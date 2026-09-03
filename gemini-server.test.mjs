import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAIRelayServer } from "./openai-server.mjs";
import { createPanelRouter } from "./panel.mjs";
import { createAliasResolver } from "./antigravity-alias.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";
import { openAIToGemini } from "./gemini-protocol.mjs";

function startTestServer(deps, port = 0) {
  const server = createOpenAIRelayServer(deps);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" ? address.port : port;
      resolve({
        port: actualPort,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

describe("gemini server routes and panel antigravity APIs", () => {
  const mockStore = {
    version: 2,
    providers: {
      "acme-default": {
        displayName: "acme default",
        baseURL: "https://mock.api/v1",
        protocol: "openai-compatible",
        credentialFile: "acme.dpapi",
        models: {
          "gemini-3.7-flash": { displayName: "Gemini 3.7 Flash" },
          "gemini-3.6-flash": { displayName: "Gemini 3.6 Flash" },
        },
      },
    },
  };

  const overlay = {
    "gemini-3.7-flash": "acme-default/gemini-3.7-flash",
  };
  const aliasResolver = createAliasResolver({ filePath: "mock-nonexistent.json", overlay });

  // The panel router's POST route validates alias targets against the store ON
  // DISK (the same enabled set the handler will resolve against), so the mock
  // store is also materialized into a temp file here.
  const tmpRoot = mkdtempSync(join(tmpdir(), "apicred-gemini-server-test-"));
  process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));
  writeFileSync(join(tmpRoot, "store.json"), JSON.stringify(mockStore));

  const deps = {
    token: "test-relay-token-12345",
    loadStore: () => ({ ok: true, store: mockStore }),
    loadCredential: async () => ({ ok: true, value: "mock-api-key" }),
    upstreamFetch: async (urls, options) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Hello from upstream" } }],
        }),
      };
    },
    aliasResolver,
    panelRouter: createPanelRouter({
      storePaths: { root: tmpRoot, storeFile: join(tmpRoot, "store.json") },
      logger: { info() {}, warn() {}, error() {} },
      aliasResolver,
    }),
  };

  it("handles GET /v1beta/models with valid api key", async () => {
    const srv = await startTestServer(deps);
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/v1beta/models?key=${deps.token}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.models);
      assert.ok(data.models.some((m) => m.name === "models/gemini-3.7-flash"));
    } finally {
      await srv.close();
    }
  });

  it("rejects GET /v1beta/models with invalid api key", async () => {
    const srv = await startTestServer(deps);
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/v1beta/models?key=wrong-token`);
      assert.strictEqual(res.status, 401);
    } finally {
      await srv.close();
    }
  });

  it("handles POST /v1beta/models/gemini-3.7-flash:generateContent via upstream dispatch", async () => {
    const srv = await startTestServer(deps);
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/v1beta/models/gemini-3.7-flash:generateContent`, {
        method: "POST",
        headers: {
          "x-goog-api-key": deps.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
        }),
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.candidates);
      assert.strictEqual(data.candidates[0].content.parts[0].text, "Hello from upstream");
    } finally {
      await srv.close();
    }
  });

  it("serves GET and POST /panel/api/antigravity/aliases", async () => {
    const srv = await startTestServer(deps);
    try {
      // 1. GET aliases
      const getRes = await fetch(`http://127.0.0.1:${srv.port}/panel/api/antigravity/aliases`);
      assert.strictEqual(getRes.status, 200);
      const getData = await getRes.json();
      assert.strictEqual(getData.ok, true);
      assert.strictEqual(getData.aliases["gemini-3.7-flash"], "acme-default/gemini-3.7-flash");

      // 2. POST update aliases
      const postRes = await fetch(`http://127.0.0.1:${srv.port}/panel/api/antigravity/aliases`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-apicred-panel": "1",
          origin: `http://127.0.0.1:${srv.port}`,
        },
        body: JSON.stringify({
          aliases: {
            "gemini-3.7-flash": "acme-default/gemini-3.7-flash",
            "gemini-3.6-flash": "acme-default/gemini-3.6-flash",
          },
        }),
      });
      assert.strictEqual(postRes.status, 200);
      const postData = await postRes.json();
      assert.strictEqual(postData.ok, true);
      assert.strictEqual(postData.aliases["gemini-3.6-flash"], "acme-default/gemini-3.6-flash");

      // 3. Verify hot-reloaded alias in resolver
      assert.strictEqual(aliasResolver.snapshot()["gemini-3.6-flash"], "acme-default/gemini-3.6-flash");
    } finally {
      await srv.close();
    }
  });

  it("serves GET /panel/api/antigravity/options", async () => {
    const srv = await startTestServer(deps);
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/panel/api/antigravity/options`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ok, true);
      assert.ok(Array.isArray(data.slugs));
      assert.ok(data.options);
      assert.ok(data.aliases);
    } finally {
      await srv.close();
    }
  });
});

describe("gemini keep-alive anti-truncation", () => {
  const mockStore = {
    version: 2,
    providers: {
      "acme-default": {
        displayName: "acme default",
        baseURL: "https://mock.api/v1",
        protocol: "openai-compatible",
        credentialFile: "acme.dpapi",
        models: { "gemini-3.7-flash": { displayName: "Gemini 3.7 Flash" } },
      },
    },
  };
  const aliasResolver = createAliasResolver({
    filePath: "mock-nonexistent.json",
    overlay: { "gemini-3.7-flash": "acme-default/gemini-3.7-flash" },
  });

  function sseStream(chunks) {
    const enc = new TextEncoder();
    return (async function* () {
      for (const c of chunks) yield enc.encode(c);
    })();
  }

  function makeDeps(upstreamFetch, metricsCollector) {
    return {
      token: "test-relay-token-12345",
      loadStore: () => ({ ok: true, store: mockStore }),
      loadCredential: async () => ({ ok: true, value: "mock-api-key" }),
      upstreamFetch,
      aliasResolver,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
      metricsCollector,
    };
  }

  function postGenerate(port) {
    return fetch(`http://127.0.0.1:${port}/v1beta/models/gemini-3.7-flash:streamGenerateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": "test-relay-token-12345", "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
  }

  it("(a) recovers on empty stream via 1 keep-alive retry and delivers the retried text", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return { ok: true, status: 200, body: sseStream(['data: {"id":"1","choices":[{"delta":{}}]}\n\n', "data: [DONE]\n\n"]) };
      }
      return { ok: true, status: 200, body: sseStream(['data: {"id":"2","choices":[{"delta":{"content":"recovered text"}}]}\n\n', "data: [DONE]\n\n"]) };
    };
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const srv = await startTestServer(makeDeps(upstreamFetch, collector));
    try {
      const res = await postGenerate(srv.port);
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered text"), "client must receive the retried stream's payload");
      assert.equal(callCount, 2);

      const status = await collector.getAgentsStatus();
      const agy = status.find((a) => a.id === "agy");
      assert.equal(agy.metrics.keepAlive.retries, 1);
      assert.equal(agy.metrics.keepAlive.recoveries, 1);
      assert.equal(agy.errorActive, false);
    } finally {
      await srv.close();
    }
  });

  it("(b) exhausts retries on a persistently empty stream and returns a 502", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      return { ok: true, status: 200, body: sseStream(['data: {"id":"1","choices":[{"delta":{}}]}\n\n', "data: [DONE]\n\n"]) };
    };
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const srv = await startTestServer(makeDeps(upstreamFetch, collector));
    try {
      const res = await postGenerate(srv.port);
      assert.strictEqual(res.status, 502);
      assert.equal(callCount, 2);

      const status = await collector.getAgentsStatus();
      const agy = status.find((a) => a.id === "agy");
      assert.equal(agy.metrics.keepAlive.exhausted, 1);
      assert.equal(agy.errorActive, true);
    } finally {
      await srv.close();
    }
  });

  it("(c) enhanced mode holds the turn but never emits SSE comment pings (agy's genai SDK rejects ': ping')", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"1","choices":[{"delta":{"content":"held text"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    });
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = makeDeps(upstreamFetch, collector);
    deps.getKeepAliveConfig = () => ({ enabled: true, mode: "enhanced", maxRetries: 1, backoffMs: 10 });
    const srv = await startTestServer(deps);
    try {
      const res = await postGenerate(srv.port);
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes(": ping"), "gemini stream must not contain SSE comment pings");
      assert.ok(text.trim().startsWith("data:"), "first chunk must be a real SSE data event, not a comment");
      assert.ok(text.includes("held text"), "the held turn must be released to the client after the verdict");
    } finally {
      await srv.close();
    }
  });

  it("(d) retries a transient upstream 5xx (e.g. Cloudflare 522) before any content and delivers the recovered stream", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      if (callCount === 1) return { ok: false, status: 522 };
      return { ok: true, status: 200, body: sseStream(['data: {"id":"1","choices":[{"delta":{"content":"recovered from 522"}}]}\n\n', "data: [DONE]\n\n"]) };
    };
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const srv = await startTestServer(makeDeps(upstreamFetch, collector));
    try {
      const res = await postGenerate(srv.port);
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered from 522"), "client must receive the retried stream after the transient 5xx");
      assert.equal(callCount, 2);

      const status = await collector.getAgentsStatus();
      const agy = status.find((a) => a.id === "agy");
      assert.equal(agy.metrics.keepAlive.retries, 1);
      assert.equal(agy.metrics.keepAlive.recoveries, 1);
      assert.equal(agy.errorActive, false);
    } finally {
      await srv.close();
    }
  });

  it("(e) surfaces the upstream 5xx only after retries are exhausted", async () => {
    let callCount = 0;
    const upstreamFetch = async () => {
      callCount += 1;
      return { ok: false, status: 522 };
    };
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const srv = await startTestServer(makeDeps(upstreamFetch, collector));
    try {
      const res = await postGenerate(srv.port);
      assert.strictEqual(res.status, 522);
      const text = await res.text();
      assert.ok(text.includes("the upstream provider returned status 522"), "the terminal error must carry the upstream status");
      assert.equal(callCount, 2);

      const status = await collector.getAgentsStatus();
      const agy = status.find((a) => a.id === "agy");
      assert.equal(agy.errorActive, true);
    } finally {
      await srv.close();
    }
  });
});


describe("gemini usage cached-token pass-through", () => {
  const mockStore = {
    version: 2,
    providers: {
      "acme-default": {
        displayName: "acme default",
        baseURL: "https://mock.api/v1",
        protocol: "openai-compatible",
        credentialFile: "acme.dpapi",
        models: { "gemini-3.7-flash": { displayName: "Gemini 3.7 Flash" } },
      },
    },
  };
  const aliasResolver = createAliasResolver({
    filePath: "mock-nonexistent.json",
    overlay: { "gemini-3.7-flash": "acme-default/gemini-3.7-flash" },
  });

  function sseStream(chunks) {
    const enc = new TextEncoder();
    return (async function* () {
      for (const c of chunks) yield enc.encode(c);
    })();
  }

  function makeDeps(upstreamFetch, metricsCollector) {
    return {
      token: "test-relay-token-12345",
      loadStore: () => ({ ok: true, store: mockStore }),
      loadCredential: async () => ({ ok: true, value: "mock-api-key" }),
      upstreamFetch,
      aliasResolver,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 0, backoffMs: 10 }),
      metricsCollector,
    };
  }

  it("openAIToGemini resolves cachedContentTokenCount via the three-level fallback chain", () => {
    const base = { choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "stop" }] };
    assert.strictEqual(
      openAIToGemini({ ...base, usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } } }, "gemini-3.7-flash").usageMetadata.cachedContentTokenCount,
      6,
    );
    assert.strictEqual(
      openAIToGemini({ ...base, usage: { prompt_tokens: 10, completion_tokens: 4, prompt_cache_hit_tokens: 5 } }, "gemini-3.7-flash").usageMetadata.cachedContentTokenCount,
      5,
    );
    assert.strictEqual(
      openAIToGemini({ ...base, usage: { prompt_tokens: 10, completion_tokens: 4, cached_tokens: 3 } }, "gemini-3.7-flash").usageMetadata.cachedContentTokenCount,
      3,
    );
    assert.strictEqual(
      openAIToGemini({ ...base, usage: { prompt_tokens: 10, completion_tokens: 4 } }, "gemini-3.7-flash").usageMetadata.cachedContentTokenCount,
      0,
    );
  });

  it("non-streaming generateContent surfaces cachedContentTokenCount in usageMetadata", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } },
      }),
    });
    const srv = await startTestServer(makeDeps(upstreamFetch));
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/v1beta/models/gemini-3.7-flash:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": "test-relay-token-12345", "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.usageMetadata.promptTokenCount, 10);
      assert.strictEqual(data.usageMetadata.candidatesTokenCount, 4);
      assert.strictEqual(data.usageMetadata.cachedContentTokenCount, 6);
    } finally {
      await srv.close();
    }
  });

  it("streaming passes cached tokens to the wire usageMetadata and the aggregate tracker", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"cached_tokens":6}}\n\n',
        "data: [DONE]\n\n",
      ]),
    });
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const srv = await startTestServer(makeDeps(upstreamFetch, collector));
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/v1beta/models/gemini-3.7-flash:streamGenerateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": "test-relay-token-12345", "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      });
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('"cachedContentTokenCount":6'), "the wire usageMetadata carries the cached count");

      const status = await collector.getAgentsStatus();
      const agy = status.find((a) => a.id === "agy");
      assert.equal(agy.metrics.tokens.prompt, 10);
      assert.equal(agy.metrics.tokens.completion, 4);
      assert.equal(agy.metrics.tokens.cached, 6, "the aggregate tracker receives the cached count");
    } finally {
      await srv.close();
    }
  });
});
