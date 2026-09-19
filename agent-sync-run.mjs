// Standalone agent-config sync runner.
//
// Spawned as a short-lived child by the relay-host's store watcher and the
// panel's "同步到端点" route. Running the sync in a fresh process loads the
// merge modules from disk on every invocation, so catalog-writer code changes
// propagate on the very next sync without restarting the resident relay or
// panel — the resident processes spawn this script, they never run the merge
// logic in-memory again.
//
// Exit code 0 = the sync ran (every endpoint synced, or only some of them);
// non-zero = the store was unreadable or the runner itself crashed. Stdout
// carries one human-readable line per outcome for the spawner's logger plus a
// single machine-readable summary line (see SYNC_RESULT_PREFIX) the panel
// parses — a lone endpoint failure must not sink the whole run.

import { join } from "node:path";
import { syncAllAgentConfigs, buildSyncSummary, formatSyncSummaryLine } from "./agent-sync.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";

const DEFAULT_PORT = 47821;

function relayDataRoot(base = process.env) {
  return join(
    base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"),
    "Anyswitch",
  );
}

function parsePort(argv) {
  const index = argv.indexOf("--port");
  if (index === -1) return DEFAULT_PORT;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`invalid --port value "${argv[index + 1]}"`);
  }
  return value;
}

const logger = {
  info: (message) => process.stdout.write(`[agent-sync] ${message}\n`),
  warn: (message) => process.stdout.write(`[agent-sync] WARN ${message}\n`),
  error: (message) => process.stderr.write(`[agent-sync] ERROR ${message}\n`),
};

async function main() {
  const port = parsePort(process.argv.slice(2));
  const root = relayDataRoot();
  const token = loadOrGenerateToken(root);
  const result = await syncAllAgentConfigs({ port, token, root, logger });
  const summary = buildSyncSummary(result);
  // 机器可读摘要原样落 stdout（不加日志前缀，行首就是约定的标记）：面板靠它
  // 拿到每个端点的成败，而不是只看退出码。这行的形状固定为
  // __ANYSWITCH_SYNC_RESULT__{"ok":true,"synced":[...],"failed":[...],"codexCatalog":{"state":"written","entries":N}}
  // ——前缀与字段的组装在 agent-sync.mjs 的 SYNC_RESULT_PREFIX / buildSyncSummary 里，
  // 面板用 parseSyncSummaryLine 反向解析，两边共用同一份定义。
  process.stdout.write(`${formatSyncSummaryLine(summary)}\n`);
  if (!result.ok) {
    logger.error(`sync failed: ${result.reason ?? "unknown"}`);
    process.exit(1);
  }
  if (summary.failed.length > 0) {
    // 个别端点写不进去：其余端点已经同步好，整体仍算跑完，退出码留给真失败。
    logger.warn(`sync finished with failures: ${summary.failed.join(", ")}`);
    process.exit(0);
  }
  logger.info("all agent configurations synced");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[agent-sync] ERROR ${err.message}\n`);
  process.exit(1);
});
