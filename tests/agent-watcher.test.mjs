import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAgentWatcher } from "../src/agents/agent-watcher.mjs";

// followAgent 的 anyAgent 求和必须把 WorkBuddy 算进去，只开
// WorkBuddy 时 relay 也要被拉起，否则用户以为「跟随启动」坏了。
describe("follow-agent watcher 的 anyAgent 求和", () => {
  function makeWatcher(procs, calls, status = "stopped") {
    return createAgentWatcher({
      root: "C:/tmp/anyswitch-watcher-test",
      loadSettings: () => ({ settings: { followAgent: true } }),
      scanProcesses: async () => procs,
      getRelayStatus: async () => ({ status }),
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

  // 求和的十个键逐键钉住。只钉 WorkBuddy 时，任何一项从求和里消失（实现退化、
  // 端点改名、键拼写漂移）都不会红——只在那个端点跑的机器上 followAgent 静默
  // 失灵：agent 明明在跑，relay 却不被拉起。守卫只对表内键成立：表里的键从
  // 求和里消失（源码删键/改名，或表里多写求和不认的键）必在这里红；源码将来
  // 新增第 11 个键时本表不会自动跟进，那个方向要靠手工补行。
  it("each of the ten endpoint keys alone is enough to auto-start the relay", async () => {
    for (const key of ["zcode", "claude", "opencode", "dsh", "pi", "kimi", "qoder", "codex", "grok", "workbuddy"]) {
      const calls = [];
      await makeWatcher({ [key]: 1 }, calls).tick();
      assert.deepEqual(calls, ["start"], `只有 ${key} 在跑时也必须自动拉起 relay`);
    }
  });

  it("no agent running leaves the relay alone", async () => {
    const calls = [];
    await makeWatcher({ workbuddy: 0, grok: 0 }, calls).tick();
    assert.deepEqual(calls, []);
  });

  it("waits when Relay is starting or its state cannot be confirmed", async () => {
    for (const status of ["starting", "unknown"]) {
      const calls = [];
      await makeWatcher({ workbuddy: 1 }, calls, status).tick();
      assert.deepEqual(calls, [], status);
    }
  });
});
