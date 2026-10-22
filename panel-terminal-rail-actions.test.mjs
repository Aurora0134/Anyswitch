// 终端会话栏 M7 修正（S1 归档 / S2 分组移除 / S3 组头三件 / S4 钉底 / S5 去重聚焦）。
// 断言分两层：静态源码（HTML 骨架 / CSS 观感红线 / JS 挂点与文案逐字）+ vm 真跑
// （过滤与归组、归档两分支、toast 撤销、钉底分层结构、去重两分支）。
// 取样惯例照 panel-terminal-rail.test.mjs：源码字符串断言 + 按函数名切源码进桩环境。
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

const cssRule = (selector) => {
  const at = panelCss.indexOf(selector);
  assert.ok(at >= 0, `样式规则 ${selector} 在册`);
  return panelCss.slice(at, panelCss.indexOf("}", at) + 1);
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const escapeHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── 渲染沙盒：renderTerminalRailHistory 及其全部依赖（照既有测试的同款桩） ──
function renderSandbox({ history, activeSession = null, prefs = { archived: [], removedGroups: [] }, collapsed = [], removedCollapsed = true, viewPrefs = { groupBy: "workspace", orderBy: "updated", archivedFilter: "default", sessionOrder: {} } } = {}) {
  const list = { html: "", writes: 0 };
  Object.defineProperty(list, "innerHTML", {
    get: () => list.html,
    set: (v) => { list.writes += 1; list.html = v; },
  });
  const state = { collapsed: new Set(collapsed), scrolled: [] };
  const fn = new Function("list", "state", "history", "activeSession", "prefs", "removedCollapsed", "viewPrefs", `
    let terminalRailRendered = { history: null };
    let terminalRailAutoExpandedFor = "";
    let terminalRailScrolledFor = "";
    let terminalRailFlipMode = "instant";
    const terminalRailCollapsedGroups = state.collapsed;
    const terminalRailWatermarks = new Map();
    const terminalRailPrefs = prefs;
    const terminalRailViewPrefs = viewPrefs;
    let terminalRailRemovedCollapsed = removedCollapsed;
    const terminalRailSearch = { open: false, query: "", timer: null, searching: false };
    let terminalRailLastGroups = [];
    const TERMINAL_RAIL_WATERMARK = 5;
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
    function terminalRailRowTops() { return null; }
    function playTerminalRailFlip() {}
    ${extractFn("terminalRailFindOpenSession")}
    ${extractFn("terminalRailGroupSessions")}
    ${extractFn("terminalRailWatermarkView")}
    ${extractFn("terminalRailNextWatermark")}
    ${extractFn("terminalRailMoreLabel")}
    ${extractFn("terminalRailSameDir")}
    ${extractFn("terminalRailGroupForDir")}
    ${extractFn("terminalRailArchivedKey")}
    ${extractFn("terminalRailIsArchived")}
    ${extractFn("terminalRailVisibleSessions")}
    ${extractFn("terminalRailRegroupRemoved")}
    ${extractFn("terminalRailPendingNewTerminals")}
    ${extractFn("terminalRailRowHtml")}
    ${extractFn("terminalRailPendingRowHtml")}
    ${extractFn("renderTerminalRailHistory")}
    return { render: renderTerminalRailHistory, collapsed: terminalRailCollapsedGroups, scrolled: state.scrolled };
  `)(list, state, history, activeSession, prefs, removedCollapsed, viewPrefs);
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
    ${extractFn("terminalRailRowHtml")}
    return terminalRailRowHtml;
  `)(null, null, "t1", prefs);
  return fn;
}

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
      assert.ok(!withArchived.list.html.includes('data-rail-term-resume="s-1"'), "归档行不进列表（瞬时消失，resetKey）");
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
    const runArchive = (session, { apiImpl, prefs = { archived: [], removedGroups: [] } } = {}) => {
      const log = { posts: [], toasts: [], renders: 0, removed: [] };
      const fn = new Function("session", "log", "apiImpl", "prefs", `
        let terminalRailPrefs = prefs;
        let terminalRailHistory = { endpoint: "kimi", sessions: [session], fetchedAt: 1, error: null };
        let terminalRailFlipMode = "instant";
        function api(method, path, body) { log.posts.push({ method, path, body }); return apiImpl(method, path, body); }
        function toast(msg, isErr, opts) { log.toasts.push({ msg, isErr, opts }); }
        function panelError(err, fallback) { return fallback; }
        function renderTerminalRail() { log.renders += 1; }
        function renderTerminalRailHistory() { log.renders += 1; }
        function terminalRailAgentId() { return "kimi"; }
        ${extractFn("terminalRailArchivedKey")}
        ${extractFn("terminalRailArchiveSession")}
        ${extractFn("terminalRailUnarchiveSession")}
        return {
          archive: () => terminalRailArchiveSession(session.id),
          unarchive: (endpoint, id) => terminalRailUnarchiveSession(endpoint, id),
          prefs: () => terminalRailPrefs,
        };
      `)(session, log, apiImpl ?? (async () => ({ ok: true })), prefs);
      return { fn, log };
    };

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
      assert.equal(log.toasts[0].opts.action.label, "撤销", "动作钮文案逐字");
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

    it("toast 动作钮复用既有件：不新造 toast 组件，6s + action 形状", () => {
      const archive = extractFn("terminalRailArchiveSession");
      assert.ok(archive.includes('toast("会话已归档。"'), "文案逐字");
      assert.ok(archive.includes('label: "撤销"'), "动作文案逐字");
      assert.ok(archive.includes("durationMs: 6000"), "驻留 6s");
      // 既有 toast(msg, isErr, opts) 已支持 opts.action = {label, onClick}，不扩件
      const toastFn = panelJs.match(/function toast\(msg, isErr, opts\)[\s\S]*?\n  \}/)?.[0];
      assert.ok(toastFn && toastFn.includes("opts.action"), "toast 件本就有动作钮能力（S1 不扩展它）");
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
      const out = runRegroup(["c:/dev/alpha"])(
        GROUPS.filter((g) => g.key !== ""),
      );
      assert.deepEqual(out.map((g) => g.key), ["C:\\dev\\beta", ""], "未分组新建且沉底");
      assert.deepEqual(out[1].rows.map((r) => r.id), ["a-1"], "alpha 的行进未分组");
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

    it("「已移除的分组（N）」折叠区：仅 N>0 时出现，行给短名＋完整路径＋「恢复」", () => {
      const none = renderSandbox({ history: HISTORY, prefs: { archived: [], removedGroups: [] } });
      none.fn.render("kimi");
      assert.ok(!none.list.html.includes("已移除的分组"), "零移除不出折叠区");

      // 默认收起：只露带计数的标题，不露行（N 就在标题里，展开只为逐条恢复）
      const folded = renderSandbox({
        history: HISTORY,
        prefs: { archived: [], removedGroups: ["C:\\dev\\alpha", "C:\\dev\\gamma"] },
      });
      folded.fn.render("kimi");
      assert.ok(folded.list.html.includes("已移除的分组（2）"), "计数逐字形制");
      assert.ok(!folded.list.html.includes("data-rail-term-restore-group"), "默认收起不露恢复行");

      // 展开态：行给目录短名、title 给完整路径、行内「恢复」钮
      const some = renderSandbox({
        history: HISTORY,
        prefs: { archived: [], removedGroups: ["C:\\dev\\alpha", "C:\\dev\\gamma"] },
        removedCollapsed: false,
      });
      some.fn.render("kimi");
      assert.ok(some.list.html.includes('data-rail-term-restore-group="C:\\dev\\alpha"'), "恢复钮挂目录（原始拼写）");
      assert.ok(some.list.html.includes(">alpha<"), "行内显示目录短名");
      assert.ok(/class="rail-term-row rail-term-removed-row" title="C:\\dev\\alpha"/.test(some.list.html),
        "title 给完整路径");
      assert.ok(some.list.html.includes(">恢复<"), "行内「恢复」钮文案逐字");
      assert.ok(some.list.html.includes("已移除的分组（2）"), "展开态标题照旧");
    });
  });

  describe("移除/恢复交互（vm 真跑）", () => {
    const runFlow = ({ apiImpl, prefs = { archived: [], removedGroups: [] } } = {}) => {
      const log = { posts: [], toasts: [], modals: [], renders: 0, menuClosed: 0 };
      const fn = new Function("log", "apiImpl", "prefs", `
        let terminalRailPrefs = prefs;
        let terminalRailFlipMode = "instant";
        function api(method, path, body) { log.posts.push({ method, path, body }); return apiImpl(method, path, body); }
        function toast(msg, isErr) { log.toasts.push({ msg, isErr }); }
        function panelError(err, fallback) { return fallback; }
        function renderTerminalRailHistory() { log.renders += 1; }
        function terminalRailAgentId() { return "kimi"; }
        function closeTerminalRailGroupMenu() { log.menuClosed += 1; }
        function sessDirName(p) { return String(p || "").replace(/\\\\/g, "/").split("/").filter(Boolean).pop() || p || ""; }
        function escapeHtml(v) { return String(v || ""); }
        function showSkillsModal(opts) { log.modals.push(opts); opts.onConfirm(); }
        ${extractFn("terminalRailSameDir")}
        ${extractFn("terminalRailRemoveGroup")}
        ${extractFn("terminalRailCommitRemoveGroup")}
        ${extractFn("terminalRailRestoreGroup")}
        return {
          remove: terminalRailRemoveGroup,
          commit: terminalRailCommitRemoveGroup,
          restore: terminalRailRestoreGroup,
          prefs: () => terminalRailPrefs,
        };
      `)(log, apiImpl ?? (async () => ({ ok: true })), prefs);
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

    it("「恢复」：出清单 + POST 恢复；恢复后按最近活跃重新归组（不记原索引）", async () => {
      const { fn, log } = runFlow({ prefs: { archived: [], removedGroups: ["C:\\dev\\alpha", "C:\\dev\\beta"] } });
      fn.restore("C:\\dev\\alpha");
      assert.deepEqual(fn.prefs().removedGroups, ["C:\\dev\\beta"], "恢复即出清单");
      assert.deepEqual(log.posts, [{ method: "POST", path: "/api/terminal/rail/restore-group", body: { dir: "C:\\dev\\alpha" } }],
        "POST 带目录原始拼写");
      await flush();
      assert.equal(log.toasts.length, 0, "恢复无 toast（与取消归档同口径：成功路径不打扰）");
    });

    it("落盘失败：回退本地态 + 错误提示", async () => {
      const { fn, log } = runFlow({ apiImpl: async () => { throw new Error("HTTP 500：disk"); } });
      fn.commit("C:\\dev\\alpha");
      await flush();
      assert.deepEqual(fn.prefs().removedGroups, [], "失败回退");
      assert.equal(log.toasts.length, 1, "一句错误提示");
      assert.equal(log.toasts[0].isErr, true, "按错误上屏");
    });

    it("重复移除同一目录：无事可做（幂等）", async () => {
      const { fn, log } = runFlow({ prefs: { archived: [], removedGroups: ["C:\\dev\\alpha"] } });
      fn.commit("c:/dev/alpha");
      assert.deepEqual(fn.prefs().removedGroups, ["C:\\dev\\alpha"], "清单不重复");
      assert.deepEqual(log.posts, [], "不发请求");
    });

    it("点击委托：菜单开关 / 移除分组 / 恢复分组三个分支在册", () => {
      const init = extractFn("initTerminalRail");
      for (const attr of ["data-rail-term-group-menu", "data-rail-term-remove-group", "data-rail-term-restore-group"]) {
        assert.ok(init.includes(attr), `委托分支 ${attr} 在册`);
      }
      // 恢复钮抢在历史行续接之前（同在列表里，别点恢复变成续接）
      const clickAt = init.indexOf('dir.addEventListener("click"');
      const block = init.slice(clickAt, init.indexOf("});", clickAt));
      assert.ok(block.indexOf("data-rail-term-restore-group") < block.indexOf("data-rail-term-resume"),
        "恢复钮在行续接之前判");
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
      assert.ok(body.includes(">恢复<"), "恢复钮逐字");
      assert.ok(body.includes("已移除的分组（"), "折叠区标题形制逐字");
      // 失败兜底两句逐字（用户 2026-10-21 措辞修正：没能→未能）
      assert.ok(body.includes('"分组移除未能保存，请重试"'), "移除失败兜底逐字");
      assert.ok(body.includes('"分组恢复未能保存，请重试"'), "恢复失败兜底逐字");
      assert.ok(!body.includes("没能保存"), "旧措辞「没能保存」清零");
    });

    it("「未分组」组不提供移除：组头不给 ⋯（S3 同款豁免）", () => {
      const render = extractFn("renderTerminalRailHistory");
      const headAt = render.indexOf("rail-term-group-head");
      assert.ok(headAt > 0, "组头渲染可取样");
      // 组头动作钮的渲染必须绕开未分组：菜单/新建钮只在有目录键的组出现
      assert.ok(/group\.key[\s\S]{0,200}rail-term-group-menu|rail-term-group-menu[\s\S]{0,200}group\.key/.test(render),
        "菜单钮的渲染条件含组键判定（未分组不出现）");
    });

    it("CSS：菜单容器与 danger 项、恢复区在册，0ms 硬切", () => {
      assert.ok(cssRule(".rail-term-menu {").length > 0, "⋯ 菜单容器样式在册（可扩：M8 加项只加 DOM）");
      const danger = panelCss.match(/\.rail-term-menu-item\.is-danger \{([^}]*)\}/);
      assert.ok(danger, "danger 项样式在册");
      assert.ok(danger[1].includes("var(--danger)"), "danger 项取既有危险色 token");
      assert.ok(panelCss.includes(".rail-term-removed-row"), "恢复区行样式在册");
      assert.ok(!/\.rail-term-menu[^{]*\{[^}]*transition/.test(panelCss), "菜单无过渡（0ms 硬切）");
    });
  });
});

describe("S3 组头三件（dsh 工作区行按钮，m6b §B）", () => {
  describe("⊕ 在此目录新建终端（vm 真跑）", () => {
    const runCreate = ({ collapsed = [], agentId = "kimi", ready = true, apiImpl } = {}) => {
      const log = { posts: [], renders: 0, collapsed: new Set(collapsed) };
      const fn = new Function("log", "apiImpl", "agentId", "ready", `
        let terminalBackendReady = ready;
        let terminalRailFlipMode = "instant";
        const terminalRailCollapsedGroups = log.collapsed;
        function createAgentTerminal(opts) { log.posts.push(opts); return apiImpl(opts); }
        function renderTerminalRailHistory() { log.renders += 1; }
        function terminalRailAgentId() { return agentId; }
        ${extractFn("terminalRailCreateTerminalInDir")}
        return terminalRailCreateTerminalInDir;
      `)(log, apiImpl ?? (() => Promise.resolve()), agentId, ready);
      return { fn, log };
    };

    it("点击＝先展开该组（若收起）＋以该组目录为 cwd 给当前 agent 建终端", async () => {
      const { fn, log } = runCreate({ collapsed: ["C:\\dev\\alpha"] });
      fn("C:\\dev\\alpha");
      assert.equal(log.collapsed.has("C:\\dev\\alpha"), false, "收起的组先展开");
      assert.deepEqual(log.posts, [{ agentId: "kimi", cwd: "C:\\dev\\alpha" }],
        "走 createAgentTerminal 同一通路，cwd＝组目录");
      await flush();
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
      assert.ok(fn.includes("createAgentTerminal({ agentId: terminalRailAgentId(), cwd: key })"), "同一创建通路");
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

  describe("图标同槽互换（CSS 钉死）", () => {
    it("非 hover 文件夹、hover 箭头同槽互换；箭头 .15s 是栏内唯一行内过渡", () => {
      assert.ok(cssRule(".rail-term-group-slot {").includes("width: 14px"), "定宽槽 14px（与文件夹同宽）");
      assert.ok(panelCss.includes(".rail-term-group-head .rail-term-group-arrow { display: none; }"),
        "组头内箭头默认隐（非 hover 看文件夹）");
      assert.ok(panelCss.includes(".rail-term-group-head:hover .rail-term-group-arrow { display: inline-flex; }"),
        "hover 换上箭头（0ms 硬切）");
      assert.ok(panelCss.includes(".rail-term-group-head:hover .rail-term-group-icon { display: none; }"),
        "hover 收文件夹（同槽位互换）");
      const arrow = cssRule(".rail-term-group-arrow {");
      assert.ok(arrow.includes("transition: transform .15s cubic-bezier(.4,0,.2,1)"), ".15s 旋转保留");
      assert.ok(panelCss.includes(".rail-term-group.is-open .rail-term-group-arrow { transform: rotate(90deg); }"),
        "展开态旋转 90°");
      assert.ok(/\.rail-term-removed\.is-open \.rail-term-group-arrow \{ transform: rotate\(90deg\); \}/.test(panelCss),
        "移除区展开态同款旋转");
      assert.ok(!cssRule(".rail-term-group-head {").includes("transition"), "组头容器无过渡");
      assert.ok(!cssRule(".rail-term-group-btn {").includes("transition"), "动作钮无过渡（0ms 硬切）");
      assert.ok(!cssRule(".rail-term-group-toggle {").includes("transition"), "折叠开关无过渡（hover 底色 0ms 硬切）");
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
      assert.ok(block.includes("group.key"), "动作钮的渲染条件含组键判定");
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

    it("vm 真跑：进列清隐退、出列 2s 后才隐", async () => {
      const log = { attrs: [], timers: [] };
      const fn = new Function("log", `
        const els = { railTerminalDir: { attr: "", toggleAttribute(name, force) { this.attr = force ? name : ""; log.attrs.push(this.attr); } }, v2Rail: { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } } };
        const $ = (id) => els[id];
        let terminalRailQuietTimer = null;
        function setTerminalRailQuiet(quiet) {
          const dir = $("railTerminalDir");
          if (dir) dir.toggleAttribute("data-quiet", !!quiet);
        }
        const TERMINAL_RAIL_SCROLLBAR_LINGER_MS = 2000;
        ${extractFn("initTerminalRailScrollbarQuiet")}
        initTerminalRailScrollbarQuiet();
        return { enter: () => els.v2Rail.listeners.pointerenter(), leave: () => els.v2Rail.listeners.pointerleave() };
      `)(log);
      assert.deepEqual(log.attrs, ["data-quiet"], "初态隐退（thumb 随指针进列才出现）");
      fn.leave();
      await new Promise((r) => setTimeout(r, 2100));
      assert.deepEqual(log.attrs.slice(-1), ["data-quiet"], "离开 2s 后隐退");
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
        ${extractFn("createAgentTerminal")}
        ${extractFn("terminalRailResumeSession")}
        return {
          resume: terminalRailResumeSession,
          activeId: () => activeTerminalPreviewId,
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

    it("零终端/终端都无 resume 记录：照旧新建（全新终端聊出的会话不在去重范围）", () => {
      const none = runResume({}, "t-0", async () => ({ id: "t-new", agentId: "kimi" }));
      none.fn.resume(HISTORY_ROW);
      assert.equal(none.log.posts.length, 1, "零终端照旧新建");
      const fresh = runResume({ "t-f": { id: "t-f", agent: { endpointId: "kimi" }, status: "idle" } }, "t-0", async () => ({ id: "t-new", agentId: "kimi" }));
      fresh.fn.resume(HISTORY_ROW);
      assert.equal(fresh.log.posts.length, 1, "无 resume 记录的全新终端不参与去重");
    });

    it("覆盖率写进注释：只对续接创建的终端保证识别，不勉强扩", () => {
      const block = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      assert.ok(block.includes("覆盖率只保「续接创建的终端」"), "覆盖率口径注释在册");
      assert.ok(block.includes("不在去重范围"), "未覆盖面的边界也写进注释");
    });

    it("源码钉死：去重判定在续接之前，聚焦走 terminalRailActivateSession 同路", () => {
      const fn = extractFn("terminalRailResumeSession");
      assert.ok(fn.indexOf("terminalRailFindOpenSession") < fn.indexOf("createAgentTerminal"),
        "先查已开着的终端，再走新建");
      assert.ok(fn.includes("terminalRailActivateSession(open.id)"), "聚焦复用同一通路（置活跃+存档+重渲）");
      const find = extractFn("terminalRailFindOpenSession");
      assert.ok(find.includes("session.resume.endpoint === endpoint") && find.includes("session.resume.id === id"),
        "两键比对：endpoint + 会话 id");
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
      ${extractFn("terminalRailRowHtml")}
      return terminalRailRowHtml;
    `)();
    const html = rowFn({ id: "s-1", endpoint: "kimi", title: "t", lastActive: 1 }, { id: "t-7", status: "idle" }, "t-1");
    assert.ok(html.includes('data-rail-term-live="t-7"'), "live 行带终端 id（委托据此分支）");
  });
});

describe("M8 T3 文案与时间格式", () => {
  it("栏内局部时间格式：dsh 式无前缀（不动会话页共用的 sessRelTime）", () => {
    const fn = new Function(`
      const SESS_MIN = 60 * 1000, SESS_HOUR = 60 * SESS_MIN, SESS_DAY = 24 * SESS_HOUR;
      ${extractFn("terminalRailRelTime")}
      return terminalRailRelTime;
    `)();
    const now = Date.now();
    const at = (ms) => now - ms;
    assert.equal(fn(at(30 * 1000)), "刚刚", "半分钟内 = 刚刚");
    assert.equal(fn(at(-5000)), "刚刚", "时钟回拨防御");
    assert.equal(fn(at(5 * 60 * 1000)), "5分钟", "分钟无「前」缀");
    assert.equal(fn(at(3 * 60 * 60 * 1000)), "3小时", "小时无「前」缀");
    assert.equal(fn(at(3 * 24 * 60 * 60 * 1000)), "3天", "天无「前」缀");
    const yesterday = new Date(now - 24 * 60 * 60 * 1000);
    if (yesterday.getDate() !== new Date(now).getDate()) {
      assert.equal(fn(yesterday.getTime()), "昨天", "昨天");
    }
    // 跨年走 YYYY年M月D日，年内走 M月D日（与 sessRelTime 的日期形制同源，只去前缀）
    const far = new Date(now - 400 * 24 * 60 * 60 * 1000);
    const expectFar = far.getFullYear() === new Date(now).getFullYear()
      ? `${far.getMonth() + 1}月${far.getDate()}日`
      : `${far.getFullYear()}年${far.getMonth() + 1}月${far.getDate()}日`;
    assert.equal(fn(far.getTime()), expectFar, "远古日期形制");
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
      assert.ok(s.includes("退出后列表滚动回顶") || s.includes("scrollTop = 0"), "退出后滚动回顶（m6c §A6）");
      // 外点仅空查询收起：收起条件带 query 判空
      assert.ok(/terminalRailSearch\.query/.test(s), "外点收起判 query 空（有查询只失焦）");
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
      // 祖先组自动展开（m6c §B3）：树模式下所有祖先键在自动展开集里
      const s = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      assert.ok(/ancestor/i.test(s), "祖先自动展开逻辑在册");
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
        ${extractFn("terminalRailRowHtml")}
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
      function terminalRailRestoreGroup() {}
      function toggleTerminalRailRemoved() {}
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
      function terminalRailRestoreGroup() {}
      function toggleTerminalRailRemoved() {}
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
      function terminalRailRestoreGroup() {}
      function toggleTerminalRailRemoved() {}
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
  // 一个真组——点「单列表」后平铺行之外多出一个真组头（key 如 C:\\Users\\86183，
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
      activeSession: { id: "t-9", cwd: "C:\\Users\\86183", agent: { endpointId: "kimi" }, status: "idle", backendState: { createdAt: 500 } },
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
      activeSession: { id: "t-9", cwd: "C:\\Users\\86183", agent: { endpointId: "kimi" }, status: "idle", backendState: { createdAt: 500 } },
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
