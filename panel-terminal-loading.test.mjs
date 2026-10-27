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
// TTL 从真身源码里读数值（不在测试里另抄一个常数）。取值放在函数里，是让「这条
// 常量还不存在」时红在对应的测试上，而不是炸在模块加载期、把其它钉子一起带走。
function railTtl() {
  const decl = panelJs.match(/const TERMINAL_RAIL_HISTORY_TTL_MS = [^;]+;/)?.[0];
  assert.ok(decl, "TERMINAL_RAIL_HISTORY_TTL_MS 在 panel.js 里");
  return new Function(`${decl}\nreturn TERMINAL_RAIL_HISTORY_TTL_MS;`)();
}

// 真跑 enterTerminalRail / scheduleTerminalRailHistoryFetch / terminalRailHistoryFresh /
// syncTerminalRailHistory / refreshTerminalRailHistory 五个真身，只把网络面（api）与
// 渲染面替成桩：断言落在「发了几条请求、什么时候发」而不是任何墙钟。
function makeRailEnv({ history, agentId = "ep-1", view = "terminal", apiImpl } = {}) {
  const clock = makeClock();
  const seen = { api: [], rail: 0, historyRender: [], toast: [] };
  // renderTerminalRail 在真身里会调 syncTerminalRailHistory（9325-9326），桩照此接线，
  // 否则「进页 → 渲一帧 → 判身份」这条链在测试里是断的。工厂建好后再把 sync 填进来。
  const railHook = { sync: null };
  const rendersRail = () => { seen.rail += 1; if (railHook.sync) railHook.sync(agentId); };
  const factory = new Function(
    "api", "toast", "panelError", "currentView", "terminalRailAgentId",
    "terminalRailSessionMap", "renderTerminalRail", "renderTerminalRailHistory",
    "closeTerminalRailSearch", "loadTerminalRailRemovedAt", "loadTerminalRailPrefs",
    "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout",
    "TERMINAL_RAIL_HISTORY_TTL_MS",
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
    railTtl(),
  );
  env.seen = seen;
  env.clock = clock;
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

  it("真跑：补拉失败不阻断画面、不弹提示（静默留在 TTL 内）", async () => {
    const env = makeRailEnv({
      history: { endpoint: "ep-1", sessions: [{ id: "a" }], fetchedAt: Date.now() - railTtl() - 1000, error: null },
      apiImpl: () => Promise.reject(new Error("HTTP 500")),
    });
    env.enterTerminalRail();
    env.clock.flushAll();
    await Promise.resolve();
    assert.deepEqual(env.seen.toast, [], "背景补拉失败不弹任何提示");
    assert.equal(env.seen.rail >= 2, true, "失败也补渲一帧，画面不被阻断");
    const after = env.snapshot();
    assert.ok(after.error, "失败态记在缓存上");
    assert.ok(after.fetchedAt > 0, "失败也记时间戳——避免每秒轮询变成每秒重试");
    // TTL 内再进一次页：不再发请求（失败不会变成重试风暴）
    env.enterTerminalRail();
    env.clock.flushAll();
    await Promise.resolve();
    assert.equal(env.seen.api.length, 1, "TTL 内不重试");
  });
});


/* ============================================================
   T3/T4 · 切换期不出现纯底色：旧画面留到新画面就绪再换
   ============================================================ */
// 桩世界：真跑 closeTerminalStream / absorbTerminalSnapshot / connectTerminalStream /
// parkTerminalScreen / dropTerminalStaleScreen / watchTerminalStaleScreen /
// revealTerminalStaleScreen 七个真身，只把 xterm 构造、EventSource、post 面替成桩。
// 断言只锚调用序列与 DOM/属性状态，不锚任何墙钟。
function makeTerminalWorld({ hiddenView = false } = {}) {
  const clock = makeClock();
  const log = [];            // 全局调用序列（跨实例）
  const sources = [];
  const inputPosts = [];     // sendTerminalInput 的调用
  const created = [];
  const staleConst = panelJs.match(/const TERMINAL_STALE_SCREEN_MAX_MS = [^;]+;/)?.[0];
  assert.ok(staleConst, "TERMINAL_STALE_SCREEN_MAX_MS 在 panel.js 里");
  const factory = new Function(
    "$", "EventSource", "API_BASE", "setTimeout", "clearTimeout",
    "requestAnimationFrame", "cancelAnimationFrame",
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
    ${staleConst}
    ${extractFn("closeTerminalStream")}
    ${extractFn("dropTerminalStaleScreen")}
    ${extractFn("terminalScreenHasContent")}
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
      openNext() {
        const term = nextTerminal();
        terminalXterm = term;
        return term;
      },
    };
    `
  );
  const ctx = { hidden: hiddenView };
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
    () => openTerm(),
    () => { log.push("fit"); },
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

// 桩实例：buffer.active.length 模拟「解析出内容」；write 带内容时累加（首帧回放落屏），
// 空串写入不动长度（空屏会话）。
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
  return {
    id,
    cols: 120,
    rows: 34,
    options: { disableStdin: false },
    element,
    classes,
    buffer: { active: { length: 1 } },
    written: [],
    disposed: false,
    refreshCalls: 0,
    reset() { log.push(`${id}.reset`); },
    focus() { log.push(`${id}.focus`); },
    refresh() { this.refreshCalls += 1; log.push(`${id}.refresh`); },
    dispose() {
      this.disposed = true;
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
      if (this.options.disableStdin) { log.push(`${id}.reply_blocked`); return; }
      for (const fn of [...listeners]) fn(payload);
    },
    write(data, cb) {
      this.written.push(data);
      log.push(`${id}.write`);
      if (data) this.buffer.active.length = Math.max(this.buffer.active.length, 1 + String(data).split("\n").length);
      if (cb) cb();
    },
  };
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
    assert.ok(termA.buffer.active.length > 1, "旧画面确实有内容");

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

  it("真跑：回放帧是空的（空屏会话）也照样揭幕——不等兜底计时器", async () => {
    const w = makeTerminalWorld();
    const { term: termA } = await primeSession(w, terminalSession("A"));
    w.world.parkTerminalScreen();
    await w.world.connectTerminalStream(terminalSession("B"));
    w.sources[1].emit("snapshot", JSON.stringify({ pid: 2, cols: 120, rows: 34 }));
    w.sources[1].emit("data", JSON.stringify(""));
    assert.equal(w.created[1].buffer.active.length, 1, "新实例缓冲区仍是空的");
    w.clock.flushAll();
    assert.equal(termA.disposed, true, "空回放也算交代过了，垫片照撤");
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
