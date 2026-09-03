import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRelayServer, listenLoopback } from "./openai-server.mjs";
import { createAliasResolver } from "./antigravity-alias.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";

const TOKEN = "test-token-gemini-chain";

// Chain routing for the virtual model "auto": the agy endpoint's chain mixes
// channel nodes (chan-a / chan-b, one upstream call each, bound model sent
// upstream) and a pool node (test-pool, member-level failover inside the
// node). The slug "auto" has no alias — chain routing intercepts before the
// alias resolver.
const PROVIDERS = {
  "chan-a": {
    displayName: "Channel A",
    baseURL: "http://chan-a.invalid/v1",
    protocol: "openai-compatible",
    credentialFile: "chan-a.dpapi",
    models: { "model-a": { displayName: "Model A" } },
  },
  "chan-b": {
    displayName: "Channel B",
    baseURL: "http://chan-b.invalid/v1",
    protocol: "openai-compatible",
    credentialFile: "chan-b.dpapi",
    models: { "model-b": { displayName: "Model B" } },
  },
  "member-a": {
    displayName: "Member A",
    baseURL: "http://member-a.invalid/v1",
    protocol: "openai-compatible",
    credentialFile: "member-a.dpapi",
    models: { "pool-model": { displayName: "Pool Model from A" } },
  },
  "member-b": {
    displayName: "Member B",
    baseURL: "http://member-b.invalid/v1",
    protocol: "openai-compatible",
    credentialFile: "member-b.dpapi",
    models: { "pool-model": { displayName: "Pool Model from B" } },
  },
};

const POOLS = {
  "test-pool": { displayName: "Test Pool", members: ["member-a", "member-b"] },
};

function storeWithChain(chain) {
  return {
    version: 2,
    providers: PROVIDERS,
    pools: POOLS,
    routingChains: chain ? { agy: { chain } } : undefined,
  };
}

const aliasResolver = createAliasResolver({
  filePath: "mock-nonexistent-gemini-chain.json",
  overlay: { "gemini-3.7-flash": "chan-a/model-a" },
});

// Routes upstream calls by baseURL host: behaviors maps node/member id ->
// () => handler-shaped result. `calls` records the id order, `models` the
// concrete model each upstream request carried (the node's bound model).
function upstreamRouter(behaviors) {
  const calls = [];
  const models = [];
  const upstreamFetch = async (urls, init) => {
    const url = Array.isArray(urls) ? urls[0] : urls;
    const id = new URL(url).host.split(".")[0];
    calls.push(id);
    models.push(JSON.parse(init.body).model);
    const behavior = behaviors[id];
    if (!behavior) throw new Error(`unexpected upstream call to "${id}"`);
    return behavior();
  };
  return { upstreamFetch, calls, models };
}

function createMockDeps({ store, upstreamFetch, getKeepAliveConfig }) {
  return {
    token: TOKEN,
    loadStore: () => ({ ok: true, store }),
    loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
    upstreamFetch,
    aliasResolver,
    getKeepAliveConfig,
  };
}

async function withServer(deps, fn) {
  const server = createOpenAIRelayServer(deps);
  const { port, close } = await listenLoopback(server, 0);
  try {
    return await fn(port);
  } finally {
    await close();
  }
}

function postGenerate(port, { slug = "auto", stream = true } = {}) {
  const method = stream ? "streamGenerateContent" : "generateContent";
  return fetch(`http://127.0.0.1:${port}/v1beta/models/${slug}:${method}`, {
    method: "POST",
    headers: { "x-goog-api-key": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    }),
  });
}

function sseStream(chunks) {
  return (async function* () {
    const enc = new TextEncoder();
    for (const c of chunks) yield enc.encode(c);
  })();
}

function healthyStream(text) {
  return {
    ok: true,
    status: 200,
    body: sseStream([
      `data: {"id":"1","choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n`,
      "data: [DONE]\n\n",
    ]),
  };
}

function statusError(status) {
  return { ok: false, status, body: { error: { message: `upstream ${status}` } } };
}

function jsonResponse(text) {
  return async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) });
}

const NO_RETRY = () => ({ enabled: true, maxRetries: 0, backoffMs: 10 });

const CHAIN_AB = [
  { node: "chan-a", model: "model-a" },
  { node: "chan-b", model: "model-b" },
];

describe("gemini chain routing: interception", () => {
  it("(no chain) the auto slug falls through to the alias path and 404s", async () => {
    const { upstreamFetch, calls } = upstreamRouter({});
    const deps = createMockDeps({ store: storeWithChain(null), upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postGenerate(port);
      assert.equal(res.status, 404, "no chain for agy: auto has no alias, classic path 404s");
      assert.deepEqual(calls, []);
    });
  });

  it("(no chain) a non-auto slug still takes the alias path when a chain exists", async () => {
    const { upstreamFetch, calls, models } = upstreamRouter({
      "chan-a": jsonResponse("alias path"),
    });
    const deps = createMockDeps({ store: storeWithChain(CHAIN_AB), upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postGenerate(port, { slug: "gemini-3.7-flash", stream: false });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.candidates[0].content.parts[0].text, "alias path");
      assert.deepEqual(calls, ["chan-a"]);
      assert.deepEqual(models, ["model-a"]);
    });
  });
});

describe("gemini chain routing: streaming", () => {
  it("(happy) the chain head answers and the upstream receives the bound model", async () => {
    const { upstreamFetch, calls, models } = upstreamRouter({
      "chan-a": () => healthyStream("hello from A"),
    });
    const deps = createMockDeps({ store: storeWithChain(CHAIN_AB), upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postGenerate(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("hello from A"));
      assert.deepEqual(calls, ["chan-a"]);
      assert.deepEqual(models, ["model-a"], "the node's bound model is sent upstream, not auto");
    });
  });

  it("(failover) a dead chain head backs off to the next node", async () => {
    const { upstreamFetch, calls, models } = upstreamRouter({
      "chan-a": () => statusError(503),
      "chan-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({ store: storeWithChain(CHAIN_AB), upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postGenerate(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on B"));
      assert.deepEqual(calls, ["chan-a", "chan-b"]);
      assert.deepEqual(models, ["model-a", "model-b"]);
    });
  });

  it("(404) an upstream 404 on the bound model backs off to the next node", async () => {
    const { upstreamFetch, calls, models } = upstreamRouter({
      "chan-a": () => statusError(404),
      "chan-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({ store: storeWithChain(CHAIN_AB), upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postGenerate(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on B"));
      assert.deepEqual(calls, ["chan-a", "chan-b"],
        "chain semantics: a 404 means the node cannot serve its bound model, so the chain backs off");
      assert.deepEqual(models, ["model-a", "model-b"]);
    });
  });

  it("(400) an upstream 400 is a node-level failure: the chain backs off to the next node", async () => {
    // auto 的模型是链自己绑的，客户端不选模型——上游 400（模型改名/失权/
    // 契约漂移）只能归因于节点，不能当请求错误透传。
    const { upstreamFetch, calls, models } = upstreamRouter({
      "chan-a": () => statusError(400),
      "chan-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({ store: storeWithChain(CHAIN_AB), upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postGenerate(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on B"));
      assert.deepEqual(calls, ["chan-a", "chan-b"],
        "chain semantics: any upstream 4xx means this node rejected the request, so the chain backs off");
      assert.deepEqual(models, ["model-a", "model-b"]);
    });
  });

  it("(pool node) member failover stays inside the node and the survivor goes sticky", async () => {
    const chain = [
      { node: "test-pool", model: "pool-model" },
      { node: "chan-b", model: "model-b" },
    ];
    const { upstreamFetch, calls, models } = upstreamRouter({
      "member-a": () => statusError(503),
      "member-b": () => healthyStream("pool member B"),
    });
    const deps = createMockDeps({ store: storeWithChain(chain), upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      // 成员连续两次请求级失败才锁定降级（失败才降级，黄灯不降）：两个
      // 请求都走 [member-a(503) → member-b(ok)]，第二次失败后才粘住 member-b。
      for (let round = 0; round < 2; round += 1) {
        const res = await postGenerate(port);
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.ok(text.includes("pool member B"));
        assert.deepEqual(calls, ["member-a", "member-b"], `round ${round + 1}: member-level failover inside the pool node`);
        assert.deepEqual(models, ["pool-model", "pool-model"]);
        calls.length = 0;
        models.length = 0;
      }

      const second = await postGenerate(port);
      assert.equal(second.status, 200);
      assert.deepEqual(calls, ["member-b"], "pool sticky: the surviving member leads inside the node");
    });
  });

  it("(pool exhausted) when every pool member fails the chain backs off to the next node", async () => {
    const chain = [
      { node: "test-pool", model: "pool-model" },
      { node: "chan-b", model: "model-b" },
    ];
    const { upstreamFetch, calls, models } = upstreamRouter({
      "member-a": () => statusError(503),
      "member-b": () => statusError(429),
      "chan-b": () => healthyStream("chain tail"),
    });
    const deps = createMockDeps({ store: storeWithChain(chain), upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postGenerate(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("chain tail"));
      assert.deepEqual(calls, ["member-a", "member-b", "chan-b"]);
      assert.deepEqual(models, ["pool-model", "pool-model", "model-b"]);
    });
  });

  it("(sticky) the node that answered leads the next request", async () => {
    let chanAFails = true;
    const { upstreamFetch, calls } = upstreamRouter({
      "chan-a": () => (chanAFails ? statusError(503) : healthyStream("A again")),
      "chan-b": () => healthyStream("B steady"),
    });
    const deps = createMockDeps({ store: storeWithChain(CHAIN_AB), upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      // Two consecutive request-level failures at the head latch the demotion
      // (失败才降级: one blip alone must not demote).
      for (let round = 0; round < 2; round += 1) {
        const res = await postGenerate(port);
        assert.equal(res.status, 200);
        await res.text();
        assert.deepEqual(calls, ["chan-a", "chan-b"], `round ${round + 1} fails over to chan-b`);
        calls.length = 0;
      }

      chanAFails = false; // head is healthy again; chain sticky must still prefer chan-b
      const second = await postGenerate(port);
      assert.equal(second.status, 200);
      const text = await second.text();
      assert.ok(text.includes("B steady"));
      assert.deepEqual(calls, ["chan-b"], "chain sticky: the answering node leads the next request");
    });
  });
});

describe("gemini chain routing: non-streaming", () => {
  it("(happy) the chain head answers a generateContent request", async () => {
    const { upstreamFetch, calls, models } = upstreamRouter({
      "chan-a": jsonResponse("non-stream A"),
    });
    const deps = createMockDeps({ store: storeWithChain(CHAIN_AB), upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postGenerate(port, { stream: false });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.candidates[0].content.parts[0].text, "non-stream A");
      assert.deepEqual(calls, ["chan-a"]);
      assert.deepEqual(models, ["model-a"]);
    });
  });

  it("(failover) a non-stream request walks the chain and sticks the survivor", async () => {
    let chanAFails = true;
    const { upstreamFetch, calls } = upstreamRouter({
      "chan-a": () => (chanAFails ? statusError(503) : jsonResponse("A again")()),
      "chan-b": jsonResponse("non-stream B"),
    });
    const deps = createMockDeps({ store: storeWithChain(CHAIN_AB), upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      // Two consecutive request-level failures latch the demotion (失败才降级).
      for (let round = 0; round < 2; round += 1) {
        const res = await postGenerate(port, { stream: false });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.candidates[0].content.parts[0].text, "non-stream B");
        assert.deepEqual(calls, ["chan-a", "chan-b"]);
        calls.length = 0;
      }

      chanAFails = false;
      const second = await postGenerate(port, { stream: false });
      assert.equal(second.status, 200);
      assert.deepEqual(calls, ["chan-b"], "sticky holds on the non-stream path too");
    });
  });

  it("(404, non-stream) an upstream 404 walks the non-stream chain loop too", async () => {
    const { upstreamFetch, calls } = upstreamRouter({
      "chan-a": () => statusError(404),
      "chan-b": jsonResponse("non-stream B"),
    });
    const deps = createMockDeps({ store: storeWithChain(CHAIN_AB), upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postGenerate(port, { stream: false });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.candidates[0].content.parts[0].text, "non-stream B");
      assert.deepEqual(calls, ["chan-a", "chan-b"],
        "the hand-written non-stream loop uses the chain predicate too");
    });
  });

  it("(400, non-stream) an upstream 400 walks the non-stream chain loop too", async () => {
    const { upstreamFetch, calls } = upstreamRouter({
      "chan-a": () => statusError(400),
      "chan-b": jsonResponse("non-stream B"),
    });
    const deps = createMockDeps({ store: storeWithChain(CHAIN_AB), upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postGenerate(port, { stream: false });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.candidates[0].content.parts[0].text, "non-stream B");
      assert.deepEqual(calls, ["chan-a", "chan-b"],
        "the hand-written non-stream loop uses the chain predicate too");
    });
  });
});

describe("gemini chain routing: pool plan regression", () => {
  it("(pool 404) a pool plan still passes an upstream 404 straight through", async () => {
    const poolAliasResolver = createAliasResolver({
      filePath: "mock-nonexistent-gemini-chain-pool.json",
      overlay: { "gemini-pool": "test-pool/pool-model" },
    });
    const { upstreamFetch, calls } = upstreamRouter({
      "member-a": () => statusError(404),
      "member-b": () => healthyStream("must never be sent"),
    });
    const deps = {
      ...createMockDeps({ store: storeWithChain(null), upstreamFetch, getKeepAliveConfig: NO_RETRY }),
      aliasResolver: poolAliasResolver,
    };

    await withServer(deps, async (port) => {
      const res = await postGenerate(port, { slug: "gemini-pool", stream: true });
      assert.equal(res.status, 404, "pool semantics unchanged: 404 is request-shaped and never fails over");
      assert.deepEqual(calls, ["member-a"], "the second pool member must not be tried");
    });
  });

  it("(pool 400) a pool plan still passes an upstream 400 straight through", async () => {
    const poolAliasResolver = createAliasResolver({
      filePath: "mock-nonexistent-gemini-chain-pool.json",
      overlay: { "gemini-pool": "test-pool/pool-model" },
    });
    const { upstreamFetch, calls } = upstreamRouter({
      "member-a": () => statusError(400),
      "member-b": () => healthyStream("must never be sent"),
    });
    const deps = {
      ...createMockDeps({ store: storeWithChain(null), upstreamFetch, getKeepAliveConfig: NO_RETRY }),
      aliasResolver: poolAliasResolver,
    };

    await withServer(deps, async (port) => {
      const res = await postGenerate(port, { slug: "gemini-pool", stream: true });
      assert.equal(res.status, 400, "pool semantics unchanged: 400 is request-shaped and never fails over");
      assert.deepEqual(calls, ["member-a"], "the second pool member must not be tried");
    });
  });
});

describe("gemini auto 路由统计口径（auto 不作独立端点统计）", () => {
  // auto slug 没有 alias，tracker 的 providerId 为 null：修复前 journal 行
  // 落到 stale lastProvider 兜底。修复后必须归到实际应答节点 + 绑定模型。
  function journalDeps(store, upstreamFetch) {
    const lines = [];
    const journal = { lines, appendRequest: (entry) => lines.push(entry) };
    const collector = createAgentMetricsCollector({ loadSparkSettings: false, journal });
    return {
      deps: { ...createMockDeps({ store, upstreamFetch, getKeepAliveConfig: NO_RETRY }), metricsCollector: collector },
      lines,
    };
  }

  it("(non-stream) journal 归到实际应答节点，不再落 stale provider 兜底", async () => {
    const { upstreamFetch, calls } = upstreamRouter({
      "chan-a": () => statusError(503),
      "chan-b": jsonResponse("non-stream B"),
    });
    const { deps, lines } = journalDeps(storeWithChain(CHAIN_AB), upstreamFetch);

    await withServer(deps, async (port) => {
      const res = await postGenerate(port, { stream: false });
      assert.equal(res.status, 200);
      await res.json();
      assert.deepEqual(calls, ["chan-a", "chan-b"]);
    });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].providerId, "chan-b");
    assert.equal(lines[0].model, "model-b");
    assert.equal(lines[0].agentId, "agy");
  });

  it("(stream) 流式 auto 应答同样归到节点 + 绑定模型", async () => {
    const { upstreamFetch, calls } = upstreamRouter({
      "chan-a": () => healthyStream("hello from A"),
    });
    const { deps, lines } = journalDeps(storeWithChain(CHAIN_AB), upstreamFetch);

    await withServer(deps, async (port) => {
      const res = await postGenerate(port);
      assert.equal(res.status, 200);
      await res.text();
      assert.deepEqual(calls, ["chan-a"]);
    });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].providerId, "chan-a");
    assert.equal(lines[0].model, "model-a");
  });
});
