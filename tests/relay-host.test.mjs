// relay-host unit tests: startup log rotation and the
// synchronous crash-log path used by the fatal handlers. All file work happens
// in an os.tmpdir() sandbox — the production logs/relay-host.log is never
// touched.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { rotateLogIfNeeded, appendCrashLog, warmProcessScanCache, createTerminalHostSupervisor, createTerminalHostRoutes, mountTerminalHostRoutes, describeRelayStartupFailure, startResidentRelay, RELAY_PORT } from "../src/relay/relay-host.mjs";
import { createProductionDeps } from "../src/launchers/launch.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";
import { storePaths } from "../src/store/store-io.mjs";
// listen(0) 会抽中 fetch（undici）拒连的「bad port」，用例随端口抽签随机假红；
// 共享夹具命中即关掉换口重试（test-helpers/loopback.mjs 有完整说明）。
import { listenLoopback } from "../test-helpers/loopback.mjs";

// ---- 环境隔离（先于任何用例执行）----
// startResidentRelay 的装配链（createProductionDeps 的凭据缓存门、effort 注入
// 器默认路径、面板路由的 relay 控制默认值……）都按函数默认参数现读
// process.env；导入链里没有 import 期捕获（逐一核对过）。这里把用户根整体重
// 定向进本进程的临时根，装配测试读不到真实机器的 Anyswitch 配置。
const ISOLATED_ENV_ROOT = mkTestDir("anyswitch-rh-env-");
for (const key of ["LOCALAPPDATA", "APPDATA", "USERPROFILE"]) {
  process.env[key] = ISOLATED_ENV_ROOT;
}
// git anchor 是显式 opt-in（ANYSWITCH_GIT_ANCHOR=1 才动手），装配路径里的
// ensureGitAnchor 在测试进程必须保持 no-op：防环境里带了真开关。
delete process.env.ANYSWITCH_GIT_ANCHOR;

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
  assert.ok(existsSync(args[0]), `the terminal host script must exist on disk, got ${args[0]}`);
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
function routeHarness({ manualStop = false, fetchFn, spawnFn, startReadyTimeoutMs, startReadyIntervalMs, token = "test-token", tokenValidator } = {}) {
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
    token,
    tokenValidator,
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
    auth: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    listen: async () => (await listenLoopback(server)).port,
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

// 轮换感知的 token 校验（relay-host.mjs 的 currentToken / relayTokenAccepted
// 委托）：面板桥按 use-time 现读 token 文件，轮换发生后启动时拷贝的旧代际已经
// 过期——按启动时 token 做静态比较会把面板锁在自己的 terminal host 门外。
test("/terminal-host/* 的入站校验走轮换感知的 validator：旧代际 401、新代际放行", async () => {
  const BOOT = "boot-gen-1";
  const ROTATED = "rotated-gen-2";
  const validator = {
    isValid: (presented) => presented === ROTATED,
    getCurrent: () => ROTATED,
  };
  const h = routeHarness({ token: BOOT, tokenValidator: validator });
  const port = await h.listen();
  try {
    // 启动时的旧代际：静态比较（token === BOOT）在这里会放行——这条是反事实
    // 变异的牙齿；轮换感知校验必须拒绝。
    const stale = await fetch(`http://127.0.0.1:${port}/terminal-host/status`, { headers: { authorization: `Bearer ${BOOT}` } });
    assert.equal(stale.status, 401, "启动时代际过期后必须拒绝 —— 静态比较在这里会假绿");
    assert.equal((await stale.json()).error, "unauthorized");

    const rotated = await fetch(`http://127.0.0.1:${port}/terminal-host/status`, { headers: { authorization: `Bearer ${ROTATED}` } });
    assert.equal(rotated.status, 200, "validator 接受的当前代际放行");

    // 裸值（无 Bearer 前缀）同样走 validator：面板桥两种形态都会发。
    const bare = await fetch(`http://127.0.0.1:${port}/terminal-host/status`, { headers: { authorization: ROTATED } });
    assert.equal(bare.status, 200);

    // validator 拒绝的值（哪怕长度与旧代际不同）也不放行。
    const stranger = await fetch(`http://127.0.0.1:${port}/terminal-host/status`, { headers: { authorization: "Bearer stranger" } });
    assert.equal(stranger.status, 401);
  } finally {
    await h.close();
  }
});

test("挂载路由的出站调用带当前代际：就绪探针与清场请求都拼 validator 的 getCurrent", async () => {
  const BOOT = "boot-gen-1";
  const ROTATED = "rotated-gen-2";
  const probes = [];
  const h = routeHarness({
    token: BOOT,
    tokenValidator: { isValid: (p) => p === ROTATED, getCurrent: () => ROTATED },
    startReadyIntervalMs: 5,
    fetchFn: async (url, options) => {
      probes.push({ url, authorization: options.headers.authorization });
      return { ok: true, status: 200, json: async () => ({ ok: true, cleared: 2 }) };
    },
  });
  const port = await h.listen();
  try {
    const start = await fetch(`http://127.0.0.1:${port}/terminal-host/start`, { method: "POST", headers: { authorization: `Bearer ${ROTATED}` } });
    assert.equal(start.status, 200);
    const stop = await fetch(`http://127.0.0.1:${port}/terminal-host/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${ROTATED}`, "content-type": "application/json" },
      body: JSON.stringify({ clearSessions: true }),
    });
    assert.equal(stop.status, 200);

    // 就绪探针（GET /terminal/sessions）与清场（POST .../clear-all）都必须带
    // validator 的当前代际——启动时拷贝的旧代际会让轮换后的 host 拒绝自家面板。
    assert.ok(probes.some((p) => p.url.endsWith("/terminal/sessions") && p.authorization === `Bearer ${ROTATED}`), "就绪探针带当前代际");
    assert.ok(probes.some((p) => p.url.endsWith("/terminal/sessions/clear-all") && p.authorization === `Bearer ${ROTATED}`), "清场请求带当前代际");
    assert.ok(!probes.some((p) => p.authorization === `Bearer ${BOOT}`), "出站调用绝不能带启动时的旧代际（currentToken 缝被静态 token 替换时这里红）");
  } finally {
    await h.close();
  }
});

// 常驻宿主入口 startResidentRelay 的装配：手动关停分支、/terminal-host 路由
// 挂载、路由与 supervisor 的同一实例接线。supervisor / sync / watcher /
// token 轮换全部注入替身，绑定端口经 options.relayPort 缝落在临时端口上——
// 绝不碰真机 47821，也不 spawn 真实子进程。
//
// store 参数换掉预检用的最小 store.json（依赖装配验收需要可路由的渠道/池）。
// createProductionDeps 参数走 src/relay/relay-host.mjs 的依赖来源注入缝：测试用
// 真实工厂包一层、只覆写出网两键（upstreamFetch/loadCredential），装配透传的
// loadStore/getKeepAliveConfig/getClaudeTierMapping/effortInjector 仍是真实工厂
// 的产物。tokenRotationScheduleFn 默认换成捕获版：轮换检查回调交由用例驱动。
// F37（审计 ③37）的预抽口：relayPort 无偏好（0）时不再透传 0 给生产
// listenLoopback——那会走 listen(0) 端口抽签，抽中 undici 的 fetch 禁用端口表
// （实测 ~0.13%/次）时本用例的全部 fetch 以 "bad port" 假红。routeHarness 自持
// server，可直走共享夹具换口重试；assemblyHarness 的 server 在生产
// createOpenAIRelayServer 手里，只能先抽后让：预抽一个 fetch 可用口、放抽、
// 再以具体端口号经 options.relayPort 注入。抽中 RELAY_PORT（47821）重抽——
// 装配绝不碰真机中继口。放抽与生产重绑之间有毫秒级窗口，极端撞车会走生产的
// EADDRINUSE 探针拒绝、用例真红——概率远低于端口抽签本身。
async function drawAssemblyPort() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const drawn = await listenLoopback(createServer());
    const port = drawn.port;
    await drawn.close();
    if (port !== RELAY_PORT) return port;
  }
  throw new Error("装配端口预抽连续 8 次落在 RELAY_PORT 上，放弃装配");
}

// F38（审计 ③38）的猴补收尾：startResidentRelay 每次调用都在进程级注册且不
// 收尾——redirectStderrToFile 猴补 process.stderr.write（捕获上一层，链叠后
// 先建用例的日志文件会持续接收后续用例的 stderr）、挂含 process.exit(1) 的
// uncaughtException（把单用例失败放大成整文件中止）与 unhandledRejection，
// 再挂 SIGINT/SIGTERM/exit 关停钩子；生产语义是常驻进程一启动到死，无可指责。
// 测试进程是 node:test 的宿主，经不起六次累积：装配前快照、close（含启动失败
// 路径）后还原。摘除只动快照之后新挂的处理器，既有监听（node:test 自身的、
// test-helpers/tmp 的 exit 清扫）原样保留。
function snapshotProcessHooks() {
  return {
    stderrWrite: process.stderr.write,
    uncaughtException: process.listeners("uncaughtException"),
    unhandledRejection: process.listeners("unhandledRejection"),
    SIGINT: process.listeners("SIGINT"),
    SIGTERM: process.listeners("SIGTERM"),
    exit: process.listeners("exit"),
  };
}

function restoreProcessHooks(snapshot) {
  process.stderr.write = snapshot.stderrWrite;
  for (const event of ["uncaughtException", "unhandledRejection", "SIGINT", "SIGTERM", "exit"]) {
    for (const listener of process.listeners(event)) {
      if (!snapshot[event].includes(listener)) {
        process.removeListener(event, listener);
      }
    }
  }
}

function assemblyHarness({ settings, relayPort = 0, store, createProductionDeps: depsFactory, seed } = {}) {
  const tmp = mkTestDir("anyswitch-rh-resident-");
  const base = { LOCALAPPDATA: tmp };
  const root = join(tmp, "Anyswitch");
  mkdirSync(root, { recursive: true });
  // store 预检要求一个可用的 store.json：最小合法 schema（version 2 + providers）。
  writeFileSync(join(root, "store.json"), JSON.stringify(store ?? { version: 2, providers: {} }), "utf8");
  const settingsPath = join(root, "settings.json");
  if (settings !== undefined) {
    writeFileSync(settingsPath, JSON.stringify(settings), "utf8");
  }
  // seed：启动前写进数据根的文件（token 代际、轮换链……）——装配必须读到
  // 它们作为启动状态，晚写一步就只是普通文件。
  for (const [name, content] of Object.entries(seed ?? {})) {
    writeFileSync(join(root, name), content, "utf8");
  }
  const logPath = join(tmp, "relay-host.log");

  const supervisorCalls = { start: 0, stop: 0 };
  const supervisor = {
    running: false,
    manualStop: settings?.terminalHostManualStop === true,
    async start() {
      supervisorCalls.start += 1;
      this.running = true;
      return { ok: true, pid: 5150 };
    },
    async stop() {
      supervisorCalls.stop += 1;
      this.running = false;
    },
    status() {
      const state = this.running ? "running" : (this.manualStop ? "stopped-manual" : "stopped");
      return { state, pid: this.running ? 5150 : null, lastExit: null };
    },
    setManualStop(value) { this.manualStop = value === true; },
    isManualStop() { return this.manualStop; },
  };
  const syncSpawns = [];
  let rotationCheck = null;

  const ready = (async () => {
    // F37（审计 ③37）：无偏好（0）不再透传——生产 listenLoopback 的 0 就是
    // listen(0) 端口抽签；先经 drawAssemblyPort 预抽 fetch 可用口再注入，
    // 显式给出的非零口原样透传。
    const portToBind = relayPort > 0 ? relayPort : await drawAssemblyPort();
    // F38（审计 ③38）：快照必须在 startResidentRelay 之前取，还原挂在包装后的
    // close（装配用例全部在 finally 里 close）与下面的启动失败 catch 上。
    const processHooks = snapshotProcessHooks();
    try {
      const result = await startResidentRelay({
        base,
        paths: storePaths(root),
        logPath,
        relayPort: portToBind,
        terminalSupervisor: supervisor,
        spawnAgentSync: async ({ port }) => {
          syncSpawns.push(port);
          return { ok: true };
        },
        storeWatcher: { close() {} },
        tokenRotationScheduleFn: (check) => {
          rotationCheck = check;
          return () => {};
        },
        createProductionDeps: depsFactory,
        metricsCollector: { startRequest: () => null, noteZcodeSessionRequest() {}, persistMetricsSnapshot() {}, getAgentsStatus: async () => [], onActivity: () => () => {} },
        socketOwner: { lookup: () => null, onRefresh: () => () => {} },
        serviceHealth: { snapshot: () => ({ degraded: false, consecutiveFailures: 0 }), recordFailure() {}, recordSuccess() {} },
      });
      return {
        ...result,
        close: async () => {
          try {
            await result.close();
          } finally {
            restoreProcessHooks(processHooks);
          }
        },
      };
    } catch (err) {
      restoreProcessHooks(processHooks);
      throw err;
    }
  })();

  return {
    root,
    settingsPath,
    logPath,
    supervisor,
    supervisorCalls,
    syncSpawns,
    runRotationCheck: async () => {
      assert.ok(rotationCheck, "轮换检查回调必须在装配时交给调度器");
      await rotationCheck();
    },
    ready,
  };
}

test("startResidentRelay 持久化了手动关停标记时不拉起 terminal host，/terminal-host 路由已挂载", async () => {
  const h = assemblyHarness({ settings: { terminalHostManualStop: true, sparkWindowPoints: 24 } });
  const result = await h.ready;
  try {
    assert.equal(result.reused, undefined, "临时端口上没有可复用的 relay，正常独占绑定");
    assert.ok(result.port > 0 && result.port !== 47821, "绑定在注入的临时端口上，绝不碰真机 47821");
    assert.equal(h.supervisorCalls.start, 0, "手动关停标记必须让常驻 relay 不拉起 terminal host");
    assert.deepEqual(h.syncSpawns, [result.port], "启动同步仍然发生，且带实际绑定端口");

    // 路由挂载的真实证明：经真实 HTTP 打进挂载的 supervisor 同一实例。
    const denied = await fetch(`http://127.0.0.1:${result.port}/terminal-host/status`);
    assert.equal(denied.status, 401, "挂载的路由同样受 pi-relay-token 保护");

    const res = await fetch(`http://127.0.0.1:${result.port}/terminal-host/status`, { headers: { authorization: `Bearer ${result.token}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, host: { state: "stopped-manual", pid: null, lastExit: null } });

    // 非 /terminal-host 路径仍落到 relay 自己的路由：挂载包装不吞请求。
    const hello = await fetch(`http://127.0.0.1:${result.port}/api/hello`);
    assert.equal(hello.status, 200);
  } finally {
    await result.close();
  }
});

test("startResidentRelay 无标记时启动 terminal host，挂载的 stop 路由驱动同一个 supervisor 并落盘标记", async () => {
  const h = assemblyHarness({});
  const result = await h.ready;
  try {
    assert.equal(h.supervisorCalls.start, 1, "无手动关停标记时启动 terminal host");
    assert.equal(typeof result.token, "string", "装配产出了会话 token");
    assert.ok(result.token.length > 0, "会话 token 非空");

    const res = await fetch(`http://127.0.0.1:${result.port}/terminal-host/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${result.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.host.state, "stopped-manual");
    assert.equal(h.supervisorCalls.stop, 1, "挂载的路由驱动的是装配用的同一个 supervisor 实例");
    const onDisk = JSON.parse(readFileSync(h.settingsPath, "utf8"));
    assert.equal(onDisk.terminalHostManualStop, true, "stop 落盘手动关停标记到装配的 settings.json");
  } finally {
    await result.close();
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

// ---- 常驻装配的依赖接线（createResidentDeps / startResidentRelay）----------
//
// 依赖装配此前只有 supervisor/路由挂载的验收，装配出的 deps 本身无人守：档位
// 映射透传、keep-alive 配置透传、token 轮换接线、运行日志活闸门——任何一环在
// 装配层断掉，常驻前端的对应能力就静默失效。以下用例全部经真实入口
// startResidentRelay 驱动：createProductionDeps 注入缝只覆写出网两键，其余
// deps 由真实工厂产出并经装配透传；设置热读读的是真实
// loadSettings(defaultSettingsPath()) 链（env 根在文件顶部已整体重定向）。
const RESIDENT_STORE = {
  version: 2,
  providers: {
    "res-host": {
      displayName: "Resident Host",
      baseURL: "http://res-host.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "res-host.dpapi",
      models: { "kimi-hosted": { displayName: "Kimi Hosted" } },
    },
    "res-p1": {
      displayName: "Resident Pool 1",
      baseURL: "http://res-p1.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "res-p1.dpapi",
      models: { "shared-model": { displayName: "Shared from 1" } },
    },
    "res-p2": {
      displayName: "Resident Pool 2",
      baseURL: "http://res-p2.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "res-p2.dpapi",
      models: { "shared-model": { displayName: "Shared from 2" } },
    },
  },
  pools: {
    "res-pool": { displayName: "Resident Pool", members: ["res-p1", "res-p2"] },
  },
};

// 出网 mock：按 baseURL 主机段路由，非流式调用返回 chat-completions 形状的
// 200 JSON（attemptMessages 会翻译回 Anthropic 形态）。behaviors[host] 收到
// 本次的出网请求体，可按内容区分阶段；缺席的成员一律成功——「谁被调用」
// 本身就是断言。
function residentUpstream(recorder, behaviors = {}) {
  return async (urls, init) => {
    const url = Array.isArray(urls) ? urls[0] : urls;
    const host = new URL(url).host.split(".")[0];
    recorder.calls.push(host);
    const body = init?.body ? JSON.parse(init.body) : null;
    if (body) recorder.bodies.push(body);
    const behavior = behaviors[host];
    if (behavior) return behavior(body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: `${host} answers` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
    };
  };
}

// 装配级夹具：createProductionDeps 注入缝包真实工厂，只覆写 upstreamFetch 与
// loadCredential（后者绕开真实 DPAPI 解密——测试不读任何真实凭据）。
function residentAssemblyHarness({ settings, store = RESIDENT_STORE, behaviors } = {}) {
  const recorder = { calls: [], bodies: [] };
  const h = assemblyHarness({
    settings,
    store,
    createProductionDeps: (opts) => ({
      ...createProductionDeps(opts),
      upstreamFetch: residentUpstream(recorder, behaviors),
      loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
    }),
  });
  return { ...h, recorder };
}

// 装配链上的设置现读走 env 根的 defaultSettingsPath()（createProductionDeps
// 不吃 base 注入）。防外围环境泄漏：轮换相关的 env 覆盖一律先摘掉。
function envSettingsPath() {
  const p = join(process.env.LOCALAPPDATA, "Anyswitch", "settings.json");
  mkdirSync(dirname(p), { recursive: true });
  return p;
}
for (const key of ["ANYSWITCH_KEEPALIVE_MODE", "ANYSWITCH_KEEPALIVE_ENABLED", "ANYSWITCH_KEEPALIVE_RETRIES"]) {
  delete process.env[key];
}

test("常驻装配透传档位映射：接管改投经真实入口生效，映射行删除后热读回落为严格拒绝", async () => {
  const h = residentAssemblyHarness();
  const result = await h.ready;
  const settingsFile = envSettingsPath();
  try {
    writeFileSync(settingsFile, JSON.stringify({ claudeTierMappings: { sonnet: "anthropic/res-host/kimi-hosted" } }));

    const post = () => fetch(`http://127.0.0.1:${result.port}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${result.token}`, "content-type": "application/json", "x-agent-id": "claude" },
      body: JSON.stringify({ model: "sonnet", max_tokens: 16, stream: false, messages: [{ role: "user", content: "hi" }] }),
    });

    const served = await post();
    assert.equal(served.status, 200);
    assert.deepEqual(h.recorder.calls, ["res-host"], "接管后由映射目标渠道应答");
    assert.equal(h.recorder.bodies[0].model, "kimi-hosted", "上游拿到托管模型，档位名绝不出网");

    // 热读：删掉映射行（不重启），同一条请求从「接管应答」翻转为「档位未映射」
    // 拒绝——透传的 getter 是每请求现读 settings.json 的真实链。
    writeFileSync(settingsFile, JSON.stringify({}));
    h.recorder.calls.length = 0;
    h.recorder.bodies.length = 0;
    const refused = await post();
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error.message, /not mapped to any Anyswitch model yet/, "无映射行的档位名拒绝并指向未映射");
    assert.deepEqual(h.recorder.calls, [], "拒绝路径不触达上游");
  } finally {
    await result.close();
  }
});

test("常驻装配透传 keep-alive 配置并热读：端点开关关掉不重试，删掉开关立即恢复重试", async () => {
  // 上游恒给空转流，两个阶段用不同的用户内容区分：「重试了几次」只由调用次数
  // 区分——关断时 1 次，继承主开关时首空流 + 一次重试共 3 次。同一进程内改
  // settings.json，改完的下一条请求立即按新配置解析。
  const counters = { phase1: 0, phase2: 0 };
  const h = residentAssemblyHarness({
    behaviors: {
      "res-host": (body) => {
        const phase = body?.messages?.[0]?.content === "phase-2" ? "phase2" : "phase1";
        counters[phase] += 1;
        return {
          ok: true,
          status: 200,
          body: (async function* () {
            const enc = new TextEncoder();
            yield enc.encode('data: {"id":"1","choices":[{"delta":{}}]}\n\n');
            yield enc.encode("data: [DONE]\n\n");
          })(),
        };
      },
    },
  });
  const result = await h.ready;
  const settingsFile = envSettingsPath();
  try {
    writeFileSync(settingsFile, JSON.stringify({
      keepAlive: { enabled: true, mode: "on", maxRetries: 1, backoffMs: 10, endpoints: { dsh: { enabled: false } } },
    }));

    const post = (content) => fetch(`http://127.0.0.1:${result.port}/openai/res-host/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${result.token}`, "content-type": "application/json", "x-agent-id": "dsh" },
      body: JSON.stringify({ model: "kimi-hosted", stream: true, messages: [{ role: "user", content }] }),
    }).then(async (res) => {
      await res.text();
      return res.status;
    });

    assert.equal(await post("phase-1"), 502);
    assert.equal(counters.phase1, 1, "dsh 被单独关断：空流不重试（装配透传的 getKeepAliveConfig 生效）");

    // 热读：删掉 dsh 的开关位（不重启），下一条请求继承主开关重试。
    writeFileSync(settingsFile, JSON.stringify({
      keepAlive: { enabled: true, mode: "on", maxRetries: 1, backoffMs: 10 },
    }));
    assert.equal(await post("phase-2"), 502);
    assert.equal(counters.phase2, 2, "开关位删除后继承主开关：首空流 + 一次重试");
  } finally {
    await result.close();
  }
});

test("常驻装配的 token 轮换接线：到期轮换换发代际、重同步代理端配置、validator 热采纳新代际", async () => {
  // 预置 8 天前的代际（token 文件 + 链文件 + 最近使用记录，经 seed 缝在装配前
  // 落盘），装配读到它为启动代际；链头 createdAt 让轮换检查立刻到期。使用记录
  // 是 1 小时前——活跃会话的宽限语义（旧代际轮换后仍有效）依赖它，8 天前的
  // createdAt 只驱动轮换，不代表最近用过。轮换检查回调经 tokenRotationScheduleFn
  // 缝捕获，由用例手动驱动——不等待真实定时器。
  const BOOT = "seeded-boot-token-gen-1";
  const h = assemblyHarness({
    store: RESIDENT_STORE,
    seed: {
      "pi-relay-token": BOOT,
      "pi-relay-token-chain.json": JSON.stringify([
        { token: BOOT, createdAt: Date.now() - 8 * 24 * 3600_000 },
      ]),
      "pi-relay-token-usage.json": JSON.stringify({ [BOOT]: Date.now() - 3600_000 }),
    },
  });
  const tokenPath = join(h.root, "pi-relay-token");

  const result = await h.ready;
  try {
    assert.equal(result.token, BOOT, "装配的会话 token 来自预置代际");
    assert.deepEqual(h.syncSpawns, [result.port], "轮换前只有启动同步");

    await h.runRotationCheck();

    const rotated = readFileSync(tokenPath, "utf8").trim();
    assert.notEqual(rotated, BOOT, "到期检查换发了新代际");
    assert.match(rotated, /^[0-9a-f]{64}$/, "新代际仍是 64 位十六进制");
    assert.equal(h.syncSpawns.length, 2, "轮换后重同步代理端配置");
    assert.equal(JSON.parse(readFileSync(join(h.root, "sync-status.json"), "utf8")).source, "token-rotation", "重同步以轮换为落盘来源");

    // validator 热采纳：不重启的进程立即认新代际（拒绝旧代际静态比较），
    // 旧代际经链宽限仍然有效。
    const denied = await fetch(`http://127.0.0.1:${result.port}/terminal-host/status`);
    assert.equal(denied.status, 401);
    const fresh = await fetch(`http://127.0.0.1:${result.port}/terminal-host/status`, { headers: { authorization: `Bearer ${rotated}` } });
    assert.equal(fresh.status, 200, "新代际立即生效——validator 热采纳断在这里");
    const grace = await fetch(`http://127.0.0.1:${result.port}/terminal-host/status`, { headers: { authorization: `Bearer ${BOOT}` } });
    assert.equal(grace.status, 200, "旧代际经链宽限继续有效");
  } finally {
    await result.close();
  }
});

test("常驻装配的运行日志活闸门热读：开关关掉逐行丢弃，改回立即恢复落盘", async () => {
  const h = residentAssemblyHarness({
    settings: { loggingEnabled: false },
    // 池首成员 503、次成员兜底成功：非流式扇出的结局总结行（方案甲收口后
    // failover 中途行已移除，恢复时只打这一条）是可按需触发的日志行。
    behaviors: {
      "res-p1": () => ({ ok: false, status: 503, body: { error: { message: "upstream 503" } } }),
    },
  });
  const result = await h.ready;
  try {
    const post = () => fetch(`http://127.0.0.1:${result.port}/openai/res-pool/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${result.token}`, "content-type": "application/json", "x-agent-id": "zcode" },
      body: JSON.stringify({ model: "shared-model", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });

    const warnNeedsGateOn = () => post().then(async (res) => {
      assert.equal(res.status, 200);
      await res.json();
    });

    await warnNeedsGateOn();
    assert.ok(existsSync(h.logPath), "日志文件随装配创建（tee 流）");
    assert.equal(readFileSync(h.logPath, "utf8").includes("recovered after failover res-p1→res-p2"), false,
      "开关关掉时结局总结行被活闸门整条丢弃");

    // 热读：settings.json 改回开启（不重启），下一条结局总结行落盘。
    writeFileSync(h.settingsPath, JSON.stringify({ loggingEnabled: true }));
    await warnNeedsGateOn();
    assert.ok(readFileSync(h.logPath, "utf8").includes("recovered after failover res-p1→res-p2"),
      "开关改回后同一条日志路径立即恢复落盘");
  } finally {
    await result.close();
  }
});
