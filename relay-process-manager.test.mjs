// relay-process-manager unit tests (B·进程与端口安全).
//
// Locks the PID identity gate: stopRelay must never taskkill a PID whose
// command line does not reference this app directory, and restartRelay must
// abort when the stop leg fails. Every process-facing dependency (netstat /
// tasklist / powershell / taskkill / HTTP probe) is an injected fake, so no
// real process is spawned or killed and the production relay on 47821 is
// never touched.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getRelayPidPath,
  writeRelayPid,
  readRelayPid,
  isOwnProcess,
  getProcessCommandLine,
  getRelayStatus,
  stopRelay,
  restartRelay,
  findPortOwnerPid,
  createCachedPortOwnerFinder,
  PORT_OWNER_CACHE_TTL_MS,
} from "./relay-process-manager.mjs";

// stopRelay verifies against the real app directory, so the "own" command
// lines injected in these tests must reference it.
const APP_DIR = fileURLToPath(new URL(".", import.meta.url));
const OWN_RELAY_CMD = `"C:\\Program Files\\nodejs\\node.exe" ${APP_DIR}relay-host.mjs`;
const OWN_LAUNCHER_CMD = `node.exe ${APP_DIR}zcode-launcher.mjs`; // per-launch launcher also binds 47821
const FOREIGN_CMD = `"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\someone\\projects\\unrelated\\server.mjs`;

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "apicred-rpm-"));
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
  assert.equal(getProcessCommandLine(0), null);
  assert.equal(getProcessCommandLine(-1), null);
  assert.equal(getProcessCommandLine(null), null);
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

// --- A1: async findPortOwnerPid + cached wrapper (R8 coverage) --------------

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

test("getRelayStatus awaits an async owner lookup (R8: a Promise owner must not leak into the payload)", async () => {
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

test("stopRelay kills an owner PID that arrives as a Promise (R8: filter must not drop it)", async () => {
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
