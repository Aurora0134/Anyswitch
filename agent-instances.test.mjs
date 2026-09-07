// Per-instance metrics groundwork: the multi-instance endpoints (kimi /
// opencode / pi) tag each CLI instance with an instanceId — the
// x-agent-instance header on the OpenAI/Anthropic relay paths. Tagged requests land in
// BOTH the endpoint aggregate bucket (existing cards unchanged) and a
// per-instance bucket; untagged requests only land in the aggregate.
// Instance liveness splits by id shape: "<agentId>-<pid>" ids (the fallback
// below, or process-start placeholder rows) are reconciled against the
// process scan; custom ids keep a read-driven idle TTL. The fallback channel
// covers clients launched straight from the terminal (bypassing the
// launcher): a netstat socket→PID snapshot synthesizes "<agentId>-<pid>"
// when the header is absent
// (instance-socket-owner.mjs; the header always wins).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createAgentMetricsCollector,
  createSessionReporter,
  sanitizeInstanceId,
} from "./agent-metrics.mjs";
import { createOpenAIRelayServer, listenLoopback } from "./openai-server.mjs";

const silentExec = (cmd, opts, cb) => cb(null, "");

// WMIC lineage-scan builder: returns an execFn answering every probe with a
// scan whose rows are the given launcher chain (ParentProcessId column
// present). Shared by the launcher-id normalization tests below.
function lineageChainExec(...rows) {
  const scan = "Node,CommandLine,Name,ParentProcessId,ProcessId\r\n" + rows.join("\r\n") + "\r\n";
  return (cmd, opts, cb) => cb(null, scan);
}

function testCollector(opts) {
  return createAgentMetricsCollector({ loadSparkSettings: false, execFn: silentExec, ...opts });
}

describe("sanitizeInstanceId", () => {
  it("accepts charset-whitelisted ids", () => {
    assert.equal(sanitizeInstanceId("ws-1"), "ws-1");
    assert.equal(sanitizeInstanceId("host.local:8080"), "host.local:8080");
    assert.equal(sanitizeInstanceId("A_b.C"), "A_b.C");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(sanitizeInstanceId("  ws-1  "), "ws-1");
  });

  it("rejects non-strings, empty, overlong and off-whitelist values", () => {
    assert.equal(sanitizeInstanceId(null), null);
    assert.equal(sanitizeInstanceId(undefined), null);
    assert.equal(sanitizeInstanceId(42), null);
    assert.equal(sanitizeInstanceId(""), null);
    assert.equal(sanitizeInstanceId("   "), null);
    assert.equal(sanitizeInstanceId("x".repeat(65)), null);
    assert.equal(sanitizeInstanceId("bad id!"), null);
    assert.equal(sanitizeInstanceId("ws/1"), null);
    assert.equal(sanitizeInstanceId("ws?1"), null);
  });
});

describe("per-instance aggregate tracking", () => {
  it("tracks instances separately while the endpoint aggregate keeps the totals", async () => {
    let t = 1000;
    const collector = testCollector({ nowFn: () => t });

    const a1 = collector.startRequest({ agentId: "kimi", instanceId: "ws-a", providerId: "p1", model: "m1", stream: true, path: "openai" });
    t = 1500;
    a1.recordFirstChunk();
    t = 2500; // 1.0s generation
    a1.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 50 } });

    const b1 = collector.startRequest({ agentId: "kimi", instanceId: "ws-b", providerId: "p1", model: "m1", stream: false, path: "openai" });
    t = 3500;
    b1.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });

    // Untagged request: aggregate only, no instance bucket.
    const u1 = collector.startRequest({ agentId: "kimi", providerId: "p1", model: "m1" });
    t = 4500;
    u1.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });

    const status = await collector.getAgentsStatus();
    const kimi = status.find((a) => a.id === "kimi");
    assert.equal(kimi.metrics.totalRequests, 3, "aggregate counts tagged and untagged requests");
    assert.equal(kimi.metrics.tokens.prompt, 111);

    assert.ok(Array.isArray(kimi.instances), "multi-instance endpoint exposes an instances array");
    assert.deepEqual(kimi.instances.map((i) => i.id), ["ws-a", "ws-b"], "firstSeen order");

    const wsA = kimi.instances[0];
    assert.equal(wsA.title, "ws-a");
    assert.equal(wsA.status, "idle");
    assert.equal(wsA.requests, 1);
    assert.equal(wsA.tokens.prompt, 100);
    assert.equal(wsA.tokens.completion, 50);
    assert.equal(wsA.tps, 50); // 50 tokens / 1.0s
    assert.equal(wsA.lastTtftMs, 500);
    assert.equal(wsA.firstSeen, 1000);
    assert.equal(wsA.lastSeen, 2500);

    const wsB = kimi.instances[1];
    assert.equal(wsB.requests, 1);
    assert.equal(wsB.tokens.prompt, 10);
  });

  it("exposes instances for all three scoped endpoints and none for the rest", async () => {
    let t = 1000;
    const collector = testCollector({ nowFn: () => t });
    for (const agentId of ["kimi", "opencode", "pi"]) {
      // Non-pid-form id: the silent exec mock reports zero processes, and a
      // "<agentId>-<digits>" id would be (correctly) reconciled away as a
      // dead-pid instance — that path is covered in agent-metrics.test.mjs.
      const req = collector.startRequest({ agentId, instanceId: `${agentId}-one`, model: "m1" });
      t += 100;
      req.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
    // Aggregate-only endpoints must not sprout instance buckets even when tagged.
    const z = collector.startRequest({ agentId: "zcode", instanceId: "z-1", model: "m1" });
    z.recordEnd({ status: 200, usage: {} });
    const d = collector.startRequest({ agentId: "dsh", instanceId: "d-1", model: "m1" });
    d.recordEnd({ status: 200, usage: {} });

    const status = await collector.getAgentsStatus();
    for (const agentId of ["kimi", "opencode", "pi"]) {
      const agent = status.find((a) => a.id === agentId);
      assert.deepEqual(agent.instances.map((i) => i.id), [`${agentId}-one`], `${agentId} instance`);
    }
    for (const agentId of ["zcode", "dsh", "reasonix", "claude"]) {
      const agent = status.find((a) => a.id === agentId);
      assert.equal("instances" in agent, false, `${agentId} must stay aggregate-only`);
    }
  });

  it("drops an invalid instanceId silently and tracks aggregate-only", async () => {
    const collector = testCollector({ nowFn: () => 1000 });
    const req = collector.startRequest({ agentId: "kimi", instanceId: "bad id!", model: "m1" });
    req.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });

    const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.equal(kimi.metrics.totalRequests, 1);
    assert.deepEqual(kimi.instances, []);
  });

  it("attaches a late instance id to the in-flight request without double-counting the aggregate", async () => {
    let t = 1000;
    const collector = testCollector({ nowFn: () => t });
    const req = collector.startRequest({ agentId: "kimi", providerId: "p1", model: "m1", stream: true });

    let kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.equal(kimi.metrics.totalRequests, 1);
    assert.deepEqual(kimi.instances, [], "untagged in-flight request stays aggregate-only");

    t = 1500;
    req.attachInstance("kimi-ws");
    kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.equal(kimi.instances.length, 1);
    assert.equal(kimi.instances[0].id, "kimi-ws");
    assert.equal(kimi.instances[0].status, "active");
    assert.equal(kimi.instances[0].activeRequests, 1);
    assert.equal(kimi.metrics.totalRequests, 1, "late attach must not increment the endpoint card again");

    t = 2500;
    req.recordFirstChunk();
    t = 3500;
    req.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 4 } });

    kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.equal(kimi.metrics.totalRequests, 1);
    assert.equal(kimi.metrics.tokens.prompt, 10);
    assert.equal(kimi.instances[0].status, "idle");
    assert.equal(kimi.instances[0].requests, 1);
    assert.equal(kimi.instances[0].tokens.prompt, 10);
    assert.equal(kimi.instances[0].tokens.completion, 4);
  });

  it("ignores attachInstance after the request has already ended", async () => {
    const collector = testCollector({ nowFn: () => 1000 });
    const req = collector.startRequest({ agentId: "kimi", model: "m1" });
    req.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
    req.attachInstance("kimi-late");

    const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.deepEqual(kimi.instances, []);
    assert.equal(kimi.metrics.totalRequests, 1);
  });

  it("marks a live instance active while a request is in flight", async () => {
    let t = 1000;
    const collector = testCollector({ nowFn: () => t });
    const req = collector.startRequest({ agentId: "opencode", instanceId: "oc-1", model: "m1" });
    t = 2000;
    const status = await collector.getAgentsStatus();
    const inst = status.find((a) => a.id === "opencode").instances[0];
    assert.equal(inst.status, "active");
    assert.equal(inst.activeRequests, 1);
    req.recordEnd({ status: 200, usage: {} });
  });

  it("expires an idle instance past the TTL but keeps the aggregate history", async () => {
    let t = 1000;
    const collector = testCollector({ nowFn: () => t });
    const req = collector.startRequest({ agentId: "pi", instanceId: "pi-old", model: "m1" });
    req.recordEnd({ status: 200, usage: { prompt_tokens: 5, completion_tokens: 2 } });

    let pi = (await collector.getAgentsStatus()).find((a) => a.id === "pi");
    assert.equal(pi.instances.length, 1);

    t = 1000 + 10 * 60 * 1000; // exactly at TTL boundary — still listed
    pi = (await collector.getAgentsStatus()).find((a) => a.id === "pi");
    assert.equal(pi.instances.length, 1);

    t += 1; // past the TTL
    pi = (await collector.getAgentsStatus()).find((a) => a.id === "pi");
    assert.deepEqual(pi.instances, []);
    assert.equal(pi.metrics.totalRequests, 1, "aggregate keeps the instance's history");
    assert.equal(pi.metrics.tokens.prompt, 5);
  });

  it("never expires an instance with in-flight requests", async () => {
    let t = 1000;
    // A live pi process keeps the orphan-settle path from touching the
    // instance's in-flight counter (endpoint gone => settle, tested elsewhere).
    const piExec = (cmd, opts, cb) => cb(null, "Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\Tools\\node.exe C:\\x\\node_modules\\pi\\bin\\main.js,node.exe,4321\r\n");
    const collector = testCollector({ execFn: piExec, nowFn: () => t });
    collector.startRequest({ agentId: "pi", instanceId: "pi-busy", model: "m1" });
    t = 1000 + 11 * 60 * 1000;
    const pi = (await collector.getAgentsStatus()).find((a) => a.id === "pi");
    // pi-busy (custom id, in-flight) never expires; the scanned live PID
    // additionally gets a zero-count placeholder row (process-start 上屏),
    // sorted after it by firstSeen.
    assert.deepEqual(pi.instances.map((i) => i.id), ["pi-busy", "pi-4321"]);
    assert.equal(pi.instances[0].status, "active");
    assert.equal(pi.instances[1].status, "idle");
    assert.equal(pi.instances[1].requests, 0);
  });
});

describe("usage journal instanceId", () => {
  function fakeJournal() {
    const lines = [];
    return { lines, appendRequest: (entry) => lines.push(entry) };
  }

  it("writes instanceId when the request carries one, omits the key otherwise", () => {
    const journal = fakeJournal();
    const collector = testCollector({ nowFn: () => 1000, journal });

    const tagged = collector.startRequest({ agentId: "kimi", instanceId: "ws-a", providerId: "p1", model: "m1", path: "openai" });
    tagged.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const untagged = collector.startRequest({ agentId: "kimi", providerId: "p1", model: "m1", path: "openai" });
    untagged.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });

    assert.equal(journal.lines.length, 2, "the mirror tracker must not double-journal");
    assert.equal(journal.lines[0].instanceId, "ws-a");
    assert.equal("instanceId" in journal.lines[1], false);
  });
});

describe("openai relay x-agent-instance header", () => {
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

  function sseUpstream() {
    return (async function* () {
      const enc = new TextEncoder();
      yield enc.encode('data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\n\n');
      yield enc.encode("data: [DONE]\n\n");
    })();
  }

  function relayDeps(collector) {
    return {
      token: TOKEN,
      loadStore: () => ({ ok: true, store: STORE }),
      loadCredential: async () => ({ ok: true, value: "SENTINEL-UPSTREAM-KEY" }),
      upstreamFetch: async () => ({ ok: true, status: 200, body: sseUpstream() }),
      recordGeneration: () => {},
      readGeneration: () => null,
      metricsCollector: collector,
    };
  }

  function postChat(port, headers) {
    return fetch(`http://127.0.0.1:${port}/openai/poke-api/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: TOKEN, "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "claude-opus-5", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
  }

  it("tags the endpoint instance from the x-agent-instance header", async () => {
    const collector = testCollector();
    const server = createOpenAIRelayServer(relayDeps(collector));
    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await postChat(port, { "x-agent-id": "kimi", "x-agent-instance": "ws-A" });
      assert.equal(res.status, 200);
      await res.text();

      const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
      assert.deepEqual(kimi.instances.map((i) => i.id), ["ws-A"]);
      assert.equal(kimi.instances[0].requests, 1);
      assert.equal(kimi.metrics.totalRequests, 1, "aggregate still counts the tagged request");
    } finally {
      await close();
    }
  });

  it("drops an invalid header value without rejecting the request", async () => {
    const collector = testCollector();
    const server = createOpenAIRelayServer(relayDeps(collector));
    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await postChat(port, { "x-agent-id": "kimi", "x-agent-instance": "bad id!" });
      assert.equal(res.status, 200);
      await res.text();

      const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
      assert.deepEqual(kimi.instances, []);
      assert.equal(kimi.metrics.totalRequests, 1);
    } finally {
      await close();
    }
  });

  it("normalizes a launcher-injected header id (<cwd基名>-<launcher pid>) to the client pid", async () => {
    // Lineage chain (see agent-metrics scanProcesses): launcher node.exe
    // (1000) → cmd /c shim (1001) → kimi client (4321). The header carries
    // the launcher pid; the collector folds the id into the canonical
    // client-pid form and keeps the cwd basename as the row label.
    const chainExec = lineageChainExec(
      "LAPTOP,C:\\Tools\\node.exe C:\\app\\kimi-launcher.mjs,node.exe,500,1000",
      "LAPTOP,,cmd.exe,1000,1001",
      "LAPTOP,C:\\Tools\\node.exe C:\\x\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs,node.exe,1001,4321");
    const collector = testCollector({ execFn: chainExec });
    await collector.scanProcesses(); // warm the cache — the panel-open steady state
    const server = createOpenAIRelayServer(relayDeps(collector));
    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await postChat(port, { "x-agent-id": "kimi", "x-agent-instance": "myproj-1000" });
      assert.equal(res.status, 200);
      await res.text();

      const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
      assert.deepEqual(kimi.instances.map((i) => i.id), ["kimi-4321"]);
      assert.equal(kimi.instances[0].title, "myproj");
      assert.equal(kimi.instances[0].requests, 1);
      assert.equal(kimi.metrics.totalRequests, 1, "aggregate still counts the tagged request");
    } finally {
      await close();
    }
  });
});

describe("openai relay socket→PID fallback (no instance header)", () => {
  // 绕过 launcher 直连（终端敲 npm shim）的客户端不带 x-agent-instance，
  // relay 用 netstat 快照反查 keep-alive 连接对端进程，合成
  // "<agentId>-<pid>"（instance-socket-owner.mjs）。这里注入桩 socketOwner。

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

  function sseUpstream() {
    return (async function* () {
      const enc = new TextEncoder();
      yield enc.encode('data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\n\n');
      yield enc.encode("data: [DONE]\n\n");
    })();
  }

  function relayDeps(collector, socketOwner) {
    return {
      token: TOKEN,
      loadStore: () => ({ ok: true, store: STORE }),
      loadCredential: async () => ({ ok: true, value: "SENTINEL-UPSTREAM-KEY" }),
      upstreamFetch: async () => ({ ok: true, status: 200, body: sseUpstream() }),
      recordGeneration: () => {},
      readGeneration: () => null,
      metricsCollector: collector,
      socketOwner,
    };
  }

  function postChat(port, headers) {
    return fetch(`http://127.0.0.1:${port}/openai/poke-api/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: TOKEN, "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "claude-opus-5", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
  }

  function stubOwner(pid) {
    const seen = [];
    return { seen, socketOwner: { lookup: (args) => { seen.push(args); return pid; } } };
  }

  it("synthesizes kimi-<pid> when the instance header is absent", async () => {
    // The synthesized id is pid-form, so PID reconciliation applies: the
    // scan mock must report pid 4321 as a live kimi process or the row is
    // evicted as dead on the status read.
    const kimiPidExec = (cmd, opts, cb) => cb(null, "Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\Tools\\node.exe C:\\x\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs,node.exe,4321\r\n");
    const collector = testCollector({ execFn: kimiPidExec });
    const { seen, socketOwner } = stubOwner(4321);
    const server = createOpenAIRelayServer(relayDeps(collector, socketOwner));
    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await postChat(port, { "x-agent-id": "kimi" });
      assert.equal(res.status, 200);
      await res.text();

      // 接线口径：localPort = relay 端口，remotePort = 客户端临时端口
      assert.equal(seen.length, 1);
      assert.equal(seen[0].localPort, port);
      assert.equal(typeof seen[0].remotePort, "number");
      assert.ok(seen[0].remotePort > 0);

      const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
      assert.deepEqual(kimi.instances.map((i) => i.id), ["kimi-4321"]);
      assert.equal(kimi.instances[0].requests, 1);
      assert.equal(kimi.metrics.totalRequests, 1, "aggregate still counts the fallback-tagged request");
    } finally {
      await close();
    }
  });

  it("header wins over the socket fallback", async () => {
    const collector = testCollector();
    const { socketOwner } = stubOwner(4321);
    const server = createOpenAIRelayServer(relayDeps(collector, socketOwner));
    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await postChat(port, { "x-agent-id": "kimi", "x-agent-instance": "ws-A" });
      assert.equal(res.status, 200);
      await res.text();

      const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
      assert.deepEqual(kimi.instances.map((i) => i.id), ["ws-A"], "launcher-injected header is the source of truth");
    } finally {
      await close();
    }
  });

  it("zcode never falls back (aggregate-only endpoint)", async () => {
    const collector = testCollector();
    const { seen, socketOwner } = stubOwner(4321);
    const server = createOpenAIRelayServer(relayDeps(collector, socketOwner));
    const { port, close } = await listenLoopback(server, 0);
    try {
      // 无 x-agent-id、无识别 UA：openaiAgentIdFrom 兜底为 zcode
      const res = await postChat(port, {});
      assert.equal(res.status, 200);
      await res.text();

      const zcode = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
      assert.equal("instances" in zcode, false, "zcode stays aggregate-only");
      assert.equal(seen.length, 0, "the fallback must not even consult the snapshot for zcode");
      assert.equal(zcode.metrics.totalRequests, 1);
    } finally {
      await close();
    }
  });

  it("attaches kimi-<pid> to an in-flight request once a late netstat snapshot lands", async () => {
    const kimiPidExec = (cmd, opts, cb) => cb(null, "Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\Tools\\node.exe C:\\x\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs,node.exe,4321\r\n");
    const collector = testCollector({ execFn: kimiPidExec });
    const listeners = new Set();
    const socketOwner = {
      lookup: () => null,
      onRefresh: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    const delayedUpstream = async () => {
      await new Promise((r) => setImmediate(r));
      socketOwner.lookup = () => 4321;
      for (const fn of [...listeners]) fn();
      await new Promise((r) => setImmediate(r));
      return { ok: true, status: 200, body: sseUpstream() };
    };
    const deps = relayDeps(collector, socketOwner);
    deps.upstreamFetch = delayedUpstream;
    const server = createOpenAIRelayServer(deps);
    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await postChat(port, { "x-agent-id": "kimi" });
      assert.equal(res.status, 200);
      await res.text();
      const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
      assert.deepEqual(kimi.instances.map((i) => i.id), ["kimi-4321"]);
      assert.equal(kimi.instances[0].requests, 1);
      assert.equal(kimi.metrics.totalRequests, 1);
    } finally {
      await close();
    }
  });

  it("does not tag when the socket owner reports the relay's own pid (self-loop)", async () => {
    const collector = testCollector();
    const { socketOwner } = stubOwner(process.pid);
    const server = createOpenAIRelayServer(relayDeps(collector, socketOwner));
    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await postChat(port, { "x-agent-id": "kimi" });
      assert.equal(res.status, 200);
      await res.text();

      const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
      assert.deepEqual(kimi.instances, [], "self-loop pid must not become a fake instance");
      assert.equal(kimi.metrics.totalRequests, 1);
    } finally {
      await close();
    }
  });
});

describe("claude session reporter model fields", () => {
  it("carries model/providerId in the snapshot and into the panel session", async () => {
    const posts = [];
    const reporter = createSessionReporter({
      reportUrl: "http://127.0.0.1:9/unreachable",
      fetchFn: async (url, opts) => { posts.push(JSON.parse(opts.body)); },
      nowFn: () => 1000,
    });
    reporter.setClaudePid(4321);
    reporter.startRequest({ model: "claude-opus-5", providerId: "poke-api", stream: true, path: "anthropic" });
    reporter.recordFirstChunk();
    reporter.recordEnd({ status: 200, usage: { input_tokens: 10, output_tokens: 5 } });

    const last = posts.at(-1);
    assert.equal(last.model, "claude-opus-5");
    assert.equal(last.providerId, "poke-api");

    const claudeExec = (cmd, opts, cb) => cb(null, "Node,CommandLine,ProcessId\r\nLAPTOP,C:\\Programs\\claude.exe,4321\r\n");
    // nowFn past the 2500ms process-scan cache window so the first status read
    // actually scans (a fresh collector's cache starts empty at time 0).
    const collector = testCollector({ execFn: claudeExec, nowFn: () => 3000 });
    collector.reportSession("tok", last);

    const claude = (await collector.getAgentsStatus()).find((a) => a.id === "claude");
    const session = claude.sessions.find((s) => s.id === "pid-4321");
    assert.ok(session);
    assert.equal(session.model, "claude-opus-5");
    assert.equal(session.providerId, "poke-api");
  });
});
