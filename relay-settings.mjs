// Persistent settings manager for Anyswitch.
//
// Reads and writes %LOCALAPPDATA%\Anyswitch\settings.json with atomic replacements.
// Provides sensible defaults (e.g. keepAlive enabled by default).
// Preserves any existing arbitrary keys in settings.json. saveSettings refuses
// to overwrite a settings.json that fails to parse: the corrupt file is copied
// to settings.json.corrupt-<timestamp> and an UnparseableSettingsError is
// thrown instead (loadSettings keeps swallowing parse errors — it runs on every
// request — so a corrupt file degrades to defaults on the read path).

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./atomic-write.mjs";
import { CLAUDE_TIERS, parseClaudeTierMappings } from "./claude-tier-mapping.mjs";

// Same timestamp format as the config backups (zcode/kimi/dsh merge-config):
// ISO with ":" and "." replaced by "-", safe for Windows file names.
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Two-tier keep-alive: "off" or "enhanced" (whole-turn hold). The retired
// "basic" tier is normalized to "enhanced" everywhere it can still arrive
// (old settings.json, old API clients, ANYSWITCH_KEEPALIVE_MODE).
export const KEEPALIVE_MODES = Object.freeze(["off", "enhanced"]);

export const DEFAULT_KEEPALIVE_CONFIG = Object.freeze({
  enabled: true,
  mode: "enhanced",
  maxRetries: 2,
  backoffMs: 500,
});

export function normalizeKeepAliveMode(rawMode, enabled) {
  if (rawMode === "off") return "off";
  if (rawMode === "enhanced" || rawMode === "basic") return "enhanced";
  if (enabled === false) return "off";
  return "enhanced";
}

/** Sparkline is a last-N request window, not a wall-clock TTL. */
export const DEFAULT_SPARK_WINDOW_POINTS = 16;
export const MIN_SPARK_WINDOW_POINTS = 2;
export const MAX_SPARK_WINDOW_POINTS = 128;

export function parseSparkWindowPoints(raw) {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isInteger(n) || n < MIN_SPARK_WINDOW_POINTS) return DEFAULT_SPARK_WINDOW_POINTS;
  return Math.min(MAX_SPARK_WINDOW_POINTS, n);
}

export const MIN_KEEPALIVE_RETRIES = 0;
export const MAX_KEEPALIVE_RETRIES = 10;

// "Thinking depth injection": when a client sends no effort for a model, the
// relay supplies the library's default level instead, and kimi's global
// `[thinking]` switch is taken over so its default path matches. On by default
// (an absent or malformed value keeps it on; only an explicit false turns it
// off) because the whole feature exists to make the pickers real.
export const DEFAULT_INJECT_THINKING_EFFORT = true;

export function parseInjectThinkingEffort(raw) {
  return raw === false ? false : DEFAULT_INJECT_THINKING_EFFORT;
}

// 运行日志总开关。默认开——日志是排障时唯一的凭据，升级上来的安装必须与旧行为
// 一致，不能因为多出一个开关就默认把记录关掉。只有显式写入 false 才关（缺失、
// 畸形、旧版本没有这个键，全部保持开）。
export const DEFAULT_LOGGING_ENABLED = true;

export function parseLoggingEnabled(raw) {
  return raw === false ? false : DEFAULT_LOGGING_ENABLED;
}

// 实时输出的最低显示级别。默认 info——这一项决定「少看」哪些行，缺失、畸形、旧
// 版本没有这个键，一律按显示全部处理，不能因为读不到值就把日志藏起来。它只管面板
// 的显示出口：日志文件与内存环形缓冲始终记录全部级别，抬级别不会少落一行。
const LOG_LEVELS = ["info", "warn", "error"];
export const DEFAULT_LOG_LEVEL = "info";

export function parseLogLevel(raw) {
  return LOG_LEVELS.includes(raw) ? raw : DEFAULT_LOG_LEVEL;
}

// 以 bypassPermissions 启动 Claude Code：开启后 Anyswitch 拉起 Claude 时带上
// --dangerously-skip-permissions，跳过工具权限确认。默认关——这是把安全确认
// 整个交出去的选项，必须由用户显式打开（缺少或畸形值都保持关闭）。
export const DEFAULT_CLAUDE_BYPASS_PERMISSIONS = false;

export function parseClaudeBypassPermissions(raw) {
  return raw === true ? true : DEFAULT_CLAUDE_BYPASS_PERMISSIONS;
}

// 终端宿主手动关停标记：面板关停终端服务时置真，relay 启动时尊重它、不擅自把
// host 拉回来；手动启动清回 false。默认 false——缺失、畸形、旧版本没有这个键，
// 一律按「从未手动关停」处理，升级上来的安装维持原有的随 relay 拉起行为。
export const DEFAULT_TERMINAL_HOST_MANUAL_STOP = false;

export function parseTerminalHostManualStop(raw) {
  return raw === true ? true : DEFAULT_TERMINAL_HOST_MANUAL_STOP;
}

// Claude Code 档位接管总开关：关掉后四档映射暂停生效（loadSettings 返回空映
// 射，中继每请求现读，两条 relay 路径同时覆盖），但已填写的行保留不清，重新
// 开开关即恢复。默认开——升级上来的安装必须与旧行为逐字节一致。
export const DEFAULT_CLAUDE_TIER_MAPPINGS_ENABLED = true;

export function parseClaudeTierMappingsEnabled(raw) {
  return raw === false ? DEFAULT_CLAUDE_TIER_MAPPINGS_ENABLED === false : DEFAULT_CLAUDE_TIER_MAPPINGS_ENABLED;
}

// Claude 档位映射: the four Claude Code tier entries (sonnet/opus/fable/haiku)
// each optionally name one Anyswitch-hosted model. An unset or blank tier means
// "not taken over", so an unconfigured install relays exactly as before —
// normalisation itself is claude-tier-mapping.mjs#parseClaudeTierMappings.
//
// The panel PATCHes ONE tier at a time (即改即存), so a raw-spread merge of the
// section would drop the other three rows. Merge per tier and treat an empty
// value as clearing that row — the only way back to "not taken over".
function mergeClaudeTierMappings(currentRaw, patchRaw) {
  const merged = { ...parseClaudeTierMappings(currentRaw) };
  for (const tier of CLAUDE_TIERS) {
    if (!Object.prototype.hasOwnProperty.call(patchRaw, tier)) continue;
    const value = patchRaw[tier];
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed.length === 0) delete merged[tier];
    else merged[tier] = trimmed;
  }
  return merged;
}

export function parseKeepAliveMaxRetries(raw) {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isInteger(n) || n < MIN_KEEPALIVE_RETRIES) return DEFAULT_KEEPALIVE_CONFIG.maxRetries;
  return Math.min(MAX_KEEPALIVE_RETRIES, n);
}

// Per-endpoint switches ride under keepAlive.endpoints[agentId].enabled. The key
// stays absent until the user actually switches one endpoint: a missing entry
// (or a missing map) means "inherits the master switch", which makes a fresh
// install all-on without baking any endpoint list into the schema.
function parseKeepAliveEndpoints(rawEndpoints) {
  if (!rawEndpoints || typeof rawEndpoints !== "object" || Array.isArray(rawEndpoints)) return undefined;
  const endpoints = {};
  for (const [agentId, raw] of Object.entries(rawEndpoints)) {
    if (!agentId) continue;
    if (typeof raw === "boolean") {
      endpoints[agentId] = { enabled: raw };
    } else if (raw && typeof raw === "object" && typeof raw.enabled === "boolean") {
      endpoints[agentId] = { enabled: raw.enabled };
    }
  }
  return Object.keys(endpoints).length > 0 ? endpoints : undefined;
}

// One request's effective keep-alive state: master switch AND that endpoint's
// own switch. Both the panel UI and the stream pipe resolve through this so the
// two never drift (unknown/absent endpoint ids inherit the master switch).
export function resolveKeepAliveEnabled(keepAliveConfig, agentId) {
  if (!keepAliveConfig || typeof keepAliveConfig !== "object") return true;
  if (keepAliveConfig.enabled === false) return false;
  if (!agentId) return true;
  const entry = keepAliveConfig.endpoints?.[agentId];
  return !(entry && entry.enabled === false);
}

export function relayDataRoot(base = process.env) {
  return join(
    base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"),
    "Anyswitch",
  );
}

export function defaultSettingsPath(base = process.env) {
  return join(relayDataRoot(base), "settings.json");
}

export function parseKeepAliveConfig(rawKeepAlive, env = process.env) {
  const cfg = { ...DEFAULT_KEEPALIVE_CONFIG };
  if (rawKeepAlive && typeof rawKeepAlive === "object") {
    if (typeof rawKeepAlive.enabled === "boolean") {
      cfg.enabled = rawKeepAlive.enabled;
    }
    if (rawKeepAlive.maxRetries !== undefined) {
      cfg.maxRetries = parseKeepAliveMaxRetries(rawKeepAlive.maxRetries);
    }
    if (typeof rawKeepAlive.backoffMs === "number" && rawKeepAlive.backoffMs >= 0) {
      cfg.backoffMs = rawKeepAlive.backoffMs;
    }
    cfg.mode = normalizeKeepAliveMode(rawKeepAlive.mode, cfg.enabled);
    const endpoints = parseKeepAliveEndpoints(rawKeepAlive.endpoints);
    if (endpoints !== undefined) cfg.endpoints = endpoints;
  }

  // Environment variable override for troubleshooting / diagnostics
  if (env.ANYSWITCH_KEEPALIVE_MODE !== undefined) {
    const m = String(env.ANYSWITCH_KEEPALIVE_MODE).toLowerCase();
    if (m === "off" || m === "basic" || m === "enhanced") cfg.mode = normalizeKeepAliveMode(m);
  } else if (env.ANYSWITCH_KEEPALIVE_ENABLED !== undefined) {
    const on = env.ANYSWITCH_KEEPALIVE_ENABLED === "1" || env.ANYSWITCH_KEEPALIVE_ENABLED === "true";
    cfg.mode = on ? "enhanced" : "off";
  }
  if (env.ANYSWITCH_KEEPALIVE_RETRIES !== undefined) {
    const parsed = Number.parseInt(env.ANYSWITCH_KEEPALIVE_RETRIES, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      cfg.maxRetries = parsed;
    }
  }

  cfg.mode = normalizeKeepAliveMode(cfg.mode, cfg.mode !== "off");
  cfg.enabled = cfg.mode !== "off";
  return cfg;
}

export function loadSettings(settingsPath = defaultSettingsPath(), env = process.env) {
  let raw = {};
  if (existsSync(settingsPath)) {
    try {
      const text = readFileSync(settingsPath, "utf8");
      raw = JSON.parse(text);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        raw = {};
      }
    } catch {
      raw = {};
    }
  }

  const keepAlive = parseKeepAliveConfig(raw.keepAlive, env);
  const sparkWindowPoints = parseSparkWindowPoints(raw.sparkWindowPoints);
  const injectThinkingEffort = parseInjectThinkingEffort(raw.injectThinkingEffort);
  const loggingEnabled = parseLoggingEnabled(raw.loggingEnabled);
  const logLevel = parseLogLevel(raw.logLevel);
  const claudeBypassPermissions = parseClaudeBypassPermissions(raw.claudeBypassPermissions);
  const terminalHostManualStop = parseTerminalHostManualStop(raw.terminalHostManualStop);
  const claudeTierMappingsEnabled = parseClaudeTierMappingsEnabled(raw.claudeTierMappingsEnabled);
  // 总开关关着时四档映射整体不生效：这里返回空映射，handler 与 launch 两条
  // 读取路径都经过 loadSettings，无需各自判断开关。
  const claudeTierMappings = claudeTierMappingsEnabled
    ? parseClaudeTierMappings(raw.claudeTierMappings)
    : {};
  return {
    raw,
    settings: {
      ...raw,
      keepAlive,
      sparkWindowPoints,
      injectThinkingEffort,
      loggingEnabled,
      logLevel,
      claudeBypassPermissions,
      terminalHostManualStop,
      claudeTierMappingsEnabled,
      claudeTierMappings,
    },
    keepAlive,
    sparkWindowPoints,
    injectThinkingEffort,
    loggingEnabled,
    logLevel,
    claudeBypassPermissions,
    terminalHostManualStop,
    claudeTierMappingsEnabled,
    claudeTierMappings,
  };
}

// Mirrors UnparseableConfigError in zcode-merge-config.mjs: a settings file we
// cannot parse must never be treated as empty and then overwritten, or the
// user's entire settings would be lost. The corrupt original is quarantined
// next to it before this error is thrown.
export class UnparseableSettingsError extends Error {
  constructor(filePath, backupPath) {
    super(`refusing to overwrite unparseable settings: ${filePath} (backup: ${backupPath})`);
    this.name = "UnparseableSettingsError";
    this.code = "UNPARSEABLE_SETTINGS";
    this.backupPath = backupPath;
  }
}

export function saveSettings(settingsPath, patch, env = process.env) {
  // Fail closed on a corrupt settings.json: loadSettings deliberately swallows
  // parse errors (launch.mjs calls it on every request), so re-check the raw
  // bytes here — otherwise the merge below would treat the file as empty and
  // the atomic write would silently destroy its contents.
  if (existsSync(settingsPath)) {
    const rawText = readFileSync(settingsPath, "utf8");
    try {
      JSON.parse(rawText);
    } catch {
      const backupPath = `${settingsPath}.corrupt-${timestamp()}`;
      copyFileSync(settingsPath, backupPath);
      throw new UnparseableSettingsError(settingsPath, backupPath);
    }
  }

  const current = loadSettings(settingsPath, env);
  const updated = {
    ...current.raw,
    ...patch,
  };

  // If keepAlive was patched, deep-merge it cleanly
  if (patch.keepAlive && typeof patch.keepAlive === "object") {
    const merged = {
      ...(current.raw.keepAlive || {}),
      ...patch.keepAlive,
    };
    if (typeof patch.keepAlive.mode === "string") {
      merged.mode = normalizeKeepAliveMode(patch.keepAlive.mode, patch.keepAlive.enabled);
      merged.enabled = merged.mode !== "off";
    } else if (typeof patch.keepAlive.enabled === "boolean" && patch.keepAlive.mode === undefined) {
      merged.mode = patch.keepAlive.enabled ? "enhanced" : "off";
    }
    if (Object.prototype.hasOwnProperty.call(patch.keepAlive, "maxRetries")) {
      merged.maxRetries = parseKeepAliveMaxRetries(patch.keepAlive.maxRetries);
    }
    // Endpoint switches merge per endpoint: the panel PATCHes one agentId at a
    // time, and replacing the whole map would drop the other endpoint entries.
    const patchedEndpoints = parseKeepAliveEndpoints(patch.keepAlive.endpoints);
    if (patch.keepAlive.endpoints !== undefined && patchedEndpoints !== undefined) {
      merged.endpoints = { ...(current.raw.keepAlive?.endpoints || {}) };
      for (const [agentId, entry] of Object.entries(patchedEndpoints)) {
        merged.endpoints[agentId] = { ...(merged.endpoints[agentId] || {}), ...entry };
      }
    }
    updated.keepAlive = merged;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "sparkWindowPoints")) {
    updated.sparkWindowPoints = parseSparkWindowPoints(patch.sparkWindowPoints);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "injectThinkingEffort")) {
    updated.injectThinkingEffort = parseInjectThinkingEffort(patch.injectThinkingEffort);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "loggingEnabled")) {
    updated.loggingEnabled = parseLoggingEnabled(patch.loggingEnabled);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "logLevel")) {
    updated.logLevel = parseLogLevel(patch.logLevel);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "claudeBypassPermissions")) {
    updated.claudeBypassPermissions = parseClaudeBypassPermissions(patch.claudeBypassPermissions);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "terminalHostManualStop")) {
    updated.terminalHostManualStop = parseTerminalHostManualStop(patch.terminalHostManualStop);
  }

  // 总开关与四档行各自独立落盘：关开关只暂停生效，行里的值原样保留，重新开启
  // 即恢复，所以这里不触碰 claudeTierMappings。
  if (Object.prototype.hasOwnProperty.call(patch, "claudeTierMappingsEnabled")) {
    updated.claudeTierMappingsEnabled = parseClaudeTierMappingsEnabled(patch.claudeTierMappingsEnabled);
  }

  if (patch.claudeTierMappings && typeof patch.claudeTierMappings === "object" && !Array.isArray(patch.claudeTierMappings)) {
    const merged = mergeClaudeTierMappings(current.raw.claudeTierMappings, patch.claudeTierMappings);
    // No tiers left configured → no key at all, so a cleared panel section and
    // a never-configured one are byte-identical on disk.
    if (Object.keys(merged).length === 0) delete updated.claudeTierMappings;
    else updated.claudeTierMappings = merged;
  }

  // Legacy cleanup: `keepAlive.disabledEndpoints` turns up in on-disk settings
  // files, but no code in this repo's history has ever read or written it. The
  // raw-spread merge above would carry it forward forever, so drop it on any
  // save regardless of which section was patched.
  if (updated.keepAlive && typeof updated.keepAlive === "object") {
    delete updated.keepAlive.disabledEndpoints;
  }

  const text = JSON.stringify(updated, null, 2) + "\n";
  // First boot on an empty data root: the settings directory may not exist
  // yet; atomicWriteFile does not create it, so a save would 500 on ENOENT.
  mkdirSync(dirname(settingsPath), { recursive: true });
  atomicWriteFile(settingsPath, text);
  return loadSettings(settingsPath, env);
}

// One live read of a single setting, for long-lived processes that must honour a
// settings change without being restarted.
//
// This deliberately does NOT cache on mtime. mtime cannot prove the file did not
// change: consecutive saves share an mtimeMs often enough to matter (measured on
// this machine — 33 of 300 back-to-back `saveSettings` pairs, and `birthtimeMs` /
// `ctimeMs` collide right along with it), and a gate keyed on it would keep
// serving the previous value until some later write happened to move the stamp.
// For the 运行日志 switch that means the file keeps growing after the user asked
// it to stop; for 日志级别 it means the panel filters by a stale level. Both are
// exactly what these gates exist to prevent.
//
// The full read costs ~160µs against the real settings.json (measured, 1096
// bytes), the stat probe ~35µs on top. Gates are consulted per log line and per
// streamed frame — averaging well under one call a second in practice, and ~2% of
// one core even at a hundred lines a second. Correctness per call is the cheaper
// bug.
//
// A file that cannot be read at all is a different answer from a file that reads
// but does not parse: loadSettings collapses both into "defaults", but a
// momentarily unreadable file must not flip what a long-lived process is doing,
// so the last known value is kept for that case. The stat is the readability
// probe, never a cache key.
function createSettingGate({ settingsPath, env, initial, read }) {
  let cachedValue = initial;
  return function readGate() {
    try {
      statSync(settingsPath);
      cachedValue = read(loadSettings(settingsPath, env).settings);
    } catch {
      /* unreadable: keep the last known value */
    }
    return cachedValue;
  };
}

// A live read of the 运行日志 switch. relay-host owns the only persisted log file,
// and a switch that only took effect at the next restart would leave that file
// growing exactly when the user asked it to stop.
export function createLoggingEnabledGate(settingsPath = defaultSettingsPath(), env = process.env) {
  return createSettingGate({
    settingsPath,
    env,
    initial: DEFAULT_LOGGING_ENABLED,
    read: (settings) => parseLoggingEnabled(settings.loggingEnabled),
  });
}

// A live read of the 实时输出 level filter. The panel serves this on every log
// frame it forwards, so a selection that only landed after a panel restart would
// leave an already-open window streaming the old levels.
export function createLogLevelGate(settingsPath = defaultSettingsPath(), env = process.env) {
  return createSettingGate({
    settingsPath,
    env,
    initial: DEFAULT_LOG_LEVEL,
    read: (settings) => parseLogLevel(settings.logLevel),
  });
}
