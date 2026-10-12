// Resident relay host — the single long-lived process that keeps the ZCode
// relay up so the ZCode shortcut (even after an electron-updater reset) no
// longer has to.
//
// This is the "host" side of the architecture shift: instead of the ZCode.lnk
// → wscript → zcode-launcher → relay chain (broken every ZCode update), one
// node process binds 127.0.0.1:47821 for the whole session. ZCode becomes a
// pure consumer: it reads config.json (already pointing at 127.0.0.1:47821 with
// the persistent pi-relay-token) and just connects. Relay availability therefore
// does not depend on the desktop shortcut.
//
// The control panel is mounted *inside* this same server (panel.mjs), so relay
// up ⇔ panel up — no separate daemon process, no supervisor probe loop, no tray.
// Crash recovery is deliberately absent: a crash is an anomaly worth logging
// (relay-host.log) and fixing, not papering over with a 2s poll. Re-login or
// re-run restores it.

import { createWriteStream, mkdirSync, realpathSync, appendFileSync, statSync, renameSync, existsSync, unlinkSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAIRelayServer, listenLoopback } from "./openai-server.mjs";
import { createProductionDeps } from "./launch.mjs";
import { loadStore, storePaths } from "./store-io.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { writeZcodeConfig } from "./zcode-launcher.mjs";
import { writeDshConfig } from "./dsh-launcher.mjs";
import { createLogger, formatLogStamp } from "./logger.mjs";
import { createLoggingEnabledGate, defaultSettingsPath, loadSettings, saveSettings } from "./relay-settings.mjs";
import { createPanelRouter } from "./panel.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";
import { createUsageJournal } from "./usage-journal.mjs";
import { writeRelayPid, clearRelayPid, getRelayPidPath } from "./relay-process-manager.mjs";
import { createStoreWatcher } from "./agent-sync.mjs";
import { spawnAgentSync } from "./agent-sync-spawn.mjs";
import { writeSyncStatus, syncStatusFromResult } from "./sync-status.mjs";
import { createInstanceSocketOwner } from "./instance-socket-owner.mjs";
import { createServiceHealth } from "./service-health.mjs";
import { ensureGitAnchor, logGitAnchorResult } from "./git-anchor.mjs";
import { stopStaleTerminalHost, TERMINAL_PARENT_PID_ENV, TERMINAL_HOST_PORT } from "./terminal-process-manager.mjs";
import { spawn } from "node:child_process";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RELAY_PORT = 47821;
const TERMINAL_HOST_SCRIPT = fileURLToPath(new URL("terminal-host.mjs", import.meta.url));
const LOG_ROTATE_THRESHOLD_BYTES = 5 * 1024 * 1024;
// Mirrors TERMINAL_STATE_FILE in terminal-host.mjs. Duplicated instead of
// imported: importing terminal-host.mjs here would drag node-pty's native
// binding into the relay process, which never spawns a PTY itself.
const TERMINAL_STATE_FILE = "terminal-sessions.json";
// stop({clearSessions}) asks the live host to wipe its sessions first; a wedged
// host must not hold the relay's stop route open, so the call is capped.
const CLEAR_SESSIONS_TIMEOUT_MS = 2000;
// A healthy host dies on kill() immediately; this only caps a wedged child so a
// stop can never hang the relay shutdown path.
const TERMINAL_HOST_STOP_TIMEOUT_MS = 5000;
// spawn() resolving only means the process exists — the host still needs a
// moment to bind 47823, and the panel connects the moment POST
// /terminal-host/start answers. The start route therefore holds its answer
// until the sessions endpoint actually serves; these cap and pace that wait.
const TERMINAL_HOST_START_READY_TIMEOUT_MS = 5000;
const TERMINAL_HOST_START_READY_INTERVAL_MS = 150;
// Crash auto-restart policy (09-26's "no auto-revival" ruling was made for the
// watchdog suicide era — the host died cleanly and silently with no evidence;
// that is fixed, and the crashes the host actually dies of now are node-pty's
// native aborts, upstream issues microsoft/node-pty#951/#904, unfixable from
// JS). A crashed host therefore gets respawned automatically after a short
// delay, bounded by a rolling budget so a host that crashes the moment it is
// spawned cannot churn forever: once restartBudget restarts land inside
// restartWindowMs the supervisor gives up and reports "crashed" until someone
// starts the host deliberately (which resets the budget).
const TERMINAL_HOST_RESTART_DELAY_MS = 1000;
const TERMINAL_HOST_RESTART_WINDOW_MS = 10 * 60 * 1000;
const TERMINAL_HOST_RESTART_BUDGET = 5;

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
//
// Deliberately OUTSIDE the 运行日志 switch: a fatal fault is not a log line, it is
// the evidence of why the process died, and a user who turned recording off is
// exactly the user who will later ask what happened.
export function appendCrashLog(logPath, label, detail) {
  try {
    appendFileSync(logPath, `[${formatLogStamp(Date.now())}] [${label}] ${detail?.stack ?? detail}\n`, "utf8");
  } catch {
    /* log file may be unwritable; exiting anyway */
  }
}

function relayDataRoot(base = process.env) {
  return join(
    base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"),
    "Anyswitch",
  );
}

// Terminal host ownership. Pre-update builds had the PANEL spawn
// terminal-host DETACHED and never stop it, so an app update left the old
// process serving old terminal code forever. The resident relay now owns the
// terminal host as a plain NON-detached child held by handle (never unref'd):
// it starts right after the relay starts listening (unless the persisted
// manual-stop flag says the user shut it down), stop() kills it before every
// relay exit, and a foreign survivor on 47823 is reported, never murdered. The
// child additionally self-watches TERMINAL_PARENT_PID_ENV as the crash backstop
// (Windows children do not die with their parent).
//
// Child output: with logPath wired, the spawn tees the child's stdout AND
// stderr into that file through a shared append fd (the parent closes its own
// copy right after spawn — the child inherited its own). The host dying of a
// native abort otherwise leaves nothing behind: its stderr is exactly where
// node-pty/V8 say why. An oversized log is rotated to .old at each spawn
// (startup-only rotation — the running host holds the file open).
//
// Lifecycle for the panel: start() is idempotent (a live child is a no-op, an
// in-flight start is shared), stop() kills the child and waits for its exit,
// and status() reports { state, pid, lastExit } — "running" while the child
// lives, "stopped-manual" while the manual-stop flag is set, "crashed" after an
// unexpected exit that has not been restarted, "stopped" otherwise. An exit
// that stop() did not initiate is recorded as lastExit = { code, signal, at }
// and — unless the manual-stop flag is set — schedules an automatic restart
// (see the TERMINAL_HOST_RESTART_* policy above). A manual start() supersedes
// and cancels a pending restart and resets the breaker budget.
//
// A terminal host that fails to spawn or exits early (port still held,
// missing pty binding) must NEVER take the relay down — the panel already
// renders that as an empty terminal view, so a warn log is the whole
// handling.
export function createTerminalHostSupervisor({
  root,
  spawnFn = spawn,
  logger = console,
  env = process.env,
  selfPid = process.pid,
  cleanupStale = (rootArg, depsArg) => stopStaleTerminalHost(rootArg, depsArg),
  script = TERMINAL_HOST_SCRIPT,
  manualStop = false,
  stopTimeoutMs = TERMINAL_HOST_STOP_TIMEOUT_MS,
  logPath = null,
  autoRestart = true,
  restartDelayMs = TERMINAL_HOST_RESTART_DELAY_MS,
  restartWindowMs = TERMINAL_HOST_RESTART_WINDOW_MS,
  restartBudget = TERMINAL_HOST_RESTART_BUDGET,
  scheduleFn = setTimeout,
  cancelScheduleFn = clearTimeout,
  nowFn = Date.now,
} = {}) {
  let child = null;
  let lastExit = null;
  let stopping = false;
  let manualStopFlag = manualStop === true;
  let startInFlight = null;
  let restartTimer = null;
  const restarts = [];

  function openChildLog() {
    if (!logPath) return null;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      rotateLogIfNeeded(logPath);
      return openSync(logPath, "a");
    } catch (error) {
      logger.warn(`terminal host log unavailable (${error.message}); child output will be discarded`);
      return null;
    }
  }

  function scheduleRestart() {
    const now = nowFn();
    while (restarts.length && now - restarts[0] > restartWindowMs) restarts.shift();
    if (restarts.length >= restartBudget) {
      logger.warn(`terminal host auto-restart suspended: ${restarts.length} restarts within ${Math.round(restartWindowMs / 60000)} min; start it from the panel to resume`);
      return;
    }
    restarts.push(now);
    logger.warn(`restarting the terminal host automatically (crash ${restarts.length}/${restartBudget} within ${Math.round(restartWindowMs / 60000)} min)`);
    restartTimer = scheduleFn(() => {
      restartTimer = null;
      if (stopping || manualStopFlag || child) return;
      start({ auto: true }).catch((error) => logger.warn(`terminal host auto-restart failed: ${error.message}`));
    }, restartDelayMs);
    restartTimer?.unref?.();
  }

  async function startInner() {
    // One-time migration sweep (see stopStaleTerminalHost). A refusal means
    // 47823 belongs to a foreign process: skip the spawn rather than fight
    // for the port.
    try {
      const cleanup = await cleanupStale(root, { logger });
      if (cleanup.killed?.length) {
        logger.info(`stale terminal host(s) ${cleanup.killed.join(", ")} terminated before respawn`);
      }
      if (!cleanup.ok) {
        logger.warn(`terminal host not started this run: ${cleanup.reason}`);
        return { ok: false, skipped: true, reason: cleanup.reason };
      }
    } catch (error) {
      logger.warn(`stale terminal host sweep failed (continuing): ${error.message}`);
    }
    let spawned;
    let logFd = null;
    try {
      logFd = openChildLog();
      spawned = spawnFn(process.execPath, [script], {
        cwd: __dirname,
        stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
        windowsHide: true,
        env: { ...env, [TERMINAL_PARENT_PID_ENV]: String(selfPid) },
      });
    } catch (error) {
      if (logFd !== null) {
        try { closeSync(logFd); } catch { /* the relay must not leak the handle on a failed spawn */ }
      }
      logger.warn(`terminal host spawn failed (terminal view stays empty until the host is started again): ${error.message}`);
      return { ok: false, skipped: false };
    }
    // spawn() already handed the fd to the child; the parent's copy would only
    // leak one handle per respawn and hold the file open against rotation.
    if (logFd !== null) {
      try { closeSync(logFd); } catch { /* already closed — the child owns its copy either way */ }
    }
    stopping = false;
    lastExit = null;
    child = spawned;
    child.on?.("exit", (code, signal) => {
      if (child !== spawned) return; // our own stop() raced us to it
      child = null;
      if (stopping) {
        stopping = false;
        logger.info("terminal host stopped");
        return;
      }
      lastExit = { code: code ?? null, signal: signal ?? null, at: Date.now() };
      const crashed = `terminal host exited early (code ${code ?? "null"}, signal ${signal ?? "none"})`;
      if (!autoRestart || manualStopFlag) {
        logger.warn(`${crashed}; terminal view stays empty until the host is started again`);
        return;
      }
      logger.warn(crashed);
      scheduleRestart();
    });
    return { ok: true, pid: child.pid ?? null };
  }

  function start({ auto = false } = {}) {
    if (child) return Promise.resolve({ ok: true, pid: child.pid ?? null, alreadyRunning: true });
    if (!auto) {
      // A deliberate (re)start — panel button, relay boot — supersedes any
      // pending auto-restart and re-arms the breaker.
      restarts.length = 0;
      if (restartTimer) {
        cancelScheduleFn(restartTimer);
        restartTimer = null;
      }
    }
    if (startInFlight) return startInFlight;
    startInFlight = startInner().finally(() => {
      startInFlight = null;
    });
    return startInFlight;
  }

  return {
    start,
    async stop() {
      if (restartTimer) {
        cancelScheduleFn(restartTimer);
        restartTimer = null;
      }
      const target = child;
      if (!target) return;
      stopping = true;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, stopTimeoutMs);
        timer.unref?.();
        target.once?.("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          target.kill();
        } catch {
          /* already gone */
          clearTimeout(timer);
          resolve();
        }
      });
      if (child === target) child = null;
    },
    status() {
      let state = "stopped";
      if (child) state = "running";
      else if (manualStopFlag) state = "stopped-manual";
      else if (lastExit) state = "crashed";
      return { state, pid: child?.pid ?? null, lastExit };
    },
    setManualStop(value) {
      manualStopFlag = value === true;
    },
    isManualStop() {
      return manualStopFlag;
    },
  };
}

// ---- Terminal host lifecycle routes (/terminal-host/*) --------------------
// The panel drives these cross-process (47820 → 47821). They live in
// relay-host rather than openai-server.mjs because the supervisor handle only
// exists here; mounting wraps the server's request listener (see
// mountTerminalHostRoutes). Same guard rail as the /api/internal/* routes:
// loopback-only plus the pi-relay-token.

function sendRouteJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function readRouteBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > maxBytes) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error("invalid json"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function requestClearAllSessions({ token, fetchFn, hostPort, timeoutMs }) {
  const response = await fetchFn(`http://127.0.0.1:${hostPort}/terminal/sessions/clear-all`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`clear-all answered ${response.status}`);
  return response.json();
}

// Readiness probe for the start route: the sessions endpoint answering 200 is
// the first moment the host is actually connectable. ECONNREFUSED and non-200
// answers both just mean "not yet" — only the deadline ends the wait.
async function waitForTerminalHostReady({ token, fetchFn, hostPort, timeoutMs, intervalMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetchFn(`http://127.0.0.1:${hostPort}/terminal/sessions`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status === 200) return true;
    } catch {
      /* not listening yet — the interval below paces the retries */
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function createTerminalHostRoutes({
  supervisor,
  token,
  settingsPath,
  root,
  logger = console,
  env = process.env,
  fetchFn = fetch,
  saveSettingsFn = saveSettings,
  hostPort = TERMINAL_HOST_PORT,
  clearSessionsTimeoutMs = CLEAR_SESSIONS_TIMEOUT_MS,
  startReadyTimeoutMs = TERMINAL_HOST_START_READY_TIMEOUT_MS,
  startReadyIntervalMs = TERMINAL_HOST_START_READY_INTERVAL_MS,
}) {
  const persistManualStop = (value) => {
    saveSettingsFn(settingsPath, { terminalHostManualStop: value }, env);
    supervisor.setManualStop(value);
  };

  const routes = {
    "GET /terminal-host/status": async (req, res) => {
      sendRouteJson(res, 200, { ok: true, host: supervisor.status() });
    },
    "POST /terminal-host/start": async (req, res) => {
      const result = await supervisor.start();
      if (!result.ok) {
        return sendRouteJson(res, 500, { ok: false, error: result.reason ?? "terminal host failed to start" });
      }
      // The process being up is not the host being connectable: answering now
      // would send the panel's connect straight into a not-yet-bound port.
      // Wait for the sessions endpoint to serve (the alreadyRunning path takes
      // the same probe — a live child can still be mid-bind after a respawn).
      const ready = await waitForTerminalHostReady({
        token,
        fetchFn,
        hostPort,
        timeoutMs: startReadyTimeoutMs,
        intervalMs: startReadyIntervalMs,
      });
      if (!ready) {
        return sendRouteJson(res, 500, { ok: false, error: "terminal_host_start_timeout" });
      }
      // The manual-stop flag only clears once the host is actually up: clearing
      // it first would let a failed start read back as "never stopped".
      try {
        persistManualStop(false);
      } catch (error) {
        return sendRouteJson(res, 500, { ok: false, error: error.message });
      }
      return sendRouteJson(res, 200, { ok: true, host: supervisor.status() });
    },
    "POST /terminal-host/stop": async (req, res) => {
      const body = await readRouteBody(req);
      const clearSessions = body?.clearSessions === true;
      try {
        persistManualStop(true);
      } catch (error) {
        return sendRouteJson(res, 500, { ok: false, error: error.message });
      }
      let clearFailed = false;
      if (clearSessions) {
        try {
          await requestClearAllSessions({ token, fetchFn, hostPort, timeoutMs: clearSessionsTimeoutMs });
        } catch (error) {
          clearFailed = true;
          logger.warn?.(`terminal sessions clear-all failed (${error.message}); will delete the state file after the host is down`);
        }
      }
      await supervisor.stop();
      // The host was unreachable, so its persisted session records may still
      // name live tabs: with the child dead, deleting the file is the only
      // remaining way to honour the clear.
      if (clearSessions && clearFailed) {
        try {
          unlinkSync(join(root, TERMINAL_STATE_FILE));
        } catch {
          /* nothing persisted — nothing to delete */
        }
      }
      return sendRouteJson(res, 200, { ok: true, host: supervisor.status() });
    },
  };

  // Returns true when the request was claimed (answer already sent or on its
  // way), false when the path is not ours and the upstream relay routes should
  // see it.
  return function handleTerminalHostRoute(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    if (!url.pathname.startsWith("/terminal-host/")) return false;
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendRouteJson(res, 403, { ok: false, error: "loopback_only" });
      return true;
    }
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      sendRouteJson(res, 401, { ok: false, error: "unauthorized" });
      return true;
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) {
      sendRouteJson(res, 404, { ok: false, error: "not_found" });
      return true;
    }
    Promise.resolve(route(req, res)).catch((error) => {
      logger.warn?.(`terminal-host route ${req.method} ${url.pathname} failed: ${error.message}`);
      if (!res.headersSent) {
        sendRouteJson(res, error.statusCode ?? 500, { ok: false, error: error.message });
      }
    });
    return true;
  };
}

// Splice the terminal-host routes in front of the relay server's own request
// listener: openai-server.mjs owns every other path and is not touched.
export function mountTerminalHostRoutes(server, handleTerminalHostRoute) {
  const upstream = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    if (handleTerminalHostRoute(req, res)) return;
    for (const listener of upstream) listener.call(server, req, res);
  });
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
  // Socket→PID 兜底归组的共享 netstat 快照（TTL 内整个 relay 只 spawn 一次
  // netstat；机制见 instance-socket-owner.mjs）。per-launch 路径（launch.mjs）
  // 不下发——那里保持原行为。测试可注入替身。
  const socketOwner = options.socketOwner ?? createInstanceSocketOwner();
  // 中继自检：请求路径在「自身原因失败」与「真的送达上游」两处打点，根路由把
  // 结果随探针下发，面板与 watchdog 才问得出「它还能不能服务」。见 service-health.mjs。
  const serviceHealth = options.serviceHealth ?? createServiceHealth();
  const token = loadOrGenerateToken(root);

  return {
    token,
    loadStore: claudeDeps.loadStore,
    loadCredential: claudeDeps.loadCredential,
    buildUpstreamURLs: claudeDeps.buildUpstreamURLs,
    upstreamFetch: claudeDeps.upstreamFetch,
    recordGeneration: claudeDeps.recordGeneration,
    readGeneration: claudeDeps.readGeneration,
    effortInjector: claudeDeps.effortInjector,
    getKeepAliveConfig: options.getKeepAliveConfig ?? claudeDeps.getKeepAliveConfig,
    getClaudeTierMapping: options.getClaudeTierMapping ?? claudeDeps.getClaudeTierMapping,
    socketOwner,
    serviceHealth,
    panelRouter: createPanelRouter({ storePaths: paths, logger, metricsCollector, hostKind: "relay-host" }),
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
  // Late-bound fatal hook: startResidentRelay installs the metrics flush once
  // the collector exists. Registered here because this handler exits the
  // process, so a second listener registered later would never run.
  let onFatal = null;
  process.on("uncaughtException", (err) => {
    // Flush the display-metric snapshot before exiting: the restart that
    // follows this crash must come back with the board's history, not zeros.
    try { onFatal?.(); } catch { /* the crash path must not throw twice */ }
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
  return (fn) => { onFatal = fn; };
}

// Fire-and-forget warm-up of the collector's process-scan cache. The first
// scan round a collector ever runs is a cold probe (over a second on machines
// without fast WMI); if that round only starts when the panel's first
// /api/agents read arrives, the read can outrun the panel's cross-process pull
// budget and the panel substitutes its own zero-traffic collector — a
// "0 requests" frame on endpoints that are in fact busy. That is exactly the
// backgrounded-panel shape: a relay restart while the tab is hidden means no
// poll ever primes this cache, so the first read after switching back pays the
// cold probe inline. Kicking the round at startup means a snapshot has long
// landed by the time anyone polls. Failures are contained inside the
// collector's probe chain; the catches here only guard injected doubles so the
// warm-up can never disturb startup.
export function warmProcessScanCache(metricsCollector) {
  try {
    metricsCollector?.scanProcesses?.()?.catch(() => {});
  } catch {
    /* a double that throws synchronously must not disturb startup either */
  }
}

// 启动失败的归因。抽出来是为了能验：这一段以前是子进程直写的裸文本，没有时间、
// 没有 PID，而多个实例共写同一个文件，事后只能靠前后文反推时间线；更要紧的是
// 「端口被外人占用」和「自家 relay 在、只是没答上来」被压成同一句话，而这两者的
// 处置完全不同（前者要用户去看谁占了端口，后者是自家进程卡住了）。
//
// 措辞刻意只说「那个进程不按我们的 relay 应答」，不断言它一定是外人：探针认不出
// 自家 relay 时，两种情况都可能。
export function describeRelayStartupFailure(error, pid = process.pid) {
  const foreign = error?.code === "RELAY_PORT_FOREIGN";
  return {
    label: foreign ? "relayStartupBlocked" : "relayStartupFailed",
    detail: foreign
      ? `port ${RELAY_PORT} is held by a process that does not answer as our relay; this resident host will not start (pid ${pid})`
      : `${error?.stack ?? error} (pid ${pid})`,
  };
}

export async function startResidentRelay(options = {}) {
  const logPath = join(__dirname, "logs", "relay-host.log");
  rotateLogIfNeeded(logPath);
  const setFatalHook = redirectStderrToFile(logPath);
  // 运行日志开关的活闸门：中继拥有唯一持久化的日志文件，开关必须当场生效，否则
  // 用户刚关掉记录、文件却还在长，开关就等于没关。崩溃记录走 appendCrashLog 的
  // 直写路径，不受此闸门影响（见 appendCrashLog 的注释）。
  const logger = createLogger({
    sink: (line) => process.stderr.write(line),
    isEnabled: createLoggingEnabledGate(defaultSettingsPath(options.base ?? process.env)),
  });
  try {
    logGitAnchorResult(logger, ensureGitAnchor(__dirname));
  } catch {
    /* never block relay start */
  }

  const deps = createResidentDeps({ ...options, logger });
  // Crash-path flush for the display-metric snapshot (see agent-metrics'
  // METRICS_SNAPSHOT_* block): wired after the collector exists, before any
  // request can be served.
  setFatalHook(() => deps.metricsCollector?.persistMetricsSnapshot?.());

  // Prime the process-scan cache now rather than on the panel's first read —
  // see warmProcessScanCache for the failure shape this pre-empts.
  warmProcessScanCache(deps.metricsCollector);

  // Preflight: refuse to listen if the store is unusable.
  const probe = deps.loadStore();
  if (!probe.ok) {
    logger.error("Anyswitch store not usable; refusing to start resident relay");
    throw new Error("the Anyswitch global store is not usable; refusing to start the resident relay");
  }

  const server = createOpenAIRelayServer(deps);
  const startTime = Date.now();
  let listened;
  try {
    listened = await listenLoopback(server, RELAY_PORT);
  } catch (error) {
    // 启动失败必须落一条带时间戳、带自身进程号的记录，且不受运行日志开关影响：
    // 关掉记录的人正是事后要问「为什么起不来」的人。
    const { label, detail } = describeRelayStartupFailure(error);
    appendCrashLog(logPath, label, detail);
    error.loggedByRelayHost = true;
    throw error;
  }
  const { port, reused, close } = listened;

  if (reused) {
    // Port 47821 already answers the relay probe — another relay (likely a
    // per-launch zcode-launcher instance, or a prior resident host) is already
    // serving. Exit 0 rather than compete for the port: the existing instance
    // owns 47821, and the autostart entry will simply succeed
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

  // The terminal host lives and dies with THIS relay (see
  // createTerminalHostSupervisor): swept-and-spawned here, killed in
  // shutdown() below, replaced wholesale on every update. A persisted
  // manual-stop flag means the user shut it down from the panel — the relay
  // respects that and leaves it down instead of resurrecting it.
  const settingsPath = defaultSettingsPath(options.base ?? process.env);
  let terminalHostManualStop = false;
  try {
    terminalHostManualStop = loadSettings(settingsPath).settings.terminalHostManualStop === true;
  } catch {
    /* an unreadable settings file must never keep the host down */
  }
  const terminalSupervisor = options.terminalSupervisor ?? createTerminalHostSupervisor({
    root,
    logger,
    manualStop: terminalHostManualStop,
    // The host is windowless; tee its stdout/stderr into a sibling log so a
    // native abort (node-pty/microsoft#951 style) leaves its last words on disk.
    logPath: join(__dirname, "logs", "terminal-host.log"),
  });
  mountTerminalHostRoutes(server, createTerminalHostRoutes({
    supervisor: terminalSupervisor,
    token: deps.token,
    settingsPath,
    root,
    logger,
  }));
  if (terminalHostManualStop) {
    logger.info("terminal host was stopped manually; leaving it down (start it from the panel to resume)");
  } else {
    await terminalSupervisor.start();
  }

  // Initial sync of all agent configs (zcode, dsh, pi, kimi, qoder, codex,
  // opencode, grok).
  // Spawned as a child process so the merge logic always loads from disk —
  // catalog-writer fixes take effect on the next sync without restarting
  // this resident host.
  try {
    const syncResult = await spawnAgentSync({ port, logger });
    // 失败上屏的落盘点：结果写进 sync-status.json（与 store.json 同级），面板
    // 轮询它渲染「上次同步未成功」——运行日志被用户关掉时 logger.error 那行会
    // 被活闸门整条丢弃，这份文件是失败最后剩下的可见面。落盘失败不得反过来
    // 弄坏同步本身。
    try {
      writeSyncStatus(root, syncStatusFromResult(syncResult, "startup"));
    } catch (err) {
      logger.warn?.(`sync status write failed: ${err.message}`);
    }
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
      // 同启动同步：结果落 sync-status.json 供面板上屏（详见上方注释）。
      try {
        writeSyncStatus(root, syncStatusFromResult(syncResult, "store-change"));
      } catch (err) {
        logger.warn?.(`sync status write failed: ${err.message}`);
      }
      if (!syncResult.ok) {
        logger.error(`agent config sync failed: ${syncResult.error ?? `runner exit ${syncResult.code}`}`);
      }
    },
  });

  // Never phrase this as a panel URL: this line is bridged into the panel's
  // 实时输出 window, and 47821 serves no page — its /panel redirects to the
  // control plane. Only its /panel/api/* surface is live (session reports).
  logger.info(`relay data plane on 127.0.0.1:${port}; panel page lives on 47820 (this port's /panel redirects there)`);

  // Graceful shutdown on Ctrl-C / service stop / supervisor kill. Always clear
  // the pid file so relay-process-manager sees "stopped" and can start cleanly.
  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    // The terminal host child goes first — it must never outlive this relay.
    terminalSupervisor.stop();
    // Final snapshot flush: the next relay (restart, login respawn) restores
    // the board's metric history from this file instead of starting at zero.
    try { deps.metricsCollector?.persistMetricsSnapshot?.(); } catch { /* shutdown must not fail on the sidecar */ }
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
  process.on("exit", () => {
    terminalSupervisor.stop();
    clearPid();
  });

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
      // 兜底：startResidentRelay 已经归因记录过的（监听失败）不再重复落一条。
      // 走到这里的是更早的抛出——装配、store 预检之类——同样要带时间戳与进程号，
      // 否则又回到「裸文本、多个实例共写一个文件」那种事后无从归因的状态。
      if (error?.loggedByRelayHost !== true) {
        const { label, detail } = describeRelayStartupFailure(error);
        appendCrashLog(join(__dirname, "logs", "relay-host.log"), label, detail);
      }
      process.exit(1);
    },
  );
}
