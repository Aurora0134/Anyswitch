import { timingSafeEqual } from "node:crypto";
import { parseOpenAIPath, PARSE_REASON } from "./openai-path.mjs";
import { catalogGeneration, generationMatches } from "./catalog-generation.mjs";
import { extractPresentedToken } from "./handler.mjs";
import { validateStore } from "./store-schema.mjs";
import { resolvePool, poolMembersWithModel, poolModelsUnion, createStickyTable } from "./pool-routing.mjs";
import { AUTO_MODEL, resolveChain, expandChainNode, createChainState, noteChainSuccess, noteChainFailure, logChainDemote, chainNodeKey, uniqueMemberId } from "./chain-routing.mjs";

export function openAIError(type, message) {
  return { error: { type, message } };
}

function tokenMatches(presented, expected) {
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

const PARSE_STATUS = {
  [PARSE_REASON.NOT_OPENAI]: 404,
  [PARSE_REASON.NOT_A_STRING]: 400,
  [PARSE_REASON.NO_PROVIDER]: 400,
  [PARSE_REASON.EMPTY_PROVIDER]: 400,
  [PARSE_REASON.INVALID_PROVIDER]: 400,
};

// Some upstream gateways (observed: SenseNova) hard-400 any request whose
// assistant history carries a tool_call with function.arguments === "" (or
// missing/null); "{}" is accepted. Rewrite only that shape — every other
// field and message passes through untouched, and the client's body object
// is never mutated (a normalized copy is built only when something changed).
function normalizeToolCallArguments(body) {
  if (!Array.isArray(body.messages)) return body;
  let touched = false;
  const messages = body.messages.map((message) => {
    if (message === null || typeof message !== "object" || message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      return message;
    }
    let messageTouched = false;
    const toolCalls = message.tool_calls.map((call) => {
      const fn = call?.function;
      if (fn === null || typeof fn !== "object") return call;
      // Only the truly-empty shapes ("", null, undefined) are rewritten;
      // non-string values (e.g. an object from a lenient client) pass through
      // untouched — the relay does not re-encode what it was not asked to fix.
      if (fn.arguments !== "" && fn.arguments !== null && fn.arguments !== undefined) return call;
      messageTouched = true;
      return { ...call, function: { ...fn, arguments: "{}" } };
    });
    if (!messageTouched) return message;
    touched = true;
    return { ...message, tool_calls: toolCalls };
  });
  return touched ? { ...body, messages } : body;
}

export function createOpenAIHandler(deps) {
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

  // Chain routing (自动路由): endpointId (the requesting agent's id) -> the
  // chain node that answered last. Same closure lifetime as stickyTable.
  // 降级锁定时经 logger 落一条退避日志（常驻模式下经日志桥流进面板「实时输出」）。
  const chainState = createChainState({
    onDemote: (ep, idx, nodes) => logChainDemote(logger, ep, idx, nodes),
  });

  function authorize(headers) {
    const presented = extractPresentedToken(headers);
    if (presented === null) {
      return { ok: false, status: 401, body: openAIError("authentication_error", "missing Authorization header") };
    }
    if (!tokenMatches(presented, token)) {
      return { ok: false, status: 401, body: openAIError("authentication_error", "invalid relay token") };
    }
    return { ok: true };
  }

  function loadValidStore() {
    const loaded = loadStore();
    if (!loaded.ok) {
      return { ok: false, status: 502, body: openAIError("api_error", "the ApiCred global store could not be read") };
    }
    const result = validateStore(loaded.store);
    if (!result.valid) {
      return { ok: false, status: 502, body: openAIError("api_error", "the ApiCred global store failed schema validation") };
    }
    return { ok: true, store: loaded.store };
  }

  function resolveProvider(store, providerId) {
    const provider = store.providers?.[providerId];
    if (provider === undefined) {
      return { ok: false, status: 404, body: openAIError("not_found_error", `provider "${providerId}" is not in the ApiCred store`) };
    }
    return { ok: true, provider };
  }

  function generationCheck(store) {
    const recorded = readGeneration();
    const current = catalogGeneration(store);
    if (recorded !== null && !generationMatches(recorded, current)) {
      return {
        ok: false,
        status: 409,
        body: openAIError(
          "invalid_request_error",
          "the provider catalog changed since it was discovered; re-run model discovery before retrying",
        ),
      };
    }
    return { ok: true };
  }

  function modelListResponse(provider) {
    const data = Object.keys(provider.models ?? {}).map((modelId) => ({
      id: modelId,
      object: "model",
    }));
    return { object: "list", data };
  }

  async function handleModels(path, headers, agentId) {
    const auth = authorize(headers);
    if (!auth.ok) return { status: auth.status, body: auth.body };

    const parsed = parseOpenAIPath(path);
    if (!parsed.ok) {
      return { status: PARSE_STATUS[parsed.reason] ?? 400, body: openAIError("invalid_request_error", parsed.message) };
    }

    const loaded = loadValidStore();
    if (!loaded.ok) return { status: loaded.status, body: loaded.body };

    let response;
    // Pools resolve before providers: a pool id may reuse a member's id, and
    // the pool wins the tie. A pool's model list is the union of its members'
    // catalogs in pool order (first member wins duplicate ids).
    const pool = resolvePool(loaded.store, parsed.providerId);
    if (pool) {
      response = modelListResponse({ models: poolModelsUnion(loaded.store, pool) });
    } else {
      const provider = resolveProvider(loaded.store, parsed.providerId);
      if (!provider.ok) return { status: provider.status, body: provider.body };
      response = modelListResponse(provider.provider);
    }

    // Chain routing (自动路由): an agent with a configured route chain may
    // send model "auto", so advertise the virtual entry alongside the real
    // models. Same shape as every other entry — clients that never send
    // "auto" can ignore it.
    if (agentId && resolveChain(loaded.store, agentId)) {
      response.data.push({ id: AUTO_MODEL, object: "model" });
    }

    recordGeneration(catalogGeneration(loaded.store));
    return { status: 200, body: response };
  }

  async function handleChatCompletions(path, headers, body, options = {}) {
    const auth = authorize(headers);
    if (!auth.ok) return { status: auth.status, body: auth.body };

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return { status: 400, body: openAIError("invalid_request_error", "request body must be a JSON object") };
    }
    if (typeof body.model !== "string" || body.model.length === 0) {
      return { status: 400, body: openAIError("invalid_request_error", "request body is missing a non-empty `model` field") };
    }

    const parsed = parseOpenAIPath(path);
    if (!parsed.ok) {
      return { status: PARSE_STATUS[parsed.reason] ?? 400, body: openAIError("invalid_request_error", parsed.message) };
    }

    const loaded = loadValidStore();
    if (!loaded.ok) return { status: loaded.status, body: loaded.body };

    const gate = generationCheck(loaded.store);
    if (!gate.ok) return { status: gate.status, body: gate.body };

    const provider = resolveProvider(loaded.store, parsed.providerId);
    if (!provider.ok) return { status: provider.status, body: provider.body };

    const modelId = body.model;
    if (provider.provider.models?.[modelId] === undefined) {
      return {
        status: 404,
        body: openAIError("not_found_error", `model "${modelId}" is not in provider "${parsed.providerId}"`),
      };
    }

    return attemptChatCompletion(parsed.providerId, provider.provider, body, options);
  }

  // One upstream attempt against a single provider. Shared by the classic
  // single-provider path and by each member call of a pool request.
  async function attemptChatCompletion(providerId, provider, body, options = {}) {
    const credential = await loadCredential(providerId, provider);
    if (!credential.ok) {
      return { status: 502, body: openAIError("api_error", "the upstream credential for this provider could not be loaded") };
    }

    const urls = buildUpstreamURLs(provider, "/chat/completions");

    const normalizedBody = normalizeToolCallArguments(body);
    const outboundBody = normalizedBody.stream === true
      ? {
          ...normalizedBody,
          stream_options: {
            ...(normalizedBody.stream_options && typeof normalizedBody.stream_options === "object" ? normalizedBody.stream_options : {}),
            include_usage: true,
          },
        }
      : normalizedBody;

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
          body: JSON.stringify(outboundBody),
          signal: options.signal,
        },
        { bufferResponse: body.stream !== true },
      );
    } catch (err) {
      if (options.signal?.aborted) {
        throw err;
      }
      return { status: 502, body: openAIError("api_error", "the upstream provider could not be reached") };
    }

    if (!upstream.ok) {
      upstreamFetch.releaseResponse?.(upstream);
      return {
        status: upstream.status,
        body: openAIError("api_error", `the upstream provider returned status ${upstream.status}`),
      };
    }

    if (body.stream === true) {
      // A stream can legitimately exceed the connection deadline; once headers
      // establish a 2xx streaming response, transport owns its lifetime.
      upstreamFetch.releaseResponse?.(upstream);
      return { status: 200, stream: upstream.body };
    }

    let payload;
    try {
      payload = await upstream.json();
    } catch {
      return { status: 502, body: openAIError("api_error", "the upstream provider returned a malformed response") };
    } finally {
      upstreamFetch.releaseResponse?.(upstream);
    }
    return { status: 200, body: payload };
  }

  // Pool routing pre-flight (phase 2). Returns:
  //   null              — the URL segment does not name a pool; the caller
  //                       falls through to the classic single-provider path
  //                       (which re-runs auth/parse/store and reports errors)
  //   { ok: false, ...} — terminal pre-flight error (auth, body, generation
  //                       gate, or no member carries the model)
  //   { ok: true, poolId, modelId, members, noteSuccess }
  //                     — ordered per-member call plan, sticky member first
  //
  // The generation gate needs no pool special-casing: the catalog digest
  // covers providers (including every member's endpoint) but not pool
  // membership, so editing pool composition alone cannot false-trigger a 409.
  async function planPoolChatCompletions(path, headers, body) {
    const auth = authorize(headers);
    if (!auth.ok) return { ok: false, status: auth.status, body: auth.body };

    const parsed = parseOpenAIPath(path);
    if (!parsed.ok) return null;

    const loaded = loadValidStore();
    if (!loaded.ok) return null;

    const pool = resolvePool(loaded.store, parsed.providerId);
    if (!pool) return null;

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, status: 400, body: openAIError("invalid_request_error", "request body must be a JSON object") };
    }
    if (typeof body.model !== "string" || body.model.length === 0) {
      return { ok: false, status: 400, body: openAIError("invalid_request_error", "request body is missing a non-empty `model` field") };
    }

    const gate = generationCheck(loaded.store);
    if (!gate.ok) return { ok: false, status: gate.status, body: gate.body };

    const modelId = body.model;
    const candidates = poolMembersWithModel(loaded.store, pool, modelId);
    if (candidates.length === 0) {
      return {
        ok: false,
        status: 404,
        body: openAIError("not_found_error", `model "${modelId}" is not in pool "${parsed.providerId}"`),
      };
    }

    const ordered = stickyTable.order(parsed.providerId, modelId, candidates);
    return {
      ok: true,
      poolId: parsed.providerId,
      modelId,
      members: ordered.map(({ memberId, provider }) => ({
        memberId,
        call: (options = {}) => attemptChatCompletion(memberId, provider, body, options),
      })),
      noteSuccess: (memberId) => stickyTable.noteSuccess(parsed.providerId, modelId, memberId),
      // 成员级请求失败计数（成员切换真正越过该成员时由 server 侧回调）——
      // 号池粘性位降级门控（失败才降级）的计数来源。成员在一次请求里
      // 至多 failover 一次（keep-alive 重试在成员内部吸收），无需去重。
      noteFailure: (memberId) => stickyTable.noteFailure(parsed.providerId, modelId, memberId),
    };
  }

  // Chain routing pre-flight (自动路由). Triggered by the virtual model
  // AUTO_MODEL ("auto") — it names no real provider model, so it takes
  // priority over pool resolution. Returns:
  //   null              — model is not "auto", or the requesting agent has no
  //                       route chain; the caller falls through to pool/classic
  //                       routing (which reports auth/parse/store errors)
  //   { ok: false, ...} — terminal pre-flight error (auth, generation gate,
  //                       or no live chain node can serve the request)
  //   { ok: true, agentId, members, noteSuccess }
  //                     — flat ordered call plan across the whole chain
  //
  // members flattens the chain's attempt plan (chainState.plan already orders
  // it: last successful node first, probing back to the head every
  // RETRY_UPSTREAM_MS): a channel node contributes ONE callable, a pool node
  // contributes its members' callables (sticky pool order, filtered by the
  // node's bound model). Because a pool node's members sit adjacently in the
  // flat list, the caller's per-member failover exhausts the pool before the
  // chain backs off to the next node — a pool only counts as a failed node
  // when fully exhausted. memberId is `nodeId` for channels and
  // `nodeId/poolMemberId` for pool members (provider/pool ids never contain
  // '/', so the split is unambiguous).
  async function planChainChatCompletions(path, headers, body, agentId) {
    const auth = authorize(headers);
    if (!auth.ok) return { ok: false, status: auth.status, body: auth.body };

    // Not an object or not the virtual model: classic routing reports the
    // shape error / handles the concrete model.
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    if (body.model !== AUTO_MODEL || !agentId) return null;

    const parsed = parseOpenAIPath(path);
    if (!parsed.ok) return null;

    const loaded = loadValidStore();
    if (!loaded.ok) return null;

    const chainEntry = resolveChain(loaded.store, agentId);
    if (!chainEntry) return null;

    const gate = generationCheck(loaded.store);
    if (!gate.ok) return { ok: false, status: gate.status, body: gate.body };

    const plan = chainState.plan(loaded.store, agentId, chainEntry.chain, Date.now());
    const members = [];
    const memberMeta = new Map(); // memberId -> { nodeId, model, poolMemberId? }
    // 本请求已计失败的节点（node+model 复合键）：noteFailure 的去重集。
    const failedNodes = new Set();
    for (const entry of plan) {
      const expanded = expandChainNode(loaded.store, entry);
      if (!expanded) continue;
      if (expanded.kind === "channel") {
        const provider = loaded.store.providers[expanded.providerId];
        const memberId = uniqueMemberId(memberMeta, expanded.providerId, entry.model);
        members.push({
          memberId,
          memberNoun: "chain node",
          call: (options = {}) => attemptChatCompletion(
            expanded.providerId, provider, { ...body, model: entry.model }, options,
          ),
        });
        memberMeta.set(memberId, { nodeId: expanded.providerId, model: entry.model });
      } else {
        const pool = resolvePool(loaded.store, expanded.poolId);
        const candidates = poolMembersWithModel(loaded.store, pool, entry.model);
        const ordered = stickyTable.order(expanded.poolId, entry.model, candidates);
        for (const { memberId: poolMemberId, provider } of ordered) {
          const flatId = uniqueMemberId(memberMeta, `${expanded.poolId}/${poolMemberId}`, entry.model);
          members.push({
            memberId: flatId,
            memberNoun: "pool member",
            call: (options = {}) => attemptChatCompletion(
              poolMemberId, provider, { ...body, model: entry.model }, options,
            ),
          });
          memberMeta.set(flatId, { nodeId: expanded.poolId, model: entry.model, poolMemberId });
        }
      }
    }

    if (members.length === 0) {
      return {
        ok: false,
        status: 404,
        body: openAIError("not_found_error", `model "${AUTO_MODEL}" has no available nodes in the chain for "${agentId}"`),
      };
    }

    return {
      ok: true,
      agentId,
      members,
      // Node-level stats attribution for the tracker: memberId -> the chain
      // node that serves it + the node's bound model (what the upstream is
      // actually asked for). Unknown memberIds resolve to null and the
      // tracker keeps its existing attribution.
      attributeOf: (memberId) => {
        const meta = memberMeta.get(memberId);
        return meta ? { providerId: meta.nodeId, model: meta.model } : null;
      },
      noteSuccess: (memberId) => {
        const meta = memberMeta.get(memberId);
        const slash = memberId.indexOf("/");
        const nodeId = meta?.nodeId ?? (slash === -1 ? memberId : memberId.slice(0, slash));
        // meta 缺 model（memberId 不来自本次 plan）时回退链配置里该节点绑定的
        // model；链里也没有（链已重编辑、节点不在链中）就跳过 noteChainSuccess——
        // 以 undefined 写入链状态会拼出 "node\nundefined" 键，位置追踪静默失效。
        const model = meta?.model ?? chainEntry.chain.find((entry) => entry?.node === nodeId)?.model;
        if (!model) return;
        noteChainSuccess(chainState, agentId, nodeId, model, Date.now());
        if (meta?.poolMemberId) {
          stickyTable.noteSuccess(nodeId, meta.model, meta.poolMemberId);
        }
      },
      // 一次请求级节点失败（成员切换真正越过该节点时由 server 侧回调）。
      // per-request 去重：号池节点整池耗尽在同一次请求里只计一次失败——
      // 连续失败计数是「请求数」口径，不是「成员数」口径。
      noteFailure: (memberId) => {
        const meta = memberMeta.get(memberId);
        const slash = memberId.indexOf("/");
        const nodeId = meta?.nodeId ?? (slash === -1 ? memberId : memberId.slice(0, slash));
        const model = meta?.model ?? chainEntry.chain.find((entry) => entry?.node === nodeId)?.model;
        if (!model) return;
        // 池成员还要进池内粘性表的成员级计数（失败才降级，与链同一规则）；
        // 成员一次请求至多 failover 一次，不需要 per-request 去重。
        if (meta?.poolMemberId) {
          stickyTable.noteFailure(nodeId, model, meta.poolMemberId);
        }
        const key = chainNodeKey(nodeId, model);
        if (failedNodes.has(key)) return;
        failedNodes.add(key);
        noteChainFailure(chainState, agentId, nodeId, model);
      },
    };
  }

  return { authorize, handleModels, handleChatCompletions, planPoolChatCompletions, planChainChatCompletions, chainState };
}