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
import { createLogger } from "../shared/logger.mjs";
import { createAgentMetricsCollector } from "../agents/agent-metrics.mjs";
import { storePaths } from "../store/store-io.mjs";
import { loadSettings, defaultSettingsPath, createLoggingEnabledGate } from "../relay/relay-settings.mjs";
import { isWatchdogAutostartEnabled, enableWatchdogAutostart, reconcileAutostart } from "../ops/autostart.mjs";
import { spawnWatchdog, probeWatchdog } from "../agents/agent-watchdog.mjs";
import { reconcileShims } from "../agents/shim-reconcile.mjs";
import { ensureGitAnchor, logGitAnchorResult } from "../ops/git-anchor.mjs";
import { ensureTerminalHost } from "../terminal/terminal-process-manager.mjs";

const __filename = fileURLToPath(import.meta.url);
// 仓根（本文件在 src/panel/）。git anchor 维护的是安装树的 .git；传 dirname(__filename)
// 会让它在 src/panel 下另写一个 gitfile（2026-11-01 分域重构漏改）。
const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
export const PANEL_PORT = 47820;

function isLoopback(remoteAddress) {
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

export function createPanelServer(options = {}) {
  const paths = options.paths ?? storePaths();
  // 运行日志开关：闸门每次调用现读 settings.json（不按 mtime 缓存——同刻度的连写会
  // 骗过 mtime，见 relay-settings.mjs 的 createSettingGate），关掉后下一次写入即停，
  // 不需要重启面板。面板自己的记录只活在内存环形缓冲里（stderr 无人接收），所以
  // 关掉这一处就等于把实时输出整条链路关掉——中继条目经桥、各端点条目经 ingest
  // 都汇入同一个 logger。
  const logger = options.logger ?? createLogger({
    sink: (line) => process.stderr.write(line),
    isEnabled: options.isLoggingEnabled ?? createLoggingEnabledGate(options.settingsFile ?? defaultSettingsPath()),
  });
  const metricsCollector = options.metricsCollector ?? createAgentMetricsCollector();
  const startTime = options.startTime ?? Date.now();
  const router = createPanelRouter({
    storePaths: paths,
    logger,
    metricsCollector,
    startTime,
    // 同步完成后对齐垫片门牌（真实现由 startPanelHost 注入；直接建路由器的测
    // 试与 relay-host 副本不传即不触发——注入语义见 panel.mjs）。
    reconcileShimsFn: options.reconcileShimsFn,
    // 自动检测并下载更新的真实拍节（首开一拍 + 周期拍），只在常驻 panel-host
    // 进程里布——panel.mjs 侧的默认值刻意是「不布」。
    selfUpdateAutoDownloadScheduleFn: options.selfUpdateAutoDownloadScheduleFn ?? ((fn) => {
      const first = setTimeout(fn, 60_000);
      const interval = setInterval(fn, 6 * 3600_000);
      first.unref?.();
      interval.unref?.();
      return { first, interval };
    }),
  });
  // Warm the watchdog drift snapshot at startup: the panel frontend fetches
  // /api/settings on every page load to hydrate the 抗截断 toggle, and an
  // un-primed first GET would otherwise pay the ~1s probe round inline.
  // Fire-and-forget — the first GET cold-waits only if it beats the prewarm.
  router.prewarmWatchdogProbes();
  // Cold-scan prewarm (environment detection + sessions snapshot): same deal —
  // the first scan moves from the first user request to process startup. The
  // new-terminal menu's agent list and the terminal rail history stop paying
  // the cold scan inline. Fire-and-forget; failures fall back to lazy paths.
  router.prewarmColdScans();
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

// Discovery only: the terminal host is spawned and stopped by the relay (see
// createTerminalHostSupervisor in relay-host.mjs). A missing backend just
// means the relay is down — the panel frontend renders that as the terminal
// empty state — so this never throws and never repairs.
export async function discoverTerminalBackend(root, { ensureFn = ensureTerminalHost, logger } = {}) {
  try {
    const result = await ensureFn(root, { logger });
    if (!result?.ok) {
      logger?.warn?.("terminal host not reachable; the terminal view stays empty until the relay is running");
    }
    return result;
  } catch (error) {
    logger?.warn?.(`terminal host unavailable (non-fatal): ${error.message}`);
    return { ok: false };
  }
}

export async function startPanelHost(options = {}) {
  // 垫片对账真实现默认在此注入（createPanelServer 与路由器的默认都是不注入
  // 即不触发——测试安全边界，注入语义见 panel.mjs）。
  const reconcileShimsFn = options.reconcileShimsFn ?? reconcileShims;
  const { server, logger, metricsCollector } = createPanelServer({ ...options, reconcileShimsFn });
  try {
    logGitAnchorResult(logger, ensureGitAnchor(APP_DIR));
  } catch {
    /* never block panel start */
  }
  const paths = options.paths ?? storePaths();
  const preferredPort = options.port ?? PANEL_PORT;
  // Never fatal to the panel — see discoverTerminalBackend.
  await discoverTerminalBackend(paths.root, { logger, ensureFn: options.ensureTerminalHostFn });
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

  // Autostart tasks store an absolute path snapshot. When the source tree moves
  // (the 2026-11 src/ split did), the task keeps pointing at the old location
  // and the logon entry dies silently — wscript hides the console, so nothing
  // reaches a log. The toggle only ever asked "does the task exist", so the
  // panel went on claiming 开启. Reconcile once per start: correct the path
  // when it drifted, leave absent tasks alone (that is the user's own 关闭).
  try {
    const reconciled = await reconcileAutostart();
    if (!reconciled.ok) {
      logger.warn(`autostart: could not read the scheduled tasks, leaving them alone (non-fatal): ${reconciled.error}`);
    }
    for (const task of reconciled.tasks) {
      if (task.state === "healed") logger.info(`autostart: re-registered ${task.task} — stored action pointed at ${task.was}`);
      if (task.state === "backfilled") logger.info(`autostart: registered ${task.task} — install predates panel autostart coverage`);
      if (task.state === "heal-failed") logger.warn(`autostart: ${task.task} points at a stale path and re-registering failed (non-fatal): ${task.error}`);
    }
  } catch (err) {
    logger.warn(`autostart reconcile failed (non-fatal): ${err.message}`);
  }

  // 垫片对账：门牌跟随接线状态（shim-reconcile.mjs 头注释——「垫片随产品安
  // 装」语义）。升级路径也靠这一轮自愈：换树后新面板宿主起来，≤0.7.0 旧形态
  // 门牌就地改写成新路径。外围设施姿态与自启对账一致：失败记日志，不挡面板。
  try {
    const shimReport = await reconcileShimsFn({
      log: (level, message) => logger[level]?.(message),
    });
    if (!shimReport?.ok) {
      logger.warn(`shims: left as-is (non-fatal): ${shimReport?.reason ?? "unknown reason"}`);
    }
  } catch (err) {
    logger.warn(`shim reconcile failed (non-fatal): ${err.message}`);
  }

  const shutdown = async (signal) => {
    logger.info(`${signal} received, closing panel host`);
    stopLogBridge();
    // 导入预览可能正攥着解到 %TEMP% 的包与明文密钥内存副本；退出前丢掉。
    try {
      router.dropDataBundleTickets?.();
    } catch (err) {
      logger.warn(`导入暂存清理失败 (non-fatal): ${err.message}`);
    }
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
