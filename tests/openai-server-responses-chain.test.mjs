// Responses 端点（codex 前端）× 链路由：/openai/<seg>/v1/responses 在 model
// "auto"（请求方端点的链）与虚拟模型名（链自己的路由键）上的整段验收。
// codex 的产品配置发出去的正是这个组合，此前只有 chat/completions 与常驻
// anthropic 两条通道有链验收。同文件钉住 Responses 流式通道的两条接线：
// per-endpoint 抗截断开关的 agentId（保活配置按端点关断必须真的关住 codex）、
// 智能分流的在途计数（onMemberBegin/onMemberEnd 在真实流式生成形态下抬升/归还）。
// 真实回环 socket + 合成 store + mock 上游。无真实凭据、无真实出网、无 DPAPI。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRelayServer } from "../src/relay/openai-server.mjs";
import { createAgentMetricsCollector } from "../src/agents/agent-metrics.mjs";
import { createEffortInjector } from "../src/catalog/effort-injection.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";
import { listenLoopback } from "../test-helpers/loopback.mjs";

const TOKEN = "test-token-responses-chain";

// 与 anthropic-stream 系列同一隔离桩：handler 直调 anthropicToOpenAI 的
// midSystemRewrite 开关没有 deps 注入面，重定向 LOCALAPPDATA 后现读全部落空目录。
const envRoot = mkTestDir("anyswitch-responses-chain-env-");
process.env.LOCALAPPDATA = envRoot;
process.env.APPDATA = envRoot;
process.env.USERPROFILE = envRoot;

const OFF_EFFORT_INJECTOR = () => createEffortInjector({ isEnabled: () => false });

// 链：codex 端点（x-agent-id: codex，即产品配置注入的身份）chan-a → chan-b。
// 池 pool-x 两成员都带 model-p，供直投池与链内池节点两用。
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
    codex: { chain: [{ node: "chan-a", model: "model-a" }, { node: "chan-b", model: "model-b" }] },
  },
};

// 虚拟模型：启用与停用各一条（同链形状，判定只差 enabled 字段）。
const VM_STORE = {
  ...STORE,
  virtualModels: [
    { name: "vm-fast", chain: [{ node: "chan-a", model: "model-a" }, { node: "chan-b", model: "model-b" }] },
    { name: "vm-off", enabled: false, chain: [{ node: "chan-a", model: "model-a" }] },
  ],
};

// 按 baseURL 主机段路由上游调用：behaviors[memberId] 返回 handler 形状的结果。
// calls 记成员顺序；bodies 记每次出网请求体。
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

function createMockDeps({ upstreamFetch, store = STORE, getKeepAliveConfig, poolLoadBalancingGate = () => false } = {}) {
  return {
    token: TOKEN,
    loadStore: () => ({ ok: true, store }),
    loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
    upstreamFetch,
    recordGeneration: () => {},
    readGeneration: () => null,
    getKeepAliveConfig,
    poolLoadBalancingGate,
    effortInjector: OFF_EFFORT_INJECTOR(),
    imageFallbackGate: () => false,
    imageHeuristicGate: () => false,
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

function postResponses(port, { path = "/openai/chan-a/v1/responses", model = "auto", headers = {}, body } = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json", "x-agent-id": "codex", ...headers },
    body: JSON.stringify(body ?? { model, input: "hi", stream: true }),
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
      'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ]),
  };
}

function statusError(status) {
  return { ok: false, status, body: { error: { message: `upstream ${status}` } } };
}

const NO_RETRY = () => ({ enabled: true, maxRetries: 0, backoffMs: 10 });

// 上游空转流（无内容无 finish_reason）：保活语义里的 empty_stream 分类样本
// （与 openai-server-keepalive (c2) 的空流形状一致）。
const EMPTY_CHAT_SSE = [
  'data: {"id":"1","choices":[{"delta":{}}]}\n\n',
  "data: [DONE]\n\n",
];

describe("responses × auto 链（codex 产品组合）", () => {
  it("(happy) auto 走请求方端点的链：上游拿到节点绑定模型，回程是 Responses SSE", async () => {
    const { upstreamFetch, calls, bodies } = memberRouter({
      "chan-a": () => healthyStream("hello from A"),
      "chan-b": () => healthyStream("must never be sent"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postResponses(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("event: response.created"), "流以 response.created 打开");
      assert.ok(text.includes("hello from A"), "链头节点的内容透传给客户端");
      assert.ok(text.includes("event: response.completed"), "流以 response.completed 收束");
      assert.deepEqual(calls, ["chan-a"], "链头健康时只调一家");
      // 翻译后的 chat 体进链规划：上游见到节点绑定模型与翻译后的消息序列，
      // 虚拟模型名 auto 绝不出网。
      assert.equal(bodies[0].model, "model-a");
      assert.deepEqual(bodies[0].messages, [{ role: "user", content: "hi" }]);
      assert.equal(bodies[0].stream, true);
    });
  });

  it("(5xx) 链头 503 退避到第二个节点，客户端拿到恢复流", async () => {
    const { upstreamFetch, calls, bodies } = memberRouter({
      "chan-a": () => statusError(503),
      "chan-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postResponses(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on B"));
      assert.ok(text.includes("event: response.completed"), "故障发生在首字前，回程仍是完整 Responses 流");
      assert.deepEqual(calls, ["chan-a", "chan-b"]);
      assert.equal(bodies[1].model, "model-b", "第二个节点发自己绑定的模型");
    });
  });

  it("(400) 上游 400 是链节点级故障：退避而不是按请求错误透传", async () => {
    // auto 的模型是链自己绑的，客户端不选模型——上游 400 只能归因于节点。
    // isFailoverStatus 在 Responses 通道必须取链口径（isChainFailoverStatus），
    // 退回池口径（404/400 透传）时这里红。
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => statusError(400),
      "chan-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postResponses(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on B"));
      assert.deepEqual(calls, ["chan-a", "chan-b"], "链口径：任意上游 4xx 都退避到下一节点");
    });
  });

  it("(虚拟模型) 档位/目录可指到的虚拟模型名走它自己的链；停用的名字 404 且不触上游", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => healthyStream("vm answers"),
    });
    const deps = createMockDeps({ upstreamFetch, store: VM_STORE, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const ok = await postResponses(port, { model: "vm-fast" });
      assert.equal(ok.status, 200);
      const text = await ok.text();
      assert.ok(text.includes("vm answers"));
      assert.deepEqual(calls, ["chan-a"], "虚拟模型名是全局路由键，不依赖请求方端点");

      const refused = await postResponses(port, { model: "vm-off" });
      assert.equal(refused.status, 404, "停用的虚拟模型必须被拒");
      assert.equal((await refused.json()).error.type, "not_found_error");
      assert.deepEqual(calls, ["chan-a"], "停用的虚拟模型不得发起任何上游调用");
    });
  });

  it("(统计口径) auto 路由的 journal 行落在实际应答节点（节点 + 绑定模型）", async () => {
    // 真实采集器 + 假 journal：setAttributeResolver 的接线把行归到
    // chan-b（退避后的应答节点），虚拟模型名 auto 不落任何独立统计行。
    const lines = [];
    const journal = { lines, appendRequest: (entry) => lines.push(entry) };
    const collector = createAgentMetricsCollector({ loadSparkSettings: () => ({ sparkWindowPoints: 16 }), journal });
    const { upstreamFetch } = memberRouter({
      "chan-a": () => statusError(503),
      "chan-b": () => healthyStream("recovered on B"),
    });
    const deps = { ...createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY }), metricsCollector: collector };

    await withServer(deps, async (port) => {
      const res = await postResponses(port);
      assert.equal(res.status, 200);
      await res.text();
    });

    assert.equal(lines.length, 1, "一条请求一行 journal");
    assert.equal(lines[0].agentId, "codex");
    assert.equal(lines[0].providerId, "chan-b", "行落在实际应答节点，而不是 auto 或 URL 段渠道");
    assert.equal(lines[0].model, "model-b", "模型名是节点绑定模型，不是 auto");
  });
});

describe("responses 通道的 per-endpoint 抗截断开关（agentId 接线）", () => {
  // 开关形状：keepAlive.endpoints[agentId].enabled。 Responses 通道传出的
  // agentId 是 codex——面板把 codex 单独关掉时，codex 的空流不得重试；
  // 不在名单里的端点照常继承主开关。用例走直连模型（不经链）：链规划会把
  // 首字前的故障当作节点退避，那是链语义，不是这里的保活预算。
  function emptyStreamUpstream(counter) {
    return async () => {
      counter.calls += 1;
      if (counter.calls === 1) {
        return { ok: true, status: 200, body: sseStream(EMPTY_CHAT_SSE) };
      }
      return healthyStream("recovered on retry");
    };
  }

  it("codex 在面板被单独关断：空流不重试（一次调用即 502）", async () => {
    const counter = { calls: 0 };
    const deps = createMockDeps({
      upstreamFetch: emptyStreamUpstream(counter),
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10, endpoints: { codex: { enabled: false } } }),
    });

    await withServer(deps, async (port) => {
      const res = await postResponses(port, { model: "model-a" });
      assert.equal(res.status, 502);
      assert.equal((await res.json()).error.type, "api_error");
      assert.equal(counter.calls, 1, "端点开关关掉后保活预算归零：不得重试");
    });
  });

  it("不在关断名单的端点继承主开关：空流重试并恢复", async () => {
    const counter = { calls: 0 };
    const deps = createMockDeps({
      upstreamFetch: emptyStreamUpstream(counter),
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10, endpoints: { dsh: { enabled: false } } }),
    });

    await withServer(deps, async (port) => {
      const res = await postResponses(port, { model: "model-a" });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on retry"));
      assert.equal(counter.calls, 2, "首次空流 + 一次保活重试");
      assert.ok(text.includes("event: response.completed"));
    });
  });
});

describe("responses 流式通道的智能分流在途计数（onMemberBegin/onMemberEnd）", () => {
  // 判据是选头行为本身：a 在途时新请求避开 a（begin 接线抬升负载分）；a 收尾
  // 后新请求落回 a（end 接线归还计数）。begin 断线 → a 恒 0 → 第二条仍落 a；
  // end 断线 → a 恒忙 → 第三条继续避开 a。与 pool-load-balancing 的直连池
  // chat 用例同一形状，但走的是 /v1/responses（codex 的真实生成形态）。
  it("在途抬升与收尾归还都经真实流式请求生效", async () => {
    const enc = new TextEncoder();
    const calls = [];
    let releaseA;
    const parkedA = new Promise((resolve) => { releaseA = resolve; });
    let aParked;
    const aAtGate = new Promise((resolve) => { aParked = resolve; });
    let aCalls = 0;
    const upstreamFetch = async (urls) => {
      const memberId = new URL(Array.isArray(urls) ? urls[0] : urls).host.split(".")[0];
      calls.push(memberId);
      if (memberId === "pool-m1") {
        aCalls += 1;
        if (aCalls === 1) {
          // 首次：交出首块后停在闸门前，模拟慢上游（在途计数保持抬起）。
          return {
            ok: true,
            status: 200,
            body: (async function* () {
              yield enc.encode('data: {"id":"1","choices":[{"delta":{"content":"member-a answers"}}]}\n\n');
              aParked();
              await parkedA;
              yield enc.encode('data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
              yield enc.encode("data: [DONE]\n\n");
            })(),
          };
        }
      }
      return healthyStream(`${memberId} answers`);
    };

    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: NO_RETRY,
      poolLoadBalancingGate: () => true,
    });
    const server = createOpenAIRelayServer(deps);
    const { port, close } = await listenLoopback(server, 0);
    const deadline = (promise, ms, message) => Promise.race([
      promise,
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error(message)), ms);
        t.unref?.();
      }),
    ]);
    const post = () => postResponses(port, {
      path: "/openai/pool-x/v1/responses",
      model: "model-p",
    });
    try {
      const first = post();
      await deadline(aAtGate, 10000, "pool-m1 的首块未被管道取走——夹具失灵");
      assert.deepEqual(calls, ["pool-m1"], "首条请求落在 pool-m1，且 begin 已在出网前计数");

      const secondRes = await deadline(post(), 10000, "第二条请求未应答——在途的 pool-m1 没有抬高其负载分");
      assert.equal(secondRes.status, 200);
      const secondText = await secondRes.text();
      assert.ok(secondText.includes("pool-m2 answers"), `m1 在途时新请求必须避开 m1（拿到：${secondText.slice(0, 80)}）`);
      assert.deepEqual(calls, ["pool-m1", "pool-m2"]);

      releaseA();
      const firstRes = await deadline(first, 10000, "放行后首条请求未收尾");
      assert.equal(firstRes.status, 200);
      await firstRes.text();

      const thirdRes = await deadline(post(), 10000, "第三条请求未应答");
      assert.equal(thirdRes.status, 200);
      const thirdText = await thirdRes.text();
      assert.ok(thirdText.includes("pool-m1 answers"), "m1 收尾归还计数后必须重新成为选头（endMember 未接线时这里会继续避开 m1）");
      assert.deepEqual(calls, ["pool-m1", "pool-m2", "pool-m1"]);
    } finally {
      releaseA();
      await close();
    }
  });
});
