import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { relayDataRoot } from "../relay/relay-settings.mjs";
import { findPortOwnerPid, getProcessCommandLineAsync, isPidAlive, startRelay, stopRelay } from "../relay/relay-process-manager.mjs";
import { waitForPanelReady } from "../panel/panel-launcher.mjs";
import { probePanelAppInfo, SELF_UPDATE_CLIENT_ID } from "./app-self-update.mjs";
import { clientUpdateJournalDir, runningClientUpdate } from "../agents/client-update-journal.mjs";
import { retireAgentWatchdog } from "./retire-agent-watchdog.mjs";
import { reconcileAutostart } from "./autostart.mjs";
import { migrateDesktopShortcut } from "./desktop-shortcut.mjs";
import { resolveInstallRoot } from "./update-trust.mjs";
import { LOAD_REASON, loadStore, storePaths, writeStore } from "../store/store-io.mjs";

const PANEL_PORT = 47820;
const APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const INSTALL_ROOT = resolveInstallRoot({ appRoot: APP_ROOT });
const probePanel = async () => Boolean((await probePanelAppInfo(PANEL_PORT))?.version);

export function ensureInitialStore(root) {
  const paths = storePaths(root);
  if (loadStore(paths).reason === LOAD_REASON.ABSENT) {
    mkdirSync(root, { recursive: true });
    writeStore({ version: 2, providers: {} }, { paths, expectedHash: null });
  }
}

async function startPanel() {
  if (await probePanel()) return true;
  const child = spawn(process.execPath, [join(APP_ROOT, "src", "panel", "panel-host.mjs")], {
    detached: true, windowsHide: true, stdio: "ignore",
  });
  child.on("error", (error) => console.error(error.message));
  child.unref();
  return waitForPanelReady({ probe: probePanel, sleep: wait });
}

export function isHostCommand(command, host, roots, installRoot) {
  const quoted = String(command ?? "").match(/"[^"]+"|[^\s]+/g) ?? [];
  const normalize = (s) => s.replace(/^"|"$/g, "").replaceAll("/", "\\").toLowerCase();
  const script = normalize(quoted[1] ?? "");
  const suffixes = [`\\${host}-host.mjs`, `\\src\\${host}\\${host}-host.mjs`];
  if (roots.some((root) => {
    const prefix = normalize(root).replace(/\\+$/, "");
    return suffixes.some((suffix) => script === prefix + suffix);
  })) return true;
  if (!installRoot) return false;
  const prefix = normalize(join(installRoot, "versions")) + "\\";
  if (!script.startsWith(prefix)) return false;
  const match = /^([\w.+-]+)\\app(\\.+)$/.exec(script.slice(prefix.length));
  return !!match && suffixes.includes(match[2]);
}

const ownsHost = (command, host) => isHostCommand(command, host,
  [APP_ROOT, join(relayDataRoot(), "app"), join(relayDataRoot(), "..", "ApiCred", "app")], INSTALL_ROOT);

async function stopPanel() {
  const pid = await findPortOwnerPid.uncached(PANEL_PORT, { distinguishFailure: true });
  if (pid === null) return true;
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (!ownsHost(await getProcessCommandLineAsync(pid), "panel")) return false;
  try { process.kill(pid); } catch (error) { if (error.code !== "ESRCH") throw error; }
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await findPortOwnerPid.uncached(PANEL_PORT)) !== pid) return !await probePanel();
    await wait(100);
  }
  return false;
}

async function waitForSelfUpdate(root) {
  const deadline = Date.now() + 85_000;
  const journal = clientUpdateJournalDir(root);
  while (Date.now() < deadline) {
    const update = runningClientUpdate(journal, SELF_UPDATE_CLIENT_ID);
    if (!update || (update.workerPid && !isPidAlive(update.workerPid))) return true;
    await wait(250);
  }
  return false;
}

export async function runDesktopLifecycle(action, {
  root = relayDataRoot(), retire = () => retireAgentWatchdog({ installRoot: INSTALL_ROOT }), openPanel = startPanel,
  start = startRelay, stop = (dir) => stopRelay(dir, { ownsProcess: (cmd) => ownsHost(cmd, "relay") }),
  closePanel = stopPanel, reconcile = reconcileAutostart, initializeStore = ensureInitialStore,
  waitForUpdate = () => waitForSelfUpdate(root),
  migrateShortcut = () => migrateDesktopShortcut({ installRoot: INSTALL_ROOT,
    sourceRoots: [join(root, "app"), join(root, "..", "ApiCred", "app")],
  }),
} = {}) {
  if (action === "open") {
    return await openPanel();
  }
  if (action === "start") {
    if (!await retire()) return false;
    initializeStore(root);
    const relay = await start(root);
    return await openPanel() && relay.ok;
  }
  if (action === "stop") {
    if (!await retire() || !await waitForUpdate()) return false;
    if (!(await stop(root)).ok) return false;
    return await closePanel();
  }
  if (action === "migrate") {
    if (!await retire() || !await waitForUpdate() || !(await stop(root)).ok || !await closePanel()) return false;
    const shortcut = await migrateShortcut();
    if (!shortcut.ok) console.error(shortcut.error);
    return (await reconcile()).ok;
  }
  throw new Error("Unknown desktop lifecycle action");
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  try {
    const action = process.argv[2];
    if (INSTALL_ROOT) {
      process.env.ANYSWITCH_INSTALL_ROOT = INSTALL_ROOT;
      process.env.ANYSWITCH_APP_ROOT = APP_ROOT;
      process.env.ANYSWITCH_NODE_PATH = process.execPath;
    }
    process.exitCode = await runDesktopLifecycle(action) ? 0 : 1;
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
