// Desktop shortcut creation, via the WScript.Shell COM object from
// PowerShell.
//
// Desktop installs target Anyswitch.exe. Source installs retain panel-app.vbs.
//
// Field values travel over stdin as JSON so no path- or quote-sensitive
// string ever reaches the command line (same contract as autostart.mjs).
// The desktop directory is resolved inside PowerShell via
// [Environment]::GetFolderPath('Desktop'), which follows OneDrive folder
// redirection — %USERPROFILE%\Desktop would not.
//
// CreateShortcut on an existing .lnk path opens and overwrites it, so
// clicking the button again repairs a stale shortcut (moved tree, changed
// icon) for free. No startup reconcile is needed: the install directory is
// fixed and self-update swaps the tree in place, so a written .lnk keeps
// pointing at live code.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCurrentPointer, resolveInstallRoot } from "./update-trust.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// src/ops/ → 仓根：panel-app.vbs 与 anyswitch.ico 都在那里。
const APP_ROOT = join(__dirname, "..", "..");

const SHORTCUT_NAME = "Anyswitch.lnk";
const SHORTCUT_DESCRIPTION = "Anyswitch 控制面板";

// The full field set written into the .lnk. Exported so tests assert the
// wiring (wscript + panel-app.vbs + icon) without a real shell.
// 本进程的打包安装根（分发器注入的 ANYSWITCH_* 推导；源码安装 null）。
function detectInstallRoot(env = process.env) {
  try {
    const appRoot = env.ANYSWITCH_APP_ROOT ?? env.ANYSWITCH_APP_DIR;
    return resolveInstallRoot({ appRoot, env }) ?? null;
  } catch {
    return null;
  }
}

export function shortcutPayload({ installRoot = detectInstallRoot(), currentVersion = null } = {}) {
  const wscript = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
  if (installRoot) {
    const exe = join(installRoot, "Anyswitch.exe");
    if (existsSync(exe)) return {
      name: SHORTCUT_NAME, description: SHORTCUT_DESCRIPTION, target: exe,
      arguments: "", icon: `${exe},0`, workingDirectory: installRoot,
    };
    // 打包安装：快捷方式指安装根的静默分发器（隐藏控制台、打开面板）。分发
    // 器每次运行读 current.json，自更新换代后快捷方式仍指活动版本——target
    // 不需要重写。icon 优先指安装根的 anyswitch.ico（安装器 [Files] 摆放的
    // 稳定副本：换版本不动、清旧版本不失效——2026-11-20 用户裁决，图标要
    // 跨版本连续）；根副本缺失时回落活动版本 app 内的 ico。
    let version = typeof currentVersion === "string" && currentVersion ? currentVersion : null;
    if (!version) {
      try {
        version = parseCurrentPointer(readFileSync(join(installRoot, "current.json"), "utf8")).version;
      } catch {
        version = null; // 指针读不出（首装前/损坏）：回落源码形态，按钮可再修
      }
    }
    if (version) {
      // 根副本在盘（安装器 [Files] 落点）即指根副本；缺失时回落版本内 ico。
      const rootIcon = join(installRoot, "anyswitch.ico");
      const iconPath = existsSync(rootIcon) ? rootIcon : join(installRoot, "versions", version, "app", "anyswitch.ico");
      return {
        name: SHORTCUT_NAME,
        description: SHORTCUT_DESCRIPTION,
        target: wscript,
        arguments: `"${join(installRoot, "anyswitch-silent.vbs")}" "src\\panel\\panel-launcher.mjs"`,
        icon: `${iconPath},0`,
        workingDirectory: installRoot,
      };
    }
  }
  return {
    name: SHORTCUT_NAME,
    description: SHORTCUT_DESCRIPTION,
    target: wscript,
    arguments: `"${join(APP_ROOT, "panel-app.vbs")}"`,
    icon: `${join(APP_ROOT, "anyswitch.ico")},0`,
    workingDirectory: APP_ROOT,
  };
}

// Same PowerShell boundary shape as autostart.mjs: windowless, stdin-fed,
// spawnFn injectable so tests never touch the real shell.
//
// node writes the JSON payload as UTF-8 bytes, but PowerShell decodes
// [Console]::In with the console input code page (GBK on zh-CN machines)
// unless the script pins it — the Chinese SHORTCUT_DESCRIPTION and any
// non-ASCII install path would be mangled before the .lnk was written.
// OutputEncoding is pinned too, keeping the boundary symmetric with
// autostart.mjs.
const PS_CONSOLE_UTF8 =
  "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)";

function runPS(script, stdin, spawnFn = spawn) {
  return new Promise((resolve) => {
    const child = spawnFn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, stdout });
      else resolve({ ok: false, error: stderr.trim() || `powershell exited ${code}` });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

// Create (or overwrite) Anyswitch.lnk on the user's desktop. Idempotent.
export function createDesktopShortcut({ spawnFn = spawn } = {}) {
  return writeShortcut(shortcutPayload(), { spawnFn });
}

export function migrateDesktopShortcut({ installRoot, sourceRoots = [], linkPath } = {}) {
  if (!installRoot || !existsSync(join(installRoot, "Anyswitch.exe"))) return Promise.resolve({ ok: true });
  const target = shortcutPayload({ installRoot });
  const packagedShim = join(installRoot, "anyswitch-silent.vbs");
  const wscript = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
  const oldArguments = [`"${packagedShim}" "src\\panel\\panel-launcher.mjs"`, ...sourceRoots.map((root) => `"${join(root, "panel-app.vbs")}"`)];
  return writeShortcut(target, { migration: { wscript, oldArguments, linkPath } });
}

async function writeShortcut(payload, { spawnFn = spawn, migration } = {}) {
  if (process.platform !== "win32") {
    return { ok: false, error: "desktop shortcut is only supported on Windows" };
  }
  const ps = [
    PS_CONSOLE_UTF8,
    "$ErrorActionPreference = 'Stop'",
    "$p = [Console]::In.ReadToEnd() | ConvertFrom-Json",
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    "$link = Join-Path $desktop $p.name",
    "if ($p.migration.linkPath) { $link = $p.migration.linkPath }",
    "if ($p.migration -and -not (Test-Path -LiteralPath $link -PathType Leaf)) { return }",
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($link)",
    "if ($p.migration -and ($s.TargetPath -ine $p.migration.wscript -or $s.Arguments -inotIn $p.migration.oldArguments)) { return }",
    "$s.TargetPath = $p.target",
    "$s.Arguments = $p.arguments",
    "$s.IconLocation = $p.icon",
    "$s.WorkingDirectory = $p.workingDirectory",
    "$s.Description = $p.description",
    "$s.Save()",
    "'CREATED'",
  ].join("; ");
  return runPS(ps, JSON.stringify({ ...payload, migration }), spawnFn);
}
