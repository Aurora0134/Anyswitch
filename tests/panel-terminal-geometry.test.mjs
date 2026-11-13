// 回前台/重建时的快照几何闸（终端错位残行）。
//
// 机制：面板的虚拟终端每次「回前台/重建」都是整屏重建——新建 xterm（出厂 80×24）→
// fit → 开流，宿主随后按**它自己的**列宽发一整屏绝对定位回放（每行 CUP + 2K + 内容）。
// 只要那一拍 fit 没落定（隐藏闸 / 量不到 / 与缓存 PTY 同值早退），客户端就会用错的
// 列宽接这份回放；而 kimi 那类 TUI 只「定位光标 + 写字符」、从不发擦除序列，错位永久
// 留在缓冲里，只有再整屏重建才擦得掉。
//
// 取样惯例照 panel-terminal-loading.test.mjs：按函数名切源码进桩环境真跑
// （extractFn / new Function），只锚调用序列、请求参数与写在屏上的字节，不锚墙钟。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPanelFn as extractFn } from "../test-helpers/extract-panel-fn.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const panelJs = readFileSync(join(here, "../panel-ui", "panel.js"), "utf8");

// 数值不另抄：冷却窗与连续上限都从真身源码里取原句塞进沙箱，改真身时测试跟着走。
const COOLDOWN_DECL = /const TERMINAL_GEOMETRY_REALIGN_COOLDOWN_MS = \d+;/;
const MAX_ATTEMPTS_DECL = /const TERMINAL_GEOMETRY_REALIGN_MAX_ATTEMPTS = \d+;/;
const STALL_DECL = /const TERMINAL_GEOMETRY_REALIGN_STALL_MS = \d+;/;

function declOf(pattern, name) {
  const decl = panelJs.match(pattern)?.[0];
  assert.ok(decl, `${name} 在 panel.js 里`);
  return decl;
}

// 会话注册表：沙箱里的 terminalSessionFor 按 id 从这里取（补挂路径要按 id 找回会话）。
const registry = {};

// 桩世界：真跑 closeTerminalStream / absorbTerminalSnapshot / connectTerminalStream，
// 只把 xterm 构造、EventSource、resize POST 面替成桩。真实几何由 state.client 决定
// （桩 xterm 建出来就带着它，等价于「建流那次 fit 已经落定」的稳态）。
function makeGeometryWorld({ docHidden = false, viewHidden = false } = {}) {
  for (const id of Object.keys(registry)) delete registry[id];
  const state = {
    client: { cols: 120, rows: 34 },
    docHidden,
    viewHidden,
    sources: [],
    posts: [],
    writes: [],
    disposed: 0,
    resizes: [],
    resets: [],
    warnings: [],
    measurable: true,
    fitImpl: () => null,
    postImpl: () => Promise.resolve({}),
  };
  // 可控时钟：几何账的冷却窗（Date.now）与挂起兜底定时器共用同一条时间线，测试里
  // 用 advance() 显式推进，不依赖墙钟。
  const clock = {
    now: 1_000_000,
    seq: 0,
    timers: [],
    advance(ms) {
      clock.now += ms;
      for (;;) {
        const due = clock.timers.filter((timer) => timer.at <= clock.now);
        if (due.length === 0) break;
        due.sort((a, b) => a.at - b.at || a.id - b.id);
        const timer = due[0];
        clock.timers = clock.timers.filter((candidate) => candidate !== timer);
        timer.fn();
      }
    },
  };
  const factory = new Function(
    "state", "EventSource", "API_BASE", "document", "$",
    "ensureTerminalXterm", "fitTerminalXterm", "sendTerminalInput", "reviveTerminalSession",
    "postTerminalResize", "queueTerminalChunk", "flushTerminalBurst", "discardTerminalBurst",
    "disarmTerminalDprWatch", "cancelAnimationFrame", "console",
    "Date", "setTimeout", "clearTimeout", "terminalHostMeasurable",
    "terminalSessionFor", "activeTerminalPreviewId",
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
    let terminalImeHold = null;
    let terminalImeFitPending = false;
    let terminalImeArmHandler = null;
    let terminalImeReleaseHandler = null;
    let terminalImeHoldFrame = null;
    let terminalReplayRestoreCancel = null;
    let terminalReplayRestoreArm = null;
    let terminalReplayRestoring = false;
    let terminalStreamSyncCancel = null;
    let terminalStreamWrite = null;
    let terminalReplayFramePending = false;
    let terminalReplayEpoch = 0;
    let terminalLastStreamDataAt = 0;
    let terminalGeometryRealignPending = false;
    let terminalGeometryRealignAt = 0;
    let terminalGeometryRealignStreak = 0;
    let terminalGeometryReplayDrop = false;
    let terminalStreamDeferred = false;
    let terminalStreamRemounting = false;
    let terminalDeferredSessionId = null;
    let terminalGeometryRealignTimer = null;
    let terminalFrameRebuildSeq = 0;
    let terminalFrameRebuildAt = 0;
    let terminalFrameRebuildTimer = null;
    let terminalFrameRebuildStreak = 0;
    ${declOf(COOLDOWN_DECL, "TERMINAL_GEOMETRY_REALIGN_COOLDOWN_MS")}
    ${declOf(MAX_ATTEMPTS_DECL, "TERMINAL_GEOMETRY_REALIGN_MAX_ATTEMPTS")}
    ${declOf(STALL_DECL, "TERMINAL_GEOMETRY_REALIGN_STALL_MS")}
    ${extractFn("closeTerminalStream")}
    ${extractFn("absorbTerminalSnapshot")}
    ${extractFn("dropTerminalReplayFrame")}
    ${extractFn("deferTerminalStream")}
    ${extractFn("remountDeferredTerminalStream")}
    ${extractFn("requestTerminalFrameRebuild")}
    ${extractFn("finishTerminalGeometryRealign")}
    ${extractFn("scheduleTerminalGeometryRealign")}
    ${extractFn("terminalSessionShouldRevive")}
    ${extractFn("connectTerminalStream")}
    return {
      connect: connectTerminalStream,
      term: () => terminalXterm,
      stream: () => terminalEventSource,
      pending: () => terminalGeometryRealignPending,
      streak: () => terminalGeometryRealignStreak,
      epoch: () => terminalReplayEpoch,
      cooldown: () => TERMINAL_GEOMETRY_REALIGN_COOLDOWN_MS,
      maxAttempts: () => TERMINAL_GEOMETRY_REALIGN_MAX_ATTEMPTS,
      stall: () => TERMINAL_GEOMETRY_REALIGN_STALL_MS,
      deferred: () => terminalStreamDeferred,
      remount: remountDeferredTerminalStream,
      rebuildScheduled: () => terminalFrameRebuildTimer !== null,
      setPending: (v) => { terminalGeometryRealignPending = v; },
      // 尺寸可信度两个开关：默认「可测 + 不在组字」（与真身常态一致），用例 9 按需拨。
      measurable: (v) => { state.measurable = v; },
      imeHold: (v) => { terminalImeHold = v; },
      setStreak: (v) => { terminalGeometryRealignStreak = v; },
      swapTerm: (term) => { terminalXterm = term; },
    };
    `
  );
  const world = factory(
    state,
    function StubEventSource(url) {
      const es = {
        url, closed: false, handlers: {},
        close() { this.closed = true; },
        addEventListener(type, fn) { (this.handlers[type] || (this.handlers[type] = [])).push(fn); },
        // 帧内容与真身一致：handler 里是 JSON.parse(event.data)
        emit(type, payload) { for (const fn of this.handlers[type] || []) fn({ data: JSON.stringify(payload) }); },
      };
      state.sources.push(es);
      return es;
    },
    "/panel",
    { get hidden() { return state.docHidden; } },
    (id) => (id === "terminalView" ? { hidden: state.viewHidden } : null),
    () => {
      const term = {
        cols: state.client.cols,
        rows: state.client.rows,
        disposed: false,
        focus() {},
        // reset 落记录：「弃帧即清屏」那半边行为（dropTerminalReplayFrame 的
        // term?.reset?.()）由此可断言，空实现会把清屏腿变成不可观测。
        reset() { state.resets.push(1); },
        onData() { return { dispose() {} }; },
        write(text) { state.writes.push(text); },
        resize(cols, rows) { state.resizes.push({ cols, rows }); term.cols = cols; term.rows = rows; },
        dispose() { term.disposed = true; state.disposed += 1; },
      };
      world.swapTerm(term);
      return term;
    },
    () => state.fitImpl(),
    () => Promise.resolve(),
    () => Promise.resolve(null),
    (session, cols, rows) => {
      state.posts.push({ id: session.id, cols, rows });
      return state.postImpl(cols, rows);
    },
    (term, text) => { state.writes.push(text); },
    () => {},
    () => {},
    () => {},
    () => {},
    { warn(...args) { state.warnings.push(args); } },
    { now: () => clock.now },
    (fn, ms) => {
      clock.seq += 1;
      const id = clock.seq;
      clock.timers.push({ id, at: clock.now + (ms || 0), fn });
      return id;
    },
    (id) => { clock.timers = clock.timers.filter((timer) => timer.id !== id); },
    () => state.measurable,
    (id) => registry[id] || null,
    "S1",
  );
  world.state = state;
  world.clock = clock;
  return world;
}

// 建一条已画好内容的连接（首连 + 几何匹配的快照 + 首帧回放）。
async function prime(world, session) {
  await world.connect(session);
  const es = world.state.sources[world.state.sources.length - 1];
  es.emit("snapshot", { pid: 1, cols: 120, rows: 34 });
  es.emit("data", `${session.id}-screen`);
  return { es, term: world.term() };
}

const sessionOf = (id) => {
  const session = { id, backend: true, backendState: { status: "running" }, shell: {} };
  registry[id] = session;
  return session;
};
async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("快照几何闸：宿主列宽与客户端不一致时先对齐再回放", () => {
  it("错配的 snapshot 不写回放，按客户端尺寸发一次 resize，落定后重连一次", async () => {
    let releasePost;
    const postInFlight = new Promise((resolve) => { releasePost = resolve; });
    const world = makeGeometryWorld();
    const session = sessionOf("S1");
    const { es, term } = await prime(world, session);
    assert.equal(world.state.writes.length, 1, "前置：稳态那一帧正常落屏");
    world.state.postImpl = () => postInFlight;
    // 客户端被用户改宽（fit 已落定），宿主镜像还按旧列宽算整屏回放
    term.cols = 123;
    world.state.writes.length = 0;

    es.emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    es.emit("data", "host-replay-按旧列宽折行");
    assert.deepEqual(world.state.writes, [], "错配回放一个字节都不写进屏");
    assert.equal(world.state.posts.length, 1, "发了一次 resize POST");
    assert.deepEqual(world.state.posts[0], { id: "S1", cols: 123, rows: 34 }, "POST 参数是客户端真实尺寸");
    assert.equal(world.state.sources.length, 1, "POST 没落定：还没重连");
    assert.equal(world.pending(), true, "重对齐在飞：data 帧一律丢弃");

    releasePost({ cols: 123, rows: 34 });
    await flushMicrotasks();
    assert.equal(world.pending(), false, "落定后撤标志");
    assert.equal(world.state.sources.length, 2, "重连一次，拿宿主按新尺寸自绘的整屏帧");
    assert.equal(world.state.sources[1].url, world.state.sources[0].url, "重连的是同一条会话的流");
  });

  it("同一实例 1500ms 内的第二帧错配不立刻重连，但回放不落屏且排了后续对齐", async () => {
    const world = makeGeometryWorld();
    const session = sessionOf("S1");
    const { es, term } = await prime(world, session);
    world.state.postImpl = () => Promise.resolve({ cols: 123, rows: 34 });
    term.cols = 123;
    es.emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    await flushMicrotasks();
    assert.equal(world.state.posts.length, 1, "前置：第一次错配触发过一次");
    assert.equal(world.state.sources.length, 2, "前置：已经重连");
    assert.ok(world.cooldown() > 0, "冷却窗是正数");

    const term2 = world.term();
    term2.cols = 126; // 又一次错配（用户继续拖窗口）
    const es2 = world.state.sources[1];
    world.state.writes.length = 0;
    es2.emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    assert.equal(world.state.posts.length, 1, "冷却期内不再 POST");
    assert.equal(world.state.sources.length, 2, "也不重连");
    assert.equal(world.pending(), false, "冷却帧不占住回放闩（错宽回放与后续增量仍被丢，丢弃走基线作废标记而非这道闩）");
    // 冷却期不再重连，但这一帧仍然是错宽回放：不画。排一次延后对齐，等窗过去再对齐。
    es2.emit("data", "冷却期的回放");
    assert.deepEqual(world.state.writes, [], "冷却窗内的错宽回放同样不落屏");
    // 基线作废后连后续帧一并丢到下一次 snapshot：live 帧是零 2J / 零 CUP 的纯相对
    // 重绘，没有自足起点，照画只会把旧行叠成多份输入框（2026-11-08 修法 4）。
    es2.emit("data", "冷却期的增量");
    assert.deepEqual(world.state.writes, [], "基线作废期间其后的增量一并丢弃");

    const postsBefore = world.state.posts.length;
    const sourcesBefore = world.state.sources.length;
    world.clock.advance(world.cooldown() + 1);
    await flushMicrotasks();
    assert.equal(world.state.posts.length, postsBefore + 1, "窗过去后补一次 resize POST");
    assert.equal(world.state.sources.length, sourcesBefore + 1, "并重连一次拿正确回放");
  });

  it("尺寸匹配的 snapshot 走原逻辑：置回放闩、不 POST 不重连", async () => {
    const world = makeGeometryWorld();
    const session = sessionOf("S1");
    const { es, term } = await prime(world, session);
    world.state.writes.length = 0;
    world.state.sources.length = 0;

    es.emit("snapshot", { pid: 2, cols: term.cols, rows: term.rows });
    es.emit("data", "replay-once");
    assert.deepEqual(world.state.writes, ["replay-once"], "首帧直写（回放闩照旧）");
    assert.equal(world.epoch(), 2, "首帧消费闩并推进揭幕计数（与改动前一致）");
    assert.deepEqual(world.state.posts, [], "尺寸对得上不 POST");
    assert.equal(world.state.sources.length, 0, "不重连");
    assert.equal(world.streak(), 0, "匹配帧把连续计数归零");
  });

  it("旧流迟到帧：既不写屏，也不消费回放闩/揭幕计数", async () => {
    const world = makeGeometryWorld();
    const session = sessionOf("S1");
    const { es, term: termA } = await prime(world, session);
    const epochBefore = world.epoch();
    // 换会话重建：旧源未关的事件对象仍可能收到迟到帧（浏览器重连/在飞帧）
    await world.connect(sessionOf("S2"));
    const sourceA = es;
    const termB = world.term();
    assert.notEqual(termA, termB, "前置：实例已换人");
    world.state.writes.length = 0;

    sourceA.emit("snapshot", { pid: 9, cols: 80, rows: 24 });
    sourceA.emit("data", "late-frame");
    assert.deepEqual(world.state.writes, [], "迟到帧不写进新实例");
    assert.equal(world.epoch(), epochBefore, "也不推进垫片的就绪计数");
    assert.deepEqual(world.state.posts, [], "更不拿旧几何去触发重对齐");

    // 重对齐在飞时再来一帧迟到数据：标志不能被它消费掉（否则新流的回放会被当稳态走合并器）
    world.setPending(true);
    sourceA.emit("data", "late-frame-2");
    assert.equal(world.pending(), true, "迟到帧不消费「重对齐在飞」");
    assert.equal(world.epoch(), epochBefore, "计数同样不动");
  });

  it("建流：await 期间转入后台就不再开流（连实例一并收掉）", async () => {
    let releaseFit;
    const fitInFlight = new Promise((resolve) => { releaseFit = resolve; });
    const world = makeGeometryWorld();
    world.state.fitImpl = () => fitInFlight;
    const connecting = world.connect(sessionOf("S1"));
    await flushMicrotasks();
    assert.equal(world.state.sources.length, 0, "前置：resize 在飞，流还没开");
    world.state.docHidden = true; // 等 POST 的这段时间里用户切走了
    releaseFit();
    await connecting;
    assert.equal(world.state.sources.length, 0, "await 之后复查隐藏闸：一帧都不开");
    assert.equal(world.state.disposed, 1, "半成品实例当场收掉，不留悬空 xterm");
  });

  it("连续错配超出上限后放弃重对齐：不 POST，只告警一次，错宽回放不落屏并请求整屏重建", async () => {
    const world = makeGeometryWorld();
    const session = sessionOf("S1");
    await prime(world, session);
    const max = world.maxAttempts();
    world.state.postImpl = () => Promise.resolve({ cols: 123, rows: 34 });

    // 第一、第二次错配：冷却窗外各重对齐一次，连续计数顶到上限
    let term = world.term();
    term.cols = 123;
    world.state.sources[0].emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    await flushMicrotasks();
    assert.equal(world.state.posts.length, 1, "前置：第一次错配重对齐");
    assert.equal(world.state.sources.length, 2, "前置：第一次重连");

    world.clock.advance(world.cooldown() + 1);
    term = world.term();
    term.cols = 126;
    world.state.sources[1].emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    await flushMicrotasks();
    assert.equal(world.state.posts.length, 2, "冷却窗外第二次错配仍重对齐");
    assert.equal(world.state.sources.length, 3, "第二次也重连");
    assert.equal(world.streak(), max, "连续计数顶到上限");
    assert.deepEqual(world.state.warnings, [], "上限那一拍是正常重对齐，还不告警");

    // 第三次错配：超限刹车。不再 POST、不再走重对齐重连，只告警一次，且这一份错宽
    // 回放不画——整屏回放作废即清屏，宁可短暂空白也不留一屏错列宽的残行（错信息比
    // 慢更糟）。放弃对齐那一拍改发整屏重建请求：真机由 requestTerminalFrameRebuild
    // 在 0ms 后重开一条流拿宿主自绘回放（节流与连续封顶都在它内），本用例钉住请求的
    // 发出与到点重开，而不是「永不重连」——后者只在缺这套设施的桩里成立。
    world.clock.advance(world.cooldown() + 1);
    term = world.term();
    term.cols = 129;
    world.state.writes.length = 0;
    const resetsBeforeOverlimit = world.state.resets.length;
    const es = world.state.sources[2];
    es.emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    es.emit("data", "超限后的回放");
    assert.equal(world.state.posts.length, 2, "超限后不再 POST");
    assert.equal(world.state.sources.length, 3, "同步也不重连（重开流是重建请求 0ms 定时器的事，不占这一拍）");
    assert.equal(world.pending(), false, "超限帧不占回放闩");
    assert.equal(world.state.warnings.length, 1, "告警一次");
    assert.match(world.state.warnings[0][0], /geometry realign abandoned/);
    assert.deepEqual(world.state.writes, [], "超限后的错宽回放不落屏");
    assert.equal(world.state.resets.length, resetsBeforeOverlimit + 1, "作废即清屏：弃帧那一拍同步 reset");
    assert.equal(world.rebuildScheduled(), true, "超限放弃对齐时发出整屏重建请求");
    // 不再「只丢首帧」：基线没了之后每一帧增量都缺自足起点，一并丢到下一次 snapshot。
    es.emit("data", "超限后的增量");
    assert.deepEqual(world.state.writes, [], "作废期间的增量同样不落屏，堵住叠画");

    es.emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    assert.equal(world.state.warnings.length, 1, "接续的错配不再重复告警");

    // 重建请求到点：重开一条流拿宿主按当前几何自绘的整屏回放。不发 resize POST——
    // 放弃对齐后不再拿客户端尺寸去改 PTY，这是它与重对齐重连的本质区别。
    const postsAtRebuild = world.state.posts.length;
    world.clock.advance(1);
    assert.equal(world.rebuildScheduled(), false, "重建定时器已消费");
    assert.equal(world.state.sources.length, 4, "重建到点重开一条流");
    assert.equal(world.state.sources[3].url, world.state.sources[2].url, "重开的是同一条会话的流");
    assert.equal(world.state.posts.length, postsAtRebuild, "重建重开流不发 resize POST");
  });

  it("宿主把 cols 夹在 240 上限时把夹过的值回夹进 xterm", async () => {
    // 宿主 resize 路由把 cols 夹在 240、rows 夹在 120。客户端量到 250 列时 POST 250，
    // 回包却是 240——不回夹就永远「错配」，连续两拍后撞上限刹车放弃（原来的放弃形态）。
    const world = makeGeometryWorld();
    const session = sessionOf("S1");
    const { es, term } = await prime(world, session);
    world.state.postImpl = () => Promise.resolve({ cols: 240, rows: 34 });
    term.cols = 250;
    world.state.writes.length = 0;

    es.emit("snapshot", { pid: 1, cols: 200, rows: 34 });
    es.emit("data", "错宽回放");
    assert.deepEqual(world.state.writes, [], "错配回放不落屏");
    assert.deepEqual(world.state.posts, [{ id: "S1", cols: 250, rows: 34 }], "POST 的是客户端真实尺寸");
    await flushMicrotasks();

    assert.deepEqual(world.state.resizes, [{ cols: 240, rows: 34 }], "把宿主夹过的值回夹进 xterm");
    assert.equal(term.cols, 240, "回夹发生在实例被换掉之前（同一实例上生效）");

    // 回包与客户端一致时不回夹（不多余改动尺寸）。
    const world2 = makeGeometryWorld();
    const session2 = sessionOf("S2");
    const p2 = await prime(world2, session2);
    world2.state.postImpl = () => Promise.resolve({ cols: 123, rows: 34 });
    p2.term.cols = 123;
    p2.es.emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    await flushMicrotasks();
    assert.deepEqual(world2.state.resizes, [], "回包已等于客户端尺寸：不调 resize");
  });

  it("重对齐 POST 在飞时视图隐藏：落定后拆掉旧流，不留实例", async () => {
    let releasePost;
    const postInFlight = new Promise((resolve) => { releasePost = resolve; });
    const world = makeGeometryWorld();
    const session = sessionOf("S1");
    const { es, term } = await prime(world, session);
    world.state.postImpl = () => postInFlight;
    term.cols = 123;
    es.emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    assert.equal(world.state.posts.length, 1, "前置：POST 在飞");
    assert.equal(world.pending(), true, "前置：数据闸关着");

    world.state.viewHidden = true; // 用户在 POST 落定前切走
    releasePost({ cols: 123, rows: 34 });
    await flushMicrotasks();

    assert.equal(world.pending(), false, "落定后撤标志");
    assert.equal(world.stream(), null, "旧流被拆掉，不留在刚 reset 的实例上继续按错宽度写");
    assert.equal(world.term(), null, "实例一并收掉（切回终端页会走整屏重建）");
    assert.equal(es.closed, true, "旧 EventSource 真关掉");
    assert.equal(world.state.sources.length, 1, "隐藏期也不新建流");
  });

  it("POST 永不落定：兜底超时放开数据闸，其后增量照常落屏且不拆流", async () => {
    const world = makeGeometryWorld();
    const session = sessionOf("S1");
    const { es, term } = await prime(world, session);
    world.state.postImpl = () => new Promise(() => {});
    term.cols = 123;
    world.state.writes.length = 0;
    es.emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    es.emit("data", "在飞期间的错宽回放");
    assert.deepEqual(world.state.writes, [], "前置：兜底前数据帧仍被丢掉");
    assert.equal(world.pending(), true, "前置：闸还关着");

    world.clock.advance(world.stall() - 1);
    es.emit("data", "兜底前一刻");
    assert.deepEqual(world.state.writes, [], "未到兜底时限仍不放行");

    world.clock.advance(1);
    assert.equal(world.pending(), false, "越过兜底时限后放开数据闸");
    // 放开的是「重对齐在飞」这道帧闸，不是把错宽回放补画回去——那份整屏回放
    // 在闸关着的时候已经被丢弃了（M5：错宽帧一个字节都不进屏）。兜底之后落屏的
    // 是应用自己新产生的增量帧。旧断言把它写成「错宽回放照常落屏／有画面胜过空白」，
    // 与现役取向相反，2026-11-08 一并订正。
    es.emit("data", "兜底后的增量");
    assert.deepEqual(world.state.writes, ["兜底后的增量"], "闸放开后其后的增量照常落屏");
    assert.equal(world.stream(), es, "流没有被拆掉");
    assert.equal(world.term(), term, "实例也还在（可见时拆流没有补救通路）");
    assert.equal(world.state.sources.length, 1, "不新建流");
  });

  it("容器不可测时不画错宽回放：拆流挂起，几何可信后由 fit 补挂", async () => {
    const world = makeGeometryWorld();
    const session = sessionOf("S1");
    const { es, term } = await prime(world, session);
    // 先把连续计数置到 1：用来区分「不可测的一帧把账清零了」与「账原地不动」。
    world.setStreak(1);
    world.measurable(false);
    term.cols = 80;
    world.state.writes.length = 0;
    es.emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    // snapshot 本身不写屏，回放帧必须跟一发，writes 断言才有落点。
    es.emit("data", "不可测时的回放");

    assert.equal(world.state.posts.length, 0, "不可测时不 POST（没有可对齐的目标）");
    assert.deepEqual(world.state.warnings, [], "不可测时不告警");
    assert.equal(world.pending(), false, "不可测时不占重对齐闩");
    assert.equal(world.streak(), 1, "不可测的一帧既不归零也不累加：只认「判得了且没对上」的连续失败");
    assert.deepEqual(world.state.writes, [], "几何未知时的回放一个字节都不画");
    assert.equal(world.deferred(), true, "流被挂起而非丢弃：标记留到几何可信那一拍");
    assert.equal(es.closed, true, "旧流当场拆掉");
    assert.equal(world.term(), null, "实例一并收掉（与拆流同一套收尾）");

    // 几何恢复：沙箱里直调 remount 本体——fit 补挂那条腿调的就是 remountDeferredTerminalStream
    // 本身，拿宿主按客户端尺寸自绘的整屏帧；fit→remount 的真身接线在桩世界不可达（本沙箱
    // 的 fit 是工厂参数桩），用末尾的源码契约钉住它存在。
    world.measurable(true);
    world.remount();
    assert.equal(world.deferred(), false, "补挂后清标记");
    assert.equal(world.state.sources.length, 2, "重新建了一条流");
    assert.notEqual(world.term(), null, "新实例已建");
    // 源码契约：fit 在「无可对齐目标」的早退里补挂挂起的流（写法同
    // panel-terminal-loading 的源码钉）。防这条接线被拆掉后，标题里的「由 fit 补挂」
    // 只剩沙箱直调在空转。
    assert.match(extractFn("fitTerminalXterm"), /remountDeferredTerminalStream\(\)/,
      "fit 在无可对齐目标的早退里补挂挂起的流");
  });

  it("组字期（几何被冻结）同样不画，同样拆流挂起", async () => {
    const world = makeGeometryWorld();
    const session = sessionOf("S1");
    const { es, term } = await prime(world, session);
    world.setStreak(1);
    world.imeHold({});
    term.cols = 81;
    world.state.writes.length = 0;
    es.emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    es.emit("data", "组字期回放");
    assert.equal(world.state.posts.length, 0, "组字期不 POST");
    assert.equal(world.pending(), false, "组字期不占重对齐闩");
    assert.equal(world.streak(), 1, "组字期那一帧同样不动账");
    assert.deepEqual(world.state.writes, [], "组字期的回放不落屏");
    assert.equal(world.deferred(), true, "挂起等组字释放后的 fit");

    // 组字释放但几何还没量到：fit 不补挂，标记保留等下一拍。
    world.imeHold(null);
    world.measurable(false);
    world.remount();
    assert.equal(world.deferred(), true, "量不准就保持挂起，下次 fit 再试");
    assert.equal(world.state.sources.length, 1, "没有新建流");
    world.measurable(true);
    world.remount();
    assert.equal(world.deferred(), false, "量准后补挂");
    assert.equal(world.state.sources.length, 2, "补挂建了新流");
  });

  it("基线作废后连后续帧一并丢到下一次 snapshot，整屏回放重建基线", async () => {
    // 钉住图一/图二的叠画通路：宿主对每条连接只发一帧自足整屏回放，丢掉它之后
    // 后续 live 帧是零 2J / 零 CUP 的纯相对重绘，没有自足起点；旧语义「只丢首帧、
    // 其余照画」会把旧行留成残行、新帧再叠上去，输入框于是被复制成多份。
    const world = makeGeometryWorld();
    const session = sessionOf("S1");
    await prime(world, session);
    world.setStreak(world.maxAttempts() + 1); // 直接进「放弃对齐」那一支：这一拍流继续（重建请求的 0ms 定时器挂在不推进的沙箱时钟上，不会在本用例里消费）
    const term = world.term();
    term.cols = 129;
    const es = world.state.sources[0];
    world.state.writes.length = 0;
    const resetsBeforeDrop = world.state.resets.length;

    es.emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    es.emit("data", "错宽整屏回放");
    assert.deepEqual(world.state.writes, [], "作废旧基线并清屏，回放一字不进屏");
    assert.equal(world.state.resets.length, resetsBeforeDrop + 1, "弃帧即清屏：作废这份回放时同步 reset");
    es.emit("data", "纯相对增量-1");
    es.emit("data", "纯相对增量-2");
    assert.deepEqual(world.state.writes, [], "作废期间的后续帧一并丢弃，不留叠画通路");

    // 下一次 snapshot（新连接 / 自动重连）是唯一能重建基线的信号。
    term.cols = 120;
    es.emit("snapshot", { pid: 2, cols: 120, rows: 34 });
    es.emit("data", "自足整屏回放");
    assert.deepEqual(world.state.writes, ["自足整屏回放"], "新 snapshot 后整屏回放重新落屏");
  });
});
