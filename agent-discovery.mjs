import { join, isAbsolute, basename } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";

function absoluteOverride(base, key) {
  const override = base[key];
  if (override === undefined || override === null || override === "") return null;
  if (!isAbsolute(override)) {
    throw new Error(
      `${key} must be an absolute path, got "${override}". ` +
        `A bare name or relative path could resolve back to the Anyswitch shim and ` +
        `make the launcher recurse into itself.`,
    );
  }
  return override;
}

function roamingNpm(base) {
  return join(base.APPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Roaming"), "npm");
}

export function defaultClaudeExecutable(base = process.env) {
  return join(roamingNpm(base), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe").replace(/\\/g, "/");
}

export function resolveClaudeExecutable(base = process.env) {
  const override = base.CLAUDE_EXECUTABLE;
  if (override === undefined || override === null || override === "") return defaultClaudeExecutable(base);
  if (!isAbsolute(override)) {
    throw new Error(
      `CLAUDE_EXECUTABLE must be an absolute path to claude.exe, got "${override}". ` +
        `A bare name or relative path could resolve back to the Anyswitch shim and ` +
        `make the launcher recurse into itself.`,
    );
  }
  if (!/\.exe$/i.test(override)) {
    throw new Error(
      `CLAUDE_EXECUTABLE must point at a .exe, got "${override}". ` +
        `Pointing it at a .cmd/.ps1/shim wrapper could make the launcher recurse into itself.`,
    );
  }
  return override.replace(/\\/g, "/");
}

// Codex has two install shapes, and the terminal one-click launch, the launcher
// and the environment card must all resolve the same one. The npm-global shim
// is preferred because it is the artifact the panel's update button installs
// and the one environment-service detects (resolveCodexShim); the official
// native install layout stays as the fallback so a Codex installed that way
// keeps working. The shim is a .cmd, which both callers already wrap in
// `cmd /d /c`.
export function resolveCodexExecutable(base = process.env, io = { readdirSync, existsSync, statSync }) {
  const override = absoluteOverride(base, "CODEX_EXECUTABLE");
  if (override !== null) return override;
  // Prefer the shim; see the note above for why this is the shared artifact.
  const shim = join(roamingNpm(base), "codex.cmd");
  if (io.existsSync(shim)) return shim;
  const binRoot = join(base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"), "OpenAI", "Codex", "bin");
  let candidates = [];
  try {
    candidates = io.readdirSync(binRoot)
      .map((entry) => join(binRoot, entry, "codex.exe"))
      .filter((exe) => io.existsSync(exe));
  } catch (error) {
    if (io.strictErrors && !["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
  if (candidates.length === 0) {
    const error = new Error(
      `no codex.exe found under ${binRoot} and no npm shim at ${shim}; is the Codex CLI installed? ` +
        `Set CODEX_EXECUTABLE to an absolute path to point the launcher at it.`,
    );
    error.code = "ENOENT";
    throw error;
  }
  candidates.sort((a, b) => io.statSync(b).mtimeMs - io.statSync(a).mtimeMs);
  return candidates[0];
}

// opencode 的包名与目录布局由上游发包决定：1.x 是 opencode-ai 加 opencode-windows-*，
// 2.x 起整组改名 @opencode/cli 加 @opencode/cli-windows-*。候选包名只是快路径，真正
// 决定执行体位置的是包自己 package.json 的 optionalDependencies；快路径落空而 npm 确实
// 装过 opencode 这个命令时，再按 bin 声明认一次包——上游下次改名不再需要同步改这里。
const OPENCODE_PACKAGE_NAMES = ["@opencode/cli", "opencode-ai"];

function packageDir(modulesRoot, name) {
  return join(modulesRoot, ...name.split("/"));
}

// 清单读不出就当作「不是这个包」：扫描路径要路过别人家的目录，不该由它们决定
// 本机 opencode 的检测结论；快路径的候选都落空时如实报未安装。
function readManifest(dir, io) {
  let text;
  try {
    text = io.readFileSync(join(dir, "package.json"), "utf8");
  } catch (error) {
    if (io.strictErrors && !["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error;
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// npm 为这个包生成的 shim 就落在 <prefix>\<command>.cmd，用它判断「装过 opencode」
// 比猜包名可靠；没有 shim 说明这台机器根本没有 opencode 命令，不必扫全目录。
function opencodePackageDirs(npmRoot, modulesRoot, io) {
  const dirs = OPENCODE_PACKAGE_NAMES.map((name) => packageDir(modulesRoot, name));
  if (dirs.some((dir) => io.existsSync(join(dir, "package.json")))) return dirs;
  if (!io.existsSync(join(npmRoot, "opencode.cmd"))) return dirs;
  const found = [];
  for (const entry of io.readdirSync(modulesRoot)) {
    if (entry.startsWith(".")) continue;
    const dir = join(modulesRoot, entry);
    for (const candidate of entry.startsWith("@") ? io.readdirSync(dir).map((child) => join(dir, child)) : [dir]) {
      const manifest = readManifest(candidate, io);
      const commands = typeof manifest?.bin === "string" ? [] : Object.keys(manifest?.bin ?? {});
      if (commands.includes("opencode")) found.push(candidate);
    }
  }
  return [...dirs, ...found];
}

// 上游按平台与 CPU 档位各发一个可选依赖包，本机该用哪一个由它的清单说了算。
// 优先序照抄上游 postinstall 在有 AVX2 时的选择：本机 CPU 档非 baseline 优先，
// 其次同档 baseline，最后其他档；darwin/linux 的条目一律不看。
function opencodeVariantNames(manifest, hostArch) {
  const names = Object.keys(manifest?.optionalDependencies ?? {})
    .filter((name) => /-windows-(?:x64|arm64)(?:-baseline)?$/.test(name));
  const rank = (name) => (name.endsWith("-baseline") ? 1 : 0) + (name.includes(`-windows-${hostArch}`) ? 0 : 2);
  return names.sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
}

function opencodeDeclaredBinary(manifest) {
  const target = typeof manifest?.bin === "string" ? manifest.bin : Object.values(manifest?.bin ?? {})[0];
  return typeof target === "string" && target ? basename(target) : "opencode.exe";
}

// 包自己的 bin 在 postinstall 被 npm 的脚本白名单拦下时是一个文本桩（本机 2.0.28 即
// 如此），Windows 拒绝执行它，历史表现为「与你运行的 Windows 版本不兼容」。只认 PE。
function isPortableExecutable(path, io) {
  let fd;
  try {
    fd = io.openSync(path, "r");
    const head = Buffer.alloc(2);
    return io.readSync(fd, head, 0, 2, 0) === 2 && head.toString("latin1") === "MZ";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
  }
}

export function resolveOpencodeExecutable(
  base = process.env,
  io = { existsSync, readFileSync, readdirSync, openSync, readSync, closeSync, arch: process.arch },
) {
  const override = base.OPENCODE_EXECUTABLE;
  if (override) return absoluteOverride(base, "OPENCODE_EXECUTABLE");
  // 执行体取平台可选依赖包里的真实二进制，不取 %APPDATA%\npm\opencode.cmd——Anyswitch
  // 的接管 shim 会把它绕回本启动器，形成递归。
  const npmRoot = roamingNpm(base);
  const modulesRoot = join(npmRoot, "node_modules");
  const hostArch = io.arch === "arm64" ? "arm64" : "x64";
  for (const dir of opencodePackageDirs(npmRoot, modulesRoot, io)) {
    const manifest = readManifest(dir, io);
    if (!manifest) continue;
    const binary = opencodeDeclaredBinary(manifest);
    for (const variant of opencodeVariantNames(manifest, hostArch)) {
      // npm 可能把平台包嵌在宿主包下，也可能提到全局 node_modules 顶层，两种落盘都要认。
      for (const root of [join(dir, "node_modules"), modulesRoot]) {
        const candidate = join(packageDir(root, variant), "bin", binary);
        if (io.existsSync(candidate)) return candidate;
      }
    }
    // 可选依赖被跳过时（上游 installPackage 会临时装一份再复制进包自己的 bin），
    // 包自己的 bin 是唯一执行体；它得是真的 PE 才算。
    const bundled = join(dir, "bin", binary);
    if (io.existsSync(bundled) && isPortableExecutable(bundled, io)) return bundled;
  }
  // 没装：报首选包首选变体的位置（与历史口径一致）。不能报包自己的 bin——
  // 那正是上面那种文本桩的所在，路径存在会被环境检测当成「已安装」。
  const primary = OPENCODE_PACKAGE_NAMES[0];
  return join(packageDir(join(packageDir(modulesRoot, primary), "node_modules"), `${primary}-windows-x64`), "bin", "opencode.exe");
}

export function resolvePiExecutable(base = process.env) {
  return absoluteOverride(base, "PI_EXECUTABLE") ?? join(roamingNpm(base), "pi.cmd");
}

// Kimi Code CLI 的官方原生安装落点：安装器与 CLI 自更新器写下的 SEA 可执行体。
// 它是 Node 单文件产物，PE 版本资源写的是 Node.js 自身版本，读不出产品版本。
export function resolveKimiNativeExecutable(base = process.env) {
  return join(base.USERPROFILE ?? "", ".kimi-code", "bin", "kimi.exe");
}

// Kimi Code 的 CLI 有两种官方安装形态：npm 全局包（@moonshot-ai/kimi-code，
// bin 是 dist/main.mjs，shim 由 npm 生成）与官方原生二进制（安装器落下的
// ~/.kimi-code/bin/kimi.exe，shim 直指它）。npm shim 优先——面板的安装/更新
// 按钮装的就是那个包；原生执行体是回退，只有原生形态的机器上
// %APPDATA%\npm\kimi.cmd 可能并不存在。
export function resolveKimiExecutable(base = process.env, io = { existsSync }) {
  const override = base.KIMI_EXECUTABLE;
  if (override) return override;
  const shim = join(roamingNpm(base), "kimi.cmd");
  if (io.existsSync(shim)) return shim;
  return resolveKimiNativeExecutable(base);
}

export function resolveDshExecutable(base = process.env, io = { existsSync }) {
  const override = absoluteOverride(base, "DSH_EXECUTABLE");
  if (override !== null) return override;
  const cmdPath = join(roamingNpm(base), "dsh.cmd");
  // Deliberately skip dsh.ps1: realSpawnDsh only wraps .cmd in comspec /c,
  // and Windows cannot execute a .ps1 file directly — returning it would
  // guarantee an error event on spawn. Fall through to the extensionless
  // shim instead.
  return io.existsSync(cmdPath) ? cmdPath : join(roamingNpm(base), "dsh");
}

export function resolveZcodeExecutable(base = process.env) {
  return absoluteOverride(base, "ZCODE_EXECUTABLE") ?? join(
    base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"), "Programs", "zcode", "ZCode.exe",
  );
}

// ZCode CLI 是从官方源码本机构建的 node 入口（dist 发行树里的 bin\zcode.mjs，
// 由 node 拉起），与桌面版 ZCode.exe 是两种形态，override 变量也因此独立。
export function defaultZcodeCliExecutable(base = process.env) {
  return join(
    base.USERPROFILE ?? "",
    "Desktop", "agent-home", "zcode-src", "dist", "zcode", "debug", "zcode", "bin", "zcode.mjs",
  );
}

// 默认候选即本机构建产物；找不到返回 null（优雅 not-found，不抛错），
// 是提示未安装还是跳过由调用方决定。
export function resolveZcodeCliExecutable(base = process.env, io = { existsSync }) {
  const override = absoluteOverride(base, "ZCODE_CLI_EXECUTABLE");
  if (override !== null) return override;
  const candidate = defaultZcodeCliExecutable(base);
  return io.existsSync(candidate) ? candidate : null;
}

export function resolveGrokExecutable(base = process.env) {
  const override = absoluteOverride(base, "GROK_EXECUTABLE");
  if (override !== null) {
    if (!/\.exe$/i.test(override)) {
      throw new Error(
        `GROK_EXECUTABLE must point at a .exe, got "${override}". ` +
          `Pointing it at a .cmd/.ps1/shim wrapper could make the launcher recurse into itself.`,
      );
    }
    return override;
  }
  // Grok Build is a native binary installed under its own home (~/.grok, docs:
  // user-guide/14-headless-mode.md "File Locations"); GROK_HOME only moves the
  // config root, not this machine's managed install location.
  return join(base.USERPROFILE ?? "", ".grok", "bin", "grok.exe");
}

export function resolveQoderExecutable(base = process.env, io = { existsSync }) {
  const override = absoluteOverride(base, "QODER_EXECUTABLE");
  if (override !== null) return override;
  const entryPath = join(base.USERPROFILE ?? "", ".qoder", "entry", "qoder.cmd");
  return io.existsSync(entryPath) ? entryPath : join(base.USERPROFILE ?? "", ".qoder", "bin", "qodercli", "qodercli.exe");
}

// Qoder CLI 的官方形态是 Bun 单文件 qodercli.exe，与桌面端共用 ~/.qoder 数据根；
// 上面的 resolveQoderExecutable 偏向 IDE 的 qoder.cmd 调度器，环境检测与终端
// 一键启动要的都是 CLI 执行体本身，路径因此单独解析。
export function resolveQoderCliExecutable(base = process.env) {
  return join(base.USERPROFILE ?? "", ".qoder", "bin", "qodercli", "qodercli.exe");
}
