// 终端会话栏 M7 修正（S1 归档 / S2 分组移除 / S3 组头三件 / S4 钉底 / S5 去重聚焦）。
// 断言分两层：静态源码（HTML 骨架 / CSS 观感红线 / JS 挂点与文案逐字）+ vm 真跑
// （过滤与归组、归档两分支、toast 撤销、钉底分层结构、去重两分支）。
// 取样惯例照 panel-terminal-rail.test.mjs：源码字符串断言 + 按函数名切源码进桩环境。
// M13 追加：归档/撤销 FLIP（退场幽灵行＋flip 门＋armed 门）、toast 动效（入场/
// 淡出/瞬时收场）与 toast 第二钮「筛选已归档会话」（文案逐字批准，全文件唯一新增文案）。
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const panelHtml = readFileSync(join(here, "panel-ui", "panel.html"), "utf8");
const panelCss = readFileSync(join(here, "panel-ui", "panel.css"), "utf8");
const panelJs = readFileSync(join(here, "panel-ui", "panel.js"), "utf8");
const panelMjs = readFileSync(join(here, "panel.mjs"), "utf8");

const railHtml = () => {
  const m = panelHtml.match(/<aside class="rail" id="v2Rail"[\s\S]*?<\/aside>/);
  assert.ok(m, "左栏在册");
  return m[0];
};

function extractFn(name) {
  const src = panelJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
  assert.ok(src, `${name} found in panel.js`);
  return src;
}

// ── 视口表（M12：页签＝视口）的桩前置 ──
// 单测按函数体抽取进 vm，模块级符号不会跟着来。视口纯函数直接用生产实现（这样断言
// 测的是真口径），只在这里补它们的模块级状态量；外部依赖（api / terminalSessionFor /
// renderTerminalPreviewSession…）仍由各沙盒自己提供。
const VIEWPORT_FNS = [
  "terminalViewportNextId", "terminalViewportActive", "terminalViewportById",
  "terminalViewportForTerminal", "terminalViewportAttach", "terminalViewportCreate",
  "terminalViewportDestroy", "terminalViewportActivate", "terminalSessionRunning",
  "terminalViewportRetire", "terminalViewportPlaceTerminal", "terminalCloseTerminal",
  "terminalCloseViewportTab", "terminalViewportSyncFromHost",
  "loadTerminalViewports", "saveTerminalViewports", "terminalRailKeepAliveSwitch",
];
const viewportPrelude = (names = VIEWPORT_FNS) => `
  let terminalViewports = [];
  let terminalViewportActiveId = null;
  const terminalBackgroundIds = new Set();
  let terminalViewportSeq = 0;
  let terminalViewportsLoaded = false;
  let terminalViewportsSavedJson = "";
  const TERMINAL_VIEWPORTS_KEY = "panel-terminal-viewports";
  ${names.map(extractFn).join("\n")}
`;

const cssRule = (selector) => {
  const at = panelCss.indexOf(selector);
  assert.ok(at >= 0, `样式规则 ${selector} 在册`);
  return panelCss.slice(at, panelCss.indexOf("}", at) + 1);
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const escapeHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── 渲染沙盒：renderTerminalRailHistory 及其全部依赖（照既有测试的同款桩） ──
function renderSandbox({ history, activeSession = null, prefs = { archived: [], removedGroups: [] }, collapsed = [], removedAt = {}, viewPrefs = { groupBy: "workspace", orderBy: "updated", archivedFilter: "default", sessionOrder: {} }, apiImpl = async () => ({ ok: true }) } = {}) {
  const list = { html: "", writes: 0 };
  Object.defineProperty(list, "innerHTML", {
    get: () => list.html,
    set: (v) => { list.writes += 1; list.html = v; },
  });
  const state = { collapsed: new Set(collapsed), scrolled: [], posts: [], saved: 0 };
  const fn = new Function("list", "state", "history", "activeSession", "prefs", "removedAt", "viewPrefs", "apiImpl", `
    let terminalRailRendered = { history: null };
    let terminalRailAutoExpandedFor = "";
    let terminalRailScrolledFor = "";
    let terminalRailFlipMode = "instant";
    const terminalRailCollapsedGroups = state.collapsed;
    function saveTerminalRailCollapsedGroups() { state.saved += 1; }
    const terminalRailWatermarks = new Map();
    const terminalRailPrefs = prefs;
    const terminalRailViewPrefs = viewPrefs;
    const terminalRailRemovedAt = removedAt;
    const terminalRailSelfHealFailed = new Set();
    const terminalRailSearch = { open: false, query: "", timer: null, searching: false };
    let terminalRailLastGroups = [];
    const TERMINAL_RAIL_WATERMARK = 5;
    const TERMINAL_RAIL_MOTION_SELECTOR = "[data-rail-term-resume], [data-rail-term-session], [data-rail-term-group-head], [data-rail-term-more]";
    const TERMINAL_RAIL_UNGROUPED_HEAD = "~ungrouped";
    const TERMINAL_RAIL_ICON_CHEVRON = "";
    const TERMINAL_RAIL_ICON_ARCHIVE = "";
    const TERMINAL_RAIL_ICON_UNARCHIVE = "";
    const TERMINAL_RAIL_ICON_ELLIPSIS = "";
    const TERMINAL_RAIL_ICON_PLUS = "";
    const TERMINAL_RAIL_ICON_FOLDER_OPEN = "";
    const TERMINAL_RAIL_ICON_FOLDER_CLOSED = "";
    let terminalRailHistory = history;
    const activeTerminalPreviewId = activeSession ? activeSession.id : null;
    function $(id) { return id === "railTermHistoryList" ? list : null; }
    function saveTerminalRailRemovedAt() { state.saved += 1; }
    function api(method, path, body) { state.posts.push({ method, path, body }); return apiImpl(method, path, body); }
    let terminalBackendReady = true;
    const terminalBackendSessions = activeSession ? { [activeSession.id]: activeSession } : {};
    ${extractFn("terminalRailSessionMap")}
    ${extractFn("terminalRailActiveSession")}
    ${extractFn("terminalRailAgentId")}
    ${extractFn("sessDirName")}
    function sessTitle(s) { return s.title || String(s.id || "").slice(0, 8); }
    function sessRelTime() { return "3 分钟前"; }
    function terminalRailRelTime() { return "3 分钟前"; }
    function esc(v) { return String(v); }
    function escapeHtml(v) { return String(v || ""); }
    function terminalRailScrollGroupIntoView(key) { state.scrolled.push(key); }
    function terminalRailMotionTops() { return null; }
    function playTerminalRailFlip() {}
    // 兜底行 diff 动效（2026-10-25）依赖面的桩：默认关闭（MotionEnabled false），
    // 行为与既有渲染断言一致；diff 路径的真跑见「兜底行生命周期动效」专组沙盒。
    function terminalRailMotionEnabled() { return false; }
    function terminalRailPendingRowKeys() { return new Set(); }
    function terminalRailSnapshotMotion() { return new Map(); }
    function terminalRailMountExitGhosts() {}
    let terminalRailLastDiffAgent = null;
    let terminalRailLastDiffSearch = false;
    ${extractFn("terminalRailFindOpenSession")}
    ${extractFn("terminalRailNormDir")}
    ${extractFn("terminalRailGroupSessions")}
    ${extractFn("terminalRailWatermarkView")}
    ${extractFn("terminalRailNextWatermark")}
    ${extractFn("terminalRailMoreLabel")}
    ${extractFn("terminalRailSameDir")}
    ${extractFn("terminalRailGroupForDir")}
    ${extractFn("terminalRailArchivedKey")}
    ${extractFn("terminalRailIsArchived")}
    ${extractFn("terminalRailVisibleSessions")}
    ${extractFn("terminalRailSelfHealRemovedGroups")}
    ${extractFn("terminalRailRegroupRemoved")}
    ${extractFn("terminalRailPendingNewTerminals")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
    const TERMINAL_RAIL_SPINNER = "";
    const TERMINAL_RAIL_DONE_DOT = "";
    const terminalDoneUnread = new Map();
    let terminalRailSelectPending = null;
    let terminalRailSelectSeq = 0;
    let terminalSwitchInFlight = false;
    const TERMINAL_RAIL_SELECT_TTL_MS = 12000;
    function renderTerminalRail() { renderTerminalRailHistory(terminalRailAgentId()); }
    ${extractFn("terminalRailSwitchBusy")}
    ${extractFn("terminalRailBeginSelect")}
    ${extractFn("terminalRailArmSelect")}
    ${extractFn("terminalRailEndSelect")}
    ${extractFn("terminalRailStateSlotHtml")}
    ${extractFn("terminalRailRowHtml")}
    ${extractFn("terminalRailPendingRowHtml")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
    ${extractFn("renderTerminalRailHistory")}
    return {
      render: renderTerminalRailHistory,
      collapsed: terminalRailCollapsedGroups,
      scrolled: state.scrolled,
      prefs: () => terminalRailPrefs,
      removedAt: () => terminalRailRemovedAt,
      begin: (session) => terminalRailBeginSelect(session),
      endSelect: (token) => terminalRailEndSelect(token),
      pending: () => terminalRailSelectPending,
    };
  `)(list, state, history, activeSession, prefs, removedAt, viewPrefs, apiImpl);
  return { fn, list, state };
}

// 历史行渲染沙盒：只取行 HTML 生成函数本身（第二参 live = 开着终端或 null）
function rowHtmlSandbox(prefs) {
  const fn = new Function("session", "live", "activeId", "prefs", `
    const terminalRailPrefs = prefs;
    const TERMINAL_RAIL_ICON_ARCHIVE = "<svg></svg>";
    const TERMINAL_RAIL_ICON_UNARCHIVE = "<svg></svg>";
    function sessTitle(s) { return s.title || String(s.id || "").slice(0, 8); }
    function sessRelTime() { return "3 分钟前"; }
    function terminalRailRelTime() { return "3 分钟前"; }
    function esc(v) { return String(v); }
    function escapeHtml(v) { return String(v || ""); }
    ${extractFn("terminalRailArchivedKey")}
    ${extractFn("terminalRailIsArchived")}
    const TERMINAL_RAIL_SPINNER = "";
    const TERMINAL_RAIL_DONE_DOT = "";
    const terminalDoneUnread = new Map();
    let terminalRailSelectPending = null;
    ${extractFn("terminalRailStateSlotHtml")}
    ${extractFn("terminalRailRowHtml")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
    return terminalRailRowHtml;
  `)(null, null, "t1", prefs);
  return fn;
}

// 归档/撤销交互沙盒（S1 与 M13 共用）：归档两分支真跑——本地态、POST、toast opts。
const runArchive = (session, { apiImpl, prefs = { archived: [], removedGroups: [] }, viewPrefs = { groupBy: "workspace", orderBy: "updated", archivedFilter: "default", sessionOrder: {} } } = {}) => {
  const log = { posts: [], toasts: [], renders: 0, removed: [], flipModes: [], viewChoice: null };
  const fn = new Function("session", "log", "apiImpl", "prefs", "viewPrefs", `
    let terminalRailPrefs = prefs;
    let terminalRailHistory = { endpoint: "kimi", sessions: [session], fetchedAt: 1, error: null };
    let terminalRailFlipMode = "instant";
    const terminalRailMotionArmed = false;
    const terminalRailViewPrefs = viewPrefs;
    function api(method, path, body) { log.posts.push({ method, path, body }); return apiImpl(method, path, body); }
    function toast(msg, isErr, opts) { log.toasts.push({ msg, isErr, opts }); }
    function panelError(err, fallback) { return fallback; }
    function renderTerminalRail() { log.renders += 1; }
    function renderTerminalRailHistory() { log.renders += 1; log.flipModes.push(terminalRailFlipMode); }
    function terminalRailAgentId() { return "kimi"; }
    function $(id) { return null; }
    function applyTerminalRailViewChoice(field, value) { log.viewChoice = { field, value }; }
    ${extractFn("terminalRailArchivedKey")}
    ${extractFn("terminalRailMotionEnabled")}
    ${extractFn("terminalRailSnapshotMotion")}
    ${extractFn("terminalRailMountExitGhosts")}
    ${extractFn("terminalRailRerenderExitFlip")}
    ${extractFn("terminalRailArchiveSession")}
    ${extractFn("terminalRailUnarchiveSession")}
    return {
      archive: () => terminalRailArchiveSession(session.id),
      unarchive: (endpoint, id) => terminalRailUnarchiveSession(endpoint, id),
      prefs: () => terminalRailPrefs,
    };
  `)(session, log, apiImpl ?? (async () => ({ ok: true })), prefs, viewPrefs);
  return { fn, log };
};

describe("S1 会话归档（finding 1a）", () => {
  describe("过滤与渲染（vm 真跑）", () => {
    const HISTORY = {
      endpoint: "kimi",
      sessions: [
        { id: "s-1", endpoint: "kimi", project: "C:\\dev\\alpha", title: "重构权限矩阵", lastActive: 100 },
        { id: "s-2", endpoint: "kimi", project: "C:\\dev\\alpha", title: "接入渠道", lastActive: 200 },
        { id: "s-3", endpoint: "kimi", project: "C:\\dev\\beta", title: "排查掉线", lastActive: 300 },
      ],
      fetchedAt: 1,
      error: null,
    };

    it("归档＝视图过滤：归档会话不进组，「展开其余 N」计数随归档同步减", () => {
      const plain = renderSandbox({ history: HISTORY });
      plain.fn.render("kimi");
      assert.ok(plain.list.html.includes('data-rail-term-resume="s-1"'), "未归档时三条都在");
      assert.ok(plain.list.html.includes("展开其余 1 个会话") === false, "alpha 组 2 条不足一档，无展开钮");

      const withArchived = renderSandbox({
        history: HISTORY,
        prefs: { archived: [{ endpoint: "kimi", id: "s-1" }], removedGroups: [] },
      });
      withArchived.fn.render("kimi");
      assert.ok(!withArchived.list.html.includes('data-rail-term-resume="s-1"'), "归档行不进列表（立即出布局，M13 起由退场幽灵行接手视觉）");
      assert.ok(withArchived.list.html.includes('data-rail-term-resume="s-2"'), "同组未归档行不受影响");

      // 计数口径：alpha 3 条 → 归档 1 条后剩 2 条；再补 4 条让组超过一档，
      // 验证「展开其余 N」数的是过滤后的行数（m6b §A6 实测口径）。
      const many = {
        endpoint: "kimi",
        sessions: [
          ...HISTORY.sessions,
          { id: "s-4", endpoint: "kimi", project: "C:\\dev\\alpha", title: "a", lastActive: 90 },
          { id: "s-5", endpoint: "kimi", project: "C:\\dev\\alpha", title: "b", lastActive: 80 },
          { id: "s-6", endpoint: "kimi", project: "C:\\dev\\alpha", title: "c", lastActive: 70 },
          { id: "s-7", endpoint: "kimi", project: "C:\\dev\\alpha", title: "d", lastActive: 60 },
        ],
        fetchedAt: 1,
        error: null,
      };
      const before = renderSandbox({ history: many });
      before.fn.render("kimi");
      assert.ok(before.list.html.includes("展开其余 1 个会话"), "alpha 7 条先露 5，剩余 2 → 一档全展开的判据看 next");
      const after = renderSandbox({
        history: many,
        prefs: { archived: [{ endpoint: "kimi", id: "s-1" }], removedGroups: [] },
      });
      after.fn.render("kimi");
      assert.ok(!after.list.html.includes('data-rail-term-resume="s-1"'), "归档行不计入可见行");
    });

    it("归档键＝endpoint＋session id：同 id 不同端点互不打扰", () => {
      const fn = rowHtmlSandbox({ archived: [], removedGroups: [] });
      assert.ok(fn({ id: "s-1", endpoint: "kimi", title: "t" }, null, "t1").includes('data-rail-term-archive="s-1"'),
        "行内归档钮带会话 id");
      const sandbox = renderSandbox({
        history: {
          endpoint: "kimi",
          sessions: [
            { id: "s-1", endpoint: "kimi", project: "C:\\dev\\alpha", title: "t", lastActive: 100 },
            { id: "s-1", endpoint: "claude", project: "C:\\dev\\alpha", title: "t", lastActive: 90 },
          ],
          fetchedAt: 1,
          error: null,
        },
        prefs: { archived: [{ endpoint: "kimi", id: "s-1" }], removedGroups: [] },
      });
      sandbox.fn.render("kimi");
      assert.equal((sandbox.list.html.match(/data-rail-term-resume="s-1"/g) || []).length, 1,
        "只滤掉 kimi 的那条，claude 的同 id 会话照常显示");
    });

    it("归档行渲染即带「归档」钮：title 逐字「归档会话」，hover 才出现", () => {
      const html = rowHtmlSandbox({ archived: [], removedGroups: [] })(
        { id: "s-1", endpoint: "kimi", title: "重构权限矩阵", lastActive: 100 },
        null,
        "t1",
      );
      assert.ok(html.includes('data-rail-term-archive="s-1"'), "归档钮挂会话 id");
      assert.ok(html.includes('title="归档会话"'), "title 逐字取文案清单");
      assert.ok(html.includes('aria-label="归档会话"'), "无障碍名同词");
      assert.ok(/<svg/.test(html), "归档钮是图标（与关闭叉同形制，不新造文字钮）");
    });
  });

  describe("归档交互两分支（vm 真跑）", () => {
    const SESSION = { id: "s-1", endpoint: "kimi", title: "重构权限矩阵", project: "C:\\dev\\alpha" };

    it("单击即归档：本地先生效（瞬时消失）、POST 落盘、6s toast 带「撤销」", async () => {
      const { fn, log } = runArchive(SESSION);
      fn.archive();
      assert.deepEqual(fn.prefs().archived, [{ endpoint: "kimi", id: "s-1" }], "本地态先进清单（不等网络往返）");
      assert.ok(log.renders >= 1, "本地重渲一次（列表里瞬时消失）");
      assert.deepEqual(log.posts, [{ method: "POST", path: "/api/terminal/rail/archive", body: { endpoint: "kimi", id: "s-1" } }],
        "POST 归档，无确认、无二次交互");
      await flush();
      assert.equal(log.toasts.length, 1, "成功后一句 toast");
      assert.equal(log.toasts[0].msg, "会话已归档。", "文案逐字");
      assert.equal(log.toasts[0].opts.durationMs, 6000, "驻留 6s（dsh 同值）");
      assert.equal(log.toasts[0].opts.actions[0].label, "撤销", "动作钮文案逐字");
      assert.ok(!log.toasts[0].isErr, "不是错误提示（tone 走成功）");
    });

    it("「撤销」＝取消归档：出清单、POST 取消、无 toast（dsh 同口径）", async () => {
      const { fn, log } = runArchive(SESSION);
      fn.archive();
      await flush();
      log.toasts.length = 0;
      fn.unarchive("kimi", "s-1");
      assert.deepEqual(fn.prefs().archived, [], "撤销后出清单（回到原分组原位置——本就不动底层列表）");
      assert.deepEqual(log.posts.at(-1), { method: "POST", path: "/api/terminal/rail/unarchive", body: { endpoint: "kimi", id: "s-1" } },
        "POST 取消归档");
      await flush();
      assert.equal(log.toasts.length, 0, "取消归档无 toast（m6b §A6 实测口径）");
    });

    it("落盘失败：回退本地态 + 错误提示，不假装归档成功", async () => {
      const { fn, log } = runArchive(SESSION, { apiImpl: async () => { throw new Error("HTTP 500：disk full"); } });
      fn.archive();
      await flush();
      assert.deepEqual(fn.prefs().archived, [], "失败回退——刷新回来还在，比假成功更容易理解");
      assert.equal(log.toasts.length, 1, "给一句错误提示");
      assert.equal(log.toasts[0].isErr, true, "按错误上屏");
      assert.ok(!log.toasts[0].msg.includes("HTTP"), "服务端原文不上屏");
    });

    it("归档与续接无关：不可续接的会话（无 resumeCommand）同样可归档", () => {
      // 归档是面板侧视图状态，不读 resumeCommand、不依赖 terminal-host。
      const { fn } = runArchive({ ...SESSION, resumeCommand: "" });
      fn.archive();
      assert.deepEqual(fn.prefs().archived, [{ endpoint: "kimi", id: "s-1" }], "照样归档");
      assert.ok(!extractFn("terminalRailArchiveSession").includes("resumeCommand"), "源码里不看续接能力");
    });

    it("不存在的会话 id：不动手、不请求", async () => {
      const log = { posts: [], toasts: [], renders: 0 };
      const fn = new Function("log", `
        let terminalRailPrefs = { archived: [], removedGroups: [] };
        let terminalRailHistory = { endpoint: "kimi", sessions: [], fetchedAt: 1, error: null };
        function api() { log.posts.push("boom"); return Promise.resolve(); }
        function toast() { log.toasts.push("boom"); }
        function renderTerminalRail() {}
        ${extractFn("terminalRailArchivedKey")}
        ${extractFn("terminalRailArchiveSession")}
        return terminalRailArchiveSession;
      `)(log);
      fn("ghost");
      await flush();
      assert.deepEqual(log.posts, [], "找不到会话不发请求");
      assert.equal(log.toasts.length, 0, "也不提示");
      assert.equal(log.renders, 0, "不重渲");
    });
  });

  describe("静态挂点与文案", () => {
    it("点击委托：归档叉先判，抢在历史行续接之前", () => {
      const init = extractFn("initTerminalRail");
      const clickAt = init.indexOf('dir.addEventListener("click"');
      const block = init.slice(clickAt, init.indexOf("});", clickAt));
      assert.ok(block.indexOf("data-rail-term-archive") < block.indexOf("data-rail-term-resume"),
        "归档钮在行点击之前判（否则点了归档变成续接）");
    });

    it("toast 动作钮复用既有件：6s + actions 形状（M13 起多钮，单 action 兼容）", () => {
      const archive = extractFn("terminalRailArchiveSession");
      assert.ok(archive.includes('toast("会话已归档。"'), "文案逐字");
      assert.ok(archive.includes('label: "撤销"'), "动作文案逐字");
      assert.ok(archive.includes("durationMs: 6000"), "驻留 6s");
      // toast(msg, isErr, opts) 支持 opts.actions = [{label, onClick}, …]（M13 多钮）
      // 与 opts.action（单钮，既有调用形状不破）
      const toastFn = panelJs.match(/function toast\(msg, isErr, opts\)[\s\S]*?\n  \}/)?.[0];
      assert.ok(toastFn && toastFn.includes("opts.actions"), "toast 件有多钮入口");
      assert.ok(toastFn && toastFn.includes("opts.action"), "单 action 兼容保留");
    });

    it("CSS：归档钮 hover 才出现、时间让位、0ms 硬切无过渡", () => {
      const archive = panelCss.match(/\.rail-term-row-archive \{([^}]*)\}/);
      assert.ok(archive, "归档钮样式在册");
      assert.ok(archive[1].includes("display: none"), "静息不占位");
      assert.ok(!/transition/.test(archive[1]), "无过渡（0ms 硬切，dsh 同口径）");
      assert.ok(panelCss.includes(".rail-term-row-history:hover .rail-term-row-archive { display: inline-flex; }"),
        "hover 出归档钮（只限历史行）");
      assert.ok(panelCss.includes(".rail-term-row-history:hover .rail-term-row-time { display: none; }"),
        "hover 时时间让位动作钮（dsh 同款取舍，见既有注释）");
      assert.ok(!panelCss.includes(".rail-term-row-open:hover .rail-term-row-archive"),
        "「打开的终端」行没有归档钮（打开中的终端不受归档影响）");
    });

    it("文案清单逐字：归档会话 / 会话已归档。/ 撤销，不新造", () => {
      const body = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      for (const copy of ["归档会话", "会话已归档。", "撤销"]) {
        assert.ok(body.includes(copy), `栏体文案「${copy}」在册`);
      }
      // 取消归档钮的文案口径（M8 T7a 起）：归档行在「全部会话（显示已归档）」筛选下
      // 内联显示，hover 出「取消归档」钮（m6b §A2 第三恢复入口，恢复链由此补齐），
      // 与 toast 的「撤销」动作并存；上屏文案里「取消归档」只作为该钮的 title/aria，
      // 不进任何 toast 句子。
      const railStatic = panelHtml.slice(panelHtml.indexOf('id="railTerminalDir"'), panelHtml.indexOf('class="rail-foot"'));
      assert.ok(!railStatic.includes("取消归档"), "栏体静态文案无「取消归档」");
      for (const forbidden of ['toast("取消归档', 'toast("已取消归档']) {
        assert.ok(!body.includes(forbidden), `上屏文案无「${forbidden}」`);
      }
      // 失败兜底两句逐字（用户 2026-10-21 措辞修正：没能→未能）
      assert.ok(body.includes('"归档未能保存，请重试"'), "归档失败兜底逐字");
      assert.ok(body.includes('"取消归档未能保存，请重试"'), "取消归档失败兜底逐字");
      assert.ok(!body.includes("没能保存"), "旧措辞「没能保存」清零");
    });
  });
});

describe("S2 分组移除（finding 1b）", () => {
  describe("归组切换（vm 真跑）", () => {
    const GROUPS = [
      { key: "", label: "未分组", rows: [{ id: "u-1", lastActive: 50 }], latest: 50 },
      { key: "C:\\dev\\alpha", label: "alpha", rows: [{ id: "a-1", lastActive: 100 }], latest: 100 },
      { key: "C:\\dev\\beta", label: "beta", rows: [{ id: "b-1", lastActive: 200 }], latest: 200 },
    ];

    const runRegroup = (removedGroups) => {
      const fn = new Function("groups", "removed", `
        const terminalRailPrefs = { archived: [], removedGroups: removed };
        ${extractFn("terminalRailNormDir")}
        ${extractFn("terminalRailSameDir")}
        ${extractFn("terminalRailRegroupRemoved")}
        return terminalRailRegroupRemoved;
      `)(GROUPS, removedGroups);
      return fn;
    };

    it("被移除目录的会话落「未分组」；空组消失；未分组不提供移除", () => {
      const out = runRegroup(["C:\\dev\\alpha"])(
        JSON.parse(JSON.stringify(GROUPS)),
      );
      assert.deepEqual(out.map((g) => g.key), ["", "C:\\dev\\beta"], "被移除组整组消失（它的行已迁走）");
      const ungrouped = out[0];
      assert.deepEqual(ungrouped.rows.map((r) => r.id), ["a-1", "u-1"], "alpha 的行按最近活跃插进未分组（a-1 200? 不——100>50 排前）");
      const beta = out.find((g) => g.key === "C:\\dev\\beta");
      assert.deepEqual(beta.rows.map((r) => r.id), ["b-1"], "没被移除的组原样");
    });

    it("未分组原先不存在：新建一个并沉底", () => {
      // 入参必须深拷贝：terminalRailRegroupRemoved 会就地清空被移除组的 rows
      // （panel.js「group.rows = []」），filter 浅拷贝的元素仍是夹具原对象——
      // 不拷贝就把模块级 GROUPS 永久污染，后面「归一化口径」用例的 alpha 组
      // 变空组被整体丢弃、断言恒真（普查 finding：测试隔离缺陷）。
      const out = runRegroup(["c:/dev/alpha"])(
        JSON.parse(JSON.stringify(GROUPS)).filter((g) => g.key !== ""),
      );
      assert.deepEqual(out.map((g) => g.key), ["C:\\dev\\beta", ""], "未分组新建且沉底");
      assert.deepEqual(out[1].rows.map((r) => r.id), ["a-1"], "alpha 的行进未分组");
      // 夹具完好性：本用例不得动到共享 GROUPS（后续用例还要用它取快照）
      assert.equal(GROUPS.find((g) => g.key === "C:\\dev\\alpha").rows.length, 1,
        "共享夹具不被就地改写（深拷贝入参）");
    });

    it("清单为空：原样返回（不复制、不重排）", () => {
      const input = JSON.parse(JSON.stringify(GROUPS));
      const out = runRegroup([])(input);
      assert.equal(out, input, "零移除时连数组都不换（1s 轮询每拍都走，省一次深拷）");
    });

    it("归一化口径同 store：大小写/斜杠/尾斜杠不同拼写都命中", () => {
      for (const spelling of ["C:\\Dev\\Alpha", "c:/dev/alpha/", "C:\\DEV\\ALPHA"]) {
        const out = runRegroup([spelling])(JSON.parse(JSON.stringify(GROUPS)));
        assert.ok(!out.some((g) => g.key === "C:\\dev\\alpha"), `${spelling} 命中 alpha 组`);
      }
    });
  });

  describe("渲染：移除区与恢复区（vm 真跑）", () => {
    const HISTORY = {
      endpoint: "kimi",
      sessions: [
        { id: "a-1", endpoint: "kimi", project: "C:\\dev\\alpha", title: "重构权限矩阵", lastActive: 100 },
        { id: "b-1", endpoint: "kimi", project: "C:\\dev\\beta", title: "接入渠道", lastActive: 200 },
        { id: "u-1", endpoint: "kimi", project: null, title: "无归属会话", lastActive: 50 },
      ],
      fetchedAt: 1,
      error: null,
    };

    it("移除后：该目录的组头不再出现，行渲染进「未分组」", () => {
      const sandbox = renderSandbox({
        history: HISTORY,
        prefs: { archived: [], removedGroups: ["C:\\dev\\alpha"] },
      });
      sandbox.fn.render("kimi");
      assert.ok(!sandbox.list.html.includes('data-rail-term-group="C:\\dev\\alpha"'), "被移除目录没有组头");
      assert.ok(sandbox.list.html.includes('data-rail-term-group="C:\\dev\\beta"'), "beta 组头照旧");
      assert.ok(sandbox.list.html.includes(">未分组<"), "未分组组头在册");
      assert.ok(sandbox.list.html.includes('data-rail-term-resume="a-1"'), "alpha 的会话落到未分组里");
    });

    it("「已移除的分组」区整块拆除：移除只体现为组消失＋会话落未分组", () => {
      const sandbox = renderSandbox({
        history: HISTORY,
        prefs: { archived: [], removedGroups: ["C:\\dev\\alpha", "C:\\dev\\gamma"] },
      });
      sandbox.fn.render("kimi");
      assert.ok(!sandbox.list.html.includes("已移除的分组"), "区头不再出现");
      assert.ok(!sandbox.list.html.includes("data-rail-term-restore-group"), "恢复钮不再出现");
      assert.ok(!sandbox.list.html.includes("rail-term-removed"), "区容器与行样式挂点不再出现");
      assert.ok(!sandbox.list.html.includes(">恢复<"), "「恢复」文案不再出现");
      assert.ok(sandbox.list.html.includes(">未分组<"), "被移除目录的会话照旧落未分组");
    });

    it("自愈：移除之后来的新会话让组自动重现，并按 restore-group 落盘", async () => {
      const history = {
        endpoint: "kimi",
        sessions: [
          { id: "a-1", endpoint: "kimi", project: "C:\\dev\\alpha", title: "旧", lastActive: 100 },
        ],
        fetchedAt: 1,
        error: null,
      };
      const sandbox = renderSandbox({
        history,
        prefs: { archived: [], removedGroups: ["C:\\dev\\alpha"] },
        removedAt: { "c:\\dev\\alpha": 1000 },
      });
      sandbox.fn.render("kimi");
      assert.ok(!sandbox.list.html.includes('data-rail-term-group="C:\\dev\\alpha"'), "旧会话不触发自愈");
      assert.deepEqual(sandbox.state.posts, [], "无新会话不发请求");
      assert.deepEqual(sandbox.fn.prefs().removedGroups, ["C:\\dev\\alpha"], "移除清单原样");

      history.sessions.push({ id: "a-2", endpoint: "kimi", project: "C:\\dev\\alpha", title: "新", lastActive: 2000 });
      sandbox.fn.render("kimi");
      assert.ok(sandbox.list.html.includes('data-rail-term-group="C:\\dev\\alpha"'), "新会话到来自愈成组");
      assert.deepEqual(sandbox.fn.prefs().removedGroups, [], "目录从本地移除清单摘掉");
      assert.deepEqual(sandbox.state.posts,
        [{ method: "POST", path: "/api/terminal/rail/restore-group", body: { dir: "C:\\dev\\alpha" } }],
        "按既有恢复路由落盘（store 与本地同一份）");
      await flush();
      assert.equal(sandbox.fn.removedAt()["c:\\dev\\alpha"], undefined, "落盘成功后移除时刻随条目一起清掉");
    });

    it("自愈只认「新」会话：没有移除时刻的老条目不自愈，组保持隐藏", () => {
      const sandbox = renderSandbox({
        history: {
          endpoint: "kimi",
          sessions: [{ id: "a-2", endpoint: "kimi", project: "C:\\dev\\alpha", title: "新", lastActive: 999999 }],
        },
        prefs: { archived: [], removedGroups: ["C:\\dev\\alpha"] },
        removedAt: {},
      });
      sandbox.fn.render("kimi");
      assert.ok(!sandbox.list.html.includes('data-rail-term-group="C:\\dev\\alpha"'), "没有时间轴就不猜：保持隐藏");
      assert.deepEqual(sandbox.state.posts, [], "不发请求");
      assert.deepEqual(sandbox.fn.prefs().removedGroups, ["C:\\dev\\alpha"], "清单不动");
    });

    it("自愈落盘失败：目录回到移除清单、移除时刻保留，本会话不再重试", async () => {
      const history = {
        endpoint: "kimi",
        sessions: [{ id: "a-2", endpoint: "kimi", project: "C:\\dev\\alpha", title: "新", lastActive: 2000 }],
        fetchedAt: 1,
        error: null,
      };
      const sandbox = renderSandbox({
        history,
        prefs: { archived: [], removedGroups: ["C:\\dev\\alpha"] },
        removedAt: { "c:\\dev\\alpha": 1000 },
        apiImpl: async () => { throw new Error("HTTP 500：disk"); },
      });
      sandbox.fn.render("kimi");
      await flush();
      assert.equal(sandbox.state.posts.length, 1, "只发一次 restore-group");
      assert.deepEqual(sandbox.fn.prefs().removedGroups, ["C:\\dev\\alpha"], "失败回退：目录回到移除清单");
      assert.equal(sandbox.fn.removedAt()["c:\\dev\\alpha"], 1000, "移除时刻保留（重载后仍可据此自愈）");
      assert.ok(!sandbox.list.html.includes('data-rail-term-group="C:\\dev\\alpha"'), "失败后组仍隐藏");

      sandbox.fn.render("kimi");
      await flush();
      assert.equal(sandbox.state.posts.length, 1, "本会话不再重试");
    });

    it("自愈判据 createdAt 优先于 lastActive：旧 createdAt 不被新 lastActive 顶掉", () => {
      const sandbox = renderSandbox({
        history: {
          endpoint: "dsh",
          sessions: [{ id: "a-1", endpoint: "dsh", project: "C:\\dev\\alpha", title: "旧", createdAt: 500, lastActive: 2000 }],
        },
        prefs: { archived: [], removedGroups: ["C:\\dev\\alpha"] },
        removedAt: { "c:\\dev\\alpha": 1000 },
      });
      sandbox.fn.render("dsh");
      assert.ok(!sandbox.list.html.includes('data-rail-term-group="C:\\dev\\alpha"'), "createdAt 早于移除时刻就不算新会话");
      assert.deepEqual(sandbox.state.posts, [], "不发请求");
      assert.deepEqual(sandbox.fn.prefs().removedGroups, ["C:\\dev\\alpha"], "清单不动");
    });
  });

  describe("移除/恢复交互（vm 真跑）", () => {
    const runFlow = ({ apiImpl, prefs = { archived: [], removedGroups: [] }, removedAt = {} } = {}) => {
      const log = { posts: [], toasts: [], modals: [], renders: 0, menuClosed: 0, saved: 0, collapsedSaved: 0 };
      const fn = new Function("log", "apiImpl", "prefs", "removedAt", `
        let terminalRailPrefs = prefs;
        let terminalRailFlipMode = "instant";
        const terminalRailRemovedAt = removedAt;
        const terminalRailSelfHealFailed = new Set();
        const terminalRailCollapsedGroups = new Set();
        function saveTerminalRailCollapsedGroups() { log.collapsedSaved += 1; }
        function api(method, path, body) { log.posts.push({ method, path, body }); return apiImpl(method, path, body); }
        function toast(msg, isErr) { log.toasts.push({ msg, isErr }); }
        function panelError(err, fallback) { return fallback; }
        function renderTerminalRailHistory() { log.renders += 1; }
        function terminalRailAgentId() { return "kimi"; }
        function closeTerminalRailGroupMenu() { log.menuClosed += 1; }
        function sessDirName(p) { return String(p || "").replace(/\\\\/g, "/").split("/").filter(Boolean).pop() || p || ""; }
        function escapeHtml(v) { return String(v || ""); }
        function showSkillsModal(opts) { log.modals.push(opts); opts.onConfirm(); }
        function saveTerminalRailRemovedAt() { log.saved += 1; }
        ${extractFn("terminalRailNormDir")}
        ${extractFn("terminalRailSameDir")}
        ${extractFn("terminalRailRemoveGroup")}
        ${extractFn("terminalRailCommitRemoveGroup")}
        return {
          remove: terminalRailRemoveGroup,
          commit: terminalRailCommitRemoveGroup,
          prefs: () => terminalRailPrefs,
          removedAt: () => terminalRailRemovedAt,
        };
      `)(log, apiImpl ?? (async () => ({ ok: true })), prefs, removedAt);
      return { fn, log };
    };

    it("⋯ → 「移除分组」：红色确认弹窗，文案逐字，确认即本地生效 + POST", async () => {
      const { fn, log } = runFlow();
      fn.remove("C:\\dev\\alpha");
      assert.equal(log.modals.length, 1, "弹确认弹窗（复用共用确认件）");
      const modal = log.modals[0];
      assert.equal(modal.title, "移除分组", "标题逐字");
      assert.equal(modal.confirmText, "移除分组", "确认钮逐字");
      assert.equal(modal.danger, true, "红色 danger 项");
      assert.equal(modal.bodyHtml,
        "把“alpha”从会话栏移除。文件夹和会话记录都会保留，里面的会话会显示在“未分组”下。",
        "正文逐字（目录短名代入）");
      // 桩里 onConfirm 被同步调起：本地先生效、POST 落盘
      assert.deepEqual(fn.prefs().removedGroups, ["C:\\dev\\alpha"], "本地先进清单（瞬时重排，不等网络）");
      // 两次收场：开弹窗前收一次（M10-F2，菜单不许压弹窗）＋确认后 commit 里再收一次
      assert.equal(log.menuClosed, 2, "菜单收起（F2 开弹窗前 + commit 后各一次）");
      assert.deepEqual(log.posts, [{ method: "POST", path: "/api/terminal/rail/remove-group", body: { dir: "C:\\dev\\alpha" } }],
        "POST 带目录原始拼写");
      await flush();
    });

    it("确认弹窗不复用新件：走 showSkillsModal（danger 形制）", () => {
      const src = extractFn("terminalRailRemoveGroup");
      assert.ok(src.includes("showSkillsModal({"), "复用 panel 既有共用确认 modal");
      assert.ok(src.includes("danger: true"), "红色确认钮");
      assert.ok(!src.includes("createElement"), "不新写弹窗件");
    });

    it("移除时记下时刻（自愈判据）：本地清单＋时间戳同拍写入，落盘后仍保留", async () => {
      const { fn, log } = runFlow({ prefs: { archived: [], removedGroups: ["C:\\dev\\beta"] } });
      fn.commit("C:/Dev/Alpha/");
      assert.deepEqual(fn.prefs().removedGroups, ["C:\\dev\\beta", "C:/Dev/Alpha/"], "清单进原始拼写");
      const stamp = fn.removedAt()["c:\\dev\\alpha"];
      assert.ok(stamp > 0, "时间戳按归一化键记");
      assert.equal(fn.removedAt()["c:/dev/alpha/"], undefined, "只记一条（归一化去重）");
      assert.ok(log.saved >= 1, "时间戳落 localStorage");
      await flush();
      assert.ok(fn.removedAt()["c:\\dev\\alpha"] > 0, "POST 成功后时间戳不被回滚");
    });

    it("落盘失败：回退本地态＋时间戳 + 错误提示", async () => {
      const { fn, log } = runFlow({ apiImpl: async () => { throw new Error("HTTP 500：disk"); } });
      fn.commit("C:\\dev\\alpha");
      await flush();
      assert.deepEqual(fn.prefs().removedGroups, [], "失败回退");
      assert.equal(fn.removedAt()["c:\\dev\\alpha"], undefined, "时间戳一并回退（不留半条自愈轴）");
      assert.equal(log.toasts.length, 1, "一句错误提示");
      assert.equal(log.toasts[0].isErr, true, "按错误上屏");
    });

    it("重复移除同一目录：无事可做（幂等）", async () => {
      const { fn, log } = runFlow({ prefs: { archived: [], removedGroups: ["C:\\dev\\alpha"] } });
      fn.commit("c:/dev/alpha");
      assert.deepEqual(fn.prefs().removedGroups, ["C:\\dev\\alpha"], "清单不重复");
      assert.deepEqual(log.posts, [], "不发请求");
    });

    it("点击委托：菜单开关 / 移除分组分支在册，恢复区分支已随区拆掉", () => {
      const init = extractFn("initTerminalRail");
      for (const attr of ["data-rail-term-group-menu", "data-rail-term-remove-group"]) {
        assert.ok(init.includes(attr), `委托分支 ${attr} 在册`);
      }
      for (const gone of ["data-rail-term-restore-group", "data-rail-term-removed-toggle", "terminalRailRestoreGroup", "toggleTerminalRailRemoved"]) {
        assert.ok(!init.includes(gone), `恢复区挂点 ${gone} 已清除`);
      }
      // 移除分组必须走带确认弹窗的入口（M7 复审必修 1）：委托直接调 commit 版会把
      // 红色确认弹窗整个绕过——点一下就真移除，没有任何二次确认。
      // M9 复审必修 1 起该分支随菜单 portal 搬到 document 级委托（先判菜单项后走
      // 收场），dir 委托里只留注释指向——断链的真 DOM 守卫见「M9 复审必修」用例。
      const docAt = init.indexOf('document.addEventListener("click"');
      const docBlock = init.slice(docAt, init.indexOf("});", docAt));
      const removeBranch = docBlock.slice(docBlock.indexOf("data-rail-term-remove-group"), docBlock.indexOf("terminalRailRemoveGroup(") + 40);
      assert.ok(removeBranch.includes("terminalRailRemoveGroup("),
        "document 委托的菜单项分支调 terminalRailRemoveGroup（开弹窗），不是 commit 版");
      assert.ok(!removeBranch.includes("terminalRailCommitRemoveGroup("),
        "委托不许直接调 commit 版（那等于绕过确认弹窗）");
      assert.ok(docBlock.includes("terminalRailRemoveGroup("), "terminalRailRemoveGroup 有生产调用点（不是死代码）");
      // 菜单项分支必须排在收场逻辑之前（先办事后收场，否则项点击会被当成点外面）
      assert.ok(docBlock.indexOf("data-rail-term-view") < docBlock.indexOf("terminalRailMenuEl"),
        "菜单项分支先于收场逻辑（视图菜单项）");
      assert.ok(docBlock.indexOf("data-rail-term-remove-group") < docBlock.indexOf("terminalRailMenuEl"),
        "菜单项分支先于收场逻辑（移除分组项）");
    });
  });

  describe("S2 静态与文案", () => {
    it("确认弹窗文案逐字（含弯引号），不新造一字", () => {
      const body = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      assert.ok(body.includes("把“"), "正文起手逐字");
      assert.ok(body.includes("”从会话栏移除。文件夹和会话记录都会保留，里面的会话会显示在“未分组”下。"), "正文余下逐字");
      assert.ok(body.includes('title: "移除分组"'), "弹窗标题逐字");
      assert.ok(body.includes('confirmText: "移除分组"'), "确认钮逐字");
      assert.ok(!body.includes("已移除的分组"), "「已移除的分组」区整块拆掉（不是隐藏）");
      assert.ok(!body.includes(">恢复<"), "「恢复」钮文案随之消失");
      // 唯一保留的失败兜底（移除）；恢复区的兜底随恢复路径一起拆掉
      assert.ok(body.includes('"分组移除未能保存，请重试"'), "移除失败兜底逐字");
      assert.ok(!body.includes("分组恢复未能保存"), "恢复区兜底随区拆掉");
      assert.ok(!body.includes("没能保存"), "旧措辞「没能保存」清零");
    });

    it("「未分组」组不提供移除：组头不给 ⋯（S3 同款豁免）", () => {
      const render = extractFn("renderTerminalRailHistory");
      const headAt = render.indexOf("rail-term-group-head");
      assert.ok(headAt > 0, "组头渲染可取样");
      // 组头动作钮的渲染必须绕开未分组：钉死 headActions 三元的条件就是组键真值，
      // 且 ⋯ 钮落在有键分支里（旧断言只匹配属性插值自身，改弱/反转条件也过——普查 finding）。
      const actionsAt = render.indexOf("const headActions");
      assert.ok(actionsAt > 0, "动作区渲染可取样");
      const elseAt = render.indexOf(': "";', actionsAt);
      assert.ok(elseAt > 0, "动作区有无键分支的空串兜底");
      const block = render.slice(actionsAt, elseAt + ': "";'.length);
      assert.match(block, /const headActions = group\.key\s*\?/,
        "动作区只在有目录键的组渲染（条件反转/改弱/删除都过不了这条）");
      assert.ok(block.includes('data-rail-term-group-menu="${esc(group.key)}"'), "⋯ 钮挂组键且在有键分支内");
    });

    it("CSS：菜单容器与 danger 项在册，0ms 硬切；恢复区样式已随区拆掉", () => {
      assert.ok(cssRule(".rail-term-menu {").length > 0, "⋯ 菜单容器样式在册（可扩：M8 加项只加 DOM）");
      const danger = panelCss.match(/\.rail-term-menu-item\.is-danger \{([^}]*)\}/);
      assert.ok(danger, "danger 项样式在册");
      assert.ok(danger[1].includes("var(--danger)"), "danger 项取既有危险色 token");
      assert.ok(!panelCss.includes(".rail-term-removed"), "「已移除的分组」区样式整块拆掉");
      assert.ok(!panelCss.includes(".rail-term-row-restore"), "「恢复」钮样式整块拆掉");
      assert.ok(!/\.rail-term-menu[^{]*\{[^}]*transition/.test(panelCss), "菜单无过渡（0ms 硬切）");
    });
  });
});

describe("S3 组头三件（dsh 工作区行按钮，m6b §B）", () => {
  describe("⊕ 在此目录新建终端（vm 真跑）", () => {
    const runCreate = ({ collapsed = [], agentId = "kimi", ready = true, apiImpl, sessions = {}, activeId = null, agentsImpl, hostReadImpl, switchImpl } = {}) => {
      const log = { posts: [], gets: [], switchBodies: [], renders: 0, collapsed: new Set(collapsed) };
      const fn = new Function("log", "apiImpl", "agentId", "ready", "sessions", "activeId", "agentsImpl", "hostReadImpl", "switchImpl", `
        let terminalBackendReady = ready;
        let terminalRailFlipMode = "instant";
        let terminalSwitchInFlight = false;
        let activeTerminalPreviewId = activeId;
        const terminalBackendSessions = sessions;
        ${viewportPrelude(["terminalViewportNextId", "terminalViewportCreate", "terminalViewportActive", "terminalViewportForTerminal", "terminalRailKeepAliveSwitch"])}
        function armTerminalBootingOverlay() {}
        function terminalRailFindOpenSession() { return null; }
        const terminalRailCollapsedGroups = log.collapsed;
        function saveTerminalRailCollapsedGroups() { log.saved = (log.saved || 0) + 1; }
        function api(method, path, body) {
          log.gets.push({ method, path });
          if (method === "GET" && path === "/api/agents") return Promise.resolve(agentsImpl());
          if (method === "GET" && path.startsWith("/api/terminal/sessions/")) return hostReadImpl();
          if (method === "POST" && path.endsWith("/switch")) { log.switchBodies.push(body); return Promise.resolve(switchImpl()); }
          return Promise.reject(new Error("unexpected " + method + " " + path));
        }
        function enrichTerminalSessions(agents) {
          const row = Array.isArray(agents) && agents[0] && Array.isArray(agents[0].instances) ? agents[0].instances[0] : null;
          const working = !!(row && row.activeRequests > 0);
          for (const s of Object.values(terminalBackendSessions)) if (s.agent) s.status = working ? "working" : "idle";
        }
        function createAgentTerminal(opts) { log.posts.push(opts); return apiImpl(opts); }
        function terminalBackendSession(item) { return { ...item }; }
        function renderTerminalPreviewSession() { log.renders += 1; }
        function renderTerminalRailHistory() { log.renders += 1; }
        function terminalSessionFor(id) { return terminalBackendSessions[id] || null; }
        function toast() {}
        function panelError(err, fallback) { return fallback; }
        function terminalRailAgentId() { return agentId; }
        function terminalRailEndSelect() {}
        function terminalRailBeginSelect(session) { log.armed = (log.armed || []).concat(session); }
        function terminalRailArmSelect(session) { log.armed = (log.armed || []).concat(session); }
        ${extractFn("terminalRailNormDir")}
        ${extractFn("terminalRailSwitchOrCreateCore")}
        ${extractFn("terminalRailCreateTerminalInDir")}
        return terminalRailCreateTerminalInDir;
      `)(log, apiImpl ?? (() => Promise.resolve()), agentId, ready, sessions, activeId,
        agentsImpl ?? (async () => ({ agents: [{ id: "kimi", instances: [{ id: "inst-1", activeRequests: 0 }] }] })),
        hostReadImpl ?? (async () => ({ id: "t-a", status: "running" })),
        switchImpl ?? (async () => ({ id: "t-a", status: "running", resume: null })));
      return { fn, log };
    };

    it("点击＝先展开该组（若收起）＋以该组目录为 cwd 建终端（无活跃页签落新开）", async () => {
      const { fn, log } = runCreate({ collapsed: ["c:\\dev\\alpha"] });
      fn("C:\\dev\\alpha");
      assert.equal(log.collapsed.has("c:\\dev\\alpha"), false, "收起的组先展开");
      assert.deepEqual(log.posts, [{ agentId: "kimi", cwd: "C:\\dev\\alpha", resume: null }],
        "无从内切走 createAgentTerminal 通路，cwd＝组目录，全新建不带 resume");
      await flush();
    });

    it("idle 聚焦页签：⊕ 就地换新会话（与「新建会话」同门），POST 体带 agentId＋组目录 cwd", async () => {
      const { fn, log } = runCreate({
        collapsed: ["c:\\dev\\alpha"],
        sessions: { "t-a": { id: "t-a", backend: true, agentId: "kimi", agent: { endpointId: "kimi", instanceId: "inst-1" }, resume: { endpoint: "kimi", id: "s-old" }, status: "idle" } },
        activeId: "t-a",
      });
      fn("C:\\dev\\alpha");
      await flush();
      assert.equal(log.collapsed.has("c:\\dev\\alpha"), false, "收起的组照常先展开");
      assert.deepEqual(log.switchBodies, [{ agentId: "kimi", cwd: "C:\\dev\\alpha" }], "内切体必须带目标 agentId 与组目录，无 resume 键");
      assert.deepEqual(log.posts, [], "不开新页签");
    });

    it("working 聚焦页签：旧终端留后台保活、目标终端换进当前视口，不发 /switch、不加页签", async () => {
      const { fn, log } = runCreate({
        sessions: { "t-a": { id: "t-a", backend: true, agentId: "kimi", agent: { endpointId: "kimi", instanceId: "inst-1" }, resume: { endpoint: "kimi", id: "s-old" }, status: "idle" } },
        activeId: "t-a",
        agentsImpl: async () => ({ agents: [{ id: "kimi", instances: [{ id: "inst-1", activeRequests: 1 }] }] }),
      });
      fn("C:\\dev\\alpha");
      await flush();
      assert.deepEqual(log.posts, [{ agentId: "kimi", cwd: "C:\\dev\\alpha", resume: null }], "只建目标终端，cwd＝组目录");
      assert.deepEqual(log.switchBodies, [], "旧终端在跑：不走 /switch（树杀会中断任务）");
    });

    it("已展开的组不重复展开；未就绪（就绪闸）不建", () => {
      const opened = runCreate({ collapsed: [] });
      opened.fn("C:\\dev\\alpha");
      assert.equal(opened.log.collapsed.size, 0, "已展开不动组态");
      assert.equal(opened.log.renders, 0, "不重渲");
      const notReady = runCreate({ ready: false });
      notReady.fn("C:\\dev\\alpha");
      assert.deepEqual(notReady.log.posts, [], "未就绪不建（与页签栏加号同拍的就绪闸）");
    });

    it("源码钉死：不写无 agent 分支——历史段只在有 agent 聚焦时有内容，⊕ 天然有 agentId", () => {
      const fn = extractFn("terminalRailCreateTerminalInDir");
      assert.ok(fn.includes("terminalRailSwitchOrCreateCore({ agentId: terminalRailAgentId(), cwd: key })"), "与「新建会话」同一道内切判定门");
      assert.ok(!fn.includes('agentId: ""'), "没有为无 agent 兜底的代码路径");
      // 理由写在函数上方的注释里（栏体代码段内）
      const block = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      assert.ok(block.includes("历史会话段只在有 agent 聚焦时"), "注释说明为何无需无 agent 分支");
    });

    it("委托与文案：⊕ 钮挂组键，title/aria-label 逐字「在此目录新建终端」", () => {
      const render = extractFn("renderTerminalRailHistory");
      assert.ok(render.includes('data-rail-term-group-new="${esc(group.key)}"'), "⊕ 挂组键");
      assert.ok(render.includes('title="在此目录新建终端"'), "title 逐字");
      assert.ok(render.includes('aria-label="在此目录新建终端"'), "无障碍名同词");
      const init = extractFn("initTerminalRail");
      const clickAt = init.indexOf('dir.addEventListener("click"');
      const block = init.slice(clickAt, init.indexOf("});", clickAt));
      assert.ok(block.indexOf("data-rail-term-group-new") < block.indexOf('data-rail-term-group"'),
        "⊕ 抢在组折叠之前判（点⊕ 变成折叠就错了）");
    });
  });

  describe("hover 卡（源码 + CSS）", () => {
    it("800ms 延迟、三行内容、整卡复制路径 + 「已复制」", () => {
      const src = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      assert.ok(src.includes("TERMINAL_RAIL_HOVER_DELAY_MS = 800"), "延迟 800ms（dsh 同值）");
      assert.ok(src.includes("个会话"), "第三行「N 个会话」");
      assert.ok(src.includes('sessCopyText(key, "已复制")'), "整卡点击复制完整路径，反馈「已复制」（复用既有手法）");
      assert.ok(src.includes("pointerover") && src.includes("pointerout"), "指针进出驱动显隐");
    });

    it("⋯ 菜单打开期间抑制 hover 卡（dsh 的 disabled: menuOpen 同口径）", () => {
      const src = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      assert.ok(/if \(!head \|\| !key \|\| terminalRailMenuKey\) return/.test(src),
        "菜单开着不排卡");
      assert.ok(src.includes("closeTerminalRailHoverCard()") && src.includes("openTerminalRailGroupMenu"),
        "开菜单即收卡（菜单后开的情形）");
    });

    it("CSS：hover 卡三行样式在册，fixed + 高 z-index（portal 同款）", () => {
      const card = cssRule(".rail-term-hover-card {");
      assert.ok(card.includes("position: fixed"), "挂 body 下 fixed（栏体 overflow 会切卡）");
      assert.ok(card.includes("z-index: 1200"), "与右键菜单同档");
      assert.ok(panelCss.includes(".rail-term-hover-name"), "第一行：目录短名");
      assert.ok(panelCss.includes(".rail-term-hover-path"), "第二行：完整路径");
      assert.ok(panelCss.includes(".rail-term-hover-count"), "第三行：N 个会话");
    });
  });

  describe("图标同槽互换（CSS 钉死，M14 照 dsh 尺寸与色档）", () => {
    it("非 hover 文件夹、hover 箭头同槽互换；槽 16×20，箭头 14×14、文件夹 16×16", () => {
      const slot = cssRule(".rail-term-group-slot {");
      assert.ok(slot.includes("width: 16px") && slot.includes("height: 20px"), "槽位 16×20（dsh 实测槽）");
      assert.ok(slot.includes("justify-content: center"), "两枚图标同槽居中（不产生宽度跳动）");
      assert.ok(panelCss.includes(".rail-term-group-head .rail-term-group-arrow { display: none; }"),
        "组头内箭头默认隐（非 hover 看文件夹）");
      assert.ok(panelCss.includes(".rail-term-group-head:hover .rail-term-group-arrow { display: inline-flex; }"),
        "hover 换上箭头（0ms 硬切）");
      assert.ok(panelCss.includes(".rail-term-group-head:hover .rail-term-group-icon { display: none; }"),
        "hover 收文件夹（同槽位互换）");
      const arrow = cssRule(".rail-term-group-arrow {");
      assert.ok(arrow.includes("transition: transform .15s ease-in-out"), "箭头 .15s ease-in-out（dsh 实测缓动）");
      assert.ok(arrow.includes("color: var(--text-4)"), "箭头吃 caption 级色（--text-4）");
      const icon = cssRule(".rail-term-group-icon {");
      assert.ok(icon.includes("color: var(--text-3)"), "文件夹静息吃三级文字色");
      assert.ok(panelCss.includes(".rail-term-group.is-open .rail-term-group-arrow { transform: rotate(90deg); }"),
        "展开态旋转 90°");
      assert.ok(!cssRule(".rail-term-group-head {").includes("transition"), "组头容器无过渡");
      assert.ok(!cssRule(".rail-term-group-btn {").includes("transition"), "动作钮无过渡（0ms 硬切）");
      assert.ok(!cssRule(".rail-term-group-toggle {").includes("transition"), "折叠开关无过渡（hover 底色 0ms 硬切）");
      assert.ok(!panelCss.includes(".rail-term-removed"), "已移除区的箭头旋转规则随区拆掉");
    });

    it("reduced-motion：箭头过渡压成 none", () => {
      const rm = panelCss.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.rail-term-group-arrow \{([^}]*)\}/);
      assert.ok(rm, "reduced-motion 分支在册");
      assert.ok(rm[1].includes("transition: none"), "过渡关掉（不做位移动画）");
    });

    it("SVG 数据与 dsh 一致（结构与关键特征）：闭合态两条描边、展开态三层实心、chevron 以 C5.95242 为准", () => {
      const iconOf = (name) => {
        const m = panelJs.match(new RegExp(`const ${name} = '([^']*)';`));
        assert.ok(m, `${name} 在册`);
        return m[1];
      };

      const closed = iconOf("TERMINAL_RAIL_ICON_FOLDER_CLOSED");
      assert.ok(closed.startsWith('<svg width="16" height="16" viewBox="0 0 16 16" fill="none"'), "闭合态 16×16 公共包裹");
      assert.ok(closed.includes('aria-hidden="true" stroke-width="1"'), "公共包裹属性逐字（1px 描边）");
      assert.equal((closed.match(/stroke="currentColor"/g) || []).length, 2, "两条描边 path（轮廓＋中线）");
      assert.ok(!closed.includes('fill="currentColor"'), "闭合态是空心轮廓，不填实");
      assert.ok(closed.includes('d="M3.63501 7.66614H12.3647"'), "中线 path 逐字");

      const open = iconOf("TERMINAL_RAIL_ICON_FOLDER_OPEN");
      assert.ok(open.startsWith('<svg width="16" height="16" viewBox="0 0 16 16" fill="none"'), "展开态 16×16 公共包裹");
      assert.equal((open.match(/fill="currentColor"/g) || []).length, 3, "三层实心填充");
      assert.ok(!open.includes('stroke="currentColor"'), "展开态不走描边");
      assert.ok(open.includes('opacity="0.16"'), "首条背板 16% 透明");
      assert.ok(open.indexOf('opacity="0.16"') < open.indexOf('fill="currentColor"') + 200,
        "透明背板是第一条 path（层序：背板→盒体→前舌）");
      assert.ok(open.includes('d="M4.7666 1.90137'), "前舌 path 逐字（长路径未被截断）");

      const chevron = iconOf("TERMINAL_RAIL_ICON_CHEVRON");
      assert.ok(chevron.startsWith('<svg width="14" height="14" viewBox="0 0 16 16" fill="none"'), "chevron 14×14、viewBox 16");
      assert.equal((chevron.match(/fill="currentColor"/g) || []).length, 1, "单条实心三角");
      assert.ok(!chevron.includes('stroke="currentColor"'), "箭头不吃描边");
      assert.ok(chevron.includes("C5.95242"), "附录勘误后的 path 值（C5.95242）");
      assert.ok(!chevron.includes("C6.95242"), "旧误读值 C6.95242 清零");
    });

    it("整行点击折叠/展开不变：toggle 钮仍是整行宽的开关", () => {
      const render = extractFn("renderTerminalRailHistory");
      assert.ok(render.includes('class="rail-term-group-toggle"'), "折叠开关是组头内的整行按钮");
      assert.ok(render.includes("rail-term-group-actions"), "动作钮是开关的兄弟（不吃它的点击）");
      const toggle = cssRule(".rail-term-group-toggle {");
      assert.ok(toggle.includes("flex: 1 1 auto"), "开关吃满剩余宽度（整行可点）");
    });
  });

  describe("S3 豁免与菜单容器", () => {
    it("「未分组」组：无 ⊕、无 ⋯、无 hover 卡（dsh 同口径）", () => {
      const render = extractFn("renderTerminalRailHistory");
      const actionsAt = render.indexOf("const headActions");
      assert.ok(actionsAt > 0, "动作钮渲染可取样");
      const block = render.slice(actionsAt, render.indexOf("parts.push(`", actionsAt));
      // 钉死条件本体（旧断言只查文本存在性，`group.key` 命中的是属性插值——普查 finding：
      // 把条件改成恒真/反转都照样过）。hover 卡豁免由 scheduleTerminalRailHoverCard
      // 的 `!key` 守卫承担（「⋯ 菜单打开期间抑制 hover 卡」用例已钉）。
      assert.match(block, /const headActions = group\.key\s*\?/, "动作钮的渲染条件就是组键真值");
      assert.ok(block.includes('data-rail-term-group-new="${esc(group.key)}"'), "⊕ 在有键分支（未分组无 ⊕）");
      assert.ok(block.includes('data-rail-term-group-menu="${esc(group.key)}"'), "⋯ 在有键分支（未分组无 ⋯）");
      assert.ok(block.includes(': ""'), "无组键（未分组）时动作区为空串");
    });

    it("⋯ 菜单容器可扩：单一挂点 + 项是可增的 DOM（M8 加项不开第二套浮层）", () => {
      const src = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      assert.ok(src.includes("function openTerminalRailGroupMenu(key)"), "单一开菜单挂点");
      assert.ok(/menu\.append\(item\)/.test(src), "菜单项是 append 进去的（可扩）");
    });
  });
});

describe("S4 底栏钉住（finding 2，m6 §3）", () => {
  describe("三层结构（HTML 钉死）", () => {
    it("栏体三层：顶区新建终端 / 段头（滚动层外）/ 中段唯一滚动层（树）/ 底栏亮暗返回", () => {
      const dir = panelHtml.match(/<nav class="rail-dir rail-terminal-dir" id="railTerminalDir"[\s\S]*?<\/nav>/);
      assert.ok(dir, "终端会话栏在册");
      const body = dir[0];
      // 顶区：新建终端钮在最上，且不在滚动层里
      assert.ok(body.indexOf('id="railTermNewBtn"') < body.indexOf('id="railTermSectionHead"'),
        "新建终端（顶区）在段头之前");
      // 段头是滚动层外的定高块（dsh：sectionHeader 在 regionArea 里 flex:none）
      assert.ok(body.indexOf('id="railTermSectionHead"') < body.indexOf('class="rail-term-scroll"'),
        "段头在滚动层之前（不随树滚）");
      // 中段：唯一滚动层里只有一棵工作区树（M8 T1 两段合并）
      const scroll = body.match(/<div class="rail-term-scroll">([\s\S]*?)<\/div>\s*<span class="rail-term-fade"/);
      assert.ok(scroll, "中段滚动层在册，且遮罩挂在它外面（不随内容滚）");
      assert.ok(scroll[1].includes('id="railTermHistoryList"'), "工作区树在滚动层内（live 行内联其中）");
      assert.ok(!scroll[1].includes('id="railTermOpenList"'), "「打开的终端」段已拆（M8 T1）");
      // 滚动层里不再套内层滚动容器（唯一滚动层）
      assert.ok(!body.includes("rail-term-history-scroll"), "无内层滚动容器（滚动只发生在中段）");
      // 底栏：亮暗/返回在栏体下，是 .rail 的flex 子项（本 nav 之外）
      const rail = panelHtml.match(/<aside class="rail" id="v2Rail"[\s\S]*?<\/aside>/)[0];
      assert.ok(rail.indexOf('id="railTerminalDir"') < rail.indexOf('class="rail-foot"'),
        "栏底行在终端会话栏之后（同一 flex 列的最后一项）");
      assert.ok(rail.includes('id="railThemeToggle"') && rail.includes('id="railBackBtn"'), "底栏＝亮暗 + 返回");
    });
  });

  describe("滚动条指针感知隐退（JS 钉死）", () => {
    it("指针在列内可见、离开 2s 隐退：变量替换瞬时消失，无淡出", () => {
      const src = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      assert.ok(src.includes("TERMINAL_RAIL_SCROLLBAR_LINGER_MS = 2000"), "滞留 2s（dsh 同值）");
      assert.ok(src.includes("pointerenter"), "进列即显");
      assert.ok(src.includes("pointerleave"), "出列即排隐退");
      assert.ok(src.includes("setTerminalRailQuiet(true)"), "初态隐退（thumb 随指针进列才出现）");
      assert.ok(src.includes('toggleAttribute("data-quiet"'), "隐退=属性开关（CSS 变量替换）");
      // 隐退不允许带过渡：变量替换必须瞬时（dsh 同口径）。剥掉注释再查——注释里
      // 出现「transition」二字是在立规矩，不是违规。
      const css = panelCss.replace(/\/\*[\s\S]*?\*\//g, "");
      const ruleBody = (sel) => {
        const at = css.indexOf(sel);
        assert.ok(at >= 0, `规则 ${sel} 在册`);
        return css.slice(at, css.indexOf("}", at));
      };
      assert.ok(!/transition/.test(ruleBody(".rail-term-scroll::-webkit-scrollbar-thumb {")), "thumb 规则无过渡（变量替换瞬时）");
      assert.ok(!/#railTerminalDir\[data-quiet\][^}]*transition/.test(css), "隐退态无过渡");
      assert.ok(!/transition/.test(ruleBody(".rail-term-scroll {")), "滚动层本体无过渡");
    });

    it("vm 真跑：进列清隐退、出列过了滞留期才隐，滞留期内回列不隐", async () => {
      const log = { attrs: [], timers: [] };
      const fn = new Function("log", `
        const els = { railTerminalDir: { attr: "", toggleAttribute(name, force) { this.attr = force ? name : ""; log.attrs.push(this.attr); } }, v2Rail: { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } } };
        const $ = (id) => els[id];
        let terminalRailQuietTimer = null;
        function setTerminalRailQuiet(quiet) {
          const dir = $("railTerminalDir");
          if (dir) dir.toggleAttribute("data-quiet", !!quiet);
        }
        // 滞留值只在沙盒内调小（生产 2000 已由上一条静态断言钉死），真跑不再等 2.1s
        // 墙钟——普查 finding：负载抖动时 100ms 余量可能提前断言。
        const TERMINAL_RAIL_SCROLLBAR_LINGER_MS = 40;
        ${extractFn("initTerminalRailScrollbarQuiet")}
        initTerminalRailScrollbarQuiet();
        return { enter: () => els.v2Rail.listeners.pointerenter(), leave: () => els.v2Rail.listeners.pointerleave() };
      `)(log);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      assert.deepEqual(log.attrs, ["data-quiet"], "初态隐退（thumb 随指针进列才出现）");
      fn.leave();
      await sleep(15);
      fn.enter();
      await sleep(120);
      assert.deepEqual(log.attrs.slice(-1), [""], "滞留期内回列：取消隐退排程，过了滞留点仍可见");
      fn.leave();
      await sleep(140);
      assert.deepEqual(log.attrs.slice(-1), ["data-quiet"], "离开过了滞留期才隐退");
      fn.enter();
      assert.deepEqual(log.attrs.slice(-1), [""], "进列即恢复可见");
    });
  });

  describe("设置态不碰坏（共用骨架）", () => {
    it("设置态换血四条与栏底共用件原样，钉底改造只动终端会话栏内部", () => {
      for (const scope of [
        ':root[data-ui-version="v2"] body.settings-mode',
        ':root[data-ui-version="v2"] body.terminal-mode',
      ]) {
        assert.ok(panelCss.includes(`${scope} #v2Rail .rail-tabs { display: none; }`), `${scope} 收主 tab 组`);
        assert.ok(panelCss.includes(`${scope} #v2Rail #railSettingsBtn { display: none; }`), `${scope} 收栏底齿轮`);
        assert.ok(panelCss.includes(`${scope} #v2Rail #railBackBtn[hidden] { display: flex !important; }`), `${scope} 放「返回」`);
      }
      // 钉底靠的是 .rail 自身的 flex 列 + 底栏 flex:none，两个态共用，不为终端态另起炉灶
      assert.ok(cssRule(".rail-foot {").includes("flex: none"), "底栏两个态共用同一 flex:none");
      assert.ok(!panelCss.includes("body.terminal-mode .rail-foot { position"), "终端态不给底栏加定位（不破坏共用骨架）");
    });
  });
});

describe("S5 去重聚焦（finding 3，用户选甲）", () => {
  describe("历史会话点击两分支（vm 真跑）", () => {
    const runResume = (sessions, activeId, apiImpl) => {
      const log = { posts: [], toasts: [], renders: 0, remembered: [] };
      const fn = new Function("sessions", "activeId", "log", "apiImpl", `
        let terminalBackendReady = true;
        const terminalBackendSessions = sessions;
        let activeTerminalPreviewId = activeId;
        const terminalDoneUnread = new Map();
        ${viewportPrelude()}
        function armTerminalBootingOverlay() {}
        function api(method, path, body) { log.posts.push({ method, path, body }); return apiImpl(method, path, body); }
        function toast(msg, isErr) { log.toasts.push({ msg, isErr }); }
        function panelError(err, fallback) { return fallback; }
        function terminalBackendSession(item) { return { ...item }; }
        function rememberTerminalSessionId(id) { log.remembered.push(id); }
        function renderTerminalPreviewSession() { log.renders += 1; }
        function terminalCreateSize() { return { cols: 120, rows: 34 }; }
        function terminalSessionFor(id) { return terminalBackendSessions[id] || null; }
        const terminalRailPrefs = { archived: [], removedGroups: [] };
        ${extractFn("terminalRailArchivedKey")}
        ${extractFn("terminalRailIsArchived")}
        ${extractFn("terminalRailSessionMap")}
        ${extractFn("terminalRailFindOpenSession")}
        ${extractFn("terminalRailActivateSession")}
        let terminalRailSelectPending = null;
        let terminalRailSelectSeq = 0;
        const TERMINAL_RAIL_SELECT_TTL_MS = 12000;
        function renderTerminalRail() { log.railRenders = (log.railRenders || 0) + 1; }
        ${extractFn("terminalRailSwitchBusy")}
        ${extractFn("terminalRailBeginSelect")}
        ${extractFn("terminalRailArmSelect")}
        ${extractFn("terminalRailEndSelect")}
        ${extractFn("createAgentTerminal")}
        let terminalSwitchInFlight = false;
        function enrichTerminalSessions() {}
        ${extractFn("terminalRailSwitchOrCreateCore")}
        ${extractFn("terminalRailSwitchOrCreate")}
        ${extractFn("terminalRailResumeSession")}
        return {
          resume: terminalRailResumeSession,
          activeId: () => activeTerminalPreviewId,
          pending: () => terminalRailSelectPending,
          setBusy: (busy) => { terminalSwitchInFlight = busy; },
          endSelect: (token) => terminalRailEndSelect(token),
        };
      `)(sessions, activeId, log, apiImpl);
      return { fn, log };
    };

    const HISTORY_ROW = {
      endpoint: "kimi", id: "s-1", title: "重构权限矩阵", project: "C:\\dev\\alpha",
      file: "C:\\Users\\fixture\\.kimi\\sessions\\s-1.jsonl", resumeCommand: "kimi --session s-1",
    };
    const OPEN_WITH_RESUME = {
      "t-9": { id: "t-9", label: "Kimi Code", agent: { endpointId: "kimi" }, status: "idle", resume: { endpoint: "kimi", id: "s-1" } },
    };
    const OPEN_OTHER = {
      "t-8": { id: "t-8", label: "Kimi Code", agent: { endpointId: "kimi" }, status: "idle", resume: { endpoint: "kimi", id: "s-2" } },
      "t-7": { id: "t-7", label: "Kimi Code", agent: { endpointId: "kimi" }, status: "idle", resume: null },
    };

    it("已开着同 endpoint＋同会话 id 的终端：聚焦它，不重复建", async () => {
      const { fn, log } = runResume(OPEN_WITH_RESUME, "t-0", async () => { throw new Error("不该发请求"); });
      fn.resume(HISTORY_ROW);
      assert.equal(fn.activeId(), "t-9", "活跃指针落到已开着的终端（聚焦同路）");
      assert.deepEqual(log.posts, [], "不发创建请求");
      assert.deepEqual(log.remembered, ["t-9"], "存档同步写回（刷新恢复认得）");
      assert.equal(log.renders, 1, "重渲一次");
      assert.equal(log.toasts.length, 0, "不提示");
    });

    it("打开中的终端是别的会话/全新终端：照旧带 resume 新建", async () => {
      const { fn, log } = runResume(OPEN_OTHER, "t-0", async () => ({
        id: "t-new", label: "Kimi Code", agentId: "kimi", shell: "cmd", cwd: "C:\\dev\\alpha",
      }));
      fn.resume(HISTORY_ROW);
      await flush();
      assert.deepEqual(log.posts, [{
        method: "POST",
        path: "/api/terminal/agent-sessions",
        body: {
          agentId: "kimi",
          cwd: "C:\\dev\\alpha",
          resume: { endpoint: "kimi", id: "s-1", file: "C:\\Users\\fixture\\.kimi\\sessions\\s-1.jsonl" },
          cols: 120,
          rows: 34,
        },
      }], "没有可聚焦的终端才走续接新建（M3 契约原样）");
      assert.equal(fn.activeId(), "t-new", "新终端置活跃");
    });

    it("去重键＝endpoint＋会话 id：同 id 不同端点的终端不误聚焦", async () => {
      const sessions = {
        "t-c": { id: "t-c", agent: { endpointId: "claude" }, status: "idle", resume: { endpoint: "claude", id: "s-1" } },
      };
      const { fn, log } = runResume(sessions, "t-0", async () => ({ id: "t-new", agentId: "kimi" }));
      fn.resume(HISTORY_ROW); // kimi 的 s-1
      await flush();
      assert.equal(log.posts.length, 1, "claude 的同 id 终端不挡 kimi 的续接");
      assert.equal(fn.activeId(), "t-new", "照旧新建");
    });

    it("零终端/终端既无 resume 也未绑定对话：照旧新建（认不出身份就不去重）", () => {
      const none = runResume({}, "t-0", async () => ({ id: "t-new", agentId: "kimi" }));
      none.fn.resume(HISTORY_ROW);
      assert.equal(none.log.posts.length, 1, "零终端照旧新建");
      const fresh = runResume({ "t-f": { id: "t-f", agent: { endpointId: "kimi" }, status: "idle" } }, "t-0", async () => ({ id: "t-new", agentId: "kimi" }));
      fresh.fn.resume(HISTORY_ROW);
      assert.equal(fresh.log.posts.length, 1, "既无 resume 也未绑定对话：不参与去重");
    });

    it("去重口径写进注释：两个身份都算，不再是「只保续接终端」", () => {
      const block = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      assert.ok(block.includes("去重范围＝两种身份都算"), "去重口径注释在册");
      assert.ok(block.includes("boundConversation"), "绑定库身份写进注释（A4：全新会话终端的真身份只在这里）");
    });

    it("源码钉死：去重判定在续接之前，聚焦走 terminalRailActivateSession 同路", () => {
      const fn = extractFn("terminalRailResumeSession");
      assert.ok(fn.indexOf("terminalRailFindOpenSession") < fn.indexOf("terminalRailSwitchOrCreate"),
        "先查已开着的终端，再走内切/新开判定");
      const decide = extractFn("terminalRailSwitchOrCreateCore");
      // M12 视口化后判定门自己也兜一次去重：目标会话已有活终端＝直接切视口（方案第二节
      // 矩阵第 2 条）。入口去重仍在续接之前，这里兜的是绕过入口的调用点。
      const findAt = decide.indexOf("terminalRailFindOpenSession");
      assert.ok(findAt >= 0 && findAt < decide.indexOf("terminalSwitchInFlight = true"),
        "判定门内先按 resume 两键去重，命中即切视口（在补读与建终端之前）");
      // 补读在 working 判定之前；判定之后走保活分支（旧终端不杀、目标终端挂当前视口），
      // 不再是「新开页签」。
      const workingAt = decide.indexOf("if (working)");
      assert.ok(decide.indexOf("enrichTerminalSessions") < workingAt, "补读（活跃面即时取）在 working 判定之前");
      assert.ok(workingAt < decide.indexOf("terminalRailKeepAliveSwitch", workingAt),
        "working 判定之后走保活分支，不开新页签");
      assert.ok(decide.includes("terminalRailActivateSession"), "聚焦复用同一通路（切视口+存档+重渲）");
      assert.ok(fn.includes("terminalRailActivateSession(open.id)"), "续接入口去重后聚焦同路");
      const find = extractFn("terminalRailFindOpenSession");
      // A4：两个身份（续接身份 resume / 这条终端实际在跑的对话 boundConversation）都
      // 按 endpoint＋会话 id 两键比对。只认 resume 时，全新会话终端在左栏不亮 live，
      // 点它会按 resume 再起一条同对话进程——所以这把尺现在两个身份都要过。
      assert.ok(find.includes("resume.endpoint === endpoint && resume.id === id"),
        "两键比对：续接身份 endpoint + 会话 id");
      assert.ok(find.includes("bound.endpoint === endpoint && bound.id === id"),
        "两键比对：绑定库身份 endpoint + 会话 id（全新会话终端的真身份只在这里）");
    });

    it("乐观选中（M5）源码钉死：BeginSelect 在判定门之前点亮，失败清点两处到位", () => {
      const fn = extractFn("terminalRailResumeSession");
      assert.ok(fn.indexOf("terminalRailBeginSelect") < fn.indexOf("terminalRailSwitchOrCreate"),
        "过完全部拦截后先点亮再调判定门——高亮不等宿主 1~2s");
      assert.ok(extractFn("terminalRailBeginSelect").includes("terminalRailSwitchBusy()"),
        "在飞闸前置为谓词：在飞时不亮（亮也会被吞，高亮说谎比慢更糟）");
      const decide = extractFn("terminalRailSwitchOrCreateCore");
      const busyAt = decide.indexOf('if (code === "switch_busy")');
      const catchAt = decide.indexOf("} catch (error) {");
      const endSelectAt = decide.lastIndexOf("terminalRailEndSelect(null)");
      assert.ok(endSelectAt > busyAt && endSelectAt > catchAt,
        "判定门 catch 失败清点在 switch_busy 转新开之后（点击仍在兑现途中，不清）");
      assert.ok(endSelectAt < decide.indexOf("} finally {"),
        "清点不放 finally：working 转新开落点会把高亮弹回旧行");
      const postAt = decide.indexOf('await api("POST", `/api/terminal/sessions');
      const successEndAt = decide.indexOf("terminalRailEndSelect(null)");
      assert.ok(postAt < successEndAt && successEndAt < catchAt,
        "成功也收武装：POST 落地、快照换写之后即撤（真身份由 spawnedAt/resume 接手）");
      assert.ok(extractFn("createAgentTerminal").includes("terminalRailEndSelect(null)"),
        "新建失败同样清点（createAgentTerminal 的 catch）");
      assert.ok(extractFn("terminalRailActivateSession").includes("terminalRailEndSelect(null)"),
        "改主意清点：activate 无条件作废旧令牌");
      assert.ok(extractFn("terminalRailActivateSession").includes("renderTerminalPreviewSession({ deferScreen: true })"),
        "live 行快路径传 deferScreen（先让栏体高亮当拍渲，屏重建延后双 rAF）");
      const row = extractFn("terminalRailRowHtml");
      assert.ok(row.includes("terminalRailSelectPending") && row.includes('cls.push("is-active")'),
        "行选中判据读 pending 状态位（不是 DOM-only 切类名——1s 轮询会冲掉）");
      assert.ok(extractFn("terminalRailPendingRowHtml").includes("terminalRailPendingFreshActive"),
        "兜底行同口径：选中判据走共享谓词（pending 按终端 id 命中才亮，一屏至多一条）");
    });

    it("乐观选中（M5）vm 真跑：在飞时不亮不切，放行后才点亮", async () => {
      const { fn, log } = runResume({}, "t-0", async () => ({ id: "t-new", agentId: "kimi" }));
      fn.setBusy(true);
      fn.resume(HISTORY_ROW);
      assert.equal(fn.pending(), null, "在飞不落 pending");
      assert.deepEqual(log.posts, [], "在飞不发起（判定门同一条闸）");
      fn.setBusy(false);
      fn.resume(HISTORY_ROW);
      assert.ok(fn.pending() && fn.pending().id === "s-1", "放行后当拍点亮");
      await flush();
      assert.equal(log.posts.length, 1, "放行后照旧走新建");
      assert.equal(fn.activeId(), "t-new", "成功置活跃");
      fn.endSelect(null);
    });
  });

  describe("后端契约（源码钉死，真跑在 terminal-host/panel 测试）", () => {
    it("宿主侧：创建带 resume 记进会话记录并随列表下发（terminal-host.test.mjs 真跑）", () => {
      const host = readFileSync(join(here, "terminal-host.mjs"), "utf8");
      assert.ok(host.includes("normalizeResume"), "宿主有 resume 归一化（自己的形状轻验）");
      assert.ok(/invalid_resume/.test(host), "坏 resume 回机器可判错码");
      assert.ok(/\.\.\.\(session\.resume \? \{ resume: session\.resume \} : \{\}\)/.test(host),
        "快照带 resume（随列表下发）");
    });

    it("面板侧：校验过的 resume 身份随创建转发（panel-terminal-resume.test.mjs 真跑）", () => {
      assert.ok(panelMjs.includes("resume: { endpoint: body.resume.endpoint, id: body.resume.id }"),
        "只递 endpoint + id 两个非密字段");
    });
  });
});

describe("M8 T1 两段合并：live 内联 / 新会话兜底 / 无 agent 空树", () => {
  const LIVE = { id: "t-1", cwd: "C:\\dev\\alpha", agent: { endpointId: "kimi" }, status: "working", resume: { endpoint: "kimi", id: "s-1" } };

  it("live 行内联进所属目录组，与普通行同按 lastActive 倒序（live 不插队）", () => {
    const sandbox = renderSandbox({
      history: {
        endpoint: "kimi",
        sessions: [
          { id: "s-1", endpoint: "kimi", project: "C:\\dev\\alpha", title: "重构权限矩阵", lastActive: 100 },
          { id: "s-2", endpoint: "kimi", project: "C:\\dev\\alpha", title: "接入渠道", lastActive: 200 },
          { id: "s-3", endpoint: "kimi", project: "C:\\dev\\beta", title: "排查掉线", lastActive: 300 },
        ],
        fetchedAt: 1,
        error: null,
      },
      activeSession: LIVE,
    });
    sandbox.fn.render("kimi");
    const order = [...sandbox.list.html.matchAll(/data-rail-term-resume="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(order, ["s-3", "s-2", "s-1"], "组间按最近活跃、组内同按最近活跃（live 的 s-1 虽开着也不提前）");
    assert.ok(sandbox.list.html.includes("is-live"), "s-1 行带 live 标记");
    assert.equal((sandbox.list.html.match(/is-live/g) || []).length, 1, "只有 resume 两键对得上的那条是 live");
  });

  it("全新终端兜底：cwd 组顶插「新会话」行，无时间、无归档钮", () => {
    const sandbox = renderSandbox({
      history: {
        endpoint: "kimi",
        sessions: [{ id: "s-2", endpoint: "kimi", project: "C:\\dev\\alpha", title: "接入渠道", lastActive: 200 }],
        fetchedAt: 1,
        error: null,
      },
      activeSession: { id: "t-9", cwd: "C:\\dev\\alpha", agent: { endpointId: "kimi" }, status: "idle", backendState: { createdAt: 500 } },
    });
    sandbox.fn.render("kimi");
    assert.ok(sandbox.list.html.includes(">新会话<"), "兜底行标签「新会话」（T3 文案）");
    assert.ok(sandbox.list.html.includes('data-rail-term-session="t-9"'), "兜底行点击走聚焦（终端 id）");
    const at = sandbox.list.html.indexOf('data-rail-term-session="t-9"');
    const row = sandbox.list.html.slice(sandbox.list.html.lastIndexOf("<button", at), sandbox.list.html.indexOf("</button>", at));
    assert.ok(row.includes("is-live"), "兜底行是 live 行");
    assert.ok(!row.includes("rail-term-row-time"), "兜底行无时间");
    assert.ok(!row.includes("data-rail-term-archive"), "兜底行无归档钮（无会话身份可归档）");
    assert.ok(row.includes('data-rail-term-close="t-9"'), "兜底行带关闭叉");
    // 组顶：兜底行排在 lastActive 200 的 s-2 之前（不看 lastActive，固定组顶）
    const order = [...sandbox.list.html.matchAll(/data-rail-term-(?:resume|session)="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(order[0], "t-9", "兜底行在组顶");
  });

  it("乐观选中（M5）：pending 期间兜底行不亮、历史行亮，一屏至多一条（整树口径）", () => {
    const sandbox = renderSandbox({
      history: {
        endpoint: "kimi",
        sessions: [{ id: "s-2", endpoint: "kimi", project: "C:\\dev\\alpha", title: "接入渠道", lastActive: 200 }],
        fetchedAt: 1,
        error: null,
      },
      activeSession: { id: "t-9", cwd: "C:\\dev\\alpha", agent: { endpointId: "kimi" }, status: "idle", backendState: { createdAt: 500 } },
    });
    // 基线：活跃兜底行（t-9）亮。
    sandbox.fn.render("kimi");
    const baseRow = (id) => {
      const at = sandbox.list.html.indexOf(`data-rail-term-resume="${id}"`) >= 0
        ? sandbox.list.html.indexOf(`data-rail-term-resume="${id}"`)
        : sandbox.list.html.indexOf(`data-rail-term-session="${id}"`);
      return sandbox.list.html.slice(sandbox.list.html.lastIndexOf("<button", at), sandbox.list.html.indexOf("</button>", at));
    };
    assert.ok(baseRow("t-9").includes("is-active"), "基线：活跃兜底行亮（live 派生）");

    // 点历史行 s-2（没开终端的老会话）：当拍亮 s-2，兜底行同拍失亮。
    sandbox.fn.begin({ endpoint: "kimi", id: "s-2" });
    sandbox.fn.render("kimi");
    assert.ok(baseRow("s-2").includes("is-active"), "pending 命中的历史行当拍亮");
    assert.ok(!baseRow("t-9").includes("is-active"), "同期活跃兜底行失亮（pending 优先，不说谎）");
    assert.equal((sandbox.list.html.match(/is-active/g) || []).length, 1, "一屏至多一条选中");

    // 收尾后回到 live 派生。
    sandbox.fn.endSelect(null);
    sandbox.fn.render("kimi");
    assert.ok(!baseRow("s-2").includes("is-active"), "收尾后历史行不再占选中");
    assert.ok(baseRow("t-9").includes("is-active"), "活跃兜底行复位");
  });

  it("兜底行的目录没有历史会话时，为它新建组（组头三件齐全）", () => {
    const sandbox = renderSandbox({
      history: { endpoint: "kimi", sessions: [], fetchedAt: 1, error: null },
      activeSession: { id: "t-9", cwd: "C:\\dev\\gamma", agent: { endpointId: "kimi" }, status: "idle", backendState: { createdAt: 500 } },
    });
    sandbox.fn.render("kimi");
    assert.ok(sandbox.list.html.includes(">gamma<"), "新目录成组（短名）");
    assert.ok(sandbox.list.html.includes(">新会话<"), "组里是兜底行");
    assert.ok(sandbox.list.html.includes('data-rail-term-group-new="C:\\dev\\gamma"'), "新组同样有 ⊕（组头三件不限历史组）");
  });

  it("兜底接替：刷新后同目录出现更新的会话，兜底行退场（真行接替）", () => {
    const sandbox = renderSandbox({
      history: {
        endpoint: "kimi",
        sessions: [{ id: "s-new", endpoint: "kimi", project: "C:\\dev\\alpha", title: "真行", lastActive: 900 }],
        fetchedAt: 2,
        error: null,
      },
      activeSession: { id: "t-9", cwd: "C:\\dev\\alpha", agent: { endpointId: "kimi" }, status: "idle", backendState: { createdAt: 500 } },
    });
    sandbox.fn.render("kimi");
    assert.ok(!sandbox.list.html.includes(">新会话<"), "同目录已有更新的会话 → 兜底行退场");
    assert.ok(sandbox.list.html.includes(">真行<"), "真行在册");
  });

  it("终端关了兜底行即消失；无 agent 聚焦时工作区段无内容（T6）", () => {
    const noAgent = renderSandbox({
      history: { endpoint: "", sessions: [], fetchedAt: 0, error: null },
      activeSession: null,
    });
    noAgent.fn.render("");
    assert.equal(noAgent.list.html, "", "无 agent：树空（空白纯外壳终端不进栏，只从页签到达）");
    const closed = renderSandbox({
      history: { endpoint: "kimi", sessions: [], fetchedAt: 1, error: null },
      activeSession: null,
    });
    closed.fn.render("kimi");
    assert.ok(!closed.list.html.includes(">新会话<"), "终端已关：兜底行不再渲染");
  });

  it("兜底行锚＝进程出生（spawnedAt 优先，回退 createdAt）：内切换新进程后同目录旧会话不再吞掉兜底行", () => {
    // 2026-10-25 全新内切落地后新增：内切保记录换进程，createdAt 不动、spawnedAt
    // 才是本次会话的出生点。旧口径（createdAt）下 lastActive 300 ≥ 100 会把兜底
    // 行判成已被接替，全新内切后「新会话」行出不来。
    const sandbox = renderSandbox({
      history: {
        endpoint: "kimi",
        sessions: [{ id: "s-old", endpoint: "kimi", project: "C:\\dev\\alpha", title: "旧会话", lastActive: 300 }],
        fetchedAt: 1,
        error: null,
      },
      activeSession: { id: "t-a", cwd: "C:\\dev\\alpha", agent: { endpointId: "kimi" }, status: "idle", backendState: { createdAt: 100, spawnedAt: 500 } },
    });
    sandbox.fn.render("kimi");
    assert.ok(sandbox.list.html.includes('data-rail-term-session="t-a"'), "spawnedAt(500) 在旧会话 lastActive(300) 之后：兜底行在场");
    // 旧断言 `!includes(">旧会话<") || includes(t-a)` 的第二个分句被上一行保证成立，
    // 整条恒真（普查 finding）。改成有约束力的并存断言：真行不吞兜底行、兜底行也不吞真行。
    assert.ok(sandbox.list.html.includes(">旧会话<"), "旧会话真行照常在场（兜底行不吞真行）");
    assert.ok(sandbox.list.html.indexOf('data-rail-term-session="t-a"') < sandbox.list.html.indexOf(">旧会话<"),
      "兜底行仍在组顶（不被旧会话顶掉）");
  });
});

// ── 兜底行生命周期动效（2026-10-25，与归档 M13 同观感）──
// 真跑 renderTerminalRailHistory，动效帮手换成记录桩：兜底集增删的那一帧置 flip、
// 量旧位、挂幽灵；稳态帧/换 agent/搜索退出/未武装一律瞬时。几何与幽灵机制本体由
// M13 组的真跑用例与「快照只量行」源码钉死覆盖，这里钉的是 diff 的接线与门。
describe("兜底行生命周期动效（diff 驱动 FLIP/幽灵）", () => {
  const DIFF_HISTORY = {
    endpoint: "kimi",
    sessions: [{ id: "s-2", endpoint: "kimi", project: "C:\\dev\\alpha", title: "接入渠道", lastActive: 200 }],
    fetchedAt: 1,
    error: null,
  };
  const diffPendingSession = (id) => (id
    ? { id, cwd: "C:\\dev\\alpha", agent: { endpointId: "kimi" }, status: "idle", backendState: { createdAt: 900 } }
    : {});
  const diffSandbox = () => {
    const list = { html: "", writes: 0, parentElement: { append() {} } };
    Object.defineProperty(list, "innerHTML", {
      get: () => list.html,
      set: (v) => { list.writes += 1; list.html = v; },
    });
    const rec = { measureModes: [], flips: 0, ghosts: 0, snapshots: 0 };
    const ctrl = { present: new Set(), motion: true };
    const fn = new Function("list", "rec", "ctrl", "history", "pendingSession", `
      let terminalRailRendered = { history: null };
      let terminalRailAutoExpandedFor = "";
      let terminalRailScrolledFor = "";
      let terminalRailFlipMode = "instant";
      let terminalRailLastDiffAgent = null;
      let terminalRailLastDiffSearch = false;
      const terminalRailCollapsedGroups = new Set();
      function saveTerminalRailCollapsedGroups() {}
      const terminalRailWatermarks = new Map();
      const terminalRailPrefs = { archived: [], removedGroups: [] };
      const terminalRailViewPrefs = { groupBy: "workspace", orderBy: "updated", archivedFilter: "default", sessionOrder: {} };
      const terminalRailRemovedAt = {};
      const terminalRailSelfHealFailed = new Set();
      const terminalRailSearch = { open: false, query: "", timer: null, searching: false };
      let terminalRailLastGroups = [];
      const TERMINAL_RAIL_WATERMARK = 5;
      const TERMINAL_RAIL_MOTION_SELECTOR = "[data-rail-term-resume], [data-rail-term-session], [data-rail-term-group-head], [data-rail-term-more]";
      const TERMINAL_RAIL_UNGROUPED_HEAD = "~ungrouped";
      const TERMINAL_RAIL_ICON_CHEVRON = "";
      const TERMINAL_RAIL_ICON_ARCHIVE = "";
      const TERMINAL_RAIL_ICON_UNARCHIVE = "";
      const TERMINAL_RAIL_ICON_ELLIPSIS = "";
      const TERMINAL_RAIL_ICON_PLUS = "";
      const TERMINAL_RAIL_ICON_FOLDER_OPEN = "";
      const TERMINAL_RAIL_ICON_FOLDER_CLOSED = "";
      let terminalRailHistory = history;
      let terminalBackendSessions = {};
      let activeTerminalPreviewId = null;
      let terminalBackendReady = true;
      function $(id) { return id === "railTermHistoryList" ? list : null; }
      function saveTerminalRailRemovedAt() {}
      function api() { return Promise.resolve({ ok: true }); }
      function sessTitle(s) { return s.title || String(s.id || "").slice(0, 8); }
      function sessDirName(p) { return String(p || "").split("\\\\").pop(); }
      function terminalRailRelTime() { return "3 分钟前"; }
      function esc(v) { return String(v); }
      function escapeHtml(v) { return String(v || ""); }
      function terminalRailScrollGroupIntoView() {}
      function renderTerminalRailSearchResults() {}
      function terminalRailMotionTops() { rec.measureModes.push(terminalRailFlipMode); return new Map([["s-2", 100]]); }
      function playTerminalRailFlip() { rec.flips += 1; }
      function terminalRailMotionEnabled() { return ctrl.motion; }
      function terminalRailPendingRowKeys() { return new Set(ctrl.present); }
      function terminalRailSnapshotMotion() { rec.snapshots += 1; return new Map([["s-2", {}]]); }
      function terminalRailMountExitGhosts() { rec.ghosts += 1; }
      ${extractFn("terminalRailSessionMap")}
      ${extractFn("terminalRailActiveSession")}
      ${extractFn("terminalRailAgentId")}
      ${extractFn("terminalRailFindOpenSession")}
      ${extractFn("terminalRailNormDir")}
      ${extractFn("terminalRailGroupSessions")}
      ${extractFn("terminalRailWatermarkView")}
      ${extractFn("terminalRailNextWatermark")}
      ${extractFn("terminalRailMoreLabel")}
      ${extractFn("terminalRailSameDir")}
      ${extractFn("terminalRailGroupForDir")}
      ${extractFn("terminalRailArchivedKey")}
      ${extractFn("terminalRailIsArchived")}
      ${extractFn("terminalRailVisibleSessions")}
      ${extractFn("terminalRailSelfHealRemovedGroups")}
      ${extractFn("terminalRailRegroupRemoved")}
      ${extractFn("terminalRailPendingNewTerminals")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
      const TERMINAL_RAIL_SPINNER = "";
      const TERMINAL_RAIL_DONE_DOT = "";
      const terminalDoneUnread = new Map();
      let terminalRailSelectPending = null;
      ${extractFn("terminalRailStateSlotHtml")}
      ${extractFn("terminalRailRowHtml")}
      ${extractFn("terminalRailPendingRowHtml")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
      ${extractFn("renderTerminalRailHistory")}
      return {
        render: renderTerminalRailHistory,
        setPending: (id) => {
          terminalBackendSessions = id ? { [id]: pendingSession(id) } : {};
          activeTerminalPreviewId = id || null;
        },
        setPresent: (ids) => { ctrl.present = new Set(ids); },
        setMotion: (on) => { ctrl.motion = on; },
        openSearch: () => { terminalRailSearch.open = true; terminalRailSearch.query = "接入"; },
        closeSearch: () => { terminalRailSearch.open = false; terminalRailSearch.query = ""; },
      };
    `)(list, rec, ctrl, DIFF_HISTORY, diffPendingSession);
    return { fn, list, rec };
  };

  it("兜底行出现：那一帧置 flip（量旧位＋FLIP 播放），新行淡入/下方行位移由同一扇门承担；稳态帧不再动画", () => {
    const { fn, rec } = diffSandbox();
    fn.render("kimi");
    assert.deepEqual(rec.measureModes, [], "首帧＝reset（无 diff 基线）：瞬时落位");
    fn.setPending("t-9");
    fn.render("kimi");
    assert.deepEqual(rec.measureModes, ["flip"], "兜底集出现的那帧按 flip 量旧位");
    assert.equal(rec.flips, 1, "FLIP 播放一次");
    assert.equal(rec.snapshots, 1, "退场快照同帧拍下（出现帧无行离开，真实挂载由存活判定拦下，见 M13 真跑组）");
    fn.setPresent(["t-9"]);
    fn.render("kimi");
    assert.deepEqual(rec.measureModes, ["flip"], "兜底集未变的重渲不动画");
    assert.equal(rec.flips, 1, "稳态帧不重播");
  });

  it("兜底行消失：同一扇门＋快照交给幽灵挂载（淡出由 terminalRailMountExitGhosts 承担）", () => {
    const { fn, rec } = diffSandbox();
    fn.render("kimi");
    fn.setPending("t-9");
    fn.render("kimi");
    fn.setPresent(["t-9"]);
    fn.setPending(null);
    fn.render("kimi");
    assert.deepEqual(rec.measureModes, ["flip", "flip"], "出现帧与消失帧都置 flip");
    assert.equal(rec.ghosts, 2, "两帧都把快照交给幽灵挂载（真实挂载时只有离开的那行被克隆，见 M13 真跑组）");
  });

  it("reset 门：换 agent 与搜索退出的那一帧瞬时落位（沿 M13 resetKey 口径）", () => {
    const { fn, rec } = diffSandbox();
    fn.render("kimi");
    fn.setPending("t-9");
    fn.render("claude");
    assert.equal(rec.measureModes.length, 0, "换 agent：DOM 里是旧 agent 的兜底行，不按离开播动画");
    fn.render("kimi");
    assert.equal(rec.measureModes.length, 0, "回到原 agent 的首帧仍是 reset 基线");
    fn.openSearch();
    fn.render("kimi");
    fn.closeSearch();
    fn.setPending(null);
    fn.render("kimi");
    assert.equal(rec.measureModes.length, 0, "搜索退出后的首帧树渲染：瞬时落位");
    assert.equal(rec.ghosts, 0, "无幽灵");
  });

  it("armed/reduced-motion 门：动效不可用时一切瞬时（diff 不置 flip）", () => {
    const { fn, rec } = diffSandbox();
    fn.setMotion(false);
    fn.setPending("t-9");
    fn.render("kimi");
    assert.deepEqual(rec.measureModes, [], "未武装/reduce：不量不播");
    assert.equal(rec.ghosts, 0, "无幽灵");
  });
});

describe("M8 T2 选中态跟随聚焦", () => {
  it("选中只属于聚焦终端对应的 live 行", () => {
    const sandbox = renderSandbox({
      history: {
        endpoint: "kimi",
        sessions: [
          { id: "s-1", endpoint: "kimi", project: "C:\\dev\\alpha", title: "甲", lastActive: 100 },
          { id: "s-2", endpoint: "kimi", project: "C:\\dev\\alpha", title: "乙", lastActive: 200 },
        ],
        fetchedAt: 1,
        error: null,
      },
      activeSession: { id: "t-1", cwd: "C:\\dev\\alpha", agent: { endpointId: "kimi" }, status: "working", resume: { endpoint: "kimi", id: "s-1" } },
    });
    sandbox.fn.render("kimi");
    // 取整颗 button（class 在 data 属性之前，从 data 处往后切不到 class）
    const rowOf = (id) => {
      const at = sandbox.list.html.indexOf(`data-rail-term-resume="${id}"`);
      return sandbox.list.html.slice(sandbox.list.html.lastIndexOf("<button", at), sandbox.list.html.indexOf("</button>", at));
    };
    assert.ok(rowOf("s-1").includes("is-active"), "聚焦终端对应的行是选中态");
    assert.ok(!rowOf("s-2").includes("is-active"), "另一条 live 行不占选中");
  });

  it("live 行点击走聚焦、非 live 行点击走去重/续接（T2 行点击两分支）", () => {
    const init = extractFn("initTerminalRail");
    const clickAt = init.indexOf('dir.addEventListener("click"');
    const block = init.slice(clickAt, init.indexOf("});", clickAt));
    const resumeBranch = block.slice(block.indexOf("data-rail-term-resume"), block.indexOf('data-rail-term-group"'));
    assert.ok(resumeBranch.includes("data-rail-term-live"), "行分支先看 live 属性");
    assert.ok(resumeBranch.includes("terminalRailActivateSession"), "live 行 → 聚焦其终端");
    assert.ok(resumeBranch.includes("terminalRailResumeHistoryRow"), "非 live 行 → 去重聚焦或带 resume 新开（M7 甲链路原样）");
    const rowFn = new Function("session", "live", "activeId", `
      const TERMINAL_RAIL_ICON_ARCHIVE = "";
      const TERMINAL_RAIL_ICON_UNARCHIVE = "";
      function sessTitle(s) { return s.title; }
      function sessRelTime() { return "1 分钟"; }
      function terminalRailRelTime() { return "1 分钟"; }
      function terminalRailIsArchived() { return false; }
      function esc(v) { return String(v); }
      function escapeHtml(v) { return String(v || ""); }
      const TERMINAL_RAIL_SPINNER = "";
      const TERMINAL_RAIL_DONE_DOT = "";
      const terminalDoneUnread = new Map();
      let terminalRailSelectPending = null;
      ${extractFn("terminalRailStateSlotHtml")}
      ${extractFn("terminalRailRowHtml")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
      return terminalRailRowHtml;
    `)();
    const html = rowFn({ id: "s-1", endpoint: "kimi", title: "t", lastActive: 1 }, { id: "t-7", status: "idle" }, "t-1");
    assert.ok(html.includes('data-rail-term-live="t-7"'), "live 行带终端 id（委托据此分支）");
  });
});

describe("M8 T3 文案与时间格式", () => {
  it("栏内局部时间格式：dsh 式无前缀（不动会话页共用的 sessRelTime）", () => {
    // 冻结时钟沙盒：实现内部自取 Date.now()/new Date()，旧写法直接喂真实时刻——
    // 昨天/跨年分支随运行日期漂移、月/年边界还有毫秒级竞态（普查 finding）。固定
    // 「现在」后全分支确定性断言，年内/跨年两种日期形制都钉死（旧写法每天只能测到其一）。
    const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime(); // 固定「现在」＝2026-10-15 12:00 本地时
    const fn = new Function("NOW", `
      const SESS_MIN = 60 * 1000, SESS_HOUR = 60 * SESS_MIN, SESS_DAY = 24 * SESS_HOUR;
      const FixedDate = class extends globalThis.Date {
        static now() { return NOW; }
        constructor(...args) { super(...(args.length ? args : [NOW])); }
      };
      const Date = FixedDate;
      ${extractFn("terminalRailRelTime")}
      return terminalRailRelTime;
    `)(NOW);
    const at = (ms) => NOW - ms;
    assert.equal(fn(at(30 * 1000)), "刚刚", "半分钟内 = 刚刚");
    assert.equal(fn(at(-5000)), "刚刚", "时钟回拨防御");
    assert.equal(fn(at(5 * 60 * 1000)), "5分钟", "分钟无「前」缀");
    assert.equal(fn(at(3 * 60 * 60 * 1000)), "3小时", "小时无「前」缀");
    assert.equal(fn(at(3 * 24 * 60 * 60 * 1000)), "3天", "天无「前」缀");
    assert.equal(fn(at(24 * 60 * 60 * 1000)), "昨天", "昨天（固定时钟，不再随运行日期漂移）");
    // 跨年走 YYYY年M月D日，年内走 M月D日（与 sessRelTime 的日期形制同源，只去前缀）
    assert.equal(fn(new Date(2026, 0, 5, 12, 0, 0).getTime()), "1月5日", "年内形制 M月D日");
    assert.equal(fn(new Date(2025, 8, 10, 12, 0, 0).getTime()), "2025年9月10日", "跨年形制 YYYY年M月D日");
    // 栏内局部实现钉死：不许去改共用的 sessRelTime
    const sess = extractFn("sessRelTime");
    assert.ok(sess.includes("分钟前"), "会话页共用函数原样（带「前」缀）");
  });

  it("新建钮文案随聚焦分态：有 agent「新建会话」/ 无 agent「新建终端」，aria/title 同步", () => {
    const run = (agentId) => {
      const labelEl = { textContent: "" };
      const btn = {
        title: "", disabled: false,
        querySelector: (sel) => (sel === ".rail-term-new-label" ? labelEl : null),
        setAttribute: (k, v) => { btn[k] = v; },
      };
      const fn = new Function("agentId", "btn", `
        let currentView = "terminal";
        let terminalBackendReady = true;
        function $(id) { return id === "railTermNewBtn" ? btn : (id === "railTerminalDir" ? {} : null); }
        function renderTerminalRailHistory() {}
        function syncTerminalRailHistory() {}
        function terminalRailAgentId() { return agentId; }
        ${extractFn("renderTerminalRail")}
        return renderTerminalRail;
      `)(agentId, btn);
      fn();
      return { btn, labelEl };
    };
    const withAgent = run("kimi");
    assert.equal(withAgent.labelEl.textContent, "新建会话", "有 agent 聚焦：起的是该 agent 的会话");
    assert.equal(withAgent.btn.title, "新建会话", "title 同步换");
    assert.equal(withAgent.btn["aria-label"], "新建会话", "aria-label 同步换");
    const blank = run("");
    assert.equal(blank.labelEl.textContent, "新建终端", "无 agent 聚焦：起空白终端");
    assert.equal(blank.btn.title, "新建终端", "title 同步换");
    assert.equal(blank.btn["aria-label"], "新建终端", "aria-label 同步换");
  });
});

describe("M8 T4 组文件夹图标含当前会话时变主题色", () => {
  it("聚焦终端所在组的文件夹图标带 is-current，取主题 accent 变量（不写死蓝）", () => {
    const sandbox = renderSandbox({
      history: {
        endpoint: "kimi",
        sessions: [
          { id: "s-1", endpoint: "kimi", project: "C:\\dev\\alpha", title: "甲", lastActive: 100 },
          { id: "s-2", endpoint: "kimi", project: "C:\\dev\\beta", title: "乙", lastActive: 200 },
        ],
        fetchedAt: 1,
        error: null,
      },
      activeSession: { id: "t-1", cwd: "C:\\dev\\alpha", agent: { endpointId: "kimi" }, status: "idle" },
    });
    sandbox.fn.render("kimi");
    const alphaHead = sandbox.list.html.slice(sandbox.list.html.indexOf('data-rail-term-group="C:\\dev\\alpha"'));
    const betaHead = sandbox.list.html.slice(sandbox.list.html.indexOf('data-rail-term-group="C:\\dev\\beta"'));
    assert.ok(alphaHead.slice(0, 600).includes("rail-term-group-icon is-current"), "聚焦终端所在组：图标带 is-current");
    assert.ok(!betaHead.slice(0, 600).includes("is-current"), "别的组不带");
    // 用户修正：dsh 的蓝是它的品牌色，我们取主题 accent（sepia 出橙等）
    const rule = panelCss.match(/\.rail-term-group-icon\.is-current \{([^}]*)\}/);
    assert.ok(rule, "is-current 样式在册");
    assert.ok(rule[1].includes("var(--accent)"), "取 --accent 主题变量（亮暗/sepia 各自生效）");
    assert.ok(!/#[0-9a-f]{3,8}/i.test(rule[1]), "不写死任何蓝色值");
  });
});

describe("M8 T5 live 行悬停动作与归档钮并存", () => {
  it("live 行 ×＋归档并存；非 live 行只有归档；全部 0ms 硬切", () => {
    assert.ok(panelCss.includes(".rail-term-row.is-live:hover .rail-term-row-close { display: inline-flex; }"),
      "live 行 hover 出关闭叉（走 terminalRailCloseSession 同一条路）");
    assert.ok(panelCss.includes(".rail-term-row-history:hover .rail-term-row-archive { display: inline-flex; }"),
      "行 hover 出归档钮（live 与非 live 都有）");
    for (const sel of [".rail-term-row-close {", ".rail-term-row-archive {"]) {
      const rule = cssRule(sel);
      assert.ok(rule.includes("display: none"), `${sel} 静息不占位`);
      assert.ok(!/transition/.test(rule), `${sel} 无过渡（0ms 硬切）`);
    }
  });
});

describe("M8 T7a 段头搜索（照搬 m6c §A，裁剪后）", () => {
  describe("HTML 与 CSS", () => {
    it("段头三钮位：搜索槽（钮＋输入框＋清空钮）在册，刷新在位，文案逐字", () => {
      const dir = panelHtml.match(/<nav class="rail-dir rail-terminal-dir" id="railTerminalDir"[\s\S]*?<\/nav>/)[0];
      const head = dir.slice(dir.indexOf('id="railTermSectionHead"'), dir.indexOf('class="rail-term-scroll"'));
      assert.ok(head.includes('id="railTermSearchBtn"'), "搜索钮在册");
      assert.ok(head.includes('id="railTermSearchInput"'), "搜索输入框在册");
      assert.ok(head.includes('id="railTermSearchClear"'), "清空钮在册");
      assert.ok(head.includes('placeholder="搜索会话名称"'), "placeholder 逐字（m6c §A2）");
      assert.ok(/id="railTermSearchClear"[^>]*aria-label="清除搜索"/.test(head), "清空钮 aria 逐字（m6c §A2）");
      // D4：段头只剩搜索＋视图选项两钮（刷新钮已砍，用户拍板）
      assert.ok(!head.includes('id="railTermHistoryRefresh"'), "刷新钮不在册（M9-D4）");
      // 位序：标题 → 搜索 → 视图选项（dsh 两钮排布）
      assert.ok(head.indexOf('id="railTermSectionTitle"') < head.indexOf('id="railTermSearchBtn"')
        && head.indexOf('id="railTermSearchBtn"') < head.indexOf('id="railTermViewOptionsBtn"'), "位序：标题 → 搜索 → 视图选项");
      // 搜索钮无标签（批准清单里没有它的词）——同 ⋯ 钮形制
      assert.ok(/id="railTermSearchBtn"[^>]*aria-hidden="true"/.test(head), "搜索钮按装饰图标形制（标签待清单补录）");
    });

    it("行内展开观感：标题/钮带让位、搜索槽展开，0.18s（栏内第二条过渡，仅此机制）", () => {
      assert.ok(/\.rail-term-section-head\.is-searching \.rail-term-section-title,/.test(panelCss), "展开态标题让位（合并选择器，max-width:0 + opacity:0）");
      assert.ok(/\.rail-term-section-head\.is-searching \.rail-term-head-actions \{/.test(panelCss), "展开态右侧钮带让位");
      assert.ok(/\.rail-term-search \{[\s\S]*?max-width: 28px/.test(panelCss), "收起态搜索槽 28px");
      assert.ok(/\.rail-term-section-head\.is-searching \.rail-term-search \{[\s\S]*?max-width: 100%/.test(panelCss), "展开态搜索槽 100%");
      const searchRule = cssRule(".rail-term-search {");
      assert.ok(/transition:[^;]*\.18s/.test(searchRule), "搜索槽过渡 .18s（m6c §A1）");
      // 栏内运动纪律：行/钮/组头容器不因搜索加过渡
      assert.ok(!cssRule(".rail-term-row {").includes("transition"), "行本体仍 0ms 硬切");
    });
  });

  describe("匹配与结果（vm 真跑）", () => {
    const SESSIONS = [
      { id: "s-1", endpoint: "kimi", project: "C:\\dev\\alpha", title: "重构权限矩阵", lastActive: 100 },
      { id: "s-2", endpoint: "kimi", project: "C:\\dev\\beta", title: "Alpha 接入渠道", lastActive: 300 },
      { id: "s-3", endpoint: "kimi", project: null, title: "排查掉线", lastActive: 200 },
    ];
    const run = (query, sessions = SESSIONS) => {
      const fn = new Function("sessions", "query", `
        ${extractFn("sessDirName")}
        function sessTitle(s) { return s.title || String(s.id || "").slice(0, 8); }
        ${extractFn("terminalRailSearchMatches")}
        return terminalRailSearchMatches;
      `)(sessions, query);
      return fn(query, sessions);
    };

    it("范围＝会话标题＋目录短名，大小写不敏感子串（dsh 出厂口径，无全文）", () => {
      assert.deepEqual(run("重构").map((s) => s.id), ["s-1"], "标题命中");
      // alpha：s-2 标题含 Alpha，s-1 目录短名就是 alpha——两条都命中，按最近活跃倒序
      assert.deepEqual(run("alpha").map((s) => s.id), ["s-2", "s-1"], "标题/目录短名双路命中且大小写不敏感");
      assert.deepEqual(run("ALPHA").map((s) => s.id), ["s-2", "s-1"], "查询侧也大小写不敏感");
      assert.deepEqual(run("beta").map((s) => s.id), ["s-2"], "目录短名（非完整路径）命中");
      assert.deepEqual(run("dev").map((s) => s.id), [], "完整路径片段不命中（只匹配短名）");
      assert.deepEqual(run("").map((s) => s.id), [], "空查询无结果");
      assert.deepEqual(run("   ").map((s) => s.id), [], "纯空白查询无结果");
    });

    it("结果按最近活跃倒序；上限 20 条＋截断提示", () => {
      assert.deepEqual(run("a").map((s) => s.id).sort(), ["s-1", "s-2"], "宽查询命中两条（标题/短名都含 a 的）");
      const many = Array.from({ length: 25 }, (_, i) => ({ id: `m-${i}`, endpoint: "kimi", project: "C:\\dev\\x", title: `命中 ${i}`, lastActive: i }));
      const hits = run("命中", many);
      assert.equal(hits.length, 25, "匹配函数本身不截");
      // 截断在渲染层（TERMINAL_RAIL_SEARCH_LIMIT = 20）
      assert.ok(panelJs.includes("TERMINAL_RAIL_SEARCH_LIMIT = 20"), "上限 20（m6c §A4，Host 侧同值）");
    });
  });

  describe("搜索交互状态机（源码钉死）", () => {
    const src = () => panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));

    it("防抖 250ms；搜索中态「正在搜索会话历史…」role=status", () => {
      assert.ok(src().includes("TERMINAL_RAIL_SEARCH_DEBOUNCE_MS = 250"), "防抖 250ms（m6c §A2）");
      assert.ok(src().includes("正在搜索会话历史…"), "搜索中文案逐字");
      assert.ok(src().includes('role="status"'), "role=status（无障碍）");
    });

    it("退出手势：Esc／清空钮／点开结果行＝清空＋收起；外点仅空查询收起；再点搜索钮不退出", () => {
      const s = src();
      assert.ok(/event\.key === "Escape"/.test(s), "Esc 清空+收起");
      assert.ok(s.includes("railTermSearchClear"), "清空钮在册");
      // 外点仅空查询收起：收起条件带 query 判空
      assert.ok(/terminalRailSearch\.query/.test(s), "外点收起判 query 空（有查询只失焦）");
      // 退出后滚动回顶：真跑 closeTerminalRailSearch。旧断言 `s.includes("退出后列表
      // 滚动回顶")` 只命中实现上方的注释，删掉 scrollTop=0 实现行也照过（普查 finding）；
      // 且全测试集此前没有该函数的真跑，这里把行为钉死。
      const scrollEl = { scrollTop: 42 };
      const headEl = { classList: { add() {}, remove() {} } };
      const inputEl = { tabIndex: 0, value: "接入", blur() {} };
      const state = { open: true, query: "接入", timer: null, searching: true };
      const closeLog = { renders: 0 };
      const close = new Function("scrollEl", "headEl", "inputEl", "state", "closeLog", `
        function $(id) { return id === "railTermSectionHead" ? headEl : (id === "railTermSearchInput" ? inputEl : null); }
        const document = { querySelector: (sel) => (sel === ".rail-term-scroll" ? scrollEl : null) };
        const terminalRailSearch = state;
        function renderTerminalRailHistory() { closeLog.renders += 1; }
        function terminalRailAgentId() { return "kimi"; }
        ${extractFn("closeTerminalRailSearch")}
        return closeTerminalRailSearch;
      `)(scrollEl, headEl, inputEl, state, closeLog);
      close();
      assert.equal(scrollEl.scrollTop, 0, "退出后列表滚动回顶（m6c §A6，实现行为真跑）");
      assert.equal(closeLog.renders, 1, "退出后重渲回树");
      assert.equal(state.open, false, "搜索态随退出收起");
    });

    it("结果行＝T2 同一套（live 聚焦/去重/续接）；归档行进结果且点击落提示句", () => {
      const s = src();
      assert.ok(s.includes("terminalRailResumeSession"), "结果行走续接两分支（去重内置）");
      assert.ok(s.includes('data-rail-term-live'), "结果行带 live 属性（聚焦分支）");
      assert.ok(s.includes("这条会话已归档，取消归档后才能续接"), "归档行点击落批准句（m6b 已取原文）");
      assert.ok(s.includes("rail-term-row-result"), "结果行有专属类（平铺无组头）");
    });

    it("无匹配「无匹配会话」；>20 出截断句（逐字）", () => {
      const s = src();
      assert.ok(s.includes("无匹配会话"), "无匹配文案逐字");
      assert.ok(s.includes("仅显示前 20 条结果，请缩小搜索范围。"), "截断文案逐字");
    });
  });
});

// ── M8 T7b 视图选项（照搬 m6c §B 全集） ──
// 探针：从 panel.js 栏体段按函数名切源码进 vm 桩环境（照本文件既有惯例）。
import { readFileSync as readForT7b } from "node:fs";
import { join as joinForT7b } from "node:path";

const T7B_GROUPS = [
  { key: "", label: "未分组", rows: [{ id: "u-1", lastActive: 50 }], latest: 50 },
  { key: "C:\\dev", label: "dev", rows: [{ id: "d-1", project: "C:\\dev", lastActive: 100 }], latest: 100 },
  { key: "C:\\dev\\alpha", label: "alpha", rows: [{ id: "a-1", project: "C:\\dev\\alpha", lastActive: 200 }], latest: 200 },
  { key: "C:\\dev\\alpha\\sub", label: "sub", rows: [{ id: "s-1", project: "C:\\dev\\alpha\\sub", lastActive: 300 }], latest: 300 },
];

describe("M8 T7b 视图选项三组（分组/排序+行拖拽/筛选）", () => {
  describe("HTML 与 ⋯ 补录", () => {
    it("视图选项钮在册：滑杆图标、title/aria 逐字「视图选项」，位序在搜索与刷新之间", () => {
      const dir = panelHtml.match(/<nav class="rail-dir rail-terminal-dir" id="railTerminalDir"[\s\S]*?<\/nav>/)[0];
      assert.ok(dir.includes('id="railTermViewOptionsBtn"'), "视图选项钮在册");
      assert.ok(/id="railTermViewOptionsBtn"[^>]*title="视图选项"[^>]*aria-label="视图选项"/.test(dir), "title/aria 逐字");
      const head = dir.slice(dir.indexOf('id="railTermSectionHead"'), dir.indexOf('class="rail-term-scroll"'));
      assert.ok(head.indexOf('id="railTermSearchBtn"') < head.indexOf('id="railTermViewOptionsBtn"'),
        "位序：搜索 → 视图选项（D4 起段头只此两钮，dsh 两钮排布）");
    });

    it("组头 ⋯ 钮补录 aria「分组操作」（用户已知情未异议）", () => {
      const render = extractFn("renderTerminalRailHistory");
      assert.ok(render.includes('aria-label="分组操作"'), "⋯ 钮 aria 补录");
    });
  });

  describe("分组方式（vm 真跑）", () => {
    const runNest = (groups) => {
      const fn = new Function("groups", `
        ${extractFn("terminalRailNormDir")}
        ${extractFn("terminalRailSameDir")}
        ${extractFn("terminalRailIsAncestorDir")}
        ${extractFn("terminalRailNestGroups")}
        return terminalRailNestGroups;
      `)(groups);
      return fn(groups);
    };

    it("按工作区树：目录祖先嵌套、深度正确、未分组不参与嵌套", () => {
      const nested = runNest(JSON.parse(JSON.stringify(T7B_GROUPS)));
      const byKey = new Map(nested.map((g) => [g.key, g]));
      assert.equal(byKey.get("C:\\dev\\alpha").depth, 1, "alpha 的深度 1（父 dev）");
      assert.equal(byKey.get("C:\\dev\\alpha\\sub").depth, 2, "sub 的深度 2（父 alpha）");
      assert.equal(byKey.get("C:\\dev").depth, 0, "dev 深度 0");
      assert.equal(byKey.get("").depth, 0, "未分组不嵌套");
      // 祖先组自动展开（m6c §B3）：真跑 applyTerminalRailViewChoice("groupBy",
      // "workspace-tree")，钉死解折叠分支本体。旧断言 /ancestor/i 命中的是另一个
      // 函数（terminalRailIsAncestorDir）的函数名与注释，删掉解折叠分支也照过——
      // 普查 finding：该分支全测试集零真实覆盖。
      const collapsed = new Set(["c:\\dev", "c:\\dev\\alpha", "c:\\dev\\alpha\\sub"]);
      const viewLog = { collapsedSaved: 0, rendered: 0 };
      const choose = new Function("collapsed", "viewLog", `
        const TERMINAL_RAIL_VIEW_GROUPS = [
          { label: "分组方式", field: "groupBy", items: [] },
          { label: "排序方式", field: "orderBy", items: [] },
          { label: "筛选会话", field: "archivedFilter", items: [] },
        ];
        const terminalRailViewPrefs = { groupBy: "workspace", orderBy: "updated", archivedFilter: "default", sessionOrder: {} };
        const terminalRailLastGroups = [
          { key: "C:\\\\dev", depth: 0 },
          { key: "C:\\\\dev\\\\alpha", depth: 1 },
          { key: "C:\\\\dev\\\\alpha\\\\sub", depth: 2 },
          { key: "", depth: 0 },
        ];
        const terminalRailCollapsedGroups = collapsed;
        let terminalRailFlipMode = "instant";
        function closeTerminalRailViewMenu() {}
        function saveTerminalRailCollapsedGroups() { viewLog.collapsedSaved += 1; }
        function saveTerminalRailViewPrefs() {}
        function renderTerminalRailHistory() { viewLog.rendered += 1; }
        function terminalRailAgentId() { return "kimi"; }
        ${extractFn("terminalRailNormDir")}
        ${extractFn("applyTerminalRailViewChoice")}
        return applyTerminalRailViewChoice;
      `)(collapsed, viewLog);
      choose("groupBy", "workspace-tree");
      assert.equal(collapsed.has("c:\\dev\\alpha"), false, "祖先组（depth 1）自动展开");
      assert.equal(collapsed.has("c:\\dev\\alpha\\sub"), false, "更深祖先组（depth 2）同样展开");
      assert.equal(collapsed.has("c:\\dev"), true, "顶层组（depth 0）不动（它不是别人的祖先挂点）");
      assert.equal(viewLog.collapsedSaved, 1, "展开态落盘");
      assert.equal(viewLog.rendered, 1, "切树后重渲一次");
    });

    it("单列表：无组平铺，全部会话一个列表（树标签＝会话）", () => {
      const s = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      assert.ok(s.includes('label: "会话"'), "平铺模式标签「会话」（m6c §B3）");
      assert.ok(s.includes("groupBy === \"flat\""), "flat 分支在册");
    });

    it("缩进 8+depth×12px（m6c §B3 实测值）", () => {
      // 缩进算在 JS 渲染层（组头 inline style），不在 CSS 规则里
      const s = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      assert.ok(/padding-inline-start: \$\{8 \+ group\.depth \* 12\}px/.test(s), "树模式缩进算式 8+depth×12px 在册");
    });
  });

  describe("排序方式与会话行拖拽（vm 真跑）", () => {
    const runOrder = (order) => {
      const fn = new Function("order", `
        const terminalRailViewPrefs = { groupBy: "workspace", orderBy: "manual", archivedFilter: "default", sessionOrder: { kimi: order } };
        function terminalRailAgentId() { return "kimi"; }
        ${extractFn("terminalRailApplyManualOrder")}
        return terminalRailApplyManualOrder;
      `)(order);
      return fn;
    };

    it("手序渲染：按 sessionOrder 排，榜上无名回落到最近活跃", () => {
      const groups = [
        { key: "C:\\dev\\alpha", rows: [
          { id: "a", lastActive: 100 },
          { id: "b", lastActive: 300 },
          { id: "c", lastActive: 200 },
        ] },
      ];
      const out = runOrder(["c", "a"])(groups);
      assert.deepEqual(out[0].rows.map((r) => r.id), ["c", "a", "b"], "榜上三名按手序，b 无名按最近活跃补位");
    });

    it("拖拽改写手序：同组内移动写入 sessionOrder（按 agent 键）", () => {
      const box = new Function("prefs", `
        const terminalRailViewPrefs = prefs;
        function saveTerminalRailViewPrefs() {}
        ${extractFn("terminalRailMoveInManualOrder")}
        return { move: terminalRailMoveInManualOrder, prefs: () => terminalRailViewPrefs };
      `)({ groupBy: "workspace", orderBy: "manual", archivedFilter: "default", sessionOrder: { kimi: ["a", "b", "c", "d"] } });
      box.move("kimi", "a", "c");
      assert.deepEqual(box.prefs().sessionOrder.kimi, ["b", "a", "c", "d"], "a 移到 c 之前（dsh insertBefore 同语义）");
    });

    it("行 draggable＝非归档；组行不拖（组是目录派生、无清单可持久化）", () => {
      const render = extractFn("terminalRailRowHtml");
      assert.ok(/draggable/.test(render), "会话行带 draggable（手序的唯一来源）");
      const s = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      const headHtml = s.slice(s.indexOf("rail-term-group-head"), s.indexOf("rail-term-group-slot"));
      assert.ok(!headHtml.includes("draggable"), "组行不搬拖拽");
      // 归档行不可拖（m6c：draggable＝非空白且非归档）
      const rowFn = new Function("session", "live", "activeId", "prefs", `
        const terminalRailPrefs = prefs;
        const TERMINAL_RAIL_ICON_ARCHIVE = "";
        const TERMINAL_RAIL_ICON_UNARCHIVE = "";
        function sessTitle(s) { return s.title; }
        function sessRelTime() { return "1 分钟"; }
        function terminalRailRelTime() { return "1 分钟"; }
        function esc(v) { return String(v); }
        function escapeHtml(v) { return String(v || ""); }
        ${extractFn("terminalRailArchivedKey")}
        ${extractFn("terminalRailIsArchived")}
        const TERMINAL_RAIL_SPINNER = "";
        const TERMINAL_RAIL_DONE_DOT = "";
        const terminalDoneUnread = new Map();
        let terminalRailSelectPending = null;
        ${extractFn("terminalRailStateSlotHtml")}
        ${extractFn("terminalRailRowHtml")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
        return terminalRailRowHtml;
      `)(null, null, "t1", { archived: [{ endpoint: "kimi", id: "s-9" }], removedGroups: [] });
      const archivedRow = rowFn({ id: "s-9", endpoint: "kimi", title: "t", lastActive: 1 }, null, "t1");
      assert.ok(!archivedRow.includes("draggable"), "归档行不可拖");
      const plainRow = rowFn({ id: "s-1", endpoint: "kimi", title: "t", lastActive: 1 }, null, "t1");
      assert.ok(plainRow.includes("draggable"), "非归档行可拖");
    });

    it("切 manual 快照当前派生序；切回 updated 清空手序", () => {
      const s = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      assert.ok(s.includes("terminalRailSnapshotManualOrder"), "切入快照函数在册");
      assert.ok(/delete terminalRailViewPrefs\.sessionOrder\[/.test(s), "切回 updated 清空该 agent 手序");
    });
  });

  describe("筛选会话三态（vm 真跑）", () => {
    const runVisible = (filter, prefs) => {
      const fn = new Function("filter", "prefs", `
        const terminalRailViewPrefs = { groupBy: "workspace", orderBy: "updated", archivedFilter: filter, sessionOrder: {} };
        const terminalRailPrefs = prefs;
        let terminalRailHistory = { endpoint: "kimi", sessions: [
          { id: "s-1", endpoint: "kimi", project: "C:\\\\dev\\\\alpha", title: "甲", lastActive: 100 },
          { id: "s-2", endpoint: "kimi", project: "C:\\\\dev\\\\alpha", title: "乙", lastActive: 200 },
        ], fetchedAt: 1, error: null };
        ${extractFn("terminalRailArchivedKey")}
        ${extractFn("terminalRailIsArchived")}
        ${extractFn("terminalRailVisibleSessions")}
        return terminalRailVisibleSessions;
      `)(filter, prefs);
      return fn();
    };
    const PREFS = { archived: [{ endpoint: "kimi", id: "s-1" }], removedGroups: [] };

    it("隐藏已归档（默认）：归档行不进列表", () => {
      assert.deepEqual(runVisible("default", PREFS).map((s) => s.id), ["s-2"]);
    });

    it("全部会话（显示已归档）：归档行原位内联", () => {
      assert.deepEqual(runVisible("show", PREFS).map((s) => s.id), ["s-1", "s-2"]);
    });

    it("仅显示已归档：只留归档行（无归档的组整组丢弃在渲染层）", () => {
      assert.deepEqual(runVisible("only", PREFS).map((s) => s.id), ["s-1"]);
    });

    it("仅已归档且一条都没有：空态「暂无已归档会话」＋「查看其他会话」", () => {
      const s = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      assert.ok(s.includes("暂无已归档会话"), "空态文案逐字");
      assert.ok(s.includes("查看其他会话"), "空态动作文案逐字");
      assert.ok(s.includes("data-rail-term-view-reset"), "点了切回「隐藏已归档」");
    });
  });

  describe("持久化与菜单交互（源码钉死）", () => {
    const src = () => panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));

    it("视图偏好一个 localStorage 键存全部（dsh 的 view store 同层）", () => {
      assert.ok(src().includes('TERMINAL_RAIL_VIEW_KEY = "panel-terminal-rail-view"'), "键名在册");
      assert.ok(src().includes("localStorage.getItem(TERMINAL_RAIL_VIEW_KEY)"), "进入时读回");
      assert.ok(src().includes("localStorage.setItem(TERMINAL_RAIL_VIEW_KEY,"), "点选即写");
      // 三组各自独立：分组/排序/筛选
      assert.ok(/groupBy/.test(src()) && /orderBy/.test(src()) && /archivedFilter/.test(src()), "三组字段在册");
    });

    it("菜单形制：右对齐锚定、dense 30px、✓ 居项最右、点选即关", () => {
      assert.ok(/\.rail-term-view-menu \{[\s\S]*?min-width/.test(panelCss), "菜单容器在册");
      const item = cssRule(".rail-term-view-item {");
      assert.ok(/min-height:\s*30px/.test(item), "dense 30px 项（m6c §B2）");
      assert.ok(/\.rail-term-view-check \{[^}]*margin-left:\s*auto/.test(panelCss),
        "✓ 居项最右（margin-left:auto）");
      assert.ok(/\.rail-term-view-item\.is-selected \.rail-term-view-check \{[\s\S]*?display:\s*inline-flex/.test(panelCss),
        "选中项才显 ✓（不换文字色、不铺底）");
      assert.ok(src().includes("closeTerminalRailViewMenu()"), "点选即关");
    });

    it("三组菜单标签在册：分组方式 / 排序方式 / 筛选会话", () => {
      const s = src();
      for (const label of ["分组方式", "排序方式", "筛选会话"]) {
        assert.ok(s.includes(label), `菜单分组标签「${label}」在册`);
      }
    });
  });
});

describe("M8 复审必修 1：取消归档钮的行委托断链", () => {
  const initBlock = () => {
    const init = extractFn("initTerminalRail");
    const clickAt = init.indexOf('dir.addEventListener("click"');
    return init.slice(clickAt, init.indexOf("});", clickAt));
  };

  it("委托判序：unarchive 分支先于 resumeRow 分支，且分支体内调 terminalRailUnarchiveSession", () => {
    // 回归根因：取消归档钮是行按钮（data-rail-term-resume）的子元素，若 unarchive
    // 分支排在 resume 分支之后，点击永远先命中 resume——取消归档被行点击抢走。
    const block = initBlock();
    assert.ok(block.indexOf("data-rail-term-unarchive") < block.indexOf('data-rail-term-resume"'),
      "unarchive 分支必须排在 resumeRow 分支之前（子元素命中最近的祖先分支）");
    const unarchiveBranch = block.slice(block.indexOf("data-rail-term-unarchive"), block.indexOf("data-rail-term-group-menu"));
    assert.ok(unarchiveBranch.includes("terminalRailUnarchiveSession("),
      "分支体内调 terminalRailUnarchiveSession（不是 toast、不是 resume）");
    assert.ok(!unarchiveBranch.includes("terminalRailResumeHistoryRow"),
      "unarchive 分支不许捎带续接逻辑");
  });

  it("真实点击行为：点归档行的取消归档钮＝取消归档、不落提示 toast、不续接", () => {
    // 断链能存在，是因为此前没有任何「点击 data-rail-term-unarchive」的用例——
    // 这里用真委托跑一次点击（stub DOM），把行为钉死。
    const log = { unarchive: [], toasts: [], resume: [], activate: [] };
    const listeners = {};
    const dirStub = { addEventListener: (type, fn) => { listeners[type] = fn; } };
    const btnStub = () => ({ onclick: null, addEventListener: () => {}, disabled: false });
    const els = {
      railTerminalDir: dirStub,
      railTermNewBtn: btnStub(),
      railTermSearchBtn: btnStub(), railTermSearchInput: btnStub(), railTermSearchClear: btnStub(),
      railTermViewOptionsBtn: btnStub(), railBackBtn: null, v2Rail: { addEventListener: () => {} },
    };
    const fn = new Function("els", "listeners", "log", `
      const terminalRailMenuEl = null;
      const terminalRailViewMenuEl = null;
      const terminalRailSearch = { open: false, query: "", timer: null, searching: false };
      const terminalRailHoverEl = null;
      const terminalRailHoverHead = null;
      let terminalRailMotionArmed = false;
      let terminalRailHistory = { endpoint: "kimi", sessions: [{ id: "s-1", endpoint: "kimi", project: "C:\\dev\\alpha", title: "甲", lastActive: 100 }], fetchedAt: 1, error: null };
      function $(id) { return els[id] ?? null; }
      const document = { addEventListener: () => {} };
      function initTerminalRailScrollbarQuiet() {}
      function loadTerminalRailViewPrefs() {}
      function loadTerminalRailCollapsedGroups() {}
      function closeTerminalRailGroupMenu() {}
      function closeTerminalRailViewMenu() {}
      function closeTerminalRailSearch() {}
      function closeTerminalRailHoverCard() {}
      function openTerminalRailSearch() {}
      function openTerminalRailViewMenu() {}
      function onTerminalRailSearchInput() { log.input += 1; }
      function scheduleTerminalRailHoverCard() {}
      function terminalRailHeadKey() { return ""; }
      function terminalRailCloseSession() {}
      function terminalRailArchiveSession() {}
      function toggleTerminalRailGroupMenu() {}
      function terminalRailCreateTerminalInDir() {}
      function terminalRailRemoveGroup() {}
      function applyTerminalRailViewChoice() {}
      function terminalRailActivateSession(id) { log.activate.push(id); }
      function terminalRailResumeHistoryRow(id) { log.resume.push(id); }
      function terminalRailUnarchiveSession(endpoint, id) { log.unarchive.push({ endpoint, id }); }
      function toggleTerminalRailGroup() {}
      function toggleTerminalRailWatermark() {}
      function terminalRailCreateTerminal() {}
      function refreshTerminalRailHistory() {}
      function terminalRailMoveInManualOrder() {}
      function renderTerminalRailHistory() {}
      function toast(msg) { log.toasts.push(msg); }
      ${extractFn("initTerminalRail")}
      return initTerminalRail;
    `)(els, listeners, log);
    fn();
    const click = listeners.click;
    assert.equal(typeof click, "function", "栏体 click 委托已挂");
    // 点「取消归档」钮：它是行按钮（data-rail-term-resume）的子元素——closest 对
    // 行选择器会返回行（DOM 祖先链），对钮选择器返回钮。断链代码正是因此先命中
    // resume 分支。
    const rowEl = { getAttribute: (name) => (name === "data-rail-term-resume" ? "s-1" : null) };
    const unarchiveBtn = { getAttribute: () => "s-1" };
    click({ target: { closest: (sel) => (sel === "[data-rail-term-unarchive]" ? unarchiveBtn : (sel === "[data-rail-term-resume]" ? rowEl : null)) } });
    assert.deepEqual(log.unarchive, [{ endpoint: "kimi", id: "s-1" }], "执行取消归档（endpoint 从历史行解析）");
    assert.deepEqual(log.toasts, [], "无 toast（m6b §A6：取消归档成功路径不 notify）");
    assert.deepEqual(log.resume, [], "不续接（不被行点击抢走）");
    assert.deepEqual(log.activate, [], "不聚焦");
    // 对照组：点普通历史行（无 unarchive 钮）照旧走续接两分支
    click({ target: { closest: (sel) => (sel === "[data-rail-term-resume]" ? rowEl : null) } });
    assert.deepEqual(log.resume, ["s-1"], "普通行点击仍走续接（判序修复没误伤）");
  });
});

describe("M13 新会话按钮的首次交互动画", () => {
  it("第一次按下新建按钮就武装动画，不必先点历史行", () => {
    const listeners = {};
    const fn = new Function("listeners", `
      let terminalRailMotionArmed = false;
      const dir = { addEventListener: (type, fn) => { listeners[type] = fn; } };
      const btn = () => ({ addEventListener() {}, focus() {}, blur() {}, classList: { add() {}, remove() {} } });
      const els = {
        railTerminalDir: dir, railTermHistoryList: null,
        railTermNewBtn: btn(), railTermSearchBtn: btn(), railTermSearchInput: btn(),
        railTermSearchClear: btn(), railTermViewOptionsBtn: btn(), railBackBtn: null,
      };
      const document = { addEventListener() {} };
      function $(id) { return els[id] || null; }
      function loadTerminalRailViewPrefs() {}
      function loadTerminalRailCollapsedGroups() {}
      function initTerminalRailScrollbarQuiet() {}
      function closeTerminalRailGroupMenu() {}
      function closeTerminalRailViewMenu() {}
      function closeTerminalRailSearch() {}
      function closeTerminalRailHoverCard() {}
      function openTerminalRailSearch() {}
      function openTerminalRailViewMenu() {}
      function onTerminalRailSearchInput() {}
      function scheduleTerminalRailHoverCard() {}
      function terminalRailHeadKey() {}
      function terminalRailCloseSession() {}
      function terminalRailArchiveSession() {}
      function toggleTerminalRailGroupMenu() {}
      function terminalRailCreateTerminalInDir() {}
      function terminalRailRemoveGroup() {}
      function applyTerminalRailViewChoice() {}
      function terminalRailActivateSession() {}
      function terminalRailResumeHistoryRow() {}
      function terminalRailUnarchiveSession() {}
      function toggleTerminalRailGroup() {}
      function toggleTerminalRailWatermark() {}
      function terminalRailCreateTerminal() {}
      function refreshTerminalRailHistory() {}
      function terminalRailMoveInManualOrder() {}
      function renderTerminalRailHistory() {}
      function toast() {}
      ${extractFn("initTerminalRail")}
      return { init: initTerminalRail, armed: () => terminalRailMotionArmed };
    `)(listeners);
    fn.init();
    assert.equal(typeof listeners.pointerdown, "function", "首次交互监听挂在包含新建按钮的栏体");
    listeners.pointerdown();
    assert.equal(fn.armed(), true, "新建按钮首次 pointerdown 即放行本帧动效");
  });
});

describe("M8 复审必修 2：段头行观感照抄 m6c §B5", () => {
  const decls = (selector) => {
    const at = panelCss.indexOf(selector);
    assert.ok(at >= 0, `规则 ${selector} 在册`);
    return panelCss.slice(at, panelCss.indexOf("}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
  };

  it("段头行：36px 高、gap 4px、radius-md、padding-left 4px", () => {
    const head = decls(".rail-term-section-head {");
    assert.ok(/min-height:\s*36px/.test(head), "段头行高 36px（m6c §B5）");
    assert.ok(/gap:\s*4px/.test(head), "gap 4px");
    assert.ok(/border-radius:\s*var\(--radius-md\)/.test(head), "radius-md 12px");
    assert.ok(/padding:\s*0\s*4px/.test(head) || /padding-left:\s*4px/.test(head), "padding-left 4px");
    // 钉底纪律不回归：段头仍是滚动层外的定高块
    assert.ok(head.includes("flex: none"), "段头 flex:none（M7-S4 钉底三层不变）");
  });

  it("M11-A：收起态工具组贴右（搜索槽 auto 左边距）；展开态不接管", () => {
    // 刷新钮砍掉后，标题 45% 封顶之外的剩余空间无 item 吸收、全堆在钮带右侧——
    // auto 左边距落在工具组首元（搜索槽）上，「搜索＋视图选项」整体贴到段头右缘，
    // 与刷新钮在时的右缘位置一致（m6c §B5 的 45% 封顶本就按三钮带调准）。
    assert.ok(/\.rail-term-section-head:not\(\.is-searching\) \.rail-term-search \{[\s\S]*?margin-left:\s*auto/.test(panelCss),
      "收起态搜索槽 margin-left:auto＝工具组整体贴右（M11-A）");
    // 展开态搜索槽 flex:1 1 auto 要吃饱：auto 边距会先于 flex-grow 吃掉剩余空间，
    // 必须被 :not(.is-searching) scop 掉——展开态布局零改动。
    const expanded = decls(".rail-term-section-head.is-searching .rail-term-search {");
    assert.ok(!/margin-left/.test(expanded), "展开态无 auto 边距（grow 吃饱，搜索展开不回归）");
  });

  it("标题：14px/20/400 tertiary、max-width 45%", () => {
    const title = decls(".rail-term-section-title {");
    assert.ok(/font-size:\s*14px/.test(title), "标题 14px");
    assert.ok(/line-height:\s*20px/.test(title), "行高 20px");
    assert.ok(/font-weight:\s*400/.test(title), "字重 400（dsh 同：不加粗）");
    assert.ok(/color:\s*var\(--text-3\)/.test(title), "tertiary 色（语义 token）");
    assert.ok(/max-width:\s*45%/.test(title), "max-width 45%");
  });

  it("图标钮 28×28；视图选项菜单 min-width 200px", () => {
    for (const sel of [".rail-term-icon-btn {", ".rail-term-search-btn {"]) {
      const rule = decls(sel);
      assert.ok(/width:\s*28px/.test(rule) && /height:\s*28px/.test(rule), `${sel} 28×28（m6c §B5）`);
    }
    const menu = decls(".rail-term-view-menu {");
    assert.ok(/min-width:\s*200px/.test(menu), "视图选项菜单 min-width 200px（dsh 实测值）");
  });

  it("搜索槽展开态高度 28→30px（dsh 口径，height 不进过渡列表＝瞬时）", () => {
    const collapsed = decls(".rail-term-search {");
    assert.ok(/height:\s*28px/.test(collapsed), "收起态 28px");
    const expanded = decls(".rail-term-section-head.is-searching .rail-term-search {");
    assert.ok(/height:\s*30px/.test(expanded), "展开态 30px");
    // 过渡列表里不许出现 height（m6c §A1：28→30 瞬时跳）
    assert.ok(!/transition:[^;]*height/.test(collapsed), "height 不在过渡列表（瞬时跳变）");
  });
});

describe("M9 D2/D3 接线守卫：段头两钮点击必须接通（防「点了没反应」回归）", () => {
  // 背景：主控真机曾报「视图选项点不开／搜索不展开」，本 worktree 第二实例与生产
  // 47820 双环境真实点击均复现不出（菜单 8 项在场 1.5s＋、搜索 28→175px 展开聚焦）。
  // 但「点击无反应」这类断链在结构断言里极难发现，故用 vm 跑真委托把接线钉死：
  // 点钮 → 开菜单/展开搜索必须真的发生，toggle 状态机也要跟真模块状态走。
  const buildRail = (log) => {
    const listeners = {};
    const btn = (id) => ({
      id, onclick: null, disabled: false,
      addEventListener: (type, fn) => { listeners[`${id}:${type}`] = fn; },
      focus() { log.focus = id; },
      querySelector: () => null, setAttribute() {}, classList: { add() {}, remove() {}, contains: () => false },
      tabIndex: -1, value: "", blur() {},
    });
    const els = {
      railTerminalDir: { addEventListener: (type, fn) => { listeners[`dir:${type}`] = fn; }, getBoundingClientRect: () => ({ top: 0, left: 0 }), scrollTop: 0 },
      railTermNewBtn: btn("newBtn"), railTermHistoryRefresh: null,
      railTermSearchBtn: btn("searchBtn"), railTermSearchInput: btn("searchInput"), railTermSearchClear: btn("searchClear"),
      railTermViewOptionsBtn: btn("viewBtn"), railBackBtn: null, v2Rail: { addEventListener: () => {} },
    };
    const fn = new Function("els", "listeners", "log", `
      let terminalRailViewMenuEl = null;
      const terminalRailMenuEl = null;
      const terminalRailSearch = { open: false, query: "", timer: null, searching: false };
      const terminalRailHoverEl = null;
      const terminalRailHoverHead = null;
      let terminalRailMotionArmed = false;
      const document = { addEventListener: () => {} };
      function $(id) { return els[id] ?? null; }
      function loadTerminalRailViewPrefs() {}
      function loadTerminalRailCollapsedGroups() {}
      function initTerminalRailScrollbarQuiet() {}
      function closeTerminalRailGroupMenu() {}
      function closeTerminalRailHoverCard() {}
      // 开/关桩跟真模块状态同构：开即占位、关即清位——toggle 分支靠这个判
      function openTerminalRailViewMenu() { log.openView += 1; terminalRailViewMenuEl = {}; }
      function closeTerminalRailViewMenu() { log.closeView += 1; terminalRailViewMenuEl = null; }
      function openTerminalRailSearch() { log.openSearch += 1; terminalRailSearch.open = true; }
      function closeTerminalRailSearch() { log.closeSearch += 1; terminalRailSearch.open = false; }
      function onTerminalRailSearchInput() { log.input += 1; }
      function scheduleTerminalRailHoverCard() {}
      function terminalRailHeadKey() { return ""; }
      function terminalRailCloseSession() {}
      function terminalRailArchiveSession() {}
      function toggleTerminalRailGroupMenu() {}
      function terminalRailCreateTerminalInDir() {}
      function terminalRailRemoveGroup() {}
      function applyTerminalRailViewChoice() {}
      function terminalRailActivateSession() {}
      function terminalRailResumeHistoryRow() {}
      function terminalRailUnarchiveSession() {}
      function toggleTerminalRailGroup() {}
      function toggleTerminalRailWatermark() {}
      function terminalRailCreateTerminal() {}
      function refreshTerminalRailHistory() {}
      function terminalRailMoveInManualOrder() {}
      function renderTerminalRailHistory() {}
      function toast() {}
      ${extractFn("initTerminalRail")}
      return initTerminalRail;
    `)(els, listeners, log);
    fn();
    return listeners;
  };
  const freshLog = () => ({ openView: 0, closeView: 0, openSearch: 0, closeSearch: 0, input: 0, focus: "" });

  it("点视图选项钮 → 开菜单；二点 → 收起（D2 断链守卫）", () => {
    const log = freshLog();
    const listeners = buildRail(log);
    assert.equal(typeof listeners["viewBtn:click"], "function", "视图选项钮 click 监听已绑（没绑就是 D2）");
    listeners["viewBtn:click"]({ stopPropagation() {} });
    assert.equal(log.openView, 1, "首点＝开菜单");
    assert.equal(log.closeView, 0, "首点不收起");
    listeners["viewBtn:click"]({ stopPropagation() {} });
    assert.equal(log.closeView, 1, "二点＝收起（toggle 跟随真模块状态）");
  });

  it("点搜索钮 → 展开搜索；再点 → 只重新聚焦不收起（D3 断链守卫）", () => {
    const log = freshLog();
    const listeners = buildRail(log);
    assert.equal(typeof listeners["searchBtn:click"], "function", "搜索钮 click 监听已绑（没绑就是 D3）");
    listeners["searchBtn:click"]({ stopPropagation() {} });
    assert.equal(log.openSearch, 1, "首点＝展开");
    assert.equal(log.closeSearch, 0, "首点不收起（非 toggle）");
    listeners["searchBtn:click"]({ stopPropagation() {} });
    assert.equal(log.closeSearch, 0, "已展开再点＝不退出（m6c §A6：非 toggle）");
    assert.equal(log.focus, "searchInput", "再点＝重新聚焦输入框");
  });

  it("输入框 input 事件 → 防抖处理器（防抖链接通）", () => {
    const log = freshLog();
    const listeners = buildRail(log);
    assert.equal(typeof listeners["searchInput:input"], "function", "输入框 input 监听已绑");
    listeners["searchInput:input"]({ stopPropagation() {} });
    assert.equal(log.input, 1, "input 事件接通到 onTerminalRailSearchInput");
  });
});

describe("M9 复审必修：portal 后菜单项点击接线（真 DOM 守卫）", () => {
  // 背景：D1 把菜单 portal 到 body 后，菜单项（data-rail-term-view /
  // data-rail-term-remove-group）的唯一处理入口原先只在 #railTerminalDir 作用域
  // 的点击委托里——body 不是 dir 后代，点击永远到不了委托，菜单项全死。
  // 本守卫用真 openTerminalRailViewMenu/openTerminalRailGroupMenu 建菜单、挂到
  // 桩 body 上，经最小 DOM shim 真点一项，断言处理函数真的被调。
  const buildDom = () => {
    // 最小 DOM shim：createElement/append/属性/事件冒泡/closest/click
    const makeEl = (tag) => {
      const el = {
        tagName: tag, children: [], parent: null, attrs: {}, style: {}, textContent: "",
        _listeners: {},
        classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); } },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
        append(...kids) { for (const k of kids) { k.parent = el; el.children.push(k); } },
        appendChild(k) { el.append(k); },
        remove() { if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el); },
        addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
        // closest：沿父链找匹配 [attr] 选择器的祖先（够本用例）
        closest(sel) {
          const m = /^\[([\w-]+)\]$/.exec(sel);
          let cur = el;
          while (cur) {
            if (m && cur.getAttribute && cur.getAttribute(m[1]) !== null) return cur;
            cur = cur.parent;
          }
          return null;
        },
        // 真点：派发到自身监听并沿父链冒泡（document 委托就是这么收到点击的）
        click() {
          const event = { target: el, stopPropagation() { this._stopped = true; } };
          const chain = [];
          let cur = el;
          while (cur) { chain.push(cur); cur = cur.parent; }
          for (const node of chain) {
            if (event._stopped) break;
            const fns = node._listeners && node._listeners.click;
            if (fns) for (const fn of fns.slice()) fn(event);
          }
        },
        querySelectorAll(sel) {
          const m = /^\[([\w-]+)\]$/.exec(sel);
          const out = [];
          const walk = (node) => {
            for (const c of node.children || []) {
              if (m && c.getAttribute && c.getAttribute(m[1]) !== null) out.push(c);
              walk(c);
            }
          };
          walk(el);
          return out;
        },
        contains(node) {
          let cur = node;
          while (cur) { if (cur === el) return true; cur = cur.parent; }
          return false;
        },
        getBoundingClientRect: () => ({ top: 100, left: 100, right: 200, bottom: 130, width: 100, height: 30 }),
        offsetWidth: 200,
        focus() {}, blur() {},
        set innerHTML(v) { this.children = []; this._html = v; }, get innerHTML() { return this._html || ""; },
      };
      return el;
    };
    const body = makeEl("body");
    const document = {
      body,
      createElement: makeEl,
      addEventListener(type, fn) { (body._listeners[type] = body._listeners[type] || []).push(fn); },
      querySelector: () => null,
    };
    return { body, document, makeEl };
  };

  const buildRail = (log, dom) => {
    const listeners = {};
    const btn = (id) => ({
      id, onclick: null, disabled: false,
      addEventListener: (type, fn) => { listeners[id + ":" + type] = fn; },
      focus() {}, querySelector: () => null, setAttribute() {},
      getBoundingClientRect: () => ({ top: 100, left: 100, right: 128, bottom: 128, width: 28, height: 28 }),
      classList: { add() {}, remove() {}, contains: () => false },
      tabIndex: -1, value: "", blur() {},
    });
    const els = {
      railTerminalDir: { addEventListener: (type, fn) => { listeners["dir:" + type] = fn; }, getBoundingClientRect: () => ({ top: 0, left: 0 }), scrollTop: 0 },
      railTermNewBtn: btn("newBtn"), railTermHistoryRefresh: null,
      railTermSearchBtn: btn("searchBtn"), railTermSearchInput: btn("searchInput"), railTermSearchClear: btn("searchClear"),
      railTermViewOptionsBtn: btn("viewBtn"), railBackBtn: null, v2Rail: { addEventListener: () => {} },
      railTermHistoryList: {
        querySelectorAll: () => [{
          getAttribute: (name) => (name === "data-rail-term-group" ? "C:\\dev\\alpha" : null),
          getBoundingClientRect: () => ({ top: 100, left: 100, right: 200, bottom: 126, width: 100, height: 26 }),
        }],
      },
    };
    const fn = new Function("els", "listeners", "log", "document", "window", `
      let terminalRailMenuEl = null;
      let terminalRailViewMenuEl = null;
      const terminalRailSearch = { open: false, query: "", timer: null, searching: false };
      const terminalRailHoverEl = null;
      const terminalRailHoverHead = null;
      const terminalRailLastGroups = [];
      const TERMINAL_RAIL_VIEW_GROUPS = [
        { label: "分组方式", field: "groupBy", items: [
          { value: "workspace", label: "按工作区" },
          { value: "workspace-tree", label: "按工作区树" },
          { value: "flat", label: "单列表" },
        ] },
        { label: "排序方式", field: "orderBy", items: [
          { value: "updated", label: "最近更新" },
          { value: "manual", label: "手动排序" },
        ] },
        { label: "筛选会话", field: "archivedFilter", items: [
          { value: "default", label: "隐藏已归档" },
          { value: "show", label: "全部会话（显示已归档）" },
          { value: "only", label: "仅显示已归档" },
        ] },
      ];
      let terminalRailViewPrefs = { groupBy: "workspace", orderBy: "updated", archivedFilter: "default", sessionOrder: {} };
      const TERMINAL_RAIL_ICON_CHECK = "";
      function $(id) { return els[id] ?? null; }
      function loadTerminalRailViewPrefs() {}
      function saveTerminalRailViewPrefs() {}
      function loadTerminalRailCollapsedGroups() {}
      function initTerminalRailScrollbarQuiet() {}
      function closeTerminalRailGroupMenu() { log.closeGroup += 1; terminalRailMenuEl = null; }
      function closeTerminalRailViewMenu() { log.closeView += 1; terminalRailViewMenuEl = null; }
      function closeTerminalRailSearch() {}
      function closeTerminalRailHoverCard() {}
      function openTerminalRailSearch() {}
      function onTerminalRailSearchInput() {}
      function scheduleTerminalRailHoverCard() {}
      function terminalRailHeadKey() { return ""; }
      function terminalRailCloseSession() {}
      function terminalRailArchiveSession() {}
      function toggleTerminalRailGroupMenu() {}
      function terminalRailCreateTerminalInDir() {}
      function terminalRailActivateSession() {}
      function terminalRailResumeHistoryRow() {}
      function terminalRailUnarchiveSession() {}
      function toggleTerminalRailGroup() {}
      function toggleTerminalRailWatermark() {}
      function terminalRailCreateTerminal() {}
      function refreshTerminalRailHistory() {}
      function terminalRailMoveInManualOrder() {}
      function renderTerminalRailHistory() {}
      function toast() {}
      function sessDirName(p) { return String(p || "").split(/[\\\\/]/).filter(Boolean).pop() || p || ""; }
      function escapeHtml(v) { return String(v || ""); }

      // 被测真函数（真建菜单、真挂 body、真派事件）
      ${extractFn("terminalRailGroupHeadEl")}
      ${extractFn("terminalRailRemoveGroup")}
      ${extractFn("terminalRailCommitRemoveGroup")}
      ${extractFn("openTerminalRailGroupMenu")}
      ${extractFn("applyTerminalRailViewChoice")}
      ${extractFn("openTerminalRailViewMenu")}
      ${extractFn("initTerminalRail")}
      // 记录型替身：菜单项处理链的落点
      function showSkillsModal(opts) { log.modal = opts; }
      const realApply = applyTerminalRailViewChoice;
      applyTerminalRailViewChoice = function (field, value) { log.viewChoice = { field, value }; };
      const realRemove = terminalRailRemoveGroup;
      terminalRailRemoveGroup = function (key) { log.removeGroup = key; realRemove(key); };
      return { init: initTerminalRail, openView: openTerminalRailViewMenu, openGroup: openTerminalRailGroupMenu };
    `)(els, listeners, log, dom.document, { innerWidth: 1440 });
    return fn;
  };

  it("真点视图菜单项（单列表）→ applyTerminalRailViewChoice 被调（断链守卫）", () => {
    const log = { closeGroup: 0, closeView: 0, modal: null, viewChoice: null, removeGroup: null };
    const dom = buildDom();
    const rail = buildRail(log, dom);
    rail.init();
    rail.openView();
    const menu = dom.body.children[dom.body.children.length - 1];
    assert.ok(menu, "菜单挂到了桩 body 上");
    const items = menu.querySelectorAll("[data-rail-term-view]");
    assert.equal(items.length, 8, "真菜单构建器建出 8 项");
    const flat = items.find((el) => el.getAttribute("data-rail-term-view") === "groupBy:flat");
    assert.ok(flat, "「单列表」项在册");
    flat.click(); // 真点：冒泡到 document 委托
    assert.deepEqual(log.viewChoice, { field: "groupBy", value: "flat" }, "菜单项点击接通到 applyTerminalRailViewChoice（portal 后不断链）");
  });

  it("真点「移除分组」菜单项 → 确认弹窗出现（移除链通）", () => {
    const log = { closeGroup: 0, closeView: 0, modal: null, viewChoice: null, removeGroup: null };
    const dom = buildDom();
    const rail = buildRail(log, dom);
    rail.init();
    rail.openGroup("C:\\dev\\alpha");
    const menu = dom.body.children[dom.body.children.length - 1];
    const items = menu.querySelectorAll("[data-rail-term-remove-group]");
    assert.equal(items.length, 1, "⋯ 菜单建出 1 项");
    items[0].click(); // 真点：冒泡到 document 委托
    assert.equal(log.removeGroup, "C:\\dev\\alpha", "移除分组入口接通");
    assert.ok(log.modal, "确认弹窗被请求（移除链真点通）");
    assert.equal(log.modal.title, "移除分组", "弹窗标题");
    assert.equal(log.modal.confirmText, "移除分组", "确认钮文案");
    assert.equal(log.modal.danger, true, "红色 danger");
  });
});

describe("M9 复审必修 2：视图菜单 min-width 层叠", () => {
  // 真因：.rail-term-view-menu{min-width:200px} 与 .rail-term-menu{min-width:120px}
  // 同权重（0,1,0），后书者胜——视图菜单实际算出来 120px。修法：复合选择器提权重。
  // 这里跑一个迷你层叠模拟：收集所有能命中「同时带两类的元素」的规则，按
  // （特异性, 次序）取胜者，断言 min-width 落点。
  const cascadeMinWidth = (cssRaw) => {
    const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, ""); // 先剥注释：否则注释会混进选择器串
    const rules = [];
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const decl = /min-width:\s*(\d+)px/.exec(m[2]);
      if (!decl) continue;
      for (const sel of m[1].split(",")) {
        const s = sel.trim();
        if (!s.startsWith(".")) continue; // 只处理类选择器（够本用例）
        const classes = (s.match(/\.[\w-]+/g) || []).map((c) => c.slice(1));
        if (!classes.every((c) => c === "rail-term-menu" || c === "rail-term-view-menu")) continue;
        rules.push({ specificity: classes.length, order: m.index, minWidth: Number(decl[1]), selector: s });
      }
    }
    // 命中元素两类的规则里取胜者
    const hits = rules.filter((r) => {
      const cls = (r.selector.match(/\.[\w-]+/g) || []).map((c) => c.slice(1));
      return cls.every((c) => ["rail-term-menu", "rail-term-view-menu"].includes(c));
    });
    if (!hits.length) return null;
    hits.sort((a, b) => (b.specificity - a.specificity) || (b.order - a.order));
    return hits[0].minWidth;
  };

  it("层叠胜者的 min-width = 200px（不被 .rail-term-menu 的 120px 盖掉）", () => {
    const railBlock = panelCss.slice(panelCss.indexOf("/* ── 终端会话栏"), panelCss.indexOf("── 阶段 2 补"));
    assert.equal(cascadeMinWidth(railBlock), 200, "视图菜单 min-width 计算值 200px（m6c §B2 实测值）");
  });

  it("视图选项菜单补随树滚动收场（对称组头菜单的 once-capture scroll 监听）", () => {
    const src = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
    const groupOpen = src.slice(src.indexOf("function openTerminalRailGroupMenu"), src.indexOf("function toggleTerminalRailGroupMenu"));
    const viewOpen = src.slice(src.indexOf("function openTerminalRailViewMenu"), src.indexOf("function applyTerminalRailViewChoice"));
    assert.ok(groupOpen.includes('addEventListener("scroll", closeTerminalRailGroupMenu, { capture: true, once: true })'),
      "组头菜单有滚动收场（既有）");
    assert.ok(viewOpen.includes('addEventListener("scroll", closeTerminalRailViewMenu, { capture: true, once: true })'),
      "视图菜单对称补上滚动收场（portal 到 body 后不随树滚，会飘）");
  });
});

describe("M10 F1：单列表模式下「新会话」兜底行不新建真组", () => {
  // 现象（M8 遗留）：flat 转换先于兜底注入执行，兜底行找不到 key "" 的伪组就新建
  // 一个真组——点「单列表」后平铺行之外多出一个真组头（key 如 C:\\Users\\me，
  // 内挂 live 兜底行）。修法：flat 模式下兜底行挂伪组（key ""）不新建组。
  it("flat ＋ 全新终端兜底行：无 key 非空的伪组头，兜底行挂在平铺伪组里", () => {
    const sandbox = renderSandbox({
      history: {
        endpoint: "kimi",
        sessions: [
          { id: "s-1", endpoint: "kimi", project: "C:\\dev\\alpha", title: "重构权限矩阵", lastActive: 100 },
          { id: "s-2", endpoint: "kimi", project: "C:\\dev\\beta", title: "接入渠道", lastActive: 200 },
        ],
        fetchedAt: 1,
        error: null,
      },
      activeSession: { id: "t-9", cwd: "C:\\Users\\me", agent: { endpointId: "kimi" }, status: "idle", backendState: { createdAt: 500 } },
      viewPrefs: { groupBy: "flat", orderBy: "updated", archivedFilter: "default", sessionOrder: {} },
    });
    sandbox.fn.render("kimi");
    // 平铺行在册（两历史行直接平铺，无组头）
    assert.ok(sandbox.list.html.includes('data-rail-term-resume="s-1"'), "历史行平铺在册");
    assert.ok(sandbox.list.html.includes('data-rail-term-resume="s-2"'), "历史行平铺在册");
    // 兜底行在册（挂在伪组里）
    assert.ok(sandbox.list.html.includes(">新会话<"), "兜底行在册");
    // 关键断言：不得有 key 非空的组头（伪组头残留）
    assert.ok(!/data-rail-term-group="(?!")[^"]*"/.test(sandbox.list.html),
      "flat 模式无 key 非空的组头（兜底行不新建真组）");
    assert.ok(!sandbox.list.html.includes("rail-term-group-head"), "flat 模式干脆没有组头元素");
  });

  it("对照组：按工作区模式下兜底行照旧为无历史会话的新目录建组", () => {
    const sandbox = renderSandbox({
      history: { endpoint: "kimi", sessions: [], fetchedAt: 1, error: null },
      activeSession: { id: "t-9", cwd: "C:\\Users\\me", agent: { endpointId: "kimi" }, status: "idle", backendState: { createdAt: 500 } },
    });
    sandbox.fn.render("kimi");
    assert.ok(sandbox.list.html.includes("rail-term-group-head"), "非 flat 模式照旧建组");
    assert.ok(sandbox.list.html.includes(">新会话<"), "兜底行在册");
  });
});

describe("M10 F2：点「移除分组」先收场组头菜单再开弹窗", () => {
  // 现象：菜单 z-index 1200 高于弹窗 overlay 300，菜单滞留 DOM 到下一次外点，
  // 窄窗/靠中组头下可能压住弹窗。修法：开弹窗前先 closeTerminalRailGroupMenu()。
  it("terminalRailRemoveGroup：先收场菜单，后开弹窗（调用有序）", () => {
    const order = [];
    const fn = new Function("order", `
      function closeTerminalRailGroupMenu() { order.push("closeMenu"); }
      function showSkillsModal(opts) { order.push("modal"); return opts; }
      function escapeHtml(v) { return String(v || ""); }
      function sessDirName(p) { return String(p || "").split(/[\\\\/]/).filter(Boolean).pop() || p || ""; }
      ${extractFn("terminalRailRemoveGroup")}
      return terminalRailRemoveGroup;
    `)(order);
    fn("C:\\dev\\alpha");
    assert.deepEqual(order, ["closeMenu", "modal"], "先收场组头菜单，再开确认弹窗（菜单不许压在弹窗上）");
  });
});

describe("M12-A 内切判定矩阵（vm 真跑）", () => {
  // 点栏内历史会话、去重未命中后：对当前活跃视口显示的终端 A 做判定。视口是唯一能换
  // 内容的槽——空白壳/idle/exited 就地换（同页签）；working、switch_busy 与补读失败
  // 都属「旧终端可能在跑」，走保活分支：旧终端留后台不杀，目标终端挂进当前视口，页签
  // 数同样不变（绝不 /switch，那会 terminate 旧进程树）。唯一加页签的情形是没有可挂
  // 视口（placement "new"）。一次内切期间在飞闸忽略后续点击。

  it("空白壳内切接管：同页签换内容，POST switch 带目标 resume＋cwd，不开新页签", async () => {
    const { fn, log } = runSwitch({
      sessions: { "t-a": { ...BLANK } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING, switchImpl: async () => SWITCH_OK,
    });
    fn.go(HISTORY_ROW);
    await flush();
    assert.deepEqual(log.gets, [
      { method: "GET", path: "/api/agents" },
      { method: "GET", path: "/api/terminal/sessions/t-a" },
      { method: "POST", path: "/api/terminal/sessions/t-a/switch" },
    ], "补读两拍（活跃＋宿主单读）都在判定与切换之间");
    assert.equal(log.creates.length, 0, "不开新页签");
    assert.deepEqual(fn.sessions["t-a"].resume, { endpoint: "kimi", id: "s-1" }, "换绑后同页签就是目标会话（再去重点它会聚焦本页签）");
    assert.equal(fn.sessions["t-a"].label, "重构权限矩阵", "标签同步");
    assert.equal(fn.gate(), false, "闸已放行");
    assert.ok(log.renders >= 1, "重渲（栏/页签/会话数据同拍）");
  });

  it("idle/exited 内切：对话在盘上无实质损失，照旧就地换", async () => {
    for (const [name, hostRead, active] of [["idle", HOST_RUNNING, IDLE], ["exited", HOST_EXITED, IDLE]]) {
      const { fn, log } = runSwitch({
        sessions: { "t-a": { ...active } }, activeId: "t-a",
        agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => hostRead, switchImpl: async () => SWITCH_OK,
      });
      fn.go(HISTORY_ROW);
      await flush();
      assert.equal(log.creates.length, 0, `${name} 不开新页签`);
      assert.ok(log.gets.some((g) => g.path.endsWith("/switch")), `${name} 走内切`);
    }
  });

  it("已归属会话空闲自绘不误判 working：点历史仍就地内切，不多开（真实富化链路）", async () => {
    // 用户报的症状 1 主路径：新会话页挂着不动（TUI 自绘让输出窗一直「新鲜」），
    // 点历史会话却多开一页。桩式 enrich 把 working 重写成「有请求」，覆盖不到这
    // 条；这里走真 enrich（经回合闸）：零请求 + 输出新鲜但未入回合 → idle → 内切。
    const { fn, log } = runSwitch({
      sessions: {
        "t-a": {
          ...IDLE, status: "idle",
          backendState: { status: "running", createdAt: Date.now() - 600_000, spawnedAt: Date.now() - 600_000, lastActiveAt: Date.now() - 500 },
        },
      },
      activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
      switchImpl: async () => SWITCH_OK, realEnrich: true,
    });
    fn.go(HISTORY_ROW);
    await flush();
    assert.equal(log.creates.length, 0, "空闲自绘不点亮：就地内切，不开新页签");
    assert.equal(log.switchBodies.length, 1, "走 /switch");
  });

  it("回合内（请求曾在途）输出新鲜：仍判 working，点历史新开页签保护在跑任务", async () => {
    // 反向钉子：闸门只收「空闲自绘」，不能把回合内执行工具命令的会话也判空闲。
    const { fn, log } = runSwitch({
      sessions: {
        "t-a": {
          ...IDLE, status: "idle",
          backendState: { status: "running", createdAt: Date.now() - 600_000, spawnedAt: Date.now() - 600_000, lastActiveAt: Date.now() - 500 },
        },
      },
      activeId: "t-a",
      agentsImpl: async () => AGENTS_WORKING, hostReadImpl: async () => HOST_RUNNING,
      switchImpl: async () => SWITCH_OK, realEnrich: true,
    });
    fn.go(HISTORY_ROW);
    await flush();
    assert.equal(log.creates.length, 1, "回合内照旧保护性新开");
    assert.ok(!log.gets.some((g) => g.path.endsWith("/switch")), "不发内切");
  });

  it("已退出会话不被迟到的活跃信号误判 working：点历史仍内切，不多开", async () => {
    const { fn, log } = runSwitch({
      sessions: { "t-a": { ...IDLE, status: "idle", backendState: { status: "exited" } } },
      activeId: "t-a",
      agentsImpl: async () => AGENTS_WORKING, hostReadImpl: async () => HOST_EXITED,
      switchImpl: async () => SWITCH_OK, realEnrich: true,
    });
    fn.go(HISTORY_ROW);
    await flush();
    assert.equal(log.creates.length, 0, "进程已退出：没有运行任务可保护，不开新页签");
    assert.deepEqual(log.toasts, [], "真实富化依赖齐全，不把异常误当分支结果");
    assert.equal(log.switchBodies.length, 1, "按 exited 矩阵内切");
  });

  it("working 不内切：旧终端留后台保活、目标终端挂进当前视口（页签不增），原终端不动", async () => {
    const { fn, log } = runSwitch({
      sessions: { "t-a": { ...WORKING } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_WORKING, hostReadImpl: async () => HOST_RUNNING, switchImpl: async () => SWITCH_OK,
    });
    fn.go(HISTORY_ROW);
    await flush();
    assert.equal(log.creates.length, 1, "只建目标终端");
    assert.deepEqual(log.creates[0], { agentId: "kimi", cwd: "C:\\dev\\alpha", resume: { endpoint: "kimi", id: "s-1", file: "C:\\Users\\fixture\\.kimi\\sessions\\s-1.jsonl" } },
      "目标终端就是既有的续接新建（M3 契约原样）");
    assert.deepEqual(log.placements[0], { placement: "viewport", keepPrevious: true },
      "落点是当前视口 + 旧终端强制保活：页签数不变，在跑任务不被树杀");
    assert.ok(!log.gets.some((g) => g.path.endsWith("/switch")), "不发内切（/switch 会 terminate 旧进程树）");
    assert.deepEqual(fn.sessions["t-a"].resume, { endpoint: "kimi", id: "s-old" }, "原终端身份没被碰");
  });

  it("补读失败（活跃面或宿主单读）：判不出按「在跑」处置——保活旧终端、目标挂当前视口", async () => {
    for (const [name, agentsImpl, hostReadImpl] of [
      ["活跃面失败", async () => { throw new Error("HTTP 500"); }, async () => HOST_RUNNING],
      ["宿主单读失败", async () => AGENTS_IDLE, async () => { throw new Error("HTTP 500"); }],
    ]) {
      const { fn, log } = runSwitch({
        sessions: { "t-a": { ...IDLE } }, activeId: "t-a",
        agentsImpl, hostReadImpl, switchImpl: async () => SWITCH_OK,
      });
      fn.go(HISTORY_ROW);
      await flush();
      assert.equal(log.creates.length, 1, `${name} 照旧建目标终端`);
      assert.deepEqual(log.placements[0], { placement: "viewport", keepPrevious: true },
        `${name} 判不出时按在跑：旧终端保活，不误杀（A12）`);
      assert.ok(!log.gets.some((g) => g.path.endsWith("/switch")), `${name} 不发内切`);
    }
  });

  it("无活跃视口/活跃是设计稿预览会话：无从内切，建目标终端（无视口才新开视口）", async () => {
    for (const [name, sessions, activeId] of [
      ["零终端", {}, "t-a"],
      ["预览会话", { "t-a": { ...PREVIEW } }, "t-a"],
    ]) {
      const { fn, log } = runSwitch({
        sessions, activeId,
        agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING, switchImpl: async () => SWITCH_OK,
      });
      fn.go(HISTORY_ROW);
      await flush();
      assert.equal(log.creates.length, 1, `${name} 建目标终端`);
      assert.deepEqual(log.placements[0], { placement: "new" },
        `${name} 没有可挂的视口：新开一个视口承接（唯一加页签的情形）`);
      assert.ok(!log.gets.some((g) => g.path.endsWith("/switch")), `${name} 不发内切`);
    }
  });

  it("在飞闸：一次内切进行期间，后续栏内点击被忽略", async () => {
    let release;
    const { fn, log } = runSwitch({
      sessions: { "t-a": { ...BLANK } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
      switchImpl: () => new Promise((resolve) => { release = resolve; }),
    });
    fn.go(HISTORY_ROW);
    await flush(); // 等补读两拍落定、switch 在飞
    assert.equal(fn.gate(), true, "闸关着");
    const getsBefore = log.gets.length;
    fn.go({ ...HISTORY_ROW, id: "s-2" });
    assert.equal(log.gets.length, getsBefore, "第二次点击不发任何请求（在飞闸）");
    release(SWITCH_OK);
    await flush();
    assert.equal(fn.gate(), false, "落定后放行");
  });

  it("切换失败：不删本地状态、维持现状、不静默吞", async () => {
    const { fn, log } = runSwitch({
      sessions: { "t-a": { ...BLANK } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
      switchImpl: async () => { throw Object.assign(new Error("HTTP 500：boom"), { serverCode: "http_500" }); },
    });
    fn.go(HISTORY_ROW);
    await flush();
    assert.ok(fn.sessions["t-a"], "本地会话记录还在（没被删）");
    assert.equal(fn.sessions["t-a"].resume, null, "身份没被改花（失败不半吊子换绑）");
    assert.equal(log.toasts.length, 1, "有提示");
    assert.equal(log.toasts[0].isErr, true, "按错误上屏");
    assert.ok(!log.toasts[0].msg.includes("HTTP"), "服务端原文不上屏");
    assert.equal(fn.gate(), false, "失败也放行（可重试）");
  });

  it("杀前复核拒换（switch_busy）：按「在跑」改走保活分支，原终端不动、不加页签", async () => {
    // LLM 空档＋静默命令＝前端判定够不着的灰色地带，服务端 switch-guard 探测兜
    // 底：409 短码回来后按「在跑」处置——旧终端不杀、目标终端挂进当前视口，页签数
    // 不变（旧实现是静默新开页签，那正是页签变多的直接来源）。
    const { fn, log } = runSwitch({
      sessions: { "t-a": { ...IDLE } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
      switchImpl: async () => { throw Object.assign(new Error("HTTP 409：switch_busy"), { code: "switch_busy", serverCode: "switch_busy" }); },
    });
    fn.go(HISTORY_ROW);
    await flush();
    assert.equal(log.creates.length, 1, "建目标终端（保护在跑命令）");
    assert.deepEqual(log.creates[0], { agentId: "kimi", cwd: "C:\\dev\\alpha", resume: { endpoint: "kimi", id: "s-1", file: "C:\\Users\\fixture\\.kimi\\sessions\\s-1.jsonl" } },
      "目标终端带目标会话续接身份（M3 契约原样）");
    assert.deepEqual(log.placements[0], { placement: "viewport", keepPrevious: true },
      "旧终端强制保活：服务端刚证明它有活进程，绝不能回头当空闲杀");
    assert.equal(log.toasts.length, 0, "不提示（目标已换上，没有需要用户处理的失败）");
    assert.deepEqual(fn.sessions["t-a"].resume, { endpoint: "kimi", id: "s-old" }, "原终端身份没被碰，在跑命令继续");
    assert.equal(fn.gate(), false, "失败也放行（可重试）");
  });

  it("切换失败回续接族短码（resume-invalid / resume-unsupported）：落已批准续接句，服务端原文不上屏", async () => {
    // /switch 路由级拒换把 error 也置成机器码本身（文案零新增冻结条款），api() 落
    // err.code/err.serverCode 双通道都是短码——前端 startsWith("resume-") 门接住，
    // 落「这个 Agent 的会话暂时不能在终端里续接」，短码与服务端原文都不外泄。
    for (const code of ["resume-invalid", "resume-unsupported"]) {
      const { fn, log } = runSwitch({
        sessions: { "t-a": { ...BLANK } }, activeId: "t-a",
        agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
        switchImpl: async () => { throw Object.assign(new Error(`HTTP 400：${code}`), { code, serverCode: code }); },
      });
      fn.go(HISTORY_ROW);
      await flush();
      assert.equal(log.toasts.length, 1, `${code}：只提示一次`);
      assert.equal(log.toasts[0].msg, "这个 Agent 的会话暂时不能在终端里续接", `${code}：落已批准续接句`);
      assert.ok(!log.toasts[0].msg.includes("resume-"), `${code}：短码不外泄`);
      assert.equal(fn.sessions["t-a"].resume, null, `${code}：身份没被改花`);
      assert.equal(fn.gate(), false, `${code}：失败也放行（可重试）`);
    }
  });

  it("乐观选中（M5）：内切失败即撤 pending；switch_busy 转新开不清（点击仍在兑现途中）", async () => {
    // 失败清点：宿主判死 → 撤高亮（点亮的行没换成，继续说它选中就是说谎）。
    const failed = runSwitch({
      sessions: { "t-a": { ...BLANK } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
      switchImpl: async () => { throw Object.assign(new Error("HTTP 500：boom"), { serverCode: "http_500" }); },
    });
    failed.fn.begin(HISTORY_ROW);
    assert.ok(failed.fn.pending(), "判定门前点亮");
    failed.fn.go(HISTORY_ROW);
    await flush();
    assert.equal(failed.fn.pending(), null, "内切失败即撤乐观高亮");
    assert.equal(failed.log.toasts.length, 1, "照旧提示一次");

    // resume-* 族（落批准句的那条）同路撤。
    const unsupported = runSwitch({
      sessions: { "t-a": { ...BLANK } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
      switchImpl: async () => { throw Object.assign(new Error("HTTP 400：resume-unsupported"), { code: "resume-unsupported", serverCode: "resume-unsupported" }); },
    });
    unsupported.fn.begin(HISTORY_ROW);
    unsupported.fn.go(HISTORY_ROW);
    await flush();
    assert.equal(unsupported.fn.pending(), null, "resume-* 失败也撤");
    assert.equal(unsupported.log.toasts[0].msg, "这个 Agent 的会话暂时不能在终端里续接", "落批准句");

    // switch_busy 不清：改走保活分支后点击仍在兑现途中（目标终端由同一视口换上，
    // 失败由 createAgentTerminal 的 catch 清，见 panel-terminal-rail 的真跑）。
    const busy = runSwitch({
      sessions: { "t-a": { ...IDLE } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
      switchImpl: async () => { throw Object.assign(new Error("HTTP 409：switch_busy"), { code: "switch_busy", serverCode: "switch_busy" }); },
      createImpl: async () => ({ id: "t-new", resume: { endpoint: "kimi", id: "s-1" } }),
    });
    busy.fn.begin(HISTORY_ROW);
    busy.fn.go(HISTORY_ROW);
    await flush();
    assert.ok(busy.fn.pending() && busy.fn.pending().id === "s-1", "switch_busy 不清（新终端换上后 live 行接任）");
    assert.equal(busy.log.creates.length, 1, "改走保活分支（建目标终端）");
  });


  it("全新内切：idle 页签就地换新会话，POST 体带 agentId＋cwd（无 resume 键），不开新页签", async () => {
    const { fn, log } = runSwitch({
      sessions: { "t-a": { ...IDLE } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING, switchImpl: async () => SWITCH_FRESH_OK,
    });
    fn.goFresh({ agentId: "kimi", cwd: "C:\\dev\\alpha" });
    await flush();
    assert.deepEqual(log.switchBodies, [{ agentId: "kimi", cwd: "C:\\dev\\alpha" }], "全新内切必须带目标 agentId，且不带 resume 键");
    assert.equal(log.creates.length, 0, "不开新页签");
    assert.equal(fn.sessions["t-a"].resume, null, "旧会话身份被清空（兜底行/去重都以新会话为准）");
    assert.equal(fn.sessions["t-a"].agentId, "kimi", "agent 身份换绑");
    assert.ok(log.renders >= 1, "重渲（兜底行出现走同拍）");
  });

  it("全新内切矩阵：working 走保活分支（旧终端不杀、不加页签）；无视口才新开视口", async () => {
    for (const [name, sessions, expected] of [
      ["working 保活", { "t-a": { ...WORKING } }, { placement: "viewport", keepPrevious: true }],
      ["零终端", {}, { placement: "new" }],
      ["预览会话", { "t-a": { ...PREVIEW } }, { placement: "new" }],
    ]) {
      const { fn, log } = runSwitch({
        sessions, activeId: "t-a",
        agentsImpl: async () => AGENTS_WORKING, hostReadImpl: async () => HOST_RUNNING, switchImpl: async () => SWITCH_FRESH_OK,
      });
      fn.goFresh({ agentId: "kimi", cwd: "C:\\dev\\alpha" });
      await flush();
      assert.equal(log.creates.length, 1, `${name}：建目标终端`);
      assert.deepEqual(log.creates[0], { agentId: "kimi", cwd: "C:\\dev\\alpha", resume: null }, `${name}：新建不带 resume`);
      assert.deepEqual(log.placements[0], expected, `${name}：落点按视口矩阵`);
      assert.equal(log.switchBodies.length, 0, `${name}：不发内切`);
    }
  });

  it("全新内切 switch_busy：按「在跑」保活旧终端，原终端不动、不加页签", async () => {
    const { fn, log } = runSwitch({
      sessions: { "t-a": { ...IDLE } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
      switchImpl: async () => { throw Object.assign(new Error("HTTP 409：switch_busy"), { code: "switch_busy", serverCode: "switch_busy" }); },
    });
    fn.goFresh({ agentId: "kimi", cwd: "C:\\dev\\alpha" });
    await flush();
    assert.equal(log.creates.length, 1, "建目标终端");
    assert.deepEqual(log.placements[0], { placement: "viewport", keepPrevious: true },
      "旧终端留后台保活：/switch 被拒证明它有活进程，回头杀它就是误杀");
    assert.equal(log.toasts.length, 0, "不提示（目标已换上）");
    assert.deepEqual(fn.sessions["t-a"].resume, { endpoint: "kimi", id: "s-old" }, "原终端身份没被碰");
  });
});

// runSwitch 提升为顶层工具：M12-A 判定矩阵与全新内切乐观选中两族共用
const runSwitch = ({ sessions, activeId, agentsImpl, hostReadImpl, switchImpl, createImpl, realEnrich = false }) => {
  const log = { gets: [], switchBodies: [], creates: [], placements: [], toasts: [], renders: 0 };
  const fn = new Function("sessions", "activeId", "log", "agentsImpl", "hostReadImpl", "switchImpl", "createImpl", "realEnrich", `      let terminalBackendReady = true;
    const terminalBackendSessions = sessions;
    let activeTerminalPreviewId = activeId;
    let terminalSwitchInFlight = false;
    ${viewportPrelude(["terminalViewportNextId", "terminalViewportCreate", "terminalViewportActive", "terminalViewportForTerminal", "terminalViewportAttach", "terminalViewportById", "terminalViewportActivate", "terminalSessionRunning", "terminalViewportRetire", "terminalViewportPlaceTerminal", "terminalRailKeepAliveSwitch", "terminalRailFindOpenSession", "terminalRailActivateSession"])}
    const terminalPreviewSessions = {};
    const terminalHollowStreak = new Map();
    function terminalCloseTerminal() { return true; }
    function armTerminalBootingOverlay() {}
    function api(method, path, body) {
      log.gets.push({ method, path });
      if (method === "GET" && path === "/api/agents") return Promise.resolve(agentsImpl());
      if (method === "GET" && path.startsWith("/api/terminal/sessions/")) return hostReadImpl();
      if (method === "POST" && path.endsWith("/switch")) { log.switchBodies.push(body); return Promise.resolve(switchImpl()); }
      return Promise.reject(new Error("unexpected " + method + " " + path));
    }
    // 契约级桩：入参是 agents 数组（真口径见 enrich 本体 panel.js:7758），按实例
    // activeRequests 置 working/idle。抽取的生产实现改名落地（enrichTerminalSessionsReal），
    // 由同名路由壳按 realEnrich 二选一——桩与真实现不能同名共处一域：函数声明提升
    // 会让后声明者（真实现）永远盖过桩，开关整个失效（普查 finding，曾致全部用例
    // 实跑真 enrich、注释口径与执行路径不符）。
    function enrichTerminalSessionsStub(agents) {
      const row = Array.isArray(agents) && agents[0] && Array.isArray(agents[0].instances) ? agents[0].instances[0] : null;
      const working = !!(row && row.activeRequests > 0);
      for (const s of Object.values(terminalBackendSessions)) if (s.agent) s.status = working ? "working" : "idle";
    }
    function enrichTerminalSessions(agents) {
      if (realEnrich) enrichTerminalSessionsReal(agents);
      else enrichTerminalSessionsStub(agents);
    }
    function createAgentTerminal(opts, options) { log.creates.push(opts); log.placements.push(options || {}); return Promise.resolve(createImpl(opts)); }
    function terminalBackendSession(item) { return { ...item }; }
    function renderTerminalPreviewSession() { log.renders += 1; }
    function toast(msg, isErr) { log.toasts.push({ msg, isErr }); }
    function panelError(err, fallback) { return fallback; }
    function terminalSessionFor(id) { return terminalBackendSessions[id] || null; }
    function boardRoutingChains() { return []; }
    let routeRuntimeState = "none";
    let routeRuntimeCache = null;
    const terminalDoneUnread = new Map();
    const terminalPrevWorking = new Map();
    // 回合闸（working 口径的跨拍状态）：桩环境给空表；真 enrich 路径会用它。
    const terminalTurnArmed = new Set();
    ${extractFn("terminalInstanceRow")}
    ${extractFn("terminalMetricNum")}
    ${extractFn("terminalWorkTime")}
    ${extractFn("terminalMetricsFromInstance")}
    ${extractFn("terminalRouteForEndpoint")}
    ${extractFn("terminalBusyByOutput")}
    ${extractFn("terminalCommandRunning")}
    ${extractFn("terminalSessionBusyFromSignals")}
    ${extractFn("noteTerminalWorkingStatus")}
    ${extractFn("enrichTerminalSessions").replace("function enrichTerminalSessions(", "function enrichTerminalSessionsReal(")}
    let terminalRailSelectPending = null;
    let terminalRailSelectSeq = 0;
    const TERMINAL_RAIL_SELECT_TTL_MS = 12000;
    function renderTerminalRail() { log.railRenders = (log.railRenders || 0) + 1; }
    ${extractFn("terminalRailSwitchBusy")}
    ${extractFn("terminalRailBeginSelect")}
    ${extractFn("terminalRailArmSelect")}
    ${extractFn("terminalRailEndSelect")}
    ${extractFn("terminalRailSwitchOrCreateCore")}
    ${extractFn("terminalRailSwitchOrCreate")}
    // 新会话乐观选中（本 describe 下方测试族）的观察面：行渲染与兜底行推导真跑。
    const terminalRailHistory = { endpoint: "kimi", sessions: [], fetchedAt: 0, error: null };
    function terminalRailSameDir(a, b) {
      return String(a || "").replace(/\\+/g, "/").replace(/\\/+$/, "").toLowerCase()
        === String(b || "").replace(/\\+/g, "/").replace(/\\/+$/, "").toLowerCase();
    }
    function terminalRailIsArchived() { return false; }
    const TERMINAL_RAIL_SPINNER = "";
    const TERMINAL_RAIL_DONE_DOT = "";
    function esc(v) { return String(v); }
    function escapeHtml(v) { return String(v || ""); }
    const TERMINAL_RAIL_ICON_ARCHIVE = "<svg></svg>";
    const TERMINAL_RAIL_ICON_UNARCHIVE = "<svg></svg>";
    function sessTitle(s) { return s.title || String(s.id || "").slice(0, 8); }
    function terminalRailRelTime() { return "3 分钟前"; }
    function sessDirName(p) { return String(p || "").replace(/\\\\/g, "/").split("/").filter(Boolean).pop() || p || ""; }
    ${extractFn("terminalRailStateSlotHtml")}
    ${extractFn("terminalRailPendingRowHtml")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
    ${extractFn("terminalRailRowHtml")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
    ${extractFn("terminalRailAgentId")}
    ${extractFn("terminalRailActiveSession")}
    ${extractFn("terminalRailSessionMap")}
    ${extractFn("terminalRailPendingNewTerminals")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
    return {
      go: (row) => terminalRailSwitchOrCreate({ session: row, resume: { endpoint: row.endpoint, id: row.id, file: row.file }, cwd: row.project }),
      goFresh: ({ agentId, cwd }) => terminalRailSwitchOrCreateCore({ agentId, cwd }),
      gate: () => terminalSwitchInFlight,
      sessions: terminalBackendSessions,
      begin: (session) => terminalRailBeginSelect(session),
      beginFresh: (terminalId, cwd) => terminalRailBeginSelect({ terminalId, cwd }),
      pending: () => terminalRailSelectPending,
      pendingRowHtml: (entry, activeIdForRow) => terminalRailPendingRowHtml(entry, activeIdForRow),
      pendingFresh: () => terminalRailPendingNewTerminals(),
      switchBusy: terminalRailSwitchBusy,
      endSelect: (token) => terminalRailEndSelect(token),
      // 回合闸：进程树忙判据只在回合内算数（见 panel 的
      // terminalSessionBusyFromSignals），用例要模拟「回合已结束、命令还在跑」
      // 就得先把会话塞进闸里。
      armed: terminalTurnArmed,
    };
  `)(sessions, activeId, log, agentsImpl, hostReadImpl, switchImpl, createImpl ?? (async () => ({ id: "t-new" })), realEnrich);
  return { fn, log };
};

// 判定矩阵夹具（M12-A 判定矩阵与全新内切乐观选中两族共用）
const HISTORY_ROW = {
  endpoint: "kimi", id: "s-1", title: "重构权限矩阵", project: "C:\\dev\\alpha",
  file: "C:\\Users\\fixture\\.kimi\\sessions\\s-1.jsonl", resumeCommand: "kimi --session s-1",
};
const AGENTS_IDLE = { agents: [{ id: "kimi", instances: [{ id: "inst-1", activeRequests: 0 }] }] };
const AGENTS_WORKING = { agents: [{ id: "kimi", instances: [{ id: "inst-1", activeRequests: 1 }] }] };
const HOST_RUNNING = { id: "t-a", status: "running" };
const HOST_EXITED = { id: "t-a", status: "exited" };
const SWITCH_OK = { id: "t-a", status: "running", pid: 99, label: "重构权限矩阵", agentId: "kimi", agentName: "Kimi Code", resume: { endpoint: "kimi", id: "s-1" } };
const BLANK = { id: "t-a", backend: true, agentId: null, agentName: null, agent: null, resume: null, status: "idle", label: "Anyswitch" };
const IDLE = { id: "t-a", backend: true, agentId: "kimi", agentName: "Kimi Code", agent: { endpointId: "kimi", instanceId: "inst-1" }, resume: { endpoint: "kimi", id: "s-old" }, status: "idle", label: "旧会话", cwd: "C:\\dev\\alpha" };
const WORKING = { ...IDLE, status: "working" };
const PREVIEW = { id: "t-a", backend: false, agentId: null, agent: null, resume: null, status: "idle", label: "设计稿" };

// ── 进程树忙判据（agent.busy）：面板 working 的第四个输入 ──
// 面板的 working 原本只有「在途请求＋5s 输出窗＋回合闸」。三者都够不着「回合已
// 结束、agent 留下的子进程还在跑」——那一刻面板显示空闲，而内切杀前探测探到活
// 子进程就拒换（409），前端静默新开页签，用户观感即「内切失效」（2026-10-28 实机
// 复现：后台 node 进程活着，/switch 回 409）。relay 侧把守卫同源判据随 detected
// feed 下发为 agent.busy，这里钉它进 working 口径与判定门。
describe("进程树忙判据（agent.busy）进 working 口径与内切判定门", () => {
  // 一条「树里有活命令」的会话：零在途请求、输出窗早过期（lastActiveAt 很久以前），
  // 即面板旧口径下的纯空闲。唯有 agent.busy 为 true。
  const BUSY_SESSION = {
    ...IDLE, status: "idle",
    agent: { endpointId: "kimi", instanceId: "inst-1", busy: true },
    backendState: { status: "running", createdAt: Date.now() - 600_000, spawnedAt: Date.now() - 600_000, lastActiveAt: Date.now() - 60_000 },
  };
  const BUSY_NULL_SESSION = {
    ...IDLE, status: "idle",
    agent: { endpointId: "kimi", instanceId: "inst-1", busy: null },
    backendState: { status: "running", createdAt: Date.now() - 600_000, spawnedAt: Date.now() - 600_000, lastActiveAt: Date.now() - 60_000 },
  };
  const BUSY_FALSE_SESSION = {
    ...IDLE, status: "idle",
    agent: { endpointId: "kimi", instanceId: "inst-1", busy: false },
    backendState: { status: "running", createdAt: Date.now() - 600_000, spawnedAt: Date.now() - 600_000, lastActiveAt: Date.now() - 60_000 },
  };

  it("回合内树里有活命令：判 working 并保护性新开（不再让守卫单打独斗后静默转新开）", async () => {
    const { fn, log } = runSwitch({
      sessions: { "t-a": BUSY_SESSION }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
      switchImpl: async () => SWITCH_OK, realEnrich: true,
    });
    // 这一位只在回合内算数：先把会话塞进回合闸（请求出现过、回合已收尾、命令还没
    // 跑完），否则同形状的进程树在会话刚打开时只是 runtime 自查。
    fn.armed.add("t-a");
    fn.go(HISTORY_ROW);
    await flush();
    assert.equal(fn.sessions["t-a"].status, "working", "忙判据把状态点亮");
    assert.equal(log.creates.length, 1, "保护性新开");
    assert.ok(!log.gets.some((g) => g.path.endsWith("/switch")), "前端自己就判得出忙，不再等守卫 409");
  });

  it("回合外 busy=true 不点亮：会话打开时的 runtime 自查不算 agent 在跑", async () => {
    // 同一条 BUSY_SESSION，唯一差别是这条页面生命周期里没有出现过在途请求（没入
    // 闸）。dsh / dsh-tui 在会话打开时会自己跑环境自查（where / codex / git），进程
    // 树与 agent 命令同像，旧口径在这一下闪转圈（2026-10-29 用户回报）。
    let release;
    const { fn, log } = runSwitch({
      sessions: { "t-a": { ...BUSY_SESSION } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
      switchImpl: () => new Promise((resolve) => { release = resolve; }), realEnrich: true,
    });
    fn.go(HISTORY_ROW);
    await flush();
    assert.equal(fn.sessions["t-a"].status, "idle", "回合外的树忙不点亮");
    assert.equal(log.creates.length, 0, "不转新开，照旧就地内切");
    release(SWITCH_OK);
    await flush();
  });

  it("busy 为 false / null：都不点亮，照旧就地内切（判据不猜、不常亮）", async () => {
    for (const [name, session] of [["false", BUSY_FALSE_SESSION], ["null", BUSY_NULL_SESSION]]) {
      // switch 用一个可挂起的 Promise：在 POST 落定之前读页面状态，才读得到富化
      // 那一拍算出来的显示口径（落定后记录会被宿主快照整份换掉，status 是快照
      // 的 running，不是显示位）。
      let release;
      const { fn, log } = runSwitch({
        sessions: { "t-a": session }, activeId: "t-a",
        agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
        switchImpl: () => new Promise((resolve) => { release = resolve; }),
        realEnrich: true,
      });
      fn.go(HISTORY_ROW);
      await flush();
      assert.equal(fn.sessions["t-a"].status, "idle", `${name} 不点亮`);
      assert.equal(log.creates.length, 0, `${name} 不转新开`);
      assert.ok(log.gets.some((g) => g.path.endsWith("/switch")), `${name} 照旧走内切`);
      release(SWITCH_OK);
      await flush();
    }
  });

  it("忙判据不救已退出的会话：进程没了就没有任务可保护", async () => {
    // enabled/忙判据为 true，但宿主现态 exited：exited 先排（与「迟到的活跃信号不能
    // 把 exited 判忙」同一条），照样就地内切。
    let release;
    const { fn, log } = runSwitch({
      sessions: { "t-a": { ...BUSY_SESSION, backendState: { status: "exited" } } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_EXITED,
      switchImpl: () => new Promise((resolve) => { release = resolve; }),
      realEnrich: true,
    });
    fn.go(HISTORY_ROW);
    await flush();
    assert.equal(fn.sessions["t-a"].status, "idle", "exited 优先于忙判据");
    assert.equal(log.creates.length, 0, "内切");
    assert.ok(log.gets.some((g) => g.path.endsWith("/switch")), "走 /switch");
    release(SWITCH_OK);
    await flush();
  });

  it("忙判据只认自己这条会话的归属：未归属会话不因别人的 busy 点亮", async () => {
    // busy 挂在 agent 上；无归属（agent 为 null）的普通终端没有这一位。
    const { fn, log } = runSwitch({
      sessions: { "t-a": { ...IDLE, agent: null, status: "idle", backendState: { status: "running", createdAt: Date.now() - 600_000, spawnedAt: Date.now() - 600_000, lastActiveAt: Date.now() - 60_000 } } },
      activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
      switchImpl: async () => SWITCH_OK, realEnrich: true,
    });
    fn.go(HISTORY_ROW);
    await flush();
    assert.equal(log.creates.length, 0, "无归属终端维持原输出窗口径");
  });
});

// ── 全新内切（2026-10-25 用户拍板：「新建会话」/组头 ⊕ 与点历史行同门）──
// body 带 agentId＋cwd、不带 resume 键＝把当前页签就地换成一个全新 agent
// 会话；服务端按目标身份清空旧 resume。换绑快照 resume 为 null——兜底行
// 推导、去重聚焦都以此为准。
const SWITCH_FRESH_OK = { id: "t-a", status: "running", pid: 99, label: "Kimi Code", agentId: "kimi", agentName: "Kimi Code", agent: { endpointId: "kimi", instanceId: "inst-1" }, resume: null };

describe("全新内切乐观选中（M5 补口：组头 ⊕ / 新建会话无历史身份可先亮）", () => {
  // 症状：超实例页签内点「新建会话」/组头 ⊕，高亮在旧会话行上多留约半秒。
  // M5 的 pending 只认历史行身份（endpoint＋会话 id），全新内切既无 resume、
  // 活跃终端 id 又不变（同记录换内容），成功前没有任何通道能把高亮挪到新行——
  // 只能等 POST /switch 返回、spawnedAt 刷新后兜底行「新会话」才出现并被点亮。
  // 补口：判定门确定要内切后、POST 之前武装一枚按**终端 id**认行的 pending，
  // 兜底行随之提前出现（目标目录组顶），高亮当拍到位。
  const FRESH_CWDS = { agentId: "kimi", cwd: "C:\\dev\\alpha" };

  it("判定门：确定内切后武装 pending（键＝终端 id＋目标目录），成功由真值接管", async () => {
    let release;
    const { fn, log } = runSwitch({
      sessions: { "t-a": { ...IDLE } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
      switchImpl: () => new Promise((resolve) => { release = resolve; }),
    });
    fn.goFresh(FRESH_CWDS);
    await flush();
    const armed = fn.pending();
    assert.ok(armed, "POST /switch 在飞期间必须已有乐观高亮（否则这半秒栏上仍是旧行）");
    assert.equal(armed.terminalId, "t-a", "全新内切按终端 id 认行（活跃记录不换）");
    assert.equal(armed.cwd, "C:\\dev\\alpha", "记下目标目录：兜底行要落在目标组顶");
    assert.equal(armed.endpoint, "kimi", "端点随门内 agentId 记下（组归属同源）");
    assert.equal(armed.id, null, "不带历史会话 id（它不是历史行身份）");
    const entry = fn.pendingFresh().find((row) => row.id === "t-a");
    assert.ok(entry, "兜底行立刻可推导（不等 spawnedAt 刷新）");
    assert.equal(entry.cwd, "C:\\dev\\alpha", "落在目标目录");
    assert.ok(fn.pendingRowHtml(entry, "t-a").includes("is-active"), "兜底行当拍点亮");
    release(SWITCH_FRESH_OK);
    await flush();
    // 成功即收武装：兜底行的真实身份已由宿主快照（spawnedAt / resume）接手，高亮
    // 回落到「这条终端就是活跃终端」；不再占 12s TTL 的武装窗。
    assert.equal(fn.pending(), null, "成功后武装当场撤");
    assert.equal(log.creates.length, 0, "不开新页签");
  });

  it("判定门：working/补读失败照旧新开，从不武装（新开落点不是这条页签，亮它就是说谎）", async () => {
    const cases = [
      ["working 保护", { "t-a": { ...WORKING } }, async () => AGENTS_WORKING, async () => HOST_RUNNING],
      ["零终端", {}, async () => AGENTS_IDLE, async () => HOST_RUNNING],
      ["预览会话", { "t-a": { ...PREVIEW } }, async () => AGENTS_IDLE, async () => HOST_RUNNING],
      ["补读失败", { "t-a": { ...IDLE } }, async () => AGENTS_IDLE, async () => { throw new Error("HTTP 500"); }],
    ];
    for (const [name, sessions, agentsImpl, hostReadImpl] of cases) {
      const { fn, log } = runSwitch({ sessions, activeId: "t-a", agentsImpl, hostReadImpl, switchImpl: async () => SWITCH_FRESH_OK });
      fn.goFresh(FRESH_CWDS);
      await flush();
      assert.equal(fn.pending(), null, `${name}：不武装`);
      assert.equal(log.creates.length, 1, `${name}：照旧新开`);
    }
  });

  it("失败清点：内切失败撤 pending（点亮的行没换成）；switch_busy 转新开显式撤（新开在别的页签）", async () => {
    const failed = runSwitch({
      sessions: { "t-a": { ...IDLE } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
      switchImpl: async () => { throw Object.assign(new Error("HTTP 500：boom"), { serverCode: "http_500" }); },
    });
    failed.fn.goFresh(FRESH_CWDS);
    await flush();
    assert.equal(failed.fn.pending(), null, "内切失败即撤");
    assert.equal(failed.log.toasts.length, 1, "照旧提示一次");

    // 续接内切的 switch_busy 不清（M5 原口径：新开仍是这次点击的兑现，新页签会
    // 亮）；全新内切不同——兜底行提前出现锚在**本页签**上，转新开后本页签没换
    // 内容，留着就是点亮一个没发生的内切。
    const busy = runSwitch({
      sessions: { "t-a": { ...IDLE } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
      switchImpl: async () => { throw Object.assign(new Error("HTTP 409：switch_busy"), { code: "switch_busy", serverCode: "switch_busy" }); },
    });
    busy.fn.goFresh(FRESH_CWDS);
    await flush();
    assert.equal(busy.fn.pending(), null, "switch_busy 转新开：撤掉锚在本页签上的高亮");
    assert.equal(busy.log.creates.length, 1, "静默转新开");
    assert.deepEqual(busy.fn.pendingFresh(), [], "兜底行随之退场（本页签内容没换）");
  });

  it("收尾清点：activate（改主意点开着的行）无条件作废旧令牌", async () => {
    const { fn } = runSwitch({
      sessions: { "t-a": { ...IDLE } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING, switchImpl: async () => SWITCH_FRESH_OK,
    });
    fn.beginFresh("t-a", "C:\\dev\\alpha");
    assert.ok(fn.pending(), "判定门前点亮（入口上的手势先反馈）");
    fn.endSelect(null);
    assert.equal(fn.pending(), null, "无条件清点生效");
  });

  it("源码钉：武装点在判定门内、POST /switch 之前（working 分支之后）", () => {
    const decide = extractFn("terminalRailSwitchOrCreateCore");
    const armAt = decide.indexOf("terminalRailArmSelect(");
    const busyAt = decide.indexOf("if (working)");
    const postAt = decide.indexOf('await api("POST"');
    assert.ok(armAt > busyAt, "武装在 working 判定之后（working 转新开不许亮本页签）");
    assert.ok(armAt < postAt, "武装在 POST /switch 之前（高亮不等宿主 kill+spawn）");
    assert.ok(/terminalRailArmSelect\(\{[^}]*terminalId/.test(decide), "全新分支按终端 id 武装");
    const begin = extractFn("terminalRailBeginSelect");
    assert.ok(/terminalRailSwitchBusy\(\)/.test(begin), "入口的 BeginSelect 仍在飞闸前置（在飞点击不亮）");
    assert.ok(!/terminalRailSwitchBusy\(\)/.test(extractFn("terminalRailArmSelect")),
      "门内武装走无闸内核（判定门已持闸，过 BeginSelect 会被自己挡掉）");
    const row = extractFn("terminalRailPendingRowHtml");
    assert.ok(/terminalRailPendingFreshActive\(/.test(row),
      "兜底行选中判据加一条「pending 按终端 id 命中」的通道（原判据只认 activeId）");
    assert.ok(extractFn("terminalRailPendingNewTerminals").includes("terminalRailPendingFreshArmed"),
      "兜底行推导认被武装的终端：spawnedAt 还旧、resume 还在也提前出现");
  });
});


// ── M13 归档/撤销动效（FLIP）＋toast 动效与去向引导钮（dsh 对齐） ──
// 用户拍板方案：归档不再瞬时消失——被归档行克隆进覆盖层 100ms 淡出、下方行 200ms
// 上移、隐藏池回填行 100ms 淡入；撤销是镜像；toast 入场 -6px/160ms、驻留 6s 后
// 1s 淡出、动作点击瞬时收场；引导钮只在「隐藏已归档」筛选下出现（文案逐字批准）。
describe("M13 归档/撤销动效（FLIP）＋toast 引导钮", () => {
  // 6 条会话、水位线 5（TERMINAL_RAIL_WATERMARK）：归档 s-1 → s-6 回填进可见段；
  // 撤销 s-1 → s-6 再让位回隐藏池。行高 30px、首行视口 top 100、滚动层 top 50、
  // scrollTop 12——幽灵绝对位＝100−50＋12＝62px。
  const runExitFlip = ({ armed = true, reduced = false, mode = "archive" } = {}) => {
    const log = { posts: [], toasts: [], renders: 0, flipModes: [], ghosts: [] };
    const timers = []; // 退场幽灵移除定时器的捕获池（沙盒内 setTimeout 桩的落点）
    // 量测选择器与生产同串（2026-10-26 起含组头与水位线钮）
    const TERMINAL_RAIL_MOTION_SELECTOR_STUB = "[data-rail-term-resume], [data-rail-term-session], [data-rail-term-group-head], [data-rail-term-more]";
    const makeGhost = (id) => {
      const ghost = {
        id, style: {}, inert: false, removed: false, parent: null,
        classes: new Set(["rail-term-row"]),
        classList: { add: (c) => ghost.classes.add(c), contains: (c) => ghost.classes.has(c) },
        setAttribute: () => { ghost.inert = true; },
        animate: (frames, opts) => { log.ghosts.push({ id, frames, opts, ghost }); return {}; },
        remove: () => { ghost.removed = true; ghost.parent = null; },
        append: () => {},
      };
      return ghost;
    };
    const makeRow = (id, index) => ({
      id,
      getAttribute: (name) => (name === "data-rail-term-resume" ? id : null),
      hasAttribute: (name) => name === "data-rail-term-resume",
      getBoundingClientRect: () => ({ top: 100 + index * 30, left: 8, width: 240 }),
      cloneNode: () => makeGhost(id),
    });
    const rebuild = (ids) => ids.map((id, i) => makeRow(id, i));
    // 归档前置态：s-1..s-5 可见（s-6 在隐藏池）；撤销前置态：s-1 已归档、s-2..s-6 可见
    let visible = mode === "archive" ? rebuild(["s-1", "s-2", "s-3", "s-4", "s-5"]) : rebuild(["s-2", "s-3", "s-4", "s-5", "s-6"]);
    const host = {
      children: [], scrollTop: 12,
      getBoundingClientRect: () => ({ top: 50, left: 0 }),
      append: (ghost) => { ghost.parent = host; host.children.push(ghost); },
    };
    const list = {
      parentElement: host,
      querySelectorAll: (sel) => (sel === TERMINAL_RAIL_MOTION_SELECTOR_STUB ? visible.slice() : []),
    };
    // 渲染桩模拟重渲后的行集变化：归档→s-1 出布局、s-6 回填；撤销→s-1 回原槽、s-6 让位
    const swap = mode === "archive"
      ? () => { visible = rebuild(["s-2", "s-3", "s-4", "s-5", "s-6"]); }
      : () => { visible = rebuild(["s-1", "s-2", "s-3", "s-4", "s-5"]); };
    const sessions = ["s-1", "s-2", "s-3", "s-4", "s-5", "s-6"].map((id, i) => ({
      id, endpoint: "kimi", project: "C:\\dev\\alpha", title: `会话 ${id}`, lastActive: 100 - i,
    }));
    const fn = new Function("log", "list", "window", "armed", "swap", "sessions", "mode", "timers", `
      // setTimeout 捕获桩：退场幽灵的移除定时器（110ms）不真等墙钟（普查 finding：
      // 150ms 等待余量偏薄，负载抖动会提前断言）——记下回调与延迟值，测试里手动放行。
      const setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
      let terminalRailPrefs = mode === "archive"
        ? { archived: [], removedGroups: [] }
        : { archived: [{ endpoint: "kimi", id: "s-1" }], removedGroups: [] };
      let terminalRailHistory = { endpoint: "kimi", sessions, fetchedAt: 1, error: null };
      let terminalRailFlipMode = "instant";
      const terminalRailMotionArmed = armed;
      const TERMINAL_RAIL_MOTION_SELECTOR = "[data-rail-term-resume], [data-rail-term-session], [data-rail-term-group-head], [data-rail-term-more]";
      const TERMINAL_RAIL_UNGROUPED_HEAD = "~ungrouped";
      const terminalRailViewPrefs = { groupBy: "workspace", orderBy: "updated", archivedFilter: "default", sessionOrder: {} };
      function $(id) { return id === "railTermHistoryList" ? list : null; }
      function api(method, path, body) { log.posts.push({ method, path, body }); return Promise.resolve({ ok: true }); }
      function toast(msg, isErr, opts) { log.toasts.push({ msg, isErr, opts }); }
      function panelError(err, fallback) { return fallback; }
      function terminalRailAgentId() { return "kimi"; }
      function renderTerminalRailHistory() { log.renders += 1; log.flipModes.push(terminalRailFlipMode); swap(); }
      ${extractFn("terminalRailMotionKey")}
      ${extractFn("terminalRailMotionEntries")}
      ${extractFn("terminalRailArchivedKey")}
      ${extractFn("terminalRailMotionEnabled")}
      ${extractFn("terminalRailSnapshotMotion")}
      ${extractFn("terminalRailMountExitGhosts")}
      ${extractFn("terminalRailRerenderExitFlip")}
      ${extractFn("terminalRailArchiveSession")}
      ${extractFn("terminalRailUnarchiveSession")}
      return { archive: terminalRailArchiveSession, unarchive: terminalRailUnarchiveSession };
    `)(log, list, { matchMedia: () => ({ matches: reduced }) }, armed, swap, sessions, mode, timers);
    return { fn, log, host, list, timers };
  };

  describe("flip 门（vm 真跑）", () => {
    it("归档置 flip：渲染那拍 flipMode＝flip（与组折叠同一扇门），不再瞬时", () => {
      const { fn, log } = runExitFlip();
      fn.archive("s-1");
      assert.deepEqual(log.flipModes, ["flip"], "归档重渲走 FLIP 门——下方行 200ms 上移、回填行 100ms 淡入由 playTerminalRailFlip 承担");
    });

    it("撤销同门：flipMode＝flip（行落回＋回填行让位的镜像）", () => {
      const { fn, log } = runExitFlip({ mode: "unarchive" });
      fn.unarchive("kimi", "s-1");
      assert.deepEqual(log.flipModes, ["flip"], "撤销重渲走 FLIP 门");
    });
  });

  describe("退场幽灵行（vm 真跑）", () => {
    it("归档：被归档行克隆进滚动层——inert＋绝对定位＋100ms ease-out 淡出 fill forwards，淡出后移除", async () => {
      const { fn, log, host, timers } = runExitFlip();
      fn.archive("s-1");
      assert.equal(log.ghosts.length, 1, "只有离开布局的那一行有幽灵");
      assert.equal(log.ghosts[0].id, "s-1", "幽灵是被归档行");
      assert.deepEqual(log.ghosts[0].frames, [{ opacity: 1 }, { opacity: 0 }], "opacity→0 双关键帧");
      assert.equal(log.ghosts[0].opts.duration, 100, "100ms");
      assert.equal(log.ghosts[0].opts.easing, "ease-out", "ease-out");
      assert.equal(log.ghosts[0].opts.fill, "forwards", "fill forwards");
      const ghost = log.ghosts[0].ghost;
      assert.equal(host.children[0], ghost, "幽灵挂进滚动层（列表的父级）");
      assert.ok(ghost.classes.has("rail-term-ghost"), "幽灵类在册（absolute＋pointer-events:none 由 CSS 承担）");
      assert.equal(ghost.inert, true, "inert 属性置位（克隆不可聚焦不可命中）");
      assert.equal(ghost.style.top, "62px", "绝对位＝行视口位−滚动层位＋scrollTop（100−50＋12）");
      assert.equal(ghost.style.left, "8px", "左缘对齐原行");
      assert.equal(ghost.style.width, "240px", "宽同原行");
      assert.equal(timers.length, 1, "退场排了一个移除定时器（不再真等墙钟）");
      assert.equal(timers[0].ms, 110, "移除延迟 110ms（略长于 100ms 淡出）");
      timers[0].fn();
      assert.equal(ghost.removed, true, "淡出后移除（不残留 DOM）");
      assert.equal(host.children.length, 1, "存活行不克隆——下方行交给 FLIP 位移，不叠幽灵");
    });

    it("撤销镜像：水位线让位的回填行克隆淡出（s-6 回隐藏池）", async () => {
      const { fn, log, timers } = runExitFlip({ mode: "unarchive" });
      fn.unarchive("kimi", "s-1");
      assert.equal(log.ghosts.length, 1, "只有让位的回填行有幽灵");
      assert.equal(log.ghosts[0].id, "s-6", "幽灵是水位线让位的 s-6");
      assert.equal(timers.length, 1, "退场排了一个移除定时器");
      timers[0].fn();
      assert.equal(log.ghosts[0].ghost.removed, true, "淡出后移除");
    });

    it("armed 门与 reduced-motion：首次真实交互前、reduce 下不挂幽灵（一切瞬时）", () => {
      for (const opts of [{ armed: false }, { reduced: true }]) {
        const { fn, log } = runExitFlip(opts);
        fn.archive("s-1");
        assert.deepEqual(log.ghosts, [], `${JSON.stringify(opts)}：无幽灵克隆`);
        assert.deepEqual(log.flipModes, ["flip"], "门仍置 flip——实际播放由 playTerminalRailFlip 的 armed/reduce 守卫拦下");
      }
    });

    it("动效量测集＝行＋组头＋水位线钮：三类共用一套位移/淡入口径，键按类前缀不互撞；组头容器带身份属性", () => {
      const entriesFn = extractFn("terminalRailMotionEntries");
      assert.ok(entriesFn.includes("querySelectorAll(TERMINAL_RAIL_MOTION_SELECTOR)"),
        "唯一枚举点：量测集＝历史行＋兜底行＋组头＋水位线钮");
      assert.ok(entriesFn.includes("terminalRailMotionKey"),
        "同键的第 n 个出现补序号后缀（同 id 两行不互相覆盖旧位）");
      for (const fn of ["terminalRailSnapshotMotion", "terminalRailMotionTops", "playTerminalRailFlip", "terminalRailMountExitGhosts"]) {
        assert.ok(extractFn(fn).includes("terminalRailMotionEntries("),
          `${fn} 走同一份枚举（否则键序不一致＝又一次假位移）`);
      }
      const keyFn = extractFn("terminalRailMotionKey");
      for (const attr of ["data-rail-term-resume", "data-rail-term-session", "data-rail-term-group-head", "data-rail-term-more"]) {
        assert.ok(keyFn.includes(attr), `键读 ${attr}`);
      }
      for (const prefix of ["resume:", "pending:", "head:", "more:"]) {
        assert.ok(keyFn.includes(prefix), `键前缀 ${prefix}（组头与水位线钮同吃组键，不加前缀会互撞）`);
      }
      const render = extractFn("renderTerminalRailHistory");
      assert.ok(render.includes('class="rail-term-group-head" data-rail-term-group-head="${esc(group.key || TERMINAL_RAIL_UNGROUPED_HEAD)}"'),
        "组头容器自带身份属性（「未分组」组用哨兵键，空串＝不量）");
    });

    it("整组消失：组头进快照并以幽灵淡出（不再瞬跳消失）", () => {
      const ghosts = [];
      const host = { children: [], scrollTop: 0, getBoundingClientRect: () => ({ top: 50, left: 0 }), append: (g) => { g.parent = host; host.children.push(g); } };
      const makeHead = (key) => {
        const el = {
          classes: new Set(), style: {}, removed: false,
          classList: { add(c) { el.classes.add(c); } },
          setAttribute() {},
          getAttribute: (name) => (name === "data-rail-term-group-head" ? key : null),
          hasAttribute: (name) => name === "data-rail-term-group-head",
          getBoundingClientRect: () => ({ top: 100, left: 8, width: 240 }),
          animate: (frames, opts) => { ghosts.push({ frames, opts, el }); },
          remove() {},
        };
        el.cloneNode = () => makeHead(key);
        return el;
      };
      const snapshotList = { querySelectorAll: () => [makeHead("C:\\dev\\delta")] };
      const afterList = { querySelectorAll: () => [], parentElement: host };
      const fn = new Function("snapshotList", "afterList", "host", `
        const TERMINAL_RAIL_MOTION_SELECTOR = "[data-rail-term-resume], [data-rail-term-session], [data-rail-term-group-head], [data-rail-term-more]";
        const TERMINAL_RAIL_UNGROUPED_HEAD = "~ungrouped";
        ${extractFn("terminalRailMotionKey")}
        ${extractFn("terminalRailMotionEntries")}
        ${extractFn("terminalRailSnapshotMotion")}
        ${extractFn("terminalRailMountExitGhosts")}
        return { snapshot: terminalRailSnapshotMotion, mount: terminalRailMountExitGhosts };
      `)(snapshotList, afterList, host);
      const snapshot = fn.snapshot(snapshotList);
      assert.equal(snapshot.size, 1, "组头进快照");
      assert.ok(snapshot.has("head:C:\\dev\\delta"), "快照键带组头前缀");
      fn.mount(afterList, host, snapshot);
      assert.equal(host.children.length, 1, "离开布局的组头挂进滚动层");
      assert.equal(ghosts[0].opts.duration, 100, "组头幽灵 100ms 淡出（与行同）");
      assert.deepEqual(ghosts[0].frames, [{ opacity: 1 }, { opacity: 0 }], "淡出双关键帧");
      assert.ok(ghosts[0].el.classes.has("rail-term-ghost"), "幽灵类在册（absolute＋pointer-events:none 由 CSS 承担）");
    });
  });

  describe("armed 门挂点（源码钉死）", () => {
    it("会话栏捕获相挂 pointerdown/keydown——首次新建也武装，合成点击不武装", () => {
      const init = extractFn("initTerminalRail");
      assert.ok(init.includes('dir.addEventListener("pointerdown", armMotion, { once: true, capture: true })'),
        "pointerdown 捕获相挂栏体（覆盖列表外的新建按钮）");
      assert.ok(init.includes('dir.addEventListener("keydown", armMotion, { once: true, capture: true })'),
        "keydown 捕获相挂栏体");
      assert.ok(extractFn("terminalRailMotionEnabled").includes("!terminalRailMotionArmed"),
        "动效开关先看 armed（未武装＝瞬时）");
    });
  });

  describe("toast 第二钮「筛选已归档会话」（vm 真跑）", () => {
    const SESSION = { id: "s-1", endpoint: "kimi", title: "重构权限矩阵", project: "C:\\dev\\alpha" };
    const run = (archivedFilter) => runArchive(SESSION, {
      viewPrefs: { groupBy: "workspace", orderBy: "updated", archivedFilter, sessionOrder: {} },
    });

    it("筛选＝隐藏已归档：两钮在册——撤销＋筛选已归档会话（文案逐字）", async () => {
      const { fn, log } = run("default");
      fn.archive();
      await flush();
      const actions = log.toasts[0].opts.actions;
      assert.deepEqual(actions.map((action) => action.label), ["撤销", "筛选已归档会话"], "两钮文案逐字");
    });

    it("点击引导钮：切到「仅显示已归档」（applyTerminalRailViewChoice 接通）", async () => {
      const { fn, log } = run("default");
      fn.archive();
      await flush();
      log.toasts[0].opts.actions[1].onClick();
      assert.deepEqual(log.viewChoice, { field: "archivedFilter", value: "only" }, "切筛选动作接通（视图切换走既有通路）");
    });

    it("筛选＝show/only：只有撤销（引导钮只在隐藏已归档时出现）", async () => {
      for (const filter of ["show", "only"]) {
        const { fn, log } = run(filter);
        fn.archive();
        await flush();
        assert.deepEqual(log.toasts[0].opts.actions.map((action) => action.label), ["撤销"],
          `${filter} 下不出引导钮（归档行本就可见/独占视图）`);
      }
    });
  });

  describe("toast 件动效（vm 真跑＋源码钉死）", () => {
    const buildToast = () => {
      const t = {
        text: "", appended: [], tid: null, classes: new Set(),
        append(...kids) { t.appended.push(...kids); },
        set textContent(v) { t.text = v; }, get textContent() { return t.text; },
        set className(v) { t.classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
        classList: {
          add(...cs) { for (const c of cs) t.classes.add(c); },
          remove(...cs) { for (const c of cs) t.classes.delete(c); },
          contains: (c) => t.classes.has(c),
        },
      };
      Object.defineProperty(t, "_tid", { get: () => t.tid, set: (v) => { t.tid = v; } });
      const doc = {
        createTextNode: (s) => ({ kind: "text", text: s }),
        createElement: () => ({ kind: "el", className: "", textContent: "", onclick: null }),
      };
      const fn = new Function("t", "doc", `
        function $(id) { return id === "toast" ? t : null; }
        const document = doc;
        ${extractFn("toast")}
        ${extractFn("dismissToast")}
        return { toast, dismissToast };
      `)(t, doc);
      return { fn, t };
    };

    it("两钮渲染＋动作点击瞬时收场（is-gone 压过渡，不走 1s 淡出）", () => {
      const { fn, t } = buildToast();
      const clicks = [];
      fn.toast("会话已归档。", false, {
        durationMs: 6000,
        actions: [
          { label: "撤销", onClick: () => clicks.push("撤销") },
          { label: "筛选已归档会话", onClick: () => clicks.push("筛选") },
        ],
      });
      assert.ok(t.classes.has("show"), "上屏");
      assert.equal(t.appended[0].text, "会话已归档。", "文案节点逐字（主体不变）");
      const links = t.appended.slice(1);
      assert.deepEqual(links.map((link) => link.textContent), ["撤销", "筛选已归档会话"], "两钮逐字");
      assert.equal(links[0].className, "toast-action", "动作小字形状照旧");
      links[0].onclick();
      assert.deepEqual(clicks, ["撤销"], "点击接通 onClick");
      assert.ok(!t.classes.has("show"), "动作点击摘 show（瞬时消失）");
      assert.ok(t.classes.has("is-gone") && !t.classes.has("is-leaving"), "瞬时收场走 is-gone，不进 1s 淡出");
      clearTimeout(t.tid);
    });

    it("单 action 兼容：既有调用（opts.action）照旧单钮；无钮路径照旧直写 textContent", () => {
      const { fn, t } = buildToast();
      fn.toast("渠道已刷新", false, { action: { label: "查看差异", onClick: () => {} } });
      const links = t.appended.slice(1);
      assert.equal(links.length, 1, "单钮不重复");
      assert.equal(links[0].textContent, "查看差异", "兼容既有形状");
      assert.equal(t.appended[0].text, "渠道已刷新", "带钮路径文案走文本节点");
      clearTimeout(t.tid);
      const plain = buildToast();
      plain.fn.toast("渠道已刷新", false);
      assert.equal(plain.t.text, "渠道已刷新", "无钮路径照旧直写 textContent");
      assert.equal(plain.t.appended.length, 0, "无钮不建元素");
      clearTimeout(plain.t.tid);
    });

    it("驻留期满两段收场：先转 1s 淡出（is-leaving），期满落暗（源码钉死）", () => {
      const toastFn = panelJs.match(/function toast\(msg, isErr, opts\)[\s\S]*?\n  \}/)?.[0];
      assert.ok(toastFn, "toast 件在册");
      assert.ok(/classList\.add\("is-leaving"\)/.test(toastFn), "驻留期满转淡出类");
      assert.ok(/remove\("show", "is-leaving"\)/.test(toastFn), "淡出期满落暗（摘两类）");
      const dismiss = panelJs.match(/function dismissToast\(t\)[\s\S]*?\n  \}/)?.[0];
      assert.ok(dismiss && dismiss.includes('classList.add("is-gone")'), "动作点击走瞬时类");
      assert.ok(dismiss && dismiss.includes('classList.remove("show", "is-leaving")'), "瞬时收场同时清淡出态");
    });
  });

  describe("动效样式（CSS 钉死）", () => {
    it("toast：入场 -6px/160ms ease-out；驻留期满 1s 只淡出不位移；瞬时类压过渡", () => {
      const base = panelCss.match(/\.toast \{([^}]*)\}/)[1];
      assert.ok(/translateY\(-6px\)/.test(base), "入场起点 -6px");
      assert.ok(/opacity 160ms var\(--ease-out\), transform 160ms var\(--ease-out\)/.test(base), "0.16s ease-out 入场");
      const show = panelCss.match(/\.toast\.show \{([^}]*)\}/)[1];
      assert.ok(/translateY\(0\)/.test(show), "入场终点原位");
      const leaving = panelCss.match(/\.toast\.is-leaving \{([^}]*)\}/)[1];
      assert.ok(/opacity:\s*0/.test(leaving), "淡出终点");
      assert.ok(/opacity 1s var\(--ease-out\)/.test(leaving), "1s 淡出");
      assert.ok(!/transform/.test(leaving), "收场不位移（只淡出）");
      const gone = panelCss.match(/\.toast\.is-gone \{([^}]*)\}/)[1];
      assert.ok(/transition:\s*none/.test(gone), "瞬时类压掉一切过渡");
      assert.ok(panelCss.indexOf(".toast.is-leaving") > panelCss.indexOf(".toast.show {"), "淡出类后置于 show（同特异性后者胜）");
      assert.ok(panelCss.indexOf(".toast.is-gone") > panelCss.indexOf(".toast.is-leaving"), "瞬时类后置于淡出类");
    });

    it("幽灵行：absolute＋pointer-events:none（克隆不占布局不挡指针）", () => {
      const ghost = panelCss.match(/\.rail-term-ghost \{([^}]*)\}/);
      assert.ok(ghost, "幽灵类在册");
      assert.ok(/position:\s*absolute/.test(ghost[1]), "脱离布局流");
      assert.ok(/pointer-events:\s*none/.test(ghost[1]), "不挡指针");
    });

    it("reduced-motion 全关：全站压零规则在册（CSS 动效随之瞬时），WAAPI 门在 JS", () => {
      assert.ok(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*\s*\{\s*transition: none !important; animation: none !important;\s*\}\s*\}/.test(panelCss),
        "CSS 过渡/动画全站压零（toast 入场/淡出随之瞬时）");
      assert.ok(extractFn("playTerminalRailFlip").includes('matchMedia("(prefers-reduced-motion: reduce)")'),
        "FLIP 的 WAAPI 门在 JS（matchMedia）");
      assert.ok(extractFn("terminalRailMotionEnabled").includes('matchMedia("(prefers-reduced-motion: reduce)")'),
        "幽灵的 WAAPI 门同款");
    });
  });

  describe("文案纪律（冻结条款）", () => {
    it("唯一新增文案＝「筛选已归档会话」；既有文案原样", () => {
      const body = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      assert.equal((body.match(/筛选已归档会话/g) || []).length, 1, "新文案恰好一处（toast 引导钮 label）");
      for (const copy of ["会话已归档。", "撤销", "归档会话", "取消归档", "归档未能保存，请重试", "取消归档未能保存，请重试"]) {
        assert.ok(body.includes(copy), `既有文案「${copy}」原样在册`);
      }
    });
  });
});

// ── 终端页内新建会话：历史列表追赶（兜底行不常驻）──
// 病灶：历史列表只在进终端页时拉（全盘扫 2.7–9.8s，禁挂轮询），「在终端页里新建
// 会话」这条路径不刷新它——真行不回来，组顶的「新会话」兜底行就一直压着它，用户
// 看到的就是「真正的新会话被压到一个（或多个）假『新会话』之下」。
describe("终端页内新建会话：历史列表追赶", () => {
  const extract = (name) => {
    const src = panelJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
    assert.ok(src, `${name} found in panel.js`);
    return src;
  };

  // 真跑 refreshTerminalRailHistory 的取数路径。
  const refreshSandbox = ({ endpoint = "dsh", rows = [], fail = false }) => {
    const seen = [];
    const state = { endpoint: "", sessions: [], fetchedAt: 0, error: null, retryAt: 0 };
    const fn = new Function("state", "seen", "endpoint0", "rows0", "fail", `
      let terminalRailFetchInFlight = false;
      let terminalRailFlipMode = "instant";
      let terminalRailHistory = { endpoint: "", sessions: [], fetchedAt: 0, error: null };
      const TERMINAL_RAIL_HISTORY_RETRY_MS = 5000;
      function api(method, path) {
        seen.push({ method, path });
        if (fail) return Promise.reject(new Error("boom"));
        return Promise.resolve({ sessions: rows0 });
      }
      function terminalRailAgentId() { return endpoint0; }
      function renderTerminalRail() { seen.push({ render: true }); }
      function toast() {}
      ${extract("refreshTerminalRailHistory")}
      return { run: (opts) => refreshTerminalRailHistory(opts), history: () => terminalRailHistory };
    `)(state, seen, endpoint, rows, fail);
    return { fn, seen, state };
  };

  it("force 走 ?refresh=1（与会话管理页刷新钮同一条逃生口：等真扫描落地再回新值）", async () => {
    const { fn, seen } = refreshSandbox({ rows: [{ endpoint: "dsh", id: "c-1", project: "C:\\dev\\alpha" }] });
    await fn.run({ endpoint: "dsh", force: true });
    assert.deepEqual(seen.filter((s) => s.method).map((s) => s.path), ["/api/sessions/list?refresh=1"]);
    assert.equal(fn.history().sessions.length, 1, "真扫描的新值落进历史表（兜底行的接替判据读它）");
  });

  it("不 force 走裸列表（TTL 快照，请求绝不等扫描——进页那条路径的口径不变）", async () => {
    const { fn, seen } = refreshSandbox({ rows: [] });
    await fn.run({ endpoint: "dsh" });
    assert.deepEqual(seen.filter((s) => s.method).map((s) => s.path), ["/api/sessions/list"]);
  });

  // 真跑 maybeCatchUpTerminalRailHistory + terminalRailPendingNewTerminals（含
  // 它内部的「已被接替」判据）——触发条件不是猜的，是兜底行推导的同一份真值。
  const catchUpSandbox = ({ sessions, history, catchUpAt = 0, inFlight = false, ready = true, misses = 0, seen = -1 }) => {
    const calls = [];
    const fn = new Function("sessions", "history", "catchUpAt0", "inFlight", "ready", "misses0", "seen0", "calls", `
      const terminalBackendReady = ready;
      const terminalBackendSessions = sessions;
      let activeTerminalPreviewId = "t-a";
      let terminalRailFetchInFlight = inFlight;
      let terminalRailCatchUpAt = catchUpAt0;
      let terminalRailCatchUpSeen = seen0;
      let terminalRailCatchUpMisses = misses0;
      const TERMINAL_RAIL_CATCHUP_MIN_MS = 20000;
      const TERMINAL_RAIL_CATCHUP_MAX_MISSES = 5;
      const terminalRailSelectPending = null;
      const terminalRailHistory = history;
      function terminalSessionFor(id) { return terminalBackendSessions[id] || null; }
      function refreshTerminalRailHistory(opts) { calls.push(opts); return Promise.resolve(); }
      ${extract("terminalRailNormDir")}
      ${extract("terminalRailSameDir")}
      ${extract("terminalRailSessionMap")}
      ${extract("terminalRailActiveSession")}
      ${extract("terminalRailAgentId")}
      ${extract("terminalRailPendingFreshArmed")}
      ${extract("terminalRailPendingNewTerminals")}
      ${extract("maybeCatchUpTerminalRailHistory")}
      return {
        run: () => maybeCatchUpTerminalRailHistory(),
        catchUpAt: () => terminalRailCatchUpAt,
        misses: () => terminalRailCatchUpMisses,
        seen: () => terminalRailCatchUpSeen,
        pending: () => terminalRailPendingNewTerminals(),
      };
    `)(sessions, history, catchUpAt, inFlight, ready, misses, seen, calls);
    return { fn, calls };
  };

  const HIST = (rows) => ({ endpoint: "dsh", sessions: rows, fetchedAt: 1, error: null });
  const ROW = (id, lastActive) => ({ endpoint: "dsh", id, title: id, project: "C:\\dev\\alpha", lastActive, file: `F:\\${id}.jsonl` });
  const TERM = (over = {}) => ({
    id: "t-a", cwd: "C:\\dev\\alpha", agentId: "dsh", agent: { endpointId: "dsh" }, agentName: "dsh",
    resume: null, status: "idle", label: "dsh",
    backendState: { status: "running", createdAt: 1000, spawnedAt: 1000, lastActiveAt: 2500, lastInputAt: 0, ...over },
  });

  it("兜底行正为一条已键入的新会话显示 → 补一发强制对齐", () => {
    const { fn, calls } = catchUpSandbox({
      sessions: { "t-a": TERM({ lastInputAt: 2000 }) },
      history: HIST([]),
    });
    assert.equal(fn.pending().length, 1, "前提：兜底行在场（列表里没有它的真行）");
    fn.run();
    assert.deepEqual(calls, [{ endpoint: "dsh", force: true }], "按当前 agent 强制补拉（?refresh=1）");
    assert.ok(fn.catchUpAt() > 0, "记下补拉时刻（供最小间隔闸读）");
  });

  it("没键入过的新会话不补：存档还没开始写，补也是白扫一盘", () => {
    const { fn, calls } = catchUpSandbox({ sessions: { "t-a": TERM({ lastInputAt: 0 }) }, history: HIST([]) });
    assert.equal(fn.pending().length, 1, "兜底行照样在场（它确实是条新会话）");
    fn.run();
    assert.deepEqual(calls, [], "不补");
  });

  it("真行已经回来（同目录有更晚活跃的会话）就不补：没有可疑兜底行", () => {
    const { fn, calls } = catchUpSandbox({
      sessions: { "t-a": TERM({ lastInputAt: 2000 }) },
      history: HIST([ROW("c-1", 5000)]),
    });
    assert.deepEqual(fn.pending(), [], "前提：兜底行已被接替退场");
    fn.run();
    assert.deepEqual(calls, [], "不补");
  });

  it("最小间隔闸：刚补过一发，20s 内不重复扫（全盘扫 2.7–9.8s，不能连排）", () => {
    const { fn, calls } = catchUpSandbox({
      sessions: { "t-a": TERM({ lastInputAt: 2000 }) }, history: HIST([]), catchUpAt: Date.now(),
    });
    fn.run();
    assert.deepEqual(calls, [], "窗口内不重复");
  });

  it("列表已在飞 / 宿主未就绪都不补", () => {
    const flying = catchUpSandbox({ sessions: { "t-a": TERM({ lastInputAt: 2000 }) }, history: HIST([]), inFlight: true });
    flying.fn.run();
    assert.deepEqual(flying.calls, [], "在飞不排队（等那一拍落地自然重渲）");
    const cold = catchUpSandbox({ sessions: { "t-a": TERM({ lastInputAt: 2000 }) }, history: HIST([]), ready: false });
    cold.fn.run();
    assert.deepEqual(cold.calls, [], "宿主未就绪不补");
  });

  it("无进展收敛：兜底行集合连着几发不变就停手（不把全盘扫挂成轮询）", () => {
    // 5 发都没让兜底行集合变小（agent 不落存档的怪形态）→ 收敛。
    const stalled = catchUpSandbox({ sessions: { "t-a": TERM({ lastInputAt: 2000 }) }, history: HIST([]), seen: 1, misses: 4 });
    stalled.fn.run();
    assert.deepEqual(stalled.calls, [{ endpoint: "dsh", force: true }], "差一发到上限：还补最后一发");
    assert.equal(stalled.fn.misses(), 5, "记为一次无进展");
    stalled.fn.run();
    assert.deepEqual(stalled.calls, [{ endpoint: "dsh", force: true }], "到上限即停手");
    // 集合一变（真行回来／又新建会话）＝有进展，清零重来。
    const progress = catchUpSandbox({ sessions: { "t-a": TERM({ lastInputAt: 2000 }) }, history: HIST([]), seen: 2, misses: 4 });
    progress.fn.run();
    assert.deepEqual(progress.calls, [{ endpoint: "dsh", force: true }], "集合变过：照补");
    assert.equal(progress.fn.misses(), 0, "有进展即清零");
  });

  it("追赶挂在 1s 归属轮询收尾（数据路径，不是渲染路径）", () => {
    assert.ok(extract("pollTerminalSessions").includes("maybeCatchUpTerminalRailHistory()"),
      "轮询每拍问一次「有没有可疑兜底行要补」");
  });
});

// 全新内切成功后收武装：兜底行的真实身份已由宿主快照（spawnedAt / resume）接管，
// 12s 武装窗只会让它在真行已经回来的情况下多压组顶一会儿。
describe("全新内切成功即收武装", () => {
  it("POST /switch 落地后 pending 当场撤（高亮改由活跃终端接任）", async () => {
    const { fn, log } = runSwitch({
      sessions: { "t-a": { ...IDLE } }, activeId: "t-a",
      agentsImpl: async () => AGENTS_IDLE, hostReadImpl: async () => HOST_RUNNING,
      switchImpl: async () => SWITCH_FRESH_OK,
    });
    fn.goFresh({ agentId: "kimi", cwd: "C:\\dev\\alpha" });
    await flush();
    assert.equal(log.creates.length, 0, "不开新页签");
    assert.equal(fn.pending(), null, "成功即收武装（不再占 12s TTL）");
  });
});

// ── M12 视口化验收（页签＝视口）────────────────────────────────────────
// 把真函数串起来跑：宿主快照同步（rebuild → sync）＋内切判定门＋左栏聚焦＋关页签＋
// 关停清场。断言对应方案第二节验收清单 A1/A2/A3/A4/A5/A8/A9/A11。
describe("M12 视口化验收（页签＝视口）", () => {
  const AGENT_IDLE = { agents: [{ id: "kimi", instances: [] }] };
  const agentsWorking = (instanceId) => ({ agents: [{ id: "kimi", instances: [{ id: instanceId, activeRequests: 1 }] }] });
  const HISTORY = {
    endpoint: "kimi", id: "s-1", title: "重构权限矩阵", project: "C:\\dev\\alpha",
    file: "C:\\Users\\fixture\\.kimi\\sessions\\s-1.jsonl", resumeCommand: "kimi --session s-1",
  };
  const AGENT = (instanceId) => ({ endpointId: "kimi", instanceId, name: "Kimi Code", pid: 100, busy: false });
  const TERM_ITEM = (id, { instance = "inst-" + id, resume = null } = {}) => ({
    id, label: "终端 " + id, shell: "powershell", cwd: "C:\\dev\\alpha",
    agentId: "kimi", agentName: "Kimi Code", agent: AGENT(instance), resume, status: "running",
  });

  function viewportHarness({ store = {}, items = [], agents = AGENT_IDLE } = {}) {
    const log = { creates: [], switchBodies: [], closes: [], toasts: [], renders: 0, tabs: 0, empty: 0, rails: 0, streams: 0 };
    const state = { store, agents, items, created: 0 };
    const createdTerminal = (body) => {
      state.created += 1;
      const id = `t-created-${state.created}`;
      return {
        id, label: "Kimi Code", shell: "powershell", cwd: (body && body.cwd) || "C:\\dev\\alpha",
        agentId: "kimi", agentName: "Kimi Code", agent: AGENT(`inst-${id}`),
        resume: body && body.resume ? body.resume : null, status: "running",
      };
    };
    const switchSnapshot = (id, body) => ({
      id, label: "Kimi Code", shell: "powershell", cwd: (body && body.cwd) || "C:\\dev\\alpha",
      agentId: "kimi", agentName: "Kimi Code", agent: AGENT(`inst-${id}`),
      resume: body && body.resume ? body.resume : null, status: "running",
    });
    const sandbox = new Function("state", "log", `
      let terminalBackendReady = true;
      let terminalBackendSessions = {};
      let activeTerminalPreviewId = null;
      let terminalDefaultCwd = "";
      let terminalTabsRenderedHtml = "";
      let terminalSwitchInFlight = false;
      let terminalRailSelectPending = null;
      let terminalRailSelectSeq = 0;
      const TERMINAL_RAIL_SELECT_TTL_MS = 12000;
      const terminalDoneUnread = new Map();
      const terminalPrevWorking = new Map();
      const terminalTurnArmed = new Set();
      const terminalHollowStreak = new Map();
      const terminalPreviewSessions = {};
      const localStorage = {
        getItem: (k) => (k in state.store ? state.store[k] : null),
        setItem: (k, v) => { state.store[k] = String(v); },
        removeItem: (k) => { delete state.store[k]; },
      };
      ${viewportPrelude()}
      function $(id) { return null; }
      function storedTerminalSessionId() { try { return localStorage.getItem("panel-terminal-session"); } catch { return null; } }
      function rememberTerminalSessionId(id) {
        if (typeof id === "string" && id.startsWith("preview-")) id = null;
        try { if (id) localStorage.setItem("panel-terminal-session", id); else localStorage.removeItem("panel-terminal-session"); } catch {}
      }
      ${extractFn("terminalBackendSession")}
      ${extractFn("pruneTerminalHollowStreak")}
      ${extractFn("pruneTerminalDoneState")}
      ${extractFn("rebuildTerminalBackendSessions")}
      ${extractFn("clearTerminalLocalSessions")}
      function terminalSessionFor(id) { return terminalBackendSessions[id] || null; }
      function api(method, path, body) {
        log.paths = (log.paths || []).concat(method + " " + path);
        if (method === "GET" && path === "/api/agents") return Promise.resolve(state.agents);
        if (method === "POST" && path === "/api/terminal/agent-sessions") {
          log.creates.push({ body });
          return Promise.resolve(state.createdTerminal(body));
        }
        if (method === "GET" && path.startsWith("/api/terminal/sessions/")) {
          const id = decodeURIComponent(path.slice("/api/terminal/sessions/".length));
          return terminalBackendSessions[id]
            ? Promise.resolve({ id, status: terminalBackendSessions[id].backendState?.status || "running" })
            : Promise.reject(Object.assign(new Error("HTTP 404"), { code: "terminal_session_not_found" }));
        }
        if (method === "POST" && path.endsWith("/switch")) {
          const id = decodeURIComponent(path.slice("/api/terminal/sessions/".length, path.length - "/switch".length));
          log.switchBodies.push({ id, body });
          return Promise.resolve(state.switchSnapshot(id, body));
        }
        if (method === "POST" && path.endsWith("/close")) {
          const id = decodeURIComponent(path.slice("/api/terminal/sessions/".length, path.length - "/close".length));
          log.closes.push(id);
          return Promise.resolve({ ok: true });
        }
        return Promise.reject(new Error("unexpected " + method + " " + path));
      }
      // 契约级富化桩：按 agents 负载里同 instanceId 的 activeRequests 置 working（真口径
      // 见 enrichTerminalSessions 本体，这里只服务判定门的 working 输入）。
      function enrichTerminalSessions(payload) {
        const endpoints = Array.isArray(payload) ? payload : [];
        for (const session of Object.values(terminalBackendSessions)) {
          const agent = session.agent || null;
          if (!agent) continue;
          const endpoint = endpoints.find((row) => row && row.id === agent.endpointId);
          const instances = endpoint && Array.isArray(endpoint.instances) ? endpoint.instances : [];
          const instance = instances.find((row) => row && row.id === agent.instanceId);
          session.status = instance && Number(instance.activeRequests) > 0 ? "working" : "idle";
        }
      }
      function terminalCreateSize() { return { cols: 120, rows: 34 }; }
      ${extractFn("createAgentTerminal")}
      function toast(msg, isErr) { log.toasts.push({ msg, isErr }); }
      function panelError(err, fallback) { return fallback; }
      function armTerminalBootingOverlay(id) { log.booting = (log.booting || []).concat(id); }
      function renderTerminalPreviewSession() { log.renders += 1; }
      function renderTerminalPreviewTabs() { log.tabs += 1; }
      function renderTerminalEmptyState() { log.empty += 1; }
      function renderTerminalRail() { log.rails += 1; }
      function closeAllTerminalStreams() { log.streams += 1; }
      function scheduleTerminalFit() {}
      ${extractFn("terminalRailSessionMap")}
      ${extractFn("terminalRailFindOpenSession")}
      ${extractFn("terminalRailSwitchBusy")}
      ${extractFn("terminalRailBeginSelect")}
      ${extractFn("terminalRailArmSelect")}
      ${extractFn("terminalRailEndSelect")}
      ${extractFn("terminalRailSwitchOrCreateCore")}
      ${extractFn("terminalRailSwitchOrCreate")}
      ${extractFn("terminalRailActivateSession")}
      ${extractFn("terminalRailCloseSession")}
      return {
        beat: (items) => { rebuildTerminalBackendSessions(items); enrichTerminalSessions(state.agents.agents); },
        setAgents: (payload) => { state.agents = payload; },
        viewports: () => terminalViewports.map((viewport) => ({ ...viewport })),
        background: () => Array.from(terminalBackgroundIds),
        activeTerminal: () => activeTerminalPreviewId,
        activeViewport: () => terminalViewportActiveId,
        sessions: () => terminalBackendSessions,
        switchTo: (row) => terminalRailSwitchOrCreate({ session: row, resume: { endpoint: row.endpoint, id: row.id, file: row.file }, cwd: row.project }),
        fresh: (opts) => terminalRailSwitchOrCreateCore(opts),
        activate: (id) => terminalRailActivateSession(id),
        closeTab: (id) => terminalCloseViewportTab(id),
        railClose: (id) => terminalRailCloseSession(id),
        clear: () => clearTerminalLocalSessions(),
      };
    `)(state, log);
    // 沙盒内的 api 在调用时才读 state.*，这里补上外部发放的终端快照即可（new Function
    // 执行期只有函数声明，不发请求）。
    state.createdTerminal = createdTerminal;
    state.switchSnapshot = switchSnapshot;
    return { sandbox, log, state };
  }

  it("A1 终端空闲点左栏历史会话：就地换内容（同记录 /switch），页签数不变", async () => {
    const { sandbox, log } = viewportHarness({
      items: [TERM_ITEM("t-old", { resume: { endpoint: "kimi", id: "s-old" } })],
    });
    sandbox.beat([TERM_ITEM("t-old", { resume: { endpoint: "kimi", id: "s-old" } })]);
    assert.equal(sandbox.viewports().length, 1, "宿主会话 → 一个视口");
    sandbox.switchTo(HISTORY);
    await flush();
    assert.equal(log.creates.length, 0, "不新建终端（页签不增）");
    assert.deepEqual(log.switchBodies, [{
      id: "t-old", body: { resume: { endpoint: "kimi", id: "s-1", file: "C:\\Users\\fixture\\.kimi\\sessions\\s-1.jsonl" }, cwd: "C:\\dev\\alpha" },
    }], "空闲走既有 /switch：同记录 terminate+spawn，页签不变");
    assert.deepEqual(sandbox.viewports(), [{ id: "viewport-1", terminalId: "t-old" }], "视口仍只有一个、仍指向原终端记录");
    assert.deepEqual(log.booting, ["t-old"], "A6：/switch 在飞期间武装「正在加载」占位（零新增文案）");
  });

  it("A2 终端空闲点「新建会话」：就地换新会话，页签数不变", async () => {
    const { sandbox, log } = viewportHarness({ items: [TERM_ITEM("t-old")] });
    sandbox.beat([TERM_ITEM("t-old")]);
    sandbox.fresh({ agentId: "kimi", cwd: "C:\\dev\\beta" });
    await flush();
    assert.equal(log.creates.length, 0, "不新建终端");
    assert.deepEqual(log.switchBodies, [{ id: "t-old", body: { agentId: "kimi", cwd: "C:\\dev\\beta" } }],
      "空白壳/idle → /switch 同记录换新会话");
    assert.equal(sandbox.viewports().length, 1, "页签数不变");
  });

  it("A3 终端在跑点历史会话：旧进程留后台保活（不杀），目标终端换进同一视口，页签不增", async () => {
    const { sandbox, log } = viewportHarness({ items: [TERM_ITEM("t-old")] });
    sandbox.beat([TERM_ITEM("t-old")]);
    sandbox.setAgents(agentsWorking("inst-t-old"));
    sandbox.switchTo(HISTORY);
    await flush();
    assert.equal(log.creates.length, 1, "建目标终端");
    assert.deepEqual(log.switchBodies, [], "在跑：绝不走 /switch（树杀会中断任务）");
    assert.deepEqual(log.closes, [], "旧终端不被结束");
    assert.deepEqual(sandbox.background(), ["t-old"], "旧终端进后台保活集合");
    assert.ok(sandbox.sessions()["t-old"], "旧终端仍留在宿主会话表里（左栏那一行还在）");
    assert.equal(sandbox.viewports().length, 1, "页签数不变");
    assert.equal(sandbox.viewports()[0].terminalId, "t-created-1", "视口已切到目标终端");
    assert.equal(sandbox.activeTerminal(), "t-created-1", "当前显示目标终端");
  });

  it("A4 点回后台在跑的那条会话：视口切回它，进程未重启（无 create / 无 switch）", async () => {
    const { sandbox, log } = viewportHarness({ items: [TERM_ITEM("t-old")] });
    sandbox.beat([TERM_ITEM("t-old")]);
    sandbox.setAgents(agentsWorking("inst-t-old"));
    sandbox.switchTo(HISTORY);
    await flush();
    const createsAfterA3 = log.creates.length;
    const switchesAfterA3 = log.switchBodies.length;
    sandbox.activate("t-old");
    await flush();
    assert.equal(log.creates.length, createsAfterA3, "不新建终端：进程没重启");
    assert.equal(log.switchBodies.length, switchesAfterA3, "不走 /switch：宿主镜像保史，画面续上");
    assert.equal(sandbox.viewports()[0].terminalId, "t-old", "视口切回后台那条终端");
    assert.equal(sandbox.activeTerminal(), "t-old", "显示它");
    assert.deepEqual(sandbox.background(), [], "它已回到视口，退出后台保活集合");
    assert.deepEqual(log.closes, ["t-created-1"], "换下来的目标终端当时空闲 → 结束它（没在跑的杀）");
    assert.ok(sandbox.sessions()["t-old"], "旧终端仍在（未重启/未关闭）");
  });

  it("A5 A3 之后连续再操作 3 次：页签数始终不变", async () => {
    const { sandbox, log } = viewportHarness({ items: [TERM_ITEM("t-old")] });
    sandbox.beat([TERM_ITEM("t-old")]);
    sandbox.setAgents(agentsWorking("inst-t-old"));
    sandbox.switchTo(HISTORY);
    await flush();
    assert.equal(sandbox.viewports().length, 1, "A3 后页签仍 1");
    for (let index = 0; index < 3; index += 1) {
      sandbox.fresh({ agentId: "kimi", cwd: "C:\\dev\\alpha" });
      await flush();
      assert.equal(sandbox.viewports().length, 1, `第 ${index + 1} 次内切后页签数不变`);
    }
    assert.equal(log.creates.length, 1, "三次操作都就地换内容（只有 A3 那次建过目标终端）");
    assert.equal(log.switchBodies.length, 3, "空闲路径三次都走 /switch");
  });

  it("A8 关页签只结束它显示的终端；后台保活会话不动、可回到；零视口落空态", async () => {
    const { sandbox, log } = viewportHarness({ items: [TERM_ITEM("t-old")] });
    sandbox.beat([TERM_ITEM("t-old")]);
    sandbox.setAgents(agentsWorking("inst-t-old"));
    sandbox.switchTo(HISTORY);
    await flush();
    const viewportId = sandbox.viewports()[0].id;
    sandbox.closeTab(viewportId);
    assert.deepEqual(log.closes, ["t-created-1"], "只结束视口显示的终端");
    assert.equal(sandbox.viewports().length, 0, "视口销毁");
    assert.deepEqual(sandbox.background(), ["t-old"], "后台保活终端不受牵连");
    assert.ok(sandbox.sessions()["t-old"], "它还在宿主会话表（左栏能回到）");
    assert.equal(log.empty, 1, "零视口落空态（零会话遗规原样，不静默起进程）");
    sandbox.activate("t-old");
    await flush();
    assert.equal(sandbox.viewports().length, 1, "从左栏点回后台会话：重建一个视口显示它");
    assert.equal(log.closes.length, 1, "切回不结束任何人");
    assert.equal(sandbox.activeTerminal(), "t-old");
  });

  it("A9 刷新恢复：视口布局与后台保活集合按存档还原，后台不被误建成新页签", async () => {
    const store = {};
    const first = viewportHarness({ store, items: [TERM_ITEM("t-old")] });
    first.sandbox.beat([TERM_ITEM("t-old")]);
    first.sandbox.setAgents(agentsWorking("inst-t-old"));
    await first.sandbox.switchTo(HISTORY);
    assert.equal(first.sandbox.viewports().length, 1);
    assert.deepEqual(first.sandbox.background(), ["t-old"], "前提：旧终端在后台保活");
    const restoredLayout = first.sandbox.viewports();

    // 刷新：同一份 localStorage 起新沙盒，宿主里两条会话都还活着。
    const second = viewportHarness({ store, items: [TERM_ITEM("t-old"), TERM_ITEM("t-created-1")] });
    second.sandbox.beat([TERM_ITEM("t-old"), TERM_ITEM("t-created-1")]);
    assert.deepEqual(second.sandbox.viewports(), restoredLayout, "视口布局（含 id 与各自终端）原样恢复");
    assert.deepEqual(second.sandbox.background(), ["t-old"], "后台保活集合恢复后不被自动补成页签");
    assert.equal(second.sandbox.activeTerminal(), "t-created-1", "刷新后回到刷新前显示的那个终端");
  });

  it("A11 关停终端服务：视口表、后台集合、本地会话表与存档一并清空", async () => {
    const store = {};
    const { sandbox, log } = viewportHarness({ store, items: [TERM_ITEM("t-old")] });
    sandbox.beat([TERM_ITEM("t-old")]);
    sandbox.setAgents(agentsWorking("inst-t-old"));
    await sandbox.switchTo(HISTORY);
    assert.equal(sandbox.viewports().length, 1);
    assert.deepEqual(sandbox.background(), ["t-old"]);
    sandbox.clear();
    assert.equal(sandbox.viewports().length, 0, "视口表清空");
    assert.deepEqual(sandbox.background(), [], "后台保活集合清空");
    assert.deepEqual(Object.keys(sandbox.sessions()), [], "本地会话表清空");
    assert.equal(sandbox.activeTerminal(), null, "活跃指针清空");
    assert.ok(!("panel-terminal-session" in store), "旧单 id 存档摘掉");
    const saved = JSON.parse(store["panel-terminal-viewports"]);
    assert.deepEqual(saved, { active: null, viewports: [], background: [] }, "视口存档改写为空布局");
    assert.equal(log.streams, 1, "终端流一并收掉");
  });
});

// ── M12-A4 补验：宿主绑定库身份（boundConversation）──────────────────────
// A4 缺口：后台保活的那条终端若是「全新会话」终端，它在宿主记录里没有 resume（它不是
// 续接起的），真实对话身份只在宿主绑定库里（panel.mjs 随列表下发 boundConversation）。
// 前端不认这个身份时：左栏真行不亮 live（点它按 resume 再起一条同对话进程，同一个对话
// 被两个进程同时写），而且这条终端还会再冒一条假「新会话」兜底行压在真行之上。这一组
// 把三处消费者（字段透传 / 打开中终端查找 / 兜底行推导）按真函数串起来跑。
describe("M12-A4 绑定库身份（boundConversation）", () => {
  // 字段级沙盒：terminalBackendSession 只碰 terminalDefaultCwd 这一个模块级量。
  const backendSessionSandbox = () => new Function(`
    let terminalDefaultCwd = "";
    ${extractFn("terminalBackendSession")}
    return (item) => terminalBackendSession(item);
  `)();

  // 打开中终端的查找沙盒：terminalRailSessionMap 只读「后端就绪位＋会话表」。
  const findSandbox = (sessions) => new Function("sessions", `
    let terminalBackendReady = true;
    const terminalBackendSessions = sessions;
    ${extractFn("terminalRailSessionMap")}
    ${extractFn("terminalRailFindOpenSession")}
    return terminalRailFindOpenSession;
  `)(sessions);

  // 兜底行推导沙盒：terminalRailPendingNewTerminals 的真依赖面（历史表＋武装判定＋
  // 会话表），桩的写法照本文件「兜底行」组的 catchUpSandbox 同一套。
  const pendingSandbox = ({ sessions, rows, selectPending = null }) => new Function("sessions", "rows", "selectPending", `
    let terminalBackendReady = true;
    const terminalBackendSessions = sessions;
    let activeTerminalPreviewId = "t-bg";
    const terminalRailSelectPending = selectPending;
    const terminalRailHistory = { endpoint: "dsh", sessions: rows, fetchedAt: 1, error: null };
    ${extractFn("terminalRailNormDir")}
    ${extractFn("terminalRailSameDir")}
    ${extractFn("terminalRailSessionMap")}
    ${extractFn("terminalRailActiveSession")}
    ${extractFn("terminalRailAgentId")}
    ${extractFn("terminalRailPendingFreshArmed")}
    ${extractFn("terminalRailPendingNewTerminals")}
    return () => terminalRailPendingNewTerminals();
  `)(sessions, rows, selectPending);

  // 后台保活的那条「全新会话」终端：无 resume，身份只在绑定库里（宿主绑定库下发）。
  const BG_TERM = (over = {}) => ({
    id: "t-bg", cwd: "C:\\dev\\alpha", agentId: "dsh", agent: { endpointId: "dsh" }, agentName: "dsh",
    resume: null, boundConversation: { endpoint: "dsh", id: "c-1" }, status: "idle", label: "dsh",
    backendState: { status: "running", createdAt: 1000, spawnedAt: 1000, lastActiveAt: 2500, lastInputAt: 0 },
  });
  // 历史列表里的真行：lastActive 早于进程出生（兜底行推导里的「已被接替」时间判据
  // 本来就不成立），这样第 4 条测的确实只有新增的绑定库判据。
  const railRow = (over = {}) => ({
    endpoint: "dsh", id: "c-1", title: "c-1", project: "C:\\dev\\alpha",
    lastActive: 500, file: "F:\\c-1.jsonl", ...over,
  });

  it("1 terminalBackendSession：合法 boundConversation 只留两键透传，非法/缺失一律 null", () => {
    const map = backendSessionSandbox();
    const item = (over = {}) => ({
      id: "t-bg", label: "终端 t-bg", shell: "powershell", cwd: "C:\\dev\\alpha",
      pid: 100, status: "running", ...over,
    });
    const live = map(item({ boundConversation: { endpoint: "dsh", id: "c-1", extra: "x" } }));
    assert.deepEqual(live.boundConversation, { endpoint: "dsh", id: "c-1" },
      "绑定库身份原样透传（只留 endpoint/id 两键，别的字段不漏给前端）");
    assert.equal(live.resume, null, "前提：全新会话终端在宿主记录里没有 resume");
    assert.deepEqual(
      map(item({ boundConversation: { endpoint: "dsh", id: "c-1" }, resume: { endpoint: "dsh", id: "c-9" } })).boundConversation,
      { endpoint: "dsh", id: "c-1" }, "两个身份各走各的字段，不互相顶替",
    );
    for (const [name, value] of [
      ["缺 id", { endpoint: "dsh" }],
      ["缺 endpoint", { id: "c-1" }],
      ["endpoint 非字符串", { endpoint: 1, id: "c-1" }],
      ["id 非字符串", { endpoint: "dsh", id: 2 }],
      ["整块是字符串", "dsh:c-1"],
      ["整块是数组", []],
      ["整块缺失", undefined],
    ]) {
      assert.equal(map(item({ boundConversation: value })).boundConversation, null, `${name} → null`);
    }
  });

  it("2 terminalRailFindOpenSession：只带 boundConversation 的后台终端也命中（A4 主场景）", () => {
    const find = findSandbox({
      "t-bg": { id: "t-bg", resume: null, boundConversation: { endpoint: "dsh", id: "c-1" } },
      "t-other": { id: "t-other", resume: null, boundConversation: { endpoint: "kimi", id: "c-1" } },
    });
    assert.equal(find("dsh", "c-1").id, "t-bg", "全新会话终端：真身份只在绑定库里，也要算「已经开着」");
    assert.equal(find("kimi", "c-1").id, "t-other", "同会话 id 在不同端点是不同对话，各命中各的");
    assert.equal(find("dsh", "c-2"), null, "没有这条对话的终端");
    assert.equal(find("", "c-1"), null, "缺 endpoint 不命中（单键会误聚焦）");
  });

  it("3 terminalRailFindOpenSession：只带 resume 的终端照旧命中（防回归）", () => {
    const find = findSandbox({
      "t-old": { id: "t-old", resume: { endpoint: "dsh", id: "c-1" }, boundConversation: null },
    });
    assert.equal(find("dsh", "c-1").id, "t-old", "续接创建的终端仍在去重/聚焦范围内");
    assert.equal(find("kimi", "c-1"), null, "端点不同不误命中");
    assert.equal(find("dsh", "c-9"), null, "会话 id 不同不命中");
  });

  it("4 terminalRailPendingNewTerminals：绑定库身份已在历史列表里就不出兜底行（否则同一终端两行）", () => {
    const pending = pendingSandbox({ sessions: { "t-bg": BG_TERM() }, rows: [railRow()] });
    assert.deepEqual(pending(), [],
      "真行由 live 身份接任：再出一条兜底行就是把同一终端出成两行（假「新会话」压在真行上）");
    // 同一条终端、把那行会话从列表里拿掉 → 兜底行照旧出（会话文件还没生成的常态）。
    const unlisted = pendingSandbox({ sessions: { "t-bg": BG_TERM() }, rows: [] });
    assert.deepEqual(unlisted().map((entry) => entry.id), ["t-bg"], "列表里没有这条会话 → 兜底行照旧出");
    // 精确匹配：不同端点上的同名会话 id 不算「已在列表里」（不用目录/时间近似）。
    const otherEndpoint = pendingSandbox({ sessions: { "t-bg": BG_TERM() }, rows: [railRow({ endpoint: "kimi" })] });
    assert.equal(otherEndpoint().length, 1, "端点维度不串：同 id 不同端点是不同对话");
    // 武装窗（全新内切在飞）语义原样：绑定库还指着换下来的旧会话，此时扣行就是半秒空窗。
    const armed = pendingSandbox({
      sessions: { "t-bg": BG_TERM() }, rows: [railRow()],
      selectPending: { terminalId: "t-bg", cwd: "C:\\dev\\alpha" },
    });
    assert.equal(armed().length, 1, "武装窗豁免保留：正在内切成新会话，兜底行必须当拍出现");
  });
});

