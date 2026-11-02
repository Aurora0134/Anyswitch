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

// 桩世界：真跑 closeTerminalStream / absorbTerminalSnapshot / connectTerminalStream，
// 只把 xterm 构造、EventSource、resize POST 面替成桩。真实几何由 state.client 决定
// （桩 xterm 建出来就带着它，等价于「建流那次 fit 已经落定」的稳态）。
function makeGeometryWorld({ docHidden = false, viewHidden = false } = {}) {
  const state = {
    client: { cols: 120, rows: 34 },
    docHidden,
    viewHidden,
    sources: [],
    posts: [],
    writes: [],
    disposed: 0,
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
    ${declOf(COOLDOWN_DECL, "TERMINAL_GEOMETRY_REALIGN_COOLDOWN_MS")}
    ${declOf(MAX_ATTEMPTS_DECL, "TERMINAL_GEOMETRY_REALIGN_MAX_ATTEMPTS")}
    ${declOf(STALL_DECL, "TERMINAL_GEOMETRY_REALIGN_STALL_MS")}
    ${extractFn("closeTerminalStream")}
    ${extractFn("absorbTerminalSnapshot")}
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
      setPending: (v) => { terminalGeometryRealignPending = v; },
      // 尺寸可信度两个开关：默认「可测 + 不在组字」（与真身常态一致），用例 9 按需拨。
      measurable: (v) => { state.measurable = v; },
      imeHold: (v) => { terminalImeHold = v; },
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
        reset() {},
        onData() { return { dispose() {} }; },
        write(text) { state.writes.push(text); },
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

const sessionOf = (id) => ({ id, backend: true, backendState: { status: "running" }, shell: {} });

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

  it("同一实例 1500ms 内的第二帧错配不再触发（不重复 POST/重连，画面照常喂）", async () => {
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
    assert.equal(world.pending(), false, "冷却帧不占住回放闩（后续帧照常落屏）");
    // 冷却期只是「不重复重连」，画面照常喂：拖窗口那一拍不能把屏停成空白。
    es2.emit("data", "冷却期的回放");
    assert.deepEqual(world.state.writes, ["冷却期的回放"], "冷却期的帧照常画（与改动前一致）");
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

  it("连续错配超出上限后不再 POST/重连，只告警一次，那一帧照常落屏", async () => {
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

    // 第三次错配：超限刹车。不 POST、不重连，只告警一次，且这一帧按原逻辑落屏。
    world.clock.advance(world.cooldown() + 1);
    term = world.term();
    term.cols = 129;
    world.state.writes.length = 0;
    const es = world.state.sources[2];
    es.emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    es.emit("data", "超限后的回放");
    assert.equal(world.state.posts.length, 2, "超限后不再 POST");
    assert.equal(world.state.sources.length, 3, "也不重连");
    assert.equal(world.pending(), false, "超限帧不占回放闩");
    assert.equal(world.state.warnings.length, 1, "告警一次");
    assert.match(world.state.warnings[0][0], /geometry realign abandoned/);
    assert.deepEqual(world.state.writes, ["超限后的回放"], "超限那一帧照常落屏，不是空白");

    es.emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    assert.equal(world.state.warnings.length, 1, "接续的错配不再重复告警");
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

  it("POST 永不落定：兜底超时放开数据闸，回放照常落屏且不拆流", async () => {
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
    es.emit("data", "兜底后的回放");
    assert.deepEqual(world.state.writes, ["兜底后的回放"], "错宽回放照常落屏：有画面胜过空白");
    assert.equal(world.stream(), es, "流没有被拆掉");
    assert.equal(world.term(), term, "实例也还在（可见时拆流没有补救通路）");
    assert.equal(world.state.sources.length, 1, "不新建流");
  });

  it("容器不可测时不判错配：不 POST 不重连不告警，回放照常落屏", async () => {
    const world = makeGeometryWorld();
    const session = sessionOf("S1");
    const { es, term } = await prime(world, session);
    assert.equal(world.streak(), 0, "前置：匹配帧把账清零");

    // 这一拍 fit 静默早退（容器量不到），term.cols 停在 xterm 出厂值——这是猜测值，
    // 不是测量值，拿它 POST 等于把 80 列硬写进 PTY。
    world.measurable(false);
    term.cols = 80;
    world.state.writes.length = 0;
    es.emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    es.emit("data", "不可测时的回放");
    assert.deepEqual(world.state.posts, [], "不可测：不拿猜测尺寸 POST");
    assert.equal(world.state.sources.length, 1, "也不重连");
    assert.deepEqual(world.state.warnings, [], "不告警");
    assert.equal(world.pending(), false, "不占回放闩");
    assert.equal(world.streak(), 0, "不累加");
    assert.deepEqual(world.state.writes, ["不可测时的回放"], "照原逻辑落屏：屏上有内容");

    // 组字期几何被冻结（terminalImeHold 非空），同样不可信，同样不判。
    world.measurable(true);
    world.imeHold({});
    term.cols = 81;
    es.emit("snapshot", { pid: 1, cols: 120, rows: 34 });
    assert.equal(world.state.posts.length, 0, "组字期也不 POST");
    assert.equal(world.state.sources.length, 1, "组字期也不重连");
    assert.equal(world.pending(), false, "组字期也不占回放闩");
    world.imeHold(null);
  });
});
