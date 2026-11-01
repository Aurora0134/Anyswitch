// The numeric error code on a truncated upstream response.
//
// A mid-response cut leaves the SSE headers long since committed, so the
// wire cannot carry a status line any more — the fault has to travel inside
// the error frame. It travels as three slots at once:
//
//   error.type    "api_error"   — what the SDK's own retry classifier reads
//   error.code    502           — what an agent that retries on a status code reads
//   error.message <chinese>     — what a human (or a log grep) reads
//
// 502 is the closest semantic fit: "the gateway received an invalid or
// incomplete response from the upstream". The relay already records this
// fault class as 502 internally, so the wire code and the panel metric now
// speak the same vocabulary.
//
// All three wires are covered: OpenAI passthrough (data line), Anthropic
// (event: error), Responses (response.failed).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRelayServer, listenLoopback } from "../src/relay/openai-server.mjs";
import { createEffortInjector } from "../src/catalog/effort-injection.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

const envRoot = mkTestDir("anys-truncation-code-env-");
process.env.LOCALAPPDATA = envRoot;
process.env.APPDATA = envRoot;
process.env.USERPROFILE = envRoot;

const TOKEN = "test-token-truncation-code";

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

const OFF_EFFORT_INJECTOR = () => createEffortInjector({ isEnabled: () => false });

function createMockDeps({ upstreamFetch, getKeepAliveConfig }) {
  return {
    token: TOKEN,
    loadStore: () => ({ ok: true, store: STORE }),
    loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
    upstreamFetch,
    recordGeneration: () => {},
    readGeneration: () => null,
    getKeepAliveConfig,
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

function sseStream(chunks) {
  return (async function* () {
    const enc = new TextEncoder();
    for (const c of chunks) yield enc.encode(c);
  })();
}

// An upstream that answers with some text and then dies without a
// terminator — the mid-word cut.
function truncatedUpstream() {
  return async () => ({
    ok: true,
    status: 200,
    body: sseStream([
      'data: {"id":"cmpl-1","choices":[{"delta":{"content":"partial output"}}]}\n\n',
    ]),
  });
}

// The think-only shape: the turn terminates cleanly but carries reasoning
// only — no answer, no tool call.
function thinkOnlyUpstream() {
  return async () => ({
    ok: true,
    status: 200,
    body: sseStream([
      'data: {"id":"cmpl-1","choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  });
}

function postChat(port) {
  return fetch(`http://127.0.0.1:${port}/openai/test-prov/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json", "x-agent-id": "zcode" },
    body: JSON.stringify({
      model: "gpt-test",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

function postMessages(port) {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/test-prov/gpt-test",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

function postResponses(port) {
  return fetch(`http://127.0.0.1:${port}/openai/test-prov/v1/responses`, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json", "x-agent-id": "zcode" },
    body: JSON.stringify({
      model: "gpt-test",
      stream: true,
      input: "hi",
    }),
  });
}

// Pull the JSON payload out of an SSE `data:` line.
function dataPayloads(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      // not a JSON payload line
    }
  }
  return out;
}

describe("truncated upstream response carries the 502 code on every wire", () => {
  it("OpenAI passthrough: the error data line carries type + code + message and no [DONE]", async () => {
    await withServer(
      createMockDeps({ upstreamFetch: truncatedUpstream(), getKeepAliveConfig: () => ({ enabled: true, maxRetries: 0 }) }),
      async (port) => {
        const res = await postChat(port);
        assert.equal(res.status, 200, "the headers were already committed, so the status line cannot carry the fault");
        const text = await res.text();

        assert.ok(text.includes("partial output"), "the content delivered before the cut must survive");
        // The terminator must be absent — but the error MESSAGE mentions
        // "[DONE]" by name, so the check looks for the terminator line
        // itself, not the bare substring.
        assert.ok(
          !text.split("\n").some((line) => line.trim() === "data: [DONE]"),
          "a truncated turn must not look like a normal completion",
        );

        const payloads = dataPayloads(text);
        const errorPayload = payloads.find((p) => p?.error);
        assert.ok(errorPayload, "the cut must end in an error frame");
        assert.equal(errorPayload.error.type, "api_error");
        assert.equal(errorPayload.error.code, 502, "the numeric code must ride in the error object");
        assert.ok(errorPayload.error.message.length > 0, "a readable message must stay alongside the code");
      },
    );
  });

  it("OpenAI passthrough: a think-only turn also carries the 502 code", async () => {
    await withServer(
      createMockDeps({ upstreamFetch: thinkOnlyUpstream(), getKeepAliveConfig: () => ({ enabled: true, maxRetries: 0 }) }),
      async (port) => {
        const res = await postChat(port);
        const text = await res.text();
        const payloads = dataPayloads(text);
        const errorPayload = payloads.find((p) => p?.error);
        assert.ok(errorPayload, "a think-only turn must end in an error frame");
        assert.equal(errorPayload.error.code, 502);
        assert.ok(
          !text.split("\n").some((line) => line.trim() === "data: [DONE]"),
          "a think-only turn must not look like a normal completion",
        );
      },
    );
  });

  it("Anthropic: the event: error frame carries type + code + message", async () => {
    await withServer(
      createMockDeps({ upstreamFetch: truncatedUpstream(), getKeepAliveConfig: () => ({ enabled: true, maxRetries: 0 }) }),
      async (port) => {
        const res = await postMessages(port);
        assert.equal(res.status, 200);
        const text = await res.text();

        assert.ok(text.includes("event: error"), "the Anthropic wire ends a failed turn with an event: error frame");
        const payloads = dataPayloads(text);
        const errorPayload = payloads.find((p) => p?.error);
        assert.ok(errorPayload, "the error frame must carry the error object");
        assert.equal(errorPayload.error.type, "api_error");
        assert.equal(errorPayload.error.code, 502, "the Anthropic error object carries the code as an extra key");
        assert.ok(errorPayload.error.message.length > 0);
      },
    );
  });

  it("Responses: the response.failed frame carries type + code + message", async () => {
    await withServer(
      createMockDeps({ upstreamFetch: truncatedUpstream(), getKeepAliveConfig: () => ({ enabled: true, maxRetries: 0 }) }),
      async (port) => {
        const res = await postResponses(port);
        assert.equal(res.status, 200);
        const text = await res.text();

        assert.ok(text.includes("response.failed"), "the Responses wire ends a failed turn with response.failed");
        const payloads = dataPayloads(text);
        const failed = payloads.find((p) => p?.type === "response.failed");
        assert.ok(failed, "the failed frame must be present");
        assert.equal(failed.response.error.code, 502, "the Responses error object carries the code");
        assert.equal(failed.response.error.type, "api_error");
        assert.ok(failed.response.error.message.length > 0);
      },
    );
  });

  it("a healthy stream is untouched — no error frame, no code", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"cmpl-1","choices":[{"delta":{"content":"all good"}}]}\n\n',
        'data: {"id":"cmpl-1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    });

    await withServer(
      createMockDeps({ upstreamFetch, getKeepAliveConfig: () => ({ enabled: true, maxRetries: 0 }) }),
      async (port) => {
        const res = await postChat(port);
        const text = await res.text();
        assert.ok(text.includes("all good"));
        assert.ok(text.includes("[DONE]"), "a healthy stream still terminates normally");
        assert.ok(!text.includes('"error"'), "a healthy stream must not grow an error frame");
      },
    );
  });
});
