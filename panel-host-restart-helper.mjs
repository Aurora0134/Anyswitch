// One-shot helper that brings a fresh panel-host back up after the old one has
// killed itself to restart.
//
// Why this exists at all: the panel page's 重启 button is served BY panel-host,
// so the process asked to restart is the process answering the request — and
// it cannot be replaced in place. listenLoopbackPanel() resolves {reused:true}
// WITHOUT serving when 47820 is already taken (panel-host.mjs), so a new host
// can only bind once the old one has released the port. Nothing supervises
// panel-host either: the scheduled tasks cover relay-host and the follow-agent
// watchdog, and the only other spawner is the desktop shortcut's launcher. So
// the process that waits for the release and spawns the replacement has to be
// somebody else — that is this script.
//
// panel-host spawns us detached (we outlive it, the same way panel-launcher's
// detached panel-host outlives the launcher), answers the browser, then exits.
// We then poll until 47820 goes quiet, spawn a fresh panel-host, and wait for
// it to answer. Exit code 0 = a panel is serving again.
//
// Deliberately no --mode argument: restarting the host from the *relay's* copy
// of the router is not supported — relay-host's /panel redirects to 47820 now,
// so the control-plane restart can only ever originate on 47820.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync, mkdirSync, openSync, closeSync } from "node:fs";
import { probePanel, waitForPanelReady } from "./panel-launcher.mjs";

const PANEL_PORT = 47820;
// How long to wait for the dying host to release the port. Generous because a
// graceful close can take an event-loop turn or two under load; past this we
// give up rather than double-spawn against a still-held port.
const DEFAULT_RELEASE_TIMEOUT_MS = 10_000;
const DEFAULT_RELEASE_POLL_MS = 200;
// Budget for the replacement to bind and answer. panel-host does real work
// before it listens (git anchor write-back, watchdog probe prewarm), so this
// is wider than the launcher's own wait.
const DEFAULT_READY_TIMEOUT_MS = 12_000;
const DEFAULT_READY_POLL_MS = 300;

// Wait for the old host to let go of 47820, then bring a new one up and confirm
// it answers. Pure orchestration — every dependency is injected:
//   probe()          -> Promise<boolean>, is a panel answering on 47820?
//   spawnPanelHost() -> detached spawn of panel-host.mjs; throws on failure
//   sleep(ms)        -> promise delay
//   log(line)        -> message sink; the real wiring writes stderr, which the
//                       spawner redirects to logs/panel-host-restart.log
// Returns an exit code: 0 = a panel is serving again; 1 = we bailed, and the
// caller's own recovery poll will surface the failure to the user.
export async function runPanelHostRestartHelper({
  probe,
  spawnPanelHost,
  sleep,
  log = () => {},
  releaseTimeoutMs = DEFAULT_RELEASE_TIMEOUT_MS,
  releaseIntervalMs = DEFAULT_RELEASE_POLL_MS,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  readyIntervalMs = DEFAULT_READY_POLL_MS,
  now = Date.now,
}) {
  const deadline = now() + releaseTimeoutMs;
  for (;;) {
    if (!(await probe())) break;
    if (now() >= deadline) {
      // The old host never let go: it is still serving the panel, so the status
      // quo is intact and spawning a second one would only produce an instance
      // that finds the port taken and exits. Leave it alone.
      log(`panel port ${PANEL_PORT} still held after ${releaseTimeoutMs}ms; not spawning`);
      return 1;
    }
    await sleep(releaseIntervalMs);
  }

  log("panel host released the port; spawning replacement");
  try {
    spawnPanelHost();
  } catch (err) {
    log(`failed to spawn panel-host: ${err?.message ?? err}`);
    return 1;
  }

  const ready = await waitForPanelReady({
    probe,
    sleep,
    timeoutMs: readyTimeoutMs,
    intervalMs: readyIntervalMs,
    now,
  });
  if (!ready) {
    log(`panel host did not become ready within ${readyTimeoutMs}ms`);
    return 1;
  }
  log("panel host is back up");
  return 0;
}

// ---------------------------------------------------------------------------
// Real wiring (not exercised by the injected unit tests).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const SELF_SCRIPT = fileURLToPath(import.meta.url);
const PANEL_HOST_SCRIPT = join(here, "panel-host.mjs");
// The helper's only diagnostic trail. Losing it would mean a failed restart
// leaves nothing to read — the panel is just gone until the user re-runs the
// desktop shortcut.
export const RESTART_LOG_PATH = join(here, "logs", "panel-host-restart.log");

function realSpawnPanelHost() {
  // Same shape as panel-launcher's realSpawnPanelHost: detached + windowsHide
  // (background server, no console), stdio ignored, unref so we can exit.
  const child = spawn(process.execPath, [PANEL_HOST_SCRIPT], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    shell: false,
  });
  child.unref();
}

// Bring up this script as a detached one-shot. Called by the panel host BEFORE
// it exits, so the caller must not await anything here.
export function spawnPanelHostRestartHelper({
  spawnFn = spawn,
  execPath = process.execPath,
  scriptPath = SELF_SCRIPT,
  logPath = RESTART_LOG_PATH,
} = {}) {
  let fd = null;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    fd = openSync(logPath, "a");
  } catch {
    fd = null; // a log file we cannot open must never block the restart itself
  }
  try {
    const child = spawnFn(execPath, [scriptPath], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", fd === null ? "ignore" : fd],
      shell: false,
    });
    // spawn() surfaces real failures (ENOENT, EMFILE, EACCES) asynchronously on
    // the child's "error" event. With no listener that becomes an uncaught
    // exception — in the very process that is mid-restart, before its response
    // has necessarily flushed. Swallow it: the caller's recovery poll already
    // reports "panel did not come back" if the helper never lands.
    child?.on?.("error", () => {});
    child?.unref?.();
    return child;
  } finally {
    // The child inherited its own handle at spawn time; holding our copy open
    // only keeps a stray descriptor in the dying host.
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

export async function main({ log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  return runPanelHostRestartHelper({
    probe: () => probePanel(PANEL_PORT),
    spawnPanelHost: realSpawnPanelHost,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
  });
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
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`panel-host restart helper failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
