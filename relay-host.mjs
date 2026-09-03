// Resident relay host — the single long-lived process that keeps the ZCode
// relay up so the ZCode shortcut (even after an electron-updater reset) no
// longer has to.
//
// This is the "host" side of the architecture shift: instead of the ZCode.lnk
// → wscript → zcode-launcher → relay chain (broken every ZCode update), one
// node process binds 127.0.0.1:47821 for the whole session. ZCode becomes a
// pure consumer: it reads config.json (already pointing at 127.0.0.1:47821 with
// the persistent pi-relay-token) and just connects. The shortcut is no longer
// load-bearing for relay availability.
//
// The control panel is mounted *inside* this same server (panel.mjs), so relay
// up ⇔ panel up — no separate daemon process, no supervisor probe loop, no tray.
// Crash recovery is deliberately absent: a crash is an anomaly worth logging
// (relay-host.log) and fixing, not papering over with a 2s poll. Re-login or
// re-run restores it.

import { createWriteStream, mkdirSync, realpathSync, appendFileSync, statSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAIRelayServer, listenLoopback } from "./openai-server.mjs";
import { createProductionDeps } from "./launch.mjs";
import { loadStore, storePaths } from "./store-io.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { writeZcodeConfig } from "./zcode-launcher.mjs";
import { writeDshConfig } from "./dsh-launcher.mjs";
import { createLogger } from "./logger.mjs";
import { createPanelRouter } from "./panel.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";
import { createUsageJournal } from "./usage-journal.mjs";
import { aliasFilePath, createAliasResolver } from "./antigravity-alias.mjs";
import { writeRelayPid, clearRelayPid, getRelayPidPath } from "./relay-process-manager.mjs";
import { createStoreWatcher } from "./agent-sync.mjs";
import { spawnAgentSync } from "./agent-sync-spawn.mjs";
import { createInstanceSocketOwner } from "./instance-socket-owner.mjs";
import { ensureGitAnchor, logGitAnchorResult } from "./git-anchor.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RELAY_PORT = 47821;
const LOG_ROTATE_THRESHOLD_BYTES = 5 * 1024 * 1024;

// Startup-only log rotation: once relay-host.log crosses the threshold, rename
// it to .old (overwriting the previous .old). Never rotate while running —
// this process holds the write handle open and a Windows rename would fail.
export function rotateLogIfNeeded(logPath, thresholdBytes = LOG_ROTATE_THRESHOLD_BYTES) {
  let size;
  try {
    size = statSync(logPath).size;
  } catch {
    return false; // no log yet — nothing to rotate
  }
  if (size <= thresholdBytes) return false;
  const oldPath = `${logPath}.old`;
  try {
    if (existsSync(oldPath)) unlinkSync(oldPath);
  } catch {
    /* previous .old locked; the rename below surfaces that */
  }
  try {
    renameSync(logPath, oldPath);
    return true;
  } catch {
    return false; // rotation must never block relay startup
  }
}

// Synchronous crash trace. process.exit() truncates any pending async stream
// writes, so the fatal handlers below must land their line with appendFileSync
// BEFORE exiting — otherwise the crash trace is lost exactly when it matters.
export function appendCrashLog(logPath, label, detail) {
  try {
    appendFileSync(logPath, `[${label}] ${detail?.stack ?? detail}\n`, "utf8");
  } catch {
    /* log file may be unwritable; exiting anyway */
  }
}

function relayDataRoot(base = process.env) {
  return join(
    base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"),
    "ApiCred",
  );
}

// Mirror of zcode-launcher.mjs createOpenAIProductionDeps, but injecting the
// panel router and logger so the same server serves both relay and panel.
function createResidentDeps(options = {}) {
  const paths = options.paths ?? storePaths();
  const claudeDeps = createProductionDeps({ paths });
  const root = relayDataRoot(options.base ?? process.env);
  const logger = options.logger ?? createLogger();
  // Per-request usage journal lives next to the stability file under the
  // Anyswitch data root. A journal failure must never block relay startup — fall
  // back to no journal (the collector treats it as absent).
  let usageJournal = null;
  try {
    usageJournal = createUsageJournal({ dir: join(root, "usage") });
  } catch (error) {
    logger.warn?.(`usage journal unavailable; continuing without it: ${error.message}`);
  }
  const metricsCollector = options.metricsCollector ?? createAgentMetricsCollector({ persistRoot: root, journal: usageJournal });
  // Socket→PID 兜底归组的共享 netstat 快照（openai / gemini 两条路径共用一个
  // 实例，TTL 内整个 relay 只 spawn 一次 netstat；机制见
  // instance-socket-owner.mjs）。per-launch 路径（launch.mjs）不下发——那里
  // 保持原行为。测试可注入替身。
  const socketOwner = options.socketOwner ?? createInstanceSocketOwner();
  const token = loadOrGenerateToken(root);
  const aliasPath = aliasFilePath(root);
  const aliasResolver = options.aliasResolver ?? createAliasResolver({ filePath: aliasPath });

  return {
    token,
    loadStore: claudeDeps.loadStore,
    loadCredential: claudeDeps.loadCredential,
    buildUpstreamURLs: claudeDeps.buildUpstreamURLs,
    upstreamFetch: claudeDeps.upstreamFetch,
    recordGeneration: claudeDeps.recordGeneration,
    readGeneration: claudeDeps.readGeneration,
    getKeepAliveConfig: options.getKeepAliveConfig ?? claudeDeps.getKeepAliveConfig,
    aliasResolver,
    aliasPath,
    socketOwner,
    panelRouter: createPanelRouter({ storePaths: paths, logger, metricsCollector, aliasResolver, aliasPath }),
    metricsCollector,
    logger,
  };
}

// Tee stderr into a log file so a crash leaves a trace even though the process
// is windowless. logger's sink already writes to process.stderr; this layers a
// file capture underneath without changing that path.
function redirectStderrToFile(logPath) {
  mkdirSync(join(logPath, ".."), { recursive: true });
  const stream = createWriteStream(logPath, { flags: "a" });
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, encoding, callback) => {
    try {
      stream.write(chunk, encoding);
    } catch {
      /* file stream may be gone; never block stderr */
    }
    return origWrite(chunk, encoding, callback);
  };
  process.on("uncaughtException", (err) => {
    appendCrashLog(logPath, "uncaughtException", err?.stack ?? err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    // Log-only, deliberately: a stray promise rejection must not take down
    // the resident relay and reset every connected agent's API session (the
    // ESC-abort "ReadableStream is locked" rejection did exactly that).
    // Synchronous faults above still exit.
    appendCrashLog(logPath, "unhandledRejection", reason?.stack ?? reason);
  });
  return stream;
}

export async function startResidentRelay(options = {}) {
  const logPath = join(__dirname, "logs", "relay-host.log");
  rotateLogIfNeeded(logPath);
  redirectStderrToFile(logPath);
  const logger = createLogger({ sink: (line) => process.stderr.write(line) });
  try {
    logGitAnchorResult(logger, ensureGitAnchor(__dirname));
  } catch {
    /* never block relay start */
  }

  const deps = createResidentDeps({ ...options, logger });

  // Preflight: refuse to listen if the store is unusable.
  const probe = deps.loadStore();
  if (!probe.ok) {
    logger.error("Anyswitch store not usable; refusing to start resident relay");
    throw new Error("the Anyswitch global store is not usable; refusing to start the resident relay");
  }

  const server = createOpenAIRelayServer(deps);
  const startTime = Date.now();
  const { port, reused, close } = await listenLoopback(server, RELAY_PORT);

  if (reused) {
    // Port 47821 already answers the relay probe — another relay (likely a
    // per-launch zcode-launcher instance, or a prior resident host) is already
    // serving. Rather than fight for the port or idle pointlessly, exit 0: the
    // existing instance owns 47821, and the autostart entry will simply succeed
    // no-op next login if the resident host is already up.
    logger.warn(`port ${RELAY_PORT} already has a relay serving; this resident host will not double-bind. Exiting 0.`);
    return { port, token: deps.token, close, reused: true };
  }
  logger.info(`resident relay listening on 127.0.0.1:${port}`);

  // Register our PID so the decoupled panel (panel-host, 47820) and
  // relay-process-manager can target THIS process for stop/restart — never a
  // global node.exe kill. Cleared on every shutdown path below.
  const root = relayDataRoot(options.base ?? process.env);
  const pidPath = getRelayPidPath(root);
  writeRelayPid(process.pid, pidPath);
  const clearPid = () => clearRelayPid(pidPath);

  // Initial sync of all agent configs (zcode, dsh, pi, kimi, reasonix).
  // Spawned as a child process so the merge logic always loads from disk —
  // catalog-writer fixes take effect on the next sync without restarting
  // this resident host.
  try {
    const syncResult = await spawnAgentSync({ port, logger });
    if (!syncResult.ok) {
      logger.error(`initial agent config sync failed: ${syncResult.error ?? `runner exit ${syncResult.code}`}`);
    }
  } catch (err) {
    logger.error(`initial agent config sync failed: ${err.message}`);
  }

  // Real-time store.json change watcher for downstream coding agents.
  const paths = options.paths ?? storePaths(root);
  const storeWatcher = createStoreWatcher({
    storeFile: paths.storeFile,
    logger,
    onStoreChange: async () => {
      logger.info("store.json changed; re-syncing agent configurations");
      const syncResult = await spawnAgentSync({ port, logger });
      if (!syncResult.ok) {
        logger.error(`agent config sync failed: ${syncResult.error ?? `runner exit ${syncResult.code}`}`);
      }
    },
  });

  logger.info(`panel at http://127.0.0.1:${port}/panel (relay-served view; control panel lives on 47820)`);

  // Graceful shutdown on Ctrl-C / service stop / supervisor kill. Always clear
  // the pid file so relay-process-manager sees "stopped" and can start cleanly.
  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    storeWatcher.close();
    clearPid();
    try {
      await close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", () => clearPid());

  return { port, token: deps.token, close, logger, reused };
}

function isEntryModule(argv1, metaUrl) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  const norm = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  try {
    return norm(fileURLToPath(metaUrl)) === norm(argv1);
  } catch {
    return false;
  }
}

if (isEntryModule(process.argv[1], import.meta.url)) {
  startResidentRelay().then(
    () => {
      // keep alive; the server's listen() holds the event loop open
    },
    (error) => {
      process.stderr.write(`relay-host failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
