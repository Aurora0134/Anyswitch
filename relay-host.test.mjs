// relay-host unit tests: startup log rotation and the
// synchronous crash-log path used by the fatal handlers. All file work happens
// in an os.tmpdir() sandbox — the production logs/relay-host.log is never
// touched.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { rotateLogIfNeeded, appendCrashLog, warmProcessScanCache, createTerminalHostSupervisor, createTerminalHostRoutes, mountTerminalHostRoutes, describeRelayStartupFailure } from "./relay-host.mjs";
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
  // Deterministic unwritable target inside the sandbox: the parent directory
  // is never created, so appendFileSync fails with ENOENT and the crash path
  // must swallow it — the fatal handler gets exactly one shot and must not
  // die again on its own evidence write. (Bare calls assert nothing and, run
  // against the real os.tmpdir(), were neither deterministic nor sandboxed.)
  assert.doesNotThrow(() => appendCrashLog(
    join(mkTestDir("anyswitch-rh-"), "missing-parent-dir", "relay-host.log"),
    "unhandledRejection",
    "lost",
  ));
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
  // A scan promise that never resolves: the warm-up must stay a synchronous
  // fire-and-forget kick — it hands back nothing the startup path could
  // await, so a round that never lands cannot hold startup. (A bare call has
  // no discriminating power: even an await-regressed implementation passes
  // it, because an async function only suspends at its first await.)
  const result = warmProcessScanCache({ scanProcesses: () => new Promise(() => {}) });
  assert.equal(result, undefined, "fire-and-forget: the warm-up must not become an awaitable");
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
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
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
  assert.equal(child.killCalls, 1, "the kill lands exactly once");
  child.emit("exit", null, "SIGTERM"); // our own kill landing must not warn
  supervisor.stop();
  assert.doesNotThrow(() => supervisor.stop());
  assert.equal(child.killCalls, 1, "a stopped supervisor tolerates repeats without killing again");
});

test("createTerminalHostSupervisor.start is idempotent while the child is alive", async () => {
  const child = fakeChild();
  let sweeps = 0;
  let spawns = 0;
  const supervisor = createTerminalHostSupervisor({
    spawnFn: () => {
      spawns += 1;
      return child;
    },
    logger: recordingLogger(),
    cleanupStale: async () => {
      sweeps += 1;
      return { ok: true, killed: [], refused: [] };
    },
  });

  await supervisor.start();
  const again = await supervisor.start();
  assert.equal(again.ok, true);
  assert.equal(again.alreadyRunning, true);
  assert.equal(spawns, 1, "a live child means no second spawn");
  assert.equal(sweeps, 1, "and no second stale sweep either");
});

test("createTerminalHostSupervisor.status tracks stopped → running → crashed → running", async () => {
  let child = fakeChild();
  const logger = recordingLogger();
  const supervisor = createTerminalHostSupervisor({
    spawnFn: () => child,
    logger,
    cleanupStale: async () => ({ ok: true, killed: [], refused: [] }),
  });

  assert.deepEqual(supervisor.status(), { state: "stopped", pid: null, lastExit: null });

  await supervisor.start();
  assert.deepEqual(supervisor.status(), { state: "running", pid: 5150, lastExit: null });

  child.emit("exit", 1, null); // unexpected: stop() did not ask for this
  const crashed = supervisor.status();
  assert.equal(crashed.state, "crashed");
  assert.equal(crashed.pid, null);
  assert.equal(crashed.lastExit.code, 1);
  assert.equal(crashed.lastExit.signal, null);
  assert.equal(typeof crashed.lastExit.at, "number");

  child = fakeChild(6161);
  await supervisor.start();
  assert.deepEqual(supervisor.status(), { state: "running", pid: 6161, lastExit: null }, "a successful start clears the crash record");
});

test("createTerminalHostSupervisor.stop waits for the exit and records no crash", async () => {
  const child = fakeChild();
  child.kill = () => {
    child.killed = true;
    setTimeout(() => child.emit("exit", null, "SIGTERM"), 10); // async, like a real process
  };
  const logger = recordingLogger();
  const supervisor = createTerminalHostSupervisor({
    spawnFn: () => child,
    logger,
    cleanupStale: async () => ({ ok: true, killed: [], refused: [] }),
  });

  await supervisor.start();
  await supervisor.stop();
  assert.equal(child.killed, true);
  assert.deepEqual(supervisor.status(), { state: "stopped", pid: null, lastExit: null }, "a stop()-initiated exit is not a crash");
  assert.ok(!logger.logged.warn.some((line) => line.includes("exited early")), "our own kill must not warn");
});

test("createTerminalHostSupervisor.status reports stopped-manual only while the flag is set", async () => {
  const child = fakeChild();
  const supervisor = createTerminalHostSupervisor({
    spawnFn: () => child,
    logger: recordingLogger(),
    cleanupStale: async () => ({ ok: true, killed: [], refused: [] }),
    manualStop: true,
    stopTimeoutMs: 50, // fakeChild.kill never emits exit; the cap ends the wait
  });

  assert.equal(supervisor.isManualStop(), true);
  assert.equal(supervisor.status().state, "stopped-manual");

  await supervisor.start();
  assert.equal(supervisor.status().state, "running", "running wins over the flag");

  await supervisor.stop();
  assert.equal(supervisor.status().state, "stopped-manual", "the flag survives until the route layer clears it");

  supervisor.setManualStop(false);
  assert.deepEqual(supervisor.status(), { state: "stopped", pid: null, lastExit: null });
});

// Auto-restart (crash resilience) and child output capture. The restart is
// scheduled, never synchronous — tests drive it with a manual scheduler so no
// real timer ever pends. nowFn drives the rolling breaker window.
function manualScheduler() {
  const timers = [];
  return {
    timers,
    scheduleFn: (fn) => {
      const timer = { fn, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancelScheduleFn: (timer) => {
      timer.cancelled = true;
    },
    fireAll: () => {
      for (const timer of timers.splice(0)) {
        if (!timer.cancelled) timer.fn();
      }
    },
  };
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test("createTerminalHostSupervisor auto-restarts after an unexpected exit", async () => {
  const scheduler = manualScheduler();
  const logger = recordingLogger();
  const children = [];
  const supervisor = createTerminalHostSupervisor({
    spawnFn: () => {
      const spawned = fakeChild(5150 + children.length);
      children.push(spawned);
      return spawned;
    },
    logger,
    cleanupStale: async () => ({ ok: true, killed: [], refused: [] }),
    scheduleFn: scheduler.scheduleFn,
    cancelScheduleFn: scheduler.cancelScheduleFn,
  });

  await supervisor.start();
  children[0].emit("exit", 3221226505, null); // the node-pty fast-fail signature
  assert.equal(supervisor.status().state, "crashed", "the crash is visible until the restart lands");
  assert.equal(scheduler.timers.length, 1, "the restart is scheduled, not synchronous");

  scheduler.fireAll();
  await flushMicrotasks();
  assert.equal(children.length, 2, "a fresh child was spawned");
  assert.deepEqual(supervisor.status(), { state: "running", pid: 5151, lastExit: null });
  assert.ok(logger.logged.warn.some((line) => line.includes("exited early")), "the crash itself is still logged");
  assert.ok(logger.logged.warn.some((line) => line.includes("restart")), "the restart decision is logged too");
});

test("createTerminalHostSupervisor does not auto-restart after a stop()-initiated exit", async () => {
  const scheduler = manualScheduler();
  let spawns = 0;
  const supervisor = createTerminalHostSupervisor({
    spawnFn: () => {
      spawns += 1;
      const spawned = fakeChild();
      spawned.kill = () => {
        spawned.killed = true;
        setTimeout(() => spawned.emit("exit", null, "SIGTERM"), 0);
      };
      return spawned;
    },
    logger: recordingLogger(),
    cleanupStale: async () => ({ ok: true, killed: [], refused: [] }),
    scheduleFn: scheduler.scheduleFn,
    cancelScheduleFn: scheduler.cancelScheduleFn,
  });

  await supervisor.start();
  await supervisor.stop();
  scheduler.fireAll();
  await flushMicrotasks();
  assert.equal(scheduler.timers.length, 0, "no restart was ever scheduled");
  assert.equal(spawns, 1, "a death the supervisor ordered is final");
});

test("createTerminalHostSupervisor does not auto-restart while the manual-stop flag is set", async () => {
  const scheduler = manualScheduler();
  let spawns = 0;
  const children = [];
  const supervisor = createTerminalHostSupervisor({
    spawnFn: () => {
      spawns += 1;
      const spawned = fakeChild();
      children.push(spawned);
      return spawned;
    },
    logger: recordingLogger(),
    cleanupStale: async () => ({ ok: true, killed: [], refused: [] }),
    manualStop: true,
    scheduleFn: scheduler.scheduleFn,
    cancelScheduleFn: scheduler.cancelScheduleFn,
  });

  await supervisor.start();
  children[0].emit("exit", 1, null);
  scheduler.fireAll();
  await flushMicrotasks();
  assert.equal(spawns, 1, "a manual-stop context leaves a dead host down");
  assert.equal(supervisor.status().state, "stopped-manual", "the flag outranks the crash record in the status contract");
  assert.equal(supervisor.status().lastExit?.code, 1, "the crash is still recorded for diagnosis");
});

test("createTerminalHostSupervisor suspends auto-restart once the window budget is spent", async () => {
  const scheduler = manualScheduler();
  const logger = recordingLogger();
  const children = [];
  let now = 1_000_000;
  const supervisor = createTerminalHostSupervisor({
    spawnFn: () => {
      const spawned = fakeChild(100 + children.length);
      children.push(spawned);
      return spawned;
    },
    logger,
    cleanupStale: async () => ({ ok: true, killed: [], refused: [] }),
    scheduleFn: scheduler.scheduleFn,
    cancelScheduleFn: scheduler.cancelScheduleFn,
    nowFn: () => now,
    restartBudget: 3,
    restartWindowMs: 60_000,
  });

  await supervisor.start();
  for (let i = 0; i < 3; i += 1) {
    children[children.length - 1].emit("exit", 1, null);
    scheduler.fireAll();
    await flushMicrotasks();
  }
  assert.equal(children.length, 4, "three auto-restarts landed within budget");

  children[children.length - 1].emit("exit", 1, null);
  scheduler.fireAll();
  await flushMicrotasks();
  assert.equal(children.length, 4, "the breaker holds: no fourth restart");
  assert.equal(supervisor.status().state, "crashed", "a suspended host reports crashed, not running");
  assert.ok(logger.logged.warn.some((line) => line.includes("suspended")), "the suspension reaches the log");
});

test("createTerminalHostSupervisor resets the restart budget on a manual start", async () => {
  const scheduler = manualScheduler();
  const children = [];
  let now = 1_000_000;
  const supervisor = createTerminalHostSupervisor({
    spawnFn: () => {
      const spawned = fakeChild(100 + children.length);
      children.push(spawned);
      return spawned;
    },
    logger: recordingLogger(),
    cleanupStale: async () => ({ ok: true, killed: [], refused: [] }),
    scheduleFn: scheduler.scheduleFn,
    cancelScheduleFn: scheduler.cancelScheduleFn,
    nowFn: () => now,
    restartBudget: 2,
    restartWindowMs: 60_000,
  });

  await supervisor.start();
  for (let i = 0; i < 3; i += 1) {
    children[children.length - 1].emit("exit", 1, null);
    scheduler.fireAll();
    await flushMicrotasks();
  }
  assert.equal(children.length, 3, "budget 2 → two restarts, third crash suspended");

  await supervisor.start(); // manual start: deliberate intervention resets the budget
  assert.equal(children.length, 4);
  children[children.length - 1].emit("exit", 1, null);
  scheduler.fireAll();
  await flushMicrotasks();
  assert.equal(children.length, 5, "auto-restart is armed again after the manual start");
});

test("createTerminalHostSupervisor supersedes a pending auto-restart when a manual start lands first", async () => {
  const scheduler = manualScheduler();
  const children = [];
  const supervisor = createTerminalHostSupervisor({
    spawnFn: () => {
      const spawned = fakeChild(100 + children.length);
      children.push(spawned);
      return spawned;
    },
    logger: recordingLogger(),
    cleanupStale: async () => ({ ok: true, killed: [], refused: [] }),
    scheduleFn: scheduler.scheduleFn,
    cancelScheduleFn: scheduler.cancelScheduleFn,
  });

  await supervisor.start();
  children[0].emit("exit", 1, null);
  assert.equal(scheduler.timers.length, 1);
  await supervisor.start(); // the panel's start button beat the timer to it
  assert.equal(children.length, 2);
  assert.equal(scheduler.timers[0].cancelled, true, "the pending restart is cancelled");
  scheduler.fireAll();
  await flushMicrotasks();
  assert.equal(children.length, 2, "no double spawn from the superseded timer");
});

test("createTerminalHostSupervisor shares a single spawn across concurrent starts", async () => {
  let spawns = 0;
  const sweeps = [];
  const supervisor = createTerminalHostSupervisor({
    spawnFn: () => {
      spawns += 1;
      return fakeChild();
    },
    logger: recordingLogger(),
    // Resolve every sweep the code asks for: if the in-flight guard regresses,
    // this test must fail on the spawn count, not hang on a lost resolve.
    cleanupStale: () => new Promise((resolve) => sweeps.push(resolve)),
  });

  const first = supervisor.start();
  const second = supervisor.start();
  for (const resolve of sweeps) resolve({ ok: true, killed: [], refused: [] });
  const [one, two] = await Promise.all([first, second]);
  assert.equal(spawns, 1, "an in-flight start is reused, not duplicated");
  assert.equal(one.pid, two.pid);
});

test("createTerminalHostSupervisor tees child output into logPath, rotating an oversized log per spawn", async () => {
  const logPath = join(mkTestDir("anyswitch-rh-"), "terminal-host.log");
  writeFileSync(logPath, "x".repeat(6 * 1024 * 1024));
  let seen;
  const supervisor = createTerminalHostSupervisor({
    logPath,
    spawnFn: (file, args, options) => {
      seen = options;
      return fakeChild();
    },
    logger: recordingLogger(),
    cleanupStale: async () => ({ ok: true, killed: [], refused: [] }),
  });

  await supervisor.start();
  assert.ok(Array.isArray(seen.stdio), "a wired log file turns stdio into an explicit fd trio");
  assert.equal(seen.stdio[0], "ignore");
  assert.equal(typeof seen.stdio[1], "number", "stdout goes to the log fd");
  assert.equal(seen.stdio[2], seen.stdio[1], "stderr shares the same log fd");
  assert.ok(existsSync(`${logPath}.old`), "an oversized log is rotated out before the spawn inherits the fd");
  assert.equal(readFileSync(logPath, "utf8"), "", "the fresh log starts empty");
});

// /terminal-host/* routes: spliced in front of the relay server's own listener
// by mountTerminalHostRoutes, guarded by loopback + the pi-relay-token, driving
// the supervisor and persisting the manual-stop flag through settings.json.
function routeHarness({ manualStop = false, fetchFn, spawnFn, startReadyTimeoutMs, startReadyIntervalMs } = {}) {
  const root = mkTestDir("anyswitch-th-routes-");
  const settingsPath = join(root, "settings.json");
  let child = fakeChild();
  let spawns = 0;
  const logger = recordingLogger();
  const supervisor = createTerminalHostSupervisor({
    root,
    spawnFn: spawnFn ?? (() => {
      spawns += 1;
      return child;
    }),
    logger,
    cleanupStale: async () => ({ ok: true, killed: [], refused: [] }),
    manualStop,
    stopTimeoutMs: 50,
  });
  const handler = createTerminalHostRoutes({
    supervisor,
    token: "test-token",
    settingsPath,
    root,
    logger,
    fetchFn: fetchFn ?? (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, cleared: 0 }) })),
    startReadyTimeoutMs,
    startReadyIntervalMs,
  });
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream");
  });
  mountTerminalHostRoutes(server, handler);
  return {
    root,
    settingsPath,
    supervisor,
    logger,
    server,
    spawns: () => spawns,
    auth: { authorization: "Bearer test-token", "content-type": "application/json" },
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("GET /terminal-host/status requires the token and reports the supervisor state", async () => {
  const h = routeHarness({ manualStop: true });
  const port = await h.listen();
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/terminal-host/status`);
    assert.equal(denied.status, 401);

    const res = await fetch(`http://127.0.0.1:${port}/terminal-host/status`, { headers: h.auth });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, host: { state: "stopped-manual", pid: null, lastExit: null } });
  } finally {
    await h.close();
  }
});

test("non-/terminal-host paths fall through to the relay's own routes", async () => {
  const h = routeHarness();
  const port = await h.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/hello`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "upstream");

    const unknown = await fetch(`http://127.0.0.1:${port}/terminal-host/nope`, { headers: h.auth });
    assert.equal(unknown.status, 404);
  } finally {
    await h.close();
  }
});

test("POST /terminal-host/start starts the host, clears the persisted flag, and is idempotent", async () => {
  const h = routeHarness({ manualStop: true });
  writeFileSync(h.settingsPath, JSON.stringify({ terminalHostManualStop: true, sparkWindowPoints: 24 }));
  const port = await h.listen();
  try {
    const first = await fetch(`http://127.0.0.1:${port}/terminal-host/start`, { method: "POST", headers: h.auth });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.ok, true);
    assert.equal(firstBody.host.state, "running");

    const onDisk = JSON.parse(readFileSync(h.settingsPath, "utf8"));
    assert.equal(onDisk.terminalHostManualStop, false, "manual start clears the persisted flag");
    assert.equal(onDisk.sparkWindowPoints, 24, "neighbouring settings survive the write");

    const second = await fetch(`http://127.0.0.1:${port}/terminal-host/start`, { method: "POST", headers: h.auth });
    assert.equal(second.status, 200);
    assert.equal(h.spawns(), 1, "a running host makes start a no-op");
  } finally {
    await h.close();
  }
});

test("POST /terminal-host/start answers 500 when the host fails to start", async () => {
  const h = routeHarness({
    spawnFn: () => {
      throw new Error("spawn ENOENT");
    },
  });
  const port = await h.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/terminal-host/start`, { method: "POST", headers: h.auth });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).ok, false);
    assert.equal(existsSync(h.settingsPath), false, "a failed start never touches the flag");
  } finally {
    await h.close();
  }
});

// The panel connects the moment start answers, so the route must hold its
// answer until the host's sessions endpoint actually serves — spawn()
// resolving only means the process exists, not that 47823 is bound.
test("POST /terminal-host/start holds its answer until the sessions endpoint serves", async () => {
  let probeCalls = 0;
  let releaseProbe;
  const h = routeHarness({
    startReadyIntervalMs: 5,
    fetchFn: async () => {
      probeCalls += 1;
      if (probeCalls === 1) {
        return new Promise((resolve) => { releaseProbe = () => resolve({ ok: true, status: 200 }); });
      }
      return { ok: true, status: 200 };
    },
  });
  const port = await h.listen();
  try {
    const pending = fetch(`http://127.0.0.1:${port}/terminal-host/start`, { method: "POST", headers: h.auth });
    let answered = false;
    pending.then(() => { answered = true; });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(probeCalls, 1, "the readiness probe is in flight");
    assert.equal(answered, false, "未就绪前不得回答 —— 否则前端紧跟的连接必然 503");
    releaseProbe();
    const res = await pending;
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  } finally {
    await h.close();
  }
});

test("POST /terminal-host/start retries non-200 probes against the sessions endpoint with the relay token", async () => {
  const probes = [];
  const h = routeHarness({
    startReadyIntervalMs: 5,
    fetchFn: async (url, options) => {
      probes.push({ url, authorization: options.headers.authorization });
      return { ok: probes.length >= 3, status: probes.length < 3 ? 503 : 200 };
    },
  });
  const port = await h.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/terminal-host/start`, { method: "POST", headers: h.auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.host.state, "running");
    assert.ok(probes.length >= 3, "非 200 的回答要继续探测，直到 host 就绪");
    for (const probe of probes) {
      assert.equal(probe.url, "http://127.0.0.1:47823/terminal/sessions");
      assert.equal(probe.authorization, "Bearer test-token");
    }
  } finally {
    await h.close();
  }
});

test("POST /terminal-host/start answers 500 on a readiness timeout and never clears the manual-stop flag", async () => {
  let probes = 0;
  const h = routeHarness({
    manualStop: true,
    startReadyTimeoutMs: 40,
    startReadyIntervalMs: 5,
    fetchFn: async () => {
      probes += 1;
      return { ok: false, status: 503 };
    },
  });
  writeFileSync(h.settingsPath, JSON.stringify({ terminalHostManualStop: true }));
  const port = await h.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/terminal-host/start`, { method: "POST", headers: h.auth });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { ok: false, error: "terminal_host_start_timeout" });
    // The retry rhythm itself is pinned deterministically by the non-200 probe
    // test above; here the first probe may legitimately consume the whole
    // window (a stalled tick between the fetch and the deadline check), so any
    // lower bound above 1 is scheduling-dependent, not a behaviour claim.
    assert.ok(probes >= 1, "超时回答前就绪探测确实跑过");
    assert.equal(JSON.parse(readFileSync(h.settingsPath, "utf8")).terminalHostManualStop, true, "失败不能清掉手动关停标记");
    assert.equal(h.supervisor.isManualStop(), true);
  } finally {
    await h.close();
  }
});

test("POST /terminal-host/stop sets the flag, clears sessions via the host, then kills it", async () => {
  const order = [];
  // Record inside fetchFn, assert outside: the stop route wraps the clear-all
  // call in a degradation catch (clearFailed → warn → delete state file), so
  // an AssertionError thrown in here would be swallowed as "clear failed" and
  // the test would pass without any of these checks having taken effect.
  const observed = {};
  let h;
  h = routeHarness({
    fetchFn: async (url, options) => {
      observed.url = url;
      observed.method = options.method;
      observed.authorization = options.headers.authorization;
      observed.stateAtClear = h.supervisor.status().state;
      order.push("clear-all");
      return { ok: true, json: async () => ({ ok: true, cleared: 3 }) };
    },
  });
  const port = await h.listen();
  try {
    await h.supervisor.start();
    const res = await fetch(`http://127.0.0.1:${port}/terminal-host/stop`, {
      method: "POST",
      headers: h.auth,
      body: JSON.stringify({ clearSessions: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.host.state, "stopped-manual");
    assert.deepEqual(order, ["clear-all"], "sessions are cleared before the kill");
    assert.equal(observed.url, "http://127.0.0.1:47823/terminal/sessions/clear-all");
    assert.equal(observed.method, "POST");
    assert.equal(observed.authorization, "Bearer test-token");
    assert.equal(observed.stateAtClear, "running", "清场调用发生在 kill 子进程之前");
    assert.equal(JSON.parse(readFileSync(h.settingsPath, "utf8")).terminalHostManualStop, true);

    // Idempotent: already stopped is still ok.
    const again = await fetch(`http://127.0.0.1:${port}/terminal-host/stop`, { method: "POST", headers: h.auth });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).host.state, "stopped-manual");
  } finally {
    await h.close();
  }
});

test("POST /terminal-host/stop with clearSessions deletes the state file when the host is unreachable", async () => {
  const h = routeHarness({
    fetchFn: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  const stateFile = join(h.root, "terminal-sessions.json");
  writeFileSync(stateFile, JSON.stringify({ version: 1, sessions: [{ id: "leftover" }] }));
  const port = await h.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/terminal-host/stop`, {
      method: "POST",
      headers: h.auth,
      body: JSON.stringify({ clearSessions: true }),
    });
    assert.equal(res.status, 200, "an unreachable host must not fail the stop");
    assert.equal((await res.json()).ok, true);
    assert.equal(existsSync(stateFile), false, "the leftover session records are deleted best-effort");
    assert.equal(h.logger.logged.warn.some((line) => line.includes("clear-all")), true, "the failed clear reaches the log");
  } finally {
    await h.close();
  }
});

test("POST /terminal-host/stop without clearSessions leaves the state file alone", async () => {
  const h = routeHarness();
  const stateFile = join(h.root, "terminal-sessions.json");
  writeFileSync(stateFile, JSON.stringify({ version: 1, sessions: [{ id: "kept" }] }));
  const port = await h.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/terminal-host/stop`, { method: "POST", headers: h.auth });
    assert.equal(res.status, 200);
    assert.equal(existsSync(stateFile), true, "关停不清场时会话记录原样保留（「从上次中断的地方继续」）");
  } finally {
    await h.close();
  }
});

// 启动失败的归因（2026-10-05）。
//
// 失败行以前是子进程直写的裸文本：没有时间、没有 PID，而多个实例共写同一个文件，
// 事后只能靠前后文反推时间线；更要紧的是「端口被外人占用」与「自家 relay 在、只是
// 没答上来」被压成同一句话——这两者的处置完全不同。
test("describeRelayStartupFailure separates a foreign port from an unexpected fault", () => {
  const foreign = new Error("port 47821 is in use by another process");
  foreign.code = "RELAY_PORT_FOREIGN";

  const blocked = describeRelayStartupFailure(foreign, 4242);
  assert.equal(blocked.label, "relayStartupBlocked");
  assert.match(blocked.detail, /47821/);
  assert.match(blocked.detail, /does not answer as our relay/, "不断言它一定是外人：探针认不出自家 relay 时两种情况都可能");
  assert.match(blocked.detail, /pid 4242/, "带上自身进程号，多实例共写一个文件时才分得清是谁");

  const crash = describeRelayStartupFailure(new Error("the Anyswitch global store is not usable"), 777);
  assert.equal(crash.label, "relayStartupFailed");
  assert.match(crash.detail, /the Anyswitch global store is not usable/, "意外故障保留原始信息");
  assert.match(crash.detail, /pid 777/);
  assert.notEqual(blocked.detail, crash.detail);
});
