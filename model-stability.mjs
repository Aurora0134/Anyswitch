// P4 model-stability: 8h rolling window, 10-minute buckets, Top-5 by call volume.
// Pure in-memory + optional sidecar persist.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.mjs";

export const STABILITY_FILENAME = "model-stability.json";
export const BUCKET_MS = 10 * 60 * 1000;
export const WINDOW_MS = 8 * 60 * 60 * 1000;
export const BUCKET_COUNT = WINDOW_MS / BUCKET_MS; // 48
export const TOP_N = 5;
export const RATE_GREEN = 85;
export const RATE_YELLOW = 70;

export function stabilityFilePath(root) {
  return join(root, STABILITY_FILENAME);
}

export function bucketStart(ts, bucketMs = BUCKET_MS) {
  return Math.floor(Number(ts) / bucketMs) * bucketMs;
}

export function statusOf(rate) {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return "gray";
  if (rate >= RATE_GREEN) return "green";
  if (rate >= RATE_YELLOW) return "yellow";
  return "red";
}

function pairKey(provider, model) {
  return `${provider ?? ""}/${model ?? ""}`;
}

function emptyCell() {
  return { n: 0, ok: 0, latencySum: 0, prompt: 0, cached: 0, ttftSum: 0, ttftN: 0 };
}

export function createModelStabilityTracker(options = {}) {
  const nowFn = options.nowFn ?? Date.now;
  const persistPath = options.persistPath ?? null;
  const persistEveryMs = options.persistEveryMs ?? 30_000;
  const fsWrite = options.atomicWrite ?? atomicWriteFile;

  /** @type {Map<string, { provider: string, model: string, cells: Map<number, object> }>} */
  const series = new Map();
  let lastPersistAt = 0;
  let dirty = false;

  function loadFromDisk() {
    if (!persistPath || !existsSync(persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(persistPath, "utf8"));
      ingestSnapshot(raw);
    } catch {
      // corrupt sidecar: start empty, next persist overwrites
    }
  }

  function ingestSnapshot(raw) {
    if (!raw || !Array.isArray(raw.models)) return;
    const cutoff = nowFn() - WINDOW_MS;
    for (const m of raw.models) {
      if (!m || typeof m.model !== "string") continue;
      const provider = typeof m.provider === "string" ? m.provider : "";
      const key = pairKey(provider, m.model);
      const cells = new Map();
      if (Array.isArray(m.cells)) {
        for (const c of m.cells) {
          if (!c || typeof c.start !== "number") continue;
          if (c.start < cutoff) continue;
          cells.set(c.start, {
            n: Number(c.n) || 0,
            ok: Number(c.ok) || 0,
            latencySum: Number(c.latencySum) || 0,
            prompt: Number(c.prompt) || 0,
            cached: Number(c.cached) || 0,
            // Legacy sidecars predate TTFT tracking: absent fields load as 0.
            ttftSum: Number(c.ttftSum) || 0,
            ttftN: Number(c.ttftN) || 0,
          });
        }
      }
      series.set(key, { provider, model: m.model, cells });
    }
  }

  function prune(now = nowFn()) {
    const cutoff = now - WINDOW_MS;
    for (const [key, rec] of series) {
      for (const start of rec.cells.keys()) {
        if (start < cutoff) rec.cells.delete(start);
      }
      if (rec.cells.size === 0) series.delete(key);
    }
  }

  function record({ providerId, model, ok, latencyMs, prompt = 0, cached = 0, ttftMs, at } = {}) {
    if (!model) return;
    const ts = typeof at === "number" ? at : nowFn();
    const start = bucketStart(ts);
    const provider = providerId || "";
    const key = pairKey(provider, model);
    let rec = series.get(key);
    if (!rec) {
      rec = { provider, model, cells: new Map() };
      series.set(key, rec);
    }
    let cell = rec.cells.get(start);
    if (!cell) {
      cell = emptyCell();
      rec.cells.set(start, cell);
    }
    cell.n += 1;
    if (ok) cell.ok += 1;
    if (typeof latencyMs === "number" && latencyMs > 0) cell.latencySum += latencyMs;
    // TTFT is a separate dimension from latencyMs (full request duration):
    // only records that observed a real first token carry one, so failures
    // and aborts must not dilute the mean. ttftN counts those samples.
    if (typeof ttftMs === "number" && ttftMs > 0) {
      cell.ttftSum += ttftMs;
      cell.ttftN += 1;
    }
    cell.prompt += Number(prompt) || 0;
    cell.cached += Number(cached) || 0;
    dirty = true;
    prune(ts);
    maybePersist(ts);
  }

  function maybePersist(now) {
    if (!persistPath || !dirty) return;
    if (now - lastPersistAt < persistEveryMs) return;
    persist(now);
  }

  function persist(now = nowFn()) {
    if (!persistPath) return;
    prune(now);
    try {
      fsWrite(persistPath, JSON.stringify(toPersistShape(now), null, 2));
      lastPersistAt = now;
      dirty = false;
    } catch {
      // persist is best-effort; in-memory remains source of truth
    }
  }

  function toPersistShape(now) {
    const models = [];
    for (const rec of series.values()) {
      const cells = [];
      for (const [start, c] of rec.cells) {
        cells.push({ start, ...c });
      }
      models.push({ provider: rec.provider, model: rec.model, cells });
    }
    return { windowMs: WINDOW_MS, bucketMs: BUCKET_MS, savedAt: now, models };
  }

  function snapshot(now = nowFn()) {
    prune(now);
    const windowStart = bucketStart(now) - (BUCKET_COUNT - 1) * BUCKET_MS;
    const ranked = [];

    for (const rec of series.values()) {
      let total = 0;
      let ok = 0;
      let latencySum = 0;
      let prompt = 0;
      let cached = 0;
      let ttftSum = 0;
      let ttftN = 0;
      const cells = [];
      for (let i = 0; i < BUCKET_COUNT; i++) {
        const start = windowStart + i * BUCKET_MS;
        const c = rec.cells.get(start) || emptyCell();
        total += c.n;
        ok += c.ok;
        latencySum += c.latencySum;
        prompt += c.prompt;
        cached += c.cached;
        ttftSum += c.ttftSum;
        ttftN += c.ttftN;
        const rate = c.n > 0 ? (c.ok / c.n) * 100 : 0;
        cells.push({
          n: c.n,
          rate: c.n > 0 ? Number(rate.toFixed(1)) : 0,
          status: c.n > 0 ? statusOf(rate) : "idle",
        });
      }
      if (total === 0) continue;
      const successRate = (ok / total) * 100;
      ranked.push({
        model: rec.model,
        provider: rec.provider,
        total,
        successRate: Number(successRate.toFixed(1)),
        status: statusOf(successRate),
        latencyMs: total > 0 ? Math.round(latencySum / total) : 0,
        // Raw aggregate only — the green/yellow threshold is a product
        // decision owned by the frontend, not baked in here.
        ttftMs: ttftN > 0 ? Math.round(ttftSum / ttftN) : null,
        cacheHit: prompt > 0 ? Number(((cached / prompt) * 100).toFixed(1)) : 0,
        cells,
      });
    }

    ranked.sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
    return {
      window: "8h",
      buckets: BUCKET_COUNT,
      bucketMs: BUCKET_MS,
      generatedAt: now,
      models: ranked.slice(0, TOP_N),
    };
  }

  loadFromDisk();

  return {
    record,
    snapshot,
    persist,
    prune,
  };
}
