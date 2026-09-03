// Standalone resident control panel host (127.0.0.1:47820).
//
// This is the "control plane" half of the decoupled architecture. It is a
// SEPARATE long-lived Node process from the relay (relay-host.mjs, 47821), so
// that the web control panel, provider management, telemetry stream, and the
// relay start/stop/restart controls remain 100% available regardless of
// whether the relay is running, paused, or stopped. Stopping the relay from
// here cannot kill this panel — that is the whole point of the split.
//
// Live relay metrics are PULLED cross-process: handleAgents in panel.mjs fetches
// http://127.0.0.1:47821/api/internal/agents (Bearer pi-relay-token); if the
// relay is down it falls back to this process's own (mostly empty) collector,
// so the UI never errors and recovers the moment the relay is back.
//
// Relay lifecycle (start/stop/restart) is delegated to relay-process-manager,
// which spawns/kills relay-host.mjs by a single recorded PID.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { createPanelRouter, startRelayLogBridge } from "./panel.mjs";
import { createLogger } from "./logger.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";
import { storePaths } from "./store-io.mjs";
import { loadSettings, defaultSettingsPath } from "./relay-settings.mjs";
import { isWatchdogAutostartEnabled, enableWatchdogAutostart } from "./autostart.mjs";
import { spawnWatchdog, probeWatchdog } from "./agent-watchdog.mjs";
import { aliasFilePath, createAliasResolver } from "./antigravity-alias.mjs";
import { dirname } from "node:path";
import { ensureGitAnchor, logGitAnchorResult } from "./git-anchor.mjs";

const __filename = fileURLToPath(import.meta.url);
export const PANEL_PORT = 47820;

function isLoopback(remoteAddress) {
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

export function createPanelServer(options = {}) {
  const paths = options.paths ?? storePaths();
  const logger = options.logger ?? createLogger({ sink: (line) => process.stderr.write(line) });
  const metricsCollector = options.metricsCollector ?? createAgentMetricsCollector();
  const startTime = options.startTime ?? Date.now();
  // The panel host owns its own resolver over the shared antigravity.json so
  // the settings page works when opened from THIS port (47820, the desktop
  // shortcut target): reads show the on-disk bindings and saves persist to
  // disk. Cross-process liveness comes from the resolver's mtime-aware file
  // layer — the relay (47821) picks the new bindings up on its next request
  // without a restart.
  const aliasPath = aliasFilePath(paths.root);
  const aliasResolver = options.aliasResolver ?? createAliasResolver({ filePath: aliasPath });
  const router = createPanelRouter({ storePaths: paths, logger, metricsCollector, aliasResolver, aliasPath, startTime });
  // Warm the watchdog drift snapshot at startup: the panel frontend fetches
  // /api/settings on every page load to hydrate the 抗截断 toggle, and an
  // un-primed first GET would otherwise pay the ~1s probe round inline.
  // Fire-and-forget — the first GET cold-waits only if it beats the prewarm.
  router.prewarmWatchdogProbes();
  const server = createServer(async (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "permission_error", message: "panel only serves loopback clients" }));
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(302, { Location: "/panel" });
      res.end();
      return;
    }
    if (url.pathname.startsWith("/panel")) return router.handle(req, res);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return { server, logger, metricsCollector, router };
}

export function listenLoopbackPanel(server, port = PANEL_PORT) {
  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") resolve({ port, reused: true, close: async () => {} });
      else reject(err);
    });
    server.listen(port, "127.0.0.1", () => {
      resolve({ port, reused: false, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

export async function startPanelHost(options = {}) {
  const { server, logger, metricsCollector } = createPanelServer(options);
  try {
    logGitAnchorResult(logger, ensureGitAnchor(dirname(__filename)));
  } catch {
    /* never block panel start */
  }
  const paths = options.paths ?? storePaths();
  const preferredPort = options.port ?? PANEL_PORT;
  const { port, reused, close } = await listenLoopbackPanel(server, preferredPort);
  if (reused) {
    logger.warn(`panel port ${port} already in use; reusing existing panel`);
    return { port, close, reused: true };
  }
  logger.info(`Anyswitch control panel running at http://127.0.0.1:${port}/panel`);

  // Relay log bridge: re-publish the relay process's log entries (keep-alive
  // retries, stream faults) into this logger so the panel's 实时输出 window
  // shows them again. Panel-host only — see startRelayLogBridge's comment
  // for why the relay-host must never start one.
  const stopLogBridge = startRelayLogBridge(logger, paths.root);

  // One-time migration: followAgent used to be hosted in THIS process, so
  // older machines have settings.json followAgent=true but no watchdog
  // registry entry. Backfill the HKCU Run key + start the watchdog now. This
  // is a bootstrap fix-up only — afterwards the watchdog lives or dies with
  // its own registry entry, never with the panel host.
  try {
    const followAgent = loadSettings(defaultSettingsPath())?.settings?.followAgent === true;
    if (followAgent && !(await isWatchdogAutostartEnabled())) {
      const reg = await enableWatchdogAutostart();
      if (reg.ok && !(await probeWatchdog())) {
        await spawnWatchdog();
        logger.info("followAgent migration: watchdog registry entry backfilled and watchdog started");
      }
    }
  } catch (err) {
    logger.warn(`followAgent migration check failed (non-fatal): ${err.message}`);
  }

  const shutdown = async (signal) => {
    logger.info(`${signal} received, closing panel host`);
    stopLogBridge();
    try {
      await close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return { port, close, reused: false };
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
    return norm(metaUrl) === norm(argv1);
  } catch {
    return false;
  }
}

if (isEntryModule(process.argv[1], __filename)) {
  startPanelHost().then(
    () => {
      // keep alive; server.listen() holds the event loop open
    },
    (error) => {
      process.stderr.write(`panel-host failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
