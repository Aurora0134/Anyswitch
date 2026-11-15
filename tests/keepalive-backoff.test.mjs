// Deterministic unit tests for computeRetryDelay: the shared keep-alive
// backoff pure function. A fixed rng makes every assertion exact — no timing,
// no flakiness.
//
// 纯函数之外，本文件还经 deps.computeRetryDelay 注入缝钉住 stream-pipe 三处
// 调用点的入参契约：重试退避必须按 1-based 次数取值（第一次重试取 1）。这条
// 契约曾只活在纯函数的单元测试里——调用点改成 0-based 时全部旧用例仍然全绿。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeRetryDelay } from "../src/shared/keepalive-backoff.mjs";
import { runStreamWithKeepAlive } from "../src/relay/stream-pipe.mjs";

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

// ── 调用点契约：退避入参按 1-based 次数传入 ─────────────────────────────────
//
// deps.computeRetryDelay 是源码预留的注入缝（生产缺省落回共享纯函数）。测试注入
// 记录器并返回 0，免去真实睡眠；每次退避的 (backoffMs, attempt) 原样留痕。调用
// 点从 attempt + 1 改成 attempt（0-based 回归）时，下面三条全部变红——这正是纯
// 函数单元测试曾漏掉的那条腿。

function recordingDeps(recorded, { maxRetries = 2, backoffMs = 1234 } = {}) {
  return {
    getKeepAliveConfig: () => ({ enabled: true, maxRetries, backoffMs }),
    computeRetryDelay: (backoff, attempt) => {
      recorded.push({ backoffMs: backoff, attempt });
      return 0;
    },
  };
}

function fakeRes() {
  return { writableEnded: false, destroyed: false };
}

describe("stream-pipe 退避调用点（1-based 契约）", () => {
  it("5xx 静默重试腿：第一次重试取 1、第二次取 2", async () => {
    const recorded = [];
    const terminals = [];
    await runStreamWithKeepAlive(fakeRes(), {
      deps: recordingDeps(recorded),
      tracker: null,
      abortController: new AbortController(),
      pipe: () => { throw new Error("5xx 状态必须在进入管道前完成重试"); },
      callUpstreams: [{
        memberId: "solo",
        call: async () => ({ status: 503, body: { error: { message: "upstream 503" } }, stream: null }),
      }],
      onCallError: (error) => { throw error; },
      onTerminalResult: (result) => terminals.push(result.status),
      onSettled: () => { throw new Error("unexpected settled"); },
      exhaustedMessage: () => "exhausted",
      sendExhausted: () => {},
      logLabel: "request",
      agentId: "zcode",
    });
    assert.deepEqual(recorded, [
      { backoffMs: 1234, attempt: 1 },
      { backoffMs: 1234, attempt: 2 },
    ], "重试退避必须按 1-based 次数取值（0-based 回归此处变红）");
    assert.deepEqual(terminals, [503], "预算耗尽按末次上游状态收尾");
  });

  it("前置可重试流故障腿（空流）：两次退避同样按 1、2 取值", async () => {
    const recorded = [];
    const sends = [];
    await runStreamWithKeepAlive(fakeRes(), {
      deps: recordingDeps(recorded),
      tracker: null,
      abortController: new AbortController(),
      pipe: async () => ({ outcome: "retryable", reason: "empty_stream" }),
      callUpstreams: [{ memberId: "solo", call: async () => ({ status: 200, stream: {} }) }],
      onCallError: (error) => { throw error; },
      onTerminalResult: () => { throw new Error("unexpected terminal"); },
      onSettled: () => { throw new Error("unexpected settled"); },
      exhaustedMessage: () => "exhausted",
      sendExhausted: (message) => sends.push(message),
      logLabel: "request",
      agentId: "zcode",
    });
    assert.deepEqual(recorded, [
      { backoffMs: 1234, attempt: 1 },
      { backoffMs: 1234, attempt: 2 },
    ]);
    assert.equal(sends.length, 1, "预算耗尽按穷尽收尾");
  });

  it("续接腿（on 档）：续接重试同样按 1 取值", async () => {
    const recorded = [];
    await runStreamWithKeepAlive(fakeRes(), {
      deps: recordingDeps(recorded, { maxRetries: 1 }),
      tracker: null,
      abortController: new AbortController(),
      pipe: async () => ({ outcome: "resume", reason: "upstream_incomplete", shadow: { text: "partial" } }),
      callUpstreams: [{ memberId: "solo", call: async () => ({ status: 200, stream: {} }) }],
      originalBody: { model: "m", messages: [{ role: "user", content: "hi" }] },
      onCallError: (error) => { throw error; },
      onTerminalResult: () => { throw new Error("unexpected terminal"); },
      onSettled: () => { throw new Error("unexpected settled"); },
      exhaustedMessage: () => "exhausted",
      sendExhausted: () => {},
      logLabel: "request",
      agentId: "zcode",
    });
    assert.deepEqual(recorded, [{ backoffMs: 1234, attempt: 1 }],
      "续接重试的退避同样按 1-based 次数取值");
  });
});
