// panel-host unit tests: the terminal-backend discovery leg. Since the relay
// owns the terminal host process, the panel can only discover it — a missing
// backend is logged and swallowed so panel startup is never blocked.

import test from "node:test";
import assert from "node:assert/strict";
import { discoverTerminalBackend } from "./panel-host.mjs";

function recordingLogger() {
  const warnings = [];
  return { warnings, warn: (line) => warnings.push(String(line)) };
}

test("discoverTerminalBackend passes through a serving backend without a warning", async () => {
  const logger = recordingLogger();
  const serving = { ok: true, reused: true, pid: 5150, port: 47823 };
  const result = await discoverTerminalBackend("root-dir", {
    ensureFn: async () => serving,
    logger,
  });

  assert.equal(result, serving);
  assert.deepEqual(logger.warnings, []);
});

test("discoverTerminalBackend treats a missing backend as an empty state, not an error", async () => {
  const logger = recordingLogger();
  let receivedRoot = null;
  const result = await discoverTerminalBackend("root-dir", {
    ensureFn: async (root) => {
      receivedRoot = root;
      return { ok: false, reused: false, pid: null, port: 47823, reason: "terminal host is not running" };
    },
    logger,
  });

  assert.equal(receivedRoot, "root-dir");
  assert.equal(result.ok, false);
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /until the relay is running/, "the log explains who starts the terminal host");
});

test("discoverTerminalBackend swallows a throwing probe so panel startup never blocks", async () => {
  const logger = recordingLogger();
  const result = await discoverTerminalBackend("root-dir", {
    ensureFn: async () => {
      throw new Error("token store locked");
    },
    logger,
  });

  assert.equal(result.ok, false);
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /token store locked/);
});
