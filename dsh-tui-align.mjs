// dsh-tui（@deepseek-harness-tui/dsh-tui）是装进 dsh profile 的社区插件，与 dsh
// 本体靠 peerDependencies 的版本区间对齐。dsh 升级——无论经不经本面板——都不会
// 触动 profile 里的插件：0.1.7 上游删了 dsh-agent-presets 等包并改了 ctx.shell
// 契约，留下的 0.10.2 直接起不来（2026-09-28 事故，dsh-cli 与终端一键启动同挂）。
// 这里在每次「更新 DSH」流程收尾时做一次对齐：找出声明了该插件的 profile，按其
// peer 区间挑出「适配当前 dsh 的最新插件版」，有新就用 dsh 自带的 plugin 通道装上。
//
// 全程注入 spawn/io：本模块不直接碰进程与磁盘，测试用替身驱动。

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compareVersions, parseVersion } from "./version-check.mjs";
import { resolveNpmCli } from "./client-lifecycle.mjs";
import { resolveDshExecutable } from "./agent-discovery.mjs";

export const DSH_TUI_PACKAGE = "@deepseek-harness-tui/dsh-tui";

// ── profile 的 pnpm-workspace.yaml 预置 ──────────────────────────────────
// dsh 的 plugin 通道把安装转给 profile 目录里的 pnpm；pnpm ≥11 的三道闸会把
// 插件安装整次判死，而上游 dsh-tui 的 /update 在跑 pnpm 之前会先把三件事写进
// profile 的 pnpm-workspace.yaml（update.js 的 ensureProfileAllowBuilds /
// ensureProfileReleaseAgeExclude / ensureProfileSharpPlatformFilter）。面板代跑
// 对齐时同样要预置，否则「从没在 TUI 里更新过」的 profile 会失败在闸门前：
//   1. allowBuilds：链上只有 postinstall 的依赖默认被 pnpm 拦下，整次安装报
//      ERR_PNPM_IGNORED_BUILDS；
//   2. minimumReleaseAgeExclude：pnpm ≥11 默认拒绝 24h 内发布的版本，而发版
//      当天对齐到的正是那个版本；
//   3. ignoredOptionalDependencies：sharp 的平台原生包会按 lockfile 全平台下载
//      （上游维护组实测约 90MB），只留当前平台的那几包。
// 三条都按上游同一套纪律写：best-effort、幂等、不覆盖用户已有决定、失败不抛。
const PROFILE_ALLOW_BUILDS = Object.freeze({
  "@google/genai": false,
  esbuild: false,
  koffi: false,
  protobufjs: false,
});

// sharp 的平台矩阵（上游 0.35.3 的实测表）。只列「别的平台」，当前平台的包
// 永远不忽略——漏一个后缀只是少省一点下载量，错杀当前平台会让 sharp 起不来。
const SHARP_WRAPPER_SUFFIXES = Object.freeze([
  "darwin-arm64", "darwin-x64", "freebsd-wasm32", "linux-arm", "linux-arm64",
  "linux-ppc64", "linux-riscv64", "linux-s390x", "linux-x64",
  "linuxmusl-arm64", "linuxmusl-x64",
  "win32-arm64", "win32-ia32", "win32-x64",
]);
const SHARP_LIBVIPS_SUFFIXES = Object.freeze([
  "darwin-arm64", "darwin-x64", "linux-arm", "linux-arm64",
  "linux-ppc64", "linux-riscv64", "linux-s390x", "linux-x64",
  "linuxmusl-arm64", "linuxmusl-x64",
]);

export function sharpCurrentSuffix(platform, cpu, libc) {
  if (platform === "freebsd") return "freebsd-wasm32";
  const os = platform === "linux" && libc === "musl" ? "linuxmusl" : platform;
  return `${os}-${cpu}`;
}

// 除当前平台外的全部 @img 包名。wasm32 与 webcontainers-wasm32 不忽略：它们
// 没有 os 约束，是回退架构上唯一能用的形态。
export function ignoredSharpOptionalPatterns(platform, cpu, libc) {
  const current = sharpCurrentSuffix(platform, cpu, libc);
  return [
    ...SHARP_WRAPPER_SUFFIXES.filter((suffix) => suffix !== current).map((suffix) => `@img/sharp-${suffix}`),
    ...SHARP_LIBVIPS_SUFFIXES.filter((suffix) => suffix !== current).map((suffix) => `@img/sharp-libvips-${suffix}`),
  ];
}

// YAML 顶层块的通用重写：找到 `key:` 起始行，收集块内的条目行（缩进即块内），
// 交给 rewriter 决定新的条目行。文件缺失按空文档处理；读不出/写不进一律返回
// undefined，让调用方照旧跑 pnpm、由 pnpm 自己的诊断兜底。
function rewriteWorkspaceBlock(io, yamlPath, key, rewriter) {
  try {
    if (!io.existsSync(dirname(yamlPath))) return undefined;
    let text = "";
    try { text = io.readFileSync(yamlPath, "utf8"); } catch { /* 缺文件：从空文档开始 */ }
    const lines = text === "" ? [] : text.split(/\r?\n/u);
    let blockStart = -1;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line !== "" && line === line.trimStart() && line.startsWith(`${key}:`)) { blockStart = index; break; }
    }
    const blockEnd = (() => {
      if (blockStart === -1) return -1;
      let end = blockStart + 1;
      for (let index = blockStart + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === "" || line === line.trimStart()) break;
        end = index + 1;
      }
      return end;
    })();
    const existing = blockStart === -1 ? [] : lines.slice(blockStart + 1, blockEnd);
    const next = rewriter(existing);
    if (next === null) return undefined;
    const same = existing.length === next.length && existing.every((line, index) => line === next[index]);
    if (same) return { changed: false };
    if (blockStart !== -1) lines.splice(blockStart + 1, blockEnd - blockStart - 1, ...next);
    else {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      lines.push(`${key}:`, ...next);
    }
    io.writeFileSync(yamlPath, `${lines.join("\n")}\n`);
    return { changed: true };
  } catch {
    return undefined;
  }
}

// 1) allowBuilds：只补缺失的键，用户写过的（含显式 true）一律保留。
export function ensureWorkspaceAllowBuilds(io, yamlPath) {
  return rewriteWorkspaceBlock(io, yamlPath, "allowBuilds", (existing) => {
    const present = new Set();
    for (const line of existing) {
      const match = /^\s+('?)(.+?)\1:\s/u.exec(line);
      if (match) present.add(match[2]);
    }
    const added = Object.keys(PROFILE_ALLOW_BUILDS).filter((key) => !present.has(key));
    if (added.length === 0) return existing;
    return [...existing, ...added.map((key) => `  ${key.includes("@") || key.includes("/") ? `'${key}'` : key}: false`)];
  });
}

// 2) minimumReleaseAgeExclude：只维护本包自己的条目（目标版在前、旧条目丢弃
// 不累积），别人的条目逐字保留。11.7.x 只认每包的第一条，所以目标版必须在前。
export function ensureWorkspaceReleaseAgeExclude(io, yamlPath, targetVersion, alsoExempt) {
  const keep = [`${DSH_TUI_PACKAGE}@${targetVersion}`];
  if (alsoExempt && alsoExempt !== targetVersion) keep.push(`${DSH_TUI_PACKAGE}@${alsoExempt}`);
  return rewriteWorkspaceBlock(io, yamlPath, "minimumReleaseAgeExclude", (existing) => {
    const itemOf = (line) => line.trim().replace(/^-\s*/u, "").replace(/^'(.*)'$/u, "$1");
    const foreign = existing.filter((line) => !itemOf(line).startsWith(`${DSH_TUI_PACKAGE}@`));
    // 本包条目按 keep 顺序重排（目标版在前），旧目标不留档——不累积。
    return [...foreign, ...keep.map((item) => `  - '${item}'`)];
  });
}

// 3) sharp 平台过滤：每次重算（这是跑更新那台机器的事实），本模块表里的条目
// 按包名替换，其余条目（用户自己的、上游以后新增的）逐字保留。
const SHARP_MANAGED_PATTERNS = new Set([
  ...SHARP_WRAPPER_SUFFIXES.map((suffix) => `@img/sharp-${suffix}`),
  ...SHARP_LIBVIPS_SUFFIXES.map((suffix) => `@img/sharp-libvips-${suffix}`),
]);

export function ensureWorkspaceSharpFilter(io, yamlPath, { platform, cpu, libc }) {
  const patterns = ignoredSharpOptionalPatterns(platform, cpu, libc);
  return rewriteWorkspaceBlock(io, yamlPath, "ignoredOptionalDependencies", (existing) => {
    const nameOf = (line) => {
      const body = line.trim().replace(/^-\s*/u, "");
      const bare = body.replace(/^'(.*)'$/u, "$1").replace(/^"(.*)"$/u, "$1");
      const commentAt = bare.search(/\s#/u);
      const name = (commentAt === -1 ? bare : bare.slice(0, commentAt)).trim();
      return name === "" ? undefined : name;
    };
    const foreign = existing.filter((line) => {
      const name = nameOf(line);
      return name === undefined || !SHARP_MANAGED_PATTERNS.has(name);
    });
    return [...foreign, ...patterns.map((pattern) => `  - '${pattern}'`)];
  });
}

// 对齐动手前把三件事写进 profile 的 pnpm-workspace.yaml。任一条失败都不阻断
// 对齐：pnpm 自己的诊断仍是用户看得见的兜底。
export function seedProfileWorkspace({ io, profileDir, targetVersion, installedVersion, platform = process.platform, cpu = process.arch, libc = "glibc" }) {
  const yamlPath = join(profileDir, "pnpm-workspace.yaml");
  const allowBuilds = ensureWorkspaceAllowBuilds(io, yamlPath);
  const releaseAge = targetVersion ? ensureWorkspaceReleaseAgeExclude(io, yamlPath, targetVersion, installedVersion) : undefined;
  const sharp = ensureWorkspaceSharpFilter(io, yamlPath, { platform, cpu, libc });
  return { allowBuilds, releaseAge, sharp };
}

// dsh-tui 每次启动把 pid 写进 ~/.dsh-tui/last-run.json，退出时刷新同一份记录。
// 记录里的 pid 还活着 = 有一个 TUI 会话在跑：此时 pnpm 换包在 Windows 上换不掉
// 正在使用的文件，硬换只会留下半个安装（与桌面腿「在跑不装」同一口径）。
// 读不出、格式不对、进程已退出都按「没在跑」处理——漏判只是回到旧行为，误判
// 会让插件永远更新不了。
export function dshTuiSessionRunning({ base = process.env, io = { readFileSync }, alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } } = {}) {
  // 家目录读不出来就没有可查的记录：按「没在跑」处理，绝不拿相对路径去碰当前
  // 工作目录里的同名文件（测试替身常常不带 USERPROFILE）。
  const home = base.USERPROFILE ?? base.HOME;
  if (!home) return false;
  try {
    const record = JSON.parse(io.readFileSync(join(home, ".dsh-tui", "last-run.json"), "utf8"));
    return Number.isInteger(record?.pid) && record.pid > 0 && alive(record.pid);
  } catch {
    return false;
  }
}

// peer 区间里随 dsh 本体版本走的只有 @deepseek-ai/dsh* 一族；cordis/schemastery
// 有自己的版本线，不参与对齐判定。
const DSH_PEER_PREFIX = "@deepseek-ai/dsh";

// dsh 系 peer 区间的实测形状只有两种：精确版（0.1.7-rc.2）与 caret（^0.1.5-alpha.2），
// 用 || 连成长名单（上游逐版本枚举）。忠实实现这两种 + npm 的预发行规则：带预发行
// 尾巴的版本只被「同 [major,minor,patch] 且自身带预发行的档位」接住。认不出的形状
// 一律判不满足——选不出可证适配的新版就不动，绝不把说不准的包写进用户 profile。
function satisfiesToken(parsed, token) {
  const t = token.trim();
  if (!t) return false;
  if (t.startsWith("^")) {
    const base = parseVersion(t.slice(1).trim());
    if (!base) return false;
    const [major, minor, patch] = base.core.map(Number);
    // caret 上界：major>0 进 major；0.x 进 minor；0.0.x 进 patch。
    const upper = major > 0 ? `${major + 1}.0.0` : minor > 0 ? `0.${minor + 1}.0` : `0.0.${patch + 1}`;
    if (parsed.prerelease.length > 0) {
      const sameTuple = parsed.core.every((part, i) => part === base.core[i]);
      if (!(base.prerelease.length > 0 && sameTuple)) return false;
    }
    return compareVersions(parsed.version, base.version) >= 0 && compareVersions(parsed.version, upper) < 0;
  }
  if (/^[<>=~*]/.test(t) || /\s/.test(t)) return false;
  const exact = parseVersion(t);
  return exact !== null && compareVersions(parsed.version, exact.version) === 0;
}

export function dshVersionSatisfiesRange(dshVersion, range) {
  const parsed = parseVersion(String(dshVersion ?? ""));
  if (!parsed) return false;
  return String(range ?? "").split("||").some((token) => satisfiesToken(parsed, token));
}

export function peerRangesCompatible(peerDependencies, dshVersion) {
  if (!parseVersion(String(dshVersion ?? ""))) return false;
  for (const [name, range] of Object.entries(peerDependencies ?? {})) {
    if (!name.startsWith(DSH_PEER_PREFIX)) continue;
    if (!dshVersionSatisfiesRange(dshVersion, range)) return false;
  }
  return true;
}

// 从候选（{version, peerDependencies}，任意顺序）里挑适配 dshVersion 且新于
// installedVersion 的最高版。installedVersion 传 null 表示本地读不到（安装已损坏
// 或不可解析），此时适配即入选——对齐顺带完成修复。sawNewer 记录「存在更新但
// 不适配」的情形，供文案区分「已最新」与「新版尚未适配」。
export function pickCompatiblePluginVersion(candidates, dshVersion, installedVersion) {
  const installed = installedVersion === null ? null : parseVersion(String(installedVersion));
  const newer = [];
  for (const candidate of candidates ?? []) {
    const version = String(candidate?.version ?? "");
    if (!parseVersion(version)) continue;
    if (installed !== null && compareVersions(version, installed.version) <= 0) continue;
    newer.push(candidate);
  }
  const compatible = newer.filter((candidate) => peerRangesCompatible(candidate.peerDependencies, dshVersion));
  compatible.sort((a, b) => compareVersions(a.version, b.version));
  return { pick: compatible.at(-1) ?? null, sawNewer: newer.length > 0 };
}

function readJson(io, path) {
  try {
    return JSON.parse(io.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// 声明了 dsh-tui 依赖的 dsh profile 才算对齐对象；没声明过的 profile 不被代装。
// installedVersion 读 profile 自己的 node_modules 落点，读不到记 null（装坏的情形）。
export function findDshTuiProfiles({ dshHome, io = { existsSync, readFileSync, readdirSync } }) {
  const profilesDir = join(dshHome, "profiles");
  let entries;
  try {
    entries = io.readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const dir = join(profilesDir, entry.name);
    const manifest = readJson(io, join(dir, "package.json"));
    const declared = manifest?.dependencies?.[DSH_TUI_PACKAGE] ?? manifest?.devDependencies?.[DSH_TUI_PACKAGE];
    if (declared === undefined) continue;
    const installed = readJson(io, join(dir, "node_modules", ...DSH_TUI_PACKAGE.split("/"), "package.json"));
    found.push({ profile: entry.name, dir, installedVersion: installed?.version ?? null });
  }
  return found;
}

// `npm view ... --json`，与 client-lifecycle 的 npm 腿同口径：node 直跑
// npm-cli.js、不经 shell、跟随用户 registry 配置。解析不出来一律返回 null。
function npmView({ args, npmCli, spawn, execPath, timeoutMs }) {
  return new Promise((done) => {
    spawn(
      execPath,
      [npmCli, "view", ...args, "--json"],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) return done(null);
        try {
          done(JSON.parse(String(stdout ?? "")));
        } catch {
          done(null);
        }
      },
    );
  });
}

function npmViewPluginMeta({ spec, ...rest }) {
  return npmView({ args: [spec, "version", "peerDependencies"], ...rest }).then((parsed) => {
    if (typeof parsed?.version !== "string") return null;
    return {
      version: parsed.version,
      peerDependencies: parsed.peerDependencies && typeof parsed.peerDependencies === "object" ? parsed.peerDependencies : {},
    };
  });
}

async function npmViewPluginVersions(rest) {
  const parsed = await npmView({ args: [DSH_TUI_PACKAGE, "versions"], ...rest });
  // 单版包 npm 会把数组塌成字符串，兜底包回数组。
  if (Array.isArray(parsed?.versions)) return parsed.versions.map(String);
  if (typeof parsed?.versions === "string") return [parsed.versions];
  if (Array.isArray(parsed)) return parsed.map(String);
  return null;
}

// 选目标版：先问 latest（常见路径一跳命中）；latest 不适配时自新到旧逐版翻元
// 数据，封顶 VERSION_WALK_CAP 版——再老的版本即使适配也不值得为它对齐。
const VERSION_WALK_CAP = 8;

async function resolveTargetVersion({ installedVersion, dshVersion, npmCli, spawn, execPath, timeoutMs }) {
  // 本地版本不可解析时按读不到处理：与 findDshTuiProfiles 的 null 同走修复路径。
  const installed = installedVersion !== null && parseVersion(String(installedVersion)) ? String(installedVersion) : null;
  const view = { npmCli, spawn, execPath, timeoutMs };
  const latest = await npmViewPluginMeta({ spec: DSH_TUI_PACKAGE, ...view });
  if (!latest) return { state: "unavailable" };
  {
    const { pick, sawNewer } = pickCompatiblePluginVersion([latest], dshVersion, installed);
    if (pick) return { target: pick.version };
    if (!sawNewer) return { state: "current" };
  }
  const versions = await npmViewPluginVersions(view);
  if (!versions) return { state: "incompatible-newer" };
  const sorted = versions.filter((v) => parseVersion(v)).sort((a, b) => compareVersions(b, a)).slice(0, VERSION_WALK_CAP);
  const candidates = [];
  let sawNewer = false;
  for (const version of sorted) {
    if (installed !== null && compareVersions(version, installed) <= 0) continue;
    sawNewer = true;
    const meta = version === latest.version ? latest : await npmViewPluginMeta({ spec: `${DSH_TUI_PACKAGE}@${version}`, ...view });
    if (meta) candidates.push(meta);
  }
  const { pick } = pickCompatiblePluginVersion(candidates, dshVersion, installed);
  if (pick) return { target: pick.version };
  return { state: sawNewer ? "incompatible-newer" : "current" };
}

// `dsh plugin --profile <name> add -w <pkg>@<ver>`：dsh 把插件管理转发给 profile
// 目录里的 pnpm，-w 是 pnpm 允许写 workspace 根 package.json 的开关（dsh-tui 自带
// 的升级提示原文即此命令）。.cmd 壳按 dsh-launcher 的既有口径过 comspec。
function runPluginAdd({ profile, version, dshExe, spawn, base, timeoutMs, maxOutputChars }) {
  const isCmd = dshExe.toLowerCase().endsWith(".cmd");
  const comspec = base.COMSPEC || "cmd.exe";
  const args = ["plugin", "--profile", profile, "add", "-w", `${DSH_TUI_PACKAGE}@${version}`];
  const [file, argv] = isCmd ? [comspec, ["/d", "/c", dshExe, ...args]] : [dshExe, args];
  return new Promise((done) => {
    spawn(
      file,
      argv,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const raw = String(stderr ?? "").trim() || String(stdout ?? "").trim();
        done({ ok: !error, output: raw.length > maxOutputChars ? raw.slice(-maxOutputChars) : raw });
      },
    );
  });
}

// 聚合状态：none（没有声明该插件的 profile）/ current / incompatible-newer /
// updated / failed（含元数据拉不下来的 unavailable）/ unknown（dsh 版本读不出，
// 无从判定，保持沉默）。
export async function alignDshTuiPlugins({
  dshVersion,
  spawn = execFile,
  execPath = process.execPath,
  io = { existsSync, readFileSync, readdirSync, writeFileSync },
  base = process.env,
  timeoutMs = 10 * 60 * 1000,
  maxOutputChars = 2000,
  sessionRunning = () => dshTuiSessionRunning({ base }),
} = {}) {
  try {
    if (!parseVersion(String(dshVersion ?? ""))) return { state: "unknown", profiles: [] };
    const dshHome = base.DSH_HOME ?? join(base.USERPROFILE ?? "", ".dsh");
    const profiles = findDshTuiProfiles({ dshHome, io });
    if (profiles.length === 0) return { state: "none", profiles: [] };
    // 有 TUI 会话在跑就不动 profile：Windows 下正在使用的包文件换不掉，硬换
    // 只会留下半个安装。状态落 failed，复用「自动更新未完成，可稍后手工更新」
    // 那句既有结果句，不新增文案。
    if (sessionRunning()) return { state: "failed", profiles: [], output: "" };
    const npmCli = resolveNpmCli({ execPath, io });
    if (!npmCli) return { state: "failed", profiles: [], output: "" };
    const dshExe = resolveDshExecutable(base);
    const results = [];
    for (const entry of profiles) {
      const decision = await resolveTargetVersion({
        installedVersion: entry.installedVersion,
        dshVersion,
        npmCli,
        spawn,
        execPath,
        timeoutMs,
      });
      if (!decision.target) {
        results.push({ profile: entry.profile, state: decision.state, from: entry.installedVersion, to: null, output: "" });
        continue;
      }
      if (decision.target === entry.installedVersion) {
        results.push({ profile: entry.profile, state: "current", from: entry.installedVersion, to: entry.installedVersion, output: "" });
        continue;
      }
      // pnpm ≥11 的三道闸先预置，再跑安装：allowBuilds、发版当天要用的
      // release-age 豁免、sharp 平台过滤（见文件顶部的三条说明）。
      seedProfileWorkspace({
        io,
        profileDir: entry.dir,
        targetVersion: decision.target,
        installedVersion: entry.installedVersion,
      });
      const install = await runPluginAdd({
        profile: entry.profile,
        version: decision.target,
        dshExe,
        spawn,
        base,
        timeoutMs,
        maxOutputChars,
      });
      results.push({
        profile: entry.profile,
        state: install.ok ? "updated" : "failed",
        from: entry.installedVersion,
        to: decision.target,
        output: install.output,
      });
    }
    const states = results.map((r) => r.state);
    const aggregate = states.includes("failed") || states.includes("unavailable")
      ? "failed"
      : states.includes("updated")
        ? "updated"
        : states.includes("incompatible-newer")
          ? "incompatible-newer"
          : "current";
    return { state: aggregate, profiles: results };
  } catch (error) {
    return { state: "failed", profiles: [], output: String(error?.message ?? error ?? "") };
  }
}
