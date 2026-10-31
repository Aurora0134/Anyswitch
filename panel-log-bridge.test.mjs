// startRelayLogBridge tests: the bridge re-publishes the relay process's log
// entries into the panel-host's logger so the 实时输出 window shows relay-side
// events (keep-alive retries, stream faults) again after the process split.
//
// The bridge hardcodes its target — http://127.0.0.1:47821/api/internal/logs?live=1
// with a Bearer token read from the data root — so these tests fake fetch at
// the global boundary: the fake records the outgoing request (pinning the URL,
// live=1 and token contract) and answers with hand-built SSE frames. That
// covers the bridge-side logic: the request contract, SSE frame parsing, level
// handling, the legacy "[level] " prefix strip, retry-on-unreachable and
// stop() teardown. The relay-side endpoint itself (token auth, history + live
// streaming, live=1 skip-replay) is exercised against the real server in
// openai-server.test.mjs ("streams relay log entries over /api/internal/logs
// with token auth" and "skips history replay for /api/internal/logs?live=1").

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createLogger } from "./logger.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { startRelayLogBridge } from "./panel.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

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
    const frames = [
      `data: ${JSON.stringify({ ts: 1, level: "warn", message: "keep-alive: retrying request" })}\n\n`,
      `data: ${JSON.stringify({ ts: 2, level: "info", message: "keep-alive: recovered" })}\n\n`,
    ];
    const liveFrame = `data: ${JSON.stringify({ ts: 3, level: "error", message: "live fault" })}\n\n`;
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
    const unsubscribe = panelLogger.subscribe((entry) => received.push(entry.message));

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
      assert.ok(received.some((m) => m.includes("keep-alive: retrying request")), "relay entries re-publish through the panel logger");
      assert.ok(received.some((m) => m.includes("keep-alive: recovered")));
      assert.ok(received.some((m) => m.includes("live fault")), "live frames stream through");
      assert.equal(aborted, true, "stop() aborts the in-flight subscription");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // 升级窗口：面板可能先重启，对面还是把级别写进文本的旧中继。旧帧自带 "[level] "
  // 前缀，原样透传会让窗口里出现两个级别标签，所以桥接处剥掉一个前导级别标记。
  // 新中继不产生这个前缀，这一条只守旧格式。
  it("strips a leading level tag from a pre-0.6.x relay entry", async () => {
    const frames = [
      `data: ${JSON.stringify({ ts: 1, level: "warn", message: "[warn] legacy prefixed entry" })}\n\n`,
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
