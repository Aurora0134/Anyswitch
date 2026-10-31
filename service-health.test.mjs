// service-health unit tests.
//
// The tracker answers one question the relay could not answer before: "am I still
// ABLE to serve?" — as opposed to "is my port answering?". The distinction is the
// whole point of the 2026-10-05 incident, where the port answered for 70 minutes
// while every request failed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServiceHealth, DEFAULT_DEGRADED_THRESHOLD } from "./service-health.mjs";

describe("createServiceHealth", () => {
  it("is healthy until the failure threshold is reached", () => {
    const health = createServiceHealth({ threshold: 3 });
    health.recordFailure("credential");
    assert.equal(health.snapshot().degraded, false);
    health.recordFailure("credential");
    assert.equal(health.snapshot().degraded, false);
    health.recordFailure("credential");
    assert.equal(health.snapshot().degraded, true, "第 3 次连续失败才越线");
  });

  it("counts consecutive failures, not a total", () => {
    const health = createServiceHealth({ threshold: 3 });
    health.recordFailure("credential");
    health.recordFailure("credential");
    health.recordSuccess();
    health.recordFailure("credential");
    health.recordFailure("credential");
    assert.equal(health.snapshot().degraded, false, "成功一次即清零，重新计数");
    assert.equal(health.snapshot().consecutiveFailures, 2);
  });

  it("reports the last failure kind and time for the log line", () => {
    const health = createServiceHealth({ threshold: 2, now: () => 4242 });
    health.recordFailure("store");
    const snap = health.snapshot();
    assert.equal(snap.lastFailureKind, "store");
    assert.equal(snap.lastFailureAt, 4242);
    assert.equal(snap.threshold, 2);
  });

  it("defaults to the documented threshold: 5", () => {
    // 阈值是文档承诺（docs/architecture.md：连续 5 次即 degraded），必须用字面量锁定
    // 数值本身——拿 DEFAULT_DEGRADED_THRESHOLD 当夹具规模的话，常量改成几这条都绿。
    assert.equal(DEFAULT_DEGRADED_THRESHOLD, 5);
    const health = createServiceHealth();
    assert.equal(health.snapshot().threshold, 5, "默认参数下快照报告的阈值就是文档承诺的 5");
    for (let i = 1; i <= 4; i += 1) {
      health.recordFailure("credential");
      assert.equal(health.snapshot().degraded, false, `默认阈值下第 ${i} 次连续失败不越线`);
    }
    health.recordFailure("credential");
    assert.equal(health.snapshot().degraded, true, "默认阈值下第 5 次连续失败才越线");
  });

  it("starts clean: nothing has failed yet", () => {
    const snap = createServiceHealth().snapshot();
    assert.equal(snap.consecutiveFailures, 0);
    assert.equal(snap.degraded, false);
    assert.equal(snap.lastFailureKind, null);
  });
});
