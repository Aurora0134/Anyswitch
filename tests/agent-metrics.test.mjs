import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentMetricsCollector,
  createSessionReporter,
  buildDshConsoleQuery,
  claudeDesktopForm,
  claudeSurfaceLabel,
  dshProfileNameFrom,
  kimiSurfaceLabel,
  workbuddySurfaceLabel,
  summarizeKimiSurfaces,
  summarizeWorkbuddySurfaces,
  workbuddySessionIsIdlePrewarm,
  parseDshConsoleQueryOutput,
  findDescendantClientPid,
  getTtftColor,
  formatDuration,
  normalizeInstanceId,
  sampleTps,
  sampleCacheHitRate,
  windowTps,
  TTFT_THRESHOLDS,
  METRICS_SNAPSHOT_FILENAME,
  PS_PROBE_TIMEOUT_MS,
  PS_PROBE_OPTIONAL_TIMEOUT_MS,
} from "../src/agents/agent-metrics.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";
import { hasRunningCommand } from "../src/terminal/terminal-switch-guard.mjs";
import { attributeTerminalSessions } from "../src/terminal/terminal-attribution.mjs";

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
    // The cache rate reads the newest sample alone: it needs prompt tokens,
    // not a generation window, and it never aggregates across the window.
    assert.equal(sampleCacheHitRate(samples[samples.length - 1]), 0);
    assert.equal(sampleCacheHitRate(samples[0]), 50);
    assert.equal(windowTps([]), null);
    assert.equal(windowTps(undefined), null);
    assert.equal(sampleCacheHitRate(undefined), null);
    assert.equal(sampleCacheHitRate({ completion: 5, prompt: 0, cached: 0 }), null);
  });

  it("cache-hit rate reads the newest request alone, never a window aggregate", () => {
    const samples = [
      { completion: 100, genDurationMs: 1000, prompt: 100000, cached: 90000 }, // 90%
      { completion: 100, genDurationMs: 1000, prompt: 200, cached: 0 }, // 0%
    ];
    // A token-weighted window would report 89.9% and a per-request mean 45%;
    // the card shows the request that just finished.
    assert.equal(sampleCacheHitRate(samples[samples.length - 1]), 0);
    assert.equal(sampleCacheHitRate(samples[0]), 90);
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
    const req1 = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "gemini-3.7-flash" });
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
    assert.equal(stab.models[0].provider, "otter");
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

    const req = collector.startRequest({ agentId: "zcode", providerId: "acme-default", model: "claude-sonnet-4-6" });
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
    const ok1 = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
    mockTime = 2000; // TTFT = 1000ms
    ok1.recordFirstChunk();
    mockTime = 4000;
    ok1.recordEnd({ usage: { prompt_tokens: 100, completion_tokens: 10 } });

    // 2. 502 fails BEFORE any first chunk — the 5s failure duration must not
    //    be recorded as a plausible-looking TTFT
    const bad = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
    mockTime = 9000;
    bad.recordEnd({ status: 502, error: { status: 502, message: "Upstream Bad Gateway" } });

    let status = await collector.getAgentsStatus();
    let zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.metrics.lastTtftMs, 1000); // untouched by the failure
    assert.equal(zcode.metrics.ttftColor, "green");
    assert.equal(zcode.errorActive, true);

    // 3. Next clean success clears the active fault, error history retained
    const ok2 = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
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

    const bad = collector.startRequest({ agentId: "zcode", providerId: "acme-glm", model: "glm-5.3" });
    mockTime = 2000;
    bad.recordEnd({ status: 503, error: { status: 503, message: "upstream unavailable" } });

    const otherProvider = collector.startRequest({ agentId: "zcode", providerId: "acme-default", model: "gemini-3.6-flash" });
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

    const otherModel = collector.startRequest({ agentId: "zcode", providerId: "acme-glm", model: "glm-5.2" });
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

    const glm = collector.startRequest({ agentId: "zcode", providerId: "acme-glm", model: "glm-5.3" });
    mockTime = 2000;
    glm.recordEnd({ status: 503, error: { status: 503, message: "upstream unavailable" } });

    const acme = collector.startRequest({ agentId: "zcode", providerId: "acme-default", model: "gemini-3.6-flash" });
    mockTime = 2500;
    acme.recordEnd({ status: 502, error: { status: 502, message: "Upstream Bad Gateway" } });

    let status = await collector.getAgentsStatus();
    let zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, true);
    assert.equal(zcode.activeErrors.length, 2);
    assert.deepEqual(zcode.activeErrors.map((e) => e.model).sort(), ["gemini-3.6-flash", "glm-5.3"]);
    assert.equal(zcode.lastError.model, "gemini-3.6-flash");

    const recoverAcme = collector.startRequest({ agentId: "zcode", providerId: "acme-default", model: "gemini-3.6-flash" });
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

    const bad = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
    mockTime = 2000;
    bad.recordEnd({ status: 502, error: { status: 502, message: "Upstream Bad Gateway" } });
    let status = await collector.getAgentsStatus();
    let zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.errorActive, true);
    assert.equal(zcode.activeErrors.length, 1);

    // Retry begin must NOT hide the 502 — otherwise a looping retry never
    // surfaces the banner. The latch lives until a genuine first token.
    const retry = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
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

    const bad = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
    mockTime = 2000;
    bad.recordEnd({ status: 502, error: { status: 502, message: "Upstream Bad Gateway" } });

    const retry = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
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

    // Past the margin with the endpoint closed: the whole run account is
    // zeroed (run-scoped zeroing), so the banner folds together with the
    // history that used to outlive the endpoint.
    mockTime = 6000;
    status = await collector.getAgentsStatus();
    kimi = status.find((a) => a.id === "kimi");
    assert.equal(kimi.errorActive, false, "latched fault is settled once the endpoint is gone");
    assert.equal(kimi.activeErrors.length, 0);
    assert.equal(kimi.lastError, null, "fault history is part of the run account: zeroed with it");
  });

  it("keeps the fault latched while the endpoint process is still running", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => {
      // Real wmic shape: Node,CommandLine,Name,ProcessId (no parent column in
      // this older fixture — the ppid-less 4-column dump).
      cb(null, "Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\kimi\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs,node.exe,12345\r\n");
    };
    const collector = testCollector({ execFn: mockExec, nowFn });

    const bad = collector.startRequest({ agentId: "kimi", providerId: "acme-main", model: "kimi-k3" });
    mockTime = 2000;
    bad.recordEnd({ status: 400, error: { status: 400, message: "the upstream provider returned status 400" } });

    // Fault at t=2000, read at t=60000: 58s idle — far past the 3s
    // process-gone margin, but still 2s inside the 60s FAULT_IDLE_TTL_MS. The
    // latch must survive on liveness alone: the scan sees the kimi row, so run
    // zeroing never fires, and the TTL boundary (`now - fault.time >= ttlMs`)
    // is not reached either. Pushing the read to 62000 would expire it.
    mockTime = 60000;
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

    const bad = collector.startRequest({ agentId: "zcode", providerId: "acme-glm", model: "glm-5.3" });
    mockTime = 2000;
    bad.recordEnd({ status: 503, error: { status: 503, message: "upstream unavailable" } });

    // A different provider+model begins — must not touch the acme fault.
    collector.startRequest({ agentId: "zcode", providerId: "acme-default", model: "gemini-3.6-flash" });
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

    const bad = collector.startRequest({ agentId: "zcode", providerId: "acme-glm", model: "glm-5.3" });
    mockTime = 2000;
    bad.recordEnd({ status: 503, error: { status: 503, message: "upstream unavailable" } });

    const ok = collector.startRequest({ agentId: "zcode", providerId: "acme-glm", model: "glm-5.3" });
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
    // zcode 进程活着：本例验证的是故障空闲 TTL，不是 run 清零——零进程夹具
    // 会让 run zeroing 先把整账连同故障史收走，TTL 路径根本走不到。
    const mockExec = (cmd, opts, cb) =>
      cb(null, "Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\ZCode.exe,zcode.exe,12345\r\n");
    const collector = testCollector({ execFn: mockExec, nowFn });

    // Model A errors and is then abandoned; the user switches to model B.
    const bad = collector.startRequest({ agentId: "zcode", providerId: "acme-glm", model: "model-a" });
    mockTime = 2000;
    bad.recordEnd({ status: 503, error: { status: 503, message: "upstream unavailable" } });

    // Model B succeeds — this must NOT clear model A's fault (existing latch semantics)
    const ok = collector.startRequest({ agentId: "zcode", providerId: "acme-default", model: "model-b" });
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

    // Two failures on the same provider+model pair, 50s apart (t=1000 and
    // t=51000); the read happens at t=51000. The pair holds one fault entry,
    // rewritten by the second error, so the observation is inside the 60s TTL
    // either way — this pins "the pair keeps its single latch across retries",
    // not the entry.time refresh itself (that needs a read past t=61000).
    for (let round = 0; round < 2; round++) {
      const bad = collector.startRequest({ agentId: "zcode", providerId: "acme-glm", model: "model-a" });
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
    // 同上：zcode 进程活着，隔离故障 TTL 路径，别让 run zeroing 抢答。
    const mockExec = (cmd, opts, cb) =>
      cb(null, "Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\ZCode.exe,zcode.exe,12345\r\n");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const req = collector.startRequest({ agentId: "zcode",});
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

    const bad = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
    mockTime = 2000;
    bad.recordEnd({ status: 502, error: { status: 502, message: "Upstream Bad Gateway" } });

    // Abort is not recovery: the prior 502 stays latched. Abort also must
    // not raise a second fault or invent a TTFT from the wait duration.
    const aborted = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
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
    const ok = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
    mockTime = 7000;
    ok.recordFirstChunk();
    mockTime = 8000;
    ok.recordEnd({ usage: { prompt_tokens: 10, completion_tokens: 2 } });
    const ab2 = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
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
    const r1 = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
    mockTime = 1100; r1.recordFirstChunk();
    mockTime = 1200; // 100ms generation, 500 tokens
    r1.recordEnd({ usage: { prompt_tokens: 10000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 10000 } } });

    // Req 2: slow, no cache.
    const r2 = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
    mockTime = 3000; r2.recordFirstChunk();
    mockTime = 13000; // 10s generation, 50 tokens
    r2.recordEnd({ usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0 } } });

    // Req 3: slow, no cache — evicts req 1 from the size-2 window.
    const r3 = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
    mockTime = 14000; r3.recordFirstChunk();
    mockTime = 24000; // 10s generation, 50 tokens
    r3.recordEnd({ usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0 } } });

    const status = await collector.getAgentsStatus();
    const zcode = status.find((a) => a.id === "zcode");
    // Window = req2 + req3 only: 100 tok / 20s = 5.0 tps. The lifetime average
    // (all three) would be 600 tok / 20.1s ≈ 29.9 — req 1 would still own it.
    assert.equal(zcode.metrics.tps, 5);
    // Latest request: 0 cached / 1000 prompt = 0%. Lifetime would be
    // 10000/12000 ≈ 83.3%.
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
    assert.equal(claude.sessions[0].id, "claude-4444");
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
      requests: 5,
      activeRequests: 0,
      activeDurationMs: 8000,
      promptTokens: 100,
      completionTokens: 20,
      model: "anthropic/chan-b/glm-5.3",
    });

    const status = await collector.getAgentsStatus();
    const claude = status.find((a) => a.id === "claude");
    // Only pid 4444 is generating → its model is the active capsule.
    assert.deepEqual(claude.activeModels, ["anthropic/chan-a/qwen-max"]);
    assert.equal(claude.currentModel, "anthropic/chan-a/qwen-max");
    // pid 5555 reported later → its model is the latest-seen "最近" fallback.
    assert.equal(claude.lastModel, "anthropic/chan-b/glm-5.3");
  });

  it("keeps the claude card lastModel when a session goes idle (最近 capsule)", async () => {
    const nowFn = () => 10000;
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","4444","Console","1","55,000 K"\r\n`);

    const collector = testCollector({ execFn: mockExec, nowFn });

    collector.reportSession("tok_A", {
      pid: 4444,
      requests: 2,
      activeRequests: 1,
      activeDurationMs: 5000,
      promptTokens: 50,
      completionTokens: 10,
      model: "anthropic/chan-a/qwen-max",
    });
    collector.reportSession("tok_A", {
      pid: 4444,
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
      pid: 4444, requests: 3, activeRequests: 1,
      model: "claude-opus-5", providerId: "chan-a", viaAuto: true,
    });
    collector.reportSession("tok_B", {
      pid: 5555, requests: 5, activeRequests: 2,
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
      pid: 4444, requests: 1, activeRequests: 1, model: null, providerId: null, viaAuto: false,
    });
    let claude = (await collector.getAgentsStatus()).find((a) => a.id === "claude");
    assert.deepEqual(claude.activeModels, [], "节点没定下来就没有活跃模型，胶囊回落到最近/待命");
    assert.deepEqual(claude.activeTargets, []);
    assert.equal(claude.lastModel, null);

    // 节点宣布 → 真实渠道/模型上屏。
    collector.reportSession("tok_A", {
      pid: 4444, requests: 1, activeRequests: 1,
      model: "claude-opus-5", providerId: "chan-a", viaAuto: true,
    });
    claude = (await collector.getAgentsStatus()).find((a) => a.id === "claude");
    assert.deepEqual(claude.activeTargets, [{ providerId: "chan-a", model: "claude-opus-5", count: 1, autoCount: 1 }]);

    // 请求结束（快照回到无身份）→ 灰胶囊「最近」保留真实渠道/模型。
    collector.reportSession("tok_A", {
      pid: 4444, requests: 2, activeRequests: 0, model: null, providerId: null, viaAuto: false,
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
    assert.equal(claude.sessions[0].id, "claude-7777");
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
    assert.equal(claude.sessions[0].id, "claude-8888");
    assert.equal(claude.sessions[0].requests, 0);

    // Now the real session report arrives with a real token — should replace the placeholder
    collector.reportSession("token_real", {
      pid: 8888,
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
    assert.equal(claude.sessions[0].id, "claude-8888");
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
    assert.equal(claude.sessions[0].id, "claude-5555", "must be the placeholder, not the kimi session");
    assert.equal(claude.sessions[0].requests, 0);
  });

  it("keeps the claude path unchanged when agentId is missing or explicitly claude", async () => {
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","4444","Console","1","55,000 K"\r\n`);
    const collector = testCollector({ execFn: mockExec, nowFn: () => 10000 });

    collector.reportSession("tok_explicit_claude", {
      pid: 4444,
      agentId: "claude",
      requests: 1,
      activeRequests: 0,
    });

    const status = await collector.getAgentsStatus();
    const claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessionsCount, 1);
    assert.equal(claude.sessions[0].id, "claude-4444");
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
      requests: 1,
    });

    const status = await collector.getAgentsStatus();
    const claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessionsCount, 1);
    assert.equal(claude.sessions[0].id, "claude-4444");
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
      requests: 1,
    });

    const status = await collector.getAgentsStatus();
    const claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessionsCount, 1);
    assert.equal(claude.sessions[0].id, "claude-4444");
  });

  it("automatically detects running claude.exe process even before first reportSession call", async () => {
    const mockExec = (cmd, opts, cb) =>
      cb(null, `"claude.exe","4444","Console","1","55,000 K"\r\n`);
    const collector = testCollector({ execFn: mockExec, nowFn: () => 10000 });

    const status = await collector.getAgentsStatus();
    const claude = status.find((a) => a.id === "claude");
    assert.equal(claude.status, "running");
    assert.equal(claude.sessionsCount, 1);
    assert.equal(claude.sessions[0].id, "claude-4444");
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
    assert.equal(claude.sessions[0].id, "claude-9876");
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

  // 2026-10-15 修复面：qoder CLI（qodercli.exe，终端一键启动的执行体）此前
  // 不在认领桶也不在探测 WHERE——CLI 进程对检测面全盲，虚拟终端的 Qoder
  // 会话永远归属不上；实例身份面（socket 兜底白名单 + instanceBuckets）
  // 同批收编。live 取证形状：cmd 壳 19560 → 主 CLI 10284 → MCP 内部子进程 7332。
  describe("qoder CLI (qodercli.exe) process + instance surfaces", () => {
    const PS_QODER_CLI_SCAN = [
      String.raw`10284,19560,qodercli.exe,C:\Users\tester\.qoder\bin\qodercli\qodercli.exe`,
      String.raw`7332,10284,qodercli.exe,C:\Users\tester\.qoder\bin\qodercli\qodercli.exe --internal-sites-mcp C:\Users\tester\.qoder\plugins\cache\qoder-sites`,
      String.raw`19560,23828,cmd.exe,C:\Windows\system32\cmd.exe`,
    ].join("\r\n") + "\r\n";

    it("claims the CLI main process and filters the --internal-sites-mcp helper", async () => {
      const collector = testCollector({ execFn: (c, o, cb) => cb(null, PS_QODER_CLI_SCAN), nowFn: () => 10000 });
      const procs = await collector.scanProcesses();
      assert.equal(procs.qoder, 1, "主 CLI 计数 1；内部 sites-mcp 子进程与 Electron helper 同等滤掉");
      assert.ok(procs.qoderPids.has(10284));
      assert.ok(!procs.qoderPids.has(7332), "MCP 子进程不进家族集（占位行/检测面不受其干扰）");
      assert.equal(procs.ppidByPid.get(7332), 10284, "其父指针照常进谱系表");
    });

    // 2026-10-24 修复面：环境检测探版本 spawn `qodercli.exe --version`（秒退），
    // 扫描按镜像名认领会把探针当活客户端——占位实例行起行、看板卡翻「运行中/
    // 待命」一个扫描窗口再回落（重启后首次检测撞扫描节奏，悬空卡间歇闪现）。
    // 裸 --version 形状（参数仅此一个）豁免；带其他参数的调用照常计数。
    describe("version probe row (--version only) exemption", () => {
      const PS_PROBE_SCAN = [
        String.raw`10284,19560,qodercli.exe,C:\Users\tester\.qoder\bin\qodercli\qodercli.exe`,
        String.raw`42424,23332,qodercli.exe,C:\Users\tester\.qoder\bin\qodercli\qodercli.exe --version`,
        String.raw`42425,23332,qodercli.exe,"C:\Users\tester\.qoder\bin\qodercli\qodercli.exe" --version`,
      ].join("\r\n") + "\r\n";

      it("skips the probe row; the real CLI still counts and the probe pid stays in the lineage table", async () => {
        const collector = testCollector({ execFn: (c, o, cb) => cb(null, PS_PROBE_SCAN), nowFn: () => 10000 });
        const procs = await collector.scanProcesses();
        assert.equal(procs.qoder, 1, "探针行（裸 --version，引号/裸路径两形）不计数，主 CLI 照常");
        assert.ok(procs.qoderPids.has(10284));
        assert.ok(!procs.qoderPids.has(42424), "探针 pid 不进家族集（不起占位行、不翻卡）");
        assert.ok(!procs.qoderPids.has(42425));
        assert.equal(procs.ppidByPid.get(42424), 23332, "探针父指针照常进谱系表");
      });

      it("a probe-only round counts zero, so no placeholder row and the card stays stopped", async () => {
        let t = 1000;
        const collector = testCollector({
          execFn: (c, o, cb) => cb(null, String.raw`42424,23332,qodercli.exe,C:\Users\tester\.qoder\bin\qodercli\qodercli.exe --version` + "\r\n"),
          nowFn: () => t,
        });
        const procs = await collector.scanProcesses();
        assert.equal(procs.qoder, 0);
        const qoder = (await collector.getAgentsStatus()).find((a) => a.id === "qoder");
        assert.equal(qoder.status, "stopped", "探针独轮不翻卡");
        assert.equal(qoder.instances.length, 0, "不起占位实例行");
      });

      it("a session-shaped invocation (arguments beyond --version) still counts", async () => {
        const collector = testCollector({
          execFn: (c, o, cb) => cb(null, String.raw`10284,19560,qodercli.exe,C:\Users\tester\.qoder\bin\qodercli\qodercli.exe --resume 0198b8a6-7f5e-7f73-a1c2-9f4d5e6a7b8c` + "\r\n"),
          nowFn: () => 10000,
        });
        const procs = await collector.scanProcesses();
        assert.equal(procs.qoder, 1, "续接会话形调用不是探针，照常计数");
        assert.ok(procs.qoderPids.has(10284));
      });
    });

    // 2026-10-26 修复面：探针退场那一小段，可信轮的 CIM 会把 CommandLine 报空
    // （现场原始行 `<pid>,<ppid>,qodercli.exe,`；高频采样 20 次探针进程，12 次
    // 看到「先 --version 后空」）。只看形状的豁免认不出这种行，它落进「认不出
    // 即计数」，于是任何一次环境检测都能变成一张悬空卡——症状与 10-24 那笔同形，
    // 触发面却从重启扩到了全程。判定改为「连续性」：读不出命令行的行，只认上一轮
    // 可信扫描已经算进同一个桶的 pid；探针活不到下一轮扫描，永远进不了那个集合。
    describe("version probe teardown row (unreadable command line)", () => {
      const SESSION_ROW = String.raw`10284,19560,qodercli.exe,C:\Users\tester\.qoder\bin\qodercli\qodercli.exe`;
      const PROBE_TEARDOWN_ROW = String.raw`42424,23332,qodercli.exe,`;

      // 越窗的那次读只负责踢起扫描（返回上一份快照），落地后再读一次才是本轮
      // 真值——与既有 eviction 测试同款。
      async function settle(collector, id = "qoder") {
        await collector.getAgentsStatus();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return (await collector.getAgentsStatus()).find((a) => a.id === id);
      }

      it("an unreadable probe row with no history counts zero — no flip, no placeholder row", async () => {
        const collector = testCollector({
          execFn: (c, o, cb) => cb(null, PROBE_TEARDOWN_ROW + "\r\n"),
          nowFn: () => 10000,
        });
        const procs = await collector.scanProcesses();
        assert.equal(procs.qoder, 0, "命令行读不出的探针行不计数");
        assert.equal(procs.qoderPids.size, 0, "探针 pid 不进家族集");
        assert.equal(procs.ppidByPid.get(42424), 23332, "父指针照常进谱系表");
        const qoder = await settle(collector);
        assert.equal(qoder.status, "stopped", "不翻卡");
        assert.equal(qoder.instances.length, 0, "不起占位实例行");
      });

      it("a real session that reads empty in a later round keeps counting", async () => {
        let t = 3000;
        let rows = SESSION_ROW + "\r\n";
        const collector = testCollector({ execFn: (c, o, cb) => cb(null, rows), nowFn: () => t });
        let qoder = await settle(collector);
        assert.equal(qoder.status, "running");
        assert.deepEqual(qoder.instances.map((i) => i.id), ["qoder-10284"]);
        rows = String.raw`10284,19560,qodercli.exe,` + "\r\n";
        t += 3000;
        qoder = await settle(collector);
        assert.equal(qoder.status, "running", "同一 pid 上一轮算过，读空也照常计数");
        assert.deepEqual(qoder.instances.map((i) => i.id), ["qoder-10284"], "读空不得把行误删（那会闪灭一次卡）");
      });

      it("a session first seen with an empty command line lands one round later", async () => {
        let t = 3000;
        let rows = String.raw`10284,19560,qodercli.exe,` + "\r\n";
        const collector = testCollector({ execFn: (c, o, cb) => cb(null, rows), nowFn: () => t });
        let qoder = await settle(collector);
        assert.equal(qoder.status, "stopped", "首见即读空：这一轮不计数（宁可少算一轮）");
        rows = SESSION_ROW + "\r\n";
        t += 3000;
        qoder = await settle(collector);
        assert.equal(qoder.status, "running", "下一轮读得出，照常计数");
      });

      it("a blind tasklist round counts no probe either", async () => {
        const execFn = (cmd, opts, cb) => {
          if (String(cmd).startsWith("tasklist")) {
            return cb(null, '"qodercli.exe","42424","Console","1","10,000 K"\r\n');
          }
          return cb(null, ""); // 常驻探针这一路不出行 → 本轮降到 tasklist
        };
        const collector = testCollector({ execFn, nowFn: () => 10000 });
        const procs = await collector.scanProcesses();
        assert.equal(procs.countsAuthoritative, false, "确认走的是降级轮");
        assert.equal(procs.qoder, 0, "整轮没有命令行，探针同样不计数（上一笔遗留的残差一并收掉）");
        const qoder = await settle(collector);
        assert.equal(qoder.status, "stopped");
        assert.equal(qoder.instances.length, 0);
      });

      it("a blind round keeps a real session counted (carry across the fallback)", async () => {
        let t = 3000;
        let trusted = true;
        const execFn = (cmd, opts, cb) => {
          if (String(cmd).startsWith("tasklist")) {
            return cb(null, trusted ? "" : '"qodercli.exe","10284","Console","1","10,000 K"\r\n');
          }
          return cb(null, trusted ? SESSION_ROW + "\r\n" : "");
        };
        const collector = testCollector({ execFn, nowFn: () => t });
        let qoder = await settle(collector);
        assert.equal(qoder.status, "running");
        trusted = false;
        t += 3000;
        qoder = await settle(collector);
        assert.equal(qoder.status, "running", "降级轮不得把读不出命令行的真会话判没");
        assert.deepEqual(qoder.instances.map((i) => i.id), ["qoder-10284"]);
      });

      it("grok (the other PROBE_VERSION_CLIENT) follows the same rule", async () => {
        const probe = testCollector({
          execFn: (c, o, cb) => cb(null, String.raw`7401,23332,grok.exe,` + "\r\n"),
          nowFn: () => 10000,
        });
        const procs = await probe.scanProcesses();
        assert.equal(procs.grok, 0, "grok 探针的收尾行同样不计数");
        assert.equal(procs.grokPids.size, 0);

        let t = 3000;
        let rows = String.raw`7402,23332,grok.exe,C:\Users\tester\.grok\bin\grok.exe` + "\r\n";
        const collector = testCollector({ execFn: (c, o, cb) => cb(null, rows), nowFn: () => t });
        let grok = await settle(collector, "grok");
        assert.equal(grok.status, "running");
        rows = String.raw`7402,23332,grok.exe,` + "\r\n";
        t += 3000;
        grok = await settle(collector, "grok");
        assert.equal(grok.status, "running", "真会话读空仍计数");
      });
    });

    it("feeds the terminal attribution with the main CLI, ancestor chain up to the shell", async () => {
      const collector = testCollector({ execFn: (c, o, cb) => cb(null, PS_QODER_CLI_SCAN), nowFn: () => 10000 });
      await collector.scanProcesses();
      const feed = collector.getDetectedClientProcesses();
      const qoderEntries = feed.filter((proc) => proc.agentId === "qoder");
      assert.equal(qoderEntries.length, 1);
      const { busy, ...qoderRest } = qoderEntries[0];
      assert.deepEqual(qoderRest, { agentId: "qoder", pid: 10284, ancestors: [19560, 23828] });
      // 底下的 --internal-sites-mcp 助手是本体常驻派生的自家人（前缀豁免），
      // 不是用户命令：判无活命令。修前按「逐字相同」判它是在跑证据，qoder 终端
      // 会永远换不了内容。
      assert.equal(busy, false, "常驻助手不算在跑命令");
    });

    it("materializes a qoder-<pid> instance row from a socket-fallback-shaped request", async () => {
      let t = 1000;
      const collector = testCollector({ execFn: (c, o, cb) => cb(null, PS_QODER_CLI_SCAN), nowFn: () => t });
      const r = collector.startRequest({
        agentId: "qoder", providerId: "north-main", model: "glm-5.3",
        instanceId: "qoder-10284", path: "openai", stream: true,
      });
      t = 2200; r.recordFirstChunk();
      t = 3200; r.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 50 } });
      const qoder = (await collector.getAgentsStatus()).find((a) => a.id === "qoder");
      assert.equal(qoder.metrics.totalRequests, 1, "聚合口径不变");
      const row = qoder.instances.find((i) => i.id === "qoder-10284");
      assert.ok(row, "socket 兜底形状的实例号物化出实例行（终端 join 的绑定目标）");
      assert.equal(row.requests, 1);
    });

    it("evicts the qoder instance row once the CLI process exits", async () => {
      let t = 3000;
      let cliAlive = true;
      const execFn = (cmd, opts, cb) => cb(null, cliAlive ? PS_QODER_CLI_SCAN : "");
      const collector = testCollector({ execFn, nowFn: () => t });
      const r = collector.startRequest({ agentId: "qoder", instanceId: "qoder-10284", model: "m1", path: "openai" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });
      let qoder = (await collector.getAgentsStatus()).find((a) => a.id === "qoder");
      assert.deepEqual(qoder.instances.map((i) => i.id), ["qoder-10284"]);
      cliAlive = false;
      t += 3000;
      await collector.getAgentsStatus();
      await new Promise((resolve) => setTimeout(resolve, 20));
      qoder = (await collector.getAgentsStatus()).find((a) => a.id === "qoder");
      assert.deepEqual(qoder.instances, [], "CLI 进程退出，行随对账收走");
    });

    it("serves the codex session metas through the terminal-join getter (15s cache)", async () => {
      const metas = [
        { id: "01a13b08-118c-78c3-b6aa-11762eb023bf", project: "C:\\Users\\tester\\dev", lastActive: 2000, originator: "codex-tui" },
        { id: "01a13635-fb5d-7202-81ad-54b6fc421a88", project: "C:\\Users\\tester\\other", lastActive: 1000, originator: "codex_work_desktop" },
      ];
      let calls = 0;
      const collector = testCollector({
        execFn: () => {},
        nowFn: () => 10000,
        codexSessionLookup: async () => { calls += 1; return metas; },
      });
      assert.deepEqual(await collector.getCodexSessionsForTerminalJoin(), metas);
      await collector.getCodexSessionsForTerminalJoin();
      assert.equal(calls, 1, "缓存窗口内不重扫");
    });
  });

  describe("opencode CLI: the `serve --service` child is not a session", () => {
    // Live shape observed 2026-10-16: the interactive opencode.exe spawns
    // `opencode.exe serve --service` (an internal local service that never
    // issues LLM traffic). Counting it by image name alone put a second,
    // permanently-idle 待命 card on the board for every real session.
    // 5-column WMIC shape (Node,CommandLine,Name,ParentProcessId,ProcessId),
    // same fixture family as the dsh/kimi describes below.
    const wmicOc = (...rows) => `Node,CommandLine,Name,ParentProcessId,ProcessId\r\n${rows.join("\r\n")}\r\n`;
    const OC_BIN = String.raw`C:\Users\tester\AppData\Roaming\npm\node_modules\@opencode\cli\node_modules\@opencode\cli-windows-x64\bin\opencode.exe`;
    const ocLauncherRow = `LAPTOP,C:\\WINDOWS\\system32\\cmd.exe /d /c chcp 65001 >nul & ${OC_BIN},cmd.exe,18580,18868`;
    const ocMainRow = `LAPTOP,${OC_BIN},opencode.exe,18868,14788`;
    const ocServeRow = `LAPTOP,${OC_BIN} serve --service,opencode.exe,14788,19852`;
    const PS_OPENCODE_SCAN = wmicOc(ocLauncherRow, ocMainRow, ocServeRow);

    it("counts the interactive process only; the serve child joins the family set", async () => {
      const collector = testCollector({ execFn: (c, o, cb) => cb(null, PS_OPENCODE_SCAN), nowFn: () => 10000 });
      const procs = await collector.scanProcesses();
      assert.equal(procs.opencode, 1, "serve --service 子进程不计会话");
      assert.ok(procs.opencodePids.has(14788));
      assert.ok(procs.opencodePids.has(19852), "子进程仍进家族集（存活判定要用）");
      assert.ok(procs.opencodeEnginePids.has(14788));
      assert.ok(!procs.opencodeEnginePids.has(19852), "子进程不进引擎集（占位行/检测面不受其干扰）");
      assert.ok(procs.opencodeServePids.has(19852), "子进程标记进 serve 集（实例号上折的判据）");
      assert.ok(!procs.opencodeServePids.has(14788));
      assert.equal(procs.ppidByPid.get(19852), 14788, "父子链照常进谱系表");
    });

    it("attributes the terminal session to the interactive process, not the serve child", async () => {
      const collector = testCollector({ execFn: (c, o, cb) => cb(null, PS_OPENCODE_SCAN), nowFn: () => 10000 });
      await collector.scanProcesses();
      const feed = collector.getDetectedClientProcesses();
      const entries = feed.filter((proc) => proc.agentId === "opencode");
      assert.equal(entries.length, 1, "serve 子进程不进 detected feed");
      const { busy, ...ocRest } = entries[0];
      assert.deepEqual(ocRest, { agentId: "opencode", pid: 14788, ancestors: [18868, 18580] });
      // serve --service 是本体可执行＋一段参数的常驻助手（前缀豁免），不是用户
      // 命令：判无活命令。修前按「逐字相同」判它是在跑证据，opencode 终端会永远
      // 换不了内容。
      assert.equal(busy, false, "常驻助手不算在跑命令");
    });

    it("spawns no placeholder row from the process alone; rows are session-born", async () => {
      // opencode 2.x 的实例行按会话起（会话头决定），进程本身不产出占位行——
      // 与 codex 同一口径：常驻 serve 进程不属于任何一个会话，给它占一行只会
      // 在会话行旁边多出一条恒 0 请求的空行。
      const collector = testCollector({ execFn: (c, o, cb) => cb(null, PS_OPENCODE_SCAN), nowFn: () => 10000 });
      const opencode = (await collector.getAgentsStatus()).find((a) => a.id === "opencode");
      assert.equal(opencode.processCount, 1, "进程照常计数，卡片状态仍是 running");
      assert.equal(opencode.status, "running");
      assert.deepEqual(opencode.instances, [], "无流量即无会话行");
    });

    it("folds a socket-synthesized serve-child instance id onto the interactive row at ingest", async () => {
      // Live shape 2026-10-16: the serve child holds the relay keep-alive
      // connection, so the netstat reverse lookup synthesizes `opencode-19852`
      // (the child's pid). Ingest must fold it up to the interactive process —
      // that is the row the terminal join binds and the only id the journal,
      // the instance buckets and the activity frames may carry.
      let t = 3000;
      const journal = { lines: [], appendRequest: (entry) => journal.lines.push(entry) };
      const collector = testCollector({ execFn: (c, o, cb) => cb(null, PS_OPENCODE_SCAN), nowFn: () => t, journal });
      // t=3000 越过扫描缓存窗（TTL 2500ms，lastProcessScanTime 从 0 起），
      // scanProcesses 才会真跑一轮并落地——请求路径只同步读缓存、从不触发扫描。
      await collector.scanProcesses();
      const r = collector.startRequest({
        agentId: "opencode", providerId: "north-main", model: "glm-5.3",
        instanceId: "opencode-19852", path: "openai", stream: true,
      });
      t = 4200; r.recordFirstChunk();
      t = 5200; r.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 50 } });
      const opencode = (await collector.getAgentsStatus()).find((a) => a.id === "opencode");
      assert.equal(opencode.metrics.totalRequests, 1, "聚合口径不变");
      assert.deepEqual(opencode.instances.map((i) => i.id), ["opencode-14788"], "账落在交互主进程行（终端 join 的绑定目标）");
      assert.equal(opencode.instances[0].requests, 1);
      assert.equal(journal.lines.length, 1, "journal 单请求单行");
      assert.equal(journal.lines[0].instanceId, "opencode-14788", "journal 行带折后的实例号（右栏最近请求的过滤键）");
    });

    it("refolds a request that landed before the scan classified the serve child onto the interactive row", async () => {
      // 请求路径只读扫描缓存、从不触发扫描：serve 子进程刚起、扫描还没看到它
      // 时，请求先落在子进程号的原始行上；缓存跟上后的下一轮读重折叠归位，
      // 计数随行保留——与 dsh/kimi 冷缓存收敛同一条机制。
      let t = 3000;
      let serveUp = false;
      const execFn = (cmd, opts, cb) => cb(null, serveUp ? PS_OPENCODE_SCAN : wmicOc(ocLauncherRow, ocMainRow));
      const collector = testCollector({ execFn, nowFn: () => t });
      const r = collector.startRequest({ agentId: "opencode", instanceId: "opencode-19852", model: "m1", stream: true, path: "openai" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 30, completion_tokens: 12 } });

      serveUp = true;
      t += 3000;
      await collector.scanProcesses();
      const opencode = (await collector.getAgentsStatus()).find((a) => a.id === "opencode");
      assert.deepEqual(opencode.instances.map((i) => i.id), ["opencode-14788"], "冷缓存落下的子进程号行折回交互主进程行");
      assert.equal(opencode.instances[0].requests, 1);
      assert.equal(opencode.instances[0].tokens.prompt, 30);
    });

    it("lists session rows alongside the process row, titled from the session scan", async () => {
      // 2.x 的请求带着会话头（opencode-sess-<会话 id>），行是按会话起的。
      // opencode 的行是流量生的、按会话划分，不额外补进程占位行（扫描到活的
      // serve 父进程也不占位，见 agent-metrics.mjs 里占位行的 codex/opencode
      // 例外）：占位行会以 0 请求常驻在会话行旁边。标题取扫描到的会话标题，
      // 没有就用目录名。
      let t = 3000;
      const collector = testCollector({
        execFn: (c, o, cb) => cb(null, PS_OPENCODE_SCAN),
        nowFn: () => t,
        opencodeSessionLookup: async () => [
          { id: "ses_one", project: "C:\\work\\alpha", title: "修复登录框", lastActive: 5000 },
          { id: "ses_two", project: "C:\\work\\beta", title: null, lastActive: 5000 },
        ],
      });
      await collector.scanProcesses();
      const r = collector.startRequest({
        agentId: "opencode", providerId: "north-main", model: "glm-5.3",
        instanceId: "opencode-sess-ses_one", path: "openai", stream: true,
      });
      t = 4200; r.recordFirstChunk();
      t = 5200; r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 4 } });
      const opencode = (await collector.getAgentsStatus()).find((a) => a.id === "opencode");
      const byId = new Map(opencode.instances.map((i) => [i.id, i]));
      assert.deepEqual([...byId.keys()], ["opencode-sess-ses_one"], "只有会话行，没有进程占位行");
      assert.equal(byId.get("opencode-sess-ses_one").title, "修复登录框", "标题取会话扫描结果");
      assert.equal(byId.get("opencode-sess-ses_one").requests, 1);
    });

    it("titles a session row by its directory basename when the session has no title", async () => {
      let t = 3000;
      const collector = testCollector({
        execFn: (c, o, cb) => cb(null, PS_OPENCODE_SCAN),
        nowFn: () => t,
        opencodeSessionLookup: async () => [{ id: "ses_two", project: "C:\\work\\beta", title: null, lastActive: 5000 }],
      });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "opencode", instanceId: "opencode-sess-ses_two", model: "m1", stream: true, path: "openai" });
      t = 4200; r.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
      const opencode = (await collector.getAgentsStatus()).find((a) => a.id === "opencode");
      const row = opencode.instances.find((i) => i.id === "opencode-sess-ses_two");
      assert.equal(row.title, "beta");
    });

    it("drops a session row after two consecutive trusted rounds see no family", async () => {
      // 会话行声明不了属主 pid，生死只能看端点的进程家族；而单轮「家族不在」
      // 不是判决——探针可能被时间预算截断，正在重启的家族也会有一轮空白。
      // 连续两轮都看不到才收行。
      let t = 3000;
      let alive = true;
      const execFn = (c, o, cb) => cb(null, alive ? PS_OPENCODE_SCAN : wmicOc());
      const collector = testCollector({ execFn, nowFn: () => t, opencodeSessionLookup: async () => [] });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "opencode", instanceId: "opencode-sess-ses_x", model: "m1", stream: true, path: "openai" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
      const read = async () => (await collector.getAgentsStatus()).find((a) => a.id === "opencode").instances.map((i) => i.id);
      assert.deepEqual(await read(), ["opencode-sess-ses_x"]);

      // 家族全灭。第一轮读：行仍在（单轮不判死）。
      alive = false;
      t += 3000;
      await collector.scanProcesses();
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(await read(), ["opencode-sess-ses_x"], "单轮空白不收行");
      // 第二轮仍是空白：判决成立，行收走。
      assert.deepEqual(await read(), [], "连续两轮看不到家族，会话行收走");
    });

    it("keeps a session row when the family blinks out for a single round", async () => {
      // 现场形态：TUI 重启期间进程扫描恰好落在一个空窗里，下一轮又回来了。
      let t = 3000;
      let alive = true;
      const execFn = (c, o, cb) => cb(null, alive ? PS_OPENCODE_SCAN : wmicOc());
      const collector = testCollector({ execFn, nowFn: () => t, opencodeSessionLookup: async () => [] });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "opencode", instanceId: "opencode-sess-ses_blink", model: "m1", stream: true, path: "openai" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
      const read = async () => (await collector.getAgentsStatus()).find((a) => a.id === "opencode").instances.map((i) => i.id);

      alive = false;
      t += 3000;
      await collector.scanProcesses();
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(await read(), ["opencode-sess-ses_blink"], "空窗那一轮不收行");

      alive = true;
      t += 3000;
      await collector.scanProcesses();
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(await read(), ["opencode-sess-ses_blink"], "家族回来后连续计数清零，行不受影响");
    });

    it("keeps an idle opencode session row while its TUI is still open", async () => {
      // 一条开着的 TUI 只是没在打字，它的对话还在屏幕上。若照 codex 的 5 分钟
      // 空闲档收行，终端右栏与看板会静置几分钟后突然认不出这条会话。
      let t = 3000;
      const collector = testCollector({
        execFn: (c, o, cb) => cb(null, PS_OPENCODE_SCAN),
        nowFn: () => t,
        opencodeSessionLookup: async () => [],
      });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "opencode", instanceId: "opencode-sess-ses_idle", model: "m1", stream: true, path: "openai" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
      // 跳过两小时（远超 codex 的 5 分钟档），TUI 一直开着。
      t += 2 * 60 * 60 * 1000;
      await collector.scanProcesses();
      const opencode = (await collector.getAgentsStatus()).find((a) => a.id === "opencode");
      assert.deepEqual(opencode.instances.map((i) => i.id), ["opencode-sess-ses_idle"]);
    });

    it("serves the opencode session metas through the terminal-join getter", async () => {
      const metas = [{ id: "ses_join", project: "C:\\work\\alpha", lastActive: 2000 }];
      let calls = 0;
      const collector = testCollector({
        execFn: () => {},
        nowFn: () => 10000,
        opencodeSessionLookup: async () => { calls += 1; return metas; },
      });
      assert.deepEqual(await collector.getOpencodeSessionsForTerminalJoin(), metas);
      await collector.getOpencodeSessionsForTerminalJoin();
      assert.equal(calls, 1, "缓存窗口内不重扫");
    });
  });

  describe("zcode session rows (x-session-id identity)", () => {
    // 5-column WMIC shape, same fixture family as the opencode group above.
    // 桌面端形态：主进程 ZCode.exe（计数）+ --type=utility 辅助子进程（跨会话
    // 共享连接池的属主候选，不计数但进谱系表）；CLI 形态：powershell 下 node
    // 拉起的 bin\zcode.mjs。
    const wmicZc = (...rows) => `Node,CommandLine,Name,ParentProcessId,ProcessId\r\n${rows.join("\r\n")}\r\n`;
    const ZC_HOME = String.raw`C:\Users\tester\AppData\Local\Programs\zcode`;
    const zcExplorerRow = "LAPTOP,C:\\WINDOWS\\explorer.exe,explorer.exe,3999,4000";
    const zcDesktopRows = [
      zcExplorerRow,
      `LAPTOP,${ZC_HOME}\\ZCode.exe,zcode.exe,4000,5000`,
      `LAPTOP,${ZC_HOME}\\ZCode.exe --type=utility,zcode.exe,5000,5001`,
    ];
    const ZC_DESKTOP_SCAN = wmicZc(...zcDesktopRows);
    const zcCliRows = [
      zcExplorerRow,
      "LAPTOP,C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\powershell.exe,powershell.exe,4000,6000",
      `LAPTOP,C:\\Program Files\\nodejs\\node.exe ${ZC_HOME}\\bin\\zcode.mjs,node.exe,6000,6001`,
    ];
    const CLI_SCAN = wmicZc(...zcCliRows);

    it("mints a session row from the request, with no placeholder rows for live family processes", async () => {
      // zcode 的行是流量生的、按会话划分（codex/opencode 同款）：扫描到活的
      // 桌面主进程不起占位行——否则 0 请求的占位行会常驻在会话行旁边。
      let t = 3000;
      const collector = testCollector({ execFn: (c, o, cb) => cb(null, ZC_DESKTOP_SCAN), nowFn: () => t });
      await collector.scanProcesses();
      const r = collector.startRequest({
        agentId: "zcode", providerId: "north-main", model: "glm-5.3",
        instanceId: "zcode-sess-sess_one", surfacePid: 5001, path: "openai", stream: true,
      });
      t = 4200; r.recordFirstChunk();
      t = 5200; r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 4 } });
      const zcode = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
      assert.deepEqual(zcode.instances.map((i) => i.id), ["zcode-sess-sess_one"], "只有会话行，没有进程占位行");
      assert.equal(zcode.instances[0].requests, 1);
      assert.equal(zcode.metrics.totalRequests, 1, "聚合口径不变");
    });

    it("badges a desktop-owned session row Desktop and a terminal one TUI", async () => {
      // 面从请求 socket 的属主 pid 沿谱系定档：utility 子进程（5001）自身即
      // zcode.exe → Desktop；CLI node（6001）走完整条链见不到 zcode.exe → TUI。
      let t = 3000;
      const desktop = testCollector({ execFn: (c, o, cb) => cb(null, ZC_DESKTOP_SCAN), nowFn: () => t });
      await desktop.scanProcesses();
      const r1 = desktop.startRequest({ agentId: "zcode", instanceId: "zcode-sess-sess_d", surfacePid: 5001, model: "m1", stream: true, path: "openai" });
      r1.recordEnd({ status: 200, usage: {} });
      const rowD = (await desktop.getAgentsStatus()).find((a) => a.id === "zcode").instances[0];
      assert.equal(rowD.surface, "Desktop");

      const cli = testCollector({ execFn: (c, o, cb) => cb(null, CLI_SCAN), nowFn: () => t });
      await cli.scanProcesses();
      const r2 = cli.startRequest({ agentId: "zcode", instanceId: "zcode-sess-sess_c", surfacePid: 6001, model: "m1", stream: true, path: "openai" });
      r2.recordEnd({ status: 200, usage: {} });
      const rowC = (await cli.getAgentsStatus()).find((a) => a.id === "zcode").instances[0];
      assert.equal(rowC.surface, "TUI");
    });

    it("leaves the row unbadged when the owner pid is unresolvable, and retries on the next request", async () => {
      // 判不出不贴（kimi/workbuddy 同款纪律）：属主 pid 不在本轮谱系表里就不
      // 定档；也不缓存——下一个请求带着可判的 pid 再定档。
      let t = 3000;
      const collector = testCollector({ execFn: (c, o, cb) => cb(null, ZC_DESKTOP_SCAN), nowFn: () => t });
      await collector.scanProcesses();
      const r1 = collector.startRequest({ agentId: "zcode", instanceId: "zcode-sess-sess_u", surfacePid: 9999, model: "m1", stream: true, path: "openai" });
      r1.recordEnd({ status: 200, usage: {} });
      let row = (await collector.getAgentsStatus()).find((a) => a.id === "zcode").instances[0];
      assert.equal("surface" in row, false, "属主 pid 判不出，行不贴面");

      const r2 = collector.startRequest({ agentId: "zcode", instanceId: "zcode-sess-sess_u", surfacePid: 5001, model: "m1", stream: true, path: "openai" });
      r2.recordEnd({ status: 200, usage: {} });
      row = (await collector.getAgentsStatus()).find((a) => a.id === "zcode").instances[0];
      assert.equal(row.surface, "Desktop", "未定的档不缓存，下个请求再定");
    });

    it("caches the classification per row once decided", async () => {
      // undici 空闲约 4s 断连，断连期查不到属主：已定档的行不随后续请求的
      // surfacePid 缺失/变化而翻案。
      let t = 3000;
      const collector = testCollector({ execFn: (c, o, cb) => cb(null, ZC_DESKTOP_SCAN), nowFn: () => t });
      await collector.scanProcesses();
      const r1 = collector.startRequest({ agentId: "zcode", instanceId: "zcode-sess-sess_k", surfacePid: 5001, model: "m1", stream: true, path: "openai" });
      r1.recordEnd({ status: 200, usage: {} });
      const r2 = collector.startRequest({ agentId: "zcode", instanceId: "zcode-sess-sess_k", model: "m1", stream: true, path: "openai" });
      r2.recordEnd({ status: 200, usage: {} });
      const row = (await collector.getAgentsStatus()).find((a) => a.id === "zcode").instances[0];
      assert.equal(row.surface, "Desktop");
    });

    it("counts the zcode CLI node process into the zcode family (both path separators)", async () => {
      // 纯 CLI 场景：家族 = bin\zcode.mjs 的 node 进程。两种分隔符都认；同机
      // 其它 node 系 agent（kimi-code）与裸 zcode.mjs 路径不误伤。
      const scan = wmicZc(
        zcExplorerRow,
        `LAPTOP,C:\\Program Files\\nodejs\\node.exe ${ZC_HOME}\\bin\\zcode.mjs,node.exe,4000,6001`,
        `LAPTOP,C:\\Program Files\\nodejs\\node.exe C:/Users/tester/scoop/apps/zcode/bin/zcode.mjs,node.exe,4000,6002`,
        "LAPTOP,C:\\Tools\\node.exe C:\\x\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs,node.exe,4000,6003",
        "LAPTOP,C:\\Tools\\node.exe C:\\tools\\zcode.mjs,node.exe,4000,6004",
      );
      const collector = testCollector({ execFn: (c, o, cb) => cb(null, scan), nowFn: () => 10000 });
      const procs = await collector.scanProcesses();
      assert.equal(procs.zcode, 2, "只认 bin\\zcode.mjs 入口的 node 行");
      assert.ok(procs.zcodePids.has(6001));
      assert.ok(procs.zcodePids.has(6002));
      assert.ok(!procs.zcodePids.has(6003), "kimi-code 的 node 行不归 zcode");
      assert.ok(!procs.zcodePids.has(6004), "无 bin\\ 段的裸 zcode.mjs 路径不认");
    });

    it("feeds the zcode CLI process into the detected-client feed with a busy flag", async () => {
      const collector = testCollector({ execFn: (c, o, cb) => cb(null, CLI_SCAN), nowFn: () => 10000 });
      await collector.scanProcesses();
      const detected = collector.getDetectedClientProcesses();
      const entry = detected.find((d) => d.agentId === "zcode");
      assert.ok(entry, "zcode CLI 进 detected feed");
      assert.equal(entry.pid, 6001);
      assert.ok(entry.ancestors.includes(6000), "谱系带给终端 join");
      assert.ok("busy" in entry, "忙闲位随行下发");
    });

    it("drops a session row after two consecutive trusted rounds see no family", async () => {
      // 与 opencode 同一判据：单轮「家族不在」不是判决（探针可能被时间预算截断），
      // 连续两轮都看不到才收行。
      let t = 3000;
      let alive = true;
      const execFn = (c, o, cb) => cb(null, alive ? CLI_SCAN : wmicZc());
      const collector = testCollector({ execFn, nowFn: () => t });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "zcode", instanceId: "zcode-sess-sess_x", model: "m1", stream: true, path: "openai" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
      const read = async () => (await collector.getAgentsStatus()).find((a) => a.id === "zcode").instances.map((i) => i.id);
      assert.deepEqual(await read(), ["zcode-sess-sess_x"]);

      alive = false;
      t += 3000;
      await collector.scanProcesses();
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(await read(), ["zcode-sess-sess_x"], "单轮空白不收行");
      assert.deepEqual(await read(), [], "连续两轮看不到家族，会话行收走");
    });

    it("5min 空闲档收走常驻家族下的静置行，累计并入退役账", async () => {
      // 桌面端常驻使家族永不灭，原先「不设空闲档」会让 2 小时前的会话行一直挂着。
      // 空闲档对齐 codex / WorkBuddy 的 5min；行下场前把累计并进退役账，端点账 =
      // 活行 + 退役账，读数不随行蒸发。
      let t = 3000;
      const collector = testCollector({ execFn: (c, o, cb) => cb(null, CLI_SCAN), nowFn: () => t });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "zcode", instanceId: "zcode-sess-sess_idle", model: "m1", stream: true, path: "openai" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
      const read = async () => (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
      assert.equal((await read()).instances.length, 1, "刚发完请求行在");

      t += 4 * 60 * 1000;
      await collector.scanProcesses();
      assert.deepEqual((await read()).instances.map((i) => i.id), ["zcode-sess-sess_idle"], "空闲档内不收行");

      t += 2 * 60 * 1000;
      await collector.scanProcesses();
      const zcode = await read();
      assert.deepEqual(zcode.instances.map((i) => i.id), [], "过 5min 空闲档收行");
      assert.equal(zcode.retiredMetrics.requests, 1, "行的累计并入退役账");
      assert.equal(zcode.metrics.totalRequests, 1, "端点账 = 活行 + 退役账，不归零");
    });

    it("serves the zcode session metas through the terminal-join getter", async () => {
      // 与 codex/opencode 同形：透传扫描原值（含 sess_ 前缀的 meta.id——剥前缀
      // 对齐在出口层 openai-server 做），吃 15 秒 per-endpoint 缓存。
      const metas = [{ id: "sess_join", project: "C:\\work\\alpha", lastActive: 2000 }];
      let calls = 0;
      const collector = testCollector({
        execFn: () => {},
        nowFn: () => 10000,
        zcodeSessionLookup: async () => { calls += 1; return metas; },
      });
      assert.deepEqual(await collector.getZcodeSessionsForTerminalJoin(), metas);
      await collector.getZcodeSessionsForTerminalJoin();
      assert.equal(calls, 1, "缓存窗口内不重扫");
    });

    it("degrades the terminal-join feed to an empty list when the session scan fails", async () => {
      const collector = testCollector({
        execFn: () => {},
        nowFn: () => 10000,
        zcodeSessionLookup: async () => { throw new Error("db locked"); },
      });
      assert.deepEqual(await collector.getZcodeSessionsForTerminalJoin(), [], "扫描失败绝不弄坏读取面");
    });

    // ---- 预留会话行：桌面端开着但还没有任何会话行时，卡里出且只出一条零账行。
    // 行在出口合成（桶里始终只有真实行），所以真实行出现的那一拍结构上不存在
    // 「两行并存」的中间态；行也不进实例桶、不进累计账。
    it("桌面端空态（无任何请求）给一条预留会话行", async () => {
      const collector = testCollector({
        execFn: (c, o, cb) => cb(null, ZC_DESKTOP_SCAN),
        nowFn: () => 3000,
      });
      await collector.scanProcesses();
      const zcode = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
      assert.equal(zcode.instances.length, 1, "空态只有预留行一条");
      const row = zcode.instances[0];
      assert.equal(row.id, "zcode-reserved");
      assert.equal(row.status, "idle", "没有请求，行待命");
      assert.equal(row.surface, "Desktop");
      assert.equal(row.requests, 0);
      assert.equal(row.activeRequests, 0);
      assert.equal(row.lastSeen, null, "刻意不写 lastSeen，避开前端 2 分钟陈旧判定");
      assert.equal(typeof row.firstSeen, "number", "首见时间是数字");
      assert.equal(row.activeDurationMs, 0);
      assert.equal(row.activeDurationFormatted, "0秒");
      assert.deepEqual(row.tokens, { prompt: 0, completion: 0, cached: 0 }, "零账");
      assert.equal(zcode.status, "running", "桌面端在场，卡片必须点亮");
      assert.deepEqual(zcode.surfaces, [{ surface: "desktop", label: "Desktop", count: 1 }]);
    });

    it("首个真实会话行出现后只留真实行，预留行让位", async () => {
      let t = 3000;
      const collector = testCollector({
        execFn: (c, o, cb) => cb(null, ZC_DESKTOP_SCAN),
        nowFn: () => t,
      });
      await collector.scanProcesses();
      const empty = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
      assert.deepEqual(empty.instances.map((i) => i.id), ["zcode-reserved"], "前置：空态先给预留行");

      t = 3200;
      const r = collector.startRequest({
        agentId: "zcode", instanceId: "zcode-sess-sess_a", surfacePid: 5001,
        model: "m1", stream: true, path: "openai",
      });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });

      const zcode = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
      assert.deepEqual(zcode.instances.map((i) => i.id), ["zcode-sess-sess_a"], "只剩真实行");
      assert.ok(!zcode.instances.some((i) => i.id === "zcode-reserved"), "不得两行并存");
    });

    it("5min 空闲档收走真实行后预留行顶回，累计账不蒸发", async () => {
      let t = 3000;
      const collector = testCollector({
        execFn: (c, o, cb) => cb(null, ZC_DESKTOP_SCAN),
        nowFn: () => t,
      });
      await collector.scanProcesses();
      const r = collector.startRequest({
        agentId: "zcode", instanceId: "zcode-sess-sess_exp", surfacePid: 5001,
        model: "m1", stream: true, path: "openai",
      });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
      const read = async () => (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
      assert.deepEqual((await read()).instances.map((i) => i.id), ["zcode-sess-sess_exp"], "刚发完请求行在");

      t += 4 * 60 * 1000;
      await collector.scanProcesses();
      assert.deepEqual((await read()).instances.map((i) => i.id), ["zcode-sess-sess_exp"], "空闲档内不收行");

      t += 2 * 60 * 1000;
      await collector.scanProcesses();
      const zcode = await read();
      assert.deepEqual(zcode.instances.map((i) => i.id), ["zcode-reserved"], "收行后桌面端仍在，预留行顶回");
      assert.equal(zcode.retiredMetrics.requests, 1, "行的累计并入退役账");
      assert.equal(zcode.metrics.totalRequests, 1, "累计不随行蒸发");
    });

    it("纯 CLI 形态不预留会话行", async () => {
      const collector = testCollector({
        execFn: (c, o, cb) => cb(null, CLI_SCAN),
        nowFn: () => 3000,
      });
      await collector.scanProcesses();
      const zcode = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
      assert.deepEqual(zcode.instances, [], "CLI 是 node 跑 bin\\zcode.mjs，不算桌面端在场");
      assert.deepEqual(zcode.surfaces, [], "没有桌面端就没有面徽章");
    });

    it("应用关闭后预留行随之消失", async () => {
      let t = 3000;
      let scan = ZC_DESKTOP_SCAN;
      const collector = testCollector({
        execFn: (c, o, cb) => cb(null, scan),
        nowFn: () => t,
      });
      await collector.scanProcesses();
      assert.deepEqual((await collector.getAgentsStatus()).find((a) => a.id === "zcode").instances.map((i) => i.id),
        ["zcode-reserved"], "前置：桌面端开着，有预留行");

      scan = wmicZc(zcExplorerRow);
      t += 3000;
      collector.scanProcesses();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual((await collector.getAgentsStatus()).find((a) => a.id === "zcode").instances,
        [], "扫描里没有 zcode，预留行不留");
    });

    it("降级扫描轮（tasklist 兜底、无命令行列）仍按镜像名预留", async () => {
      const collector = testCollector({
        execFn: (cmd, opts, cb) => (cmd.includes("tasklist")
          ? cb(null, '"ZCode.exe","20588","Console","1","50,000 K"\r\n')
          : cb(null, "")),
        nowFn: () => 3000,
      });
      const procs = await collector.scanProcesses();
      assert.equal(procs.zcode, 1, "兜底轮按镜像名认桌面主进程");
      const zcode = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
      assert.deepEqual(zcode.instances.map((i) => i.id), ["zcode-reserved"], "降级轮照样预留");
    });

    it("空态预留行连读两次指纹一致（面板按 JSON.stringify 判重渲染）", async () => {
      let t = 3000;
      const collector = testCollector({
        execFn: (c, o, cb) => cb(null, ZC_DESKTOP_SCAN),
        nowFn: () => t,
      });
      await collector.scanProcesses();
      const first = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
      // 跨读间隔一秒（面板轮询节奏）：firstSeen 不许跟着时钟走，否则整卡指纹每拍
      // 都变、卡片每秒重渲一次。
      t += 1000;
      const second = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
      assert.equal(first.instances[0].firstSeen, second.instances[0].firstSeen, "首见时间跨读稳定");
      assert.equal(JSON.stringify(first), JSON.stringify(second), "整卡指纹稳定");
    });
  });

  describe("zcode 子会话归母 / 面正源 / 端点账同源", () => {
    const MOTHER = "zcode-sess-93b5c395-8a19-4401-bb4c-ddbb096750a1";
    const CHILD = "zcode-sess-dwf-dwfrun-26c196b7-ea7f-4f1c-8a19-1df0699906a0-actor";
    // 独立夹具：5 列 WMIC 形状，活着的 zcode CLI 家族（行不被家族缺席判定收走）。
    const CLI_SCAN = "Node,CommandLine,Name,ParentProcessId,ProcessId\r\n"
      + "LAPTOP,C:\\WINDOWS\\explorer.exe,explorer.exe,3999,4000\r\n"
      + "LAPTOP,C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\powershell.exe,powershell.exe,4000,6000\r\n"
      + "LAPTOP,C:\\Program Files\\nodejs\\node.exe C:\\zcode\\bin\\zcode.mjs,node.exe,6000,6001\r\n";
    // 同一 workflow run 的两个 actor 经 64 字符截断压成同一个行 id，且同父。
    const metas = [
      { id: "sess_93b5c395-8a19-4401-bb4c-ddbb096750a1", project: "C:\\work\\alpha", lastActive: 5000, originator: "desktop", surface: "desktop" },
      { id: "sess_dwf-dwfrun-26c196b7-ea7f-4f1c-8a19-1df0699906a0-actor_1_1", project: "C:\\work\\alpha", lastActive: 6000, originator: null, surface: "cli", parentId: "sess_93b5c395-8a19-4401-bb4c-ddbb096750a1" },
      { id: "sess_dwf-dwfrun-26c196b7-ea7f-4f1c-8a19-1df0699906a0-actor_2_5", project: "C:\\work\\alpha", lastActive: 7000, originator: null, surface: "cli", parentId: "sess_93b5c395-8a19-4401-bb4c-ddbb096750a1" },
    ];
    const zcodeOf = async (collector) => (await collector.getAgentsStatus()).find((a) => a.id === "zcode");

    it("截断后同键同父 → 映射确定；母行不被改写", async () => {
      const collector = testCollector({ execFn: () => {}, nowFn: () => 10000, zcodeSessionLookup: async () => metas });
      await collector.getZcodeSessionsForTerminalJoin();
      assert.equal(collector.resolveZcodeParentRowId(CHILD), MOTHER, "同键多 actor 同父，映射唯一");
      assert.equal(collector.resolveZcodeParentRowId(MOTHER), MOTHER);
      assert.deepEqual([...collector.getZcodeLiveRowIds()], [], "尚无流量时不放行任何 feed 行");
    });

    it("冷缓存落在子行上的账补并回母行，端点账恒等于活行 + 退役账", async () => {
      const collector = testCollector({
        execFn: (c, o, cb) => cb(null, CLI_SCAN),
        nowFn: () => 10000,
        zcodeSessionLookup: async () => metas,
      });
      await collector.scanProcesses();
      await collector.getZcodeSessionsForTerminalJoin(); // 父子/面映射就位
      // 映射到位前（或旧快照还原）已经落在子行上的账：读取时补并，不靠新请求。
      const child = collector.startRequest({ agentId: "zcode", instanceId: CHILD, model: "m1", stream: true, path: "openai" });
      child.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 20 } });
      const mother = collector.startRequest({ agentId: "zcode", instanceId: MOTHER, model: "m1", stream: true, path: "openai" });
      mother.recordEnd({ status: 200, usage: { prompt_tokens: 50, completion_tokens: 10 } });
      const card = await zcodeOf(collector);
      assert.deepEqual(card.instances.map((i) => i.id), [MOTHER], "子行不再出现在看板");
      assert.equal(card.instances[0].requests, 2, "母行接住子会话流量");
      assert.equal(card.instances[0].tokens.prompt, 150);
      assert.equal(card.metrics.totalRequests, 2, "端点账 = 活会话行 + 退役账");
      assert.equal(card.metrics.tokens.prompt, 150);
      assert.equal(card.retiredMetrics.requests, 0, "本次没有行退役");
    });

    it("会话扫描的 surface 正源给恢复行补徽标，并随快照落盘", async () => {
      const dir = mkdtempSync(join(tmpdir(), "anyswitch-zcode-surface-"));
      try {
        const opts = () => ({
          execFn: (c, o, cb) => cb(null, CLI_SCAN),
          nowFn: () => 10000,
          persistRoot: dir,
          zcodeSessionLookup: async () => metas,
        });
        const first = testCollector(opts());
        await first.scanProcesses();
        await first.getZcodeSessionsForTerminalJoin();
        const r = first.startRequest({ agentId: "zcode", instanceId: MOTHER, model: "m1", stream: true, path: "openai" });
        r.recordEnd({ status: 200, usage: { prompt_tokens: 1 } });
        const card = await zcodeOf(first);
        assert.equal(card.instances[0].surface, "Desktop", "无 socket 属主 pid 也贴面");
        assert.deepEqual(card.surfaces, [{ surface: "desktop", label: "Desktop", count: 1 }], "卡头汇总同源");
        assert.equal(first.persistMetricsSnapshot(), true);
        const snap = JSON.parse(readFileSync(join(dir, METRICS_SNAPSHOT_FILENAME), "utf8"));
        assert.equal(snap.instances.zcode.find((row) => row.id === MOTHER).zcodeSurface, "desktop", "面字段随行落盘");
        const second = testCollector(opts());
        const restored = await zcodeOf(second);
        assert.equal(restored.instances.find((row) => row.id === MOTHER).surface, "Desktop",
          "重启恢复的行不必等下个请求才补回徽标");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
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

  it("ignores the resident managed app-server daemon: no count, no standby card", async () => {
    // The managed daemon (spawned under ~/.codex/packages/app-server-daemon on
    // first use, then resident forever) owns no session: a machine with only
    // these two codex.exe processes must read as codex not running at all.
    const mockExec = (cmd, opts, cb) => {
      const csv = "Node,CommandLine,Name,ProcessId\r\n" +
        "LAPTOP,C:\\Users\\tester\\.codex\\packages\\app-server-daemon\\releases\\0.162.1-x86_64-pc-windows-msvc\\bin\\codex.exe app-server --listen unix:// --analytics-default-enabled --managed-daemon,codex.exe,7101\r\n" +
        "LAPTOP,C:\\Users\\tester\\.codex\\packages\\app-server-daemon\\releases\\0.162.1-x86_64-pc-windows-msvc\\bin\\codex.exe daemon pid-update-loop,codex.exe,7102\r\n";
      cb(null, csv);
    };
    const collector = testCollector({ execFn: mockExec, nowFn: () => 10000 });

    const procs = await collector.scanProcesses();
    assert.equal(procs.codex, 0, "daemon rows never count toward the card");
    assert.equal(procs.codexPids.size, 0);
    assert.equal(procs.codexEnginePids.size, 0, "daemon never feeds the engine pid set");

    const codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.processCount, 0);
    assert.equal(codex.status, "stopped", "daemon alone must not read as running");
    assert.deepEqual(codex.instances, [], "daemon spawns no instance rows");
  });

  it("counts real Codex usage while a resident managed daemon is alive", async () => {
    // Daemon + GUI main + per-session app-server engine: only the latter two
    // count, and the engine pid set holds the session engine alone.
    const mockExec = (cmd, opts, cb) => {
      const csv = "Node,CommandLine,Name,ProcessId\r\n" +
        "LAPTOP,C:\\Users\\tester\\.codex\\packages\\app-server-daemon\\releases\\0.162.1-x86_64-pc-windows-msvc\\bin\\codex.exe app-server --listen unix:// --managed-daemon,codex.exe,7101\r\n" +
        "LAPTOP,C:\\Users\\tester\\.codex\\packages\\app-server-daemon\\releases\\0.162.1-x86_64-pc-windows-msvc\\bin\\codex.exe daemon pid-update-loop,codex.exe,7102\r\n" +
        "LAPTOP,C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0jr76e\\ChatGPT.exe,ChatGPT.exe,6200\r\n" +
        "LAPTOP,C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\7ac07f4ce733f89a\\codex.exe app-server,codex.exe,6100\r\n";
      cb(null, csv);
    };
    const collector = testCollector({ execFn: mockExec, nowFn: () => 3000 });

    const procs = await collector.scanProcesses();
    assert.equal(procs.codex, 2, "GUI main + session engine count; daemon rows excluded");
    assert.ok(procs.codexEnginePids.has(6100));
    assert.ok(!procs.codexEnginePids.has(7101), "daemon never enters the engine pid set");

    const codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.processCount, 2);
    assert.equal(codex.status, "running");
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
    const user = collector.startRequest({ agentId: "codex", providerId: "north-main", model: "kimi-k3", path: "openai" });
    user.recordEnd({ status: 200, usage: { prompt_tokens: 4, completion_tokens: 2 } });
    let codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.lastModel, "kimi-k3");
    assert.equal(codex.lastProvider, "north-main");

    // 后台请求带着硬编码模型飞来：进行中不占「正在生成」徽章，结束后也不
    // 改写「最近模型/渠道」——实机形态即卡片 lastModel 被标题生成线程改成
    // gpt-5.6-luna（2026-09-13 复发）。
    const bg = collector.startRequest({ agentId: "codex", providerId: "north-main", model: "gpt-5.6-luna", path: "openai", background: true });
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.currentModel, null, "后台请求进行中不占用「正在生成」徽章");
    assert.deepEqual(codex.activeModels, []);
    assert.deepEqual(codex.activeTargets, []);
    bg.recordEnd({ status: 200, usage: { prompt_tokens: 4, completion_tokens: 2 } });
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.lastModel, "kimi-k3", "后台请求不改写最近模型徽章");
    assert.equal(codex.lastProvider, "north-main");
    assert.equal(codex.metrics.totalRequests, 2, "流量照实计数");
  });

  it("background traffic feeds neither the TTFT display nor the TPS window", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, ""), nowFn });

    // 用户流量建立展示面基线：流式成功，TTFT 1200ms。
    const user = collector.startRequest({ agentId: "codex", providerId: "north-main", model: "kimi-k3", path: "openai", stream: true });
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
    const bg = collector.startRequest({ agentId: "codex", providerId: "north-main", model: "gpt-5.6-luna", path: "openai", stream: true, background: true });
    mockTime = 4300;
    bg.recordFirstChunk();
    mockTime = 4400;
    bg.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 500 } });
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.metrics.lastTtftMs, baselineTtft, "后台首 token 不改写 TTFT 展示");
    assert.equal(codex.metrics.tps, baselineTps, "后台 token 不进 TPS 样本窗");
    assert.equal(codex.metrics.tokens.completion, 550, "token 总量照实结算");

    // 后台非流式成功同理：全时长 TTFT 代理也不写展示面。
    const bgNonStream = collector.startRequest({ agentId: "codex", providerId: "north-main", model: "gpt-5.6-luna", path: "openai", background: true });
    mockTime = 4450;
    bgNonStream.recordEnd({ status: 200, usage: { prompt_tokens: 5, completion_tokens: 5 } });
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.metrics.lastTtftMs, baselineTtft);
  });

  it("background requests write no model-stability rows", async () => {
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, ""), nowFn: () => 3000 });

    // 硬编码后台模型的 404 若写入稳定性，会留下永不恢复的全红行（实机即
    // north-main/gpt-5.6-luna n=6 ok=0）。
    const bg = collector.startRequest({ agentId: "codex", providerId: "north-main", model: "gpt-5.6-luna", path: "openai", background: true });
    bg.recordEnd({ status: 404, error: { status: 404, message: "model not found" } });
    assert.deepEqual(collector.getModelStability().models, [], "后台 404 不留稳定性行");

    // 对照：用户流量的同样失败照常入列——隔离是定向的。
    const user = collector.startRequest({ agentId: "codex", providerId: "north-main", model: "gpt-5.6-luna", path: "openai" });
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

    // GUI app and every CLI exited: the session row clears once two consecutive
    // trusted rounds confirm it — a single empty round is not a verdict (the
    // probe can be truncated, a family can be mid-restart).
    familyAlive = false;
    t += 3000;
    // Reads never block on a rescan: first call serves stale + kicks the round.
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 30));
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.equal(codex.instances.length, 1, "单轮空白不收行");
    codex = (await collector.getAgentsStatus()).find((a) => a.id === "codex");
    assert.deepEqual(codex.instances, [], "连续两轮无家族即收行");
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
    assert.equal(status.length, 10, "panel now exposes 10 endpoint cards including workbuddy");
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

  it("routes grok traffic by x-agent-id and detects grok.exe", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => {
      const csv = `Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\Users\\tester\\.grok\\bin\\grok.exe,grok.exe,7400\r\n`;
      cb(null, csv);
    };
    const collector = testCollector({ execFn: mockExec, nowFn });
    const req = collector.startRequest({
      agentId: "grok",
      providerId: "poke-api",
      model: "grok-4",
    });
    mockTime = 2200;
    req.recordFirstChunk();
    mockTime = 3200;
    req.recordEnd({ usage: { prompt_tokens: 10, completion_tokens: 5 } });

    const status = await collector.getAgentsStatus();
    assert.equal(status.length, 10, "panel exposes 10 endpoint cards including workbuddy");
    const grok = status.find((a) => a.id === "grok");
    assert.ok(grok);
    assert.equal(grok.name, "Grok Build");
    assert.equal(grok.status, "running");
    assert.equal(grok.processCount, 1);
    assert.equal(grok.lastModel, "grok-4");
    assert.equal(grok.metrics.totalRequests, 1);
    assert.equal(grok.sessionMode, "aggregate");
    // grok.exe 每终端一进程：扫描到的 pid 立即出 kimi 同款占位实例行。
    assert.deepEqual(grok.instances.map((i) => i.id), ["grok-7400"]);
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.metrics.totalRequests, 0);
  });

  // 2026-10-24 修复面：grok 与 qoder-cli 同在 PROBE_VERSION_CLIENTS——环境检测
  // spawn `grok.exe --version` 探版本（秒退），不过滤同样把看板 grok 卡闪翻
  // 「运行中」。裸 --version 豁免、真实会话形照常计数。
  it("skips the grok version-probe row but still counts session-shaped invocations", async () => {
    const csv = [
      String.raw`7401,23332,grok.exe,C:\Users\tester\.grok\bin\grok.exe --version`,
      String.raw`7400,23332,grok.exe,C:\Users\tester\.grok\bin\grok.exe --resume 0198b8a6-7f5e-7f73-a1c2-9f4d5e6a7b8c`,
    ].join("\r\n") + "\r\n";
    const collector = testCollector({ execFn: (c, o, cb) => cb(null, csv), nowFn: () => 10000 });
    const procs = await collector.scanProcesses();
    assert.equal(procs.grok, 1, "探针行不计数，会话形调用照常");
    assert.ok(procs.grokPids.has(7400));
    assert.ok(!procs.grokPids.has(7401), "探针 pid 不进家族集（不起占位行、不翻卡）");
  });

  it("routes grok traffic by User-Agent header (grok-cli/<version>) if agentId is missing", async () => {
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn: mockExec, nowFn });

    const req = collector.startRequest({
      userAgent: "grok-cli/1.0.30",
      providerId: "poke-api",
      model: "grok-4",
    });
    mockTime = 2000;
    req.recordFirstChunk();
    mockTime = 3000;
    req.recordEnd({ usage: { prompt_tokens: 100, completion_tokens: 20 } });

    const status = await collector.getAgentsStatus();
    const grok = status.find((a) => a.id === "grok");
    const zcode = status.find((a) => a.id === "zcode");

    assert.equal(grok.metrics.totalRequests, 1);
    assert.equal(grok.lastModel, "grok-4");
    assert.equal(zcode.metrics.totalRequests, 0, "grok traffic must not fall back into the zcode bucket");
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
    assert.equal(status.length, 10, "claude aggregate bucket must not add a panel card");
    const zcode = status.find((a) => a.id === "zcode");
    assert.equal(zcode.metrics.totalRequests, 0, "claude traffic must not fall back into the zcode bucket");
    const claude = status.find((a) => a.id === "claude");
    assert.equal(claude.sessionMode, "per_instance", "the claude panel card uses the unified instance path");
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
    assert.equal(claude.sessionMode, "per_instance");
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
    const req = collector.startRequest({ agentId: "zcode", providerId: "sensenova", model: "kimi-k3" });
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

    const req = collector.startRequest({ agentId: "zcode", providerId: "sensenova", model: "kimi-k3" });
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

    const req = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "gemini-3.7-flash" });
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

    const req = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
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

    const bad = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
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

    const req = collector.startRequest({ agentId: "zcode", providerId: "sensenova", model: "kimi-k3" });
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
    const req = collector.startRequest({ agentId: "zcode", providerId: "chan-a", model: "auto", path: "openai" });
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

    const req = collector.startRequest({ agentId: "zcode", model: "auto", path: "anthropic" });
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

    const req = collector.startRequest({ agentId: "zcode", providerId: "test-pool", model: "gpt-pool" });
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

    const req = collector.startRequest({ agentId: "zcode", providerId: "chan-a", model: "auto", path: "openai" });
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

    const req = collector.startRequest({ agentId: "zcode", providerId: "chan-a", model: "auto", path: "openai" });
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
    const req = collector.startRequest({ agentId: "zcode", providerId: "chan-a", model: "auto", path: "openai" });
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
    const req = collector.startRequest({ agentId: "zcode", providerId: "chan-a", model: "auto", path: "openai" });
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

  it("链身份随归因透出（chainKey）：虚拟模型链的跳位也定位得到，直连不带", async () => {
    // 用户报障：dsh 走的是虚拟模型链 deepseek-v4.1-flash-mix，而胶囊位次原先只在
    // 「端点自己的链」里找——那条链里没有这个节点，位次永远算不出，悬停只剩半句。
    // relay 现在把服务它的那条链（虚拟模型名）随归因送上来，面板按它数位次。
    let mockTime = 1000;
    const collector = testCollector({ nowFn: () => mockTime, journal: fakeJournal() });

    const direct = collector.startRequest({ agentId: "dsh", providerId: "demo-pool", model: "glm-5.3", path: "openai" });
    let dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(dsh.activeTargets, [{ providerId: "demo-pool", model: "glm-5.3", count: 1, autoCount: 0 }],
      "直连条目不带链身份");
    assert.equal(dsh.lastChainKey, null);

    const chained = collector.startRequest({ agentId: "dsh", providerId: null, model: "deepseek-v4.1-flash-mix", path: "openai" });
    chained.setAttributeResolver((memberId) => (memberId === "sensenova/m1"
      ? { providerId: "sensenova", model: "deepseek-flash", chainKey: "deepseek-v4.1-flash-mix" }
      : null));
    chained.setCurrentMember("sensenova/m1");

    dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    const chainedEntry = dsh.activeTargets.find((t) => t.autoCount > 0);
    assert.equal(chainedEntry?.chainKey, "deepseek-v4.1-flash-mix", "链服务条目带上服务它的那条链");
    assert.equal(dsh.lastChainKey, "deepseek-v4.1-flash-mix", "最近模型的链身份与 lastModel 配对");
    assert.equal(dsh.lastModel, "deepseek-flash");

    chained.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
    direct.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
    dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(dsh.activeTargets, [], "全部结束后账本清空");
    assert.equal(dsh.lastChainKey, "deepseek-v4.1-flash-mix", "最近模型的链身份保留");
  });

  it("旧 relay 的归因没有 chainKey：不凭空造链身份（面板按旧口径退化）", async () => {
    let mockTime = 1000;
    const collector = testCollector({ nowFn: () => mockTime, journal: fakeJournal() });
    const req = collector.startRequest({ agentId: "kimi", providerId: null, model: "auto", path: "openai" });
    req.setAttributeResolver((memberId) => (memberId === "chan-a/m1"
      ? { providerId: "chan-a", model: "kimi-k3" }
      : null));
    req.setCurrentMember("chan-a/m1");

    const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.deepEqual(kimi.activeTargets, [{ providerId: "chan-a", model: "kimi-k3", count: 1, autoCount: 1 }],
      "没有链身份时条目不多出字段");
    assert.equal(kimi.lastChainKey, null);
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
    const req = collector.startRequest({ agentId: "zcode", providerId: "chan-d", model: "m9", path: "openai" });
    req.setCurrentMember("chan-d/member-1"); // member loop announces even without a resolver

    const zcode = (await collector.getAgentsStatus()).find((a) => a.id === "zcode");
    assert.deepEqual(zcode.activeTargets, [{ providerId: "chan-d", model: "m9", count: 1, autoCount: 0 }]);
    assert.equal(zcode.lastViaAuto, false);
  });

  it("mixed provenance on one pair: autoCount tracks chain-served requests only", async () => {
    let mockTime = 1000;
    const collector = testCollector({ nowFn: () => mockTime, journal: fakeJournal() });
    const direct = collector.startRequest({ agentId: "zcode", providerId: "chan-a", model: "shared-m", path: "openai" });
    const chained = collector.startRequest({ agentId: "zcode", providerId: "chan-a", model: "auto", path: "openai" });
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

  it("journal rows carry the canonical instanceId once the pid is set, and omit it before", async () => {
    // Terminal attribution binds a shell to `claude-<pid>` rows; the journal
    // row must carry that very key or a bound terminal can never see its own
    // requests. Before setClaudePid the reporter has no identity to claim —
    // the key stays absent rather than pointing at the wrong process.
    const pidSet = reporterHarness();
    pidSet.reporter.setClaudePid(4242);
    pidSet.reporter.startRequest({ model: "claude-opus-5", stream: false, path: "anthropic" });
    pidSet.tick(2000);
    pidSet.reporter.recordEnd({ status: 200, usage: { input_tokens: 8, output_tokens: 4 } });
    assert.equal(pidSet.lines.length, 1);
    assert.equal(pidSet.lines[0].instanceId, "claude-4242");

    const pidUnset = reporterHarness();
    pidUnset.reporter.startRequest({ model: "claude-opus-5", stream: false, path: "anthropic" });
    pidUnset.tick(2000);
    pidUnset.reporter.recordEnd({ status: 200, usage: { input_tokens: 8, output_tokens: 4 } });
    assert.equal(pidUnset.lines.length, 1);
    assert.ok(!("instanceId" in pidUnset.lines[0]), "no claimed identity before the pid is known");
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

    const req1 = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "gemini-3.7-flash" }); // interval opens at 1000
    mockTime = 2000;
    const req2 = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "gemini-3.7-flash" }); // overlaps
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

    collector.startRequest({ agentId: "zcode", providerId: "otter", model: "gemini-3.7-flash" });
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

    const req1 = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "gemini-3.7-flash" });
    mockTime = 3000;
    req1.recordEnd({});
    const req2 = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "gemini-3.7-flash" });
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
    const req = collector.startRequest({ agentId: "zcode", providerId: "acme-default", model: "claude-sonnet-4-6" });
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

    const reqA = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "model-A" });
    let status = await collector.getAgentsStatus();
    let zcode = status.find((a) => a.id === "zcode");
    assert.deepEqual(zcode.activeModels, ["model-A"]);
    assert.equal(zcode.currentModel, "model-A");

    // Start model B (user switched model)
    const reqB = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "model-B" });
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
    const req1 = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "model-1" });
    mockTime = 1500;
    req1.recordFirstChunk();
    mockTime = 2500;
    req1.recordEnd({ usage: { prompt_tokens: 100, completion_tokens: 40 } });

    // Request 2: 60 tokens generated over 1.0s -> 60.0 tok/s
    const req2 = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "model-2" });
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
    const req = collector.startRequest({ agentId: "zcode", providerId: "kestrel-default", model: "deepseek-v4.1-flash" });
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
    const req = collector.startRequest({ agentId: "zcode", providerId: "acme-default", model: "gemini-3.7-flash" });
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
    const zReq = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "claude-3-7-sonnet" });
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
    const r1 = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "claude-3-7-sonnet" });
    mockTime = 1500;
    r1.recordFirstChunk();
    mockTime = 2500;
    r1.recordEnd({ usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 500 } } });

    // Request 2: 1200ms TTFT, 100 tok/s, 80% cache hit
    mockTime = 3000;
    const r2 = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "claude-3-7-sonnet" });
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

  it("实例行折线按「折线视窗」设置收点：建行时取当前设置，设置改宽后已在列的行跟着变宽", async () => {
    // 折线视窗是「折线画几个请求」，不是端点的私产：同一份历史在端点卡和
    // 实例行上必须同宽，否则把视窗从默认 16 调大只在端点级看得出变化。
    // kimi 进程保持存活：本例每步隔 60s，零进程夹具会触发 run zeroing 把
    // 样本窗连同账一起清掉，视窗宽度就无从验证。
    let mockTime = 1000;
    const nowFn = () => mockTime;
    const mockExec = (cmd, opts, cb) =>
      cb(null, "Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\kimi\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs,node.exe,12345\r\n");
    let diskWindow = 20;
    const collector = testCollector({
      execFn: mockExec,
      nowFn,
      sparkWindowPoints: 20,
      loadSparkSettings: () => ({ sparkWindowPoints: diskWindow }),
    });
    const issue = (n) => {
      for (let i = 0; i < n; i++) {
        const r = collector.startRequest({ agentId: "kimi", instanceId: "ws-a", providerId: "p1", model: "m1", stream: true, path: "openai" });
        mockTime += 500;
        r.recordFirstChunk();
        mockTime += 1000;
        r.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 50 } });
        mockTime += 60_000;
      }
    };

    issue(20);
    const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.equal(kimi.metrics.sparkHistory.ttft.length, 20, "端点级按设置收满 20 点");
    assert.equal(kimi.instances[0].sparkHistory.ttft.length, 20, "实例行与端点级同宽");
    assert.equal(kimi.instances[0].sparkHistory.tps.length, 20);
    assert.equal(kimi.instances[0].sparkHistory.cache.length, 20);

    // 面板把视窗调宽：环里已有的历史必须一起交给折线，而不是等新请求从头攒。
    diskWindow = 24;
    const wider = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.equal(wider.metrics.sparkHistory.ttft.length, 20, "环里只有 20 个样本");
    assert.equal(wider.instances[0].sparkHistory.ttft.length, 20, "实例行同样给到环里的全部样本");
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
    assert.equal(sessionRow.cacheHitRate, 0, "the newest request's own ratio: 0 / 80");
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
      const r = collector.startRequest({ agentId: "zcode", providerId: "otter", model: "glm-5.3" });
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

describe("DSH surfaces: harness process vs TUI launcher shell", () => {
  // Command lines as they really appear on Windows for the npm-form install:
  // `dst` runs the global copy's bin\dsh-tui.js, which delegates to the profile
  // copy's bin\dsh-tui.js, which spawns `dsh --profile dsh-tui` (the npm dsh.cmd
  // shim resolves to node + @deepseek-ai/dsh/lib/bin.js). All three are
  // node.exe rows and all three carry a "bin\dsh" substring, which is why the
  // card used to read 3 DSH processes per terminal.
  const DSH_BIN = "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
  const TUI_LAUNCHERS = [
    "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@deepseek-harness-tui\\dsh-tui\\bin\\dsh-tui.js",
    "C:\\Users\\tester\\.dsh\\profiles\\dsh-tui\\node_modules\\@deepseek-harness-tui\\dsh-tui\\bin\\dsh-tui.js",
  ];
  const nodeRow = (pid, commandLine) => `LAPTOP,"C:\\Program Files\\nodejs\\node.exe" ${commandLine},node.exe,${pid}`;
  // 5 列形态（带 ParentProcessId）：dsh 0.2.0 的委托宿主判定只认父进程列——
  // 宿主与引擎的命令行逐字相同，4 列形态下两者无从分辨。
  const nodeRow5 = (pid, ppid, commandLine) => `LAPTOP,"C:\\Program Files\\nodejs\\node.exe" ${commandLine},node.exe,${ppid},${pid}`;
  const launcherRow = (pid, idx) => nodeRow(pid, `"${TUI_LAUNCHERS[idx]}"`);
  const harnessRow = (pid, args) => nodeRow(pid, `"${DSH_BIN}" ${args}`);
  // The official desktop package: image `DeepSeek Harness.exe`. The shell row
  // runs the app itself; the host child runs the same image with the bundled
  // host script — that child is what boots the `desktop` profile.
  const DESKTOP_EXE = "C:\\Users\\tester\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe";
  const DESKTOP_HOST = "C:\\Users\\tester\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js";
  const desktopShellRow = (pid, args) => `LAPTOP,"${DESKTOP_EXE}"${args ? ` ${args}` : ""},DeepSeek Harness.exe,${pid}`;
  const desktopHostRow = (pid) => `LAPTOP,"${DESKTOP_EXE}" --expose-internals "${DESKTOP_HOST}",DeepSeek Harness.exe,${pid}`;
  // 常驻探针的真实形状带父进程列（壳锚判据的生产输入）：壳行与宿主行各带
  // ParentProcessId。
  const wmic5 = (...rows) => `Node,CommandLine,Name,ParentProcessId,ProcessId\r\n${rows.join("\r\n")}\r\n`;
  const desktopShellRow5 = (pid, ppid) => `LAPTOP,"${DESKTOP_EXE}",DeepSeek Harness.exe,${ppid},${pid}`;
  const desktopHostRow5 = (pid, ppid) => `LAPTOP,"${DESKTOP_EXE}" --expose-internals "${DESKTOP_HOST}",DeepSeek Harness.exe,${ppid},${pid}`;
  const wmic = (...rows) => `Node,CommandLine,Name,ProcessId\r\n${rows.join("\r\n")}\r\n`;
  const surfacesOf = (agent) => Object.fromEntries(agent.surfaces.map((s) => [s.label, s.count]));

  it("counts one npm-form TUI launch as one DSH process instead of three", async () => {
    const execFn = (cmd, opts, cb) => cb(null, wmic(
      launcherRow(4100, 0),
      launcherRow(4101, 1),
      harnessRow(4102, "--profile dsh-tui"),
    ));
    const collector = testCollector({ execFn, nowFn: () => 3000 });

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.equal(dsh.processCount, 1, "两个启动器壳不算会话进程");
    assert.equal(dsh.status, "running");
    assert.deepEqual(surfacesOf(dsh), { TUI: 1 });
    assert.deepEqual(dsh.instances.map((i) => i.id), ["dsh-4102"], "只有引擎进程出行");
    assert.equal(dsh.instances[0].surface, "TUI");
  });

  it("folds the 0.2.0 command-line-identical delegation host into its engine child", async () => {
    // dsh 0.2.0 起 `dsh --profile <name>` 的宿主把引擎作为子进程再拉起一遍，
    // 命令行与宿主逐字相同（面板一键启动 75056a6 落的就是这条形态）。命令行
    // 谓词分不出两者，父进程列能：宿主折出引擎集后，卡上 1 进程、副行 TUI ×1、
    // 占位行只有引擎子进程一条，终端归属面也只报子进程——「绑最近引擎」从此
    // 绑到真正持流量的那一行，而不是 0 请求的宿主（2026-10-17 幽灵行根因）。
    const execFn = (cmd, opts, cb) => cb(null, wmic5(
      nodeRow5(5100, 99, `"${DSH_BIN}" --profile dsh-tui`),
      nodeRow5(5101, 5100, `"${DSH_BIN}" --profile dsh-tui`),
    ));
    const collector = testCollector({ execFn, nowFn: () => 3000 });

    const procs = await collector.scanProcesses();
    assert.equal(procs.dsh, 1, "委托宿主不算会话进程");
    assert.equal(procs.dshPids.has(5100), true, "宿主留在家族集保活性");
    assert.equal(procs.dshEnginePids.has(5100), false, "宿主折出引擎集");
    assert.equal(procs.dshEnginePids.has(5101), true);

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.equal(dsh.processCount, 1);
    assert.deepEqual(surfacesOf(dsh), { TUI: 1 });
    assert.deepEqual(dsh.instances.map((i) => i.id), ["dsh-5101"], "只有引擎子进程出行");
    assert.equal(dsh.instances[0].surface, "TUI");

    const dshFeed = collector.getDetectedClientProcesses().filter((p) => p.agentId === "dsh");
    assert.equal(dshFeed.length, 1, "终端归属面只报引擎子进程");
    const { busy, ...dshRest } = dshFeed[0];
    assert.deepEqual(dshRest, { agentId: "dsh", pid: 5101, ancestors: [5100, 99] });
    assert.equal(busy, false, "这张夹具里引擎底下没有活命令");
  });

  it("collapses a delegation chain of any depth and carries the host's profile down", async () => {
    // 三层链一次折到底；子进程命令行读不出 profile 时（引擎经 env 转发而非
    // 重传旗标），由宿主读出的传下去——徽标与副行都读子进程。
    const execFn = (cmd, opts, cb) => cb(null, wmic5(
      nodeRow5(5200, 99, `"${DSH_BIN}" --profile dsh-tui`),
      nodeRow5(5201, 5200, `"${DSH_BIN}" --profile dsh-tui`),
      nodeRow5(5202, 5201, `"${DSH_BIN}"`),
    ));
    const collector = testCollector({ execFn, nowFn: () => 3000 });

    const procs = await collector.scanProcesses();
    assert.equal(procs.dsh, 1, "三层链折到最深一个");
    assert.deepEqual([...procs.dshEnginePids], [5202]);
    assert.equal(procs.dshProfileByPid.get(5202), "dsh-tui", "宿主的 profile 传给读不出的子进程");
    assert.equal(procs.dshProfileByPid.has(5200), false, "宿主的映射随宿主折出");

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.equal(dsh.processCount, 1);
    assert.deepEqual(surfacesOf(dsh), { TUI: 1 });
    assert.deepEqual(dsh.instances.map((i) => i.id), ["dsh-5202"]);
  });

  it("keeps the desktop host out of the fold: its stable row is anchored on the host pid", async () => {
    // 桌面宿主行的身份按设计锚在宿主 pid 上（resolveInstanceId 折 DSH_DESKTOP_
    // INSTANCE_ID），即便它也是某个引擎进程的父进程也不折——豁免判据用
    // dshDesktopHostPids 集合，与 CLI 自建同名 profile 无关。
    const execFn = (cmd, opts, cb) => cb(null, wmic5(
      desktopShellRow5(5300, 99),
      desktopHostRow5(5301, 5300),
      nodeRow5(5302, 5301, `"${DSH_BIN}" --profile desktop`),
    ));
    const collector = testCollector({ execFn, nowFn: () => 3000 });

    const procs = await collector.scanProcesses();
    assert.equal(procs.dshDesktopHostPids.has(5301), true, "桌面宿主不被折出");
    assert.equal(procs.dshEnginePids.has(5301), true);

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(dsh.instances.map((i) => i.id).sort(), ["dsh-5302", "dsh-desktop"],
      "宿主持稳定行，引擎子进程照常逐 pid");
  });

  it("labels every profile its own name and adds up to the process count", async () => {
    const execFn = (cmd, opts, cb) => cb(null, wmic(
      harnessRow(4200, "web --port 3080"),
      harnessRow(4201, "--profile dsh-tui"),
      harnessRow(4202, "--profile mydesk"),
      launcherRow(4203, 0),
    ));
    const collector = testCollector({ execFn, nowFn: () => 3000 });

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.equal(dsh.processCount, 3);
    // 排序按 profile 名，读不出profile的落最后。
    assert.deepEqual(dsh.surfaces, [
      { profile: "dsh-tui", label: "TUI", count: 1 },
      { profile: "mydesk", label: "mydesk", count: 1 },
      { profile: "web", label: "Web", count: 1 },
    ]);
    assert.deepEqual(dsh.instances.map((i) => [i.id, i.surface]), [
      ["dsh-4200", "Web"],
      ["dsh-4201", "TUI"],
      ["dsh-4202", "mydesk"],
    ]);
  });

  it("keeps CLI management invocations out of the session count", async () => {
    // `dsh plugin --profile x add <pkg>` forwards to pnpm and `--dump-config`
    // prints and exits: both run the harness entry file, neither boots a session.
    const execFn = (cmd, opts, cb) => cb(null, wmic(
      harnessRow(4300, "plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui"),
      harnessRow(4301, "--profile web --dump-config"),
    ));
    const collector = testCollector({ execFn, nowFn: () => 3000 });

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.equal(dsh.processCount, 0);
    assert.deepEqual(dsh.instances, []);
    assert.deepEqual(dsh.surfaces, []);
    assert.equal(dsh.status, "stopped");
  });

  it("counts the dsh.exe packaging as a session process and still reads its profile", async () => {
    // The pip packaging installs Scripts\dsh.exe, so the image-name branch owns
    // these rows (accept-by-name stays authoritative — a command line is a
    // bonus used only for the surface label).
    const execFn = (cmd, opts, cb) => cb(null,
      "Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\Tools\\Python311\\Scripts\\dsh.exe --profile web,dsh.exe,4400\r\n");
    const collector = testCollector({ execFn, nowFn: () => 3000 });

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.equal(dsh.processCount, 1);
    assert.deepEqual(surfacesOf(dsh), { Web: 1 });
  });

  it("degrades to an unlabeled surface instead of guessing when no profile is readable", async () => {
    // plain-tasklist-shaped rows carry no command line at all.
    const execFn = (cmd, opts, cb) => cb(null, '"dsh.exe","4500","Console","1"\r\n"dsh.exe","4501","Console","1"\r\n');
    const collector = testCollector({ execFn, nowFn: () => 3000 });

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.equal(dsh.processCount, 2);
    assert.deepEqual(dsh.surfaces, [{ profile: null, label: "未知", count: 2 }]);
    assert.equal("surface" in dsh.instances[0], false, "读不出面就不贴标签");
  });

  it("evicts a DSH row by its own pid and leaves the launcher shells unlisted", async () => {
    let t = 3000;
    let terminalOpen = true;
    const execFn = (cmd, opts, cb) => cb(null, terminalOpen
      ? wmic(launcherRow(4600, 0), launcherRow(4601, 1), harnessRow(4602, "--profile dsh-tui"))
      : wmic(harnessRow(4700, "--profile web")));
    const collector = testCollector({ execFn, nowFn: () => t });

    let dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(dsh.instances.map((i) => i.id), ["dsh-4602"]);

    // The TUI terminal closes (all three of its processes go) while a web
    // process starts. Reconciling against the engine set means the row drops
    // immediately; the shells were never in the list to begin with.
    terminalOpen = false;
    t += 3000;
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 20));
    dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(dsh.instances.map((i) => [i.id, i.surface]), [["dsh-4700", "Web"]]);
    assert.equal(dsh.processCount, 1);
  });

  it("counts the DSH desktop app's host child as one Desktop session, and its shell not at all", async () => {
    // The official Electron package: `DeepSeek Harness.exe` spawns the same
    // image again with --expose-internals pointing at its bundled host, and
    // THAT child boots profile `desktop`. Neither the image name (dsh.exe is
    // the pip packaging, a different product) nor the engine signature
    // (…\dsh\lib\bin.js) matches either row, so the desktop used to be absent
    // from the card entirely — no process, no subline entry, no instance row.
    // The shell must stay out of the count: counting by image name would read
    // one boot as two sessions.
    const execFn = (cmd, opts, cb) => cb(null, wmic(
      desktopShellRow(4800, ""),
      desktopShellRow(4801, "--type=renderer"),
      desktopHostRow(4802),
    ));
    const collector = testCollector({ execFn, nowFn: () => 3000 });

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.equal(dsh.status, "running");
    assert.equal(dsh.processCount, 1, "只有承载会话的宿主进程计数，桌面壳与渲染进程都不算");
    assert.deepEqual(surfacesOf(dsh), { Desktop: 1 });
    // 行 id 是面级稳定行（dsh-desktop），不是宿主 pid——引擎换代不再换行。
    assert.deepEqual(dsh.instances.map((i) => [i.id, i.surface]), [["dsh-desktop", "Desktop"]]);
  });

  it("accepts the desktop host on the 3-column probe shape, where the image is argv[0]", async () => {
    // The legacy probe dump has no Name field: the row is
    // Node,CommandLine,ProcessId and the image is the command line's leading
    // token — which for the desktop app contains a space.
    const execFn = (cmd, opts, cb) => cb(null,
      `Node,CommandLine,ProcessId\r\nLAPTOP,"C:\\Users\\tester\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe" --expose-internals "C:\\Users\\tester\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js",4900\r\n`);
    const collector = testCollector({ execFn, nowFn: () => 3000 });

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.equal(dsh.processCount, 1);
    assert.deepEqual(surfacesOf(dsh), { Desktop: 1 });
  });

  it("does not relabel a user's own `desktop` profile as the desktop app", async () => {
    // A CLI boot of a profile that happens to be named `desktop` is still a
    // command-line session; only the bundled host child is the app.
    const execFn = (cmd, opts, cb) => cb(null, wmic(
      harnessRow(4850, "--profile desktop"),
      desktopShellRow(4851, ""),
    ));
    const collector = testCollector({ execFn, nowFn: () => 3000 });

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.equal(dsh.processCount, 1, "桌面壳这一行不计数");
    assert.deepEqual(dsh.instances.map((i) => [i.id, i.surface]), [["dsh-4850", "Desktop"]]);
  });

  it("adds the desktop surface to a mixed set and keeps the subline summing to the count", async () => {
    const execFn = (cmd, opts, cb) => cb(null, wmic(
      harnessRow(4860, "web --port 3080"),
      harnessRow(4861, "--profile dsh-tui"),
      desktopHostRow(4862),
    ));
    const collector = testCollector({ execFn, nowFn: () => 3000 });

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.equal(dsh.processCount, 3);
    assert.deepEqual(dsh.surfaces, [
      { profile: "desktop", label: "Desktop", count: 1 },
      { profile: "dsh-tui", label: "TUI", count: 1 },
      { profile: "web", label: "Web", count: 1 },
    ]);
    assert.deepEqual(dsh.instances.map((i) => [i.id, i.surface]).sort(), [
      ["dsh-4860", "Web"],
      ["dsh-4861", "TUI"],
      ["dsh-desktop", "Desktop"],
    ]);
  });

  it("keeps one desktop row across engine generations so churn no longer resets it", async () => {
    // 用量日志实证（2026-10-04）：桌面 App 的宿主引擎一天换代 11 次，逐 pid
    // 行每次换代连请求计数带 sparkHistory 一起清零，看板切回前台只能从零慢
    // 慢重画。稳定行以面为键：换代只是换 pid，行不换。
    let t = 3000;
    let hostPid = 4910;
    const execFn = (cmd, opts, cb) => cb(null, wmic(desktopHostRow(hostPid)));
    const collector = testCollector({ execFn, nowFn: () => t });
    await collector.scanProcesses(); // warm the cache — the panel-open steady state

    const r1 = collector.startRequest({ agentId: "dsh", instanceId: `dsh-${hostPid}`, model: "m1", stream: true, path: "openai" });
    r1.recordFirstChunk();
    r1.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 40 } });

    // The desktop app recycles its engine. The panel's poll refreshes the scan
    // before the next request (two-step read: first serves stale and kicks the
    // round, second serves what landed).
    hostPid = 4911;
    t += 3000;
    await collector.getAgentsStatus();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const r2 = collector.startRequest({ agentId: "dsh", instanceId: `dsh-${hostPid}`, model: "m1", stream: true, path: "openai" });
    r2.recordFirstChunk();
    r2.recordEnd({ status: 200, usage: { prompt_tokens: 50, completion_tokens: 20 } });

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(dsh.instances.map((i) => [i.id, i.surface]), [["dsh-desktop", "Desktop"]]);
    assert.equal(dsh.instances[0].requests, 2, "both engine generations land on the same row");
    assert.equal(dsh.instances[0].tokens.prompt, 150);
  });

  it("folds desktop-host traffic onto the stable row while TUI traffic keeps its pid row", async () => {
    const execFn = (cmd, opts, cb) => cb(null, wmic(
      harnessRow(4920, "--profile dsh-tui"),
      desktopHostRow(4921),
    ));
    const collector = testCollector({ execFn, nowFn: () => 3000 });
    await collector.scanProcesses();

    const tui = collector.startRequest({ agentId: "dsh", instanceId: "dsh-4920", model: "m1", stream: true, path: "openai" });
    tui.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 4 } });
    const desktop = collector.startRequest({ agentId: "dsh", instanceId: "dsh-4921", model: "m1", stream: true, path: "openai" });
    desktop.recordEnd({ status: 200, usage: { prompt_tokens: 20, completion_tokens: 8 } });

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(dsh.instances.map((i) => [i.id, i.surface]).sort(), [
      ["dsh-4920", "TUI"],
      ["dsh-desktop", "Desktop"],
    ]);
  });

  it("does not fold a CLI boot of a profile named desktop onto the stable row", async () => {
    // 折叠判据是宿主集合（HOST_RE 命中的行），不是 profile 名：同名 CLI 会话
    // 仍按逐 pid 行记账。与扫描侧的同名 profile 测试互为表里，这里钉的是请
    // 求归一面。
    const execFn = (cmd, opts, cb) => cb(null, wmic(harnessRow(4930, "--profile desktop")));
    const collector = testCollector({ execFn, nowFn: () => 3000 });
    await collector.scanProcesses();
    const r = collector.startRequest({ agentId: "dsh", instanceId: "dsh-4930", model: "m1", stream: true, path: "openai" });
    r.recordEnd({ status: 200, usage: { prompt_tokens: 5, completion_tokens: 2 } });

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(dsh.instances.map((i) => [i.id, i.surface]), [["dsh-4930", "Desktop"]]);
  });

  it("keeps the idle desktop row while the app runs and retires it with the app", async () => {
    // 稳定行无 pid 可对账：宿主活着就与逐 pid 行同权常驻（空闲不清行）；
    // 宿主退场当轮收行，与空闲时长无关——下面故意在刚发生请求（行不空闲）
    // 时退场，钉住「死即收、不等任何 TTL」。此夹具无父进程列（降级形状），
    // 壳锚缺席时家族判据退化为宿主集合，空轮即死。
    let t = 3000;
    let hostAlive = true;
    const execFn = (cmd, opts, cb) => cb(null, hostAlive ? wmic(desktopHostRow(4940)) : wmic());
    const collector = testCollector({ execFn, nowFn: () => t });
    await collector.scanProcesses();
    const r = collector.startRequest({ agentId: "dsh", instanceId: "dsh-4940", model: "m1", stream: true, path: "openai" });
    r.recordEnd({ status: 200, usage: { prompt_tokens: 8, completion_tokens: 3 } });

    t += 20 * 60 * 1000; // far past the old 10-minute idle TTL
    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(dsh.instances.map((i) => i.id), ["dsh-desktop"], "an idle row survives while the desktop app runs");

    const r2 = collector.startRequest({ agentId: "dsh", instanceId: "dsh-4940", model: "m1", stream: true, path: "openai" });
    r2.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });

    // 读驱动的重扫在微任务里落地，且可能横跨下一次读：「读→等→读」两步不足以
    // 保证服务到的快照是宿主退场后的那一轮（后台在途轮会先于读者落不了地）。
    // 每轮都把时钟推过缓存窗口再等一拍，直到某轮读到空扫描、行被收掉为止。
    hostAlive = false;
    t += 3000;
    let gone = null;
    for (let round = 0; round < 25 && gone === null; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      t += 3000; // past the cache window so this read serves the last landed scan
      const c = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
      if (c.instances.length === 0) gone = c;
    }
    assert.ok(gone !== null, "the row retires with the app");
    assert.equal(gone.status, "stopped");
  });

  it("keeps one account across engine generations when the Electron shell anchors them", async () => {
    // 生产形状（常驻探针带父进程列）：两个宿主引擎同父（同一个壳）= 同一次
    // App 运行，换代续账。壳镜像本来就在探针查询名单里，父锚可对账。
    let t = 3000;
    let hostPid = 4910;
    const execFn = (cmd, opts, cb) => cb(null, wmic5(
      desktopShellRow5(4900, 100),
      desktopHostRow5(hostPid, 4900),
    ));
    const collector = testCollector({ execFn, nowFn: () => t });
    await collector.scanProcesses();

    const r1 = collector.startRequest({ agentId: "dsh", instanceId: `dsh-${hostPid}`, model: "m1", stream: true, path: "openai" });
    r1.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 40 } });

    hostPid = 4911;
    t += 3000;
    await collector.getAgentsStatus();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const r2 = collector.startRequest({ agentId: "dsh", instanceId: `dsh-${hostPid}`, model: "m1", stream: true, path: "openai" });
    r2.recordEnd({ status: 200, usage: { prompt_tokens: 50, completion_tokens: 20 } });

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(dsh.instances.map((i) => [i.id, i.surface]), [["dsh-desktop", "Desktop"]]);
    assert.equal(dsh.instances[0].requests, 2, "same shell = same app run = one account");
    assert.equal(dsh.instances[0].tokens.prompt, 150);
  });

  it("reopens the account when the desktop app restarts (new shell), no idle wait", async () => {
    // 真重启 = 壳换了且旧壳全灭：新代请求重开账，秒级重启也不等任何 TTL。
    let t = 3000;
    let shellPid = 4900;
    let hostPid = 4910;
    const execFn = (cmd, opts, cb) => cb(null, wmic5(
      desktopShellRow5(shellPid, 100),
      desktopHostRow5(hostPid, shellPid),
    ));
    const collector = testCollector({ execFn, nowFn: () => t });
    await collector.scanProcesses();

    const r1 = collector.startRequest({ agentId: "dsh", instanceId: `dsh-${hostPid}`, model: "m1", stream: true, path: "openai" });
    r1.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 40 } });

    shellPid = 4901;
    hostPid = 4920;
    t += 3000;
    await collector.getAgentsStatus();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const r2 = collector.startRequest({ agentId: "dsh", instanceId: `dsh-${hostPid}`, model: "m1", stream: true, path: "openai" });
    r2.recordEnd({ status: 200, usage: { prompt_tokens: 50, completion_tokens: 20 } });

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(dsh.instances.map((i) => [i.id, i.surface]), [["dsh-desktop", "Desktop"]], "the row itself survives the restart");
    assert.equal(dsh.instances[0].requests, 1, "a new app run reopens the account");
    assert.equal(dsh.instances[0].tokens.prompt, 50, "the previous run's tokens do not carry over");
  });

  it("keeps the row and account through an engine gap while the shell stays up", async () => {
    // 引擎换代空档（旧宿主已死、新宿主未起）里壳还在 = App 开着：行常驻、
    // 账目保留，空闲时长无关（这里推 20 分钟，远超旧实现 10 分钟的误洗线）。
    let t = 3000;
    let hostUp = true;
    let hostPid = 4910;
    const execFn = (cmd, opts, cb) => cb(null, hostUp
      ? wmic5(desktopShellRow5(4900, 100), desktopHostRow5(hostPid, 4900))
      : wmic5(desktopShellRow5(4900, 100)));
    const collector = testCollector({ execFn, nowFn: () => t });
    await collector.scanProcesses();

    const r1 = collector.startRequest({ agentId: "dsh", instanceId: `dsh-${hostPid}`, model: "m1", stream: true, path: "openai" });
    r1.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 40 } });

    hostUp = false;
    t += 20 * 60 * 1000;
    await collector.getAgentsStatus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const mid = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(mid.instances.map((i) => i.id), ["dsh-desktop"], "the seat survives the engine gap");
    assert.equal(mid.instances[0].requests, 1, "the account is untouched by the gap");

    hostUp = true;
    hostPid = 4911;
    t += 3000;
    // scanProcesses 是「陈旧即回、后台刷新」语义：踢出的轮（含 reap 的控制台
    // 查询延迟）未必在下一个微任务前落地。轮询到缓存真正看到新宿主再发请求，
    // 不赌落地时机。
    for (let tries = 0; tries < 10; tries += 1) {
      const procs = await collector.scanProcesses();
      if (procs.dshDesktopHostPids.has(4911)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const r2 = collector.startRequest({ agentId: "dsh", instanceId: `dsh-${hostPid}`, model: "m1", stream: true, path: "openai" });
    r2.recordEnd({ status: 200, usage: { prompt_tokens: 50, completion_tokens: 20 } });
    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.equal(dsh.instances[0].requests, 2, "the next engine generation continues the account");
  });

  it("refolds a request that landed before the scan saw the host onto the stable row", async () => {
    // 请求路径只读扫描缓存、从不触发扫描：宿主刚换代、缓存还没赶上时，请
    // 求先落在原始 pid 行上；缓存跟上后的下一轮读重折叠归位，计数随行保留。
    let t = 3000;
    let hostUp = false;
    const execFn = (cmd, opts, cb) => cb(null, hostUp ? wmic(desktopHostRow(4950)) : "Node,CommandLine,Name,ProcessId\r\n");
    const collector = testCollector({ execFn, nowFn: () => t });
    const r = collector.startRequest({ agentId: "dsh", instanceId: "dsh-4950", model: "m1", stream: true, path: "openai" });
    r.recordEnd({ status: 200, usage: { prompt_tokens: 30, completion_tokens: 12 } });

    hostUp = true;
    t += 3000;
    await collector.scanProcesses();
    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(dsh.instances.map((i) => [i.id, i.surface]), [["dsh-desktop", "Desktop"]], "the cold pid row folds onto the stable row");
    assert.equal(dsh.instances[0].requests, 1);
    assert.equal(dsh.instances[0].tokens.prompt, 30);
  });

  it("folds a cold-cache desktop host row into the stable row at the display exit", async () => {
    // 稳定占位行先在桶里，宿主换代后首笔在途请求因冷缓存落在原始 pid 行上：
    // 二者同指一个桌面宿主，出口只能吐一行；在途计数与面汇总一起对齐，
    // 请求收尾后由既有重折叠并账，账目不丢。
    let t = 3000;
    let hostPid = 4910;
    const execFn = (cmd, opts, cb) => cb(null, wmic(desktopHostRow(hostPid)));
    const collector = testCollector({ execFn, nowFn: () => t });
    const before = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(before.instances.map((i) => i.id), ["dsh-desktop"], "占位稳定行先在桶里");

    hostPid = 4950;
    t += 3000;
    const r = collector.startRequest({ agentId: "dsh", instanceId: `dsh-${hostPid}`, model: "m1", stream: true, path: "openai" });
    // 请求侧此时读到的仍是旧宿主缓存，落成原始 dsh-<pid> 行；读侧要等扫描
    // 缓存真正看到新宿主才能重折叠。scanProcesses 是「陈旧即回、后台刷新」语义，
    // 轮询到新宿主落地再读，不赌后台线程的落地时机。
    for (let tries = 0; tries < 10; tries += 1) {
      const procs = await collector.scanProcesses();
      if (procs.dshDesktopHostPids.has(4950)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // 刻意不 recordEnd：在途闸拦住重折叠并账，双行帧才成立。
    const mid = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(mid.instances.map((i) => i.id), ["dsh-desktop"], "冷缓存 pid 行与稳定行同指宿主，出口只吐一行");
    assert.equal(mid.instances[0].activeRequests, 1, "在途请求随稳定行呈现");
    assert.deepEqual(mid.surfaces, [{ profile: "desktop", label: "Desktop", count: 1 }], "面汇总与出口行数一致");

    r.recordEnd({ status: 200, usage: { prompt_tokens: 30, completion_tokens: 12 } });
    const after = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(after.instances.map((i) => i.id), ["dsh-desktop"], "收敛后仍只有稳定行");
    assert.equal(after.instances[0].requests, 1, "并账计数不丢");
    assert.equal(after.instances[0].tokens.prompt, 30, "样本随账归位");
  });

  it("asks the resident probe for the whole process table, not a name-filtered one", async () => {
    // 行的第一道门是探针的查询范围：2026-10-28 起查询不带镜像名白名单，因为
    // 「锚 pid 之下有没有活命令」要的全表——白名单一滤，agent 跑的命令子进程
    // （ping.exe / npm / python…）就全消失了，只剩一串没有命令行的空壳。
    // 这条把「无白名单」钉住，防止谁为了省几行把 name= 条件加回来。
    const seen = [];
    const spawnFn = () => {
      const child = new EventEmitter();
      const stdout = new EventEmitter();
      stdout.setEncoding = () => {};
      const stderr = new EventEmitter();
      stderr.resume = () => {};
      child.stdin = {
        write: (text) => {
          seen.push(text);
          const marker = (text.match(/Write-Output '([^']+)'/) ?? [])[1] ?? "";
          stdout.emit("data", `__unused__${marker}\r\n`);
        },
      };
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => child.emit("exit", 0);
      child.unref = () => {};
      return child;
    };
    const collector = testCollector({ nowFn: () => 3000, spawnFn, execFn: (cmd, opts, cb) => cb(null, "Node,CommandLine,Name,ProcessId\r\n") });
    await collector.getAgentsStatus();
    assert.ok(seen.length > 0, "探针被问过");
    assert.ok(seen[0].includes("Get-CimInstance Win32_Process"), `常驻查询要枚举全表，实际：${seen[0].slice(0, 200)}`);
    assert.ok(!seen[0].includes("-Filter"), "查询不再带镜像名白名单：桌面端与命令子进程都靠全表");
  });

  it("keeps the fire-and-forget desktop shell out of the process count", async () => {
    // The shell alone (no host child yet, e.g. while it is starting) is not a
    // session: the card must stay dark until the process that boots a profile
    // exists.
    const execFn = (cmd, opts, cb) => cb(null, wmic(desktopShellRow(4900, "")));
    const collector = testCollector({ execFn, nowFn: () => 3000 });

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.equal(dsh.processCount, 0);
    assert.equal(dsh.status, "stopped");
    assert.deepEqual(dsh.instances, []);
  });

  it("folds a launcher-tailed instance id against the engine pid, not the shell", () => {
    // The dsh launcher never injects an instance header; this pins the shared
    // rule anyway, so a future injection cannot fold onto a shell pid.
    const scan = {
      dshPids: new Set([4100, 4101, 4102]),
      dshEnginePids: new Set([4102]),
      ppidByPid: new Map([[4101, 4100], [4102, 4101]]),
    };
    assert.deepEqual(normalizeInstanceId("dsh", "proj-4100", scan), { id: "dsh-4102", label: "proj" });
    assert.deepEqual(normalizeInstanceId("dsh", "proj-4101", scan), { id: "dsh-4102", label: "proj" });
  });

  it("dshProfileNameFrom reads the flag forms DSH accepts and nothing else", () => {
    assert.equal(dshProfileNameFrom(`"${DSH_BIN}" --profile web`), "web");
    assert.equal(dshProfileNameFrom(`"${DSH_BIN}" --profile=DeepSeek-Web`), "DeepSeek-Web", "大小写按用户命名保留");
    assert.equal(dshProfileNameFrom(`"${DSH_BIN}" --profile "quoted name"`), null, "带空格的名字不是 profile 目录名");
    assert.equal(dshProfileNameFrom(`"${DSH_BIN}" --profile ./relative-path`), null, "路径值不当 profile 名读");
    assert.equal(dshProfileNameFrom(`"${DSH_BIN}" web --no-open`), "web", "web 子命令是 --profile web 的别名");
    assert.equal(dshProfileNameFrom(`"${DSH_BIN}" --resume abc`), null);
    assert.equal(dshProfileNameFrom(null), null);
  });

  // spawnFn that answers the process scan with `scanRows` and the console
  // probe with the queued `consoleAnswers` (one per round, consumed in
  // order), telling the two apart by the AttachErr marker in the query text.
  // Same child shape as makeShimPsSpawn so the persistent probe drives it.
  const makeDualSpawn = (scanRows, consoleAnswers) => {
    const state = { consoleQueries: [], spawnFn: null };
    const answers = [...consoleAnswers];
    state.spawnFn = () => {
      const child = new EventEmitter();
      const stdout = new EventEmitter();
      stdout.setEncoding = () => {};
      const stderr = new EventEmitter();
      stderr.resume = () => {};
      child.stdin = {
        write: (text) => {
          const markerMatch = text.match(/Write-Output '([^']+)'/);
          const marker = markerMatch ? markerMatch[1] : "";
          let body = scanRows;
          if (text.includes("AttachErr")) {
            state.consoleQueries.push(text);
            body = answers.length > 0 ? answers.shift() : "";
          }
          if (body.length > 0 && !body.endsWith("\r\n")) body += "\r\n";
          stdout.emit("data", body + marker + "\r\n");
        },
      };
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => { child.emit("exit", 0); };
      child.unref = () => {};
      return child;
    };
    return state;
  };

  it("keeps harness-spawned helper processes out of the DSH engine count", async () => {
    // Live third-card root cause (2026-09-22): the harness spawns transient
    // helpers under its own node_modules — subprocess runner, sandbox ACL
    // runner, directory-picker worker, web-app server — and every one of them
    // carries an `@deepseek-ai\dsh…` path prefix, so a package-path engine
    // signature counts them as sessions (unbadged row + "DSH ×1" subline).
    // Only the manifest entry dsh\lib\bin.js boots a session.
    const NPM = "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules";
    const helperRow = (pid, rel) => nodeRow(pid, `"${NPM}\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\${rel}"`);
    const execFn = (cmd, opts, cb) => cb(null, wmic(
      harnessRow(4800, "--profile dsh-tui"),
      helperRow(4801, "dsh-subprocess-local\\lib\\runner.js -- powershell.exe -NoLogo"),
      helperRow(4802, "dsh-sandbox-windows-acl\\lib\\runner.js --workspace C:\\w --temp C:\\t"),
      helperRow(4803, "dsh-host-directory-picker-native\\lib\\worker.cjs"),
      helperRow(4804, "dsh-web-app\\lib\\index.js"),
    ));
    const collector = testCollector({ execFn, nowFn: () => 3000 });

    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.equal(dsh.processCount, 1);
    assert.deepEqual(surfacesOf(dsh), { TUI: 1 });
    assert.deepEqual(dsh.instances.map((i) => [i.id, i.surface]), [["dsh-4800", "TUI"]]);
  });

  it("reaps a TUI harness whose terminal is gone and drops its row", async () => {
    // Live empty-TUI-card root cause (2026-09-22): a `--profile dsh-tui`
    // harness outlives its dead terminal (AttachConsole -> 233/5/87) and the
    // panel kept listing it forever. Two dead verdicts one scan window apart
    // confirm; then the process is reaped and the row/count drop. A web
    // engine is never probed.
    let t = 3000;
    const probe = makeDualSpawn(
      wmic(harnessRow(5001, "--profile dsh-tui"), harnessRow(5002, "web --no-open --port 31399")),
      ["c=5001/233", "c=5001/5"],
    );
    const killed = [];
    const collector = testCollector({ spawnFn: probe.spawnFn, killFn: (pid) => killed.push(pid), nowFn: () => t });

    let dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(dsh.instances.map((i) => [i.id, i.surface]), [["dsh-5001", "TUI"], ["dsh-5002", "Web"]]);
    assert.equal(killed.length, 0, "one dead verdict alone must not reap");

    t += 3000;
    await collector.getAgentsStatus(); // round 2: confirming verdict + reap
    await new Promise((r) => setTimeout(r, 20));
    dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(killed, [5001]);
    assert.deepEqual(dsh.instances.map((i) => [i.id, i.surface]), [["dsh-5002", "Web"]]);
    assert.equal(dsh.processCount, 1);
    assert.deepEqual(surfacesOf(dsh), { Web: 1 });
    assert.ok(probe.consoleQueries.length >= 2);
    assert.ok(probe.consoleQueries.every((q) => q.includes("5001") && !q.includes("5002")), "只探测 TUI 形态");
  });

  it("does not reap when a dead verdict is followed by a live console", async () => {
    let t = 3000;
    const probe = makeDualSpawn(wmic(harnessRow(5101, "--profile dsh-tui")), ["c=5101/233", "c=5101/0", "c=5101/0"]);
    const killed = [];
    const collector = testCollector({ spawnFn: probe.spawnFn, killFn: (pid) => killed.push(pid), nowFn: () => t });

    await collector.getAgentsStatus();
    t += 3000; await collector.getAgentsStatus(); await new Promise((r) => setTimeout(r, 20));
    t += 3000; await collector.getAgentsStatus(); await new Promise((r) => setTimeout(r, 20));
    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(killed, []);
    assert.deepEqual(dsh.instances.map((i) => i.id), ["dsh-5101"]);
  });

  it("never reaps when the process has no console object at all", async () => {
    // err 6 = the process has no console object (headless spawn shapes);
    // that is not a closed-terminal verdict, so the row stays.
    let t = 3000;
    const probe = makeDualSpawn(wmic(harnessRow(5201, "--profile dsh-tui")), ["c=5201/6", "c=5201/6"]);
    const killed = [];
    const collector = testCollector({ spawnFn: probe.spawnFn, killFn: (pid) => killed.push(pid), nowFn: () => t });

    await collector.getAgentsStatus();
    t += 3000; await collector.getAgentsStatus(); await new Promise((r) => setTimeout(r, 20));
    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(killed, []);
    assert.deepEqual(dsh.instances.map((i) => i.id), ["dsh-5201"]);
  });

  it("reaps on every measured dead-console flavor, not just the first one seen", async () => {
    // Live miss fixed 2026-09-22: the first orphan measured (parent long
    // gone) answered 233, so the dead verdict was pinned to {5, 233}; a
    // freshly orphaned harness (parent still alive, conhost just killed)
    // answers 87 (ERROR_INVALID_PARAMETER) and slipped through unreaped.
    // The verdict rule is now "nonzero and not no-console", so 87 reaps
    // exactly like 233 and 5.
    let t = 3000;
    const probe = makeDualSpawn(
      wmic(harnessRow(5401, "--profile dsh-tui")),
      ["c=5401/87", "c=5401/87"],
    );
    const killed = [];
    const collector = testCollector({ spawnFn: probe.spawnFn, killFn: (pid) => killed.push(pid), nowFn: () => t });

    await collector.getAgentsStatus();
    assert.deepEqual(killed, [], "one dead verdict alone must not reap");
    t += 3000; await collector.getAgentsStatus(); await new Promise((r) => setTimeout(r, 20));
    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(killed, [5401]);
    assert.deepEqual(dsh.instances.map((i) => i.id), []);
    assert.equal(dsh.processCount, 0);
  });

  it("never reaps when the console probe answer is unreadable", async () => {
    let t = 3000;
    const probe = makeDualSpawn(wmic(harnessRow(5301, "--profile dsh-tui")), ["", "Node,CommandLine,Name,ProcessId"]);
    const killed = [];
    const collector = testCollector({ spawnFn: probe.spawnFn, killFn: (pid) => killed.push(pid), nowFn: () => t });

    await collector.getAgentsStatus();
    t += 3000; await collector.getAgentsStatus(); await new Promise((r) => setTimeout(r, 20));
    const dsh = (await collector.getAgentsStatus()).find((a) => a.id === "dsh");
    assert.deepEqual(killed, []);
    assert.deepEqual(dsh.instances.map((i) => i.id), ["dsh-5301"]);
  });

  it("buildDshConsoleQuery and parseDshConsoleQueryOutput round the probe contract", () => {
    assert.equal(buildDshConsoleQuery([]), null);
    const query = buildDshConsoleQuery([13128, 27156]);
    assert.ok(query.includes("AttachErr"), "AttachErr 标记是识别控制台查询的契约");
    assert.ok(query.includes("13128,27156"));
    const verdicts = parseDshConsoleQueryOutput("c=13128/233\r\nc=27156/0\r\n__MARKER__\r\n");
    assert.equal(verdicts.get(13128), 233);
    assert.equal(verdicts.get(27156), 0);
    assert.equal(parseDshConsoleQueryOutput("Node,CommandLine\r\n").size, 0);
    assert.equal(parseDshConsoleQueryOutput(null).size, 0);
  });
});

describe("Kimi Code 分面（桌面端 / 终端 / kimi web）", () => {
  // 行形态与真机一致：WMIC 形状 <Node>,<CommandLine>,<Name>,<ProcessId>。
  const KIMI_PKG = "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@moonshot-ai\\kimi-code";
  const DESKTOP_IMG = "C:\\Users\\tester\\AppData\\Local\\Programs\\Kimi Code\\Kimi Code.exe";
  const nodeRow = (pid, commandLine) => `LAPTOP,"C:\\Program Files\\nodejs\\node.exe" ${commandLine},node.exe,${pid}`;
  const kimiRow = (pid) => nodeRow(pid, `"${KIMI_PKG}\\dist\\main.mjs"`);
  const desktopRow = (pid, args = "") => `LAPTOP,"${DESKTOP_IMG}" ${args},kimi code.exe,${pid}`;
  const wmic = (...rows) => `Node,CommandLine,Name,ProcessId\r\n${rows.join("\r\n")}\r\n`;
  const tasklistCsv = (...quotedRows) => `${quotedRows.join("\r\n")}\r\n`;
  const surfacesOf = (agent) => Object.fromEntries(agent.surfaces.map((s) => [s.label, s.count]));
  const rowsOf = (agent) => agent.instances.map((i) => [i.id, i.surface ?? null]);
  const registry = (entries) => async () => new Map(entries);
  const kimi = (status) => status.find((a) => a.id === "kimi");

  it("counts one desktop app as one Kimi process, labelled Desktop, and ignores its Electron children", async () => {
    // 桌面端是原生 Electron 包：命令行里没有 `kimi-code` 安装路径，今天那套
    // node 路径谓词一条都不命中（进程面全盲）。主进程自己就是会话
    // 属主（kimi 核心内嵌其中、relay 连接挂在它身上），所以它计数并贴桌面面；
    // --type= 的辅助子进程与 qoder / ChatGPT.exe 同口径只进家族集。
    const collector = testCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(
        desktopRow(6001),
        desktopRow(6002, "--type=crashpad-handler"),
        desktopRow(6003, "--type=gpu-process"),
        desktopRow(6004, '--type=renderer --user-data-dir="C:\\Users\\tester\\AppData\\Roaming\\kimi-code-app"'),
      )),
      kimiRegistryLookup: registry([]),
    });
    const card = kimi(await collector.getAgentsStatus());
    assert.equal(card.status, "running", "只开桌面端就要点亮卡片");
    assert.equal(card.processCount, 1, "辅助子进程不计数");
    assert.deepEqual(surfacesOf(card), { Desktop: 1 });
    // 主进程出行挂面级稳定行（kimi-desktop），不是它的 pid——换代不再换行。
    assert.deepEqual(rowsOf(card), [["kimi-desktop", "Desktop"]], "只有主进程出行");
  });

  it("桌面端拉起的家目录插件帮手不算会话（幻影 TUI 行回归）", async () => {
    // 实测 2026-10-22：桌面主进程孵化 cmd 垫片再拉起托管插件
    // ~/.kimi-code/plugins/managed/kimi-cu-win/bin/launch.mjs（computer-use
    // MCP）。插件命令行里的 `.kimi-code\` 恰好包含 node 谓词的裸安装 token
    // `kimi-code\`，原先被折成一条零请求的幻影 TUI 会话行（kimi-<pid>），
    // 卡头凭空多出「TUI ×1」。家目录是数据目录不是安装目录，住在里面的
    // node 一律是帮手而非会话——isKimiNode 对家目录之下的行整体豁免。
    const HOME = "C:\\Users\\tester\\.kimi-code";
    const collector = testCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(
        desktopRow(6001),
        "LAPTOP,cmd.exe /c bin\\kimi-cu-mcp.cmd,cmd.exe,6002",
        nodeRow(6003, `"${HOME}\\plugins\\managed\\kimi-cu-win\\bin\\launch.mjs"`),
      )),
      kimiRegistryLookup: registry([]),
    });
    const card = kimi(await collector.getAgentsStatus());
    assert.equal(card.status, "running");
    assert.equal(card.processCount, 1, "家目录帮手进程不计数");
    assert.deepEqual(surfacesOf(card), { Desktop: 1 });
    assert.deepEqual(rowsOf(card), [["kimi-desktop", "Desktop"]], "帮手进程不出实例行");
  });

  it("家目录豁免罩住 dist/main.mjs 回退分支，真 TUI 照常计数", async () => {
    // 回退分支（`dist\main.mjs` + `kimi`）同样会被家目录下的帮手命中：插件
    // 入口若叫 dist/main.mjs，路径里的 `.kimi-code` 同时满足两个条件。豁免
    // 必须罩住整个 isKimiNode，而不是只堵裸 token 那两条；同一轮里的真 TUI
    // 行照常计数，证明这是纯减法。
    const HOME = "C:\\Users\\tester\\.kimi-code";
    const collector = testCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(
        nodeRow(6101, `"${HOME}\\plugins\\managed\\some-mcp\\dist\\main.mjs"`),
        kimiRow(6102),
      )),
      kimiRegistryLookup: registry([]),
    });
    const card = kimi(await collector.getAgentsStatus());
    assert.equal(card.processCount, 1, "家目录帮手不计数，真 TUI 照常");
    assert.deepEqual(surfacesOf(card), { TUI: 1 });
    assert.deepEqual(rowsOf(card), [["kimi-6102", "TUI"]]);
  });

  it("家目录豁免跟随 KIMI_CODE_HOME 挪家", async () => {
    // 家目录可被 KIMI_CODE_HOME 挪走（kimi-server-registry.mjs 的口径）：
    // 挪走后默认 token `.kimi-code\` 不再出现在帮手命令行里，但路径含
    // "kimi" 的 dist/main.mjs 帮手仍会命中回退分支。豁免每轮按解析出的
    // 真实家目录做子串包含，而不是只认默认目录名。
    const prev = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = "D:\\kimihomes\\tester";
    try {
      const collector = testCollector({
        nowFn: () => 3000,
        execFn: (cmd, opts, cb) => cb(null, wmic(
          nodeRow(6201, `"D:\\kimihomes\\tester\\plugins\\managed\\kimi-cu-win\\dist\\main.mjs"`),
          kimiRow(6202),
        )),
        kimiRegistryLookup: registry([]),
      });
      const card = kimi(await collector.getAgentsStatus());
      assert.equal(card.processCount, 1);
      assert.deepEqual(rowsOf(card), [["kimi-6202", "TUI"]]);
    } finally {
      if (prev === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = prev;
    }
  });

  it("reopens the account when the main process is replaced, row identity intact", async () => {
    // 主进程是会话属主，它死了 = 这一代账目结束：新主进程的请求重新开账
    // （请求数/工时/折线从零），行 id 与 Desktop 标签保持稳定。判定只看进程
    // 生死、与空闲时长无关——journal 实证（2026-10-02~06）主进程换代都发生在
    // 会话尺度，旧主全灭 + 新主出现即真重启。
    let t = 3000;
    let mainPid = 6401;
    const collector = testCollector({
      nowFn: () => t,
      execFn: (cmd, opts, cb) => cb(null, wmic(desktopRow(mainPid))),
      kimiRegistryLookup: registry([]),
    });
    await collector.scanProcesses();

    const r1 = collector.startRequest({ agentId: "kimi", instanceId: `kimi-${mainPid}`, model: "m1", stream: true, path: "openai" });
    r1.recordFirstChunk();
    r1.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 40 } });

    // The desktop app relaunches its core; the panel's poll refreshes the scan
    // before the next request (two-step read: first serves stale and kicks the
    // round, second serves what landed). The read itself settles the generation:
    // the old main is gone from the scan, so the account reopens before the
    // new generation's first request lands.
    mainPid = 6402;
    t += 3000;
    await collector.getAgentsStatus();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const r2 = collector.startRequest({ agentId: "kimi", instanceId: `kimi-${mainPid}`, model: "m1", stream: true, path: "openai" });
    r2.recordFirstChunk();
    r2.recordEnd({ status: 200, usage: { prompt_tokens: 50, completion_tokens: 20 } });

    const card = kimi(await collector.getAgentsStatus());
    assert.deepEqual(rowsOf(card), [["kimi-desktop", "Desktop"]]);
    assert.equal(card.instances[0].requests, 1, "a replaced main process reopens the account");
    assert.equal(card.instances[0].tokens.prompt, 50, "the old generation's tokens do not carry over");
  });

  it("folds desktop traffic onto the stable row while terminal traffic keeps its pid row", async () => {
    const collector = testCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(kimiRow(6411), desktopRow(6412))),
      kimiRegistryLookup: registry([]),
    });
    await collector.scanProcesses();

    const tui = collector.startRequest({ agentId: "kimi", instanceId: "kimi-6411", model: "m1", stream: true, path: "openai" });
    tui.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 4 } });
    const desktop = collector.startRequest({ agentId: "kimi", instanceId: "kimi-6412", model: "m1", stream: true, path: "openai" });
    desktop.recordEnd({ status: 200, usage: { prompt_tokens: 20, completion_tokens: 8 } });

    const card = kimi(await collector.getAgentsStatus());
    assert.deepEqual(rowsOf(card).sort(), [["kimi-6411", "TUI"], ["kimi-desktop", "Desktop"]]);
  });

  it("keeps the idle desktop row while the app runs and retires it with the app", async () => {
    // 稳定行无 pid 可对账：主进程活着就与逐 pid 行同权常驻（空闲不清行）；
    // App 退场当轮收行，与空闲时长无关——下面故意在刚发生请求（行不空闲）时
    // 退场，钉住「死即收、不等任何 TTL」。
    let t = 3000;
    let appUp = true;
    const collector = testCollector({
      nowFn: () => t,
      execFn: (cmd, opts, cb) => cb(null, appUp ? wmic(desktopRow(6421)) : "Node,CommandLine,Name,ProcessId\r\n"),
      kimiRegistryLookup: registry([]),
    });
    await collector.scanProcesses();
    const r = collector.startRequest({ agentId: "kimi", instanceId: "kimi-6421", model: "m1", stream: true, path: "openai" });
    r.recordEnd({ status: 200, usage: { prompt_tokens: 8, completion_tokens: 3 } });

    t += 20 * 60 * 1000; // far past the old 10-minute idle TTL
    const card = kimi(await collector.getAgentsStatus());
    assert.deepEqual(rowsOf(card), [["kimi-desktop", "Desktop"]], "an idle row survives while the desktop app runs");

    const r2 = collector.startRequest({ agentId: "kimi", instanceId: "kimi-6421", model: "m1", stream: true, path: "openai" });
    r2.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });

    // 读驱动的重扫在微任务里落地，且可能横跨下一次读：「读→等→读」两步不足以
    // 保证服务到的快照是 App 退场后的那一轮（后台在途轮会先于读者落不了地）。
    // 每轮都把时钟推过缓存窗口再等一拍，直到某轮读到空扫描、行被收掉为止。
    appUp = false;
    t += 3000;
    let gone = null;
    for (let round = 0; round < 25 && gone === null; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      t += 3000; // past the cache window so this read serves the last landed scan
      const c = kimi(await collector.getAgentsStatus());
      if (c.instances.length === 0) gone = c;
    }
    assert.ok(gone !== null, "the row retires with the app");
    assert.equal(gone.status, "stopped");
  });

  it("keeps one account while two main processes coexist (overlap churn)", async () => {
    // journal 实证的共存换代（2026-10-04 两个主进程共存约 25 分钟）：旧主还有
    // 活口就续账，新主并入同一行同一账；全部退场后的新主才重开账。
    const collector = testCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(desktopRow(6401), desktopRow(6402))),
      kimiRegistryLookup: registry([]),
    });
    await collector.scanProcesses();

    const r1 = collector.startRequest({ agentId: "kimi", instanceId: "kimi-6401", model: "m1", stream: true, path: "openai" });
    r1.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 40 } });
    const r2 = collector.startRequest({ agentId: "kimi", instanceId: "kimi-6402", model: "m1", stream: true, path: "openai" });
    r2.recordEnd({ status: 200, usage: { prompt_tokens: 50, completion_tokens: 20 } });

    const card = kimi(await collector.getAgentsStatus());
    assert.deepEqual(rowsOf(card), [["kimi-desktop", "Desktop"]]);
    assert.equal(card.instances[0].requests, 2, "coexisting mains share one account");
  });

  it("does not reopen the account on idle time alone while the app keeps running", async () => {
    // 空闲时长不参与账目判定：同主进程闲置多久后续跑都是同代续账。
    let t = 3000;
    const collector = testCollector({
      nowFn: () => t,
      execFn: (cmd, opts, cb) => cb(null, wmic(desktopRow(6401))),
      kimiRegistryLookup: registry([]),
    });
    await collector.scanProcesses();
    const r1 = collector.startRequest({ agentId: "kimi", instanceId: "kimi-6401", model: "m1", stream: true, path: "openai" });
    r1.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 40 } });

    t += 20 * 60 * 1000;
    const r2 = collector.startRequest({ agentId: "kimi", instanceId: "kimi-6401", model: "m1", stream: true, path: "openai" });
    r2.recordEnd({ status: 200, usage: { prompt_tokens: 50, completion_tokens: 20 } });

    const card = kimi(await collector.getAgentsStatus());
    assert.deepEqual(rowsOf(card), [["kimi-desktop", "Desktop"]]);
    assert.equal(card.instances[0].requests, 2, "same main process = same account, however long the idle");
  });

  it("keeps the desktop row through a degraded round that lost the app", async () => {
    // 降级轮（tasklist 有行但无命令行列）答不出桌面端生死：不收行也不重开账，
    // 与逐 pid 行「旧形状不淘汰」同一保守守卫。旧实现此场景会把空闲行交给
    // 10 分钟 TTL 洗掉。
    let t = 3000;
    let trusted = true;
    const collector = testCollector({
      nowFn: () => t,
      execFn: (cmd, opts, cb) => {
        if (cmd.includes("tasklist")) {
          return cb(null, trusted ? "" : '"explorer.exe","999","Console","1","80,000 K"\r\n');
        }
        return cb(null, trusted ? wmic(desktopRow(6401)) : "");
      },
      kimiRegistryLookup: registry([]),
    });
    await collector.scanProcesses();
    const r = collector.startRequest({ agentId: "kimi", instanceId: "kimi-6401", model: "m1", stream: true, path: "openai" });
    r.recordEnd({ status: 200, usage: { prompt_tokens: 8, completion_tokens: 3 } });

    trusted = false;
    t += 20 * 60 * 1000;
    await collector.getAgentsStatus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const card = kimi(await collector.getAgentsStatus());
    assert.deepEqual(rowsOf(card), [["kimi-desktop", "Desktop"]], "an untrusted round never retires the row");
  });

  it("refolds a request that landed before the scan saw the desktop app onto the stable row", async () => {
    // 请求路径只读扫描缓存、从不触发扫描：App 刚换代、缓存还没赶上时，请求
    // 先落在原始 pid 行上；缓存跟上后的下一轮读重折叠归位，计数随行保留。
    let t = 3000;
    let appUp = false;
    const collector = testCollector({
      nowFn: () => t,
      execFn: (cmd, opts, cb) => cb(null, appUp ? wmic(desktopRow(6431)) : "Node,CommandLine,Name,ProcessId\r\n"),
      kimiRegistryLookup: registry([]),
    });
    const r = collector.startRequest({ agentId: "kimi", instanceId: "kimi-6431", model: "m1", stream: true, path: "openai" });
    r.recordEnd({ status: 200, usage: { prompt_tokens: 30, completion_tokens: 12 } });

    appUp = true;
    t += 3000;
    await collector.scanProcesses();
    const card = kimi(await collector.getAgentsStatus());
    assert.deepEqual(rowsOf(card), [["kimi-desktop", "Desktop"]], "the cold pid row folds onto the stable row");
    assert.equal(card.instances[0].requests, 1);
    assert.equal(card.instances[0].tokens.prompt, 30);
  });

  it("folds a cold-cache desktop main-process row into the stable row at the display exit", async () => {
    // 与 dsh 同形：桌面主进程换代 + 首笔在途请求撞上冷缓存，桶里稳定行与
    // 原始 pid 行同指一个宿主。出口只吐 kimi-desktop，计数与在途状态随行。
    let t = 3000;
    let appPid = 6401;
    const collector = testCollector({
      nowFn: () => t,
      execFn: (cmd, opts, cb) => cb(null, wmic(desktopRow(appPid))),
      kimiRegistryLookup: registry([]),
    });
    assert.deepEqual(rowsOf(kimi(await collector.getAgentsStatus())), [["kimi-desktop", "Desktop"]]);

    appPid = 6431;
    t += 3000;
    const r = collector.startRequest({ agentId: "kimi", instanceId: `kimi-${appPid}`, model: "m1", stream: true, path: "openai" });
    for (let tries = 0; tries < 10; tries += 1) {
      const procs = await collector.scanProcesses();
      if (procs.kimiDesktopPids.has(6431)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const mid = kimi(await collector.getAgentsStatus());
    assert.deepEqual(rowsOf(mid), [["kimi-desktop", "Desktop"]], "同指一个主进程，出口只吐一行");
    assert.equal(mid.instances[0].activeRequests, 1, "在途请求随稳定行呈现");

    r.recordEnd({ status: 200, usage: { prompt_tokens: 30, completion_tokens: 12 } });
    const after = kimi(await collector.getAgentsStatus());
    assert.deepEqual(rowsOf(after), [["kimi-desktop", "Desktop"]], "收敛后仍只有稳定行");
    assert.equal(after.instances[0].requests, 1, "并账计数不丢");
  });

  it("accepts a plain-tasklist desktop row by image name (no command line on that probe)", async () => {
    const collector = testCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, tasklistCsv(
        '"Kimi Code.exe","6301","Console","1","280,000 K"',
      )),
      kimiRegistryLookup: registry([]),
    });
    const card = kimi(await collector.getAgentsStatus());
    // 2026-10-07 改判：命令行列缺席的那一轮不再主张宿主与面（见 parseTasklistCsv 的
    // kimi 分支）。这一行的进程数照旧是本轮的事实，面那一档要等可信轮或 carry 说话——
    // 本机实测降级轮把一个 Kimi 桌面端的每个 Electron 进程都收进宿主集，副行报出
    // 「Desktop ×5」，正是看板加载中间态空实例卡同源的那次误折。
    assert.equal(card.processCount, 1);
    assert.deepEqual(surfacesOf(card), {}, "读不到命令行的轮次不报面");
    assert.deepEqual(rowsOf(card), [], "读不到命令行的轮次不造实例行");
  });

  it("claims the desktop face as soon as a probe can read the command line", async () => {
    const collector = testCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, [
        "Node,CommandLine,Name,ProcessId",
        'LAPTOP,"C:\\Users\\tester\\AppData\\Local\\Programs\\Kimi\\Kimi Code.exe",Kimi Code.exe,6301',
      ].join("\r\n") + "\r\n"),
      kimiRegistryLookup: registry([]),
    });
    const card = kimi(await collector.getAgentsStatus());
    assert.equal(card.processCount, 1);
    assert.deepEqual(surfacesOf(card), { Desktop: 1 }, "命令行读得到：主进程就是桌面宿主");
    assert.deepEqual(rowsOf(card), [["kimi-desktop", "Desktop"]]);
  });

  it("promotes the terminal row that owns a server registration to Web and leaves the desktop row alone", async () => {
    // `kimi web` 与终端客户端在命令行上无法分辨（同一个 dist/main.mjs），区别
    // 只在谁起了 server：起了 server 的会在 ~/.kimi-code/server/instances/ 留下
    // 以自己 pid 署名的一条登记。注册表只提级终端那一档，桌面端由镜像名定性。
    const collector = testCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(
        kimiRow(6101),
        kimiRow(6102),
        desktopRow(6103),
      )),
      kimiRegistryLookup: registry([[6102, { pid: 6102, port: 7457, heartbeatAt: 2900, hostVersion: "2.0.1" }]]),
    });
    const card = kimi(await collector.getAgentsStatus());
    assert.equal(card.processCount, 3);
    assert.deepEqual(surfacesOf(card), { Desktop: 1, TUI: 1, Web: 1 }, "副行加总 = 进程数");
    assert.deepEqual(rowsOf(card).sort(), [["kimi-6101", "TUI"], ["kimi-6102", "Web"], ["kimi-desktop", "Desktop"]]);
  });

  it("flips a process's face when it hands its session to the browser mid-life, with the row identity intact", async () => {
    // 客户端里有一条「TUI 交棒」的路：在终端界面里把当前会话交给浏览器，TUI 让位
    // 后同一个进程号就地变成 server，并在注册表里补一条以自己 pid 署名的登记。
    // 面不是一次贴死的——每轮扫描都从「镜像名 + 本轮注册表」重算，所以登记出现后
    // 的那一轮里卡头副行与实例行一起换面，行身份仍是同一个 kimi-<pid>。
    // 轮数按上界轮询而不是固定排空次数：换面落地前的读者照旧拿上一轮快照
    // （stale-while-revalidate），哪一轮落地由不得测试来猜。
    let now = 3000;
    let registered = false;
    const collector = testCollector({
      nowFn: () => now,
      execFn: (cmd, opts, cb) => cb(null, wmic(kimiRow(6501))),
      kimiRegistryLookup: async () => (registered
        ? new Map([[6501, { pid: 6501, port: 58627, heartbeatAt: now, hostVersion: "2.0.2" }]])
        : new Map()),
    });
    const before = kimi(await collector.getAgentsStatus());
    assert.deepEqual(surfacesOf(before), { TUI: 1 });
    assert.deepEqual(rowsOf(before), [["kimi-6501", "TUI"]]);

    registered = true;
    now += 2501;
    let flipped = null;
    for (let round = 0; round < 20 && flipped === null; round += 1) {
      const card = kimi(await collector.getAgentsStatus());
      if (card.surfaces.some((s) => s.label === "Web")) flipped = card;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(flipped !== null, "登记出现后的一轮里，副行要跟着换成 Web");
    assert.deepEqual(surfacesOf(flipped), { Web: 1 }, "同一个进程只有一张面，换面不是加面");
    assert.deepEqual(flipped.instances.map((i) => [i.id, i.surface]), [["kimi-6501", "Web"]], "实例行与副行同轮换面");
    assert.equal(flipped.processCount, 1, "换面不换计数");
  });

  it("never lets the registration table move a desktop row off its face", async () => {
    const collector = testCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(desktopRow(6201), kimiRow(6202))),
      kimiRegistryLookup: registry([[6201, { pid: 6201, port: 7457, heartbeatAt: 2900, hostVersion: "2.0.1" }]]),
    });
    const card = kimi(await collector.getAgentsStatus());
    assert.deepEqual(surfacesOf(card), { Desktop: 1, TUI: 1 }, "桌面端不被注册表改写");
  });

  it("ignores registrations for pids the scan does not list, and degrades when the table is unreadable", async () => {
    // 注册表只分面、不判活：一条残档（进程早没了、pid 被复用）既不能撑出一行，
    // 也不能把卡片点亮；整轮读不出就退回"所有 kimi 进程都算终端面"。
    const rowsOnly = {
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(kimiRow(6301))),
    };
    const stale = kimi(await testCollector({
      ...rowsOnly,
      kimiRegistryLookup: registry([[9999, { pid: 9999, port: 7457, heartbeatAt: 2900, hostVersion: "2.0.1" }]]),
    }).getAgentsStatus());
    assert.deepEqual(surfacesOf(stale), { TUI: 1 });
    assert.deepEqual(rowsOf(stale), [["kimi-6301", "TUI"]]);

    const broken = kimi(await testCollector({
      ...rowsOnly,
      kimiRegistryLookup: async () => { throw new Error("EACCES"); },
    }).getAgentsStatus());
    assert.deepEqual(surfacesOf(broken), { TUI: 1 }, "读不出注册表不影响计数与卡片");
    assert.equal(broken.processCount, 1);
  });

  it("leaves an unresolvable instance id unbadged instead of guessing a face", async () => {
    // 启动器注入的 <cwd>-<launcher pid> 在扫描缓存没赶上时折不进规范形，
    // 落成自定义 id 行：行要有（请求真实发生），但面未知时不贴徽标。
    const collector = testCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(kimiRow(6401))),
      kimiRegistryLookup: registry([]),
    });
    collector.startRequest({ agentId: "kimi", instanceId: "proj-999999", model: "m", providerId: "p" });
    const card = kimi(await collector.getAgentsStatus());
    const foreign = card.instances.find((i) => i.id === "proj-999999");
    assert.ok(foreign, "未折叠的实例行照常出");
    assert.equal(foreign.surface, undefined, "非 pid 形行不贴面徽标");
    assert.deepEqual(surfacesOf(card), { TUI: 1 }, "副行只按扫描到的进程算");
  });

  it("summarizeKimiSurfaces labels only the closed face set and stays empty without an engine set", () => {
    assert.deepEqual(summarizeKimiSurfaces(undefined), []);
    assert.deepEqual(summarizeKimiSurfaces({}), []);
    assert.deepEqual(summarizeKimiSurfaces({ kimiEnginePids: new Set([1]) }), [
      { surface: null, label: "未知", count: 1 },
    ]);
    assert.deepEqual(summarizeKimiSurfaces({
      kimiEnginePids: new Set([1, 2, 3, 4]),
      kimiSurfaceByPid: new Map([[1, "desktop"], [2, "web"], [3, "tui"], [4, "bogus"]]),
    }), [
      { surface: "bogus", label: "未知", count: 1 },
      { surface: "desktop", label: "Desktop", count: 1 },
      { surface: "tui", label: "TUI", count: 1 },
      { surface: "web", label: "Web", count: 1 },
    ]);
    assert.equal(kimiSurfaceLabel("desktop"), "Desktop");
    assert.equal(kimiSurfaceLabel(undefined), "未知");
    assert.equal(kimiSurfaceLabel("Kimi Code"), "未知", "产品名不当界面名用");
  });

  it("carries generation anchors across a relay restart: same main continues the account", async () => {
    // 代际锚随指标快照落盘还原：relay 重启（缓存清零）后同一主进程的请求仍是
    // 同一代，续账不重开。快照落盘走真实定时器，需真等一拍。
    const dir = mkdtempSync(join(tmpdir(), "anyswitch-metrics-snapshot-"));
    const snapPath = join(dir, "metrics-snapshot.json");
    try {
      let t = 3000;
      const opts = () => ({
        nowFn: () => t,
        metricsSnapshotPath: snapPath,
        metricsSnapshotEveryMs: 30,
        execFn: (cmd, opts2, cb) => cb(null, wmic(desktopRow(6401))),
        kimiRegistryLookup: registry([]),
      });
      const a = testCollector(opts());
      await a.scanProcesses();
      const r1 = a.startRequest({ agentId: "kimi", instanceId: "kimi-6401", model: "m1", stream: true, path: "openai" });
      r1.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 40 } });
      t += 100;
      // 轮询等快照定时器真正落一次盘（截止 2s），不用固定 sleep：满载时 30ms
      // 周期定时器在 80ms 墙钟内未必抢到一拍，固定 sleep 会假红（同上方心跳
      // 用例的轮询写法）。落盘是同步原子写，文件出现即写完成。
      const snapDeadline = Date.now() + 2000;
      while (!existsSync(snapPath) && Date.now() < snapDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      assert.ok(existsSync(snapPath), "快照定时器未在截止时间内落盘");

      const b = testCollector(opts());
      await b.scanProcesses();
      const r2 = b.startRequest({ agentId: "kimi", instanceId: "kimi-6401", model: "m1", stream: true, path: "openai" });
      r2.recordEnd({ status: 200, usage: { prompt_tokens: 50, completion_tokens: 20 } });

      const card = kimi(await b.getAgentsStatus());
      assert.deepEqual(rowsOf(card), [["kimi-desktop", "Desktop"]]);
      assert.equal(card.instances[0].requests, 2, "same main process across a relay restart = same account");
      assert.equal(card.instances[0].tokens.prompt, 150);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reopens the restored account when the app restarted during the relay downtime", async () => {
    // relay 停机期间 App 重启过：还原的旧账在新主进程证据到来时收口重开，新
    // 主落在原始 pid 行上的计数经重折叠并账进入新账——隐藏期攒下的历史不丢。
    const dir = mkdtempSync(join(tmpdir(), "anyswitch-metrics-snapshot-"));
    const snapPath = join(dir, "metrics-snapshot.json");
    try {
      let t = 3000;
      let mainPid = 6401;
      const a = testCollector({
        nowFn: () => t,
        metricsSnapshotPath: snapPath,
        metricsSnapshotEveryMs: 30,
        execFn: (cmd, opts2, cb) => cb(null, wmic(desktopRow(mainPid))),
        kimiRegistryLookup: registry([]),
      });
      await a.scanProcesses();
      const r1 = a.startRequest({ agentId: "kimi", instanceId: "kimi-6401", model: "m1", stream: true, path: "openai" });
      r1.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 40 } });
      t += 100;
      // 同上：轮询等落盘（截止 2s），不用固定 sleep。
      const snapDeadline = Date.now() + 2000;
      while (!existsSync(snapPath) && Date.now() < snapDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      assert.ok(existsSync(snapPath), "快照定时器未在截止时间内落盘");

      mainPid = 6402;
      t += 3000;
      const b = testCollector({
        nowFn: () => t,
        metricsSnapshotPath: snapPath,
        metricsSnapshotEveryMs: 30,
        execFn: (cmd, opts2, cb) => cb(null, wmic(desktopRow(mainPid))),
        kimiRegistryLookup: registry([]),
      });
      // B 的缓存冷着：请求先落原始 pid 行（真正的隐藏期桥接形状）。
      const r2 = b.startRequest({ agentId: "kimi", instanceId: "kimi-6402", model: "m1", stream: true, path: "openai" });
      r2.recordEnd({ status: 200, usage: { prompt_tokens: 50, completion_tokens: 20 } });
      await b.scanProcesses();
      const card = kimi(await b.getAgentsStatus());
      await new Promise((resolve) => setTimeout(resolve, 20));
      const settled = kimi(await b.getAgentsStatus());

      assert.deepEqual(rowsOf(settled), [["kimi-desktop", "Desktop"]], "the cold pid row folds onto the stable row");
      assert.equal(settled.instances[0].requests, 1, "the old era's account was reopened");
      assert.equal(settled.instances[0].tokens.prompt, 50, "the new era's counts survive the refold merge");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("WorkBuddy 进程分桶与面（一名九进程）", () => {
  // 行形态与真机一致：WMIC 形状 <Node>,<CommandLine>,<Name>,<ParentProcessId>,<ProcessId>。
  const INSTALL = "C:\\Users\\tester\\AppData\\Local\\Programs\\WorkBuddy";
  const IMG = `${INSTALL}\\WorkBuddy.exe`;
  const RUNTIME = `${INSTALL}\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy`;
  const wmic = (...rows) => `Node,CommandLine,Name,ParentProcessId,ProcessId\r\n${rows.join("\r\n")}\r\n`;
  const row = (pid, ppid, args = "") => `LAPTOP,"${IMG}"${args ? ` ${args}` : ""},workbuddy.exe,${ppid},${pid}`;
  const agentRow = (pid, ppid) => row(pid, ppid, `--optimize-for-size --max-semi-space-size=2 ${RUNTIME} --resume 0198b8a6`);
  const wb = (status) => status.find((a) => a.id === "workbuddy");

  // 这些用例不该碰真实家目录：注册表读到东西与读不到是两种结局，静默读用户的
  // ~/.workbuddy 既不可重复也可能改变结论。缺省注入「没有注册表」，需要注册表
  // 的用例自己传 workbuddySessionLookup。会话文件活跃快照同理：缺省注入「读不
  // 出」（fail-open，不判活跃），需要活动判据的用例自己传 workbuddySessionActivity。
  const wbCollector = (opts = {}) => testCollector({
    workbuddySessionLookup: () => null,
    workbuddySessionActivity: async () => null,
    ...opts,
  });
  const registryLookup = (sessions) => (pid) => sessions[pid] ?? null;

  it("counts exactly the two agent runtimes in the nine-process sample", async () => {
    // 一个桌面实例的真机形状：主进程 + 四个 --type= 辅助 + daemon + sidecar
    // + 两个 agent 运行时。只有最后两个算会话；其余同镜像进程只进家族集。
    const collector = wbCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(
        row(7001, 800), // GUI 主进程
        row(7002, 7001, "--type=gpu-process"),
        row(7003, 7001, "--type=renderer"),
        row(7004, 7001, "--type=utility"),
        row(7005, 7001, "--type=crashpad-handler"),
        row(7006, 7001, "--daemon-app-server-entry.js"),
        row(7007, 7001, "--sidecar-entry.js"),
        agentRow(7008, 7001),
        agentRow(7009, 7001),
      )),
    });
    const card = wb(await collector.getAgentsStatus());
    assert.equal(card.status, "running", "有 agent 运行时就要点亮卡片");
    assert.equal(card.name, "WorkBuddy");
    assert.equal(card.processCount, 2, "九个同镜像进程只有两个 agent 运行时算会话");
    assert.deepEqual(card.instances.map((i) => i.id).sort(), ["workbuddy-7008", "workbuddy-7009"]);
    assert.deepEqual(card.instances.map((i) => i.surface), ["Desktop", "Desktop"], "父是本实例 GUI 主进程 → Desktop");
  });

  it("never counts --type= helpers, daemon or sidecar", async () => {
    const collector = wbCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(
        row(7101, 800),
        row(7102, 7101, "--type=gpu-process"),
        row(7103, 7101, "--type=renderer"),
        row(7104, 7101, "--type=utility"),
        row(7105, 7101, "--type=crashpad-handler"),
        row(7106, 7101, "--daemon-app-server-entry.js"),
        row(7107, 7101, "--sidecar-entry.js"),
      )),
    });
    const card = wb(await collector.getAgentsStatus());
    assert.equal(card.processCount, 0, "辅助/daemon/sidecar 一个都不算会话");
    assert.deepEqual(card.instances.map((i) => i.id), ["workbuddy-reserved"],
      "没有会话进程就不起真实行，只剩主进程在场合成的预留行");
  });

  it("does not inflate the count when the command line is unreadable", async () => {
    // 降级轮/收尾窗口读不出命令行：镜像名不能当会话用，只有上一轮已认过的
    // 会话才按连续性保留。
    const collector = wbCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(
        row(7300, 800), // GUI 主进程
        agentRow(7301, 7300), // 真会话
        "LAPTOP,,workbuddy.exe,7300,7302", // 读不出命令行的同镜像行
      )),
    });
    const card = wb(await collector.getAgentsStatus());
    assert.equal(card.processCount, 1, "读不出命令行的行不得凭镜像名计数");
    assert.deepEqual(card.instances.map((i) => i.id), ["workbuddy-7301"]);
  });

  it("keeps the session count on a tasklist fallback round (no image-name inflation)", async () => {
    // 降级轮整轮没有命令行：九个同镜像行只凭上一轮可信扫描的会话集延续，
    // 不能按镜像名把 helper/daemon/sidecar 一起算进来。
    let t = 3000;
    let trusted = true;
    const tasklistRows = [
      7001, 7002, 7003, 7004, 7005, 7006, 7007, 7008, 7009,
    ].map((pid) => `"WorkBuddy.exe","${pid}","Console","1","100,000 K"`).join("\r\n") + "\r\n";
    const trustedScan = wmic(
      row(7001, 800),
      row(7002, 7001, "--type=gpu-process"),
      row(7003, 7001, "--type=renderer"),
      row(7004, 7001, "--type=utility"),
      row(7005, 7001, "--type=crashpad-handler"),
      row(7006, 7001, "--daemon-app-server-entry.js"),
      row(7007, 7001, "--sidecar-entry.js"),
      agentRow(7008, 7001),
      agentRow(7009, 7001),
    );
    const collector = wbCollector({
      nowFn: () => t,
      execFn: (cmd, opts, cb) => cb(null, cmd.includes("tasklist") ? tasklistRows : (trusted ? trustedScan : "")),
    });
    await collector.scanProcesses();
    trusted = false;
    t += 3000;
    await collector.scanProcesses();

    const card = wb(await collector.getAgentsStatus());
    assert.equal(card.processCount, 2, "降级轮按上一轮会话集延续，不按镜像名");
    assert.deepEqual(card.instances.map((i) => i.id).sort(), ["workbuddy-7008", "workbuddy-7009"]);
  });

  it("labels Desktop / CLI / unknown from the parent chain", async () => {
    const collector = wbCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(
        row(7400, 800), // GUI 主进程
        agentRow(7401, 7400), // 父 = GUI 主进程 → Desktop
        "LAPTOP,C:\\Windows\\System32\\cmd.exe,cmd.exe,800,7402", // 终端宿主
        agentRow(7403, 7402), // 父 = 终端 → CLI
        agentRow(7404, 9999), // 父不在扫描里 → 判不出，不贴面
      )),
    });
    const card = wb(await collector.getAgentsStatus());
    const byId = Object.fromEntries(card.instances.map((i) => [i.id, i.surface ?? null]));
    assert.equal(byId["workbuddy-7401"], "Desktop");
    assert.equal(byId["workbuddy-7403"], "CLI");
    assert.equal(byId["workbuddy-7404"], null, "判不出面时不回落成产品名");
  });

  it("maps surface labels and never shows the product name as a surface", () => {
    assert.equal(workbuddySurfaceLabel("desktop"), "Desktop");
    assert.equal(workbuddySurfaceLabel("cli"), "CLI");
    assert.equal(workbuddySurfaceLabel("WorkBuddy"), "未知");
    assert.equal(workbuddySurfaceLabel(undefined), "未知");
  });

  it("routes workbuddy traffic into the workbuddy card by agentId and UA", async () => {
    const collector = wbCollector({ execFn: (cmd, opts, cb) => cb(null, ""), nowFn: () => 3000 });
    const byId = collector.startRequest({ agentId: "workbuddy", model: "wb-1" });
    byId.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });
    const byUa = collector.startRequest({ userAgent: "WorkBuddy/5.9.3", model: "wb-1" });
    byUa.recordEnd({ status: 200, usage: { prompt_tokens: 4, completion_tokens: 2 } });

    const status = await collector.getAgentsStatus();
    const card = wb(status);
    assert.equal(card.metrics.totalRequests, 2, "agentId 与 UA 两条通道都落 workbuddyState");
    assert.equal(card.metrics.tokens.prompt, 14);
    assert.equal(card.lastModel, "wb-1");
    assert.equal(status.find((a) => a.id === "zcode").metrics.totalRequests, 0, "不得回落进 zcode 桶");
  });

  it("keeps the account continuous across a relay restart (snapshot restore)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anyswitch-metrics-workbuddy-"));
    const snapPath = join(dir, "metrics-snapshot.json");
    try {
      let t = 3000;
      const scan = wmic(row(7500, 800), agentRow(7501, 7500));
      const mk = () => wbCollector({
        nowFn: () => t,
        metricsSnapshotPath: snapPath,
        metricsSnapshotEveryMs: 30,
        execFn: (cmd, opts, cb) => cb(null, scan),
      });
      const a = mk();
      await a.scanProcesses();
      const r1 = a.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-7501", model: "m1" });
      r1.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 40 } });
      t += 100;
      await new Promise((resolve) => setTimeout(resolve, 80)); // 让快照定时器真正落一次盘

      const b = mk();
      await b.scanProcesses();
      const r2 = b.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-7501", model: "m1" });
      r2.recordEnd({ status: 200, usage: { prompt_tokens: 50, completion_tokens: 20 } });

      const card = wb(await b.getAgentsStatus());
      assert.equal(card.metrics.totalRequests, 2, "同一会话进程跨 restart 续账");
      assert.equal(card.metrics.tokens.prompt, 150);
      const restored = card.instances.find((i) => i.id === "workbuddy-7501");
      assert.ok(restored, "实例行 id 形如 workbuddy-<pid>");
      assert.equal(restored.requests, 2);
      assert.equal(restored.surface, "Desktop");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- 终端形态（R1）：launcher 用 process.execPath 再 spawn
  // `node <install>\resources\app.asar.unpacked\cli\bin\codebuddy`，镜像名是
  // node.exe。只认 WorkBuddy.exe 的判据对这条形态全盲。
  const nodeRow = (pid, ppid, args = "") =>
    `LAPTOP,"C:\\Program Files\\nodejs\\node.exe" "${RUNTIME}"${args ? ` ${args}` : ""},node.exe,${ppid},${pid}`;

  it("counts the terminal form: node.exe running cli\\bin\\codebuddy", async () => {
    // 真机行样本：node.exe "…\cli\bin\codebuddy" --resume <id>，父是本机终端宿主。
    const collector = wbCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(
        "LAPTOP,C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe,powershell.exe,900,7600",
        nodeRow(7601, 7600, "--resume 0198b8a6-4d2f-7c31-9a44-1b2c3d4e5f60"),
      )),
    });
    const card = wb(await collector.getAgentsStatus());
    assert.equal(card.processCount, 1, "终端形态的 CLI 运行时算一个会话");
    const inst = card.instances.find((i) => i.id === "workbuddy-7601");
    assert.ok(inst, "实例行 id 由引擎集占位合成 workbuddy-<pid>");
    assert.equal(inst.surface, "CLI", "父链走进终端 → CLI 面");
  });

  it("never counts the launcher's own node row", async () => {
    // launcher 自身：node 跑 workbuddy-launcher.mjs，路径不含 cli/bin/codebuddy。
    const launcher = `LAPTOP,"C:\\Program Files\\nodejs\\node.exe" "${INSTALL}\\resources\\app.asar.unpacked\\workbuddy-launcher.mjs" --port 9,node.exe,900,7700`;
    const collector = wbCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(
        "LAPTOP,C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe,powershell.exe,900,7600",
        launcher,
      )),
    });
    const card = wb(await collector.getAgentsStatus());
    assert.equal(card.processCount, 0, "启动器不是会话");
    assert.deepEqual(card.instances, []);
  });

  // ---- 面汇总（R2）：面板的面徽章只读这个字段。
  it("summarizes Desktop and CLI surfaces for the card", async () => {
    const desktop = wbCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(
        row(7001, 800),
        agentRow(7008, 7001),
        agentRow(7009, 7001),
      )),
    });
    assert.deepEqual(wb(await desktop.getAgentsStatus()).surfaces,
      [{ surface: "desktop", label: "Desktop", count: 2 }]);

    const cli = wbCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(
        "LAPTOP,C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe,powershell.exe,900,7600",
        nodeRow(7601, 7600, "--resume 0198b8a6"),
      )),
    });
    assert.deepEqual(wb(await cli.getAgentsStatus()).surfaces,
      [{ surface: "cli", label: "CLI", count: 1 }]);

    // 纯函数口径：副行加总 = 卡上进程数，读不出面的档落「未知」。
    assert.deepEqual(summarizeWorkbuddySurfaces({
      workbuddyEnginePids: new Set([1, 2]),
      workbuddySurfaceByPid: new Map([[1, "desktop"]]),
    }), [{ surface: "desktop", label: "Desktop", count: 1 }, { surface: null, label: "未知", count: 1 }]);
  });

  // ---- 预热池（R3）：空闲备用进程命令行与真会话同形，只有产品注册表能分辨。
  const prewarmRow = (pid, ppid) => row(pid, ppid, `${RUNTIME} --prewarm --prewarm-id wb-pool-3f2a`);

  it("drops idle prewarm-pool rows the registry marks as standing by", async () => {
    const cases = [
      ["kind=prewarm 且无 sessionId", { kind: "prewarm", sessionId: "" }],
      ["kind=interactive 但 sessionId 为空", { kind: "interactive", sessionId: "" }],
    ];
    for (const [label, record] of cases) {
      const collector = wbCollector({
        nowFn: () => 3000,
        workbuddySessionLookup: registryLookup({ 7801: record }),
        execFn: (cmd, opts, cb) => cb(null, wmic(row(7800, 800), prewarmRow(7801, 7800))),
      });
      const card = wb(await collector.getAgentsStatus());
      assert.equal(card.processCount, 0, `${label}：待命进程不是会话`);
      assert.deepEqual(card.instances.map((i) => i.id), ["workbuddy-reserved"],
        `${label}：待命进程不起真实行，只剩主进程在场的预留行`);
    }
  });

  it("主进程-only：卡仍 running，给一条预留会话行", async () => {
    // 主进程不算会话（processCount 0），但应用开着，卡片必须点亮并给一条零账行。
    const collector = wbCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(row(7001, 800))),
    });
    const card = wb(await collector.getAgentsStatus());
    assert.equal(card.status, "running", "家族里有人，卡片必须点亮");
    assert.equal(card.processCount, 0, "GUI 主进程不是会话");
    assert.deepEqual(card.instances.map((i) => i.id), ["workbuddy-reserved"]);
    assert.deepEqual(card.surfaces, [{ surface: "desktop", label: "Desktop", count: 1 }]);
  });

  it("daemon/sidecar/辅助进程残留不算应用开着：不点亮也不预留", async () => {
    // 主进程退出后家族成员可能短暂残留，它们没有窗口——为它们挂行就是幽灵卡。
    const collector = wbCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(
        row(7006, 800, "--daemon-app-server-entry.js"),
        row(7007, 7006, "--sidecar-entry.js"),
        row(7008, 7006, "--type=utility"),
      )),
    });
    const card = wb(await collector.getAgentsStatus());
    assert.equal(card.status, "stopped", "主进程不在，家族成员不点亮卡片");
    assert.deepEqual(card.instances, [], "也不留预留行");
  });

  it("引擎在、会话行还没铸出时可预留，面徽章只记一票", async () => {
    // 注册表列着会话、但会话文件不新鲜：会话行起不来（见占位行的活跃闸），
    // 引擎也不进活跃集（卡面真值是「会话行还活着的 runtime」）。此态卡片仍要
    // 有一行（否则落回全局汇总），面徽章只由预留行记一票，不重复计。
    const collector = wbCollector({
      nowFn: () => 3000,
      workbuddySessionLookup: registryLookup({ 100: { sessionId: "6d2c" } }),
      workbuddySessionActivity: async () => new Map(),
      execFn: (cmd, opts, cb) => cb(null, wmic(row(60, 800), agentRow(100, 60))),
    });
    await collector.scanProcesses();
    const card = wb(await collector.getAgentsStatus());
    assert.equal(card.processCount, 0, "行未铸出，引擎不进活跃集");
    assert.deepEqual(card.instances.map((i) => i.id), ["workbuddy-reserved"], "行未铸出，只留预留行");
    assert.deepEqual(card.surfaces, [{ surface: "desktop", label: "Desktop", count: 1 }], "一票，不重复");
  });

  it("有真实会话行时不再给预留行", async () => {
    const collector = wbCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(
        row(7001, 800),
        agentRow(7008, 7001),
      )),
    });
    const card = wb(await collector.getAgentsStatus());
    assert.deepEqual(card.instances.map((i) => i.id), ["workbuddy-7008"], "只有真实行");
    assert.ok(!card.instances.some((i) => i.id === "workbuddy-reserved"), "不得两行并存");
  });

  // ---- 会话粒度行（A 方案 2026-11-01）：行身份锚注册表 sessionId，不锚 pid。
  // runtime 池按回合回收换 pid（真机：同会话 20 分钟换 3 个 pid），pid 行把每次
  // 换代都演成「死一个实例、生一个零账实例」——幽灵卡。注册表反查让同一会话
  // 的新 pid 连回旧行，账续着。
  describe("WorkBuddy 会话粒度行", () => {
    it("keeps the row and its account across a runtime pid swap", async () => {
      // 同一会话 6d2c：pid 100 → 200 换代，中间一拍注册表行已删（暂停窗）。
      let t = 3000;
      let pid = 100;
      let registry = { 100: { kind: "interactive", sessionId: "6d2c", cwd: "C:\\proj\\bridge" } };
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: (p) => registry[p] ?? null,
        workbuddySessionDirectory: async () => [{ id: "6d2c", title: "bridge", pid, startedAt: t }],
        execFn: (cmd, opts, cb) => cb(null, wmic(
          row(60, 800),
          agentRow(pid, 60),
        )),
      });
      await collector.scanProcesses();
      const r1 = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-sess-6d2c", model: "m1" });
      r1.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 40 } });

      // 换代：pid 100 死、注册表行删（内核已收），一拍后 pid 200 起来接同一会话。
      t += 5000;
      pid = 200;
      registry = {};
      await collector.scanProcesses(); // 旧行进入「无引擎」态（注册表也读不出）——行须保留

      const mid = wb(await collector.getAgentsStatus());
      const midRow = mid.instances.find((i) => i.id === "workbuddy-sess-6d2c");
      assert.ok(midRow, "暂停/换代窗（注册表读不出）会话行保留，不闪没");
      assert.equal(midRow.requests, 1, "数据不清零");
      assert.equal(midRow.tokens.prompt, 100);
      assert.equal(midRow.status, "idle", "无在途请求 → 待命");

      t += 5000;
      registry = { 200: { kind: "interactive", sessionId: "6d2c", cwd: "C:\\proj\\bridge" } };
      await collector.scanProcesses();
      const r2 = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-sess-6d2c", model: "m1" });
      r2.recordEnd({ status: 200, usage: { prompt_tokens: 50, completion_tokens: 20 } });

      const card = wb(await collector.getAgentsStatus());
      assert.equal(card.instances.length, 1, "同一会话一个行，不裂成两个");
      const row1 = card.instances.find((i) => i.id === "workbuddy-sess-6d2c");
      assert.ok(row1, "会话行 id 跨 pid 换代不变");
      assert.equal(row1.requests, 2, "换代后续账");
      assert.equal(row1.tokens.prompt, 150);
      assert.equal(row1.surface, "Desktop", "面随当前 runtime 的父链");
      assert.equal(row1.title, "bridge", "标题来自注册表 cwd 基名");
      assert.ok(!card.instances.some((i) => i.id.startsWith("workbuddy-100") || i.id.startsWith("workbuddy-200")),
        "不留 pid 形幽灵行");
    });

    it("folds a pid-shaped socket-fallback row into the session row with its account", async () => {
      // 冷缓存窗口的并账形状：会话行已带自己的账，注册表反查一时读不出（换写
      // 窗口），新请求折不进会话行、按 pid 形落账；注册表跟上后，读取侧重折叠
      // 把 pid 行整行折进已存在的会话行——计数并入（不并＝冷窗口攒的账凭空清零），
      // 流量锚随账并入（扛过那些请求的引擎 pid 保住行的活跃判定）。
      let t = 3000;
      // lookup 函数在构造时固定，但它引用的 registry 可变——按阶段演化读得出/读不出。
      let registry = { 61: { kind: "interactive", sessionId: "9a3f", cwd: "C:\\proj\\bridge" } };
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: (p) => registry[p] ?? null,
        workbuddySessionDirectory: async () => [{ id: "9a3f", title: "bridge", pid: 61, startedAt: 3000 }],
        // 快照读得成（ok）但会话文件全静默：行活跃三选一只剩「扛过流量的引擎
        // pid 还活着」一条臂，流量锚有没有随折并入就在这里见分晓。
        workbuddySessionActivity: async () => new Map(),
        execFn: (cmd, opts, cb) => cb(null, wmic(row(60, 800), agentRow(61, 60))),
      });
      await collector.scanProcesses();
      const r1 = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-sess-9a3f", model: "m1" });
      r1.recordEnd({ status: 200, usage: { prompt_tokens: 20, completion_tokens: 10 } });

      // 冷缓存窗口：注册表反查读不出，请求侧归一化折不动，落 pid 形行再攒一笔账。
      t += 5000;
      registry = {};
      const r2 = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-61", model: "m1" });
      r2.recordEnd({ status: 200, usage: { prompt_tokens: 80, completion_tokens: 30 } });

      // 注册表跟上：下一轮读取触发重折叠，pid 行折进已存在的会话行并账。
      t += 5000;
      registry = { 61: { kind: "interactive", sessionId: "9a3f", cwd: "C:\\proj\\bridge" } };
      await collector.scanProcesses();
      const card = wb(await collector.getAgentsStatus());
      assert.equal(card.instances.length, 1, "pid 行折进会话行，不留 pid 形幽灵行");
      const row1 = card.instances.find((i) => i.id === "workbuddy-sess-9a3f");
      assert.ok(row1, "会话行还在");
      assert.equal(row1.requests, 2, "冷窗口攒的计数并入会话行，不清零");
      assert.equal(row1.tokens.prompt, 100, "会话行 20 ＋ pid 行 80");
      assert.equal(row1.tokens.completion, 40, "会话行 10 ＋ pid 行 30");
      assert.equal(row1.surface, "Desktop", "面随当前 runtime 的父链");
      assert.equal(row1.title, "bridge", "标题来自注册表 cwd 基名");

      // 流量锚随账并入的护栏：会话文件静默、无在途请求，行续命只剩「扛过流量
      // 的引擎 pid 还活着」——锚没并入的话，第二轮不活跃确认会连行带并进来的
      // 账一起收走。
      t += 5000;
      await collector.scanProcesses();
      const settled = wb(await collector.getAgentsStatus());
      const row2 = settled.instances.find((i) => i.id === "workbuddy-sess-9a3f");
      assert.ok(row2, "流量锚随账并入：引擎还活着，行不被不活跃判定收走");
      assert.equal(row2.requests, 2, "并账结果在后续读取里稳定");
      assert.equal(row2.tokens.prompt, 100);
    });

    it("reaps a closed session row after two confirmed absent rounds (no pause window)", async () => {
      // 环境退场：runtime 回收、注册表行删。新语义（推翻 a9aee08 的 30 分钟
      // 待命窗）：每次发请求才给会话起新环境，请求间隔里注册行本就不在，
      // 缺席即真缺席——连续 2 轮确认收行，1 轮不成判决（防读盘抖动），不再
      // 有「暂停待命、替离线会话保账」的保留窗。
      let t = 3000;
      let pid = 100;
      let registry = { 100: { kind: "interactive", sessionId: "6d2c", cwd: "C:\\proj\\bridge" } };
      // 扫描输出可变：环境退场后 runtime 行消失（GUI 宿主 60 还在，它不是会话
      // 进程）——count 两轮稳定为 0，缺席判据稳定落在家族分支上。
      let procs = () => wmic(row(60, 800), agentRow(pid, 60));
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: (p) => registry[p] ?? null,
        workbuddySessionDirectory: async () => [],
        execFn: (cmd, opts, cb) => cb(null, procs()),
      });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-sess-6d2c", model: "m1" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });

      pid = -1; registry = {}; // 全家死绝 + 注册表删净
      procs = () => wmic(row(60, 800));
      t += 60 * 1000;
      // 扫描快照有实时钟缓存：setImmediate 等内部刷新落地再扫一拍，确保
      // 本轮读吃到退场后的进程表（否则第一拍还在用旧表，判据分支漂移）。
      await collector.scanProcesses();
      await new Promise((resolve) => setImmediate(resolve));
      await collector.scanProcesses();
      assert.ok(wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
        "缺席第 1 轮：行还在（1 轮不成判决）");

      t += 5 * 1000;
      await collector.scanProcesses();
      const reaped = wb(await collector.getAgentsStatus());
      assert.deepEqual(reaped.instances.map((i) => i.id), ["workbuddy-reserved"],
        "缺席第 2 轮：会话行收走（数秒级，不再等 30 分钟待命 TTL），只剩预留行");
    });

    it("keeps the endpoint account while the session row survives, zeroes it once the row is reaped", async () => {
      // 端点级整账清零（家族全灭 + 3s 宽限）与会话行的生死是两套判据，但锚
      // 同源：行还在（缺席确认未满 2 轮）端点账不清；行被收走后端点账才轮到
      // 家族全灭判决清零——行在即账在，行走即账清。
      let t = 3000;
      let registry = { 100: { kind: "interactive", sessionId: "6d2c", cwd: "C:\\proj\\bridge" } };
      // 扫描输出可变：环境退场后 runtime 那一行消失（GUI 宿主 60 还在，它不是
      // 会话进程——命令行只有镜像路径，没有 runtime 路径）。
      let procs = () => wmic(row(60, 800), agentRow(100, 60));
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: (p) => registry[p] ?? null,
        workbuddySessionDirectory: async () => [],
        execFn: (cmd, opts, cb) => cb(null, procs()),
      });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-sess-6d2c", model: "m1" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 40 } });
      const base = wb(await collector.getAgentsStatus());
      assert.equal(base.metrics.totalRequests, 1, "基线：端点账有请求");

      // 环境退场：runtime 回收（GUI 宿主 60 还在，它不算会话进程）、注册表删净。
      registry = {};
      procs = () => wmic(row(60, 800));
      t += 60 * 1000; // 远大于 3s 通用宽限
      await collector.scanProcesses();
      await new Promise((resolve) => setImmediate(resolve)); // 等新一轮扫描落地
      await collector.scanProcesses();
      const paused = wb(await collector.getAgentsStatus());
      assert.equal(paused.processCount, 0, "会话进程已回收：端点进程数为 0");
      assert.equal(paused.metrics.totalRequests, 1, "缺席第 1 轮：行还在，端点账不清零");
      assert.equal(paused.metrics.sparkHistory.ttft.length, 1, "行还在：端点折线不清零");

      // 缺席第 2 轮：行被收走；端点账的清零判据在读路径上先于行淘汰求值，
      // 行走当拍账还在，下一拍（数秒后的一次看板轮询）落判清零。
      t += 5 * 1000;
      await collector.scanProcesses();
      const after = wb(await collector.getAgentsStatus());
      assert.deepEqual(after.instances.map((i) => i.id), ["workbuddy-reserved"],
        "缺席第 2 轮：会话行收走，只剩预留行");
      const settled = wb(await collector.getAgentsStatus());
      assert.equal(settled.metrics.totalRequests, 0, "行走后下一拍端点账清零");
    });

    it("does not spawn a placeholder row for a pid the scan no longer sees", async () => {
      // 注册表是实时读的、扫描快照可能还是旧轮（2.5s TTL 缓存）。错拍时（进程
      // 已回收、注册表行还在）占位逻辑会起一条零账 pid 行——面板闪一条幽灵
      // 卡。占位行的语义是「扫描看见了一个在跑的引擎」，所以要过本轮全量进程
      // 表这一闸。
      let t = 3000;
      const registry = { 100: { kind: "interactive", sessionId: "6d2c", cwd: "C:\\proj\\bridge" } };
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: (p) => registry[p] ?? null,
        workbuddySessionDirectory: async () => [],
        // 扫描只看见 GUI 宿主，注册表却还留着 runtime pid 100 的行
        execFn: (cmd, opts, cb) => cb(null, wmic(row(60, 800))),
      });
      await collector.scanProcesses();
      const card = wb(await collector.getAgentsStatus());
      assert.deepEqual(card.instances.map((i) => i.id), ["workbuddy-reserved"],
        "扫描没见过的 pid 不起真实占位行（注册表残影不算），只剩主进程在场的预留行");
      assert.equal(card.processCount, 0);
    });

    it("reaps a closed session row after the registry stops listing it, two rounds later", async () => {
      // 用户关会话：注册表行删（目录扫描成功但没这个 sessionId）、该会话的
      // runtime 退场，但家族活着（另一条会话的 runtime 撑着 count>0）——
      // 家族缺席判据管不到，旧机制只能等 30 分钟空闲 TTL。新判据：注册表
      // 缺席连续 2 轮确认收行（1 轮不成判决），数秒级，无宽限窗。
      let t = 3000;
      let registry = {
        100: { kind: "interactive", sessionId: "6d2c", cwd: "C:\\proj\\bridge" },
        200: { kind: "interactive", sessionId: "bbbb", cwd: "C:\\proj\\other" },
      };
      let dir = () => [
        { id: "6d2c", title: "bridge", pid: 100, startedAt: 1000 },
        { id: "bbbb", title: "other", pid: 200, startedAt: 2000 },
      ];
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: (p) => registry[p] ?? null,
        workbuddySessionDirectory: async () => dir(),
        execFn: (cmd, opts, cb) => cb(null, wmic(
          row(60, 800), // GUI 主进程：只进家族集
          agentRow(200, 60), // 另一条会话的 runtime：撑住 count>0
          agentRow(100, 60),
        )),
      });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-sess-6d2c", model: "m1" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });
      assert.ok(wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
        "开着时有行");

      // 关会话：注册行删、pid 100 退场；pid 200 那条还开着。
      t += 60 * 1000;
      registry = { 200: registry[200] };
      dir = () => [{ id: "bbbb", title: "other", pid: 200, startedAt: 2000 }];
      await collector.scanProcesses();
      assert.ok(wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
        "缺席第 1 轮：行还在（1 轮不成判决，防读盘抖动）");

      t += 5 * 1000;
      await collector.scanProcesses();
      assert.ok(!wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
        "缺席第 2 轮：半死空行收走（数秒级，不再等 30 分钟）");
      assert.ok(wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-bbbb"),
        "还开着的那条不受牵连");
    });

    it("keeps an open-but-idle session row and its account (registry says open)", async () => {
      // 注册表说会话开着：行不吃空闲淘汰，账不清零——旧机制 30 分钟 TTL 到点
      // 后占位重铸零账行的「活着却丢了账」一并消失。
      let t = 3000;
      const registry = { 100: { kind: "interactive", sessionId: "6d2c", cwd: "C:\\proj\\bridge" } };
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: (p) => registry[p] ?? null,
        workbuddySessionDirectory: async () => [{ id: "6d2c", title: "bridge", pid: 100, startedAt: 1000 }],
        execFn: (cmd, opts, cb) => cb(null, wmic(row(60, 800), agentRow(100, 60))),
      });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-sess-6d2c", model: "m1" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 40 } });

      t += 40 * 60 * 1000; // 静置 40 分钟 > 旧 30 分钟 TTL
      await collector.scanProcesses();
      const sessRow = wb(await collector.getAgentsStatus()).instances.find((i) => i.id === "workbuddy-sess-6d2c");
      assert.ok(sessRow, "注册表说开着：静置再久行也在");
      assert.equal(sessRow.requests, 1, "账不清零");
      assert.equal(sessRow.tokens.prompt, 100);
    });

    it("holds a registry-absent row while its request is still in flight", async () => {
      // runtime 崩在请求中间：注册行没了但在途请求还在。在途＝会话还在被
      // 服务的证据，缺席轮次确认到线也不收，等它落定再判。
      let t = 3000;
      let registry = { 100: { kind: "interactive", sessionId: "6d2c", cwd: "C:\\proj\\bridge" } };
      let dir = () => [{ id: "6d2c", title: "bridge", pid: 100, startedAt: 1000 }];
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: (p) => registry[p] ?? null,
        workbuddySessionDirectory: async () => dir(),
        execFn: (cmd, opts, cb) => cb(null, wmic(row(60, 800), agentRow(100, 60))),
      });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-sess-6d2c", model: "m1" });

      t += 60 * 1000; // 注册行删，缺席计轮中，但请求在途
      registry = {};
      dir = () => [];
      await collector.scanProcesses();
      assert.ok(wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
        "在途请求压着：行不收");

      r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });
      t += 5 * 1000; // 缺席第 2 轮：在途已落定
      await collector.scanProcesses();
      assert.ok(!wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
        "请求落定后缺席满 2 轮：下一拍收行");
    });

    // ---- 子代理会话行（2026-11-05）：WorkBuddy 的子代理跑在主 runtime 进程内，
    // 各带独立 x-conversation-id 头，注册表永远只记主会话——子会话行注册表
    // 配不上键，徽标与存活都只能吃「扛过本行流量的引擎 pid」（wbTrafficPid），
    // relay 侧在头通道命中时随 meta 捎带（workbuddyClientPid）。
    it("badges a subagent conversation row via the traffic pid (registry never lists sub-conversations)", async () => {
      let t = 3000;
      const registry = { 100: { kind: "interactive", sessionId: "6d2c", cwd: "C:\\proj\\bridge" } };
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: (p) => registry[p] ?? null,
        workbuddySessionDirectory: async () => [{ id: "6d2c", title: "bridge", pid: 100, startedAt: 1000 }],
        workbuddySessionActivity: async () => new Map(),
        execFn: (cmd, opts, cb) => cb(null, wmic(row(60, 800), agentRow(100, 60))),
      });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-sess-sub1", workbuddyClientPid: 100, model: "m1" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });
      const card = wb(await collector.getAgentsStatus());
      const subRow = card.instances.find((i) => i.id === "workbuddy-sess-sub1");
      assert.ok(subRow, "子代理会话行在列");
      assert.equal(subRow.surface, "Desktop", "徽标回落到扛流量的引擎 pid 的面（与主会话同进程同面）");
    });

    it("keeps a registry-absent subagent row between requests while its engine pid lives", async () => {
      // 子代理行注册表永远缺席：缺席轮次照收＝请求间隙行下场、下一笔请求再起
      // 新行、计数清零（真机：同一行 65→3 请求）。扛过流量的引擎 pid 还活着时
      // 行钉住不下场；引擎退场后照旧 2 轮确认收走。
      let t = 3000;
      let withEngine = true;
      const registry = { 100: { kind: "interactive", sessionId: "6d2c", cwd: "C:\\proj\\bridge" } };
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: (p) => registry[p] ?? null,
        workbuddySessionDirectory: async () => [{ id: "6d2c", title: "bridge", pid: 100, startedAt: 1000 }],
        workbuddySessionActivity: async () => new Map(),
        execFn: (cmd, opts, cb) => cb(null, wmic(
          row(60, 800),
          ...(withEngine ? [agentRow(100, 60)] : []),
        )),
      });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-sess-sub1", workbuddyClientPid: 100, model: "m1" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });

      // 请求间隙（引擎活着）：行与账都保持，不抖。
      for (let i = 0; i < 3; i++) {
        t += 5 * 1000;
        await collector.scanProcesses();
        await collector.getAgentsStatus();
      }
      const mid = wb(await collector.getAgentsStatus());
      const midRow = mid.instances.find((i) => i.id === "workbuddy-sess-sub1");
      assert.ok(midRow, "引擎活着：请求间隙行不下场");
      assert.equal(midRow.requests, 1, "计数不清零");

      // 引擎退场：扫描是 stale-while-revalidate（当拍吐旧快照、后台换新），先
      // 让无引擎那一轮落地，再数缺席轮次。
      withEngine = false;
      t += 5 * 1000;
      await collector.scanProcesses();
      await collector.getAgentsStatus(); // 无引擎快照落地（这拍仍伺服旧快照）
      t += 5 * 1000;
      await collector.scanProcesses();
      assert.ok(wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-sub1"),
        "缺席第 1 轮：行还在（1 轮不成判决）");
      t += 5 * 1000;
      await collector.scanProcesses();
      assert.ok(!wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-sub1"),
        "引擎退场后缺席满 2 轮：行收走");
    });

    it("keeps the main session row and the process count while its engine serves subagents", async () => {
      // 子代理整段跑：主会话自己的流量停、会话文件静默、注册表还开着——行
      // 活跃只剩「扛过本行流量的引擎 pid 活着」一臂。头通道身份解析不出 pid，
      // relay 捎带的 workbuddyClientPid 把锚补上：主行不下场、processCount 不
      // 归零、分面副行不空（真机：主行被收走、卡上进程数 0、surfaces 空）。
      let t = 3000;
      const registry = { 100: { kind: "interactive", sessionId: "6d2c", cwd: "C:\\proj\\bridge" } };
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: (p) => registry[p] ?? null,
        workbuddySessionDirectory: async () => [{ id: "6d2c", title: "bridge", pid: 100, startedAt: 1000 }],
        workbuddySessionActivity: async () => new Map(),
        execFn: (cmd, opts, cb) => cb(null, wmic(row(60, 800), agentRow(100, 60))),
      });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-sess-6d2c", workbuddyClientPid: 100, model: "m1" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 40 } });

      // 主会话流量停（子代理在跑）：文件静默超过 2 分钟活跃窗、无在途。
      t += 3 * 60 * 1000;
      await collector.scanProcesses();
      await collector.getAgentsStatus(); // 不活跃确认第 1 轮
      t += 5 * 1000;
      await collector.scanProcesses();
      const card = wb(await collector.getAgentsStatus()); // 第 2 轮：旧机制此处已收行
      const mainRow = card.instances.find((i) => i.id === "workbuddy-sess-6d2c");
      assert.ok(mainRow, "流量 pid 活着：主行不下场");
      assert.equal(mainRow.requests, 1, "账不清零");
      assert.equal(card.processCount, 1, "会话行活着 → 进程计数不归零");
      assert.deepEqual(card.surfaces.map((s) => [s.label, s.count]), [["Desktop", 1]], "分面副行保持");
    });

    it("falls open when the registry directory cannot be read (TTL fallback intact)", async () => {
      // 目录读不出 ≠ 没有会话：fail-open 不判生死，行按 5 分钟兜底 TTL 走
      //（判不了生死就不按缺席收，只按静默收）。
      let t = 3000;
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: () => null,
        workbuddySessionDirectory: async () => { throw new Error("EACCES"); },
        execFn: (cmd, opts, cb) => cb(null, wmic(row(60, 800), agentRow(200, 60))),
      });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-sess-6d2c", model: "m1" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });

      t += 60 * 1000; // 静置 1 分钟 < 5 分钟兜底 TTL
      await collector.scanProcesses();
      assert.ok(wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
        "注册表读不出：fail-open，行保留");

      t += 5 * 60 * 1000; // 超过 5 分钟兜底 TTL
      await collector.scanProcesses();
      assert.ok(!wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
        "兜底 TTL 仍在：判不了生死的孤儿行不永挂");
    });

    it("treats a registry row whose pid died as absent (crash orphan files)", async () => {
      // 内核崩溃没清注册文件：文件还在但 pid 早死了，家族由另一条活会话撑着。
      // 孤儿注册行按缺席处理，2 轮确认收行，不给半死行留永挂后门。
      let t = 3000;
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: () => null,
        workbuddySessionDirectory: async () => [{ id: "6d2c", title: "bridge", pid: 100, startedAt: 1000 }],
        execFn: (cmd, opts, cb) => cb(null, wmic(row(60, 800), agentRow(200, 60))),
      });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-sess-6d2c", model: "m1" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });
      assert.ok(wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
        "孤儿文件在场：第一拍行还在，缺席计时从这一拍起走");

      t += 5 * 1000;
      await collector.scanProcesses();
      assert.ok(!wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
        "孤儿注册行（pid 死）按缺席处理，第 2 轮收行");
    });

    it("reaps a registry-open row whose conversation file has gone quiet (pre-acquired runtime)", async () => {
      // 产品侧的过渡态 runtime（预取给下一回合/待释放）：注册表列着、pid 活着，
      // 但会话文件早不写了、也没有在途或扛流量的 pid——「活跃会话数+1」的幽灵
      // 卡正是它。行连续 2 轮不活跃即收（与注册表缺席同一确认口径，数秒级）。
      let t = 3000;
      let fileAgeMs = 10 * 1000; // 回合刚跑完：文件还在活跃窗内
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: registryLookup({ 100: { kind: "interactive", sessionId: "6d2c", cwd: "C:\\proj\\bridge" } }),
        workbuddySessionDirectory: async () => [{ id: "6d2c", title: "bridge", pid: 100, startedAt: 1000 }],
        workbuddySessionActivity: async () => new Map([["6d2c", t - fileAgeMs]]),
        execFn: (cmd, opts, cb) => cb(null, wmic(row(60, 800), agentRow(100, 60))),
      });
      await collector.scanProcesses();
      assert.ok(wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
        "会话文件在写：行在");

      t += 60 * 1000;
      fileAgeMs = 3 * 60 * 1000; // 文件静默 3 分钟（预取 runtime 挂着，会话不在跑）
      await collector.scanProcesses();
      assert.ok(wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
        "不活跃第 1 轮：行还在（1 轮不成判决）");

      t += 5 * 1000;
      fileAgeMs = 3 * 60 * 1000 + 5 * 1000;
      await collector.scanProcesses();
      assert.ok(!wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
        "不活跃满 2 轮：幽灵行收走（注册表还列着也收）");
    });

    it("keeps a quiet-file row while the runtime that carried its traffic lives (long tool run)", async () => {
      // 长工具调用：会话文件静默、无在途请求，但扛过这条会话流量的引擎进程还
      // 在跑（回合没结束）——行不能闪没。预取态 runtime 从未扛过流量，拿不到
      // 这条保护，与上一条用例合成幽灵/活会话的分界。
      let t = 3000;
      let fileAgeMs = 10 * 1000;
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: registryLookup({ 100: { kind: "interactive", sessionId: "6d2c", cwd: "C:\\proj\\bridge" } }),
        workbuddySessionDirectory: async () => [{ id: "6d2c", title: "bridge", pid: 100, startedAt: 1000 }],
        workbuddySessionActivity: async () => new Map([["6d2c", t - fileAgeMs]]),
        execFn: (cmd, opts, cb) => cb(null, wmic(row(60, 800), agentRow(100, 60))),
      });
      await collector.scanProcesses();
      // 流量走 pid 形再折进会话行（socket 兜底的真实形态）：行上记下扛流量的 pid。
      const r = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-100", model: "m1" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });
      assert.ok(wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
        "pid 形流量折进会话行");

      for (let round = 0; round < 4; round += 1) {
        t += 60 * 1000;
        fileAgeMs += 60 * 1000; // 文件静默越滚越旧，早已超过活跃窗
        await collector.scanProcesses();
        assert.ok(wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
          `扛流量的 runtime 还活着：第 ${round + 1} 轮行不收`);
      }
    });

    it("keeps a quiet-file row while its request is in flight", async () => {
      // 在途请求本身就是会话在被服务的证据：文件静默也不收（覆盖「回合刚起、
      // 首个事件还没落盘」的窗口）。
      let t = 3000;
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: registryLookup({ 100: { kind: "interactive", sessionId: "6d2c", cwd: "C:\\proj\\bridge" } }),
        workbuddySessionDirectory: async () => [{ id: "6d2c", title: "bridge", pid: 100, startedAt: 1000 }],
        workbuddySessionActivity: async () => new Map([["6d2c", t - 5 * 60 * 1000]]),
        execFn: (cmd, opts, cb) => cb(null, wmic(row(60, 800), agentRow(100, 60))),
      });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-100", model: "m1" });
      for (let round = 0; round < 3; round += 1) {
        t += 60 * 1000;
        await collector.scanProcesses();
        assert.ok(wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
          `在途请求压着：第 ${round + 1} 轮行不收`);
      }
      r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });
    });

    it("does not spawn a session placeholder for a runtime whose conversation file is quiet", async () => {
      // 预取/待释放的 runtime：注册表列着 interactive、pid 活着，但它的会话文件
      // 早不写了——占位行不再为它起行。对照组：会话文件在写的 runtime 照常起行。
      // （这也是标题生成等一次性会话不入卡的同一道闸：它们没有会话文件。）
      let t = 3000;
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: registryLookup({
          100: { kind: "interactive", sessionId: "ghost1", cwd: "C:\\proj\\bridge" },
          200: { kind: "interactive", sessionId: "live1", cwd: "C:\\proj\\bridge" },
        }),
        workbuddySessionDirectory: async () => [
          { id: "ghost1", title: "bridge", pid: 100, startedAt: 1000 },
          { id: "live1", title: "bridge", pid: 200, startedAt: 2000 },
        ],
        workbuddySessionActivity: async () => new Map([
          ["ghost1", t - 5 * 60 * 1000],
          ["live1", t - 10 * 1000],
        ]),
        execFn: (cmd, opts, cb) => cb(null, wmic(row(60, 800), agentRow(100, 60), agentRow(200, 60))),
      });
      await collector.scanProcesses();
      const card = wb(await collector.getAgentsStatus());
      assert.ok(!card.instances.some((i) => i.id === "workbuddy-sess-ghost1"),
        "文件静默的预取 runtime 不起会话行");
      assert.ok(card.instances.some((i) => i.id === "workbuddy-sess-live1"),
        "文件在写的会话照常起行");
    });

    it("card process count and surface badges follow the active session set", async () => {
      // 卡面三处数字一个真值：行数、进程计数、Desktop ×N 徽章都只数活跃会话的
      // runtime，预取 runtime 不进数——否则「实例 1 行、徽章 Desktop ×2」对不上。
      let t = 3000;
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: registryLookup({
          100: { kind: "interactive", sessionId: "ghost1", cwd: "C:\\proj\\bridge" },
          200: { kind: "interactive", sessionId: "live1", cwd: "C:\\proj\\bridge" },
        }),
        workbuddySessionDirectory: async () => [
          { id: "ghost1", title: "bridge", pid: 100, startedAt: 1000 },
          { id: "live1", title: "bridge", pid: 200, startedAt: 2000 },
        ],
        workbuddySessionActivity: async () => new Map([
          ["ghost1", t - 5 * 60 * 1000],
          ["live1", t - 10 * 1000],
        ]),
        execFn: (cmd, opts, cb) => cb(null, wmic(row(60, 800), agentRow(100, 60), agentRow(200, 60))),
      });
      await collector.scanProcesses();
      const card = wb(await collector.getAgentsStatus());
      assert.equal(card.processCount, 1, "只数活跃会话的 runtime");
      assert.deepEqual(card.surfaces, [{ surface: "desktop", label: "Desktop", count: 1 }],
        "面徽章同口径：预取 runtime 不进 Desktop ×N");
    });

    it("fails open when the conversation-activity scan cannot read", async () => {
      // 会话文件读不出 ≠ 会话不在跑：该轮不按「不活跃」收行、占位照旧——与
      // 注册表读不出的 fail-open 同一口径。
      let t = 3000;
      const collector = wbCollector({
        nowFn: () => t,
        workbuddySessionLookup: registryLookup({ 100: { kind: "interactive", sessionId: "6d2c", cwd: "C:\\proj\\bridge" } }),
        workbuddySessionDirectory: async () => [{ id: "6d2c", title: "bridge", pid: 100, startedAt: 1000 }],
        workbuddySessionActivity: async () => null,
        execFn: (cmd, opts, cb) => cb(null, wmic(row(60, 800), agentRow(100, 60))),
      });
      await collector.scanProcesses();
      const r = collector.startRequest({ agentId: "workbuddy", instanceId: "workbuddy-100", model: "m1" });
      r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });
      for (let round = 0; round < 3; round += 1) {
        t += 60 * 1000;
        await collector.scanProcesses();
        assert.ok(wb(await collector.getAgentsStatus()).instances.some((i) => i.id === "workbuddy-sess-6d2c"),
          `活动快照读不出：fail-open，第 ${round + 1} 轮行保留`);
      }
    });
  });

  it("counts a registry-less row and the live --prewarm row that is serving a session", async () => {
    // 没有注册表：按命令行判据照常计数（宁可多算，不静默漏）。
    const noRegistry = wbCollector({
      nowFn: () => 3000,
      workbuddySessionLookup: () => null,
      execFn: (cmd, opts, cb) => cb(null, wmic(row(7800, 800), prewarmRow(7801, 7800))),
    });
    assert.equal(wb(await noRegistry.getAgentsStatus()).processCount, 1, "读不出注册表 → 照旧计数");

    // 真机那条 --prewarm 行注册表是 kind:"interactive" 且有 sessionId：正在服务。
    const serving = wbCollector({
      nowFn: () => 3000,
      workbuddySessionLookup: registryLookup({ 7801: { kind: "interactive", sessionId: "0199c1a2-3b4d" } }),
      execFn: (cmd, opts, cb) => cb(null, wmic(row(7800, 800), prewarmRow(7801, 7800))),
    });
    const card = wb(await serving.getAgentsStatus());
    assert.equal(card.processCount, 1, "正在服务的 --prewarm 进程继续计数");
    // 会话行（A 方案 2026-11-01）：注册表给 sessionId 的引擎行落会话粒度 id，
    // pid 形只属于读不出注册表的行。
    assert.deepEqual(card.instances.map((i) => i.id), ["workbuddy-sess-0199c1a2-3b4d"]);

    assert.equal(workbuddySessionIsIdlePrewarm(null), false, "读不出注册表不等于待命");
    assert.equal(workbuddySessionIsIdlePrewarm({ kind: "prewarm" }), true);
    assert.equal(workbuddySessionIsIdlePrewarm({ kind: "interactive", sessionId: "s" }), false);
  });

  // 配置根只有一份实现（写入器 workbuddy-merge-models.workbuddyConfigRoot）：它认
  // WORKBUDDY_CONFIG_DIR / CODEBUDDY_CONFIG_DIR 两个变量，扫描必须读同一棵树，否则
  // 只设后者时注册表读不到、预热池判据静默失效。这条用例因此**不注入** lookup：
  // 走的就是默认的磁盘读取口，只把环境变量指向临时根（不碰真实 ~/.workbuddy）。
  it("reads the registry from CODEBUDDY_CONFIG_DIR — the same root the writer uses", async () => {
    const root = mkTestDir("anyswitch-wb-config-root-");
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(join(root, "sessions", "7901.json"), JSON.stringify({ kind: "prewarm", sessionId: "" }));

    const collector = testCollector({
      nowFn: () => 3000,
      env: { CODEBUDDY_CONFIG_DIR: root },
      execFn: (cmd, opts, cb) => cb(null, wmic(row(7900, 800), prewarmRow(7901, 7900))),
    });
    const card = wb(await collector.getAgentsStatus());
    assert.equal(card.processCount, 0, "只设 CODEBUDDY_CONFIG_DIR 也要读到注册表，待命进程不计数");
    assert.deepEqual(card.instances.map((i) => i.id), ["workbuddy-reserved"],
      "待命进程不起真实行，只剩主进程在场的预留行");
  });

  it("options.env 优先于 process.env：注入的根决定读哪棵注册表", async () => {
    const injected = mkTestDir("anyswitch-wb-env-injected-");
    const ambient = mkTestDir("anyswitch-wb-env-ambient-");
    // 两棵树对同一 pid 给出相反答案：读到注入的根 → 待命（0），误读 process.env
    // 的根 → 正在服务（1）。
    for (const [dir, record] of [
      [injected, { kind: "prewarm" }],
      [ambient, { kind: "interactive", sessionId: "0199c1a2-3b4d" }],
    ]) {
      mkdirSync(join(dir, "sessions"), { recursive: true });
      writeFileSync(join(dir, "sessions", "7951.json"), JSON.stringify(record));
    }
    const saved = process.env.CODEBUDDY_CONFIG_DIR;
    process.env.CODEBUDDY_CONFIG_DIR = ambient;
    try {
      const collector = testCollector({
        nowFn: () => 3000,
        env: { CODEBUDDY_CONFIG_DIR: injected },
        execFn: (cmd, opts, cb) => cb(null, wmic(row(7950, 800), prewarmRow(7951, 7950))),
      });
      assert.equal(wb(await collector.getAgentsStatus()).processCount, 0, "options.env 的根覆盖 process.env");
    } finally {
      if (saved === undefined) delete process.env.CODEBUDDY_CONFIG_DIR;
      else process.env.CODEBUDDY_CONFIG_DIR = saved;
    }
  });

  // ---- 终端归属（R4）：workbuddy 进 detected feed 后，终端页签才能绑定端点。
  it("lets a terminal session bind the workbuddy endpoint and its pid row", async () => {
    const collector = wbCollector({
      nowFn: () => 3000,
      execFn: (cmd, opts, cb) => cb(null, wmic(
        "LAPTOP,C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe,powershell.exe,900,7600",
        nodeRow(7601, 7600, "--resume 0198b8a6"),
      )),
    });
    const status = await collector.getAgentsStatus();
    const detected = collector.getDetectedClientProcesses();
    assert.deepEqual(
      detected.map((d) => [d.agentId, d.pid, d.ancestors]),
      [["workbuddy", 7601, [7600, 900]]],
      "引擎集进 detected feed，祖链穿过终端宿主",
    );
    const [session] = attributeTerminalSessions([{ id: "t1", pid: 7600 }], detected, status);
    assert.equal(session.agent.endpointId, "workbuddy");
    assert.equal(session.agent.name, "WorkBuddy");
    assert.equal(session.agent.pid, 7601);
    assert.equal(session.agent.instanceId, "workbuddy-7601", "占位行在，pid 形行就能绑定");
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
      "LAPTOP,C:\\WINDOWS\\system32\\cmd.exe /d /s /c \"wmic process where \"name='ZCode.exe' or name='claude.exe' or name='opencode.exe' or name='dsh.exe' or name='pi.exe' or name='Qoder.exe' or name='codex.exe' or name='codex-code-mode-host.exe' or name='codex-command-runner.exe' or name='ChatGPT.exe' or name='grok.exe' or name='node.exe' or name='cmd.exe'\" get ProcessId,ParentProcessId,CommandLine,Name /format:csv\",cmd.exe,5184,7300",
      ...extraRows,
    ].join("\r\n") + "\r\n";
  const allZero = (p) => ({
    zcode: p.zcode, claude: p.claude, dsh: p.dsh,
    kimi: p.kimi, pi: p.pi, opencode: p.opencode, qoder: p.qoder, codex: p.codex, grok: p.grok,
  });

  it("wmic wrapper row carrying every agent name literal counts as nothing", async () => {
    const execFn = (cmd, opts, cb) => cb(null, wmicWrapper());
    const collector = testCollector({ execFn, nowFn: () => 10000 });
    const p = await collector.scanProcesses();
    assert.deepEqual(allZero(p), { zcode: 0, claude: 0, dsh: 0, kimi: 0, pi: 0, opencode: 0, qoder: 0, codex: 0, grok: 0 },
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

// pi 原生形态（上游发布的原生 pi.exe）计数：PS 白名单本就拉取 pi.exe 行，但
// 桶表缺席时行→桶查不到即跳过——原生行只进谱系表，不进任何计数（2026-10-25
// 体检：原生形态潜伏漏计，现状 npm 形态不受影响）。这里钉三件事：原生行直接
// 计入 pi；「pi.exe 父＋node 子」谱系只算一次；npm 形态既有行为不回归。
describe("pi 原生形态计数（pi.exe 镜像桶）", () => {
  // PowerShell 探测行格式 <pid>,<ppid>,<name>,<cmdline>（同终端归属面夹具）
  const psScan = (rows) => rows.join("\r\n") + "\r\n";
  const nativePi = String.raw`7000,9000,pi.exe,C:\Tools\pi\pi.exe --session`;
  const scan = async (rows) => {
    const execFn = (cmd, opts, cb) => cb(null, psScan(rows));
    const collector = testCollector({ execFn, nowFn: () => 10000 });
    return collector.scanProcesses();
  };

  it("native pi.exe row counts into pi and joins the pid set", async () => {
    const p = await scan([nativePi]);
    assert.equal(p.pi, 1);
    assert.ok(p.piPids.has(7000), "pid 进 piPids（run 锚与终端归属面都吃这个集合）");
  });

  it("panel face: a lone native pi.exe marks the pi card running with processCount 1", async () => {
    const execFn = (cmd, opts, cb) => cb(null, psScan([nativePi]));
    const collector = testCollector({ execFn, nowFn: () => 10000 });
    const status = await collector.getAgentsStatus();
    const pi = status.find((a) => a.id === "pi");
    assert.equal(pi.status, "running");
    assert.equal(pi.processCount, 1);
  });

  it("pi.exe parent + node child (pi paths) counts once: the node row is suppressed", async () => {
    const p = await scan([
      String.raw`7000,9000,pi.exe,C:\Tools\pi\pi.exe`,
      String.raw`7100,7000,node.exe,C:\Tools\pi\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js`,
    ]);
    assert.equal(p.pi, 1, "同一会话两种形态并存时只算一次");
    assert.ok(p.piPids.has(7000), "会话记在原生 pi.exe 名下");
    assert.equal(p.piPids.has(7100), false, "node 子行不重复计数");
  });

  it("suppression crosses a cmd /c shim between the pi.exe parent and the node child", async () => {
    const p = await scan([
      String.raw`7000,9000,pi.exe,C:\Tools\pi\pi.exe`,
      String.raw`7050,7000,cmd.exe,C:\WINDOWS\system32\cmd.exe /d /s /c "C:\Program Files\nodejs\node.exe" C:\Tools\pi\bin\pi.js`,
      String.raw`7100,7050,node.exe,"C:\Program Files\nodejs\node.exe" C:\Tools\pi\bin\pi.js`,
    ]);
    assert.equal(p.pi, 1);
    assert.ok(p.piPids.has(7000));
    assert.equal(p.piPids.has(7100), false, "隔垫片的 node 子行同样被压掉");
  });

  it("npm-form pi beside an unrelated native pi.exe counts both", async () => {
    const p = await scan([
      nativePi,
      String.raw`4321,500,node.exe,C:\Users\tester\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\cli.js`,
    ]);
    assert.equal(p.pi, 2, "两个独立会话各算一次：npm 形态不受邻近 pi.exe 压制");
    assert.ok(p.piPids.has(7000));
    assert.ok(p.piPids.has(4321));
  });

  it("lineage table keeps every pi.exe row whether or not a branch claims it", async () => {
    const p = await scan([nativePi]);
    assert.equal(p.ppidByPid.get(7000), 9000);
    assert.ok(p.seenPids.has(7000));
  });

  it("tasklist rows (no command line) count pi.exe accept-by-name", async () => {
    const csv = '"pi.exe","7000","Console","1","55,000 K"\r\n';
    const execFn = (cmd, opts, cb) => cb(null, csv);
    const collector = testCollector({ execFn, nowFn: () => 10000 });
    const p = await collector.scanProcesses();
    assert.equal(p.pi, 1);
    assert.ok(p.piPids.has(7000));
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
    assert.equal(card.sessions[0].id, "claude-24956");
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
    assert.equal(card.sessions[0].id, "claude-24956");
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
    assert.equal(card.sessions[0].id, "claude-5555");
  });
});

describe("claude desktop form folding (MSIX shell + managed engine → one claude-desktop row)", () => {
  const wmic = (rows) => `Node,CommandLine,Name,ProcessId\r\n${rows.join("\r\n")}\r\n`;
  const claude = (status) => status.find((a) => a.id === "claude");
  const SHELL = "C:\\Program Files\\WindowsApps\\Claude_1.37937.1.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe";
  const ENGINE_3P = "C:\\Users\\u\\AppData\\Local\\Claude-3p\\claude-code\\2.1.246\\claude.exe";

  it("classifies desktop shell/engine image paths and rejects CLI or unknown shapes", () => {
    // MSIX 桌面壳（真机包路径形状 1.37937.1.0），主进程与 --type= 助手同一形态
    assert.equal(claudeDesktopForm(SHELL), "desktop");
    assert.equal(claudeDesktopForm(`${SHELL} --type=renderer`), "desktop");
    assert.equal(claudeDesktopForm(`"${SHELL}"`), "desktop");
    // 桌面托管引擎的三个根（3p 真机旧布局取证 claude-code\2.1.246\claude.exe）
    assert.equal(claudeDesktopForm(ENGINE_3P), "desktop");
    assert.equal(claudeDesktopForm("C:\\Users\\u\\AppData\\Local\\Claude\\claude-code\\2.1.246\\claude.exe"), "desktop");
    assert.equal(claudeDesktopForm("C:\\Users\\u\\.claude\\claude-code\\2.1.246\\claude.exe"), "desktop");
    // 新布局（Desktop 2.37337.1.0 / 引擎 2.1.295 真机取证）：semver 与 exe 之间
    // 垫一层构建哈希目录（claude-code\2.1.295\d2e29494ec83\claude.exe），三个根同
    // 规则；真实引擎命令行拖着一大串 --flag 尾巴，照样命中
    assert.equal(claudeDesktopForm("C:\\Users\\u\\AppData\\Local\\Claude-3p\\claude-code\\2.1.295\\d2e29494ec83\\claude.exe"), "desktop");
    assert.equal(claudeDesktopForm("C:\\Users\\u\\AppData\\Local\\Claude\\claude-code\\2.1.295\\4b49b5f1c422\\claude.exe"), "desktop");
    assert.equal(claudeDesktopForm("C:\\Users\\u\\.claude\\claude-code\\2.1.295\\d2e29494ec83\\claude.exe --output-format stream-json"), "desktop");
    // 至多垫一层：更深的嵌套不在白名单形状内，退回逐 PID 旧行
    assert.equal(claudeDesktopForm("C:\\Users\\u\\AppData\\Local\\Claude-3p\\claude-code\\2.1.295\\d2e29494ec83\\nested\\claude.exe"), null);
    // npm 全局 CLI：claude-code 的下一段是 bin 而非 semver —— 不折
    assert.equal(claudeDesktopForm("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"), null);
    // 引擎根锚定用户目录布局：%LOCALAPPDATA%\claude 根照样折
    assert.equal(claudeDesktopForm("C:\\Users\\u\\AppData\\Local\\claude\\claude-code\\9.9.9\\claude.exe"), "desktop");
    // 非用户目录下同名的 claude 目录（用户手工维护的同形副本）不认，退回逐 PID 旧行
    assert.equal(claudeDesktopForm("D:\\tools\\claude\\claude-code\\9.9.9\\claude.exe"), null);
    // 白名单外路径 / 无命令行：认不出，退回逐 PID 旧行为
    assert.equal(claudeDesktopForm("C:\\Programs\\claude.exe"), null);
    assert.equal(claudeDesktopForm(""), null);
    assert.equal(claudeDesktopForm(null), null);
  });

  it("exposes the Desktop badge token only for the desktop form", () => {
    assert.equal(claudeSurfaceLabel("desktop"), "Desktop");
    assert.equal(claudeSurfaceLabel("cli"), "TUI");
    assert.equal(claudeSurfaceLabel(null), null);
  });

  it("folds the multi-process MSIX shell (≈5 pids) into a single claude-desktop row", async () => {
    const csv = wmic([
      `LAPTOP,${SHELL},Claude.exe,6200`,
      `LAPTOP,${SHELL} --type=gpu-process,Claude.exe,6201`,
      `LAPTOP,${SHELL} --type=renderer,Claude.exe,6202`,
      `LAPTOP,${SHELL} --type=utility,Claude.exe,6203`,
      `LAPTOP,${SHELL} --type=crashpad-handler,Claude.exe,6204`,
    ]);
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => 10000 });

    const card = claude(await collector.getAgentsStatus());
    assert.equal(card.processCount, 5, "card process count keeps counting the whole family");
    assert.equal(card.sessionsCount, 1, "one desktop form — one instance row");
    assert.equal(card.sessions[0].id, "claude-desktop");
    assert.equal(card.sessions[0].surface, "Desktop");
    assert.equal(card.sessions[0].requests, 0);
    assert.equal(card.sessions[0].status, "idle");
  });

  it("folds same-image desktop engine pids into the same synthetic row", async () => {
    const csv = wmic([
      `LAPTOP,${ENGINE_3P},claude.exe,6100`,
      `LAPTOP,${ENGINE_3P},claude.exe,6101`,
    ]);
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => 10000 });

    const card = claude(await collector.getAgentsStatus());
    assert.equal(card.sessionsCount, 1, "two engine processes are one desktop session row");
    assert.equal(card.sessions[0].id, "claude-desktop");
  });

  it("folds the hash-directory engine layout (Desktop ≥2.37337) into the desktop row, traffic included", async () => {
    // 2026-10-30 报障：新版 Desktop（本机 2.37337.1.0 / 引擎 2.1.295）把引擎落盘改为
    // <根>\claude-code\<semver>\<12 位构建哈希>\claude.exe，旧白名单要求 semver 段后
    // 紧跟 exe，分型落空 → 真正发请求的引擎进程被正证标成 CLI 单独成行，桌面行只剩
    // 壳、零请求——「一个 Desktop 两张卡、流量全走 CLI 卡」。本例钉住修复后的整链：
    // 壳 + 新布局引擎折成一张桌面行，引擎的流量计入该行。
    const ENGINE_HASH = "C:\\Users\\u\\AppData\\Local\\Claude-3p\\claude-code\\2.1.295\\d2e29494ec83\\claude.exe";
    const csv = wmic([
      `LAPTOP,${SHELL},Claude.exe,6200`,
      `LAPTOP,${SHELL} --type=renderer,Claude.exe,6201`,
      `LAPTOP,${ENGINE_HASH} --output-format stream-json --verbose,claude.exe,6100`,
    ]);
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => 10000 });

    collector.reportSession("token_engine", { pid: 6100, requests: 83, activeRequests: 2 });

    const card = claude(await collector.getAgentsStatus());
    assert.equal(card.sessionsCount, 1, "壳 + 新布局引擎 = 一张桌面行，不再多出 CLI 行");
    assert.equal(card.sessions[0].id, "claude-desktop");
    assert.equal(card.sessions[0].surface, "Desktop");
    assert.equal(card.sessions[0].requests, 83, "引擎进程的流量折进桌面行");
    assert.equal(card.sessions[0].status, "active", "在飞请求随折叠行一起呈现");
    assert.deepEqual(card.surfaces, [{ surface: "desktop", label: "Desktop", count: 1 }],
      "副行不再报出 CLI 档");
  });

  it("keeps npm-CLI claude.exe rows per-pid — old behavior verbatim", async () => {
    const csv = wmic([
      "LAPTOP,C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe,claude.exe,24956",
      "LAPTOP,C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe,claude.exe,24957",
    ]);
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => 10000 });

    const card = claude(await collector.getAgentsStatus());
    assert.equal(card.sessionsCount, 2, "CLI sessions stay one row per pid");
    assert.deepEqual(card.sessions.map((s) => s.id), ["claude-24956", "claude-24957"]);
    assert.ok(card.sessions.every((s) => s.surface === "TUI"), "CLI rows carry the client-form badge");
  });

  it("falls back to per-pid rows when the scan carries no command line (tasklist)", async () => {
    const csv = `"claude.exe","6200","Console","1","55,000 K"\r\n"claude.exe","6201","Console","1","9,000 K"\r\n`;
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => 10000 });

    const card = claude(await collector.getAgentsStatus());
    assert.equal(card.sessionsCount, 2, "unreadable paths never fold — 宁可漏折不可误折");
    assert.deepEqual(card.sessions.map((s) => s.id), ["claude-6200", "claude-6201"]);
  });

  it("lists the folded desktop row side by side with per-pid CLI rows", async () => {
    const csv = wmic([
      `LAPTOP,${SHELL},Claude.exe,6200`,
      `LAPTOP,${SHELL} --type=renderer,Claude.exe,6201`,
      "LAPTOP,C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe,claude.exe,24956",
    ]);
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => 10000 });

    const card = claude(await collector.getAgentsStatus());
    assert.equal(card.sessionsCount, 2);
    assert.deepEqual(card.sessions.map((s) => s.id), ["claude-desktop", "claude-24956"],
      "folded row takes the first desktop member's slot");
    assert.equal(card.sessions[0].surface, "Desktop");
    assert.equal(card.sessions[1].surface, "TUI");
  });

  it("aggregates counters and keeps the freshest telemetry across folded members", async () => {
    const csv = wmic([
      `LAPTOP,${ENGINE_3P},claude.exe,6100`,
      `LAPTOP,${ENGINE_3P},claude.exe,6101`,
    ]);
    let t = 10000;
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => t });

    collector.reportSession("token_a", {
      pid: 6100,
      requests: 3,
      activeRequests: 0,
      activeDurationMs: 5000,
      promptTokens: 300,
      completionTokens: 60,
      cachedTokens: 30,
      lastTtftMs: 1200,
    });
    collector.reportSession("token_b", {
      pid: 6101,
      requests: 2,
      activeRequests: 1,
      activeDurationMs: 4000,
      promptTokens: 200,
      completionTokens: 40,
      cachedTokens: 20,
    });

    const card = claude(await collector.getAgentsStatus());
    assert.equal(card.sessionsCount, 1);
    const row = card.sessions[0];
    assert.equal(row.id, "claude-desktop");
    assert.equal(row.status, "active", "any busy member activates the folded row");
    assert.equal(row.requests, 5, "counters sum across members");
    assert.equal(row.tokens.prompt, 500);
    assert.equal(row.tokens.completion, 100);
    assert.equal(row.tokens.cached, 50);
    assert.equal(row.activeDurationMs, 9000);
    assert.equal(row.lastTtftMs, 1200, "telemetry comes from the freshest member carrying a value");
  });

  it("publishes the desktop surface summary as one entry per folded row", async () => {
    // 卡头副行的计数口径是**折叠后的行数**，不是进程数：一个桌面端 = 一张
    // 界面形态，与卡上「N 实例」胶囊同口径。12 个进程不会变成 Desktop ×12。
    const csv = wmic([
      `LAPTOP,${SHELL},Claude.exe,6200`,
      `LAPTOP,${SHELL} --type=gpu-process,Claude.exe,6201`,
      `LAPTOP,${SHELL} --type=renderer,Claude.exe,6202`,
    ]);
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => 10000 });

    const card = claude(await collector.getAgentsStatus());
    assert.deepEqual(card.surfaces, [{ surface: "desktop", label: "Desktop", count: 1 }]);
  });

  it("keeps the desktop entry at one row when a CLI session runs alongside it", async () => {
    const csv = wmic([
      `LAPTOP,${SHELL},Claude.exe,6200`,
      "LAPTOP,C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe,claude.exe,24956",
    ]);
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => 10000 });

    const card = claude(await collector.getAgentsStatus());
    assert.deepEqual(
      card.surfaces,
      [
        { surface: "desktop", label: "Desktop", count: 1 },
        { surface: "cli", label: "TUI", count: 1 },
      ],
      "并排的 CLI 行不占形态位：这一格只回答「桌面端开着没有」",
    );
  });

  it("publishes no surface summary when only per-pid CLI rows exist", async () => {
    const csv = wmic([
      "LAPTOP,C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe,claude.exe,24956",
    ]);
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => 10000 });

    const card = claude(await collector.getAgentsStatus());
    assert.deepEqual(card.surfaces, [{ surface: "cli", label: "TUI", count: 1 }], "CLI 形态由进程扫描直接提供");
  });

  it("drops the folded row once every desktop process is gone", async () => {
    let alive = true;
    const execFn = (cmd, opts, cb) =>
      cb(null, alive
        ? wmic([`LAPTOP,${SHELL},Claude.exe,6200`, `LAPTOP,${SHELL} --type=gpu-process,Claude.exe,6201`])
        : wmic([]));
    let t = 10000;
    const collector = testCollector({ execFn, nowFn: () => t });

    let card = claude(await collector.getAgentsStatus());
    assert.equal(card.sessionsCount, 1);
    assert.equal(card.sessions[0].id, "claude-desktop");

    alive = false;
    t += 3000; // past the 2.5s scan cache so the read rescans
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 20));
    card = claude(await collector.getAgentsStatus());
    assert.equal(card.sessionsCount, 0, "members all ended → synthetic row vanishes with them");
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

  it("folds an opencode serve-child pid up to the interactive engine pid", () => {
    // Live shape 2026-10-16: the interactive opencode.exe (14788) spawns
    // `opencode.exe serve --service` (19852) which owns the relay keep-alive
    // connection — the socket fallback synthesizes the child's pid. The fold
    // walks the parent chain UP to the engine pid, mirroring how the codex
    // fold walks DOWN from a GUI pid: both land on the row engine-scoped
    // housekeeping keeps alive and the terminal join binds.
    const ocSnapshot = {
      opencodePids: new Set([14788, 19852]),
      opencodeEnginePids: new Set([14788]),
      opencodeServePids: new Set([19852]),
      ppidByPid: new Map([[19852, 14788], [14788, 18868]]),
    };
    assert.deepEqual(normalizeInstanceId("opencode", "opencode-19852", ocSnapshot), { id: "opencode-14788", label: null });
    assert.deepEqual(normalizeInstanceId("opencode", "opencode-14788", ocSnapshot), { id: "opencode-14788", label: null });
    assert.deepEqual(normalizeInstanceId("opencode", "opencode-9999", ocSnapshot), { id: "opencode-9999", label: null },
      "a pid outside the family with no serve classification stays unchanged");
  });

  it("keeps an opencode serve-child id unchanged when no engine ancestor is reachable", () => {
    // TUI 退出而 serve 子进程滞留：父链离开扫描表，上折没有目标——原始号
    // 维持原样，行走家族集存活判定，家族全灭自然收走（宁可漏折，不可误折）。
    const ocSnapshot = {
      opencodePids: new Set([19852]),
      opencodeEnginePids: new Set(),
      opencodeServePids: new Set([19852]),
      ppidByPid: new Map([[19852, 999999]]),
    };
    assert.deepEqual(normalizeInstanceId("opencode", "opencode-19852", ocSnapshot), { id: "opencode-19852", label: null });
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

// 探针超时判罚。这条链原来的形状是「任何一条查询超时 = 子进程卡死 = 杀掉」，于是
// 一轮里那条**可选**的终端存活复查能把刚刚正常答过进程扫描的热子进程打死，下一轮
// 重付冷启动（本机实测冷轮 556ms、热轮 149–185ms），而复查在新子进程里还要现场
// 编译一段 Win32 互操作代码（实测 188ms）——杀完必回冷态，下轮又要编译，链条自持。
// 更要紧的是落数据原本排在这条可选复查之后：面板读到的快照被可选工作拖住最长 3 秒，
// 而面板给 relay 的拉取预算只有 1500ms。2026-10-07 用假子进程驱动真实采集器实测：
// 扫描 20ms 就答完，整轮仍 3032ms 才落地，且那只子进程被 kill、下一轮重新 spawn。
describe("探针超时判罚：可选复查不杀热子进程，落地不等复查", () => {
  const DSH_BIN = "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
  const HEADER = "Node,CommandLine,Name,ProcessId\r\n";
  const dshTuiRow = (pid) => `LAPTOP,"C:\\Program Files\\nodejs\\node.exe" "${DSH_BIN}" --profile dsh-tui,node.exe,${pid}`;
  const zcodeRow = (pid) => `LAPTOP,C:\\Programs\\ZCode.exe,ZCode.exe,${pid}`;
  const tuiScan = HEADER + dshTuiRow(6001) + "\r\n";
  const cleanScan = HEADER + dshTuiRow(6001) + "\r\n";

  function raceWithPending(promise, ms) {
    return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("__pending__"), ms))]);
  }

  function makeChild(onWrite) {
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    stdout.setEncoding = () => {};
    const stderr = new EventEmitter();
    stderr.resume = () => {};
    child.stdin = { write: (text) => onWrite(child, stdout, text) };
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => { child.killed = true; child.emit("exit", 0); };
    child.unref = () => {};
    return child;
  }
  const markerOf = (text) => (text.match(/Write-Output '([^']+)'/) || [])[1] || "";

  it("可选复查还挂在半空时，扫描结果必须已经能读走", async () => {
    // 落地的判据是「本轮进程事实到手」，不是「本轮所有可选附加工作都跑完」。
    let t = 3000;
    const spawnFn = () => makeChild((child, stdout, text) => {
      const marker = markerOf(text);
      if (text.includes("AttachErr")) {
        setTimeout(() => stdout.emit("data", `c=6001/0\r\n${marker}\r\n`), 400); // 复查慢，但会答
        return;
      }
      stdout.emit("data", tuiScan + marker + "\r\n");
    });
    const collector = testCollector({ spawnFn, nowFn: () => t });
    const firstRound = collector.scanProcesses(); // 首轮在飞（复查未答完）
    await new Promise((r) => setTimeout(r, 60));
    const read = await raceWithPending(collector.scanProcesses(), 30);
    assert.notEqual(read, "__pending__", "复查挂半空不得让第二次读排队等整轮");
    assert.equal(read.dsh, 1, "读到的就是本轮扫描的进程事实");
    await firstRound;
  });

  it("复查超时不得打死刚答过扫描的子进程；同一只第二次超时才换掉", async () => {
    let t = 3000;
    const kids = [];
    const spawnFn = () => {
      const child = makeChild((c, stdout, text) => {
        if (text.includes("AttachErr")) return; // 永不回话：模拟争用下卡住的可选复查
        stdout.emit("data", tuiScan + markerOf(text) + "\r\n");
      });
      kids.push(child);
      return child;
    };
    const collector = testCollector({
      spawnFn,
      killFn: () => false,
      nowFn: () => t,
      psProbeTimeoutMs: 6000,
      psProbeOptionalTimeoutMs: 40,
    });

    const first = await collector.scanProcesses();
    assert.equal(first.dsh, 1, "复查不回话也必须把本轮进程数据交出来");
    assert.equal(kids.length, 1);
    assert.equal(kids[0].killed, undefined, "第一次复查超时：热子进程不得被判死");
    assert.equal(collector.getProbeStats().optionalTimeouts, 1);

    t = 10000; // 过 TTL → 第二轮仍走同一只热子进程（不重付冷启动）
    await collector.scanProcesses();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(kids.length, 1, "第二轮必须复用子进程");
    const stats = collector.getProbeStats();
    assert.equal(stats.optionalTimeouts, 2, "第二轮同样放弃复查");
    assert.equal(stats.childKills, 1, "同一只子进程第二次复查超时即换掉，不得无限拖着");

    t = 20000; // 被判罚之后，下一轮必须重新 spawn
    await collector.scanProcesses();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(kids.length, 2, "换掉的子进程下一轮重起，真卡死的不得永久占用");
  });

  it("被放弃那条复查迟到的回话不得混进下一轮读数", async () => {
    let t = 3000;
    let abandonedMarker = null;
    let scanWrites = 0;
    const spawnFn = () => makeChild((child, stdout, text) => {
      const marker = markerOf(text);
      if (text.includes("AttachErr")) {
        abandonedMarker = marker; // 记下被放弃那条的标记，稍后迟到
        return;
      }
      scanWrites += 1;
      if (scanWrites === 1) {
        stdout.emit("data", tuiScan + marker + "\r\n");
        return;
      }
      // 第二轮：先把第一轮那条被放弃的复查回话吐出来（内容故意伪装成进程行），
      // 再吐本轮真正的扫描结果。序列上迟到段一定排在当轮答案之前。
      setTimeout(() => stdout.emit("data", HEADER + zcodeRow(9111) + "\r\n" + abandonedMarker + "\r\n"), 5);
      setTimeout(() => stdout.emit("data", cleanScan + marker + "\r\n"), 12);
    });
    const collector = testCollector({
      spawnFn,
      killFn: () => false,
      nowFn: () => t,
      psProbeTimeoutMs: 6000,
      psProbeOptionalTimeoutMs: 30,
    });

    await collector.scanProcesses(); // 第 1 轮：扫描到手，复查被放弃
    t = 10000;
    collector.scanProcesses(); // 踢第 2 轮（后台重验）
    await new Promise((r) => setTimeout(r, 80)); // 等第 2 轮落地
    const second = await collector.scanProcesses();
    assert.equal(second.zcode, 0, "迟到段不得当成本轮进程行计数");
    assert.equal(second.dsh, 1, "本轮自己的扫描结果照常落地");
    assert.ok(collector.getProbeStats().lateAnswersDiscarded >= 1, "迟到段必须被显式丢弃并计数");
  });

  it("必需的进程扫描超时照旧换子进程并回落 tasklist", async () => {
    let t = 3000;
    const kids = [];
    const spawnFn = () => {
      const child = makeChild(() => { /* 扫描也不回话：整轮不可用 */ });
      kids.push(child);
      return child;
    };
    const execFn = (cmd, opts, cb) => {
      if (cmd.includes("tasklist")) return cb(null, '"ZCode.exe","20588","Console","1","50,000 K"\r\n');
      return cb(new Error("unexpected exec"));
    };
    const collector = testCollector({
      spawnFn, execFn, killFn: () => false, nowFn: () => t,
      psProbeTimeoutMs: 40, psProbeOptionalTimeoutMs: 40,
    });
    const procs = await collector.scanProcesses();
    assert.equal(procs.zcode, 1, "必需查询超时仍须兜底出数据");
    assert.ok(kids[0].killed, "必需查询超时的子进程必须被换掉——数据不可信的那条路不放宽");
  });

  it("可选预算短于必需预算", () => {
    assert.ok(PS_PROBE_OPTIONAL_TIMEOUT_MS < PS_PROBE_TIMEOUT_MS,
      "可选查询的预算必须明显短于必需查询，否则可选工作又能拖住整轮");
  });

  it("processScanTtlMs 放宽后，未到窗口的读不再踢新的一轮", async () => {
    let t = 100_000; // 纪元量级的时钟：首轮没有快照，必须无条件踢一次
    let scanQueries = 0;
    const spawnFn = () => makeChild((child, stdout, text) => {
      const marker = markerOf(text);
      if (text.includes("AttachErr")) {
        stdout.emit("data", `c=6001/0\r\n${marker}\r\n`);
        return;
      }
      scanQueries += 1;
      stdout.emit("data", tuiScan + marker + "\r\n");
    });
    const collector = testCollector({ spawnFn, nowFn: () => t, processScanTtlMs: 6000 });
    await collector.scanProcesses();
    assert.equal(scanQueries, 1);
    t = 103_000; // 距今 3000ms：默认窗口(2500)会踢新一轮，放宽到 6000 则不该踢
    await collector.scanProcesses();
    assert.equal(scanQueries, 1, "未到缓存窗口不得重扫——少一路并发就是少一份争用");
    t = 109_500; // 距今 6500ms：过窗，正常重验
    await collector.scanProcesses();
    assert.equal(scanQueries, 2);
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
    return mkTestDir("anyswitch-metrics-snapshot-");
  }

  it("restores endpoint accounting, sample windows and sticky identity", async () => {
    const dir = snapshotDir();
    try {
      let t = 10_000;
      const first = testCollector({ execFn: chainExec, nowFn: () => t, persistRoot: dir });
      await first.scanProcesses();
      const req = first.startRequest({ agentId: "kimi", model: "kimi-k3", providerId: "north-main" });
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
      assert.equal(kimi.lastProvider, "north-main");
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
      first.startRequest({ agentId: "kimi", instanceId: "kimi-4321", model: "kimi-k3", providerId: "north-main" });
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
      // 家族全灭（可信零轮）→ run 判决重开：还原的 kimi 账整体归零。
      assert.equal(kimiGone.metrics.totalRequests, 0, "family gone = run over: restored endpoint accounting is zeroed");
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
      assert.equal(written.version, 2);
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

  it("run verdict: relay restart with the family alive continues the account, dead pids reopen it", async () => {
    // 运行锚判决：快照里的家族 pid 集在 relay 重启后决定续账 or 重开。
    // 第一段：kimi 4321 在跑、有账、锚落盘。第二段 A：同一进程还在 → 续账；
    // 第二段 B：进程全灭 → 还原账归零。
    const dir = snapshotDir();
    try {
      let t = 10_000;
      const mk = (exec) => testCollector({ execFn: exec, nowFn: () => t, persistRoot: dir });
      const first = mk(chainExec);
      await first.scanProcesses();
      const req = first.startRequest({ agentId: "kimi", instanceId: "kimi-4321", model: "kimi-k3" });
      t += 1000;
      req.recordEnd({ status: 200, usage: { prompt_tokens: 400, completion_tokens: 40 } });
      assert.equal(first.persistMetricsSnapshot(), true);

      // A：家族照旧在跑（同一扫描输出）——续账。
      t += 5000;
      const continued = mk(chainExec);
      const kimiA = (await continued.getAgentsStatus()).find((a) => a.id === "kimi");
      assert.equal(kimiA.metrics.totalRequests, 1, "family alive across the restart = same run, account continues");
      assert.equal(kimiA.metrics.tokens.prompt, 400);

      // B：relay 又重启了一次，这次停机期间进程全灭——还原账归零（重开）。
      t += 5000;
      const reopened = mk(emptyScanExec);
      const kimiB = (await reopened.getAgentsStatus()).find((a) => a.id === "kimi");
      assert.equal(kimiB.metrics.totalRequests, 0, "family gone during the restart = old run over, account reopened at zero");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a v1 snapshot (pre run-anchor shape) is discarded, not restored", async () => {
    const dir = snapshotDir();
    try {
      // 手写一份 v1 形状的旧快照：账目字段齐全，但 version = 1。
      writeFileSync(join(dir, METRICS_SNAPSHOT_FILENAME), JSON.stringify({
        version: 1,
        savedAt: 10_000,
        endpoints: {
          kimi: { totalRequests: 7, totalPromptTokens: 700, totalCompletionTokens: 70 },
        },
        instances: {},
      }), "utf8");
      const collector = testCollector({ execFn: chainExec, nowFn: () => 10_000, persistRoot: dir });
      const kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
      assert.equal(kimi.metrics.totalRequests, 0, "old-shape sidecar must not leak into the v2 account");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("claude partial exit folds retired sessions into the aggregate ledger", async () => {
    // 退役账：一个会话行退出（pid 消失 + 过展示窗）后其累计并入端点级累加器，
    // 聚合 = 活行 + 退役账；另一个会话行还活着 → 卡片聚合保持两段之和。
    const dir = snapshotDir();
    try {
      let t = 10_000;
      let claudeA = true; // pid 4400 在跑
      const execFn = (cmd, opts, cb) => cb(null, claudeA
        ? "Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe,claude.exe,4400\r\nLAPTOP,C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe,claude.exe,4401\r\n"
        : "Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe,claude.exe,4401\r\n");
      const collector = testCollector({ execFn, nowFn: () => t, persistRoot: dir });
      await collector.scanProcesses();

      collector.reportSession("token_a", { pid: 4400, requests: 5, activeRequests: 0, promptTokens: 500, completionTokens: 50 });
      collector.reportSession("token_b", { pid: 4401, requests: 3, activeRequests: 0, promptTokens: 300, completionTokens: 30 });

      let card = (await collector.getAgentsStatus()).find((a) => a.id === "claude");
      assert.equal(card.sessions.length, 2, "two live sessions");

      // pid 4400 退出：行挂 ended；过 ENDED_DISPLAY_MS 后清除并吸收进退役账。
      // t 跳 61s 过了扫描缓存窗（2.5s）：跳时后的第一读吃旧扫描（两 pid 都在）
      // 并踢新轮，第二读吃到新扫描把行挂 ended，第三读过展示窗清除并吸收。
      claudeA = false;
      t += 1000;
      await collector.getAgentsStatus();
      await new Promise((r) => setTimeout(r, 20));
      t += 61_000; // ENDED_DISPLAY_MS 60s
      await collector.getAgentsStatus(); // 旧扫描（stale）
      await collector.getAgentsStatus(); // 新扫描：行挂 ended
      card = (await collector.getAgentsStatus()).find((a) => a.id === "claude"); // 过窗清除 + 吸收
      assert.equal(card.sessions.length, 1, "the exited session row is purged past its display window");
      const ledger = card.retiredMetrics;
      assert.equal(ledger.requests, 5, "the retired row's requests folded into the endpoint ledger");
      assert.equal(ledger.promptTokens, 500);
      assert.equal(ledger.completionTokens, 50);
      // 活行 + 退役账：面板侧 claudeAggregateMetrics 的并表口径由这组字段喂出。
      assert.equal(card.sessions[0].requests + ledger.requests, 8, "aggregate = live rows + retired ledger");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("claude full family exit zeroes the whole card account, ledger included", async () => {
    const dir = snapshotDir();
    try {
      let t = 10_000;
      let alive = true;
      const execFn = (cmd, opts, cb) => cb(null, alive
        ? "Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe,claude.exe,4400\r\n"
        : "Node,CommandLine,Name,ProcessId\r\n");
      const collector = testCollector({ execFn, nowFn: () => t, persistRoot: dir });
      await collector.scanProcesses();

      collector.reportSession("token_a", { pid: 4400, requests: 5, activeRequests: 0, promptTokens: 500, completionTokens: 50 });

      // 家族全灭过宽限：会话行与退役账同批清零，聚合归零——不先吸收再清（那
      // 会把刚归零的聚合又用退役账填回来）。
      alive = false;
      t += 1000;
      await collector.getAgentsStatus(); // 首读吃旧缓存并踢新一轮
      await new Promise((r) => setTimeout(r, 20)); // 家族全灭的扫描落地
      t += 4000; // 过 3s 宽限
      await collector.getAgentsStatus(); // 这一读做 run 清零（会话行随账清）
      const card = (await collector.getAgentsStatus()).find((a) => a.id === "claude");
      assert.equal(card.retiredMetrics.requests, 0, "ledger is zeroed with the endpoint account");
      assert.equal(card.retiredMetrics.promptTokens, 0);
      assert.equal(card.status, "stopped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 虚拟终端归属喂给（getDetectedClientProcesses）：shell 行只进谱系不进桶，
// 检测面按引擎子集出活进程并带祖先链（panel 按 shell pid join）。
describe("terminal attribution feed (getDetectedClientProcesses)", () => {
  // PowerShell 探测行格式 <pid>,<ppid>,<name>,<cmdline>：两个会话壳
  //（powershell.exe / pwsh.exe）、codex 引擎 + ChatGPT 桌面壳、kimi node 进程，
  // 其中 codex 引擎与 kimi 进程都挂在 powershell 8888 之下。
  const PS_TERMINAL_ATTRIBUTION_SCAN = [
    String.raw`6100,8888,codex.exe,C:\Codex\bin\1\codex.exe app-server`,
    String.raw`6200,7000,ChatGPT.exe,C:\ChatGPT\ChatGPT.exe`,
    String.raw`4321,8888,node.exe,C:\app\node_modules\@moonshot-ai\kimi-code\dist\main.mjs`,
    String.raw`8888,9000,powershell.exe,C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile`,
    String.raw`8890,9001,pwsh.exe,C:\Tools\pwsh\pwsh.exe -NoLogo`,
  ].join("\r\n") + "\r\n";
  const terminalAttributionExec = (cmd, opts, cb) => cb(null, PS_TERMINAL_ATTRIBUTION_SCAN);

  it("shell rows feed the lineage table only, never a counting bucket or pid set", async () => {
    const collector = testCollector({ execFn: terminalAttributionExec, nowFn: () => 10000, kimiRegistryLookup: async () => new Map() });
    const procs = await collector.scanProcesses();
    assert.equal(procs.ppidByPid.get(8888), 9000, "powershell.exe 进谱系表");
    assert.equal(procs.ppidByPid.get(8890), 9001, "pwsh.exe 同样只进谱系");
    assert.equal(procs.kimi, 1);
    assert.equal(procs.codex, 2, "codex.exe 与 ChatGPT 主进程照常计数");
    for (const key of ["zcode", "claude", "opencode", "dsh", "pi", "qoder", "grok"]) {
      assert.equal(procs[key], 0, `${key} 不受 shell 行影响`);
    }
    assert.equal(procs.kimiPids.has(8888), false);
    assert.equal(procs.kimiEnginePids.has(8888), false);
    assert.equal(procs.codexPids.has(8890), false);
    assert.equal(procs.codexEnginePids.has(8888), false);
    assert.equal(procs.ppidByPid.has(6100), true, "引擎行照常进谱系");
  });

  it("feed lists engine clients with ancestor chains, skipping non-engine family members", async () => {
    const collector = testCollector({ execFn: terminalAttributionExec, nowFn: () => 10000, kimiRegistryLookup: async () => new Map() });
    await collector.scanProcesses();
    const feed = collector.getDetectedClientProcesses();
    assert.equal(feed.length, 2, "ChatGPT 桌面壳不是引擎，不进检测面");
    const codexEntry = feed.find((p) => p.agentId === "codex");
    // busy 是「锚 pid 之下有没有活命令」判据：这张夹具里两条引擎都是光杆。
    const { busy: codexBusy, ...codexRest } = codexEntry;
    assert.deepEqual(codexRest, { agentId: "codex", pid: 6100, ancestors: [8888, 9000] });
    assert.equal(codexBusy, false, "光杆引擎判无活命令");
    const kimiEntry = feed.find((p) => p.agentId === "kimi");
    const { busy: kimiBusy, ...kimiRest } = kimiEntry;
    assert.deepEqual(kimiRest, { agentId: "kimi", pid: 4321, ancestors: [8888, 9000] });
    assert.equal(kimiBusy, false);
    assert.equal(feed.some((p) => p.pid === 6200), false);
  });

  it("before any scan lands the feed is empty (no phantom clients)", () => {
    const collector = testCollector({ execFn: () => {}, nowFn: () => 10000 });
    assert.deepEqual(collector.getDetectedClientProcesses(), []);
  });

  // 「树里有活命令」判据：面板的 working 只有「在途请求＋5s 输出窗＋回合闸」三个
  // 替代信号，对「回合已结束、agent 留下的子进程还在跑」完全失明——此时面板显示
  // 空闲，而内切杀前探测探到活子进程就拒换（409），前端静默新开页签，用户观感即
  // 「内切失效」（2026-10-28 实测定案）。守卫的全表探测是真值但只跑一次，所以
  // 这里把同源判据搬进常驻进程扫描：扫描查询改成不带镜像名白名单的全表（本机实测
  // 中位 250→371ms，TTL 2.5s 档可承受；按 pid 逐个子查询 219ms，并不更便宜），
  // 每轮用 switch-guard 的同一个 hasRunningCommand 谓词算出「锚 pid 之下有没有
  // 活命令」，随 detected feed 下发。判定与守卫同源，面板与守卫不再各说各话。
  describe("command-running verdict on the detected feed", () => {
    // 一棵 dsh 终端进程树：宿主(6200)派生同命令行引擎(6300)，引擎底下挂一条
    // ping；另一条 dsh 引擎(6400)光杆等输入；外加一个与端点无关的 svchost 行
    // 与一个只喂谱系的 powershell 壳。
    const BUSY_SCAN = [
      String.raw`9000,8000,powershell.exe,C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile`,
      String.raw`6200,9000,node.exe,C:\Users\u\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js --profile dsh-tui`,
      String.raw`6300,6200,node.exe,C:\Users\u\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js --profile dsh-tui`,
      String.raw`6310,6300,ping.exe,ping -n 45 127.0.0.1 > nul`,
      String.raw`6400,9000,node.exe,C:\Users\u\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js --profile dsh-tui`,
      String.raw`7000,6000,svchost.exe,C:\Windows\System32\svchost.exe -k netsvcs`,
    ].join("\r\n") + "\r\n";
    const busyExec = (cmd, opts, cb) => cb(null, BUSY_SCAN);

    it("engine with a live command child reports busy; the clean engine does not", async () => {
      const collector = testCollector({ execFn: busyExec, nowFn: () => 10000, kimiRegistryLookup: async () => new Map() });
      await collector.scanProcesses();
      const feed = collector.getDetectedClientProcesses();
      const byPid = new Map(feed.map((p) => [p.pid, p]));
      // 宿主 6200 被折出引擎集（同命令行派生），检测面只剩两条引擎
      assert.deepEqual([...byPid.keys()].sort((a, b) => a - b), [6300, 6400], "检测面只列引擎");
      assert.equal(byPid.get(6300).busy, true, "引擎底下挂着 ping：判有活命令");
      assert.equal(byPid.get(6400).busy, false, "光杆引擎：判无活命令");
    });

    it("verdict is computed by the switch-guard predicate on the same table", async () => {
      // 同源是这套判据的全部意义：不能出现「面板说忙、守卫放行」或反向。
      // 这里直接拿 switch-guard 的 hasRunningCommand 复算一遍同一张表。
      const collector = testCollector({ execFn: busyExec, nowFn: () => 10000, kimiRegistryLookup: async () => new Map() });
      const counts = await collector.scanProcesses();
      const feed = collector.getDetectedClientProcesses();
      const table = collector.getProcessTableForGuard?.() ?? null;
      assert.ok(table, "扫描保留守卫形状的全表（pid/ppid/name/命令行）");
      for (const entry of feed) {
        const expected = hasRunningCommand(table, { rootPid: entry.pid, anchorPid: entry.pid });
        assert.equal(entry.busy, expected, `pid ${entry.pid} 的判据与守卫同源`);
      }
      assert.ok(counts.ppidByPid.has(6310), "无关进程行进谱系表");
    });

    it("a derived same-command-line engine child is exempt, but its own subtree still counts", async () => {
      // dsh 0.2.0 宿主派生同命令行引擎（豁免形态），引擎底下新挂的命令照算。
      const scan = [
        String.raw`6200,9000,node.exe,C:\u\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js --profile dsh-tui`,
        String.raw`6300,6200,node.exe,C:\u\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js --profile dsh-tui`,
        String.raw`6310,6300,ping.exe,ping -n 45 127.0.0.1 > nul`,
        String.raw`6320,6310,findstr.exe,findstr x`,
      ].join("\r\n") + "\r\n";
      const collector = testCollector({ execFn: (c, o, cb) => cb(null, scan), nowFn: () => 10000, kimiRegistryLookup: async () => new Map() });
      await collector.scanProcesses();
      const feed = collector.getDetectedClientProcesses();
      const engine = feed.find((p) => p.pid === 6300);
      assert.equal(engine.busy, true, "豁免的子进程自己的子树仍算证据");
    });

    it("degraded round with no command lines yields no verdict (null), never a guess", async () => {
      // tasklist 兜底没有命令行列：树里每个进程都读不出命令行，按守卫语义那正是
      // 「保守拒」。但那是点击内切那一刻的一次性语义；显示面常亮会把它放大成
      // 「永远在转圈」。所以读不出就不判（null），面板回落既有信号。引擎 pid 靠
      // 形态延续活过降级轮（kimiEnginePids 在 CARRIED_FORM_KEYS 里），判据留空。
      const KIMI_BUSY = [
        String.raw`9000,8000,powershell.exe,C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile`,
        String.raw`4321,9000,node.exe,C:\app\node_modules\@moonshot-ai\kimi-code\dist\main.mjs`,
        String.raw`4390,4321,ping.exe,ping -n 45 127.0.0.1 > nul`,
      ].join("\r\n") + "\r\n";
      const KIMI_DEGRADED = [
        String.raw`"node.exe","4321","Console","1","120,000 K"`,
        String.raw`"ping.exe","4390","Console","1","20,000 K"`,
      ].join("\r\n") + "\r\n";
      let trusted = true;
      let t = 10000;
      const collector = testCollector({
        nowFn: () => t,
        execFn: (cmd, opts, cb) => {
          if (cmd.includes("tasklist")) return cb(null, trusted ? "" : KIMI_DEGRADED);
          return cb(null, trusted ? KIMI_BUSY : "");
        },
        kimiRegistryLookup: async () => new Map(),
      });
      await collector.scanProcesses();
      assert.equal(collector.getDetectedClientProcesses().find((p) => p.pid === 4321).busy, true, "可信轮判据在手");
      trusted = false;
      // 5s：够越过扫描 TTL（2.5s）触发重扫，又必须在形态延续的 30s 窗口内——
      // 跳 20 分钟会让延续失效，引擎集整批消失，那就不是「降级轮」而是「进程没了」。
      t += 5000;
      // 扫描是 stale-while-revalidate：首拍返回旧快照，新轮在后台落地。与其余降
      // 级轮用例同款等法——连赶两拍让新轮落定。
      await collector.scanProcesses();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await collector.scanProcesses();
      const degraded = collector.getDetectedClientProcesses().find((p) => p.pid === 4321);
      assert.ok(degraded, "形态延续让引擎活过降级轮");
      assert.equal(degraded.busy, null, "读不出命令行不判忙");
    });
  });
});

describe("activity transition publish (onActivity)", () => {
  // The activity frame shape every jump publisher emits: an absolute-state
  // row for one (endpointId, instanceId) pair, never a delta.
  const sig = (f) => [f.type, f.endpointId, f.instanceId, f.activeRequests];
  const collect = (collector) => {
    const frames = [];
    collector.onActivity((f) => frames.push(f));
    return frames;
  };

  it("publishes the aggregate 0↔N jump only; intra-busy deltas and duplicate ends stay silent", () => {
    const collector = testCollector({ nowFn: () => 10000 });
    const frames = collect(collector);

    const r1 = collector.startRequest({ agentId: "kimi", model: "m1" });
    const r2 = collector.startRequest({ agentId: "kimi", model: "m1" });
    assert.deepEqual(frames.map(sig), [["activity", "kimi", null, 1]],
      "0→1 publishes once; the 1→2 overlap is not a jump");
    assert.equal(typeof frames[0].at, "number", "frame carries its emit timestamp");

    r2.recordEnd({ status: 200, usage: {} });
    assert.equal(frames.length, 1, "2→1 is not a jump");
    r1.recordEnd({ status: 200, usage: {} });
    r1.recordEnd({ status: 200, usage: {} });
    assert.deepEqual(frames.map(sig), [
      ["activity", "kimi", null, 1],
      ["activity", "kimi", null, 0],
    ], "N→0 publishes once — the second recordEnd is a no-op, not a repeat");
  });

  it("publishes the tagged instance mirror as a second identity alongside the aggregate", () => {
    const collector = testCollector({ nowFn: () => 10000 });
    const frames = collect(collector);

    const r = collector.startRequest({ agentId: "kimi", instanceId: "kimi-1010", model: "m1" });
    assert.deepEqual(frames.map(sig), [
      ["activity", "kimi", null, 1],
      ["activity", "kimi", "kimi-1010", 1],
    ], "aggregate and mirror each own their identity's 0→N jump");

    r.recordEnd({ status: 200, usage: {} });
    assert.deepEqual(frames.map(sig), [
      ["activity", "kimi", null, 1],
      ["activity", "kimi", "kimi-1010", 1],
      ["activity", "kimi", null, 0],
      ["activity", "kimi", "kimi-1010", 0],
    ], "both identities publish their N→0 jump on the same end");
  });

  it("a late attachInstance publishes only the mirror jump, never an aggregate one", () => {
    const collector = testCollector({ nowFn: () => 10000 });
    const frames = collect(collector);

    const r = collector.startRequest({ agentId: "kimi", model: "m1" });
    r.attachInstance("kimi-1010");
    assert.deepEqual(frames.map(sig), [
      ["activity", "kimi", null, 1],
      ["activity", "kimi", "kimi-1010", 1],
    ], "the mirror opens at 0→N from the attach moment; the aggregate stays at 1");
  });

  it("publishes claude per-launch merges at 0↔N boundaries with the session id", () => {
    const collector = testCollector({ nowFn: () => 10000 });
    const frames = collect(collector);

    collector.reportSession("tok_C", { pid: 4444, activeRequests: 2 });
    assert.deepEqual(frames.map(sig), [["activity", "claude", "claude-4444", 2]],
      "0→2 lands past 1 and is still one jump");
    collector.reportSession("tok_C", { pid: 4444, activeRequests: 3 });
    assert.equal(frames.length, 1, "2→3 is not a jump");
    collector.reportSession("tok_C", { pid: 4444, activeRequests: 0 });
    assert.deepEqual(frames.map(sig), [
      ["activity", "claude", "claude-4444", 2],
      ["activity", "claude", "claude-4444", 0],
    ]);
  });

  it("isolates a throwing listener from the request path and from other listeners", () => {
    const collector = testCollector({ nowFn: () => 10000 });
    collector.onActivity(() => {
      throw new Error("subscriber bug");
    });
    const frames = collect(collector);

    const r = collector.startRequest({ agentId: "kimi", model: "m1" });
    r.recordEnd({ status: 200, usage: {} });
    assert.deepEqual(frames.map(sig), [
      ["activity", "kimi", null, 1],
      ["activity", "kimi", null, 0],
    ], "the recording listener sees both frames despite its neighbor throwing");
  });

  it("unsubscribe (returned from onActivity) and offActivity both stop delivery", () => {
    const collector = testCollector({ nowFn: () => 10000 });
    const keep = collect(collector);
    const removed = [];
    const removedListener = (f) => removed.push(f);
    collector.onActivity(removedListener);
    collector.offActivity(removedListener);
    const unsubbed = [];
    const unsub = collector.onActivity((f) => unsubbed.push(f));
    unsub();

    collector.startRequest({ agentId: "zcode", model: "m1" });
    assert.equal(keep.length, 1, "still-subscribed listener receives");
    assert.equal(removed.length, 0);
    assert.equal(unsubbed.length, 0);
    assert.equal(keep[0].endpointId, "zcode");
  });
});

// usage 归一（统计口径）：上游两种 usage 形状都会原样到达记账口——OpenAI
// 透传带 prompt_tokens/completion_tokens，Anthropic 上行（stream-pipe 的
// onTerminalResult / pipe 结果）带 input_tokens/output_tokens/
// cache_read_input_tokens。聚合 tracker 只认前一种时，Anthropic 渠道的
// prompt/completion/cached 恒 0；归一后两种形状都照实入账。
describe("usage 形状归一（OpenAI / Anthropic 两种 usage 都照实入账）", () => {
  function fakeJournal() {
    const lines = [];
    return { lines, appendRequest: (entry) => lines.push(entry) };
  }
  // wmic-shaped CSV reporting one live kimi node.exe process with the given PID.
  const kimiWmicRow = (pid) =>
    `Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\Tools\\node.exe C:\\x\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs,node.exe,${pid}\r\n`;

  it("Anthropic 形状 usage 经 recordEnd 后实例行与聚合桶的 tokens 照实入账", async () => {
    let t = 3000;
    const execFn = (cmd, opts, cb) => cb(null, kimiWmicRow(21564));
    const collector = testCollector({ execFn, nowFn: () => t });

    let kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.equal(kimi.instances.length, 1, "placeholder listed before any request");

    const r = collector.startRequest({ agentId: "kimi", instanceId: "kimi-21564", providerId: "chan-a", model: "kimi-k3", stream: true, path: "anthropic" });
    t += 800;
    r.recordFirstChunk();
    t += 1200;
    r.recordEnd({ status: 200, usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900 } });

    t += 3000; // past the scan cache so the read rescans (pid still alive)
    kimi = (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
    assert.deepEqual(kimi.instances[0].tokens, { prompt: 1200, completion: 80, cached: 900 },
      "实例行不再对 Anthropic 形状记 0");
    assert.deepEqual(kimi.metrics.tokens, { prompt: 1200, completion: 80, cached: 900 },
      "聚合桶同步照实");
    assert.equal(kimi.metrics.cacheHitRate, 75, "缓存命中率随真实 cached 落地（900/1200）");
  });

  it("Anthropic 形状 usage 的 journal 行同样入账", () => {
    let t = 1000;
    const journal = fakeJournal();
    const collector = testCollector({ nowFn: () => t, journal });

    const r = collector.startRequest({ agentId: "kimi", providerId: "chan-a", model: "kimi-k3", stream: true, path: "anthropic" });
    t = 1800;
    r.recordFirstChunk();
    t = 4000;
    r.recordEnd({ status: 200, usage: { input_tokens: 64, output_tokens: 16, cache_read_input_tokens: 48 } });

    assert.equal(journal.lines.length, 1);
    assert.deepEqual(
      { prompt: journal.lines[0].prompt, completion: journal.lines[0].completion, cached: journal.lines[0].cached },
      { prompt: 64, completion: 16, cached: 48 },
    );
  });

  it("OpenAI 形状 usage 行为不变（回归：prompt_tokens_details.cached_tokens 优先）", () => {
    let t = 1000;
    const journal = fakeJournal();
    const collector = testCollector({ nowFn: () => t, journal });

    const r = collector.startRequest({ agentId: "kimi", providerId: "chan-a", model: "kimi-k3", stream: true, path: "openai" });
    t = 1800;
    r.recordFirstChunk();
    t = 4000;
    r.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } });

    assert.deepEqual(
      { prompt: journal.lines[0].prompt, completion: journal.lines[0].completion, cached: journal.lines[0].cached },
      { prompt: 100, completion: 20, cached: 30 },
    );
  });

  it("两种形状混用不回退歧义：各行的 token 只按自己行的形状入账", async () => {
    let t = 1000;
    const journal = fakeJournal();
    const execFn = (cmd, opts, cb) => cb(null, "");
    const collector = testCollector({ execFn, nowFn: () => t, journal });

    const a = collector.startRequest({ agentId: "kimi", providerId: "chan-a", model: "m1", stream: true, path: "openai" });
    a.recordFirstChunk();
    a.recordEnd({ status: 200, usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } } });
    const b = collector.startRequest({ agentId: "kimi", providerId: "chan-b", model: "m2", stream: true, path: "anthropic" });
    b.recordFirstChunk();
    b.recordEnd({ status: 200, usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 20 } });

    assert.deepEqual(journal.lines.map((l) => [l.prompt, l.completion, l.cached]), [
      [100, 10, 40],
      [50, 5, 20],
    ], "每行各按自己的形状，互不串味");
    const kimi = (await collector.getAgentsStatus()).find((x) => x.id === "kimi");
    assert.deepEqual(kimi.metrics.tokens, { prompt: 150, completion: 15, cached: 60 }, "聚合桶为两行之和");
  });
});

// ---------------------------------------------------------------------------
// 进程扫描降级轮（P0 根因回归）。
//
// 常驻 PowerShell 探针一轮没答完就回落 `tasklist /NH /FO CSV`，而那条路上每一
// 行都没有命令行：kimi/pi/dsh/opencode 靠命令行里的安装路径识别，于是这一轮这
// 些端点的进程数直接变 0。修复前这个 0 被当成「进程都没了」的证据——实例行被
// 删、在途计数被清零、累计请求数随行一起消失，终端页的「生成中」永不出现、
// 「最近请求」永远为空、「关标签不弹确认」都是这一条的下游。修复后：不完整轮
// 只判生死（本轮全量 pid），不判归属，也不结算计数；健康轮一切照旧。
describe("进程扫描降级轮（tasklist 回落）不得销毁实例状态", () => {
  const KIMI_PID = 41376;
  // 健康轮：常驻探针形状 <Node>,<CommandLine>,<Name>,<ProcessId>，带命令行。
  const healthyScan = (pid) =>
    `Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\Tools\\node.exe C:\\x\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs,node.exe,${pid}\r\n`;
  // 降级轮：tasklist CSV 形状，只有镜像名与 pid——node.exe 行认不出属于哪个 agent。
  const tasklistScan = (...pids) =>
    pids.map((pid) => `"node.exe","${pid}","Console","1","120,000 K"`).join("\r\n") + "\r\n";
  const unrelatedScan = '"explorer.exe","9001","Console","1","40,000 K"\r\n';
  const noSurfaces = async () => new Map();
  // 一次读只服务上一轮快照，扫描在后台落地：先踢一轮，等它落地，再读。
  const settleRound = async (collector) => {
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 20));
  };
  const kimiCard = async (collector) => (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
  const startDone = (collector) => {
    const r = collector.startRequest({ agentId: "kimi", instanceId: `kimi-${KIMI_PID}`, providerId: "p1", model: "m1", stream: true, path: "openai" });
    r.recordFirstChunk();
    r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });
  };

  it("保留实例行、累计请求数与在途计数，恢复健康轮后仍然在", async () => {
    let t = 3000;
    let psAnswer = healthyScan(KIMI_PID);
    const execFn = (cmd, opts, cb) => cb(null, cmd.includes("tasklist") ? tasklistScan(KIMI_PID) : psAnswer);
    const collector = testCollector({ execFn, nowFn: () => t, kimiRegistryLookup: noSurfaces });

    let kimi = await kimiCard(collector);
    assert.deepEqual(kimi.instances.map((i) => i.id), [`kimi-${KIMI_PID}`], "健康轮列出实例行");

    for (let i = 0; i < 5; i += 1) startDone(collector);
    const inflight = collector.startRequest({ agentId: "kimi", instanceId: `kimi-${KIMI_PID}`, providerId: "p1", model: "m1", stream: true, path: "openai" });

    kimi = await kimiCard(collector);
    assert.equal(kimi.instances[0].requests, 6);
    assert.equal(kimi.instances[0].activeRequests, 1);
    assert.equal(kimi.metrics.activeRequests, 1);

    // 探针空答 → 该轮回落 tasklist（无命令行）；时间同时推过 3s 的「进程没了」
    // 结算门槛，修复前这一步就会清空在途计数。
    psAnswer = "";
    t += 10_000;
    await settleRound(collector);
    kimi = await kimiCard(collector);
    assert.deepEqual(kimi.instances.map((i) => i.id), [`kimi-${KIMI_PID}`], "降级轮不得删实例行");
    assert.equal(kimi.instances[0].requests, 6, "降级轮不得清零累计请求数");
    assert.equal(kimi.instances[0].activeRequests, 1, "降级轮不得清零在途计数");
    assert.equal(kimi.metrics.activeRequests, 1, "端点聚合在途也不得被清零");

    // 连续降级轮同样不得清算。
    t += 10_000;
    await settleRound(collector);
    kimi = await kimiCard(collector);
    assert.equal(kimi.instances[0].activeRequests, 1, "多轮降级仍不清零");
    assert.equal(kimi.instances[0].requests, 6);

    // 恢复健康轮：行与计数都在，在途请求照常收尾。
    psAnswer = healthyScan(KIMI_PID);
    t += 10_000;
    await settleRound(collector);
    kimi = await kimiCard(collector);
    assert.deepEqual(kimi.instances.map((i) => i.id), [`kimi-${KIMI_PID}`]);
    assert.equal(kimi.instances[0].requests, 6);
    assert.equal(kimi.instances[0].activeRequests, 1);
    inflight.recordEnd({ status: 200, usage: { prompt_tokens: 3, completion_tokens: 2 } });
    kimi = await kimiCard(collector);
    assert.equal(kimi.instances[0].activeRequests, 0, "恢复后请求正常收尾");
    assert.equal(kimi.instances[0].requests, 6);
  });

  it("降级轮里进程真死了，仍然即时淘汰并结算它泄漏的在途", async () => {
    let t = 3000;
    let psAnswer = healthyScan(KIMI_PID);
    let tasklistAnswer = tasklistScan(KIMI_PID);
    const execFn = (cmd, opts, cb) => cb(null, cmd.includes("tasklist") ? tasklistAnswer : psAnswer);
    const collector = testCollector({ execFn, nowFn: () => t, kimiRegistryLookup: noSurfaces });

    await collector.getAgentsStatus();
    collector.startRequest({ agentId: "kimi", instanceId: `kimi-${KIMI_PID}`, providerId: "p1", model: "m1" });
    assert.equal((await kimiCard(collector)).metrics.activeRequests, 1);

    // 进程真的没了：探针空答，回落的全量 pid 列表里也没有这个 pid。
    psAnswer = "";
    tasklistAnswer = unrelatedScan;
    t += 10_000;
    await settleRound(collector);
    const kimi = await kimiCard(collector);
    assert.deepEqual(kimi.instances, [], "本轮全量 pid 里没有它 → 照样即时淘汰");
    assert.equal(kimi.metrics.activeRequests, 0, "泄漏的在途在端点聚合里一并结算");
  });

  it("健康轮里进程退出，淘汰照旧（闸门只作用于不完整轮）", async () => {
    let t = 3000;
    let psAnswer = healthyScan(KIMI_PID);
    const execFn = (cmd, opts, cb) => cb(null, cmd.includes("tasklist") ? tasklistScan(KIMI_PID) : psAnswer);
    const collector = testCollector({ execFn, nowFn: () => t, kimiRegistryLookup: noSurfaces });

    await collector.getAgentsStatus();
    collector.startRequest({ agentId: "kimi", instanceId: `kimi-${KIMI_PID}`, providerId: "p1", model: "m1" });

    // 完整轮（带命令行）里 kimi 进程消失：桶内 pid 集为空即判死。
    psAnswer = `Node,CommandLine,Name,ProcessId\r\nLAPTOP,C:\\Windows\\explorer.exe,explorer.exe,9001\r\n`;
    t += 10_000;
    await settleRound(collector);
    const kimi = await kimiCard(collector);
    assert.deepEqual(kimi.instances, [], "完整轮仍然按桶内 pid 集即时淘汰");
    assert.equal(kimi.metrics.activeRequests, 0);
  });
});

// ---------------------------------------------------------------------------
// node 桶失配行兜底与第三道护栏（2026-11-01）。
//
// node 桶的五组安装路径谓词都认不出的 npm 形 node 行（上游改包名后的会话行形状）
// 此前静默归零：计数没有去处，读侧还把它当「事实零」淘汰实例行、清在途账。修复
// 后：失配行以 unclaimedNodeRows 计数（不进任何端点桶，整轮可信位也不动）；读侧
// 的实例行淘汰与零值结算在该计数非零时挂上全表生死联动（scanPidLiveness）——
// pid 活着就留行，确实死了照删。自进程与裸 node 脚本（命令行无 node_modules）
// 不入计数，护栏对该计数为零的轮次逐位等价于不存在（既有用例全部照旧）。
describe("node 桶失配行兜底与第三道护栏", () => {
  const OLD_PID = 41000;
  const RENAMED_PID = 41376;
  const noSurfaces = async () => new Map();
  // 常驻探针的真实行形状：<pid>,<ppid>,<name>,<command line>——带父进程列，
  // 全表生死判定（scanPidLiveness）才有据可依；WMIC 旧形状没有 ppid，判不了
  // 生死时护栏按既有口径保守留行，测不出「确实死了的照删」。
  const psScan = (rows) => rows.join("\r\n") + "\r\n";
  // 健康形状：旧包名的 kimi 会话行（isKimiNode 认领）。
  const claimedKimiRow = (pid) =>
    `${pid},500,node.exe,C:\\Tools\\node.exe C:\\x\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs`;
  // 上游改包名后的形状：五组谓词全失配，但命令行带 node_modules。
  const renamedNodeRow = (pid) =>
    `${pid},7000,node.exe,C:\\u\\AppData\\Roaming\\npm\\node_modules\\@moonshot-ai\\kimi-code-next\\lib\\start.mjs`;
  const unrelatedRow = "9001,100,explorer.exe,C:\\Windows\\explorer.exe";
  const settleRound = async (collector) => {
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 20));
  };
  const kimiCard = async (collector) => (await collector.getAgentsStatus()).find((a) => a.id === "kimi");
  // 直取扫描快照的同款节奏：落地前的读者一律服务上一轮，先踢一轮再取。
  const scanRound = async (collector) => {
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 20));
    return collector.scanProcesses();
  };

  it("失配的 npm 形 node 行有计数去处，但不进任何端点桶、整轮可信位不动", async () => {
    let t = 3000;
    let psAnswer = psScan([renamedNodeRow(RENAMED_PID)]);
    const collector = testCollector({
      execFn: (cmd, opts, cb) => cb(null, cmd.includes("tasklist") ? "" : psAnswer),
      nowFn: () => t,
      kimiRegistryLookup: noSurfaces,
    });
    const procs = await collector.scanProcesses();
    assert.equal(procs.unclaimedNodeRows, 1, "失配行入兜底计数，不再静默");
    assert.equal(procs.kimi, 0, "不凭镜像名或路径猜归属，端点桶不动");
    assert.equal(procs.kimiPids.size, 0);
    assert.equal(procs.countsAuthoritative, true, "整轮可信位不动（自进程与无关 node 工具每轮常在，整轮降级等于可信模式常关）");
    assert.ok(procs.seenPids.has(RENAMED_PID), "行本身仍进全表 pid，生死判定有据");

    // 认领命中的行、自进程与裸脚本（命令行无 node_modules）都不入兜底计数。
    psAnswer = psScan([
      claimedKimiRow(OLD_PID),
      '1001,1000,node.exe,"C:\\Program Files\\nodejs\\node.exe"  "C:\\Users\\u\\AppData\\Local\\Anyswitch\\app\\src\\relay\\relay-host.mjs"',
      "1002,1000,node.exe,C:\\tools\\srv.js",
    ]);
    t += 10_000;
    const procs2 = await scanRound(collector);
    assert.equal(procs2.unclaimedNodeRows, 0, "认领命中行、自进程、裸脚本都不算失配行");
    assert.equal(procs2.kimi, 1);
  });

  it("降级轮（无命令行）不产生失配计数：盲轮语义仍归 50a41fc 管", async () => {
    let t = 3000;
    let psAnswer = "";
    const collector = testCollector({
      execFn: (cmd, opts, cb) => cb(null, cmd.includes("tasklist") ? `"node.exe","${RENAMED_PID}","Console","1","120,000 K"\r\n` : psAnswer),
      nowFn: () => t,
      kimiRegistryLookup: noSurfaces,
    });
    const procs = await collector.scanProcesses();
    assert.equal(procs.countsAuthoritative, false, "确认走的是降级轮");
    assert.equal(procs.unclaimedNodeRows, 0, "没有命令行就没有形状可判，计数不入场");
  });

  it("改名会话的实例行不再被事实零淘汰：pid 活着就留行，确实死了照删", async () => {
    let t = 3000;
    let psAnswer = psScan([claimedKimiRow(OLD_PID)]);
    const collector = testCollector({
      execFn: (cmd, opts, cb) => cb(null, cmd.includes("tasklist") ? "" : psAnswer),
      nowFn: () => t,
      kimiRegistryLookup: noSurfaces,
    });
    let kimi = await kimiCard(collector);
    assert.deepEqual(kimi.instances.map((i) => i.id), [`kimi-${OLD_PID}`], "前置：健康轮占位行在");

    // 旧会话（认领形状）退出、改名行进轮；等这一轮落地后再给改名会话起在途
    // 请求（先起会被「服务上一轮快照」的读按旧 pid 集当轮删掉，测不到护栏）。
    psAnswer = psScan([renamedNodeRow(RENAMED_PID)]);
    t += 10_000;
    await settleRound(collector);
    const inflight = collector.startRequest({ agentId: "kimi", instanceId: `kimi-${RENAMED_PID}`, providerId: "p1", model: "m1", stream: true, path: "openai" });
    inflight.recordFirstChunk();
    kimi = await kimiCard(collector);
    assert.deepEqual(kimi.instances.map((i) => i.id), [`kimi-${RENAMED_PID}`],
      "修复前：桶内 pid 集为空 + 可信轮 → 在途的改名会话行当轮被删");
    assert.equal(kimi.instances[0].activeRequests, 1, "行级在途不被零值结算清掉");
    assert.equal(kimi.metrics.activeRequests, 1, "端点聚合的账面与行同进退，不得按假零清算");
    assert.equal(kimi.processCount, 0, "桶内计数语义不动：认不出就是不计入");

    // 改名进程确实退出（全表无此 pid）：护栏退位，照常即时淘汰并结算。
    psAnswer = psScan([unrelatedRow]);
    t += 10_000;
    await settleRound(collector);
    kimi = await kimiCard(collector);
    assert.deepEqual(kimi.instances, [], "确实死了的照删");
    assert.equal(kimi.metrics.activeRequests, 0, "泄漏的在途照常结算");
  });

  it("claude 会话行同理：改名窗口内不被 ended 闩收走", async () => {
    let t = 3000;
    let psAnswer = psScan([renamedNodeRow(RENAMED_PID)]);
    const collector = testCollector({
      execFn: (cmd, opts, cb) => cb(null, cmd.includes("tasklist") ? "" : psAnswer),
      nowFn: () => t,
      kimiRegistryLookup: noSurfaces,
    });
    collector.reportSession("token_claude_renamed", {
      pid: RENAMED_PID,
      requests: 3,
      activeRequests: 1,
      activeDurationMs: 15000,
      promptTokens: 2000,
      completionTokens: 300,
    });
    const claude = (await collector.getAgentsStatus()).find((a) => a.id === "claude");
    assert.equal(claude.sessions.length, 1, "修复前：pid 不在 claudePids → 行被闩成 ended 当轮消失");
    assert.equal(claude.sessions[0].id, `claude-${RENAMED_PID}`);
    assert.equal(claude.sessions[0].requests, 3);

    // 进程确实退出（全表无此 pid）：ended 闩照常工作。
    psAnswer = psScan([unrelatedRow]);
    t += 10_000;
    await settleRound(collector);
    const claudeAfter = (await collector.getAgentsStatus()).find((a) => a.id === "claude");
    assert.equal(claudeAfter.sessions.length, 0, "确实死了的照常闩 ended");
  });
});

// 降级轮不得把一个桌面端拆成一排「CLI 实例」（2026-10-05 用户报障：只开一个
// Claude Desktop，claude 卡却出现十几个带 CLI 徽标的实例行，刷新页面后又好了）。
// 根因：桌面形态的分型与折叠都以命令行为唯一依据，而回落 tasklist 的那一轮每一
// 行都没有命令行——桌面壳和它的 Electron 子进程于是逐个成行，再按「认不出就当
// CLI」的默认值各贴一枚 CLI 徽标，卡片副行跟着报出「CLI ×n」。修复后：降级轮只
// 判生死（本轮全量 pid），分型与归属沿用上一轮可信扫描的答案；可信轮从未见过的
// 新进程仍然不猜形态（「宁可漏折，不可误折」不动）。
describe("进程扫描降级轮沿用上一轮可信分型，不造幽灵实例行", () => {
  // 真机取证：一个 Claude Desktop 的 claude.exe 全家福 = MSIX 桌面壳 + 其
  // Electron 子进程（--type=）+ 桌面托管引擎（<根>\claude-code\<semver>\）。
  const SHELL = "C:\\Program Files\\WindowsApps\\Claude_2.9939.2.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe";
  const ENGINE = "C:\\Users\\tester\\AppData\\Local\\Claude-3p\\claude-code\\2.1.246\\claude.exe";
  const SHELL_PID = 14640;
  const HELPER_PID = 41728;
  const ENGINE_A = 5416;
  const ENGINE_B = 18392;
  const ALL_PIDS = [SHELL_PID, HELPER_PID, ENGINE_A, ENGINE_B];
  const healthyScan = () => [
    "Node,CommandLine,Name,ProcessId",
    `LAPTOP,${SHELL},claude.exe,${SHELL_PID}`,
    `LAPTOP,${SHELL} --type=gpu-process --user-data-dir=C:\\Users\\tester\\AppData\\Local\\Claude-3p,claude.exe,${HELPER_PID}`,
    `LAPTOP,${ENGINE} --output-format stream-json --verbose,claude.exe,${ENGINE_A}`,
    `LAPTOP,${ENGINE} --output-format stream-json --verbose,claude.exe,${ENGINE_B}`,
  ].join("\r\n") + "\r\n";
  // 降级轮：同一批进程号，tasklist CSV 形状只给得出镜像名。
  const blindScan = (pids = ALL_PIDS) =>
    pids.map((pid) => `"claude.exe","${pid}","Console","1","120,000 K"`).join("\r\n") + "\r\n";
  const settleRound = async (collector) => {
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 20));
  };
  const claudeCard = async (collector) =>
    (await collector.getAgentsStatus()).find((a) => a.id === "claude");

  it("健康轮折成一行的桌面端，降级轮到达时仍然只有那一行", async () => {
    let t = 3000;
    let psAnswer = healthyScan();
    const execFn = (cmd, opts, cb) => cb(null, cmd.includes("tasklist") ? blindScan() : psAnswer);
    const collector = testCollector({ execFn, nowFn: () => t });

    await settleRound(collector);
    let cc = await claudeCard(collector);
    assert.deepEqual(cc.instances.map((i) => i.id), ["claude-desktop"], "健康轮：桌面端折叠成一行");
    assert.equal(cc.surfaces.find((s) => s.label === "TUI"), undefined, "健康轮一个 CLI 客户端也没有");

    // 探针这一轮不答 → 回落 tasklist：四个进程号全在，命令行一条都没有。
    psAnswer = "";
    t += 10_000;
    await settleRound(collector);
    cc = await claudeCard(collector);
    assert.deepEqual(cc.instances.map((i) => i.id), ["claude-desktop"],
      "降级轮的「读不到命令行」不是「这些是 CLI 会话」的证据");
    assert.deepEqual(cc.surfaces, [{ surface: "desktop", label: "Desktop", count: 1 }],
      "副行照旧只报一个桌面端，不报 CLI ×n");
  });

  it("盲轮期间刚起的、可信轮没见过的进程不贴形态徽标", async () => {
    let t = 3000;
    const onlyShell = `Node,CommandLine,Name,ProcessId\r\nLAPTOP,${SHELL},claude.exe,${SHELL_PID}\r\n`;
    let psAnswer = onlyShell;
    const execFn = (cmd, opts, cb) => cb(null, cmd.includes("tasklist") ? blindScan([SHELL_PID, 99999]) : psAnswer);
    const collector = testCollector({ execFn, nowFn: () => t });

    await settleRound(collector);
    psAnswer = "";
    t += 10_000;
    await settleRound(collector);
    const cc = await claudeCard(collector);
    // 14640 沿用可信轮的桌面分型（并进那一行）；99999 是盲轮期间第一次被看到的
    // 进程，谁也不知道它是什么——宁可这行少一枚徽标，也不把「看不见」说成「CLI」。
    assert.deepEqual(cc.instances.map((i) => i.id), ["claude-desktop", "claude-99999"]);
    assert.equal(cc.instances[0].surface, "Desktop", "沿用下来的桌面行照旧贴徽标");
    assert.equal(cc.instances[1].surface, undefined, "读不出形态的行不贴徽标");
    assert.deepEqual(cc.surfaces, [{ surface: "desktop", label: "Desktop", count: 1 }],
      "读不出形态的进程不计进 CLI 那一档");
  });

  it("冷启动第一轮就是降级轮时，不造逐进程的空实例行", async () => {
    // 2026-10-07 报障的另一半：上面两条的前提都是「先有过一轮可信扫描」。面板/中继
    // 刚起的那一轮没有可信轮可沿，carry 直接空转，于是桌面端全家福逐个成行——本机实测
    // 一次冷降级轮出 10 行「0 请求 / tokens 全 0 / 无徽标」的空实例卡，正是看板从出现到
    // 加载出数据那段中间态。规则：这一轮是降级轮且手里没有任何可信依据时，不新建行。
    let t = 3000;
    const execFn = (cmd, opts, cb) => cb(null, cmd.includes("tasklist") ? blindScan() : "");
    const collector = testCollector({ execFn, nowFn: () => t });

    const cc = await claudeCard(collector);
    assert.equal(cc.status, "running", "进程数仍是本轮的事实：桌面端确实在跑");
    assert.deepEqual(cc.instances, [], "读不出归属的那一轮不逐进程建行");
    assert.deepEqual(cc.surfaces, [], "也不报面");
  });

  it("可信轮过了沿用窗之后的降级轮，不再新增逐进程的空行", async () => {
    // 探针闲置 60s 被回收 → 下一次冷启动超时 → 落 tasklist；此时最近一次可信轮已在
    // 30s 沿用窗之外，carry 拒供。本条只管「不再凭空添行」：已有行带着自己攒下的账，
    // 折叠丢了就退回逐 pid（那是 50a41fc/99e4d9c 定下的保守保行，不在这里动）；但一个
    // 谁都不认识的进程号在这种轮次里新建一行，就是零请求零 tokens 的空实例卡。
    let t = 3000;
    let psAnswer = healthyScan();
    const extraPid = 99999;
    const execFn = (cmd, opts, cb) => cb(null, cmd.includes("tasklist")
      ? blindScan([...ALL_PIDS, extraPid]) : psAnswer);
    const collector = testCollector({ execFn, nowFn: () => t });

    await settleRound(collector);
    psAnswer = "";
    t += 60_000;
    await settleRound(collector);
    const cc = await claudeCard(collector);
    assert.ok(!cc.instances.some((i) => i.id === `claude-${extraPid}`),
      "没有可沿依据的降级轮不给陌生进程号建空行");
    assert.ok(cc.instances.length > 0, "可信轮认过的行一律留着，不因为降级轮而消失");
  });

  it("恢复可信轮后按本轮命令行重新分型，不被上一轮的旧值盖住", async () => {
    let t = 3000;
    let psAnswer = healthyScan();
    const execFn = (cmd, opts, cb) => cb(null, cmd.includes("tasklist") ? blindScan() : psAnswer);
    const collector = testCollector({ execFn, nowFn: () => t });

    await settleRound(collector);
    psAnswer = "";
    t += 10_000;
    await settleRound(collector);

    // 同一个进程号，这一轮读得到的命令行是 npm 全局 CLI 的形状：本轮的正证说话。
    psAnswer = healthyScan().replace(
      `${ENGINE} --output-format stream-json --verbose,claude.exe,${ENGINE_A}`,
      "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe,claude.exe," + ENGINE_A,
    );
    t += 10_000;
    await settleRound(collector);
    const cc = await claudeCard(collector);
    assert.deepEqual(cc.instances.map((i) => i.id), ["claude-desktop", `claude-${ENGINE_A}`],
      "真 CLI 从桌面行里分出去");
    assert.equal(cc.instances[1].surface, "TUI", "分型由本轮命令行决定");
  });

  it("终端里经 node 起的 claude 仍标明 CLI 形态", async () => {
    const t = 3000;
    const csv = "Node,CommandLine,Name,ProcessId\r\n"
      + `LAPTOP,"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs",node.exe,4321\r\n`;
    const collector = testCollector({ execFn: (cmd, opts, cb) => cb(null, csv), nowFn: () => t });

    const cc = await claudeCard(collector);
    assert.deepEqual(cc.instances.map((i) => i.id), ["claude-4321"]);
    assert.equal(cc.instances[0].surface, "TUI", "读得出命令行且不在桌面形状里＝CLI");
    assert.deepEqual(cc.surfaces, [{ surface: "cli", label: "TUI", count: 1 }]);
  });

  it("沿用有时限：降级持续过窗口后不再猜形态，可信轮回来即恢复折叠", async () => {
    let t = 3000;
    let psAnswer = healthyScan();
    const execFn = (cmd, opts, cb) => cb(null, cmd.includes("tasklist") ? blindScan() : psAnswer);
    const collector = testCollector({ execFn, nowFn: () => t });

    await settleRound(collector);
    psAnswer = "";
    // 一直读不到命令行，且推过沿用窗口（30s）：进程号还活着，所以行不会消失，
    // 但也不再拿一分钟内都不知所措的旧分型把它们说成桌面端——行留在卡上、
    // 不贴任何形态徽标，宁可漏折不可误折。
    t += 60_000;
    await settleRound(collector);
    let cc = await claudeCard(collector);
    assert.equal(cc.instances.length, ALL_PIDS.length, "过窗后按本轮逐进程成行");
    assert.ok(cc.instances.every((i) => i.surface === undefined), "过窗后一律不贴形态徽标");
    assert.deepEqual(cc.surfaces, [], "既读不出形态，副行就没有任何一档可写");

    // 可信轮回来：折叠与徽标立刻恢复。
    psAnswer = healthyScan();
    t += 10_000;
    await settleRound(collector);
    cc = await claudeCard(collector);
    assert.deepEqual(cc.instances.map((i) => i.id), ["claude-desktop"]);
    assert.equal(cc.instances[0].surface, "Desktop");
  });
});

// Kimi 卡同一条链的另一处症状：桌面端 Electron 子进程在降级轮里被当成会话宿主
// （认出「这是子进程」靠的也是命令行），于是一张卡裂成多行、副行报出成倍的桌面端。
describe("进程扫描降级轮不把 kimi 桌面端的子进程当成会话宿主", () => {
  const KIMI_SHELL = "C:\\Users\\tester\\AppData\\Local\\Programs\\Kimi\\Kimi Code.exe";
  const MAIN_PID = 7100;
  const HELPER_PID = 7101;
  const healthyScan = () => [
    "Node,CommandLine,Name,ProcessId",
    `LAPTOP,"${KIMI_SHELL}",Kimi Code.exe,${MAIN_PID}`,
    `LAPTOP,"${KIMI_SHELL}" --type=renderer,Kimi Code.exe,${HELPER_PID}`,
  ].join("\r\n") + "\r\n";
  const blindScan = () => [MAIN_PID, HELPER_PID]
    .map((pid) => `"Kimi Code.exe","${pid}","Console","1","150,000 K"`).join("\r\n") + "\r\n";
  const settleRound = async (collector) => {
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 20));
  };
  const kimiCard = async (collector) => (await collector.getAgentsStatus()).find((a) => a.id === "kimi");

  it("降级轮里桌面端仍然只算一个会话宿主", async () => {
    let t = 3000;
    let psAnswer = healthyScan();
    const execFn = (cmd, opts, cb) => cb(null, cmd.includes("tasklist") ? blindScan() : psAnswer);
    const collector = testCollector({
      execFn, nowFn: () => t, kimiRegistryLookup: async () => new Map(),
    });

    await settleRound(collector);
    let kimi = await kimiCard(collector);
    assert.deepEqual(kimi.surfaces, [{ surface: "desktop", label: "Desktop", count: 1 }],
      "健康轮：主进程算宿主，--type= 子进程不算");

    psAnswer = "";
    t += 10_000;
    await settleRound(collector);
    kimi = await kimiCard(collector);
    assert.deepEqual(kimi.surfaces, [{ surface: "desktop", label: "Desktop", count: 1 }],
      "降级轮不得因为读不出 --type= 就把子进程也报成宿主");
  });
});

// ---------------------------------------------------------------------------
// 端点进程家族全灭即「本次运行」结束，整账归零（run zeroing，2026-10-04 用户
// 报障：zcode 卡工时会随着总运行时间一直涨，中途关掉再开不清零）。根因：工时
// 计数自建仓起是终身累计的忙碌区间并集，09-17 快照持久化（927be08）后又跨
// relay 重启续命，全程没有任何一处归零。规则：可信扫描轮确认端点进程数归零、
// 且距最后活动已过 PROCESS_GONE_ACTIVE_REQUEST_TTL_MS（与孤儿请求结算同一道
// 3s 闸门），settleAndResetRunAccount → resetEndpointRunAccount 把该端点的整份
// 账原位重置：已工作时间、请求数、tokens、折线样本、模型/渠道身份、lastSeen、
// 故障史全部回零，下次启动从 0 重计。不是「只清工时、累计量照留」——本 describe
// 的第一条用例把 totalRequests 也钉成 0。
describe("已工作时间随端点关闭清零", () => {
  const ZCODE_PID = 20588;
  const zcodeScan = (pid) =>
    `Node,CommandLine,ProcessId\r\nLAPTOP,C:\\Programs\\ZCode.exe,${pid}\r\n`;
  // 健康轮里只剩无关进程：计数可信、zcode 桶为 0。
  const goneScan = `Node,CommandLine,ProcessId\r\nLAPTOP,C:\\Windows\\explorer.exe,9001\r\n`;
  const tasklistUnrelated = '"explorer.exe","9001","Console","1","40,000 K"\r\n';
  const settleRound = async (collector) => {
    await collector.getAgentsStatus();
    await new Promise((r) => setTimeout(r, 20));
  };
  const zcodeCard = async (collector) => (await collector.getAgentsStatus()).find((a) => a.id === "zcode");

  it("进程退出过 3s 宽限，已工作时间清零；重开从 0 重新累计", async () => {
    let t = 3000;
    let scan = zcodeScan(ZCODE_PID);
    const execFn = (cmd, opts, cb) => cb(null, scan);
    const collector = testCollector({ execFn, nowFn: () => t });

    await settleRound(collector); // 扫描落地：zcode 在跑
    let zcode = await zcodeCard(collector);
    assert.equal(zcode.status, "running");

    const r = collector.startRequest({ agentId: "zcode", providerId: "p1", model: "m1" }); // 起点 3000
    t = 7000;
    r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } }); // 结算 4000ms

    t = 13000; // 进程活着、空闲 6s：计数不走字
    zcode = await zcodeCard(collector);
    assert.equal(zcode.metrics.activeDurationMs, 4000, "空闲不计时，只累计忙碌区间");

    scan = goneScan;
    t = 17000; // 过扫描缓存（新一轮认不出 zcode），距收尾 10000ms > 3s 宽限
    await settleRound(collector);
    zcode = await zcodeCard(collector);
    assert.equal(zcode.status, "stopped");
    assert.equal(zcode.metrics.activeDurationMs, 0, "端点关闭过宽限，已工作时间清零");
    assert.equal(zcode.sessions[0].activeDurationMs, 0, "全局汇总行同步清零");
    assert.equal(zcode.metrics.totalRequests, 0, "进程全灭过宽限，本次运行的请求数一并清零");

    // 重开（新 pid）：从 0 起，不接旧值。
    scan = zcodeScan(20604);
    t = 21000;
    await settleRound(collector);
    const r2 = collector.startRequest({ agentId: "zcode", providerId: "p1", model: "m1" }); // 21000
    t = 21500;
    r2.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } }); // 500ms
    zcode = await zcodeCard(collector);
    assert.equal(zcode.metrics.activeDurationMs, 500, "重开后从 0 重新累计");
    assert.equal(zcode.metrics.totalRequests, 1, "新运行从 0 计数，不接旧账");
  });

  it("3s 宽限期内不清零，过宽限才清", async () => {
    let t = 3000;
    let scan = zcodeScan(ZCODE_PID);
    const execFn = (cmd, opts, cb) => cb(null, scan);
    const collector = testCollector({ execFn, nowFn: () => t });

    await settleRound(collector);
    const r = collector.startRequest({ agentId: "zcode", providerId: "p1", model: "m1" }); // 3000
    t = 6000;
    r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } }); // 结算 3000ms

    scan = goneScan;
    t = 8000; // 距收尾 2000ms ≤ 宽限
    await settleRound(collector);
    let zcode = await zcodeCard(collector);
    assert.equal(zcode.metrics.activeDurationMs, 3000, "宽限期内不清零");

    t = 12000; // 距收尾 6000ms > 宽限
    await settleRound(collector);
    zcode = await zcodeCard(collector);
    assert.equal(zcode.metrics.activeDurationMs, 0, "过宽限即清零");
  });

  it("降级轮（tasklist 回落、认不出归属）不清零", async () => {
    let t = 3000;
    let psAnswer = zcodeScan(ZCODE_PID);
    const execFn = (cmd, opts, cb) => cb(null, cmd.includes("tasklist") ? tasklistUnrelated : psAnswer);
    const collector = testCollector({ execFn, nowFn: () => t });

    await settleRound(collector);
    const r = collector.startRequest({ agentId: "zcode", providerId: "p1", model: "m1" }); // 3000
    t = 6000;
    r.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } }); // 3000ms

    // 探针空答 → 回落 tasklist；有一行无关进程 → 桶内计数不可信（50a41fc 口径）。
    psAnswer = "";
    t = 12000; // 距收尾 6000ms > 宽限，但本轮不可信
    await settleRound(collector);
    const zcode = await zcodeCard(collector);
    assert.equal(zcode.metrics.activeDurationMs, 3000, "不可信轮的「零进程」是看不见，不清零");
  });

  it("在飞请求随进程死亡先结算，工时不留下结算出的尾巴", async () => {
    let t = 3000;
    let scan = zcodeScan(ZCODE_PID);
    const execFn = (cmd, opts, cb) => cb(null, scan);
    const collector = testCollector({ execFn, nowFn: () => t });

    await settleRound(collector);
    collector.startRequest({ agentId: "zcode", providerId: "p1", model: "m1" }); // 3000，永不收尾

    scan = goneScan;
    t = 12000; // 距在飞起点 9000ms > 宽限
    await settleRound(collector);
    const zcode = await zcodeCard(collector);
    assert.equal(zcode.metrics.activeRequests, 0, "孤儿请求照旧结算");
    assert.equal(zcode.metrics.activeDurationMs, 0, "工时随关闭清零，连孤儿尾巴一并清");
  });
});

describe("claude conversation fold (session registry)", () => {
  // 双答探针：主扫描（Get-CimInstance 全表 dump）答进程表；会话归属的启动
  // 刻度查询（Get-Process -Id …，见 claude-session-registry.mjs）答
  // pid,filetime 行。其余可选查询（kimi 形态、DSH 控制台）答空串。
  const makeFoldProbe = (scanCsv, procStartAnswer) => () => {
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    stdout.setEncoding = () => {};
    const stderr = new EventEmitter();
    stderr.resume = () => {};
    child.stdin = {
      write: (text) => {
        const markerMatch = text.match(/Write-Output '([^']+)'/);
        const marker = markerMatch ? markerMatch[1] : "";
        let body = text.includes("Get-Process -Id") ? procStartAnswer : "";
        if (!text.includes("Get-Process -Id") && text.includes("Win32_Process")) body = scanCsv;
        if (body.length > 0 && !body.endsWith("\r\n")) body += "\r\n";
        stdout.emit("data", body + marker + "\r\n");
      },
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => { child.emit("exit", 0); };
    child.unref = () => {};
    return child;
  };

  const CLAUDE_TWO_CLI =
    `"claude.exe","4444","Console","1","55,000 K"\r\n` +
    `"claude.exe","5555","Console","1","55,000 K"\r\n`;

  const writeRegistry = (dir, rows) => {
    for (const [pid, sessionId, procStart] of rows) {
      writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, procStart, kind: "interactive" }));
    }
  };

  const claudeCard = async (collector) => (await collector.getAgentsStatus()).find((a) => a.id === "claude");

  it("folds two processes driving one conversation into a single stable row", async () => {
    // 2026-11-01 报障现场：一条对话被 resume 附着的第二个进程并发驱动，看板
    // 扫出两张各带活跃数据的 TUI 卡。注册表把两个 pid 指到同一条会话。
    const dir = mkTestDir();
    writeRegistry(dir, [[4444, "sess-abc", "111"], [5555, "sess-abc", "222"]]);
    const collector = testCollector({
      spawnFn: makeFoldProbe(CLAUDE_TWO_CLI, "4444,111\r\n5555,222\r\n"),
      nowFn: () => 10000,
      claudeSessionsDir: dir,
    });

    collector.reportSession("tok_A", {
      pid: 4444, requests: 3, activeRequests: 1, activeDurationMs: 1000,
      promptTokens: 2000, completionTokens: 300, cachedTokens: 1500,
    });
    collector.reportSession("tok_B", {
      pid: 5555, requests: 2, activeRequests: 1, activeDurationMs: 500,
      promptTokens: 1000, completionTokens: 100, cachedTokens: 500,
    });

    const claude = await claudeCard(collector);
    assert.equal(claude.sessionsCount, 1, "two pids of one conversation are one row");
    const row = claude.sessions[0];
    assert.equal(row.id, "claude-sess-sess-abc");
    assert.deepEqual(row.memberPids, [4444, 5555]);
    assert.equal(row.status, "active");
    assert.equal(row.requests, 5, "counts sum across member processes");
    assert.equal(row.activeRequests, 2, "in-flight is the union of both members");
    assert.equal(row.tokens.prompt, 3000);
    assert.equal(row.tokens.cached, 2000);
  });

  it("keeps distinct conversations as separate rows (a single member still gets the stable session id)", async () => {
    const dir = mkTestDir();
    writeRegistry(dir, [[4444, "sess-a", "111"], [5555, "sess-b", "222"]]);
    const collector = testCollector({
      spawnFn: makeFoldProbe(CLAUDE_TWO_CLI, "4444,111\r\n5555,222\r\n"),
      nowFn: () => 10000,
      claudeSessionsDir: dir,
    });

    collector.reportSession("tok_A", { pid: 4444, requests: 1, activeRequests: 0 });
    collector.reportSession("tok_B", { pid: 5555, requests: 1, activeRequests: 0 });

    const claude = await claudeCard(collector);
    assert.equal(claude.sessionsCount, 2);
    const ids = claude.sessions.map((s) => s.id).sort();
    assert.deepEqual(ids, ["claude-sess-sess-a", "claude-sess-sess-b"]);
    // 单成员也换稳定身份：行身份跨进程换代延续（重启/续接不再裂行），且
    // memberPids 让下游（终端归属、最近请求）仍能映回进程键。
    assert.deepEqual(claude.sessions.map((s) => s.memberPids).sort(), [[4444], [5555]]);
  });

  it("refuses the fold when the live start tick disagrees (PID reuse: stale registry file)", async () => {
    const dir = mkTestDir();
    writeRegistry(dir, [[4444, "sess-abc", "111"], [5555, "sess-abc", "222"]]);
    const collector = testCollector({
      // 4444 的实时刻度与注册表对不上：旧文件碰上了同名新进程。
      spawnFn: makeFoldProbe(CLAUDE_TWO_CLI, "4444,999\r\n5555,222\r\n"),
      nowFn: () => 10000,
      claudeSessionsDir: dir,
    });

    collector.reportSession("tok_A", { pid: 4444, requests: 1, activeRequests: 0 });
    collector.reportSession("tok_B", { pid: 5555, requests: 1, activeRequests: 0 });

    const claude = await claudeCard(collector);
    assert.equal(claude.sessionsCount, 2, "no attribution, no fold — 宁可漏折，不可误折");
    const ids = claude.sessions.map((s) => s.id).sort();
    assert.deepEqual(ids, ["claude-4444", "claude-sess-sess-abc"]);
  });

  it("keeps per-pid rows when the registry has no answer (pre-2.1 CC or unreadable dir)", async () => {
    const dir = mkTestDir(); // 空目录：没有任何注册表文件
    const collector = testCollector({
      spawnFn: makeFoldProbe(CLAUDE_TWO_CLI, "4444,111\r\n5555,222\r\n"),
      nowFn: () => 10000,
      claudeSessionsDir: dir,
    });

    collector.reportSession("tok_A", { pid: 4444, requests: 1, activeRequests: 0 });
    collector.reportSession("tok_B", { pid: 5555, requests: 1, activeRequests: 0 });

    const claude = await claudeCard(collector);
    assert.equal(claude.sessionsCount, 2);
    assert.deepEqual(claude.sessions.map((s) => s.id).sort(), ["claude-4444", "claude-5555"]);
  });

  it("publishes activity frames on the folded row with the conversation-wide count", async () => {
    const dir = mkTestDir();
    writeRegistry(dir, [[4444, "sess-abc", "111"], [5555, "sess-abc", "222"]]);
    const collector = testCollector({
      spawnFn: makeFoldProbe(CLAUDE_TWO_CLI, "4444,111\r\n5555,222\r\n"),
      nowFn: () => 10000,
      claudeSessionsDir: dir,
    });
    const frames = [];
    collector.onActivity((f) => frames.push(f));
    const sig = (f) => [f.type, f.endpointId, f.instanceId, f.activeRequests];

    await claudeCard(collector); // 落一轮可信扫描，归属映射进缓存
    assert.deepEqual(frames, [], "scans publish nothing");

    collector.reportSession("tok_A", { pid: 4444, activeRequests: 1 });
    assert.deepEqual(frames.map(sig), [["activity", "claude", "claude-sess-sess-abc", 1]],
      "member A 0→N: the folded row lights up with the conversation total");

    collector.reportSession("tok_B", { pid: 5555, activeRequests: 1 });
    assert.deepEqual(frames.map(sig), [
      ["activity", "claude", "claude-sess-sess-abc", 1],
      ["activity", "claude", "claude-sess-sess-abc", 2],
    ], "member B 0→N: both members busy, total 2");

    collector.reportSession("tok_A", { pid: 4444, activeRequests: 0 });
    assert.deepEqual(frames.map(sig).at(-1), ["activity", "claude", "claude-sess-sess-abc", 1],
      "member A goes idle but B still runs — the row must not blink off");

    collector.reportSession("tok_B", { pid: 5555, activeRequests: 0 });
    assert.deepEqual(frames.map(sig).at(-1), ["activity", "claude", "claude-sess-sess-abc", 0]);
    assert.equal(frames.length, 4);
  });

  it("a reporter's first frame counts itself (publish happens after the session lands)", async () => {
    // 时点钉：0→N 帧若在 claudeSessions.set 之前发，折叠合计会漏掉首发会话
    // 自己（彼时 map 里还看不到它），单成员会话的首帧会错发 0。
    const dir = mkTestDir();
    writeRegistry(dir, [[4444, "sess-abc", "111"]]);
    const collector = testCollector({
      spawnFn: makeFoldProbe(`"claude.exe","4444","Console","1","55,000 K"\r\n`, "4444,111\r\n"),
      nowFn: () => 10000,
      claudeSessionsDir: dir,
    });
    const frames = [];
    collector.onActivity((f) => frames.push(f));

    await claudeCard(collector);
    collector.reportSession("tok_A", { pid: 4444, activeRequests: 1 });
    assert.deepEqual(frames.map((f) => [f.instanceId, f.activeRequests]), [["claude-sess-sess-abc", 1]]);
  });
});
