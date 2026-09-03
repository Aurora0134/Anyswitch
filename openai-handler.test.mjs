import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIHandler } from "./openai-handler.mjs";
import { createRetryingFetch } from "./launch.mjs";

const TOKEN = "test-token-123";

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
    assert.match(result.body.error.message, /not in the ApiCred store/);
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

  it("uses a primary-first URL list for the retry boundary", async () => {
    const store = makeStore();
    store.providers["poke-api"].baseURL = "https://primary.example/v1/";
    store.providers["poke-api"].fallbackURLs = ["https://backup.example/v1"];
    let receivedURLs = null;
    const handler = createOpenAIHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store }),
      loadCredential: () => ({ ok: true, value: "sk" }),
      buildUpstreamURLs: (provider, path) => [provider.baseURL, ...provider.fallbackURLs]
        .map((baseURL) => `${baseURL.replace(/\/+$/, "")}${path}`),
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
    let generation = "stale-hash";
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
