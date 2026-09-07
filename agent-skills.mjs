// Agent skills deployment: one git-backed master repo as the single source of
// truth, NTFS junctions projecting individual skill directories into each
// agent's skills directory.
//
// Key platform facts (verified during research, do not "fix"):
//   - Junctions are created with `cmd /c mklink /J "<link>" "<target>"` and
//     need no elevation. In Node, a junction's lstat().isSymbolicLink() is
//     true and fs.readlink() returns its target (sometimes `\\?\`-prefixed).
//   - Deleting a junction with fs.rmdir() removes ONLY the link, never the
//     target. Recursive rm on a junction would empty the target — forbidden.
//   - Recycle-bin deletion goes through PowerShell + VisualBasic FileIO
//     (SendToRecycleBin). If it fails we abort with an error; we never fall
//     back to a hard delete.
//   - Deployment state is derived from the filesystem on every read; only
//     { repoPath } is persisted (skills.json next to settings.json).

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { atomicWriteFile } from "./atomic-write.mjs";
import { relayDataRoot } from "./relay-settings.mjs";

// Endpoint registry. `relSkillsDir` is relative to the user's home directory.
export const ENDPOINT_DEFS = Object.freeze([
  { id: "claude", label: "Claude Code", relSkillsDir: [".claude", "skills"] },
  { id: "zcode", label: "ZCode", relSkillsDir: [".zcode", "skills"] },
  { id: "opencode", label: "OpenCode", relSkillsDir: [".config", "opencode", "skills"] },
  { id: "pi", label: "Pi", relSkillsDir: [".pi", "agent", "skills"] },
  { id: "kimi", label: "Kimi Code", relSkillsDir: [".kimi-code", "skills"] },
  { id: "dsh", label: "DSH", relSkillsDir: [".dsh", "skills"] },
  { id: "reasonix", label: "Reasonix", relSkillsDir: [".reasonix", "skills"] },
  { id: "qoder", label: "Qoder", relSkillsDir: [".qoder", "skills"] },
]);

// Repo-path candidates the panel offers as one-click choices.
// The ANYSWITCH_SKILLS_REPO environment variable (absolute path) is offered
// first; the entries below are home-relative common locations.
const REPO_CANDIDATES = Object.freeze([
  [".agents", "skills"],
]);

const SCAN_MAX_DEPTH = 4;
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** Resolve the endpoint list for a given home directory. */
export function listEndpoints(homeDir = homedir()) {
  return ENDPOINT_DEFS.map((def) => ({
    id: def.id,
    label: def.label,
    enabled: def.enabled !== false,
    skillsDir: join(homeDir, ...def.relSkillsDir),
  }));
}

function findEndpoint(endpointId, homeDir) {
  return listEndpoints(homeDir).find((e) => e.id === endpointId) ?? null;
}

// ─────────────────────────────────────────────────────────────
// SKILL.md frontmatter (hand-rolled, zero dependency)
// ─────────────────────────────────────────────────────────────

/**
 * Parse the YAML frontmatter of a SKILL.md into a flat key->string map.
 * Supports `key: value`, single/double-quoted values, and `|` / `>` block
 * scalars. Unknown extra fields (trigger_words, compatibility, metadata…)
 * are tolerated; nested maps collapse to their parent key and are ignored.
 */
export function parseSkillFrontmatter(text) {
  const fields = {};
  if (typeof text !== "string") return fields;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return fields;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end === -1) return fields;
  const body = lines.slice(1, end);
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    if (/^\s/.test(line)) continue; // continuation / nested lines handled below
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (value === "|" || value === ">") {
      // Block scalar: collect following more-indented lines.
      const block = [];
      for (let j = i + 1; j < body.length; j++) {
        const bl = body[j];
        if (bl.trim() === "") { block.push(""); i = j; continue; }
        if (/^\s+\S/.test(bl)) { block.push(bl.trim()); i = j; continue; }
        break;
      }
      value = (m[2].trim() === ">" ? block.join(" ") : block.join("\n")).trim();
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return fields;
}

// ─────────────────────────────────────────────────────────────
// Repo scan
// ─────────────────────────────────────────────────────────────

/**
 * Recursively discover skill directories (those containing SKILL.md) under
 * `repoPath`, up to SCAN_MAX_DEPTH levels deep, skipping .git/node_modules.
 * Container directories (e.g. animate-skills/, skills/) are traversed, so
 * second-level skills are found. Returns [] for a missing/unreadable repo.
 */
export function scanRepo(repoPath) {
  const skills = [];
  if (!repoPath || !existsSync(repoPath)) return skills;
  walk(repoPath, 0);
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return skills;

  function walk(dir, depth) {
    if (depth > SCAN_MAX_DEPTH) return;
    const skillFile = join(dir, "SKILL.md");
    if (depth > 0 && existsSync(skillFile)) {
      let fm = {};
      try {
        fm = parseSkillFrontmatter(readFileSync(skillFile, "utf8"));
      } catch {
        /* unreadable SKILL.md: fall back to directory name */
      }
      skills.push({
        name: fm.name || basename(dir),
        dirName: basename(dir),
        relPath: relative(repoPath, dir),
        description: fm.description || "",
        absPath: dir,
      });
      return; // a skill directory is a leaf; nothing nested inside it
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Content hashing / diffing
// ─────────────────────────────────────────────────────────────

// List all files under `dir` as POSIX-style relative paths (sorted by caller),
// skipping .git/node_modules. Symlinked entries are recorded as "link:<target>".
function listFiles(dir, prefix = "", out = new Map()) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      listFiles(join(dir, entry.name), rel, out);
    } else if (entry.isSymbolicLink()) {
      let target = "";
      try { target = readlinkSync(join(dir, entry.name)); } catch { /* dangling */ }
      out.set(rel, `link:${target}`);
    } else if (entry.isFile()) {
      out.set(rel, null);
    }
  }
  return out;
}

function fileDigest(path) {
  return createHash("md5").update(readFileSync(path)).digest("hex");
}

/**
 * Order-independent content hash of a directory tree: sorted relative paths
 * plus per-file md5. Two directories with identical content hash equal even
 * if file mtimes/order differ. .git/node_modules are excluded.
 */
export function hashDir(dir) {
  const files = listFiles(dir);
  const hash = createHash("md5");
  for (const rel of [...files.keys()].sort()) {
    hash.update(rel);
    hash.update("\0");
    const marker = files.get(rel);
    hash.update(marker ?? fileDigest(join(dir, ...rel.split("/"))));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Structural diff between two directory trees. Returns a sorted list of
 * { path, kind } where kind is "only-a" | "only-b" | "different".
 */
export function diffDirs(dirA, dirB) {
  const filesA = listFiles(dirA);
  const filesB = listFiles(dirB);
  const diffs = [];
  const all = new Set([...filesA.keys(), ...filesB.keys()]);
  for (const rel of [...all].sort()) {
    const inA = filesA.has(rel);
    const inB = filesB.has(rel);
    if (inA && !inB) { diffs.push({ path: rel, kind: "only-a" }); continue; }
    if (!inA && inB) { diffs.push({ path: rel, kind: "only-b" }); continue; }
    const markerA = filesA.get(rel);
    const markerB = filesB.get(rel);
    const digestA = markerA ?? fileDigest(join(dirA, ...rel.split("/")));
    const digestB = markerB ?? fileDigest(join(dirB, ...rel.split("/")));
    if (digestA !== digestB) diffs.push({ path: rel, kind: "different" });
  }
  return diffs;
}

// ─────────────────────────────────────────────────────────────
// Junction helpers
// ─────────────────────────────────────────────────────────────

// Normalize a junction target for comparison: strip the `\\?\` prefix
// readlink may return and compare case-insensitively (Windows paths).
function normalizePath(p) {
  if (!p) return "";
  let out = String(p);
  if (out.startsWith("\\\\?\\")) out = out.slice(4);
  return resolve(out).toLowerCase();
}

function isJunction(absPath) {
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function junctionTarget(absPath) {
  try {
    return readlinkSync(absPath);
  } catch {
    return null;
  }
}

function lexists(absPath) {
  try {
    lstatSync(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create an NTFS junction `link` -> `target` via cmd's mklink (no elevation
 * needed). Throws on any failure; never silently falls back to copying.
 */
export function createJunction(link, target) {
  // shell:true routes through cmd.exe (mklink is a cmd builtin, not an exe).
  // Passing the whole command as one string lets libuv apply cmd-compatible
  // quoting; an argv array would get MSVCRT-escaped quotes that cmd misreads
  // ("文件名、目录名或卷标语法不正确").
  const result = spawnSync(`mklink /J "${link}" "${target}"`, {
    shell: true,
    windowsHide: true,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`mklink failed (${result.status}): ${(result.stderr || result.stdout || "").trim()}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Endpoint scan
// ─────────────────────────────────────────────────────────────

/**
 * Scan every registered endpoint's skills directory. Each endpoint reports
 * { id, label, enabled, dirExists, entries } where an entry is:
 *   { name, kind: "junction"|"local", linkTarget, broken, matchesRepo, repoSkill }
 * - junction: linkTarget from readlink; broken when the target no longer
 *   exists; repoSkill = dirName of the repo skill it points into (or null).
 * - local: a real directory; matchesRepo compares content hash against the
 *   same-named repo skill (true/false, or null when the repo has no such
 *   skill — or no repo is configured).
 */
export function scanEndpoints(repoPath, { homeDir = homedir() } = {}) {
  const repoSkills = repoPath ? scanRepo(repoPath) : [];
  const byDirName = new Map(repoSkills.map((s) => [s.dirName, s]));
  const repoAbs = new Map(repoSkills.map((s) => [normalizePath(s.absPath), s.dirName]));
  return listEndpoints(homeDir).map((endpoint) => {
    const result = { ...endpoint, dirExists: false, entries: [] };
    if (!existsSync(endpoint.skillsDir) || isJunction(endpoint.skillsDir)) return result;
    result.dirExists = true;
    let entries;
    try {
      entries = readdirSync(endpoint.skillsDir, { withFileTypes: true });
    } catch {
      return result;
    }
    for (const entry of entries) {
      // VCS metadata and other non-skill dot entries are not manageable skills
      // (e.g. the opencode skills dir is itself a git repo — its .git showed
      // up as a bogus "local skill" entry).
      if (entry.name.startsWith(".")) continue;
      const abs = join(endpoint.skillsDir, entry.name);
      if (entry.isSymbolicLink()) {
        const linkTarget = junctionTarget(abs);
        const normalized = normalizePath(linkTarget);
        result.entries.push({
          name: entry.name,
          kind: "junction",
          linkTarget,
          broken: linkTarget ? !existsSync(linkTarget) : true,
          matchesRepo: null,
          repoSkill: repoAbs.get(normalized) ?? null,
        });
      } else if (entry.isDirectory()) {
        const repoSkill = byDirName.get(entry.name) ?? null;
        let matchesRepo = null;
        if (repoSkill) {
          try {
            matchesRepo = hashDir(abs) === hashDir(repoSkill.absPath);
          } catch {
            matchesRepo = null;
          }
        }
        result.entries.push({
          name: entry.name,
          kind: "local",
          linkTarget: null,
          broken: false,
          matchesRepo,
          repoSkill: repoSkill?.dirName ?? null,
        });
      }
      // plain files in a skills directory are not skills; ignore them
    }
    result.entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return result;
  });
}

// ─────────────────────────────────────────────────────────────
// Recycle bin + native folder picker (PowerShell subprocesses)
// ─────────────────────────────────────────────────────────────

function runPowerShell(script, { spawnFn = spawn, timeoutMs = 30000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnFn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      rejectPromise(new Error(`powershell timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(stderr.trim() || `powershell exited ${code}`));
    });
  });
}

/**
 * Send a directory to the Windows Recycle Bin via VisualBasic FileIO.
 * Throws on failure — there is deliberately NO hard-delete fallback, because
 * a silent downgrade would destroy data the user expected to be recoverable.
 */
export async function recycleDir(absPath, { spawnFn = spawn } = {}) {
  const psPath = String(absPath).replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${psPath}', 'OnlyErrorDialogs', 'SendToRecycleBin')`,
  ].join("; ");
  await runPowerShell(script, { spawnFn });
}

// C# wrapper around the modern IFileOpenDialog. Folder mode adds
// FOS_PICKFOLDERS (OK only accepts folders); file mode is the plain
// open-file dialog (OK only accepts files) — the stock dialog cannot take
// "a folder OR a file" in one box, hence the two separate import buttons.
// The vtable order below matches IModalWindow + IFileDialog exactly;
// trailing IFileOpenDialog methods are unneeded (never called past GetResult).
const FOLDER_PICKER_CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;

public static class AnySwitchFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  private class FileOpenDialog { }

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder([MarshalAs(UnmanagedType.Interface)] object psi);
    void SetFolder([MarshalAs(UnmanagedType.Interface)] object psi);
    void GetFolder([MarshalAs(UnmanagedType.Interface)] out object ppsi);
    void GetCurrentSelection([MarshalAs(UnmanagedType.Interface)] out object ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult([MarshalAs(UnmanagedType.Interface)] out object ppsi);
    void AddPlace([MarshalAs(UnmanagedType.Interface)] object psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter([MarshalAs(UnmanagedType.Interface)] object pFilter);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent([MarshalAs(UnmanagedType.Interface)] out object ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare([MarshalAs(UnmanagedType.Interface)] object psi, uint hint, out int piOrder);
  }

  private const uint FOS_PICKFOLDERS = 0x20;
  private const uint FOS_FORCEFILESYSTEM = 0x40;
  private const uint SIGDN_FILESYSPATH = 0x80058000;
  private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  // Returns the chosen path, or null when the user cancels. pickFolders
  // toggles FOS_PICKFOLDERS (folder selection, OK only accepts folders);
  // without it this is a plain file-open dialog (OK only accepts files).
  // The stock dialog cannot accept "a folder OR a file" in one box, so the
  // import flow uses file mode and asks for SKILL.md / .zip instead.
  public static string Pick(string title, bool pickFolders) {
    var dlg = (IFileDialog)(object)new FileOpenDialog();
    uint options;
    dlg.GetOptions(out options);
    uint flags = options | FOS_FORCEFILESYSTEM;
    if (pickFolders) flags |= FOS_PICKFOLDERS;
    dlg.SetOptions(flags);
    dlg.SetTitle(title);
    // Owner the dialog to the foreground window (the browser, at click time).
    // Without an owner the dialog can surface UNDER the browser and, as an
    // ownerless top-level window, earns its own taskbar button showing the
    // host process icon.
    int hr = dlg.Show(GetForegroundWindow());
    if (hr == ERROR_CANCELLED) return null;
    if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    object resultObj;
    dlg.GetResult(out resultObj);
    var item = (IShellItem)resultObj;
    string path;
    item.GetDisplayName(SIGDN_FILESYSPATH, out path);
    return path;
  }

  // Standalone-exe entry point. Idle (never invoked) under the PowerShell
  // Add-Type path; used by the pre-compiled helper exe. Emits the same
  // stdout protocol as the PowerShell chain: PICKED:<path> / CANCELLED.
  // argv[0] "--file" switches to file-picking mode; the following argv
  // entry optionally overrides the dialog title.
  [STAThread]
  public static int Main(string[] args) {
    try {
      Console.OutputEncoding = System.Text.Encoding.UTF8;
    } catch { /* encoding is best-effort; a pipe always accepts the default */ }
    try {
      bool pickFile = args.Length > 0 && args[0] == "--file";
      int titleIdx = pickFile ? 1 : 0;
      var title = args.Length > titleIdx && args[titleIdx].Length > 0
        ? args[titleIdx]
        : "选择 Skills 主仓库目录";
      var path = Pick(title, !pickFile);
      if (path == null) Console.WriteLine("CANCELLED");
      else Console.WriteLine("PICKED:" + path);
      return 0;
    } catch (Exception ex) {
      Console.Error.WriteLine(ex.Message);
      return 1;
    }
  }
}
`;

// On-disk form of the source: UTF-8 BOM so csc.exe decodes the non-ASCII
// dialog title correctly regardless of the system ANSI codepage.
const FOLDER_PICKER_CSHARP_FILE = "﻿" + FOLDER_PICKER_CSHARP;

// Spawn a helper process and collect its stdout/stderr. Rejects on spawn
// error, non-zero exit, or timeout.
function runProcess(file, args, { spawnFn = spawn, timeoutMs = 120000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnFn(file, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
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
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(stderr.trim() || `${file} exited ${code}`));
    });
  });
}

/**
 * Resolve the pre-compiled folder-picker helper exe, (re)building it when
 * missing or when the C# source has changed. Compiling once up front avoids
 * paying PowerShell startup + CLR + Add-Type JIT on every click.
 * Throws when no csc.exe is found or compilation fails — callers fall back
 * to the PowerShell chain.
 */
export async function ensureFolderPickerHelper({ spawnFn = spawn, base = process.env } = {}) {
  const binDir = join(relayDataRoot(base), "bin");
  const srcPath = join(binDir, "folder-picker.cs");
  const exePath = join(binDir, "folder-picker.exe");
  if (
    existsSync(exePath) &&
    existsSync(srcPath) &&
    readFileSync(srcPath, "utf8") === FOLDER_PICKER_CSHARP_FILE
  ) {
    return exePath;
  }
  mkdirSync(binDir, { recursive: true });
  atomicWriteFile(srcPath, FOLDER_PICKER_CSHARP_FILE);
  const windir = base.WINDIR || base.SystemRoot || "C:\\Windows";
  const csc = [
    join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ].find((candidate) => existsSync(candidate));
  if (!csc) throw new Error(`csc.exe not found under ${windir}\\Microsoft.NET`);
  const { stdout, stderr } = await runProcess(
    csc,
    ["/target:winexe", "/nologo", `/out:${exePath}`, srcPath],
    { spawnFn, timeoutMs: 30000 },
  );
  if (!existsSync(exePath)) {
    throw new Error(`csc.exe did not produce ${exePath}: ${stderr.trim() || stdout.trim()}`);
  }
  return exePath;
}

// Shared stdout protocol of both picker chains: PICKED:<path> / CANCELLED.
function parsePickerStdout(stdout) {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("PICKED:") || l.trim() === "CANCELLED");
  if (!line) return { cancelled: true };
  if (line.trim() === "CANCELLED") return { cancelled: true };
  return { cancelled: false, path: line.slice("PICKED:".length).trim() };
}

/**
 * Open the native folder-picker dialog and resolve with
 *   { cancelled: true }            — user dismissed the dialog
 *   { cancelled: false, path }     — absolute path of the chosen folder
 * Fast path: the pre-compiled helper exe (see ensureFolderPickerHelper).
 * Any failure there falls back to the PowerShell chain, which prefers the
 * modern IFileOpenDialog (same C# source via Add-Type) and then WinForms
 * FolderBrowserDialog. COM dialogs need STA, hence -STA.
 * `title` sets the dialog title (passed as argv[0] to the helper exe).
 */
export async function pickFolder({ spawnFn = spawn, timeoutMs = 120000, base = process.env, title = "选择 Skills 主仓库目录" } = {}) {
  return runPicker({ spawnFn, timeoutMs, base, title, pickFile: false });
}

/**
 * Open the native file-open dialog (same C# source, no FOS_PICKFOLDERS —
 * the OK button accepts files, not folders) and resolve with the same
 * protocol as pickFolder:
 *   { cancelled: true }            — user dismissed the dialog
 *   { cancelled: false, path }     — absolute path of the chosen file
 * The WinForms fallback uses OpenFileDialog. No filter is set — the caller
 * validates the extension.
 */
export async function pickFile({ spawnFn = spawn, timeoutMs = 120000, base = process.env, title = "选择文件" } = {}) {
  return runPicker({ spawnFn, timeoutMs, base, title, pickFile: true });
}

async function runPicker({ spawnFn, timeoutMs, base, title, pickFile: fileMode }) {
  try {
    const exePath = await ensureFolderPickerHelper({ spawnFn, base });
    const exeArgs = fileMode ? ["--file", title] : [title];
    const { stdout } = await runProcess(exePath, exeArgs, { spawnFn, timeoutMs });
    return parsePickerStdout(stdout);
  } catch {
    // Helper unavailable (no csc, compile or spawn failure) — PowerShell chain.
  }
  const psTitle = title.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$picked = $null",
    "$cancelled = $false",
    "$failed = $false",
    `try { Add-Type -TypeDefinition @'\n${FOLDER_PICKER_CSHARP}\n'@; $r = [AnySwitchFolderPicker]::Pick('${psTitle}', ${fileMode ? "$false" : "$true"}); if ($null -eq $r) { $cancelled = $true } else { $picked = $r } } catch { $failed = $true }`,
    fileMode
      ? `if ($failed) { try { Add-Type -AssemblyName System.Windows.Forms; $ofd = New-Object System.Windows.Forms.OpenFileDialog; $ofd.Title = '${psTitle}'; if ($ofd.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $ofd.FileName } else { $cancelled = $true } } catch { Write-Error $_; exit 1 } }`
      : `if ($failed) { try { Add-Type -AssemblyName System.Windows.Forms; $fbd = New-Object System.Windows.Forms.FolderBrowserDialog; $fbd.Description = '${psTitle}'; if ($fbd.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $fbd.SelectedPath } else { $cancelled = $true } } catch { Write-Error $_; exit 1 } }`,
    "if ($cancelled) { 'CANCELLED' } elseif ($picked) { 'PICKED:' + $picked } else { 'CANCELLED' }",
  ].join("\n");
  const { stdout } = await runPowerShellSta(script, { spawnFn, timeoutMs });
  return parsePickerStdout(stdout);
}

// STA variant of runPowerShell: COM shell dialogs require a single-threaded
// apartment, and powershell.exe defaults to MTA.
function runPowerShellSta(script, { spawnFn = spawn, timeoutMs = 120000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnFn("powershell.exe", ["-STA", "-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      rejectPromise(new Error(`folder picker timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(stderr.trim() || `powershell exited ${code}`));
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Config persistence ({ repoPath } only)
// ─────────────────────────────────────────────────────────────

export function skillsConfigPath(base = process.env) {
  return join(relayDataRoot(base), "skills.json");
}

export function loadSkillsConfig({ base = process.env } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(skillsConfigPath(base), "utf8"));
    if (parsed && typeof parsed === "object") {
      return { repoPath: typeof parsed.repoPath === "string" ? parsed.repoPath : null };
    }
  } catch {
    /* absent or corrupt config = unconfigured */
  }
  return { repoPath: null };
}

export function saveSkillsConfig(config, { base = process.env } = {}) {
  const target = skillsConfigPath(base);
  mkdirSync(relayDataRoot(base), { recursive: true });
  atomicWriteFile(target, JSON.stringify({ repoPath: config.repoPath ?? null }, null, 2) + "\n");
}

// ─────────────────────────────────────────────────────────────
// Deploy / undeploy / import / delete / merge
// ─────────────────────────────────────────────────────────────

function findRepoSkill(repoPath, skillName) {
  return scanRepo(repoPath).find((s) => s.name === skillName || s.dirName === skillName) ?? null;
}

// skillName 必须就是目录名本身：join 前拦截 ".." / 含分隔符的输入，
// 否则回收站/junction 语义会落到 skillsDir 之外的任意目录上
function assertPlainSkillDirName(skillName) {
  if (skillName !== basename(skillName) || skillName === "." || skillName === "..") {
    const error = new Error(`非法 skillName: ${skillName}`);
    error.statusCode = 400;
    throw error;
  }
}

/**
 * Deploy a repo skill into an endpoint as a junction.
 * - Creates the endpoint skills directory on first use (kimi/dsh).
 * - Idempotent when the junction already points at the same repo directory.
 * - A same-named real directory is hash-compared: identical content is
 *   recycled and replaced by a junction; different content returns
 *   { ok:false, conflict:true, diffs } unless force is set, in which case
 *   the local copy is recycled and replaced.
 * Returns { ok:true, idempotent? } on success.
 */
export async function deploy(
  { endpointId, skillName, repoPath, force = false },
  { homeDir = homedir(), recycleDirFn = recycleDir } = {},
) {
  const endpoint = findEndpoint(endpointId, homeDir);
  if (!endpoint) throw new Error(`unknown endpoint: ${endpointId}`);
  if (!endpoint.enabled) throw new Error(`endpoint "${endpointId}" 兼容性未验证，暂未启用`);
  const skill = findRepoSkill(repoPath, skillName);
  if (!skill) throw new Error(`repo 中不存在 skill: ${skillName}`);

  mkdirSync(endpoint.skillsDir, { recursive: true });
  const linkPath = join(endpoint.skillsDir, skill.dirName);

  if (lexists(linkPath)) {
    if (isJunction(linkPath)) {
      const current = normalizePath(junctionTarget(linkPath));
      if (current === normalizePath(skill.absPath)) return { ok: true, idempotent: true };
      throw new Error(`端点已存在指向其他目录的 junction: ${linkPath}`);
    }
    // Same-named real directory: only replace after content comparison.
    if (hashDir(linkPath) !== hashDir(skill.absPath) && !force) {
      return { ok: false, conflict: true, diffs: diffDirs(skill.absPath, linkPath) };
    }
    await recycleDirFn(linkPath);
  }

  createJunction(linkPath, skill.absPath);
  return { ok: true };
}

/**
 * Remove a deployed junction. Refuses to touch real directories — undeploy
 * must never delete user data, only links we (or the user) created.
 */
export async function undeploy(
  { endpointId, skillName, repoPath },
  { homeDir = homedir() } = {},
) {
  const endpoint = findEndpoint(endpointId, homeDir);
  if (!endpoint) throw new Error(`unknown endpoint: ${endpointId}`);
  const skill = repoPath ? findRepoSkill(repoPath, skillName) : null;
  const dirName = skill?.dirName ?? skillName;
  // 扫描命中分支的 dirName 来自 scanRepo（恒为单段目录名）；兜底分支
  // 直接采用调用方传入的 skillName，后者也必须是纯目录名才能 join
  assertPlainSkillDirName(dirName);
  const linkPath = join(endpoint.skillsDir, dirName);
  if (!lexists(linkPath)) return { ok: true, idempotent: true };
  if (!isJunction(linkPath)) {
    throw new Error(`拒绝解除部署：${linkPath} 是实体目录，不是 junction`);
  }
  rmdirSync(linkPath); // rmdir on a junction removes only the link
  return { ok: true };
}

/**
 * Import an external skill into the repo root. The source is either a
 * directory containing SKILL.md, or a .zip archive holding such a directory
 * (SKILL.md at the archive root or inside a single top-level directory —
 * the GitHub "Download ZIP" shape). Archives are extracted with the
 * built-in System32 bsdtar and land in the repo as plain directories, so
 * everything downstream stays folder-shaped. A same-named or same-dirName
 * skill already in the repo is refused. Returns the imported descriptor.
 */
export function importSkill({ repoPath, sourcePath }, deps = {}) {
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error(`源路径不存在: ${sourcePath}`);
  }
  const st = lstatSync(sourcePath);
  if (st.isFile()) {
    if (!/\.zip$/i.test(sourcePath)) {
      throw new Error(`不支持的源文件类型（仅支持目录或 .zip）: ${sourcePath}`);
    }
    return importSkillFromZip({ repoPath, sourcePath }, deps);
  }
  if (!st.isDirectory()) {
    throw new Error(`源路径不是目录或 .zip 文件: ${sourcePath}`);
  }
  if (!existsSync(join(sourcePath, "SKILL.md"))) {
    throw new Error(`源目录缺少 SKILL.md: ${sourcePath}`);
  }
  return importSkillDir({ repoPath, sourceDir: sourcePath, dirName: basename(resolve(sourcePath)) });
}

// Shared tail of both import paths: frontmatter name, repo-conflict checks,
// and the recursive copy (with the .git filter) into the repo root.
function importSkillDir({ repoPath, sourceDir, dirName }) {
  const existing = scanRepo(repoPath);
  if (existing.some((s) => s.dirName === dirName || s.name === dirName)) {
    throw new Error(`仓库中已存在同名 skill: ${dirName}`);
  }
  let fm = {};
  try {
    fm = parseSkillFrontmatter(readFileSync(join(sourceDir, "SKILL.md"), "utf8"));
  } catch {
    /* fall back to directory name */
  }
  const name = fm.name || dirName;
  if (existing.some((s) => s.name === name)) {
    throw new Error(`仓库中已存在同名 skill: ${name}`);
  }
  const dest = join(repoPath, dirName);
  cpSync(sourceDir, dest, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).includes(".git"),
  });
  return { ok: true, skill: { name, dirName, relPath: dirName, description: fm.description || "" } };
}

// Extract a .zip into a temp dir, locate the skill root, then run the shared
// import tail. The repo directory is named after the wrapper directory when
// there is one, else after the zip filename sans extension.
function importSkillFromZip(
  { repoPath, sourcePath },
  { spawnFn = spawnSync, mkdtempFn = mkdtempSync, tmpBase = tmpdir(), env = process.env } = {},
) {
  const tmpDir = mkdtempFn(join(tmpBase, "anyswitch-skill-import-"));
  try {
    const systemRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
    const tarPath = join(systemRoot, "System32", "tar.exe");
    if (!existsSync(tarPath)) {
      throw new Error(`无法解压 .zip：未找到 ${tarPath}（Windows 10 1803+ 自带 bsdtar）`);
    }
    const r = spawnFn(tarPath, ["-xf", sourcePath, "-C", tmpDir]);
    if (!r || r.status !== 0) {
      throw new Error(`解压失败: ${r ? (r.stderr || "").toString().trim() || `tar 退出码 ${r.status}` : "tar 未运行"}`);
    }
    const root = findZipSkillRoot(tmpDir);
    const dirName = root === tmpDir
      ? basename(sourcePath).replace(/\.zip$/i, "")
      : basename(root);
    return importSkillDir({ repoPath, sourceDir: root, dirName });
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup of the extraction scratch dir */
    }
  }
}

// Locate the skill root inside an extracted archive:
// - SKILL.md right here → this directory is the skill.
// - exactly one entry that is a directory holding SKILL.md → that directory
//   (the GitHub "Download ZIP" wrapper shape).
// - exactly one entry at all, a directory without SKILL.md → descend into it
//   (a zip of the skill's parent folder) and repeat.
// - several directories holding SKILL.md → ambiguous, refuse.
// Depth-capped so a pathological archive cannot loop forever.
function findZipSkillRoot(extractDir) {
  let root = extractDir;
  for (let depth = 0; depth < 5; depth++) {
    if (existsSync(join(root, "SKILL.md"))) return root;
    const entries = readdirSync(root);
    const candidates = entries.filter((entry) => lstatSync(join(root, entry)).isDirectory()
      && existsSync(join(root, entry, "SKILL.md")));
    if (candidates.length > 1) {
      throw new Error(`压缩包内有 ${candidates.length} 个含 SKILL.md 的目录，无法确定要导入哪个，请只压缩单个 skill`);
    }
    if (candidates.length === 1) return join(root, candidates[0]);
    // No skill directory among the entries; a sole subdirectory may still be
    // a wrapper (zip of the parent folder) — descend and look again.
    const dirs = entries.filter((entry) => lstatSync(join(root, entry)).isDirectory());
    if (entries.length === 1 && dirs.length === 1) {
      root = join(root, dirs[0]);
      continue;
    }
    throw new Error("压缩包内未找到 SKILL.md（应位于压缩包根目录或其唯一一级子目录）");
  }
  throw new Error("压缩包目录层级过深，未找到 SKILL.md");
}

/**
 * Delete a skill from the repo: first remove every endpoint junction that
 * references the skill directory (link-only rmdir), then send the repo
 * directory itself to the Recycle Bin. A recycle failure aborts with an
 * error after the junctions are already cleaned — the data stays put.
 */
export async function deleteRepoSkill(
  { repoPath, skillName },
  { homeDir = homedir(), recycleDirFn = recycleDir } = {},
) {
  const skill = findRepoSkill(repoPath, skillName);
  if (!skill) throw new Error(`repo 中不存在 skill: ${skillName}`);
  const target = normalizePath(skill.absPath);
  const unlinked = [];
  for (const endpoint of listEndpoints(homeDir)) {
    const linkPath = join(endpoint.skillsDir, skill.dirName);
    if (!lexists(linkPath) || !isJunction(linkPath)) continue;
    if (normalizePath(junctionTarget(linkPath)) !== target) continue;
    rmdirSync(linkPath);
    unlinked.push(endpoint.id);
  }
  await recycleDirFn(skill.absPath);
  return { ok: true, unlinked };
}

/**
 * Adopt an endpoint-local skill into the master repo. Three paths by content:
 * - repo has no such skill (local-only): copy it into the repo root, recycle
 *   the local directory, then put a junction in its place — a real push.
 * - repo copy identical: no copy at all; the local dir is recycled and
 *   replaced by a junction pointing at the repo copy — the repo takes over.
 * - repo copy diverged: nothing is touched; returns
 *   { ok:false, conflict:true, diffs } for the user to resolve through
 *   resolveConflictSkill().
 */
export async function mergeLocalSkill(
  { endpointId, skillName, repoPath },
  { homeDir = homedir(), recycleDirFn = recycleDir } = {},
) {
  const endpoint = findEndpoint(endpointId, homeDir);
  if (!endpoint) throw new Error(`unknown endpoint: ${endpointId}`);
  if (!endpoint.enabled) throw new Error(`endpoint "${endpointId}" 兼容性未验证，暂未启用`);
  assertPlainSkillDirName(skillName);
  const localPath = join(endpoint.skillsDir, skillName);
  if (!existsSync(localPath) || isJunction(localPath)) {
    throw new Error(`端点上不存在本地实体目录: ${skillName}`);
  }
  if (!existsSync(join(localPath, "SKILL.md"))) {
    throw new Error(`本地目录缺少 SKILL.md，不是有效 skill: ${skillName}`);
  }
  const existing = findRepoSkill(repoPath, skillName);
  if (existing) {
    if (hashDir(existing.absPath) !== hashDir(localPath)) {
      return { ok: false, conflict: true, diffs: diffDirs(existing.absPath, localPath) };
    }
    // Identical: no copy needed, just swap the local dir for a junction.
    await recycleDirFn(localPath);
    createJunction(localPath, existing.absPath);
    return { ok: true, reusedRepoCopy: true };
  }
  const dest = join(repoPath, basename(localPath));
  cpSync(localPath, dest, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).includes(".git"),
  });
  await recycleDirFn(localPath);
  createJunction(localPath, dest);
  return { ok: true };
}

/**
 * Delete an endpoint-local real directory by sending it to the Recycle Bin.
 * Used by the panel's anomaly card for the "matching" (repo keeps an
 * identical copy) and "unique" (only copy — recoverable from the Recycle
 * Bin) groups. Junctions are refused outright: deleting a link is undeploy's
 * job, and this operation must only ever touch real data. There is no
 * hard-delete fallback — a recycle failure aborts with the dir in place.
 */
export async function deleteLocalSkill(
  { endpointId, skillName },
  { homeDir = homedir(), recycleDirFn = recycleDir } = {},
) {
  const endpoint = findEndpoint(endpointId, homeDir);
  if (!endpoint) throw new Error(`unknown endpoint: ${endpointId}`);
  if (!endpoint.enabled) throw new Error(`endpoint "${endpointId}" 兼容性未验证，暂未启用`);
  assertPlainSkillDirName(skillName);
  const localPath = join(endpoint.skillsDir, skillName);
  if (!existsSync(localPath) || isJunction(localPath)) {
    throw new Error(`端点上不存在本地实体目录: ${skillName}`);
  }
  await recycleDirFn(localPath);
  return { ok: true };
}
/**
 * Resolve a diverged same-named pair (repo skill vs endpoint-local directory)
 * in one explicit direction. Both directions end with a junction at the local
 * path pointing into the repo, single source of truth intact.
 * - direction "repo": the local directory is recycled and replaced by a
 *   junction pointing at the repo copy — repo content wins.
 * - direction "local": the repo directory is first sent to the Recycle Bin
 *   (recoverable; the repo may not be under version control), the local content is copied
 *   into the repo in place, then the local dir is recycled and replaced by a
 *   junction — local content wins, and every other endpoint junction that
 *   pointed at the repo copy now serves the new content.
 * A recycle failure aborts with an error; there is no hard-delete fallback,
 * and whatever already moved stays recoverable in the Recycle Bin.
 */
export async function resolveConflictSkill(
  { endpointId, skillName, repoPath, direction },
  { homeDir = homedir(), recycleDirFn = recycleDir } = {},
) {
  const endpoint = findEndpoint(endpointId, homeDir);
  if (!endpoint) throw new Error(`unknown endpoint: ${endpointId}`);
  if (!endpoint.enabled) throw new Error(`endpoint "${endpointId}" 兼容性未验证，暂未启用`);
  if (direction !== "repo" && direction !== "local") {
    throw new Error(`direction 必须是 "repo" 或 "local": ${direction}`);
  }
  assertPlainSkillDirName(skillName);
  const localPath = join(endpoint.skillsDir, skillName);
  if (!existsSync(localPath) || isJunction(localPath)) {
    throw new Error(`端点上不存在本地实体目录: ${skillName}`);
  }
  if (!existsSync(join(localPath, "SKILL.md"))) {
    throw new Error(`本地目录缺少 SKILL.md，不是有效 skill: ${skillName}`);
  }
  const repoSkill = findRepoSkill(repoPath, skillName);
  if (!repoSkill) throw new Error(`repo 中不存在 skill: ${skillName}`);

  if (direction === "repo") {
    await recycleDirFn(localPath);
    createJunction(localPath, repoSkill.absPath);
    return { ok: true };
  }
  // direction === "local": recycle the old repo copy BEFORE overwriting so it
  // stays recoverable, then copy local content into the same repo path.
  await recycleDirFn(repoSkill.absPath);
  cpSync(localPath, repoSkill.absPath, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).includes(".git"),
  });
  await recycleDirFn(localPath);
  createJunction(localPath, repoSkill.absPath);
  return { ok: true };
}

/**
 * Read-only structural diff of a diverged pair, for the panel's "view
 * differences" action. Same validation rules as resolveConflictSkill.
 */
export function diffLocalSkill({ endpointId, skillName, repoPath }, { homeDir = homedir() } = {}) {
  const endpoint = findEndpoint(endpointId, homeDir);
  if (!endpoint) throw new Error(`unknown endpoint: ${endpointId}`);
  assertPlainSkillDirName(skillName);
  const localPath = join(endpoint.skillsDir, skillName);
  if (!existsSync(localPath) || isJunction(localPath)) {
    throw new Error(`端点上不存在本地实体目录: ${skillName}`);
  }
  const repoSkill = findRepoSkill(repoPath, skillName);
  if (!repoSkill) throw new Error(`repo 中不存在 skill: ${skillName}`);
  return { ok: true, diffs: diffDirs(repoSkill.absPath, localPath) };
}

/**
 * Read a repo skill's SKILL.md by its relPath (the scanRepo unique key).
 * The relPath is resolved under repoPath and must stay inside it — anything
 * escaping the repo (`..`, absolute paths) is refused. Throws when the path
 * is not a scanned skill or its SKILL.md is missing.
 */
export function readSkillBody(repoPath, relPath) {
  if (typeof relPath !== "string" || !relPath.trim()) {
    const error = new Error("relPath 不能为空");
    error.statusCode = 400;
    throw error;
  }
  const repoRoot = resolve(repoPath);
  const target = resolve(repoRoot, relPath);
  const inside = relative(repoRoot, target);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    const error = new Error(`拒绝访问：relPath 越出仓库目录: ${relPath}`);
    error.statusCode = 400;
    throw error;
  }
  const skill = scanRepo(repoPath).find((s) => normalizePath(s.absPath) === normalizePath(target));
  if (!skill) {
    const error = new Error(
      existsSync(target)
        ? `目录缺少 SKILL.md，不是有效 skill: ${relPath}`
        : `repo 中不存在 skill: ${relPath}`,
    );
    error.statusCode = 404;
    throw error;
  }
  const content = readFileSync(join(skill.absPath, "SKILL.md"), "utf8");
  return { name: skill.name, dirName: skill.dirName, relPath: skill.relPath, content };
}

// ─────────────────────────────────────────────────────────────
// Service factory (what the panel router consumes)
// ─────────────────────────────────────────────────────────────

/**
 * Bundle the module's functions behind one injectable service object so the
 * panel router stays unit-testable without touching real home directories,
 * PowerShell, or junctions. All operations resolve deployment state live
 * from the filesystem; only repoPath persists.
 */
export function createSkillsService({
  homeDir = homedir(),
  base = process.env,
  spawnFn = spawn,
  recycleDirFn = (p) => recycleDir(p, { spawnFn }),
} = {}) {
  const deps = { homeDir, recycleDirFn };

  function configuredRepo() {
    return loadSkillsConfig({ base }).repoPath;
  }

  return {
    /** Aggregate everything the Skills tab renders in one round-trip. */
    getState() {
      const repoPath = configuredRepo();
      const repoExists = Boolean(repoPath) && existsSync(repoPath);
      const skills = repoExists ? scanRepo(repoPath) : [];
      return {
        repoPath,
        repoConfigured: Boolean(repoPath),
        repoValid: repoExists && skills.length > 0,
        skills,
        endpoints: scanEndpoints(repoExists ? repoPath : null, { homeDir }),
        candidates: [
          ...(base.ANYSWITCH_SKILLS_REPO ? [base.ANYSWITCH_SKILLS_REPO] : []),
          ...REPO_CANDIDATES.map((parts) => join(homeDir, ...parts)),
        ].map((p) => ({ path: p, exists: existsSync(p) && scanRepo(p).length > 0 })),
      };
    },

    /** Validate and persist a new master repo path. */
    setRepoPath(repoPath) {
      if (typeof repoPath !== "string" || !repoPath.trim()) {
        throw new Error("repoPath 不能为空");
      }
      const resolved = resolve(repoPath.trim());
      if (!existsSync(resolved)) throw new Error(`路径不存在: ${resolved}`);
      const skills = scanRepo(resolved);
      if (skills.length === 0) {
        throw new Error(`该目录下没有找到任何 skill（含 SKILL.md 的目录）: ${resolved}`);
      }
      saveSkillsConfig({ repoPath: resolved }, { base });
      return { repoPath: resolved, skillCount: skills.length };
    },

    pickFolder: (options = {}) => pickFolder({ spawnFn, base, ...options }),

    async importSkill(sourcePath) {
      const repoPath = configuredRepo();
      if (!repoPath) throw new Error("尚未设置主仓库");
      return importSkill({ repoPath, sourcePath });
    },

    /**
     * 调出系统目录选择框（FOS_PICKFOLDERS）让用户选 skill 本体目录，
     * 校验确为有效 skill（含 SKILL.md、不与仓库现有条目同名）后拷入
     * 主仓库。用户取消时返回 { cancelled: true }，其余同 importSkill。
     */
    async importPickedSkill() {
      const repoPath = configuredRepo();
      if (!repoPath) throw new Error("尚未设置主仓库");
      const picked = await pickFolder({ spawnFn, base, title: "选择要导入的 skill 目录（需包含 SKILL.md）" });
      if (picked.cancelled || !picked.path) return { cancelled: true };
      return { cancelled: false, ...importSkill({ repoPath, sourcePath: picked.path }) };
    },

    /**
     * 调出系统文件选择框让用户选 skill 的 .zip 压缩包，解压校验
     * （SKILL.md 定位、同名检查）后以目录形式拷入主仓库，与目录导入
     * 储存形态一致。选到非 .zip 文件时报错；取消返回 { cancelled: true }。
     */
    async importPickedZip() {
      const repoPath = configuredRepo();
      if (!repoPath) throw new Error("尚未设置主仓库");
      const picked = await pickFile({ spawnFn, base, title: "选择要导入的 skill .zip 压缩包" });
      if (picked.cancelled || !picked.path) return { cancelled: true };
      if (!/\.zip$/i.test(picked.path)) {
        throw new Error(`只支持 .zip 压缩包: ${picked.path}`);
      }
      return { cancelled: false, ...importSkill({ repoPath, sourcePath: picked.path }) };
    },

    async deleteRepoSkill(skillName) {
      const repoPath = configuredRepo();
      if (!repoPath) throw new Error("尚未设置主仓库");
      return deleteRepoSkill({ repoPath, skillName }, deps);
    },

    async deploy({ endpointId, skillName, force }) {
      const repoPath = configuredRepo();
      if (!repoPath) throw new Error("尚未设置主仓库");
      return deploy({ endpointId, skillName, repoPath, force: Boolean(force) }, deps);
    },

    async undeploy({ endpointId, skillName }) {
      const repoPath = configuredRepo();
      if (!repoPath) throw new Error("尚未设置主仓库");
      return undeploy({ endpointId, skillName, repoPath }, deps);
    },

    async mergeLocalSkill({ endpointId, skillName }) {
      const repoPath = configuredRepo();
      if (!repoPath) throw new Error("尚未设置主仓库");
      return mergeLocalSkill({ endpointId, skillName, repoPath }, deps);
    },

    // 删除端点本地实体目录不触碰主仓库，不要求 repo 已配置
    async deleteLocalSkill({ endpointId, skillName }) {
      return deleteLocalSkill({ endpointId, skillName }, deps);
    },

    async resolveConflictSkill({ endpointId, skillName, direction }) {
      const repoPath = configuredRepo();
      if (!repoPath) throw new Error("尚未设置主仓库");
      return resolveConflictSkill({ endpointId, skillName, repoPath, direction }, deps);
    },

    diffLocalSkill({ endpointId, skillName }) {
      const repoPath = configuredRepo();
      if (!repoPath) throw new Error("尚未设置主仓库");
      return diffLocalSkill({ endpointId, skillName, repoPath }, { homeDir });
    },

    readSkillBody(relPath) {
      const repoPath = configuredRepo();
      if (!repoPath) throw new Error("尚未设置主仓库");
      return readSkillBody(repoPath, relPath);
    },
  };
}
