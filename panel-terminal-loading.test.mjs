// 终端切签 / 后台切回 / 进页 的客户端行为钉（M4）。
//
// 三条要钉的东西：
//   1) 切换链里「销毁旧实例」不再排在新画面就绪之前——旧画面留屏当垫片，
//      新实例全新构造（旧字节没有通路打进新 PTY）。
//   2) 进终端页不触发一次强制的历史全量拉取：TTL 内复用快照，过期才补拉，
//      且补拉排在首帧之后。
//   3) 「刷新会话列表」按钮带上 ?refresh=1（服务端 TTL 快照的逃生口）。
//
// 取样惯例照 panel-terminal-dprfit / panel-terminal-rail：源码字符串断言 + 按函数名
// 切源码进桩环境真跑（extractFn / new Function）。不打墙钟、不锚耗时——只锚调用序列、
// 请求参数与 DOM 存在性。本文件自带桩与工具，不 import panel.test.mjs 的内部符号。
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const panelJs = readFileSync(join(here, "panel-ui", "panel.js"), "utf8");
const panelCss = readFileSync(join(here, "panel-ui", "panel.css"), "utf8");

// 函数体不得出现提前闭合的「\n  }」，否则切出来的源码是半截——照既有取样惯例。
function extractFn(name) {
  const src = panelJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
  assert.ok(src, `${name} found in panel.js`);
  return src;
}

// 手动推进的 rAF/定时器队列：切源码后的代码只认注入的这两个入口，测试自己决定
// 「下一帧」和「下一个任务」什么时候到——不靠 sleep。
function makeClock() {
  let seq = 0;
  const frames = [];
  const timers = [];
  return {
    requestAnimationFrame(fn) { const id = ++seq; frames.push({ id, fn }); return id; },
    cancelAnimationFrame(id) {
      const at = frames.findIndex((f) => f.id === id);
      if (at >= 0) frames.splice(at, 1);
    },
    setTimeout(fn, ms = 0) { const id = ++seq; timers.push({ id, fn, ms }); return id; },
    clearTimeout(id) {
      const at = timers.findIndex((t) => t.id === id);
      if (at >= 0) timers.splice(at, 1);
    },
    // 冲一帧：回调按登记序执行（含这一帧里新登记的）
    flushFrames() {
      for (let i = 0; i < 20 && frames.length; i += 1) {
        const batch = frames.splice(0, frames.length);
        for (const f of batch) f.fn(0);
      }
    },
    // 冲到静默：帧与定时器交替推进，直到两边都空
    flushAll() {
      for (let i = 0; i < 40; i += 1) {
        if (!frames.length && !timers.length) return;
        this.flushFrames();
        const batch = timers.splice(0, timers.length);
        for (const t of batch) t.fn();
      }
    },
    pendingFrames: () => frames.length,
    pendingTimers: () => timers.length,
  };
}

/* ============================================================
   T2 · 进终端页不排在画面路径上
   ============================================================ */
const railTtl = new Function(
  `${panelJs.match(/const TERMINAL_RAIL_HISTORY_TTL_MS = [^;]+;/)?.[0]}\nreturn TERMINAL_RAIL_HISTORY_TTL_MS;`
)();

function makeRailEnv({ history, agentId = "ep-1", view = "terminal" }) {
  const clock = makeClock();
  const seen = { refresh: [], render: 0, renderHistory: [] };
  const state = {
    history: { endpoint: "", sessions: [], fetchedAt: 0, error: null, ...history },
  };
  const historyCtor = state.history;
  // renderTerminalRail 在真身里会调 syncTerminalRailHistory（9325-9326），桩照此接线，
  // 否则「进页 → 渲一帧 → 判身份」这条链在测试里是断的。
  const renderTerminalRail = () => {
    seen.render += 1;
    sync();
  };
  const deps = {
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    currentView: view,
    terminalRailAgentId: () => agentId,
    terminalRailSessionMap: () => ({}),
    refreshTerminalRailHistory: (opts) => { seen.refresh.push(opts && opts.endpoint); return Promise.resolve(); },
    renderTerminalRail,
    renderTerminalRailHistory: (id) => { seen.renderHistory.push(id); },
    closeTerminalRailSearch: () => {},
    loadTerminalRailRemovedAt: () => {},
    loadTerminalRailPrefs: () => Promise.resolve(),
    TERMINAL_RAIL_HISTORY_TTL_MS: railTtl,
  };
  const factory = new Function(
    ...Object.keys(deps),
    `
    let terminalRailHistory = ${JSON.stringify(historyCtor)};
    let terminalRailFetchQueued = false;
    let terminalRailFetchInFlight = false;
    let terminalRailRendered = { history: null };
    const terminalRailWatermarks = new Map();
    let terminalRailAutoExpandedFor = "";
    let terminalRailScrolledFor = "";
    let terminalRailFlipMode = "instant";
    ${extractFn("terminalRailHistoryFresh")}
    ${extractFn("scheduleTerminalRailHistoryFetch")}
    ${extractFn("syncTerminalRailHistory")}
    ${extractFn("enterTerminalRail")}
    return {
      enterTerminalRail,
      sync: syncTerminalRailHistory,
      snapshot: () => terminalRailHistory,
      queued: () => terminalRailFetchQueued,
    };
    `
  );
  const api = factory(...Object.values(deps));
  api.seen = seen;
  api.clock = clock;
  // renderTerminalRail 桩要先于 sync 存在：上面的对象字面量里已按引用闭包到它。
  function sync() { return api.sync(deps.terminalRailAgentId()); }
  return api;
}

describe("T2 进终端页不再把历史列表排在首帧之前", () => {
  it("源码：进页不再清空历史缓存，改为渲一帧 + 首帧后补拉", () => {
    const src = extractFn("enterTerminalRail");
    assert.doesNotMatch(src, /terminalRailHistory = \{ endpoint: ""/, "进页不再抛掉缓存");
    assert.match(src, /renderTerminalRail\(\)/);
    assert.match(src, /scheduleTerminalRailHistoryFetch\(\)/);
  });

  it("真跑：TTL 内进页一次请求都不发（缓存直接用）", () => {
    const env = makeRailEnv({
      history: { endpoint: "ep-1", sessions: [{ id: "a" }], fetchedAt: Date.now(), error: null },
    });
    env.enterTerminalRail();
    assert.equal(env.seen.render, 1, "进页先渲一帧");
    env.clock.flushAll();
    assert.deepEqual(env.seen.refresh, [], "TTL 内不补拉");
    assert.equal(env.snapshot().sessions.length, 1, "缓存行还在（没被清成空表）");
  });

  it("真跑：缓存过期才补拉，且补拉不在进页这一拍上", () => {
    const env = makeRailEnv({
      history: { endpoint: "ep-1", sessions: [], fetchedAt: Date.now() - railTtl - 1000, error: null },
    });
    env.enterTerminalRail();
    assert.deepEqual(env.seen.refresh, [], "进页这一拍只渲不拉");
    assert.equal(env.clock.pendingFrames() + env.clock.pendingTimers(), 1, "只排了一次补拉");
    env.clock.flushAll();
    assert.deepEqual(env.seen.refresh, ["ep-1"], "首帧之后补拉一次");
  });

  it("真跑：冷缓存（首次进入）同样的延迟口径——先渲空树，再补拉", () => {
    const env = makeRailEnv({ history: { endpoint: "", sessions: [], fetchedAt: 0, error: null } });
    env.enterTerminalRail();
    assert.deepEqual(env.seen.refresh, []);
    env.clock.flushAll();
    assert.deepEqual(env.seen.refresh, ["ep-1"]);
  });

  it("真跑：换身份当场清行、请求仍然延后；同身份不重复排队", () => {
    const env = makeRailEnv({
      history: { endpoint: "ep-old", sessions: [{ id: "old" }], fetchedAt: Date.now(), error: null },
    });
    env.enterTerminalRail();
    assert.equal(env.snapshot().endpoint, "ep-1", "身份已认下");
    assert.equal(env.snapshot().sessions.length, 0, "旧身份的行当场清掉");
    env.sync("ep-1");
    assert.equal(env.clock.pendingFrames() + env.clock.pendingTimers(), 1, "同一份补拉只排一次");
    env.clock.flushAll();
    assert.deepEqual(env.seen.refresh, ["ep-1"]);
  });

  it("真跑：离开终端页后补拉落地前自行放弃", () => {
    const env = makeRailEnv({ history: { endpoint: "", sessions: [], fetchedAt: 0, error: null }, view: "board" });
    env.enterTerminalRail();
    env.clock.flushAll();
    assert.deepEqual(env.seen.refresh, [], "不在终端页就不发请求");
  });

  it("真跑：补拉失败不阻断画面、不弹提示（静默留在 TTL 内）", async () => {
    const toasts = [];
    let renders = 0;
    let history = { endpoint: "ep-1", sessions: [{ id: "a" }], fetchedAt: 0, error: null };
    const factory = new Function(
      "api", "toast", "panelError", "renderTerminalRail", "terminalRailAgentId",
      `
      let terminalRailFetchInFlight = false;
      let terminalRailFlipMode = "instant";
      let terminalRailHistory = null;
      ${extractFn("refreshTerminalRailHistory")}
      return {
        run: (opts) => refreshTerminalRailHistory(opts),
        setHistory: (h) => { terminalRailHistory = h; },
        getHistory: () => terminalRailHistory,
      };
      `
    );
    const api = factory(
      () => Promise.reject(new Error("HTTP 500")),
      (msg) => { toasts.push(msg); },
      (err, fallback) => fallback,
      () => { renders += 1; },
      () => "ep-1",
    );
    api.setHistory(history);
    await api.run({ endpoint: "ep-1" });
    assert.equal(toasts.length, 0, "背景补拉失败不弹提示");
    assert.equal(renders, 1, "失败也补渲一帧，画面不被阻断");
    const after = api.getHistory();
    assert.ok(after.error, "失败态记在缓存上");
    assert.ok(after.fetchedAt > 0, "失败也记时间戳——避免每秒轮询变成每秒重试");
  });
});
/* ============================================================
   T7 · 刷新按钮带强制刷新参数
   ============================================================ */
describe("T7 刷新会话列表：显式刷新带 ?refresh=1", () => {
  function makeRefresh() {
    const calls = [];
    const state = {
      loading: false,
      sessions: [{ id: "s1", endpoint: "ep", title: "t" }],
      endpointErrors: [],
      checked: new Set(),
      selectedId: null,
    };
    const seen = { api: [], toast: [], renderList: 0 };
    let seq = 0;
    const api = (method, path) => {
      seen.api.push(`${method} ${path}`);
      return Promise.resolve({ sessions: state.sessions, endpointErrors: [] });
    };
    const factory = new Function(
      "api", "sessState", "renderSessList", "renderSessErrBanner", "renderSessDetail",
      "updateSessBatchBar", "toast", "panelError",
      `
      let sessListReqSeq = 0;
      ${extractFn("refreshSessionsList")}
      return refreshSessionsList;
      `
    );
    const run = factory(
      api,
      state,
      () => { seen.renderList += 1; },
      () => {},
      () => {},
      () => {},
      (msg) => { seen.toast.push(msg); },
      (err, fallback) => fallback,
    );
    return { run, seen, state, calls, seqOf: () => seq };
  }

  it("源码：refreshSessionsList 收 force 选项并把 refresh=1 拼进 URL", () => {
    const src = extractFn("refreshSessionsList");
    assert.match(src, /async function refreshSessionsList\(\{ force = false \} = \{\}\)/);
    assert.match(src, /\/api\/sessions\/list\$\{force \? "\?refresh=1" : ""\}/);
  });

  it("源码：刷新按钮传 force=true（其余调用点不传）", () => {
    const callers = panelJs.match(/refreshSessionsList\([^)]*\)/g) || [];
    assert.ok(callers.includes("refreshSessionsList({ force: true })"), "刷新按钮带 force");
    assert.ok(callers.includes("refreshSessionsList()"), "首次装载等自动路径不带 force");
  });

  it("真跑：force=true 的请求 URL 带 refresh=1，自动路径不带", async () => {
    const { run, seen } = makeRefresh();
    await run({ force: true });
    assert.deepEqual(seen.api, ["GET /api/sessions/list?refresh=1"]);
    const second = makeRefresh();
    await second.run();
    assert.deepEqual(second.seen.api, ["GET /api/sessions/list"]);
  });
});
