import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRelayServer, listenLoopback } from "./openai-server.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";
import { AUTO_MODEL, AUTO_MODEL_ANTHROPIC_ID } from "./chain-routing.mjs";

const TOKEN = "test-token-chain";

// Chain routing (自动路由): body.model === "auto" walks the requesting
// agent's route chain (store.routingChains[agentId].chain). Chain node ids:
//   - chan-a/chan-b/chan-c are plain channels;
//   - pool-x is a two-member pool whose members both carry "model-p".
// Endpoint ids are the fixed agent ids (store-schema ROUTING_ENDPOINT_IDS).
const STORE = {
  version: 2,
  providers: {
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
    "chan-c": {
      displayName: "Channel C",
      baseURL: "http://chan-c.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "chan-c.dpapi",
      models: { "model-c": { displayName: "Model C" } },
    },
    "pool-m1": {
      displayName: "Pool Member 1",
      baseURL: "http://pool-m1.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "pool-m1.dpapi",
      models: { "model-p": { displayName: "Model P from 1" } },
    },
    "pool-m2": {
      displayName: "Pool Member 2",
      baseURL: "http://pool-m2.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "pool-m2.dpapi",
      models: { "model-p": { displayName: "Model P from 2" } },
    },
  },
  pools: {
    "pool-x": { displayName: "Pool X", members: ["pool-m1", "pool-m2"] },
  },
  routingChains: {
    // channel -> channel
    zcode: { chain: [ { node: "chan-a", model: "model-a" }, { node: "chan-b", model: "model-b" } ] },
    // channel -> pool -> channel
    kimi: { chain: [ { node: "chan-a", model: "model-a" }, { node: "pool-x", model: "model-p" }, { node: "chan-c", model: "model-c" } ] },
    // no candidate anywhere: the pool node binds a model no member carries
    dsh: { chain: [ { node: "pool-x", model: "model-zzz" } ] },
    // 同一节点绑定不同模型两次入链（node+model 复合键去重后的合法形态）
    reasonix: { chain: [ { node: "chan-a", model: "model-a" }, { node: "chan-a", model: "model-a2" } ] },
  },
};

// Routes upstream calls by baseURL host: behaviors maps memberId -> () =>
// handler-shaped result (or throws). `calls` records the member order,
// `bodies` the parsed outbound request bodies.
function memberRouter(behaviors) {
  const calls = [];
  const bodies = [];
  const upstreamFetch = async (urls, init) => {
    const url = Array.isArray(urls) ? urls[0] : urls;
    const memberId = new URL(url).host.split(".")[0];
    calls.push(memberId);
    bodies.push(init?.body ? JSON.parse(init.body) : null);
    const behavior = behaviors[memberId];
    if (!behavior) throw new Error(`unexpected upstream call to member "${memberId}"`);
    return behavior();
  };
  return { upstreamFetch, calls, bodies };
}

function createMockDeps({ upstreamFetch, getKeepAliveConfig }) {
  return {
    token: TOKEN,
    loadStore: () => ({ ok: true, store: STORE }),
    loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
    upstreamFetch,
    recordGeneration: () => {},
    readGeneration: () => null,
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

function postChat(port, { agentId = "zcode", model = "auto", stream = true } = {}) {
  return fetch(`http://127.0.0.1:${port}/openai/chan-a/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json", "x-agent-id": agentId },
    body: JSON.stringify({
      model,
      stream,
      messages: [{ role: "user", content: "hi" }],
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

const NO_RETRY = () => ({ enabled: true, maxRetries: 0, backoffMs: 10 });

describe("chain routing: streaming", () => {
  it("(happy) the head channel answers and upstream receives the bound model, not auto", async () => {
    const { upstreamFetch, calls, bodies } = memberRouter({
      "chan-a": () => healthyStream("hello from A"),
      "chan-b": () => healthyStream("must never be sent"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("hello from A"));
      assert.deepEqual(calls, ["chan-a"]);
      assert.equal(bodies[0].model, "model-a", "the node's bound model replaces the virtual auto");
    });
  });

  it("(5xx) a head-channel fault backs off to the second chain node", async () => {
    const { upstreamFetch, calls, bodies } = memberRouter({
      "chan-a": () => statusError(503),
      "chan-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on B"));
      assert.deepEqual(calls, ["chan-a", "chan-b"]);
      assert.equal(bodies[1].model, "model-b", "the second node's own bound model is sent");
    });
  });

  it("(404) an upstream 404 on the bound model backs off to the second chain node", async () => {
    const { upstreamFetch, calls, bodies } = memberRouter({
      "chan-a": () => statusError(404),
      "chan-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on B"));
      assert.deepEqual(calls, ["chan-a", "chan-b"],
        "chain semantics: a 404 means the node cannot serve its bound model, so the chain backs off");
      assert.equal(bodies[1].model, "model-b");
    });
  });

  it("(400) an upstream 400 is a node-level failure: the chain backs off to the second node", async () => {
    // auto 的模型是链自己绑的，客户端不选模型——上游 400（模型改名/失权/
    // 契约漂移）只能归因于节点，不能当请求错误透传。
    const { upstreamFetch, calls, bodies } = memberRouter({
      "chan-a": () => statusError(400),
      "chan-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on B"));
      assert.deepEqual(calls, ["chan-a", "chan-b"],
        "chain semantics: any upstream 4xx means this node rejected the request, so the chain backs off");
      assert.equal(bodies[1].model, "model-b");
    });
  });

  it("(pool node) members fail over inside the pool before the chain backs off", async () => {
    const { upstreamFetch, calls, bodies } = memberRouter({
      "chan-a": () => statusError(503),
      "pool-m1": () => statusError(503),
      "pool-m2": () => healthyStream("recovered on pool member 2"),
      "chan-c": () => healthyStream("must never be sent"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port, { agentId: "kimi" });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on pool member 2"));
      assert.deepEqual(calls, ["chan-a", "pool-m1", "pool-m2"],
        "a pool node fails internally member by member; the third chain node is not touched");
      assert.equal(bodies[2].model, "model-p", "pool members are called with the pool node's bound model");
    });
  });

  it("(pool exhausted) the whole pool down backs off to the third chain node", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => statusError(503),
      "pool-m1": () => statusError(503),
      "pool-m2": () => statusError(429),
      "chan-c": () => healthyStream("recovered on C"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port, { agentId: "kimi" });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on C"));
      assert.deepEqual(calls, ["chan-a", "pool-m1", "pool-m2", "chan-c"],
        "only a fully exhausted pool counts as a failed node");
    });
  });

  it("(blip) a single transient head fault does NOT latch a demotion (黄灯不降级)", async () => {
    let chanAFails = true;
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => (chanAFails ? statusError(503) : healthyStream("A again")),
      "chan-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const first = await postChat(port);
      assert.equal(first.status, 200);
      await first.text();
      assert.deepEqual(calls, ["chan-a", "chan-b"], "the blipped request still fails over to chan-b");

      calls.length = 0;
      chanAFails = false;
      const second = await postChat(port);
      assert.equal(second.status, 200);
      const text = await second.text();
      assert.ok(text.includes("A again"));
      assert.deepEqual(calls, ["chan-a"], "one transient fault is not a failure — the chain still starts at the head");
    });
  });

  it("(sticky) the node that answered leads the next request once the head latches as failing", async () => {
    let chanAFails = true;
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => (chanAFails ? statusError(503) : healthyStream("A again")),
      "chan-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      // Two consecutive request-level failures at the head latch the demotion
      // (失败才降级: two is CHAIN_DEMOTE_AFTER_FAILURES).
      for (let round = 0; round < 2; round += 1) {
        const res = await postChat(port);
        assert.equal(res.status, 200);
        await res.text();
        assert.deepEqual(calls, ["chan-a", "chan-b"], `round ${round + 1} fails over to chan-b`);
        calls.length = 0;
      }

      chanAFails = false; // chan-a is healthy again; the latched demotion still prefers chan-b
      const third = await postChat(port);
      assert.equal(third.status, 200);
      const text = await third.text();
      assert.ok(text.includes("recovered on B"));
      assert.deepEqual(calls, ["chan-b"], "the chain restarts at the node that answered last");
    });
  });

  it("(same node twice) the first occurrence answering sticks to ITSELF, not the later one", async () => {
    // 同一节点两个模型：第一次出现应答后，粘性键是 node+model，下一请求仍从
    // 链首（model-a）开始；若按 node 记录会错粘到第二次出现（model-a2）。
    const { upstreamFetch, calls, bodies } = memberRouter({
      "chan-a": () => healthyStream("A answers"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const first = await postChat(port, { agentId: "reasonix" });
      assert.equal(first.status, 200);
      await first.text();
      assert.deepEqual(calls, ["chan-a"]);
      assert.equal(bodies[0].model, "model-a");

      calls.length = 0;
      bodies.length = 0;
      const second = await postChat(port, { agentId: "reasonix" });
      assert.equal(second.status, 200);
      await second.text();
      assert.deepEqual(calls, ["chan-a"]);
      assert.equal(bodies[0].model, "model-a", "sticky must point at the first occurrence, not the same node's later entry");
    });
  });

  it("(same node twice) the second occurrence answering sticks to the second occurrence", async () => {
    // 同一节点两个模型：第一次出现（model-a）持续 404。前两个请求都走
    // [model-a(404) → model-a2(ok)]，第二次连续失败锁定降级；此后链从
    // 第二次出现（model-a2）开始。
    const { upstreamFetch, calls, bodies } = memberRouter({
      // memberRouter 在调用 behavior 前已把本请求体压进 bodies，
      // 据此区分同一节点的两次出现。
      "chan-a": () => {
        const model = bodies.length ? bodies[bodies.length - 1].model : "model-a";
        return model === "model-a" ? statusError(404) : healthyStream("A2 answers");
      },
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      // 两个请求都走 [model-a(404) → model-a2(ok)]：第二次连续失败锁定降级。
      for (let round = 0; round < 2; round += 1) {
        const res = await postChat(port, { agentId: "reasonix" });
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.ok(text.includes("A2 answers"));
        assert.deepEqual(calls, ["chan-a", "chan-a"], `round ${round + 1}: the same node is tried twice with its two bound models`);
        assert.deepEqual(bodies.map((b) => b.model), ["model-a", "model-a2"]);
        calls.length = 0;
        bodies.length = 0;
      }

      const third = await postChat(port, { agentId: "reasonix" });
      assert.equal(third.status, 200);
      await third.text();
      assert.deepEqual(calls, ["chan-a"], "the chain restarts at the second occurrence, skipping the dead head entry");
      assert.equal(bodies[0].model, "model-a2");
    });
  });
});

describe("chain routing: non-streaming", () => {
  it("(non-stream) same failover semantics without streaming", async () => {
    const { upstreamFetch, calls, bodies } = memberRouter({
      "chan-a": () => statusError(503),
      "chan-b": async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "B says hi" } }] }) }),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port, { stream: false });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.choices[0].message.content, "B says hi");
      assert.deepEqual(calls, ["chan-a", "chan-b"]);
      assert.equal(bodies[1].model, "model-b");
    });
  });

  it("(non-stream 404) an upstream 404 backs off to the second chain node", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => statusError(404),
      "chan-b": async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "B recovered" } }] }) }),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port, { stream: false });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.choices[0].message.content, "B recovered");
      assert.deepEqual(calls, ["chan-a", "chan-b"],
        "the hand-written non-stream loop uses the chain predicate too");
    });
  });

  it("(non-stream 400) an upstream 400 backs off to the second chain node", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => statusError(400),
      "chan-b": async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "B recovered" } }] }) }),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port, { stream: false });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.choices[0].message.content, "B recovered");
      assert.deepEqual(calls, ["chan-a", "chan-b"],
        "the hand-written non-stream loop uses the chain predicate too");
    });
  });
});

describe("chain routing: pool plan regression", () => {
  it("(pool 404) a pool plan still passes an upstream 404 straight through", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "pool-m1": () => statusError(404),
      "pool-m2": () => healthyStream("must never be sent"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/openai/pool-x/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json" },
        body: JSON.stringify({
          model: "model-p",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      assert.equal(res.status, 404, "pool semantics unchanged: 404 is request-shaped and never fails over");
      assert.deepEqual(calls, ["pool-m1"], "the second pool member must not be tried");
    });
  });

  it("(pool 400) a pool plan still passes an upstream 400 straight through", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "pool-m1": () => statusError(400),
      "pool-m2": () => healthyStream("must never be sent"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/openai/pool-x/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json" },
        body: JSON.stringify({
          model: "model-p",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      assert.equal(res.status, 400, "pool semantics unchanged: 400 is request-shaped and never fails over");
      assert.deepEqual(calls, ["pool-m1"], "the second pool member must not be tried");
    });
  });
});

describe("chain routing: models and pre-flight", () => {
  it("(no chain) model auto without a chain keeps the classic 404", async () => {
    const { upstreamFetch, calls } = memberRouter({});
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port, { agentId: "pi" });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.match(body.error.message, /model "auto" is not in provider "chan-a"/);
      assert.deepEqual(calls, []);
    });
  });

  it("(dead chain) no live chain node answers with 404 and no upstream call", async () => {
    const { upstreamFetch, calls } = memberRouter({});
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port, { agentId: "dsh" });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.match(body.error.message, /auto/);
      assert.match(body.error.message, /dsh/);
      assert.deepEqual(calls, []);
    });
  });

  it("(models) GET /models appends the virtual auto entry when the agent has a chain", async () => {
    const { upstreamFetch, calls } = memberRouter({});
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/openai/chan-a/v1/models`, {
        headers: { authorization: TOKEN, "x-agent-id": "zcode" },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.data.map((m) => m.id), ["model-a", "auto"]);
      assert.deepEqual(calls, [], "model listing must not call any upstream");
    });
  });

  it("(models) GET /models has no auto entry when the agent has no chain", async () => {
    const { upstreamFetch, calls } = memberRouter({});
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/openai/chan-a/v1/models`, {
        headers: { authorization: TOKEN, "x-agent-id": "pi" },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.data.map((m) => m.id), ["model-a"]);
      assert.deepEqual(calls, []);
    });
  });

  it("(models) resident GET /v1/models appends auto for a UA-sniffed agent with a chain", async () => {
    const { upstreamFetch, calls } = memberRouter({});
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const withChain = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { authorization: TOKEN, "user-agent": "kimi-code/1.0" },
      });
      assert.equal(withChain.status, 200);
      const catalog = await withChain.json();
      // The anthropic-path catalog advertises auto under its picker-surviving
      // alias (Claude Code's discovery filter drops the bare id).
      assert.ok(
        (catalog.data ?? catalog.models ?? []).some((m) => (m.id ?? m.wireId) === AUTO_MODEL_ANTHROPIC_ID),
        "kimi has a chain, so the catalog must carry the virtual auto entry",
      );
      assert.ok(
        !(catalog.data ?? catalog.models ?? []).some((m) => (m.id ?? m.wireId) === AUTO_MODEL),
        "the bare auto id is never advertised on the anthropic path",
      );

      const noChain = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { authorization: TOKEN, "user-agent": "claude-cli/1.0" },
      });
      assert.equal(noChain.status, 200);
      const catalog2 = await noChain.json();
      assert.ok(
        !(catalog2.data ?? catalog2.models ?? []).some((m) => (m.id ?? m.wireId) === AUTO_MODEL_ANTHROPIC_ID),
        "claude has no chain, so the catalog must not carry auto",
      );
      assert.deepEqual(calls, []);
    });
  });
});

describe("chain runtime introspection endpoint (/api/internal/route-chain-runtime)", () => {
  function getRuntime(port, token = TOKEN) {
    return fetch(`http://127.0.0.1:${port}/api/internal/route-chain-runtime`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  it("rejects callers without the relay token", async () => {
    const { upstreamFetch } = memberRouter({});
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });
    await withServer(deps, async (port) => {
      const res = await getRuntime(port, null);
      assert.equal(res.status, 401);
      const bad = await getRuntime(port, "wrong-token");
      assert.equal(bad.status, 401);
    });
  });

  it("before any chain request, configured endpoints report the chain head with since null", async () => {
    const { upstreamFetch } = memberRouter({});
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });
    await withServer(deps, async (port) => {
      const res = await getRuntime(port);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.endpoints.zcode, {
        current: { node: "chan-a", model: "model-a" },
        since: null,
        retryIntervalMs: 300000,
        lamps: ["green", "gray"], // per-startup: fresh start lights only the head
        positions: [], // no backoff records anywhere
      });
      assert.deepEqual(body.endpoints.kimi.current, { node: "chan-a", model: "model-a" });
    });
  });

  it("after a failover, the endpoint reports the backed-off node and the backoff time", async () => {
    const { upstreamFetch } = memberRouter({
      "chan-a": () => statusError(503),
      "chan-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });
    await withServer(deps, async (port) => {
      // One failover alone does not demote (黄灯不降级): two consecutive
      // request-level failures at the head are what latch the backoff. The
      // demotion moment is round 2's walk, so the clock brackets it.
      let before = Date.now();
      for (let round = 0; round < 2; round += 1) {
        before = Date.now();
        const chat = await postChat(port);
        assert.equal(chat.status, 200);
        await chat.text();
      }
      const after = Date.now();

      const res = await getRuntime(port);
      const body = await res.json();
      assert.deepEqual(body.endpoints.zcode.current, { node: "chan-b", model: "model-b" });
      assert.equal(typeof body.endpoints.zcode.since, "number");
      assert.ok(body.endpoints.zcode.since >= before && body.endpoints.zcode.since <= after,
        "since is the moment the backoff happened");
      assert.equal(body.endpoints.zcode.retryIntervalMs, 300000);
      // Untouched endpoints still sit at their chain head.
      assert.deepEqual(body.endpoints.kimi.current, { node: "chan-a", model: "model-a" });
      assert.equal(body.endpoints.kimi.since, null);
    });
  });
});

describe("chain enabled 开关（自动路由 per-endpoint 启用）", () => {
  // zcode 的链加了 enabled:false；kimi 的链保持默认（开）。
  const DISABLED_STORE = {
    ...STORE,
    routingChains: {
      zcode: { enabled: false, chain: [{ node: "chan-a", model: "model-a" }, { node: "chan-b", model: "model-b" }] },
      kimi: STORE.routingChains.kimi,
    },
  };
  const disabledDeps = (upstreamFetch) => ({
    ...createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY }),
    loadStore: () => ({ ok: true, store: DISABLED_STORE }),
  });

  it("(models) 开关关时 GET /openai/.../models 不再追加 auto（链配置保留）", async () => {
    const { upstreamFetch, calls } = memberRouter({});
    await withServer(disabledDeps(upstreamFetch), async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/openai/chan-a/v1/models`, {
        headers: { authorization: TOKEN, "x-agent-id": "zcode" },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.data.map((m) => m.id), ["model-a"]);
      assert.deepEqual(calls, []);
    });
  });

  it("(chat) 开关关时 POST model=auto 不走链，回落到经典 404", async () => {
    const { upstreamFetch, calls } = memberRouter({});
    await withServer(disabledDeps(upstreamFetch), async (port) => {
      const res = await postChat(port, { agentId: "zcode", stream: false });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.match(body.error.message, /model "auto" is not in provider "chan-a"/);
      assert.deepEqual(calls, [], "disabled chain must not fire any upstream call");
    });
  });

  it("(models) 开关关时常驻 /v1/models（anthropic 通道）也不追加 auto", async () => {
    const { upstreamFetch } = memberRouter({});
    const store = {
      ...STORE,
      routingChains: { kimi: { enabled: false, chain: STORE.routingChains.kimi.chain } },
    };
    const deps = { ...createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY }), loadStore: () => ({ ok: true, store }) };
    await withServer(deps, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { authorization: TOKEN, "user-agent": "kimi-code/1.0" },
      });
      assert.equal(res.status, 200);
      const catalog = await res.json();
      assert.ok(
        !(catalog.data ?? catalog.models ?? []).some((m) => (m.id ?? m.wireId) === AUTO_MODEL_ANTHROPIC_ID),
        "kimi's chain is disabled, so the catalog must not carry auto",
      );
      assert.ok(
        !(catalog.data ?? catalog.models ?? []).some((m) => (m.id ?? m.wireId) === AUTO_MODEL),
        "the bare auto id is never advertised on the anthropic path",
      );
    });
  });

  it("(runtime) 开关关的端点不进 route-chain runtime（监测页 Flow Rail 数据源）", async () => {
    const { upstreamFetch } = memberRouter({});
    await withServer(disabledDeps(upstreamFetch), async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/internal/route-chain-runtime`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.endpoints.zcode, undefined, "disabled endpoint must not surface in the runtime view");
      assert.ok(body.endpoints.kimi, "enabled endpoints still report their chain head");
    });
  });
});

describe("openai 路径端点识别（UA 嗅探）", () => {
  // 只有 kimi 配了链：kimi 的合并配置（kimi-merge-config.mjs）不带 x-agent-id，
  // 端点识别只能依赖 UA。修复前 openaiAgentIdFrom 把 kimi 兜底成 zcode——
  // kimi 的链既不暴露 auto，调用 auto 也按 zcode（无链）404。
  const KIMI_ONLY_STORE = {
    ...STORE,
    routingChains: {
      kimi: { chain: [{ node: "chan-b", model: "model-b" }] },
    },
  };
  const kimiDeps = (upstreamFetch) => ({
    ...createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY }),
    loadStore: () => ({ ok: true, store: KIMI_ONLY_STORE }),
  });

  it("(models) UA kimi-code 的 /openai/.../models 追加 kimi 链的 auto", async () => {
    const { upstreamFetch } = memberRouter({});
    await withServer(kimiDeps(upstreamFetch), async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/openai/chan-a/v1/models`, {
        headers: { authorization: TOKEN, "user-agent": "kimi-code/1.0" },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.data.map((m) => m.id), ["model-a", "auto"]);
    });
  });

  it("(chat) UA kimi-code 的 auto 请求走 kimi 自己的链，不是 zcode 兜底", async () => {
    const { upstreamFetch, calls, bodies } = memberRouter({
      "chan-b": async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "kimi chain answered" } }] }) }),
    });
    await withServer(kimiDeps(upstreamFetch), async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/openai/chan-a/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json", "user-agent": "kimi-code/1.0" },
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(calls, ["chan-b"], "kimi's chain head is chan-b; a zcode fallback would 404 (no chain)");
      assert.equal(bodies[0].model, "model-b");
    });
  });

  it("(models) UA kimi-code 且 kimi 无链时不泄漏 zcode 的 auto", async () => {
    const { upstreamFetch } = memberRouter({});
    // zcode 有链、kimi 无链：kimi 的列表不得出现 auto（修复前兜底到 zcode 会错配）。
    const deps = {
      ...createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY }),
      loadStore: () => ({ ok: true, store: { ...STORE, routingChains: { zcode: STORE.routingChains.zcode } } }),
    };
    await withServer(deps, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/openai/chan-a/v1/models`, {
        headers: { authorization: TOKEN, "user-agent": "kimi-code/1.0" },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.data.map((m) => m.id), ["model-a"]);
    });
  });
});

describe("auto 路由统计口径（auto 不作独立端点统计）", () => {
  // 真实采集器 + 假 journal：数据统计页唯一数据源是 journal，口径必须落在
  // 实际应答节点（节点 id + 绑定模型）上，虚拟模型 auto 不得独立成行。
  function journalDeps(upstreamFetch) {
    const lines = [];
    const journal = { lines, appendRequest: (entry) => lines.push(entry) };
    const collector = createAgentMetricsCollector({ loadSparkSettings: false, journal });
    return {
      deps: { ...createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY }), metricsCollector: collector },
      lines,
      collector,
    };
  }

  it("(stream) journal 归到实际应答节点，head 的失败计在 head 节点名下", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => statusError(503),
      "chan-b": () => healthyStream("recovered on B"),
    });
    const { deps, lines, collector } = journalDeps(upstreamFetch);

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      await res.text();
      assert.deepEqual(calls, ["chan-a", "chan-b"]);
    });

    assert.equal(lines.length, 1, "exactly one journal line per client request");
    assert.equal(lines[0].providerId, "chan-b", "attributed to the answering node, not the chain-head URL segment");
    assert.equal(lines[0].model, "model-b", "attributed to the node's bound model, not the virtual auto");

    const rows = collector.getModelStability().models;
    const okRow = rows.find((r) => r.provider === "chan-b");
    assert.equal(okRow.model, "model-b");
    assert.ok(okRow.successRate > 0);
    const failedRow = rows.find((r) => r.provider === "chan-a");
    assert.equal(failedRow.model, "model-a", "the failed head attempt counts against the head node");
    assert.equal(failedRow.successRate, 0);
    assert.ok(!rows.some((r) => r.model === "auto"), "auto must never surface as a stability row");
  });

  it("(pool node) 池节点成员的应答归到池节点 + 绑定模型", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => statusError(503),
      "pool-m1": () => statusError(503),
      "pool-m2": () => healthyStream("recovered on pool member 2"),
      "chan-c": () => healthyStream("must never be sent"),
    });
    const { deps, lines, collector } = journalDeps(upstreamFetch);

    await withServer(deps, async (port) => {
      const res = await postChat(port, { agentId: "kimi" });
      assert.equal(res.status, 200);
      await res.text();
      assert.deepEqual(calls, ["chan-a", "pool-m1", "pool-m2"]);
    });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].providerId, "pool-x", "a pool node answers as the NODE, not as its member");
    assert.equal(lines[0].model, "model-p");

    const rows = collector.getModelStability().models;
    assert.ok(!rows.some((r) => r.model === "auto"));
    const poolRow = rows.find((r) => r.provider === "pool-x");
    assert.equal(poolRow.model, "model-p");
    assert.equal(poolRow.total, 2, "both pool attempts count against the pool node row");
  });

  it("(non-stream) 非流式请求同样归到实际应答节点", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => statusError(503),
      "chan-b": async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "B says hi" } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }) }),
    });
    const { deps, lines } = journalDeps(upstreamFetch);

    await withServer(deps, async (port) => {
      const res = await postChat(port, { stream: false });
      assert.equal(res.status, 200);
      await res.json();
      assert.deepEqual(calls, ["chan-a", "chan-b"]);
    });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].providerId, "chan-b");
    assert.equal(lines[0].model, "model-b");
    assert.equal(lines[0].ok, true);
    assert.equal(lines[0].prompt, 7);
  });

  it("(direct pool unaffected) 直连池请求仍按池口径统计（无解析器）", async () => {
    const { upstreamFetch } = memberRouter({
      "pool-m1": () => healthyStream("pool member answers"),
    });
    const { deps, lines } = journalDeps(upstreamFetch);

    await withServer(deps, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/openai/pool-x/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ model: "model-p", stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 200);
      await res.text();
    });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].providerId, "pool-x", "direct pool traffic keeps the pool-level attribution");
    assert.equal(lines[0].model, "model-p");
  });

  it("(resident anthropic) 常驻 /v1/messages 的 auto 请求同样归到实际应答节点", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => statusError(503),
      "pool-m1": () => statusError(503),
      "pool-m2": async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "recovered" } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }) }),
      "chan-c": async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "must never be sent" } }] }) }),
    });
    const { deps, lines } = journalDeps(upstreamFetch);

    await withServer(deps, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json", "user-agent": "kimi-code/1.0" },
        body: JSON.stringify({ model: "auto", max_tokens: 64, stream: false, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.content[0].text, "recovered");
      assert.deepEqual(calls, ["chan-a", "pool-m1", "pool-m2"]);
    });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].providerId, "pool-x", "the resident anthropic path attributes to the serving node too");
    assert.equal(lines[0].model, "model-p");
    assert.equal(lines[0].agentId, "kimi");
  });
});

describe("wire id 统计口径（anthropic/ 前缀不进 journal）", () => {
  // Claude Code 以完整 wire id "anthropic/<provider>/<model>" 作为 body.model
  // 发到 anthropic 端点（前缀是端点识别所需的身份伪装，非统计数据）。
  // journal / 稳定性 / 面板只能看到裸模型名，与 openai 路径口径一致。
  // 真实采集器 + 假 journal，与上方「auto 路由统计口径」块同构（该块把
  // journalDeps 关在自己的闭包里，这里自带一份）。
  function journalDeps(upstreamFetch) {
    const lines = [];
    const journal = { lines, appendRequest: (entry) => lines.push(entry) };
    const collector = createAgentMetricsCollector({ loadSparkSettings: false, journal });
    return {
      deps: { ...createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY }), metricsCollector: collector },
      lines,
    };
  }

  it("(resident anthropic) 直连 wire id 请求的 journal 模型名为裸模型名", async () => {
    const { upstreamFetch } = memberRouter({
      "chan-a": () => healthyStream("direct wire-id"),
    });
    const { deps, lines } = journalDeps(upstreamFetch);

    await withServer(deps, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json", "user-agent": "claude-code/1.0" },
        body: JSON.stringify({ model: "anthropic/chan-a/model-a", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 200);
      await res.text();
    });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].model, "model-a", "the wire prefix and provider segment must not reach the journal");
    // Direct (non-pool/chain) anthropic requests carry their channel id in
    // the startRequest meta (wireIdToTargetId) — without it the per-launch
    // session reporter's fallback chain ends in an empty 未知渠道 row
    // (2026-09-03 regression fix; c924055 had removed the read-time backfill
    // this row shape used to rely on).
    assert.equal(lines[0].providerId, "chan-a");
  });

  it("(resident anthropic) 池 wire id 请求的 journal 模型名同样剥前缀", async () => {
    const { upstreamFetch } = memberRouter({
      "pool-m1": () => healthyStream("pool answers"),
    });
    const { deps, lines } = journalDeps(upstreamFetch);

    await withServer(deps, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json", "user-agent": "claude-code/1.0" },
        body: JSON.stringify({ model: "anthropic/pool-x/model-p", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 200);
      await res.text();
    });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].model, "model-p");
    assert.equal(lines[0].providerId, "pool-x");
  });

  it("(openai chat) openai 路径模型名不受影响（裸名直传）", async () => {
    const { upstreamFetch } = memberRouter({
      "chan-a": () => healthyStream("openai path"),
    });
    const { deps, lines } = journalDeps(upstreamFetch);

    await withServer(deps, async (port) => {
      const res = await postChat(port, { agentId: "zcode", model: "model-a", stream: true });
      assert.equal(res.status, 200);
      await res.text();
    });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].model, "model-a");
    assert.equal(lines[0].providerId, "chan-a");
  });
});
