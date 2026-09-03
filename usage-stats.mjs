// Usage statistics aggregation over the usage journal (usage-journal.mjs).
// Reads the journal on every getState() call, segmented per metric: the
// heatmap pulls its fixed 90-day range, everything else only the selected
// window (90-day retention keeps the data small, so no caching layer); a
// missing/unreadable journal dir yields the
// all-empty shape instead of throwing. Window series are computed from a
// local-time bucket axis (1h or 8h buckets) so the panel frontend gets
// continuous, zero-filled series it can render directly.
//
// Response contract (field names are consumed by the panel UI — do not rename):
//   { ok, generatedAt, days: 1 | 7,
//     overview:   today only — totals + cacheHitRate/avgTtftMs/successRate
//                 (null when undefined),
//     heatmap:    fixed 90-day axis, { day, requests, tokens } per day,
//     trends:     per grouping (channel=providerId / endpoint=agentId /
//                 model=providerId+"/"+model) Top-5 by window tokens with the
//                 remainder merged into key "__other__" (label "其他");
//                 { buckets: [bucket start ms...], series: [...] },
//   usage:      donut/ranking card — window token totals per single node,
//               channel=providerId, endpoint=agentId, model=bare model name
//               (merged across channels);
//               { total, nodes: [{ key, label, tokens, requests }] }
//               with Top-N by tokens + remainder under "__other__" (label
//               "其他渠道"/"其他端点"/"其他模型"); empty keys label
//               "未知渠道"/"未知端点"/"未知模型". Channel keys are resolved to
//               displayName at read time via the injected `channelLabel`
//               resolver (keys themselves stay raw ids — the panel's legend
//               persistence is keyed), unknown ids keep their raw key.
//     ttft:       per-bucket ({ start, avg, p95 }) + per-model avg/p95
//                 (nearest-rank) over successful rows that have a ttftMs,
//     tps:        per-model generation TPS, completion / ((durationMs-ttftMs)/1000),
//                 rows whose generation window is < 0.2s are excluded,
//     endpoints:  per agentId rows — sessions = activity points split into
//                 segments at 30-minute gaps (journal session end rows each
//                 count as one segment), workMs = union of busy intervals. }
//                 Session end rows merge their tokens into the endpoints row
//                 ONLY for windows where that agent has no request rows
//                 (legacy windows — the per-launch claude relay journals its
//                 requests now, and merging both would double count).

import { dayKey } from "./usage-journal.mjs";
import { WIRE_PREFIX } from "./wire-id.mjs";

const HEATMAP_DAYS = 90;
// 趋势线只保留前 5 名，其余并入「其他」：线多了图例和曲线都不可读（2026-09-01
// 用户迭代，7→5）。
const TOP_N = 5;
const OTHER_KEY = "__other__";
const OTHER_LABEL = "其他";
const SESSION_GAP_MS = 30 * 60 * 1000;
const TPS_MIN_GEN_SEC = 0.2;
const HOUR_MS = 60 * 60 * 1000;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Only 24h (days=1) and 7-day (days=7) windows exist; anything else clamps
// onto them (finite values <= 1 → 1, everything else including NaN/undefined → 7).
export function clampStatDays(days) {
  const n = Number(days);
  return Number.isFinite(n) && n <= 1 ? 1 : 7;
}

function floorToHour(nowTs) {
  const d = new Date(nowTs);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

// Local 8h boundary: hours snap onto 0 / 8 / 16.
function floorTo8h(nowTs) {
  const d = new Date(nowTs);
  d.setHours(Math.floor(d.getHours() / 8) * 8, 0, 0, 0);
  return d.getTime();
}

// Bucket axis for the selected window: days=1 → 24 hour-aligned 1h buckets,
// days=7 → 21 buckets of 8h aligned to local 0/8/16. The last bucket always
// starts at the current boundary and is therefore still incomplete.
function bucketAxis(nowTs, windowDays) {
  const step = windowDays === 1 ? HOUR_MS : 8 * HOUR_MS;
  const count = windowDays === 1 ? 24 : 21;
  const end0 = windowDays === 1 ? floorToHour(nowTs) : floorTo8h(nowTs);
  const start = end0 - (count - 1) * step;
  const buckets = [];
  for (let i = 0; i < count; i += 1) buckets.push(start + i * step);
  return { buckets, start, end: start + count * step, step };
}

// Consecutive local-day axis of `count` days ending at `today` ("YYYY-MM-DD").
// Built with calendar-date arithmetic so DST transitions cannot shift a day.
function dayAxis(today, count) {
  const [y, m, d] = today.split("-").map(Number);
  const axis = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    axis.push(dayKey(new Date(y, m - 1, d - i).getTime()));
  }
  return axis;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Nearest-rank percentile: sort ascending, take element ceil(p*n) (1-based).
function nearestRank(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
}

// Wall-clock union of [start, end] intervals (overlaps counted once).
function unionMs(intervals) {
  const valid = intervals
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = null;
  let curE = null;
  for (const [s, e] of valid) {
    if (curS === null) {
      curS = s;
      curE = e;
    } else if (s <= curE) {
      curE = Math.max(curE, e);
    } else {
      total += curE - curS;
      curS = s;
      curE = e;
    }
  }
  if (curS !== null) total += curE - curS;
  return total;
}

// Activity points (timestamps) split into sessions at gaps > SESSION_GAP_MS.
function countSessionSegments(points) {
  if (points.length === 0) return 0;
  const sorted = [...points].sort((a, b) => a - b);
  let count = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - 1] > SESSION_GAP_MS) count += 1;
  }
  return count;
}

export function createUsageStats({ journal, now = () => Date.now(), channelLabel = null } = {}) {
  // Channel display-name resolution (read-time, never stored): journal rows
  // are keyed by the immutable provider/pool id, so the stats views must map
  // id → displayName at aggregation time for renames to propagate. The host
  // injects a sync resolver over a fresh store snapshot; unknown ids (deleted
  // channels) fall back to the raw id. Empty keys keep their explicit
  // 未知渠道 fallback at every call site.
  const labelChannel = (key) => {
    if (key === "") return "未知渠道";
    const label = typeof channelLabel === "function" ? channelLabel(key) : null;
    return typeof label === "string" && label.length > 0 ? label : key;
  };

  function readRequestsSafe(range) {
    try {
      const rows = journal.readRequests(range);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return []; // unreadable journal == empty data, never blow up the panel
    }
  }

  function readSessionsSafe(range) {
    try {
      const rows = journal.readSessions(range);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  // Tag rows with a normalized ts/day; rows without a usable ts are skipped.
  // Legacy rows (written before the transport layer started stripping it)
  // carry the full Claude wire ID "anthropic/<provider>/<model>" in `model`.
  // The wire prefix is endpoint identity spoofing, not statistics, so both
  // segments are stripped here — old and new rows aggregate into the same
  // series, and the wire's provider segment backfills rows whose providerId
  // never resolved (e.g. pre-routing 409 failures).
  function tagRows(raw) {
    const rows = [];
    for (const r of raw) {
      const ts = Number(r?.ts);
      if (!Number.isFinite(ts)) continue;
      let providerId = r?.providerId;
      let model = r?.model;
      if (typeof model === "string" && model.startsWith(WIRE_PREFIX)) {
        const rest = model.slice(WIRE_PREFIX.length);
        const cut = rest.indexOf("/");
        if (cut > 0) {
          if (typeof providerId !== "string" || providerId === "") providerId = rest.slice(0, cut);
          model = rest.slice(cut + 1);
        } else {
          model = rest;
        }
      }
      rows.push({ ...r, providerId, model, _ts: ts, _day: dayKey(ts) });
    }
    return rows;
  }

  function getState({ days } = {}) {
    const windowDays = clampStatDays(days);
    const nowTs = now();
    const today = dayKey(nowTs);
    const axis = bucketAxis(nowTs, windowDays);
    const heatAxis = dayAxis(today, HEATMAP_DAYS);
    const heatFrom = heatAxis[0];

    // Segmented reads: the heatmap pulls its fixed 90-day range on its own;
    // every other metric reads only the day range covering
    // [min(axis.start, usageStart), axis.end) plus today's overview rows. The
    // donut's independent usage window (below) always spans 7 days, so the
    // window read range also covers usageAxis7 even when days=1.
    const heatRequests = tagRows(readRequestsSafe({ fromDay: heatFrom, toDay: today }));
    const usageAxis1 = bucketAxis(nowTs, 1);
    const usageAxis7 = bucketAxis(nowTs, 7);
    const usageStart = Math.min(usageAxis1.start, usageAxis7.start);
    const usageEnd = Math.max(usageAxis1.end, usageAxis7.end);
    const winRange = {
      fromDay: dayKey(Math.min(axis.start, usageStart)),
      toDay: dayKey(Math.max(axis.end, usageEnd)),
    };
    const allRequests = tagRows(readRequestsSafe(winRange));
    const inWindow = (r) => r._ts >= axis.start && r._ts < axis.end;
    const win = allRequests.filter(inWindow);
    const usage1 = allRequests.filter(
      (r) => r._ts >= usageAxis1.start && r._ts < usageAxis1.end,
    );
    const usage7 = allRequests.filter(
      (r) => r._ts >= usageAxis7.start && r._ts < usageAxis7.end,
    );
    // coveredAgents anti-double-count needs every session end row whose ts
    // falls in the window, so the sessions read spans the same window range.
    const sessionRows = tagRows(
      readSessionsSafe({ fromDay: dayKey(axis.start), toDay: dayKey(axis.end) }),
    ).filter((r) => r.event === "end" && inWindow(r));
    const bucketOf = (r) => Math.floor((r._ts - axis.start) / axis.step);

    // ── Overview: today only, independent of the selected window ──
    const todayRows = allRequests.filter((r) => r._day === today);
    const sumField = (list, field) => list.reduce((a, r) => a + num(r[field]), 0);
    const oPrompt = sumField(todayRows, "prompt");
    const oCompletion = sumField(todayRows, "completion");
    const oCached = sumField(todayRows, "cached");
    const oOk = todayRows.filter((r) => r.ok === true).length;
    const oTtfts = todayRows
      .filter((r) => r.ok === true && num(r.ttftMs) > 0)
      .map((r) => num(r.ttftMs));
    const overview = {
      today,
      requests: todayRows.length,
      prompt: oPrompt,
      completion: oCompletion,
      cached: oCached,
      cacheHitRate: oPrompt > 0 ? oCached / oPrompt : null,
      avgTtftMs: mean(oTtfts),
      successRate: todayRows.length > 0 ? oOk / todayRows.length : null,
    };

    // ── Heatmap: fixed 90-day axis, zero-filled ──
    const heatByDay = new Map();
    for (const r of heatRequests) {
      if (r._day < heatFrom || r._day > today) continue;
      const e = heatByDay.get(r._day) ?? { requests: 0, tokens: 0 };
      e.requests += 1;
      e.tokens += num(r.prompt) + num(r.completion);
      heatByDay.set(r._day, e);
    }
    const heatmap = heatAxis.map((day) => {
      const e = heatByDay.get(day);
      return { day, requests: e?.requests ?? 0, tokens: e?.tokens ?? 0 };
    });

    // ── Trends: three groupings, Top-N + merged "__other__" ──
    // labelOf maps a grouping key to its display label; keys stay raw (the
    // panel's legend show/hide state persists by key), only labels resolve.
    function buildTrend(keyOf, labelOf = (key) => key) {
      const perKey = new Map(); // key -> { total, buckets: Map(idx -> {prompt, completion}) }
      for (const r of win) {
        const key = keyOf(r);
        let e = perKey.get(key);
        if (!e) {
          e = { total: 0, buckets: new Map() };
          perKey.set(key, e);
        }
        const p = num(r.prompt);
        const c = num(r.completion);
        e.total += p + c;
        const idx = bucketOf(r);
        const d = e.buckets.get(idx) ?? { prompt: 0, completion: 0 };
        d.prompt += p;
        d.completion += c;
        e.buckets.set(idx, d);
      }
      const ranked = [...perKey.entries()].sort(
        (a, b) => b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1),
      );
      const topKeys = ranked.slice(0, TOP_N).map(([k]) => k);
      const topSet = new Set(topKeys);
      const seriesFor = (key, label, bucketsMap) => ({
        key,
        label,
        prompt: axis.buckets.map((_, i) => bucketsMap.get(i)?.prompt ?? 0),
        completion: axis.buckets.map((_, i) => bucketsMap.get(i)?.completion ?? 0),
      });
      const series = topKeys.map((key) => seriesFor(key, labelOf(key), perKey.get(key).buckets));
      if (ranked.length > TOP_N) {
        const otherBuckets = new Map();
        for (const [key, e] of perKey) {
          if (topSet.has(key)) continue;
          for (const [idx, v] of e.buckets) {
            const d = otherBuckets.get(idx) ?? { prompt: 0, completion: 0 };
            d.prompt += v.prompt;
            d.completion += v.completion;
            otherBuckets.set(idx, d);
          }
        }
        series.push(seriesFor(OTHER_KEY, OTHER_LABEL, otherBuckets));
      }
      return { buckets: axis.buckets, series };
    }
    const trends = {
      channel: buildTrend((r) => String(r.providerId ?? ""), labelChannel),
      endpoint: buildTrend((r) => String(r.agentId ?? "")),
      model: buildTrend((r) => `${r.providerId ?? ""}/${r.model ?? ""}`),
    };

    // ── Usage: single-node token totals for the donut card ──
    // Channel = providerId, model = bare model name merged across channels
    // (trends.model is the providerId+"/"+model compound key, which would
    // split one model across channels). Top-N + "__other__", sorted by
    // tokens desc; total is the whole-window sum so donut percentages
    // always add up to 100% including the "other" slice. Both windows
    // (24h + 7d) ship in every response so the donut card can flip between
    // them without a second round trip; rows come in via the parameter.
    function buildUsage(rows, keyOf, fallbackLabel, otherLabel, labelOf = (key) => key) {
      const perKey = new Map(); // key -> { tokens, requests }
      let total = 0;
      for (const r of rows) {
        const key = keyOf(r);
        const tokens = num(r.prompt) + num(r.completion);
        total += tokens;
        let e = perKey.get(key);
        if (!e) {
          e = { tokens: 0, requests: 0 };
          perKey.set(key, e);
        }
        e.tokens += tokens;
        e.requests += 1;
      }
      const ranked = [...perKey.entries()].sort(
        (a, b) => b[1].tokens - a[1].tokens || (a[0] < b[0] ? -1 : 1),
      );
      const nodes = ranked.slice(0, TOP_N).map(([key, e]) => ({
        key,
        label: key === "" ? fallbackLabel : labelOf(key),
        tokens: e.tokens,
        requests: e.requests,
      }));
      if (ranked.length > TOP_N) {
        const rest = ranked.slice(TOP_N);
        nodes.push({
          key: OTHER_KEY,
          label: otherLabel,
          tokens: rest.reduce((a, [, e]) => a + e.tokens, 0),
          requests: rest.reduce((a, [, e]) => a + e.requests, 0),
        });
      }
      return { total, nodes };
    }
    const usageFor = (rows) => ({
      channel: buildUsage(
        rows,
        (r) => String(r.providerId ?? ""),
        "未知渠道",
        "其他渠道",
        labelChannel,
      ),
      endpoint: buildUsage(
        rows,
        (r) => String(r.agentId ?? ""),
        "未知端点",
        "其他端点",
      ),
      model: buildUsage(
        rows,
        (r) => String(r.model ?? ""),
        "未知模型",
        "其他模型",
      ),
    });
    const usage = { "1": usageFor(usage1), "7": usageFor(usage7) };

    // Bucket index → rows, shared by the per-bucket ttft series.
    const winByBucket = new Map();
    for (const r of win) {
      const idx = bucketOf(r);
      const list = winByBucket.get(idx) ?? [];
      list.push(r);
      winByBucket.set(idx, list);
    }

    // ── TTFT: per-bucket + per model (successful rows with a ttftMs only) ──
    const ttftOf = (list) =>
      list.filter((r) => r.ok === true && num(r.ttftMs) > 0).map((r) => num(r.ttftMs));
    const ttftDaily = axis.buckets.map((start, i) => {
      const samples = ttftOf(winByBucket.get(i) ?? []);
      return { start, avg: mean(samples), p95: nearestRank(samples, 0.95) };
    });
    const ttftByModelMap = new Map();
    for (const r of win) {
      if (!(r.ok === true && num(r.ttftMs) > 0)) continue;
      const key = `${r.providerId ?? ""}/${r.model ?? ""}`;
      const list = ttftByModelMap.get(key) ?? [];
      list.push(num(r.ttftMs));
      ttftByModelMap.set(key, list);
    }
    const ttftByModel = [...ttftByModelMap.entries()]
      .map(([key, samples]) => ({
        key,
        avg: mean(samples),
        p95: nearestRank(samples, 0.95),
        samples: samples.length,
      }))
      .sort((a, b) => b.samples - a.samples || (a.key < b.key ? -1 : 1));

    // ── TPS: completion tokens per generation second (post-first-chunk) ──
    const tpsMap = new Map();
    for (const r of win) {
      if (r.ok !== true) continue;
      const completion = num(r.completion);
      const durationMs = num(r.durationMs);
      const ttftMs = num(r.ttftMs);
      const genSec = (durationMs - ttftMs) / 1000;
      if (completion <= 0 || genSec < TPS_MIN_GEN_SEC) continue;
      const key = `${r.providerId ?? ""}/${r.model ?? ""}`;
      const e = tpsMap.get(key) ?? { completion: 0, genSec: 0, samples: 0 };
      e.completion += completion;
      e.genSec += genSec;
      e.samples += 1;
      tpsMap.set(key, e);
    }
    const tps = [...tpsMap.entries()]
      .map(([key, e]) => ({ key, avgTps: e.completion / e.genSec, samples: e.samples }))
      .sort((a, b) => b.avgTps - a.avgTps || (a.key < b.key ? -1 : 1));

    // ── Endpoints: per agentId activity, sessions, and busy-time union ──
    const epMap = new Map();
    const epFor = (agentId) => {
      let e = epMap.get(agentId);
      if (!e) {
        e = { agentId, requests: 0, prompt: 0, completion: 0, points: [], intervals: [], sessionEnds: 0 };
        epMap.set(agentId, e);
      }
      return e;
    };
    for (const r of win) {
      const e = epFor(String(r.agentId ?? ""));
      e.requests += 1;
      e.prompt += num(r.prompt);
      e.completion += num(r.completion);
      e.points.push(r._ts);
      e.intervals.push([r._ts, r._ts + Math.max(0, num(r.durationMs))]);
    }
    // Agent ids covered by request rows in this window (only claude ever
    // lacked them — the per-launch relay now journals its requests, so its
    // session-end rows must NOT be merged on top or the tokens/sessions
    // would count twice). Windows predating that journaling still merge.
    const coveredAgents = new Set(
      sessionRows.map((s) => String(s.agentId ?? "")).filter((id) => epMap.has(id)),
    );
    for (const s of sessionRows) {
      if (coveredAgents.has(String(s.agentId ?? ""))) continue;
      // Session end rows carry tokens the requests journal never saw (windows
      // before the per-launch claude relay wrote request rows), so merge them
      // in for the uncovered agents only.
      const e = epFor(String(s.agentId ?? ""));
      e.prompt += num(s.prompt);
      e.completion += num(s.completion);
      e.sessionEnds += 1;
      const startTs = Number(s.startTs);
      if (Number.isFinite(startTs)) {
        e.intervals.push([startTs, startTs + Math.max(0, num(s.durationMs))]);
      }
    }
    const endpoints = [...epMap.values()]
      .map((e) => ({
        agentId: e.agentId,
        requests: e.requests,
        prompt: e.prompt,
        completion: e.completion,
        sessions: countSessionSegments(e.points) + e.sessionEnds,
        workMs: unionMs(e.intervals),
      }))
      .sort((a, b) => b.requests - a.requests || (a.agentId < b.agentId ? -1 : 1));

    return {
      ok: true,
      generatedAt: nowTs,
      days: windowDays,
      overview,
      heatmap,
      trends,
      usage,
      ttft: { daily: ttftDaily, byModel: ttftByModel },
      tps,
      endpoints,
    };
  }

  return { getState };
}
