import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname, resolve, isAbsolute, extname, basename, relative } from "node:path";
import {
  resolveClaudeExecutable, resolveOpencodeExecutable,
  resolvePiExecutable, resolveKimiExecutable, resolveDshExecutable,
  resolveZcodeExecutable, resolveGrokExecutable, resolveQoderCliExecutable,
  resolveZcodeCliExecutable, defaultZcodeCliExecutable,
} from "./agent-discovery.mjs";
import { compareVersions, parseVersion } from "./version-check.mjs";

// Qoder 桌面端在这里检测；~/.qoder/entry/qoder.cmd 是 IDE 自带的命令调度器
// （IDE 安装器丢下的 code.cmd 式垫片），不是独立安装的 CLI 产品，不做检测目标。
// CLI 形态的检测目标是 ~/.qoder/bin/qodercli/qodercli.exe（resolveQoderCliExecutable）。
function resolveQoderExecutable(base = process.env) {
  return join(base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"), "Programs", "Qoder", "Qoder.exe");
}

// DSH 官方桌面端（Electron 包，安装器默认落点）。它在进程面上自带运行时，
// 不经过我们的启动器，因此检测只认它自己的安装目录；未安装时这一行如实报未找到。
export function resolveDshDesktopExecutable(base = process.env) {
  return join(base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"), "Programs", "DeepSeek Harness", "DeepSeek Harness.exe");
}

// Kimi Code 官方桌面端（Electron 包，electron-builder NSIS 安装器的默认落点，
// 与 DSH 桌面端同型）。检测只认它自己的安装目录；未安装时这一行如实报未找到。
export function resolveKimiDesktopExecutable(base = process.env) {
  return join(base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"), "Programs", "Kimi Code", "Kimi Code.exe");
}

// The Codex CLI line must describe the same artifact the update button
// installs — the npm-global @openai/codex package. Detection therefore follows
// the npm shim like the other npm-based clients, and resolveCodexExecutable
// now prefers that same shim, so the terminal one-click launch and this card
// agree on which file is installed.
function resolveCodexShim(base = process.env) {
  return join(base.APPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Roaming"), "npm", "codex.cmd");
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

// Microsoft Store MSIX packages carry their version in the package
// registration, not in any executable resource. An empty stdout means the
// package is absent (resolve null); a nonzero exit, a timeout, or output that
// is not JSON rejects so the caller reports discovery_failed.
export function readWindowsAppxPackage(name) {
  if (process.platform !== "win32") return Promise.resolve(null);
  const script = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-AppxPackage -Name $env:ANYSWITCH_APPX_NAME | Select-Object Name,Version,InstallLocation | ConvertTo-Json -Compress";
  return new Promise((done, reject) => {
    execFile(join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { timeout: 3000, windowsHide: true, maxBuffer: 65536, encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, ANYSWITCH_APPX_NAME: name } },
      (error, stdout) => {
        if (error) return reject(Object.assign(new Error(), { code: error.killed ? "RESOURCE_TIMEOUT" : "RESOURCE_FAILED" }));
        const text = stdout.replace(/^\uFEFF/, "").trim();
        if (!text) return done(null);
        let parsed;
        try { parsed = JSON.parse(text); }
        catch { return reject(Object.assign(new Error(), { code: "METADATA_INVALID" })); }
        return done(Array.isArray(parsed) ? parsed[0] ?? null : parsed);
      });
  });
}

function productVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value) ? value : null;
}

// For native-binary clients without a reliable version resource the only
// accurate source is the CLI's own report. Bounded subprocess, never a shell;
// a missing file reports `missing` so the caller can fall back to "not found"
// instead of blaming the installation.
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
  ["codex", "Codex", resolveCodexShim],
  ["opencode", "OpenCode", resolveOpencodeExecutable],
  ["pi", "Pi", resolvePiExecutable],
  ["kimi", "Kimi Code", resolveKimiExecutable],
  ["dsh", "DeepSeek Harness", resolveDshExecutable],
  ["zcode", "ZCode", resolveZcodeExecutable],
  ["qoder", "Qoder", resolveQoderExecutable],
  // Grok Build is the remaining native binary: its local version comes from the
  // CLI's own --version report (probeVersion branch below), never an npm
  // package.json — `@xai-official/grok` is only how upstream ships it (and how
  // release-service reads the official latest), not the copy this machine runs.
  ["grok", "Grok Build", resolveGrokExecutable],
];

// 只有桌面形态的端点：本地那条记录就是桌面端，inspect 走 kind="desktop" 分支
// （版本从 app.asar 读）。dsh / kimi / codex / qoder / claude 是「CLI + 桌面端」
// 两形态，不在此列。
const DESKTOP_CLIENTS = new Set(["zcode", "qoder"]);

// 原生二进制、没有 npm 包清单可读的安装记录：本地版本只认执行体自报的
// --version（inspect 里的 probeVersion 分支），探不出来降级 not_runnable。
const PROBE_VERSION_CLIENTS = new Set(["grok", "qoder-cli"]);

// 两种安装形态都有的端点：npm 形态读包清单，原生形态（执行体旁边没有
// package.json）回退到 --version。Kimi Code 是唯一两者兼备的客户端——npm 全局包
// 与官方原生 SEA 可执行体都由官方分发，机器上装的是哪一种得看实际情况。
const PROBE_VERSION_FALLBACK_CLIENTS = new Set(["kimi"]);

// 各端点实际存在的产品形态枚举（数据面常量）。表与数组双层冻结：这是关于页
// 与各形态接线共用的跨模块契约，运行期不许改写。
export const CLIENT_ENTRY_FORMS = Object.freeze({
  kimi: Object.freeze(["CLI", "Desktop", "Web"]),
  codex: Object.freeze(["CLI", "Desktop"]),
  qoder: Object.freeze(["CLI", "Desktop"]),
  claude: Object.freeze(["CLI", "Desktop"]),
  // 官方桌面端上线后 DSH 与 kimi 同形：一个端点 id、一份家目录之上有终端、
  // 浏览器与桌面三个界面。
  dsh: Object.freeze(["CLI", "Desktop", "Web"]),
  pi: Object.freeze(["CLI"]),
  opencode: Object.freeze(["CLI"]),
  grok: Object.freeze(["CLI"]),
  // ZCode 桌面端是主形态；CLI 是官方源码在本机构建的 node 入口形态（bin\zcode.mjs），
  // 无官方 release 渠道，不参团官方版本比对。
  zcode: Object.freeze(["Desktop", "CLI"]),
});

function missing(error) {
  return ["ENOENT", "ENOTDIR"].includes(error?.code);
}

export function createEnvironmentService({ base = process.env, now = Date.now, io = fs, readVersionResource = readWindowsVersionResource, probeVersion = probeExecutableVersion, readAppxPackage = readWindowsAppxPackage, ttl = 60_000 } = {}) {
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

  // shim 里的路径按 cmd 的规矩展开：%~dp0 是 shim 自己所在目录，%NAME% 从环境取。
  // 只认这几种（官方安装器写下的启动器用的就是它们），展开不了的变量原样留着，
  // 于是路径不成绝对路径、isFile 判假，如实落到「未找到」。
  function expandShimPath(raw, shimDir) {
    return raw
      .replace(/%~dp0[\\/]?/gi, `${shimDir}\\`)
      .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) => base[name] ?? whole);
  }

  // npm 生成的 shim 解到它真正的入口，好让 packageVersion 顺着目录往上读
  // package.json；官方原生安装器写下的启动器（shim 直指原生执行体，既没有
  // %dp0% 也没有 node_modules）解到那个执行体。两者都不成立时按客户端分流：
  // kimi 原样返回 shim——shim 本身就是真实存在的执行体，判成「没找到」是
  // 假阴性；codex / pi / dsh 维持旧语义返回 null——解不出的损坏/残缺 shim
  // 按「未找到」报，别让「已安装」掩盖入口缺失。
  function npmTarget(path, id) {
    if (![".cmd", ".ps1", ""].includes(extname(path).toLowerCase())) return path;
    const text = readText(path);
    const entry = text?.match(/(?:%dp0%|%~dp0|\$basedir)[\\/]+(node_modules[\\/][^"\r\n]+)["]/i);
    if (entry) return resolve(dirname(path), entry[1].replace(/[\\/]/g, "/"));
    const direct = text?.match(/"([^"\r\n]*\.exe)"|((?:[A-Za-z]:)?[^\s"\r\n]*\.exe)/i);
    if (direct) {
      const expanded = expandShimPath(direct[1] ?? direct[2], dirname(path));
      // 引 node.exe 执行脚本的 shim（npm 标准式以外的手写形态）不把 node.exe
      // 当作客户端执行体：解到它会误报安装位置，kimi 的 --version 探针还会
      // 把 Node 自身版本当成客户端版本。
      if (isAbsolute(expanded) && basename(expanded).toLowerCase() !== "node.exe") return resolve(expanded);
    }
    return id === "kimi" ? path : null;
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
      // 只认归档确实属于这个产品：目录里的 app.asar 可能是别人的，包名对不上
      // 就不报版本（与 qoder / zcode 同一条防线）。
      const expected = id === "zcode" ? ["zcode"]
        : id === "dsh-desktop" ? ["@deepseek-ai/dsh-desktop"]
        : id === "kimi-desktop" ? ["kimi-code-app"]
        : ["qoder"];
      return [pkg.name, pkg.productName].some((name) => typeof name === "string" && expected.includes(name.toLowerCase()))
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
      // 平台变体包不声明 bin，走不了下面「bin 指向该执行体」的通用分支。身份防线因此
      // 只看两件事：清单名去掉 scope 就是它所在的目录名、且确实是 opencode 家的包，
      // 执行体就在那个目录的 bin 下。上游把 opencode-windows-* 改名 @opencode/cli-windows-*
      // 不再影响读版本，别人家的目录仍然进不来。
      const name = typeof pkg.name === "string" ? pkg.name.toLowerCase() : "";
      return name.split("/").pop() === basename(root).toLowerCase()
        && name.includes("opencode")
        && dirname(resolve(path)).toLowerCase() === resolve(root, "bin").toLowerCase()
        && typeof pkg.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version) ? pkg.version : null;
    }
    const names = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex", pi: "@earendil-works/pi-coding-agent", kimi: "@moonshot-ai/kimi-code", dsh: "@deepseek-ai/dsh" };
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

  // zcode-cli 是本机源码构建的发行树（dist/zcode/debug/zcode/），入口
  // bin\zcode.mjs 上两级就是带版本号的包清单。只认包名对得上的那份——
  // 与 readAsarPackageVersion 的包名防线同理，目录里可能有别人的清单。
  function zcodeCliVersion(path) {
    const text = readText(join(dirname(dirname(path)), "package.json"));
    if (!text) return null;
    const pkg = JSON.parse(text);
    return pkg.name === "zcode-runtime" ? productVersion(pkg.version) : null;
  }

  async function inspect(id, kind, locate) {
    // Every client row carries the remoteId the about page queries its official
    // latest from; release-service.mjs CLIENTS is the authoritative source list.
    const result = { kind, remoteId: id, status: "not_found", path: null, version: null, versionSource: null, issue: "entry_missing" };
    try {
      let path = locate(base, resolverIo);
      if (!isFile(path)) return result;
      if (["codex", "pi", "kimi", "dsh"].includes(id)) path = npmTarget(path, id);
      if (!path || !isFile(path)) return result;
      Object.assign(result, { status: "found", path, issue: "version_unavailable" });
      if (PROBE_VERSION_CLIENTS.has(id)) {
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
      // 两种形态都有的客户端：包清单读不出（原生执行体旁没有 package.json）时，
      // 本地版本改由执行体自报，与纯原生客户端同一口径。
      if (!version && PROBE_VERSION_FALLBACK_CLIENTS.has(id) && /\.exe$/i.test(path)) {
        const probe = await probeVersion(path);
        if (probe?.missing) return { ...result, status: "not_found", path: null, issue: "entry_missing" };
        return probe?.version
          ? { ...result, version: probe.version, versionSource: "cli --version", issue: null }
          : { ...result, issue: "not_runnable" };
      }
      return version ? { ...result, version, versionSource: "package.json", issue: null } : result;
    } catch (error) {
      if (missing(error) && result.status !== "found") return result;
      return { ...result, status: "error", issue: ["EACCES", "EPERM"].includes(error.code) ? "access_denied" : "discovery_failed" };
    }
  }

  // The Codex desktop app is a Microsoft Store MSIX package (OpenAI.Codex).
  // Store builds carry a four-segment manifest version (26.915.4065.0); a
  // trailing ".0" is stripped like the Claude PE check above, anything else
  // reports the row as found with an unreadable version. remoteId is
  // "codex-desktop" so the panel queries the desktop release feed for it.
  async function inspectCodexDesktop() {
    const result = { kind: "desktop", remoteId: "codex-desktop", status: "not_found", path: null, version: null, versionSource: null, issue: "entry_missing" };
    try {
      const pkg = await readAppxPackage("OpenAI.Codex");
      if (!pkg) return result;
      const found = {
        ...result,
        status: "found",
        path: typeof pkg.InstallLocation === "string" ? pkg.InstallLocation : null,
        issue: "version_unavailable",
      };
      const version = typeof pkg.Version === "string" ? productVersion(pkg.Version.replace(/^(\d+\.\d+\.\d+)\.0$/, "$1")) : null;
      return version ? { ...found, version, versionSource: "appx manifest", issue: null } : found;
    } catch {
      return { ...result, status: "error", issue: "discovery_failed" };
    }
  }

  // The Claude desktop app is an official MSIX package (packageName "Claude"),
  // distributed outside any store or package manager. Like the Codex row, the
  // manifest carries a four-segment version (2.9939.2.0) whose trailing ".0" is
  // stripped; remoteId is "claude-desktop" so the panel resolves its official
  // source through the desktop entry. The update itself is run by the
  // client-lifecycle official-MSIX leg, not by npm.
  async function inspectClaudeDesktop() {
    const result = { kind: "desktop", remoteId: "claude-desktop", status: "not_found", path: null, version: null, versionSource: null, issue: "entry_missing" };
    try {
      const pkg = await readAppxPackage("Claude");
      if (!pkg) return result;
      const found = {
        ...result,
        status: "found",
        path: typeof pkg.InstallLocation === "string" ? pkg.InstallLocation : null,
        issue: "version_unavailable",
      };
      const version = typeof pkg.Version === "string" ? productVersion(pkg.Version.replace(/^(\d+\.\d+\.\d+)\.0$/, "$1")) : null;
      return version ? { ...found, version, versionSource: "appx manifest", issue: null } : found;
    } catch {
      return { ...result, status: "error", issue: "discovery_failed" };
    }
  }

  // The DSH desktop app. Its version is the product version the package
  // manifest carries, read from inside the Electron archive: the executable's
  // own resource is the Electron artifact version (44.0.0 for every Electron
  // build, so it can never answer "which DSH is installed"), and the bundled
  // runtime manifest (`dsh/package.json` inside the archive) reports the
  // runtime's version rather than the app's — for the shipped build both are
  // 0.2.0-rc.2, but the app's own version is the one the official feed keys
  // on. remoteId is "dsh-desktop" so the panel queries the desktop release
  // feed for it, and the update is run by the app's own signed installer.
  async function inspectDshDesktop() {
    const result = { kind: "desktop", remoteId: "dsh-desktop", status: "not_found", path: null, version: null, versionSource: null, issue: "entry_missing" };
    try {
      const path = resolveDshDesktopExecutable(base);
      if (!isFile(path)) return result;
      const found = { ...result, status: "found", path, issue: "version_unavailable" };
      const version = asarProductVersion("dsh-desktop", join(dirname(path), "resources", "app.asar"));
      return version ? { ...found, version, versionSource: "app.asar/package.json", issue: null } : found;
    } catch (error) {
      if (missing(error) && result.status !== "found") return result;
      return { ...result, status: "error", issue: ["EACCES", "EPERM"].includes(error.code) ? "access_denied" : "discovery_failed" };
    }
  }

  // ZCode 的 CLI 形态（zcode 端点的第二条安装记录）：官方源码在本机构建的
  // node 入口 bin\zcode.mjs。不能裸用通用 inspect，有三处定制：
  // resolveZcodeCliExecutable 找不到时返回 null 而不是抛错，这里包一层回落
  // 默认构建树路径，让缺失如实走 not_found（裸传给 isFile 会 TypeError 落进
  // error 态）；本机构建没有官方 release 渠道，remoteId 恒为 null，否则关于页
  // 会拿它去查 /api/environment/latest/<id> 撞白名单 404；.mjs 在 Windows
  // 上不能直接执行，版本从入口附近的包清单读，不走 probeVersion。
  async function inspectZcodeCli() {
    const result = { kind: "cli", remoteId: null, status: "not_found", path: null, version: null, versionSource: null, issue: "entry_missing" };
    try {
      const path = resolveZcodeCliExecutable(base, resolverIo) ?? defaultZcodeCliExecutable(base);
      if (!isFile(path)) return result;
      const found = { ...result, status: "found", path, issue: "version_unavailable" };
      const version = zcodeCliVersion(path);
      return version ? { ...found, version, versionSource: "package.json", issue: null } : found;
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
      // 每个端点的主安装记录在 index 0：codex 的 0 是面板代管更新的 npm CLI、1 是
      // Microsoft Store 桌面端；qoder 的 0 是原生 CLI、1 是桌面 IDE；claude 与 dsh
      // 的 0 是 npm 全局 CLI（更新按钮装的就是这个包）、1 是官方桌面端；kimi 的
      // 1 是官方桌面应用；zcode 的 0 是桌面主形态、1 是本机源码构建的 CLI。
      // 顺序即「动作位认哪一条」的约定。
      const desktopInstallations = {
        codex: inspectCodexDesktop,
        dsh: inspectDshDesktop,
        claude: inspectClaudeDesktop,
        kimi: () => inspect("kimi-desktop", "desktop", resolveKimiDesktopExecutable),
      };
      const installations = await Promise.all(id === "qoder"
        ? [inspect("qoder-cli", "cli", resolveQoderCliExecutable), inspect(id, "desktop", resolver)]
        : id === "zcode"
          // zcode 与 qoder 同型（同一端点 id 下挂 CLI 形态安装记录），但桌面是它
          // 的主形态：desktop 守 index 0 是有意为之，CLI 记录只追加在后。
          ? [inspect(id, "desktop", resolver), inspectZcodeCli()]
          : [inspect(id, DESKTOP_CLIENTS.has(id) ? "desktop" : "cli", resolver),
            ...(desktopInstallations[id] ? [desktopInstallations[id]()] : [])]);
      return { id, name, entryForms: CLIENT_ENTRY_FORMS[id], installations };
    }));
    const state = { checkedAt: new Date(at).toISOString(), platform: process.platform, nodeVersion: process.version, clients };
    cache = { at, state };
    return state;
  }
  return { getState };
}
