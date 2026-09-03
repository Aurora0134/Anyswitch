// Per-request usage journal: daily-rolled JSONL files under the usage dir
// (e.g. %LOCALAPPDATA%\ApiCred\usage). Side-band for the relay hot path —
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
//   { "ts": 1724900000000, "agentId": "zcode|dsh|kimi|pi|agy|reasonix|opencode|claude",
//     "providerId": "渠道id或号池id(池按整体)", "model": "kimi-k3",
//     "prompt": 1234, "completion": 567, "cached": 100,
//     "ttftMs": 850, "durationMs": 5200, "ok": true, "status": 200,
//     "errKind": null, "stream": true, "path": "openai|anthropic|gemini",
//     "instanceId": "ws-1" /* 可选：多实例端点的实例标签，有则写 */ }
//   errKind enum: null | "http_429" | "http_5xx" | "http_4xx" | "network" | "timeout" | "abort"
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

// Local-timezone day key, exported for the aggregation layer.
export function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

  return {
    appendRequest: (entry) => append("requests", entry),
    appendSession: (entry) => append("sessions", entry),
    readRequests: (range) => read("requests", range),
    readSessions: (range) => read("sessions", range),
    cleanup,
  };
}
