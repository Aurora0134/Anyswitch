import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";

export const TERMINAL_HOST_PORT = 47823;
const TERMINAL_HOST_SCRIPT = fileURLToPath(new URL("./terminal-host.mjs", import.meta.url));

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

function probe(port = TERMINAL_HOST_PORT, token = null) {
  return fetch(`http://127.0.0.1:${port}/terminal/sessions`, { headers: { authorization: `Bearer ${token || ""}` } })
    .then((response) => response.ok)
    .catch(() => false);
}

export async function ensureTerminalHost(root, { spawnFn = spawn, port = TERMINAL_HOST_PORT, logger = console } = {}) {
  const token = loadOrGenerateToken(root);
  if (await probe(port, token)) return { ok: true, reused: true, pid: readPid(getTerminalHostPidPath(root)), port };
  const child = spawnFn(process.execPath, [TERMINAL_HOST_SCRIPT], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  if (child.pid) writeFileSync(getTerminalHostPidPath(root), String(child.pid), "utf8");
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await probe(port, token)) return { ok: true, reused: false, pid: child.pid ?? null, port };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  logger.warn?.("terminal host did not become ready");
  return { ok: false, reused: false, pid: child.pid ?? null, port };
}
