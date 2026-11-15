// 智能分流（poolLoadBalancing）的会话亲和键接线：server 侧把每请求身份
// （requestInstanceId）传进池/链规划，负载均衡器用它把同一会话钉在同一个
// 成员上。此前只有算法/规划层测试（pool-load-balancing 的 plan-mode 用例），
// 接线本身无人守——把每请求身份换成固定 endpoint id，规划层测试全绿。
//
// 每条用例的判据是选头行为本身（可观察的公共行为：上游调用顺序）：
//   r1（会话 A，全员空闲）落在 m1 → 亲和绑定 A→m1；
//   r0（无身份）落在 m1 并停驻（m1 在途=1）；
//   r2（会话 A）必须顶住负载分回到 m1（亲和把 m1 挪到队首）；
//   r3（会话 B）无亲和、避开在途的 m1 → 落 m2。
// 把身份换成固定键时 A/B 同键，r3 会被拖去 m1 —— 这里红。
// 覆盖四条前端：常驻 openai chat（x-agent-instance）、常驻 Responses
// （prompt_cache_key 派生的 codex-sess-<id>）、常驻 anthropic
// （x-agent-instance）、per-launch anthropic（会话键 = 端点 id，本进程即一会话）。
// 真实回环 socket + 合成 store + mock 上游。无真实凭据、无真实出网、无 DPAPI。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRelayServer } from "../src/relay/openai-server.mjs";
import { createRelayServer } from "../src/relay/server.mjs";
import { createEffortInjector } from "../src/catalog/effort-injection.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";
import { listenLoopback } from "../test-helpers/loopback.mjs";

const envRoot = mkTestDir("anyswitch-session-affinity-env-");
process.env.LOCALAPPDATA = envRoot;
process.env.APPDATA = envRoot;
process.env.USERPROFILE = envRoot;

const TOKEN = "test-token-session-affinity";

const OFF_EFFORT_INJECTOR = () => createEffortInjector({ isEnabled: () => false });

const STORE = {
  version: 2,
  providers: {
    "aff-m1": {
      displayName: "Affinity Member 1",
      baseURL: "http://aff-m1.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "aff-m1.dpapi",
      models: { "shared-model": { displayName: "Shared Model from 1" } },
    },
    "aff-m2": {
      displayName: "Affinity Member 2",
      baseURL: "http://aff-m2.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "aff-m2.dpapi",
      models: { "shared-model": { displayName: "Shared Model from 2" } },
    },
  },
  pools: {
    "aff-pool": { displayName: "Affinity Pool", members: ["aff-m1", "aff-m2"] },
  },
};

function createMockDeps({ upstreamFetch, poolLoadBalancingGate = () => true, ...extra } = {}) {
  return {
    token: TOKEN,
    loadStore: () => ({ ok: true, store: STORE }),
    loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
    upstreamFetch,
    recordGeneration: () => {},
    readGeneration: () => null,
    getKeepAliveConfig: () => ({ enabled: true, maxRetries: 0, backoffMs: 10 }),
    poolLoadBalancingGate,
    effortInjector: OFF_EFFORT_INJECTOR(),
    imageFallbackGate: () => false,
    imageHeuristicGate: () => false,
    ...extra,
  };
}

// 夹具收尾：先摘掉 undici fetch 留下的空闲 keep-alive 连接再 close，否则
// close() 要等客户端的 4s 空闲超时才返回（每条用例平白多挂 4 秒）。
async function withServer(server, fn) {
  const { port, close } = await listenLoopback(server, 0);
  try {
    return await fn(port);
  } finally {
    server.closeIdleConnections?.();
    await close();
  }
}

// 停驻型上游：aff-m1 的第二次调用（场景里的无身份 r0）交出首块后停在闸门前
//（在途计数保持抬起），其余调用立即完整应答——第一次调用是场景的 r1，必须
// 完整收尾才能把亲和绑定到 m1。releaseA 放行停驻；calls 记录上游调用顺序。
function parkedUpstream() {
  const calls = [];
  const enc = new TextEncoder();
  let releaseA;
  const parkedA = new Promise((resolve) => { releaseA = resolve; });
  let aParked;
  const aAtGate = new Promise((resolve) => { aParked = resolve; });
  let m1Calls = 0;
  const upstreamFetch = async (urls) => {
    const memberId = new URL(Array.isArray(urls) ? urls[0] : urls).host.split(".")[0];
    calls.push(memberId);
    if (memberId === "aff-m1" && (m1Calls += 1) === 2) {
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          yield enc.encode('data: {"id":"1","choices":[{"delta":{"content":"aff-m1 answers"}}]}\n\n');
          aParked();
          await parkedA;
          yield enc.encode('data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
          yield enc.encode("data: [DONE]\n\n");
        })(),
      };
    }
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        yield enc.encode(`data: {"id":"1","choices":[{"delta":{"content":${JSON.stringify(`${memberId} answers`)}}}],"index":0}\n\n`);
        yield enc.encode('data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n');
        yield enc.encode("data: [DONE]\n\n");
      })(),
    };
  };
  return { upstreamFetch, calls, releaseA, aAtGate };
}

// 同一批次的时序护栏：只把「接线断了会挂起的路径」变成响亮的失败，
// 不参与正常路径的判定。
function deadline(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(message)), ms);
      t.unref?.();
    }),
  ]);
}

// 四条通道共用的场景骨架。send(session) 发一条流式请求；session 为 null 表示
// 无身份请求。断言完全挂在 calls 顺序上。releaseA 挂在 finally：用例失败时也
// 必须放行停驻的上游调用，否则悬着的请求会挂死整个测试进程。
async function runAffinityScenario({ listen, send }) {
  const fx = parkedUpstream();
  return listen(fx, async (port) => {
    try {
      // r1：会话 A，全员空闲 → m1；成功后亲和绑定 A→m1。
      const r1 = await deadline(send(port, fx, "sess-A"), 10000, "r1 未应答——夹具失灵");
      assert.equal(r1.status, 200);
      await r1.text();

      // r0：无身份 → 选头 m1（索引序），停驻在闸门前，m1 在途计数抬起。
      const r0 = send(port, fx, null);
      await deadline(fx.aAtGate, 10000, "aff-m1 的首块未被管道取走——夹具失灵");
      assert.deepEqual(fx.calls, ["aff-m1", "aff-m1"], "r1 与 r0 都落在 aff-m1");

      // r2：会话 A 顶着更高的负载分回到 m1 —— 亲和必须压过最小负载排序。
      const r2 = await deadline(send(port, fx, "sess-A"), 10000, "r2 未应答——在途的 m1 没有抬高其负载分（begin 接线断）");
      assert.equal(r2.status, 200);
      await r2.text();

      // r3：会话 B 无亲和、避开在途的 m1 → m2。身份被换成固定键时
      // 亲和被 r2 拖到 m1，这里会拿到 m1 —— 红。
      const r3 = await deadline(send(port, fx, "sess-B"), 10000, "r3 未应答");
      assert.equal(r3.status, 200);
      await r3.text();

      assert.deepEqual(fx.calls, ["aff-m1", "aff-m1", "aff-m1", "aff-m2"],
        "会话 A 亲和钉回 m1，会话 B 无亲和避开在途的 m1 落到 m2");

      fx.releaseA(); // 放行停驻的 r0（finally 里的兜底放行对已决的 promise 无害）
      await deadline(r0, 10000, "放行后 r0 未收尾");
      const r0res = await r0;
      assert.equal(r0res.status, 200);
      await r0res.text();
    } finally {
      fx.releaseA();
    }
  });
}

describe("常驻 openai chat 通道：会话亲和键 = 每请求实例身份（x-agent-instance）", () => {
  function send(port, fx, session) {
    return fetch(`http://127.0.0.1:${port}/openai/aff-pool/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: TOKEN,
        "content-type": "application/json",
        "x-agent-id": "zcode",
        ...(session === null ? {} : { "x-agent-instance": session }),
      },
      body: JSON.stringify({ model: "shared-model", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
  }

  it("同会话钉回同一成员，不同会话各走各的", async () => {
    await runAffinityScenario({
      listen: async (fx, fn) => withServer(createOpenAIRelayServer(createMockDeps({ upstreamFetch: fx.upstreamFetch })), fn),
      send,
    });
  });
});

describe("常驻 Responses 通道：会话亲和键 = prompt_cache_key 派生的会话 id", () => {
  function send(port, fx, session) {
    return fetch(`http://127.0.0.1:${port}/openai/aff-pool/v1/responses`, {
      method: "POST",
      headers: { authorization: TOKEN, "content-type": "application/json", "x-agent-id": "codex" },
      body: JSON.stringify({
        model: "shared-model",
        input: "hi",
        stream: true,
        ...(session === null ? {} : { prompt_cache_key: session }),
      }),
    });
  }

  it("codex 会话（prompt_cache_key）各自钉在自己的成员上", async () => {
    await runAffinityScenario({
      listen: async (fx, fn) => withServer(createOpenAIRelayServer(createMockDeps({ upstreamFetch: fx.upstreamFetch })), fn),
      send,
    });
  });
});

describe("常驻 anthropic 通道：会话亲和键 = 每请求实例身份（x-agent-instance）", () => {
  function send(port, fx, session) {
    return fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: TOKEN,
        "content-type": "application/json",
        "x-agent-id": "kimi",
        ...(session === null ? {} : { "x-agent-instance": session }),
      },
      body: JSON.stringify({ model: "anthropic/aff-pool/shared-model", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
  }

  it("同会话钉回同一成员，不同会话各走各的", async () => {
    await runAffinityScenario({
      listen: async (fx, fn) => withServer(createOpenAIRelayServer(createMockDeps({ upstreamFetch: fx.upstreamFetch })), fn),
      send,
    });
  });
});

describe("per-launch anthropic 通道：会话亲和键 = 端点 id（本进程即一会话）", () => {
  // per-launch 中继服务单个端点的单个会话：sessionKey 恒为 deps.agentId，
  // 进程内所有请求共享一份亲和。判据：m1 在途时，同进程的下一条请求仍被
  // 亲和拖回 m1——会话键缺失（null）时最小负载会把它送去 m2，这里红。
  it("进程内请求共享同一份亲和，在途成员仍被亲和拉回", async () => {
    const fx = parkedUpstream();
    const server = createRelayServer(createMockDeps({ upstreamFetch: fx.upstreamFetch, agentId: "claude" }));
    await withServer(server, async (port) => {
      const send = () => fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ model: "anthropic/aff-pool/shared-model", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }),
      });

      // r1：全员空闲 → m1；成功后亲和绑定 claude→m1。
      const r1 = await deadline(send(), 10000, "r1 未应答——夹具失灵");
      assert.equal(r1.status, 200);
      await r1.text();

      // r0：同键 → 索引序仍选 m1，停驻，m1 在途计数抬起。
      const r0 = send();
      await deadline(fx.aAtGate, 10000, "aff-m1 的首块未被管道取走——夹具失灵");

      // r2：亲和把在途的 m1 拉回队首——没有会话键时这里必然改投 m2。
      const r2 = await deadline(send(), 10000, "r2 未应答");
      assert.equal(r2.status, 200);
      await r2.text();

      assert.deepEqual(fx.calls, ["aff-m1", "aff-m1", "aff-m1"],
        "per-launch 进程内请求共享同一会话身份：亲和必须把三条请求都钉在 m1");

      fx.releaseA();
      await deadline(r0, 10000, "放行后 r0 未收尾");
      const r0res = await r0;
      assert.equal(r0res.status, 200);
      await r0res.text();
    });
  });
});
