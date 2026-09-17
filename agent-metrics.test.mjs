import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentMetricsCollector,
  createSessionReporter,
  findDescendantClientPid,
  getTtftColor,
  formatDuration,
  normalizeInstanceId,
  sampleTps,
  windowCacheHitRate,
  windowTps,
  TTFT_THRESHOLDS,
  METRICS_SNAPSHOT_FILENAME,
} from "./agent-metrics.mjs";

describe("getTtftColor", () => {
  it("returns green for ttft under 5s", () => {
    assert.equal(getTtftColor(1200), "green");
    assert.equal(getTtftColor(4999), "green");
  });

  it("returns yellow for ttft between 5s and 15s", () => {
    assert.equal(getTtftColor(5000), "yellow");
    assert.equal(getTtftColor(10000), "yellow");
    assert.equal(getTtftColor(15000), "yellow");
  });

  it("returns red for ttft above 15s", () => {
    assert.equal(getTtftColor(15001), "red");
    assert.equal(getTtftColor(25000), "red");
  });

  it("returns gray for null or invalid ttft", () => {
    assert.equal(getTtftColor(null), "gray");
    assert.equal(getTtftColor(undefined), "gray");
    assert.equal(getTtftColor(0), "gray");
    assert.equal(getTtftColor(-100), "gray");
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    assert.equal(formatDuration(0), "0秒");
    assert.equal(formatDuration(45000), "45秒");
    assert.equal(formatDuration(135000), "2分15秒");
    assert.equal(formatDuration(3665000), "1小时1分5秒");
  });
});

// The collector's fast probe is a RESIDENT powershell.exe spoken to over
// stdin/stdout. Tests that only inject execFn still exercise that path: this
// shim fakes the child process and answers each stdin query by invoking the
// test's execFn with a powershell-flavoured command string, so mocks that
// route on `cmd.includes("powershell" / "tasklist" / ...)` keep working, and
// delayed/gated exec callbacks keep their "scan round in flight" semantics.
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
  const patched = { loadSparkSettings: false, ...opts };
  if (patched.execFn && !patched.spawnFn) {
    patched.spawnFn = makeShimPsSpawn(patched.execFn);
  }
  return createAgentMetricsCollector(patched);
}

// Shared WMIC lineage fixture (CommandLine,Name,ParentProcessId,ProcessId —
// /format:csv emits columns alphabetically after Node). The chain is the real
// launcher shape (kimi-launcher spawns via COMSPEC): launcher node.exe (1000)
// → cmd /c shim (1001) → kimi client (4321). Used by the "process lineage"
// and "instance id normalization (collector)" describes below.
const WMIC_LINEAGE_CHAIN_SCAN =
  "Node,CommandLine,Name,ParentProcessId,ProcessId\r\n" +
  [
    "LAPTOP,C:\\Tools\\node.exe C:\\app\\kimi-launcher.mjs,node.exe,500,1000",
    "LAPTOP,,cmd.exe,1000,1001",
    "LAPTOP,C:\\Tools\\node.exe C:\\x\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs,node.exe,1001,4321",
  ].join("\r\n") + "\r\n";

describe("generation-speed window (the statistic the card and the stats page share)", () => {
  it("sums tokens over generation windows and ignores requests that carry no measurement", () => {
    const samples = [
      { completion: 270, genDurationMs: 1000, prompt: 100, cached: 50 },
      { completion: 2, genDurationMs: 1, prompt: 100, cached: 0 }, // one-packet burst
      { completion: 50, genDurationMs: null, prompt: 100, cached: 50 }, // never streamed
      { completion: 300, genDurationMs: 1000, prompt: 100, cached: 0 },
    ];
    // (270 + 300) tokens over (1.0 + 1.0)s — the burst and the non-streaming
    // reply have no window to measure, so they are absent from both sides.
    assert.equal(windowTps(samples), 285);
    assert.equal(sampleTps(samples[1]), null);
    assert.equal(sampleTps(samples[2]), null);
    // The cache rate counts every sample in the window: it needs prompt tokens,
    // not a generation window.
    assert.equal(windowCacheHitRate(samples), 25);
    assert.equal(windowTps([]), null);
    assert.equal(windowTps(undefined), null);
    assert.equal(windowCacheHitRate([]), null);
  });

  it("weights by tokens, not one vote per request", () => {
    const samples = [
      { completion: 40, genDurationMs: 1000, prompt: 1, cached: 0 }, // 40 tok/s
      { completion: 300, genDurationMs: 3000, prompt: 1, cached: 0 }, // 100 tok/s
    ];
    assert.equal(windowTps(samples), 85); // 340 tokens / 4.0s
    assert.notEqual(windowTps(samples), 70); // the mean of the two quotients
  });

  it("keeps only the last N samples", () => {
    const samples = [
      { completion: 10, genDurationMs: 1000, prompt: 1, cached: 0 },
      { completion: 900, genDurationMs: 1000, prompt: 1, cached: 0 },
    ];
    assert.equal(windowTps(samples, 1), 900);
  });
});

describe("createAgentMetricsCollector", () => {
  it("tracks ZCode request start, firstChunk, end, TPS and cache hit rate", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => {
      // Return wmic-like output with one main ZCode and one renderer child
      const csv = `Node,CommandLine,ProcessId\r\nLAPTOP,C:\\Programs\\ZCode.exe,20588\r\nLAPTOP,C:\\Programs\\ZCode.exe --type=renderer,20604\r\n`;
      cb(null, csv);
    };

    const collector = testCollector({ execFn: mockExec, nowFn });

    // Request 1: streaming
    const req1 = collector.startRequest({ providerId: "furry", model: "gemini-3.7-flash" });
    mockTime = 2200; // 1200ms TTFT
    req1.recordFirstChunk();
    mockTime = 3200; // 1000ms generation duration (1.0s)
    req1.recordEnd({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    });

    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    assert.ok(zcode);
    assert.equal(zcode.status, "running");
    assert.equal(zcode.processCount, 1); // 1 main process, helper filtered out
    assert.equal(zcode.lastModel, "gemini-3.7-flash");
    assert.equal(zcode.metrics.totalRequests, 1);
    assert.equal(zcode.metrics.lastTtftMs, 1200);
    assert.equal(zcode.metrics.ttftColor, "green");
    assert.equal(zcode.metrics.tps, 50); // 50 tokens / 1.0s = 50.0
    assert.equal(zcode.metrics.cacheHitRate, 80); // 800 / 1000 = 80.0%
    assert.equal(zcode.metrics.tokens.prompt, 1000);
    assert.equal(zcode.metrics.tokens.completion, 50);
    assert.equal(zcode.metrics.tokens.cached, 800);
    assert.equal(zcode.sessions.length, 1);
    assert.equal(zcode.sessions[0].title, "全局汇总");

    const stab = collector.getModelStability();
    assert.equal(stab.models.length, 1);
    assert.equal(stab.models[0].model, "gemini-3.7-flash");
    assert.equal(stab.models[0].provider, "furry");
    assert.equal(stab.models[0].total, 1);
    assert.equal(stab.models[0].successRate, 100);
    assert.equal(stab.models[0].cacheHit, 80);
    assert.equal(stab.models[0].cells.length, 48);
  });

  it("captures and surfaces error status such as 502", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");

    const collector = testCollector({ execFn: mockExec, nowFn });

    const req = collector.startRequest({ providerId: "acme-default", model: "claude-sonnet-4-6" });
    mockTime = 1500;
    req.recordEnd({ status: 502, error: { status: 502, message: "Upstream Bad Gateway" } });

    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    assert.ok(zcode);
    assert.ok(zcode.lastError);
    assert.equal(zcode.lastError.status, 502);
    assert.equal(zcode.lastError.message, "Upstream Bad Gateway");
    assert.equal(zcode.lastError.model, "claude-sonnet-4-6");
    assert.equal(zcode.lastError.providerId, "acme-default");
    assert.equal(zcode.errorActive, true);
    assert.equal(zcode.activeErrors.length, 1);
    assert.equal(zcode.activeErrors[0].model, "claude-sonnet-4-6");
    assert.equal(zcode.sessions[0].errorActive, true);
    assert.equal(zcode.sessions[0].lastError.status, 502);

    const stab = collector.getModelStability();
    assert.equal(stab.models[0].total, 1);
    assert.equal(stab.models[0].successRate, 0);
    assert.equal(stab.models[0].status, "red");
  });

  it("failed requests do not fabricate TTFT; a later success clears the active fault", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");

    const collector = testCollector({ execFn: mockExec, nowFn });

    // 1. Healthy request establishes a real TTFT
    const ok1 = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
    mockTime = 2000; // TTFT = 1000ms
    ok1.recordFirstChunk();
    mockTime = 4000;
    ok1.recordEnd({ usage: { prompt_tokens: 100, completion_tokens: 10 } });

    // 2. 502 fails BEFORE any first chunk — the 5s failure duration must not
    //    be recorded as a plausible-looking TTFT
    const bad = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
    mockTime = 9000;
    bad.recordEnd({ status: 502, error: { status: 502, message: "Upstream Bad Gateway" } });

    let status = await collector.getAgentsStatus();
    let zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.metrics.lastTtftMs, 1000); // untouched by the failure
    assert.equal(zcode.metrics.ttftColor, "green");
    assert.equal(zcode.errorActive, true);

    // 3. Next clean success clears the active fault, error history retained
    const ok2 = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
    mockTime = 10000;
    ok2.recordFirstChunk();
    mockTime = 11000;
    ok2.recordEnd({ usage: { prompt_tokens: 50, completion_tokens: 5 } });

    status = await collector.getAgentsStatus();
    zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, false);
    assert.equal(zcode.sessions[0].errorActive, false);
    assert.ok(zcode.lastError); // kept for the banner's error history
    assert.equal(zcode.lastError.status, 502);
    assert.equal(zcode.activeErrors.length, 0);
  });

  it("does not clear a fault when a different provider or model succeeds", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const bad = collector.startRequest({ providerId: "acme-glm", model: "glm-5.3" });
    mockTime = 2000;
    bad.recordEnd({ status: 503, error: { status: 503, message: "upstream unavailable" } });

    const otherProvider = collector.startRequest({ providerId: "acme-default", model: "gemini-3.6-flash" });
    mockTime = 3000;
    otherProvider.recordFirstChunk();
    mockTime = 4000;
    otherProvider.recordEnd({ usage: { prompt_tokens: 10, completion_tokens: 4 } });

    let status = await collector.getAgentsStatus();
    let zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, true);
    assert.equal(zcode.activeErrors.length, 1);
    assert.equal(zcode.activeErrors[0].model, "glm-5.3");
    assert.equal(zcode.activeErrors[0].providerId, "acme-glm");
    assert.equal(zcode.lastError.model, "glm-5.3");

    const otherModel = collector.startRequest({ providerId: "acme-glm", model: "glm-5.2" });
    mockTime = 5000;
    otherModel.recordFirstChunk();
    mockTime = 6000;
    otherModel.recordEnd({ usage: { prompt_tokens: 8, completion_tokens: 2 } });

    status = await collector.getAgentsStatus();
    zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, true);
    assert.equal(zcode.activeErrors.length, 1);
    assert.equal(zcode.activeErrors[0].model, "glm-5.3");
  });

  it("keeps concurrent provider+model faults until each pair recovers", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const glm = collector.startRequest({ providerId: "acme-glm", model: "glm-5.3" });
    mockTime = 2000;
    glm.recordEnd({ status: 503, error: { status: 503, message: "upstream unavailable" } });

    const acme = collector.startRequest({ providerId: "acme-default", model: "gemini-3.6-flash" });
    mockTime = 2500;
    acme.recordEnd({ status: 502, error: { status: 502, message: "Upstream Bad Gateway" } });

    let status = await collector.getAgentsStatus();
    let zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, true);
    assert.equal(zcode.activeErrors.length, 2);
    assert.deepEqual(zcode.activeErrors.map((e) => e.model).sort(), ["gemini-3.6-flash", "glm-5.3"]);
    assert.equal(zcode.lastError.model, "gemini-3.6-flash");

    const recoverAcme = collector.startRequest({ providerId: "acme-default", model: "gemini-3.6-flash" });
    mockTime = 3000;
    recoverAcme.recordFirstChunk();
    mockTime = 3500;
    recoverAcme.recordEnd({ usage: { prompt_tokens: 10, completion_tokens: 4 } });

    status = await collector.getAgentsStatus();
    zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, true);
    assert.equal(zcode.activeErrors.length, 1);
    assert.equal(zcode.activeErrors[0].model, "glm-5.3");
    assert.equal(zcode.lastError.model, "glm-5.3");
  });

  it("keeps a same-pair fault latched through retry begin; first token is what clears it", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const bad = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
    mockTime = 2000;
    bad.recordEnd({ status: 502, error: { status: 502, message: "Upstream Bad Gateway" } });
    let status = await collector.getAgentsStatus();
    let zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, true);
    assert.equal(zcode.activeErrors.length, 1);

    // Retry begin must NOT hide the 502 — otherwise a looping retry never
    // surfaces the banner. The latch lives until a genuine first token.
    const retry = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
    status = await collector.getAgentsStatus();
    zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, true, "retry begin must keep the 502 visible");
    assert.equal(zcode.activeErrors.length, 1);
    assert.equal(zcode.lastError.status, 502);

    mockTime = 3000;
    retry.recordFirstChunk();
    status = await collector.getAgentsStatus();
    zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, false, "first token recovers the pair");
    assert.equal(zcode.activeErrors.length, 0);
    assert.ok(zcode.lastError, "error history retained");
    assert.equal(zcode.lastError.status, 502);

    mockTime = 4000;
    retry.recordEnd({ usage: { prompt_tokens: 10, completion_tokens: 2 } });
    status = await collector.getAgentsStatus();
    zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, false);
  });

  it("a retry that fails again keeps the fault latched and refreshes the message", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const bad = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
    mockTime = 2000;
    bad.recordEnd({ status: 502, error: { status: 502, message: "Upstream Bad Gateway" } });

    const retry = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
    mockTime = 4000;
    retry.recordEnd({ status: 502, error: { status: 502, message: "still down" } });
    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, true);
    assert.equal(zcode.activeErrors.length, 1);
    assert.equal(zcode.lastError.message, "still down");
  });

  it("keeps a keyless (no provider+model) fault latched through retry begin; first token clears it", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    // A request started without providerId produces a keyless fault
    // (keylessFaultAt), so activeErrors stays empty while errorActive is raised.
    const bad = collector.startRequest({ agentId: "kimi", model: "test-model" });
    mockTime = 2000;
    bad.recordEnd({ status: 502, error: { status: 502, message: "Upstream Bad Gateway" } });
    let status = await collector.getAgentsStatus();
    let kimi = status.find((a) => a.id === "kimi");
    assert.equal(kimi.errorActive, true);
    assert.equal(kimi.activeErrors.length, 0, "keyless fault is not surfaced via activeErrors");
    assert.ok(kimi.lastError);

    const retry = collector.startRequest({ agentId: "kimi", model: "test-model" });
    status = await collector.getAgentsStatus();
    kimi = status.find((a) => a.id === "kimi");
    assert.equal(kimi.errorActive, true, "retry begin must keep the keyless 502 visible");
    assert.ok(kimi.lastError, "error history retained");

    mockTime = 3000;
    retry.recordFirstChunk();
    status = await collector.getAgentsStatus();
    kimi = status.find((a) => a.id === "kimi");
    assert.equal(kimi.errorActive, false, "first token recovers the keyless latch");
    assert.ok(kimi.lastError);
  });

  it("folds the fault banner when the endpoint closes, ending the fault lifecycle", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, ""); // endpoint process gone
    const collector = testCollector({ execFn: mockExec, nowFn });

    const bad = collector.startRequest({ agentId: "kimi", providerId: "acme-main", model: "kimi-k3" });
    mockTime = 2000;
    bad.recordEnd({ status: 400, error: { status: 400, message: "the upstream provider returned status 400" } });

    // Within the process-gone safety margin the fault stays latched.
    mockTime = 3000;
    let status = await collector.getAgentsStatus();
    let kimi = status.find((a) => a.id === "kimi");
    assert.equal(kimi.errorActive, true, "fault stays latched within the safety margin");

    // Past the margin with the endpoint closed: the fault lifecycle ends now,
    // not at the idle fault TTL.
    mockTime = 6000;
    status = await collector.getAgentsStatus();
    kimi = status.find((a) => a.id === "kimi");
    assert.equal(kimi.errorActive, false, "latched fault is settled once the endpoint is gone");
    assert.equal(kimi.activeErrors.length, 0);
    assert.ok(kimi.lastError, "error history is retained for the record");
    assert.equal(kimi.lastError.status, 400);
  });

  it("keeps the fault latched while the endpoint process is still running", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => {
      // Real wmic shape: Node,CommandLine,Name,ProcessId (no parent column in
      // this older fixture — the ppid-less 4-column dump).
      cb(null, "Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\\\kimi\\\\node_modules\\\\@moonshot-ai\\\\kimi-code\\\\dist\\\\main.mjs,node.exe,12345\r\n");
    };
    const collector = testCollector({ execFn: mockExec, nowFn });

    const bad = collector.startRequest({ agentId: "kimi", providerId: "acme-main", model: "kimi-k3" });
    mockTime = 2000;
    bad.recordEnd({ status: 400, error: { status: 400, message: "the upstream provider returned status 400" } });

    mockTime = 60000; // well past the process-gone margin AND the idle fault TTL
    const status = await collector.getAgentsStatus();
    const kimi = status.find((a) => a.id === "kimi");
    assert.equal(kimi.errorActive, true, "fault stays latched while the endpoint is alive");
    assert.equal(kimi.activeErrors.length, 1);
  });

  it("does not clear another pair's fault when a different provider+model begins", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const bad = collector.startRequest({ providerId: "acme-glm", model: "glm-5.3" });
    mockTime = 2000;
    bad.recordEnd({ status: 503, error: { status: 503, message: "upstream unavailable" } });

    // A different provider+model begins — must not touch the acme fault.
    collector.startRequest({ providerId: "acme-default", model: "gemini-3.6-flash" });
    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, true, "an unrelated pair's begin must not clear this fault");
    assert.equal(zcode.activeErrors.length, 1);
    assert.equal(zcode.activeErrors[0].model, "glm-5.3");
    assert.equal(zcode.activeErrors[0].providerId, "acme-glm");
  });

  it("non-streaming success on the same pair clears that fault and keeps lastError history", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const bad = collector.startRequest({ providerId: "acme-glm", model: "glm-5.3" });
    mockTime = 2000;
    bad.recordEnd({ status: 503, error: { status: 503, message: "upstream unavailable" } });

    const ok = collector.startRequest({ providerId: "acme-glm", model: "glm-5.3" });
    mockTime = 3000;
    ok.recordEnd({ usage: { prompt_tokens: 10, completion_tokens: 4 } });

    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, false);
    assert.equal(zcode.activeErrors.length, 0);
    assert.equal(zcode.lastError.status, 503);
    assert.equal(zcode.lastError.model, "glm-5.3");
  });

  it("an abandoned model's fault expires after the idle TTL; lastError history remains", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    // Model A errors and is then abandoned; the user switches to model B.
    const bad = collector.startRequest({ providerId: "acme-glm", model: "model-a" });
    mockTime = 2000;
    bad.recordEnd({ status: 503, error: { status: 503, message: "upstream unavailable" } });

    // Model B succeeds — this must NOT clear model A's fault (existing latch semantics)
    const ok = collector.startRequest({ providerId: "acme-default", model: "model-b" });
    mockTime = 3000;
    ok.recordFirstChunk();
    mockTime = 4000;
    ok.recordEnd({ usage: { prompt_tokens: 10, completion_tokens: 4 } });

    // Well within the TTL: fault still latched
    let status = await collector.getAgentsStatus();
    let zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, true);
    assert.equal(zcode.activeErrors.length, 1);
    assert.equal(zcode.activeErrors[0].model, "model-a");

    // Past 60s idle: the abandoned model's fault expires on the status read
    mockTime = 2000 + 60000;
    status = await collector.getAgentsStatus();
    zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, false);
    assert.equal(zcode.activeErrors.length, 0);
    assert.ok(zcode.lastError); // history retained for the banner's record
    assert.equal(zcode.lastError.model, "model-a");
    assert.equal(zcode.lastError.status, 503);
  });

  it("a repeatedly failing model refreshes its fault timestamp and never expires while live", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    // Two rounds of failure, each ~50s apart — each error refreshes entry.time,
    // so the fault is 100s old at the end but never 60s idle.
    for (let round = 0; round < 2; round++) {
      const bad = collector.startRequest({ providerId: "acme-glm", model: "model-a" });
      mockTime = 1000 + round * 50000;
      bad.recordEnd({ status: 502, error: { status: 502, message: "Upstream Bad Gateway" } });
    }

    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, true);
    assert.equal(zcode.activeErrors.length, 1);
    assert.equal(zcode.activeErrors[0].model, "model-a");
  });

  it("a keyless fault (no provider/model meta) also expires after the idle TTL", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const req = collector.startRequest({});
    mockTime = 2000;
    req.recordEnd({ status: 500, error: { status: 500, message: "handler error" } });

    let status = await collector.getAgentsStatus();
    let zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, true);

    mockTime = 2000 + 60000;
    status = await collector.getAgentsStatus();
    zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, false);
    assert.ok(zcode.lastError);
  });

  it("an abort on a retry neither clears the prior fault nor fabricates a TTFT", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");

    const collector = testCollector({ execFn: mockExec, nowFn });

    const bad = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
    mockTime = 2000;
    bad.recordEnd({ status: 502, error: { status: 502, message: "Upstream Bad Gateway" } });

    // Abort is not recovery: the prior 502 stays latched. Abort also must
    // not raise a second fault or invent a TTFT from the wait duration.
    const aborted = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
    mockTime = 6000;
    aborted.recordEnd({ aborted: true });

    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, true, "abort is not recovery; prior 502 stays visible");
    assert.ok(zcode.lastError, "error history retained");
    assert.equal(zcode.lastError.status, 502);
    assert.equal(zcode.metrics.lastTtftMs, null, "abort must not fabricate a TTFT");

    // Symmetric check: a clean success followed by an abort keeps the row normal.
    // ok started at mockTime=6000 (left over from the previous step), first chunk
    // at 7000 → TTFT = max(1, 7000-6000) = 1000; the later abort must not touch it.
    const ok = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
    mockTime = 7000;
    ok.recordFirstChunk();
    mockTime = 8000;
    ok.recordEnd({ usage: { prompt_tokens: 10, completion_tokens: 2 } });
    const ab2 = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
    mockTime = 8500;
    ab2.recordEnd({ aborted: true });

    const status2 = await collector.getAgentsStatus();
    const zcode2 = status2.find((a) => a.id === "zcode");
    assert.equal(zcode2.errorActive, false, "abort must not raise a fault either");
    assert.equal(zcode2.metrics.lastTtftMs, 1000, "clean success TTFT survives the later abort");
  });

  it("computes TPS and cache-hit rate from a recent sliding window, not the process-lifetime average", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    // Tiny window so one early outlier is evicted by two later samples.
    const collector = testCollector({ execFn: mockExec, nowFn, recentSampleWindow: 2, loadSparkSettings: false });

    // Req 1: very fast and fully cached — would dominate a lifetime average.
    const r1 = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
    mockTime = 1100; r1.recordFirstChunk();
    mockTime = 1200; // 100ms generation, 500 tokens
    r1.recordEnd({ usage: { prompt_tokens: 10000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 10000 } } });

    // Req 2: slow, no cache.
    const r2 = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
    mockTime = 3000; r2.recordFirstChunk();
    mockTime = 13000; // 10s generation, 50 tokens
    r2.recordEnd({ usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0 } } });

    // Req 3: slow, no cache — evicts req 1 from the size-2 window.
    const r3 = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
    mockTime = 14000; r3.recordFirstChunk();
    mockTime = 24000; // 10s generation, 50 tokens
    r3.recordEnd({ usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0 } } });

    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    // Window = req2 + req3 only: 100 tok / 20s = 5.0 tps. The lifetime average
    // (all three) would be 600 tok / 20.1s ≈ 29.9 — req 1 would still own it.
    assert.equal(zcode.metrics.tps, 5);
    // Window: 0 cached / 2000 prompt = 0%. Lifetime would be 10000/12000 ≈ 83.3%.
    assert.equal(zcode.metrics.cacheHitRate, 0);
    // Lifetime token totals are untouched by the window — still shown as-is.
    assert.equal(zcode.metrics.tokens.prompt, 12000);
    assert.equal(zcode.metrics.tokens.completion, 600);
    assert.equal(zcode.metrics.tokens.cached, 10000);
  });

  it("uses PID liveness for Claude sessions — alive when PID in process list", async () => {
    let mockTime = 10000;
    const nowFn = () => mockTime;
    // tasklist returns one claude.exe with PID 4444
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","4444","Console","1","55,000 K"\r\n`);

    const collector = testCollector({ execFn: mockExec, nowFn });

    collector.reportSession("token_claude_1", {
      pid: 4444,
      sessionId: "sess_001",
      requests: 3,
      activeRequests: 1,
      // 15s of session busy time, of which only 5s was generation — the Claude
      // Code shape (every request waits several seconds for its first token).
      activeDurationMs: 15000,
      promptTokens: 2000,
      completionTokens: 300,
      cachedTokens: 1500,
      lastTtftMs: 6500, // yellow
      samples: [{ completion: 300, genDurationMs: 5000, prompt: 2000, cached: 1500 }],
    });

    let status = await collector.getAgentsStatus();
    let claude = status.find((a) => a.id === "claude");
    assert.equal(claude.status, "running");
    assert.equal(claude.sessionsCount, 1);
    assert.equal(claude.sessions[0].id, "sess_001");
    assert.equal(claude.sessions[0].ttftColor, "yellow");
    // 300 tokens over the 5s generation window. Dividing by the 15s of busy
    // time instead reports 20 — first-token waits booked as generation time.
    assert.equal(claude.sessions[0].tps, 60);
    assert.notEqual(claude.sessions[0].tps, 20);
    assert.equal(claude.sessions[0].cacheHitRate, 75); // 1500 / 2000 = 75%
  });

  it("falls back to the reporter's recent per-request mean when the launcher predates window samples", async () => {
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","4444","Console","1","55,000 K"\r\n`);
    const collector = testCollector({ execFn: mockExec, nowFn: () => 10000 });

    collector.reportSession("token_claude_old", {
      pid: 4444,
      sessionId: "sess_old",
      requests: 5,
      activeRequests: 0,
      activeDurationMs: 60000,
      promptTokens: 1000,
      completionTokens: 400,
      cachedTokens: 500,
      lastTtftMs: 3000,
      // A launcher from before the window-sample field: only the ring is present.
      sparkHistory: { ttft: [3], tps: [50, 40, 60], cache: [50] },
    });

    const claude = (await collector.getAgentsStatus()).find((a) => a.id === "claude");
    assert.equal(claude.sessions[0].tps, 50, "mean of the ring (50/40/60) — degraded, never 400 tokens / 60s = 6.7");
    assert.equal(claude.sessions[0].cacheHitRate, 50, "cumulative fallback: 500 / 1000");
  });

  it("settles a claude session whose reporter went silent mid-generation, but never a freshly-heartbeating one", async () => {
    let mockTime = 10000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","4444","Console","1","55,000 K"\r\n`);

    const collector = testCollector({ execFn: mockExec, nowFn });

    collector.reportSession("token_claude_silent", {
      pid: 4444,
      sessionId: "sess_silent",
      requests: 1,
      activeRequests: 1,
    });

    // The launcher heartbeats every ~10s while generating, so a snapshot this
    // fresh is a genuinely live generation — settling it would kill a real
    // 生成中 capsule mid-turn.
    mockTime = 10000 + 44000;
    let status = await collector.getAgentsStatus();
    let claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessions[0].activeRequests, 1);
    assert.equal(claude.sessions[0].status, "active");

    // Past the silence threshold the reporter is gone for good (its final
    // zeroing snapshot was lost): settle on read so the capsule recovers.
    mockTime = 10000 + 46000;
    status = await collector.getAgentsStatus();
    claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessions[0].activeRequests, 0);
    assert.equal(claude.sessions[0].status, "idle");
  });

  it("derives claude card-level model fields from session reports when the aggregate tracker is idle", async () => {
    // Claude Code rides the per-launch relay: its model identity reaches the
    // panel only through session reports, never through the resident relay's
    // aggregate claude bucket. The card-level fields must therefore fall back
    // to the session snapshots or the capsule row stays blank.
    let mockTime = 10000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","4444","Console","1","55,000 K"\r\n"claude.exe","5555","Console","1","55,000 K"\r\n`);

    const collector = testCollector({ execFn: mockExec, nowFn });

    collector.reportSession("tok_A", {
      pid: 4444,
      sessionId: "sess_A",
      requests: 3,
      activeRequests: 1,
      activeDurationMs: 15000,
      promptTokens: 100,
      completionTokens: 30,
      model: "anthropic/chan-a/qwen-max",
    });
    mockTime = 12000;
    collector.reportSession("tok_B", {
      pid: 5555,
      sessionId: "sess_B",
      requests: 5,
      activeRequests: 0,
      activeDurationMs: 8000,
      promptTokens: 100,
      completionTokens: 20,
      model: "anthropic/chan-b/glm-5.3",
    });

    const status = await collector.getAgentsStatus();
    const claude = status.find((a) => a.id === "claude");
    // Only sess_A is generating → its model is the active capsule.
    assert.deepEqual(claude.activeModels, ["anthropic/chan-a/qwen-max"]);
    assert.equal(claude.currentModel, "anthropic/chan-a/qwen-max");
    // sess_B reported later → its model is the latest-seen "最近" fallback.
    assert.equal(claude.lastModel, "anthropic/chan-b/glm-5.3");
  });

  it("keeps the claude card lastModel when a session goes idle (最近 capsule)", async () => {
    const nowFn = () => 10000;
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","4444","Console","1","55,000 K"\r\n`);

    const collector = testCollector({ execFn: mockExec, nowFn });

    collector.reportSession("tok_A", {
      pid: 4444,
      sessionId: "sess_A",
      requests: 2,
      activeRequests: 1,
      activeDurationMs: 5000,
      promptTokens: 50,
      completionTokens: 10,
      model: "anthropic/chan-a/qwen-max",
    });
    collector.reportSession("tok_A", {
      pid: 4444,
      sessionId: "sess_A",
      requests: 3,
      activeRequests: 0,
      activeDurationMs: 9000,
      promptTokens: 80,
      completionTokens: 20,
      model: "anthropic/chan-a/qwen-max",
    });

    const status = await collector.getAgentsStatus();
    const claude = status.find((a) => a.id === "claude");
    assert.deepEqual(claude.activeModels, [], "idle session contributes no active model");
    assert.equal(claude.lastModel, "anthropic/chan-a/qwen-max", "idle session keeps its model as the 最近 fallback");
    assert.equal(claude.currentModel, null, "no in-flight traffic → currentModel stays null");
  });

  it("derives the claude card's 渠道×模型 复合账本 from session reports (胶囊双段 + auto 角标数据源)", async () => {
    const nowFn = () => 10000;
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","4444","Console","1","55,000 K"\r\n"claude.exe","5555","Console","1","55,000 K"\r\n`);

    const collector = testCollector({ execFn: mockExec, nowFn });
    collector.reportSession("tok_A", {
      pid: 4444, sessionId: "sess_A", requests: 3, activeRequests: 1,
      model: "claude-opus-5", providerId: "chan-a", viaAuto: true,
    });
    collector.reportSession("tok_B", {
      pid: 5555, sessionId: "sess_B", requests: 5, activeRequests: 2,
      model: "qwen-max", providerId: "chan-b", viaAuto: false,
    });

    const claude = (await collector.getAgentsStatus()).find((a) => a.id === "claude");
    assert.deepEqual(claude.activeTargets, [
      { providerId: "chan-a", model: "claude-opus-5", count: 1, autoCount: 1 },
      { providerId: "chan-b", model: "qwen-max", count: 2, autoCount: 0 },
    ], "每个（渠道,模型）组合一颗胶囊，auto 归因跟条目自身走");
    assert.equal(claude.currentProvider, "chan-b");
    assert.equal(claude.currentViaAuto, false);
    assert.equal(claude.lastProvider, "chan-b");
    assert.equal(claude.lastViaAuto, false);
  });

  it("节点待定的在飞会话不出模型胶囊：不冒充模型，最近身份也不被抹掉", async () => {
    const nowFn = () => 10000;
    const mockExec = (cmd, opts, cb) => cb(null, `"claude.exe","4444","Console","1","55,000 K"\r\n`);
    const collector = testCollector({ execFn: mockExec, nowFn });

    // 自动路由请求刚发出、链上节点还没定下来。
    collector.reportSession("tok_A", {
      pid: 4444, sessionId: "sess_A", requests: 1, activeRequests: 1, model: null, providerId: null, viaAuto: false,
    });
    let claude = (await collector.getAgentsStatus()).find((a) => a.id === "claude");
    assert.deepEqual(claude.activeModels, [], "节点没定下来就没有活跃模型，胶囊回落到最近/待命");
    assert.deepEqual(claude.activeTargets, []);
    assert.equal(claude.lastModel, null);

    // 节点宣布 → 真实渠道/模型上屏。
    collector.reportSession("tok_A", {
      pid: 4444, sessionId: "sess_A", requests: 1, activeRequests: 1,
      model: "claude-opus-5", providerId: "chan-a", viaAuto: true,
    });
    claude = (await collector.getAgentsStatus()).find((a) => a.id === "claude");
    assert.deepEqual(claude.activeTargets, [{ providerId: "chan-a", model: "claude-opus-5", count: 1, autoCount: 1 }]);

    // 请求结束（快照回到无身份）→ 灰胶囊「最近」保留真实渠道/模型。
    collector.reportSession("tok_A", {
      pid: 4444, sessionId: "sess_A", requests: 2, activeRequests: 0, model: null, providerId: null, viaAuto: false,
    });
    claude = (await collector.getAgentsStatus()).find((a) => a.id === "claude");
    assert.deepEqual(claude.activeTargets, []);
    assert.equal(claude.lastModel, "claude-opus-5", "无身份快照不抹掉最近身份");
    assert.equal(claude.lastProvider, "chan-a");
    assert.equal(claude.lastViaAuto, true);
  });

  it("marks Claude session ended when PID disappears from process list (forced kill)", async () => {
    let mockTime = 10000;
    const nowFn = () => mockTime;
    // First scan: PID 4444 present. Second scan: no claude processes.
    let claudeCsv = `"claude.exe","4444","Console","1","55,000 K"\r\n`;
    const mockExec = (cmd, opts, cb) => cb(null, claudeCsv);

    const collector = testCollector({ execFn: mockExec, nowFn });

    collector.reportSession("token_claude_1", {
      pid: 4444,
      sessionId: "sess_001",
      requests: 1,
      activeRequests: 0,
      activeDurationMs: 5000,
      promptTokens: 100,
      completionTokens: 20,
      cachedTokens: 0,
      lastTtftMs: 1200,
    });

    // First poll — PID alive
    let status = await collector.getAgentsStatus();
    let claude = status.find((a) => a.id === "claude");
    assert.equal(claude.status, "running");
    assert.equal(claude.sessionsCount, 1);

    // Process killed — next scan sees no claude.exe
    claudeCsv = "";
    // Bump time past the 2.5s scan cache so the next scan re-runs
    mockTime = 13000;
    // Reads never block on a rescan: the first call serves the stale snapshot
    // and kicks the background round; the second serves what it landed.
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 20));
    status = await collector.getAgentsStatus();
    claude = status.find((a) => a.id === "claude");
    assert.equal(claude.status, "stopped");
    assert.equal(claude.sessionsCount, 0);
  });

  it("treats same PID with a different token as a new session (PID reuse guard)", async () => {
    const nowFn = () => 10000;
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","7777","Console","1","55,000 K"\r\n`);

    const collector = testCollector({ execFn: mockExec, nowFn });

    collector.reportSession("token_A", {
      pid: 7777,
      sessionId: "sess_A",
      requests: 5,
      activeRequests: 0,
      activeDurationMs: 10000,
      promptTokens: 500,
      completionTokens: 100,
      cachedTokens: 0,
      lastTtftMs: 2000,
    });

    // Same PID, different token — OS recycled the PID for a new Claude session
    collector.reportSession("token_B", {
      pid: 7777,
      sessionId: "sess_B",
      requests: 1,
      activeRequests: 1,
      activeDurationMs: 1000,
      promptTokens: 50,
      completionTokens: 10,
      cachedTokens: 0,
      lastTtftMs: 800,
    });

    const status = await collector.getAgentsStatus();
    const claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessionsCount, 1);
    assert.equal(claude.sessions[0].id, "sess_B");
    assert.equal(claude.sessions[0].requests, 1);
  });

  it("does not briefly show two sessions when process scanning creates a placeholder before reportSession", async () => {
    const nowFn = () => 10000;
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","8888","Console","1","55,000 K"
`);

    const collector = testCollector({ execFn: mockExec, nowFn });

    // Process scanning detects claude.exe and creates a placeholder session with token === null
    let status = await collector.getAgentsStatus();
    let claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessionsCount, 1, "placeholder session created by process scan");
    assert.equal(claude.sessions[0].id, "pid-8888");
    assert.equal(claude.sessions[0].requests, 0);

    // Now the real session report arrives with a real token — should replace the placeholder
    collector.reportSession("token_real", {
      pid: 8888,
      sessionId: "sess_real",
      requests: 2,
      activeRequests: 1,
      activeDurationMs: 5000,
      promptTokens: 300,
      completionTokens: 50,
      cachedTokens: 100,
      lastTtftMs: 1200,
    });

    // Must show exactly 1 session (the real one), not 2 (placeholder + real)
    status = await collector.getAgentsStatus();
    claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessionsCount, 1, "must not briefly show two sessions");
    assert.equal(claude.sessions[0].id, "sess_real");
    assert.equal(claude.sessions[0].requests, 2);
    assert.equal(claude.sessions[0].tokens.prompt, 300);
    assert.equal(claude.sessions[0].tokens.completion, 50);
    assert.equal(claude.sessions[0].tokens.cached, 100);
  });

  it("propagates per-session error state from launcher reports to the API output", async () => {
    const nowFn = () => 10000;
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","4444","Console","1","55,000 K"\r\n`);

    const collector = testCollector({ execFn: mockExec, nowFn });

    collector.reportSession("token_claude_1", {
      pid: 4444,
      sessionId: "sess_err",
      requests: 2,
      lastTtftMs: 1200,
      lastError: { status: 502, message: "Upstream Bad Gateway", time: 9500 },
      errorActive: true,
    });

    let status = await collector.getAgentsStatus();
    let claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessions[0].errorActive, true);
    assert.equal(claude.sessions[0].lastError.status, 502);

    // Cumulative snapshot semantics: the reporter's recovery overwrites state
    collector.reportSession("token_claude_1", {
      pid: 4444,
      sessionId: "sess_err",
      requests: 3,
      lastTtftMs: 1300,
      lastError: { status: 502, message: "Upstream Bad Gateway", time: 9500 },
      errorActive: false,
    });

    status = await collector.getAgentsStatus();
    claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessions[0].errorActive, false);
    assert.equal(claude.sessions[0].lastError.status, 502, "history kept after recovery");
  });

  it("ignores Claude session reports without a pid", async () => {
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn: () => 10000 });

    collector.reportSession("token_no_pid", {
      sessionId: "sess_nopid",
      requests: 1,
    });

    const status = await collector.getAgentsStatus();
    const claude = status.find((a) => a.id === "claude");
    // No session registered (no pid) and no process running
    assert.equal(claude.status, "stopped");
    assert.equal(claude.sessionsCount, 0);
  });

  it("ignores session reports tagged with a non-claude agentId (kimi relay)", async () => {
    // The kimi launcher rides startProductionRelay({ agentId: "kimi" }); its
    // child is spawned via cmd /c kimi.cmd, so the reported pid is cmd's and
    // never appears in claudePids. claudeSessions must not take such a report:
    // if the OS later recycles that pid for a real claude.exe, the kimi row is
    // revived as-is and the claude card shows kimi's session id and stats. The
    // panel's journal chain already consumes agentId correctly; this side has to
    // agree with it.
    let claudeCsv = "";
    const mockExec = (cmd, opts, cb) => cb(null, claudeCsv);
    let mockTime = 10000;
    const collector = testCollector({ execFn: mockExec, nowFn: () => mockTime });

    collector.reportSession("tok_kimi", {
      pid: 5555,
      agentId: "kimi",
      sessionId: "sess_kimi",
      requests: 2,
      activeRequests: 1,
      activeDurationMs: 3000,
      promptTokens: 100,
      completionTokens: 20,
    });

    // No claude.exe running: no session rows at all.
    let status = await collector.getAgentsStatus();
    let claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessionsCount, 0, "kimi report must not create a claude session row");
    assert.deepEqual(claude.sessions, []);

    // The OS recycles pid 5555 for a real claude.exe: the card must show the
    // process-scan placeholder for the new claude process, never the kimi row.
    claudeCsv = `"claude.exe","5555","Console","1","55,000 K"\r\n`;
    mockTime = 13000; // past the scan cache so the next poll re-runs the probe
    // Reads never block on a rescan: first call serves stale + kicks the round.
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 20));
    status = await collector.getAgentsStatus();
    claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessionsCount, 1);
    assert.equal(claude.sessions[0].id, "pid-5555", "must be the placeholder, not the kimi session");
    assert.equal(claude.sessions[0].requests, 0);
  });

  it("keeps the claude path unchanged when agentId is missing or explicitly claude", async () => {
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","4444","Console","1","55,000 K"\r\n`);
    const collector = testCollector({ execFn: mockExec, nowFn: () => 10000 });

    collector.reportSession("tok_explicit_claude", {
      pid: 4444,
      agentId: "claude",
      sessionId: "sess_explicit",
      requests: 1,
      activeRequests: 0,
    });

    const status = await collector.getAgentsStatus();
    const claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessionsCount, 1);
    assert.equal(claude.sessions[0].id, "sess_explicit");
    assert.equal(claude.sessions[0].requests, 1);
  });

  it("treats a non-string agentId as missing (claude), same as the panel journal", async () => {
    // panel.mjs journalSessionEnd normalizes with
    // `typeof agentId === "string" && agentId.trim() ? agentId.trim() : "claude"`,
    // so a garbage non-string agentId is journaled as claude. reportSession
    // must reach the same verdict or the row splits between claudeSessions
    // and the journal.
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","4444","Console","1","55,000 K"\r\n`);
    const collector = testCollector({ execFn: mockExec, nowFn: () => 10000 });

    collector.reportSession("tok_garbage_agent", {
      pid: 4444,
      agentId: 42,
      sessionId: "sess_garbage",
      requests: 1,
    });

    const status = await collector.getAgentsStatus();
    const claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessionsCount, 1);
    assert.equal(claude.sessions[0].id, "sess_garbage");
  });

  it("trims a padded claude agentId instead of early-returning (panel journal parity)", async () => {
    // A padded `" claude"` has to be trimmed before the identity check, or this
    // side drops the row while the panel journal trims it and files the same
    // report under claude — the two sides would disagree.
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","4444","Console","1","55,000 K"\r\n`);
    const collector = testCollector({ execFn: mockExec, nowFn: () => 10000 });

    collector.reportSession("tok_padded_claude", {
      pid: 4444,
      agentId: " claude ",
      sessionId: "sess_padded",
      requests: 1,
    });

    const status = await collector.getAgentsStatus();
    const claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessionsCount, 1);
    assert.equal(claude.sessions[0].id, "sess_padded");
  });

  it("automatically detects running claude.exe process even before first reportSession call", async () => {
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","4444","Console","1","55,000 K"\r\n`);
    const collector = testCollector({ execFn: mockExec, nowFn: () => 10000 });

    const status = await collector.getAgentsStatus();
    const claude = status.find((a) => a.id === "claude");
    assert.equal(claude.status, "running");
    assert.equal(claude.sessionsCount, 1);
    assert.equal(claude.sessions[0].id, "pid-4444");
    assert.equal(claude.sessions[0].requests, 0);
    assert.equal(claude.sessions[0].status, "idle");
  });

  it("detects claude running under node with cli-wrapper", async () => {
    const mockExec = (cmd, opts, cb) => {
      const csv = `Node,CommandLine,Name,ProcessId\r\nLAPTOP,"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs",node.exe,9876\r\n`;
      cb(null, csv);
    };
    const collector = testCollector({ execFn: mockExec, nowFn: () => 10000 });

    const status = await collector.getAgentsStatus();
    const claude = status.find((a) => a.id === "claude");
    assert.equal(claude.status, "running");
    assert.equal(claude.sessionsCount, 1);
    assert.equal(claude.sessions[0].id, "pid-9876");
  });

  it("detects Pi running under node with pi-coding-agent package", async () => {
    const mockExec = (cmd, opts, cb) => {
      const csv = `Node,CommandLine,Name,ProcessId\r\nLAPTOP,"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",node.exe,5432\r\n`;
      cb(null, csv);
    };
    const collector = testCollector({ execFn: mockExec, nowFn: () => 10000 });

    const status = await collector.getAgentsStatus();
    const pi = status.find((a) => a.id === "pi");
    assert.equal(pi.status, "running");
    assert.equal(pi.processCount, 1);
  });

  it("routes Qoder traffic by x-agent-id and counts Qoder.exe main processes only", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => {
      // Qoder IDE (Electron): one main process + one --type= helper child.
      const csv = `Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\Users\\tester\\AppData\\Local\\Programs\\Qoder\\Qoder.exe,Qoder.exe,5150\r\nLAPTOP,C:\\Users\\tester\\AppData\\Local\\Programs\\Qoder\\Qoder.exe --type=renderer,Qoder.exe,5151\r\n`;
      cb(null, csv);
    };
    const collector = testCollector({ execFn: mockExec, nowFn });
    const req = collector.startRequest({
      agentId: "qoder",
      providerId: "poke-api",
      model: "claude-opus-5",
    });
    mockTime = 2200;
    req.recordFirstChunk();
    mockTime = 3200;
    req.recordEnd({ usage: { prompt_tokens: 10, completion_tokens: 5 } });

    const status = await collector.getAgentsStatus();
    const qoder = status.find((a) => a.id === "qoder");
    assert.ok(qoder);
    assert.equal(qoder.status, "running");
    assert.equal(qoder.processCount, 1, "Electron --type= helper child filtered out");
    assert.equal(qoder.lastModel, "claude-opus-5");
    assert.equal(qoder.metrics.totalRequests, 1);
    assert.equal(qoder.sessionMode, "aggregate");
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.metrics.totalRequests, 0, "qoder traffic must not fall back into the zcode bucket");
  });

  it("collects Qoder PIDs into qoderPids like the other endpoints", async () => {
    const mockExec = (cmd, opts, cb) => {
      const csv = `Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\Programs\\Qoder\\Qoder.exe,Qoder.exe,7001\r\nLAPTOP,C:\\Programs\\Qoder\\Qoder.exe,Qoder.exe,7002\r\n`;
      cb(null, csv);
    };
    const collector = testCollector({ execFn: mockExec, nowFn: () => 10000 });

    const procs = await collector.scanProcesses();
    assert.equal(procs.qoder, 2);
    assert.ok(procs.qoderPids instanceof Set);
    assert.ok(procs.qoderPids.has(7001));
    assert.ok(procs.qoderPids.has(7002));
  });

  it("routes Codex traffic by x-agent-id and counts the codex.exe engine family", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => {
      // Codex CLI + desktop GUI: the engine family lives under the versioned
      // bin dir (hash drifts per upgrade), ChatGPT.exe is the GUI's Electron
      // shell under WindowsApps (package version drifts too) with one main
      // process and one --type= helper child.
      const csv = "Node,CommandLine,Name,ProcessId\r\n" +
        "LAPTOP,C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex.exe app-server,codex.exe,6100\r\n" +
        "LAPTOP,C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex-code-mode-host.exe,codex-code-mode-host.exe,6101\r\n" +
        "LAPTOP,C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex-command-runner.exe,codex-command-runner.exe,6102\r\n" +
        "LAPTOP,C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0jr76e\\ChatGPT.exe,ChatGPT.exe,6200\r\n" +
        "LAPTOP,C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0jr76e\\ChatGPT.exe --type=renderer,ChatGPT.exe,6201\r\n";
      cb(null, csv);
    };
    const collector = testCollector({ execFn: mockExec, nowFn });
    const req = collector.startRequest({
      agentId: "codex",
      providerId: "poke-api",
      model: "gpt-5.2-codex",
    });
    mockTime = 2200;
    req.recordFirstChunk();
    mockTime = 3200;
    req.recordEnd({ usage: { prompt_tokens: 10, completion_tokens: 5 } });

    const status = await collector.getAgentsStatus();
    const codex = status.find((a) => a.id === "codex");
    assert.ok(codex);
    assert.equal(codex.status, "running");
    assert.equal(codex.processCount, 4, "engine family + ChatGPT.exe main; Electron --type= helper child filtered out");
    assert.equal(codex.lastModel, "gpt-5.2-codex");
    assert.equal(codex.metrics.totalRequests, 1);
    assert.equal(codex.sessionMode, "aggregate");
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.metrics.totalRequests, 0, "codex traffic must not fall back into the zcode bucket");
  });

  it("collects Codex PIDs into codexPids like the other endpoints", async () => {
    const mockExec = (cmd, opts, cb) => {
      const csv = `Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex.exe,codex.exe,7101\r\nLAPTOP,C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex.exe,codex.exe,7102\r\n`;
      cb(null, csv);
    };
    const collector = testCollector({ execFn: mockExec, nowFn: () => 10000 });

    const procs = await collector.scanProcesses();
    assert.equal(procs.codex, 2);
    assert.ok(procs.codexPids instanceof Set);
    assert.ok(procs.codexPids.has(7101));
    assert.ok(procs.codexPids.has(7102));
  });

  it("counts an idling ChatGPT.exe GUI shell as a process but never as activity", async () => {
    // V4 验收语义：仅 GUI 空转时卡面可有进程数，但活跃会话引擎是 GUI 为每个
    // 会话拉起的 codex.exe app-server 子进程——外壳本身不产生活跃。
    const mockExec = (cmd, opts, cb) => {
      const csv = `Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0jr76e\\ChatGPT.exe,ChatGPT.exe,6200\r\n`;
      cb(null, csv);
    };
    const collector = testCollector({ execFn: mockExec, nowFn: () => 3000 });

    const codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.processCount, 1, "GUI main process counts toward the card");
    assert.equal(codex.status, "running");
    assert.equal(codex.metrics.activeRequests, 0);
    assert.equal(codex.metrics.totalRequests, 0);
    assert.equal(codex.sessions[0].status, "idle", "idle GUI is 待命, never 活跃");
  });

  it("sniffs codex_cli_rs / codex-tui user agents into the codex bucket", async () => {
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, ""), nowFn: () => 1000 });
    for (const userAgent of ["codex_cli_rs/0.153.4 (Windows 11; x86_64)", "codex-tui/0.153.4"]) {
      const req = collector.startRequest({ userAgent, providerId: "p1", model: "m1" });
      req.recordEnd({ status: 200, usage: {} });
    }
    const status = await collector.getAgentsStatus();
    const codex = status.find((a) => a.id === "codex");
    assert.equal(codex.metrics.totalRequests, 2);
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.metrics.totalRequests, 0);
  });

  it("spawns no codex instance rows from processes alone; launcher-tagged traffic folds into codex-<pid>", async () => {
    const t = 3000;
    const codexRow = (pid) =>
      `LAPTOP,C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex.exe,codex.exe,${pid}`;
    const execFn = (cmd, opts, cb) =>
      cb(null, "Node,CommandLine,Name,ProcessId\r\n" + codexRow(8101) + "\r\n" + codexRow(8102) + "\r\n");
    const collector = testCollector({ execFn, nowFn: () => t });

    // Engine processes alive but zero traffic: no placeholder rows — codex
    // instance rows are session/traffic-born only.
    let codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.deepEqual(codex.instances, [], "live engine processes never spawn placeholder rows");
    assert.equal(codex.processCount, 2, "the card still counts the engine family");

    // A launcher-tagged request (header path, no prompt_cache_key derived id)
    // folds into the canonical codex-<pid> row, keeping the cwd basename as
    // the row label.
    const r = collector.startRequest({ agentId: "codex", instanceId: "myproj-8101", model: "m1", path: "openai" });
    r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.instances.length, 1);
    const inst = codex.instances[0];
    assert.equal(inst.id, "codex-8101");
    assert.equal(inst.requests, 1);
    assert.equal(inst.title, "myproj");
    assert.equal(codex.metrics.totalRequests, 1, "tagged traffic also lands in the endpoint aggregate");
  });

  it("keeps a desktop session (ChatGPT.exe GUI + codex.exe engine) rowless until session traffic arrives", async () => {
    // GUI shell + shared app-server engine alive, no traffic: no rows — one
    // engine hosts every GUI conversation, so a process cannot stand in for
    // a session.
    const t = 3000;
    const csv = "Node,CommandLine,Name,ProcessId\r\n" +
      "LAPTOP,C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0jr76e\\ChatGPT.exe,ChatGPT.exe,6200\r\n" +
      "LAPTOP,C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex.exe app-server,codex.exe,6100\r\n";
    const execFn = (cmd, opts, cb) => cb(null, csv);
    const collector = testCollector({ execFn, nowFn: () => t, codexSessionLookup: async () => [] });

    let codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.deepEqual(codex.instances, [], "GUI + engine alone spawn no instance row");
    assert.equal(codex.processCount, 2, "card process count keeps the full family scope");

    // One session-tagged request (prompt_cache_key derived upstream) creates
    // exactly one row; with no session-scan match the title is the short id.
    const sessionId = "01932abc-7f6e-7a01-9c8e-1a2b3c4d5e6f";
    const r = collector.startRequest({ agentId: "codex", instanceId: `codex-sess-${sessionId}`, model: "m1", path: "openai" });
    r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.instances.length, 1, "session traffic converges on the single session row");
    assert.equal(codex.instances[0].id, `codex-sess-${sessionId}`);
    assert.equal(codex.instances[0].requests, 1);
    assert.equal(codex.instances[0].title, "Codex 会话 01932abc", "no session-scan match → short-id title");
  });

  it("spawns no instance row for a short-lived codex-command-runner.exe", async () => {
    const csv = "Node,CommandLine,Name,ProcessId\r\n" +
      "LAPTOP,C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex-command-runner.exe,codex-command-runner.exe,6150\r\n";
    const execFn = (cmd, opts, cb) => cb(null, csv);
    const collector = testCollector({ execFn, nowFn: () => 3000 });

    const codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.processCount, 1, "the helper still counts toward the card");
    assert.deepEqual(codex.instances, [], "helpers never own an instance row");
  });

  it("evicts a pid-shaped codex row when its engine process exits", async () => {
    let t = 3000;
    let engineAlive = true;
    const guiRow = "LAPTOP,C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0jr76e\\ChatGPT.exe,ChatGPT.exe,6200";
    const engineRow = "LAPTOP,C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex.exe app-server,codex.exe,6100";
    const execFn = (cmd, opts, cb) =>
      cb(null, "Node,CommandLine,Name,ProcessId\r\n" + guiRow + "\r\n" + (engineAlive ? engineRow + "\r\n" : ""));
    const collector = testCollector({ execFn, nowFn: () => t });

    // The socket fallback synthesizes codex-<engine pid> for a request that
    // carries neither a prompt_cache_key nor a launcher header.
    const r = collector.startRequest({ agentId: "codex", instanceId: "codex-6100", model: "m1", path: "openai" });
    r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });
    let codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.deepEqual(codex.instances.map((i) => i.id), ["codex-6100"]);

    // The engine exits while the GUI shell keeps running. The next read past
    // the scan cache window must drop the row even though the bucket still
    // holds a live (GUI) process.
    engineAlive = false;
    t += 3000;
    // Reads never block on a rescan: the first call past the cache window
    // serves the stale snapshot and kicks the background round; the next read
    // serves what it landed.
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 20));
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.deepEqual(codex.instances, [], "engine-scoped liveness evicts the row while the GUI idles on");
    assert.equal(codex.processCount, 1, "the idling GUI still counts toward the card");
  });

  it("titles codex session rows from the on-disk session scan (GUI/CLI 同构)", async () => {
    const t = 3000;
    const csv = "Node,CommandLine,Name,ProcessId\r\n" +
      "LAPTOP,C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex.exe app-server,codex.exe,6100\r\n";
    const sessA = "aaaa1111-2222-3333-4444-55556666777f";
    const sessB = "bbbb2222-3333-4444-5555-66667777888f";
    const collector = testCollector({
      execFn: (cmd, opts, cb) => cb(null, csv),
      nowFn: () => t,
      codexSessionLookup: async () => [
        { endpoint: "codex", id: sessA, title: "修复登录页闪退", project: "C:\\work\\shop" },
        // No thread name or first message on record → cwd basename titles.
        { endpoint: "codex", id: sessB, title: null, project: "C:\\work\\shop" },
      ],
    });

    for (const sessionId of [sessA, sessB]) {
      const r = collector.startRequest({ agentId: "codex", instanceId: `codex-sess-${sessionId}`, model: "m1", path: "openai" });
      r.recordEnd({ status: 200, usage: {} });
    }

    const codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.instances.length, 2, "different sessions split into different rows");
    const rowA = codex.instances.find((i) => i.id === `codex-sess-${sessA}`);
    const rowB = codex.instances.find((i) => i.id === `codex-sess-${sessB}`);
    assert.equal(rowA.title, "修复登录页闪退", "the scanned session title wins");
    assert.equal(rowB.title, "shop", "titleless session falls back to the cwd basename");
  });

  // ── codex 后台请求（meta.background）的面板隔离 ─────────────────────
  // openai-server 的分类器把引擎/GUI 自发流量（记忆整理、guardian、预热、
  // 线程标题/摘要生成等）标成 background；这一侧的约定：不出实例行（即便
  // 调用方误传 instanceId），不碰卡片报错面（lastError/activeErrors/
  // errorActive），不改写模型徽章（currentModel/lastModel/currentProvider/
  // lastProvider/activeModels/activeTargets）、TTFT/TPS 样本窗与模型稳定性
  // 行；但请求数与 token 照实计入端点聚合——不藏流量，也不惊动用户。
  it("background traffic spawns no instance row even when an instanceId leaks through", async () => {
    const t = 3000;
    const csv = "Node,CommandLine,Name,ProcessId\r\n" +
      "LAPTOP,C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex.exe app-server,codex.exe,6100\r\n";
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => t, codexSessionLookup: async () => [] });

    // 防线测试：openai-server 正常路径会传 instanceId: null，这里故意带上
    // 会话 id，验证 collector 侧第二道闸门；迟挂通道（attachInstance）同样是
    // no-op。
    const r = collector.startRequest({ agentId: "codex", instanceId: "codex-sess-ghost", model: "gpt-5.6-luna", path: "openai", background: true });
    r.attachInstance("codex-6100");
    r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });

    const codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.deepEqual(codex.instances, [], "background traffic never spawns an instance row");
    assert.equal(codex.metrics.totalRequests, 1, "流量照实计入端点聚合");
    assert.equal(codex.metrics.tokens.prompt, 10);
    assert.equal(codex.metrics.tokens.completion, 5);
  });

  it("a background failure leaves the card error surfaces untouched but still counts", async () => {
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, ""), nowFn: () => 3000 });

    // 后台请求撞上硬编码模型的 404：不上报错横幅，但请求数照涨。
    const bg = collector.startRequest({ agentId: "codex", providerId: "codex-hosted", model: "gpt-5.6-luna", path: "openai", background: true });
    bg.recordEnd({ status: 404, error: { status: 404, message: "model not found" } });

    let codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.errorActive, false);
    assert.equal(codex.lastError, null);
    assert.deepEqual(codex.activeErrors, []);
    assert.equal(codex.sessions[0].errorActive, false);
    assert.equal(codex.metrics.totalRequests, 1, "失败的后台请求也照实计数");

    // 对照：同一端点上用户流量的同样失败照常 raise——隔离是定向的，不是
    // 把报错面整个关掉。
    const user = collector.startRequest({ agentId: "codex", providerId: "codex-hosted", model: "gpt-5.6-luna", path: "openai" });
    user.recordEnd({ status: 404, error: { status: 404, message: "model not found" } });
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.errorActive, true);
    assert.equal(codex.activeErrors.length, 1);
    assert.equal(codex.lastError.status, 404);
  });

  it("a background failure neither raises nor clears a user-latched fault", async () => {
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, ""), nowFn: () => 3000 });

    // 用户流量先在 (provider, model) 对上挂起真实故障。
    const user = collector.startRequest({ agentId: "codex", providerId: "codex-hosted", model: "gpt-5.6-luna", path: "openai" });
    user.recordEnd({ status: 502, error: { status: 502, message: "Upstream Bad Gateway" } });
    let codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.errorActive, true);

    // 同一对上的后台失败：不得改写 lastError、不得新增 activeErrors，更不得
    // 落入 clear 分支把用户故障吞掉。
    const bgFail = collector.startRequest({ agentId: "codex", providerId: "codex-hosted", model: "gpt-5.6-luna", path: "openai", background: true });
    bgFail.recordEnd({ status: 404, error: { status: 404, message: "model not found" } });
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.errorActive, true, "后台失败不得清掉用户挂起的故障");
    assert.equal(codex.activeErrors.length, 1);
    assert.equal(codex.lastError.status, 502, "lastError 仍是用户那次 502");

    // 同一对上的后台成功（流式首 token + 正常结算）也不是用户故障的恢复信号。
    const bgOk = collector.startRequest({ agentId: "codex", providerId: "codex-hosted", model: "gpt-5.6-luna", path: "openai", background: true });
    bgOk.recordFirstChunk();
    bgOk.recordEnd({ status: 200, usage: { prompt_tokens: 4, completion_tokens: 2 } });
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.errorActive, true, "后台成功不得替用户流量宣布恢复");

    // 用户流量的成功照常清闩。
    const userOk = collector.startRequest({ agentId: "codex", providerId: "codex-hosted", model: "gpt-5.6-luna", path: "openai" });
    userOk.recordFirstChunk();
    userOk.recordEnd({ status: 200, usage: { prompt_tokens: 4, completion_tokens: 2 } });
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.errorActive, false);
    assert.equal(codex.activeErrors.length, 0);
  });

  it("background traffic never touches the card model/provider badges", async () => {
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, ""), nowFn: () => 3000 });

    // 用户流量先建立徽章基线。
    const user = collector.startRequest({ agentId: "codex", providerId: "a6api-main", model: "kimi-k3", path: "openai" });
    user.recordEnd({ status: 200, usage: { prompt_tokens: 4, completion_tokens: 2 } });
    let codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.lastModel, "kimi-k3");
    assert.equal(codex.lastProvider, "a6api-main");

    // 后台请求带着硬编码模型飞来：进行中不占「正在生成」徽章，结束后也不
    // 改写「最近模型/渠道」——实机形态即卡片 lastModel 被标题生成线程改成
    // gpt-5.6-luna（2026-09-13 复发）。
    const bg = collector.startRequest({ agentId: "codex", providerId: "a6api-main", model: "gpt-5.6-luna", path: "openai", background: true });
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.currentModel, null, "后台请求进行中不占用「正在生成」徽章");
    assert.deepEqual(codex.activeModels, []);
    assert.deepEqual(codex.activeTargets, []);
    bg.recordEnd({ status: 200, usage: { prompt_tokens: 4, completion_tokens: 2 } });
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.lastModel, "kimi-k3", "后台请求不改写最近模型徽章");
    assert.equal(codex.lastProvider, "a6api-main");
    assert.equal(codex.metrics.totalRequests, 2, "流量照实计数");
  });

  it("background traffic feeds neither the TTFT display nor the TPS window", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, ""), nowFn });

    // 用户流量建立展示面基线：流式成功，TTFT 1200ms。
    const user = collector.startRequest({ agentId: "codex", providerId: "a6api-main", model: "kimi-k3", path: "openai", stream: true });
    mockTime = 2200;
    user.recordFirstChunk();
    mockTime = 4200;
    user.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 50 } });
    let codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    const baselineTtft = codex.metrics.lastTtftMs;
    const baselineTps = codex.metrics.tps;
    assert.equal(baselineTtft, 1200);

    // 后台流式成功：首 token 与结算都不进 TTFT/TPS 展示面（100ms 的后台
    // TTFT 若漏进去会立刻拉低 lastTtftMs）。
    const bg = collector.startRequest({ agentId: "codex", providerId: "a6api-main", model: "gpt-5.6-luna", path: "openai", stream: true, background: true });
    mockTime = 4300;
    bg.recordFirstChunk();
    mockTime = 4400;
    bg.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 500 } });
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.metrics.lastTtftMs, baselineTtft, "后台首 token 不改写 TTFT 展示");
    assert.equal(codex.metrics.tps, baselineTps, "后台 token 不进 TPS 样本窗");
    assert.equal(codex.metrics.tokens.completion, 550, "token 总量照实结算");

    // 后台非流式成功同理：全时长 TTFT 代理也不写展示面。
    const bgNonStream = collector.startRequest({ agentId: "codex", providerId: "a6api-main", model: "gpt-5.6-luna", path: "openai", background: true });
    mockTime = 4450;
    bgNonStream.recordEnd({ status: 200, usage: { prompt_tokens: 5, completion_tokens: 5 } });
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.metrics.lastTtftMs, baselineTtft);
  });

  it("background requests write no model-stability rows", async () => {
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, ""), nowFn: () => 3000 });

    // 硬编码后台模型的 404 若写入稳定性，会留下永不恢复的全红行（实机即
    // a6api-main/gpt-5.6-luna n=6 ok=0）。
    const bg = collector.startRequest({ agentId: "codex", providerId: "a6api-main", model: "gpt-5.6-luna", path: "openai", background: true });
    bg.recordEnd({ status: 404, error: { status: 404, message: "model not found" } });
    assert.deepEqual(collector.getModelStability().models, [], "后台 404 不留稳定性行");

    // 对照：用户流量的同样失败照常入列——隔离是定向的。
    const user = collector.startRequest({ agentId: "codex", providerId: "a6api-main", model: "gpt-5.6-luna", path: "openai" });
    user.recordEnd({ status: 404, error: { status: 404, message: "model not found" } });
    assert.equal(collector.getModelStability().models.length, 1);
  });

  it("keeps one row for repeated traffic of the same codex session", async () => {
    const t = 3000;
    const csv = "Node,CommandLine,Name,ProcessId\r\n" +
      "LAPTOP,C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex.exe app-server,codex.exe,6100\r\n";
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => t, codexSessionLookup: async () => [] });

    const sessionId = "cccc3333-4444-5555-6666-77778888999f";
    for (let i = 0; i < 3; i++) {
      const r = collector.startRequest({ agentId: "codex", instanceId: `codex-sess-${sessionId}`, model: "m1", path: "openai" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }

    const codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.instances.length, 1, "one session is one row, however many requests");
    assert.equal(codex.instances[0].id, `codex-sess-${sessionId}`);
    assert.equal(codex.instances[0].requests, 3);
    assert.equal(codex.metrics.totalRequests, 3, "every request also lands in the endpoint aggregate");
  });

  it("clears codex session rows once the whole codex process family exits", async () => {
    let t = 3000;
    let familyAlive = true;
    const engineRow = "LAPTOP,C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex.exe app-server,codex.exe,6100";
    const execFn = (cmd, opts, cb) =>
      cb(null, "Node,CommandLine,Name,ProcessId\r\n" + (familyAlive ? engineRow + "\r\n" : ""));
    const collector = testCollector({ execFn, nowFn: () => t, codexSessionLookup: async () => [] });

    const r = collector.startRequest({ agentId: "codex", instanceId: "codex-sess-dddd4444-5555-6666-7777-88889990000f", model: "m1", path: "openai" });
    r.recordEnd({ status: 200, usage: {} });
    let codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.instances.length, 1);

    // GUI app and every CLI exited: the session row clears on the next read
    // even though it is seconds old — no process is left that could belong
    // to the session.
    familyAlive = false;
    t += 3000;
    // Reads never block on a rescan: first call serves stale + kicks the round.
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 20));
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.deepEqual(codex.instances, [], "procCounts.codex === 0 clears session rows immediately");
    assert.equal(codex.status, "stopped");
  });

  it("expires a codex session row after 5 idle minutes, not the 10-minute custom TTL", async () => {
    let t = 3000;
    const csv = "Node,CommandLine,Name,ProcessId\r\n" +
      "LAPTOP,C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex.exe app-server,codex.exe,6100\r\n";
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => t, codexSessionLookup: async () => [] });

    const r = collector.startRequest({ agentId: "codex", instanceId: "codex-sess-eeee5555-6666-7777-8888-99990000111f", model: "m1", path: "openai" });
    r.recordEnd({ status: 200, usage: {} });
    let codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.instances.length, 1);

    t += 4 * 60 * 1000;
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.instances.length, 1, "inside the 5-minute session TTL the row stays");

    t += 2 * 60 * 1000; // 6 minutes since the last traffic
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.deepEqual(codex.instances, [], "idle past 5 minutes clears the row while the engine idles on");
    assert.equal(codex.processCount, 1, "the engine still counts toward the card");
  });

  it("evicts a codex launcher custom id row once its tail pid leaves the scan", async () => {
    let t = 3000;
    let launcherAlive = true;
    // WMIC shape with ParentProcessId: the launcher (node.exe 7777) and the
    // engine (codex.exe 6100), parented elsewhere so the launcher id never
    // folds into the canonical row.
    const engineRow = "LAPTOP,C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex.exe app-server,codex.exe,500,6100";
    const launcherRow = "LAPTOP,C:\\Tools\\node.exe C:\\app\\codex-launcher.mjs,node.exe,500,7777";
    const execFn = (cmd, opts, cb) =>
      cb(null, "Node,CommandLine,Name,ParentProcessId,ProcessId\r\n" + engineRow + "\r\n" + (launcherAlive ? launcherRow + "\r\n" : ""));
    const collector = testCollector({ execFn, nowFn: () => t });

    // Ingestion cannot fold "shop-7777" (7777 is no engine pid nor an engine
    // ancestor), so the row stays custom — and while the launcher lives in
    // the scan, the row lists.
    const r = collector.startRequest({ agentId: "codex", instanceId: "shop-7777", model: "m1", path: "openai" });
    r.recordEnd({ status: 200, usage: {} });
    let codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.deepEqual(codex.instances.map((i) => i.id), ["shop-7777"]);

    // Launcher exits (session over): the dead tail pid evicts the row now,
    // not after the idle TTL — the engine alone keeps the card running.
    launcherAlive = false;
    t += 3000;
    // Reads never block on a rescan: first call serves stale + kicks the round.
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 20));
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.deepEqual(codex.instances, [], "dead launcher pid evicts its leftover custom row");
    assert.equal(codex.processCount, 1, "the engine still counts toward the card");
  });

  it("routes opencode traffic by x-agent-id and detects opencode.exe", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => {
      const csv = `Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\Users\\tester\\AppData\\Local\\Programs\\opencode\\opencode.exe,opencode.exe,6363\r\n`;
      cb(null, csv);
    };
    const collector = testCollector({ execFn: mockExec, nowFn });
    const req = collector.startRequest({
      agentId: "opencode",
      providerId: "poke-api",
      model: "claude-opus-5",
    });
    mockTime = 2200;
    req.recordFirstChunk();
    mockTime = 3200;
    req.recordEnd({ usage: { prompt_tokens: 10, completion_tokens: 5 } });

    const status = await collector.getAgentsStatus();
    assert.equal(status.length, 8, "panel now exposes 8 endpoint cards including codex");
    const opencode = status.find((a) => a.id === "opencode");
    assert.ok(opencode);
    assert.equal(opencode.status, "running");
    assert.equal(opencode.processCount, 1);
    assert.equal(opencode.lastModel, "claude-opus-5");
    assert.equal(opencode.metrics.totalRequests, 1);
    assert.equal(opencode.sessionMode, "aggregate");
    assert.equal(opencode.sessions.length, 1);
    assert.equal(opencode.sessions[0].id, "opencode-global");
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.metrics.totalRequests, 0);
  });

  it("collects opencode PIDs into opencodePids like the other endpoints", async () => {
    // parseTasklistCsv 必须为每个端点都把 PID 收进各自的 xxxPids Set；只计数
    // 不收集的端点，其进程对账与实例驱逐都会失效。
    const mockExec = (cmd, opts, cb) => {
      const csv = `Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\Users\\tester\\AppData\\Local\\Programs\\opencode\\opencode.exe,opencode.exe,6363\r\nLAPTOP,C:\\Users\\tester\\AppData\\Local\\Programs\\opencode\\opencode.exe,opencode.exe,6364\r\n`;
      cb(null, csv);
    };
    const collector = testCollector({ execFn: mockExec, nowFn: () => 10000 });

    const procs = await collector.scanProcesses();
    assert.equal(procs.opencode, 2);
    assert.ok(procs.opencodePids instanceof Set);
    assert.ok(procs.opencodePids.has(6363));
    assert.ok(procs.opencodePids.has(6364));
  });

  it("routes opencode traffic by User-Agent header if agentId is missing", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const req = collector.startRequest({
      userAgent: "opencode/0.6.3 (+https://opencode.ai)",
      providerId: "poke-api",
      model: "gpt-5.2",
    });
    mockTime = 2000;
    req.recordFirstChunk();
    mockTime = 3000;
    req.recordEnd({ usage: { prompt_tokens: 100, completion_tokens: 20 } });

    const status = await collector.getAgentsStatus();
    const opencode = status.find((a) => a.id === "opencode");
    const zcode = status.find((a) => a.id === "zcode");

    assert.equal(opencode.metrics.totalRequests, 1);
    assert.equal(opencode.lastModel, "gpt-5.2");
    assert.equal(zcode.metrics.totalRequests, 0, "opencode traffic must not fall back into the zcode bucket");
  });

  it("routes claude traffic by agentId into its own bucket, not the zcode fallback", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const req = collector.startRequest({
      agentId: "claude",
      providerId: "poke-api",
      model: "claude-opus-5",
    });
    mockTime = 2200;
    req.recordFirstChunk();
    mockTime = 3200;
    req.recordEnd({ usage: { prompt_tokens: 10, completion_tokens: 5 } });

    const status = await collector.getAgentsStatus();
    // The claude aggregate bucket stays internal: the panel keeps its fixed
    // cards and claude's card remains the per-session reporter one.
    assert.equal(status.length, 8, "claude aggregate bucket must not add a panel card");
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.metrics.totalRequests, 0, "claude traffic must not fall back into the zcode bucket");
    const claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessionMode, "per_session", "the claude panel card stays on the per-session path");
  });

  it("never surfaces the virtual chain model on the claude card; the serving node replaces it", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    // Resident /v1/messages traffic (UA-sniffed agentId "claude") lands in the
    // claude aggregate bucket. "auto" is routing glue, not a model: it must
    // never reach the card's display fields — not before the chain node is
    // announced, and not after a request that never got one.
    const req = collector.startRequest({
      agentId: "claude",
      providerId: null,
      model: "auto",
    });

    let status = await collector.getAgentsStatus();
    let claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessionMode, "per_session");
    assert.deepEqual(claude.activeModels, [], "未归因的 auto 请求不进入活跃模型");
    assert.equal(claude.currentModel, null, "auto 不是模型名");
    assert.equal(claude.lastModel, null);
    assert.deepEqual(claude.activeTargets, []);

    // 链成员宣布 → 身份改指到节点的绑定模型 + 渠道，并带上服务归因。
    req.setAttributeResolver((memberId) => (memberId === "chan-a/m1" ? { providerId: "chan-a", model: "claude-opus-5" } : null));
    req.setCurrentMember("chan-a/m1");

    status = await collector.getAgentsStatus();
    claude = status.find((a) => a.id === "claude");
    assert.deepEqual(claude.activeTargets, [
      { providerId: "chan-a", model: "claude-opus-5", count: 1, autoCount: 1 },
    ], "渠道×模型复合账本 + auto 归因");
    assert.equal(claude.lastProvider, "chan-a");
    assert.equal(claude.lastViaAuto, true, "来源标记跟胶囊条目自身走");

    mockTime = 2000;
    req.recordFirstChunk();
    mockTime = 3000;
    req.recordEnd({ usage: { prompt_tokens: 10, completion_tokens: 5 } });

    status = await collector.getAgentsStatus();
    claude = status.find((a) => a.id === "claude");
    assert.deepEqual(claude.activeModels, []);
    assert.equal(claude.currentModel, null);
    assert.equal(claude.lastModel, "claude-opus-5", "lastModel survives request end so the card shows 最近: <渠道>/<模型>");
    assert.equal(claude.lastProvider, "chan-a");
  });

  it("claude card model fields stay null/empty when no tracker traffic exists", async () => {
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn: () => 1000 });

    const status = await collector.getAgentsStatus();
    const claude = status.find((a) => a.id === "claude");
    assert.equal(claude.currentModel, null);
    assert.equal(claude.lastModel, null);
    assert.deepEqual(claude.activeModels, []);
  });

  it("keeps the explicit zcode agentId default on the zcode bucket", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    // The chat/completions path explicitly tags agentId "zcode" — the claude
    // bucket must not steal it (isClaudeRequest is agentId-only).
    const req = collector.startRequest({
      agentId: "zcode",
      userAgent: "claude-cli/2.0.0 (external, cli)",
      providerId: "poke-api",
      model: "claude-opus-5",
    });
    mockTime = 2000;
    req.recordFirstChunk();
    mockTime = 3000;
    req.recordEnd({ usage: { prompt_tokens: 10, completion_tokens: 5 } });

    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.metrics.totalRequests, 1, "an explicit zcode tag wins over a claude-looking UA");
  });

  it("pool requests attribute every attempt to the pool id in model-stability (attempt-level)", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    // Pool request: meta.providerId is the pool id. Member failover means one
    // failed attempt (recordRetry with the failing memberId) followed by a
    // successful recordEnd. Both must land on the pool's single row.
    const req = collector.startRequest({ providerId: "sensenova", model: "kimi-k3" });
    mockTime = 1500;
    req.recordRetry({ reason: "upstream_502", memberId: "sensenova-backup1" });
    mockTime = 2500;
    req.recordFirstChunk();
    mockTime = 3500;
    req.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 20 } });

    const stab = collector.getModelStability();
    assert.equal(stab.models.length, 1, "one pool row, no member rows");
    const row = stab.models[0];
    assert.equal(row.provider, "sensenova");
    assert.equal(row.model, "kimi-k3");
    assert.equal(row.total, 2, "the failed attempt and the success both count (attempt-level)");
    assert.equal(row.successRate, 50);
    assert.equal(row.status, "red");
  });

  it("a pool request failing terminally still attributes to the pool id, not the member", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const req = collector.startRequest({ providerId: "sensenova", model: "kimi-k3" });
    mockTime = 2000;
    // Terminal failure carrying the last member's id (stream-pipe exhausted path).
    req.recordEnd({ status: 502, error: { status: 502, message: "exhausted" }, memberId: "sensenova-backup2" });

    const stab = collector.getModelStability();
    assert.equal(stab.models.length, 1);
    assert.equal(stab.models[0].provider, "sensenova");
    assert.equal(stab.models[0].total, 1);
    assert.equal(stab.models[0].successRate, 0);

    // The fault banner keeps the member id as a display field.
    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.lastError.providerId, "sensenova");
    assert.equal(zcode.lastError.memberId, "sensenova-backup2");
  });

  it("feeds the real first-chunk TTFT of a streaming success into model-stability", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const req = collector.startRequest({ providerId: "furry", model: "gemini-3.7-flash" });
    mockTime = 2200; // TTFT = 1200ms
    req.recordFirstChunk();
    mockTime = 5200; // full duration 4200ms must NOT leak into ttftMs
    req.recordEnd({ usage: { prompt_tokens: 100, completion_tokens: 50 } });

    const stab = collector.getModelStability();
    assert.equal(stab.models[0].total, 1);
    assert.equal(stab.models[0].latencyMs, 4200);
    assert.equal(stab.models[0].ttftMs, 1200);
  });

  it("uses the full-duration TTFT proxy for a non-streaming success", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const req = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
    mockTime = 3500; // no recordFirstChunk: non-streaming, duration is the TTFT proxy
    req.recordEnd({ usage: { prompt_tokens: 50, completion_tokens: 10 } });

    const stab = collector.getModelStability();
    assert.equal(stab.models[0].ttftMs, 2500);
  });

  it("a failure before first chunk contributes no TTFT to model-stability", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const bad = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
    mockTime = 9000; // 8s of waiting must not become a TTFT sample
    bad.recordEnd({ status: 502, error: { status: 502, message: "Upstream Bad Gateway" } });

    const stab = collector.getModelStability();
    assert.equal(stab.models[0].total, 1);
    assert.equal(stab.models[0].successRate, 0);
    assert.equal(stab.models[0].ttftMs, null);
  });

  it("a retried pool attempt does not fabricate TTFT; only the real one counts", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const req = collector.startRequest({ providerId: "sensenova", model: "kimi-k3" });
    mockTime = 1500;
    req.recordRetry({ reason: "upstream_502", memberId: "sensenova-backup1" });
    mockTime = 4000; // TTFT of the successful attempt = 3000ms
    req.recordFirstChunk();
    mockTime = 5000;
    req.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 20 } });

    const stab = collector.getModelStability();
    assert.equal(stab.models.length, 1);
    assert.equal(stab.models[0].total, 2);
    assert.equal(stab.models[0].ttftMs, 3000);
  });
});

describe("auto-route node attribution (auto 不作为独立统计口径)", () => {
  function fakeJournal() {
    const lines = [];
    return { lines, appendRequest: (entry) => lines.push(entry) };
  }

  it("journal and stability attribute to the serving node + bound model when a chain resolver is set", () => {
    let mockTime = 1000;
    const journal = fakeJournal();
    const collector = testCollector({ nowFn: () => mockTime, journal });

    // An auto request enters under the chain head's URL segment with the
    // virtual model — the tracker meta is what the old stats tab saw.
    const req = collector.startRequest({ providerId: "chan-a", model: "auto", path: "openai" });
    req.setAttributeResolver((memberId) => ({
      "chan-a": { providerId: "chan-a", model: "model-a" },
      "pool-x/pool-m1": { providerId: "pool-x", model: "model-p" },
    })[memberId] ?? null);

    // Head node fails: the failed attempt counts under the node, not "auto".
    req.setCurrentMember("chan-a");
    mockTime = 1500;
    req.recordRetry({ reason: "upstream_503", memberId: "chan-a" });

    // A pool member answers the request.
    req.setCurrentMember("pool-x/pool-m1");
    mockTime = 2000;
    req.recordFirstChunk();
    mockTime = 3000;
    req.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 20 } });

    assert.equal(journal.lines.length, 1);
    assert.equal(journal.lines[0].providerId, "pool-x");
    assert.equal(journal.lines[0].model, "model-p");
    assert.equal(journal.lines[0].ok, true);

    const rows = collector.getModelStability().models;
    assert.equal(rows.length, 2, "one row per node — never an 'auto' row");
    const failedRow = rows.find((r) => r.provider === "chan-a");
    assert.equal(failedRow.model, "model-a");
    assert.equal(failedRow.total, 1);
    assert.equal(failedRow.successRate, 0);
    const okRow = rows.find((r) => r.provider === "pool-x");
    assert.equal(okRow.model, "model-p");
    assert.equal(okRow.total, 1);
    assert.equal(okRow.successRate, 100);
    assert.ok(!rows.some((r) => r.model === "auto"), "auto must not surface as a model row");
  });

  it("a terminal recordEnd carrying an explicit memberId resolves through the resolver", () => {
    let mockTime = 1000;
    const journal = fakeJournal();
    const collector = testCollector({ nowFn: () => mockTime, journal });

    const req = collector.startRequest({ model: "auto", path: "anthropic" });
    req.setAttributeResolver((memberId) => (memberId === "chan-b" ? { providerId: "chan-b", model: "model-b" } : null));
    req.setCurrentMember("chan-a"); // stale announcement — the explicit id wins
    mockTime = 2000;
    req.recordEnd({ status: 502, error: { status: 502, message: "exhausted" }, memberId: "chan-b" });

    assert.equal(journal.lines.length, 1);
    assert.equal(journal.lines[0].providerId, "chan-b");
    assert.equal(journal.lines[0].model, "model-b");
    assert.equal(journal.lines[0].ok, false);
  });

  it("requests without a resolver (direct and pool routing) keep their existing attribution", () => {
    let mockTime = 1000;
    const journal = fakeJournal();
    const collector = testCollector({ nowFn: () => mockTime, journal });

    const req = collector.startRequest({ providerId: "test-pool", model: "gpt-pool" });
    req.setCurrentMember("test-pool/member-a"); // set by the member loop even without a resolver
    mockTime = 2000;
    req.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });

    assert.equal(journal.lines[0].providerId, "test-pool");
    assert.equal(journal.lines[0].model, "gpt-pool");
    const rows = collector.getModelStability().models;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, "test-pool");
  });

  it("an unknown memberId resolves to null and falls back to the tracker meta", () => {
    let mockTime = 1000;
    const journal = fakeJournal();
    const collector = testCollector({ nowFn: () => mockTime, journal });

    const req = collector.startRequest({ providerId: "chan-a", model: "auto", path: "openai" });
    req.setAttributeResolver(() => null);
    req.setCurrentMember("chan-a");
    mockTime = 2000;
    req.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });

    assert.equal(journal.lines[0].providerId, "chan-a");
    assert.equal(journal.lines[0].model, "auto");
  });

  it("panel capsules show the serving node's bound model, never the virtual auto", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn, journal: fakeJournal() });

    const req = collector.startRequest({ providerId: "chan-a", model: "auto", path: "openai" });
    req.setAttributeResolver((memberId) => (memberId === "chan-a" ? { providerId: "chan-a", model: "glm-5.2" } : null));
    req.setCurrentMember("chan-a");

    let status = await collector.getAgentsStatus();
    let zcode = status.find((a) => a.id === "zcode");
    assert.deepEqual(zcode.activeModels, ["glm-5.2"], "active capsule carries the bound model mid-flight");
    assert.equal(zcode.currentModel, "glm-5.2");
    assert.equal(zcode.lastModel, "glm-5.2");

    mockTime = 3000;
    req.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });
    status = await collector.getAgentsStatus();
    zcode = status.find((a) => a.id === "zcode");
    assert.deepEqual(zcode.activeModels, [], "the bound-model key is the one decremented at end");
    assert.equal(zcode.lastModel, "glm-5.2", "最近 model survives as the bound model, not auto");
  });
});

describe("capsule 渠道×模型 composite ledger (同名坍缩修复 + 服务归因标记)", () => {
  function fakeJournal() {
    const lines = [];
    return { lines, appendRequest: (entry) => lines.push(entry) };
  }

  it("chain member announcement books the composite target with autoCount and flips viaAuto", async () => {
    let mockTime = 1000;
    const collector = testCollector({ nowFn: () => mockTime, journal: fakeJournal() });
    const req = collector.startRequest({ providerId: "chan-a", model: "auto", path: "openai" });
    req.setAttributeResolver(() => ({ providerId: "chan-b", model: "model-b" }));
    req.setCurrentMember("chan-b");

    const zcode = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
    assert.deepEqual(zcode.activeTargets, [{ providerId: "chan-b", model: "model-b", count: 1, autoCount: 1 }]);
    assert.equal(zcode.currentViaAuto, true);
    assert.equal(zcode.lastViaAuto, true);
    assert.equal(zcode.lastProvider, "chan-b", "provider follows the serving node for chain displays");
    assert.deepEqual(zcode.activeModels, ["model-b"], "旧模型名维度照旧（兼容旧面板）");
  });

  it("same-model cross-channel switch moves the composite key (A/a→B/a 不再被同名 no-op 吞掉)", async () => {
    let mockTime = 1000;
    const collector = testCollector({ nowFn: () => mockTime, journal: fakeJournal() });
    const req = collector.startRequest({ providerId: "chan-a", model: "auto", path: "openai" });
    req.setAttributeResolver((id) => ({
      "chan-a": { providerId: "chan-a", model: "shared-m" },
      "chan-b": { providerId: "chan-b", model: "shared-m" },
    })[id] ?? null);
    req.setCurrentMember("chan-a");
    req.setCurrentMember("chan-b"); // walk crossed to the next hop, same bound model name

    const zcode = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
    assert.deepEqual(zcode.activeTargets, [{ providerId: "chan-b", model: "shared-m", count: 1, autoCount: 1 }],
      "A/a unbooked, B/a booked — the cross-hop switch is visible");
  });

  it("two instances on different hops of one chain stay two targets (同名不坍缩)", async () => {
    let mockTime = 1000;
    const collector = testCollector({ nowFn: () => mockTime, journal: fakeJournal() });
    const resolver = (id) => ({
      "chan-a": { providerId: "chan-a", model: "shared-m" },
      "chan-b": { providerId: "chan-b", model: "shared-m" },
    })[id] ?? null;
    const r1 = collector.startRequest({ agentId: "kimi", instanceId: "ws-a", providerId: "chan-a", model: "auto", path: "openai" });
    const r2 = collector.startRequest({ agentId: "kimi", instanceId: "ws-b", providerId: "chan-a", model: "auto", path: "openai" });
    r1.setAttributeResolver(resolver);
    r2.setAttributeResolver(resolver);
    r1.setCurrentMember("chan-a"); // instance 1 rides the head
    r2.setCurrentMember("chan-a");
    r2.setCurrentMember("chan-b"); // instance 2 backed off to the next hop

    const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.deepEqual(
      kimi.activeTargets.map((t) => `${t.providerId}/${t.model}:${t.count}:${t.autoCount}`).sort(),
      ["chan-a/shared-m:1:1", "chan-b/shared-m:1:1"],
      "两跳各一颗胶囊，auto 归因各自独立（预备期虚模型记账已被各自的成员宣布释放）",
    );
    assert.deepEqual(kimi.activeModels, ["shared-m"], "旧模型名维度仍合并口径");

    r1.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
    r2.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const after = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.deepEqual(after.activeTargets, [], "全部结束后账本清空");
    assert.equal(after.lastViaAuto, true, "最近模型的链归因保留");
  });

  it("late attachInstance after the chain announcement replays attribution to the mirror (迟挂载不丢自动路由)", async () => {
    // netstat 快照 miss 的真实时序：请求落聚合桶 → 链布线/成员宣布完成 →
    // 快照刷新后才 attachInstance 补挂。镜像在宣布之后创建，必须把已宣布的
    // 链归属重放进去，否则实例行把链服务请求整段显示成直连「生成中」。
    let mockTime = 1000;
    const collector = testCollector({ nowFn: () => mockTime, journal: fakeJournal() });
    const req = collector.startRequest({ agentId: "kimi", providerId: null, model: "auto", path: "openai" });
    req.setAttributeResolver((memberId) => (memberId === "chan-a/m1" ? { providerId: "chan-a", model: "kimi-k3" } : null));
    req.setCurrentMember("chan-a/m1");

    req.attachInstance("ws-a"); // 快照补挂晚于成员宣布

    const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    const inst = kimi.instances.find((i) => i.id === "ws-a");
    assert.ok(inst, "补挂后实例行出现");
    assert.deepEqual(inst.activeTargets, [
      { providerId: "chan-a", model: "kimi-k3", count: 1, autoCount: 1 },
    ], "镜像重放已宣布的链归属，按服务归因记账");

    req.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const after = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    const instAfter = after.instances.find((i) => i.id === "ws-a");
    assert.deepEqual(instAfter?.activeTargets ?? [], [], "结束后镜像账本清空");
  });

  it("attach before the chain announcement still receives it via the fan-out (先挂后宣布)", async () => {
    // 快照 miss 但补挂赶在成员循环之前的时序：镜像只预置 resolver，宣布
    // 经 composed 扇出到达，归因同样成立。
    let mockTime = 1000;
    const collector = testCollector({ nowFn: () => mockTime, journal: fakeJournal() });
    const req = collector.startRequest({ agentId: "kimi", providerId: null, model: "auto", path: "openai" });
    req.attachInstance("ws-a");
    req.setAttributeResolver((memberId) => (memberId === "chan-a/m1" ? { providerId: "chan-a", model: "kimi-k3" } : null));
    req.setCurrentMember("chan-a/m1");

    const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    const inst = kimi.instances.find((i) => i.id === "ws-a");
    assert.deepEqual(inst.activeTargets, [
      { providerId: "chan-a", model: "kimi-k3", count: 1, autoCount: 1 },
    ]);
    req.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });

  it("late-attached direct request keeps autoCount 0 (重放不误标直连)", async () => {
    let mockTime = 1000;
    const collector = testCollector({ nowFn: () => mockTime, journal: fakeJournal() });
    const req = collector.startRequest({ agentId: "kimi", providerId: "chan-d", model: "m9", path: "openai" });
    req.attachInstance("ws-a");

    const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    const inst = kimi.instances.find((i) => i.id === "ws-a");
    assert.deepEqual(inst.activeTargets, [
      { providerId: "chan-d", model: "m9", count: 1, autoCount: 0 },
    ], "直连请求没有可重放的链归属，账本维持直连口径");
    req.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });

  it("direct request books the entry channel with autoCount 0 and viaAuto stays false", async () => {
    let mockTime = 1000;
    const collector = testCollector({ nowFn: () => mockTime, journal: fakeJournal() });
    const req = collector.startRequest({ providerId: "chan-d", model: "m9", path: "openai" });
    req.setCurrentMember("chan-d/member-1"); // member loop announces even without a resolver

    const zcode = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
    assert.deepEqual(zcode.activeTargets, [{ providerId: "chan-d", model: "m9", count: 1, autoCount: 0 }]);
    assert.equal(zcode.lastViaAuto, false);
  });

  it("mixed provenance on one pair: autoCount tracks chain-served requests only", async () => {
    let mockTime = 1000;
    const collector = testCollector({ nowFn: () => mockTime, journal: fakeJournal() });
    const direct = collector.startRequest({ providerId: "chan-a", model: "shared-m", path: "openai" });
    const chained = collector.startRequest({ providerId: "chan-a", model: "auto", path: "openai" });
    chained.setAttributeResolver(() => ({ providerId: "chan-a", model: "shared-m" }));
    chained.setCurrentMember("chan-a");

    let zcode = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
    assert.deepEqual(zcode.activeTargets, [{ providerId: "chan-a", model: "shared-m", count: 2, autoCount: 1 }]);

    direct.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
    zcode = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
    assert.deepEqual(zcode.activeTargets, [{ providerId: "chan-a", model: "shared-m", count: 1, autoCount: 1 }],
      "直连请求结束不动 autoCount");
  });

  it("instance snapshot exposes current/last model + provider + viaAuto (实例行 模型@渠道 数据源)", async () => {
    let mockTime = 1000;
    const collector = testCollector({ nowFn: () => mockTime, journal: fakeJournal() });
    const req = collector.startRequest({ agentId: "kimi", instanceId: "ws-9", providerId: "chan-a", model: "auto", path: "openai" });
    req.setAttributeResolver(() => ({ providerId: "chan-b", model: "model-b" }));
    req.setCurrentMember("chan-b");

    const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    const inst = kimi.instances.find((i) => i.id === "ws-9");
    assert.equal(inst.currentModel, "model-b");
    assert.equal(inst.currentProvider, "chan-b");
    assert.equal(inst.currentViaAuto, true);
    assert.equal(inst.lastModel, "model-b");
    assert.equal(inst.lastProvider, "chan-b");
    assert.equal(inst.lastViaAuto, true);
  });
});

describe("createSessionReporter", () => {
  function reporterHarness({ mockTimeBase = 1000 } = {}) {
    let mockTime = mockTimeBase;
    const lines = [];
    const journal = { lines, appendRequest: (entry) => lines.push(entry) };
    const posted = [];
    const reporter = createSessionReporter({
      reportUrl: "http://report.invalid/panel/api/session/report",
      journal,
      nowFn: () => mockTime,
      fetchFn: (url, init) => {
        posted.push(JSON.parse(init.body));
        return Promise.resolve({ ok: true });
      },
    });
    return { reporter, lines, posted, tick: (t) => { mockTime = t; } };
  }

  it("journals one request row per recordEnd with anthropic-shaped usage normalized", async () => {
    const { reporter, lines, tick } = reporterHarness();
    reporter.startRequest({ model: "claude-opus-5", stream: true, path: "anthropic" });
    tick(1500);
    reporter.recordFirstChunk();
    tick(4000);
    reporter.recordEnd({ status: 200, usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 5 } });

    assert.equal(lines.length, 1);
    const row = lines[0];
    assert.equal(row.agentId, "claude");
    assert.equal(row.model, "claude-opus-5");
    assert.equal(row.providerId, "");
    assert.equal(row.prompt, 12);
    assert.equal(row.completion, 7);
    assert.equal(row.cached, 5);
    assert.equal(row.ok, true);
    assert.equal(row.status, 200);
    assert.equal(row.errKind, null);
    assert.equal(row.stream, true);
    assert.equal(row.path, "anthropic");
    assert.equal(row.ttftMs, 500, "first-chunk TTFT");
    assert.equal(row.durationMs, 3000);
  });

  it("journals request rows and snapshots under the configured agentId (kimi), default stays claude", async () => {
    // kimi per-launch relay 复用同一 reporter：journal 行与上报快照都必须
    // 带上自己的 agentId，否则 kimi 流量会被记进 claude 桶。
    let mockTime = 1000;
    const lines = [];
    const journal = { lines, appendRequest: (entry) => lines.push(entry) };
    const posted = [];
    const reporter = createSessionReporter({
      agentId: "kimi",
      reportUrl: "http://report.invalid/panel/api/session/report",
      journal,
      nowFn: () => mockTime,
      fetchFn: (url, init) => {
        posted.push(JSON.parse(init.body));
        return Promise.resolve({ ok: true });
      },
    });
    reporter.setClaudePid(4242);
    reporter.startRequest({ model: "kimi-k3", stream: false, path: "anthropic" });
    mockTime = 3000;
    reporter.recordEnd({ status: 200, usage: { input_tokens: 8, output_tokens: 4 } });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].agentId, "kimi");
    assert.equal(lines[0].model, "kimi-k3");
    assert.ok(posted.length > 0);
    assert.ok(posted.every((body) => body.agentId === "kimi"), "every snapshot carries the configured agentId");

    // 不传 agentId 时保持 claude 默认（claude 现有行为零回归）
    const defaultPosted = [];
    const defaultReporter = createSessionReporter({
      reportUrl: "http://report.invalid/panel/api/session/report",
      nowFn: () => 1000,
      fetchFn: (url, init) => {
        defaultPosted.push(JSON.parse(init.body));
        return Promise.resolve({ ok: true });
      },
    });
    defaultReporter.setClaudePid(1);
    assert.equal(defaultPosted[0].agentId, "claude");
  });

  it("auto requests journal to the serving chain node via the member resolver", async () => {
    const { reporter, lines, tick } = reporterHarness();
    reporter.startRequest({ model: "auto", stream: false, path: "anthropic" });
    reporter.setAttributeResolver((memberId) => (memberId === "pool-x/member-a" ? { providerId: "pool-x", model: "glm-5.2" } : null));
    reporter.setCurrentMember("pool-x/member-a");
    tick(2500);
    reporter.recordEnd({ status: 200, usage: { input_tokens: 9, output_tokens: 3 } });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].providerId, "pool-x", "pool node attributes at pool level, same as direct pool traffic");
    assert.equal(lines[0].model, "glm-5.2", "the node's bound model, never the virtual auto");
  });

  it("aborts are not journaled and failed rows carry errKind", async () => {
    const { reporter, lines, tick } = reporterHarness();
    reporter.startRequest({ model: "auto", stream: true, path: "anthropic" });
    reporter.setAttributeResolver(() => null);
    tick(1500);
    reporter.recordEnd({ aborted: true });
    assert.equal(lines.length, 0, "aborted request writes no journal row");

    reporter.startRequest({ model: "auto", stream: false, path: "anthropic" });
    tick(2600);
    reporter.recordEnd({ status: 503, error: { status: 503, message: "upstream unavailable" } });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].ok, false);
    assert.equal(lines[0].status, 503);
    assert.equal(lines[0].errKind, "http_5xx");
    assert.equal(lines[0].ttftMs, null, "failed requests fabricate no TTFT");
  });

  it("failed request snapshots carry the model on lastError for the panel banner", async () => {
    // The panel's fault banner renders `HTTP <status> · <model>` from
    // lastError.model. Direct requests name the requested model; chain (auto)
    // requests name the serving node's bound model — never the virtual "auto".
    const { reporter, posted, tick } = reporterHarness();
    reporter.startRequest({ model: "anthropic/chan-a/qwen-max", stream: true, path: "anthropic" });
    tick(2000);
    reporter.recordEnd({ status: 504, error: { status: 504, message: "upstream timeout" } });
    const direct = posted[posted.length - 1];
    assert.equal(direct.lastError.status, 504);
    assert.equal(direct.lastError.model, "anthropic/chan-a/qwen-max");

    reporter.startRequest({ model: "auto", stream: false, path: "anthropic" });
    reporter.setAttributeResolver((memberId) => (memberId === "chan-a/m1" ? { providerId: "chan-a", model: "glm-5.2" } : null));
    reporter.setCurrentMember("chan-a/m1");
    tick(4000);
    reporter.recordEnd({ status: 502, error: { status: 502, message: "bad gateway" } });
    const chained = posted[posted.length - 1];
    assert.equal(chained.lastError.model, "glm-5.2", "chain failures attribute to the serving node's model");
  });

  it("accumulates metrics and POSTs cumulative snapshots on each request end", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const posted = [];
    const fetchFn = (url, init) => {
      posted.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return Promise.resolve({ ok: true });
    };

    const reporter = createSessionReporter({
      token: "tok_abc",
      reportUrl: "http://127.0.0.1:47821/panel/api/session/report",
      nowFn,
      fetchFn,
    });
    reporter.setClaudePid(5555);

    // Initial snapshot on PID set
    assert.equal(posted.length, 1);
    assert.equal(posted[0].body.pid, 5555);
    assert.equal(posted[0].body.requests, 0);
    assert.equal(posted[0].body.activeRequests, 0);

    // Request 1: streaming with usage
    reporter.startRequest();
    assert.equal(posted.length, 2);
    assert.equal(posted[1].body.requests, 1);
    assert.equal(posted[1].body.activeRequests, 1);

    mockTime = 2500; // TTFT = 1500ms
    reporter.recordFirstChunk();
    mockTime = 4000; // generation duration = 1500ms
    reporter.recordEnd({
      usage: { prompt_tokens: 2000, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 1500 } },
    });

    assert.equal(posted.length, 3);
    assert.equal(posted[2].url, "http://127.0.0.1:47821/panel/api/session/report");
    assert.equal(posted[2].headers.authorization, "Bearer tok_abc");
    assert.equal(posted[2].headers["x-anyswitch-panel"], "1");
    assert.equal(posted[2].body.token, undefined);
    assert.equal(posted[2].body.pid, 5555);
    assert.equal(posted[2].body.requests, 1);
    assert.equal(posted[2].body.activeRequests, 0);
    assert.equal(posted[2].body.lastTtftMs, 1500);
    assert.equal(posted[2].body.promptTokens, 2000);
    assert.equal(posted[2].body.completionTokens, 60);
    assert.equal(posted[2].body.cachedTokens, 1500);

    // Request 2: non-streaming, Anthropic-shaped usage
    mockTime = 5000;
    reporter.startRequest();
    assert.equal(posted.length, 4);
    assert.equal(posted[3].body.requests, 2);
    assert.equal(posted[3].body.activeRequests, 1);

    mockTime = 7000;
    reporter.recordEnd({ usage: { input_tokens: 500, output_tokens: 30 } });

    assert.equal(posted.length, 5);
    assert.equal(posted[4].body.requests, 2);
    assert.equal(posted[4].body.activeRequests, 0);
    assert.equal(posted[4].body.promptTokens, 2500); // 2000 + 500
    assert.equal(posted[4].body.completionTokens, 90); // 60 + 30
    assert.equal(posted[4].body.cachedTokens, 1500); // unchanged
  });

  it("reports lastError and errorActive, cleared by a later clean success", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const posted = [];
    const fetchFn = (url, init) => {
      posted.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true });
    };

    const reporter = createSessionReporter({
      token: "tok_err",
      reportUrl: "http://127.0.0.1:47821/panel/api/session/report",
      nowFn,
      fetchFn,
    });
    reporter.setClaudePid(8888);

    // Request 1: fails with 429 before any first chunk
    reporter.startRequest();
    mockTime = 3000;
    reporter.recordEnd({ error: { status: 429, message: "rate limited" } });

    // posted: [0]=setClaudePid, [1]=startRequest, [2]=recordEnd
    assert.equal(posted.length, 3);
    assert.equal(posted[2].errorActive, true);
    assert.equal(posted[2].lastError.status, 429);
    assert.equal(posted[2].lastError.message, "rate limited");
    assert.equal(posted[2].lastTtftMs, null, "no first chunk → no fabricated TTFT");

    // Request 2: retry begin must keep the 429 latched so a looping retry
    // still surfaces on the panel. First token is what recovers.
    reporter.startRequest();
    // posted[3] is the begin snapshot of request 2
    assert.equal(posted[3].errorActive, true, "retry begin must keep the prior fault visible");
    assert.equal(posted[3].lastError.status, 429, "error history retained");
    assert.equal(posted[3].activeRequests, 1);

    mockTime = 4000;
    reporter.recordFirstChunk();
    mockTime = 5000;
    reporter.recordEnd({ usage: { prompt_tokens: 100, completion_tokens: 10 } });

    // posted: [3]=startRequest, [4]=recordEnd
    assert.equal(posted.length, 5);
    assert.equal(posted[4].errorActive, false);
    assert.equal(posted[4].lastError.status, 429, "error history retained for context");
    assert.equal(posted[4].lastTtftMs, 1000);
  });

  it("sends ended:true on reportEnd", async () => {
    const posted = [];
    const fetchFn = (url, init) => {
      posted.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true });
    };
    const reporter = createSessionReporter({
      token: "tok_end",
      reportUrl: "http://127.0.0.1:47821/panel/api/session/report",
      nowFn: () => 1000,
      fetchFn,
    });
    reporter.setClaudePid(6666);
    reporter.startRequest();
    reporter.recordEnd({ usage: { prompt_tokens: 10, completion_tokens: 5 } });

    reporter.reportEnd();

    const last = posted[posted.length - 1];
    assert.equal(last.ended, true);
    assert.equal(last.pid, 6666);
  });

  it("swallows POST failures silently", async () => {
    const fetchFn = () => Promise.reject(new Error("connection refused"));
    const reporter = createSessionReporter({
      token: "tok_fail",
      reportUrl: "http://127.0.0.1:47821/panel/api/session/report",
      nowFn: () => 1000,
      fetchFn,
    });
    reporter.setClaudePid(7777);
    // Should not throw
    reporter.startRequest();
    reporter.recordEnd({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
    reporter.reportEnd();
  });

  it("handles concurrent requests without clobbering start/end times in createSessionReporter", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const posted = [];
    const fetchFn = (url, init) => {
      posted.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true });
    };
    const reporter = createSessionReporter({
      token: "tok_concurrent",
      reportUrl: "http://127.0.0.1:47821/panel/api/session/report",
      nowFn,
      fetchFn,
    });
    reporter.setClaudePid(9999);

    const r1 = reporter.startRequest();
    mockTime = 2000;
    const r2 = reporter.startRequest();
    mockTime = 3000;
    r2.recordFirstChunk();
    mockTime = 4000; // r2 duration = 2000ms (4000-2000), genDuration = 1000ms (4000-3000)
    r2.recordEnd({ usage: { input_tokens: 100, output_tokens: 20 } }); // 20 tok / 1s = 20 tok/s

    mockTime = 5000;
    r1.recordFirstChunk();
    mockTime = 7000; // r1 duration = 6000ms (7000-1000), genDuration = 2000ms (7000-5000)
    r1.recordEnd({ usage: { input_tokens: 200, output_tokens: 40 } }); // 40 tok / 2s = 20 tok/s

    // posted: [0]=setClaudePid, [1]=r1 start, [2]=r2 start, [3]=r2 end, [4]=r1 end
    assert.equal(posted.length, 5);
    assert.equal(posted[3].requests, 2);
    assert.equal(posted[3].activeRequests, 1);
    assert.equal(posted[3].completionTokens, 20);

    assert.equal(posted[4].requests, 2);
    assert.equal(posted[4].activeRequests, 0);
    assert.equal(posted[4].completionTokens, 60);
  });

  it("settles interleaved recordEnd calls — concurrent ends never pin activeRequests at 1", async () => {
    // Claude Code fires concurrent in-session requests (side queries, rapid
    // re-send after Esc). The transport ends them out of start order; every
    // terminal end must decrement the counter, or the session's panel capsule
    // stays 生成中 forever.
    const { reporter, posted, tick } = reporterHarness();
    reporter.setClaudePid(4321);

    reporter.startRequest({ model: "m1", stream: true, path: "anthropic" });
    tick(2000);
    reporter.startRequest({ model: "m1", stream: true, path: "anthropic" });
    tick(3000);
    reporter.recordEnd({ usage: { input_tokens: 10, output_tokens: 5 } }); // first request ends
    assert.equal(posted[posted.length - 1].activeRequests, 1);
    tick(4000);
    reporter.recordEnd({ usage: { input_tokens: 10, output_tokens: 5 } }); // second ends
    assert.equal(posted[posted.length - 1].activeRequests, 0);
  });

  it("heartbeats snapshots while a request is in flight and stops once idle", async () => {
    const posted = [];
    const reporter = createSessionReporter({
      reportUrl: "http://report.invalid/panel/api/session/report",
      fetchFn: (url, init) => {
        posted.push(JSON.parse(init.body));
        return Promise.resolve({ ok: true });
      },
      heartbeatIntervalMs: 25,
    });
    reporter.setClaudePid(3131);

    const r = reporter.startRequest({ model: "m1", stream: true });
    const afterStart = posted.length;
    // Poll instead of one fixed sleep — under full-suite load timer ticks drift.
    const deadline = Date.now() + 2000;
    while (posted.length - afterStart < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const beats = posted.length - afterStart;
    assert.ok(beats >= 2, `expected heartbeat snapshots while generating, got ${beats}`);
    assert.equal(posted[posted.length - 1].activeRequests, 1);

    r.recordEnd({ usage: { input_tokens: 1, output_tokens: 1 } });
    const settled = posted.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(posted.length, settled, "no heartbeats once the session is idle");
    assert.equal(posted[posted.length - 1].activeRequests, 0);
  });

  it("counts overlapping requests as a wall-clock union, not a per-request sum (reporter)", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const posted = [];
    const fetchFn = (url, init) => {
      posted.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true });
    };
    const reporter = createSessionReporter({
      token: "tok_union",
      reportUrl: "http://127.0.0.1:47821/panel/api/session/report",
      nowFn,
      fetchFn,
    });
    reporter.setClaudePid(8888);

    const r1 = reporter.startRequest(); // busy interval opens at 1000
    mockTime = 2000;
    const r2 = reporter.startRequest(); // overlaps — same physical seconds
    mockTime = 3000;
    r2.recordEnd({ usage: { input_tokens: 100, output_tokens: 10 } });
    // r2 ended but r1 still in flight: snapshot = in-flight tail (3000-1000)
    assert.equal(posted[posted.length - 1].activeDurationMs, 2000);

    mockTime = 7000;
    r1.recordEnd({ usage: { input_tokens: 100, output_tokens: 10 } });
    // Interval settles once, from 1000 to 7000 = 6000ms — NOT 2000+6000 summed
    const last = posted[posted.length - 1];
    assert.equal(last.activeDurationMs, 6000);
    assert.equal(last.activeRequests, 0);
  });

  it("keeps reporter snapshots monotonic across sequential requests", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const posted = [];
    const fetchFn = (url, init) => {
      posted.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true });
    };
    const reporter = createSessionReporter({
      token: "tok_seq",
      reportUrl: "http://127.0.0.1:47821/panel/api/session/report",
      nowFn,
      fetchFn,
    });
    reporter.setClaudePid(1234);

    const r1 = reporter.startRequest(); // 1000 -> 3000 = 2000ms
    mockTime = 3000;
    r1.recordEnd({});
    assert.equal(posted[posted.length - 1].activeDurationMs, 2000);

    mockTime = 5000;
    const r2 = reporter.startRequest(); // 5000 -> 8000 = 3000ms
    mockTime = 8000;
    r2.recordEnd({});
    assert.equal(posted[posted.length - 1].activeDurationMs, 5000);
  });

  it("counts overlapping aggregate requests as a wall-clock union, not a per-request sum", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const req1 = collector.startRequest({ providerId: "furry", model: "gemini-3.7-flash" }); // interval opens at 1000
    mockTime = 2000;
    const req2 = collector.startRequest({ providerId: "furry", model: "gemini-3.7-flash" }); // overlaps
    mockTime = 4000;
    req2.recordEnd({ usage: { prompt_tokens: 100, completion_tokens: 10 } });
    mockTime = 7000;
    req1.recordEnd({ usage: { prompt_tokens: 100, completion_tokens: 10 } }); // interval settles: 7000-1000

    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    // Union of [1000,7000] = 6000ms — the old per-request sum would report 8000
    assert.equal(zcode.metrics.activeDurationMs, 6000);
    assert.equal(zcode.sessions[0].activeDurationMs, 6000);
  });

  it("includes the still-running tail when reading status mid-request", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    collector.startRequest({ providerId: "furry", model: "gemini-3.7-flash" });
    mockTime = 3500;
    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.metrics.activeDurationMs, 2500);
  });

  it("sums durations of strictly sequential requests (union degenerates to sum)", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const req1 = collector.startRequest({ providerId: "furry", model: "gemini-3.7-flash" });
    mockTime = 3000;
    req1.recordEnd({});
    const req2 = collector.startRequest({ providerId: "furry", model: "gemini-3.7-flash" });
    mockTime = 8000;
    req2.recordEnd({});

    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.metrics.activeDurationMs, 7000); // 2000 + 5000
  });

  it("treats a one-packet reply as unmeasurable instead of inventing a denominator", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    // Total turn: 1000ms (TTFT = 999ms), output arrived in 1ms (2 tokens). The
    // quotient (2000 tok/s) is a burst artifact, and the full turn is no better a
    // denominator — it is almost entirely first-token wait. Such a request
    // carries no speed measurement at all, exactly as the statistics page treats
    // it (a generation window under 0.2s), so the card reports nothing rather
    // than a fabricated number.
    const req = collector.startRequest({ providerId: "acme-default", model: "claude-sonnet-4-6" });
    mockTime = 1999;
    req.recordFirstChunk();
    mockTime = 2000;
    req.recordEnd({ usage: { prompt_tokens: 500, completion_tokens: 2 } });

    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.metrics.tps, null, "no measured window, no number");
    assert.deepEqual(zcode.metrics.sparkHistory.tps, [], "and no point on the curve");
    assert.equal(zcode.metrics.tokens.completion, 2, "the tokens themselves are still counted");
  });

  it("releases activeModels and currentModel immediately on abort", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const reqA = collector.startRequest({ providerId: "furry", model: "model-A" });
    let status = await collector.getAgentsStatus();
    let zcode = status.find((a) => a.id === "zcode");
    assert.deepEqual(zcode.activeModels, ["model-A"]);
    assert.equal(zcode.currentModel, "model-A");

    // Start model B (user switched model)
    const reqB = collector.startRequest({ providerId: "furry", model: "model-B" });
    status = await collector.getAgentsStatus();
    zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.activeModels.length, 2);

    // Abort model A immediately
    reqA.recordEnd({ aborted: true });
    status = await collector.getAgentsStatus();
    zcode = status.find((a) => a.id === "zcode");
    assert.deepEqual(zcode.activeModels, ["model-B"]);
    assert.equal(zcode.currentModel, "model-B");

    // Complete model B
    reqB.recordEnd({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
    status = await collector.getAgentsStatus();
    zcode = status.find((a) => a.id === "zcode");
    assert.deepEqual(zcode.activeModels, []);
    assert.equal(zcode.currentModel, null);
    assert.equal(zcode.lastModel, "model-B");
  });

  it("publishes a token-weighted window speed, not an average of per-request quotients and not a combined sum", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    // Request 1: 40 tokens generated over 1.0s -> 40.0 tok/s
    const req1 = collector.startRequest({ providerId: "furry", model: "model-1" });
    mockTime = 1500;
    req1.recordFirstChunk();
    mockTime = 2500;
    req1.recordEnd({ usage: { prompt_tokens: 100, completion_tokens: 40 } });

    // Request 2: 60 tokens generated over 1.0s -> 60.0 tok/s
    const req2 = collector.startRequest({ providerId: "furry", model: "model-2" });
    mockTime = 3000;
    req2.recordFirstChunk();
    mockTime = 4000;
    req2.recordEnd({ usage: { prompt_tokens: 100, completion_tokens: 60 } });

    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    // 100 tokens over 2.0s = 50.0 tok/s: neither the combined 100 (the two
    // requests never generated at the same time) nor a couple of quotients
    // averaged by hand.
    assert.equal(zcode.metrics.tps, 50);
    assert.deepEqual(zcode.metrics.sparkHistory.tps, [40, 60]);
  });

  it("publishes a fast model at its real speed — a long first-token wait is not generation time", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    // A realistic live shape (dsh / deepseek-v4.1): 810 tokens streamed in
    // 3.0s at the tail of an 8.0s turn.
    const req = collector.startRequest({ providerId: "sta1n-default", model: "deepseek-v4.1-flash" });
    mockTime = 6000;
    req.recordFirstChunk(); // 5s first-token wait
    mockTime = 9000;
    req.recordEnd({ usage: { prompt_tokens: 20000, completion_tokens: 810 } });

    const zcode = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
    // 810 / 3.0s = 270 tok/s. The guard this replaced rewrote the denominator to
    // the whole 8.0s turn whenever a rate passed 200 tok/s, which printed 101.
    assert.equal(zcode.metrics.tps, 270);
    assert.deepEqual(zcode.metrics.sparkHistory.tps, [270]);
  });

  it("keeps a tool-call burst out of the window instead of clamping it to a fake ceiling", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    // Tool call response: 80 tokens, total turn 400ms, firstChunk to end 2ms.
    // The burst is not a rate (40000 tok/s) — and the whole turn is not one
    // either (the reply was already written when the turn had 398ms left).
    const req = collector.startRequest({ providerId: "acme-default", model: "gemini-3.7-flash" });
    mockTime = 1398;
    req.recordFirstChunk();
    mockTime = 1400;
    req.recordEnd({ usage: { prompt_tokens: 200, completion_tokens: 80 } });

    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.metrics.tps, null);
    assert.deepEqual(zcode.metrics.sparkHistory.tps, []);
    assert.equal(zcode.metrics.tokens.completion, 80);
  });

  it("routes DSH requests and tracks DSH aggregate metrics independently from ZCode", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => {
      // WMIC output containing one ZCode process and one DSH process
      const csv = `Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\Programs\\ZCode.exe,20588\r\nLAPTOP,"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",node.exe,14280\r\n`;
      cb(null, csv);
    };

    const collector = testCollector({ execFn: mockExec, nowFn });

    // 1. ZCode request
    const zReq = collector.startRequest({ providerId: "furry", model: "claude-3-7-sonnet" });
    mockTime = 1800; // TTFT = 800ms
    zReq.recordFirstChunk();
    mockTime = 2800; // 1000ms gen duration
    zReq.recordEnd({ usage: { prompt_tokens: 500, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 200 } } });

    // 2. DSH request (identified via agentId or userAgent)
    const dshReq = collector.startRequest({ agentId: "dsh", providerId: "_deepseek", model: "deepseek-chat" });
    mockTime = 3800; // TTFT = 1000ms
    dshReq.recordFirstChunk();
    mockTime = 4800; // 1000ms gen duration
    dshReq.recordEnd({ usage: { prompt_tokens: 1000, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 800 } } });

    const status = await collector.getAgentsStatus();
    assert.ok(status.find((a) => a.id === "kimi"));
    assert.ok(status.find((a) => a.id === "pi"));

    const zcode = status.find((a) => a.id === "zcode");
    const dsh = status.find((a) => a.id === "dsh");

    assert.ok(zcode);
    assert.ok(dsh);

    // ZCode assertions
    assert.equal(zcode.status, "running");
    assert.equal(zcode.processCount, 1);
    assert.equal(zcode.lastModel, "claude-3-7-sonnet");
    assert.equal(zcode.metrics.totalRequests, 1);
    assert.equal(zcode.metrics.tps, 40); // 40 tokens / 1.0s
    assert.equal(zcode.metrics.cacheHitRate, 40); // 200 / 500 = 40%
    assert.equal(zcode.metrics.tokens.prompt, 500);
    assert.equal(zcode.metrics.tokens.completion, 40);

    // DSH assertions
    assert.equal(dsh.status, "running");
    assert.equal(dsh.processCount, 1);
    assert.equal(dsh.lastModel, "deepseek-chat");
    assert.equal(dsh.metrics.totalRequests, 1);
    assert.equal(dsh.metrics.tps, 80); // 80 tokens / 1.0s
    assert.equal(dsh.metrics.cacheHitRate, 80); // 800 / 1000 = 80%
    assert.equal(dsh.metrics.tokens.prompt, 1000);
    assert.equal(dsh.metrics.tokens.completion, 80);
    assert.equal(dsh.sessions.length, 1);
    assert.equal(dsh.sessions[0].id, "dsh-global");
  });

  it("routes DSH request by User-Agent header if agentId is missing", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const req = collector.startRequest({
      userAgent: "deepseek-harness/1.0.0 (+https://github.com/deepseek-ai/deepseek-harness)",
      providerId: "_deepseek",
      model: "deepseek-reasoner",
    });
    mockTime = 2000;
    req.recordFirstChunk();
    mockTime = 3000;
    req.recordEnd({ usage: { prompt_tokens: 300, completion_tokens: 30 } });

    const status = await collector.getAgentsStatus();
    const dsh = status.find((a) => a.id === "dsh");
    const zcode = status.find((a) => a.id === "zcode");

    assert.equal(dsh.metrics.totalRequests, 1);
    assert.equal(dsh.lastModel, "deepseek-reasoner");
    assert.equal(zcode.metrics.totalRequests, 0);
  });

  it("exports authoritative sparkHistory in metrics for robust UI reconnection/history preservation", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    // Request 1: 500ms TTFT, 50 tok/s, 50% cache hit
    const r1 = collector.startRequest({ providerId: "furry", model: "claude-3-7-sonnet" });
    mockTime = 1500;
    r1.recordFirstChunk();
    mockTime = 2500;
    r1.recordEnd({ usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 500 } } });

    // Request 2: 1200ms TTFT, 100 tok/s, 80% cache hit
    mockTime = 3000;
    const r2 = collector.startRequest({ providerId: "furry", model: "claude-3-7-sonnet" });
    mockTime = 4200;
    r2.recordFirstChunk();
    mockTime = 5200;
    r2.recordEnd({ usage: { prompt_tokens: 500, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } } });

    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    assert.ok(zcode);
    assert.ok(zcode.metrics.sparkHistory);
    assert.deepEqual(zcode.metrics.sparkHistory.ttft, [0.5, 1.2]);
    assert.deepEqual(zcode.metrics.sparkHistory.tps, [50, 100]);
    assert.deepEqual(zcode.metrics.sparkHistory.cache, [50, 80]);
  });

  it("carries per-instance sparkHistory so instance sparklines survive page reloads", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    // Instance ws-a: 500ms then 400ms TTFT (seconds mapping, same rule as endpoint level).
    const r1 = collector.startRequest({ agentId: "kimi", instanceId: "ws-a", providerId: "p1", model: "m1", stream: true, path: "openai" });
    mockTime = 1500;
    r1.recordFirstChunk();
    mockTime = 2500;
    r1.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 50 } });
    const r2 = collector.startRequest({ agentId: "kimi", instanceId: "ws-a", providerId: "p1", model: "m1", stream: true, path: "openai" });
    mockTime = 2900;
    r2.recordFirstChunk();
    mockTime = 3900;
    r2.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 25 } });

    // Untagged kimi traffic lands in the aggregate only — it must not bend the instance curve.
    const r3 = collector.startRequest({ agentId: "kimi", providerId: "p1", model: "m1", stream: true, path: "openai" });
    mockTime = 9000;
    r3.recordFirstChunk();
    mockTime = 10000;
    r3.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 10 } });

    const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.deepEqual(kimi.metrics.sparkHistory.ttft, [0.5, 0.4, 5.1], "aggregate keeps all traffic");

    const wsA = kimi.instances[0];
    assert.deepEqual(Object.keys(wsA.sparkHistory).sort(), ["cache", "tps", "ttft"],
      "instance snapshot mirrors the endpoint metrics.sparkHistory shape");
    assert.deepEqual(wsA.sparkHistory.ttft, [0.5, 0.4], "per-instance ttft history in seconds, isolated from untagged traffic");
    assert.deepEqual(wsA.sparkHistory.tps, [50, 25]);
  });

  it("carries per-session sparkHistory so cc-card sparklines survive page reloads", async () => {
    // Session reporter builds a per-request sample ring and ships it in every
    // snapshot; the collector persists it on the claudeSessions row and the
    // per-session snapshot surfaces it — the same contract instances use.
    let mockTime = 1000;
    const lines = [];
    const journal = { lines, appendRequest: (entry) => lines.push(entry) };
    const posted = [];
    const reporter = createSessionReporter({
      reportUrl: "http://report.invalid/panel/api/session/report",
      journal,
      nowFn: () => mockTime,
      fetchFn: (url, init) => {
        posted.push(JSON.parse(init.body));
        return Promise.resolve({ ok: true });
      },
    });

    // Request 1: streaming, 500ms TTFT, 50 tokens over 2s → 25 tok/s.
    reporter.setClaudePid(4242); // session identity: reportSession keys on this PID
    reporter.startRequest({ model: "claude-opus-5", stream: true, path: "anthropic" });
    mockTime = 1500;
    reporter.recordFirstChunk();
    mockTime = 3500;
    reporter.recordEnd({ status: 200, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 40 } });
    // Request 2: non-streaming success — full duration is the TTFT proxy
    // (journal rule), so the sample's ttftMs is null and ttft history stays
    // [0.5]. It also has no generation window, so it contributes no speed point.
    reporter.startRequest({ model: "claude-opus-5", stream: false, path: "anthropic" });
    mockTime = 5000;
    reporter.recordEnd({ status: 200, usage: { input_tokens: 80, output_tokens: 25 } });
    // Request 3: failure — no sample (same eligibility as the aggregate ring).
    reporter.startRequest({ model: "claude-opus-5", stream: true, path: "anthropic" });
    mockTime = 6000;
    reporter.recordEnd({ status: 502, error: { status: 502, message: "Upstream Error" } });

    const last = posted[posted.length - 1];
    assert.ok(last.sparkHistory, "snapshot carries sparkHistory");
    assert.deepEqual(Object.keys(last.sparkHistory).sort(), ["cache", "tps", "ttft"],
      "session sparkHistory mirrors the aggregate metrics.sparkHistory shape");
    assert.deepEqual(last.sparkHistory.tps, [25], "only replies with a measurable generation window are plotted: 50 tokens / 2s. The non-streamed 25 tokens have no window, so there is no point — the curve and the card's number are always the same requests");
    assert.deepEqual(last.sparkHistory.ttft, [0.5], "streamed TTFT in seconds; non-streamed sample has no first-chunk point");
    assert.deepEqual(last.sparkHistory.cache, [40.0, 0.0], "per-request cache-hit-rate percentages (40/100 cached, then 0/80)");
    assert.deepEqual(
      last.samples,
      [
        { completion: 50, genDurationMs: 2000, prompt: 100, cached: 40 },
        { completion: 25, genDurationMs: null, prompt: 80, cached: 0 },
      ],
      "the snapshot ships raw measurements so the panel derives the session's speed and cache rate with the shared window rule",
    );
    assert.deepEqual(last.sparkHistory.cache, [40.0, 0.0], "per-request cache hit-rate percentages (40/100 cached, then 0/80)");

    // Collector side: reportSession persists the ring onto the session row.
    // PID 4242 from the snapshot rides a live claude.exe row in the scan.
    let mockTimeC = 10_000;
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","4242","Console","1","55,000 K"\r\n`);
    const collector = testCollector({ execFn: mockExec, nowFn: () => mockTimeC });
    collector.reportSession("tok-1", last);
    const claude = (await collector.getAgentsStatus()).find((a) => a.id === "claude");
    const sessionRow = claude.sessions[0];
    assert.ok(sessionRow, "per-session snapshot surfaces sparkHistory");
    assert.ok(sessionRow.sparkHistory, "session row carries the reporter's history");
    assert.deepEqual(sessionRow.sparkHistory.tps, [25]);
    assert.deepEqual(sessionRow.sparkHistory.ttft, [0.5]);
    // The row's speed comes from the window samples, not from dividing the
    // session's cumulative tokens by its cumulative busy time.
    assert.equal(sessionRow.tps, 25, "50 tokens over the 2s generation window");
    assert.equal(sessionRow.cacheHitRate, 22.2, "40 cached / 180 prompt over the window");
  });

  it("trims sparkHistory to a last-N request window, not a time TTL", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    let diskWindow = 2;
    const collector = testCollector({
      execFn: mockExec,
      nowFn,
      sparkWindowPoints: 2,
      loadSparkSettings: () => ({ sparkWindowPoints: diskWindow }),
    });

    for (let i = 0; i < 3; i++) {
      mockTime += 60_000;
      const r = collector.startRequest({ providerId: "furry", model: "glm-5.3" });
      mockTime += 500;
      r.recordFirstChunk();
      mockTime += 1000;
      r.recordEnd({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10 + i,
          prompt_tokens_details: { cached_tokens: 10 * i },
        },
      });
    }

    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.metrics.sparkHistory.ttft.length, 2);
    assert.equal(zcode.metrics.sparkHistory.tps.length, 2);
    assert.equal(zcode.metrics.sparkHistory.cache.length, 2);
    diskWindow = 2;
    collector.setSparkWindowPoints(16);
    const wider = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
    assert.equal(wider.metrics.sparkHistory.ttft.length, 2, "disk setting of 2 still wins over in-memory 16");
  });
  it("auto 请求在链节点宣布前不上报模型名（虚拟模型不得当模型名上屏）", async () => {
    // startRequest 不得把虚拟模型 id "auto" 当模型名上报：面板胶囊会显示
    // 「活跃: auto」，而真实节点身份要等心跳或请求结束才更正。
    const { reporter, posted, tick } = reporterHarness();
    const req = reporter.startRequest({ providerId: null, model: "auto", stream: true, path: "anthropic" });

    const start = posted[posted.length - 1];
    assert.equal(start.activeRequests, 1, "在飞状态照常上报（卡片要点亮「正在生成」）");
    assert.equal(start.model, null, "节点没定下来就没有可展示身份，绝不回落 auto");
    assert.equal(start.providerId, null);
    assert.equal(start.viaAuto, false);

    // 节点一宣布就上报渠道 + 模型 + 归因，不必等心跳。
    req.setAttributeResolver((memberId) => (memberId === "chan-a/m1" ? { providerId: "chan-a", model: "claude-opus-5" } : null));
    req.setCurrentMember("chan-a/m1");
    const announced = posted[posted.length - 1];
    assert.equal(announced.model, "claude-opus-5");
    assert.equal(announced.providerId, "chan-a");
    assert.equal(announced.viaAuto, true, "服务归因跟身份同源");
    assert.equal(announced.activeRequests, 1, "请求仍在飞");

    tick(4000);
    req.recordEnd({ status: 200, usage: { input_tokens: 10, output_tokens: 5 } });
    const ended = posted[posted.length - 1];
    assert.equal(ended.activeRequests, 0);
    assert.equal(ended.model, "claude-opus-5", "请求结束后沿用最近身份，供面板「最近」胶囊使用");
    assert.equal(ended.providerId, "chan-a");
  });

  it("并发请求各自归因：后发请求的结束清不掉先发请求的成员身份", async () => {
    const { reporter, lines, tick } = reporterHarness();
    const auto = reporter.startRequest({ providerId: null, model: "auto", stream: true, path: "anthropic" });
    auto.setAttributeResolver((memberId) => (memberId === "chan-a/m1" ? { providerId: "chan-a", model: "claude-opus-5" } : null));
    auto.setCurrentMember("chan-a/m1");

    // Claude Code 的侧查询：直连请求，与上面的 auto 请求并发在飞。
    const side = reporter.startRequest({ providerId: "chan-b", model: "qwen-max", stream: true, path: "anthropic" });
    tick(2000);
    side.recordEnd({ status: 200, usage: { input_tokens: 4, output_tokens: 2 } });

    tick(4000);
    auto.recordEnd({ status: 200, usage: { input_tokens: 10, output_tokens: 5 } });

    assert.equal(lines.length, 2);
    assert.equal(lines.find((r) => r.model === "qwen-max").providerId, "chan-b", "直连行保持自己的渠道");
    const autoRow = lines.find((r) => r.model === "claude-opus-5");
    assert.ok(autoRow, "auto 行归因到链上服务节点，没有被并发请求清成 auto");
    assert.equal(autoRow.providerId, "chan-a");
  });

  it("身份未变不重发快照（一次故障切换至多一次回环上报）", async () => {
    const { reporter, posted } = reporterHarness();
    const req = reporter.startRequest({ providerId: null, model: "auto", stream: true, path: "anthropic" });
    req.setAttributeResolver((memberId) => (memberId === "chan-a/m1" ? { providerId: "chan-a", model: "claude-opus-5" } : null));
    const before = posted.length;
    req.setCurrentMember("chan-a/m1");
    assert.equal(posted.length, before + 1, "身份首次出现 → 上报");
    req.setCurrentMember("chan-a/m1");
    assert.equal(posted.length, before + 1, "身份未变 → 不重发");
  });
});



describe("per-launch stability batch + chain runtime relay（一次性 relay 盲区修复）", () => {
  // Like reporterHarness but the POST outcome is switchable mid-test, so the
  // batch resend path (failed POST keeps entries) can be exercised.
  function batchHarness() {
    let mockTime = 1000;
    const posted = [];
    const state = { fail: false };
    const reporter = createSessionReporter({
      reportUrl: "http://report.invalid/panel/api/session/report",
      nowFn: () => mockTime,
      fetchFn: (url, init) => {
        posted.push(JSON.parse(init.body));
        return state.fail ? Promise.reject(new Error("connection refused")) : Promise.resolve({ ok: true });
      },
    });
    return { reporter, posted, state, tick: (t) => { mockTime = t; } };
  }
  // post() acknowledges the batch in the microtask after fetchFn resolves.
  const flush = () => new Promise((r) => setImmediate(r));

  it("recordEnd 终态入 stabilityBatch：归因与 TTFT 规则和 journal 行一致", async () => {
    const { reporter, posted, tick } = batchHarness();
    reporter.setClaudePid(100);
    const req = reporter.startRequest({ providerId: "chan-a", model: "claude-opus-5", stream: true, path: "anthropic" });
    tick(1500);
    req.recordFirstChunk();
    tick(4000);
    req.recordEnd({ status: 200, usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 5 } });

    const batch = posted[posted.length - 1].stabilityBatch;
    assert.equal(batch.length, 1);
    assert.deepEqual(batch[0], {
      seq: 1,
      providerId: "chan-a",
      model: "claude-opus-5",
      ok: true,
      latencyMs: 3000,
      prompt: 12,
      cached: 5,
      ttftMs: 500,
      at: 4000,
    });

    // 失败终态：ok:false 且不携带 TTFT（失败请求没有首字，等待时长不得把
    // 死节点刷绿）。
    const req2 = reporter.startRequest({ providerId: "chan-a", model: "claude-opus-5", stream: true, path: "anthropic" });
    tick(6000);
    req2.recordEnd({ status: 502, error: { status: 502, message: "bad gateway" } });
    const batch2 = posted[posted.length - 1].stabilityBatch;
    const failed = batch2.find((r) => r.ok === false);
    assert.ok(failed, "failed terminal end recorded");
    assert.equal(failed.ttftMs, null);
    assert.equal(failed.latencyMs, 2000);

    // abort 不进稳定性（与 journal/常驻收集器同规则）。
    const before3 = posted[posted.length - 1].stabilityBatch.length;
    const req3 = reporter.startRequest({ providerId: "chan-a", model: "claude-opus-5", stream: true, path: "anthropic" });
    tick(7000);
    req3.recordEnd({ aborted: true });
    const after3 = posted[posted.length - 1].stabilityBatch;
    assert.equal(after3.filter((r) => r.at === 7000).length, 0, "abort contributes no stability record");

    // 链请求：归因归到服务节点（链解析器），不落在虚拟 auto 上。
    const req4 = reporter.startRequest({ providerId: null, model: "auto", stream: true, path: "anthropic" });
    req4.setAttributeResolver((memberId) => (memberId === "chan-b/m1" ? { providerId: "chan-b", model: "glm-5.2" } : null));
    req4.setCurrentMember("chan-b/m1");
    tick(9000);
    req4.recordEnd({ status: 200, usage: { input_tokens: 3, output_tokens: 2 } });
    const auto = posted[posted.length - 1].stabilityBatch.find((r) => r.at === 9000);
    assert.equal(auto.providerId, "chan-b");
    assert.equal(auto.model, "glm-5.2");
  });

  it("recordRetry 记尝试级失败：静默恢复不得把成功率染成 100%", async () => {
    const { reporter, posted, tick } = batchHarness();
    const req = reporter.startRequest({ providerId: "pool-x", model: "glm-5.2", stream: true, path: "anthropic" });
    req.setAttributeResolver((memberId) => (memberId === "pool-x/member-a" ? { providerId: "pool-x", model: "glm-5.2" } : null));
    req.recordRetry({ reason: "upstream_429", usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 40 } }, memberId: "pool-x/member-a" });
    tick(3000);
    req.recordEnd({ status: 200, usage: { input_tokens: 100, output_tokens: 50 } });

    const batch = posted[posted.length - 1].stabilityBatch;
    assert.equal(batch.length, 2, "retry attempt + terminal end");
    assert.deepEqual(batch[0], {
      seq: 1,
      providerId: "pool-x",
      model: "glm-5.2",
      ok: false,
      latencyMs: 0,
      prompt: 100,
      cached: 40,
      ttftMs: null,
      at: 1000,
    });
    assert.equal(batch[1].seq, 2);
    assert.equal(batch[1].ok, true);
  });

  it("上报成功才清缓冲；失败的 POST 保留下轮重发，序号单调", async () => {
    const { reporter, posted, state, tick } = batchHarness();
    state.fail = true;
    reporter.startRequest({ providerId: "chan-a", model: "m", stream: false, path: "anthropic" });
    tick(2000);
    reporter.recordEnd({ status: 200, usage: { input_tokens: 1, output_tokens: 1 } });
    await flush();
    tick(3000);
    reporter.startRequest({ providerId: "chan-a", model: "m", stream: false, path: "anthropic" });
    assert.deepEqual(posted[posted.length - 1].stabilityBatch.map((r) => r.seq), [1], "failed POST keeps entries; next snapshot re-carries them");

    state.fail = false;
    tick(4000);
    reporter.recordEnd({ status: 200, usage: { input_tokens: 1, output_tokens: 1 } });
    assert.deepEqual(posted[posted.length - 1].stabilityBatch.map((r) => r.seq), [1, 2], "seq keeps climbing across resends");
    await flush();
    reporter.startRequest({ providerId: "chan-a", model: "m", stream: false, path: "anthropic" });
    assert.equal(posted[posted.length - 1].stabilityBatch.length, 0, "acked entries cleared after a successful POST");
  });

  it("setChainState 后快照捎带 chainRuntime；未接线时不带", async () => {
    const { reporter, posted } = batchHarness();
    reporter.setChainState({
      snapshot: () => [{ endpointId: "claude", nodeId: "chan-b", model: "model-b", since: 1234 }],
      nodeStats: () => [{ node: "chan-a", model: "model-a", failures: 2 }],
    });
    reporter.startRequest({ providerId: "chan-b", model: "model-b", stream: false, path: "anthropic" });
    assert.deepEqual(posted[posted.length - 1].chainRuntime, {
      positions: [{ endpointId: "claude", nodeId: "chan-b", model: "model-b", since: 1234 }],
      nodes: [{ node: "chan-a", model: "model-a", failures: 2 }],
    });

    const plain = batchHarness();
    plain.reporter.startRequest({ providerId: "chan-a", model: "m", stream: false, path: "anthropic" });
    assert.ok(!("chainRuntime" in plain.posted[plain.posted.length - 1]), "no chainState wired → field absent");
  });

  it("reportSession 把 batch 喂进常驻追踪器，按 at 落桶、按 seq 去重", async () => {
    let mockTime = 1_000_000;
    const collector = testCollector({ nowFn: () => mockTime });
    const report = {
      pid: 4444,
      agentId: "claude",
      stabilityBatch: [
        { seq: 1, providerId: "sensenova", model: "kimi-k3", ok: true, latencyMs: 3000, prompt: 10, cached: 4, ttftMs: 800, at: 999000 },
        { seq: 2, providerId: "sensenova", model: "kimi-k3", ok: false, latencyMs: 0, prompt: 5, cached: 0, ttftMs: null, at: 1000000 },
      ],
    };
    collector.reportSession("tok_a", report);
    let row = collector.getModelStability().models.find((m) => m.provider === "sensenova" && m.model === "kimi-k3");
    assert.equal(row.total, 2);
    assert.equal(row.successRate, 50);
    assert.equal(row.ttftMs, 800, "only the record with a real first token feeds the TTFT mean");

    collector.reportSession("tok_a", report);
    row = collector.getModelStability().models.find((m) => m.provider === "sensenova" && m.model === "kimi-k3");
    assert.equal(row.total, 2, "重放的同批必须按 seq 去重，不双计");

    // PID 复用（同 pid 不同 token）= 新 reporter 进程，seq 从 1 重启——
    // 去重游标必须随会话重置，否则新会话的整批记录会被静默丢弃。
    collector.reportSession("tok_b", {
      pid: 4444,
      agentId: "claude",
      stabilityBatch: [{ seq: 1, providerId: "sensenova", model: "kimi-k3", ok: true, latencyMs: 1000, at: 1001000 }],
    });
    row = collector.getModelStability().models.find((m) => m.provider === "sensenova" && m.model === "kimi-k3");
    assert.equal(row.total, 3, "recycled PID starts a fresh seq line and must record");
  });

  it("reportSession 存 chainRuntime 全量快照，getReportedChainRuntime 供链运行时合并", async () => {
    const collector = testCollector({ nowFn: () => 1000 });
    collector.reportSession("tok_a", {
      pid: 4444,
      agentId: "claude",
      chainRuntime: {
        positions: [{ endpointId: "claude", nodeId: "chan-b", model: "model-b", since: 900 }],
        nodes: [{ node: "chan-a", model: "model-a", failures: 2 }],
      },
    });
    let dumps = collector.getReportedChainRuntime();
    assert.equal(dumps.length, 1);
    assert.deepEqual(dumps[0].positions, [{ endpointId: "claude", nodeId: "chan-b", model: "model-b", since: 900 }]);
    assert.deepEqual(dumps[0].nodes, [{ node: "chan-a", model: "model-a", failures: 2 }]);

    // 同一会话的新快照整体覆盖（上报方 dump 是全量不是增量）。
    collector.reportSession("tok_a", {
      pid: 4444,
      agentId: "claude",
      chainRuntime: { positions: [], nodes: [{ node: "chan-b", model: "model-b", failures: 0 }] },
    });
    dumps = collector.getReportedChainRuntime();
    assert.equal(dumps.length, 1);
    assert.deepEqual(dumps[0].positions, []);
    assert.deepEqual(dumps[0].nodes, [{ node: "chan-b", model: "model-b", failures: 0 }]);
  });
});



describe("instance PID reconciliation and process-start placeholders", () => {
  // wmic-shaped CSV reporting one live kimi node.exe process with the given PID.
  const kimiWmicRow = (pid) =>
    `Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\Tools\\node.exe C:\\x\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs,node.exe,${pid}\r\n`;

  it("evicts a dead-pid instance immediately and settles its leaked in-flight counters", async () => {
    // Start past the 2500ms process-scan cache window so the first status read
    // actually scans (a fresh collector's cache starts empty at time 0).
    let t = 3000;
    let alive = true;
    const execFn = (cmd, opts, cb) => cb(null, alive ? kimiWmicRow(21564) : "");
    const collector = testCollector({ execFn, nowFn: () => t });

    // An instance with an in-flight request never idle-TTL-expires, so under
    // the old endpoint-level-only settling this row lingered as 待命/生成中
    // until lastSeen+10min after its process died.
    collector.startRequest({ agentId: "kimi", instanceId: "kimi-21564", model: "m1" });
    let kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.equal(kimi.instances.length, 1);
    assert.equal(kimi.instances[0].status, "active");

    // The process dies; the next read (past the scan cache window) must drop
    // the row now, not at lastSeen+10min, and settle the share its orphan
    // request leaked into the endpoint aggregate (tagged requests count in
    // both buckets).
    alive = false;
    t += 3000;
    // Reads never block on a rescan: first call serves stale + kicks the round.
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 20));
    kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.deepEqual(kimi.instances, [], "dead-pid instance is evicted on read, not by idle TTL");
    assert.equal(kimi.metrics.activeRequests, 0, "leaked in-flight count settled in the endpoint aggregate");
  });

  it("lists a zero-count placeholder row for a scanned live pid before its first request", async () => {
    let t = 3000;
    const execFn = (cmd, opts, cb) => cb(null, kimiWmicRow(21564));
    const collector = testCollector({ execFn, nowFn: () => t });

    const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.deepEqual(kimi.instances.map((i) => i.id), ["kimi-21564"], "process start is enough for the row");
    const ph = kimi.instances[0];
    assert.equal(ph.status, "idle");
    assert.equal(ph.requests, 0);
    assert.equal(ph.activeRequests, 0);
    assert.deepEqual(ph.tokens, { prompt: 0, completion: 0, cached: 0 });

    // A pid-form row lives by the process list, not the idle TTL: still
    // listed past 10 idle minutes while the process runs.
    t += 11 * 60 * 1000;
    const kimiLater = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.deepEqual(kimiLater.instances.map((i) => i.id), ["kimi-21564"]);
  });

  it("keeps custom ids on the idle TTL path, never pid-reconciled", async () => {
    let t = 3000;
    const execFn = (cmd, opts, cb) => cb(null, ""); // no kimi processes at all
    const collector = testCollector({ execFn, nowFn: () => t });

    // "ws-a": no numeric tail. "myproj-9999": launcher-injected <cwd基名>-<pid>
    // form — numeric tail but prefix ≠ agentId. Neither declares its PID.
    for (const id of ["ws-a", "myproj-9999"]) {
      const r = collector.startRequest({ agentId: "kimi", instanceId: id, model: "m1" });
      r.recordEnd({ status: 200, usage: {} });
    }

    let kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    // Same firstSeen for both → deterministic id tiebreak in instanceSnapshots.
    assert.deepEqual(kimi.instances.map((i) => i.id), ["myproj-9999", "ws-a"],
      "custom ids are not evicted by PID reconciliation even with zero kimi processes");

    t += 10 * 60 * 1000 + 1; // past the idle TTL (also past the scan cache)
    kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.deepEqual(kimi.instances, [], "the idle TTL still governs custom ids");
  });

  it("a real request takes over its placeholder entry instead of doubling the row", async () => {
    let t = 3000;
    const execFn = (cmd, opts, cb) => cb(null, kimiWmicRow(21564));
    const collector = testCollector({ execFn, nowFn: () => t });

    let kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.equal(kimi.instances.length, 1, "placeholder listed before any request");
    assert.equal(kimi.instances[0].requests, 0);

    const r = collector.startRequest({ agentId: "kimi", instanceId: "kimi-21564", providerId: "p1", model: "m1", stream: true, path: "openai" });
    t += 500;
    r.recordFirstChunk();
    t += 500;
    r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });

    t += 3000; // past the scan cache so the read rescans (pid still alive)
    kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.equal(kimi.instances.length, 1, "same id converges to a single row");
    assert.equal(kimi.instances[0].requests, 1);
    assert.equal(kimi.instances[0].tokens.prompt, 10);
    assert.equal(kimi.instances[0].tokens.completion, 5);
  });
});

describe("probe row claiming by image name (probe self-match regression)", () => {
  // Live capture of the exact failure that motivated this describe: the probe
  // runs through child_process.exec, Windows wraps it in
  // `cmd.exe /d /s /c "wmic process where "name='Qoder.exe' ..."` and that
  // wrapper process — its COMMAND LINE carrying every agent name literal from
  // the WHERE clause — lands in the probe's own result. Whole-line matching
  // claimed it as a qoder client (first branch, no command-line check), so
  // a machine that never ran Qoder showed a phantom 启动/待命 qoder card
  // forever. Claiming must key off the image NAME field only.
  const wmicWrapper = (extraRows = []) =>
    "Node,CommandLine,Name,ParentProcessId,ProcessId\r\n" +
    [
      "LAPTOP,C:\\WINDOWS\\system32\\cmd.exe /d /s /c \"wmic process where \"name='ZCode.exe' or name='claude.exe' or name='opencode.exe' or name='dsh.exe' or name='pi.exe' or name='Qoder.exe' or name='codex.exe' or name='codex-code-mode-host.exe' or name='codex-command-runner.exe' or name='ChatGPT.exe' or name='node.exe' or name='cmd.exe'\" get ProcessId,ParentProcessId,CommandLine,Name /format:csv\",cmd.exe,5184,7300",
      ...extraRows,
    ].join("\r\n") + "\r\n";
  const allZero = (p) => ({
    zcode: p.zcode, claude: p.claude, dsh: p.dsh,
    kimi: p.kimi, pi: p.pi, opencode: p.opencode, qoder: p.qoder, codex: p.codex,
  });

  it("wmic wrapper row carrying every agent name literal counts as nothing", async () => {
    const execFn = (cmd, opts, cb) => cb(null, wmicWrapper());
    const collector = testCollector({ execFn, nowFn: () => 10000 });
    const p = await collector.scanProcesses();
    assert.deepEqual(allZero(p), { zcode: 0, claude: 0, dsh: 0, kimi: 0, pi: 0, opencode: 0, qoder: 0, codex: 0 },
      "the probe's own cmd.exe wrapper must not impersonate any client");
    assert.equal(p.qoderPids.has(7300), false);
    // The wrapper stays in the lineage table — it is a legitimate hop for
    // launcher → cmd /c → client ancestor resolution.
    assert.equal(p.ppidByPid.get(7300), 5184, "wrapper still feeds the lineage table");
  });

  it("real clients in the same scan still count beside the wrapper", async () => {
    const execFn = (cmd, opts, cb) =>
      cb(null, wmicWrapper([
        "LAPTOP,C:\\Users\\tester\\AppData\\Local\\Programs\\Qoder\\Qoder.exe,Qoder.exe,4000,4242",
        "LAPTOP,\"C:\\Program Files\\nodejs\\node.exe\" C:\\app\\relay-host.mjs,node.exe,5184,7320",
        "LAPTOP,\"C:\\Programs\\ZCode\\ZCode.exe\",ZCode.exe,15332,6592",
      ]));
    const collector = testCollector({ execFn, nowFn: () => 10000 });
    const p = await collector.scanProcesses();
    assert.equal(p.qoder, 1);
    assert.deepEqual([...p.qoderPids], [4242]);
    assert.equal(p.zcode, 1);
    assert.equal(p.kimi, 0, "a bare relay node.exe is no client");
  });

  it("powershell fallback wrapper row (with ppid) also counts as nothing", async () => {
    const ps =
      "7300,5184,cmd.exe,C:\\WINDOWS\\system32\\cmd.exe /d /s /c \"powershell -NoProfile -NonInteractive -Command \"Get-CimInstance Win32_Process -Filter \\\"name='Qoder.exe' or name='node.exe'\\\"\"\r\n" +
      "4242,4000,Qoder.exe,C:\\Users\\u\\AppData\\Local\\Programs\\Qoder\\Qoder.exe\r\n";
    const execFn = (cmd, opts, cb) => {
      if (cmd.includes("wmic")) return cb(null, "");
      if (cmd.includes("powershell")) return cb(null, ps);
      return cb(null, "");
    };
    const collector = testCollector({ execFn, nowFn: () => 10000 });
    const p = await collector.scanProcesses();
    assert.equal(p.qoder, 1, "exactly the real Qoder.exe counts — wrapper contributes nothing");
    assert.deepEqual([...p.qoderPids], [4242], "wrapper pid 7300 absent from qoderPids");
    assert.equal(p.claude, 0);
    assert.equal(p.zcode, 0);
    assert.equal(p.ppidByPid.get(7300), 5184, "wrapper still feeds the lineage table");
  });

  it("tasklist fallback keeps accept-by-name and never counts cmd.exe", async () => {
    const execFn = (cmd, opts, cb) => {
      if (cmd.includes("tasklist")) {
        return cb(null, '"claude.exe","4321","Console","1","50,000 K"\r\n"cmd.exe","7300","Console","1","5,000 K"\r\n');
      }
      return cb(null, "");
    };
    const collector = testCollector({ execFn, nowFn: () => 10000 });
    const p = await collector.scanProcesses();
    assert.ok(p.claudePids.has(4321), "accept-by-name preserved for quoted tasklist rows");
    assert.equal(p.qoder, 0);
    assert.equal(p.zcode, 0);
  });
});

describe("claude process-scan helper filtering and ended-latch revival", () => {
  const wmic = (rows) => `Node,CommandLine,Name,ProcessId\r\n${rows.join("\r\n")}\r\n`;
  const claude = (status) => status.find((a) => a.id === "claude");

  it("ignores claude.exe children running as embedded tools (rg) — the startup double-count", async () => {
    // Live capture: interactive claude.exe (pid 24956) spawns a short-lived
    // child that keeps the claude.exe image name but runs `rg --version`.
    // That helper must not become a placeholder session row.
    const csv = wmic([
      "LAPTOP,C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe,claude.exe,24956",
      "LAPTOP,rg --version,claude.exe,19844",
    ]);
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => 10000 });

    const card = claude(await collector.getAgentsStatus());
    assert.equal(card.processCount, 1, "rg helper is not a claude session process");
    assert.equal(card.sessionsCount, 1, "no phantom second session row");
    assert.equal(card.sessions[0].id, "pid-24956");
  });

  it("still accepts claude.exe rows in the plain tasklist fallback (no command line column)", async () => {
    const csv = `"claude.exe","24956","Console","1","55,000 K"\r\n"claude.exe","19844","Console","1","9,000 K"\r\n`;
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => 10000 });

    const card = claude(await collector.getAgentsStatus());
    assert.equal(card.processCount, 2, "tasklist rows carry no command line — accept-by-name preserved");
  });

  it("does not count the auto-update npm probe as a claude session", async () => {
    // Live capture: ~10s after start, claude.exe spawns
    // `node npm-cli.js view @anthropic-ai/claude-code@latest version`.
    const ps =
      "24956,claude.exe,C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\r\n" +
      "24764,node.exe,\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js\" \"view\" \"@anthropic-ai/claude-code@latest\" \"version\" \"--prefer-online\"\r\n";
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, ps), nowFn: () => 10000 });

    const card = claude(await collector.getAgentsStatus());
    assert.equal(card.processCount, 1, "npm view maintenance process is not a session");
    assert.equal(card.sessionsCount, 1, "no third session row from the updater");
    assert.equal(card.sessions[0].id, "pid-24956");
  });

  it("does not register npm maintenance processes as kimi/pi instances, but keeps real ones", async () => {
    const csv = wmic([
      "LAPTOP,\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\npm\\npm-cli.js\" \"view\" \"@moonshot-ai/kimi-code@latest\",node.exe,30001",
      "LAPTOP,\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\npm\\npm-cli.js\" \"view\" \"@earendil-works/pi-coding-agent\",node.exe,30002",
      "LAPTOP,\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs\",node.exe,30003",
    ]);
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => 10000 });

    const status = await collector.getAgentsStatus();
    const kimi = status.find((a) => a.id === "kimi");
    const pi = status.find((a) => a.id === "pi");
    assert.equal(kimi.processCount, 1, "only the real kimi node process counts");
    assert.deepEqual(kimi.instances.map((i) => i.id), ["kimi-30003"], "no garbage placeholder rows from npm view");
    assert.equal(pi.processCount, 0);
    assert.deepEqual(pi.instances, []);
  });

  it("revives a session whose PID reappears in the scan after a transient miss", async () => {
    // A stale/empty scan read latches the session ended; while the latch held,
    // the placeholder loop's has() check blocked recreation, so the panel kept
    // showing fewer rows than running processes (observed: proc=3, rows=2).
    let t = 10000;
    let alive = true;
    const execFn = (cmd, opts, cb) =>
      cb(null, alive
        ? wmic(["LAPTOP,C:\\Programs\\claude.exe\\claude.exe,claude.exe,5555"])
        : wmic([]));
    const collector = testCollector({ execFn, nowFn: () => t });

    let card = claude(await collector.getAgentsStatus());
    assert.equal(card.sessionsCount, 1);

    alive = false;
    t += 3000; // past the 2.5s scan cache so the read rescans
    // Reads never block on a rescan: first call serves stale + kicks the round.
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 20));
    card = claude(await collector.getAgentsStatus());
    assert.equal(card.sessionsCount, 0, "process gone — session latched ended");

    alive = true; // same PID back (recycled, or the miss was transient)
    t += 3000;
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 20));
    card = claude(await collector.getAgentsStatus());
    assert.equal(card.sessionsCount, 1, "live PID revives the row instead of staying hidden behind the ended latch");
    assert.equal(card.sessions[0].id, "pid-5555");
  });
});

describe("process lineage (ParentProcessId)", () => {
  it("records parent pids for every WMIC row, including non-agent intermediates", async () => {
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, WMIC_LINEAGE_CHAIN_SCAN), nowFn: () => 10000 });
    const procs = await collector.scanProcesses();
    assert.equal(procs.kimi, 1, "the launcher node.exe and the cmd shim must not count as kimi clients");
    assert.deepEqual([...procs.kimiPids], [4321]);
    assert.ok(procs.ppidByPid instanceof Map);
    assert.equal(procs.ppidByPid.get(4321), 1001);
    assert.equal(procs.ppidByPid.get(1001), 1000, "the cmd shim hop stays in the table so chains can cross it");
    assert.equal(procs.ppidByPid.get(1000), 500);
  });

  it("records parent pids from the PowerShell fallback (<pid>,<ppid>,<name>,<cmdline>)", async () => {
    const execFn = (cmd, opts, cb) => {
      if (cmd.includes("wmic")) return cb(null, ""); // wmic unavailable/deprecated
      if (cmd.includes("powershell")) {
        return cb(null,
          "1000,500,node.exe,C:\\Tools\\node.exe C:\\app\\kimi-launcher.mjs\r\n" +
          "4321,1000,node.exe,C:\\Tools\\node.exe C:\\x\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs\r\n");
      }
      return cb(null, "");
    };
    const collector = testCollector({ execFn, nowFn: () => 10000 });
    const procs = await collector.scanProcesses();
    assert.ok(procs.kimiPids.has(4321));
    assert.equal(procs.ppidByPid.get(4321), 1000);
    assert.equal(procs.ppidByPid.get(1000), 500);
  });

  it("tasklist fallback rows carry no parent column — lineage lookups degrade to null", async () => {
    const execFn = (cmd, opts, cb) => {
      if (cmd.includes("tasklist")) return cb(null, '"claude.exe","4321","Console","1","50,000 K"\r\n');
      return cb(null, "");
    };
    const collector = testCollector({ execFn, nowFn: () => 10000 });
    const procs = await collector.scanProcesses();
    assert.ok(procs.claudePids.has(4321));
    assert.equal(procs.ppidByPid.size, 0);
    assert.equal(findDescendantClientPid(1000, procs.claudePids, procs.ppidByPid), null);
  });
});

describe("findDescendantClientPid", () => {
  it("resolves across generations (launcher → cmd shim → client)", () => {
    const map = new Map([[4321, 1001], [1001, 1000], [1000, 500]]);
    assert.equal(findDescendantClientPid(1000, new Set([4321]), map), 4321);
  });

  it("returns null when the pid is not an ancestor of any client", () => {
    const map = new Map([[4321, 1001], [1001, 1000]]);
    assert.equal(findDescendantClientPid(9999, new Set([4321]), map), null);
  });

  it("returns null without a lineage table (tasklist degradation)", () => {
    assert.equal(findDescendantClientPid(1000, new Set([4321]), new Map()), null);
    assert.equal(findDescendantClientPid(1000, new Set([4321]), null), null);
  });

  it("terminates on parent-pointer cycles", () => {
    const map = new Map([[10, 11], [11, 10]]);
    assert.equal(findDescendantClientPid(99, new Set([10]), map), null);
  });

  it("caps the ancestor walk depth", () => {
    const map = new Map();
    for (let p = 1; p <= 40; p++) map.set(p + 1, p); // 41 → 40 → … → 1
    assert.equal(findDescendantClientPid(1, new Set([41]), map), null, "a target deeper than the walk cap must not resolve");
  });
});

describe("normalizeInstanceId", () => {
  // launcher node (1000) → cmd shim (1001) → kimi client (4321)
  const snapshot = {
    kimiPids: new Set([4321]),
    ppidByPid: new Map([[4321, 1001], [1001, 1000], [1000, 500]]),
  };

  it("folds a launcher-pid id into the client pid and returns the cwd basename as label", () => {
    assert.deepEqual(normalizeInstanceId("kimi", "myproj-1000", snapshot), { id: "kimi-4321", label: "myproj" });
  });

  it("normalizes a direct client-pid tail without lineage", () => {
    assert.deepEqual(normalizeInstanceId("kimi", "myproj-4321", snapshot), { id: "kimi-4321", label: "myproj" });
  });

  it("sets no label when the prefix is the endpoint id itself", () => {
    assert.deepEqual(normalizeInstanceId("kimi", "kimi-1000", snapshot), { id: "kimi-4321", label: null });
    assert.deepEqual(normalizeInstanceId("kimi", "kimi-4321", snapshot), { id: "kimi-4321", label: null });
  });

  it("keeps unresolvable ids unchanged (custom id, TTL path)", () => {
    assert.deepEqual(normalizeInstanceId("kimi", "myproj-9999", snapshot), { id: "myproj-9999", label: null });
    assert.deepEqual(normalizeInstanceId("kimi", "ws-a", snapshot), { id: "ws-a", label: null });
  });

  it("keeps ids unchanged without a usable snapshot", () => {
    assert.deepEqual(normalizeInstanceId("kimi", "myproj-4321", null), { id: "myproj-4321", label: null });
  });

  it("returns null for invalid ids", () => {
    assert.equal(normalizeInstanceId("kimi", "bad id!", snapshot), null);
    assert.equal(normalizeInstanceId("kimi", null, snapshot), null);
  });

  it("folds codex ids against the engine pid set, not the whole bucket", () => {
    // Desktop session shape: ChatGPT.exe GUI (6200) is the PARENT of the
    // codex.exe app-server engine (6100). The engine pid direct-hits; a
    // GUI-pid tag folds to the engine through the lineage table — both land
    // on the same row the engine-scoped housekeeping keeps alive.
    const codexSnapshot = {
      codexPids: new Set([6200, 6100]),
      codexEnginePids: new Set([6100]),
      ppidByPid: new Map([[6100, 6200]]),
    };
    assert.deepEqual(normalizeInstanceId("codex", "codex-6100", codexSnapshot), { id: "codex-6100", label: null });
    assert.deepEqual(normalizeInstanceId("codex", "codex-6200", codexSnapshot), { id: "codex-6100", label: null });
    assert.deepEqual(normalizeInstanceId("codex", "codex-9999", codexSnapshot), { id: "codex-9999", label: null },
      "a pid outside the engine set with no lineage link stays a custom id");
  });
});

describe("instance id normalization (collector)", () => {
  const chainExec = (cmd, opts, cb) => cb(null, WMIC_LINEAGE_CHAIN_SCAN);

  it("folds a launcher-injected <cwd基名>-<launcher pid> id into the client-pid row with the basename as label", async () => {
    let t = 3000;
    const collector = testCollector({ execFn: chainExec, nowFn: () => t });
    await collector.scanProcesses(); // warm the cache — the panel-open steady state
    const r = collector.startRequest({ agentId: "kimi", instanceId: "myproj-1000", model: "m1" });
    r.recordEnd({ status: 200, usage: { prompt_tokens: 4, completion_tokens: 2 } });

    t += 3000; // past the scan cache so the read rescans (client pid still alive)
    const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.deepEqual(kimi.instances.map((i) => i.id), ["kimi-4321"], "one canonical row, no raw launcher-pid duplicate");
    assert.equal(kimi.instances[0].title, "myproj", "the cwd basename survives as the display label");
    assert.equal(kimi.instances[0].requests, 1);
    assert.equal(kimi.instances[0].tokens.prompt, 4);
  });

  it("normalizes an id whose tail pid IS the client pid", async () => {
    let t = 3000;
    const collector = testCollector({ execFn: chainExec, nowFn: () => t });
    await collector.scanProcesses();
    const r = collector.startRequest({ agentId: "kimi", instanceId: "proj-4321", model: "m1" });
    r.recordEnd({ status: 200, usage: {} });

    t += 3000;
    const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.deepEqual(kimi.instances.map((i) => i.id), ["kimi-4321"]);
    assert.equal(kimi.instances[0].title, "proj");
    assert.equal(kimi.instances[0].requests, 1);
  });

  it("keeps an unresolvable custom id on the idle-TTL path", async () => {
    let t = 3000;
    const collector = testCollector({ execFn: chainExec, nowFn: () => t });
    await collector.scanProcesses();
    const r = collector.startRequest({ agentId: "kimi", instanceId: "myproj-9999", model: "m1" });
    r.recordEnd({ status: 200, usage: {} });

    t += 3000;
    let kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.deepEqual(kimi.instances.map((i) => i.id), ["myproj-9999", "kimi-4321"],
      "custom id kept as-is (firstSeen order: request bucket before the scanned placeholder)");

    t += 10 * 60 * 1000 + 1; // past the idle TTL
    kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.deepEqual(kimi.instances.map((i) => i.id), ["kimi-4321"], "the idle TTL still governs custom ids");
  });

  it("a cwd literally named after the endpoint (kimi-<launcher pid>) folds into the client row instead of being evicted", async () => {
    let t = 3000;
    const collector = testCollector({ execFn: chainExec, nowFn: () => t });
    await collector.scanProcesses();
    const r = collector.startRequest({ agentId: "kimi", instanceId: "kimi-1000", model: "m1" });
    r.recordEnd({ status: 200, usage: {} });

    t += 3000;
    let kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    // Without lineage normalization this id matches ^kimi-(\d+)$ with a pid
    // outside kimiPids and would be evicted as a dead-pid row on this read.
    assert.deepEqual(kimi.instances.map((i) => i.id), ["kimi-4321"], "normalized to the client pid, not evicted");
    assert.equal(kimi.instances[0].title, "kimi-4321", "prefix equals the endpoint id → no label, title stays the id");
    assert.equal(kimi.instances[0].requests, 1);

    t += 11 * 60 * 1000; // pid-form rows live by the process list, not the TTL
    kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.deepEqual(kimi.instances.map((i) => i.id), ["kimi-4321"]);
  });
});

// Process-scan staleness contract (see scanProcesses in agent-metrics.mjs).
// A blocking read can push a panel /api/agents poll past the 1500ms
// cross-process pull budget — the process probe alone costs over a second on
// machines without WMI — after which the panel substitutes its own
// zero-traffic collector: a "no data" frame on a healthy relay.
describe("process scan staleness (stale-while-revalidate)", () => {
  const wmicScan = "Node,CommandLine,Name,ProcessId\r\n"
    + "LAPTOP,C:\\Programs\\Qoder\\Qoder.exe,Qoder.exe,4321\r\n";

  // An execFn that answers immediately until arm() is called; from then on the
  // probe chain only completes when the test says so — so "this read waited for
  // the in-flight scan" is assertable instead of showing up as a hung test.
  // payload() is read per answer, so a test can change what the next round lands.
  function gatedExec(payloadFn = () => wmicScan) {
    let armed = false;
    let release;
    const gate = new Promise((r) => { release = r; });
    return {
      arm: () => { armed = true; },
      release: () => release(),
      execFn: (cmd, opts, cb) => {
        if (!armed) {
          cb(null, payloadFn());
          return;
        }
        gate.then(() => cb(null, payloadFn()));
      },
    };
  }

  // Resolves to the sentinel instead of hanging if `promise` is still pending
  // after ms — the assertion is "this read must/must-not wait for the scan".
  function raceWithPending(promise, ms) {
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve("__pending__"), ms)),
    ]);
  }

  it("first read waits for a snapshot instead of serving the never-filled empty scan", async () => {
    const probe = { started: 0 };
    const execFn = (cmd, opts, cb) => { probe.started += 1; cb(null, wmicScan); };
    const collector = testCollector({ execFn, nowFn: () => 3000 });
    const procs = await collector.scanProcesses();
    assert.equal(procs.qoder, 1, "首轮必须等一轮扫描落地");
    assert.equal(probe.started, 1);
  });

  it("a read past the cache window returns the previous snapshot without waiting", async () => {
    let t = 3000;
    const probe = gatedExec();
    const collector = testCollector({ execFn: probe.execFn, nowFn: () => t });
    await collector.scanProcesses(); // round 1 lands at t=3000

    probe.arm();
    t = 6000; // past the 2500ms window; round 2 is in flight and unfinished
    const procs = await raceWithPending(collector.scanProcesses(), 200);
    assert.notEqual(procs, "__pending__", "读取被在飞扫描阻塞了");
    assert.equal(procs.qoder, 1, "端出的就是上一份快照");
    probe.release();
  });

  it("a snapshot of ANY age is served without waiting while a background round revalidates", async () => {
    // First frame after a long idle gap (hidden tab pauses polling) must not
    // wait a probe round — that stall was the user-visible "switch back to the
    // panel and the board sits frozen" regression.
    let t = 3000;
    const freshScan = "Node,CommandLine,Name,ProcessId\r\n"
      + "LAPTOP,C:\\Programs\\ZCode.exe,ZCode.exe,7777\r\n";
    let nextPayload = wmicScan;
    const probe = gatedExec(() => nextPayload);
    const collector = testCollector({ execFn: probe.execFn, nowFn: () => t });
    await collector.scanProcesses(); // round 1 lands qoder at t=3000

    probe.arm();
    nextPayload = freshScan;
    t = 20000; // minutes after the tab was hidden — far past any staleness ceiling
    const procs = await raceWithPending(collector.scanProcesses(), 200);
    assert.notEqual(procs, "__pending__", "超龄快照也必须立即端出，不得等扫描");
    assert.equal(procs.qoder, 1, "端出的就是上一份快照（内容陈旧但立即可得）");
    probe.release();

    // The background round the stale read kicked off must still land; the next
    // read then serves the fresh snapshot.
    await new Promise((r) => setTimeout(r, 30));
    t = 20100;
    const fresh = await collector.scanProcesses();
    assert.equal(fresh.zcode, 1, "后台重验轮落地后读到的就是新快照");
    assert.equal(fresh.qoder, 0);
  });
});

describe("persistent PowerShell probe transport", () => {
  const qoderScan = "Node,CommandLine,Name,ProcessId\r\n"
    + "LAPTOP,C:\\Programs\\Qoder\\Qoder.exe,Qoder.exe,4321\r\n";

  // A controllable fake child process: writes are answered per the handler.
  function fakeChild(onWrite) {
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    stdout.setEncoding = () => {};
    const stderr = new EventEmitter();
    stderr.resume = () => {};
    child.stdin = { write: (text) => onWrite(child, stdout, text) };
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => { child.emit("exit", 0); };
    child.unref = () => {};
    return child;
  }
  const markerOf = (text) => (text.match(/Write-Output '([^']+)'/) || [])[1] || "";

  it("spawns once and reuses the same child across scan rounds", async () => {
    let t = 1000;
    let spawns = 0;
    const spawnFn = () => {
      spawns += 1;
      return fakeChild((child, stdout, text) => stdout.emit("data", qoderScan + markerOf(text) + "\r\n"));
    };
    const collector = testCollector({ spawnFn, nowFn: () => t });
    await collector.scanProcesses();
    t = 10000; // past the TTL → second round
    await collector.scanProcesses();
    assert.equal(spawns, 1, "常驻探测进程必须跨轮复用，不得每轮冷启动");
  });

  it("a child that dies mid-query falls back to tasklist for that round and respawns next round", async () => {
    let t = 3000;
    let spawns = 0;
    const spawnFn = () => {
      spawns += 1;
      const n = spawns;
      return fakeChild((child, stdout, text) => {
        if (n === 1) {
          child.emit("error", new Error("child died"));
          return;
        }
        stdout.emit("data", qoderScan + markerOf(text) + "\r\n");
      });
    };
    const execFn = (cmd, opts, cb) => {
      if (cmd.includes("tasklist")) {
        return cb(null, '"ZCode.exe","20588","Console","1","50,000 K"\r\n');
      }
      return cb(new Error("unexpected exec"));
    };
    const collector = testCollector({ spawnFn, execFn, nowFn: () => t });
    const first = await collector.scanProcesses();
    assert.equal(first.zcode, 1, "探测进程死亡当轮必须落到 tasklist 兜底");
    t = 10000;
    await collector.scanProcesses(); // stale read kicks the respawn round
    await new Promise((r) => setTimeout(r, 20)); // let it land
    t = 11000; // inside the fresh TTL window: serves round-2 data, no extra spawn
    const second = await collector.scanProcesses();
    assert.equal(second.qoder, 1, "下一轮必须重起探测进程并走回快车道");
    assert.equal(spawns, 2, "死亡进程不得复用");
  });

  it("an unanswered query rejects within the probe timeout instead of hanging the scan", { timeout: 15000 }, async () => {
    // The real probe timeout is 3000ms; this test waits it out and asserts the
    // scan still settles through the tasklist fallback.
    const spawnFn = () => fakeChild(() => { /* never answers */ });
    const execFn = (cmd, opts, cb) => {
      if (cmd.includes("tasklist")) {
        return cb(null, '"ZCode.exe","20588","Console","1","50,000 K"\r\n');
      }
      return cb(new Error("unexpected exec"));
    };
    const collector = testCollector({ spawnFn, execFn, nowFn: () => 3000 });
    const procs = await collector.scanProcesses();
    assert.equal(procs.zcode, 1, "超时轮必须落到 tasklist 兜底而不是挂死");
  });
});

// Cross-restart display history. A relay restart used to zero every aggregate
// and instance bucket, and the board showed zeros/empty cells until the next
// request finished settling — a whole coding turn for kimi. The snapshot
// carries cumulative accounting and the sample windows only; in-flight
// counters and current-identity fields stay live-only.
describe("metrics snapshot persistence across collector recreations", () => {
  const chainExec = (cmd, opts, cb) => cb(null, WMIC_LINEAGE_CHAIN_SCAN);
  const emptyScanExec = (cmd, opts, cb) => cb(null, "Node,CommandLine,Name,ParentProcessId,ProcessId\r\n");

  function snapshotDir() {
    return mkdtempSync(join(tmpdir(), "anyswitch-metrics-snapshot-"));
  }

  it("restores endpoint accounting, sample windows and sticky identity", async () => {
    const dir = snapshotDir();
    try {
      let t = 10_000;
      const first = testCollector({ execFn: chainExec, nowFn: () => t, persistRoot: dir });
      await first.scanProcesses();
      const req = first.startRequest({ agentId: "kimi", model: "kimi-k3", providerId: "a6api-main" });
      t += 1200;
      req.recordFirstChunk();
      t += 2000;
      req.recordEnd({ usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } } });
      assert.equal(first.persistMetricsSnapshot(), true, "flush writes the sidecar");
      assert.ok(existsSync(join(dir, METRICS_SNAPSHOT_FILENAME)));

      const second = testCollector({ execFn: chainExec, nowFn: () => t, persistRoot: dir });
      const kimi = (await second.getAgentsStatus()).find((a) => a.id === "kimi");
      assert.equal(kimi.metrics.totalRequests, 1);
      assert.equal(kimi.metrics.tokens.prompt, 1000);
      assert.equal(kimi.metrics.tokens.completion, 50);
      assert.equal(kimi.metrics.tokens.cached, 800);
      assert.equal(kimi.metrics.cacheHitRate, 80); // 800 / 1000
      assert.equal(kimi.metrics.lastTtftMs, 1200);
      assert.equal(kimi.metrics.avgTtftMs, 1200);
      assert.equal(kimi.metrics.tps, 25); // 50 tokens over the 2.0s generation window
      assert.equal(kimi.lastModel, "kimi-k3");
      assert.equal(kimi.lastProvider, "a6api-main");
      // Live-only fields never come back: nothing is generating in this process.
      assert.equal(kimi.metrics.activeRequests, 0);
      assert.equal(kimi.currentModel, null);
      assert.equal(kimi.status, "running"); // process scan still owns liveness
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops an in-flight request's live state while keeping its started accounting", async () => {
    const dir = snapshotDir();
    try {
      let t = 10_000;
      const first = testCollector({ execFn: chainExec, nowFn: () => t, persistRoot: dir });
      await first.scanProcesses();
      first.startRequest({ agentId: "kimi", instanceId: "kimi-4321", model: "kimi-k3", providerId: "a6api-main" });
      assert.equal(first.persistMetricsSnapshot(), true);

      const second = testCollector({ execFn: chainExec, nowFn: () => t, persistRoot: dir });
      const kimi = (await second.getAgentsStatus()).find((a) => a.id === "kimi");
      assert.equal(kimi.metrics.totalRequests, 1, "the start crossed the restart");
      assert.equal(kimi.metrics.activeRequests, 0, "a restored activeRequests would pin the 生成中 badge");
      assert.equal(kimi.currentModel, null);
      assert.equal(kimi.lastModel, "kimi-k3", "the sticky 最近 identity survives");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restored instance rows survive only while their owning pid is alive", async () => {
    const dir = snapshotDir();
    try {
      let t = 10_000;
      const first = testCollector({ execFn: chainExec, nowFn: () => t, persistRoot: dir });
      await first.scanProcesses(); // kimi client pid 4321 alive
      const req = first.startRequest({ agentId: "kimi", instanceId: "kimi-4321", model: "m1" });
      req.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 10 } });
      assert.equal(first.persistMetricsSnapshot(), true);

      const alive = testCollector({ execFn: chainExec, nowFn: () => t, persistRoot: dir });
      const kimiAlive = (await alive.getAgentsStatus()).find((a) => a.id === "kimi");
      const row = kimiAlive.instances.find((i) => i.id === "kimi-4321");
      assert.ok(row, "a live pid keeps its restored row");
      assert.equal(row.requests, 1);
      assert.equal(row.tokens.prompt, 100);

      const gone = testCollector({ execFn: emptyScanExec, nowFn: () => t, persistRoot: dir });
      const kimiGone = (await gone.getAgentsStatus()).find((a) => a.id === "kimi");
      assert.deepEqual(kimiGone.instances.map((i) => i.id), [],
        "a dead pid evicts the restored row on the first read");
      assert.equal(kimiGone.metrics.totalRequests, 1, "endpoint accounting is unaffected by instance liveness");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a corrupt sidecar loads as a clean start and is overwritten by the next flush", async () => {
    const dir = snapshotDir();
    try {
      writeFileSync(join(dir, METRICS_SNAPSHOT_FILENAME), "{ this is not json", "utf8");
      const collector = testCollector({ execFn: chainExec, nowFn: () => 10_000, persistRoot: dir });
      const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
      assert.equal(kimi.metrics.totalRequests, 0);
      assert.equal(collector.persistMetricsSnapshot(), true);
      const written = JSON.parse(readFileSync(join(dir, METRICS_SNAPSHOT_FILENAME), "utf8"));
      assert.equal(written.version, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a collector without persistRoot keeps no sidecar at all", async () => {
    const dir = snapshotDir();
    try {
      const collector = testCollector({ execFn: chainExec, nowFn: () => 10_000 });
      const req = collector.startRequest({ agentId: "kimi", model: "m1" });
      req.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
      assert.equal(collector.persistMetricsSnapshot(), false);
      assert.deepEqual(readdirSync(dir), [], "no persistRoot means nothing is ever written");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
