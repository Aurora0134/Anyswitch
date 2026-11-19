import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPanelRouter } from "../src/panel/panel.mjs";
import { createUsageJournal, dayKey } from "../src/shared/usage-journal.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

// GET /panel/api/stats/logs（请求日志路由）：fakeReqRes + 注入 mock 模式与
// panel-stats.test.mjs 同款，不碰真实 store/relay/usage 目录。journal 注入
// readRequestsLog mock（捕获入参），渠道名经 storeService mock 的 board 名表解析；
// storeService 一律注入（默认空名表），路由不会惰性建真服务去读磁盘。

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
    // root 用本进程独享的临时目录当占位：下面所有真实读写面（journal/store/stats）
    // 都注入了 mock，这个 root 不会被碰到——不与其他测试文件共享 C:/fake/anyswitch。
    storePaths: { root: mkTestDir("anys-panel-logs-root-") },
    logger: null,
    metricsCollector: null,
    fetchRelayAgents: async () => null,
    statsService: { getState: async () => ({ ok: true }) }, // 不触发真实聚合
    // 渠道名解析走空名表 board mock（providerLabel 回退裸 id）：不给真 storeService
    // 留惰性建服务读 <root>/store.json 的口子，裸 id 回退断言不依赖磁盘上「恰好没有」。
    storeService: {
      getBoardState: async () => ({ ok: true, providerNames: {}, poolNames: {} }),
    },
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

// 与路由同一套 range → [fromDay, toDay] 推算（日历运算，含当天往前推）。
// 时刻必须传路由自己那一次 Date.now()——响应体的 generatedAt 就是它（路由里
// 同一个 nowTs 同时喂 todayKey 和 generatedAt）。断言侧另取当前时间的话，跨
// 本地午夜时「今天」会与请求时刻算出的不一致，用例假红。
function expectedRange(range, atTs) {
  const back = { today: 0, "7d": 6, "14d": 13, "30d": 29, all: 89 }[range];
  const toDay = dayKey(atTs);
  const [y, m, d] = toDay.split("-").map(Number);
  return { fromDay: dayKey(new Date(y, m - 1, d - back).getTime()), toDay };
}

function realLogsRouter(t, nowTs) {
  let writeTs = nowTs;
  const clock = t.mock.method(Date, "now", () => nowTs);
  const journal = createUsageJournal({ dir: mkTestDir("anys-panel-logs-usage-"), now: () => writeTs });
  const router = logsRouter({ usageJournal: journal });
  return {
    setNow(ts) { clock.mock.mockImplementation(() => ts); },
    append(ts, fields = {}) {
      writeTs = ts;
      journal.appendRequest({ ts, agentId: "kimi", providerId: "p1", model: "m1", ok: true, ...fields });
    },
    async get(params) {
      const { req, res, json } = fakeReqRes("/panel/api/stats/logs?" + new URLSearchParams(params));
      await router.handle(req, res);
      return { status: res.statusCode, body: json() };
    },
  };
}

describe("panel router request-logs route", () => {
  it("rolls 1d across midnight while today starts at local midnight", async (t) => {
    const nowTs = new Date(2026, 0, 15, 0, 30).getTime();
    const midnight = new Date(2026, 0, 15).getTime();
    const startTs = nowTs - DAY_MS;
    const logs = realLogsRouter(t, nowTs);
    for (const ts of [startTs - 1, startTs, midnight - 1, midnight, nowTs]) logs.append(ts);

    const rolling = await logs.get({ range: "1d" });
    assert.equal(rolling.status, 200);
    assert.equal(rolling.body.range, "1d");
    assert.deepEqual(rolling.body.rows.map((r) => r.ts), [nowTs, midnight, midnight - 1, startTs]);

    const today = await logs.get({ range: "today" });
    assert.equal(today.status, 200);
    assert.deepEqual(today.body.rows.map((r) => r.ts), [nowTs, midnight]);
  });
  it("includes the whole fixed end minute before building facets and paging", async (t) => {
    const startTs = new Date(2026, 0, 14, 23, 59).getTime();
    const endTs = new Date(2026, 0, 15, 0, 0).getTime();
    const lastTs = endTs + 59_999;
    const logs = realLogsRouter(t, new Date(2026, 0, 15, 0, 1).getTime());
    logs.append(startTs - 1, { model: "early", durationMs: 110 });
    for (let i = 0; i < 20; i++) logs.append(startTs + i, { durationMs: i });
    logs.append(endTs, { model: "alternate", agentId: null, providerId: "p2", ok: false, errKind: "network" });
    logs.append(lastTs, { durationMs: 100 });
    logs.append(lastTs + 1, { model: "late", durationMs: 120 });
    const params = { range: "custom", startTs, endTs, status: "ok", sort: "durationMs", dir: "desc" };

    const first = await logs.get(params);
    assert.equal(first.status, 200);
    assert.equal(first.body.range, "custom");
    assert.equal(first.body.total, 21);
    assert.deepEqual(first.body.rows.map((r) => r.ts), [lastTs, ...Array.from({ length: 19 }, (_, i) => startTs + 19 - i)]);
    assert.deepEqual(first.body.facets.agents.map((facet) => facet.id), [null, "kimi"]);
    assert.deepEqual(first.body.facets.models.map((facet) => facet.raw), ["alternate", "m1"]);
    assert.deepEqual(first.body.facets.providers.map((facet) => facet.id), ["p1", "p2"]);

    const second = await logs.get({ ...params, page: 2 });
    assert.equal(second.status, 200);
    assert.equal(second.body.total, 21);
    assert.deepEqual(second.body.rows.map((r) => r.ts), [startTs]);
  });

  it("validates fixed custom inputs at minute precision", async (t) => {
    const endTs = new Date(2026, 0, 31, 12).getTime();
    const startTs = endTs - 30 * DAY_MS;
    const logs = realLogsRouter(t, endTs + 45_123);
    const valid = { range: "custom", startTs, endTs };
    assert.equal((await logs.get(valid)).status, 200, "exactly 30 days between minute starts");
    assert.equal((await logs.get({ ...valid, startTs: endTs })).status, 200, "same minute");
    assert.equal((await logs.get({ ...valid, startTs: 0, endTs: 0 })).status, 200, "retention limits results, not fixed historical inputs");

    for (const params of [
      { range: "custom" },
      { range: "custom", startTs },
      { ...valid, startTs: "" },
      { ...valid, startTs: "+" + startTs },
      { ...valid, startTs: "0x" + startTs.toString(16) },
      { ...valid, startTs: "1e12" },
      { ...valid, startTs: "9007199254740992" },
      { ...valid, startTs: startTs + 1 },
      { ...valid, endTs: endTs - 1 },
      { ...valid, startTs: endTs, endTs: endTs - 60_000 },
      { ...valid, startTs: startTs - 60_000 },
      { ...valid, startTs: endTs, endTs: endTs + 60_000 },
      { ...valid, liveEnd: 1 },
      { ...valid, liveEnd: "" },
      [...Object.entries(valid), ["startTs", startTs]],
      [...Object.entries(valid), ["endTs", endTs]],
    ]) {
      const result = await logs.get(params);
      assert.equal(result.status, 400, new URLSearchParams(params).toString());
      assert.deepEqual(result.body, { ok: false, error: "invalid_custom_range" });
    }
  });

  it("refreshes live custom through server now even after 30 days", async (t) => {
    const startTs = new Date(2026, 0, 15, 23, 59).getTime();
    const firstNow = startTs + 40_123;
    const afterMidnight = startTs + 60_000;
    const agedNow = startTs + 31 * DAY_MS + 45_123;
    const logs = realLogsRouter(t, firstNow);
    for (const ts of [startTs - 1, startTs, firstNow, afterMidnight, agedNow, agedNow + 1]) logs.append(ts);
    const params = { range: "custom", startTs, liveEnd: 1 };

    const first = await logs.get(params);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.rows.map((r) => r.ts), [firstNow, startTs]);

    logs.setNow(afterMidnight);
    const next = await logs.get(params);
    assert.equal(next.status, 200);
    assert.deepEqual(next.body.rows.map((r) => r.ts), [afterMidnight, firstNow, startTs]);

    logs.setNow(agedNow);
    const aged = await logs.get(params);
    assert.equal(aged.status, 200);
    assert.equal(aged.body.generatedAt, agedNow);
    assert.deepEqual(aged.body.rows.map((r) => r.ts), [agedNow, afterMidnight, firstNow, startTs]);

    for (const invalid of [
      { ...params, startTs: agedNow + 60_000 - agedNow % 60_000 },
      { ...params, liveEnd: "true" },
      { ...params, endTs: "" },
      [...Object.entries(params), ["liveEnd", 1]],
    ]) {
      assert.equal((await logs.get(invalid)).status, 400);
    }
  });

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
    const { fromDay, toDay } = expectedRange("today", body.generatedAt);
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

  it("range=7d/14d/30d/all map to closed day windows; bogus range falls back to today", async () => {
    const journal = mockLogsJournal();
    const router = logsRouter({ usageJournal: journal });
    const seen = [];
    for (const range of ["7d", "14d", "30d", "all", "bogus", "year"]) {
      const { req, res, json } = fakeReqRes(`/panel/api/stats/logs?range=${range}`);
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
      const expectKey = ["7d", "14d", "30d", "all"].includes(range) ? range : "today";
      assert.equal(json().range, expectKey, `range=${range} → ${expectKey}`);
      // generatedAt 是路由本次请求用的 nowTs，期望窗由它推算才不会跨午夜漂移
      seen.push([expectKey, json().generatedAt]);
    }
    assert.deepEqual(
      journal.calls.map((c) => [c.fromDay, c.toDay]),
      seen.map(([r, at]) => {
        const { fromDay, toDay } = expectedRange(r, at);
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
