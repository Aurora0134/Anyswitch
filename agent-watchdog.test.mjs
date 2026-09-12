// agent-watchdog unit tests (B·进程与端口安全).
//
// probeWatchdog must validate the marker port's JSON body (watchdog === true),
// not just a 200 status; stopWatchdog applies the same PID identity gate as
// relay-process-manager.stopRelay. All process-facing dependencies are
// injected fakes; the mock marker servers bind ephemeral loopback ports only.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeWatchdog, stopWatchdog, getWatchdogPidPath, startWatchdogHost } from "./agent-watchdog.mjs";
import { createAgentWatcher } from "./agent-watcher.mjs";

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
  const envRoot = mkdtempSync(join(tmpdir(), "anyswitch-wd-"));
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

// --- A1: stopWatchdog async owner path (R8 coverage) -------------------------

test("stopWatchdog kills an owner PID that arrives as a Promise (R8: filter must not drop it)", async () => {
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
  const localAppData = mkdtempSync(join(tmpdir(), "anyswitch-watchdog-"));
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
