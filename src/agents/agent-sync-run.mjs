// Standalone agent-config sync runner.
//
// Spawned as a short-lived child by the relay-host's store watcher and the
// panel's "同步到端点" route. Running the sync in a fresh process loads the
// merge modules from disk on every invocation, so catalog-writer code changes
// propagate on the very next sync without restarting the resident relay or
// panel — the resident processes spawn this script, they never run the merge
// logic in-memory again.
//
// Exit code 0 means the runner finished evaluating the endpoints, whether or
// not their writes succeeded. A nonzero exit means the runner could not finish
// (for example, the store was unreadable). The parent uses the structured
// summary to log the batch outcome separately from per-endpoint diagnostics.

import { join } from "node:path";
import { syncAllAgentConfigs, buildSyncSummary, formatSyncSummaryLine } from "./agent-sync.mjs";
import { loadOrGenerateToken } from "../launchers/pi-relay-token.mjs";

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

// 级别由「走哪条流」承载，不写进文本：stdout 是正常输出，stderr 是异常。父进程
// （agent-sync-spawn.mjs）按流定级。文本里再出现 WARN/ERROR 就是第二份级别，且
// 可能与流自相矛盾——曾经因此落盘成 "[info] [agent-sync] WARN sync finished…"，
// 级别字段于是不再可信。
const logger = {
  info: (message) => process.stdout.write(`[agent-sync] ${message}\n`),
  warn: (message) => process.stderr.write(`[agent-sync] ${message}\n`),
  error: (message) => process.stderr.write(`[agent-sync] ${message}\n`),
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
  // Endpoint diagnostics and the count of rewritten configs are emitted by
  // syncAllAgentConfigs. The parent owns the batch failure summary.
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[agent-sync] ${err.message}\n`);
  process.exit(1);
});
