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

export function resolveKimiExecutable(base = process.env) {
  return base.KIMI_EXECUTABLE || join(roamingNpm(base), "kimi.cmd");
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

export function resolveQoderExecutable(base = process.env, io = { existsSync }) {
  const override = absoluteOverride(base, "QODER_EXECUTABLE");
  if (override !== null) return override;
  const entryPath = join(base.USERPROFILE ?? "", ".qoder", "entry", "qoder.cmd");
  return io.existsSync(entryPath) ? entryPath : join(base.USERPROFILE ?? "", ".qoder", "bin", "qodercli", "qodercli.exe");
}
