// Resident relay Anthropic-path tests: real loopback sockets against
// createOpenAIRelayServer (openai-server.mjs), synthetic store, mock upstream.
// These cover the resident /v1/messages streaming route, which the per-launch
// server.test.mjs suite does not reach.
// No real credentials, no real network egress, no DPAPI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRelayServer, listenLoopback } from "./openai-server.mjs";

const TOKEN = "test-token-anthropic-stream";

const STORE = {
  version: 2,
  providers: {
    "test-prov": {
      displayName: "Test Provider",
      baseURL: "https://upstream.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "test.dpapi",
      models: { "claude-test": { displayName: "Claude Test" } },
    },
  },
};

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

function postMessages(port) {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/test-prov/claude-test",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

function sseStream(chunks) {
  return (async function* () {
    const enc = new TextEncoder();
    for (const c of chunks) yield enc.encode(c);
  })();
}

describe("resident relay /v1/messages streaming (Anthropic path)", () => {
  it("translates a healthy upstream stream into an ordered Anthropic SSE sequence", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"cmpl-1","choices":[{"delta":{"content":"He"}}]}\n\n',
        'data: {"id":"cmpl-1","choices":[{"delta":{"content":"llo"}}]}\n\n',
        'data: {"id":"cmpl-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":5}}\n\n',
        "data: [DONE]\n\n",
      ]),
    });

    await withServer(createMockDeps({ upstreamFetch }), async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200, "a healthy stream must not end in a 502");
      assert.match(res.headers.get("content-type"), /text\/event-stream/);
      const text = await res.text();

      // The client speaks the Anthropic Messages protocol: the relay must
      // translate the upstream OpenAI chunks into Anthropic-shaped events.
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
    });
  });

  it("translates upstream reasoning into a thinking block that closes before the answer", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"cmpl-1","choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
        'data: {"id":"cmpl-1","choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
        'data: {"id":"cmpl-1","choices":[{"delta":{"content":"答"}}]}\n\n',
        'data: {"id":"cmpl-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n',
        "data: [DONE]\n\n",
      ]),
    });

    await withServer(createMockDeps({ upstreamFetch }), async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      const text = await res.text();

      // The thinking block opens, streams, and closes BEFORE the text block.
      const order = [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ];
      let cursor = 0;
      for (const event of order) {
        const at = text.indexOf(`event: ${event}`, cursor);
        assert.ok(at !== -1, `missing ${event}`);
        cursor = at;
      }
      assert.ok(text.includes('"thinking"'), "a thinking block must be opened");
      assert.ok(text.includes('"thinking_delta"'), "reasoning must stream as thinking_delta");
      assert.ok(text.includes("想"), "the thinking text must survive");
      assert.ok(text.includes('"text_delta"'));
      assert.ok(text.includes("答"), "the answer text must survive");
    });
  });

  it("exhausts keep-alive retries on empty streams and answers 502 with a readable message", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"1","choices":[{"delta":{}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    });

    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error.type, "api_error");
      assert.match(body.error.message, /模型未返回任何内容/, "exhaustion message must be readable Chinese, not mojibake");
    });
  });

  it("enhanced mode holds the whole turn: a cut after reasoning is a retryable reject, not a partial stream", async () => {
    // Single-flag guard semantics: enhanced means holdEntireTurn, so even a
    // reasoning-first turn stays withheld until the verdict. A stream cut
    // after reasoning (no [DONE], no finish_reason) must surface as a
    // retryable reject — with no retries left, a clean 502 — instead of
    // streaming partial content and an after-the-fact error event.
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"1","choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
        'data: {"id":"1","choices":[{"delta":{"content":"partial answ"}}]}\n\n',
      ]),
    });

    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, mode: "enhanced", maxRetries: 0, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 502, "a cut turn must be rejected wholesale, not streamed partially");
      const body = await res.json();
      assert.match(body.error.message, /截断|truncat/i);
    });
  });

  it("retries a transient upstream 5xx (e.g. Cloudflare 522) before any content and delivers the recovered stream", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) return { ok: false, status: 522 };
      return {
        ok: true,
        status: 200,
        body: sseStream([
          'data: {"id":"1","choices":[{"delta":{"content":"recovered from 522"},"index":0}]}\n\n',
          'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    };

    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered from 522"), "client must receive the retried stream after the transient 5xx");
      assert.equal(callCount, 2, "the 522 attempt plus exactly one silent retry");
    });
  });

  it("surfaces the upstream 5xx only after retries are exhausted", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      return { ok: false, status: 522 };
    };

    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 522);
      const body = await res.json();
      assert.match(body.error.message, /status 522/, "the terminal error must carry the upstream status");
      assert.equal(callCount, 2, "initial attempt + 1 retry, then pass through");
    });
  });
});
