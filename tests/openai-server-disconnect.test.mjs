import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRelayServer } from "../src/relay/openai-server.mjs";
import { createAgentMetricsCollector } from "../src/agents/agent-metrics.mjs";
import { listenLoopback } from "../test-helpers/loopback.mjs";

const TOKEN = "test-token-disconnect";

const STORE = {
  version: 2,
  providers: {
    "test-prov": {
      displayName: "Test Provider",
      baseURL: "https://upstream.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "test.dpapi",
      models: { "gpt-test": { displayName: "GPT Test" } },
    },
  },
};

function createMockDeps({ upstreamFetch, metricsCollector }) {
  return {
    token: TOKEN,
    loadStore: () => ({ ok: true, store: STORE }),
    loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
    upstreamFetch,
    recordGeneration: () => {},
    readGeneration: () => null,
    getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
    metricsCollector,
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

function sseStream(chunks) {
  return (async function* () {
    const enc = new TextEncoder();
    for (const c of chunks) yield enc.encode(c);
  })();
}

function postChatStream(port, signal) {
  return fetch(`http://127.0.0.1:${port}/openai/test-prov/v1/chat/completions`, {
    method: "POST",
    // 显式端点身份：本文件断言挂在（旧默认兜底桶）zcode 卡上；四通道
    // 全落空现在是「无归属不显示」，裸请求不再计到任何卡片。
    headers: { authorization: TOKEN, "content-type": "application/json", "x-agent-id": "zcode" },
    body: JSON.stringify({
      model: "gpt-test",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
    signal,
  });
}

describe("client disconnect detection (ask-user pause false-502 fix)", () => {
  it("(a) client aborting mid-stream records aborted, not a latched 502 fault", async () => {
    const ac = new AbortController();
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });

    // The abort arrives while upstream is still open: the generator parks
    // forever after one chunk. An async generator has no cancel(), so
    // pipeGuardedStream's cancelUpstream is a no-op here — the "upstream
    // actually cancelled through the owning reader" claim is (e)'s job, on a
    // real web ReadableStream. This fixture pins the accounting side: the
    // res-close handler must settle the tracker as aborted (activeRequests
    // back to 0) and latch nothing.
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        const enc = new TextEncoder();
        yield enc.encode('data: {"id":"1","choices":[{"delta":{"content":"partial"}}]}\n\n');
        await new Promise(() => {});
      })(),
    });

    const deps = createMockDeps({ upstreamFetch, metricsCollector: collector });

    await withServer(deps, async (port) => {
      const res = await postChatStream(port, ac.signal);
      assert.equal(res.status, 200);
      // Wait until the first chunk is out and the generator is parked on our promise.
      await new Promise((r) => setTimeout(r, 50));
      // The client walks away (coding agent enters ask-user confirmation pause).
      ac.abort();
      // Give the relay a moment to observe res close and cancel upstream.
      await new Promise((r) => setTimeout(r, 100));

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.errorActive, false, "client abort must not latch a panel fault");
      assert.ok(!zcode.lastError || zcode.lastError.status !== 502, "no phantom 502 recorded");
      // The "records aborted" half of the title: the res-close handler ran
      // tracker.recordEnd({aborted:true}) and the in-flight request settled.
      // Without an abort (or with the aborted bookkeeping dropped) the tracker
      // never sees an end and activeRequests stays 1 — this line is what makes
      // the title observable.
      assert.equal(zcode.metrics.activeRequests, 0, "abort must settle the in-flight request via recordEnd({aborted:true})");
    });
  });

  it("(e) ESC on a locked web stream: no unhandled rejection, upstream actually cancelled", async () => {
    // Production upstream bodies are web ReadableStreams (undici fetch). The
    // pipe holds the stream lock while reading; the old stream-level cancel()
    // in the res-close handler rejected with ERR_INVALID_STATE("ReadableStream
    // is locked") on Node 24, escaped the try/catch as an unhandledRejection,
    // and killed the relay process the moment a client pressed ESC mid-stream.
    let upstreamCancelled = false;
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    const enc = new TextEncoder();
    let ctrl;
    const body = new ReadableStream({
      start(c) {
        ctrl = c;
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    ctrl.enqueue(enc.encode('data: {"id":"1","choices":[{"delta":{"content":"partial"}}]}\n\n'));
    // Stream stays open: upstream is mid-think when the client walks away.

    const upstreamFetch = async () => ({ ok: true, status: 200, body });
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = createMockDeps({ upstreamFetch, metricsCollector: collector });

    try {
      await withServer(deps, async (port) => {
        const ac = new AbortController();
        const res = await postChatStream(port, ac.signal);
        assert.equal(res.status, 200);
        // Wait until the pipe is parked on a pending read (stream locked).
        await new Promise((r) => setTimeout(r, 50));
        ac.abort();
        // Give the relay a moment to observe res close and cancel upstream.
        await new Promise((r) => setTimeout(r, 100));

        assert.equal(upstreamCancelled, true, "upstream must be cancelled through the owning reader");

        const status = await collector.getAgentsStatus();
        const zcode = status.find((a) => a.id === "zcode");
        assert.equal(zcode.errorActive, false, "client abort must not latch a panel fault");
      });
      // Let any stray rejection surface before asserting.
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(rejections, [], "client abort must not leak an unhandled rejection");
    } finally {
      process.removeListener("unhandledRejection", onRejection);
    }
  });

  it("(b) healthy request that completes normally records success and settles the tracker", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"1","choices":[{"delta":{"content":"hello"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    });
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = createMockDeps({ upstreamFetch, metricsCollector: collector });

    await withServer(deps, async (port) => {
      const res = await postChatStream(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("hello"));

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.errorActive, false);
      // One request is counted exactly once — totalRequests only ever moves at
      // request start, so this guards the request-start ledger, not the end
      // bookkeeping.
      assert.equal(zcode.metrics.totalRequests, 1);
      // Healthy completion settles the in-flight request: the pass path ran
      // recordEnd({usage}) before the response tail reached the client, so the
      // tracker is back to zero. A dropped end bookkeeping would leave 1.
      assert.equal(zcode.metrics.activeRequests, 0, "normal completion must settle the in-flight request");
    });
  });

  it("(c) slow empty upstream + client aborts mid-wait: aborted, no 502 latch, no blind retry", async () => {
    // 用闸门取代固定睡眠抢占：空流判定被闸在「客户端已离开」之后，abort 必然
    // 落在管道停驻等下一块上游数据的中途——「判定落在中止之前」的时序抖动被
    // 消灭。此前 50ms/200ms 双定时器在慢机器上会换序，分支未真正执行也仍绿。
    let callCount = 0;
    let releaseUpstream;
    const gate = new Promise((resolve) => { releaseUpstream = resolve; });
    let pipeParked;
    const pipeParkedAtGate = new Promise((resolve) => { pipeParked = resolve; });
    const upstreamFetch = async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          const enc = new TextEncoder();
          yield enc.encode('data: {"id":"1","choices":[{"delta":{}}]}\n\n');
          // 管道取走首块后会来拉第二块——此时它已停驻在等上游数据的途中。
          pipeParked();
          await gate;
          yield enc.encode("data: [DONE]\n\n");
        })(),
      };
    };
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = createMockDeps({ upstreamFetch, metricsCollector: collector });

    await withServer(deps, async (port) => {
      const ac = new AbortController();
      const resPromise = postChatStream(port, ac.signal);
      // 确定性同步：管道停驻在等第二块上游数据的途中（空流判定必然未发生）。
      await pipeParkedAtGate;
      // 客户端离开（ask-user confirmation pause），然后放行上游——空流判定落
      // 在一个已经消失的客户端头上。
      ac.abort();
      releaseUpstream();
      await resPromise.then(
        () => {},
        () => {},
      );
      // 放行后的判定链是同步级联，留一个宏任务余量让记账落地；这不是竞速。
      await new Promise((r) => setTimeout(r, 100));

      assert.equal(callCount, 1, "no blind keep-alive retry against a dead client");

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.errorActive, false, "client-gone request must not latch a panel fault");
      assert.ok(!zcode.lastError || zcode.lastError.status !== 502, "no phantom 502 recorded");
    });
  });

  it("(d) client walks away during keep-alive backoff: aborted, no phantom 502 fault", async () => {
    // 同步点挂 deps.computeRetryDelay 注入缝：relay 进退避睡眠前必在同一同步
    // 块内先算退避再 sleep，回调触发即证明睡眠已开启（中途的 retrying 日志行
    // 已随方案甲「按请求收口」移除，注入缝是仅剩的确定性观测点）。退避取
    // 5000ms，截止线 2000ms 夹在两者之间：中止截断睡眠时请求毫秒级收尾；
    // 截断失守时要等满 5000ms，截止线变红。
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"1","choices":[{"delta":{}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };
    let backoffEntered;
    const backoffGate = new Promise((resolve) => { backoffEntered = resolve; });
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = {
      ...createMockDeps({ upstreamFetch, metricsCollector: collector }),
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 5000 }),
      computeRetryDelay: (backoff) => {
        backoffEntered();
        return backoff;
      },
    };

    await withServer(deps, async (port) => {
      const ac = new AbortController();
      const resPromise = postChatStream(port, ac.signal);
      // 等到「进入退避」的回调触发——这是睡眠已开启的确定性信号。
      await Promise.race([
        backoffGate,
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error("relay never entered the keep-alive backoff — fixture broken")), 10000);
          t.unref?.();
        }),
      ]);
      ac.abort();
      // 中止应立刻截断退避睡眠并收尾；若实现忽视退避中的中止，请求要等满
      // 5000ms，截止线（2000ms）先红。
      await Promise.race([
        resPromise.then(() => {}, () => {}),
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error("the request outlived the 2s deadline — the abort did not cut the backoff short")), 2000);
          t.unref?.();
        }),
      ]);
      // 退避从未完整走完，重试无从发生；留一个宏任务余量让记账落地。
      await new Promise((r) => setTimeout(r, 100));

      assert.equal(callCount, 1, "no retry against a departed client");

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.errorActive, false, "abort-during-backoff must not latch a fault");
      assert.ok(!zcode.lastError || zcode.lastError.status !== 502, "no phantom 502 recorded");
    });
  });
});
