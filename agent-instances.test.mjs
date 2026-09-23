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
import { EventEmitter } from "node:events";
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

// Same stdin/stdout shim as agent-metrics.test.mjs: the collector's fast
// probe is a resident powershell child; tests inject execFn only, so fake the
// child and route each query back through the injected execFn — otherwise the
// probe would spawn a REAL powershell and assert against the live process list.
function makeShimPsSpawn(execFn) {
  return () => {
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    stdout.setEncoding = () => {};
    const stderr = new EventEmitter();
    stderr.resume = () => {};
    const stdin = {
      write: (text) => {
        execFn('powershell -NoProfile -NonInteractive -Command "<shim>"', {}, (err, out) => {
          if (err || typeof out !== "string") {
            child.emit("error", err || new Error("shim exec failed"));
            return;
          }
          const markerMatch = text.match(/Write-Output '([^']+)'/);
          const marker = markerMatch ? markerMatch[1] : "";
          stdout.emit("data", out + marker + "\r\n");
        });
      },
    };
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => { child.emit("exit", 0); };
    child.unref = () => {};
    return child;
  };
}

function testCollector(opts) {
  const patched = { loadSparkSettings: false, execFn: silentExec, ...opts };
  if (!patched.spawnFn) patched.spawnFn = makeShimPsSpawn(patched.execFn);
  return createAgentMetricsCollector(patched);
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

  it("exposes instances for every scoped endpoint and none for the aggregate-only ones", async () => {
    let t = 1000;
    const collector = testCollector({ nowFn: () => t });
    for (const agentId of ["kimi", "opencode", "pi", "dsh"]) {
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
    const c = collector.startRequest({ agentId: "claude", instanceId: "c-1", model: "m1" });
    c.recordEnd({ status: 200, usage: {} });

    const status = await collector.getAgentsStatus();
    for (const agentId of ["kimi", "opencode", "pi", "dsh"]) {
      const agent = status.find((a) => a.id === agentId);
      assert.deepEqual(agent.instances.map((i) => i.id), [`${agentId}-one`], `${agentId} instance`);
    }
    // dsh became instance-capable with the DSH-TUI integration (一行 = 一个 DSH
    // 进程); zcode/qoder/claude keep the aggregate-only shape.
    for (const agentId of ["zcode", "qoder", "claude"]) {
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

describe("冷缓存临时身份的折叠收敛（单会话不再显示两个实例）", () => {
  // pi 现场（2026-09-14）：会话头几条请求赶上进程扫描缓存未刷新，启动
  // 器注入的 "<cwd>-<launcher pid>" 折不进规范形，落成自定义 id 临时行；
  // 缓存跟上后后续请求折回 "<pi>-<pid>"，看板两行并存，临时行要等 10
  // 分钟空闲 TTL。housekeeping 现在每次读都拿新快照重试折叠，临时行于
  // 下一轮读归位。下面三例：整行改名、目标行已存在时清行、在途请求延
  // 迟收敛。
  //
  // 进程链仿 pi 现场：launcher node.exe (17360) → cmd /c shim (10220) →
  // pi 客户端 node.exe (14692)。
  const PI_CHAIN_SCAN = "Node,CommandLine,Name,ParentProcessId,ProcessId\r\n" + [
    "LAPTOP,C:\\Tools\\node.exe C:\\app\\pi-launcher.mjs,node.exe,500,17360",
    "LAPTOP,,cmd.exe,17360,10220",
    "LAPTOP,C:\\Tools\\node.exe C:\\x\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js,node.exe,10220,14692",
  ].join("\r\n") + "\r\n";

  // execFn 冷热身切换：warm=false 任何探测都回空（等价于快照里没有客户
  // 端），warm=true 回完整进程链。scanWarm 只驱动扫描缓存转热、不跑
  // housekeeping（stale-while-revalidate：首个快照未落地前 scanProcesses
  // 会等本轮扫完；已有快照后越过 2.5s TTL 的调用踢一轮后台扫描即返回旧
  // 快照，故循环「踢+让出事件循环」直到新快照落地）。之后的
  // startRequest 才能折回规范身份，且临时行与规范行的并存态不被提前收
  // 敛——留给被测的那次 getAgentsStatus 读。
  function coldWarmCollector(tRef) {
    const state = { warm: false };
    const execFn = (cmd, opts, cb) => cb(null, state.warm ? PI_CHAIN_SCAN : "");
    const collector = testCollector({ execFn, nowFn: () => tRef.t });
    const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); };
    const scanWarm = async () => {
      state.warm = true;
      for (let i = 0; i < 10; i += 1) {
        tRef.t += 3000;
        await collector.scanProcesses();
        await flush();
      }
    };
    return { state, collector, flush, scanWarm };
  }

  const piReq = (collector, tRef) => collector.startRequest({
    agentId: "pi", instanceId: "86183-17360", providerId: "p1", model: "m1", stream: true, path: "openai",
  });
  const piStatus = async (collector) => (await collector.getAgentsStatus()).find((a) => a.id === "pi");

  it("缓存冷时落临时行，缓存热后整行改名归位（计数与标签保留）", async () => {
    const tRef = { t: 1000 };
    const { collector, scanWarm } = coldWarmCollector(tRef);

    const r1 = piReq(collector, tRef);
    tRef.t = 2000;
    r1.recordFirstChunk();
    tRef.t = 3000;
    r1.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });

    let pi = await piStatus(collector);
    assert.deepEqual(pi.instances.map((i) => i.id), ["86183-17360"], "冷缓存：行保持启动器临时身份");

    await scanWarm(); // 看板轮询驱动缓存转热（用户打开看板）

    pi = await piStatus(collector);
    assert.deepEqual(pi.instances.map((i) => i.id), ["pi-14692"], "热缓存下一轮读：临时行折回规范身份，不再两行并存");
    assert.equal(pi.instances[0].title, "86183", "cwd 基名作为行标签随折叠归位");
    assert.equal(pi.instances[0].requests, 1, "临时行的历史计数随之归位");
    assert.equal(pi.metrics.totalRequests, 1);
  });

  it("临时行与规范行并存时清掉临时行（无在途请求），规范行计数不重复", async () => {
    const tRef = { t: 1000 };
    const { collector, scanWarm } = coldWarmCollector(tRef);

    // 冷缓存期的请求落临时行（用户在 pi 里发的第一条消息）。
    const r1 = piReq(collector, tRef);
    tRef.t = 2000;
    r1.recordEnd({ status: 503, error: { status: 503, message: "upstream" } });

    // 用户打开看板查 503：轮询把缓存焐热（只扫描、未 housekeeping），之
    // 后的请求折回规范身份——此刻临时行与规范行并存，正是用户看到的两
    // 个实例。
    await scanWarm();

    const r2 = piReq(collector, tRef); // 热缓存折回规范身份
    tRef.t += 1000;
    r2.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });

    // 下一轮读 housekeeping 拿热快照重折叠：临时行被清掉，只剩规范行。
    const pi = await piStatus(collector);
    assert.deepEqual(pi.instances.map((i) => i.id), ["pi-14692"], "临时行被清掉，单会话回到单实例");
    assert.equal(pi.instances[0].requests, 1, "规范行只计折回的请求，临时行历史不重复并入");
    assert.equal(pi.metrics.totalRequests, 2, "端点聚合计数不受影响");
  });

  it("临时行有在途请求时延迟收敛，请求收尾后下一轮读归位", async () => {
    const tRef = { t: 1000 };
    const { collector, scanWarm } = coldWarmCollector(tRef);

    const r1 = piReq(collector, tRef); // 在途，先不收尾
    await scanWarm();

    const r2 = piReq(collector, tRef); // 热缓存折回规范身份，两行并存
    tRef.t += 1000;
    r2.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });

    let pi = await piStatus(collector);
    assert.deepEqual(pi.instances.map((i) => i.id).sort(), ["86183-17360", "pi-14692"], "临时行有在途请求：本轮保留");

    tRef.t += 1000;
    r1.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
    pi = await piStatus(collector);
    assert.deepEqual(pi.instances.map((i) => i.id), ["pi-14692"], "在途请求收尾后收敛为单行");
    assert.equal(pi.metrics.totalRequests, 2);
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

  it("synthesizes dsh-<pid> for a DSH started in a terminal, and labels its surface", async () => {
    // 终端里自己起的 dsh（web 或 `dst`）不经过 Anyswitch 启动器、不带任何头，
    // 只有 x-agent-id 是托管渠道写进 settings.yaml 的。行身份来自 netstat 反查，
    // 面（Web / TUI）来自同一次进程扫描。
    const dshPidExec = (cmd, opts, cb) => cb(null, "Node,CommandLine,Name,ProcessId\r\nLAPTOP,\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js\" --profile dsh-tui,node.exe,4321\r\n");
    const collector = testCollector({ execFn: dshPidExec });
    const { seen, socketOwner } = stubOwner(4321);
    const server = createOpenAIRelayServer(relayDeps(collector, socketOwner));
    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await postChat(port, { "x-agent-id": "dsh" });
      assert.equal(res.status, 200);
      await res.text();

      assert.equal(seen.length, 1, "dsh 在套接字兜底白名单内");
      const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
      assert.deepEqual(dsh.instances.map((i) => [i.id, i.surface]), [["dsh-4321", "TUI"]]);
      assert.equal(dsh.instances[0].requests, 1);
      assert.equal(dsh.metrics.totalRequests, 1);
    } finally {
      await close();
    }
  });

  it("synthesizes kimi-<pid> for a desktop app started by double-click, labelled Desktop", async () => {
    // 桌面端不经过 Anyswitch 启动器：既没有 x-agent-id 也没有 x-agent-instance，
    // 归属只能靠 UA 嗅探（内嵌核心发的是 kimi-code-desktop/<ver>），行身份靠
    // netstat 反查，面来自同一次进程扫描里的镜像名。这条把"双击启动也能被观测"
    // 整条链钉住——它正是本期决定不引入 launcher 的前提（计划 §8）。
    const desktopPidExec = (cmd, opts, cb) => cb(null, "Node,CommandLine,Name,ProcessId\r\nLAPTOP,\"C:\\Users\\tester\\AppData\\Local\\Programs\\Kimi Code\\Kimi Code.exe\" ,kimi code.exe,4321\r\n");
    const collector = testCollector({ execFn: desktopPidExec });
    const { seen, socketOwner } = stubOwner(4321);
    const server = createOpenAIRelayServer(relayDeps(collector, socketOwner));
    const { port, close } = await listenLoopback(server, 0);
    try {
      const res = await postChat(port, { "user-agent": "kimi-code-desktop/1.0.2" });
      assert.equal(res.status, 200);
      await res.text();

      assert.equal(seen.length, 1, "kimi 在套接字兜底白名单内");
      const card = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
      assert.equal(card.processCount, 1, "桌面端计入端点进程数");
      assert.deepEqual(card.instances.map((i) => [i.id, i.surface]), [["kimi-4321", "Desktop"]]);
      assert.deepEqual(card.surfaces.map((s) => [s.label, s.count]), [["Desktop", 1]]);
      assert.equal(card.metrics.totalRequests, 1, "无头请求照样归到 kimi 桶");
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

  it("unidentified traffic lands on no endpoint card at all", async () => {
    const collector = testCollector();
    const { seen, socketOwner } = stubOwner(4321);
    const server = createOpenAIRelayServer(relayDeps(collector, socketOwner));
    const { port, close } = await listenLoopback(server, 0);
    try {
      // 无 x-agent-id、无识别 UA：归属为 null（旧语义曾兜底为 zcode，已废弃——
      // 未知来源不占任何端点卡）。
      const res = await postChat(port, {});
      assert.equal(res.status, 200);
      await res.text();

      const agents = await collector.getAgentsStatus();
      const zcode = agents.find((a) => a.id === "zcode");
      assert.equal(seen.length, 0, "unattributed requests must not consult the socket snapshot");
      assert.equal(zcode.metrics.totalRequests, 0, "zcode bucket stays clean");
      for (const a of agents) {
        if (!a.metrics) continue; // claude 卡是 per-session 报表，无聚合 metrics
        assert.equal(a.metrics.totalRequests, 0, `no endpoint card may count this request (${a.id})`);
      }
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
