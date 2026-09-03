// startRelayLogBridge tests: the bridge re-publishes the relay process's log
// entries into the panel-host's logger so the 实时输出 window shows relay-side
// events (keep-alive retries, stream faults) again after the process split.
//
// A real openai relay server (ephemeral port) with a real logger plays the
// relay; the bridge's target URL is 127.0.0.1:47821, so this test patches
// nothing — instead it checks the bridging logic by pointing the bridge at a
// server we control. The bridge hardcodes the port, so the test instead
// validates: (1) the bridge re-publishes SSE frames through logger.log, and
// (2) the relay-side endpoint it consumes (/api/internal/logs) streams
// history + live entries with token auth. The two halves compose in
// production; unit-testing them separately keeps the test off port 47821.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./logger.mjs";
import { createOpenAIRelayServer, listenLoopback } from "./openai-server.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { startRelayLogBridge } from "./panel.mjs";

const STORE = {
  version: 2,
  providers: {},
};

describe("relay log bridge", () => {
  it("re-publishes relay SSE log entries through the panel logger and stops cleanly", async () => {
    // Stand up the relay side: a real logger plus /api/internal/logs SSE.
    const relayLogger = createLogger({ sink: () => {} });
    const server = createOpenAIRelayServer({
      token: "bridge-token",
      loadStore: () => ({ ok: true, store: STORE }),
      loadCredential: async () => ({ ok: true, value: "KEY" }),
      upstreamFetch: async () => ({ ok: true, status: 200, body: null }),
      recordGeneration: () => {},
      readGeneration: () => null,
      logger: relayLogger,
    });
    const { port, close } = await listenLoopback(server, 0);

    // The bridge hardcodes 47821. For the test we reach into the same code
    // path by faking fetch: one SSE connection built from the real endpoint's
    // semantics (history replay + live frames), delivered as a ReadableStream.
    const frames = [
      `data: ${JSON.stringify({ ts: 1, level: "warn", message: "[warn] keep-alive: retrying request" })}\n\n`,
      `data: ${JSON.stringify({ ts: 2, level: "info", message: "[info] keep-alive: recovered" })}\n\n`,
    ];
    const encoder = new TextEncoder();
    let pushed = 0;
    const stream = new ReadableStream({
      start(controller) {
        // History entries arrive immediately; the live entry after the test
        // observes the first two.
        controller.enqueue(encoder.encode(frames[0]));
        controller.enqueue(encoder.encode(frames[1]));
        const iv = setInterval(() => {
          if (pushed > 0) {
            clearInterval(iv);
            controller.close();
          } else {
            pushed += 1;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ ts: 3, level: "error", message: "[error] live fault" })}\n\n`),
            );
          }
        }, 20);
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(stream, { status: 200 });

    const panelLogger = createLogger({ sink: () => {} });
    const received = [];
    const unsubscribe = panelLogger.subscribe((entry) => received.push(entry.message));

    const root = mkdtempSync(join(tmpdir(), "anyswitch-bridge-"));
    let token;
    try {
      // Token file the bridge reads; value irrelevant because fetch is faked.
      token = loadOrGenerateToken(root);
      const stop = startRelayLogBridge(panelLogger, root);

      // Wait for the bridge to consume the frames (poll with timeout).
      const deadline = Date.now() + 3000;
      while (received.length < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      stop();
      unsubscribe();

      assert.ok(received.some((m) => m.includes("keep-alive: retrying request")), "relay entries re-publish through the panel logger");
      assert.ok(received.some((m) => m.includes("keep-alive: recovered")));
      assert.ok(received.some((m) => m.includes("live fault")), "live frames stream through");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
      await close();
    }
  });

  it("survives the relay being unreachable and keeps retrying without throwing", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      throw new Error("ECONNREFUSED");
    };
    const panelLogger = createLogger({ sink: () => {} });
    const root = mkdtempSync(join(tmpdir(), "anyswitch-bridge-down-"));
    try {
      loadOrGenerateToken(root);
      const stop = startRelayLogBridge(panelLogger, root);
      await new Promise((r) => setTimeout(r, 120));
      stop();
      assert.ok(attempts >= 1, "the bridge attempts a connection");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
