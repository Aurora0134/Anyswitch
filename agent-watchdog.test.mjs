// agent-watchdog unit tests.
//
// probeWatchdog must validate the marker port's JSON body (watchdog === true),
// not just a 200 status; stopWatchdog applies the same PID identity gate as
// relay-process-manager.stopRelay. All process-facing dependencies are
// injected fakes; the mock marker servers bind ephemeral loopback ports only.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeWatchdog, stopWatchdog, getWatchdogPidPath, startWatchdogHost } from "./agent-watchdog.mjs";
import { createAgentWatcher } from "./agent-watcher.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

const APP_DIR = fileURLToPath(new URL(".", import.meta.url));
const OWN_CMD = `node.exe ${APP_DIR}agent-watchdog.mjs`;
const FOREIGN_CMD = "node.exe C:\\Users\\someone\\unrelated\\server.mjs";

function writeWatchdogPidFile(root, pid) {
  writeFileSync(getWatchdogPidPath(root), String(pid), "utf8");
}

async function withMockServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("probeWatchdog accepts the marker body {ok:true,watchdog:true}", async () => {
  await withMockServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, watchdog: true }));
  }, async (port) => {
    assert.equal(await probeWatchdog(port), true);
  });
});

test("probeWatchdog rejects a 200 body without the watchdog marker", async () => {
  await withMockServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async (port) => {
    assert.equal(await probeWatchdog(port), false);
  });
});

test("probeWatchdog rejects a non-JSON body", async () => {
  await withMockServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("OK");
  }, async (port) => {
    assert.equal(await probeWatchdog(port), false);
  });
});

test("probeWatchdog rejects a non-200 status", async () => {
  await withMockServer((req, res) => {
    res.writeHead(404);
    res.end();
  }, async (port) => {
    assert.equal(await probeWatchdog(port), false);
  });
});

function makeWatchdogRoot() {
  // relayDataRoot(env) = join(env.LOCALAPPDATA, "Anyswitch"), so the pid file
  // lives one level below the env root we hand to stopWatchdog.
  const envRoot = mkTestDir("anyswitch-wd-");
  const dataRoot = join(envRoot, "Anyswitch");
  mkdirSync(dataRoot, { recursive: true });
  return { envRoot, dataRoot };
}

function makeStopDeps({ ownerPid = null, alive = [], commandLines = {}, probeDown = true } = {}) {
  const aliveSet = new Set(alive);
  const killed = [];
  return {
    killed,
    deps: {
      findPortOwnerPid: () => ownerPid,
      isPidAlive: (pid) => aliveSet.has(pid),
      getProcessCommandLine: (pid) => commandLines[pid] ?? null,
      terminatePid: (pid) => killed.push(pid),
      probe: async () => !probeDown,
      delay: async () => {},
      stopPollMs: 1,
      stopTimeoutMs: 10,
    },
  };
}

test("stopWatchdog refuses to kill a live PID whose command line is foreign", async () => {
  const { envRoot, dataRoot } = makeWatchdogRoot();
  writeWatchdogPidFile(dataRoot, 777);

  const { deps, killed } = makeStopDeps({
    ownerPid: 777,
    alive: [777],
    commandLines: { 777: FOREIGN_CMD },
    probeDown: false, // marker port still answering after the refused kill
  });

  const result = await stopWatchdog({ LOCALAPPDATA: envRoot }, deps);

  assert.equal(result.ok, false);
  assert.match(result.reason, /777/);
  assert.deepEqual(killed, []);
});

test("stopWatchdog kills a verified PID and clears the pid file once down", async () => {
  const { envRoot, dataRoot } = makeWatchdogRoot();
  writeWatchdogPidFile(dataRoot, 888);

  const { deps, killed } = makeStopDeps({
    ownerPid: 888,
    alive: [888],
    commandLines: { 888: OWN_CMD },
    probeDown: true,
  });

  const result = await stopWatchdog({ LOCALAPPDATA: envRoot }, deps);

  assert.equal(result.ok, true);
  assert.deepEqual(killed, [888]);
  assert.equal(existsSync(getWatchdogPidPath(dataRoot)), false, "pid file cleared once the marker port is down");
});

test("stopWatchdog is fail-safe when the command line cannot be queried", async () => {
  const { envRoot, dataRoot } = makeWatchdogRoot();
  writeWatchdogPidFile(dataRoot, 999);

  const { deps, killed } = makeStopDeps({
    alive: [999],
    commandLines: {},
  });

  const result = await stopWatchdog({ LOCALAPPDATA: envRoot }, deps);

  assert.equal(result.ok, false);
  assert.match(result.reason, /999/);
  assert.deepEqual(killed, []);
});

// --- stopWatchdog async owner path -------------------------

test("stopWatchdog kills an owner PID that arrives as a Promise (a Promise owner must not be dropped)", async () => {
  const { envRoot, dataRoot } = makeWatchdogRoot();
  writeWatchdogPidFile(dataRoot, 888);

  const { deps, killed } = makeStopDeps({
    alive: [555, 888],
    commandLines: { 555: OWN_CMD, 888: OWN_CMD },
    probeDown: true,
  });
  deps.findPortOwnerPid = async () => 555; // async mock — the old sync filter would silently drop this

  const result = await stopWatchdog({ LOCALAPPDATA: envRoot }, deps);

  assert.equal(result.ok, true);
  assert.deepEqual(killed.sort(), [555, 888], "the async owner PID must reach the kill loop");
});

test("stopWatchdog treats an owner lookup resolving null as 'no port owner'", async () => {
  const { envRoot, dataRoot } = makeWatchdogRoot();
  writeWatchdogPidFile(dataRoot, 888);

  const { deps, killed } = makeStopDeps({
    alive: [888],
    commandLines: { 888: OWN_CMD },
    probeDown: true,
  });
  deps.findPortOwnerPid = async () => null;

  const result = await stopWatchdog({ LOCALAPPDATA: envRoot }, deps);

  assert.equal(result.ok, true);
  assert.deepEqual(killed, [888], "only the pid-file PID is killed");
});

// --- follow-agent watcher revive path ---------------------------------------

test("followAgent tick reaches getRelayStatus/startRelay with an ASYNC scanProcesses", async () => {
  // Regression: the injected scanProcesses is the collector's async probe —
  // calling it without await made `procs` a Promise, every endpoint count
  // read undefined, and anyAgent short-circuited the tick to a silent no-op.
  const calls = { getRelayStatus: 0, startRelay: 0 };
  const watcher = createAgentWatcher({
    root: "C:/x",
    scanProcesses: async () => ({ zcode: 1 }),
    startRelay: async () => { calls.startRelay += 1; },
    getRelayStatus: async () => { calls.getRelayStatus += 1; return { status: "stopped" }; },
    loadSettings: () => ({ settings: { followAgent: true } }),
    intervalMs: 60 * 60 * 1000, // the timer must not re-fire during the test
    logger: { info() {}, error() {} },
  });
  watcher.start(); // fires one tick immediately
  await new Promise((r) => setTimeout(r, 50));
  watcher.stop();
  assert.equal(calls.getRelayStatus, 1, "async scanProcesses 下 anyAgent 必须读到真计数");
  assert.equal(calls.startRelay, 1, "agent 在跑且 relay 停了就必须自动拉起");
});

test("startWatchdogHost wires the real settings file (not the data root dir) into the tick", async () => {
  // Regression: the loadSettings glue forwarded the watcher's `root` argument
  // (a directory) as the settings file path; readFileSync on a directory
  // failed, the tick saw empty settings, and followAgent was silently dead.
  const localAppData = mkTestDir("anyswitch-watchdog-");
  mkdirSync(join(localAppData, "Anyswitch"), { recursive: true });
  writeFileSync(join(localAppData, "Anyswitch", "settings.json"), JSON.stringify({ followAgent: true }));
  const calls = { getRelayStatus: 0, startRelay: 0 };
  const host = await startWatchdogHost({
    base: { LOCALAPPDATA: localAppData },
    port: 0, // ephemeral marker port — no collision with a live watchdog
    logger: { info() {}, error() {} },
    watcherIntervalMs: 60 * 60 * 1000,
    watcherDeps: {
      scanProcesses: async () => ({ zcode: 1 }),
      getRelayStatus: async () => { calls.getRelayStatus += 1; return { status: "stopped" }; },
      startRelay: async () => { calls.startRelay += 1; },
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  await host.close();
  assert.equal(calls.getRelayStatus, 1, "tick 必须读到真 settings.json 并走到 relay 状态探测");
  assert.equal(calls.startRelay, 1);
});

// --- degraded relay self-heal (2026-10-05) ----------------------------------
//
// "Does the port answer?" was the only question the watcher asked, so a relay
// that stayed up while failing EVERY request was never touched. These tests lock
// the reaction and its guard rails together: the old shape acted on every tick
// forever, failures included, which spawned 48 relays that each died on the
// occupied port — 2.5 hours of churn that made a bad situation worse.

function makeDegradedWatcher({ status, now, restarts, errors = [], options = {} }) {
  return createAgentWatcher({
    root: "C:/x",
    scanProcesses: async () => ({ dsh: 1 }),
    startRelay: async () => { restarts.push("start"); },
    restartRelay: async () => { restarts.push("restart"); },
    getRelayStatus: async () => status.value,
    loadSettings: () => ({ settings: { followAgent: true } }),
    intervalMs: 60 * 60 * 1000,
    logger: { info() {}, warn() {}, error: (m) => errors.push(m) },
    now: () => now.value,
    degradedGraceMs: 60_000,
    healBackoffMs: [30_000],
    healBudget: 3,
    healBudgetWindowMs: 30 * 60_000,
    ...options,
  });
}

test("degraded relay: nothing happens while the relay serves", async () => {
  const status = { value: { status: "running", degraded: false } };
  const now = { value: 0 };
  const restarts = [];
  const w = makeDegradedWatcher({ status, now, restarts });
  await w.tick();
  assert.deepEqual(restarts, [], "健康的中继一次都不该被动");
});

test("degraded relay: the grace period is waited out before anything is touched", async () => {
  const status = { value: { status: "running", degraded: true, consecutiveFailures: 5, lastFailureKind: "credential" } };
  const now = { value: 1_000_000 };
  const restarts = [];
  const w = makeDegradedWatcher({ status, now, restarts });

  await w.tick(); // first sighting starts the clock
  assert.deepEqual(restarts, [], "刚看见降级就重启 = 把偶发抖动变成一次重启");
  now.value += 30_000;
  await w.tick();
  assert.deepEqual(restarts, [], "宽限期内不动手");
  now.value += 31_000; // 61s since the first sighting
  await w.tick();
  assert.deepEqual(restarts, ["restart"], "过宽限期走重启（端口被自己占着时「启动」是空操作）");
});

test("degraded relay: backoff spaces the attempts out", async () => {
  const status = { value: { status: "running", degraded: true, consecutiveFailures: 9, lastFailureKind: "credential" } };
  const now = { value: 0 };
  const restarts = [];
  const w = makeDegradedWatcher({ status, now, restarts });

  await w.tick();
  now.value = 60_000;
  await w.tick();
  assert.deepEqual(restarts, ["restart"]);
  now.value = 70_000; // inside the 30s backoff
  await w.tick();
  assert.deepEqual(restarts, ["restart"], "退避未到不再动手");
  now.value = 90_000;
  await w.tick();
  assert.deepEqual(restarts, ["restart", "restart"], "退避走完才允许下一次");
});

test("degraded relay: gives up after the budget and records why", async () => {
  const status = { value: { status: "running", degraded: true, consecutiveFailures: 9, lastFailureKind: "credential" } };
  const now = { value: 0 };
  const restarts = [];
  const errors = [];
  const w = makeDegradedWatcher({
    status, now, restarts, errors,
    options: { healBudget: 2, healBackoffMs: [0] },
  });

  await w.tick(); // sighting
  now.value = 60_000;
  await w.tick(); // attempt 1
  now.value = 61_000;
  await w.tick(); // attempt 2
  assert.equal(restarts.length, 2);
  now.value = 62_000;
  await w.tick();
  now.value = 300_000;
  await w.tick();
  assert.equal(restarts.length, 2, "预算用完即停手，不再无限拉进程");
  assert.equal(errors.length, 1, "停手必须留一条明确的记录，而不是静默放弃");
  assert.match(errors[0], /auto-heal stopped/);
});

test("degraded relay: a brief recovery does NOT hand the budget back", async () => {
  // 重启之后新进程当然是干净的、探针立刻报正常。如果这就把预算还回去，「30 分钟
  // 内最多 3 次」形同虚设——每次重启都重置，实际节奏退化成「宽限期 + 退避」一次，
  // 比原来的每 tick 一拉还密。
  const status = { value: { status: "running", degraded: true, consecutiveFailures: 9, lastFailureKind: "credential" } };
  const now = { value: 0 };
  const restarts = [];
  const w = makeDegradedWatcher({
    status, now, restarts,
    options: { healBudget: 1, healBackoffMs: [0] },
  });

  await w.tick(); // sighting
  now.value = 60_000;
  await w.tick(); // attempt 1（预算 1，已用完）
  assert.equal(restarts.length, 1);

  status.value = { status: "running", degraded: false };
  now.value = 61_000;
  await w.tick(); // 短暂恢复
  status.value = { status: "running", degraded: true, consecutiveFailures: 3, lastFailureKind: "credential" };
  now.value = 200_000;
  await w.tick(); // 重新计时
  now.value = 400_000;
  await w.tick(); // 宽限期早过，但预算还没还
  assert.equal(restarts.length, 1, "窗口内已用掉的额度不因一次恢复而归还");
});

test("degraded relay: the budget comes back once the window has passed", async () => {
  const status = { value: { status: "running", degraded: true, consecutiveFailures: 9, lastFailureKind: "credential" } };
  const now = { value: 0 };
  const restarts = [];
  const w = makeDegradedWatcher({
    status, now, restarts,
    options: { healBudget: 1, healBackoffMs: [0], healBudgetWindowMs: 30 * 60_000 },
  });

  await w.tick();
  now.value = 60_000;
  await w.tick();
  assert.equal(restarts.length, 1);

  now.value = 60_000 + 31 * 60_000; // 窗口已过
  await w.tick();
  assert.equal(restarts.length, 2, "窗口滑过去之后额度自然恢复");
});

test("degraded relay: a stopped relay still takes the plain start path", async () => {
  const status = { value: { status: "stopped" } };
  const now = { value: 0 };
  const restarts = [];
  const w = makeDegradedWatcher({ status, now, restarts });
  await w.tick();
  assert.deepEqual(restarts, ["start"], "原有自愈路径不变");
});
