import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPanelRouter, startRelayActivityBridge } from "./panel.mjs";
import { TERMINAL_CONVERSATION_BINDINGS_FILE } from "./terminal-conversation-bindings.mjs";
import { createLogger } from "./logger.mjs";
import { createLoggingEnabledGate, saveSettings } from "./relay-settings.mjs";
import { AGENT_TERMINAL_TARGETS } from "./agent-session-env.mjs";
import { getTtftColor } from "./agent-metrics.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";

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
    fetchTerminalHostStatus: async () => null,
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
// 回放突发合并器的阈值常量：沙箱按函数名切源码，常量不在其中，单独取出注入——
// 测试不抄数字，改阈值时行为钉跟着变。
const terminalBurstConsts = ["TERMINAL_BURST_ENTER_BYTES", "TERMINAL_BURST_QUIET_MS", "TERMINAL_BURST_MAX_HOLD_MS", "TERMINAL_BURST_MAX_BYTES"]
  .map((name) => {
    const found = panelJs.match(new RegExp(`const ${name} = [^;]+;`))?.[0];
    assert.ok(found, `${name} 可从 panel.js 取到`);
    return found;
  })
  .join("\n");
const panelMjs = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "panel.mjs"),
  "utf8",
);
const terminalHostJs = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "terminal-host.mjs"),
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

  // ── 看板首帧闸（2026-10-07 报障：从页面出现到加载出数据之间，卡面把「还没取到数」
  // 画成「什么都没跑」）── frame.ready 是看板唯一能据以开口的字段：真快照 / 可续的陈旧
  // 快照 / relay 真停了时的本地收集器都算 ready；relay 活着只是这一拍没答上、且手里没有
  // 可续快照时宁可不给数据。前端据此决定 data-board 是 pending（骨架条）还是 live。
  it("GET /panel/api/agents marks a pulled frame ready with its source", async () => {
    const pulled = [{ id: "zcode", status: "running", metrics: { totalRequests: 5 } }];
    const router = routerWith({ pulledAgents: pulled });
    const { req, res, json } = fakeReqRes("/panel/api/agents", "GET");
    await router.handle(req, res);
    assert.deepEqual(json().frame, { ready: true, source: "relay" });
  });

  it("GET /panel/api/agents answers not-ready instead of substituting the zero-traffic collector on a pull timeout", async () => {
    let localAsked = false;
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, aliasResolver: null, aliasPath: null,
      metricsCollector: { getAgentsStatus: async () => { localAsked = true; return [{ id: "claude", status: "running" }]; } },
      // 面板自己那 1500ms 预算撞上 relay 冷探针时，真实现返回超时标记（不是 null）。
      fetchRelayAgents: async () => ({ pullTimeout: true }),
    });
    const { req, res, json } = fakeReqRes("/panel/api/agents", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json().agents, [], "没有可续快照时不发一份看起来像数据的空壳");
    assert.equal(json().frame.ready, false);
    assert.equal(json().frame.reason, "relay-timeout");
    assert.equal(localAsked, false, "relay 活着，绝不拿不经流量的本地收集器顶这一帧");
  });

  it("GET /panel/api/agents keeps serving the last pull across a pull timeout", async () => {
    const pulled = [{ id: "qoder", status: "running", metrics: { totalRequests: 67 } }];
    let answer = pulled;
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, aliasResolver: null, aliasPath: null,
      metricsCollector: null,
      fetchRelayAgents: async () => answer,
    });
    const first = fakeReqRes("/panel/api/agents", "GET");
    await router.handle(first.req, first.res);
    assert.equal(first.json().frame.source, "relay");

    answer = { pullTimeout: true };
    const second = fakeReqRes("/panel/api/agents", "GET");
    await router.handle(second.req, second.res);
    assert.deepEqual(second.json().agents, pulled);
    assert.deepEqual(second.json().frame, { ready: true, source: "relay-stale" }, "陈旧的真数据仍是能说的话");
  });

  it("GET /panel/api/agents still falls back to the local collector when the relay is unreachable", async () => {
    // relay 真停了：它确实不经任何流量，本地收集器报的零是事实，看板照常画 stopped/running。
    const local = [{ id: "claude", status: "stopped" }];
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, aliasResolver: null, aliasPath: null,
      metricsCollector: { getAgentsStatus: async () => local },
      fetchRelayAgents: async () => null,
    });
    const { req, res, json } = fakeReqRes("/panel/api/agents", "GET");
    await router.handle(req, res);
    assert.deepEqual(json().agents, local);
    assert.deepEqual(json().frame, { ready: true, source: "panel-local" });
  });

  it("GET /panel/api/agents answers not-ready when this process has no source at all", async () => {
    const router = routerWith({ pulledAgents: null });
    const { req, res, json } = fakeReqRes("/panel/api/agents", "GET");
    await router.handle(req, res);
    assert.deepEqual(json().agents, []);
    assert.equal(json().frame.ready, false);
    assert.equal(json().frame.reason, "no-source");
  });

  it("defaultFetchRelayAgents 把超时报成标记，把连不上报成 null", async () => {
    // 两种「拉不到」的处置完全不同（见 panel.mjs 该函数上方），所以出口必须分得开。
    const src = readFileSync(new URL("./panel.mjs", import.meta.url), "utf8");
    const fn = src.match(/async function defaultFetchRelayAgents\([\s\S]*?\n\}/)?.[0];
    assert.ok(fn, "defaultFetchRelayAgents 在册");
    assert.match(fn, /err\?\.name === "TimeoutError"/, "超时与中断分别命名");
    assert.match(fn, /return \{ pullTimeout: true \};/, "预算内没答上 → 超时标记");
    assert.match(fn, /\n {4}return null;\n {2}\}\n\}$/, "连不上 → null（沿用可注入契约，测试替身不受影响）");
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
    const dir = mkTestDir("anyswitch-panel-pool-");
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
    const dir = mkTestDir("anyswitch-panel-wd-");
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
    const dir = mkTestDir("anyswitch-panel-wd-snap-");
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
    assert.ok(m[0].includes('renderSurfaceSummary("dsh", d.surfaces)'), "卡头副行按面汇总");
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

  it("renders Kimi as a surface-badged multi-instance card", () => {
    const cardStart = panelHtml.indexOf('data-agent-id="kimi"');
    const cardEnd = panelHtml.indexOf('data-agent-id="', cardStart + 20);
    const kimiCard = panelHtml.slice(cardStart, cardEnd);
    assert.ok(cardStart > 0, "kimi card container exists");
    assert.ok(kimiCard.includes('id="kimiSurfaceSummary"'), "卡头有分面副行位");
    assert.ok(
      kimiCard.indexOf('id="kimiInstanceCount"') < kimiCard.indexOf('id="kimiSurfaceSummary"'),
      "副行排在实例计数胶囊之后（与 DSH 卡同序）",
    );

    const m = panelJs.match(/function renderKimi\(p\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "renderKimi found in panel.js");
    assert.ok(m[0].includes("showSurface: true"), "行上贴面徽标");
    assert.ok(m[0].includes('renderSurfaceSummary("kimi", p.surfaces)'), "卡头副行按面汇总");
    assert.ok(m[0].includes('renderSurfaceSummary("kimi", [])'), "停止态显式清副行（CSS 不藏徽标，脏值会挂到下一轮）");
    assert.ok(m[0].includes('setInstanceCount("kimi", 0)'), "未运行分支清零计数");
    assert.ok(!m[0].includes("dshInstances") && !m[0].includes("dshSurface"), "不借 DSH 的接线");
  });

  it("keeps the surface badge off the cards without a second face", () => {
    for (const fn of ["renderPi", "renderOpencode", "renderCodex", "renderGrok"]) {
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

  it("目录读后端 turns、窄窗有备用入口、长会话分帧", () => {
    // 目录曾经整条看不见，两件事叠在一起：右栏在窄窗被断点关掉，唯一的备用按钮又
    // 只在「有目录条目」时出现，而条目是前端按 role==="user" 现算的——qoder 一条会话
    // 因此报出 1203 个"用户轮"（全是工具输出），kimi 则普遍算出 0 个。
    assert.ok(panelJs.includes("Array.isArray(s.turns)"), "目录条目取自后端 turns");
    assert.ok(!panelJs.includes("function sessTocEntries"), "前端不再按角色自己现算目录");
    assert.ok(/const SESS_TOC_MIN_TURNS = 2/.test(panelJs), "一两轮的会话不占栏");
    assert.ok(panelJs.includes('block: "center"'), "跳转居中对齐，避开吸顶头行");
    assert.ok(/const SESS_RENDER_CHUNK = 120/.test(panelJs), "消息流按帧建节点");
    assert.ok(panelJs.includes("function ensureSessMessageRendered"), "跳转前补齐未渲染的帧");
    assert.ok(
      panelJs.includes('document.body.classList.toggle("sessions-mode", sessions)'),
      "☰ 与弹层随会话页在场",
    );
    const css = panelCss.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(
      /@media \(max-width: 1023px\) \{[\s\S]*?\.toc-side \{ display: none; \}/.test(css),
      "窄窗收右栏",
    );
    assert.ok(
      css.includes("body.sessions-mode .toc-fab.has-toc { display: flex; }"),
      "窄窗目录备用入口挂在会话页在场，不再绑死媒体查询",
    );
    assert.ok(
      /@media \(min-width: 1024px\) \{[\s\S]*?\.toc-fab\.has-toc \{ display: none; \}/.test(css),
      "宽窗走右栏，不留两个入口",
    );
    assert.ok(!/@media \(max-width: 1279px\)/.test(css), "1280 断点已下调到 1024");
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

  it("staggers by the archived visual order while the prepaint card order is still in force", () => {
    // 2026-10-08 报障：加载态窗口期切回看板，卡片浮出次序混乱。根因是首帧卡序接管
    // （panel.html 的 data-prepaint-card-order）只用 CSS order 改绘制序、不改 DOM 序，
    // 可信首帧落地前按 DOM 序发延迟就会跟屏上卡序对不上。
    const m = panelJs.match(/function playBoardEnter\(view\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "playBoardEnter found in panel.js");
    assert.ok(m[1].includes('document.documentElement.getAttribute("data-prepaint-card-order")'),
      "首帧卡序接管生效期间读存档序");
    assert.ok(m[1].includes('rank.get(a.getAttribute("data-agent-id")) - rank.get(b.getAttribute("data-agent-id"))'),
      "端点卡槽位按存档视觉序填回，阶梯延迟跟着屏上卡序走");
    assert.ok(m[1].indexOf("data-prepaint-card-order") < m[1].indexOf("cards.forEach"),
      "重排发生在发延迟之前");
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
    const dir = mkTestDir("anyswitch-panel-html-");
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
    const dir = mkTestDir("anyswitch-panel-etag-");
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

describe("panel router xterm unicode11 asset", () => {
  // 文件名漂移回归钉：@xterm/addon-unicode11 打包后 lib/ 实物为 addon-unicode11.js
  // （UMD，全局 window.Unicode11Addon.Unicode11Addon，与 panel.js 实例化处一致），
  // 并非按包名推断的 unicode11.js。环境装了依赖（装机/开发机）就必须真 200；
  // 包在而文件名再漂移时 readFileSync 抛错转红，不允许静默跳过。
  const addonPkgDir = new URL("./node_modules/@xterm/addon-unicode11/", import.meta.url);
  const addonFile = new URL("./node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js", import.meta.url);
  const addonInstalled = existsSync(addonPkgDir);

  it("GET /panel/assets/xterm-unicode11.js serves the packaged UMD bundle, including query params", { skip: !addonInstalled }, async () => {
    const expected = readFileSync(addonFile, "utf8");
    const router = routerWith();
    for (const path of ["/panel/assets/xterm-unicode11.js", "/panel/assets/xterm-unicode11.js?startup=1&v=2"]) {
      const { req, res } = fakeReqRes(path, "GET", null, { host: "127.0.0.1:47820" });
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["content-type"], "text/javascript; charset=utf-8");
      assert.equal(res.headers["cache-control"], "no-cache");
      assert.ok(res.headers.etag, "响应带 ETag（size-mtimeMs 派生）");
      assert.equal(res.headers.location, undefined);
      assert.equal(res.body, expected);
      assert.ok(res.body.includes("Unicode11Addon"), "UMD 包导出全局 Unicode11Addon（panel.js 以 window.Unicode11Addon.Unicode11Addon 实例化）");
    }
  });

  it("HEAD /panel/assets/xterm-unicode11.js returns JavaScript headers without redirect", { skip: !addonInstalled }, async () => {
    const router = routerWith();
    const { req, res } = fakeReqRes("/panel/assets/xterm-unicode11.js", "HEAD", null, { host: "127.0.0.1:47820" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(res.headers["cache-control"], "no-cache");
    assert.equal(res.headers.location, undefined);
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

  // 位次的链身份：同一（渠道,模型）可以同时出现在端点链和虚拟模型链里，所以
  // 位次必须按「服务它的那条链」数——relay 在归因里给出 chainKey（端点 id 或
  // 虚拟模型名），面板按它取链，不能按端点自己的链去猜。
  function makeChainByKey({ chains = [], virtualModels = [] } = {}) {
    const m = panelJs.match(/function boardChainByKey\(chainKey\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "boardChainByKey found in panel.js");
    return new Function("boardRoutingChains", "boardVirtualModels", `return (${m[0]});`)(
      () => chains,
      () => virtualModels,
    );
  }
  const ENDPOINT_CHAINS = [
    { endpointId: "kimi", chain: [{ node: "demo-pool", model: "kimi-k3" }, { node: "sensenova", model: "kimi-k3" }], enabled: true },
  ];
  const VIRTUAL_MODELS = [
    {
      name: "deepseek-v4.1-flash-mix",
      chain: [
        { node: "sensenova", model: "deepseek-flash" },
        { node: "backup-pool", model: "deepseek-v4.1-flash" },
        { node: "demo-pool", model: "deepseek-v4.1-flash" },
      ],
      enabled: true,
    },
  ];

  it("chainKey 指向端点链或虚拟模型链，两种都取得到", () => {
    const byKey = makeChainByKey({ chains: ENDPOINT_CHAINS, virtualModels: VIRTUAL_MODELS });
    assert.deepEqual(byKey("kimi"), ENDPOINT_CHAINS[0].chain, "端点 id → 端点链");
    assert.deepEqual(byKey("deepseek-v4.1-flash-mix"), VIRTUAL_MODELS[0].chain, "虚拟模型名 → 虚拟模型链");
  });

  it("chainKey 缺失或链已被删除时返回 null（不猜、不拿别的链凑数）", () => {
    const byKey = makeChainByKey({ chains: ENDPOINT_CHAINS, virtualModels: VIRTUAL_MODELS });
    assert.equal(byKey(null), null);
    assert.equal(byKey(""), null);
    assert.equal(byKey("deleted-chain"), null);
  });

  it("同（渠道,模型）出现在两条链里时，位次按 chainKey 那条数（不串链）", () => {
    // kimi 端点链与 kimi-k3-mix 虚拟模型链里都有 demo-pool/kimi-k3，但位次不同。
    const chains = [
      { endpointId: "kimi", chain: [{ node: "demo-pool", model: "kimi-k3" }, { node: "x", model: "m" }, { node: "y", model: "m" }, { node: "z", model: "m" }], enabled: true },
    ];
    const virtualModels = [
      { name: "kimi-k3-mix", chain: [{ node: "other", model: "m" }, { node: "demo-pool", model: "kimi-k3" }], enabled: true },
    ];
    const byKey = makeChainByKey({ chains, virtualModels });
    const mark = makeAutoMark();
    assert.deepEqual(mark(byKey("kimi"), "demo-pool", "kimi-k3", true), { cur: 0, total: 4 }, "端点链第 1 跳");
    assert.deepEqual(mark(byKey("kimi-k3-mix"), "demo-pool", "kimi-k3", true), { cur: 1, total: 2 }, "虚拟模型链第 2 跳");
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

  it("capsuleTargetList：新快照 activeTargets 逐条出（渠道,模型,活跃,归因,链身份）", () => {
    const list = makeCapsuleTargetList()({
      activeTargets: [
        { providerId: "A", model: "a", count: 1, autoCount: 1, chainKey: "kimi" },
        { providerId: "B", model: "a", count: 2, autoCount: 0 },
      ],
      lastModel: "old",
    });
    assert.deepEqual(list, [
      { providerId: "A", model: "a", active: true, viaAuto: true, chainKey: "kimi" },
      { providerId: "B", model: "a", active: true, viaAuto: false, chainKey: null },
    ], "chainKey 随条目透传：位次要按服务它的那条链数（旧 relay 缺该字段为 null）");
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
      { providerId: null, model: "m", active: true, viaAuto: false, chainKey: null },
    ]);
  });

  it("capsuleTargetList：活跃账本空 → 最近灰胶囊携带 lastProvider/lastViaAuto/lastChainKey 来源", () => {
    const list = makeCapsuleTargetList()({
      activeTargets: [],
      lastModel: "m",
      lastProvider: "B",
      lastViaAuto: true,
      lastChainKey: "deepseek-v4.1-flash-mix",
    });
    assert.deepEqual(list, [{
      providerId: "B",
      model: "m",
      active: false,
      viaAuto: true,
      chainKey: "deepseek-v4.1-flash-mix",
    }]);
    assert.deepEqual(makeCapsuleTargetList()({ activeTargets: [] }), []);
  });

  it("capsuleTargetList：旧 relay 无 activeTargets → 退化为旧名单（无渠道、无标记）", () => {
    const fn = makeCapsuleTargetList();
    assert.deepEqual(fn({ activeModels: ["m1", "m2"] }), [
      { providerId: null, model: "m1", active: true, viaAuto: false, chainKey: null },
      { providerId: null, model: "m2", active: true, viaAuto: false, chainKey: null },
    ]);
    assert.deepEqual(fn({ currentModel: "m3" }), [{ providerId: null, model: "m3", active: true, viaAuto: false, chainKey: null }]);
    assert.deepEqual(fn({ lastModel: "m4" }), [{ providerId: null, model: "m4", active: false, viaAuto: false, chainKey: null }]);
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
    // 胶囊位次按条目自带的链身份取链（端点链 / 虚拟模型链同口径），旧 relay 缺
    // chainKey 时才退回端点自己的链——退回不是主路径，不能把主路径写丢。
    assert.ok(panelJs.includes("boardChainByKey(t.chainKey)"), "badge hop resolves the chain by chainKey");
    assert.ok(panelJs.includes("boardVirtualModels()"), "virtual model chains are part of the hop lookup");
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

  it("容器改 grid 四列共享列宽（序号 max-content + 标签 38% + 轨道 1fr + 数值 max-content，各行轨道右端严格对齐）", () => {
    assert.ok(panelJs.includes('el.classList.add("stats-bars")'), "statsRenderBars 给容器挂 grid 类");
    const m = panelCss.match(/\.stats-bars \{([^}]*)\}/);
    assert.ok(m, ".stats-bars rule found in panel.css");
    assert.match(m[1], /display:\s*grid/, "container is grid");
    assert.match(m[1], /max-content/, "value column sized to the longest row");
    assert.match(m[1], /max-content minmax\(0, 38%\)/, "首列为序号 max-content 列（R-27），标签列仍 38%");
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

describe("panel.html stats TTFT/TPS 排名序号 + 双卡等高 + 全量弹窗（R-27/R-28）", () => {
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

  it("TTFT 榜按 avg 升序（越快越前）+ 卡内截断 Top5（R-27）", () => {
    assert.ok(panelJs.includes("const STATS_TTFT_TOP_N = 5"), "TTFT Top5 常量存在");
    const m = panelJs.match(/function statsTtftRankedAll\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "statsTtftRankedAll found in panel.js");
    assert.match(m[1], /a\.avg - b\.avg/, "TTFT 按 avg 升序（越快越前）");
    assert.match(m[1], /a\.key < b\.key/, "并列按 key 字母序");
    assert.ok(
      panelJs.includes("statsTtftRankedAll().slice(0, STATS_TTFT_TOP_N)"),
      "卡内榜取 Top5（后端全量下发，前端截断）",
    );
    assert.ok(panelHtml.includes("按模型 Top5（均值）"), "TTFT 卡小标题仍为 Top5");
  });

  it("TPS 卡内榜 Top10 + avgTps 降序兜底（R-27）", () => {
    assert.ok(panelJs.includes("const STATS_TPS_TOP_N = 10"), "TPS Top10 常量存在");
    const m = panelJs.match(/function statsTpsRankedAll\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "statsTpsRankedAll found in panel.js");
    assert.match(m[1], /b\.avgTps - a\.avgTps/, "TPS 按 avgTps 降序");
    assert.ok(
      panelJs.includes("valid.slice(0, STATS_TPS_TOP_N)"),
      "卡内榜从全量截断 Top10（此前全量直出）",
    );
    assert.ok(panelHtml.includes("按模型 Top10"), "TPS 卡小标题为 Top10");
  });

  it("排名序号 1..N 复用看板状态检测卡 .ms-rank/.top（R-27）", () => {
    assert.ok(panelJs.includes("function statsRankEl(n)"), "序号小件 statsRankEl 存在");
    assert.ok(panelJs.includes('rk.className = "ms-rank"'), "序号复用 .ms-rank 基类（不新造）");
    // 仅第 1 名 accent：与看板状态检测卡同构（那边是 idx === 0 挂 .top），不是 1-2 名
    assert.ok(panelJs.includes('rk.className = "ms-rank" + (n === 1 ? " top" : "")'),
      "仅第 1 名挂 .top 走 accent 色");
    assert.ok(!panelJs.includes("n <= 2"), "旧「1-2 名 accent」写法已撤");
    assert.ok(panelJs.includes('rank.className = "ms-rank" + (idx === 0 ? " top" : "")'),
      "看板同构实现仍在（仅第 1 名），两边同规则");
    // 卡内榜传 rank：TTFT 与 TPS 同构
    assert.ok(panelJs.includes("rank: i + 1,"), "卡内榜行带 rank 序号");
    // CSS：不新造渐变规则；复用看板 .ms-rank/.top（10px mono 灰字，首名 accent）
    assert.ok(panelCss.includes(".ms-rank {"), "看板 .ms-rank 基类仍在");
    assert.ok(panelCss.includes(".ms-rank.top"), "看板 .ms-rank.top 首名规则仍在");
    assert.ok(!panelCss.includes(".stats-bar-rank"), "无新造 .stats-bar-rank 规则");
    assert.ok(!panelCss.includes("#FFD54F") && !panelCss.includes("#B8860B"), "无金渐变硬编码色");
    assert.ok(!panelCss.includes("#CFD8DC") && !panelCss.includes("#78909C"), "无银渐变硬编码色");
  });

  it("榜区悬停提示统一措辞（R-27）", () => {
    const hits = panelHtml.match(/title="双击查看全部模型"/g) || [];
    assert.equal(hits.length, 2, "TTFT/TPS 两榜区各一个悬停提示");
  });

  it("双卡等高：stretch + 卡片纵向撑满 + 占位行补齐（空态例外，R-28）", () => {
    assert.ok(
      panelCss.includes(".skills-grid.stats-quad { align-items: stretch; }"),
      "网格切 stretch（覆盖基座 start）",
    );
    assert.ok(
      panelCss.includes(".skills-grid.stats-quad .panel-card { height: 100%; display: flex; flex-direction: column; }"),
      "卡片纵向撑满",
    );
    assert.ok(panelCss.includes("#statsTtftBars, #statsTpsBars { flex: 1;"), "榜容器 flex:1 顶满卡体");
    // 占位行：虚线、跨满列、高度贴近常规榜行
    assert.ok(panelCss.includes(".stats-bar-placeholder {"), "占位行规则存在");
    assert.ok(panelCss.includes("border-bottom: 1px dashed"), "占位行为虚线行");
    assert.ok(panelJs.includes("placeholders: STATS_TTFT_TOP_N - rows.length"), "TTFT 缺位补足 5 行");
    assert.ok(panelJs.includes("placeholders: STATS_TPS_TOP_N - top.length"), "TPS 缺位补足 10 行");
    // 空态例外：无数据走 empty-hint，不补占位
    assert.ok(panelJs.includes('<div class="empty-hint">暂无数据</div>'), "空态仍走 empty-hint");
  });

  it("全量弹窗一卡一窗 + 窗内两列均分 + 空态不开窗（R-28）", () => {
    for (const id of ["statsRankModal", "statsRankTitle", "statsRankBody", "statsRankCloseBtn", "statsRankCancelBtn"]) {
      assert.ok(panelHtml.includes(`id="${id}"`), `弹窗骨架 #${id} 存在`);
    }
    assert.ok(panelJs.includes("function openStatsRankModal(kind)"), "开窗函数存在");
    assert.ok(panelJs.includes('openStatsRankModal("ttft")'), "TTFT 榜双击开 TTFT 窗");
    assert.ok(panelJs.includes('openStatsRankModal("tps")'), "TPS 榜双击开 TPS 窗");
    assert.ok(panelJs.includes('addEventListener("dblclick"'), "榜区双击接线（非卡头按钮）");
    // 一卡一窗：kind 分支取各自全量 + 各自标题（标题只写卡片名，不带「· 全部模型」后缀）
    assert.ok(panelJs.includes('titleEl.textContent = "首字响应 TTFT"'), "TTFT 窗标题为卡片名");
    assert.ok(panelJs.includes('titleEl.textContent = "TPS 生成速度"'), "TPS 窗标题为卡片名");
    assert.ok(!panelJs.includes("· 全部模型"), "窗标题不带「· 全部模型」后缀");
    assert.ok(panelHtml.includes('<h3 id="statsRankTitle"></h3>'), "markup 静态标题留空（开窗前现写）");
    // 两列纵向连续：奇左多一 + 序号跨列延续 + 紧凑文本行（复用 valText，无横条）
    assert.ok(panelJs.includes("Math.ceil(items.length / 2)"), "偶均分/奇左多一");
    assert.ok(panelJs.includes("stats-rank-cols") && panelJs.includes("stats-rank-col"), "两列容器类");
    assert.ok(panelJs.includes("stats-rank-row") && panelJs.includes("stats-rank-name") && panelJs.includes("stats-rank-val"),
      "紧凑文本行（序号+模型名+数值）");
    assert.ok(!panelJs.match(/function openStatsRankModal[\s\S]{0,2000}stats-bar-track/),
      "弹窗行无横条轨道");
    // 720px 档 + 内容区 52vh 内部滚动 + 两列 grid（窄屏折单列）
    assert.ok(panelCss.includes(".stats-rank-modal-overlay .modal-card { max-width: 720px; }"),
      "弹窗 720px 档（复用差异弹窗规格）");
    assert.ok(panelCss.includes(".stats-rank-modal-overlay .modal-body { max-height: 52vh; overflow-y: auto; }"),
      "内容区 52vh 内部滚动（整体一根纵向滚动条、窗高固定）");
    assert.ok(panelCss.includes(".stats-rank-cols { display: grid; grid-template-columns: 1fr 1fr;"),
      "窗内两列 grid");
    // 关闭：✕/按钮/遮罩/Esc；空态不开窗
    assert.ok(panelJs.includes("function hideStatsRankModal()"), "关窗函数存在");
    assert.ok(panelJs.includes('e.key === "Escape"'), "Esc 关窗");
    assert.ok(panelJs.includes("if (e.target === rankModal) hideStatsRankModal()"), "遮罩点击关窗");
    assert.ok(panelJs.includes("if (!items.length) return;"), "空态不开窗（卡内已有暂无数据）");
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

  it("虚拟模型瓦片墙：复用 route-ep-tile 质感 + 三态控件 + 末位新建瓦片，随 renderRouteChains 一并刷新", () => {
    assert.ok(panelHtml.includes('id="virtualModelGrid"'), "tile grid container exists in panel.html");
    assert.ok(panelHtml.includes('id="virtualModelBadge"'), "count badge exists in panel.html");
    assert.ok(panelJs.includes("function renderVirtualModels()"), "virtual model tile renderer exists");
    assert.ok(panelJs.includes("data-vm-edit=") && panelJs.includes("data-vm-del=") && panelJs.includes("data-vm-enabled="),
      "tiles carry edit/delete/enabled controls");
    assert.ok(panelJs.includes('id="virtualModelAddBtn"'), "create tile pinned at grid end");
    const m = panelJs.match(/function renderRouteChains\(\) \{[\s\S]*?\n  \}/);
    assert.ok(m && m[0].includes("renderVirtualModels()"), "endpoint tiles refresh the virtual grid too");
  });

  it("虚拟模型编辑器共用链编辑弹窗：新建与编辑同一形态，名字输入可编辑并带初值", () => {
    assert.ok(panelJs.includes("function openVirtualModelModal("), "virtual editor open fn exists");
    const open = panelJs.match(/function openVirtualModelModal\(name\) \{[\s\S]*?\n  \}/);
    assert.ok(open && /virtualModelNameDraft = name;/.test(open[0]), "编辑流把当前名填进草稿");
    const bodyFn = panelJs.match(/function renderRouteChainBody\(opts\) \{[\s\S]*?\n  \}/);
    assert.ok(bodyFn, "route chain body renderer found");
    assert.ok(bodyFn[0].includes('id="virtualModelNameInput"'), "the editor renders a name input");
    const nameInput = bodyFn[0].split("\n").find((l) => l.includes('id="virtualModelNameInput"'));
    assert.ok(nameInput && !nameInput.includes("disabled"), "名字输入不再禁用（改名走保存）");
    assert.ok(bodyFn[0].includes("virtualModelCreating"), "create-vs-edit branching is explicit");
    assert.ok(bodyFn[0].includes('$("routeChainConfirmBtn").textContent = isVirtual ? "保存虚拟模型"'),
      "底部按钮按目标分叉，不再在虚拟模型编辑器里写「保存路由链」");
  });

  it("虚拟模型保存/删除/启用打到独立 API，保存体携带 name+chain（改名时带 previousName）", () => {
    const save = panelJs.match(/api\("POST",\s*"\/api\/store\/virtual-model\/save",\s*\{[\s\S]*?\}\);/);
    assert.ok(save, "save posts to virtual-model/save");
    assert.ok(/\bname\b/.test(save[0]) && /chain:/.test(save[0]), "save body carries name and chain");
    assert.ok(save[0].includes("previousName"), "改名时保存体带原名");
    assert.ok(panelJs.includes('"/api/store/virtual-model/delete"'), "delete endpoint wired");
    assert.ok(panelJs.includes('"/api/store/virtual-model/enabled"'), "enabled endpoint wired");
  });

  it("虚拟模型名称校验：小写字母开头 + 字符集 + 长度上限，不得与链内模型重名，也不得占用别的虚拟模型名", () => {
    const m = panelJs.match(/function virtualModelNameError\(\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "name validator exists");
    assert.ok(m[0].includes('^[a-z][a-z0-9._-]*$'), "charset anchored to store PROVIDER_ID shape");
    assert.ok(m[0].includes("模型名不能与链内模型重名"), "chain-internal collision rejected");
    assert.ok(m[0].includes("这个名字已被占用"), "other virtual models' names rejected");
  });

  it("编辑已有虚拟模型：名字取自当前名，校验放行（回归：曾误报「请填写模型名」）", () => {
    const src = ["virtualModelNameValue", "virtualModelNameError"].map((fnName) => {
      const body = panelJs.match(new RegExp(`function ${fnName}\\(\\)[\\s\\S]*?\\n  \\}`))?.[0];
      assert.ok(body, `${fnName} found in panel.js`);
      return body;
    }).join("\n");
    const chain = [{ node: "prov-a", model: "m1" }];
    const existing = [{ name: "deepseek-pro" }, { name: "other-vm" }];
    const call = (over) => {
      const ctx = {
        virtualModelNameDraft: "deepseek-pro",
        virtualModelCreating: false,
        routeChainTarget: { kind: "virtual", id: "deepseek-pro" },
        routeChainDraft: chain,
        storeVirtualModels: () => existing,
        ...over,
      };
      return vm.runInNewContext(`(() => { ${src}; return virtualModelNameError; })()`, ctx)();
    };
    assert.equal(call({}), null, "编辑流保留原名必须放行（曾恒报「请填写模型名」）");
    assert.equal(call({ virtualModelNameDraft: "  " }), "请填写模型名", "清空名字仍报缺名");
    assert.equal(call({ virtualModelNameDraft: "MyName" }).startsWith("模型名格式不对"), true, "格式校验不变");
    assert.equal(call({ virtualModelNameDraft: "other-vm" }), "这个名字已被占用：other-vm", "改名撞名拦在保存前");
    assert.equal(
      call({ virtualModelNameDraft: "deepseek-pro", virtualModelCreating: true, routeChainTarget: { kind: "virtual", id: null } }),
      "这个名字已被占用：deepseek-pro",
      "新建撞名不再静默覆盖那条模型的链",
    );
  });

  it("改名虚拟模型：写盘前过一次确认，写盘带 previousName，成功提示点名新旧名", () => {
    const confirm = panelJs.match(/async function confirmRouteChainSave\(\) \{[\s\S]*?\n  \}/);
    assert.ok(confirm, "save entry point found");
    assert.ok(confirm[0].includes("showSkillsModal"), "改名先过确认弹窗");
    assert.ok(confirm[0].includes("commitRouteChainSave()"), "确认后走同一次写盘");
    const commit = panelJs.match(/async function commitRouteChainSave\(\) \{[\s\S]*?\n  \}/);
    assert.ok(commit, "commit fn found");
    assert.ok(commit[0].includes("previousName"), "改名写盘带原名");
    assert.ok(commit[0].includes("虚拟模型已改名："), "改名成功提示点名新旧名");
  });

  it("名字输入即时驱动入口桩与链路标签（新建与编辑同源），且打字即清除报错", () => {
    const m = panelJs.match(/nameInput\.addEventListener\("input", \(\) => \{[\s\S]*?\n      \}\);/);
    assert.ok(m, "name input live listener exists");
    assert.ok(m[0].includes('route-entry-tag'), "entry tag updates live");
    assert.ok(m[0].includes("逐跳退避"), "stage label updates live");
    assert.ok(m[0].includes("编辑虚拟模型 — "), "编辑流标题随输入更新");
    assert.ok(m[0].includes('err.hidden = true'), "typing clears the inline error");
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
  // （← 退出 + 「设置」标题 + 亮暗钮），内容区顶部「通用」「高级选项」「自动路由」「主题」「关于」五个子 tab。
  // 设置视图不占 panel-view（那份留作「←退出」的目标），另由 panel-settings-open
  // 标记记录是否停在设置页：刷新与面板重启恢复都按这两个键回到原处。
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("设置视图 section 挂在 main 内且默认隐藏，含「通用」「高级选项」「自动路由」「主题」「关于」子 tab与面板", () => {
    assert.ok(/<section class="settings-view" id="settingsView" hidden>/.test(panelHtml),
      "settingsView section 默认隐藏");
    const iView = panelHtml.indexOf('id="settingsView"');
    assert.ok(iView > panelHtml.indexOf('id="sessionsView"') && iView < panelHtml.indexOf("</main>"),
      "settingsView 位于 main 内（sessions 之后）");
    assert.ok(/<button class="view-tab active" id="settingsTabGeneral" role="tab" aria-selected="true"[^>]*>通用<\/button>/.test(panelHtml),
      "「通用」子 tab 默认选中");
    for (const [name, label] of [["Advanced", "高级选项"], ["Route", "自动路由"], ["Theme", "主题"], ["About", "关于"]]) {
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
    for (const id of ["followAgentToggle", "startupAnimationToggle", "keepAliveToggle", "keepAliveEndpoints", "keepAliveRetriesInput", "injectEffortToggle", "sparkWindowInput"]) {
      assert.ok(general.includes(`id="${id}"`), `通用面板保留控件 #${id}`);
    }
  });

  it("「通用」子 tab 分六张卡：启动/显示/抗截断/Claude Code/实时输出 带图标卡头，其余未归类平卡", () => {
    const general = panelHtml.slice(
      panelHtml.indexOf('id="settingsPanelGeneral"'),
      panelHtml.indexOf('id="settingsPanelRoute"'),
    );
    assert.strictEqual((general.match(/<div class="panel-card">/g) || []).length, 6,
      "通用面板恰六张 panel-card");
    assert.strictEqual((general.match(/<div class="card-header">/g) || []).length, 5,
      "五张卡有 card-header（杂项卡保持无头）");
    assert.ok(/<h2 class="card-title">[\s\S]*?<svg[\s\S]*?<\/svg>\s*启动\s*<\/h2>/.test(general),
      "「启动」卡带 stroke 图标卡头");
    assert.ok(/<h2 class="card-title">[\s\S]*?<svg[\s\S]*?<\/svg>\s*显示\s*<\/h2>/.test(general),
      "「显示」卡带 stroke 图标卡头");
    assert.ok(/<h2 class="card-title">[\s\S]*?<svg[\s\S]*?<\/svg>\s*抗截断\s*<\/h2>/.test(general),
      "「抗截断」卡带 stroke 图标卡头");
    assert.ok(/<h2 class="card-title">[\s\S]*?<svg[\s\S]*?<\/svg>\s*Claude Code\s*<\/h2>/.test(general),
      "「Claude Code」卡带品牌图标卡头（档位映射四行都在卡内）");
    assert.ok(/<h2 class="card-title">[\s\S]*?<svg[\s\S]*?<\/svg>\s*实时输出\s*<\/h2>/.test(general),
      "「实时输出」卡带 stroke 图标卡头");
    assert.ok(general.includes('id="loggingEnabledToggle"'), "运行日志开关在卡内");
    // 卡头图标 = 厂商品牌字形，字形不另抄一份：从看板那张卡的 .agent-avatar 里取，两边必须是
    // 同一 path（改一边漏另一边就红）。官方只发品牌橙那一版，而卡头要跟同行文字同色，故 fill
    // 必须走 currentColor——亮主题即黑、暗主题随字色翻白；硬写品牌橙会跟「五张卡头同一视觉
    // 语言」打架，硬写 #000 则在暗主题里整块看不见。
    const ccCard = general.slice(
      general.lastIndexOf('<div class="panel-card">', general.indexOf('id="claudeBypassPermissionsToggle"')),
    );
    const ccIcon = (ccCard.match(/<h2 class="card-title">[\s\S]*?<\/svg>/) || [""])[0];
    const brandGlyph = (panelHtml.match(/data-agent-id="claude"[\s\S]*?<path fill="#D97757" d="([^"]+)"/) || [])[1];
    assert.ok(brandGlyph, "看板头像的品牌字形在册（卡头字形以它为唯一真源）");
    assert.ok(ccIcon.includes(`d="${brandGlyph}"`), "设置页卡头用的就是这枚品牌字形");
    assert.ok(/fill="currentColor"/.test(ccIcon), "品牌字形按 currentColor 单色呈现，随主题字色");
    assert.doesNotMatch(ccIcon, /#D97757/, "卡头不带品牌橙");
    assert.doesNotMatch(ccIcon, /fill="#0{3}"/, "也不硬写纯黑（暗主题会看不见）");
    assert.ok(panelCss.includes("#settingsPanelGeneral .modal-item:hover { background: var(--surface-hover); }"),
      "设置行悬停整行淡底（--surface-hover）");
  });

  it("「自动路由」子 tab：面板在通用与主题之间，虚拟模型卡 + 端点瓦片墙双卡，Store 旧折叠卡已移除", () => {
    const iRoute = panelHtml.indexOf('id="settingsPanelRoute"');
    assert.ok(iRoute > panelHtml.indexOf('id="settingsPanelGeneral"'), "路由面板在通用面板之后");
    assert.ok(iRoute < panelHtml.indexOf('id="settingsPanelTheme"'), "路由面板在主题面板之前");
    const route = panelHtml.slice(iRoute, panelHtml.indexOf('id="settingsPanelTheme"'));
    assert.ok(route.includes('id="routeChainGrid"'), "端点瓦片墙容器存在");
    assert.ok(route.includes('id="routeChainBadge"'), "端点链已配置计数徽标存在");
    assert.ok(route.includes('id="virtualModelGrid"'), "虚拟模型瓦片墙容器存在");
    assert.ok(route.includes('id="virtualModelBadge"'), "虚拟模型计数徽标存在");
    assert.ok(route.includes("按链顺序路由，失败自动退避下一节点"), "端点链功能说明文案保留");
    assert.ok(route.includes("端点请求虚拟模型时按链顺序路由，失败自动退避下一节点"), "虚拟模型说明行与端点链说明同式（模型auto→虚拟模型）");
    assert.ok(route.indexOf("虚拟模型") < route.indexOf('id="routeChainGrid"'), "虚拟模型卡在端点瓦片墙之前");
    assert.strictEqual((route.match(/<div class="panel-card">/g) || []).length, 2,
      "路由面板两张 panel-card（虚拟模型 + 端点路由链）");
    assert.ok(!route.includes("ailureRate"), "路由子 tab 不含按失败率降级控件");
    assert.ok(!panelHtml.includes('id="routeChainCard"'), "Store 页旧折叠卡已移除");
    assert.ok(!panelHtml.includes("routeChainFoldBtn"), "折叠钮已移除");
  });

  it("看板左栏服务状态卡下提供虚拟终端入口，终端页为独立整页且返回看板", () => {
    const iService = panelHtml.indexOf('id="sbStateBadge"');
    const iEntry = panelHtml.indexOf('<div class="panel-card terminal-entry-card">');
    const iMsCard = panelHtml.indexOf('<div class="panel-card" id="msCard">');
    assert.ok(iService > 0 && iEntry > iService && iMsCard > iEntry,
      "入口卡位于服务状态卡之后、状态检测卡之前");
    const entry = panelHtml.slice(iEntry, iMsCard);
    assert.ok(entry.includes('id="openTerminalPreviewBtn"'), "入口卡含虚拟终端入口");
    assert.ok(entry.includes("打开虚拟终端"), "入口文案明确");
    assert.ok(entry.includes("打开后可连接本机终端运行 CLI Agent"), "入口说明与真实终端能力一致");
    assert.ok(!entry.includes("当前为实验性功能"), "说明行不再自指实验性");
    assert.ok(panelHtml.includes('<section class="terminal-view" id="terminalView" hidden'), "虚拟终端是独立整页视图");
    assert.ok(panelHtml.includes('id="terminalReturnBtn" title="返回看板" aria-label="返回看板"'),
      "终端页返回钮的文字、悬停与读屏都说返回看板");
    assert.ok(!panelHtml.includes("实验功能"), "终端页不再挂「实验功能」胶囊（已转正式功能）");
    assert.ok(!entry.includes(">预览</span>"), "入口卡头不再挂「预览」徽标（已转正式功能）");
    for (const id of ["terminalTabs", "terminalXtermHost", "terminalInspector", "terminalRequestList"]) {
      assert.ok(panelHtml.includes(`id="${id}"`), `终端预览含 #${id}`);
    }
    assert.ok(panelHtml.includes('/panel/assets/xterm.js') && panelHtml.includes('/panel/assets/xterm-fit.js'), "终端页加载 xterm 渲染运行时");
    assert.ok(panelHtml.includes('/panel/assets/xterm-unicode11.js'), "终端页加载 unicode11 宽度表附加组件");
    assert.ok(panelHtml.includes('/panel/assets/xterm-webgl.js'), "终端页加载 WebGL 渲染附加组件");
    assert.ok(panelJs.includes('unicode.activeVersion = "11"'), "unicode11 宽度表激活（emoji 按 2 格记账）");
    assert.ok(panelJs.includes("allowProposedApi: true"), "xterm 构造开启 allowProposedApi（unicode 附件属提案 API，不开则 loadAddon 抛错）");
    assert.ok(panelMjs.includes("/panel/assets/xterm-unicode11.js") && panelMjs.includes("addon-unicode11"), "panel-host 路由服务 unicode11 资产");
    assert.ok(panelMjs.includes("/panel/assets/xterm-webgl.js") && panelMjs.includes("addon-webgl"), "panel-host 路由服务 WebGL 资产");
    assert.ok(panelJs.includes("terminalWebglAddon.onContextLoss") && panelJs.includes("WebGL renderer unavailable"), "WebGL 渲染不可用时回退 DOM 渲染");
    assert.ok(panelJs.includes('fontFamily: \'ui-monospace, "Cascadia Mono"'), "终端使用稳定的等宽字体栈测量尺寸");
    assert.ok(panelJs.includes("function scheduleTerminalFit()"), "终端显示后重新调度一次尺寸适配");
    assert.ok(panelJs.includes('terminalReturnView = currentView;'), "返回目标取进来时所在的视图（看板）");
    assert.ok(!panelJs.includes("terminalReturnSettingsSubTab"), "返回终端页不再改写设置页的子 tab 存档");
    assert.ok(panelJs.includes("function openTerminalPreview()") && panelJs.includes("function closeTerminalPreview()"), "终端预览有进入/返回逻辑");
    // v2 撤除入口卡：栏内「虚拟终端」tab 与这张卡同走一条 openTerminalPreview 链，入口重复；
    // v1 无栏，卡是唯一入口——markup 原样保留（上面逐条在册），只由 v2 门控的 CSS 整隐。
    const entryHideRule = ':root[data-ui-version="v2"][data-style] .terminal-entry-card { display: none; }';
    assert.ok(panelCss.includes(entryHideRule), "v2 下看板虚拟终端入口卡整隐（侧栏已有同链入口）");
    assert.strictEqual(panelCss.split(entryHideRule).length - 1, 1, "入口卡隐藏规则只此一处");
    assert.ok(!/(^|})\s*\.terminal-entry-card \{ display: none;/.test(panelCss),
      "无未门控的裸隐藏规则，v1 原样呈现");
  });

  it("虚拟终端预览的监测区复用看板遥测口径，普通终端无监测块", () => {
    assert.ok(panelHtml.includes('terminal-metrics-section" id="terminalMetricsSection"'), "右栏含请求监测区");
    for (const label of ["首字响应时间", "生成速度", "缓存命中率", "已工作时间"]) {
      assert.ok(panelHtml.includes(`<span class="terminal-metric-label">${label}`), `监测区含看板口径「${label}」`);
    }
    const metricsBlock = panelHtml.slice(panelHtml.indexOf('id="terminalMetricsSection"'), panelHtml.indexOf('id="terminalRequestList"'));
    assert.ok(!metricsBlock.includes("telemetry-card"), "监测区为直排网格，不套卡片盒");
    assert.ok(metricsBlock.includes('terminal-metric-spark" id="terminalSparkTtft"'), "折线图保留并在格子右侧贴两排字");
    assert.ok(!panelHtml.includes('id="terminalSessionTokens"'), "tokens 行已移出侧栏");
    const footbar = panelHtml.slice(panelHtml.indexOf('class="terminal-footbar"'), panelHtml.indexOf('id="terminalInspector"'));
    assert.ok(footbar.includes('id="terminalFootStats"') && footbar.includes('id="terminalFootRequests"') && footbar.includes('id="terminalFootTokens"'), "底栏右侧承载请求数与 tokens");
    // tokens 字串的看板同口径只存在于 JS 构造源：静态稿改 pending 骨架后底栏不再携带样例值
    assert.ok(panelJs.includes("tokens: `Prompt: ${fmt(tokens.prompt)} · Completion: ${fmt(tokens.completion)} · Cached: ${fmt(tokens.cached)}`"),
      "底栏 tokens 与看板同口径");
    assert.ok(!footbar.includes("可输入"), "底栏移除纯装饰占位");
    assert.ok(panelJs.includes("个请求进行中"), "实况行报告在途请求数事实");
    assert.ok(panelJs.includes("当前没有进行中的请求"), "空闲实况只报告无在途请求");
    assert.ok(!panelJs.includes("正在等待模型继续输出") && !panelHtml.includes("正在等待模型继续输出"), "伪意图文案已移除");
    assert.ok(panelJs.includes('updateSparkline("terminalSparkTtft"'), "TTFT 折线复用看板渲染");
    assert.ok(panelJs.includes("metricsSection.hidden = !metrics"), "普通终端无监测数据时整块隐藏");
    assert.ok(panelJs.includes('$("terminalFootStats").hidden = !metrics'), "普通终端无底栏统计");
    assert.ok(/\.terminal-footbar \{[^}]*font: 11px var\(--font-mono\)/.test(panelCss), "底栏字号提到 11px 保证可见");
    assert.ok(panelCss.includes(".terminal-foot-status > span") && footbar.includes('class="terminal-foot-status"'), "底栏状态区胶囊化提升存在感");
    assert.ok(panelCss.includes(".terminal-foot-stats[hidden] { display: none; }"), "底栏统计隐藏显式兜底");
    assert.ok(!panelHtml.includes("terminal-context-grid"), "与顶栏重复的工作目录/运行时间块已移除");
  });

  it("最近请求 5 行视窗 + 四宫格数值改细 + 折线回 0.6.6 位置并右缘内收", () => {
    // 视窗：行高 40px、间距 6px，max-height = 5×40+4×6 = 224px，刚好 5 行；
    // 不足 5 条自然变矮（flex 列高由内容决定，无 min-height 撑高）。
    const listRule = panelCss.match(/\.terminal-request-list \{([^}]*)\}/)[1];
    assert.ok(listRule.includes("max-height: 224px"), "视窗封顶 5 行");
    assert.ok(listRule.includes("overflow-y: auto"), "超出在窗内滚动");
    assert.ok(listRule.includes("scrollbar-width: thin") && listRule.includes("scrollbar-color: var(--border-strong) transparent"), "滚动条为细款窄条");
    assert.ok(!listRule.includes("min-height"), "列表不设最小高度，不足 5 条不留空白");
    assert.ok(/\.terminal-request-item \{[^}]*height: 40px/.test(panelCss), "请求行高固定 40px");
    assert.ok(/\.terminal-request-item \{[^}]*flex: none/.test(panelCss), "行不可压——flex 子项默认 shrink 会压扁行高、视窗塞进 6+ 行");
    assert.ok(/\.terminal-request-item \{[^}]*align-items: center/.test(panelCss), "行内各栏垂直居中（中栏 TTFT 随行居中）");
    // 四宫格：数值改细、折线回到 0.6.6 发布版的 56×22 垂直居中位，再从格子右缘
    // 内收 4px；格子仍为 grid——折线占右列、跨标签/数值两行，两排字左对齐位不动。
    assert.ok(/\.terminal-metric strong \{[^}]*font: 500 16px/.test(panelCss), "白色粗字改细（700→500）");
    assert.ok(panelCss.includes("width: 56px; height: 22px;"), "折线回到 0.6.6 原生 56×22");
    assert.ok(/\.terminal-metric-spark \{[^}]*align-self: center/.test(panelCss), "折线垂直居中（0.6.6 位置）");
    assert.ok(/\.terminal-metric-spark \{[^}]*transform: translateX\(-4px\)/.test(panelCss), "折线自原右缘左移 4px，且不改动两排字的占位宽度");
    assert.ok(panelCss.includes(".terminal-metric-spark svg { display: block; }"), "折线 SVG 块级化");
    assert.ok(panelCss.includes(".terminal-metric-row { display: contents; }"), "数值行拆盒并入格子 grid");
    assert.ok(/\.terminal-metric-spark \{[^}]*grid-row: 1 \/ span 2/.test(panelCss), "折线跨标签/数值两行");
    assert.ok(panelJs.includes("{ w: 56, h: 22 }"), "终端侧栏折线生成规格 56×22 与 CSS 盒等大");
    assert.ok(panelJs.includes("TERMINAL_SPARK_SIZE"), "侧栏折线尺寸随调用方传入生成器");
    // 来源语义改纯文本（副行「绝对时间 · 来源名」）：无图例的紫/青色编码退役
    assert.ok(!panelCss.includes("is-pool") && !panelCss.includes("--chan"), "来源色类与 --chan 已退役");
    assert.ok(panelCss.includes(".terminal-request-detail.is-failed { color: var(--danger); }"), "失败明细红字");
    assert.ok(panelCss.includes(".terminal-request-expand"), "失败行展开块样式齐备");
    assert.ok(/\.terminal-request-data \{[^}]*align-items: flex-end/.test(panelCss), "右栏两行右对齐");
    // 版式改版：TTFT 挪中栏并上看板语义色，右栏改输入/输出 + 缓存灰字
    assert.ok(/\.terminal-request-item \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/.test(panelCss),
      "行网格三段：左身份 / 中栏 TTFT / 右数据——左右两列等宽吃余量，中列被对称夹住即整行几何中点");
    assert.ok(/\.terminal-request-lead \{[^}]*display: flex/.test(panelCss), "状态点与身份栏包进 lead 横排容器（同属左列）");
    assert.ok(/\.terminal-request-data \{[^}]*justify-self: end/.test(panelCss), "右列是 1fr 余量列，数据栏显式贴行右缘");
    assert.ok(/\.terminal-request-metric \{[^}]*justify-self: center/.test(panelCss), "中栏 TTFT 列内居中——配合等宽左右列落整行几何中点");
    assert.ok(panelCss.includes(".terminal-request-metric.is-green { color: var(--ok); }")
      && panelCss.includes(".terminal-request-metric.is-yellow { color: var(--warn); }")
      && panelCss.includes(".terminal-request-metric.is-red { color: var(--danger); }"),
      "中栏 TTFT 红黄绿语义色与看板同档");
    assert.ok(/\.terminal-request-metric \{[^}]*font: 600 13px/.test(panelCss), "中栏 TTFT 与模型名同档字号");
    assert.ok(/\.terminal-request-io \{[^}]*font: 600 12px/.test(panelCss), "右栏上行输入/输出收 12px 小字贴右（比中栏 TTFT 收一档）");
    assert.ok(/\.terminal-request-cache \{[^}]*color: var\(--text-3\)/.test(panelCss), "右栏下行缓存命中为灰字");
  });

  it("虚拟终端整页固定且隐藏全局页脚，终端身份按目录与检测到的 Agent 呈现", () => {
    assert.ok(panelCss.includes("body.terminal-mode { overflow: hidden; }"), "终端页锁定整页滚动");
    assert.ok(panelCss.includes("body.terminal-mode > footer { display: none; }"), "终端页隐藏全局页脚灰字行");
    assert.ok(panelCss.includes(".terminal-shell { height: 100vh;"), "终端外壳固定为视口高度");
    assert.ok(panelJs.includes("session.agent ? session.agent.name : session.shell.name"), "普通终端身份位回落显示 Shell");
    assert.ok(!panelHtml.includes("terminalAgentBadge"), "右栏头部的 agent 徽标已整体退役");
    assert.ok(panelJs.includes('shell: { name: "PowerShell", pid:') && panelJs.includes("instanceId:"), "会话数据携带进程与实例归属");
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
    assert.ok(panelJs.includes("各 Agent 偏好保留，重新开启后生效"), "关态文案说明偏好保留（端点口径已改 Agent）");
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

  it("4 处亮暗钮日/月图标 path 全部逐字一致（终端页那颗曾抄反最后一条光芒）", () => {
    // 一致性锁原本只罩主头行↔设置头行两处；终端页与 v2 栏底不在锁内，terminalIcoSun
    // 的末条光芒 x/y 对调抄反（斜率反向、戳向圆心）多时无人发现。4 处同图，锁全量。
    function svgInner(id) {
      const m = panelHtml.match(new RegExp(`<svg id="${id}"[^>]*>([\\s\\S]*?)</svg>`));
      assert.ok(m, id + " svg found");
      return m[1];
    }
    for (const prefix of ["settings", "terminal", "rail"]) {
      assert.equal(svgInner(`${prefix}IcoSun`), svgInner("icoSun"), `${prefix}IcoSun 与 icoSun 逐字一致`);
      assert.equal(svgInner(`${prefix}IcoMoon`), svgInner("icoMoon"), `${prefix}IcoMoon 与 icoMoon 逐字一致`);
    }
  });

  it("亮暗钮日/月 SVG 按主题摘挂 hidden attribute（SVG 无 hidden IDL 反射，.hidden= 只写 expando）", () => {
    // 4 处亮暗钮（主头行/设置头行/终端页/v2 栏底）同一状态源：initTheme 的 syncBtns 一处收口。
    // hidden 是 HTMLElement 的 IDL 反射属性，SVGElement 上 .hidden = 只写 expando 不落 attribute，
    // UA 的 [hidden] 规则永不生效，图标永远停在 HTML 初态（与栏收展钮同款病、同款修法）。
    const theme = panelJs.match(/function initTheme\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(theme, "initTheme found in panel.js");
    assert.ok(theme[1].includes('t.sun.toggleAttribute("hidden", dark)'), "暗态摘太阳走 attribute");
    assert.ok(theme[1].includes('t.moon.toggleAttribute("hidden", !dark)'), "暗态挂月亮走 attribute");
    assert.ok(!/t\.(sun|moon)\.hidden =/.test(theme[1]),
      "亮暗钮 SVG 的 .hidden = 写法已清除（对 SVG 只写 expando、不落 attribute，图标永不翻转）");
    // 图标画当前态、文案讲点击后去哪（PANEL-COPY-SPEC）：暗态挂月亮、亮态挂太阳，
    // aria/title 的「切换到亮/暗色模式」是目标态动作。默认 auto 跟随系统（暗）——暗态
    // 图标 = 月亮可见、太阳 hidden；主脚本是 defer 外链，首帧只能画静态初态，初态错了
    // 首帧必闪错图标
    for (const [sun, moon] of [["icoSun", "icoMoon"], ["settingsIcoSun", "settingsIcoMoon"], ["terminalIcoSun", "terminalIcoMoon"], ["railIcoSun", "railIcoMoon"]]) {
      assert.ok(new RegExp(`<svg id="${sun}"[^>]* hidden>`).test(panelHtml), `${sun} 初态带 hidden`);
      assert.ok(!new RegExp(`<svg id="${moon}"[^>]* hidden>`).test(panelHtml), `${moon} 初态不带 hidden`);
    }
    // 托底规则覆盖面：8 颗 SVG 全在 .icon-btn 内（UA 的 [hidden] 规则打不赢 .icon-btn svg 的 display:block，
    // 必须显式 !important 兜底——选择器若被收窄出 .icon-btn 之外，这 8 颗即失托底）
    for (const btn of ["themeToggle", "settingsThemeToggle", "terminalThemeToggle", "railThemeToggle"]) {
      const tag = panelHtml.match(new RegExp(`<button[^>]*id="${btn}"[^>]*>`));
      assert.ok(tag && /class="icon-btn[ "]/.test(tag[0]), `${btn} 是 .icon-btn，被 svg[hidden] 兜底规则罩住`);
    }
    assert.ok(panelCss.includes(".icon-btn svg[hidden] { display: none !important; }"),
      "svg[hidden] 显式兜底规则在册（罩 4 处按钮 8 颗 SVG）");
  });

  it("「主题」子 tab：左栏三项点选即生效，右栏预览为真实看板镜像", () => {
    const picker = panelHtml.match(/<div class="settings-theme-list" id="stylePicker"[^>]*>([\s\S]*?)<\/div>/);
    assert.ok(picker, "主题列表沿用 stylePicker 锚点");
    const items = [...picker[1].matchAll(/class="settings-theme-item" data-style="([^"]*)" role="radio" aria-checked="([^"]*)"[^>]*>([^<]+)<\/button>/g)];
    assert.deepEqual(items.map((m) => [m[1], m[3], m[2]]), [
      ["saas", "Default", "true"], ["aurora", "Aurora", "false"], ["sepia", "Sepia", "false"],
    ], "三项主题与样式值一一对应，Default 按钮静态 aria-checked=\"true\"");
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

  it("主题镜像按 UI 版本取导航形态：旧版克隆头行 tabs，新版克隆迷你左栏", () => {
    // v2 的头行 tabs 已被 :root[data-ui-version="v2"] #mainHeadInner .view-tabs 隐去——
    // 剥了 id 的克隆体移进镜像容器后不再命中那条规则，照样克隆就是给 v2 用户画出一条
    // 界面上根本不存在的旧版胶囊导航。新版改克隆一份迷你左栏（皮肤 token 全局生效，
    // 自动着色）；旧版行为原样保留。
    const capture = panelJs.match(/function captureSettingsMirror\(\) \{([\s\S]*?)\n    \}/);
    assert.ok(capture, "captureSettingsMirror found in panel.js");
    const body = capture[1];
    assert.ok(body.includes("newUiEnabled()"), "镜像按本机 UI 版本分路（复用 newUiEnabled，与分段钮同一状态源）");
    assert.ok(body.includes('document.querySelector(".rail")'), "新版克隆左栏进镜像");
    assert.ok(/\} else \{\s*const tabs = document\.querySelector\("#mainHeadInner nav\.view-tabs"\)/.test(body),
      "头行 tabs 克隆只在旧版分支执行");
    assert.ok(/\+ \(mirrorRailW \? mirrorRailW \+ 24 : 0\)/.test(body),
      "镜像自然宽补回栏克隆实渲宽 + 24px 栏间隔（宽档 216+24、窄栏随媒体查询 72+24，与布局左让同源）");
    assert.ok(/railClone\.offsetWidth/.test(body), "栏宽按克隆实渲取值，不硬编码档宽");
    assert.ok(/:root\[data-ui-version="v2"\] \.settings-mirror-scale \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\); column-gap: 24px; row-gap: 24px; \}/.test(panelCss),
      "镜像画布在新版下两列网格：栏跨头行/看板两行通高，栏与内容区间照真实布局留 24px 间隔，行距 24 照 main padding-top");
    assert.ok(/:root\[data-ui-version="v2"\] \.settings-mirror-scale \.rail \{ position: static;/.test(panelCss),
      "镜像内的栏剥 fixed 通高形态，随画布静态铺开");
    assert.ok(/:root\[data-ui-version="v2"\] \.settings-mirror-scale > \.telemetry-view \{ grid-column: 2; min-width: 0; \}/.test(panelCss),
      "看板镜像落右列第二行、吃掉栏外全部宽度，不超宽也不缩水");
    assert.ok(body.includes('document.querySelector("#mainHeadInner")'),
      "新版头行一并克隆进镜像（板内顶栏不再整条缺失）");
    assert.ok(/headClone\.removeAttribute\("hidden"\)/.test(body),
      "设置态真身主头行带 hidden 属性，克隆体必须剥掉否则整行不可见");
    assert.ok(/headWrap\.className = "site-head"/.test(body),
      "头行克隆外套 site-head 壳（皮肤玻璃底/底边线与 48px 高都锚 .site-head 祖先链）");
    assert.ok(/:root\[data-ui-version="v2"\]\[data-style\] \.settings-mirror-scale \.head-inner \.brand-group,\s*:root\[data-ui-version="v2"\]\[data-style\] \.settings-mirror-scale \.head-inner \.view-tabs,/.test(panelCss),
      "镜像头行克隆顶班 v2 id 锚收编规则：品牌组与旧 tab 条在克隆体里整隐");
    assert.ok(/:root\[data-ui-version="v2"\]\[data-style\] \.settings-mirror-scale \.head-inner \{\s*max-width: none; padding-left: 0; justify-content: flex-end;/.test(panelCss),
      "镜像头行剥栏让位（padding-left 0）、保持右对齐，与看板内容左缘对齐");
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
    assert.ok(sw[1].includes('$("mainHeadInner").hidden = settings || terminal;')
      && sw[1].includes('$("settingsHeadInner").hidden = !settings;'),
      "主头行、设置头行与终端页互斥切换");
    assert.ok(/if \(!settings && !terminal\) try \{ localStorage\.setItem\("panel-view", name\)/.test(sw[1]),
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
    assert.ok(init && init[0].includes('view === "terminal" ? $("terminalView")'),
      "开屏淡出后的入场动画覆盖终端页（漏一格就落在链尾的会话页上播）");
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

  // ── 终端页整页加载恢复（外部刷新不再弹回主页）──────────────────────────
  // 9-21 那次给设置页补的是「localStorage 标记 + 首帧预绘」；终端页 9-24 接进来时
  // 跟着设置页的旧规则一起被排除在视图恢复之外，于是「在终端页遭遇外部刷新直接回到
  // 主页」在同一条链上复现。三条红线在此钉死：标记优先序、返回目标不被终端页吃掉、
  // 活动标签按存档回读（否则多标签时永远落最早那个，看着就是「历史丢了」）。
  it("终端页存档：switchView 写两把键，panel-view 那份仍是主视图", () => {
    const sw = panelJs.match(/function switchView\(name\) \{([\s\S]*?)\n  \}/);
    assert.ok(sw, "switchView found in panel.js");
    assert.ok(sw[1].includes('localStorage.setItem("panel-terminal-open", terminal ? "1" : "0")'),
      "进终端页打标记、离开即清");
    assert.ok(/if \(!settings && !terminal\) try \{ localStorage\.setItem\("panel-view", name\)/.test(sw[1]),
      "终端页与设置页同样不占 panel-view——那份仍是设置页「←退出」的目标");
  });

  it("恢复决策实测：终端页标记优先于设置页，返回目标仍是主视图，首开两把键一起清", () => {
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

    // 停在终端页（进终端前在渠道页）：主视图先落位，终端页是最后一屏
    const onTerminal = run({ "panel-view": "store", "panel-settings-open": "0", "panel-terminal-open": "1" }, {});
    assert.deepEqual(onTerminal.calls, ["store", "terminal"], "先恢复主视图再落终端页");
    assert.strictEqual(onTerminal.settingsReturnView, "store", "终端页 ← 设置页 ← 渠道页，两跳返回目标都在");
    assert.strictEqual(onTerminal.restartEnterView, null, "普通刷新不记重启入场动画");

    // 两把键同时为真（存档被手改的形态）：按终端页走，不落设置页
    const both = run({ "panel-view": "board", "panel-settings-open": "1", "panel-terminal-open": "1" }, {});
    assert.deepEqual(both.calls, ["terminal"], "终端页标记压过设置页标记");

    // 面板服务重启后自动刷新回来：落终端页，入场动画记到终端视图
    const afterRestart = run({ "panel-view": "board", "panel-settings-open": "0", "panel-terminal-open": "1" }, { panelStartupRestart: true });
    assert.deepEqual(afterRestart.calls, ["terminal"], "重启回来仍在终端页");
    assert.strictEqual(afterRestart.restartEnterView, "terminal", "开屏淡出后播终端页入场");

    // 没停在终端页：标记为 0 / 值不是 1 一律不凭空进终端
    assert.deepEqual(run({ "panel-view": "stats", "panel-settings-open": "0", "panel-terminal-open": "0" }, {}).calls,
      ["stats"], "标记为 0 时只恢复主视图");
    assert.deepEqual(run({ "panel-view": "stats", "panel-settings-open": "0", "panel-terminal-open": "yes" }, {}).calls,
      ["stats"], "标记值不是 1 按未停进终端处理");

    // 设置页那条链逐条保持改前行为（本改动不许动它）
    const onSettings = run({ "panel-view": "store", "panel-settings-open": "1", "panel-settings-subtab": "theme" }, {});
    assert.deepEqual(onSettings.calls, ["store", "settings"], "设置页恢复链不受终端页分支影响");
    assert.strictEqual(onSettings.settingsSubTabToRestore, "theme", "子 tab 存档照常交棒");
    assert.strictEqual(onSettings.settingsReturnView, "store", "设置页返回目标仍取主视图");

    // launcher 首开：固定落看板，两把键一起清——留着任何一把，本页第一次刷新就跳进去
    const launched = run({ "panel-view": "store", "panel-settings-open": "1", "panel-terminal-open": "1" }, { panelStartupLaunch: true });
    assert.deepEqual(launched.calls, [], "首开不恢复，停在看板");
    assert.strictEqual(launched.store["panel-settings-open"], "0", "首开清设置页标记");
    assert.strictEqual(launched.store["panel-terminal-open"], "0", "首开清终端页标记");
  });

  it("活动标签按存档回读：存档在册优先，认不到才回落第一个并改写存档", () => {
    const srcOf = (name) => {
      const src = panelJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
      assert.ok(src, `${name} found in panel.js`);
      return src;
    };
    const bodies = ["storedTerminalSessionId", "rememberTerminalSessionId",
      "terminalBackendSession", "rebuildTerminalBackendSessions", "pruneTerminalHollowStreak"].map(srcOf).join("\n");
    // 整页加载把内存里的活动 id 打回预览稿遗留的初值 "checkout"，这就是恢复的起点。
    const run = (store, items, initialId = "checkout") => new Function("store", "items", "initialId", `
      let activeTerminalPreviewId = initialId;
      let terminalBackendSessions = {};
      const localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = v; },
        removeItem: (k) => { delete store[k]; },
      };
      let terminalDefaultCwd = "";
      // 空壳防抖计数表（rebuild 重建后清掉已消失会话的计数）：桩环境给空表即可
      const terminalHollowStreak = new Map();
      const terminalPreviewSessions = {};
      ${bodies}
      rebuildTerminalBackendSessions(items);
      return { active: activeTerminalPreviewId, ids: Object.keys(terminalBackendSessions) };
    `)(store, items, initialId);
    const three = [{ id: "t-old" }, { id: "t-mid" }, { id: "t-new" }];

    const remembered = run({ "panel-terminal-session": "t-mid" }, three);
    assert.strictEqual(remembered.active, "t-mid", "刷新后回到刷新前看着的那个标签，而不是最早创建的");

    const staleStore = { "panel-terminal-session": "t-gone" };
    const stale = run(staleStore, three);
    assert.strictEqual(stale.active, "t-old", "存档里的会话已被别处关掉 → 回落第一个");
    assert.strictEqual(staleStore["panel-terminal-session"], "t-old", "回落即改写存档，不留失效值再踩一次");

    const freshStore = {};
    run(freshStore, three);
    assert.strictEqual(freshStore["panel-terminal-session"], "t-old", "没有存档时仍是第一个（改前行为），并把落定的 id 记进存档");

    const goneStore = { "panel-terminal-session": "t-gone" };
    const none = run(goneStore, []);
    assert.strictEqual(none.active, null, "零会话不硬造活跃标签");
    assert.ok(!("panel-terminal-session" in goneStore), "零会话即摘存档，下次恢复不认领不存在的会话");

    // 预览稿假 id 不进存档：降级下点「+」产的 "preview-N" 服务端根本不认
    const previewStore = {};
    new Function("store", `
      const localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = v; },
        removeItem: (k) => { delete store[k]; },
      };
      ${srcOf("rememberTerminalSessionId")}
      rememberTerminalSessionId("preview-1");
      rememberTerminalSessionId("t-real");
    `)(previewStore);
    assert.ok(!("panel-terminal-session" in previewStore) || previewStore["panel-terminal-session"] === "t-real",
      "preview- 一律当无值处理，真 id 才写档");
  });

  // ── 首帧视图落位：整页加载不再先画出看板 ──────────────────────────────
  // 主脚本是 defer 外链，restoreView 落位必然晚于首绘，而 HTML 的静态默认是看板。
  // panel.html 的 panelViewPrepaint 于绘制前把目标屏写在 <html> 上，panel.css 的
  // 「首帧视图落位」段负责那一帧显隐。三条红线在此钉死：
  // ① 首帧目标与 restoreView 落定目标逐一相等——两边不一致本身就是新的闪烁；
  // ② CSS 的显示取值等于各容器自身的 display——凭印象写就会首帧布局走形；
  // ③ switchView 摘属性的时机在 hidden 赋值之后、进入钩子之前。
  // ④ 子 tab 名单与 panel.js 的注册表同源——注册了新格子却漏了首帧规则，就会
  //    在「停在高级选项 → 重新加载」时先闪出通用。
  const PREPAINT_SUB_TABS = ["general", "advanced", "route", "theme", "about"];
  const registeredSubTabs = [...panelJs.matchAll(/^ {6}([a-z]+): \["settingsTab[A-Za-z]+", "settingsPanel[A-Za-z]+"\],$/gm)].map((m) => m[1]);
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
    { name: "停在统计页", view: "stats", subTab: "overview",
      store: { "panel-view": "stats", "panel-settings-open": "0" } },
    { name: "停在统计页·请求日志子 tab", view: "stats", subTab: "logs",
      store: { "panel-view": "stats", "panel-settings-open": "0", "panel-stats-subtab": "logs" } },
    { name: "统计页子 tab 存档不在册 → 与 enterStatsView 同样回落总览", view: "stats", subTab: "overview",
      store: { "panel-view": "stats", "panel-settings-open": "0", "panel-stats-subtab": "nope" } },
    { name: "停在会话页", view: "sessions", subTab: null,
      store: { "panel-view": "sessions", "panel-settings-open": "0" } },
    { name: "停在终端页（进终端前在渠道页）", view: "terminal", subTab: null,
      store: { "panel-view": "store", "panel-settings-open": "0", "panel-terminal-open": "1" } },
    { name: "停在终端页且设置页标记也在（存档被手改）→ 终端页优先", view: "terminal", subTab: null,
      store: { "panel-view": "board", "panel-settings-open": "1", "panel-settings-subtab": "theme", "panel-terminal-open": "1" } },
    { name: "终端页标记值不是 1 → 按主视图走，不凭空进终端", view: "stats", subTab: "overview",
      store: { "panel-view": "stats", "panel-settings-open": "0", "panel-terminal-open": "yes" } },
    { name: "停在终端页时子 tab 存档不参与首帧（首帧是终端页本身）", view: "terminal", subTab: null,
      store: { "panel-view": "sessions", "panel-settings-open": "0", "panel-settings-subtab": "about", "panel-terminal-open": "1" } },
    { name: "launcher 首开固定落看板（终端页标记同属上一次会话）", view: "board", subTab: null,
      store: { "panel-view": "store", "panel-settings-open": "0", "panel-terminal-open": "1" },
      win: { panelStartupLaunch: true } },
    { name: "面板服务重启后的自动刷新回终端页", view: "terminal", subTab: null,
      store: { "panel-view": "board", "panel-settings-open": "0", "panel-terminal-open": "1" },
      win: { panelStartupRestart: true } },
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
      // 拿不到有效存档时的回落同一格。统计页同理：默认露出「总览」（overview），
      // 落定侧是 enterStatsView 读 panel-stats-subtab（仅 "logs" 切日志页）。
      const jsSub = out.currentView === "settings"
        ? (PREPAINT_SUB_TABS.includes(out.settingsSubTabToRestore) ? out.settingsSubTabToRestore : "general")
        : out.currentView === "stats"
          ? (c.store["panel-stats-subtab"] === "logs" ? "logs" : "overview")
          : null;
      const paintSub = attrs["data-prepaint-subtab"]
        ?? (out.currentView === "settings" ? "general" : out.currentView === "stats" ? "overview" : null);
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
    assert.deepEqual(scriptSubTabs, PREPAINT_SUB_TABS, "脚本子 tab 清单与 panel.js 的五个子 tab 同");
    assert.deepEqual(scriptSubTabs, registeredSubTabs,
      "首帧在册的子 tab 必须与 settingsSubTabs 注册表逐格同（漏一格就是那一格仍然闪）");

    // 容器自身的 display（class 规则 + id 规则，都没有即 block）
    const ownDisplay = (id) => {
      const tag = (panelHtml.match(new RegExp(`<(?:section|div|button|nav)[^>]*id="${id}"[^>]*>`)) || [])[0];
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
    assert.ok(reveals.length >= 12,
      `取得显示侧规则 ${reveals.length} 条，少于六主视图+终端页+设置头行+四块子面板`);
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
    // 终端页整页形态：body.terminal-mode 那四条要等 switchView 挂类，首帧没有类，
    // 必须按属性前缀重述一遍——漏一条就是「首帧带着站点头与页脚、落定后整屏跳一次」。
    assert.ok(/html\[data-prepaint-view="terminal"\] #mainHeadInner \{ display: none; \}/.test(block),
      "首帧收起主头行（终端页）");
    for (const probe of [
      /html\[data-prepaint-view="terminal"\] body \{ overflow: hidden; \}/,
      /html\[data-prepaint-view="terminal"\] body header\.site-head \{ display: none; \}/,
      /html\[data-prepaint-view="terminal"\] body > footer \{ display: none; \}/,
      /html\[data-prepaint-view="terminal"\] body main\.layout-container \{ max-width: none; padding: 0; margin: 0; \}/,
    ]) {
      assert.ok(probe.test(block), `终端页首帧整页形态缺一条：${probe.source}`);
    }
    // v2 的终端首帧按栏态分档重述左让：窄栏让 72（基座规则无下界，任何窗口宽度都让），
    // 宽档在 ≥1200 让 216——首帧即落定态，整屏不跳。
    assert.ok(/html\[data-prepaint-view="terminal"\]\[data-ui-version="v2"\] body main\.layout-container \{ padding-left: 72px; \}/.test(block),
      "v2 终端页窄栏首帧左让 72px（图标栏），与落定态同值");
    assert.ok(/@media \(min-width: 1200px\) \{\s*html\[data-prepaint-view="terminal"\]\[data-ui-version="v2"\] body main\.layout-container \{ padding-left: 216px; \}/.test(block),
      "v2 终端页宽档首帧左让 216px（全栏），与落定态同值");
    // 终端页的会话级静态种子（设计稿遗留）首帧一律不露
    const terminalSeedIs = (block.match(/:is\(([^)]*terminal-session-bar[^)]*)\)/) || [, ""])[1]
      .split(",").map((s) => s.trim().replace(/^[.#]/, "")).filter(Boolean);
    assert.deepEqual(terminalSeedIs, ["terminal-session-bar", "terminal-foot-status", "terminal-foot-stats", "terminalInspector"],
      "终端页首帧收起的静态种子名单：假会话栏 / 假底栏两段 / 假监测区");
    assert.ok(/html\[data-prepaint-view="terminal"\] \.terminal-workspace \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(block),
      "终端页首帧工作区收成单列（取值须与 .terminal-workspace.is-empty 逐字同）");
    assert.ok(/\.terminal-workspace\.is-empty \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(base),
      "运行时的 is-empty 单列规则仍是首帧那条的取值来源");
    // 五块子面板的整收起规则按内容认：块里现在不止一处 :is()，位置不再唯一
    const isList = (block.match(/:is\(([^)]*settingsPanelGeneral[^)]*)\)/) || [, ""])[1]
      .split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean);
    assert.deepEqual(isList, ["settingsPanelGeneral", "settingsPanelAdvanced", "settingsPanelRoute", "settingsPanelTheme", "settingsPanelAbout"],
      "子 tab 整体收起规则覆盖五块面板");
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
    // 结构（R-25 起）：enterStatsView 重置 reveal 标记后经 activateStatsSubTab
    // （{enter:true}）进总览分支——缓存热渲染（趋势+环）必须先于 refreshStatsState()
    const enter = panelJs.match(/function enterStatsView\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(enter, "enterStatsView found in panel.js");
    const enterBody = enter[1];
    const enterResetIdx = enterBody.indexOf("statsTrendPrev = null");
    const activateIdx = enterBody.indexOf("activateStatsSubTab(statsSubTabSaved, { enter: true })");
    assert.ok(enterResetIdx !== -1 && activateIdx !== -1 && enterResetIdx < activateIdx,
      "reveal flag reset before subtab activation on tab enter");
    // 回归根因：热渲染曾只有环形图，趋势图首渲等 refreshStatsState 的网络往返
    // 落地（实测热 300~500ms）才触发，reveal 起跑随之延迟同款时长。
    const act = panelJs.match(/function activateStatsSubTab\(which, opts\) \{([\s\S]*?)\n  \}/);
    assert.ok(act, "activateStatsSubTab found in panel.js");
    const body = act[1];
    const fetchIdx = body.indexOf("refreshStatsState()");
    const trendIdx = body.indexOf("renderStatsTrend()");
    const usageIdx = body.indexOf("renderStatsUsage()");
    assert.ok(fetchIdx !== -1, "overview branch kicks off the fetch");
    assert.ok(trendIdx !== -1 && trendIdx < fetchIdx, "trend hot-rendered from cache before the fetch");
    assert.ok(usageIdx !== -1 && usageIdx < fetchIdx, "donut hot-render preserved");
    // 日志子 tab 切回总览同属进 tab 范式（R-25）：热渲染前重置 reveal 标记
    const subResetIdx = body.indexOf("statsTrendPrev = null");
    assert.ok(subResetIdx !== -1 && subResetIdx < trendIdx, "subtab switch-back resets reveal flag before hot-render");
    // 接口落地重渲不打断在飞动画的兜底仍在：数据未变由同终点签名守卫整体跳过
    assert.ok(panelJs.includes("container._statsAnim.targetSig === renderStatsTrendSignature(cfg, statsChartWidth(container))"),
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
    // 渲染器顶层守卫：在飞动画存在时先比目标签名（画布宽+labels+series key/color/dash+values；
    // 宽入签为阶段 3 改动——viewBox 宽随容器实测后，resize 重渲同数据不同宽，不入签会被误跳），
    // 一致 → 整体 return 不重启 rAF；不一致或 reveal → 照旧取消重建。
    const fn = panelJs.match(/function renderStatsLineChart\(container, cfg, anim\) \{([\s\S]*?)\n  \}/);
    assert.ok(fn, "renderStatsLineChart found in panel.js");
    const head = fn[1];
    // 守卫必须在取消在飞 rAF 之前（否则动画已被杀，跳过无意义）
    const guardIdx = head.indexOf("renderStatsTrendSignature(cfg, statsChartWidth(container))");
    const cancelIdx = head.indexOf("cancelAnimationFrame(prevAnim.raf)");
    assert.ok(guardIdx !== -1, "same-target guard present in renderer head");
    assert.ok(cancelIdx !== -1 && guardIdx < cancelIdx,
      "guard runs before cancelling the in-flight rAF");
    // 签名函数存在且覆盖画布宽、轴与系列（值含在 series.values）
    assert.ok(panelJs.includes("function renderStatsTrendSignature(cfg, w)"),
      "signature helper defined (width included since stage 3)");
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
    assert.ok(m[1].includes("const agg = claudeAggregateMetrics(sessions, c.retiredMetrics);"), "claude 无聚合桶，由各会话行 + 退役账求和派生");
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

  it("claude 卡头有形态副行位，且与其他多实例卡同序、同渲染器", () => {
    const cardStart = panelHtml.indexOf('data-agent-id="claude"');
    const cardEnd = panelHtml.indexOf('data-agent-id="', cardStart + 20);
    const ccCard = panelHtml.slice(cardStart, cardEnd);
    assert.ok(cardStart > 0, "claude card container exists");
    assert.ok(ccCard.includes('id="ccSurfaceSummary"'), "卡头有形态副行位");
    assert.ok(
      ccCard.indexOf('id="ccInstanceCount"') < ccCard.indexOf('id="ccSurfaceSummary"'),
      "副行排在实例计数胶囊之后（与 DSH/Kimi 卡同序）",
    );

    const m = panelJs.match(/function renderClaude\(c\) \{[\s\S]*?\n  \}/);
    assert.ok(m, "renderClaude found in panel.js");
    assert.ok(m[0].includes('renderSurfaceSummary("cc", c.surfaces)'), "卡头副行按形态汇总");
    assert.ok(m[0].includes('renderSurfaceSummary("cc", [])'), "停止态显式清副行（CSS 不藏徽标，脏值会挂到下一轮）");
  });

  it("claudeAggregateMetrics 求和口径：累加项、prompt 加权缓存、最近会话 TTFT、退役账并表", () => {    const m = panelJs.match(/function claudeAggregateMetrics\(sessions, retired\) \{([\s\S]*?)\n  \}/);
    assert.ok(m, "claudeAggregateMetrics exists in panel.js");
    assert.ok(m[1].includes("tokens.prompt += tk.prompt || 0;"), "tokens 累加");
    assert.ok(m[1].includes("totalRequests += s.requests || 0;"), "请求数累加");
    assert.ok(m[1].includes("durationMs += s.activeDurationMs || 0;"), "工时累加");
    assert.ok(m[1].includes("if (typeof s.tps === \"number\" && s.tps > 0) tpsSum += s.tps;"), "tps 为各会话之和");
    assert.ok(m[1].includes("tokens.cached / tokens.prompt"), "缓存命中率按 prompt 加权");
    assert.ok(m[1].includes("(seen || 0) >= ttftSeen"), "TTFT 取最近有活动的会话");
    assert.ok(m[1].includes("totalRequests += ledger.requests || 0;"), "退役账请求数并入汇总");
    assert.ok(m[1].includes("tokens.prompt += ledger.promptTokens || 0;"), "退役账 tokens 并入汇总");
    assert.ok(m[1].includes("durationMs += ledger.activeDurationMs || 0;"), "退役账工时并入汇总");
    assert.ok(m[1].includes("seen >= ttftSeen"), "退役账 TTFT 与活行取最近");
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
    assert.ok(body.includes("paintCtxMeter(presets)"), "header occupancy meter painted from injected presets");
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
      fetchTerminalHostStatus: async () => null,
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
    const recovery = panelJs.slice(recoveryStart, panelJs.indexOf('document.addEventListener("anyswitch:self-update-swap"', recoveryStart));
    assert.ok(recovery.includes("dropStartupSplash()"), "恢复超时路径也要收回开屏");
    assert.ok(!recovery.includes("playStartupSplash()"), "恢复监视本身不得重复盖屏");
    // 自更新换装由 swap 事件接管：同一套恢复监视，但先播开屏定格盖住换装窗口——
    // 旧页面不播，新页面（startup=restart）的定格就没有接力来源，只剩无动画闪屏。
    const swapStart = panelJs.indexOf('document.addEventListener("anyswitch:self-update-swap"');
    const swap = panelJs.slice(swapStart, panelJs.indexOf("if (stopConfirmBtn)", swapStart));
    assert.ok(swap.includes("playStartupSplash()"), "自更新换装窗口先盖开屏再接恢复监视");
    assert.ok(swap.includes("watchPanelHostComeBack()"), "自更新换装仍走同一套恢复监视");
  });

  it("换装恢复页不再派换装事件、不再谎称即将刷新", () => {
    // 新页面就是换装的产物：再派 swap 事件会让恢复监视空等一次永远不会来的身份
    // 变化（超时后谎报重启失败）；结局渲染在新页面直接给最终结论，「页面即将刷新」
    // 只属于旧页面。
    assert.ok(panelJs.includes("swapSignal && !swapAnnounced && !window.panelStartupRestart"), "换装事件在重启恢复页上不得派发");
    // 换装信号不能只靠看到 ready-to-restart：服务端监听器在该相位落盘后一秒内就
    // 点火自退，页面轮询经常来不及看到——应用中轮询落空（面板已退场）必须也算数。
    assert.ok(/const atSwap = status === null \|\| status\?\.phase === "ready-to-restart" \|\| status\?\.phase === "waiting-panel";/.test(panelJs),
      "换装信号必须覆盖「应用中轮询落空」，否则开屏在真实时序下永远盖不上");
    assert.ok(/const swapSignal = sawApply && atSwap && \(status === null \|\| status\?\.state === "running"\);/.test(panelJs),
      "换装信号只在任务仍在跑时派发：终态帧不得触发恢复监视（空等一次不会来的退场）");
    // 一键任务（autoApply）从 download 一路跑到 apply：落空信号须等见过应用段
    // （step=apply 或换装相位）才武装，下载期一次网络抖动不得误盖开屏。
    assert.ok(panelJs.includes('if (status?.step === "apply" || status?.phase === "ready-to-restart" || status?.phase === "waiting-panel") sawApply = true;'),
      "落空换装信号须以「见过应用段」为武装条件");
    const outcomeStart = panelJs.indexOf('if (status?.outcome === "updated")', panelJs.indexOf("function renderSelfUpdateOutcome"));
    const outcome = panelJs.slice(outcomeStart, outcomeStart + 1500);
    assert.ok(outcome.includes("window.panelStartupRestart"), "updated 结局按「本页是否换装产物」分流");
    assert.ok(outcome.includes("anyswitch:self-update-shown:"), "新页面直接显示结论时记入已读，/last 不重复补显");
  });

  it("一键更新：一次确认覆盖下载+应用，应用接续在服务端 autoApply，前端不再代点", () => {
    // 确认弹层合并为一次：正文承诺「自动下载并应用」，确认键是「立即更新」，
    // 运行中 Agent 的中断警示从「应用」那次确认前移到这唯一的一次。
    const startStart = panelJs.indexOf("async function startSelfUpdate()");
    const start = panelJs.slice(startStart, panelJs.indexOf("async function applySelfUpdateRun", startStart));
    assert.ok(start.length > 500, "未真正取到 startSelfUpdate 函数体，后续断言会全部落空");
    assert.ok(start.includes('"立即更新"'), "一键更新的确认键");
    assert.ok(start.includes('fetchOnce("/api/agents")'), "运行中 Agent 的中断警示前移到首次确认");
    assert.ok(start.includes('trackSelfUpdate(started.runId, started.targetVersion || target, "staging", false)'),
      "一键 run 交给服务端 autoApply 流水线，前端只跟同一 runId 的进度");
    assert.ok(!panelJs.includes("oneClick"), "前端自动接续应用已收编进服务端，oneClick 标记不得残留");
    // 下载不再途经前端接续：downloaded 结局只属于自动下载的停留态（staged）。
    const outcomeStart = panelJs.indexOf("function renderSelfUpdateOutcome");
    const downloaded = panelJs.slice(panelJs.indexOf('status?.outcome === "downloaded"', outcomeStart), panelJs.indexOf('status?.outcome === "updated"', outcomeStart));
    assert.ok(downloaded.includes("renderSelfUpdateStaged()"), "downloaded（自动下载产物）落 staged 停留态");
    assert.ok(!downloaded.includes("applySelfUpdateRun(status)"), "下载完成不得再由前端接续应用");
    // 应用入口：手动「应用更新」仍走同一端点与 isApply 轮询。
    const applyStart = panelJs.indexOf("async function applySelfUpdateRun");
    const apply = panelJs.slice(applyStart, panelJs.indexOf("async function startSelfUpdateApply", applyStart));
    assert.ok(apply.includes('request("POST", "/api/self-update/apply"'), "apply 仍走同一端点");
    assert.ok(apply.includes('trackSelfUpdate(staged.runId, staged.targetVersion, "installing", true)'), "apply 以 isApply 模式接续轮询");
  });

  it("自更新捎带帧喂给页面级观察者：完成提示与换装接管在关于页之外也成立", () => {
    assert.ok(panelJs.includes("function createSelfUpdateFrameWatcher("), "观察者工厂在主脚本");
    const feedStart = panelJs.indexOf('lastPanelIdentity = { pid: res?.pid ?? null, startTime: res?.startTime ?? null };');
    const feed = panelJs.slice(feedStart, panelJs.indexOf('const dot = $("topDot");', feedStart));
    assert.ok(feed.includes("selfUpdateWatcher.frame(res?.selfUpdate ?? null)"), "状态帧把 selfUpdate 捎带喂给观察者（旧版服务端无字段喂 null）");
    assert.ok(panelJs.includes("selfUpdateWatcher.setAboutProbe("), "关于页跟踪探针接线：本页跟踪时观察者让位");
  });

  it("开屏动画关到「关」时，看板重启的复播入口整层不出", () => {
    // 真跑：把 startupAnimationEnabled 与 playStartupSplash 两段源码原样取出来，
    // 配上假 localStorage 与记录了调用次数的假 window，比复述它的逻辑更接近页面行为。
    const reader = (panelJs.match(/^ {2}function startupAnimationEnabled\(\) \{[\s\S]*?\n {2}\}/m) || [])[0];
    const entry = (panelJs.match(/^ {4}const playStartupSplash = \(\) => \{[\s\S]*?\n {4}\};/m) || [])[0];
    assert.ok(reader && entry, "未真正取到 startupAnimationEnabled 与 playStartupSplash，后续断言会全部落空");
    for (const [stored, begins] of [[null, 1], ["1", 1], ["0", 0], ["denied", 1]]) {
      let begun = 0, played = 0;
      const localStorage = stored === "denied"
        ? { getItem: () => { throw new Error("denied"); }, setItem() {} }
        : { getItem: () => stored, setItem() {} };
      vm.runInNewContext(`${reader};\n${entry}\nplayStartupSplash();`, {
        localStorage,
        window: { panelStartupBegin: () => { begun += 1; }, panelStartupPlay: () => { played += 1; } },
        PANEL_RESTART_RECOVERY_TIMEOUT_MS: 20_000,
      });
      assert.equal(begun, begins, `${String(stored)}：起层次数`);
      assert.equal(played, begins, `${String(stored)}：不起层就不播动画`);
    }
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

  // 逐渠道刷完即时上屏：后端本就是一渠道一请求、发现完即落盘，前端此前把唯一一次
  // 重渲压在整轮循环之外，行/详情卡要等全部渠道跑完才更新。
  it("逐渠道刷完即时上屏：内层循环里取最新状态重渲，不攒到整轮结束", () => {
    const fnStart = panelJs.indexOf("async function storeRefresh(");
    const fn = panelJs.slice(fnStart, panelJs.indexOf("// ── 新增渠道 modal", fnStart));
    const innerStart = fn.indexOf("for (const id of unit.ids)");
    assert.ok(innerStart >= 0, "逐渠道内层循环存在");
    const inner = fn.slice(innerStart, fn.indexOf("refreshDiffUnits.push({", innerStart));
    assert.ok(inner.includes("await refreshStoreModelsView()"), "每个渠道刷完立刻上屏");
    assert.ok(inner.indexOf("markStoreNewModels(") < inner.indexOf("await refreshStoreModelsView()"),
      "先登记待读新增再上屏，高亮才带得出来");
    assert.ok(fn.includes("await refreshStoreState()"), "收尾仍走整轮全量重渲（列表行/路由链归位）");
    const viewStart = panelJs.indexOf("function refreshStoreModelsView()");
    assert.ok(viewStart >= 0, "轻量上屏函数存在");
    const view = panelJs.slice(viewStart, panelJs.indexOf("// 渠道配置读不出来时的四种情形", viewStart));
    assert.ok(view.includes('api("GET", "/api/store/state")'), "上屏只取渠道状态");
    assert.ok(view.includes("renderStoreOverview()") && view.includes("renderStoreDetail()"),
      "只重渲总览计数与详情卡模型列表");
    assert.ok(!view.includes("renderStoreList()") && !view.includes("renderRouteChains()"),
      "列表行与路由链与模型缓存无关，不重渲");
    assert.ok(view.includes("storeRefreshChain.then("), "并入同一条串行链，旧响应不盖新状态");
    assert.ok(panelJs.includes("function applyStoreState("), "状态落库/reconcile 抽出共用");
    assert.equal((panelJs.match(/applyStoreState\(res\);/g) || []).length, 2, "两条取状态路径共用 reconcile");
  });

  it("本轮在途不消费新增高光，收尾全量重渲才消费", () => {
    const detailStart = panelJs.indexOf("function renderProviderDetail(");
    const detail = panelJs.slice(detailStart, panelJs.indexOf("function bindStoreDetail(", detailStart));
    assert.ok(detail.includes("if (highlight && !storeRefreshInFlight) consumeStoreNewModels(p.id)"),
      "在途期间只渲染不消费（逐渠道上屏反复重渲不会抹掉焦点渠道的高光）");
    const fnStart = panelJs.indexOf("async function storeRefresh(");
    const fn = panelJs.slice(fnStart, panelJs.indexOf("// ── 新增渠道 modal", fnStart));
    const onAt = fn.indexOf("storeRefreshInFlight = true");
    const offAt = fn.indexOf("storeRefreshInFlight = false");
    const finalAt = fn.indexOf("await refreshStoreState()");
    assert.ok(onAt >= 0 && onAt < offAt, "整轮开始置在途标记");
    assert.ok(offAt >= 0 && offAt < finalAt, "撤标记在收尾重渲之前，收尾那次才消费");
    assert.equal((fn.match(/storeRefreshInFlight = false/g) || []).length, 2, "收尾与中断各撤一次");
  });

  it("号池刷新小字保持池粒度：刷期间不逐成员替换，池聚合落单元收尾", () => {
    const fnStart = panelJs.indexOf("async function storeRefresh(");
    const fn = panelJs.slice(fnStart, panelJs.indexOf("// ── 新增渠道 modal", fnStart));
    const innerStart = fn.indexOf("for (const id of unit.ids)");
    const inner = fn.slice(innerStart, fn.indexOf("refreshDiffUnits.push({", innerStart));
    assert.ok(inner.includes("await refreshStoreModelsView()"), "逐渠道上屏保留（行为逐成员，文案不逐成员）");
    assert.ok(!inner.includes("setStoreRefreshStatus"), "刷期间不逐成员替换小字");
    assert.ok(!inner.includes("lastTail"), "内层循环不更新 tail，池名持续到单元收尾");
    assert.ok(!panelJs.includes("chanResultHtml"), "逐成员结果渲染助手已撤，无死代码残留");
    assert.ok(fn.includes("? `${escapeHtml(unit.label)} ${storeAggregateHtml(uAdded, uPruned, uFail)}`"),
      "单元收尾仍落池聚合，完成态 tail 用池口径");
    assert.ok(fn.includes('if (!wholeLabel) setStoreRefreshStatus("正在刷新..", "busy", lastTail)'),
      "号池详情路径单元收尾同样不覆盖，完成态才落池结果");
  });

  it("「手动添加」草稿跨重渲保留，换渠道丢弃", () => {
    const start = panelJs.indexOf("function captureStoreManualDraft(");
    assert.ok(start >= 0, "草稿存取函数存在");
    const cap = panelJs.slice(start, panelJs.indexOf("function renderStoreDetail()", start));
    assert.ok(cap.includes("storeDetailRenderedId"), "草稿记所属渠道");
    assert.ok(cap.includes("el.selectionStart") && cap.includes("document.activeElement === el"),
      "连光标与焦点一起存");
    const detailStart = panelJs.indexOf("function renderStoreDetail()");
    const detail = panelJs.slice(detailStart, panelJs.indexOf("function renderPoolDetail(", detailStart));
    assert.ok(detail.indexOf("captureStoreManualDraft()") < detail.indexOf("renderPoolDetail(row)"),
      "渲染前先存草稿（池详情会先重建外层容器）");
    assert.ok(detail.includes("restoreStoreManualDraft(draft, storeDetailRenderedId)"), "渲染后按渠道恢复");
    assert.ok(panelJs.includes("if (!draft || draft.providerId !== renderedId) return;"), "换渠道不搬草稿");
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
    const dir = mkTestDir("anyswitch-panel-effort-");
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

describe("设置项「开屏动画」", () => {
  // 真跑注入块：把 startupAnimationEnabled 与 if (startupAnimationToggle) {...} 两段
  // 源码原样取出来配假 localStorage 执行——回显与写档是这个设置项的全部行为，
  // 复述逻辑就等于没测。
  function runStartupToggleRow(stored, nextChecked) {
    const reader = (panelJs.match(/^ {2}function startupAnimationEnabled\(\) \{[\s\S]*?\n {2}\}/m) || [])[0];
    const wiring = (panelJs.match(/^ {4}if \(startupAnimationToggle\) \{[\s\S]*?\n {4}\}/m) || [])[0];
    assert.ok(reader && wiring, "未真正取到 startupAnimationEnabled 与开关注入块，后续断言会全部落空");
    const writes = [];
    const store = { "panel-startup-animation": stored }; // stored 为 null 即从未设过（缺省）
    const toggle = { checked: false, onchange: null };
    vm.runInNewContext(`${reader};\n${wiring}`, {
      startupAnimationToggle: toggle,
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { writes.push([k, v]); },
      },
    });
    const shown = toggle.checked;
    assert.equal(typeof toggle.onchange, "function", "开关接上了 onchange");
    toggle.checked = nextChecked;
    toggle.onchange();
    return { shown, writes, wiring };
  }

  it("回显按存档、点一下把新值写回存档", () => {
    assert.equal(runStartupToggleRow(null, true).shown, true, "缺省视为开——升级上来的安装行为不变");
    assert.equal(runStartupToggleRow("1", false).shown, true);
    assert.equal(runStartupToggleRow("0", true).shown, false);
    assert.deepEqual(runStartupToggleRow("1", false).writes, [["panel-startup-animation", "0"]], "关下去写 \"0\"");
    assert.deepEqual(runStartupToggleRow("0", true).writes, [["panel-startup-animation", "1"]], "开回来写 \"1\"");
  });

  it("本机偏好不占服务端设置：注入块里没有 POST、保存态与回滚", () => {
    // 钉住这个承载面：开屏在绘制前就要决定出不出，等服务端存档就赶不上那一帧。
    // 以后若真要把它挪进 /api/settings，得先解决绘制前的同步读，不该由这颗开关顺手带。
    assert.doesNotMatch(runStartupToggleRow(null, false).wiring, /api\(|settingsSaving|settingsLoadGen|aria-busy|toast\(/,
      "逐控件即时写本地存档，不进服务端保存链");
  });

  it("行在「显示」卡内、排在「UI版本」之后，沿用同一套 .toggle 控件", () => {
    const atSeg = panelHtml.indexOf('id="uiVersionSeg"');
    const atStartup = panelHtml.indexOf('id="startupAnimationToggle"');
    const atSpark = panelHtml.indexOf('id="sparkWindowInput"');
    const atKeepAlive = panelHtml.indexOf('id="keepAliveToggle"');
    assert.ok(atSeg > 0 && atSeg < atStartup && atStartup < atSpark && atSpark < atKeepAlive,
      "新行落在「显示」卡内、「抗截断」卡之前，卡内顺序 UI版本 → 开屏动画 → 折线视窗节点数");
    const row = panelHtml.slice(panelHtml.lastIndexOf('<div class="modal-item">', atStartup), atStartup + 200);
    assert.ok(row.includes('<label class="toggle">'), "沿用设置页既有开关控件");
    // 卡数口径不变：开屏动画与折线视窗节点数两行只是搬进「显示」卡，通用仍是六张卡。
    const general = panelHtml.slice(panelHtml.indexOf('id="settingsPanelGeneral"'), panelHtml.indexOf('id="settingsPanelRoute"'));
    assert.strictEqual((general.match(/<div class="panel-card">/g) || []).length, 6, "通用六张卡");
    assert.ok(panelHtml.includes("「通用」：按语义分六张卡"), "卡上注释的卡数跟着改到六张");
  });

  it("说明文案就是用户拍板的那两句，不出现字段名也不替用户判断", () => {
    const desc = panelHtml.match(/<div class="modal-item-title">开屏动画<\/div>\s*<div class="modal-item-desc">([^<]*)<\/div>/);
    assert.ok(desc, "行标题「开屏动画」与说明在册");
    assert.equal(desc[1], "关闭时不展示开屏动画；开启时，打开面板与看板重启后展示开屏动画。");
    assert.doesNotMatch(desc[1], /[A-Za-z]+_[A-Za-z]+|[a-z]+[A-Z][A-Za-z]+|panel-startup-animation|localStorage/,
      "正文不出现标识符、字段名与承载面");
    assert.doesNotMatch(desc[1], /默认|建议|更快|更稳|代价/, "不写变更日志口吻、不替用户判断");
  });
});

describe("设置项「UI版本」", () => {
  // 与「开屏动画」同一取法：把 newUiEnabled 与 if (uiVersionSeg) {...} 两段源码
  // 原样取出配假 localStorage/document/分段钮执行——回显、写档、属性改写是这个
  // 设置项的全部行为，复述逻辑就等于没测。
  function runUiVersionSeg(stored, clickChoice) {
    const reader = (panelJs.match(/^ {2}function newUiEnabled\(\) \{[\s\S]*?\n {2}\}/m) || [])[0];
    const wiring = (panelJs.match(/^ {4}if \(uiVersionSeg\) \{[\s\S]*?\n {4}\}/m) || [])[0];
    assert.ok(reader && wiring, "未真正取到 newUiEnabled 与分段钮注入块，后续断言会全部落空");
    const writes = [];
    const store = {};
    if (stored != null) store["panel-ui-version"] = stored;
    const rootAttrs = {};
    const mkBtn = (choice) => ({
      dataset: { uiVersionChoice: choice },
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      onclick: null,
    });
    const btns = [mkBtn("classic"), mkBtn("v2")];
    vm.runInNewContext(`${reader};\n${wiring}`, {
      uiVersionSeg: { querySelectorAll: () => btns },
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = v; writes.push(["set", k, v]); },
        removeItem: (k) => { delete store[k]; writes.push(["remove", k]); },
      },
      document: { documentElement: {
        setAttribute: (k, v) => { rootAttrs[k] = v; },
        removeAttribute: (k) => { delete rootAttrs[k]; },
      } },
    });
    const echo = btns.map((b) => b.attrs["aria-checked"]);
    if (clickChoice != null) {
      const btn = btns.find((b) => b.dataset.uiVersionChoice === clickChoice);
      assert.equal(typeof btn.onclick, "function", `「${clickChoice}」钮接上了 onclick`);
      btn.onclick();
    }
    return { echo, btns, writes, rootAttrs };
  }

  it("回显按存档：缺省旧版高亮、存档 v2 新版高亮", () => {
    assert.deepEqual(runUiVersionSeg(null, null).echo, ["true", "false"], "缺省旧版——升级上来的安装界面不变");
    assert.deepEqual(runUiVersionSeg("v2", null).echo, ["false", "true"]);
  });

  it("点选写档并当帧改写 <html> 属性，高亮跟着移动", () => {
    const on = runUiVersionSeg(null, "v2");
    assert.deepEqual(on.writes, [["set", "panel-ui-version", "v2"]], "选新版写 \"v2\"");
    assert.equal(on.rootAttrs["data-ui-version"], "v2", "选新版立刻挂上属性，看板当帧换列");
    assert.deepEqual(on.btns.map((b) => b.attrs["aria-checked"]), ["false", "true"], "高亮移到新版");
    const off = runUiVersionSeg("v2", "classic");
    assert.deepEqual(off.writes, [["remove", "panel-ui-version"]], "选回旧版删存档、不落冗余值");
    assert.ok(!("data-ui-version" in off.rootAttrs), "选回旧版摘掉属性，回到 CSS 默认旧版");
    assert.deepEqual(off.btns.map((b) => b.attrs["aria-checked"]), ["true", "false"], "高亮移回旧版");
  });

  it("本机偏好不占服务端设置：注入块里没有 POST、保存态与回滚，也没有 toast", () => {
    // 与开屏动画同一承载面：首帧布局必须由 head 脚本同步读存档决定，等服务端就晚了。
    // 不带 toast：选中枚高亮当帧移动本身就是反馈（同设置页子 tab）。
    const wiring = (panelJs.match(/^ {4}if \(uiVersionSeg\) \{[\s\S]*?\n {4}\}/m) || [])[0];
    assert.ok(wiring, "未取到分段钮注入块");
    assert.doesNotMatch(wiring, /api\(|settingsSaving|settingsLoadGen|aria-busy|toast\(/,
      "点选即时写本地存档，不进服务端保存链");
  });

  it("绘制前落位：head 脚本读同一条存档，旧版不写属性", () => {
    const boot = panelHtml.slice(0, panelHtml.indexOf("</head>"));
    assert.ok(boot.includes('localStorage.getItem("panel-ui-version") === "v2"'),
      "head 预绘脚本读 panel-ui-version");
    assert.ok(boot.includes('document.documentElement.setAttribute("data-ui-version", "v2")'),
      "存档为 v2 时在绘制前挂上 data-ui-version，首帧不闪旧版");
    assert.ok(!boot.includes('setAttribute("data-ui-version", "classic")'),
      "旧版是 CSS 默认态，不落冗余属性值");
  });

  it("新版主导航进左栏：栏体默认整隐，新版定宽 fixed、右区统一让位", () => {
    assert.ok(/\.rail \{ display: none; \}/.test(panelCss), "旧版整栏整隐");
    assert.ok(/:root\[data-ui-version="v2"\] \.rail \{[\s\S]*?position: fixed;[\s\S]*?width: 72px;[\s\S]*?\}/.test(panelCss),
      "新版栏 fixed 定宽通高（基座=窄栏 72px 图标栏，任何窗口宽度都常驻、不整栏消失）");
    // 右区让位按栏态分档：宽档（≥1200px）栏占 240、窄栏（<1200px）图标栏占 96——
    // 栏在任何窗口宽度都常驻，窄栏让位就是基座规则（无媒体查询、无下界）。
    const wideLayoutRule = ':root[data-ui-version="v2"] .layout-container { max-width: calc(1440px + 216px); padding-left: 240px; }';
    const atWideLayout = panelCss.indexOf(wideLayoutRule);
    assert.ok(atWideLayout > 0 && panelCss.indexOf(wideLayoutRule, atWideLayout + 1) < 0, "宽档让位规则全站只有一处");
    assert.ok(panelCss.lastIndexOf("@media (min-width: 1200px) {", atWideLayout) > 0,
      "宽档让位收在 min-width:1200 断点内，内容有效宽度与旧版一致仍是 1392");
    assert.ok(panelCss.includes(':root[data-ui-version="v2"] .layout-container { max-width: calc(1440px + 72px); padding-left: 96px; }'),
      "窄栏让位规则在册（基座，无媒体查询）");
    assert.ok(panelCss.includes(':root[data-ui-version="v2"] body.terminal-mode main.layout-container { max-width: none; padding-left: 216px; }')
      && panelCss.includes(':root[data-ui-version="v2"] body.terminal-mode main.layout-container { max-width: none; padding-left: 72px; }'),
      "终端页保留全屏形态：分档规则重述 max-width:none（否则分档让位规则的 0-3-0 会压过 v1 terminal-mode 的 0-2-2），只让栏宽");
    assert.ok(/:root\[data-ui-version="v2"\] #mainHeadInner \.view-tabs,[\s\S]*?head-meta-strip \.icon-btn \{ display: none; \}/.test(panelCss),
      "新版头行的主 tab 与设置/亮暗钮让位给栏");
    assert.ok(panelCss.includes(':root[data-ui-version="v2"] #settingsThemeToggle,'), "设置页亮暗钮让位");
    assert.ok(panelCss.includes(':root[data-ui-version="v2"] #terminalThemeToggle { display: none; }'), "终端页亮暗钮让位");
    assert.ok(panelCss.includes(':root[data-ui-version="v2"] #mainHeadInner .brand-group { display: none; }'),
      "头行品牌让位给栏顶那一份，同一枚 logo 不留两处");
    assert.ok(/:root\[data-ui-version="v2"\] #mainHeadInner \{ justify-content: flex-end; \}/.test(panelCss),
      "头行只剩状态条后右对齐，不贴栏沿");
  });

  it("新版终端页首帧：预绘制链按栏态分档重述左让，首帧即落定态", () => {
    // 首帧没有 body.terminal-mode 类，落定态那条（:root[v2] body.terminal-mode …）不命中；
    // 两个标记同在 <html> 上，同链即可命中。窄栏让 72 是基座规则（无下界），宽档在
    // ≥1200 分档重述 216。
    assert.ok(/html\[data-prepaint-view="terminal"\]\[data-ui-version="v2"\] body main\.layout-container \{ padding-left: 72px; \}/.test(panelCss),
      "预绘制链有窄栏 v2 终端补充规则（72px 图标栏），与落定态一致");
    const wide = panelCss.match(/@media \(min-width: 1200px\) \{\s*html\[data-prepaint-view="terminal"\]\[data-ui-version="v2"\] body main\.layout-container \{([^}]*)\}/);
    assert.ok(wide, "预绘制链有宽档（min-width:1200）v2 终端补充规则");
    assert.ok(wide[1].includes("padding-left: 216px;"), "宽档首帧左让 216px（全栏），与落定态一致");
    assert.ok(!panelCss.includes('html[data-prepaint-view="terminal"][data-ui-version="v2"] body main.layout-container { max-width: none; padding-left: 216px; }'),
      "旧的不分档 v2 终端预绘制规则已按栏态分档（否则窄窗口首帧多让 216px）");
  });

  it("左栏版式：栏顶品牌、七枚图标 tab 贴栏底、最底一行左亮暗右设置（图标+文字）", () => {
    const rail = panelHtml.match(/<aside class="rail" id="v2Rail"[\s\S]*?<\/aside>/);
    assert.ok(rail, "左栏在册");
    const body = rail[0];
    const atBrand = body.indexOf('class="rail-brand"');
    const atTabs = body.indexOf('class="rail-tabs"');
    const atFoot = body.indexOf('class="rail-foot"');
    assert.ok(atBrand > 0 && atBrand < atTabs && atTabs < atFoot, "栏内自上而下：品牌 → tab 组 → 底行");
    assert.ok(/\.rail-tabs \{ display: flex; flex-direction: column; gap: 2px; margin-top: auto; \}/.test(panelCss),
      "tab 组靠 margin-top:auto 贴栏底，上方留白");
    assert.ok(panelCss.includes('.rail-foot { margin-top: 12px;'), "底行不再吃 auto，紧跟 tab 组");
    const tabs = [...body.matchAll(/<button class="rail-tab(?: active)?" id="(railTab\w+)" role="tab" aria-selected="(?:true|false)"([^>]*)>([\s\S]*?)<\/button>/g)];
    assert.deepEqual(tabs.map((m) => m[1]),
      ["railTabBoard", "railTabSkills", "railTabPresets", "railTabSessions", "railTabStore", "railTabStats", "railTabTerminal"],
      "七 tab 依次在册（终端垫底），中间四项不带「管理」，模型管理在使用统计之上");
    const labels = tabs.map((m) => (m[3].match(/<span class="rail-tab-label">([^<]+)<\/span>/) || [])[1]);
    assert.deepEqual(labels, ["看板", "Skills", "预设", "会话", "模型管理", "使用统计", "虚拟终端"],
      "标签文本全部为既有词汇，文字包 span 供图标栏整隐");
    for (const [i, m] of tabs.entries()) {
      const atLabel = m[3].indexOf('<span class="rail-tab-label">');
      // 预设/会话两枚图标原样搬自阶段 6 原型（用户从那三份原型里唯独看中这两个）：
      // 原型用的不是 feather SVG 而是 Unicode 字形 ❑/☰，故这两枚按原型形制为裸字形，
      // 其余五枚仍为既有 feather 风 SVG（24 视窗、空心描边、round caps）。
      const glyph = { railTabPresets: "❑", railTabSessions: "☰" }[m[1]];
      if (glyph) {
        assert.ok(m[3].indexOf(glyph) >= 0 && m[3].indexOf(glyph) < atLabel, `${m[1]} 图标为原型字形 ${glyph}、在文字前`);
      } else {
        const atSvg = m[3].indexOf("<svg");
        assert.ok(atSvg >= 0 && atSvg < atLabel, `${m[1]} 图标在文字前`);
        assert.ok(m[3].includes('viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'),
          `${m[1]} 图标与既有齿轮/日月同一 feather 风（24 视窗、空心描边、round caps）`);
      }
      // 悬停提示=标签文本（10-14 用户拍板：栏位标签即用产品正式名「虚拟终端」，
      // 与看板入口卡同名，title 与标签一致）
      const wantTitle = labels[i];
      assert.ok(m[2].includes(`title="${wantTitle}"`), `${m[1]} 的 title=${wantTitle}（图标栏悬停提示）`);
    }
    assert.ok(tabs[0][2].includes('aria-current="page"'), "静态默认高亮的看板 tab 带 aria-current");
    // 头行 tab 旧名不动：旧版布局原样保留
    for (const [id, label] of [["tabSkills", "Skills 管理"], ["tabPresets", "预设管理"], ["tabStore", "渠道管理"], ["tabSessions", "会话管理"]]) {
      assert.ok(panelHtml.includes(`id="${id}" role="tab" aria-selected="false">${label}</button>`), `头行 ${label} 原样保留`);
    }
    const foot = (body.match(/<div class="rail-foot">([\s\S]*?)<\/div>\s*<\/aside>/) || [])[1] || "";
    assert.ok(foot.indexOf('id="railThemeToggle"') >= 0 && foot.indexOf('id="railThemeToggle"') < foot.indexOf('id="railSettingsBtn"'),
      "栏底先亮暗（左）后设置（右）");
    assert.ok(/id="railSettingsBtn"[\s\S]*?<svg[\s\S]*?<\/svg>\s*<span class="rail-tab-label">设置<\/span>/.test(foot),
      "设置钮图标在左、文字在右（文字带 rail-tab-label，图标栏随标签一起收起）");
    assert.ok(foot.includes('id="railIcoMoon"') && foot.includes('id="railIcoSun"'), "亮暗钮日月图标在册");
  });

  it("左栏栏顶品牌：与头行同一枚 logo，版本徽标与头行同源同显隐口径", () => {
    const rail = panelHtml.match(/<aside class="rail" id="v2Rail"[\s\S]*?<\/aside>/)[0];
    const brand = rail.slice(rail.indexOf('<div class="rail-brand">'), rail.indexOf('</div>\n  <nav class="rail-tabs"'));
    assert.ok(/<div class="brand-icon">[\s\S]*?<rect x="2" y="2" width="20" height="8"/.test(brand),
      "栏顶用与头行同一枚 brand-icon logo");
    assert.ok(brand.includes("<h1>Anyswitch</h1>"), "栏顶产品名在册");
    const tag = brand.match(/<span class="version-tag"[^>]*><\/span>/);
    assert.ok(tag, "栏顶版本徽标元素存在");
    assert.ok(tag[0].includes('id="railBrandVersion"'), "栏顶徽标有可填的 id");
    assert.ok(/\shidden(\s|>)/.test(tag[0]), "栏顶徽标初始隐藏：填不进版本时不留空胶囊");
    const body = panelJs.match(/async function initBrandVersion\(\) \{[\s\S]*?\n  \}/)?.[0] || "";
    assert.ok(body.includes('$("brandVersion"), $("railBrandVersion")'), "一次取值写两处徽标");
    assert.ok(!body.includes("railBrandVersion") || body.indexOf('$("brandVersion")') < body.indexOf('$("railBrandVersion")'),
      "头行徽标在先，栏顶徽标在后");
  });

  it("左栏接线：tab 直调 switchView、终端 tab 复用入口卡同一条链、设置与亮暗复用头行同一处理源", () => {
    assert.ok(panelJs.includes('["railTabBoard", "board"]') && panelJs.includes('["railTabStats", "stats"]'),
      "六枚栏 tab 接上 switchView");
    assert.ok(panelJs.includes('railTab.classList.toggle("active", on)'), "switchView 内同步栏 tab 激活态");
    assert.ok(panelJs.includes('railTab.setAttribute("aria-selected",'), "栏 tab aria-selected 同步");
    // 「终端」tab：不进 switchView 直调循环，与看板「虚拟终端」入口卡同一条
    // openTerminalPreview 链（记忆返回视图与滚动位），不另写一套
    const termWire = panelJs.match(/\$\("railTabTerminal"\)[\s\S]{0,160}?onclick = \(\) => openTerminalPreview\(\)/);
    assert.ok(termWire, "「终端」tab 点击复用 openTerminalPreview（与 #openTerminalPreviewBtn 同一函数）");
    assert.ok(panelJs.includes('["railTabTerminal", terminal]'), "终端 tab 进 switchView 的高亮同步循环");
    assert.ok(panelJs.includes('{ btn: $("railThemeToggle"), sun: $("railIcoSun"), moon: $("railIcoMoon") }'),
      "栏底亮暗钮进 initTheme 同一状态源");
    const seg = panelJs.slice(panelJs.indexOf("const openSettings = () =>"), panelJs.indexOf("const openSettings = () =>") + 400);
    assert.ok(seg.includes("if (openBtn) openBtn.onclick = openSettings;") && seg.includes("if (railOpenBtn) railOpenBtn.onclick = openSettings;"),
      "栏内设置钮与头行齿轮同一处理函数");
  });

  it("左栏位置反馈：设置/终端进同一同步循环，高亮即挂 aria-current、熄灭即摘", () => {
    const sw = panelJs.match(/function switchView\(name\) \{([\s\S]*?)\n  \}/);
    assert.ok(sw, "switchView found in panel.js");
    const body = sw[1];
    assert.ok(body.includes('railTab.setAttribute("aria-current", "page")') && body.includes('railTab.removeAttribute("aria-current")'),
      "栏 tab 的 active 态与 aria-current 同点同步");
    assert.ok(body.includes('const railSettings = $("railSettingsBtn");')
      && body.includes('railSettings.classList.toggle("active", settings)'),
      "设置视图下栏底设置钮点亮（接进同步循环，不另立状态源）");
    assert.ok(/railSettings\.setAttribute\("aria-current", "page"\)[\s\S]{0,80}?railSettings\.removeAttribute\("aria-current"\)/.test(body)
      || body.includes('if (settings) railSettings.setAttribute("aria-current", "page"); else railSettings.removeAttribute("aria-current");'),
      "设置钮的 aria-current 随设置视图进出");
    // 轻页头页题：与左栏高亮同源——从点亮的栏 tab 现取标签文字，不复制字符串。
    // 取的是 .rail-tab-label 而非 tab 整段 textContent：预设/会话两枚栏图标是裸
    // Unicode 字形（❑/☰）而非 svg，svg 无文本内容、整段取不会带出图标，裸字形
    // 会——整段取就把字形混进页面左上角页题（2026-10-17 报障）。
    assert.ok(body.includes('const railLabel = railTab.querySelector(".rail-tab-label")'),
      "页题取标签 span，不取 tab 整段文本（裸字形图标不带进页题）");
    assert.ok(body.includes('v2PageTitle.textContent = (railLabel || railTab).textContent.trim()'),
      "页题文本与点亮 tab 的标签同源");
  });

  it("设置页区块成描边盒（材质修正）：透明底四边描边盒 + aurora 恢复玻璃卡，hairline 撤场", () => {
    const scope = ':root[data-ui-version="v2"][data-style] :is(#settingsPanelGeneral, #settingsPanelRoute, #settingsPanelAbout, #settingsPanelAdvanced)';
    const card = panelCss.match(new RegExp(scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\.panel-card \\{([^}]*)\\}"));
    assert.ok(card, "设置页卡片规则在册（四面板 id 列举作用域，不整罩）");
    for (const pin of ["background: transparent;", "border: 1px solid var(--border);",
      "border-radius: var(--radius-md);", "box-shadow: none;", "backdrop-filter: none;"]) {
      assert.ok(card[1].includes(pin), `描边盒缺：${pin}`);
    }
    assert.ok(!card[1].includes("border-radius: 0"), "不再是去壳的方角透明片");
    const hover = panelCss.match(new RegExp(scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\.panel-card:hover \\{([^}]*)\\}"));
    assert.ok(hover[1].includes("transform: none;") && hover[1].includes("box-shadow: none;") && hover[1].includes("border-color: var(--border);"),
      "hover 不浮、不描边变化（描边盒是静态容器）");
    assert.ok(panelCss.includes(`${scope} { gap: 28px; }`), "盒间距 28px 节奏");
    assert.ok(!new RegExp(scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\.panel-card \\+ \\.panel-card").test(panelCss),
      "卡间 hairline 单线已撤（描边盒自带边界）");
    assert.ok(panelCss.includes(`${scope} .card-title {\n    font-size: 15px; font-weight: 600; color: var(--text);\n  }`),
      "区段标题 15px/600/正文色（grill 定稿）");
    assert.ok(panelCss.includes(`${scope} .card-body {\n    padding: 12px 18px 16px;\n  }`), "标题到内容 12px、盒内 16 节奏");
    assert.ok(panelCss.includes(`${scope} .card-header {\n    background: transparent; border-bottom: 0; padding: 16px 18px 0;\n  }`), "卡头去底线、顶距 16");
    // aurora 例外：恢复皮肤原生玻璃卡材质（去影去 hover 浮），不是透明描边盒
    const aurora = panelCss.match(/:root\[data-ui-version="v2"\]\[data-style="aurora"\] :is\(#settingsPanelGeneral[^)]*\) \.panel-card \{([^}]*)\}/);
    assert.ok(aurora, "aurora 玻璃卡恢复规则在册");
    for (const pin of ["background: var(--surface);", "background-image: var(--card-hairline);",
      "backdrop-filter: var(--glass-blur);", "border: 1px solid var(--border);",
      "border-radius: var(--radius-lg);", "box-shadow: inset 0 1px 0 var(--hl-inset);"]) {
      assert.ok(aurora[1].includes(pin), `aurora 玻璃卡缺：${pin}`);
    }
    assert.ok(!aurora[1].includes("--shadow-sm") && !aurora[1].includes("--shadow-md"), "aurora 只留 inset 顶部高光、去投影");
  });

  it("v2 明暗关系交换：saas/sepia 内容区与栏底 token 对调，aurora 摘出，v1 原样", () => {
    for (const skin of ["saas", "sepia"]) {
      assert.ok(panelCss.includes(`:root[data-ui-version="v2"][data-style="${skin}"] body`),
        `${skin} 内容区底换 --surface`);
      assert.ok(panelCss.includes(`:root[data-ui-version="v2"][data-style="${skin}"] .rail`),
        `${skin} 栏底换 --bg-page`);
    }
    assert.ok(/:root\[data-ui-version="v2"\]\[data-style="saas"\] body,[\s\S]*?body \{ background: var\(--surface\); \}/.test(panelCss),
      "内容区底 = --surface（亮：白；暗：抬亮一档）");
    assert.ok(/:root\[data-ui-version="v2"\]\[data-style="saas"\] \.rail,[\s\S]*?\.rail \{ background: var\(--bg-page\); \}/.test(panelCss),
      "栏底 = --bg-page（亮：灰；暗：再压暗）");
    assert.ok(panelCss.includes('.terminal-view,\n  :root[data-ui-version="v2"][data-style="sepia"] .terminal-view { background: var(--surface); }'),
      "terminal-view 同步换（切页不跳变）");
    assert.ok(panelCss.includes('.settings-theme-preview,\n  :root[data-ui-version="v2"][data-style="sepia"] .settings-theme-preview { background: var(--surface); }'),
      "主题预览镜像视口同步换（镜像演示新明暗关系）");
    assert.ok(panelCss.includes('.settings-mirror-viewport,\n  :root[data-ui-version="v2"][data-style="sepia"] .settings-mirror-viewport { background: var(--surface); }'),
      "镜像内层画布同步换底（对调时漏同步的一处，补齐后预览承托面与真实内容区同值）");
    assert.ok(!panelCss.includes(':root[data-ui-version="v2"][data-style="aurora"] body'),
      "aurora 摘出对调（--surface 是半透玻璃料，对调毁玻璃页身层次；页面底即其「面」）");
    // aurora 栏不添底色规则：其栏玻璃规则（backdrop-filter 那条）不含 background，
    // 由阶段 1「aurora 栏材质」断言原样钉着
    // v1 零变化：基座 body/rail 底色原样
    assert.ok(/\n  body \{\n    margin: 0; background: var\(--bg-page\);/.test(panelCss), "基座 body 底色原样");
    assert.ok(/:root\[data-ui-version="v2"\] \.rail \{[\s\S]*?background: var\(--surface\);/.test(panelCss), "v2 栏基座底色规则原样（对调由双属性覆写承担）");
  });

  it("v2 遥测四宫格扁平化：saas 收为平涂撤打光（照 sepia），aurora 与 v1 原样", () => {
    assert.ok(panelCss.includes(':root[data-ui-version="v2"][data-style="saas"] .telemetry-card {\n    background: var(--surface-sunken);\n    box-shadow: none;\n  }'),
      "saas 四宫格 v2 平涂 --surface-sunken + 撤内高光");
    assert.ok(!panelCss.includes(':root[data-ui-version="v2"][data-style="aurora"] .telemetry-card'),
      "aurora 四宫格保持现状（无 v2 覆写）");
    assert.ok(!panelCss.includes(':root[data-ui-version="v2"][data-style="sepia"] .telemetry-card'),
      "sepia 本就是平样板（无需覆写）");
    // v1 零变化：saas 皮肤段的渐变底 + 顶部内高光原样在册（v2 靠双属性提级覆写）
    assert.ok(panelCss.includes(':root[data-style="saas"] .telemetry-card {\n  border-radius: var(--radius-md);\n  background: linear-gradient(180deg, var(--surface) 0%, var(--surface-sunken) 100%);\n  box-shadow: inset 0 1px 0 var(--hl-inset);\n}'),
      "saas 皮肤段四宫格打光规则原样（v1 观感不动）");
  });

  it("设置子导航迁入左栏：设置态主 tab 组整组换目录、栏底齿轮换「返回」，首帧与运行时可交棒", () => {
    const rail = panelHtml.match(/<aside class="rail" id="v2Rail"[\s\S]*?<\/aside>/)[0];
    // 目录组就在主 tab 组与栏底行之间，静态 hidden（v1 整栏不出、v2 非设置态不出）
    const dir = rail.match(/<nav class="rail-dir" id="railSettingsDir" role="tablist" aria-label="设置分类" hidden>([\s\S]*?)<\/nav>/);
    assert.ok(dir, "设置目录组在册（rail-tabs 与 rail-foot 之间）");
    assert.ok(rail.indexOf('class="rail-tabs"') < rail.indexOf('id="railSettingsDir"')
      && rail.indexOf('id="railSettingsDir"') < rail.indexOf('class="rail-foot"'),
      "目录组位置：主 tab 组之后、栏底行之前");
    const items = [...dir[1].matchAll(/<button class="rail-tab" id="(railDir\w+)" role="tab" aria-selected="false" aria-controls="(settingsPanel\w+)" title="([^"]+)">([\s\S]*?)<\/button>/g)];
    assert.deepEqual(items.map((m) => m[1]),
      ["railDirGeneral", "railDirAdvanced", "railDirRoute", "railDirTheme", "railDirAbout"],
      "目录五项依次在册");
    assert.deepEqual(items.map((m) => m[3]), ["通用", "高级选项", "自动路由", "主题", "关于"],
      "目录标签逐字复用子 tab 文本（无新文案）");
    assert.deepEqual(items.map((m) => m[2]),
      ["settingsPanelGeneral", "settingsPanelAdvanced", "settingsPanelRoute", "settingsPanelTheme", "settingsPanelAbout"],
      "目录项 aria-controls 对齐五块子面板");
    for (const m of items) {
      assert.ok(m[4].includes('viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'),
        `${m[1]} 图标与主 tab 同一 feather 风（24 视窗空心描边 round caps）`);
      assert.ok(m[4].indexOf("<svg") < m[4].indexOf('<span class="rail-tab-label">'), `${m[1]} 图标在文字前`);
      assert.ok(m[4].includes(`<span class="rail-tab-label">${m[3]}</span>`), `${m[1]} 标签=title（窄栏图标栏悬停提示同源）`);
    }
    // 栏底「返回」：紧跟齿轮、同一槽位形制（rail-settings 类），静态 hidden，
    // 图标复用头行「←」箭头，文案仅此一处新词（已授权）
    const foot = rail.match(/<div class="rail-foot">([\s\S]*?)<\/div>\s*<\/aside>/)[1];
    const back = foot.match(/<button class="rail-tab rail-settings" id="railBackBtn" aria-label="返回" title="返回" hidden>([\s\S]*?)<\/button>/);
    assert.ok(back, "栏底「返回」钮在册（静态 hidden）");
    assert.ok(foot.indexOf('id="railSettingsBtn"') < foot.indexOf('id="railBackBtn"'), "「返回」紧跟齿轮（同一槽位）");
    assert.ok(back[1].includes('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
      "「返回」复用头行「←」箭头图标");
    assert.ok(back[1].includes('<span class="rail-tab-label">返回</span>'), "宽档图标+文字，窄栏随标签收起只留图标");
    // 换血 CSS：运行时 body.settings-mode 四条 + 首帧 prepaint 同值四条，只锚 #v2Rail
    // （主题预览的栏克隆剥了 id，继续呈主 tab 组）；显示侧带 [hidden] 必须 !important
    for (const scope of [':root[data-ui-version="v2"] body.settings-mode', 'html[data-prepaint-view="settings"][data-ui-version="v2"]']) {
      assert.ok(panelCss.includes(`${scope} #v2Rail .rail-tabs { display: none; }`), `${scope} 收主 tab 组`);
      assert.ok(panelCss.includes(`${scope} #v2Rail #railSettingsDir[hidden] { display: flex !important; }`), `${scope} 放目录组（!important 压全局 [hidden] 兜底）`);
      assert.ok(panelCss.includes(`${scope} #v2Rail #railSettingsBtn { display: none; }`), `${scope} 收栏底齿轮`);
      assert.ok(panelCss.includes(`${scope} #v2Rail #railBackBtn[hidden] { display: flex !important; }`), `${scope} 放「返回」`);
    }
    assert.ok(/\.rail-dir \{ display: flex; flex-direction: column; gap: 2px; margin-top: auto; \}/.test(panelCss),
      "目录组自身形制与主 tab 组同（贴栏底生态位）；藏它的是 hidden 属性而非 display 规则");
    // 让位全档成立：栏在任何窗口宽度都常驻，子 tab 条与头行「←」的让位没有档位例外——
    // 设置态的子导航与出口由栏目录和栏底「返回」全档接管（规则无媒体查询）
    assert.ok(panelCss.includes(':root[data-ui-version="v2"] .settings-subtabs { display: none; }'),
      "栏目录接班后原子 tab 条让位（全档，无媒体查询）");
    assert.ok(panelCss.includes(':root[data-ui-version="v2"] #settingsExitBtn { display: none; }'),
      "栏底「返回」接班后头行「←」让位（全档，无媒体查询）");
    // JS：目录与原子 tab 同一状态源——键集逐格同、点击同入口、切换函数内双向同步
    const subTabKeys = [...panelJs.matchAll(/^ {6}([a-z]+): \["settingsTab[A-Za-z]+", "settingsPanel[A-Za-z]+"\],$/gm)].map((m) => m[1]);
    const dirKeys = [...panelJs.matchAll(/^ {6}([a-z]+): "railDir[A-Za-z]+",$/gm)].map((m) => m[1]);
    assert.deepEqual(dirKeys, subTabKeys, "settingsDirItems 键集与 settingsSubTabs 逐格同（漏一格那一格目录项不同步）");
    const activate = panelJs.match(/function activateSettingsSubTab\(which, animate\) \{([\s\S]*?)\n    \}/)[1];
    assert.ok(activate.includes('const dirItem = $(settingsDirItems[name]);')
      && activate.includes('dirItem.classList.toggle("active", on)')
      && activate.includes('dirItem.setAttribute("aria-selected", String(on))')
      && activate.includes('dirItem.setAttribute("aria-current", "page")'),
      "切子 tab 时栏目录同帧跟随（active + aria-selected + aria-current 与主栏 tab 同套）");
    const bind = panelJs.match(/function bindSettingsSubTabs\(\) \{([\s\S]*?)\n    \}/)[1];
    assert.ok(bind.includes('if (dirItem) dirItem.onclick = () => activateSettingsSubTab(name, true);'),
      "目录项点击与原子 tab 同一入口（activateSettingsSubTab 回同步两处高亮）");
    // 返回钮与头行「←」同一处理函数（回跳目标一个状态源）
    assert.ok(panelJs.includes("const exitSettings = () => switchView(settingsReturnView);")
      && panelJs.includes("if (exitBtn) exitBtn.onclick = exitSettings;")
      && panelJs.includes('if (railBackBtn) railBackBtn.onclick = exitSettings;'),
      "头行「←」与栏底「返回」挂同一 exitSettings");
    // 运行时标记：与 terminal-mode 同型的 body 类，switchView 挂/摘
    assert.ok(panelJs.includes('document.body.classList.toggle("settings-mode", settings)'),
      "switchView 挂/摘 body.settings-mode（首帧由 prepaint 四条承担，交棒不跳）");
  });

  it("行在「显示」卡内：radiogroup 两枚分段钮（旧版/新版），无行说明", () => {
    const atCard = panelHtml.search(/<h2 class="card-title">[\s\S]*?<svg[\s\S]*?<\/svg>\s*显示\s*<\/h2>/);
    const atSeg = panelHtml.indexOf('id="uiVersionSeg"');
    const atKeepAlive = panelHtml.indexOf('id="keepAliveToggle"');
    assert.ok(atCard > 0 && atCard < atSeg && atSeg < atKeepAlive,
      "分段钮落在「显示」卡内、「抗截断」卡之前");
    const win = panelHtml.slice(panelHtml.lastIndexOf('<div class="modal-item">', atSeg), atSeg + 600);
    assert.ok(win.includes('<div class="modal-item-title">UI版本</div>'), "行标题「UI版本」在册");
    assert.ok(!win.includes("modal-item-desc"), "无行说明");
    assert.ok(win.includes('role="radiogroup"'), "分段钮是 radiogroup");
    const labels = [...win.matchAll(/role="radio" aria-checked="(?:true|false)">([^<]+)<\/button>/g)].map((m) => m[1]);
    assert.deepEqual(labels, ["旧版", "新版"], "两枚按钮依次为旧版/新版");
  });

  it("分段钮样式：选中态只认 aria-checked，胶囊语言沿用 view-tabs token", () => {
    assert.ok(panelCss.includes('.seg-switch-btn[aria-checked="true"]'), "选中态挂 aria-checked");
    assert.ok(/\.seg-switch \{[\s\S]*?background: var\(--surface-sunken\)/.test(panelCss), "sunken 底胶囊");
    assert.ok(!panelCss.includes(".seg-switch-btn.active"), "不另设 active 类，免得两处状态源漂移");
  });
});

describe("新版 UI 阶段 3：统计页平铺（描边盒 + 表格纪律 + 四毛病修复 + 空态骨架）", () => {
  const S3 = ':root[data-ui-version="v2"][data-style] #statsView';
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  it("统计区块成描边盒（同阶段 2 定稿材质）：透明底四边描边盒、hover 静态、28 节奏、标题 15/600，aurora 恢复玻璃卡", () => {
    const card = panelCss.match(new RegExp(esc(S3) + " \\.panel-card \\{([^}]*)\\}"));
    assert.ok(card, "统计页卡片规则在册（#statsView 整罩——统计页不进主题预览镜像）");
    for (const pin of ["background: transparent;", "border: 1px solid var(--border);",
      "border-radius: var(--radius-md);", "box-shadow: none;", "backdrop-filter: none;"]) {
      assert.ok(card[1].includes(pin), `描边盒缺：${pin}`);
    }
    const hover = panelCss.match(new RegExp(esc(S3) + " \\.panel-card:hover \\{([^}]*)\\}"));
    assert.ok(hover[1].includes("transform: none;") && hover[1].includes("box-shadow: none;") && hover[1].includes("border-color: var(--border);"),
      "hover 不浮、不描边变化（描边盒是静态容器）");
    for (const layer of ["#statsOverviewPane", "#statsView .stats-top-grid", "#statsView .stats-side", "#statsView .skills-grid.stats-quad"]) {
      assert.ok(panelCss.includes(`${layer}`), `28px 节奏层在册：${layer}`);
    }
    assert.ok(panelCss.includes(`${S3} .card-title {\n    font-size: 15px; font-weight: 600; color: var(--text);\n  }`),
      "区段标题 15px/600/正文色（与阶段 2 同档）");
    assert.ok(panelCss.includes(`${S3} .card-body { padding: 12px 18px 16px; }`), "卡体 12/16 节奏");
    assert.ok(panelCss.includes(`${S3} .card-header {\n    background: transparent; border-bottom: 0; padding: 16px 18px 0;\n  }`), "卡头去底线、顶距 16");
    assert.ok(panelCss.includes(`${S3} .panel-card > .card-body:first-child {\n    padding-top: 16px;\n  }`), "无头平卡（请求日志卡）顶距同档 16");
    // aurora 例外：恢复皮肤原生玻璃卡材质（配方逐项同阶段 2）
    const aurora = panelCss.match(/:root\[data-ui-version="v2"\]\[data-style="aurora"\] #statsView \.panel-card \{([^}]*)\}/);
    assert.ok(aurora, "aurora 玻璃卡恢复规则在册");
    for (const pin of ["background: var(--surface);", "background-image: var(--card-hairline);",
      "backdrop-filter: var(--glass-blur);", "border: 1px solid var(--border);",
      "border-radius: var(--radius-lg);", "box-shadow: inset 0 1px 0 var(--hl-inset);"]) {
      assert.ok(aurora[1].includes(pin), `aurora 玻璃卡缺：${pin}`);
    }
    // v1 零变化：统计卡基座无任何 v2 段外的改动（基座规则原样钉着）
    assert.ok(/\.panel-card \{\n    background: var\(--surface\);\n    border: 1px solid var\(--border\);\n    border-radius: 14px;/.test(panelCss), "v1 卡基座原样");
  });

  it("统计子 tab 降权同手法：撤托盘 + 2px accent 下划线选中态", () => {
    assert.ok(panelCss.includes(':root[data-ui-version="v2"][data-style] .view-tabs.stats-subtabs {\n    background: transparent; border-color: transparent;\n  }'), "子 tab 撤托盘");
    assert.ok(panelCss.includes(':root[data-ui-version="v2"][data-style] .stats-subtabs .view-tab.active {\n    background: transparent; border: 0; color: var(--text);\n    box-shadow: inset 0 -2px 0 var(--accent);\n  }'),
      "选中态 2px accent 下划线（box-shadow inset 零位移，prepaint 减法相容）");
  });

  it("表格纪律：数字列右对齐 + 空值统一「—」", () => {
    assert.ok(panelCss.includes(`${S3.replace("#statsView", "#statsEndpoints")} .stats-table :is(th, td):not(:first-child) { text-align: right; }`),
      "端点会话表 2–5 列（全数字）右对齐");
    for (const nth of ["5", "6"]) {
      assert.ok(panelCss.includes(`:root[data-ui-version="v2"][data-style] .logs-table th:nth-child(${nth}),`), `日志表第 ${nth} 列表头右对齐在册`);
      assert.ok(panelCss.includes(`:root[data-ui-version="v2"][data-style] .logs-table td:nth-child(${nth})`), `日志表第 ${nth} 列单元格右对齐在册`);
    }
    // 等宽数字基座本已钉在 .stats-table td（tabular-nums），原样不动即满足
    assert.ok(/\.stats-table td \{[^}]*font-variant-numeric: tabular-nums;/.test(panelCss), "数字列 tabular-nums 基座原样");
    // 空值「—」：statsFmtHours 补齐 null 口径（0 仍是 0h），其余格式化器本已如此
    const fmt = panelJs.match(/function statsFmtHours\(ms\) \{([\s\S]*?)\n  \}/)[1];
    assert.ok(fmt.includes('if (ms == null) return "—";'), "工时格式化：null→「—」");
    assert.ok(fmt.includes('if (!ms || ms <= 0) return "0h";'), "真实零值仍 0h");
  });

  it("既有毛病四修（全 v2-only，v1 基座逐字原样）", () => {
    // a) 上下半区同档塌缩：quad 补窄档 1057–1096 与宽档自动态 1200–1240 两段
    const mid = [...panelCss.matchAll(/@media \(min-width: 1057px\) and \(max-width: 1096px\) \{([\s\S]*?)\n  \}/g)].map((m) => m[0])
      .find((b) => b.includes(".skills-grid.stats-quad"));
    assert.ok(mid && mid.includes("grid-template-columns: 1fr;") && mid.includes("height: auto;"),
      "quad 窄档 1057–1096 塌缩补齐（与 top-grid 同档）");
    const wide = [...panelCss.matchAll(/@media \(min-width: 1200px\) and \(max-width: 1240px\) \{([\s\S]*?)\n  \}/g)].map((m) => m[0])
      .find((b) => b.includes(".skills-grid.stats-quad"));
    assert.ok(wide && wide.includes(':not([data-rail="collapsed"]) .skills-grid.stats-quad { grid-template-columns: 1fr; }'),
      "quad 宽档自动态 1200–1240 塌缩补齐（collapsed 手动态摘出同 top-grid）");
    // b) 热力图单列态封顶 340（侧栏设计宽），v1 基座 width:100% 原样
    assert.ok(panelCss.includes(`${S3} .stats-heatmap svg { max-width: 340px; margin: 0 auto; }`), "热力图 svg 封顶居中");
    assert.ok(panelCss.includes(".stats-heatmap svg { display: block; width: 100%; height: auto; }"), "v1 热力图基座原样");
    // c) 环形图窄屏等比缩；折线图量宽走 JS
    assert.ok(panelCss.includes(`${S3} .stats-usage-donut svg { max-width: 100%; height: auto; }`), "环形图 max-width:100%");
    assert.ok(panelCss.includes(".stats-usage-donut svg { display: block; width: 248px; height: 248px; }"), "v1 环形图基座原样");
    assert.ok(/function statsChartWidth\(container\) \{\n    const w = Math\.round\(container\.clientWidth\);\n    return w > 0 \? Math\.max\(280, w\) : 760;\n  \}/.test(panelJs),
      "折线图画布宽=容器实测（藏态回落 760）");
    assert.ok(!/const W = 760, H = cfg\.height/.test(panelJs), "写死 760 已除");
    assert.ok(panelJs.includes("const W = statsChartWidth(container), H = cfg.height || 220;"), "viewBox 宽随容器");
    assert.ok(panelJs.includes("renderStatsTrendSignature(cfg, statsChartWidth(container))")
      && panelJs.includes("renderStatsTrendSignature(cfg, W)")
      && /function renderStatsTrendSignature\(cfg, w\) \{\n    return JSON\.stringify\(\[\n      w,/.test(panelJs),
      "画布宽入渲染签名（resize 重渲不被同终点守卫误跳）");
    assert.ok(panelJs.includes("bindStatsChartResize()")
      && /new ResizeObserver\(\(entries\) => \{[\s\S]*?statsTrendSnapOnce = true;[\s\S]*?renderStatsTrend\(\);[\s\S]*?renderStatsTtft\(\);/.test(panelJs)
      && panelJs.includes("const anim = statsTrendSnapOnce ? null :"),
      "ResizeObserver 防抖重渲在册（snap 标记瞬时落地不播动画，renderStatsTrend 签名不动）");
    // d) 日志页固定高：v2 头行 48 → 88；v1 基座 96 原样
    assert.ok(panelCss.includes(':root[data-ui-version="v2"] .stats-view.logs-fixed { height: calc(100vh - 88px); height: calc(100dvh - 88px); }'),
      "v2 日志页固定高 88（48 头行 + 24 顶距 + 16 底余量）");
    assert.ok(panelCss.includes(".stats-view.logs-fixed { height: calc(100vh - 96px); height: calc(100dvh - 96px); overflow: hidden; }"),
      "v1 日志页固定高 96 原样");
  });

  it("POLISH02 回归：statsTrendChartHeight 必须是外层作用域声明（嵌套进渲染器则调用处 ReferenceError、趋势图整图空白）", () => {
    // 批次 1 事故实录：该函数被写成 renderStatsLineChart 体内的嵌套声明，而调用点
    // height: statsTrendChartHeight(chartEl) 在 renderStatsTrend——外层作用域没有
    // 这个名字，每次渲染入口即抛 ReferenceError，容器清空后整图空白（连坐标轴都不出）。
    const fnIdx = panelJs.indexOf("function statsTrendChartHeight(el) {");
    assert.ok(fnIdx > 0, "statsTrendChartHeight 在册");
    assert.ok(panelJs.includes("height: statsTrendChartHeight(chartEl)"), "实测高入 cfg 的调用点在册");
    const chartStart = panelJs.indexOf("function renderStatsLineChart(container, cfg, anim) {");
    assert.ok(chartStart > 0 && fnIdx > chartStart, "声明在渲染器之后");
    // 括号配平走查找渲染器的函数体闭合点（体内字符串/模板字面量的花括号均成对，
    // 不干扰配平）：声明点必须在闭合点之后——在体内即嵌套
    let depth = 0, end = -1;
    for (let i = chartStart; i < panelJs.length; i++) {
      const ch = panelJs[i];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > chartStart, "renderStatsLineChart 括号配平可行走");
    assert.ok(fnIdx > end, "statsTrendChartHeight 在 renderStatsLineChart 体外（外层作用域）");
  });

  it("空态与加载骨架的平铺化重设计：空态撤框纯排版、日志首载铺 shimmer 骨架行（v2 门控）", () => {
    assert.ok(panelCss.includes(`${S3} .empty-hint {\n    background: transparent; border: 0; padding: 28px 24px;\n  }`),
      "空态撤 sunken 底与虚线描边（排版而非虚线框）");
    // v1 空态基座原样（虚线框不动）
    assert.ok(/\.empty-hint \{\n    text-align: center; padding: 24px; color: var\(--text-3\); font-size: 12\.5px;\n    background: var\(--surface-sunken\); border-radius: var\(--radius-md, 8px\); border: 1px dashed var\(--border\);\n  \}/.test(panelCss),
      "v1 空态基座原样");
    assert.ok(panelCss.includes(`${S3} .logs-skel-row td { border-top: 0; padding: 11px 8px; }`), "骨架行间不画分隔线");
    assert.ok(panelCss.includes(`${S3} .logs-skel-row:hover { background: transparent; }`), "骨架行 hover 不亮");
    assert.ok(panelCss.includes(`${S3} .logs-skel-bar { height: 12px; }`), "骨架条行高在册（shimmer 复用 .sessions-skel）");
    // JS：首载铺骨架（空表才铺、v2 门控、enterLogsPane 调用、复用 sessions-skel 类）
    const skel = panelJs.match(/function renderLogsSkeleton\(\) \{([\s\S]*?)\n  \}/);
    assert.ok(skel, "renderLogsSkeleton 在册");
    assert.ok(skel[1].includes('if (!tbody || tbody.children.length) return;'), "只铺首次空表（轮询静默范式不动 DOM）");
    assert.ok(skel[1].includes('document.documentElement.getAttribute("data-ui-version") !== "v2"),'.slice(0, -1)), "v2 门控（v1 行为原样）");
    assert.ok(skel[1].includes('class="sessions-skel logs-skel-bar"'), "骨架条复用 .sessions-skel shimmer");
    assert.ok(/function enterLogsPane\(\) \{\n    syncLogsSortHeaders\(\);\n    renderLogsSkeleton\(\);/.test(panelJs), "进日志子页即铺骨架");
  });
});

describe("新版 UI 阶段 1：框架骨架（轻页头 + 左栏两级降级）", () => {
  it("轻页头：v2 头行收成 48px——左侧当前页标题 h1、右侧只剩 relay 状态 pill；旧版像素级不动", () => {
    const head = panelHtml.match(/<div class="layout-container head-inner" id="mainHeadInner">([\s\S]*?)<\/header>/)?.[1] || "";
    assert.ok(head, "主头行在册");
    const atTitle = head.indexOf('<h1 class="v2-page-title" id="v2PageTitle">看板</h1>');
    assert.ok(atTitle > 0 && atTitle < head.indexOf('class="brand-group"'),
      "页题 h1 在主头行最左；静态默认「看板」与静态高亮的看板 tab 同帧一致");
    assert.ok(/\.v2-page-title \{ display: none; \}/.test(panelCss), "旧版页题整隐（v1 头行像素级不动）");
    assert.ok(/:root\[data-ui-version="v2"\] \.v2-page-title \{[^}]*margin-right: auto;/.test(panelCss),
      "v2 页题左置、状态区顶右（auto 外边距吸收自由空间）");
    assert.ok(panelCss.includes(':root[data-ui-version="v2"] .site-head .head-inner { height: 48px; }'),
      "v2 头行 56→48px 轻页头（规则只挂 v2 作用域）");
    assert.ok(panelCss.includes("height: 56px;"), "旧版头行 56px 原样");
    assert.ok(/#mainHeadInner \.view-tabs,[\s\S]*?head-meta-strip \.icon-btn \{ display: none; \}/.test(panelCss),
      "v2 头行状态区只留 relay 状态 pill——页级主操作不进页头（归位属后续逐页阶段）");
  });

  it("窄档抽屉机关整体拆除：栏任何宽度常驻，三份源文件零抽屉 token、CSS 不再有 860 断点", () => {
    for (const [src, name] of [[panelHtml, "panel.html"], [panelJs, "panel.js"], [panelCss, "panel.css"]]) {
      for (const token of ["rail-drawer", "railDrawer"]) {
        assert.ok(!src.includes(token), `${name} 无抽屉 token（${token}——按钮/遮罩/开合类/常量全链路）`);
      }
    }
    assert.ok(!panelCss.includes("@media (min-width: 860px)"), "panel.css 不再有 860px 断点（三档改两档，档界只剩 1200）");
    assert.ok(!panelHtml.includes("rail-drawer-mask") && !panelHtml.includes('id="railDrawerBtn"'),
      "汉堡钮与遮罩元素已从 markup 删除");
  });

  it("终端页「返回看板」让位给栏内「看板」tab：v2 隐钮与分隔线，v1 markup 原样", () => {
    assert.ok(panelHtml.includes('id="terminalReturnBtn" title="返回看板" aria-label="返回看板"'),
      "markup 原样保留（v1 无栏，返回链唯一入口不动）");
    assert.ok(panelCss.includes(':root[data-ui-version="v2"] .terminal-return-btn,')
      && panelCss.includes(':root[data-ui-version="v2"] .terminal-head-divider { display: none; }'),
      "v2 隐返回钮与紧随其后的分隔竖线（同一组规则——只隐按钮会空剩一道栏）");
  });

  it("左栏两级降级：基座=窄栏 72 图标栏（常驻视口，任何宽度不整栏消失），min-width:1200 全栏 216", () => {
    const railBase = panelCss.match(/:root\[data-ui-version="v2"\] \.rail \{([\s\S]*?)\n  \}/)?.[1] || "";
    assert.ok(railBase.includes("width: 72px;"), "窄栏 72px 图标栏是基座形态——栏常驻视口内，任何窗口宽度都不整栏消失");
    assert.ok(!railBase.includes("transform") && !railBase.includes("transition"), "无抽屉滑入机关（transform/transition 均不在册）");
    assert.ok(railBase.includes("overflow-y: auto;"), "C2：矮窗口栏体自滚，贴底 tab 组与底行可达（margin-top:auto 贴底语义保持）");
    // S4 起底行显式钉 flex:none（= flex:0 0 auto，含 shrink:0）；早期拼写
    // flex-shrink:0 语义等价，两种都认——钉的是「不收缩」这个事实。
    assert.ok(/\.rail-brand \{[^}]*flex-shrink: 0;/.test(panelCss)
      && /\.rail-foot \{[^}]*(flex-shrink: 0|flex: none)/.test(panelCss),
      "栏顶品牌与底行不收缩，矮窗下滚动而非压扁");
    // 窄栏基座：品牌文字、tab 标签、底行「设置」文字收起只留图标（规则无媒体查询）
    assert.ok(panelCss.includes(':root[data-ui-version="v2"] .rail-brand .brand-text { display: none; }'), "品牌文字收起（基座）");
    assert.ok(panelCss.includes(':root[data-ui-version="v2"] .rail-tab-label { display: none; }'), "tab 标签与「设置」文字收起只留图标（基座）");
    assert.ok(panelCss.includes(':root[data-ui-version="v2"] .rail-foot { flex-direction: column; }'), "底行两钮纵排（基座）");
    const wide = [...panelCss.matchAll(/@media \(min-width: 1200px\) \{[\s\S]*?\n  \}/g)].map((m) => m[0])
      .find((b) => b.includes(':root[data-ui-version="v2"] .rail { width: 216px; padding: 8px 12px 16px; }'));
    assert.ok(wide, "宽档 216px 全栏块在册：窄栏的收起逐项撤销");
    assert.ok(wide.includes(':root[data-ui-version="v2"] .rail-tab-label { display: inline; }')
      && wide.includes(':root[data-ui-version="v2"] .rail-brand .brand-text { display: block; }')
      && wide.includes(':root[data-ui-version="v2"] .rail-foot { flex-direction: row; }'),
      "宽档逐项撤销：标签/品牌文字回明、底行横排");
  });

  it("常驻栏层级 40：不与会话抽屉（110）/弹窗（300）争浮层", () => {
    const railBase = panelCss.match(/:root\[data-ui-version="v2"\] \.rail \{([\s\S]*?)\n  \}/)?.[1] || "";
    assert.ok(railBase.includes("z-index: 40;"), "常驻栏 40：压不过会话抽屉 110 与弹窗 300（栏不是浮层，让位靠内容 padding）");
    assert.ok(panelCss.includes(".sessions-drawer-mask { position: fixed; inset: 0; z-index: 100;"), "会话遮罩 100 原样");
    assert.ok(panelCss.includes("z-index: 110;"), "会话抽屉 110 原样");
  });

  it("aurora 栏材质：玻璃配方抄既有 token，双属性选择器压得住位置更靠后的皮肤块", () => {
    const m = panelCss.match(/:root\[data-ui-version="v2"\]\[data-style="aurora"\] \.rail \{([^}]*)\}/);
    assert.ok(m, "aurora 栏规则在册（集中在 v2 段，不进皮肤内嵌块）");
    assert.ok(m[1].includes("backdrop-filter: var(--glass-blur);") && m[1].includes("-webkit-backdrop-filter: var(--glass-blur);"),
      "玻璃模糊取既有 --glass-blur（aurora 卡片玻璃同配方）");
    assert.ok(!m[1].includes("background"), "半透底沿用基座 var(--surface)（aurora 下本就半透），不造新色值");
    // 阶段 2 材质修正后，saas/sepia 栏各多一条 v2 底色对调规则（栏底换 --bg-page）——
    // 那是明暗交换、不是玻璃材质；本例仍钉「saas/sepia 栏的规则只有对调这一条」
    const swapRail = [...panelCss.matchAll(/\[data-style="(?:saas|sepia)"\] \.rail[ ,]/g)];
    assert.ok(swapRail.length === 2, "saas/sepia 栏仅底色对调一处（合并选择器各占一格）");
    assert.ok(panelCss.includes(':root[data-ui-version="v2"][data-style="sepia"] .rail { background: var(--bg-page); }'),
      "saas/sepia 栏底对调为 --bg-page；玻璃材质仍只有 aurora");
  });

  it("布局断点按栏态校准：宽档 +240 / 窄栏 +96（栏常驻，窄栏块无下界）；只校准真挤压的布局断点", () => {
    // 校准清单（v1 阈值 → v2 宽档/窄栏）：看板双栏 1080→1320/1176、统计上半区 1000→1240/1096、
    // 会话详情+目录 1023→1263/1119（目录浮动钮显隐随同一条）、Skills 双栏/统计四宫格 960→仅窄栏
    // 1056（宽档阈值 960+240=1200 恰为档界：v1 口径的塌缩内容宽在宽档本就够不到，宽档无需补）。
    // 手动态修正：collapsed（宽档栏收 72、内容只让 96）时宽档三块收 :not() 摘出——≥1200 内容
    // 恒 ≥1104 盖过全部 v1 阈值；expanded（窄栏栏展 216）的窄栏全档塌缩块在下方另钉。
    const expectBlock = (mq, rules) => {
      const text = `${mq} {\n${rules.map((r) => `    ${r}`).join("\n")}\n  }`;
      assert.ok(panelCss.includes(text), `校准块在册：${mq}`);
    };
    expectBlock("@media (min-width: 1200px) and (max-width: 1320px)",
      [':root[data-ui-version="v2"]:not([data-rail="collapsed"]) .telemetry-layout-grid { grid-template-columns: 1fr; }']);
    expectBlock("@media (max-width: 1176px)",
      [':root[data-ui-version="v2"] .telemetry-layout-grid { grid-template-columns: 1fr; }']);
    expectBlock("@media (max-width: 1056px)",
      [':root[data-ui-version="v2"] .skills-grid { grid-template-columns: 1fr; }',
        ':root[data-ui-version="v2"] .skills-grid.stats-quad { grid-template-columns: 1fr; }',
        ':root[data-ui-version="v2"] .skills-grid.stats-quad .panel-card { height: auto; }']);
    expectBlock("@media (min-width: 1200px) and (max-width: 1240px)",
      [':root[data-ui-version="v2"]:not([data-rail="collapsed"]) .stats-top-grid { grid-template-columns: 1fr; }']);
    expectBlock("@media (max-width: 1096px)",
      [':root[data-ui-version="v2"] .stats-top-grid { grid-template-columns: 1fr; }']);
    expectBlock("@media (min-width: 1200px) and (max-width: 1263px)",
      [':root[data-ui-version="v2"]:not([data-rail="collapsed"]) .sessions-detail-wrap { grid-template-columns: minmax(0, 1fr); }',
        ':root[data-ui-version="v2"]:not([data-rail="collapsed"]) .toc-side { display: none; }',
        ':root[data-ui-version="v2"]:not([data-rail="collapsed"]) body.sessions-mode .toc-fab.has-toc { display: flex; }']);
    expectBlock("@media (max-width: 1119px)",
      [':root[data-ui-version="v2"] .sessions-detail-wrap { grid-template-columns: minmax(0, 1fr); }',
        ':root[data-ui-version="v2"] .toc-side { display: none; }',
        ':root[data-ui-version="v2"] body.sessions-mode .toc-fab.has-toc { display: flex; }']);
    // 不动清单：瓦片类小网格（弹性吸收，塌晚仅瓦片略窄）与排版/紧凑类断点一律沿用 v1
    // （.terminal-head 带 {：v2 另有 .terminal-head-divider 隐藏规则，不带花括号会误伤）
    for (const sel of [".telemetry-grid", ".instance-telemetry-grid", ".route-ep-grid", ".stats-rank-cols",
      ".settings-theme-grid", ".about-client-main", ".terminal-workspace", ".terminal-head {"]) {
      assert.ok(!panelCss.includes(`:root[data-ui-version="v2"] ${sel}`), `${sel} 不做 v2 校准`);
    }
  });

  it("左栏手动收/展：栏顶收起钮、手动态持久化绘制前读回、双态 CSS 镜像与校准跟手", () => {
    // 结构：收起钮在栏顶品牌行内（品牌之后），icon-btn 形制、双图标随态换向、
    // aria 齐（expanded/controls/label+title 同源文案）
    const rail = panelHtml.match(/<aside class="rail" id="v2Rail"[\s\S]*?<\/aside>/)[0];
    const brandRow = rail.slice(rail.indexOf('<div class="rail-brand">'), rail.indexOf('</div>\n  <nav class="rail-tabs"'));
    const collapseBtn = brandRow.match(/<button class="icon-btn rail-collapse-btn" id="railCollapseBtn" aria-expanded="true" aria-controls="v2Rail" aria-label="收起侧栏" title="收起侧栏">([\s\S]*?)<\/button>/);
    assert.ok(collapseBtn, "收起钮在栏顶品牌行内（品牌之后、行尾）");
    assert.ok(collapseBtn[1].includes('id="railIcoCollapse"') && /<svg id="railIcoExpand"[^>]*\shidden>/.test(collapseBtn[1]),
      "双图标在册：收起态图标默认在明、展开态图标默认藏（静态默认=宽档全栏）");
    for (const m of collapseBtn[1].matchAll(/<svg[\s\S]*?<\/svg>/g)) {
      assert.ok(m[0].includes('viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'),
        "图标与既有一枚同源（feather 24 视窗空心描边 round caps）");
    }
    // 显隐：基座整隐（双类选择器压过 .icon-btn 基座的 inline-flex），v2 全宽都出
    // （栏常驻，无档位例外）
    assert.ok(/\.icon-btn\.rail-collapse-btn \{ display: none; \}/.test(panelCss), "收起钮基座整隐（v1 不出）");
    assert.ok(panelCss.includes(':root[data-ui-version="v2"] .rail-collapse-btn { display: inline-flex; margin-left: auto; flex-shrink: 0; }'),
      "v2 栏顶出收起钮、行尾就位（无媒体查询，任何窗口宽度）");
    // 持久化与首帧：head 脚本绘制前读 panel-rail-manual 写 <html> data-rail
    const headBoot = panelHtml.slice(panelHtml.indexOf('localStorage.getItem("panel-ui-version")') - 200, panelHtml.indexOf('id="panelStartupBootstrap"'));
    assert.ok(headBoot.includes('localStorage.getItem("panel-rail-manual")') && headBoot.includes('setAttribute("data-rail", railManual)'),
      "手动态绘制前读回（同 UI版本 bootstrap 形态，首帧即手动态）");
    assert.ok(headBoot.includes('railManual === "collapsed" || railManual === "expanded"'),
      "只认在册两值，缺省/脏值=自动档（不写属性）");
    // JS：点击按有效栏态翻向并写档+写属性；有效态 = 手动态 ?? 宽度档（1200 界）
    assert.ok(panelJs.includes('const RAIL_COLLAPSE_LABEL = "收起侧栏";') && panelJs.includes('const RAIL_EXPAND_LABEL = "展开侧栏";'),
      "文案常量制（授权仅此一处新词）");
    const toggleBody = panelJs.match(/function toggleRailManual\(\) \{([\s\S]*?)\n  \}/)[1];
    assert.ok(toggleBody.includes('localStorage.setItem("panel-rail-manual", next)')
      && toggleBody.includes('setAttribute("data-rail", next)'), "点击写档并当帧写属性（CSS 全挂 data-rail）");
    const collapseBody = panelJs.match(/function initRailCollapse\(\) \{([\s\S]*?)\n  \}/)[1];
    assert.ok(collapseBody.includes('const wideMq = window.matchMedia("(min-width: 1200px)");')
      && collapseBody.includes('wideMq.addEventListener("change"'),
      "自动档跨 1200 档界重同步图标与文案（档界 mq 提为常量，同一监听兼作手动态出口）");
    assert.ok(/if \(typeof initRailCollapse === "function"\) initRailCollapse\(\);/.test(panelJs), "init 接线走 typeof 守卫");
    const effBody = panelJs.match(/function railEffectivelyCollapsed\(\) \{([\s\S]*?)\n  \}/)[1];
    assert.ok(effBody.indexOf('=== "collapsed"') < effBody.indexOf('matchMedia') && effBody.indexOf('=== "expanded"') < effBody.indexOf('matchMedia'),
      "手动态优先于宽度自动档（先判属性再落 matchMedia）");
    // CSS 双态镜像：collapsed 在 ≥1200 把宽档撤销再撤回去（回 72 形态），
    // expanded 在 <1200 把窄栏收起撤销成 216 全栏；栏多宽内容让多少
    const collapsedBlock = [...panelCss.matchAll(/@media \(min-width: 1200px\) \{[\s\S]*?\n  \}/g)].map((m) => m[0])
      .find((b) => b.includes('[data-rail="collapsed"]'));
    assert.ok(collapsedBlock, "collapsed 的 ≥1200 反撤销块在册");
    for (const pin of [':root[data-ui-version="v2"][data-rail="collapsed"] .rail { width: 72px; padding: 8px 8px 16px; }',
      '[data-rail="collapsed"] .rail-tab-label { display: none; }',
      '[data-rail="collapsed"] .layout-container { max-width: calc(1440px + 72px); padding-left: 96px; }',
      '[data-rail="collapsed"] body.terminal-mode main.layout-container { max-width: none; padding-left: 72px; }',
      '[data-rail="collapsed"] #railThemeToggle { display: none; }']) {
      assert.ok(collapsedBlock.includes(pin), `collapsed 块缺：${pin}`);
    }
    const expandedBlock = [...panelCss.matchAll(/@media \(max-width: 1199px\) \{[\s\S]*?\n  \}/g)].map((m) => m[0])
      .find((b) => b.includes('[data-rail="expanded"]'));
    assert.ok(expandedBlock, "expanded 的窄栏撤销块在册");
    for (const pin of [':root[data-ui-version="v2"][data-rail="expanded"] .rail { width: 216px; padding: 8px 12px 16px; }',
      '[data-rail="expanded"] .rail-tab-label { display: inline; }',
      '[data-rail="expanded"] .layout-container { max-width: calc(1440px + 216px); padding-left: 240px; }',
      '[data-rail="expanded"] body.terminal-mode main.layout-container { max-width: none; padding-left: 216px; }',
      '[data-rail="expanded"] #railThemeToggle { display: inline-flex; }']) {
      assert.ok(expandedBlock.includes(pin), `expanded 块缺：${pin}`);
    }
    // expanded 窄栏内容让 240、v1 阈值全程真挤压：四项布局全档塌缩同块在册
    for (const pin of ['[data-rail="expanded"] .telemetry-layout-grid { grid-template-columns: 1fr; }',
      '[data-rail="expanded"] .stats-top-grid { grid-template-columns: 1fr; }',
      '[data-rail="expanded"] .sessions-detail-wrap { grid-template-columns: minmax(0, 1fr); }',
      '[data-rail="expanded"] body.sessions-mode .toc-fab.has-toc { display: flex; }']) {
      assert.ok(expandedBlock.includes(pin), `expanded 校准缺：${pin}`);
    }
    // 终端页首帧：手静态下同链两条分档左让按属性分支修正（首帧即手动态）
    assert.ok(panelCss.includes('html[data-prepaint-view="terminal"][data-ui-version="v2"][data-rail="collapsed"] body main.layout-container { padding-left: 72px; }'),
      "终端首帧 collapsed 让 72");
    assert.ok(panelCss.includes('html[data-prepaint-view="terminal"][data-ui-version="v2"][data-rail="expanded"] body main.layout-container { padding-left: 216px; }'),
      "终端首帧 expanded 让 216");
  });

  it("收窄态栏底换钮与版本徽标纯文字：窄栏自动档与手动 collapsed 同口径", () => {
    // 收窄态栏底：亮暗钮隐（窄栏自动档 + 手动 collapsed 两条链），设置/返回钮照常；
    // 单钮居中防歪；expanded/宽档全栏召回亮暗钮（栏底照旧：亮暗+设置）
    const midAuto = [...panelCss.matchAll(/@media \(max-width: 1199px\) \{[\s\S]*?\n  \}/g)].map((m) => m[0])
      .find((b) => b.includes('#railThemeToggle { display: none; }') && !b.includes('[data-rail'));
    assert.ok(midAuto, "窄栏自动档的栏底换钮块在册");
    assert.ok(midAuto.includes(':root[data-ui-version="v2"] .rail-foot { justify-content: center; }'), "收窄态栏底单钮居中");
    assert.ok(midAuto.includes(':root[data-ui-version="v2"] .rail-brand { gap: 4px; }'),
      "收窄态品牌行横排收紧（图标/收起钮各收 24px 后 52 ≤ 栏内容 56，整行收进 48px 头行高度带）");
    // 版本徽标：仅 v2 栏顶去胶囊、纯文字挪到品牌字下方，蓝色高光走 accent；v1 头行那颗原样
    const h1Rule = panelCss.match(/:root\[data-ui-version="v2"\]\[data-style\] \.rail-brand \.brand-text h1 \{([^}]*)\}/);
    assert.ok(h1Rule && h1Rule[1].includes("display: block;") && h1Rule[1].includes("font-size: 14px;") && h1Rule[1].includes("line-height: 1.2;"),
      "品牌字改块级并收 14px/1.2——徽标自然折到下一行，两行块收进头行高度带");
    const tagRule = panelCss.match(/:root\[data-ui-version="v2"\]\[data-style\] \.rail-brand \.version-tag \{([^}]*)\}/);
    assert.ok(tagRule, "v2 栏顶徽标规则在册");
    assert.ok(tagRule[1].includes("background: transparent;") && tagRule[1].includes("border: 0;") && tagRule[1].includes("color: var(--accent);"),
      "去胶囊：去底/边纯文字，字色回 accent 蓝（不造新色值）");
    assert.ok(tagRule[1].includes("border-radius: 0;"), "三皮肤的 999px 胶囊圆角同被压掉");
    assert.ok(tagRule[1].includes("font-size: 11px;") && tagRule[1].includes("line-height: 1.2;") && tagRule[1].includes("display: inline-block;"),
      "栏顶徽标收 11px/1.2（与品牌字两行一起压进 48px 高度带）且 inline-block（顶距才真正生效）");
    assert.ok(/\.brand-text \.version-tag \{\s*font-size: 12\.5px/.test(panelCss), "v1/基座胶囊徽标原样不动");
  });

  it("左栏收展表现层：手动切换那一次栏自身宽度滑动、收起态滚条与图标、安静钮、快捷键豁免、宽档出口", () => {
    // ── 动效手法（10-14 拍板）：只对栏自身做宽度过渡，盖板与 clip-path 双出局 ──
    // 栏 fixed 定位、内容让位靠 padding，栏宽不参与内容重排，无需合成盖板；
    // clip-path 只能减不能加（收起时边线被裁走）。开关只挂 <html> 临时属性。
    assert.ok(panelCss.includes(':root[data-ui-version="v2"][data-rail-anim] .rail { transition: width 200ms cubic-bezier(0.2, 0, 0, 1); }'),
      "栏宽滑动规则在册（基座常驻无媒体门槛——栏任何窗口宽度都作数；时长与缓动照 ccswitch v4）");
    // 内容让位必须与栏同缓动：栏 fixed/z-index 40/底色不透明，让位当帧到位而栏还在滑，
    // 收起向栏压在已让开的文字上、展开向栏裁掉未缩小的行右端（终端 120ms 防抖才重排）
    assert.ok(panelCss.includes(':root[data-ui-version="v2"][data-rail-anim] main.layout-container { transition: padding-left 200ms cubic-bezier(0.2, 0, 0, 1), max-width 200ms cubic-bezier(0.2, 0, 0, 1); }'),
      "容器让位同开关、同时长同缓动，且 padding-left 与 max-width 两属性都在（只过渡一个，宽窗口内容宽反抖 144px）");
    assert.equal(panelCss.match(/padding-left 200ms/g).length, 1, "容器过渡只此一条（与栏开关同链，不另开分路）");
    assert.ok(/:root\[data-ui-version="v2"\] \.rail \{[^}]*overflow-y: auto; overflow-x: hidden;/.test(panelCss),
      "栏基座横轴显式收掉（单轴 auto 会让 overflow-x 算成 auto，动画途中蹦横条）");
    // ── 收起态两处细节：隐栏内滚条 + 图标放大一档；收起态两个来处各挂一条 ──
    const midCollapsedBlock = [...panelCss.matchAll(/@media \(max-width: 1199px\) \{[\s\S]*?\n  \}/g)].map((m) => m[0])
      .find((b) => b.includes('.rail::-webkit-scrollbar'));
    assert.ok(midCollapsedBlock, "窄栏收起态的细节块在册");
    assert.ok(midCollapsedBlock.includes(':root[data-ui-version="v2"]:not([data-rail="expanded"]) .rail::-webkit-scrollbar { width: 0; }')
      && midCollapsedBlock.includes(':root[data-ui-version="v2"]:not([data-rail="expanded"]) .rail .rail-tab svg { width: 17px; height: 17px; }'),
      "窄栏用 :not(expanded) 让开手动全栏（无需反向召回），展开态滚条照旧在");
    const wideCollapsedBlock = [...panelCss.matchAll(/@media \(min-width: 1200px\) \{[\s\S]*?\n  \}/g)].map((m) => m[0])
      .find((b) => b.includes('[data-rail="collapsed"] .rail::-webkit-scrollbar'));
    assert.ok(wideCollapsedBlock, "宽档手动收起的同款细节块在册");
    assert.ok(wideCollapsedBlock.includes('[data-rail="collapsed"] .rail .rail-tab svg { width: 17px; height: 17px; }'),
      "宽档 collapsed 图标同放大（主 tab、设置目录、栏底两钮同批，收起钮不吃）");
    // ── 安静钮：只改栏顶这一颗，脱离通用 .icon-btn 的描边+底+投影 ──
    const quietAt = panelCss.indexOf(':root[data-ui-version="v2"] .rail-brand .rail-collapse-btn.icon-btn {');
    assert.ok(quietAt > 0, "安静钮规则块在册（基座常驻，无媒体门槛）");
    const quietBlock = quietAt > 0 ? panelCss.slice(quietAt, quietAt + 700) : "";
    const quietRule = panelCss.match(/:root\[data-ui-version="v2"\] \.rail-brand \.rail-collapse-btn\.icon-btn \{([\s\S]*?)\}/);
    assert.ok(quietRule, "安静钮作用域锁 .rail-brand（栏底亮暗与设置钮形制不动）");
    for (const pin of ["width: 28px;", "height: 28px;", "border: 0;", "background: transparent;", "box-shadow: none;"]) {
      assert.ok(quietRule[1].includes(pin), `安静钮缺：${pin}`);
    }
    assert.ok(/\.rail-collapse-btn\.icon-btn:hover \{[^}]*background: var\(--surface-hover\);/.test(quietBlock), "hover 才浮浅底");
    assert.ok(/\.rail-collapse-btn\.icon-btn:active \{ transform: scale\(0\.96\); \}/.test(quietBlock), "按下微缩一档");
    // ── JS：滑动开关只挂手动路径，自动档与 reduced-motion 一律不挂 ──
    assert.ok(panelJs.includes('const RAIL_ANIM_ATTR = "data-rail-anim";'), "开关属性名常量制（与 CSS 同源）");
    const slideBody = panelJs.match(/function requestRailSlide\(\) \{([\s\S]*?)\n  \}/)[1];
    assert.ok(slideBody.includes('prefers-reduced-motion: reduce') && slideBody.includes("return;"),
      "reduced-motion 命中直接不挂开关");
    assert.ok(slideBody.includes(`root.setAttribute(RAIL_ANIM_ATTR, "1")`) && slideBody.includes("root.removeAttribute(RAIL_ANIM_ATTR)"),
      "开关写了必撤（定时器到点撤除，宽度没变化的场合也照样撤干净）");
    const toggleBody = panelJs.match(/function toggleRailManual\(\) \{([\s\S]*?)\n  \}/)[1];
    assert.ok(toggleBody.indexOf("requestRailSlide()") < toggleBody.indexOf('setAttribute("data-rail", next)'),
      "先挂开关再改栏宽（同一帧起算过渡）");
    const syncBody = panelJs.match(/function syncRailCollapseBtn\(\) \{([\s\S]*?)\n  \}/)[1];
    assert.ok(syncBody.includes("syncRailTabTitles(collapsed)"),
      "摘挂提示随有效栏态走（与钮的 aria、图标换向同一处收口）");
    const titleBody = panelJs.match(/function syncRailTabTitles\(collapsed\) \{([\s\S]*?)\n  \}/)[1];
    assert.ok(titleBody.includes('tab.setAttribute("title", label.textContent.trim())') && titleBody.includes('tab.removeAttribute("title")'),
      "收起态以标签文本回填 title、展开态摘掉（收起态标签不渲染，title 是唯一名字来源）");
    const collapseBody = panelJs.match(/function initRailCollapse\(\) \{([\s\S]*?)\n  \}/)[1];
    assert.ok(collapseBody.includes("btn.onclick = () => toggleRailManual();"), "钮与快捷键走同一条链");
    assert.ok(/if \(wideMq\.matches\) releaseRailManual\(\);\s*syncRailCollapseBtn\(\);/.test(collapseBody),
      "跨进宽档解除手动态，两向都重同步图标与文案");
    const releaseBody = panelJs.match(/function releaseRailManual\(\) \{([\s\S]*?)\n  \}/)[1];
    assert.ok(releaseBody.includes('root.removeAttribute("data-rail")') && releaseBody.includes('localStorage.removeItem("panel-rail-manual")'),
      "手动态出口：属性与存档一并清（拖回宽档即回到跟随窗口）");
    assert.ok(!releaseBody.includes("requestRailSlide"), "解除属自动态变化，不挂滑动开关");
    for (const pin of ['event.key !== "\\\\"', '!document.documentElement.hasAttribute("data-ui-version")',
      "event.isComposing || event.keyCode === 229", 'active.tagName === "INPUT"', 'active.tagName === "TEXTAREA"',
      'active.tagName === "SELECT"', "active.isContentEditable", 'currentView === "terminal"']) {
      assert.ok(collapseBody.includes(pin), `快捷键豁免缺：${pin}`);
    }
    assert.ok(!collapseBody.includes('matchMedia("(min-width: 860px)")'),
      "快捷键无宽度门槛——栏任何窗口宽度常驻，Ctrl+\\ 全档在管");
  });

  it("收展交叉淡化：收起向定宽淡出＋落态延迟＋rail-in 进场，展开向整体淡入（dsh 规格）", () => {
    // ── JS：三个瞬态属性与 150ms 落态延迟（dsh SidebarRoot「slide＋crossfade」）──
    for (const pin of ['const RAIL_COLLAPSING_ATTR = "data-rail-collapsing";',
      'const RAIL_WIDEIN_ATTR = "data-rail-widein";',
      'const RAIL_RAILIN_ATTR = "data-rail-railin";',
      "const RAIL_SETTLE_MS = 150;", "const RAIL_RAILIN_MS = 200;"]) {
      assert.ok(panelJs.includes(pin), `收展瞬态常量缺：${pin}`);
    }
    const toggleBody = panelJs.match(/function toggleRailManual\(\) \{([\s\S]*?)\n  \}/)[1];
    assert.ok(toggleBody.includes('root.setAttribute(RAIL_COLLAPSING_ATTR, "1")'), "收起向先挂淡出窗口");
    const settleAt = toggleBody.indexOf("RAIL_SETTLE_MS"), attrAt = toggleBody.indexOf('root.setAttribute(RAIL_COLLAPSING_ATTR, "1")');
    assert.ok(attrAt > -1 && settleAt > attrAt && /setTimeout\(\(\) => \{[\s\S]*?root\.setAttribute\("data-rail", next\);/.test(toggleBody),
      "落态写进 150ms 定时器回调——淡出完成后 display:none 才隐（无硬切）");
    assert.ok(/root\.setAttribute\("data-rail", next\);[\s\S]*?root\.setAttribute\(RAIL_RAILIN_ATTR, "1"\);/.test(toggleBody),
      "落态同拍放 rail-in 进场，掩掉布局换装的一瞬");
    assert.ok(toggleBody.includes('root.setAttribute(RAIL_WIDEIN_ATTR, "1")'), "展开向挂整体淡入");
    const effBody2 = panelJs.match(/function railEffectivelyCollapsed\(\) \{([\s\S]*?)\n  \}/)[1];
    assert.ok(/if \(railCollapseInFlight\) return true;/.test(effBody2)
      && effBody2.indexOf("railCollapseInFlight") < effBody2.indexOf('=== "collapsed"'),
      "收起在飞计入有效栏态且优先于属性判（钮即刻换向；窗口内再点自然反转成 expanded）");
    const clearBody = panelJs.match(/function railClearCollapseSequence\(\) \{([\s\S]*?)\n  \}/)[1];
    for (const attr of ["RAIL_COLLAPSING_ATTR", "RAIL_WIDEIN_ATTR", "RAIL_RAILIN_ATTR"]) {
      assert.ok(clearBody.includes(`root.removeAttribute(${attr})`), `中断收口摘 ${attr}`);
    }
    const collapseInit = panelJs.match(/function initRailCollapse\(\) \{([\s\S]*?)\n  \}/)[1];
    assert.ok(/wideMq\.addEventListener\("change", \(\) => \{\s*\n\s*railClearCollapseSequence\(\);/.test(collapseInit),
      "跨档自动变化先撤收起序半程序再走手动态出口");
    // ── CSS：淡出／进场／宽度让位镜像／reduced-motion 压零 ──
    assert.ok(panelCss.includes("@keyframes rail-wide-in { from { opacity: 0; } }"), "展开淡入关键帧在册");
    assert.ok(panelCss.includes("@keyframes rail-rail-in { from { opacity: 0; transform: translateX(49px); } }"),
      "rail-in 从右侧 49px 滑入（dsh 同值）");
    const fadeRule = panelCss.match(/\[data-rail-collapsing\] \.rail > :is\(\.rail-brand, \.rail-tabs, \.rail-dir, \.rail-terminal-dir, \.rail-foot\) \{([^}]*)\}/);
    assert.ok(fadeRule, "淡出规则在册（五个直接子块）");
    assert.ok(fadeRule[1].includes("min-width: 192px;") && fadeRule[1].includes("opacity: 0;")
      && fadeRule[1].includes("transition: opacity 150ms var(--ease-out);"),
      "内容钉 192px（宽态内容宽，不折行不省略）原地淡出 150ms");
    assert.ok(panelCss.includes(':root[data-ui-version="v2"][data-rail-collapsing] .rail { width: 72px; padding: 8px 8px 16px; }'),
      "淡出窗口的栏宽镜像照终态值（栏宽与淡出同帧起算，不空滑）");
    assert.ok(panelCss.includes(':root[data-ui-version="v2"][data-rail-collapsing] .layout-container { max-width: calc(1440px + 72px); padding-left: 96px; }')
      && panelCss.includes(':root[data-ui-version="v2"][data-rail-collapsing] body.terminal-mode main.layout-container { max-width: none; padding-left: 72px; }'),
      "让位镜像同窗口起算（晚一个窗口会在栏与内容间露底）");
    assert.ok(panelCss.includes('[data-rail-railin] .rail > .rail-foot {\n    animation: rail-wide-in 150ms'),
      "栏底行只淡入不位移（dsh footArea 同款）");
    assert.ok(/@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*:root\[data-ui-version="v2"\]\[data-rail-collapsing\][\s\S]{0,600}?transition: none; animation: none;/.test(panelCss),
      "reduced-motion 压零段在册（淡化全关、直接落位）");
  });
});

describe("设置项「运行日志」", () => {
  function loggingRouter({ logger, base }) {
    return createPanelRouter({
      base,
      storePaths: { root: "C:/fake/anyswitch" },
      logger, metricsCollector: null, aliasResolver: null, aliasPath: null,
      enableWatchdogAutostartFn: async () => ({ ok: true }),
      disableWatchdogAutostartFn: async () => ({ ok: true }),
      isWatchdogAutostartEnabledFn: async () => false,
      spawnWatchdogFn: async () => ({ ok: true }),
      stopWatchdogFn: async () => ({ ok: true }),
      probeWatchdogFn: async () => false,
      fetchRelayAgents: async () => null,
      spawnAgentSyncFn: async () => ({ ok: true, stdout: "" }),
    });
  }
  function loggingBase() {
    const dir = mkTestDir("anyswitch-panel-logging-");
    const relayDataRoot = join(dir, "Anyswitch");
    mkdirSync(relayDataRoot, { recursive: true });
    return { base: { LOCALAPPDATA: dir, USERPROFILE: join(dir, "user") }, dir: relayDataRoot };
  }

  it("未落盘时默认为开，POST false 后 GET 回读为 false", async () => {
    const { base, dir } = loggingBase();
    const router = loggingRouter({ logger: null, base });

    const initial = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(initial.req, initial.res);
    assert.equal(JSON.parse(initial.res.body).settings.loggingEnabled, true, "开关默认开——升级上来的安装行为不变");

    const post = fakeReqRes("/panel/api/settings", "POST", { loggingEnabled: false });
    await router.handle(post.req, post.res);
    assert.equal(JSON.parse(post.res.body).ok, true);

    const after = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(after.req, after.res);
    assert.equal(JSON.parse(after.res.body).settings.loggingEnabled, false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("关掉时丢掉已缓冲内容并向所有打开的面板窗口广播清空", async () => {
    const { base, dir } = loggingBase();
    const logger = createLogger({ sink: () => {} });
    const router = loggingRouter({ logger, base });
    logger.info("before-off");

    const frames = [];
    const unsubscribe = logger.subscribe((entry) => frames.push(entry));
    const post = fakeReqRes("/panel/api/settings", "POST", { loggingEnabled: false });
    await router.handle(post.req, post.res);
    unsubscribe();

    assert.equal(logger.getHistory().length, 0,
      "不丢的话，重新打开会先涌出一批关闭前的旧行，看着像「关掉没生效」");
    assert.ok(frames.some((f) => f.type === "clear"), "清空帧广播出去，别的窗口一起空");

    // 重新开启时窗口从新日志开始。
    const back = fakeReqRes("/panel/api/settings", "POST", { loggingEnabled: true });
    await router.handle(back.req, back.res);
    logger.info("after-on");
    assert.deepEqual(logger.getHistory().map((e) => e.message), ["after-on"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("开着时日志流正常建连；关掉时以 204 收尾，不挂一条只会干等的 SSE", async () => {
    const { base, dir } = loggingBase();
    // 闸门挂在 logger 上（生产里由 panel-host 装配）：SSE 端点问的是它，而不是
    // 每次请求去读一遍设置文件。
    const settingsPath = join(dir, "settings.json");
    const logger = createLogger({
      sink: () => {},
      isEnabled: createLoggingEnabledGate(settingsPath, {}),
    });
    const router = loggingRouter({ logger, base });

    const on = fakeReqRes("/panel/api/logs", "GET");
    let flushed = 0;
    on.res.flushHeaders = () => { flushed += 1; };
    await router.handle(on.req, on.res);
    assert.equal(on.res.statusCode, 200);
    assert.equal(flushed, 1,
      "必须显式冲头：空闲时一个字节都不写，不冲头浏览器会一直停在「正在重连」");

    const off = fakeReqRes("/panel/api/settings", "POST", { loggingEnabled: false });
    await router.handle(off.req, off.res);
    const stream = fakeReqRes("/panel/api/logs", "GET");
    await router.handle(stream.req, stream.res);
    assert.equal(stream.res.statusCode, 204, "记录停着就不该建这条流");
    rmSync(dir, { recursive: true, force: true });
  });

  it("写入闸门按设置实时开关：关掉后不再落盘、不再进缓冲", () => {
    const { base, dir } = loggingBase();
    const lines = [];
    const gate = createLoggingEnabledGate(join(dir, "settings.json"), {});
    const logger = createLogger({ sink: (line) => lines.push(line), isEnabled: gate });

    logger.info("recorded");
    assert.equal(lines.length, 1);

    saveSettings(join(dir, "settings.json"), { loggingEnabled: false }, {});
    logger.info("dropped");
    assert.equal(lines.length, 1, "关掉后写入即停，不需要重启进程");
    assert.equal(logger.getHistory().length, 1, "也不进环形缓冲");

    saveSettings(join(dir, "settings.json"), { loggingEnabled: true }, {});
    logger.info("recorded-again");
    assert.equal(lines.length, 2);
    rmSync(dir, { recursive: true, force: true });
  });

  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );

  it("挂在「通用」子页的「实时输出」卡里，沿用既有 .toggle 控件", () => {
    const item = panelHtml.match(/<div class="modal-item">[\s\S]*?记录运行日志[\s\S]*?<\/label>\s*<\/div>/);
    assert.ok(item, "条目挂在设置页内");
    assert.ok(item[0].includes('<label class="toggle">'), "沿用全局开关控件与各主题皮肤");
    assert.ok(item[0].includes('id="loggingEnabledToggle"'), "开关有稳定 id 供读写");
    assert.ok(item[0].includes("关闭后停止记录，左侧的实时输出一并隐藏"), "说明写清关闭后的后果");
  });

  it("左侧实时输出卡有稳定 id，供开关驱动整卡显隐", () => {
    assert.ok(panelHtml.includes('<div class="panel-card" id="liveLogCard">'), "实时输出卡可被定位");
  });

  it("关掉时断流、清空并隐去整卡；重新打开才重新建连", () => {
    const source = panelJs.match(/function applyLoggingEnabled\(enabled\) \{[\s\S]*?\n  \}/);
    assert.ok(source, "applyLoggingEnabled 在 panel.js 里");
    const card = { hidden: false };
    const body = { innerHTML: "old rows" };
    const state = { es: { closed: false, close() { this.closed = true; } } };
    let connects = 0;
    const run = new Function(
      "card", "body", "state", "onConnect",
      `const $ = (id) => (id === "liveLogCard" ? card : id === "logBody" ? body : null);
       let es = state.es;
       function connectLogStream() { onConnect(); }
       let loggingEnabled = null;
       ${source[0]}
       const apply = applyLoggingEnabled;
       return {
         apply,
         get es() { return es; },
         get loggingEnabled() { return loggingEnabled; },
       };`,
    );
    const api = run(card, body, state, () => { connects += 1; });

    api.apply(false);
    assert.equal(card.hidden, true, "整卡隐去——记录停了，留一张空窗只是噪声");
    assert.equal(body.innerHTML, "", "已缓冲的内容一并清掉");
    assert.equal(api.es, null, "流断开，不再挂着一条永远没内容的连接");
    assert.equal(api.loggingEnabled, false);

    api.apply(true);
    assert.equal(card.hidden, false, "重新打开立刻回来，不需要刷新");
    assert.equal(connects, 1, "只有重新打开才重新建连");
  });

  it("首次问开关发生在建流之前，且不覆盖用户已经切过的值", async () => {
    const source = panelJs.match(/async function startLogStream\(\) \{[\s\S]*?\n  \}/);
    assert.ok(source, "startLogStream 在 panel.js 里");
    const order = [];
    // 替身照着真身的行为：定态之后，开着才建流（真身里那一步是 applyLoggingEnabled
    // 转给 connectLogStream，这里只关心它发生在问开关之后）。
    const run = new Function(
      "order", "settingsResult",
      `const $ = () => ({ addEventListener() {}, onclick: null });
       const api = async () => { order.push("ask"); return settingsResult; };
       let loggingEnabled = null;
       let logLevel = null;
       function applyLoggingEnabled(v) { loggingEnabled = v; order.push("apply:" + v); if (v) connectLogStream(); }
       function applyLogLevel(v) { logLevel = v; order.push("level:" + v); }
       function connectLogStream() { order.push("connect"); }
       ${source[0]}
       return {
         start: startLogStream,
         setSeen(v) { loggingEnabled = v; },
       };`,
    );

    const off = run(order, { settings: { loggingEnabled: false } });
    await off.start();
    assert.deepEqual(order, ["ask", "level:info", "apply:false"], "关着时不建流");

    order.length = 0;
    const on = run(order, { settings: { loggingEnabled: true } });
    await on.start();
    assert.deepEqual(order, ["ask", "level:info", "apply:true", "connect"],
      "开着时先定态再建流；级别定在建流之前，重放第一帧就按这一档走");

    order.length = 0;
    const raced = run(order, { settings: { loggingEnabled: true } });
    raced.setSeen(false);
    await raced.start();
    assert.deepEqual(order, ["ask", "level:info"], "已经有定论时不再覆盖界面");

    // 服务端存着级别时，建流之前用的就是它，不是默认的「显示全部」。
    order.length = 0;
    const withLevel = run(order, { settings: { loggingEnabled: true, logLevel: "error" } });
    await withLevel.start();
    assert.deepEqual(order, ["ask", "level:error", "apply:true", "connect"]);
  });

  it("保存失败时开关弹回原状并报错，成功则按服务端回读值落地", async () => {
    const source = panelJs.match(/loggingEnabledToggle\.onchange = async \(\) => \{[\s\S]*?\n      \};/);
    assert.ok(source, "onchange 处理器在 panel.js 里");
    const runHandler = (checked, apiResult) => {
      const toggle = { checked, setAttribute() {}, removeAttribute() {} };
      const calls = [];
      const toasts = [];
      const settingsSaving = { loggingEnabled: false };
      const applied = [];
      const run = new Function(
        "loggingEnabledToggle", "settingsSaving", "api", "toast", "applyLoggingEnabled",
        `let settingsLoadGen = 0; ${source[0]} return loggingEnabledToggle.onchange();`,
      );
      return {
        done: run(toggle, settingsSaving,
          async (method, path, body) => { calls.push({ method, path, body }); return apiResult; },
          (message) => toasts.push(message),
          (v) => applied.push(v)),
        calls, toasts, toggle, applied,
        savingAfter: () => settingsSaving.loggingEnabled,
      };
    };

    const on = runHandler(true, { ok: true, settings: { loggingEnabled: true } });
    await on.done;
    assert.deepEqual(on.calls, [{ method: "POST", path: "/api/settings", body: { loggingEnabled: true } }]);
    assert.deepEqual(on.applied, [true], "界面跟着服务端回读值走");
    assert.deepEqual(on.toasts, ["已开启运行日志"]);
    assert.equal(on.savingAfter(), false, "保存中标记已释放");

    const off = runHandler(false, { ok: true, settings: { loggingEnabled: false } });
    await off.done;
    assert.deepEqual(off.applied, [false]);
    assert.deepEqual(off.toasts, ["已关闭运行日志"]);

    const failed = runHandler(false, { ok: false });
    await failed.done;
    assert.equal(failed.toggle.checked, true, "回滚到点击前状态");
    assert.deepEqual(failed.applied, [], "失败不落地界面");
    assert.deepEqual(failed.toasts, ["设置保存失败"]);
  });

  // ── 「日志级别」：过滤只发生在 SSE 出口，档案与缓冲一律全量 ──────────────
  // res.write 不在通用 fakeReqRes 上（SSE 端点才会逐帧写），所以这里就地补一个能
  // 收下帧的假 res，再把 data: 行还原成条目。
  function ssePair(url) {
    const pair = fakeReqRes(url, "GET");
    const chunks = [];
    pair.res.write = (s) => { chunks.push(String(s)); return true; };
    pair.res.flushHeaders = () => {};
    pair.frames = () => chunks.join("").split("\n\n").filter(Boolean)
      .map((frame) => JSON.parse(frame.replace(/^data: /, "")));
    return pair;
  }

  async function routerWithLevels(initialLevel) {
    const { base, dir } = loggingBase();
    const lines = [];
    const logger = createLogger({ sink: (line) => lines.push(line) });
    const router = loggingRouter({ logger, base });
    if (initialLevel) {
      const post = fakeReqRes("/panel/api/settings", "POST", { logLevel: initialLevel });
      await router.handle(post.req, post.res);
    }
    return { router, logger, lines, dir };
  }

  it("重放按门槛筛：info 全给，warn 只剩警告与错误，error 只剩错误", async () => {
    const cases = [["info", ["a", "b", "c"]], ["warn", ["b", "c"]], ["error", ["c"]]];
    for (const [level, expected] of cases) {
      const { router, logger, dir } = await routerWithLevels(level);
      logger.info("a"); logger.warn("b"); logger.error("c");
      const pair = ssePair("/panel/api/logs");
      await router.handle(pair.req, pair.res);
      assert.deepEqual(pair.frames().map((f) => f.message), expected, `门槛 ${level} 时的重放结果`);
      assert.equal(logger.getHistory().length, 3,
        "环形缓冲不因门槛变窄——档案与缓冲全量，只有显示出口在筛");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("已建着的流逐帧过闸：换门槛不必重连就不再收到低级别新行", async () => {
    const { router, logger, dir } = await routerWithLevels("info");
    const pair = ssePair("/panel/api/logs");
    await router.handle(pair.req, pair.res);
    assert.equal(pair.frames().length, 0, "空缓冲建连，先什么都不给");

    const post = fakeReqRes("/panel/api/settings", "POST", { logLevel: "error" });
    await router.handle(post.req, post.res);

    logger.info("noise");
    logger.warn("still-noise");
    logger.error("keep me");
    assert.deepEqual(pair.frames().map((f) => f.message), ["keep me"],
      "同一条连接当场按新门槛走，别的已打开窗口不必重连");
    rmSync(dir, { recursive: true, force: true });
  });

  it("清空帧与认不出的级别一律放行", async () => {
    const { router, logger, dir } = await routerWithLevels("error");
    const pair = ssePair("/panel/api/logs");
    await router.handle(pair.req, pair.res);

    // 清空是控制操作、不是一条日志：它没有 level，被筛掉的话窗口就再也空不了。
    logger.clear();
    // 将来真加第四级时，它不该因为一个显示过滤器不认识它就从面板上消失。
    logger.log("debug", "future level");
    const frames = pair.frames();
    assert.ok(frames.some((f) => f.type === "clear"), "清空帧照到");
    assert.ok(frames.some((f) => f.message === "future level"), "未知级别不被吞掉");
    rmSync(dir, { recursive: true, force: true });
  });

  it("抬门槛不碰落盘：中继那条写文件的路一行不少", async () => {
    const { router, logger, lines, dir } = await routerWithLevels("error");
    logger.info("info line");
    logger.warn("warn line");
    logger.error("error line");
    assert.equal(lines.length, 3, "sink 收到全部三行");
    assert.ok(lines.every((line, i) => line.includes(["info line", "warn line", "error line"][i])),
      "落盘内容与顺序都不变");
    assert.equal(logger.getHistory().length, 3, "缓冲同样全量");
    rmSync(dir, { recursive: true, force: true });
  });

  it("设置往返：写入后 GET 回读，畸形值回落成 info", async () => {
    const { router, dir } = await routerWithLevels(null);
    const initial = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(initial.req, initial.res);
    assert.equal(JSON.parse(initial.res.body).settings.logLevel, "info",
      "没落盘时是「显示全部」那一档，升级上来的安装行为不变");

    const post = fakeReqRes("/panel/api/settings", "POST", { logLevel: "warn" });
    await router.handle(post.req, post.res);
    assert.equal(JSON.parse(post.res.body).settings.logLevel, "warn");

    const after = fakeReqRes("/panel/api/settings", "GET");
    await router.handle(after.req, after.res);
    assert.equal(JSON.parse(after.res.body).settings.logLevel, "warn");

    const bogus = fakeReqRes("/panel/api/settings", "POST", { logLevel: "trace" });
    await router.handle(bogus.req, bogus.res);
    assert.equal(JSON.parse(bogus.res.body).settings.logLevel, "info", "认不出的值不落盘成畸形值");
    rmSync(dir, { recursive: true, force: true });
  });

  it("从属行在「实时输出」卡内、随总开关收起，控件有稳定 id", () => {
    const toggleAt = panelHtml.indexOf('id="loggingEnabledToggle"');
    const rowsAt = panelHtml.indexOf('<div id="logLevelRows" hidden>');
    const selectAt = panelHtml.indexOf('id="logLevelSelect"');
    const panelEnd = panelHtml.indexOf('id="settingsPanelRoute"');
    assert.ok(toggleAt > 0 && rowsAt > toggleAt && selectAt > rowsAt, "级别行紧跟在总开关之后");
    assert.ok(rowsAt < panelEnd, "整段仍在「通用」子页内，没有漏到别的 tab");
    assert.ok(panelHtml.slice(rowsAt, selectAt + 40).includes("日志级别"), "行标题是「日志级别」");
    assert.ok(panelHtml.includes('<option value="info">信息</option>')
      && panelHtml.includes('<option value="warn">警告</option>')
      && panelHtml.includes('<option value="error">错误</option>'), "三档选项齐备");
    assert.ok(panelHtml.slice(rowsAt, panelEnd).includes("级别说明："), "图例在段内");
    for (const tag of ["ERROR", "WARN", "INFO"]) {
      assert.ok(panelHtml.slice(rowsAt, panelEnd).includes(tag), `图例覆盖 ${tag}`);
    }
  });

  it("从属段说明只讲用户看得懂的行为，不出现字段名", () => {
    const desc = panelHtml.match(/<div class="modal-item-desc">(实时输出只显示[^<]*)<\/div>/);
    assert.ok(desc, "说明文案存在");
    assert.equal(desc[1], "实时输出只显示所选级别及其更高级别的日志行。", "文案逐字定稿");
    assert.doesNotMatch(desc[1], /logLevel|loggingEnabled|logger|SSE|level/, "正文不出现标识符与机制词");
    assert.doesNotMatch(desc[1], /[A-Za-z]+_[A-Za-z]+|[a-z]+[A-Z][A-Za-z]+/, "正文不出现 snake_case / camelCase");
  });

  it("整段的显隐只在 applyLoggingEnabled 一处切，级别行不另立第二套判据", () => {
    const source = panelJs.match(/function applyLoggingEnabled\(enabled\) \{[\s\S]*?\n  \}/);
    assert.ok(source, "applyLoggingEnabled 在 panel.js 里");
    const card = { hidden: false };
    const rows = { hidden: true };
    const body = { innerHTML: "old rows" };
    const run = new Function(
      "card", "rows", "body", "onConnect",
      `const $ = (id) => (id === "liveLogCard" ? card : id === "logBody" ? body : id === "logLevelRows" ? rows : null);
       let es = { close() {} };
       function connectLogStream() { onConnect(); }
       let loggingEnabled = null;
       ${source[0]}
       return { apply: applyLoggingEnabled, get es() { return es; } };`,
    );
    const api = run(card, rows, body, () => {});
    api.apply(false);
    assert.equal(rows.hidden, true, "记录停了，选级别没有意义 → 整段收起");
    api.apply(true);
    assert.equal(rows.hidden, false, "重新打开立刻回到原来那一档");
  });

  it("只有已经建着流时换档才重连；同值与开屏定态都不动", () => {
    const source = panelJs.match(/function applyLogLevel\(level\) \{[\s\S]*?\n  \}/);
    assert.ok(source, "applyLogLevel 在 panel.js 里");
    const sel = { value: "" };
    let restarts = 0;
    const run = new Function(
      "sel", "onRestart", "stream",
      `const $ = () => sel;
       function restartLogStream() { onRestart(); }
       let es = stream.es;
       let logLevel = null;
       ${source[0]}
       return { apply: applyLogLevel, get level() { return logLevel; } };`,
    );

    // 开屏：流还没建（applyLoggingEnabled 随后才连），此时不该抢先重连一次。
    const cold = run(sel, () => { restarts += 1; }, { es: null });
    cold.apply("info");
    assert.equal(sel.value, "info", "首次定态把选框对齐");
    assert.equal(restarts, 0, "流还没建，谈不上重连");

    // 已建流：进设置页重读设置回灌同一档，不许把流拆了重建（屏幕会闪一下）。
    const stream = { es: { close() {} } };
    const same = run(sel, () => { restarts += 1; }, stream);
    same.apply("warn");
    same.apply("warn");
    assert.equal(restarts, 1, "第一次换档重连一次");
    assert.equal(same.level, "warn");

    same.apply("error");
    assert.equal(restarts, 2, "再换一档，再重连一次");
    assert.equal(same.level, "error");
  });

  it("级别保存：成功按服务端回读落地，失败弹回原档且不重连", async () => {
    const source = panelJs.match(/logLevelSelect\.onchange = async \(\) => \{[\s\S]*?\n      \};/);
    assert.ok(source, "onchange 处理器在 panel.js 里");
    const runHandler = (value, apiResult, opts = {}) => {
      const calls = [];
      const toasts = [];
      const applied = [];
      const settingsSaving = { logLevel: false };
      const select = {
        value,
        selectedOptions: [{ textContent: value === "warn" ? "警告" : "错误" }],
        setAttribute() {},
        removeAttribute() {},
      };
      const run = new Function(
        "logLevelSelect", "settingsSaving", "api", "toast", "applyLogLevel", "panelError", "logLevel",
        `let settingsLoadGen = 0; ${source[0]} return logLevelSelect.onchange();`,
      );
      const done = run(
        select, settingsSaving,
        async (method, path, body) => {
          calls.push({ method, path, body });
          if (opts.throwOnPost) throw new Error("boom");
          return apiResult;
        },
        (message) => toasts.push(message),
        (v) => applied.push(v),
        (e, fallback) => fallback,
        opts.knownLevel ?? "info",
      );
      return { done, calls, toasts, applied, select, savingAfter: () => settingsSaving.logLevel };
    };

    const ok = runHandler("warn", { ok: true, settings: { logLevel: "warn" } });
    await ok.done;
    assert.deepEqual(ok.calls, [{ method: "POST", path: "/api/settings", body: { logLevel: "warn" } }]);
    assert.deepEqual(ok.applied, ["warn"], "界面跟着服务端回读值走");
    assert.deepEqual(ok.toasts, ["日志级别已设为警告"], "toast 说结果＋新值，措辞抄选项文字");
    assert.equal(ok.savingAfter(), false, "保存中标记已释放");

    const failed = runHandler("error", { ok: false }, { knownLevel: "warn" });
    await failed.done;
    assert.equal(failed.select.value, "warn", "回滚到上一档");
    assert.deepEqual(failed.applied, [], "失败不落地界面、不重连");
    assert.deepEqual(failed.toasts, ["设置保存失败"]);

    const threw = runHandler("error", null, { throwOnPost: true, knownLevel: "info" });
    await threw.done;
    assert.equal(threw.select.value, "info", "异常同样回滚");
    assert.deepEqual(threw.toasts, ["请求失败"]);
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

  it("「同步到端点」按钮与它的反馈整体下线，Codex 目录那两句不得借机复活", () => {
    // 用户 10-06 定稿：渠道配置一变、relay 一启动都会自动同步，这颗手动按钮没有
    // 存在必要，按钮 DOM、点击处理与它的反馈文案一并删除。09-21 那条红线（反馈
    // 只到「哪些端点写进去了」）随按钮消失，两个常量仍是「不得复活」的锚点：
    // 谁要把它们加回界面，本用例必红、必进 diff。
    assert.ok(!panelHtml.includes("storeSyncAgentsBtn"), "按钮 DOM 不得残留");
    assert.ok(!panelJs.includes("storeSyncAgentsBtn"), "点击处理不得残留");
    assert.ok(!panelHtml.includes("同步到端点"), "按钮文案不得残留");
    assert.ok(!allUiText.includes("syncCodexCatalogNote"), "拼句子的函数整体撤回，不得复活");
    assert.ok(!allUiText.includes("CODEX_PICKER_PAGE_SIZE"), "页容量常量随之撤回，不得复活");
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

  it("入池迁移回报：组池/加池/重排成功提示接 migratedChains 后缀句，剪除与去重标签兼容虚拟模型", () => {
    // 用户 10-18 定稿（入池迁移 + 解散除节点）：后缀句已报批，这里钉住批准版本。
    assert.ok(panelJs.includes("function routeChainMigratedNote"), "迁移后缀生成器存在");
    assert.ok(panelJs.includes("已把自动路由中指向成员渠道的节点改为该号池："), "迁移后缀句");
    assert.ok(panelJs.includes("item.endpointId ?? item.virtualModel"), "剪除/迁移/去重三处都按虚拟模型名兜底");
    assert.ok(panelJs.includes("routeChainMigratedNote(r.migratedChains)"), "组池成功提示接迁移回报");
    const buildStart = panelJs.indexOf("function confirmPoolBuild");
    const buildBody = panelJs.slice(buildStart, panelJs.indexOf("\n  }", buildStart));
    assert.ok(buildBody.includes("const r = await api("), "组池结果先落变量再拼后缀");
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
    assert.ok(toastRule[0].includes("translateY(-6px)"), "入场自上方滑下（M13 对齐 dsh 批准规格 -6px/160ms）");
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

describe("看板端点卡首帧卡序接管（普通刷新不再先画基准序）", () => {
  // 症状：刷新看板页，端点卡先以「zcode 在顶」画出一帧，取数落地后再整屏跳一次。
  // 根因：卡序由「生成中 / 待命 / 未启动」三段分层决定，只有主脚本拿到
  // /api/agents 才算得出来；主脚本是 defer 外链，首绘必然早于那次取数，而
  // panel.html 的静态卡序就是基准序。launcher 首开与「重启」回跳有开屏层挡着，
  // 只有普通刷新看得见这一帧。
  // 机制沿用 09-21 已拍板的「首帧视图落位」：由绘制前脚本把那一帧直接画对，
  // 而不是让 JS 更早跑——存档只记「上一次真正重排出来的卡序」，读回来即用户
  // 刷新前看到的画面。
  const here = dirname(fileURLToPath(import.meta.url));
  const panelJs = readFileSync(join(here, "panel-ui", "panel.js"), "utf8");
  const panelHtml = readFileSync(join(here, "panel-ui", "panel.html"), "utf8");
  const panelCss = readFileSync(join(here, "panel-ui", "panel.css"), "utf8");

  const AGENT_IDS = ["zcode", "claude", "dsh", "pi", "kimi", "opencode", "qoder", "codex", "grok"];
  const ORDER_KEY = "agent-card-order";
  const GATE = "data-prepaint-card-order";
  const STYLE_ID = "panelCardOrderPrepaintCss";

  const prepaintSrc = (panelHtml.match(/<script id="panelCardOrderPrepaint">([\s\S]*?)<\/script>/) || [])[1];
  const styleTag = (panelHtml.match(new RegExp(`<style id="${STYLE_ID}">[\\s\\S]*?</style>`)) || [])[0];
  // 与 panel-card-standby-sink.test.mjs 同一提取式：块尾锚定 container.append(...)
  const reorderBlock = (panelJs.match(
    /const AGENT_CARD_ORDER[\s\S]*?container\.append\(\.\.\.cards\);\r?\n  \}/,
  ) || [])[0];

  // 首帧视觉卡序 = 注入规则里的 order 升序
  function paintOrder(cssText) {
    return [...String(cssText).matchAll(/\[data-agent-id="([a-z]+)"\]\{order:(\d+)\}/g)]
      .map((m) => ({ id: m[1], order: Number(m[2]) }))
      .sort((a, b) => a.order - b.order)
      .map((r) => r.id);
  }

  function runPrepaint(stored, opts = {}) {
    const attrs = {};
    const style = { textContent: "" };
    const document = {
      documentElement: {
        setAttribute: (k, v) => { attrs[k] = v; },
        removeAttribute: (k) => { delete attrs[k]; },
      },
      getElementById: (id) => (opts.noStyle || id !== STYLE_ID ? null : style),
    };
    const localStorage = {
      getItem: (k) => {
        if (opts.denied) throw new Error("denied");
        return k === ORDER_KEY ? stored : null;
      },
      setItem: (k, v) => { (opts.writes || []).push([k, v]); },
    };
    // 原样跑那段内联脚本（含 IIFE），与 panelViewPrepaint 的取样方式同构
    new Function("document", "localStorage", prepaintSrc)(document, localStorage);
    return { attrs, cssText: style.textContent, painted: paintOrder(style.textContent) };
  }

  // 真实形态的看板 payload：grok 生成中置顶，dsh/qoder 长待命入中层，其余未启动垫底
  // （层内保持基准序）——即线上实测落地后的卡序，非基准序，足以证伪「首帧不用接管」。
  function liveAgents() {
    const now = Date.now();
    const mk = (id, status, active, lastSeen) => ({
      id, status, processCount: status === "running" ? 1 : 0,
      metrics: { activeRequests: active }, sessions: lastSeen ? [{ lastSeen }] : [],
    });
    return [
      mk("zcode", "stopped", 0, now - 300_000),
      { id: "claude", status: "stopped", processCount: 0, sessions: [] },
      mk("dsh", "running", 0, now - 60_000),
      mk("pi", "stopped", 0, now - 300_000),
      mk("qoder", "running", 0, now - 60_000),
      mk("kimi", "stopped", 0, now - 300_000),
      mk("opencode", "stopped", 0, now - 300_000),
      mk("codex", "stopped", 0, now - 60_000),
      mk("grok", "running", 1, now - 1_000),
    ];
  }
  const LIVE_ORDER = ["grok", "dsh", "qoder", "zcode", "claude", "pi", "kimi", "opencode", "codex"];

  function reorderSandbox() {
    const cards = {};
    for (const id of AGENT_IDS) cards[id] = { id };
    const log = { appends: [], removes: [], writes: [] };
    const container = {
      append(...els) { log.appends.push(els.map((e) => e.id)); },
      querySelector(sel) {
        const m = /data-agent-id="([^"]+)"/.exec(sel);
        return m ? (cards[m[1]] || null) : null;
      },
    };
    const document = {
      querySelector: (sel) => (sel === ".agent-cards-container" ? container : null),
      documentElement: { removeAttribute: (k) => { log.removes.push(k); } },
    };
    const localStorage = { setItem: (k, v) => { log.writes.push([k, v]); } };
    const reorder = new Function(
      "document", "localStorage", "Date",
      `${reorderBlock}\nreturn reorderAgentCards;`,
    )(document, localStorage, Date);
    return { reorder, log };
  }

  it("取样点都在册：绘制前脚本、空样式节点、排序语义块", () => {
    assert.ok(prepaintSrc, "panel.html 有 <script id=\"panelCardOrderPrepaint\">");
    assert.ok(styleTag, `panel.html 有 <style id="${STYLE_ID}">`);
    assert.ok(reorderBlock, "panel.js 的排序语义块可被完整提取（交棒三步须在其中）");
    const styleInner = styleTag
      .replace(/^<style id="panelCardOrderPrepaintCss">/, "").replace(/<\/style>$/, "");
    assert.equal(styleInner.trim(), "", "样式节点静态留空，卡序只能来自存档");
    assert.ok(panelHtml.indexOf("panelViewPrepaint") < panelHtml.indexOf("panelCardOrderPrepaint"),
      "排在同段首帧机制之后，不进 body");
    assert.ok(panelHtml.indexOf("panelCardOrderPrepaint") < panelHtml.indexOf("</head>"),
      "脚本在 </head> 之前，早于任何一次绘制");
  });

  it("① 存档是完整排列：首帧卡序即存档卡序，并挂上首帧属性", () => {
    const out = runPrepaint(LIVE_ORDER.join(","));
    assert.deepEqual(out.painted, LIVE_ORDER, "首帧按上次卡序画，不再画基准序");
    assert.equal(out.attrs[GATE], LIVE_ORDER.join(","), "首帧层生效");
    // 每条规则都带首帧属性前缀：摘掉属性即整层失效，不留半截 order
    const rules = [...out.cssText.matchAll(/[^}]*\}/g)].map((m) => m[0]);
    assert.equal(rules.length, AGENT_IDS.length, "一张卡一条规则");
    for (const r of rules) assert.ok(r.includes(`html[${GATE}]`), `规则带属性前缀：${r}`);
  });

  it("② 存档缺项 / 多项 / 重复 / 非法字符 / 为空 → 首帧完全不介入", () => {
    const dup = [...LIVE_ORDER];
    dup[3] = dup[0]; // grok 出现两次、zcode 整个不见了：长度对得上但不是排列
    const bad = {
      "少一张卡（旧端点清单）": LIVE_ORDER.slice(0, 8).join(","),
      "多一张卡（新增端点还没进脚本清单）": [...LIVE_ORDER, "agy"].join(","),
      "有重复": dup.join(","),
      "含不在册的 id": LIVE_ORDER.map((id) => (id === "grok" ? "reasonix" : id)).join(","),
      "含注入形状的垃圾": 'zcode",claude,dsh,pi,kimi,opencode,qoder,codex,grok}{order:1',
      "空串": "",
      "只有分隔符": ",,,,,,,,",
    };
    for (const [name, stored] of Object.entries(bad)) {
      const out = runPrepaint(stored);
      assert.deepEqual(out.painted, [], `${name}：不写任何 order`);
      assert.ok(!(GATE in out.attrs), `${name}：不挂首帧属性`);
      assert.equal(out.cssText, "", `${name}：样式节点原样留空`);
    }
  });

  it("③ 存储不可用 / 样式节点不在册 → 静默不介入，不抛出", () => {
    assert.doesNotThrow(() => runPrepaint(LIVE_ORDER.join(","), { denied: true }));
    const denied = runPrepaint(LIVE_ORDER.join(","), { denied: true });
    assert.ok(!(GATE in denied.attrs) && denied.cssText === "", "localStorage 抛错即放弃接管");
    const noStyle = runPrepaint(LIVE_ORDER.join(","), { noStyle: true });
    assert.ok(!(GATE in noStyle.attrs), "样式节点被删走时不挂属性，避免画出无样式的首帧层");
    const nothing = runPrepaint(null);
    assert.ok(!(GATE in nothing.attrs), "从未重排过（首次安装）→ 行为与今天一致");
  });

  it("④ 脚本端点清单与运行时基准序同一套（漏一格即首帧闪新卡）", () => {
    const listOf = (src, key) => (src.match(new RegExp(`const ${key} = \\[([^\\]]*)\\]`)) || [, ""])[1]
      .split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    assert.deepEqual(listOf(prepaintSrc, "AGENT_IDS"), listOf(panelJs, "AGENT_CARD_ORDER"),
      "绘制前脚本的端点清单必须与 panel.js 的基准序逐项同");
    assert.deepEqual(listOf(prepaintSrc, "AGENT_IDS"), AGENT_IDS, "取样用的九个端点清单未过期");
    // 清单对了还得对得上真实 DOM：首帧那层是按 data-agent-id 挂 order 的，
    // 卡容器里多一张少一张都会让那一格拿不到 order。
    const markupIds = [...panelHtml.matchAll(/^ {10}<div class="panel-card" data-agent-id="([a-z]+)">$/gm)]
      .map((m) => m[1]);
    assert.deepEqual(markupIds, ["zcode", "claude", "dsh", "pi", "qoder", "kimi", "opencode", "codex", "grok"],
      "panel.html 静态九张卡按缩进一层不落地取到（卡序接管靠这套 id 挂 order）");
    assert.deepEqual(new Set(markupIds), new Set(listOf(prepaintSrc, "AGENT_IDS")),
      "首帧脚本的清单与卡容器里的卡一一对应");
  });

  it("⑤ 往返：运行时写出的存档喂回首帧脚本，首帧卡序与 DOM 卡序逐一相等", () => {
    const { reorder, log } = reorderSandbox();
    reorder(liveAgents());
    assert.deepEqual(log.appends[0], LIVE_ORDER, "运行时首重排的 DOM 卡序");
    assert.deepEqual(log.writes.map((w) => w[0]), [ORDER_KEY], "重排那一刻写存档");
    assert.equal(log.writes[0][1], LIVE_ORDER.join(","), "存档即那份卡序键");
    assert.deepEqual(runPrepaint(log.writes[0][1]).painted, log.appends[0],
      "交棒不跳帧：下一次刷新首帧就是这次重排出来的卡序");
  });

  it("⑥ 交棒三步在同一同步块内、都在「顺序没变」守卫之后", () => {
    const iGuard = reorderBlock.indexOf('if (key === lastCardOrderKey) return;');
    const iRemove = reorderBlock.indexOf(`document.documentElement.removeAttribute("${GATE}")`);
    const iWrite = reorderBlock.indexOf(`localStorage.setItem("${ORDER_KEY}", key)`);
    const iAppend = reorderBlock.indexOf("container.append(...cards);");
    assert.ok(iGuard >= 0 && iRemove >= 0 && iWrite >= 0 && iAppend >= 0,
      "守卫、摘属性、写存档、DOM 重排四步都在排序语义块内");
    assert.ok(iGuard < iRemove && iRemove < iAppend,
      "摘属性晚于守卫、早于 DOM 重排：三步同处一个同步块，中间不产帧，不会先闪基准序");
    assert.ok(iGuard < iWrite && iWrite < iAppend, "写存档同样只在真重排那一刻");
    assert.ok(!/await/.test(reorderBlock.slice(iRemove, iAppend)),
      "摘属性与重排之间不得有 await，否则会让出一帧");
  });

  it("⑦ 顺序没变的那一轮不写存档、不摘属性（每秒轮询不空转）", () => {
    const { reorder, log } = reorderSandbox();
    const agents = liveAgents();
    reorder(agents);
    reorder(agents);
    reorder(agents);
    assert.equal(log.appends.length, 1, "只有首轮真重排");
    assert.equal(log.writes.length, 1, "存档不随每秒轮询重写");
    assert.equal(log.removes.length, 1, "首帧属性也只摘一次");
  });

  it("⑧ 卡容器仍是 flex：order 属性唯一依赖的排版前提", () => {
    const rule = panelCss.match(/^\s*\.agent-cards-container \{([^}]*)\}/m);
    assert.ok(rule, "有 .agent-cards-container 规则");
    assert.ok(/display:\s*flex/.test(rule[1]),
      "容器改出 flex/grid 之外就得同步换掉首帧接管机制");
  });

  // ── 未安装 Agent 卡的运行时显隐（panelHiddenAgentsPrepaint 的接棒方） ──
  // 首版把 hidden 布尔写反（null→全藏、已装→藏、未装→显），全装机器看板卡
  // 全数消失且取数救不回——这里把三路方向钉死，源码级防再犯。
  const visibilityFn = (panelJs.match(
    /function applyAgentCardVisibility\(ids\) \{[\s\S]*?\n  \}/,
  ) || [])[0];
  function visibilitySandbox() {
    const cards = ["zcode", "claude", "kimi", "grok"].map((id) => ({
      id,
      hidden: null,
      getAttribute: (k) => (k === "data-agent-id" ? id : null),
    }));
    const removedAttrs = [];
    const container = {
      querySelectorAll: (sel) => (sel === ".panel-card[data-agent-id]" ? cards : []),
    };
    const document = {
      querySelector: (sel) => (sel === ".agent-cards-container" ? container : null),
      documentElement: { removeAttribute: (k) => { removedAttrs.push(k); } },
    };
    assert.ok(visibilityFn, "panel.js must contain applyAgentCardVisibility");
    const apply = new Function("document", `${visibilityFn}\nreturn applyAgentCardVisibility;`)(document);
    return { apply, cards, removedAttrs };
  }

  it("⑨ 可见性方向：null 全显示（fail-open），未安装才隐藏，已装全显示", () => {
    const { apply, cards, removedAttrs } = visibilitySandbox();
    apply(null);
    assert.deepEqual(cards.map((c) => c.hidden), [false, false, false, false],
      "ids=null（检测未知/失败）必须全显示，此处写反即全卡消失");
    apply(new Set(["zcode", "kimi"]));
    assert.deepEqual(cards.map((c) => c.hidden), [false, true, false, true],
      "只有不在册的 Agent 卡才隐藏；已装被藏 = 布尔又写反了");
    apply(new Set(["zcode", "claude", "kimi", "grok"]));
    assert.deepEqual(cards.map((c) => c.hidden), [false, false, false, false],
      "全在册全显示");
  });

  it("⑩ 运行时接管无条件摘首帧属性：null 路径不摘会留下过期 CSS 压卡", () => {
    const { apply, cards, removedAttrs } = visibilitySandbox();
    apply(null);
    apply(new Set(["zcode"]));
    assert.deepEqual(removedAttrs.filter((k) => k === "data-prepaint-hidden-agents").length, 2,
      "每次接管（含 fail-open 全显示）都要摘属性");
    assert.equal(cards.find((c) => c.id === "zcode").hidden, false);
    assert.equal(cards.find((c) => c.id === "grok").hidden, true);
  });
});

// 虚拟终端归属接线：panel 路由层把 shell pid ↔ 祖先链 join 进会话列表，
// 最近请求走当日 usage journal；前端把归属后的实例行套看板口径渲染。
describe("虚拟终端归属接线（terminal sessions list + recent requests）", () => {
  function terminalRouter({ sessions, detected, codexSessions, agents, journalRows, root, scanAgentConversations } = {}) {
    return createPanelRouter({
      storePaths: { root: root ?? "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => agents ?? null,
      // 数组形态 = 只喂进程面（旧用例默认）；codex 桥接数据走 codexSessions 键，
      // 与真实端点的 { processes, codexSessions } 负载同形；函数形态 = 逐请求
      // 可变的 feed（缓存回退用例要在同一路由上先喂好轮、再喂可疑轮）。
      fetchRelayDetectedProcesses: async () => {
        const feed = typeof detected === "function" ? detected() : detected;
        if (feed === null || feed === undefined) return null;
        if (Array.isArray(feed)) return { processes: feed, codexSessions: codexSessions ?? [] };
        return feed;
      },
      fetchTerminalSessionsList: async () => sessions ?? null,
      // 绑定捕获的对话存档扫描：默认空表，不碰真 home 下的 agent 存档。
      scanAgentConversationsFn: scanAgentConversations ?? (async () => []),
      usageJournal: {
        appendRequest() {}, appendSession() {},
        readRequests: () => journalRows ?? [],
      },
    });
  }

  it("会话列表按 shell pid 归属注 agent 并剥掉输出缓冲", async () => {
    const router = terminalRouter({
      sessions: [{ id: "t1", label: "新终端", cwd: "D:\\dev", shell: "powershell", pid: 8888, status: "running", cols: 120, rows: 34, buffer: ["chunk-a", "chunk-b"] }],
      detected: [
        { agentId: "kimi", pid: 4321, ancestors: [8888, 9000] },
        { agentId: "codex", pid: 6100, ancestors: [7777, 8888] }, // 距壳更远，取最近者
      ],
      agents: [
        { id: "kimi", name: "Kimi Code", instances: [{ id: "kimi-4321" }] },
        { id: "codex", name: "Codex", instances: [{ id: "codex-6100" }] },
      ],
    });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    const body = json();
    assert.equal(body.sessions.length, 1);
    assert.deepEqual(body.sessions[0].agent, { endpointId: "kimi", name: "Kimi Code", pid: 4321, instanceId: "kimi-4321" });
    assert.equal(body.sessions[0].buffer, undefined, "输出缓冲留在 SSE 流，不进轮询列表");
  });

  it("codex 会话桥接：pid 形绑不上时按 cwd 绑 codex-sess 实例行", async () => {
    const router = terminalRouter({
      sessions: [{ id: "t1", label: "Codex 终端", cwd: "D:\\dev\\bridge", shell: "cmd", pid: 8888 }],
      detected: [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
      codexSessions: [
        { id: "codex-sess-older", cwd: "D:\\dev\\bridge", lastActive: 1000, originator: "codex-tui" },
        { id: "codex-sess-latest", cwd: "D:/dev/bridge/", lastActive: 2000, originator: "codex-tui" },
        { id: "codex-sess-elsewhere", cwd: "E:\\other", lastActive: 3000, originator: "codex-tui" },
        { id: "codex-sess-desktop", cwd: "D:\\dev\\bridge", lastActive: 4000, originator: "codex_work_desktop" },
      ],
      agents: [{ id: "codex", name: "Codex", instances: [
        { id: "codex-sess-older" }, { id: "codex-sess-latest" },
        { id: "codex-sess-elsewhere" }, { id: "codex-sess-desktop" },
      ] }],
    });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    const agent = json().sessions[0].agent;
    assert.equal(agent.endpointId, "codex");
    assert.equal(agent.pid, 6100);
    assert.equal(agent.instanceId, "codex-sess-latest",
      "同 cwd 取最近活跃；桌面来源被排除，别的目录不参与");
  });

  it("codex 会话桥接：实例行不在 agents 负载里就不绑（与 pid 路同判）", async () => {
    const router = terminalRouter({
      sessions: [{ id: "t1", cwd: "D:\\dev", shell: "cmd", pid: 8888 }],
      detected: [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
      codexSessions: [{ id: "codex-sess-x", cwd: "D:\\dev", lastActive: 1000, originator: "codex-tui" }],
      agents: [{ id: "codex", name: "Codex", instances: [] }],
    });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await router.handle(req, res);
    assert.equal(json().sessions[0].agent.instanceId, null, "行不存在不编造绑定");
  });

  it("codex 会话桥接：旧 relay 不喂 codexSessions 时照旧不绑", async () => {
    const router = terminalRouter({
      sessions: [{ id: "t1", cwd: "D:\\dev", shell: "cmd", pid: 8888 }],
      detected: [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
      agents: [{ id: "codex", name: "Codex", instances: [{ id: "codex-sess-x" }] }],
    });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await router.handle(req, res);
    assert.equal(json().sessions[0].agent.instanceId, null, "无桥接数据时不猜会话身份");
  });

  it("qoder 归属：qodercli 进程检测 + qoder-<pid> 实例行即绑（socket 兜底路径的下游）", async () => {
    const router = terminalRouter({
      sessions: [{ id: "t1", label: "Qoder", cwd: "D:\\dev", shell: "cmd", pid: 19560 }],
      detected: [
        { agentId: "qoder", pid: 10284, ancestors: [19560] },
        { agentId: "qoder", pid: 7332, ancestors: [10284, 19560] }, // MCP 子进程：更远，让位主 CLI
      ],
      agents: [{ id: "qoder", name: "Qoder", instances: [{ id: "qoder-10284" }] }],
    });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json().sessions[0].agent,
      { endpointId: "qoder", name: "Qoder", pid: 10284, instanceId: "qoder-10284" });
  });

  it("检测喂给中断（relay 挂）时列表照常返回纯外壳会话", async () => {
    const router = terminalRouter({ sessions: [{ id: "t1", pid: 8888 }], detected: null });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().sessions[0].agent, undefined, "无检测面时不得造归属");
  });

  it("terminal-host 不可用时返回 503 terminal_host_unavailable", async () => {
    const router = terminalRouter({ sessions: null });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 503);
    assert.equal(json().error, "terminal_host_unavailable");
  });

  it("最近请求按 agentId+instanceId 严格过滤、最新在前", async () => {
    const rows = [
      { ts: 1, agentId: "kimi", instanceId: "kimi-4321", model: "m1", ok: true },
      { ts: 2, agentId: "kimi", instanceId: "kimi-9999", model: "m2", ok: true },
      { ts: 3, agentId: "kimi", model: "m3", ok: true },
      { ts: 4, agentId: "kimi", instanceId: "kimi-4321", model: "m4", ok: true },
    ];
    const router = terminalRouter({ journalRows: rows });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/requests?agentId=kimi&instanceId=kimi-4321", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json().requests.map((r) => r.ts), [4, 1], "无实例声明的行不匹配绑定实例");
  });

  it("最近请求缺参数返回空列表而不是报错", async () => {
    const router = terminalRouter({ journalRows: [{ ts: 1, agentId: "kimi" }] });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/requests", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json().requests, []);
  });

  it("端点源码钉死：当日 journal 走公开 API readRequests，不得再调不存在的 read", () => {
    assert.ok(panelMjs.includes('usageJournalLazy().readRequests({ fromDay: today, toDay: today })'),
      "最近请求端点必须调 journal 的真实公开方法 readRequests");
    assert.ok(!panelMjs.includes('.read("requests"'),
      "journal 没有 read 方法，旧写法只会抛 TypeError 被空 catch 吞成恒空列表");
  });

  // ── 空谱系可疑轮回退（relay 探针单次超时落 tasklist 兜底轮：谱系表为空但
  // relay 有应答。空谱系被当事实会让全部 agent 终端丢归属一轮，前端侧栏塌缩
  // 回弹即「抽搐」）──
  it("谱系盲可疑轮：窗口内有上一份好 feed 就回退（含 codex 桥接面），且不覆盖缓存", async () => {
    let feed = {
      processes: [{ agentId: "codex", pid: 6100, ancestors: [8888] }],
      codexSessions: [{ id: "codex-sess-x", cwd: "D:\\dev", lastActive: 2000, originator: "codex-tui" }],
    };
    const router = terminalRouter({
      sessions: [{ id: "t1", label: "Codex 终端", cwd: "D:\\dev", shell: "cmd", pid: 8888 }],
      detected: () => feed,
      agents: [{ id: "codex", name: "Codex", instances: [{ id: "codex-sess-x" }] }],
    });
    const first = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await router.handle(first.req, first.res);
    assert.equal(first.json().sessions[0].agent.instanceId, "codex-sess-x",
      "好轮先落缓存：pid 谱系与 codex 桥接面都在");

    // relay 有应答但谱系盲：ancestors 全空（tasklist 兜底轮形状）
    feed = { processes: [{ agentId: "codex", pid: 6100, ancestors: [] }], codexSessions: [] };
    const second = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await router.handle(second.req, second.res);
    assert.equal(second.json().sessions[0].agent.instanceId, "codex-sess-x",
      "可疑轮回退 10 秒内的好缓存：processes 谱系与 codexSessions 随整个 feed 一起回退，归属不丢一轮");

    // 可疑轮不得覆盖缓存：随后 relay 不可达，走 5 秒陈旧路径端出的仍是那份好 feed
    feed = null;
    const third = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await router.handle(third.req, third.res);
    assert.equal(third.json().sessions[0].agent.instanceId, "codex-sess-x",
      "缓存仍是好 feed——可疑轮没把空谱系写进去");
  });

  it("谱系盲可疑轮：无缓存或窗口（10 秒）外照实透传，没有 agent 在跑的机器语义保持", async () => {
    // 无缓存：首轮 relay 就答空谱系（机器上本来就没有 agent 在跑）
    const fresh = terminalRouter({
      sessions: [{ id: "t1", pid: 8888 }],
      detected: { processes: [], codexSessions: [] },
    });
    const first = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await fresh.handle(first.req, first.res);
    assert.equal(first.res.statusCode, 200);
    assert.equal(first.json().sessions[0].agent, undefined, "没有好缓存可回退时空谱系照实透传");

    // 窗口外：好 feed 落缓存后时间推进到 10 秒之外，再来的可疑轮不再回退
    let feed = {
      processes: [{ agentId: "kimi", pid: 4321, ancestors: [8888] }],
      codexSessions: [],
    };
    const router = terminalRouter({
      sessions: [{ id: "t1", pid: 8888 }],
      detected: () => feed,
      agents: [{ id: "kimi", name: "Kimi Code", instances: [{ id: "kimi-4321" }] }],
    });
    const good = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await router.handle(good.req, good.res);
    assert.equal(good.json().sessions[0].agent.instanceId, "kimi-4321", "好轮先落缓存");

    const realNow = Date.now;
    const cachedAt = Date.now();
    Date.now = () => cachedAt + 10001; // 缓存年龄 10 秒 + 1ms：可疑回退窗口外
    try {
      feed = { processes: [{ agentId: "kimi", pid: 4321, ancestors: [] }], codexSessions: [] };
      const late = fakeReqRes("/panel/api/terminal/sessions", "GET");
      await router.handle(late.req, late.res);
      assert.equal(late.json().sessions[0].agent, undefined,
        "窗口外的可疑 feed 照实透传，不拿过期好缓存顶");
    } finally {
      Date.now = realNow;
    }
  });

  it("检测缓存只由好轮更新：可疑轮不落缓存，好轮一落、relay 断了还能顶 5 秒", async () => {
    let feed = { processes: [{ agentId: "kimi", pid: 4321, ancestors: [] }], codexSessions: [] };
    const router = terminalRouter({
      sessions: [{ id: "t1", pid: 8888 }],
      detected: () => feed,
      agents: [{ id: "kimi", name: "Kimi Code", instances: [{ id: "kimi-4321" }] }],
    });
    const suspect = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await router.handle(suspect.req, suspect.res);
    assert.equal(suspect.json().sessions[0].agent, undefined, "无缓存时可疑 feed 透传给请求方");

    feed = { processes: [{ agentId: "kimi", pid: 4321, ancestors: [8888] }], codexSessions: [] };
    const good = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await router.handle(good.req, good.res);
    assert.equal(good.json().sessions[0].agent.instanceId, "kimi-4321", "好轮当轮就生效");

    // 好轮真的写进了缓存：relay 随后不可达，拉取失败路径还能端出这份好 feed
    feed = null;
    const after = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await router.handle(after.req, after.res);
    assert.equal(after.json().sessions[0].agent.instanceId, "kimi-4321",
      "好轮把缓存立起来了（可疑轮那一下没写，否则这里只剩空谱系）");
  });
});

// 前端接线：适配层读注入的 agent 字段、指标/路由/请求按看板口径映射，
// 最后一标签可关、底栏行列随 resize 联动。映射函数在 vm 里真跑。
describe("虚拟终端归属前端（adapter + 映射口径）", () => {
  async function vmFn(name, args, deps = []) {
    const source = [name, ...deps].map((fnName) => {
      const body = panelJs.match(new RegExp(`function ${fnName}\\([\\s\\S]*?\\n  \\}`))?.[0];
      assert.ok(body, `${fnName} found in panel.js`);
      return body;
    }).join("\n");
    const fn = await vm.runInNewContext(`(() => { ${source}; return ${name}; })()`, {});
    const result = fn(...args);
    // vm 域里 new 出来的对象原型链与宿域不同，deepEqual 会误判：出口统一 JSON 往返。
    return result === undefined || result === null ? result : JSON.parse(JSON.stringify(result));
  }

  it("terminalBackendSession 把注入的 agent 原样挂进会话模型", async () => {
    const session = await vmFn("terminalBackendSession", [{
      id: "t1", label: "新终端", cwd: "D:/dev", shell: "powershell", pid: 8888,
      agent: { endpointId: "kimi", name: "Kimi Code", pid: 4321, instanceId: "kimi-4321" },
    }]);
    assert.deepEqual(session.agent, { endpointId: "kimi", name: "Kimi Code", pid: 4321, instanceId: "kimi-4321" });
    assert.equal(session.metrics, null, "指标仍由富化轮询补，不在适配层编造");
  });

  it("terminalWorkTime 已工作时间取最大单位整数（并轨「数字 + 小单位」排印）", async () => {
    assert.deepEqual(await vmFn("terminalWorkTime", [45000]), { workTime: "45", workTimeUnit: "秒" });
    assert.deepEqual(await vmFn("terminalWorkTime", [732000]), { workTime: "12", workTimeUnit: "分钟" });
    assert.deepEqual(await vmFn("terminalWorkTime", [3 * 3600 * 1000 + 59 * 60 * 1000]), { workTime: "3", workTimeUnit: "小时" });
    assert.deepEqual(await vmFn("terminalWorkTime", [2 * 86400 * 1000]), { workTime: "2", workTimeUnit: "天" });
    assert.deepEqual(await vmFn("terminalWorkTime", [null]), { workTime: "0", workTimeUnit: "秒" }, "缺位不编造");
  });

  it("terminalMetricsFromInstance 按看板口径套指标（TTFT 秒 / TPS 一位小数 / tokens 千分位）", async () => {
    const metrics = await vmFn("terminalMetricsFromInstance", [{
      activeRequests: 2, lastTtftMs: 860, ttftColor: "green", tps: 42.64, cacheHitRate: 60.9,
      activeDurationMs: 732000, requests: 14, model: "kimi-k3", providerId: "north-main",
      tokens: { prompt: 128460, completion: 31204, cached: 96080 },
      sparkHistory: { ttft: [0.8], tps: [40], cache: [55] },
    }], ["terminalMetricNum", "terminalWorkTime"]);
    assert.deepEqual(metrics, {
      activeRequests: 2, ttft: "0.86", ttftLamp: "green", tps: "42.6", cache: "61",
      workTime: "12", workTimeUnit: "分钟", requestCount: 14,
      model: "kimi-k3", providerId: "north-main",
      tokens: "Prompt: 128,460 · Completion: 31,204 · Cached: 96,080",
      sparkTtft: [0.8], sparkTps: [40], sparkCache: [55],
    });
  });

  it("terminalMetricsFromInstance 对空实例行不编造数字", async () => {
    const metrics = await vmFn("terminalMetricsFromInstance", [{ activeRequests: 0, requests: 0, ttftColor: "gray" }], ["terminalMetricNum", "terminalWorkTime"]);
    assert.equal(metrics.ttft, "—");
    assert.equal(metrics.tps, "—");
    assert.equal(metrics.cache, "—");
    assert.equal(metrics.requestCount, 0);
    assert.equal(metrics.workTime, "0");
    assert.equal(metrics.workTimeUnit, "秒");
    assert.equal(metrics.model, "", "身份缺位留空串，实况行据此不出模型段");
  });

  it("terminalRouteForEndpoint 只在「配了链且本次运行真走过」时给出节点序列", async () => {
    const chains = [{ endpointId: "kimi", enabled: true, chain: [{ node: "north-main", model: "kimi-k3" }, { node: "sensenova", model: "kimi-k3" }] }];
    const walked = {
      kimi: {
        current: { node: "sensenova", model: "kimi-k3" }, since: 1, lamps: ["red", "green"],
        positions: [{ nodeId: "sensenova", model: "kimi-k3", since: 1 }],
      },
    };
    const hit = await vmFn("terminalRouteForEndpoint", ["kimi", chains, walked], ["terminalAutoRouteLive"]);
    assert.deepEqual(hit.route, [
      { node: "north-main", model: "kimi-k3", state: "failed" },
      { node: "sensenova", model: "kimi-k3" },
    ]);
    assert.equal(hit.routeCurrent, 1, "粘性位置落在第 2 跳");

    // 走过链但落在链首（success 归位、since 仍为 null）：positions 就是证据。
    const walkedHome = {
      kimi: {
        current: { node: "north-main", model: "kimi-k3" }, since: null, lamps: ["green", "green"],
        positions: [{ nodeId: "north-main", model: "kimi-k3", since: null }],
      },
    };
    const home = await vmFn("terminalRouteForEndpoint", ["kimi", chains, walkedHome], ["terminalAutoRouteLive"]);
    assert.equal(home.route.length, 2, "走过链即画");
    assert.equal(home.route[0].state, undefined, "绿跳不带失败态");

    // 只配了链、本次启动还没人走过（runtime 条目是配置兜底：当前跳=链首、
    // positions 空、全灰时链首被强制点亮）→ 不算「在自动路由」，整块隐藏。
    const configuredOnly = {
      kimi: { current: { node: "north-main", model: "kimi-k3" }, since: null, lamps: ["green", "gray"], positions: [] },
    };
    assert.deepEqual(await vmFn("terminalRouteForEndpoint", ["kimi", chains, configuredOnly], ["terminalAutoRouteLive"]),
      { route: [], routeCurrent: 0 }, "配了链但没走过 → 不画配置链");

    // 已降级退避但粘性位置还没落地：红跳本身就是走过链的证据。
    const backoffOnly = {
      kimi: { current: { node: "north-main", model: "kimi-k3" }, since: 5, lamps: ["red", "gray"], positions: [] },
    };
    const backoff = await vmFn("terminalRouteForEndpoint", ["kimi", chains, backoffOnly], ["terminalAutoRouteLive"]);
    assert.equal(backoff.route.length, 2, "红跳即走过链的证据");

    assert.deepEqual(await vmFn("terminalRouteForEndpoint", ["kimi", chains, null], ["terminalAutoRouteLive"]),
      { route: [], routeCurrent: 0 }, "runtime 缺位整块隐藏");
    assert.deepEqual(await vmFn("terminalRouteForEndpoint", ["codex", chains, walked], ["terminalAutoRouteLive"]),
      { route: [], routeCurrent: 0 }, "端点未配链整块隐藏");
  });

  it("terminalRequestsFromRows 把 journal 行套成展示行：输入/输出、缓存、失败类型码、语义色齐备", async () => {
    const out = await vmFn("terminalRequestsFromRows", [[
      { model: "kimi-k3", providerId: "north-main", ttftMs: 1820, prompt: 72560, completion: 486, cached: 1360000, ok: true },
      { model: "m2", providerId: "p2", ok: false },
      { model: "m3", providerId: "p3", prompt: 12, completion: 5, cached: undefined, ok: true },
    ]], ["terminalTtftColor"]);
    assert.deepEqual(out, [
      { model: "kimi-k3", provider: "north-main", metric: "1.82s", metricColor: "green", io: "72,560 / 486", cache: "缓存 1,360,000", fail: "", state: "ok", rel: "", key: "|north-main|kimi-k3", errMsg: "", at: "", duration: "" },
      { model: "m2", provider: "p2", metric: "—", metricColor: "gray", io: "", cache: "", fail: "失败", state: "failed", rel: "", key: "|p2|m2", errMsg: "", at: "", duration: "" },
      { model: "m3", provider: "p3", metric: "—", metricColor: "gray", io: "12 / 5", cache: "", fail: "", state: "ok", rel: "", key: "|p3|m3", errMsg: "", at: "", duration: "" },
    ]);

    const ts = Date.now() - 125000;
    const withTs = await vmFn("terminalRequestsFromRows", [[
      { model: "m5", providerId: "p5", ok: false, status: 429, errMsg: "boom", ts, durationMs: 3400 },
    ]], ["terminalTtftColor"]);
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    assert.equal(withTs[0].fail, "失败 · 429", "失败明细带类型码（对齐大板徽标口径）");
    assert.equal(withTs[0].io, "", "失败行不出输入/输出行");
    assert.equal(withTs[0].cache, "", "失败行不出缓存行");
    assert.equal(withTs[0].rel, `${p(d.getHours())}:${p(d.getMinutes())}`, "副行时间改 24 小时制 HH:MM 绝对时间");
    assert.equal(withTs[0].duration, "3.4s", "总耗时保留给展开块");
    assert.equal(withTs[0].errMsg, "boom", "错误信息保留给展开块");
    assert.equal(withTs[0].at, `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`, "展开块绝对时间落 HH:MM:SS");
    assert.equal(withTs[0].key.split("|")[1], "p5", "行键与大板 logsRowKey 同形");
    assert.ok(!panelJs.includes("terminalRelTime"), "相对时间函数已退役");
  });

  it("terminalTtftColor 与看板 TTFT 灯同源（逐边界对齐 agent-metrics 分档）", async () => {
    for (const ms of [null, undefined, 0, -5, NaN, 1, 4999, 5000, 5001, 9999, 15000, 15001, 60000]) {
      assert.equal(await vmFn("terminalTtftColor", [ms]), getTtftColor(ms),
        `首字响应 ${ms}ms 的语义色必须与看板 TTFT 灯同源（只改一边这里就红）`);
    }
  });

  it("最近请求行模板：身份两行 + 中栏 TTFT 语义色 + 右栏输入/输出与缓存，失败行带类型码且可就地展开", async () => {
    const ok = await vmFn("terminalRequestItemHtml", [{
      model: "kimi-k3", provider: "north-main", metric: "1.82s", metricColor: "green", io: "72,560 / 486", cache: "缓存 1,360,000", fail: "", state: "ok", rel: "15:48", key: "k1", errMsg: "", at: "", duration: "",
    }, { label: "主力号池" }], ["escapeHtml"]);
    assert.ok(ok.includes("<strong>kimi-k3</strong>"), "左栏上行：模型名大字（不再挂来源色类）");
    assert.ok(ok.includes("<span>15:48 · 主力号池</span>"), "左栏下行：绝对时间 · 来源显示名");
    assert.ok(ok.includes('class="terminal-request-metric is-green">1.82s<'), "中栏 TTFT 带看板语义色（绿）");
    assert.ok(ok.includes('class="terminal-request-io">72,560 / 486<'), "右栏上行：输入/输出 tokens，斜杠带空隙排印");
    assert.ok(ok.includes('class="terminal-request-cache">缓存 1,360,000<'), "右栏下行：缓存命中灰字");
    assert.ok(!ok.includes("is-expandable") && !ok.includes("terminal-request-expand"), "成功行不可展开");

    const noLabel = await vmFn("terminalRequestItemHtml", [{
      model: "m3", provider: "ghost-id", metric: "—", metricColor: "gray", io: "5 / 0", cache: "", fail: "", state: "ok", rel: "", key: "k2", errMsg: "", at: "", duration: "",
    }, null], ["escapeHtml"]);
    assert.ok(noLabel.includes("<span>ghost-id</span>"), "显示名未解析时回落原始 id（无时间位不造分隔符）");
    assert.ok(!noLabel.includes("terminal-request-cache"), "cached 为 0 不出缓存行");
    assert.ok(noLabel.includes('class="terminal-request-metric is-gray">—<'), "无 TTFT 样本语义色置灰");

    const failed = await vmFn("terminalRequestItemHtml", [{
      model: "m4", provider: "pool-a", metric: "—", metricColor: "gray", io: "", cache: "", fail: "失败 · 429", state: "failed",
      rel: "12:03", key: "k3", errMsg: "upstream exploded", at: "12:03:04", duration: "3.4s",
    }, { label: "主力号池", expanded: true }], ["escapeHtml"]);
    assert.ok(failed.includes('class="terminal-request-item is-failed is-expandable"'), "失败行带可展开标记");
    assert.ok(failed.includes('data-req-key="k3"'), "行键落 data 属性供点击回查");
    assert.ok(failed.includes('class="terminal-request-detail is-failed">失败 · 429<'), "失败行右栏只留类型码红字");
    assert.ok(!failed.includes("terminal-request-io") && !failed.includes("terminal-request-cache"), "失败行不出输入/输出与缓存行");
    assert.ok(failed.includes("upstream exploded"), "展开块含错误信息");
    assert.ok(failed.includes("时间 12:03:04 · 耗时 3.4s"), "展开块含时间与耗时元信息");
    assert.ok(!failed.includes("缓存"), "失败行不追加缓存后缀");

    const collapsedFail = await vmFn("terminalRequestItemHtml", [{
      model: "m4", provider: "pool-a", metric: "—", metricColor: "gray", io: "", cache: "", fail: "失败", state: "failed",
      rel: "12:03", key: "k4", errMsg: "x", at: "12:03:04", duration: "1.0s",
    }, { label: "主力号池" }], ["escapeHtml"]);
    assert.ok(collapsedFail.includes("is-expandable") && !collapsedFail.includes("terminal-request-expand"), "未展开的失败行只有行体");

    const escaped = await vmFn("terminalRequestItemHtml", [{
      model: "<b>x</b>", provider: "p", metric: "—", metricColor: "gray", io: "1 / 0", cache: "", fail: "", state: "ok", rel: "", key: "k5", errMsg: "", at: "", duration: "",
    }, { label: "<i>y</i>" }], ["escapeHtml"]);
    assert.ok(escaped.includes("&lt;b&gt;x&lt;/b&gt;") && escaped.includes("&lt;i&gt;y&lt;/i&gt;"), "模型名与显示名都转义");
  });

  it("terminalInstanceRow 在 instances 缺位时回退到聚合端点的 sessions 行", async () => {
    const agents = [
      { id: "kimi", instances: [{ id: "kimi-4321" }] },
      { id: "claude", sessions: [{ id: "claude-9001" }] },
    ];
    const bound = await vmFn("terminalInstanceRow", [agents, { endpointId: "kimi", instanceId: "kimi-4321" }]);
    assert.equal(bound.id, "kimi-4321");
    const viaSessions = await vmFn("terminalInstanceRow", [agents, { endpointId: "claude", instanceId: "claude-9001" }]);
    assert.equal(viaSessions.id, "claude-9001");
    const unbound = await vmFn("terminalInstanceRow", [agents, { endpointId: "kimi", instanceId: null }]);
    assert.equal(unbound, null, "未绑定实例不出行（codex 流量前状态）");
  });

  it("接线结构：渲染拆成数据层与结构层、最后一标签可关", () => {
    assert.ok(panelJs.includes("function renderTerminalSessionData()"), "数据层渲染独立成函数");
    const renderBody = panelJs.match(/function renderTerminalPreviewSession\(([\s\S]*?)\n  \}/)?.[0];
    assert.ok(renderBody.includes("renderTerminalSessionData();"), "结构层渲染复用数据层");
    assert.ok(renderBody.includes("connectTerminalStream(session, { revive });"), "SSE 只在结构层重连，且把复活口径透传下去");
    assert.ok(!panelJs.includes("预览至少保留一个终端标签"), "「至少保留一个终端标签」预览遗规已移除");
    assert.ok(!panelJs.includes("ids.length <= 1"), "关闭守卫不再按数量拦截");
    assert.ok(panelJs.includes("remaining.length === 0"), "最后一个标签照常可关");
    const zeroBranch = panelJs.match(/if \(remaining\.length === 0\) \{[\s\S]*?\n        \}/)?.[0];
    assert.ok(zeroBranch, "零会话分支可取样");
    assert.ok(zeroBranch.includes("closeAllTerminalStreams()"), "零会话分支先收流（全部列）");
    assert.ok(zeroBranch.includes("renderTerminalPreviewTabs()"), "零会话分支重渲页签，关掉的标签即时退场");
    assert.ok(zeroBranch.includes("renderTerminalEmptyState()"), "关完最后一个标签留在页内落空态，不退出终端页");
    assert.ok(!zeroBranch.includes("closeTerminalPreview"), "零会话不再退出终端页（退出再回归只会挂一个没有会话的空页）");
    assert.ok(panelJs.includes("pollTerminalSessions()"), "归属数据轮询存在");
  });
});

// 实况行内联归属（面 R 撤换路由链区块后）：侧栏不再有路由链图形，「谁在
// 服务」由实况行副行回答——实例身份（model/providerId）优先、走看板胶囊同
// 一口径，auto 链身份缺位时回落路由当前跳（真实服务方只在路由运行态里）。
// 归属函数在桩环境里真跑（同 terminalFontSizeSandbox 先例）。
describe("虚拟终端实况行归属（实例身份 / 路由后备 / 空壳收列 / 排印收口）", () => {
  function servingSandbox() {
    const bodies = ["terminalServingLabel", "hasDisplayIdentity", "capsuleLabel", "routeNodeName"].map((fnName) => {
      const src = panelJs.match(new RegExp(`function ${fnName}\\([\\s\\S]*?\\n  \\}`))?.[0];
      assert.ok(src, `${fnName} found in panel.js`);
      return src;
    }).join("\n");
    const state = {
      pools: [{ id: "pool-a", displayName: "主力号池" }],
      providers: [{ id: "north-main", displayName: "A6 主渠道" }],
    };
    const fn = new Function("state", `
      function storePools() { return state.pools; }
      function storeProviders() { return state.providers; }
      let routeNodeInfoCache = null;
      ${bodies}
      return terminalServingLabel;
    `)(state);
    return fn;
  }

  it("实例身份优先：model/providerId 直达看板胶囊口径（显示名/模型名）", () => {
    const fn = servingSandbox();
    assert.equal(fn({ metrics: { model: "kimi-k3", providerId: "north-main" }, route: [], routeCurrent: 0 }),
      "A6 主渠道/kimi-k3", "渠道跳显示渠道 displayName，不上原始 id");
    assert.equal(fn({ metrics: { model: "kimi-k3", providerId: "pool-a" }, route: [], routeCurrent: 0 }),
      "主力号池/kimi-k3", "号池显示号池 displayName");
    assert.equal(fn({ metrics: { model: "kimi-k3", providerId: "" }, route: [], routeCurrent: 0 }),
      "kimi-k3", "无渠道维度保持单段模型名");
  });

  it("auto 链身份缺位回落路由当前跳；两头皆空归空串（普通终端不出模型段）", () => {
    const fn = servingSandbox();
    assert.equal(fn({ metrics: { model: "auto", providerId: "" }, route: [{ node: "north-main", model: "kimi-k3" }], routeCurrent: 0 }),
      "A6 主渠道/kimi-k3", "虚拟 auto 不上屏，回落路由当前跳");
    assert.equal(fn({ metrics: null, route: [{ node: "north-main", model: "auto" }], routeCurrent: 0 }),
      "", "路由当前跳自身是 auto 也不上屏");
    assert.equal(fn({ metrics: { model: "", providerId: "" }, route: [], routeCurrent: 0 }), "", "身份未上报且无路由证据归空串");
    assert.equal(fn({ metrics: null, route: [], routeCurrent: 0 }), "", "普通终端（无 metrics）归空串");
  });

  it("实况行结构：工作中报「服务方 · N 个请求进行中」，空闲有归属说「最近由 X 服务」", () => {
    const render = panelJs.match(/function renderTerminalSessionData\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(render.includes("terminalServingLabel(session)"), "实况行归属走统一标签函数");
    assert.ok(render.includes("`最近由 ${serving} 服务`"), "空闲有归属说最近服务方");
    assert.ok(render.includes("个请求进行中"), "工作中报告在途请求数事实");
    assert.ok(render.includes("当前没有进行中的请求"), "无归属空闲只报告无在途请求");
    assert.ok(!panelJs.includes("renderTerminalPreviewRoute") && !panelJs.includes("terminalRouteFocusSignature"), "路由链渲染器与视窗落位已撤除");
    assert.ok(!panelHtml.includes("terminal-route-section") && !panelHtml.includes("terminalRouteLine"), "路由链区块已从 HTML 移除");
    assert.ok(!panelCss.includes(".terminal-route-node") && !panelCss.includes(".terminal-route-viewport"), "路由链样式族已撤除");
  });

  it("空壳侧栏：无归属会话不再整列消失，收拢成细条保留开关可拉回", () => {
    const render = panelJs.match(/function renderTerminalSessionData\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(!render.includes('inspector.style.display = empty ? "none" : ""'),
      "整列 display:none 已退役——开关在列内，藏列即无拉回通路");
    assert.ok(!render.includes('workspace.classList.toggle("is-empty", empty)'),
      "is-empty 单列只属零会话/未连接退场，空壳不走它");
    assert.ok(render.includes('workspace.classList.toggle("is-inspector-collapsed", collapsed)'),
      "无归属走收拢机制：48px 细条、开关按钮保留在列内可拉回");
    assert.ok(render.includes('inspector.style.display = ""'), "从零会话/未连接退场回来恢复可见（poll 直达不经 clear）");
    assert.ok(render.includes('collapsed ? "展开状态面板" : "收起状态面板"'), "自动收拢同步开关文案与 aria（细条悬停不说反话）");
    assert.ok(render.includes("scheduleTerminalFit()"), "收拢与拉回都改变终端区宽度，须触发终端重排尺寸");
  });

  it("空壳收拢防拉锯：归属恢复不自动展开用户已手动收拢的侧栏，手动拉回不被轮询打回", () => {
    const render = panelJs.match(/function renderTerminalSessionData\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(render.includes("terminalInspectorHollowCollapsed") && render.includes("terminalInspectorUserPinned"),
      "系统收拢与用户锁定分两个状态位，轮询不覆盖用户选择");
    const init = panelJs.match(/function initTerminalPreview\(\) \{[\s\S]*?\n  \}/)?.[0];
    const toggleAt = init.indexOf('$("terminalInspectorToggle").onclick');
    assert.ok(toggleAt > 0, "inspector 开关接线在位");
    const toggleBody = init.slice(toggleAt, init.indexOf('$("terminalRedrawBtn").onclick'));
    assert.ok(toggleBody.includes("terminalInspectorUserPinned"), "手动收放写锁定位，空壳自动收拢不再与之打架");
    assert.ok(toggleBody.includes("scheduleTerminalFit()"), "手动收放保留尺寸适配");
  });

  it("vm 真跑空壳收拢状态机：防抖按归属拍计数、细条收放、拉回锁定、归属恢复只展开系统收拢那次", () => {
    const src = panelJs.match(/function renderTerminalSessionData\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(src, "renderTerminalSessionData found in panel.js");
    // 防抖阈值与计数表从源码取样，测试不另抄一份数字：阈值改了这里就红，不靠人记得改。
    const streakSrc = panelJs.match(/const TERMINAL_HOLLOW_COLLAPSE_STREAK = \d+;\n  const terminalHollowStreak = new Map\(\);/)?.[0];
    assert.ok(streakSrc, "空壳塌缩防抖的阈值与计数表可从 panel.js 取到");
    const state = { session: null, fits: 0 };
    const sandbox = new Function("state", `
      const elCache = {};
      const el = (id) => elCache[id] ??= {
        textContent: "", innerHTML: "", title: "", hidden: false, style: {}, className: "",
        classes: new Set(),
        classList: {
          add: (c) => elCache[id].classes.add(c),
          remove: (c) => elCache[id].classes.delete(c),
          contains: (c) => elCache[id].classes.has(c),
          toggle: (c, on) => { if (on === undefined) on = !elCache[id].classes.has(c); if (on) elCache[id].classes.add(c); else elCache[id].classes.delete(c); return on; },
        },
        setAttribute() {},
        getAttribute: () => null,
      };
      const $ = (id) => el(id);
      let activeTerminalPreviewId = "s1";
      const terminalSessionFor = () => state.session;
      const terminalRequestExpanded = new Set();
      let terminalInspectorHollowCollapsed = false;
      const terminalInspectorUserPinned = new Set();
      ${streakSrc}
      let terminalRequestListRenderedHtml = "";
      function scheduleTerminalFit() { state.fits += 1; }
      function updateSparkline() {}
      function routeNodeName(x) { return x; }
      function terminalServingLabel() { return ""; }
      function terminalRequestItemHtml() { return ""; }
      ${src}
      return {
        render: renderTerminalSessionData,
        el: el,
        pin: (id) => terminalInspectorUserPinned.add(id),
        unpin: (id) => terminalInspectorUserPinned.delete(id),
        pinned: (id) => terminalInspectorUserPinned.has(id),
        streak: (id) => terminalHollowStreak.get(id) || 0,
        // 模拟归属数据拍（rebuildTerminalBackendSessions 观测）落下的计数
        beat: (id, n) => terminalHollowStreak.set(id, n),
      };
    `)(state);
    const { render, el, pin, unpin, pinned, streak, beat } = sandbox;

    // ① 空壳拍未到阈值：SSE 活动帧再密也不收拢，计数不被渲染推进（评审修正的回归钉）
    state.session = { id: "s1", label: "外壳", cwd: "C:\\", branch: "", shell: { name: "PowerShell" }, status: "idle", metrics: null, requests: [], agent: null };
    beat("s1", 1);
    render();
    render();
    render();
    const inspector = el("terminalInspector");
    const workspace = el("terminalWorkspace");
    assert.strictEqual(inspector.classes.has("is-collapsed"), false, "一拍空壳 + 任意多次重渲都不收拢");
    assert.strictEqual(workspace.classes.has("is-empty"), false, "空壳不走零会话单列机制");
    assert.equal(streak("s1"), 1, "渲染不递增计数——SSE 活动帧整渲不带新归属数据，计数跟数据拍走");
    beat("s1", 2);
    render();
    assert.strictEqual(inspector.classes.has("is-collapsed"), false, "连续两拍空壳仍不收拢");
    beat("s1", 3);
    render();
    assert.ok(inspector.classes.has("is-collapsed"), "连续第三拍归属观测空壳 → 自动收拢成细条");
    assert.ok(state.fits >= 1, "收拢改变终端列宽 → 触发重排");
    const fitsAfterCollapse = state.fits;
    render();
    assert.strictEqual(state.fits, fitsAfterCollapse, "稳态轮询同形态不重复触发重排");
    assert.equal(streak("s1"), 3, "稳态渲染同样不推进计数");

    // ② 用户拉回（等价开关点击的 DOM 效果 + 锁存写入）→ 后续空壳拍渲染不得打回
    inspector.classes.delete("is-collapsed");
    workspace.classes.delete("is-inspector-collapsed");
    pin("s1");
    render();
    render();
    assert.strictEqual(inspector.classes.has("is-collapsed"), false, "用户拉回后渲染不再收拢（钉住优先，计数在阈值也不塌）");

    // ③ 归属恢复：维持展开、清锁定、清计数；用户随后手动收拢 → 渲染不得替用户展开
    state.session.agent = { endpointId: "dsh", name: "DeepSeek Harness", pid: 1, instanceId: "dsh-1" };
    render();
    assert.strictEqual(inspector.classes.has("is-collapsed"), false, "归属恢复维持展开");
    assert.strictEqual(pinned("s1"), false, "归属恢复清用户锁定");
    assert.equal(streak("s1"), 0, "归属恢复渲染兜底清零防抖计数");
    inspector.classes.add("is-collapsed");
    workspace.classes.add("is-inspector-collapsed");
    render();
    assert.strictEqual(inspector.classes.has("is-collapsed"), true, "用户手动收拢被尊重（归属态不自动展开）");

    // 归属态下再拉回（不进锁定集合）：给 ④ 一个展开起点
    inspector.classes.delete("is-collapsed");
    workspace.classes.delete("is-inspector-collapsed");
    render();

    // ④ 归属再掉：防抖从头数起，连续第 3 拍才收拢回细条；恢复后只展开系统收拢的那次
    state.session.agent = null;
    beat("s1", 1);
    render();
    beat("s1", 2);
    render();
    assert.strictEqual(inspector.classes.has("is-collapsed"), false, "再掉归属的第 1、2 拍保持展开（防抖重新数起）");
    beat("s1", 3);
    render();
    assert.ok(inspector.classes.has("is-collapsed"), "连续第 3 拍自动收拢回细条");
    state.session.agent = { endpointId: "dsh", name: "DeepSeek Harness", pid: 1, instanceId: "dsh-1" };
    render();
    assert.strictEqual(inspector.classes.has("is-collapsed"), false, "系统收拢的那次随归属恢复自动展开");
    unpin("s1");
  });

  it("排印收口：末端分隔线收边、字阶并档 11/12、数值行同轴、TTFT 灯色图例悬停浮出", () => {
    assert.ok(panelCss.includes(".terminal-inspector-section:last-child { border-bottom: none; }"), "末端区块不再悬空分隔线");
    assert.ok(panelCss.includes(".terminal-metric-label { grid-column: 1; color: var(--text-3); font-size: 12px; }"), "标签字阶并入 12px");
    assert.ok(panelCss.includes(".terminal-metric-unit { color: var(--text-3); font-size: 11px; }"), "单位字阶并入 11px");
    assert.ok(/\.terminal-live-status span:not\(\.terminal-live-icon\) \{[^}]*font-size: 12px/.test(panelCss), "实况行副行并入 12px");
    assert.ok(/\.terminal-metric strong \{[^}]*align-items: center/.test(panelCss), "数值行统一居中轴（灯与单位同轴）");
    assert.ok(!panelCss.includes(".terminal-metric strong .lamp"), "lamp 不再单列 align-self 例外");
    assert.ok(panelHtml.includes("terminal-metric-tip"), "TTFT 灯色图例浮层就位");
    assert.ok(panelCss.includes(".terminal-metric-ttft:hover .terminal-metric-tip"), "图例悬停浮出");
    assert.ok(panelHtml.includes('id="terminalWorkTimeUnit"'), "已工作时间并轨「数字 + 小单位」");
  });
});

// 底栏（E）：tokens 截断串悬停显全从原生 title 升级 styled tooltip（统计页
// 同款）；最近一条请求失败时「N 次请求」字串转 danger 字色，与列表红点同源。
// 字式化修订：请求数去徽标壳改纯文字（与 tokens 字串同构），不再绑跳转；
// 缓存命中率字串从底栏左段退役，改挂「最近请求」标题行右侧（无徽标壳）。
describe("虚拟终端底栏（悬停显全 / 失败字色 / 缓存与请求数字串）", () => {
  it("tokens 悬停显全：原生 title 退役，styled tooltip 向上浮出且不被截断串裁剪", () => {
    const render = panelJs.match(/function renderTerminalSessionData\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(!render.includes("terminalFootTokens\").title"), "原生 title 赋值已退役");
    assert.ok(render.includes('$("terminalFootTokensTip").textContent = metrics.tokens'), "浮层文本随轮询同拍更新");
    assert.ok(panelHtml.includes('class="stats-tooltip terminal-foot-tip" id="terminalFootTokensTip"'), "浮层复用 stats-tooltip 组件");
    assert.ok(panelHtml.includes("terminal-foot-tokens-wrap"), "截断串外加定位壳（浮层不进 overflow:hidden 内）");
    assert.ok(/\.terminal-foot-tip \{[^}]*bottom: calc\(100% \+ 8px\)[^}]*right: 0/.test(panelCss), "底栏贴屏幕底，浮层向上且右对齐不出窗");
    assert.ok(panelCss.includes(".terminal-foot-tokens-wrap:hover .terminal-foot-tip"), "悬停浮出");
  });

  it("失败语义色：仅最近一条请求失败时「N 次请求」字串转 danger 字色，最近一条正常即恢复常色", () => {
    const render = panelJs.match(/function renderTerminalSessionData\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(render.includes('classList.toggle("is-failed", session.requests[0]?.state === "failed")'),
      "字串只跟随最近一条请求的结果（requests[0] 即最新），历史失败行不粘红");
    assert.ok(!render.includes('session.requests.some((r) => r.state === "failed")'),
      "窗口内任意失败即红的旧口径已退役（红过一次就一直红的病根）");
    assert.ok(panelCss.includes(".terminal-foot-requests.is-failed { color: var(--danger); }"), "失败语义降格为纯字色，不带边框与底色");
  });

  it("vm 真跑失败字色状态机：红→正常序列后字串恢复常色，历史失败行不粘红", () => {
    const src = panelJs.match(/function renderTerminalSessionData\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(src, "renderTerminalSessionData found in panel.js");
    const streakSrc = panelJs.match(/const TERMINAL_HOLLOW_COLLAPSE_STREAK = \d+;\n  const terminalHollowStreak = new Map\(\);/)?.[0];
    assert.ok(streakSrc, "空壳塌缩防抖的阈值与计数表可从 panel.js 取到");
    const state = { session: null };
    const sandbox = new Function("state", `
      const elCache = {};
      const el = (id) => elCache[id] ??= {
        textContent: "", innerHTML: "", title: "", hidden: false, style: {}, className: "",
        classes: new Set(),
        classList: {
          add: (c) => elCache[id].classes.add(c),
          remove: (c) => elCache[id].classes.delete(c),
          contains: (c) => elCache[id].classes.has(c),
          toggle: (c, on) => { if (on === undefined) on = !elCache[id].classes.has(c); if (on) elCache[id].classes.add(c); else elCache[id].classes.delete(c); return on; },
        },
        setAttribute() {},
        getAttribute: () => null,
      };
      const $ = (id) => el(id);
      let activeTerminalPreviewId = "s1";
      const terminalSessionFor = () => state.session;
      const terminalRequestExpanded = new Set();
      let terminalInspectorHollowCollapsed = false;
      const terminalInspectorUserPinned = new Set();
      ${streakSrc}
      let terminalRequestListRenderedHtml = "";
      function scheduleTerminalFit() {}
      function updateSparkline() {}
      function routeNodeName(x) { return x; }
      function terminalServingLabel() { return ""; }
      function terminalRequestItemHtml() { return ""; }
      ${src}
      return { render: renderTerminalSessionData, el };
    `)(state);
    const { render, el } = sandbox;
    const failed = { state: "failed", key: "k-fail" };
    const ok = { state: "ok", key: "k-ok" };
    // requests[0] 即最新一条（服务端从 journal 尾部倒序取回，见
    // terminal-attribution.mjs filterTerminalRequestRows）
    state.session = { id: "s1", label: "外壳", cwd: "C:\\", branch: "", shell: { name: "PowerShell" }, status: "idle", metrics: null, requests: [ok, failed], agent: { endpointId: "kimi", name: "Kimi", pid: 1, instanceId: "kimi-1" } };
    render();
    assert.strictEqual(el("terminalFootRequests").classes.has("is-failed"), false, "最新一条正常、历史有失败行：不红（旧 any-failed 口径在此即粘红）");
    state.session.requests = [failed, ok];
    render();
    assert.ok(el("terminalFootRequests").classes.has("is-failed"), "最新一条失败：转 danger");
    state.session.requests = [ok, failed];
    render();
    assert.strictEqual(el("terminalFootRequests").classes.has("is-failed"), false, "红→正常序列后恢复常色");
    state.session.requests = [];
    render();
    assert.strictEqual(el("terminalFootRequests").classes.has("is-failed"), false, "零请求不红");
  });

  it("缓存命中率字串：挂「最近请求」标题行右侧，无指标或零请求时隐藏", () => {
    assert.ok(panelHtml.includes('<span class="terminal-section-note" id="terminalRequestCount" hidden>'),
      "标题行右侧是纯文字元素（无徽标壳），初始隐藏");
    assert.ok(!panelHtml.includes('id="terminalFootCache"'), "底栏左段的缓存字串元素已退役");
    assert.ok(!panelCss.includes(".terminal-foot-cache"), "底栏缓存字串样式随元素清退");
    assert.ok(!panelCss.includes(".terminal-section-count"), "请求数徽标壳样式已退役");
    assert.ok(!panelHtml.includes("terminalFootPid") && !panelHtml.includes("terminalFootSize"), "PID/UTF-8/尺寸徽标不得回流");
    assert.ok(!panelJs.includes("updateTerminalFootSize"), "底栏尺寸写入不得回流");
    const render = panelJs.match(/function renderTerminalSessionData\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(render.includes('$("terminalRequestCount").hidden = !metrics || metrics.requestCount === 0'),
      "无指标或零请求时隐藏（与原缓存字串同口径）");
    assert.ok(render.includes('$("terminalRequestCount").textContent = metrics ? `缓存命中 ${metrics.cache}%` : ""'),
      "文案随轮询同拍更新，值与监测区四宫格同源");
    assert.ok(!render.includes("String(session.requests.length)"), "标题行不再显示请求数");
    const noteRule = panelCss.match(/\.terminal-section-note \{([^}]*)\}/)?.[1];
    assert.ok(noteRule && !/border|background|padding/.test(noteRule), "无徽标壳，纯文字与标题行同构");
    assert.ok(panelCss.includes(".terminal-section-note[hidden]"), "隐藏显式兜底");
  });

  it("请求数字串：无壳无跳转，与 tokens 字串同构", () => {
    const init = panelJs.match(/function initTerminalPreview\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(init, "initTerminalPreview found in panel.js");
    assert.ok(!init.includes('$("terminalFootRequests").onclick'), "请求数不再绑跳转（E4 退役）");
    const reqRule = panelCss.match(/\.terminal-foot-requests \{([^}]*)\}/)?.[1];
    assert.ok(reqRule && !/border|background|padding|cursor/.test(reqRule), "徽标壳与可点外壳全撤");
    assert.ok(!panelCss.includes(".terminal-foot-requests:hover"), "悬停态随可点性退役");
    const tokensRule = panelCss.match(/\.terminal-foot-tokens \{([^}]*)\}/)?.[1];
    for (const decl of ["color: var(--text-2)", "font-weight: 650"]) {
      assert.ok(reqRule.includes(decl) && tokensRule.includes(decl), `与 tokens 字串同构（${decl}）`);
    }
  });
});

// SSE 断线重连不重影（B2）：后端每次建连都重发 snapshot + 全量缓冲，前端
// 对齐语义 = 每收到 snapshot 先 reset 再回放。纯函数在桩环境里真跑。
describe("虚拟终端 SSE 重连重置（snapshot 帧先清屏）", () => {
  it("每个 snapshot 帧都先 reset 再对齐状态——重连后旧内容不叠加", () => {
    const src = panelJs.match(/function absorbTerminalSnapshot\([\s\S]*?\n  \}/)?.[0];
    assert.ok(src, "absorbTerminalSnapshot found in panel.js");
    const seen = { resets: 0 };
    const term = { reset: () => { seen.resets += 1; } };
    const session = { backendState: null, shell: { pid: null } };
    const fn = new Function(`
      let terminalReplayRestoring = false;
      let terminalReplayRestoreArm = null;
      let terminalReplayFramePending = false;
      function discardTerminalBurst() {}
      ${src}
      return absorbTerminalSnapshot;
    `)();
    fn(term, session, { pid: 8888, cols: 120, rows: 34 });
    assert.equal(seen.resets, 1, "建连首个 snapshot 先清屏");
    assert.equal(session.backendState.pid, 8888);
    assert.equal(session.shell.pid, 8888, "会话进程号随 snapshot 对齐");
    fn(term, session, { pid: 8888, cols: 100, rows: 30 });
    assert.equal(seen.resets, 2, "自动重连后的 snapshot 同样先清屏");
  });

  it("接线：snapshot 帧走 reset 入口，data 帧与 onerror 不 reset", () => {
    const body = panelJs.match(/async function connectTerminalStream\(session,[^)]*\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(body, "connectTerminalStream found in panel.js");
    assert.ok(body.includes("absorbTerminalSnapshot(term, session, JSON.parse(event.data))"), "snapshot 帧路由到 reset 入口");
    const dataHandler = body.match(/addEventListener\("data"[\s\S]*?\n    \}\);/)?.[0];
    assert.ok(dataHandler && !dataHandler.includes("reset"), "稳态 data 帧不 reset，不误清屏");
    const errorHandler = body.match(/onerror[\s\S]*?\n    \};/)?.[0];
    assert.ok(errorHandler && !errorHandler.includes("reset"), "onerror 不 reset：断线瞬间不清屏，等重连后 snapshot 统一对齐");
  });

  it("回放闩接线：snapshot reset 与建流 reset 之后都置闩并排静默清闩", () => {
    const absorb = panelJs.match(/function absorbTerminalSnapshot\([\s\S]*?\n  \}/)?.[0];
    assert.ok(absorb, "absorbTerminalSnapshot found in panel.js");
    assert.ok(/term\.reset\(\);[\s\S]*?terminalReplayRestoring = true;[\s\S]*?terminalReplayRestoreArm\(\)/.test(absorb),
      "snapshot reset 之后置回放闩（reset 的滚动不误判成用户离底）");
    const body = panelJs.match(/async function connectTerminalStream\(session,[^)]*\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(body, "connectTerminalStream found in panel.js");
    assert.ok(/term\.reset\(\);[\s\S]*?terminalReplayRestoring = true;[\s\S]*?terminalReplayRestoreArm\(\)/.test(body),
      "建流 reset 之后同样置闩");
    assert.ok(panelJs.includes("let terminalReplayRestoring = false;"), "回放闩带回初值 false");
  });
});

// 同步输出合帧（`\e[?2026h` … `\e[?2026l`）：Kimi 等 TUI 用这对标记声明「整屏原子
// 提交」，而宿主 SSE 的 32KB 冲刷会把一次整屏重绘拆成两帧送达。先到的半帧只有清屏
// 与半屏内容（帧首 2J/3J 已把视口打到顶部），后到的半帧才补齐内容底——视口于是按
// 重绘节奏在头尾之间来回跳（真机实测 8 次/秒）。客户端在标记之间攒字节、闭合时一次
// 写入，中间态永不落屏。函数体抽进桩环境真跑，定时器可驱动。
describe("虚拟终端同步输出合帧（整屏重绘不再撕裂）", () => {
  function syncSandbox() {
    const bodies = ["closeTerminalStream", "ensureTerminalXterm", "armTerminalDprWatch", "disarmTerminalDprWatch", "terminalXtermTheme",
      "connectTerminalStream", "terminalClipboardKeyIntent", "terminalNewlineEnterKey",
      "terminalNewlineDeliveryBlocked", "terminalNewlineData", "terminalSessionMap", "terminalSessionFor",
      "installTerminalFollowBottomGuard", "absorbTerminalSnapshot", "reviveTerminalSession", "sendTerminalInput",
      "queueTerminalChunk", "flushTerminalBurst", "discardTerminalBurst"]
      .map((name) => {
        const src = panelJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
        assert.ok(src, `${name} found in panel.js`);
        return src;
      }).join("\n");
    const state = { posts: [], eventSources: [], terms: [], sessions: {}, timers: new Map(), timerSeq: 0 };
    const sandbox = new Function("state", `
      const API_BASE = "http://panel.test";
      ${terminalBurstConsts}
      const terminalFontSize = 13;
      const terminalBackendReady = true;
      const terminalBackendSessions = state.sessions;
      const terminalPreviewSessions = {};
      let activeTerminalPreviewId = null;
      let terminalXterm = null;
      let terminalFitAddon = null;
      let terminalWebglAddon = null;
      let terminalEventSource = null;
      let terminalHostResizeObserver = null;
      let terminalDprMediaQuery = null;
      let terminalDprMediaHandler = null;
      let terminalInputDisposable = null;
      let terminalBoundSessionId = null;
      let terminalImeHold = null;
      let terminalImeHoldFrame = null;
      let terminalImeFitPending = false;
      let terminalImeAnchorTextarea = null;
      let terminalImeArmHandler = null;
      let terminalImeReleaseHandler = null;
      let terminalBottomAlignIntentAt = 0;
      let terminalBottomAlignTrimFrame = null;
      let terminalReplayRestoring = false;
      let terminalReplayRestoreArm = null;
      let terminalReplayRestoreCancel = null;
      let terminalStreamSyncCancel = null;
      let terminalStreamWrite = null;
      let terminalWriteBurst = null;
      let terminalReplayFramePending = false;
      const host = {};
      const $ = (id) => (id === "terminalXtermHost" ? host : null);
      const document = { documentElement: {} };
      const getComputedStyle = () => ({ getPropertyValue: () => "", colorScheme: "dark" });
      const terminalReviveInflight = new Map();
      const api = () => Promise.resolve({});
      function fitTerminalXterm() {}
      function requestAnimationFrame(cb) { cb(); }
      function cancelAnimationFrame() {}
      function terminalImeAnchorReady() { return false; }
      function armTerminalImeAnchor() {}
      function releaseTerminalImeAnchor() {}
      function installTerminalImeAnchor() {}
      function installTerminalBottomAlign() {}
      // 合帧的兜底定时器：可驱动，不依赖真实时钟
      function setTimeout(fn, ms) { state.timerSeq += 1; state.timers.set(state.timerSeq, { at: ms, fn }); return state.timerSeq; }
      function clearTimeout(id) { if (id !== null && id !== undefined) state.timers.delete(id); }
      class FakeFitAddon {}
      const window = { Terminal: null, FitAddon: { FitAddon: FakeFitAddon } };
      window.Terminal = class {
        constructor(options) { this.options = options; this.disposed = false; this.writes = []; this.resetCount = 0; this._disposables = new Set(); state.terms.push(this); }
        loadAddon() {}
        open(hostEl) { this.hostEl = hostEl; }
        onData(fn) { const d = { dispose: () => { this._disposables.delete(d); } }; this._disposables.add(d); this._fire = (data) => { if (this._disposables.has(d)) fn(data); }; return d; }
        fire(data) { this._fire?.(data); }
        write(text) { this.writes.push(text); }
        reset() { this.resetCount += 1; }
        dispose() { this.disposed = true; this._disposables.clear(); this._fire = null; }
        attachCustomKeyEventHandler(fn) { this.keyEventHandler = fn; }
        focus() { this.focusCount = (this.focusCount || 0) + 1; }
        hasSelection() { return false; }
      };
      class FakeEventSource {
        constructor(url) { this.url = url; this.closed = false; this.handlers = {}; state.eventSources.push(this); }
        addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
        set onerror(fn) {}
        close() { this.closed = true; }
        emit(type, payload) { for (const fn of this.handlers[type] || []) fn({ data: JSON.stringify(payload) }); }
      }
      const EventSource = FakeEventSource;
      ${bodies}
      return {
        connect: (session, opts) => connectTerminalStream(session, opts),
        close: () => closeTerminalStream(),
        xterm: () => terminalXterm,
        source: () => terminalEventSource,
        runTimers: () => { for (const [id, t] of [...state.timers]) { state.timers.delete(id); t.fn(); } },
        pendingTimers: () => state.timers.size,
      };
    `)(state);
    return { sandbox, state };
  }
  const session = (id) => ({ id, label: id, backend: true, shell: {}, output: [] });
  const OPEN = "\u001b[?2026h";
  const CLOSE = "\u001b[?2026l";

  it("被拆成两帧的整屏重绘合成一次写入——清屏后的中间态从不落屏", () => {
    const { sandbox } = syncSandbox();
    sandbox.connect(session("sess-a"));
    const term = sandbox.xterm();
    const src = sandbox.source();
    const head = `${OPEN}\u001b[2J\u001b[H\u001b[3J╭─ 头部 ─╮\r\n│ 半屏内容 │`;
    const tail = `\r\n╰─ 尾部 ─╯${CLOSE}`;
    src.emit("data", head);
    assert.deepEqual(term.writes, [], "块未闭合：一个字节都不落屏（清屏+半屏的中间态不可见）");
    src.emit("data", tail);
    assert.deepEqual(term.writes, [head + tail], "闭合时整块一次写入，视口只解析/渲染一遍");
    assert.equal(sandbox.pendingTimers(), 0, "闭合后兜底定时器已撤销");
  });

  it("无标记的增量输出逐帧直通，零延迟不攒", () => {
    const { sandbox } = syncSandbox();
    sandbox.connect(session("sess-a"));
    const term = sandbox.xterm();
    const src = sandbox.source();
    src.emit("data", "正在思考");
    src.emit("data", "…\r\n");
    assert.deepEqual(term.writes, ["正在思考", "…\r\n"], "逐帧落屏，与旧行为一致");
    assert.equal(sandbox.pendingTimers(), 0, "直通不排任何定时器");
  });

  it("同一帧内自带开闭：整段一次写入，不挂起", () => {
    const { sandbox } = syncSandbox();
    sandbox.connect(session("sess-a"));
    const term = sandbox.xterm();
    const src = sandbox.source();
    const block = `${OPEN}\u001b[2J\u001b[H全屏${CLOSE}`;
    src.emit("data", `前缀${block}后缀`);
    assert.deepEqual(term.writes, ["前缀", block, "后缀"], "块前的字节当拍直通，块整段一次写，块后的字节继续直通");
  });

  it("标记被劈在两帧之间：尾部前缀扣住，下一帧拼回后仍识别为块", () => {
    const { sandbox } = syncSandbox();
    sandbox.connect(session("sess-a"));
    const term = sandbox.xterm();
    const src = sandbox.source();
    src.emit("data", `正文\u001b[?20`);
    assert.deepEqual(term.writes, ["正文"], "非标记正文照常落屏，半截标记扣住不写");
    src.emit("data", `26h全屏${CLOSE}`);
    assert.deepEqual(term.writes, ["正文", `${OPEN}全屏${CLOSE}`], "拼回后识别为块并整块写入");
  });

  it("闭合标记迟到时按上限兜底冲刷，画面不被永久锁死", () => {
    const { sandbox } = syncSandbox();
    sandbox.connect(session("sess-a"));
    const term = sandbox.xterm();
    const src = sandbox.source();
    src.emit("data", `${OPEN}\u001b[2J半屏`);
    assert.deepEqual(term.writes, [], "块内挂起");
    sandbox.runTimers();
    assert.deepEqual(term.writes, [`${OPEN}\u001b[2J半屏`], "超时兜底冲刷，已到的字节不丢");
  });

  it("snapshot 作废挂起块：上一段画面的半帧不得写进重连后的新屏", () => {
    const { sandbox } = syncSandbox();
    sandbox.connect(session("sess-a"));
    const term = sandbox.xterm();
    const src = sandbox.source();
    src.emit("data", `${OPEN}\u001b[2J旧半帧`);
    const resetsBefore = term.resetCount;
    src.emit("snapshot", { pid: 1 });
    assert.equal(term.resetCount, resetsBefore + 1, "snapshot 先 reset");
    sandbox.runTimers();
    assert.deepEqual(term.writes, [], "挂起块随 snapshot 丢弃，不会补写到新屏");
    src.emit("data", `${OPEN}新整屏${CLOSE}`);
    assert.deepEqual(term.writes, [`${OPEN}新整屏${CLOSE}`], "重连后的块照常合帧");
  });

  it("关流撤销兜底定时器并丢弃未闭合字节：dispose 之后不再碰实例", () => {
    const { sandbox } = syncSandbox();
    sandbox.connect(session("sess-a"));
    const term = sandbox.xterm();
    sandbox.source().emit("data", `${OPEN}\u001b[2J半帧`);
    sandbox.close();
    assert.equal(term.disposed, true, "实例已销毁");
    assert.equal(sandbox.pendingTimers(), 0, "兜底定时器随关流撤销");
    sandbox.runTimers();
    assert.deepEqual(term.writes, [], "销毁后没有任何迟到写入");
  });
});

// 回放突发合并（2026-10-19）：[CC] resume 把整段历史一次性重放出来，宿主按 32KB
// 阈值把它拆成多帧，客户端收一帧写一帧 → xterm 每帧画一次、视口跟一次，用户看到
// 「从对话头部出现、随后飞速滚到底」。合并器把一段突发攒成一次写入，落屏只发生
// 一次。这组用例用可控时钟真跑函数体，把判据、窗口、上限与各强制落屏点钉死。
// 与同步合帧的层次（burst 在外、合帧在内）由本组单测 + 合帧组共同钉住：单测环境
// terminalStreamWrite 为空走直写回退，接线断言另钉真实管线的排队路径。
describe("终端回放突发合并（大段历史一次落屏）", () => {
  // 可控时钟：setTimeout 只登记，advance 按到期顺序执行。合并器的三个窗口
  // （静默 / 硬上限 / 2MB）都靠它推进，测试不 sleep。
  function makeClock() {
    let now = 0;
    let seq = 0;
    const timers = new Map();
    return {
      setTimeout(fn, delay) {
        const id = ++seq;
        timers.set(id, { fn, at: now + Math.max(0, Number(delay) || 0), id });
        return id;
      },
      clearTimeout(id) { timers.delete(id); },
      advance(ms) {
        const target = now + ms;
        for (;;) {
          const due = [...timers.values()].filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id);
          if (due.length === 0) break;
          const next = due[0];
          timers.delete(next.id);
          now = next.at;
          next.fn();
        }
        now = target;
      },
      pending() { return timers.size; },
    };
  }

  // 只取合并器本体：这组用例验的是「攒/落」的判据，不牵扯流与渲染。
  function burstSandbox() {
    const bodies = ["queueTerminalChunk", "flushTerminalBurst", "discardTerminalBurst"]
      .map((name) => {
        const src = panelJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
        assert.ok(src, `${name} found in panel.js`);
        return src;
      }).join("\n");
    const clock = makeClock();
    const writes = [];
    const sandbox = new Function("clock", "writes", `
      ${terminalBurstConsts}
      const setTimeout = clock.setTimeout;
      const clearTimeout = clock.clearTimeout;
      ${bodies}
      let terminalWriteBurst = null;
      let terminalStreamWrite = null;
      const term = { write: (text) => writes.push(text) };
      return {
        term,
        push: (text) => queueTerminalChunk(term, text),
        flush: () => flushTerminalBurst(),
        discard: () => discardTerminalBurst(),
        writeBurst: () => terminalWriteBurst,
        thresholds: {
          enter: TERMINAL_BURST_ENTER_BYTES,
          quiet: TERMINAL_BURST_QUIET_MS,
          cap: TERMINAL_BURST_MAX_HOLD_MS,
          maxBytes: TERMINAL_BURST_MAX_BYTES,
        },
      };
    `)(clock, writes);
    return { sandbox, clock, writes };
  }

  const big = (bytes, fill = "x") => fill.repeat(bytes);

  it("小帧直通：实时输出的碎块不进突发，逐块立即落屏（手感不变）", () => {
    const { sandbox, writes, clock } = burstSandbox();
    for (const piece of ["\u001b[2K", "思考中", "…", "\r\n"]) sandbox.push(piece);
    assert.deepEqual(writes, ["\u001b[2K", "思考中", "…", "\r\n"], "小帧逐块直写，不等窗口");
    assert.equal(sandbox.writeBurst(), null, "小帧不起突发");
    assert.equal(clock.pending(), 0, "小帧不留定时器");
  });

  it("大帧起突发、后续帧并入：整段历史只写一次，且写入内容是原样拼接", () => {
    const { sandbox, writes, clock } = burstSandbox();
    const first = big(64 * 1024, "a");
    const second = big(64 * 1024, "b");
    const third = big(32 * 1024, "c");
    sandbox.push(first);
    assert.deepEqual(writes, [], "突发内不立即落屏（这就是「逐帧飞滚」的病灶）");
    sandbox.push(second);
    sandbox.push(third);
    assert.deepEqual(writes, [], "突发持续期间仍不落屏");
    clock.advance(sandbox.thresholds.quiet);
    assert.deepEqual(writes, [first + second + third], "静默窗口到点一次写入，内容原样拼接");
    assert.equal(sandbox.writeBurst(), null, "落屏后突发清空");
    assert.equal(clock.pending(), 0, "两个定时器都撤掉");
  });

  it("静默窗口被后续帧续命：突发内的帧间隔小于窗口时不会提前落屏", () => {
    const { sandbox, writes, clock } = burstSandbox();
    sandbox.push(big(20 * 1024, "a"));
    clock.advance(sandbox.thresholds.quiet - 1);
    sandbox.push(big(20 * 1024, "b"));
    assert.deepEqual(writes, [], "续命后仍攒着");
    clock.advance(sandbox.thresholds.quiet - 1);
    assert.deepEqual(writes, [], "每次新帧都重置静默计时");
    clock.advance(1);
    assert.equal(writes.length, 1, "最后一帧之后静默满窗口才落屏");
  });

  it("硬上限：持续洪峰不会无限期不画，到点强制落屏", () => {
    const { sandbox, writes, clock } = burstSandbox();
    sandbox.push(big(20 * 1024, "a"));
    // 每半个静默窗口来一帧，模拟持续输出：静默窗口永远到不了，只有硬上限能救。
    // 落屏后立刻停手——后续小帧会直通，那是另一条已单独钉过的通路。
    const step = Math.max(1, Math.floor(sandbox.thresholds.quiet / 2));
    let elapsed = 0;
    while (elapsed < sandbox.thresholds.cap + step && writes.length === 0) {
      clock.advance(step);
      elapsed += step;
      if (writes.length > 0) break;
      sandbox.push(big(1024, "b"));
    }
    assert.equal(writes.length, 1, "硬上限到点落屏一次");
    assert.ok(writes[0].length > 20 * 1024, "落屏内容是攒下来的全部字节");
  });

  it("字节上限：累计触顶立即落屏，不等窗口（再大就不是一次重放而是长任务）", () => {
    const { sandbox, writes, clock } = burstSandbox();
    const chunk = big(1024 * 1024, "a");
    sandbox.push(chunk);
    assert.deepEqual(writes, [], "第一个 1MB 还没触顶");
    sandbox.push(chunk);
    assert.equal(writes.length, 1, "第二个 1MB 压到 2MB 上限：立即落屏");
    assert.equal(writes[0].length, 2 * 1024 * 1024, "落屏内容是两块之和");
    assert.equal(sandbox.writeBurst(), null, "触顶后突发清空");
    assert.equal(clock.pending(), 0, "触顶落屏不留定时器");
  });

  it("用户键入强制落屏：攒着的历史不能排在输入回显后面", () => {
    const { sandbox, writes, clock } = burstSandbox();
    sandbox.push(big(64 * 1024, "h"));
    assert.deepEqual(writes, [], "历史还攒着");
    sandbox.flush();
    assert.equal(writes.length, 1, "flush 立即落屏");
    assert.equal(clock.pending(), 0, "落屏后定时器撤净");
    sandbox.flush();
    assert.equal(writes.length, 1, "无突发时 flush 是空操作");
  });

  it("丢弃：换连接/关流时攒着的字节不落屏，定时器一并撤掉", () => {
    const { sandbox, writes, clock } = burstSandbox();
    sandbox.push(big(64 * 1024, "h"));
    sandbox.discard();
    assert.deepEqual(writes, [], "丢弃不写屏（新连接会整屏重发，写了就是双份）");
    assert.equal(sandbox.writeBurst(), null, "突发清空");
    assert.equal(clock.pending(), 0, "定时器撤净");
    clock.advance(sandbox.thresholds.cap * 2);
    assert.deepEqual(writes, [], "被丢弃的字节不会在之后偷偷落屏");
  });

  it("接线：data 帧走合并器、建连首帧直写、键入与换行都先落屏、关流丢弃", () => {
    const connect = panelJs.match(/async function connectTerminalStream\(session,[^)]*\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(connect, "connectTerminalStream found in panel.js");
    assert.ok(/terminalEventSource\.addEventListener\("data"[\s\S]*?queueTerminalChunk\(term, text\)/.test(connect),
      "data 帧交给合并器，不再直接 term.write");
    assert.ok(/terminalReplayFramePending\) \{[\s\S]*?term\.write\(text\)[\s\S]*?queueTerminalChunk/.test(connect),
      "建连后宿主的自足整屏重绘直写，不进合并窗口");
    const inputHandler = connect.match(/terminalInputDisposable = term\.onData\([\s\S]*?\n    \}\);/)?.[0];
    assert.ok(inputHandler && /flushTerminalBurst\(\)/.test(inputHandler), "键入前先落屏攒着的历史");
    const ensure = panelJs.match(/function ensureTerminalXterm\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(ensure, "ensureTerminalXterm found in panel.js");
    const keyHandler = ensure.match(/attachCustomKeyEventHandler\([\s\S]*?\n    \}\);/)?.[0];
    assert.ok(keyHandler && /flushTerminalBurst\(\)/.test(keyHandler), "修饰 Enter 换行同样先落屏");
    const close = panelJs.match(/function closeTerminalStream\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(close && /discardTerminalBurst\(\)/.test(close), "关流丢弃未落屏突发（定时器不能在 dispose 后碰旧实例）");
    const snapshot = panelJs.match(/function absorbTerminalSnapshot\([\s\S]*?\n  \}/)?.[0];
    assert.ok(snapshot && /discardTerminalBurst\(\)/.test(snapshot), "新连接的 snapshot 丢弃上一条连接的残留");
    assert.ok(snapshot && /terminalReplayFramePending = true/.test(snapshot), "snapshot 之后标记首帧直写");
  });

  it("阈值口径：进入门槛远大于实时碎块、上限远小于「一次重放」的合理体量", () => {
    const { sandbox } = burstSandbox();
    const t = sandbox.thresholds;
    assert.ok(t.enter >= 8 * 1024 && t.enter <= 64 * 1024, `进入门槛 ${t.enter} 应在实时碎块与回放块之间`);
    assert.ok(t.quiet > 0 && t.quiet <= 200, `静默窗口 ${t.quiet}ms 应短于用户可感知的停顿`);
    assert.ok(t.cap > t.quiet && t.cap <= 1000, `硬上限 ${t.cap}ms 应有界且长于静默窗口`);
    assert.ok(t.maxBytes >= 1024 * 1024, `字节上限 ${t.maxBytes} 应容得下一次完整重放`);
  });
});

// 应答定投（C 案）：每连接独占一个 xterm 实例，onData 闭包绑定建连时固化的
// 会话 id，不再读 activeTerminalPreviewId；旧连接关闭时实例随流销毁，WriteBuffer
// 里排队未解析的旧字节（大回放跨事件循环切片、续跑定时器不可取消）解析时只能
// 打进监听器表已清空的旧实例——DA/CPR 应答不会再投进新会话的 PTY。函数体抽出
// 进桩环境真跑（Terminal/EventSource/api 全桩），切换语义逐断言钉死。
describe("终端应答定投回所属会话（每连接独占 xterm）", () => {
  function streamSandbox() {
    const bodies = ["closeTerminalStream", "ensureTerminalXterm", "armTerminalDprWatch", "disarmTerminalDprWatch", "terminalXtermTheme", "connectTerminalStream", "terminalClipboardKeyIntent", "terminalNewlineEnterKey", "terminalNewlineDeliveryBlocked", "terminalNewlineData", "terminalSessionMap", "terminalSessionFor", "installTerminalFollowBottomGuard", "reviveTerminalSession", "sendTerminalInput", "queueTerminalChunk", "flushTerminalBurst", "discardTerminalBurst"]
      .map((name) => {
        const src = panelJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
        assert.ok(src, `${name} found in panel.js`);
        return src;
      }).join("\n");
    const state = { posts: [], eventSources: [], terms: [], sessions: {} };
    const sandbox = new Function("state", `
      const API_BASE = "http://panel.test";
      ${terminalBurstConsts}
      const terminalFontSize = 13;
      const terminalBackendReady = true;
      const terminalBackendSessions = state.sessions;
      const terminalPreviewSessions = {};
      let activeTerminalPreviewId = null;
      let terminalXterm = null;
      let terminalFitAddon = null;
      let terminalWebglAddon = null;
      let terminalEventSource = null;
      let terminalHostResizeObserver = null;
      let terminalDprMediaQuery = null;
      let terminalDprMediaHandler = null;
      let terminalInputDisposable = null;
      let terminalBoundSessionId = null;
      let terminalImeHold = null;
      let terminalImeHoldFrame = null;
      let terminalImeFitPending = false;
      let terminalImeAnchorTextarea = null;
      let terminalImeArmHandler = null;
      let terminalImeReleaseHandler = null;
      let terminalBottomAlignIntentAt = 0;
      let terminalBottomAlignTrimFrame = null;
      let terminalReplayRestoring = false;
      let terminalReplayRestoreArm = null;
      let terminalReplayRestoreCancel = null;
      let terminalStreamSyncCancel = null;
      let terminalStreamWrite = null;
      let terminalWriteBurst = null;
      let terminalReplayFramePending = false;
      const host = {};
      const $ = (id) => (id === "terminalXtermHost" ? host : null);
      // xterm 主题读 --terminal-* token：沙箱无样式表，桩回空串走暗色兜底（等价旧行为）
      const document = { documentElement: {} };
      const getComputedStyle = () => ({ getPropertyValue: () => "", colorScheme: "dark" });
      const terminalReviveInflight = new Map();
      const api = (method, url, body) => {
        state.posts.push({ method, url, body });
        if (state.apiImpl) return state.apiImpl(method, url, body);
        return Promise.resolve({});
      };
      function fitTerminalXterm() {}
      function requestAnimationFrame(cb) { cb(); }
      function cancelAnimationFrame() {}
      function terminalImeAnchorReady() { return false; }
      function armTerminalImeAnchor() {}
      function releaseTerminalImeAnchor() {}
      function installTerminalImeAnchor() {}
      // 底部自动对齐：本沙箱不验其行为（行为钉见「虚拟终端底部自动对齐」组），补空桩接线
      function installTerminalBottomAlign() {}
      class FakeFitAddon {}
      const window = { Terminal: null, FitAddon: { FitAddon: FakeFitAddon } };
      window.Terminal = class {
        constructor(options) { this.options = options; this.disposed = false; this.writes = []; this.resetCount = 0; this._disposables = new Set(); state.terms.push(this); }
        loadAddon() {}
        open(hostEl) { this.hostEl = hostEl; }
        onData(fn) { const d = { dispose: () => { this._disposables.delete(d); } }; this._disposables.add(d); this._fire = (data) => { if (this._disposables.has(d)) fn(data); }; return d; }
        fire(data) { this._fire?.(data); }
        write(text) { this.writes.push(text); }
        reset() { this.resetCount += 1; }
        dispose() { this.disposed = true; this._disposables.clear(); this._fire = null; }
        attachCustomKeyEventHandler(fn) { this.keyEventHandler = fn; }
        focus() { this.focusCount = (this.focusCount || 0) + 1; }
        hasSelection() { return this.hasSelectionValue === true; }
      };
      class FakeEventSource {
        constructor(url) { this.url = url; this.closed = false; state.eventSources.push(this); }
        addEventListener() {}
        set onerror(fn) {}
        close() { this.closed = true; }
      }
      const EventSource = FakeEventSource;
      ${bodies}
      return {
        connect: (session, opts) => connectTerminalStream(session, opts),
        close: () => closeTerminalStream(),
        xterm: () => terminalXterm, source: () => terminalEventSource,
        fitAddon: () => terminalFitAddon, input: () => terminalInputDisposable,
      };
    `)(state);
    return { sandbox, state };
  }
  const backendSession = (id, extra = {}) => ({ id, label: id, backend: true, shell: {}, output: [], ...extra });
  const inputUrls = (state) => state.posts.filter((p) => p.method === "POST" && p.url.includes("/input")).map((p) => p.url);

  it("键入只进该 xterm 绑定的会话；A 切 B 后旧实例销毁、B 键入不落 A，会话 C 也不沾边", () => {
    const { sandbox, state } = streamSandbox();
    sandbox.connect(backendSession("sess-a"));
    const termA = sandbox.xterm();
    assert.equal(sandbox.source().url, "http://panel.test/api/terminal/sessions/sess-a/stream", "A 连接指向 A 的流");
    termA.fire("ls\r");
    assert.deepEqual(inputUrls(state), ["/api/terminal/sessions/sess-a/input"], "活跃期间键入POST给A");

    sandbox.connect(backendSession("sess-b"));
    const termB = sandbox.xterm();
    assert.equal(termA.disposed, true, "切换时旧 xterm 随旧流销毁");
    assert.notEqual(termB, termA, "新连接是新实例，不复用旧 xterm");
    assert.deepEqual(inputUrls(state), ["/api/terminal/sessions/sess-a/input"], "切换动作本身不产生 POST");

    termB.fire("pwd\r");
    termA.fire("\x1b[?1;2c"); // 旧会话积压里迟到的 DA 应答打进已销毁实例
    assert.deepEqual(inputUrls(state), [
      "/api/terminal/sessions/sess-a/input",
      "/api/terminal/sessions/sess-b/input",
    ], "B 键入定投进 B；旧实例的迟到应答无监听器可打、不落任何会话");
    assert.ok(!inputUrls(state).some((u) => u.includes("sess-c")), "任何数据都不进第三方会话");
  });

  it("closeTerminalStream 单独调用也断干净：源关闭、实例销毁、键入彻底无出口", () => {
    const { sandbox, state } = streamSandbox();
    sandbox.connect(backendSession("sess-a"));
    sandbox.close();
    assert.equal(sandbox.source(), null, "EventSource 释放");
    assert.equal(sandbox.xterm(), null, "xterm 引用释放");
    assert.equal(sandbox.fitAddon(), null, "fitAddon 引用释放");
    assert.equal(sandbox.input(), null, "onData disposable 引用释放");
    assert.equal(state.eventSources[0].closed, true, "旧 SSE 已 close");
    assert.equal(state.terms[0].disposed, true, "旧 xterm 已 dispose");
    state.terms[0].fire("x");
    assert.deepEqual(inputUrls(state), [], "流关闭后键入无出口");
  });

  it("无后端的预览会话：静态输出照旧回放，键入落空不产生 POST", () => {
    const { sandbox, state } = streamSandbox();
    sandbox.connect({ id: "preview-1", backend: false, shell: {}, output: [["dim", "Windows PowerShell"], ["prompt-line", "PS D:\\dev> "]] });
    assert.equal(sandbox.source(), null, "预览会话不开 SSE");
    assert.deepEqual(sandbox.xterm().writes, ["Windows PowerShell\r\n", "PS D:\\dev> \r\n"], "静态输出逐行回放");
    sandbox.xterm().fire("dir\r");
    assert.deepEqual(inputUrls(state), [], "预览会话键入落空");
  });

  it("Ctrl/Shift+Enter 接管为换行：拦下 xterm 求值（keydown 与 keypress 两条），向定投会话 POST 单字节 LF", () => {
    const { sandbox, state } = streamSandbox();
    sandbox.connect(backendSession("sess-a"));
    const termA = sandbox.xterm();
    assert.equal(termA.keyEventHandler({ type: "keydown", key: "Enter", ctrlKey: true }), false, "Ctrl+Enter 从 xterm 求值摘出（内核只会折叠成 CR）");
    assert.equal(termA.keyEventHandler({ type: "keydown", key: "Enter", shiftKey: true }), false, "Shift+Enter 同样接管");
    assert.deepEqual(state.posts.filter((p) => p.url.includes("/input")), [
      { method: "POST", url: "/api/terminal/sessions/sess-a/input", body: { data: "\n" } },
      { method: "POST", url: "/api/terminal/sessions/sess-a/input", body: { data: "\n" } },
    ], "换行定投 LF 字节（opencode 与 Claude Code 的 ctrl+j 换行语义），不是 CR");

    // 真机漏点：keydown 摘出后内核还会吃 keypress，Shift+Enter 在那里被补折叠成 CR，
    // 用户看到的是「先换行、紧接着发送」。keypress 只拦不投，字节数保持不变。
    assert.equal(termA.keyEventHandler({ type: "keypress", key: "Enter", shiftKey: true, keyCode: 13, charCode: 13 }), false, "Shift+Enter 的 keypress 一并摘出");
    assert.equal(termA.keyEventHandler({ type: "keypress", key: "Enter", ctrlKey: true, keyCode: 13, charCode: 13 }), false, "Ctrl+Enter 的 keypress 一并摘出");
    assert.deepEqual(state.posts.filter((p) => p.url.includes("/input")), [
      { method: "POST", url: "/api/terminal/sessions/sess-a/input", body: { data: "\n" } },
      { method: "POST", url: "/api/terminal/sessions/sess-a/input", body: { data: "\n" } },
    ], "一次按键只有一个换行字节：keypress 不重复投");

    sandbox.connect(backendSession("sess-b"));
    const termB = sandbox.xterm();
    assert.equal(termB.keyEventHandler({ type: "keydown", key: "Enter", ctrlKey: true }), false);
    assert.deepEqual(inputUrls(state).slice(2), ["/api/terminal/sessions/sess-b/input"], "换行定投随建连会话走：A 切 B 后落 B，不落旧会话");
  });

  it("换行字节按会话端点分派：codex 发 ESC CR（Alt+Enter 编码），其余端点与识别不上的会话维持单字节 LF", () => {
    const { sandbox, state } = streamSandbox();
    const inputDataFor = (id) => state.posts
      .filter((p) => p.method === "POST" && p.url.includes("/input") && p.url.includes(id))
      .map((p) => p.body.data);

    // 一键启动的 codex 会话：terminal-host 快照直接携带 agentId
    const codexSession = backendSession("sess-codex", { agentId: "codex", agentName: "Codex CLI" });
    state.sessions[codexSession.id] = codexSession;
    sandbox.connect(codexSession);
    assert.equal(sandbox.xterm().keyEventHandler({ type: "keydown", key: "Enter", ctrlKey: true }), false);
    assert.equal(sandbox.xterm().keyEventHandler({ type: "keydown", key: "Enter", shiftKey: true }), false);
    assert.deepEqual(inputDataFor("sess-codex"), ["\x1b\r", "\x1b\r"],
      "codex 会话发 ESC CR：ConPTY 转译成 Enter+ALT 键事件，命中 codex 的 alt(Enter) 换行绑定；LF 则会被转译成无修饰符的普通 Enter 被当成提交");

    // 纯 shell 里手动启动的 codex：agentId 为空，靠归属轮询注入的 agent.endpointId 识别
    const manualCodex = backendSession("sess-manual", { agent: { name: "Codex CLI", endpointId: "codex", instanceId: "codex-24512", pid: 24512 } });
    state.sessions[manualCodex.id] = manualCodex;
    sandbox.connect(manualCodex);
    sandbox.xterm().keyEventHandler({ type: "keydown", key: "Enter", ctrlKey: true });
    assert.deepEqual(inputDataFor("sess-manual"), ["\x1b\r"], "归属检测判 codex 同样发 ESC CR");

    // 读原始字节流的 Node TUI 维持 LF：ESC CR 对它们是「Esc 再回车」两个字节，会被误提交
    const claudeSession = backendSession("sess-claude", { agentId: "claude", agentName: "Claude Code" });
    state.sessions[claudeSession.id] = claudeSession;
    sandbox.connect(claudeSession);
    sandbox.xterm().keyEventHandler({ type: "keydown", key: "Enter", ctrlKey: true });
    assert.deepEqual(inputDataFor("sess-claude"), ["\n"], "Claude Code/opencode 这类 Node TUI 维持单字节 LF，绝不分派 ESC CR");

    // 识别不上的会话（无 agentId、无归属）维持 LF：换行不生效但不误提交
    const plainShell = backendSession("sess-shell");
    state.sessions[plainShell.id] = plainShell;
    sandbox.connect(plainShell);
    sandbox.xterm().keyEventHandler({ type: "keydown", key: "Enter", shiftKey: true });
    assert.deepEqual(inputDataFor("sess-shell"), ["\n"], "识别不上维持 LF（归属轮询落地前的 codex 也走这一支）");
  });

  it("兜底转发处理过的修饰 Enter 不重复投字节，但仍拦下内核补折叠", () => {
    const { sandbox, state } = streamSandbox();
    sandbox.connect(backendSession("sess-a"));
    const handler = sandbox.xterm().keyEventHandler;
    assert.equal(handler({ type: "keydown", key: "Enter", shiftKey: true, defaultPrevented: true }), false, "仍从内核求值摘出");
    assert.equal(handler({ type: "keypress", key: "Enter", shiftKey: true, defaultPrevented: true }), false, "keypress 同样摘出");
    assert.deepEqual(inputUrls(state), [], "字节已由兜底转发投过，这里不再第二次投");
  });

  it("裸 Enter 与 Alt/Meta 组合交回 xterm 原语义；IME 组字态只拦不发", () => {
    const { sandbox, state } = streamSandbox();
    sandbox.connect(backendSession("sess-a"));
    const handler = sandbox.xterm().keyEventHandler;
    assert.equal(handler({ type: "keydown", key: "Enter" }), true, "裸 Enter 交回 xterm（照常走提交语义）");
    assert.equal(handler({ type: "keypress", key: "Enter", keyCode: 13, charCode: 13 }), true, "裸 Enter 的 keypress 照旧交回 xterm（闸门只多管修饰 Enter）");
    assert.equal(handler({ type: "keydown", key: "Enter", ctrlKey: true, altKey: true }), true, "Ctrl+Alt+Enter 放行（保留 xterm 的 Alt+Enter 原语义）");
    assert.equal(handler({ type: "keydown", key: "Enter", shiftKey: true, metaKey: true }), true, "带 Meta 放行");
    assert.equal(handler({ type: "keyup", key: "Enter", ctrlKey: true }), true, "keyup 不拦");
    // 组字态：键必须摘出内核求值（否则内核上屏候选词后补折叠一个 CR，等于替用户提交），
    // 但字节归输入法，面板不投——换行等字上屏后再按一次。
    assert.equal(handler({ type: "keydown", key: "Enter", ctrlKey: true, isComposing: true }), false, "组字中 Ctrl+Enter 仍摘出内核求值");
    assert.equal(handler({ type: "keydown", key: "Enter", shiftKey: true, keyCode: 229 }), false, "组字中 Shift+Enter（keyCode 229）仍摘出");
    assert.equal(handler({ type: "keypress", key: "Enter", shiftKey: true, isComposing: true }), false, "组字中的 keypress 一并摘出");
    assert.deepEqual(inputUrls(state), [], "以上路径均不产生 input POST");
  });

  it("预览会话无定投目标：修饰 Enter 只拦下折叠、不发 POST", () => {
    const { sandbox, state } = streamSandbox();
    sandbox.connect({ id: "preview-1", backend: false, shell: {}, output: [] });
    assert.equal(sandbox.xterm().keyEventHandler({ type: "keydown", key: "Enter", ctrlKey: true }), false, "仍拦下 xterm 的 CR 折叠");
    assert.deepEqual(inputUrls(state), [], "无后端定投只拦不发");
  });

  it("接线结构：onData 移出 ensure、定投不读活动会话、清理路径销毁实例、resize 监听只绑一次", () => {
    const ensure = panelJs.match(/function ensureTerminalXterm\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(ensure, "ensureTerminalXterm found in panel.js");
    assert.ok(!ensure.includes("onData"), "ensure 不再注册 onData");
    assert.ok(!ensure.includes("activeTerminalPreviewId"), "ensure 不读活动会话");
    assert.ok(!ensure.includes('addEventListener("resize"'), "resize 监听移出 ensure（防逐连接重复注册）");
    const connect = panelJs.match(/async function connectTerminalStream\(session,[^)]*\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(connect, "connectTerminalStream found in panel.js");
    assert.ok(connect.includes("session?.backend ? session.id : null"), "建连时固化会话 id");
    assert.ok(connect.includes("term.onData("), "onData 挂在每连接专属实例上");
    assert.ok(connect.includes("sendTerminalInput(boundSessionId, data)"), "键入走唯一出口并带上固化的会话 id");
    assert.ok(!connect.includes("activeTerminalPreviewId"), "connect 全链路不再读活动会话");
    const close = panelJs.match(/function closeTerminalStream\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(close, "closeTerminalStream found in panel.js");
    assert.ok(close.includes("terminalInputDisposable?.dispose()"), "清理路径先拆 onData 监听器");
    assert.ok(close.includes("terminalXterm?.dispose()"), "清理路径销毁 xterm 实例");
    assert.ok(close.includes("terminalFitAddon = null"), "fitAddon 引用随实例释放");
    const init = panelJs.match(/function initTerminalPreview\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(init.includes('window.addEventListener("resize", debounceTerminalFit)'), "resize 监听收编到初始化一次性绑定");
  });

  it("被动重挂不复活：exited 会话照挂流回放最后一屏，restart 仍只由主动通路发出", async () => {    const { sandbox, state } = streamSandbox();
    const exitedSession = () => ({ id: "sess-x", backend: true, shell: {}, output: [], backendState: { status: "exited" } });
    await sandbox.connect(exitedSession(), { revive: false });
    assert.deepEqual(state.posts, [], "切回前台/回页补挂这类被动重挂绝不发 restart");
    assert.equal(state.eventSources.length, 1, "仍然挂流：画面来自宿主镜像的最后一屏（挂流不要求进程还在）");
    await sandbox.connect(exitedSession(), { revive: true });
    const revives = state.posts.filter((p) => p.url.includes("/revive"));
    assert.equal(revives.length, 1, "点页签等主动通路照旧一次点击一个新壳");
    assert.equal(revives[0].url, "/api/terminal/sessions/sess-x/revive", "复活走重组装凭据的路由");
  });

  it("输入落进 409：复活一次并把这次输入补发过去，不静默吞字", async () => {
    const { sandbox, state } = streamSandbox();
    let inputAttempts = 0;
    state.apiImpl = (method, url) => {
      if (url.includes("/revive")) return Promise.resolve({ id: "sess-d", status: "running", pid: 99 });
      if (url.includes("/input")) {
        inputAttempts += 1;
        if (inputAttempts === 1) return Promise.reject(Object.assign(new Error("HTTP 409：session_exited"), { code: "session_exited" }));
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({});
    };
    const session = backendSession("sess-d", { backendState: { status: "exited" } });
    state.sessions["sess-d"] = session;
    sandbox.connect(session, { revive: false });
    const term = sandbox.xterm();
    term.fire("hi");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const urls = state.posts.map((p) => p.url);
    assert.ok(urls.some((u) => u.includes("/sess-d/revive")), "409 触发一次复活");
    assert.equal(inputAttempts, 2, "复活后把这次输入补发一次");
    assert.equal(session.backendState.status, "running", "会话状态随复活结果更新");
  });

  it("并发 409 只复活一次：两键同时落空不各起一个进程", async () => {
    const { sandbox, state } = streamSandbox();
    let inputAttempts = 0;
    let reviveCalls = 0;
    state.apiImpl = (method, url) => {
      if (url.includes("/revive")) { reviveCalls += 1; return Promise.resolve({ id: "sess-e", status: "running", pid: 100 }); }
      if (url.includes("/input")) {
        inputAttempts += 1;
        if (inputAttempts <= 2) return Promise.reject(Object.assign(new Error("HTTP 409：session_exited"), { code: "session_exited" }));
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({});
    };
    const session = backendSession("sess-e", { backendState: { status: "exited" } });
    state.sessions["sess-e"] = session;
    sandbox.connect(session, { revive: false });
    const term = sandbox.xterm();
    term.fire("a");
    term.fire("b");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(reviveCalls, 1, "同一会话的并发复活合并成一次");
  });

  it("非 409 的投递失败不触发复活", async () => {
    const { sandbox, state } = streamSandbox();
    state.apiImpl = () => Promise.reject(Object.assign(new Error("HTTP 503：terminal_host_unavailable"), { code: "terminal_host_unavailable" }));
    const session = backendSession("sess-f", { backendState: { status: "running" } });
    state.sessions["sess-f"] = session;
    sandbox.connect(session, { revive: false });
    sandbox.xterm().fire("x");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(!state.posts.some((p) => p.url.includes("/revive")), "宿主不可达不该被当成进程已退");
  });
});

// 跳顶回归钉（跟随底部护栏）：渲染尺寸同步的瞬时塌缩会让浏览器把 .xterm-viewport
// 的 scrollTop 钳回原位并派发无标记 scroll 事件，xterm 把它当用户滚动写进 ydisp，
// 视口自此脱离底部卡死在接近顶端（实测：建流回放+输出洪峰窗口内 scrollTop 从底部
// 40095 被钳到 345 且不自行恢复）。护栏语义：跟随态下无意图的离底事件拉回底部；
// 用户主动滚动（滚轮/触摸/按住拖动/键盘 Shift+PageUp·PageDown 翻页）经意图窗口
// 退出跟随态，停在历史绝不拉回；滚回底部恢复跟随。「底部自动对齐」开启时护栏的
// 「底」从缓冲真尾迁到有效底部（尾屏最后一个含文本行=内容底）：落底判定、钳制
// 拉回、内容变化锚定三处同口径。内容变化的唯一来源是 onWriteParsed：增长（输入
// 回显、流式输出）当拍同步锚定，收缩（2J/矮帧/清屏）等写入静默一拍再折。回放期
// 由列上的 replayRestoring 闩住，reset() 后的滚动与逐块写入都不参与跟随判定。
// 开关关=与旧行为逐位一致。函数体抽进桩环境真跑，逐项钉死。
describe("虚拟终端跟随底部护栏（跳顶回归钉）", () => {
  function guardSandbox() {
    const src = panelJs.match(/function installTerminalFollowBottomGuard\(term\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(src, "installTerminalFollowBottomGuard found in panel.js");
    const intentSrc = panelJs.match(/const TERMINAL_SCROLL_INTENT_MS = \d+;/)?.[0];
    assert.ok(intentSrc, "意图窗口常量可从 panel.js 取到（测试不抄数字）");
    const settleSrc = panelJs.match(/const TERMINAL_EFFECTIVE_BOTTOM_SETTLE_MS = \d+;/)?.[0];
    assert.ok(settleSrc, "折回防抖常量可从 panel.js 取到（测试不抄数字）");
    const state = {
      now: 100000, scrollToBottomCount: 0, scrollToLineCalls: [], writeCbs: [], resizeCbs: [],
      alignOn: false, effBase: null, settleMs: Number(settleSrc.match(/\d+/)[0]),
    };
    const sandbox = new Function("state", `
      ${intentSrc}
      ${settleSrc}
      const Date = { now: () => state.now };
      // 有效底部依赖桩：开关态与内容底行由 state 驱动（行为钉见「有效底部」各用例）
      function terminalBottomAlignEnabled() { return state.alignOn; }
      function terminalEffectiveBottomBase(term) { return state.effBase === null ? term.buffer.active.baseY : state.effBase; }
      const view = { hidden: false };
      function $(id) { return id === "terminalView" ? view : null; }
      // 静默防抖 / 意图补排 / 回放清闩的定时器桩：到点任务由 flushTimers 按 state.now 驱动
      const timers = new Map();
      let timerSeq = 0;
      function setTimeout(fn, ms) { timerSeq += 1; timers.set(timerSeq, { at: state.now + ms, fn }); return timerSeq; }
      function clearTimeout(id) { if (id !== null && id !== undefined) timers.delete(id); }
      function flushTimers() {
        for (;;) {
          let due = null;
          for (const [id, t] of timers) if (t.at <= state.now) { due = [id, t]; break; }
          if (!due) break;
          timers.delete(due[0]);
          due[1].fn();
        }
      }
      function makeEl() {
        const handlers = {};
        return {
          handlers,
          addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
          fire(type, event = {}) { for (const fn of handlers[type] || []) fn(event); },
        };
      }
      ${src}
      // 护栏读的是模块级平铺单值；桩环境里声明后经访问器镜成 column 形状，
      // 用例侧的置闩/组字桩写法不变。
      let terminalImeHold = null;
      let terminalReplayRestoring = false;
      let terminalReplayRestoreArm = null;
      let terminalReplayRestoreCancel = null;
      const column = {
        get imeHold() { return terminalImeHold; }, set imeHold(v) { terminalImeHold = v; },
        get replayRestoring() { return terminalReplayRestoring; }, set replayRestoring(v) { terminalReplayRestoring = v; },
        get replayRestoreArm() { return terminalReplayRestoreArm; }, set replayRestoreArm(v) { terminalReplayRestoreArm = v; },
        get replayRestoreCancel() { return terminalReplayRestoreCancel; }, set replayRestoreCancel(v) { terminalReplayRestoreCancel = v; },
      };
      return { installTerminalFollowBottomGuard, makeEl, flushTimers, column };
    `)(state);
    state.flushTimers = sandbox.flushTimers;
    const viewport = sandbox.makeEl();
    const root = sandbox.makeEl();
    root.querySelector = (sel) => (sel === ".xterm-viewport" ? viewport : null);
    root.isConnected = true; // 防抖回调的销毁守卫按 isConnected 判活
    const buffer = { viewportY: 500, baseY: 500, type: "normal" };
    const term = {
      element: root,
      buffer: { active: buffer },
      scrollToBottom() { state.scrollToBottomCount += 1; buffer.viewportY = buffer.baseY; },
      scrollToLine(line) { state.scrollToLineCalls.push(line); buffer.viewportY = line; },
      onWriteParsed(cb) { state.writeCbs.push(cb); },
      onResize(cb) { state.resizeCbs.push(cb); },
    };
    sandbox.installTerminalFollowBottomGuard(term);
    const write = () => { for (const cb of state.writeCbs) cb(); };
    const resize = () => { for (const cb of state.resizeCbs) cb(); };
    return { state, root, viewport, buffer, column: sandbox.column, term, write, resize };
  }

  it("钳制抖动：跟随态下无意图的离底 scroll 事件被拉回底部", () => {
    const { state, viewport, buffer } = guardSandbox();
    viewport.fire("scroll");
    assert.equal(state.scrollToBottomCount, 0, "落底事件不触发拉回");
    buffer.viewportY = 20; // 抖动把 ydisp 从底部打到接近顶端
    viewport.fire("scroll");
    assert.equal(state.scrollToBottomCount, 1, "无意图离底 = 钳制抖动，拉回底部");
    assert.equal(buffer.viewportY, buffer.baseY, "视口回到底部");
  });

  it("用户上翻停在历史绝不拉回：意图窗口内离底退出跟随，之后无意图离底也不动", () => {
    const { state, root, viewport, buffer } = guardSandbox();
    root.fire("wheel", { deltaY: -120 });
    buffer.viewportY = 300;
    viewport.fire("scroll");
    assert.equal(state.scrollToBottomCount, 0, "用户上翻不拉回");
    buffer.viewportY = 20; // 用户停车后抖动再打一次
    viewport.fire("scroll");
    assert.equal(state.scrollToBottomCount, 0, "非跟随态下离底事件一概不动");
  });

  it("按住拖动持续刷新意图窗口：滚动条拖拽/选择拖动全程不拉回", () => {
    const { state, root, viewport, buffer } = guardSandbox();
    root.fire("pointerdown", { buttons: 1 });
    buffer.viewportY = 300;
    viewport.fire("scroll");
    assert.equal(state.scrollToBottomCount, 0, "按下即意图，不拉回");
    state.now += 1000000; // 窗口早过——但拖动进行中
    root.fire("pointermove", { buttons: 1 });
    buffer.viewportY = 200;
    viewport.fire("scroll");
    assert.equal(state.scrollToBottomCount, 0, "按住拖动刷新窗口，仍不拉回");
    state.now += 1000000; // 松手后窗口过去：视口停在历史，后续抖动不动它
    buffer.viewportY = 20;
    viewport.fire("scroll");
    assert.equal(state.scrollToBottomCount, 0, "用户停在历史的现场受保护");
  });

  it("滚回底部恢复跟随：其后的钳制抖动重新被拉回", () => {
    const { state, root, viewport, buffer } = guardSandbox();
    root.fire("wheel", { deltaY: -120 });
    buffer.viewportY = 300;
    viewport.fire("scroll"); // 退出跟随
    buffer.viewportY = buffer.baseY; // 用户滚回底部
    viewport.fire("scroll");
    buffer.viewportY = 20; // 抖动再来
    viewport.fire("scroll");
    assert.equal(state.scrollToBottomCount, 1, "恢复跟随后抖动再次被拉回");
  });

  it("键盘翻页是用户滚动：Shift+PageUp 离底不拉回（xterm 译为 scrollLines 的键只此两枚）", () => {
    const { state, root, viewport, buffer } = guardSandbox();
    root.fire("keydown", { key: "PageUp", shiftKey: true });
    buffer.viewportY = 300;
    viewport.fire("scroll");
    assert.equal(state.scrollToBottomCount, 0, "Shift+PageUp 翻页不被误判为抖动");
    root.fire("keydown", { key: "PageDown", shiftKey: true });
    buffer.viewportY = 400;
    viewport.fire("scroll");
    assert.equal(state.scrollToBottomCount, 0, "Shift+PageDown 同样记意图");
  });

  it("键盘翻页映射精度：裸 PageUp、Shift+Home 不记意图（xterm 对它们无滚动翻译）", () => {
    const { state, root, viewport, buffer } = guardSandbox();
    root.fire("keydown", { key: "PageUp", shiftKey: false });
    root.fire("keydown", { key: "Home", shiftKey: true });
    buffer.viewportY = 20; // 抖动来犯
    viewport.fire("scroll");
    assert.equal(state.scrollToBottomCount, 1, "无滚动映射的键不占用意图窗口，抖动照拉");
  });

  it("接线：open 之后安装护栏；实例缺 element/viewport 时安全返回", () => {
    const ensure = panelJs.match(/function ensureTerminalXterm\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(ensure, "ensureTerminalXterm found in panel.js");
    const openAt = ensure.indexOf("term.open(host)");
    const guardAt = ensure.indexOf("installTerminalFollowBottomGuard(term)");
    assert.ok(openAt > 0 && guardAt > openAt, "护栏装在 open 之后（xterm 自己的 scroll 监听先行绑定）");
    const src = panelJs.match(/function installTerminalFollowBottomGuard\(term\) \{[\s\S]*?\n  \}/)?.[0];
    const fn = new Function(`${src}\nreturn installTerminalFollowBottomGuard;`)();
    fn({ element: null }); // 桩实例无 element：早期返回，不炸
    const rootless = { element: { querySelector: () => null } };
    fn(rootless); // 无 .xterm-viewport：同样安全返回
  });

  it("有效底部·计算：尾屏最后一个含文本行钉在视口末行；全空屏/无空白/短缓冲回退真尾", () => {
    const src = panelJs.match(/function terminalEffectiveBottomBase\(term\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(src, "terminalEffectiveBottomBase found in panel.js");
    const fn = new Function(`${src}\nreturn terminalEffectiveBottomBase;`)();
    const makeTerm = (rows, screen, scrollback) => {
      const lines = [];
      for (let i = 0; i < scrollback; i += 1) lines.push(`scrollback ${i}`);
      lines.push(...screen);
      const baseY = Math.max(0, lines.length - rows);
      return {
        rows,
        buffer: {
          active: {
            length: lines.length,
            baseY,
            getLine: (y) => (y >= 0 && y < lines.length ? { translateToString: () => lines[y] } : undefined),
          },
        },
      };
    };
    // 34 行回滚 + 30 行屏（0..12 有内容、13..29 空白）：内容底=34+12，视口顶=46-29=17
    const blankTail = Array.from({ length: 30 }, (_, i) => (i <= 12 ? `row ${i}` : ""));
    assert.equal(fn(makeTerm(30, blankTail, 34)), 17, "17 行空白折到折叠线下，上方回滚补位");
    assert.equal(fn(makeTerm(30, Array.from({ length: 30 }, (_, i) => `row ${i}`), 34)), 34, "无空白=真尾");
    assert.equal(fn(makeTerm(30, Array.from({ length: 30 }, () => ""), 34)), 34, "整屏全空回退真尾：空屏之下没有可对齐内容");
    assert.equal(fn(makeTerm(30, blankTail.slice(0, 13), 0)), 0, "短缓冲（3J 后无回滚可补）钳到 0=真尾");
  });

  // 地板（Claude Desktop hold/trim 的缓冲层等价）：跟随态停泊行 ∈ [内容底, 真尾]。
  // 初始=真尾（空白带完全可见、零自动折回）；用户上滚经过的最低点把地板收到那里
  // （trim 只缩不扩）；内容增长地板同幅平移（屏上空白恒定）；收缩不动地板。
  it("有效底部·上滚吃掉空白带：收缩零动作，上滚逐拍收紧地板，滚回地板即恢复跟随", () => {
    const { state, root, viewport, buffer, write } = guardSandbox();
    state.alignOn = true;
    state.effBase = 500;
    buffer.viewportY = 500;
    write(); // 取基准：无带，零写
    assert.deepEqual(state.scrollToLineCalls, [], "无空白带不做无谓 scrollToLine");
    state.effBase = 483; // 2J + 顶部重画：内容底收缩，17 行空白带出现
    write();
    state.now += state.settleMs + 10;
    state.flushTimers();
    assert.deepEqual(state.scrollToLineCalls, [], "收缩后不自动折回（CD 语义：空区留给用户上滚吃掉）");
    assert.equal(buffer.viewportY, 500, "视口原地不动");
    root.fire("wheel", { deltaY: -120 });
    buffer.viewportY = 490; // 用户上滚第一拍：地板收到 490
    viewport.fire("scroll");
    buffer.viewportY = 483; // 再上滚：地板收到内容底
    viewport.fire("scroll");
    buffer.viewportY = 482; // 滚回地板上一行=落底，恢复跟随
    viewport.fire("scroll");
    write();
    assert.deepEqual(state.scrollToLineCalls, [483], "跟随后停泊在地板（空区已吃掉）");
    assert.equal(buffer.viewportY, 483, "落点恰好是修剪后的内容底");
    assert.equal(state.scrollToBottomCount, 0, "全程不回真尾");
  });

  it("有效底部·收缩后洪峰多拍仍零动作", () => {
    const { state, write } = guardSandbox();
    state.alignOn = true;
    state.effBase = 500;
    write();
    state.effBase = 483;
    for (let round = 0; round < 3; round += 1) {
      write();
      state.now += state.settleMs + 10;
      state.flushTimers();
      assert.deepEqual(state.scrollToLineCalls, [], `第 ${round} 拍不折`);
    }
  });

  it("有效底部·trim 只缩不扩：深滚进历史地板不越过内容底，下滚不回扩", () => {
    const { state, root, viewport, buffer, write } = guardSandbox();
    state.alignOn = true;
    state.effBase = 483;
    root.fire("wheel", { deltaY: -120 });
    buffer.viewportY = 100; // Shift+PageUp 式深滚：地板钳到内容底 483，不跟到 100
    viewport.fire("scroll");
    buffer.viewportY = 482; // 落回地板上一行即恢复跟随（滚不到 483 以下才 repin）
    viewport.fire("scroll");
    write();
    assert.deepEqual(state.scrollToLineCalls, [483], "地板被内容底托住，不被深滚削穿");
    assert.equal(buffer.viewportY, 483);
  });

  it("有效底部·钳制拉回：修剪后跟随态被无意图抖动打离地板时拉回地板", () => {
    const { state, root, viewport, buffer } = guardSandbox();
    state.alignOn = true;
    state.effBase = 483;
    root.fire("wheel", { deltaY: -120 });
    buffer.viewportY = 483;
    viewport.fire("scroll"); // trim 到 483、退出跟随
    buffer.viewportY = 482;
    viewport.fire("scroll"); // 落回地板恢复跟随
    state.now += 100000; // 意图窗早过
    buffer.viewportY = 20; // 钳制抖动
    viewport.fire("scroll");
    assert.deepEqual(state.scrollToLineCalls, [483], "拉回地板而非真尾");
    assert.equal(buffer.viewportY, 483);
    assert.equal(state.scrollToBottomCount, 0, "不走 scrollToBottom");
  });

  it("有效底部·增长锚定：修剪后内容底下行，地板同幅平移当拍跟随（可视空白恒定）", () => {
    const { state, root, viewport, buffer, write } = guardSandbox();
    state.alignOn = true;
    state.effBase = 483;
    root.fire("wheel", { deltaY: -120 });
    buffer.viewportY = 483;
    viewport.fire("scroll");
    buffer.viewportY = 482;
    viewport.fire("scroll"); // 恢复跟随
    state.effBase = 490; // 内容底下行 7 行
    write();
    assert.deepEqual(state.scrollToLineCalls, [490], "地板 483+7 当拍落位，不等任何静默窗");
    assert.equal(buffer.viewportY, 490);
  });

  it("有效底部·菜单回归：折叠态下内容向下延伸穿屏，视口跟到真尾、菜单尾部可见", () => {
    const { state, root, viewport, buffer, write } = guardSandbox();
    state.alignOn = true;
    state.effBase = 483;
    buffer.viewportY = 500;
    root.fire("wheel", { deltaY: -120 });
    buffer.viewportY = 483;
    viewport.fire("scroll"); // trim 到 483
    buffer.viewportY = 482;
    viewport.fire("scroll"); // 恢复跟随
    state.effBase = 491; // / 菜单第一段：内容底下行 8 行（缓冲真尾未动）
    write();
    assert.deepEqual(state.scrollToLineCalls, [491], "内容底下行视口跟随，菜单始终可见");
    buffer.baseY = 508; // 菜单穿屏：缓冲滚动，真尾与内容底同到 508
    state.effBase = 508;
    write();
    assert.deepEqual(state.scrollToLineCalls, [491, 508], "地板随内容顶到真尾");
    assert.equal(buffer.viewportY, 508, "视口落真尾=菜单底可见（旧码此处零写入、菜单落在屏下）");
  });

  it("有效底部·回放落点：停在历史顶时写流把视口锚到真尾（地板未修剪，空区保留）", () => {
    const { state, write, buffer } = guardSandbox();
    state.alignOn = true;
    state.effBase = 483;
    buffer.viewportY = 0; // 回放落点停在历史顶，跟随态无滚动事件可醒护栏
    write();
    assert.deepEqual(state.scrollToLineCalls, [500], "地板=真尾：锚到真尾，空白带不自动折");
    assert.equal(buffer.viewportY, 500);
  });

  it("有效底部·意图窗零动作且不丢帧：修剪态增长在窗内不锚，窗过补锚一次", () => {
    const { state, root, viewport, buffer, write } = guardSandbox();
    state.alignOn = true;
    state.effBase = 483;
    root.fire("wheel", { deltaY: -120 });
    buffer.viewportY = 483;
    viewport.fire("scroll");
    buffer.viewportY = 482;
    viewport.fire("scroll"); // 恢复跟随
    root.fire("wheel", { deltaY: 120 }); // 手势进行中（只记意图，无位移）
    state.effBase = 490;
    write();
    assert.deepEqual(state.scrollToLineCalls, [], "手势期间零动作");
    state.now += 100; // 仍在 250ms 意图窗内
    state.flushTimers();
    assert.deepEqual(state.scrollToLineCalls, [], "意图窗内补排不提前动作");
    state.now += 400; // 窗过，补排到点
    state.flushTimers();
    assert.deepEqual(state.scrollToLineCalls, [490], "补排保证跟随不被丢掉");
    assert.equal(buffer.viewportY, 490);
  });

  it("有效底部·尺寸变化：onResize 后按地板重锚", () => {
    const { state, root, viewport, buffer, resize } = guardSandbox();
    state.alignOn = true;
    state.effBase = 483;
    root.fire("wheel", { deltaY: -120 });
    buffer.viewportY = 483;
    viewport.fire("scroll");
    buffer.viewportY = 482;
    viewport.fire("scroll");
    resize();
    assert.deepEqual(state.scrollToLineCalls, [483], "行数变化后按地板重锚");
    assert.equal(buffer.viewportY, 483);
  });

  it("有效底部·历史保护：非跟随态（用户在历史上）内容变化绝不拽回", () => {
    const { state, root, viewport, buffer, write } = guardSandbox();
    state.alignOn = true;
    state.effBase = 483;
    root.fire("wheel", { deltaY: -120 });
    buffer.viewportY = 300;
    viewport.fire("scroll"); // 退出跟随（地板同时被内容底托在 483）
    state.now += 100000;
    write();
    state.now += state.settleMs + 10;
    state.flushTimers();
    assert.deepEqual(state.scrollToLineCalls, [], "停在历史上绝不拉回（护栏旧语义不动）");
  });

  it("有效底部·组字冻结：imeHold 期间内容变化不锚动", () => {
    const { state, root, viewport, buffer, column, write } = guardSandbox();
    state.alignOn = true;
    state.effBase = 483;
    root.fire("wheel", { deltaY: -120 });
    buffer.viewportY = 483;
    viewport.fire("scroll");
    buffer.viewportY = 482;
    viewport.fire("scroll");
    column.imeHold = { textarea: {} };
    state.effBase = 490;
    write();
    state.now += state.settleMs + 10;
    state.flushTimers();
    assert.deepEqual(state.scrollToLineCalls, [], "组字期零动作");
  });

  it("有效底部·备用屏跳过：alternate 缓冲无滚动历史，写解析与滚动都不动视口", () => {
    const { state, viewport, buffer, write } = guardSandbox();
    state.alignOn = true;
    state.effBase = 483;
    buffer.type = "alternate";
    buffer.viewportY = 0;
    write();
    state.now += state.settleMs + 10;
    state.flushTimers();
    assert.deepEqual(state.scrollToLineCalls, [], "备屏写解析不锚定");
    buffer.viewportY = 0;
    viewport.fire("scroll");
    assert.equal(state.scrollToBottomCount, 0, "备屏滚动事件不拉回");
  });

  it("回放闩：reset 后的滚动不改跟随态，回放静默后落真尾（地板未修剪）", () => {
    const { state, viewport, buffer, column, write } = guardSandbox();
    state.alignOn = true;
    state.effBase = 483;
    column.replayRestoring = true;
    column.replayRestoreArm();
    buffer.viewportY = 0; // reset() 把 ydisp/ybase 归零后的离底滚动
    viewport.fire("scroll");
    assert.deepEqual(state.scrollToLineCalls, [], "闩内滚动不触发动作");
    write(); // 回放数据逐块写入：重置静默窗
    assert.deepEqual(state.scrollToLineCalls, [], "回放期间不逐块锚定");
    state.now += state.settleMs - 10;
    state.flushTimers();
    assert.equal(column.replayRestoring, true, "写入未静默，闩保持");
    state.now += 20;
    state.flushTimers();
    assert.equal(column.replayRestoring, false, "静默一拍后清闩");
    assert.deepEqual(state.scrollToLineCalls, [500], "回放结束落在真尾（空区不自动折，留待上滚吃掉）");
    assert.equal(buffer.viewportY, 500, "视口在真尾");
    buffer.viewportY = 20; // 闩清后无意图离底仍是抖动
    viewport.fire("scroll");
    assert.equal(state.scrollToBottomCount, 1, "跟随态已恢复，抖动照拉回真尾（地板=真尾）");
  });

  it("回放闩兜底：无回放数据时清闩定时器同样到期，不永久闩住", () => {
    const { state, column, buffer } = guardSandbox();
    state.alignOn = true;
    state.effBase = 483;
    buffer.viewportY = 0; // reset 归零后的位置——否则视口本就在地板，锚定是零写
    column.replayRestoring = true;
    column.replayRestoreArm();
    state.now += state.settleMs + 10;
    state.flushTimers();
    assert.equal(column.replayRestoring, false, "无写入也清闩");
    assert.deepEqual(state.scrollToLineCalls, [500], "清闩时锚一次到真尾");
    assert.equal(buffer.viewportY, 500, "视口在真尾");
  });

  it("回放闩随实例销毁撤销：close 后定时器不再碰旧实例", () => {
    const { state, column } = guardSandbox();
    column.replayRestoring = true;
    column.replayRestoreArm();
    column.replayRestoreCancel();
    state.now += state.settleMs + 10;
    state.flushTimers();
    assert.equal(column.replayRestoring, true, "撤销后定时器不再执行（由 closeTerminalStream 置回 false）");
  });

  it("回放闩·历史保护：用户在读历史时回放结束不拽底、不恢复跟随（CD：视窗自己不动）", () => {
    const { state, root, viewport, buffer, column, write } = guardSandbox();
    state.alignOn = true;
    state.effBase = 483;
    root.fire("wheel", { deltaY: -120 });
    buffer.viewportY = 300;
    viewport.fire("scroll"); // 用户停在历史上，退出跟随
    state.now += 1000; // 越过意图窗——否则旧码的拽底会被补排窗口遮蔽（钉子必须判别）
    column.replayRestoring = true;
    column.replayRestoreArm();
    write(); // 回放数据写入：重置静默窗
    state.now += state.settleMs + 10;
    state.flushTimers();
    assert.equal(column.replayRestoring, false, "静默后照常清闩");
    assert.deepEqual(state.scrollToLineCalls, [], "读历史时清闩零动作");
    assert.equal(state.scrollToBottomCount, 0, "不走真尾");
    assert.equal(buffer.viewportY, 300, "视窗原地不动");
    buffer.viewportY = 20; // 其后的无意图离底事件按非跟随态处理：不动
    viewport.fire("scroll");
    assert.deepEqual(state.scrollToLineCalls, [], "跟随态未被强置");
  });

  it("有效底部·开关关=逐位旧版：写解析零动作、钳制拉回走 scrollToBottom 真尾", () => {
    const { state, viewport, buffer, write } = guardSandbox();
    write();
    state.now += state.settleMs + 10;
    state.flushTimers();
    assert.deepEqual(state.scrollToLineCalls, [], "写解析零动作");
    assert.equal(state.scrollToBottomCount, 0, "写解析不触发拉回");
    buffer.viewportY = 20;
    viewport.fire("scroll");
    assert.equal(state.scrollToBottomCount, 1, "钳制拉回仍走 scrollToBottom");
    assert.deepEqual(state.scrollToLineCalls, [], "零 scrollToLine");
  });

  it("scrollOnUserInput 关闭：输入不再把视口写回真尾（有效底部语义的前提）", () => {
    const ensure = panelJs.match(/function ensureTerminalXterm\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(ensure, "ensureTerminalXterm found in panel.js");
    assert.ok(/new window\.Terminal\(\{[\s\S]*?scrollOnUserInput: false/.test(ensure), "Terminal 选项显式关闭输入自动滚底");
  });
});

// 输入法锚点的折叠补正（2026-10-20 定案）：xterm 的组字定位按「光标屏内行 × 行高」算，
// 不含 viewportY 偏移——底部自动对齐把视口锚到真尾之上后，组字窗恒偏高「折起的空白带
// 行数」行；光标出视口时 xterm 整块跳过更新（锚点留在旧位置）。修法：冻结时按公开缓冲
// 读数把 (baseY − viewportY) × cellHeight 补回；光标不在视口内（翻历史）不冻结。
describe("虚拟终端输入法锚点·折叠补正", () => {
  function imeSandbox() {
    const armSrc = panelJs.match(/function armTerminalImeAnchor\(\) \{[\s\S]*?\n  \}/)?.[0];
    const readySrc = panelJs.match(/function terminalImeAnchorReady\(textarea\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(armSrc, "armTerminalImeAnchor found in panel.js");
    assert.ok(readySrc, "terminalImeAnchorReady found in panel.js");
    const state = { frames: [], sets: [], classes: [] };
    const sandbox = new Function("state", `
      let terminalImeHold = null;
      let terminalImeHoldFrame = null;
      let terminalImeAnchorTextarea = null;
      let terminalImeAnchorTerm = null;
      function requestAnimationFrame(fn) { state.frames.push(fn); return state.frames.length; }
      function cancelAnimationFrame(id) { state.frames[id - 1] = null; }
      ${readySrc}
      ${armSrc}
      return {
        armTerminalImeAnchor,
        setTextarea(v) { terminalImeAnchorTextarea = v; },
        setTerm(v) { terminalImeAnchorTerm = v; },
        getHold() { return terminalImeHold; },
      };
    `)(state);
    const makePart = (name) => ({
      style: {
        left: "10px", top: "40px", width: "20px", height: "19px", lineHeight: "19px",
        setProperty(k, v) { state.sets.push(`${name}:${k}=${v}`); },
        removeProperty() {},
      },
      classList: { add(c) { state.classes.push(`${name}:${c}`); }, remove() {} },
    });
    const compositionView = makePart("view");
    const textarea = makePart("textarea");
    textarea.parentElement = { querySelector: (sel) => (sel === ".composition-view" ? compositionView : null) };
    const makeTerm = (baseY, viewportY, cursorY, rows = 30) => ({
      rows,
      buffer: { active: { baseY, viewportY, cursorY } },
    });
    return { state, sandbox, textarea, compositionView, makeTerm };
  }

  it("折叠态：冻结的 top 按 (baseY−viewportY)×cellHeight 补正，textarea 与组字窗同值", () => {
    const { state, sandbox, textarea, makeTerm } = imeSandbox();
    sandbox.setTextarea(textarea);
    sandbox.setTerm(makeTerm(500, 483, 2)); // 折起 17 行空白带
    sandbox.armTerminalImeAnchor();
    assert.ok(state.sets.includes("textarea:--ime-hold-top=363px"), "textarea 冻结 top=40+17×19=363px");
    assert.ok(state.sets.includes("view:--ime-hold-top=363px"), "组字窗同值冻结");
    assert.ok(state.classes.includes("textarea:ime-hold") && state.classes.includes("view:ime-hold"), "双件同钉");
    assert.ok(sandbox.getHold(), "组字持钉态就位");
  });

  it("无折叠：偏移为 0，冻结值与 xterm 计算值一致（与既有行为逐位一致）", () => {
    const { state, sandbox, textarea, makeTerm } = imeSandbox();
    sandbox.setTextarea(textarea);
    sandbox.setTerm(makeTerm(500, 500, 2));
    sandbox.armTerminalImeAnchor();
    assert.ok(state.sets.includes("textarea:--ime-hold-top=40px"), "零偏移原值冻结");
    assert.ok(sandbox.getHold(), "正常持钉");
  });

  it("光标出视口（翻历史）不冻结：不钉、不重排", () => {
    const { state, sandbox, textarea, makeTerm } = imeSandbox();
    sandbox.setTextarea(textarea);
    sandbox.setTerm(makeTerm(500, 100, 2)); // 光标在视口下 372 行
    sandbox.armTerminalImeAnchor();
    assert.equal(sandbox.getHold(), null, "光标出视口不持钉");
    assert.equal(state.classes.length, 0, "不加冻结类");
    assert.equal(state.frames.length, 0, "不排重试帧（避免组字全程空转 rAF）");
  });

  it("几何未就绪：照既有语义排到下一帧重试", () => {
    const { state, sandbox, textarea, makeTerm } = imeSandbox();
    textarea.style.top = "";
    sandbox.setTextarea(textarea);
    sandbox.setTerm(makeTerm(500, 483, 2));
    sandbox.armTerminalImeAnchor();
    assert.equal(sandbox.getHold(), null, "未就绪不持钉");
    assert.equal(state.frames.length, 1, "重排一帧");
  });

  it("接线：installTerminalImeAnchor 固化 term 引用，closeTerminalStream 清空", () => {
    const installSrc = panelJs.match(/function installTerminalImeAnchor\(term\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(installSrc, "installTerminalImeAnchor found in panel.js");
    assert.ok(installSrc.includes("terminalImeAnchorTerm = term"), "装配时固化 term（补正要读缓冲）");
    const closeSrc = panelJs.match(/function closeTerminalStream\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(closeSrc, "closeTerminalStream found in panel.js");
    assert.ok(closeSrc.includes("terminalImeAnchorTerm = null"), "关流清空 term 引用，不碰旧实例");
  });
});

// 底部自动对齐（terminalBottomAutoAlign，缺省关）外层半边：窗口收放等尺寸错配期，xterm 渲染层
// 旧高度溢出宿主盒、被外层 .terminal-screen 的 overflow:auto 接住，形成底部可滚入的
// 空白带。开启后用户上滚意图（wheel deltaY<0 / Shift+PageUp，与跳顶护栏同一 root
// capture 事件面）触发把外层 scrollTop 收 0；本函数动作面只写外层 scrollTop，不写
// .xterm-viewport、不调 scrollToBottom/scrollToLines。缓冲层半边（/ 指令表收起留下
// 的缓冲空白带）在护栏的有效底部，见「跟随底部护栏」组。函数体抽进桩环境真跑。
describe("虚拟终端底部自动对齐", () => {
  const ALIGN_DESC = "关闭时，终端画面下方多出的空白区域保持原样；开启后，向上翻看历史时自动裁掉底部多出的空白，再滚回底部即恰好对齐。";

  function alignSrc(name, pattern) {
    const src = panelJs.match(pattern)?.[0];
    assert.ok(src, `${name} found in panel.js`);
    return src;
  }

  it("骨架：终端设置小窗含新开关条目，标题与定稿 desc 字面量在册，位列恢复开关之后", () => {
    const modal = panelHtml.slice(panelHtml.indexOf('id="terminalSettingsModal"'));
    assert.ok(modal.includes('id="terminalBottomAlignToggle"'), "开关 toggle 在册");
    assert.ok(modal.includes('<div class="modal-item-title">底部自动对齐</div>'), "标题「底部自动对齐」在册");
    assert.ok(modal.includes(`<div class="modal-item-desc">${ALIGN_DESC}</div>`), "desc 定稿字面量逐字在册");
    assert.ok(
      modal.indexOf('id="terminalRestoreToggle"') < modal.indexOf('id="terminalBottomAlignToggle"'),
      "新条目位列「从上次中断的地方继续」之后（同一个小窗内并列追加）");
  });

  function alignSandbox() {
    const fnSrc = alignSrc("installTerminalBottomAlign", /function installTerminalBottomAlign\(term\) \{[\s\S]*?\n  \}/);
    const intentSrc = alignSrc("TERMINAL_SCROLL_INTENT_MS", /const TERMINAL_SCROLL_INTENT_MS = \d+;/);
    const bandSrc = alignSrc("TERMINAL_BOTTOM_ALIGN_BAND_MIN_PX", /const TERMINAL_BOTTOM_ALIGN_BAND_MIN_PX = \d+;/);
    const state = { now: 100000, alignOn: true, viewHidden: false, rafQueue: [] };
    const sandbox = new Function("state", `
      ${intentSrc}
      ${bandSrc}
      const Date = { now: () => state.now };
      function requestAnimationFrame(cb) { state.rafQueue.push(cb); return state.rafQueue.length; }
      function makeEl() {
        const handlers = {};
        return {
          handlers,
          dataset: {},
          addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
          fire(type, event = {}) { for (const fn of handlers[type] || []) fn(event); },
        };
      }
      const els = {};
      function $(id) { return els[id] || null; }
      function terminalBottomAlignEnabled() { return state.alignOn; }
      ${fnSrc}
      // 对齐状态在模块级平铺单值上；经访问器镜成 column 形状，用例写法不变。
      let terminalImeHold = null;
      let terminalBottomAlignIntentAt = 0;
      let terminalBottomAlignTrimFrame = null;
      const column = {
        get imeHold() { return terminalImeHold; }, set imeHold(v) { terminalImeHold = v; },
        get bottomAlignIntentAt() { return terminalBottomAlignIntentAt; }, set bottomAlignIntentAt(v) { terminalBottomAlignIntentAt = v; },
        get bottomAlignTrimFrame() { return terminalBottomAlignTrimFrame; }, set bottomAlignTrimFrame(v) { terminalBottomAlignTrimFrame = v; },
      };
      return { installTerminalBottomAlign, makeEl, els, column };
    `)(state);
    const root = sandbox.makeEl();
    const screen = sandbox.makeEl();
    screen.scrollHeight = 900;
    screen.clientHeight = 600;
    let scrollTopValue = 120; // 带已被滚入（滚轮到底后链入外层）
    const writes = [];
    Object.defineProperty(screen, "scrollTop", {
      get() { return scrollTopValue; },
      set(v) { writes.push(v); scrollTopValue = v; },
    });
    sandbox.els.terminalScreen = screen;
    sandbox.els.terminalView = { get hidden() { return state.viewHidden; } };
    const term = {
      element: root,
      scrollToBottom() { state.scrollToBottomCount = (state.scrollToBottomCount || 0) + 1; },
      scrollToLines() { state.scrollToLinesCount = (state.scrollToLinesCount || 0) + 1; },
    };
    sandbox.installTerminalBottomAlign(term);
    const flush = () => { for (const cb of state.rafQueue.splice(0)) cb(); };
    return { state, root, screen, term, column: sandbox.column, writes, flush };
  }

  it("开关关：上滚意图不动作，外层 scrollTop 原样", () => {
    const { state, root, screen, writes, flush } = alignSandbox();
    state.alignOn = false;
    root.fire("wheel", { deltaY: -120 });
    flush();
    assert.equal(writes.length, 0, "开关关时零写");
    assert.equal(screen.scrollTop, 120, "外层 scrollTop 不动");
  });

  it("开关开：上滚意图把外层 scrollTop 收 0，且绝不碰内层 viewport 通路", () => {
    const { state, root, screen, writes, flush } = alignSandbox();
    root.fire("wheel", { deltaY: -120 });
    flush();
    assert.deepEqual(writes, [0], "外层 scrollTop 收 0 恰好一笔");
    assert.equal(screen.scrollTop, 0, "带被吃掉，回到自然停靠位");
    assert.equal(screen.dataset.bottomAlignTrim, "300", "调试属性记下被吃的带高");
    assert.equal(state.scrollToBottomCount, undefined, "不调 scrollToBottom");
    assert.equal(state.scrollToLinesCount, undefined, "不调 scrollToLines");
  });

  it("无空带不动：scrollHeight==clientHeight 时上滚零写；行高取整残余（<阈值）同样不动", () => {
    const tight = alignSandbox();
    tight.screen.scrollHeight = 600; // 与 clientHeight 齐平：无带
    tight.root.fire("wheel", { deltaY: -120 });
    tight.flush();
    assert.equal(tight.writes.length, 0, "无空带零写");
    const residual = alignSandbox();
    residual.screen.scrollHeight = 603; // 行高取整残余 3px，低于阈值
    residual.root.fire("wheel", { deltaY: -120 });
    residual.flush();
    assert.equal(residual.writes.length, 0, "行高取整残余不构成带，零写");
  });

  it("组字期挂起：imeHold 期间上滚不量不动", () => {
    const { root, column, writes, flush } = alignSandbox();
    column.imeHold = { textarea: {} };
    root.fire("wheel", { deltaY: -120 });
    flush();
    assert.equal(writes.length, 0, "组字期零写");
  });

  it("隐藏期不量不动：终端页 hidden 时上滚零写", () => {
    const { state, root, writes, flush } = alignSandbox();
    state.viewHidden = true;
    root.fire("wheel", { deltaY: -120 });
    flush();
    assert.equal(writes.length, 0, "隐藏期零写");
  });

  it("幂等闸：已在停靠位再触发零写", () => {
    const { root, writes, flush } = alignSandbox();
    root.fire("wheel", { deltaY: -120 });
    flush();
    root.fire("wheel", { deltaY: -120 });
    flush();
    assert.deepEqual(writes, [0], "重复触发只写一笔，已归 0 不再写");
  });

  it("意图映射精度：Shift+PageUp 收带；裸 PageUp、Shift+Home、wheel 下滚都不触发", () => {
    const up = alignSandbox();
    up.root.fire("keydown", { key: "PageUp", shiftKey: true });
    up.flush();
    assert.deepEqual(up.writes, [0], "Shift+PageUp 翻历史触发收带");
    for (const [type, event] of [
      ["keydown", { key: "PageUp", shiftKey: false }],
      ["keydown", { key: "Home", shiftKey: true }],
      ["wheel", { deltaY: 120 }],
    ]) {
      const sandbox = alignSandbox();
      sandbox.root.fire(type, event);
      sandbox.flush();
      assert.equal(sandbox.writes.length, 0, `${type} ${JSON.stringify(event)} 不占上滚意图`);
    }
  });

  it("滚动事件流内逐步收：无标记 scroll 裸信不动作，意图时效窗内才收", () => {
    const { state, root, screen, writes, flush } = alignSandbox();
    screen.fire("scroll");
    flush();
    assert.equal(writes.length, 0, "无意图的 scroll 事件（布局钳制派生）不动作");
    root.fire("wheel", { deltaY: -120 });
    flush(); // 吃掉意图自带的帧，带收 0
    assert.deepEqual(writes, [0]);
    state.now += 100000; // 意图窗口早过
    screen.scrollHeight = 900; // 带又长出来（尺寸错配期延续）
    screen.fire("scroll");
    flush();
    assert.equal(writes.length, 1, "时效窗外再无动作——意图判定必须配窗，不裸信");
  });

  it("布局型静态残留空带：带非滚动成因（/ 指令表收起后下方残留），无 scroll 事件史，上滚意图即收；无意图则静态保留", () => {
    const { state, root, screen, writes, flush } = alignSandbox();
    // 沙箱出厂即 scrollHeight>clientHeight 且 scrollTop>0：带是布局变化静态留下的，
    // 全程不派发任何 scroll 事件——不模拟「滚进去」的过程，与窗口收放成因无关。
    flush();
    assert.equal(writes.length, 0, "功能不自愈：无用户意图，静态残留带原样保留");
    state.now += 100000; // 静置再久也不动
    flush();
    assert.equal(screen.scrollTop, 120, "残留带静态存在，不被后台机制裁掉");
    root.fire("wheel", { deltaY: -120 }); // 用户上滚翻看历史
    flush();
    assert.deepEqual(writes, [0], "上滚意图触发收带：成因无关，静态残留带同样被吃");
    assert.equal(screen.scrollTop, 0, "外层回到自然停靠位");
  });

  it("装配与共存：open 之后护栏先行、本功能随后", () => {
    const ensure = alignSrc("ensureTerminalXterm", /function ensureTerminalXterm\(\) \{[\s\S]*?\n  \}/);
    const openAt = ensure.indexOf("term.open(host)");
    const guardAt = ensure.indexOf("installTerminalFollowBottomGuard(term)");
    const alignAt = ensure.indexOf("installTerminalBottomAlign(term)");
    assert.ok(openAt > 0 && guardAt > openAt, "护栏装在 open 之后（既有次序不动）");
    assert.ok(alignAt > guardAt, "本功能装在护栏之后——两 install 同位邻接，事件面同源");
    assert.ok(panelJs.includes("let terminalBottomAlignIntentAt = 0;"), "上滚意图时间戳是模块级单值");
    assert.ok(panelJs.includes("let terminalBottomAlignTrimFrame = null;"), "裁剪帧句柄是模块级单值");
  });

  async function hostControlsSandbox() {
    const src = alignSrc("initTerminalHostControls", /function initTerminalHostControls\(\) \{[\s\S]*?\n  \}/);
    const state = { posts: [], toasts: [], postResult: { ok: true, settings: {} }, postThrow: null };
    const makeToggle = () => ({
      checked: false,
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      removeAttribute(k) { delete this.attrs[k]; },
    });
    const els = {
      terminalHostToggleBtn: {},
      terminalSettingsModal: { classList: { add() {}, remove() {} } },
      terminalRestoreToggle: makeToggle(),
      terminalBottomAlignToggle: makeToggle(),
      terminalSettingsBtn: {},
      terminalSettingsCloseBtn: {},
    };
    const sandbox = new Function("state", "els", `
      function $(id) { return els[id] || null; }
      let terminalHostState = "running";
      function syncTerminalHostControls() {}
      function requestStopTerminalHost() {}
      function startTerminalHost() {}
      let terminalRestoreSessions = true;
      let terminalRestoreSaving = false;
      function terminalRestoreEnabled() { return terminalRestoreSessions; }
      let terminalBottomAutoAlign = false;
      let terminalBottomAlignSaving = false;
      function terminalBottomAlignEnabled() { return terminalBottomAutoAlign; }
      async function api(method, url, body) {
        state.posts.push({ method, url, body });
        if (state.postThrow) throw state.postThrow;
        return state.postResult;
      }
      function toast(msg) { state.toasts.push(msg); }
      function panelError(err, fallback) { return fallback; }
      ${src}
      return { initTerminalHostControls, get align() { return terminalBottomAutoAlign; } };
    `)(state, els);
    sandbox.initTerminalHostControls();
    return { state, els, sandbox };
  }

  it("装配：开窗回显当前值；onchange 乐观置值 + POST /api/settings 带 terminalBottomAutoAlign 键", async () => {
    const { state, els, sandbox } = await hostControlsSandbox();
    const toggle = els.terminalBottomAlignToggle;
    els.terminalSettingsBtn.onclick();
    assert.equal(toggle.checked, false, "缺省关，开窗回显关位");
    toggle.checked = true;
    await toggle.onchange();
    assert.deepEqual(state.posts, [{ method: "POST", url: "/api/settings", body: { terminalBottomAutoAlign: true } }],
      "onchange 即改即存，POST 带新键");
    assert.equal(sandbox.align, true, "运行时缓存乐观置值");
    els.terminalSettingsBtn.onclick();
    assert.equal(toggle.checked, true, "再开窗回显已开启");
  });

  it("装配：保存失败回滚 checked 与缓存并 toast；请求异常同样回滚", async () => {
    const failed = await hostControlsSandbox();
    failed.state.postResult = { ok: false };
    const toggleA = failed.els.terminalBottomAlignToggle;
    toggleA.checked = true;
    await toggleA.onchange();
    assert.equal(toggleA.checked, false, "失败回滚 checked");
    assert.equal(failed.sandbox.align, false, "失败回滚运行时缓存");
    assert.ok(failed.state.toasts.includes("设置保存失败"), "失败有 toast");
    const thrown = await hostControlsSandbox();
    thrown.state.postThrow = new Error("network down");
    const toggleB = thrown.els.terminalBottomAlignToggle;
    toggleB.checked = true;
    await toggleB.onchange();
    assert.equal(toggleB.checked, false, "异常回滚 checked");
    assert.equal(thrown.sandbox.align, false, "异常回滚运行时缓存");
    assert.ok(thrown.state.toasts.includes("请求失败"), "异常走 panelError 兜底文案");
  });
});

// 挂后台/切回的总闸：终端页各数据源对 document.hidden 的分工在这一个处理器里。
// 处理器整体抽进桩环境真跑——不靠字符串比对猜"接了线"，每个视图分支按调用序列钉。
describe("虚拟终端后台转折：进后台拆流、切回按镜像重建且不复活", () => {
  const handlerBody = panelJs.match(/document\.addEventListener\("visibilitychange", \(\) => \{([\s\S]*?)\n  \}\);/)?.[1];
  assert.ok(handlerBody, "visibilitychange 处理器可取样");

  function run(view, hidden) {
    const state = { view, calls: [] };
    new Function("state", "document", `
      function refreshStatus() { state.calls.push("refreshStatus"); return Promise.resolve(); }
      function refreshAgents() { state.calls.push("refreshAgents"); }
      function refreshModelStability() { state.calls.push("refreshModelStability"); }
      function refreshStatsState() { state.calls.push("refreshStatsState"); }
      function pollTerminalSessions() { state.calls.push("pollTerminalSessions"); }
      function renderTerminalPreviewSession(opts) { state.calls.push("renderPreview:revive=" + (opts && opts.revive)); }
      function syncTerminalDataStream() { state.calls.push("syncTerminalDataStream"); }
      function boardVisible() { return state.view === "board"; }
      let currentView = state.view;
      let terminalVisibilityWasHidden = false;
      ${handlerBody}
    `)(state, { hidden });
    return state.calls;
  }

  it("进后台：只拆流，其余一概不刷", () => {
    assert.deepEqual(run("terminal", true), ["syncTerminalDataStream"]);
    assert.deepEqual(run("board", true), ["syncTerminalDataStream"]);
  });

  it("切回终端页：先核一次闸（可见即空操作），补一拍归属数据，并按被动重挂口径重建画面", () => {
    assert.deepEqual(run("terminal", false), [
      "syncTerminalDataStream", "refreshStatus", "pollTerminalSessions", "renderPreview:revive=false",
    ]);
  });

  it("切回看板/统计/其它页：不碰终端重建，看板照常补两拍", () => {
    assert.deepEqual(run("board", false), ["syncTerminalDataStream", "refreshStatus", "refreshAgents", "refreshModelStability"]);
    assert.deepEqual(run("stats", false), ["syncTerminalDataStream", "refreshStatus", "refreshStatsState"]);
    assert.deepEqual(run("sessions", false), ["syncTerminalDataStream", "refreshStatus"]);
  });

  it("1s 兜底拍：只补漏掉的转折，开局即 hidden 不算转折（不把常驻隐藏环境的终端页拆成空白）", () => {
    const init = panelJs.match(/function initTerminalPreview\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(init, "initTerminalPreview found in panel.js");
    assert.ok(init.includes("terminalVisibilityWasHidden = document.hidden;"), "定时器建立时按当下可见性起算初值");
    const at = init.indexOf("terminalPollTimer = setInterval");
    const tick = init.slice(at, init.indexOf("}, 1000);", at));
    assert.ok(tick.includes("document.hidden && !terminalVisibilityWasHidden"), "拆流核拍以转折为条件，不是以隐藏为条件");
    assert.ok(tick.indexOf("syncTerminalDataStream") < tick.indexOf('if (document.hidden) return;'), "核拍排在隐藏早退之前，否则隐藏期根本跑不到");
    assert.ok(tick.indexOf("syncTerminalActivityStream()") < tick.indexOf("syncTerminalDataStream()"), "两条流的闸同拍，字节流不落在真值流后面");
  });
});

// 键盘兜底转发（首开吞字收口）：焦点不在 xterm 隐藏输入框（首开未就绪/未聚焦
// 的窗口）时，按键落到页面主体直接丢字。捕获阶段监听把可打印键与回车/退格
// 转投当前活动会话。函数体抽出进桩环境真跑：document 桩记录监听注册、处理器
// 手动触发（无 DOM 事件派发），api 桩记录 POST。
describe("终端键盘兜底转发（焦点不在 xterm 时）", () => {
  function keydownSandbox() {
    const src = panelJs.match(/function initTerminalPreview\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(src, "initTerminalPreview found in panel.js");
    const newlineGate = panelJs.match(/function terminalNewlineEnterKey\(event\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(newlineGate, "terminalNewlineEnterKey found in panel.js");
    const newlineData = panelJs.match(/function terminalNewlineData\(session\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(newlineData, "terminalNewlineData found in panel.js");
    const state = { posts: [], documentListeners: [], focusCount: 0 };
    const sandbox = new Function("state", `
      let currentView = "terminal";
      let terminalBackendReady = true;
      let terminalPollTimer = null;
      let activeTerminalPreviewId = "sess-a";
      let terminalXterm = null;
      const terminalBackendSessions = {};
      const terminalPreviewSessions = {};
      const sessions = {
        "sess-a": { id: "sess-a", backend: true },
        "sess-b": { id: "sess-b", backend: true },
        "sess-codex": { id: "sess-codex", backend: true, agentId: "codex", agentName: "Codex CLI" },
        "sess-manual": { id: "sess-manual", backend: true, agent: { name: "Codex CLI", endpointId: "codex", instanceId: "codex-24512", pid: 24512 } },
      };
      const document = {
        hidden: false,
        activeElement: null,
        addEventListener(type, fn, capture) { state.documentListeners.push({ type, fn, capture: capture === true }); },
      };
      const elements = {};
      const $ = (id) => {
        if (!elements[id]) elements[id] = {
          addEventListener() {}, hidden: true, contains() { return false; },
          classList: { toggle() {}, contains() { return false; } },
          setAttribute() {}, getAttribute() { return null; },
        };
        return elements[id];
      };
      const terminalReviveInflight = new Map();
      const api = (method, url, body) => { state.posts.push({ method, url, body }); return Promise.resolve({}); };
      function sendTerminalInput(sessionId, data) {
        return api("POST", "/api/terminal/sessions/" + sessionId + "/input", { data });
      }
      function terminalSessionFor(id) { return sessions[id] || null; }
      function debounceTerminalFit() {}
      function positionTerminalAddMenu() {}
      function restoreTerminalFontSize() {}
      function syncTerminalAddBtn() {}
      function fetchTerminalDefaultCwd() {}
      function connectTerminalBackend() {}
      function renderTerminalPreviewSession() {}
      function renderTerminalPendingState() {}
      function syncTerminalActivityStream() {}
      function pollTerminalSessions() {}
      function nudgeTerminalFontSize() {}
      function isTerminalFontZoomKey() { return 0; }
      function rememberTerminalSessionId() {}
      function closeTerminalPreview() {}
      function closeTerminalStream() {}
      function renderTerminalPreviewTabs() {}
      function renderTerminalEmptyState() {}
      function openTerminalAddMenu() {}
      function closeTerminalAddMenu() {}
      function confirmTerminalAddMenu() {}
      function selectTerminalAddAgent() {}
      function loadInstalledTerminalAgents() {}
      // 页签条收展接线走真实现（applyTerminalTabsHidden/setTerminalTabsHidden 在源码内），
      // 桩只补它们触到的外部面：localStorage 与 scheduleTerminalFit。
      const localStorage = { getItem: () => null, setItem: () => {} };
      function scheduleTerminalFit() {}
      function setTerminalTabsHidden() {}
      function applyTerminalTabsHidden() {}
      function setInterval(cb) { return 1; }
      const window = { addEventListener() {}, confirm: () => true };
      ${newlineGate}
      ${newlineData}
      ${src}
      terminalXterm = { focus() { state.focusCount += 1; } };
      initTerminalPreview();
      return {
        document,
        setActive: (v) => { activeTerminalPreviewId = v; },
        setView: (v) => { currentView = v; },
      };
    `)(state);
    const captureHandlers = state.documentListeners.filter((l) => l.type === "keydown" && l.capture);
    assert.equal(captureHandlers.length, 1, "兜底转发恰一个，且注册在捕获阶段");
    const fire = (event) => {
      const prevented = [];
      captureHandlers[0].fn({
        preventDefault: () => prevented.push(true),
        type: "keydown", isComposing: false, keyCode: 0, ctrlKey: false, metaKey: false, altKey: false,
        ...event,
      });
      return prevented.length > 0;
    };
    const inputPosts = () => state.posts.filter((p) => p.method === "POST" && p.url.includes("/input"));
    return { sandbox, state, fire, inputPosts };
  }

  it("终端页焦点在页面主体：可打印键与 Enter/Backspace 转投当前活动会话并聚焦 xterm", () => {
    const { sandbox, state, fire, inputPosts } = keydownSandbox();
    sandbox.document.activeElement = { tagName: "BODY", classList: { contains: () => false } };
    assert.equal(fire({ key: "a" }), true, "preventDefault 落地，字节不再落回页面主体");
    assert.deepEqual(inputPosts(), [
      { method: "POST", url: "/api/terminal/sessions/sess-a/input", body: { data: "a" } },
    ]);
    assert.equal(state.focusCount, 1, "转发后回焦 xterm，后续键入由 xterm 自收");
    sandbox.setActive("sess-b");
    fire({ key: "Enter" });
    fire({ key: "Backspace" });
    assert.deepEqual(inputPosts().slice(1), [
      { method: "POST", url: "/api/terminal/sessions/sess-b/input", body: { data: "\r" } },
      { method: "POST", url: "/api/terminal/sessions/sess-b/input", body: { data: "\x7f" } },
    ], "Enter/Backspace 映射成控制字节，发往触发时读到的活动会话");
  });

  it("焦点不在 xterm 时修饰 Enter 同走换行闸门：只投 LF，绝不出现提交字节", () => {
    const { sandbox, fire, inputPosts } = keydownSandbox();
    sandbox.document.activeElement = { tagName: "BODY", classList: { contains: () => false } };
    assert.equal(fire({ key: "Enter", shiftKey: true }), true, "Shift+Enter 被兜底接管（此前按 Ctrl/Meta/Alt 闸门放行）");
    assert.equal(fire({ key: "Enter", ctrlKey: true }), true, "Ctrl+Enter 同样接管（此前整条键静默丢失）");
    assert.deepEqual(inputPosts().map((p) => p.body.data), ["\n", "\n"], "兜底转发发的是换行字节");
    assert.ok(!inputPosts().some((p) => p.body.data === "\r"), "兜底通路里没有提交字节");
    // 裸 Enter 与其余 Ctrl 组合键的既有语义不受影响
    fire({ key: "Enter" });
    fire({ key: "c", ctrlKey: true });
    assert.deepEqual(inputPosts().slice(2).map((p) => p.body.data), ["\r"], "裸 Enter 照旧 CR 提交，其余 Ctrl 组合键不劫持");
  });

  it("兜底转发的修饰 Enter 同样按端点分派：codex 会话发 ESC CR，识别不上的维持 LF", () => {
    const { sandbox, fire, inputPosts } = keydownSandbox();
    sandbox.document.activeElement = { tagName: "BODY", classList: { contains: () => false } };
    fire({ key: "Enter", shiftKey: true });
    sandbox.setActive("sess-codex");
    fire({ key: "Enter", ctrlKey: true });
    sandbox.setActive("sess-manual");
    fire({ key: "Enter", shiftKey: true });
    assert.deepEqual(inputPosts().map((p) => p.url), [
      "/api/terminal/sessions/sess-a/input",
      "/api/terminal/sessions/sess-codex/input",
      "/api/terminal/sessions/sess-manual/input",
    ], "三字节各自定投到触发时的活动会话");
    assert.deepEqual(inputPosts().map((p) => p.body.data), ["\n", "\x1b\r", "\x1b\r"],
      "无归属的 sess-a 维持 LF；agentId 携带与归属检测判 codex 的两条都发 ESC CR");
  });

  it("焦点在其它输入控件（INPUT/TEXTAREA）或 xterm 自持输入框时不劫持", () => {
    const { sandbox, fire, inputPosts } = keydownSandbox();
    sandbox.document.activeElement = { tagName: "INPUT" };
    assert.equal(fire({ key: "a" }), false, "INPUT 不劫持（新建菜单 cwd 框同型）");
    sandbox.document.activeElement = { tagName: "TEXTAREA" };
    assert.equal(fire({ key: "a" }), false, "TEXTAREA 不劫持");
    sandbox.document.activeElement = { classList: { contains: (c) => c === "xterm-helper-textarea" } };
    assert.equal(fire({ key: "a" }), false, "xterm 自持的隐藏输入框不劫持");
    assert.deepEqual(inputPosts(), [], "以上路径均不产生 POST");
  });

  it("非 terminal 视图不劫持", () => {
    const { sandbox, fire, inputPosts } = keydownSandbox();
    sandbox.setView("sessions");
    assert.equal(fire({ key: "a" }), false);
    assert.deepEqual(inputPosts(), []);
  });

  it("IME 组字态（isComposing / keyCode 229）与不映射键（方向键、F 键、Tab）不劫持", () => {
    const { fire, inputPosts } = keydownSandbox();
    assert.equal(fire({ key: "a", keyCode: 229 }), false, "组字态 keyCode 229 不劫持");
    assert.equal(fire({ key: "a", isComposing: true }), false, "isComposing 不劫持");
    assert.equal(fire({ key: "a", ctrlKey: true }), false, "Ctrl 组合键不劫持");
    assert.equal(fire({ key: "a", metaKey: true }), false, "Meta 组合键不劫持");
    assert.equal(fire({ key: "a", altKey: true }), false, "Alt 组合键不劫持");
    assert.equal(fire({ key: "ArrowUp" }), false, "方向键不劫持");
    assert.equal(fire({ key: "F5" }), false, "F 键不劫持");
    assert.equal(fire({ key: "Tab" }), false, "Tab 不劫持");
    assert.deepEqual(inputPosts(), [], "以上路径均不产生 POST");
  });
});

// 窗口 resize 防抖（B3）：拖动动画里逐帧的事件合并到静默期后一次 fit。
// 防抖函数在桩定时器环境里真跑。
describe("虚拟终端 resize 防抖", () => {
  function resizeDebounceSandbox() {
    const src = panelJs.match(/function debounceTerminalFit\([\s\S]*?\n  \}/)?.[0];
    assert.ok(src, "debounceTerminalFit found in panel.js");
    const state = { fits: 0, seq: 0, pending: new Map() };
    const setTimeoutStub = (cb, ms) => { const id = ++state.seq; state.pending.set(id, { cb, ms }); return id; };
    const clearTimeoutStub = (id) => { state.pending.delete(id); };
    const fn = new Function("state", "setTimeout", "clearTimeout", `
      let terminalResizeDebounceTimer = null;
      const TERMINAL_RESIZE_DEBOUNCE_MS = 120;
      function fitTerminalXterm() { state.fits += 1; }
      ${src}
      return debounceTerminalFit;
    `)(state, setTimeoutStub, clearTimeoutStub);
    const flush = () => {
      const batch = [...state.pending.values()];
      state.pending.clear();
      for (const { cb } of batch) cb();
    };
    return { fn, state, flush };
  }

  it("连续 resize 事件只 fit 一次，静默期后再来一次再 fit 一次", () => {
    const { fn, state, flush } = resizeDebounceSandbox();
    fn(); fn(); fn();
    assert.equal(state.fits, 0, "拖动过程中不逐帧 fit");
    assert.equal(state.pending.size, 1, "重复事件合并成一个待触发定时器");
    flush();
    assert.equal(state.fits, 1, "静默期后恰好一次 fit");
    fn();
    flush();
    assert.equal(state.fits, 2, "下一轮 resize 再补一次");
    const delay = resizeDebounceSandbox();
    delay.fn();
    const ms = [...delay.state.pending.values()][0]?.ms;
    assert.ok(ms >= 80 && ms <= 150, `防抖延迟 ${ms}ms 落在 80–150ms 区间`);
  });

  it("接线：resize 监听挂防抖入口；建流先同步 fit 再开流（回放到达前列宽已量准）", () => {
    assert.ok(panelJs.includes('window.addEventListener("resize", debounceTerminalFit)'), "resize 监听走防抖");
    const connect = panelJs.match(/async function connectTerminalStream\(session,[^)]*\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(connect, "connectTerminalStream found in panel.js");
    const fitAt = connect.indexOf("fitTerminalXterm()");
    const streamAt = connect.indexOf("terminalEventSource = new EventSource");
    assert.ok(fitAt > 0 && streamAt > 0 && fitAt < streamAt,
      "建流先同步 fit 再开 SSE——首帧回放不再按 xterm 出厂默认列宽（80）折行");
    const schedule = panelJs.match(/function scheduleTerminalFit\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(schedule.includes("fitTerminalXterm()"), "终端页显示路径仍直接 fit");
  });
});

// 页签条收展：终端页头「隐藏页签/展示页签」钮整排收起会话页签给终端屏让高。
// 收放改变终端容器高度 → 必然牵动 fit/resize，安全性全部押在既有闸门复用上：
// 收展只调 scheduleTerminalFit（inspector 收放同一先例），视图闸 / 窗口级尺寸闸 /
// 同尺寸不 POST 闸在 fitTerminalXterm 体内原样生效，本功能不另起任何 resize 通路。
describe("虚拟终端页签条收展（页头「隐藏页签/展示页签」钮）", () => {
  it("markup 与样式契约：页题右侧按钮两态文案、页签条整排可收起", () => {
    const btnTag = panelHtml.match(/<button[^>]*id="terminalTabsToggleBtn"[\s\S]*?<\/button>/)?.[0];
    assert.ok(btnTag, "页头带 terminalTabsToggleBtn 按钮");
    assert.ok(btnTag.includes(">隐藏页签<"), "默认态文案「隐藏页签」");
    assert.ok(btnTag.includes('title="隐藏页签"') && btnTag.includes('aria-label="隐藏页签"'),
      "悬停与读屏口径与按钮文案同词");
    const titleAt = panelHtml.indexOf('class="terminal-page-title"');
    const btnAt = panelHtml.indexOf('id="terminalTabsToggleBtn"');
    const headRightAt = panelHtml.indexOf('class="terminal-head-right"');
    assert.ok(titleAt > 0 && btnAt > titleAt && btnAt < headRightAt,
      "按钮落在页题右侧、页头右段之前");
    assert.ok(!panelHtml.includes("展示页签"), "「展示页签」只由 JS 翻转，静态稿不出现");
    const barTag = panelHtml.match(/<div class="terminal-tabs-bar"[^>]*>/)?.[0];
    assert.ok(barTag?.includes('id="terminalTabsBar"'), "页签条带 id 供 JS 收展");
    const hideRule = panelCss.match(/\.terminal-tabs-bar\.is-hidden\s*\{[^}]*\}/)?.[0];
    assert.ok(hideRule?.includes("display: none"), "is-hidden 整排收走页签条");
    assert.ok(/\.terminal-tabs-toggle-btn\s*\{[^}]*margin-left/.test(panelCss),
      "按钮与页题之间拉开距离的样式在位");
  });

  it("resize 安全契约：收展只走 scheduleTerminalFit，不另起 fit/POST 通路", () => {
    const setSrc = panelJs.match(/function setTerminalTabsHidden\([\s\S]*?\n  \}/)?.[0];
    assert.ok(setSrc, "setTerminalTabsHidden found in panel.js");
    assert.ok(setSrc.includes("scheduleTerminalFit()"),
      "收放后补一次尺寸适配（±页签条高度不经 window resize，同 inspector 收放先例）");
    for (const banned of ["fitTerminalXterm", "postTerminalResize", "terminalFitAddon", "api("]) {
      assert.ok(!setSrc.includes(banned), `收展逻辑不得直触 ${banned}——闸门只在 fitTerminalXterm 体内`);
    }
    const applySrc = panelJs.match(/function applyTerminalTabsHidden\([\s\S]*?\n  \}/)?.[0];
    assert.ok(applySrc, "applyTerminalTabsHidden found in panel.js");
    assert.ok(!applySrc.includes("scheduleTerminalFit"),
      "落态函数不触发 fit——初始化恢复时终端流未建，进页既有通路自会量准");
    const init = panelJs.match(/function initTerminalPreview\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(init.includes('$("terminalTabsToggleBtn").onclick'), "按钮接线在 initTerminalPreview");
    assert.ok(init.includes("localStorage.getItem(TERMINAL_TABS_HIDDEN_KEY)"),
      "刷新恢复读持久化偏好");
  });

  it("vm 真跑收展状态机：隐藏/恢复两态翻转、持久化、恢复态不触发 fit", () => {
    const keySrc = panelJs.match(/const TERMINAL_TABS_HIDDEN_KEY = "[^"]+";/)?.[0];
    const applySrc = panelJs.match(/function applyTerminalTabsHidden\([\s\S]*?\n  \}/)?.[0];
    const setSrc = panelJs.match(/function setTerminalTabsHidden\([\s\S]*?\n  \}/)?.[0];
    assert.ok(keySrc && applySrc && setSrc, "状态机三段可从 panel.js 取到");
    const build = () => {
      const state = { fits: 0, store: {} };
      const sandbox = new Function("state", `
        const elCache = {};
        const el = (id) => elCache[id] ??= {
          textContent: "", title: "", attrs: {},
          classes: new Set(),
          classList: {
            toggle: (c, on) => { if (on === undefined) on = !elCache[id].classes.has(c); if (on) elCache[id].classes.add(c); else elCache[id].classes.delete(c); return on; },
          },
          setAttribute(k, v) { this.attrs[k] = v; },
        };
        const $ = (id) => el(id);
        const localStorage = {
          getItem: (k) => (k in state.store ? state.store[k] : null),
          setItem: (k, v) => { state.store[k] = String(v); },
        };
        let terminalTabsHidden = false;
        ${keySrc}
        function scheduleTerminalFit() { state.fits += 1; }
        ${applySrc}
        ${setSrc}
        return {
          applyTerminalTabsHidden, setTerminalTabsHidden, el,
          hidden: () => terminalTabsHidden,
          restore: () => applyTerminalTabsHidden(localStorage.getItem(TERMINAL_TABS_HIDDEN_KEY) === "1"),
        };
      `)(state);
      return { ...sandbox, state };
    };

    // ① 无存档：默认展开，落态不触发 fit、不写存档
    const fresh = build();
    fresh.restore();
    assert.strictEqual(fresh.el("terminalTabsBar").classes.has("is-hidden"), false, "默认页签条展开");
    assert.strictEqual(fresh.el("terminalTabsToggleBtn").textContent, "隐藏页签", "默认文案「隐藏页签」");
    assert.equal(fresh.state.fits, 0, "初始化落态不触发 fit");
    assert.deepEqual(fresh.state.store, {}, "落态不写存档");

    // ② 隐藏：整排收起 + 文案翻转 + 存档 "1" + 恰好一次 fit
    fresh.setTerminalTabsHidden(true);
    assert.strictEqual(fresh.hidden(), true);
    assert.strictEqual(fresh.el("terminalTabsBar").classes.has("is-hidden"), true, "页签条整排收起");
    const btn = fresh.el("terminalTabsToggleBtn");
    assert.strictEqual(btn.textContent, "展示页签", "隐藏后文案翻「展示页签」");
    assert.strictEqual(btn.title, "展示页签");
    assert.strictEqual(btn.attrs["aria-label"], "展示页签");
    assert.strictEqual(btn.attrs["aria-expanded"], "false", "aria-expanded 随收展同步");
    assert.equal(fresh.state.store["panel-terminal-tabs-hidden"], "1", "隐藏态持久化");
    assert.equal(fresh.state.fits, 1, "高度变化恰好补一次 fit");

    // ③ 恢复：对称翻转 + 存档 "0" + 再补一次 fit
    fresh.setTerminalTabsHidden(false);
    assert.strictEqual(fresh.el("terminalTabsBar").classes.has("is-hidden"), false, "页签条恢复");
    assert.strictEqual(fresh.el("terminalTabsToggleBtn").textContent, "隐藏页签");
    assert.strictEqual(fresh.el("terminalTabsToggleBtn").attrs["aria-expanded"], "true");
    assert.equal(fresh.state.store["panel-terminal-tabs-hidden"], "0");
    assert.equal(fresh.state.fits, 2, "恢复同样恰好补一次 fit");

    // ④ 刷新恢复隐藏态：存档 "1" → 落 is-hidden 与翻转文案，不触发 fit（终端流未建）
    const restored = build();
    restored.state.store["panel-terminal-tabs-hidden"] = "1";
    restored.restore();
    assert.strictEqual(restored.el("terminalTabsBar").classes.has("is-hidden"), true, "刷新后隐藏态保持");
    assert.strictEqual(restored.el("terminalTabsToggleBtn").textContent, "展示页签");
    assert.equal(restored.state.fits, 0, "恢复落态不触发 fit——进页时 scheduleTerminalFit 按含本态的布局量准");
  });
});

// 首次开启碎屏修复：面板加载后终端页还是隐藏的（display:none），旧初始化路径
// 已经在隐藏容器里建流、fit 并收全量回放。FitAddon 从隐藏宿主只能量到百分比
// 兜底值（实测把 xterm 压成 12×6），整行提示符按 12 列折成 4 段；之后可见 fit
// 虽把 PTY 纠正到 119×26，xterm 加大列宽却不重排已折行内容——首帧画错就一直
// 是错的，实时输出再和旧折行缝成「Frankenstein」画面。修法=隐藏期整体闸下
// 建流与测量，进页（可见）才建流。函数体抽进桩环境真跑，FitAddon 桩按视图
// 显隐返回实测/兜底两套尺寸，复刻真实测量行为。
describe("虚拟终端隐藏期不建流不测量（首次开启碎屏修复）", () => {
  function terminalGateSandbox({ viewHidden = true } = {}) {
    const bodies = ["fitTerminalXterm", "terminalHostMeasurable", "postTerminalResize", "debounceTerminalFit", "armTerminalDprWatch", "disarmTerminalDprWatch", "ensureTerminalXterm", "terminalXtermTheme", "connectTerminalStream", "closeTerminalStream", "syncTerminalDataStream", "terminalClipboardKeyIntent", "terminalNewlineEnterKey", "terminalNewlineDeliveryBlocked", "installTerminalFollowBottomGuard", "reviveTerminalSession", "sendTerminalInput", "queueTerminalChunk", "flushTerminalBurst", "discardTerminalBurst"]
      .map((name) => {
        const src = panelJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
        assert.ok(src, `${name} found in panel.js`);
        return src;
      }).join("\n");
    const state = {
      posts: [], eventSources: [], terms: [],
      measured: { cols: 119, rows: 26 },
      hiddenFallback: { cols: 12, rows: 6 },
      session: { id: "sess-a", backend: true, backendState: null, shell: {} },
      warns: [], resizeObservers: [], resizeFailures: 0,
      windowHidden: false,
    };
    const view = { hidden: viewHidden };
    const fitFloorSrc = panelJs.match(/const TERMINAL_FIT_MIN_HOST_WIDTH_PX = \d+;[\s\S]{0,80}?const TERMINAL_FIT_MIN_HOST_HEIGHT_PX = \d+;/)?.[0];
    assert.ok(fitFloorSrc, "窗口级尺寸闸的下限可从 panel.js 取到（测试不抄数字）");
    const host = {};
    const sandbox = new Function("state", `
      const API_BASE = "http://panel.test";
      ${terminalBurstConsts}
      const terminalFontSize = 13;
      const view = { hidden: ${JSON.stringify(viewHidden)} };
      const host = { clientWidth: 1200, clientHeight: 600 };
      const $ = (id) => (id === "terminalView" ? view : id === "terminalXtermHost" ? host : null);
      // xterm 主题读 --terminal-* token：沙箱无样式表，桩回空串走暗色兜底（等价旧行为）
      // document.hidden 走 state.windowHidden：视图显隐与窗口可见性是两件事，各自可摆。
      const document = { documentElement: {}, get hidden() { return state.windowHidden; } };
      const getComputedStyle = () => ({ getPropertyValue: () => "", colorScheme: "dark" });
      const console = { warn: (...args) => { state.warns.push(args.map(String).join(" ")); } };
      const api = (method, url, body) => {
        state.posts.push({ method, url, body });
        if (method === "POST" && url.includes("/resize") && state.resizeFailures > 0) {
          state.resizeFailures -= 1;
          return Promise.reject(new Error("resize 失败（测试注入）"));
        }
        return Promise.resolve({});
      };
      function terminalSessionFor(id) { return state.session; }
      function requestAnimationFrame(cb) { cb(); }
      // 底部自动对齐：本沙箱不验其行为（行为钉见「虚拟终端底部自动对齐」组），补空桩接线
      function installTerminalBottomAlign() {}
      class FakeFitAddon {
        fit() {
          const term = this.term;
          if (!term) return;
          // 复刻真实测量：视图隐藏时 getComputedStyle 只能给出百分比兜底值
          const m = view.hidden ? state.hiddenFallback : state.measured;
          term.cols = m.cols;
          term.rows = m.rows;
        }
      }
      const window = { FitAddon: { FitAddon: FakeFitAddon } };
      window.Terminal = class {
        constructor(options) { this.options = options; this.cols = 80; this.rows = 24; this.disposed = false; this.writes = []; this.resetCount = 0; this._disposables = new Set(); this.focusCount = 0; this.keyEventHandler = null; this.selection = false; state.terms.push(this); }
        loadAddon(addon) { addon.term = this; }
        open(hostEl) { this.openedHost = hostEl; }
        onData(fn) { const d = { dispose: () => { this._disposables.delete(d); } }; this._disposables.add(d); this._fire = (data) => { if (this._disposables.has(d)) fn(data); }; return d; }
        fire(data) { this._fire?.(data); }
        write(text) { this.writes.push(text); }
        reset() { this.resetCount += 1; }
        dispose() { this.disposed = true; this._disposables.clear(); this._fire = null; }
        attachCustomKeyEventHandler(fn) { this.keyEventHandler = fn; }
        focus() { this.focusCount += 1; }
        hasSelection() { return this.selection; }
      };
      class FakeEventSource {
        constructor(url) { this.url = url; this.closed = false; state.eventSources.push(this); }
        addEventListener() {}
        set onerror(fn) {}
        close() { this.closed = true; }
      }
      const EventSource = FakeEventSource;
      class FakeResizeObserver {
        constructor(cb) { this.cb = cb; this.observed = []; this.disconnected = false; state.resizeObservers.push(this); }
        observe(el) { this.observed.push(el); }
        disconnect() { this.disconnected = true; }
      }
      const ResizeObserver = FakeResizeObserver;
      let terminalResizeDebounceTimer = null;
      const TERMINAL_RESIZE_DEBOUNCE_MS = 120;
      // 尺寸闸下限从源码取，测试不另抄一份数字：阈值改了这里就红，不靠人记得改。
      ${fitFloorSrc}
      const pendingTimers = [];
      const setTimeoutStub = (cb, ms) => { const id = pendingTimers.length + 1; pendingTimers.push({ id, cb, ms }); return id; };
      const clearTimeoutStub = (id) => { const i = pendingTimers.findIndex((t) => t.id === id); if (i >= 0) pendingTimers.splice(i, 1); };
      const setTimeout = setTimeoutStub;
      const clearTimeout = clearTimeoutStub;
      function cancelAnimationFrame() {}
      function terminalImeAnchorReady() { return false; }
      function armTerminalImeAnchor() {}
      function releaseTerminalImeAnchor() {}
      function installTerminalImeAnchor() {}
      ${bodies}
      // 平铺单值群：沙箱照 panel.js 的模块级声明摆一份，真实函数体直接读写它们。
      let terminalXterm = null;
      let terminalFitAddon = null;
      let terminalWebglAddon = null;
      let terminalEventSource = null;
      let terminalHostResizeObserver = null;
      let terminalDprMediaQuery = null;
      let terminalDprMediaHandler = null;
      let terminalInputDisposable = null;
      let terminalBoundSessionId = null;
      let terminalImeHold = null;
      let terminalImeHoldFrame = null;
      let terminalImeFitPending = false;
      let terminalImeAnchorTextarea = null;
      let terminalImeArmHandler = null;
      let terminalImeReleaseHandler = null;
      let terminalReplayRestoring = false;
      let terminalReplayRestoreArm = null;
      let terminalReplayRestoreCancel = null;
      let terminalStreamSyncCancel = null;
      let terminalStreamWrite = null;
      let terminalWriteBurst = null;
      let terminalReplayFramePending = false;
      return {
        connect: (session, opts) => connectTerminalStream(session, opts),
        close: () => closeTerminalStream(),
        fit: () => fitTerminalXterm(),
        debounce: debounceTerminalFit,
        sync: syncTerminalDataStream,
        flushTimers: () => { for (const { cb } of pendingTimers.splice(0)) cb(); },
        xterm: () => terminalXterm, source: () => terminalEventSource,
        host: () => host,
        setViewHidden: (v) => { view.hidden = v; },
        setWindowHidden: (v) => { state.windowHidden = v; },
        setHostSize: (w, h) => { host.clientWidth = w; host.clientHeight = h; },
        setMeasured: (cols, rows) => { state.measured = { cols, rows }; },
        observers: () => state.resizeObservers,
      };
    `)(state);
    return { sandbox, state, view };
  }
  const backendSession = (id) => ({ id, label: id, backend: true, shell: {}, output: [] });
  const resizePosts = (state) => state.posts.filter((p) => p.method === "POST" && p.url.includes("/resize"));

  it("首次开启：终端页隐藏期不建流不测量，点开可见后才建流并按可见尺寸收首帧", () => {
    const { sandbox, state } = terminalGateSandbox({ viewHidden: true });
    // 面板加载即初始化：终端页还在隐藏（display:none）
    sandbox.connect(backendSession("sess-a"));
    assert.equal(sandbox.xterm(), null, "隐藏期不创建 xterm 实例");
    assert.equal(state.terms.length, 0, "隐藏期不把 xterm 打开进宿主");
    assert.equal(state.eventSources.length, 0, "隐藏期不开 SSE 流");
    assert.deepEqual(state.posts, [], "隐藏期没有任何 resize/input POST——12×6 兜底尺寸不进 PTY");

    // 用户点开终端页：DOM 先可见，建流路径才放行
    sandbox.setViewHidden(false);
    sandbox.connect(backendSession("sess-a"));
    assert.ok(sandbox.xterm(), "可见期创建 xterm");
    assert.equal(sandbox.xterm().openedHost, sandbox.host(), "xterm 打开进终端页宿主");
    assert.equal(state.eventSources.length, 1, "可见期建立 SSE 流");
    assert.equal(resizePosts(state).length, 1, "建流后首帧 fit 恰好一次");
    assert.deepEqual(resizePosts(state)[0].body, { cols: 119, rows: 26 },
      "首帧按可见容器实测尺寸——回放不再按 12 列折行，提示符不碎");
  });

  it("流保持存活：离开终端页不断流，隐藏期的 fit 与窗口 resize 都不把兜底尺寸写进 PTY", () => {
    const { sandbox, state } = terminalGateSandbox({ viewHidden: false });
    sandbox.connect(backendSession("sess-a"));
    const term = sandbox.xterm();
    const source = sandbox.source();
    assert.equal(resizePosts(state).length, 1, "建流首帧一次 fit");

    // 用户切到别的页：流与实例保持存活（离开即断流的备选未采纳）
    sandbox.setViewHidden(true);
    sandbox.fit();
    sandbox.debounce();
    sandbox.flushTimers();
    assert.equal(sandbox.xterm(), term, "离开页面不销毁 xterm");
    assert.equal(sandbox.source(), source, "离开页面不断 SSE");
    assert.equal(resizePosts(state).length, 1, "隐藏期直接 fit 与防抖 resize 都不再 POST——兜底值不进 PTY");

    // 回到终端页：实例还在，补一次 fit 即按可见尺寸纠正
    sandbox.setViewHidden(false);
    sandbox.fit();
    const posts = resizePosts(state);
    assert.equal(posts.length, 2, "回页补一次 fit");
    assert.deepEqual(posts[1].body, { cols: 119, rows: 26 }, "回页补的 fit 按可见尺寸");
  });

  it("接线：进入终端页时建流（可见容器里创建 xterm），不再只补一次 fit", () => {
    const m = panelJs.match(/function switchView\(name\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(m, "switchView found in panel.js");
    const branch = m.slice(m.indexOf("if (terminal) {"));
    assert.ok(branch.includes("renderTerminalPreviewSession({ revive: false })"), "终端分支建流：xterm 在可见容器里创建再收全量回放");
    assert.ok(!branch.includes("renderTerminalPreviewSession();"), "回页补挂是被动重挂，不替用户重开已退会话");
  });

  it("剪贴板键位：裸 Ctrl+V 交还浏览器、Ctrl+C 有选中才交还复制，建流即回焦", () => {
    const { sandbox } = terminalGateSandbox({ viewHidden: false });
    sandbox.connect(backendSession("sess-a"));
    const term = sandbox.xterm();
    assert.ok(term.keyEventHandler, "xterm 实例挂了自定义键位处理器");
    assert.ok(term.focusCount >= 1, "建流后焦点回守终端（进页/切签/新建同一入口）");
    assert.equal(term.keyEventHandler({ type: "keydown", ctrlKey: true, key: "v" }), false, "裸 Ctrl+V 整体交还浏览器（原生粘贴 → xterm paste 通路 → PTY）");
    assert.equal(term.keyEventHandler({ type: "keydown", ctrlKey: true, key: "c" }), true, "无选中时 Ctrl+C 交回 xterm 照旧发中断");
    term.selection = true;
    assert.equal(term.keyEventHandler({ type: "keydown", ctrlKey: true, key: "c" }), false, "有选中时 Ctrl+C 交还浏览器 copy 事件（选中即复制）");
    assert.equal(term.keyEventHandler({ type: "keydown", ctrlKey: true, shiftKey: true, key: "C" }), true, "Ctrl+Shift+C 不接管，维持既有复制通路");
    assert.equal(term.keyEventHandler({ type: "keydown", ctrlKey: true, shiftKey: true, key: "V" }), true, "Ctrl+Shift+V 不接管，维持既有粘贴通路");
    assert.equal(term.keyEventHandler({ type: "keydown", ctrlKey: true, key: "x" }), true, "其余组合键交回 xterm 原语义");
    assert.equal(term.keyEventHandler({ type: "keyup", ctrlKey: true, key: "v" }), true, "keyup 不拦（xterm 自身的焦点自愈逻辑不受影响）");
  });

  it("宿主尺寸观察：inspector 收放等不经 window resize 的宽度变动也触发防抖 fit", () => {
    const { sandbox, state } = terminalGateSandbox({ viewHidden: false });
    sandbox.connect(backendSession("sess-a"));
    assert.equal(state.resizeObservers.length, 1, "xterm 打开进宿主后挂上 ResizeObserver");
    const observer = state.resizeObservers[0];
    assert.deepEqual(observer.observed, [sandbox.host()], "观察的是终端宿主元素");
    assert.equal(resizePosts(state).length, 1, "建流同步 fit 一次");

    // observe 的首次即时机不重复 POST（建流前的同步 fit 已量准）
    observer.cb();
    sandbox.flushTimers();
    assert.equal(resizePosts(state).length, 1, "首次即时机被跳过，不同尺寸重复 POST");

    // inspector 收起：宿主变宽（不经 window resize），防抖合并后按新实测尺寸纠正 PTY
    sandbox.setMeasured(96, 30);
    observer.cb();
    observer.cb();
    assert.equal(resizePosts(state).length, 1, "防抖窗口内不逐次 POST");
    sandbox.flushTimers();
    const posts = resizePosts(state);
    assert.equal(posts.length, 2, "静默期后补一次 resize");
    assert.deepEqual(posts[1].body, { cols: 96, rows: 30 }, "按变动后的实测尺寸纠正 PTY 列宽");
  });

  it("关流即摘观察器：旧宿主的尺寸变动不再触发 fit", () => {
    const { sandbox, state } = terminalGateSandbox({ viewHidden: false });
    sandbox.connect(backendSession("sess-a"));
    const observer = state.resizeObservers[0];
    sandbox.close();
    assert.equal(observer.disconnected, true, "关流时 disconnect 观察器");
  });

  it("resize POST 失败：短重试一次，成功即纠正（PTY 不再停在旧列宽）", async () => {
    const { sandbox, state } = terminalGateSandbox({ viewHidden: false });
    state.resizeFailures = 1;
    sandbox.connect(backendSession("sess-a"));
    await new Promise((r) => setTimeout(r, 0)); // 等首次 POST 的失败落定
    assert.equal(resizePosts(state).length, 1, "首次 POST 发出（被注入失败）");
    sandbox.flushTimers(); // 250ms 重试到场
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(resizePosts(state).length, 2, "失败后短重试一次");
    assert.deepEqual(resizePosts(state)[1].body, { cols: 119, rows: 26 }, "重试补上真实尺寸");
    assert.equal(state.warns.length, 0, "重试成功不告警");
  });

  it("resize 两次失败才告警；重试执行前用户已 resize 过的更新测量优先，旧重试不回溯", async () => {
    const twice = terminalGateSandbox({ viewHidden: false });
    twice.state.resizeFailures = 2;
    twice.sandbox.connect(backendSession("sess-a"));
    await new Promise((r) => setTimeout(r, 0));
    twice.sandbox.flushTimers();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(resizePosts(twice.state).length, 2, "最多重试一次，不无限重");
    assert.equal(twice.state.warns.length, 1, "两次都失败才告警（会话可能已关闭，属预期末路）");
    assert.ok(twice.state.warns[0].includes("resize failed"), "告警带 resize 关键词");

    const superseded = terminalGateSandbox({ viewHidden: false });
    superseded.state.resizeFailures = 1;
    superseded.sandbox.connect(backendSession("sess-a"));
    await new Promise((r) => setTimeout(r, 0));
    // 用户在重试到场前又改了窗口：新一次 fit 量到别的大小并成功
    superseded.sandbox.setMeasured(100, 30);
    superseded.sandbox.fit();
    superseded.sandbox.flushTimers(); // 旧重试到场：xterm 已换尺寸，跳过
    await new Promise((r) => setTimeout(r, 0));
    const posts = resizePosts(superseded.state);
    assert.equal(posts.length, 2, "旧重试被跳过，不发旧尺寸");
    assert.deepEqual(posts[1].body, { cols: 100, rows: 30 }, "PTY 停在更新后的实测尺寸，不回溯");
  });

  it("接线结构：新会话初始行列取实测尺寸、inspector 收放补 fit（TUI 溢我方修复）", () => {
    assert.equal((panelJs.match(/\.\.\.terminalCreateSize\(\)/g) || []).length, 2, "两处用户创建点（「+」菜单/一键启动）全部改用实测尺寸（首连自动补建已退役）");
    assert.ok(!panelJs.includes('shell: "powershell", cols: 120'), "创建入参不再硬编码列宽");
    const create = panelJs.match(/function terminalCreateSize\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(create, "terminalCreateSize found in panel.js");
    assert.ok(create.includes("terminalXterm.cols"), "有 xterm 实例时取其实测 cols/rows");
    const runCreate = new Function("terminalXterm", `${create}\nreturn terminalCreateSize;`);
    const withXterm = runCreate({ cols: 96, rows: 30 });
    assert.deepEqual(withXterm(), { cols: 96, rows: 30 });
    const fallback = runCreate(null);
    assert.deepEqual(fallback(), { cols: 120, rows: 34 }, "首装载入尚无实例才回落兜底值");
    const junk = runCreate({ cols: "x", rows: null });
    assert.deepEqual(junk(), { cols: 120, rows: 34 }, "实例尺寸异常时回落兜底");
    const init = panelJs.match(/function initTerminalPreview\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(init, "initTerminalPreview found in panel.js");
    const toggleAt = init.indexOf('$("terminalInspectorToggle").onclick');
    assert.ok(toggleAt > 0, "inspector 开关接线在位");
    const toggleBody = init.slice(toggleAt, init.indexOf('$("terminalRedrawBtn").onclick'));
    assert.ok(toggleBody.includes("scheduleTerminalFit()"), "inspector 收放即调度一次尺寸适配（±292px 不经 window resize）");
  });

  // 挂后台这一路：视图没被隐藏、隐藏的是整个窗口，上面那道视图闸管不到。实测真实
  // 行为：0×0 宿主让 FitAddon 把 xterm 收成 2 列 1 行且不会自己回弹；隐藏期字节照投
  // 递而解析被钳成每秒一片、rAF 零帧。下面三例分别钉住"塌陷尺寸不进 PTY""进后台即拆
  // 流""可见时绝不误拆、无事时拆流是空操作"。
  it("窗口最小化把宿主压成 0×0：既不缩放也不 POST，窗口恢复后按真实尺寸补一次", () => {
    const { sandbox, state } = terminalGateSandbox({ viewHidden: false });
    sandbox.connect(backendSession("sess-a"));
    const term = sandbox.xterm();
    assert.equal(resizePosts(state).length, 1, "建流首帧一次 fit");
    assert.equal(term.cols, 119, "首帧按可见尺寸");

    sandbox.setHostSize(0, 0); // 视口塌陷：宿主量得到 0×0，视图却没隐藏
    sandbox.fit();
    sandbox.debounce();
    sandbox.flushTimers();
    assert.equal(resizePosts(state).length, 1, "塌陷尺寸不 POST 进 PTY——TUI 不会被打成 2 列碎条");
    assert.equal(term.cols, 119, "xterm 行列不被塌陷测量改写");

    sandbox.setHostSize(1200, 600); // 窗口恢复：ResizeObserver / window resize 再叫一次
    sandbox.fit();
    assert.equal(resizePosts(state).length, 2, "恢复后照常按真实尺寸上报");
    assert.deepEqual(resizePosts(state)[1].body, { cols: 119, rows: 26 });
  });

  it("进后台即拆会话字节流：连接断开、实例销毁，未解析积压随实例一起清掉", () => {
    const { sandbox, state } = terminalGateSandbox({ viewHidden: false });
    sandbox.connect(backendSession("sess-a"));
    const term = sandbox.xterm();
    const source = sandbox.source();
    sandbox.setWindowHidden(true);
    sandbox.sync();
    assert.equal(source.closed, true, "SSE 断开：隐藏期不再收字节，宿主也不再为这个客户端堆缓冲");
    assert.equal(term.disposed, true, "xterm 实例随流销毁：WriteBuffer 里排队的旧字节不会被切回时一次成吨解析");
    assert.equal(sandbox.xterm(), null, "实例引用清空，回前台走新建实例重建");
    assert.equal(sandbox.source(), null, "流引用清空");
    assert.equal(state.terms.length, 1, "拆流不顺手新建实例");
  });

  it("可见时不误拆、无流时拆是空操作", () => {
    const { sandbox } = terminalGateSandbox({ viewHidden: false });
    sandbox.connect(backendSession("sess-a"));
    const source = sandbox.source();
    sandbox.setWindowHidden(false);
    sandbox.sync();
    assert.equal(source.closed, false, "正在看着的终端不被核拍收走");
    assert.notEqual(sandbox.xterm(), null, "实例保持存活");

    const idle = terminalGateSandbox({ viewHidden: false });
    idle.sandbox.setWindowHidden(true);
    idle.sandbox.sync();
    assert.equal(idle.state.terms.length, 0, "无实例无流：拆流不建、不报错");
    assert.equal(idle.state.eventSources.length, 0, "同上，没有连接被打开");
  });
});

// 输入法候选框抽搐：组字期间 xterm 内核每次渲染都把隐藏输入框改写到实时光标格，
// 与面板自己的逐帧拉回互抢，帧序随输出密度摆动。治本：锚点落位后写成 CSS 自定义
// 属性并挂 ime-hold 类，样式表 !important 让内核的内联改写视觉失效，不再逐帧抢写。
// 还停在屏幕外时不钉；组字结束摘类清属性。尺寸自适应在组字期间先记下，结束后补一次。
describe("虚拟终端组字期间输入法锚点不动", () => {
  function imeStyleStub() {
    return {
      left: "", top: "", width: "", height: "", lineHeight: "",
      props: {},
      setCalls: [],
      setProperty(k, v) { this.setCalls.push(k); this.props[k] = v; },
      removeProperty(k) { delete this.props[k]; },
    };
  }
  function imeClassListStub() {
    const set = new Set();
    return {
      add(c) { set.add(c); },
      remove(c) { set.delete(c); },
      contains(c) { return set.has(c); },
    };
  }
  function imeAnchorSandbox() {
    const bodies = ["terminalImeAnchorReady", "armTerminalImeAnchor", "releaseTerminalImeAnchor", "installTerminalImeAnchor"]
      .map((name) => {
        const src = panelJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
        assert.ok(src, `${name} found in panel.js`);
        return src;
      }).join("\n");
    const compositionView = { classList: imeClassListStub(), style: imeStyleStub() };
    const textarea = {
      isConnected: true,
      style: imeStyleStub(),
      classList: imeClassListStub(),
      listeners: {},
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      dispatch(type) { for (const fn of this.listeners[type] || []) fn(); },
      parentElement: { querySelector: (sel) => (sel === ".composition-view" ? compositionView : null) },
    };
    const term = {
      element: { querySelector: (sel) => (sel === ".xterm-helper-textarea" ? textarea : null) },
      rows: 30,
      // 无折叠桩：baseY=viewportY 偏移恒 0，折叠补正对本组既有断言透明
      buffer: { active: { baseY: 500, viewportY: 500, cursorY: 2 } },
    };
    const frames = [];
    let frameSeq = 0;
    const api = new Function("textarea", "term", `
      // IME 组字锚点状态在模块级平铺单值上。
      let terminalImeHold = null;
      let terminalImeHoldFrame = null;
      let terminalImeFitPending = false;
      let terminalImeAnchorTextarea = null;
      let terminalImeAnchorTerm = null;
      let terminalImeArmHandler = null;
      let terminalImeReleaseHandler = null;
      const frames = [];
      let frameSeq = 0;
      function requestAnimationFrame(cb) { const id = ++frameSeq; frames.push({ id, cb }); return id; }
      function cancelAnimationFrame(id) { const i = frames.findIndex((f) => f.id === id); if (i >= 0) frames.splice(i, 1); }
      ${bodies}
      return {
        install: () => installTerminalImeAnchor(term),
        flushFrame: () => { const frame = frames.shift(); if (frame) frame.cb(); },
        queuedFrames: () => frames.length,
      };
    `)(textarea, term);
    return { api, textarea, compositionView, term, frames };
  }

  it("组字期间锚点由样式表冻结：落位后挂类写自定义属性，不再逐帧改写，结束摘类清属性", () => {
    const { api, textarea, compositionView } = imeAnchorSandbox();
    api.install();
    textarea.style.left = "-9999em";
    textarea.style.top = "0px";
    textarea.style.width = "0px";
    textarea.style.height = "0px";
    textarea.dispatch("compositionstart");
    assert.ok(!textarea.classList.contains("ime-hold"), "还停在屏幕外：不钉");
    assert.equal(textarea.style.setCalls.length, 0, "未落位不写自定义属性");
    assert.equal(api.queuedFrames(), 1, "未落位留一帧重试");
    api.flushFrame();
    assert.ok(!textarea.classList.contains("ime-hold"), "重试时仍未落位：继续不钉");
    textarea.style.left = "48px";
    textarea.style.top = "64px";
    textarea.style.width = "16px";
    textarea.style.height = "18px";
    textarea.style.lineHeight = "18px";
    api.flushFrame();
    assert.ok(textarea.classList.contains("ime-hold"), "落位后挂上冻结类");
    assert.equal(textarea.style.props["--ime-hold-left"], "48px");
    assert.equal(textarea.style.props["--ime-hold-top"], "64px");
    assert.equal(textarea.style.props["--ime-hold-height"], "18px");
    assert.equal(textarea.style.props["--ime-hold-lineheight"], "18px");
    assert.equal(textarea.style.props["--ime-hold-width"], undefined, "宽度不钉：留给内核随拼音扩宽");
    const writes = (k) => textarea.style.setCalls.filter((c) => c === k).length;
    assert.equal(writes("--ime-hold-left"), 1, "每个自定义属性只写一次");
    assert.equal(writes("--ime-hold-top"), 1);
    assert.equal(writes("--ime-hold-height"), 1);
    assert.equal(writes("--ime-hold-lineheight"), 1);
    assert.ok(compositionView.classList.contains("ime-hold"), "组字预览块一并冻结");
    assert.equal(compositionView.style.props["--ime-hold-left"], "48px");
    assert.equal(compositionView.style.props["--ime-hold-top"], "64px");
    assert.equal(api.queuedFrames(), 0, "冻结靠样式表，不再注册逐帧 rAF");
    textarea.style.left = "900px";
    textarea.style.top = "2px";
    textarea.style.height = "40px";
    textarea.style.lineHeight = "40px";
    api.flushFrame();
    assert.equal(textarea.style.props["--ime-hold-left"], "48px", "内核改写内联位置不影响钉住值");
    assert.equal(writes("--ime-hold-left"), 1, "高频输出下也不重写自定义属性");
    assert.equal(api.queuedFrames(), 0, "高频输出下不再逐帧拉回");
    textarea.dispatch("compositionend");
    assert.ok(!textarea.classList.contains("ime-hold"), "结束摘类");
    assert.ok(!compositionView.classList.contains("ime-hold"), "预览块同步摘类");
    assert.deepEqual(textarea.style.props, {}, "自定义属性清空");
    assert.deepEqual(compositionView.style.props, {}, "预览块自定义属性清空");
    assert.equal(api.queuedFrames(), 0, "结束后没有任何排帧");
  });

  it("组字期间尺寸变化先不缩放，组字结束后补一次", () => {
    const fitSrc = panelJs.match(/function fitTerminalXterm\(\) \{[\s\S]*?\n  \}/)?.[0];
    const measurableSrc = panelJs.match(/function terminalHostMeasurable\(\) \{[\s\S]*?\n  \}/)?.[0];
    const fitFloorSrc = panelJs.match(/const TERMINAL_FIT_MIN_HOST_WIDTH_PX = \d+;[\s\S]{0,80}?const TERMINAL_FIT_MIN_HOST_HEIGHT_PX = \d+;/)?.[0];
    const releaseSrc = panelJs.match(/function releaseTerminalImeAnchor\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(fitSrc && releaseSrc && measurableSrc && fitFloorSrc);
    const state = { fits: 0 };
    const holdTextarea = { classList: imeClassListStub(), style: imeStyleStub() };
    const api = new Function("state", "holdTextarea", `
      // 组字挂起与补 fit 都是模块级平铺单值。
      let terminalXterm = { cols: 80, rows: 24 };
      const terminalFitAddon = { fit() { state.fits += 1; } };
      let terminalBoundSessionId = "sess-a";
      let terminalImeHold = null;
      let terminalImeHoldFrame = null;
      let terminalImeFitPending = false;
      let terminalImeAnchorTextarea = null;
      let terminalImeArmHandler = null;
      let terminalImeReleaseHandler = null;
      const $ = (id) => (id === "terminalXtermHost" ? { clientWidth: 1200, clientHeight: 600 } : { hidden: false });
      function terminalSessionFor() { return null; }
      function postTerminalResize() {}
      function cancelAnimationFrame() {}
      ${fitFloorSrc}
      ${measurableSrc}
      ${fitSrc}
      ${releaseSrc}
      return {
        fit: () => fitTerminalXterm(),
        hold: () => { terminalImeHold = { textarea: holdTextarea }; },
        release: () => releaseTerminalImeAnchor(),
      };
    `)(state, holdTextarea);
    api.fit();
    assert.equal(state.fits, 1, "平时缩放照常");
    api.hold();
    api.fit();
    api.fit();
    assert.equal(state.fits, 1, "组字期间连续缩放都不立刻重排");
    api.release();
    assert.equal(state.fits, 2, "组字结束后把记下的缩放补一次");
    api.fit();
    assert.equal(state.fits, 3, "放开后缩放恢复即时");
  });

  it("冻结规则挂在样式表：left/top/height/line-height 全部 !important，宽度故意不钉", () => {
    const rule = panelCss.match(/\.terminal-xterm-host \.xterm-helper-textarea\.ime-hold\s*\{[^}]*\}/)?.[0];
    assert.ok(rule, "ime-hold 规则存在");
    assert.match(rule, /left:\s*var\(--ime-hold-left\)\s*!important/, "left 钉住且压过内联写");
    assert.match(rule, /top:\s*var\(--ime-hold-top\)\s*!important/, "top 钉住且压过内联写");
    assert.match(rule, /height:\s*var\(--ime-hold-height\)\s*!important/, "height 钉住且压过内联写");
    assert.match(rule, /line-height:\s*var\(--ime-hold-lineheight\)\s*!important/, "line-height 钉住且压过内联写");
    assert.ok(!/(?<![-\w])width\s*:/.test(rule), "宽度不钉：caret 随拼音变长始终在框内");
    const viewRule = panelCss.match(/\.terminal-xterm-host \.xterm \.composition-view\.ime-hold\s*\{[^}]*\}/)?.[0];
    assert.ok(viewRule, "组字预览块的冻结规则存在");
    assert.match(viewRule, /left:\s*var\(--ime-hold-left\)\s*!important/);
    assert.match(viewRule, /top:\s*var\(--ime-hold-top\)\s*!important/);
  });

  it("隐藏输入框仍留在画面上：字和光标看不见，框本身不透明", () => {
    assert.match(panelCss, /\.terminal-xterm-host \.xterm-helper-textarea\s*\{[^}]*opacity:\s*1;/, "焦点框不再完全透明");
    const rule = panelCss.match(/\.terminal-xterm-host \.xterm-helper-textarea\s*\{[^}]*\}/)?.[0];
    assert.ok(rule?.includes("color: transparent"), "框里的字看不见");
    assert.ok(rule?.includes("caret-color: transparent"), "框里的光标看不见");
    assert.ok(rule?.includes("background: transparent"), "框底不盖住终端");
  });
});


// 终端字号调节：全局单一字号，10–24px 钳制，localStorage 记忆，
// 快捷键 Ctrl± 与 Ctrl+滚轮（仅在终端页生效）。纯函数在 vm 里真跑，
// 事件路径在桩环境里真跑（同 restoreView 先例）。
describe("终端字号调节（钳制 + 记忆 + 快捷键）", () => {
  async function vmFn(name, args, deps = []) {
    const source = [name, ...deps].map((fnName) => {
      const body = panelJs.match(new RegExp(`function ${fnName}\\([\\s\\S]*?\\n  \\}`))?.[0];
      assert.ok(body, `${fnName} found in panel.js`);
      return body;
    }).join("\n");
    const fn = await vm.runInNewContext(`(() => { ${source}; return ${name}; })()`, {});
    const result = fn(...args);
    return result === undefined || result === null ? result : JSON.parse(JSON.stringify(result));
  }

  // applyTerminalFontSize / nudgeTerminalFontSize / restoreTerminalFontSize 依赖
  // 模块态（terminalFontSize / terminalXterm / $ / fitTerminalXterm / localStorage），
  // 按文件先例抽出函数体放进桩环境真跑。
  function fontSizeSandbox(store = {}, withXterm = true) {
    const bodies = ["clampTerminalFontSize", "terminalFontSizeFromStored",
      "applyTerminalFontSize", "nudgeTerminalFontSize", "restoreTerminalFontSize"]
      .map((fnName) => {
        const src = panelJs.match(new RegExp(`function ${fnName}\\([\\s\\S]*?\\n  \\}`))?.[0];
        assert.ok(src, `${fnName} found in panel.js`);
        return src;
      }).join("\n");
    const state = { readout: { textContent: "13" }, fits: [], xterm: withXterm ? { options: { fontSize: 13 } } : null };
    const api = new Function("store", "state", `
      let terminalFontSize = 13;
      let terminalXterm = state.xterm;
      const localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
      };
      const $ = (id) => (id === "terminalFontSizeValue" ? state.readout : null);
      function fitTerminalXterm() { state.fits.push(terminalXterm.options.fontSize); }
      ${bodies}
      return {
        nudge: nudgeTerminalFontSize,
        restore: restoreTerminalFontSize,
        size: () => terminalFontSize,
      };
    `)(store, state);
    return { api, state, store };
  }

  it("clampTerminalFontSize 钳制边界、非数字回退 13", async () => {
    assert.equal(await vmFn("clampTerminalFontSize", [9]), 10);
    assert.equal(await vmFn("clampTerminalFontSize", [25]), 24);
    assert.equal(await vmFn("clampTerminalFontSize", [13]), 13);
    assert.equal(await vmFn("clampTerminalFontSize", ["abc"]), 13);
    assert.equal(await vmFn("clampTerminalFontSize", [undefined]), 13);
  });

  it("terminalFontSizeFromStored 非法值（非数字 / 越界）回退 13", async () => {
    assert.equal(await vmFn("terminalFontSizeFromStored", ["17"]), 17);
    assert.equal(await vmFn("terminalFontSizeFromStored", ["9"]), 13, "越界（偏小）回退");
    assert.equal(await vmFn("terminalFontSizeFromStored", ["25"]), 13, "越界（偏大）回退");
    assert.equal(await vmFn("terminalFontSizeFromStored", ["abc"]), 13, "非数字回退");
    assert.equal(await vmFn("terminalFontSizeFromStored", [""]), 13);
  });

  it("± 事件改字号：读数、xterm、localStorage 同步，越界处钳住", () => {
    const { api, state, store } = fontSizeSandbox();
    api.nudge(1);
    assert.equal(api.size(), 14);
    assert.equal(state.readout.textContent, "14", "读数同步");
    assert.equal(state.xterm.options.fontSize, 14, "已有 xterm 立即生效");
    assert.equal(store["panel-terminal-font-size"], "14", "每次改动写 localStorage");
    assert.deepEqual(state.fits, [14], "改动后重新 fit（底栏行列联动入口）");
    api.nudge(-1);
    api.nudge(-1);
    assert.equal(api.size(), 12);
    assert.equal(store["panel-terminal-font-size"], "12");
    for (let i = 0; i < 20; i++) api.nudge(-1);
    assert.equal(api.size(), 10, "下限钳在 10");
    for (let i = 0; i < 40; i++) api.nudge(1);
    assert.equal(api.size(), 24, "上限钳在 24");
  });

  it("restoreTerminalFontSize 读取记忆值应用，非法存储回退 13 且不回写", () => {
    const good = fontSizeSandbox({ "panel-terminal-font-size": "17" }, false);
    good.api.restore();
    assert.equal(good.api.size(), 17);
    assert.equal(good.state.readout.textContent, "17");
    const junk = fontSizeSandbox({ "panel-terminal-font-size": "abc" }, false);
    junk.api.restore();
    assert.equal(junk.api.size(), 13, "非数字回退 13");
    assert.equal(junk.store["panel-terminal-font-size"], "abc", "恢复路径不回写存储");
    const outOfRange = fontSizeSandbox({ "panel-terminal-font-size": "99" }, false);
    outOfRange.api.restore();
    assert.equal(outOfRange.api.size(), 13, "越界回退 13");
    const empty = fontSizeSandbox({}, false);
    empty.api.restore();
    assert.equal(empty.api.size(), 13, "无存储默认 13");
  });

  it("isTerminalFontZoomKey 只认 Ctrl±（含小键盘）", async () => {
    assert.equal(await vmFn("isTerminalFontZoomKey", [{ ctrlKey: true, key: "=" }]), 1);
    assert.equal(await vmFn("isTerminalFontZoomKey", [{ ctrlKey: true, key: "+" }]), 1);
    assert.equal(await vmFn("isTerminalFontZoomKey", [{ ctrlKey: true, code: "NumpadAdd" }]), 1);
    assert.equal(await vmFn("isTerminalFontZoomKey", [{ ctrlKey: true, key: "-" }]), -1);
    assert.equal(await vmFn("isTerminalFontZoomKey", [{ ctrlKey: true, code: "NumpadSubtract" }]), -1);
    assert.equal(await vmFn("isTerminalFontZoomKey", [{ key: "=" }]), 0, "无 Ctrl 不触发");
    assert.equal(await vmFn("isTerminalFontZoomKey", [{ ctrlKey: true, key: "0" }]), 0);
  });

  it("terminalClipboardKeyIntent 只认裸 Ctrl+C / Ctrl+V，组合键一律放行", async () => {
    assert.equal(await vmFn("terminalClipboardKeyIntent", [{ type: "keydown", ctrlKey: true, key: "v" }]), "paste");
    assert.equal(await vmFn("terminalClipboardKeyIntent", [{ type: "keydown", ctrlKey: true, key: "V" }]), "paste");
    assert.equal(await vmFn("terminalClipboardKeyIntent", [{ type: "keydown", ctrlKey: true, key: "c" }]), "copy");
    assert.equal(await vmFn("terminalClipboardKeyIntent", [{ type: "keydown", ctrlKey: true, key: "C" }]), "copy");
    assert.equal(await vmFn("terminalClipboardKeyIntent", [{ type: "keydown", ctrlKey: true, shiftKey: true, key: "C" }]), null, "Ctrl+Shift+C 不接管（放行浏览器复制）");
    assert.equal(await vmFn("terminalClipboardKeyIntent", [{ type: "keydown", ctrlKey: true, shiftKey: true, key: "V" }]), null, "Ctrl+Shift+V 不接管（放行粘贴为纯文本）");
    assert.equal(await vmFn("terminalClipboardKeyIntent", [{ type: "keydown", ctrlKey: true, altKey: true, key: "v" }]), null, "带 Alt 不接管");
    assert.equal(await vmFn("terminalClipboardKeyIntent", [{ type: "keydown", ctrlKey: true, metaKey: true, key: "v" }]), null, "带 Meta 不接管");
    assert.equal(await vmFn("terminalClipboardKeyIntent", [{ type: "keydown", key: "v" }]), null, "无 Ctrl 不触发");
    assert.equal(await vmFn("terminalClipboardKeyIntent", [{ type: "keydown", ctrlKey: true, key: "x" }]), null);
    assert.equal(await vmFn("terminalClipboardKeyIntent", [{ type: "keyup", ctrlKey: true, key: "v" }]), null, "只看 keydown");
    assert.equal(await vmFn("terminalClipboardKeyIntent", [null]), null, "空事件不炸");
    assert.equal(await vmFn("terminalClipboardKeyIntent", [{ type: "keydown", ctrlKey: true }]), null, "缺 key 字段不误判");
  });

  it("terminalNewlineEnterKey 认 keydown 与 keypress 两道的 Ctrl/Shift+Enter（含组字态），keyup 不认", async () => {
    assert.equal(await vmFn("terminalNewlineEnterKey", [{ type: "keydown", key: "Enter", ctrlKey: true }]), true, "Ctrl+Enter");
    assert.equal(await vmFn("terminalNewlineEnterKey", [{ type: "keydown", key: "Enter", shiftKey: true }]), true, "Shift+Enter");
    assert.equal(await vmFn("terminalNewlineEnterKey", [{ type: "keydown", key: "Enter", ctrlKey: true, shiftKey: true }]), true, "Ctrl+Shift+Enter 同属换行");
    assert.equal(await vmFn("terminalNewlineEnterKey", [{ type: "keypress", key: "Enter", shiftKey: true, keyCode: 13, charCode: 13 }]), true, "Shift+Enter 的 keypress 一并认（内核在这里补折叠 CR）");
    assert.equal(await vmFn("terminalNewlineEnterKey", [{ type: "keypress", key: "Enter", ctrlKey: true, keyCode: 13, charCode: 13 }]), true, "Ctrl+Enter 的 keypress 一并认");
    assert.equal(await vmFn("terminalNewlineEnterKey", [{ type: "keydown", key: "Enter", shiftKey: true, isComposing: true }]), true, "组字态也认：这条键任何时候都不许回内核求值");
    assert.equal(await vmFn("terminalNewlineEnterKey", [{ type: "keydown", key: "Enter", ctrlKey: true, keyCode: 229 }]), true, "keyCode 229 组字态也认");
    assert.equal(await vmFn("terminalNewlineEnterKey", [{ type: "keydown", key: "Enter" }]), false, "裸 Enter 不接管");
    assert.equal(await vmFn("terminalNewlineEnterKey", [{ type: "keypress", key: "Enter" }]), false, "裸 Enter 的 keypress 不接管（提交语义照旧）");
    assert.equal(await vmFn("terminalNewlineEnterKey", [{ type: "keydown", key: "Enter", altKey: true }]), false, "Alt+Enter 不接管（保留 xterm 的 Alt 语义）");
    assert.equal(await vmFn("terminalNewlineEnterKey", [{ type: "keydown", key: "Enter", ctrlKey: true, altKey: true }]), false, "Ctrl+Alt+Enter 不接管");
    assert.equal(await vmFn("terminalNewlineEnterKey", [{ type: "keydown", key: "Enter", shiftKey: true, metaKey: true }]), false, "带 Meta 不接管");
    assert.equal(await vmFn("terminalNewlineEnterKey", [{ type: "keyup", key: "Enter", ctrlKey: true }]), false, "keyup 不接管（只认 keydown/keypress）");
    assert.equal(await vmFn("terminalNewlineEnterKey", [{ type: "keydown", key: "j", ctrlKey: true }]), false, "非 Enter 键不接管");
    assert.equal(await vmFn("terminalNewlineEnterKey", [null]), false, "空事件不炸");
    assert.equal(await vmFn("terminalNewlineEnterKey", [{ type: "keydown", ctrlKey: true }]), false, "缺 key 字段不误判");
  });

  it("terminalNewlineDeliveryBlocked 只在组字态与兜底已处理时挡住投递", async () => {
    assert.equal(await vmFn("terminalNewlineDeliveryBlocked", [{ type: "keydown", key: "Enter", shiftKey: true }]), false, "非组字态照常投递");
    assert.equal(await vmFn("terminalNewlineDeliveryBlocked", [{ type: "keydown", key: "Enter", shiftKey: true, isComposing: true }]), true, "isComposing 挡住");
    assert.equal(await vmFn("terminalNewlineDeliveryBlocked", [{ type: "keydown", key: "Enter", ctrlKey: true, keyCode: 229 }]), true, "keyCode 229 挡住");
    assert.equal(await vmFn("terminalNewlineDeliveryBlocked", [{ type: "keydown", key: "Enter", ctrlKey: true, defaultPrevented: true }]), true, "兜底转发投过的挡住（一次按键只有一个换行）");
    assert.equal(await vmFn("terminalNewlineDeliveryBlocked", [null]), false, "空事件不炸");
  });

  it("接线结构：剪贴板键位交还浏览器、焦点四路回守、死焦点调用已清除", () => {
    const ensure = panelJs.match(/function ensureTerminalXterm\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(ensure?.includes("term.attachCustomKeyEventHandler("), "每个 xterm 实例挂自定义键位处理器");
    assert.ok(ensure?.includes('if (intent === "paste") return false;'), "裸 Ctrl+V 整体交还浏览器（原生粘贴 → xterm paste 通路 → PTY）");
    assert.ok(ensure?.includes('if (intent === "copy" && term.hasSelection()) return false;'), "裸 Ctrl+C 有选中才交还复制，无选中交回 xterm 发中断");
    const connect = panelJs.match(/async function connectTerminalStream\(session, \{ revive[^)]*\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(connect?.includes("term.focus()"), "建流（进页/切签/新建/降级重试）后焦点回守");
    assert.ok(panelJs.includes("terminalXterm?.focus()"), "字号 ± 与终端屏点击后焦点回守（唯一 xterm 实例收口）");
    assert.ok(panelJs.includes("else terminalXterm.focus();"), "重进终端页（实例尚存）也回焦");
    assert.ok(!panelJs.includes("terminalCommandInput"), "聚焦不存在输入框的死调用已清除");
  });

  it("接线结构：按钮组落在重画按钮左侧、xterm 初始字号取记忆值、快捷键只在终端页生效", () => {
    const actions = panelHtml.slice(panelHtml.indexOf('class="terminal-session-actions"'), panelHtml.indexOf('id="terminalRedrawBtn"'));
    assert.ok(actions.includes('id="terminalFontDecBtn"'), "− 按钮在重画按钮左侧");
    assert.ok(actions.includes('id="terminalFontSizeValue"'), "字号读数在重画按钮左侧");
    assert.ok(actions.includes('id="terminalFontIncBtn"'), "+ 按钮在重画按钮左侧");
    const ensure = panelJs.match(/function ensureTerminalXterm\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(ensure?.includes("fontSize: terminalFontSize"), "新建 xterm 实例使用记住的字号");
    const apply = panelJs.match(/function applyTerminalFontSize\(size[\s\S]*?\n  \}/)?.[0];
    assert.ok(apply?.includes("fitTerminalXterm()"), "字号变更后重新 fit，底栏行列随 resize 联动");
    assert.ok(panelJs.includes('if (currentView !== "terminal") return;'), "快捷键路径只在终端页激活态生效");
    const init = panelJs.match(/function initTerminalPreview\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(init?.includes("restoreTerminalFontSize()"), "终端页初始化即恢复记忆字号");
    assert.ok(panelJs.includes('localStorage.setItem("panel-terminal-font-size"'), "持久化键沿用 panel- 前缀");
  });
});

// 「重画终端画面」按钮：画面看着不对时的兜底入口。它做两件事——先把宽度挤掉一列
// 再恢复，逼 agent 整屏重画（手动调字号能救回来就是这个道理）；再重建客户端画面，
// 让客户端拿到后端镜像的整屏回放。旧按钮调的是终端的 clear()，那会真的删掉滚动
// 历史，只是顺带触发一次重绘。
describe("终端重画按钮（挤宽度让 agent 重画 + 重建客户端画面）", () => {
  const redrawSource = () => {
    const body = panelJs.match(/const TERMINAL_REDRAW_NUDGE_MS = \d+;\n  function redrawTerminalScreen\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(body, "redrawTerminalScreen found in panel.js");
    return body;
  };

  function sandbox(term, session) {
    const calls = { posted: [], rebuilt: 0, timers: [] };
    const api = new Function("term", "session", "calls", `
      let terminalXterm = term;
      let activeTerminalPreviewId = "s1";
      function terminalSessionFor() { return session; }
      function postTerminalResize(s, cols, rows) { calls.posted.push([cols, rows]); }
      function connectTerminalStream() { calls.rebuilt += 1; }
      function setTimeout(fn, ms) { calls.timers.push({ fn, ms }); return calls.timers.length; }
      ${redrawSource()}
      return {
        redraw: redrawTerminalScreen,
        flushTimers: () => { for (const t of calls.timers.splice(0)) t.fn(); },
        swapTerm: (next) => { terminalXterm = next; },
      };
    `)(term, session, calls);
    return { api, calls };
  }

  const makeTerm = () => ({
    cols: 100, rows: 30, resized: [],
    resize(cols, rows) { this.resized.push([cols, rows]); this.cols = cols; this.rows = rows; },
  });

  it("接线结构：按钮改叫重画、旧清空调用已下线", () => {
    assert.ok(!panelHtml.includes("terminalClearBtn"), "旧的清空按钮已下线");
    assert.ok(panelHtml.includes('id="terminalRedrawBtn"'), "重画按钮在位");
    assert.ok(panelHtml.includes('title="重画终端画面"') && panelHtml.includes('aria-label="重画终端画面"'),
      "文案用产品语义：重画终端画面");
    assert.ok(panelJs.includes('$("terminalRedrawBtn").onclick'), "重画按钮已接线");
    assert.ok(!panelJs.includes("terminalXterm?.clear()"), "不得再调终端的 clear()：那会真的删掉滚动历史");
  });

  it("有后端：先挤掉一列并 POST，留一拍再重建客户端画面", () => {
    const term = makeTerm();
    const { api, calls } = sandbox(term, { id: "s1", backend: {} });
    api.redraw();
    assert.deepEqual(term.resized, [[99, 30]], "先把宽度挤掉一列");
    assert.deepEqual(calls.posted, [[99, 30]], "PTY 必须跟着缩：只改 PTY 会让 agent 按新列宽排版、客户端按旧列宽渲染");
    assert.equal(calls.rebuilt, 0, "挤宽度这一拍先不重建：两次尺寸变化挨太近会被合成一次，agent 就不重画了");
    assert.ok(calls.timers[0].ms >= 100, "留一拍再恢复");
    api.flushTimers();
    assert.equal(calls.rebuilt, 1, "恢复那一拍重建客户端画面，重建时的 fit 会把真实尺寸 POST 回去");
  });

  it("挤宽度期间终端实例已换：恢复那一拍不再动别人的屏", () => {
    const term = makeTerm();
    const { api, calls } = sandbox(term, { id: "s1", backend: {} });
    api.redraw();
    api.swapTerm(makeTerm());
    api.flushTimers();
    assert.equal(calls.rebuilt, 0, "实例已换，旧定时器不得再重建");
  });

  it("预览会话没有 PTY 可挤：直接重建客户端画面", () => {
    const term = makeTerm();
    const { api, calls } = sandbox(term, { id: "p1", backend: null });
    api.redraw();
    assert.deepEqual(term.resized, [], "预览会话不挤宽度");
    assert.deepEqual(calls.posted, [], "预览会话不 POST 尺寸");
    assert.equal(calls.rebuilt, 1, "预览会话直接重建客户端画面");
  });

  it("终端页未建流（没有实例）时什么都不做", () => {
    const { api, calls } = sandbox(null, { id: "s1", backend: {} });
    api.redraw();
    assert.equal(calls.rebuilt, 0);
    assert.deepEqual(calls.posted, []);
  });
});
// 终端渲染行为性能三钉（纯机械行为改造，用户可见文案与 DOM 结构不动）：
// ①空壳塌缩防抖——归属轮询在归属丢失/恢复的边界会闪一帧空 agent，原逻辑当拍
// 即把侧栏收拢 340↔48px、下一拍又展开，宽度跳变逼终端区整屏重排（用户看到的
// 「抽搐」）；改为同一会话连续 3 拍都空壳才自动塌缩，归属恢复当拍清零。②fit
// 同尺寸跳过——fit 后尺寸与 PTY 侧已知值一致时跳过 resize POST（TUI 收到同值
// resize 也要整屏重排一次）。③两处每拍重建的 innerHTML（页签栏 / 请求行）改
// 整串指纹比对，相同即跳过赋值（DOM 零写）。结构用源码钉，行为在桩环境真跑。
describe("终端渲染行为性能（塌缩防抖 / 同尺寸跳过 / innerHTML 指纹门控）", () => {
  const extractFn = (name) => {
    const src = panelJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
    assert.ok(src, `${name} found in panel.js`);
    return src;
  };

  it("塌缩防抖结构：按会话 id 连拍计数、阈值 3、计数跟归属数据拍走，归属恢复/会话关闭清零；锁存语义原样", () => {
    const render = extractFn("renderTerminalSessionData");
    assert.ok(/const TERMINAL_HOLLOW_COLLAPSE_STREAK = 3;/.test(panelJs), "阈值常量钉在 3（闪断一帧不算塌缩证据）");
    assert.ok(/const terminalHollowStreak = new Map\(\);/.test(panelJs), "计数表按会话 id 存模块级 Map");
    // 计数在归属数据拍（会话表重建）推进、渲染只读阈值：SSE 活动帧整渲不推进
    //（评审修正——原实现计数随渲染递增，多开时他端活跃亚秒凑满 3 拍，防抖窗口名存实亡）
    const rebuild = extractFn("rebuildTerminalBackendSessions");
    assert.ok(rebuild.includes("terminalHollowStreak.set(session.id"), "表重建（1s 轮询 / 连接）时空壳会话计数 +1");
    assert.ok(rebuild.includes("if (session.agent) terminalHollowStreak.delete(session.id)"), "归属观测拍清零计数（闪断不累积）");
    assert.ok(render.includes("terminalHollowStreak.get(session.id)"), "渲染读连续计数判阈值");
    assert.ok(!render.includes("terminalHollowStreak.set"), "渲染不递增计数——SSE 活动帧整渲不带新归属数据，计数跟数据拍走不跟渲染走");
    assert.ok(render.includes(">= TERMINAL_HOLLOW_COLLAPSE_STREAK"), "计数到阈值才走自动塌缩分支（阈值前保持当前形态）");
    assert.ok(render.includes("terminalHollowStreak.delete(session.id)"), "归属恢复渲染兜底清零计数");
    // 两条既有锁存语义原样：防抖只改塌缩触发时机
    assert.ok(render.includes("terminalInspectorUserPinned.has(session.id)"), "用户钉住判定先于阈值（拉回后轮询不收拢）");
    assert.ok(render.includes("terminalInspectorHollowCollapsed = true"), "系统收拢标记仍只在自动塌缩分支落");
    // 会话关闭清零的三个入口：本地关标签 / 轮询重建（别处关掉）/ 关停清场
    const init = extractFn("initTerminalPreview");
    const closeAt = init.indexOf('event.target.closest(".terminal-tab-close")');
    assert.ok(closeAt > 0, "关标签分支可取样");
    const closeBranch = init.slice(closeAt, init.indexOf("remaining.length === 0"));
    assert.ok(closeBranch.includes("terminalHollowStreak.delete(id)"), "关标签同步清该会话计数");
    assert.ok(rebuild.includes("pruneTerminalHollowStreak()"), "轮询整表换血后清掉已消失会话的计数");
    assert.ok(extractFn("clearTerminalLocalSessions").includes("pruneTerminalHollowStreak()"),
      "关停清场同样清计数（后端会话全数失效）");
    assert.ok(extractFn("pruneTerminalHollowStreak").includes("!terminalBackendSessions[id] && !terminalPreviewSessions[id]"),
      "只清两张会话表都不认的 id（切页签、换窗口不清）");

    // 桩环境真跑拍计数：计数跟归属观测走——闪断清零、连续空壳累积、会话消失即清
    const bodies = ["storedTerminalSessionId", "rememberTerminalSessionId",
      "terminalBackendSession", "rebuildTerminalBackendSessions", "pruneTerminalHollowStreak"]
      .map(extractFn).join("\n");
    const store = {};
    const counter = new Function("store", `
      let activeTerminalPreviewId = "t1";
      let terminalBackendSessions = {};
      let terminalDefaultCwd = "C:\\\\";
      const terminalHollowStreak = new Map();
      const terminalPreviewSessions = {};
      const localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = v; },
        removeItem: (k) => { delete store[k]; },
      };
      ${bodies}
      return {
        beat: (items) => rebuildTerminalBackendSessions(items),
        streak: (id) => terminalHollowStreak.get(id) || 0,
      };
    `)(store);
    const attributed = [{ id: "t1", shell: "powershell", agent: { endpointId: "k", name: "K", pid: 1, instanceId: "k-1" } }];
    const hollow = [{ id: "t1", shell: "powershell" }];
    counter.beat(hollow);
    assert.equal(counter.streak("t1"), 1, "空壳观测拍 +1");
    counter.beat(attributed);
    assert.equal(counter.streak("t1"), 0, "归属恢复的观测拍清零（闪断不累积）");
    counter.beat(hollow);
    counter.beat(hollow);
    assert.equal(counter.streak("t1"), 2, "连续两拍空壳计 2（未到阈值）");
    counter.beat(hollow);
    assert.equal(counter.streak("t1"), 3, "连续第三拍计 3（到阈值）");
    counter.beat([]);
    assert.equal(counter.streak("t1"), 0, "会话从表中消失（别处关掉）即清计数");
  });

  it("fit 同尺寸跳过：与 PTY 侧已知尺寸一致时不 POST，拿不到/不完整/不一致照旧（保守）", () => {
    const fit = extractFn("fitTerminalXterm");
    assert.ok(fit.includes("terminalFitAddon?.fit();"), "fit 本身照跑（客户端重排不靠 POST 陪跑）");
    assert.ok(fit.includes("session.backendState"), "以会话的 PTY 侧已知尺寸为比对基准");
    assert.ok(fit.includes("postTerminalResize(session, terminalXterm.cols, terminalXterm.rows)"),
      "比对不过照旧 POST（保守：宁可多一次对齐，不漏一次）");
    // 挤一列再恢复的重画链不经这道闸：直接调 postTerminalResize，链上尺寸本就不同
    const redraw = panelJs.match(/const TERMINAL_REDRAW_NUDGE_MS = \d+;\n  function redrawTerminalScreen\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(redraw?.includes("postTerminalResize(session, cols - 1, rows)"), "重画挤宽度链不经 fit 闸");

    // 桩环境真跑四种形态：backendState 缺失 / 完整且一致 / 不一致 / 不完整
    const bodies = ["fitTerminalXterm", "terminalHostMeasurable", "postTerminalResize"].map(extractFn).join("\n");
    const fitFloorSrc = panelJs.match(/const TERMINAL_FIT_MIN_HOST_WIDTH_PX = \d+;[\s\S]{0,80}?const TERMINAL_FIT_MIN_HOST_HEIGHT_PX = \d+;/)?.[0];
    assert.ok(fitFloorSrc, "窗口级尺寸闸下限可从 panel.js 取到（测试不抄数字）");
    const state = { posts: [], measured: { cols: 119, rows: 26 }, session: { id: "s1", backend: true, backendState: null } };
    const makeFit = () => new Function("state", `
      const API_BASE = "http://panel.test";
      let terminalXterm = { cols: 0, rows: 0 };
      let terminalFitAddon = {
        fit() { terminalXterm.cols = state.measured.cols; terminalXterm.rows = state.measured.rows; },
      };
      let terminalBoundSessionId = "s1";
      let terminalImeHold = null;
      let terminalImeFitPending = false;
      const view = { hidden: false };
      const host = { clientWidth: 1200, clientHeight: 600 };
      const $ = (id) => (id === "terminalView" ? view : id === "terminalXtermHost" ? host : null);
      const terminalReviveInflight = new Map();
      const api = (method, url, body) => { state.posts.push({ method, url, body }); return Promise.resolve({}); };
      function terminalSessionFor(id) { return state.session; }
      ${fitFloorSrc}
      ${bodies}
      return () => fitTerminalXterm();
    `)(state);
    const resizePosts = () => state.posts.filter((p) => p.method === "POST" && p.url.includes("/resize"));
    const fitFn = makeFit();

    fitFn();
    assert.equal(resizePosts().length, 1, "backendState 拿不到时照旧 POST（保守）");

    state.session.backendState = { cols: 119, rows: 26 };
    fitFn();
    assert.equal(resizePosts().length, 1, "fit 后尺寸与 PTY 侧一致 → 跳过这次 POST");

    state.measured = { cols: 96, rows: 30 };
    fitFn();
    assert.equal(resizePosts().length, 2, "实测变了 → 照常 POST");
    assert.deepEqual(resizePosts()[1].body, { cols: 96, rows: 30 }, "POST 的是 fit 后的新尺寸");

    state.session.backendState = { cols: 96 };
    fitFn();
    assert.equal(resizePosts().length, 3, "backendState 不完整（缺 rows）照旧 POST");
  });

  it("innerHTML 指纹门控：整串相同即零写，active 态/内容/展开态变化照常写入", () => {
    // 结构钉：两处渲染各带一份指纹缓存；三处直写清空的退场路径同步重置指纹
    assert.ok(extractFn("renderTerminalPreviewTabs").includes("terminalTabsRenderedHtml"), "页签栏渲染带指纹缓存");
    assert.ok(extractFn("renderTerminalSessionData").includes("terminalRequestListRenderedHtml"), "请求行渲染带指纹缓存");
    for (const name of ["renderTerminalPendingState", "renderTerminalUnavailableState", "clearTerminalLocalSessions"]) {
      assert.ok(extractFn(name).includes('terminalTabsRenderedHtml = "";'),
        `${name} 直写清空同步重置指纹（保住「指纹 = DOM 现值」不变式）`);
    }

    // 桩环境真跑页签栏：同内容第二拍零写；active 态与内容变化照常写入
    const escapeHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const tabsWrites = [];
    const tabsEl = { set innerHTML(v) { tabsWrites.push(v); } };
    const sessions = {
      t1: { label: "新终端", shell: { name: "PowerShell" }, agentName: null, agent: null, status: "idle" },
    };
    const tabsApi = new Function("$", "escapeHtml", "sessions", `
      let activeTerminalPreviewId = "t1";
      let terminalTabsRenderedHtml = "";
      const TERMINAL_RAIL_SPINNER = '<span class="rail-term-spinner">SPINNER-STUB</span>';
      function terminalSessionMap() { return sessions; }
      ${extractFn("renderTerminalPreviewTabs")}
      return { render: renderTerminalPreviewTabs, setActive: (id) => { activeTerminalPreviewId = id; } };
    `)((id) => (id === "terminalTabs" ? tabsEl : null), escapeHtml, sessions);
    tabsApi.render();
    tabsApi.render();
    assert.equal(tabsWrites.length, 1, "稳态第二拍跳过赋值（DOM 零写）");
    sessions.t1.status = "working";
    tabsApi.render();
    assert.equal(tabsWrites.length, 2, "内容（工作/空闲态）变化照常写入");
    tabsApi.setActive("t2");
    tabsApi.render();
    assert.equal(tabsWrites.length, 3, "active 态在串里，切活动标签即指纹变化");
    sessions.t1.status = "idle";
    tabsApi.setActive("t1");
    tabsApi.render();
    assert.equal(tabsWrites.length, 4, "串回到旧值也照常写入（指纹只认「与上次相同」）");

    // 桩环境真跑请求行：同请求列表零写；展开态（在串里）变化照常写入
    const state = { session: null, requestWrites: [] };
    const requestList = {
      html: "",
      set innerHTML(v) { state.requestWrites.push(v); this.html = v; },
      get innerHTML() { return this.html; },
    };
    const dataApi = new Function("state", "requestList", `
      const elCache = {};
      const el = (id) => elCache[id] ??= {
        textContent: "", title: "", hidden: false, style: {}, className: "",
        classes: new Set(),
        classList: {
          add: (c) => elCache[id].classes.add(c),
          remove: (c) => elCache[id].classes.delete(c),
          contains: (c) => elCache[id].classes.has(c),
          toggle: (c, on) => { if (on === undefined) on = !elCache[id].classes.has(c); if (on) elCache[id].classes.add(c); else elCache[id].classes.delete(c); return on; },
        },
        setAttribute() {},
        getAttribute: () => null,
      };
      const $ = (id) => (id === "terminalRequestList" ? requestList : el(id));
      let activeTerminalPreviewId = "s1";
      const terminalSessionFor = () => state.session;
      const terminalRequestExpanded = new Set();
      let terminalInspectorHollowCollapsed = false;
      const terminalInspectorUserPinned = new Set();
      const TERMINAL_HOLLOW_COLLAPSE_STREAK = 3;
      const terminalHollowStreak = new Map();
      let terminalRequestListRenderedHtml = "";
      function scheduleTerminalFit() {}
      function updateSparkline() {}
      function routeNodeName(x) { return x; }
      function terminalServingLabel() { return ""; }
      function terminalRequestItemHtml(req, opts) { return \`<div>\${req.key}\${opts.expanded ? "+e" : ""}</div>\`; }
      ${extractFn("renderTerminalSessionData")}
      return {
        render: renderTerminalSessionData,
        expand: (key) => terminalRequestExpanded.add(key),
      };
    `)(state, requestList);
    state.session = {
      id: "s1", label: "L", cwd: "C:\\", branch: "", shell: { name: "PowerShell" },
      status: "idle", metrics: null, agent: { endpointId: "k", name: "K", pid: 1, instanceId: "k-1" },
      requests: [{ key: "r1", provider: "p", state: "ok" }],
    };
    dataApi.render();
    dataApi.render();
    assert.equal(state.requestWrites.length, 1, "同请求列表第二拍跳过赋值（DOM 零写）");
    dataApi.expand("r1");
    dataApi.render();
    assert.equal(state.requestWrites.length, 2, "展开态在串里，展开变化照常写入");
    assert.ok(state.requestWrites[1].includes("r1+e"), "第二笔带展开态内容");
    dataApi.render();
    assert.equal(state.requestWrites.length, 2, "展开态稳态后回到零写");
  });
});

// 活跃真值推送：panel 侧长驻订阅 relay 的 /api/internal/agents-activity，缓存
// (endpointId, instanceId) 最新在途状态；浏览器经 /panel/api/agents-activity 建连
// 先拿缓存快照、其后收转发事件；前端把帧按真值键落到终端标签圆点与实况行。
// 与 panel-log-bridge 同路取证：桥硬编码 47821，测试用假 fetch 喂流直读真代码。
describe("活跃真值推送桥（缓存 / 浏览器出口 / 前端应用）", () => {
  async function vmFn(name, args, deps = []) {
    const source = [name, ...deps].map((fnName) => {
      const body = panelJs.match(new RegExp(`function ${fnName}\\([\\s\\S]*?\\n  \\}`))?.[0];
      assert.ok(body, `${fnName} found in panel.js`);
      return body;
    }).join("\n");
    const fn = await vm.runInNewContext(`(() => { ${source}; return ${name}; })()`, {});
    const result = fn(...args);
    return result === undefined || result === null ? result : JSON.parse(JSON.stringify(result));
  }

  it("桥：snapshot 整帧建缓存、activity 定点更新、心跳注释直通、坏行跳过", async () => {
    const lines = [
      `data: ${JSON.stringify({ type: "snapshot", instances: [
        { endpointId: "kimi", instanceId: "kimi-4321", activeRequests: 2, at: 100 },
        { endpointId: "codex", instanceId: null, activeRequests: 1, at: 101 },
      ] })}\n\n`,
      `data: ${JSON.stringify({ type: "activity", endpointId: "kimi", instanceId: "kimi-4321", activeRequests: 0, at: 102 })}\n\n`,
      ": keepalive\n\n",
      "data: {not json}\n\n",
      `data: ${JSON.stringify({ type: "activity", endpointId: "kimi", instanceId: "kimi-9999", activeRequests: 3, at: 103 })}\n\n`,
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(stream, { status: 200 });

    const received = [];
    const root = mkTestDir("anyswitch-activity-bridge-");
    let bridge;
    try {
      loadOrGenerateToken(root);
      bridge = startRelayActivityBridge(root);
      bridge.subscribe((block) => received.push(block));

      const deadline = Date.now() + 3000;
      while (received.length < 4 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }

      assert.equal(received.length, 4, "3 条 data + 1 条心跳注释全部送达");
      assert.equal(received.filter((b) => b.startsWith("data:")).length, 3, "snapshot + 两帧 activity 转发");
      assert.ok(received.some((b) => b === ": keepalive\n\n"), "心跳注释行直通");
      assert.ok(!received.some((b) => b.includes("not json")), "坏行被跳过且不杀流");
      const frame = JSON.parse(received[0].slice(5));
      assert.equal(frame.type, "snapshot", "第一帧是快照（推送顺序落地）");

      // 缓存：snapshot 建表 → activity 定点归零 kimi-4321 → kimi-9999 独立落键不互踩。
      assert.deepEqual(bridge.snapshotFrame(), {
        type: "snapshot",
        instances: [
          { endpointId: "kimi", instanceId: "kimi-4321", activeRequests: 0, at: 102 },
          { endpointId: "codex", instanceId: null, activeRequests: 1, at: 101 },
          { endpointId: "kimi", instanceId: "kimi-9999", activeRequests: 3, at: 103 },
        ],
      });
    } finally {
      bridge?.stop();
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("桥：relay 不可达时退避重试、stop 干净", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      throw new Error("ECONNREFUSED");
    };
    const root = mkTestDir("anyswitch-activity-down-");
    let bridge;
    try {
      loadOrGenerateToken(root);
      bridge = startRelayActivityBridge(root);
      await new Promise((r) => setTimeout(r, 120));
      assert.ok(attempts >= 1, "桥会尝试建连");
      assert.deepEqual(bridge.snapshotFrame(), { type: "snapshot", instances: [] }, "未连上时缓存为空快照");
      bridge.stop();
      const atStop = attempts;
      await new Promise((r) => setTimeout(r, 1100));
      assert.equal(attempts, atStop, "stop 后不再重试");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("路由：/panel/api/agents-activity 建连先发缓存快照、其后转发订阅事件", async () => {
    let subscribed = null;
    const bridge = {
      snapshotFrame: () => ({ type: "snapshot", instances: [{ endpointId: "kimi", instanceId: "kimi-4321", activeRequests: 2, at: 100 }] }),
      subscribe: (fn) => { subscribed = fn; return () => {}; },
    };
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => null,
      agentsActivityBridge: bridge,
    });
    const { req, res } = fakeReqRes("/panel/api/agents-activity", "GET");
    res.write = (chunk) => { res.body += chunk; return true; };
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "text/event-stream");
    assert.match(res.body, /data: \{"type":"snapshot","instances":\[\{"endpointId":"kimi","instanceId":"kimi-4321","activeRequests":2,"at":100\}\]\}\n\n/,
      "建连即收桥缓存的当前快照帧");
    assert.ok(subscribed, "建连挂上桥订阅");
    const forward = `data: ${JSON.stringify({ type: "activity", endpointId: "kimi", instanceId: "kimi-4321", activeRequests: 0, at: 101 })}\n\n`;
    subscribed(forward);
    assert.ok(res.body.endsWith(forward), "桥事件逐帧转发");
  });

  it("前端：terminalActivityApplyToSession 口径（>0 working / 0 idle / 明细即时）", async () => {
    const session = { status: "idle", metrics: { activeRequests: 0, ttft: "—" } };
    await vmFn("terminalActivityApplyToSession", [session, 2], ["terminalBusyByOutput"]);
    assert.equal(session.status, "working");
    assert.equal(session.metrics.activeRequests, 2, "「N 个请求进行中」明细用真值即时更新");
    await vmFn("terminalActivityApplyToSession", [session, 0], ["terminalBusyByOutput"]);
    assert.equal(session.status, "idle");
    assert.equal(session.metrics.activeRequests, 0);
    const bare = { status: "idle", metrics: null };
    await vmFn("terminalActivityApplyToSession", [bare, 5], ["terminalBusyByOutput"]);
    assert.equal(bare.status, "working");
    assert.equal(bare.metrics, null, "metrics 未富化出来时不编造空指标行");
  });

  it("前端：输出活跃窗补 LLM 请求盲区（跑长命令不再显示空闲）", async () => {
    // 请求 0 但终端刚出过字：在跑命令（LLM 空档是执行工具命令的常态）。
    const hot = { status: "idle", metrics: null, backendState: { lastActiveAt: Date.now() - 1000, status: "running" } };
    await vmFn("terminalActivityApplyToSession", [hot, 0], ["terminalBusyByOutput"]);
    assert.equal(hot.status, "working", "1s 前还在出字：在跑");
    // 静默超窗回落空闲；请求在途与输出活跃是 OR 关系（活跃窗不吞请求真值）。
    const cold = { status: "working", metrics: { activeRequests: 0 }, backendState: { lastActiveAt: Date.now() - 60_000, status: "running" } };
    await vmFn("terminalActivityApplyToSession", [cold, 0], ["terminalBusyByOutput"]);
    assert.equal(cold.status, "idle", "静默超窗回落空闲");
    const both = { status: "idle", metrics: null, backendState: { lastActiveAt: Date.now() - 60_000, status: "running" } };
    await vmFn("terminalActivityApplyToSession", [both, 1], ["terminalBusyByOutput"]);
    assert.equal(both.status, "working", "请求在途照常 working（窗不吞请求真值）");
    // exited 不因退出瞬间的 lastActiveAt 刷新而误转圈。
    const dead = { status: "idle", metrics: null, backendState: { lastActiveAt: Date.now(), status: "exited" } };
    await vmFn("terminalActivityApplyToSession", [dead, 0], ["terminalBusyByOutput"]);
    assert.equal(dead.status, "idle", "exited 不转圈");
  });

  it("前端：terminalBusyByOutput 四输入面（出生零输出／键入抑制／孵化豁免／请求穿透）", async () => {
    // 时刻注入固定值，四个面全按相对时刻构造，不依赖墙钟。
    const now = 1_000_000;
    const busy = (backendState) => vmFn("terminalBusyByOutput", [{ backendState }, 5000, now]);
    // 面 1：出生零输出不忙——宿主不再播种 lastActiveAt，刚打开的空会话不转圈、
    // M12 内切门按 idle 就地换内容（不再保护性新开）。
    assert.equal(await busy({ status: "running", createdAt: now - 1000, spawnedAt: now - 1000 }), false,
      "出生零输出不忙（快照没有 lastActiveAt）");
    // 面 2：近 2s 有键入则输出不判忙（PTY 回显归因用户交互）；静默超 2s 后的
    // 输出才是程序自己的。lastInputAt 缺省（undefined/0：老会话恢复、老宿主
    // 快照）按无抑制处理。
    const echoState = (inputAt) => ({
      status: "running", createdAt: now - 60_000, spawnedAt: now - 60_000,
      lastActiveAt: now - 500, lastInputAt: inputAt,
    });
    assert.equal(await busy(echoState(now - 1000)), false, "1s 前刚键入：回显不判忙");
    assert.equal(await busy(echoState(now - 2500)), true, "键入静默 2.5s 后仍在出字：在跑");
    assert.equal(await busy(echoState(undefined)), true, "lastInputAt 缺省按无抑制");
    assert.equal(await busy(echoState(0)), true, "lastInputAt 为 0 按无抑制");
    // 面 3：孵化窗 15s——出生 15s 内的输出（新 shell banner／续接重放实测
    // 6–12s）不当「在跑」，窗后命令输出照常判忙；出生点锚 spawnedAt，老宿主
    // 快照没有时回落 createdAt。
    const bannerState = (bornAt) => ({
      status: "running", createdAt: now - 600_000, spawnedAt: bornAt, lastActiveAt: now - 100,
    });
    assert.equal(await busy(bannerState(now - 10_000)), false, "出生 10s：banner/重放不判忙");
    assert.equal(await busy(bannerState(now - 16_000)), true, "出生 16s：窗后命令输出判忙");
    assert.equal(await busy({ status: "running", createdAt: now - 10_000, lastActiveAt: now - 100 }), false,
      "老宿主快照无 spawnedAt：回落 createdAt 照样豁免");
    // 面 4：孵化窗内在途请求 >0 仍忙——请求真值是 relay 权威信号，豁免窗只收
    // 输出启发，不吞请求（写点口径 count > 0 || busy 的 OR 结构）。
    const fresh = { status: "idle", metrics: null, backendState: bannerState(now - 1000) };
    await vmFn("terminalActivityApplyToSession", [fresh, 1], ["terminalBusyByOutput"]);
    assert.equal(fresh.status, "working", "孵化窗内请求在途仍 working");
    await vmFn("terminalActivityApplyToSession", [fresh, 0], ["terminalBusyByOutput"]);
    assert.equal(fresh.status, "idle", "孵化窗内零请求零有效输出：idle（内切门就地换内容）");
  });

  it("前端：terminalActivityApplyFrame 定点更新不串键、snapshot 整帧对齐", async () => {
    const mk = (endpointId, instanceId, status = "idle") => ({
      status,
      metrics: { activeRequests: 0 },
      agent: instanceId === null
        ? { endpointId, name: endpointId, pid: 6100, instanceId: null }
        : { endpointId, name: endpointId, pid: 4321, instanceId },
    });
    const kimi = mk("kimi", "kimi-4321");
    const claude = mk("claude", "claude-9001", "working");

    // activity 帧按 (endpointId, instanceId) 严格配对：只动命中会话。
    assert.equal(await vmFn("terminalActivityApplyFrame",
      [{ type: "activity", endpointId: "claude", instanceId: "claude-9001", activeRequests: 2, at: 1 },
        { t1: kimi, t2: claude }],
      ["terminalActivityApplyToSession", "terminalBusyByOutput", "terminalActivityKey"]), true);
    assert.equal(claude.status, "working");
    assert.equal(claude.metrics.activeRequests, 2);
    assert.equal(kimi.status, "idle", "键不匹配的会话不动");

    // null instanceId 的帧不放大到端点下已归属实例的会话。
    assert.equal(await vmFn("terminalActivityApplyFrame",
      [{ type: "activity", endpointId: "kimi", instanceId: null, activeRequests: 9, at: 2 },
        { t1: kimi, t2: claude }],
      ["terminalActivityApplyToSession", "terminalBusyByOutput", "terminalActivityKey"]), false,
      "未命中任何会话返回 false（不重绘）");
    assert.equal(kimi.status, "idle");

    // snapshot 帧整帧对齐：快照里查不到的归属会话回落 0。
    kimi.status = "working";
    kimi.metrics.activeRequests = 7;
    assert.equal(await vmFn("terminalActivityApplyFrame",
      [{ type: "snapshot", instances: [{ endpointId: "kimi", instanceId: "kimi-4321", activeRequests: 1, at: 3 }] },
        { t1: kimi, t2: claude }],
      ["terminalActivityApplyToSession", "terminalBusyByOutput", "terminalActivityKey"]), true);
    assert.equal(kimi.status, "working", "快照里命中的键用真值");
    assert.equal(kimi.metrics.activeRequests, 1);
    assert.equal(claude.status, "idle", "快照里查不到的键一律回落 0");

    assert.equal(await vmFn("terminalActivityApplyFrame", [{ type: "other" }, { t1: kimi }],
      ["terminalActivityApplyToSession", "terminalBusyByOutput", "terminalActivityKey"]), false, "未知帧型忽略");
    assert.equal(await vmFn("terminalActivityApplyFrame", [null, { t1: kimi }],
      ["terminalActivityApplyToSession", "terminalBusyByOutput", "terminalActivityKey"]), false, "空帧忽略");
  });

  it("接线结构：路由就位、桥注释行直通、轮询原样 1s、EventSource 按活性同拍开合", () => {
    assert.ok(panelMjs.includes('if (path === "/panel/api/agents-activity" && method === "GET")'),
      "panel 侧浏览器出口路由存在");
    assert.ok(panelMjs.includes("agentsActivityBridge = null"), "桥可注入、惰性起真桥");
    assert.ok(panelMjs.includes("line.startsWith(\":\")"), "桥透传注释心跳行");
    const source = panelJs.match(/function syncTerminalActivityStream\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(source?.includes("new EventSource(`${API_BASE}/api/agents-activity`)"), "前端订阅 /panel/api/agents-activity");
    assert.ok(source?.includes("terminalActivityApplyFrame(frame, terminalSessionMap())"), "帧落到当前会话图");
    const wanted = panelJs.match(/function activityStreamWanted\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(wanted?.includes("terminalBackendReady") && wanted?.includes("!document.hidden") && wanted?.includes('currentView === "terminal"') && wanted?.includes('currentView === "board"'),
      "活性门控与轮询一致：backend 就绪 + 页面可见 +（终端页 或 看板）");
    const tick = panelJs.match(/terminalPollTimer = setInterval\(\(\) => \{[\s\S]*?\}, 1000\);/)?.[0];
    assert.ok(tick?.includes("syncTerminalActivityStream();"), "推送流开关随每秒轮询节拍走");
    assert.ok(tick?.includes("pollTerminalSessions();"), "1s 轮询原样保留");
  });
});

// 看板侧活跃真值应用：帧改的是数据不是 DOM，命中端点返回其 id、由调用方调对应渲染器
// 整卡重渲（复用既有渲染口径）；指纹只在轮询里更新，SSE 渲染不碰 agentRenderFp。
describe("看板活跃真值应用（boardActivityApplyFrame）", () => {
  async function vmFn(name, args, deps = []) {
    const source = [name, ...deps].map((fnName) => {
      const body = panelJs.match(new RegExp(`function ${fnName}\\([\\s\\S]*?\\n  \\}`))?.[0];
      assert.ok(body, `${fnName} found in panel.js`);
      return body;
    }).join("\n");
    const fn = await vm.runInNewContext(`(() => { ${source}; return ${name}; })()`, {});
    const result = fn(...args);
    return result === undefined || result === null ? result : JSON.parse(JSON.stringify(result));
  }

  const mkBoardAgents = () => ([
    { id: "kimi", metrics: { activeRequests: 0 }, instances: [{ id: "kimi-4321", activeRequests: 0, status: "idle" }] },
    { id: "claude", sessions: [{ id: "claude-9001", activeRequests: 1, status: "active" }] },
    { id: "dsh", metrics: { activeRequests: 2 }, instances: [{ id: "dsh-26304", activeRequests: 2, status: "active" }] },
  ]);

  it("activity 帧：端点级(null)改 metrics、实例级改 instances 行，返回命中端点 id", async () => {
    const agents = mkBoardAgents();
    let hit = await vmFn("boardActivityApplyFrame",
      [{ type: "activity", endpointId: "kimi", instanceId: null, activeRequests: 3, at: 1 }, agents],
      ["terminalActivityKey"]);
    assert.deepEqual(hit, ["kimi"]);
    assert.equal(agents[0].metrics.activeRequests, 3, "端点级帧落到 metrics.activeRequests");

    hit = await vmFn("boardActivityApplyFrame",
      [{ type: "activity", endpointId: "kimi", instanceId: "kimi-4321", activeRequests: 1, at: 2 }, agents],
      ["terminalActivityKey"]);
    assert.deepEqual(hit, ["kimi"]);
    assert.equal(agents[0].instances[0].activeRequests, 1, "实例级帧落到 instances[].activeRequests");
    assert.equal(agents[0].instances[0].status, "active", "实例行 status 同步镜像（徽标派生源）");
    assert.equal(agents[2].metrics.activeRequests, 2, "未命中端点不动");

    await vmFn("boardActivityApplyFrame",
      [{ type: "activity", endpointId: "dsh", instanceId: "dsh-26304", activeRequests: 0, at: 3 }, agents],
      ["terminalActivityKey"]);
    assert.equal(agents[2].instances[0].status, "idle", "归零时 status 回落 idle");
  });

  it("claude 按 sessions 行匹配（无端点桶），未知实例 id 不编造", async () => {
    const agents = mkBoardAgents();
    const hit = await vmFn("boardActivityApplyFrame",
      [{ type: "activity", endpointId: "claude", instanceId: "claude-9001", activeRequests: 0, at: 3 }, agents],
      ["terminalActivityKey"]);
    assert.deepEqual(hit, ["claude"]);
    assert.equal(agents[1].sessions[0].activeRequests, 0, "claude 帧落到 sessions[].activeRequests");
    assert.equal(agents[1].sessions[0].status, "idle", "claude 会话行 status 同步镜像");

    const miss = await vmFn("boardActivityApplyFrame",
      [{ type: "activity", endpointId: "claude", instanceId: "claude-7777", activeRequests: 5, at: 4 }, agents],
      ["terminalActivityKey"]);
    assert.deepEqual(miss, [], "实例 id 查不到归属行时不命中、不编造行");
  });

  it("snapshot 帧：点到且新鲜的行按真值写，没点到的身份交给轮询", async () => {
    const agents = mkBoardAgents();
    const now = Date.now();
    const hit = await vmFn("boardActivityApplyFrame",
      [{ type: "snapshot", instances: [
        { endpointId: "kimi", instanceId: null, activeRequests: 3, at: now },
        { endpointId: "claude", instanceId: "claude-9001", activeRequests: 0, at: now },
        { endpointId: "dsh", instanceId: "dsh-26304", activeRequests: 0, at: now },
      ] }, agents],
      ["terminalActivityKey"]);
    assert.deepEqual(hit.sort(), ["claude", "dsh", "kimi"]);
    assert.equal(agents[0].metrics.activeRequests, 3, "点到且新鲜的端点级行按真值写");
    assert.equal(agents[1].sessions[0].activeRequests, 0, "点到且新鲜的会话行按真值写");
    assert.equal(agents[1].sessions[0].status, "idle", "会话行 status 同步镜像");
    assert.equal(agents[2].instances[0].activeRequests, 0, "点到且新鲜的实例行按真值写");
    assert.equal(agents[2].instances[0].status, "idle", "实例行 status 同步镜像");
    assert.equal(agents[2].metrics.activeRequests, 2, "端点级键没点到 → 原样不动（不擅自归零）");
  });

  it("snapshot 帧按 at 取时效：过期行不改数不命中（合并计数身份的桥缓存旧值）", async () => {
    const agents = mkBoardAgents();
    const now = Date.now();
    const hit = await vmFn("boardActivityApplyFrame",
      [{ type: "snapshot", instances: [
        { endpointId: "kimi", instanceId: null, activeRequests: 0, at: now - 60000 },
        { endpointId: "kimi", instanceId: "kimi-4321", activeRequests: 0, at: now - 60000 },
        { endpointId: "dsh", instanceId: null, activeRequests: 2, at: now - 100 },
      ] }, agents],
      ["terminalActivityKey"]);
    assert.deepEqual(hit, ["dsh"], "只有 at 新鲜的行算真值触达");
    assert.equal(agents[0].metrics.activeRequests, 0, "过期行不改写 kimi 端点计数");
    assert.equal(agents[0].instances[0].activeRequests, 0, "过期行不改写 kimi 实例计数");
    assert.equal(agents[2].metrics.activeRequests, 2, "新鲜行照常按真值写");
  });

  it("snapshot 帧按 at 取时效：过期行不改数不命中（合并计数身份的桥缓存旧值）", async () => {
    const agents = mkBoardAgents();
    const now = Date.now();
    const hit = await vmFn("boardActivityApplyFrame",
      [{ type: "snapshot", instances: [
        { endpointId: "kimi", instanceId: null, activeRequests: 0, at: now - 60000 },
        { endpointId: "kimi", instanceId: "kimi-4321", activeRequests: 0, at: now - 60000 },
        { endpointId: "dsh", instanceId: null, activeRequests: 2, at: now - 100 },
      ] }, agents],
      ["terminalActivityKey"]);
    assert.deepEqual(hit, ["dsh"], "只有 at 新鲜的行算真值触达");
    assert.equal(agents[0].metrics.activeRequests, 0, "过期行不改写 kimi 端点计数");
    assert.equal(agents[0].instances[0].activeRequests, 0, "过期行不改写 kimi 实例计数");
    assert.equal(agents[2].metrics.activeRequests, 2, "新鲜行照常按真值写");
  });

  it("未知帧型与空帧忽略", async () => {
    const agents = mkBoardAgents();
    assert.deepEqual(await vmFn("boardActivityApplyFrame", [{ type: "other" }, agents], ["terminalActivityKey"]), []);
    assert.deepEqual(await vmFn("boardActivityApplyFrame", [null, agents], ["terminalActivityKey"]), []);
  });

  it("端点级键缺失时不擅自归零；径路渲染器映射覆盖九端点", async () => {
    // 与按 at 取时效同源：端点级键没被点到 → 没有真值可写，metrics 原样留着；
    // 同一端点只由命中行上报一次，不会一帧把一张卡重渲两遍。
    const agents = mkBoardAgents();
    const now = Date.now();
    let hit = await vmFn("boardActivityApplyFrame",
      [{ type: "snapshot", instances: [{ endpointId: "dsh", instanceId: "dsh-26304", activeRequests: 0, at: now }] }, agents],
      ["terminalActivityKey"]);
    assert.deepEqual(hit, ["dsh"], "只由命中的实例行上报一次");
    assert.equal(hit.filter((x) => x === "dsh").length, 1, "同一端点不重复上报（端点级与实例行同卡）");
    assert.equal(agents[2].metrics.activeRequests, 2, "端点级键没点到 → 不改写（不擅自归零）");
    assert.equal(agents[2].instances[0].activeRequests, 0, "实例行按真值写");

    // 帧改数据 → 调用方按 id 整卡重渲：九端点各有渲染器，键与卡 id 一一对应
    const rStart = panelJs.indexOf("const BOARD_RENDERERS = {");
    const rEnd = panelJs.indexOf("};", rStart);
    const renderers = rStart >= 0 ? panelJs.slice(rStart, rEnd) : "";
    assert.ok(renderers.length > 0, "BOARD_RENDERERS 映射表存在");
    for (const id of ["zcode", "claude", "dsh", "pi", "kimi", "qoder", "opencode", "codex", "grok"]) {
      assert.ok(renderers.includes(`${id}: (a) => render`), `${id} 有对应渲染器`);
    }
    const sync = panelJs.match(/function syncTerminalActivityStream\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(sync?.includes("boardActivityApplyFrame(frame, lastBoardAgents)"), "看板分支以留存 payload 应用帧");
    assert.ok(sync?.includes("BOARD_RENDERERS[id]"), "命中端点按映射整卡重渲");
    assert.ok(panelJs.includes("lastBoardAgents = res.agents;"), "refreshAgents 留存本轮 payload 供 SSE 定位");
  });

  it("接线结构：闸门放宽到看板、onmessage 按视图分流、轮询 1s 与指纹口径不动", () => {
    const wanted = panelJs.match(/function activityStreamWanted\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(wanted, "闸门更名为 activityStreamWanted");
    assert.ok(wanted?.includes("terminalBackendReady") && wanted?.includes("!document.hidden"),
      "backend 就绪 + 页面可见保留");
    assert.ok(wanted?.includes('currentView === "terminal"') && wanted?.includes('currentView === "board"'),
      "连流条件放宽到 终端页 或 看板");
    const sync = panelJs.match(/function syncTerminalActivityStream\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(sync?.includes("boardActivityApplyFrame"), "onmessage 接入看板侧应用");
    assert.ok(sync?.includes("terminalActivityApplyFrame(frame, terminalSessionMap())"), "终端页路径原样保留");
    assert.ok(!panelJs.includes("boardRenderFp"), "看板 SSE 渲染不经指纹闸（指纹仍只由轮询维护）");
  });

  it("真实调度：看板视图下帧只重渲命中端点、离开看板即断开", async () => {
    const source = ["activityStreamWanted", "boardActivityApplyFrame", "terminalActivityKey", "syncTerminalActivityStream"]
      .map((fnName) => {
        const body = panelJs.match(new RegExp(`function ${fnName}\\([\\s\\S]*?\\n  \\}`))?.[0];
        assert.ok(body, `${fnName} found in panel.js`);
        return body;
      }).join("\n");
    const state = { rendered: [], es: null, closed: false, terminalRendered: 0 };
    const agents = [
      { id: "kimi", metrics: { activeRequests: 0 }, instances: [] },
      { id: "dsh", metrics: { activeRequests: 0 }, instances: [] },
    ];
    class FakeEventSource {
      constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; state.es = this; }
      close() { state.closed = true; }
    }
    const sandbox = {
      API_BASE: "http://127.0.0.1:47820",
      EventSource: FakeEventSource,
      document: { hidden: false },
      terminalBackendReady: true,
      currentView: "board",
      lastBoardAgents: agents,
      BOARD_RENDERERS: {
        kimi: (a) => state.rendered.push(["kimi", a.metrics.activeRequests]),
        dsh: (a) => state.rendered.push(["dsh", a.metrics.activeRequests]),
      },
      terminalSessionMap: () => ({}),
      terminalActivityApplyFrame: () => true,
      renderTerminalSessionData: () => { state.terminalRendered += 1; },
      renderTerminalPreviewTabs: () => {},
    };
    const sync = vm.runInNewContext(
      `(() => { let terminalActivitySource = null; ${source}; return syncTerminalActivityStream; })()`,
      sandbox,
    );

    sync();
    assert.ok(state.es, "看板视图建立了 SSE 连接");
    assert.equal(state.es.url, "http://127.0.0.1:47820/api/agents-activity");

    // 一帧只改命中端点：kimi 的 metrics 被写成真值并只重渲 kimi 的卡。
    state.es.onmessage({ data: JSON.stringify({ type: "activity", endpointId: "kimi", instanceId: null, activeRequests: 2, at: 1 }) });
    assert.equal(agents[0].metrics.activeRequests, 2, "帧先把数据改成真值");
    assert.deepEqual(state.rendered, [["kimi", 2]], "只触发命中端点的整卡重渲");
    assert.equal(state.terminalRendered, 0, "看板视图不抄终端页的渲染路径");

    // 未命中的端点（无归属行/无 metrics）不出现在渲染里。
    state.es.onmessage({ data: JSON.stringify({ type: "activity", endpointId: "pi", instanceId: null, activeRequests: 4, at: 2 }) });
    assert.equal(state.rendered.length, 1, "查不到的端点不重渲");

    // 离开看板：同一条流断开（不在终端的视图不留空转连接）。
    sandbox.currentView = "stats";
    sync();
    assert.equal(state.closed, true, "离开看板即断开");
  });
});


// 降级路径收口：terminal-host 不可达（面板路由 503 terminal_host_unavailable / fetch
// 直接失败）时，终端页不再把 mock 假会话（假指标/假路由/假请求/假横幅）端给用户，
// 改给真空态——xterm 区盖空态覆盖层、监测区沿用 hidden 通路、「+」禁用；
// 重试走空态动作钮（按宿主现态分派：running 重连 / stopped·exited 拉起 / unknown 提示
// 侧栏）与进页自动重试。判定键是就绪位本身，不是会话数（零会话是
// 就绪下的合法空态，不是降级）；backend 中途死掉的轮询不动就绪位，仍保上一帧。
describe("虚拟终端降级空态（terminal-backend 不可达不再渲 mock）", () => {
  function extractFn(name) {
    const src = panelJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
    assert.ok(src, `${name} found in panel.js`);
    return src;
  }

  it("源钉死：初始化不再先渲 mock，fetch 失败分支必调空态渲染", () => {
    const init = extractFn("initTerminalPreview");
    const head = init.slice(init.indexOf("restoreTerminalFontSize()"), init.indexOf("connectTerminalBackend();"));
    assert.ok(!head.includes("renderTerminalPreviewSession"), "初始化首拍不再先渲 mock 会话");
    assert.ok(!init.includes("fetchTerminalSessions().then"), "初装连接走共用通路，不再内联 fetch+then");
    const connect = extractFn("connectTerminalBackend");
    assert.ok(connect.includes("fetchTerminalSessions()"), "连接通路以 fetch 会话列表为就绪判定");
    assert.ok(connect.includes("renderTerminalPreviewSession({ revive: false })"), "成功链路重渲会话（被动挂载不复活）");
    assert.ok(connect.includes("pollTerminalSessions();"), "成功链路立即补拍归属轮询（三件套之二）");
    assert.ok(connect.includes("syncTerminalActivityStream();"), "成功链路同步活跃真值流（三件套之三）");
    const catchBranch = connect.slice(connect.indexOf(".catch("));
    assert.ok(catchBranch.includes("terminalBackendReady = false"), "失败分支置回未就绪");
    assert.ok(catchBranch.includes("renderTerminalUnavailableState();"), "失败分支必调空态渲染");
    assert.ok(catchBranch.includes("renderTerminalStoppedState();"), "失败分支按宿主现态分派：已停落「已停止」页，不拿「未运行」页顶掉");
  });

  it("源钉死：终端区静态直出 pending 骨架，设计稿假页签从 HTML 退场", () => {
    // 修的是「就绪但零会话」态的常驻假页签：renderTerminalPreviewTabs 的指纹初值是
    // 空串，零会话渲染结果也是空串，两者相等即跳过 innerHTML 赋值——静态 HTML 若
    // 携带种子页签，DOM 与指纹从第一帧起就不一致，任何渲染通路都清不掉它们。静态
    // 稿改成空骨架后「指纹 = DOM 现值」从首帧成立；init 的 pending 先落是缓存错位
    // 保险（旧缓存 HTML 带种子时，脚本运行一刻清场并重置指纹）。
    const init = extractFn("initTerminalPreview");
    const pendingAt = init.indexOf("renderTerminalPendingState();");
    const connectAt = init.indexOf("connectTerminalBackend();");
    assert.ok(pendingAt > -1 && pendingAt < connectAt, "首连发出前先同步落 pending 态");
    assert.ok(!init.includes("if (terminalBackendReady) renderTerminalPreviewSession();"),
      "初始化尾部的恒假就绪渲染退役（就绪只可能由连接通路落定）");
    for (const ghost of ["payment-service", "portal"]) {
      assert.ok(!panelHtml.includes(ghost), `设计稿假数据「${ghost}」不再出现在静态 HTML`);
    }
    assert.ok(panelHtml.includes('class="terminal-workspace is-empty"'), "工作区静态即收单列");
    assert.ok(panelHtml.includes('class="terminal-session-bar" style="display:none"'),
      "会话栏静态隐藏（与 setTerminalSessionChromeVisible 同一开关）");
    assert.ok(panelHtml.includes('id="terminalInspector" aria-label="终端状态" style="display:none"'), "监测区静态隐藏");
    assert.ok(panelHtml.includes('id="terminalFootStats" hidden'), "底栏统计静态隐藏");
    assert.ok(panelHtml.includes('id="terminalMetricsSection" hidden'), "指标区静态隐藏");
    assert.ok(panelHtml.includes('<div class="terminal-tabs" id="terminalTabs" role="tablist" aria-label="终端会话"></div>'),
      "页签栏静态无页签按钮（真实页签一律由会话清单渲染）");
  });

  it("源钉死：「+」在降级下禁用，openTerminalPreview 含降级重试分支", () => {
    const sync = extractFn("syncTerminalAddBtn");
    assert.ok(sync.includes("addBtn.disabled = !terminalBackendReady"), "新建键禁用位与就绪位同拍");
    const unavailable = extractFn("renderTerminalUnavailableState");
    assert.ok(unavailable.includes("addBtn.disabled = true"), "落空态即禁用「+」，不再产假会话");
    const open = extractFn("openTerminalPreview");
    assert.ok(open.includes("if (!terminalBackendReady) connectTerminalBackend();"), "进页未就绪自动重试一次");
    assert.ok(panelJs.includes('$("terminalRetryBtn").onclick = () => dispatchTerminalUnavailableAction();'),
      "空态动作钮静态绑定走宿主现态分派，不再无脑重跑 fetch");
    assert.ok(unavailable.includes("dispatchTerminalUnavailableAction()"), "空态渲染写入同一分派");
    assert.ok(unavailable.includes('retryBtn.textContent = "启动服务"'), "空态动作钮文案为「启动服务」");
    assert.ok(unavailable.includes("终端服务当前未在运行，点击下方按钮即可启动。"), "空态说明指向动作钮");
    const autoStart = extractFn("autoStartTerminalHost");
    assert.ok(autoStart.includes("renderTerminalStoppedState();"),
      "自动拉起失败落带「启动服务」动作的「已停止」页，不留死按钮页");
    const render = extractFn("renderTerminalPreviewSession");
    assert.ok(render.includes("terminalBackendReady === false"), "降级闸判定键是就绪位，不是会话数");
    assert.ok(render.includes("if (!terminalFirstConnectSettled) renderTerminalPendingState();"),
      "降级闸先看首连定性位：未定性落 pending，不落「服务未运行」");
    assert.ok(render.includes("renderTerminalUnavailableState();"), "降级时渲染通路整体改落空态");
    assert.ok(render.includes("renderTerminalEmptyState();"), "零会话（含回归）落空态，不再静默 return 挂占位数据");
    assert.ok(unavailable.includes('tabs.innerHTML = ""'), "落空态即清空静态假页签");
    assert.ok(unavailable.includes("setTerminalSessionChromeVisible(false)"),
      "假会话栏/假底栏/假监测区与零会话共用同一套退场，不留空 column");
    assert.ok(unavailable.includes("terminalEmpty"), "降级空态优先：零会话覆盖层一并收起");
    assert.ok(render.includes('querySelector(".terminal-foot-status")'), "就绪路径恢复底栏左段");
  });

  it("HTML/CSS：空态节点存在于 xterm 区内且默认隐藏", () => {
    assert.ok(panelHtml.includes('id="terminalUnavailable" hidden'), "空态覆盖层默认 hidden");
    const screen = panelHtml.slice(panelHtml.indexOf('id="terminalScreen"'), panelHtml.indexOf('class="terminal-footbar"'));
    assert.ok(screen.indexOf('id="terminalUnavailable"') > screen.indexOf('id="terminalXtermHost"'),
      "覆盖层在 xterm 宿主之后，同容器内天然压在上层");
    assert.ok(screen.includes("终端服务未运行"), "空态标题就位");
    assert.ok(screen.includes("终端服务当前未在运行，点击下方按钮即可启动。"), "空态说明就位");
    assert.ok(screen.includes('id="terminalRetryBtn"') && screen.includes("启动服务"), "空态动作钮就位");
    assert.ok(panelHtml.includes('id="terminalEmpty" hidden'), "零会话空态覆盖层默认 hidden");
    assert.ok(screen.includes("当前没有终端"), "零会话空态标题就位");
    assert.ok(screen.includes("点上方「+」新建一个终端，就能在这里运行 CLI Agent。"), "零会话空态说明就位");
    assert.ok(panelCss.includes(".terminal-unavailable[hidden] { display: none; }"), "hidden 语义不被 flex 布局覆盖");
    assert.ok(panelCss.includes(".terminal-empty[hidden] { display: none; }"), "零会话空态 hidden 语义不被 flex 布局覆盖");
    assert.ok(panelCss.includes(".terminal-workspace.is-empty"), "零会话空态工作区收全宽，右侧不留空列");
    assert.ok(/\.terminal-screen \{[^}]*position: relative/.test(panelCss), "screen 是覆盖层的定位祖先");
    assert.ok(panelCss.includes(".terminal-add-btn:disabled"), "「+」禁用态有视觉反馈");
  });

  function unavailableSandbox() {
    const bodies = ["renderTerminalPreviewSession", "renderTerminalUnavailableState", "renderTerminalEmptyState",
      "clearTerminalEmptyState", "setTerminalSessionChromeVisible", "renderTerminalPendingState",
      "syncTerminalAddBtn", "connectTerminalBackend", "renderTerminalStoppedState"]
      .map(extractFn).join("\n");
    const els = {
      terminalUnavailable: { hidden: true },
      terminalUnavailableTitle: { textContent: "" },
      terminalUnavailableDesc: { hidden: false, textContent: "" },
      terminalRetryBtn: { hidden: false, textContent: "", onclick: null },
      terminalEmpty: { hidden: true },
      terminalMetricsSection: { hidden: false },
      terminalFootStats: { hidden: false },
      terminalAddBtn: { disabled: false },
      terminalInspector: { style: {} },
      terminalTabs: { innerHTML: "<button>demo-service</button>" },
      terminalWorkspace: { classList: { add: (c) => els.terminalWorkspace.classes.add(c), remove: (c) => els.terminalWorkspace.classes.delete(c), contains: (c) => els.terminalWorkspace.classes.has(c), toggle: (c, on) => (on ? els.terminalWorkspace.classes.add(c) : els.terminalWorkspace.classes.delete(c)) }, classes: new Set() },
      ".terminal-session-bar": { style: {} },
      ".terminal-foot-status": { style: {} },
    };
    const state = {
      backendUp: false, session: null,
      fetches: 0, polled: 0, synced: 0, renderedData: 0, renderedTabs: 0, connected: null,
      themeReports: 0,
    };
    const sandbox = new Function("els", "state", `
      const $ = (id) => els[id] ?? null;
      const document = { querySelector: (sel) => els[sel] ?? null };
      let terminalBackendReady = false;
      // 页签栏指纹缓存：空态直写清空的退场路径会重置它（见 panel.js 指纹缓存注释）
      let terminalTabsRenderedHtml = "";
      // 默认按「首连已定性」起沙盒：既有降级三态测的是失败之后的画面；
      // 首连在飞那一态由 setSettled(false) 单独摆出来。
      let terminalFirstConnectSettled = true;
      // 失败兜底按宿主现态分派落页（connectTerminalBackend catch 读它）
      let terminalHostState = "unknown";
      let activeTerminalPreviewId = "t1";
      const currentView = "terminal";
      const console = { warn: () => {} };
      async function fetchTerminalSessions() {
        state.fetches += 1;
        if (!state.backendUp) throw new Error("terminal_host_unavailable");
        terminalBackendReady = true;
      }
      function terminalSessionFor() { return state.session; }
      function renderTerminalSessionData() { state.renderedData += 1; }
      function renderTerminalPreviewTabs() { state.renderedTabs += 1; }
      function connectTerminalStream(session) { state.connected = session; }
      function scheduleTerminalFit() {}
      function pollTerminalSessions() { state.polled += 1; }
      function syncTerminalActivityStream() { state.synced += 1; }
      function reportTerminalThemeToBackend(force) { state.themeReports += 1; state.themeForce = !!force; }
      ${bodies}
      return {
        render: renderTerminalPreviewSession,
        renderUnavailable: renderTerminalUnavailableState,
        renderPending: renderTerminalPendingState,
        syncAddBtn: syncTerminalAddBtn,
        connect: connectTerminalBackend,
        setReady: (v) => { terminalBackendReady = v; },
        ready: () => terminalBackendReady,
        setSettled: (v) => { terminalFirstConnectSettled = v; },
        settled: () => terminalFirstConnectSettled,
        setHostState: (v) => { terminalHostState = v; },
      };
    `)(els, state);
    return { sandbox, els, state };
  }

  it("vm 真跑空态渲染三态：降级 → 就绪恢复 → 再降级，幂等可重进", () => {
    const { sandbox, els, state } = unavailableSandbox();
    // 态一：未就绪 → 渲染整体落空态，不进 connectTerminalStream（mock 横幅不进屏）
    sandbox.render();
    assert.equal(els.terminalUnavailable.hidden, false, "降级时空态覆盖层盖上");
    assert.equal(els.terminalMetricsSection.hidden, true, "监测区走 hidden 通路");
    assert.equal(els.terminalFootStats.hidden, true, "底栏统计随监测区一并隐藏");
    assert.equal(els.terminalAddBtn.disabled, true, "「+」随降级禁用");
    assert.equal(els.terminalTabs.innerHTML, "", "降级清空静态假页签（demo-service/portal 种子）");
    assert.equal(els[".terminal-session-bar"].style.display, "none", "降级隐藏静态假会话栏");
    assert.equal(els[".terminal-foot-status"].style.display, "none", "降级隐藏静态假底栏左段（PID/尺寸种子）");
    assert.equal(els.terminalInspector.style.display, "none", "降级隐藏静态假监测区（demo-service/Codex CLI 种子）");
    assert.ok(els.terminalWorkspace.classList.contains("is-empty"), "监测区退场即收成单列，不留 340px 空 column");
    assert.equal(state.connected, null, "不建流——mock 横幅不进屏");
    assert.equal(state.renderedData, 0, "假会话数据不渲染");

    // 态二：就绪 → 同一会话渲真数据，覆盖层收起，「+」放开
    sandbox.setReady(true);
    state.session = { id: "t1", backend: true };
    sandbox.render();
    assert.equal(els.terminalUnavailable.hidden, true, "就绪渲染收起覆盖层");
    assert.equal(els.terminalEmpty.hidden, true, "就绪渲染收起零会话空态");
    assert.equal(els[".terminal-session-bar"].style.display, "", "就绪恢复会话栏");
    assert.equal(els[".terminal-foot-status"].style.display, "", "就绪恢复底栏左段");
    assert.deepEqual(state.connected, { id: "t1", backend: true }, "就绪时进 connectTerminalStream 建流");
    assert.equal(state.renderedData, 1, "就绪渲染真实会话数据");
    assert.equal(state.renderedTabs, 1, "就绪渲染会话标签");
    sandbox.syncAddBtn();
    assert.equal(els.terminalAddBtn.disabled, false, "就绪后「+」放开");

    // 态三：再降级 → 空态重落且幂等（重试按钮反复按不炸）
    sandbox.setReady(false);
    sandbox.render();
    assert.equal(els.terminalUnavailable.hidden, false, "再降级覆盖层重新盖上");
    assert.equal(els.terminalAddBtn.disabled, true, "再降级「+」回禁");
    sandbox.renderUnavailable();
    sandbox.renderUnavailable();
    assert.equal(els.terminalUnavailable.hidden, false, "空态渲染幂等可重进");
  });

  it("vm 真跑零会话空态：就绪但无会话 → 落空态留页内，来会话即恢复", () => {
    const { sandbox, els, state } = unavailableSandbox();
    sandbox.setReady(true);
    state.session = null;
    sandbox.render();
    assert.equal(els.terminalEmpty.hidden, false, "零会话盖上空态覆盖层");
    assert.equal(els[".terminal-session-bar"].style.display, "none", "空态隐藏静态假会话栏");
    assert.equal(els[".terminal-foot-status"].style.display, "none", "空态隐藏静态假底栏左段");
    assert.equal(els.terminalInspector.style.display, "none", "空态隐藏监测区（没有会话可监测）");
    assert.ok(els.terminalWorkspace.classList.contains("is-empty"), "监测区退场后工作区收成全宽，右侧不留空列");
    assert.equal(state.connected, null, "零会话不建流");
    assert.equal(state.renderedData, 0, "零会话不渲会话数据");
    sandbox.render();
    assert.equal(els.terminalEmpty.hidden, false, "空态渲染幂等可重进（回归路径重跑同一分支）");

    state.session = { id: "t1", backend: true };
    sandbox.render();
    assert.equal(els.terminalEmpty.hidden, true, "来会话即收起空态");
    assert.equal(els[".terminal-session-bar"].style.display, "", "会话栏恢复");
    assert.equal(els[".terminal-foot-status"].style.display, "", "底栏左段恢复");
    assert.equal(els.terminalInspector.style.display, "", "监测区恢复");
    assert.ok(!els.terminalWorkspace.classList.contains("is-empty"), "来会话即恢复双栏工作区");
    assert.deepEqual(state.connected, { id: "t1", backend: true }, "来会话即建流");
  });

  it("vm 真跑轮询零会话：别处关光会话也落空态，不挂残留数据", () => {
    // pollTerminalSessions 是 async 函数：手工取样带上 async 前缀（extractFn 的正则从
    // function 起匹配会丢掉它，函数体里的 await 会直接语法错误）。
    const pollSrc = panelJs.match(/async function pollTerminalSessions\([\s\S]*?\n  \}/)?.[0];
    assert.ok(pollSrc, "pollTerminalSessions found in panel.js");
    const bodies = [pollSrc, extractFn("renderTerminalEmptyState"), extractFn("setTerminalSessionChromeVisible")].join("\n");
    const els = {
      terminalEmpty: { hidden: true },
      terminalWorkspace: { classList: { add: (c) => els.terminalWorkspace.classes.add(c), remove: (c) => els.terminalWorkspace.classes.delete(c), contains: (c) => els.terminalWorkspace.classes.has(c), toggle: (c, on) => (on ? els.terminalWorkspace.classes.add(c) : els.terminalWorkspace.classes.delete(c)) }, classes: new Set() },
      terminalTabs: { innerHTML: "" },
    };
    const state = { data: 0, enriched: 0, requested: 0, renderedData: 0, renderedTabs: 0 };
    const sandbox = new Function("els", "state", `
      const $ = (id) => els[id] ?? null;
      const document = { querySelector: () => null };
      const terminalBackendReady = true;
      let terminalPollInFlight = false;
      const terminalBackendSessions = {};
      async function api() { state.data += 1; return { sessions: [] }; }
      function rebuildTerminalBackendSessions() {}
      async function refreshRouteRuntimeCache() {}
      async function refreshActiveTerminalRequests() { state.requested += 1; }
      function enrichTerminalSessions() { state.enriched += 1; }
      function renderTerminalSessionData() { state.renderedData += 1; }
      function renderTerminalPreviewTabs() { state.renderedTabs += 1; }
      ${bodies}
      return { poll: pollTerminalSessions };
    `)(els, state);
    return sandbox.poll().then(() => {
      assert.equal(state.renderedTabs, 1, "轮询照常重渲页签");
      assert.equal(state.renderedData, 0, "零会话不渲会话数据（无会话可渲）");
      assert.equal(els.terminalEmpty.hidden, false, "别处关光会话也落空态");
      assert.ok(els.terminalWorkspace.classList.contains("is-empty"), "轮询路径同样收全宽工作区");
    });
  });

  it("vm 真跑连接通路：失败落空态，成功链路三件套各一拍且「+」放开", async () => {
    const { sandbox, els, state } = unavailableSandbox();
    await sandbox.connect();
    assert.equal(state.fetches, 1, "发起一次会话拉取");
    assert.equal(sandbox.ready(), false, "失败置回未就绪");
    assert.equal(els.terminalUnavailable.hidden, false, "失败即落空态");
    assert.equal(els.terminalAddBtn.disabled, true, "失败「+」禁用");
    assert.equal(state.polled, 0, "失败不补拍轮询");
    assert.equal(state.synced, 0, "失败不同步活跃流");
    assert.equal(state.connected, null, "失败不建流");
    assert.equal(state.themeReports, 0, "失败链路不补报亮暗");

    state.backendUp = true;
    state.session = { id: "t1", backend: true };
    await sandbox.connect();
    assert.equal(sandbox.ready(), true, "成功置就绪");
    assert.equal(els.terminalUnavailable.hidden, true, "成功收起覆盖层");
    assert.equal(els.terminalAddBtn.disabled, false, "成功「+」放开");
    assert.equal(state.renderedData, 1, "成功链路重渲会话");
    assert.equal(state.polled, 1, "成功链路补拍归属轮询");
    assert.equal(state.synced, 1, "成功链路同步活跃真值流");
    assert.deepEqual(state.connected, { id: "t1", backend: true }, "成功链路建流进真会话");
    assert.equal(state.themeReports, 1, "成功链路强制补报一次亮暗");
    assert.equal(state.themeForce, true, "补报走强制口径（宿主可能重启遗忘）");
  });

  it("vm 真跑首连零会话：不自动 POST 新建，就绪位照常落定", async () => {
    // 真跑源码里的 fetchTerminalSessions（降级沙箱把它桩掉，这里换成抽源码）：零会话
    // 只 GET 一次后落就绪位，新建只属于用户动作。此前这里会自动 POST 一个空白终端
    // ——页面加载必经首连，任何页刷新都在零页签时凭空蹦空白页签＋静默起 powershell。
    const src = panelJs.match(/async function fetchTerminalSessions\([\s\S]*?\n  \}/)?.[0];
    assert.ok(src, "fetchTerminalSessions found in panel.js");
    const calls = [];
    const rebuilt = [];
    const vm = new Function("api", "rebuildTerminalBackendSessions", "rememberTerminalSessionId", "terminalCwdInitial", "terminalCreateSize", `
      let terminalBackendReady = false;
      ${src}
      return { run: () => fetchTerminalSessions().then(() => terminalBackendReady) };
    `);
    const remembered = [];
    const harness = vm(
      async (method, path, body) => { calls.push({ method, path, body }); return { sessions: [] }; },
      (items) => { rebuilt.push(items); },
      (id) => { remembered.push(id ?? null); },
      () => "cwd",
      () => ({ cols: 120, rows: 34 })
    );
    const ready = await harness.run();
    assert.equal(ready, true, "会话列表落地后就绪位照常置位");
    assert.deepEqual(calls.map((c) => c.method), ["GET"], "零会话只 GET 一次，不自动补建 POST");
    assert.deepEqual(rebuilt, [[]], "空会话表照常进 rebuild（活动 id 回退归 rebuild 自担）");
  });

  it("首连在飞那一帧不落降级空态：静态种子退场、覆盖层不盖，定性失败才落空态", async () => {
    // 刷新恢复直接落进终端页时，就绪位还是 false 而列表请求还在飞（实测一个往返
    // 16–41ms）。这一帧的空白是「还不知道」：既不能谎称服务未运行，也不能谎称零会话。
    const { sandbox, els, state } = unavailableSandbox();
    sandbox.setSettled(false);
    state.session = { id: "t1", backend: true };
    sandbox.render();
    assert.equal(els.terminalUnavailable.hidden, true, "未定性不盖「终端服务未运行」");
    assert.equal(els.terminalEmpty.hidden, true, "未定性也不盖「当前没有终端」");
    assert.equal(els.terminalTabs.innerHTML, "", "未定性即清空静态假页签");
    assert.equal(els[".terminal-session-bar"].style.display, "none", "假会话栏退场");
    assert.equal(els[".terminal-foot-status"].style.display, "none", "假底栏左段（PID/尺寸种子）退场");
    assert.equal(els.terminalInspector.style.display, "none", "假监测区（demo-service/Codex CLI）退场");
    assert.equal(els.terminalAddBtn.disabled, true, "「+」按未就绪保持禁用");
    assert.equal(state.connected, null, "未定性不建流");
    assert.equal(state.renderedData, 0, "未定性不渲会话数据");

    // 首连真失败即定性，降级空态照旧落下（改前后行为一致）
    await sandbox.connect();
    assert.equal(sandbox.settled(), true, "首连失败即定性");
    assert.equal(sandbox.ready(), false, "失败仍是未就绪");
    assert.equal(els.terminalUnavailable.hidden, false, "定性失败落降级空态");
    assert.equal(els.terminalEmpty.hidden, true, "降级空态优先于零会话空态");
  });

  it("vm 真跑空态动作钮分派：running 重连 / stopped·exited 拉起 / unknown 提示侧栏", async () => {
    // 「未运行」页动作钮不再无脑 connectTerminalBackend：先现取宿主状态再分派。
    // unknown 含 relay 不可达（host/status 路由回 200 state:"unknown"）与请求本身失败。
    const dispatch = extractFn("dispatchTerminalUnavailableAction");
    const norm = extractFn("normalizeTerminalHostState");
    async function runCase(apiImpl) {
      const state = { connected: 0, started: 0, toasts: [] };
      const run = new Function("state", "api", `
        function connectTerminalBackend() { state.connected += 1; }
        function startTerminalHost() { state.started += 1; }
        function toast(msg) { state.toasts.push(msg); }
        ${norm}
        ${dispatch}
        return dispatchTerminalUnavailableAction();
      `)(state, apiImpl);
      await run;
      return state;
    }
    const running = await runCase(async () => ({ state: "running" }));
    assert.equal(running.connected, 1, "running → 重连后端");
    assert.equal(running.started, 0, "running 不重复拉起");
    assert.equal(running.toasts.length, 0, "running 无提示");
    const stopped = await runCase(async () => ({ state: "stopped" }));
    assert.equal(stopped.started, 1, "stopped → 走启动通路");
    assert.equal(stopped.connected, 0, "stopped 不空连");
    const exited = await runCase(async () => ({ state: "crashed" }));
    assert.equal(exited.started, 1, "exited（relay 细分词 crashed 归一）→ 走启动通路");
    const unknown = await runCase(async () => ({ state: "unknown" }));
    assert.equal(unknown.connected + unknown.started, 0, "unknown 不动手（启动 relay 归侧栏）");
    assert.equal(unknown.toasts.length, 1, "unknown 给出可执行提示");
    assert.ok(unknown.toasts[0].includes("Relay 未在运行") && unknown.toasts[0].includes("左侧栏"),
      "提示指向侧栏 relay 启动钮");
    const unreachable = await runCase(async () => { throw new Error("network"); });
    assert.equal(unreachable.toasts.length, 1, "状态请求本身失败同按 unknown 提示");
    assert.equal(unreachable.connected + unreachable.started, 0, "请求失败不动手");
  });

  it("vm 真跑连接失败兜底：宿主已停落「已停止」页，unknown 才落「未运行」页", async () => {
    const { sandbox, els } = unavailableSandbox();
    sandbox.setHostState("stopped");
    await sandbox.connect();
    assert.equal(els.terminalUnavailableTitle.textContent, "终端服务已停止", "已停落「已停止」页，不被「未运行」页顶掉");
    assert.equal(els.terminalRetryBtn.textContent, "启动终端服务", "兜底页带启动动作");
    sandbox.setHostState("unknown");
    await sandbox.connect();
    assert.equal(els.terminalUnavailableTitle.textContent, "终端服务未运行", "unknown 落「未运行」页");
    assert.equal(els.terminalRetryBtn.textContent, "启动服务", "「未运行」页动作钮文案");
    assert.equal(els.terminalUnavailableDesc.textContent, "终端服务当前未在运行，点击下方按钮即可启动。", "「未运行」页说明指向动作钮");
  });

  it("vm 真跑自动拉起失败兜底：落带启动动作的页，不留死按钮页", async () => {
    const bodies = ["autoStartTerminalHost", "normalizeTerminalHostState", "renderTerminalUnavailableState",
      "renderTerminalStoppedState", "setTerminalSessionChromeVisible"].map(extractFn).join("\n");
    const els = {
      terminalUnavailable: { hidden: true },
      terminalUnavailableTitle: { textContent: "" },
      terminalUnavailableDesc: { hidden: false, textContent: "" },
      terminalRetryBtn: { hidden: false, textContent: "", onclick: null },
      terminalEmpty: { hidden: true },
      terminalMetricsSection: { hidden: false },
      terminalFootStats: { hidden: false },
      terminalAddBtn: { disabled: false },
      terminalTabs: { innerHTML: "" },
      terminalWorkspace: { classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} } },
    };
    async function runCase(hostState) {
      const vm = new Function("els", "hostState", `
        const $ = (id) => els[id] ?? null;
        const document = { querySelector: () => null };
        let terminalHostOpInFlight = false;
        let terminalBackendReady = false;
        let terminalHostState = hostState;
        let terminalTabsRenderedHtml = "";
        async function api() { throw new Error("start failed"); }
        function renderTerminalStartingState() {}
        function applyTerminalHostState() {}
        function connectTerminalBackend() {}
        function syncTerminalHostControls() {}
        ${bodies}
        return autoStartTerminalHost().then(() => ({
          title: els.terminalUnavailableTitle.textContent,
          btn: els.terminalRetryBtn.textContent,
          ready: terminalBackendReady,
        }));
      `);
      return vm(els, hostState);
    }
    const exited = await runCase("exited");
    assert.equal(exited.title, "终端服务已停止", "异常退出拉起失败落「已停止」页");
    assert.equal(exited.btn, "启动终端服务", "兜底页动作钮可再启动");
    assert.equal(exited.ready, false, "失败置回未就绪");
    const unknown = await runCase("unknown");
    assert.equal(unknown.title, "终端服务未运行", "状态不可知仍落「未运行」页");
    assert.equal(unknown.btn, "启动服务", "「未运行」页动作钮走分派");
  });
});

// 一键启动 CLI Agent：面板路由把「选中的 agent + 工作目录」在服务端组装成
// launch（cmd /c 包装，归属链硬前提）与 env（凭证只走环境变量），透传给
// terminal-host；env 不落盘也不回显。createTerminalSession 注入式假实现，
// 不起真 terminal-host。
describe("一键启动 CLI Agent（terminal agent-sessions 路由）", () => {
  function agentTerminalRouter({ createSession, root } = {}) {
    const calls = [];
    const router = createPanelRouter({
      storePaths: { root },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => null,
      createTerminalSession: createSession ?? (async (body, options) => {
        calls.push({ body, options });
        return {
          status: 201,
          body: {
            id: "t-agent-1", label: body.label, cwd: body.cwd, shell: "cmd", pid: 777,
            status: "running", agentId: body.agentId, agentName: body.agentName, launch: body.launch,
          },
        };
      }),
    });
    return { router, calls };
  }

  // kimi 的可执行文件走 KIMI_EXECUTABLE 指向的临时文件：组装层要求它真实存在，
  // 且测试不能依赖本机装没装 kimi。进程环境用后即还。
  function withFakeKimiExecutable(fn) {
    const root = mkTestDir("anyswitch-agent-route-");
    const exe = join(root, "kimi.cmd");
    writeFileSync(exe, "");
    const saved = process.env.KIMI_EXECUTABLE;
    process.env.KIMI_EXECUTABLE = exe;
    return fn(root).finally(() => {
      if (saved === undefined) delete process.env.KIMI_EXECUTABLE;
      else process.env.KIMI_EXECUTABLE = saved;
    });
  }

  it("组装好的 launch/env 透传，token 与代理同源，响应不回显 env", async () => {
    await withFakeKimiExecutable(async (cwd) => {
      const root = mkTestDir("anyswitch-agent-route-root-");
      const { router, calls } = agentTerminalRouter({ root });
      const { req, res, json } = fakeReqRes("/panel/api/terminal/agent-sessions", "POST", { agentId: "kimi", cwd, cols: 120, rows: 34 });
      await router.handle(req, res);
      assert.equal(res.statusCode, 201);
      const body = json();
      assert.equal(body.id, "t-agent-1");
      assert.equal(body.agentId, "kimi");
      assert.equal(body.agentName, "Kimi Code");
      assert.ok(body.launch, "非密 launch 元数据随快照回传");

      assert.equal(calls.length, 1, "走注入的 createTerminalSession，不起真 terminal-host");
      const forwarded = calls[0].body;
      assert.equal(forwarded.shell, "cmd");
      assert.equal(forwarded.cwd, cwd);
      assert.equal(forwarded.label, "Kimi Code");
      assert.deepEqual(forwarded.launch.args.slice(0, 6), ["/d", "/c", "chcp", "65001", ">nul", "&"], "cmd 包装 + 前置 UTF-8 码页切换：session.pid 落在扫描名单内，agent 进程树共享 65001 伪控制台");
      assert.equal(forwarded.launch.args[6], process.env.KIMI_EXECUTABLE);
      assert.equal(forwarded.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:47821", "base 恒为常驻 relay");
      assert.equal(forwarded.env.ANTHROPIC_AUTH_TOKEN, loadOrGenerateToken(root));
      assert.ok(forwarded.env.KIMI_CODE_CUSTOM_HEADERS.includes("x-agent-id: kimi"));
      assert.equal(forwarded.env.ANTHROPIC_API_KEY, null, "上游真键以 null 标删");
      assert.equal(calls[0].options.token, loadOrGenerateToken(root), "token 取法与 terminal 代理一致");
      // env 不经响应体回显：回给浏览器的只有 terminal-host 的快照（无 env 键，
      // 也不含令牌明文——凭证只存在于转发给 terminal-host 的那一次请求体里）。
      assert.equal("env" in body, false, "响应不含 env");
      assert.ok(!JSON.stringify(body).includes(loadOrGenerateToken(root)), "响应不含令牌明文");
    });
  });

  it("未知 agentId / 目录不存在返回 400，文案面向用户", async () => {
    await withFakeKimiExecutable(async (cwd) => {
      const root = mkTestDir("anyswitch-agent-route-root-");
      const { router, calls } = agentTerminalRouter({ root });

      const unknown = fakeReqRes("/panel/api/terminal/agent-sessions", "POST", { agentId: "no-such-agent", cwd });
      await router.handle(unknown.req, unknown.res);
      assert.equal(unknown.res.statusCode, 400);
      assert.match(unknown.json().error, /[\u4e00-\u9fff]/, "中文产品文案，不是机器码");
      assert.equal(calls.length, 0, "白名单外不转发");

      const missing = fakeReqRes("/panel/api/terminal/agent-sessions", "POST", { agentId: "kimi", cwd: join(cwd, "no-such-dir") });
      await router.handle(missing.req, missing.res);
      assert.equal(missing.res.statusCode, 400);
      assert.match(missing.json().error, /工作目录/);
      assert.equal(calls.length, 0, "目录不存在不静默回落");

      const empty = fakeReqRes("/panel/api/terminal/agent-sessions", "POST", { agentId: "kimi" });
      await router.handle(empty.req, empty.res);
      assert.equal(empty.res.statusCode, 400);
    });
  });

  it("terminal-host 不在（假实现返回 null 或抛错）返回 503", async () => {
    await withFakeKimiExecutable(async (cwd) => {
      for (const createSession of [
        async () => null,
        async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:47823"); },
      ]) {
        const root = mkTestDir("anyswitch-agent-route-root-");
        const { router } = agentTerminalRouter({ root, createSession });
        const { req, res, json } = fakeReqRes("/panel/api/terminal/agent-sessions", "POST", { agentId: "kimi", cwd });
        await router.handle(req, res);
        assert.equal(res.statusCode, 503);
        assert.match(json().error, /[\u4e00-\u9fff]/);
      }
    });
  });

  it("源码钉死：路由字面量、组装调用、可注入依赖、Bearer 头都在位", () => {
    assert.ok(panelMjs.includes('if (path === "/panel/api/terminal/agent-sessions" && method === "POST") return handleTerminalAgentSessionCreate(req, res);'),
      "新路由挂在终端路由块内");
    assert.ok(panelMjs.includes("buildAgentSessionLaunch({ agentId, cwd: body?.cwd, port: AGENT_RELAY_PORT, token, base, claudeBypassPermissions })"),
      "launch/env 在服务端组装，不在前端拼；bypassPermissions 开关也由服务端现读设置传入");
    assert.ok(panelMjs.includes("createTerminalSession = defaultCreateTerminalSession"),
      "createTerminalSession 可注入，测试不起真 terminal-host");
    assert.ok(panelMjs.includes('headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }'),
      "默认实现用与代理相同的 pi-relay-token Bearer 头");
    assert.ok(panelMjs.includes("return sendJson(res, created.status || 201, created.body ?? {});"),
      "响应只透传 terminal-host 快照，面板不自行拼装——env 无从回显");
  });
});

// 复活路由：进程已退的 agent 会话重开时必须重新拿到 relay 地址与 token。
// env 从不落盘（terminal-host.mjs 的注释与落盘字段都明写），宿主自己 restart
// 一个 agent 会话只能拉起 agent 的原生实例——那正是「历史看着还在、一刷新变
// 空白新对话」的来源。这条路由是唯一正确的复活通路。
// 终端会话 ↔ 对话存档绑定文件的读写替身：真实 createBindingStore 落在
// storePaths.root 下，测试直接写/读这个文件来预置与验收。
function writeTerminalBindings(root, bindings) {
  writeFileSync(join(root, TERMINAL_CONVERSATION_BINDINGS_FILE), JSON.stringify({ version: 1, bindings }));
}

function readTerminalBindings(root) {
  const file = join(root, TERMINAL_CONVERSATION_BINDINGS_FILE);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")).bindings;
}

// fire-and-forget 旁路（绑定捕获、自愈重扫）的确定性强排：微任务链 + 注入的
// 即时扫描都在几跳内落定，给足五拍。
async function flushAsyncSideEffects() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("终端会话复活（revive 路由重组装凭据）", () => {
  function reviveRouter({ session, root, restartSession, fetchSession, scanAgentConversations, scheduleRefresh, base } = {}) {
    const restarts = [];
    const scheduled = [];
    const router = createPanelRouter({
      storePaths: { root },
      base: base ?? process.env,
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => null,
      fetchTerminalSessionFn: fetchSession ?? (async (id) => ({ ...session, id })),
      restartTerminalSessionFn: restartSession ?? (async (id, body, options) => {
        restarts.push({ id, body, options });
        return { status: 200, body: { id, status: "running", pid: 4242 } };
      }),
      // resume 接线的对话存档扫描：默认空表（=判不出、维持现状），不碰真存档。
      scanAgentConversationsFn: scanAgentConversations ?? (async () => []),
      // 复活后的自愈换绑拍节：默认只收不点，测试要验刷新就手动泵。
      bindingRefreshScheduleFn: scheduleRefresh ?? ((fn) => { scheduled.push(fn); }),
    });
    return { router, restarts, scheduled };
  }

  function withFakeKimiExecutable(fn) {
    const root = mkTestDir("anyswitch-revive-");
    const exe = join(root, "kimi.cmd");
    writeFileSync(exe, "");
    const saved = process.env.KIMI_EXECUTABLE;
    process.env.KIMI_EXECUTABLE = exe;
    return fn(root).finally(() => {
      if (saved === undefined) delete process.env.KIMI_EXECUTABLE;
      else process.env.KIMI_EXECUTABLE = saved;
    });
  }

  it("agent 会话：按当前安装重新组装 launch/env 再交给宿主重开", async () => {
    await withFakeKimiExecutable(async (cwd) => {
      const root = mkTestDir("anyswitch-revive-root-");
      const { router, restarts } = reviveRouter({
        root,
        session: { id: "5e551234", agentId: "kimi", cwd, shell: "cmd" },
      });
      const { req, res, json } = fakeReqRes("/panel/api/terminal/sessions/5e551234/revive", "POST", {});
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(json().status, "running");
      assert.equal(restarts.length, 1, "只转发一次重开");
      const forwarded = restarts[0];
      assert.equal(forwarded.id, "5e551234");
      assert.equal(forwarded.body.cwd, cwd, "工作目录随会话走");
      assert.deepEqual(forwarded.body.launch.args.slice(0, 6), ["/d", "/c", "chcp", "65001", ">nul", "&"], "cmd 包装与码页前缀照旧");
      assert.equal(forwarded.body.launch.args[6], process.env.KIMI_EXECUTABLE);
      assert.equal(forwarded.body.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:47821", "凭据在复活时重建");
      assert.equal(forwarded.body.env.ANTHROPIC_AUTH_TOKEN, loadOrGenerateToken(root));
      assert.ok(!JSON.stringify(json()).includes(loadOrGenerateToken(root)), "响应不回显令牌");
    });
  });

  it("纯外壳会话：没有可重建的凭据，直接转发重开", async () => {
    const root = mkTestDir("anyswitch-revive-shell-");
    const { router, restarts } = reviveRouter({
      root,
      session: { id: "5e55a11c", cwd: root, shell: "powershell" },
    });
    const { req, res } = fakeReqRes("/panel/api/terminal/sessions/5e55a11c/revive", "POST", {});
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(restarts[0].body, {}, "外壳会话不带 launch/env");
  });

  it("会话不存在返回 404，宿主不可达返回 503", async () => {
    const root = mkTestDir("anyswitch-revive-missing-");
    const missing = reviveRouter({ root, fetchSession: async () => null });
    const miss = fakeReqRes("/panel/api/terminal/sessions/deadbeef/revive", "POST", {});
    await missing.router.handle(miss.req, miss.res);
    assert.equal(miss.res.statusCode, 404);
    assert.equal(missing.restarts.length, 0);

    const down = reviveRouter({
      root,
      session: { id: "5e55c001", cwd: root, shell: "powershell" },
      restartSession: async () => null,
    });
    const off = fakeReqRes("/panel/api/terminal/sessions/5e55c001/revive", "POST", {});
    await down.router.handle(off.req, off.res);
    assert.equal(off.res.statusCode, 503);
  });

  it("源码钉死：复活路由只走 /revive，前端不再裸打 restart", () => {
    assert.ok(panelMjs.includes("/revive$/i"), "revive 在按 id 的路由块里单独匹配");
    assert.ok(panelMjs.includes("handleTerminalSessionRevive(req, res, reviveMatch[1])"), "路由转发到复活处理");
    assert.ok(panelJs.includes('api("POST", `/api/terminal/sessions/${encodeURIComponent(session.id)}/revive`)'),
      "前端复活走新路由");
    assert.ok(!panelJs.includes('api("POST", `/api/terminal/sessions/${encodeURIComponent(session.id)}/restart`)'),
      "裸 restart 复活已退役：它起来的是没有凭据的原生实例");
  });

  // ---- resume 接线：复活带回原对话（绑定优先，兜底扫描，判不出不接） ----

  it("有绑定：按绑定对话追加 resume 参数，并布一拍复活后自愈重扫", async () => {
    await withFakeKimiExecutable(async () => {
      const root = mkTestDir("anyswitch-revive-bind-root-");
      const cwd = mkTestDir("anyswitch-revive-bind-cwd-");
      writeTerminalBindings(root, {
        "5e55b001": { agentId: "kimi", cwd, conversationId: "conv-42", file: null, boundAt: 1, source: "bound" },
      });
      const { router, restarts, scheduled } = reviveRouter({
        root,
        session: { id: "5e55b001", agentId: "kimi", cwd, shell: "cmd", createdAt: 1000, lastActiveAt: 8000 },
        scanAgentConversations: async () => [
          { endpoint: "kimi", id: "conv-42", project: cwd, file: "F:\\kimi\\conv-42", createdAt: null, lastActive: 9000 },
        ],
      });
      const { req, res } = fakeReqRes("/panel/api/terminal/sessions/5e55b001/revive", "POST", {});
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(restarts.length, 1);
      assert.deepEqual(restarts[0].body.launch.args.slice(-2), ["--session", "conv-42"], "kimi 按 --session <id> 续会");
      assert.equal(scheduled.length, 1, "复活带了 resume 才布自愈重扫");
      // 绑定里的 file 被扫描现值刷新（续写原存档的 agent 上这是同值确认）。
      assert.equal(readTerminalBindings(root)["5e55b001"].file, "F:\\kimi\\conv-42");
    });
  });

  it("复活后自愈重扫：复活时刻之后唯一活跃的新存档换绑进库", async () => {
    await withFakeKimiExecutable(async () => {
      const root = mkTestDir("anyswitch-revive-fork-root-");
      const cwd = mkTestDir("anyswitch-revive-fork-cwd-");
      writeTerminalBindings(root, {
        "5e55b002": { agentId: "kimi", cwd, conversationId: "conv-old", file: null, boundAt: 1, source: "bound" },
      });
      let scanCalls = 0;
      const { router, scheduled } = reviveRouter({
        root,
        session: { id: "5e55b002", agentId: "kimi", cwd, shell: "cmd", createdAt: 1000, lastActiveAt: 8000 },
        scanAgentConversations: async () => {
          scanCalls += 1;
          if (scanCalls === 1) {
            return [{ endpoint: "kimi", id: "conv-old", project: cwd, createdAt: null, lastActive: 9000 }];
          }
          // resume 另起了新对话存档：复活时刻之后唯一活跃的是它。
          return [
            { endpoint: "kimi", id: "conv-old", project: cwd, createdAt: null, lastActive: 9000 },
            { endpoint: "kimi", id: "conv-new", project: cwd, createdAt: null, lastActive: Date.now() + 60_000 },
          ];
        },
      });
      const { req, res } = fakeReqRes("/panel/api/terminal/sessions/5e55b002/revive", "POST", {});
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(scheduled.length, 1);
      scheduled[0]();
      await flushAsyncSideEffects();
      assert.equal(readTerminalBindings(root)["5e55b002"].conversationId, "conv-new", "新存档换绑，下次复活接新对话");
    });
  });

  it("绑定存档已消失：落兜底扫描，挑生命周期重叠最佳者", async () => {
    await withFakeKimiExecutable(async () => {
      const root = mkTestDir("anyswitch-revive-stale-root-");
      const cwd = mkTestDir("anyswitch-revive-stale-cwd-");
      writeTerminalBindings(root, {
        "5e55b003": { agentId: "kimi", cwd, conversationId: "conv-dead", file: null, boundAt: 1, source: "bound" },
      });
      const { router, restarts } = reviveRouter({
        root,
        session: { id: "5e55b003", agentId: "kimi", cwd, shell: "cmd", createdAt: 1000, lastActiveAt: 5000 },
        scanAgentConversations: async () => [
          { endpoint: "kimi", id: "conv-live", project: cwd, createdAt: 1500, lastActive: 4500 },
        ],
      });
      const { req, res } = fakeReqRes("/panel/api/terminal/sessions/5e55b003/revive", "POST", {});
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(restarts[0].body.launch.args.slice(-2), ["--session", "conv-live"]);
      const bindings = readTerminalBindings(root);
      assert.equal(bindings["5e55b003"].conversationId, "conv-live", "失效绑定被兜底结果替换");
      assert.equal(bindings["5e55b003"].source, "scanned");
    });
  });

  it("无绑定兜底命中：resume 参数带上，绑定落盘（绑定存储读写贯通）", async () => {
    await withFakeKimiExecutable(async () => {
      const root = mkTestDir("anyswitch-revive-fallback-root-");
      const cwd = mkTestDir("anyswitch-revive-fallback-cwd-");
      const { router, restarts } = reviveRouter({
        root,
        session: { id: "5e55b004", agentId: "kimi", cwd, shell: "cmd", createdAt: 1000, lastActiveAt: 5000 },
        scanAgentConversations: async () => [
          { endpoint: "kimi", id: "too-early", project: cwd, createdAt: 100, lastActive: 900 },
          { endpoint: "kimi", id: "picked", project: cwd, createdAt: 1500, lastActive: 4500 },
          { endpoint: "kimi", id: "too-late", project: cwd, createdAt: 6000, lastActive: 7000 },
          { endpoint: "kimi", id: "elsewhere", project: "C:\\other", createdAt: 1500, lastActive: 4800 },
        ],
      });
      const { req, res } = fakeReqRes("/panel/api/terminal/sessions/5e55b004/revive", "POST", {});
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(restarts[0].body.launch.args.slice(-2), ["--session", "picked"], "窗口重叠里取最新活跃");
      const bindings = readTerminalBindings(root);
      assert.equal(bindings["5e55b004"].conversationId, "picked");
      assert.equal(bindings["5e55b004"].agentId, "kimi");
      assert.equal(bindings["5e55b004"].source, "scanned");
    });
  });

  it("兜底判不出（重叠并列 / 扫描空表）：维持现状空白复活，绑定不落盘", async () => {
    await withFakeKimiExecutable(async () => {
      const root = mkTestDir("anyswitch-revive-tie-root-");
      const cwd = mkTestDir("anyswitch-revive-tie-cwd-");
      const tied = reviveRouter({
        root,
        session: { id: "5e55b005", agentId: "kimi", cwd, shell: "cmd", createdAt: 1000, lastActiveAt: 5000 },
        scanAgentConversations: async () => [
          { endpoint: "kimi", id: "conv-a", project: cwd, createdAt: 1500, lastActive: 4500 },
          { endpoint: "kimi", id: "conv-b", project: cwd, createdAt: 1600, lastActive: 4500 },
        ],
      });
      const { req, res } = fakeReqRes("/panel/api/terminal/sessions/5e55b005/revive", "POST", {});
      await tied.router.handle(req, res);
      assert.equal(res.statusCode, 200, "判不出不挡复活本身");
      const args = tied.restarts[0].body.launch.args;
      assert.equal(args.length, 7, "没有 resume 参数，args 保持 cmd 包装原形");
      assert.equal(args[6], process.env.KIMI_EXECUTABLE);
      assert.equal(readTerminalBindings(root), null, "判不出不落绑定");
      assert.equal(tied.scheduled.length, 0, "没带 resume 就不布自愈重扫");
    });
  });

  it("qoder：进覆盖名单后复活带续会参数并落绑定（原样复活已成历史）", async () => {
    const home = mkTestDir("anyswitch-revive-qoder-home-");
    const exe = join(home, ".qoder", "bin", "qodercli", "qodercli.exe");
    mkdirSync(dirname(exe), { recursive: true });
    writeFileSync(exe, "");
    const root = mkTestDir("anyswitch-revive-qoder-root-");
    const cwd = mkTestDir("anyswitch-revive-qoder-cwd-");
    let scanCalls = 0;
    const { router, restarts, scheduled } = reviveRouter({
      root,
      base: { ...process.env, USERPROFILE: home },
      session: { id: "5e55b006", agentId: "qoder", cwd, shell: "cmd", createdAt: 1000, lastActiveAt: 5000 },
      scanAgentConversations: async () => {
        scanCalls += 1;
        return [{ endpoint: "qoder", id: "q-1", project: cwd, createdAt: 1500, lastActive: 4500 }];
      },
    });
    const { req, res } = fakeReqRes("/panel/api/terminal/sessions/5e55b006/revive", "POST", {});
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    const args = restarts[0].body.launch.args;
    assert.deepEqual(args.slice(0, 6), ["/d", "/c", "chcp", "65001", ">nul", "&"]);
    assert.equal(args[6], exe, "launch 保持原组装");
    assert.deepEqual(args.slice(7), ["--resume", "q-1"], "qoder 的续会参数按追加片段接上（不带任何固定参数）");
    assert.equal(scanCalls, 1, "覆盖名单内且未绑定：起扫描");
    assert.equal(scheduled.length, 1, "带 resume 复活：布自愈重扫");
    assert.equal(readTerminalBindings(root)["5e55b006"].conversationId, "q-1", "扫到即绑");
  });
});

// 列表路由旁的绑定捕获：未绑定且 running 的可续会 agent 会话异步扫描绑定，
// 按会话防抖；孤儿绑定顺手清。全部 fire-and-forget，列表主流程不受阻。
describe("终端会话绑定捕获（列表路由异步扫描）", () => {
  function listRouter({ root, sessions, scanAgentConversations }) {
    return createPanelRouter({
      storePaths: { root },
      logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
      fetchRelayAgents: async () => null,
      fetchRelayDetectedProcesses: async () => null,
      fetchTerminalSessionsList: async () => sessions,
      scanAgentConversationsFn: scanAgentConversations ?? (async () => []),
    });
  }

  it("running 且未绑定的 agent 会话扫到即绑（source=bound），孤儿绑定清掉", async () => {
    const root = mkTestDir("anyswitch-capture-root-");
    const cwd = mkTestDir("anyswitch-capture-cwd-");
    writeTerminalBindings(root, {
      "gone-session": { agentId: "kimi", cwd, conversationId: "c-orphan", file: null, boundAt: 1, source: "bound" },
    });
    const now = Date.now();
    const router = listRouter({
      root,
      sessions: [
        { id: "t9", label: "kimi", cwd, shell: "cmd", pid: 123, status: "running", agentId: "kimi", createdAt: now - 60_000, lastActiveAt: now },
      ],
      scanAgentConversations: async () => [
        { endpoint: "kimi", id: "conv-9", project: cwd, createdAt: now - 30_000, lastActive: now },
      ],
    });
    const { req, res } = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    await flushAsyncSideEffects();
    const bindings = readTerminalBindings(root);
    assert.equal(bindings["t9"].conversationId, "conv-9");
    assert.equal(bindings["t9"].source, "bound");
    assert.equal(bindings["gone-session"], undefined, "会话已消失的绑定被清");
  });

  it("按会话防抖：5s 内重复列表不重复扫描；已绑定/非 running/不支持 agent 不起扫描", async () => {
    const root = mkTestDir("anyswitch-capture-debounce-root-");
    const cwd = mkTestDir("anyswitch-capture-debounce-cwd-");
    writeTerminalBindings(root, {
      "t-bound": { agentId: "kimi", cwd, conversationId: "conv-x", file: null, boundAt: 1, source: "bound" },
    });
    const now = Date.now();
    let kimiScans = 0;
    const router = listRouter({
      root,
      sessions: [
        { id: "t-bound", label: "k", cwd, shell: "cmd", pid: 1, status: "running", agentId: "kimi", createdAt: now - 60_000 },
        { id: "t-exited", label: "k2", cwd, shell: "cmd", pid: 2, status: "exited", agentId: "kimi", createdAt: now - 60_000 },
        { id: "t-uncovered", label: "u", cwd, shell: "cmd", pid: 3, status: "running", agentId: "uncovered-agent", createdAt: now - 60_000 },
        { id: "t-shell", label: "s", cwd, shell: "cmd", pid: 4, status: "running", createdAt: now - 60_000 },
      ],
      scanAgentConversations: async () => {
        kimiScans += 1;
        return [];
      },
    });
    for (let round = 0; round < 3; round += 1) {
      const { req, res } = fakeReqRes("/panel/api/terminal/sessions", "GET");
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
    }
    await flushAsyncSideEffects();
    assert.equal(kimiScans, 0, "已绑定、已退出、名单外、纯外壳四类都不扫");
    // 换一个未绑定的 running kimi 会话进来：第一轮列表只扫一次，防抖窗口内
    // 的后续列表不重复扫。
    const router2 = listRouter({
      root,
      sessions: [
        { id: "t-new", label: "k3", cwd, shell: "cmd", pid: 5, status: "running", agentId: "kimi", createdAt: now - 60_000 },
      ],
      scanAgentConversations: async () => {
        kimiScans += 1;
        return [];
      },
    });
    for (let round = 0; round < 3; round += 1) {
      const { req, res } = fakeReqRes("/panel/api/terminal/sessions", "GET");
      await router2.handle(req, res);
    }
    await flushAsyncSideEffects();
    assert.equal(kimiScans, 1, "同一未绑定会话在防抖窗内只扫一拍");
  });

  it("扫描判不出（并列）则不绑定，下轮列表还可再试", async () => {
    const root = mkTestDir("anyswitch-capture-tie-root-");
    const cwd = mkTestDir("anyswitch-capture-tie-cwd-");
    const now = Date.now();
    const router = listRouter({
      root,
      sessions: [
        { id: "t-tie", label: "k", cwd, shell: "cmd", pid: 9, status: "running", agentId: "kimi", createdAt: now - 60_000 },
      ],
      scanAgentConversations: async () => [
        { endpoint: "kimi", id: "conv-a", project: cwd, createdAt: now - 1000, lastActive: now },
        { endpoint: "kimi", id: "conv-b", project: cwd, createdAt: now - 900, lastActive: now },
      ],
    });
    const { req, res } = fakeReqRes("/panel/api/terminal/sessions", "GET");
    await router.handle(req, res);
    await flushAsyncSideEffects();
    assert.equal(readTerminalBindings(root), null, "判不出就宁缺毋滥");
  });
});

// 前端：「+」开菜单（已安装 CLI Agent 单选 + 工作目录）、createAgentTerminal
// 走新路由、成功分支登记会话并渲染；空白终端保留原 POST 逻辑。
describe("一键启动 CLI Agent（前端菜单 + 启动链路）", () => {
  function extractFn(name) {
    const src = panelJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
    assert.ok(src, `${name} found in panel.js`);
    return src;
  }

  // 纯函数在 vm 里真跑（同归属前科的取样式）；出口统一 JSON 往返，防跨原型误判。
  // terminalBackendSession 引用模块级默认目录变量，vm 域里补一份同值定义。
  const VM_TERMINAL_DEFAULT_CWD = 'let terminalDefaultCwd = "";';
  async function vmFn(name, args, deps = []) {
    const source = [name, ...deps].map(extractFn).join("\n");
    const fn = await vm.runInNewContext(`(() => { ${VM_TERMINAL_DEFAULT_CWD}\n${source}; return ${name}; })()`, {});
    const result = fn(...args);
    return result === undefined || result === null ? result : JSON.parse(JSON.stringify(result));
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  function addMenuSandbox({ environment, environmentError } = {}) {
    const bodies = ["closeTerminalAddMenu", "loadInstalledTerminalAgents", "renderTerminalAddMenuList",
      "positionTerminalAddMenu", "openTerminalAddMenu", "selectTerminalAddAgent", "createAgentTerminal", "confirmTerminalAddMenu", "terminalCreateSize",
      // 新终端置活跃要写存档；沙盒的 localStorage 用内存桩真跑，不碰真存档。
      "rememberTerminalSessionId",
      // 目录解析三件套：confirm 记目录、open 预填，都靠它们取默认值与持久化。
      "rememberTerminalCwd", "loadTerminalCwd", "terminalCwdInitial"]
      .map(extractFn).join("\n");
    const btnRect = { left: 400, right: 430, top: 12, bottom: 42 };
    const barRect = { left: 0, top: 0, width: 1200 };
    const bar = { getBoundingClientRect: () => barRect };
    const els = {
      terminalAddMenu: {
        hidden: true, style: {}, offsetWidth: 256,
        closest: (sel) => (sel === ".terminal-tabs-bar" ? bar : null),
      },
      terminalAddMenuList: { innerHTML: "", querySelectorAll: () => [] },
      terminalAddMenuNote: { hidden: true, textContent: "" },
      terminalAddMenuCwd: { value: "D:\\work" },
      terminalAddBtn: { getBoundingClientRect: () => btnRect },
    };
    const log = { posts: [], toasts: [], renders: 0, environmentFetches: 0 };
    const api = (method, path, body) => {
      if (path === "/api/environment") {
        log.environmentFetches += 1;
        return environmentError ? Promise.reject(environmentError) : Promise.resolve(environment);
      }
      log.posts.push({ method, path, body });
      return Promise.resolve({ id: "t-new", label: "Kimi Code", agentId: "kimi", agentName: "Kimi Code", shell: "cmd", cwd: "D:\\work" });
    };
    const escapeHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const store = {};
    const localStorageStub = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    };
    const sandbox = new Function("$", "api", "toast", "panelError", "terminalBackendSession",
      "terminalBackendSessions", "renderTerminalPreviewSession", "escapeHtml", "localStorage", `
      // 活跃指针与唯一 xterm 实例是模块级平铺单值，沙箱照摆一份。
      let activeTerminalPreviewId = null;
      let terminalXterm = null;
      let terminalDefaultCwd = "C:\\\\Users\\\\fixture";
      const TERMINAL_ADD_MENU_AGENT_IDS = ["claude", "codex", "kimi", "pi", "dsh", "opencode", "grok", "qoder", "zcode"];
      let terminalAddMenuAgents = [];
      let terminalAddMenuAgentsAt = 0;
      let terminalAddMenuSelection = "";
      ${bodies}
      return {
        load: loadInstalledTerminalAgents,
        render: renderTerminalAddMenuList,
        open: openTerminalAddMenu,
        select: selectTerminalAddAgent,
        confirm: confirmTerminalAddMenu,
        activeId: () => activeTerminalPreviewId,
        sessions: terminalBackendSessions,
      };
    `)((id) => els[id] ?? null, api,
      (msg, isErr) => log.toasts.push({ msg, isErr }),
      (err, fallback) => fallback,
      (item) => ({ ...item }),
      {}, () => { log.renders += 1; }, escapeHtml, localStorageStub);
    return { sandbox, els, log, btnRect, store };
  }

  const ENVIRONMENT = {
    clients: [
      { id: "claude", name: "Claude Code", installations: [{ status: "found", kind: "cli", path: "C:\\claude.exe" }] },
      { id: "codex", name: "Codex", installations: [{ status: "not_found", kind: "cli" }] },
      { id: "kimi", name: "Kimi Code", installations: [{ status: "found", kind: "cli", path: "C:\\kimi.cmd" }] },
      { id: "zcode", name: "ZCode", installations: [{ status: "found", kind: "cli", path: "C:\\zcode\\bin\\zcode.mjs" }, { status: "found", kind: "desktop" }] },
      { id: "qoder", name: "Qoder", installations: [{ status: "found", kind: "cli" }] },
    ],
  };

  it("已安装清单：只收白名单内 status=found 且 kind=cli 的端点", async () => {
    const { sandbox, els, log } = addMenuSandbox({ environment: ENVIRONMENT });
    const agents = await sandbox.load();
    assert.deepEqual(agents.map((a) => a.id), ["claude", "kimi", "zcode", "qoder"], "未安装（status≠found）不进菜单；zcode 桌面端是 GUI，但 CLI 形态经 launcher 进终端");
    assert.equal(log.environmentFetches, 1);
    await sandbox.load();
    assert.equal(log.environmentFetches, 1, "60s TTL 内不重复探测");

    sandbox.render(agents);
    assert.ok(els.terminalAddMenuList.innerHTML.includes("空白终端"), "首项恒为空白终端");
    assert.ok(els.terminalAddMenuList.innerHTML.includes("Claude Code"));
    assert.ok(els.terminalAddMenuList.innerHTML.includes("Kimi Code"));
    assert.ok(els.terminalAddMenuList.innerHTML.includes("Qoder"), "qoder 已有 CLI 形态，进新建菜单");
    assert.ok(els.terminalAddMenuList.innerHTML.includes("ZCode"), "zcode 桌面端是 GUI，但 CLI 形态经 launcher 进终端，进新建菜单");
    assert.equal(els.terminalAddMenuNote.hidden, true, "有可用 agent 时不显示提示");
  });

  it("启动方式列表双预热：面板启动与进终端页各补一次", () => {
    const init = panelJs.match(/function initTerminalPreview\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(init, "initTerminalPreview found in panel.js");
    assert.ok(init.includes("loadInstalledTerminalAgents()"), "面板启动即预热，点「+」不等探测");
    const sw = panelJs.match(/function switchView\(name\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(sw, "switchView found in panel.js");
    const termBranch = sw.slice(sw.indexOf("if (terminal) {"));
    const branchBody = termBranch.slice(0, termBranch.indexOf("\n    }"));
    assert.ok(branchBody.includes("loadInstalledTerminalAgents()"), "进终端页补热——60s TTL 内近零成本，过期才真实探测");
  });

  it("探测失败只留空白终端并说明；一个都没装也说明", async () => {
    const failed = addMenuSandbox({ environmentError: new Error("HTTP 500") });
    assert.equal(await failed.sandbox.load(), null, "失败返回 null 且不进缓存");
    failed.sandbox.render(null);
    assert.equal(failed.els.terminalAddMenuNote.hidden, false);
    assert.equal(failed.els.terminalAddMenuNote.textContent, "暂时读不到已安装的 CLI Agent，可以先建空白终端");

    const none = addMenuSandbox({ environment: { clients: [{ id: "kimi", name: "Kimi Code", installations: [{ status: "not_found", kind: "cli" }] }] } });
    assert.deepEqual(await none.sandbox.load(), []);
    none.sandbox.render([]);
    assert.equal(none.els.terminalAddMenuNote.hidden, false);
    assert.equal(none.els.terminalAddMenuNote.textContent, "尚未安装可用的 CLI Agent，可以先建空白终端");
  });

  it("createAgentTerminal POST 到新路由，成功分支登记会话、置活跃、重渲", async () => {
    const { sandbox, els, log } = addMenuSandbox({ environment: ENVIRONMENT });
    await sandbox.load();
    sandbox.select("kimi");
    await sandbox.confirm();
    await flush();
    assert.equal(els.terminalAddMenu.hidden, true, "确认即收起菜单");
    assert.deepEqual(log.posts, [{
      method: "POST", path: "/api/terminal/agent-sessions",
      body: { agentId: "kimi", cwd: "D:\\work", cols: 120, rows: 34 },
    }], "只递 agentId 与工作目录，凭证在服务端组装");
    assert.ok(sandbox.sessions["t-new"], "成功分支登记终端会话");
    assert.equal(sandbox.activeId(), "t-new", "新终端置为活跃");
    assert.equal(log.renders, 1, "成功分支重渲会话");
    assert.equal(log.toasts.length, 0);
  });

  it("空白终端保留原 POST 逻辑；启动失败落 toast 不建会话", async () => {
    const blank = addMenuSandbox({ environment: ENVIRONMENT });
    await blank.sandbox.confirm(); // 默认选中空白终端
    await flush();
    assert.deepEqual(blank.log.posts, [{
      method: "POST", path: "/api/terminal/sessions",
      body: { label: "Anyswitch", cwd: "D:\\work", shell: "powershell", cols: 120, rows: 34 },
    }], "空白终端用菜单里填的工作目录，不再写死 D:\\dev");

    // 启动失败：服务端 4xx/5xx（英文短码）→ toast 落中文兜底，不登记会话。
    const toasts = [];
    const sessions = {};
    const rejectApi = (method, path) => (path === "/api/terminal/agent-sessions"
      ? Promise.reject(Object.assign(new Error("HTTP 400"), { code: "invalid_cwd" }))
      : Promise.resolve({}));
    const fn = new Function("api", "toast", "panelError", "terminalBackendSession",
      "terminalBackendSessions", "renderTerminalPreviewSession", `
      let activeTerminalPreviewId = null;
      let terminalXterm = null;
      ${extractFn("terminalCreateSize")}
      ${extractFn("createAgentTerminal")}
      return { createAgentTerminal, sessions: terminalBackendSessions };
    `)(rejectApi, (msg, isErr) => toasts.push({ msg, isErr }), (err, fallback) => fallback,
      (item) => ({ ...item }), sessions, () => {});
    await fn.createAgentTerminal({ agentId: "claude", cwd: "D:\\gone" });
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].isErr, true);
    assert.equal(toasts[0].msg, "无法启动这个终端", "英文短码落中文兜底；服务端中文文案会优先上屏");
    assert.deepEqual(Object.keys(fn.sessions), [], "失败不登记会话");
  });

  it("open 开菜单即拉清单并渲染；「+」onclick 切换菜单", async () => {
    const { sandbox, els, log } = addMenuSandbox({ environment: ENVIRONMENT });
    await sandbox.open();
    await flush();
    assert.equal(els.terminalAddMenu.hidden, false, "开菜单");
    assert.equal(log.environmentFetches, 1);
    assert.ok(els.terminalAddMenuList.innerHTML.includes("空白终端"), "开菜单即渲染清单");

    const onclick = panelJs.match(/\$\("terminalAddBtn"\)\.onclick = \(\) => \{[\s\S]*?\n    \};/)?.[0];
    assert.ok(onclick, "「+」的 onclick 可取样");
    assert.ok(onclick.includes("openTerminalAddMenu()"), "就绪即开新建菜单");
    assert.ok(onclick.includes("closeTerminalAddMenu()"), "再点一次收起");
    assert.ok(onclick.includes("terminalPreviewSessions"), "降级预览分支原样保留");
  });

  it("菜单挂「+」右侧：左缘贴加号右缘，右侧放不下时翻到加号左侧", async () => {
    const { sandbox, els, btnRect } = addMenuSandbox({ environment: ENVIRONMENT });
    await sandbox.open();
    await flush();
    assert.equal(els.terminalAddMenu.style.left, "438px", "默认开在加号右侧（左缘贴加号右缘）");
    assert.equal(els.terminalAddMenu.style.top, "48px", "顶缘贴加号底缘，不盖页签");
    btnRect.left = 1160;
    btnRect.right = 1190;
    await sandbox.open();
    assert.equal(els.terminalAddMenu.style.left, "896px", "右侧放不下时翻到加号左侧，始终紧邻加号不出血");
    assert.ok(panelJs.includes("if (menu && !menu.hidden) positionTerminalAddMenu();"),
      "窗口 resize 时开着的菜单跟着加号重挂，不脱节");
  });

  it("标签副行优先显示 agentName；terminalBackendSession 带上 agent 身份", async () => {
    const carried = await vmFn("terminalBackendSession", [{
      id: "t1", label: "Kimi Code", cwd: "D:\\work", shell: "cmd", pid: 777,
      agentId: "kimi", agentName: "Kimi Code",
    }]);
    assert.equal(carried.agentId, "kimi");
    assert.equal(carried.agentName, "Kimi Code");
    const plain = await vmFn("terminalBackendSession", [{ id: "t2", label: "新终端", shell: "powershell", pid: 1 }]);
    assert.equal(plain.agentId, null, "纯外壳会话不带 agent 身份");
    assert.equal(plain.agentName, null);

    const src = extractFn("renderTerminalPreviewTabs");
    const escapeHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const runTabs = (sessions) => {
      const tabs = { innerHTML: "" };
      const fn = new Function("$", "escapeHtml", "sessions", `
        let terminalTabsRenderedHtml = "";
        let activeTerminalPreviewId = "t1";
        const TERMINAL_RAIL_SPINNER = '<span class="rail-term-spinner">SPINNER-STUB</span>';
        function terminalSessionMap() { return sessions; }
        ${src}
        return renderTerminalPreviewTabs;
      `)((id) => (id === "terminalTabs" ? tabs : null), escapeHtml, sessions);
      fn();
      return tabs.innerHTML;
    };
    const agentTab = runTabs({
      t1: { label: "Kimi Code", shell: { name: "命令提示符" }, agentName: "Kimi Code", agent: null, status: "idle" },
    });
    assert.ok(agentTab.includes("<small>Kimi Code</small>"), "快照自带 agentName 时优先显示");
    const attributedTab = runTabs({
      t1: { label: "新终端", shell: { name: "PowerShell" }, agentName: null, agent: { name: "Claude Code" }, status: "idle" },
    });
    assert.ok(attributedTab.includes("<small>Claude Code</small>"), "归属注入的 agent.name 次之");
    const shellTab = runTabs({
      t1: { label: "新终端", shell: { name: "PowerShell" }, agentName: null, agent: null, status: "idle" },
    });
    assert.ok(shellTab.includes("<small>PowerShell</small>"), "都没有时回落外壳名");

    // 页签左图标：身份已知（归属 endpointId / 快照 agentId）挂品牌槽位，纯外壳维持徽标
    const brandTab = runTabs({
      t1: { label: "新终端", shell: { name: "PowerShell" }, agentName: null, agent: { name: "Claude Code", endpointId: "claude" }, status: "idle" },
    });
    assert.ok(brandTab.includes('class="terminal-tab-brand" data-terminal-brand="claude"'), "归属会话左图标改品牌槽位");
    assert.ok(brandTab.includes('data-terminal-brand="claude"><span class="terminal-tab-shell"'), "槽位默认内容留外壳徽标兜底");
    const launchedTab = runTabs({
      t1: { label: "Kimi Code", shell: { name: "命令提示符" }, agentId: "kimi", agentName: "Kimi Code", agent: null, status: "idle" },
    });
    assert.ok(launchedTab.includes('data-terminal-brand="kimi"'), "一键启动快照 agentId 同样挂品牌槽位");
    assert.ok(!shellTab.includes("data-terminal-brand"), "纯外壳会话维持外壳徽标，不出品牌槽位");
    const weirdTab = runTabs({
      t1: { label: "新终端", shell: { name: "PowerShell" }, agentName: null, agent: { name: "x", endpointId: 'bad"id' }, status: "idle" },
    });
    assert.ok(!weirdTab.includes("data-terminal-brand"), "非常规字符的品牌 id 被白名单拦下，回落外壳徽标");

    // 品牌头像克隆后填：有 document 时槽位内容被看板 .agent-avatar 克隆整体替换
    const avatarClone = { marker: "avatar-clone" };
    const slotStub = {
      filled: null,
      getAttribute: (name) => (name === "data-terminal-brand" ? "claude" : null),
      replaceChildren(node) { this.filled = node; },
    };
    const tabsStub = {
      innerHTML: "",
      querySelectorAll: (sel) => (sel === "[data-terminal-brand]" ? [slotStub] : []),
    };
    const docStub = {
      queried: "",
      querySelector(sel) { this.queried = sel; return { cloneNode: () => avatarClone }; },
    };
    globalThis.document = docStub;
    try {
      new Function("$", "escapeHtml", "sessions", `
        let terminalTabsRenderedHtml = "";
        let activeTerminalPreviewId = "t1";
        const TERMINAL_RAIL_SPINNER = "";
        function terminalSessionMap() { return sessions; }
        ${extractFn("renderTerminalPreviewTabs")}
        return renderTerminalPreviewTabs;
      `)((id) => (id === "terminalTabs" ? tabsStub : null), escapeHtml, {
        t1: { label: "新终端", shell: { name: "PowerShell" }, agentName: null, agent: { name: "Claude Code", endpointId: "claude" }, status: "idle" },
      })();
    } finally {
      delete globalThis.document;
    }
    assert.ok(docStub.queried.includes('.panel-card[data-agent-id="claude"] .agent-avatar'), "克隆来源是看板卡头像");
    assert.equal(slotStub.filled, avatarClone, "头像克隆整体替换槽位默认徽标");
  });

  it("页签指示位 dsh 四态子集：工作态复用栏内转圈、idle 空槽无灰点、定宽防挤动", () => {
    const escapeHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const runTabs = (sessions) => {
      const tabs = { innerHTML: "" };
      new Function("$", "escapeHtml", "sessions", `
        let terminalTabsRenderedHtml = "";
        let activeTerminalPreviewId = "t1";
        const TERMINAL_RAIL_SPINNER = '<span class="rail-term-spinner">SPINNER-STUB</span>';
        function terminalSessionMap() { return sessions; }
        ${extractFn("renderTerminalPreviewTabs")}
        return renderTerminalPreviewTabs;
      `)((id) => (id === "terminalTabs" ? tabs : null), escapeHtml, sessions)();
      return tabs.innerHTML;
    };
    const base = { label: "新终端", shell: { name: "PowerShell" }, agentName: null, agent: null };
    const working = runTabs({ t1: { ...base, status: "working" } });
    assert.ok(working.includes("SPINNER-STUB"), "工作态填栏内同款转圈组件（复用 TERMINAL_RAIL_SPINNER）");
    assert.ok(working.includes('title="进行中"'), "工作态悬停提示「进行中」");
    assert.ok(!working.includes("is-working"), "绿点光晕类名不出现（图标面退役）");
    const idle = runTabs({ t1: { ...base, status: "idle" } });
    assert.ok(idle.includes('<span class="terminal-tab-state"></span>'), "idle 指示位是空常驻槽（dsh：idle 不画任何图标）");
    assert.ok(!idle.includes("SPINNER-STUB"), "idle 无转圈");
    assert.ok(!idle.includes("is-idle"), "灰点类名不出现（图标面退役）");
    assert.ok(!idle.includes('title="空闲"') && !idle.includes('title="进行中"'), "「空闲」tooltip 随灰点消失，idle 无悬停提示");
    // 定宽防挤动：指示位是常驻槽（与栏内行首槽同原则），转圈出现/消失不推挤
    // 页签文字；绿点光晕（is-working）与灰点（is-idle）两条规则随图标面清用删除。
    const slot = panelCss.match(/\.terminal-tab-state \{([^}]*)\}/)?.[1] ?? "";
    assert.ok(/width:\s*16px/.test(slot) && /height:\s*20px/.test(slot) && /flex:\s*none/.test(slot),
      "指示位常驻定宽槽 16×20 不参与伸缩");
    assert.ok(!panelCss.includes(".terminal-tab-state.is-working") && !panelCss.includes(".terminal-tab-state.is-idle"),
      "页签绿点/灰点死规则已删（文字状态条 .terminal-live-status.is-idle 是另一面）");
  });

  it("监测区 agent 徽标整体退役：身份标注由页签副行承担，节点/JS/CSS 无残留", () => {
    assert.ok(!panelHtml.includes("terminalAgentBadge"), "HTML 无徽标节点");
    assert.ok(!panelJs.includes("terminalAgentBadge"), "JS 无徽标引用残留（写入或类名切换漏删都会让徽标诈尸）");
    assert.ok(!panelCss.includes("terminal-agent-badge"), "CSS 徽标样式一并退役");
    assert.ok(extractFn("renderTerminalPreviewTabs").includes("session.agentName || (session.agent ? session.agent.name : session.shell.name)"),
      "页签副行仍是唯一 agent 身份位：agentName 优先、实时归属次之、外壳名兜底");
  });

  it("源码钉死：白名单与后端一致，菜单结构与样式就位", () => {
    const ids = panelJs.match(/const TERMINAL_ADD_MENU_AGENT_IDS = \[([^\]]+)\]/)?.[1];
    assert.ok(ids, "前端白名单可取样");
    const frontendIds = ids.split(",").map((s) => s.trim().replace(/"/g, ""));
    assert.deepEqual(frontendIds, Object.keys(AGENT_TERMINAL_TARGETS),
      "前端白名单与 agent-session-env 的 AGENT_TERMINAL_TARGETS 一一对应，禁漂移");

    assert.ok(panelHtml.includes('id="terminalAddMenu" hidden'), "菜单默认隐藏");
    for (const id of ["terminalAddMenuList", "terminalAddMenuNote", "terminalAddMenuCwd", "terminalAddMenuCancel", "terminalAddMenuConfirm"]) {
      assert.ok(panelHtml.includes(`id="${id}"`), `菜单节点 ${id} 就位`);
    }
    // 默认目录接口：面板转发到终端宿主的 /terminal/default-cwd，宿主按当前用户给主目录。
    assert.ok(panelJs.includes('api("GET", "/api/terminal/default-cwd")'), "前端向默认目录接口取默认目录");
    assert.ok(terminalHostJs.includes('"/terminal/default-cwd"'), "终端宿主提供默认目录接口");
    assert.ok(terminalHostJs.includes("process.env.USERPROFILE"), "默认目录跟随当前用户主目录，不写死某个用户名");
    assert.ok(panelHtml.includes(">空白终端<") === false && panelJs.includes("空白终端"), "空白首项由脚本渲染，HTML 不写死");
    assert.ok(panelCss.includes(".terminal-add-menu {"), "菜单样式就位");
    assert.ok(panelCss.includes(".terminal-add-menu[hidden] { display: none; }"), "hidden 语义不被 flex 覆盖");
    assert.ok(panelCss.includes(".terminal-add-menu-item.is-selected"), "选中态有视觉反馈");

    // 默认工作目录：跟随当前用户主目录，由后端接口给出，绝不写死某个用户名路径、
    // 也绝不落到软件安装目录。前端不再持有写死常量，HTML 输入框不写死 value。
    assert.ok(!panelJs.includes("AppData\\\\Local\\\\Anyswitch\\\\app"), "前端不再写死安装目录作默认");
    assert.ok(!panelHtml.includes("AppData\\Local\\Anyswitch\\app"), "目录输入框不再写死默认值");
    const fetchSrc = panelJs.match(/async function fetchTerminalSessions\([\s\S]*?\n  \}/)?.[0];
    assert.ok(fetchSrc && !fetchSrc.includes('api("POST", "/api/terminal/sessions"'),
      "首载零会话不自动补建：新建只留用户动作，零页签刷新恢复落空态");
    const confirmSrc = extractFn("confirmTerminalAddMenu");
    assert.ok(confirmSrc.includes("|| terminalCwdInitial()"), "菜单未填目录时回落终端目录解析");
    assert.ok(confirmSrc.includes("rememberTerminalCwd(cwd)"), "确认即记住本次目录");
    assert.ok(confirmSrc.includes('{ label: "Anyswitch", cwd, shell: "powershell"'), "空白终端用菜单里填的工作目录，不写死");
    // 取值顺序与持久化键钉死：上次目录优先于后端默认。
    const initialSrc = extractFn("terminalCwdInitial");
    assert.ok(initialSrc.includes("loadTerminalCwd() || terminalDefaultCwd"), "上次用过的目录优先于后端主目录默认");
    assert.ok(extractFn("rememberTerminalCwd").includes('localStorage.setItem("panel-terminal-cwd"'), "目录持久化键 panel-terminal-cwd");
    assert.ok(extractFn("openTerminalAddMenu").includes("cwdInput.value = terminalCwdInitial()"), "开菜单即预填解析出的目录");
  });
});

// ─────────────────────────────────────────────────────────────
// 前端调用路径 ↔ 服务端路由契约
//
// panel.js 的 api() / request() 会把 API_BASE（origin + "/panel"）拼在传入路径前面，
// 所以传入路径必须以 /api/ 开头。写成 "/panel/api/..." 会拼出 /panel/panel/api/...，
// 落到路由表末尾的 404；而 404 的 error 是英文 "not found"，会被前端的 panelError
// 折成调用方的中文兜底，界面上只剩一句笼统的失败，看不出是路径写错。
//
// 2026-10-02 修的就是这一类：数据搬迁的四条调用（导出选位置、导入选包、导入落定、
// 改 Skills 位置）全部写成双前缀，该功能自 09-23 上线起从未可用——连选择框都没被
// 调到过，所以前两次「修选择框归属」的改动自然都没效果。
//
// 原先只有一条守卫，且正则把被调函数名写死为 api(，改用 request( 的四条直接逃逸。
// 这里改成两道：按调用形式收全所有路径 + 逐条对服务端路由表。新增端点若只改了
// 一边，这条会立刻红。
describe("panel.html 前端调用路径与服务端路由一致", () => {
  // 客户端拼 URL 的三种写法：api()/request() 传路径、API_BASE + 字面量、模板串。
  const CLIENT_CALL_RES = [
    /\b(?:api|request)\(\s*"(?:GET|POST|PUT|DELETE)",\s*"([^"]+)"/g,
    /API_BASE\s*\+\s*"([^"]+)"/g,
    /\$\{API_BASE\}([^`"']*)/g,
  ];

  function clientPaths(source) {
    const found = new Map(); // 路径 → 首次出现的行号
    for (const re of CLIENT_CALL_RES) {
      for (const m of source.matchAll(re)) {
        let p = m[1];
        if (!p.startsWith("/")) continue;
        const dollar = p.indexOf("$");
        if (dollar >= 0) p = p.slice(0, dollar); // 模板变量段截断，留静态前缀
        if (!p) continue;
        if (!found.has(p)) found.set(p, source.slice(0, m.index).split("\n").length);
      }
    }
    return found;
  }

  // 服务端路由表：panel.mjs 里 path === / path.startsWith 的 /panel/api/... 字面量。
  function serverRoutes(source) {
    const exact = new Set();
    const prefixes = new Set();
    for (const m of source.matchAll(/path ===\s*"(\/panel\/api\/[^"]*)"/g)) exact.add(m[1]);
    for (const m of source.matchAll(/path\.startsWith\(\s*"(\/panel\/api\/[^"]*)"/g)) prefixes.add(m[1]);
    return { exact, prefixes };
  }

  const paths = clientPaths(panelJs);
  const { exact, prefixes } = serverRoutes(panelMjs);
  const routed = (full) => exact.has(full) || [...prefixes].some((pre) => full.startsWith(pre));

  it("每条前端路径都不带 /panel 前缀（双前缀 404 回归）", () => {
    assert.ok(paths.size > 0, "前端路径可取样");
    const bad = [...paths].filter(([p]) => p.startsWith("/panel/"));
    assert.deepEqual(bad, [],
      "以下调用会再拼一层 /panel 得到 /panel/panel/... → 404：\n" +
      bad.map(([p, line]) => `  panel.js:${line}  ${p}`).join("\n"));
  });

  it("每条前端路径都能在服务端找到对应路由", () => {
    const missing = [...paths].filter(([p]) => !routed("/panel" + p));
    assert.deepEqual(missing, [],
      "以下前端路径拼出的完整路径对不上任何服务端路由：\n" +
      missing.map(([p, line]) => `  panel.js:${line}  ${p}  →  /panel${p}`).join("\n"));
  });

  it("数据搬迁四条调用走 /api/ 且路由齐备（本次回归的钉子）", () => {
    for (const p of [
      "/api/data/export-pick",
      "/api/data/import-pick",
      "/api/data/import-apply",
      "/api/skills/repo/pick",
    ]) {
      assert.ok(paths.has(p), `前端应有 ${p}`);
      assert.ok(exact.has("/panel" + p), `服务端应有 /panel${p}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 被折叠的失败要留下可查的痕迹
//
// panelError 会把非中文的服务端原文换成调用方兜底，用户只看到一句笼统的话。
// 2026-10-02 的「导出未完成」正是这样：真因是路径写错拿到 404，而 404 的
// "not found" 没有中文，被折成兜底后界面上完全看不出。所以两条都要钉住：
//   1) 原文必须进面板日志（面板的日志页就能查到），不能只丢浏览器控制台；
//   2) 数据搬迁卡在被折叠时要说清「刷新页面重试」这条有意义的下一步。
describe("面板失败文案：折叠时留痕 + 数据搬迁给下一步", () => {
  // 从 panel.js 里摘出这几个纯函数单独跑，与 panel-advanced.test.mjs 摘
  // createDataBundleController 是同一手法。
  function loadHelpers() {
    const block = panelJs.match(/const PANEL_UI_COPY_RE = [\s\S]*?\n(?=async function api\()/);
    assert.ok(block, "panel.js 里的文案辅助块可取样");
    const warns = [];
    const posts = [];
    const ctx = {
      API_BASE: "http://127.0.0.1:47820/panel",
      console: { warn: (...a) => warns.push(a.join(" ")) },
      fetch: (url, opts) => { posts.push({ url, opts }); return Promise.resolve({ ok: true }); },
      String, JSON, Promise,
    };
    const helpers = vm.runInNewContext(
      `(() => { ${block[0]}\n return { panelError, panelFailure, PANEL_FAILURE_HINT }; })()`,
      ctx,
    );
    return { helpers, warns, posts };
  }

  it("中文服务端原文照原样上屏，不加尾巴、不记日志", () => {
    const { helpers, warns, posts } = loadHelpers();
    const err = Object.assign(new Error("HTTP 200：导出目录不存在，请重新选择"), { code: "导出目录不存在，请重新选择" });
    assert.equal(helpers.panelFailure(err, "导出未完成"), "导出目录不存在，请重新选择");
    assert.equal(warns.length, 0, "业务原因不算折叠，不必记日志");
    assert.equal(posts.length, 0);
  });

  it("非中文原文被折叠时：数据搬迁卡补「刷新页面重试」，并把原文送进面板日志", () => {
    const { helpers, warns, posts } = loadHelpers();
    const err = Object.assign(new Error("HTTP 404：not found"), { code: "not found" });
    assert.equal(helpers.panelFailure(err, "导出未完成"),
      "导出未完成（请刷新页面后重试；详情见面板日志）");
    assert.equal(warns.length, 1, "原文仍留一份到控制台");
    assert.equal(posts.length, 1, "原文要进面板日志");
    assert.equal(posts[0].url, "http://127.0.0.1:47820/panel/api/logs/ingest");
    const body = JSON.parse(posts[0].opts.body);
    assert.equal(body.level, "warn");
    assert.ok(body.message.includes("not found"), "日志里要带服务端原文，否则查不到真因");
    assert.ok(body.message.includes("导出未完成"), "日志里要带用户看到的兜底，便于对上号");
  });

  it("普通调用方的 panelError 保持原样（不补尾巴），但同样把原文记入日志", () => {
    const { helpers, posts } = loadHelpers();
    const err = Object.assign(new Error("HTTP 500：boom"), { code: "boom" });
    assert.equal(helpers.panelError(err, "请求失败"), "请求失败");
    assert.equal(posts.length, 1);
    assert.ok(JSON.parse(posts[0].opts.body).message.includes("boom"));
  });

  it("上报本身失败也绝不改变返回的文案", () => {
    const block = panelJs.match(/const PANEL_UI_COPY_RE = [\s\S]*?\n(?=async function api\()/)[0];
    const ctx = {
      API_BASE: "http://127.0.0.1:47820/panel",
      console: { warn: () => {} },
      fetch: () => { throw new Error("上报通道也挂了"); },
      String, JSON, Promise,
    };
    const helpers = vm.runInNewContext(
      `(() => { ${block}\n return { panelFailure }; })()`,
      ctx,
    );
    const err = Object.assign(new Error("HTTP 404：not found"), { code: "not found" });
    assert.equal(helpers.panelFailure(err, "导出未完成"),
      "导出未完成（请刷新页面后重试；详情见面板日志）",
      "上报是顺带的事，不能把原错误盖掉");
  });
});

// 终端宿主生命周期代理：状态/起停的真值都在 relay（47821 /terminal-host/*），
// 面板路由只做转发与兜底。relay 实现的应答把状态嵌在 host 下，面板端下发
// 平铺结构；状态词表（running/stopped/stopped-manual/crashed）原样透传——
// panel.js 的徽标与起停钮按这套词表渲染。
describe("panel router terminal-host lifecycle proxy", () => {
  function terminalHostRouter({ statusPayload = null, actionImpl = null } = {}) {
    const calls = { statusPulls: 0, actions: [] };
    const router = createPanelRouter({
      storePaths: { root: "C:/fake/anyswitch" },
      logger: null,
      metricsCollector: null,
      aliasResolver: null,
      aliasPath: null,
      getRelayStatusFn: async () => ({ status: "running", pid: 1234, port: 47821 }),
      fetchRelayAgents: async () => null,
      fetchTerminalHostStatus: async () => {
        calls.statusPulls += 1;
        return typeof statusPayload === "function" ? statusPayload() : statusPayload;
      },
      callTerminalHostAction: async (action, body) => {
        calls.actions.push({ action, body });
        return actionImpl ? actionImpl(action, body) : { status: 200, body: { ok: true, host: { state: "running", pid: 55, lastExit: null } } };
      },
    });
    return { router, calls };
  }

  it("GET /panel/api/terminal/host/status flattens the relay's host payload", async () => {
    const { router } = terminalHostRouter({
      statusPayload: { ok: true, host: { state: "running", pid: 4321, lastExit: null } },
    });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/host/status", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), { ok: true, state: "running", pid: 4321, manualStop: false, lastExit: null });
  });

  it("GET /panel/api/terminal/host/status passes a flat relay payload through", async () => {
    const { router } = terminalHostRouter({
      statusPayload: { ok: true, state: "stopped", pid: null, manualStop: true, lastExit: null },
    });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/host/status", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), { ok: true, state: "stopped", pid: null, manualStop: true, lastExit: null });
  });

  it("GET /panel/api/terminal/host/status keeps the state vocabulary and derives manualStop from stopped-manual", async () => {
    const { router } = terminalHostRouter({
      statusPayload: { ok: true, host: { state: "stopped-manual", pid: null, lastExit: null } },
    });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/host/status", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().state, "stopped-manual");
    assert.equal(json().manualStop, true);
  });

  it("GET /panel/api/terminal/host/status answers unknown instead of erroring when the relay is unreachable", async () => {
    const { router } = terminalHostRouter({ statusPayload: null });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/host/status", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), { ok: true, state: "unknown", pid: null, manualStop: false, lastExit: null });
  });

  it("POST /panel/api/terminal/host/start proxies to the relay and answers the resulting state", async () => {
    const { router, calls } = terminalHostRouter();
    const { req, res, json } = fakeReqRes("/panel/api/terminal/host/start", "POST", {});
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), { ok: true, state: "running" });
    assert.deepEqual(calls.actions, [{ action: "start", body: {} }]);
  });

  it("POST /panel/api/terminal/host/start answers 503 relay_unavailable when the relay is unreachable", async () => {
    const { router } = terminalHostRouter({ actionImpl: () => null });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/host/start", "POST", {});
    await router.handle(req, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(json(), { ok: false, error: "relay_unavailable" });
  });

  it("POST /panel/api/terminal/host/start passes a relay-side failure through untouched", async () => {
    const { router } = terminalHostRouter({
      actionImpl: () => ({ status: 500, body: { ok: false, error: "terminal host failed to start" } }),
    });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/host/start", "POST", {});
    await router.handle(req, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(json(), { ok: false, error: "terminal host failed to start" });
  });

  it("POST /panel/api/terminal/host/stop forwards the body verbatim and answers ok", async () => {
    const { router, calls } = terminalHostRouter({
      actionImpl: () => ({ status: 200, body: { ok: true, host: { state: "stopped-manual", pid: null, lastExit: null } } }),
    });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/host/stop", "POST", { clearSessions: true });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), { ok: true });
    assert.deepEqual(calls.actions, [{ action: "stop", body: { clearSessions: true } }]);
  });

  it("POST /panel/api/terminal/host/stop answers 503 relay_unavailable when the relay is unreachable", async () => {
    const { router } = terminalHostRouter({ actionImpl: () => null });
    const { req, res, json } = fakeReqRes("/panel/api/terminal/host/stop", "POST", { clearSessions: false });
    await router.handle(req, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(json(), { ok: false, error: "relay_unavailable" });
  });

  it("GET /panel/api/status carries terminalHost { state, manualStop } from the relay", async () => {
    const { router } = terminalHostRouter({
      statusPayload: { ok: true, host: { state: "crashed", pid: null, lastExit: { code: 1, signal: null, at: 999 } } },
    });
    const { req, res, json } = fakeReqRes("/panel/api/status", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json().terminalHost, { state: "crashed", manualStop: false });
    assert.equal(json().relay.status, "running");
  });

  it("GET /panel/api/status reports terminalHost unknown when the relay is unreachable", async () => {
    const { router } = terminalHostRouter({ statusPayload: null });
    const { req, res, json } = fakeReqRes("/panel/api/status", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json().terminalHost, { state: "unknown", manualStop: false });
  });

  it("GET /panel/api/status caches the host-status pull within its TTL instead of doubling relay pressure", async () => {
    const { router, calls } = terminalHostRouter({
      statusPayload: { ok: true, host: { state: "running", pid: 55, lastExit: null } },
    });
    const first = fakeReqRes("/panel/api/status", "GET");
    await router.handle(first.req, first.res);
    const second = fakeReqRes("/panel/api/status", "GET");
    await router.handle(second.req, second.res);
    assert.equal(calls.statusPulls, 1);
    assert.deepEqual(second.json().terminalHost, { state: "running", manualStop: false });
  });

  it("host start/stop invalidates the cached status so the next poll re-pulls", async () => {
    const { router, calls } = terminalHostRouter({
      statusPayload: { ok: true, host: { state: "running", pid: 55, lastExit: null } },
    });
    const before = fakeReqRes("/panel/api/status", "GET");
    await router.handle(before.req, before.res);
    assert.equal(calls.statusPulls, 1);
    const start = fakeReqRes("/panel/api/terminal/host/start", "POST", {});
    await router.handle(start.req, start.res);
    assert.equal(start.res.statusCode, 200);
    const after = fakeReqRes("/panel/api/status", "GET");
    await router.handle(after.req, after.res);
    assert.equal(calls.statusPulls, 2);
  });
});

// 2026-10-05：relay 进程活着、47821 在监听、探针也答得出来，但每一个真实请求都
// 在失败，连续 70 分钟。看板当时显示的是「运行中 / 运行正常」——把一次全灭盖成
// 了正常。这里锁住新增的第四态，以及它和原有三态的分界。
describe("看板 relay 状态呈现（含「服务异常」第四态）", () => {
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  function presentation(relay) {
    const source = panelJs.match(/function relayStatusPresentation\(relay, defaultPort\) \{[\s\S]*?\n  \}/);
    assert.ok(source, "relayStatusPresentation 在 panel.js 里，且是可直接取出的纯函数");
    const fn = new Function(`${source[0]}; return relayStatusPresentation;`)();
    return fn(relay, 47821);
  }

  it("在跑但服务不了 → 「服务异常」，不是「运行正常」", () => {
    const view = presentation({ status: "running", degraded: true, port: 47821 });
    assert.equal(view.statusText, "Relay 服务异常 (47821)");
    assert.equal(view.badgeText, "服务异常");
    assert.equal(view.badgeClass, "badge badge-warn", "既不是正常（ok）也不是已停止（danger）");
  });

  it("在跑且服务得了 → 仍是原来的「运行中 / 运行正常」", () => {
    const view = presentation({ status: "running", degraded: false, port: 47821 });
    assert.equal(view.statusText, "Relay 运行中 (47821)");
    assert.equal(view.badgeText, "运行正常");
    assert.equal(view.badgeClass, "badge badge-ok");
  });

  it("缺 degraded 字段（旧服务端）不误报服务异常", () => {
    const view = presentation({ status: "running", port: 47821 });
    assert.equal(view.badgeText, "运行正常", "没有这个字段就按正常显示，不能凭空报警");
  });

  it("启动中 / 已停止两态文案不变", () => {
    assert.equal(presentation({ status: "starting" }).statusText, "Relay 启动中...");
    assert.equal(presentation({ status: "starting" }).badgeText, "启动中");
    assert.equal(presentation({ status: "stopped" }).statusText, "Relay 已停止");
    assert.equal(presentation({ status: "stopped" }).badgeText, "已停止");
    assert.equal(presentation({ status: "stopped" }).badgeClass, "badge badge-danger");
  });
});

describe("设置项「缓存上游密钥」", () => {
  const panelJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
    "utf8",
  );
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8",
  );

  it("以既有的 .toggle 开关呈现，文案按约定", () => {
    // 只取这一条自己的 DOM 窗口：从它所属的 modal-item 开始到它自己的 </label>
    // 结束，否则非贪婪匹配会从文件里更早的 modal-item 起算，把别张卡的文字也算进来。
    const title = panelHtml.indexOf('<div class="modal-item-title">缓存上游密钥</div>');
    assert.ok(title > 0, "条目标题存在");
    const item = panelHtml.slice(
      panelHtml.lastIndexOf('<div class="modal-item">', title),
      panelHtml.indexOf("</label>", title) + "</label>".length,
    );
    assert.ok(item.includes('<label class="toggle">'), "沿用全局开关控件与各主题皮肤");
    assert.ok(item.includes('id="credentialCacheToggle"'), "开关有稳定 id 供读写");
    assert.ok(item.includes("建议仅在受信任环境中开启"), "把代价写在开关旁边，而不是留给用户去猜");
    // 这条是安全与速度的取舍，属于用户的决定；文案不得暗示实现细节。
    assert.ok(!/DPAPI|dpapi|进程|缓存命中|哈希|失效/.test(item), "不向用户暴露实现细节");
  });

  it("切换后 POST 该设置并以服务端回读值为准", async () => {
    const source = panelJs.match(/credentialCacheToggle\.onchange = async \(\) => \{[\s\S]*?\n      \};/);
    assert.ok(source, "onchange 处理器在 panel.js 里");
    const toggle = { checked: true, setAttribute() {}, removeAttribute() {} };
    const calls = [];
    const toasts = [];
    const settingsSaving = { credentialCache: false };
    const api = async (method, path, body) => {
      calls.push({ method, path, body });
      return { ok: true, settings: { credentialCacheEnabled: true } };
    };
    const run = new Function(
      "credentialCacheToggle", "settingsSaving", "api", "toast",
      `let settingsLoadGen = 0; ${source[0]} return credentialCacheToggle.onchange();`,
    );
    await run(toggle, settingsSaving, api, (m) => toasts.push(m));

    assert.deepEqual(calls, [{
      method: "POST",
      path: "/api/settings",
      body: { credentialCacheEnabled: true },
    }]);
    assert.equal(settingsSaving.credentialCache, false, "保存标记必须复位");
    assert.equal(toasts.length, 1);
  });
});

describe("自动同步失败上屏（sync-status 落盘 + 轮询 + 文案锚点）", () => {
  // 10-06 定稿：自动同步失败原先只进 relay 日志，而日志有「运行日志」活闸门——
  // 用户关掉后失败整条丢弃、完全静默。现在每次同步把结果落 sync-status.json，
  // 面板 3s 轮询上屏。这里钉住：状态小字容器、两句失败文案与 title 模板、
  // 轮询接线、路由注册，以及文案不得暴露实现细节。
  const here = dirname(fileURLToPath(import.meta.url));
  const panelHtml = readFileSync(join(here, "panel-ui", "panel.html"), "utf8");
  const panelJs = readFileSync(join(here, "panel-ui", "panel.js"), "utf8");
  const panelMjs = readFileSync(join(here, "panel.mjs"), "utf8");
  const relayHost = readFileSync(join(here, "relay-host.mjs"), "utf8");

  it("渠道页状态小字容器存在，复用刷新小字同款样式类", () => {
    assert.ok(
      panelHtml.includes('<span class="store-refresh-status" id="storeSyncStatus" aria-live="polite"></span>'),
      "storeSyncStatus DOM 存在且复用 store-refresh-status 样式类",
    );
  });

  it("两句失败文案与发生时间 title 模板上屏锚点", () => {
    assert.ok(panelJs.includes("上次同步未成功：${failed.map((id) => statsEndpointLabel(id)).join(\"、\")}"),
      "部分失败点名端点（经显示名翻译）");
    assert.ok(panelJs.includes("上次同步未成功：端点配置未更新"), "进程级失败的兜底句");
    assert.ok(panelJs.includes("发生时间：${formatSyncStatusAt(status.at)}"), "title 带发生时间");
  });

  it("失败文案不得暴露实现细节（store.json / 子进程 / watcher / 状态文件名）", () => {
    const copyLines = panelJs.split("\n").filter((line) =>
      line.includes("上次同步未成功") || line.includes("发生时间："));
    assert.ok(copyLines.length >= 3, "三句文案都被抓到");
    for (const line of copyLines) {
      assert.ok(!/store\.json|子进程|watcher|sync-status|防抖/.test(line),
        `文案含实现细节词: ${line.trim()}`);
    }
  });

  it("3s 轮询接线：跟随既有轮询写法，页面隐藏不取数", () => {
    assert.ok(panelJs.includes("function startSyncStatusPolling()"), "轮询入口存在");
    assert.ok(panelJs.includes('api("GET", "/api/sync-status")'), "api 自动加 /panel 前缀");
    const start = panelJs.indexOf("function startSyncStatusPolling()");
    const body = panelJs.slice(start, panelJs.indexOf("\n  }", start));
    assert.ok(body.includes("if (document.hidden) return;"), "隐藏页不取数");
    assert.ok(body.includes("3000"), "3 秒间隔");
    // init() 在文件前部、函数定义在后部：钉调用点与 startStatusPolling 同处，
    // 不能用「调用出现在定义之后」这种位置判据。
    const initAnchor = panelJs.indexOf("const firstStatus = startStatusPolling();");
    assert.ok(initAnchor >= 0, "init() 轮询起点锚点");
    assert.ok(panelJs.slice(initAnchor, initAnchor + 300).includes("startSyncStatusPolling();"),
      "init() 里接上了调用点");
  });

  it("边缘触发 toast：at 变化才弹、首帧历史失败不弹", () => {
    const start = panelJs.indexOf("async function pollSyncStatus()");
    assert.ok(start >= 0, "轮询函数存在");
    const body = panelJs.slice(start, panelJs.indexOf("\n  }\n", start));
    assert.ok(body.includes("syncStatusLastAt !== undefined"), "首帧不弹 toast 的守卫");
    assert.ok(body.includes("status.at !== syncStatusLastAt"), "新失败按 at 变化判定");
    assert.ok(body.includes("toast(syncStatusFailureText(status), true)"), "新失败弹 err toast");
  });

  it("路由注册存在，读不出文件时按「无从报告」返回而非 500", () => {
    assert.ok(panelMjs.includes('if (path === "/panel/api/sync-status" && method === "GET") return handleSyncStatus(res);'),
      "GET /panel/api/sync-status 路由注册");
    assert.ok(panelMjs.includes('{ ok: true, at: null, failed: [], synced: [] }'),
      "文件缺失/损坏的「无从报告」兜底形状");
  });

  it("四条同步路径都落盘（relay 启动/监视器/设置切换/手动路由）", () => {
    assert.ok(relayHost.includes('syncStatusFromResult(syncResult, "startup")'), "relay 启动同步");
    assert.ok(relayHost.includes('syncStatusFromResult(syncResult, "store-change")'), "store 监视器同步");
    assert.ok(panelMjs.includes('syncStatusFromResult(syncResult, "settings")'), "推理强度设置切换");
    assert.ok(panelMjs.includes('syncStatusFromResult(result, "manual")'), "手动同步路由");
  });
});

// ─────────────────────────────────────────────────────────────
// BYOK「导入本地配置」（面板前端）：入口按钮、勾选弹窗、回执生命周期。
// 服务端路由与票据服务由 panel.mjs / byok-import.mjs 承担（路由侧另有
// byok-import-api 测试）；这里钉前端的契约形状与逐字文案。纯函数摘出来在
// vm 里真跑（与 createDataBundleController 的摘取手法同源），胶水层走源码断言。
describe("BYOK 导入本地配置（面板前端）", () => {
  // 摘 panel.js 顶层的 2 空格缩进函数进 vm 跑；deps 先行注入（如 escapeHtml）
  function vmFn(name, deps = []) {
    const parts = [...deps, name].map((fnName) => {
      const body = panelJs.match(new RegExp(`  function ${fnName}\\([\\s\\S]*?\\n  \\}`))?.[0];
      assert.ok(body, `${fnName} found in panel.js`);
      return body;
    }).join("\n");
    return vm.runInNewContext(`(() => { ${parts}; return ${name}; })()`, {});
  }

  it("入口按钮在渠道总览按钮行（新增渠道与全部刷新之间）", () => {
    assert.ok(
      /id="storeAddBtn">新增渠道<\/button>[\s\S]{0,200}?id="storeImportLocalBtn">导入本地配置<\/button>[\s\S]{0,200}?id="storeRefreshAllBtn">全部刷新<\/button>/.test(panelHtml),
      "按钮行：新增渠道 → 导入本地配置 → 全部刷新",
    );
    assert.ok(panelJs.includes('$("storeImportLocalBtn").onclick = () => openByokImportModal();'),
      "点击接线到弹窗");
  });

  it("弹窗逐字文案在线（标题/导语/删除开关/脚注/空态/扫描中）", () => {
    const openStart = panelJs.indexOf("function openByokImportModal(");
    assert.ok(openStart >= 0, "openByokImportModal 存在");
    const open = panelJs.slice(openStart, panelJs.indexOf("\n  }\n", openStart));
    assert.ok(open.includes('title: "从本地配置导入"'), "弹窗标题");
    assert.ok(open.includes("以下是各端点本地配置中检出、尚未入库的渠道。勾选后导入中央库，并随同步分发到所有端点。"), "导语");
    assert.ok(open.includes("导入后移除端点本地的原始配置"), "删除本地开关标签");
    assert.ok(open.includes("移除前自动备份原文件；取消勾选则仅入库，本地原样保留。"), "删除开关小字");
    assert.ok(open.includes("Claude Code 没有可读取的本地渠道配置，不在其列"), "固定脚注");
    assert.ok(open.includes("加载中…"), "弹窗内先呈扫描中状态（复用既有文案）");
    assert.ok(open.includes('id="byokImportDeleteLocal" checked'), "删除本地默认勾选");
    assert.ok(open.includes('confirmText: "导入所选（0）"'), "确认按钮初始文案（0 时禁用）");
    assert.ok(open.includes("wide: true"), "宽弹窗");
    assert.ok(open.includes("onConfirm: applyByokImportSelection"), "确认接线");
    assert.ok(panelJs.includes("未检出可导入的本地渠道配置"), "空态文案");
  });

  it("扫描与入库走契约路径与契约 body", () => {
    assert.ok(panelJs.includes('api("POST", "/api/byok-import/scan", {})'), "scan 调用（无 body）");
    assert.ok(panelJs.includes('api("POST", "/api/byok-import/apply", { ticket: byokImportTicket, keys, deleteLocal })'),
      "apply body = { ticket, keys, deleteLocal }");
  });

  it("候选 key 不序列化进 DOM（勾选框只带下标）", () => {
    const start = panelJs.indexOf("function byokImportRowHtml(");
    const fn = panelJs.slice(start, panelJs.indexOf("\n  }\n", start));
    assert.ok(fn.includes("data-byok-idx"), "行内只带下标");
    assert.ok(!fn.includes("entry.key"), "key 不进 DOM（票据内存态）");
  });

  it("行渲染：ok 默认勾选，duplicate/密钥问题禁选并给逐字标注", () => {
    const rowHtml = vmFn("byokImportRowHtml", ["escapeHtml"]);
    const okRow = rowHtml({ key: "k1", displayName: "A6 API", baseURL: "https://a6.example.com/v1", modelCount: 3, status: "ok" }, 0);
    assert.ok(okRow.includes(" checked") && !okRow.includes("disabled"), "ok 行默认勾选、可改");
    assert.ok(okRow.includes("A6 API · https://a6.example.com/v1 · 3 个模型"), "行 = 渠道名 · 上游地址 · N 个模型");
    const dup = rowHtml({ key: "k2", displayName: "Dup", baseURL: "https://d.example.com", modelCount: 1, status: "duplicate" }, 1);
    assert.ok(dup.includes("disabled") && !dup.includes(" checked"), "duplicate 置灰禁选");
    assert.ok(dup.includes("已在库"), "duplicate 徽标");
    const unresolved = rowHtml({ key: "k3", displayName: "U", baseURL: "https://u.example.com", modelCount: 0, status: "unresolved-key" }, 2);
    assert.ok(unresolved.includes("disabled") && unresolved.includes("密钥无法读取，跳过"), "unresolved-key 标注");
    const noKey = rowHtml({ key: "k4", displayName: "N", baseURL: "https://n.example.com", modelCount: 0, status: "no-key" }, 3);
    assert.ok(noKey.includes("disabled") && noKey.includes("未配置密钥，跳过"), "no-key 标注");
  });

  it("回执拼装：删/不删打底，部分失败与移除失败依次追加", () => {
    const receipt = vmFn("byokImportReceiptText");
    assert.equal(receipt({ imported: 3, failed: [], removeFailed: [] }, true),
      "已导入 3 条渠道，本地原始配置已移除（原文件已备份）");
    assert.equal(receipt({ imported: 2, failed: [], removeFailed: [] }, false),
      "已导入 2 条渠道，本地配置原样保留");
    assert.equal(receipt({ imported: 2, failed: [{ key: "a", error: "x" }], removeFailed: [] }, false),
      "已导入 2 条渠道，本地配置原样保留，1 条失败（详情见面板日志）");
    assert.equal(receipt({ imported: 1, failed: [], removeFailed: [{ key: "b", error: "y" }] }, true),
      "已导入 1 条渠道，本地原始配置已移除（原文件已备份），1 处本地配置移除失败（详情见面板日志）");
    assert.equal(receipt({
      imported: 1,
      failed: [{ key: "a", error: "x" }, { key: "b", error: "z" }],
      removeFailed: [{ key: "c", error: "y" }],
    }, true),
      "已导入 1 条渠道，本地原始配置已移除（原文件已备份），2 条失败（详情见面板日志），1 处本地配置移除失败（详情见面板日志）");
  });

  it("回执落点：状态小字 + toast，人不在渠道 tab 置「等切回」", () => {
    const start = panelJs.indexOf("function landByokImportReceipt(");
    const fn = panelJs.slice(start, panelJs.indexOf("\n  }\n", start));
    assert.ok(fn.includes('setStoreRefreshStatus(text, isErr ? "err" : "done")'), "落渠道总览状态小字");
    assert.ok(fn.includes('if (currentView !== "store")'), "人不在渠道 tab 才置标记");
    assert.ok(fn.includes("storeStatusAwaitReturn = true;"), "等切回标记");
    assert.ok(fn.includes("disarmStoreStatusTimer()"), "暂停淡出等人切回");
    assert.ok(fn.includes("toast(text, isErr)"), "结果 toast");
  });

  it("票据过期给逐字提示且只认重新扫描；被折叠原文进面板日志", () => {
    const start = panelJs.indexOf("async function applyByokImportSelection(");
    const fn = panelJs.slice(start, panelJs.indexOf("\n  }\n", start));
    assert.ok(fn.includes('e.code === "ticket-expired"'), "过期短码分支");
    assert.ok(fn.includes('"导入票据已过期，请重新扫描"'), "过期逐字文案");
    assert.ok(!fn.includes("runByokImportScan()"), "过期不做静默重扫");
    assert.ok(fn.includes("reportMaskedPanelError("), "失败条目原文进面板日志");
    assert.ok(fn.includes("await refreshStoreState()"), "完成后走既有路径刷新渠道列表");
  });

  it("扫描中先呈加载态，回话按 skillsModalGen 代际防串台", () => {
    const openStart = panelJs.indexOf("function openByokImportModal(");
    const open = panelJs.slice(openStart, panelJs.indexOf("\n  }\n", openStart));
    assert.ok(open.includes("加载中…"), "弹窗内先呈扫描中状态");
    const scanStart = panelJs.indexOf("async function runByokImportScan(");
    const scan = panelJs.slice(scanStart, panelJs.indexOf("\n  }\n", scanStart));
    assert.ok(scan.includes("const gen = skillsModalGen"), "取代际");
    assert.ok(scan.includes("gen !== skillsModalGen"), "代际不符作废旧回话");
  });

  it("确认按钮文案随勾选数联动、0 时禁用", () => {
    const start = panelJs.indexOf("function updateByokImportConfirm(");
    const fn = panelJs.slice(start, panelJs.indexOf("\n  }\n", start));
    assert.ok(fn.includes("`导入所选（${n}）`"), "导入所选（N）");
    assert.ok(fn.includes("btn.disabled = n === 0"), "0 时禁用");
  });

  it("组头用端点显示名（取自既有 agent 元数据映射）", () => {
    const start = panelJs.indexOf("function renderByokImportGroups(");
    const fn = panelJs.slice(start, panelJs.indexOf("\n  }\n", start));
    assert.ok(fn.includes("statsEndpointLabel(g.agentId)"), "端点显示名取自 STATS_ENDPOINT_LABELS");
  });
});

// 新增渠道表单：显示名行移到渠道 ID 行上方；显示名输入时 id 行实时联动
// （合法化 = poolSlugify 同款规则再截 127），手动改过即断、清空恢复。
describe("新增渠道表单：显示名上移 + 渠道 ID 随显示名联动", () => {
  function vmFn(name, deps = []) {
    const parts = [...deps, name].map((fnName) => {
      const body = panelJs.match(new RegExp(`  function ${fnName}\\([\\s\\S]*?\\n  \\}`))?.[0];
      assert.ok(body, `${fnName} found in panel.js`);
      return body;
    }).join("\n");
    return vm.runInNewContext(`(() => { ${parts}; return ${name}; })()`, {});
  }

  it("单渠道表单：显示名行在渠道 ID 行上方", () => {
    const start = panelJs.indexOf("function showAddModal(");
    const fn = panelJs.slice(start, panelJs.indexOf("showSkillsModal({", start));
    const nameAt = fn.indexOf('id="storeAddName"');
    const idAt = fn.indexOf('id="storeAddId"');
    assert.ok(nameAt >= 0 && idAt >= 0, "两行都在");
    assert.ok(nameAt < idAt, "显示名在上");
  });

  it("号池资料组同样显示名在渠道 ID 上方", () => {
    const start = panelJs.indexOf("function addSetHtml(");
    const fn = panelJs.slice(start, panelJs.indexOf("\n  }\n", start));
    const nameAt = fn.indexOf("set-name");
    const idAt = fn.indexOf("set-id");
    assert.ok(nameAt >= 0 && idAt >= 0 && nameAt < idAt, "资料组内显示名在上");
  });

  it("联动合法化：小写、非法段折叠为 -、剥开头非字母数字、上限 127、纯中文留空", () => {
    const slug = vmFn("storeAddIdFromName", ["poolSlugify"]);
    assert.equal(slug("My Provider"), "my-provider");
    assert.equal(slug("  ANTHROPIC 专用 "), "anthropic");
    assert.equal(slug(".hidden"), "hidden");
    assert.equal(slug("渠道"), "", "纯中文合法化结果为空，留空不硬造");
    assert.equal(slug("a/b/c"), "a-b-c");
    assert.equal(slug("x".repeat(200)).length, 127, "上限 127");
    assert.ok(/^[a-z0-9][a-z0-9._-]*$/.test(slug("A Very Long Provider_Name.v2")), "产出恒合法形");
  });

  it("联动接线：手动改过即断、清空恢复；单渠道与资料组都接上", () => {
    const start = panelJs.indexOf("function wireStoreAddNameIdLinkage(");
    const fn = panelJs.slice(start, panelJs.indexOf("\n  }\n", start));
    assert.ok(fn.includes('idInput.dataset.touched !== "1"'), "未手动改过才联动");
    assert.ok(fn.includes("storeAddIdFromName(nameInput.value)"), "合法化后填入");
    assert.ok(fn.includes('idInput.dataset.touched = idInput.value.trim() ? "1" : "0"'), "清空即恢复联动");
    const modalStart = panelJs.indexOf("function showAddModal(");
    const modal = panelJs.slice(modalStart, panelJs.indexOf("async function submitAddSingleModal(", modalStart));
    assert.ok(modal.includes('wireStoreAddNameIdLinkage($("storeAddName"), $("storeAddId"))'), "单渠道接线");
    assert.ok(modal.includes('wireStoreAddNameIdLinkage(setEl.querySelector(".set-name"), setEl.querySelector(".set-id"))'), "资料组逐组接线");
  });

  it("开关切换与失败重开回填联动态（data-touched 随收集留存）", () => {
    const start = panelJs.indexOf("function collectAddModalValues(");
    const fn = panelJs.slice(start, panelJs.indexOf("\n  }\n", start));
    assert.ok(fn.includes('idTouched: ($("storeAddId")?.dataset.touched || "") === "1"'), "单渠道联动态入收集");
    assert.ok(fn.includes('idTouched: (setEl.querySelector(".set-id").dataset.touched || "") === "1"'), "资料组联动态入收集");
    const subStart = panelJs.indexOf("async function submitAddSingleModal(");
    const sub = panelJs.slice(subStart, panelJs.indexOf("\n  }\n", subStart));
    assert.ok(sub.includes('idTouched: $("storeAddId")?.dataset.touched === "1"'), "失败重开带回联动态");
    assert.ok(panelJs.includes('id="storeAddId" value="${escapeHtml(v.id || "")}" data-touched="${v.idTouched ? "1" : "0"}"'),
      "单渠道 id 行回填联动态");
    assert.ok(panelJs.includes('class="store-form-input set-id" value="${escapeHtml(s.id || "")}" data-touched="${s.idTouched ? "1" : "0"}"'),
      "资料组 id 行回填联动态");
  });
});

// ── 看板加载态（2026-10-07 报障：页面出现到加载出数据之间的中间态畸形）──
// 一页两件事：① 首帧静态默认必须是加载态而不是数据态；② 只有后端明说「这一帧能当
// 事实说」才翻 live。判定抽在 boardFrameVerdict 里，在 vm 里真跑（同 relayStatusPresentation
// 与终端字号的先例），静态那半钉住 html/css 的契约。
describe("看板加载态：首帧不撒谎，可信首帧才开口", () => {
  async function verdict(res) {
    const body = panelJs.match(/function boardFrameVerdict\([\s\S]*?\n  \}/)?.[0];
    assert.ok(body, "boardFrameVerdict 在册");
    return vm.runInNewContext(`(() => { ${body}; return boardFrameVerdict; })()`)(res);
  }

  it("可信帧与非可信帧按后端的话分", async () => {
    assert.equal(await verdict({ agents: [{ id: "claude" }], frame: { ready: true, source: "relay" } }), true);
    assert.equal(await verdict({ agents: [], frame: { ready: false, reason: "relay-timeout" } }), false);
    assert.equal(await verdict({ agents: [{ id: "claude" }], frame: { ready: false, reason: "relay-timeout" } }), false,
      "带着数据却明说不能当事实：仍不开口");
  });

  it("空帧与缺字段一律算「还没取到」", async () => {
    assert.equal(await verdict({ agents: [] }), false, "空数组不是成功帧（relay 停了以外没有理由发它）");
    assert.equal(await verdict({}), false);
    assert.equal(await verdict(null), false);
    assert.equal(await verdict(undefined), false);
  });

  it("旧后端不带 frame 时按非空 agents 兜底，行为与改前一致", async () => {
    assert.equal(await verdict({ agents: [{ id: "kimi" }] }), true);
  });

  it("首帧静态默认是加载态：九张卡都带骨架条，html 带 data-board=pending", () => {
    assert.ok(/<html lang="zh-CN" data-board="pending">/.test(panelHtml),
      "主脚本是 defer 外链，首绘早于第一拍取数——加载态只能由静态 HTML 自己带");
    assert.equal((panelHtml.match(/class="board-card-loading"/g) ?? []).length, 9);
    for (const id of ["zcode", "claude", "dsh", "pi", "qoder", "kimi", "opencode", "codex", "grok"]) {
      const at = panelHtml.indexOf(`<div class="panel-card" data-agent-id="${id}">`);
      assert.ok(at >= 0, `${id} 卡在册`);
      const topBar = panelHtml.indexOf('<div class="agent-top-bar">', at);
      const skel = panelHtml.indexOf('class="board-card-loading"', at);
      const nextCard = panelHtml.indexOf('<div class="panel-card" data-agent-id="', at + 1);
      assert.ok(topBar >= 0 && skel > topBar && (nextCard < 0 || skel < nextCard),
        `${id} 骨架条在品牌行之后、本卡之内——立在数据位上，pending 与 live 品牌行同位，flip 时标题不跳（2026-10-08 位置修正）`);
    }
  });

  it("加载态把卡内数据位整块压掉，只留品牌行与骨架条", () => {
    assert.ok(/html\[data-board="pending"\] \.agent-cards-container \.panel-card > div > :not\(\.agent-top-bar\):not\(\.board-card-loading\)\s*\{\s*display: none;?\s*\}/.test(panelCss),
      "pending 期卡内除品牌行与骨架条以外不出现");
    assert.ok(!/html\[data-board="pending"\][^{]*\.card-body/.test(panelCss),
      "压的是卡身里的数据块，不给 .card-body 写 display（skills 那张折叠卡的闸门会判违规）");
    assert.ok(/\.board-card-loading \{ display: none; \}/.test(panelCss),
      "非 pending 期骨架条不出（live 后不留残影）");
    assert.ok(/html\[data-board="pending"\] \.agent-cards-container \.agent-actions \{ visibility: hidden; \}/.test(panelCss),
      "徽标/折叠钮/实例计数是数据位，pending 期藏而不删，标题不换位");
  });

  it("pending 同帧盖住左列数据位：徽标与连接态藏而不删，监听地址值位立骨架", () => {
    // 左列静态默认写的是「运行正常」「127.0.0.1:47821」「● 在线 / ● 实时传输」——
    // 与右列「没取到不许画」同帧矛盾。徽标与状态行藏而不删（visibility，同
    // .agent-actions 口径：占位不跳），监听地址的值位立一条复用 .sessions-skel 的骨架。
    assert.ok(/html\[data-board="pending"\] #sbStateBadge,\s*html\[data-board="pending"\] #logConnBadge,\s*html\[data-board="pending"\] #logConn \{ visibility: hidden; \}/.test(panelCss),
      "服务状态徽标 / 日志连接徽标 / 实时传输行在 pending 期藏而不删");
    assert.ok(panelCss.includes('html[data-board="pending"] #sbHost { display: none; }'),
      "监听地址的写死默认值 pending 期不出现");
    assert.ok(/\.board-side-skel \{ display: none; \}/.test(panelCss),
      "左列骨架非 pending 期不出（live 后不留残影）");
    assert.ok(/html\[data-board="pending"\] \.board-side-skel \{ display: block;/.test(panelCss),
      "pending 期值位立骨架");
    const hostRow = panelHtml.match(/<div class="prop-row">\s*<span class="prop-name">监听地址<\/span>[\s\S]*?<\/div>/);
    assert.ok(hostRow, "监听地址行在册");
    assert.ok(hostRow[0].includes('id="sbHost">127.0.0.1:47821</span>'), "写死的静态默认值不动（文案不归这里改）");
    assert.ok(/sessions-skel board-side-skel/.test(hostRow[0]), "骨架条复用 sessions-skel、与写死值同一行");
  });

  it("flip 只有一处，且只在可信帧后发生", () => {
    assert.equal((panelJs.match(/setAttribute\("data-board", "live"\)/g) ?? []).length, 1,
      "翻转点唯一");
    const refresh = panelJs.match(/async function refreshAgents\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(refresh);
    assert.match(refresh, /if \(!boardFrameVerdict\(res\)\) return;\n\s*markBoardLive\(\);/,
      "不可信帧在渲染之前就返回，一帧都不画");
  });

  it("拿到可信首帧后把看板入场重播一遍，开屏层还在或落在别屏则不播", () => {
    const refresh = panelJs.match(/async function refreshAgents\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(refresh);
    assert.ok(refresh.includes("const boardWasPending = !boardLive;"),
      "只在「本拍翻转」时播——1s 轮询的后续帧不再重播");
    assert.ok(refresh.includes('boardWasPending && boardVisible() && !document.documentElement.hasAttribute("data-startup")'),
      "无遮挡层且正停看板才补播：开屏窗口的入场归 onLeave，别屏的入场归 switchView");
    assert.ok(refresh.indexOf('playBoardEnter(document.querySelector(".telemetry-view"))')
      > refresh.indexOf("notifyBoardRendered()"),
      "时点放在整卡渲染完之后：动画首帧看到的就是真内容");
  });

  it("骨架条取会话行剪影：两条（名称行 + tokens 行），不再砌段落三杠", () => {
    assert.equal((panelHtml.match(/sessions-skel board-skel-bar/g) ?? []).length, 18,
      "九卡各两条骨架");
    assert.ok(!panelHtml.includes("board-skel-c"), "第三条段落杠已从 HTML 移除");
    assert.ok(!panelCss.includes("board-skel-c"), "c 杠的 CSS 规则同步移除");
    assert.ok(panelCss.includes('html[data-board="pending"] .board-skel-a { width: 30%; height: 12px; }'),
      "名称行剪影：短而高");
    assert.ok(panelCss.includes('html[data-board="pending"] .board-skel-b { width: 55%; height: 11px; }'),
      "tokens 行剪影：长而矮");
    assert.ok(panelCss.includes('html[data-board="pending"] .board-card-loading { display: flex; flex-direction: column; gap: 7px; margin: 0; }'),
      "两条形行距 7px，上下间距仍零自设");
  });

  it("sepia 皮肤下骨架条收 3px 方角，与 empty-hint 同档", () => {
    assert.ok(/:root\[data-style="sepia"\] \.sessions-skel \{\s*border-radius: 3px;/.test(panelCss),
      "骨架族（看板加载态 + 会话页）统一收进 sepia 的方角口径");
  });
});

describe("panel v2 栏收展：终端纵向抖动 + 收展钮图标反转 + 收起态摘蓝标（RAILANIM）", () => {
  it("v2 终端屏横向溢出常驻只裁不滚（上下抽搐的滚动条分量）", () => {
    assert.ok(
      panelCss.includes(':root[data-ui-version="v2"] body.terminal-mode .terminal-screen { overflow-x: clip; }'),
      "容器已变、xterm 仍按旧宽渲染的窗口期不再瞬时顶出横向滚动条吃掉终端高度",
    );
    assert.ok(
      !panelCss.includes('[data-rail-anim] body.terminal-mode .terminal-screen'),
      "不挂收展动画开关：开关撤除与防抖 fit 落点之间的空窗盖不住（实测 289–426ms 仍闪滚动条）",
    );
  });

  it("收展钮两颗 SVG 图标按栏态摘挂 hidden attribute（SVG 无 hidden IDL 反射）", () => {
    assert.ok(panelJs.includes('icoCollapse.toggleAttribute("hidden", collapsed)'),
      "收起态摘「收起」图标要走 attribute");
    assert.ok(panelJs.includes('icoExpand.toggleAttribute("hidden", !collapsed)'),
      "展开态摘「展开」图标要走 attribute");
    assert.ok(!/ico(Collapse|Expand)\.hidden =/.test(panelJs),
      "SVG 图标的 .hidden = 写法已清除（对 SVG 只写 expando、不落 attribute，图标永不切换）");
    assert.ok(/<svg id="railIcoExpand"[^>]* hidden>/.test(panelHtml),
      "HTML 初态：「展开」图标带 hidden attribute（默认展开态只露「收起」图标）");
    assert.ok(!/<svg id="railIcoCollapse"[^>]* hidden>/.test(panelHtml),
      "HTML 初态：「收起」图标不带 hidden");
  });

  it("收起态（72 图标栏）两个来处都摘下蓝标徽标，左上角只留收展钮", () => {
    assert.ok(
      panelCss.includes(':root[data-ui-version="v2"][data-style]:not([data-rail="expanded"]) .rail-brand .brand-icon { display: none; }'),
      "<1200 自动收窄态摘徽标",
    );
    assert.ok(
      panelCss.includes(':root[data-ui-version="v2"][data-style][data-rail="collapsed"] .rail-brand .brand-icon { display: none; }'),
      "≥1200 手动 collapsed 态摘徽标",
    );
    assert.ok(!panelCss.includes('.rail-brand .brand-icon svg { width: 14px; height: 14px; }'),
      "徽标整颗摘下后，收起态徽标内 SVG 的 14px 尺寸档同步作废");
    // 展开态品牌区保持现状：216 全栏徽标基座规则不动
    assert.ok(panelCss.includes(':root[data-ui-version="v2"][data-rail="expanded"] .rail-brand .brand-text { display: block; }'),
      "手动 expanded 档品牌字照旧渲染");
  });
});

// 终端亮暗/底色上报是 agent「match terminal」的面板半边：宿主按这个值回答
// 996n / OSC 11，agent 靠它选调色板。深浅变了要报，深浅不变只换肤（底色变）
// 也要报——宿主按上报值回答背景色，答旧色等于答错。
describe("终端亮暗/底色上报（agent match terminal 的面板半边）", () => {
  function extractFn(name) {
    const src = panelJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
    assert.ok(src, `${name} found in panel.js`);
    return src;
  }
  function sandbox() {
    const posts = [];
    const style = { colorScheme: "dark", background: "#0b1220" };
    const context = {
      document: { documentElement: {} },
      getComputedStyle: () => ({
        colorScheme: style.colorScheme,
        getPropertyValue: (name) => (name === "--terminal-bg" ? style.background : ""),
      }),
      // body 从 vm 域出来，JSON 往返一次回到本域再比对（跨原型 deepEqual 会假红）
      api: (method, path, body) => {
        posts.push({ method, path, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
        return Promise.resolve({});
      },
    };
    const run = vm.runInNewContext(
      `(() => { let terminalThemeReported = "";
        ${extractFn("terminalBackgroundHex")}
        ${extractFn("reportTerminalThemeToBackend")}
        return reportTerminalThemeToBackend; })()`,
      context,
    );
    return { run, posts, style };
  }

  it("首次上报带亮暗与真实底色，同值重复调用不重复上报", () => {
    const { run, posts } = sandbox();
    run();
    assert.deepEqual(posts, [{ method: "POST", path: "/api/terminal/theme", body: { dark: true, background: "#0b1220" } }]);
    run();
    assert.equal(posts.length, 1, "同值不重复上报");
  });

  it("深浅不变只换肤（底色变）也要重报：宿主按上报值回答背景色询问", () => {
    const { run, posts, style } = sandbox();
    run();
    style.background = "#050e1a";
    run();
    assert.equal(posts.length, 2, "底色变化必须重报");
    assert.deepEqual(posts[1].body, { dark: true, background: "#050e1a" });
    style.colorScheme = "light";
    style.background = "#eef7fb";
    run();
    assert.deepEqual(posts[2].body, { dark: false, background: "#eef7fb" });
  });

  it("force 口径无视去重（宿主重启后补报真值）", () => {
    const { run, posts } = sandbox();
    run();
    run(true);
    assert.equal(posts.length, 2);
  });

  it("底色取三缩减写与非法值时都给出可解析的六位十六进制", () => {
    const { run, posts, style } = sandbox();
    style.background = "#abc";
    run();
    assert.equal(posts[0].body.background, "#aabbcc", "三位简写展开");
    style.background = "oklch(0.7 0.1 200)";
    style.colorScheme = "light";
    run(true);
    assert.equal(posts[1].body.background, "#f8fafc", "不可解析时按亮暗取兜底色");
  });
});
