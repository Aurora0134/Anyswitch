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
    assert.equal(p.elements.get("panelStartup").removed, true);
  });

  it("converges seven nodes to the brand geometry before revealing the page", () => {
    const p = page();
    p.start();
    p.advance(0);
    const nodes = p.elements.get("startupNodes").children;
    assert.equal(nodes.length, 7);
    assert.equal(nodes[0].getAttribute("cx"), "256");
    assert.equal(nodes[0].getAttribute("cy"), "251");
    const firstY = Number(nodes[1].getAttribute("cy"));
    assert.ok(firstY < 121, "outer top node starts farther from the center");
    p.context.panelStartupController.ready();
    p.elements.get("startupLogo").dispatch("load");
    p.advance(500);
    assert.ok(Number(nodes[1].getAttribute("cy")) > firstY);
    assert.equal(p.root.getAttribute("data-startup"), "playing");
    p.advance(1100);
    assert.equal(nodes[1].getAttribute("cy"), "121");
    assert.equal(p.elements.get("panelStartup").getAttribute("data-phase"), "settled");
    assert.equal(p.root.getAttribute("data-startup"), "playing");
    p.advance(1380);
    assert.equal(p.root.getAttribute("data-startup"), "leaving");
    p.advance(1580);
    assert.equal(p.root.getAttribute("data-startup"), null);
    assert.equal(p.frames.size, 0);
    assert.equal(p.timers.size, 0);
  });

  it("keeps the settled logo until data and the original PNG are ready", () => {
    const p = page();
    p.start();
    p.advance(1100);
    p.advance(1380);
    p.context.panelStartupController.ready();
    assert.equal(p.root.getAttribute("data-startup"), "playing");
    p.elements.get("startupLogo").dispatch("load");
    assert.equal(p.root.getAttribute("data-startup"), "playing");
    p.advance(1560);
    assert.equal(p.root.getAttribute("data-startup"), "leaving");
    p.advance(1740);
    assert.equal(p.elements.get("panelStartup").removed, true);
  });

  it("uses the three-second fallback when the original PNG fails", () => {
    const p = page();
    p.start();
    p.advance(1100);
    p.advance(1380);
    p.context.panelStartupController.ready();
    p.elements.get("startupLogo").dispatch("error");
    assert.equal(p.root.getAttribute("data-startup"), "playing");
    p.advance(3000);
    assert.equal(p.root.getAttribute("data-startup"), "leaving");
  });

  it("releases a stalled initialization after three seconds and stops every animation timer", () => {
    const p = page();
    p.start();
    p.advance(3000);
    assert.equal(p.root.getAttribute("data-startup"), "leaving");
    p.advance(3180);
    assert.equal(p.elements.get("panelStartup").removed, true);
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
    p.elements.get("startupLogo").dispatch("load");
    p.advance(1);
    assert.equal(p.root.getAttribute("data-startup"), "leaving");
    p.advance(2);
    assert.equal(p.root.getAttribute("data-startup"), null);
  });

  it("keeps random edges bounded and finishes with exactly the twelve logo edges", () => {
    const p = page();
    p.start();
    for (let t = 40; t < 880; t += 40) {
      p.advance(t);
      const visible = p.elements.get("startupEdges").children.filter((e) => Number(e.getAttribute("opacity")) > 0);
      assert.ok(visible.length <= 3);
      for (const e of visible) assert.ok(e.getAttribute("x1") !== e.getAttribute("x2") || e.getAttribute("y1") !== e.getAttribute("y2"));
    }
    p.advance(1100);
    const final = p.elements.get("startupEdges").children.filter((e) => e.getAttribute("opacity") === "1");
    assert.equal(final.length, 12);
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
    for (const name of ["initTheme", "initStylePicker", "initSettingsModal", "initAgyMapping", "initRelayControls", "initSkillsTab", "initPresetsTab", "initStoreTab", "initStatsTab", "loadAutostartState", "refreshRouteChainsCache", "refreshRouteRuntimeCache", "startLogStream"]) context[name] = () => {};
    const pending = runInNewContext(`${init}; init()`, context);
    await new Promise((resolve) => setImmediate(resolve));
    statusDone();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ready, false);
    viewDone();
    await pending;
    assert.equal(ready, true);
  });
});
