import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("./panel-ui/panel.html", import.meta.url), "utf8");
// 开屏样式规则在 panel.css（原 body 内 <style> 块）；init() 等主脚本逻辑在 panel.js
const panelCss = readFileSync(new URL("./panel-ui/panel.css", import.meta.url), "utf8");
const panelJs = readFileSync(new URL("./panel-ui/panel.js", import.meta.url), "utf8");
function script(id) {
  const match = html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)<\\/script>`));
  assert.ok(match, `startup script ${id} is present`);
  return match[1];
}
function element() {
  const attrs = new Map();
  const listeners = new Map();
  return {
    style: {}, children: [], removed: false,
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.get(k) ?? null; },
    removeAttribute(k) { attrs.delete(k); },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren() { this.children.length = 0; },
    remove() { this.removed = true; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    dispatch(type) { listeners.get(type)?.({ type, matches: type === "change" }); },
  };
}
function page(url = "http://127.0.0.1:47820/panel?startup=1", { reduce = false, navigation = "navigate", splashAnim = null } = {}) {
  let now = 0, serial = 0;
  const timers = new Map(), frames = new Map(), root = element();
  const elements = new Map(["panelStartup", "startupSvg", "startupEdges", "startupNodes", "startupLogo"].map((id) => [id, element()]));
  const context = {
    URL, Math, console,
    location: { href: url },
    history: { state: { preserved: true }, replaceState(state, _, value) { this.state = state; context.location.href = String(value); } },
    performance: { now: () => now, getEntriesByType: () => [{ type: navigation }] },
    document: { documentElement: root, getElementById: (id) => elements.get(id), createElementNS: () => element() },
    matchMedia: () => ({ matches: reduce, addEventListener() {}, removeEventListener() {} }),
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, due: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { const id = ++serial; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  context.window = context;
  // 桩环境本来没有 localStorage，bootstrap 的读档落在 try/catch 里按「开」处理——
  // 未点明 splashAnim 的那些用例因此一字不用改。点明了才造一个真读得到存档的环境：
  // true/false 是开关的两个存档值，"denied" 模拟本地存储整个读不了（隐私模式／桩缺件）。
  if (splashAnim !== null) {
    context.localStorage = splashAnim === "denied"
      ? { getItem: () => { throw new Error("denied"); }, setItem() {} }
      : { getItem: (k) => (k === "panel-startup-animation" ? (splashAnim ? "1" : "0") : null), setItem() {} };
  }
  return { context, root, elements, timers, frames,
    bootstrap() { runInNewContext(script("panelStartupBootstrap"), context); },
    start() { this.bootstrap(); runInNewContext(script("panelStartupAnimation"), context); },
    advance(time) {
      now = time;
      for (const [id, timer] of [...timers]) if (timer.due <= now && timers.delete(id)) timer.fn();
      for (const [id, frame] of [...frames]) if (frames.delete(id)) frame(now);
    },
  };
}

describe("launcher-only startup screen", () => {
  it("consumes the launcher marker while preserving other URL state", () => {
    const p = page("http://127.0.0.1:47820/panel?startup=1&keep=yes#details");
    p.bootstrap();
    assert.equal(p.root.getAttribute("data-startup"), "playing");
    assert.equal(p.context.panelStartupLaunch, true, "launcher 首开打点，主脚本据此固定落看板页");
    assert.equal(p.context.location.href, "http://127.0.0.1:47820/panel?keep=yes#details");
    assert.equal(p.context.history.state.preserved, true);
  });

  it("does not replay for direct visits, refreshes or history restoration", () => {
    for (const [url, navigation] of [
      ["http://127.0.0.1:47820/panel", "navigate"],
      ["http://127.0.0.1:47820/panel?startup=1", "reload"],
      ["http://127.0.0.1:47820/panel?startup=1", "back_forward"],
      ["http://127.0.0.1:47820/panel?startup=restart", "reload"],
    ]) {
      const p = page(url, { navigation });
      p.bootstrap();
      assert.equal(p.root.getAttribute("data-startup"), null);
      assert.equal(p.context.panelStartupLaunch, undefined, "非 launcher 首开不打点，刷新仍恢复上次 tab");
      assert.equal(p.context.panelStartupRestart, undefined, "非重启恢复不打点");
      assert.equal(p.timers.size, 0);
    }
  });

  it("consumes the restart marker: splash replays from first paint without pinning the board view", () => {
    const p = page("http://127.0.0.1:47820/panel?startup=restart&keep=yes");
    p.bootstrap();
    assert.equal(p.root.getAttribute("data-startup"), "playing", "重启恢复首绘即接力开屏层");
    assert.equal(p.context.panelStartupRestart, true, "重启恢复打点，restoreView 据此播入场动画");
    assert.equal(p.context.panelStartupLaunch, undefined, "不打 launcher 首开点——不固定落看板，仍恢复上次 tab");
    assert.equal(p.context.location.href, "http://127.0.0.1:47820/panel?keep=yes", "标记即清，二次刷新不复播");
  });

  it("关掉开屏动画：遮挡层连定格画面都不出现，URL 标记照消费、首开落看板照打点", () => {
    const p = page("http://127.0.0.1:47820/panel?startup=1&keep=yes", { splashAnim: false });
    p.start(); // bootstrap + panelStartupPlay：后者开头就问控制器在不在，不在即整条链路空转
    assert.equal(p.root.getAttribute("data-startup"), null, "关着就不挂遮挡层");
    assert.equal(p.context.panelStartupController, undefined);
    assert.equal(p.frames.size, 0, "不起脉冲帧");
    assert.equal(p.timers.size, 0, "连兜底时限都不起");
    assert.equal(p.context.panelStartupLaunch, true, "落位规则与开屏无关：launcher 首开仍固定落看板");
    assert.equal(p.context.location.href, "http://127.0.0.1:47820/panel?keep=yes", "标记照消费，二次刷新不再认首开");
  });

  it("关掉开屏动画：重启回跳不出层，也不打恢复点", () => {
    // 恢复点是主脚本「入场动画等开屏淡出那一帧再播」的发令枪，而它只在开屏控制器
    // 在场时才被消费并清掉。没有控制器还打点，那份待播入场动画名就永久悬着，下一次
    // 重启会把上一次的也一起放出来。不打点则重启回跳落回普通刷新的既有表现：直接落位。
    const p = page("http://127.0.0.1:47820/panel?startup=restart&keep=yes", { splashAnim: false });
    p.start();
    assert.equal(p.root.getAttribute("data-startup"), null);
    assert.equal(p.context.panelStartupController, undefined);
    assert.equal(p.timers.size, 0);
    assert.equal(p.context.panelStartupRestart, undefined, "不打恢复点");
    assert.equal(p.context.panelStartupLaunch, undefined, "重启回跳不是首开");
    assert.equal(p.context.location.href, "http://127.0.0.1:47820/panel?keep=yes", "标记即清");
  });

  it("开屏动画显式存「开」与读不到存档，都按原样出层播脉冲", () => {
    for (const splashAnim of [true, "denied"]) {
      const p = page("http://127.0.0.1:47820/panel?startup=1", { splashAnim });
      p.start();
      assert.equal(p.root.getAttribute("data-startup"), "playing", `${splashAnim} 仍出层`);
      assert.ok(p.frames.size > 0, "照常播脉冲");
      assert.equal(p.context.panelStartupLaunch, true);
    }
  });

  it("settles immediately on restart recovery instead of replaying the pulse animation", () => {
    const p = page("http://127.0.0.1:47820/panel?startup=restart");
    p.start();
    // 脉冲动画用户在旧页面已看过一遍，新页面重播就是「多播放了一次」：
    // 首帧即定格（无 scale 外扩、无 rAF 循环、data-phase=settled），开屏层只盖首刷 + 淡出。
    const nodesG = p.elements.get("startupNodes");
    assert.equal(nodesG.getAttribute("transform"), "", "首帧即定格，不从 scale(1.12) 重播收缩");
    assert.equal(p.elements.get("panelStartup").getAttribute("data-phase"), "settled");
    assert.equal(p.frames.size, 0, "不起 rAF 脉冲循环");
    // 定格后仍等 ready 信号才淡出（盖首刷的职责不变），onLeave 链不受影响。
    assert.equal(p.root.getAttribute("data-startup"), "playing");
    let left = 0;
    p.context.panelStartupController.onLeave = () => { left++; };
    p.context.panelStartupController.ready();
    p.advance(1);
    assert.equal(p.root.getAttribute("data-startup"), "leaving");
    assert.equal(left, 1, "onLeave 仍在淡出起点触发");
    p.advance(241);
    assert.equal(p.root.getAttribute("data-startup"), null);
  });

  it("does not mistake a browser window named element for an active startup controller", () => {
    const p = page("http://127.0.0.1:47820/panel");
    p.context.panelStartup = p.elements.get("panelStartup");
    p.start();
    assert.equal(p.frames.size, 0);
    assert.equal(p.elements.get("startupLogo").src, undefined);
  });

  it("unblocks the page if the main script never starts", () => {
    const p = page();
    p.bootstrap();
    p.advance(3000);
    assert.equal(p.root.getAttribute("data-startup"), null);
    assert.equal(p.context.panelStartupController, undefined);
    assert.equal(p.elements.get("panelStartup").removed, false);
  });

  it("converges seven nodes to the brand geometry before revealing the page", () => {
    const p = page();
    p.start();
    p.advance(0);
    const nodes = p.elements.get("startupNodes").children;
    const nodesG = p.elements.get("startupNodes");
    assert.equal(nodes.length, 7);
    assert.equal(nodes[0].getAttribute("cx"), "256");
    assert.equal(nodes[0].getAttribute("cy"), "251");
    // 几何在初始化时按最终位置算死，收缩动画由容器 <g> 的整体 transform 承担：
    // 起始 scale > 1（外扩），随时间推进向 1 收敛，settle 后 transform 清空。
    const firstTransform = nodesG.getAttribute("transform");
    assert.ok(firstTransform.includes("scale("), "起始帧容器带 scale 变换");
    const firstScale = Number(firstTransform.match(/scale\(([\d.]+)\)/)[1]);
    assert.ok(firstScale > 1, "outer nodes start farther from the center via container scale");
    p.context.panelStartupController.ready();
    p.advance(500);
    const midScale = Number(nodesG.getAttribute("transform").match(/scale\(([\d.]+)\)/)[1]);
    assert.ok(midScale < firstScale, "scale 随时间向 1 收敛");
    assert.equal(p.root.getAttribute("data-startup"), "playing");
    p.advance(1100);
    assert.equal(nodesG.getAttribute("transform"), "", "settle 后 transform 清空，几何回到算死的终值");
    assert.equal(p.elements.get("panelStartup").getAttribute("data-phase"), "settled");
    // settle 无干等：ready 早已就位，定格帧画完隔一帧 leaving（防淡出被吞），240ms 后退场完毕。
    assert.equal(p.root.getAttribute("data-startup"), "playing");
    p.advance(1101);
    assert.equal(p.root.getAttribute("data-startup"), "leaving");
    p.advance(1341);
    assert.equal(p.root.getAttribute("data-startup"), null);
    assert.equal(p.frames.size, 0);
    assert.equal(p.timers.size, 0);
  });

  it("leaves as soon as the settled frame is drawn and data is ready, without waiting for the PNG", () => {
    const p = page();
    p.start();
    p.advance(1100);
    // settle 立即 settled，但 ready 未就位，仍停 playing。
    assert.equal(p.root.getAttribute("data-startup"), "playing");
    p.context.panelStartupController.ready();
    // ready 一就位触发 leave，但 leaving 隔一帧才生效（防淡出被吞），240ms 后退场完毕。
    p.advance(1101);
    assert.equal(p.root.getAttribute("data-startup"), "leaving");
    p.advance(1341);
    assert.equal(p.root.getAttribute("data-startup"), null);
    assert.equal(p.context.panelStartupController, undefined);
    assert.equal(p.elements.get("panelStartup").removed, false);
  });

  it("fires onLeave at the exact frame the splash starts fading, not at ready()", () => {
    const p = page();
    p.start();
    let left = 0;
    p.context.panelStartupController.onLeave = () => { left++; };
    // ready 提前就位（数据快于 1100ms 动画）：onLeave 不能在此时触发——开屏层还盖着，
    // 此刻播入场动画会在底下播完。
    p.context.panelStartupController.ready();
    p.advance(500);
    assert.equal(left, 0, "ready 时就触发 = 动画在开屏层底下播完");
    assert.equal(p.root.getAttribute("data-startup"), "playing");
    // settle 到位触发 leave，leaving 隔一帧生效——onLeave 与淡出起点同帧。
    p.advance(1100);
    assert.equal(left, 0, "settle 帧只提交定格，淡出尚未开始");
    p.advance(1101);
    assert.equal(p.root.getAttribute("data-startup"), "leaving");
    assert.equal(left, 1, "淡出起点那一帧触发一次");
    assert.equal(p.context.panelStartupController.onLeave, null, "触发后自清——复播/失败收回路径不会重放旧钩子");
    p.advance(1341);
    assert.equal(left, 1, "退场完毕不重复触发");
  });

  it("does not block the exit chain on a PNG error", () => {
    const p = page();
    p.start();
    p.advance(0);
    // PNG 在动画中途加载失败：error 打 data-logo 标记（CSS 兜底挂点），但它
    // 既不触发退场、也不是退场门槛——放行仍只看 settled && ready。error 派发
    // 必须落在 done 之前：leave() 一旦提交（ready 后），handler 的 !done 守卫
    // 会拦下标记，派发就成空操作了。
    p.elements.get("startupLogo").dispatch("error");
    assert.equal(p.elements.get("panelStartup").getAttribute("data-logo"), "failed", "PNG 失败打 data-logo 标记");
    assert.equal(p.root.getAttribute("data-startup"), "playing", "error 本身不触发退场");
    p.advance(1100);
    assert.equal(p.root.getAttribute("data-startup"), "playing", "PNG 失败不改变退场门槛，仍等 ready");
    p.context.panelStartupController.ready();
    p.advance(1101);
    assert.equal(p.root.getAttribute("data-startup"), "leaving");
    p.advance(1341);
    assert.equal(p.root.getAttribute("data-startup"), null);
  });

  it("releases a stalled initialization after three seconds and stops every animation timer", () => {
    const p = page();
    p.start();
    p.advance(3000);
    // deadline 触发 leave，leaving 隔一帧生效，240ms 后退场完毕。
    p.advance(3001);
    assert.equal(p.root.getAttribute("data-startup"), "leaving");
    p.advance(3241);
    assert.equal(p.root.getAttribute("data-startup"), null);
    assert.equal(p.context.panelStartupController, undefined);
    assert.equal(p.elements.get("panelStartup").removed, false);
    assert.equal(p.frames.size, 0);
    assert.equal(p.timers.size, 0);
  });

  it("skips moving nodes for reduced motion while still waiting for readiness", () => {
    const p = page(undefined, { reduce: true });
    p.start();
    p.advance(0);
    assert.equal(p.frames.size, 0);
    // cy 是创建时写死的常量、运行期从不回写，不足以证明「没在动」；有效证据是
    // reduce 路径直接 settle()——容器 transform 清空，不从 scale(1.12) 重播收缩。
    assert.equal(p.elements.get("startupNodes").getAttribute("transform"), "", "reduce 首帧即定格：容器不带 scale 变换");
    assert.equal(p.root.getAttribute("data-startup"), "playing");
    p.context.panelStartupController.ready();
    // reduce 路径 settle 立即 settled，ready 一就位触发 leave，leaving 隔一帧生效，removeTimer 为 0。
    p.advance(1);
    assert.equal(p.root.getAttribute("data-startup"), "leaving");
    p.advance(2);
    assert.equal(p.root.getAttribute("data-startup"), null);
  });

  it("keeps random edges bounded and finishes with the full hub topology", () => {
    const p = page();
    p.start();
    for (let t = 40; t < 880; t += 40) {
      p.advance(t);
      const visible = p.elements.get("startupEdges").children.filter((e) => Number(e.getAttribute("opacity")) > 0);
      assert.ok(visible.length <= 3);
      for (const e of visible) assert.ok(e.getAttribute("x1") !== e.getAttribute("x2") || e.getAttribute("y1") !== e.getAttribute("y2"));
    }
    p.advance(1100);
    // 终态 = logo.png 的轮毂结构：6 条边缘环 + 6 条中心辐射线，共 12 条。
    const final = p.elements.get("startupEdges").children.filter((e) => e.getAttribute("opacity") === "1");
    assert.equal(final.length, 12);
  });

  it("keeps the center out of the ring pairs, pools every line for the pulse, and paces bursts at 50ms within a 160ms window", () => {
    const p = page();
    p.start();
    const edges = p.elements.get("startupEdges").children;
    // 21 条线 = 15 条边缘构对（端点不含中心点）+ 6 条中心辐射线（起点是中心点）。
    // 两类都在洗牌脉冲池里：抽中哪条哪条闪，辐射线不享有「永不脉冲」的豁免。
    assert.equal(edges.length, 21);
    const ringPairs = edges.slice(0, 15);
    const hubLines = edges.slice(15);
    for (const e of ringPairs) {
      const endpoints = [[e.getAttribute("x1"), e.getAttribute("y1")], [e.getAttribute("x2"), e.getAttribute("y2")]];
      for (const [x, y] of endpoints) assert.ok(!(x === "256" && y === "251"), "边缘构对端点不含中心点");
    }
    for (const e of hubLines) {
      assert.equal(e.getAttribute("x1"), "256", "辐射线起点是中心点");
      assert.equal(e.getAttribute("y1"), "251", "辐射线起点是中心点");
    }
    // 行为化钉住发夹节奏（不比对源码字面量）：按 50ms 步进，t=50/100/150 同时
    // 亮的线数恰为 1/2/3——发车间隔 50ms（t=50 才轮到第二发）与脉冲窗 160ms
    // （窗内各发同屏叠亮）的联合结果，间隔或窗口一变序列即散架；发射帧 age=0
    // （sin(0)=0）不亮。
    const litCount = () => edges.filter((e) => Number(e.getAttribute("opacity")) > 0).length;
    const litIndexes = new Set();
    const sweep = (t) => {
      p.advance(t);
      edges.forEach((e, i) => { if (Number(e.getAttribute("opacity")) > 0) litIndexes.add(i); });
      return litCount();
    };
    p.advance(0);
    assert.equal(litCount(), 0, "发射帧 age=0，脉冲尚未爬升");
    assert.equal(sweep(50), 1, "间隔 50ms：t=50 才发第二发，此刻仅首发在窗内");
    assert.equal(sweep(100), 2, "相邻两发同窗叠亮");
    assert.equal(sweep(150), 3);
    // 脉冲期一路推进到 880ms 截止前：18 发（t=0 与 t=50..850）互不重复——洗牌
    // 队列耗尽前不重灌；15 条边缘构对凑不满 18 发，亮过的线必然含辐射线。观测
    // 止于 t=850：t≥880 起定格 lock 爬升，fixed 线改由 lock 点亮，会污染计数。
    for (let t = 200; t <= 850; t += 50) sweep(t);
    assert.equal(litIndexes.size, 17, "观测窗内 17 发两两不同（t=850 发射帧 age=0 尚未亮）");
    assert.ok([...litIndexes].some((i) => i >= 15), "亮过的线含辐射线——脉冲池不豁免辐射线");
  });

  it("keeps page content visible under the acrylic and fades only the splash layer on leave", () => {
    // playing 期间主页内容若压透明，亚克力 backdrop-filter 后面是空白，模糊质感
    // 就没了。leaving 时主页本来就在，无需淡入——只淡出开屏层。选择器若用
    // :not(#panelStartup) 反选，特异性取括号内 ID 级，会压过 .toast/.modal-overlay
    // 默认的 opacity:0，导致浮动层被强制淡入成短暂可见的"弹窗"。钉死：playing
    // 只拦指针不压透明，leaving 只淡出开屏层，不出现 :not() 反选形式。
    const css = panelCss;
    const playingRule = css.match(/html\[data-startup="playing"\] body > header[^{]*\{([^}]*)\}/)?.[1] ?? "";
    assert.ok(playingRule.includes("pointer-events: none"), "playing 拦指针");
    assert.ok(!playingRule.includes("opacity"), "playing 不压透明，亚克力有内容可透");
    assert.ok(css.includes('html[data-startup="leaving"] #panelStartup'), "leaving 淡出开屏层");
    assert.ok(!css.includes(':not(#panelStartup):not(script)'), "不用 :not() 反选压过浮动层默认态");
  });

  it("signals readiness only after initial status, the restored view and a trustworthy first board frame have settled", async () => {
    const init = panelJs.match(/async function init\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(init);
    let statusDone, viewDone, boardDone, ready = false;
    const context = {
      window: { panelStartupController: { ready: () => { ready = true; } } },
      restartEnterView: null,
      startupViewReady: new Promise((resolve) => { viewDone = resolve; }),
      startStatusPolling: () => new Promise((resolve) => { statusDone = resolve; }),
      requestAnimationFrame: (fn) => fn(),
      // 看板首帧闸：落看板页时开屏要等「这一帧能当事实说」（frame.ready，见 refreshAgents
      // 的帧闸）才退——请求一 resolve 就揭会把遮挡层掀在「什么都没跑」的静态基线上。
      // Promise.race 的 2500ms 上限由这里的 setTimeout 桩供，取数不通也让开屏照常淡出。
      boardVisible: () => true,
      boardLivePromise: new Promise((resolve) => { boardDone = resolve; }),
      setTimeout: () => 1,
      Promise,
    };
    for (const name of ["initTheme", "initStylePicker", "initBrandVersion", "initSettingsView", "initRelayControls", "initSkillsTab", "initPresetsTab", "initStoreTab", "initStatsTab", "initSessionsTab", "loadAutostartState", "refreshRouteChainsCache", "refreshRouteRuntimeCache", "startLogStream", "startSyncStatusPolling"]) context[name] = () => {};
    const pending = runInNewContext(`${init}; init()`, context);
    await new Promise((resolve) => setImmediate(resolve));
    statusDone();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ready, false);
    viewDone();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ready, false, "前两样都 settled 但看板还没拿到可信帧：不开屏不退场");
    boardDone();
    await pending;
    assert.equal(ready, true, "可信首帧到位即退场");
  });

  it("caps the board-frame wait so a board that never gets data still releases the splash", async () => {
    const init = panelJs.match(/async function init\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(init);
    const asked = [];
    const controller = { readyCount: 0, ready() { this.readyCount += 1; } };
    const context = {
      window: { panelStartupController: controller },
      restartEnterView: null,
      startupViewReady: Promise.resolve(),
      startStatusPolling: () => Promise.resolve(),
      requestAnimationFrame: (fn) => fn(),
      boardVisible: () => true,
      // 永不到来的首帧（relay 一直超预算）：不能把用户锁在开屏动画后面。
      boardLivePromise: new Promise(() => {}),
      // 桩里没有真时钟：init 挂的那道时限由这里记下再手动触发。
      setTimeout(fn, ms) { asked.push({ fn, ms }); return asked.length; },
      Promise,
    };
    for (const name of ["initTheme", "initStylePicker", "initBrandVersion", "initSettingsView", "initRelayControls", "initSkillsTab", "initPresetsTab", "initStoreTab", "initStatsTab", "initSessionsTab", "loadAutostartState", "refreshRouteChainsCache", "refreshRouteRuntimeCache", "startLogStream", "startSyncStatusPolling"]) context[name] = () => {};
    const pending = runInNewContext(`${init}; init()`, context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asked.length, 1, "等首帧挂了时限");
    assert.equal(asked[0].ms, 2500, "上限 2500ms，早于开屏自己的兜底时限");
    asked[0].fn();
    await pending;
    assert.equal(controller.readyCount, 1, "到点照常退场，画面交给骨架条");
  });

  it("does not wait for a board frame when the landing view is not the board", async () => {
    const init = panelJs.match(/async function init\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(init);
    const controller = { readyCount: 0, ready() { this.readyCount += 1; } };
    const context = {
      window: { panelStartupController: controller },
      restartEnterView: null,
      startupViewReady: Promise.resolve(),
      startStatusPolling: () => Promise.resolve(),
      requestAnimationFrame: (fn) => fn(),
      boardVisible: () => false,
      boardLivePromise: new Promise(() => {}),
      setTimeout: () => 1,
      Promise,
    };
    for (const name of ["initTheme", "initStylePicker", "initBrandVersion", "initSettingsView", "initRelayControls", "initSkillsTab", "initPresetsTab", "initStoreTab", "initStatsTab", "initSessionsTab", "loadAutostartState", "refreshRouteChainsCache", "refreshRouteRuntimeCache", "startLogStream", "startSyncStatusPolling"]) context[name] = () => {};
    await runInNewContext(`${init}; init()`, context);
    assert.equal(controller.readyCount, 1, "非看板落点不等那一帧，退场时机与改前一致");
  });

  it("hooks the restored view's enter animation onto onLeave when recovering from a restart", async () => {
    const init = panelJs.match(/async function init\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(init);
    const controller = { ready() {}, onLeave: null };
    const context = {
      window: { panelStartupController: controller },
      restartEnterView: "board",
      startupViewReady: Promise.resolve(),
      startStatusPolling: () => Promise.resolve(),
      requestAnimationFrame: (fn) => fn(),
      playBoardEnter() {},
      boardVisible: () => true,
      boardLivePromise: Promise.resolve(),
      setTimeout: () => 1,
    };
    for (const name of ["initTheme", "initStylePicker", "initBrandVersion", "initSettingsView", "initRelayControls", "initSkillsTab", "initPresetsTab", "initStoreTab", "initStatsTab", "initSessionsTab", "loadAutostartState", "refreshRouteChainsCache", "refreshRouteRuntimeCache", "startLogStream", "startSyncStatusPolling"]) context[name] = () => {};
    await runInNewContext(`${init}; init()`, context);
    assert.equal(typeof controller.onLeave, "function", "重启恢复时入场动画挂到开屏淡出起点");
    assert.equal(context.restartEnterView, null, "标记消费一次即清");
  });

  it("leaves onLeave untouched for the launcher first-paint path", async () => {
    const init = panelJs.match(/async function init\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(init);
    const controller = { ready() {}, onLeave: null };
    const context = {
      window: { panelStartupController: controller },
      restartEnterView: null,
      startupViewReady: Promise.resolve(),
      startStatusPolling: () => Promise.resolve(),
      requestAnimationFrame: (fn) => fn(),
      boardVisible: () => true,
      boardLivePromise: Promise.resolve(),
      setTimeout: () => 1,
    };
    for (const name of ["initTheme", "initStylePicker", "initBrandVersion", "initSettingsView", "initRelayControls", "initSkillsTab", "initPresetsTab", "initStoreTab", "initStatsTab", "initSessionsTab", "loadAutostartState", "refreshRouteChainsCache", "refreshRouteRuntimeCache", "startLogStream", "startSyncStatusPolling"]) context[name] = () => {};
    await runInNewContext(`${init}; init()`, context);
    assert.equal(controller.onLeave, null, "launcher 首开不挂钩子，行为不变");
  });

  it("replays over the resident layer for the restart window and resets between shows", () => {
    const p = page("http://127.0.0.1:47820/panel");
    p.start();
    assert.equal(p.root.getAttribute("data-startup"), null);
    p.context.panelStartupBegin(25_000);
    p.context.panelStartupPlay();
    assert.equal(p.context.panelStartupBegin(), p.context.panelStartupController, "已在播放中返回同一控制器");
    p.advance(1100);
    const nodes = p.elements.get("startupNodes").children;
    assert.equal(nodes.length, 7);
    assert.equal(p.elements.get("panelStartup").getAttribute("data-phase"), "settled");
    // 复播没有 ready 信号（init 早已跑完）：停在定格等重启流程收尾，不自动退场
    p.advance(5_000);
    assert.equal(p.root.getAttribute("data-startup"), "playing");

    p.context.panelStartupController.release();
    // release 触发 leave，leaving 隔一帧生效，240ms 后退场完毕。
    p.advance(5_001);
    assert.equal(p.root.getAttribute("data-startup"), "leaving");
    p.advance(5_241);
    assert.equal(p.root.getAttribute("data-startup"), null);

    p.context.panelStartupBegin(25_000);
    p.context.panelStartupPlay();
    assert.equal(p.root.getAttribute("data-startup"), "playing");
    assert.equal(p.elements.get("panelStartup").getAttribute("data-phase"), null);
    assert.equal(p.elements.get("startupNodes").children.length, 7);
    // 第二轮 startedAt=5241：推进到 6341 恰满 1100ms 动画窗，复播应照常定格。
    p.advance(6_341);
    assert.equal(p.elements.get("panelStartup").getAttribute("data-phase"), "settled", "复播重走完整时序后照常定格");
    assert.equal(p.elements.get("panelStartup").removed, false);
  });

  it("keeps the replayed splash up with its own fallback deadline", () => {
    const p = page("http://127.0.0.1:47820/panel");
    p.start();
    p.context.panelStartupBegin(25_000);
    p.context.panelStartupPlay();
    p.advance(24_999);
    assert.equal(p.root.getAttribute("data-startup"), "playing");
    p.advance(25_000);
    // deadline 触发 leave，leaving 隔一帧生效，240ms 后退场完毕。
    p.advance(25_001);
    assert.equal(p.root.getAttribute("data-startup"), "leaving");
    p.advance(25_241);
    assert.equal(p.root.getAttribute("data-startup"), null);
    assert.equal(p.context.panelStartupController, undefined);
    assert.equal(p.frames.size, 0);
    assert.equal(p.timers.size, 0);
  });

  it("plays the pulse for a restart the user starts from the restart-recovery page", () => {
    // 回归：用户点完重启跳到 ?startup=restart 的新页面，此后就常驻在这一页上。
    // 在这页上再点重启，如果只看「本页来自重启恢复」这个页面级标记，这一遍开屏
    // 会被静默吞成定格——整条重启链一帧动画都没有，只剩静止图标挂到淡出。
    const p = page("http://127.0.0.1:47820/panel?startup=restart");
    p.start();
    assert.equal(p.elements.get("panelStartup").getAttribute("data-phase"), "settled", "首绘接力定格");
    p.context.panelStartupBegin(25_000);
    p.context.panelStartupPlay(true); // playStartupSplash 的调用形态：显式要求播脉冲
    assert.ok(p.frames.size > 0, "用户主动触发的复播必须播脉冲，不受页面级标记压制");
    assert.equal(p.elements.get("panelStartup").getAttribute("data-phase"), null, "复播从定格态复位，不被冻结");
    p.advance(1_100);
    assert.equal(p.elements.get("panelStartup").getAttribute("data-phase"), "settled", "播完照常定格等接管");
  });

  it("plays the pulse on every page the restart can be started from", () => {
    for (const [label, url] of [
      ["launcher 首开页", "http://127.0.0.1:47820/panel?startup=1"],
      ["重启恢复页", "http://127.0.0.1:47820/panel?startup=restart"],
      ["手动打开页", "http://127.0.0.1:47820/panel"],
    ]) {
      const p = page(url);
      p.start();
      p.context.panelStartupBegin(25_000);
      p.context.panelStartupPlay(true);
      assert.ok(p.frames.size > 0, `${label} 上点重启都应播脉冲`);
    }
  });

  it("keeps reduced motion settled even when the restart path explicitly asks for the pulse", () => {
    const p = page("http://127.0.0.1:47820/panel", { reduce: true });
    p.start();
    p.context.panelStartupBegin(25_000);
    p.context.panelStartupPlay(true);
    assert.equal(p.frames.size, 0, "减少动态效果优先于复播请求，不因显式传参而破例");
    assert.equal(p.elements.get("panelStartup").getAttribute("data-phase"), "settled");
  });

  it("keeps the first paint settled only on the restart-recovery page, not on a plain boot", () => {
    // 首绘自动调用不带参数：只有「本页来自重启恢复」才定格，普通首开照旧播脉冲。
    const plain = page("http://127.0.0.1:47820/panel?startup=1");
    plain.start();
    assert.ok(plain.frames.size > 0, "launcher 首开首绘仍播脉冲");
    const restarted = page("http://127.0.0.1:47820/panel?startup=restart");
    restarted.start();
    assert.equal(restarted.frames.size, 0, "重启恢复首绘定格接力，不重播旧页面刚播过的脉冲");
  });
});
