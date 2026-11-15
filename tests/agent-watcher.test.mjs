import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAgentWatcher } from "../src/agents/agent-watcher.mjs";

// followAgent 的 anyAgent 求和必须把 WorkBuddy 算进去，只开
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

  // 求和的十个键逐键钉住。只钉 WorkBuddy 时，任何一项从求和里消失（实现退化、
  // 端点改名、键拼写漂移）都不会红——只在那个端点跑的机器上 followAgent 静默
  // 失灵：agent 明明在跑，relay 却不被拉起。键集与 src/agents/agent-watcher.mjs
  // 的 anyAgent 求和一一对应，多出/漏掉的键都在这里爆红。
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
});
