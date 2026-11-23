import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { findPortOwnerPid, getProcessCommandLineAsync, isPidAlive } from "../relay/relay-process-manager.mjs";
import { relayDataRoot } from "../relay/relay-settings.mjs";
import { removeWatchdogTasks } from "./autostart.mjs";

function getPid(path) {
  try { return Number(readFileSync(path, "utf8").trim()); } catch { return null; }
}

export function isRetiredWatchdogCommand(command, dataRoot, installRoot) {
  const tokens = String(command ?? "").match(/"[^"]+"|[^\s]+/g) ?? [];
  const normalize = (s) => s.replace(/^"|"$/g, "").replaceAll("/", "\\").toLowerCase();
  const script = normalize(tokens[1] ?? "");
  for (const dir of [join(dataRoot, "app"), join(dataRoot, "..", "ApiCred", "app")]) {
    const prefix = normalize(dir);
    if (script === `${prefix}\\agent-watchdog.mjs` || script === `${prefix}\\src\\agents\\agent-watchdog.mjs`) return true;
  }
  const versions = installRoot && normalize(join(installRoot, "versions")) + "\\";
  return !!versions && script.startsWith(versions) && /^[\w.+-]+\\app\\(?:src\\agents\\)?agent-watchdog\.mjs$/.test(script.slice(versions.length));
}

export async function retireAgentWatchdog({
  dataRoot = relayDataRoot(), installRoot = process.env.ANYSWITCH_INSTALL_ROOT,
  removeTasks = removeWatchdogTasks, findOwner = findPortOwnerPid.uncached,
  readPid = getPid, isAlive = isPidAlive, commandLine = getProcessCommandLineAsync,
  kill = (pid) => process.kill(pid), clearPid = unlinkSync, sleep = wait,
} = {}) {
  if (process.platform !== "win32") return true;
  if (!await removeTasks()) return false;
  const path = join(dataRoot, "watchdog.pid");
  const candidates = [readPid(path), await findOwner(47822)];
  for (const pid of new Set(candidates)) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !isAlive(pid)) continue;
    if (!isRetiredWatchdogCommand(await commandLine(pid), dataRoot, installRoot)) continue;
    try { kill(pid); } catch (error) { if (error.code !== "ESRCH") return false; }
    for (let attempt = 0; attempt < 20 && isAlive(pid); attempt++) await sleep(100);
    if (isAlive(pid)) return false;
  }
  try { clearPid(path); } catch (error) { if (error.code !== "ENOENT") return false; }
  return true;
}
