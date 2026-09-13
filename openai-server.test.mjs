// OpenAI relay transport tests: real loopback sockets, synthetic store, mock
// upstream. No real credentials, no real network egress, no DPAPI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRelayServer, listenLoopback, anthropicUsageToOpenAI, probeRelay, isCodexBackgroundRequest } from "./openai-server.mjs";
import { INSTANCE_ID_MAX_LEN } from "./agent-metrics.mjs";

const TOKEN = "test-token-123";

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

function deps(upstreamBody) {
  return {
    token: TOKEN,
    loadStore: () => ({ ok: true, store: STORE }),
    loadCredential: async () => ({ ok: true, value: "SENTINEL-UPSTREAM-KEY" }),
    upstreamFetch: async () => ({ ok: true, status: 200, body: upstreamBody }),
    recordGeneration: () => {},
    readGeneration: () => null,
  };
}

async function withServer(deps, fn) {
  const server = createOpenAIRelayServer(deps);
  // Explicit port 0: listenLoopback's default is the production relay port
  // (47821); a test must never bind or probe the real relay.
  const { port, close } = await listenLoopback(server, 0);
  try {
    return await fn(port);
  } finally {
    await close();
  }
}

function postChat(port) {
  return fetch(`http://127.0.0.1:${port}/openai/poke-api/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-5",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

describe("openai relay transport", () => {
  it("pipes a healthy upstream stream through unchanged", async () => {
    const sse = [
      'data: {"id":"cmpl-1","choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const upstreamBody = (async function* () {
      const encoder = new TextEncoder();
      for (const part of sse) yield encoder.encode(part);
    })();

    await withServer(deps(upstreamBody), async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /text\/event-stream/);
      const text = await res.text();
      assert.ok(text.includes('"content":"hi"'));
      assert.ok(text.includes("[DONE]"));
      assert.equal(text.includes("SENTINEL-UPSTREAM-KEY"), false, "must never leak the upstream key");
    });
  });

  it("signals a mid-stream upstream failure with a structured error instead of silent truncation", async () => {
    const upstreamBody = (async function* () {
      const encoder = new TextEncoder();
      yield encoder.encode('data: {"id":"cmpl-1","choices":[{"delta":{"content":"He"}}]}\n\n');
      throw new Error("upstream socket reset");
    })();

    await withServer(deps(upstreamBody), async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();

      assert.ok(text.includes("He"), "already-delivered content must survive");
      assert.ok(text.includes('"error"'), "a structured error chunk must be emitted");
      assert.ok(text.includes("api_error"));
      assert.equal(text.includes("[DONE]"), false, "must not be a normal completion");
      assert.equal(text.includes("SENTINEL-UPSTREAM-KEY"), false, "must never leak the upstream key");
    });
  });

  it("rejects with 502 when the upstream tool call never gets a function name, before any byte is forwarded", async () => {
    // Shape observed in production: one tool-input delta (id + argument
    // fragment, no name), then the stream ends. Strict clients abort the
    // whole turn on this; a 502 keeps their retry path alive instead.
    const upstreamBody = (async function* () {
      const encoder = new TextEncoder();
      yield encoder.encode(
        'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_a","function":{"arguments":"{\\"cmd\\":"}}]}}]}\n\n',
      );
      yield encoder.encode(
        'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      );
      yield encoder.encode("data: [DONE]\n\n");
    })();

    await withServer(deps(upstreamBody), async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error.type, "api_error");
      assert.match(body.error.message, /tool call/i);
      assert.equal(body.error.message.includes("SENTINEL-UPSTREAM-KEY"), false, "must never leak the upstream key");
    });
  });

  it("terminates an already-started stream with a structured error when a late tool call lacks a name", async () => {
    const upstreamBody = (async function* () {
      const encoder = new TextEncoder();
      yield encoder.encode('data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"He"}}]}\n\n');
      yield encoder.encode(
        'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"arguments":"{}"}}]}}]}\n\n',
      );
      yield encoder.encode("data: [DONE]\n\n");
    })();

    await withServer(deps(upstreamBody), async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('"content":"He"'), "already-delivered content must survive");
      assert.ok(text.includes('"error"'), "a structured error chunk must be emitted");
      assert.match(text, /tool call/i);
      assert.equal(text.includes("[DONE]"), false, "must not be a normal completion");
      assert.equal(text.includes("SENTINEL-UPSTREAM-KEY"), false, "must never leak the upstream key");
    });
  });

  it("returns 502 when the upstream dies before delivering any usable content", async () => {
    const upstreamBody = (async function* () {
      throw new Error("upstream socket reset before first event");
    })();

    await withServer(deps(upstreamBody), async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error.type, "api_error");
    });
  });

  it("answers the liveness probe without auth or store access", async () => {
    let storeRead = false;
    await withServer(
      {
        token: TOKEN,
        loadStore: () => {
          storeRead = true;
          return { ok: true, store: STORE };
        },
        loadCredential: async () => ({ ok: true, value: "k" }),
        upstreamFetch: async () => {
          throw new Error("must not be called");
        },
        recordGeneration: () => {},
        readGeneration: () => null,
      },
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/hello`);
        assert.equal(res.status, 200);
      },
    );
    assert.equal(storeRead, false, "liveness probe must not read the store");
  });

  it("passes req, tracker, model and providerId into metricsCollector", async () => {
    let startedMeta = null;
    let endedInfo = null;
    const fakeCollector = {
      startRequest: (meta) => {
        startedMeta = meta;
        return {
          recordFirstChunk: () => {},
          recordEnd: (info) => {
            endedInfo = info;
          },
        };
      },
    };

    const server = createOpenAIRelayServer({
      ...deps(
        (async function* () {
          yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
          yield new TextEncoder().encode("data: [DONE]\n\n");
        })(),
      ),
      metricsCollector: fakeCollector,
    });

    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      await res.text();
      assert.equal(startedMeta.providerId, "poke-api");
      assert.equal(startedMeta.model, "claude-opus-5");
    } finally {
      await close();
    }
  });

  it("routes requests with x-agent-id: pi to Pi metrics", async () => {
    let startedMeta = null;
    const fakeCollector = {
      startRequest: (meta) => {
        startedMeta = meta;
        return {
          recordFirstChunk: () => {},
          recordEnd: () => {},
        };
      },
    };

    const server = createOpenAIRelayServer({
      ...deps(
        (async function* () {
          yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
          yield new TextEncoder().encode("data: [DONE]\n\n");
        })(),
      ),
      metricsCollector: fakeCollector,
    });

    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/openai/poke-api/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: TOKEN,
          "content-type": "application/json",
          "x-agent-id": "pi",
        },
        body: JSON.stringify({
          model: "claude-opus-5",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(res.status, 200);
      await res.text();
      assert.ok(startedMeta, "metricsCollector.startRequest was called");
      assert.equal(startedMeta.providerId, "poke-api");
      assert.equal(startedMeta.agentId, "pi");
    } finally {
      await close();
    }
  });

  it("routes requests with an opencode User-Agent to opencode metrics instead of the zcode fallback", async () => {
    let startedMeta = null;
    const fakeCollector = {
      startRequest: (meta) => {
        startedMeta = meta;
        return {
          recordFirstChunk: () => {},
          recordEnd: () => {},
        };
      },
    };

    const server = createOpenAIRelayServer({
      ...deps(
        (async function* () {
          yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
          yield new TextEncoder().encode("data: [DONE]\n\n");
        })(),
      ),
      metricsCollector: fakeCollector,
    });

    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/openai/poke-api/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: TOKEN,
          "content-type": "application/json",
          "user-agent": "opencode/0.6.3 (+https://opencode.ai)",
        },
        body: JSON.stringify({
          model: "claude-opus-5",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(res.status, 200);
      await res.text();
      assert.ok(startedMeta, "metricsCollector.startRequest was called");
      assert.equal(startedMeta.agentId, "opencode");
    } finally {
      await close();
    }
  });

  it("keeps the zcode fallback for requests without x-agent-id or a known UA", async () => {
    let startedMeta = null;
    const fakeCollector = {
      startRequest: (meta) => {
        startedMeta = meta;
        return {
          recordFirstChunk: () => {},
          recordEnd: () => {},
        };
      },
    };

    const server = createOpenAIRelayServer({
      ...deps(
        (async function* () {
          yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
          yield new TextEncoder().encode("data: [DONE]\n\n");
        })(),
      ),
      metricsCollector: fakeCollector,
    });

    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      await res.text();
      assert.ok(startedMeta, "metricsCollector.startRequest was called");
      assert.equal(startedMeta.agentId, "zcode");
    } finally {
      await close();
    }
  });

  it("ignores an unknown x-agent-id value and falls back to the zcode default", async () => {
    // 白名单之外的显式值（拼写错误/未知客户端）不允许创造幽灵端点：
    // 回落 UA 识别与兜底，而不是原样进 journal。
    let startedMeta = null;
    const fakeCollector = {
      startRequest: (meta) => {
        startedMeta = meta;
        return {
          recordFirstChunk: () => {},
          recordEnd: () => {},
        };
      },
    };

    const server = createOpenAIRelayServer({
      ...deps(
        (async function* () {
          yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
          yield new TextEncoder().encode("data: [DONE]\n\n");
        })(),
      ),
      metricsCollector: fakeCollector,
    });

    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/openai/poke-api/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: TOKEN,
          "content-type": "application/json",
          "x-agent-id": "ghost-endpoint",
        },
        body: JSON.stringify({
          model: "claude-opus-5",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(res.status, 200);
      await res.text();
      assert.equal(startedMeta.agentId, "zcode");
    } finally {
      await close();
    }
  });

  it("attributes the requesting endpoint from the `~` identity prefix in the URL segment", async () => {
    // Qoder 既发不出 x-agent-id、UA 里也没有自家标识，认端点的通道只剩 URL 段。
    // 这里一次钉住四条契约：前缀认端点、stats 的 providerId 必须是剥离后的真实渠道
    // （否则 journal 落下 store 里不存在的「qoder~poke-api」幽灵渠道）、显式头仍压在
    // 前缀之上、未知前缀一律作废回落。
    const metas = [];
    const fakeCollector = {
      startRequest: (meta) => {
        metas.push(meta);
        return { recordFirstChunk: () => {}, recordEnd: () => {} };
      },
    };
    // 每条请求都要一条全新的上游流：deps() 传进去的是单个 async 迭代器，第二次
    // 请求复用会读到已耗尽的流并回 502。
    const sse = () =>
      (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
        yield new TextEncoder().encode("data: [DONE]\n\n");
      })();

    const server = createOpenAIRelayServer({
      ...deps(sse()),
      upstreamFetch: async () => ({ ok: true, status: 200, body: sse() }),
      metricsCollector: fakeCollector,
    });

    const { port, close } = await listenLoopback(server, 0);
    const chat = (segment, headers = {}) =>
      fetch(`http://127.0.0.1:${port}/openai/${segment}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json", ...headers },
        body: JSON.stringify({
          model: "claude-opus-5",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
    try {
      let res = await chat("qoder~poke-api", { "user-agent": "Mozilla/5.0 (Electron)" });
      assert.equal(res.status, 200);
      await res.text();
      assert.equal(metas[0].agentId, "qoder");
      assert.equal(metas[0].providerId, "poke-api");

      res = await chat("qoder~poke-api", { "x-agent-id": "dsh" });
      assert.equal(res.status, 200);
      await res.text();
      assert.equal(metas[1].agentId, "dsh");

      res = await chat("ghost~poke-api");
      assert.equal(res.status, 200);
      await res.text();
      assert.equal(metas[2].agentId, "zcode");
      assert.equal(metas[2].providerId, "poke-api");
    } finally {
      await close();
    }
  });

  it("normalizes a known x-agent-id value with stray case and whitespace", async () => {
    let startedMeta = null;
    const fakeCollector = {
      startRequest: (meta) => {
        startedMeta = meta;
        return {
          recordFirstChunk: () => {},
          recordEnd: () => {},
        };
      },
    };

    const server = createOpenAIRelayServer({
      ...deps(
        (async function* () {
          yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
          yield new TextEncoder().encode("data: [DONE]\n\n");
        })(),
      ),
      metricsCollector: fakeCollector,
    });

    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/openai/poke-api/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: TOKEN,
          "content-type": "application/json",
          "x-agent-id": " Kimi ",
        },
        body: JSON.stringify({
          model: "claude-opus-5",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(res.status, 200);
      await res.text();
      assert.equal(startedMeta.agentId, "kimi");
    } finally {
      await close();
    }
  });

  it("routes requests with x-agent-id: qoder to Qoder metrics", async () => {
    let startedMeta = null;
    const fakeCollector = {
      startRequest: (meta) => {
        startedMeta = meta;
        return {
          recordFirstChunk: () => {},
          recordEnd: () => {},
        };
      },
    };

    const server = createOpenAIRelayServer({
      ...deps(
        (async function* () {
          yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
          yield new TextEncoder().encode("data: [DONE]\n\n");
        })(),
      ),
      metricsCollector: fakeCollector,
    });

    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/openai/poke-api/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: TOKEN,
          "content-type": "application/json",
          "x-agent-id": "qoder",
        },
        body: JSON.stringify({
          model: "claude-opus-5",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(res.status, 200);
      await res.text();
      assert.equal(startedMeta.agentId, "qoder");
    } finally {
      await close();
    }
  });

  it("normalizes empty/missing tool_call arguments to \"{}\" before forwarding upstream", async () => {
    // Some upstream gateways (observed: SenseNova) hard-400 any request whose
    // assistant history carries a tool_call with function.arguments === ""
    // (or missing/null); "{}" is accepted. The relay rewrites only that shape.
    let forwardedBody = null;
    const server = createOpenAIRelayServer({
      token: TOKEN,
      loadStore: () => ({ ok: true, store: STORE }),
      loadCredential: async () => ({ ok: true, value: "SENTINEL-UPSTREAM-KEY" }),
      upstreamFetch: async (_urls, init) => {
        forwardedBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "ok" } }] }),
        };
      },
      recordGeneration: () => {},
      readGeneration: () => null,
    });

    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/openai/poke-api/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-5",
          messages: [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: "ok",
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "f", arguments: "" } },
                { id: "call_2", type: "function", function: { name: "g" } },
                { id: "call_3", type: "function", function: { name: "h", arguments: null } },
                { id: "call_4", type: "function", function: { name: "i", arguments: "{\"x\":1}" } },
              ],
            },
            { role: "tool", tool_call_id: "call_1", content: "err" },
            { role: "user", content: "go on" },
          ],
        }),
      });
      assert.equal(res.status, 200);
      await res.json();
    } finally {
      await close();
    }

    assert.ok(forwardedBody, "upstreamFetch was called");
    const calls = forwardedBody.messages[1].tool_calls;
    assert.equal(calls[0].function.arguments, "{}", "empty-string arguments must become {}");
    assert.equal(calls[1].function.arguments, "{}", "missing arguments must become {}");
    assert.equal(calls[2].function.arguments, "{}", "null arguments must become {}");
    assert.equal(calls[3].function.arguments, "{\"x\":1}", "non-empty arguments pass through untouched");
    assert.equal(forwardedBody.messages[0].content, "hi", "other messages pass through untouched");
    assert.equal(forwardedBody.messages[2].tool_call_id, "call_1", "tool messages pass through untouched");
  });

  it("passes non-string tool_call arguments (e.g. an object) through untouched", async () => {
    // Lenient clients sometimes send arguments as an already-parsed object.
    // The relay rewrites only the truly-empty shapes ("", null, undefined);
    // anything else must reach the upstream byte-identical — no "{}" clobber,
    // no JSON.stringify re-encoding.
    let forwardedBody = null;
    const server = createOpenAIRelayServer({
      token: TOKEN,
      loadStore: () => ({ ok: true, store: STORE }),
      loadCredential: async () => ({ ok: true, value: "SENTINEL-UPSTREAM-KEY" }),
      upstreamFetch: async (_urls, init) => {
        forwardedBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "ok" } }] }),
        };
      },
      recordGeneration: () => {},
      readGeneration: () => null,
    });

    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/openai/poke-api/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-5",
          messages: [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: "ok",
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "f", arguments: { x: 1 } } },
                { id: "call_2", type: "function", function: { name: "g", arguments: 42 } },
              ],
            },
            { role: "tool", tool_call_id: "call_1", content: "err" },
            { role: "user", content: "go on" },
          ],
        }),
      });
      assert.equal(res.status, 200);
      await res.json();
    } finally {
      await close();
    }

    assert.ok(forwardedBody, "upstreamFetch was called");
    const calls = forwardedBody.messages[1].tool_calls;
    assert.deepEqual(calls[0].function.arguments, { x: 1 }, "object arguments pass through untouched");
    assert.equal(calls[1].function.arguments, 42, "numeric arguments pass through untouched");
  });

  it("non-streaming upstream error records the fault without a fake first chunk", async () => {
    let recordedFirstChunk = false;
    let endedInfo = null;
    const fakeCollector = {
      startRequest: () => ({
        recordFirstChunk: () => { recordedFirstChunk = true; },
        recordEnd: (info) => { endedInfo = info; },
      }),
    };

    // Non-streaming request + upstream 502
    const server = createOpenAIRelayServer({
      ...deps({ ok: false, status: 502 }),
      metricsCollector: fakeCollector,
    });

    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/openai/poke-api/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "hello" }] }),
      });
      assert.equal(res.status, 502);
      await res.json();
    } finally {
      await close();
    }

    assert.equal(recordedFirstChunk, false, "error response must not record a fake first chunk");
    assert.ok(endedInfo, "recordEnd was called");
    assert.equal(endedInfo.status, 502);
    assert.equal(endedInfo.error?.status, 502);
  });

  it("non-streaming success does not record a fake first chunk", async () => {
    let recordedFirstChunk = false;
    let endedInfo = null;
    const fakeCollector = {
      startRequest: () => ({
        recordFirstChunk: () => { recordedFirstChunk = true; },
        recordEnd: (info) => { endedInfo = info; },
      }),
    };

    const server = createOpenAIRelayServer({
      token: TOKEN,
      loadStore: () => ({ ok: true, store: STORE }),
      loadCredential: async () => ({ ok: true, value: "SENTINEL-UPSTREAM-KEY" }),
      upstreamFetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      }),
      recordGeneration: () => {},
      readGeneration: () => null,
      metricsCollector: fakeCollector,
    });

    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/openai/poke-api/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "hello" }] }),
      });
      assert.equal(res.status, 200);
      await res.json();
    } finally {
      await close();
    }

    assert.equal(recordedFirstChunk, false, "non-streaming success must not record a fake first chunk");
    assert.ok(endedInfo, "recordEnd was called");
    assert.equal(endedInfo.usage?.completion_tokens, 5);
  });

  it("flags mid-word truncation: content delivered, no [DONE] and no finish_reason, latch a 502 on the tracker", async () => {
    // The 字中截断 shape: text was flowing, then the TCP stream simply ends.
    // Previously classified as a healthy completion — the client treated
    // partial output as the full response.
    let endedInfo = null;
    const fakeCollector = {
      startRequest: () => ({
        recordFirstChunk: () => {},
        recordEnd: (info) => { endedInfo = info; },
      }),
    };
    const upstreamBody = (async function* () {
      const encoder = new TextEncoder();
      yield encoder.encode('data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"partial output cut mid-"}}]}\n\n');
    })();

    await withServer({ ...deps(upstreamBody), metricsCollector: fakeCollector }, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("partial output cut mid-"), "already-delivered content must survive");
      assert.ok(text.includes('"error"'), "a structured error chunk must replace the normal ending");
      assert.equal(text.includes("data: [DONE]"), false, "a truncated stream must not look like a normal completion");
    });

    assert.ok(endedInfo, "recordEnd was called");
    assert.equal(endedInfo.status, 502, "truncation after content must latch a fault, not a healthy end");
  });

  it("flags silent truncation: clean [DONE] but tool arguments never parse, latch a 502 on the tracker", async () => {
    // The 静默截断 shape: the stream terminates cleanly, but the accumulated
    // tool-call argument string was cut midway and never parses as JSON.
    let endedInfo = null;
    const fakeCollector = {
      startRequest: () => ({
        recordFirstChunk: () => {},
        recordEnd: (info) => { endedInfo = info; },
      }),
    };
    const upstreamBody = (async function* () {
      const encoder = new TextEncoder();
      yield encoder.encode('data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"bash","arguments":"{\\"comma"}}]}}]}\n\n');
      yield encoder.encode('data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"nd\\":\\"ls -"}}]}}]}\n\n');
      yield encoder.encode('data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      yield encoder.encode("data: [DONE]\n\n");
    })();

    await withServer({ ...deps(upstreamBody), metricsCollector: fakeCollector }, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('"name":"bash"'), "already-delivered call metadata must survive");
      assert.ok(text.includes('"error"'), "a structured error chunk must replace the normal ending");
      assert.equal(text.includes("data: [DONE]"), false, "a truncated stream must not look like a normal completion");
    });

    assert.ok(endedInfo, "recordEnd was called");
    assert.equal(endedInfo.status, 502, "silent truncation must latch a fault, not a healthy end");
  });

  it("streams relay log entries over /api/internal/logs with token auth", async () => {
    const { createLogger } = await import("./logger.mjs");
    const logger = createLogger({ sink: () => {} });
    logger.info("relay-entry-1");

    const server = createOpenAIRelayServer({ ...deps(null), logger });
    const { port, close } = await listenLoopback(server, 0);
    try {
      // No token: 401.
      const unauth = await fetch(`http://127.0.0.1:${port}/api/internal/logs`);
      assert.equal(unauth.status, 401);

      // With token: SSE replay of history, then live entries.
      const res = await fetch(`http://127.0.0.1:${port}/api/internal/logs`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /text\/event-stream/);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const readFrame = async () => {
        for (;;) {
          const sep = buffer.indexOf("\n\n");
          if (sep !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data:"));
            if (line) return JSON.parse(line.slice(5).trim());
            continue;
          }
          const { done, value } = await reader.read();
          if (done) return null;
          buffer += decoder.decode(value, { stream: true });
        }
      };
      const first = await readFrame();
      assert.equal(first.message, "[info] relay-entry-1", "history replays for late joiners");
      logger.warn("relay-entry-live");
      const second = await readFrame();
      assert.equal(second.level, "warn");
      assert.ok(second.message.includes("relay-entry-live"), "live entries stream through");
      await reader.cancel();
    } finally {
      await close();
    }
  });

  it("skips history replay for /api/internal/logs?live=1 (bridge mode, no duplicates)", async () => {
    const { createLogger } = await import("./logger.mjs");
    const logger = createLogger({ sink: () => {} });
    logger.info("already-bridged-entry");

    const server = createOpenAIRelayServer({ ...deps(null), logger });
    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/internal/logs?live=1`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const readFrame = async () => {
        for (;;) {
          const sep = buffer.indexOf("\n\n");
          if (sep !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data:"));
            if (line) return JSON.parse(line.slice(5).trim());
            continue;
          }
          const { done, value } = await reader.read();
          if (done) return null;
          buffer += decoder.decode(value, { stream: true });
        }
      };
      // Only entries logged AFTER the subscription may arrive.
      logger.warn("post-subscribe-entry");
      let first;
      try {
        first = await readFrame();
        assert.ok(first.message.includes("post-subscribe-entry"), "live mode streams only new entries");
      } finally {
        await reader.cancel();
      }
    } finally {
      await close();
    }
  });
});

describe("openai relay upstream 5xx silent retry", () => {
  function sseStream(chunks) {
    const enc = new TextEncoder();
    return (async function* () {
      for (const c of chunks) yield enc.encode(c);
    })();
  }

  function retryDeps(upstreamFetch) {
    return {
      token: TOKEN,
      loadStore: () => ({ ok: true, store: STORE }),
      loadCredential: async () => ({ ok: true, value: "SENTINEL-UPSTREAM-KEY" }),
      upstreamFetch,
      recordGeneration: () => {},
      readGeneration: () => null,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
    };
  }

  it("retries a transient upstream 5xx (e.g. Cloudflare 522) before any content and delivers the recovered stream", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) return { ok: false, status: 522 };
      return { ok: true, status: 200, body: sseStream(['data: {"id":"1","choices":[{"delta":{"content":"recovered from 522"}}]}\n\n', "data: [DONE]\n\n"]) };
    };

    await withServer(retryDeps(upstreamFetch), async (port) => {
      const res = await postChat(port);
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

    await withServer(retryDeps(upstreamFetch), async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 522);
      const body = await res.json();
      assert.match(body.error.message, /status 522/, "the terminal error must carry the upstream status");
      assert.equal(callCount, 2, "initial attempt + 1 retry, then pass through");
    });
  });

  it("passes a 429 through immediately without a silent retry", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      return { ok: false, status: 429 };
    };

    await withServer(retryDeps(upstreamFetch), async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 429);
      await res.json();
      assert.equal(callCount, 1, "4xx/429 are terminal — no keep-alive retry");
    });
  });
});


describe("resident /v1/messages non-streaming usage mapping", () => {
  it("maps Anthropic-shaped usage to the OpenAI shape the aggregate tracker reads", async () => {
    let endedInfo = null;
    const fakeCollector = {
      startRequest: () => ({
        recordFirstChunk: () => {},
        recordEnd: (info) => {
          endedInfo = info;
        },
      }),
    };

    const server = createOpenAIRelayServer({
      token: TOKEN,
      loadStore: () => ({ ok: true, store: STORE }),
      loadCredential: async () => ({ ok: true, value: "SENTINEL-UPSTREAM-KEY" }),
      upstreamFetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: "cmpl-1",
          choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
      }),
      recordGeneration: () => {},
      readGeneration: () => null,
      metricsCollector: fakeCollector,
    });

    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: TOKEN,
          "content-type": "application/json",
          "user-agent": "claude-cli/2.0.0 (external, cli)",
        },
        body: JSON.stringify({
          model: "anthropic/poke-api/claude-opus-5",
          max_tokens: 64,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.usage.input_tokens, 11, "the client still gets the Anthropic-shaped usage");

      assert.ok(endedInfo, "tracker.recordEnd was called");
      // The tracker only reads prompt_tokens/completion_tokens — the raw
      // Anthropic shape ({input_tokens, output_tokens}) used to record 0.
      assert.equal(endedInfo.usage.prompt_tokens, 11);
      assert.equal(endedInfo.usage.completion_tokens, 7);
    } finally {
      await close();
    }
  });

  it("maps cache_read_input_tokens to cached_tokens (unit)", () => {
    assert.deepEqual(
      anthropicUsageToOpenAI({ input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 9 }),
      { prompt_tokens: 11, completion_tokens: 7, cached_tokens: 9 },
    );
    // No cache field -> no cached_tokens key at all (the tracker's fallback
    // chain treats a missing key and undefined identically, but the object
    // stays clean for the stats tab).
    assert.deepEqual(
      anthropicUsageToOpenAI({ input_tokens: 11, output_tokens: 7 }),
      { prompt_tokens: 11, completion_tokens: 7 },
    );
    assert.equal(anthropicUsageToOpenAI(undefined), undefined);
  });
});

// B·进程与端口安全: probeRelay is the trust check behind relay reuse (EADDRINUSE
// in listenLoopback) and relay start/stop status, so a bare 200 from an
// unrelated loopback service on 47821 must not count as "our relay" — GET /
// must answer {service:"anyswitch-relay"}.
describe("probeRelay (root-endpoint identity check)", () => {
  async function withMockServer(handler, fn) {
    const { createServer } = await import("node:http");
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      return await fn(server.address().port);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it("accepts the real relay: GET / answers {service:'anyswitch-relay'}", async () => {
    await withServer(deps(null), async (port) => {
      assert.equal(await probeRelay(port), true);
    });
  });

  it("rejects a 200 root body without the anyswitch-relay service marker", async () => {
    await withMockServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }, async (port) => {
      assert.equal(await probeRelay(port), false);
    });
  });

  it("rejects a server that only serves the legacy /api/hello probe", async () => {
    // Old probe shape: HEAD /api/hello → 200. A foreign or legacy server that
    // never answers GET / with the service marker must not be treated as the
    // relay.
    await withMockServer((req, res) => {
      if (req.url === "/api/hello") {
        res.writeHead(200, { "content-length": 0 });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    }, async (port) => {
      assert.equal(await probeRelay(port), false);
    });
  });

  it("rejects a non-JSON root body", async () => {
    await withMockServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("OK");
    }, async (port) => {
      assert.equal(await probeRelay(port), false);
    });
  });

  it("rejects a non-200 root status", async () => {
    await withMockServer((req, res) => {
      res.writeHead(404);
      res.end();
    }, async (port) => {
      assert.equal(await probeRelay(port), false);
    });
  });
});

// ── Responses routes (codex frontend) ──────────────────────────────────────
// /openai/<seg>/v1/responses[/compact]: Responses-shaped request in, translated
// chat/completions fan-out upstream, Responses SSE back. Same loopback-socket
// rig as the transport suite above.

function chatSseStream(lines) {
  return (async function* () {
    const encoder = new TextEncoder();
    for (const part of lines) yield encoder.encode(part);
  })();
}

const HEALTHY_CHAT_SSE = [
  'data: {"id":"chatcmpl-1","model":"claude-opus-5","created":1724900000,"choices":[{"delta":{"content":"hi"}}]}\n\n',
  'data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
  "data: [DONE]\n\n",
];

function responsesDeps(upstreamBody, captured = null) {
  return {
    token: TOKEN,
    loadStore: () => ({ ok: true, store: STORE }),
    loadCredential: async () => ({ ok: true, value: "SENTINEL-UPSTREAM-KEY" }),
    upstreamFetch: async (urls, init) => {
      if (captured) captured.body = JSON.parse(init.body);
      return { ok: true, status: 200, body: upstreamBody };
    },
    recordGeneration: () => {},
    readGeneration: () => null,
  };
}

function postResponses(port, tail = "/v1/responses", headers = {}, body = undefined) {
  return fetch(`http://127.0.0.1:${port}/openai/poke-api${tail}`, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {
      model: "claude-opus-5",
      instructions: "be terse",
      input: "hello",
      stream: true,
    }),
  });
}

describe("openai relay /responses routes (codex)", () => {
  it("hits the route, translates the request downstream and the stream back up", async () => {
    const captured = {};
    await withServer(responsesDeps(chatSseStream(HEALTHY_CHAT_SSE), captured), async (port) => {
      const res = await postResponses(port);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /text\/event-stream/);
      const text = await res.text();
      // Responses SSE dialect on the wire, with the codex load-bearing
      // invariants: msg_/resp_ id prefixes, usage details filled, literal
      // [DONE] terminator.
      assert.ok(text.includes("event: response.created"), "stream opens with response.created");
      assert.ok(text.includes("event: response.completed"), "stream ends with response.completed");
      assert.ok(text.includes('"id":"msg_resp_chatcmpl-1"'), "message item carries the msg_ prefix");
      assert.ok(text.includes('"reasoning_tokens":0'), "usage always carries output_tokens_details.reasoning_tokens");
      assert.ok(text.includes("data: [DONE]"), "literal [DONE] terminates the stream");
      assert.equal(text.includes("SENTINEL-UPSTREAM-KEY"), false, "must never leak the upstream key");

      // The upstream saw the translated chat/completions body: instructions
      // collapsed into a head system message, input as the user message,
      // streaming forced with usage riding the terminal chunk.
      assert.equal(captured.body.model, "claude-opus-5");
      assert.deepEqual(captured.body.messages, [
        { role: "system", content: "be terse" },
        { role: "user", content: "hello" },
      ]);
      assert.equal(captured.body.stream, true);
      assert.equal(captured.body.stream_options?.include_usage, true);
    });
  });

  it("routes /v1/responses/compact through the same pipeline", async () => {
    const captured = {};
    await withServer(responsesDeps(chatSseStream(HEALTHY_CHAT_SSE), captured), async (port) => {
      const res = await postResponses(port, "/v1/responses/compact");
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("event: response.completed"));
      assert.deepEqual(captured.body.messages, [
        { role: "system", content: "be terse" },
        { role: "user", content: "hello" },
      ]);
    });
  });

  it("returns 401 without a token", async () => {
    await withServer(responsesDeps(chatSseStream(HEALTHY_CHAT_SSE)), async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/openai/poke-api/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-5", input: "hello", stream: true }),
      });
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.error.type, "authentication_error");
    });
  });

  it("keeps the 404 fallback untouched around the new routes", async () => {
    await withServer(responsesDeps(chatSseStream(HEALTHY_CHAT_SSE)), async (port) => {
      // The compact suffix must not swallow further path tails...
      const extra = await postResponses(port, "/v1/responses/compactx");
      assert.equal(extra.status, 404);
      assert.equal((await extra.json()).error.type, "not_found_error");
      // ...and an unknown endpoint under the same segment still 404s.
      const unknown = await postResponses(port, "/v1/unknown");
      assert.equal(unknown.status, 404);
      assert.equal((await unknown.json()).error.type, "not_found_error");
    });
  });

  it("ends a mid-stream upstream failure with response.failed instead of [DONE]", async () => {
    const upstreamBody = (async function* () {
      const encoder = new TextEncoder();
      yield encoder.encode('data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"He"}}]}\n\n');
      throw new Error("upstream socket reset");
    })();

    await withServer(responsesDeps(upstreamBody), async (port) => {
      const res = await postResponses(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("He"), "already-delivered content must survive");
      assert.ok(text.includes("event: response.failed"), "the turn ends with response.failed");
      assert.equal(text.includes("data: [DONE]"), false, "no [DONE] may follow a failed response");
      assert.equal(text.includes("SENTINEL-UPSTREAM-KEY"), false, "must never leak the upstream key");
    });
  });

  // x-agent-id: codex is what the launcher injects; the UA branches are the
  // fallback for clients that bypass it.
  async function agentIdForResponsesRequest(headers) {
    let startedMeta = null;
    const fakeCollector = {
      startRequest: (meta) => {
        startedMeta = meta;
        return {
          recordFirstChunk: () => {},
          recordEnd: () => {},
        };
      },
    };
    const server = createOpenAIRelayServer({
      ...responsesDeps(chatSseStream(HEALTHY_CHAT_SSE)),
      metricsCollector: fakeCollector,
    });
    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await postResponses(port, "/v1/responses", headers);
      assert.equal(res.status, 200);
      await res.text();
      assert.ok(startedMeta, "metricsCollector.startRequest was called");
      return startedMeta.agentId;
    } finally {
      await close();
    }
  }

  it("accepts x-agent-id: codex as a known endpoint id", async () => {
    assert.equal(await agentIdForResponsesRequest({ "x-agent-id": "codex" }), "codex");
  });

  it("sniffs a codex_cli_rs User-Agent as codex", async () => {
    assert.equal(await agentIdForResponsesRequest({ "user-agent": "codex_cli_rs/0.55.0" }), "codex");
  });

  it("sniffs a codex-tui User-Agent as codex", async () => {
    assert.equal(await agentIdForResponsesRequest({ "user-agent": "codex-tui/1.0" }), "codex");
  });

  // prompt_cache_key 会话身份：codex 核心客户端（GUI app-server 与 CLI 共用）恒在
  // Responses 请求体写会话 id。实例归属优先级：prompt_cache_key 派生 >
  // x-agent-instance 头 > socket pid 兜底；非 codex 归属或无 key 时行为不变。
  async function instanceMetaForResponsesRequest(body, headers = {}, tail = "/v1/responses") {
    let startedMeta = null;
    const fakeCollector = {
      startRequest: (meta) => {
        startedMeta = meta;
        return {
          recordFirstChunk: () => {},
          recordEnd: () => {},
        };
      },
    };
    const server = createOpenAIRelayServer({
      ...responsesDeps(chatSseStream(HEALTHY_CHAT_SSE)),
      metricsCollector: fakeCollector,
    });
    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await postResponses(port, tail, { "x-agent-id": "codex", ...headers }, body);
      assert.equal(res.status, 200);
      await res.text();
      assert.ok(startedMeta, "metricsCollector.startRequest was called");
      return startedMeta;
    } finally {
      await close();
    }
  }

  function responsesBody(extra = {}) {
    return { model: "claude-opus-5", input: "hello", stream: true, ...extra };
  }

  it("derives the instance id from prompt_cache_key as codex-sess-<会话 id>", async () => {
    const meta = await instanceMetaForResponsesRequest(
      responsesBody({ prompt_cache_key: "018f6c2a-1234-7abc-8def-0123456789ab" }),
    );
    assert.equal(meta.agentId, "codex");
    assert.equal(meta.instanceId, "codex-sess-018f6c2a-1234-7abc-8def-0123456789ab");
  });

  it("folds repeat requests of one session into the same instance and splits different sessions", async () => {
    const a1 = await instanceMetaForResponsesRequest(responsesBody({ prompt_cache_key: "sess-alpha" }));
    const a2 = await instanceMetaForResponsesRequest(responsesBody({ input: "hello again", prompt_cache_key: "sess-alpha" }));
    const b = await instanceMetaForResponsesRequest(responsesBody({ prompt_cache_key: "sess-beta" }));
    assert.equal(a1.instanceId, "codex-sess-sess-alpha");
    assert.equal(a2.instanceId, a1.instanceId);
    assert.equal(b.instanceId, "codex-sess-sess-beta");
  });

  it("derives the same session instance on the compact route", async () => {
    const meta = await instanceMetaForResponsesRequest(
      responsesBody({ prompt_cache_key: "sess-compact" }),
      {},
      "/v1/responses/compact",
    );
    assert.equal(meta.instanceId, "codex-sess-sess-compact");
  });

  it("lets prompt_cache_key win over the x-agent-instance header", async () => {
    const meta = await instanceMetaForResponsesRequest(
      responsesBody({ prompt_cache_key: "sess-win" }),
      { "x-agent-instance": "launcher-tag-1" },
    );
    assert.equal(meta.instanceId, "codex-sess-sess-win");
  });

  it("falls back to the x-agent-instance header when prompt_cache_key is absent", async () => {
    const meta = await instanceMetaForResponsesRequest(
      responsesBody(),
      { "x-agent-instance": "launcher-tag-1" },
    );
    assert.equal(meta.instanceId, "launcher-tag-1");
  });

  it("leaves a non-codex agent carrying prompt_cache_key on the header/fallback path", async () => {
    const meta = await instanceMetaForResponsesRequest(
      responsesBody({ prompt_cache_key: "sess-not-codex" }),
      { "x-agent-id": "kimi", "x-agent-instance": "kimi-inst-1" },
    );
    assert.equal(meta.agentId, "kimi");
    assert.equal(meta.instanceId, "kimi-inst-1");
  });

  it("cleans non-whitelist characters out of the session id", async () => {
    // 内部子会话的 "{source}:{parent_thread_id}" 形状里冒号天然合法；空白等
    // 白名单外字符折成 "-"。
    const meta = await instanceMetaForResponsesRequest(
      responsesBody({ prompt_cache_key: "guardian:018f6c2a dead beef" }),
    );
    assert.equal(meta.instanceId, "codex-sess-guardian:018f6c2a-dead-beef");
  });

  it("caps the derived session id at the instance-id length limit", async () => {
    const meta = await instanceMetaForResponsesRequest(
      responsesBody({ prompt_cache_key: "a".repeat(120) }),
    );
    assert.equal(meta.instanceId.length, INSTANCE_ID_MAX_LEN);
    assert.ok(meta.instanceId.startsWith("codex-sess-"));
  });

  it("never forwards prompt_cache_key to the upstream", async () => {
    const captured = {};
    await withServer(responsesDeps(chatSseStream(HEALTHY_CHAT_SSE), captured), async (port) => {
      const res = await postResponses(port, "/v1/responses", { "x-agent-id": "codex" },
        responsesBody({ prompt_cache_key: "018f6c2a-1234-7abc-8def-0123456789ab" }));
      assert.equal(res.status, 200);
      await res.text();
      // 翻译层是字段级白名单（EXTRA_CHAT_PASSTHROUGH_FIELDS 不含它），会话身份
      // 字段只用于归属，绝不透给第三方上游。
      assert.equal("prompt_cache_key" in captured.body, false);
    });
  });

  // ── codex 后台/内部请求的分类与面板隔离 ──────────────────────────────
  // 引擎/GUI 自发流量（记忆流水线、guardian、预热、GUI 线程标题/摘要生成等）
  // 带线上标记，命中其一即判后台（isCodexBackgroundRequest）：实例身份三条通道
  //（prompt_cache_key 派生 / x-agent-instance 头 / socket pid 兜底）全部跳过，
  // meta.background 传给 agent-metrics 压报错面与展示面。turn/compaction/
  // 用户可见 thread_source/无标记/坏 JSON 一律按用户流量——宁可漏判一个后台
  // 请求，也绝不错杀真实用户流量。
  const turnMeta = (obj) => JSON.stringify(obj);

  it("unit: each of the four wire markers classifies the request as background", () => {
    assert.equal(isCodexBackgroundRequest(
      { headers: { "x-codex-turn-metadata": turnMeta({ request_kind: "memory", thread_source: "user" }) } }, {},
    ), true, "request_kind=memory");
    assert.equal(isCodexBackgroundRequest(
      { headers: { "x-codex-turn-metadata": turnMeta({ request_kind: "prewarm" }) } }, {},
    ), true, "request_kind=prewarm");
    // 四者命中其一即后台：thread_source 的后台值优先于 request_kind=turn。
    assert.equal(isCodexBackgroundRequest(
      { headers: { "x-codex-turn-metadata": turnMeta({ request_kind: "turn", thread_source: "memory_consolidation" }) } }, {},
    ), true, "thread_source=memory_consolidation wins even on a turn kind");
    assert.equal(isCodexBackgroundRequest(
      { headers: { "x-codex-turn-metadata": turnMeta({ request_kind: "turn", thread_source: "guardian_review" }) } }, {},
    ), true, "thread_source=guardian_review");
    assert.equal(isCodexBackgroundRequest({ headers: { "x-openai-subagent": "guardian" } }, {}), true, "x-openai-subagent 头存在即后台");
    assert.equal(isCodexBackgroundRequest({ headers: { "x-openai-memgen-request": "true" } }, {}), true, "x-openai-memgen-request: true");
  });

  it("unit: GUI hidden-helper thread sources classify as background even on a turn kind", () => {
    // 引擎 ThreadSource::Feature(String) 把 GUI 建线程时传的 feature 名原样
    // 透传进 thread_source；这些 ephemeral 元数据线程（模型硬编码
    // gpt-5.6-luna、effort=low）是后台流量，即便 request_kind 是普通 turn。
    for (const source of [
      "thread_title",
      "thread_description",
      "thread_summary",
      "thread_title_reconsideration",
      "ambient_suggestion_safety",
      "ambient_suggestions",
      "dictation_cleanup",
      "guardian_classifier",
    ]) {
      assert.equal(isCodexBackgroundRequest(
        { headers: { "x-codex-turn-metadata": turnMeta({ request_kind: "turn", thread_source: source }) } }, {},
      ), true, `thread_source=${source}`);
    }
  });

  it("unit: turn_trigger hits the same background table when thread_source is absent or user-shaped", () => {
    // GUI 建线程传 threadSource、发 turn 传 turnTrigger，同源同值；任一通道
    // 缺失时另一个兜底。thread_source 缺失或为用户值不掩护 turn_trigger 命中。
    assert.equal(isCodexBackgroundRequest(
      { headers: { "x-codex-turn-metadata": turnMeta({ request_kind: "turn", turn_trigger: "thread_title" }) } }, {},
    ), true, "turn_trigger=thread_title without thread_source");
    assert.equal(isCodexBackgroundRequest(
      { headers: { "x-codex-turn-metadata": turnMeta({ request_kind: "turn", thread_source: "user", turn_trigger: "dictation_cleanup" }) } }, {},
    ), true, "thread_source=user does not shield a background turn_trigger");
  });

  it("unit: user-visible thread sources stay user traffic", () => {
    // 与 GUI 任务列表的可见性白名单同口径：这些来源对应用户看得见的工作，
    // 误杀会丢实例行与报错横幅。
    for (const source of [
      "user",
      "agent_created_thread",
      "agent_forked_thread",
      "ambient_suggestion_task",
      "code_review",
      "conversation_digest",
      "implement_todo",
      "automation",
      "automated_review",
      "conversational_onboarding",
      "inline_edit",
    ]) {
      assert.equal(isCodexBackgroundRequest(
        { headers: { "x-codex-turn-metadata": turnMeta({ request_kind: "turn", thread_source: source, turn_trigger: source }) } }, {},
      ), false, `thread_source=${source} must stay user traffic`);
    }
  });

  it("unit: turn/compaction kinds and markerless requests stay user traffic", () => {
    assert.equal(isCodexBackgroundRequest(
      { headers: { "x-codex-turn-metadata": turnMeta({ request_kind: "turn", thread_source: "user", turn_trigger: "user" }) } }, {},
    ), false, "request_kind=turn");
    assert.equal(isCodexBackgroundRequest(
      { headers: { "x-codex-turn-metadata": turnMeta({ request_kind: "compaction", thread_source: "user" }) } }, {},
    ), false, "request_kind=compaction");
    assert.equal(isCodexBackgroundRequest({ headers: {} }, {}), false, "no markers at all");
    assert.equal(isCodexBackgroundRequest({ headers: { "x-openai-memgen-request": "false" } }, {}), false, "显式 false 不算标记");
  });

  it("unit: unparseable or non-object metadata degrades to user traffic", () => {
    assert.equal(isCodexBackgroundRequest({ headers: { "x-codex-turn-metadata": "{not-json" } }, {}), false, "坏 JSON");
    assert.equal(isCodexBackgroundRequest({ headers: { "x-codex-turn-metadata": "[1,2]" } }, {}), false, "数组不是对象");
    assert.equal(isCodexBackgroundRequest({ headers: { "x-codex-turn-metadata": "\"memory\"" } }, {}), false, "裸字符串不是对象");
  });

  it("unit: falls back to body client_metadata when the header copy is missing or unparseable", () => {
    const body = { client_metadata: { "x-codex-turn-metadata": turnMeta({ request_kind: "memory", thread_source: "memory_consolidation" }) } };
    assert.equal(isCodexBackgroundRequest({ headers: {} }, body), true, "头缺失时 body 里的同一份 metadata 生效");
    assert.equal(isCodexBackgroundRequest({ headers: { "x-codex-turn-metadata": "{broken" } }, body), true, "头解析失败回落 body 副本");
  });

  it("gives background requests no instance id — session key and header channels both skipped", async () => {
    const meta = await instanceMetaForResponsesRequest(
      responsesBody({ prompt_cache_key: "sess-bg" }),
      {
        "x-agent-instance": "launcher-tag-1",
        "x-codex-turn-metadata": turnMeta({ request_kind: "memory", thread_source: "memory_consolidation" }),
      },
    );
    assert.equal(meta.agentId, "codex");
    assert.equal(meta.background, true, "background 标记随 meta 传给 agent-metrics");
    assert.equal(meta.instanceId, null, "prompt_cache_key 派生与 x-agent-instance 头都被跳过");
  });

  it("gives a GUI title-generation turn no instance row — the ghost-session regression shape", async () => {
    // 实机复发形态（2026-09-13）：GUI 标题生成线程以 request_kind=turn +
    // thread_source=thread_title + 一次性线程 id 作 prompt_cache_key 打到
    // relay，旧检测器只认 memory_consolidation/guardian_review，漏判出一行
    // codex-sess-* 幽灵实例。
    const meta = await instanceMetaForResponsesRequest(
      responsesBody({ prompt_cache_key: "01a09912-e5db-7463-99f2-20609d61ff43" }),
      {
        "x-codex-turn-metadata": turnMeta({ request_kind: "turn", thread_source: "thread_title", turn_trigger: "thread_title" }),
      },
    );
    assert.equal(meta.agentId, "codex");
    assert.equal(meta.background, true, "标题生成线程判后台");
    assert.equal(meta.instanceId, null, "一次性线程 id 不产生实例行");
  });

  it("never consults the socket pid fallback or the late-bind channel for background traffic", async () => {
    let startedMeta = null;
    const counters = { lookups: 0, subscriptions: 0, attaches: 0 };
    const fakeCollector = {
      startRequest: (meta) => {
        startedMeta = meta;
        return {
          recordFirstChunk: () => {},
          recordEnd: () => {},
          attachInstance: () => { counters.attaches += 1; },
        };
      },
    };
    const server = createOpenAIRelayServer({
      ...responsesDeps(null),
      // 两条请求共用一台 server，上游流必须每次新建（生成器消费一次即尽）。
      upstreamFetch: async () => ({ ok: true, status: 200, body: chatSseStream(HEALTHY_CHAT_SSE) }),
      metricsCollector: fakeCollector,
      socketOwner: {
        lookup: () => { counters.lookups += 1; return 987654; },
        onRefresh: () => { counters.subscriptions += 1; return () => {}; },
      },
    });
    const { port, close } = await listenLoopback(server, 0);
    try {
      // 对照组先行：无标记用户流量照常走 socket pid 兜底，证明桩本身是通的。
      const userRes = await postResponses(port, "/v1/responses", { "x-agent-id": "codex" }, responsesBody());
      assert.equal(userRes.status, 200);
      await userRes.text();
      assert.equal(startedMeta.background, false);
      assert.equal(startedMeta.instanceId, "codex-987654", "user traffic keeps the socket pid fallback");
      const afterControl = { ...counters };
      assert.ok(afterControl.lookups > 0 && afterControl.subscriptions > 0, "control request must exercise the stub");

      const bgRes = await postResponses(port, "/v1/responses", {
        "x-agent-id": "codex",
        "x-codex-turn-metadata": turnMeta({ request_kind: "prewarm" }),
      }, responsesBody({ prompt_cache_key: "sess-bg" }));
      assert.equal(bgRes.status, 200);
      await bgRes.text();
      assert.equal(startedMeta.background, true);
      assert.equal(startedMeta.instanceId, null, "后台请求连 socket pid 兜底也跳过");
      assert.deepEqual(counters, afterControl, "后台请求零次反查、零次订阅、零次迟挂");
    } finally {
      await close();
    }
  });
});

// ── 渠道限定模型 slug（<channelId>~<modelId>）──────────────────────────────
// codex 目录把渠道编码进 slug；relay 入口剥离并以该渠道路由（选模型即选渠
// 道），URL 段 provider 退化为未编码模型的回落。store 用两条独立渠道，靠
// 上游 URL 与 tracker 归属证明路由落点。

const SLUG_STORE = {
  version: 2,
  providers: {
    "poke-api": {
      displayName: "Poke",
      baseURL: "https://poke.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "poke-api.dpapi",
      models: { "claude-opus-5": { displayName: "Opus 5" } },
    },
    nim: {
      displayName: "NIM",
      baseURL: "https://nim.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "nim.dpapi",
      models: { "deepseek-chat": { displayName: "DS" } },
    },
  },
};

function slugDeps(upstreamBody, captured) {
  return {
    token: TOKEN,
    loadStore: () => ({ ok: true, store: SLUG_STORE }),
    loadCredential: async () => ({ ok: true, value: "SENTINEL-UPSTREAM-KEY" }),
    upstreamFetch: async (url, init) => {
      captured.url = url;
      captured.body = JSON.parse(init.body);
      return { ok: true, status: 200, body: upstreamBody };
    },
    recordGeneration: () => {},
    readGeneration: () => null,
    metricsCollector: {
      startRequest: (meta) => {
        captured.meta = meta;
        return { recordFirstChunk: () => {}, recordEnd: () => {} };
      },
    },
  };
}

function postSlugChat(port, model) {
  return fetch(`http://127.0.0.1:${port}/openai/poke-api/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hello" }] }),
  });
}

describe("channel-qualified model slugs (<channel>~<model>)", () => {
  it("chat route: the slug's channel wins over the URL segment, upstream sees the bare model", async () => {
    const captured = {};
    await withServer(slugDeps(chatSseStream(HEALTHY_CHAT_SSE), captured), async (port) => {
      const res = await postSlugChat(port, "nim~deepseek-chat");
      assert.equal(res.status, 200);
      await res.text();
      assert.ok(String(captured.url).startsWith("https://nim.invalid/"), "routed by the slug's channel, not the URL segment's");
      assert.equal(captured.body.model, "deepseek-chat", "the upstream never sees the channel prefix");
      assert.equal(captured.meta.providerId, "nim", "journal/stats attribute the real channel");
      assert.equal(captured.meta.model, "deepseek-chat");
    });
  });

  it("responses route: the same rewrite happens ahead of the translator", async () => {
    const captured = {};
    await withServer(slugDeps(chatSseStream(HEALTHY_CHAT_SSE), captured), async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/openai/poke-api/v1/responses`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ model: "nim~deepseek-chat", instructions: "be terse", input: "hello", stream: true }),
      });
      assert.equal(res.status, 200);
      await res.text();
      assert.ok(String(captured.url).startsWith("https://nim.invalid/"));
      assert.equal(captured.body.model, "deepseek-chat");
      assert.equal(captured.meta.providerId, "nim");
    });
  });

  it("unknown-channel slugs pass through untouched: the URL segment keeps routing", async () => {
    const captured = {};
    await withServer(slugDeps(chatSseStream(HEALTHY_CHAT_SSE), captured), async (port) => {
      const res = await postSlugChat(port, "unknown~x");
      assert.equal(res.status, 404, "poke-api does not carry the model — proof the request stayed on the URL segment's channel");
      assert.equal(captured.url, undefined, "upstream never called");
      assert.equal(captured.meta.providerId, "poke-api");
      assert.equal(captured.meta.model, "unknown~x");
    });
  });

  it("bare model ids keep today's URL-segment routing verbatim", async () => {
    const captured = {};
    await withServer(slugDeps(chatSseStream(HEALTHY_CHAT_SSE), captured), async (port) => {
      const res = await postSlugChat(port, "claude-opus-5");
      assert.equal(res.status, 200);
      await res.text();
      assert.ok(String(captured.url).startsWith("https://poke.invalid/"));
      assert.equal(captured.body.model, "claude-opus-5");
      assert.equal(captured.meta.providerId, "poke-api");
    });
  });
});
