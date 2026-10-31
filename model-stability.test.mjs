import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createModelStabilityTracker,
  statusOf,
  bucketStart,
  BUCKET_MS,
  BUCKET_COUNT,
  WINDOW_MS,
} from "./model-stability.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

describe("statusOf", () => {
  it("uses 85 green / 70 yellow / else red", () => {
    assert.equal(statusOf(85), "green");
    assert.equal(statusOf(84.9), "yellow");
    assert.equal(statusOf(70), "yellow");
    assert.equal(statusOf(69.9), "red");
  });
});

describe("createModelStabilityTracker", () => {
  it("ranks by 8h call volume and returns 48 cells", () => {
    let t = 8 * 60 * 60 * 1000;
    const tracker = createModelStabilityTracker({ nowFn: () => t });
    for (let i = 0; i < 10; i++) {
      tracker.record({ providerId: "acme", model: "claude-sonnet-4-5", ok: true, latencyMs: 2000, prompt: 100, cached: 20, at: t });
    }
    for (let i = 0; i < 3; i++) {
      tracker.record({ providerId: "bigmodel", model: "glm-4.7", ok: true, latencyMs: 800, prompt: 50, cached: 10, at: t });
    }
    const snap = tracker.snapshot(t);
    assert.equal(snap.buckets, 48);
    assert.equal(snap.models.length, 2);
    assert.equal(snap.models[0].model, "claude-sonnet-4-5");
    assert.equal(snap.models[0].total, 10);
    assert.equal(snap.models[0].cells.length, BUCKET_COUNT);
    assert.equal(snap.models[0].status, "green");
    assert.equal(snap.models[0].cacheHit, 20);
    assert.equal(snap.models[0].latencyMs, 2000);
  });

  it("weights success rate by call count across buckets and paints a cell red below 70%", () => {
    const base = bucketStart(1_000_000);
    let t = base + 1000;
    const tracker = createModelStabilityTracker({ nowFn: () => t });
    // Older bucket: the only call fails (cell rate 0). Newer bucket: three calls all succeed.
    tracker.record({ providerId: "acme", model: "gpt-5.2", ok: false, latencyMs: 100, at: t });
    t = base + BUCKET_MS + 1000;
    for (let i = 0; i < 3; i++) {
      tracker.record({ providerId: "acme", model: "gpt-5.2", ok: true, latencyMs: 100, at: t });
    }
    const snap = tracker.snapshot(t);
    const m = snap.models[0];
    // Call-count weighting: (3 ok / 4 total) = 75 → yellow. A per-bucket simple
    // average of cell rates would give (0 + 100) / 2 = 50 → red, so this
    // assertion distinguishes the two.
    assert.equal(m.total, 4);
    assert.equal(m.successRate, 75);
    assert.equal(m.status, "yellow");
    const cells = m.cells;
    assert.equal(cells[cells.length - 2].n, 1);
    assert.equal(cells[cells.length - 2].rate, 0);
    assert.equal(cells[cells.length - 2].status, "red");
    const last = cells[cells.length - 1];
    assert.equal(last.n, 3);
    assert.equal(last.rate, 100);
    assert.equal(last.status, "green");
  });

  it("drops buckets older than 8h from ranking", () => {
    const start = 10 * WINDOW_MS;
    let t = start;
    const tracker = createModelStabilityTracker({ nowFn: () => t });
    tracker.record({ providerId: "old", model: "stale-model", ok: true, latencyMs: 10, at: start });
    t = start + WINDOW_MS + BUCKET_MS;
    tracker.record({ providerId: "new", model: "fresh-model", ok: true, latencyMs: 10, at: t });
    const snap = tracker.snapshot(t);
    assert.equal(snap.models.length, 1);
    assert.equal(snap.models[0].model, "fresh-model");
  });

  it("caps snapshot at five models even when more pairs exist", () => {
    let t = 1000;
    const tracker = createModelStabilityTracker({ nowFn: () => t });
    for (let i = 0; i < 7; i++) {
      const n = 7 - i;
      for (let k = 0; k < n; k++) {
        tracker.record({ providerId: "p", model: `m${i}`, ok: true, latencyMs: 1, at: t });
      }
    }
    const snap = tracker.snapshot(t);
    assert.equal(snap.models.length, 5);
    assert.equal(snap.models[0].model, "m0");
    assert.equal(snap.models[4].model, "m4");
  });

  it("aggregates ttftMs as the window mean over records that carry one", () => {
    let t = bucketStart(2_000_000) + 1000;
    const tracker = createModelStabilityTracker({ nowFn: () => t });
    tracker.record({ providerId: "p1", model: "m-ttft", ok: true, latencyMs: 3000, ttftMs: 1000, at: t });
    tracker.record({ providerId: "p1", model: "m-ttft", ok: true, latencyMs: 5000, ttftMs: 2000, at: t });
    tracker.record({ providerId: "p1", model: "m-ttft", ok: true, latencyMs: 4000, ttftMs: 1500, at: t });
    const snap = tracker.snapshot(t);
    assert.equal(snap.models[0].ttftMs, 1500);
  });

  it("outputs ttftMs null when no record in the window carried a TTFT", () => {
    let t = bucketStart(2_000_000) + 1000;
    const tracker = createModelStabilityTracker({ nowFn: () => t });
    tracker.record({ providerId: "p1", model: "m-no-ttft", ok: true, latencyMs: 3000, at: t });
    tracker.record({ providerId: "p1", model: "m-no-ttft", ok: false, latencyMs: 100, at: t });
    const snap = tracker.snapshot(t);
    assert.equal(snap.models[0].ttftMs, null);
  });

  it("averages TTFT only over records that carried one (failures without TTFT excluded)", () => {
    let t = bucketStart(2_000_000) + 1000;
    const tracker = createModelStabilityTracker({ nowFn: () => t });
    tracker.record({ providerId: "p1", model: "m-mixed", ok: true, latencyMs: 3000, ttftMs: 1000, at: t });
    tracker.record({ providerId: "p1", model: "m-mixed", ok: false, latencyMs: 60000, at: t });
    tracker.record({ providerId: "p1", model: "m-mixed", ok: true, latencyMs: 5000, ttftMs: 3000, at: t });
    const snap = tracker.snapshot(t);
    assert.equal(snap.models[0].total, 3);
    assert.equal(snap.models[0].ttftMs, 2000);
  });

  it("tolerates a legacy sidecar whose cells have no ttft fields", () => {
    const dir = mkTestDir("ms-legacy-");
    const path = join(dir, "model-stability.json");
    const t0 = bucketStart(5_000_000);
    writeFileSync(path, JSON.stringify({
      models: [{
        provider: "legacy-prov",
        model: "legacy-model",
        cells: [{ start: t0, n: 2, ok: 2, latencySum: 2000, prompt: 100, cached: 10 }],
      }],
    }));
    let t = t0 + 1000;
    const tracker = createModelStabilityTracker({ nowFn: () => t, persistPath: path, persistEveryMs: 0 });
    const snap = tracker.snapshot(t);
    assert.equal(snap.models[0].model, "legacy-model");
    assert.equal(snap.models[0].total, 2);
    assert.equal(snap.models[0].ttftMs, null);
    // And the legacy row still accepts new TTFT-bearing records afterwards.
    tracker.record({ providerId: "legacy-prov", model: "legacy-model", ok: true, latencyMs: 3000, ttftMs: 900, at: t });
    assert.equal(tracker.snapshot(t).models[0].ttftMs, 900);
  });

  it("roundtrips ttft aggregates through the persisted sidecar", () => {
    const dir = mkTestDir("ms-ttft-");
    const path = join(dir, "model-stability.json");
    const t0 = bucketStart(5_000_000);
    let t = t0 + 1000;
    // Write side: record twice, then persist and inspect what lands on disk.
    const writer = createModelStabilityTracker({ nowFn: () => t, persistPath: path, persistEveryMs: 0 });
    writer.record({ providerId: "p1", model: "m-persist", ok: true, latencyMs: 2000, prompt: 100, cached: 25, ttftMs: 1000, at: t });
    writer.record({ providerId: "p1", model: "m-persist", ok: true, latencyMs: 2000, prompt: 100, cached: 25, ttftMs: 1400, at: t });
    writer.persist(t);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    const cell = onDisk.models.find((m) => m.model === "m-persist").cells.find((c) => c.start === t0);
    assert.equal(cell.n, 2);
    assert.equal(cell.ok, 2);
    assert.equal(cell.latencySum, 4000);
    assert.equal(cell.prompt, 200);
    assert.equal(cell.cached, 50);
    assert.equal(cell.ttftSum, 2400);
    assert.equal(cell.ttftN, 2);
    // Read side: a fresh tracker reloads the file and keeps ttftMs / cacheHit.
    const reader = createModelStabilityTracker({ nowFn: () => t, persistPath: path, persistEveryMs: 0 });
    const snap = reader.snapshot(t);
    assert.equal(snap.models[0].model, "m-persist");
    assert.equal(snap.models[0].total, 2);
    assert.equal(snap.models[0].ttftMs, 1200);
    assert.equal(snap.models[0].cacheHit, 25);
  });

  it("reloads persisted sidecar on create", () => {
    const dir = mkTestDir("ms-");
    const path = join(dir, "model-stability.json");
    const t0 = bucketStart(5_000_000);
    writeFileSync(path, JSON.stringify({
      models: [{
        provider: "legacy-prov",
        model: "gemini-3-pro",
        cells: [{ start: t0, n: 4, ok: 4, latencySum: 4000, prompt: 200, cached: 50 }],
      }],
    }));
    let t = t0 + 1000;
    const tracker = createModelStabilityTracker({ nowFn: () => t, persistPath: path, persistEveryMs: 0 });
    const snap = tracker.snapshot(t);
    assert.equal(snap.models[0].model, "gemini-3-pro");
    assert.equal(snap.models[0].total, 4);
    assert.equal(snap.models[0].cacheHit, 25);
  });
});
