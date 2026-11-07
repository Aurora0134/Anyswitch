// 终端切签 / 后台切回 / 进页的客户端行为钉。
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
// 切源码共用带截断守卫的共享取样 helper（正则终点锚是首个「\n  }」，函数体内
// 模板串/注释含该序列时由 helper 在提取处报半截，不再静默放行）。
import { extractPanelFn as extractFn } from "../test-helpers/extract-panel-fn.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const panelJs = readFileSync(join(here, "../panel-ui", "panel.js"), "utf8");
const panelCss = readFileSync(join(here, "../panel-ui", "panel.css"), "utf8");

// 手动推进的 rAF/定时器队列：切源码后的代码只认注入的这两个入口，测试自己决定
// 「下一帧」和「下一个任务」什么时候到——不靠 sleep。
function makeClock() {
  let seq = 0;
  const frames = [];
  const timers = [];
  const stats = { framesFlushed: 0, timersFired: 0 };
  return {
    stats,
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
        for (const f of batch) { stats.framesFlushed += 1; f.fn(0); }
      }
    },
    // 冲到静默：帧与定时器交替推进，直到两边都空
    flushAll() {
      for (let i = 0; i < 40; i += 1) {
        if (!frames.length && !timers.length) return;
        this.flushFrames();
        const batch = timers.splice(0, timers.length);
        for (const t of batch) { stats.timersFired += 1; t.fn(); }
      }
    },
    pendingFrames: () => frames.length,
    pendingTimers: () => timers.length,
    // 只触发最早登记的那一个定时器：续窗逻辑要靠「到点那一刻垫片还在不在」来验，
    // flushAll 一口气冲到静默会把中间态跳过去。
    fireOldestTimer() {
      const t = timers.shift();
      if (!t) return false;
      stats.timersFired += 1;
      t.fn();
      return true;
    },
    // 在册定时器的延时值（升序）：上限分档这类「只差一个常数」的判据不能靠推进时钟
    // 来验——手动时钟一冲就是把所有定时器一起跑完，2s 与 6s 没有区别。读登记值才分得开。
    timerDelays: () => timers.map((t) => t.ms).sort((a, b) => a - b),
  };
}

/* ============================================================
   T2 · 进终端页不排在画面路径上
   ============================================================ */
// TTL 从真身源码里读数值（不在测试里另抄一个常数）。取值放在函数里，是让「这条
// 常量还不存在」时红在对应的测试上，而不是炸在模块加载期、把其它钉子一起带走。
function railTtl() {
  const decl = panelJs.match(/const TERMINAL_RAIL_HISTORY_TTL_MS = [^;]+;/)?.[0];
  assert.ok(decl, "TERMINAL_RAIL_HISTORY_TTL_MS 在 panel.js 里");
  return new Function(`${decl}\nreturn TERMINAL_RAIL_HISTORY_TTL_MS;`)();
}

// 失败后的短退避同样从真身取值——测试不另抄常数。
function retryMs() {
  const decl = panelJs.match(/const TERMINAL_RAIL_HISTORY_RETRY_MS = [^;]+;/)?.[0];
  assert.ok(decl, "TERMINAL_RAIL_HISTORY_RETRY_MS 在 panel.js 里");
  return new Function(`${decl}\nreturn TERMINAL_RAIL_HISTORY_RETRY_MS;`)();
}

// 真跑 enterTerminalRail / scheduleTerminalRailHistoryFetch / terminalRailHistoryFresh /
// syncTerminalRailHistory / refreshTerminalRailHistory 五个真身，只把网络面（api）与
// 渲染面替成桩：断言落在「发了几条请求、什么时候发」而不是任何墙钟。
function makeRailEnv({ history, agentId = "ep-1", view = "terminal", apiImpl, fetchedAtAgo } = {}) {
  const clock = makeClock();
  const seen = { api: [], rail: 0, historyRender: [], toast: [] };
  // 可注入的「现在」：退避与 TTL 都是时间闸，测试要么等墙钟（禁止）要么把时钟捏在手里。
  let virtualNow = Date.now();
  const DateStub = { now: () => virtualNow };
  // 缓存时间戳一律由本工厂相对虚拟钟折算（fetchedAtAgo＝这份缓存已存在多少毫秒），
  // 夹具不再各自取 Date.now()——真钟与虚拟钟只在上面这一行对齐一次，此后不混用。
  const seed = { endpoint: "", sessions: [], fetchedAt: 0, error: null, ...history };
  if (fetchedAtAgo !== undefined) seed.fetchedAt = virtualNow - fetchedAtAgo;
  // renderTerminalRail 真身渲完一帧会调 syncTerminalRailHistory 认身份（这条接线由
  // T2 的「源码：renderTerminalRail 真身认身份」用例钉住，此处不引行号防漂移），
  // 桩照此接线，否则「进页 → 渲一帧 → 判身份」这条链在测试里是断的。工厂建好后再把 sync 填进来。
  const railHook = { sync: null };
  const rendersRail = () => { seen.rail += 1; if (railHook.sync) railHook.sync(agentId); };
  const factory = new Function(
    "api", "toast", "panelError", "currentView", "terminalRailAgentId",
    "terminalRailSessionMap", "renderTerminalRail", "renderTerminalRailHistory",
    "closeTerminalRailSearch", "loadTerminalRailRemovedAt", "loadTerminalRailPrefs",
    "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout",
    "TERMINAL_RAIL_HISTORY_TTL_MS", "TERMINAL_RAIL_HISTORY_RETRY_MS", "Date",
    `
    let terminalRailHistory = ${JSON.stringify(seed)};
    let terminalRailFetchQueued = false;
    let terminalRailFetchInFlight = false;
    let terminalRailRendered = { history: null };
    let terminalRailFlipMode = "instant";
    const terminalRailWatermarks = new Map();
    let terminalRailAutoExpandedFor = "";
    let terminalRailScrolledFor = "";
    ${extractFn("terminalRailHistoryFresh")}
    ${extractFn("refreshTerminalRailHistory")}
    ${extractFn("scheduleTerminalRailHistoryFetch")}
    ${extractFn("syncTerminalRailHistory")}
    ${extractFn("enterTerminalRail")}
    return {
      enterTerminalRail,
      sync: syncTerminalRailHistory,
      snapshot: () => terminalRailHistory,
      queued: () => terminalRailFetchQueued,
      inFlight: () => terminalRailFetchInFlight,
    };
    `
  );
  const env = factory(
    (method, path) => {
      seen.api.push(`${method} ${path}`);
      return (apiImpl || (() => Promise.resolve({ sessions: [], endpointErrors: [] })))(method, path);
    },
    (msg) => { seen.toast.push(msg); },
    (err, fallback) => fallback,
    view,
    () => agentId,
    () => ({}),
    rendersRail,
    (id) => { seen.historyRender.push(id); },
    () => {},
    () => {},
    () => Promise.resolve(),
    clock.requestAnimationFrame, clock.cancelAnimationFrame, clock.setTimeout, clock.clearTimeout,
    railTtl(), retryMs(), DateStub,
  );
  env.seen = seen;
  env.clock = clock;
  env.now = () => virtualNow;
  env.setNow = (t) => { virtualNow = t; };
  railHook.sync = env.sync;
  return env;
}

describe("T2 进终端页不再把历史列表排在首帧之前", () => {
  it("源码：进页不再清空历史缓存，改为渲一帧 + 首帧后补拉", () => {
    const src = extractFn("enterTerminalRail");
    assert.doesNotMatch(src, /terminalRailHistory = \{ endpoint: ""/, "进页不再抛掉缓存");
    assert.match(src, /renderTerminalRail\(\)/);
    assert.match(src, /scheduleTerminalRailHistoryFetch\(\)/);
    // 身份换人那条路径保持既有同步契约（别处 vm 沙箱钉着它）
    const sync = extractFn("syncTerminalRailHistory");
    assert.match(sync, /if \(agentId === terminalRailHistory\.endpoint\) return;/);
    assert.match(sync, /refreshTerminalRailHistory\(\{ endpoint: agentId \}\);/);
  });

  it("源码：renderTerminalRail 真身渲一帧后认身份（桩里手工补的 sync 接线有据可依）", () => {
    // 桩环境把 renderTerminalRail 整个替掉了，「进页 → 渲一帧 → 认身份」这条真实
    // 接线在本文件的真跑里永远走不到——在源码层钉住它，接线断开时这里要红。
    assert.match(
      extractFn("renderTerminalRail"),
      /syncTerminalRailHistory\(agentId\);/,
      "渲完一帧要认身份，否则进页后的身份切换没人接",
    );
  });

  it("真跑：TTL 内进页一条请求都不发（缓存直接用）", () => {
    const env = makeRailEnv({
      history: { endpoint: "ep-1", sessions: [{ id: "a" }], error: null },
      fetchedAtAgo: 0,
    });
    env.enterTerminalRail();
    assert.equal(env.seen.rail, 1, "进页先渲一帧");
    env.clock.flushAll();
    assert.deepEqual(env.seen.api, [], "TTL 内不补拉");
    assert.equal(env.snapshot().sessions.length, 1, "缓存行还在（没被清成空表）");
  });

  it("真跑：缓存过期才补拉，且补拉不在进页这一拍上", async () => {
    const env = makeRailEnv({
      history: { endpoint: "ep-1", sessions: [], error: null },
      fetchedAtAgo: railTtl() + 1000,
    });
    env.enterTerminalRail();
    assert.deepEqual(env.seen.api, [], "进页这一拍只渲不拉");
    assert.equal(env.clock.pendingFrames() + env.clock.pendingTimers(), 1, "只排了一次补拉");
    env.clock.flushAll();
    await Promise.resolve();
    assert.deepEqual(env.seen.api, ["GET /api/sessions/list"], "首帧之后补拉一次");
  });

  it("真跑：冷缓存（首次进入）走既有换身份通路，且首帧之后不再重复拉一次", async () => {
    const env = makeRailEnv({ history: { endpoint: "", sessions: [], fetchedAt: 0, error: null } });
    env.enterTerminalRail();
    env.clock.flushAll();
    await Promise.resolve();
    assert.equal(env.seen.api.length, 1, "冷启动只发一条");
    assert.deepEqual(env.seen.api, ["GET /api/sessions/list"], "不重复、不并发");
  });

  it("真跑：同身份过期时补拉保留屏上已有的行（stale-while-revalidate）", async () => {
    const env = makeRailEnv({
      history: { endpoint: "ep-1", sessions: [{ id: "a" }], error: null },
      fetchedAtAgo: railTtl() + 1000,
    });
    env.enterTerminalRail();
    env.clock.flushAll();
    // 请求在飞：行还在（没被清成空表）
    assert.equal(env.snapshot().sessions.length, 1, "复取期间行不清空");
    await Promise.resolve();
    assert.equal(env.snapshot().fetchedAt > env.now() - railTtl(), true, "落地后刷新时间戳（对齐虚拟钟，不混真钟）");
  });

  it("真跑：换身份当场清行、同步重拉一次（既有契约）；同身份不排队", () => {
    const env = makeRailEnv({
      history: { endpoint: "ep-old", sessions: [{ id: "old" }], error: null },
      fetchedAtAgo: 0,
    });
    env.enterTerminalRail();
    assert.equal(env.snapshot().endpoint, "ep-1", "身份已认下");
    assert.equal(env.snapshot().sessions.length, 0, "旧身份的行当场清掉");
    assert.equal(env.seen.api.length, 1, "换身份这一拍就重拉（既有契约）");
    env.clock.flushAll();
    assert.equal(env.seen.api.length, 1, "首帧之后不重复排队");
  });

  it("真跑：离开终端页后补拉落地前自行放弃", async () => {
    const env = makeRailEnv({
      history: { endpoint: "ep-1", sessions: [], error: null },
      view: "board",
      fetchedAtAgo: railTtl() + 1000,
    });
    env.enterTerminalRail();
    env.clock.flushAll();
    await Promise.resolve();
    assert.deepEqual(env.seen.api, [], "不在终端页就不发请求");
  });

  it("真跑：补拉失败不清行、不弹提示，并按短退避（不是 TTL、不是每秒）允许重试", async () => {
    const env = makeRailEnv({
      history: { endpoint: "ep-1", sessions: [{ id: "a" }, { id: "b" }], error: null },
      fetchedAtAgo: railTtl() + 1000,
      apiImpl: () => Promise.reject(new Error("HTTP 500")),
    });
    env.enterTerminalRail();
    env.clock.flushAll();
    await Promise.resolve();
    assert.deepEqual(env.seen.toast, [], "背景补拉失败不弹任何提示");
    assert.equal(env.seen.rail >= 2, true, "失败也补渲一帧，画面不被阻断");
    const after = env.snapshot();
    assert.equal(after.sessions.length, 2, "失败不清屏上已有的行");
    assert.equal(after.error, null, "有行在手就不落失败态（那份行仍是事实，只是旧）");
    assert.ok(after.retryAt > env.now(), "失败记下重试闸（对齐虚拟钟，不混真钟）");
    // 重试闸立到：立刻再进页也不发（不是每秒重试）
    env.enterTerminalRail();
    env.clock.flushAll();
    await Promise.resolve();
    assert.equal(env.seen.api.length, 1, "退避窗内不重试");
    // 退避到期：下一个自然触发点（进页）照常重取——不是死等 30s TTL
    env.setNow(env.now() + retryMs() + 50);
    env.enterTerminalRail();
    env.clock.flushAll();
    await Promise.resolve();
    assert.equal(env.seen.api.length, 2, "退避到期后重取一次");
    assert.ok(retryMs() < railTtl(), "短退避必须远小于 TTL");
  });

  it("真跑：首拉失败（一行都没有）才落失败态，且仍不弹提示", async () => {
    const env = makeRailEnv({
      history: { endpoint: "", sessions: [], fetchedAt: 0, error: null },
      apiImpl: () => Promise.reject(new Error("HTTP 500")),
    });
    env.enterTerminalRail();
    env.clock.flushAll();
    await Promise.resolve();
    const after = env.snapshot();
    assert.equal(after.sessions.length, 0);
    assert.ok(after.error, "没有旧行可留时如实记失败态");
    assert.deepEqual(env.seen.toast, [], "仍然不弹提示");
  });
});


/* ============================================================
   T3/T4 · 切换期不出现纯底色：旧画面留到新画面就绪再换
   ============================================================ */
// 桩世界：真跑 closeTerminalStream / absorbTerminalSnapshot / connectTerminalStream /
// parkTerminalScreen / dropTerminalStaleScreen / watchTerminalStaleScreen /
// revealTerminalStaleScreen 七个真身，只把 xterm 构造、EventSource、post 面替成桩。
// 断言只锚调用序列与 DOM/属性状态，不锚任何墙钟。
function makeTerminalWorld({ hiddenView = false, fitImpl = null } = {}) {
  const clock = makeClock();
  const log = [];            // 全局调用序列（跨实例）
  const sources = [];
  const inputPosts = [];     // sendTerminalInput 的调用
  const created = [];
  const staleConst = panelJs.match(/const TERMINAL_STALE_SCREEN_MAX_MS = [^;]+;/)?.[0];
  assert.ok(staleConst, "TERMINAL_STALE_SCREEN_MAX_MS 在 panel.js 里");
  const switchStaleConst = panelJs.match(/const TERMINAL_SWITCH_STALE_SCREEN_MAX_MS = [^;]+;/)?.[0];
  assert.ok(switchStaleConst, "TERMINAL_SWITCH_STALE_SCREEN_MAX_MS 在 panel.js 里（换绑放宽档）");
  const renewalsConst = panelJs.match(/const TERMINAL_SWITCH_STALE_SCREEN_MAX_RENEWALS = [^;]+;/)?.[0];
  assert.ok(renewalsConst, "TERMINAL_SWITCH_STALE_SCREEN_MAX_RENEWALS 在 panel.js 里（续窗上限）");
  // 几何闸的常量从真身取原句：本文件只跑切签，但 close/absorb 会读它们。
  const declOfGeom = (name) => {
    const decl = panelJs.match(new RegExp(`const ${name} = [^;]+;`))?.[0];
    assert.ok(decl, `${name} 在 panel.js 里`);
    return decl;
  };
  const factory = new Function(
    "$", "EventSource", "API_BASE", "setTimeout", "clearTimeout",
    "requestAnimationFrame", "cancelAnimationFrame", "document",
    "ensureTerminalXterm", "fitTerminalXterm", "sendTerminalInput", "reviveTerminalSession",
    "flushTerminalBurst", "discardTerminalBurst", "queueTerminalChunk",
    "disarmTerminalDprWatch", "nextTerminal", "terminalHostMeasurable",
    "postTerminalResize", "console",
    `
    let terminalXterm = null;
    let terminalEventSource = null;
    let terminalInputDisposable = null;
    let terminalBoundSessionId = null;
    let terminalFitAddon = null;
    let terminalWebglAddon = null;
    let terminalHostResizeObserver = null;
    let terminalImeAnchorTextarea = null;
    let terminalImeAnchorTerm = null;
    let terminalImeArmHandler = null;
    let terminalImeReleaseHandler = null;
    let terminalImeHold = null;
    let terminalImeFitPending = false;
    let terminalImeHoldFrame = null;
    let terminalReplayRestoreCancel = null;
    let terminalReplayRestoreArm = null;
    let terminalReplayRestoring = false;
    let terminalStreamSyncCancel = null;
    let terminalStreamWrite = null;
    let terminalReplayFramePending = false;
    let terminalStaleScreen = null;
    let terminalReplayEpoch = 0;
    let terminalContentEpoch = 0;
    let terminalContentTerm = null;
    let terminalContentSeen = false;
    let terminalSwitchInFlight = false;
    let terminalSwitchInFlightSessionId = null;
    let terminalBooting = null;
    let terminalUnavailableRenders = 0;
    // 几何闸的收尾设施（G2b）：closeTerminalStream / absorbTerminalSnapshot 会碰它们。
    // 本文件只关心垫片与切签，会话查找给空表——补挂路径在这里永远早退，不参与断言。
    let terminalGeometryRealignPending = false;
    let terminalGeometryRealignAt = 0;
    let terminalGeometryRealignStreak = 0;
    let terminalGeometryReplayDrop = false;
    let terminalStreamDeferred = false;
    let terminalStreamRemounting = false;
    let terminalDeferredSessionId = null;
    let terminalGeometryRealignTimer = null;
    let activeTerminalPreviewId = null;
    function terminalSessionFor() { return null; }
    ${declOfGeom("TERMINAL_GEOMETRY_REALIGN_COOLDOWN_MS")}
    ${declOfGeom("TERMINAL_GEOMETRY_REALIGN_MAX_ATTEMPTS")}
    ${declOfGeom("TERMINAL_GEOMETRY_REALIGN_STALL_MS")}
    function renderTerminalUnavailableState() { terminalUnavailableRenders += 1; }
    ${staleConst}
    ${switchStaleConst}
    ${renewalsConst}
    ${extractFn("terminalSwitchStaleWidened")}
    ${extractFn("closeTerminalStream")}
    ${extractFn("dropTerminalStaleScreen")}
    ${extractFn("terminalScreenHasContent")}
    ${extractFn("noteTerminalContent")}
    ${extractFn("terminalStaleScreenReady")}
    ${extractFn("watchTerminalStaleScreen")}
    ${extractFn("revealTerminalStaleScreen")}
    ${extractFn("parkTerminalScreen")}
    ${extractFn("absorbTerminalSnapshot")}
    ${extractFn("dropTerminalReplayFrame")}
    ${extractFn("deferTerminalStream")}
    ${extractFn("remountDeferredTerminalStream")}
    ${extractFn("finishTerminalGeometryRealign")}
    ${extractFn("scheduleTerminalGeometryRealign")}
    ${extractFn("terminalSessionShouldRevive")}
    ${extractFn("connectTerminalStream")}
    return {
      connectTerminalStream,
      parkTerminalScreen,
      closeTerminalStream,
      dropTerminalStaleScreen,
      stale: () => terminalStaleScreen,
      instance: () => terminalXterm,
      bound: () => terminalBoundSessionId,
      pending: () => terminalReplayFramePending,
      epoch: () => terminalReplayEpoch,
      contentEpoch: () => terminalContentEpoch,
      unavailableRenders: () => terminalUnavailableRenders,
      setSwitchInFlight: (v, sessionId = null) => { terminalSwitchInFlight = v; terminalSwitchInFlightSessionId = sessionId; },
      setBooting: (v) => { terminalBooting = v; },
      openNext() {
        const term = nextTerminal();
        terminalXterm = term;
        return term;
      },
    };
    `
  );
  const ctx = { hidden: hiddenView, docHidden: false };
  // 宿主桩：xterm 的 open 就是把 element 挂进宿主，dispose 再摘走——垫片断言靠它。
  const host = {
    children: [],
    appendChild(node) { node.parentNode = host; host.children.push(node); return node; },
    removeChild(node) {
      node.parentNode = null;
      host.children = host.children.filter((c) => c !== node);
      return node;
    },
  };
  const world = factory(
    (id) => (id === "terminalView" ? { hidden: ctx.hidden } : null),
    function StubEventSource(url) {
      const es = {
        url, closed: false, handlers: {}, onerror: null,
        close() { this.closed = true; log.push("es_close"); },
        addEventListener(type, fn) { (this.handlers[type] || (this.handlers[type] = [])).push(fn); },
        emit(type, data) { for (const fn of this.handlers[type] || []) fn({ data }); },
      };
      sources.push(es);
      log.push("es_new");
      return es;
    },
    "/panel",
    clock.setTimeout, clock.clearTimeout, clock.requestAnimationFrame, clock.cancelAnimationFrame,
    { get hidden() { return ctx.docHidden; } },
    () => openTerm(),
    fitImpl ?? (() => { log.push("fit"); }),
    (id, data) => { inputPosts.push(`${id}:${data}`); },
    () => Promise.resolve(null),
    () => { log.push("flush_burst"); },
    () => {},
    () => { log.push("queue_chunk"); },
    () => {},
    () => {
      const term = makeStubTerm(log, created.length + 1);
      created.push(term);
      return term;
    },
    // 几何闸的「尺寸可信」判据：本文件的世界里宿主总是可测的（与真身默认路径一致）。
    () => true,
    // 几何重对齐的 resize POST 面：本文件的用例不走这条路径，只保证不炸。
    () => Promise.resolve(null),
    console,
  );
  function openTerm() {
    log.push("open_new");
    const term = world.openNext();
    host.appendChild(term.element);
    return term;
  }
  return { world, clock, log, sources, inputPosts, created, ctx, host };
}

// 桩实例：buffer 忠实复刻 xterm 的两条实测事实——①一开屏就有 rows 行空行，所以
// buffer.active.length 恒 ≥ rows，拿它当「有内容」的判据必然误判（CDP 实测里这条
// 错判据会让垫片提前约 340ms 撤走）；②真有字要逐行看 translateToString。
function makeStubTerm(log, n) {
  const id = `t${n}`;
  const listeners = [];
  const classes = new Set();
  const element = {
    parentNode: null,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
  const term = {
    id,
    cols: 120,
    rows: 34,
    options: { disableStdin: false },
    element,
    classes,
    screenText: "",
    written: [],
    disposed: false,
    refreshCalls: 0,
    reset() { term.screenText = ""; log.push(`${id}.reset`); },
    focus() { log.push(`${id}.focus`); },
    refresh() { term.refreshCalls += 1; log.push(`${id}.refresh`); },
    dispose() {
      term.disposed = true;
      log.push(`${id}.dispose`);
      if (element.parentNode) { element.parentNode.removeChild(element); element.parentNode = null; }
    },
    onData(fn) {
      listeners.push(fn);
      return {
        dispose: () => {
          const at = listeners.indexOf(fn);
          if (at >= 0) listeners.splice(at, 1);
          log.push(`${id}.input_disposed`);
        },
      };
    },
    // 模拟「内核解析旧积压后产生的自动应答」：只在监听器还在时才派发（与 xterm
    // 的 _onData 表一致）。disableStdin 为真时真内核根本不会走到派发。
    fireAutoReply(payload) {
      if (term.options.disableStdin) { log.push(`${id}.reply_blocked`); return; }
      for (const fn of [...listeners]) fn(payload);
    },
    // 写入按 xterm 的解析面复刻：CSI/OSC 控制序列不落字，ED（2J/3J）清屏。桩早期
    // 是「原样拼字节」，于是清屏帧也变成「屏上有内容」——那条判据在真实 xterm 上
    // 恒不成立，用桩钉它只会把 bug 钉成期望值。
    write(data, cb) {
      term.written.push(data);
      log.push(`${id}.write`);
      const text = data === undefined || data === null ? "" : String(data);
      if (/\u001b\[[0-3]?J/.test(text)) term.screenText = "";
      term.screenText += text
        .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
      if (cb) cb();
    },
  };
  term.buffer = {
    active: {
      length: 34, // ← 空屏也是 rows 行（真 xterm 就这样）
      viewportY: 0,
      getLine: (y) => ({ translateToString: () => (y === 0 ? term.screenText : "") }),
    },
  };
  return term;
}

const terminalSession = (id, extra = {}) => ({
  id, backend: true, backendState: { status: "running", cols: 120, rows: 34 }, shell: {}, ...extra,
});

// 建一条已画好内容的连接（首连不涉及垫片）
async function primeSession(w, session) {
  await w.world.connectTerminalStream(session);
  const es = w.sources[w.sources.length - 1];
  es.emit("snapshot", JSON.stringify({ pid: 1, cols: 120, rows: 34 }));
  es.emit("data", JSON.stringify(`${session.id}-screen\n`));
  w.clock.flushAll();
  return { es, term: w.created[w.created.length - 1] };
}

describe("T3 切签：旧画面留到新画面就绪再换", () => {
  it("源码：切换入口先停放旧画面，拆流公共体一字未改", () => {
    const render = extractFn("renderTerminalPreviewSession");
    // 切换入口有两条路径（deferScreen 让帧路径 / 默认直排路径），各有同一对
    // 「停放 → 建流」。逐路径配对核对——indexOf 首次命中只会落进 deferScreen
    // 分支，默认路径反转时它无感。
    const parkAt = [...render.matchAll(/parkTerminalScreen\(\);/g)].map((m) => m.index);
    const connectAt = [...render.matchAll(/connectTerminalStream\(session, \{ revive \}\);/g)].map((m) => m.index);
    assert.equal(parkAt.length, 2, "两条切换路径各停放一次");
    assert.equal(connectAt.length, 2, "两条切换路径各建流一次");
    assert.ok(connectAt[0] > parkAt[0], "deferScreen 让帧路径：停放排在建流之前");
    assert.ok(connectAt[1] > parkAt[1], "默认直排路径：停放排在建流之前");
    // 拆流公共体保持原样：签名与 dispose 都在（别的沙箱按这两个特征切它）
    const close = extractFn("closeTerminalStream");
    assert.match(close, /^function closeTerminalStream\(\) \{/);
    assert.match(close, /terminalXterm\?\.dispose\(\);/);
    // 停放是「借那一拍把 dispose 空转」，不是改拆流语义
    const park = extractFn("parkTerminalScreen");
    assert.match(park, /term\.dispose = \(\) => \{\};/);
    assert.match(park, /term\.dispose = originalDispose;/);
    assert.match(park, /disableStdin = true/);
    assert.match(park, /if \(\$\("terminalView"\)\?\.hidden\) return null;/, "隐藏期不停放不拆流");
  });

  it("源码/CSS：垫片是绝对定位盖层，不参与布局、不吞指针事件", () => {
    const rule = panelCss.match(/\.terminal-xterm-host \.xterm\.terminal-stale-frame \{[\s\S]*?\}/)?.[0] || "";
    assert.match(rule, /position: absolute/);
    assert.match(rule, /inset: 0/);
    assert.match(rule, /pointer-events: none/);
    assert.match(rule, /z-index: 1/);
    assert.match(panelCss, /\.terminal-xterm-host \{ position: relative;/);
    assert.match(panelCss, /\.terminal-unavailable \{[\s\S]{0,120}z-index: 2/);
  });

  it("真跑：销毁旧实例排在新画面画出内容之后（调用序列可判红）", async () => {
    const w = makeTerminalWorld();
    const { term: termA } = await primeSession(w, terminalSession("A"));
    assert.ok(termA.screenText.length > 0, "旧画面确实有内容");

    // 切签：完全照 renderTerminalPreviewSession 的顺序——先停放，再建流
    w.world.parkTerminalScreen();
    await w.world.connectTerminalStream(terminalSession("B"));
    const termB = w.created[1];

    // 新画面还没落地之前：旧实例既没销毁，也还在宿主里当垫片
    assert.equal(termA.disposed, false, "旧实例未销毁");
    assert.ok(termA.classes.has("terminal-stale-frame"), "旧实例留在宿主里当垫片");
    assert.equal(termA.options.disableStdin, true, "垫片实例输入面已掐断");
    assert.ok(w.host.children.includes(termA.element), "旧实例的 DOM 还挂着");
    w.clock.flushFrames();
    w.clock.flushFrames();
    assert.equal(termA.disposed, false, "新实例还没有内容，垫片不撤");

    // 新画面落地：snapshot → 首帧回放
    w.sources[1].emit("snapshot", JSON.stringify({ pid: 2, cols: 120, rows: 34 }));
    w.sources[1].emit("data", JSON.stringify("B-screen\n"));
    assert.equal(termA.disposed, false, "写入这一拍还没撤垫片");
    w.clock.flushAll();
    assert.equal(termA.disposed, true, "新画面画出内容后垫片才销毁");
    assert.equal(termA.classes.has("terminal-stale-frame"), false, "垫片类已摘");
    assert.equal(w.host.children.includes(termA.element), false, "垫片 DOM 已从宿主摘走");
    assert.equal(termB.refreshCalls, 1, "撤垫片后补一帧整屏重绘");

    const writeAt = w.log.indexOf(`${termB.id}.write`);
    const disposeAt = w.log.indexOf(`${termA.id}.dispose`);
    assert.ok(writeAt >= 0 && disposeAt > writeAt, `销毁排在新画面写入之后（${w.log.join(" → ")}）`);
  });

  it("真跑：旧实例的自动应答打不进新会话 PTY（定投目标已换人 + 监听已摘）", async () => {
    const w = makeTerminalWorld();
    const { term: termA } = await primeSession(w, terminalSession("A"));
    termA.fireAutoReply("\u001b[?1;2c");
    assert.deepEqual(w.inputPosts, ["A:\u001b[?1;2c"], "切换前应答定投旧会话");

    w.world.parkTerminalScreen();
    await w.world.connectTerminalStream(terminalSession("B"));
    assert.equal(w.world.bound(), "B", "新连接的定投目标已是新会话");
    // 停放把 disableStdin 置位与拆流摘监听同拍完成，桩环境里可独立判红的闸只有
    // 「监听已摘」这一道：把 disableStdin 硬关掉，应答仍派发不到任何投递点。
    // disableStdin 置位本身由「源码：切换入口先停放旧画面」（源码正则）与
    // 「真跑：销毁旧实例…」（置位后的实例属性）两条钉住；若这里对着置位态再发
    // 一枪，结果与下一枪全同（监听已空，走不走 disableStdin 早退都无投递），无判别力。
    termA.options.disableStdin = false;
    termA.fireAutoReply("\u001b[?1;2c");
    assert.deepEqual(w.inputPosts, ["A:\u001b[?1;2c"], "监听已摘，旧字节无处可去");
    w.clock.flushAll();
  });

  it("真跑：换绑清屏帧不算就绪——垫片继续盖着，直到新画面真的出字", async () => {
    // 病灶（2026-11-05 A4）：旧判据「首帧回放那一拍发生过」在换绑内切时命中的是宿主
    // 发来的清屏帧（\e[0m\e[2J\e[H），于是在屏上什么都没有的那一刻就揭幕——用户看到
    // 的就是那块空白。这里钉住：清屏帧到了、缓冲区一个字都没有 ⇒ 垫片不撤。
    const w = makeTerminalWorld();
    const { term: termA } = await primeSession(w, terminalSession("A"));
    const contentEpochAtPark = w.world.contentEpoch();
    w.world.parkTerminalScreen();
    await w.world.connectTerminalStream(terminalSession("B"));
    w.sources[1].emit("snapshot", JSON.stringify({ pid: 2, cols: 120, rows: 34 }));
    // 换绑清屏帧：真实字节就是这样，写进去缓冲区里仍然没有字
    w.sources[1].emit("data", JSON.stringify("\u001b[0m\u001b[2J\u001b[H"));
    assert.equal(w.created[1].written.join(""), "\u001b[0m\u001b[2J\u001b[H", "清屏帧确实写进了新实例");
    assert.equal(w.world.contentEpoch(), contentEpochAtPark, "清屏帧不出字：首帧出字计数没动");
    w.clock.flushFrames();
    assert.equal(termA.disposed, false, "清屏帧不算就绪：垫片还在（旧判据在这一步就撤了）");
    assert.notEqual(w.world.stale(), null, "垫片还在册");
    assert.equal(w.world.stale().term, termA, "在册的仍是停放时那只旧实例");

    // 新会话画出第一屏：这时候才揭幕
    w.sources[1].emit("data", JSON.stringify("dsh > \n"));
    w.clock.flushAll();
    assert.equal(termA.disposed, true, "新画面真的出字后垫片才销毁");
    assert.equal(w.world.stale(), null, "垫片已撤");
  });

  it("真跑：空屏会话不再靠「首帧回放」揭幕，交给兜底上限撤", async () => {
    // 首帧回放是空串（宿主镜像本来就空）时没有任何字可认——这正是旧判据的用武
    // 之地，也是它在换绑场景误伤的来源。现在一律等兜底：宁可多盖一会儿同一条会话
    // 的旧帧（换绑档 6s，见下一条用例），也不在屏上还没东西时就把垫片撤掉。
    const w = makeTerminalWorld();
    const { term: termA } = await primeSession(w, terminalSession("A"));
    w.world.parkTerminalScreen();
    await w.world.connectTerminalStream(terminalSession("B"));
    w.sources[1].emit("snapshot", JSON.stringify({ pid: 2, cols: 120, rows: 34 }));
    w.sources[1].emit("data", JSON.stringify(""));
    assert.equal(w.created[1].screenText, "", "新实例缓冲区里一个字都没有");
    w.clock.flushFrames();
    assert.equal(termA.disposed, false, "空回放不揭幕");
    assert.equal(w.clock.stats.timersFired, 0, "帧推进期间一个定时器都没跑（不是兜底撤的）");
    w.clock.flushAll();
    assert.equal(w.world.stale(), null, "最终由兜底计时器撤垫片");
    assert.equal(termA.disposed, true);
  });

  it("真跑：判据函数在没有换绑/占位设施的环境里也不抛（typeof 不豁免 TDZ）", () => {
    // 两个信号声明在 panel.js 后文（12130 / 9148 附近），而 parkTerminalScreen 可能被更早
    // 的调用路径问到。typeof 对 let/const 不豁免 TDZ——用 typeof 闸写这条判据会在真机上
    // 抛 ReferenceError（垫片兜底计时器整条失效）。沙箱里两个名字完全不存在，等价于
    // 「读不到就按普通档」这条路；这里直接调，抛了就红。
    const fn = new Function(`${extractFn("terminalSwitchStaleWidened")}\nreturn terminalSwitchStaleWidened;`)();
    assert.equal(fn(), false, "名字一个都不存在：按普通档，且不抛");
    assert.equal(fn("s1"), false, "给了会话 id 但设施不存在：同样按普通档，且不抛");
    // 在飞 + 同一会话 → 放宽；在飞但是别的会话 → 不放宽（这条是 2026-11-05 评审 major 的钉子）
    const fn2 = new Function(
      "terminalSwitchInFlight", "terminalSwitchInFlightSessionId",
      `let terminalBooting = null;\n${extractFn("terminalSwitchStaleWidened")}\nreturn terminalSwitchStaleWidened;`,
    )(true, "s1");
    assert.equal(fn2("s1"), true, "这条会话自己在换绑 → 放宽");
    assert.equal(fn2("s2"), false, "别的会话在换绑 → 不放宽（不许把别人的旧帧盖 6s）");
    // 占位武装：按占位自己的会话 id 判
    const fn3 = new Function(
      "terminalSwitchInFlight", "terminalSwitchInFlightSessionId",
      `let terminalBooting = { sessionId: "s1" };\n${extractFn("terminalSwitchStaleWidened")}\nreturn terminalSwitchStaleWidened;`,
    )(false, null);
    assert.equal(fn3("s1"), true, "本会话的占位还武装着 → 放宽");
    assert.equal(fn3("s2"), false, "占位是别的会话的 → 不放宽");
    assert.equal(fn3(), false, "没有会话 id → 一律普通档");
  });

  it("判据本身：只有「新画面真的出字」才算就绪（换回计数比较这条必红）", () => {
    const factory = new Function(
      "requestAnimationFrame",
      `
      let terminalXterm = null;
      let terminalContentEpoch = 0;
      let terminalContentTerm = null;
      let terminalContentSeen = false;
      ${extractFn("terminalScreenHasContent")}
      ${extractFn("noteTerminalContent")}
      ${extractFn("terminalStaleScreenReady")}
      return {
        ready: terminalStaleScreenReady,
        setTerm: (t) => { terminalXterm = t; },
      };
      `
    );
    const api = factory(() => 0);
    const blankTerm = {
      rows: 4,
      buffer: { active: { length: 4, viewportY: 0, getLine: () => ({ translateToString: () => "" }) } },
    };
    const filledTerm = {
      rows: 4,
      buffer: { active: { length: 4, viewportY: 0, getLine: (y) => ({ translateToString: () => (y === 0 ? "hello" : "") }) } },
    };
    // 空屏实例：停放时记下的计数是 0
    api.setTerm(blankTerm);
    const stale = { contentEpochAtPark: 0 };
    assert.equal(api.ready(stale), false, "屏上没字 → 未就绪");
    assert.equal(api.ready(null), false, "没有垫片就不谈就绪");
    // 换成有字的实例：出字当拍计数 +1，判据成立
    api.setTerm(filledTerm);
    assert.equal(api.ready(stale), true, "新画面出字 → 就绪");
    // 再换一只空实例：计数不因「上一只出过字」而白涨（实例换了就重新等）
    const beforeEpoch = 1;
    api.setTerm(blankTerm);
    assert.equal(api.ready({ contentEpochAtPark: beforeEpoch }), false, "新实例空屏 → 仍未就绪");
  });

  it("真跑：换绑期上限放宽到 6s，普通切页签仍是 2s", async () => {
    // 放宽的正当性：垫片永远是**同一条会话**的旧帧（/switch 换进程不换身份），
    // 不违反 2026-10-27 「宁可短暂空白也不长时间显示别的会话」那条裁决。
    // 断言读的是登记进时钟的延时值，不是「推多久才撤」——手动时钟一冲就把所有定时器
    // 跑完，2s 与 6s 在那里没有区别。
    const plainMax = Number(/TERMINAL_STALE_SCREEN_MAX_MS = (\d+)/.exec(panelJs)[1]);
    const switchMax = Number(/TERMINAL_SWITCH_STALE_SCREEN_MAX_MS = (\d+)/.exec(panelJs)[1]);
    assert.equal(plainMax, 2000, "普通切页签维持 2s");
    assert.equal(switchMax, 6000, "换绑放宽到 6s");

    // 普通切页签：没有 /switch 在飞、也没有占位武装
    const w = makeTerminalWorld();
    await primeSession(w, terminalSession("A"));
    w.world.parkTerminalScreen();
    assert.deepEqual(w.clock.timerDelays(), [plainMax], "普通档：兜底登记 2000ms");

    // 换绑期（/switch 在飞，且飞的就是这条会话）
    const w2 = makeTerminalWorld();
    await primeSession(w2, terminalSession("A"));
    w2.world.setSwitchInFlight(true, "A");
    w2.world.parkTerminalScreen();
    assert.deepEqual(w2.clock.timerDelays(), [switchMax], "本会话换绑在飞：兜底登记 6000ms");

    // 换绑已落地、占位还武装着（/switch 回来了但新会话还没出字）——占位是本会话的
    const w3 = makeTerminalWorld();
    await primeSession(w3, terminalSession("A"));
    w3.world.setBooting({ sessionId: "A" });
    w3.world.parkTerminalScreen();
    assert.deepEqual(w3.clock.timerDelays(), [switchMax], "本会话的占位武装中：同样按 6000ms");

    // 别人的占位/在飞一律不放宽（2026-11-05 评审 major）：terminalBooting 是单例，
    // 新建页签会武装自己的占位并靠 TTL 自然过期；不按会话判，此刻切到旧页签就会让
    // **另一条会话**的旧帧盖 6 秒，正是 2026-10-27 明令禁止的形态。
    const w4 = makeTerminalWorld();
    await primeSession(w4, terminalSession("A"));
    w4.world.setBooting({ sessionId: "B" });
    w4.world.parkTerminalScreen();
    assert.deepEqual(w4.clock.timerDelays(), [plainMax], "别的会话的占位：仍走 2000ms");

    const w5 = makeTerminalWorld();
    await primeSession(w5, terminalSession("A"));
    w5.world.setSwitchInFlight(true, "B");
    w5.world.parkTerminalScreen();
    assert.deepEqual(w5.clock.timerDelays(), [plainMax], "别的会话在换绑：同样 2000ms");

    // 五只世界都照旧会在到点时撤（放宽不是取消）
    w.clock.flushAll();
    w2.clock.flushAll();
    w3.clock.flushAll();
    w4.clock.flushAll();
    w5.clock.flushAll();
    assert.equal(w.world.stale(), null, "普通档到点撤");
    assert.equal(w2.world.stale(), null, "换绑档到点也撤（不把旧帧永久留屏）");
    assert.equal(w3.world.stale(), null, "占位撤了之后同样退回既有三态");
    assert.equal(w4.world.stale(), null, "别人的占位不放宽，到点照撤");
    assert.equal(w5.world.stale(), null, "别人的换绑不放宽，到点照撤");
  });

  it("真跑：/switch 在飞时兜底到点只续窗，不撤出纯底色；续窗用尽后强制撤", async () => {
    // 2026-11-05 重审 major：6s 是从 POST **之前**的 park 起算的，而 /switch 自身要
    // 6~12s；「正在加载」占位是 POST 落地之后才武装。第一窗到点就撤，屏上既没有旧帧
    // 也没有占位，正是要消灭的那块空白。到点续窗等落地，但必须有上限——POST 永不
    // 落地（宿主卡死）时不能把一屏旧画面永久留在屏上。
    const switchMax = Number(/TERMINAL_SWITCH_STALE_SCREEN_MAX_MS = (\d+)/.exec(panelJs)[1]);
    const maxRenewals = Number(/TERMINAL_SWITCH_STALE_SCREEN_MAX_RENEWALS = (\d+)/.exec(panelJs)[1]);
    assert.ok(Number.isInteger(maxRenewals) && maxRenewals > 0, "续窗上限是个正的常数");

    const w = makeTerminalWorld();
    const { term: termA } = await primeSession(w, terminalSession("A"));
    w.world.setSwitchInFlight(true, "A");
    w.world.parkTerminalScreen();
    assert.deepEqual(w.clock.timerDelays(), [switchMax], "首窗按换绑档登记");

    w.clock.fireOldestTimer();
    assert.notEqual(w.world.stale(), null, "第一窗到点：POST 还没落地，垫片不撤");
    assert.equal(termA.disposed, false, "旧帧仍盖着，没有露出纯底色");
    assert.deepEqual(w.clock.timerDelays(), [switchMax], "只续了一窗，且仍是换绑档");

    for (let i = 1; i < maxRenewals; i += 1) {
      w.clock.fireOldestTimer();
      assert.notEqual(w.world.stale(), null, `第 ${i + 1} 窗到点仍只续窗`);
    }
    w.clock.fireOldestTimer();
    assert.equal(w.world.stale(), null, "续窗次数用尽：强制撤，退回既有三态覆盖层");
    assert.equal(termA.disposed, true, "旧实例随之销毁");
    assert.equal(w.clock.pendingTimers(), 0, "不再登记新的兜底计时器");

    // 别人的会话在飞：既不放宽也不续窗（会话 id 对不上就按普通档，宁可早点撤）
    const w2 = makeTerminalWorld();
    await primeSession(w2, terminalSession("A"));
    w2.world.setSwitchInFlight(true, "B");
    w2.world.parkTerminalScreen();
    w2.clock.fireOldestTimer();
    assert.equal(w2.world.stale(), null, "别人的 /switch 在飞不给这条会话续窗");
  });

  it("真跑：/switch 落地后下一窗到点即撤，让「正在加载」占位露出来", async () => {
    // 续窗只认「在飞」，不认第二个信号（占位已武装）：占位武装说明 POST 落地了，
    // 那一拍正该撤垫片让占位露出来，继续盖着会把占位一直闷在旧帧底下。
    const w = makeTerminalWorld();
    const { term: termA } = await primeSession(w, terminalSession("A"));
    w.world.setSwitchInFlight(true, "A");
    w.world.parkTerminalScreen();
    w.clock.fireOldestTimer();
    assert.notEqual(w.world.stale(), null, "前置：第一窗续上了");
    w.world.setSwitchInFlight(false, null);
    w.world.setBooting({ sessionId: "A" });
    w.clock.fireOldestTimer();
    assert.equal(w.world.stale(), null, "落地后不再续窗，到点撤");
    assert.equal(termA.disposed, true);
  });

  it("真跑：新画面迟迟不来时兜底撤垫片（不把旧画面永久留在屏上）", async () => {
    const w = makeTerminalWorld();
    const { term: termA } = await primeSession(w, terminalSession("A"));
    w.world.parkTerminalScreen();
    await w.world.connectTerminalStream(terminalSession("B"));
    // 只推进 rAF，不放任何 SSE 帧
    for (let i = 0; i < 6; i += 1) w.clock.flushFrames();
    assert.notEqual(w.world.stale(), null, "只跑帧不撤垫片");
    assert.ok(w.clock.pendingTimers() >= 1, "兜底计时器在册");
    w.clock.flushAll();
    assert.equal(w.world.stale(), null, "兜底计时器到点撤垫片");
    assert.equal(termA.disposed, true);
  });

  it("真跑：视图隐藏时不停放、不建实例（隐藏期不建流不测量）", async () => {
    const w = makeTerminalWorld();
    const { term: termA } = await primeSession(w, terminalSession("A"));
    w.ctx.hidden = true;
    assert.equal(w.world.parkTerminalScreen(), null, "隐藏期不停放");
    assert.equal(termA.disposed, false, "也不拆旧实例");
    assert.equal(termA.classes.has("terminal-stale-frame"), false, "不打垫片类");
    await w.world.connectTerminalStream(terminalSession("B"));
    assert.equal(w.created.length, 1, "视图隐藏时一个新实例都不建");
  });

  it("真跑：后台期间兜底计时器不撤垫片，切回后新画面一有字就揭幕", async () => {
    const w = makeTerminalWorld();
    const { term: termA } = await primeSession(w, terminalSession("A"));
    // visibilitychange 里拆流前的那一停
    w.world.parkTerminalScreen();
    assert.ok(termA.classes.has("terminal-stale-frame"), "垫片就位");
    w.ctx.docHidden = true;
    w.clock.flushAll();
    assert.notEqual(w.world.stale(), null, "窗口在后台：兜底计时器不撤垫片");
    // 切回前台：先按 renderTerminalPreviewSession 的顺序建流（停放发现无可停的画面）
    w.ctx.docHidden = false;
    w.world.parkTerminalScreen();
    assert.notEqual(w.world.stale(), null, "无可停的画面时不撤已有垫片");
    await w.world.connectTerminalStream(terminalSession("B"));
    w.sources[w.sources.length - 1].emit("snapshot", JSON.stringify({ pid: 2, cols: 120, rows: 34 }));
    w.sources[w.sources.length - 1].emit("data", JSON.stringify("B-screen\n"));
    w.clock.flushAll();
    assert.equal(termA.disposed, true, "新画面画出内容后揭幕");
    assert.equal(w.world.stale(), null);
  });
});

/* ============================================================
   T12 · 换绑前先停帧 + exit 帧消费（2026-11-05 A1/A2）
   ============================================================ */
describe("T12 换绑前停帧、退出帧落地", () => {
  it("源码：POST /switch 之前先停帧（清屏字节先到旧实例，停晚了只能停到空白）", () => {
    const decide = extractFn("terminalRailSwitchOrCreateCore");
    const parkAt = decide.indexOf('if (typeof parkTerminalScreen === "function") parkTerminalScreen();');
    const postAt = decide.indexOf("/switch`");
    assert.ok(parkAt >= 0, "换绑前有一次停放");
    assert.ok(postAt > parkAt, "停放排在 POST 之前（反了就等于停到一张刚被清空的图）");
    // render 里那次停放置于 POST 之后仍保留：此刻 terminalXterm 已是 null，走幂等空转
    assert.match(extractFn("renderTerminalPreviewSession"), /parkTerminalScreen\(\)/);
  });

  it("源码：换绑期判据复用既有两个信号，不新起状态位", () => {
    const fn = extractFn("terminalSwitchStaleWidened");
    assert.match(fn, /terminalSwitchInFlight/, "/switch 在飞");
    assert.match(fn, /terminalBooting/, "已落地且「正在加载」占位还武装着（armTerminalBootingOverlay 同一标记）");
    // 上限放宽只作用在垫片兜底计时器上，不改判据
    assert.match(extractFn("parkTerminalScreen"), /TERMINAL_SWITCH_STALE_SCREEN_MAX_MS/);
    assert.doesNotMatch(extractFn("terminalStaleScreenReady"), /terminalSwitchStaleWidened/);
  });

  it("源码：换绑期上限放宽必须绑会话，不许被别人的占位/在飞顶走", () => {
    // 2026-11-05 评审 major：terminalBooting 是单例、在飞原本只是布尔。不比对会话 id，
    // 新建页签武装的占位会让别的会话的旧帧也拿到 6s 档——屏上是另一条会话盖 6 秒，
    // 正是 2026-10-27 明令禁止的形态。放宽档的正当性只建立在「同一会话」上。
    const fn = extractFn("terminalSwitchStaleWidened");
    assert.match(fn, /terminalSwitchBooting|terminalBooting\.sessionId/, "占位按会话 id 比");
    assert.match(fn, /terminalSwitchInFlightSessionId/, "在飞要记是哪条会话");
    assert.match(fn, /if \(!sessionId\) return false/, "拿不到会话 id 一律普通档");
    // 停放处必须在拆流之前取会话 id：closeTerminalStream 会把定投会话归零
    const park = extractFn("parkTerminalScreen");
    const idAt = park.indexOf("parkSessionId");
    const closeAt = park.indexOf("closeTerminalStream()");
    assert.ok(idAt >= 0 && closeAt > idAt, "会话 id 在拆流之前取（之后取恒为 null）");
    assert.match(park, /terminalSwitchStaleWidened\(parkSessionId\)/, "判据收到会话 id");
  });

  it("源码：/switch 失败出口恢复旧流；switch_busy 由切换态接住到 B 落地", () => {
    // 2026-11-05 评审 blocker：进函数时为了先停帧已经拆了流。2026-11-07 起拆流提前到
    // 点击当拍（enterTerminalSwitchLoading），失败恢复走 abortTerminalSwitchLoading：撤
    // 加载层＋被动重挂宿主镜像。switch_busy 不重挂 A——视口马上换成 B，A 的旧画面闪
    // 一帧反而错；切换态继续盖着，B 失败时由 createAgentTerminal 的 catch 兜底恢复。
    const fn = extractFn("terminalRailSwitchOrCreateCore");
    const resumeAt = fn.indexOf("const resumeStream = () =>");
    assert.ok(resumeAt >= 0, "失败路径有重挂入口");
    assert.match(fn, /renderTerminalPreviewSession\(\{ revive: false \}\)/, "被动重挂：不替用户重启进程");
    assert.match(fn, /abortTerminalSwitchLoading\(\)/, "切换态在飞先撤层再重挂，一条龙恢复");
    const busyAt = fn.indexOf('code === "switch_busy"');
    const busyReturn = fn.indexOf("return terminalRailKeepAliveSwitch(", busyAt);
    assert.ok(busyAt >= 0 && busyReturn > busyAt, "switch_busy 出口存在");
    assert.equal(fn.slice(busyAt, busyReturn).includes("resumeStream();"), false,
      "switch_busy 不重挂 A 的流（切换态继续盖到 B 落地，A 的旧帧不闪回）");
    // 在飞闸在转保活之前清掉：B 挂载那次 park 不再命中「这条会话在换绑」放宽档。
    const clearFlag = fn.indexOf("terminalSwitchInFlight = false;", busyAt);
    const clearId = fn.indexOf("terminalSwitchInFlightSessionId = null;", busyAt);
    assert.ok(clearFlag > busyAt && clearFlag < busyReturn, "转保活前清在飞闸");
    assert.ok(clearId > clearFlag && clearId < busyReturn, "会话 id 一并清掉");
    // B 的 POST 失败出口必须兜底恢复，否则切换态一直盖到 30s 兜底才撤。
    assert.match(extractFn("createAgentTerminal"), /abortTerminalSwitchLoading\(\)/,
      "B 的 POST 失败：撤层并重挂 A 的流");
    // 两条 toast 出口各自「先提示、后重挂」；switch_busy 不提示。
    assert.match(
      fn,
      /"这个 Agent 的会话暂时不能在终端里续接", true\);\s*resumeStream\(\);/,
      "resume-* 分支：toast 之后重挂",
    );
    assert.match(
      fn,
      /toast\(panelError\(error, "无法启动这个终端"\), true\);\s*resumeStream\(\);/,
      "兜底分支：toast 之后重挂",
    );
    assert.equal((fn.match(/resumeStream\(\)/g) || []).length, 2, "恰好两处调用（switch_busy 不再重挂 A）");
  });

  it("真跑：空屏收到 exit 帧 → 只翻状态位，不挂任何覆盖层（会话级退出提示待文案批准）", async () => {
    const w = makeTerminalWorld();
    const session = terminalSession("S");
    await w.world.connectTerminalStream(session);
    const es = w.sources[w.sources.length - 1];
    es.emit("snapshot", JSON.stringify({ pid: 1, cols: 120, rows: 34 }));
    // 只来了一帧清屏，屏上仍没有字
    es.emit("data", JSON.stringify("\u001b[0m\u001b[2J\u001b[H"));
    w.clock.flushFrames();
    assert.equal(w.created[0].screenText, "", "前置：屏上确实什么都没有");
    assert.equal(w.world.unavailableRenders(), 0, "退出之前不落卡片");
    es.emit("exit", "{}");
    // 2026-11-05 评审 major：宿主级降级页会把全部页签清空、藏底栏、禁新建键，而服务
    // 明明在跑——一个会话退出绝不能触发它。会话级提示需要新措辞，文案批准前不做。
    assert.equal(w.world.unavailableRenders(), 0, "空屏退出也不挂宿主级降级页（服务在跑）");
    assert.equal(session.backendState.status, "exited", "状态位仍翻成 exited（1s 轮询之外的第二条感知）");
    assert.equal(w.created[0].disposed, false, "不动实例（页签保留，停在最后一帧）");
  });

  it("真跑：有内容收到 exit 帧 → 什么都不动（最后一帧就是用户要的现场）", async () => {
    const w = makeTerminalWorld();
    const session = terminalSession("S");
    await w.world.connectTerminalStream(session);
    const es = w.sources[w.sources.length - 1];
    es.emit("snapshot", JSON.stringify({ pid: 1, cols: 120, rows: 34 }));
    es.emit("data", JSON.stringify("ERROR: build failed\n"));
    w.clock.flushFrames();
    assert.ok(w.created[0].screenText.includes("ERROR"), "前置：屏上有内容");
    es.emit("exit", "{}");
    assert.equal(w.world.unavailableRenders(), 0, "有内容不盖卡片（不遮掉最后一屏）");
    assert.equal(session.backendState.status, "exited", "状态位翻成 exited（轮询之外的即时真值）");
    assert.equal(w.world.pending(), false, "回放闩一并收掉");
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
      "updateSessBatchBar", "toast", "panelError", "$", "setSessSessions", "currentView",
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
      () => null,
      (list) => { state.sessions = list; },
      "terminal",
    );
    return { run, seen, state, calls, seqOf: () => seq };
  }

  it("源码：refreshSessionsList 收 force 选项并把 refresh=1 拼进 URL", () => {
    const src = extractFn("refreshSessionsList");
    assert.match(src, /async function refreshSessionsList\(\{ force = false \} = \{\}\)/);
    assert.match(src, /\/api\/sessions\/list\$\{force \? "\?refresh=1" : ""\}/);
  });

  it("源码：刷新按钮传 force=true，自动路径零参——调用点逐一位置绑定", () => {
    // 全文只许这两个调用点，且各归其位：自动路径必须零参、留在服务端 TTL 快照窗口内
    // 复用；force 只属于刷新钮的 click handler——挂在自动路径上会让每次进页都触发一次
    // 真扫描（refreshSessionsList 定义处明写的纪律）。纯存在性断言分辨不出 force 挂在
    // 哪个调用点，故按「全文数量 + 所在函数」双重钉住。
    const callSites = panelJs.match(/refreshSessionsList\((\{[^}]*\})?\)/g) || [];
    assert.deepEqual(
      callSites,
      ["refreshSessionsList()", "refreshSessionsList({ force: true })"],
      "全文件只有自动路径零参与刷新钮带 force 两个调用点（定义行的形参不在其列）",
    );
    const enter = extractFn("enterSessionsView");
    assert.match(enter, /refreshSessionsList\(\)/, "首次装载等自动路径零参调用");
    assert.doesNotMatch(enter, /refreshSessionsList\(\s*\{/, "自动路径不携带任何选项");
    assert.match(
      extractFn("initSessionsTab"),
      /sessRefreshBtn[\s\S]{0,200}refreshSessionsList\(\{ force: true \}\)/,
      "force 绑定在刷新钮的 click handler 里，不落在别的调用点",
    );
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

/* ============================================================
   T8 · 列宽变化后的整屏重对齐
   ============================================================ */
// 病灶：TUI 全程只做「定位光标 + 写字符」，从不发擦除序列（本机实测 12 万字符的
// 实时字节里 EL/ED 计数为 0）。列宽一变，它只重画自己认为变了的格子，旧列宽的行
// 就原地留成残行。客户端不重排已折行的内容，所以只能靠重建流拿一次镜像整屏自绘帧
// 来抹。本组钉四件事：首连不误判、变化只重建一次、被动重对齐不重开进程、拆流清账。
describe("T8 列宽变化：残行靠镜像整屏自绘抹掉", () => {
  function makeReflowWorld({ hiddenView = false, es = {}, term = { cols: 120, rows: 30 }, session = { id: "s1", backend: true, backendState: { cols: 120, rows: 30 } } } = {}) {
    const clock = makeClock();
    const calls = [];
    const st = { session };
    // 常量取值收在工厂里（同 makeTerminalWorld 的 staleConst、73-79 行的 TTL 纪律）：
    // 这条常量还不存在时红在用到它的各条用例上，而不是炸在 describe 求值期、把整组
    // T8 用例从计数里静默带走。
    const reflowConst = panelJs.match(/const TERMINAL_REFLOW_REPAINT_DELAY_MS = \d+;/)?.[0];
    assert.ok(reflowConst, "TERMINAL_REFLOW_REPAINT_DELAY_MS 在 panel.js 里");
    const factory = new Function(
      "$", "setTimeout", "clearTimeout", "connectTerminalStream", "terminalSessionFor", "initial",
      `
      let terminalEventSource = initial.es;
      let terminalXterm = initial.term;
      let terminalBoundSessionId = "s1";
      let terminalReflowRepaintTimer = null;
      let terminalSettledCols = 0;
      let terminalReflowRepaintMuteUntil = 0;
      ${reflowConst}
      ${extractFn("resetTerminalReflowRepaint")}
      ${extractFn("noteTerminalFittedCols")}
      ${extractFn("armTerminalReflowRepaint")}
      ${extractFn("runTerminalReflowRepaint")}
      return {
        noteTerminalFittedCols, resetTerminalReflowRepaint,
        pending: () => terminalReflowRepaintTimer,
      };
      `
    );
    const api = factory(
      (id) => (id === "terminalView" ? { hidden: hiddenView } : null),
      clock.setTimeout, clock.clearTimeout,
      (s, opts) => { calls.push({ id: s?.id, opts }); },
      () => st.session,
      { es, term },
    );
    return { api, clock, calls, st, term };
  }

  it("首连 fit 不算列宽变化：建流那次 fit 之后不重建", () => {
    const w = makeReflowWorld();
    w.api.noteTerminalFittedCols(135);
    w.clock.flushAll();
    assert.equal(w.calls.length, 0, "新实例从出厂 80 列 fit 到真实宽度属于建流");
  });

  it("列宽变化后重建一次，且是被动重对齐（revive:false）", () => {
    const w = makeReflowWorld();
    w.api.noteTerminalFittedCols(135);
    w.clock.flushAll();
    assert.equal(w.calls.length, 0, "先建立基准");
    w.api.noteTerminalFittedCols(120);
    w.clock.flushAll();
    assert.equal(w.calls.length, 1, "列宽变了就重建一次");
    assert.equal(w.calls[0].id, "s1");
    assert.deepEqual(w.calls[0].opts, { revive: false }, "被动重对齐不许替用户重开已退的进程");
  });

  it("连续变化只重建一次（防抖合并）", () => {
    const w = makeReflowWorld();
    w.api.noteTerminalFittedCols(135);
    w.clock.flushAll();
    w.api.noteTerminalFittedCols(130);
    w.api.noteTerminalFittedCols(125);
    w.api.noteTerminalFittedCols(120);
    w.clock.flushAll();
    assert.equal(w.calls.length, 1, "拖动窗口逐帧来，合并到静默期一次");
  });

  it("PTY 侧还没跟上就继续等，不让镜像按旧列宽自绘", () => {
    const w = makeReflowWorld({ session: { id: "s1", backend: true, backendState: { cols: 135, rows: 30 } } });
    w.api.noteTerminalFittedCols(135);
    w.clock.flushAll();
    w.api.noteTerminalFittedCols(120);
    w.clock.flushAll();
    assert.equal(w.calls.length, 0, "两边尺寸不一致时重建只会把残行原样画一遍");
    w.st.session.backendState = { cols: 120, rows: 30 };
    w.clock.flushAll();
    assert.equal(w.calls.length, 1, "对齐之后才重建");
  });

  it("终端页隐藏 / 没有活流时不重建", () => {
    const hidden = makeReflowWorld({ hiddenView: true });
    hidden.api.noteTerminalFittedCols(135);
    hidden.clock.flushAll();
    hidden.api.noteTerminalFittedCols(120);
    hidden.clock.flushAll();
    assert.equal(hidden.calls.length, 0, "隐藏期没有可看的画面");

    const idle = makeReflowWorld({ es: null });
    idle.api.noteTerminalFittedCols(135);
    idle.clock.flushAll();
    idle.api.noteTerminalFittedCols(120);
    idle.clock.flushAll();
    assert.equal(idle.calls.length, 0, "没有活流就没有残行可言");
  });

  it("接线：fit 里的列宽记账排在「尺寸已对齐」早退之前，拆流时会清账", () => {
    const fit = extractFn("fitTerminalXterm");
    const noteAt = fit.indexOf("noteTerminalFittedCols");
    const earlyAt = fit.indexOf("backendSize.cols === terminalXterm.cols");
    assert.ok(noteAt > 0, "fit 里接线了列宽记账");
    assert.ok(earlyAt > noteAt, "记账必须先于同值闸早退——残行最容易留在「客户端已变、PTY 还没跟上」那一拍");
    const close = extractFn("closeTerminalStream");
    assert.ok(close.includes("resetTerminalReflowRepaint"), "拆流时撤销待办并把基准归零");
  });

  it("拆流时清账：待办定时器撤销，且基准归零", () => {
    const w = makeReflowWorld();
    w.api.noteTerminalFittedCols(135);
    w.clock.flushAll();
    w.api.noteTerminalFittedCols(120);
    assert.ok(w.api.pending() !== null, "变化后有待办");
    w.api.resetTerminalReflowRepaint();
    assert.equal(w.api.pending(), null, "拆流撤销待办");
    w.clock.flushAll();
    assert.equal(w.calls.length, 0, "撤销后不再重建");
  });
});

/* ============================================================
   T10 · 建连：fit 发出的 resize POST 落定后才开流
   ============================================================ */
// SSE 首帧回放按宿主镜像的「当前尺寸」算。建连路径里 fit 的 resize POST 是异步
// 落地的：不等它就开流，POST 与 GET 竞速——回放可能按旧尺寸算、客户端按新尺寸
// 渲染，两边尺寸一旧一新，画面整体错位。这里用可控 deferred 钉住时序：
// POST 在飞 → EventSource 不得创建；落定 → 才创建。返回 null（同尺寸没发 POST）
// 则零等待直开——正常路径不因这条等待多付一个来回。
describe("T10 建连：fit 的 resize POST 落定后再开流", () => {
  it("fit 在飞时不开 EventSource，落定后才开", async () => {
    let releaseFit;
    const fitInFlight = new Promise((resolve) => { releaseFit = resolve; });
    let fitCalls = 0;
    const w = makeTerminalWorld({ fitImpl: () => { fitCalls += 1; return fitInFlight; } });
    const connectPromise = w.world.connectTerminalStream(terminalSession("S"));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fitCalls, 1, "前置：fit 已发出（POST 在飞）");
    assert.equal(w.sources.length, 0, "resize POST 在飞：SSE 还没开流");
    releaseFit();
    await connectPromise;
    assert.equal(w.sources.length, 1, "POST 落定后才开流");
  });

  it("fit 返回 null（同尺寸没发 POST）：不等待，当拍开流", async () => {
    const w = makeTerminalWorld({ fitImpl: () => null });
    const connectPromise = w.world.connectTerminalStream(terminalSession("S"));
    // 零等待的可观测形态：这条路径上（revive 分支未走、resizeInFlight 为 null）从
    // 函数入口到 EventSource 创建之间没有任何 await——async 函数首次挂起前全程
    // 同步，调用一返回流就应已开出。放在 await 之后再断言，多付任意一拍它都照样
    // 绿，钉不住「不因这条等待多付一个来回」，故同步即断言。
    assert.equal(w.sources.length, 1, "无 POST 可等：调用当拍直开，一个微任务都不多付");
    await connectPromise;
  });
});

/* ============================================================
   T11 「正在加载」占位：挂层排在新实例建好之后，撤层认出画
   ============================================================ */
// 病灶（2026-11-02 用户报告的内切错位）：占位在上一屏还没擦时就挂上了，叠在终端
// 画面上；等旧画面被擦掉、新会话还在启动那段，它又已经撤走，剩一整段空屏。两条
// 判据各反了一面，本组逐面钉住：
//   · 挂层：武装本身不碰 DOM（点击当拍不能上屏），sync 之后占位压在垫片之下
//     （z-index 0 < 1，见 CSS 断言），旧帧还在时它不露脸；
//   · 撤层：数据帧不再是判据（换绑清屏帧、空回放、TUI 清屏序列都是数据帧），只有
//     「活跃实例缓冲区真的有字」才撤；3 秒上限仍在，防永久挂着。
describe("T11 「正在加载」占位：只在旧屏已擦、新屏未出字那一段露脸", () => {
  // 真跑 arm/drop/sync/watch 四个真身 + 内容判据，只把 $ / document / rAF / 定时器
  // 与「现在」替成桩：断言只锚 DOM 存在性与帧序列，不锚任何墙钟。
  function makeOverlayWorld() {
    const clock = makeClock();
    const screen = {
      children: [],
      appendChild(node) { node.parentNode = screen; screen.children.push(node); return node; },
      removeChild(node) {
        node.parentNode = null;
        screen.children = screen.children.filter((c) => c !== node);
        return node;
      },
    };
    const factory = new Function(
      "$", "document", "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "Date",
      `
      let terminalXterm = null;
      const TERMINAL_BOOTING_MAX_MS = 3000;
      const TERMINAL_BOOTING_ARM_TTL_MS = 10000;
      let terminalBooting = null;
      ${extractFn("terminalScreenHasContent")}
      ${extractFn("armTerminalBootingOverlay")}
      ${extractFn("dropTerminalBootingOverlay")}
      ${extractFn("watchTerminalBootingOverlay")}
      ${extractFn("syncTerminalBootingOverlay")}
      return {
        arm: armTerminalBootingOverlay,
        drop: dropTerminalBootingOverlay,
        sync: syncTerminalBootingOverlay,
        booting: () => terminalBooting,
        setTerm: (t) => { terminalXterm = t; },
      };
      `
    );
    let now = 1_000_000;
    const world = factory(
      (id) => (id === "terminalScreen" ? screen : null),
      { createElement: () => ({ className: "", innerHTML: "", parentNode: null }) },
      clock.requestAnimationFrame, clock.cancelAnimationFrame, clock.setTimeout, clock.clearTimeout,
      { now: () => now },
    );
    return { world, clock, screen, advance: (ms) => { now += ms; } };
  }

  // 内容判据的输入：只有第一行有字，其余行空（与真 xterm 一开屏就有 rows 行空行
  // 的形状一致——判据必须逐行看内容，不能数行数）。
  function termWith(text) {
    return {
      rows: 4,
      buffer: {
        active: {
          length: 4,
          viewportY: 0,
          getLine: (y) => ({ translateToString: () => (y === 0 ? text : "") }),
        },
      },
    };
  }

  it("武装不碰 DOM：点击当拍屏上不多任何东西（旧屏还在，那一段不能挂）", () => {
    const w = makeOverlayWorld();
    w.world.arm("t-old");
    assert.equal(w.screen.children.length, 0, "武装只记意图");
    assert.equal(w.world.booting().sessionId, "t-old", "意图锚在这条会话上");
  });

  it("sync 只给武装的那个会话挂层；换成别的会话即撤（用户在占位期点了别的页签）", () => {
    const w = makeOverlayWorld();
    w.world.arm("t-old");
    w.world.sync("t-new");
    assert.equal(w.screen.children.length, 0, "不是武装的会话：不挂，且把武装撤掉");
    assert.equal(w.world.booting(), null);
    w.world.arm("t-old");
    w.world.sync("t-old");
    assert.equal(w.screen.children.length, 1, "武装的会话挂一层");
    assert.equal(w.screen.children[0].className, "terminal-booting");
    assert.match(w.screen.children[0].innerHTML, /正在加载/, "沿用既有文案，零新增");
  });

  it("空屏会话：空回放/清屏之后不撤，新画面出字那一帧才撤", () => {
    const w = makeOverlayWorld();
    w.world.arm("t-x");
    w.world.sync("t-x");
    w.world.setTerm(termWith(""));
    for (let i = 0; i < 5; i += 1) w.clock.flushFrames();
    assert.equal(w.screen.children.length, 1,
      "缓冲区里没有字就不撤——旧判据「任意数据帧落地即撤」在这一步就撤走了，正是那段空屏");
    w.world.setTerm(termWith("Claude Code"));
    w.clock.flushFrames();
    assert.equal(w.screen.children.length, 0, "新画面出字即撤");
    assert.equal(w.world.booting(), null, "武装一并收掉");
    assert.equal(w.clock.pendingFrames(), 0, "帧循环不空转");
  });

  it("一直不出字也不永久挂着：3 秒上限兜底撤层", () => {
    const w = makeOverlayWorld();
    w.world.arm("t-x");
    w.world.sync("t-x");
    w.world.setTerm(termWith(""));
    for (let i = 0; i < 5; i += 1) w.clock.flushFrames();
    assert.equal(w.screen.children.length, 1, "帧推进不会撤（判据没成立）");
    w.clock.flushAll();
    assert.equal(w.screen.children.length, 0, "兜底计时器到点撤层");
    assert.equal(w.world.booting(), null);
  });

  it("陈旧武装不挂到后来的重建上：超 10 秒的 sync 直接作废", () => {
    const w = makeOverlayWorld();
    w.world.arm("t-x");
    w.advance(10001);
    w.world.sync("t-x");
    assert.equal(w.screen.children.length, 0, "过期武装不挂层");
    assert.equal(w.world.booting(), null, "过期即清");
  });

  it("源码/CSS：占位压在垫片之下（旧帧还在时不露脸），且不参与布局、不吞指针", () => {
    const rule = panelCss.match(/\.terminal-booting \{[\s\S]*?\}/)?.[0] || "";
    assert.match(rule, /position: absolute/);
    assert.match(rule, /inset: 0/);
    assert.match(rule, /pointer-events: none/);
    assert.match(rule, /z-index: 0/);
    const stale = panelCss.match(/\.terminal-xterm-host \.xterm\.terminal-stale-frame \{[\s\S]*?\}/)?.[0] || "";
    assert.match(stale, /z-index: 1/, "垫片压在上面：占位等同层就叠到终端画面上了");
  });

  it("源码：挂层点在 render 的建流之后，data 处理器不再撤层", () => {
    const render = extractFn("renderTerminalPreviewSession");
    const connects = [...render.matchAll(/connectTerminalStream\(session, \{ revive \}\);/g)].map((m) => m.index);
    const syncs = [...render.matchAll(/syncTerminalBootingOverlay\(session\.id\)/g)].map((m) => m.index);
    assert.equal(syncs.length, 2, "两条切换路径各同步一次");
    assert.ok(syncs[0] > connects[0] && syncs[1] > connects[1], "挂层排在建流之后");
    const data = extractFn("connectTerminalStream");
    assert.equal(data.includes("dropTerminalBootingOverlay"), false, "数据帧不是撤层判据");
  });
});

/* ============================================================
   T12 内切切换态：点击当拍擦屏，等待整段收进加载态
   ============================================================ */
// 左栏高亮是点击当拍的，中间屏却要等补读两拍＋进程探测＋PTY 重启（/switch 实测
// 6~12s）才擦。旧行为让这整段继续显示上一条会话的画面（切换垫片特意留的旧帧），
// 于是「点了没反应」。本组钉住：擦屏与高亮同拍、等待期是加载态、POST 落地交接、
// 失败/超时恢复、零新增前端文案。
describe("T12 内切切换态：点击当拍擦屏，等待整段收进加载态", () => {
  function makeSwitchLoadingWorld() {
    const clock = makeClock();
    const screen = {
      children: [],
      appendChild(node) { node.parentNode = screen; screen.children.push(node); return node; },
      removeChild(node) {
        node.parentNode = null;
        screen.children = screen.children.filter((c) => c !== node);
        return node;
      },
    };
    const calls = { streams: 0, stale: 0, bootingDrop: 0, renders: [] };
    const factory = new Function(
      "$", "document", "setTimeout", "clearTimeout", "Date", "calls",
      `
      const TERMINAL_SWITCH_LOADING_MAX_MS = 30000;
      let terminalSwitchLoading = null;
      let terminalBooting = null;
      function dropTerminalStaleScreen() { calls.stale += 1; }
      function closeTerminalStream() { calls.streams += 1; }
      function dropTerminalBootingOverlay() { calls.bootingDrop += 1; terminalBooting = null; }
      function renderTerminalPreviewSession(opts) { calls.renders.push(opts); }
      ${extractFn("enterTerminalSwitchLoading")}
      ${extractFn("leaveTerminalSwitchLoading")}
      ${extractFn("abortTerminalSwitchLoading")}
      ${extractFn("armTerminalBootingOverlay")}
      return {
        enter: enterTerminalSwitchLoading,
        leave: leaveTerminalSwitchLoading,
        abort: abortTerminalSwitchLoading,
        arm: armTerminalBootingOverlay,
        state: () => terminalSwitchLoading,
        booting: () => terminalBooting,
      };
      `,
    );
    const world = factory(
      (id) => (id === "terminalScreen" ? screen : null),
      { createElement: () => ({ className: "", innerHTML: "", parentNode: null }) },
      clock.setTimeout, clock.clearTimeout,
      { now: () => 1_000_000 }, calls,
    );
    return { world, clock, screen, calls };
  }

  it("点击当拍：拆流＋撤垫片＋挂一层加载态，等待整段不再显示上一条会话", () => {
    const w = makeSwitchLoadingWorld();
    w.world.enter();
    assert.equal(w.calls.streams, 1, "旧流这一拍拆掉（xterm dispose 后 DOM 随之摘除＝擦屏）");
    assert.equal(w.calls.stale, 1, "旧帧垫片一并撤掉，不留上一屏");
    assert.equal(w.screen.children.length, 1, "屏上落一层加载态");
    assert.equal(w.screen.children[0].className, "terminal-booting");
    assert.deepEqual(w.clock.timerDelays(), [30000], "30s 兜底撑得住 /switch 的 6~12s");
  });

  it("重复进入不叠层、不堆定时器", () => {
    const w = makeSwitchLoadingWorld();
    w.world.enter();
    w.world.enter();
    assert.equal(w.screen.children.length, 1);
    assert.deepEqual(w.clock.timerDelays(), [30000]);
  });

  it("等待期（POST 未落地）加载态不撤：不按帧撤、不按 3s 撤", () => {
    const w = makeSwitchLoadingWorld();
    w.world.enter();
    w.clock.flushFrames();
    assert.equal(w.screen.children.length, 1);
    assert.notEqual(w.world.state(), null);
  });

  it("POST 落地：arm 交接切换层，不残留两层、不残留兜底定时器", () => {
    const w = makeSwitchLoadingWorld();
    w.world.enter();
    w.world.arm("t-new");
    assert.equal(w.screen.children.length, 0, "切换层已撤，普通层由随后的 render→sync 挂");
    assert.equal(w.world.state(), null);
    assert.equal(w.clock.pendingTimers(), 0);
    assert.equal(w.world.booting().sessionId, "t-new", "普通占位层武装在新会话上");
  });

  it("切换失败：撤层并重挂旧流（revive:false 被动重挂），幂等", () => {
    const w = makeSwitchLoadingWorld();
    w.world.enter();
    assert.equal(w.world.abort(), true);
    assert.equal(w.screen.children.length, 0);
    assert.equal(w.world.state(), null);
    assert.deepEqual(w.calls.renders, [{ revive: false }], "宿主镜像回放把上一屏接回来");
    assert.equal(w.clock.pendingTimers(), 0);
    assert.equal(w.world.abort(), false, "没有切换态时不重复重挂");
    assert.equal(w.calls.renders.length, 1);
  });

  it("兜底超时：POST 永不落地也不永久白屏，到点按失败同路恢复", () => {
    const w = makeSwitchLoadingWorld();
    w.world.enter();
    assert.equal(w.clock.fireOldestTimer(), true);
    assert.equal(w.screen.children.length, 0);
    assert.deepEqual(w.calls.renders, [{ revive: false }]);
  });

  it("没有切换态时 arm 行为不变（「+」新建页签 / 一键新建不受影响）", () => {
    const w = makeSwitchLoadingWorld();
    w.world.arm("t-plus");
    assert.equal(w.world.booting().sessionId, "t-plus");
    assert.equal(w.screen.children.length, 0);
  });

  it("零新增前端文案：切换层与既有占位的 HTML 逐字相同", () => {
    const w = makeSwitchLoadingWorld();
    w.world.enter();
    const existing = extractFn("syncTerminalBootingOverlay").match(/el\.innerHTML = `([^`]*)`/)?.[1];
    assert.ok(existing, "既有占位 HTML 在源码里");
    assert.equal(w.screen.children[0].innerHTML, existing, "复用同一句，不另造词");
    assert.match(existing, /正在加载/);
  });

  it("源码：切换态进入排在补读两拍与 POST 之前，两条落点分支都覆盖", () => {
    const decide = extractFn("terminalRailSwitchOrCreateCore");
    const enters = [...decide.matchAll(/enterTerminalSwitchLoading\(\);/g)].map((m) => m.index);
    assert.equal(enters.length, 2, "空壳分支与有活跃终端分支各一次");
    const probe = decide.indexOf('await api("GET", "/api/agents")');
    const post = decide.indexOf("/switch`");
    assert.ok(probe > 0 && post > 0);
    assert.ok(enters[0] < probe, "空壳分支：进入在创建请求之前");
    assert.ok(enters[1] < probe && enters[1] < post, "主分支：进入在补读与换绑请求之前");
  });

  it("源码：switch_busy 转保活不重挂 A 的流（切换态继续盖到 B 落地）", () => {
    const decide = extractFn("terminalRailSwitchOrCreateCore");
    const busy = decide.indexOf('if (code === "switch_busy")');
    const keep = decide.indexOf("return terminalRailKeepAliveSwitch({ agentId, cwd, resume });", busy);
    assert.ok(busy >= 0 && keep > busy);
    assert.equal(decide.slice(busy, keep).includes("resumeStream();"), false,
      "A 的旧画面不闪回一帧；B 失败由 createAgentTerminal 的 catch 兜底恢复");
    assert.match(extractFn("createAgentTerminal"), /abortTerminalSwitchLoading\(\)/,
      "B 的 POST 失败出口会撤层并重挂旧流");
  });
});

