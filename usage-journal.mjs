// Per-request usage journal: daily-rolled JSONL files under the usage dir
// (e.g. %LOCALAPPDATA%\Anyswitch\usage). Side-band for the relay hot path —
// append failures warn and never throw back at the caller.
//
// File shape: `dir/requests-YYYY-MM-DD.jsonl` and `dir/sessions-YYYY-MM-DD.jsonl`,
// one JSON object per line. The day in the file name is the *local* date of
// `now()` at append time. Retention defaults to 90 days; cleanup runs once at
// create time and again whenever `now()` crosses a day boundary (not per append).
//
// Entry schema (contract for writers and the aggregation layer):
//
// requests line:
//   { "ts": 1724900000000, "agentId": "zcode|dsh|kimi|pi|qoder|opencode|claude|codex|grok|null",
//     "providerId": "渠道id或号池id(池按整体)", "model": "kimi-k3",
//     "prompt": 1234, "completion": 567, "cached": 100,
//     "ttftMs": 850, "durationMs": 5200, "ok": true, "status": 200,
//     "errKind": null, "stream": true, "path": "openai|anthropic",
//     "errMsg": "上游错误原文（可选：仅失败行；消毒：折叠空白/trim/截 200 字符）",
//     "instanceId": "ws-1" /* 可选：多实例端点的实例标签，有则写 */ }
//   agentId: null 表示「未知来源」（认不出归属的请求）：行照记作审计账，
//   但不进任何端点维度——看板卡与统计页端点行/端点趋势/端点用量都不显示它。
//   errKind enum: null | "http_429" | "http_5xx" | "http_4xx" | "network" | "timeout" | "abort"
//   errMsg: 调用方传上游错误原文，journal 统一消毒（非字符串/空串丢弃不写该键），
//   成功行不传——旧行无此键，读侧按可缺省处理。
//   Missing fields are tolerated: readers/aggregators treat them as 0/null.
//
// sessions line (endpoint session / work-hours, written mainly by the panel
// process for claude sessions):
//   { "ts": 1724900000000, "agentId": "claude", "event": "end",
//     "startTs": 1724890000000, "durationMs": 3600000,
//     "prompt": 0, "completion": 0, "cached": 0 }

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const FILE_RE = /^(requests|sessions)-(\d{4}-\d{2}-\d{2})\.jsonl$/;
// LRU cap for the read() parse cache. Sized well above the worst-case full
// read (90-day retention × 2 kinds ≈ 180 files) so range-less stats reads
// never thrash it.
const READ_CACHE_LIMIT = 200;
// errMsg 消毒上限：上游错误原文可能带大段堆栈/HTML，日志行只留可读头 200 字符。
const ERR_MSG_MAX = 200;
// agentId 过滤的「未知来源」哨兵：null 是合法行值，不能直接当查询参数传。
export const AGENT_ID_NONE = "__none__";

// Local-timezone day key, exported for the aggregation layer.
export function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// errMsg 消毒（写侧单点）：非字符串丢弃；连续空白折叠为单空格 + trim +
// 截断 200 字符；结果为空串则视为没有（不落键）。
function sanitizeErrMsg(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim().slice(0, ERR_MSG_MAX);
  return cleaned === "" ? null : cleaned;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function createUsageJournal({ dir, retentionDays = 90, now = () => Date.now() }) {
  let lastCleanupDay = null;

  // Parse cache for read(): path -> { mtimeMs, size, lines }. Validated by
  // stat on every read — any append changes the file size, so staleness is
  // impossible to miss. Map insertion order doubles as LRU recency.
  // CONTRACT: cached `lines` arrays are shared between calls; callers of
  // read()/readRequests()/readSessions() must never mutate returned entries.
  const lineCache = new Map();

  // Returns the parsed lines of one journal file, or null when the file
  // cannot be statted/read (e.g. swept by retention cleanup) — the caller
  // then skips that file, mirroring the old per-file continue semantics.
  function readLinesCached(path) {
    let st;
    try {
      st = statSync(path);
    } catch {
      lineCache.delete(path); // file gone — drop any stale cached entry
      return null;
    }
    const hit = lineCache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      lineCache.delete(path);
      lineCache.set(path, hit); // refresh LRU recency
      return hit.lines;
    }
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      lineCache.delete(path); // vanished between stat and read — cache nothing
      return null;
    }
    const lines = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // corrupt/truncated line — skip, never blow up the read
      }
    }
    lineCache.delete(path);
    if (lineCache.size >= READ_CACHE_LIMIT) {
      lineCache.delete(lineCache.keys().next().value); // evict oldest
    }
    lineCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, lines });
    return lines;
  }

  function fileFor(kind, day) {
    return join(dir, `${kind}-${day}.jsonl`);
  }

  function cleanup() {
    lastCleanupDay = dayKey(now());
    const cutoff = dayKey(now() - retentionDays * DAY_MS);
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return; // dir not created yet — nothing to retain or delete
    }
    for (const name of names) {
      const match = FILE_RE.exec(name);
      if (match && match[2] < cutoff) {
        try {
          rmSync(join(dir, name), { force: true });
        } catch (error) {
          console.warn(`[usage-journal] cleanup failed for ${name}: ${error.message}`);
        }
      }
    }
  }

  function maybeCleanup() {
    if (dayKey(now()) !== lastCleanupDay) cleanup();
  }

  function append(kind, entry) {
    try {
      maybeCleanup();
      mkdirSync(dir, { recursive: true });
      appendFileSync(fileFor(kind, dayKey(now())), `${JSON.stringify(entry)}\n`, { flag: "a" });
    } catch (error) {
      console.warn(`[usage-journal] append ${kind} failed: ${error.message}`);
    }
  }

  // 请求行写入：errMsg 在 journal 内统一消毒（写侧单点，各写点传原值即可）。
  // 消毒结果为空则整键摘除——成功行与无消息失败行的落盘形状与旧版完全一致。
  function appendRequest(entry) {
    const errMsg = sanitizeErrMsg(entry?.errMsg);
    let row = entry;
    if (errMsg === null) {
      if (entry && typeof entry === "object" && "errMsg" in entry) {
        const { errMsg: _drop, ...rest } = entry;
        row = rest;
      }
    } else {
      row = { ...entry, errMsg };
    }
    append("requests", row);
  }

  function read(kind, { fromDay, toDay } = {}) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return []; // missing dir == empty journal
    }
    const days = [];
    for (const name of names) {
      const match = FILE_RE.exec(name);
      if (!match || match[1] !== kind) continue;
      const day = match[2];
      if (fromDay && day < fromDay) continue;
      if (toDay && day > toDay) continue;
      days.push(day);
    }
    days.sort();
    const entries = [];
    for (const day of days) {
      const lines = readLinesCached(fileFor(kind, day));
      if (lines === null) continue; // file vanished between readdir and read
      // Copy refs into a fresh array — never sort/mutate the cached arrays.
      entries.push(...lines);
    }
    entries.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    return entries;
  }

  cleanup(); // retention sweep at create time

  // 请求日志查询面（统计页「请求日志」子 tab 的数据源）：在 requests 流上做
  // 筛选/排序/分页，行原样透传不聚合。范围 [fromDay, toDay] 闭区间，按天
  // 新→旧读（复用 readLinesCached 的解析缓存）。facets 只受时间范围影响：
  // 在仅时间过滤的行集上收集 distinct agentId（可含 null）/providerId/model，
  // 供筛选下拉回填——筛选项自身不会把自己从下拉里筛没。
  function readRequestsLog({
    fromDay, toDay,
    agentId, providerId, model, ok, errKind,
    sortBy = "ts", sortDir = "desc",
    page = 1, pageSize = 20,
  } = {}) {
    const sortField = sortBy === "durationMs" ? "durationMs" : "ts";
    const asc = sortDir === "asc";
    let pageNo = Math.floor(Number(page));
    if (!Number.isFinite(pageNo) || pageNo < 1) pageNo = 1;
    let size = Math.floor(Number(pageSize));
    if (!Number.isFinite(size)) size = 20;
    size = Math.min(100, Math.max(1, size));

    let names;
    try {
      names = readdirSync(dir);
    } catch {
      names = null; // missing dir == empty journal
    }
    const days = [];
    if (names) {
      for (const name of names) {
        const match = FILE_RE.exec(name);
        if (!match || match[1] !== "requests") continue;
        const day = match[2];
        if (fromDay && day < fromDay) continue;
        if (toDay && day > toDay) continue;
        days.push(day);
      }
      days.sort();
      days.reverse(); // 新→旧
    }

    const rangeRows = []; // 仅时间范围过滤（facets 的行集）
    const matched = [];   // 再叠加筛选条件后的全量匹配集
    for (const day of days) {
      const lines = readLinesCached(fileFor("requests", day));
      if (lines === null) continue; // file vanished between readdir and read
      for (const r of lines) {
        rangeRows.push(r);
        if (agentId !== undefined && agentId !== null) {
          // 哨兵 "__none__" 匹配归属缺失（null/缺键）的行
          if (agentId === AGENT_ID_NONE) {
            if (r.agentId !== null && r.agentId !== undefined) continue;
          } else if (r.agentId !== agentId) continue;
        }
        if (providerId !== undefined && providerId !== null && r.providerId !== providerId) continue;
        if (model !== undefined && model !== null && r.model !== model) continue;
        if (ok !== undefined && ok !== null && r.ok !== ok) continue;
        if (errKind !== undefined && errKind !== null && r.errKind !== errKind) continue;
        matched.push(r);
      }
    }

    // 全量匹配集上排序（90 天 retention 封顶约十万行，内存排序成立）；
    // 主键并列时 ts desc 兜底，再并列保持读入顺序（sort 稳定）。
    matched.sort((a, b) => {
      const av = num(a?.[sortField]);
      const bv = num(b?.[sortField]);
      if (av !== bv) return asc ? av - bv : bv - av;
      return num(b?.ts) - num(a?.ts);
    });

    // distinct 值字母序，null 排最前（未知来源在筛选下拉里固定置顶语义由前端定）
    const facetSort = (a, b) => (a === null ? (b === null ? 0 : -1) : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0);
    const agents = new Set();
    const providers = new Set();
    const models = new Set();
    for (const r of rangeRows) {
      agents.add(r.agentId ?? null);
      providers.add(r.providerId ?? null);
      models.add(r.model ?? null);
    }

    const total = matched.length;
    const start = (pageNo - 1) * size;
    return {
      rows: matched.slice(start, start + size), // 页超界 → 空 rows，total 如实
      total,
      page: pageNo,
      pageSize: size,
      facets: {
        agents: [...agents].sort(facetSort),
        providers: [...providers].sort(facetSort),
        models: [...models].sort(facetSort),
      },
    };
  }

  return {
    appendRequest,
    appendSession: (entry) => append("sessions", entry),
    readRequests: (range) => read("requests", range),
    readSessions: (range) => read("sessions", range),
    readRequestsLog,
    cleanup,
  };
}
