import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { isRetiredWatchdogCommand, retireAgentWatchdog } from "../src/ops/retire-agent-watchdog.mjs";

test("recognizes only prior Anyswitch source and packaged watchdog entry points", () => {
  const dataRoot = "C:/Users/test/AppData/Local/Anyswitch";
  const installRoot = "C:/Users/test/AppData/Local/Programs/Anyswitch";
  assert.equal(isRetiredWatchdogCommand('"node.exe" "C:/Users/test/AppData/Local/Anyswitch/app/src/agents/agent-watchdog.mjs"', dataRoot, installRoot), true);
  assert.equal(isRetiredWatchdogCommand('"node.exe" "C:/Users/test/AppData/Local/Programs/Anyswitch/versions/0.7.5/app/agent-watchdog.mjs"', dataRoot, installRoot), true);
  assert.equal(isRetiredWatchdogCommand('"node.exe" "C:/other/app/src/agents/agent-watchdog.mjs"', dataRoot, installRoot), false);
});

test("stops and clears only a process whose command belongs to the retired watchdog", async () => {
  const killed = [];
  let alive = true;
  let cleared = null;
  const result = await retireAgentWatchdog({
    dataRoot: "C:/data/Anyswitch",
    installRoot: "C:/Apps/Anyswitch",
    removeTasks: async () => true,
    findOwner: async () => 4321,
    readPid: () => 4321,
    isAlive: () => alive,
    commandLine: async () => '"node.exe" "C:/Apps/Anyswitch/versions/0.7.5/app/src/agents/agent-watchdog.mjs"',
    kill: (pid) => { killed.push(pid); alive = false; },
    clearPid: (path) => { cleared = path; },
    sleep: async () => {},
  });
  assert.equal(result, true);
  assert.deepEqual(killed, [4321]);
  assert.equal(cleared, join("C:/data/Anyswitch", "watchdog.pid"));
});

test("does not stop a foreign process using the watchdog marker port", async () => {
  const killed = [];
  let cleared = false;
  const result = await retireAgentWatchdog({
    dataRoot: "C:/data/Anyswitch",
    installRoot: "C:/Apps/Anyswitch",
    removeTasks: async () => true,
    findOwner: async () => 9876,
    readPid: () => null,
    isAlive: () => true,
    commandLine: async () => '"other.exe" "C:/Apps/Other/app.mjs"',
    kill: (pid) => killed.push(pid),
    clearPid: () => { cleared = true; },
  });
  assert.equal(result, true);
  assert.deepEqual(killed, []);
  assert.equal(cleared, true);
});

test("leaves watchdog files and processes untouched when task cleanup fails", async () => {
  let touched = false;
  const result = await retireAgentWatchdog({
    removeTasks: async () => false,
    findOwner: async () => { touched = true; return null; },
    clearPid: () => { touched = true; },
  });
  assert.equal(result, false);
  assert.equal(touched, false);
});
