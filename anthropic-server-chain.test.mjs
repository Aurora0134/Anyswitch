// Anthropic-path chain routing tests (自动路由, wave 2): the virtual model
// "auto" walks store.routingChains[endpointId].chain in chainState.plan
// order. Channel nodes are single upstream calls with the node's bound model;
// pool nodes expand to their sticky-ordered member callables and only count
// as failed when the whole pool is exhausted. Per-launch relay
// (createRelayServer, agentId "claude") over real loopback sockets, plus
// handler-level tests for the intercept/catalog contract. Synthetic store,
// mock upstream. No real credentials, no real network egress, no DPAPI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "./handler.mjs";
import { createRelayServer, listenLoopback } from "./server.mjs";
import { createSessionReporter } from "./agent-metrics.mjs";

const TOKEN = "test-token-anthropic-chain";

// Chain under test: chan-a (channel) -> test-pool (member-a, member-b) ->
// chan-b (channel). member-c carries no chain-bound model and only exists to
// prove pool model filtering.
const STORE = {
  version: 2,
  providers: {
    "chan-a": {
      displayName: "Channel A",
      baseURL: "http://chan-a.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "chan-a.dpapi",
      models: { "claude-a": { displayName: "Claude A" } },
    },
    "chan-b": {
      displayName: "Channel B",
      baseURL: "http://chan-b.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "chan-b.dpapi",
      models: { "claude-b": { displayName: "Claude B" } },
    },
    "member-a": {
      displayName: "Member A",
      baseURL: "http://member-a.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "member-a.dpapi",
      models: { "claude-pool": { displayName: "Claude Pool from A" } },
    },
    "member-b": {
      displayName: "Member B",
      baseURL: "http://member-b.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "member-b.dpapi",
      models: { "claude-pool": { displayName: "Claude Pool from B" } },
    },
    "member-c": {
      displayName: "Member C",
      baseURL: "http://member-c.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "member-c.dpapi",
      models: { "claude-c-only": { displayName: "C only" } },
    },
  },
  pools: {
    "test-pool": { displayName: "Test Pool", members: ["member-a", "member-b"] },
  },
  routingChains: {
    claude: {
      chain: [
        { node: "chan-a", model: "claude-a" },
        { node: "test-pool", model: "claude-pool" },
        { node: "chan-b", model: "claude-b" },
      ],
    },
  },
};

// STORE without the routingChains key, for the no-chain fallthrough test.
const STORE_NO_CHAIN = {
  version: STORE.version,
  providers: STORE.providers,
  pools: STORE.pools,
};

// Two-hop chain (chan-a -> chan-b) for 400-failover tests that want a chain
// without a pool node between the channels.
const STORE_AB = {
  ...STORE,
  routingChains: {
    claude: {
      chain: [
        { node: "chan-a", model: "claude-a" },
        { node: "chan-b", model: "claude-b" },
      ],
    },
  },
};

// Routes upstream calls by baseURL host: behaviors maps the host's first
// segment (chan-a / member-a / ...) to () => handler-shaped result (or
// throws). `calls` records the member order; `bodies` records the parsed
// upstream request body per call so tests can assert the bound model.
function memberRouter(behaviors) {
  const calls = [];
  const bodies = [];
  const upstreamFetch = async (urls, init) => {
    const url = Array.isArray(urls) ? urls[0] : urls;
    const memberId = new URL(url).host.split(".")[0];
    calls.push(memberId);
    bodies.push(JSON.parse(init.body));
    const behavior = behaviors[memberId];
    if (!behavior) throw new Error(`unexpected upstream call to member "${memberId}"`);
    return behavior();
  };
  return { upstreamFetch, calls, bodies };
}

function createMockDeps({ upstreamFetch, store = STORE, getKeepAliveConfig } = {}) {
  return {
    token: TOKEN,
    loadStore: () => ({ ok: true, store }),
    loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
    upstreamFetch,
    recordGeneration: () => {},
    readGeneration: () => null,
    getKeepAliveConfig,
  };
}

async function withPerLaunch(deps, fn) {
  const server = createRelayServer(deps);
  const { port, close } = await listenLoopback(server);
  try {
    return await fn(port);
  } finally {
    await close();
  }
}

function postMessages(port, { model = "auto", stream = false } = {}) {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

function getModels(port) {
  return fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: { authorization: TOKEN },
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
      `data: {"id":"1","choices":[{"delta":{"content":${JSON.stringify(text)}},"index":0}]}\n\n`,
      'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":2,"completion_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ]),
  };
}

function statusError(status) {
  return { ok: false, status, body: { error: { message: `upstream ${status}` } } };
}

function nonStreamJson(text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: "cmpl-1",
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    }),
  };
}

const NO_RETRY = () => ({ enabled: true, maxRetries: 0, backoffMs: 10 });

describe("handler planChainMessages (contract)", () => {
  function makeHandler(store = STORE) {
    return createHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store }),
      loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
      upstreamFetch: async () => nonStreamJson("hi"),
      recordGeneration: () => {},
      readGeneration: () => null,
    });
  }

  it("returns null for a non-auto model (classic/pool paths untouched)", async () => {
    const handler = makeHandler();
    const plan = await handler.planChainMessages(
      { authorization: TOKEN },
      { model: "anthropic/chan-a/claude-a" },
      "claude",
    );
    assert.equal(plan, null);
  });

  it("returns null for auto when the endpoint has no chain", async () => {
    const handler = makeHandler(STORE_NO_CHAIN);
    const plan = await handler.planChainMessages({ authorization: TOKEN }, { model: "auto" }, "claude");
    assert.equal(plan, null);
  });

  it("returns null for auto when the endpoint id is unknown", async () => {
    const handler = makeHandler();
    const plan = await handler.planChainMessages({ authorization: TOKEN }, { model: "auto" }, "zcode");
    assert.equal(plan, null);
  });

  it("fails auth before anything else", async () => {
    const handler = makeHandler();
    const plan = await handler.planChainMessages({ authorization: "wrong" }, { model: "auto" }, "claude");
    assert.equal(plan.ok, false);
    assert.equal(plan.status, 401);
  });

  it("expands the chain into a flat ordered member list with tracker fields", async () => {
    const handler = makeHandler();
    const plan = await handler.planChainMessages({ authorization: TOKEN }, { model: "auto" }, "claude");
    assert.equal(plan.ok, true);
    assert.equal(plan.endpointId, "claude");
    assert.deepEqual(
      plan.members.map((m) => m.memberId),
      ["chan-a", "test-pool/member-a", "test-pool/member-b", "chan-b"],
    );
    assert.deepEqual(
      plan.members.map((m) => [m.providerId, m.model]),
      [
        ["chan-a", "claude-a"],
        ["test-pool", "claude-pool"],
        ["test-pool", "claude-pool"],
        ["chan-b", "claude-b"],
      ],
      "channel nodes key the tracker on the channel id; pool nodes on the pool id, both with the bound model",
    );
    for (const member of plan.members) assert.equal(typeof member.call, "function");
    assert.equal(typeof plan.noteSuccess, "function");
  });

  it("404s when no chain node can serve (pool members lost the bound model)", async () => {
    const store = {
      ...STORE,
      routingChains: { claude: { chain: [{ node: "test-pool", model: "claude-c-only" }] } },
    };
    const handler = makeHandler(store);
    // member-c is not in test-pool, so no pool member carries claude-c-only.
    const plan = await handler.planChainMessages({ authorization: TOKEN }, { model: "auto" }, "claude");
    assert.equal(plan.ok, false);
    assert.equal(plan.status, 404);
  });
});

describe("handleModels auto catalog entry", () => {
  function makeHandler(store = STORE) {
    return createHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store }),
      loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
      upstreamFetch: async () => nonStreamJson("hi"),
      recordGeneration: () => {},
      readGeneration: () => null,
    });
  }

  it("appends the auto virtual model when the caller's endpoint has a chain", async () => {
    const handler = makeHandler();
    const result = await handler.handleModels({ authorization: TOKEN }, "claude");
    assert.equal(result.status, 200);
    const auto = result.body.data.find((entry) => entry.id === "auto");
    assert.ok(auto, "the catalog must list the auto virtual model");
    assert.equal(auto.type, "model");
  });

  it("omits auto when no agentId is given (unidentifiable caller)", async () => {
    const handler = makeHandler();
    const result = await handler.handleModels({ authorization: TOKEN });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.find((entry) => entry.id === "auto"), undefined);
  });

  it("omits auto for an endpoint without a chain", async () => {
    const handler = makeHandler(STORE_NO_CHAIN);
    const result = await handler.handleModels({ authorization: TOKEN }, "claude");
    assert.equal(result.status, 200);
    assert.equal(result.body.data.find((entry) => entry.id === "auto"), undefined);
  });
});

describe("per-launch relay /v1/messages chain routing (model auto)", () => {
  it("(no chain) auto falls through to the classic path and is rejected", async () => {
    const { upstreamFetch, calls } = memberRouter({});
    const deps = createMockDeps({ upstreamFetch, store: STORE_NO_CHAIN, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 400, "auto is not a wire id; without a chain the classic unpack rejects it");
      const body = await res.json();
      assert.match(body.error.message, /not registered/);
      assert.deepEqual(calls, []);
    });
  });

  it("(happy, non-stream) the chain head answers and the upstream sees the bound model", async () => {
    const { upstreamFetch, calls, bodies } = memberRouter({
      "chan-a": () => nonStreamJson("A says hi"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.type, "message");
      assert.equal(body.content[0].text, "A says hi");
      assert.deepEqual(calls, ["chan-a"]);
      assert.equal(bodies[0].model, "claude-a", "the upstream receives the node's bound model, not auto");
    });
  });

  it("(happy, stream) the chain head's stream is translated to Anthropic events", async () => {
    const { upstreamFetch, calls, bodies } = memberRouter({
      "chan-a": () => healthyStream("streamed from A"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port, { stream: true });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("streamed from A"));
      assert.ok(text.includes("event: message_stop"));
      assert.deepEqual(calls, ["chan-a"]);
      assert.equal(bodies[0].model, "claude-a");
    });
  });

  it("(5xx) a dead chain head backs off to the next node (the pool's first member)", async () => {
    const { upstreamFetch, calls, bodies } = memberRouter({
      "chan-a": () => statusError(503),
      "member-a": () => nonStreamJson("pool A recovered"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.content[0].text, "pool A recovered");
      assert.deepEqual(calls, ["chan-a", "member-a"]);
      assert.deepEqual(
        bodies.map((b) => b.model),
        ["claude-a", "claude-pool"],
        "each node is asked for its own bound model",
      );
    });
  });

  it("(404) an upstream 404 on the bound model backs off to the next chain node", async () => {
    const { upstreamFetch, calls, bodies } = memberRouter({
      "chan-a": () => statusError(404),
      "member-a": () => nonStreamJson("pool A recovered"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.content[0].text, "pool A recovered");
      assert.deepEqual(calls, ["chan-a", "member-a"],
        "chain semantics: a 404 means the node cannot serve its bound model, so the chain backs off");
      assert.deepEqual(bodies.map((b) => b.model), ["claude-a", "claude-pool"]);
    });
  });

  it("(pool 404 regression) a pool plan still passes an upstream 404 straight through", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => statusError(404),
      "member-b": () => nonStreamJson("must never be sent"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port, { model: "anthropic/test-pool/claude-pool" });
      assert.equal(res.status, 404, "pool semantics unchanged: 404 is request-shaped and never fails over");
      assert.deepEqual(calls, ["member-a"], "the second pool member must not be tried");
    });
  });

  it("(pool node) members back off internally; a fully dead pool backs off to the next chain node", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => statusError(503),
      "member-a": () => statusError(503),
      "member-b": () => statusError(429),
      "chan-b": () => nonStreamJson("B tail recovered"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.content[0].text, "B tail recovered");
      assert.deepEqual(calls, ["chan-a", "member-a", "member-b", "chan-b"]);
    });
  });

  it("(400) an upstream 400 is a node-level failure: the chain backs off to the next node", async () => {
    // auto 的模型是链自己绑的，客户端不选模型——上游 400（模型改名/失权/
    // 契约漂移）只能归因于节点，不能当请求错误透传。
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => statusError(400),
      "member-a": () => nonStreamJson("pool A recovered"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      assert.deepEqual(calls, ["chan-a", "member-a"],
        "chain semantics: any upstream 4xx means this node rejected the request, so the chain backs off");
    });
  });

  it("(pool 400 regression) a pool plan still passes an upstream 400 straight through", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => statusError(400),
      "member-b": () => nonStreamJson("must never be sent"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port, { model: "anthropic/test-pool/claude-pool" });
      assert.equal(res.status, 400, "pool semantics unchanged: 400 is request-shaped and never fails over");
      assert.deepEqual(calls, ["member-a"], "the second pool member must not be tried");
    });
  });

  it("(all reject 400) the client receives the LAST member's 400", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => statusError(400),
      "chan-b": () => statusError(422),
    });
    const deps = createMockDeps({ upstreamFetch, store: STORE_AB, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 422, "the last chain member's status surfaces");
      assert.deepEqual(calls, ["chan-a", "chan-b"]);
    });
  });

  it("(all down) the client receives the LAST member's error", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => statusError(503),
      "member-a": () => statusError(503),
      "member-b": () => statusError(503),
      "chan-b": () => statusError(429),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 429, "the last chain member's status surfaces");
      assert.deepEqual(calls, ["chan-a", "member-a", "member-b", "chan-b"]);
    });
  });

  it("(kimi relay) auto walks the KIMI endpoint chain, not the claude one", async () => {
    // kimi per-launch relay 与 claude 共用 createRelayServer：deps.agentId
    // 决定 auto 路由走哪个端点的链。这里 STORE 只有 claude 链，kimi 链挂在
    // routingChains.kimi 上。
    const kimiStore = {
      ...STORE,
      routingChains: { kimi: { chain: [{ node: "chan-b", model: "claude-b" }] } },
    };
    const { upstreamFetch, calls, bodies } = memberRouter({
      "chan-b": () => nonStreamJson("B serves kimi"),
    });
    const deps = { ...createMockDeps({ upstreamFetch, store: kimiStore, getKeepAliveConfig: NO_RETRY }), agentId: "kimi" };

    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.content[0].text, "B serves kimi");
      assert.deepEqual(calls, ["chan-b"], "the kimi chain node serves, never the claude chain");
      assert.equal(bodies[0].model, "claude-b");

      const models = await getModels(port);
      const catalog = await models.json();
      assert.ok(catalog.data.find((entry) => entry.id === "auto"), "the kimi chain offers the auto virtual model");
    });
  });

  it("(kimi relay without agentId) claude default keeps the old behaviour", async () => {
    // 零回归对照：同一个只有 kimi 链的 store，默认 agentId（claude）下
    // auto 无链可走，落回 classic 路径并被拒绝。
    const kimiStore = {
      ...STORE,
      routingChains: { kimi: { chain: [{ node: "chan-b", model: "claude-b" }] } },
    };
    const { upstreamFetch, calls } = memberRouter({});
    const deps = createMockDeps({ upstreamFetch, store: kimiStore, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 400);
      assert.deepEqual(calls, []);

      const models = await getModels(port);
      const catalog = await models.json();
      assert.equal(catalog.data.find((entry) => entry.id === "auto"), undefined);
    });
  });

  it("(sticky) a recovered later node leads the next request, pool sticky member included", async () => {
    let chanAFails = true;
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => (chanAFails ? statusError(503) : nonStreamJson("A again")),
      "member-a": () => statusError(503),
      "member-b": () => nonStreamJson("pool B says hi"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      // Two consecutive request-level failures at the head latch the demotion
      // (失败才降级: one blip alone must not demote). Round 2 walks the same
      // path except the pool's own sticky table already prefers member-b.
      const first = await postMessages(port);
      assert.equal(first.status, 200);
      assert.deepEqual(calls, ["chan-a", "member-a", "member-b"], "round 1 fails over into the pool");

      calls.length = 0;
      const second = await postMessages(port);
      assert.equal(second.status, 200);
      // member-a 也只失败过一次（未锁定），池内仍按池序先试 member-a。
      assert.deepEqual(calls, ["chan-a", "member-a", "member-b"], "round 2: chain still starts at the head, member-a not latched yet");

      calls.length = 0;
      chanAFails = false; // chan-a is healthy again; chain stickiness must still start at the pool
      const third = await postMessages(port);
      assert.equal(third.status, 200);
      const body = await third.json();
      assert.equal(body.content[0].text, "pool B says hi");
      assert.deepEqual(calls, ["member-b"], "chain sticky node leads, pool sticky member first inside it");
    });
  });

  it("(sticky 400) consecutive upstream 400s latch the demotion like any node failure", async () => {
    // 400 进请求级失败计数后走同一套「失败才降级」门控：连坏两次锁降级，
    // 第三次请求不再碰头部，直接从第二跳开始。
    let chanAFails = true;
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => (chanAFails ? statusError(400) : nonStreamJson("A again")),
      "chan-b": () => nonStreamJson("B serves"),
    });
    const deps = createMockDeps({ upstreamFetch, store: STORE_AB, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      const first = await postMessages(port);
      assert.equal(first.status, 200);
      assert.deepEqual(calls, ["chan-a", "chan-b"], "round 1 fails over past the 400ing head");

      calls.length = 0;
      const second = await postMessages(port);
      assert.equal(second.status, 200);
      assert.deepEqual(calls, ["chan-a", "chan-b"], "round 2: still starts at the head (one blip does not demote)");

      calls.length = 0;
      const third = await postMessages(port);
      assert.equal(third.status, 200);
      assert.deepEqual(calls, ["chan-b"], "two consecutive 400s latched: the head is skipped");

      calls.length = 0;
      chanAFails = false; // probe window expiry would return here; success must clear the latch
      const fourth = await postMessages(port);
      assert.equal(fourth.status, 200);
      assert.deepEqual(calls, ["chan-b"], "within the retry window the demoted head stays skipped");
    });
  });

  it("(catalog) GET /v1/models lists the auto virtual model for this endpoint", async () => {
    const { upstreamFetch } = memberRouter({});
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      const res = await getModels(port);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.data.some((entry) => entry.id === "auto"), "per-launch catalog must offer auto");
    });
  });

  it("(catalog, no chain) GET /v1/models does not list auto", async () => {
    const { upstreamFetch } = memberRouter({});
    const deps = createMockDeps({ upstreamFetch, store: STORE_NO_CHAIN, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      const res = await getModels(port);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.find((entry) => entry.id === "auto"), undefined);
    });
  });
});


describe("per-launch claude usage journal（claude 端点进入按端点统计）", () => {
  // The per-launch relay's sessionTracker is now a journaling reporter: every
  // terminal recordEnd appends a request row with agentId "claude" — before
  // this, claude traffic never reached the requests journal and the stats
  // tab's by-endpoint trend silently missed the whole endpoint.
  function reporterDeps({ upstreamFetch, store = STORE, getKeepAliveConfig = NO_RETRY } = {}) {
    const lines = [];
    const journal = { lines, appendRequest: (entry) => lines.push(entry) };
    const sessionTracker = createSessionReporter({
      reportUrl: "http://report.invalid/panel/api/session/report",
      journal,
      fetchFn: async () => ({ ok: true }),
    });
    const deps = { ...createMockDeps({ upstreamFetch, store, getKeepAliveConfig }), sessionTracker };
    return { deps, lines };
  }

  it("(auto, non-stream) journal 行归到实际应答节点 + 绑定模型，不再是 auto", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => statusError(503),
      "member-a": () => nonStreamJson("pool answers"),
    });
    const { deps, lines } = reporterDeps({ upstreamFetch });
    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port, { model: "auto", stream: false });
      assert.equal(res.status, 200);
      await res.json();
    });
    assert.deepEqual(calls, ["chan-a", "member-a"]);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].agentId, "claude");
    assert.equal(lines[0].providerId, "test-pool", "pool node attributes at pool level");
    assert.equal(lines[0].model, "claude-pool", "the node's bound model, never the virtual auto");
    assert.equal(lines[0].ok, true);
    assert.equal(lines[0].path, "anthropic");
  });

  it("(auto, stream) 流式应答同样归到实际应答节点", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => statusError(503),
      "member-a": () => healthyStream("pool streams"),
    });
    const { deps, lines } = reporterDeps({ upstreamFetch });
    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port, { model: "auto", stream: true });
      assert.equal(res.status, 200);
      await res.text();
    });
    assert.deepEqual(calls, ["chan-a", "member-a"]);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].agentId, "claude");
    assert.equal(lines[0].providerId, "test-pool");
    assert.equal(lines[0].model, "claude-pool");
    assert.equal(lines[0].ok, true);
  });

  it("(direct wire id) 直连请求照常落行，模型为裸模型名（剥 wire 前缀）", async () => {
    const { upstreamFetch } = memberRouter({ "chan-a": () => nonStreamJson("direct answer") });
    const { deps, lines } = reporterDeps({ upstreamFetch });
    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port, { model: "anthropic/chan-a/claude-a", stream: false });
      assert.equal(res.status, 200);
      await res.json();
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].agentId, "claude");
    // "anthropic/" 前缀是端点身份伪装，不是统计维度：journal 只落裸模型名
    //（与 openai 路径口径一致）；直连经典路径的 providerId 空串是既有口径，
    // 由 usage-stats 读侧从 wire id 回填。
    assert.equal(lines[0].model, "claude-a");
    assert.equal(lines[0].ok, true);
  });

  it("(exhausted) 全链失败的终端错误也落一行 errKind", async () => {
    const { upstreamFetch } = memberRouter({
      "chan-a": () => statusError(503),
      "member-a": () => statusError(503),
      "member-b": () => statusError(503),
      "chan-b": () => statusError(503),
    });
    const { deps, lines } = reporterDeps({ upstreamFetch });
    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port, { model: "auto", stream: false });
      assert.equal(res.status, 503);
      await res.json();
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].ok, false);
    assert.equal(lines[0].status, 503);
    assert.equal(lines[0].errKind, "http_5xx");
  });
});
