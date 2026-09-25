import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attributeTerminalSessions, filterTerminalRequestRows } from "./terminal-attribution.mjs";

// 终端归属 join 的纯函数合同：shell pid 出现在检测进程祖先链即归属；
// instanceId 只在 agents 负载里存在同名实例行时才绑定（codex 无占位行
// 时归属先落在「检测到」层）。
describe("attributeTerminalSessions", () => {
  const baseSession = { id: "t1", label: "新终端", shell: "powershell", pid: 8888, status: "running" };

  it("no detected processes (null / empty) passes sessions through unannotated", () => {
    const sessions = [baseSession];
    for (const detected of [null, [], "junk"]) {
      const out = attributeTerminalSessions(sessions, detected, []);
      assert.equal(out.length, 1);
      assert.equal(out[0].agent, undefined);
    }
  });

  it("attributes a session whose shell pid is a direct parent of a client process", () => {
    const out = attributeTerminalSessions(
      [baseSession],
      [{ agentId: "kimi", pid: 4321, ancestors: [8888, 9000] }],
      [{ id: "kimi", name: "Kimi Code", instances: [{ id: "kimi-4321" }] }],
    );
    assert.deepEqual(out[0].agent, { endpointId: "kimi", name: "Kimi Code", pid: 4321, instanceId: "kimi-4321" });
    assert.equal(baseSession.agent, undefined, "input sessions are never mutated");
  });

  it("crosses intermediate hops (launcher wrappers, cmd shims) by ancestor chain distance", () => {
    const out = attributeTerminalSessions(
      [baseSession],
      [{ agentId: "codex", pid: 6100, ancestors: [7777, 8888, 1] }],
      [{ id: "codex", name: "Codex", instances: [{ id: "codex-6100" }] }],
    );
    assert.equal(out[0].agent.endpointId, "codex");
  });

  it("picks the nearest client when several agents hang under one shell", () => {
    const out = attributeTerminalSessions(
      [baseSession],
      [
        { agentId: "codex", pid: 6100, ancestors: [7777, 8888] },
        { agentId: "kimi", pid: 4321, ancestors: [8888] },
      ],
      [{ id: "kimi", name: "Kimi Code", instances: [] }, { id: "codex", name: "Codex", instances: [] }],
    );
    assert.equal(out[0].agent.endpointId, "kimi", "distance 1 beats distance 2");
  });

  it("attributes before instance binding (codex has no placeholder rows pre-traffic)", () => {
    const out = attributeTerminalSessions(
      [baseSession],
      [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
      [{ id: "codex", name: "Codex", instances: [] }],
    );
    assert.deepEqual(out[0].agent, { endpointId: "codex", name: "Codex", pid: 6100, instanceId: null });
  });

  it("falls back when the agents payload is absent (relay restart窗口)", () => {
    const out = attributeTerminalSessions(
      [baseSession],
      [{ agentId: "kimi", pid: 4321, ancestors: [8888] }],
      null,
    );
    assert.deepEqual(out[0].agent, { endpointId: "kimi", name: "kimi", pid: 4321, instanceId: null });
  });

  it("leaves sessions without a numeric shell pid untouched", () => {
    const out = attributeTerminalSessions(
      [{ id: "t2", label: "旧会话", pid: null, status: "exited" }],
      [{ agentId: "kimi", pid: 4321, ancestors: [8888] }],
      [],
    );
    assert.equal(out[0].agent, undefined);
  });

  it("ignores malformed detected entries (no pid, no ancestors, empty chain)", () => {
    const out = attributeTerminalSessions(
      [baseSession],
      [
        { agentId: "kimi", pid: "nope", ancestors: [8888] },
        { agentId: "kimi", pid: 4321 },
        { agentId: "kimi", pid: 4322, ancestors: [] },
        { pid: 4323, ancestors: [8888] },
      ],
      [],
    );
    assert.equal(out[0].agent, undefined);
  });
});

describe("filterTerminalRequestRows", () => {
  const rows = [
    { ts: 1, agentId: "kimi", instanceId: "kimi-4321", model: "m1", ok: true },
    { ts: 2, agentId: "codex", instanceId: "codex-6100", model: "m2", ok: false },
    { ts: 3, agentId: "kimi", instanceId: "kimi-9999", model: "m3", ok: true },
    { ts: 4, agentId: "kimi", model: "m4", ok: true }, // 无实例声明的历史行
    { ts: 5, agentId: "kimi", instanceId: "kimi-4321", model: "m5", ok: true },
  ];

  it("strict instanceId filter, newest-first", () => {
    const out = filterTerminalRequestRows(rows, { agentId: "kimi", instanceId: "kimi-4321" });
    assert.deepEqual(out.map((r) => r.ts), [5, 1]);
  });

  it("rows without instanceId never match a bound instance", () => {
    const out = filterTerminalRequestRows(rows, { agentId: "kimi", instanceId: "kimi-4321" });
    assert.equal(out.some((r) => r.ts === 4), false);
  });

  it("unbound query returns the endpoint's rows, newest-first", () => {
    const out = filterTerminalRequestRows(rows, { agentId: "kimi" });
    assert.deepEqual(out.map((r) => r.ts), [5, 4, 3, 1]);
  });

  it("honours the limit over the tail, not the head", () => {
    const long = Array.from({ length: 15 }, (_, i) => ({ ts: i, agentId: "kimi", instanceId: "kimi-1" }));
    const out = filterTerminalRequestRows(long, { agentId: "kimi", instanceId: "kimi-1" });
    assert.equal(out.length, 10);
    assert.equal(out[0].ts, 14);
    assert.equal(out[9].ts, 5);
  });

  it("missing agentId returns nothing", () => {
    assert.deepEqual(filterTerminalRequestRows(rows, {}), []);
    assert.deepEqual(filterTerminalRequestRows(rows, { agentId: "" }), []);
    assert.deepEqual(filterTerminalRequestRows(null, { agentId: "kimi" }), []);
  });
});
