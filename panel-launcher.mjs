// Panel launcher — the human entry point to the standalone control panel.
//
// In the decoupled architecture the control panel is a separate long-lived
// process (panel-host.mjs, 127.0.0.1:47820). This launcher is the desktop
// shortcut bridge: .lnk → wscript → vbs shim → node panel-launcher.mjs, and the
// .mjs does the only logic that matters:
//
//   1. probe 47820/panel — is the control panel already up?
//   2. if not, spawn panel-host.mjs detached and wait for it to answer
//   3. open the panel in the default browser (http://127.0.0.1:47820/panel)
//
// It brings up the PANEL, not the relay. The relay (47821) is a separate
// process that the panel starts/stops on demand (or the followAgent watcher
// auto-starts when a coding agent appears). A down relay does not block this
// launcher — the panel opens and shows "relay stopped" + a start button.
//
// runPanelLauncher() takes every side effect as an injected dependency, so the
// probe-hit / probe-miss / spawn-failure branches are testable with zero real
// spawn and zero real panel.

import { spawn } from "node:child_process";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const PANEL_PORT = 47820;
// How long to wait for a just-spawned panel-host to bind before giving up.
const DEFAULT_PANEL_READY_TIMEOUT_MS = 8_000;
const DEFAULT_PROBE_INTERVAL_MS = 400;

// Is the control panel answering on PORT? Probes /panel/api/status (loopback,
// unauthenticated) and treats a 200 as "up".
// Exported: panel-host-restart-helper.mjs waits on the same definition, so the
// "is a panel up?" question is answered one way in this app.
export function probePanel(port = PANEL_PORT) {
  return new Promise((resolve) => {
    const req = request(`http://127.0.0.1:${port}/panel/api/status`, { method: "GET", timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Decide what to do, given a probe result. Pure: no IO.
export function decideAction(probeOk) {
  return probeOk ? { kind: "open" } : { kind: "spawn" };
}

// Wait for the panel to answer on PORT by polling probe(). Resolves true once
// it answers, false on timeout. Injected probe + sleep keep it testable.
export async function waitForPanelReady({ probe, sleep, timeoutMs = DEFAULT_PANEL_READY_TIMEOUT_MS, intervalMs = DEFAULT_PROBE_INTERVAL_MS, now = Date.now }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

// Back-compat alias for callers/tests that used the old name.
export const waitForRelayReady = waitForPanelReady;

// Orchestrate a single panel launch. Returns an exit code (0 success).
// Every dependency is injected:
//   probe()           -> Promise<boolean>, is the panel answering?
//   spawnPanelHost()  -> start panel-host detached (returns nothing; errors throw)
//   openBrowser()     -> open http://127.0.0.1:47820/panel in the default browser
//   sleep(ms)         -> promise delay (used while waiting for the panel)
//   log(line)         -> operator-facing message sink
//   timeoutMs/intervalMs -> panel-ready poll tuning
export async function runPanelLauncher({
  probe,
  spawnPanelHost,
  openBrowser,
  sleep,
  log = () => {},
  timeoutMs = DEFAULT_PANEL_READY_TIMEOUT_MS,
  intervalMs = DEFAULT_PROBE_INTERVAL_MS,
  now = Date.now,
}) {
  const action = decideAction(await probe());

  if (action.kind === "open") {
    log("panel already running; opening");
    await openBrowser();
    return 0;
  }

  // Probe missed: bring the panel host up, then wait for it to answer.
  log("panel not running; starting panel-host");
  try {
    spawnPanelHost();
  } catch (err) {
    log(`failed to start panel-host: ${err?.message ?? err}`);
    return 1;
  }

  const ready = await waitForPanelReady({ probe, sleep, timeoutMs, intervalMs, now });
  if (!ready) {
    log(`panel did not become ready within ${timeoutMs}ms; not opening`);
    return 1;
  }
  log("panel is up; opening");
  await openBrowser();
  return 0;
}

// ---------------------------------------------------------------------------
// Real wiring (not exercised by the injected unit tests).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));

function realSpawnPanelHost() {
  // Detached + windowsHide: panel-host is a background server with no console.
  // stdio ignored — the host redirects its own stderr. unref so the launcher
  // can exit once the browser is open.
  const child = spawn(process.execPath, [join(here, "panel-host.mjs")], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    shell: false,
  });
  child.unref();
}

function realOpenBrowser() {
  // `start "" "url"` opens the URL in the default browser via cmd.exe /c. The
  // empty title arg ("") prevents a quoted URL being mistaken for the title.
  return new Promise((resolve) => {
    const child = spawn("cmd.exe", ["/c", "start", "", `http://127.0.0.1:${PANEL_PORT}/panel`], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}

export async function main() {
  const code = await runPanelLauncher({
    probe: () => probePanel(PANEL_PORT),
    spawnPanelHost: realSpawnPanelHost,
    openBrowser: realOpenBrowser,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  return code;
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
      process.stderr.write(`panel-launcher failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
