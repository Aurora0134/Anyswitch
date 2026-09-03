// Relay request handler.
// Transport-agnostic: takes a parsed request, returns a response description.
// All IO (store read, credential decrypt, upstream fetch) is injected, so the
// whole error surface is testable without touching real credentials or network.
//
// Fail-closed everywhere. Explicitly absent by design:
//   - no default provider
//   - no prefix fuzzy matching
//   - no nearest-model fallback
//   - no official Anthropic passthrough (user decision 2026-08-04)
//   - no falling back to some other key when decryption fails

import { timingSafeEqual } from "node:crypto";
import { unpackWireId, buildWireCatalog, UNPACK_REASON } from "./wire-id.mjs";
import { catalogGeneration, generationMatches } from "./catalog-generation.mjs";
import { anthropicToOpenAI, openAIToAnthropic, buildModelsResponse } from "./protocol.mjs";
import { validateStore } from "./store-schema.mjs";
import { resolvePool, poolMembersWithModel, createStickyTable } from "./pool-routing.mjs";
import {
  AUTO_MODEL,
  resolveChain,
  expandChainNode,
  createChainState,
  noteChainSuccess,
  noteChainFailure,
  logChainDemote,
  chainNodeKey,
  uniqueMemberId,
} from "./chain-routing.mjs";

// Anthropic-shaped error body. Never carries a key, ciphertext, token or raw
// upstream response body (secret boundary).
export function errorBody(type, message) {
  return { type: "error", error: { type, message } };
}

const UNPACK_STATUS = {
  [UNPACK_REASON.MISSING]: 400,
  [UNPACK_REASON.NOT_A_STRING]: 400,
  [UNPACK_REASON.NOT_WIRE_ID]: 400,
  [UNPACK_REASON.NO_SEPARATOR]: 400,
  [UNPACK_REASON.EMPTY_PROVIDER]: 400,
  [UNPACK_REASON.EMPTY_MODEL]: 400,
  [UNPACK_REASON.AMBIGUOUS_UNQUALIFIED]: 400,
  [UNPACK_REASON.UNKNOWN_UNQUALIFIED]: 400,
};

// Constant-time token comparison. Length mismatch is reported without
// short-circuiting on content. Both temporary copies are zeroed on every path so
// no extra copy of the session token is left for the GC to reclaim lazily.
export function tokenMatches(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  try {
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } finally {
    a.fill(0);
    b.fill(0);
  }
}

// Claude sends ANTHROPIC_AUTH_TOKEN in `Authorization` as the
// bare value (no Bearer scheme). Accept an optional `Bearer ` prefix too, since
// stripping it cannot weaken the comparison.
export function extractPresentedToken(headers) {
  const raw = headers?.authorization ?? headers?.Authorization;
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw.startsWith("Bearer ") ? raw.slice(7) : raw;
}

// deps:
//   token          : string    - the relay's session token
//   loadStore      : () => { ok, store?, errors? }
//   loadCredential : (providerId, provider) => Promise<{ ok, value?, reason? }>
//                    providerId is the already-validated id this request routed
//                    to; it is passed explicitly so the implementation never has
//                    to recover it from shared or cross-request state.
//   buildUpstreamURLs : (provider, path) => string[]
//   upstreamFetch  : (urls, init) => Promise<Response>
//   recordGeneration / readGeneration : catalog generation binding
export function createHandler(deps) {
  const {
    token,
    loadStore,
    loadCredential,
    upstreamFetch,
    buildUpstreamURLs = (provider, path) => [provider.baseURL, ...(provider.fallbackURLs ?? [])]
      .map((baseURL) => `${baseURL.replace(/\/+$/, "")}${path}`),
    recordGeneration,
    readGeneration,
    logger = null,
  } = deps;

  // Sticky pool routing: (poolId, modelId) -> last successful member. Lives
  // in the handler closure, so it is process memory and resets on restart.
  const stickyTable = createStickyTable();

  // Chain routing (自动路由): endpointId -> last successful chain node. Same
  // process-memory lifetime as the sticky table. 降级锁定时经 logger 落一条
  // 退避日志（常驻模式下经日志桥流进面板「实时输出」）。
  const chainState = createChainState({
    onDemote: (ep, idx, nodes) => logChainDemote(logger, ep, idx, nodes),
  });

  // Token check happens before the body is parsed.
  function authorize(headers) {
    const presented = extractPresentedToken(headers);
    if (presented === null) {
      return { ok: false, status: 401, body: errorBody("authentication_error", "missing Authorization header") };
    }
    if (!tokenMatches(presented, token)) {
      return { ok: false, status: 401, body: errorBody("authentication_error", "invalid relay token") };
    }
    return { ok: true };
  }

  function loadValidStore() {
    const loaded = loadStore();
    if (!loaded.ok) {
      return {
        ok: false,
        status: 502,
        body: errorBody("api_error", "the ApiCred global store could not be read"),
      };
    }
    const result = validateStore(loaded.store);
    if (!result.valid) {
      return {
        ok: false,
        status: 502,
        body: errorBody("api_error", "the ApiCred global store failed schema validation"),
      };
    }
    return { ok: true, store: loaded.store };
  }

  // agentId is optional: callers that can identify the requesting endpoint
  // (per-launch relay: the launched agent; resident relay: UA detection) pass
  // it so the catalog can offer the endpoint's route chain as the AUTO_MODEL
  // virtual model. Unidentifiable callers get the plain wire catalog.
  async function handleModels(headers, agentId) {
    const auth = authorize(headers);
    if (!auth.ok) return { status: auth.status, body: auth.body };

    const loaded = loadValidStore();
    if (!loaded.ok) return { status: loaded.status, body: loaded.body };

    let entries;
    try {
      entries = buildWireCatalog(loaded.store);
    } catch (error) {
      // A wire ID collision fails the WHOLE catalog. No partial output.
      return { status: 500, body: errorBody("api_error", error.message) };
    }

    // 自动路由: an endpoint with a configured chain can ask for the virtual
    // model "auto". It is deliberately not a wire id (no provider carries it)
    // and is appended after collision checking, so it can never trip that check.
    if (agentId !== undefined && (resolveChain(loaded.store, agentId)?.chain?.length ?? 0) > 0) {
      entries.push({
        wireId: AUTO_MODEL,
        providerId: agentId,
        modelId: AUTO_MODEL,
        displayName: `[${agentId}] 自动路由 (auto)`,
      });
    }

    // Bind this discovery result to the store shape that produced it.
    recordGeneration(catalogGeneration(loaded.store));
    return { status: 200, body: buildModelsResponse(entries) };
  }

  async function handleMessages(headers, body) {
    const auth = authorize(headers);
    if (!auth.ok) return { status: auth.status, body: auth.body };

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return { status: 400, body: errorBody("invalid_request_error", "request body must be a JSON object") };
    }

    const loaded = loadValidStore();
    if (!loaded.ok) return { status: loaded.status, body: loaded.body };

    const unpacked = unpackWireId(body.model, loaded.store);
    if (!unpacked.ok) {
      return {
        status: UNPACK_STATUS[unpacked.reason] ?? 400,
        body: errorBody("invalid_request_error", unpacked.message),
      };
    }

    // The generation check runs before provider lookup so a stale catalog is
    // reported as such rather than as a 404 on a since-removed provider.
    const recorded = readGeneration();
    const current = catalogGeneration(loaded.store);
    if (recorded !== null && !generationMatches(recorded, current)) {
      return {
        status: 409,
        body: errorBody(
          "invalid_request_error",
          "the provider catalog changed since it was discovered; re-run model discovery before retrying",
        ),
      };
    }

    const provider = loaded.store.providers?.[unpacked.providerId];
    if (provider === undefined) {
      return {
        status: 404,
        body: errorBody("not_found_error", `provider "${unpacked.providerId}" is not in the ApiCred store`),
      };
    }
    if (provider.models?.[unpacked.modelId] === undefined) {
      return {
        status: 404,
        body: errorBody(
          "not_found_error",
          `model "${unpacked.modelId}" is not in provider "${unpacked.providerId}"`,
        ),
      };
    }

    return attemptMessages(unpacked.providerId, provider, body, unpacked.modelId);
  }

  // One upstream attempt against a single provider. Shared by the classic
  // single-provider path and by each member call of a pool request.
  async function attemptMessages(providerId, provider, body, modelId) {
    // Decrypt only now, inject for this one request, never cache.
    const credential = await loadCredential(providerId, provider);
    if (!credential.ok) {
      return {
        status: 502,
        body: errorBody("api_error", "the upstream credential for this provider could not be loaded"),
      };
    }

    const upstreamRequest = anthropicToOpenAI(body, modelId);
    const urls = buildUpstreamURLs(provider, "/chat/completions");

    let upstream;
    try {
      upstream = await upstreamFetch(
        urls,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${credential.value}`,
          },
          body: JSON.stringify(upstreamRequest),
        },
        { bufferResponse: upstreamRequest.stream !== true },
      );
    } catch {
      // Message deliberately generic: an upstream transport error must not leak
      // the URL, the credential or the raw error text.
      return { status: 502, body: errorBody("api_error", "the upstream provider could not be reached") };
    }

    if (!upstream.ok) {
      upstreamFetch.releaseResponse?.(upstream);
      // Pass the status class through, but not the raw upstream body.
      return {
        status: upstream.status,
        body: errorBody("api_error", `the upstream provider returned status ${upstream.status}`),
      };
    }

    if (upstreamRequest.stream === true) {
      // A stream can legitimately exceed the connection deadline; once headers
      // establish a 2xx streaming response, transport owns its lifetime.
      upstreamFetch.releaseResponse?.(upstream);
      return { status: 200, stream: upstream.body, wireId: body.model };
    }

    let payload;
    try {
      payload = await upstream.json();
    } catch {
      return { status: 502, body: errorBody("api_error", "the upstream provider returned a malformed response") };
    } finally {
      upstreamFetch.releaseResponse?.(upstream);
    }
    return { status: 200, body: openAIToAnthropic(payload, body.model) };
  }

  // Pool routing pre-flight. Returns:
  //   null              — body.model does not name a pool; the caller falls
  //                       through to the classic single-provider path (which
  //                       re-runs auth/unpack/store and reports errors)
  //   { ok: false, ...} — terminal pre-flight error (auth, body, generation
  //                       gate, or no member carries the model)
  //   { ok: true, poolId, modelId, members, noteSuccess }
  //                     — ordered per-member call plan, sticky member first
  //
  // The generation gate needs no pool special-casing: the catalog digest
  // covers providers (including every member's endpoint) but not pool
  // membership, so editing pool composition alone cannot false-trigger a 409.
  async function planPoolMessages(headers, body) {
    const auth = authorize(headers);
    if (!auth.ok) return { ok: false, status: auth.status, body: auth.body };

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, status: 400, body: errorBody("invalid_request_error", "request body must be a JSON object") };
    }

    const loaded = loadValidStore();
    if (!loaded.ok) return null;

    const unpacked = unpackWireId(body.model, loaded.store);
    if (!unpacked.ok || unpacked.pool !== true) return null;

    const pool = resolvePool(loaded.store, unpacked.poolId);
    if (!pool) return null;

    // Generation check, same ordering as handleMessages.
    const recorded = readGeneration();
    const current = catalogGeneration(loaded.store);
    if (recorded !== null && !generationMatches(recorded, current)) {
      return {
        ok: false,
        status: 409,
        body: errorBody(
          "invalid_request_error",
          "the provider catalog changed since it was discovered; re-run model discovery before retrying",
        ),
      };
    }

    const candidates = poolMembersWithModel(loaded.store, pool, unpacked.modelId);
    if (candidates.length === 0) {
      return {
        ok: false,
        status: 404,
        body: errorBody("not_found_error", `model "${unpacked.modelId}" is not in pool "${unpacked.poolId}"`),
      };
    }

    const ordered = stickyTable.order(unpacked.poolId, unpacked.modelId, candidates);
    return {
      ok: true,
      poolId: unpacked.poolId,
      modelId: unpacked.modelId,
      members: ordered.map(({ memberId, provider }) => ({
        memberId,
        call: () => attemptMessages(memberId, provider, body, unpacked.modelId),
      })),
      noteSuccess: (memberId) => stickyTable.noteSuccess(unpacked.poolId, unpacked.modelId, memberId),
      // 成员级请求失败计数（成员切换真正越过该成员时由 server 侧回调）——
      // 号池粘性位降级门控（失败才降级）的计数来源。成员一次请求至多
      // failover 一次，无需去重。
      noteFailure: (memberId) => stickyTable.noteFailure(unpacked.poolId, unpacked.modelId, memberId),
    };
  }

  // Chain routing pre-flight (自动路由). Same return contract as
  // planPoolMessages:
  //   null              — body.model is not the virtual model AUTO_MODEL, or
  //                       the endpoint has no configured chain; the caller
  //                       falls through to the pool/classic paths untouched
  //   { ok: false, ...} — terminal pre-flight error (auth, body, generation
  //                       gate, or no chain node can serve)
  //   { ok: true, endpointId, members, noteSuccess }
  //                     — flat, chainState.plan-ordered callable list: a
  //                       channel node contributes ONE callable, a pool node
  //                       contributes its sticky-ordered member callables
  //
  // AUTO_MODEL is a virtual model, not a wire id, so it MUST be intercepted
  // before unpackWireId (which would reject it as an unknown unqualified
  // model). memberId is `nodeId` for a channel node and `nodeId/poolMemberId`
  // for a pool member (provider ids never contain '/'). Each member also
  // carries the tracker key fields: providerId (channel id, or pool id for
  // pool members — the pool member itself rides memberId) and model (the
  // node's bound model, which is what the upstream is actually asked for).
  async function planChainMessages(headers, body, agentId) {
    const auth = authorize(headers);
    if (!auth.ok) return { ok: false, status: auth.status, body: auth.body };

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, status: 400, body: errorBody("invalid_request_error", "request body must be a JSON object") };
    }

    if (body.model !== AUTO_MODEL) return null;

    const loaded = loadValidStore();
    if (!loaded.ok) return null;

    const chain = resolveChain(loaded.store, agentId);
    if (!chain || chain.chain.length === 0) return null;

    // Generation check, same ordering as handleMessages.
    const recorded = readGeneration();
    const current = catalogGeneration(loaded.store);
    if (recorded !== null && !generationMatches(recorded, current)) {
      return {
        ok: false,
        status: 409,
        body: errorBody(
          "invalid_request_error",
          "the provider catalog changed since it was discovered; re-run model discovery before retrying",
        ),
      };
    }

    // plan already applies "current node first + retry from the head every
    // RETRY_UPSTREAM_MS"; expand the entries in exactly the returned order.
    const planned = chainState.plan(loaded.store, agentId, chain.chain, Date.now());

    const members = [];
    const byMemberId = new Map();
    // 本请求已计失败的节点（node+model 复合键）：noteFailure 的去重集。
    const failedNodes = new Set();
    for (const entry of planned) {
      const expanded = expandChainNode(loaded.store, entry);
      if (!expanded) continue;

      if (expanded.kind === "channel") {
        const provider = loaded.store.providers[expanded.providerId];
        const memberId = uniqueMemberId(byMemberId, expanded.providerId, expanded.model);
        byMemberId.set(memberId, { nodeId: expanded.providerId, model: expanded.model });
        members.push({
          memberId,
          nodeId: expanded.providerId,
          providerId: expanded.providerId,
          model: expanded.model,
          memberNoun: "chain node",
          call: () => attemptMessages(expanded.providerId, provider, body, expanded.model),
        });
        continue;
      }

      // Pool node: the pool's own sticky member routing runs inside the node;
      // the node only counts as failed when every member is exhausted.
      const candidates = expanded.memberIds.map((poolMemberId) => ({
        memberId: poolMemberId,
        provider: loaded.store.providers[poolMemberId],
      }));
      for (const { memberId: poolMemberId, provider } of stickyTable.order(expanded.poolId, expanded.model, candidates)) {
        const memberId = uniqueMemberId(byMemberId, `${expanded.poolId}/${poolMemberId}`, expanded.model);
        byMemberId.set(memberId, {
          nodeId: expanded.poolId,
          poolId: expanded.poolId,
          poolMemberId,
          model: expanded.model,
        });
        members.push({
          memberId,
          nodeId: expanded.poolId,
          providerId: expanded.poolId,
          model: expanded.model,
          memberNoun: "pool member",
          call: () => attemptMessages(poolMemberId, provider, body, expanded.model),
        });
      }
    }

    if (members.length === 0) {
      return {
        ok: false,
        status: 404,
        body: errorBody("not_found_error", `no node in the route chain for "${agentId}" can serve the request`),
      };
    }

    return {
      ok: true,
      endpointId: agentId,
      members,
      // Node-level stats attribution for the tracker: memberId -> the chain
      // node that serves it + the node's bound model. Unknown memberIds
      // resolve to null and the tracker keeps its existing attribution.
      attributeOf: (memberId) => {
        const record = byMemberId.get(memberId);
        return record ? { providerId: record.nodeId, model: record.model } : null;
      },
      // A member answered: stick the chain to its node, and when the member
      // is a pool member also feed the pool's own sticky table.
      noteSuccess: (memberId) => {
        const record = byMemberId.get(memberId);
        if (record === undefined) return;
        noteChainSuccess(chainState, agentId, record.nodeId, record.model, Date.now());
        if (record.poolId !== undefined) {
          stickyTable.noteSuccess(record.poolId, record.model, record.poolMemberId);
        }
      },
      // 一次请求级节点失败（成员切换真正越过该节点时由 server 侧回调）；
      // per-request 去重让号池整池耗尽只计一次（请求数口径）。
      noteFailure: (memberId) => {
        const record = byMemberId.get(memberId);
        if (record === undefined) return;
        // 池成员还要进池内粘性表的成员级计数（失败才降级，与链同一规则）；
        // 成员一次请求至多 failover 一次，不需要 per-request 去重。
        if (record.poolId !== undefined) {
          stickyTable.noteFailure(record.poolId, record.model, record.poolMemberId);
        }
        const key = chainNodeKey(record.nodeId, record.model);
        if (failedNodes.has(key)) return;
        failedNodes.add(key);
        noteChainFailure(chainState, agentId, record.nodeId, record.model);
      },
    };
  }

  return { authorize, handleModels, handleMessages, planPoolMessages, planChainMessages, chainState };
}
