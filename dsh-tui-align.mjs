// dsh-tui（@deepseek-harness-tui/dsh-tui）是装进 dsh profile 的社区插件，与 dsh
// 本体靠 peerDependencies 的版本区间对齐。dsh 升级——无论经不经本面板——都不会
// 触动 profile 里的插件：0.1.7 上游删了 dsh-agent-presets 等包并改了 ctx.shell
// 契约，留下的 0.10.2 直接起不来（2026-09-28 事故，dsh-cli 与终端一键启动同挂）。
// 这里在每次「更新 DSH」流程收尾时做一次对齐：找出声明了该插件的 profile，按其
// peer 区间挑出「适配当前 dsh 的最新插件版」，有新就用 dsh 自带的 plugin 通道装上。
//
// 全程注入 spawn/io：本模块不直接碰进程与磁盘，测试用替身驱动。

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, parseVersion } from "./version-check.mjs";
import { resolveNpmCli } from "./client-lifecycle.mjs";
import { resolveDshExecutable } from "./agent-discovery.mjs";

export const DSH_TUI_PACKAGE = "@deepseek-harness-tui/dsh-tui";

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
  io = { existsSync, readFileSync, readdirSync },
  base = process.env,
  timeoutMs = 10 * 60 * 1000,
  maxOutputChars = 2000,
} = {}) {
  try {
    if (!parseVersion(String(dshVersion ?? ""))) return { state: "unknown", profiles: [] };
    const dshHome = base.DSH_HOME ?? join(base.USERPROFILE ?? "", ".dsh");
    const profiles = findDshTuiProfiles({ dshHome, io });
    if (profiles.length === 0) return { state: "none", profiles: [] };
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
