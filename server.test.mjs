// Relay transport tests: real loopback sockets, synthetic store, mock upstream.
// No real credentials, no real network egress, no DPAPI.

import test from "node:test";
import assert from "node:assert/strict";
import { createRelayServer, listenLoopback, generateToken } from "./server.mjs";
import { catalogGeneration } from "./catalog-generation.mjs";
import { createSessionReporter } from "./agent-metrics.mjs";

const STORE = {
  version: 2,
  providers: {
    "poke-api": {
      displayName: "Poke",
      baseURL: "https://upstream.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "poke-api.dpapi",
      models: { "claude-opus-5": { displayName: "Opus 5" } },
    },
  },
};

function deps(overrides = {}) {
  let generation = null;
  return {
    token: "test-token-abc",
    loadStore: () => ({ ok: true, store: STORE }),
    loadCredential: async () => ({ ok: true, value: "SENTINEL-UPSTREAM-KEY" }),
    upstreamFetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "cmpl-1",
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
    }),
    recordGeneration: (g) => {
      generation = g;
    },
    readGeneration: () => generation,
    ...overrides,
  };
}

async function withServer(d, fn) {
  const server = createRelayServer(d);
  const { port, close } = await listenLoopback(server);
  try {
    return await fn(port);
  } finally {
    await close();
  }
}

test("generateToken produces a 256-bit hex value, unique per call", () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test("binds loopback and answers HEAD /api/hello without auth or store access", async () => {
  let storeRead = false;
  await withServer(
    deps({
      loadStore: () => {
        storeRead = true;
        return { ok: true, store: STORE };
      },
    }),
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/hello`, { method: "HEAD" });
      assert.equal(res.status, 200);
    },
  );
  assert.equal(storeRead, false, "liveness probe must not read the store");
});

test("discovery over HTTP returns wire ids and requires the token", async () => {
  await withServer(deps(), async (port) => {
    const anon = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(anon.status, 401);

    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: "test-token-abc" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.data.map((m) => m.id),
      ["anthropic/poke-api/claude-opus-5"],
    );
  });
});

test("non-JSON body is 400 and never reaches upstream", async () => {
  let called = false;
  await withServer(
    deps({
      upstreamFetch: async () => {
        called = true;
        throw new Error("must not be called");
      },
    }),
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "test-token-abc", "content-type": "application/json" },
        body: "{not json",
      });
      assert.equal(res.status, 400);
    },
  );
  assert.equal(called, false);
});

test("body exceeding 32 MiB is 413 and never reaches upstream", async () => {
  let called = false;
  await withServer(
    deps({
      upstreamFetch: async () => {
        called = true;
        throw new Error("must not be called");
      },
    }),
    async (port) => {
      // 33 MiB of padding — one byte over the 32 MiB limit.
      const oversized = "x".repeat(33 * 1024 * 1024);
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "test-token-abc", "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/poke-api/claude-opus-5",
          max_tokens: 1,
          messages: [{ role: "user", content: oversized }],
        }),
      });
      assert.equal(res.status, 413);
    },
  );
  assert.equal(called, false);
});

test("non-streaming message round trip translates to an Anthropic body", async () => {
  await withServer(deps(), async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { authorization: "test-token-abc", "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/poke-api/claude-opus-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, "message");
    assert.equal(body.model, "anthropic/poke-api/claude-opus-5");
    assert.deepEqual(body.content, [{ type: "text", text: "hi" }]);
    assert.equal(body.stop_reason, "end_turn");
  });
});

test("streaming request emits an ordered Anthropic SSE sequence", async () => {
  const sse = [
    'data: {"id":"cmpl-1","choices":[{"delta":{"content":"He"}}]}\n\n',
    'data: {"id":"cmpl-1","choices":[{"delta":{"content":"llo"}}]}\n\n',
    'data: {"id":"cmpl-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":5}}\n\n',
    "data: [DONE]\n\n",
  ];
  const upstreamBody = (async function* () {
    const encoder = new TextEncoder();
    for (const part of sse) yield encoder.encode(part);
  })();

  await withServer(
    deps({
      upstreamFetch: async () => ({ ok: true, status: 200, body: upstreamBody }),
    }),
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "test-token-abc", "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/poke-api/claude-opus-5",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /text\/event-stream/);
      const text = await res.text();

      const order = ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"];
      let cursor = 0;
      for (const event of order) {
        const at = text.indexOf(`event: ${event}`, cursor);
        assert.ok(at !== -1, `missing ${event}`);
        cursor = at;
      }
      assert.ok(text.includes('"text_delta"'));
      assert.ok(text.includes("He"), "first text fragment must survive");
      assert.ok(text.includes("llo"), "second text fragment must survive");
      assert.equal(text.includes("SENTINEL-UPSTREAM-KEY"), false, "must never leak the upstream key");
    },
  );
});

test("mid-stream upstream failure emits an SSE error event, not a fake message_stop", async () => {
  const upstreamBody = (async function* () {
    const encoder = new TextEncoder();
    yield encoder.encode('data: {"id":"cmpl-1","choices":[{"delta":{"content":"He"}}]}\n\n');
    throw new Error("upstream connection reset");
  })();

  await withServer(
    deps({
      upstreamFetch: async () => ({ ok: true, status: 200, body: upstreamBody }),
    }),
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "test-token-abc", "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/poke-api/claude-opus-5",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();

      assert.ok(text.includes("He"), "already-delivered content must survive");
      assert.ok(text.includes("event: error"), "a structured error event must be emitted");
      assert.ok(text.includes("api_error"));
      assert.equal(text.includes("message_delta"), false, "no finish metadata for a failed stream");
      assert.equal(text.includes("message_stop"), false, "truncated stream must not be presented as a completed message");
      assert.equal(text.includes("SENTINEL-UPSTREAM-KEY"), false, "must never leak the upstream key");
    },
  );
});

test("post-content truncation emits an Anthropic error event, not an OpenAI data line", async () => {
  // Content is delivered, then the stream simply ends: no finish_reason, no
  // [DONE] — the mid-word truncation shape. The guard flags it after content
  // was committed; the client must receive a legible Anthropic error frame,
  // never a bare OpenAI-style data line (which Claude Code misreads as an
  // unterminated stream and answers with an unprotected non-streaming retry).
  const upstreamBody = (async function* () {
    const encoder = new TextEncoder();
    yield encoder.encode('data: {"id":"cmpl-1","choices":[{"delta":{"content":"He"}}]}\n\n');
  })();

  await withServer(
    deps({
      upstreamFetch: async () => ({ ok: true, status: 200, body: upstreamBody }),
    }),
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "test-token-abc", "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/poke-api/claude-opus-5",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();

      assert.ok(text.includes("He"), "already-delivered content must survive");
      assert.ok(text.includes("event: error"), "the error must be an Anthropic error event frame");
      assert.ok(text.includes('"type":"error"'), "the payload must carry the Anthropic error envelope");
      assert.equal(text.includes("message_delta"), false, "no finish metadata for a truncated stream");
      assert.equal(text.includes("message_stop"), false, "truncated stream must not be presented as a completed message");
    },
  );
});

test("stale catalog over HTTP is 409", async () => {
  let store = STORE;
  let generation = null;
  await withServer(
    {
      token: "test-token-abc",
      loadStore: () => ({ ok: true, store }),
      loadCredential: async () => ({ ok: true, value: "k" }),
      upstreamFetch: async () => {
        throw new Error("must not be called");
      },
      recordGeneration: (g) => {
        generation = g;
      },
      readGeneration: () => generation,
    },
    async (port) => {
      const discovery = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { authorization: "test-token-abc" },
      });
      assert.equal(discovery.status, 200);

      // Same provider id, different endpoint: the exact endpoint-swap scenario this guards against.
      store = {
        version: 2,
        providers: {
          "poke-api": {
            ...STORE.providers["poke-api"],
            baseURL: "https://attacker.invalid/v1",
          },
        },
      };
      assert.notEqual(catalogGeneration(store), generation);

      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "test-token-abc", "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/poke-api/claude-opus-5",
          max_tokens: 8,
          messages: [{ role: "user", content: "x" }],
        }),
      });
      assert.equal(res.status, 409);
    },
  );
});

test("unsupported endpoints and methods are 404", async () => {
  await withServer(deps(), async (port) => {
    const wrongPath = await fetch(`http://127.0.0.1:${port}/v1/complete`, {
      method: "POST",
      headers: { authorization: "test-token-abc", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(wrongPath.status, 404);

    const wrongMethod = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      method: "DELETE",
      headers: { authorization: "test-token-abc" },
    });
    assert.equal(wrongMethod.status, 404);
  });
});

test("server binds only 127.0.0.1", async () => {
  const server = createRelayServer(deps());
  const { close } = await listenLoopback(server);
  try {
    assert.equal(server.address().address, "127.0.0.1");
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Session tracker wiring (Phase B)
// ---------------------------------------------------------------------------

// A mock session tracker that records every call in order.
function mockTracker() {
  const calls = [];
  return {
    calls,
    startRequestMeta: null,
    setToken() {},
    setClaudePid() {},
    startRequest(meta = {}) {
      calls.push("startRequest");
      this.startRequestMeta = meta;
    },
    recordFirstChunk() {
      calls.push("recordFirstChunk");
    },
    recordEnd(info = {}) {
      calls.push({ recordEnd: info });
    },
    reportEnd() {
      calls.push("reportEnd");
    },
  };
}

function sseStream(chunks) {
  const encoder = new TextEncoder();
  return (async function* () {
    for (const chunk of chunks) yield encoder.encode(chunk);
  })();
}

test("streaming request calls startRequest, recordFirstChunk and recordEnd with usage", async () => {
  const tracker = mockTracker();
  const upstreamBody = sseStream([
    'data: {"id":"1","choices":[{"delta":{"content":"hi"},"index":0}]}\n\n',
    'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":80}}}\n\n',
    "data: [DONE]\n\n",
  ]);

  await withServer(
    deps({ upstreamFetch: async () => ({ ok: true, status: 200, body: upstreamBody }), sessionTracker: tracker }),
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "test-token-abc", "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/poke-api/claude-opus-5",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(res.status, 200);
      await res.text();
    },
  );

  assert.equal(tracker.calls[0], "startRequest");
  assert.equal(tracker.calls[1], "recordFirstChunk");
  const endCall = tracker.calls.find((c) => c && c.recordEnd);
  assert.ok(endCall, "recordEnd was called");
  assert.equal(endCall.recordEnd.usage?.prompt_tokens, 100);
  assert.equal(endCall.recordEnd.usage?.completion_tokens, 20);
  assert.equal(endCall.recordEnd.usage?.prompt_tokens_details?.cached_tokens, 80);
});

test("startRequest meta carries the channel id for plain wire-id requests (未知渠道 regression)", async () => {
  const tracker = mockTracker();
  await withServer(
    deps({ sessionTracker: tracker }),
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "test-token-abc", "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/poke-api/claude-opus-5",
          max_tokens: 64,
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(res.status, 200);
      await res.text();
    },
  );
  const meta = tracker.startRequestMeta;
  assert.ok(meta, "startRequest was called with meta");
  assert.equal(meta.providerId, "poke-api");
  assert.equal(meta.model, "claude-opus-5");
});

test("non-streaming request calls startRequest and recordEnd with mapped usage without fake firstChunk", async () => {
  const tracker = mockTracker();

  await withServer(
    deps({ sessionTracker: tracker }),
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "test-token-abc", "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/poke-api/claude-opus-5",
          max_tokens: 64,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(res.status, 200);
      await res.json();
    },
  );

  assert.equal(tracker.calls[0], "startRequest");
  assert.ok(!tracker.calls.includes("recordFirstChunk"), "non-streaming requests must not record a fake first chunk");
  const endCall = tracker.calls.find((c) => c && c.recordEnd);
  assert.ok(endCall, "recordEnd was called");
  // The default deps upstream returns prompt_tokens=3, completion_tokens=4;
  // openAIToAnthropic maps those to input_tokens/output_tokens, then server.mjs
  // maps them back to prompt_tokens/completion_tokens for the tracker.
  assert.equal(endCall.recordEnd.usage?.prompt_tokens, 3);
  assert.equal(endCall.recordEnd.usage?.completion_tokens, 4);
});

test("non-streaming upstream error records the fault without a fake first chunk", async () => {
  const tracker = mockTracker();

  await withServer(
    deps({
      sessionTracker: tracker,
      upstreamFetch: async () => ({ ok: false, status: 502 }),
    }),
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "test-token-abc", "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/poke-api/claude-opus-5",
          max_tokens: 64,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(res.status, 502);
      await res.json();
    },
  );

  assert.equal(tracker.calls[0], "startRequest");
  assert.ok(
    !tracker.calls.includes("recordFirstChunk"),
    "an error response never produced a first token — no fake TTFT",
  );
  const endCall = tracker.calls.find((c) => c && c.recordEnd);
  assert.ok(endCall, "recordEnd was called");
  assert.equal(endCall.recordEnd.status, 502);
  assert.equal(endCall.recordEnd.error?.status, 502);
});

test("recordEnd is called even when the upstream stream fails mid-response", async () => {
  const tracker = mockTracker();
  const failingStream = (async function* () {
    yield new TextEncoder().encode('data: {"id":"1","choices":[{"delta":{"content":"hi"},"index":0}]}\n\n');
    throw new Error("upstream died");
  })();

  await withServer(
    deps({ upstreamFetch: async () => ({ ok: true, status: 200, body: failingStream }), sessionTracker: tracker }),
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "test-token-abc", "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/poke-api/claude-opus-5",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(res.status, 200);
      await res.text();
    },
  );

  assert.equal(tracker.calls[0], "startRequest");
  assert.equal(tracker.calls[1], "recordFirstChunk");
  const failEnd = tracker.calls.find((c) => c && c.recordEnd);
  assert.ok(failEnd, "recordEnd was called despite upstream failure");
  // A mid-stream upstream death (client did NOT cancel) is a real fault: the
  // tracker must receive the error so the panel can flag the session.
  assert.equal(failEnd.recordEnd.error?.status, 502);
});

test("works without a sessionTracker (no crash)", async () => {
  const upstreamBody = sseStream([
    'data: {"id":"1","choices":[{"delta":{"content":"hi"},"index":0}]}\n\n',
    'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
    "data: [DONE]\n\n",
  ]);

  await withServer(
    deps({ upstreamFetch: async () => ({ ok: true, status: 200, body: upstreamBody }) }),
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "test-token-abc", "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/poke-api/claude-opus-5",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(res.status, 200);
      await res.text();
    },
  );
});

// A richer tracker that captures the keep-alive counters so anti-truncation
// behavior is observable without a full metrics collector.
function keepAliveTracker() {
  const t = mockTracker();
  t.retries = 0;
  t.recoveries = 0;
  t.exhausted = 0;
  t.recordRetry = () => { t.retries += 1; };
  t.noteKeepAliveRecovery = () => { t.recoveries += 1; };
  t.noteKeepAliveExhausted = () => { t.exhausted += 1; };
  return t;
}

test("keep-alive: recovers on empty stream via 1 retry and delivers the retried text", async () => {
  let callCount = 0;
  const upstreamFetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return { ok: true, status: 200, body: sseStream(['data: {"id":"1","choices":[{"delta":{}}]}\n\n', "data: [DONE]\n\n"]) };
    }
    return { ok: true, status: 200, body: sseStream(['data: {"id":"2","choices":[{"delta":{"content":"recovered"},"index":0}]}\n\n', "data: [DONE]\n\n"]) };
  };
  const tracker = keepAliveTracker();
  await withServer(
    deps({ upstreamFetch, sessionTracker: tracker, getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }) }),
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "test-token-abc", "content-type": "application/json" },
        body: JSON.stringify({ model: "anthropic/poke-api/claude-opus-5", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered"), "client must receive the retried stream's payload");
      assert.equal(callCount, 2, "upstream called twice (1 retry)");
    },
  );
  assert.equal(tracker.retries, 1, "retry counter incremented");
  assert.equal(tracker.recoveries, 1, "recovery counter incremented");
});

test("keep-alive: exhausts retries on a persistently empty stream and returns 502", async () => {
  let callCount = 0;
  const upstreamFetch = async () => {
    callCount += 1;
    return { ok: true, status: 200, body: sseStream(['data: {"id":"1","choices":[{"delta":{}}]}\n\n', "data: [DONE]\n\n"]) };
  };
  const tracker = keepAliveTracker();
  await withServer(
    deps({ upstreamFetch, sessionTracker: tracker, getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }) }),
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "test-token-abc", "content-type": "application/json" },
        body: JSON.stringify({ model: "anthropic/poke-api/claude-opus-5", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 502);
      assert.equal(callCount, 2, "initial attempt + 1 retry");
    },
  );
  assert.equal(tracker.retries, 1);
  assert.equal(tracker.exhausted, 1, "exhaustion counter incremented");
});


test("keep-alive: retries a transient upstream 5xx (e.g. Cloudflare 522) and delivers the recovered stream", async () => {
  let callCount = 0;
  const upstreamFetch = async () => {
    callCount += 1;
    if (callCount === 1) return { ok: false, status: 522 };
    return { ok: true, status: 200, body: sseStream(['data: {"id":"1","choices":[{"delta":{"content":"recovered from 522"},"index":0}]}\n\n', "data: [DONE]\n\n"]) };
  };
  const tracker = keepAliveTracker();
  await withServer(
    deps({ upstreamFetch, sessionTracker: tracker, getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }) }),
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "test-token-abc", "content-type": "application/json" },
        body: JSON.stringify({ model: "anthropic/poke-api/claude-opus-5", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered from 522"), "client must receive the retried stream after the transient 5xx");
      assert.equal(callCount, 2, "the 522 attempt plus exactly one silent retry");
    },
  );
  assert.equal(tracker.retries, 1, "retry counter incremented");
  assert.equal(tracker.recoveries, 1, "recovery counter incremented");
});

test("keep-alive: surfaces the upstream 5xx only after retries are exhausted", async () => {
  let callCount = 0;
  const upstreamFetch = async () => {
    callCount += 1;
    return { ok: false, status: 522 };
  };
  const tracker = keepAliveTracker();
  await withServer(
    deps({ upstreamFetch, sessionTracker: tracker, getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }) }),
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "test-token-abc", "content-type": "application/json" },
        body: JSON.stringify({ model: "anthropic/poke-api/claude-opus-5", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 522);
      const body = await res.json();
      assert.match(body.error.message, /status 522/, "the terminal error must carry the upstream status");
      assert.equal(callCount, 2, "initial attempt + 1 retry, then pass through");
    },
  );
  assert.equal(tracker.retries, 1, "the transient 5xx consumed the one retry");
});

test("concurrent in-session requests settle independently — activeRequests returns to 0", async () => {
  // Claude Code fires concurrent requests inside one session (side queries,
  // rapid re-send after Esc). Request A ends while request B's stream is
  // still open; B's terminal recordEnd must still decrement the counter, or
  // the panel capsule stays 生成中 forever.
  const posted = [];
  const reporter = createSessionReporter({
    reportUrl: "http://report.invalid/panel/api/session/report",
    fetchFn: (url, init) => {
      posted.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true });
    },
  });
  reporter.setClaudePid(2222);

  let releaseB;
  const gateB = new Promise((resolve) => { releaseB = resolve; });
  const encoder = new TextEncoder();
  const upstreamFetch = async (urls, opts) => {
    if (String(opts?.body).includes("hold-me")) {
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          await gateB;
          yield encoder.encode('data: {"id":"b","choices":[{"delta":{"content":"b"},"index":0}]}\n\n');
          yield encoder.encode('data: {"id":"b","choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":5,"completion_tokens":6}}\n\n');
          yield encoder.encode("data: [DONE]\n\n");
        })(),
      };
    }
    return {
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"a","choices":[{"delta":{"content":"a"},"index":0}]}\n\n',
        'data: {"id":"a","choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n',
        "data: [DONE]\n\n",
      ]),
    };
  };

  await withServer(deps({ upstreamFetch, sessionTracker: reporter }), async (port) => {
    const send = (content) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { authorization: "test-token-abc", "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/poke-api/claude-opus-5", max_tokens: 64, stream: true, messages: [{ role: "user", content }] }),
    });

    const reqB = send("hold-me");
    const reqA = send("finish-now");
    const resA = await reqA;
    assert.equal(resA.status, 200);
    await resA.text();

    // A has fully ended, B is still streaming: exactly one in flight.
    assert.equal(posted[posted.length - 1].activeRequests, 1);

    releaseB();
    const resB = await reqB;
    assert.equal(resB.status, 200);
    await resB.text();
  });

  // B's terminal end must have settled the counter — a swallowed recordEnd
  // would leave the final snapshot pinned at 1.
  assert.equal(posted[posted.length - 1].activeRequests, 0);
});
