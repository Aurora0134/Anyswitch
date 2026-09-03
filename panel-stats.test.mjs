import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelRouter } from "./panel.mjs";

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
    aliasResolver: null,
    aliasPath: null,
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
    const root = mkdtempSync(join(tmpdir(), "panel-stats-"));
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
    const post = (body, headers = { authorization: "Bearer tok-1" }) => {
      const { req, res } = fakeReqRes("/panel/api/session/report", "POST", body, headers);
      return router.handle(req, res);
    };
    await post({ ...endedReport, ended: false });
    await post({ ...endedReport, pid: 0 });
    await post(endedReport, {}); // no authorization header
    assert.equal(journal.sessions.length, 0);
  });

  it("spans startTs from the session's first seen report", async () => {
    const journal = fakeJournal();
    const router = statsRouter({ usageJournal: journal });
    const post = (body) => {
      const { req, res } = fakeReqRes("/panel/api/session/report", "POST", body, {
        authorization: "Bearer tok-1",
      });
      return router.handle(req, res);
    };
    await post({ pid: 4321, requests: 1, promptTokens: 100 }); // first sighting
    await new Promise((resolve) => setTimeout(resolve, 15));
    await post(endedReport);
    assert.equal(journal.sessions.length, 1);
    const row = journal.sessions[0];
    assert.ok(row.startTs < row.ts);
    assert.ok(row.durationMs >= 10);
    assert.equal(row.durationMs, row.ts - row.startTs);
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
    const { createUsageJournal } = await import("./usage-journal.mjs");
    const dir = mkdtempSync(join(tmpdir(), "panel-stats-labels-"));
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
    const { createUsageJournal } = await import("./usage-journal.mjs");
    const dir = mkdtempSync(join(tmpdir(), "panel-stats-labels-"));
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
