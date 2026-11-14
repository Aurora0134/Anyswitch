import { relayTokenAccepted } from "../launchers/pi-relay-token.mjs";
import { parseOpenAIPath, PARSE_REASON } from "./openai-path.mjs";
import { providerRoutingShapes, findStaleTargets } from "../catalog/catalog-generation.mjs";
import { extractPresentedToken } from "./handler.mjs";
import { validateStore } from "../store/store-schema.mjs";
import { resolvePool, poolMembersWithModel, poolModelsUnion, createStickyTable } from "../channels/pool-routing.mjs";
import { createLoadBalancer } from "../channels/pool-load-routing.mjs";
import { AUTO_MODEL, resolveChain, resolveVirtualModelEntry, expandChainNode, createChainState, noteChainSuccess, noteChainFailure, logChainDemote, chainNodeKey, uniqueMemberId } from "../channels/chain-routing.mjs";
import { defaultEffortInjector, looksLikeEffortRejection, readResponseText } from "../catalog/effort-injection.mjs";
import { buildChannelModelSlugCatalog } from "../channels/channel-model-slug.mjs";
import { requestModelIsTextOnly, looksLikeTextOnlyRejection } from "../catalog/text-models.mjs";
import { requestHasImages, stripImages, noteImageFallback } from "./media-strip.mjs";
import { imageFallbackEnabled, imageHeuristicEnabled, poolLoadBalancingEnabled } from "./relay-settings.mjs";

// The optional `code` rides inside the error object. OpenAI's own error
// schema types `code` as a string, but the numeric form (e.g. 429, 502) is
// common in the wild and is what downstream agents that auto-retry on a
// status code actually compare against. The value is therefore passed
// through unchanged: a number stays a number, a string stays a string.
export function openAIError(type, message, code = null) {
  const error = { type, message };
  if (code !== null && code !== undefined) error.code = code;
  return { error };
}

// The body the keep-alive loop re-issues when a truncated turn is resumed.
// Everything the client has already seen goes back upstream as the
// assistant's partial output: text, reasoning, and every completed tool
// call. The resume instruction names the shape so the model does not start
// over.
//
// The shape is chosen per wire: Anthropic gets a native assistant prefill
// (the model continues from the partial turn), OpenAI-compatible upstreams
// get an assistant turn plus a continuation hint. The caller passes the
// original request body and the shadow; the result is a body the upstream
// sees as one continued turn.
export function buildResumeBody(originalBody, shadow) {
  if (shadow === null || shadow === undefined) return originalBody;

  const text = typeof shadow.text === "string" ? shadow.text : "";
  const reasoning = typeof shadow.reasoning === "string" ? shadow.reasoning : "";
  const calls = Array.isArray(shadow.calls) ? shadow.calls : [];

  // A cut with nothing the client saw is a clean retry, not a resume.
  if (!text && !reasoning && calls.length === 0) return originalBody;

  const original = originalBody === null || typeof originalBody !== "object" ? {} : originalBody;
  const messages = Array.isArray(original.messages) ? original.messages.slice() : [];

  // Anthropic wire: assistant prefill. The partial output is the last
  // assistant message, and the model continues from it. No continuation
  // instruction is needed — the prefill IS the continuation.
  if (original.system !== undefined || messages.some((m) => m?.role === "user" && Array.isArray(m?.content))) {
    // Build the prefill content: text blocks for text, tool_use blocks for
    // completed calls. Reasoning is folded into the first text block (the
    // Anthropic wire has no separate reasoning content type on input).
    const content = [];
    if (text) content.push({ type: "text", text: reasoning ? reasoning + text : text });
    else if (reasoning) content.push({ type: "text", text: reasoning });
    for (const call of calls) {
      if (call === null || typeof call !== "object") continue;
      let args;
      try {
        args = JSON.parse(call.args);
      } catch {
        args = {};
      }
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: args,
      });
    }
    if (content.length === 0) return originalBody;
    return {
      ...original,
      messages: [...messages, { role: "assistant", content }],
    };
  }

  // OpenAI-compatible wire: an assistant turn carrying the partial output,
  // followed by a continuation hint. The hint names what has already been
  // emitted so the model does not repeat it.
  const assistantMessage = { role: "assistant" };
  if (reasoning) assistantMessage.reasoning_content = reasoning;
  if (text) assistantMessage.content = text;
  if (calls.length > 0) {
    assistantMessage.tool_calls = calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.args },
    }));
  }
  if (text || reasoning || calls.length > 0) {
    messages.push(assistantMessage);
  }
  // The continuation hint: tell the model what was already emitted so it
  // continues instead of restarting. "已输出" 是给模型看的，不是给用户看的。
  const alreadyEmitted = [];
  if (text) alreadyEmitted.push(`正文「${text.slice(0, 50)}${text.length > 50 ? "…" : ""}」`);
  if (reasoning) alreadyEmitted.push("一段思考");
  if (calls.length > 0) alreadyEmitted.push(`${calls.length} 个已完成的工具调用`);
  messages.push({
    role: "user",
    content:
      alreadyEmitted.length > 0
        ? `上一段输出中${alreadyEmitted.join("、")}已发给用户。请从被打断处继续输出，不要重复已输出内容，也不要重新执行已完成的工具调用。`
        : "请从被打断处继续输出，不要重复已输出内容。",
  });

  return { ...original, messages };
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

// Upstreams reject an assistant tool_call whose id or function name is empty
// (observed: stepfun answers 400), and such an entry is unanswerable anyway:
// no tool message can ever pair with an empty/missing id. A client that
// replays a corrupted turn then hard-fails every later request of the
// session, so drop the unusable calls together with the tool messages they
// can never match, and drop an assistant message the cleanup leaves empty.
function stripUnusableToolCalls(body) {
  if (!Array.isArray(body.messages)) return body;
  const survivingIds = new Set();
  for (const message of body.messages) {
    if (message === null || typeof message !== "object" || message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      if (hasUsableIdentity(call)) survivingIds.add(call.id);
    }
  }
  let touched = false;
  const messages = [];
  for (const message of body.messages) {
    if (message !== null && typeof message === "object" && message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const toolCalls = message.tool_calls.filter(hasUsableIdentity);
      if (toolCalls.length !== message.tool_calls.length) touched = true;
      const content = message.content;
      const contentEmpty = content == null || content === "" || (Array.isArray(content) && content.length === 0);
      if (toolCalls.length === 0 && contentEmpty) { touched = true; continue; }
      messages.push(toolCalls.length === message.tool_calls.length ? message : { ...message, tool_calls: toolCalls });
      continue;
    }
    if (message !== null && typeof message === "object" && message.role === "tool") {
      const id = message.tool_call_id;
      if (typeof id !== "string" || id.length === 0 || !survivingIds.has(id)) { touched = true; continue; }
    }
    messages.push(message);
  }
  return touched ? { ...body, messages } : body;
}

function hasUsableIdentity(call) {
  return typeof call?.id === "string" && call.id.length > 0
    && typeof call?.function?.name === "string" && call.function.name.length > 0;
}

export function createOpenAIHandler(deps) {
  const {
    loadStore,
    loadCredential,
    upstreamFetch,
    buildUpstreamURLs = (provider, path) => [provider.baseURL, ...(provider.fallbackURLs ?? [])]
      .map((baseURL) => `${baseURL.replace(/\/+$/, "")}${path}`),
    recordGeneration,
    readGeneration,
    logger = null,
    effortInjector = null,
    serviceHealth = null,
    // 图片降级两门：thunk 形式每请求现读（与 effort 开关的即改即生效契约
    // 一致）；未注入时走 relay-settings 的磁盘现读默认，测试注入定值。
    imageFallbackGate = imageFallbackEnabled,
    imageHeuristicGate = imageHeuristicEnabled,
    poolLoadBalancingGate = poolLoadBalancingEnabled,
  } = deps;

  const efforts = effortInjector ?? defaultEffortInjector({ logger });

  // Sticky pool routing: (poolId, modelId) -> last successful member. Lives
  // in the handler closure, so it is process memory and resets on restart.
  const stickyTable = createStickyTable();

  // 智能分流（poolLoadBalancing）：开启后号池改用加权最小负载分流，关闭时
  // 沿用上面的粘性表。与 stickyTable 同一闭包生命周期（进程内存，重启清零）。
  const loadBalancer = createLoadBalancer();

  // 号池路由门面：按当前开关在粘性表与负载均衡器之间二选一，规划时一次性定模式
  // （避免请求中途翻开关导致 order 与记账走不同机制）。关闭时返回值与旧粘性
  // 路径逐字节一致：noteSuccess 忽略多余的 ttft 参数，begin/end 为 undefined。
  function poolRouting(poolId, modelId, candidates, sessionKey) {
    if (poolLoadBalancingGate()) {
      return {
        useLb: true,
        ordered: loadBalancer.order(poolId, modelId, candidates, sessionKey),
        noteSuccess: (memberId, ttftMs) => loadBalancer.noteSuccess(poolId, modelId, memberId, ttftMs, sessionKey),
        noteFailure: (memberId) => loadBalancer.noteFailure(poolId, modelId, memberId, sessionKey),
        begin: (memberId) => loadBalancer.begin(memberId),
        end: (memberId) => loadBalancer.end(memberId),
      };
    }
    return {
      useLb: false,
      ordered: stickyTable.order(poolId, modelId, candidates),
      noteSuccess: (memberId) => stickyTable.noteSuccess(poolId, modelId, memberId),
      noteFailure: (memberId) => stickyTable.noteFailure(poolId, modelId, memberId),
    };
  }

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
    if (!relayTokenAccepted(deps, presented)) {
      return { ok: false, status: 401, body: openAIError("authentication_error", "invalid relay token") };
    }
    return { ok: true };
  }

  function loadValidStore() {
    const loaded = loadStore();
    if (!loaded.ok) {
      serviceHealth?.recordFailure("store");
      return { ok: false, status: 502, body: openAIError("api_error", "the Anyswitch global store could not be read") };
    }
    const result = validateStore(loaded.store);
    if (!result.valid) {
      serviceHealth?.recordFailure("store");
      return { ok: false, status: 502, body: openAIError("api_error", "the Anyswitch global store failed schema validation") };
    }
    return { ok: true, store: loaded.store };
  }

  function resolveProvider(store, providerId) {
    const provider = store.providers?.[providerId];
    if (provider === undefined) {
      return { ok: false, status: 404, body: openAIError("not_found_error", `provider "${providerId}" is not in the Anyswitch store`) };
    }
    return { ok: true, provider };
  }

  // The catalog gate, scoped to the channels THIS request may reach, so editing
  // an unrelated channel cannot invalidate a live session (see
  // catalog-generation.mjs for what a channel's shape covers). A channel that
  // appeared after discovery is not stale; a deleted one is the 404 path's
  // business.
  function generationCheck(store, providerIds) {
    const stale = findStaleTargets(readGeneration(), store, providerIds);
    if (stale.length === 0) return { ok: true };
    const channels = stale.map((providerId) => `"${providerId}"`).join(", ");
    return {
      ok: false,
      status: 409,
      body: openAIError(
        "invalid_request_error",
        `the upstream endpoint of ${channels} changed since this client discovered its models; `
        + "re-run model discovery (restart the endpoint, or pick the model again in /model) before retrying",
      ),
    };
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
    if (agentId === "codex") {
      // codex 的模型选择器读静态目录（model_catalog_json），provider 是全局
      // 单选——目录把渠道编码进 slug（<channelId>~<modelId>，见
      // channel-model-slug.mjs），/models 与目录保持同一口径：全部可见渠道
      // 的并集，与 URL 段无关（任一 provider 入口都可能被问到全部模型）。
      response = {
        object: "list",
        data: buildChannelModelSlugCatalog(loaded.store).map((entry) => ({ id: entry.slug, object: "model" })),
      };
    } else {
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
    }

    // Chain routing (自动路由): an agent with a configured route chain may
    // send model "auto", so advertise the virtual entry alongside the real
    // models. Same shape as every other entry — clients that never send
    // "auto" can ignore it.
    if (agentId && resolveChain(loaded.store, agentId)) {
      response.data.push({ id: AUTO_MODEL, object: "model" });
    }

    // 虚拟模型：不绑定端点，任何可识别的请求方都能看到（agentId 缺失也照列
    // ——这正是与 auto 的区别）。裸 id 即模型名，拦截优先于一切 provider 解析。
    for (const vm of Array.isArray(loaded.store.virtualModels) ? loaded.store.virtualModels : []) {
      // 准入走 resolveVirtualModelEntry 单一收口：目录里列出的必须是请求路径真
      // 认得的虚拟模型，判定收紧只改查链入口那一处，不再内联复制。
      if (!resolveVirtualModelEntry(loaded.store, vm?.name)) continue;
      response.data.push({ id: vm.name, object: "model" });
    }

    // Bind this discovery result to the endpoint each channel resolves to.
    recordGeneration(providerRoutingShapes(loaded.store));
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

    const gate = generationCheck(loaded.store, [parsed.providerId]);
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
    // 凭据在请求时刻取；是否缓存由 credentialCacheEnabled 决定（见 launch.mjs）。
    const credentialStartedAt = Date.now();
    const credential = await loadCredential(providerId, provider);
    if (!credential.ok) {
      // 这一条日志是这类故障唯一的证据来源：客户端只看到一句笼统的 502，而
      // 原因（文件缺失 / 助手没起来 / 助手超时 / 解密失败）只有中继知道。
      serviceHealth?.recordFailure("credential");
      logger?.error?.(
        `credential load failed for provider "${providerId}" (${credential.reason}, ${Date.now() - credentialStartedAt}ms)`,
      );
      return { status: 502, body: openAIError("api_error", "the upstream credential for this provider could not be loaded") };
    }

    const urls = buildUpstreamURLs(provider, "/chat/completions");

    // options.overrideBody replaces the request body wholesale — the keep-alive
    // loop's resume path re-issues the same upstream with the partial output
    // appended (see runStreamWithKeepAlive), and must not re-run this
    // function's own input-body plumbing on the stitched body.
    const sourceBody = options.overrideBody !== undefined ? options.overrideBody : body;
    const normalizedBody = normalizeToolCallArguments(stripUnusableToolCalls(sourceBody));
    const withUsage = normalizedBody.stream === true
      ? {
          ...normalizedBody,
          stream_options: {
            ...(normalizedBody.stream_options && typeof normalizedBody.stream_options === "object" ? normalizedBody.stream_options : {}),
            include_usage: true,
          },
        }
      : normalizedBody;
    // A client that named its own level wins; this only ever fills a gap. The
    // store row rides along so a channel that states its own levels wins over
    // the library, same rule as the config face.
    const { body: injectedBody, injected } = efforts.inject({
      providerId,
      body: withUsage,
      model: provider.models?.[withUsage.model],
      provider,
    });

    // 图片降级预判：store 模态声明（不受开关控制）或内置名单命中（受预判子
    // 开关控制）时，send 前把图替换为占位标记——带图请求发给纯文本模型本来
    // 是整单 400、对话中断，占位后模型至少能答。此路径覆盖 openai 直传与
    // responses 翻译体（tool 输出图的占位归 responses-translate，不重叠）。
    const modelId = withUsage.model;
    let outboundBody = injectedBody;
    if (
      requestHasImages(outboundBody)
      && requestModelIsTextOnly(provider.models?.[modelId], modelId, imageHeuristicGate())
    ) {
      const { body: stripped, count } = stripImages(outboundBody);
      if (count > 0) {
        outboundBody = stripped;
        noteImageFallback({ providerId, modelId, count, via: "predict", logger });
      }
    }

    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${credential.value}`,
    };
    const send = (payload) => upstreamFetch(
      urls,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: options.signal,
      },
      { bufferResponse: body.stream !== true },
    );

    let upstream;
    try {
      upstream = await send(outboundBody);
    } catch (err) {
      if (options.signal?.aborted) {
        throw err;
      }
      return { status: 502, body: openAIError("api_error", "the upstream provider could not be reached") };
    }

    // 请求真的到了上游：凭据读得出、网络出得去，中继自己的活干完了。上游之后回
    // 429/5xx 是上游的问题，不改变「我还能服务」这个事实。
    serviceHealth?.recordSuccess();

    // A gateway that does not take the parameter at all gets the same request
    // back off without it, once; the channel is then left alone for the rest of
    // this process's life. Only a level WE added can be removed this way.
    let firstRejectionDetail = null;
    if (!upstream.ok && (injected !== null || (requestHasImages(outboundBody) && imageFallbackGate()))) {
      firstRejectionDetail = await readResponseText(upstream);
    }

    let effortRetried = false;
    if (!upstream.ok && injected !== null) {
      if (looksLikeEffortRejection(upstream.status, firstRejectionDetail ?? "")) {
        upstreamFetch.releaseResponse?.(upstream);
        efforts.noteRejected(providerId);
        try {
          upstream = await send(efforts.withoutEffort(outboundBody));
          effortRetried = true;
        } catch (err) {
          if (options.signal?.aborted) {
            throw err;
          }
          return { status: 502, body: openAIError("api_error", "the upstream provider could not be reached") };
        }
      }
    }

    // 图片降级兜底：漏判（模型纯文本但声明与名单都没说中）时，上游 4xx 的措辞
    // 自证「只支持文本」，把图替换为占位标记重试一次，仍失败才按原错误透传。
    // 顺序先 effort 后图片、各至多一次；重试基体取产出本次拒绝的请求——effort
    // 重试已发生时用去 effort 体，不把刚被拒的参数再放回线上。
    if (!upstream.ok && requestHasImages(outboundBody) && imageFallbackGate()) {
      const detail = effortRetried ? await readResponseText(upstream) : (firstRejectionDetail ?? "");
      if (looksLikeTextOnlyRejection(upstream.status, detail)) {
        const base = effortRetried ? efforts.withoutEffort(outboundBody) : outboundBody;
        const { body: stripped, count } = stripImages(base);
        if (count > 0) {
          upstreamFetch.releaseResponse?.(upstream);
          noteImageFallback({ providerId, modelId, count, via: "fallback", logger });
          try {
            upstream = await send(stripped);
          } catch (err) {
            if (options.signal?.aborted) {
              throw err;
            }
            return { status: 502, body: openAIError("api_error", "the upstream provider could not be reached") };
          }
        }
      }
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

  // Pool routing pre-flight. Returns:
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
  async function planPoolChatCompletions(path, headers, body, sessionKey = null) {
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

    const modelId = body.model;
    // A pool id is not a channel: gate over exactly the members this request
    // could call. With no candidate member there is nothing that can be stale,
    // so that case keeps its own 404 below.
    const candidates = poolMembersWithModel(loaded.store, pool, modelId);
    const gate = generationCheck(loaded.store, candidates.map((candidate) => candidate.memberId));
    if (!gate.ok) return { ok: false, status: gate.status, body: gate.body };

    if (candidates.length === 0) {
      return {
        ok: false,
        status: 404,
        body: openAIError("not_found_error", `model "${modelId}" is not in pool "${parsed.providerId}"`),
      };
    }

    const routing = poolRouting(parsed.providerId, modelId, candidates, sessionKey);
    return {
      ok: true,
      poolId: parsed.providerId,
      modelId,
      members: routing.ordered.map(({ memberId, provider }) => ({
        memberId,
        call: (options = {}) => attemptChatCompletion(memberId, provider, body, options),
      })),
      noteSuccess: (memberId, ttftMs) => routing.noteSuccess(memberId, ttftMs),
      // 成员级请求失败计数（该成员本次请求彻底失败时由 server 侧回调，
      // 末位成员同样计入）——号池粘性位降级门控（失败才降级）的计数来源。
      // 一个成员在一次请求里至多失败一次（keep-alive 重试在成员内部吸收），无需去重。
      noteFailure: (memberId) => routing.noteFailure(memberId),
      // 智能分流开启时的在途计数钩子（关闭时为 undefined，server 侧 ?. 空操作）。
      beginMember: routing.begin,
      endMember: routing.end,
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
  async function planChainChatCompletions(path, headers, body, agentId, sessionKey = null) {
    const auth = authorize(headers);
    if (!auth.ok) return { ok: false, status: auth.status, body: auth.body };

    // Not an object: classic routing reports the shape error.
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;

    const parsed = parseOpenAIPath(path);
    if (!parsed.ok) return null;

    const loaded = loadValidStore();
    if (!loaded.ok) return null;

    // 路由键与链的来源：auto 走请求方端点的链（必须可识别），虚拟模型名走
    // 自己的链（端点无关，agentId 缺失也照走——名字本身就是全局路由键）。
    // 链状态表也按路由键分格：auto 沿用端点 id，虚拟模型用名字（保存时
    // schema 禁用端点 id 撞名，两格永不重叠）。
    let chainEntry = null;
    let routeKey = null;
    let requested = null;
    if (body.model === AUTO_MODEL) {
      if (!agentId) return null;
      chainEntry = resolveChain(loaded.store, agentId);
      routeKey = agentId;
      requested = AUTO_MODEL;
    } else {
      chainEntry = resolveVirtualModelEntry(loaded.store, body.model);
      routeKey = chainEntry?.name ?? null;
      requested = body.model;
    }
    if (!chainEntry || !Array.isArray(chainEntry.chain) || chainEntry.chain.length === 0) return null;

    // Reachable channels, derived from the CONFIGURED chain without touching
    // chainState: plan() re-anchors the backoff probe window, and a request
    // refused here must not spend that probe. A node that no longer resolves
    // contributes nothing — the existing 404 path owns it.
    const reachable = [];
    for (const entry of chainEntry.chain) {
      const expanded = expandChainNode(loaded.store, entry);
      if (!expanded) continue;
      if (expanded.kind === "channel") reachable.push(expanded.providerId);
      else reachable.push(...expanded.memberIds);
    }
    const gate = generationCheck(loaded.store, reachable);
    if (!gate.ok) return { ok: false, status: gate.status, body: gate.body };

    const plan = chainState.plan(loaded.store, routeKey, chainEntry.chain, Date.now());
    const members = [];
    const memberMeta = new Map(); // memberId -> { nodeId, model, poolMemberId?, routing? }
    // 本请求已计失败的节点（node+model 复合键）：noteFailure 的去重集。
    const failedNodes = new Set();
    // 链里任一池节点走了智能分流，整条链就暴露在途计数钩子。
    let poolLbActive = false;
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
        const routing = poolRouting(expanded.poolId, entry.model, candidates, sessionKey);
        poolLbActive = poolLbActive || routing.useLb;
        for (const { memberId: poolMemberId, provider } of routing.ordered) {
          const flatId = uniqueMemberId(memberMeta, `${expanded.poolId}/${poolMemberId}`, entry.model);
          members.push({
            memberId: flatId,
            memberNoun: "pool member",
            call: (options = {}) => attemptChatCompletion(
              poolMemberId, provider, { ...body, model: entry.model }, options,
            ),
          });
          memberMeta.set(flatId, { nodeId: expanded.poolId, model: entry.model, poolMemberId, routing });
        }
      }
    }

    if (members.length === 0) {
      // 保留既有 auto 报错口径（点名请求方端点）；虚拟模型请求 agentId 可缺，
      // 缺则省略尾巴。requested 已点名模型（auto 或虚拟模型名）。
      const tail = agentId ? ` for "${agentId}"` : "";
      return {
        ok: false,
        status: 404,
        body: openAIError("not_found_error", `model "${requested}" has no available nodes in the chain${tail}`),
      };
    }

    return {
      ok: true,
      agentId,
      members,
      // Node-level stats attribution for the tracker: memberId -> the chain
      // node that serves it + the node's bound model (what the upstream is
      // actually asked for). Unknown memberIds resolve to null and the
      // tracker keeps its existing attribution. chainKey names the chain that
      // produced this member (endpoint id / virtual model name) so the panel
      // can locate the hop in the chain that actually served the request.
      attributeOf: (memberId) => {
        const meta = memberMeta.get(memberId);
        return meta ? { providerId: meta.nodeId, model: meta.model, chainKey: routeKey } : null;
      },
      noteSuccess: (memberId, ttftMs) => {
        const meta = memberMeta.get(memberId);
        const slash = memberId.indexOf("/");
        const nodeId = meta?.nodeId ?? (slash === -1 ? memberId : memberId.slice(0, slash));
        // meta 缺 model（memberId 不来自本次 plan）时回退链配置里该节点绑定的
        // model；链里也没有（链已重编辑、节点不在链中）就跳过 noteChainSuccess——
        // 以 undefined 写入链状态会拼出 "node\nundefined" 键，位置追踪静默失效。
        const model = meta?.model ?? chainEntry.chain.find((entry) => entry?.node === nodeId)?.model;
        if (!model) return;
        noteChainSuccess(chainState, routeKey, nodeId, model, Date.now());
        if (meta?.poolMemberId) {
          meta.routing.noteSuccess(meta.poolMemberId, ttftMs);
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
        // 池成员还要进池内路由的成员级计数（失败才降级，与链同一规则）；
        // 成员一次请求至多 failover 一次，不需要 per-request 去重。
        if (meta?.poolMemberId) {
          meta.routing.noteFailure(meta.poolMemberId);
        }
        const key = chainNodeKey(nodeId, model);
        if (failedNodes.has(key)) return;
        failedNodes.add(key);
        noteChainFailure(chainState, routeKey, nodeId, model);
      },
      // 智能分流开启时（链含池节点）暴露在途计数钩子；纯渠道链或关闭时为
      // undefined，server 侧 ?. 空操作。链成员的 memberId 是扁平 id
      // （pool/member），在途计数须翻回池成员 id 才能与 order 的负载键对齐。
      beginMember: poolLbActive ? (memberId) => loadBalancer.begin(memberMeta.get(memberId)?.poolMemberId ?? memberId) : undefined,
      endMember: poolLbActive ? (memberId) => loadBalancer.end(memberMeta.get(memberId)?.poolMemberId ?? memberId) : undefined,
    };
  }

  return { authorize, handleModels, handleChatCompletions, planPoolChatCompletions, planChainChatCompletions, chainState };
}
