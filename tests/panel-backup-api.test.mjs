import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe, it } from "node:test";

import { createPanelRouter } from "../src/panel/panel.mjs";

// 备份位置端点：路由与真实迁移逻辑一起跑，只把数据根换成临时目录。
// fakeReqRes 沿用 panel-data.test.mjs 的写法。

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

function routerAt(root) {
  return createPanelRouter({
    storePaths: { root },
    logger: null,
    metricsCollector: null,
    fetchRelayAgents: async () => null,
  });
}

function machine() {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-backup-api-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("panel backup location routes", () => {
  it("GET 回当前路径与默认态；换位置后随之更新", async () => {
    const m = machine();
    try {
      const router = routerAt(m.root);
      const first = fakeReqRes("/panel/api/backups", "GET");
      await router.handle(first.req, first.res);
      assert.equal(first.res.statusCode, 200);
      assert.deepEqual(first.json(), { ok: true, path: join(m.root, "backups"), isDefault: true });

      const target = join(m.root, "custom-backups");
      const set = fakeReqRes("/panel/api/backups/set", "POST", { path: target });
      await router.handle(set.req, set.res);
      assert.equal(set.json().ok, true, set.json().error);
      assert.equal(set.json().path, target);
      assert.deepEqual(JSON.parse(readFileSync(join(m.root, "backup-root.json"), "utf8")), { root: target });

      const second = fakeReqRes("/panel/api/backups", "GET");
      await router.handle(second.req, second.res);
      assert.deepEqual(second.json(), { ok: true, path: target, isDefault: false });
    } finally { m.cleanup(); }
  });

  it("换位置会连历史备份一起迁走", async () => {
    const m = machine();
    try {
      const from = join(m.root, "backups");
      mkdirSync(join(from, "pre-import-1"), { recursive: true });
      writeFileSync(join(from, "pre-import-1", "store.json"), "{}", "utf8");
      const target = join(m.root, "moved");

      const router = routerAt(m.root);
      const set = fakeReqRes("/panel/api/backups/set", "POST", { path: target });
      await router.handle(set.req, set.res);
      assert.equal(set.json().moved, 1);
      assert.equal(existsSync(join(target, "pre-import-1", "store.json")), true);
      assert.equal(existsSync(from), false);
    } finally { m.cleanup(); }
  });

  it("目标有同名项：业务失败走 200 + ok:false，设置不落盘", async () => {
    const m = machine();
    try {
      const from = join(m.root, "backups");
      mkdirSync(join(from, "pre-import-1"), { recursive: true });
      const target = join(m.root, "taken");
      mkdirSync(join(target, "pre-import-1"), { recursive: true });

      const router = routerAt(m.root);
      const set = fakeReqRes("/panel/api/backups/set", "POST", { path: target });
      await router.handle(set.req, set.res);
      assert.equal(set.res.statusCode, 200);
      assert.equal(set.json().ok, false);
      assert.match(set.json().error, /pre-import-1/);
      assert.equal(existsSync(join(m.root, "backup-root.json")), false);
      assert.equal(existsSync(from), true, "源目录原样保留");
    } finally { m.cleanup(); }
  });

  it("恢复默认：路径回默认并删掉本机记录", async () => {
    const m = machine();
    try {
      const custom = join(m.root, "custom");
      mkdirSync(custom, { recursive: true });
      writeFileSync(join(m.root, "backup-root.json"), JSON.stringify({ root: custom }), "utf8");

      const router = routerAt(m.root);
      const reset = fakeReqRes("/panel/api/backups/reset", "POST", {});
      await router.handle(reset.req, reset.res);
      assert.equal(reset.json().ok, true, reset.json().error);
      assert.equal(reset.json().path, join(m.root, "backups"));
      assert.equal(existsSync(join(m.root, "backup-root.json")), false);
    } finally { m.cleanup(); }
  });

  it("换位置端点同样受面板变更守卫保护（缺请求头 = 403）", async () => {
    const m = machine();
    try {
      const router = routerAt(m.root);
      const blocked = fakeReqRes("/panel/api/backups/set", "POST", { path: join(m.root, "x") }, { "x-anyswitch-panel": "" });
      await router.handle(blocked.req, blocked.res);
      assert.equal(blocked.res.statusCode, 403);
    } finally { m.cleanup(); }
  });

  it("open 拉起 explorer 开备份根，参数不带 windowsHide（隐形窗口坑）", async () => {
    const m = machine();
    try {
      const calls = [];
      const router = createPanelRouter({
        storePaths: { root: m.root },
        logger: null,
        metricsCollector: null,
        fetchRelayAgents: async () => null,
        spawnExplorerFn: (file, args, options) => { calls.push({ file, args, options }); return { unref() {} }; },
      });
      const open = fakeReqRes("/panel/api/backups/open", "POST", {});
      await router.handle(open.req, open.res);
      assert.equal(open.res.statusCode, 200);
      assert.deepEqual(open.json(), { ok: true });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].file, "explorer.exe");
      assert.deepEqual(calls[0].args, [join(m.root, "backups")]);
      // windowsHide 会让 explorer 的文件夹窗口继承 SW_HIDE：窗口开出来是隐形的，
      // 用户看到的就是「点了没反应」。参数形状整体钉死，回潮即红。
      assert.deepEqual(calls[0].options, { detached: true, stdio: "ignore" });
      assert.equal(existsSync(join(m.root, "backups")), true, "explorer 要有东西可开：目录先建出来");
    } finally { m.cleanup(); }
  });

  it("GET /list：回两族备份的名称/族/时间/大小，按名降序；空根回空数组", async () => {
    const m = machine();
    try {
      const dir = join(m.root, "backups");
      mkdirSync(join(dir, "pre-import-20261031-120000"), { recursive: true });
      writeFileSync(join(dir, "pre-import-20261031-120000", "store.json"), "{\"a\":1}", "utf8");
      writeFileSync(join(dir, "pre-import-20261031-120000", "manifest.json"),
        JSON.stringify({ backupId: "20261031-120000", createdAt: "2026-10-31T04:00:00.000Z", saved: ["store.json"] }), "utf8");
      mkdirSync(join(dir, "byok-import-20261030-090000", "kimi"), { recursive: true });
      writeFileSync(join(dir, "byok-import-20261030-090000", "kimi", "config.toml"), "xx", "utf8");
      mkdirSync(join(dir, "not-a-backup"), { recursive: true });

      const router = routerAt(m.root);
      const list = fakeReqRes("/panel/api/backups/list", "GET");
      await router.handle(list.req, list.res);
      assert.equal(list.res.statusCode, 200);
      const payload = list.json();
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.items.map((i) => i.name), ["pre-import-20261031-120000", "byok-import-20261030-090000"],
        "按名降序，同名异物不进列表");
      assert.deepEqual(Object.keys(payload.items[0]).sort(), ["createdAt", "kind", "name", "sizeBytes"], "条目形状");
      assert.equal(payload.items[0].kind, "pre-import");
      assert.equal(payload.items[0].createdAt, "2026-10-31T04:00:00.000Z", "manifest 优先");
      assert.equal(payload.items[0].sizeBytes,
        Buffer.byteLength("{\"a\":1}") + Buffer.byteLength(JSON.stringify({ backupId: "20261031-120000", createdAt: "2026-10-31T04:00:00.000Z", saved: ["store.json"] })),
        "大小递归求和");
      assert.equal(payload.items[1].kind, "byok-import");
      assert.equal(payload.items[1].sizeBytes, 2);
      assert.equal(new Date(payload.items[1].createdAt).getTime(), new Date(2026, 9, 30, 9, 0, 0).getTime(), "无 manifest 回退名解析");

      // 既有 GET /panel/api/backups 响应形状不受新路由影响（deepEqual 原样钉住）。
      const info = fakeReqRes("/panel/api/backups", "GET");
      await router.handle(info.req, info.res);
      assert.deepEqual(info.json(), { ok: true, path: join(m.root, "backups"), isDefault: true });

      const empty = machine();
      try {
        const emptyList = fakeReqRes("/panel/api/backups/list", "GET");
        await routerAt(empty.root).handle(emptyList.req, emptyList.res);
        assert.deepEqual(emptyList.json(), { ok: true, items: [] });
      } finally { empty.cleanup(); }
    } finally { m.cleanup(); }
  });

  it("POST /delete：删掉指定备份目录并回 ok；锚定外的名字拒绝且目录原样保留", async () => {
    const m = machine();
    try {
      const dir = join(m.root, "backups");
      mkdirSync(join(dir, "pre-import-20261031-120000"), { recursive: true });
      writeFileSync(join(dir, "pre-import-20261031-120000", "store.json"), "{}", "utf8");
      mkdirSync(join(dir, "my-own-folder"), { recursive: true });
      writeFileSync(join(dir, "my-own-folder", "a.txt"), "x", "utf8");

      const router = routerAt(m.root);
      const del = fakeReqRes("/panel/api/backups/delete", "POST", { name: "pre-import-20261031-120000" });
      await router.handle(del.req, del.res);
      assert.equal(del.res.statusCode, 200);
      assert.deepEqual(del.json(), { ok: true });
      assert.equal(existsSync(join(dir, "pre-import-20261031-120000")), false);

      for (const bad of ["my-own-folder", "../backups", "pre-import-20261031-120000/extra", "pre-import-1"]) {
        const refused = fakeReqRes("/panel/api/backups/delete", "POST", { name: bad });
        await router.handle(refused.req, refused.res);
        assert.equal(refused.res.statusCode, 200, `业务失败走 200：${bad}`);
        assert.equal(refused.json().ok, false, `应拒绝：${bad}`);
      }
      assert.equal(existsSync(join(dir, "my-own-folder", "a.txt")), true, "用户自建目录一个字节不动");

      const gone = fakeReqRes("/panel/api/backups/delete", "POST", { name: "byok-import-20261030-090000" });
      await router.handle(gone.req, gone.res);
      assert.equal(gone.json().ok, false);
      assert.match(gone.json().error, /备份不存在/);
    } finally { m.cleanup(); }
  });

  it("删除端点同样受面板变更守卫保护（缺请求头 = 403）", async () => {
    const m = machine();
    try {
      const router = routerAt(m.root);
      const blocked = fakeReqRes("/panel/api/backups/delete", "POST", { name: "pre-import-20261031-120000" }, { "x-anyswitch-panel": "" });
      await router.handle(blocked.req, blocked.res);
      assert.equal(blocked.res.statusCode, 403);
    } finally { m.cleanup(); }
  });

  it("POST /restore：写回备份内容并先留安全备份，回 safetyName；byok 名被拒", async () => {
    const m = machine();
    try {
      const localAppData = join(m.root, "localappdata");
      const root = join(localAppData, "Anyswitch");
      const backupsDir = join(root, "backups");
      const backupDir = join(backupsDir, "pre-import-20261031-120000");
      const alphaStore = {
        version: 2,
        providers: { alpha: { displayName: "alpha", baseURL: "https://alpha.example/v1", protocol: "openai-compatible", credentialFile: "alpha.dpapi", models: {} } },
        pools: {},
        routingChains: {},
      };
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(backupDir, "store.json"), JSON.stringify(alphaStore, null, 2) + "\n", "utf8");
      writeFileSync(join(backupDir, "manifest.json"),
        JSON.stringify({ backupId: "20261031-120000", createdAt: "2026-10-31T04:00:00.000Z", saved: ["store.json"] }), "utf8");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "store.json"), JSON.stringify({ version: 2, providers: {}, pools: {}, routingChains: {} }, null, 2) + "\n", "utf8");

      // base 注入临时 LOCALAPPDATA：惰性建的 data-bundle 服务整棵数据根都在沙箱里。
      const router = createPanelRouter({
        storePaths: { root },
        base: { LOCALAPPDATA: localAppData },
        logger: null,
        metricsCollector: null,
        fetchRelayAgents: async () => null,
      });
      const restored = fakeReqRes("/panel/api/backups/restore", "POST", { name: "pre-import-20261031-120000" });
      await router.handle(restored.req, restored.res);
      assert.equal(restored.res.statusCode, 200);
      assert.equal(restored.json().ok, true, restored.json().error);
      assert.match(restored.json().safetyName, /^pre-import-\d{8}-\d{6}$/);
      assert.deepEqual(JSON.parse(readFileSync(join(root, "store.json"), "utf8")), alphaStore, "备份内容已写回");
      assert.equal(existsSync(join(backupsDir, restored.json().safetyName, "store.json")), true, "安全备份已落盘");
      assert.equal(existsSync(join(backupDir, "store.json")), true, "被恢复的备份原样保留");

      const refused = fakeReqRes("/panel/api/backups/restore", "POST", { name: "byok-import-20261031-120000" });
      await router.handle(refused.req, refused.res);
      assert.equal(refused.res.statusCode, 200, "业务失败走 200");
      assert.equal(refused.json().ok, false);
      assert.match(refused.json().error, /备份名不可用/);
    } finally { m.cleanup(); }
  });

  it("恢复端点同样受面板变更守卫保护（缺请求头 = 403）", async () => {
    const m = machine();
    try {
      const router = routerAt(m.root);
      const blocked = fakeReqRes("/panel/api/backups/restore", "POST", { name: "pre-import-20261031-120000" }, { "x-anyswitch-panel": "" });
      await router.handle(blocked.req, blocked.res);
      assert.equal(blocked.res.statusCode, 403);
    } finally { m.cleanup(); }
  });
});

// ── 恢复路由的 followAgent 对齐 ──────────────────────────────────────
// 恢复整份写回 settings.json，与导入一样绕开设置路由的副作用链：路由按
// 「settings 真被换才调」的判据，把备份里的 followAgent 对齐到登录计划与自愈进程。
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

function restoreRouter({ restoreResult, ...watch }) {
  const spy = watchdogSpy(watch);
  const router = createPanelRouter({
    storePaths: { root: "C:/fake/anyswitch" },
    logger: null,
    metricsCollector: null,
    fetchRelayAgents: async () => null,
    dataBundleService: { restoreBackup: async () => restoreResult },
    ...spy.fns,
  });
  return { spy, router };
}

async function doRestore(router) {
  const h = fakeReqRes("/panel/api/backups/restore", "POST", { name: "pre-import-20261031-120000" });
  await router.handle(h.req, h.res);
  return { json: h.json(), res: h.res };
}

describe("恢复后备份里的 followAgent 与本机登录计划/自愈进程对齐", () => {
  it("备份开、本机没计划也没进程：注册并拉起，响应回传 watchdog 与 safetyName", async () => {
    const { spy, router } = restoreRouter({
      restoreResult: { ok: true, safetyName: "pre-import-20261122-120000", applied: { settings: true, followAgent: true } },
      registered: false, alive: false,
    });
    const { json } = await doRestore(router);
    assert.equal(json.ok, true);
    assert.equal(json.safetyName, "pre-import-20261122-120000");
    assert.deepEqual(spy.calls, ["isRegistered", "enable", "probe", "spawn"]);
    assert.deepEqual(json.watchdog, { desired: true, task: "registered", process: "started", warnings: [], reasons: {} });
  });

  it("备份关、本机计划与进程都在：注销并停止（值相反必调，这条才是真正危险的方向）", async () => {
    const { spy, router } = restoreRouter({
      restoreResult: { ok: true, safetyName: "pre-import-20261122-120000", applied: { settings: true, followAgent: false } },
      registered: true, alive: true,
    });
    const { json } = await doRestore(router);
    assert.deepEqual(spy.calls, ["isRegistered", "disable", "probe", "stop"]);
    assert.deepEqual(json.watchdog, { desired: false, task: "unregistered", process: "stopped", warnings: [], reasons: {} });
  });

  it("值与本机实际状态本就一致：一次写操作都不做", async () => {
    const { spy, router } = restoreRouter({
      restoreResult: { ok: true, safetyName: "pre-import-20261122-120000", applied: { settings: true, followAgent: true } },
      registered: true, alive: true,
    });
    const { json } = await doRestore(router);
    assert.deepEqual(spy.calls, ["isRegistered", "probe"]);
    assert.equal(json.watchdog.task, "unchanged");
    assert.equal(json.watchdog.process, "unchanged");
  });

  it("备份没带 settings.json：盘上设置未动，六个函数一个都不调，响应无 watchdog", async () => {
    const { spy, router } = restoreRouter({
      restoreResult: { ok: true, safetyName: "pre-import-20261122-120000", applied: { settings: false } },
      registered: true, alive: true,
    });
    const { json } = await doRestore(router);
    assert.equal(json.ok, true);
    assert.equal(json.safetyName, "pre-import-20261122-120000", "无设置可对齐时恢复本身照常回执");
    assert.equal(spy.calls.length, 0);
    assert.equal(json.watchdog, undefined);
  });

  it("恢复被拒（ok:false）：不动计划与进程", async () => {
    const { spy, router } = restoreRouter({
      restoreResult: { ok: false, error: "备份不存在" },
      registered: true, alive: true,
    });
    const { json } = await doRestore(router);
    assert.equal(json.ok, false);
    assert.equal(json.error, "备份不存在");
    assert.equal(spy.calls.length, 0);
    assert.equal(json.watchdog, undefined);
  });
});
