import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 模型字段测试「进行中关窗 → 中止确认 → 确认后丢弃迟到结果」的单测。沿用
// panel-store-new-models.test.mjs 的 new Function 提取范式：把模型字段测试机制块
// 从 panel.js 抠出来，喂 $(DOM)/api/showSkillsModal 桩，驱动状态机验证交互口径。
// 不碰真实 DOM、不碰后端。

const panelJs = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../panel-ui", "panel.js"),
  "utf8"
);

// 机制块：状态声明 + 全部模型测试函数（到 dismissModelTestAbortConfirm 收尾）
const mechSrc = panelJs.match(
  /let modelTestState = "idle";[\s\S]*?function dismissModelTestAbortConfirm\(\) \{[\s\S]*?\n  \}/
);
assert.ok(mechSrc, "panel.js must contain the model-test mechanism block");

function makeHarness() {
  return new Function(`
    const __els = new Map();
    function __el(id) {
      if (!__els.has(id)) {
        const classes = new Set();
        __els.set(id, {
          id,
          innerHTML: "",
          onclick: null,
          classList: {
            add: (...c) => c.forEach((x) => classes.add(x)),
            remove: (...c) => c.forEach((x) => classes.delete(x)),
            contains: (c) => classes.has(c),
            toggle: (c, on) => { (on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c); },
          },
        });
      }
      return __els.get(id);
    }
    const $ = __el;
    const escapeHtml = (s) => String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    let __apiImpl = null;
    const api = (...a) => __apiImpl(...a);
    const storeTestErrorText = (e) => String(e && e.message || e);
    let __skillsOpts = null;      // showSkillsModal 最近一次参数（null = 单例未开）
    const __skillsShown = () => __el("skillsModal").classList.contains("show");
    function showSkillsModal(opts) { __skillsOpts = opts; __el("skillsModal").classList.add("show"); }
    function forceHideSkillsModal() { __skillsOpts = null; __el("skillsModal").classList.remove("show"); }
    ${mechSrc[0]}
    return {
      open: (mid) => openModelTestModal({ id: "p1", displayName: "渠道甲" }, mid),
      run: runModelTest,
      close: closeModelTestModal,
      state: () => modelTestState,
      modalShown: () => __el("modelTestModal").classList.contains("show"),
      skillsShown: __skillsShown,
      skillsOpts: () => __skillsOpts,
      bodyHtml: () => __el("modelTestBody").innerHTML,
      footHtml: () => __el("modelTestFoot").innerHTML,
      setApi: (fn) => { __apiImpl = fn; },
    };
  `)();
}

// 可手动落地的 api 桩：返回 { resolve, reject } 控制 promise
function deferredApi() {
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { fn: () => p, resolve, reject };
}

describe("模型字段测试 · 进行中关窗的中止确认", () => {
  it("running 态点关闭不直接关窗，弹出中止确认（文案钉死）", () => {
    const h = makeHarness();
    h.setApi(deferredApi().fn);
    h.open("m1");
    h.run();
    assert.equal(h.state(), "running");
    h.close();
    assert.ok(h.modalShown(), "确认未答前测试窗保持打开");
    assert.ok(h.skillsShown(), "应弹出中止确认单例");
    assert.equal(h.skillsOpts().title, "中止测试？");
    assert.equal(h.skillsOpts().confirmText, "中止并退出");
    assert.equal(h.skillsOpts().cancelText, "继续测试");
    assert.ok(h.skillsOpts().bodyHtml.includes("测试尚未完成，退出后本次测试将中止。"));
  });

  it("确认中止 → 关窗；迟到的结果被丢弃，不上屏", async () => {
    const h = makeHarness();
    const d = deferredApi();
    h.setApi(d.fn);
    h.open("m1");
    h.run();
    h.close();
    h.skillsOpts().onConfirm(); // 中止并退出
    assert.equal(h.modalShown(), false, "确认后测试窗关闭");
    assert.equal(h.state(), "idle");
    d.resolve({ returned: "m1", match: true, latencyMs: 12 });
    await Promise.resolve(); await Promise.resolve(); // 让 runModelTest 的 await 链走完
    assert.equal(h.state(), "idle", "迟到结果不得把状态机拉回 result");
    assert.ok(!h.bodyHtml().includes("mft-verdict"), "迟到结果不上屏");
  });

  it("确认悬而未决时结果落地 → 结果照常上屏，确认层自动收掉", async () => {
    const h = makeHarness();
    const d = deferredApi();
    h.setApi(d.fn);
    h.open("m1");
    h.run();
    h.close(); // 确认层挂上
    d.resolve({ returned: "m1", match: true, latencyMs: 12 });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.state(), "result");
    assert.ok(h.bodyHtml().includes("返回的模型标识与请求一致"));
    assert.equal(h.skillsShown(), false, "结果落地后中止确认自动收掉");
  });

  it("「继续测试」/确认层 ✕ → 回到测试中等结果，结果正常上屏", async () => {
    const h = makeHarness();
    const d = deferredApi();
    h.setApi(d.fn);
    h.open("m1");
    h.run();
    h.close();
    h.skillsOpts().onCancel(); // 继续测试
    assert.equal(h.skillsShown(), false);
    assert.equal(h.state(), "running");
    assert.ok(h.modalShown());
    d.resolve({ returned: "m2", match: false, latencyMs: 34 });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.state(), "result");
    assert.ok(h.bodyHtml().includes("返回的模型标识与请求不一致"));
  });

  it("非 running 态关窗不弹确认，直接关闭", () => {
    const h = makeHarness();
    h.open("m1"); // confirm 态
    h.close();
    assert.equal(h.modalShown(), false);
    assert.equal(h.skillsShown(), false);
    assert.equal(h.state(), "idle");
  });

  it("running 态底部「取消」可用且与 ✕ 同走中止确认", () => {
    const h = makeHarness();
    h.setApi(deferredApi().fn);
    h.open("m1");
    h.run();
    const foot = h.footHtml();
    assert.ok(foot.includes('id="modelTestCancelBtn"'), "进行中保留取消钮");
    assert.ok(!/id="modelTestCancelBtn"[^>]*disabled/.test(foot), "进行中取消钮不再禁用");
  });
});
