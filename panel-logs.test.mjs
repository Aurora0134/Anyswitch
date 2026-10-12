import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPanelRouter } from "./panel.mjs";
import { dayKey } from "./usage-journal.mjs";

// GET /panel/api/stats/logs（请求日志路由）：fakeReqRes + 注入 mock 模式与
// panel-stats.test.mjs 同款，不碰真实 store/relay/usage 目录。journal 注入
// readRequestsLog mock（捕获入参），渠道名经 storeService mock 的 board 名表解析。

const DAY_MS = 24 * 60 * 60 * 1000;

function fakeReqRes(url, method = "GET") {
  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(code, h) { this.statusCode = code; this.headers = h || {}; },
    end(data) { if (data !== undefined) this.body += data; },
  };
  const req = {
    url,
    method,
    headers: {
      host: "127.0.0.1:47820",
      origin: "http://127.0.0.1:47820",
      "x-anyswitch-panel": "1",
    },
    on() { return req; },
  };
  const json = () => (res.body ? JSON.parse(res.body) : null);
  return { req, res, json };
}

function logsRouter(overrides = {}) {
  return createPanelRouter({
    storePaths: { root: "C:/fake/anyswitch" },
    logger: null,
    metricsCollector: null,
    aliasResolver: null,
    aliasPath: null,
    fetchRelayAgents: async () => null,
    statsService: { getState: async () => ({ ok: true }) }, // 不触发真实聚合
    ...overrides,
  });
}

function mockLogsJournal(result) {
  const calls = [];
  return {
    calls,
    appendSession: () => {},
    appendRequest: () => {},
    readRequests: () => [],
    readSessions: () => [],
    cleanup: () => {},
    readRequestsLog: (args) => {
      calls.push(args);
      return result ?? { rows: [], total: 0, page: 1, pageSize: 20, facets: { agents: [], providers: [], models: [] } };
    },
  };
}

// 与路由同一套 range → [fromDay, toDay] 推算（日历运算，含当天往前推）
function expectedRange(range) {
  const back = { today: 0, "7d": 6, "30d": 29, all: 89 }[range];
  const toDay = dayKey(Date.now());
  const [y, m, d] = toDay.split("-").map(Number);
  return { fromDay: dayKey(new Date(y, m - 1, d - back).getTime()), toDay };
}

describe("panel router request-logs route", () => {
  it("defaults: range=today, sort=ts desc, page=1, pageSize=20, no filters", async () => {
    const journal = mockLogsJournal();
    const router = logsRouter({ usageJournal: journal });
    const { req, res, json } = fakeReqRes("/panel/api/stats/logs");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    const body = json();
    assert.equal(body.ok, true);
    assert.equal(body.range, "today");
    assert.equal(body.page, 1);
    assert.equal(body.pageSize, 20);
    assert.equal(typeof body.generatedAt, "number");
    const arg = journal.calls[0];
    const { fromDay, toDay } = expectedRange("today");
    assert.equal(arg.fromDay, fromDay);
    assert.equal(arg.toDay, toDay);
    assert.equal(arg.sortBy, "ts");
    assert.equal(arg.sortDir, "desc");
    assert.equal(arg.page, 1);
    assert.equal(arg.pageSize, 20);
    assert.equal(arg.agentId, undefined);
    assert.equal(arg.providerId, undefined);
    assert.equal(arg.model, undefined);
    assert.equal(arg.ok, undefined);
    assert.equal(arg.errKind, undefined);
  });

  it("range=7d/30d/all map to closed day windows; bogus range falls back to today", async () => {
    const journal = mockLogsJournal();
    const router = logsRouter({ usageJournal: journal });
    for (const range of ["7d", "30d", "all", "bogus", "year"]) {
      const { req, res, json } = fakeReqRes(`/panel/api/stats/logs?range=${range}`);
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      const expectKey = ["7d", "30d", "all"].includes(range) ? range : "today";
      assert.equal(json().range, expectKey, `range=${range} → ${expectKey}`);
    }
    assert.deepEqual(
      journal.calls.map((c) => [c.fromDay, c.toDay]),
      ["7d", "30d", "all", "today", "today"].map((r) => {
        const { fromDay, toDay } = expectedRange(r);
        return [fromDay, toDay];
      }),
    );
  });

  it("clamps pageSize onto {20,50,100} and page onto >= 1", async () => {
    const journal = mockLogsJournal();
    const router = logsRouter({ usageJournal: journal });
    const get = async (q) => {
      const { req, res } = fakeReqRes(`/panel/api/stats/logs?${q}`);
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
    };
    await get("pageSize=50");
    await get("pageSize=100");
    await get("pageSize=21");
    await get("pageSize=abc");
    await get("page=3");
    await get("page=0");
    await get("page=-2");
    await get("page=abc");
    assert.deepEqual(
      journal.calls.map((c) => [c.page, c.pageSize]),
      [[1, 50], [1, 100], [1, 20], [1, 20], [3, 20], [1, 20], [1, 20], [1, 20]],
    );
  });

  it("maps status onto ok/errKind; bogus status/sort/dir fall back to defaults", async () => {
    const journal = mockLogsJournal();
    const router = logsRouter({ usageJournal: journal });
    const get = async (q) => {
      const { req, res } = fakeReqRes(`/panel/api/stats/logs?${q}`);
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
    };
    await get("status=all");
    await get("status=ok");
    await get("status=http_429");
    await get("status=network");
    await get("status=bogus");
    await get("sort=durationMs&dir=asc");
    await get("sort=bogus&dir=bogus");
    assert.deepEqual(
      journal.calls.map((c) => [c.ok, c.errKind]),
      [
        [undefined, undefined], // all：不过滤
        [true, undefined], // ok → ok=true
        [undefined, "http_429"],
        [undefined, "network"],
        [undefined, undefined], // bogus → all
        [undefined, undefined],
        [undefined, undefined],
      ],
    );
    assert.deepEqual(journal.calls[5].sortBy, "durationMs");
    assert.deepEqual(journal.calls[5].sortDir, "asc");
    assert.deepEqual(journal.calls[6].sortBy, "ts");
    assert.deepEqual(journal.calls[6].sortDir, "desc");
  });

  it("passes agent/provider/model through verbatim, including the __none__ sentinel", async () => {
    const journal = mockLogsJournal();
    const router = logsRouter({ usageJournal: journal });
    const get = async (q) => {
      const { req, res } = fakeReqRes(`/panel/api/stats/logs?${q}`);
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
    };
    await get("agent=__none__");
    await get("agent=kimi&provider=p1&model=" + encodeURIComponent("anthropic/p1/m1"));
    assert.equal(journal.calls[0].agentId, "__none__");
    assert.equal(journal.calls[1].agentId, "kimi");
    assert.equal(journal.calls[1].providerId, "p1");
    assert.equal(journal.calls[1].model, "anthropic/p1/m1");
  });

  it("decorates rows with providerLabel (channelLabel resolution) and modelDisplay (wire prefix stripped)", async () => {
    const journal = mockLogsJournal({
      rows: [
        { ts: 1, agentId: "claude", providerId: "sensenova", model: "anthropic/sensenova/m1", ok: true },
        { ts: 2, agentId: "kimi", providerId: "gone", model: "kimi-k3", ok: true }, // 已删渠道回落裸 id
      ],
      total: 2,
      page: 1,
      pageSize: 20,
      facets: {
        agents: [null, "claude", "kimi"],
        providers: ["gone", "sensenova"],
        models: ["anthropic/sensenova/m1", "kimi-k3"],
      },
    });
    const router = logsRouter({
      usageJournal: journal,
      storeService: {
        getBoardState: async () => ({
          ok: true,
          providerNames: { sensenova: "渠道1" },
          poolNames: { sensenova: "SenseNova" }, // 池名覆盖渠道名
        }),
      },
    });
    const { req, res, json } = fakeReqRes("/panel/api/stats/logs");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    const body = json();
    assert.equal(body.rows[0].providerLabel, "SenseNova");
    assert.equal(body.rows[0].modelDisplay, "m1");
    assert.equal(body.rows[0].model, "anthropic/sensenova/m1", "raw model preserved");
    assert.equal(body.rows[0].providerId, "sensenova", "raw providerId preserved");
    assert.equal(body.rows[1].providerLabel, "gone", "unknown channel falls back to raw id");
    assert.equal(body.rows[1].modelDisplay, "kimi-k3", "plain model passes through");
    // facets 映射：agents 的 label=id 原值、null 保持 null；providers 走 channelLabel；models 剥前缀
    assert.deepEqual(body.facets.agents, [
      { id: null, label: null },
      { id: "claude", label: "claude" },
      { id: "kimi", label: "kimi" },
    ]);
    assert.deepEqual(body.facets.providers, [
      { id: "gone", label: "gone" },
      { id: "sensenova", label: "SenseNova" },
    ]);
    assert.deepEqual(body.facets.models, [
      { raw: "anthropic/sensenova/m1", display: "m1" },
      { raw: "kimi-k3", display: "kimi-k3" },
    ]);
  });

  it("keeps legacy rows (no errMsg key) byte-compatible in the response", async () => {
    const journal = mockLogsJournal({
      rows: [{ ts: 1, agentId: "kimi", providerId: "p1", model: "m1", ok: true, errKind: null }],
      total: 1,
      page: 1,
      pageSize: 20,
      facets: { agents: ["kimi"], providers: ["p1"], models: ["m1"] },
    });
    const router = logsRouter({ usageJournal: journal });
    const { req, res, json } = fakeReqRes("/panel/api/stats/logs");
    await router.handle(req, res);
    const row = json().rows[0];
    assert.ok(!("errMsg" in row), "no errMsg key invented for legacy rows");
    assert.equal(row.providerLabel, "p1");
    assert.equal(row.modelDisplay, "m1");
  });

  it("drops null/empty providers and models from facets (no sentinel semantics there)", async () => {
    const journal = mockLogsJournal({
      rows: [],
      total: 0,
      page: 1,
      pageSize: 20,
      facets: { agents: [null], providers: [null, "", "p1"], models: [null, "", "m1"] },
    });
    const router = logsRouter({ usageJournal: journal });
    const { req, res, json } = fakeReqRes("/panel/api/stats/logs");
    await router.handle(req, res);
    assert.deepEqual(json().facets.providers, [{ id: "p1", label: "p1" }]);
    assert.deepEqual(json().facets.models, [{ raw: "m1", display: "m1" }]);
    assert.deepEqual(json().facets.agents, [{ id: null, label: null }]);
  });

  it("surfaces a throwing journal as 500 { ok:false }", async () => {
    const router = logsRouter({
      usageJournal: {
        appendSession: () => {},
        appendRequest: () => {},
        readRequests: () => [],
        readSessions: () => [],
        cleanup: () => {},
        readRequestsLog: () => { throw new Error("journal gone"); },
      },
    });
    const { req, res, json } = fakeReqRes("/panel/api/stats/logs");
    await router.handle(req, res);
    assert.equal(res.statusCode, 500);
    assert.equal(json().ok, false);
    assert.equal(json().error, "journal gone");
  });
});
