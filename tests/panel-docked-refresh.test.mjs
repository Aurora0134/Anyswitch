// 停靠页数据回灌的行为钉：设置页/渠道页只在切入时取数，窗口 B 改完另一侧的窗口 A
// 收不到信号；本车道在 visibilitychange（变可见）与 focus 两个信号上按当前视图补拉。
//
// 取样惯例照 panel-terminal-foreground-restore：visibilitychange 处理器整体抽进桩
// 环境真跑，触发器/回灌函数按名切源码进桩，去抖时钟手动推进，不锚墙钟。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPanelFn as extractFn } from "../test-helpers/extract-panel-fn.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const panelJs = readFileSync(join(here, "../panel-ui", "panel.js"), "utf8");

const handlerBody = panelJs.match(/document\.addEventListener\("visibilitychange", \(\) => \{([\s\S]*?)\n  \}\);/)?.[1];
assert.ok(handlerBody, "visibilitychange 处理器可取样");

// loadSettingsState 是交给模块层占位的交接版（赋值形式），锚失配当场红，不静默放行。
const loadSettingsFn = panelJs.match(/loadSettingsState = async function \(\) \{[\s\S]*?\n    \}/)?.[0];
assert.ok(loadSettingsFn, "loadSettingsState 交接版可取样");
new Function(loadSettingsFn); // 半截切片在此处抛 SyntaxError，不留给后面的桩环境

// 回灌函数的全部外部依赖：元素一律置空（回灌各块自带存在守卫），函数用最小桩，
// 只留 api 与两个数字输入走真值。Date 被参数遮蔽成可手动推进的时钟。
const SETTINGS_SANDBOX = `
  let settingsLoadGen = 0;
  const settingsSaving = {};
  let keepAliveEndpoints = null;
  function applyKeepAliveUi() {}
  let keepAliveMaxRetries = 5;
  function clampKeepAliveRetries(n) { return n; }
  let keepAliveRetriesInput = null;
  let followAgentToggle = null;
  let terminalRestoreSaving = false;
  let terminalRestoreSessions = true;
  let terminalBottomAlignSaving = false;
  let terminalBottomAutoAlign = true;
  let injectEffortToggle = null;
  let credentialCacheToggle = null;
  let autoDownloadUpdatesToggle = null;
  let poolRoutingSeg = null;
  function applyPoolRouting() {}
  let updateChannelSeg = null;
  function applyUpdateChannel() {}
  let loggingEnabledToggle = null;
  function applyLoggingEnabled() {}
  let logLevelSelect = null;
  function applyLogLevel() {}
  let claudeBypassPermissionsToggle = null;
  let midSystemRewriteToggle = null;
  let sparkWindowPoints = 16;
  function clampSparkWindow(n) { return n; }
  function resetAgentRenderFingerprints() {}
  let sparkWindowInput = null;
  const historyBuffers = {};
  function pruneSparkBuffer() {}
  let claudeTierEnabledToggle = null;
  let claudeTierEnabled = true;
  function anyClaudeTierSaving() { return false; }
  let claudeTierMappings = {};
  function applyClaudeTierUi() {}
  async function api(method, path) { state.calls.push(method + " " + path); return state.response; }
  let loadSettingsState = () => {};
  ${loadSettingsFn}
`;

describe("停靠页回灌：触发链", () => {
  function makeWorld({ view, response = { ok: true, settings: {} } } = {}) {
    const state = { view, response, calls: [], now: 1000 };
    const sandbox = new Function("state", "document", "Date", `
      function refreshStatus() { state.calls.push("refreshStatus"); }
      function syncTerminalDataStream() {}
      let terminalVisibilityWasHidden = false;
      let currentView = state.view;
      let storeDragId = null;
      let dockedRefreshAt = 0;
      let dockedRefreshView = null;
      ${extractFn("refreshDockedView")}
      ${SETTINGS_SANDBOX}
      function visibilitychange() { ${handlerBody} }
      return {
        visibilitychange,
        set view(v) { currentView = v; },
      };
    `)(state, { hidden: false, activeElement: null }, { now: () => state.now });
    return { state, sandbox };
  }
  const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

  it("变可见且停在设置页：发起一次 GET /api/settings；同拍第二信号被去抖", async () => {
    const { state, sandbox } = makeWorld({ view: "settings" });
    sandbox.visibilitychange();
    await flush();
    assert.deepEqual(state.calls, ["refreshStatus", "GET /api/settings"],
      "回前台一拍补拉设置页数据");
    // 同拍连发（visibilitychange 与 focus 前后脚）：时钟不动，第二拍不再发请求
    sandbox.visibilitychange();
    await flush();
    assert.equal(state.calls.filter((c) => c === "GET /api/settings").length, 1,
      "2 秒内同一视图只拉一次");
  });

  it("渠道页：变可见补拉一次；拖拽与弹窗开态各弃一轮，窗口过后照常补", () => {
    const state = { view: "store", response: { ok: true, settings: {} }, calls: [], now: 1000, modal: null, drag: null };
    const world = new Function("state", "document", "Date", `
      function refreshStatus() {}
      function syncTerminalDataStream() {}
      let terminalVisibilityWasHidden = false;
      let currentView = state.view;
      let storeDragId = state.drag;
      let dockedRefreshAt = 0;
      let dockedRefreshView = null;
      function loadSettingsState() { state.calls.push("loadSettings"); }
      function refreshStoreState() { state.calls.push("refreshStore"); return Promise.resolve(); }
      ${extractFn("refreshDockedView")}
      return {
        fire: () => refreshDockedView(),
        set drag(v) { storeDragId = v; },
        set view(v) { currentView = v; },
      };
    `)(state, { hidden: false, querySelector: () => state.modal }, { now: () => state.now });

    world.fire();
    assert.deepEqual(state.calls, ["refreshStore"], "渠道页停靠回前台补拉一轮");
    world.fire();
    assert.deepEqual(state.calls, ["refreshStore"], "同拍第二信号去抖");
    state.now += 3000;
    world.drag = "p1";
    world.fire();
    assert.deepEqual(state.calls, ["refreshStore"], "拖拽重排进行中弃本轮");
    state.now += 3000;
    world.drag = null;
    state.modal = { classList: { contains: () => true } };
    world.fire();
    assert.deepEqual(state.calls, ["refreshStore"], "弹窗开态弃本轮");
    state.now += 3000;
    state.modal = null;
    world.fire();
    assert.deepEqual(state.calls, ["refreshStore", "refreshStore"], "守卫解除后下一拍照常补拉");
    // 换视图不受上一个视图的去抖窗口限制（同一视图 2 秒）
    state.now += 100;
    world.view = "settings";
    world.fire();
    assert.deepEqual(state.calls, ["refreshStore", "refreshStore", "loadSettings"],
      "切到设置页换口补拉，不背渠道页的去抖账");
  });
});

describe("停靠页回灌：数字输入焦点守卫", () => {
  const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

  async function runBackfill({ activeElement, input, response, field }) {
    const state = { calls: [], response, now: 1000, input };
    const sandbox = new Function("state", "document", "Date", `
      ${SETTINGS_SANDBOX}
      ${field === "spark" ? "sparkWindowInput = state.input;" : "keepAliveRetriesInput = state.input;"}
      return {
        backfill: () => loadSettingsState(),
        get model() { return ${field === "spark" ? "sparkWindowPoints" : "keepAliveMaxRetries"}; },
      };
    `)(state, { hidden: false, activeElement }, { now: () => state.now });
    await sandbox.backfill();
    return { input: state.input, model: sandbox.model, calls: state.calls };
  }

  it("sparkWindowInput 正被聚焦：输入框不回灌，值模型照常更新", async () => {
    const input = { value: "32" };
    const focused = await runBackfill({
      activeElement: input, input,
      response: { ok: true, sparkWindowPoints: 16 },
      field: "spark",
    });
    assert.equal(focused.input.value, "32", "聚焦中的输入框不被回灌覆盖");
    assert.equal(focused.model, 16, "值模型照常吃服务端值（失焦后下一轮回灌跟上）");

    const blurred = await runBackfill({
      activeElement: null, input: { value: "32" },
      response: { ok: true, sparkWindowPoints: 16 },
      field: "spark",
    });
    assert.equal(blurred.input.value, "16", "不在焦点时照常回填");
  });

  it("keepAliveRetriesInput 正被聚焦：同样只跳过输入框回显", async () => {
    const input = { value: "9" };
    const focused = await runBackfill({
      activeElement: input, input,
      response: { ok: true, keepAlive: { maxRetries: 3 } },
      field: "retries",
    });
    assert.equal(focused.input.value, "9", "聚焦中的输入框不被回灌覆盖");
    assert.equal(focused.model, 3, "值模型照常吃服务端值");

    const blurred = await runBackfill({
      activeElement: null, input: { value: "9" },
      response: { ok: true, keepAlive: { maxRetries: 3 } },
      field: "retries",
    });
    assert.equal(blurred.input.value, "3", "不在焦点时照常回填");
  });
});

describe("停靠页回灌：接线钉", () => {
  it("visibilitychange 的可见分支把设置/渠道页引到补拉口，board 序列原样", () => {
    const hiddenReturn = handlerBody.indexOf("if (document.hidden) return;");
    const dispatch = handlerBody.indexOf('if (currentView === "settings" || currentView === "store")');
    assert.ok(hiddenReturn >= 0 && dispatch > hiddenReturn, "停靠页分发挂在可见分支");
    assert.ok(handlerBody.includes("refreshDockedView();"), "分发走 refreshDockedView 单口");
    // board 序列钉（既有钉的口径）：终端/统计提前 return 之后、board 兜底之前
    const board = handlerBody.indexOf("if (!boardVisible()) return;");
    assert.ok(dispatch < board, "停靠页分发排在 board 兜底之前");
  });

  it("focus 与变可见共用同一分发口；新增面零文案、零 DOM 写", () => {
    assert.ok(panelJs.includes('window.addEventListener("focus", refreshDockedView);'),
      "focus 信号挂同一分发口");
    const added = extractFn("refreshDockedView");
    assert.doesNotMatch(added, /toast\(|textContent|innerHTML|createElement|appendChild|insertAdjacentHTML/,
      "补拉口只读不写：不出文案、不动 DOM");
  });
});
