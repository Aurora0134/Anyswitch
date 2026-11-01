// Usage statistics aggregation over the usage journal (usage-journal.mjs).
//
// 数据面来自 usage-rollup.mjs 的「日汇总」：每个日文件折叠一次并常驻，文件变了
// 只读新增的尾巴。本模块只做窗口合并——把落在时间轴里的那些小时并起来，按旧口径
// 出响应，不再逐行扫日志。窗口边界全部落在本地整点（1 小时桶 / 0·8·16 点对齐的
// 8 小时桶），所以「按小时合并」与旧实现「逐行过滤」结果一致。
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
//                 models with < 10 such samples are dropped from the list
//                 entirely (same rule as tps below),
//     tps:        per-model generation TPS, completion / ((durationMs-ttftMs)/1000),
//                 rows whose generation window is < 0.2s are excluded; models
//                 with < 10 such samples are dropped from the list entirely,
//     endpoints:  per agentId rows — sessions = activity points split into
//                 segments at 30-minute gaps (journal session end rows each
//                 count as one segment), workMs = union of busy intervals. }
//                 Session end rows merge their tokens into the endpoints row
//                 ONLY for windows where that agent has no request rows
//                 (legacy windows — the per-launch claude relay journals its
//                 requests now, and merging both would double count).

import { dayKey } from "./usage-journal.mjs";
import { createUsageRollups, stripWirePrefix } from "./usage-rollup.mjs";

// 请求日志路由（panel.mjs modelDisplay）经此处取同一份读侧归一实现，不复制第二份。
export { stripWirePrefix };

const HEATMAP_DAYS = 90;
// 趋势线只保留前 5 名，其余并入「其他」：线多了图例和曲线都不可读。
const TOP_N = 5;
const OTHER_KEY = "__other__";
const OTHER_LABEL = "其他";
const SESSION_GAP_MS = 30 * 60 * 1000;
// TPS 卡样本下限：低于 10 个生成段的模型不显示——小样本的总量加权均值
// 被单请求噪声主导（一次慢请求就把均值拖走），读数没有参考意义。
// （生成段的逐行过滤在 usage-rollup.mjs 折叠时就做掉了。）
const TPS_MIN_SAMPLES = 10;
// TTFT 行样本下限：与 TPS 卡同一机制——低于 10 个样本的模型不显示，
// 小样本均值被单请求噪声主导（一次慢请求就把均值拖走），读数没有参考意义。
const TTFT_MIN_SAMPLES = 10;
const HOUR_MS = 60 * 60 * 1000;

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

function emptyCounters() {
  return { requests: 0, prompt: 0, completion: 0, cached: 0, ok: 0, ttftSum: 0, ttftCnt: 0 };
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
  // 日汇总缓存：一次构建常驻，文件变了只读新增尾巴（详见 usage-rollup.mjs）。
  const rollups = createUsageRollups({ journal, now });

  function getState({ days } = {}) {
    const windowDays = clampStatDays(days);
    const nowTs = now();
    const today = dayKey(nowTs);
    const axis = bucketAxis(nowTs, windowDays);
    const heatAxis = dayAxis(today, HEATMAP_DAYS);
    const heatFrom = heatAxis[0];

    // 请求流：一次拿到 [90 天热力起点, 今天] 的日汇总——热力图吃每日总量，
    // 窗口类指标吃其中最近几天的小时级明细。
    const reqUnits = rollups.requests({ fromDay: heatFrom, toDay: today });
    // 会话行只服务端点工时表，范围与趋势窗口一致。
    const sessUnits = rollups.sessions({ fromDay: dayKey(axis.start), toDay: dayKey(axis.end) });

    const usageAxis1 = bucketAxis(nowTs, 1);
    const usageAxis7 = bucketAxis(nowTs, 7);
    const usageStart = Math.min(usageAxis1.start, usageAxis7.start);
    const usageEnd = Math.max(usageAxis1.end, usageAxis7.end);

    // 遍历窗口内的小时。窗口起止都落在整点，所以「小时落在窗口内」与旧实现
    // 「行 ts 落在窗口内」等价，不会漏也不会多。
    function eachWindowHour(units, from, to, visit) {
      for (const fold of units) {
        for (const [hour, h] of fold.hours) {
          if (hour < from || hour >= to) continue;
          visit(hour, h);
        }
      }
    }

    // 每个口径一张「键 → 逐桶 token/请求数」表：趋势出 prompt/completion 两条线，
    // 用量卡出窗口总量，两者共用同一次遍历。
    function collectKeySeries(pick, targetAxis) {
      const count = targetAxis.buckets.length;
      const perKey = new Map();
      eachWindowHour(reqUnits, targetAxis.start, targetAxis.end, (hour, h) => {
        const m = pick(h);
        if (!m || m.size === 0) return;
        const idx = Math.floor((hour - targetAxis.start) / targetAxis.step);
        for (const [key, v] of m) {
          let e = perKey.get(key);
          if (!e) {
            e = { p: new Array(count).fill(0), c: new Array(count).fill(0), n: 0, total: 0 };
            perKey.set(key, e);
          }
          e.p[idx] += v[0];
          e.c[idx] += v[1];
          e.n += v[2];
          e.total += v[0] + v[1];
        }
      });
      return perKey;
    }

    // ── Overview: today only, independent of the selected window ──
    const ovAcc = emptyCounters();
    for (const fold of reqUnits) {
      const d = fold.dayTotals.get(today);
      if (!d) continue;
      ovAcc.requests += d.requests;
      ovAcc.prompt += d.prompt;
      ovAcc.completion += d.completion;
      ovAcc.cached += d.cached;
      ovAcc.ok += d.ok;
      ovAcc.ttftSum += d.ttftSum;
      ovAcc.ttftCnt += d.ttftCnt;
    }
    const overview = {
      today,
      requests: ovAcc.requests,
      prompt: ovAcc.prompt,
      completion: ovAcc.completion,
      cached: ovAcc.cached,
      cacheHitRate: ovAcc.prompt > 0 ? ovAcc.cached / ovAcc.prompt : null,
      avgTtftMs: ovAcc.ttftCnt > 0 ? ovAcc.ttftSum / ovAcc.ttftCnt : null,
      successRate: ovAcc.requests > 0 ? ovAcc.ok / ovAcc.requests : null,
    };

    // ── Heatmap: fixed 90-day axis, zero-filled ──
    const heatByDay = new Map();
    for (const fold of reqUnits) {
      for (const [day, d] of fold.dayTotals) {
        if (day < heatFrom || day > today) continue;
        const e = heatByDay.get(day) ?? { requests: 0, tokens: 0 };
        e.requests += d.requests;
        e.tokens += d.prompt + d.completion;
        heatByDay.set(day, e);
      }
    }
    const heatmap = heatAxis.map((day) => {
      const e = heatByDay.get(day);
      return { day, requests: e?.requests ?? 0, tokens: e?.tokens ?? 0 };
    });

    // ── Trends: three groupings, Top-N + merged "__other__" ──
    // labelOf maps a grouping key to its display label; keys stay raw (the
    // panel's legend show/hide state persists by key), only labels resolve.
    const count = axis.buckets.length;
    function buildTrend(perKey, labelOf = (key) => key) {
      const ranked = [...perKey.entries()].sort(
        (a, b) => b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1),
      );
      const topKeys = ranked.slice(0, TOP_N).map(([k]) => k);
      const topSet = new Set(topKeys);
      const series = topKeys.map((key) => {
        const e = perKey.get(key);
        return { key, label: labelOf(key), prompt: [...e.p], completion: [...e.c] };
      });
      if (ranked.length > TOP_N) {
        const p = new Array(count).fill(0);
        const c = new Array(count).fill(0);
        for (const [key, e] of perKey) {
          if (topSet.has(key)) continue;
          for (let i = 0; i < count; i += 1) {
            p[i] += e.p[i];
            c[i] += e.c[i];
          }
        }
        series.push({ key: OTHER_KEY, label: OTHER_LABEL, prompt: p, completion: c });
      }
      return { buckets: axis.buckets, series };
    }
    const trends = {
      channel: buildTrend(collectKeySeries((h) => h.ch, axis), labelChannel),
      endpoint: buildTrend(collectKeySeries((h) => h.ep, axis), (key) => key),
      model: buildTrend(collectKeySeries((h) => h.md, axis)),
    };

    // ── Usage: single-node token totals for the donut card ──
    // Channel = providerId, model = bare model name merged across channels
    // (trends.model is the providerId+"/"+model compound key, which would
    // split one model across channels). Top-N + "__other__", sorted by
    // tokens desc; total is the whole-window sum so donut percentages
    // always add up to 100% including the "other" slice. Both windows
    // (24h + 7d) are merged from the same day rollups, so the card can flip
    // between them without a second round trip.
    function buildUsage(perKey, fallbackLabel, otherLabel, labelOf = (key) => key) {
      const ranked = [...perKey.entries()].sort(
        (a, b) => b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1),
      );
      let total = 0;
      for (const [, e] of perKey) total += e.total;
      const nodes = ranked.slice(0, TOP_N).map(([key, e]) => ({
        key,
        label: key === "" ? fallbackLabel : labelOf(key),
        tokens: e.total,
        requests: e.n,
      }));
      if (ranked.length > TOP_N) {
        const rest = ranked.slice(TOP_N);
        nodes.push({
          key: OTHER_KEY,
          label: otherLabel,
          tokens: rest.reduce((a, [, e]) => a + e.total, 0),
          requests: rest.reduce((a, [, e]) => a + e.n, 0),
        });
      }
      return { total, nodes };
    }
    const usageFor = (targetAxis) => ({
      channel: buildUsage(collectKeySeries((h) => h.ch, targetAxis), "未知渠道", "其他渠道", labelChannel),
      endpoint: buildUsage(collectKeySeries((h) => h.ep, targetAxis), "未知端点", "其他端点"),
      model: buildUsage(collectKeySeries((h) => h.bm, targetAxis), "未知模型", "其他模型"),
    });
    const usage = { "1": usageFor(usageAxis1), "7": usageFor(usageAxis7) };

    // ── TTFT: per-bucket + per model (successful rows with a ttftMs only) ──
    const ttftDaily = axis.buckets.map((start) => {
      const lo = start;
      const hi = start + axis.step;
      const samples = [];
      eachWindowHour(reqUnits, lo, hi, (hour, h) => {
        if (h.ttft.length === 0) return;
        for (const v of h.ttft) samples.push(v);
      });
      return { start, avg: mean(samples), p95: nearestRank(samples, 0.95) };
    });
    const ttftByModelSamples = new Map();
    eachWindowHour(reqUnits, axis.start, axis.end, (hour, h) => {
      if (h.ttftModel.size === 0) return;
      for (const [key, vals] of h.ttftModel) {
        let bucketSamples = ttftByModelSamples.get(key);
        if (!bucketSamples) {
          bucketSamples = [];
          ttftByModelSamples.set(key, bucketSamples);
        }
        for (const v of vals) bucketSamples.push(v);
      }
    });
    const ttftByModel = [...ttftByModelSamples.entries()]
      .map(([key, samples]) => ({
        key,
        avg: mean(samples),
        p95: nearestRank(samples, 0.95),
        samples: samples.length,
      }))
      .filter((e) => e.samples >= TTFT_MIN_SAMPLES)
      .sort((a, b) => b.samples - a.samples || (a.key < b.key ? -1 : 1));

    // ── TPS: completion tokens per generation second (post-first-chunk) ──
    const tpsMap = new Map();
    eachWindowHour(reqUnits, axis.start, axis.end, (hour, h) => {
      if (h.tps.size === 0) return;
      for (const [key, t] of h.tps) {
        let e = tpsMap.get(key);
        if (!e) {
          e = { completion: 0, genSec: 0, samples: 0 };
          tpsMap.set(key, e);
        }
        e.completion += t[0];
        e.genSec += t[1];
        e.samples += t[2];
      }
    });
    const tps = [...tpsMap.entries()]
      .map(([key, e]) => ({ key, avgTps: e.completion / e.genSec, samples: e.samples }))
      .filter((e) => e.samples >= TPS_MIN_SAMPLES)
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
    eachWindowHour(reqUnits, axis.start, axis.end, (hour, h) => {
      for (const [agentId, a] of h.ag) {
        const e = epFor(agentId);
        e.requests += a.requests;
        e.prompt += a.prompt;
        e.completion += a.completion;
        for (const p of a.points) e.points.push(p);
        for (const iv of a.intervals) e.intervals.push(iv);
      }
    });
    // Session end rows merge their tokens/time ONLY for agents with no request
    // rows in this window (legacy windows). Agents covered by request rows must
    // NOT be merged on top or the tokens/sessions would count twice.
    const sessWindow = [];
    for (const fold of sessUnits) {
      for (const [hour, m] of fold.hours) {
        if (hour < axis.start || hour >= axis.end) continue;
        for (const [agentId, s] of m) sessWindow.push([agentId, s]);
      }
    }
    const coveredAgents = new Set();
    for (const [agentId] of sessWindow) if (epMap.has(agentId)) coveredAgents.add(agentId);
    for (const [agentId, s] of sessWindow) {
      if (coveredAgents.has(agentId)) continue;
      const e = epFor(agentId);
      e.prompt += s.prompt;
      e.completion += s.completion;
      e.sessionEnds += s.count;
      for (const iv of s.intervals) e.intervals.push(iv);
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
