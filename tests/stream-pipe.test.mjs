import test from "node:test";
import assert from "node:assert/strict";
import { attemptTrailDetail, openAIStreamChannel, runStreamWithKeepAlive } from "../src/relay/stream-pipe.mjs";

test("a resume exhausted on the first member keeps its identity and does not invent a second attempted upstream", async () => {
  const calls = [];
  const ends = [];
  const logs = [];
  const member = (memberId) => ({
    memberId,
    memberNoun: "pool member",
    call: async () => {
      calls.push(memberId);
      return { status: 200, stream: {} };
    },
  });
  const tracker = { recordEnd: (row) => ends.push(row) };
  await runStreamWithKeepAlive(
    { writableEnded: false, destroyed: false },
    {
      deps: {
        getKeepAliveConfig: () => ({ enabled: true, mode: "on", maxRetries: 1, backoffMs: 0 }),
      },
      tracker,
      abortController: new AbortController(),
      pipe: async () => ({ outcome: "resume", reason: "upstream_incomplete", shadow: null }),
      callUpstreams: [member("member-a"), member("member-b")],
      onCallError: (error) => { throw error; },
      onTerminalResult: () => { throw new Error("unexpected terminal result"); },
      onSettled: () => { throw new Error("unexpected settled result"); },
      exhaustedMessage: () => "upstream incomplete",
      onExhaustedLog: (message) => logs.push(message),
      sendExhausted: () => {},
      logLabel: "request",
      agentId: "zcode",
    },
  );

  assert.deepEqual(calls, ["member-a", "member-a"]);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].memberId, "member-a", "the terminal ledger belongs to the member actually tried");
  assert.doesNotMatch(ends[0].error.message, /已尝试 2 个上游/, "an untried member is not an upstream failure");
  assert.doesNotMatch(logs[0], /已尝试 2 个上游/);
});

// ── 方案甲「按请求收口」：中途行静默，结局一条总结行 ────────────────────────
// 循环只收集请求级轨迹（成员序列 + 每成员尝试次数）并经 settleCtx/retryCtx 交
// 给通道；总结行的措辞归通道描述符。以下用例分两腿：循环侧钉轨迹与静默，
// 描述符侧钉文案与面板计数口径。

function captureLogger() {
  const lines = { info: [], warn: [] };
  return {
    lines,
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
  };
}

function collapseChannel({ deps: depsOverride, ...rest } = {}) {
  return {
    deps: {
      getKeepAliveConfig: () => ({ enabled: true, maxRetries: 1, backoffMs: 0 }),
      computeRetryDelay: () => 0,
      ...depsOverride,
    },
    tracker: null,
    abortController: new AbortController(),
    onCallError: (error) => { throw error; },
    onTerminalResult: () => { throw new Error("unexpected terminal"); },
    onSettled: () => {},
    exhaustedMessage: () => "exhausted",
    sendExhausted: () => {},
    logLabel: "request",
    agentId: "zcode",
    originalBody: { model: "m" },
    ...rest,
  };
}

test("attemptTrailDetail 细节段：首试即过为空，重试/接力链按到场拼接", () => {
  assert.equal(attemptTrailDetail({ retries: 0, chain: ["a"] }), "");
  assert.equal(attemptTrailDetail({ retries: 1, chain: ["a"] }), " after 1 retry");
  assert.equal(attemptTrailDetail({ retries: 2, chain: ["a"] }), " after 2 retries");
  assert.equal(attemptTrailDetail({ retries: 0, chain: ["a", "b"] }), " after failover a→b");
  assert.equal(attemptTrailDetail({ retries: 1, chain: ["a", "b"] }), " after failover a→b, 1 retry");
});

test("收口·循环侧：重试恢复只经 settleCtx 交轨迹，中途零日志行", async () => {
  const logger = captureLogger();
  const settled = [];
  let pipeCalls = 0;
  await runStreamWithKeepAlive(
    { writableEnded: false, destroyed: false },
    collapseChannel({
      deps: { logger },
      pipe: async () => {
        pipeCalls += 1;
        return pipeCalls === 1
          ? { outcome: "retryable", reason: "empty_stream" }
          : { outcome: "ok" };
      },
      callUpstreams: [{ memberId: "solo", call: async () => ({ status: 200, stream: {} }) }],
      onSettled: (outcome, attempt, identity, settleCtx) => settled.push({ outcome, attempt, settleCtx }),
    }),
  );
  assert.equal(settled.length, 1);
  assert.equal(settled[0].outcome.outcome, "ok");
  assert.deepEqual(settled[0].settleCtx, { retries: 1, chain: ["solo"] });
  assert.deepEqual(logger.lines.warn, [], "中途的 retrying 行已移除");
  assert.deepEqual(logger.lines.info, [], "总结行的措辞归通道描述符，循环自身不打");
});

test("收口·循环侧：failover 后末位一次通过，轨迹带完整接力链", async () => {
  const logger = captureLogger();
  const settled = [];
  let pipeCalls = 0;
  const member = (memberId) => ({ memberId, call: async () => ({ status: 200, stream: {} }) });
  await runStreamWithKeepAlive(
    { writableEnded: false, destroyed: false },
    collapseChannel({
      deps: {
        logger,
        // 零重试预算：首成员空流即耗尽，直接 failover 到次成员。
        getKeepAliveConfig: () => ({ enabled: true, maxRetries: 0, backoffMs: 0 }),
      },
      pipe: async () => {
        pipeCalls += 1;
        return pipeCalls === 1
          ? { outcome: "retryable", reason: "empty_stream" }
          : { outcome: "ok" };
      },
      callUpstreams: [member("member-a"), member("member-b")],
      onSettled: (outcome, attempt, identity, settleCtx) => settled.push({ outcome, attempt, settleCtx }),
    }),
  );
  assert.equal(settled.length, 1);
  assert.deepEqual(settled[0].settleCtx, { retries: 0, chain: ["member-a", "member-b"] });
  assert.deepEqual(logger.lines.warn, [], "failing over 中途行已移除");
});

test("收口·循环侧：重试后仍是状态终局，循环打唯一一条全灭行", async () => {
  const logger = captureLogger();
  const terminals = [];
  await runStreamWithKeepAlive(
    { writableEnded: false, destroyed: false },
    collapseChannel({
      deps: { logger },
      pipe: () => { throw new Error("5xx 状态必须在进入管道前完成重试"); },
      callUpstreams: [{ memberId: "solo", call: async () => ({ status: 522, body: { error: { message: "upstream 522" } }, stream: null }) }],
      onTerminalResult: (result) => terminals.push(result.status),
    }),
  );
  assert.deepEqual(terminals, [522], "预算耗尽按末次上游状态收尾");
  assert.deepEqual(logger.lines.warn, [
    "keep-alive: request [solo · m] failed after 1 retry (last: upstream status 522)",
  ]);
  assert.deepEqual(logger.lines.info, []);
});

test("收口·循环侧：首试即过的状态终局保持零行", async () => {
  const logger = captureLogger();
  const terminals = [];
  await runStreamWithKeepAlive(
    { writableEnded: false, destroyed: false },
    collapseChannel({
      deps: { logger, getKeepAliveConfig: () => ({ enabled: true, maxRetries: 0, backoffMs: 0 }) },
      callUpstreams: [{ memberId: "solo", call: async () => ({ status: 404, body: { error: { message: "no model" } }, stream: null }) }],
      onTerminalResult: (result) => terminals.push(result.status),
    }),
  );
  assert.deepEqual(terminals, [404]);
  assert.deepEqual(logger.lines.warn, [], "无重试无 failover：没有可总结的过程");
  assert.deepEqual(logger.lines.info, []);
});

test("收口·循环侧：耗尽结局的 retryCtx 带接力链", async () => {
  const exhausted = [];
  const member = (memberId) => ({ memberId, call: async () => ({ status: 200, stream: {} }) });
  await runStreamWithKeepAlive(
    { writableEnded: false, destroyed: false },
    collapseChannel({
      deps: { getKeepAliveConfig: () => ({ enabled: true, maxRetries: 0, backoffMs: 0 }) },
      pipe: async () => ({ outcome: "retryable", reason: "empty_stream" }),
      callUpstreams: [member("member-a"), member("member-b")],
      onExhaustedLog: (message, lastOutcome, retryCtx) => exhausted.push({ message, retryCtx }),
    }),
  );
  assert.equal(exhausted.length, 1);
  assert.deepEqual(exhausted[0].retryCtx.chain, ["member-a", "member-b"]);
});

test("收口·描述符侧：onSettled 按 settleCtx 拼恢复总结行，面板恢复计数口径不变", () => {
  const logger = captureLogger();
  let recoveries = 0;
  const channel = openAIStreamChannel({
    res: { writableEnded: false, destroyed: false },
    tracker: { noteKeepAliveRecovery: () => { recoveries += 1; } },
    abortController: new AbortController(),
    deps: { logger },
    agentId: "zcode",
    originalBody: { model: "m" },
    callUpstream: async () => { throw new Error("unused"); },
  });
  channel.onSettled({ outcome: "ok" }, 2, " [solo · m]", { retries: 2, chain: ["solo"] });
  channel.onSettled({ outcome: "ok" }, 0, " [b · m]", { retries: 0, chain: ["a", "b"] });
  channel.onSettled({ outcome: "ok" }, 0, " [a · m]", { retries: 0, chain: ["a"] });
  assert.deepEqual(logger.lines.info, [
    "keep-alive: request [solo · m] recovered after 2 retries",
    "keep-alive: request [b · m] recovered after failover a→b",
  ], "重试恢复含次数、failover 恢复含接力链、首试即过零行");
  assert.equal(recoveries, 1, "只有本成员真实重试过才计恢复（attempt>0 口径不变）");
});

test("收口·描述符侧：耗尽行扩展带接力链（chain>1 才拼）", () => {
  const logger = captureLogger();
  const channel = openAIStreamChannel({
    res: { writableEnded: false, destroyed: false },
    tracker: null,
    abortController: new AbortController(),
    deps: { logger },
    agentId: "zcode",
    originalBody: { model: "m" },
    callUpstream: async () => { throw new Error("unused"); },
  });
  channel.onExhaustedLog("msg", { reason: "empty_stream" }, { attemptsUsed: 2, chain: ["a", "b", "c"] }, " [c · m]");
  channel.onExhaustedLog("msg", { reason: "empty_stream" }, { attemptsUsed: 2, chain: ["a"] }, " [a · m]");
  assert.deepEqual(logger.lines.warn, [
    "keep-alive: exhausted [c · m] (empty_stream, chain a→b→c): msg",
    "keep-alive: exhausted [a · m] (empty_stream): msg",
  ]);
});
