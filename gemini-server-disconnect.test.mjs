import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRelayServer, listenLoopback } from "./openai-server.mjs";
import { createAliasResolver } from "./antigravity-alias.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";
import { geminiStreamChannel } from "./stream-pipe.mjs";

const TOKEN = "test-token-gemini-disconnect";

// Two-member pool: member-a hangs (like a real pending upstream fetch),
// member-b would answer — proving the abort stops the failover cascade.
const STORE = {
  version: 2,
  providers: {
    "member-a": {
      displayName: "Member A",
      baseURL: "http://member-a.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "member-a.dpapi",
      models: { "gemini-x": { displayName: "Gemini X" } },
    },
    "member-b": {
      displayName: "Member B",
      baseURL: "http://member-b.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "member-b.dpapi",
      models: { "gemini-x": { displayName: "Gemini X B" } },
    },
  },
  pools: { "test-pool": { displayName: "Test Pool", members: ["member-a", "member-b"] } },
};

const aliasResolver = createAliasResolver({
  filePath: "mock-nonexistent-gemini-disconnect.json",
  overlay: { "gemini-3.7-flash": "test-pool/gemini-x" },
});

const NO_RETRY = () => ({ enabled: true, maxRetries: 0, backoffMs: 10 });

function createMockDeps({ upstreamFetch, metricsCollector }) {
  return {
    token: TOKEN,
    loadStore: () => ({ ok: true, store: STORE }),
    loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
    upstreamFetch,
    aliasResolver,
    getKeepAliveConfig: NO_RETRY,
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

function postGenerate(port, signal, { stream = false } = {}) {
  const method = stream ? "streamGenerateContent" : "generateContent";
  return fetch(`http://127.0.0.1:${port}/v1beta/models/gemini-3.7-flash:${method}`, {
    method: "POST",
    headers: { "x-goog-api-key": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    signal,
  });
}

function sseStream(chunks) {
  const enc = new TextEncoder();
  return (async function* () {
    for (const c of chunks) yield enc.encode(c);
  })();
}

// An upstream that parks for `ms` and honors init.signal exactly like a real
// fetch: the abort rejects the pending attempt so the handler's rethrow-on-
// abort path (the fix under test) is exercised for real.
function hangingUpstream(ms) {
  return (urls, init) =>
    new Promise((resolve, reject) => {
      const url = Array.isArray(urls) ? urls[0] : urls;
      const memberId = new URL(url).host.split(".")[0];
      const timer = setTimeout(() => {
        resolve({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: `late ${memberId}` } }] }),
          body: sseStream([`data: {"id":"1","choices":[{"delta":{"content":"late ${memberId}"}}]}\n\n`, "data: [DONE]\n\n"]),
        });
        init?.signal?.removeEventListener("abort", onAbort);
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(init.signal.reason ?? new Error("This operation was aborted"));
      };
      if (init?.signal?.aborted) onAbort();
      else init?.signal?.addEventListener("abort", onAbort);
    });
}

describe("gemini client disconnect cascade (signal propagation)", () => {
  it("(a) non-streaming pool: abort mid-attempt stops the failover cascade at the first member", async () => {
    const calls = [];
    const signals = [];
    const upstreamFetch = async (urls, init) => {
      const url = Array.isArray(urls) ? urls[0] : urls;
      const memberId = new URL(url).host.split(".")[0];
      calls.push(memberId);
      signals.push(init?.signal ?? null);
      if (memberId === "member-a") return hangingUpstream(3000)(urls, init);
      // member-b answers instantly — a broken implementation that converts
      // the abort into a 502 would fail over here and log the call.
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "B says hi" } }] }),
      };
    };
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = createMockDeps({ upstreamFetch, metricsCollector: collector });

    await withServer(deps, async (port) => {
      const ac = new AbortController();
      const resPromise = postGenerate(port, ac.signal);
      // Let the request reach member-a's pending upstream fetch.
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      await resPromise.then(
        () => {},
        () => {},
      );
      // Long enough that a broken failover would have called member-b by now.
      await new Promise((r) => setTimeout(r, 150));

      assert.deepEqual(calls, ["member-a"], "abort must stop the pool loop, not fail over to the next member");
      assert.ok(signals[0], "the abort signal must be passed to upstreamFetch");
      assert.equal(signals[0].aborted, true);

      const status = await collector.getAgentsStatus();
      const agy = status.find((a) => a.id === "agy");
      assert.equal(agy.errorActive, false, "client abort must not latch a panel fault");
      assert.ok(!agy.lastError || agy.lastError.status !== 502, "no phantom 502 recorded");
    });
  });

  it("(b) streaming pool: abort mid-attempt records aborted and never retries or fails over", async () => {
    const calls = [];
    const upstreamFetch = async (urls, init) => {
      const url = Array.isArray(urls) ? urls[0] : urls;
      const memberId = new URL(url).host.split(".")[0];
      calls.push(memberId);
      return hangingUpstream(3000)(urls, init);
    };
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = createMockDeps({ upstreamFetch, metricsCollector: collector });

    await withServer(deps, async (port) => {
      const ac = new AbortController();
      const resPromise = postGenerate(port, ac.signal, { stream: true });
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      await resPromise.then(
        () => {},
        () => {},
      );
      await new Promise((r) => setTimeout(r, 150));

      assert.deepEqual(calls, ["member-a"], "no keep-alive retry and no failover against a departed client");

      const status = await collector.getAgentsStatus();
      const agy = status.find((a) => a.id === "agy");
      assert.equal(agy.errorActive, false, "client abort must not latch a panel fault");
      assert.ok(!agy.lastError || agy.lastError.status !== 502, "no phantom 502 recorded");
    });
  });

  it("(c) healthy streaming request still completes and records success once", async () => {
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
      const res = await postGenerate(port, undefined, { stream: true });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("hello"));

      const status = await collector.getAgentsStatus();
      const agy = status.find((a) => a.id === "agy");
      assert.equal(agy.errorActive, false);
      assert.equal(agy.metrics.totalRequests, 1, "request counted exactly once (no aborted double-record)");
    });
  });
  it("(d) streaming classic path: abort mid-attempt records aborted, no retry", async () => {
    // The non-pool alias exercises the callUpstream closure in gemini-server,
    // a distinct call site from the pool's callUpstreams fan-out.
    let callCount = 0;
    const plainResolver = createAliasResolver({
      filePath: "mock-nonexistent-gemini-disconnect.json",
      overlay: { "gemini-3.7-flash": "member-a/gemini-x" },
    });
    const upstreamFetch = async (urls, init) => {
      callCount += 1;
      return hangingUpstream(3000)(urls, init);
    };
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = { ...createMockDeps({ upstreamFetch, metricsCollector: collector }), aliasResolver: plainResolver };

    await withServer(deps, async (port) => {
      const ac = new AbortController();
      const resPromise = postGenerate(port, ac.signal, { stream: true });
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      await resPromise.then(
        () => {},
        () => {},
      );
      await new Promise((r) => setTimeout(r, 150));

      assert.equal(callCount, 1, "no keep-alive retry against a departed client");

      const status = await collector.getAgentsStatus();
      const agy = status.find((a) => a.id === "agy");
      assert.equal(agy.errorActive, false, "client abort must not latch a panel fault");
      assert.ok(!agy.lastError || agy.lastError.status !== 502, "no phantom 502 recorded");
    });
  });
});

describe("geminiStreamChannel onSettled defensive abort branch", () => {
  // Mirrors the anthropic channel's onSettled contract: a clientAborted
  // outcome records an abort end so the in-flight tracker entry cannot leak.
  // In production gemini-server's res "close" listener records the abort
  // first (first-terminal-wins); these unit tests lock the safety net itself.
  function channelWith(tracker) {
    const res = { headersSent: false, write() {}, end() {} };
    return geminiStreamChannel({ res, tracker, abortController: new AbortController(), deps: {} });
  }

  it("a clientAborted outcome records an aborted end with usage", () => {
    const ends = [];
    const channel = channelWith({ recordEnd: (info) => ends.push(info) });
    channel.onSettled({ outcome: "terminal", committed: false, clientAborted: true, usage: { prompt_tokens: 3 } }, 0);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].aborted, true);
    assert.deepEqual(ends[0].usage, { prompt_tokens: 3 });
  });

  it("an ok outcome still records usage only (unchanged behavior)", () => {
    const ends = [];
    const channel = channelWith({ recordEnd: (info) => ends.push(info) });
    channel.onSettled({ outcome: "ok", committed: true, usage: { prompt_tokens: 5 } }, 0);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].aborted, undefined);
    assert.deepEqual(ends[0].usage, { prompt_tokens: 5 });
  });
});
