import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPanelRouter } from "./panel.mjs";

// Minimal fake HTTP req/res pair. res captures the status code, headers, and
// JSON body the router writes, so a test can assert on them. `body` (optional)
// is replayed into readJsonBody's data/end event listeners.
function fakeReqRes(url, method = "GET", body = null, extraHeaders = {}) {
  const res = {
    statusCode: null,
    headers: {},
    body: "",
    // Minimal event surface: the panel-host self-restart route arms
    // res.once("finish") to time its own exit, so tests need to be able to
    // pull that trigger (see fakeReqRes's caller calling res.emit("finish")).
    _events: {},
    once(event, fn) { (this._events[event] ??= []).push(fn); return res; },
    emit(event) { for (const fn of this._events?.[event] ?? []) fn(); return true; },
    writeHead(code, h) { this.statusCode = code; this.headers = h || {}; },
    end(data) { if (data !== undefined) this.body += data; },
  };
  const listeners = {};
  const req = {
    url,
    method,
    headers: {
      host: "127.0.0.1",
      origin: "http://127.0.0.1:47820",
      "x-anyswitch-panel": "1",
      ...extraHeaders,
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

function routerWith({ relayStatus, relayResult, pulledAgents, metricsCollector } = {}) {
  return createPanelRouter({
    storePaths: { root: "C:/fake/anyswitch" },
    logger: null,
    metricsCollector: metricsCollector ?? null,
    aliasResolver: null,
    aliasPath: null,
    startTime: 123456,
    getRelayStatusFn: async () => relayStatus ?? { status: "stopped", pid: null, port: 47821 },
    startRelayFn: async () => relayResult ?? { ok: true, relay: { status: "running", pid: 4242, port: 47821 } },
    stopRelayFn: async () => relayResult ?? { ok: true, relay: { status: "stopped", pid: null, port: 47821 } },
    restartRelayFn: async () => relayResult ?? { ok: true, relay: { status: "running", pid: 4243, port: 47821 } },
    fetchRelayAgents: async () => pulledAgents ?? null,
  });
}

// 拆分后的面板源码：panel.html（DOM + 两个内联启动脚本）、panel.css（主样式 + 开屏样式
// + style-lab 主题块）、panel.js（原 body 末主脚本）。源码扫描断言按对象选文件。
const panelHtml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
  "utf8",
);
const panelCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.css"),
  "utf8",
);
const panelJs = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
  "utf8",
);

describe("panel router relay control + pull-mode agents", () => {
  it("POST /panel/api/logs/ingest republishes a forwarded entry through the logger bus", async () => {
    const entries = [];
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: {
        info: (m) => entries.push(["info", m]),
        warn: (m) => entries.push(["warn", m]),
        error: (m) => entries.push(["error", m]),
      },
      metricsCollector: null, aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => null,
    });
    const { req, res, json } = fakeReqRes("/panel/api/logs/ingest", "POST", { level: "warn", message: "keep-alive: retrying claude request (empty_stream, attempt 1/1)" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.equal(entries.length, 1);
    assert.equal(entries[0][0], "warn");
    assert.match(entries[0][1], /claude/);
    assert.match(entries[0][1], /empty_stream/);
  });

  it("POST /panel/api/logs/ingest rejects a malformed level as bad request, never logging it", async () => {
    const entries = [];
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: { info: (m) => entries.push(m), warn: (m) => entries.push(m), error: (m) => entries.push(m) },
      metricsCollector: null, aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => null,
    });
    const { req, res } = fakeReqRes("/panel/api/logs/ingest", "POST", { level: "debug", message: "x" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(entries.length, 0);
  });

  it("POST /panel/api/logs/clear resets the logger buffer (真清空)", async () => {
    const { createLogger } = await import("./logger.mjs");
    const logger = createLogger({ sink: () => {} });
    logger.info("stale-entry");
    let clearFrame = null;
    const unsubscribe = logger.subscribe((entry) => { clearFrame = entry; });
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger,
      metricsCollector: null, aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => null,
    });
    const { req, res, json } = fakeReqRes("/panel/api/logs/clear", "POST", {});
    await router.handle(req, res);
    unsubscribe();
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.equal(logger.getHistory().length, 0, "server-side history is gone, refresh cannot resurrect it");
    assert.equal(clearFrame?.type, "clear", "live viewers are told to clear too");
  });

  it("POST /panel/api/logs/clear without the panel header is rejected as CSRF", async () => {
    let cleared = false;
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: { info: () => {}, warn: () => {}, error: () => {}, clear: () => { cleared = true; } },
      metricsCollector: null, aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => null,
    });
    const { req, res } = fakeReqRes("/panel/api/logs/clear", "POST", {}, { origin: "http://evil.example", "x-anyswitch-panel": undefined });
    delete req.headers["x-anyswitch-panel"];
    await router.handle(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(cleared, false, "a foreign page must not wipe the log");
  });

  it("GET /panel/api/relay/status returns the injected relay status", async () => {
    const router = routerWith({ relayStatus: { status: "running", pid: 999, port: 47821 } });
    const { req, res, json } = fakeReqRes("/panel/api/relay/status", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.equal(json().relay.status, "running");
    assert.equal(json().relay.pid, 999);
  });

  it("POST /panel/api/relay/start calls startRelayFn and returns its result", async () => {
    let called = false;
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      startRelayFn: async () => { called = true; return { ok: true, relay: { status: "running", pid: 7, port: 47821 } }; },
      fetchRelayAgents: async () => null,
    });
    const { req, res, json } = fakeReqRes("/panel/api/relay/start", "POST");
    await router.handle(req, res);
    assert.equal(called, true);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.equal(json().relay.pid, 7);
  });

  it("POST /panel/api/relay/stop calls stopRelayFn", async () => {
    let called = false;
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      stopRelayFn: async () => { called = true; return { ok: true, relay: { status: "stopped", pid: null, port: 47821 } }; },
      fetchRelayAgents: async () => null,
    });
    const { req, res, json } = fakeReqRes("/panel/api/relay/stop", "POST");
    await router.handle(req, res);
    assert.equal(called, true);
    assert.equal(json().ok, true);
  });

  it("POST /panel/api/relay/stop without the panel header does not stop the relay", async () => {
    let called = false;
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      stopRelayFn: async () => { called = true; return { ok: true, relay: { status: "stopped", pid: null, port: 47821 } }; },
      fetchRelayAgents: async () => null,
    });
    const { req, res, json } = fakeReqRes("/panel/api/relay/stop", "POST", null, { "x-anyswitch-panel": "" });
    delete req.headers["x-anyswitch-panel"];
    await router.handle(req, res);
    assert.equal(called, false);
    assert.equal(res.statusCode, 403);
    assert.equal(json().error, "csrf");
  });

  it("POST /panel/api/relay/stop from a foreign origin does not stop the relay", async () => {
    let called = false;
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      stopRelayFn: async () => { called = true; return { ok: true }; },
      fetchRelayAgents: async () => null,
    });
    const { req, res, json } = fakeReqRes("/panel/api/relay/stop", "POST", null, { origin: "http://evil.test" });
    await router.handle(req, res);
    assert.equal(called, false);
    assert.equal(res.statusCode, 403);
    assert.equal(json().error, "csrf");
  });

  it("POST /panel/api/relay/stop with referer only (no origin) still works from the panel", async () => {
    let called = false;
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      stopRelayFn: async () => { called = true; return { ok: true, relay: { status: "stopped", pid: null, port: 47821 } }; },
      fetchRelayAgents: async () => null,
    });
    const { req, res, json } = fakeReqRes("/panel/api/relay/stop", "POST", null, {
      origin: "",
      referer: "http://127.0.0.1:47821/panel",
    });
    delete req.headers.origin;
    await router.handle(req, res);
    assert.equal(called, true);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
  });

  it("POST /panel/api/relay/restart calls restartRelayFn", async () => {
    let called = false;
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      restartRelayFn: async () => { called = true; return { ok: true, relay: { status: "running", pid: 8, port: 47821 } }; },
      fetchRelayAgents: async () => null,
    });
    const { req, res, json } = fakeReqRes("/panel/api/relay/restart", "POST");
    await router.handle(req, res);
    assert.equal(called, true);
    assert.equal(json().ok, true);
  });

  it("GET /panel/api/agents uses pulled relay metrics when available (Pull mode)", async () => {
    const pulled = [{ id: "zcode", status: "running", metrics: { totalRequests: 5 } }];
    const router = routerWith({ pulledAgents: pulled });
    const { req, res, json } = fakeReqRes("/panel/api/agents", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.deepEqual(json().agents, pulled);
  });

  it("GET /panel/api/agents falls back to local collector when relay is down", async () => {
    const local = [{ id: "claude", status: "stopped" }];
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, aliasResolver: null, aliasPath: null,
      metricsCollector: { getAgentsStatus: async () => local },
      fetchRelayAgents: async () => null, // relay down -> null
    });
    const { req, res, json } = fakeReqRes("/panel/api/agents", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json().agents, local);
  });

  it("GET /panel/api/agents returns empty array when relay down and no collector", async () => {
    const router = routerWith({ pulledAgents: null });
    const { req, res, json } = fakeReqRes("/panel/api/agents", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json().agents, []);
  });

  it("GET /panel/api/agents serves the last relay pull after a missed pull, not the blind local frame", async () => {
    const pulled = [{ id: "qoder", status: "running", metrics: { totalRequests: 67 } }];
    const blindLocal = [{ id: "qoder", status: "running", metrics: { totalRequests: 0 } }];
    let relayAnswers = true;
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, aliasResolver: null, aliasPath: null,
      metricsCollector: { getAgentsStatus: async () => blindLocal },
      fetchRelayAgents: async () => (relayAnswers ? pulled : null),
    });

    const first = fakeReqRes("/panel/api/agents", "GET");
    await router.handle(first.req, first.res);
    assert.deepEqual(first.json().agents, pulled);

    // A pull that misses its 1500ms budget answers null — the same value a dead
    // relay answers. Substituting this process's own collector there yields a
    // structurally identical frame with 0 requests / no lastSeen, which is what
    // flashed the Qoder card empty on a healthy relay.
    relayAnswers = false;
    const second = fakeReqRes("/panel/api/agents", "GET");
    await router.handle(second.req, second.res);
    assert.equal(second.res.statusCode, 200);
    assert.deepEqual(second.json().agents, pulled, "上一次真快照优先于本地盲帧");
  });

  it("GET /panel/api/model-stability uses pulled relay snapshot when available", async () => {
    const pulled = { window: "8h", buckets: 48, models: [{ model: "glm-4.7", provider: "bigmodel", total: 12, successRate: 99, status: "green", cells: [] }] };
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => null,
      fetchRelayStability: async () => pulled,
    });
    const { req, res, json } = fakeReqRes("/panel/api/model-stability", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.equal(json().models[0].model, "glm-4.7");
  });

  it("GET /panel/api/model-stability falls back to local collector", async () => {
    const snap = { window: "8h", buckets: 48, models: [{ model: "gpt-5.2", total: 3, successRate: 33.3, status: "red", cells: [] }] };
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, aliasResolver: null, aliasPath: null,
      metricsCollector: { getModelStability: () => snap },
      fetchRelayAgents: async () => null,
      fetchRelayStability: async () => null,
    });
    const { req, res, json } = fakeReqRes("/panel/api/model-stability", "GET");
    await router.handle(req, res);
    assert.equal(json().ok, true);
    assert.equal(json().models[0].status, "red");
  });

  // 状态检测号池富化：池 id 行 → poolName；成员 id 行 → poolName + memberName；
  // 无关渠道行原样透传。pulled 与本地 collector 两条路径都过同一富化。
  function poolStoreEnv(models, { pulled = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "anyswitch-panel-pool-"));
    const storeFile = join(dir, "store.json");
    writeFileSync(storeFile, JSON.stringify({
      version: 2,
      providers: {
        "member-a": {
          displayName: "成员甲",
          baseURL: "https://a.example/v1",
          protocol: "openai-compatible",
          credentialFile: "a.bin",
          models: { "m-1": { displayName: "M1" } },
        },
        "member-b": {
          displayName: "成员乙",
          baseURL: "https://b.example/v1",
          protocol: "openai-compatible",
          credentialFile: "b.bin",
          models: { "m-1": { displayName: "M1" } },
        },
        standalone: {
          displayName: "独立渠道",
          baseURL: "https://c.example/v1",
          protocol: "openai-compatible",
          credentialFile: "c.bin",
          models: { "m-2": { displayName: "M2" } },
        },
      },
      pools: {
        "main-pool": { displayName: "主力号池", members: ["member-a", "member-b"] },
      },
    }));
    const router = createPanelRouter({
      storePaths: { root: dir, storeFile, credentialsDir: join(dir, "credentials"), appDir: join(dir, "app") },
      logger: null, metricsCollector: { getModelStability: () => ({ window: "8h", buckets: 48, models }) },
      aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => null,
      fetchRelayStability: async () => (pulled ? { window: "8h", buckets: 48, models } : null),
    });
    return { dir, router };
  }

  it("GET /panel/api/model-stability merges pool + member rows into one pool row (pulled snapshot)", async () => {
    const models = [
      { model: "m-1", provider: "main-pool", total: 9, successRate: 100, status: "green", latencyMs: 100, cacheHit: 50, cells: [{ n: 9, rate: 100, status: "green" }] },
      { model: "m-1", provider: "member-a", total: 1, successRate: 0, status: "red", latencyMs: 0, cacheHit: 0, cells: [{ n: 1, rate: 0, status: "red" }] },
      { model: "m-2", provider: "standalone", total: 4, successRate: 100, status: "green", cells: [] },
    ];
    const { dir, router } = poolStoreEnv(models);
    try {
      const { req, res, json } = fakeReqRes("/panel/api/model-stability", "GET");
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      const rows = json().models;
      assert.equal(rows.length, 2);
      const [poolRow, plainRow] = rows;
      // 尝试级聚合：池路由 9 成功 + 成员直连 1 失败 = 10 次尝试 90%。
      assert.equal(poolRow.provider, "main-pool");
      assert.equal(poolRow.poolId, "main-pool");
      assert.equal(poolRow.poolName, "主力号池");
      assert.equal(poolRow.memberName, undefined);
      assert.equal(poolRow.total, 10);
      assert.equal(poolRow.successRate, 90);
      assert.equal(poolRow.status, "green");
      assert.equal(poolRow.cells[0].n, 10);
      assert.equal(poolRow.cells[0].rate, 90);
      assert.equal(poolRow.cells[0].status, "green");
      assert.equal(plainRow.poolName, undefined);
      assert.equal(plainRow.provider, "standalone");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GET /panel/api/model-stability merges ttftMs weighted by total; non-pool rows pass through", async () => {
    const models = [
      { model: "m-1", provider: "main-pool", total: 9, successRate: 100, status: "green", latencyMs: 100, cacheHit: 0, ttftMs: 100, cells: [{ n: 9, rate: 100, status: "green" }] },
      { model: "m-1", provider: "member-a", total: 1, successRate: 100, status: "green", latencyMs: 50, cacheHit: 0, ttftMs: 200, cells: [{ n: 1, rate: 100, status: "green" }] },
      { model: "m-2", provider: "standalone", total: 4, successRate: 100, status: "green", ttftMs: 123, cells: [] },
    ];
    const { dir, router } = poolStoreEnv(models);
    try {
      const { req, res, json } = fakeReqRes("/panel/api/model-stability", "GET");
      await router.handle(req, res);
      const rows = json().models;
      const poolRow = rows.find((r) => r.poolId === "main-pool");
      // (100×9 + 200×1) / 10 = 110
      assert.equal(poolRow.ttftMs, 110);
      const plainRow = rows.find((r) => r.provider === "standalone");
      assert.equal(plainRow.ttftMs, 123);
      assert.equal(plainRow.poolId, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GET /panel/api/model-stability ignores null ttftMs sides; both null → null", async () => {
    const models = [
      { model: "m-1", provider: "main-pool", total: 8, successRate: 100, status: "green", ttftMs: null, cells: [{ n: 8, rate: 100, status: "green" }] },
      { model: "m-1", provider: "member-a", total: 2, successRate: 100, status: "green", ttftMs: 50, cells: [{ n: 2, rate: 100, status: "green" }] },
      { model: "m-3", provider: "main-pool", total: 5, successRate: 100, status: "green", ttftMs: null, cells: [] },
      { model: "m-3", provider: "member-b", total: 3, successRate: 100, status: "green", ttftMs: null, cells: [] },
    ];
    const { dir, router } = poolStoreEnv(models);
    try {
      const { req, res, json } = fakeReqRes("/panel/api/model-stability", "GET");
      await router.handle(req, res);
      const rows = json().models;
      const oneNull = rows.find((r) => r.model === "m-1");
      // 池侧 ttftMs 为 null 按 0 权重忽略，只剩成员侧 50。
      assert.equal(oneNull.ttftMs, 50);
      const bothNull = rows.find((r) => r.model === "m-3");
      assert.equal(bothNull.ttftMs, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GET /panel/api/model-stability folds a lone member row into its pool (local-collector fallback)", async () => {
    const models = [
      { model: "m-1", provider: "member-b", total: 2, successRate: 50, status: "yellow", cells: [{ n: 2, rate: 50, status: "yellow" }] },
    ];
    const { dir, router } = poolStoreEnv(models, { pulled: false });
    try {
      const { req, res, json } = fakeReqRes("/panel/api/model-stability", "GET");
      await router.handle(req, res);
      const rows = json().models;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].provider, "main-pool");
      assert.equal(rows[0].poolName, "主力号池");
      assert.equal(rows[0].memberName, undefined);
      assert.equal(rows[0].total, 2);
      assert.equal(rows[0].successRate, 50);
      // Status is re-derived from the pool-level thresholds (green≥85,
      // yellow≥70) — 50% is red regardless of what the member row claimed.
      assert.equal(rows[0].status, "red");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GET /panel/api/status reports relay status + panelPort + panel pid", async () => {
    const router = routerWith({ relayStatus: { status: "running", pid: 1234, port: 47821 } });
    const { req, res, json } = fakeReqRes("/panel/api/status", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().running, true);
    assert.equal(json().panelPort, 47820);
    assert.equal(json().pid, process.pid);
    assert.equal(json().relay.status, "running");
    assert.equal(json().relay.pid, 1234);
  });
});

// Watchdog coordination for followAgent: registry FIRST (durable), then
// settings.json, then process control. All watchdog deps are injected so no
// reg.exe and no real watchdog process is touched here.
describe("panel router followAgent watchdog coordination", () => {
  function watchdogRouter(calls, opts = {}) {
    return createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null,
      metricsCollector: null,
      aliasResolver: null,
      aliasPath: null,
      enableWatchdogAutostartFn: async () => { calls.push("reg-enable"); return { ok: true }; },
      disableWatchdogAutostartFn: async () => { calls.push("reg-disable"); return { ok: opts.regDisableFails ? false : true, ...(opts.regDisableFails ? { error: "boom" } : {}) }; },
      isWatchdogAutostartEnabledFn: async () => opts.registryEnabled ?? false,
      spawnWatchdogFn: async () => { calls.push("spawn"); return { ok: true }; },
      stopWatchdogFn: async () => { calls.push("stop"); return { ok: true }; },
      probeWatchdogFn: async () => opts.probe ?? false,
      fetchRelayAgents: async () => null,
    });
  }
  // Point settings.json at a temp dir so POSTs do not touch the real one.
  // mkdir first: atomicWriteFile writes settings.json.<uuid>.tmp next to the
  // target and cannot create intermediate directories itself.
  function tempBase() {
    const dir = mkdtempSync(join(tmpdir(), "anyswitch-panel-wd-"));
    const relayDataRoot = join(dir, "Anyswitch");
    mkdirSync(relayDataRoot, { recursive: true });
    return { base: { LOCALAPPDATA: dir, USERPROFILE: join(dir, "user") }, dir };
  }

  it("POST followAgent=true: registry key first, then save, then spawn watchdog", async () => {
    const calls = [];
    const { base } = tempBase();
    const router = createPanelRouter({
      base,
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      enableWatchdogAutostartFn: async () => { calls.push("reg-enable"); return { ok: true }; },
      disableWatchdogAutostartFn: async () => { calls.push("reg-disable"); return { ok: true }; },
      isWatchdogAutostartEnabledFn: async () => false,
      spawnWatchdogFn: async () => { calls.push("spawn"); return { ok: true }; },
      stopWatchdogFn: async () => { calls.push("stop"); return { ok: true }; },
      probeWatchdogFn: async () => false,
      fetchRelayAgents: async () => null,
    });
    const { req, res, json } = fakeReqRes("/panel/api/settings", "POST", { followAgent: true });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.deepEqual(calls, ["reg-enable", "spawn"]);
    // and the setting persisted with followAgent true
    const getRes = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(getRes.req, getRes.res);
    assert.equal(JSON.parse(getRes.res.body).settings.followAgent, true);
    rmSync(base.LOCALAPPDATA, { recursive: true, force: true });
  });

  it("POST followAgent=false: registry removal first, then save, then stop watchdog", async () => {
    const calls = [];
    const { base } = tempBase();
    const router = createPanelRouter({
      base,
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      enableWatchdogAutostartFn: async () => { calls.push("reg-enable"); return { ok: true }; },
      disableWatchdogAutostartFn: async () => { calls.push("reg-disable"); return { ok: true }; },
      isWatchdogAutostartEnabledFn: async () => true,
      spawnWatchdogFn: async () => { calls.push("spawn"); return { ok: true }; },
      stopWatchdogFn: async () => { calls.push("stop"); return { ok: true }; },
      probeWatchdogFn: async () => true,
      fetchRelayAgents: async () => null,
    });
    const { req, res } = fakeReqRes("/panel/api/settings", "POST", { followAgent: false });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, ["reg-disable", "stop"]);
    rmSync(base.LOCALAPPDATA, { recursive: true, force: true });
  });

  it("registry failure refuses the save (500) and no watchdog spawn", async () => {
    const calls = [];
    const { base } = tempBase();
    const router = createPanelRouter({
      base,
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      enableWatchdogAutostartFn: async () => ({ ok: false, error: "reg.exe exploded" }),
      disableWatchdogAutostartFn: async () => { calls.push("reg-disable"); return { ok: true }; },
      isWatchdogAutostartEnabledFn: async () => false,
      spawnWatchdogFn: async () => { calls.push("spawn"); return { ok: true }; },
      stopWatchdogFn: async () => { calls.push("stop"); return { ok: true }; },
      probeWatchdogFn: async () => false,
      fetchRelayAgents: async () => null,
    });
    const { req, res, json } = fakeReqRes("/panel/api/settings", "POST", { followAgent: true });
    await router.handle(req, res);
    assert.equal(res.statusCode, 500);
    assert.equal(json().ok, false);
    assert.match(json().error, /watchdog autostart/);
    assert.deepEqual(calls, []);
    rmSync(base.LOCALAPPDATA, { recursive: true, force: true });
  });

  it("GET settings exposes watchdog drift (registry vs process)", async () => {
    const router = watchdogRouter([], { registryEnabled: true, probe: false });
    const { req, res, json } = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json().watchdog, { autostart: true, running: false });
  });

  it("GET settings returns keepAlive.mode from disk, including enhanced", async () => {
    const { base, dir } = tempBase();
    writeFileSync(join(dir, "Anyswitch", "settings.json"), JSON.stringify({
      followAgent: true,
      keepAlive: { enabled: true, mode: "enhanced" },
    }));
    const router = createPanelRouter({
      base,
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      enableWatchdogAutostartFn: async () => ({ ok: true }),
      disableWatchdogAutostartFn: async () => ({ ok: true }),
      isWatchdogAutostartEnabledFn: async () => false,
      spawnWatchdogFn: async () => ({ ok: true }),
      stopWatchdogFn: async () => ({ ok: true }),
      probeWatchdogFn: async () => false,
      fetchRelayAgents: async () => null,
    });
    const { req, res, json } = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().keepAlive.mode, "enhanced");
    assert.equal(json().keepAlive.enabled, true);
    assert.equal(json().settings.keepAlive.mode, "enhanced");
    rmSync(base.LOCALAPPDATA, { recursive: true, force: true });
  });

  it("GET settings migrates the retired basic mode to enhanced", async () => {
    const { base, dir } = tempBase();
    // 旧版 settings.json 形状：keepAlive 仍带 mode 字段。
    writeFileSync(join(dir, "Anyswitch", "settings.json"), JSON.stringify({
      keepAlive: { enabled: true, mode: "basic" },
    }));
    const router = createPanelRouter({
      base,
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      enableWatchdogAutostartFn: async () => ({ ok: true }),
      disableWatchdogAutostartFn: async () => ({ ok: true }),
      isWatchdogAutostartEnabledFn: async () => false,
      spawnWatchdogFn: async () => ({ ok: true }),
      stopWatchdogFn: async () => ({ ok: true }),
      probeWatchdogFn: async () => false,
      fetchRelayAgents: async () => null,
    });
    const { req, res, json } = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().keepAlive.mode, "enhanced");
    assert.equal(json().keepAlive.enabled, true);
    assert.equal(json().settings.keepAlive.mode, "enhanced");
    rmSync(base.LOCALAPPDATA, { recursive: true, force: true });
  });

  it("POST without followAgent patch does not touch watchdog coordination", async () => {
    const calls = [];
    const { base } = tempBase();
    const router = createPanelRouter({
      base,
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      enableWatchdogAutostartFn: async () => { calls.push("reg-enable"); return { ok: true }; },
      disableWatchdogAutostartFn: async () => { calls.push("reg-disable"); return { ok: true }; },
      isWatchdogAutostartEnabledFn: async () => false,
      spawnWatchdogFn: async () => { calls.push("spawn"); return { ok: true }; },
      stopWatchdogFn: async () => { calls.push("stop"); return { ok: true }; },
      probeWatchdogFn: async () => false,
      fetchRelayAgents: async () => null,
    });
    const { req, res } = fakeReqRes("/panel/api/settings", "POST", { keepAlive: { enabled: false } });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, []);
    rmSync(base.LOCALAPPDATA, { recursive: true, force: true });
  });

  it("POST keepAlive.maxRetries persists, clamps to 0-10, and is returned by GET", async () => {
    const { base } = tempBase();
    const router = createPanelRouter({
      base,
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      enableWatchdogAutostartFn: async () => ({ ok: true }),
      disableWatchdogAutostartFn: async () => ({ ok: true }),
      isWatchdogAutostartEnabledFn: async () => false,
      spawnWatchdogFn: async () => ({ ok: true }),
      stopWatchdogFn: async () => ({ ok: true }),
      probeWatchdogFn: async () => false,
      fetchRelayAgents: async () => null,
    });

    const post = fakeReqRes("/panel/api/settings", "POST", { keepAlive: { maxRetries: 3 } });
    await router.handle(post.req, post.res);
    assert.equal(post.res.statusCode, 200);
    assert.equal(post.json().keepAlive.maxRetries, 3);

    const getRes = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(getRes.req, getRes.res);
    assert.equal(getRes.json().keepAlive.maxRetries, 3);
    assert.equal(getRes.json().settings.keepAlive.maxRetries, 3);

    // Out-of-range values are clamped, not persisted raw
    const over = fakeReqRes("/panel/api/settings", "POST", { keepAlive: { maxRetries: 99 } });
    await router.handle(over.req, over.res);
    assert.equal(over.json().keepAlive.maxRetries, 10);
    const under = fakeReqRes("/panel/api/settings", "POST", { keepAlive: { maxRetries: -2 } });
    await router.handle(under.req, under.res);
    assert.equal(under.json().keepAlive.maxRetries, 2);

    rmSync(base.LOCALAPPDATA, { recursive: true, force: true });
  });

  it("POST keepAlive.endpoints persists per endpoint and is returned by GET", async () => {
    const { base } = tempBase();
    const router = createPanelRouter({
      base,
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      enableWatchdogAutostartFn: async () => ({ ok: true }),
      disableWatchdogAutostartFn: async () => ({ ok: true }),
      isWatchdogAutostartEnabledFn: async () => false,
      spawnWatchdogFn: async () => ({ ok: true }),
      stopWatchdogFn: async () => ({ ok: true }),
      probeWatchdogFn: async () => false,
      fetchRelayAgents: async () => null,
    });

    const off = fakeReqRes("/panel/api/settings", "POST", { keepAlive: { endpoints: { claude: { enabled: false } } } });
    await router.handle(off.req, off.res);
    assert.equal(off.res.statusCode, 200);
    assert.deepEqual(off.json().keepAlive.endpoints, { claude: { enabled: false } });

    // A second endpoint patch must not clobber the first entry.
    const second = fakeReqRes("/panel/api/settings", "POST", { keepAlive: { endpoints: { kimi: { enabled: false } } } });
    await router.handle(second.req, second.res);
    assert.deepEqual(second.json().keepAlive.endpoints, { claude: { enabled: false }, kimi: { enabled: false } });
    assert.equal(second.json().keepAlive.mode, "enhanced", "endpoint patches leave the master switch alone");

    const getRes = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(getRes.req, getRes.res);
    assert.deepEqual(getRes.json().keepAlive.endpoints, { claude: { enabled: false }, kimi: { enabled: false } });

    rmSync(base.LOCALAPPDATA, { recursive: true, force: true });
  });
});

// GET /api/settings decorates its response with watchdog drift visibility
// (registry task present vs watchdog process answering). Both probes are
// expensive — a PowerShell Get-ScheduledTask spawn plus an
// HTTP liveness probe — and the panel frontend fetches /api/settings on every
// page load to hydrate the per-endpoint 抗截断 toggle, so paying the probes on
// every GET delayed that toggle ~1.4s. The snapshot serves the probes
// stale-while-revalidate: GETs never wait once a snapshot has settled.
describe("panel router watchdog probe snapshot", () => {
  function tempBase() {
    const dir = mkdtempSync(join(tmpdir(), "anyswitch-panel-wd-snap-"));
    const relayDataRoot = join(dir, "Anyswitch");
    mkdirSync(relayDataRoot, { recursive: true });
    return { base: { LOCALAPPDATA: dir, USERPROFILE: join(dir, "user") }, dir };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  it("prewarm at router creation kicks the first probe round before any request", async () => {
    const { base } = tempBase();
    let calls = 0;
    const hang = new Promise(() => {});
    const router = createPanelRouter({
      base,
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      enableWatchdogAutostartFn: async () => ({ ok: true }),
      disableWatchdogAutostartFn: async () => ({ ok: true }),
      isWatchdogAutostartEnabledFn: async () => { calls++; await hang; return false; },
      spawnWatchdogFn: async () => ({ ok: true }),
      stopWatchdogFn: async () => ({ ok: true }),
      probeWatchdogFn: async () => { calls++; await hang; return false; },
      fetchRelayAgents: async () => null,
    });
    router.prewarmWatchdogProbes();
    await sleep(50);
    assert.equal(calls, 2); // one shared round: registry probe + liveness probe
    rmSync(base.LOCALAPPDATA, { recursive: true, force: true });
  });

  it("once a probe round has settled, GETs are served from the snapshot without re-probing", async () => {
    const { base } = tempBase();
    let autoCalls = 0, probeCalls = 0;
    const hang = new Promise(() => {});
    const router = createPanelRouter({
      base,
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      enableWatchdogAutostartFn: async () => ({ ok: true }),
      disableWatchdogAutostartFn: async () => ({ ok: true }),
      isWatchdogAutostartEnabledFn: async () => { autoCalls++; if (autoCalls > 1) await hang; return false; },
      spawnWatchdogFn: async () => ({ ok: true }),
      stopWatchdogFn: async () => ({ ok: true }),
      probeWatchdogFn: async () => { probeCalls++; if (probeCalls > 1) await hang; return false; },
      fetchRelayAgents: async () => null,
    });
    router.prewarmWatchdogProbes();
    // First GET may cold-wait the settling prewarm round...
    const first = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(first.req, first.res);
    assert.deepEqual(JSON.parse(first.res.body).watchdog, { autostart: false, running: false });
    // ...the second must come off the snapshot: these probes would hang forever.
    const second = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(second.req, second.res);
    assert.deepEqual(JSON.parse(second.res.body).watchdog, { autostart: false, running: false });
    assert.equal(autoCalls, 1);
    assert.equal(probeCalls, 1);
    rmSync(base.LOCALAPPDATA, { recursive: true, force: true });
  });

  it("expired snapshot serves stale immediately while concurrent GETs share one background refresh", async () => {
    const { base } = tempBase();
    let rounds = 0; // each probe round increments this twice (registry + liveness)
    let release = null;
    const gate = new Promise((r) => { release = r; });
    const router = createPanelRouter({
      base,
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      enableWatchdogAutostartFn: async () => ({ ok: true }),
      disableWatchdogAutostartFn: async () => ({ ok: true }),
      isWatchdogAutostartEnabledFn: async () => { rounds++; if (rounds > 2) await gate; return false; },
      spawnWatchdogFn: async () => ({ ok: true }),
      stopWatchdogFn: async () => ({ ok: true }),
      probeWatchdogFn: async () => { rounds++; if (rounds > 2) await gate; return false; },
      fetchRelayAgents: async () => null,
      watchdogSnapshotTtlMs: 0, // every GET sees an expired snapshot
    });
    router.prewarmWatchdogProbes();
    // Prime: cold-waits the settling prewarm round.
    const prime = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(prime.req, prime.res);
    assert.deepEqual(JSON.parse(prime.res.body).watchdog, { autostart: false, running: false });
    assert.equal(rounds, 2);
    // Two concurrent GETs against the expired snapshot: both return the stale
    // value at once (the refresh gate is still shut)...
    const g2 = fakeReqRes("/panel/api/settings", "GET");
    const g3 = fakeReqRes("/panel/api/settings", "GET");
    await Promise.all([router.handle(g2.req, g2.res), router.handle(g3.req, g3.res)]);
    assert.deepEqual(JSON.parse(g2.res.body).watchdog, { autostart: false, running: false });
    assert.deepEqual(JSON.parse(g3.res.body).watchdog, { autostart: false, running: false });
    // ...and exactly one background refresh was shared between them.
    release();
    await sleep(50);
    assert.equal(rounds, 4);
    rmSync(base.LOCALAPPDATA, { recursive: true, force: true });
  });

  it("failed cold probe round fails soft to the legacy nulls and is not cached", async () => {
    const { base } = tempBase();
    let fail = true;
    let calls = 0;
    const router = createPanelRouter({
      base,
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      enableWatchdogAutostartFn: async () => ({ ok: true }),
      disableWatchdogAutostartFn: async () => ({ ok: true }),
      isWatchdogAutostartEnabledFn: async () => { calls++; if (fail) throw new Error("reg.exe exploded"); return false; },
      spawnWatchdogFn: async () => ({ ok: true }),
      stopWatchdogFn: async () => ({ ok: true }),
      probeWatchdogFn: async () => false,
      fetchRelayAgents: async () => null,
    });
    router.prewarmWatchdogProbes();
    const first = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(first.req, first.res);
    assert.equal(first.res.statusCode, 200);
    assert.deepEqual(JSON.parse(first.res.body).watchdog, { autostart: null, running: null });
    // The failure must not poison the snapshot: after recovery the next GET
    // re-probes and reports real values.
    fail = false;
    const second = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(second.req, second.res);
    assert.deepEqual(JSON.parse(second.res.body).watchdog, { autostart: false, running: false });
    assert.equal(calls, 2);
    rmSync(base.LOCALAPPDATA, { recursive: true, force: true });
  });

  it("POST followAgent invalidates the snapshot: the next GET repopulates synchronously", async () => {
    const { base, dir } = tempBase();
    let regOn = false;
    let autoCalls = 0;
    const router = createPanelRouter({
      base,
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      enableWatchdogAutostartFn: async () => { regOn = true; return { ok: true }; },
      disableWatchdogAutostartFn: async () => { regOn = false; return { ok: true }; },
      isWatchdogAutostartEnabledFn: async () => { autoCalls++; return regOn; },
      spawnWatchdogFn: async () => ({ ok: true }),
      stopWatchdogFn: async () => ({ ok: true }),
      probeWatchdogFn: async () => false,
      fetchRelayAgents: async () => null,
    });
    router.prewarmWatchdogProbes();
    const prime = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(prime.req, prime.res);
    assert.equal(JSON.parse(prime.res.body).watchdog.autostart, false);
    const post = fakeReqRes("/panel/api/settings", "POST", { followAgent: true });
    await router.handle(post.req, post.res);
    assert.equal(post.res.statusCode, 200);
    // Without invalidation this GET would serve the pre-POST stale snapshot.
    const after = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(after.req, after.res);
    assert.deepEqual(JSON.parse(after.res.body).watchdog, { autostart: true, running: false });
    assert.equal(autoCalls, 2); // primed once, re-probed once after invalidation
    rmSync(base.LOCALAPPDATA, { recursive: true, force: true });
  });
});

describe("panel.html opencode endpoint card", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );
  // 卡片 DOM 在 panel.html，绑定与渲染逻辑已拆到 panel.js
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );

  it("declares an opencode panel card with its own id prefix", () => {
    assert.ok(panelHtml.includes('data-agent-id="opencode"'), "opencode card container exists");
    for (const id of [
      "opencodeModelBadgesList",
      "opencodeErrorBanner",
      "opencodeErrorMsg",
      "opencodeErrorTime",
      "opencodeEmpty",
      "opencodeMetricsBlock",
      "opencodeInstanceCount",
      "opencodeInstancesList",
      "opencodeSessionRow",
      "opencodeSessionReqs",
      "opencodeSessionTokens",
      "opencodeActiveTag",
      "opencodeLastModelTag",
    ]) {
      assert.ok(panelHtml.includes(`id="${id}"`), `missing element #${id}`);
    }
  });

  it("wires opencode into the card order, refreshAgents and renderOpencode", () => {
    assert.ok(panelJs.includes('"opencode"'), "opencode appears in AGENT_CARD_ORDER");
    const orderMatch = panelJs.match(/AGENT_CARD_ORDER\s*=\s*\[([^\]]+)\]/);
    assert.ok(orderMatch, "AGENT_CARD_ORDER literal found");
    assert.ok(orderMatch[1].includes('"opencode"'), "AGENT_CARD_ORDER contains opencode");
    assert.ok(panelJs.includes('a.id === "opencode"'), "refreshAgents looks up the opencode agent");
    assert.ok(panelJs.includes("renderOpencode(opencode)"), "refreshAgents calls renderOpencode");
    assert.ok(panelJs.includes("function renderOpencode(p)"), "renderOpencode is defined");
  });

  it("keeps the stop-relay display name for opencode", () => {
    assert.ok(panelJs.includes('opencode: "OpenCode"'), "lifecycle modal label map covers opencode");
  });

  it("inline scripts stay syntactically valid JavaScript", () => {
    // 取样含带 id 的内联脚本（panelStartupBootstrap / panelViewPrepaint 等）——
    // 只匹配裸 <script> 会把首帧脚本留在自检之外，而它跑在绘制前、语法错了整页白屏。
    const blocks = [...panelHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(blocks.length >= 4, "panel.html 的内联脚本数量不少于四个");
    for (const code of blocks) {
      // new Function parses the source without executing it — a cheap
      // node --check equivalent for the inline scripts.
      assert.doesNotThrow(() => new Function(code), "inline script must parse");
    }
  });
});

describe("panel.html qoder endpoint card", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );
  // 卡片 DOM 在 panel.html，绑定与渲染逻辑已拆到 panel.js
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );

  it("declares a qoder panel card with its own id prefix", () => {
    assert.ok(panelHtml.includes('data-agent-id="qoder"'), "qoder card container exists");
    for (const id of [
      "qoderModelBadgesList",
      "qoderStateBadge",
      "qoderErrorBanner",
      "qoderErrorMsg",
      "qoderErrorTime",
      "qoderEmpty",
      "qoderMetricsBlock",
      "qoderDetailBrief",
      "qoderTelemetryGrid",
      "qoderSparkTtft",
      "qoderSparkTps",
      "qoderSparkCache",
      "qoderSessionRow",
      "qoderSessionReqs",
      "qoderSessionTokens",
      "qoderActiveTag",
      "qoderLastModelTag",
    ]) {
      assert.ok(panelHtml.includes(`id="${id}"`), `missing element #${id}`);
    }
  });

  it("wires qoder into the card order, refreshAgents and renderQoder", () => {
    const orderMatch = panelJs.match(/AGENT_CARD_ORDER\s*=\s*\[([^\]]+)\]/);
    assert.ok(orderMatch, "AGENT_CARD_ORDER literal found");
    assert.ok(orderMatch[1].includes('"qoder"'), "AGENT_CARD_ORDER contains qoder");
    assert.ok(panelJs.includes('a.id === "qoder"'), "refreshAgents looks up the qoder agent");
    assert.ok(panelJs.includes("renderQoder(qoder)"), "refreshAgents calls renderQoder");
    assert.ok(panelJs.includes("function renderQoder(p)"), "renderQoder is defined");
  });

  it("keeps the stop-relay display name and stats label for qoder", () => {
    assert.ok(panelJs.includes('qoder: "Qoder"'), "lifecycle modal label map covers qoder");
    const statsMatch = panelJs.match(/STATS_ENDPOINT_LABELS\s*=\s*\{[\s\S]*?\n  \}/);
    assert.ok(statsMatch, "STATS_ENDPOINT_LABELS literal found");
    assert.ok(statsMatch[0].includes('qoder: "Qoder"'), "STATS_ENDPOINT_LABELS covers qoder");
  });
});

describe("panel.html codex endpoint card", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );
  // 卡片 DOM 在 panel.html，绑定与渲染逻辑已拆到 panel.js
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );

  it("declares a codex panel card with its own id prefix", () => {
    assert.ok(panelHtml.includes('data-agent-id="codex"'), "codex card container exists");
    for (const id of [
      "codexModelBadgesList",
      "codexErrorBanner",
      "codexErrorMsg",
      "codexErrorTime",
      "codexEmpty",
      "codexMetricsBlock",
      "codexInstanceCount",
      "codexInstancesList",
      "codexSessionRow",
      "codexSessionReqs",
      "codexSessionTokens",
      "codexActiveTag",
      "codexLastModelTag",
    ]) {
      assert.ok(panelHtml.includes(`id="${id}"`), `missing element #${id}`);
    }
  });

  it("wires codex into the card order, refreshAgents and renderCodex", () => {
    const orderMatch = panelJs.match(/AGENT_CARD_ORDER\s*=\s*\[([^\]]+)\]/);
    assert.ok(orderMatch, "AGENT_CARD_ORDER literal found");
    assert.ok(orderMatch[1].includes('"codex"'), "AGENT_CARD_ORDER contains codex");
    assert.ok(panelJs.includes('a.id === "codex"'), "refreshAgents looks up the codex agent");
    assert.ok(panelJs.includes("renderCodex(codex)"), "refreshAgents calls renderCodex");
    assert.ok(panelJs.includes("function renderCodex(p)"), "renderCodex is defined");
  });

  it("renders codex as a multi-instance card like pi (instance rows + delegated fold, no legacy wiring)", () => {
    assert.ok(panelHtml.includes('class="agent-detail-fold" data-prefix="codex"'), "fold button uses data-prefix delegation");
    const m = panelJs.match(/function renderCodex\(p\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "renderCodex found in panel.js");
    assert.ok(m[0].includes('renderInstanceRows({ prefix: "codex"'), "renders instance rows");
    assert.ok(m[0].includes('setInstanceCount("codex", instances.length)'), "drives the instance-count badge");
    assert.ok(m[0].includes('applyDetailFold("codex")'), "applies the delegated fold state");
    assert.ok(m[0].includes('gateAggregateRow("codex", $("codexSessionRow"), instances.length)'), "gates the aggregate row on instance count");
    assert.ok(m[0].includes("buildAggregateFallback(m, p, isGenerating)"), "zero-instance aggregate fallback row");
    assert.ok(!m[0].includes("redrawEndpointSparklines"), "no legacy endpoint-level sparkline path");
    assert.ok(!panelJs.includes("codexTelemetryGrid"), "no endpoint-level telemetry grid");
    const keys = panelJs.match(/const ENDPOINT_SPARK_KEYS = \{[\s\S]*?\n  \};/);
    assert.ok(keys && !keys[0].includes("codex"), "ENDPOINT_SPARK_KEYS stays legacy-only (no codex)");
    const legacyFold = panelJs.match(/\["zc", "qoder"\]\.forEach/);
    assert.ok(legacyFold, "legacy id-wired fold list = zc/qoder only (codex not in it)");
  });

  it("keeps the stop-relay display name and stats label for codex", () => {
    assert.ok(panelJs.includes('codex: "Codex"'), "lifecycle modal label map covers codex");
    const statsMatch = panelJs.match(/STATS_ENDPOINT_LABELS\s*=\s*\{[\s\S]*?\n  \}/);
    assert.ok(statsMatch, "STATS_ENDPOINT_LABELS literal found");
    assert.ok(statsMatch[0].includes('codex: "Codex"'), "STATS_ENDPOINT_LABELS covers codex");
  });

  it("aligns the codex avatar with the shared white-tile pattern (same as qoder)", () => {
    const tile =
      '<div style="width:32px; height:32px; border-radius:8px; background:#fff; display:flex; align-items:center; justify-content:center;">';
    const headingIdx = panelHtml.indexOf("<h3>Codex</h3>");
    assert.ok(headingIdx > 0, "codex card heading exists");
    const brandStart = panelHtml.lastIndexOf('<div class="agent-brand">', headingIdx);
    assert.ok(brandStart >= 0, "codex brand block found");
    const brandBlock = panelHtml.slice(brandStart, headingIdx);
    assert.ok(brandBlock.includes(tile), "codex avatar wrapped in the 32px white rounded tile");
    assert.ok(brandBlock.includes('alt="Codex"'), "existing codex icon asset preserved");
    assert.ok(brandBlock.includes('style="width:24px; height:24px; display:block;'), "icon centered at 24px inside the tile");
    assert.ok(!brandBlock.includes('width="32" height="32"'), "no bare 32px img left on the codex avatar");
  });
});

describe("panel.html DSH endpoint card（卡内分面 + 每进程一行）", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );
  const panelCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.css"),
    "utf8",
  );
  const cardStart = panelHtml.indexOf('data-agent-id="dsh"');
  const cardEnd = panelHtml.indexOf('data-agent-id="', cardStart + 20);
  const dshCard = panelHtml.slice(cardStart, cardEnd);

  it("declares its own instance region and surface subline inside the DSH card", () => {
    assert.ok(cardStart > 0, "dsh card container exists");
    for (const id of [
      "dshInstanceCount",
      "dshSurfaceSummary",
      "dshInstancesWrapper",
      "dshInstancesList",
    ]) {
      assert.ok(dshCard.includes(`id="${id}"`), `dsh card missing #${id}`);
    }
    assert.ok(dshCard.indexOf('id="dshInstancesWrapper"') < dshCard.indexOf('id="dshSessionRow"'),
      "实例盒排在「全局汇总」行之前（与多实例栏同序）");
    assert.ok(panelCss.includes(".instances-table-wrapper"), "实例盒的间距节奏在 CSS 里有定义");
  });

  it("folds with the unified data-prefix mechanism, legacy fold leftovers gone", () => {
    // DSH 卡并入多实例统一折叠（zcode 老机制的端点四宫格/简要栏残留物是
    // 双四宫格并存的根因，本测试钉死其不得回潮）。
    assert.ok(dshCard.includes('data-prefix="dsh"'), "折叠钮走统一事件委托");
    for (const legacy of ["dshTelemetryGrid", "dshDetailBrief", "dshDetailFoldBtn"]) {
      assert.ok(!dshCard.includes(`id="${legacy}"`), `旧机制残留物 #${legacy} 已摘除`);
    }
    const wrapAt = dshCard.indexOf('id="dshInstancesWrapper"');
    const wrapTag = dshCard.slice(dshCard.lastIndexOf("<div", wrapAt), wrapAt);
    assert.ok(wrapTag.includes("instances-table-wrapper"), "实例盒用自家的间距节奏类");
    assert.ok(!wrapTag.includes("detail-open-only"), "实例盒不随展开态收放（行常驻）");
    const rowAt = dshCard.indexOf('id="dshSessionRow"');
    const rowTag = dshCard.slice(dshCard.lastIndexOf("<div", rowAt), rowAt);
    assert.ok(rowTag.includes("detail-open-only"), "「全局汇总」行归入展开态门控");
  });

  it("renders DSH as a canon multi-instance card", () => {
    const m = panelJs.match(/function renderDsh\(d\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "renderDsh found in panel.js");
    assert.ok(m[0].includes('renderInstanceRows({ prefix: "dsh"'), "renders instance rows");
    assert.ok(m[0].includes('setInstanceCount("dsh", instances.length)'), "drives the instance-count badge");
    assert.ok(m[0].includes("showSurface: true"), "行上贴面徽标");
    assert.ok(m[0].includes("renderDshSurfaceSummary(d.surfaces)"), "卡头副行按面汇总");
    assert.ok(m[0].includes("$(\"dshInstancesWrapper\").hidden") || m[0].includes("instancesWrap.hidden = instances.length === 0"),
      "零实例时实例盒收起，不留空盒");
    assert.ok(!m[0].includes("buildAggregateFallback"),
      "不造伪实例行：端点级汇总由实例行与「全局汇总」行承担");
    assert.ok(m[0].includes('applyDetailFold("dsh")'), "折叠态应用走统一管线");
    assert.ok(m[0].includes('gateAggregateRow("dsh", $("dshSessionRow"), instances.length)'), "「全局汇总」行同其他卡门控");
    assert.ok(m[0].includes('setInstanceCount("dsh", 0)'), "未运行分支清零计数与副行");
    for (const oldWire of ["updateDetailBrief", "redrawEndpointSparklines", "dimEndpointRateCards", "isEndpointStale", "$(\"dshTelemetryGrid\")", "$(\"dshTtftVal\")"]) {
      assert.ok(!m[0].includes(oldWire), `旧端点遥测接线 ${oldWire} 已摘除`);
    }
  });

  it("does not opt the other instance cards into the surface badge", () => {
    for (const fn of ["renderPi", "renderKimi", "renderOpencode", "renderCodex", "renderGrok"]) {
      const m = panelJs.match(new RegExp("function " + fn + "\\(p\\) \\{[\\s\\S]*?\\n  \\}"));
      assert.ok(m, fn + " found in panel.js");
      assert.ok(!m[0].includes("showSurface"), `${fn} keeps today's row markup`);
      assert.ok(!m[0].includes("dshInstances"), `${fn} stays free of dsh wiring`);
    }
  });
});

describe("panel.html stats tab", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );
  // 视图容器与 id 在 panel.html，tab 机制与图表函数已拆到 panel.js
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );

  it("declares the stats tab button and view container", () => {
    assert.ok(panelHtml.includes('id="tabStats"'), "tabStats tab button exists");
    assert.ok(panelHtml.includes('id="statsView"'), "statsView section exists");
    assert.ok(panelHtml.includes("使用统计"), "stats tab label exists");
    assert.ok(panelHtml.includes('class="stats-top-grid"'), "two-column top layout exists");
    assert.ok(!panelHtml.includes("statsOvActive"), "active-count card removed");
    // 概览不设日期徽标：今日口径是默认读法
    assert.ok(!panelHtml.includes("statsOverviewDate"), "overview date badge removed");
    for (const id of [
      "statsOvRequests",
      "statsOvTokens",
      "statsOvCache",
      "statsOvTtft",
      "statsOvSuccess",
      "statsHeatmap",
      "statsSegScope",
      "statsSegDays",
      "statsTrendChart",
      "statsTrendLegend",
      "statsTtftChart",
      "statsTtftBars",
      "statsTpsBars",
      "statsEndpoints",
    ]) {
      assert.ok(panelHtml.includes(`id="${id}"`), `missing element #${id}`);
    }
    assert.ok(!panelHtml.includes("statsCacheChart"), "cache hit-rate card removed");
    assert.ok(!panelHtml.includes("statsCacheBars"), "cache by-channel bars removed");
    assert.ok(!panelHtml.includes("statsStability"), "stability card removed");
    // 负向断言覆盖全部三个文件：CSS 规则与脚本都可能让移除的卡复活
    for (const src of [panelHtml, panelJs, panelCss]) {
      assert.ok(!src.includes(".stats-stab-"), "stability card CSS removed");
    }
  });

  it("stats-quad 网格两列各一卡：左列 TTFT、右列 TPS 并排", () => {
    const m = panelHtml.match(/<div class="skills-grid stats-quad">([\s\S]*?)<\/div>\s*\n\s*<!-- G2/);
    assert.ok(m, "stats-quad grid found");
    const cols = m[1].split('<div class="skills-col">').slice(1);
    assert.equal(cols.length, 2, "exactly two skills-col columns");
    assert.ok(cols[0].includes('id="statsTtftChart"') && cols[0].includes('id="statsTtftBars"'),
      "left column holds the TTFT card");
    assert.ok(!cols[0].includes('id="statsTpsBars"'), "left column holds only one card");
    assert.ok(cols[1].includes('id="statsTpsBars"'), "right column holds the TPS card");
  });

  it("extends switchView to four views without changing board/skills/store behavior", () => {
    const m = panelJs.match(/function switchView\(name\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "switchView found in panel.js");
    const body = m[1];
    assert.ok(body.includes('name === "board"'), "board branch preserved");
    assert.ok(body.includes('name === "store"'), "store branch preserved");
    assert.ok(body.includes('name === "stats"'), "stats branch added");
    assert.ok(body.includes('$("statsView").hidden = !stats'), "statsView visibility wired");
    assert.ok(body.includes('$("tabStats").classList.toggle("active", stats)'), "tabStats active state wired");
    assert.ok(body.includes('$("skillsView").hidden = !(name === "skills")'), "skills view still exclusive");
    assert.ok(body.includes("refreshSkillsState()"), "skills refresh preserved");
    assert.ok(body.includes("refreshStoreState()"), "store refresh preserved");
  });

  it("restores the stats tab from localStorage", () => {
    const m = panelJs.match(/function restoreView\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "restoreView found in panel.js");
    assert.ok(m[1].includes('saved === "skills"'), "skills branch preserved");
    assert.ok(m[1].includes('saved === "store"'), "store branch preserved");
    assert.ok(m[1].includes('saved === "stats"'), "stats branch added");
  });

  it("loads persisted stats prefs before the first stats fetch (restoreView ordering)", () => {
    // initSkillsTab 的 restoreView→switchView→enterStatsView 先于 initStatsTab 触发
    // 首次取数；refreshStatsState 必须在读 statsPrefs.days 之前兜底 loadStatsPrefs，
    // 否则刷新后 seg 显示已存选择、数据却按默认 days=7 拉取。
    const m = panelJs.match(/function refreshStatsState\(opts\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "refreshStatsState found in panel.js");
    const loadIdx = m[1].indexOf("loadStatsPrefs()");
    const fetchIdx = m[1].indexOf("/api/stats/state?days=");
    assert.ok(loadIdx !== -1 && fetchIdx !== -1 && loadIdx < fetchIdx,
      "loadStatsPrefs runs before the days-dependent fetch");
    assert.ok(panelJs.includes("let statsPrefsLoaded = false;"), "prefs load is once-only guarded");
  });

  it("wires the stats tab, polls the stats API and pauses when hidden", () => {
    assert.ok(panelJs.includes("initStatsTab();"), "initStatsTab runs during init");
    assert.ok(panelJs.includes('$("tabStats").onclick = () => switchView("stats")'), "tabStats click wired");
    assert.ok(panelJs.includes('api("GET", "/api/stats/state?days='), "stats API endpoint used");
    assert.ok(panelJs.includes("function enterStatsView()"), "enter hook defined");
    assert.ok(panelJs.includes("function leaveStatsView()"), "leave hook defined");
    const m = panelJs.match(/function enterStatsView\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "enterStatsView found in panel.js");
    assert.ok(m[1].includes("document.hidden"), "polling pauses while page hidden");
    assert.ok(m[1].includes("30000"), "30s polling interval");
  });

  it("clamps smooth-path control points so spike-adjacent segments never dip below the baseline", () => {
    const m = panelJs.match(/function statsSmoothPath\(pts, clampY\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "statsSmoothPath(pts, clampY) found in panel.js");
    const fn = new Function(`return function statsSmoothPath(pts, clampY) {${m[1]}\n  }`)();
    // 复现回归场景：零-零段前方两天后有尖峰（像素域 [10, 198]，基线 y=198）。
    const pts = [
      { x: 46, y: 198 }, { x: 221, y: 198 }, { x: 396, y: 10 }, { x: 571, y: 198 },
    ];
    const d = fn(pts, { minY: 10, maxY: 198 });
    const nums = d.match(/-?\d+(\.\d+)?/g).map(Number);
    // C 命令成组出现：c1x c1y c2x c2y x y —— 控制点 y（每组第 2、4 个数）必须在像素域内。
    const cIdx = nums.findIndex((v, i) => d.includes("C") && i > 0);
    assert.ok(cIdx > 0, "path has curve segments");
    for (let i = 1; i < nums.length; i += 2) {
      assert.ok(nums[i] >= 10 && nums[i] <= 198, `y ${nums[i]} outside plot area [10, 198]`);
    }
    // 端点不受影响：起止点保持原坐标。
    assert.ok(d.startsWith("M46.0,198.0"), "start point untouched");
    assert.ok(d.endsWith("571.0,198.0"), "end point untouched");
  });

  it("leaves the zero baseline horizontally so the rise has no slope jump", () => {
    const m = panelJs.match(/function statsSmoothPath\(pts, clampY\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "statsSmoothPath(pts, clampY) found in panel.js");
    const fn = new Function(`return function statsSmoothPath(pts, clampY) {${m[1]}\n  }`)();
    // 零-零-尖峰-零（像素域：基线 y=198，峰值 y=10）。旧 Catmull-Rom + 硬钳制在 x=221 处
    // 入场斜率 0、出场斜率 −0.537，节点两侧折角即用户所见「从 0 升高时斜率跳变」。
    const pts = [
      { x: 46, y: 198 }, { x: 221, y: 198 }, { x: 396, y: 10 }, { x: 571, y: 198 },
    ];
    const nums = fn(pts, { minY: 10, maxY: 198 }).match(/-?\d+(\.\d+)?/g).map(Number);
    const at = (i) => ({ x: nums[i], y: nums[i + 1] });
    const segs = [];
    for (let i = 2; i + 5 < nums.length; i += 6) {
      segs.push({ c1: at(i), c2: at(i + 2), end: at(i + 4) });
    }
    assert.equal(segs.length, 3, "three curve segments parsed");
    const slope = (a, b) => (Math.abs(b.x - a.x) < 1e-9 ? 0 : (b.y - a.y) / (b.x - a.x));
    assert.ok(Math.abs(slope(at(0), segs[0].c1)) < 1e-9, "flat zero run stays flat");
    assert.ok(Math.abs(slope(segs[0].end, segs[1].c1)) < 1e-9, "rise departs the baseline horizontally");
    for (let i = 0; i + 1 < segs.length; i++) {
      const node = segs[i].end;
      assert.ok(Math.abs(slope(segs[i].c2, node) - slope(node, segs[i + 1].c1)) < 1e-6,
        `tangent continuous at node x=${node.x}`);
    }
  });
});

describe("panel.html sessions tab", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("declares the sessions tab button and view container", () => {
    assert.ok(panelHtml.includes('id="tabSessions"'), "tabSessions tab button exists");
    assert.ok(panelHtml.includes("会话管理"), "sessions tab label exists");
    const btnMatch = panelHtml.match(/<button[^>]*id="tabSessions"[^>]*>/);
    assert.ok(btnMatch, "tabSessions button tag found");
    assert.ok(btnMatch[0].includes('role="tab"'), "tabSessions carries role=tab");
    assert.ok(panelHtml.includes('id="sessionsView"'), "sessionsView section exists");
  });

  it("declares the key sessions view elements", () => {
    for (const id of [
      "sessSearchInput",      // 搜索框
      "sessEndpointFilter",   // 端点筛选
      "sessScroll",           // 列表容器
      "sessDetailCard",       // 详情容器
      "sessBatchToggleBtn",   // 批量管理按钮
      "sessRefreshBtn",       // 刷新按钮
    ]) {
      assert.ok(panelHtml.includes(`id="${id}"`), `missing element #${id}`);
    }
  });

  it("会话视图布局规则存活：注释正文不含裸 */，页头与内容靠 gap 拉开", () => {
    // 注释里出现 */ 会提前结束注释，浏览器随后把中文说明当选择器前奏，
    // 并把紧随其后的第一条真规则整条当作它的声明块丢弃（.sessions-view 曾这样消失）。
    const stripped = panelCss.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!stripped.includes("*/"), "panel.css 注释正文含裸 */，会吞掉紧随的规则");
    assert.ok(/\.sessions-view \{[^}]*gap: 16px/.test(stripped), ".sessions-view 的 gap 规则未被吞");
    assert.ok(/\.sessions-err-host:empty \{[^}]*display: none/.test(stripped),
      "无错误横幅时挂载点不占 flex gap，页头间距不翻倍");
    assert.ok(panelHtml.includes('<div class="sessions-err-host" id="sessErrHost">'),
      "sessErrHost 带 sessions-err-host 类");
  });

  it("extends switchView with the sessions branch and keeps aria-selected in sync", () => {
    const m = panelJs.match(/function switchView\(name\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "switchView found in panel.js");
    const body = m[1];
    assert.ok(body.includes('name === "sessions"'), "sessions branch added");
    assert.ok(body.includes('$("sessionsView").hidden = !sessions'), "sessionsView visibility wired");
    assert.ok(body.includes('$("tabSessions").classList.toggle("active", sessions)'), "tabSessions active state wired");
    // aria-selected 数组漏项会静默破坏 tablist 无障碍语义，必须断言
    assert.ok(body.includes('["tabSessions", sessions]'), "aria-selected sync covers tabSessions");
  });

  it("resets page scroll to the top on every main or settings sub-tab switch", () => {
    const reset = panelJs.match(/function resetPageScroll\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(reset, "resetPageScroll found in panel.js");
    const scrollCalls = [];
    const documentElement = { scrollTop: 240 };
    const body = { scrollTop: 240 };
    const resetPageScroll = new Function("window", "document",
      `return function resetPageScroll() {${reset[1]}\n  }`,
    )(
      { scrollTo: (...args) => scrollCalls.push(args) },
      { documentElement, body },
    );

    resetPageScroll();

    assert.deepEqual(scrollCalls, [[0, 0]], "window scroll resets the page viewport");
    assert.equal(documentElement.scrollTop, 0, "standards-mode scroll position is reset");
    assert.equal(body.scrollTop, 0, "legacy body scroll position is reset");

    const switchView = panelJs.match(/function switchView\(name\) \{([\s\S]*?)\n  \}/);
    assert.ok(switchView, "switchView found in panel.js");
    assert.ok(switchView[1].includes("resetPageScroll();"), "every switchView path resets the page scroll");

    const settingsSubTab = panelJs.match(/function activateSettingsSubTab\(which, animate\) \{([\s\S]*?)\n    \}/);
    assert.ok(settingsSubTab, "activateSettingsSubTab found in panel.js");
    assert.ok(settingsSubTab[1].includes("resetPageScroll();"),
      "every settings sub-tab switch resets the page scroll");
  });

  it("plays the view-enter animation on active switches only, suppressed on restore", () => {
    assert.ok(panelCss.includes("@keyframes viewEnter"), "viewEnter keyframes defined in panel.css");
    assert.ok(
      panelCss.includes(".view-enter { animation: viewEnter 300ms cubic-bezier(0.42, 0, 0.58, 1); }"),
      "view-enter class plays the 300ms easeInOut entrance aligned with the board variant",
    );
    const m = panelJs.match(/function switchView\(name\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "switchView found in panel.js");
    assert.ok(m[1].includes("replayViewEnter(enteredView)"), "switchView plays the entrance on the entered view");
    const re = panelJs.match(/function replayViewEnter\(el\) \{([\s\S]*?)\n  \}/);
    assert.ok(re && re[1].includes('classList.add("view-enter")'), "重播实现收敛在共用 replayViewEnter");
    assert.ok(m[1].includes('playBoardEnter(document.querySelector(".telemetry-view"))'), "board view routed to the variant entrance");
    assert.ok(m[1].includes("suppressViewEnter"), "switchView honors the suppress flag");
    const r = panelJs.match(/function restoreView\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(r, "restoreView found in panel.js");
    assert.ok(r[1].includes("suppressViewEnter = true"), "restoreView suppresses the entrance animation");
    // 置位必须挂在有效分支条件上：saved 为 "board"/无效值时不调 switchView，
    // 无条件置位会让标志残留、吞掉下一次主动切换的动画
    assert.ok(
      r[1].includes('if (saved === "skills" || saved === "presets" || saved === "store" || saved === "stats" || saved === "sessions") suppressViewEnter = true;'),
      "suppress flag is only set when a switchView call follows",
    );
  });

  it("defers the restart-recovery entrance to the splash fade via restartEnterView", () => {
    const r = panelJs.match(/function restoreView\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(r, "restoreView found in panel.js");
    // 重启恢复时恢复分支仍先静默（开屏层还盖着，立即播会在底下播完），
    // 改为记 restartEnterView，init() 末尾挂到开屏淡出起点（onLeave）起播。
    assert.ok(r[1].includes("if (window.panelStartupRestart)"), "restart recovery branch present");
    assert.ok(r[1].includes('restartEnterView = (saved === "skills"'), "restored tab recorded for deferred playback");
    assert.ok(r[1].includes(': "board"'), "board default recorded — the board never passes through switchView on restore");
    assert.ok(!r[1].includes("playBoardEnter("), "no immediate playback while the splash still covers the page");
    // init() 里消费：挂钩子、清标记、onLeave 起播
    const init = panelJs.match(/async function init\(\) \{[\s\S]*?\n  \}/);
    assert.ok(init, "init found in panel.js");
    assert.ok(init[0].includes("window.panelStartupController.onLeave = () => {"), "enter animation hooked onto the splash fade start");
    assert.ok(init[0].includes("restartEnterView = null"), "marker consumed exactly once");
    assert.ok(init[0].includes('if (view === "board") playBoardEnter('), "board routed to the staggered variant");
    assert.ok(init[0].includes('classList.add("view-enter")'), "other views routed to the generic entrance");
    // 声明与默认值
    assert.ok(panelJs.includes("let restartEnterView = null;"), "marker declared with null default");
  });

  it("ports the staggered mount entrance for the board view", () => {
    assert.ok(panelCss.includes("@keyframes boardEnter { from { opacity: 0; transform: translateY(10px); } }"),
      "boardEnter keyframes: fade + 10px rise (panel.css)");
    assert.ok(panelCss.includes("@keyframes boardEnterScale { from { opacity: 0; transform: scale(0.98); } }"),
      "boardEnterScale keyframes for the hero card (panel.css)");
    assert.ok(
      panelCss.includes(".board-card-enter { animation: boardEnter 300ms cubic-bezier(0.42, 0, 0.58, 1) backwards"),
      "cards stagger with 300ms easeInOut and backwards fill (panel.css)",
    );
    const s = panelJs.match(/function switchView\(name\) \{([\s\S]*?)\n  \}/);
    assert.ok(s, "switchView found in panel.js");
    assert.ok(s[1].includes("} else if (board) {"), "board branch split from the generic entrance");
    const m = panelJs.match(/function playBoardEnter\(view\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "playBoardEnter found in panel.js");
    assert.ok(m[1].includes('classList.add("board-enter")'), "container entrance plays");
    assert.ok(m[1].includes('querySelectorAll(".panel-card")'), "stagger covers the board panel cards");
    assert.ok(m[1].includes("!el.hidden"), "hidden cards skipped from the stagger");
    assert.ok(m[1].includes("150 + (i - 1) * 40"), "stagger delay formula 150ms + i*40ms");
    assert.ok(m[1].includes('hero ? "100ms"'), "hero card delay 100ms");
    assert.ok(m[1].includes('hero ? "board-card-enter-scale" : "board-card-enter"'), "hero card uses the scale variant");
  });

  it("restores the sessions tab from localStorage", () => {
    const m = panelJs.match(/function restoreView\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "restoreView found in panel.js");
    assert.ok(m[1].includes('saved === "sessions"'), "sessions branch added");
  });

  it("defines initSessionsTab and wires the tab click to switchView", () => {
    assert.ok(panelJs.includes("function initSessionsTab()"), "initSessionsTab is defined");
    assert.ok(
      panelJs.includes('$("tabSessions").onclick = () => switchView("sessions")'),
      "tabSessions click wired to switchView",
    );
  });

  it("ships the finalized sessions copy", () => {
    // 用户可见文案分布在三个文件（DOM、脚本 toast、CSS 内容），负向与正向都按全量文本断言
    const allUiText = panelHtml + panelJs + panelCss;
    assert.ok(allUiText.includes("删除后不可恢复。"), "delete warning copy exists");
    assert.ok(allUiText.includes("命令已复制，粘贴到终端即可继续会话"), "resume-command copied toast exists");
    assert.ok(allUiText.includes("已删除"), "deleted toast copy exists");
  });

  it("详情端点徽标换会话时瞬时换色，不吃基座 150ms 过渡", () => {
    // 基座 .badge 带 border-color/color/background 三条 150ms 过渡，而详情徽标每次
    // 换会话都整条换色：不覆盖就会让上一个端点的颜色挂在新端点的名字上淡出，读起来
    // 像外框颜色变化滞后。覆盖必须按 id 写——基座与各主题都对 .badge 有规则，靠
    // 类选择器压不住（同权重时由样式表顺序决定）。徽标只在端点之间切换，不需要渐入。
    const css = panelCss;
    assert.ok(/\.badge \{[^}]*transition: background[^}]*border-color/.test(css),
      "基座 .badge 的过渡前提变了，这条断言需要重新核对");
    assert.ok(/#sessDEpBadge \{ transition: none; \}/.test(css),
      "详情端点徽标必须按 id 覆盖掉 .badge 的过渡");
  });
});

// Body size cap + panel.html lookup chain. readJsonBody rejects bodies over
// 1MB with 413 (BodyTooLargeError) — every legitimate panel payload is KB-scale
// JSON — and servePanelHtml resolves ANYSWITCH_PANEL_HTML → bundled
// panel-ui/panel.html → 404, with no legacy desktop fallback.
describe("panel router body limit + panel.html lookup chain", () => {
  // Fake req that streams raw (possibly huge) chunks into readJsonBody's
  // data/end listeners — fakeReqRes only replays JSON.stringify-able bodies.
  function streamingReqRes(url, chunks) {
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
      method: "POST",
      headers: { host: "127.0.0.1", origin: "http://127.0.0.1:47820", "x-anyswitch-panel": "1" },
      on(event, fn) { listeners[event] = fn; return req; },
    };
    queueMicrotask(() => {
      for (const c of chunks) listeners.data?.(c);
      listeners.end?.();
    });
    const json = () => (res.body ? JSON.parse(res.body) : null);
    return { req, res, json };
  }

  it("POST /panel/api/session/report rejects a body over 1MB as 413 without hanging", async () => {
    const router = routerWith();
    // Two 700KB chunks: the second pushes the running total past 1048576.
    const { req, res, json } = streamingReqRes("/panel/api/session/report", [
      Buffer.alloc(700 * 1024, 0x61),
      Buffer.alloc(700 * 1024, 0x61),
    ]);
    await router.handle(req, res);
    assert.equal(res.statusCode, 413);
    assert.equal(json().ok, false);
    assert.equal(json().error, "request body too large");
  });

  it("POST /panel/api/session/report still accepts a body just under the 1MB cap", async () => {
    const router = routerWith();
    const body = JSON.stringify({ pid: 123, pad: "a".repeat(900 * 1024) });
    assert.ok(Buffer.byteLength(body) <= 1024 * 1024, "fixture must stay under the cap");
    const { req, res, json } = streamingReqRes("/panel/api/session/report", [Buffer.from(body)]);
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
  });

  const repoPanelHtml = join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html");

  it("GET /panel serves the bundled panel-ui/panel.html when no env override is set", async () => {
    const saved = process.env.ANYSWITCH_PANEL_HTML;
    delete process.env.ANYSWITCH_PANEL_HTML;
    try {
      const router = routerWith();
      const { req, res } = fakeReqRes("/panel", "GET");
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"], /^text\/html/);
      assert.equal(res.body, readFileSync(repoPanelHtml, "utf8"));
    } finally {
      if (saved !== undefined) process.env.ANYSWITCH_PANEL_HTML = saved;
    }
  });

  it("GET /panel serves ANYSWITCH_PANEL_HTML when the env override is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anyswitch-panel-html-"));
    const custom = join(dir, "custom-panel.html");
    writeFileSync(custom, "<html>env-injected panel</html>");
    const saved = process.env.ANYSWITCH_PANEL_HTML;
    process.env.ANYSWITCH_PANEL_HTML = custom;
    try {
      const router = routerWith();
      const { req, res } = fakeReqRes("/panel", "GET");
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body, "<html>env-injected panel</html>");
    } finally {
      if (saved !== undefined) process.env.ANYSWITCH_PANEL_HTML = saved;
      else delete process.env.ANYSWITCH_PANEL_HTML;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GET /panel 404s when the resolved html path does not exist (no fallback)", async () => {
    const saved = process.env.ANYSWITCH_PANEL_HTML;
    process.env.ANYSWITCH_PANEL_HTML = join(tmpdir(), "anyswitch-panel-missing", "panel.html");
    try {
      const router = routerWith();
      const { req, res, json } = fakeReqRes("/panel", "GET");
      await router.handle(req, res);
      assert.equal(res.statusCode, 404);
      assert.equal(json().error, "panel.html not found");
    } finally {
      if (saved !== undefined) process.env.ANYSWITCH_PANEL_HTML = saved;
      else delete process.env.ANYSWITCH_PANEL_HTML;
    }
  });

  it("GET /panel revalidates via ETag: If-None-Match hits 304, changed content changes the ETag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anyswitch-panel-etag-"));
    const custom = join(dir, "panel.html");
    writeFileSync(custom, "<html>v1</html>");
    const saved = process.env.ANYSWITCH_PANEL_HTML;
    process.env.ANYSWITCH_PANEL_HTML = custom;
    try {
      const router = routerWith();
      const first = fakeReqRes("/panel", "GET");
      await router.handle(first.req, first.res);
      assert.equal(first.res.statusCode, 200);
      assert.equal(first.res.body, "<html>v1</html>");
      const etag1 = first.res.headers.etag;
      assert.ok(etag1, "first response carries an ETag derived from size+mtimeMs");
      assert.equal(first.res.headers["cache-control"], "no-cache");

      // Same size+mtimeMs → cached body → If-None-Match short-circuits to 304.
      const second = fakeReqRes("/panel", "GET", null, { "if-none-match": etag1 });
      await router.handle(second.req, second.res);
      assert.equal(second.res.statusCode, 304);
      assert.equal(second.res.body, "");
      assert.equal(second.res.headers.etag, etag1);

      // Content change → size/mtime change → cache miss → 200 with a new ETag.
      writeFileSync(custom, "<html>v2 changed</html>");
      const third = fakeReqRes("/panel", "GET", null, { "if-none-match": etag1 });
      await router.handle(third.req, third.res);
      assert.equal(third.res.statusCode, 200);
      assert.equal(third.res.body, "<html>v2 changed</html>");
      assert.ok(third.res.headers.etag, "changed content still carries an ETag");
      assert.notEqual(third.res.headers.etag, etag1);
    } finally {
      if (saved !== undefined) process.env.ANYSWITCH_PANEL_HTML = saved;
      else delete process.env.ANYSWITCH_PANEL_HTML;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("panel router logo asset", () => {
  it("HEAD /panel/assets/logo.png returns PNG headers without a body, including query params", async () => {
    const expected = readFileSync(new URL("./docs/assets/logo.png", import.meta.url));
    const router = routerWith();
    for (const path of ["/panel/assets/logo.png", "/panel/assets/logo.png?startup=1&v=2"]) {
      const { req, res } = fakeReqRes(path, "HEAD", null, { host: "127.0.0.1:47820" });
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["content-type"], "image/png");
      assert.equal(Number(res.headers["content-length"]), expected.length);
      assert.equal(res.headers["cache-control"], "no-cache");
      assert.equal(res.headers.location, undefined);
      assert.equal(res.body, "");
    }
  });

  it("unknown panel asset paths remain unavailable", async () => {
    const router = routerWith();
    for (const path of ["/panel/assets/other.png", "/panel/assets/logo.png/", "/docs/assets/logo.png"]) {
      const { req, res } = fakeReqRes(path, "GET");
      await router.handle(req, res);
      assert.equal(res.statusCode, 404);
    }
  });

  it("GET /panel/assets/logo.png serves the bundled PNG bytes on the same origin, including query params", async () => {
    const expected = readFileSync(new URL("./docs/assets/logo.png", import.meta.url));
    const router = routerWith();
    for (const path of ["/panel/assets/logo.png", "/panel/assets/logo.png?startup=1&v=2"]) {
      const { req, res } = fakeReqRes(path, "GET", null, { host: "127.0.0.1:47820" });
      const chunks = [];
      res.end = (data) => { if (data !== undefined) chunks.push(data); };
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["content-type"], "image/png");
      assert.equal(Number(res.headers["content-length"]), expected.length);
      assert.equal(res.headers["cache-control"], "no-cache");
      assert.equal(res.headers.location, undefined);
      assert.ok(chunks.every((chunk) => Buffer.isBuffer(chunk)), "PNG must not be decoded as text");
      assert.deepEqual(Buffer.concat(chunks), expected);
    }
  });
});

describe("panel router route-chain runtime", () => {
  it("GET /panel/api/route-chain/runtime uses the pulled relay snapshot when available", async () => {
    const pulled = {
      endpoints: {
        zcode: { current: { node: "chan-b", model: "model-b" }, since: 1700000000000, retryIntervalMs: 300000 },
      },
    };
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => null,
      fetchRelayChainRuntime: async () => pulled,
    });
    const { req, res, json } = fakeReqRes("/panel/api/route-chain/runtime", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.deepEqual(json().endpoints.zcode, pulled.endpoints.zcode);
  });

  it("GET /panel/api/route-chain/runtime falls back to an empty endpoints map when the relay is down", async () => {
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => null,
      fetchRelayChainRuntime: async () => null,
    });
    const { req, res, json } = fakeReqRes("/panel/api/route-chain/runtime", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.deepEqual(json().endpoints, {});
  });
});


describe("panel.html 路由链状态（灯色口径 + 胶囊 auto 标记 + 左栏路由链卡）", () => {
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );
  const panelCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.css"),
    "utf8",
  );

  // 胶囊 auto 标记只认条目自身的服务归因 (viaAuto)：胶囊反映当前服务的模型，
  // 角标表示该服务来自 auto 链。链位置快照不参与胶囊判定（那是左栏路由链卡的
  // 职责）；直连流量从数据源上就不携带 viaAuto，因此不会按链名误挂。
  function makeAutoMark() {
    const m = panelJs.match(/function autoRouteMarkForTarget\(chain, providerId, modelName, viaAuto\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "autoRouteMarkForTarget found in panel.js");
    return new Function(`return (${m[0]});`)();
  }
  const CHAIN = [{ node: "a", model: "m1" }, { node: "b", model: "m2" }, { node: "c", model: "m3" }];

  it("viaAuto 条目按（渠道,模型）在链配置里精确定位位次", () => {
    const mark = makeAutoMark();
    assert.deepEqual(mark(CHAIN, "b", "m2", true), { cur: 1, total: 3 });
    assert.deepEqual(mark(CHAIN, "a", "m1", true), { cur: 0, total: 3 });
  });

  it("非 viaAuto 条目一律不标记（直连流量从数据源上就不会携带归因）", () => {
    const mark = makeAutoMark();
    assert.equal(mark(CHAIN, "b", "m2", false), null);
    assert.equal(mark(CHAIN, "a", "m1", false), null, "与链上模型同名的直连条目也不标记");
  });

  it("链上不存在的（渠道,模型）配位仍挂标但不带位次（cur:-1，链重编辑兼容）", () => {
    const mark = makeAutoMark();
    assert.deepEqual(mark(CHAIN, "x", "m2", true), { cur: -1, total: 3 });
  });

  it("无链 / 空模型名不标记", () => {
    const mark = makeAutoMark();
    assert.equal(mark(null, "b", "m2", true), null);
    assert.equal(mark(CHAIN, "b", "", true), null);
  });

  // 胶囊数据整形：同名坍缩修复的渲染层入口。新 relay 快照带 activeTargets
  // （渠道×模型复合账本）→ 逐条出双段胶囊；旧 relay 无此字段 → 退化为旧名单。
  function makeCapsuleTargetList() {
    const m = panelJs.match(/function capsuleTargetList\(st\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "capsuleTargetList found in panel.js");
    // 虚拟模型判定委托 hasDisplayIdentity（与 capsuleLabel 委托 routeNodeName
    // 同样的注入方式）：面板这里只测列表整形与过滤。
    const h = panelJs.match(/function hasDisplayIdentity\(providerId, model\) \{[\s\S]*?\n  \}/);
    assert.ok(h, "hasDisplayIdentity found in panel.js");
    return new Function("hasDisplayIdentity", `return (${m[0]});`)(new Function(`return (${h[0]});`)());
  }

  it("capsuleTargetList：新快照 activeTargets 逐条出（渠道,模型,活跃,归因）", () => {
    const list = makeCapsuleTargetList()({
      activeTargets: [
        { providerId: "A", model: "a", count: 1, autoCount: 1 },
        { providerId: "B", model: "a", count: 2, autoCount: 0 },
      ],
      lastModel: "old",
    });
    assert.deepEqual(list, [
      { providerId: "A", model: "a", active: true, viaAuto: true },
      { providerId: "B", model: "a", active: true, viaAuto: false },
    ]);
  });

  it("capsuleTargetList：无渠道的虚拟 auto 条目被丢弃（不把路由胶水当模型名显示）", () => {
    const fn = makeCapsuleTargetList();
    // 旧 relay（未重启的 per-launch 中继）与预检失败的请求都会送来这种条目：
    // 没有渠道配对的 auto 没有任何可展示身份。
    assert.deepEqual(fn({ activeTargets: [{ providerId: null, model: "auto", count: 1, autoCount: 1 }] }), []);
    assert.deepEqual(fn({ activeTargets: [], lastModel: "auto", lastProvider: null, lastViaAuto: true }), []);
    assert.deepEqual(fn({ activeModels: ["auto"] }), []);
    assert.deepEqual(fn({ lastModel: "auto" }), []);
    // 真实模型不受影响（无渠道维度时仍按旧口径单段显示）
    assert.deepEqual(fn({ activeTargets: [{ providerId: null, model: "m", count: 1, autoCount: 0 }] }), [
      { providerId: null, model: "m", active: true, viaAuto: false },
    ]);
  });

  it("capsuleTargetList：活跃账本空 → 最近灰胶囊携带 lastProvider/lastViaAuto 来源", () => {
    const list = makeCapsuleTargetList()({ activeTargets: [], lastModel: "m", lastProvider: "B", lastViaAuto: true });
    assert.deepEqual(list, [{ providerId: "B", model: "m", active: false, viaAuto: true }]);
    assert.deepEqual(makeCapsuleTargetList()({ activeTargets: [] }), []);
  });

  it("capsuleTargetList：旧 relay 无 activeTargets → 退化为旧名单（无渠道、无标记）", () => {
    const fn = makeCapsuleTargetList();
    assert.deepEqual(fn({ activeModels: ["m1", "m2"] }), [
      { providerId: null, model: "m1", active: true, viaAuto: false },
      { providerId: null, model: "m2", active: true, viaAuto: false },
    ]);
    assert.deepEqual(fn({ currentModel: "m3" }), [{ providerId: null, model: "m3", active: true, viaAuto: false }]);
    assert.deepEqual(fn({ lastModel: "m4" }), [{ providerId: null, model: "m4", active: false, viaAuto: false }]);
    assert.deepEqual(fn({}), []);
  });

  // 渠道段显示名委托 routeNodeName（池 id 先 pools 后 providers 的前科在它身上，
  // 由路由链编辑器套件覆盖）；这里只测 capsuleLabel 自己的守卫与拼装。
  function makeCapsuleLabel() {
    const m = panelJs.match(/function capsuleLabel\(providerId, model\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "capsuleLabel found in panel.js");
    return (routeNodeName, providerId, model) => new Function("routeNodeName", `return (${m[0]});`)(routeNodeName)(providerId, model);
  }

  it("capsuleLabel：渠道段委托 routeNodeName；虚拟 auto 与无渠道条目保持单段", () => {
    const label = makeCapsuleLabel();
    const nameOf = (id) => ({ P: "池P", A: "渠A" })[id] ?? id;
    assert.equal(label(nameOf, "P", "m"), "池P/m");
    assert.equal(label(nameOf, "A", "m"), "渠A/m");
    assert.equal(label(() => "X名", "X", "m"), "X名/m");
    assert.equal(label(nameOf, null, "m"), "m");
    assert.equal(label(nameOf, "A", "auto"), "auto");
  });

  it("实例行不重复挂「模型 @ 渠道」标签：端点卡胶囊已是渠道×模型复合键", () => {
    assert.ok(!panelJs.includes("instanceTagBubble"), "instanceTagBubble gone");
    assert.ok(!panelJs.includes("instanceTargetOf"), "instanceTargetOf gone");
    assert.ok(!panelJs.includes("modelTag"), "modelTag slot gone");
  });

  it("卡头不含 Flow Rail：mini 轨道 CSS 与渲染入口均不存在", () => {
    assert.ok(!panelCss.includes("route-seg--mini"), "mini seg CSS gone");
    assert.ok(!panelJs.includes("renderRouteChainStatus"), "rail renderer gone");
    assert.ok(!panelCss.includes(".route-rail {"), "rail container CSS gone");
  });

  it("左栏路由链卡与 auto 胶囊的钩子存在", () => {
    assert.ok(panelHtml.includes('id="routeRailCard"'), "sidebar card hook");
    assert.ok(panelHtml.includes('id="routeRailList"'), "sidebar list hook");
    assert.ok(panelCss.includes(".badge-auto {"), "badge-auto CSS");
    assert.ok(panelCss.includes(".badge-auto-tag"), "auto tag CSS");
    assert.ok(panelJs.includes("renderRouteChainBoard();"), "board renderer wired into polling");
    assert.ok(panelJs.includes("renderModelBadges(modelBadgesList,"), "badge helper wired into cards");
  });

  it("claude 卡头「模型: …」与胶囊同源（虚拟 auto 不会从卡头漏出）", () => {
    const m = panelJs.match(/function renderClaude\(c\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "renderClaude found in panel.js");
    assert.ok(m[0].includes("capsuleTargetList(c)"), "卡头复用胶囊同一份过滤后的列表");
    assert.ok(!m[0].includes("c.activeModels"), "卡头不再直接读未过滤的 activeModels");
  });

  it("右键菜单项文案为「删除」", () => {
    assert.ok(panelJs.includes('{ label: "删除", danger: true'), "menu item renamed to 删除");
    assert.ok(!panelJs.includes('label: "从链中移除"'), "old label gone");
  });

  // 灯色数据源：runtime lamps（每次启动重新统计），不是 stability 缓存判定；
  // 无黄档，runtime 缺失时链首默认点亮。
  function makeRailLights() {
    const re = new RegExp("function routeRailLights\\(items, rt\\) \\{[\\s\\S]*?\\n  \\}");
    const m = panelJs.match(re);
    assert.ok(m, "routeRailLights found in panel.js");
    return (items, rt) => new Function("items", "rt", `return (${m[0]})(items, rt);`)(items, rt);
  }

  it("灯色取 runtime lamps，逐节点透传", () => {
    const items = [{ node: "a", model: "m1" }, { node: "b", model: "m2" }, { node: "c", model: "m3" }];
    assert.deepEqual(makeRailLights()(items, { lamps: ["red", "green", "gray"] }), ["red", "green", "gray"]);
  });

  it("runtime 缺失/长度不符时退化为链首绿、其余灰（开启时只见第一个亮灯）", () => {
    const items = [{ node: "a", model: "m1" }, { node: "b", model: "m2" }];
    assert.deepEqual(makeRailLights()(items, null), ["green", "gray"]);
    assert.deepEqual(makeRailLights()(items, {}), ["green", "gray"]);
    assert.deepEqual(makeRailLights()(items, { lamps: ["red"] }), ["green", "gray"], "长度不符不采用");
  });

  it("链路状态区不含 TTFT 黄档判定", () => {
    assert.ok(!panelJs.includes("ROUTE_TTFT_WARN_MS"), "链路状态区不得含 ROUTE_TTFT_WARN_MS");
    assert.ok(!panelJs.includes("routeNodeLamp"), "stability-based lamp gone");
    assert.ok(!panelJs.includes("lampWord"), "悬浮窗灯色文字 gone");
    assert.ok(!/黄灯|绿灯/.test(panelJs), "链路状态区不再出现灯色名称字样");
  });
});

describe("panel.html stats tab 图表可读性（bar-fill 块级 / niceMax 密档 / 热力线性分档）", () => {
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );
  const panelCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.css"),
    "utf8",
  );

  function makeNiceMax() {
    const m = panelJs.match(/function statsNiceMax\(v\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "statsNiceMax found in panel.js");
    return new Function("v", m[1]);
  }

  function makeHeatLevel(maxT) {
    const m = panelJs.match(/const level = (\(t\) => \{[\s\S]*?\n    \});/);
    assert.ok(m, "heatmap level closure found in panel.js");
    return new Function("maxT", `return ${m[1]};`)(maxT);
  }

  it("stats-bar-fill 是块级元素（span 无 display:block 时宽高塌陷，横条只剩空黑轨道）", () => {
    const m = panelCss.match(/\.stats-bar-fill \{([^}]*)\}/);
    assert.ok(m, ".stats-bar-fill rule found in panel.css");
    assert.match(m[1], /display:\s*block/, "fill must be block-level for width/height to apply");
  });

  it("statsNiceMax 密档取整：峰值利用率不低于 80%（旧 {1,2,2.5,5,10} 档把峰值压到 ~50%）", () => {
    const niceMax = makeNiceMax();
    assert.equal(niceMax(0), 1);
    for (const v of [1.21, 2.6, 4.2, 5.1, 8.5, 26, 51, 260, 5100]) {
      const cap = niceMax(v);
      assert.ok(cap >= v, `niceMax(${v})=${cap} 必须不小于数据峰值`);
      assert.ok(v / cap >= 0.79, `niceMax(${v})=${cap} 余量过大，曲线峰值利用率不足 80%`);
    }
    // 经典取整边界保持不变
    assert.equal(niceMax(1), 1);
    assert.equal(niceMax(2), 2);
    assert.equal(niceMax(2.5), 2.5);
    assert.equal(niceMax(5), 5);
    assert.equal(niceMax(10), 10);
  });

  it("热力图 level 按当日值/90 天最大值的线性相对比例分 4 档（对数档把同数量级值全压到顶格 lv4）", () => {
    const level = makeHeatLevel(100);
    assert.equal(level(0), 0, "无数据为空色");
    assert.equal(level(10), 1);
    assert.equal(level(40), 2);
    assert.equal(level(60), 3, "同数量级中段值须与顶值拉开档位（对数档下 60 与 100 同为 lv4）");
    assert.equal(level(100), 4);
  });

  it("热力图 level 兜底：maxT<=0 时一律空色", () => {
    assert.equal(makeHeatLevel(0)(5), 0);
  });

  it("今日概览卡头有手动刷新键：disabled 变暗反馈 + 数据落地后重播生长动画", () => {
    assert.ok(panelHtml.includes('id="statsRefreshBtn"'), "刷新按钮存在");
    assert.match(
      panelJs,
      /\$\("statsRefreshBtn"\)\.onclick = \(\) => runStatsRefreshWithFeedback\(\)/,
      "按钮点击走带反馈的刷新包装（暗到动画播完才亮）",
    );
    assert.ok(panelCss.includes(".stats-header-actions { display: flex"), "卡头操作区并排布局规则存在");
    const m = panelJs.match(/async function runStatsRefreshWithFeedback\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "runStatsRefreshWithFeedback found in panel.js");
    const fn = m[1];
    assert.ok(fn.includes("if (btn.disabled) return;"), "连点防护：暗着时重复点击直接忽略");
    assert.ok(fn.includes("btn.disabled = true"), "点击即变暗（.btn:disabled 45%）");
    assert.ok(fn.includes('refreshStatsState({ replay: true })'), "刷新带 replay 标记");
    // 亮起串在 reveal 播完之后（STATS_MORPH_MS=1500，环 1400ms 先收尾），不提前
    const awaitIdx = fn.indexOf("await refreshStatsState");
    const waitIdx = fn.indexOf("setTimeout(r, STATS_MORPH_MS)");
    const enableIdx = fn.indexOf("btn.disabled = false");
    assert.ok(awaitIdx !== -1 && waitIdx !== -1 && awaitIdx < waitIdx && waitIdx < enableIdx,
      "顺序：刷新 → 等动画播完 → 亮起");
    assert.ok(fn.includes("finally"), "失败路径也恢复按钮（toast 由 refreshStatsState 弹）");
  });

  it("手动刷新重播生长动画：replay 重置趋势 reveal 标记与环揭示标记后再渲染", () => {
    const m = panelJs.match(/async function refreshStatsState\(opts\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "refreshStatsState found in panel.js");
    const body = m[1];
    const replayIdx = body.indexOf("opts && opts.replay");
    assert.ok(replayIdx !== -1, "replay option parsed");
    // 重置必须落在 renderStatsAll 之前（否则当次渲染已按旧标记走 morph/静默）
    const resetIdx = body.indexOf('if (replay) { statsTrendPrev = null; statsUsageRevealed = false; }');
    const renderIdx = body.indexOf("renderStatsAll()");
    assert.ok(resetIdx !== -1 && renderIdx !== -1 && resetIdx < renderIdx,
      "replay resets statsTrendPrev + statsUsageRevealed before renderStatsAll");
    // 30s 轮询仍是静默路径，不带 replay
    assert.ok(panelJs.includes("refreshStatsState({ silent: true })"), "poll stays silent (morph)");
  });
});

describe("panel.html stats 横条：右端对齐 + 上限留白", () => {
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );
  const panelCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.css"),
    "utf8",
  );

  it("容器改 grid 三列共享列宽（数值列 max-content 取全组最长行，各行轨道右端严格对齐）", () => {
    assert.ok(panelJs.includes('el.classList.add("stats-bars")'), "statsRenderBars 给容器挂 grid 类");
    const m = panelCss.match(/\.stats-bars \{([^}]*)\}/);
    assert.ok(m, ".stats-bars rule found in panel.css");
    assert.match(m[1], /display:\s*grid/, "container is grid");
    assert.match(m[1], /max-content/, "value column sized to the longest row");
    assert.ok(panelCss.includes(".stats-bar-row { display: contents"), "rows join the shared grid");
    assert.ok(!panelCss.includes(".stats-bar-row { display: flex"), "old per-row flex rule gone");
    assert.ok(
      panelCss.includes(".stats-bars .empty-hint { grid-column: 1 / -1"),
      "empty hint spans all grid columns",
    );
  });

  it("最长条不顶到轨道满宽：填充上限 STATS_BAR_FILL_MAX < 100", () => {
    const m = panelJs.match(/STATS_BAR_FILL_MAX = (\d+)/);
    assert.ok(m, "STATS_BAR_FILL_MAX defined");
    const cap = Number(m[1]);
    assert.equal(cap, 85, `cap=${cap} 应为 85（最长条留 15% 呼吸余量）`);
    assert.ok(
      panelJs.includes("/ maxV) * STATS_BAR_FILL_MAX"),
      "fill width scales by the cap instead of 100%",
    );
  });
});

describe("panel router route-chain enabled 开关 API", () => {
  function routerWithStoreService(storeService) {
    return createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => null,
      storeService,
    });
  }

  it("POST /panel/api/store/route-chain/enabled 透传 endpointId+enabled 到 service", async () => {
    const calls = [];
    const router = routerWithStoreService({
      setRouteChainEnabled: async (endpointId, enabled) => {
        calls.push({ endpointId, enabled });
        return { ok: true, endpointId, enabled };
      },
    });
    const { req, res, json } = fakeReqRes("/panel/api/store/route-chain/enabled", "POST", { endpointId: "kimi", enabled: false });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, [{ endpointId: "kimi", enabled: false }]);
    assert.equal(json().ok, true);
  });

  it("POST /panel/api/store/route-chain/enabled 拒绝非布尔 enabled 与空 endpointId", async () => {
    const router = routerWithStoreService({
      setRouteChainEnabled: async () => ({ ok: true }),
    });
    const bad1 = fakeReqRes("/panel/api/store/route-chain/enabled", "POST", { endpointId: "kimi", enabled: "yes" });
    await router.handle(bad1.req, bad1.res);
    assert.equal(bad1.res.statusCode, 400);
    const bad2 = fakeReqRes("/panel/api/store/route-chain/enabled", "POST", { endpointId: "  ", enabled: true });
    await router.handle(bad2.req, bad2.res);
    assert.equal(bad2.res.statusCode, 400);
  });
});

describe("panel.html 自动路由卡片启用开关 + agentUsingAutoRoute 口径", () => {
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );

  // 从 panel.js 抠出 agentUsingAutoRoute 函数体，注入 boardRoutingChains 做行为测试
  function makeAgentUsingAutoRoute(chains) {
    const m = panelJs.match(/function agentUsingAutoRoute\(agentId, st\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "agentUsingAutoRoute found in panel.js");
    return new Function("boardRoutingChains", `return (${m[0]});`)(() => chains);
  }

  it("判定口径看开关+运行态：链存在且 enabled!==false 且端点 running 才视为正在用 auto", () => {
    const chain = [{ node: "chan-a", model: "m1" }];
    const fn = makeAgentUsingAutoRoute([{ endpointId: "kimi", chain, enabled: true }]);
    // st 里活跃模型不是 auto 也命中——开关本身就是「正在用 auto 工作」的声明
    assert.deepEqual(fn("kimi", { status: "running", activeModels: ["m1"] }), chain);
    assert.equal(fn("zcode", { status: "running", activeModels: ["auto"] }), null, "未配链端点不命中");
  });

  it("开关关（enabled:false）时不命中，即使端点 running 且最近模型是 auto", () => {
    const chain = [{ node: "chan-a", model: "m1" }];
    const fn = makeAgentUsingAutoRoute([{ endpointId: "kimi", chain, enabled: false }]);
    assert.equal(fn("kimi", { status: "running", activeModels: ["auto"], lastModel: "auto" }), null);
  });

  it("端点关闭（非 running）后链路状态区一并收起：不命中，回原胶囊逻辑", () => {
    const chain = [{ node: "chan-a", model: "m1" }];
    const fn = makeAgentUsingAutoRoute([{ endpointId: "kimi", chain, enabled: true }]);
    assert.equal(fn("kimi", { status: "stopped", activeModels: [], lastModel: "auto" }), null,
      "stopped agent must collapse the chain area even with an enabled chain");
    assert.equal(fn("kimi", undefined), null, "missing status object also collapses");
  });

  it("链卡片渲染带 per-endpoint 启用开关（沿用 .toggle 滑块控件），与「编辑/配置路由链」并列", () => {
    assert.ok(panelJs.includes("data-route-enabled"), "route chain card carries a data-route-enabled toggle");
    const m = panelJs.match(/<label class="toggle"[^>]*>[\s\S]*?data-route-enabled[\s\S]*?<\/label>/);
    assert.ok(m, "toggle uses the existing .toggle switch control");
  });

  it("开关变更打到 /api/store/route-chain/enabled", () => {
    assert.ok(panelJs.includes("/api/store/route-chain/enabled"), "toggle posts to the enabled API");
  });

  it("瓦片墙渲染：三态瓦片 + 图标克隆看板 avatar + 进 tab 刷新 store 数据", () => {
    assert.ok(panelJs.includes('class="route-ep-tile'), "renders tiles");
    assert.ok(panelJs.includes("route-ep-tile--empty"), "未配置瓦片变体");
    assert.ok(!panelJs.includes("route-ep-tile--off"), "质感与启用/配置状态解耦：无 --off 变体");
    assert.ok(panelJs.includes("data-route-avatar"), "瓦片带图标槽位");
    assert.ok(panelJs.includes(".agent-cards-container .panel-card[data-agent-id="),
      "图标克隆自看板卡 .agent-avatar（与抗截断端点钮同源）");
    assert.ok(panelJs.includes('route: ["settingsTabRoute", "settingsPanelRoute"]'),
      "settingsSubTabs 注册自动路由子 tab");
    assert.ok(panelJs.includes('if (which === "route") refreshStoreState();'),
      "进自动路由 tab 刷新 store 数据");
    assert.ok(!panelJs.includes("route-chain-card"), "旧小链卡渲染已移除");
    assert.ok(!panelJs.includes("store-route-chain-fold"), "折叠态 localStorage 已移除");
    assert.ok(!panelJs.includes("routeFoldCard"), "折叠逻辑已移除");
  });
});

describe("panel.html 渠道列表拖拽重排（DnD + FLIP + 皮肤差分）", () => {
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );
  const panelCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.css"),
    "utf8",
  );
  // 预设列表复刻了同一套拖拽机制，两个模块的源码在 panel.js 里前后相邻；
  // 本组断言只看渠道那段，否则预设段会替渠道段满足断言，渠道机制静默失效也测不出来。
  const dragStart = panelJs.indexOf("// ── 渠道列表拖拽重排");
  const dragEnd = panelJs.indexOf("// ── 卡片 C：渠道详情", dragStart);
  assert.ok(dragStart > 0 && dragEnd > dragStart, "channel drag section found in panel.js");
  const dragHtml = panelJs.slice(dragStart, dragEnd);

  it("renderStoreList 渠道行/池行在非过滤态带 draggable，过滤态不带", () => {
    const m = panelJs.match(/function renderStoreList\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "renderStoreList found in panel.js");
    assert.ok(m[1].includes('draggable="true"'), "rows render draggable attribute");
    assert.ok(m[1].includes("storeListDraggable"), "draggable gated on filter input state");
  });

  it("drop 按 DOM 现序展开池成员并提交 /api/store/reorder", () => {
    assert.ok(panelJs.includes("/api/store/reorder"), "reorder API call exists");
    const m = panelJs.match(/\/api\/store\/reorder",\s*\{\s*order\s*\}/);
    assert.ok(m, "reorder posts {order}");
  });

  it("dragend 置位 suppressStoreClick，click 委托吞掉拖拽后的合成点击", () => {
    assert.ok(panelJs.includes("suppressStoreClick"), "suppressStoreClick flag exists");
    const m = panelJs.match(/\$\("storeList"\)\.addEventListener\("click", \(e\) => \{([\s\S]*?)\n    \}\);/);
    assert.ok(m, "storeList click delegate found");
    assert.ok(m[1].includes("suppressStoreClick"), "click delegate swallows the click after drag");
  });

  it("基础层 + saas/aurora/sepia 三皮肤段均定义 --store-drag-accent", () => {
    assert.match(panelCss, /:root \{[\s\S]*?--store-drag-accent:/, "base :root defines --store-drag-accent");
    for (const skin of ["saas", "aurora", "sepia"]) {
      const re = new RegExp(`:root\\[data-style="${skin}"\\] \\{[\\s\\S]*?--store-drag-accent:`);
      assert.ok(re.test(panelCss), `${skin} skin defines --store-drag-accent`);
    }
  });

  it("reduced-motion 时跳过 FLIP（matchMedia 短路）", () => {
    const m = dragHtml.match(/function storeDragReducedMotion\(\) \{([\s\S]*?)\}/);
    assert.ok(m, "storeDragReducedMotion helper exists");
    assert.ok(m[1].includes('matchMedia("(prefers-reduced-motion: reduce)")'), "matchMedia reduce check");
  });

  it("dragover 不挪行不做行 FLIP：列表静止，只更新指示线槽位", () => {
    const m = dragHtml.match(/addEventListener\("dragover", \(e\) => \{([\s\S]*?)addEventListener\("drop"/);
    assert.ok(m, "dragover handler found");
    assert.ok(!m[1].includes("insertBefore"), "dragover must not move rows");
    assert.ok(!m[1].includes("translateY(${dy}"), "dragover must not FLIP rows");
    assert.ok(m[1].includes("store-drop-indicator") || m[1].includes("Indicator"), "dragover updates the indicator");
    assert.ok(m[1].includes("scrollTop"), "dragover auto-scrolls near the list's top/bottom edge");
  });

  it("drop 一次性重排：DOM 应用新顺序 + 全列表 FLIP（260ms store-drag-ease）", () => {
    const m = dragHtml.match(/addEventListener\("drop", \(e\) => \{([\s\S]*?)addEventListener\("dragend"/);
    assert.ok(m, "drop handler found");
    assert.ok(m[1].includes("insertBefore"), "drop applies the new order in DOM");
    assert.ok(m[1].includes("260ms var(--store-drag-ease)"), "drop FLIP uses 260ms skin easing");
    assert.ok(m[1].includes("store-row-landed"), "landed row pulses");
  });

  it("dragend 只清理态，不再 renderStoreList 恢复（拖动中 DOM 未变）", () => {
    const m = dragHtml.match(/addEventListener\("dragend", \(\) => \{([\s\S]*?)\n    \}\);/);
    assert.ok(m, "dragend handler found");
    assert.ok(!m[1].includes("renderStoreList"), "dragend must not re-render");
    assert.ok(m[1].includes("suppressStoreClick"), "click suppression kept");
  });

  it("空位占位 + 加重指示线（绝对定位/3px/槽间瞬移/左端圆帽）样式齐备", () => {
    const drag = panelCss.match(/\.store-row-dragging[^{]*\{([\s\S]*?)\}/);
    assert.ok(drag, "dragging row style exists in panel.css");
    assert.ok(drag[1].includes("dashed var(--store-drag-accent)"), "placeholder uses dashed accent inset");
    const ind = panelCss.match(/\.store-drop-indicator[^{]*\{([\s\S]*?)\}/);
    assert.ok(ind, "drop indicator style exists in panel.css");
    assert.ok(ind[1].includes("position: absolute"), "indicator absolutely positioned");
    assert.ok(ind[1].includes("3px"), "indicator is 3px heavy");
    assert.ok(!ind[1].includes("transition"), "indicator jumps between slots instantly (no glide transition)");
    assert.ok(panelCss.includes(".store-drop-indicator::before"), "left round cap exists");
    assert.ok(panelCss.includes(".store-row-landed"), "landed highlight style exists");
  });
});

describe("panel.html 预设列表拖拽重排（与渠道列表同款）", () => {
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );
  const panelCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.css"),
    "utf8",
  );
  // 只取预设那段：机制与渠道同款，断言必须落在预设自己的模块上
  const dragStart = panelJs.indexOf("// ── 预设列表拖拽重排");
  const dragEnd = panelJs.indexOf("// ── 卡片 A：全局设置", dragStart);
  assert.ok(dragStart > 0 && dragEnd > dragStart, "preset drag section found in panel.js");
  const dragHtml = panelJs.slice(dragStart, dragEnd);
  const renderFn = panelJs.match(/function renderPresetsList\(\) \{([\s\S]*?)\n  \}/);

  it("预设行在非过滤态带 draggable，过滤态不带", () => {
    assert.ok(renderFn, "renderPresetsList found in panel.js");
    assert.ok(renderFn[1].includes('draggable="true"'), "rows render the draggable attribute");
    assert.ok(renderFn[1].includes("presetsListDraggable"), "draggable gated on the filter input state");
    const gate = panelJs.match(/function presetsListDraggable\(\) \{([\s\S]*?)\}/);
    assert.ok(gate, "presetsListDraggable helper exists");
    assert.ok(gate[1].includes('$("presetsFilterInput").value.trim()'), "gate reads the presets filter input");
  });

  it("拖拽逻辑挂在 presetsList 上并在 init 时接线", () => {
    assert.ok(dragHtml.includes('$("presetsList")'), "handlers bind to #presetsList");
    assert.ok(panelJs.includes("initPresetsListDrag();"), "drag module is initialised");
    for (const evt of ["dragstart", "dragover", "drop", "dragend"]) {
      assert.ok(dragHtml.includes(`addEventListener("${evt}"`), `${evt} handler exists`);
    }
  });

  it("dragover 不挪行不做行 FLIP：列表静止，只更新指示线槽位并边缘自动滚动", () => {
    const m = dragHtml.match(/addEventListener\("dragover", \(e\) => \{([\s\S]*?)addEventListener\("drop"/);
    assert.ok(m, "dragover handler found");
    assert.ok(!m[1].includes("insertBefore"), "dragover must not move rows");
    assert.ok(!m[1].includes("translateY(${dy}"), "dragover must not FLIP rows");
    assert.ok(m[1].includes("preset-drop-indicator"), "dragover updates the indicator");
    assert.ok(m[1].includes("scrollTop"), "dragover auto-scrolls near the list's top/bottom edge");
  });

  it("drop 一次性重排：DOM 应用新顺序 + 全列表 FLIP + 提交 /api/prompts/preset/reorder", () => {
    const m = dragHtml.match(/addEventListener\("drop", \(e\) => \{([\s\S]*?)addEventListener\("dragend"/);
    assert.ok(m, "drop handler found");
    assert.ok(m[1].includes("insertBefore"), "drop applies the new order in DOM");
    assert.ok(m[1].includes("260ms var(--store-drag-ease)"), "drop FLIP uses 260ms skin easing");
    assert.ok(m[1].includes("preset-row-landed"), "landed row pulses");
    assert.ok(m[1].includes('/api/prompts/preset/reorder", { order: nextIds }'), "drop posts the new order");
    assert.ok(m[1].includes("refreshPresetsState()"), "state refreshes after the order lands");
    assert.ok(m[1].includes("renderPresetsList()"), "a failed save restores the previous order");
  });

  it("dragend 只清理态不重渲，并置位 suppressPresetClick 吞掉合成点击", () => {
    const m = dragHtml.match(/addEventListener\("dragend", \(\) => \{([\s\S]*?)\n    \}\);/);
    assert.ok(m, "dragend handler found");
    assert.ok(!m[1].includes("renderPresetsList"), "dragend must not re-render");
    assert.ok(m[1].includes("suppressPresetClick"), "click suppression set");
    const click = panelJs.match(/\$\("presetsList"\)\.addEventListener\("click", \(e\) => \{([\s\S]*?)\n    \}\);/);
    assert.ok(click, "presetsList click delegate found");
    assert.ok(click[1].includes("suppressPresetClick"), "click delegate swallows the click after a drag");
  });

  it("reduced-motion 时跳过 FLIP（matchMedia 短路）", () => {
    const m = dragHtml.match(/function presetDragReducedMotion\(\) \{([\s\S]*?)\}/);
    assert.ok(m, "presetDragReducedMotion helper exists");
    assert.ok(m[1].includes('matchMedia("(prefers-reduced-motion: reduce)")'), "matchMedia reduce check");
  });

  it("预设列表复用同款占位/指示线/落位样式", () => {
    const drag = panelCss.match(/\.store-row-dragging[^{]*\{([\s\S]*?)\}/);
    assert.ok(drag && drag[0].includes(".preset-row-dragging"), "preset rows share the dragging placeholder style");
    const ind = panelCss.match(/\.store-drop-indicator[^{]*\{([\s\S]*?)\}/);
    assert.ok(ind && ind[0].includes(".preset-drop-indicator"), "preset list shares the drop indicator style");
    assert.ok(/\.store-drop-indicator::before, \.preset-drop-indicator::before \{/.test(panelCss), "preset indicator carries the round cap");
    assert.ok(/\.store-row-landed, \.preset-row-landed \{/.test(panelCss), "preset rows share the landed pulse");
    assert.ok(/#storeList, #presetsList \{ position: relative; \}/.test(panelCss), "preset list is a positioning context for the indicator");
  });
});

describe("panel.html per-instance telemetry TTFT sparkline", () => {
  // 多实例化后端点级四宫格已不在，实例级四宫格必须自带 tps/cache/TTFT 三条
  // sparkline——任一条漏接都会让 kimi/opencode/pi 三栏静默失去该折线图。
  // 以下断言覆盖容器、缓冲、绘制三个环节。
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );

  it("gives the per-instance 首字响应时间 card its own sparkline container", () => {
    assert.ok(/const sparkTtftId = prefix \+ "InstSparkTtft-" \+ domId;/.test(panelJs),
      "renderInstanceRows derives a stable InstSparkTtft id");
    assert.ok(/首字响应时间<\/span>\s*<div class="telemetry-sparkline" id="\$\{sparkTtftId\}"><\/div>/.test(panelJs),
      "TTFT card header carries the telemetry-sparkline div");
  });

  it("records and draws TTFT history in the per-instance spark buffer", () => {
    assert.ok(/instanceSparkBuffers\[key\] = \{ tps: \[\], cache: \[\], ttft: \[\] \}/.test(panelJs),
      "buffer allocation includes a ttft array");
    assert.ok(/pushOne\(buf\.ttft, vals \? vals\.ttft : null\);/.test(panelJs),
      "pushInstanceSpark feeds ttft samples");
    assert.ok(/ttft: typeof ttft === "number" && ttft > 0 \? ttft \/ 1000 : null,/.test(panelJs),
      "renderInstanceRows pushes lastTtftMs in seconds (endpoint-level unit parity)");
    // 折叠门控：绘制收在 if (open) 内，权威历史暂存到 buf.sparkHistory
    // （折叠期间无 inst 可用），两条路径口径见 panel-instance-fold.test.mjs。
    assert.ok(/updateSparkline\(sparkTtftId, sparkValues\(buf\.ttft, buf\.sparkHistory\?\.ttft\)\);/.test(panelJs),
      "sparkline redraws each render, seeded from buffer-stashed authoritative history");
  });
});

describe("panel.html 实例行状态徽标恒为生成中/待命（不随链归因换装）", () => {
  // 实例行状态徽标只有生成中/待命两态：「这条请求走没走自动路由」由端点模型胶囊
  // 上的 auto 角标单独表达，不由状态徽标换装承担；伪「全局汇总」行不挂状态徽标。
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );

  function makeRenderStateBadge() {
    // 截「const stateBadge = 」到语句末（模板串内无分号，首个 ; 即语句尾），
    // 整段三元（含 isAggregate 空串分支）作为表达式求值
    const m = panelJs.match(/const stateBadge = (isAggregate[\s\S]*?);/);
    assert.ok(m, "instance-row state badge expression found in panel.js");
    return (ctx) => new Function("isAggregate", "isAct", `return (${m[1]});`)(ctx.isAggregate, ctx.isAct);
  }

  it("在飞恒 badge-ok「生成中」、待命恒 badge-neutral「待命」、汇总行无状态徽标", () => {
    const badge = makeRenderStateBadge();
    const act = badge({ isAggregate: false, isAct: true });
    assert.match(act, /badge-ok/);
    assert.match(act, /生成中/);
    const idle = badge({ isAggregate: false, isAct: false });
    assert.match(idle, /badge-neutral/);
    assert.match(idle, /待命/);
    assert.equal(badge({ isAggregate: true, isAct: true }), "");
  });

  it("实例行渲染器不留链归因分支（badge-auto 只归端点胶囊）", () => {
    assert.doesNotMatch(makeRenderStateBadge()({ isAggregate: false, isAct: true }), /自动路由中|badge-auto/);
    const m = panelJs.match(/function renderInstanceRows\(\{[^}]*\}\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "renderInstanceRows found in panel.js");
    assert.ok(!/instViaAuto|自动路由中/.test(m[0]), "no chain-attribution branch left in the instance-row renderer");
  });
});

describe("panel.html 设置全页视图", () => {
  // 设置从弹窗升级为全页视图：页头齿轮切入，原页头整行换成设置专用头行
  // （← 退出 + 「设置」标题 + 亮暗钮），内容区顶部「通用」「自动路由」「主题」「关于」四个子 tab。
  // 设置视图不占 panel-view（那份留作「←退出」的目标），另由 panel-settings-open
  // 标记记录是否停在设置页：刷新与面板重启恢复都按这两个键回到原处。
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("设置视图 section 挂在 main 内且默认隐藏，含「通用」「自动路由」「主题」「关于」子 tab 与四块面板", () => {
    assert.ok(/<section class="settings-view" id="settingsView" hidden>/.test(panelHtml),
      "settingsView section 默认隐藏");
    const iView = panelHtml.indexOf('id="settingsView"');
    assert.ok(iView > panelHtml.indexOf('id="sessionsView"') && iView < panelHtml.indexOf("</main>"),
      "settingsView 位于 main 内（sessions 之后）");
    assert.ok(/<button class="view-tab active" id="settingsTabGeneral" role="tab" aria-selected="true"[^>]*>通用<\/button>/.test(panelHtml),
      "「通用」子 tab 默认选中");
    for (const [name, label] of [["Route", "自动路由"], ["Theme", "主题"], ["About", "关于"]]) {
      assert.ok(new RegExp(`<button class="view-tab" id="settingsTab${name}" role="tab" aria-selected="false"[^>]*>${label}</button>`).test(panelHtml), `${label}子 tab 默认未选`);
      assert.ok(panelHtml.includes(`id="settingsPanel${name}" hidden`), `${label}面板默认隐藏`);
    }
    assert.ok(panelHtml.includes('id="settingsPanelGeneral"'), "通用面板存在");
  });

  it("「通用」子 tab 保留原设置弹窗的全部控件", () => {
    const iGeneral = panelHtml.indexOf('id="settingsPanelGeneral"');
    const iRoute = panelHtml.indexOf('id="settingsPanelRoute"');
    assert.ok(iGeneral > 0 && iRoute > iGeneral, "通用面板在自动路由面板之前");
    const general = panelHtml.slice(iGeneral, iRoute);
    for (const id of ["followAgentToggle", "keepAliveToggle", "keepAliveEndpoints", "keepAliveRetriesInput", "injectEffortToggle", "sparkWindowInput"]) {
      assert.ok(general.includes(`id="${id}"`), `通用面板保留控件 #${id}`);
    }
  });

  it("「通用」子 tab 五项分三张卡：启动/抗截断带图标卡头，其余未归类平卡", () => {
    const general = panelHtml.slice(
      panelHtml.indexOf('id="settingsPanelGeneral"'),
      panelHtml.indexOf('id="settingsPanelRoute"'),
    );
    assert.strictEqual((general.match(/<div class="panel-card">/g) || []).length, 3,
      "通用面板恰三张 panel-card");
    assert.strictEqual((general.match(/<div class="card-header">/g) || []).length, 2,
      "仅两张卡有 card-header（杂项卡保持无头）");
    assert.ok(/<h2 class="card-title">[\s\S]*?<svg[\s\S]*?<\/svg>\s*启动\s*<\/h2>/.test(general),
      "「启动」卡带 stroke 图标卡头");
    assert.ok(/<h2 class="card-title">[\s\S]*?<svg[\s\S]*?<\/svg>\s*抗截断\s*<\/h2>/.test(general),
      "「抗截断」卡带 stroke 图标卡头");
    assert.ok(panelCss.includes("#settingsPanelGeneral .modal-item:hover { background: var(--surface-hover); }"),
      "设置行悬停整行淡底（--surface-hover）");
  });

  it("「自动路由」子 tab：面板在通用与主题之间，含瓦片墙容器与卡头徽标，Store 旧折叠卡已移除", () => {
    const iRoute = panelHtml.indexOf('id="settingsPanelRoute"');
    assert.ok(iRoute > panelHtml.indexOf('id="settingsPanelGeneral"'), "路由面板在通用面板之后");
    assert.ok(iRoute < panelHtml.indexOf('id="settingsPanelTheme"'), "路由面板在主题面板之前");
    const route = panelHtml.slice(iRoute, panelHtml.indexOf('id="settingsPanelTheme"'));
    assert.ok(route.includes('id="routeChainGrid"'), "瓦片墙容器存在");
    assert.ok(route.includes('id="routeChainBadge"'), "已配置计数徽标存在");
    assert.ok(route.includes("按链顺序路由，失败自动退避下一节点"), "功能说明文案保留");
    assert.strictEqual((route.match(/<div class="panel-card">/g) || []).length, 1,
      "路由面板一张 panel-card（仅瓦片墙）");
    assert.ok(!route.includes("ailureRate"), "路由子 tab 不含按失败率降级控件");
    assert.ok(!panelHtml.includes('id="routeChainCard"'), "Store 页旧折叠卡已移除");
    assert.ok(!panelHtml.includes("routeChainFoldBtn"), "折叠钮已移除");
  });

  it("瓦片墙样式：三列网格 + 卡内小块质感（内陷面、自身无投影），质感与配置状态解耦（未配置仅文字降色）", () => {
    assert.ok(panelCss.includes(".route-ep-grid { display: grid; grid-template-columns: repeat(3, 1fr);"),
      "三列瓦片网格");
    const tileRule = panelCss.match(/\.route-ep-tile \{([^}]*)\}/);
    assert.ok(tileRule, ".route-ep-tile 静止规则存在");
    assert.ok(/background: var\(--surface-sunken\);/.test(tileRule[1]),
      "瓦片底色取内陷面（与遥测四宫格、分段控件同一档）");
    assert.ok(!/box-shadow/.test(tileRule[1]), "瓦片自身无投影——抬升由外层 .panel-card 承担");
    assert.ok(!/linear-gradient/.test(tileRule[1]), "无常驻渐变面（悬停 token 不当常任用色）");
    const tileHover = panelCss.match(/\.route-ep-tile:hover \{([^}]*)\}/);
    assert.ok(tileHover && /background: var\(--surface-hover\)/.test(tileHover[1])
      && /border-color: var\(--border-strong\)/.test(tileHover[1]),
      "悬停＝整块平铺提亮 + 边框提到立边色（与设置页「通用」行、主题列表项同手感）");
    assert.ok(tileHover && !/var\(--accent\)/.test(tileHover[1]) && !/box-shadow/.test(tileHover[1]),
      "悬停不用品牌色描边、不跳投影档（品牌色描边只表示选中/启用）");
    // 材质只走 token，不留主题特化：皮肤段若给瓦片单画材质，就会出现「不随主题重画的表面」
    const skinSection = panelCss.slice(panelCss.indexOf("/* ===== style-lab: saas ===== */"));
    assert.ok(skinSection.includes("style-lab: sepia"), "皮肤段切片锚点有效");
    assert.ok(!/\.route-ep-/.test(skinSection), "主题片段不覆盖 route-ep 选择器");
    assert.ok(!panelCss.includes(".route-ep-tile--off"), "无停用降档投影（质感不绑状态）");
    assert.ok(!panelCss.includes(".route-ep-tile--empty {") && !panelCss.includes(".route-ep-tile--empty:"),
      "未配置瓦片不再覆盖底色/投影");
    assert.ok(/\.route-ep-tile--empty \.route-ep-name \{ color: var\(--text-3\); \}/.test(panelCss),
      "未配置仅名称降色");
    assert.ok(!panelCss.includes(".route-chain-grid"), "旧两列网格样式已删");
    assert.ok(!panelCss.includes(".route-fold-toggle"), "折叠钮样式已删");
    assert.ok(!panelCss.includes(".route-chain-card"), "旧小链卡样式已删");
  });

  it("抗截断开关同构 ccswitch skill 管理：品牌色淡底方钮 + 总开关关时收起图标", () => {
    // ── DOM：控件只剩图标组 + 总开关（计数徽标已移除）──
    const controls = panelHtml.slice(
      panelHtml.indexOf('class="keepalive-controls"'),
      panelHtml.indexOf('id="keepAliveToggle"'),
    );
    assert.ok(controls.includes('id="keepAliveEndpoints"'), "端点图标组存在");
    assert.ok(!panelHtml.includes("keepAliveCount") && !panelHtml.includes("keepalive-count"),
      "计数徽标已移除（DOM 与样式名都不再出现）");

    // ── CSS：只扫抗截断段（段内负向断言防空转）──
    const kaCss = panelCss.slice(
      panelCss.indexOf(".keepalive-controls"),
      panelCss.indexOf("/* 浮动 Toast"),
    );
    assert.ok(kaCss.length > 100, "取到抗截断 CSS 段");
    assert.ok(/\.keepalive-ep \{[\s\S]*?width: 28px; height: 28px/.test(kaCss), "端点按钮统一 28px 方钮");
    assert.ok(kaCss.includes(".keepalive-eps { display: flex; align-items: center; gap: 9px; }"),
      "端点图标间隔 9px");
    assert.ok(kaCss.includes(".keepalive-eps[hidden] { display: none; }"),
      "hidden 收起有显式兜底（否则被同元素的 display:flex 覆盖）");
    assert.ok(/\.keepalive-ep-icon \{[\s\S]*?width: 20px; height: 20px/.test(kaCss)
      && kaCss.includes(".keepalive-ep-icon .agent-avatar { flex: none; transform: scale(0.625); transform-origin: center; }"),
      "图标=克隆整头像等比缩 0.625（保留各家自带底衬）");
    assert.ok(!kaCss.includes(".keepalive-ep-icon > *"), "不再强制子元素撑满（会压糊/溢出内联尺寸头像）");
    // 启用态=品牌色淡底+同色相细描边（纯品牌色，不掺灰；色值同会话管理圆点）
    assert.ok(/\.keepalive-ep\[aria-pressed="true"\] \{[\s\S]*?background: color-mix\(in srgb, var\(--ep-color\) 16%, transparent\);[\s\S]*?border-color: color-mix\(in srgb, var\(--ep-color\) 45%, transparent\);/.test(kaCss),
      "启用态=品牌色 16% 淡底 + 45% 同色相描边");
    assert.ok(/\.keepalive-ep\[aria-pressed="true"\]:hover \{[\s\S]*?background: color-mix\(in srgb, var\(--ep-color\) 24%, transparent\);/.test(kaCss),
      "悬停加深淡底到 24%");
    assert.ok(!kaCss.includes("background: var(--ep-color);"),
      "不再有实心品牌色铺满（图标自带底衬会被框成镶边）");
    assert.ok(kaCss.includes('.keepalive-ep[aria-pressed="true"].keepalive-ep--ringed { border-color: var(--ep-ring); }'),
      "pi 白/zcode 黑由 --ep-ring 描边立边（同会话圆点）");
    assert.ok(kaCss.includes('.keepalive-ep[aria-pressed="false"] { opacity: 0.35; }')
      && kaCss.includes('.keepalive-ep[aria-pressed="false"]:hover { opacity: 0.7; }'),
      "停用态=35% 透明、悬停回 70%");
    for (const dead of ["grayscale", "brightness", "master-off", "ep-off", "keepalive-count"]) {
      assert.ok(!kaCss.includes(dead), `抗截断段不再使用 ${dead}`);
    }

    // ── JS：整头像克隆 + ringed 判据 + 总开关关时收起 ──
    assert.ok(panelJs.includes('setProperty("--ep-color"'), "按钮注入 --ep-color 品牌色指针");
    const build = panelJs.match(/function buildKeepAliveEndpoints\(\) \{([\s\S]*?)\n    \}/);
    assert.ok(build, "buildKeepAliveEndpoints found");
    assert.ok(build[1].includes('querySelector(`.panel-card[data-agent-id="${agentId}"] .agent-avatar`)')
      && build[1].includes("iconWrap.appendChild(avatar.cloneNode(true))"),
      "克隆看板整头像（含底衬/圆角），不再只取字形");
    assert.ok(!build[1].includes("firstElementChild"), "不再剥掉头像容器的内联底衬");
    assert.ok(build[1].includes("KEEP_ALIVE_EP_RINGED.has(agentId)")
      && build[1].includes("keepalive-ep--ringed"), "pi/zcode 加 ringed 类");
    assert.ok(panelJs.includes('const KEEP_ALIVE_EP_RINGED = new Set(["pi", "zcode"]);'),
      "ringed 判据与会话管理 SESS_EP_RINGED 同一集合");
    assert.ok(!panelJs.includes("applyKeepAliveCountUi") && !panelJs.includes("persistKeepAliveEndpointsAll"),
      "计数徽标的渲染与批量写入逻辑已整体移除");
    const applyUi = panelJs.match(/function applyKeepAliveUi\(mode\) \{([\s\S]*?)\n    \}/);
    assert.ok(applyUi, "applyKeepAliveUi found");
    assert.ok(applyUi[1].includes('keepAliveEndpointsWrap.hidden = m === "off"'),
      "总开关 off 时收起整排端点图标");
    assert.ok(panelJs.includes("已启用 ✓，点击停用"), "tooltip 带 ✓ 状态词");
    assert.ok(panelJs.includes("各端点偏好保留，重新开启后生效"), "关态文案说明偏好保留");
    assert.ok(!panelJs.includes("master-off") && !panelJs.includes("ep-off"),
      "JS 不再驱动 master-off / ep-off");
  });

  it("设置专用头行：左侧「←」图标钮（无文字）+「设置」标题，右侧亮暗钮与主头行同源", () => {
    assert.ok(/<div class="layout-container head-inner" id="mainHeadInner">/.test(panelHtml),
      "主头行有 mainHeadInner 锚点");
    assert.ok(/id="settingsHeadInner" hidden/.test(panelHtml), "设置头行默认隐藏");
    const head = panelHtml.slice(panelHtml.indexOf('id="settingsHeadInner"'), panelHtml.indexOf("</header>"));
    const exit = head.match(/<button class="icon-btn" id="settingsExitBtn"[^>]*>([\s\S]*?)<\/button>/);
    assert.ok(exit, "左侧退出钮沿用 icon-btn 图标钮形态");
    assert.ok(exit[0].includes('title="回到之前的视图"') && exit[0].includes('aria-label="回到之前的视图"'),
      "退出钮悬浮提示与无障碍标签保留");
    assert.ok(/^\s*<svg[\s\S]*<\/svg>\s*$/.test(exit[1]), "退出钮仅含箭头图标、无文字");
    assert.ok(/class="settings-head-title">设置</.test(head), "「设置」标题");
    assert.ok(head.includes('id="settingsThemeToggle"'), "右侧亮暗切换按钮");
    assert.ok(head.includes('id="settingsIcoMoon"') && head.includes('id="settingsIcoSun"'), "日/月图标齐备");
    const theme = panelJs.match(/function initTheme\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(theme, "initTheme found in panel.js");
    assert.ok(theme[1].includes("settingsThemeToggle") && theme[1].includes("settingsIcoSun"),
      "initTheme 把设置头行亮暗钮并入同一状态源");
  });

  it("设置头行日/月图标 path 与主头行 #themeToggle 逐字一致", () => {
    // 两颗亮暗钮同图不同 id：图标 path 若各自手抄极易 drift（缺一段弧线肉眼难辨），
    // 与原「设置弹窗齿轮 path 与页头齿轮逐字一致」测试同一锁法。
    function svgInner(id) {
      const m = panelHtml.match(new RegExp(`<svg id="${id}"[^>]*>([\\s\\S]*?)</svg>`));
      assert.ok(m, id + " svg found");
      return m[1];
    }
    assert.equal(svgInner("settingsIcoMoon"), svgInner("icoMoon"), "月亮图标 path 逐字一致");
    assert.equal(svgInner("settingsIcoSun"), svgInner("icoSun"), "太阳图标 path 逐字一致");
  });

  it("「主题」子 tab：左栏三项点选即生效，右栏预览为真实看板镜像", () => {
    const picker = panelHtml.match(/<div class="settings-theme-list" id="stylePicker"[^>]*>([\s\S]*?)<\/div>/);
    assert.ok(picker, "主题列表沿用 stylePicker 锚点");
    const items = [...picker[1].matchAll(/class="settings-theme-item" data-style="([^"]*)" role="radio" aria-checked="([^"]*)"[^>]*>([^<]+)<\/button>/g)];
    assert.deepEqual(items.map((m) => [m[1], m[3], m[2]]), [
      ["saas", "SaaS", "true"], ["aurora", "极光", "false"], ["sepia", "暖纸", "false"],
    ], "三项主题与样式值一一对应，SaaS 按钮静态 aria-checked=\"true\"");
    assert.ok(panelJs.includes('picker.querySelectorAll(".settings-theme-item")'),
      "initStylePicker 同步选中态到新列表项");
    assert.ok(/id="settingsThemePreview" inert/.test(panelHtml), "预览整体不响应交互");
    const preview = panelHtml.slice(
      panelHtml.indexOf('id="settingsThemePreview"'),
      panelHtml.indexOf('id="settingsPanelAbout"'),
    );
    // 镜像三层结构：viewport 定高内滚 → sizer 撑缩放后尺寸 → scale 等比微缩；
    // 容器内不再有独立样张 markup，内容由 captureSettingsMirror 克隆看板填充
    for (const id of ["settingsMirrorViewport", "settingsMirrorSizer", "settingsMirrorScale"]) {
      assert.ok(preview.includes(`id="${id}"`), `预览含镜像层 #${id}`);
    }
    assert.ok(!preview.includes("panel-card"), "预览不再内置独立样张");
    const capture = panelJs.match(/function captureSettingsMirror\(\) \{([\s\S]*?)\n    \}/);
    assert.ok(capture, "captureSettingsMirror found in panel.js");
    assert.ok(capture[1].includes('document.querySelector(".telemetry-view")'), "镜像源为真实看板视图");
    assert.ok(capture[1].includes("cloneNode(true)"), "镜像为看板 DOM 克隆");
    assert.ok(capture[1].includes('removeAttribute("id")'), "克隆剥 id 防重复命中");
    assert.ok(capture[1].includes('boardClone.removeAttribute("hidden")'), "克隆根去 hidden 抵消看板被切走");
    assert.ok(capture[1].includes("scale("), "镜像按预览栏宽缩放");
    const subTab = panelJs.match(/function activateSettingsSubTab\(which, animate\) \{([\s\S]*?)\n    \}/);
    assert.ok(subTab, "activateSettingsSubTab found in panel.js");
    assert.ok(subTab[1].includes("captureSettingsMirror()"), "进主题子页即抓看板快照");
  });

  it("主题存档恢复：内联脚本三项在册、非法存档回落覆写，且无 removeAttribute(data-style) 分支", () => {
    assert.ok(panelHtml.includes('var PANEL_STYLES = ["saas", "aurora", "sepia"];'),
      "PANEL_STYLES 恰为 saas/aurora/sepia 三项");
    assert.ok(panelHtml.includes('? panelStyleRaw : "saas"'),
      "缺失或非法存档一律回落 \"saas\"");
    assert.ok(panelHtml.includes("if (panelStyleRaw !== panelStyle)"),
      "解析结果与原始存档不一致时进入覆写分支");
    assert.ok(panelHtml.includes('localStorage.setItem("panel-style", panelStyle)'),
      "覆写 localStorage 存档，避免残留已删样式");
    assert.ok(panelHtml.includes('document.documentElement.setAttribute("data-style", panelStyle)'),
      "绘制前无条件写入 data-style");
    assert.ok(!panelHtml.includes('removeAttribute("data-style")'),
      "panel.html 无 removeAttribute(\"data-style\") 分支");
    assert.ok(!panelJs.includes('removeAttribute("data-style")'),
      "panel.js 无 removeAttribute(\"data-style\") 分支");
    assert.ok(panelJs.includes('const STYLES = ["saas", "aurora", "sepia"];'),
      "panel.js 的 STYLES 数组恰为三项");
  });

  it("齿轮改为切入设置视图，退出回到进入前视图；设置页另用 panel-settings-open 持久化", () => {
    assert.ok(/\$\("settingsBtn"\)[\s\S]{0,300}?switchView\("settings"\)/.test(panelJs),
      "页头齿轮切入设置视图");
    assert.ok(panelJs.includes("switchView(settingsReturnView)"), "退出回到进入前视图");
    const sw = panelJs.match(/function switchView\(name\) \{([\s\S]*?)\n  \}/);
    assert.ok(sw, "switchView found in panel.js");
    assert.ok(sw[1].includes('$("settingsView").hidden = !settings;'), "switchView 切换设置视图显隐");
    assert.ok(sw[1].includes('$("mainHeadInner").hidden = settings;')
      && sw[1].includes('$("settingsHeadInner").hidden = !settings;'),
      "主头行与设置头行互斥切换");
    assert.ok(/if \(!settings\) try \{ localStorage\.setItem\("panel-view", name\)/.test(sw[1]),
      "panel-view 只存主视图，设置视图不覆盖它");
    assert.ok(sw[1].includes('localStorage.setItem("panel-settings-open", settings ? "1" : "0")'),
      "进设置页打标记、离开即清");
    const restoreStart = panelJs.indexOf("function restoreView()");
    const restore = panelJs.slice(restoreStart, panelJs.indexOf("function reconcileSkillsSelection()", restoreStart));
    assert.ok(restore.length > 100, "未真正取到 restoreView 函数体");
    assert.ok(restore.includes('localStorage.getItem("panel-settings-open")'), "刷新按标记判定是否恢复进设置页");
    assert.ok(restore.includes('switchView("settings")'), "restoreView 恢复设置页");
    assert.ok(restore.includes("settingsReturnView = currentView"), "恢复后「←退出」目标取自主视图存档");
    assert.ok(restore.includes('restartEnterView = "settings"'), "重启恢复的入场动画落到设置视图");
  });

  it("刷新恢复设置页：子 tab 回到离开前那一个，主题镜像等看板首刷补拍", () => {
    const subTab = panelJs.match(/function activateSettingsSubTab\(which, animate\) \{([\s\S]*?)\n    \}/);
    assert.ok(subTab, "activateSettingsSubTab found in panel.js");
    assert.ok(subTab[1].includes('localStorage.setItem("panel-settings-subtab", which)'),
      "子 tab 激活即存档（存档＝此刻真实显示的那一个）");
    const enter = panelJs.match(/\n    enterSettingsView = \(\) => \{([\s\S]*?)\n    \};/);
    assert.ok(enter, "enterSettingsView found in panel.js");
    assert.ok(enter[1].includes("settingsSubTabToRestore"), "恢复路径按存档激活子 tab");
    assert.ok(enter[1].includes("settingsSubTabToRestore = null"), "存档只消费一次，不留到下一次进入");
    assert.ok(enter[1].includes("resetSettingsSubTab()"), "主动点齿轮进入仍落「通用」");
    // 恢复直接进「主题」时快照拍在首刷数据落地之前（空壳看板），等 agents 渲染完补拍一次
    assert.ok(panelJs.includes("let notifyBoardRendered = () => {};"), "补拍钩子有无操作默认值");
    const hook = panelJs.match(/\n    notifyBoardRendered = \(\) => \{([\s\S]*?)\n    \};/);
    assert.ok(hook && hook[1].includes("mirrorAwaitRender = false"), "补拍一次性：触发即摘标记");
    assert.ok(hook && hook[1].includes("captureSettingsMirror()"), "补拍实现复用同一套快照逻辑");
    const agents = panelJs.match(/async function refreshAgents\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(agents && agents[1].includes("notifyBoardRendered();"), "看板渲染完成即通知");
    const init = panelJs.match(/async function init\(\) \{[\s\S]*?\n  \}/);
    assert.ok(init && init[0].includes('view === "settings" ? $("settingsView")'),
      "开屏淡出后的入场动画覆盖设置视图");
  });

  it("恢复决策实测：设置页标记决定落点，返回目标取主视图，launcher 首开清标记", () => {
    // 只断字符串证明不了行为：把 restoreView 抽出来在桩环境里真跑一遍，
    // switchView 换成记录调用与 currentView 的桩，localStorage 换成内存对象。
    const body = (panelJs.match(/function restoreView\(\) \{([\s\S]*?)\n  \}/) || [])[1];
    assert.ok(body, "restoreView found in panel.js");
    const run = (store, win) => {
      const calls = [];
      return new Function("store", "win", "calls", `
        let suppressViewEnter = false, settingsReturnView = "board", settingsSubTabToRestore = null,
            restartEnterView = null, currentView = "board";
        const window = win;
        const localStorage = {
          getItem: (k) => (k in store ? store[k] : null),
          setItem: (k, v) => { store[k] = v; },
        };
        function switchView(name) { currentView = name; calls.push(name); }
        function restoreView() {
        ${body}
        }
        restoreView();
        return { calls, currentView, settingsReturnView, settingsSubTabToRestore, restartEnterView, store };
      `)(store, win, calls);
    };

    // 停在设置页（进设置前在渠道页）：恢复进设置，退出目标是渠道页，子 tab 存档交棒
    const onSettings = run({ "panel-view": "store", "panel-settings-open": "1", "panel-settings-subtab": "theme" }, {});
    assert.deepEqual(onSettings.calls, ["store", "settings"], "先恢复主视图再落设置页");
    assert.strictEqual(onSettings.settingsReturnView, "store", "「←退出」回到进入设置前的渠道页");
    assert.strictEqual(onSettings.settingsSubTabToRestore, "theme", "子 tab 存档交给 enterSettingsView");
    assert.strictEqual(onSettings.restartEnterView, null, "普通刷新不记重启入场动画");

    // 面板服务重启后自动刷新回来：同样落设置页，且入场动画改由开屏淡出起播
    const afterRestart = run({ "panel-view": "board", "panel-settings-open": "1" }, { panelStartupRestart: true });
    assert.deepEqual(afterRestart.calls, ["settings"], "看板进的设置页恢复后仍在设置页");
    assert.strictEqual(afterRestart.settingsReturnView, "board", "返回目标仍是看板");
    assert.strictEqual(afterRestart.restartEnterView, "settings", "入场动画记到设置视图");

    // launcher 首开：固定落看板，且把上次会话留下的标记就地清掉
    const launched = run({ "panel-view": "store", "panel-settings-open": "1" }, { panelStartupLaunch: true });
    assert.deepEqual(launched.calls, [], "首开不恢复，停在看板");
    assert.strictEqual(launched.store["panel-settings-open"], "0", "首开即清标记，之后的刷新才按真实视图走");

    // 没停在设置页：标记为 0 时不得凭空进设置
    const mainOnly = run({ "panel-view": "stats", "panel-settings-open": "0" }, {});
    assert.deepEqual(mainOnly.calls, ["stats"], "只恢复主视图");
  });

  // ── 首帧视图落位：整页加载不再先画出看板 ──────────────────────────────
  // 主脚本是 defer 外链，restoreView 落位必然晚于首绘，而 HTML 的静态默认是看板。
  // panel.html 的 panelViewPrepaint 于绘制前把目标屏写在 <html> 上，panel.css 的
  // 「首帧视图落位」段负责那一帧显隐。三条红线在此钉死：
  // ① 首帧目标与 restoreView 落定目标逐一相等——两边不一致本身就是新的闪烁；
  // ② CSS 的显示取值等于各容器自身的 display——凭印象写就会首帧布局走形；
  // ③ switchView 摘属性的时机在 hidden 赋值之后、进入钩子之前。
  const PREPAINT_SUB_TABS = ["general", "route", "theme", "about"];
  const prepaintSrc = (panelHtml.match(/<script id="panelViewPrepaint">([\s\S]*?)<\/script>/) || [])[1];
  const prepaintRestoreBody =
    (panelJs.match(/function restoreView\(\) \{([\s\S]*?)\n  \}/) || [])[1];

  function prepaintAttrs(store, win = {}, broken = false) {
    const attrs = {};
    const document = {
      documentElement: {
        setAttribute: (k, v) => { attrs[k] = v; },
        removeAttribute: (k) => { delete attrs[k]; },
      },
    };
    const localStorage = {
      getItem: (k) => { if (broken) throw new Error("denied"); return k in store ? store[k] : null; },
      setItem: () => {},
    };
    // 原样跑那段内联脚本（含 IIFE），比复述它的逻辑更接近真页面上的行为
    new Function("window", "document", "localStorage", prepaintSrc)(win, document, localStorage);
    return attrs;
  }

  function restoreOutcome(store, win = {}, broken = false) {
    const calls = [];
    return new Function("store", "win", "calls", "broken", `
      let suppressViewEnter = false, settingsReturnView = "board", settingsSubTabToRestore = null,
          restartEnterView = null, currentView = "board";
      const window = win;
      const localStorage = {
        getItem: (k) => { if (broken) throw new Error("denied"); return k in store ? store[k] : null; },
        setItem: (k, v) => { store[k] = v; },
      };
      function switchView(name) { currentView = name; calls.push(name); }
      function restoreView() {
      ${prepaintRestoreBody}
      }
      restoreView();
      return { calls, currentView, settingsSubTabToRestore };
    `)(store, win, calls, broken);
  }

  const PREPAINT_CASES = [
    { name: "停在设置页·主题（进设置前在渠道页）", view: "settings", subTab: "theme",
      store: { "panel-view": "store", "panel-settings-open": "1", "panel-settings-subtab": "theme" } },
    { name: "停在设置页·关于（进设置前在看板）", view: "settings", subTab: "about",
      store: { "panel-view": "board", "panel-settings-open": "1", "panel-settings-subtab": "about" } },
    { name: "停在设置页但子 tab 存档不在册 → 与 enterSettingsView 同样回落「通用」", view: "settings", subTab: "general",
      store: { "panel-view": "store", "panel-settings-open": "1", "panel-settings-subtab": "nope" } },
    { name: "停在渠道页", view: "store", subTab: null,
      store: { "panel-view": "store", "panel-settings-open": "0" } },
    { name: "停在统计页", view: "stats", subTab: null,
      store: { "panel-view": "stats", "panel-settings-open": "0" } },
    { name: "停在会话页", view: "sessions", subTab: null,
      store: { "panel-view": "sessions", "panel-settings-open": "0" } },
    { name: "没有任何存档 → 看板就是 HTML 默认，不写属性", view: "board", subTab: null, store: {} },
    { name: "panel-view 值不在册 → 同上", view: "board", subTab: null,
      store: { "panel-view": "nope", "panel-settings-open": "0" } },
    { name: "launcher 首开固定落看板（标记属上一次会话）", view: "board", subTab: null,
      store: { "panel-view": "store", "panel-settings-open": "1", "panel-settings-subtab": "theme" },
      win: { panelStartupLaunch: true } },
    { name: "面板服务重启后的自动刷新 → 开屏层后面也是目标屏", view: "settings", subTab: "route",
      store: { "panel-view": "board", "panel-settings-open": "1", "panel-settings-subtab": "route" },
      win: { panelStartupRestart: true } },
    { name: "localStorage 不可用 → 两边同样落看板默认", view: "board", subTab: null, store: {}, broken: true },
  ];

  it("首帧落位与 restoreView 落定目标逐一相等（含首开、重启、非法存档、存储不可用）", () => {
    assert.ok(prepaintSrc, "panel.html 有 <script id=\"panelViewPrepaint\">");
    assert.ok(prepaintRestoreBody, "restoreView found in panel.js");
    for (const c of PREPAINT_CASES) {
      const attrs = prepaintAttrs({ ...c.store }, c.win, c.broken);
      const out = restoreOutcome({ ...c.store }, c.win, c.broken);
      assert.strictEqual(out.currentView, c.view, `${c.name}：restoreView 落点与预期不符`);
      assert.strictEqual(attrs["data-prepaint-view"] ?? "board", out.currentView,
        `${c.name}：首帧那一屏与落定那一屏不一致`);
      // 首帧没有子 tab 属性时，HTML 默认露出的就是「通用」——与 enterSettingsView
      // 拿不到有效存档时的回落同一格。
      const jsSub = out.currentView === "settings"
        ? (PREPAINT_SUB_TABS.includes(out.settingsSubTabToRestore) ? out.settingsSubTabToRestore : "general")
        : null;
      const paintSub = attrs["data-prepaint-subtab"]
        ?? (out.currentView === "settings" ? "general" : null);
      assert.strictEqual(paintSub, jsSub, `${c.name}：首帧子 tab 与落定子 tab 不一致`);
      assert.strictEqual(jsSub, c.subTab, `${c.name}：子 tab 落点与预期不符`);
    }
  });

  it("首帧脚本只读判定：不改任何存档，且带 id 而非裸 <script>", () => {
    let written = [];
    const before = { "panel-view": "store", "panel-settings-open": "1", "panel-settings-subtab": "theme" };
    const store = { ...before };
    const document = { documentElement: { setAttribute: () => {}, removeAttribute: () => {} } };
    new Function("window", "document", "localStorage", prepaintSrc)(
      {}, document,
      { getItem: (k) => (k in store ? store[k] : null), setItem: (k) => { written.push(k); } },
    );
    assert.deepEqual(written, [], "首帧脚本不写存档（存档归 switchView / restoreView）");
    assert.deepEqual(store, before, "存档原样未动");
    assert.ok(/<script id="panelViewPrepaint">/.test(panelHtml),
      "带 id 引入，不与既有「裸 <script> 语法自检」用例的取样范围相撞");
  });

  it("首帧视图 CSS：显示取值等于容器自身 display，且六视图全在册", () => {
    const iMark = panelCss.indexOf("首帧视图落位（绘制前）");
    assert.ok(iMark > 0, "panel.css 有「首帧视图落位」段");
    const base = panelCss.slice(0, iMark);
    // 注释里带着 [hidden]{display:none !important} 这样的字面量，取样先剥注释
    const block = panelCss.slice(iMark).replace(/\/\*[\s\S]*?\*\//g, "");

    // 视图名与子 tab 名：内联脚本与 CSS 必须是同一套，漏一格就是一格仍然闪
    const listOf = (src, key) => (src.match(new RegExp(`const ${key} = \\[([^\\]]*)\\]`)) || [, ""])[1]
      .split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    const scriptViews = listOf(prepaintSrc, "VIEW_NAMES");
    const scriptSubTabs = listOf(prepaintSrc, "SUB_TAB_NAMES");
    const cssViews = new Set([...block.matchAll(/data-prepaint-view="([a-z]+)"/g)].map((m) => m[1]));
    const cssSubTabs = new Set([...block.matchAll(/data-prepaint-subtab="([a-z]+)"/g)].map((m) => m[1]));
    for (const v of scriptViews) assert.ok(cssViews.has(v), `CSS 缺视图 ${v} 的首帧规则`);
    for (const v of cssViews) assert.ok(scriptViews.includes(v), `CSS 视图 ${v} 不在脚本白名单内`);
    for (const s of scriptSubTabs) assert.ok(cssSubTabs.has(s), `CSS 缺子 tab ${s} 的首帧规则`);
    assert.deepEqual(scriptSubTabs, PREPAINT_SUB_TABS, "脚本子 tab 清单与 panel.js 的四个子 tab 同");

    // 容器自身的 display（class 规则 + id 规则，都没有即 block）
    const ownDisplay = (id) => {
      const tag = (panelHtml.match(new RegExp(`<(?:section|div)[^>]*id="${id}"[^>]*>`)) || [])[0];
      assert.ok(tag, `${id} 在 panel.html 里有开标签`);
      const classes = ((tag.match(/class="([^"]+)"/) || [, ""])[1]).split(/\s+/).filter(Boolean);
      const found = new Set();
      const grab = (re) => {
        for (const m of base.matchAll(re)) {
          const d = m[1].match(/display:\s*([a-z-]+)/);
          if (d) found.add(d[1]);
        }
      };
      for (const cls of classes) grab(new RegExp(`\\.${cls}(?![\\w-])(?:\\[[^\\]]*\\])*\\s*\\{([^}]*)\\}`, "g"));
      grab(new RegExp(`#${id}\\s*\\{([^}]*)\\}`, "g"));
      assert.ok(found.size <= 1, `${id} 自身有多条互相冲突的 display，需人工判定首帧取值`);
      return found.size ? [...found][0] : "block";
    };
    const reveals = [];
    for (const chunk of block.split("}")) {
      const iBrace = chunk.indexOf("{");
      if (iBrace < 0) continue;
      const decl = chunk.slice(iBrace + 1).trim();
      const display = (decl.match(/display:\s*([a-z-]+)/) || [])[1];
      if (!display || display === "none") continue; // 收起侧另有专门断言
      for (const sel of chunk.slice(0, iBrace).split(",")) {
        // 选择器可以以 #id[hidden] 收尾，取 selector 里最后一个 ID
        const ids = sel.match(/#[A-Za-z]+(?![\w-])/g) || [];
        const id = ids.length ? ids[ids.length - 1].slice(1) : null;
        if (!id || !sel.includes("data-prepaint")) continue;
        reveals.push({ id, display, hidden: sel.includes("[hidden]"), important: decl.includes("!important") });
      }
    }
    assert.ok(reveals.length >= 11,
      `取得显示侧规则 ${reveals.length} 条，少于六视图+设置头行+四块子面板`);
    for (const r of reveals) {
      assert.strictEqual(r.display, ownDisplay(r.id), `${r.id} 首帧 display=${r.display}，容器自身是 ${ownDisplay(r.id)}`);
      if (r.hidden) {
        assert.ok(base.includes("[hidden] { display: none !important; }"), "全局 hidden 兜底仍是 !important");
        assert.ok(r.important, `${r.id} 带 hidden，显示侧必须 !important 才压得住全局兜底`);
      }
    }
    // 收起侧两条：看板与主头行（不显示的那一侧不存在布局冲突，无需取值比对）
    assert.ok(/html\[data-prepaint-view\] \.telemetry-view \{ display: none; \}/.test(block),
      "首帧收起看板");
    assert.ok(/html\[data-prepaint-view="settings"\] #mainHeadInner \{ display: none; \}/.test(block),
      "首帧收起主头行（仅设置页）");
    const isList = (block.match(/:is\(([^)]*)\)/) || [, ""])[1]
      .split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean);
    assert.deepEqual(isList, ["settingsPanelGeneral", "settingsPanelRoute", "settingsPanelTheme", "settingsPanelAbout"],
      "子 tab 整体收起规则覆盖四块面板");
  });

  it("首帧不描子 tab 选中态：只把静态选中项减回基座外观，取值与三个主题都不冲突", () => {
    const undo = panelCss.match(/html\[data-prepaint-subtab\]:not\([^\)]*\) #([A-Za-z]+) \{([^}]*)\}/);
    assert.ok(undo, "有一条减子 tab 选中态的规则");
    // 主头行 tab 条里的「看板」同样是静态选中项，取样限定在设置子 tab 那格 nav 内
    const navStart = panelHtml.indexOf("settings-subtabs");
    const subTabNav = panelHtml.slice(navStart, panelHtml.indexOf("</nav>", navStart));
    assert.ok(navStart > 0 && subTabNav.includes("settingsTabAbout"), "取到设置子 tab 的 nav");
    const activeInMarkup = (subTabNav.match(/<button class="view-tab active" id="([A-Za-z]+)"/) || [])[1];
    assert.strictEqual(undo[1], activeInMarkup, "减的就是 HTML 静态选中的那一个子 tab");
    const baseDecls = (panelCss.match(/^ {2}\.view-tab \{([^}]*)\}/m) || [, ""])[1];
    const activeDecls = (panelCss.match(/^ {2}\.view-tab\.active \{([^}]*)\}/m) || [, ""])[1];
    const props = (s) => new Set(s.split(";").map((d) => (d.split(":")[0] || "").trim()).filter(Boolean));
    assert.deepEqual(props(undo[2]), props(activeDecls),
      "减法必须覆盖 .view-tab.active 添加的每一个属性，漏一个就留下半截高亮");
    for (const d of undo[2].split(";").map((s) => s.trim()).filter(Boolean)) {
      const [prop, value] = d.split(":").map((s) => s.trim());
      if (prop === "box-shadow") {
        // 基座的 transition 里也写着 box-shadow，只认「属性声明」那一处
        assert.ok(!/(?:^|[;{\s])box-shadow\s*:/.test(baseDecls), "基座未声明 box-shadow 属性，减为 none 即未选中态");
        continue;
      }
      assert.ok(baseDecls.includes(`${prop}: ${value}`), `${d} 与 .view-tab 基座同值，才等于未选中外观`);
    }
    // 主题只往 .view-tab.active 上加 box-shadow、只给未选中态改圆角：减法不碰这两处
    // 之外的属性，就不会在任何主题下把未选中态减成第四个样子。
    for (const m of panelCss.matchAll(/:root\[data-style="([a-z]+)"\] \.view-tab\.active \{([^}]*)\}/g)) {
      assert.deepEqual([...props(m[2])], ["box-shadow"], `${m[1]} 主题的选中态只应动 box-shadow`);
    }
    for (const m of panelCss.matchAll(/:root\[data-style="([a-z]+)"\] \.view-tab \{([^}]*)\}/g)) {
      assert.deepEqual([...props(m[2])], ["border-radius"], `${m[1]} 主题的未选中态只应动 border-radius`);
    }
    assert.ok(!/data-prepaint-subtab[^\n]*\{[^}]*box-shadow:\s*var/.test(panelCss),
      "首帧层不自己造选中态描色");
  });

  it("switchView 摘首帧属性的时机：hidden 赋值之后、进入钩子之前", () => {
    const sw = panelJs.match(/function switchView\(name\) \{([\s\S]*?)\n  \}/);
    assert.ok(sw, "switchView found in panel.js");
    const body = sw[1];
    const at = (needle) => {
      const i = body.indexOf(needle);
      assert.ok(i >= 0, `switchView 里找到「${needle}」`);
      return i;
    };
    const iHidden = at('$("settingsView").hidden = !settings;');
    const iHead = at('$("settingsHeadInner").hidden = !settings;');
    const iRemoveView = at('document.documentElement.removeAttribute("data-prepaint-view")');
    const iRemoveSub = at('document.documentElement.removeAttribute("data-prepaint-subtab")');
    const iEnter = at("if (settings) viewReady = enterSettingsView()");
    assert.ok(iRemoveView > iHidden && iRemoveView > iHead,
      "摘属性前 hidden 已落定，两套显隐来源不会同框");
    assert.ok(iRemoveSub > iHidden && iRemoveSub < iEnter,
      "摘属性早于进入钩子：镜像快照按真实 DOM 拍，不被首帧收起规则连累");
    assert.ok(!body.includes('data-prepaint') || iRemoveView < iEnter,
      "switchView 不残留首帧属性");
  });

  it("原设置弹窗整体移除（DOM、开关逻辑、init 装配更名）", () => {
    // 负向断言覆盖三个文件：DOM 残留、脚本残留、CSS 残留都会让弹窗以任一形式复活
    for (const src of [panelHtml, panelJs, panelCss]) {
      assert.ok(!src.includes('id="settingsModal"'), "settingsModal DOM 已删除");
      assert.ok(!src.includes("settingsCloseBtn") && !src.includes("settingsDoneBtn"),
        "弹窗关闭/完成按钮已删除");
      assert.ok(!src.includes("initSettingsModal"), "initSettingsModal 已更名移除");
    }
    const init = panelJs.match(/async function init\(\) \{[\s\S]*?\n  \}/);
    assert.ok(init && init[0].includes("initSettingsView();"), "init 装配 initSettingsView");
  });
});
describe("panel.html 结构完整性（超长行原样保留）", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("文件不含截断占位标记（img/path 数据不得被替换为占位文本）", () => {
    assert.ok(!panelHtml.includes("(line truncated to 2000 chars)"),
      "超长 base64 行一旦被占位文本替换，头像 img src 会损坏、监测卡标题会错乱");
  });

  it("监测页九个端点卡的头像区结构配对完整（avatar/headings 成对、无跨标签吞并）", () => {
    assert.equal((panelHtml.match(/class="agent-avatar"/g) || []).length, 9, "9 个 agent-avatar");
    assert.equal((panelHtml.match(/class="agent-headings"/g) || []).length, 9, "9 个 agent-headings");
    // img 开标签必须在本行内闭合（不允许 > 落在数千字符之后吞掉后续结构）
    let idx2 = 0;
    let broken = 0;
    while (true) {
      const j = panelHtml.indexOf("<img ", idx2);
      if (j < 0) break;
      const close = panelHtml.indexOf(">", j);
      const lineEnd = panelHtml.indexOf("\n", j);
      if (close < 0 || (lineEnd >= 0 && close > lineEnd)) broken++;
      idx2 = j + 5;
    }
    assert.equal(broken, 0, "每个 <img> 标签必须在行内闭合");
  });
});

describe("panel.html 实例四宫格陈旧语义（lastSeen 超阈值速率类置 —）", () => {
  // 背景：速率类指标（tok/s、TTFT、缓存命中率、sparkline）是 last-N 计数窗口而非
  // 时间窗，PID 形态实例靠进程扫描续命绕过 10min TTL，聚合桶更是无 TTL——数小时前
  // 的数值会原样上屏冒充实时数据。渲染层按 lastSeen 判定陈旧并隐藏速率类数值。
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );
  const panelCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.css"),
    "utf8",
  );

  it("陈旧判定 helper：lastSeen 超 INSTANCE_STALE_MS（2min）为陈旧，active 豁免", () => {
    assert.ok(/const INSTANCE_STALE_MS = 2 \* 60 \* 1000;/.test(panelJs),
      "stale threshold pinned at 2 minutes");
    const m = panelJs.match(/function isInstanceStale\(inst\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "isInstanceStale helper exists");
    assert.ok(m[1].includes('inst.status === "active"'), "active instances never stale");
    assert.ok(m[1].includes("inst.lastSeen"), "reads inst.lastSeen");
    assert.ok(m[1].includes("INSTANCE_STALE_MS"), "compares against INSTANCE_STALE_MS");
  });

  it("聚合伪实例行透出 sessions[0].lastSeen 参与同一陈旧判定", () => {
    const m = panelJs.match(/function buildAggregateFallback\(m, d, isGenerating\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "buildAggregateFallback exists");
    assert.ok(/lastSeen: typeof sess\.lastSeen === "number" \? sess\.lastSeen : null,/.test(m[1]),
      "aggregate fallback carries lastSeen (aggregate bucket is TTL-less residue)");
  });

  it("陈旧行四宫格：速率类三格压暗置 —，工时卡不动，无额外注释行", () => {
    assert.ok(/const stale = isInstanceStale\(inst\);/.test(panelJs), "renderInstanceRows computes stale");
    assert.ok(/const staleCls = stale \? " inst-stale" : "";/.test(panelJs), "stale class prepared");
    assert.ok(/<div class="telemetry-card\$\{staleCls\}">\s*<div class="telemetry-header">\s*<span class="telemetry-label">生成速度<\/span>/.test(panelJs),
      "tps card dimmed when stale");
    assert.ok(/<span>\$\{!stale && tps > 0 \? tps\.toFixed\(1\) : "-"\}<\/span>/.test(panelJs),
      "stale tps renders as dash");
    assert.ok(/<span>\$\{!stale && ttft > 0 \? \(ttft \/ 1000\)\.toFixed\(2\) : "-"\}<\/span>/.test(panelJs),
      "stale ttft renders as dash");
    assert.ok(/<span>\$\{!stale && typeof hit === "number" \? hit\.toFixed\(1\) : "-"\}<\/span>/.test(panelJs),
      "stale cache hit rate renders as dash");
    assert.ok(!panelJs.includes("instance-stale-note") && !panelCss.includes("instance-stale-note"), "grid tail annotation removed");
  });

  it("陈旧行简要胶囊行：速率类胶囊换成相对时间胶囊（「X 分钟前」），工时胶囊保留", () => {
    assert.ok(/<span class="tag-bubble tag-stale">\$\{formatRelativeAge\(inst\.lastSeen\)\}<\/span>/.test(panelJs),
      "tags line swaps rate bubbles for a bare relative-age bubble");
  });

  it("陈旧行折线停绘：渲染期 if (open && !stale) 门控 + 展开补绘跳过 data-stale 行", () => {
    assert.ok(/if \(open && !stale\) \{[\s\S]*?updateSparkline\(sparkTpsId/.test(panelJs),
      "render-time sparkline draw gated on !stale");
    assert.ok(/grid\.dataset\.stale = stale \? "1" : "0";/.test(panelJs), "grid carries data-stale flag");
    assert.ok(/if \(grid\.dataset\.stale === "1"\) return;/.test(panelJs),
      "redrawInstanceSparklines skips stale grids");
  });

  it("相对时间标注随时间刷新：renderIfChanged 指纹混入陈旧分钟桶", () => {
    assert.ok(/function agentStaleTick\(agent\) \{/.test(panelJs), "agentStaleTick exists");
    assert.ok(/agentStaleTick\(agent\) \+ "\|" \+ JSON\.stringify\(agent\)/.test(panelJs),
      "fingerprint mixes the stale minute tick so 「X 前」 refreshes at most once a minute");
  });

  it("陈旧态样式齐备：整卡压暗 + 虚线陈旧胶囊（无格尾注释样式）", () => {
    assert.ok(/\.telemetry-card\.inst-stale \{ opacity: 0\.45; \}/.test(panelCss), "stale card dimmed");
    assert.ok(!/\.instance-stale-note/.test(panelCss), "note style removed with the note element");
    assert.ok(/\.tag-bubble\.tag-stale \{/.test(panelCss), "stale bubble style exists");
  });
});

describe("panel.html 静态卡（zc/qoder）端点级陈旧语义", () => {
  // 与实例行同口径：全局汇总行 lastSeen 超 INSTANCE_STALE_MS 即陈旧——速率类置 —
  // 压暗、折线停绘、简要栏换相对时间胶囊；累计量（工时/tokens/请求数）不动。
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("端点级判定 helper：isEndpointStale 读 sessions[0].lastSeen，生成中豁免", () => {
    const m = panelJs.match(/function isEndpointStale\(agent, isGenerating\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "isEndpointStale exists in panel.js");
    assert.ok(m[1].includes("if (isGenerating) return false;"), "generating endpoints never stale");
    assert.ok(m[1].includes("s0.lastSeen"), "reads 全局汇总行 lastSeen");
    assert.ok(m[1].includes("INSTANCE_STALE_MS"), "same threshold as instance rows");
  });

  it("三个静态渲染函数同口径接线：判定 + 置位 flag + 压暗 + staleText + 停绘", () => {
    for (const [fnName, prefix, arg] of [["renderZcode", "zc", "z"], ["renderQoder", "qoder", "p"]]) {
      const m = panelJs.match(new RegExp("function " + fnName + "\\(" + arg + "\\) \\{[\\s\\S]*?\\n  \\}"));
      assert.ok(m, fnName + " found in panel.js");
      assert.ok(m[0].includes(`const stale = isEndpointStale(${arg}, isGenerating);`), fnName + " computes stale");
      assert.ok(m[0].includes(`endpointStaleFlags.${prefix} = stale;`), fnName + " sets stale flag");
      assert.ok(m[0].includes(`dimEndpointRateCards("${prefix}", stale);`), fnName + " dims rate cards");
      assert.ok(m[0].includes(`staleText: stale ? formatRelativeAge(sess.lastSeen) : null,`), fnName + " brief gets relative-age pill");
      assert.ok(/if \(!stale\) \{[\s\S]*?pushMetricPoint[\s\S]*?redrawEndpointSparklines/.test(m[0]),
        fnName + " gates metric push + sparkline redraw on !stale");
      assert.ok(m[0].includes(`(!stale && typeof tps === "number" && tps > 0)`), fnName + " tps hidden when stale");
    }
  });

  it("redrawEndpointSparklines 顶层门控 endpointStaleFlags（setFold 展开补绘同受控）", () => {
    const m = panelJs.match(/function redrawEndpointSparklines\(prefix\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "redrawEndpointSparklines found in panel.js");
    assert.ok(m[1].includes("if (endpointStaleFlags[prefix]) return;"), "stale endpoints skip drawing");
  });

  it("updateDetailBrief 支持 staleText：隐藏速率类胶囊、显示相对时间胶囊", () => {
    const m = panelJs.match(/function updateDetailBrief\(prefix, \{([\s\S]*?)\n  \}/);
    assert.ok(m, "updateDetailBrief found in panel.js");
    assert.ok(m[0].includes("staleText"), "accepts staleText");
    assert.ok(m[0].includes('setPill("BriefStale", staleMode'), "drives the stale pill");
    assert.ok(m[0].includes('setPill("BriefTps", !staleMode && tps !== null'), "rate pills hidden in stale mode");
    assert.ok(!/setPill\("BriefTps", [^,]+, `\$\{tps\.toFixed/.test(m[0]),
      "rate pill html no longer eager-evaluated (null-safe)");
  });

  it("两张静态卡的简要栏都有 tag-stale 相对时间胶囊", () => {
    for (const prefix of ["zc", "qoder"]) {
      assert.ok(
        new RegExp(`<span class="tag-bubble tag-stale" id="${prefix}BriefStale" hidden></span>`).test(panelHtml),
        prefix + "BriefStale pill exists");
    }
  });
});
describe("panel.html 静态卡（zc/qoder）收起态简要栏与多实例实例行同范式", () => {
  // 收起态主信息栏对齐多实例端点实例行：名称行挂请求数徽标、名称行下挂 tokens 行
  // （Prompt/Completion/Cached），「全局汇总」行改仅展开态显示（避免同数据双行并存）。
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );

  it("两张静态卡简要栏：名称行挂请求数徽标 + tokens 行（Prompt/Completion/Cached）", () => {
    for (const prefix of ["zc", "qoder"]) {
      assert.ok(
        new RegExp(`<span class="badge badge-neutral" id="${prefix}BriefReqs">0 请求</span>`).test(panelHtml),
        prefix + "BriefReqs badge exists");
      assert.ok(
        new RegExp(`<div class="session-tokens-line" id="${prefix}BriefTokens">Prompt: 0 · Completion: 0 · Cached: 0</div>`).test(panelHtml),
        prefix + "BriefTokens line exists");
    }
  });

  it("updateDetailBrief 驱动请求数徽标与 tokens 行（累计量，不受 staleMode 门控）", () => {
    const m = panelJs.match(/function updateDetailBrief\(prefix, \{([\s\S]*?)\n  \}/);
    assert.ok(m, "updateDetailBrief found in panel.js");
    assert.ok(m[0].includes("requests"), "accepts requests");
    assert.ok(m[0].includes("tokensText"), "accepts tokensText");
    assert.ok(m[0].includes('$(prefix + "BriefReqs")'), "drives the requests badge");
    assert.ok(m[0].includes('$(prefix + "BriefTokens")'), "drives the tokens line");
    assert.ok(m[0].includes("`${requests || 0} 请求`"), "badge text matches instance-row 「N 请求」 wording");
  });

  it("三个静态渲染函数把 tokens/请求数接入 updateDetailBrief（tokens 先于调用声明）", () => {
    for (const [fnName, arg, totalReq] of [["renderZcode", "z", "z.totalRequests"], ["renderQoder", "p", "p.totalRequests"]]) {
      const m = panelJs.match(new RegExp("function " + fnName + "\\(" + arg + "\\) \\{[\\s\\S]*?\\n  \\}"));
      assert.ok(m, fnName + " found in panel.js");
      assert.ok(m[0].includes(`requests: m.totalRequests || ${totalReq} || 0,`), fnName + " passes requests");
      assert.ok(
        m[0].includes("tokensText: `Prompt: ${formatTokens(tokens.prompt)} · Completion: ${formatTokens(tokens.completion)} · Cached: ${formatTokens(tokens.cached)}`,"),
        fnName + " passes tokensText");
      const declIdx = m[0].indexOf("const tokens = m.tokens || sess.tokens || {};");
      const callIdx = m[0].indexOf("updateDetailBrief(");
      assert.ok(declIdx !== -1 && callIdx !== -1 && declIdx < callIdx, fnName + " declares tokens before the brief call");
    }
  });

  it("「全局汇总」行仅展开态显示：旧机制 setFold 门控其 session-table-wrapper", () => {
    const m = panelJs.match(/\["zc", "qoder"\]\.forEach\(\(prefix\) => \{[\s\S]*?\n  \}\);/);
    assert.ok(m, "static fold wiring found in panel.js");
    assert.ok(m[0].includes('$(prefix + "SessionRow")'), "resolves the aggregate row");
    assert.ok(m[0].includes('closest(".session-table-wrapper")'), "toggles the wrapper");
    assert.ok(m[0].includes("if (aggWrap) aggWrap.hidden = !open;"), "collapsed hides the aggregate row");
  });
});


describe("panel.html stats tab 竞态守卫 / 动画收尾 / 图例持久化 / a11y", () => {
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );

  it("refreshStatsState 丢弃旧响应：请求序号 + 响应 days 双比对", () => {
    const m = panelJs.match(/async function refreshStatsState\(opts\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "refreshStatsState found in panel.js");
    const body = m[1];
    assert.ok(panelJs.includes("let statsReqSeq = 0"), "req seq counter declared");
    assert.ok(body.includes("++statsReqSeq"), "seq bumped per request");
    assert.ok(body.includes("seq !== statsReqSeq"), "stale response dropped by seq");
    assert.ok(body.includes("res.days !== statsPrefs.days"), "window-mismatched response dropped");
    // 竞态丢弃必须发生在 statsData 赋值之前
    const dropIdx = body.indexOf("res.days !== statsPrefs.days");
    const setIdx = body.indexOf("statsData = res;");
    assert.ok(dropIdx !== -1 && setIdx !== -1 && dropIdx < setIdx, "drop guard precedes statsData commit");
    // 手动刷新（非静默）失败才 toast 的语义不变
    assert.ok(body.includes("if (!silent) toast("), "manual-refresh failure still toasts");
    assert.ok(/seq !== statsReqSeq\) return;/.test(body), "stale failure returns without toast");
  });

  it("leaveStatsView 停轮询并统一取消在飞动画 rAF（趋势 morph + 环形 reveal）", () => {
    const m = panelJs.match(/function leaveStatsView\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "leaveStatsView found in panel.js");
    const body = m[1];
    assert.ok(body.includes("clearInterval(statsTimer)"), "30s poll cleared");
    assert.ok(body.includes("statsTrendChart"), "trend chart visited");
    assert.ok(body.includes("statsUsageDonut"), "donut visited");
    assert.ok(body.includes("cancelAnimationFrame"), "in-flight rAF cancelled");
    assert.ok(body.includes("_statsAnim"), "trend morph/reveal state cleared");
    assert.ok(body.includes("_usageRaf"), "donut reveal state cleared");
  });

  it("环形图揭示动画每次进 tab 重播（enterStatsView 重置标记，与趋势图 reveal 同语义）", () => {
    const m = panelJs.match(/function enterStatsView\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "enterStatsView found in panel.js");
    assert.ok(m[1].includes("statsUsageRevealed = false"), "reveal flag reset on tab enter");
    assert.ok(m[1].includes("statsTrendPrev = null"), "trend reveal reset preserved");
  });

  it("趋势图进 tab 缓存热渲染：动画随进 tab 即时起跑，不等 stats 接口返回", () => {
    const m = panelJs.match(/function enterStatsView\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "enterStatsView found in panel.js");
    const body = m[1];
    // 回归根因：热渲染曾只有环形图，趋势图首渲等 refreshStatsState 的网络往返
    // 落地（实测热 300~500ms）才触发，reveal 起跑随之延迟同款时长。
    const fetchIdx = body.indexOf("refreshStatsState()");
    assert.ok(fetchIdx !== -1, "fetch kicked off on tab enter");
    const trendIdx = body.indexOf("renderStatsTrend()");
    const usageIdx = body.indexOf("renderStatsUsage()");
    assert.ok(trendIdx !== -1 && trendIdx < fetchIdx, "trend hot-rendered from cache before the fetch");
    assert.ok(usageIdx !== -1 && usageIdx < fetchIdx, "donut hot-render preserved");
    // 热渲染时刻 reveal 标记已重置 → 首渲走 reveal 清屏生长而非 morph
    const resetIdx = body.indexOf("statsTrendPrev = null");
    assert.ok(resetIdx !== -1 && resetIdx < trendIdx, "reveal flag reset before hot-render");
    // 接口落地重渲不打断在飞动画的兜底仍在：数据未变由同终点签名守卫整体跳过
    assert.ok(panelJs.includes("container._statsAnim.targetSig === renderStatsTrendSignature(cfg)"),
      "same-endpoint guard skips the fetch-landing re-render when data is unchanged");
  });

  it("趋势图切口径 seg：重置 reveal 标记走清屏生长，不走 morph；days seg 维持 morph", () => {
    const m = panelJs.match(/function initStatsTab\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "initStatsTab found in panel.js");
    // 切口径：先重置 statsTrendPrev（下次渲染落 reveal 生长）再重渲，顺序不能反
    const scope = m[1].match(/wireStatsSeg\("statsSegScope", \(v\) => \{([^}]*)\}\)/);
    assert.ok(scope, "statsSegScope wiring found");
    const resetIdx = scope[1].indexOf("statsTrendPrev = null");
    const renderIdx = scope[1].indexOf("renderStatsTrend()");
    assert.ok(resetIdx !== -1 && renderIdx !== -1 && resetIdx < renderIdx,
      "scope seg resets reveal flag before re-render → 清屏左至右生长");
    // days seg 维持原状：重拉数据后走 morph（跨桶数索引比例映射），不重置标记
    const days = m[1].match(/wireStatsSeg\("statsSegDays", \(v\) => \{([^}]*)\}\)/);
    assert.ok(days, "statsSegDays wiring found");
    assert.ok(!days[1].includes("statsTrendPrev"), "days seg keeps the morph path");
    assert.ok(days[1].includes("refreshStatsState()"), "days seg re-fetches window data");
    // 动画决策单点：有上一帧 → morph，无 → reveal（清屏生长）
    const trend = panelJs.match(/function renderStatsTrend\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(trend, "renderStatsTrend found in panel.js");
    assert.ok(trend[1].includes('statsTrendPrev ? { type: "morph" } : { type: "reveal" }'),
      "anim decision: morph only when a previous frame exists, otherwise reveal");
  });

  it("揭示收尾清 _usageRaf 句柄，守卫只挡静默重渲（seg 点击 replay 放行）", () => {
    const m = panelJs.match(/function renderStatsUsage\(opts\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "renderStatsUsage found in panel.js");
    const body = m[1];
    // 收尾：draw 最后一帧必须清句柄，否则已触发的旧 id 恒真 → 守卫永久吞掉 seg/轮询重渲
    const doneIdx = body.indexOf("else donutEl._usageRaf = null;");
    assert.ok(doneIdx !== -1, "draw completion clears _usageRaf");
    const contIdx = body.indexOf("if (p < 1) donutEl._usageRaf = requestAnimationFrame(draw);");
    assert.ok(contIdx !== -1 && contIdx < doneIdx, "clear comes after the continuation branch");
    // 守卫语义：静默重渲被挡，但用户主动 seg 点击（replay）必须放行
    assert.ok(body.includes("if (!force && !replay && donutEl._usageRaf) return;"),
      "in-flight guard skips silent re-renders only");
  });

  it("模型用量卡两栏：右半柱状图与环同源同色、同一 rAF 生长揭示、静默重渲画满", () => {
    // 结构：卡体 .stats-usage-split 两栏，左 donut-wrap（环+图例榜原样），右柱状图容器
    const body = panelHtml.match(/<!-- H：模型用量[\s\S]*?<!-- F\/G1/);
    assert.ok(body, "usage card markup found");
    const markup = body[0];
    assert.ok(/<div class="stats-usage-split">/.test(markup), "two-column split wrapper");
    assert.ok(markup.includes('<div class="stats-usage-bars" id="statsUsageBars">'), "bars container present");
    assert.ok(markup.indexOf("stats-usage-donut-wrap") < markup.indexOf("statsUsageBars"),
      "donut+legend left column precedes bars right column");

    // 渲染：与环同一批可见节点（nodes=hidden 过滤后）、同一颜色来源 statsUsageColorOf(key, allNodes)
    const m = panelJs.match(/function renderStatsUsage\(opts\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "renderStatsUsage found in panel.js");
    const fn = m[1];
    assert.ok(fn.includes('$("statsUsageBars")'), "renderStatsUsage visits bars container");
    assert.ok(fn.includes("barsEl.textContent = \"\""), "bars cleared on every render (空态不渲染)");
    const callIdx = fn.indexOf("appendStatsUsageBars(barsEl, nodes, allNodes, reveal");
    assert.ok(callIdx !== -1, "bars built from same visible nodes + allNodes (同源同排序)");
    const emptyIdx = fn.indexOf("empty-hint\">暂无用量数据");
    assert.ok(emptyIdx !== -1 && emptyIdx < callIdx, "empty state returns before bars render");

    // 生长动画：复用 USAGE_REVEAL_MS + easeOutCubic，挂在环的同一 draw 循环里
    // （共享 _usageRaf 句柄守卫与 leaveStatsView 清理，无第二处 rAF）
    const drawIdx = fn.indexOf("const draw = (t) => {");
    assert.ok(drawIdx !== -1, "single shared rAF draw loop");
    const loop = fn.slice(drawIdx);
    assert.ok(loop.includes("(t - t0) / USAGE_REVEAL_MS"), "bars growth reuses USAGE_REVEAL_MS");
    assert.ok(loop.includes("1 - Math.pow(1 - p, 3)"), "same easeOutCubic easing");
    assert.ok(loop.includes("rect.setAttribute(\"height\", String(h))"), "bar height driven per frame");
    assert.equal((fn.match(/requestAnimationFrame\(draw\)/g) || []).length, 2,
      "only one rAF chain (schedule + continuation) drives both donut and bars");

    // 构造器：同色（statsUsageColorOf）、同名（nodeLabel→端点粒度走 statsEndpointLabel）、
    // 数值标签 formatTokensCn；reveal 时 0 高起步，静默（reveal=false）直接画满
    const bm = panelJs.match(/function appendStatsUsageBars\(([\s\S]*?)\n  \}/);
    assert.ok(bm, "appendStatsUsageBars found in panel.js");
    const bb = bm[1];
    assert.ok(bb.includes('rect.setAttribute("fill", statsUsageColorOf(n.key, allNodes))'),
      "bar fill reuses statsUsageColorOf — 与环段/图例点同色");
    assert.ok(bb.includes("nodeLabel(n)"), "bar name label shares legend naming");
    assert.ok(bb.includes("formatTokensCn(n.tokens || 0)"), "bar value label formatted");
    assert.ok(bb.includes('reveal ? groundY : groundY - fullH'), "reveal starts at 0 height, silent render full");
    assert.ok(bb.includes('aria-label", "模型用量柱状图"'), "bars svg role=img aria-label wired");
  });

  it("同终点守卫：morph 进行中同内容重渲跳过（seg 重击/轮询不重置动画时间轴）", () => {
    // 渲染器顶层守卫：在飞动画存在时先比目标签名（labels+series key/color/dash+values），
    // 一致 → 整体 return 不重启 rAF；不一致或 reveal → 照旧取消重建。
    const fn = panelJs.match(/function renderStatsLineChart\(container, cfg, anim\) \{([\s\S]*?)\n  \}/);
    assert.ok(fn, "renderStatsLineChart found in panel.js");
    const head = fn[1];
    // 守卫必须在取消在飞 rAF 之前（否则动画已被杀，跳过无意义）
    const guardIdx = head.indexOf("renderStatsTrendSignature(cfg)");
    const cancelIdx = head.indexOf("cancelAnimationFrame(prevAnim.raf)");
    assert.ok(guardIdx !== -1, "same-target guard present in renderer head");
    assert.ok(cancelIdx !== -1 && guardIdx < cancelIdx,
      "guard runs before cancelling the in-flight rAF");
    // 签名函数存在且覆盖轴与系列（值含在 series.values）
    assert.ok(panelJs.includes("function renderStatsTrendSignature(cfg)"),
      "signature helper defined");
    // 守卫成立路径：直接 return，不重建 DOM（textContent 清空在守卫之后）
    const after = head.slice(guardIdx, guardIdx + 400);
    assert.ok(/return;/.test(after), "guard short-circuits with plain return");
  });

  it("reveal 半途被 morph 接管：dash 从已画弧长连续起步、沿用原时钟归一续推（不重启、总时长不变）", () => {
    // reveal 的 t0 记上 state，供接管沿用
    assert.ok(
      /const state = \{ raf: 0, current: commitPixels\(\), grown: new Map\(\), targetSig: animSig, t0: performance\.now\(\) \}/.test(panelJs),
      "reveal state carries t0 for takeover clock inheritance");
    // morph 状态带 dashT0（续接时钟）与 grown（链式续推的成员判定）
    assert.ok(
      /const state = \{ raf: 0, current: null, targetSig: animSig, t0, dashT0, grown: new Map\(\) \}/.test(panelJs),
      "morph state carries dashT0 and grown");
    // 续接时钟沿接管链继承最初 reveal 的时钟，链外取自身 t0
    assert.ok(
      panelJs.includes("const dashT0 = (prevAnim && (prevAnim.dashT0 ?? prevAnim.t0)) ?? t0;"),
      "dashT0 inherited along the takeover chain");
    // 续推从接管点已画弧长 k 连续起步，剩余段按缓动尾部归一（eStart=接管点在原
    // 时钟上的缓动进度）：位置与速度都连续、不重启时钟；旧的「k→total 换全新
    // 1500ms」写法已移除
    assert.ok(
      panelJs.includes("const eStart = STATS_MORPH_EASE(Math.min(1, (t0 - dashT0) / STATS_MORPH_MS));")
        && panelJs.includes("const pDash = Math.min(1, (t - dashT0) / STATS_MORPH_MS);")
        && panelJs.includes("k + (pl.total - k) * (STATS_MORPH_EASE(pDash) - eStart) / (1 - eStart)"),
      "dash continuation continuous from k, normalized over the remaining ease tail");
    assert.ok(!panelJs.includes("(pl.total - k) * e;"),
      "old clock-restart continuation removed");
    // 续接系列已画弧长回写 grown（链式接管不断链）；播满还原静态 dash
    assert.ok(panelJs.includes("state.grown.set(pl.rec.s.key, u);")
        && panelJs.includes("if (pDash >= 1) restoreSegs(pl);"),
      "grown maintained during carry and dash restored on completion");
  });

  it("morph/reveal 进行中 hover 十字线与 tooltip 隐藏（终态坐标不再与曲线错位）", () => {
    const m = panelJs.match(/overlay\.addEventListener\("mousemove", \(e\) => \{([\s\S]*?)\n    \}\);/);
    assert.ok(m, "mousemove handler found in panel.js");
    const body = m[1];
    const guardIdx = body.indexOf("container._statsAnim");
    const useIdx = body.indexOf("X(idx)");
    assert.ok(guardIdx !== -1 && useIdx !== -1 && guardIdx < useIdx,
      "in-flight animation guard runs before final-state coordinates are used");
    assert.ok(body.includes('tip.style.display = "none"'), "tooltip hidden while animating");
  });

  it("图例隐藏集 prune + 持久化到 localStorage（panel-stats-legend 并列键）", () => {
    assert.ok(panelJs.includes('"panel-stats-legend"'), "legend persistence key used");
    assert.ok(panelJs.includes("function saveStatsLegend()"), "saveStatsLegend defined");
    const trend = panelJs.match(/function renderStatsTrend\(\) \{([\s\S]*?)\n  \}/);
    const usage = panelJs.match(/function renderStatsUsage\(opts\) \{([\s\S]*?)\n  \}/);
    assert.ok(trend && usage, "both renderers found in panel.js");
    for (const [name, body] of [["renderStatsTrend", trend[1]], ["renderStatsUsage", usage[1]]]) {
      assert.ok(body.includes("liveKeys"), name + " collects live keys");
      assert.ok(body.includes("hidden.delete(k)"), name + " prunes vanished keys");
      assert.ok(body.includes("saveStatsLegend()"), name + " persists on toggle/prune");
    }
    // 双窗口回归：取数必须 winKey 先选窗口、dim 再下钻粒度（缺任一层 allNodes 恒空 → 恒空态）
    const u = usage[1];
    const winIdx = u.indexOf("statsData.usage[winKey]");
    const dimIdx = u.indexOf("winUsage[dim]");
    assert.ok(winIdx !== -1 && dimIdx !== -1 && winIdx < dimIdx,
      "renderStatsUsage reads usage[winKey][dim] — both drill-down levels");
  });

  it("panel-stats-legend 存取往返：Set 序列化为数组、非法形状静默忽略", () => {
    const load = panelJs.match(/function loadStatsPrefs\(\) \{([\s\S]*?)\n  \}/);
    const save = panelJs.match(/function saveStatsLegend\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(load && save, "load/save functions found in panel.js");
    const factory = new Function(
      "localStorage", "statsPrefs", "statsLegendHidden", "statsUsageHidden",
      "let statsPrefsLoaded = false;\n"
      + `function loadStatsPrefs() {${load[1]}\n  }\n`
      + `function saveStatsLegend() {${save[1]}\n  }\n`
      + "return { loadStatsPrefs, saveStatsLegend };",
    );
    // 存：隐藏 channel:foo / usage channel:bar → JSON 数组
    const store = {};
    const ls = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
    const mkSets = () => ({ channel: new Set(), endpoint: new Set(), model: new Set() });
    const legend1 = mkSets(), usage1 = mkSets();
    legend1.channel.add("foo");
    usage1.channel.add("bar");
    const f1 = factory(ls, { scope: "channel", days: 7, usageDim: "channel" }, legend1, usage1);
    f1.saveStatsLegend();
    const persisted = JSON.parse(store["panel-stats-legend"]);
    assert.deepEqual(persisted.legend.channel, ["foo"]);
    assert.deepEqual(persisted.usage.channel, ["bar"]);
    // 取：新会话（全新 Set）从同一 localStorage 恢复
    const legend2 = mkSets(), usage2 = mkSets();
    factory(ls, { scope: "channel", days: 7, usageDim: "channel" }, legend2, usage2).loadStatsPrefs();
    assert.ok(legend2.channel.has("foo"), "legend hidden key restored");
    assert.ok(usage2.channel.has("bar"), "usage hidden key restored");
    // 非法形状：坏 JSON / 非数组字段不抛、不污染
    store["panel-stats-legend"] = "{broken";
    const legend3 = mkSets(), usage3 = mkSets();
    assert.doesNotThrow(() => factory(ls, { scope: "channel", days: 7, usageDim: "channel" }, legend3, usage3).loadStatsPrefs());
    assert.equal(legend3.channel.size, 0);
    store["panel-stats-legend"] = JSON.stringify({ legend: { channel: "nope" }, usage: { model: [1, "ok"] } });
    const legend4 = mkSets(), usage4 = mkSets();
    factory(ls, { scope: "channel", days: 7, usageDim: "channel" }, legend4, usage4).loadStatsPrefs();
    assert.equal(legend4.channel.size, 0, "non-array dim ignored");
    assert.deepEqual([...usage4.model], ["ok"], "non-string entries filtered");
  });

  it("a11y：四个视图 tab 有 tablist/tab/aria-selected，switchView 同步选中态", () => {
    assert.ok(/<nav class="view-tabs" role="tablist"/.test(panelHtml), "tablist role on nav");
    for (const id of ["tabBoard", "tabSkills", "tabStore", "tabStats"]) {
      assert.ok(new RegExp(`id="${id}" role="tab" aria-selected=`).test(panelHtml), id + " has tab role + selected state");
    }
    const m = panelJs.match(/function switchView\(name\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "switchView found in panel.js");
    assert.ok(m[1].includes('setAttribute("aria-selected"'), "aria-selected synced in switchView");
  });

  it("a11y：统计页 seg 按钮补 role=radio（对齐 keepAlive 处既有写法）", () => {
    for (const seg of ["statsSegScope", "statsSegDays", "statsSegUsageDim"]) {
      const m = panelHtml.match(new RegExp(`<div class="seg-control" id="${seg}"[^>]*>([\\s\\S]*?)</div>`));
      assert.ok(m, seg + " found");
      const btns = m[1].match(/<button[^>]*>/g) || [];
      assert.ok(btns.length > 0, seg + " has buttons");
      for (const b of btns) assert.ok(b.includes('role="radio"'), seg + " button has radio role: " + b);
    }
  });

  it("a11y：图例项为 button，趋势/环形 SVG 有 role=img 与 aria-label", () => {
    assert.ok(!panelJs.includes('document.createElement("span");\n      chip.className = "stats-legend-item"'),
      "trend legend chip no longer a span");
    assert.ok(panelJs.includes('document.createElement("button")'), "legend items are buttons");
    assert.ok(panelJs.includes('ariaLabel: "Token 趋势图"'), "trend chart aria-label wired");
    assert.ok(panelJs.includes('ariaLabel: "首字响应 TTFT 趋势图"'), "ttft chart aria-label wired");
    assert.ok(panelJs.includes('aria-label", "模型用量环形图"'), "donut svg aria-label wired");
    assert.ok(panelJs.includes('svg.setAttribute("role", "img")'), "svg role=img set");
  });

  it("统计卡口径标注唯一性", () => {
    // 卡头标注只留在确有误读风险的卡（TPS）；今日概览与趋势卡头不设标注
    //（今日口径与滚动窗口属默认读法）。
    const allUiText = panelHtml + panelJs + panelCss;
    for (const note of [
      "仅统计流式请求",
    ]) {
      assert.ok(allUiText.includes(`<span class="stats-card-note">${note}</span>`), "note: " + note);
    }
    assert.ok(!allUiText.includes("成功率不含用户取消"), "统计卡不含该标注");
    for (const dropped of [
      "今日自然日口径",
      "按过去 24h / 7 日滚动窗口统计",
    ]) {
      assert.ok(!allUiText.includes(dropped), "卡头不得出现标注: " + dropped);
    }
    // 取消口径下沉到成功率行标签。
    assert.ok(allUiText.includes("成功率（不含取消）"), "success-rate row carries the exclude-cancel caveat");
    assert.ok(!panelHtml.includes(".stats-usage-grid") && !panelCss.includes(".stats-usage-grid"), ".stats-usage-grid 不得残留");
    assert.ok(!allUiText.includes("图表 tab[柱状图/环形图]"), "图表 tab 注释不得残留");
    assert.ok(!panelHtml.includes('<section class="skills-view stats-view"'),
      "statsView 不得挂未引用的 .skills-view 类");
    assert.ok(panelHtml.includes('<span class="badge badge-neutral">近 90 天</span>'), "heatmap 90-day badge kept as its annotation");
  });
});

describe("panel.html claude 全局汇总行（与其他多实例栏同范式）", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );
  // 汇总行 DOM 在 panel.html，renderClaude/claudeAggregateMetrics 逻辑已拆到 panel.js
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );

  it("claude 卡声明与其他多实例栏同构的静态「全局汇总」行（detail-open-only）", () => {
    for (const id of ["ccSessionRow", "ccSessionReqs", "ccSessionTokens", "ccActiveTag", "ccLastModelTag"]) {
      assert.ok(panelHtml.includes(`id="${id}"`), `missing element #${id}`);
    }
    assert.ok(/<div class="session-row detail-open-only" id="ccSessionRow">/.test(panelHtml),
      "cc 汇总行带 detail-open-only（仅展开态显示，与 pi/kimi/opencode 一致）");
    assert.ok(/<div id="ccSessionsList"><\/div>\s*<div class="session-row detail-open-only" id="ccSessionRow">/.test(panelHtml),
      "汇总行位于实例列表之后的 session-table-wrapper 内（同其他栏结构）");
  });

  it("renderClaude 接线：会话求和聚合 + 零实例伪实例行 + 折叠门控与其他栏一致", () => {
    const m = panelJs.match(/function renderClaude\(c\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "renderClaude found in panel.js");
    assert.ok(m[1].includes("const agg = claudeAggregateMetrics(sessions);"), "claude 无聚合桶，由各会话行求和派生");
    assert.ok(m[1].includes("aggregateFallback: buildAggregateFallback(agg, c, isGenerating)"),
      "零实例时用聚合量渲染「全局汇总」伪实例行，收起态不为空");
    assert.ok(m[1].includes('applyDetailFold("cc")'), "渲染后应用折叠态");
    assert.ok(m[1].includes('gateAggregateRow("cc", $("ccSessionRow"), sessions.length)'),
      "静态汇总行门控：有实例仅展开态显示，零实例让位伪实例行");
    assert.ok(m[1].includes('$("ccSessionTokens").textContent'), "汇总行 tokens 喂数");
    assert.ok(m[1].includes('$("ccSessionReqs").textContent'), "汇总行请求数喂数");
    assert.ok(m[1].includes('$("ccActiveTag").hidden = !isGenerating'), "正在生成胶囊门控");
    assert.ok(m[1].includes('ccLastModelTag.textContent = "模型: " + capsuleLabels.join(", ")'),
      "卡头走同源胶囊列表（虚拟 auto 已被过滤）");
  });

  it("claudeAggregateMetrics 求和口径：累加项、prompt 加权缓存、最近会话 TTFT", () => {    const m = panelJs.match(/function claudeAggregateMetrics\(sessions\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "claudeAggregateMetrics exists in panel.js");
    assert.ok(m[1].includes("tokens.prompt += tk.prompt || 0;"), "tokens 累加");
    assert.ok(m[1].includes("totalRequests += s.requests || 0;"), "请求数累加");
    assert.ok(m[1].includes("durationMs += s.activeDurationMs || 0;"), "工时累加");
    assert.ok(m[1].includes("if (typeof s.tps === \"number\" && s.tps > 0) tpsSum += s.tps;"), "tps 为各会话之和");
    assert.ok(m[1].includes("tokens.cached / tokens.prompt"), "缓存命中率按 prompt 加权");
    assert.ok(m[1].includes("(seen || 0) >= ttftSeen"), "TTFT 取最近有活动的会话");
  });

  it("看板 claude 头像方砖：亮色品牌橙描边 + 淡橙打底，暗色两段回退深棕砖", () => {
    // 方块来自 panel.html 内联 var()，值由 panel.css 三段 token 提供：亮色段=淡橙底+
    // 品牌橙边；显式 dark 与跟随系统 dark 两段都回退为原来的 #2b1810/#542c1b。
    // 三段缺一，暗底就会留下亮色淡橙（或反之），三套主题共用同一组值。
    const inline = /<div class="agent-avatar" style="background:var\(--cc-avatar-bg\); border:1px solid var\(--cc-avatar-border\);">/;
    assert.ok(inline.test(panelHtml), "claude 头像方砖走 --cc-avatar-* token（非写死色值）");
    assert.ok(!panelHtml.includes("background:#2b1810"), "写死的深棕底已交还 token，否则内联样式会盖住亮色值");
    const roots = panelCss.match(/:root([^{]*)\{([\s\S]*?)\n  \}/g) || [];
    const tokensOf = (sel) => {
      const block = roots.find((b) => b.startsWith(sel));
      return block ? { bg: /--cc-avatar-bg:\s*([^;]+);/.exec(block)?.[1], border: /--cc-avatar-border:\s*([^;]+);/.exec(block)?.[1] } : null;
    };
    const light = tokensOf(":root {") ?? tokensOf(":root{");
    assert.deepEqual(light && { bg: light.bg?.trim(), border: light.border?.trim() },
      { bg: "#ffedd5", border: "var(--ep-claude)" }, "亮色段=淡橙底 + 品牌橙描边");
    assert.equal((panelCss.match(/--cc-avatar-bg:\s*#2b1810;/g) || []).length, 2,
      "暗色两段（显式 dark 与跟随系统）各回退一次深棕底");
    assert.equal((panelCss.match(/--cc-avatar-border:\s*#542c1b;/g) || []).length, 2,
      "暗色两段各回退一次深棕描边");
    const dark = panelCss.slice(panelCss.indexOf(':root[data-theme="dark"] {'), panelCss.indexOf('@media (prefers-color-scheme: dark)'));
    assert.ok(/--cc-avatar-bg:\s*#2b1810;/.test(dark) && /--cc-avatar-border:\s*#542c1b;/.test(dark),
      "显式暗色段带完整回退值");
  });
});

describe("panel.html 行不含 hover 高亮", () => {
  const panelCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.css"),
    "utf8",
  );

  it("全局汇总行与实例 title 行（同为 .session-row）不再有鼠标悬浮高亮", () => {
    assert.ok(!panelCss.includes(".session-row:hover"), ".session-row 不得含 hover 高亮规则");
    assert.ok(!panelCss.includes(".session-name-line:hover"), "session-name-line 无独立 hover 规则");
  });
});


describe("panel.html 预设管理 tab", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );
  // 视图容器与按钮在 panel.html，列表/详情/表单/接线逻辑已拆到 panel.js
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );

  it("declares the presets tab button (after tabSkills) and view container", () => {
    assert.ok(panelHtml.includes('id="tabPresets"'), "tabPresets tab button exists");
    assert.ok(panelHtml.includes('id="presetsView"'), "presetsView section exists");
    assert.ok(panelHtml.includes("预设管理"), "presets tab label exists");
    const nav = panelHtml.match(/<nav class="view-tabs"[\s\S]*?<\/nav>/);
    assert.ok(nav, "view-tabs nav found");
    const iSkills = nav[0].indexOf('id="tabSkills"');
    const iPresets = nav[0].indexOf('id="tabPresets"');
    assert.ok(iSkills !== -1 && iPresets !== -1 && iSkills < iPresets,
      "tabPresets sits right after tabSkills");
    for (const id of [
      "ctxMeter",
      "presetsAddBtn",
      "presetsRefreshBtn",
      "presetsFilterInput",
      "presetsList",
      "presetsMasterToggle",
      "presetsDetailBody",
    ]) {
      assert.ok(panelHtml.includes(`id="${id}"`), `missing element #${id}`);
    }
  });

  it("全局设置（总开关）卡挂在预设视图左列首张，不漂回看板左栏", () => {
    const iView = panelHtml.indexOf('id="presetsView"');
    const iToggle = panelHtml.indexOf('id="presetsMasterToggle"');
    assert.ok(iView > 0 && iToggle > iView, "总开关在预设管理视图内（看板 section 之后）");
    const firstCol = panelHtml.indexOf('<div class="skills-col">', iView + 1);
    const secondCol = panelHtml.indexOf('<div class="skills-col">', firstCol + 1);
    const leftCol = panelHtml.slice(firstCol, secondCol);
    assert.ok(leftCol.includes('id="presetsMasterToggle"'), "总开关位于左列（第一个 skills-col）");
    const iGlobal = leftCol.indexOf("全局设置");
    const iList = leftCol.indexOf("预设列表");
    assert.ok(iGlobal > -1 && iList > -1 && iGlobal < iList,
      "左列首张是全局设置，其下才是预设列表");
    const board = panelHtml.slice(panelHtml.indexOf('<section class="telemetry-view">'), iView);
    assert.ok(!board.includes("启用预设注入"), "看板视图不携带预设总开关");
  });

  it("extends switchView / restoreView / init for the presets view without regressing others", () => {
    const m = panelJs.match(/function switchView\(name\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "switchView found in panel.js");
    const body = m[1];
    assert.ok(body.includes('name === "presets"'), "presets branch added");
    assert.ok(body.includes('$("presetsView").hidden = !presets'), "presetsView visibility wired");
    assert.ok(body.includes('$("tabPresets").classList.toggle("active", presets)'), "tabPresets active state wired");
    assert.ok(body.includes('["tabPresets", presets]'), "aria-selected sync covers tabPresets");
    assert.ok(body.includes("refreshPresetsState()"), "entering presets refreshes state");
    assert.ok(body.includes('$("skillsView").hidden = !(name === "skills")'), "skills view still exclusive");
    assert.ok(body.includes("refreshSkillsState()"), "skills refresh preserved");
    assert.ok(body.includes("refreshStoreState()"), "store refresh preserved");
    assert.ok(panelJs.includes("initPresetsTab();"), "initPresetsTab runs during init");
    assert.ok(panelJs.includes('$("tabPresets").onclick = () => switchView("presets")'), "tabPresets click wired");
    const r = panelJs.match(/function restoreView\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(r, "restoreView found in panel.js");
    assert.ok(r[1].includes('saved === "presets"'), "presets branch added");
    assert.ok(r[1].includes('saved === "skills"'), "skills branch preserved");
    assert.ok(r[1].includes('saved === "store"'), "store branch preserved");
    assert.ok(r[1].includes('saved === "stats"'), "stats branch preserved");
  });

  it("list rows reuse the skills row template plus a per-preset length badge; header meter painted", () => {
    const m = panelJs.match(/function renderPresetsList\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "renderPresetsList found in panel.js");
    const body = m[1];
    assert.ok(body.includes("skills-list-row"), "row reuses .skills-list-row");
    assert.ok(body.includes("skills-list-name"), "title reuses .skills-list-name");
    assert.ok(body.includes("badge badge-neutral"), "tag badge reuses .badge-neutral");
    assert.ok(body.includes("skills-ep-count"), "inject count reuses .skills-ep-count");
    assert.ok(body.includes('" some"') && body.includes('" full"'), "some/full count coloring preserved");
    assert.ok(body.includes("skills-list-desc"), "desc line reuses .skills-list-desc");
    assert.ok(body.includes("data-preset="), "rows carry the preset id key");
    assert.ok(body.includes("ctx-preset-badge"), "per-preset length badge rendered");
    assert.ok(body.includes("presetBadgeClass"), "length badge tier coloring (green/yellow/red) wired");
    assert.ok(body.includes("paintCtxMeter(presets)"), "header occupancy meter painted from full preset set");
  });

  it("detail card renders per-endpoint rows with toggle, status badge and sync-error warning", () => {
    const m = panelJs.match(/function renderPresetDetail\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "renderPresetDetail found in panel.js");
    const body = m[1];
    assert.ok(body.includes("endpoints.map((ep) =>"), "one row per endpoint (9 from state)");
    assert.ok(body.includes("skills-skill-row"), "endpoint row reuses .skills-skill-row");
    assert.ok(body.includes('class="toggle"'), "per-endpoint toggle present");
    assert.ok(body.includes("data-inject="), "toggle carries the endpoint id");
    assert.ok(body.includes("badge-ok") && body.includes("badge-neutral"), "injected/not-injected badges");
    assert.ok(body.includes("badge-warn"), "sync failure badge");
    assert.ok(body.includes("运行中会话需重开生效"), "hotReload=false endpoint note");
    assert.ok(body.includes("skills-batch-actions"), "batch inject/uninject actions");
    assert.ok(body.includes("presetsInjectAllBtn") && body.includes("presetsUninjectAllBtn"), "batch buttons wired");
    assert.ok(body.includes("presetDetailEditBtn") && body.includes("presetDetailDeleteBtn"), "edit/delete buttons in detail head");
  });

  it("shares one store-style form modal for create/edit with title/tag/content and an error bar", () => {
    const m = panelJs.match(/function showPresetFormModal\(preset, values, errorMsg\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "showPresetFormModal found in panel.js");
    const body = m[1];
    assert.ok(body.includes('id="presetFormTitle"'), "title input");
    assert.ok(body.includes('id="presetFormTag"'), "tag input");
    assert.ok(body.includes('id="presetFormContent"'), "content textarea");
    assert.ok(body.includes('id="presetFormError"') && body.includes("store-form-error"), "error bar");
    assert.ok(body.includes("wide: true"), "wide modal like store showAddModal");
    assert.ok(body.includes("showPresetFormModal(preset, { title, tag, content }, msg)"),
      "validation/submit failure reopens with filled values preserved");
    assert.ok(body.includes('"/api/prompts/preset/create"'), "create endpoint");
    assert.ok(body.includes('"/api/prompts/preset/update"'), "update endpoint");
  });

  it("uses the prompts HTTP contract and the shared api() helper", () => {
    // api() 会自动拼 API_BASE（origin + "/panel"），传入路径必须是不带
    // "/panel" 前缀的 "/api/..."——带前缀会产生 /panel/panel/... 双重前缀 404。
    assert.ok(panelJs.includes('api("GET", "/api/prompts/state")'), "state GET");
    for (const p of [
      "/api/prompts/master",
      "/api/prompts/preset/delete",
      "/api/prompts/preset/enable",
      "/api/prompts/override",
    ]) {
      assert.ok(panelJs.includes(`"${p}"`), `missing endpoint ${p}`);
    }
    assert.ok(!/api\("(?:GET|POST)", "\/panel\//.test(panelJs),
      "api() paths must not carry the /panel prefix (double-prefix 404 regression)");
    // 串行刷新链（防乱序），与 skills 同模式
    assert.ok(panelJs.includes("presetsRefreshChain"), "serialized refresh chain");
  });
});

describe("panel-host self-restart endpoint + control-plane-only page", () => {
  function restartRouter({ hostKind, spawnImpl, exitImpl } = {}) {
    const calls = { spawns: 0, exits: [] };
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null,
      metricsCollector: null,
      aliasResolver: null,
      aliasPath: null,
      fetchRelayAgents: async () => null,
      hostKind,
      spawnPanelHostRestartFn: spawnImpl ?? (() => { calls.spawns += 1; }),
      exitPanelHostFn: exitImpl ?? ((code) => calls.exits.push(code)),
    });
    return { router, calls };
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  it("answers first and exits only after the response has flushed", async () => {
    const { router, calls } = restartRouter();
    const { req, res, json } = fakeReqRes("/panel/api/panel-host/restart", "POST");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.equal(json().pid, process.pid);
    assert.equal(calls.spawns, 1, "the detached helper is the only thing that can bring the next host up");
    assert.deepEqual(calls.exits, [], "exiting before the flush is what the browser cannot distinguish from failure");
    res.emit("finish");
    await wait(250);
    assert.deepEqual(calls.exits, [0]);
  });

  it("still exits when the client is gone before the flush completes", async () => {
    const { router, calls } = restartRouter();
    const { req, res } = fakeReqRes("/panel/api/panel-host/restart", "POST");
    await router.handle(req, res);
    // No "finish" emitted: the backstop must still release 47820, otherwise the
    // frontend's recovery poll waits forever on a port we are holding.
    await wait(1_500);
    assert.deepEqual(calls.exits, [0]);
  });

  it("reports ok:false without exiting when the helper cannot be spawned", async () => {
    const { router, calls } = restartRouter({ spawnImpl: () => { throw new Error("spawn ENOENT"); } });
    const { req, res, json } = fakeReqRes("/panel/api/panel-host/restart", "POST");
    await router.handle(req, res);
    assert.equal(res.statusCode, 500);
    assert.equal(json().ok, false);
    assert.match(json().error, /ENOENT/);
    await wait(250);
    assert.deepEqual(calls.exits, [], "no helper means no replacement — stay up and serve");
  });

  it("refuses the restart from the relay-host copy of the router", async () => {
    const { router, calls } = restartRouter({ hostKind: "relay-host" });
    const { req, res, json } = fakeReqRes("/panel/api/panel-host/restart", "POST");
    await router.handle(req, res);
    assert.equal(res.statusCode, 409);
    assert.equal(json().ok, false);
    assert.match(json().error, /47820/);
    assert.equal(calls.spawns, 0);
    await wait(250);
    assert.deepEqual(calls.exits, [], "the relay is never the process that dies here");
  });

  it("rejects a cross-site restart POST without the panel header", async () => {
    const { router, calls } = restartRouter();
    const { req, res } = fakeReqRes("/panel/api/panel-host/restart", "POST", null, { origin: "http://evil.test" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(calls.spawns, 0);
  });

  it("redirects 47821's page document to the control plane instead of serving a second copy", async () => {
    const { router } = restartRouter({ hostKind: "relay-host" });
    const { req, res } = fakeReqRes("/panel", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, "http://127.0.0.1:47820/panel");
    assert.equal(res.body, "");
  });

  it("keeps 47821's API surface alive while its page document redirects", async () => {
    const { router } = restartRouter({ hostKind: "relay-host" });
    const status = fakeReqRes("/panel/api/status", "GET");
    await router.handle(status.req, status.res);
    assert.equal(status.res.statusCode, 200);
    assert.equal(status.json().relay.port, 47821);
    // Per-launch Claude relays POST session/report to 47821 — the redirect must
    // stay scoped to the page document or their usage-journal rows would stop.
    const report = fakeReqRes("/panel/api/session/report", "POST", { pid: 123 });
    await router.handle(report.req, report.res);
    assert.equal(report.res.statusCode, 200);
    assert.equal(report.json().ok, true);
  });
});

describe("panel.html 面板重启状态机契约", () => {
  // 主脚本逻辑（恢复轮询/重启执行/控制按住）在 panel.js；开屏复播入口
  // panelStartupPlay 由 panel.html 的内联脚本暴露，跨文件断言两处都覆盖。
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );

  it("恢复轮询独立成链且不受 document.hidden 门控", () => {
    assert.ok(panelJs.includes("function watchPanelHostComeBack()"), "独立的恢复轮询");
    assert.ok(panelJs.includes("PANEL_RESTART_POLL_MS"), "恢复轮询自带节奏常量");
    const recoveryStart = panelJs.indexOf("function watchPanelHostComeBack()");
    const recovery = panelJs.slice(recoveryStart, panelJs.indexOf("if (stopConfirmBtn)", recoveryStart));
    assert.ok(recovery.length > 500, "未真正取到函数体，后续断言会全部落空");
    assert.ok(!recovery.includes("document.hidden"),
      "带 hidden 门控的话，用户点完重启切走标签页就永远检测不到换新");
    assert.ok(!recovery.includes("location.reload()"), "不再裸 reload——新页面首绘要接力开屏层，裸 reload 会把标记丢掉");
    assert.ok(recovery.includes('next.searchParams.set("startup", "restart")'), "带 startup=restart 跳转，新页面据此接力开屏并播入场动画");
    assert.ok(recovery.includes("location.assign(next.href)"), "assign 走 navigate 路径，bootstrap 的 navigation.type 门控才放行");
    assert.ok(recovery.includes("identity.pid !== before.pid"), "以 pid 变化判定新进程");
    assert.ok(recovery.includes("identity.startTime !== before.startTime"), "startTime 作为辅助身份信号");
  });

  it("panelRestarting 同时压住徽标误报与按钮重新启用", () => {
    assert.ok(panelJs.includes("let panelRestarting = false;"));
    // 徽标：refreshStatus 的 catch 在窗口内不得改判
    assert.ok(/if \(panelRestarting\) return;\s*\n\s*\$\("topDot"\)\.className = "pulse-dot stopped";/.test(panelJs),
      "面板重启期间 47820 不可达是预期，不能把徽标写成「Relay 未运行」");
    // 按钮：1s 轮询会重新调用 updateRelayControls，不拦住恢复期能再点一次重启
    assert.ok(/function updateRelayControls\(relay\) \{[\s\S]{0,600}?if \(panelRestarting\) \{[\s\S]{0,200}?return;\s*\}/.test(panelJs),
      "updateRelayControls 必须在重启窗口内按住两个按钮后直接返回");
  });

  it("面板重启请求用裸 fetch，区分连接掐断与服务端拒绝", () => {
    const execStart = panelJs.indexOf("async function executeRestartRelay()");
    const exec = panelJs.slice(execStart, panelJs.indexOf("function watchPanelHostComeBack()", execStart));
    assert.ok(exec.length > 500, "未真正取到 executeRestartRelay 函数体，后续断言会全部落空");
    assert.ok(exec.includes('fetch(API_BASE + "/api/panel-host/restart"'),
      "api() 把「响应被退出掐断」和「403/409/500 明确拒绝」都抛成同一种 Error");
    assert.ok(!exec.includes('api("POST", "/api/panel-host/restart"'), "这个端点只能走裸 fetch：api() 无法区分连接掐断与明确拒绝");
    assert.ok(exec.includes("restartStarted = true;"), "连接中断按「重启已开始」处理");
    assert.ok(exec.includes('api("POST", "/api/relay/restart")'), "relay 仍是第一段，失败即终止");
  });

  it("重启窗口复播开屏：确认即盖屏，失败与超时显式收回", () => {
    assert.ok(panelJs.includes("window.panelStartupBegin"), "开屏复播入口由 head 内联脚本暴露");
    assert.ok(panelHtml.includes("function panelStartupPlay(replayPulse)"), "开屏动画必须是可重复调用的函数，且接受「这一次要不要播脉冲」");
    const execStart = panelJs.indexOf("async function executeRestartRelay()");
    const exec = panelJs.slice(execStart, panelJs.indexOf("function watchPanelHostComeBack()", execStart));
    assert.ok(exec.includes("playStartupSplash()"), "确认重启后立刻复播开屏盖住页面");
    // 复播必须显式要求播脉冲：只看页面级标记的话，用户停在上次重启恢复页上再点
    // 重启，这一遍开屏会被静默吞成定格（整条链一帧动画都没有）。
    assert.ok(panelJs.includes("panelStartupPlay?.(true)"),
      "用户点重启触发的复播显式传 true，不依赖页面级标记");
    assert.equal(exec.split("dropStartupSplash()").length - 1, 2,
      "relay 换新失败与面板换新被拒两条失败路径都要收回开屏");
    const recoveryStart = panelJs.indexOf("function watchPanelHostComeBack()");
    const recovery = panelJs.slice(recoveryStart, panelJs.indexOf("if (stopConfirmBtn)", recoveryStart));
    assert.ok(recovery.includes("dropStartupSplash()"), "恢复超时路径也要收回开屏");
    assert.ok(!recovery.includes("playStartupSplash()"), "恢复期不得重复盖屏");
  });

  it("launcher 启动固定落看板页，刷新仍恢复上次 tab", () => {
    assert.ok(panelHtml.includes("window.panelStartupLaunch = true"), "标记只在 launcher URL 路径打点");
    const restoreStart = panelJs.indexOf("function restoreView()");
    const restore = panelJs.slice(restoreStart, panelJs.indexOf("function reconcileSkillsSelection()", restoreStart));
    assert.ok(restore.length > 100, "未真正取到 restoreView 函数体，后续断言会全部落空");
    assert.ok(/if \(window\.panelStartupLaunch\) \{[\s\S]{0,200}setItem\("panel-settings-open", "0"\)[\s\S]{0,120}return;/.test(restore),
      "launcher 首开连设置页标记一起清掉再跳过恢复，固定落看板");
    assert.ok(restore.includes('localStorage.getItem("panel-view")'), "刷新与普通访问仍按 panel-view 恢复");
  });
});

describe("panel.html 渠道刷新「查看差异」弹窗", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );
  // 弹窗 DOM 在 panel.html，storeRefresh/状态小字/分组渲染逻辑在 panel.js，
  // 宽幅弹窗与 diff 小字的样式规则在 panel.css
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );
  const panelCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.css"),
    "utf8",
  );

  it("声明弹窗 DOM 与「查看差异」小字结构", () => {
    for (const id of [
      "storeDiffMask",
      "storeDiffCloseBtn",
      "storeDiffFails",
      "storeDiffAddedTitle",
      "storeDiffAddedBody",
      "storeDiffPrunedTitle",
      "storeDiffPrunedBody",
    ]) {
      assert.ok(panelHtml.includes(`id="${id}"`), `missing element #${id}`);
    }
    assert.ok(panelHtml.includes("diff-modal-overlay"), "弹窗挂宽幅类");
    assert.ok(panelJs.includes("srs-diff-link"), "状态小字含 diff 小字类");
    assert.ok(panelJs.includes('>查看差异</span>'), "小字文案在线");
    assert.ok(!panelHtml.includes("展示diff") && !panelJs.includes("展示diff"), "旧文案不得残留");
  });

  it("「查看差异」小字在可见态可命中（容器 none 需子元素显式开回）", () => {
    // 前提：容器声明不拦指针（浮动小字不挡按钮），这条被删掉会让全页小字都吃点击
    assert.ok(/\.store-refresh-status\s*\{[^}]*pointer-events:\s*none/.test(panelCss),
      "容器默认 pointer-events: none（前提）");
    // pointer-events 可继承：不在可见态开回，小字的 onclick 永远不触发
    assert.ok(panelCss.includes(".store-refresh-status.show .srs-diff-link { pointer-events: auto; }"),
      "可见态显式恢复小字命中测试");
  });

  it("storeRefresh 累积本轮 diff 快照（含池合并与失败原因）", () => {
    const fnStart = panelJs.indexOf("async function storeRefresh(");
    assert.ok(fnStart >= 0, "storeRefresh 定义存在");
    const fn = panelJs.slice(fnStart, panelJs.indexOf("// ── 新增渠道 modal", fnStart));
    assert.ok(fn.length > 500, "storeRefresh 体必须真的被抓取到");
    assert.ok(fn.includes("refreshDiffUnits = []"), "每轮开始清空快照");
    assert.ok(fn.includes("refreshDiffUnits.push({"), "每单元刷完累积快照");
    assert.ok(fn.includes("uAddedIds.push(...(rep.added || []))"), "收集新增模型 id 数组");
    assert.ok(fn.includes("uPrunedIds.push(...(rep.pruned || []))"), "收集移除模型 id 数组");
    assert.ok(fn.includes("if (!uErr) uErr = rep.reason"), "失败原因回填（report failed 路径）");
    assert.ok(fn.includes("failed: uFail > 0"), "快照记录失败标记");
  });

  it("「查看差异」小字仅完成态且确有增减/失败时挂出", () => {
    const fnStart = panelJs.indexOf("async function storeRefresh(");
    const fn = panelJs.slice(fnStart, panelJs.indexOf("// ── 新增渠道 modal", fnStart));
    assert.ok(fn.includes('const hasDiff = refreshDiffUnits.some('), "计算本轮是否有 diff");
    assert.ok(fn.includes('setStoreRefreshStatus("刷新完成", "done", lastTail, hasDiff)'),
      "done 路径把 hasDiff 传给状态小字");
    // setStoreRefreshStatus 第四参数控制 diff 小字显隐
    const setStart = panelJs.indexOf("function setStoreRefreshStatus(");
    const set = panelJs.slice(setStart, panelJs.indexOf("// 10s 淡出计时", setStart));
    assert.ok(set.includes("showDiff"), "setStoreRefreshStatus 接收 showDiff 参数");
    assert.ok(set.includes("diff.hidden = !showDiff"), "按 showDiff 切换小字显隐");
  });

  it("弹窗打开期间暂停状态小字淡出计时，关闭时重新武装", () => {
    assert.ok(panelJs.includes("function armStoreStatusTimer()"), "计时武装函数存在");
    assert.ok(panelJs.includes("function disarmStoreStatusTimer()"), "计时暂停函数存在");
    const openStart = panelJs.indexOf("function openStoreDiffModal()");
    const open = panelJs.slice(openStart, panelJs.indexOf("function closeStoreDiffModal()", openStart));
    assert.ok(open.includes("disarmStoreStatusTimer()"), "打开弹窗暂停计时");
    const closeStart = panelJs.indexOf("function closeStoreDiffModal()");
    const close = panelJs.slice(closeStart, panelJs.indexOf("// 刷新：全部刷新", closeStart));
    assert.ok(close.includes('classList.contains("show")'), "关闭时判状态小字仍可见");
    assert.ok(close.includes("armStoreStatusTimer()"), "关闭时重新武装 10s");
  });

  it("弹窗按单元分组渲染左右分栏，失败渠道单列一区", () => {
    const grpStart = panelJs.indexOf("function storeDiffGroupHtml(");
    const grp = panelJs.slice(grpStart, panelJs.indexOf("function openStoreDiffModal()", grpStart));
    assert.ok(grp.includes("diff-modal-group-title"), "组标题渲染渠道/池名");
    assert.ok(grp.includes("diff-modal-row"), "每行一个模型 id");
    assert.ok(grp.includes("diff-modal-empty"), "空态兜底");
    const openStart = panelJs.indexOf("function openStoreDiffModal()");
    const open = panelJs.slice(openStart, panelJs.indexOf("function closeStoreDiffModal()", openStart));
    assert.ok(open.includes('refreshDiffUnits.filter((u) => u.failed)'), "失败单元单列");
    assert.ok(open.includes("storeDiffFails"), "失败区挂载点");
    assert.ok(open.includes('storeDiffGroupHtml(refreshDiffUnits, "added", "diff-added")'), "左栏新增绿底");
    assert.ok(open.includes('storeDiffGroupHtml(refreshDiffUnits, "pruned", "diff-pruned")'), "右栏移除红底");
  });

  it("弹窗关闭走关闭钮/遮罩/Esc 三路（与会话删除确认同模式）", () => {
    assert.ok(panelJs.includes('$("storeDiffCloseBtn").addEventListener("click", closeStoreDiffModal)'),
      "关闭钮接线");
    assert.ok(panelJs.includes('e.target === $("storeDiffMask")'), "遮罩点击关闭");
    assert.ok(panelJs.includes('$("storeDiffMask").classList.contains("show")) closeStoreDiffModal()'),
      "Esc 关闭（判 show 态）");
  });
});

describe("设置项「注入推理强度」", () => {
  function makeRouter(base, { onSync } = {}) {
    return createPanelRouter({
      base,
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      enableWatchdogAutostartFn: async () => ({ ok: true }),
      disableWatchdogAutostartFn: async () => ({ ok: true }),
      isWatchdogAutostartEnabledFn: async () => false,
      spawnWatchdogFn: async () => ({ ok: true }),
      stopWatchdogFn: async () => ({ ok: true }),
      probeWatchdogFn: async () => false,
      fetchRelayAgents: async () => null,
      // Never let a test spawn the real sync runner: it rewrites the user's
      // own endpoint configs under ~/.zcode, ~/.pi, ~/.codex and friends.
      spawnAgentSyncFn: async (args) => { onSync?.(args); return { ok: true, stdout: "" }; },
    });
  }

  function tempBase() {
    const dir = mkdtempSync(join(tmpdir(), "anyswitch-panel-effort-"));
    const relayDataRoot = join(dir, "Anyswitch");
    mkdirSync(relayDataRoot, { recursive: true });
    return { base: { LOCALAPPDATA: dir, USERPROFILE: join(dir, "user") }, dir: relayDataRoot };
  }

  it("未落盘时默认为开，POST false 后 GET 回读为 false", async () => {
    const { base, dir } = tempBase();
    const router = makeRouter(base);

    const initial = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(initial.req, initial.res);
    assert.equal(JSON.parse(initial.res.body).settings.injectThinkingEffort, true, "开关默认开");

    const post = fakeReqRes("/panel/api/settings", "POST", { injectThinkingEffort: false });
    await router.handle(post.req, post.res);
    assert.equal(JSON.parse(post.res.body).ok, true);

    const after = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(after.req, after.res);
    assert.equal(JSON.parse(after.res.body).settings.injectThinkingEffort, false);
    rmSync(dir, { recursive: true, force: true });
  });

  // The endpoints only learn about levels from a sync, so saving this setting
  // has to fire one — otherwise the toggle would appear to do nothing until
  // the next unrelated store change.
  it("保存该设置后触发一次端点同步", async () => {
    const { base, dir } = tempBase();
    const syncs = [];
    const router = makeRouter(base, { onSync: (args) => syncs.push(args) });

    const post = fakeReqRes("/panel/api/settings", "POST", { injectThinkingEffort: false });
    await router.handle(post.req, post.res);
    assert.equal(syncs.length, 1, "保存推理强度开关触发一次同步");
    rmSync(dir, { recursive: true, force: true });
  });

  it("保存无关设置时不触发同步", async () => {
    const { base, dir } = tempBase();
    const syncs = [];
    const router = makeRouter(base, { onSync: (args) => syncs.push(args) });

    const post = fakeReqRes("/panel/api/settings", "POST", { sparkWindowPoints: 32 });
    await router.handle(post.req, post.res);
    assert.equal(syncs.length, 0, "其它设置不触发端点同步");
    rmSync(dir, { recursive: true, force: true });
  });

  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );

  it("设置弹窗里以既有的 .toggle 开关呈现，标题为「注入推理强度」", () => {
    assert.ok(panelHtml.includes('<div class="modal-item-title">注入推理强度</div>'), "条目标题");
    const item = panelHtml.match(/<div class="modal-item">[\s\S]*?注入推理强度[\s\S]*?<\/label>\s*<\/div>/);
    assert.ok(item, "条目挂在设置弹窗内");
    assert.ok(item[0].includes('<label class="toggle">'), "沿用全局开关控件与各主题皮肤");
    assert.ok(item[0].includes('id="injectEffortToggle"'), "开关有稳定 id 供读写");
  });

  // 抠出 onchange 函数体，注入假 toggle/api/toast 做真行为断言（全绿不等于可点，
  // 这里跑的就是点击后那段代码）。
  function runToggleHandler({ checked, apiResult }) {
    const source = panelJs.match(/injectEffortToggle\.onchange = async \(\) => \{[\s\S]*?\n      \};/);
    assert.ok(source, "onchange 处理器在 panel.js 里");
    const toggle = {
      checked,
      setAttribute() {},
      removeAttribute() {},
    };
    const calls = [];
    const toasts = [];
    const settingsSaving = { injectEffort: false };
    const api = async (method, path, body) => {
      calls.push({ method, path, body });
      return apiResult;
    };
    const run = new Function(
      "injectEffortToggle", "settingsSaving", "api", "toast",
      `let settingsLoadGen = 0; ${source[0]} return injectEffortToggle.onchange();`,
    );
    return {
      done: run(toggle, settingsSaving, api, (message) => toasts.push(message)),
      calls,
      toasts,
      toggle,
      savingAfter: () => settingsSaving.injectEffort,
    };
  }

  it("打开开关后 POST 该设置并以服务端回读值为准", async () => {
    const scenario = runToggleHandler({
      checked: true,
      apiResult: { ok: true, settings: { injectThinkingEffort: true } },
    });
    await scenario.done;
    assert.deepEqual(scenario.calls, [{
      method: "POST", path: "/api/settings", body: { injectThinkingEffort: true },
    }]);
    assert.deepEqual(scenario.toasts, ["已开启注入推理强度"]);
    assert.equal(scenario.savingAfter(), false, "保存中标记已释放");
  });

  it("保存失败时开关弹回原状并报错", async () => {
    const scenario = runToggleHandler({ checked: false, apiResult: { ok: false } });
    await scenario.done;
    assert.equal(scenario.toggle.checked, true, "回滚到点击前状态");
    assert.equal(scenario.toasts.length, 1);
    assert.equal(scenario.toasts[0], "设置保存失败");
  });

  it("说明文案只讲用户看得懂的行为，不出现字段名", () => {
    const desc = panelHtml.match(/<div class="modal-item-desc">(anyswitch借助公开资料[^<]*)<\/div>/);
    assert.ok(desc, "说明文案存在");
    assert.doesNotMatch(desc[1], /reasoning_effort|injectThinkingEffort|support_efforts|default_effort|thinkingLevelMap|thinkingFormat/, "正文不出现字段名");
    assert.doesNotMatch(desc[1], /[A-Za-z]+_[A-Za-z]+|[a-z]+[A-Z][A-Za-z]+/, "正文不出现 snake_case / camelCase 标识符");
  });
});

describe("panel.html 界面文案边界（实现细节不上屏）", () => {
  // 用户可见文本分布在三个文件（DOM、脚本 toast/模板、CSS content），负向断言
  // 必须覆盖三文件拼接后的文本，否则实现细节词会从 panel.js/panel.css 漏上屏。
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );
  const panelCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.css"),
    "utf8",
  );
  const allUiText = panelHtml + panelJs + panelCss;

  it("服务端失败原文只挂 err.code，上屏一律经 panelError 取文案", () => {
    assert.ok(panelJs.includes("err.code = detail;"), "抛出时把服务端原文带在 code 上");
    assert.ok(panelJs.includes("function panelError(err, fallback)"), "取文案的唯一出口");
    assert.ok(panelJs.includes("function panelCopy(raw, fallback)"), "短码/文案分流的判据");
    assert.ok(!/\+ (e|err)\.message\b/.test(allUiText), "不得把 err.message 拼进界面文案");
    assert.ok(!/\$\{(?:e|err)\.message\}/.test(allUiText), "模板串里同理");
  });

  it("CAS 冲突分支比对 err.code：message 带 HTTP 前缀，比对它等于分支不生效", () => {
    assert.ok(!allUiText.includes('e.message === "cas-conflict"'), "旧比对不得残留");
    assert.equal(panelJs.split('e.code === "cas-conflict"').length - 1, 6,
      "六处冲突恢复分支全部接线");
  });

  it("渠道配置读取失败的前端译名覆盖 store-io 的 LOAD_REASON", () => {
    const storeIo = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "store-io.mjs"),
      "utf8",
    );
    const decl = storeIo.indexOf("export const LOAD_REASON");
    const codes = [...storeIo.slice(decl, storeIo.indexOf("};", decl)).matchAll(/:\s*"([^"]+)"/g)]
      .map((m) => m[1]);
    assert.ok(codes.length >= 4, "LOAD_REASON 取值被抓到，got " + codes.length);
    const tbl = panelJs.indexOf("const STORE_LOAD_COPY");
    const table = panelJs.slice(tbl, panelJs.indexOf("};", tbl));
    assert.ok(tbl >= 0, "译名表在线");
    for (const code of codes) {
      assert.ok(table.includes(`"${code}"`), "缺译名的短码: " + code);
    }
  });

  it("「同步到端点」的反馈止于端点结果，Codex 目录那两句不得复现", () => {
    // 边界由用户 09-21 定稿（app 仓 02d531f 撤回 ed5f703 挂上来的 Codex 目录提示）：
    // 这颗按钮写八个端点，反馈语义只到「哪些写进去了、哪些没写进去」。往这里加任何
    // 用户可见文本都属文案改动，须先经用户单独同意——本用例是那条红线的 diff 级锚点：
    // 改文案必然红，红了必然进 diff。细则见 bridge/anyswitch/PANEL-COPY-SPEC.md §六。
    const btnStart = panelJs.indexOf('$("storeSyncAgentsBtn").onclick');
    assert.ok(btnStart >= 0, "同步按钮处理函数存在");
    const btn = panelJs.slice(btnStart, panelJs.indexOf('$("storeFilterInput").addEventListener', btnStart));
    assert.ok(btn.length > 500, "处理函数体必须真的被抓取到，got " + btn.length);
    assert.ok(btn.includes("`已同步到全部 ${synced.length} 个端点的配置`"), "成功口径只报端点数");
    assert.ok(btn.includes('setStoreRefreshStatus("端点同步完成", "done")'), "完成态不挂右侧小字");
    assert.ok(btn.includes("没同步成功"), "部分失败仍点名未成功的端点");
    assert.ok(!/Codex/i.test(btn), "反馈里不得出现 Codex（含上游客户端实现限制类说明）");
    assert.ok(!allUiText.includes("syncCodexCatalogNote"), "拼句子的函数整体撤回，不得复活");
    assert.ok(!allUiText.includes("CODEX_PICKER_PAGE_SIZE"), "页容量常量随之撤回，不得复活");
    // 悬停名单是用户批准过的文案：动它要走单独同意，先钉住现文
    assert.ok(panelHtml.includes(
      'title="把当前渠道/号池立即写入全部端点配置（Kimi Code、Codex、OpenCode、Pi、DSH、ZCode、Qoder、Grok Build）"'
    ), "「同步到端点」悬停文案为已批准版本");
  });
});

describe("panel.html 删除渠道/号池携路由链剪除", () => {
  // 用户 09-21 定稿：删除被自动路由引用的渠道不再拒绝，而是同一笔删除里剪掉
  // 对应链节点；确认弹窗预告、成功提示回报。新增文案已逐句过审（PANEL-COPY-SPEC
  // 的流程），这里钉住批准版本。
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );

  it("删除恢复失败的 failed 项按 providerId 上屏，不得整对象拼接出 [object Object]", () => {
    assert.ok(panelJs.includes("item.providerId"), "失败项取 providerId");
    assert.ok(!panelJs.includes("const failed = (rr && rr.failed) || [];"), "不得保留旧写法（直接拿对象数组 join）");
  });

  it("删除渠道/池成员/号池/多选四个弹窗都预报自动路由被剪", () => {
    for (const fn of ["confirmDeleteProvider", "confirmDeletePoolMember", "confirmDissolvePool", "confirmDeletePool", "confirmDeleteStoreSelection"]) {
      assert.ok(panelJs.includes(`function ${fn}`), `${fn} 存在`);
    }
    assert.ok(panelJs.includes("endpointsRoutingThroughNodes("), "引用预判走共享函数");
    assert.ok(panelJs.includes("以下端点的自动路由包含该渠道："), "渠道弹窗预告句");
    assert.ok(panelJs.includes("以下端点的自动路由包含该号池："), "解除号池弹窗预告句");
    assert.ok(panelJs.includes("以下端点的自动路由包含其中的渠道或号池："), "删池/多选弹窗预告句");
    assert.ok(panelJs.includes("已从自动路由移除对应节点："), "删除成功提示后缀句");
  });

  it("prunedChains 的剩余跳数口径：0 跳整链消失只报端点名，>0 报剩几个节点", () => {
    const start = panelJs.indexOf("function routeChainPrunedNote");
    assert.ok(start >= 0, "后缀生成器存在");
    const body = panelJs.slice(start, panelJs.indexOf("\n  }", start));
    assert.ok(body.includes("item.remaining > 0"), "按 remaining 分支");
    assert.ok(body.includes("（剩 ${item.remaining} 个节点）"), "正数口径");
    assert.ok(!body.includes("[object"), "不得出现对象拼接");
  });
});

describe("panel.html 渠道刷新远离通报与「等切回」暂停", () => {
  // toast 机制与通报函数体在 panel.js；.toast 基座与动作小字命中规则在 panel.css
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );
  const panelCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.css"),
    "utf8",
  );

  it("toast 支持动作小字与自定义驻留（可见态开回命中）", () => {
    assert.ok(/function toast\(msg, isErr, opts\)/.test(panelJs), "toast 接收 opts 第三参数");
    assert.ok(panelJs.includes("(opts && opts.durationMs) || 3000"), "默认 3s、可覆盖驻留时长");
    assert.ok(panelJs.includes('link.className = "toast-action"'), "动作小字挂 toast-action 类");
    // 前提：基座 toast 不拦指针（浮动层不遮下方操作）；动作小字必须在可见态
    // 显式开回命中测试，否则 onclick 永远不触发（与 srs-diff-link 同款约束）
    assert.ok(/\.toast\s*\{[^}]*pointer-events:\s*none/.test(panelCss), "toast 默认 pointer-events: none（前提）");
    assert.ok(panelCss.includes(".toast.show .toast-action { pointer-events: auto; }"),
      "可见态恢复动作小字命中测试");
  });

  it("toast 置顶于顶栏下方（底部难以察觉，上移不遮顶栏 tab）", () => {
    const toastRule = panelCss.match(/\.toast\s*\{[^}]*\}/);
    assert.ok(toastRule, "基座 .toast 规则存在");
    assert.ok(toastRule[0].includes("top: 68px"), "固定在 56px 顶栏下方 12px");
    assert.ok(!toastRule[0].includes("bottom:"), "底部定位已移除");
    assert.ok(toastRule[0].includes("translateY(-8px)"), "入场自上方滑下");
  });

  it("终态远离通报：置「等切回」标记、停淡出计时、弹带链接的 8s toast", () => {
    assert.ok(panelJs.includes("let storeStatusAwaitReturn = false;"), "一次性等切回标记存在");
    const nStart = panelJs.indexOf("function notifyStoreRefreshAway(");
    assert.ok(nStart >= 0, "远离通报函数存在");
    const fn = panelJs.slice(nStart, panelJs.indexOf("// 渠道 diff 只摆增减数字", nStart));
    assert.ok(fn.includes('if (currentView === "store") return;'), "人在渠道 tab 不通报");
    assert.ok(fn.includes("storeStatusAwaitReturn = true;"), "置等切回标记");
    assert.ok(fn.includes("disarmStoreStatusTimer()"), "停掉小字 10s 淡出计时等人切回");
    assert.ok(fn.includes("durationMs: 8000"), "结果 toast 驻留 8s（留点击窗口）");
    assert.ok(fn.includes('label: "查看差异"'), "有差异时附可点「查看差异」");
    assert.ok(fn.includes("onClick: () => openStoreDiffModal()"), "点中原地开差异弹窗");
    assert.ok(!fn.includes("switchView("), "不抢焦点切 tab");
  });

  it("storeRefresh 三个终态各接线一次通报：完成带聚合与 diff、失败无 diff", () => {
    const fnStart = panelJs.indexOf("async function storeRefresh(");
    const fn = panelJs.slice(fnStart, panelJs.indexOf("// ── 新增渠道 modal", fnStart));
    assert.equal((fn.match(/notifyStoreRefreshAway\(/g) || []).length, 3,
      "完成/cas冲突/失败三处终态各通报一次（无可刷渠道的空操作不通报）");
    assert.ok(fn.includes('notifyStoreRefreshAway(`刷新完成：${totParts.length ? totParts.join(" ") : "无变化"}`, false, hasDiff)'),
      "完成态弹聚合结果并沿用 hasDiff 决定链接");
    assert.ok(fn.includes("const totAdded = refreshDiffUnits.reduce"), "toast 文案按全轮聚合而非末单元");
    assert.ok(fn.includes('notifyStoreRefreshAway("渠道配置已被其他操作改动，本次刷新未完成", true, false)'),
      "cas-conflict 中断通报（红色、无链接）");
    assert.ok(fn.includes("notifyStoreRefreshAway(errText, true, false)"), "刷新失败通报（红色、无链接）");
  });

  it("切回渠道 tab 消费标记重计 10s；标记未消费时关弹窗不武装", () => {
    const swStart = panelJs.indexOf("function switchView(");
    const sw = panelJs.slice(swStart, panelJs.indexOf("// 看板变体入场", swStart));
    const consumeAt = sw.indexOf("if (store && storeStatusAwaitReturn)");
    assert.ok(consumeAt >= 0, "切回渠道 tab 时检查等切回标记");
    const consume = sw.slice(consumeAt);
    assert.ok(consume.includes("storeStatusAwaitReturn = false;"), "标记一次性消费（再切走不再暂停）");
    assert.ok(consume.includes('classList.contains("show")'), "仅小字仍可见时才重计");
    assert.ok(consume.includes("armStoreStatusTimer()"), "切回重新武装完整 10s");
    const closeStart = panelJs.indexOf("function closeStoreDiffModal()");
    const close = panelJs.slice(closeStart, panelJs.indexOf("// 刷新：全部刷新", closeStart));
    assert.ok(close.includes("!storeStatusAwaitReturn"), "标记未消费（人未切回）时关弹窗不武装计时");
  });
});

describe("panel.html 品牌版本徽标（左上角取真实版本，不写死）", () => {
  // 徽标文本只有一处来源：package.json 经 /api/app-info 下发。页面里若写死版本号，
  // 发版升号后徽标不会跟着变，页面上就会显示一个与真实版本不符的数字——这条测试
  // 同时钉住「有位可填」「取值来源唯一」「取不到不编造」三点。
  const html = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );
  const js = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8"),
  );

  it("左上角徽标是空位＋隐藏态，不是写死的文字", () => {
    const tag = html.match(/<span class="version-tag"[^>]*><\/span>/);
    assert.ok(tag, "版本徽标元素存在");
    assert.ok(tag[0].includes('id="brandVersion"'), "徽标有可填的 id");
    assert.ok(/\shidden(\s|>)/.test(tag[0]), "初始隐藏：填不进版本时不留空胶囊");
    assert.ok(!html.includes("MONITOR"), "写死的 MONITOR 文案已移除");
    // 版本号不得出现在页面文件里（写死即必然过期）
    assert.ok(!html.includes(pkg.version), "panel.html 不含写死的版本号");
    assert.ok(!js.includes(pkg.version), "panel.js 不含写死的版本号");
  });

  it("init() 接线一次：取值来源是 /api/app-info，显示为 v+版本", async () => {
    assert.ok(js.includes("initBrandVersion();"), "init() 调用品牌版本装配");
    const body = js.match(/async function initBrandVersion\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(body, "initBrandVersion found in panel.js");
    assert.ok(body.includes('api("GET", "/api/app-info")'), "版本取自 app-info 唯一来源");
    assert.ok(body.includes('"v" + version'), "徽标文本为 v 前缀版本号");
  });

  async function run(info, { fail = false } = {}) {
    const body = js.match(/async function initBrandVersion\(\) \{[\s\S]*?\n  \}/)[0];
    const tag = { textContent: null, hidden: true };
    const initBrandVersion = await vm.runInNewContext(
      `(async () => { ${body} ; return initBrandVersion; })()`,
      {
        api: async () => { if (fail) throw new Error("HTTP 500"); return info; },
        $: (id) => (id === "brandVersion" ? tag : null),
      },
    );
    await initBrandVersion();
    return tag;
  }

  it("拿到版本：写入 v+版本并取消隐藏", async () => {
    const tag = await run({ version: "0.5.0-preview" });
    assert.equal(tag.textContent, "v0.5.0-preview");
    assert.equal(tag.hidden, false);
  });

  it("版本号两侧空白被去掉，不出现 v 与数字之间的空格", async () => {
    const tag = await run({ version: " 1.2.3 " });
    assert.equal(tag.textContent, "v1.2.3");
    assert.equal(tag.hidden, false);
  });

  it("接口失败：保持隐藏，不显示占位或旧版本，也不抛出", async () => {
    const tag = await run(null, { fail: true });
    assert.equal(tag.textContent, null);
    assert.equal(tag.hidden, true);
  });

  it("响应缺版本字段：保持隐藏，不编造数字", async () => {
    const tag = await run({ platform: "win32" });
    assert.equal(tag.textContent, null);
    assert.equal(tag.hidden, true);
  });
});
