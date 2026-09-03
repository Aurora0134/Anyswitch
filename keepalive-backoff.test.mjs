// Deterministic unit tests for computeRetryDelay: the shared keep-alive
// backoff pure function. A fixed rng makes every assertion exact — no timing,
// no flakiness.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeRetryDelay } from "./keepalive-backoff.mjs";

describe("computeRetryDelay", () => {
  it("first retry stays within [0.5x, 1x] of backoffMs (upper bound matches the old fixed delay)", () => {
    assert.equal(computeRetryDelay(500, 1, () => 0), 250);
    assert.equal(computeRetryDelay(500, 1, () => 1), 500);
    assert.equal(computeRetryDelay(500, 1, () => 0.5), 375);
  });

  it("doubles the base delay per retry attempt (1-based)", () => {
    assert.equal(computeRetryDelay(500, 2, () => 0), 500);
    assert.equal(computeRetryDelay(500, 3, () => 0), 1000);
    assert.equal(computeRetryDelay(500, 4, () => 1), 4000);
    // Same jitter factor across attempts -> exact doubling.
    assert.equal(computeRetryDelay(200, 1, () => 0.5), 150);
    assert.equal(computeRetryDelay(200, 2, () => 0.5), 300);
    assert.equal(computeRetryDelay(200, 3, () => 0.5), 600);
  });

  it("never leaves the [0.5, 1.0] * base band for any rng value", () => {
    for (let i = 0; i <= 10; i += 1) {
      const r = i / 10;
      for (const attempt of [1, 2, 3, 4, 5]) {
        const base = 500 * 2 ** (attempt - 1);
        const d = computeRetryDelay(500, attempt, () => r);
        assert.ok(d >= base * 0.5, `attempt ${attempt} rng ${r}: ${d} below ${base * 0.5}`);
        assert.ok(d <= base, `attempt ${attempt} rng ${r}: ${d} above ${base}`);
      }
    }
  });

  it("defaults rng to Math.random and stays in band", () => {
    for (let i = 0; i < 100; i += 1) {
      const d = computeRetryDelay(500, 2);
      assert.ok(d >= 500 && d <= 1000, `default rng delay ${d} out of [500, 1000]`);
    }
  });

  it("zero backoff stays zero", () => {
    assert.equal(computeRetryDelay(0, 1, () => 1), 0);
    assert.equal(computeRetryDelay(0, 3, () => 0.5), 0);
  });
});
