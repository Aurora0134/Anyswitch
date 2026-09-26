// terminal-process-manager unit tests: discovery-only ensureTerminalHost and
// the one-time stopStaleTerminalHost migration sweep. Every boundary (port
// owner lookup, liveness, command line query, taskkill) is injected — no real
// process is spawned or killed, and no real port is probed.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ensureTerminalHost,
  stopStaleTerminalHost,
  getTerminalHostPidPath,
  TERMINAL_HOST_PORT,
} from "./terminal-process-manager.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

const APP_DIR = fileURLToPath(new URL(".", import.meta.url));

function ownCommandLine() {
  return `"C:\\Program Files\\nodejs\\node.exe" "${APP_DIR}terminal-host.mjs"`;
}

function makeDeps({ ownerPid = null, alive = [], commandLines = {} } = {}) {
  const aliveSet = new Set(alive);
  const killed = [];
  return {
    killed,
    findPortOwnerPid: async () => ownerPid,
    isPidAlive: (pid) => aliveSet.has(pid),
    getProcessCommandLine: (pid) => commandLines[pid] ?? null,
    terminatePid: (pid) => {
      killed.push(pid);
      aliveSet.delete(pid);
    },
    delay: async () => {},
  };
}

test("ensureTerminalHost discovers a serving backend and never spawns", async () => {
  const root = mkTestDir("anyswitch-tpm-");
  const result = await ensureTerminalHost(root, { probeFn: async () => true });
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.port, TERMINAL_HOST_PORT);
  assert.equal(existsSync(getTerminalHostPidPath(root)), false, "discovery mode never writes a pid file");
});

test("ensureTerminalHost reports relay-required instead of spawning when the port is dead", async () => {
  const root = mkTestDir("anyswitch-tpm-");
  const result = await ensureTerminalHost(root, { probeFn: async () => false });
  assert.equal(result.ok, false);
  assert.equal(result.reused, false);
  assert.match(result.reason, /starts and stops with the relay/);
  assert.equal(existsSync(getTerminalHostPidPath(root)), false, "a dead backend must not leave a pid file behind");
});

test("stopStaleTerminalHost kills an own port owner and clears the legacy pid file", async () => {
  const root = mkTestDir("anyswitch-tpm-");
  writeFileSync(getTerminalHostPidPath(root), "2384", "utf8");
  const deps = makeDeps({
    ownerPid: 2384,
    alive: [2384],
    commandLines: { 2384: ownCommandLine() },
  });

  const result = await stopStaleTerminalHost(root, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.killed, [2384]);
  assert.equal(existsSync(getTerminalHostPidPath(root)), false, "the legacy pid file does not survive the sweep");
});

test("stopStaleTerminalHost kills a pid-file survivor that no longer owns the port", async () => {
  const root = mkTestDir("anyswitch-tpm-");
  writeFileSync(getTerminalHostPidPath(root), "4001", "utf8");
  // 47823 is free (ownerPid null) but a detached terminal host from an old
  // build lingers on another machine state — the pid file is the only lead.
  const deps = makeDeps({
    ownerPid: null,
    alive: [4001],
    commandLines: { 4001: ownCommandLine() },
  });

  const result = await stopStaleTerminalHost(root, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.killed, [4001]);
});

test("stopStaleTerminalHost refuses a foreign port owner and reports why", async () => {
  const root = mkTestDir("anyswitch-tpm-");
  const deps = makeDeps({
    ownerPid: 777,
    alive: [777],
    commandLines: { 777: `"C:\\other\\tool\\server.exe" --port ${TERMINAL_HOST_PORT}` },
  });

  const result = await stopStaleTerminalHost(root, deps);
  assert.equal(result.ok, false);
  assert.deepEqual(result.killed, [], "a foreign process is never taskkilled");
  assert.deepEqual(result.refused, [777]);
  assert.match(result.reason, /refused to kill PID 777/);
  assert.match(result.reason, /does not identify it as an Anyswitch app process/);
});

test("stopStaleTerminalHost refuses when the command line cannot be queried", async () => {
  const root = mkTestDir("anyswitch-tpm-");
  writeFileSync(getTerminalHostPidPath(root), "900", "utf8");
  const deps = makeDeps({ ownerPid: 900, alive: [900], commandLines: {} }); // null = cannot verify

  const result = await stopStaleTerminalHost(root, deps);
  assert.equal(result.ok, false);
  assert.deepEqual(result.killed, [], "unverifiable identity fails safe — no kill");
  assert.deepEqual(result.refused, [900]);
});

test("stopStaleTerminalHost skips dead candidates without calling it a refusal", async () => {
  const root = mkTestDir("anyswitch-tpm-");
  writeFileSync(getTerminalHostPidPath(root), "555", "utf8");
  const deps = makeDeps({ ownerPid: 555, alive: [] }); // both leads point at a dead pid

  const result = await stopStaleTerminalHost(root, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.killed, []);
  assert.deepEqual(result.refused, []);
  assert.equal(existsSync(getTerminalHostPidPath(root)), false, "a stale pid file is still swept");
});

test("stopStaleTerminalHost dedupes a pid that appears as both file pid and port owner", async () => {
  const root = mkTestDir("anyswitch-tpm-");
  writeFileSync(getTerminalHostPidPath(root), "881", "utf8");
  const deps = makeDeps({
    ownerPid: 881,
    alive: [881],
    commandLines: { 881: ownCommandLine() },
  });

  const result = await stopStaleTerminalHost(root, deps);
  assert.deepEqual(deps.killed, [881], "taskkill runs exactly once per candidate");
  assert.deepEqual(result.killed, [881]);
});

test("stopStaleTerminalHost with nothing around is a clean no-op", async () => {
  const root = mkTestDir("anyswitch-tpm-");
  const deps = makeDeps({ ownerPid: null, alive: [] });

  const result = await stopStaleTerminalHost(root, deps);
  assert.deepEqual(result, { ok: true, killed: [], refused: [] });
  assert.equal(deps.killed.length, 0);
});
