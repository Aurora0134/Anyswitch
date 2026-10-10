import { join, isAbsolute } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";

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

export function resolveCodexExecutable(base = process.env, io = { readdirSync, existsSync, statSync }) {
  const override = absoluteOverride(base, "CODEX_EXECUTABLE");
  if (override !== null) return override;
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
      `no codex.exe found under ${binRoot}; is the Codex CLI installed? ` +
        `Set CODEX_EXECUTABLE to an absolute path to point the launcher at it.`,
    );
    error.code = "ENOENT";
    throw error;
  }
  candidates.sort((a, b) => io.statSync(b).mtimeMs - io.statSync(a).mtimeMs);
  return candidates[0];
}

export function resolveOpencodeExecutable(base = process.env) {
  const override = base.OPENCODE_EXECUTABLE;
  if (override) return absoluteOverride(base, "OPENCODE_EXECUTABLE");
  // Default to the real opencode binary bundled inside the platform optional
  // dependency — NOT %APPDATA%\npm\opencode.cmd (the Anyswitch shadow shims
  // route that back into this launcher = infinite recursion) and NOT
  // opencode-ai\bin\opencode.exe: that top-level path is a 479-byte
  // placeholder batch whenever npm's allow-scripts policy blocks the
  // postinstall copy (observed with npm 12 on 2026-09-14/15), which Windows
  // then refuses to execute ("与你运行的 Windows 版本不兼容"). The embedded
  // path depends on upstream's "optional dependency per platform" layout —
  // if upstream repackages, OPENCODE_EXECUTABLE is the escape hatch.
  return join(roamingNpm(base), "node_modules", "opencode-ai", "node_modules", "opencode-windows-x64", "bin", "opencode.exe");
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
