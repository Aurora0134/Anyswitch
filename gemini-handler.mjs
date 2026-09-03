// Gemini frontend request handler for the antigravity (agy) adapter.
// Transport-agnostic: takes a parsed Gemini REST request, returns a response
// description. All IO (store read, credential decrypt, upstream fetch, alias
// resolve) is injected, so the error surface is testable without real
// credentials or network.
//
// Request flow:
//   1. authorize via x-goog-api-key header (or ?key= query), constant-time.
//   2. parseGeminiPath -> { slug, method }
//   3. aliasResolver.resolve(slug) -> { providerId, modelId }  (dynamic alias)
//   4. loadStore + validateStore + provider/model lookup
//   5. decrypt credential (request-scoped, never cached)
//   6. geminiToOpenAI(body, modelId) -> OpenAI chat completions request
//   7. upstreamFetch /chat/completions (stream:true iff Gemini method is stream)
//   8. non-stream: openAIToGemini; stream: return the upstream body for the
//      transport to translate via GeminiStreamTranslator.
//
// Fail-closed everywhere, mirroring handler.mjs / openai-handler.mjs. No
// generationCheck: agy does not discover models, so a 409 "catalog changed"
// has no recovery path and would only break live traffic.

import { timingSafeEqual } from "node:crypto";
import { parseGeminiPath, PARSE_REASON, METHODS } from "./gemini-path.mjs";
import { geminiToOpenAI, openAIToGemini, geminiError, buildGeminiModelsResponse } from "./gemini-protocol.mjs";
import { validateStore } from "./store-schema.mjs";
import { resolvePool, poolMembersWithModel, createStickyTable } from "./pool-routing.mjs";
import { AUTO_MODEL, resolveChain, createChainState, expandChainNode, noteChainSuccess, noteChainFailure, logChainDemote, chainNodeKey, uniqueMemberId } from "./chain-routing.mjs";
import { sanitizeInstanceId } from "./agent-metrics.mjs";

export { geminiError };

// Accept the token from x-goog-api-key (the SDK default) or the ?key= query
// (Google's fallback), with an optional "Bearer " prefix tolerated on the header
// so a misconfigured client is not rejected for a strippable scheme.
export function extractPresentedGeminiKey(headers, query) {
  const header =
    headers?.["x-goog-api-key"] ??
    headers?.["X-Goog-Api-Key"] ??
    null;
  if (typeof header === "string" && header.length > 0) {
    return header.startsWith("Bearer ") ? header.slice(7) : header;
  }
  const q = query?.key;
  if (typeof q === "string" && q.length > 0) return q;
  return null;
}

function keyMatches(presented, expected) {
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

// Key comparison with the optional "token.instanceId" suffix (per-instance
// metrics for agy: the client's GEMINI_API_KEY is passed through verbatim, so
// the instance tag rides the key). The exact whole-key match is tried FIRST —
// a suffixless client behaves exactly as before. Only when that fails is the
// key split on the LAST dot: the base segment must still equal the relay
// token in constant time, and the suffix is kept only if it passes the
// instance-id rules (an off-whitelist suffix authenticates but tags nothing).
export function matchGeminiKey(presented, expected) {
  if (keyMatches(presented, expected)) return { ok: true, instanceId: null };
  if (typeof presented === "string") {
    const dot = presented.lastIndexOf(".");
    if (dot > 0 && dot < presented.length - 1 && keyMatches(presented.slice(0, dot), expected)) {
      return { ok: true, instanceId: sanitizeInstanceId(presented.slice(dot + 1)) };
    }
  }
  return { ok: false, instanceId: null };
}

const PARSE_STATUS = {
  [PARSE_REASON.NOT_A_STRING]: 400,
  [PARSE_REASON.NOT_GEMINI]: 404,
  [PARSE_REASON.NO_MODELS]: 404,
  [PARSE_REASON.NO_METHOD]: 404,
  [PARSE_REASON.EMPTY_SLUG]: 400,
  [PARSE_REASON.INVALID_SLUG]: 400,
  [PARSE_REASON.UNKNOWN_METHOD]: 404,
};

export function createGeminiHandler(deps) {
  const {
    token,
    loadStore,
    loadCredential,
    upstreamFetch,
    aliasResolver,
    buildUpstreamURLs = (provider, path) => [provider.baseURL, ...(provider.fallbackURLs ?? [])]
      .map((baseURL) => `${baseURL.replace(/\/+$/, "")}${path}`),
    recordGeneration,
    readGeneration,
    logger = null,
  } = deps;

  // recordGeneration/readGeneration are accepted for parity with the other
  // frontends but intentionally unused (see module header). Destructure them so
  // callers wiring the full deps surface don't get a "missing dependency"
  // surprise; reference once to keep linters quiet.
  void recordGeneration;
  void readGeneration;

  // Sticky pool routing: (poolId, modelId) -> last successful member. Lives
  // in the handler closure, so it is process memory and resets on restart.
  const stickyTable = createStickyTable();

  // Chain routing state (virtual model "auto"): endpointId -> last answering
  // node. Same closure lifetime as the sticky table. 降级锁定时经 logger 落一条
  // 退避日志（常驻模式下经日志桥流进面板「实时输出」）。
  const chainState = createChainState({
    onDemote: (ep, idx, nodes) => logChainDemote(logger, ep, idx, nodes),
  });

  function authorize(headers, query) {
    const presented = extractPresentedGeminiKey(headers, query);
    if (presented === null) {
      return { ok: false, status: 401, body: geminiError(401, "missing API key") };
    }
    const match = matchGeminiKey(presented, token);
    if (!match.ok) {
      return { ok: false, status: 401, body: geminiError(401, "invalid relay token") };
    }
    // instanceId is informational for the transport's metrics tracker; no
    // handler code path consumes it.
    return { ok: true, instanceId: match.instanceId };
  }

  function loadValidStore() {
    const loaded = loadStore();
    if (!loaded.ok) {
      return { ok: false, status: 502, body: geminiError(502, "the Anyswitch global store could not be read") };
    }
    const result = validateStore(loaded.store);
    if (!result.valid) {
      return { ok: false, status: 502, body: geminiError(502, "the Anyswitch global store failed schema validation") };
    }
    return { ok: true, store: loaded.store };
  }

  // GET /v1beta/models — list the slugs the relay will accept. agy ignores this
  // (its allowlist is hardcoded), but it documents the alias surface and lets a
  // control panel / health check see what is wired.
  async function handleModels(headers, query) {
    const auth = authorize(headers, query);
    if (!auth.ok) return { status: auth.status, body: auth.body };

    const loaded = loadValidStore();
    if (!loaded.ok) return { status: loaded.status, body: loaded.body };

    const snap = aliasResolver.snapshot();
    const entries = Object.keys(snap).map((slug) => ({ slug, displayName: `${slug} -> ${snap[slug]}` }));
    return { status: 200, body: buildGeminiModelsResponse(entries) };
  }

  async function handleGenerate(path, headers, query, body, options = {}) {
    const auth = authorize(headers, query);
    if (!auth.ok) return { status: auth.status, body: auth.body };

    const parsed = parseGeminiPath(path);
    if (!parsed.ok) {
      return { status: PARSE_STATUS[parsed.reason] ?? 400, body: geminiError(400, parsed.message) };
    }

    const loaded = loadValidStore();
    if (!loaded.ok) return { status: loaded.status, body: loaded.body };

    const resolved = aliasResolver.resolve(parsed.slug);
    if (!resolved.ok) {
      return { status: 404, body: geminiError(404, resolved.reason) };
    }

    const provider = loaded.store.providers?.[resolved.providerId];
    if (provider === undefined) {
      return { status: 404, body: geminiError(404, `provider "${resolved.providerId}" is not in the Anyswitch store`) };
    }
    if (provider.models?.[resolved.modelId] === undefined) {
      return {
        status: 404,
        body: geminiError(404, `model "${resolved.modelId}" is not in provider "${resolved.providerId}"`),
      };
    }

    const isStream = parsed.method === METHODS.STREAM;
    return attemptGenerate(resolved.providerId, provider, resolved.modelId, parsed.slug, isStream, body, options);
  }

  // One upstream attempt against a single provider. Shared by the classic
  // single-provider path and by each member call of a pool request. options
  // carries the request abort signal: when the client disconnects mid-attempt,
  // upstreamFetch rejects and the abort error is rethrown so the pool loop /
  // keep-alive loop stops instead of converting it into a 502 that would
  // failover to the next member against an already-abandoned request.
  async function attemptGenerate(providerId, provider, modelId, slug, isStream, body, options = {}) {
    const credential = await loadCredential(providerId, provider);
    if (!credential.ok) {
      return { status: 502, body: geminiError(502, "the upstream credential for this provider could not be loaded") };
    }

    const upstreamRequest = geminiToOpenAI(body ?? {}, modelId);
    if (isStream) upstreamRequest.stream = true;

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
          signal: options.signal,
        },
        { bufferResponse: !isStream },
      );
    } catch (err) {
      if (options.signal?.aborted) {
        throw err;
      }
      return { status: 502, body: geminiError(502, "the upstream provider could not be reached") };
    }

    if (!upstream.ok) {
      upstreamFetch.releaseResponse?.(upstream);
      return { status: upstream.status, body: geminiError(upstream.status, `the upstream provider returned status ${upstream.status}`) };
    }

    if (isStream) {
      upstreamFetch.releaseResponse?.(upstream);
      return {
        status: 200,
        stream: upstream.body,
        slug,
        providerId,
        modelId,
      };
    }

    let payload;
    try {
      payload = await upstream.json();
    } catch {
      return { status: 502, body: geminiError(502, "the upstream provider returned a malformed response") };
    } finally {
      upstreamFetch.releaseResponse?.(upstream);
    }
    return {
      status: 200,
      body: openAIToGemini(payload, slug),
      usage: payload.usage,
      providerId,
      modelId,
    };
  }

  // Pool routing pre-flight (phase 2). Same contract as the OpenAI frontend's
  // planPoolChatCompletions:
  //   null              — the alias target does not name a pool (or the
  //                       request fails before pool resolution matters); the
  //                       caller falls through to the classic single-provider
  //                       path, which re-runs the checks and reports errors
  //   { ok: false, ...} — terminal pre-flight error (auth, or no member
  //                       carries the model)
  //   { ok: true, poolId, modelId, slug, members, noteSuccess }
  //                     — ordered per-member call plan, sticky member first
  //
  // The alias target's provider segment may name a pool: pools resolve before
  // providers (a pool id may reuse a member's id; the pool wins the tie). The
  // alias file format is unchanged — "<poolId>/<modelId>" is just a target
  // whose provider segment happens to be a pool. Both the store and the alias
  // table are re-read per request here (loadStore, resolver's mtime check),
  // so a panel-side pool edit or alias re-point takes effect without a
  // restart, exactly as in the classic path.
  async function planPoolGenerate(path, headers, query, body) {
    const auth = authorize(headers, query);
    if (!auth.ok) return { ok: false, status: auth.status, body: auth.body };

    const parsed = parseGeminiPath(path);
    if (!parsed.ok) return null;

    const loaded = loadValidStore();
    if (!loaded.ok) return null;

    const resolved = aliasResolver.resolve(parsed.slug);
    if (!resolved.ok) return null;

    const pool = resolvePool(loaded.store, resolved.providerId);
    if (!pool) return null;

    const candidates = poolMembersWithModel(loaded.store, pool, resolved.modelId);
    if (candidates.length === 0) {
      return {
        ok: false,
        status: 404,
        body: geminiError(404, `model "${resolved.modelId}" is not in pool "${resolved.providerId}"`),
      };
    }

    const isStream = parsed.method === METHODS.STREAM;
    const ordered = stickyTable.order(resolved.providerId, resolved.modelId, candidates);
    return {
      ok: true,
      poolId: resolved.providerId,
      modelId: resolved.modelId,
      slug: parsed.slug,
      members: ordered.map(({ memberId, provider }) => ({
        memberId,
        call: (options = {}) => attemptGenerate(memberId, provider, resolved.modelId, parsed.slug, isStream, body, options),
      })),
      noteSuccess: (memberId) => stickyTable.noteSuccess(resolved.providerId, resolved.modelId, memberId),
      // 成员级请求失败计数（成员切换真正越过该成员时由 server 侧回调）——
      // 号池粘性位降级门控（失败才降级）的计数来源。成员一次请求至多
      // failover 一次，无需去重。
      noteFailure: (memberId) => stickyTable.noteFailure(resolved.providerId, resolved.modelId, memberId),
    };
  }

  // Chain routing pre-flight (virtual model "auto"). Intercepts BEFORE the
  // alias resolver: "auto" is a virtual model with no alias, so any slug
  // other than AUTO_MODEL (or a missing chain) returns null and the caller
  // falls through to pool / classic routing untouched. Same result contract
  // as planPoolGenerate:
  //   null              — slug is not "auto", or the endpoint has no chain,
  //                       or the request fails before chain resolution
  //                       matters; the caller falls through
  //   { ok: false, ...} — terminal pre-flight error (auth, or no chain node
  //                       can serve the request)
  //   { ok: true, endpointId, members, noteSuccess }
  //                     — the chain's attempt plan expanded into an ordered
  //                       per-member call plan
  //
  // Expansion follows chainState.plan's order (current node first, head
  // probe every RETRY_UPSTREAM_MS): a channel node contributes one callable
  // bound to the node's model (memberId = nodeId, providerId = channel id);
  // a pool node contributes its poolMembersWithModel-filtered members in
  // pool-sticky order (memberId = "<poolId>/<memberId>", providerId = pool
  // id) — the node only fails when the whole pool is exhausted. noteSuccess
  // sticks both levels: the chain node via noteChainSuccess and, for pool
  // members, the pool member via the sticky table.
  //
  // agentId identifies the endpoint whose chain applies. This path serves
  // only agy and the existing transport hardcodes agentId "agy" for metrics
  // (gemini-server.mjs startRequest), so the same constant is the default
  // here — there is no per-request signal that could distinguish endpoints.
  async function planChainGenerate(path, headers, query, body, { agentId = "agy" } = {}) {
    const auth = authorize(headers, query);
    if (!auth.ok) return { ok: false, status: auth.status, body: auth.body };

    const parsed = parseGeminiPath(path);
    if (!parsed.ok) return null;
    if (parsed.slug !== AUTO_MODEL) return null;

    const loaded = loadValidStore();
    if (!loaded.ok) return null;

    const chainEntry = resolveChain(loaded.store, agentId);
    if (!chainEntry) return null;

    const isStream = parsed.method === METHODS.STREAM;
    const plan = chainState.plan(loaded.store, agentId, chainEntry.chain, Date.now());

    const members = [];
    // memberId -> { nodeId, poolMemberId, model } so noteSuccess can stick
    // the right chain node (and pool member) without re-parsing strings.
    const successIndex = new Map();
    // 本请求已计失败的节点（node+model 复合键）：noteFailure 的去重集。
    const failedNodes = new Set();
    for (const entry of plan) {
      const expanded = expandChainNode(loaded.store, entry);
      if (!expanded) continue;
      if (expanded.kind === "channel") {
        const provider = loaded.store.providers[expanded.providerId];
        const memberId = uniqueMemberId(successIndex, expanded.providerId, expanded.model);
        members.push({
          memberId,
          providerId: expanded.providerId,
          memberNoun: "chain node",
          call: (options = {}) =>
            attemptGenerate(expanded.providerId, provider, expanded.model, parsed.slug, isStream, body, options),
        });
        successIndex.set(memberId, { nodeId: expanded.providerId, poolMemberId: null, model: expanded.model });
      } else {
        const pool = resolvePool(loaded.store, expanded.poolId);
        const ordered = stickyTable.order(
          expanded.poolId,
          expanded.model,
          poolMembersWithModel(loaded.store, pool, expanded.model),
        );
        for (const { memberId, provider } of ordered) {
          const planMemberId = uniqueMemberId(successIndex, `${expanded.poolId}/${memberId}`, expanded.model);
          members.push({
            memberId: planMemberId,
            providerId: expanded.poolId,
            memberNoun: "pool member",
            call: (options = {}) => attemptGenerate(memberId, provider, expanded.model, parsed.slug, isStream, body, options),
          });
          successIndex.set(planMemberId, { nodeId: expanded.poolId, poolMemberId: memberId, model: expanded.model });
        }
      }
    }

    if (members.length === 0) {
      return {
        ok: false,
        status: 404,
        body: geminiError(404, `no chain node for endpoint "${agentId}" can serve the request`),
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
        const target = successIndex.get(memberId);
        return target ? { providerId: target.nodeId, model: target.model } : null;
      },
      noteSuccess: (memberId) => {
        const target = successIndex.get(memberId);
        if (!target) return;
        noteChainSuccess(chainState, agentId, target.nodeId, target.model, Date.now());
        if (target.poolMemberId !== null) {
          stickyTable.noteSuccess(target.nodeId, target.model, target.poolMemberId);
        }
      },
      // 一次请求级节点失败（成员切换真正越过该节点时由 server 侧回调）；
      // per-request 去重让号池整池耗尽只计一次（请求数口径）。
      noteFailure: (memberId) => {
        const target = successIndex.get(memberId);
        if (!target) return;
        // 池成员还要进池内粘性表的成员级计数（失败才降级，与链同一规则）；
        // 成员一次请求至多 failover 一次，不需要 per-request 去重。
        if (target.poolMemberId !== null) {
          stickyTable.noteFailure(target.nodeId, target.model, target.poolMemberId);
        }
        const key = chainNodeKey(target.nodeId, target.model);
        if (failedNodes.has(key)) return;
        failedNodes.add(key);
        noteChainFailure(chainState, agentId, target.nodeId, target.model);
      },
    };
  }

  // countTokens: agy does not call this, but a correct handler maps it to an
  // upstream chat completion with a tiny max_tokens and reads usage. For now we
  // return a usage estimate from the request body length — a stub that keeps the
  // endpoint from 404ing without spending an upstream call.
  async function handleCountTokens(path, headers, query, body) {
    const auth = authorize(headers, query);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    const parsed = parseGeminiPath(path);
    if (!parsed.ok) return { status: PARSE_STATUS[parsed.reason] ?? 400, body: geminiError(400, parsed.message) };
    const text = JSON.stringify(body?.contents ?? "");
    return { status: 200, body: { totalTokens: Math.max(1, Math.ceil(text.length / 4)) } };
  }

  return { authorize, handleModels, handleGenerate, handleCountTokens, planPoolGenerate, planChainGenerate, chainState };
}
