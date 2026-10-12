// Sync status sidecar.
//
// Every agent-config sync (relay startup, store.json watcher, settings toggle,
// panel route) writes its outcome here so the panel can surface "上次同步未成功"
// even when 运行日志 is turned off — the logger has a live gate that drops the
// failure line entirely, and before this file existed that was the only place
// a failed sync was reported. The panel polls GET /panel/api/sync-status and
// renders only failures; success stays silent.
//
// The file lives next to store.json under the Anyswitch data root. Writes go
// through atomicWriteFile (tmp + rename) so a polling reader never sees a half
// written document. The store watcher only reacts to store.json-shaped names
// (see isStoreRelated in agent-sync.mjs), so writing this file cannot retrigger
// a sync.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.mjs";
import { parseSyncSummaryLine } from "./agent-sync.mjs";

export const SYNC_STATUS_FILENAME = "sync-status.json";

// Where a sync was triggered from. Surfaced in the file for forensics only;
// the panel renders the same copy regardless of source.
export const SYNC_SOURCES = ["startup", "store-change", "settings", "manual"];

export function syncStatusPath(root) {
  return join(root, SYNC_STATUS_FILENAME);
}

// Map a spawnAgentSync result ({ ok, code?, error?, stdout, stderr }) to the
// persisted status shape. Pure — exported for unit tests.
//
// ok === true only when every endpoint was written. A runner that finished
// with some endpoints unwritten exits 0, so the failed list comes from the
// machine-readable summary line, not the exit code. A process-level failure
// (spawn error, timeout, store unreadable, runner crash) has failed: [] and
// carries the reason in error.
export function syncStatusFromResult(result, source) {
  const at = new Date().toISOString();
  const summary = parseSyncSummaryLine(result?.stdout);
  if (summary) {
    const ok = summary.ok && summary.failed.length === 0;
    const status = { at, ok, failed: summary.failed, synced: summary.synced, source };
    if (!ok && summary.failed.length === 0) {
      status.error = result?.error ?? `runner exit ${result?.code ?? "unknown"}`;
    }
    return status;
  }
  return {
    at,
    ok: false,
    failed: [],
    synced: [],
    error: result?.error ?? `runner exit ${result?.code ?? "unknown"}`,
    source,
  };
}

export function writeSyncStatus(root, status) {
  atomicWriteFile(syncStatusPath(root), JSON.stringify(status, null, 2) + "\n");
}

// Returns the parsed status, or null when the file is missing, unreadable, or
// not a well-formed status — callers render "无从报告" for null and must never
// 500 on a corrupt file.
export function readSyncStatus(root) {
  let text;
  try {
    text = readFileSync(syncStatusPath(root), "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (typeof parsed.at !== "string" || typeof parsed.ok !== "boolean") return null;
  const names = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
  const status = {
    at: parsed.at,
    ok: parsed.ok,
    failed: names(parsed.failed),
    synced: names(parsed.synced),
    source: SYNC_SOURCES.includes(parsed.source) ? parsed.source : "manual",
  };
  if (typeof parsed.error === "string") status.error = parsed.error;
  return status;
}
