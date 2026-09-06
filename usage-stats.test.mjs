import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageJournal, dayKey } from "./usage-journal.mjs";
import { createUsageStats, clampStatDays } from "./usage-stats.mjs";

// Fixed "now": 2026-08-30 12:34:56 local — deliberately mid-bucket so the
// flooring of the bucket axes is exercised. The 1h axis floors onto 12:00,
// the 8h axis onto 08:00; both windows then extend backwards in fixed steps.
const H1 = 60 * 60 * 1000;
const NOW = new Date(2026, 7, 30, 12, 34, 56).getTime();
const TODAY = "2026-08-30";
const END0_H = new Date(2026, 7, 30, 12, 0, 0).getTime(); // floorToHour(NOW)
const START_H = END0_H - 23 * H1; // 2026-08-29 13:00
const END0_8H = new Date(2026, 7, 30, 8, 0, 0).getTime(); // floorTo8h(NOW)
const START_8H = END0_8H - 20 * 8 * H1; // 2026-08-23 16:00

function tsOn(dayOffset, hour = 10, minute = 0, second = 0) {
  return new Date(2026, 7, 30 - dayOffset, hour, minute, second).getTime();
}

// Bucket index of a timestamp under the 1h axis.
function idxH(ts) {
  return Math.floor((ts - START_H) / H1);
}

// Bucket index of a timestamp under the 8h axis.
function idx8h(ts) {
  return Math.floor((ts - START_8H) / (8 * H1));
}

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "usage-stats-"));
  const stats = createUsageStats({ journal: createUsageJournal({ dir }), now: () => NOW });
  // Writers append under the file name of THEIR day, so each past-day row is
  // written through a journal whose clock sits on that day.
  const writeRequests = (dayOffset, rows) => {
    const j = createUsageJournal({ dir, now: () => tsOn(dayOffset, 12) });
    for (const r of rows) j.appendRequest(r);
  };
  const writeSessions = (dayOffset, rows) => {
    const j = createUsageJournal({ dir, now: () => tsOn(dayOffset, 12) });
    for (const r of rows) j.appendSession(r);
  };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, stats, writeRequests, writeSessions, cleanup };
}

function req(overrides = {}) {
  return {
    ts: tsOn(0, 10),
    agentId: "zcode",
    providerId: "prov-a",
    model: "m1",
    prompt: 100,
    completion: 50,
    cached: 10,
    ttftMs: 500,
    durationMs: 2000,
    ok: true,
    status: 200,
    errKind: null,
    ...overrides,
  };
}

describe("clampStatDays", () => {
  it("clamps onto the two supported windows {1, 7}", () => {
    assert.equal(clampStatDays(1), 1);
    assert.equal(clampStatDays(0), 1);
    assert.equal(clampStatDays(7), 7);
    assert.equal(clampStatDays(2), 7);
    assert.equal(clampStatDays(30), 7);
    assert.equal(clampStatDays(undefined), 7);
    assert.equal(clampStatDays("abc"), 7);
  });
});

describe("usage-stats empty journal", () => {
  it("returns the all-empty shape for a missing dir (days=1)", () => {
    const stats = createUsageStats({
      journal: createUsageJournal({ dir: join(tmpdir(), "usage-stats-definitely-missing") }),
      now: () => NOW,
    });
    const s = stats.getState({ days: 1 });
    assert.equal(s.ok, true);
    assert.equal(s.days, 1);
    assert.equal(s.generatedAt, NOW);
    assert.deepEqual(s.overview, {
      today: TODAY,
      requests: 0,
      prompt: 0,
      completion: 0,
      cached: 0,
      cacheHitRate: null,
      avgTtftMs: null,
      successRate: null,
    });
    assert.equal(s.heatmap.length, 90);
    assert.equal(s.heatmap[0].day, dayKey(tsOn(89)));
    assert.equal(s.heatmap[89].day, TODAY);
    assert.ok(s.heatmap.every((d) => d.requests === 0 && d.tokens === 0));
    for (const grouping of ["channel", "endpoint", "model"]) {
      assert.equal(s.trends[grouping].buckets.length, 24);
      assert.equal(s.trends[grouping].buckets[0], START_H);
      assert.equal(s.trends[grouping].buckets[23], END0_H);
      assert.deepEqual(s.trends[grouping].series, []);
    }
    assert.deepEqual(s.usage, {
      "1": {
        channel: { total: 0, nodes: [] },
        endpoint: { total: 0, nodes: [] },
        model: { total: 0, nodes: [] },
      },
      "7": {
        channel: { total: 0, nodes: [] },
        endpoint: { total: 0, nodes: [] },
        model: { total: 0, nodes: [] },
      },
    });
    assert.equal(s.cache, undefined);
    assert.equal(s.claudeSessions, undefined);
    assert.equal(s.overview.activeChannels, undefined);
    assert.equal(s.ttft.daily.length, 24);
    assert.ok(s.ttft.daily.every((d, i) =>
      d.start === START_H + i * H1 && d.avg === null && d.p95 === null,
    ));
    assert.deepEqual(s.ttft.byModel, []);
    assert.deepEqual(s.tps, []);
    assert.deepEqual(s.endpoints, []);
  });
});

describe("bucket axes", () => {
  it("days=1 yields 24 hour-aligned buckets ending at the current hour", () => {
    const { stats, cleanup } = makeHarness();
    const buckets = stats.getState({ days: 1 }).trends.channel.buckets;
    assert.equal(buckets.length, 24);
    assert.equal(buckets[0], START_H);
    for (let i = 0; i < buckets.length; i += 1) {
      assert.equal(buckets[i], START_H + i * H1);
      const d = new Date(buckets[i]);
      assert.equal(d.getMinutes(), 0);
      assert.equal(d.getSeconds(), 0);
    }
    // The last bucket is the current, not-yet-complete hour.
    assert.ok(buckets[23] <= NOW && NOW < buckets[23] + H1);
    cleanup();
  });

  it("days=7 yields 21 buckets of 8h aligned to local 0/8/16", () => {
    const { stats, cleanup } = makeHarness();
    const buckets = stats.getState({ days: 7 }).trends.channel.buckets;
    assert.equal(buckets.length, 21);
    assert.equal(buckets[0], START_8H);
    for (let i = 0; i < buckets.length; i += 1) {
      assert.equal(buckets[i], START_8H + i * 8 * H1);
      const d = new Date(buckets[i]);
      assert.ok([0, 8, 16].includes(d.getHours()));
      assert.equal(d.getMinutes(), 0);
    }
    // The last bucket is the current, not-yet-complete 8h segment.
    assert.ok(buckets[20] <= NOW && NOW < buckets[20] + 8 * H1);
    cleanup();
  });
});

describe("usage-stats aggregation", () => {
  it("zero-fills the continuous 1h bucket axis", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    writeRequests(0, [req({ prompt: 10, completion: 5 })]); // 10:00 → bucket 21
    writeRequests(0, [req({ ts: tsOn(0, 12, 40), prompt: 3, completion: 1 })]); // current bucket 23
    writeRequests(1, [req({ ts: tsOn(1, 13, 0), prompt: 20, completion: 10 })]); // bucket 0
    const s = stats.getState({ days: 1 });
    const series = s.trends.channel.series[0];
    assert.equal(series.key, "prov-a");
    const expectedPrompt = Array(24).fill(0);
    expectedPrompt[idxH(tsOn(1, 13, 0))] = 20;
    expectedPrompt[idxH(tsOn(0, 10, 0))] = 10;
    expectedPrompt[idxH(tsOn(0, 12, 40))] = 3;
    const expectedCompletion = Array(24).fill(0);
    expectedCompletion[idxH(tsOn(1, 13, 0))] = 10;
    expectedCompletion[idxH(tsOn(0, 10, 0))] = 5;
    expectedCompletion[idxH(tsOn(0, 12, 40))] = 1;
    assert.deepEqual(series.prompt, expectedPrompt);
    assert.deepEqual(series.completion, expectedCompletion);
    assert.equal(s.heatmap.length, 90);
    assert.equal(s.heatmap[89].requests, 2);
    assert.equal(s.heatmap[89].tokens, 19);
    assert.equal(s.heatmap[88].tokens, 30);
    cleanup();
  });

  it("assigns rows on bucket boundaries to the bucket they start", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    writeRequests(0, [
      req({ ts: tsOn(0, 10, 0, 0), prompt: 1 }), // exactly at a bucket start
      req({ ts: tsOn(0, 10, 59, 59), prompt: 2 }), // end of the same bucket
      req({ ts: tsOn(0, 11, 0, 0), prompt: 4 }), // exactly at the next start
    ]);
    const s = stats.getState({ days: 1 });
    const series = s.trends.channel.series[0];
    assert.equal(series.prompt[idxH(tsOn(0, 10, 0))], 3); // 1 + 2
    assert.equal(series.prompt[idxH(tsOn(0, 11, 0))], 4);
    assert.equal(idxH(tsOn(0, 11, 0)), idxH(tsOn(0, 10, 0)) + 1);
    cleanup();
  });

  it("excludes rows outside the [start, end) window but keeps them in overview/heatmap", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    writeRequests(0, [req({ ts: tsOn(0, 13, 0), prompt: 7 })]); // == axis end (13:00) → out
    writeRequests(1, [req({ ts: tsOn(1, 12, 59, 59), prompt: 9 })]); // 1s before start → out
    writeRequests(0, [req({ ts: tsOn(0, 12, 30), prompt: 5 })]); // inside the current bucket
    const s = stats.getState({ days: 1 });
    const series = s.trends.channel.series[0];
    assert.deepEqual(series.prompt, [...Array(23).fill(0), 5]);
    // Overview (today) and heatmap (90 days) are NOT window-filtered.
    assert.equal(s.overview.requests, 2); // both of today's rows
    assert.equal(s.heatmap[89].requests, 2);
    assert.equal(s.heatmap[88].requests, 1);
    cleanup();
  });

  it("assigns 8h buckets by the local 0/8/16 boundaries", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    writeRequests(0, [
      req({ ts: tsOn(0, 7, 59), prompt: 1 }), // [00:00, 08:00) bucket
      req({ ts: tsOn(0, 8, 0), prompt: 2 }), // [08:00, 16:00) — the current bucket
    ]);
    const s = stats.getState({ days: 7 });
    const series = s.trends.channel.series[0];
    assert.equal(idx8h(tsOn(0, 7, 59)), 19);
    assert.equal(idx8h(tsOn(0, 8, 0)), 20);
    assert.equal(series.prompt[19], 1);
    assert.equal(series.prompt[20], 2);
    assert.equal(s.trends.channel.buckets[20], END0_8H);
    cleanup();
  });

  it("keeps Top 5 per grouping and merges the rest into __other__", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    // 9 channels with descending token totals ch1 > ch2 > ... > ch9.
    writeRequests(0, Array.from({ length: 9 }, (_, i) =>
      req({ providerId: `ch${i + 1}`, prompt: (9 - i) * 100, completion: 0 }),
    ));
    const s = stats.getState({ days: 7 });
    const series = s.trends.channel.series;
    assert.equal(series.length, 6);
    assert.deepEqual(series.slice(0, 5).map((x) => x.key), ["ch1", "ch2", "ch3", "ch4", "ch5"]);
    const other = series[5];
    assert.equal(other.key, "__other__");
    assert.equal(other.label, "其他");
    // ch6 (400) + ch7 (300) + ch8 (200) + ch9 (100) merged into the current bucket.
    const expected = Array(21).fill(0);
    expected[20] = 1000;
    assert.deepEqual(other.prompt, expected);
    cleanup();
  });

  it("groups by channel / endpoint / model with the documented key shapes", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    writeRequests(0, [
      req({ providerId: "pool-1", agentId: "kimi", model: "k3", prompt: 10, completion: 1 }),
      req({ providerId: "prov-b", agentId: "zcode", model: "m9", prompt: 20, completion: 2 }),
    ]);
    const s = stats.getState({ days: 7 });
    assert.deepEqual(s.trends.channel.series.map((x) => x.key).sort(), ["pool-1", "prov-b"]);
    assert.deepEqual(s.trends.endpoint.series.map((x) => x.key).sort(), ["kimi", "zcode"]);
    assert.deepEqual(s.trends.model.series.map((x) => x.key).sort(), ["pool-1/k3", "prov-b/m9"]);
    cleanup();
  });

  it("computes overview for today only, with null-safe ratios", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    writeRequests(0, [
      req({ prompt: 100, completion: 50, cached: 25, ttftMs: 400, ok: true }),
      req({ ts: tsOn(0, 11), prompt: 100, completion: 50, cached: 75, ttftMs: 800, ok: false, errKind: "http_429", agentId: "kimi", providerId: "prov-b", model: "m2" }),
    ]);
    writeRequests(1, [req({ ts: tsOn(1, 10), prompt: 999, completion: 999 })]);
    const s = stats.getState({ days: 7 });
    const o = s.overview;
    assert.equal(o.today, TODAY);
    assert.equal(o.requests, 2);
    assert.equal(o.prompt, 200);
    assert.equal(o.completion, 100);
    assert.equal(o.cached, 100);
    assert.equal(o.cacheHitRate, 0.5);
    assert.equal(o.avgTtftMs, 400); // only successful rows with a ttft count
    assert.equal(o.successRate, 0.5);
    cleanup();
  });

  it("computes nearest-rank p95 for ttft", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    // 20 samples, ttft = 100..2000 — nearest-rank ceil(0.95*20)=19 → 1900.
    writeRequests(0, Array.from({ length: 20 }, (_, i) =>
      req({ ttftMs: (i + 1) * 100, ok: true }),
    ));
    const s = stats.getState({ days: 7 });
    const byModel = s.ttft.byModel.find((x) => x.key === "prov-a/m1");
    assert.equal(byModel.samples, 20);
    assert.equal(byModel.p95, 1900);
    assert.equal(byModel.avg, 1050);
    const bucketIdx = idx8h(tsOn(0, 10));
    const cell = s.ttft.daily[bucketIdx];
    assert.equal(cell.start, s.trends.channel.buckets[bucketIdx]);
    assert.equal(cell.p95, 1900);
    assert.equal(cell.avg, 1050);
    cleanup();
  });

  it("excludes sub-0.2s generation windows from TPS", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    // genSec = (2000-500)/1000 = 1.5s → included, 300 completion tokens.
    // 满 10 样本才出榜（下方小样本用例钉下限）。
    writeRequests(0, Array.from({ length: 10 }, () =>
      req({ completion: 300, durationMs: 2000, ttftMs: 500, ok: true })));
    writeRequests(0, [
      // genSec = (600-500)/1000 = 0.1s → excluded.
      req({ completion: 9999, durationMs: 600, ttftMs: 500, ok: true }),
      // failed rows never count.
      req({ completion: 8888, durationMs: 9000, ttftMs: 500, ok: false }),
    ]);
    const s = stats.getState({ days: 7 });
    assert.equal(s.tps.length, 1);
    assert.equal(s.tps[0].key, "prov-a/m1");
    assert.equal(s.tps[0].samples, 10);
    assert.equal(s.tps[0].avgTps, 200); // 300 / 1.5
    cleanup();
  });

  it("drops TPS rows with < 10 samples (small-sample means are noise-dominated)", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    // 9 个合格样本 → 不到 10 样本下限，整行不显示
    writeRequests(0, Array.from({ length: 9 }, () =>
      req({ completion: 300, durationMs: 2000, ttftMs: 500, ok: true })));
    // 另一模型恰好 10 样本 → 出榜
    writeRequests(0, Array.from({ length: 10 }, () =>
      req({ model: "m2", completion: 150, durationMs: 2000, ttftMs: 500, ok: true })));
    const s = stats.getState({ days: 7 });
    assert.deepEqual(s.tps.map((r) => r.key), ["prov-a/m2"]);
    assert.equal(s.tps[0].samples, 10);
    assert.equal(s.tps[0].avgTps, 100); // 150 / 1.5
    cleanup();
  });

  it("splits endpoint sessions at 30-minute activity gaps", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    // Points: 10:00, 10:10 (same segment), 10:50, 11:00 (gap 40m → new
    // segment), 14:00 (gap 3h → third segment).
    writeRequests(0, [
      req({ ts: tsOn(0, 10, 0) }),
      req({ ts: tsOn(0, 10, 10) }),
      req({ ts: tsOn(0, 10, 50) }),
      req({ ts: tsOn(0, 11, 0) }),
      req({ ts: tsOn(0, 14, 0) }),
    ]);
    const s = stats.getState({ days: 7 });
    const ep = s.endpoints.find((x) => x.agentId === "zcode");
    assert.equal(ep.requests, 5);
    assert.equal(ep.sessions, 3);
    cleanup();
  });

  it("unions overlapping request intervals into workMs", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    const base = tsOn(0, 10, 0);
    writeRequests(0, [
      req({ ts: base, durationMs: 1000 }),          // [0, 1000]
      req({ ts: base + 500, durationMs: 1000 }),    // [500, 1500] overlaps
      req({ ts: base + 2000, durationMs: 1000 }),   // [2000, 3000] disjoint
    ]);
    const s = stats.getState({ days: 7 });
    const ep = s.endpoints.find((x) => x.agentId === "zcode");
    assert.equal(ep.workMs, 2500); // 1500 + 1000
    cleanup();
  });

  it("merges claude session end rows into endpoints without double counting", () => {
    const { stats, writeRequests, writeSessions, cleanup } = makeHarness();
    const start = tsOn(0, 8, 0);
    writeSessions(0, [{
      ts: tsOn(0, 10, 0),
      agentId: "claude",
      event: "end",
      startTs: start,
      durationMs: 2 * 60 * 60 * 1000,
      prompt: 700,
      completion: 300,
      cached: 100,
    }]);
    writeRequests(0, [req({ agentId: "zcode", prompt: 10, completion: 5 })]);
    const s = stats.getState({ days: 7 });
    const claude = s.endpoints.find((x) => x.agentId === "claude");
    // No request rows for claude: tokens come ONLY from the session end row.
    assert.equal(claude.requests, 0);
    assert.equal(claude.prompt, 700);
    assert.equal(claude.completion, 300);
    assert.equal(claude.sessions, 1); // one end row == one session segment
    assert.equal(claude.workMs, 2 * 60 * 60 * 1000);
    // zcode row is unaffected.
    const zcode = s.endpoints.find((x) => x.agentId === "zcode");
    assert.equal(zcode.prompt, 10);
    cleanup();
  });

  it("skips the session-row merge once claude request rows exist (per-launch journaling)", () => {
    const { stats, writeRequests, writeSessions, cleanup } = makeHarness();
    const start = tsOn(0, 8, 0);
    writeSessions(0, [{
      ts: tsOn(0, 10, 0),
      agentId: "claude",
      event: "end",
      startTs: start,
      durationMs: 2 * 60 * 60 * 1000,
      prompt: 700,
      completion: 300,
      cached: 100,
    }]);
    // The per-launch claude relay journals requests now: same tokens appear as
    // request rows, so merging the session row on top would count them twice.
    writeRequests(0, [
      req({ agentId: "claude", prompt: 500, completion: 200, durationMs: 1000 }),
      req({ agentId: "claude", ts: tsOn(0, 10, 45), prompt: 200, completion: 100, durationMs: 1000 }),
    ]);
    const s = stats.getState({ days: 7 });
    const claude = s.endpoints.find((x) => x.agentId === "claude");
    assert.equal(claude.requests, 2);
    assert.equal(claude.prompt, 700, "tokens come from request rows only");
    assert.equal(claude.completion, 300);
    assert.equal(claude.sessions, 2, "session segments come from request points only");
    // Mixed agents: zcode request rows never affect claude's merge decision.
    writeRequests(0, [req({ agentId: "zcode", prompt: 42 })]);
    const s2 = stats.getState({ days: 7 });
    const claude2 = s2.endpoints.find((x) => x.agentId === "claude");
    assert.equal(claude2.prompt, 700);
    cleanup();
  });

  it("skips the kimi session-row merge once kimi request rows exist (per-launch journaling)", () => {
    // kimi per-launch relay 也开始写 request 行后，coveredAgents 逻辑按
    // agentId 生效：kimi 的 session-end 行不再叠加，claude 的互不影响。
    const { stats, writeRequests, writeSessions, cleanup } = makeHarness();
    const start = tsOn(0, 8, 0);
    writeSessions(0, [{
      ts: tsOn(0, 10, 0),
      agentId: "kimi",
      event: "end",
      startTs: start,
      durationMs: 60 * 60 * 1000,
      prompt: 400,
      completion: 100,
      cached: 50,
    }]);
    writeRequests(0, [
      req({ agentId: "kimi", prompt: 300, completion: 80, durationMs: 1000 }),
      req({ agentId: "kimi", ts: tsOn(0, 10, 45), prompt: 100, completion: 20, durationMs: 1000 }),
    ]);
    const s = stats.getState({ days: 7 });
    const kimi = s.endpoints.find((x) => x.agentId === "kimi");
    assert.equal(kimi.requests, 2);
    assert.equal(kimi.prompt, 400, "tokens come from request rows only, no session-row double count");
    assert.equal(kimi.completion, 100);
    cleanup();
  });

  it("tolerates rows with missing fields", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    writeRequests(0, [
      { ts: tsOn(0, 10) },                 // almost everything missing
      { agentId: "zcode", prompt: 5 },     // no ts → skipped entirely
      req({ model: undefined, providerId: undefined }),
    ]);
    const s = stats.getState({ days: 7 });
    assert.equal(s.overview.requests, 2); // the no-ts row is skipped
    // Only the fully-formed row carries a ttft sample; the near-empty one doesn't.
    assert.equal(s.ttft.byModel.length, 1);
    assert.ok(Number.isFinite(s.endpoints[0].workMs));
    cleanup();
  });

  it("clamps days onto {1, 7} and defaults to 7", () => {
    const { stats, cleanup } = makeHarness();
    assert.equal(stats.getState({ days: 1 }).days, 1);
    assert.equal(stats.getState({ days: 7 }).days, 7);
    assert.equal(stats.getState({ days: 99 }).days, 7);
    assert.equal(stats.getState({}).days, 7);
    assert.equal(stats.getState().days, 7);
    assert.equal(stats.getState({ days: 1 }).trends.channel.buckets.length, 24);
    assert.equal(stats.getState({ days: 7 }).trends.channel.buckets.length, 21);
    cleanup();
  });
});

describe("legacy wire-id rows (anthropic/ 前缀剥离 + providerId 回填)", () => {
  // 历史行（transport 层开始剥前缀之前写入）的 model 字段是完整 Claude
  // wire id "anthropic/<provider>/<model>"。前缀是端点身份伪装，不是统计
  // 维度：读侧必须剥到裸模型名，且 wire 的 provider 段回填空 providerId
  // 的行，使新旧行聚进同一条序列。

  it("strips the wire prefix and provider segment in every grouping", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    writeRequests(0, [
      req({ model: "anthropic/prov-a/m1", providerId: "prov-a" }),
      // Same bare model written the new way — must land in the SAME series.
      req({ ts: tsOn(0, 11), model: "m1", providerId: "prov-a" }),
    ]);
    const s = stats.getState({ days: 1 });
    const channel = s.trends.channel.series.find((x) => x.key === "prov-a");
    assert.ok(channel, "channel grouping keys on providerId, unaffected by the model field");
    assert.ok(
      s.trends.model.series.some((x) => x.key === "prov-a/m1" && !s.trends.model.series.some((y) => y.key !== "__other__" && y.key.includes("anthropic"))),
      "model grouping merges legacy wire-id rows into the bare-model series",
    );
    assert.ok(
      s.ttft.byModel.every((r) => !r.key.includes("anthropic/")),
      "ttft keys show the bare model",
    );
    cleanup();
  });

  it("backfills an empty providerId from the wire id's provider segment", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    writeRequests(0, [
      // Pre-routing 409 failures: providerId never resolved, the model field
      // is the only carrier of the channel identity.
      req({ model: "anthropic/sensenova/sensenova-6.8-flash-lite", providerId: "", ok: false, status: 409, ttftMs: null }),
    ]);
    const s = stats.getState({ days: 1 });
    assert.ok(
      s.trends.model.series.some((x) => x.key === "sensenova/sensenova-6.8-flash-lite"),
      "the wire's provider segment backfills the empty providerId and the bare model is kept",
    );
    const channel = s.trends.channel.series.find((x) => x.key === "sensenova");
    assert.ok(channel, "channel trend sees the backfilled channel");
    cleanup();
  });

  it("keeps model ids that contain '/' after the provider segment", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    writeRequests(0, [
      req({ model: "anthropic/vendorb-go/go/qwen3.8-max", providerId: "vendorb-go" }),
    ]);
    const s = stats.getState({ days: 1 });
    assert.equal(s.ttft.byModel[0].key, "vendorb-go/go/qwen3.8-max", "the FIRST '/' after the prefix is the provider boundary");
    cleanup();
  });

  it("leaves plain (non-wire-id) rows untouched", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    writeRequests(0, [
      req({ model: "kimi-k3", providerId: "prov-a" }),
    ]);
    const s = stats.getState({ days: 1 });
    assert.equal(s.ttft.byModel[0].key, "prov-a/kimi-k3");
    cleanup();
  });
});

describe("usage (single-node token totals for the donut card)", () => {
  it("merges the same bare model across channels and keys channel totals by providerId", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    writeRequests(0, [
      // m1 on two channels → channel dim: two nodes; model dim: ONE merged node.
      req({ ts: tsOn(0, 10), providerId: "prov-a", model: "m1", prompt: 100, completion: 50 }),
      req({ ts: tsOn(0, 11), providerId: "prov-b", model: "m1", prompt: 200, completion: 50 }),
      req({ ts: tsOn(0, 12), providerId: "prov-a", model: "m2", prompt: 10, completion: 5 }),
    ]);
    const s = stats.getState({ days: 1 });
    assert.equal(s.usage["1"].channel.total, 415);
    assert.deepEqual(s.usage["1"].channel.nodes.map((n) => [n.key, n.tokens, n.requests]), [
      ["prov-b", 250, 1],
      ["prov-a", 165, 2],
    ]);
    assert.equal(s.usage["1"].model.total, 415);
    assert.deepEqual(s.usage["1"].model.nodes.map((n) => [n.key, n.tokens]), [
      ["m1", 400],
      ["m2", 15],
    ]);
    cleanup();
  });

  it("keeps Top-5 by tokens and merges the remainder into one '__other__' node; total includes it", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    const rows = [];
    for (let i = 0; i < 7; i += 1) {
      rows.push(req({
        ts: tsOn(0, 10),
        providerId: `prov-${i}`,
        model: "m",
        prompt: (i + 1) * 100,
        completion: 0,
      }));
    }
    writeRequests(0, rows);
    const s = stats.getState({ days: 1 });
    assert.equal(s.usage["1"].channel.total, 2800, "total is the whole-window sum, not just the top nodes");
    const nodes = s.usage["1"].channel.nodes;
    assert.equal(nodes.length, 6);
    assert.deepEqual(nodes.slice(0, 5).map((n) => n.key), ["prov-6", "prov-5", "prov-4", "prov-3", "prov-2"]);
    const other = nodes[5];
    assert.equal(other.key, "__other__");
    assert.equal(other.label, "其他渠道");
    assert.equal(other.tokens, 300, "prov-0 + prov-1 merged");
    assert.equal(other.requests, 2);
    cleanup();
  });

  it("labels empty keys with the fallback and sorts equal-token nodes by key", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    writeRequests(0, [
      req({ ts: tsOn(0, 10), providerId: "", model: "", prompt: 10, completion: 0 }),
    ]);
    const s = stats.getState({ days: 1 });
    assert.deepEqual(s.usage["1"].channel.nodes, [{ key: "", label: "未知渠道", tokens: 10, requests: 1 }]);
    assert.deepEqual(s.usage["1"].model.nodes, [{ key: "", label: "未知模型", tokens: 10, requests: 1 }]);
    cleanup();
  });

  it("ships both windows independently: rows older than 24h appear in '7' but not '1'", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    // NOW = day0 12:34:56, 1h window starts at 13:00 on day -1; tsOn(2, 10)
    // (day -2) is outside 24h but inside 7d.
    writeRequests(2, [req({ ts: tsOn(2, 10), providerId: "prov-old", prompt: 70, completion: 0 })]);
    writeRequests(0, [req({ ts: tsOn(0, 10), providerId: "prov-new", prompt: 30, completion: 0 })]);
    const s = stats.getState({ days: 1 });
    assert.deepEqual(s.usage["1"].channel.nodes.map((n) => [n.key, n.tokens]), [
      ["prov-new", 30],
    ]);
    assert.deepEqual(s.usage["7"].channel.nodes.map((n) => [n.key, n.tokens]), [
      ["prov-old", 70],
      ["prov-new", 30],
    ]);
    assert.equal(s.usage["1"].channel.total, 30);
    assert.equal(s.usage["7"].channel.total, 100);
    cleanup();
  });
});

describe("segmented journal reads", () => {
  // getState must not pull the full 90-day journal for every call: the heatmap
  // reads its fixed 90-day range on its own, and everything else reads only
  // the day range covering [min(axis.start, usage 1h/8h axes),
  // max(axis.end, usage 7d end)) — the donut's independent usage windows
  // always span 7 days, so the read range covers them even when days=1.
  function spyJournal() {
    const calls = { requests: [], sessions: [] };
    return {
      calls,
      journal: {
        readRequests: (range) => { calls.requests.push(range); return []; },
        readSessions: (range) => { calls.sessions.push(range); return []; },
      },
    };
  }

  it("days=1 reads the 90d heatmap range plus the 24h+7d window range", () => {
    const { calls, journal } = spyJournal();
    const stats = createUsageStats({ journal, now: () => NOW });
    stats.getState({ days: 1 });
    assert.deepEqual(calls.requests, [
      { fromDay: dayKey(tsOn(89)), toDay: TODAY }, // heatmap: fixed 90 days
      { fromDay: "2026-08-23", toDay: TODAY },     // window + today + usage windows (7d)
    ]);
    // sessions stay scoped to the trends window: only those metrics
    // consume session rows, the usage windows read requests only.
    assert.deepEqual(calls.sessions, [{ fromDay: "2026-08-29", toDay: TODAY }]);
  });

  it("days=7 reads the 90d heatmap range plus only the 7d window range", () => {
    const { calls, journal } = spyJournal();
    const stats = createUsageStats({ journal, now: () => NOW });
    stats.getState({ days: 7 });
    assert.deepEqual(calls.requests, [
      { fromDay: dayKey(tsOn(89)), toDay: TODAY },
      { fromDay: "2026-08-23", toDay: TODAY },
    ]);
    assert.deepEqual(calls.sessions, [{ fromDay: "2026-08-23", toDay: TODAY }]);
  });

  it("window-filtered metrics ignore rows outside the read window, heatmap keeps them", () => {
    const { stats, writeRequests, cleanup } = makeHarness();
    writeRequests(3, [req({ ts: tsOn(3, 10), prompt: 50, completion: 50 })]);
    writeRequests(0, [req({ ts: tsOn(0, 10), prompt: 1, completion: 1 })]);
    const s = stats.getState({ days: 1 });
    assert.equal(s.trends.channel.series[0].prompt.reduce((a, b) => a + b, 0), 1);
    assert.equal(s.heatmap[86].requests, 1); // 3 days ago, still inside 90d
    assert.equal(s.heatmap[86].tokens, 100);
    cleanup();
  });
});

describe("channel display-name resolution (channelLabel)", () => {
  function labeledHarness(channelLabel) {
    const dir = mkdtempSync(join(tmpdir(), "usage-stats-label-"));
    const stats = createUsageStats({ journal: createUsageJournal({ dir }), now: () => NOW, channelLabel });
    const writeRequests = (dayOffset, rows) => {
      const j = createUsageJournal({ dir, now: () => tsOn(dayOffset, 12) });
      for (const r of rows) j.appendRequest(r);
    };
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    return { stats, writeRequests, cleanup };
  }

  const NAMES = { "prov-a": "渠道A", "pool-x": "大池" };

  it("resolves usage channel node labels via the injected resolver", () => {
    const { stats, writeRequests, cleanup } = labeledHarness((id) => NAMES[id] ?? null);
    writeRequests(0, [
      req({ ts: tsOn(0, 10), providerId: "prov-a", prompt: 10, completion: 0 }),
      req({ ts: tsOn(0, 10), providerId: "ghost", prompt: 5, completion: 0 }),
    ]);
    const s = stats.getState({ days: 1 });
    assert.deepEqual(
      s.usage["1"].channel.nodes.map((n) => [n.key, n.label]),
      [["prov-a", "渠道A"], ["ghost", "ghost"]],
    );
    cleanup();
  });

  it("keys stay raw ids so legend persistence by key keeps working", () => {
    const { stats, writeRequests, cleanup } = labeledHarness((id) => NAMES[id] ?? null);
    writeRequests(0, [req({ ts: tsOn(0, 10), providerId: "prov-a", prompt: 10, completion: 0 })]);
    const s = stats.getState({ days: 1 });
    assert.equal(s.usage["1"].channel.nodes[0].key, "prov-a");
    assert.equal(s.trends.channel.series[0].key, "prov-a");
    cleanup();
  });

  it("resolves trend channel labels and marks the empty key 未知渠道 (was a blank legend chip)", () => {
    const { stats, writeRequests, cleanup } = labeledHarness((id) => NAMES[id] ?? null);
    writeRequests(0, [
      req({ ts: tsOn(0, 10), providerId: "", prompt: 10, completion: 0 }),
      req({ ts: tsOn(0, 10), providerId: "prov-a", prompt: 20, completion: 0 }),
    ]);
    const s = stats.getState({ days: 1 });
    assert.deepEqual(
      s.trends.channel.series.map((n) => [n.key, n.label]),
      [["prov-a", "渠道A"], ["", "未知渠道"]],
    );
    cleanup();
  });

  it("leaves endpoint and model labels untouched (endpoint maps in the panel)", () => {
    const { stats, writeRequests, cleanup } = labeledHarness((id) => NAMES[id] ?? null);
    writeRequests(0, [req({ ts: tsOn(0, 10), agentId: "zcode", providerId: "prov-a", model: "m1", prompt: 10, completion: 0 })]);
    const s = stats.getState({ days: 1 });
    assert.equal(s.trends.endpoint.series[0].label, "zcode");
    assert.equal(s.trends.model.series[0].label, "prov-a/m1");
    cleanup();
  });

  it("tolerates a missing/non-function channelLabel (plain id labels)", () => {
    const { stats, writeRequests, cleanup } = labeledHarness(undefined);
    writeRequests(0, [req({ ts: tsOn(0, 10), providerId: "prov-a", prompt: 10, completion: 0 })]);
    const s = stats.getState({ days: 1 });
    assert.equal(s.usage["1"].channel.nodes[0].label, "prov-a");
    cleanup();
  });
});
