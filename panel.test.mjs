import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
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
    // Production settings.json shape before the two-tier keep-alive merge.
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
});

// GET /api/settings decorates its response with watchdog drift visibility
// (registry task present vs watchdog process answering). Both probes are
// expensive — a PowerShell Get-ScheduledTask spawn (~0.9s measured) plus an
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
    assert.ok(panelHtml.includes('"opencode"'), "opencode appears in AGENT_CARD_ORDER");
    const orderMatch = panelHtml.match(/AGENT_CARD_ORDER\s*=\s*\[([^\]]+)\]/);
    assert.ok(orderMatch, "AGENT_CARD_ORDER literal found");
    assert.ok(orderMatch[1].includes('"opencode"'), "AGENT_CARD_ORDER contains opencode");
    assert.ok(panelHtml.includes('a.id === "opencode"'), "refreshAgents looks up the opencode agent");
    assert.ok(panelHtml.includes("renderOpencode(opencode)"), "refreshAgents calls renderOpencode");
    assert.ok(panelHtml.includes("function renderOpencode(p)"), "renderOpencode is defined");
  });

  it("keeps the stop-relay display name for opencode", () => {
    assert.ok(panelHtml.includes('opencode: "OpenCode"'), "lifecycle modal label map covers opencode");
  });

  it("inline scripts stay syntactically valid JavaScript", () => {
    const blocks = [...panelHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(blocks.length > 0, "panel.html has inline scripts");
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
    const orderMatch = panelHtml.match(/AGENT_CARD_ORDER\s*=\s*\[([^\]]+)\]/);
    assert.ok(orderMatch, "AGENT_CARD_ORDER literal found");
    assert.ok(orderMatch[1].includes('"qoder"'), "AGENT_CARD_ORDER contains qoder");
    assert.ok(panelHtml.includes('a.id === "qoder"'), "refreshAgents looks up the qoder agent");
    assert.ok(panelHtml.includes("renderQoder(qoder)"), "refreshAgents calls renderQoder");
    assert.ok(panelHtml.includes("function renderQoder(p)"), "renderQoder is defined");
  });

  it("keeps the stop-relay display name and stats label for qoder", () => {
    assert.ok(panelHtml.includes('qoder: "Qoder"'), "lifecycle modal label map covers qoder");
    const statsMatch = panelHtml.match(/STATS_ENDPOINT_LABELS\s*=\s*\{[\s\S]*?\n  \}/);
    assert.ok(statsMatch, "STATS_ENDPOINT_LABELS literal found");
    assert.ok(statsMatch[0].includes('qoder: "Qoder"'), "STATS_ENDPOINT_LABELS covers qoder");
  });
});

describe("panel.html stats tab", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("declares the stats tab button and view container", () => {
    assert.ok(panelHtml.includes('id="tabStats"'), "tabStats tab button exists");
    assert.ok(panelHtml.includes('id="statsView"'), "statsView section exists");
    assert.ok(panelHtml.includes("使用统计"), "stats tab label exists");
    assert.ok(panelHtml.includes('class="stats-top-grid"'), "two-column top layout exists");
    assert.ok(!panelHtml.includes("statsOvActive"), "active-count card removed");
    // 日期徽标已删（用户拍板）：今日口径是默认读法
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
    assert.ok(!panelHtml.includes(".stats-stab-"), "stability card CSS removed");
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
    const m = panelHtml.match(/function switchView\(name\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "switchView found");
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
    const m = panelHtml.match(/function restoreView\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "restoreView found");
    assert.ok(m[1].includes('saved === "skills"'), "skills branch preserved");
    assert.ok(m[1].includes('saved === "store"'), "store branch preserved");
    assert.ok(m[1].includes('saved === "stats"'), "stats branch added");
  });

  it("loads persisted stats prefs before the first stats fetch (restoreView ordering)", () => {
    // initSkillsTab 的 restoreView→switchView→enterStatsView 先于 initStatsTab 触发
    // 首次取数；refreshStatsState 必须在读 statsPrefs.days 之前兜底 loadStatsPrefs，
    // 否则刷新后 seg 显示已存选择、数据却按默认 days=7 拉取。
    const m = panelHtml.match(/function refreshStatsState\(opts\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "refreshStatsState found");
    const loadIdx = m[1].indexOf("loadStatsPrefs()");
    const fetchIdx = m[1].indexOf("/api/stats/state?days=");
    assert.ok(loadIdx !== -1 && fetchIdx !== -1 && loadIdx < fetchIdx,
      "loadStatsPrefs runs before the days-dependent fetch");
    assert.ok(panelHtml.includes("let statsPrefsLoaded = false;"), "prefs load is once-only guarded");
  });

  it("wires the stats tab, polls the stats API and pauses when hidden", () => {
    assert.ok(panelHtml.includes("initStatsTab();"), "initStatsTab runs during init");
    assert.ok(panelHtml.includes('$("tabStats").onclick = () => switchView("stats")'), "tabStats click wired");
    assert.ok(panelHtml.includes('api("GET", "/api/stats/state?days='), "stats API endpoint used");
    assert.ok(panelHtml.includes("function enterStatsView()"), "enter hook defined");
    assert.ok(panelHtml.includes("function leaveStatsView()"), "leave hook defined");
    const m = panelHtml.match(/function enterStatsView\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "enterStatsView found");
    assert.ok(m[1].includes("document.hidden"), "polling pauses while page hidden");
    assert.ok(m[1].includes("30000"), "30s polling interval");
  });

  it("clamps smooth-path control points so spike-adjacent segments never dip below the baseline", () => {
    const m = panelHtml.match(/function statsSmoothPath\(pts, clampY\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "statsSmoothPath(pts, clampY) found");
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
    const m = panelHtml.match(/function statsSmoothPath\(pts, clampY\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "statsSmoothPath(pts, clampY) found");
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

  it("extends switchView with the sessions branch and keeps aria-selected in sync", () => {
    const m = panelHtml.match(/function switchView\(name\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "switchView found");
    const body = m[1];
    assert.ok(body.includes('name === "sessions"'), "sessions branch added");
    assert.ok(body.includes('$("sessionsView").hidden = !sessions'), "sessionsView visibility wired");
    assert.ok(body.includes('$("tabSessions").classList.toggle("active", sessions)'), "tabSessions active state wired");
    // aria-selected 数组漏项会静默破坏 tablist 无障碍语义，必须断言
    assert.ok(body.includes('["tabSessions", sessions]'), "aria-selected sync covers tabSessions");
  });

  it("restores the sessions tab from localStorage", () => {
    const m = panelHtml.match(/function restoreView\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "restoreView found");
    assert.ok(m[1].includes('saved === "sessions"'), "sessions branch added");
  });

  it("defines initSessionsTab and wires the tab click to switchView", () => {
    assert.ok(panelHtml.includes("function initSessionsTab()"), "initSessionsTab is defined");
    assert.ok(
      panelHtml.includes('$("tabSessions").onclick = () => switchView("sessions")'),
      "tabSessions click wired to switchView",
    );
  });

  it("ships the finalized sessions copy", () => {
    assert.ok(panelHtml.includes("删除后不可恢复。"), "delete warning copy exists");
    assert.ok(panelHtml.includes("命令已复制，粘贴到终端即可继续会话"), "resume-command copied toast exists");
    assert.ok(panelHtml.includes("已删除"), "deleted toast copy exists");
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
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  // 胶囊 auto 标记判定（2026-09-02 语义纠偏）：标记数据源从「链位置快照
  // (route-chain runtime current)」改为「胶囊条目自身的服务归因 (viaAuto)」——
  // 胶囊反映当前服务的模型，auto 角标表示该服务来自 auto 链。位置快照不再参与
  // 胶囊判定（那是左栏路由链卡的职责）；旧「loading 首刷守卫」随之失去意义：
  // 直连流量从数据源上就不携带 viaAuto，按链名误挂的路径已不存在。
  function makeAutoMark() {
    const m = panelHtml.match(/function autoRouteMarkForTarget\(chain, providerId, modelName, viaAuto\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "autoRouteMarkForTarget found in panel.html");
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
    const m = panelHtml.match(/function capsuleTargetList\(st\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "capsuleTargetList found in panel.html");
    // 虚拟模型判定委托 hasDisplayIdentity（与 capsuleLabel 委托 routeNodeName
    // 同样的注入方式）：面板这里只测列表整形与过滤。
    const h = panelHtml.match(/function hasDisplayIdentity\(providerId, model\) \{[\s\S]*?\n  \}/);
    assert.ok(h, "hasDisplayIdentity found in panel.html");
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
    const m = panelHtml.match(/function capsuleLabel\(providerId, model\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "capsuleLabel found in panel.html");
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

  it("实例行「模型 @ 渠道」标签已移除：端点卡胶囊复合键化后归因信息完整，不再重复展示", () => {
    assert.ok(!panelHtml.includes("instanceTagBubble"), "instanceTagBubble gone");
    assert.ok(!panelHtml.includes("instanceTargetOf"), "instanceTargetOf gone");
    assert.ok(!panelHtml.includes("modelTag"), "modelTag slot gone");
  });

  it("卡头 Flow Rail 已移除：mini 轨道 CSS 与渲染入口不存在", () => {
    assert.ok(!panelHtml.includes("route-seg--mini"), "mini seg CSS gone");
    assert.ok(!panelHtml.includes("renderRouteChainStatus"), "rail renderer gone");
    assert.ok(!panelHtml.includes(".route-rail {"), "rail container CSS gone");
  });

  it("左栏路由链卡与 auto 胶囊的钩子存在", () => {
    assert.ok(panelHtml.includes('id="routeRailCard"'), "sidebar card hook");
    assert.ok(panelHtml.includes('id="routeRailList"'), "sidebar list hook");
    assert.ok(panelHtml.includes(".badge-auto {"), "badge-auto CSS");
    assert.ok(panelHtml.includes(".badge-auto-tag"), "auto tag CSS");
    assert.ok(panelHtml.includes("renderRouteChainBoard();"), "board renderer wired into polling");
    assert.ok(panelHtml.includes("renderModelBadges(modelBadgesList,"), "badge helper wired into cards");
  });

  it("claude 卡头「模型: …」与胶囊同源（虚拟 auto 不会从卡头漏出）", () => {
    const m = panelHtml.match(/function renderClaude\(c\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "renderClaude found in panel.html");
    assert.ok(m[0].includes("capsuleTargetList(c)"), "卡头复用胶囊同一份过滤后的列表");
    assert.ok(!m[0].includes("c.activeModels"), "卡头不再直接读未过滤的 activeModels");
  });

  it("右键菜单项文案为「删除」", () => {
    assert.ok(panelHtml.includes('{ label: "删除", danger: true'), "menu item renamed to 删除");
    assert.ok(!panelHtml.includes('label: "从链中移除"'), "old label gone");
  });

  // 灯色数据源切换（2026-09-01）：runtime lamps（每次启动重新统计）取代
  // stability 缓存判定；黄档移除，runtime 缺失时链首默认点亮。
  function makeRailLights() {
    const re = new RegExp("function routeRailLights\\(items, rt\\) \\{[\\s\\S]*?\\n  \\}");
    const m = panelHtml.match(re);
    assert.ok(m, "routeRailLights found in panel.html");
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

  it("stability 灯色判定与 TTFT 黄档已从链路状态区移除", () => {
    assert.ok(!panelHtml.includes("ROUTE_TTFT_WARN_MS"), "TTFT warn threshold gone");
    assert.ok(!panelHtml.includes("routeNodeLamp"), "stability-based lamp gone");
    assert.ok(!panelHtml.includes("lampWord"), "悬浮窗灯色文字 gone");
    assert.ok(!/黄灯|绿灯/.test(panelHtml), "链路状态区不再出现灯色名称字样");
  });
});

describe("panel.html stats tab 图表可读性（bar-fill 块级 / niceMax 密档 / 热力线性分档）", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  function makeNiceMax() {
    const m = panelHtml.match(/function statsNiceMax\(v\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "statsNiceMax found");
    return new Function("v", m[1]);
  }

  function makeHeatLevel(maxT) {
    const m = panelHtml.match(/const level = (\(t\) => \{[\s\S]*?\n    \});/);
    assert.ok(m, "heatmap level closure found");
    return new Function("maxT", `return ${m[1]};`)(maxT);
  }

  it("stats-bar-fill 是块级元素（span 无 display:block 时宽高塌陷，横条只剩空黑轨道）", () => {
    const m = panelHtml.match(/\.stats-bar-fill \{([^}]*)\}/);
    assert.ok(m, ".stats-bar-fill rule found");
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
      panelHtml,
      /\$\("statsRefreshBtn"\)\.onclick = \(\) => runStatsRefreshWithFeedback\(\)/,
      "按钮点击走带反馈的刷新包装（暗到动画播完才亮）",
    );
    assert.ok(panelHtml.includes(".stats-header-actions { display: flex"), "卡头操作区并排布局规则存在");
    const m = panelHtml.match(/async function runStatsRefreshWithFeedback\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "runStatsRefreshWithFeedback found");
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
    const m = panelHtml.match(/async function refreshStatsState\(opts\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "refreshStatsState found");
    const body = m[1];
    const replayIdx = body.indexOf("opts && opts.replay");
    assert.ok(replayIdx !== -1, "replay option parsed");
    // 重置必须落在 renderStatsAll 之前（否则当次渲染已按旧标记走 morph/静默）
    const resetIdx = body.indexOf('if (replay) { statsTrendPrev = null; statsUsageRevealed = false; }');
    const renderIdx = body.indexOf("renderStatsAll()");
    assert.ok(resetIdx !== -1 && renderIdx !== -1 && resetIdx < renderIdx,
      "replay resets statsTrendPrev + statsUsageRevealed before renderStatsAll");
    // 30s 轮询仍是静默路径，不带 replay
    assert.ok(panelHtml.includes("refreshStatsState({ silent: true })"), "poll stays silent (morph)");
  });
});

describe("panel.html stats 横条：右端对齐 + 上限留白", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("容器改 grid 三列共享列宽（数值列 max-content 取全组最长行，各行轨道右端严格对齐）", () => {
    assert.ok(panelHtml.includes('el.classList.add("stats-bars")'), "statsRenderBars 给容器挂 grid 类");
    const m = panelHtml.match(/\.stats-bars \{([^}]*)\}/);
    assert.ok(m, ".stats-bars rule found");
    assert.match(m[1], /display:\s*grid/, "container is grid");
    assert.match(m[1], /max-content/, "value column sized to the longest row");
    assert.ok(panelHtml.includes(".stats-bar-row { display: contents"), "rows join the shared grid");
    assert.ok(!panelHtml.includes(".stats-bar-row { display: flex"), "old per-row flex rule gone");
    assert.ok(
      panelHtml.includes(".stats-bars .empty-hint { grid-column: 1 / -1"),
      "empty hint spans all grid columns",
    );
  });

  it("最长条不顶到轨道满宽：填充上限 STATS_BAR_FILL_MAX < 100", () => {
    const m = panelHtml.match(/STATS_BAR_FILL_MAX = (\d+)/);
    assert.ok(m, "STATS_BAR_FILL_MAX defined");
    const cap = Number(m[1]);
    assert.equal(cap, 85, `cap=${cap} 应为 85（最长条留 15% 呼吸余量）`);
    assert.ok(
      panelHtml.includes("/ maxV) * STATS_BAR_FILL_MAX"),
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
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  // 从 panel.html 抠出 agentUsingAutoRoute 函数体，注入 boardRoutingChains 做行为测试
  function makeAgentUsingAutoRoute(chains) {
    const m = panelHtml.match(/function agentUsingAutoRoute\(agentId, st\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "agentUsingAutoRoute found in panel.html");
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
    assert.ok(panelHtml.includes("data-route-enabled"), "route chain card carries a data-route-enabled toggle");
    const m = panelHtml.match(/<label class="toggle"[^>]*>[\s\S]*?data-route-enabled[\s\S]*?<\/label>/);
    assert.ok(m, "toggle uses the existing .toggle switch control");
  });

  it("开关变更打到 /api/store/route-chain/enabled", () => {
    assert.ok(panelHtml.includes("/api/store/route-chain/enabled"), "toggle posts to the enabled API");
  });
});

describe("panel.html 渠道列表拖拽重排（DnD + FLIP + 皮肤差分）", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("renderStoreList 渠道行/池行在非过滤态带 draggable，过滤态不带", () => {
    const m = panelHtml.match(/function renderStoreList\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "renderStoreList found");
    assert.ok(m[1].includes('draggable="true"'), "rows render draggable attribute");
    assert.ok(m[1].includes("storeListDraggable"), "draggable gated on filter input state");
  });

  it("drop 按 DOM 现序展开池成员并提交 /api/store/reorder", () => {
    assert.ok(panelHtml.includes("/api/store/reorder"), "reorder API call exists");
    const m = panelHtml.match(/\/api\/store\/reorder",\s*\{\s*order\s*\}/);
    assert.ok(m, "reorder posts {order}");
  });

  it("dragend 置位 suppressStoreClick，click 委托吞掉拖拽后的合成点击", () => {
    assert.ok(panelHtml.includes("suppressStoreClick"), "suppressStoreClick flag exists");
    const m = panelHtml.match(/\$\("storeList"\)\.addEventListener\("click", \(e\) => \{([\s\S]*?)\n    \}\);/);
    assert.ok(m, "storeList click delegate found");
    assert.ok(m[1].includes("suppressStoreClick"), "click delegate swallows the click after drag");
  });

  it("5 个皮肤段（默认/saas/aurora/blueprint/sepia）均定义 --store-drag-accent", () => {
    assert.match(panelHtml, /:root \{[\s\S]*?--store-drag-accent:/, "default :root defines --store-drag-accent");
    for (const skin of ["saas", "aurora", "blueprint", "sepia"]) {
      const re = new RegExp(`:root\\[data-style="${skin}"\\] \\{[\\s\\S]*?--store-drag-accent:`);
      assert.ok(re.test(panelHtml), `${skin} skin defines --store-drag-accent`);
    }
  });

  it("reduced-motion 时跳过 FLIP（matchMedia 短路）", () => {
    const m = panelHtml.match(/function storeDragReducedMotion\(\) \{([\s\S]*?)\}/);
    assert.ok(m, "storeDragReducedMotion helper exists");
    assert.ok(m[1].includes('matchMedia("(prefers-reduced-motion: reduce)")'), "matchMedia reduce check");
  });

  it("dragover 不挪行不做行 FLIP：列表静止，只更新指示线槽位", () => {
    const m = panelHtml.match(/addEventListener\("dragover", \(e\) => \{([\s\S]*?)addEventListener\("drop"/);
    assert.ok(m, "dragover handler found");
    assert.ok(!m[1].includes("insertBefore"), "dragover must not move rows");
    assert.ok(!m[1].includes("translateY(${dy}"), "dragover must not FLIP rows");
    assert.ok(m[1].includes("store-drop-indicator") || m[1].includes("Indicator"), "dragover updates the indicator");
    assert.ok(m[1].includes("scrollTop"), "dragover auto-scrolls near the list's top/bottom edge");
  });

  it("drop 一次性重排：DOM 应用新顺序 + 全列表 FLIP（260ms store-drag-ease）", () => {
    const m = panelHtml.match(/addEventListener\("drop", \(e\) => \{([\s\S]*?)addEventListener\("dragend"/);
    assert.ok(m, "drop handler found");
    assert.ok(m[1].includes("insertBefore"), "drop applies the new order in DOM");
    assert.ok(m[1].includes("260ms var(--store-drag-ease)"), "drop FLIP uses 260ms skin easing");
    assert.ok(m[1].includes("store-row-landed"), "landed row pulses");
  });

  it("dragend 只清理态，不再 renderStoreList 恢复（拖动中 DOM 未变）", () => {
    const m = panelHtml.match(/addEventListener\("dragend", \(\) => \{([\s\S]*?)\n    \}\);/);
    assert.ok(m, "dragend handler found");
    assert.ok(!m[1].includes("renderStoreList"), "dragend must not re-render");
    assert.ok(m[1].includes("suppressStoreClick"), "click suppression kept");
  });

  it("空位占位 + 加重指示线（绝对定位/3px/槽间瞬移/左端圆帽）样式齐备", () => {
    const drag = panelHtml.match(/\.store-row-dragging \{([\s\S]*?)\}/);
    assert.ok(drag, "dragging row style exists");
    assert.ok(drag[1].includes("dashed var(--store-drag-accent)"), "placeholder uses dashed accent inset");
    const ind = panelHtml.match(/\.store-drop-indicator \{([\s\S]*?)\}/);
    assert.ok(ind, "drop indicator style exists");
    assert.ok(ind[1].includes("position: absolute"), "indicator absolutely positioned");
    assert.ok(ind[1].includes("3px"), "indicator is 3px heavy");
    assert.ok(!ind[1].includes("transition"), "indicator jumps between slots instantly (no glide transition)");
    assert.ok(panelHtml.includes(".store-drop-indicator::before"), "left round cap exists");
    assert.ok(panelHtml.includes(".store-row-landed"), "landed highlight style exists");
    const bp = panelHtml.match(/:root\[data-style="blueprint"\] \.store-drop-indicator \{([\s\S]*?)\}/);
    assert.ok(bp, "blueprint overrides drop indicator");
    assert.ok(bp[1].includes("repeating-linear-gradient"), "blueprint indicator is dashed");
  });
});

describe("panel.html per-instance telemetry TTFT sparkline", () => {
  // 回归（dd61b99 多实例化重构）：端点级四宫格删除后，实例级四宫格只接回了
  // 生成速度/缓存命中率两条 sparkline，「首字响应时间」折线图从 kimi/opencode/
  // pi 三栏消失。以下断言钉住容器、缓冲、绘制三个环节。
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("gives the per-instance 首字响应时间 card its own sparkline container", () => {
    assert.ok(/const sparkTtftId = prefix \+ "InstSparkTtft-" \+ domId;/.test(panelHtml),
      "renderInstanceRows derives a stable InstSparkTtft id");
    assert.ok(/首字响应时间<\/span>\s*<div class="telemetry-sparkline" id="\$\{sparkTtftId\}"><\/div>/.test(panelHtml),
      "TTFT card header carries the telemetry-sparkline div");
  });

  it("records and draws TTFT history in the per-instance spark buffer", () => {
    assert.ok(/instanceSparkBuffers\[key\] = \{ tps: \[\], cache: \[\], ttft: \[\] \}/.test(panelHtml),
      "buffer allocation includes a ttft array");
    assert.ok(/pushOne\(buf\.ttft, vals \? vals\.ttft : null\);/.test(panelHtml),
      "pushInstanceSpark feeds ttft samples");
    assert.ok(/ttft: typeof ttft === "number" && ttft > 0 \? ttft \/ 1000 : null,/.test(panelHtml),
      "renderInstanceRows pushes lastTtftMs in seconds (endpoint-level unit parity)");
    // 2026-09-01 折叠门控调和：绘制收进 if (open)，权威历史暂存到 buf.sparkHistory
    // （折叠期间无 inst 可用），两条路径口径见 panel-instance-fold.test.mjs。
    assert.ok(/updateSparkline\(sparkTtftId, sparkValues\(buf\.ttft, buf\.sparkHistory\?\.ttft\)\);/.test(panelHtml),
      "sparkline redraws each render, seeded from buffer-stashed authoritative history");
  });
});

describe("panel.html 实例行状态徽标恒为生成中/待命（不随链归因换装）", () => {
  // 撤销（2026-09-08）：实例行曾按链归因把绿色「生成中」换成号池紫「自动路由中」。
  // 「这条请求走没走自动路由」只由端点模型胶囊上的 auto 角标表达，状态徽标回到
  // 生成中/待命两态；伪「全局汇总」行依旧不挂状态徽标。此处钉住不再换装。
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  function makeRenderStateBadge() {
    // 截「const stateBadge = 」到语句末（模板串内无分号，首个 ; 即语句尾），
    // 整段三元（含 isAggregate 空串分支）作为表达式求值
    const m = panelHtml.match(/const stateBadge = (isAggregate[\s\S]*?);/);
    assert.ok(m, "instance-row state badge expression found");
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
    const m = panelHtml.match(/function renderInstanceRows\(\{ prefix, listEl, instances, aggregateFallback \}\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "renderInstanceRows found in panel.html");
    assert.ok(!/instViaAuto|自动路由中/.test(m[0]), "no chain-attribution branch left in the instance-row renderer");
  });
});

describe("panel.html 设置弹窗齿轮图标完整性", () => {
  // 回归（2026-09-07）：设置弹窗标题的齿轮 path 曾缺一段双弧线段
  // （a2 2 0 0 1 -2.83 0 2 2 0 0 1），齿形塌陷、图标歪斜。钉住弹窗齿轮与
  // 页头齿轮（视觉正确基准）path 完全一致，防止再被不完整粘贴破坏。
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("settingsModal 标题齿轮 path 与页头设置按钮齿轮 path 完全一致", () => {
    const paths = [...panelHtml.matchAll(/M19\.4 15a1\.65[^"]+/g)].map((m) => m[0]);
    assert.ok(paths.length >= 2, "header + modal gear paths both present");
    assert.equal(new Set(paths).size, 1, "every gear render uses the identical intact path");
    // 该弧段是齿轮左下齿的双弧连接，缺失即塌齿
    assert.ok(paths[0].includes("a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83"), "gear arc segment present");
  });
});
describe("panel.html 结构完整性（防 read 截断污染回写）", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("文件不含工具截断标记（超长行必须原样保留，img/path 数据不得被替换为占位文本）", () => {
    assert.ok(!panelHtml.includes("(line truncated to 2000 chars)"),
      "base64 行曾被 read 工具截断产物污染，导致头像 img src 损坏、监测卡标题错乱");
  });

  it("监测页八个端点卡的头像区结构配对完整（avatar/headings 成对、无跨标签吞并）", () => {
    assert.equal((panelHtml.match(/class="agent-avatar"/g) || []).length, 8, "8 个 agent-avatar");
    assert.equal((panelHtml.match(/class="agent-headings"/g) || []).length, 8, "8 个 agent-headings");
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
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("陈旧判定 helper：lastSeen 超 INSTANCE_STALE_MS（2min）为陈旧，active 豁免", () => {
    assert.ok(/const INSTANCE_STALE_MS = 2 \* 60 \* 1000;/.test(panelHtml),
      "stale threshold pinned at 2 minutes");
    const m = panelHtml.match(/function isInstanceStale\(inst\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "isInstanceStale helper exists");
    assert.ok(m[1].includes('inst.status === "active"'), "active instances never stale");
    assert.ok(m[1].includes("inst.lastSeen"), "reads inst.lastSeen");
    assert.ok(m[1].includes("INSTANCE_STALE_MS"), "compares against INSTANCE_STALE_MS");
  });

  it("聚合伪实例行透出 sessions[0].lastSeen 参与同一陈旧判定", () => {
    const m = panelHtml.match(/function buildAggregateFallback\(m, d, isGenerating\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "buildAggregateFallback exists");
    assert.ok(/lastSeen: typeof sess\.lastSeen === "number" \? sess\.lastSeen : null,/.test(m[1]),
      "aggregate fallback carries lastSeen (aggregate bucket is TTL-less residue)");
  });

  it("陈旧行四宫格：速率类三格压暗置 —，工时卡不动，无额外注释行", () => {
    assert.ok(/const stale = isInstanceStale\(inst\);/.test(panelHtml), "renderInstanceRows computes stale");
    assert.ok(/const staleCls = stale \? " inst-stale" : "";/.test(panelHtml), "stale class prepared");
    assert.ok(/<div class="telemetry-card\$\{staleCls\}">\s*<div class="telemetry-header">\s*<span class="telemetry-label">生成速度<\/span>/.test(panelHtml),
      "tps card dimmed when stale");
    assert.ok(/<span>\$\{!stale && tps > 0 \? tps\.toFixed\(1\) : "-"\}<\/span>/.test(panelHtml),
      "stale tps renders as dash");
    assert.ok(/<span>\$\{!stale && ttft > 0 \? \(ttft \/ 1000\)\.toFixed\(2\) : "-"\}<\/span>/.test(panelHtml),
      "stale ttft renders as dash");
    assert.ok(/<span>\$\{!stale && typeof hit === "number" \? hit\.toFixed\(1\) : "-"\}<\/span>/.test(panelHtml),
      "stale cache hit rate renders as dash");
    assert.ok(!panelHtml.includes("instance-stale-note"), "grid tail annotation removed");
  });

  it("陈旧行简要胶囊行：速率类胶囊换成相对时间胶囊（「X 分钟前」），工时胶囊保留", () => {
    assert.ok(/<span class="tag-bubble tag-stale">\$\{formatRelativeAge\(inst\.lastSeen\)\}<\/span>/.test(panelHtml),
      "tags line swaps rate bubbles for a bare relative-age bubble");
  });

  it("陈旧行折线停绘：渲染期 if (open && !stale) 门控 + 展开补绘跳过 data-stale 行", () => {
    assert.ok(/if \(open && !stale\) \{[\s\S]*?updateSparkline\(sparkTpsId/.test(panelHtml),
      "render-time sparkline draw gated on !stale");
    assert.ok(/grid\.dataset\.stale = stale \? "1" : "0";/.test(panelHtml), "grid carries data-stale flag");
    assert.ok(/if \(grid\.dataset\.stale === "1"\) return;/.test(panelHtml),
      "redrawInstanceSparklines skips stale grids");
  });

  it("相对时间标注随时间刷新：renderIfChanged 指纹混入陈旧分钟桶", () => {
    assert.ok(/function agentStaleTick\(agent\) \{/.test(panelHtml), "agentStaleTick exists");
    assert.ok(/agentStaleTick\(agent\) \+ "\|" \+ JSON\.stringify\(agent\)/.test(panelHtml),
      "fingerprint mixes the stale minute tick so 「X 前」 refreshes at most once a minute");
  });

  it("陈旧态样式齐备：整卡压暗 + 虚线陈旧胶囊（无格尾注释样式）", () => {
    assert.ok(/\.telemetry-card\.inst-stale \{ opacity: 0\.45; \}/.test(panelHtml), "stale card dimmed");
    assert.ok(!/\.instance-stale-note/.test(panelHtml), "note style removed with the note element");
    assert.ok(/\.tag-bubble\.tag-stale \{/.test(panelHtml), "stale bubble style exists");
  });
});

describe("panel.html 静态卡（zc/dsh/reasonix）端点级陈旧语义", () => {
  // 与实例行同口径：全局汇总行 lastSeen 超 INSTANCE_STALE_MS 即陈旧——速率类置 —
  // 压暗、折线停绘、简要栏换相对时间胶囊；累计量（工时/tokens/请求数）不动。
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("端点级判定 helper：isEndpointStale 读 sessions[0].lastSeen，生成中豁免", () => {
    const m = panelHtml.match(/function isEndpointStale\(agent, isGenerating\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "isEndpointStale exists");
    assert.ok(m[1].includes("if (isGenerating) return false;"), "generating endpoints never stale");
    assert.ok(m[1].includes("s0.lastSeen"), "reads 全局汇总行 lastSeen");
    assert.ok(m[1].includes("INSTANCE_STALE_MS"), "same threshold as instance rows");
  });

  it("四个静态渲染函数同口径接线：判定 + 置位 flag + 压暗 + staleText + 停绘", () => {
    for (const [fnName, prefix, arg] of [["renderZcode", "zc", "z"], ["renderDsh", "dsh", "d"], ["renderReasonix", "reasonix", "p"], ["renderQoder", "qoder", "p"]]) {
      const m = panelHtml.match(new RegExp("function " + fnName + "\\(" + arg + "\\) \\{[\\s\\S]*?\\n  \\}"));
      assert.ok(m, fnName + " found");
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
    const m = panelHtml.match(/function redrawEndpointSparklines\(prefix\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "redrawEndpointSparklines found");
    assert.ok(m[1].includes("if (endpointStaleFlags[prefix]) return;"), "stale endpoints skip drawing");
  });

  it("updateDetailBrief 支持 staleText：隐藏速率类胶囊、显示相对时间胶囊", () => {
    const m = panelHtml.match(/function updateDetailBrief\(prefix, \{([\s\S]*?)\n  \}/);
    assert.ok(m, "updateDetailBrief found");
    assert.ok(m[0].includes("staleText"), "accepts staleText");
    assert.ok(m[0].includes('setPill("BriefStale", staleMode'), "drives the stale pill");
    assert.ok(m[0].includes('setPill("BriefTps", !staleMode && tps !== null'), "rate pills hidden in stale mode");
    assert.ok(!/setPill\("BriefTps", [^,]+, `\$\{tps\.toFixed/.test(m[0]),
      "rate pill html no longer eager-evaluated (null-safe)");
  });

  it("四张静态卡的简要栏都有 tag-stale 相对时间胶囊", () => {
    for (const prefix of ["zc", "dsh", "reasonix", "qoder"]) {
      assert.ok(
        new RegExp(`<span class="tag-bubble tag-stale" id="${prefix}BriefStale" hidden></span>`).test(panelHtml),
        prefix + "BriefStale pill exists");
    }
  });
});
describe("panel.html 静态卡（zc/dsh/reasonix/qoder）收起态简要栏与多实例实例行同范式", () => {
  // 收起态主信息栏对齐多实例端点实例行：名称行挂请求数徽标、名称行下挂 tokens 行
  // （Prompt/Completion/Cached），「全局汇总」行改仅展开态显示（避免同数据双行并存）。
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("四张静态卡简要栏：名称行挂请求数徽标 + tokens 行（Prompt/Completion/Cached）", () => {
    for (const prefix of ["zc", "dsh", "reasonix", "qoder"]) {
      assert.ok(
        new RegExp(`<span class="badge badge-neutral" id="${prefix}BriefReqs">0 请求</span>`).test(panelHtml),
        prefix + "BriefReqs badge exists");
      assert.ok(
        new RegExp(`<div class="session-tokens-line" id="${prefix}BriefTokens">Prompt: 0 · Completion: 0 · Cached: 0</div>`).test(panelHtml),
        prefix + "BriefTokens line exists");
    }
  });

  it("updateDetailBrief 驱动请求数徽标与 tokens 行（累计量，不受 staleMode 门控）", () => {
    const m = panelHtml.match(/function updateDetailBrief\(prefix, \{([\s\S]*?)\n  \}/);
    assert.ok(m, "updateDetailBrief found");
    assert.ok(m[0].includes("requests"), "accepts requests");
    assert.ok(m[0].includes("tokensText"), "accepts tokensText");
    assert.ok(m[0].includes('$(prefix + "BriefReqs")'), "drives the requests badge");
    assert.ok(m[0].includes('$(prefix + "BriefTokens")'), "drives the tokens line");
    assert.ok(m[0].includes("`${requests || 0} 请求`"), "badge text matches instance-row 「N 请求」 wording");
  });

  it("四个静态渲染函数把 tokens/请求数接入 updateDetailBrief（tokens 先于调用声明）", () => {
    for (const [fnName, arg, totalReq] of [["renderZcode", "z", "z.totalRequests"], ["renderDsh", "d", "d.totalRequests"], ["renderReasonix", "p", "p.totalRequests"], ["renderQoder", "p", "p.totalRequests"]]) {
      const m = panelHtml.match(new RegExp("function " + fnName + "\\(" + arg + "\\) \\{[\\s\\S]*?\\n  \\}"));
      assert.ok(m, fnName + " found");
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
    const m = panelHtml.match(/\["zc", "dsh", "reasonix", "qoder"\]\.forEach\(\(prefix\) => \{[\s\S]*?\n  \}\);/);
    assert.ok(m, "static fold wiring found");
    assert.ok(m[0].includes('$(prefix + "SessionRow")'), "resolves the aggregate row");
    assert.ok(m[0].includes('closest(".session-table-wrapper")'), "toggles the wrapper");
    assert.ok(m[0].includes("if (aggWrap) aggWrap.hidden = !open;"), "collapsed hides the aggregate row");
  });
});


describe("panel.html stats tab 竞态守卫 / 动画收尾 / 图例持久化 / a11y", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("refreshStatsState 丢弃旧响应：请求序号 + 响应 days 双比对", () => {
    const m = panelHtml.match(/async function refreshStatsState\(opts\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "refreshStatsState found");
    const body = m[1];
    assert.ok(panelHtml.includes("let statsReqSeq = 0"), "req seq counter declared");
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
    const m = panelHtml.match(/function leaveStatsView\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "leaveStatsView found");
    const body = m[1];
    assert.ok(body.includes("clearInterval(statsTimer)"), "30s poll cleared");
    assert.ok(body.includes("statsTrendChart"), "trend chart visited");
    assert.ok(body.includes("statsUsageDonut"), "donut visited");
    assert.ok(body.includes("cancelAnimationFrame"), "in-flight rAF cancelled");
    assert.ok(body.includes("_statsAnim"), "trend morph/reveal state cleared");
    assert.ok(body.includes("_usageRaf"), "donut reveal state cleared");
  });

  it("环形图揭示动画每次进 tab 重播（enterStatsView 重置标记，与趋势图 reveal 同语义）", () => {
    const m = panelHtml.match(/function enterStatsView\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "enterStatsView found");
    assert.ok(m[1].includes("statsUsageRevealed = false"), "reveal flag reset on tab enter");
    assert.ok(m[1].includes("statsTrendPrev = null"), "trend reveal reset preserved");
  });

  it("趋势图切口径 seg：重置 reveal 标记走清屏生长，不走 morph；days seg 维持 morph", () => {
    const m = panelHtml.match(/function initStatsTab\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "initStatsTab found");
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
    const trend = panelHtml.match(/function renderStatsTrend\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(trend, "renderStatsTrend found");
    assert.ok(trend[1].includes('statsTrendPrev ? { type: "morph" } : { type: "reveal" }'),
      "anim decision: morph only when a previous frame exists, otherwise reveal");
  });

  it("揭示收尾清 _usageRaf 句柄，守卫只挡静默重渲（seg 点击 replay 放行）", () => {
    const m = panelHtml.match(/function renderStatsUsage\(opts\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "renderStatsUsage found");
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
    const m = panelHtml.match(/function renderStatsUsage\(opts\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "renderStatsUsage found");
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
    const bm = panelHtml.match(/function appendStatsUsageBars\(([\s\S]*?)\n  \}/);
    assert.ok(bm, "appendStatsUsageBars found");
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
    const fn = panelHtml.match(/function renderStatsLineChart\(container, cfg, anim\) \{([\s\S]*?)\n  \}/);
    assert.ok(fn, "renderStatsLineChart found");
    const head = fn[1];
    // 守卫必须在取消在飞 rAF 之前（否则动画已被杀，跳过无意义）
    const guardIdx = head.indexOf("renderStatsTrendSignature(cfg)");
    const cancelIdx = head.indexOf("cancelAnimationFrame(prevAnim.raf)");
    assert.ok(guardIdx !== -1, "same-target guard present in renderer head");
    assert.ok(cancelIdx !== -1 && guardIdx < cancelIdx,
      "guard runs before cancelling the in-flight rAF");
    // 签名函数存在且覆盖轴与系列（值含在 series.values）
    assert.ok(panelHtml.includes("function renderStatsTrendSignature(cfg)"),
      "signature helper defined");
    // 守卫成立路径：直接 return，不重建 DOM（textContent 清空在守卫之后）
    const after = head.slice(guardIdx, guardIdx + 400);
    assert.ok(/return;/.test(after), "guard short-circuits with plain return");
  });

  it("morph/reveal 进行中 hover 十字线与 tooltip 隐藏（终态坐标不再与曲线错位）", () => {
    const m = panelHtml.match(/overlay\.addEventListener\("mousemove", \(e\) => \{([\s\S]*?)\n    \}\);/);
    assert.ok(m, "mousemove handler found");
    const body = m[1];
    const guardIdx = body.indexOf("container._statsAnim");
    const useIdx = body.indexOf("X(idx)");
    assert.ok(guardIdx !== -1 && useIdx !== -1 && guardIdx < useIdx,
      "in-flight animation guard runs before final-state coordinates are used");
    assert.ok(body.includes('tip.style.display = "none"'), "tooltip hidden while animating");
  });

  it("图例隐藏集 prune + 持久化到 localStorage（panel-stats-legend 并列键）", () => {
    assert.ok(panelHtml.includes('"panel-stats-legend"'), "legend persistence key used");
    assert.ok(panelHtml.includes("function saveStatsLegend()"), "saveStatsLegend defined");
    const trend = panelHtml.match(/function renderStatsTrend\(\) \{([\s\S]*?)\n  \}/);
    const usage = panelHtml.match(/function renderStatsUsage\(opts\) \{([\s\S]*?)\n  \}/);
    assert.ok(trend && usage, "both renderers found");
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
    const load = panelHtml.match(/function loadStatsPrefs\(\) \{([\s\S]*?)\n  \}/);
    const save = panelHtml.match(/function saveStatsLegend\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(load && save, "load/save functions found");
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
    const m = panelHtml.match(/function switchView\(name\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "switchView found");
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
    assert.ok(!panelHtml.includes('document.createElement("span");\n      chip.className = "stats-legend-item"'),
      "trend legend chip no longer a span");
    assert.ok(panelHtml.includes('document.createElement("button")'), "legend items are buttons");
    assert.ok(panelHtml.includes('ariaLabel: "Token 趋势图"'), "trend chart aria-label wired");
    assert.ok(panelHtml.includes('ariaLabel: "首字响应 TTFT 趋势图"'), "ttft chart aria-label wired");
    assert.ok(panelHtml.includes('aria-label", "模型用量环形图"'), "donut svg aria-label wired");
    assert.ok(panelHtml.includes('svg.setAttribute("role", "img")'), "svg role=img set");
  });

  it("卡片口径标注副标就位，死样式与过期注释已清", () => {
    // 卡头标注只留在确有误读风险的卡（TPS）；今日概览与趋势卡头不设标注
    //（今日口径与滚动窗口属默认读法，用户拍板删除）。稳定性卡已整卡移除。
    for (const note of [
      "仅统计流式请求",
    ]) {
      assert.ok(panelHtml.includes(`<span class="stats-card-note">${note}</span>`), "note: " + note);
    }
    assert.ok(!panelHtml.includes("成功率不含用户取消"), "stability card note gone with the card");
    for (const dropped of [
      "今日自然日口径",
      "按过去 24h / 7 日滚动窗口统计",
    ]) {
      assert.ok(!panelHtml.includes(dropped), "dropped note really gone: " + dropped);
    }
    // 取消口径下沉到成功率行标签。
    assert.ok(panelHtml.includes("成功率（不含取消）"), "success-rate row carries the exclude-cancel caveat");
    assert.ok(!panelHtml.includes(".stats-usage-grid"), "dead .stats-usage-grid CSS removed");
    assert.ok(!panelHtml.includes("图表 tab[柱状图/环形图]"), "stale chart-tab comment removed");
    assert.ok(!panelHtml.includes('<section class="skills-view stats-view"'),
      "unreferenced .skills-view class dropped from statsView");
    assert.ok(panelHtml.includes('<span class="badge badge-neutral">近 90 天</span>'), "heatmap 90-day badge kept as its annotation");
  });
});

describe("panel.html claude 全局汇总行（与其他多实例栏同范式）", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
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
    const m = panelHtml.match(/function renderClaude\(c\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "renderClaude found");
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

  it("claudeAggregateMetrics 求和口径：累加项、prompt 加权缓存、最近会话 TTFT", () => {
    const m = panelHtml.match(/function claudeAggregateMetrics\(sessions\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "claudeAggregateMetrics exists");
    assert.ok(m[1].includes("tokens.prompt += tk.prompt || 0;"), "tokens 累加");
    assert.ok(m[1].includes("totalRequests += s.requests || 0;"), "请求数累加");
    assert.ok(m[1].includes("durationMs += s.activeDurationMs || 0;"), "工时累加");
    assert.ok(m[1].includes("if (typeof s.tps === \"number\" && s.tps > 0) tpsSum += s.tps;"), "tps 为各会话之和");
    assert.ok(m[1].includes("tokens.cached / tokens.prompt"), "缓存命中率按 prompt 加权");
    assert.ok(m[1].includes("(seen || 0) >= ttftSeen"), "TTFT 取最近有活动的会话");
  });
});

describe("panel.html 行 hover 高亮移除", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("全局汇总行与实例 title 行（同为 .session-row）不再有鼠标悬浮高亮", () => {
    assert.ok(!panelHtml.includes(".session-row:hover"), ".session-row:hover 高亮规则已删除");
    assert.ok(!panelHtml.includes(".session-name-line:hover"), "session-name-line 无独立 hover 规则");
  });
});


describe("panel.html 预设管理 tab", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
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

  it("extends switchView / restoreView / init for the presets view without regressing others", () => {
    const m = panelHtml.match(/function switchView\(name\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "switchView found");
    const body = m[1];
    assert.ok(body.includes('name === "presets"'), "presets branch added");
    assert.ok(body.includes('$("presetsView").hidden = !presets'), "presetsView visibility wired");
    assert.ok(body.includes('$("tabPresets").classList.toggle("active", presets)'), "tabPresets active state wired");
    assert.ok(body.includes('["tabPresets", presets]'), "aria-selected sync covers tabPresets");
    assert.ok(body.includes("refreshPresetsState()"), "entering presets refreshes state");
    assert.ok(body.includes('$("skillsView").hidden = !(name === "skills")'), "skills view still exclusive");
    assert.ok(body.includes("refreshSkillsState()"), "skills refresh preserved");
    assert.ok(body.includes("refreshStoreState()"), "store refresh preserved");
    assert.ok(panelHtml.includes("initPresetsTab();"), "initPresetsTab runs during init");
    assert.ok(panelHtml.includes('$("tabPresets").onclick = () => switchView("presets")'), "tabPresets click wired");
    const r = panelHtml.match(/function restoreView\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(r, "restoreView found");
    assert.ok(r[1].includes('saved === "presets"'), "presets branch added");
    assert.ok(r[1].includes('saved === "skills"'), "skills branch preserved");
    assert.ok(r[1].includes('saved === "store"'), "store branch preserved");
    assert.ok(r[1].includes('saved === "stats"'), "stats branch preserved");
  });

  it("list rows reuse the skills row template plus a per-preset length badge; header meter painted", () => {
    const m = panelHtml.match(/function renderPresetsList\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "renderPresetsList found");
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
    const m = panelHtml.match(/function renderPresetDetail\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "renderPresetDetail found");
    const body = m[1];
    assert.ok(body.includes("endpoints.map((ep) =>"), "one row per endpoint (8 from state)");
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
    const m = panelHtml.match(/function showPresetFormModal\(preset, values, errorMsg\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "showPresetFormModal found");
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
    assert.ok(panelHtml.includes('api("GET", "/api/prompts/state")'), "state GET");
    for (const p of [
      "/api/prompts/master",
      "/api/prompts/preset/delete",
      "/api/prompts/preset/enable",
      "/api/prompts/override",
    ]) {
      assert.ok(panelHtml.includes(`"${p}"`), `missing endpoint ${p}`);
    }
    assert.ok(!/api\("(?:GET|POST)", "\/panel\//.test(panelHtml),
      "api() paths must not carry the /panel prefix (double-prefix 404 regression)");
    // 串行刷新链（防乱序），与 skills 同模式
    assert.ok(panelHtml.includes("presetsRefreshChain"), "serialized refresh chain");
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
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("恢复轮询独立成链且不受 document.hidden 门控", () => {
    assert.ok(panelHtml.includes("function watchPanelHostComeBack()"), "独立的恢复轮询");
    assert.ok(panelHtml.includes("PANEL_RESTART_POLL_MS"), "恢复轮询自带节奏常量");
    const recoveryStart = panelHtml.indexOf("function watchPanelHostComeBack()");
    const recovery = panelHtml.slice(recoveryStart, panelHtml.indexOf("if (stopConfirmBtn)", recoveryStart));
    assert.ok(recovery.length > 500, "恢复逻辑体必须真的被抓取到，否则下面的断言全是空过");
    assert.ok(!recovery.includes("document.hidden"),
      "带 hidden 门控的话，用户点完重启切走标签页就永远检测不到换新");
    assert.ok(recovery.includes("location.reload()"), "新进程接管后重载页面，前端 JS 与后端同版本");
    assert.ok(recovery.includes("identity.pid !== before.pid"), "以 pid 变化判定新进程");
    assert.ok(recovery.includes("identity.startTime !== before.startTime"), "startTime 作为辅助身份信号");
  });

  it("panelRestarting 同时压住徽标误报与按钮重新启用", () => {
    assert.ok(panelHtml.includes("let panelRestarting = false;"));
    // 徽标：refreshStatus 的 catch 在窗口内不得改判
    assert.ok(/if \(panelRestarting\) return;\s*\n\s*\$\("topDot"\)\.className = "pulse-dot stopped";/.test(panelHtml),
      "面板重启期间 47820 不可达是预期，不能把徽标写成「Relay 未运行」");
    // 按钮：1s 轮询会重新调用 updateRelayControls，不拦住恢复期能再点一次重启
    assert.ok(/function updateRelayControls\(relay\) \{[\s\S]{0,600}?if \(panelRestarting\) \{[\s\S]{0,200}?return;\s*\}/.test(panelHtml),
      "updateRelayControls 必须在重启窗口内按住两个按钮后直接返回");
  });

  it("面板重启请求用裸 fetch，区分连接掐断与服务端拒绝", () => {
    const execStart = panelHtml.indexOf("async function executeRestartRelay()");
    const exec = panelHtml.slice(execStart, panelHtml.indexOf("function watchPanelHostComeBack()", execStart));
    assert.ok(exec.length > 500, "executeRestartRelay 体必须真的被抓取到，否则下面的断言全是空过");
    assert.ok(exec.includes('fetch(API_BASE + "/api/panel-host/restart"'),
      "api() 把「响应被退出掐断」和「403/409/500 明确拒绝」都抛成同一种 Error");
    assert.ok(!exec.includes('api("POST", "/api/panel-host/restart"'), "不得改用 api() 打这个端点");
    assert.ok(exec.includes("restartStarted = true;"), "连接中断按「重启已开始」处理");
    assert.ok(exec.includes('api("POST", "/api/relay/restart")'), "relay 仍是第一段，失败即终止");
  });

  it("重启窗口复播开屏：确认即盖屏，失败与超时显式收回", () => {
    assert.ok(panelHtml.includes("window.panelStartupBegin"), "开屏复播入口由 head 内联脚本暴露");
    assert.ok(panelHtml.includes("function panelStartupPlay()"), "开屏动画必须是可重复调用的函数");
    const execStart = panelHtml.indexOf("async function executeRestartRelay()");
    const exec = panelHtml.slice(execStart, panelHtml.indexOf("function watchPanelHostComeBack()", execStart));
    assert.ok(exec.includes("playStartupSplash()"), "确认重启后立刻复播开屏盖住页面");
    assert.equal(exec.split("dropStartupSplash()").length - 1, 2,
      "relay 换新失败与面板换新被拒两条失败路径都要收回开屏");
    const recoveryStart = panelHtml.indexOf("function watchPanelHostComeBack()");
    const recovery = panelHtml.slice(recoveryStart, panelHtml.indexOf("if (stopConfirmBtn)", recoveryStart));
    assert.ok(recovery.includes("dropStartupSplash()"), "恢复超时路径也要收回开屏");
    assert.ok(!recovery.includes("playStartupSplash()"), "恢复期不得重复盖屏");
  });

  it("launcher 启动固定落看板页，刷新仍恢复上次 tab", () => {
    assert.ok(panelHtml.includes("window.panelStartupLaunch = true"), "标记只在 launcher URL 路径打点");
    const restoreStart = panelHtml.indexOf("function restoreView()");
    const restore = panelHtml.slice(restoreStart, panelHtml.indexOf("function reconcileSkillsSelection()", restoreStart));
    assert.ok(restore.length > 100, "restoreView 体必须真的被抓取到，否则下面的断言全是空过");
    assert.ok(restore.includes("if (window.panelStartupLaunch) return;"), "launcher 首开跳过恢复固定看板");
    assert.ok(restore.includes('localStorage.getItem("panel-view")'), "刷新与普通访问仍按 panel-view 恢复");
  });
});
