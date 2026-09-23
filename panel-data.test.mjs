import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPanelRouter } from "./panel.mjs";

// 数据搬迁端点：路由用假 bundle 服务与假选择框跑，不起对话框、不碰真数据目录。
// fakeReqRes 取自 panel-store.test.mjs 同一套写法。

function fakeReqRes(url, method = "GET", body = null, extraHeaders = {}) {
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
    headers: { host: "127.0.0.1:47820", origin: "http://127.0.0.1:47820", "x-anyswitch-panel": "1", ...extraHeaders },
    on(event, fn) { listeners[event] = fn; return req; },
  };
  if (body !== null) {
    queueMicrotask(() => { listeners.data?.(Buffer.from(JSON.stringify(body))); listeners.end?.(); });
  }
  const json = () => (res.body ? JSON.parse(res.body) : null);
  return { req, res, json };
}

function dataRouter({ dataBundleService, pickFolderFn, pickFileFn, ...rest } = {}) {
  return createPanelRouter({
    storePaths: { root: "C:/fake/anyswitch" },
    logger: null,
    metricsCollector: null,
    fetchRelayAgents: async () => null,
    dataBundleService,
    pickFolderFn,
    pickFileFn,
    ...rest,
  });
}

const okExport = { ok: true, path: "C:/out/anyswitch-export-20260923-120000.zip", sizeBytes: 1234, counts: { providers: 22 }, skippedCredentials: [] };
const okPreview = { ok: true, token: "t1", counts: { providers: 22, credentials: 22 }, hasPlaintextKeys: true, includes: { settings: true }, skillsSourcePath: "C:/skills" };
const okApply = { ok: true, backupId: "20260923-120500", backupDir: "C:/anyswitch/backups/pre-import-20260923-120500", applied: { store: true, credentials: 22 } };

function spyBundle() {
  const calls = [];
  return {
    calls,
    service: {
      exportBundle: async (arg) => { calls.push(["export", arg]); return okExport; },
      previewBundle: async (arg) => { calls.push(["preview", arg]); return okPreview; },
      applyBundle: async (arg) => { calls.push(["apply", arg]); return okApply; },
    },
  };
}

describe("panel data routes", () => {
  it("导出与导入都要过面板变更守卫（缺请求头 = 403 csrf）", async () => {
    const { service } = spyBundle();
    const router = dataRouter({ dataBundleService: service });
    for (const path of ["/panel/api/data/export", "/panel/api/data/import-preview", "/panel/api/data/import-apply"]) {
      const { req, res, json } = fakeReqRes(path, "POST", { targetDir: "C:/out" }, { "x-anyswitch-panel": undefined });
      await router.handle(req, res);
      assert.equal(res.statusCode, 403, path);
      assert.deepEqual(json(), { ok: false, error: "csrf" });
    }
  });

  it("export 把 targetDir 交给服务并原样回传结果", async () => {
    const spy = spyBundle();
    const router = dataRouter({ dataBundleService: spy.service });
    const { req, res, json } = fakeReqRes("/panel/api/data/export", "POST", { targetDir: " C:/out " });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(spy.calls[0][1].targetDir, "C:/out", "路径两端空白应被收掉");
    assert.equal(json().path, okExport.path);
    assert.equal(json().ok, true);
  });

  it("export 缺 targetDir 报 400，不当成内部错误", async () => {
    const spy = spyBundle();
    const router = dataRouter({ dataBundleService: spy.service });
    const { req, res, json } = fakeReqRes("/panel/api/data/export", "POST", {});
    await router.handle(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(json().error, /targetDir/);
    assert.equal(spy.calls.length, 0);
  });

  it("export-pick 选完目录直接落包；用户取消则只回 cancelled", async () => {
    const spy = spyBundle();
    let picked = null;
    const router = dataRouter({
      dataBundleService: spy.service,
      pickFolderFn: async () => ({ cancelled: false, path: "C:/picked" }),
      pickFileFn: async (arg) => { picked = arg; return { cancelled: true }; },
    });
    const first = fakeReqRes("/panel/api/data/export-pick", "POST", {});
    await router.handle(first.req, first.res);
    assert.equal(json2(first).ok, true);
    assert.equal(json2(first).pickedPath, "C:/picked");
    assert.equal(spy.calls[0][0], "export");
    assert.equal(spy.calls[0][1].targetDir, "C:/picked");

    const second = fakeReqRes("/panel/api/data/import-pick", "POST", {});
    await router.handle(second.req, second.res);
    assert.deepEqual(json2(second), { ok: true, cancelled: true });
    assert.equal(spy.calls.length, 1, "取消后不应继续调用服务");
  });

  it("import-preview 回摘要与票据，import-apply 只交票据与可选的 skills 位置", async () => {
    const spy = spyBundle();
    const router = dataRouter({ dataBundleService: spy.service });
    const prev = fakeReqRes("/panel/api/data/import-preview", "POST", { zipPath: "C:/in/a.zip" });
    await router.handle(prev.req, prev.res);
    assert.equal(json2(prev).token, "t1");
    assert.equal(json2(prev).hasPlaintextKeys, true);

    const apply = fakeReqRes("/panel/api/data/import-apply", "POST", { token: "t1", skillsRepoPath: "D:/new/skills" });
    await router.handle(apply.req, apply.res);
    assert.equal(spy.calls[1][0], "apply");
    assert.deepEqual(spy.calls[1][1], { token: "t1", skillsRepoPath: "D:/new/skills" });
    assert.equal(json2(apply).backupId, okApply.backupId);
  });

  it("skillsRepoPath 缺省时交 undefined，让服务用包内记的来源路径", async () => {
    const spy = spyBundle();
    const router = dataRouter({ dataBundleService: spy.service });
    const { req, res } = fakeReqRes("/panel/api/data/import-apply", "POST", { token: "t1" });
    await router.handle(req, res);
    assert.equal(spy.calls[0][1].skillsRepoPath, undefined);
  });

  it("业务失败以 200 + ok:false 回界面（坏包、过期票据都是可用信息，不是异常）", async () => {
    const router = dataRouter({
      dataBundleService: {
        previewBundle: async () => ({ ok: false, error: "包里缺 manifest.json，不像 anyswitch 导出包" }),
        applyBundle: async () => ({ ok: false, error: "导入确认已过期，请重新选择导出包" }),
        exportBundle: async () => ({ ok: false, error: "导出目录不存在，请重新选择" }),
      },
    });
    const prev = fakeReqRes("/panel/api/data/import-preview", "POST", { zipPath: "C:/in/a.zip" });
    await router.handle(prev.req, prev.res);
    assert.equal(prev.res.statusCode, 200);
    assert.equal(json2(prev).ok, false);
    assert.match(json2(prev).error, /manifest/);

    const apply = fakeReqRes("/panel/api/data/import-apply", "POST", { token: "gone" });
    await router.handle(apply.req, apply.res);
    assert.equal(json2(apply).ok, false);
  });

  it("服务抛错按 statusCode 落地，未知错 500", async () => {
    const router = dataRouter({
      dataBundleService: {
        exportBundle: async () => { const e = new Error("bsdtar 退出码 1"); e.statusCode = 500; throw e; },
        previewBundle: async () => { throw new Error("tar not found"); },
        applyBundle: async () => ({ ok: true }),
      },
    });
    const { req, res, json } = fakeReqRes("/panel/api/data/export", "POST", { targetDir: "C:/out" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 500);
    assert.match(json().error, /bsdtar/);
  });

  it("未知 data 路径落 404，GET 不进变更通道", async () => {
    const spy = spyBundle();
    const router = dataRouter({ dataBundleService: spy.service });
    const { req, res } = fakeReqRes("/panel/api/data/nope", "POST", {});
    await router.handle(req, res);
    assert.equal(res.statusCode, 404);
    const get = fakeReqRes("/panel/api/data/export", "GET");
    await router.handle(get.req, get.res);
    assert.equal(get.res.statusCode, 404);
    assert.equal(spy.calls.length, 0);
  });

  it("退出清理钩子把活儿转给服务；服务还没建起来时静默跳过", () => {
    let dropped = 0;
    const router = dataRouter({ dataBundleService: { dropAllTickets: () => { dropped += 1; } } });
    router.dropDataBundleTickets();
    assert.equal(dropped, 1);

    const lazy = dataRouter({ dataBundleService: null });
    lazy.dropDataBundleTickets(); // 不能为了清理而把服务建起来，也不能抛

    const broken = dataRouter({ dataBundleService: { dropAllTickets: () => { throw new Error("暂存被占用"); } } });
    broken.dropDataBundleTickets(); // 退出路径上不能被一次清理失败卡住
  });
});

// 导入整份覆盖 settings.json 会绕开设置路由上那条 followAgent 副作用链（登录
// 计划 + 常驻自愈进程）。这里验的正是导入后有没有把两者对齐回包里的值——
// 全程假计划假进程，绝不碰真任务计划程序。
function watchdogSpy({ registered = false, alive = false, regOk = true, regError = "拒绝访问", spawnResult, stopResult } = {}) {
  const calls = [];
  return {
    calls,
    fns: {
      isWatchdogAutostartEnabledFn: async () => { calls.push("isRegistered"); return registered; },
      enableWatchdogAutostartFn: async () => { calls.push("enable"); return { ok: regOk, error: regOk ? undefined : regError }; },
      disableWatchdogAutostartFn: async () => { calls.push("disable"); return { ok: regOk, error: regOk ? undefined : regError }; },
      probeWatchdogFn: async () => { calls.push("probe"); return alive; },
      spawnWatchdogFn: async () => { calls.push("spawn"); return spawnResult; },
      stopWatchdogFn: async () => { calls.push("stop"); return stopResult; },
    },
  };
}

function applyRouter({ followAgent, settings = true, ...watch }) {
  const spy = watchdogSpy(watch);
  const router = dataRouter({
    dataBundleService: {
      applyBundle: async () => ({
        ok: true,
        backupId: "20260923-120500",
        applied: { store: true, settings, ...(settings ? { followAgent } : {}) },
      }),
    },
    ...spy.fns,
  });
  return { spy, router };
}

async function doApply(router) {
  const h = fakeReqRes("/panel/api/data/import-apply", "POST", { token: "t1" });
  await router.handle(h.req, h.res);
  return { json: json2(h), res: h.res };
}

describe("导入落定后把 followAgent 的登录计划与自愈进程对齐回来", () => {
  it("包内开、本机没计划也没进程：注册并拉起，不碰注销与停止", async () => {
    const { spy, router } = applyRouter({ followAgent: true, registered: false, alive: false });
    const { json } = await doApply(router);
    assert.equal(json.ok, true);
    assert.deepEqual(spy.calls, ["isRegistered", "enable", "probe", "spawn"]);
    assert.deepEqual(json.watchdog, { desired: true, task: "registered", process: "started", warnings: [], reasons: {} });
  });

  it("包内关、本机计划与进程都在：注销并停止（这条才是真正危险的方向）", async () => {
    const { spy, router } = applyRouter({ followAgent: false, registered: true, alive: true });
    const { json } = await doApply(router);
    assert.deepEqual(spy.calls, ["isRegistered", "disable", "probe", "stop"]);
    assert.deepEqual(json.watchdog, { desired: false, task: "unregistered", process: "stopped", warnings: [], reasons: {} });
  });

  it("值与本机实际状态本就一致：一次写操作都不做", async () => {
    const { spy, router } = applyRouter({ followAgent: true, registered: true, alive: true });
    const { json } = await doApply(router);
    assert.deepEqual(spy.calls, ["isRegistered", "probe"]);
    assert.equal(json.watchdog.task, "unchanged");
    assert.equal(json.watchdog.process, "unchanged");
  });

  it("计划写失败就停在计划这一层：不动进程，只把警告交回去，导入本身不回滚", async () => {
    const { spy, router } = applyRouter({ followAgent: true, registered: false, alive: false, regOk: false });
    const { json, res } = await doApply(router);
    assert.equal(res.statusCode, 200, "数据已落定，这属于要告知、不属于失败");
    assert.equal(json.ok, true);
    assert.equal(json.backupId, "20260923-120500");
    assert.deepEqual(spy.calls, ["isRegistered", "enable"], "计划没写成就不该去动进程");
    assert.equal(json.watchdog.task, "failed");
    assert.equal(json.watchdog.process, "unchanged");
    assert.equal(json.watchdog.warnings.length, 1);
    assert.match(json.watchdog.warnings[0], /登录计划未同步.*拒绝访问/);
    assert.equal(json.watchdog.reasons.task, "拒绝访问", "裸原因要单独交出去，成句文案归前端");
  });

  it("包里没带 settings.json：盘上还是原来那份，六个函数一个都不该调", async () => {
    const { spy, router } = applyRouter({ settings: false, registered: true, alive: true });
    const { json } = await doApply(router);
    assert.equal(spy.calls.length, 0);
    assert.equal(json.watchdog, undefined);
  });

  it("进程答「没做成」（等端口等不到）就是 failed，不能算已对齐", async () => {
    const { spy, router } = applyRouter({ followAgent: true, registered: false, alive: false, spawnResult: { ok: false } });
    const { json } = await doApply(router);
    assert.deepEqual(spy.calls, ["isRegistered", "enable", "probe", "spawn"]);
    assert.equal(json.watchdog.task, "registered");
    assert.equal(json.watchdog.process, "failed");
    assert.match(json.watchdog.warnings[0], /自愈进程未拉起/);
    assert.equal(json.watchdog.reasons.process, "未达到预期状态");
  });

  it("停进程被安全红线挡下时，把带的 reason 原样交回", async () => {
    const { router } = applyRouter({ followAgent: false, registered: true, alive: true, stopResult: { ok: false, reason: "refused to kill PID 1234" } });
    const { json } = await doApply(router);
    assert.equal(json.watchdog.process, "failed");
    assert.match(json.watchdog.warnings[0], /未停止：refused to kill PID 1234/);
    assert.equal(json.watchdog.reasons.process, "refused to kill PID 1234");
  });

  it("探测计划状态本身就失败：不再往下写，警告照实带回", async () => {
    const calls = [];
    const router = dataRouter({
      dataBundleService: { applyBundle: async () => ({ ok: true, applied: { store: true, settings: true, followAgent: true } }) },
      isWatchdogAutostartEnabledFn: async () => { calls.push("isRegistered"); throw new Error("PowerShell 启动失败"); },
      enableWatchdogAutostartFn: async () => { calls.push("enable"); return { ok: true }; },
      disableWatchdogAutostartFn: async () => { calls.push("disable"); return { ok: true }; },
      probeWatchdogFn: async () => { calls.push("probe"); return false; },
      spawnWatchdogFn: async () => { calls.push("spawn"); },
      stopWatchdogFn: async () => { calls.push("stop"); },
    });
    const { json } = await doApply(router);
    assert.deepEqual(calls, ["isRegistered"]);
    assert.equal(json.watchdog.task, "unknown");
    assert.match(json.watchdog.warnings[0], /读不出来/);
  });
});

function json2(handle) {
  return handle.json();
}
