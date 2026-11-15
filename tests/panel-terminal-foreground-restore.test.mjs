// 后台切回屏面交接的行为钉：整屏重建必须把切走前的阅读位/跟随态/地板带过岸，
// 外层几何错配留下的空白带必须在没有任何用户交互的那一拍被收掉。
//
// 取样惯例照 panel-terminal-loading：源码字符串断言 + 按函数名切源码进桩环境真跑。
// 时钟手动推进，不锚墙钟；桩环境不依赖本机 xterm 安装。
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPanelFn as extractFn } from "../test-helpers/extract-panel-fn.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const panelJs = readFileSync(join(here, "../panel-ui", "panel.js"), "utf8");
const panelCss = readFileSync(join(here, "../panel-ui", "panel.css"), "utf8");

const decl = (name) => {
  const src = panelJs.match(new RegExp(`const ${name} = \\d+;`))?.[0];
  assert.ok(src, `${name} 常量可从 panel.js 取到`);
  return src;
};

function makeClock(start = 100000) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    get now() { return now; },
    get pending() { return timers.size; },
    setTimeout(fn, ms = 0) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) if (t.at <= now) { due = [id, t]; break; }
        if (!due) break;
        timers.delete(due[0]);
        due[1].fn();
      }
    },
  };
}

// 交接单四个真身 + 共享常量的最小桩世界。所有模块级量以访问器暴露，用例可换实例、
// 换会话、换视图、推进时钟，读到的就是产线那份源码里的同一批变量。
function handoffWorld() {
  const bodies = [
    "trimTerminalOuterBand",
    "captureTerminalForegroundFrame",
    "resumeTerminalForegroundFrame",
    "beginTerminalForegroundRestore",
  ].map(extractFn).join("\n");
  const clock = makeClock();
  const state = { view: "terminal", viewHidden: false, writes: [], restoreCalls: [], disposed: 0 };
  const screen = { scrollHeight: 1000, clientHeight: 600, dataset: {}, writes: [] };
  let screenScrollTop = 406.7;
  Object.defineProperty(screen, "scrollTop", {
    get() { return screenScrollTop; },
    set(v) { screen.writes.push(v); screenScrollTop = v; },
  });
  const writeHandlers = [];
  const term = {
    rows: 30,
    buffer: { active: { type: "normal", hasScrollback: true, viewportY: 5500, baseY: 6000, length: 6030 } },
    onWriteParsed(cb) {
      writeHandlers.push(cb);
      return { dispose() { state.disposed += 1; } };
    },
  };
  const stale = { done: false, restorePending: false, foregroundFrame: false };
  const handoff = {
    term,
    read: () => ({ viewportY: 5500, baseY: 6000, length: 6030, followBottom: false, floor: 5990, lastEffBottom: null }),
    restore: (saved) => { state.restoreCalls.push({ ...saved }); return true; },
  };
  const el = { isConnected: true };
  const sandbox = new Function("state", "clock", "screen", "term", "stale", "handoff", "el", `
    ${decl("TERMINAL_BOTTOM_ALIGN_BAND_MIN_PX")}
    ${decl("TERMINAL_FOREGROUND_RESTORE_SETTLE_MS")}
    ${decl("TERMINAL_FOREGROUND_RESTORE_MAX_MS")}
    const Date = { now: () => clock.now };
    const setTimeout = (fn, ms) => clock.setTimeout(fn, ms);
    const clearTimeout = (id) => clock.clearTimeout(id);
    let currentView = state.view;
    let terminalXterm = term;
    let terminalStaleScreen = stale;
    let terminalFrameHandoff = handoff;
    let terminalBoundSessionId = "sess-1";
    let terminalUserActionAt = 0;
    let terminalForegroundFrame = null;
    let terminalForegroundFrameTimer = null;
    let terminalForegroundRestorePending = false;
    const terminalView = el;
    function $(id) {
      if (id === "terminalScreen") return screen;
      if (id === "terminalView") return { get hidden() { return state.viewHidden; } };
      return null;
    }
    ${bodies}
    return {
      capture: captureTerminalForegroundFrame,
      resume: resumeTerminalForegroundFrame,
      begin: beginTerminalForegroundRestore,
      trim: trimTerminalOuterBand,
      get frame() { return terminalForegroundFrame; }, set frame(v) { terminalForegroundFrame = v; },
      get pending() { return terminalForegroundRestorePending; }, set pending(v) { terminalForegroundRestorePending = v; },
      get handoff() { return terminalFrameHandoff; }, set handoff(v) { terminalFrameHandoff = v; },
      get xterm() { return terminalXterm; }, set xterm(v) { terminalXterm = v; },
      get bound() { return terminalBoundSessionId; }, set bound(v) { terminalBoundSessionId = v; },
      get userActionAt() { return terminalUserActionAt; }, set userActionAt(v) { terminalUserActionAt = v; },
      get staleScreen() { return terminalStaleScreen; }, set staleScreen(v) { terminalStaleScreen = v; },
      get view() { return currentView; }, set view(v) { currentView = v; },
    };
  `)(state, clock, screen, term, stale, handoff, el);
  return {
    state, clock, screen, term, stale, handoff, sandbox,
    write: () => { for (const cb of writeHandlers.slice()) cb(); },
  };
}

describe("后台切回屏面交接：接线", () => {
  const vis = panelJs.match(/document\.addEventListener\("visibilitychange", \(\) => \{([\s\S]*?)\n  \}\);/)?.[1];
  assert.ok(vis, "visibilitychange 处理器可取样");

  it("隐藏拍先记交接单再停放/拆流；可见拍核交接单且不改既有调用序列", () => {
    const capture = vis.indexOf("captureTerminalForegroundFrame()");
    const park = vis.indexOf("parkTerminalScreen()");
    const hiddenReturn = vis.indexOf("if (document.hidden) return;");
    const resume = vis.indexOf("resumeTerminalForegroundFrame()");
    assert.ok(capture > 0 && capture < park, "进后台先抄屏面状态，park 会摘掉旧实例");
    assert.ok(park > 0 && park < hiddenReturn, "停放仍排在隐藏早退之前");
    assert.ok(resume > hiddenReturn, "回前台核交接单挂在可见分支");
    assert.ok(vis.includes('if (document.hidden && typeof captureTerminalForegroundFrame === "function")'),
      "隐藏拍带 typeof 闸，桩环境空转");
  });

  it("整屏重建两条路径都在建流之后挂交接单；已建流短路不挂", () => {
    const render = extractFn("renderTerminalPreviewSession");
    const begins = [...render.matchAll(/beginTerminalForegroundRestore\(\);/g)].map((m) => m.index);
    const connects = [...render.matchAll(/connectTerminalStream\(session, \{ revive \}\);/g)].map((m) => m.index);
    assert.equal(begins.length, 2, "同步路径与双 rAF 延后路径各一次");
    assert.equal(connects.length, 2);
    assert.ok(begins[0] > connects[0] && begins[1] > connects[1], "两条路径都排在建流之后");
    const short = render.indexOf("&& terminalEventSource) return;");
    assert.ok(short > 0 && short < render.indexOf("parkTerminalScreen(session);"),
      "同会话流健在的短路仍排在建流之前");
  });

  it("拆流清护栏桥、揭幕再收带、兜底窗等落位、回放闩不先锚底", () => {
    assert.match(extractFn("closeTerminalStream"), /terminalFrameHandoff = null/,
      "桥属于旧实例，拆流即清");
    assert.match(extractFn("revealTerminalStaleScreen"), /trimTerminalOuterBand\(\)/,
      "揭幕那一拍补收重建期滚出的带");
    assert.match(extractFn("parkTerminalScreen"), /stale\.restorePending && capRenewals/,
      "阅读位没落定时兜底窗不撤垫片");
    const arm = panelJs.match(/terminalReplayRestoreArm = \(\) => \{[\s\S]*?\n    \};/)?.[0];
    assert.match(arm, /terminalForegroundRestorePending/, "闩清后不按 fresh 实例出厂态锚底");
  });

  it("CSS：外层滚动盒禁止滚动锚定，重建换 DOM 时不把空白带重新滚入", () => {
    const rule = panelCss.match(/\n  \.terminal-screen \{[^}]*\}/)?.[0];
    assert.ok(rule, "主 .terminal-screen 规则可取样");
    assert.match(rule, /overflow-anchor:\s*none/, "滚动锚定关掉");
    assert.match(rule, /overflow:\s*auto/, "滚动能力原样保留");
  });

  it("零文案自检：新增代码不写任何用户可见文本", () => {
    const added = [
      "trimTerminalOuterBand", "captureTerminalForegroundFrame",
      "resumeTerminalForegroundFrame", "beginTerminalForegroundRestore",
    ].map(extractFn).join("\n");
    assert.doesNotMatch(added, /textContent|innerHTML|innerText|toast\(|alert\(|confirm\(/);
    assert.doesNotMatch(added, /placeholder|aria-label/, "不新增任何展示串");
  });
});

describe("后台切回屏面交接：真跑", () => {
  it("进后台抄下阅读位/跟随态/地板与会话身份；备屏与非终端页不抄", () => {
    const w = handoffWorld();
    w.sandbox.capture();
    assert.equal(w.sandbox.frame.sessionId, "sess-1");
    assert.equal(w.sandbox.frame.buffer.viewportY, 5500);
    assert.equal(w.sandbox.frame.buffer.length, 6030);
    assert.equal(w.sandbox.frame.buffer.followBottom, false, "正在读历史，跟随态随交接单过岸");
    assert.equal(w.sandbox.frame.buffer.floor, 5990, "地板不是真尾，不能让新实例从出厂值重算");

    w.term.buffer.active.type = "alternate";
    w.sandbox.capture();
    assert.equal(w.sandbox.frame.buffer, null, "备屏无滚动历史，不参与交接");

    w.term.buffer.active.type = "normal";
    w.sandbox.view = "board";
    w.sandbox.capture();
    assert.equal(w.sandbox.frame, null, "不在终端页，交接单作废");
  });

  it("隐藏转折重复到达：拆流后读不到屏面时保留上一份有效交接单", () => {
    const w = handoffWorld();
    w.sandbox.capture();
    const first = w.sandbox.frame;
    assert.equal(first.buffer.viewportY, 5500);
    // 真机实测：后台期又来一次 visibilitychange，旧实例已被摘掉，这一拍读不到 buffer。
    w.sandbox.xterm = null;
    w.sandbox.capture();
    assert.equal(w.sandbox.frame, first, "空帧不许覆盖有效交接单");
    assert.equal(w.sandbox.frame.buffer.viewportY, 5500);
    w.sandbox.resume();
    assert.equal(w.sandbox.pending, true, "交接单仍交给紧随其后的重建");
  });

  it("重复转折守卫与落位判据：源码级钉子", () => {
    assert.match(extractFn("captureTerminalForegroundFrame"), /terminalForegroundFrame\?\.buffer\) return/,
      "空帧早退守卫在");
    const restoreBody = extractFn("installTerminalFollowBottomGuard")
      .match(/restore: \(saved\) => \{[\s\S]*?\n      \},/)?.[0];
    assert.ok(restoreBody, "护栏落位函数可取样");
    assert.doesNotMatch(restoreBody, /!buffer\.hasScrollback/,
      "本版 xterm 普通缓冲区的 hasScrollback 实测为 null，不能当布尔闸");
  });

  it("回前台无条件收外层空白带：不看开关、不等用户上滚意图，且幂等", () => {
    const w = handoffWorld();
    w.sandbox.capture();
    w.sandbox.resume();
    assert.deepEqual(w.screen.writes, [0], "406.7px 的带被收掉，恰好一笔");
    assert.equal(w.screen.scrollTop, 0, "回到自然停靠位");
    assert.equal(w.screen.dataset.bottomAlignTrim, "400", "调试属性记下被吃的带高");
    assert.equal(w.sandbox.pending, true, "交接单排给紧随其后的重建");

    const afterFirst = w.screen.writes.length;
    w.sandbox.trim();
    assert.equal(w.screen.writes.length, afterFirst, "再收一次零写");
    w.screen.scrollHeight = 602;
    w.screen.scrollTop = 2;
    const afterReset = w.screen.writes.length;
    w.sandbox.trim();
    assert.equal(w.screen.writes.length, afterReset, "行高取整残余（2px）不动");
    assert.equal(w.screen.scrollTop, 2);
  });

  it("非终端页回前台：交接单作废，pending 不外溢到下一次无关重建", () => {
    const w = handoffWorld();
    w.sandbox.capture();
    w.sandbox.view = "stats";
    w.sandbox.resume();
    assert.equal(w.sandbox.frame, null);
    assert.equal(w.sandbox.pending, false);
    assert.equal(w.clock.pending, 0, "不留安全定时器");
  });

  it("等到重建仍没起来：安全上限到点整组作废", () => {
    const w = handoffWorld();
    w.sandbox.capture();
    w.sandbox.resume();
    assert.equal(w.sandbox.pending, true);
    w.clock.advance(5000);
    assert.equal(w.sandbox.frame, null);
    assert.equal(w.sandbox.pending, false);
  });

  it("回放写入静默后落位再揭幕：交接单交到新实例、垫片扣住到落定", () => {
    const w = handoffWorld();
    w.sandbox.capture();
    w.sandbox.resume();
    w.sandbox.begin();
    assert.equal(w.stale.restorePending, true, "揭幕判据先扣住");
    assert.equal(w.stale.foregroundFrame, true, "揭幕那一拍收带");
    assert.equal(w.state.restoreCalls.length, 0, "回放还没静默，不提前落位");

    w.write();
    w.clock.advance(50);
    assert.equal(w.state.restoreCalls.length, 0, "静默窗未满");
    w.clock.advance(150);
    assert.equal(w.state.restoreCalls.length, 1, "静默一拍后落位");
    assert.equal(w.state.restoreCalls[0].viewportY, 5500);
    assert.equal(w.state.restoreCalls[0].followBottom, false);
    assert.equal(w.stale.restorePending, false, "落定即放行揭幕");
    assert.equal(w.sandbox.frame, null, "交接单一次性消费");
    assert.equal(w.sandbox.pending, false, "回放闩旗标收回");
    assert.equal(w.state.disposed, 1, "写帧监听已摘");
    assert.equal(w.clock.pending, 0, "轮询与安全定时器都收干净");
  });

  it("垫片被兜底撤走 / 实例被顶替 / 会话变了 / 交接窗内用户动过：一律放弃落位但放行揭幕", () => {
    const scenarios = [
      (w) => { w.stale.done = true; },
      (w) => { w.sandbox.xterm = { ...w.term, buffer: w.term.buffer }; },
      (w) => { w.sandbox.bound = "sess-2"; },
      (w) => { w.sandbox.userActionAt = w.clock.now + 1; },
      (w) => { w.sandbox.staleScreen = { done: false, restorePending: false }; },
    ];
    for (const mutate of scenarios) {
      const w = handoffWorld();
      w.sandbox.capture();
      w.sandbox.resume();
      w.sandbox.begin();
      mutate(w);
      w.write();
      w.clock.advance(200);
      assert.equal(w.state.restoreCalls.length, 0, "不许在可见画面上再 scrollToLine");
      assert.equal(w.stale.restorePending, false, "揭幕不被永久扣住");
      assert.equal(w.sandbox.pending, false);
      assert.equal(w.clock.pending, 0);
    }
  });

  it("连接失败没有写入：安全上限到点收摊、放行揭幕", () => {
    const w = handoffWorld();
    w.sandbox.capture();
    w.sandbox.resume();
    w.sandbox.begin();
    w.clock.advance(2500);
    assert.equal(w.state.restoreCalls.length, 0);
    assert.equal(w.stale.restorePending, false);
    assert.equal(w.sandbox.frame, null);
    assert.equal(w.clock.pending, 0);
  });

  it("护栏桥缺位（桩/降级）：只收带、放行揭幕，不抛错", () => {
    const w = handoffWorld();
    w.sandbox.capture();
    w.sandbox.resume();
    w.sandbox.handoff = null;
    w.sandbox.begin();
    w.write();
    w.clock.advance(200);
    assert.equal(w.stale.restorePending, false);
    assert.equal(w.sandbox.frame, null);
  });
});

// 护栏桥的「落位」在产线里由新实例的护栏闭包执行：行数差折算、跟随态与地板过岸。
describe("后台切回屏面交接：新实例护栏落位", () => {
  function guardWorld({ alignOn = true, length = 5030, baseY = 5000 } = {}) {
    const bodies = [
      "terminalEffectiveBottomBase", "installTerminalFollowBottomGuard",
    ].map(extractFn).join("\n");
    const clock = makeClock();
    const state = { alignOn, scrollToLineCalls: [], scrollToBottomCount: 0 };
    const viewport = { handlers: {}, addEventListener(t, fn) { (this.handlers[t] ||= []).push(fn); }, fire(t) { for (const fn of this.handlers[t] || []) fn(); } };
    const root = {
      isConnected: true, handlers: {},
      addEventListener(t, fn) { (this.handlers[t] ||= []).push(fn); },
      querySelector: (sel) => (sel === ".xterm-viewport" ? viewport : null),
    };
    const lines = Array.from({ length }, (_, i) => (i < 5010 ? `line ${i}` : ""));
    const buffer = {
      type: "normal", hasScrollback: true, length, baseY, viewportY: 0,
      getLine: (y) => (y >= 0 && y < lines.length ? { translateToString: () => lines[y] } : undefined),
    };
    const term = {
      rows: 30, element: root, buffer: { active: buffer },
      scrollToLine(line) { state.scrollToLineCalls.push(line); buffer.viewportY = line; },
      scrollToBottom() { state.scrollToBottomCount += 1; },
      onWriteParsed() {}, onResize() {},
    };
    const sandbox = new Function("state", "clock", "term", `
      ${decl("TERMINAL_SCROLL_INTENT_MS")}
      ${decl("TERMINAL_EFFECTIVE_BOTTOM_SETTLE_MS")}
      const Date = { now: () => clock.now };
      const setTimeout = (fn, ms) => clock.setTimeout(fn, ms);
      const clearTimeout = (id) => clock.clearTimeout(id);
      function terminalBottomAlignEnabled() { return state.alignOn; }
      function $(id) { return id === "terminalView" ? { hidden: false } : null; }
      let terminalImeHold = null;
      let terminalReplayRestoring = false;
      let terminalReplayRestoreArm = null;
      let terminalReplayRestoreCancel = null;
      let terminalFrameHandoff = null;
      ${bodies}
      installTerminalFollowBottomGuard(term);
      return {
        get bridge() { return terminalFrameHandoff; },
        get followBottom() { return terminalFrameHandoff.read().followBottom; },
        get floor() { return terminalFrameHandoff.read().floor; },
      };
    `)(state, clock, term);
    return { state, clock, term, buffer, viewport, sandbox };
  }

  it("镜像历史被裁 1000 行：阅读位与地板同步扣减，跟随态按切走前恢复", () => {
    const w = guardWorld();
    assert.equal(w.sandbox.bridge.term, w.term, "桥绑定当前实例");
    assert.equal(w.sandbox.bridge.restore({ viewportY: 5500, length: 6030, followBottom: false, floor: 5990 }), true);
    assert.deepEqual(w.state.scrollToLineCalls, [4500], "5500 - 1000 = 4500，落回切走前那一行");
    assert.equal(w.sandbox.followBottom, false, "读历史的人不被 fresh 实例的出厂跟随拽回底");
    assert.equal(w.sandbox.floor, 4990, "地板 5990 - 1000 = 4990，夹在 [有效底, 真尾] 内");
  });

  it("切走前贴底跟随：落点仍是新缓冲真尾，跟随态为 true", () => {
    const w = guardWorld();
    w.sandbox.bridge.restore({ viewportY: 6000, length: 6030, followBottom: true, floor: 6000 });
    assert.deepEqual(w.state.scrollToLineCalls, [5000]);
    assert.equal(w.sandbox.followBottom, true);
  });

  it("开关关：地板回退真尾，落位只改阅读行不改跟随语义", () => {
    const w = guardWorld({ alignOn: false });
    w.sandbox.bridge.restore({ viewportY: 5500, length: 6030, followBottom: false, floor: 5990 });
    assert.deepEqual(w.state.scrollToLineCalls, [4500]);
    assert.equal(w.sandbox.followBottom, false);
    assert.equal(w.sandbox.floor, 5000, "开关关时护栏地板恒为真尾");
  });

  it("备屏 / 缺交接数据：安全早退；hasScrollback 为 null 不影响落位", () => {
    const w = guardWorld();
    w.buffer.type = "alternate";
    assert.equal(w.sandbox.bridge.restore({ viewportY: 5500, length: 6030, followBottom: false, floor: 5990 }), false);
    w.buffer.type = "normal";
    // 真机实测：本版 xterm 普通缓冲区的 hasScrollback 是 null，拿它当布尔闸会把
    // 每次落位都判成不可滚，用户看到的是 fresh 实例真尾加一屏空白。
    w.buffer.hasScrollback = null;
    assert.equal(w.sandbox.bridge.restore({ viewportY: 5500, length: 6030, followBottom: false, floor: 5990 }), true);
    assert.deepEqual(w.state.scrollToLineCalls, [4500]);
    w.state.scrollToLineCalls.length = 0;
    w.buffer.hasScrollback = true;
    assert.equal(w.sandbox.bridge.restore(null), false);
    assert.deepEqual(w.state.scrollToLineCalls, []);
  });
});

test("接线自检：交接单四个真身都能从 panel.js 完整取样", () => {
  for (const name of [
    "trimTerminalOuterBand", "captureTerminalForegroundFrame",
    "resumeTerminalForegroundFrame", "beginTerminalForegroundRestore",
  ]) {
    assert.ok(extractFn(name).endsWith("\n  }"), `${name} 取样完整`);
  }
});
