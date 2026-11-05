import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attributeTerminalSessions, filterTerminalRequestRows } from "../src/terminal/terminal-attribution.mjs";

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
    assert.deepEqual(out[0].agent, { endpointId: "kimi", name: "Kimi Code", pid: 4321, instanceId: "kimi-4321", busy: null });
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
    assert.deepEqual(out[0].agent, { endpointId: "claude", name: "Claude Code", pid: 4321, instanceId: "claude-4321", busy: null });
  });

  it("does not bind aggregate session rows (zcode-global and friends have no pid tail)", () => {
    const out = attributeTerminalSessions(
      [baseSession],
      [{ agentId: "zcode", pid: 4321, ancestors: [8888] }],
      [{ id: "zcode", name: "ZCode", sessions: [{ id: "zcode-global" }] }],
    );
    assert.deepEqual(out[0].agent, { endpointId: "zcode", name: "ZCode", pid: 4321, instanceId: null, busy: null });
  });

  it("claude attribution stays unbound while the sessions bucket is absent", () => {
    const out = attributeTerminalSessions(
      [baseSession],
      [{ agentId: "claude", pid: 4321, ancestors: [8888] }],
      [{ id: "claude", name: "Claude Code" }],
    );
    assert.deepEqual(out[0].agent, { endpointId: "claude", name: "Claude Code", pid: 4321, instanceId: null, busy: null });
  });

  it("attributes before instance binding (codex has no placeholder rows pre-traffic)", () => {
    const out = attributeTerminalSessions(
      [baseSession],
      [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
      [{ id: "codex", name: "Codex", instances: [] }],
    );
    assert.deepEqual(out[0].agent, { endpointId: "codex", name: "Codex", pid: 6100, instanceId: null, busy: null });
  });

  // 进程树忙判据随归属下发：relay 用切换守卫同一个谓词算「这个 agent 的进程树里
  // 有没有正在执行的命令」，挂到 detected 条目上，这里原样搬到 session.agent.busy。
  // 面板的 working 口径靠它看见「回合已结束、agent 留下的子进程还在跑」——否则面板
  // 判空闲而内切杀前探测拒换，前端静默新开页签（2026-10-28 实机复现）。
  describe("command-running verdict (agent.busy)", () => {
    const withBusy = (busy) => [{ agentId: "kimi", pid: 4321, ancestors: [8888], busy }];

    it("carries a true verdict through to the session", () => {
      const out = attributeTerminalSessions(
        [baseSession],
        withBusy(true),
        [{ id: "kimi", name: "Kimi Code", instances: [{ id: "kimi-4321" }] }],
      );
      assert.equal(out[0].agent.busy, true, "树里有活命令");
    });

    it("carries false and null through without guessing", () => {
      for (const verdict of [false, null]) {
        const out = attributeTerminalSessions(
          [baseSession],
          withBusy(verdict),
          [{ id: "kimi", name: "Kimi Code", instances: [{ id: "kimi-4321" }] }],
        );
        assert.equal(out[0].agent.busy, verdict, `判据 ${verdict} 原样下发`);
      }
    });

    it("an older relay that omits the field still attributes, busy stays null", () => {
      const out = attributeTerminalSessions(
        [baseSession],
        [{ agentId: "kimi", pid: 4321, ancestors: [8888] }],
        [{ id: "kimi", name: "Kimi Code", instances: [{ id: "kimi-4321" }] }],
      );
      assert.equal(out[0].agent.busy, null, "老 relay 没有这一位：按未判处理，不猜");
    });
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
        { codex: [{ id: "codex-sess-x", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: "codex-tui" }] },
      );
      assert.equal(out[0].agent.instanceId, null, "行不存在不绑，与 pid 路同一判据");
    });

    it("cwd mismatch or missing cwd stays unbound", () => {
      for (const session of [{ ...baseSession, cwd: "E:\\elsewhere" }, { ...baseSession }]) {
        const out = attributeTerminalSessions(
          [session],
          [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
          codexAgents(["codex-sess-x"]),
          { codex: [{ id: "codex-sess-x", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: "codex-tui" }] },
        );
        assert.equal(out[0].agent.instanceId, null);
      }
    });

    it("pid-shaped row wins over the bridge when it exists", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
        codexAgents(["codex-6100", "codex-sess-x"]),
        { codex: [{ id: "codex-sess-x", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: "codex-tui" }] },
      );
      assert.equal(out[0].agent.instanceId, "codex-6100", "进程形状仍是第一优先");
    });

    it("non-codex endpoints never consult the bridge feed", () => {
      // 行在 agents 负载里存在、cwd 也匹配：kimi 若误拿 codex 的 feed 就会绑上
      // codex-sess-x，唯一拦住它的是 feeds 按 best.agentId 取键（kimi 不在会话
      // 桥名单里），这里把那一步真正钉住。
      const out = attributeTerminalSessions(
        [{ ...baseSession, cwd: "D:\\dev\\bridge" }],
        [{ agentId: "kimi", pid: 4321, ancestors: [8888] }],
        [
          { id: "kimi", name: "Kimi Code", instances: [] },
          { id: "codex", name: "Codex", instances: [{ id: "codex-sess-x" }] },
        ],
        { codex: [{ id: "codex-sess-x", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: "codex-tui" }] },
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
      // 两个 TUI 在跑时不按活跃猜（另一个终端的 TUI 也可能在别处干活），维持 cwd 匹配。
      const twoTuis = [...detected, { agentId: "opencode", pid: 7777, ancestors: [4444] }];
      const out = attributeTerminalSessions(
        [cwdSession],
        twoTuis,
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

    it("binds the latest-active row when the sole TUI works outside the shell cwd", () => {
      // opencode 2.1.x 的 TUI 可以显示任意项目里的会话（项目切换 / 恢复上次
      // 项目），会话目录不必等于终端启动目录——真机取证 2026-10-27：终端启动
      // 目录 C:\Users\me\Desktop\work，TUI 正在干活的项目却是另一个 worktree。
      // 机器上只有这一个 opencode 交互进程时，全部会话行都归它所有，「最近活跃」
      // 就是它正在显示的那一个。
      const out = attributeTerminalSessions(
        [cwdSession],
        detected,
        ocAgents(["opencode-sess-here", "opencode-sess-worktree"]),
        { opencode: [
          { id: "opencode-sess-here", cwd: "C:\\Users\\t\\proj", lastActive: 1000 },
          { id: "opencode-sess-worktree", cwd: "C:\\Anyswitch-worktrees\\wt", lastActive: 3000 },
        ] },
      );
      assert.equal(out[0].agent.instanceId, "opencode-sess-worktree");
      assert.equal(out[0].agent.pid, 2960, "进程归属本身不变");
    });

    it("sole-TUI recency beats a stale same-cwd row (TUI switched projects)", () => {
      // 启动目录里那条旧会话行还在负载里（未过空闲 TTL），但 TUI 早已切到别处
      // 干活：按 cwd 匹配会绑到一条停滞指标上，右栏显示的是别人项目的旧账。
      const out = attributeTerminalSessions(
        [cwdSession],
        detected,
        ocAgents(["opencode-sess-stale", "opencode-sess-active"]),
        { opencode: [
          { id: "opencode-sess-stale", cwd: "C:\\Users\\t\\proj", lastActive: 1000 },
          { id: "opencode-sess-active", cwd: "D:\\other-project", lastActive: 5000 },
        ] },
      );
      assert.equal(out[0].agent.instanceId, "opencode-sess-active");
    });

    it("sole-TUI recency only binds rows that exist in the agents payload", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        detected,
        ocAgents(["opencode-sess-live"]),
        { opencode: [
          { id: "opencode-sess-dead", cwd: "C:\\Users\\t\\proj", lastActive: 9000 },
          { id: "opencode-sess-live", cwd: "E:\\elsewhere", lastActive: 100 },
        ] },
      );
      assert.equal(out[0].agent.instanceId, "opencode-sess-live",
        "过了空闲 TTL 的行不在负载里，绑上去右栏也取不到数");
    });

    it("sole TUI with no live session row falls back to the pid row", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        detected,
        ocAgents(["opencode-2960"]),
        { opencode: [{ id: "opencode-sess-dead", cwd: "C:\\Users\\t\\proj", lastActive: 9000 }] },
      );
      assert.equal(out[0].agent.instanceId, "opencode-2960");
    });

    it("does not bind another terminal's TUI row when a second TUI is running", () => {
      // 另一个终端也开着 opencode（在别的目录干活）：本终端 cwd 匹配不到任何
      // 行时保持未绑定，不猜——抢过来右栏显示的就是别人终端的会话。
      const twoTuis = [...detected, { agentId: "opencode", pid: 7777, ancestors: [4444] }];
      const out = attributeTerminalSessions(
        [cwdSession],
        twoTuis,
        ocAgents(["opencode-sess-elsewhere"]),
        { opencode: [{ id: "opencode-sess-elsewhere", cwd: "E:\\elsewhere", lastActive: 3000 }] },
      );
      assert.equal(out[0].agent.instanceId, null);
    });

    it("two TUIs under one shell still bind the latest-active row", () => {
      const twoUnderOneShell = [
        { agentId: "opencode", pid: 2960, ancestors: [8888] },
        { agentId: "opencode", pid: 2961, ancestors: [8888] },
      ];
      const out = attributeTerminalSessions(
        [cwdSession],
        twoUnderOneShell,
        ocAgents(["opencode-sess-a", "opencode-sess-b"]),
        { opencode: [
          { id: "opencode-sess-a", cwd: "C:\\Users\\t\\proj", lastActive: 1000 },
          { id: "opencode-sess-b", cwd: "C:\\Users\\t\\proj", lastActive: 2000 },
        ] },
      );
      assert.equal(out[0].agent.instanceId, "opencode-sess-b");
    });

    it("a non-opencode terminal never triggers the recency fallback", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        [{ agentId: "claude", pid: 6100, ancestors: [8888] }],
        [{ id: "claude", name: "Claude Code", sessions: [{ id: "claude-777" }] }],
        { opencode: [{ id: "opencode-sess-x", cwd: "E:\\elsewhere", lastActive: 3000 }] },
      );
      assert.deepEqual(out[0].agent, {
        endpointId: "claude",
        name: "Claude Code",
        pid: 6100,
        instanceId: null,
        busy: null,
      }, "feed 只在自家端点的行集里挑，别的端点连猜都不猜");
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
        busy: null,
      });
    });
  });

  it("falls back when the agents payload is absent (relay restart窗口)", () => {
    const out = attributeTerminalSessions(
      [baseSession],
      [{ agentId: "kimi", pid: 4321, ancestors: [8888] }],
      null,
    );
    assert.deepEqual(out[0].agent, { endpointId: "kimi", name: "kimi", pid: 4321, instanceId: null, busy: null });
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

  // WB 的实例行已是会话粒度（workbuddy-sess-<sessionId>，runtime 池化换 pid 不
  // 换行），pid 形 socket 兜底行对不上——终端归属要靠会话 feed 桥，与 codex/
  // opencode 同形。
  describe("workbuddy session bridge (session-granular instance ids)", () => {
    const wbAgents = (rows) => [{ id: "workbuddy", name: "WorkBuddy", instances: rows.map((id) => ({ id })) }];
    const cwdSession = { ...baseSession, cwd: "D:\\dev\\bridge" };
    const detected = [{ agentId: "workbuddy", pid: 5120, ancestors: [8888] }];

    it("binds the latest same-cwd workbuddy-sess row when the pid shape misses", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        detected,
        wbAgents(["workbuddy-sess-old", "workbuddy-sess-new", "workbuddy-sess-other"]),
        { workbuddy: [
          { id: "workbuddy-sess-old", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: null },
          { id: "workbuddy-sess-new", cwd: "d:/dev/bridge/", lastActive: 2000, originator: null },
          { id: "workbuddy-sess-other", cwd: "E:\\elsewhere", lastActive: 3000, originator: null },
        ] },
      );
      assert.equal(out[0].agent.instanceId, "workbuddy-sess-new",
        "cwd 匹配忽略大小写/分隔符/尾斜杠；别的目录不参与；取最近活跃");
    });

    it("the session row wins over a pid-shaped row (the pid names a runtime, not a conversation)", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        detected,
        wbAgents(["workbuddy-5120", "workbuddy-sess-x"]),
        { workbuddy: [{ id: "workbuddy-sess-x", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: null }] },
      );
      assert.equal(out[0].agent.instanceId, "workbuddy-sess-x",
        "runtime 是池化的：pid 行只说「某个 runtime 进程」，会话行才说「哪条对话」");
    });

    it("excludes desktop-originated sessions from the bridge", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        detected,
        wbAgents(["workbuddy-sess-tui", "workbuddy-sess-desktop"]),
        { workbuddy: [
          { id: "workbuddy-sess-tui", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: null },
          { id: "workbuddy-sess-desktop", cwd: "D:\\dev\\bridge", lastActive: 9000, originator: "desktop" },
        ] },
      );
      assert.equal(out[0].agent.instanceId, "workbuddy-sess-tui",
        "桌面 GUI 会话更近也不能抢走终端会话的绑定");
    });

    it("bridge only binds rows present in the agents payload", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        detected,
        wbAgents([]),
        { workbuddy: [{ id: "workbuddy-sess-x", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: null }] },
      );
      assert.equal(out[0].agent.instanceId, null, "行不存在不绑，与 pid 路同一判据");
    });

    it("an old relay without the workbuddy feed still attributes by pid", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        detected,
        wbAgents(["workbuddy-5120"]),
        { codex: [], opencode: [] },
      );
      assert.equal(out[0].agent.instanceId, "workbuddy-5120", "没有会话 feed 时回落 pid 形行");
      assert.equal(out[0].agent.pid, 5120);
    });
  });

  // zcode 的实例行全是会话粒度（zcode-sess-<id>，relay 按请求头 x-session-id
  // 铸行）；它不进 socket 兜底白名单，pid 形行从不存在——没有 feed 时没有
  // 任何东西可退，归属停在「检测到」层。
  describe("zcode session bridge (session-granular instance ids)", () => {
    const zcAgents = (rows) => [{ id: "zcode", name: "ZCode", instances: rows.map((id) => ({ id })) }];
    const cwdSession = { ...baseSession, cwd: "D:\\dev\\bridge" };
    const detected = [{ agentId: "zcode", pid: 6400, ancestors: [8888] }];

    it("binds the same-cwd zcode-sess row when it is the only match", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        detected,
        zcAgents(["zcode-sess-new", "zcode-sess-other"]),
        { zcode: [
          { id: "zcode-sess-new", cwd: "d:/dev/bridge/", lastActive: 2000, originator: null },
          { id: "zcode-sess-other", cwd: "E:\\elsewhere", lastActive: 3000, originator: null },
        ] },
      );
      assert.equal(out[0].agent.instanceId, "zcode-sess-new",
        "cwd 匹配忽略大小写/分隔符/尾斜杠；别的目录不参与");
    });

    it("two same-cwd rows are ambiguous and stay unbound", () => {
      // 修前按 lastActive 猜最近一条；现在多行同 cwd 就是判不准，不绑。
      const out = attributeTerminalSessions(
        [cwdSession],
        detected,
        zcAgents(["zcode-sess-old", "zcode-sess-new"]),
        { zcode: [
          { id: "zcode-sess-old", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: null },
          { id: "zcode-sess-new", cwd: "d:/dev/bridge/", lastActive: 2000, originator: null },
        ] },
      );
      assert.equal(out[0].agent.instanceId, null);
    });

    it("excludes desktop-originated sessions from the bridge", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        detected,
        zcAgents(["zcode-sess-cli", "zcode-sess-desktop"]),
        { zcode: [
          { id: "zcode-sess-cli", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: null },
          { id: "zcode-sess-desktop", cwd: "D:\\dev\\bridge", lastActive: 9000, originator: "desktop" },
        ] },
      );
      assert.equal(out[0].agent.instanceId, "zcode-sess-cli",
        "桌面 GUI 会话更近也不能抢走终端会话的绑定");
    });

    it("bridge only binds rows present in the agents payload", () => {
      const out = attributeTerminalSessions(
        [cwdSession],
        detected,
        zcAgents([]),
        { zcode: [{ id: "zcode-sess-x", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: null }] },
      );
      assert.equal(out[0].agent.instanceId, null, "行不存在不绑，与 pid 路同一判据");
    });

    it("an old relay without the zcode feed attributes but stays unbound", () => {
      const out = attributeTerminalSessions([cwdSession], detected, zcAgents(["zcode-sess-x"]));
      assert.deepEqual(out[0].agent, {
        endpointId: "zcode",
        name: "ZCode",
        pid: 6400,
        instanceId: null,
        busy: null,
      }, "没有 pid 形行可退：无 feed 即无绑定");
    });

    it("the busy verdict rides through a feed-bound zcode session", () => {
      // 多报/少报闭环的另一半：归属打通后 busy 透传不该有额外门槛——它只挂在
      // detected 条目上，与实例行走哪座桥无关。
      const out = attributeTerminalSessions(
        [cwdSession],
        [{ agentId: "zcode", pid: 6400, ancestors: [8888], busy: true }],
        zcAgents(["zcode-sess-x"]),
        { zcode: [{ id: "zcode-sess-x", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: null }] },
      );
      assert.equal(out[0].agent.instanceId, "zcode-sess-x");
      assert.equal(out[0].agent.busy, true);
    });
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
    // 精确结果集已蕴含「无 instanceId 的行（ts=4）不参与 bound 匹配」；
    // unbound 查询那侧由下一条用例覆盖它仍被返回。
    assert.deepEqual(out.map((r) => r.ts), [5, 1]);
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

  it("filters zcode session rows by their instance key", () => {
    // zcode 会话行的 journal 账目键就是 zcode-sess-<id>：按绑定的实例键过滤时
    // 只回本行，聚合桶（zcode-global）与别的会话行都不进集。
    const zcodeRows = [
      { ts: 1, agentId: "zcode", instanceId: "zcode-global", model: "m1", ok: true },
      { ts: 2, agentId: "zcode", instanceId: "zcode-sess-a", model: "m2", ok: true },
      { ts: 3, agentId: "zcode", instanceId: "zcode-sess-b", model: "m3", ok: true },
    ];
    assert.deepEqual(
      filterTerminalRequestRows(zcodeRows, { agentId: "zcode", instanceId: "zcode-sess-a" }).map((r) => r.ts),
      [2],
    );
  });
});

describe("claude conversation fold (memberPids reverse lookup)", () => {
  const baseSession = { id: "t1", label: "新终端", shell: "powershell", pid: 8888, status: "running" };

  it("binds a member pid to its folded conversation row (claude rows live in the sessions bucket)", () => {
    // 折叠后行 id 是会话身份（claude-sess-*），join 手里的进程号要按
    // memberPids 映回行身份——否则折叠行的终端高亮失锚（2026-11-01 报障的
    // 另一半：会话行高亮失败）。
    const out = attributeTerminalSessions(
      [baseSession],
      [{ agentId: "claude", pid: 4321, ancestors: [8888] }],
      [{ id: "claude", name: "Claude Code", sessions: [{ id: "claude-sess-abc", memberPids: [4321, 4322] }] }],
    );
    assert.equal(out[0].agent.instanceId, "claude-sess-abc");
    assert.equal(out[0].agent.pid, 4321);
  });

  it("binds via the instances bucket too (the panel payload mirrors sessions into instances)", () => {
    const out = attributeTerminalSessions(
      [baseSession],
      [{ agentId: "claude", pid: 4322, ancestors: [8888] }],
      [{ id: "claude", name: "Claude Code", instances: [{ id: "claude-sess-abc", memberPids: [4321, 4322] }] }],
    );
    assert.equal(out[0].agent.instanceId, "claude-sess-abc");
  });

  it("a canonical per-pid row still wins over the member reverse lookup", () => {
    // 未折叠的逐 pid 行与折叠行并存时，进程号精确命中的行优先——反查只是
    // 「canonical 查不到」时的兜底。canonical 行刻意不带 memberPids：一带上，
    // 反查索引（首见优先）也把 4321 映回同一个 id，两条路径结果重合，用例
    // 对优先级翻转免疫；不带时反查只能落到折叠行 claude-sess-abc，优先级
    // 被删或被前置才会真正变红。
    const out = attributeTerminalSessions(
      [baseSession],
      [{ agentId: "claude", pid: 4321, ancestors: [8888] }],
      [{ id: "claude", name: "Claude Code", sessions: [
        { id: "claude-4321" },
        { id: "claude-sess-abc", memberPids: [4321] },
      ] }],
    );
    assert.equal(out[0].agent.instanceId, "claude-4321",
      "canonical 命中优先；若反查兜底被前置或 canonical 判定被删，会得到 claude-sess-abc");
  });

  it("a member pid without a matching row stays unbound", () => {
    const out = attributeTerminalSessions(
      [baseSession],
      [{ agentId: "claude", pid: 9999, ancestors: [8888] }],
      [{ id: "claude", name: "Claude Code", sessions: [{ id: "claude-sess-abc", memberPids: [4321] }] }],
    );
    assert.equal(out[0].agent.instanceId, null);
  });
});

describe("filterTerminalRequestRows (instanceIds set filter)", () => {
  // 折叠行的「最近请求」：journal 账目是逐进程的，折叠行的请求散在全部成员
  // 键下；instanceIds 与 instanceId 并集生效，任一命中即算本行。
  const rows = [
    { ts: 1, agentId: "claude", instanceId: "claude-4444", model: "m1", ok: true },
    { ts: 2, agentId: "claude", instanceId: "claude-5555", model: "m2", ok: true },
    { ts: 3, agentId: "claude", instanceId: "claude-7777", model: "m3", ok: true },
    { ts: 4, agentId: "kimi", instanceId: "kimi-4444", model: "m4", ok: true },
    { ts: 5, agentId: "claude", instanceId: "claude-sess-abc", model: "m5", ok: true },
  ];

  it("matches any of the member keys, newest-first", () => {
    const out = filterTerminalRequestRows(rows, {
      agentId: "claude",
      instanceId: "claude-sess-abc",
      instanceIds: ["claude-4444", "claude-5555"],
    });
    assert.deepEqual(out.map((r) => r.ts), [5, 2, 1],
      "成员键与行自身键并集；别的会话（7777）与别的端点（kimi）不进集");
  });

  it("instanceIds alone (no instanceId) still binds", () => {
    const out = filterTerminalRequestRows(rows, { agentId: "claude", instanceIds: ["claude-7777"] });
    assert.deepEqual(out.map((r) => r.ts), [3]);
  });

  it("empty instanceIds degrades to the plain instanceId filter", () => {
    const out = filterTerminalRequestRows(rows, { agentId: "claude", instanceId: "claude-4444", instanceIds: [] });
    assert.deepEqual(out.map((r) => r.ts), [1]);
  });

  it("junk entries in instanceIds are ignored", () => {
    const out = filterTerminalRequestRows(rows, { agentId: "claude", instanceIds: ["", "claude-5555", 7] });
    assert.deepEqual(out.map((r) => r.ts), [2]);
  });
});
