// Cross-process relay lifecycle supervisor.
//
// The panel (panel-host.mjs, port 47820) is a SEPARATE process from the relay
// (relay-host.mjs, port 47821). So that the panel can start/stop/restart the
// relay without dying itself, this module owns the relay's OS process: it
// records the relay PID to %LOCALAPPDATA%\ApiCred\relay.pid, probes 47821's
// root-endpoint liveness, and spawns/kills relay-host.mjs by that single PID.
//
// Safety red line: we ONLY ever terminate recorded/verified PIDs, via
// `taskkill /PID <pid> /T /F`, and only after the PID's command line (via
// PowerShell Get-CimInstance, not the removed wmic) positively references
// this app directory. Never `taskkill /IM node.exe` — that would murder every
// other Node process on the machine (ZCode, Claude Code, DSH, the panel host
// itself).

import { existsSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeRelay } from "./openai-server.mjs";

const RELAY_PORT = 47821;
const RELAY_HOST_SCRIPT = fileURLToPath(new URL("relay-host.mjs", import.meta.url));
// Directory every ApiCred relay process is spawned from — the resident
// relay-host.mjs AND the per-launch launchers (zcode/dsh/pi/kimi/reasonix,
// which also legitimately bind 47821) all run scripts located here. This is
// the trust boundary for the PID identity check before any taskkill.
const APP_DIR = fileURLToPath(new URL(".", import.meta.url));

const PS_QUERY_TIMEOUT_MS = 5000;

const START_POLL_MS = 300;
const START_TIMEOUT_MS = 8000;
const STOP_POLL_MS = 300;
const STOP_TIMEOUT_MS = 6000;

export function getRelayPidPath(root) {
  return join(root, "relay.pid");
}

export function writeRelayPid(pid, pidPath) {
  try {
    writeFileSync(pidPath, String(pid), "utf8");
  } catch {
    /* best-effort; a missing pid file just means we can't stop by PID */
  }
}

export function clearRelayPid(pidPath) {
  try {
    if (existsSync(pidPath)) unlinkSync(pidPath);
  } catch {
    /* already gone or locked */
  }
}

export function readRelayPid(pidPath) {
  try {
    if (!existsSync(pidPath)) return null;
    const text = readFileSync(pidPath, "utf8").trim();
    const pid = Number.parseInt(text, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Windows process liveness via tasklist (no wmic dependency). true = alive.
export function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      windowsHide: true,
      timeout: 2000,
    });
    const out = r.stdout ? r.stdout.toString() : "";
    // tasklist prints a CSV row containing the pid in quotes when it exists.
    return new RegExp(`"${pid}"`).test(out);
  } catch {
    return false;
  }
}

const NETSTAT_TIMEOUT_MS = 3000;
const NETSTAT_MAX_BUFFER = 4 * 1024 * 1024;
export const PORT_OWNER_CACHE_TTL_MS = 5000;

// Pure parser: `netstat -ano -p tcp` output → the PID LISTENING on `port`,
// or null when no such row exists.
export function parsePortOwnerPid(out, port) {
  const needle = `:${port}`;
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes(needle)) continue;
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const pid = Number.parseInt(cols[cols.length - 1], 10);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

// Find the PID that actually owns (is LISTENING on) a given local TCP port,
// via `netstat -ano`. ASYNC (was spawnSync): the panel's /api/status poll
// calls this on every tick, and a synchronous netstat blocked the whole panel
// event loop for tens of ms each time. The spawnSync semantics are rebuilt
// by hand: timeout via timer + child.kill, maxBuffer via streaming
// accumulation (kills the child on overflow, no backpressure stall), and any
// error / non-zero exit resolves null.
//
// This is the robust fallback when relay.pid is stale or absent (e.g. the
// relay was started by an older build that didn't write the pid file, or a
// per-launch launcher instance). Safety stays intact: we only ever resolve
// and target the single PID bound to the relay's own port — never a global
// `taskkill /IM node.exe`.
export function findPortOwnerPid(port) {
  if (!port) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("netstat", ["-ano", "-p", "tcp"], { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (pid) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(pid);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(null);
    }, NETSTAT_TIMEOUT_MS);
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.length > NETSTAT_MAX_BUFFER) {
        // ENOBUFS equivalent: too much output, kill and bail.
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        finish(null);
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0) return finish(null);
      finish(parsePortOwnerPid(out, port));
    });
  });
}

// 5s TTL cache + in-flight dedupe wrapper around an uncached port-owner
// lookup, keyed by port. The cache is for DISPLAY paths only (status polls) —
// kill decisions must use the uncached lookup. `now` is injectable for tests.
export function createCachedPortOwnerFinder(uncached, { ttlMs = PORT_OWNER_CACHE_TTL_MS, now = () => Date.now() } = {}) {
  const cache = new Map(); // port -> { pid, expiresAt }
  const inflight = new Map(); // port -> Promise<pid|null>
  return function cachedFindPortOwnerPid(port) {
    const hit = cache.get(port);
    if (hit && now() < hit.expiresAt) return Promise.resolve(hit.pid);
    const pending = inflight.get(port);
    if (pending) return pending;
    const p = Promise.resolve()
      .then(() => uncached(port))
      .then((pid) => {
        cache.set(port, { pid, expiresAt: now() + ttlMs });
        return pid;
      })
      .finally(() => {
        inflight.delete(port);
      });
    inflight.set(port, p);
    return p;
  };
}

// Display-path lookup (getRelayStatus): cached, deduped.
findPortOwnerPid.cached = createCachedPortOwnerFinder(findPortOwnerPid);
// Kill-decision lookup (stopRelay/stopWatchdog): the raw function itself —
// completely bypasses the cache and the in-flight table, no shared slot.
findPortOwnerPid.uncached = findPortOwnerPid;

// Read a process's command line via PowerShell Get-CimInstance (wmic is gone
// on Win11 24H2, so it must not be used). Returns null whenever the query
// fails, times out, or yields nothing — callers treat null as "cannot verify"
// and must NOT kill the PID (fail-safe).
export function getProcessCommandLine(pid) {
  if (!pid || pid <= 0) return null;
  try {
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine`,
      ],
      { windowsHide: true, timeout: PS_QUERY_TIMEOUT_MS },
    );
    if (r.error || r.status !== 0) return null;
    const line = (r.stdout ? r.stdout.toString() : "").trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

// A PID may only be terminated when its command line references this app
// directory. The check is deliberately "command line contains the app dir",
// NOT "runs relay-host.mjs": the per-launch launchers also legitimately bind
// 47821, and every one of them is spawned from a script inside this
// directory. Both slash styles are accepted (spawned command lines may use
// either). Anything else — foreign process, or a command line we could not
// read — fails the check.
export function isOwnProcess(commandLine, appDir = APP_DIR) {
  if (typeof commandLine !== "string" || typeof appDir !== "string") return false;
  const haystack = commandLine.toLowerCase();
  const back = appDir.toLowerCase();
  const fwd = back.replaceAll("\\", "/");
  return haystack.includes(back) || haystack.includes(fwd);
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

function spawnRelayHost(env = process.env) {
  const child = spawn(process.execPath, [RELAY_HOST_SCRIPT], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.unref();
  return child;
}

async function waitForRelayUp(timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeRelay(RELAY_PORT)) return true;
    await new Promise((r) => setTimeout(r, START_POLL_MS));
  }
  return false;
}

export async function getRelayStatus(root, deps = {}) {
  const probe = deps.probe ?? ((port) => probeRelay(port));
  // Display path: cached port-owner lookup (5s TTL). The cached value never
  // feeds a kill decision — startRelay's reuse short-circuit is guarded by
  // the live HTTP probe, not by this PID.
  const findOwner = deps.findPortOwnerPid ?? findPortOwnerPid.cached;
  const isAlive = deps.isPidAlive ?? isPidAlive;

  const pidPath = getRelayPidPath(root);
  const filePid = readRelayPid(pidPath);
  const serving = await probe(RELAY_PORT);

  if (serving) {
    // The port owner is authoritative — a stale relay.pid (left by a dead
    // process that was since replaced) must not be reported as the relay's PID.
    const ownerPid = await findOwner(RELAY_PORT);
    const pid = Number.isFinite(ownerPid) ? ownerPid : filePid;
    return { status: "running", pid, port: RELAY_PORT };
  }
  // Port not answering. Distinguish starting (pid alive) from stopped
  // (no live pid) and clean a stale pid file so a later start is clean.
  if (filePid && isAlive(filePid)) {
    return { status: "starting", pid: filePid, port: RELAY_PORT };
  }
  if (filePid) clearRelayPid(pidPath);
  return { status: "stopped", pid: null, port: RELAY_PORT };
}

export async function startRelay(root, env = process.env) {
  const existing = await getRelayStatus(root);
  if (existing.status === "running") {
    return { ok: true, relay: existing, reused: true };
  }
  // Clear any stale pid so the new child's pid is authoritative.
  clearRelayPid(getRelayPidPath(root));

  const child = spawnRelayHost(env);
  if (child.pid) writeRelayPid(child.pid, getRelayPidPath(root));

  const up = await waitForRelayUp();
  const status = await getRelayStatus(root);
  return { ok: up, relay: status, reused: false };
}

export async function stopRelay(root, deps = {}) {
  const probe = deps.probe ?? ((port) => probeRelay(port));
  // Kill path: UNCACHED port-owner lookup — the kill gate must see the fresh
  // owner PID, never a cached one, and must not share the display cache's
  // in-flight slot.
  const findOwner = deps.findPortOwnerPid ?? findPortOwnerPid.uncached;
  const isAlive = deps.isPidAlive ?? isPidAlive;
  const getCommandLine = deps.getProcessCommandLine ?? getProcessCommandLine;
  const kill = deps.terminatePid ?? terminatePid;
  const delay = deps.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = deps.stopPollMs ?? STOP_POLL_MS;
  const timeoutMs = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;

  const pidPath = getRelayPidPath(root);
  const filePid = readRelayPid(pidPath);
  // Resolve the real owner of 47821 so a stale pid file doesn't leave the
  // relay running. We kill at most these two candidate PIDs (both specific),
  // never a global node.exe sweep — and only after each PID's command line
  // positively identifies it as an ApiCred app process.
  const ownerPid = await findOwner(RELAY_PORT);

  // PID identity gate: a live PID whose command line does not reference this
  // app directory (PID reuse by an unrelated process, or a command line we
  // simply could not query) is never killed. Refusals are reported through
  // ok:false + reason — the panel frontend surfaces that to the user instead
  // of a silent skip that would look like success.
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
  while (Date.now() < deadline) {
    if (!(await probe(RELAY_PORT))) break;
    await delay(pollMs);
  }

  clearRelayPid(pidPath);
  const status = await getRelayStatus(root, { probe, findPortOwnerPid: findOwner, isPidAlive: isAlive });
  const result = { ok: status.status === "stopped" && refused.length === 0, relay: status };
  if (refused.length > 0) {
    result.reason = `refused to kill PID ${refused.join(", ")}: command line does not identify it as an ApiCred app process`;
  }
  return result;
}

export async function restartRelay(root, env = process.env, deps = {}) {
  const stop = deps.stopRelay ?? stopRelay;
  const start = deps.startRelay ?? startRelay;
  const stopResult = await stop(root);
  // A failed stop must abort the restart: starting a second relay while the
  // old one still owns 47821 would just produce a duplicate that exits.
  if (!stopResult.ok) return stopResult;
  return start(root, env);
}
