import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProcessTable, hasRunningCommand } from "../src/terminal/terminal-switch-guard.mjs";
import { attributeTerminalSessions } from "../src/terminal/terminal-attribution.mjs";
import { createScreenMirror } from "../src/terminal/terminal-screen.mjs";
import { createTerminalHost } from "../src/terminal/terminal-host.mjs";
import { createPanelRouter } from "../src/panel/panel.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

// M14 C 线后端地基的回归夹具：① 插件宿主行豁免；② 两处 detected-processes feed
// 都带 zcodeSessions；③ zcode 精确绑定；④ 可见文本指纹与 lastVisibleAt；⑤ 快照
// 兼容。宿主/路由器全部注入桩，不碰真实 47820/47821/47823。

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function table(rows) {
  const ppidByPid = new Map();
  const cmdByPid = new Map();
  const imageByPid = new Map();
  for (const [pid, ppid, image, cmd] of rows) {
    ppidByPid.set(pid, ppid);
    cmdByPid.set(pid, cmd);
    imageByPid.set(pid, image);
  }
  return { ppidByPid, cmdByPid, imageByPid };
}

describe("P0-a 基础设施行豁免（__zcode-plugin-host / node-repl-host）", () => {
  const ZCODE_TREE = [
    [20, 1, "cmd.exe", "cmd /c zcode"],
    [21, 20, "node.exe", "node zcode.cjs"],
  ];
  const INFRA_ROWS = [
    [22, 21, "node.exe", "node C:\\app\\__zcode-plugin-host.cjs --port 1"],
    [23, 21, "node.exe", "node C:\\app\\node-repl-host.js"],
  ];

  it("宿主行不算证据：锚下只有基础设施行时判空闲", () => {
    const idle = table([...ZCODE_TREE, ...INFRA_ROWS]);
    assert.equal(hasRunningCommand(idle, { rootPid: 20, anchorPid: 21 }), false);
  });

  it("宿主底下真起的命令仍算证据（跳过证据位但不跳过遍历）", () => {
    const busy = table([
      ...ZCODE_TREE,
      ...INFRA_ROWS,
      [30, 22, "node.exe", "node C:\\work\\runner.js"],
    ]);
    assert.equal(hasRunningCommand(busy, { rootPid: 20, anchorPid: 21 }), true);
  });

  it("解析面同样认这条豁免：CIM 行形状走同一条判据", () => {
    const parsed = parseProcessTable([
      "20\t1\tcmd.exe\tcmd /c zcode",
      "21\t20\tnode.exe\tnode zcode.cjs",
      "22\t21\tnode.exe\tnode C:\\app\\__zcode-plugin-host.cjs",
    ].join("\n"));
    assert.equal(hasRunningCommand(parsed, { rootPid: 20, anchorPid: 21 }), false);
  });
});

describe("P1' zcode 精确绑定", () => {
  const session = { id: "t-z", label: "ZCode", shell: "pwsh", pid: 8888, cwd: "D:\\dev\\bridge" };
  const detected = [{ agentId: "zcode", pid: 6400, ancestors: [8888] }];
  const agentsWith = (rows) => [{ id: "zcode", name: "ZCode", instances: rows.map((id) => ({ id })) }];

  it("resume.id 命中优先于任何 cwd 兜底", () => {
    const resumeId = "sess_7c1f4a2e-1111-2222-3333-444455556666";
    const out = attributeTerminalSessions(
      [{ ...session, resume: { endpoint: "zcode", id: resumeId } }],
      detected,
      agentsWith(["zcode-sess-7c1f4a2e-1111-2222-3333-444455556666", "zcode-sess-hot"]),
      { zcode: [
        { id: "zcode-sess-hot", cwd: "D:\\dev\\bridge", lastActive: 9000, originator: null },
      ] },
    );
    assert.equal(out[0].agent.instanceId, "zcode-sess-7c1f4a2e-1111-2222-3333-444455556666");
  });

  it("resume 的 sess_ / subagent_agent_ 前缀按 relay 同一顺序各剥一次", () => {
    for (const [rawId, rowId] of [
      ["sess_abc-123", "zcode-sess-abc-123"],
      ["subagent_agent_abc-123", "zcode-sess-abc-123"],
    ]) {
      const out = attributeTerminalSessions(
        [{ ...session, resume: { endpoint: "zcode", id: rawId } }],
        detected,
        agentsWith([rowId]),
        null,
      );
      assert.equal(out[0].agent.instanceId, rowId, `${rawId} → ${rowId}`);
    }
  });

  it("resume 行不存在于 agents 负载时不硬绑，退回 cwd 兜底", () => {
    const out = attributeTerminalSessions(
      [{ ...session, resume: { endpoint: "zcode", id: "sess_missing" } }],
      detected,
      agentsWith(["zcode-sess-real"]),
      { zcode: [{ id: "zcode-sess-real", cwd: "D:\\dev\\bridge", lastActive: 1, originator: null }] },
    );
    assert.equal(out[0].agent.instanceId, "zcode-sess-real");
  });

  it("-actor / subagent 行不参与 cwd 兜底（即使最热、originator 为 null）", () => {
    const out = attributeTerminalSessions(
      [session],
      detected,
      agentsWith(["zcode-sess-dwf-...-actor", "zcode-sess-main"]),
      { zcode: [
        { id: "zcode-sess-dwf-...-actor", cwd: "D:\\dev\\bridge", lastActive: 9_999_999, originator: null },
        { id: "zcode-sess-main", cwd: "D:\\dev\\bridge", lastActive: 1, originator: null },
      ] },
    );
    assert.equal(out[0].agent.instanceId, "zcode-sess-main");
  });

  it("只剩 actor 行时判不准，不绑", () => {
    const out = attributeTerminalSessions(
      [session],
      detected,
      agentsWith(["zcode-sess-a-actor", "zcode-sess-b-subagent"]),
      { zcode: [
        { id: "zcode-sess-a-actor", cwd: "D:\\dev\\bridge", lastActive: 1, originator: null },
        { id: "zcode-sess-b-subagent", cwd: "D:\\dev\\bridge", lastActive: 2, originator: null },
      ] },
    );
    assert.equal(out[0].agent.instanceId, null);
  });

  it("其它端点回归：codex 仍按 cwd＋最近活跃绑（多行同 cwd 不是歧义）", () => {
    const out = attributeTerminalSessions(
      [session],
      [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
      [{ id: "codex", name: "Codex", instances: [{ id: "codex-sess-old" }, { id: "codex-sess-new" }] }],
      { codex: [
        { id: "codex-sess-old", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: "codex-tui" },
        { id: "codex-sess-new", cwd: "D:\\dev\\bridge", lastActive: 2000, originator: "codex-tui" },
      ] },
    );
    assert.equal(out[0].agent.instanceId, "codex-sess-new");
  });
});

describe("P-B visibleSignature（排除 SGR）", () => {
  it("纯颜色变化签名不变，可见字符/光标/备屏位变化签名改变", () => {
    const mirror = createScreenMirror({ cols: 20, rows: 4 });
    mirror.write("hello");
    const base = mirror.visibleSignature();
    mirror.write("\u001b[38;2;255;0;0m");
    assert.equal(mirror.visibleSignature(), base, "SGR 颜色不进可见文本指纹");
    mirror.write("!");
    assert.notEqual(mirror.visibleSignature(), base, "可见字符变化必须改变指纹");
    const afterChar = mirror.visibleSignature();
    mirror.write("\u001b[1;1H");
    assert.notEqual(mirror.visibleSignature(), afterChar, "光标位置进指纹");
    const beforeAlt = mirror.visibleSignature();
    mirror.write("\u001b[?1049h");
    assert.notEqual(mirror.visibleSignature(), beforeAlt, "备屏位进指纹");
  });
});

class FakePty {
  constructor() {
    this.pid = 4321;
    this.cols = 80;
    this.rows = 24;
    this.dataListener = null;
    this.exitListener = null;
  }
  onData(fn) { this.dataListener = fn; }
  onExit(fn) { this.exitListener = fn; }
  write() {}
  resize() {}
  kill() { this.exitListener?.({ exitCode: 0 }); }
}

async function listen(host) {
  await new Promise((resolve, reject) => {
    host.server.once("error", reject);
    host.server.listen(0, "127.0.0.1", resolve);
  });
  return host.server.address().port;
}

function headers(host) {
  return { authorization: `Bearer ${host.token}`, "content-type": "application/json" };
}

describe("P-B lastVisibleAt 与快照", () => {
  it("扫光帧（纯 SGR）不刷新 lastVisibleAt，可见字符才刷新；快照带出该字段", async () => {
    const root = mkdtempSync(`${tmpdir()}\\anyswitch-m14-visible-`);
    const calls = [];
    const ptyModule = {
      spawn: () => {
        const pty = new FakePty();
        calls.push(pty);
        return pty;
      },
    };
    // 受控时钟（createTerminalHost 的 nowFn 注入，默认不传行为不变）：lastActiveAt
    // 走这只钟，纯 SGR 帧有没有把它推进到本帧时刻不再靠墙钟竞速判定；lastVisibleAt
    // 仍走真实墙钟（touchVisibleAt 用 Date.now），可见变化两腿之间保留 sleep(10)
    // 让墙钟拉开毫秒。
    let clockNow = 1_700_000_000_000;
    let host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} }, nowFn: () => clockNow });
    try {
      const port = await listen(host);
      const url = (path) => `http://127.0.0.1:${port}${path}`;
      const created = await fetch(url("/terminal/sessions"), {
        method: "POST",
        headers: headers(host),
        body: JSON.stringify({ label: "可见性", cwd: root, shell: "powershell", cols: 80, rows: 24 }),
      }).then((response) => response.json());

      const list = () => fetch(url("/terminal/sessions"), { headers: headers(host) }).then((response) => response.json());
      let listed = await list();
      assert.equal("lastVisibleAt" in listed.sessions[0], false, "出生不播种：还没画过东西");

      calls[0].dataListener("hello");
      await sleep(10);
      listed = await list();
      const firstVisibleAt = listed.sessions[0].lastVisibleAt;
      assert.equal(typeof firstVisibleAt, "number", "可见字符刷新出时间戳");

      // 欢迎屏 logo 扫光：只有 SGR 颜色在变，字符一格不动。
      const sgrAt = clockNow + 5000;
      clockNow = sgrAt;
      calls[0].dataListener("\u001b[38;2;255;0;0m");
      calls[0].dataListener("\u001b[38;2;0;255;0m");
      await sleep(10);
      listed = await list();
      assert.equal(listed.sessions[0].lastVisibleAt, firstVisibleAt, "纯颜色帧不刷新 lastVisibleAt");
      assert.equal(listed.sessions[0].lastActiveAt, sgrAt,
        "lastActiveAt 语义不动：任何输出块都算活跃——纯 SGR 帧也把活动时刻推进到本帧（退化成只在可见变化时刷新会停在此前的时刻）");

      calls[0].dataListener("!");
      await sleep(10);
      listed = await list();
      assert.ok(listed.sessions[0].lastVisibleAt > firstVisibleAt, "可见字符变化刷新 lastVisibleAt");

      await host.close();
      const recordPath = host.sessionStatePath(created.id);
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      assert.equal(typeof record.lastVisibleAt, "number", "落盘记录同样带出 lastVisibleAt");

      // 老快照兼容：把字段删掉再起宿主，列表照出、字段缺席、不炸。
      delete record.lastVisibleAt;
      writeFileSync(recordPath, JSON.stringify(record), "utf8");
      host = createTerminalHost({ root, port: 0, ptyModule: { spawn: () => new FakePty() }, logger: { warn() {} } });
      const restoredPort = await listen(host);
      const restoredList = await fetch(`http://127.0.0.1:${restoredPort}/terminal/sessions`, { headers: headers(host) }).then((response) => response.json());
      assert.equal(restoredList.sessions.length, 1);
      assert.equal("lastVisibleAt" in restoredList.sessions[0], false, "老快照无字段时下发缺席");
      await host.close();
      host = null;
    } finally {
      if (host) await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function fakeReqRes(url) {
  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(code, h) { this.statusCode = code; this.headers = h || {}; },
    end(data) { if (data !== undefined) this.body += data; },
  };
  const req = {
    url,
    method: "GET",
    headers: {
      host: "127.0.0.1:47820",
      origin: "http://127.0.0.1:47820",
      "x-anyswitch-panel": "1",
    },
    on() { return req; },
  };
  return { req, res, json: () => (res.body ? JSON.parse(res.body) : null) };
}

const FEED_SESSION = { id: "t-feed", label: "ZCode", cwd: "D:\\dev\\bridge", shell: "pwsh", pid: 8888, status: "running" };
const FEED_AGENTS = [{ id: "zcode", name: "ZCode", instances: [{ id: "zcode-sess-resume-1" }] }];
const FEED_PROCESSES = [{ agentId: "zcode", pid: 6400, ancestors: [8888], busy: null }];
const FEED_ZCODE_SESSIONS = [{ id: "zcode-sess-resume-1", cwd: "D:\\dev\\bridge", lastActive: 1, originator: null }];

async function listSessions(router) {
  const { req, res, json } = fakeReqRes("/panel/api/terminal/sessions");
  await router.handle(req, res);
  return json();
}

describe("P0-c 两处 feed 都带 zcodeSessions", () => {
  it("HTTP 拉取分支（defaultFetchRelayDetectedProcesses）透传 data.zcodeSessions", async () => {
    const root = mkTestDir("anyswitch-m14-feed-http-");
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/api/internal/detected-processes")) {
        return {
          ok: true,
          json: async () => ({ processes: FEED_PROCESSES, zcodeSessions: FEED_ZCODE_SESSIONS }),
        };
      }
      return realFetch(url, init);
    };
    try {
      const router = createPanelRouter({
        storePaths: { root },
        logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
        fetchRelayAgents: async () => FEED_AGENTS,
        fetchTerminalSessionsList: async () => [FEED_SESSION],
        scanAgentConversationsFn: async () => [],
      });
      const body = await listSessions(router);
      assert.equal(body.ok, true);
      assert.equal(body.sessions[0].agent.instanceId, "zcode-sess-resume-1",
        "HTTP feed 的 zcodeSessions 一路喂到归属 join");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("本地回落分支按 pull(...) 风格读 getZcodeSessionsForTerminalJoin", async () => {
    const root = mkTestDir("anyswitch-m14-feed-local-");
    const router = createPanelRouter({
      storePaths: { root },
      logger: null,
      metricsCollector: {
        getDetectedClientProcesses: () => FEED_PROCESSES,
        getZcodeSessionsForTerminalJoin: async () => FEED_ZCODE_SESSIONS,
      },
      aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => FEED_AGENTS,
      fetchRelayDetectedProcesses: async () => null,
      fetchTerminalSessionsList: async () => [FEED_SESSION],
      scanAgentConversationsFn: async () => [],
    });
    const body = await listSessions(router);
    assert.equal(body.ok, true);
    assert.equal(body.sessions[0].agent.instanceId, "zcode-sess-resume-1",
      "本地回落的 zcodeSessions 同样喂到归属 join");
  });
});
