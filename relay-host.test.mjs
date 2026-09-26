// relay-host unit tests: startup log rotation and the
// synchronous crash-log path used by the fatal handlers. All file work happens
// in an os.tmpdir() sandbox — the production logs/relay-host.log is never
// touched.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { rotateLogIfNeeded, appendCrashLog, warmProcessScanCache, createTerminalHostSupervisor } from "./relay-host.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

function makeLogPath() {
  return join(mkTestDir("anyswitch-rh-"), "relay-host.log");
}

test("rotateLogIfNeeded leaves a small log untouched", () => {
  const logPath = makeLogPath();
  writeFileSync(logPath, "small\n", "utf8");

  assert.equal(rotateLogIfNeeded(logPath, 1024), false);
  assert.equal(existsSync(logPath), true);
  assert.equal(existsSync(`${logPath}.old`), false);
});

test("rotateLogIfNeeded renames an oversized log to .old", () => {
  const logPath = makeLogPath();
  writeFileSync(logPath, "x".repeat(2048), "utf8");

  assert.equal(rotateLogIfNeeded(logPath, 1024), true);
  assert.equal(existsSync(logPath), false, "the live log is renamed away");
  assert.equal(readFileSync(`${logPath}.old`, "utf8"), "x".repeat(2048));
});

test("rotateLogIfNeeded overwrites a previous .old", () => {
  const logPath = makeLogPath();
  writeFileSync(`${logPath}.old`, "previous generation\n", "utf8");
  writeFileSync(logPath, "y".repeat(4096), "utf8");

  assert.equal(rotateLogIfNeeded(logPath, 1024), true);
  assert.equal(readFileSync(`${logPath}.old`, "utf8"), "y".repeat(4096), "only one .old generation is kept");
});

test("rotateLogIfNeeded is a no-op when no log exists yet", () => {
  const logPath = makeLogPath(); // never written
  assert.equal(rotateLogIfNeeded(logPath, 1024), false);
  assert.equal(existsSync(`${logPath}.old`), false);
});

test("appendCrashLog synchronously appends the labelled crash trace", () => {
  const logPath = makeLogPath();
  writeFileSync(logPath, "before\n", "utf8");

  const err = new Error("boom");
  appendCrashLog(logPath, "uncaughtException", err);

  const text = readFileSync(logPath, "utf8");
  assert.match(text, /^before\n/);
  assert.match(text, /\[uncaughtException\] Error: boom/);
  assert.match(text, /at /, "the full stack trace lands in the crash log");
});

test("appendCrashLog never throws on an unwritable path", () => {
  appendCrashLog(join(tmpdir(), "anyswitch-no-such-dir", "relay-host.log"), "unhandledRejection", "lost");
});

// Startup warm-up of the collector's process-scan cache. The regression shape:
// the relay restarts while the panel tab is hidden, no poll ever primes the
// scan cache, and the first read after switching back pays the cold ~1s probe
// inline — past the panel's pull budget, so the panel falls back to its own
// zero-traffic collector and shows a "0 requests" frame for busy endpoints.
test("warmProcessScanCache kicks the collector's first scan round immediately", () => {
  let calls = 0;
  warmProcessScanCache({ scanProcesses: () => { calls += 1; return Promise.resolve({}); } });
  assert.equal(calls, 1, "startup must kick the scan round synchronously");
});

test("warmProcessScanCache does not wait for the scan round to land", () => {
  // A scan promise that never resolves: if the warm-up awaited it, the relay
  // startup path would hang right here.
  warmProcessScanCache({ scanProcesses: () => new Promise(() => {}) });
});

test("warmProcessScanCache swallows a rejected scan round without an unhandled rejection", async () => {
  const stray = [];
  const onRejection = (reason) => stray.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    assert.doesNotThrow(() => warmProcessScanCache({ scanProcesses: () => Promise.reject(new Error("probe dead")) }));
    await new Promise((r) => setTimeout(r, 20)); // give any stray rejection a tick to fire
    assert.deepEqual(stray, [], "warm-up failure must surface nowhere");
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("warmProcessScanCache tolerates missing or throwing collectors", () => {
  assert.doesNotThrow(() => warmProcessScanCache(null));
  assert.doesNotThrow(() => warmProcessScanCache(undefined));
  assert.doesNotThrow(() => warmProcessScanCache({}), "injected double without scanProcesses");
  assert.doesNotThrow(() => warmProcessScanCache({
    scanProcesses: () => { throw new Error("sync boom"); },
  }), "injected double that throws synchronously");
});

// createTerminalHostSupervisor: the relay owns the terminal host as a plain
// non-detached child (starts after listen, killed before exit), with the
// pre-start stale sweep in front and a refuse-to-fight stance on foreign port
// owners. spawnFn/cleanupStale/logger are injected — no real process ever
// starts.

function fakeChild(pid = 5150) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

function recordingLogger() {
  const logged = { info: [], warn: [] };
  return {
    logged,
    info: (line) => logged.info.push(String(line)),
    warn: (line) => logged.warn.push(String(line)),
  };
}

test("createTerminalHostSupervisor spawns a non-detached child carrying the relay pid env", async () => {
  const child = fakeChild();
  const calls = [];
  const supervisor = createTerminalHostSupervisor({
    root: "root-dir",
    spawnFn: (file, args, options) => {
      calls.push({ file, args, options });
      return child;
    },
    logger: recordingLogger(),
    env: { EXISTING: "1" },
    selfPid: 4242,
    cleanupStale: async () => ({ ok: true, killed: [], refused: [] }),
  });

  const result = await supervisor.start();
  assert.equal(result.ok, true);
  assert.equal(result.pid, 5150);
  assert.equal(calls.length, 1);
  const { file, args, options } = calls[0];
  assert.equal(file, process.execPath);
  assert.ok(args[0].endsWith("terminal-host.mjs"), `expected the terminal host script, got ${args[0]}`);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.windowsHide, true);
  assert.ok(!("detached" in options), "the child must stay in the relay's process tree — no detached flag");
  assert.equal(options.env.ANYSWITCH_TERMINAL_PARENT_PID, "4242", "the child learns its parent through the env");
  assert.equal(options.env.EXISTING, "1", "the ambient environment is passed through");
});

test("createTerminalHostSupervisor sweeps stale hosts before spawning", async () => {
  const order = [];
  const logger = recordingLogger();
  const supervisor = createTerminalHostSupervisor({
    spawnFn: () => {
      order.push("spawn");
      return fakeChild();
    },
    logger,
    cleanupStale: async () => {
      order.push("sweep");
      return { ok: true, killed: [2384], refused: [] };
    },
  });

  await supervisor.start();
  assert.deepEqual(order, ["sweep", "spawn"]);
  assert.ok(logger.logged.info.some((line) => line.includes("2384")), "the sweep is visible in the log");
});

test("createTerminalHostSupervisor skips the spawn when the sweep refuses a foreign owner", async () => {
  let spawns = 0;
  const logger = recordingLogger();
  const supervisor = createTerminalHostSupervisor({
    spawnFn: () => {
      spawns += 1;
      return fakeChild();
    },
    logger,
    cleanupStale: async () => ({
      ok: false,
      killed: [],
      refused: [777],
      reason: "refused to kill PID 777: command line does not identify it as an Anyswitch app process",
    }),
  });

  const result = await supervisor.start();
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(spawns, 0, "no fight for a port the sweep could not free");
  assert.ok(logger.logged.warn.some((line) => line.includes("777")), "the refusal reaches the log");
});

test("createTerminalHostSupervisor.start never breaks the relay when spawn throws", async () => {
  const logger = recordingLogger();
  const supervisor = createTerminalHostSupervisor({
    spawnFn: () => {
      throw new Error("spawn ENOENT");
    },
    logger,
    cleanupStale: async () => ({ ok: true, killed: [], refused: [] }),
  });

  const result = await supervisor.start();
  assert.equal(result.ok, false, "a failed spawn is a result, not an exception");
  assert.ok(logger.logged.warn.some((line) => line.includes("spawn ENOENT")));
});

test("createTerminalHostSupervisor logs an early child exit without throwing", async () => {
  const child = fakeChild();
  const logger = recordingLogger();
  const supervisor = createTerminalHostSupervisor({
    spawnFn: () => child,
    logger,
    cleanupStale: async () => ({ ok: true, killed: [], refused: [] }),
  });

  await supervisor.start();
  child.emit("exit", 1, null); // e.g. port 47823 still held by a zombie

  assert.ok(logger.logged.warn.some((line) => line.includes("exited early")), "the early exit is logged");
  supervisor.stop(); // the dead child is forgotten — stopping again is a no-op
});

test("createTerminalHostSupervisor.stop kills the child exactly once and tolerates repeats", async () => {
  const child = fakeChild();
  const supervisor = createTerminalHostSupervisor({
    spawnFn: () => child,
    logger: recordingLogger(),
    cleanupStale: async () => ({ ok: true, killed: [], refused: [] }),
  });

  await supervisor.start();
  supervisor.stop();
  assert.equal(child.killed, true, "shutdown kills the terminal host first");
  child.emit("exit", null, "SIGTERM"); // our own kill landing must not warn
  supervisor.stop();
  assert.doesNotThrow(() => supervisor.stop());
});
