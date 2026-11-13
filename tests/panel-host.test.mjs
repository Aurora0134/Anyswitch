// panel-host unit tests: the terminal-backend discovery leg. Since the relay
// owns the terminal host process, the panel can only discover it — a missing
// backend is logged and swallowed so panel startup is never blocked.

import test from "node:test";
import assert from "node:assert/strict";
import { createPanelServer, discoverTerminalBackend } from "../src/panel/panel-host.mjs";

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

// 接线兑底用例：createPanelServer 必须在启动时调 prewarmPromptsBackfill——
// 注入文件唯一写入触发面原本是预设变更，漏掉这行接线则启动回填失效（面板
// 重启后注入文件仍不落盘）。environmentService/promptsService 都注入 mock，
// 预热回填不触真检测、不写真家目录；其余预热腿（watchdog/会话扫描）是
// createPanelServer 既有行为，与本断言无关。
test("createPanelServer 启动即预热注入回填（漏接线则 resync 计数为 0）", async () => {
  const env = { getState: async () => ({ clients: [{ id: "claude", installations: [{ status: "found" }] }] }) };
  let resyncs = 0;
  const promptsService = { resync: () => { resyncs += 1; } };
  createPanelServer({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    environmentService: env,
    promptsService,
  });
  const deadline = Date.now() + 100;
  while (resyncs === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(resyncs, 1, "启动即一次注入回填");
});
