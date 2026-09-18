import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname, resolve, isAbsolute, extname, basename, relative } from "node:path";
import {
  resolveClaudeExecutable, resolveCodexExecutable, resolveOpencodeExecutable,
  resolvePiExecutable, resolveKimiExecutable, resolveDshExecutable,
  resolveZcodeExecutable, resolveQoderExecutable,
} from "./agent-discovery.mjs";

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

const CLIENTS = [
  ["claude", "Claude Code", resolveClaudeExecutable],
  ["codex", "Codex CLI", resolveCodexExecutable],
  ["opencode", "OpenCode", resolveOpencodeExecutable],
  ["pi", "Pi", resolvePiExecutable],
  ["kimi", "Kimi Code", resolveKimiExecutable],
  ["dsh", "DSH", resolveDshExecutable],
  ["zcode", "ZCode", resolveZcodeExecutable],
  ["qoder", "Qoder", resolveQoderExecutable],
];

function missing(error) {
  return ["ENOENT", "ENOTDIR"].includes(error?.code);
}

export function createEnvironmentService({ base = process.env, now = Date.now, io = fs, readVersionResource = readWindowsVersionResource, ttl = 60_000 } = {}) {
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

  function desktopVersion(id, executable) {
    const path = join(dirname(executable), "resources/app.asar");
    if (!isFile(path)) return null;
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
    const result = { kind, remoteId: id, status: "not_found", path: null, version: null, versionSource: null, issue: "entry_missing" };
    try {
      let path = locate(base, resolverIo);
      if (!isFile(path)) return result;
      if (["pi", "kimi", "dsh"].includes(id)) path = npmTarget(path);
      if (!path || !isFile(path)) return result;
      Object.assign(result, { status: "found", path, issue: "version_unavailable" });
      if (kind === "desktop") {
        const desktop = desktopVersion(id, path);
        return desktop ? { ...result, version: desktop, versionSource: "app.asar/package.json", issue: null } : result;
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
      const installations = [await inspect(id, id === "zcode" ? "desktop" : "cli", resolver)];
      if (id === "qoder") installations.push(await inspect("qoder-desktop", "desktop", () => join(
        base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"), "Programs", "Qoder", "Qoder.exe",
      )));
      return { id, name, installations };
    }));
    const state = { checkedAt: new Date(at).toISOString(), platform: process.platform, nodeVersion: process.version, clients };
    cache = { at, state };
    return state;
  }
  return { getState };
}
