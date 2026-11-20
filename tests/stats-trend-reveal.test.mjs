import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const panel = readFileSync(new URL("../panel-ui/panel.js", import.meta.url), "utf8");
const renderer = panel.slice(panel.indexOf("  function statsNiceMax("), panel.indexOf("  function statsTrendChartHeight("));

class SvgNode {
  children = [];
  attributes = new Map();
  style = {};

  constructor(tag) { this.tag = tag; }
  set textContent(_) { this.children = []; }
  appendChild(node) { this.children.push(node); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener() {}
  getTotalLength() { return 720; }
}

function chartFixture() {
  const chart = new SvgNode("div");
  chart.clientWidth = 760;
  let clock = 0;
  let frameId = 0;
  const frames = new Map();
  const render = vm.runInNewContext(`${renderer}\nrenderStatsLineChart;`, {
    document: { createElement: (tag) => new SvgNode(tag), createElementNS: (_, tag) => new SvgNode(tag) },
    window: { matchMedia: () => ({ matches: false }) },
    performance: { now: () => clock },
    requestAnimationFrame: (cb) => { frames.set(++frameId, cb); return frameId; },
    cancelAnimationFrame: (id) => frames.delete(id),
  });

  function draw(values, type) {
    render(chart, {
      labels: ["08:00", "09:00"], series: [{ key: "sample", color: "blue", values }], fmt: String,
    }, { type });
  }
  function frame(elapsed) {
    clock += elapsed;
    const batch = [...frames.values()];
    frames.clear();
    for (const cb of batch) cb(clock);
  }
  function path() {
    return chart.children[0].children.find((node) => node.tag === "g").children[0];
  }
  function visibleLength() {
    const dash = path().attributes.get("stroke-dasharray");
    return dash ? parseFloat(dash) : path().getTotalLength();
  }
  return { draw, frame, path, visibleLength, elapse: (ms) => { clock += ms; } };
}

test("统计趋势：首帧前数据更新，最新折线从零开始生长", () => {
  const chart = chartFixture();
  chart.draw([10, 100], "reveal");
  const cachedPath = chart.path().attributes.get("d");
  chart.draw([35, 100], "morph");
  assert.equal(chart.visibleLength(), 0);
  assert.notEqual(chart.path().attributes.get("d"), cachedPath, "starts drawing the fresh curve");

  chart.frame(300);
  assert.ok(chart.visibleLength() > 0 && chart.visibleLength() < 720);
  chart.frame(1200);
  assert.equal(chart.visibleLength(), 720);
});

test("统计趋势：首帧后数据更新，折线从已有进度继续生长", () => {
  const chart = chartFixture();
  chart.draw([10, 100], "reveal");
  chart.frame(300);
  const before = chart.visibleLength();
  chart.draw([35, 100], "morph");
  chart.frame(16);
  assert.ok(chart.visibleLength() > before && chart.visibleLength() < 720);
  chart.frame(1184);
  assert.equal(chart.visibleLength(), 720, "finishes the reveal on its original schedule");
});

test("统计趋势：首帧前数据未变，缓存折线按原进度生长", () => {
  const chart = chartFixture();
  chart.draw([10, 100], "reveal");
  chart.elapse(10);
  chart.draw([10, 100], "morph");
  chart.frame(300);
  assert.ok(chart.visibleLength() > 0 && chart.visibleLength() < 720);
  chart.frame(1190);
  assert.equal(chart.visibleLength(), 720);
  assert.equal(chart.path().attributes.has("stroke-dasharray"), false);
});
