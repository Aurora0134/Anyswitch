import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIHandler } from "./openai-handler.mjs";
import { createRetryingFetch } from "./launch.mjs";
import { providerRoutingShapes } from "./catalog-generation.mjs";
import { createEffortInjector } from "./effort-injection.mjs";

const TOKEN = "test-token-123";

// 不读机器状态的 effort 注入器。这些用例主张的是鉴权/路由/透传/重试边界，
// 注入与否不是它们的主张；不注入时 handler 落回生产默认注入器，每请求现场读
// 真实用户的 settings.json 与 thinking-efforts 库，用例结果随机器状态漂移。
// isEnabled 钉死后请求体原样上行，且不碰任何磁盘文件。
const makeOffEffortInjector = () => createEffortInjector({ isEnabled: () => false });

function makeStore() {
  return {
    version: 2,
    providers: {
      "poke-api": {
        displayName: "Poke API",
        baseURL: "https://poke.example/v1",
        protocol: "openai-compatible",
        credentialFile: "poke-api.dpapi",
        models: {
          "claude-opus-5": { displayName: "Claude Opus 5" },
          "claude-sonnet-4": { displayName: "Claude Sonnet 4" },
        },
      },
      "deepseek": {
        displayName: "DeepSeek",
        baseURL: "https://deepseek.example/v1",
        protocol: "openai-compatible",
        credentialFile: "deepseek.dpapi",
        models: {
          "deepseek-v4": { displayName: "DeepSeek V4" },
        },
      },
    },
  };
}

function makeHandler({ store = makeStore(), credential = "sk-test", upstream = null } = {}) {
  let generation = null;
  return createOpenAIHandler({
    token: TOKEN,
    loadStore: () => ({ ok: true, store }),
    loadCredential: (providerId) =>
      credential === null
        ? { ok: false, reason: "credential missing" }
        : { ok: true, value: credential },
    upstreamFetch: async () => upstream,
    effortInjector: makeOffEffortInjector(),
    recordGeneration: (value) => {
      generation = value;
    },
    readGeneration: () => generation,
  });
}

function success(payload = { choices: [] }) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("openai handler authorization", () => {
  it("rejects missing token with 401", async () => {
    const handler = makeHandler();
    const result = await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      {},
      { model: "claude-opus-5", messages: [] },
    );
    assert.equal(result.status, 401);
    assert.equal(result.body.error.type, "authentication_error");
  });

  it("rejects wrong token with 401", async () => {
    const handler = makeHandler();
    const result = await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: "Bearer wrong" },
      { model: "claude-opus-5", messages: [] },
    );
    assert.equal(result.status, 401);
  });

  it("accepts bare token and Bearer prefix", async () => {
    const handler = makeHandler({
      upstream: { ok: true, status: 200, json: async () => ({ choices: [] }) },
    });
    const bare = await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: TOKEN },
      { model: "claude-opus-5", messages: [] },
    );
    assert.equal(bare.status, 200);
    const bearer = await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: `Bearer ${TOKEN}` },
      { model: "claude-opus-5", messages: [] },
    );
    assert.equal(bearer.status, 200);
  });
});

describe("openai handler path routing", () => {
  it("rejects non-openai path with 404", async () => {
    const handler = makeHandler();
    const result = await handler.handleChatCompletions(
      "/v1/messages",
      { authorization: TOKEN },
      { model: "x", messages: [] },
    );
    assert.equal(result.status, 404);
  });

  it("rejects unknown provider with 404", async () => {
    const handler = makeHandler();
    const result = await handler.handleChatCompletions(
      "/openai/ghost/v1/chat/completions",
      { authorization: TOKEN },
      { model: "claude-opus-5", messages: [] },
    );
    assert.equal(result.status, 404);
    assert.match(result.body.error.message, /not in the Anyswitch store/);
  });

  it("rejects unknown model with 404 and no upstream call", async () => {
    let called = false;
    const handler = createOpenAIHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store: makeStore() }),
      loadCredential: () => ({ ok: true, value: "sk" }),
      upstreamFetch: async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({}) };
      },
      recordGeneration: () => {},
      readGeneration: () => null,
    });
    const result = await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: TOKEN },
      { model: "ghost-model", messages: [] },
    );
    assert.equal(result.status, 404);
    assert.equal(called, false);
  });
});

describe("openai handler body passthrough", () => {
  it("passes body.model through unchanged to upstream", async () => {
    let sentBody = null;
    const handler = createOpenAIHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store: makeStore() }),
      loadCredential: () => ({ ok: true, value: "sk-upstream" }),
      upstreamFetch: async (_url, init) => {
        sentBody = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: "hi" } }] }) };
      },
      effortInjector: makeOffEffortInjector(),
      recordGeneration: () => {},
      readGeneration: () => null,
    });
    const result = await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: TOKEN },
      { model: "claude-opus-5", messages: [{ role: "user", content: "hello" }] },
    );
    assert.equal(result.status, 200);
    assert.equal(sentBody.model, "claude-opus-5");
    assert.equal(sentBody.messages[0].content, "hello");
  });

  it("injects Bearer credential to upstream", async () => {
    let authHeader = null;
    const handler = createOpenAIHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store: makeStore() }),
      loadCredential: () => ({ ok: true, value: "sk-secret-value" }),
      upstreamFetch: async (_url, init) => {
        authHeader = init.headers.authorization;
        return { ok: true, status: 200, json: async () => ({ choices: [] }) };
      },
      effortInjector: makeOffEffortInjector(),
      recordGeneration: () => {},
      readGeneration: () => null,
    });
    await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: TOKEN },
      { model: "claude-opus-5", messages: [] },
    );
    assert.equal(authHeader, "Bearer sk-secret-value");
  });

  it("fails closed with 502 when credential cannot be loaded", async () => {
    const handler = makeHandler({ credential: null });
    const result = await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: TOKEN },
      { model: "claude-opus-5", messages: [] },
    );
    assert.equal(result.status, 502);
  });

  it("fails closed with 502 when upstream is unreachable", async () => {
    const handler = createOpenAIHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store: makeStore() }),
      loadCredential: () => ({ ok: true, value: "sk" }),
      upstreamFetch: async () => {
        throw new Error("network down");
      },
      effortInjector: makeOffEffortInjector(),
      recordGeneration: () => {},
      readGeneration: () => null,
    });
    const result = await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: TOKEN },
      { model: "claude-opus-5", messages: [] },
    );
    assert.equal(result.status, 502);
  });

  it("passes upstream error status class through without raw body", async () => {
    const handler = makeHandler({
      upstream: { ok: false, status: 429 },
    });
    const result = await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: TOKEN },
      { model: "claude-opus-5", messages: [] },
    );
    assert.equal(result.status, 429);
    assert.match(result.body.error.message, /returned status 429/);
  });

  it("hands the default-built primary-first URL list to the upstream fetch", async () => {
    // 不注入 buildUpstreamURLs：钉的是 handler 默认构造器的实际产物——
    // primary 在前、尾斜杠收敛、fallback 依序跟上（构造器本身的语义已由
    // launch.test.mjs 覆盖，这里钉的是 handler 转手交给 upstreamFetch 的东西）。
    const store = makeStore();
    store.providers["poke-api"].baseURL = "https://primary.example/v1/";
    store.providers["poke-api"].fallbackURLs = ["https://backup.example/v1"];
    let receivedURLs = null;
    const handler = createOpenAIHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store }),
      loadCredential: () => ({ ok: true, value: "sk" }),
      effortInjector: makeOffEffortInjector(),
      upstreamFetch: async (urls) => {
        receivedURLs = urls;
        return success();
      },
      recordGeneration: () => {},
      readGeneration: () => null,
    });

    const result = await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: TOKEN },
      { model: "claude-opus-5", messages: [] },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(receivedURLs, [
      "https://primary.example/v1/chat/completions",
      "https://backup.example/v1/chat/completions",
    ]);
  });

  it("retries a 5xx primary against the OpenAI route fallback", async () => {
    const store = makeStore();
    store.providers["poke-api"].fallbackURLs = ["https://backup.example/v1"];
    const calls = [];
    const handler = createOpenAIHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store }),
      loadCredential: () => ({ ok: true, value: "sk" }),
      buildUpstreamURLs: (provider, path) => [provider.baseURL, ...provider.fallbackURLs]
        .map((baseURL) => `${baseURL.replace(/\/+$/, "")}${path}`),
      upstreamFetch: createRetryingFetch(
        async (url) => {
          calls.push(url);
          return url.includes("poke.example")
            ? { status: 503 }
            : success({ choices: [{ message: { content: "fallback" } }] });
        },
        { sleep: async () => {} },
      ),
      effortInjector: makeOffEffortInjector(),
      recordGeneration: () => {},
      readGeneration: () => null,
    });

    const result = await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: TOKEN },
      { model: "claude-opus-5", messages: [] },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(calls, [
      "https://poke.example/v1/chat/completions",
      "https://backup.example/v1/chat/completions",
    ]);
    assert.equal(result.body.choices[0].message.content, "fallback");
  });

  it("does not retry a terminal OpenAI route 4xx", async () => {
    const store = makeStore();
    store.providers["poke-api"].fallbackURLs = ["https://backup.example/v1"];
    const calls = [];
    const handler = createOpenAIHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store }),
      loadCredential: () => ({ ok: true, value: "sk" }),
      buildUpstreamURLs: (provider, path) => [provider.baseURL, ...provider.fallbackURLs]
        .map((baseURL) => `${baseURL.replace(/\/+$/, "")}${path}`),
      upstreamFetch: createRetryingFetch(
        async (url) => {
          calls.push(url);
          return { status: 429 };
        },
        { sleep: async () => {} },
      ),
      effortInjector: makeOffEffortInjector(),
      recordGeneration: () => {},
      readGeneration: () => null,
    });

    const result = await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: TOKEN },
      { model: "claude-opus-5", messages: [] },
    );
    assert.equal(result.status, 429);
    assert.deepEqual(calls, ["https://poke.example/v1/chat/completions"]);
  });

  it("returns stream passthrough when stream is true", async () => {
    const handler = makeHandler({
      upstream: { ok: true, status: 200, body: "stream-data" },
    });
    const result = await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: TOKEN },
      { model: "claude-opus-5", stream: true, messages: [] },
    );
    assert.equal(result.status, 200);
    assert.equal(result.stream, "stream-data");
  });
});

describe("openai handler models discovery", () => {
  it("returns only the requested provider's models", async () => {
    const handler = makeHandler();
    const result = await handler.handleModels("/openai/poke-api/v1/models", {
      authorization: TOKEN,
    });
    assert.equal(result.status, 200);
    const ids = result.body.data.map((m) => m.id).sort();
    assert.deepEqual(ids, ["claude-opus-5", "claude-sonnet-4"]);
  });

  it("returns the channel-qualified union for codex, regardless of the URL segment", async () => {
    const handler = makeHandler();
    const result = await handler.handleModels("/openai/poke-api/v1/models", { authorization: TOKEN }, "codex");
    assert.equal(result.status, 200);
    const ids = result.body.data.map((m) => m.id).sort();
    assert.deepEqual(ids, ["deepseek~deepseek-v4", "poke-api~claude-opus-5", "poke-api~claude-sonnet-4"]);
    // Same answer from the other provider's entry point: every codex provider
    // is an equivalent doorway once the channel rides the model slug.
    const viaDeepseek = await handler.handleModels("/openai/deepseek/v1/models", { authorization: TOKEN }, "codex");
    assert.deepEqual(viaDeepseek.body.data.map((m) => m.id).sort(), ids);
  });

  it("records catalog generation on discovery", async () => {
    let recorded = null;
    const handler = createOpenAIHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store: makeStore() }),
      loadCredential: () => ({ ok: true, value: "sk" }),
      upstreamFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      recordGeneration: (value) => {
        recorded = value;
      },
      readGeneration: () => recorded,
    });
    await handler.handleModels("/openai/poke-api/v1/models", { authorization: TOKEN });
    assert.ok(recorded);
  });

  it("rejects stale catalog with 409 before credential load", async () => {
    let credentialLoaded = false;
    // The snapshot discovery bound: poke-api pointed somewhere else then.
    const discovered = makeStore();
    discovered.providers["poke-api"].baseURL = "https://elsewhere.invalid/v1";
    let generation = providerRoutingShapes(discovered);
    const handler = createOpenAIHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store: makeStore() }),
      loadCredential: () => {
        credentialLoaded = true;
        return { ok: true, value: "sk" };
      },
      upstreamFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      recordGeneration: (value) => {
        generation = value;
      },
      readGeneration: () => generation,
    });
    const result = await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: TOKEN },
      { model: "claude-opus-5", messages: [] },
    );
    assert.equal(result.status, 409);
    assert.equal(credentialLoaded, false);
  });

  it("a change to a channel this request never touches still routes", async () => {
    let upstreamCalls = 0;
    // Discovery bound both channels; afterwards deepseek was re-pointed.
    const store = makeStore();
    let generation = providerRoutingShapes(store);
    store.providers["deepseek"].baseURL = "https://elsewhere.invalid/v1";
    const handler = createOpenAIHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store }),
      loadCredential: () => ({ ok: true, value: "sk" }),
      upstreamFetch: async () => {
        upstreamCalls += 1;
        return { ok: true, status: 200, json: async () => ({ choices: [] }) };
      },
      effortInjector: makeOffEffortInjector(),
      recordGeneration: (value) => {
        generation = value;
      },
      readGeneration: () => generation,
    });
    const result = await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: TOKEN },
      { model: "claude-opus-5", messages: [] },
    );
    assert.equal(result.status, 200);
    assert.equal(upstreamCalls, 1);
  });
});

describe("openai handler chain noteSuccess model 兜底", () => {
  // zcode 链：channel poke-api -> pool pool-x（仅 deepseek 携带 deepseek-v4）
  function makeChainHandler() {
    const store = {
      ...makeStore(),
      pools: { "pool-x": { displayName: "Pool X", members: ["poke-api", "deepseek"] } },
      routingChains: {
        zcode: { chain: [ { node: "poke-api", model: "claude-opus-5" }, { node: "pool-x", model: "deepseek-v4" } ] },
      },
    };
    return makeHandler({ store });
  }

  async function planFor(handler) {
    const plan = await handler.planChainChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: TOKEN },
      { model: "auto", messages: [] },
      "zcode",
    );
    assert.equal(plan.ok, true);
    return plan;
  }

  it("正常路径：meta 命中时按 memberMeta 的 node+model 落链状态", async () => {
    const handler = makeChainHandler();
    const plan = await planFor(handler);
    plan.noteSuccess("poke-api");
    const entry = handler.chainState.get("zcode");
    assert.equal(entry.nodeId, "poke-api");
    assert.equal(entry.model, "claude-opus-5");
  });

  it("meta 缺失（memberId 不来自本次 plan）时回退链配置里该节点绑定的 model", async () => {
    const handler = makeChainHandler();
    // 两次独立请求（各自有自己的 per-request 去重集）让前排节点连续失败
    // 两次，锁定降级（失败才降级）。
    (await planFor(handler)).noteFailure("poke-api");
    const plan = await planFor(handler);
    plan.noteFailure("poke-api");
    // "pool-x" 不在 memberMeta（池成员以 pool-x/<member> 入库），但链里有该节点。
    plan.noteSuccess("pool-x");
    const entry = handler.chainState.get("zcode");
    assert.equal(entry.nodeId, "pool-x");
    assert.equal(entry.model, "deepseek-v4");
  });

  it("meta 与链配置都拿不到 model 时跳过 noteChainSuccess，不写入 undefined model", async () => {
    const handler = makeChainHandler();
    const plan = await planFor(handler);
    plan.noteSuccess("ghost-member");
    assert.equal(handler.chainState.get("zcode"), undefined);
  });
});

describe("openai handler thinking-depth injection", () => {
  const catalog = {
    models: new Map([
      ["claude-opus-5", { kind: "reasoning", levels: ["high", "xhigh", "max"], default: "high", wire: {}, thinkingFormat: null }],
    ]),
  };

  function makeInjectingHandler({ responses, isEnabled = () => true } = {}) {
    const sent = [];
    let index = 0;
    let generation = null;
    const handler = createOpenAIHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store: makeStore() }),
      loadCredential: () => ({ ok: true, value: "sk-test" }),
      upstreamFetch: async (urls, init) => {
        sent.push(JSON.parse(init.body));
        // 槽位可以是 Response 实例或工厂：工厂每次调用都交出全新实例。handler
        // 会把 2xx 响应的 body 读掉（upstream.json()），多轮请求若复用同一个
        // 实例，第二次就会伪造成 502 malformed response。
        const next = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return typeof next === "function" ? next() : next;
      },
      recordGeneration: (value) => { generation = value; },
      readGeneration: () => generation,
      effortInjector: createEffortInjector({ catalog, isEnabled }),
    });
    return { handler, sent };
  }

  const ask = (handler, extra = {}) => handler.handleChatCompletions(
    "/openai/poke-api/v1/chat/completions",
    { authorization: `Bearer ${TOKEN}` },
    { model: "claude-opus-5", messages: [], ...extra },
  );

  it("adds the library default when the client named no level", async () => {
    const { handler, sent } = makeInjectingHandler({ responses: [success()] });
    await ask(handler);
    assert.equal(sent[0].reasoning_effort, "high");
  });

  it("leaves a level the client chose exactly as sent", async () => {
    const { handler, sent } = makeInjectingHandler({ responses: [success()] });
    await ask(handler, { reasoning_effort: "max" });
    assert.equal(sent[0].reasoning_effort, "max");
  });

  it("retries once without the field when the channel refuses it, then stops injecting there", async () => {
    const refusal = new Response('{"error":{"message":"Unsupported parameter: \'reasoning_effort\'"}}', {
      status: 400,
      headers: { "content-type": "application/json" },
    });
    // 第二个槽位给工厂而非实例：停注入后的后续请求拿到的必须是全新的成功响应，
    // 否则复用已被读空的实例会把这一步伪造成 502，返回侧就没法断言了。
    const { handler, sent } = makeInjectingHandler({ responses: [refusal, success] });

    const first = await ask(handler);
    assert.equal(first.status, 200, "the client sees the retry's result");
    assert.equal(sent.length, 2);
    assert.equal(sent[0].reasoning_effort, "high");
    assert.equal("reasoning_effort" in sent[1], false);

    const second = await ask(handler);
    assert.equal(second.status, 200, "later requests really succeed, not just leave the field out");
    assert.equal(sent.length, 3, "later requests go out clean, no refusal cycle again");
    assert.equal("reasoning_effort" in sent[2], false);
  });

  it("keeps an unrelated upstream failure a single attempt", async () => {
    const quota = new Response('{"error":{"message":"quota exceeded"}}', { status: 400 });
    const { handler, sent } = makeInjectingHandler({ responses: [quota] });
    const result = await ask(handler);
    assert.equal(result.status, 400);
    assert.equal(sent.length, 1);
  });

  it("sends nothing while the switch is off", async () => {
    const { handler, sent } = makeInjectingHandler({ responses: [success()], isEnabled: () => false });
    await ask(handler);
    assert.equal("reasoning_effort" in sent[0], false);
  });
});

describe("outbound history tool-call sanitization", () => {
  function makeCaptureHandler() {
    let sentBody = null;
    const handler = createOpenAIHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store: makeStore() }),
      loadCredential: () => ({ ok: true, value: "sk-test" }),
      upstreamFetch: async (_url, init) => {
        sentBody = JSON.parse(init.body);
        return success();
      },
      effortInjector: makeOffEffortInjector(),
      recordGeneration: () => {},
      readGeneration: () => null,
    });
    return { handler, sent: () => sentBody };
  }

  const ask = (handler, messages) => handler.handleChatCompletions(
    "/openai/poke-api/v1/chat/completions",
    { authorization: TOKEN },
    { model: "claude-opus-5", messages },
  );

  it("drops assistant tool_calls whose id or name is empty, plus the tool results they can never answer", async () => {
    const { handler, sent } = makeCaptureHandler();
    const result = await ask(handler, [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "", type: "function", function: { name: "", arguments: "{}" } },
          { id: "call_2", type: "function", function: { name: "", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "", content: "x" },
    ]);
    assert.equal(result.status, 200);
    assert.deepEqual(sent().messages, [
      { role: "user", content: "hi" },
    ]);
  });

  it("keeps a healthy tool-call round trip exactly as the client sent it", async () => {
    const { handler, sent } = makeCaptureHandler();
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "done" },
    ];
    const result = await ask(handler, messages);
    assert.equal(result.status, 200);
    assert.deepEqual(sent().messages, messages);
  });

  it("keeps the good call and its result while dropping a bad sibling call and its orphan result", async () => {
    const { handler, sent } = makeCaptureHandler();
    const result = await ask(handler, [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } },
          { id: "", type: "function", function: { name: "", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "done" },
      { role: "tool", tool_call_id: "", content: "orphan" },
    ]);
    assert.equal(result.status, 200);
    assert.deepEqual(sent().messages, [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "done" },
    ]);
  });

  it("keeps an assistant message whose content survives even when its tool calls were unusable", async () => {
    const { handler, sent } = makeCaptureHandler();
    const result = await ask(handler, [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "partial answer without tool",
        tool_calls: [
          { id: "", type: "function", function: { name: "", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "", content: "orphan" },
    ]);
    assert.equal(result.status, 200);
    assert.deepEqual(sent().messages, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "partial answer without tool", tool_calls: [] },
    ]);
  });
});

// ---------- 图片降级（M13：纯文本模型预判 + 报错兜底，openai 直传/汇合路径） ----------

const IMAGE_URL_PART = { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } };
const EMPTY_EFFORT_CATALOG = { models: new Map() };

function imageChatBody(model, { imageOnly = false } = {}) {
  const content = imageOnly
    ? [IMAGE_URL_PART]
    : [{ type: "text", text: "look at this" }, IMAGE_URL_PART];
  return { model, messages: [{ role: "user", content }] };
}

function imageGuardStore() {
  const store = makeStore();
  store.providers["poke-api"].models = {
    "claude-opus-5": { displayName: "Claude Opus 5" },
    "glm-5.3": { displayName: "GLM 5.3" },
    "declared-text": { displayName: "Declared Text", inputModalities: ["text"] },
    // id 必须在内置纯文本名单里（CONFIRMED_TEXT_ONLY_MODELS），声明推翻名单
    // 的冲突场景才搭得出来；「声明 image + 名单命中」用这一行。
    "minimax-m2.7": { displayName: "Declared Vision", inputModalities: ["text", "image"] },
    "mystery-model": { displayName: "Mystery" },
  };
  return store;
}

function refusal(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TEXT_ONLY_REFUSAL = () =>
  refusal(400, "Model only support text input Request id: 021783");

describe("openai handler 图片降级", () => {
  function makeImageGuardHandler(responses, { gates = {}, store = imageGuardStore() } = {}) {
    const sent = [];
    const lines = [];
    let index = 0;
    let generation = null;
    const handler = createOpenAIHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store }),
      loadCredential: () => ({ ok: true, value: "sk-test" }),
      upstreamFetch: async (_urls, init) => {
        sent.push(JSON.parse(init.body));
        // 同 makeInjectingHandler：槽位可以是实例或工厂，工厂每次给出全新实例。
        const next = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return typeof next === "function" ? next() : next;
      },
      recordGeneration: (value) => { generation = value; },
      readGeneration: () => generation,
      logger: { info: (line) => lines.push(line) },
      effortInjector: createEffortInjector({ catalog: EMPTY_EFFORT_CATALOG }),
      ...gates,
    });
    return { handler, sent, lines };
  }

  const ask = (handler, body) => handler.handleChatCompletions(
    "/openai/poke-api/v1/chat/completions",
    { authorization: `Bearer ${TOKEN}` },
    body,
  );

  it("预判：store 声明纯文本时 send 前剥图（不受预判子开关控制）", async () => {
    const { handler, sent, lines } = makeImageGuardHandler([success()], {
      gates: { imageHeuristicGate: () => false },
    });
    const result = await ask(handler, imageChatBody("declared-text"));
    assert.equal(result.status, 200);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].messages[0].content, [
      { type: "text", text: "look at this" },
      { type: "text", text: "[Unsupported Image]" },
    ]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /图片降级（预判）/);
    assert.match(lines[0], /"declared-text"/);
    assert.match(lines[0], /1 张图片/);
  });

  it("预判：内置名单命中，单图 content 折叠为字符串形态", async () => {
    const { handler, sent } = makeImageGuardHandler([success()], {
      gates: { imageHeuristicGate: () => true },
    });
    const result = await ask(handler, imageChatBody("glm-5.3", { imageOnly: true }));
    assert.equal(result.status, 200);
    assert.equal(sent[0].messages[0].content, "[Unsupported Image]");
    assert.equal(sent[0].model, "glm-5.3");
  });

  it("预判：子开关关着时名单不预判，图原样上行", async () => {
    const { handler, sent, lines } = makeImageGuardHandler([success()], {
      gates: { imageHeuristicGate: () => false },
    });
    const result = await ask(handler, imageChatBody("glm-5.3"));
    assert.equal(result.status, 200);
    assert.deepEqual(sent[0].messages[0].content[1], IMAGE_URL_PART);
    assert.equal(lines.length, 0);
  });

  it("预判：声明支持图片时，名单命中也被声明推翻", async () => {
    // 对照臂：同一 id 没有模态声明时确实被名单剥图——证明这个 id 真的命中
    // 名单，冲突场景真实成立，而不是「名单本来就没命中」的恒真断言。
    const plainStore = imageGuardStore();
    plainStore.providers["poke-api"].models["minimax-m2.7"] = { displayName: "Minimax M2.7" };
    const plain = makeImageGuardHandler([success()], {
      gates: { imageHeuristicGate: () => true },
      store: plainStore,
    });
    const plainResult = await ask(plain.handler, imageChatBody("minimax-m2.7"));
    assert.equal(plainResult.status, 200);
    assert.deepEqual(plain.sent[0].messages[0].content, [
      { type: "text", text: "look at this" },
      { type: "text", text: "[Unsupported Image]" },
    ]);

    // 主张臂：同一 id 换成声明 inputModalities 含 image 的行，声明胜出、图原样上行。
    const declared = makeImageGuardHandler([success()], {
      gates: { imageHeuristicGate: () => true },
    });
    const result = await ask(declared.handler, imageChatBody("minimax-m2.7"));
    assert.equal(result.status, 200);
    assert.deepEqual(declared.sent[0].messages[0].content[1], IMAGE_URL_PART);
  });

  it("兜底：漏判后上游报「只支持文本」，剥图重试一次并成功", async () => {
    const { handler, sent, lines } = makeImageGuardHandler([TEXT_ONLY_REFUSAL(), success()], {
      gates: { imageHeuristicGate: () => false, imageFallbackGate: () => true },
    });
    const result = await ask(handler, imageChatBody("mystery-model"));
    assert.equal(result.status, 200, "客户端看到的是重试结果");
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].messages[0].content[1], IMAGE_URL_PART);
    assert.deepEqual(sent[1].messages[0].content, [
      { type: "text", text: "look at this" },
      { type: "text", text: "[Unsupported Image]" },
    ]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /图片降级（兜底）/);
    assert.match(lines[0], /"mystery-model"/);
  });

  it("兜底：总开关关着时不重试，错误原样透传", async () => {
    const { handler, sent, lines } = makeImageGuardHandler([TEXT_ONLY_REFUSAL()], {
      gates: { imageHeuristicGate: () => false, imageFallbackGate: () => false },
    });
    const result = await ask(handler, imageChatBody("mystery-model"));
    assert.equal(result.status, 400);
    assert.equal(sent.length, 1);
    assert.equal(lines.length, 0);
  });

  it("兜底：措辞不是模态判决时不重试（单次发送）", async () => {
    // 预判门也钉死：请求带图时 send 前的预判判定会调预判门，不注入就会落到
    // 生产默认、现场读真实用户的 settings.json。
    const { handler, sent, lines } = makeImageGuardHandler([refusal(400, "Invalid API key")], {
      gates: { imageHeuristicGate: () => false, imageFallbackGate: () => true },
    });
    const result = await ask(handler, imageChatBody("mystery-model"));
    assert.equal(result.status, 400);
    assert.equal(sent.length, 1);
    assert.equal(lines.length, 0);
  });

  it("兜底：重试仍失败时按重试结果透传，不再三发", async () => {
    const { handler, sent } = makeImageGuardHandler([TEXT_ONLY_REFUSAL(), TEXT_ONLY_REFUSAL()], {
      gates: { imageHeuristicGate: () => false, imageFallbackGate: () => true },
    });
    const result = await ask(handler, imageChatBody("mystery-model"));
    assert.equal(result.status, 400);
    assert.equal(sent.length, 2, "图片兜底只重试一次");
  });

  it("兜底：请求不带图时模态报错不触发重试", async () => {
    const { handler, sent } = makeImageGuardHandler([TEXT_ONLY_REFUSAL()], {
      gates: { imageFallbackGate: () => true },
    });
    const result = await ask(handler, { model: "mystery-model", messages: [{ role: "user", content: "hi" }] });
    assert.equal(result.status, 400);
    assert.equal(sent.length, 1);
  });

  it("组合：effort 拒绝重试在前，图片兜底的基体不带刚被拒的 effort 字段", async () => {
    const catalog = {
      models: new Map([
        ["mystery-model", { kind: "reasoning", levels: ["high", "max"], default: "high", wire: {}, thinkingFormat: null }],
      ]),
    };
    const sent = [];
    let index = 0;
    let generation = null;
    const handler = createOpenAIHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store: imageGuardStore() }),
      loadCredential: () => ({ ok: true, value: "sk-test" }),
      upstreamFetch: async (_urls, init) => {
        sent.push(JSON.parse(init.body));
        const responses = [
          refusal(400, "Unsupported parameter: 'reasoning_effort'"),
          TEXT_ONLY_REFUSAL(),
          success(),
        ];
        const next = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return next;
      },
      recordGeneration: (value) => { generation = value; },
      readGeneration: () => generation,
      effortInjector: createEffortInjector({ catalog }),
      imageHeuristicGate: () => false,
      imageFallbackGate: () => true,
    });
    const result = await handler.handleChatCompletions(
      "/openai/poke-api/v1/chat/completions",
      { authorization: `Bearer ${TOKEN}` },
      imageChatBody("mystery-model"),
    );
    assert.equal(result.status, 200);
    assert.equal(sent.length, 3);
    assert.equal(sent[0].reasoning_effort, "high");
    assert.equal(sent[0].messages[0].content[1].type, "image_url");
    // effort 重试：去字段、图仍在。
    assert.equal("reasoning_effort" in sent[1], false);
    assert.equal(sent[1].messages[0].content[1].type, "image_url");
    // 图片兜底：基体是去 effort 的请求——不再把被拒的字段放回线上。
    assert.equal("reasoning_effort" in sent[2], false);
    assert.deepEqual(sent[2].messages[0].content, [
      { type: "text", text: "look at this" },
      { type: "text", text: "[Unsupported Image]" },
    ]);
  });
});
