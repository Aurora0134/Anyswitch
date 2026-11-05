// Desktop shortcut creation, via the WScript.Shell COM object from
// PowerShell.
//
// The .lnk chain is the documented panel entry (docs/architecture.md):
// Anyswitch.lnk → wscript.exe → panel-app.vbs → node panel-launcher.mjs.
// Until now that shortcut was created by hand outside the product; this
// module is what the panel's 创建快捷方式 button calls.
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// src/ops/ → 仓根：panel-app.vbs 与 anyswitch.ico 都在那里。
const APP_ROOT = join(__dirname, "..", "..");

const SHORTCUT_NAME = "Anyswitch.lnk";
const SHORTCUT_DESCRIPTION = "Anyswitch 控制面板";

// The full field set written into the .lnk. Exported so tests assert the
// wiring (wscript + panel-app.vbs + icon) without a real shell.
export function shortcutPayload() {
  return {
    name: SHORTCUT_NAME,
    description: SHORTCUT_DESCRIPTION,
    target: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe"),
    arguments: `"${join(APP_ROOT, "panel-app.vbs")}"`,
    icon: `${join(APP_ROOT, "anyswitch.ico")},0`,
    workingDirectory: APP_ROOT,
  };
}

// Same PowerShell boundary shape as autostart.mjs: windowless, stdin-fed,
// spawnFn injectable so tests never touch the real shell.
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
export async function createDesktopShortcut({ spawnFn = spawn } = {}) {
  if (process.platform !== "win32") {
    return { ok: false, error: "desktop shortcut is only supported on Windows" };
  }
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "$p = [Console]::In.ReadToEnd() | ConvertFrom-Json",
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop $p.name))",
    "$s.TargetPath = $p.target",
    "$s.Arguments = $p.arguments",
    "$s.IconLocation = $p.icon",
    "$s.WorkingDirectory = $p.workingDirectory",
    "$s.Description = $p.description",
    "$s.Save()",
    "'CREATED'",
  ].join("; ");
  return runPS(ps, JSON.stringify(shortcutPayload()), spawnFn);
}
