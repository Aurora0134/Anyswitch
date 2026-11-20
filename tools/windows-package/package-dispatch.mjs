import { realpathSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export function resolveLauncher(appRoot, name) {
  if (typeof name !== "string" || !/^src(?:[/\\][a-z0-9_.-]+)+\.mjs$/i.test(name) || /(^|[/\\])\.\.(?:[/\\]|$)/.test(name)) {
    throw new Error("Invalid Anyswitch launcher path.");
  }
  const root = realpathSync(appRoot);
  const target = realpathSync(resolve(root, name.replace(/[/\\]/g, sep)));
  const rel = relative(root, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) throw new Error("Invalid Anyswitch launcher path.");
  return target;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] === self) {
  try {
    const appRoot = dirname(self);
    const versionRoot = dirname(appRoot);
    const installRoot = dirname(dirname(versionRoot));
    const [name, ...args] = process.argv.slice(2);
    const result = spawnSync(process.execPath, [resolveLauncher(appRoot, name), ...args], {
      stdio: "inherit",
      env: { ...process.env, ANYSWITCH_INSTALL_ROOT: installRoot, ANYSWITCH_APP_ROOT: appRoot, ANYSWITCH_APP_DIR: appRoot },
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
