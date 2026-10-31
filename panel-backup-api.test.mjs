import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe, it } from "node:test";

import { createPanelRouter } from "./panel.mjs";

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
});
