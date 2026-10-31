import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAgentWatcher } from "./agent-watcher.mjs";

// followAgent 的 anyAgent 求和必须把 WorkBuddy 算进去（plan §3.3-5）：只开
// WorkBuddy 时 relay 也要被拉起，否则用户以为「跟随启动」坏了。
describe("follow-agent watcher 的 anyAgent 求和", () => {
  function makeWatcher(procs, calls) {
    return createAgentWatcher({
      root: "C:/tmp/anyswitch-watcher-test",
      loadSettings: () => ({ settings: { followAgent: true } }),
      scanProcesses: async () => procs,
      getRelayStatus: async () => ({ status: "down" }),
      startRelay: async () => { calls.push("start"); },
      restartRelay: async () => { calls.push("restart"); },
      now: () => 1000,
      logger: { info() {}, warn() {}, error() {} },
    });
  }

  it("only WorkBuddy running is enough to auto-start the relay", async () => {
    const calls = [];
    await makeWatcher({ workbuddy: 2 }, calls).tick();
    assert.deepEqual(calls, ["start"]);
  });

  it("no agent running leaves the relay alone", async () => {
    const calls = [];
    await makeWatcher({ workbuddy: 0, grok: 0 }, calls).tick();
    assert.deepEqual(calls, []);
  });
});
