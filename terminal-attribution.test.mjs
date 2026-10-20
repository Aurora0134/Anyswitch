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

  it("binds a claude terminal via the sessions rows (claude ships no instances)", () => {
    // The claude card only carries `sessions` ({ id: "claude-<pid>" }), never
    // `instances` — the existence index must read both buckets or every
    // claude attribution stays unbound.
    const out = attributeTerminalSessions(
      [baseSession],
      [{ agentId: "claude", pid: 4321, ancestors: [8888] }],
      [{ id: "claude", name: "Claude Code", sessions: [{ id: "claude-4321" }] }],
    );
    assert.deepEqual(out[0].agent, { endpointId: "claude", name: "Claude Code", pid: 4321, instanceId: "claude-4321" });
  });

  it("does not bind aggregate session rows (zcode-global and friends have no pid tail)", () => {
    const out = attributeTerminalSessions(
      [baseSession],
      [{ agentId: "zcode", pid: 4321, ancestors: [8888] }],
      [{ id: "zcode", name: "ZCode", sessions: [{ id: "zcode-global" }] }],
    );
    assert.deepEqual(out[0].agent, { endpointId: "zcode", name: "ZCode", pid: 4321, instanceId: null });
  });

  it("claude attribution stays unbound while the sessions bucket is absent", () => {
    const out = attributeTerminalSessions(
      [baseSession],
      [{ agentId: "claude", pid: 4321, ancestors: [8888] }],
      [{ id: "claude", name: "Claude Code" }],
    );
    assert.deepEqual(out[0].agent, { endpointId: "claude", name: "Claude Code", pid: 4321, instanceId: null });
  });

  it("attributes before instance binding (codex has no placeholder rows pre-traffic)", () => {
    const out = attributeTerminalSessions(
      [baseSession],
      [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
      [{ id: "codex", name: "Codex", instances: [] }],
    );
    assert.deepEqual(out[0].agent, { endpointId: "codex", name: "Codex", pid: 6100, instanceId: null });
  });

  describe("codex session bridge (session-granular instance ids)", () => {
    const codexAgents = (rows) => [{ id: "codex", name: "Codex", instances: rows.map((id) => ({ id })) }];
    const cwdSession = { ...baseSession, cwd: "D:\\dev\\bridge" };

    it("binds the latest same-cwd codex-sess row when the pid shape misses", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
        codexAgents(["codex-sess-old", "codex-sess-new", "codex-sess-other"]),
        { codex: [
          { id: "codex-sess-old", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: "codex-tui" },
          { id: "codex-sess-new", cwd: "d:/dev/bridge/", lastActive: 2000, originator: "codex-tui" },
          { id: "codex-sess-other", cwd: "E:\\elsewhere", lastActive: 3000, originator: "codex-tui" },
        ] },
      );
      assert.equal(out[0].agent.instanceId, "codex-sess-new",
        "cwd 匹配忽略大小写/分隔符/尾斜杠；别的目录不参与；取最近活跃");
    });

    it("excludes desktop-originated sessions from the bridge", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
        codexAgents(["codex-sess-tui", "codex-sess-desktop"]),
        { codex: [
          { id: "codex-sess-tui", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: "codex-tui" },
          { id: "codex-sess-desktop", cwd: "D:\\dev\\bridge", lastActive: 9000, originator: "codex_work_desktop" },
        ] },
      );
      assert.equal(out[0].agent.instanceId, "codex-sess-tui",
        "桌面 GUI 会话更近也不能抢走终端会话的绑定");
    });

    it("bridge only binds rows present in the agents payload", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
        codexAgents([]),
        [{ id: "codex-sess-x", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: "codex-tui" }],
      );
      assert.equal(out[0].agent.instanceId, null, "行不存在不绑，与 pid 路同一判据");
    });

    it("cwd mismatch or missing cwd stays unbound", () => {
      for (const session of [{ ...baseSession, cwd: "E:\\elsewhere" }, { ...baseSession }]) {
        const out = attributeTerminalSessions(
          [session],
          [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
          codexAgents(["codex-sess-x"]),
          [{ id: "codex-sess-x", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: "codex-tui" }],
        );
        assert.equal(out[0].agent.instanceId, null);
      }
    });

    it("pid-shaped row wins over the bridge when it exists", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
        codexAgents(["codex-6100", "codex-sess-x"]),
        [{ id: "codex-sess-x", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: "codex-tui" }],
      );
      assert.equal(out[0].agent.instanceId, "codex-6100", "进程形状仍是第一优先");
    });

    it("non-codex endpoints never consult the bridge feed", () => {
      const out = attributeTerminalSessions(
        [{ ...baseSession, cwd: "D:\\dev\\bridge" }],
        [{ agentId: "kimi", pid: 4321, ancestors: [8888] }],
        [{ id: "kimi", name: "Kimi Code", instances: [] }],
        [{ id: "codex-sess-x", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: "codex-tui" }],
      );
      assert.equal(out[0].agent.instanceId, null);
    });

    it("ties on lastActive resolve deterministically by id", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
        codexAgents(["codex-sess-a", "codex-sess-b"]),
        { codex: [
          { id: "codex-sess-b", cwd: "D:\\dev\\bridge", lastActive: 500, originator: "codex-tui" },
          { id: "codex-sess-a", cwd: "D:\\dev\\bridge", lastActive: 500, originator: "codex-tui" },
        ] },
      );
      assert.equal(out[0].agent.instanceId, "codex-sess-a");
    });
  });

  describe("opencode session bridge (session-granular instance ids)", () => {
    const ocAgents = (rows) => [{ id: "opencode", name: "OpenCode", instances: rows.map((id) => ({ id })) }];
    const cwdSession = { ...baseSession, cwd: "C:\\Users\\t\\proj" };
    // opencode 2.x: every TUI's traffic leaves through one resident
    // `serve --service` process, so the shell's ancestor chain never reaches a
    // row that could name the conversation. The session feed is the bridge.
    const detected = [{ agentId: "opencode", pid: 2960, ancestors: [8888] }];

    it("binds the latest same-cwd opencode-sess row when the pid shape misses", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        detected,
        ocAgents(["opencode-sess-old", "opencode-sess-new", "opencode-sess-other"]),
        { opencode: [
          { id: "opencode-sess-old", cwd: "C:\\Users\\t\\proj", lastActive: 1000 },
          { id: "opencode-sess-new", cwd: "c:/users/t/proj/", lastActive: 2000 },
          { id: "opencode-sess-other", cwd: "E:\\elsewhere", lastActive: 3000 },
        ] },
      );
      assert.equal(out[0].agent.instanceId, "opencode-sess-new",
        "cwd 匹配忽略大小写/分隔符/尾斜杠；别的目录不参与；取最近活跃");
    });

    it("prefers the bridged session row over the resident-service pid row", () => {
      // opencode 的 pid 行是常驻服务的占位/杂流归属，会话的请求永远不落在它
      // 上；终端右栏按 instanceId 取数，绑到 pid 行就是一条恒 0 的空行。
      const out = attributeTerminalSessions(
        [cwdSession],
        detected,
        ocAgents(["opencode-2960", "opencode-sess-real"]),
        { opencode: [{ id: "opencode-sess-real", cwd: "C:\\Users\\t\\proj", lastActive: 1000 }] },
      );
      assert.equal(out[0].agent.instanceId, "opencode-sess-real");
      assert.equal(out[0].agent.pid, 2960, "进程归属本身不变");
    });

    it("an opencode feed never binds a codex terminal (feeds are per endpoint)", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
        [{ id: "codex", name: "Codex", instances: [{ id: "codex-sess-x" }] }],
        { opencode: [{ id: "codex-sess-x", cwd: "C:\\Users\\t\\proj", lastActive: 1000 }] },
      );
      assert.equal(out[0].agent.instanceId, null, "feed 只在自家端点的行集里挑");
    });

    it("opencode rows that are not in the agents payload stay unbound", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        detected,
        ocAgents([]),
        { opencode: [{ id: "opencode-sess-x", cwd: "C:\\Users\\t\\proj", lastActive: 1000 }] },
      );
      assert.equal(out[0].agent.instanceId, null);
    });

    it("old relays without the feed still attribute the process, just unbound", () => {
      const out = attributeTerminalSessions([cwdSession], detected, ocAgents(["opencode-2960"]));
      assert.deepEqual(out[0].agent, {
        endpointId: "opencode",
        name: "OpenCode",
        pid: 2960,
        instanceId: "opencode-2960",
      });
    });
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
