// 常驻前端的 Anthropic 通道接线验收（/v1/messages，createOpenAIRelayServer）：
// auto 链的流式分支与 4xx 节点级分类（此前常驻 anthropic 只有一条非流式 503）、
// 直连池的对照口径（池把 4xx 当请求错误透传，不退避）、智能分流在途计数在
// anthropic 流式生成形态下的抬升/归还、per-endpoint 抗截断开关的 agentId 接线
// （常驻 + per-launch 两条 anthropic 通道）。
// 真实回环 socket + 合成 store + mock 上游。无真实凭据、无真实出网、无 DPAPI。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRelayServer } from "../src/relay/openai-server.mjs";
import { createRelayServer } from "../src/relay/server.mjs";
import { createEffortInjector } from "../src/catalog/effort-injection.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";
import { listenLoopback } from "../test-helpers/loopback.mjs";

const envRoot = mkTestDir("anyswitch-anthropic-resident-chain-env-");
process.env.LOCALAPPDATA = envRoot;
process.env.APPDATA = envRoot;
process.env.USERPROFILE = envRoot;

const TOKEN = "test-token-anthropic-resident-chain";

const OFF_EFFORT_INJECTOR = () => createEffortInjector({ isEnabled: () => false });

// 链挂 kimi（常驻 anthropic 上 x-agent-id: kimi 的显式白名单身份）：chan-a → chan-b。
// 池 pool-x 两成员都带 pool-model，供直投池对照与在途计数用。
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
  },
  pools: {
    "pool-x": { displayName: "Pool X", members: ["member-a", "member-b"] },
  },
  routingChains: {
    kimi: { chain: [{ node: "chan-a", model: "model-a" }, { node: "chan-b", model: "model-b" }] },
  },
};

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

function createMockDeps({ upstreamFetch, store = STORE, getKeepAliveConfig, poolLoadBalancingGate = () => false, ...extra } = {}) {
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
    ...extra,
  };
}

async function withResident(deps, fn) {
  const server = createOpenAIRelayServer(deps);
  const { port, close } = await listenLoopback(server, 0);
  try {
    return await fn(port);
  } finally {
    await close();
  }
}

async function withPerLaunch(deps, fn) {
  const server = createRelayServer(deps);
  const { port, close } = await listenLoopback(server, 0);
  try {
    return await fn(port);
  } finally {
    await close();
  }
}

function postMessages(port, { model = "auto", stream = true, headers = {} } = {}) {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json", "x-agent-id": "kimi", ...headers },
    body: JSON.stringify({ model, max_tokens: 64, stream, messages: [{ role: "user", content: "hi" }] }),
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

function nonStreamOk(text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }),
  };
}

const EMPTY_CHAT_SSE = [
  'data: {"id":"1","choices":[{"delta":{}}]}\n\n',
  "data: [DONE]\n\n",
];

const NO_RETRY = () => ({ enabled: true, maxRetries: 0, backoffMs: 10 });

describe("常驻 anthropic 的 auto 链：流式分支", () => {
  it("(5xx) 链头 503 退避到第二个节点，客户端收到完整的 Anthropic SSE", async () => {
    const { upstreamFetch, calls, bodies } = memberRouter({
      "chan-a": () => statusError(503),
      "chan-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withResident(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      // 流式分支（anthropicStreamChannel + callUpstreams）真正驱动扇出：
      // 客户端拿到的是翻译回 Anthropic 形态的事件序列。
      assert.ok(text.includes("event: message_start"), "回程必须是 Anthropic SSE");
      assert.ok(text.includes("recovered on B"), "退避后节点的内容透传");
      assert.ok(text.includes("event: message_stop"), "回合正常收束");
      assert.ok(!text.includes("event: error"), "首字前的退避对客户端不可见");
      assert.deepEqual(calls, ["chan-a", "chan-b"]);
      assert.equal(bodies[1].model, "model-b", "第二个节点发自己绑定的模型");
    });
  });

  it("(400) 流式分支同样把上游 4xx 当节点级故障退避", async () => {
    // auto 的模型是链自己绑的：上游 400 只能归因于节点。isFailoverStatus 在
    // 常驻 anthropic 通道必须取链口径——退回池口径（4xx 透传）时这里红。
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => statusError(400),
      "chan-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withResident(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on B"));
      assert.deepEqual(calls, ["chan-a", "chan-b"], "链口径：任意上游 4xx 都退避到下一节点（流式分支同样生效）");
    });
  });

  it("(400) 非流式分支的 4xx 节点级退避", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "chan-a": () => statusError(400),
      "chan-b": () => nonStreamOk("recovered on B"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withResident(deps, async (port) => {
      const res = await postMessages(port, { stream: false });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.content[0].text, "recovered on B");
      assert.deepEqual(calls, ["chan-a", "chan-b"]);
    });
  });

  it("(对照) 直连池的上游 4xx 是请求错误：透传，不退避到下一成员", async () => {
    // 同一条 isFailoverStatus 接线的另一分支：池口径下 400/404 是请求形状，
    // 末成员之前也不得越过。两个分支互为反证——把池口径误换成链口径时这里红。
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => statusError(400),
      "member-b": () => nonStreamOk("must never be sent"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withResident(deps, async (port) => {
      const res = await postMessages(port, { model: "anthropic/pool-x/pool-model", stream: false });
      assert.equal(res.status, 400, "请求形状的 4xx 原样透传给客户端");
      assert.deepEqual(calls, ["member-a"], "池口径不得把请求错误当节点故障退避");
    });
  });
});

describe("常驻 anthropic 流式通道的智能分流在途计数（onMemberBegin/onMemberEnd）", () => {
  // 判据是选头行为本身（与 responses/chat 通道的在途用例同构）：a 在途时新
  // 请求避开 a；a 收尾归还计数后新请求落回 a。
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
      if (memberId === "member-a") {
        aCalls += 1;
        if (aCalls === 1) {
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
    const post = () => postMessages(port, { model: "anthropic/pool-x/pool-model", stream: true });
    try {
      const first = post();
      await deadline(aAtGate, 10000, "member-a 的首块未被管道取走——夹具失灵");
      assert.deepEqual(calls, ["member-a"], "首条请求落在 member-a，且 begin 已在出网前计数");

      const secondRes = await deadline(post(), 10000, "第二条请求未应答——在途的 member-a 没有抬高其负载分");
      assert.equal(secondRes.status, 200);
      const secondText = await secondRes.text();
      assert.ok(secondText.includes("member-b answers"), `a 在途时新请求必须避开 a（拿到：${secondText.slice(0, 80)}）`);
      assert.deepEqual(calls, ["member-a", "member-b"]);

      releaseA();
      const firstRes = await deadline(first, 10000, "放行后首条请求未收尾");
      assert.equal(firstRes.status, 200);
      await firstRes.text();

      const thirdRes = await deadline(post(), 10000, "第三条请求未应答");
      assert.equal(thirdRes.status, 200);
      const thirdText = await thirdRes.text();
      assert.ok(thirdText.includes("member-a answers"), "a 收尾归还计数后必须重新成为选头（endMember 未接线时这里会继续避开 a）");
      assert.deepEqual(calls, ["member-a", "member-b", "member-a"]);
    } finally {
      releaseA();
      await close();
    }
  });
});

describe("anthropic 通道的 per-endpoint 抗截断开关（agentId 接线）", () => {
  // 开关形状：keepAlive.endpoints[agentId].enabled，按端点各自关断。两条
  // anthropic 通道传出的 agentId 必须是请求的真实端点身份：常驻通道传归属
  // 判定结果（x-agent-id/UA），per-launch 通道传 deps.agentId（kimi 中继绝不
  // 能读到 claude 的开关位）。
  function emptyStreamUpstream(counter) {
    return async () => {
      counter.calls += 1;
      if (counter.calls === 1) {
        return { ok: true, status: 200, body: sseStream(EMPTY_CHAT_SSE) };
      }
      return healthyStream("recovered on retry");
    };
  }

  it("常驻通道：kimi 被单独关断时空流不重试；名单外的端点照常重试", async () => {
    // 两个场景各自起服务、各自计数：上游「首次空转、其后恢复」的样本是按
    // 请求计数的，共用一个计数器会把第二场景的首空流吃掉。
    const runEmptyStreamScenario = async (endpoints, headers) => {
      const counter = { calls: 0 };
      const deps = createMockDeps({
        upstreamFetch: emptyStreamUpstream(counter),
        getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10, endpoints }),
      });
      return withResident(deps, async (port) => {
        const res = await postMessages(port, { model: "anthropic/chan-a/model-a", headers });
        const text = await res.text();
        return { status: res.status, text, calls: counter.calls };
      });
    };

    const off = await runEmptyStreamScenario({ kimi: { enabled: false } }, {});
    assert.equal(off.status, 502);
    assert.equal(off.calls, 1, "端点开关关掉后保活预算归零：不得重试");

    // 名单外（claude）的请求继承主开关：同一条空流重试并恢复。身份必须按
    // 请求归属判定取——写死或恒置 null 时这个场景不可能重试。
    const inheriting = await runEmptyStreamScenario({ kimi: { enabled: false } }, { "x-agent-id": "claude" });
    assert.equal(inheriting.status, 200);
    assert.ok(inheriting.text.includes("recovered on retry"));
    assert.equal(inheriting.calls, 2, "名单外端点继承主开关：首空流 + 一次重试");
  });

  it("per-launch 通道：kimi 中继读 kimi 的开关位", async () => {
    const counter = { calls: 0 };
    const deps = createMockDeps({
      upstreamFetch: emptyStreamUpstream(counter),
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10, endpoints: { kimi: { enabled: false } } }),
      agentId: "kimi",
    });

    await withPerLaunch(deps, async (port) => {
      const off = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ model: "anthropic/chan-a/model-a", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(off.status, 502);
      assert.equal(counter.calls, 1, "per-launch 中继必须按自己的端点身份解析开关");
    });
  });
});
