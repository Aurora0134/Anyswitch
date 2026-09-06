// Persistent settings manager for Anyswitch.
//
// Reads and writes %LOCALAPPDATA%\Anyswitch\settings.json with atomic replacements.
// Provides sensible defaults (e.g. keepAlive enabled by default).
// Preserves any existing arbitrary keys in settings.json. saveSettings refuses
// to overwrite a settings.json that fails to parse: the corrupt file is copied
// to settings.json.corrupt-<timestamp> and an UnparseableSettingsError is
// thrown instead (loadSettings keeps swallowing parse errors — it runs on every
// request — so a corrupt file degrades to defaults on the read path).

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./atomic-write.mjs";

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

export function parseKeepAliveMaxRetries(raw) {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isInteger(n) || n < MIN_KEEPALIVE_RETRIES) return DEFAULT_KEEPALIVE_CONFIG.maxRetries;
  return Math.min(MAX_KEEPALIVE_RETRIES, n);
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
  return {
    raw,
    settings: {
      ...raw,
      keepAlive,
      sparkWindowPoints,
    },
    keepAlive,
    sparkWindowPoints,
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
    updated.keepAlive = merged;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "sparkWindowPoints")) {
    updated.sparkWindowPoints = parseSparkWindowPoints(patch.sparkWindowPoints);
  }

  const text = JSON.stringify(updated, null, 2) + "\n";
  // First boot on an empty data root: the settings directory may not exist
  // yet; atomicWriteFile does not create it, so a save would 500 on ENOENT.
  mkdirSync(dirname(settingsPath), { recursive: true });
  atomicWriteFile(settingsPath, text);
  return loadSettings(settingsPath, env);
}
