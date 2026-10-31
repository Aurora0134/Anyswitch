import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRelayServer, listenLoopback } from "./openai-server.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";

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
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          const enc = new TextEncoder();
          yield enc.encode('data: {"id":"1","choices":[{"delta":{}}]}\n\n');
          // Slow upstream: the empty-stream verdict would land ~200ms in, but
          // the coding agent walks away first (ask-user confirmation pause).
          await new Promise((r) => setTimeout(r, 200));
          yield enc.encode("data: [DONE]\n\n");
        })(),
      };
    };
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = createMockDeps({ upstreamFetch, metricsCollector: collector });

    await withServer(deps, async (port) => {
      const ac = new AbortController();
      const resPromise = postChatStream(port, ac.signal);
      // Abort while the upstream is still mid-stream, before any verdict.
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      await resPromise.then(
        () => {},
        () => {},
      );
      // Let the relay finish the now client-less request cycle.
      await new Promise((r) => setTimeout(r, 300));

      assert.equal(callCount, 1, "no blind keep-alive retry against a dead client");

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.errorActive, false, "client-gone request must not latch a panel fault");
      assert.ok(!zcode.lastError || zcode.lastError.status !== 502, "no phantom 502 recorded");
    });
  });

  it("(d) client walks away during keep-alive backoff: aborted, no phantom 502 fault", async () => {
    // The empty-stream verdict landed, the relay entered the backoff sleep,
    // and the client left during it. The definitive outcome is "aborted",
    // not a 502 — the fault must latch only when retries are exhausted
    // while the client is still there. A long backoff (200ms) pins the
    // abort inside the sleep window deterministically.
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
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = {
      ...createMockDeps({ upstreamFetch, metricsCollector: collector }),
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 200 }),
    };

    await withServer(deps, async (port) => {
      const ac = new AbortController();
      const resPromise = postChatStream(port, ac.signal);
      // First (empty) attempt resolves in ~1ms with the fast mock; the relay
      // then sleeps 200ms before the retry. Abort at +15ms — mid-backoff.
      await new Promise((r) => setTimeout(r, 15));
      ac.abort();
      await resPromise.then(
        () => {},
        () => {},
      );
      // Let the backoff window elapse so a broken implementation would have
      // fired the retry and latched the exhaustion 502 by now.
      await new Promise((r) => setTimeout(r, 400));

      assert.equal(callCount, 1, "no retry against a departed client");

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.errorActive, false, "abort-during-backoff must not latch a fault");
      assert.ok(!zcode.lastError || zcode.lastError.status !== 502, "no phantom 502 recorded");
    });
  });
});
