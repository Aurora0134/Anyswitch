// Cross-process terminal host lifecycle: discovery + one-time migration sweep.
//
// The terminal host (terminal-host.mjs, 127.0.0.1:47823) is spawned and owned
// by the resident relay (relay-host.mjs) as a plain non-detached child — see
// createTerminalHostSupervisor there. Before that ownership change, the panel
// spawned it DETACHED through this module and nothing ever stopped it, so an
// app update left the old process serving old code forever. This module
// therefore no longer spawns anything: the panel only discovers whether the
// terminal backend is serving, and the relay calls stopStaleTerminalHost once
// per start to sweep detached terminal hosts left behind by pre-update builds.
//
// Same safety red line as relay-process-manager: `taskkill /PID <pid> /T /F`
// only ever targets PIDs whose command line positively references this app
// directory — never a global node.exe sweep.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { findPortOwnerPid, getProcessCommandLineAsync, isOwnProcess, isPidAlive } from "./relay-process-manager.mjs";

export const TERMINAL_HOST_PORT = 47823;
// Set by the relay on its managed terminal-host child so the child can watch
// for its parent's death (Windows children do not die with the parent).
export const TERMINAL_PARENT_PID_ENV = "ANYSWITCH_TERMINAL_PARENT_PID";

const STOP_POLL_MS = 100;
const STOP_TIMEOUT_MS = 3000;

export function getTerminalHostPidPath(root) {
  return join(root, "terminal-host.pid");
}

function readPid(path) {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearPidFile(path) {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* already gone or locked */
  }
}

function probe(port = TERMINAL_HOST_PORT, token = null) {
  return fetch(`http://127.0.0.1:${port}/terminal/sessions`, { headers: { authorization: `Bearer ${token || ""}` } })
    .then((response) => response.ok)
    .catch(() => false);
}

// Discovery only: the terminal host starts and stops with the relay, so the
// panel can no longer bring it up itself. A down backend is an empty-state
// situation for the panel frontend, not an error to repair from here.
export async function ensureTerminalHost(root, { probeFn = probe, port = TERMINAL_HOST_PORT } = {}) {
  const token = loadOrGenerateToken(root);
  if (await probeFn(port, token)) {
    return { ok: true, reused: true, pid: readPid(getTerminalHostPidPath(root)), port };
  }
  return {
    ok: false,
    reused: false,
    pid: null,
    port,
    reason: "terminal host is not running; it starts and stops with the relay",
  };
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

// One-time migration sweep for terminal hosts spawned by pre-update builds
// (detached, ownerless, pinned to the old code). The relay runs this once
// before spawning its own managed child: a swept port lets the new child bind,
// while a FOREIGN port owner (command line not in this app directory) is
// refused, reported, and leaves the spawn skipped — never killed.
//
// PID candidate set and identity gate mirror stopRelay exactly: the legacy
// pid file plus the live owner of 47823, each taskkill-gated by isOwnProcess.
export async function stopStaleTerminalHost(root, deps = {}) {
  const findOwner = deps.findPortOwnerPid ?? findPortOwnerPid.uncached;
  const isAlive = deps.isPidAlive ?? isPidAlive;
  const getCommandLine = deps.getProcessCommandLine ?? getProcessCommandLineAsync;
  const kill = deps.terminatePid ?? terminatePid;
  const delay = deps.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = deps.stopPollMs ?? STOP_POLL_MS;
  const timeoutMs = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const port = deps.port ?? TERMINAL_HOST_PORT;

  const pidPath = getTerminalHostPidPath(root);
  const filePid = readPid(pidPath);
  const ownerPid = await findOwner(port);

  const killed = [];
  const refused = [];
  for (const pid of new Set([filePid, ownerPid].filter((p) => Number.isFinite(p) && p > 0))) {
    if (!isAlive(pid)) continue; // dead PID: taskkill would no-op, not a refusal
    if (!isOwnProcess(await getCommandLine(pid))) {
      refused.push(pid);
      continue;
    }
    kill(pid);
    killed.push(pid);
  }

  // The relay spawns its replacement immediately after this sweep; give the
  // killed processes a bounded window to actually die and release the port.
  const deadline = Date.now() + timeoutMs;
  while (killed.some((pid) => isAlive(pid)) && Date.now() < deadline) {
    await delay(pollMs);
  }

  // The pid file is a legacy artifact — the relay-owned child is tracked by
  // handle, no longer by file — so it never survives the sweep.
  clearPidFile(pidPath);

  const result = { ok: refused.length === 0, killed, refused };
  if (refused.length > 0) {
    result.reason = `refused to kill PID ${refused.join(", ")}: command line does not identify it as an Anyswitch app process`;
  }
  return result;
}
