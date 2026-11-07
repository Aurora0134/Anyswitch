// 切会话决策留痕（P0）：terminal-switch-log 写者纪律＋/panel/api/terminal/switch-log
// 收件口＋/switch 处理器全出口埋点。
// 写者是「绝不抛进主流程」的 JSONL 追加器；收件口只认机读事件名；/switch 每个出口
// 一记（recv/deny/fail/ok）。createTerminalSession 等注入假实现，不起真 terminal-host。
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTerminalSwitchLog, TERMINAL_SWITCH_LOG_MAX_BYTES } from "../src/terminal/terminal-switch-log.mjs";
import { createPanelRouter } from "../src/panel/panel.mjs";
import { createBindingStore } from "../src/terminal/terminal-conversation-bindings.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

const readLines = (file) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));

describe("terminal-switch-log 写者", () => {
  it("JSONL 追加：每条一行，信封 ts/event 齐备，字段透传", () => {
    const file = join(mkTestDir("anyswitch-switch-log-"), "terminal-switch.log");
    const log = createTerminalSwitchLog({ file });
    log("recv", { id: "t-1", mode: "fresh" });
    log("ok", { id: "t-1", ms: 42 });
    const lines = readLines(file);
    assert.equal(lines.length, 2, "两拍两行");
    assert.equal(lines[0].event, "recv");
    assert.equal(lines[0].id, "t-1");
    assert.ok(typeof lines[0].ts === "string" && !Number.isNaN(Date.parse(lines[0].ts)), "ISO 时间戳");
    assert.equal(lines[1].event, "ok");
    assert.equal(lines[1].ms, 42);
  });

  it("字段净化：标量留；对象/函数/undefined 丢；ts/event 键不可篡", () => {
    const file = join(mkTestDir("anyswitch-switch-log-"), "terminal-switch.log");
    const log = createTerminalSwitchLog({ file });
    log("recv", {
      keep: "yes", num: 1, flag: false, nil: null,
      obj: { a: 1 }, fn: () => {}, undef: undefined,
      ts: "2099-01-01", event: "forged",
    });
    const [line] = readLines(file);
    assert.equal(line.keep, "yes");
    assert.equal(line.num, 1);
    assert.equal(line.flag, false);
    assert.equal(line.nil, null);
    assert.ok(!("obj" in line) && !("fn" in line) && !("undef" in line), "非标量一律丢");
    assert.notEqual(line.ts, "2099-01-01", "ts 不可篡");
    assert.equal(line.event, "recv", "event 不可篡");
    assert.ok(!("forged" in line));
  });

  it("字段净化：字符串截 300、键数 ≤20、键名 ≤64、数组只留标量且 ≤10 项", () => {
    const file = join(mkTestDir("anyswitch-switch-log-"), "terminal-switch.log");
    const log = createTerminalSwitchLog({ file });
    const detail = { long: "x".repeat(400), arr: [1, "a", true, null, { b: 1 }, 2, 3, 4, 5, 6, 7, 8, 9], [`k${"y".repeat(64)}`]: 1 };
    for (let index = 0; index < 30; index += 1) detail[`f${index}`] = index;
    log("recv", detail);
    const [line] = readLines(file);
    assert.equal(line.long.length, 300, "字符串截到 300");
    assert.deepEqual(line.arr, [1, "a", true, 2, 3, 4, 5, 6, 7, 8], "数组滤非标量、截到 10 项");
    assert.ok(!(`k${"y".repeat(64)}` in line), "键名超 64 丢");
    const fieldCount = Object.keys(line).length - 2; // 扣掉信封 ts/event
    assert.ok(fieldCount <= 20, `键数封顶 20（实得 ${fieldCount}）`);
  });

  it("detail 不是对象（字符串/数组/null）：只留信封，不抛", () => {
    const file = join(mkTestDir("anyswitch-switch-log-"), "terminal-switch.log");
    const log = createTerminalSwitchLog({ file });
    log("recv", "junk");
    log("recv", ["junk"]);
    log("recv", null);
    const lines = readLines(file);
    assert.equal(lines.length, 3, "三拍都落");
    for (const line of lines) assert.deepEqual(Object.keys(line).sort(), ["event", "ts"], "零字段");
  });

  it("事件名不是非空字符串：整条丢弃不写", () => {
    const file = join(mkTestDir("anyswitch-switch-log-"), "terminal-switch.log");
    const log = createTerminalSwitchLog({ file });
    log("", { a: 1 });
    log(null);
    log(42);
    assert.equal(existsSync(file), false, "一条都不落盘");
  });

  it("超帽轮转：现文件改名 .old（单档，覆盖上一档），新行落新文件", () => {
    const file = join(mkTestDir("anyswitch-switch-log-"), "terminal-switch.log");
    writeFileSync(file, "1".repeat(TERMINAL_SWITCH_LOG_MAX_BYTES), "utf8");
    const log = createTerminalSwitchLog({ file });
    log("ok", { id: "after-rotate" });
    const oldLines = readFileSync(`${file}.old`, "utf8");
    assert.equal(oldLines.length, TERMINAL_SWITCH_LOG_MAX_BYTES, "旧内容整份进 .old");
    const [only] = readLines(file);
    assert.equal(only.event, "ok", "新行落新文件");
    // 再灌满再写：单档轮转，上一档 .old 被覆盖
    writeFileSync(file, "2".repeat(TERMINAL_SWITCH_LOG_MAX_BYTES), "utf8");
    log("ok", { id: "second-rotate" });
    assert.equal(readFileSync(`${file}.old`, "utf8").length, TERMINAL_SWITCH_LOG_MAX_BYTES, ".old 仍是单档");
    assert.equal(readFileSync(`${file}.old`, "utf8")[0], "2", "上一档被覆盖，不叠 .old.old");
  });

  it("写者全程不抛：目录建不出（父路径是文件）也静默吞", () => {
    const blocker = join(mkTestDir("anyswitch-switch-log-"), "blocker");
    writeFileSync(blocker, "", "utf8");
    const log = createTerminalSwitchLog({ file: join(blocker, "sub", "terminal-switch.log") });
    assert.doesNotThrow(() => log("recv", { id: "t-1" }), "mkdirSync 失败被吞");
    assert.doesNotThrow(() => log("ok"), "下一拍重试同样不抛");
  });
});

// ── 路由级：POST /panel/api/terminal/switch-log（前端埋点收件口）──
function fakeReqRes(url, method = "GET", body = null) {
  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(code, h) { this.statusCode = code; this.headers = h || {}; },
    end(data) { if (data !== undefined) this.body += data; },
  };
  const listeners = {};
  const req = {
    url,
    method,
    headers: {
      host: "127.0.0.1:47820",
      origin: "http://127.0.0.1:47820",
      "x-anyswitch-panel": "1",
    },
    on(event, fn) { listeners[event] = fn; return req; },
  };
  if (body !== null) {
    queueMicrotask(() => {
      listeners.data?.(Buffer.from(JSON.stringify(body)));
      listeners.end?.();
    });
  }
  const json = () => (res.body ? JSON.parse(res.body) : null);
  return { req, res, json };
}

function switchLogRouter({ root, terminalSwitchLogFn } = {}) {
  return createPanelRouter({
    storePaths: { root },
    logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
    fetchRelayAgents: async () => null,
    terminalSwitchLogFn,
  });
}

describe("POST /panel/api/terminal/switch-log 收件口", () => {
  it("合法事件：200 {ok:true}，事件与 detail 进注入的写者", async () => {
    const captured = [];
    const router = switchLogRouter({ root: mkTestDir("anyswitch-switch-log-route-"), terminalSwitchLogFn: (event, detail) => captured.push({ event, detail }) });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/switch-log", "POST", {
      event: "keep-alive", detail: { reason: "busy", signals: ["working"] },
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), { ok: true });
    assert.deepEqual(captured, [{ event: "keep-alive", detail: { reason: "busy", signals: ["working"] } }], "原样转交写者（净化是写者的职责）");
  });

  it("事件名非法一律 400 invalid_event，不进写者", async () => {
    const captured = [];
    const router = switchLogRouter({ root: mkTestDir("anyswitch-switch-log-route-"), terminalSwitchLogFn: (event, detail) => captured.push({ event, detail }) });
    for (const [label, event] of [
      ["大写", "Keep-Alive"],
      ["空串", ""],
      ["缺键", undefined],
      ["前导连字符", "-x"],
      ["超 64 字符", "a".repeat(65)],
      ["含空格", "has space"],
      ["含下划线", "has_under"],
      ["含点", "a.b"],
    ]) {
      const { req, res, json } = fakeReqRes("/panel/api/terminal/switch-log", "POST", { event, detail: {} });
      await router.handle(req, res);
      assert.equal(res.statusCode, 400, `${label}：400`);
      assert.equal(json().error, "invalid_event", `${label}：invalid_event`);
    }
    assert.deepEqual(captured, [], "非法事件一条都不进写者");
  });

  it("detail 不是对象：按 null 转交（写者只留信封）", async () => {
    const captured = [];
    const router = switchLogRouter({ root: mkTestDir("anyswitch-switch-log-route-"), terminalSwitchLogFn: (event, detail) => captured.push({ event, detail }) });
    const { req, res } = fakeReqRes("/panel/api/terminal/switch-log", "POST", { event: "switch-ok", detail: "junk" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(captured, [{ event: "switch-ok", detail: null }]);
  });

  it("未注入写者：默认惰性建真写者，落 <数据根>/logs/terminal-switch.log", async () => {
    const root = mkTestDir("anyswitch-switch-log-route-");
    const router = switchLogRouter({ root });
    const { req, res } = fakeReqRes("/panel/api/terminal/switch-log", "POST", { event: "switch-ok", detail: { terminal: "t-1" } });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    const file = join(root, "logs", "terminal-switch.log");
    const [line] = readLines(file);
    assert.equal(line.event, "switch-ok");
    assert.equal(line.terminal, "t-1");
  });
});

// ── /switch 处理器全出口埋点（recv/deny/fail/ok）──
describe("/switch 处理器埋点", () => {
  const SESSION_ID = "3f2b8c1e-9a44-4d0b-8f6e-1c2d3e4f5a6b";

  function instrumentedRouter({ root, hostSession, probe = false } = {}) {
    const captured = [];
    const router = createPanelRouter({
      storePaths: { root },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => null,
      fetchRelayDetectedProcesses: async () => null,
      fetchTerminalSessionsList: async () => [],
      createTerminalSession: async (body) => ({ status: 201, body: { id: "t-new", ...body } }),
      fetchTerminalSessionFn: async (id) => (hostSession === null
        ? null
        : (hostSession ?? { id, label: "Anyswitch", cwd: "C:\\shell-dir", shell: "powershell", status: "running", pid: 42 })),
      probeTerminalCommandTreeFn: async () => probe,
      switchGuardRecheckDelayMs: 0,
      restartTerminalSessionFn: async (id, body) => ({
        status: 200,
        body: { id, status: "running", pid: 99, label: body.label, agentId: body.agentId, agentName: body.agentName, resume: body.resume },
      }),
      scanAgentConversationsFn: async () => [],
      opencodeBusyFn: () => null,
      bindingRefreshScheduleFn: () => {},
      bindingCaptureDebounceMs: 0,
      terminalBindingStore: createBindingStore({ file: join(root, "terminal-conversation-bindings.json") }),
      terminalSwitchLogFn: (event, detail) => captured.push({ event, detail }),
    });
    return { router, captured };
  }

  // launch 组装要求端点可执行文件真实存在：只钉 kimi 一个端点，进程环境用后即还。
  async function withFakeKimi(fn) {
    // cwd 必须是真实存在的目录：launch 组装会校验工作目录（400「工作目录不存在」）。
    const dir = mkTestDir("anyswitch-switch-log-bin-");
    writeFileSync(join(dir, "kimi.cmd"), "", "utf8");
    const saved = process.env.KIMI_EXECUTABLE;
    process.env.KIMI_EXECUTABLE = join(dir, "kimi.cmd");
    try {
      await fn(dir);
    } finally {
      if (saved === undefined) delete process.env.KIMI_EXECUTABLE;
      else process.env.KIMI_EXECUTABLE = saved;
    }
  }

  it("ok 出口：recv（入口一拍）＋ ok（带模式与耗时）", async () => {
    await withFakeKimi(async (cwd) => {
      const { router, captured } = instrumentedRouter({ root: mkTestDir("anyswitch-switch-log-sw-") });
      const { req, res } = fakeReqRes(`/panel/api/terminal/sessions/${SESSION_ID}/switch`, "POST", { agentId: "kimi", cwd });
      await router.handle(req, res);
      assert.equal(res.statusCode, 200, "前提：内切成功");
      assert.deepEqual(captured.map((row) => row.event), ["recv", "ok"], "入口与成功出口各一拍");
      assert.equal(captured[0].detail.id, SESSION_ID);
      assert.equal(captured[0].detail.mode, "fresh");
      assert.equal(captured[0].detail.endpoint, "kimi");
      assert.equal(captured[1].detail.mode, "fresh");
      assert.ok(typeof captured[1].detail.ms === "number", "ok 带耗时");
    });
  });

  it("deny 出口：杀前复核探到活命令 → 409，recv＋deny（guard-busy）", async () => {
    await withFakeKimi(async (cwd) => {
      const { router, captured } = instrumentedRouter({ root: mkTestDir("anyswitch-switch-log-sw-"), probe: true });
      const { req, res } = fakeReqRes(`/panel/api/terminal/sessions/${SESSION_ID}/switch`, "POST", { agentId: "kimi", cwd });
      await router.handle(req, res);
      assert.equal(res.statusCode, 409, "前提：守卫拒换");
      assert.deepEqual(captured.map((row) => row.event), ["recv", "deny"], "入口与拒换出口各一拍");
      assert.equal(captured[1].detail.reason, "guard-busy");
      assert.equal(captured[1].detail.first, true, "判据现值随行");
    });
  });

  it("fail 出口：agentId 不在册 → 400，recv＋fail（agent-invalid）", async () => {
    const { router, captured } = instrumentedRouter({ root: mkTestDir("anyswitch-switch-log-sw-") });
    const { req, res } = fakeReqRes(`/panel/api/terminal/sessions/${SESSION_ID}/switch`, "POST", { agentId: "nope", cwd: "C:\\dev\\alpha" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 400, "前提：非法端点被拒");
    assert.deepEqual(captured.map((row) => row.event), ["recv", "fail"]);
    assert.equal(captured[1].detail.reason, "agent-invalid");
  });

  it("fail 出口：宿主会话不存在 → 404，recv＋fail（terminal_session_not_found）", async () => {
    const { router, captured } = instrumentedRouter({ root: mkTestDir("anyswitch-switch-log-sw-"), hostSession: null });
    const { req, res } = fakeReqRes(`/panel/api/terminal/sessions/${SESSION_ID}/switch`, "POST", { agentId: "kimi", cwd: "C:\\dev\\alpha" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 404, "前提：会话不存在");
    assert.deepEqual(captured.map((row) => row.event), ["recv", "fail"]);
    assert.equal(captured[1].detail.reason, "terminal_session_not_found");
  });
});
