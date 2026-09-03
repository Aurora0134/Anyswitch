// 收起态折线图渲染门控——行为回归测试。
// 背景：栏的「展开 ▾/收起 ▴」折叠只对四宫格切 hidden（CSS display:none），
// 修复前渲染路径对折叠态无感知：收起的栏每秒仍对隐藏 SVG 写折线 d 属性
// （生成中每实例 3 条 × 1s 的 JS 空转写）。本文件钉住修后的三个行为：
// ① 收起态渲染实例行：零 updateSparkline 调用（buffer 照常累积，曲线连续性不受影响）；
// ② 展开瞬间（折叠钮 → applyDetailFold）立即用已攒 buffer 补绘，不等下一轮 1s 轮询；
// ③ 展开态渲染行为与修前一致（tps/ttft/cache 三条，cache 锁 0-100 量程）。
// 端点级旧机制（zcode/dsh/reasonix）行为见文件尾 describe。
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const panelHtml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
  "utf8",
);

function fakeElement() {
  return {
    className: "", dataset: {}, hidden: false,
    _innerHTML: "",
    set innerHTML(v) { this._innerHTML = v; },
    get innerHTML() { return this._innerHTML; },
    appendChild() {},
  };
}

function makeEnv() {
  const calls = { update: [], push: [], redraw: [], redrawEp: [] };
  const created = [];
  const env = {
    calls,
    created,
    instanceSparkBuffers: {},
    endpointStaleFlags: {},
    redrawInstanceSparklines: (prefix) => { calls.redraw.push(prefix); },
    redrawEndpointSparklines: (prefix) => { calls.redrawEp.push(prefix); },
    isDetailOpen: () => false,
    pushInstanceSpark: (prefix, iid, vals) => {
      const key = prefix + ":" + iid;
      const buf = env.instanceSparkBuffers[key] || (env.instanceSparkBuffers[key] = { tps: [], cache: [], ttft: [] });
      if (typeof vals?.tps === "number") buf.tps.push({ t: 0, v: vals.tps });
      if (typeof vals?.cacheHitRate === "number") buf.cache.push({ t: 0, v: vals.cacheHitRate });
      if (typeof vals?.ttft === "number") buf.ttft.push({ t: 0, v: vals.ttft });
      calls.push.push(key);
    },
    updateSparkline: (containerId, dataPoints, minVal, maxVal) => {
      calls.update.push({ id: containerId, dataPoints, minVal, maxVal });
    },
    sparkValues: (buf) => (buf ? buf.map((p) => p.v) : []),
    formatDurationSeconds: () => "0秒",
    escapeHtml: (s) => String(s ?? ""),
    formatTokens: () => "0",
    // 与 panel.html 同口径：active 豁免，lastSeen 超 2min 为陈旧
    isInstanceStale: (inst) => !inst || inst.status === "active"
      ? false
      : (typeof inst.lastSeen === "number" && (Date.now() - inst.lastSeen) > 2 * 60 * 1000),
    formatRelativeAge: () => "3 小时前",
    document: { createElement: () => { const el = fakeElement(); created.push(el); return el; } },
  };
  return env;
}

function makeRenderInstanceRows(env) {
  const m = panelHtml.match(/function renderInstanceRows\(\{ prefix, listEl, instances, aggregateFallback \}\) \{[\s\S]*?\n  \}/);
  assert.ok(m, "renderInstanceRows found in panel.html");
  return new Function(
    "isDetailOpen", "pushInstanceSpark", "updateSparkline", "sparkValues", "instanceSparkBuffers",
    "formatDurationSeconds", "escapeHtml", "formatTokens", "isInstanceStale", "formatRelativeAge", "document",
    `return (${m[0]});`,
  )(
    env.isDetailOpen, env.pushInstanceSpark, env.updateSparkline, env.sparkValues, env.instanceSparkBuffers,
    env.formatDurationSeconds, env.escapeHtml, env.formatTokens, env.isInstanceStale, env.formatRelativeAge, env.document,
  );
}

function makeApplyDetailFold(env, open) {
  const m = panelHtml.match(/function applyDetailFold\(prefix\) \{[\s\S]*?\n  \}/);
  assert.ok(m, "applyDetailFold found in panel.html");
  const gridEl = fakeElement();
  const btn = {
    textContent: "",
    setAttribute() {},
    closest: () => ({ querySelectorAll: () => [gridEl] }),
  };
  const foldDoc = { querySelectorAll: () => [btn] };
  const fn = new Function("isDetailOpen", "document", "redrawInstanceSparklines", `return (${m[0]});`)(
    () => open, foldDoc, env.redrawInstanceSparklines,
  );
  return { fn, btn, gridEl };
}

const KIMI_INSTANCE = {
  id: "inst-1", title: "kimi one", status: "active",
  tps: 12.3, lastTtftMs: 420, cacheHitRate: 88.5,
  tokens: {}, requests: 3, activeDurationMs: 65000,
};

describe("panel.html 实例栏收起态不画折线（buffer 照常累积）", () => {
  it("收起态渲染实例行：零折线绘制调用，实例采样照常入 buffer", () => {
    const env = makeEnv();
    env.isDetailOpen = () => false;
    const render = makeRenderInstanceRows(env);
    render({ prefix: "kimi", listEl: fakeElement(), instances: [KIMI_INSTANCE] });
    assert.equal(env.calls.update.length, 0, "收起时不得对隐藏 DOM 做任何折线绘制");
    assert.deepEqual(env.calls.push, ["kimi:inst-1"], "buffer 累积不因收起而停（展开后曲线才连续）");
  });

  it("展开态渲染实例行：tps/ttft/cache 三条照常绘制，cache 锁 0-100 量程（修前行为保持）", () => {
    const env = makeEnv();
    env.isDetailOpen = () => true;
    const render = makeRenderInstanceRows(env);
    render({ prefix: "kimi", listEl: fakeElement(), instances: [KIMI_INSTANCE] });
    const ids = env.calls.update.map((c) => c.id).sort();
    assert.deepEqual(ids, [
      "kimiInstSparkCache-inst-1", "kimiInstSparkTps-inst-1", "kimiInstSparkTtft-inst-1",
    ]);
    const cache = env.calls.update.find((c) => c.id === "kimiInstSparkCache-inst-1");
    assert.equal(cache.minVal, 0);
    assert.equal(cache.maxVal, 100);
  });
});

describe("panel.html 展开瞬间补绘（不等下一轮 1s 轮询）", () => {
  it("折叠钮展开（applyDetailFold open=true）立即触发本栏实例折线补绘", () => {
    const env = makeEnv();
    const fold = makeApplyDetailFold(env, true);
    fold.fn("kimi");
    assert.deepEqual(env.calls.redraw, ["kimi"], "展开瞬间补绘");
    assert.equal(fold.gridEl.hidden, false, "四宫格同时恢复可见");
    assert.equal(fold.btn.textContent, "收起 ▴", "钮文案切展开态");
  });

  it("收起方向的 applyDetailFold 不触发补绘", () => {
    const env = makeEnv();
    const fold = makeApplyDetailFold(env, false);
    fold.fn("kimi");
    assert.deepEqual(env.calls.redraw, []);
    assert.equal(fold.gridEl.hidden, true);
  });

  it("redrawInstanceSparklines 用已攒 buffer 逐实例绘制三条折线，不串栏", () => {
    const m = panelHtml.match(/function redrawInstanceSparklines\(prefix\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "redrawInstanceSparklines found in panel.html");
    const buffers = {
      "kimi:a1": { tps: [{ t: 0, v: 10 }, { t: 0, v: 11 }], cache: [{ t: 0, v: 80 }], ttft: [{ t: 0, v: 0.4 }], sparkHistory: { ttft: [0.3, 0.42] } },
      "kimi:a2": { tps: [{ t: 0, v: 5 }], cache: [], ttft: [] },
      "agy:x": { tps: [{ t: 0, v: 1 }], cache: [{ t: 0, v: 2 }], ttft: [{ t: 0, v: 3 }] },
    };
    const calls = [];
    const foldBtn = {};
    const card = { querySelector: (sel) => (sel.includes("agent-detail-fold") ? foldBtn : null) };
    const gridEls = ["a1", "a2"].map((iid) => ({ dataset: { instanceId: iid }, closest: () => card }));
    gridEls.push({ dataset: { instanceId: "x" }, closest: () => ({ querySelector: () => null }) }); // agy 卡无本栏折叠钮，必须跳过
    const foldDoc = { querySelectorAll: (sel) => (sel.startsWith(".instance-telemetry-grid") ? gridEls : []) };
    const fn = new Function("document", "instanceSparkBuffers", "sparkValues", "updateSparkline", `return (${m[0]});`)(
      foldDoc,
      buffers,
      (buf, hist) => (hist && hist.length ? hist.slice(-1) : (buf || []).map((p) => p.v)),
      (id, dataPoints, minVal, maxVal) => calls.push({ id, dataPoints, minVal, maxVal }),
    );
    fn("kimi");
    assert.deepEqual(calls.map((c) => c.id), [
      "kimiInstSparkTps-a1", "kimiInstSparkCache-a1", "kimiInstSparkTtft-a1",
      "kimiInstSparkTps-a2", "kimiInstSparkCache-a2", "kimiInstSparkTtft-a2",
    ], "kimi 两实例各三条，agy 不串栏");
    const ttft = calls.find((c) => c.id === "kimiInstSparkTtft-a1");
    assert.deepEqual(ttft.dataPoints, [0.42], "ttft 补绘用 buffer 暂存的权威历史（与渲染时口径一致）");
    const cache = calls.find((c) => c.id === "kimiInstSparkCache-a1");
    assert.equal(cache.minVal, 0);
    assert.equal(cache.maxVal, 100);
  });
});

describe("panel.html 端点级旧机制（zcode/dsh/reasonix）收起不绘制、展开补绘", () => {
  function makeRedrawEndpoint(env) {
    const m = panelHtml.match(/function redrawEndpointSparklines\(prefix\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "redrawEndpointSparklines found in panel.html");
    const km = panelHtml.match(/const ENDPOINT_SPARK_KEYS = \{[\s\S]*?\n  \};/);
    assert.ok(km, "ENDPOINT_SPARK_KEYS found in panel.html");
    const keys = new Function(`return (${km[0].replace(/^const ENDPOINT_SPARK_KEYS = /, "").replace(/;$/, "")})`)();
    const historyBuffers = {
      ttft: [{ t: 0, v: 1.1 }, { t: 0, v: 1.2 }], tps: [{ t: 0, v: 30 }], cache: [{ t: 0, v: 90 }],
      dsh_ttft: [], dsh_tps: [], dsh_cache: [],
      reasonix_ttft: [], reasonix_tps: [], reasonix_cache: [],
    };
    const gridEls = { zcTelemetryGrid: { hidden: true }, dshTelemetryGrid: { hidden: false }, reasonixTelemetryGrid: { hidden: false } };
    const fn = new Function("$", "historyBuffers", "sparkValues", "updateSparkline", "ENDPOINT_SPARK_KEYS", "endpointStaleFlags", `return (${m[0]});`)(
      (id) => gridEls[id] || null,
      historyBuffers,
      (buf) => (buf || []).map((p) => p.v),
      (id, dataPoints, minVal, maxVal) => env.calls.update.push({ id, dataPoints, minVal, maxVal }),
      keys,
      env.endpointStaleFlags,
    );
    return { fn, historyBuffers, gridEls };
  }

  it("四宫格隐藏（收起）时不绘制；可见时按端点级 buffer 画三条（cache 锁 0-100）", () => {
    const env = makeEnv();
    const { fn } = makeRedrawEndpoint(env);
    fn("zc");
    assert.equal(env.calls.update.length, 0, "收起态零绘制");
    fn("dsh");
    assert.deepEqual(env.calls.update.map((c) => c.id), ["dshSparkTtft", "dshSparkTps", "dshSparkCache"], "可见栏照常绘制");
    fn("reasonix");
    const ids = env.calls.update.map((c) => c.id);
    assert.ok(ids.includes("reasonixSparkTtft") && ids.includes("reasonixSparkTps") && ids.includes("reasonixSparkCache"));
    const zc = env.calls.update.filter((c) => c.id === "zcSparkTtft");
    assert.equal(zc.length, 0, "zc 全程收起，不得出现 zc 折线调用");
  });

  it("renderZcode/renderDsh/renderReasonix 不再裸调 updateSparkline，改走 redrawEndpointSparklines 门控", () => {
    for (const fnName of ["renderZcode", "renderDsh", "renderReasonix"]) {
      const m = panelHtml.match(new RegExp("function " + fnName + "\\([a-z]+\\) \\{[\\s\\S]*?\\n  \\}"));
      assert.ok(m, fnName + " found in panel.html");
      assert.ok(!m[0].includes("updateSparkline("), fnName + " 不得裸调 updateSparkline（收起态会直写隐藏 DOM）");
      const prefix = fnName === "renderZcode" ? "zc" : fnName === "renderDsh" ? "dsh" : "reasonix";
      assert.ok(m[0].includes(`redrawEndpointSparklines("${prefix}")`), fnName + " 改走 redrawEndpointSparklines");
    }
  });

  it("旧机制 setFold 展开（open=true）立即补绘端点级折线", () => {
    const m = panelHtml.match(/const setFold = \(open\) => \{[\s\S]*?\n    \};/);
    assert.ok(m, "setFold found in panel.html");
    const env = makeEnv();
    const grid = { hidden: true }, brief = { hidden: false }, foldBtn = { setAttribute() {}, textContent: "" };
    const aggWrap = { hidden: true };
    const arrow = m[0].replace(/^const setFold = /, "").replace(/;$/, "");
    const fn = new Function("grid", "brief", "foldBtn", "prefix", "redrawEndpointSparklines", "aggWrap", `return (${arrow});`)(
      grid, brief, foldBtn, "dsh", env.redrawEndpointSparklines, aggWrap,
    );
    fn(true);
    assert.deepEqual(env.calls.redrawEp, ["dsh"], "展开瞬间补绘");
    assert.equal(grid.hidden, false);
    assert.equal(aggWrap.hidden, false, "展开态显示「全局汇总」行");
    fn(false);
    assert.deepEqual(env.calls.redrawEp, ["dsh"], "收起方向不补绘");
    assert.equal(aggWrap.hidden, true, "收起态隐藏「全局汇总」行（tokens/请求数由简要栏承载）");
  });

  it("陈旧端点（endpointStaleFlags 置位）可见也零绘制，恢复新鲜后照常", () => {
    const env = makeEnv();
    const { fn } = makeRedrawEndpoint(env);
    env.endpointStaleFlags.dsh = true;
    fn("dsh");
    assert.equal(env.calls.update.length, 0, "陈旧端点不绘历史折线（四宫格可见也一样）");
    env.endpointStaleFlags.dsh = false;
    fn("dsh");
    assert.equal(env.calls.update.length, 3, "恢复新鲜后照常绘制");
  });
});

describe("panel.html 陈旧实例行（lastSeen 超阈值）速率类隐藏", () => {
  // 数小时前的 last-N 窗口均值不再冒充实时数据：速率类三格置 —、折线停绘、
  // 简要胶囊行换成相对时间；工时等累计量不受影响。
  const STALE_INSTANCE = {
    id: "inst-old", title: "kimi old", status: "idle",
    tps: 12.3, lastTtftMs: 420, cacheHitRate: 88.5,
    tokens: { prompt: 100, completion: 50, cached: 20 }, requests: 3,
    activeDurationMs: 65000, lastSeen: Date.now() - 3 * 3600 * 1000,
  };

  it("展开态渲染陈旧行：零折线绘制 + data-stale=1 + 速率类置 — + 胶囊行标注相对时间", () => {
    const env = makeEnv();
    env.isDetailOpen = () => true;
    const render = makeRenderInstanceRows(env);
    render({ prefix: "kimi", listEl: fakeElement(), instances: [STALE_INSTANCE] });
    assert.equal(env.calls.update.length, 0, "陈旧行不绘历史折线");
    const grid = env.created.find((el) => el.className === "instance-telemetry-grid");
    const row = env.created.find((el) => el.className === "session-row");
    assert.equal(grid.dataset.stale, "1", "grid carries data-stale flag");
    assert.ok(row.innerHTML.includes('tag-stale">3 小时前<'), "tags line annotates bare relative age");
    assert.ok(!grid.innerHTML.includes("最后活动"), "grid has no tail annotation");
    assert.ok((grid.innerHTML.match(/inst-stale/g) || []).length === 3, "速率类三格压暗，工时卡不动");
    assert.ok(!grid.innerHTML.includes("12.3"), "stale tps hidden");
    assert.ok(grid.innerHTML.includes("0秒"), "工时累计量照常显示");
  });

  it("新鲜行不受影响：lastSeen 近 1 分钟内照常绘制三条折线", () => {
    const env = makeEnv();
    env.isDetailOpen = () => true;
    const render = makeRenderInstanceRows(env);
    render({ prefix: "kimi", listEl: fakeElement(), instances: [{ ...STALE_INSTANCE, lastSeen: Date.now() - 30 * 1000 }] });
    assert.equal(env.calls.update.length, 3, "fresh row draws all three sparklines");
    const grid = env.created.find((el) => el.className === "instance-telemetry-grid");
    assert.equal(grid.dataset.stale, "0");
    assert.ok(grid.innerHTML.includes("12.3"), "fresh tps shown");
  });

  it("无 lastSeen 的行（旧 relay 快照）按新鲜处理，不出现陈旧标注", () => {
    const env = makeEnv();
    env.isDetailOpen = () => true;
    const render = makeRenderInstanceRows(env);
    const inst = { ...STALE_INSTANCE };
    delete inst.lastSeen;
    render({ prefix: "kimi", listEl: fakeElement(), instances: [inst] });
    const grid = env.created.find((el) => el.className === "instance-telemetry-grid");
    const row = env.created.find((el) => el.className === "session-row");
    assert.equal(grid.dataset.stale, "0", "missing lastSeen never marked stale");
    assert.ok(!row.innerHTML.includes("tag-stale"), "no stale bubble");
  });
});


describe("claudeAggregateMetrics 会话求和聚合（claude 无端点聚合桶）", () => {
  const m = panelHtml.match(/function claudeAggregateMetrics\(sessions\) \{[\s\S]*?\n  \}/);
  assert.ok(m, "claudeAggregateMetrics found in panel.html");
  const claudeAggregateMetrics = new Function(`return (${m[0]});`)();

  it("tokens/请求/工时累加，tps 求和，缓存按 prompt 加权，TTFT/lastSeen 取最近会话", () => {
    const agg = claudeAggregateMetrics([
      { tokens: { prompt: 100, completion: 50, cached: 80 }, requests: 2, tps: 10, activeDurationMs: 60000, lastSeen: 1000, lastTtftMs: 300, ttftColor: "green" },
      { tokens: { prompt: 300, completion: 150, cached: 40 }, requests: 1, tps: 5.5, activeDurationMs: 30000, lastSeen: 2000, lastTtftMs: 900, ttftColor: "red" },
    ]);
    assert.deepEqual(agg.tokens, { prompt: 400, completion: 200, cached: 120 });
    assert.equal(agg.totalRequests, 3);
    assert.equal(agg.tps, 15.5);
    assert.equal(agg.activeDurationMs, 90000);
    assert.equal(agg.cacheHitRate, 30, "120/400 按 prompt 加权");
    assert.equal(agg.lastTtftMs, 900, "TTFT 取 lastSeen 最近的会话");
    assert.equal(agg.ttftColor, "red");
    assert.equal(agg.lastSeen, 2000);
  });

  it("零会话：全部归零/null，不产生 NaN（零实例伪实例行用）", () => {
    const agg = claudeAggregateMetrics([]);
    assert.deepEqual(agg.tokens, { prompt: 0, completion: 0, cached: 0 });
    assert.equal(agg.totalRequests, 0);
    assert.equal(agg.tps, null);
    assert.equal(agg.lastTtftMs, null);
    assert.equal(agg.cacheHitRate, null);
    assert.equal(agg.activeDurationMs, 0);
    assert.equal(agg.lastSeen, null);
  });

  it("缺字段会话（旧 relay 快照）按零计，不炸", () => {
    const agg = claudeAggregateMetrics([{ requests: 1 }]);
    assert.equal(agg.totalRequests, 1);
    assert.equal(agg.tps, null);
    assert.equal(agg.cacheHitRate, null);
    assert.equal(agg.lastSeen, null);
  });
});
