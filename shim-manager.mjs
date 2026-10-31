// Shim manager — codifies the previously hand-maintained
// ~/.config/anyswitch-bin shim convention so it can be installed and (above
// all) uninstalled from code. The convention as it exists on disk:
//   - layout: one directory per takeover command under the shim root —
//     bin-grok/, bin-claude/, bin-codex/, bin-opencode/, bin-pi/ — plus one
//     shared bin/ holding the auxiliary commands (dsh-cli, zcode, and the
//     retired agy). Every command is a triplet of same-named files: the
//     extensionless POSIX sh script (git-bash), the .cmd (cmd.exe) and the
//     .ps1 (PowerShell/pwsh).
//   - every shim body does exactly one thing: run node on the endpoint's
//     *-launcher.mjs under %LOCALAPPDATA%\Anyswitch\app, passing arguments
//     through. Shims never carry credentials, tokens or config.
//   - each shim directory sits on the per-user PATH (HKCU\Environment,
//     value "Path"); edits preserve the value's existing registry kind and
//     are followed by a WM_SETTINGCHANGE broadcast so new consoles see them.
//
// This is a pure library: importing it touches nothing. Every fs operation
// goes through the injected `fs` surface, every registry read/write through
// the injected `pathStore`, and the environment broadcast through the
// injected `broadcastFn` — production wiring is the factory's defaults, tests
// substitute temp directories and in-memory fakes. Nothing here activates
// itself.

import { spawn } from "node:child_process";
import {
  existsSync as realExistsSync,
  readFileSync as realReadFileSync,
  mkdirSync as realMkdirSync,
  readdirSync as realReaddirSync,
  renameSync as realRenameSync,
  rmSync as realRmSync,
  rmdirSync as realRmdirSync,
  writeFileSync as realWriteFileSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.mjs";

// ─────────────────────────────────────────────────────────────
// Shim registry
// ─────────────────────────────────────────────────────────────

export function shimRoot(base = process.env) {
  return join(base.USERPROFILE ?? "", ".config", "anyswitch-bin");
}

// One entry per shimmed command. `dir` is relative to the shim root.
// `launcher` is the app-side entry the shim execs; `launcherArgs` are fixed
// arguments placed BEFORE the user's own arguments (dsh-cli's profile
// selector). `extraFiles` names additional same-directory files that belong
// to the shim set and are removed with it (never generated here).
// `retired` marks commands whose launcher no longer ships (agy's
// antigravity-launcher.mjs is gone from the app): they can be removed but
// never (re)installed.
export const SHIM_SPECS = Object.freeze([
  { id: "grok", command: "grok", dir: "bin-grok", launcher: "grok-launcher.mjs" },
  { id: "claude", command: "claude", dir: "bin-claude", launcher: "launcher.mjs" },
  { id: "codex", command: "codex", dir: "bin-codex", launcher: "codex-launcher.mjs" },
  { id: "opencode", command: "opencode", dir: "bin-opencode", launcher: "opencode-launcher.mjs" },
  { id: "pi", command: "pi", dir: "bin-pi", launcher: "pi-launcher.mjs" },
  { id: "dsh", command: "dsh-cli", dir: "bin", launcher: "dsh-launcher.mjs", launcherArgs: ["--profile", "dsh-tui"] },
  { id: "zcode", command: "zcode", dir: "bin", launcher: "zcode-launcher.mjs", extraFiles: ["zcode-app.vbs"] },
  { id: "workbuddy", command: "workbuddy", dir: "bin-workbuddy", launcher: "workbuddy-launcher.mjs" },
  { id: "agy", command: "agy", dir: "bin", launcher: "antigravity-launcher.mjs", retired: true },
]);

export function findShimSpec(specOrId) {
  const spec = typeof specOrId === "string"
    ? SHIM_SPECS.find((entry) => entry.id === specOrId)
    : specOrId;
  if (!spec) throw new Error(`unknown shim spec: ${specOrId}`);
  return spec;
}

// ─────────────────────────────────────────────────────────────
// Shim script rendering (canonical triplet)
// ─────────────────────────────────────────────────────────────

// The canonical forms follow the bin-grok / bin-dsh-cli templates read from
// the live machine. Line endings are LF everywhere: cmd.exe runs these
// linear scripts fine (the production bin-grok/grok.cmd is LF), and LF keeps
// the sh variant byte-identical to what git-bash expects. All bodies are
// ASCII-only on purpose: cmd parses .cmd under the console code page and
// PowerShell 5.1 reads a BOM-less file as ANSI, so a non-ASCII byte here
// could mangle the statements (the dsh-cli shim comments say the same).
export function renderShimScripts(spec) {
  const args = spec.launcherArgs ?? [];
  const shArgs = args.length > 0 ? ` ${args.join(" ")}` : "";
  const launcherWin = `%LOCALAPPDATA%\\Anyswitch\\app\\${spec.launcher}`;
  return {
    sh: [
      "#!/bin/sh",
      'localappdata=$(cygpath -u "$LOCALAPPDATA" 2>/dev/null || echo "$LOCALAPPDATA")',
      `exec node "$localappdata/Anyswitch/app/${spec.launcher}"${shArgs} "$@"`,
      "",
    ].join("\n"),
    cmd: [
      "@ECHO off",
      "SETLOCAL",
      `node "${launcherWin}"${shArgs} %*`,
      "EXIT /b %ERRORLEVEL%",
      "",
    ].join("\n"),
    ps1: [
      "#!/usr/bin/env pwsh",
      `$launcher = Join-Path $env:LOCALAPPDATA 'Anyswitch\\app\\${spec.launcher}'`,
      "if ($MyInvocation.ExpectingInput) {",
      `  $input | & node $launcher${shArgs} @args`,
      "} else {",
      `  & node $launcher${shArgs} @args`,
      "}",
      "exit $LASTEXITCODE",
      "",
    ].join("\n"),
  };
}

/** The triplet's file names for a command: extensionless sh, .cmd, .ps1. */
export function shimFileNames(spec) {
  return [spec.command, `${spec.command}.cmd`, `${spec.command}.ps1`];
}

// ─────────────────────────────────────────────────────────────
// PATH value surgery (pure)
// ─────────────────────────────────────────────────────────────

// Entries compare case-insensitively with slashes unified and trailing
// separators stripped — "C:\x", "c:\x\" and "C:/x/" are the same PATH entry.
export function pathEntriesEqual(a, b) {
  const norm = (p) => String(p ?? "").trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export function splitPathValue(value) {
  return String(value ?? "")
    .split(";")
    .filter((entry) => entry.trim() !== "");
}

/**
 * Append `dir` at the END of a PATH value. A no-op (the original string
 * returned verbatim) when an equal entry already exists at any position —
 * the entry is never re-ordered.
 */
export function appendPathEntry(value, dir) {
  const entries = splitPathValue(value);
  if (entries.some((entry) => pathEntriesEqual(entry, dir))) {
    return { value: String(value ?? ""), changed: false };
  }
  return { value: [...entries, dir].join(";"), changed: true };
}

/** Remove every entry equal to `dir`. Others pass through byte-for-byte. */
export function removePathEntry(value, dir) {
  const entries = splitPathValue(value);
  const kept = entries.filter((entry) => !pathEntriesEqual(entry, dir));
  if (kept.length === entries.length) {
    return { value: String(value ?? ""), changed: false };
  }
  return { value: kept.join(";"), changed: true };
}

// ─────────────────────────────────────────────────────────────
// Production registry PATH store + environment broadcast
// ─────────────────────────────────────────────────────────────

function runProcess(file, args, { spawnFn = spawn, timeoutMs = 30000, env } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnFn(file, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        ...(env ? { env } : {}),
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    // Buffers, not += strings: a multi-byte UTF-8 sequence split across
    // chunks must not corrupt (PATH values can carry non-ASCII user names).
    const outChunks = [];
    const errChunks = [];
    child.stdout?.on("data", (c) => outChunks.push(c));
    child.stderr?.on("data", (c) => errChunks.push(c));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      rejectPromise(new Error(`${file} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(outChunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const error = new Error(stderr.trim() || `${file} exited ${code}`);
      error.exitCode = code;
      rejectPromise(error);
    });
  });
}

function runPowerShell(script, { spawnFn = spawn, powershellExe = "powershell.exe", timeoutMs = 30000, env } = {}) {
  return runProcess(powershellExe, ["-NoProfile", "-NonInteractive", "-Command", script], { spawnFn, timeoutMs, env });
}

// Registry access goes through PowerShell's Microsoft.Win32 API rather than
// reg.exe: reg add mangles values containing ';' or '%' and always rewrites
// the kind, while the Win32 API reads without expanding REG_EXPAND_SZ
// (DoNotExpandEnvironmentNames) and writes back with the value's EXISTING
// kind. The PATH value itself never travels on the command line (quoting and
// length limits); it rides the child process's environment.
/**
 * The production HKCU\Environment "Path" store: { read, write }.
 * read() resolves to the raw (unexpanded) value, or null when the value or
 * key does not exist. write() preserves the existing value kind, defaulting
 * to REG_EXPAND_SZ for a fresh value.
 */
export function createRegistryPathStore({ spawnFn = spawn, powershellExe, timeoutMs } = {}) {
  const READ_SCRIPT = [
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)",
    "if ($null -eq $key) { exit 3 }",
    "$v = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "if ($null -eq $v) { exit 3 }",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "[Console]::Write([string]$v)",
  ].join("\n");
  const WRITE_SCRIPT = [
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
    "if ($null -eq $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }",
    "$kind = [Microsoft.Win32.RegistryValueKind]::ExpandString",
    "if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }",
    "$key.SetValue('Path', $env:ANYSWITCH_PATH_VALUE, $kind)",
    "$key.Close()",
  ].join("\n");
  return {
    async read() {
      try {
        const { stdout } = await runPowerShell(READ_SCRIPT, { spawnFn, powershellExe, timeoutMs });
        return stdout;
      } catch (error) {
        // exit 3 = value or key absent (scripted sentinel, not a failure)
        if (error?.exitCode === 3) return null;
        throw error;
      }
    },
    async write(value, { env = process.env } = {}) {
      await runPowerShell(WRITE_SCRIPT, {
        spawnFn,
        powershellExe,
        timeoutMs,
        env: { ...env, ANYSWITCH_PATH_VALUE: String(value) },
      });
    },
  };
}

// WM_SETTINGCHANGE broadcast with lParam "Environment": what
// SystemPropertiesAdvanced.exe does after an environment edit, so consoles
// started afterwards inherit the new PATH. HWND_BROADCAST = 0xffff,
// SMTO_ABORTIFHUNG = 2, five-second timeout per window.
const BROADCAST_SCRIPT = [
  'Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition \'[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);\'',
  "$result = [System.UIntPtr]::Zero",
  "[void][Win32.NativeMethods]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)",
].join("\n");

/** Broadcast the environment-change notification. Throws on failure. */
export function createEnvironmentBroadcaster({ spawnFn = spawn, powershellExe, timeoutMs } = {}) {
  return async function broadcastEnvironmentChange() {
    await runPowerShell(BROADCAST_SCRIPT, { spawnFn, powershellExe, timeoutMs });
  };
}

// ─────────────────────────────────────────────────────────────
// Manager
// ─────────────────────────────────────────────────────────────

const defaultFs = {
  existsSync: realExistsSync,
  readFileSync: realReadFileSync,
  mkdirSync: realMkdirSync,
  readdirSync: realReaddirSync,
  renameSync: realRenameSync,
  rmSync: realRmSync,
  rmdirSync: realRmdirSync,
  writeFileSync: realWriteFileSync,
};

/**
 * The shim manager. All methods are no-throw-unless-real-failure operations
 * against the injected surfaces; importing the module alone does nothing.
 *
 * @param {object} deps
 * @param {object} deps.env process-env style base (USERPROFILE drives the root)
 * @param {object} deps.fs  fs surface (atomicWriteFile-compatible)
 * @param {object} deps.pathStore { read(): Promise<string|null>, write(v): Promise<void> }
 * @param {Function} deps.broadcastFn () => Promise<void>
 */
export function createShimManager({
  env = process.env,
  fs = defaultFs,
  pathStore = createRegistryPathStore(),
  broadcastFn = createEnvironmentBroadcaster(),
} = {}) {
  const root = shimRoot(env);
  const dirFor = (spec) => join(root, spec.dir);

  /** Rendered triplet as { [fileName]: text } for a spec. */
  function renderSpec(specOrId) {
    const spec = findShimSpec(specOrId);
    const scripts = renderShimScripts(spec);
    const names = shimFileNames(spec);
    return { [names[0]]: scripts.sh, [names[1]]: scripts.cmd, [names[2]]: scripts.ps1 };
  }

  /**
   * Write the triplet. Idempotent: files whose bytes already match are left
   * untouched. Retired specs are refused (their launcher no longer exists).
   * Returns { ok, dir, written, unchanged }.
   */
  function installShim(specOrId) {
    const spec = findShimSpec(specOrId);
    if (spec.retired) throw new Error(`shim "${spec.id}" is retired and cannot be installed`);
    const dir = dirFor(spec);
    const files = renderSpec(spec);
    const written = [];
    const unchanged = [];
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      const target = join(dir, name);
      if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === text) {
        unchanged.push(target);
        continue;
      }
      atomicWriteFile(target, text, { fs });
      written.push(target);
    }
    return { ok: true, dir, written, unchanged };
  }

  /**
   * Remove the triplet (and any spec extraFiles) from disk, then the shim
   * directory itself when — and only when — nothing else remains in it.
   * Foreign files in a shim directory are never touched, and a non-empty
   * directory is never removed. Returns { ok, dir, removed, dirRemoved }.
   */
  function removeShim(specOrId) {
    const spec = findShimSpec(specOrId);
    const dir = dirFor(spec);
    const removed = [];
    if (fs.existsSync(dir)) {
      for (const name of [...shimFileNames(spec), ...(spec.extraFiles ?? [])]) {
        const target = join(dir, name);
        if (!fs.existsSync(target)) continue;
        fs.rmSync(target, { force: true });
        removed.push(target);
      }
    }
    let dirRemoved = false;
    if (fs.existsSync(dir)) {
      let remaining = [];
      try {
        remaining = fs.readdirSync(dir);
      } catch {
        remaining = ["<unreadable>"];
      }
      if (remaining.length === 0) {
        fs.rmdirSync(dir);
        dirRemoved = true;
      }
    }
    return { ok: true, dir, removed, dirRemoved };
  }

  /** Append the directory to the user PATH. { changed }. */
  async function addShimToPath(specOrId) {
    const spec = findShimSpec(specOrId);
    const current = await pathStore.read();
    const next = appendPathEntry(current ?? "", dirFor(spec));
    if (next.changed) await pathStore.write(next.value);
    return { changed: next.changed, value: next.value };
  }

  /** Remove the directory from the user PATH (all matching entries). */
  async function removeShimFromPath(specOrId) {
    const spec = findShimSpec(specOrId);
    const current = await pathStore.read();
    if (current === null) return { changed: false, value: null };
    const next = removePathEntry(current, dirFor(spec));
    if (next.changed) await pathStore.write(next.value);
    return { changed: next.changed, value: next.value };
  }

  /**
   * The uninstall composition: remove the files, then drop the PATH entry
   * exactly when the shim directory no longer exists afterwards (removed by
   * us, or never there). A directory that survives — foreign files, or the
   * shared bin/ still holding other commands — keeps its PATH entry, so a
   * partial uninstall never strands the remaining shims.
   */
  async function retireShim(specOrId) {
    const removed = removeShim(specOrId);
    let path = { changed: false, value: null };
    if (!fs.existsSync(removed.dir)) {
      path = await removeShimFromPath(specOrId);
    }
    return { ok: true, ...removed, path };
  }

  async function broadcastEnvironmentChange() {
    await broadcastFn();
  }

  return {
    root,
    renderSpec,
    installShim,
    removeShim,
    addShimToPath,
    removeShimFromPath,
    retireShim,
    broadcastEnvironmentChange,
  };
}
