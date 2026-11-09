// 新建会话乐观高亮：创建请求挂起期间，左栏必须当拍点亮「新会话」占位行。
// 取样惯例照同目录用例：按函数名切源码进桩环境真跑，桩只补模块级状态与纯展示
// 依赖；不发请求、不碰在跑终端。
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPanelFn as extract } from "../test-helpers/extract-panel-fn.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const panelJs = readFileSync(join(here, "../panel-ui", "panel.js"), "utf8");

const OLD_TERMINAL = {
  id: "t-old", agentId: "kimi", cwd: "C:\\dev\\alpha",
  boundConversation: { endpoint: "kimi", id: "s-old" },
  backendState: { spawnedAt: 2 },
};
const OLD_HISTORY_ROW = {
  endpoint: "kimi", id: "s-old", title: "老会话",
  project: "C:\\dev\\alpha", lastActive: 1,
};
const HISTORY = { endpoint: "kimi", sessions: [OLD_HISTORY_ROW], fetchedAt: 1, error: null };
const CREATE_PENDING = {
  endpoint: "kimi", cwd: "C:\\dev\\alpha", token: 7,
  placeholderId: "rail-create:7", timer: null,
};

// 渲染层沙盒：兜底行推导、两个行渲染器与它们的身份判据全用生产实现。
function railSandbox({ createPending = null, sessions = { "t-old": OLD_TERMINAL } } = {}) {
  return new Function("state", `
    let terminalRailCreatePending = state.createPending;
    let terminalRailSelectPending = null;
    const terminalRailHistory = state.history;
    const terminalBackendReady = true;
    const terminalBackendSessions = state.sessions;
    let activeTerminalPreviewId = state.activeId;
    const terminalDoneUnread = new Set();
    const TERMINAL_RAIL_SPINNER = "";
    const TERMINAL_RAIL_DONE_DOT = "";
    const TERMINAL_RAIL_ICON_ARCHIVE = "";
    const TERMINAL_RAIL_ICON_UNARCHIVE = "";
    const esc = (v) => String(v);
    const escapeHtml = (v) => String(v || "");
    const sessTitle = (s) => s.title || "";
    const sessDirName = (p) => String(p || "");
    const terminalRailRelTime = () => "3 分钟前";
    const terminalRailIsArchived = () => false;
    ${extract("terminalRailNormDir")}
    ${extract("terminalRailSameDir")}
    ${extract("terminalRailSessionMap")}
    ${extract("terminalRailActiveSession")}
    ${extract("terminalRailAgentId")}
    ${extract("terminalRailStateSlotHtml")}
    ${extract("terminalRailPendingFreshActive")}
    ${extract("terminalRailPendingFreshArmed")}
    ${extract("terminalRailPendingNewTerminals")}
    ${extract("terminalRailPendingRowHtml")}
    ${extract("terminalRailRowHtml")}
    return {
      pendingNew: () => terminalRailPendingNewTerminals(),
      pendingRow: (entry) => terminalRailPendingRowHtml(entry, activeTerminalPreviewId),
      historyRow: (row, live) => terminalRailRowHtml(row, live, activeTerminalPreviewId, {}),
    };
  `)({ createPending, sessions, history: HISTORY, activeId: "t-old" });
}

describe("新建会话：创建请求挂起期间左栏高亮当拍切换", () => {
  it("POST 挂起时占位「新会话」行已出现并点亮，老会话行同拍失亮，一屏至多一条", () => {
    const sb = railSandbox({ createPending: CREATE_PENDING });
    const rows = sb.pendingNew();
    const optimistic = rows.find((entry) => entry.optimistic);
    assert.ok(optimistic, "创建请求还没回来，左栏就该有一条占位「新会话」行");
    assert.equal(optimistic.cwd, "C:\\dev\\alpha", "占位行落在目标工作区那一组");
    const placeholder = sb.pendingRow(optimistic);
    const oldRow = sb.historyRow(OLD_HISTORY_ROW, { id: "t-old" });
    assert.ok(placeholder.includes("is-active"), "占位行当拍点亮");
    assert.ok(!oldRow.includes("is-active"), "老会话行同拍失亮");
    assert.equal((placeholder + oldRow).match(/is-active/g).length, 1, "一屏至多一条选中");
    assert.ok(placeholder.includes(">新会话<"), "占位行复用既有标签");
    assert.equal(placeholder.replace(/<[^>]*>/g, "").trim(), "新会话", "零新增／改动前端文案");
    assert.ok(placeholder.includes("data-rail-term-create-pending"), "占位行带不可点标记");
    assert.ok(!placeholder.includes("data-rail-term-close"), "没有实体终端，占位行不给关闭叉");
  });

  it("无创建在飞时保持原状：老会话行照常亮，栏上不出现占位行", () => {
    const sb = railSandbox({ createPending: null });
    assert.equal(sb.pendingNew().length, 0, "老终端已有会话身份，没有兜底行也没有占位行");
    assert.ok(sb.historyRow(OLD_HISTORY_ROW, { id: "t-old" }).includes("is-active"), "活跃终端的历史行照常亮");
  });

  it("占位行不挤掉同一栏里其它工作区的真实兜底行", () => {
    const sb = railSandbox({
      createPending: CREATE_PENDING,
      sessions: {
        "t-old": OLD_TERMINAL,
        "t-other": { id: "t-other", agentId: "kimi", cwd: "C:\\dev\\beta", backendState: { spawnedAt: 3 } },
      },
    });
    const rows = sb.pendingNew();
    assert.equal(rows.filter((entry) => entry.optimistic).length, 1, "一次点击只武装一枚占位");
    assert.ok(rows.some((entry) => entry.id === "t-other"), "别的工作区已在跑的全新终端照常有真兜底行");
    assert.ok(rows.some((entry) => entry.id === "rail-create:7"), "占位行与真兜底行同表、按身份键区分");
    assert.ok(!sb.pendingRow(rows.find((entry) => entry.id === "t-other")).includes("is-active"), "创建在飞时真兜底行不跟着亮");
  });

  it("乐观态令牌：武装幂等、按令牌撤销、TTL 兜底撤假行", () => {
    const sb = new Function(`
      let terminalRailCreatePending = null;
      let terminalRailCreateSeq = 0;
      const TERMINAL_RAIL_CREATE_TTL_MS = 30000;
      let renders = 0;
      function renderTerminalRail() { renders += 1; }
      ${extract("terminalRailArmCreate")}
      ${extract("terminalRailDisarmCreate")}
      return {
        arm: (o) => terminalRailArmCreate(o),
        disarm: (t) => terminalRailDisarmCreate(t),
        pending: () => terminalRailCreatePending,
        renders: () => renders,
      };
    `)();
    const token = sb.arm({ endpoint: "kimi", cwd: "C:\\dev\\alpha" });
    assert.ok(sb.pending(), "武装后乐观态在册");
    assert.equal(sb.renders(), 1, "武装当拍重渲左栏");
    assert.equal(sb.arm({ endpoint: "kimi", cwd: "C:\\dev\\alpha" }), token, "同一趟创建重复武装不重置令牌");
    sb.disarm(token + 999);
    assert.ok(sb.pending(), "迟到令牌清不掉在飞的新点击");
    sb.disarm(token);
    assert.equal(sb.pending(), null, "落地按令牌撤销");
    const second = sb.arm({ endpoint: "kimi", cwd: "C:\\dev\\beta" });
    assert.notEqual(second, token, "新一趟创建领新令牌");
    const third = sb.arm({ endpoint: "kimi", cwd: "C:\\dev\\gamma" });
    assert.notEqual(third, second, "目标目录换了就重新武装，占位行不跟错组");
    sb.disarm(second);
    assert.ok(sb.pending(), "旧请求落地清不掉新点击的占位");
    sb.disarm(null);
    assert.equal(sb.pending(), null, "无条件作废用于失败回滚与用户改主意");
  });

  it("创建请求挂起即武装；落地、失败两出口都撤销；续接创建不武装", async () => {
    const state = { gate: null };
    const armed = [];
    const disarmed = [];
    const placed = [];
    const sb = new Function("state", "armed", "disarmed", "placed", `
      let terminalCreateInFlight = 0;
      const terminalBackendSessions = {};
      function terminalBackendSession(x) { return { ...x }; }
      function terminalCreateSize() { return { cols: 80, rows: 24 }; }
      function terminalViewportPlaceTerminal(id) { placed.push(id); }
      function armTerminalBootingOverlay() {}
      function renderTerminalPreviewSession() {}
      function toast() {}
      function panelError(e, fallback) { return fallback; }
      function terminalSwitchLog() {}
      function abortTerminalSwitchLoading() { return false; }
      function terminalRailEndSelect() {}
      function terminalRailArmCreate(o) { armed.push(o); return 11; }
      function terminalRailDisarmCreate(t) { disarmed.push(t); }
      function api() { return state.gate; }
      ${extract("createAgentTerminal")}
      return (opts, options) => createAgentTerminal(opts, options);
    `)(state, armed, disarmed, placed);
    // 挂起：POST 永不落地，检查武装已发生。
    state.gate = new Promise(() => {});
    sb({ agentId: "kimi", cwd: "C:\\dev\\alpha" }, { placement: "viewport" });
    assert.equal(armed.length, 1, "POST 发出前已武装");
    assert.equal(armed[0].endpoint, "kimi", "武装带目标 agent");
    // 落地：认领后撤销。
    state.gate = Promise.resolve({ id: "t-new" });
    await sb({ agentId: "kimi", cwd: "C:\\dev\\alpha" }, { placement: "viewport" });
    assert.ok(placed.includes("t-new"), "新终端挂进视口");
    assert.ok(disarmed.includes(11), "落地出口撤销占位");
    // 失败：同样撤销，不留假高亮。
    state.gate = Promise.reject(new Error("spawn failed"));
    await sb({ agentId: "kimi", cwd: "C:\\dev\\alpha" }, { placement: "viewport" });
    assert.equal(disarmed.length, 2, "失败出口也撤销占位");
    // 续接创建不武装（历史行由既有点亮机制接管）。
    state.gate = Promise.resolve({ id: "t-resume" });
    await sb({ agentId: "kimi", cwd: "C:\\dev\\alpha", resume: { endpoint: "kimi", id: "s-old" } }, { placement: "viewport" });
    assert.equal(armed.length, 3, "三次全新创建都武装，续接那次不武装");
  });

  it("判定门：武装排在补读两拍之前，内切路径先撤占位再点亮真实兜底行", () => {
    const core = extract("terminalRailSwitchOrCreateCore");
    const armAt = core.indexOf("terminalRailArmCreate(");
    const rereadAt = core.indexOf('api("GET", "/api/agents")');
    assert.ok(armAt >= 0 && armAt < rereadAt, "在飞闸置位后、补读之前就点亮，不等宿主探测");
    const disarmAt = core.indexOf("terminalRailDisarmCreate(");
    const armSelectAt = core.indexOf("terminalRailArmSelect(");
    assert.ok(disarmAt >= 0 && disarmAt < armSelectAt, "同记录内切撤掉占位，交给既有真实兜底行");
  });

  it("占位行点击不进入聚焦／续接委托", () => {
    const guard = panelJs.indexOf('closest("[data-rail-term-create-pending]")');
    const sessionRow = panelJs.indexOf('const sessionRow = target.closest("[data-rail-term-session]")');
    assert.ok(guard >= 0 && sessionRow >= 0 && guard < sessionRow, "占位行在会话行分支之前被拦下");
  });
});
