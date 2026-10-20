// Per-day rollup layer for the usage stats page (consumed by usage-stats.mjs).
//
// 统计页每次打开/切窗口都要看 90 天热力图 + 最近窗口的趋势，而 journal 的写入
// 形状是「一天一个文件、写完不再改动」。所以这里把「每次重读重算全部日志」换成
// 「每个日文件折叠一次」：
//
//   - 每个日文件折成一份当日汇总：按本地小时分桶的渠道/端点/型号 token 与请求数、
//     TTFT 样本、TPS 分子分母、端点活动点与忙区间，加上当日总量（热力图口径）；
//   - 文件签名（大小/mtime）没变就直接复用，变了只读新增的尾巴（journal
//     readDayTail）——当天那个文件再大，也只解析新写入的那几行；
//   - 只有最近 DETAIL_DAYS 天需要小时级明细（窗口最长 7 天、跨零点再占一天），
//     更早的日子压成当日总量，常驻内存只剩几十 MB 量级的前身；
//   - 上层只合并窗口内那几天，不再逐行扫。
//
// journal 没有增量接口时（测试替身/旧实现）退化为「每次读整段再折叠」，折叠出的
// 结构与增量路径完全相同，所以上层聚合逻辑只有一份。
//
// 分桶精度：日汇总按本地整点分桶，而统计页的时间轴也全部落在整点上
// （days=1 是 24 个整点桶，days=7 是 21 个 0/8/16 点对齐的 8 小时桶，窗口起止
// 都由 floorToHour/floorTo8h 派生），所以按小时合并与逐行过滤的结果逐字段相同。

import { dayKey } from "./usage-journal.mjs";
import { WIRE_PREFIX } from "./wire-id.mjs";

// 窗口最长 7 天，起点可能回退到 7 天前的那一日历日（8 小时桶对齐再加一天余量），
// 取 9 天：更早的日文件只需保留当日总量（热力图）。
const DETAIL_DAYS = 9;
// TPS 行样本下限（生成窗口短于此的样本不进分子分母），与 usage-stats 的
// TTFT_MIN_SAMPLES 同一方向：原始行级过滤必须在折叠时做掉，合并阶段只按
// 样本数门槛筛模型。
const TPS_MIN_GEN_SEC = 0.2;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// 剥 wire 前缀（"anthropic/<provider>/<model>"）的读侧口径：model 剥到裸模型名，
// wire 的 provider 段在 providerId 为空时回填。导出给 panel.mjs 请求日志路由
// 复用（modelDisplay），统计聚合与日汇总共用同一份实现，不复制第二份。
export function stripWirePrefix(model, providerId) {
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
  return { providerId, model };
}

function floorToHour(ts) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

// [p, c, n] 累加器：prompt / completion / 请求数。趋势要前两者分桶，用量要
// 三者合并后的窗口总量，所以一次折叠同时喂两边。
function addKey(map, key, p, c) {
  const e = map.get(key);
  if (e) {
    e[0] += p;
    e[1] += c;
    e[2] += 1;
  } else {
    map.set(key, [p, c, 1]);
  }
}

function newHourFold() {
  return {
    ch: new Map(), // 渠道：providerId
    md: new Map(), // 模型：providerId/model（趋势的复合键）
    bm: new Map(), // 裸模型名（用量卡跨渠道合并）
    ep: new Map(), // 端点：agentId（只收归属明确的请求）
    ttft: [], // 该小时成功请求的 TTFT 样本
    ttftModel: new Map(), // providerId/model -> 该小时的 TTFT 样本
    tps: new Map(), // providerId/model -> [completion, genSec, samples]
    ag: new Map(), // agentId -> { requests, prompt, completion, points, intervals }
  };
}

export function createRequestFold() {
  return {
    rows: 0,
    detail: true,
    dayTotals: new Map(), // 行所属本地日 -> { requests, prompt, completion, cached, ok, ttftSum, ttftCnt }
    hours: new Map(), // 本地整点 -> newHourFold()
  };
}

export function createSessionFold() {
  return {
    rows: 0,
    detail: true,
    hours: new Map(), // 本地整点 -> Map<agentId, { prompt, completion, count, intervals }>
  };
}

// 折一批请求行。与旧实现逐行聚合等价：字段缺失一律按 0，ts 非有限的行跳过，
// wire 前缀在折的时候剥掉（读侧身份归一，写侧不动）。
export function foldRequestRows(fold, rows) {
  for (const r of rows) {
    const ts = Number(r?.ts);
    if (!Number.isFinite(ts)) continue;
    const { providerId, model } = stripWirePrefix(r?.model, r?.providerId);
    const p = num(r.prompt);
    const c = num(r.completion);
    const hour = floorToHour(ts);
    let h = fold.hours.get(hour);
    if (!h) {
      h = newHourFold();
      fold.hours.set(hour, h);
    }
    const chKey = String(providerId ?? "");
    const modelKey = String(model ?? "");
    const mdKey = `${chKey}/${modelKey}`;
    addKey(h.ch, chKey, p, c);
    addKey(h.md, mdKey, p, c);
    addKey(h.bm, modelKey, p, c);
    // 端点维度只收归属明确的请求（agentId 非空字符串）——与旧实现「未知来源不
    // 进任何端点维度」同一条：它们仍在渠道/模型/总览/热力图里。
    if (typeof r.agentId === "string" && r.agentId !== "") {
      addKey(h.ep, r.agentId, p, c);
      let a = h.ag.get(r.agentId);
      if (!a) {
        a = { requests: 0, prompt: 0, completion: 0, points: [], intervals: [] };
        h.ag.set(r.agentId, a);
      }
      a.requests += 1;
      a.prompt += p;
      a.completion += c;
      a.points.push(ts);
      a.intervals.push([ts, ts + Math.max(0, num(r.durationMs))]);
    }
    if (r.ok === true) {
      const ttft = num(r.ttftMs);
      if (ttft > 0) {
        h.ttft.push(ttft);
        let samples = h.ttftModel.get(mdKey);
        if (!samples) {
          samples = [];
          h.ttftModel.set(mdKey, samples);
        }
        samples.push(ttft);
      }
      const completion = num(r.completion);
      const genSec = (num(r.durationMs) - num(r.ttftMs)) / 1000;
      if (completion > 0 && genSec >= TPS_MIN_GEN_SEC) {
        const t = h.tps.get(mdKey);
        if (t) {
          t[0] += completion;
          t[1] += genSec;
          t[2] += 1;
        } else {
          h.tps.set(mdKey, [completion, genSec, 1]);
        }
      }
    }
    const day = dayKey(ts);
    let d = fold.dayTotals.get(day);
    if (!d) {
      d = { requests: 0, prompt: 0, completion: 0, cached: 0, ok: 0, ttftSum: 0, ttftCnt: 0 };
      fold.dayTotals.set(day, d);
    }
    d.requests += 1;
    d.prompt += p;
    d.completion += c;
    d.cached += num(r.cached);
    if (r.ok === true) {
      d.ok += 1;
      const ttft = num(r.ttftMs);
      if (ttft > 0) {
        d.ttftSum += ttft;
        d.ttftCnt += 1;
      }
    }
    fold.rows += 1;
  }
}

// 折一批会话行：只有 event:"end" 的行进端点工时表，且只用于「该窗口没有请求行
// 的端点」兜底（双计防护在聚合侧按窗口判定，这里保持逐行原样）。
export function foldSessionRows(fold, rows) {
  for (const r of rows) {
    const ts = Number(r?.ts);
    if (!Number.isFinite(ts)) continue;
    if (r?.event !== "end") continue;
    const hour = floorToHour(ts);
    let m = fold.hours.get(hour);
    if (!m) {
      m = new Map();
      fold.hours.set(hour, m);
    }
    const id = String(r.agentId ?? "");
    let e = m.get(id);
    if (!e) {
      e = { prompt: 0, completion: 0, count: 0, intervals: [] };
      m.set(id, e);
    }
    e.prompt += num(r.prompt);
    e.completion += num(r.completion);
    e.count += 1;
    const startTs = Number(r.startTs);
    if (Number.isFinite(startTs)) {
      e.intervals.push([startTs, startTs + Math.max(0, num(r.durationMs))]);
    }
    fold.rows += 1;
  }
}

// 丢掉过早日子的小时级明细，只留当日总量（热力图还会读它）。窗口最长 7 天，
// 9 天以前的日子不会再被任何窗口读到；这里幂等，重复调用无副作用。
export function trimRequestDetail(fold) {
  if (fold.detail) {
    fold.hours = new Map();
    fold.detail = false;
  }
}

export function trimSessionDetail(fold) {
  if (fold.detail) {
    fold.hours = new Map();
    fold.detail = false;
  }
}

function detailCutoff(today) {
  const [y, m, d] = today.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d - DETAIL_DAYS).getTime());
}

export function createUsageRollups({ journal, now = () => Date.now() } = {}) {
  const KINDS = {
    requests: {
      cache: new Map(),
      create: createRequestFold,
      fold: foldRequestRows,
      trim: trimRequestDetail,
      readRange: (fromDay, toDay) => journal.readRequests({ fromDay, toDay }),
    },
    sessions: {
      cache: new Map(),
      create: createSessionFold,
      fold: foldSessionRows,
      trim: trimSessionDetail,
      readRange: (fromDay, toDay) => journal.readSessions({ fromDay, toDay }),
    },
  };
  // 增量接口缺失时（测试替身 / 旧 journal）走整段读：结构相同、代价同旧实现。
  const incremental =
    typeof journal?.listDayFiles === "function" && typeof journal?.readDayTail === "function";

  // 把某天的缓存推进到最新。半行容错与截短重来都在 journal 侧返回，这里只
  // 决定「保留还是作废这份聚合」。
  function advance(kind, state, day) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = journal.readDayTail(kind, day, state.offset);
      if (!res) return false; // 文件没了：上层当作这天没有数据
      if (res.reset) {
        state.fold = KINDS[kind].create();
        state.offset = 0;
        continue;
      }
      if (res.rows && res.rows.length) KINDS[kind].fold(state.fold, res.rows);
      state.offset = res.offset;
      state.size = res.size;
      state.mtimeMs = res.mtimeMs;
      return true;
    }
    state.size = -1; // 两次都被截短（被反复替换）——留待下次再试
    state.mtimeMs = -1;
    return true;
  }

  function collect(kind, fromDay, toDay) {
    const meta = KINDS[kind];
    if (!incremental) {
      const fold = meta.create();
      let rows = null;
      try {
        rows = meta.readRange(fromDay, toDay);
      } catch {
        rows = null; // 日志不可读 == 没有数据，绝不往上抛
      }
      if (Array.isArray(rows) && rows.length) meta.fold(fold, rows);
      return [fold];
    }

    let files;
    try {
      files = journal.listDayFiles(kind);
    } catch {
      files = [];
    }
    if (!Array.isArray(files)) files = [];
    const present = new Set();
    const units = [];
    const cutoff = kind === "requests" ? detailCutoff(dayKey(now())) : null;
    for (const f of files) {
      present.add(f.day);
      if (f.day < fromDay || f.day > toDay) continue;
      let state = meta.cache.get(f.day);
      if (!state) {
        state = { offset: 0, size: -1, mtimeMs: -1, fold: meta.create() };
        meta.cache.set(f.day, state);
      }
      // 签名没变就不碰文件；变了只读新增尾巴（当天那个文件因此只付增量代价）。
      if (state.size !== f.size || state.mtimeMs !== f.mtimeMs) {
        if (!advance(kind, state, f.day)) {
          meta.cache.delete(f.day);
          continue;
        }
      }
      // 过早的日子压成当日总量；窗口永远碰不到它们（详见 DETAIL_DAYS）。
      if (cutoff !== null && f.day < cutoff) meta.trim(state.fold);
      units.push(state.fold);
    }
    // 保留期清理掉的日文件连带清缓存，常驻内存跟着日志一起收敛。
    for (const day of [...meta.cache.keys()]) if (!present.has(day)) meta.cache.delete(day);
    return units;
  }

  return {
    requests: ({ fromDay, toDay }) => collect("requests", fromDay, toDay),
    sessions: ({ fromDay, toDay }) => collect("sessions", fromDay, toDay),
  };
}
