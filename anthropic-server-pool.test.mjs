// Anthropic-path pool routing tests (phase 2): real loopback sockets against
// both Anthropic entries — the resident relay (createOpenAIRelayServer,
// /v1/messages) and the per-launch relay (createRelayServer). Synthetic
// store, mock upstream. No real credentials, no real network egress, no DPAPI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRelayServer, listenLoopback as listenResident } from "./openai-server.mjs";
import { createRelayServer, listenLoopback as listenPerLaunch } from "./server.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";

const TOKEN = "test-token-anthropic-pool";

// Two-member pool. member-c carries no shared model and only exists to prove
// model filtering.
const STORE = {
  version: 2,
  providers: {
    "member-a": {
      displayName: "Member A",
      baseURL: "http://member-a.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "member-a.dpapi",
      models: {
        "claude-pool": { displayName: "Claude Pool from A" },
        "claude-a-only": { displayName: "A only" },
      },
    },
    "member-b": {
      displayName: "Member B",
      baseURL: "http://member-b.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "member-b.dpapi",
      models: {
        "claude-pool": { displayName: "Claude Pool from B" },
        "claude-b-only": { displayName: "B only" },
      },
    },
    "member-c": {
      displayName: "Member C",
      baseURL: "http://member-c.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "member-c.dpapi",
      models: {
        "claude-c-only": { displayName: "C only" },
      },
    },
  },
  pools: {
    "test-pool": { displayName: "Test Pool", members: ["member-a", "member-b"] },
  },
};

// Routes upstream calls by baseURL host: behaviors maps memberId -> () =>
// handler-shaped result (or throws). `calls` records the member order.
function memberRouter(behaviors) {
  const calls = [];
  const upstreamFetch = async (urls) => {
    const url = Array.isArray(urls) ? urls[0] : urls;
    const memberId = new URL(url).host.split(".")[0];
    calls.push(memberId);
    const behavior = behaviors[memberId];
    if (!behavior) throw new Error(`unexpected upstream call to member "${memberId}"`);
    return behavior();
  };
  return { upstreamFetch, calls };
}

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

async function withResident(deps, fn) {
  const server = createOpenAIRelayServer(deps);
  const { port, close } = await listenResident(server, 0);
  try {
    return await fn(port);
  } finally {
    await close();
  }
}

async function withPerLaunch(deps, fn) {
  const server = createRelayServer(deps);
  const { port, close } = await listenPerLaunch(server);
  try {
    return await fn(port);
  } finally {
    await close();
  }
}

function postMessages(port, { model = "anthropic/test-pool/claude-pool", stream = true } = {}) {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

function sseStream(chunks) {
  return (async function* () {
    const enc = new TextEncoder();
    for (const c of chunks) yield enc.encode(c);
  })();
}

function healthyStream(text) {
  return {
    ok: true,
    status: 200,
    body: sseStream([
      `data: {"id":"1","choices":[{"delta":{"content":${JSON.stringify(text)}},"index":0}]}\n\n`,
      'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":2,"completion_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ]),
  };
}

function emptyStream() {
  return {
    ok: true,
    status: 200,
    body: sseStream([
      'data: {"id":"1","choices":[{"delta":{}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  };
}

function statusError(status) {
  return { ok: false, status, body: { error: { message: `upstream ${status}` } } };
}

function nonStreamJson(text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: "cmpl-1",
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    }),
  };
}

const NO_RETRY = () => ({ enabled: true, maxRetries: 0, backoffMs: 10 });

describe("resident relay /v1/messages pool routing: streaming", () => {
  it("(happy) delivers the first member's stream and calls no other member", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => healthyStream("hello from A"),
      "member-b": () => healthyStream("hello from B"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withResident(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("hello from A"));
      assert.ok(text.includes("event: message_stop"), "the stream must translate to Anthropic events");
      assert.deepEqual(calls, ["member-a"]);
    });
  });

  it("(5xx) fails over to the next member when the first returns 503", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => statusError(503),
      "member-b": () => healthyStream("recovered on B"),
    });
    const collector = createAgentMetricsCollector({ nowFn: () => 1000, execFn: (cmd, opts, cb) => cb(null, "") });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY, metricsCollector: collector });

    await withResident(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on B"));
      assert.deepEqual(calls, ["member-a", "member-b"]);

      // Metrics: the pool is one attempt-level statistical unit, so the
      // failed attempt and the recovery both count into the pool row from the wire ID.
      const stability = await collector.getModelStability();
      // The anthropic tracker keys the row on the bare model id (the wire
      // "anthropic/" prefix is endpoint identity spoofing, stripped at
      // startRequest), same as the gemini/openai paths.
      const failed = stability.models.find((x) => x.provider === "test-pool" && x.model === "claude-pool");
      assert.ok(failed, "stability must record the failed attempt against the pool");
      assert.equal(failed.total, 2, "attempt-level: the failed member attempt and the recovery both count");
      assert.equal(failed.successRate, 50.0);
      const agents = await collector.getAgentsStatus();
      const zcode = agents.find((a) => a.id === "zcode");
      assert.equal(zcode.lastProvider, "test-pool", "tracker main key is the pool id");
    });
  });

  it("(401) fails over to the next member on an auth fault", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => statusError(401),
      "member-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withResident(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on B"));
      assert.deepEqual(calls, ["member-a", "member-b"]);
    });
  });

  it("(truncation) an empty first-member stream backs off to the next member", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => emptyStream(),
      "member-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withResident(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on B"));
      assert.deepEqual(calls, ["member-a", "member-b"]);
    });
  });

  it("(400) passes a request-shaped 4xx straight through without failover", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => statusError(400),
      "member-b": () => healthyStream("must never be sent"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withResident(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error.message, /returned status 400/);
      assert.deepEqual(calls, ["member-a"], "400 must not trigger failover");
    });
  });

  it("(all down) the client receives the LAST member's error", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => statusError(503),
      "member-b": () => statusError(429),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withResident(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 429, "the last member's status surfaces");
      const body = await res.json();
      assert.match(body.error.message, /returned status 429/);
      assert.deepEqual(calls, ["member-a", "member-b"]);
    });
  });

  it("(committed) never switches members once content bytes were delivered", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => ({
        ok: true,
        status: 200,
        body: (async function* () {
          const enc = new TextEncoder();
          yield enc.encode('data: {"id":"1","choices":[{"delta":{"content":"partial content"},"index":0}]}\n\n');
          throw new Error("upstream socket died");
        })(),
      }),
      "member-b": () => healthyStream("must never be sent"),
    });
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 2, backoffMs: 10 }),
    });

    await withResident(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200, "headers were already committed");
      const text = await res.text();
      assert.ok(text.includes("partial content"));
      assert.ok(text.includes("event: error"), "the mid-stream fault rides an Anthropic error frame");
      assert.deepEqual(calls, ["member-a"], "committed content is the red line: no failover, no retry");
    });
  });
});

describe("resident relay /v1/messages pool routing: non-streaming", () => {
  it("(happy) delivers the first member's response translated to Anthropic shape", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => nonStreamJson("A says hi"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withResident(deps, async (port) => {
      const res = await postMessages(port, { stream: false });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.type, "message");
      assert.equal(body.content[0].text, "A says hi");
      assert.deepEqual(calls, ["member-a"]);
    });
  });

  it("(sticky) a member that recovered the pool becomes the next request's first try", async () => {
    let memberAFails = true;
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => (memberAFails ? statusError(503) : nonStreamJson("A again")),
      "member-b": () => nonStreamJson("B says hi"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withResident(deps, async (port) => {
      // 连续两次请求级失败才锁定降级（失败才降级，黄灯不降）。
      for (let round = 0; round < 2; round += 1) {
        const res = await postMessages(port, { stream: false });
        assert.equal(res.status, 200);
        assert.deepEqual(calls, ["member-a", "member-b"], `round ${round + 1} fails over to member-b`);
        calls.length = 0;
      }

      memberAFails = false; // member-a is healthy again; the latched sticky still prefers member-b
      const second = await postMessages(port, { stream: false });
      assert.equal(second.status, 200);
      const body = await second.json();
      assert.equal(body.content[0].text, "B says hi");
      assert.deepEqual(calls, ["member-b"], "sticky member leads the next request");
    });
  });

  it("(all down, non-stream) the client receives the last member's error", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => statusError(502),
      "member-b": () => statusError(401),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withResident(deps, async (port) => {
      const res = await postMessages(port, { stream: false });
      assert.equal(res.status, 401);
      assert.deepEqual(calls, ["member-a", "member-b"]);
    });
  });

  it("rejects a model no pool member carries with 404 and no upstream call", async () => {
    const { upstreamFetch, calls } = memberRouter({});
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withResident(deps, async (port) => {
      const res = await postMessages(port, { model: "anthropic/test-pool/claude-c-only" });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.match(body.error.message, /not in pool "test-pool"/);
      assert.deepEqual(calls, []);
    });
  });
});

describe("per-launch relay /v1/messages pool routing", () => {
  it("(streaming 5xx) fails over to the next member", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => statusError(503),
      "member-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on B"));
      assert.deepEqual(calls, ["member-a", "member-b"]);
    });
  });

  it("(non-stream, sticky) drives members through the keep-alive loop and remembers the winner", async () => {
    let memberAFails = true;
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => (memberAFails ? statusError(503) : nonStreamJson("A again")),
      "member-b": () => nonStreamJson("B says hi"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withPerLaunch(deps, async (port) => {
      // 连续两次请求级失败才锁定降级（失败才降级，黄灯不降）。
      for (let round = 0; round < 2; round += 1) {
        const res = await postMessages(port, { stream: false });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.content[0].text, "B says hi");
        assert.deepEqual(calls, ["member-a", "member-b"], `round ${round + 1} fails over to member-b`);
        calls.length = 0;
      }

      memberAFails = false; // member-a is healthy again; the latched sticky still prefers member-b
      const second = await postMessages(port, { stream: false });
      assert.equal(second.status, 200);
      const body = await second.json();
      assert.equal(body.content[0].text, "B says hi");
      assert.deepEqual(calls, ["member-b"], "non-stream success through the loop updates the sticky table");
    });
  });
});
