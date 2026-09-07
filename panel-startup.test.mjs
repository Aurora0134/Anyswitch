import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("./panel-ui/panel.html", import.meta.url), "utf8");
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
function page(url = "http://127.0.0.1:47820/panel?startup=1", { reduce = false, navigation = "navigate" } = {}) {
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
    ]) {
      const p = page(url, { navigation });
      p.bootstrap();
      assert.equal(p.root.getAttribute("data-startup"), null);
      assert.equal(p.context.panelStartupLaunch, undefined, "非 launcher 首开不打点，刷新仍恢复上次 tab");
      assert.equal(p.timers.size, 0);
    }
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
    p.elements.get("startupLogo").dispatch("load");
    p.advance(500);
    const midScale = Number(nodesG.getAttribute("transform").match(/scale\(([\d.]+)\)/)[1]);
    assert.ok(midScale < firstScale, "scale 随时间向 1 收敛");
    assert.equal(p.root.getAttribute("data-startup"), "playing");
    p.advance(1100);
    assert.equal(nodesG.getAttribute("transform"), "", "settle 后 transform 清空，几何回到算死的终值");
    assert.equal(nodes[1].getAttribute("cy"), "121");
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

  it("does not block the exit chain on a PNG error", () => {
    const p = page();
    p.start();
    p.advance(1100);
    p.context.panelStartupController.ready();
    p.elements.get("startupLogo").dispatch("error");
    // PNG 失败只打 data-logo 标记，不阻塞退场：settled && ready 齐备即 leaving。
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
    assert.equal(p.elements.get("startupNodes").children[1].getAttribute("cy"), "121");
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

  it("excludes the center node from every pulse edge and paces bursts at 50ms within a 160ms window", () => {
    const p = page();
    p.start();
    const edges = p.elements.get("startupEdges").children;
    // 随机脉冲池只从边缘 6 点构对 C(6,2)=15 条，中心点不参与快闪；另有 6 条
    // 中心辐射线只参与定格，born 恒为 -Infinity，脉冲永不触发。
    assert.equal(edges.length, 21);
    const pulseEdges = edges.slice(0, 15);
    const hubEdges = edges.slice(15);
    for (const e of pulseEdges) {
      const endpoints = [[e.getAttribute("x1"), e.getAttribute("y1")], [e.getAttribute("x2"), e.getAttribute("y2")]];
      for (const [x, y] of endpoints) assert.ok(!(x === "256" && y === "251"), "脉冲线端点不含中心点");
    }
    for (const e of hubEdges) {
      assert.equal(e.getAttribute("x1"), "256", "辐射线起点是中心点");
      assert.equal(e.getAttribute("y1"), "251", "辐射线起点是中心点");
    }
    p.advance(0);
    p.advance(25);
    assert.ok(pulseEdges.some((e) => Number(e.getAttribute("opacity")) > 0), "脉冲爬升段可见");
    assert.ok(hubEdges.every((e) => Number(e.getAttribute("opacity")) === 0), "辐射线在脉冲阶段不亮");
    // 窗口与间隔常数从源码字面量钉死，防调参漂移（行为断言受并发脉冲干扰不可靠）。
    const src = html.match(/<script id="panelStartupAnimation">([\s\S]*?)<\/script>/)[1];
    assert.ok(src.includes("time - lastBurst >= 50"), "burst 间隔 50ms");
    assert.ok(src.includes("age < 160"), "脉冲窗口 160ms");
    assert.ok(src.includes("age / 160 * Math.PI"), "脉冲缓动按 160ms 归一");
    assert.ok(src.includes("reduce ? 0 : 240"), "退场重叠 240ms");
  });

  it("keeps page content visible under the acrylic and fades only the splash layer on leave", () => {
    // playing 期间主页内容若压透明，亚克力 backdrop-filter 后面是空白，模糊质感
    // 就没了。leaving 时主页本来就在，无需淡入——只淡出开屏层。选择器若用
    // :not(#panelStartup) 反选，特异性取括号内 ID 级，会压过 .toast/.modal-overlay
    // 默认的 opacity:0，导致浮动层被强制淡入成短暂可见的"弹窗"。钉死：playing
    // 只拦指针不压透明，leaving 只淡出开屏层，不出现 :not() 反选形式。
    const css = html.match(/<style>([\s\S]*?)<\/style>/g).find((b) => b.includes("data-startup"));
    const playingRule = css.match(/html\[data-startup="playing"\] body > header[^{]*\{([^}]*)\}/)?.[1] ?? "";
    assert.ok(playingRule.includes("pointer-events: none"), "playing 拦指针");
    assert.ok(!playingRule.includes("opacity"), "playing 不压透明，亚克力有内容可透");
    assert.ok(css.includes('html[data-startup="leaving"] #panelStartup'), "leaving 淡出开屏层");
    assert.ok(!css.includes(':not(#panelStartup):not(script)'), "不用 :not() 反选压过浮动层默认态");
  });

  it("signals readiness only after initial status and the restored view have settled", async () => {
    const init = html.match(/async function init\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(init);
    let statusDone, viewDone, ready = false;
    const context = {
      window: { panelStartupController: { ready: () => { ready = true; } } },
      startupViewReady: new Promise((resolve) => { viewDone = resolve; }),
      startStatusPolling: () => new Promise((resolve) => { statusDone = resolve; }),
      requestAnimationFrame: (fn) => fn(),
    };
    for (const name of ["initTheme", "initStylePicker", "initSettingsModal", "initRelayControls", "initSkillsTab", "initPresetsTab", "initStoreTab", "initStatsTab", "loadAutostartState", "refreshRouteChainsCache", "refreshRouteRuntimeCache", "startLogStream"]) context[name] = () => {};
    const pending = runInNewContext(`${init}; init()`, context);
    await new Promise((resolve) => setImmediate(resolve));
    statusDone();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ready, false);
    viewDone();
    await pending;
    assert.equal(ready, true);
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
    p.advance(6_280);
    assert.equal(nodes[1].getAttribute("cy"), "121");
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
});
