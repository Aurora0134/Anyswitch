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
import { probeWatchdog, stopWatchdog, getWatchdogPidPath } from "./agent-watchdog.mjs";

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
