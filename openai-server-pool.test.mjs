import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRelayServer, listenLoopback } from "./openai-server.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";

const TOKEN = "test-token-pool";

// Two-member pool plus a pool that reuses its first member's id (the
// pools-before-providers tie break). member-c carries no shared model and
// only exists to prove model filtering.
const STORE = {
  version: 2,
  providers: {
    "member-a": {
      displayName: "Member A",
      baseURL: "http://member-a.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "member-a.dpapi",
      models: {
        "gpt-pool": { displayName: "GPT Pool from A" },
        "gpt-a-only": { displayName: "A only" },
      },
    },
    "member-b": {
      displayName: "Member B",
      baseURL: "http://member-b.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "member-b.dpapi",
      models: {
        "gpt-pool": { displayName: "GPT Pool from B" },
        "gpt-b-only": { displayName: "B only" },
      },
    },
    "member-c": {
      displayName: "Member C",
      baseURL: "http://member-c.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "member-c.dpapi",
      models: {
        "gpt-pool": { displayName: "GPT Pool from C" },
        "gpt-c-only": { displayName: "C only" },
      },
    },
    "member-d": {
      displayName: "Member D",
      baseURL: "http://member-d.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "member-d.dpapi",
      models: {
        "gpt-pool": { displayName: "GPT Pool from D" },
      },
    },
  },
  pools: {
    "test-pool": { displayName: "Test Pool", members: ["member-a", "member-b"] },
    // Pool id identical to a member provider id: the pool must win routing.
    // (A provider may belong to exactly one pool, so this pool has its own
    // member pair.)
    "member-c": { displayName: "Same-name Pool", members: ["member-c", "member-d"] },
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

async function withServer(deps, fn) {
  const server = createOpenAIRelayServer(deps);
  const { port, close } = await listenLoopback(server, 0);
  try {
    return await fn(port);
  } finally {
    await close();
  }
}

function postChat(port, { poolId = "test-pool", model = "gpt-pool", stream = true } = {}) {
  return fetch(`http://127.0.0.1:${port}/openai/${poolId}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      model,
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
      `data: {"id":"1","choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n`,
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

const NO_RETRY = () => ({ enabled: true, maxRetries: 0, backoffMs: 10 });

describe("pool routing: streaming", () => {
  it("(happy) delivers the first member's stream and calls no other member", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => healthyStream("hello from A"),
      "member-b": () => healthyStream("hello from B"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("hello from A"));
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

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on B"));
      assert.deepEqual(calls, ["member-a", "member-b"]);

      // Metrics: the pool is one attempt-level statistical unit, so the
      // failed attempt and the recovery both count into the pool row from the URL.
      const stability = await collector.getModelStability();
      const failed = stability.models.find((x) => x.provider === "test-pool" && x.model === "gpt-pool");
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

    await withServer(deps, async (port) => {
      const res = await postChat(port);
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

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on B"));
      assert.deepEqual(calls, ["member-a", "member-b"]);
    });
  });

  it("(per-member budget) keep-alive retries stay inside the member before failover", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => emptyStream(),
      "member-b": () => healthyStream("recovered on B"),
    });
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on B"));
      assert.deepEqual(calls, ["member-a", "member-a", "member-b"],
        "member-a gets its full keep-alive budget (1 retry) before the failover");
    });
  });

  it("(400) passes a request-shaped 4xx straight through without failover", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => statusError(400),
      "member-b": () => healthyStream("must never be sent"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
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

    await withServer(deps, async (port) => {
      const res = await postChat(port);
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
          yield enc.encode('data: {"id":"1","choices":[{"delta":{"content":"partial content"}}]}\n\n');
          throw new Error("upstream socket died");
        })(),
      }),
      "member-b": () => healthyStream("must never be sent"),
    });
    const deps = createMockDeps({
      upstreamFetch,
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 2, backoffMs: 10 }),
    });

    await withServer(deps, async (port) => {
      const res = await postChat(port);
      assert.equal(res.status, 200, "headers were already committed");
      const text = await res.text();
      assert.ok(text.includes("partial content"));
      assert.ok(text.includes("the upstream stream failed mid-response"));
      assert.deepEqual(calls, ["member-a"], "committed content is the red line: no failover, no retry");
    });
  });

  it("(same-name) a pool id that equals a member provider id still routes as a pool", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-c": () => statusError(503),
      "member-d": () => healthyStream("recovered on D"),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port, { poolId: "member-c" });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("recovered on D"),
        "pool resolution must win over the provider with the same id, so failover happens");
      assert.deepEqual(calls, ["member-c", "member-d"]);
    });
  });
});

describe("pool routing: non-streaming", () => {
  it("(happy) delivers the first member's response", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "A says hi" } }] }) }),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port, { stream: false });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.choices[0].message.content, "A says hi");
      assert.deepEqual(calls, ["member-a"]);
    });
  });

  it("(sticky) a member that recovered the pool becomes the next request's first try", async () => {
    let memberAFails = true;
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => (memberAFails ? statusError(503) : healthyStream("A again")),
      "member-b": async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "B says hi" } }] }) }),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      // 连续两次请求级失败才锁定降级（失败才降级，黄灯不降）：两个请求都
      // 走 [member-a(503) → member-b(ok)]，第二次失败才把粘性位移到 member-b。
      for (let round = 0; round < 2; round += 1) {
        const res = await postChat(port, { stream: false });
        assert.equal(res.status, 200);
        assert.deepEqual(calls, ["member-a", "member-b"], `round ${round + 1} fails over to member-b`);
        calls.length = 0;
      }

      memberAFails = false; // member-a is healthy again; the latched sticky still prefers member-b
      const second = await postChat(port, { stream: false });
      assert.equal(second.status, 200);
      const body = await second.json();
      assert.equal(body.choices[0].message.content, "B says hi");
      assert.deepEqual(calls, ["member-b"], "sticky member leads the next request");
    });
  });

  it("(all down, non-stream) the client receives the last member's error", async () => {
    const { upstreamFetch, calls } = memberRouter({
      "member-a": () => statusError(502),
      "member-b": () => statusError(401),
    });
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port, { stream: false });
      assert.equal(res.status, 401);
      assert.deepEqual(calls, ["member-a", "member-b"]);
    });
  });
});

describe("pool routing: models and pre-flight", () => {
  it("GET /models returns the member catalog union in pool order, deduplicated", async () => {
    const { upstreamFetch, calls } = memberRouter({});
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/openai/test-pool/v1/models`, {
        headers: { authorization: TOKEN },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(
        body.data.map((m) => m.id),
        ["gpt-pool", "gpt-a-only", "gpt-b-only"],
        "union in pool order; the duplicate gpt-pool appears once",
      );
      assert.deepEqual(calls, [], "model listing must not call any upstream");
    });
  });

  it("rejects a model no pool member carries with 404 and no upstream call", async () => {
    const { upstreamFetch, calls } = memberRouter({});
    const deps = createMockDeps({ upstreamFetch, getKeepAliveConfig: NO_RETRY });

    await withServer(deps, async (port) => {
      const res = await postChat(port, { model: "gpt-c-only" });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.match(body.error.message, /not in pool "test-pool"/);
      assert.deepEqual(calls, []);
    });
  });
});
