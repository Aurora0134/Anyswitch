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
});
