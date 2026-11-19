import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createPanelRouter } from "../src/panel/panel.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

// Stats routes + claude session-end journaling: the router is exercised with
// mock services / a fake journal so no real store, relay, or usage dir is
// touched. Mirrors the fakeReqRes pattern from panel-store.test.mjs.

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
    headers: {
      host: "127.0.0.1:47820",
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

function statsRouter(overrides = {}) {
  return createPanelRouter({
    storePaths: { root: "C:/fake/anyswitch" },
    logger: null,
    metricsCollector: null,
    fetchRelayAgents: async () => null,
    ...overrides,
  });
}

function mockStatsService(state = { ok: true }) {
  const calls = [];
  return {
    calls,
    getState: async (arg) => {
      calls.push(arg);
      return state;
    },
  };
}

function fakeJournal() {
  const sessions = [];
  return {
    sessions,
    appendSession: (entry) => sessions.push(entry),
    appendRequest: () => {},
    readRequests: () => [],
    readSessions: () => sessions,
    cleanup: () => {},
  };
}

describe("panel router stats routes", () => {
  it("GET /panel/api/stats/state defaults days to 7", async () => {
    const svc = mockStatsService();
    const router = statsRouter({ statsService: svc });
    const { req, res, json } = fakeReqRes("/panel/api/stats/state", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.deepEqual(svc.calls, [{ days: 7 }]);
  });

  it("passes days=1/7 through and clamps anything else onto {1,7}", async () => {
    const svc = mockStatsService();
    const router = statsRouter({ statsService: svc });
    for (const query of ["1", "7", "30", "99", "3", "abc"]) {
      const { req, res } = fakeReqRes(`/panel/api/stats/state?days=${query}`, "GET");
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
    }
    assert.deepEqual(svc.calls, [
      { days: 1 }, { days: 7 }, { days: 7 }, { days: 7 }, { days: 7 }, { days: 7 },
    ]);
  });

  it("returns the service state verbatim", async () => {
    const state = { ok: true, generatedAt: 123, days: 7, overview: { today: "2026-08-30", requests: 4 } };
    const router = statsRouter({ statsService: mockStatsService(state) });
    const { req, res, json } = fakeReqRes("/panel/api/stats/state?days=7", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), state);
  });

  it("lazily builds a real service over <root>/usage when statsService is null", async () => {
    const root = mkTestDir("panel-stats-");
    try {
      const router = statsRouter({ storePaths: { root }, statsService: null });
      const { req, res, json } = fakeReqRes("/panel/api/stats/state", "GET");
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      const body = json();
      assert.equal(body.ok, true);
      assert.equal(body.days, 7);
      assert.equal(body.heatmap.length, 90);
      assert.equal(body.overview.requests, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces a throwing service as 500 { ok:false }", async () => {
    const router = statsRouter({
      statsService: { getState: async () => { throw new Error("boom"); } },
    });
    const { req, res, json } = fakeReqRes("/panel/api/stats/state", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 500);
    assert.equal(json().ok, false);
    assert.equal(json().error, "boom");
  });
});

describe("stats channel label wiring", () => {
  function labelHarness() {
    let now = 1000;
    let board = { ok: true, storeOk: true, providerNames: { chan: "旧名" }, poolNames: {} };
    // 读取器是唯一注入点、永不替换：throwing 只切换「这一拍读取抛错」，board
    // 重绑永远有读者。fail()/throwRead()/recover() 各自把 store 切到一种完整
    // 状态——fail＝读取成功但板显式 storeOk:false，throwRead＝读取抛错，
    // recover＝恢复健康读取。（旧夹具 throwRead 永久替换 getBoardState，其后
    // 的 fail() 只重绑 board 而无任何读者，显式 storeOk:false 分支全程踩不到。）
    let throwing = false;
    let reads = 0;
    const storeService = {
      getBoardState: async () => {
        if (throwing) throw new Error("store unreadable");
        reads += 1;
        return board;
      },
    };
    const usageJournal = {
      readRequestsLog: () => ({
        rows: [{ providerId: "chan", model: "m" }],
        facets: { agents: [], providers: ["chan"], models: ["m"] },
        total: 1,
        page: 1,
        pageSize: 20,
      }),
    };
    const router = statsRouter({ storeService, usageJournal, statsNowFn: () => now, statsChannelLabelsTtlMs: 100 });
    const getLabel = async () => {
      const { req, res, json } = fakeReqRes("/panel/api/stats/logs", "GET");
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      return json().rows[0].providerLabel;
    };
    return {
      getLabel,
      reads: () => reads,
      tick: (value) => { now = value; },
      rename: (name) => { board = { ok: true, storeOk: true, providerNames: { chan: name }, poolNames: {} }; },
      fail: () => { throwing = false; board = { ok: true, storeOk: false, providerNames: {}, poolNames: {} }; },
      throwRead: () => { throwing = true; },
      recover: () => { throwing = false; },
    };
  }

  it("shares a TTL snapshot across requests, refreshes on expiry, and survives a failed read", async () => {
    const h = labelHarness();
    assert.equal(await h.getLabel(), "旧名");
    assert.equal(await h.getLabel(), "旧名");
    assert.equal(h.reads(), 1, "TTL 内的连续请求共用同一份名称快照");
    h.rename("新名");
    assert.equal(await h.getLabel(), "旧名");
    h.tick(1100);
    assert.equal(await h.getLabel(), "新名", "到期后的下一次请求看到改名");
    h.tick(1200);
    h.throwRead();
    assert.equal(await h.getLabel(), "新名", "刷新异常保留旧映射");
    h.tick(1300);
    h.fail();
    // fail() 把 store 切到「读取成功但板显式 storeOk:false」：与上一段的
    // throw→catch 互为镜像，这一拍走的是 refreshStatsChannelLabels 的显式
    // 失败分支——非空旧表保旧映射、不清空（删掉该分支，这里会清成裸 id "chan"）。
    assert.equal(await h.getLabel(), "新名", "显式 storeOk:false 也是失败，不能清空旧映射");
  });

  it("recovers the initial empty mapping after a failed store read", async () => {
    const h = labelHarness();
    h.fail();
    assert.equal(await h.getLabel(), "chan");
    h.rename("恢复名");
    h.tick(1050);
    // 首读显式 storeOk:false（空旧表）不缓存失败拍：at 留在 0，TTL 窗内的
    // 下一拍（1050-1000=50<100）即可恢复。若失败拍被当有效快照缓存到
    // at=1000，这里不会刷新，读到的仍是裸 id "chan"。
    assert.equal(await h.getLabel(), "恢复名", "首读失败不缓存失败拍，TTL 窗内即恢复");
  });

  it("retries an initial thrown read immediately rather than caching the empty mapping", async () => {
    const h = labelHarness();
    h.throwRead();
    assert.equal(await h.getLabel(), "chan");
    h.rename("恢复名");
    h.recover();
    assert.equal(await h.getLabel(), "恢复名");
    assert.equal(h.reads(), 1, "only the recovered read returned a board");
  });
});

describe("claude session-end journaling", () => {
  const endedReport = {
    pid: 4321,
    requests: 3,
    promptTokens: 700,
    completionTokens: 300,
    cachedTokens: 100,
    ended: true,
  };

  it("appends one session end row on the ended report", async () => {
    const journal = fakeJournal();
    const router = statsRouter({ usageJournal: journal });
    const { req, res, json } = fakeReqRes("/panel/api/session/report", "POST", endedReport, {
      authorization: "Bearer tok-1",
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.equal(journal.sessions.length, 1);
    const row = journal.sessions[0];
    assert.equal(row.agentId, "claude");
    assert.equal(row.event, "end");
    assert.equal(row.prompt, 700);
    assert.equal(row.completion, 300);
    assert.equal(row.cached, 100);
    assert.equal(typeof row.ts, "number");
    assert.equal(row.startTs, row.ts); // never seen before → zero-length span
    assert.equal(row.durationMs, 0);
  });

  it("journals the session end row under the report's own agentId (kimi)", async () => {
    const journal = fakeJournal();
    const router = statsRouter({ usageJournal: journal });
    const { req, res, json } = fakeReqRes("/panel/api/session/report", "POST", { ...endedReport, agentId: "kimi" }, {
      authorization: "Bearer tok-kimi",
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.equal(journal.sessions.length, 1);
    assert.equal(journal.sessions[0].agentId, "kimi");
  });

  it("does not journal the same session twice, but a recycled PID with a new token does", async () => {
    const journal = fakeJournal();
    const router = statsRouter({ usageJournal: journal });
    const post = (token) => {
      const { req, res } = fakeReqRes("/panel/api/session/report", "POST", endedReport, {
        authorization: `Bearer ${token}`,
      });
      return router.handle(req, res);
    };
    await post("tok-1");
    await post("tok-1"); // duplicate ended report → deduped
    assert.equal(journal.sessions.length, 1);
    await post("tok-2"); // PID reused by a new session → new row
    assert.equal(journal.sessions.length, 2);
  });

  it("ignores non-ended reports and reports without a token or pid", async () => {
    const journal = fakeJournal();
    const router = statsRouter({ usageJournal: journal });
    const post = async (body, headers = { authorization: "Bearer tok-1" }) => {
      const { req, res, json } = fakeReqRes("/panel/api/session/report", "POST", body, headers);
      await router.handle(req, res);
      // 200 {ok:true} proves the request got past the CSRF gate in front of
      // /panel/api/* and was dropped inside handleSessionReport by the token
      // / pid checks — a 403 {error:"csrf"} bounce would fail these asserts,
      // so the empty-journal claim below cannot be satisfied by the wrong gate.
      assert.equal(res.statusCode, 200);
      assert.equal(json().ok, true);
    };
    await post({ ...endedReport, ended: false });
    await post({ ...endedReport, pid: 0 });
    await post(endedReport, {}); // no authorization header
    assert.equal(journal.sessions.length, 0);
  });

  it("spans startTs from the session's first seen report", async () => {
    const journal = fakeJournal();
    let now = 1_700_000_000_000;
    const router = statsRouter({ usageJournal: journal, sessionNowFn: () => now });
    const post = (body) => {
      const { req, res } = fakeReqRes("/panel/api/session/report", "POST", body, {
        authorization: "Bearer tok-1",
      });
      return router.handle(req, res);
    };
    await post({ pid: 4321, requests: 1, promptTokens: 100 }); // first sighting
    now += 50;
    await post(endedReport);
    assert.equal(journal.sessions.length, 1);
    const row = journal.sessions[0];
    assert.equal(row.startTs, 1_700_000_000_000);
    assert.equal(row.ts - row.startTs, 50);
    assert.equal(row.durationMs, 50);
  });

  it("still forwards reports to the metrics collector", async () => {
    const seen = [];
    const router = statsRouter({
      usageJournal: fakeJournal(),
      metricsCollector: { reportSession: (token, body) => seen.push([token, body]) },
    });
    const { req, res } = fakeReqRes("/panel/api/session/report", "POST", endedReport, {
      authorization: "Bearer tok-1",
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], "tok-1");
    assert.equal(seen[0][1].pid, 4321);
  });
});

describe("stats channel label wiring (panel.mjs resolver)", () => {
  it("resolves channel labels from the store board names, pools winning shared ids", async () => {
    const { createUsageJournal } = await import("../src/shared/usage-journal.mjs");
    const dir = mkTestDir("panel-stats-labels-");
    try {
      const journal = createUsageJournal({ dir });
      journal.appendRequest({
        ts: Date.now(), agentId: "zcode", providerId: "sensenova",
        model: "m", prompt: 10, completion: 0, ok: true,
      });
      journal.appendRequest({
        ts: Date.now(), agentId: "zcode", providerId: "solo",
        model: "m", prompt: 30, completion: 0, ok: true,
      });
      const router = statsRouter({
        usageJournal: journal,
        storeService: {
          getBoardState: async () => ({
            ok: true,
            providerNames: { sensenova: "渠道1", solo: "Solo渠道" },
            poolNames: { sensenova: "SenseNova" },
          }),
        },
      });
      const { req, res, json } = fakeReqRes("/panel/api/stats/state?days=7", "GET");
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      const state = json();
      assert.deepEqual(
        state.usage["7"].channel.nodes.map((n) => [n.key, n.label]),
        [["solo", "Solo渠道"], ["sensenova", "SenseNova"]],
      );
      assert.deepEqual(
        state.trends.channel.series.map((n) => [n.key, n.label]),
        [["solo", "Solo渠道"], ["sensenova", "SenseNova"]],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to raw ids when the store is unreadable (stats never break)", async () => {
    const { createUsageJournal } = await import("../src/shared/usage-journal.mjs");
    const dir = mkTestDir("panel-stats-labels-");
    try {
      const journal = createUsageJournal({ dir });
      journal.appendRequest({
        ts: Date.now(), agentId: "zcode", providerId: "solo",
        model: "m", prompt: 10, completion: 0, ok: true,
      });
      const router = statsRouter({
        usageJournal: journal,
        storeService: { getBoardState: async () => { throw new Error("store gone"); } },
      });
      const { req, res, json } = fakeReqRes("/panel/api/stats/state?days=7", "GET");
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      const state = json();
      assert.deepEqual(
        state.usage["7"].channel.nodes.map((n) => [n.key, n.label]),
        [["solo", "solo"]],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
