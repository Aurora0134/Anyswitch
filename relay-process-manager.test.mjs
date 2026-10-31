// relay-process-manager unit tests.
//
// Locks the PID identity gate: stopRelay must never taskkill a PID whose
// command line does not reference this app directory, and restartRelay must
// abort when the stop leg fails. Every process-facing dependency (netstat /
// tasklist / powershell / taskkill / HTTP probe) is an injected fake, so no
// real process is spawned or killed and the production relay on 47821 is
// never touched.
//
// One deliberate exception, documented so the claim above stays honest: the
// liveness test below also calls the un-injected probePidLiveness on our own
// PID and on PID 999999. Both are pure kernel existence checks
// (process.kill(pid, 0) — signal 0 delivers nothing): they spawn and kill
// nothing, never reach the tasklist fallback, and are deterministic — our own
// process is by definition alive, and 999999 is not 4-aligned, so the
// Windows kernel (which only hands out multiples of 4) can never have
// assigned it to a real process.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getRelayPidPath,
  writeRelayPid,
  readRelayPid,
  isOwnProcess,
  getProcessCommandLine,
  getProcessCommandLineAsync,
  getRelayStatus,
  stopRelay,
  restartRelay,
  findPortOwnerPid,
  createCachedPortOwnerFinder,
  PORT_OWNER_CACHE_TTL_MS,
  probePidLiveness,
  isPidAlive,
} from "./relay-process-manager.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

// stopRelay verifies against the real app directory, so the "own" command
// lines injected in these tests must reference it.
const APP_DIR = fileURLToPath(new URL(".", import.meta.url));
const OWN_RELAY_CMD = `"C:\\Program Files\\nodejs\\node.exe" ${APP_DIR}relay-host.mjs`;
const OWN_LAUNCHER_CMD = `node.exe ${APP_DIR}zcode-launcher.mjs`; // per-launch launcher also binds 47821
const FOREIGN_CMD = `"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\someone\\projects\\unrelated\\server.mjs`;

function makeRoot() {
  return mkTestDir("anyswitch-rpm-");
}

// Build injected deps for stopRelay. `alive` PIDs pass the liveness filter;
// `commandLines` maps PID -> command line (missing entry = query failed).
function makeStopDeps({
  ownerPid = null,
  alive = [],
  commandLines = {},
  portAnswering = false,
} = {}) {
  const aliveSet = new Set(alive);
  const killed = [];
  return {
    killed,
    deps: {
      findPortOwnerPid: () => ownerPid,
      isPidAlive: (pid) => aliveSet.has(pid),
      getProcessCommandLine: (pid) => commandLines[pid] ?? null,
      terminatePid: (pid) => killed.push(pid),
      probe: async () => portAnswering,
      delay: async () => {},
      stopPollMs: 1,
      stopTimeoutMs: 10,
    },
  };
}

// Minimal stand-in for the child process getProcessCommandLineAsync wires up:
// the source only touches stdout (setEncoding/on("data")), on("error"/"close")
// and kill() (timeout path). Events are emitted on a microtask, like a real
// child's, so the promise executor finishes wiring its handlers first.
function fakePowerShellChild({ code = 0, stdout = "" } = {}) {
  const handlers = {};
  const child = {
    stdout: {
      setEncoding() {},
      on(_event, fn) { handlers.data = fn; },
    },
    on(event, fn) { handlers[event] = fn; },
    kill() {},
  };
  queueMicrotask(() => {
    if (stdout) handlers.data?.(stdout);
    handlers.close?.(code);
  });
  return child;
}

test("isOwnProcess accepts a relay-host command line inside the app dir", () => {
  assert.equal(isOwnProcess(OWN_RELAY_CMD, APP_DIR), true);
});

test("isOwnProcess accepts a per-launch launcher command line (not just relay-host.mjs)", () => {
  assert.equal(isOwnProcess(OWN_LAUNCHER_CMD, APP_DIR), true);
});

test("isOwnProcess accepts forward-slash command lines", () => {
  const fwd = `node.exe ${APP_DIR.replaceAll("\\", "/")}relay-host.mjs`;
  assert.equal(isOwnProcess(fwd, APP_DIR), true);
});

test("isOwnProcess rejects a foreign command line and unreadable command lines", () => {
  assert.equal(isOwnProcess(FOREIGN_CMD, APP_DIR), false);
  assert.equal(isOwnProcess(null, APP_DIR), false);
  assert.equal(isOwnProcess(undefined, APP_DIR), false);
  assert.equal(isOwnProcess("", APP_DIR), false);
});

test("getProcessCommandLine returns null for invalid PIDs without spawning powershell", () => {
  // Counting stub: without it this test could not see the difference between
  // "the guard returned null" and "the guard skipped the spawn" — the latter
  // is the behavior its name claims to lock.
  let spawnCalls = 0;
  const spawnSyncSpy = () => {
    spawnCalls += 1;
    return { status: 0, stdout: "should never be reached" };
  };
  assert.equal(getProcessCommandLine(0, { spawnSync: spawnSyncSpy }), null);
  assert.equal(getProcessCommandLine(-1, { spawnSync: spawnSyncSpy }), null);
  assert.equal(getProcessCommandLine(null, { spawnSync: spawnSyncSpy }), null);
  assert.equal(spawnCalls, 0, "invalid PIDs must short-circuit before any powershell spawn");

  // Positive control: with the same seam, a valid PID does go through the
  // spawn path — proving the zero count above is a real finding and not a
  // stub that is simply never consulted.
  assert.equal(
    getProcessCommandLine(4242, { spawnSync: () => ({ status: 0, stdout: "node.exe relay-host.mjs\n" }) }),
    "node.exe relay-host.mjs",
  );
});

test("stopRelay refuses to kill a live PID whose command line is foreign", async () => {
  const root = makeRoot();
  const pidPath = getRelayPidPath(root);
  writeRelayPid(1234, pidPath);

  const { deps, killed } = makeStopDeps({
    ownerPid: null,
    alive: [1234],
    commandLines: { 1234: FOREIGN_CMD },
    portAnswering: false,
  });

  const result = await stopRelay(root, deps);

  assert.equal(result.ok, false, "an unidentified PID must make the stop fail loudly");
  assert.match(result.reason, /1234/);
  assert.deepEqual(killed, [], "must not taskkill an unverified PID");
});

test("stopRelay refuses (fail-safe) when the command line cannot be queried", async () => {
  const root = makeRoot();
  const pidPath = getRelayPidPath(root);
  writeRelayPid(2222, pidPath);

  const { deps, killed } = makeStopDeps({
    alive: [2222],
    commandLines: {}, // powershell query failed / empty → null
  });

  const result = await stopRelay(root, deps);

  assert.equal(result.ok, false);
  assert.match(result.reason, /2222/);
  assert.deepEqual(killed, [], "fail-safe: no command line, no kill");
});

test("stopRelay kills both filePid and ownerPid once both verify as own processes", async () => {
  const root = makeRoot();
  const pidPath = getRelayPidPath(root);
  writeRelayPid(111, pidPath);

  const { deps, killed } = makeStopDeps({
    ownerPid: 222,
    alive: [111, 222],
    commandLines: { 111: OWN_RELAY_CMD, 222: OWN_LAUNCHER_CMD },
    portAnswering: false,
  });

  const result = await stopRelay(root, deps);

  assert.equal(result.ok, true);
  assert.deepEqual(killed.sort(), [111, 222]);
  assert.equal(result.relay.status, "stopped");
  assert.equal(readRelayPid(pidPath), null, "pid file is cleared after a clean stop");
});

test("stopRelay skips a dead filePid silently (nothing to kill, no refusal)", async () => {
  const root = makeRoot();
  const pidPath = getRelayPidPath(root);
  writeRelayPid(111, pidPath);

  const { deps, killed } = makeStopDeps({
    ownerPid: 222,
    alive: [222], // filePid 111 is dead
    commandLines: { 222: OWN_RELAY_CMD },
  });

  const result = await stopRelay(root, deps);

  assert.equal(result.ok, true);
  assert.deepEqual(killed, [222]);
});

test("stopRelay reports ok:false when a refused PID leaves the port serving", async () => {
  const root = makeRoot();
  const pidPath = getRelayPidPath(root);
  writeRelayPid(333, pidPath);

  const { deps, killed } = makeStopDeps({
    ownerPid: 333,
    alive: [333],
    commandLines: { 333: FOREIGN_CMD },
    portAnswering: true, // refused kill → relay still up
  });

  const result = await stopRelay(root, deps);

  assert.equal(result.ok, false);
  assert.equal(result.relay.status, "running");
  assert.deepEqual(killed, []);
});

test("restartRelay aborts (no start) when the stop leg fails", async () => {
  const root = makeRoot();
  let started = false;
  const result = await restartRelay(root, process.env, {
    stopRelay: async () => ({ ok: false, reason: "refused to kill PID 1234", relay: { status: "running", pid: 1234, port: 47821 } }),
    startRelay: async () => {
      started = true;
      return { ok: true, relay: { status: "running", pid: 9, port: 47821 }, reused: false };
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /1234/);
  assert.equal(started, false, "a failed stop must abort the restart, not spawn a second relay");
});

test("restartRelay starts the relay only after a successful stop", async () => {
  const root = makeRoot();
  let started = false;
  const result = await restartRelay(root, process.env, {
    stopRelay: async () => ({ ok: true, relay: { status: "stopped", pid: null, port: 47821 } }),
    startRelay: async () => {
      started = true;
      return { ok: true, relay: { status: "running", pid: 9, port: 47821 }, reused: false };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(started, true);
});

// --- async findPortOwnerPid + cached wrapper --------------

test("findPortOwnerPid exposes cached and uncached shapes; uncached is the raw function", () => {
  assert.equal(typeof findPortOwnerPid.cached, "function");
  // uncached must be the raw lookup itself: it bypasses the cache and the
  // in-flight table entirely, never sharing a slot with the cached wrapper.
  assert.equal(findPortOwnerPid.uncached, findPortOwnerPid);
  assert.notEqual(findPortOwnerPid.cached, findPortOwnerPid.uncached);
});

test("cached finder does not re-call the underlying lookup within the TTL", async () => {
  let calls = 0;
  let clock = 1000;
  const cached = createCachedPortOwnerFinder(async () => {
    calls += 1;
    return 4321;
  }, { ttlMs: PORT_OWNER_CACHE_TTL_MS, now: () => clock });

  assert.equal(await cached(47821), 4321);
  assert.equal(await cached(47821), 4321);
  assert.equal(calls, 1, "second call inside the TTL must be served from cache");

  clock += PORT_OWNER_CACHE_TTL_MS + 1; // let the entry expire
  assert.equal(await cached(47821), 4321);
  assert.equal(calls, 2, "after the TTL the underlying lookup runs again");
});

test("cached finder caches per port (different ports do not share entries)", async () => {
  let calls = 0;
  const cached = createCachedPortOwnerFinder(async (port) => {
    calls += 1;
    return port + 1;
  }, { now: () => 0 });

  assert.equal(await cached(47821), 47822);
  assert.equal(await cached(47822), 47823);
  assert.equal(calls, 2);
  assert.equal(await cached(47821), 47822);
  assert.equal(calls, 2, "both ports are now cached");
});

test("cached finder dedupes concurrent in-flight lookups for the same port", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const cached = createCachedPortOwnerFinder(async () => {
    calls += 1;
    await gate;
    return 777;
  });

  const p1 = cached(47821);
  const p2 = cached(47821);
  assert.equal(p1, p2, "the second call must join the in-flight lookup (same Promise), not start a new one");
  release();
  assert.equal(await p1, 777);
  assert.equal(await p2, 777);
  assert.equal(calls, 1, "only one underlying netstat ran for the two concurrent calls");

  // Once settled, a fresh call inside the TTL is served from cache.
  assert.equal(await cached(47821), 777);
  assert.equal(calls, 1);
});

test("getRelayStatus awaits an async owner lookup (a Promise owner must not leak into the payload)", async () => {
  const root = makeRoot();
  const status = await getRelayStatus(root, {
    probe: async () => true,
    findPortOwnerPid: async () => 4242,
    isPidAlive: () => false,
  });
  assert.equal(status.status, "running");
  assert.equal(status.pid, 4242);
});

test("getRelayStatus falls back to the pid file when the owner lookup resolves null", async () => {
  const root = makeRoot();
  writeRelayPid(1234, getRelayPidPath(root));
  const status = await getRelayStatus(root, {
    probe: async () => true,
    findPortOwnerPid: async () => null,
    isPidAlive: () => false,
  });
  assert.equal(status.status, "running");
  assert.equal(status.pid, 1234);
});

test("stopRelay kills an owner PID that arrives as a Promise (a Promise owner must not be dropped)", async () => {
  const root = makeRoot();
  const pidPath = getRelayPidPath(root);
  writeRelayPid(111, pidPath);

  const { deps, killed } = makeStopDeps({
    ownerPid: 222,
    alive: [111, 222],
    commandLines: { 111: OWN_RELAY_CMD, 222: OWN_LAUNCHER_CMD },
    portAnswering: false,
  });
  deps.findPortOwnerPid = async () => 222; // async mock — the old sync filter would silently drop this

  const result = await stopRelay(root, deps);

  assert.equal(result.ok, true);
  assert.deepEqual(killed.sort(), [111, 222], "the async owner PID must reach the kill loop");
});

// --- async command-line query (the stop-leg cold-start fix) --------------

test("getProcessCommandLineAsync mirrors the sync null-on-invalid contract without spawning", async () => {
  // Counting stub over the injectable spawn seam — same teeth as the sync
  // test: the name claims "without spawning", so the spawn count is asserted,
  // not just the null return.
  let spawnCalls = 0;
  const spawnSpy = () => {
    spawnCalls += 1;
    return fakePowerShellChild({ stdout: "node.exe relay-host.mjs" });
  };
  assert.equal(await getProcessCommandLineAsync(0, { spawn: spawnSpy }), null);
  assert.equal(await getProcessCommandLineAsync(-1, { spawn: spawnSpy }), null);
  assert.equal(await getProcessCommandLineAsync(null, { spawn: spawnSpy }), null);
  assert.equal(spawnCalls, 0, "invalid PIDs must short-circuit before any powershell spawn");

  // Positive control: a valid PID exercises the stubbed spawn path end to end
  // (stdout collected, close(0), trimmed line returned).
  assert.equal(await getProcessCommandLineAsync(4242, { spawn: spawnSpy }), "node.exe relay-host.mjs");
  assert.equal(spawnCalls, 1, "a valid PID must go through the (stubbed) powershell path");
});

test("stopRelay accepts an async (Promise-returning) injected command-line mapper", async () => {
  const root = makeRoot();
  const pidPath = getRelayPidPath(root);
  writeRelayPid(111, pidPath);
  const { deps, killed } = makeStopDeps({ ownerPid: null, alive: [111], commandLines: {}, portAnswering: false });
  // Inject an ASYNC mapper returning an own command line — the kill loop must
  // await it (a missing await would turn the Promise into a falsy verify and
  // refuse the kill).
  deps.getProcessCommandLine = async () => OWN_RELAY_CMD;
  const result = await stopRelay(root, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(killed, [111], "the awaited async mapper must verify and reach the kill");
});

// --- liveness probe: three states, not two ------------------------------
//
// "The OS says no such process" and "the probe could not tell" are different
// findings, and collapsing them into one false is how a healthy terminal host
// came to be killed by its own parent watchdog (the tasklist probe reports
// false on a timeout/error under load). Only a positive finding of absence may
// count as death; a probe that failed proves nothing either way.

test("probePidLiveness 区分「确认死亡」与「探针无结论」", () => {
  let crossed = 0;
  const crossCheck = () => {
    crossed += 1;
    return "alive";
  };

  // A native verdict that is already conclusive must not pay for a tasklist run.
  assert.equal(probePidLiveness(4242, { nativeProbe: () => "alive", crossCheck }), "alive");
  assert.equal(probePidLiveness(4242, { nativeProbe: () => "dead", crossCheck }), "dead");
  assert.equal(crossed, 0, "a conclusive native verdict skips the cross-check entirely");

  // Inconclusive native probe → the cross-check decides; inconclusive there too
  // → unknown, never dead.
  assert.equal(probePidLiveness(4242, { nativeProbe: () => "unknown", crossCheck: () => "dead" }), "dead");
  assert.equal(probePidLiveness(4242, { nativeProbe: () => "unknown", crossCheck: () => "alive" }), "alive");
  assert.equal(probePidLiveness(4242, { nativeProbe: () => "unknown", crossCheck: () => "unknown" }), "unknown");
});

test("probePidLiveness 对无效 PID 与真实进程给出正确结论", () => {
  // Pure invalid-PID logic: no OS touch at all.
  assert.equal(probePidLiveness(0), "dead");
  assert.equal(probePidLiveness(-1), "dead");
  assert.equal(probePidLiveness(Number.NaN), "dead");
  // Real OS, deterministic verdicts — this is the only direct coverage of the
  // default nativeLivenessProbe's success/ESRCH mappings (see the file header
  // for why these two do not break the all-fakes rule).
  assert.equal(probePidLiveness(process.pid), "alive", "本进程必然活着");
  // A PID that cannot exist is a positive finding of absence, not an
  // inconclusive probe: the watchdog still has to be able to clean up orphans.
  // 999999 is not machine-dependent luck — the Windows kernel only assigns
  // 4-aligned PIDs (every live PID in tasklist is a multiple of 4), and
  // 999999 % 4 === 3, so it can never name a real process. The native probe
  // therefore deterministically answers ESRCH → "dead" and never reaches the
  // tasklist fallback.
  assert.equal(probePidLiveness(999999), "dead", "不存在的 PID 是确认死亡，不是无结论");
});

test("isPidAlive 保持保守口径：无结论不算存活", () => {
  // The conservatism is the whole contract (see isPidAlive in the source: kill
  // gates must not act on a guess). Before the deps passthrough this was
  // untestable — no injected probe could make the boolean view see "unknown",
  // so the old assertions only re-covered dead/alive facts the probe test
  // already had.
  assert.equal(
    isPidAlive(4242, { nativeProbe: () => "unknown", crossCheck: () => "unknown" }),
    false,
    "探针两级都无结论 → 不判活（保守口径，宁可不杀）",
  );
  assert.equal(
    isPidAlive(4242, { nativeProbe: () => "unknown", crossCheck: () => "alive" }),
    true,
    "交叉检查确认活着 → 判活",
  );
  assert.equal(
    isPidAlive(4242, { nativeProbe: () => "dead" }),
    false,
    "确认死亡 → 不判活",
  );
});

// --- degraded reporting (2026-10-05) ----------------------------------------
//
// getRelayStatus must be able to say "running, but not able to serve". The status
// string deliberately stays "running": startRelay short-circuits on it, and a
// fourth lifecycle state there would make every watchdog tick spawn a duplicate
// relay that dies on the occupied port.

test("getRelayStatus carries degraded facts while keeping status 'running'", async () => {
  const root = makeRoot();
  writeRelayPid(1234, getRelayPidPath(root));

  const status = await getRelayStatus(root, {
    probe: async () => ({ serving: true, degraded: true, consecutiveFailures: 7, lastFailureKind: "credential" }),
    findPortOwnerPid: () => 1234,
    isPidAlive: () => true,
  });

  assert.equal(status.status, "running", "degraded 是附加事实，不是第四种生命周期状态");
  assert.equal(status.degraded, true);
  assert.equal(status.consecutiveFailures, 7);
  assert.equal(status.lastFailureKind, "credential");
  assert.equal(status.pid, 1234, "端口属主仍是权威 pid");
});

test("getRelayStatus accepts a boolean probe (existing doubles) and reports not degraded", async () => {
  const root = makeRoot();
  writeRelayPid(4321, getRelayPidPath(root));

  const status = await getRelayStatus(root, {
    probe: async () => true,
    findPortOwnerPid: () => 4321,
    isPidAlive: () => true,
  });

  assert.equal(status.status, "running");
  assert.equal(status.degraded, false);
  assert.equal(status.consecutiveFailures, 0);
});

test("getRelayStatus reports no degradation while the port is not serving", async () => {
  const root = makeRoot();
  writeRelayPid(555, getRelayPidPath(root));

  const status = await getRelayStatus(root, {
    probe: async () => ({ serving: false, degraded: true, consecutiveFailures: 9 }),
    findPortOwnerPid: () => null,
    isPidAlive: () => true,
  });

  assert.equal(status.status, "starting", "pid 还活着但端口不答 = 启动中");
  assert.equal(status.degraded, false, "没在服务的进程不该被报成服务异常");
});

test("stopRelay normalizes an object probe: a still-serving relay is not 'down'", async () => {
  // 归一化的理由：停用路径的等待轮询写的是 `!probe(...)`，而对象恒为真值——
  // 不压成布尔就会把「一直还在答」误判成「已经停了」。
  const root = makeRoot();
  const { deps, killed } = makeStopDeps({ portAnswering: false });
  deps.probe = async () => ({ serving: true, degraded: false });

  const result = await stopRelay(root, deps);

  assert.equal(result.ok, false, "端口还在答，停用不算成功");
  assert.deepEqual(killed, []);
});

test("stopRelay treats an object probe reporting not-serving as down", async () => {
  const root = makeRoot();
  const { deps } = makeStopDeps({ portAnswering: false });
  deps.probe = async () => ({ serving: false, degraded: false });

  const result = await stopRelay(root, deps);

  assert.equal(result.ok, true);
  assert.equal(result.relay.status, "stopped");
});
