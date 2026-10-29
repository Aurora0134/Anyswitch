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
function makeRailEnv({ history, agentId = "ep-1", view = "terminal", apiImpl } = {}) {
  const clock = makeClock();
  const seen = { api: [], rail: 0, historyRender: [], toast: [] };
  // 可注入的「现在」：退避与 TTL 都是时间闸，测试要么等墙钟（禁止）要么把时钟捏在手里。
  let virtualNow = Date.now();
  const DateStub = { now: () => virtualNow };
  // renderTerminalRail 在真身里会调 syncTerminalRailHistory（9325-9326），桩照此接线，
  // 否则「进页 → 渲一帧 → 判身份」这条链在测试里是断的。工厂建好后再把 sync 填进来。
  const railHook = { sync: null };
  const rendersRail = () => { seen.rail += 1; if (railHook.sync) railHook.sync(agentId); };
  const factory = new Function(
    "api", "toast", "panelError", "currentView", "terminalRailAgentId",
    "terminalRailSessionMap", "renderTerminalRail", "renderTerminalRailHistory",
    "closeTerminalRailSearch", "loadTerminalRailRemovedAt", "loadTerminalRailPrefs",
    "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout",
    "TERMINAL_RAIL_HISTORY_TTL_MS", "TERMINAL_RAIL_HISTORY_RETRY_MS", "Date",
    `
    let terminalRailHistory = ${JSON.stringify({ endpoint: "", sessions: [], fetchedAt: 0, error: null, ...history })};
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

  it("真跑：TTL 内进页一条请求都不发（缓存直接用）", () => {
    const env = makeRailEnv({
      history: { endpoint: "ep-1", sessions: [{ id: "a" }], fetchedAt: Date.now(), error: null },
    });
    env.enterTerminalRail();
    assert.equal(env.seen.rail, 1, "进页先渲一帧");
    env.clock.flushAll();
    assert.deepEqual(env.seen.api, [], "TTL 内不补拉");
    assert.equal(env.snapshot().sessions.length, 1, "缓存行还在（没被清成空表）");
  });

  it("真跑：缓存过期才补拉，且补拉不在进页这一拍上", async () => {
    const env = makeRailEnv({
      history: { endpoint: "ep-1", sessions: [], fetchedAt: Date.now() - railTtl() - 1000, error: null },
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
      history: { endpoint: "ep-1", sessions: [{ id: "a" }], fetchedAt: Date.now() - railTtl() - 1000, error: null },
    });
    env.enterTerminalRail();
    env.clock.flushAll();
    // 请求在飞：行还在（没被清成空表）
    assert.equal(env.snapshot().sessions.length, 1, "复取期间行不清空");
    await Promise.resolve();
    assert.equal(env.snapshot().fetchedAt > Date.now() - railTtl(), true, "落地后刷新时间戳");
  });

  it("真跑：换身份当场清行、同步重拉一次（既有契约）；同身份不排队", () => {
    const env = makeRailEnv({
      history: { endpoint: "ep-old", sessions: [{ id: "old" }], fetchedAt: Date.now(), error: null },
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
      history: { endpoint: "ep-1", sessions: [], fetchedAt: Date.now() - railTtl() - 1000, error: null },
      view: "board",
    });
    env.enterTerminalRail();
    env.clock.flushAll();
    await Promise.resolve();
    assert.deepEqual(env.seen.api, [], "不在终端页就不发请求");
  });

  it("真跑：补拉失败不清行、不弹提示，并按短退避（不是 TTL、不是每秒）允许重试", async () => {
    const env = makeRailEnv({
      history: { endpoint: "ep-1", sessions: [{ id: "a" }, { id: "b" }], fetchedAt: Date.now() - railTtl() - 1000, error: null },
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
    assert.ok(after.retryAt > Date.now(), "失败记下重试闸");
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
  const factory = new Function(
    "$", "EventSource", "API_BASE", "setTimeout", "clearTimeout",
    "requestAnimationFrame", "cancelAnimationFrame", "document",
    "ensureTerminalXterm", "fitTerminalXterm", "sendTerminalInput", "reviveTerminalSession",
    "flushTerminalBurst", "discardTerminalBurst", "queueTerminalChunk",
    "disarmTerminalDprWatch", "nextTerminal",
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
    ${staleConst}
    ${extractFn("closeTerminalStream")}
    ${extractFn("dropTerminalStaleScreen")}
    ${extractFn("terminalScreenHasContent")}
    ${extractFn("terminalStaleScreenReady")}
    ${extractFn("watchTerminalStaleScreen")}
    ${extractFn("revealTerminalStaleScreen")}
    ${extractFn("parkTerminalScreen")}
    ${extractFn("absorbTerminalSnapshot")}
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
    write(data, cb) {
      term.written.push(data);
      log.push(`${id}.write`);
      if (data) term.screenText += String(data);
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
    const parkAt = render.indexOf("parkTerminalScreen();");
    const connectAt = render.indexOf("connectTerminalStream(session, { revive });");
    assert.ok(parkAt > 0, "切换入口调 parkTerminalScreen");
    assert.ok(connectAt > parkAt, "停放排在建流之前");
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

  it("真跑：旧实例的自动应答打不进新会话 PTY（两道闸各测一次）", async () => {
    const w = makeTerminalWorld();
    const { term: termA } = await primeSession(w, terminalSession("A"));
    termA.fireAutoReply("\u001b[?1;2c");
    assert.deepEqual(w.inputPosts, ["A:\u001b[?1;2c"], "切换前应答定投旧会话");

    w.world.parkTerminalScreen();
    await w.world.connectTerminalStream(terminalSession("B"));
    assert.equal(w.world.bound(), "B", "新连接的定投目标已是新会话");
    // 闸一：disableStdin 让内核在产生处早退（桩按同一语义建模）
    termA.fireAutoReply("\u001b[?1;2c");
    assert.deepEqual(w.inputPosts, ["A:\u001b[?1;2c"], "垫片实例的应答没有新增投递");
    // 闸二：onData 监听已随停放摘除——把 disableStdin 硬关掉也派发不到任何投递点
    termA.options.disableStdin = false;
    termA.fireAutoReply("\u001b[?1;2c");
    assert.deepEqual(w.inputPosts, ["A:\u001b[?1;2c"], "监听已摘，旧字节无处可去");
    w.clock.flushAll();
  });

  it("真跑：空屏会话在「首帧回放那一拍」就揭幕——不是靠 2s 兜底", async () => {
    const w = makeTerminalWorld();
    const { term: termA } = await primeSession(w, terminalSession("A"));
    const epochAtPark = w.world.epoch();
    w.world.parkTerminalScreen();
    await w.world.connectTerminalStream(terminalSession("B"));
    assert.equal(w.world.epoch(), epochAtPark, "还没收到首帧：计数没动");
    w.sources[1].emit("snapshot", JSON.stringify({ pid: 2, cols: 120, rows: 34 }));
    // 空屏会话：回放帧是空串，缓冲区里永远没有字，判据 a 不成立
    w.sources[1].emit("data", JSON.stringify(""));
    assert.equal(w.world.epoch(), epochAtPark + 1, "首帧回放那一拍记了数（同帧也算）");
    assert.equal(w.created[1].screenText, "", "新实例缓冲区里一个字都没有");
    // 关键：只推进「帧」，一个定时器都不跑。兜底计时器仍在册 ⇒ 揭幕不可能来自兜底。
    assert.ok(w.clock.pendingTimers() >= 1, "兜底计时器在册");
    assert.equal(termA.disposed, false, "帧推进之前垫片还在");
    w.clock.flushFrames();
    assert.equal(w.clock.stats.timersFired, 0, "全程没有跑过任何定时器（兜底从未参与）");
    assert.equal(termA.disposed, true, "帧一到就揭幕");
  });

  it("判据本身：只有计数变了或真有字才算就绪（删掉计数比较这条必红）", () => {
    const factory = new Function(
      "requestAnimationFrame",
      `
      let terminalReplayEpoch = 0;
      let terminalXterm = null;
      ${extractFn("terminalScreenHasContent")}
      ${extractFn("terminalStaleScreenReady")}
      return {
        ready: terminalStaleScreenReady,
        setEpoch: (v) => { terminalReplayEpoch = v; },
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
    const stale = { epochAtPark: 7 };
    api.setTerm(blankTerm);
    api.setEpoch(7);
    assert.equal(api.ready(stale), false, "计数没动、屏上没字 → 未就绪");
    assert.equal(api.ready(null), false, "没有垫片就不谈就绪");
    api.setEpoch(8);
    assert.equal(api.ready(stale), true, "首帧回放那一拍发生过 → 就绪（空屏会话的全部依据）");
    api.setEpoch(7);
    api.setTerm(filledTerm);
    assert.equal(api.ready(stale), true, "计数没变但屏上有字 → 也就绪");
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

/* ============================================================
   T8 · 列宽变化后的整屏重对齐
   ============================================================ */
// 病灶：TUI 全程只做「定位光标 + 写字符」，从不发擦除序列（本机实测 12 万字符的
// 实时字节里 EL/ED 计数为 0）。列宽一变，它只重画自己认为变了的格子，旧列宽的行
// 就原地留成残行。客户端不重排已折行的内容，所以只能靠重建流拿一次镜像整屏自绘帧
// 来抹。本组钉四件事：首连不误判、变化只重建一次、被动重对齐不重开进程、拆流清账。
describe("T8 列宽变化：残行靠镜像整屏自绘抹掉", () => {
  const reflowConst = panelJs.match(/const TERMINAL_REFLOW_REPAINT_DELAY_MS = \d+;/)?.[0];
  assert.ok(reflowConst, "TERMINAL_REFLOW_REPAINT_DELAY_MS 在 panel.js 里");

  function makeReflowWorld({ hiddenView = false, es = {}, term = { cols: 120, rows: 30 }, session = { id: "s1", backend: true, backendState: { cols: 120, rows: 30 } } } = {}) {
    const clock = makeClock();
    const calls = [];
    const st = { session };
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
    await w.world.connectTerminalStream(terminalSession("S"));
    assert.equal(w.sources.length, 1, "无 POST 可等：直开");
  });
});
