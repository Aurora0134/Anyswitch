import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPanelRouter } from "./panel.mjs";

// BYOK 渠道导入端点：路由用假 import 服务跑，绝不 import 真 byok-import.mjs /
// byok-remove.mjs（并行工人交付中，注入的假服务让动态 import 不会触发）。
// fakeReqRes 取自 panel-data.test.mjs 同一套写法。

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

function byokRouter({ byokImportService, ...rest } = {}) {
  return createPanelRouter({
    storePaths: { root: "C:/fake/anyswitch" },
    logger: null,
    metricsCollector: null,
    fetchRelayAgents: async () => null,
    byokImportService,
    ...rest,
  });
}

const okScan = {
  ok: true,
  ticket: "tk-1",
  groups: [
    {
      agentId: "codex",
      agentName: "Codex",
      entries: [
        { key: "codex::abc123", displayName: "我的中转", suggestedId: "my-relay", baseURL: "https://relay.example/v1", modelCount: 3, status: "ok" },
        { key: "codex::def456", displayName: "官方", suggestedId: "official", baseURL: "https://api.example/v1", modelCount: 1, status: "duplicate", reason: "已在中央库" },
      ],
    },
  ],
  scannedAt: "2026-10-07T01:00:00.000Z",
};

const okApply = {
  ok: true,
  imported: 1,
  failed: [],
  removed: ["codex::abc123"],
  removeFailed: [],
  backupDir: "C:/fake/anyswitch/backups/byok-import-20261007-010000",
};

function spyService() {
  const calls = [];
  return {
    calls,
    service: {
      scanLocalConfigs: async () => { calls.push(["scan"]); return okScan; },
      applyImport: async (arg) => { calls.push(["apply", arg]); return okApply; },
      dropTickets: () => { calls.push(["drop"]); },
    },
  };
}

describe("panel byok-import routes", () => {
  it("两条路由都要过面板变更守卫（缺请求头 = 403 csrf）", async () => {
    const spy = spyService();
    const router = byokRouter({ byokImportService: spy.service });
    for (const path of ["/panel/api/byok-import/scan", "/panel/api/byok-import/apply"]) {
      const { req, res, json } = fakeReqRes(path, "POST", {}, { "x-anyswitch-panel": undefined });
      await router.handle(req, res);
      assert.equal(res.statusCode, 403, path);
      assert.deepEqual(json(), { ok: false, error: "csrf" });
    }
    assert.equal(spy.calls.length, 0);
  });

  // scan 响应契约（entries 带选择用 key、不含明文 key 与内部路径）由下面的
  // deepEqual(json(), okScan) 整体承担：strict deepEqual 遇任何多余/缺失字段即红，
  // 路由若向 entries 注入 keyPlaintext/sourcePath/sourceId 这里必然失败。
  it("scan 无 body，调 scanLocalConfigs 并把结果原样回传", async () => {
    const spy = spyService();
    const router = byokRouter({ byokImportService: spy.service });
    const { req, res, json } = fakeReqRes("/panel/api/byok-import/scan", "POST", null);
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(spy.calls, [["scan"]]);
    assert.deepEqual(json(), okScan);
  });

  it("apply 把 ticket / keys / deleteLocal 交给服务并原样回传结果", async () => {
    const spy = spyService();
    const router = byokRouter({ byokImportService: spy.service });
    const { req, res, json } = fakeReqRes("/panel/api/byok-import/apply", "POST", {
      ticket: " tk-1 ",
      keys: ["codex::abc123", " kimi::x9 "],
      deleteLocal: true,
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(spy.calls, [["apply", { ticket: "tk-1", keys: ["codex::abc123", "kimi::x9"], deleteLocal: true }]]);
    assert.deepEqual(json(), okApply);
  });

  it("业务失败以 200 + ok:false 回界面（过期票据、未知勾选都是可用信息，不是异常）", async () => {
    const router = byokRouter({
      byokImportService: {
        scanLocalConfigs: async () => ({ ok: true, ticket: null, groups: [], scannedAt: "2026-10-07T01:00:00.000Z" }),
        applyImport: async () => ({ ok: false, error: "ticket-expired" }),
      },
    });
    const { req, res, json } = fakeReqRes("/panel/api/byok-import/apply", "POST", { ticket: "gone", keys: ["codex::a"], deleteLocal: false });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), { ok: false, error: "ticket-expired" });
  });

  it("apply 缺 deleteLocal 以外的字段各有 400：ticket 空、keys 非数组、keys 含非字符串、deleteLocal 非布尔", async () => {
    const spy = spyService();
    const router = byokRouter({ byokImportService: spy.service });
    const badBodies = [
      [{ keys: ["a::b"], deleteLocal: true }, /ticket/],
      [{ ticket: "t", keys: "a::b", deleteLocal: true }, /keys/],
      [{ ticket: "t", keys: ["a::b", 42], deleteLocal: true }, /keys/],
      [{ ticket: "t", keys: ["a::b", "  "], deleteLocal: true }, /keys/],
      [{ ticket: "t", keys: ["a::b"] }, /deleteLocal/],
    ];
    for (const [body, pattern] of badBodies) {
      const { req, res, json } = fakeReqRes("/panel/api/byok-import/apply", "POST", body);
      await router.handle(req, res);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.match(json().error, pattern);
    }
    assert.equal(spy.calls.length, 0, "校验失败不应触达服务");
  });

  it("服务抛错按 statusCode 落地，未知错 500", async () => {
    const router = byokRouter({
      byokImportService: {
        scanLocalConfigs: async () => { throw new Error("zcode 配置目录不可读"); },
        applyImport: async () => { const e = new Error("store CAS 冲突"); e.statusCode = 409; throw e; },
      },
    });
    const scan = fakeReqRes("/panel/api/byok-import/scan", "POST", null);
    await router.handle(scan.req, scan.res);
    assert.equal(scan.res.statusCode, 500);
    assert.match(scan.json().error, /zcode/);

    const apply = fakeReqRes("/panel/api/byok-import/apply", "POST", { ticket: "t", keys: ["a::b"], deleteLocal: false });
    await router.handle(apply.req, apply.res);
    assert.equal(apply.res.statusCode, 409);
    assert.match(apply.json().error, /CAS/);
  });

  it("未知 byok-import 路径落 404，GET 不进变更通道", async () => {
    const spy = spyService();
    const router = byokRouter({ byokImportService: spy.service });
    const { req, res } = fakeReqRes("/panel/api/byok-import/nope", "POST", {});
    await router.handle(req, res);
    assert.equal(res.statusCode, 404);
    const get = fakeReqRes("/panel/api/byok-import/scan", "GET");
    await router.handle(get.req, get.res);
    assert.equal(get.res.statusCode, 404);
    assert.equal(spy.calls.length, 0);
  });

  it("退出清理钩子把活儿转给服务；服务还没建起来时静默跳过", () => {
    const spy = spyService();
    const router = byokRouter({ byokImportService: spy.service });
    router.dropByokImportTickets();
    assert.deepEqual(spy.calls, [["drop"]]);

    const lazy = byokRouter({ byokImportService: null });
    lazy.dropByokImportTickets(); // 不能为了清理而把服务建起来，也不能抛

    const broken = byokRouter({ byokImportService: { dropTickets: () => { throw new Error("票据表被占用"); } } });
    broken.dropByokImportTickets(); // 退出路径上不能被一次清理失败卡住
  });

  it("panel-host 只调 dropDataBundleTickets 时，BYOK 票据随同一退出钩子一并丢掉", () => {
    const spy = spyService();
    const router = byokRouter({ byokImportService: spy.service });
    router.dropDataBundleTickets();
    assert.deepEqual(spy.calls, [["drop"]]);
  });
});
