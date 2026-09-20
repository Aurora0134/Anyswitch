import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname, resolve, isAbsolute, extname, basename, relative } from "node:path";
import {
  resolveClaudeExecutable, resolveCodexExecutable, resolveOpencodeExecutable,
  resolvePiExecutable, resolveKimiExecutable, resolveDshExecutable,
  resolveZcodeExecutable, resolveGrokExecutable,
} from "./agent-discovery.mjs";
import { compareVersions, parseVersion } from "./version-check.mjs";

// Qoder is a desktop-only client here: ~/.qoder/entry/qoder.cmd is the IDE's
// own command dispatcher (the `code.cmd`-style shim the IDE installer drops),
// not a separately installed CLI product, so it is not a detection target.
function resolveQoderExecutable(base = process.env) {
  return join(base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"), "Programs", "Qoder", "Qoder.exe");
}

export function readWindowsVersionResource(path) {
  if (process.platform !== "win32") return Promise.resolve(null);
  const script = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:ANYSWITCH_DETECT_FILE) | Select-Object ProductName,ProductVersion,FileVersion | ConvertTo-Json -Compress";
  return new Promise((done, reject) => {
    execFile(join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { timeout: 3000, windowsHide: true, maxBuffer: 65536, encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, ANYSWITCH_DETECT_FILE: path } },
      (error, stdout) => {
        if (error) return reject(Object.assign(new Error(), { code: error.killed ? "RESOURCE_TIMEOUT" : "RESOURCE_FAILED" }));
        try { done(JSON.parse(stdout.replace(/^\uFEFF/, "").trim())); }
        catch { reject(Object.assign(new Error(), { code: "METADATA_INVALID" })); }
      });
  });
}

function productVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value) ? value : null;
}

// Codex ships a native binary with no version resource and a hash-named install
// directory, so the only accurate source is the CLI's own report. Bounded
// subprocess, never a shell; a missing file reports `missing` so the caller can
// fall back to "not found" instead of blaming the installation.
export function probeExecutableVersion(path, { exec = execFile, timeoutMs = 5000 } = {}) {
  return new Promise((done) => {
    exec(path, ["--version"], { timeout: timeoutMs, windowsHide: true, maxBuffer: 65536, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) return done({ missing: ["ENOENT", "ENOTDIR"].includes(error.code), version: null });
      const match = /(?:^|[^\d.])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:[^\d]|$)/.exec(`${stdout}\n${stderr}`);
      done({ missing: false, version: match ? productVersion(match[1]) : null });
    });
  });
}

const CLIENTS = [
  ["claude", "Claude Code", resolveClaudeExecutable],
  ["codex", "Codex CLI", resolveCodexExecutable],
  ["opencode", "OpenCode", resolveOpencodeExecutable],
  ["pi", "Pi", resolvePiExecutable],
  ["kimi", "Kimi Code", resolveKimiExecutable],
  ["dsh", "DSH", resolveDshExecutable],
  ["zcode", "ZCode", resolveZcodeExecutable],
  ["qoder", "Qoder", resolveQoderExecutable],
  // Grok Build is a native binary like codex: version comes from the CLI's own
  // --version report (probeVersion branch below), never an npm package.json.
  ["grok", "Grok Build", resolveGrokExecutable],
];

const DESKTOP_CLIENTS = new Set(["zcode", "qoder"]);

// Grok Build is a native binary with its own `grok update` and no public
// release feed — no entry in release-service.mjs CLIENTS, so the about page
// must not issue an official-latest query for it.
const NO_OFFICIAL_SOURCE = new Set(["grok"]);

function missing(error) {
  return ["ENOENT", "ENOTDIR"].includes(error?.code);
}

export function createEnvironmentService({ base = process.env, now = Date.now, io = fs, readVersionResource = readWindowsVersionResource, probeVersion = probeExecutableVersion, ttl = 60_000 } = {}) {
  function isFile(path) {
    try { return io.statSync(path).isFile(); }
    catch (error) { if (missing(error)) return false; throw error; }
  }
  const resolverIo = { ...io, existsSync: isFile, strictErrors: true };

  function readText(path) {
    if (!isFile(path)) return null;
    if (io.statSync(path).size > 1024 * 1024) throw Object.assign(new Error(), { code: "METADATA_INVALID" });
    const bytes = io.readFileSync(path);
    return bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
      ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8").replace(/^\uFEFF/, "");
  }

  function npmTarget(path) {
    if (![".cmd", ".ps1", ""].includes(extname(path).toLowerCase())) return path;
    const text = readText(path);
    const match = text?.match(/(?:%dp0%|%~dp0|\$basedir)[\\/]+(node_modules[\\/][^"\r\n]+)["]/i);
    return match ? resolve(dirname(path), match[1].replace(/[\\/]/g, "/")) : null;
  }

  // Qoder's updater installs every release into <installRoot>/.qoder-versions/<version>/
  // and never rewrites the install root, whose app.asar keeps reporting the first
  // installed version. The newest payload carrying both its executable and its
  // app.asar is the one that runs.
  function desktopPayloads(id, executable) {
    const root = join(dirname(executable), `.${id}-versions`);
    let entries;
    try {
      entries = io.readdirSync(root);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    return entries.filter((entry) => parseVersion(entry))
      .map((entry) => ({ version: entry, exe: join(root, entry, basename(executable)), asar: join(root, entry, "resources/app.asar") }))
      .filter((payload) => isFile(payload.exe) && isFile(payload.asar))
      .sort((left, right) => compareVersions(right.version, left.version) ?? 0);
  }

  function asarProductVersion(id, path) {
    try {
      return readAsarPackageVersion(id, path);
    } catch (error) {
      if (error.code === "METADATA_INVALID" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  function readAsarPackageVersion(id, path) {
    const fd = io.openSync(path, "r");
    try {
      const size = io.fstatSync(fd).size;
      function readAt(length, offset) {
        if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(offset) || offset < 0 || offset + length > size) {
          throw Object.assign(new Error(), { code: "METADATA_INVALID" });
        }
        const buffer = Buffer.alloc(length);
        if (io.readSync(fd, buffer, 0, length, offset) !== length) throw Object.assign(new Error(), { code: "METADATA_INVALID" });
        return buffer;
      }
      const prefix = readAt(16, 0);
      const headerSize = prefix.readUInt32LE(4);
      const jsonSize = prefix.readUInt32LE(12);
      if (prefix.readUInt32LE(0) !== 4 || headerSize < 8 || jsonSize > headerSize - 8 || headerSize > 8 * 1024 * 1024) {
        throw Object.assign(new Error(), { code: "METADATA_INVALID" });
      }
      const header = JSON.parse(readAt(jsonSize, 16).toString("utf8"));
      const entry = header.files?.["package.json"];
      if (!entry || entry.unpacked || entry.link) return null;
      if (!/^\d+$/.test(entry.offset) || entry.size > 1024 * 1024) throw Object.assign(new Error(), { code: "METADATA_INVALID" });
      const pkg = JSON.parse(readAt(entry.size, 8 + headerSize + Number(entry.offset)).toString("utf8"));
      const expected = id === "zcode" ? "zcode" : "qoder";
      return [pkg.name, pkg.productName].some((name) => typeof name === "string" && name.toLowerCase() === expected)
        ? productVersion(pkg.version) : null;
    } finally { io.closeSync(fd); }
  }

  function desktopVersion(id, executable) {
    const [payload] = desktopPayloads(id, executable);
    if (payload) return { version: asarProductVersion(id, payload.asar), path: payload.exe };
    const asar = join(dirname(executable), "resources/app.asar");
    return isFile(asar) ? { version: asarProductVersion(id, asar), path: null } : { version: null, path: null };
  }

  function packageVersion(id, path) {
    if (id === "opencode") {
      const root = dirname(dirname(path));
      const text = readText(join(root, "package.json"));
      if (!text) return null;
      const pkg = JSON.parse(text);
      return /^opencode-windows-(?:x64|arm64)(?:-baseline)?$/.test(pkg.name)
        && resolve(root, "bin/opencode.exe").toLowerCase() === resolve(path).toLowerCase()
        && typeof pkg.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version) ? pkg.version : null;
    }
    const names = { claude: "@anthropic-ai/claude-code", pi: "@earendil-works/pi-coding-agent", kimi: "@moonshot-ai/kimi-code", dsh: "@deepseek-ai/dsh" };
    if (!names[id]) return null;
    let dir = dirname(path);
    for (let depth = 0; depth < 6; depth++, dir = dirname(dir)) {
      const text = readText(join(dir, "package.json"));
      if (!text) continue;
      const pkg = JSON.parse(text);
      if (pkg.name !== names[id]) return null;
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[id];
      if (typeof bin !== "string" || resolve(dir, bin).toLowerCase() !== resolve(path).toLowerCase()) return null;
      return typeof pkg.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version) ? pkg.version : null;
    }
    return null;
  }

  async function inspect(id, kind, locate) {
    // Clients without a public release feed (Grok Build: native binary,
    // self-updates via `grok update`) get no remoteId — the about page then
    // skips the official-latest query instead of showing a query failure.
    const result = { kind, remoteId: NO_OFFICIAL_SOURCE.has(id) ? null : id, status: "not_found", path: null, version: null, versionSource: null, issue: "entry_missing" };
    try {
      let path = locate(base, resolverIo);
      if (!isFile(path)) return result;
      if (["pi", "kimi", "dsh"].includes(id)) path = npmTarget(path);
      if (!path || !isFile(path)) return result;
      Object.assign(result, { status: "found", path, issue: "version_unavailable" });
      if (id === "codex" || id === "grok") {
        const probe = await probeVersion(path);
        if (probe?.missing) return { ...result, status: "not_found", path: null, issue: "entry_missing" };
        return probe?.version
          ? { ...result, version: probe.version, versionSource: "cli --version", issue: null }
          : { ...result, issue: "not_runnable" };
      }
      if (kind === "desktop") {
        const desktop = desktopVersion(id, path);
        const located = desktop.path ? { ...result, path: desktop.path } : result;
        return desktop.version ? { ...located, version: desktop.version, versionSource: "app.asar/package.json", issue: null } : located;
      }
      const version = packageVersion(id, path);
      if (id === "claude") {
        const resource = await readVersionResource(path);
        const peVersion = /^(?:Claude|Claude Code)$/i.test(resource?.ProductName ?? "")
          ? productVersion(resource.ProductVersion?.replace(/^(\d+\.\d+\.\d+)\.0$/, "$1")) : null;
        if (version && peVersion && version !== peVersion) return { ...result, issue: "version_conflict" };
        if (version || peVersion) return { ...result, version: version || peVersion, versionSource: version && peVersion ? "package.json+pe" : version ? "package.json" : "pe", issue: null };
      }
      return version ? { ...result, version, versionSource: "package.json", issue: null } : result;
    } catch (error) {
      if (missing(error) && result.status !== "found") return result;
      return { ...result, status: "error", issue: ["EACCES", "EPERM"].includes(error.code) ? "access_denied" : "discovery_failed" };
    }
  }

  let cache = null;
  async function getState({ force = false } = {}) {
    const at = now();
    if (!force && cache && at - cache.at < ttl) return cache.state;
    const clients = await Promise.all(CLIENTS.map(async ([id, name, resolver]) => {
      const installations = [await inspect(id, DESKTOP_CLIENTS.has(id) ? "desktop" : "cli", resolver)];
      return { id, name, installations };
    }));
    const state = { checkedAt: new Date(at).toISOString(), platform: process.platform, nodeVersion: process.version, clients };
    cache = { at, state };
    return state;
  }
  return { getState };
}
