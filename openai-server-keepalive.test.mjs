import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRelayServer, listenLoopback } from "./openai-server.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";

const TOKEN = "test-token-keepalive";

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

function createMockDeps({ upstreamFetch, getKeepAliveConfig, metricsCollector }) {
  return {
    token: TOKEN,
    loadStore: () => ({ ok: true, store: STORE }),
    loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
    upstreamFetch,
    recordGeneration: () => {},
    readGeneration: () => null,
    getKeepAliveConfig,
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

function postChat(port, { signal } = {}) {
  return fetch(`http://127.0.0.1:${port}/openai/test-prov/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-test",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
    signal,
  });
}

function sseStream(chunks) {
  return (async function* () {
    const enc = new TextEncoder();
    for (const c of chunks) yield enc.encode(c);
  })();
}

describe("openai relay keep-alive anti-truncation", () => {
  it("(a) recovers on empty stream via 1 keep-alive retry and delivers successful stream to client", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        // First attempt: clean empty stream (no text deltas)
        return {
          ok: true,
          status: 200,
          body: sseStream([
            'data: {"id":"1","choices":[{"delta":{}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      }
      // Second attempt: healthy stream
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"2","choices":[{"delta":{"content":"recovered text"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered text"), "client must receive healthy payload from retried stream");
      assert.equal(callCount, 2, "upstream should have been called twice (1 retry)");

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.errorActive, false, "first chunk of successful stream clears fault latch");
      assert.equal(zcode.metrics.keepAlive.retries, 1, "keepAlive retries counter incremented");
      assert.equal(zcode.metrics.keepAlive.recoveries, 1, "keepAlive recoveries counter incremented");

      const stability = await collector.getModelStability();
      const m = stability.models.find((x) => x.model === "gpt-test");
      assert.ok(m, "model-stability should include the retried model");
      assert.equal(m.total, 2, "the failed attempt must also count toward call volume");
      assert.equal(m.successRate, 50.0, "success rate must reflect the absorbed failure");
    });
  });

  it("(b) exhausts retries when all attempts return empty stream, returns 502 and keeps fault latched", async () => {
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
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error.type, "api_error");
      assert.match(body.error.message, /模型未返回任何内容/);
      assert.match(body.error.message, /保活重试已耗尽/, "a spent retry budget may claim exhaustion");
      assert.equal(callCount, 2, "initial attempt + 1 retry = 2 calls");

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.errorActive, true, "fault must stay latched on panel until next genuine first chunk");
      assert.equal(zcode.metrics.keepAlive.retries, 1);
      assert.equal(zcode.metrics.keepAlive.exhausted, 1);

      const stability = await collector.getModelStability();
      const m = stability.models.find((x) => x.model === "gpt-test");
      assert.ok(m, "model-stability should include the exhausted model");
      assert.equal(m.total, 2, "both exhausted attempts must count");
      assert.equal(m.successRate, 0.0, "success rate must be zero when all attempts failed");
    });
  });

  it("(b2) silently retries a transient upstream 5xx and counts the failed attempt in stability", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: false,
          status: 503,
          body: { error: { message: "upstream unavailable" } },
        };
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"2","choices":[{"delta":{"content":"recovered after 503"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered after 503"), "client must receive the retried stream");
      assert.equal(callCount, 2, "upstream 503 must be silently retried once");

      const stability = await collector.getModelStability();
      const m = stability.models.find((x) => x.model === "gpt-test");
      assert.ok(m, "model-stability should include the retried model");
      assert.equal(m.total, 2, "the 503 attempt and the successful retry both count");
      assert.equal(m.successRate, 50.0, "success rate must reflect the absorbed 503 failure");
    });
  });

  it("(c) does NOT retry when keepAlive is disabled via config", async () => {
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
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: false, maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.match(body.error.message, /未配置重试/, "zero-retry exhaustion must not claim a spent budget");
      assert.doesNotMatch(body.error.message, /已耗尽/);
      assert.equal(callCount, 1, "zero retry when enabled:false");

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.metrics.keepAlive.exhausted, 0, "nothing was exhausted when no retry budget existed");
      assert.equal(zcode.metrics.keepAlive.retries, 0);
    });
  });

  it("(d) does NOT retry when stream was already committed (bytes delivered mid-response)", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          const enc = new TextEncoder();
          yield enc.encode('data: {"id":"1","choices":[{"delta":{"content":"partial content"}}]}\n\n');
          // Then abrupt socket throw mid-stream
          throw new Error("upstream socket died");
        })(),
      };
    };

    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200, "headers were already sent 200");
      const text = await res.text();
      assert.ok(text.includes("partial content"));
      assert.ok(text.includes("the upstream stream failed mid-response"));
      assert.equal(callCount, 1, "must NOT retry once bytes were already committed to client");
    });
  });

  it("(f) retries when a gateway keep-alive `data:` line precedes an otherwise-empty stream", async () => {
    // Production bypass shape: an empty `data:` ping line used to disarm the
    // stream guard, so the truncated stream looked like a normal completion
    // and the retry never fired. It must be classified empty and retried.
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          body: sseStream([
            "data:\n\n",
            'data: {"id":"1","choices":[{"delta":{}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"2","choices":[{"delta":{"content":"recovered text"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered text"), "client must receive the retried stream's payload");
      assert.ok(!text.includes("[DONE]\n\ndata:"), "no duplicated terminator from the failed attempt");
      assert.equal(callCount, 2, "empty-ping stream must trigger the keep-alive retry");

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.metrics.keepAlive.retries, 1);
      assert.equal(zcode.metrics.keepAlive.recoveries, 1);
      assert.equal(zcode.errorActive, false);
      assert.ok(!zcode.lastError, "a recovered request must not leave a stale fault entry");
    });
  });

  it("(e) immediately halts retry loop when client disconnects/aborts during backoff", async () => {
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

    const ac = new AbortController();
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 2, backoffMs: 200 }),
    });

    await withServer(deps, async (port) => {
      const p = postChat(port, { signal: ac.signal });
      // Abort quickly after first call settles
      setTimeout(() => ac.abort(), 20);
      try {
        await p;
      } catch {
        /* client abort error expected */
      }
      assert.equal(callCount, 1, "must not perform subsequent retries after client aborts");
    });
  });
});

describe("plan A: whole-turn hold in enhanced mode", () => {
  it("(A1) retries a mid-word truncation after reasoning and delivers the healthy retry verbatim", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        // reasoning-first stream cut mid-word: no [DONE], no finish_reason
        return {
          ok: true,
          status: 200,
          body: sseStream([
            'data: {"id":"1","choices":[{"delta":{"role":"assistant","reasoning_content":"thinking"}}]}\n\n',
            'data: {"id":"1","choices":[{"delta":{"content":"partial answ"}}]}\n\n',
          ]),
        };
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"2","choices":[{"delta":{"role":"assistant","reasoning_content":"thinking"}}]}\n\n',
          'data: {"id":"2","choices":[{"delta":{"content":"full answer"}}]}\n\n',
          'data: {"id":"2","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "enhanced", maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes("partial answ"), "the truncated attempt must never reach the client");
      assert.ok(text.includes("full answer"), "the retried turn is delivered");
      assert.ok(text.includes("[DONE]"), "the retried turn terminates cleanly");
      assert.equal(callCount, 2);

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.metrics.keepAlive.retries, 1);
      assert.equal(zcode.metrics.keepAlive.recoveries, 1);
      assert.equal(zcode.errorActive, false);
    });
  });

  it("(A2) exhausts retries on repeated mid-word truncation; delivers a structured SSE error, not a silent close", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"1","choices":[{"delta":{"reasoning_content":"r"}}]}\n\n',
        'data: {"id":"1","choices":[{"delta":{"content":"cut mid"}}]}\n\n',
      ]),
    });

    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "enhanced", maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200, "headers were already committed by pings; the error must ride SSE");
      const text = await res.text();
      assert.ok(!text.includes("cut mid"), "truncated bytes must not leak");
      assert.ok(text.includes('"error"'), "a structured error event replaces the turn");
      assert.ok(!/\ndata: \[DONE\]/.test(text), "no bare [DONE] terminator line may ride along");
      assert.equal(text.trim().startsWith(":") || text.includes(": ping") || text.includes("data:"), true);

      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.errorActive, true, "exhaustion must latch the panel fault");
      assert.equal(zcode.metrics.keepAlive.exhausted, 1);
    });
  });

  it("(A3) healthy reasoning-first turn passes through with content intact (no regression in enhanced mode)", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"1","choices":[{"delta":{"role":"assistant","reasoning_content":"think"}}]}\n\n',
          'data: {"id":"1","choices":[{"delta":{"content":"hello"}}]}\n\n',
          'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "enhanced", maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("reasoning_content"));
      assert.ok(text.includes("hello"));
      assert.ok(text.includes("[DONE]"));
      assert.equal(callCount, 1, "healthy turns must not be retried");
      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.metrics.keepAlive.retries, 0);
    });
  });

  it("(A1b) enhanced mode retries a truncated JSON data line and does not forward it", async () => {
    let callCount = 0;
    const truncated =
      'data: {"choices":[{"delta":{"reasoning_content":" DNS","role":"assistant"},"index":0}],"created":1,"id":"x","model":"glm-5.3","object":"chat.completion.chunk"\n\n';
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          body: sseStream([
            truncated,
            'data: {"id":"1","choices":[{"delta":{"content":"hello"}}]}\n\n',
            'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"2","choices":[{"delta":{"content":"recovered text"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "enhanced", maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });
    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes("chat.completion.chunk"), "truncated JSON line must not reach the client");
      assert.ok(text.includes("recovered text"));
      assert.equal(callCount, 2);
    });
  });

  it("(A3b) enhanced-mode empty stream still retries and recovers despite ping-committed headers", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          body: sseStream([
            'data: {"id":"1","choices":[{"delta":{}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"2","choices":[{"delta":{"content":"recovered text"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "enhanced", maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });
    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered text"), "client must receive the retried healthy payload");
      assert.equal(callCount, 2, "ping-committed headers must not block keep-alive retry");
      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      assert.equal(zcode.metrics.keepAlive.retries, 1);
      assert.equal(zcode.metrics.keepAlive.recoveries, 1);
    });
  });

  it("(A4) enhanced-mode empty_stream exhaustion rides SSE error (headers committed by pings)", async () => {
    // Plan-A semantics: in enhanced mode the SSE headers are committed by the
    // first keep-alive ping, so even an empty-stream exhaustion can no longer
    // return a 5xx JSON body — the definitive error rides an SSE data line.
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
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "enhanced", maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });
    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200, "ping-committed headers force SSE delivery");
      const text = await res.text();
      assert.ok(text.includes('"error"'));
      assert.match(text, /模型未返回任何内容/);
      assert.equal(callCount, 2);
    });
  });

  it("(A5) enhanced mode timestamps the upstream first token so TPS measures the generation segment", async () => {
    // Whole-turn hold defers the client delivery to the verdict flush, but the
    // tracker must still timestamp the upstream first token: TPS = completion
    // over the generation segment (first token → end), not over the whole
    // request (which would fold the TTFT into the denominator and understate
    // the speed by the TTFT share).
    let fakeNow = 1000;
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        const enc = new TextEncoder();
        await new Promise((r) => setTimeout(r, 25)); // ordering only; the clock is fakeNow
        fakeNow += 400; // upstream TTFT (queue + prefill)
        yield enc.encode('data: {"id":"1","choices":[{"index":0,"delta":{"content":"hello world"}}]}\n\n');
        await new Promise((r) => setTimeout(r, 25));
        fakeNow += 300; // generation segment
        yield enc.encode('data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\n');
        yield enc.encode("data: [DONE]\n\n");
      })(),
    });
    const collector = createAgentMetricsCollector({ nowFn: () => fakeNow, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "enhanced", maxRetries: 1, backoffMs: 10 }),
      metricsCollector: collector,
    });
    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      await res.text();
      const status = await collector.getAgentsStatus();
      const zcode = status.find((a) => a.id === "zcode");
      // 20 tokens over a 300ms generation segment → ~66.7 tok/s. The
      // pre-fix regression measured over the whole 700ms request → 28.6.
      assert.ok(Math.abs(zcode.metrics.tps - 66.7) < 1, `tps must reflect the generation segment, got ${zcode.metrics.tps}`);
      assert.ok(Math.abs(zcode.metrics.lastTtftMs - 400) < 5, `ttft must reflect the upstream first token, got ${zcode.metrics.lastTtftMs}`);
    });
  });
});
