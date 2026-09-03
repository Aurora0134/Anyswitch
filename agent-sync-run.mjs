// Standalone agent-config sync runner.
//
// Spawned as a short-lived child by the relay-host's store watcher and the
// panel's "同步到端点" route. Running the sync in a fresh process loads the
// merge modules from disk on every invocation, so catalog-writer code changes
// propagate on the very next sync without restarting the resident relay or
// panel — the resident processes spawn this script, they never run the merge
// logic in-memory again.
//
// Exit code 0 = every agent config synced (or was already up to date);
// non-zero = store unreadable or at least one agent failed. Stdout carries
// one human-readable line per outcome for the spawner's logger.

import { join } from "node:path";
import { syncAllAgentConfigs } from "./agent-sync.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";

const DEFAULT_PORT = 47821;

function relayDataRoot(base = process.env) {
  return join(
    base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"),
    "ApiCred",
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
  if (!result.ok) {
    logger.error(`sync failed: ${result.reason ?? "unknown"}`);
    process.exit(1);
  }
  const failed = Object.entries(result.results).filter(([, r]) => r && r.ok === false);
  if (failed.length > 0) {
    logger.error(`sync finished with failures: ${failed.map(([name]) => name).join(", ")}`);
    process.exit(1);
  }
  logger.info("all agent configurations synced");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[agent-sync] ERROR ${err.message}\n`);
  process.exit(1);
});
