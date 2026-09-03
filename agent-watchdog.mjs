// Standalone follow-agent watchdog process.
//
// The followAgent setting ("跟随 Coding Agent 启动") used to be hosted inside
// panel-host.mjs — which meant it only worked while a human had opened the
// panel at least once since login. This process breaks that bootstrap
// deadlock: it is registered as the "ApiCredWatchdog" scheduled task (see
// autostart.mjs), so Windows starts it at login, and the agent-watcher poll
// inside it revives the relay with nobody at the panel. The relay itself stays
// lazily started: nothing runs on 47821 until a coding agent appears.
//
// Single-instance guard: binds loopback port 47822 as a marker. EADDRINUSE
// means another watchdog is already alive → exit quietly (same pattern as
// relay-host on 47821 and panel-host on 47820). The listening socket also
// holds the event loop open; the watcher's own poll timer is unref'd.

import { createServer } from "node:http";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync, readFileSync, unlinkSync, realpathSync } from "node:fs";
import { createAgentWatcher } from "./agent-watcher.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";
import { startRelay, getRelayStatus, findPortOwnerPid, isPidAlive, getProcessCommandLine, isOwnProcess } from "./relay-process-manager.mjs";
import { loadSettings, defaultSettingsPath, apiCredRoot } from "./relay-settings.mjs";
import { createLogger } from "./logger.mjs";

export const WATCHDOG_PORT = 47822;
const WATCHDOG_SCRIPT = fileURLToPath(new URL("agent-watchdog.mjs", import.meta.url));

const SPAWN_POLL_MS = 300;
const SPAWN_TIMEOUT_MS = 8000;
const STOP_POLL_MS = 300;
const STOP_TIMEOUT_MS = 6000;

// ---------------------------------------------------------------------------
// PID bookkeeping (mirrors relay-process-manager's relay.pid handling).
// ---------------------------------------------------------------------------

export function getWatchdogPidPath(root) {
  return join(root, "watchdog.pid");
}

function writeWatchdogPid(pid, pidPath) {
  try {
    writeFileSync(pidPath, String(pid), "utf8");
  } catch {
    /* best-effort; a missing pid file just means we can't stop by PID */
  }
}

export function readWatchdogPid(pidPath) {
  try {
    if (!existsSync(pidPath)) return null;
    const text = readFileSync(pidPath, "utf8").trim();
    const pid = Number.parseInt(text, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearWatchdogPid(pidPath) {
  try {
    if (existsSync(pidPath)) unlinkSync(pidPath);
  } catch {
    /* already gone or locked */
  }
}

// ---------------------------------------------------------------------------
// Liveness / lifecycle (usable from any process — panel-host migration,
// panel.mjs settings coordination).
// ---------------------------------------------------------------------------

// Liveness + identity probe: the marker port must answer a JSON body with
// watchdog === true (listenMarkerPort's response), not just any 200 — a
// foreign loopback service on 47822 must not count as a live watchdog.
export function probeWatchdog(port = WATCHDOG_PORT) {
  return new Promise((resolve) => {
    const req = request(`http://127.0.0.1:${port}/`, { method: "GET", timeout: 1500 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(false);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body)?.watchdog === true);
        } catch {
          resolve(false);
        }
      });
      res.on("error", () => resolve(false));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export async function spawnWatchdog(env = process.env) {
  if (await probeWatchdog()) return { ok: true, reused: true };

  const root = apiCredRoot(env);
  clearWatchdogPid(getWatchdogPidPath(root));
  const child = spawn(process.execPath, [WATCHDOG_SCRIPT], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.unref();
  if (child.pid) writeWatchdogPid(child.pid, getWatchdogPidPath(root));

  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeWatchdog()) return { ok: true, reused: false };
    await new Promise((r) => setTimeout(r, SPAWN_POLL_MS));
  }
  return { ok: false, reused: false };
}

function terminatePid(pid) {
  if (!pid || pid <= 0) return;
  try {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch {
    /* process may already be gone */
  }
}

export async function stopWatchdog(env = process.env, deps = {}) {
  // Kill path: UNCACHED port-owner lookup (same rule as stopRelay) — the kill
  // gate must see the fresh owner PID, never a cached one.
  const findOwner = deps.findPortOwnerPid ?? findPortOwnerPid.uncached;
  const isAlive = deps.isPidAlive ?? isPidAlive;
  const getCommandLine = deps.getProcessCommandLine ?? getProcessCommandLine;
  const kill = deps.terminatePid ?? terminatePid;
  const probe = deps.probe ?? (() => probeWatchdog());
  const delay = deps.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = deps.stopPollMs ?? STOP_POLL_MS;
  const timeoutMs = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;

  const root = apiCredRoot(env);
  const pidPath = getWatchdogPidPath(root);
  const filePid = readWatchdogPid(pidPath);
  // Same safety red line as relay-process-manager.stopRelay: kill at most
  // these two specific PIDs (pid file + marker-port owner), never a global
  // node.exe sweep — and only after each PID's command line positively
  // identifies it as an ApiCred app process.
  const ownerPid = await findOwner(WATCHDOG_PORT);

  const refused = [];
  for (const pid of new Set([filePid, ownerPid].filter((p) => Number.isFinite(p) && p > 0))) {
    if (!isAlive(pid)) continue; // dead PID: taskkill would no-op, not a refusal
    if (!isOwnProcess(getCommandLine(pid))) {
      refused.push(pid);
      continue;
    }
    kill(pid);
  }

  const deadline = Date.now() + timeoutMs;
  let down = false;
  while (Date.now() < deadline) {
    if (!(await probe())) {
      down = true;
      break;
    }
    await delay(pollMs);
  }
  if (down) clearWatchdogPid(pidPath);
  if (refused.length > 0) {
    return {
      ok: false,
      reason: `refused to kill PID ${refused.join(", ")}: command line does not identify it as an ApiCred app process`,
    };
  }
  return { ok: down };
}

// ---------------------------------------------------------------------------
// Entry-point host: marker port + real-deps agent watcher.
// ---------------------------------------------------------------------------

function listenMarkerPort(port = WATCHDOG_PORT) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, watchdog: true }));
    });
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") resolve({ reused: true, close: async () => {} });
      else reject(err);
    });
    server.listen(port, "127.0.0.1", () => {
      resolve({ reused: false, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

export async function startWatchdogHost(options = {}) {
  const logger = options.logger ?? createLogger({ sink: (line) => process.stderr.write(line) });
  const { reused, close } = await listenMarkerPort(options.port ?? WATCHDOG_PORT);
  if (reused) {
    // Another watchdog owns the marker port; the HKCU Run entry starting a
    // second copy simply succeeds as a no-op, same as relay-host on 47821.
    return { reused: true, close };
  }
  // legacy name "ApiCred" retained in log prefixes after product rename to Anyswitch
  logger.info(`ApiCred follow-agent watchdog alive on 127.0.0.1:${WATCHDOG_PORT}`);

  const root = apiCredRoot(options.base ?? process.env);
  const metricsCollector = options.metricsCollector ?? createAgentMetricsCollector();
  createAgentWatcher({
    root,
    scanProcesses: () => metricsCollector.scanProcesses(),
    startRelay: () => startRelay(root),
    getRelayStatus: () => getRelayStatus(root),
    loadSettings: (p) => loadSettings(p ?? defaultSettingsPath()),
    logger,
  }).start();

  const shutdown = async (signal) => {
    logger.info(`${signal} received, watchdog exiting`);
    try {
      await close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return { reused: false, close };
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

if (isEntryModule(process.argv[1], fileURLToPath(import.meta.url))) {
  startWatchdogHost().then(
    () => {
      // keep alive; marker-port listen() holds the event loop open
    },
    (error) => {
      process.stderr.write(`watchdog failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
