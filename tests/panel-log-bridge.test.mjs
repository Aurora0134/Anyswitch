// startRelayLogBridge tests: the bridge re-publishes the relay process's log
// entries into the panel-host's logger so the 实时输出 window shows relay-side
// events (keep-alive retries, stream faults) again after the process split.
//
// The bridge hardcodes its target — http://127.0.0.1:47821/api/internal/logs
// (?live=1 on the first connect, full replay + watermark/dedup on reconnects)
// with a Bearer token read from the data root — so these tests fake fetch at
// the global boundary: the fake records the outgoing request (pinning the URL,
// live=1 and token contract) and answers with hand-built SSE frames. That
// covers the bridge-side logic: the request contract, SSE frame parsing, level
// handling, the frame ts pass-through, the legacy "[level] " prefix strip,
// retry-on-unreachable, reconnect replay dedup, pre-birth stock filtering
// via the birth watermark and stop() teardown. The relay-side endpoint itself
// (token auth, history + live streaming, live=1 skip-replay) is exercised
// against the real server in openai-server.test.mjs ("streams relay log
// entries over /api/internal/logs with token auth" and "skips history replay
// for /api/internal/logs?live=1").

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createLogger } from "../src/shared/logger.mjs";
import { loadOrGenerateToken } from "../src/launchers/pi-relay-token.mjs";
import { startRelayLogBridge } from "../src/panel/panel.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

// Yield past every pending microtask. The bridge's failure path (fetch
// rejection → catch → scheduleRetry) settles within one microtask; setImmediate
// stays real under mocked setTimeout, so this drains it without firing timers.
async function flush() {
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("relay log bridge", () => {
  it("re-publishes relay SSE log entries through the panel logger and stop() aborts the subscription", async () => {
    // Frames carry the level in the field only — the shape the relay emits since
    // the level contract landed (the legacy "[warn] " prefix is covered by its
    // own test below).
    // ts 取用例时刻之后的毫秒数：出生水位线滤的是首连成功一刻之前的行，本用例的
    // 帧全部当作首连后的行（出生前存量的滤除由水位线用例单独钉）。
    const retryTs = Date.now() + 1000;
    const recoveredTs = Date.now() + 2000;
    const liveTs = Date.now() + 3000;
    const frames = [
      `data: ${JSON.stringify({ ts: retryTs, level: "warn", message: "keep-alive: retrying request" })}\n\n`,
      `data: ${JSON.stringify({ ts: recoveredTs, level: "info", message: "keep-alive: recovered" })}\n\n`,
    ];
    const liveFrame = `data: ${JSON.stringify({ ts: liveTs, level: "error", message: "live fault" })}\n\n`;
    const encoder = new TextEncoder();
    const requests = [];
    let aborted = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      requests.push({ url, init });
      const stream = new ReadableStream({
        start(controller) {
          // History entries arrive immediately; the live entry follows shortly.
          controller.enqueue(encoder.encode(frames[0]));
          controller.enqueue(encoder.encode(frames[1]));
          let liveSent = false;
          const iv = setInterval(() => {
            if (!liveSent) {
              liveSent = true;
              controller.enqueue(encoder.encode(liveFrame));
              return;
            }
            // The stream itself stays open until stop() aborts it, but this
            // timer must die on its own: a broken stop() has to fail the run,
            // not hang the process.
            clearInterval(iv);
          }, 20);
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            clearInterval(iv);
            controller.close();
          });
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    };

    const panelLogger = createLogger({ sink: () => {} });
    const received = [];
    const unsubscribe = panelLogger.subscribe((entry) => received.push(entry));

    const root = mkTestDir("anyswitch-bridge-");
    let token;
    try {
      // Token file the bridge reads; the fake records the request, so the auth
      // header can be checked against this exact value.
      token = loadOrGenerateToken(root);
      const stop = startRelayLogBridge(panelLogger, root);

      // Wait for the bridge to consume the frames (poll with timeout).
      const deadline = Date.now() + 3000;
      while (received.length < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      stop();
      unsubscribe();

      assert.equal(requests.length, 1, "the bridge opens exactly one SSE subscription");
      assert.equal(
        requests[0].url,
        "http://127.0.0.1:47821/api/internal/logs?live=1",
        "the bridge subscribes to the relay's live log endpoint",
      );
      assert.equal(
        new Headers(requests[0].init.headers).get("authorization"),
        `Bearer ${token}`,
        "the bridge authenticates with the data root's relay token",
      );
      assert.ok(requests[0].init.signal instanceof AbortSignal, "the subscription is abortable");
      assert.ok(received.some((e) => e.message.includes("keep-alive: retrying request")), "relay entries re-publish through the panel logger");
      assert.ok(received.some((e) => e.message.includes("keep-alive: recovered")));
      assert.ok(received.some((e) => e.message.includes("live fault")), "live frames stream through");
      assert.equal(aborted, true, "stop() aborts the in-flight subscription");
      // 时间戳端到端：桥接透传帧内 ts，条目带真实发生时刻，不取桥接时刻。
      assert.equal(received.find((e) => e.message === "keep-alive: retrying request").ts, retryTs,
        "a bridged entry carries the frame's ts, not the bridging moment");
      assert.equal(received.find((e) => e.message === "live fault").ts, liveTs,
        "a live frame's ts passes through too");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // 升级窗口：面板可能先重启，对面还是把级别写进文本的旧中继。旧帧自带 "[level] "
  // 前缀，原样透传会让窗口里出现两个级别标签，所以桥接处剥掉一个前导级别标记。
  // 新中继不产生这个前缀，这一条只守旧格式。
  it("strips a leading level tag from a pre-0.6.x relay entry", async () => {
    // ts 取用例时刻之后的值：出生水位线会滤掉首连成功一刻之前的行。
    const frameTs = Date.now() + 1000;
    const frames = [
      `data: ${JSON.stringify({ ts: frameTs, level: "warn", message: "[warn] legacy prefixed entry" })}\n\n`,
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(frames[0]));
        setTimeout(() => controller.close(), 40);
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(stream, { status: 200 });

    const panelLogger = createLogger({ sink: () => {} });
    const received = [];
    const unsubscribe = panelLogger.subscribe((entry) => received.push(entry));

    const root = mkTestDir("anyswitch-bridge-legacy-");
    try {
      loadOrGenerateToken(root);
      const stop = startRelayLogBridge(panelLogger, root);
      const deadline = Date.now() + 3000;
      while (received.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      stop();
      unsubscribe();

      assert.equal(received.length, 1, "the legacy frame still bridges");
      assert.equal(received[0].level, "warn", "the level comes from the field, never the text");
      assert.equal(received[0].message, "legacy prefixed entry", "the stale level tag is stripped once");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A3：首连 ?live=1（不把中继侧存量倒灌进新起的面板总线）；重连改要全量历史
  // 并按 (ts, level, message) 去重——中继重启窗口里的启动段只存在于那次历史里，
  // 而没重启的纯断线重连，重放帧全是桥过的旧条目，必须整条滤掉。
  it("reconnects ask for full history and dedup it: the restart-gap startup segment lands, replayed entries do not re-bridge", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const encoder = new TextEncoder();
    const requests = [];
    // ts 取用例时刻之后的值：出生水位线滤的是首连成功一刻之前的行，本用例的帧
    // 全部当作水位线之后的行（出生前存量的滤除由水位线用例单独钉）。
    const oldTs = Date.now() + 1000;
    const gapTs = Date.now() + 2000;
    let attempt = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      attempt += 1;
      requests.push(url);
      if (attempt === 1) {
        // 首连：一条实时条目后流立即收尾（模拟中继重启把连接掐断）。close 必须
        // 同步排进 start——本用例的 setTimeout 已被 mock，用它关流永远不会触发。
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ts: oldTs, level: "info", message: "old line" })}\n\n`));
            controller.close();
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      }
      // 重连：全量重放（含已桥过的 old line）＋重启窗口里才产生的新行；此后保持
      // 挂起，直到 stop() 中止。
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ts: oldTs, level: "info", message: "old line" })}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ts: gapTs, level: "info", message: "relay listening again" })}\n\n`));
          init?.signal?.addEventListener("abort", () => {
            try { controller.close(); } catch { /* already closed */ }
          });
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    };

    const panelLogger = createLogger({ sink: () => {} });
    const received = [];
    const unsubscribe = panelLogger.subscribe((entry) => received.push(entry.message));

    const root = mkTestDir("anyswitch-bridge-reconnect-");
    try {
      loadOrGenerateToken(root);
      const stop = startRelayLogBridge(panelLogger, root);
      await flush(); // 首连取流、读到 done、排上 5s 重连计时器
      assert.deepEqual(received, ["old line"], "首连只桥到实时条目");
      t.mock.timers.tick(5000);
      await flush(); // 重连发生、重放帧走完解析与去重
      stop();
      unsubscribe();

      assert.equal(requests.length, 2, "首连一次、重连一次");
      assert.equal(requests[0], "http://127.0.0.1:47821/api/internal/logs?live=1", "首连仍不拿历史");
      assert.equal(requests[1], "http://127.0.0.1:47821/api/internal/logs", "重连改要全量历史，重启窗口的启动段才有处可补");
      assert.deepEqual(received, ["old line", "relay listening again"],
        "重放里已桥过的条目被去重簿滤掉，只有间隙新行进总线");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // 出世水位线：面板出生前就躺在中继环里的存量从未进过判重簿，重连全量重放时
  // 与断窗新行分不开，会整批复活——面板「清空」后的下一次重连最多涌回 500 条
  // 旧账。本用例钉水位线语义：首连 ?live=1 只桥实时行；重连重放三帧里，已桥行
  // 由簿滤、出生前行由水位线滤，只有断窗新行进总线。
  it("filters pre-birth stock through the birth watermark: a reconnect replay revives nothing from before the panel's birth", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const encoder = new TextEncoder();
    const requests = [];
    // 首连实时行与断窗新行的 ts 取用例时刻之后的值，保证晚于首连成功那一刻的
    // 水位线；出生前行的 ts 用极小值，任何真实水位线都晚于它。
    const liveTs = Date.now() + 1000;
    const gapTs = Date.now() + 2000;
    let attempt = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      attempt += 1;
      requests.push(url);
      if (attempt === 1) {
        // 首连：一条实时行后流收尾（模拟中继重启把连接掐断）。close 必须同步排
        // 进 start——本用例的 setTimeout 已被 mock，用它关流永远不会触发。
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ts: liveTs, level: "info", message: "live line during first connect" })}\n\n`));
            controller.close();
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      }
      // 重连：全量重放三帧——已桥行（判重簿滤）、出生前行（水位线滤）、断窗新行
      // （照常补回）；此后保持挂起，直到 stop() 中止。
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ts: liveTs, level: "info", message: "live line during first connect" })}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ts: 1, level: "info", message: "stock line logged before the panel was born" })}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ts: gapTs, level: "info", message: "gap line during the disconnect" })}\n\n`));
          init?.signal?.addEventListener("abort", () => {
            try { controller.close(); } catch { /* already closed */ }
          });
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    };

    const panelLogger = createLogger({ sink: () => {} });
    const received = [];
    const unsubscribe = panelLogger.subscribe((entry) => received.push(entry.message));

    const root = mkTestDir("anyswitch-bridge-watermark-");
    try {
      loadOrGenerateToken(root);
      const stop = startRelayLogBridge(panelLogger, root);
      await flush(); // 首连取流、桥到实时行、读到 done、排上 5s 重连计时器
      assert.deepEqual(received, ["live line during first connect"], "首连只桥实时行");
      t.mock.timers.tick(5000);
      await flush(); // 重连发生、三帧走完解析、水位线与判重簿
      stop();
      unsubscribe();

      assert.equal(requests.length, 2, "首连一次、重连一次");
      assert.equal(requests[0], "http://127.0.0.1:47821/api/internal/logs?live=1", "首连带 live=1，不拿历史");
      assert.equal(requests[1], "http://127.0.0.1:47821/api/internal/logs", "重连不带 live=1，改要全量历史");
      assert.deepEqual(received, ["live line during first connect", "gap line during the disconnect"],
        "重放里已桥行被簿滤、出生前行被水位线滤，只有断窗新行进总线");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("survives the relay being unreachable: retries on its timer and stop() ends the retries", async (t) => {
    // The retry interval is 5s of wall clock — too slow to wait out in a unit
    // test, so the retry timer runs under mocked timers. That actually
    // exercises "keeps retrying" and "stop() ends the retries" instead of only
    // the first connection attempt; an unhandled failure on the way still
    // fails the test, so "without throwing" stays covered too.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      throw new Error("ECONNREFUSED");
    };
    const panelLogger = createLogger({ sink: () => {} });
    const root = mkTestDir("anyswitch-bridge-down-");
    try {
      loadOrGenerateToken(root);
      const stop = startRelayLogBridge(panelLogger, root);
      assert.equal(attempts, 1, "the bridge attempts a connection immediately");
      await flush(); // let the connection failure reach the bridge's retry scheduler
      t.mock.timers.tick(5000); // one retry interval elapses
      assert.ok(attempts >= 2, "the bridge keeps retrying while the relay is unreachable");
      stop();
      const atStop = attempts;
      await flush();
      t.mock.timers.runAll(); // no retry may survive stop(), however long the clock runs
      assert.equal(attempts, atStop, "stop() ends the retry loop");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
