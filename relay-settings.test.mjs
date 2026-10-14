import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_KEEPALIVE_CONFIG,
  DEFAULT_SPARK_WINDOW_POINTS,
  parseKeepAliveConfig,
  resolveKeepAliveEnabled,
  parseSparkWindowPoints,
  parseInjectThinkingEffort,
  DEFAULT_INJECT_THINKING_EFFORT,
  DEFAULT_LOGGING_ENABLED,
  parseLoggingEnabled,
  createLoggingEnabledGate,
  DEFAULT_LOG_LEVEL,
  parseLogLevel,
  createLogLevelGate,
  parseClaudeBypassPermissions,
  parseTerminalHostManualStop,
  DEFAULT_TERMINAL_HOST_MANUAL_STOP,
  parseTerminalRestoreSessions,
  DEFAULT_TERMINAL_RESTORE_SESSIONS,
  parseClaudeTierMappingsEnabled,
  parseCredentialCacheEnabled,
  DEFAULT_CREDENTIAL_CACHE_ENABLED,
  createCredentialCacheEnabledGate,
  parseAutoDownloadUpdates,
  DEFAULT_AUTO_DOWNLOAD_UPDATES,
  loadSettings,
  saveSettings,
} from "./relay-settings.mjs";
import { parseClaudeTierMappings } from "./claude-tier-mapping.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

describe("relay-settings", () => {
  it("uses default enabled=true when no config exists", () => {
    const cfg = parseKeepAliveConfig(undefined, {});
    assert.deepEqual(cfg, DEFAULT_KEEPALIVE_CONFIG);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.mode, "enhanced");
    assert.equal(cfg.maxRetries, 2);
  });

  it("maps legacy enabled=false to mode=off and enabled=true to mode=enhanced", () => {
    const off = parseKeepAliveConfig({ enabled: false }, {});
    assert.equal(off.mode, "off");
    assert.equal(off.enabled, false);
    const on = parseKeepAliveConfig({ enabled: true }, {});
    assert.equal(on.mode, "enhanced");
    assert.equal(on.enabled, true);
  });

  it("honors explicit mode and keeps enabled in sync", () => {
    const enhanced = parseKeepAliveConfig({ mode: "enhanced" }, {});
    assert.equal(enhanced.mode, "enhanced");
    assert.equal(enhanced.enabled, true);
    const off = parseKeepAliveConfig({ mode: "off" }, {});
    assert.equal(off.mode, "off");
    assert.equal(off.enabled, false);
  });

  it("migrates the retired basic mode to enhanced (config, env, and save patches)", () => {
    // Two-tier keep-alive: "basic" is not a valid mode, so every surface that
    // can still receive it must land on "enhanced".
    const fromConfig = parseKeepAliveConfig({ mode: "basic" }, {});
    assert.equal(fromConfig.mode, "enhanced");
    assert.equal(fromConfig.enabled, true);

    const fromEnv = parseKeepAliveConfig({}, { ANYSWITCH_KEEPALIVE_MODE: "basic" });
    assert.equal(fromEnv.mode, "enhanced");
    assert.equal(fromEnv.enabled, true);

    const tmp = mkTestDir("anyswitch-settings-migrate-");
    const path = join(tmp, "settings.json");
    try {
      // Production settings.json shape before the two-tier merge.
      writeFileSync(path, JSON.stringify({ keepAlive: { enabled: true, mode: "basic" } }));
      const loaded = loadSettings(path, {});
      assert.equal(loaded.keepAlive.mode, "enhanced");
      assert.equal(loaded.keepAlive.enabled, true);

      // An old client POSTing mode: "basic" is normalized on save too.
      const saved = saveSettings(path, { keepAlive: { mode: "basic" } }, {});
      assert.equal(saved.keepAlive.mode, "enhanced");
      assert.equal(saved.keepAlive.enabled, true);
      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(onDisk.keepAlive.mode, "enhanced");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("honors explicitly configured settings", () => {
    const cfg = parseKeepAliveConfig({ enabled: false, maxRetries: 2, backoffMs: 100 }, {});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.maxRetries, 2);
    assert.equal(cfg.backoffMs, 100);
  });

  it("allows environment variable override", () => {
    const cfg1 = parseKeepAliveConfig({ enabled: true }, { ANYSWITCH_KEEPALIVE_ENABLED: "0" });
    assert.equal(cfg1.enabled, false);

    const cfg2 = parseKeepAliveConfig({}, { ANYSWITCH_KEEPALIVE_RETRIES: "3" });
    assert.equal(cfg2.maxRetries, 3);
  });

  it("loads from disk, preserves extra keys, and atomic writes patches", () => {
    const tmp = mkTestDir("anyswitch-settings-test-");
    const path = join(tmp, "settings.json");
    try {
      writeFileSync(path, JSON.stringify({ followAgentLaunch: true, customKey: 123 }));

      const loaded = loadSettings(path, {});
      assert.equal(loaded.settings.followAgentLaunch, true);
      assert.equal(loaded.settings.customKey, 123);
      assert.equal(loaded.keepAlive.enabled, true);

      // Save a patch toggling keepAlive off
      const saved = saveSettings(path, { keepAlive: { enabled: false } }, {});
      assert.equal(saved.keepAlive.enabled, false);
      assert.equal(saved.keepAlive.mode, "off");
      assert.equal(saved.settings.followAgentLaunch, true);
      assert.equal(saved.settings.customKey, 123);

      // Re-read independently
      const reloaded = loadSettings(path, {});
      assert.equal(reloaded.keepAlive.enabled, false);
      assert.equal(reloaded.keepAlive.mode, "off");

      const enhanced = saveSettings(path, { keepAlive: { mode: "enhanced" } }, {});
      assert.equal(enhanced.keepAlive.mode, "enhanced");
      assert.equal(enhanced.keepAlive.enabled, true);
      assert.equal(reloaded.settings.followAgentLaunch, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("defaults spark window to 16 request nodes and clamps out-of-range values", () => {
    assert.equal(parseSparkWindowPoints(undefined), DEFAULT_SPARK_WINDOW_POINTS);
    assert.equal(parseSparkWindowPoints(1), DEFAULT_SPARK_WINDOW_POINTS);
    assert.equal(parseSparkWindowPoints(16), 16);
    assert.equal(parseSparkWindowPoints(64), 64);
    assert.equal(parseSparkWindowPoints(999), 128);
    assert.equal(parseSparkWindowPoints("24"), 24);
  });

  it("persists sparkWindowPoints as a last-N request window", () => {
    const tmp = mkTestDir("anyswitch-settings-spark-");
    const path = join(tmp, "settings.json");
    try {
      const loaded = loadSettings(path, {});
      assert.equal(loaded.sparkWindowPoints, 16);
      const saved = saveSettings(path, { sparkWindowPoints: 24 }, {});
      assert.equal(saved.sparkWindowPoints, 24);
      assert.equal(loadSettings(path, {}).sparkWindowPoints, 24);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("quarantines a corrupt settings.json instead of overwriting it", () => {
    const tmp = mkTestDir("anyswitch-settings-corrupt-");
    const path = join(tmp, "settings.json");
    try {
      const corrupt = '{ "keepAlive": { "enabled": true, '; // truncated JSON
      writeFileSync(path, corrupt);
      assert.throws(
        () => saveSettings(path, { keepAlive: { enabled: false } }, {}),
        (err) => err.name === "UnparseableSettingsError" && err.code === "UNPARSEABLE_SETTINGS",
      );
      // The corrupt original is left untouched on disk...
      assert.equal(readFileSync(path, "utf8"), corrupt);
      // ...and a timestamped backup carries the same bytes.
      const backups = readdirSync(tmp).filter((f) => f.startsWith("settings.json.corrupt-"));
      assert.equal(backups.length, 1);
      assert.match(backups[0], /^settings\.json\.corrupt-\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
      assert.equal(readFileSync(join(tmp, backups[0]), "utf8"), corrupt);
      // loadSettings still degrades to defaults instead of throwing.
      assert.equal(loadSettings(path, {}).keepAlive.enabled, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("saves successfully when the settings root directory does not exist yet", () => {
    const tmp = mkTestDir("anyswitch-settings-noroot-");
    try {
      // First boot on an empty data root: nested missing directories.
      const path = join(tmp, "missing", "settings.json");
      const saved = saveSettings(path, { keepAlive: { enabled: false } }, {});
      assert.equal(saved.keepAlive.enabled, false);
      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(onDisk.keepAlive.enabled, false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("leaves no corrupt backup behind on a normal save", () => {
    const tmp = mkTestDir("anyswitch-settings-clean-");
    const path = join(tmp, "settings.json");
    try {
      saveSettings(path, { keepAlive: { enabled: false } }, {});
      assert.deepEqual(readdirSync(tmp), ["settings.json"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("parses keepAlive maxRetries as an integer clamped to 0-10, default 2", () => {
    assert.equal(parseKeepAliveConfig({}, {}).maxRetries, 2);
    assert.equal(parseKeepAliveConfig({ maxRetries: 0 }, {}).maxRetries, 0);
    assert.equal(parseKeepAliveConfig({ maxRetries: 5 }, {}).maxRetries, 5);
    assert.equal(parseKeepAliveConfig({ maxRetries: 99 }, {}).maxRetries, 10);
    assert.equal(parseKeepAliveConfig({ maxRetries: -2 }, {}).maxRetries, 2);
    assert.equal(parseKeepAliveConfig({ maxRetries: 1.5 }, {}).maxRetries, 2);
    assert.equal(parseKeepAliveConfig({ maxRetries: "4" }, {}).maxRetries, 4);
  });

  it("persists keepAlive.maxRetries via saveSettings and clamps out-of-range values", () => {
    const tmp = mkTestDir("anyswitch-settings-retries-");
    const path = join(tmp, "settings.json");
    try {
      const saved = saveSettings(path, { keepAlive: { maxRetries: 3 } }, {});
      assert.equal(saved.keepAlive.maxRetries, 3);
      // mode untouched by a retries-only patch
      assert.equal(saved.keepAlive.mode, "enhanced");
      assert.equal(loadSettings(path, {}).keepAlive.maxRetries, 3);

      const over = saveSettings(path, { keepAlive: { maxRetries: 42 } }, {});
      assert.equal(over.keepAlive.maxRetries, 10);
      const under = saveSettings(path, { keepAlive: { maxRetries: -5 } }, {});
      assert.equal(under.keepAlive.maxRetries, 2);
      assert.equal(loadSettings(path, {}).keepAlive.maxRetries, 2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ANYSWITCH_KEEPALIVE_RETRIES overrides the persisted value and is not clamped to 10", () => {
    const tmp = mkTestDir("anyswitch-settings-retries-env-");
    const path = join(tmp, "settings.json");
    try {
      writeFileSync(path, JSON.stringify({ keepAlive: { maxRetries: 2 } }));
      assert.equal(loadSettings(path, {}).keepAlive.maxRetries, 2);
      assert.equal(loadSettings(path, { ANYSWITCH_KEEPALIVE_RETRIES: "7" }).keepAlive.maxRetries, 7);
      assert.equal(loadSettings(path, { ANYSWITCH_KEEPALIVE_RETRIES: "20" }).keepAlive.maxRetries, 20);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("injectThinkingEffort", () => {
  it("turns off only for an explicit false", () => {
    assert.equal(DEFAULT_INJECT_THINKING_EFFORT, true);
    assert.equal(parseInjectThinkingEffort(undefined), true);
    assert.equal(parseInjectThinkingEffort(false), false);
    assert.equal(parseInjectThinkingEffort(true), true);
    assert.equal(parseInjectThinkingEffort("false"), true, "a stray string is not a user's off switch");
  });

  it("survives a save round-trip without disturbing neighbouring keys", () => {
    const tmp = mkTestDir("anyswitch-effort-setting-");
    const path = join(tmp, "settings.json");
    try {
      writeFileSync(path, JSON.stringify({ followAgent: true, sparkWindowPoints: 24 }));
      assert.equal(loadSettings(path, {}).injectThinkingEffort, true);

      const saved = saveSettings(path, { injectThinkingEffort: false }, {});
      assert.equal(saved.settings.injectThinkingEffort, false);
      assert.equal(saved.settings.followAgent, true);
      assert.equal(saved.settings.sparkWindowPoints, 24);
      assert.equal(loadSettings(path, {}).injectThinkingEffort, false);

      const malformed = saveSettings(path, { injectThinkingEffort: "nonsense" }, {});
      assert.equal(malformed.settings.injectThinkingEffort, true, "stored value stays canonical");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("loggingEnabled", () => {
  it("records by default — only an explicit false turns it off", () => {
    assert.equal(DEFAULT_LOGGING_ENABLED, true);
    assert.equal(parseLoggingEnabled(undefined), true);
    assert.equal(parseLoggingEnabled(true), true);
    assert.equal(parseLoggingEnabled(false), false);
    assert.equal(parseLoggingEnabled("false"), true, "a stray string is not a user's off switch");
  });

  it("survives a save round-trip without disturbing neighbouring keys", () => {
    const tmp = mkTestDir("anyswitch-logging-setting-");
    const path = join(tmp, "settings.json");
    try {
      writeFileSync(path, JSON.stringify({ followAgent: true, sparkWindowPoints: 24 }));
      assert.equal(loadSettings(path, {}).settings.loggingEnabled, true, "an install predating the switch keeps recording");

      const saved = saveSettings(path, { loggingEnabled: false }, {});
      assert.equal(saved.settings.loggingEnabled, false);
      assert.equal(saved.settings.followAgent, true);
      assert.equal(saved.settings.sparkWindowPoints, 24);
      assert.equal(loadSettings(path, {}).settings.loggingEnabled, false);

      const malformed = saveSettings(path, { loggingEnabled: "nonsense" }, {});
      assert.equal(malformed.settings.loggingEnabled, true, "stored value stays canonical");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the live gate follows the file, so a long-lived process needs no restart", () => {
    const tmp = mkTestDir("anyswitch-logging-gate-");
    const path = join(tmp, "settings.json");
    try {
      const gate = createLoggingEnabledGate(path, {});
      assert.equal(gate(), true, "missing settings.json still records");

      saveSettings(path, { loggingEnabled: false }, {});
      assert.equal(gate(), false, "the switch takes effect on the next write");

      saveSettings(path, { loggingEnabled: true }, {});
      assert.equal(gate(), true, "and back on again");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to the default — recording ON — when settings.json is corrupt", () => {
    const tmp = mkTestDir("anyswitch-logging-gate-broken-");
    const path = join(tmp, "settings.json");
    try {
      saveSettings(path, { loggingEnabled: false }, {});
      const gate = createLoggingEnabledGate(path, {});
      assert.equal(gate(), false);

      // loadSettings deliberately swallows parse errors (it runs on every
      // request), so a corrupt file reads as defaults. For this switch that
      // means recording RESUMES — the right failure direction: a damaged file
      // must not be able to silently stop recording, and the log path must
      // never throw. The corrupt file is quarantined by saveSettings, so the
      // user is not left with a silently-ignored setting.
      writeFileSync(path, "{ not json");
      assert.equal(gate(), true, "a corrupt file must not silently stop recording");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the last known value while settings.json is unreadable", () => {
    const tmp = mkTestDir("anyswitch-logging-gate-missing-");
    const path = join(tmp, "settings.json");
    try {
      saveSettings(path, { loggingEnabled: false }, {});
      const gate = createLoggingEnabledGate(path, {});
      assert.equal(gate(), false);
      // A vanished file (no mtime to compare) keeps the last known state rather
      // than flipping recording back on mid-session.
      rmSync(path, { force: true });
      assert.equal(gate(), false, "an unreadable file keeps the last known state");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("logLevel", () => {
  it("accepts exactly the three levels this bus knows", () => {
    assert.equal(parseLogLevel("info"), "info");
    assert.equal(parseLogLevel("warn"), "warn");
    assert.equal(parseLogLevel("error"), "error");
  });

  it("falls back to showing everything on anything unrecognised", () => {
    // 这一项决定「少看」哪些行，所以认不出来的值必须回到「全看」：一个拼错的
    // debug、一份大写字母、一个旧版本根本没写过的键，都不该让窗口安静下来。
    assert.equal(parseLogLevel(undefined), "info");
    assert.equal(parseLogLevel(null), "info");
    assert.equal(parseLogLevel("debug"), "info");
    assert.equal(parseLogLevel("WARN"), "info");
    assert.equal(parseLogLevel(42), "info");
    assert.equal(DEFAULT_LOG_LEVEL, "info", "默认值就是「显示全部」那一档");
  });

  it("exposes logLevel through loadSettings and keeps it canonical through saveSettings", () => {
    const tmp = mkTestDir("anyswitch-loglevel-");
    const path = join(tmp, "settings.json");
    try {
      assert.equal(loadSettings(path, {}).settings.logLevel, "info", "未落盘时为 info");

      const saved = saveSettings(path, { logLevel: "warn" }, {});
      assert.equal(saved.settings.logLevel, "warn");
      assert.equal(loadSettings(path, {}).settings.logLevel, "warn");

      const bogus = saveSettings(path, { logLevel: "trace" }, {});
      assert.equal(bogus.settings.logLevel, "info", "畸形值不落盘成畸形值");

      const other = saveSettings(path, { sparkWindowPoints: 30 }, {});
      assert.equal(other.settings.logLevel, "info", "改别的设置项不会把这一项挤掉");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the live gate follows the file, so an open panel needs no restart", () => {
    const tmp = mkTestDir("anyswitch-loglevel-gate-");
    const path = join(tmp, "settings.json");
    try {
      const gate = createLogLevelGate(path, {});
      assert.equal(gate(), "info", "missing settings.json shows everything");

      saveSettings(path, { logLevel: "error" }, {});
      assert.equal(gate(), "error", "selection takes effect on the next frame");

      saveSettings(path, { logLevel: "warn" }, {});
      assert.equal(gate(), "warn", "and back down again");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("follows a save even when mtime never moves", () => {
    // 这条钉的是闸门的一个真实失效模式：它若按 mtime 判断文件动没动，就会被同刻度的
    // 连写骗过去——本机实测 300 对连续保存里 33 对共享同一个 mtimeMs，而且
    // birthtimeMs / ctimeMs 跟着一起撞。那样它会一直端着旧值，直到某次「运气好」的
    // 写入把刻度挪开，而那次写入可能永远不来。这里把 mtime 钉死不动，两次保存都必须
    // 立刻跟到。
    const tmp = mkTestDir("anyswitch-loglevel-gate-tick-");
    const path = join(tmp, "settings.json");
    const pinned = new Date(Date.UTC(2026, 9, 3, 12, 0, 0));
    const writePinned = (logLevel) => {
      saveSettings(path, { logLevel }, {});
      utimesSync(path, pinned, pinned);
    };
    try {
      const gate = createLogLevelGate(path, {});
      writePinned("error");
      assert.equal(gate(), "error");

      writePinned("warn");
      assert.equal(statSync(path).mtimeMs, pinned.getTime(),
        "前提成立：两次保存的 mtime 一模一样，按 mtime 缓存的闸门必然看不见这次变化");
      assert.equal(gate(), "warn", "刻度没动也必须当场跟到新值");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to showing everything when settings.json is corrupt", () => {
    const tmp = mkTestDir("anyswitch-loglevel-gate-broken-");
    const path = join(tmp, "settings.json");
    try {
      saveSettings(path, { logLevel: "error" }, {});
      const gate = createLogLevelGate(path, {});
      assert.equal(gate(), "error");

      // loadSettings swallows parse errors and reads defaults, so a damaged file
      // widens the view back to "everything" — the right direction for a filter
      // whose whole job is hiding lines. (Saving over a corrupt file is a
      // separate, deliberate refusal: see UnparseableSettingsError.)
      writeFileSync(path, "{ not json");
      assert.equal(gate(), "info", "a corrupt file must not keep lines hidden");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the last known filter while settings.json is unreadable", () => {
    const tmp = mkTestDir("anyswitch-loglevel-gate-missing-");
    const path = join(tmp, "settings.json");
    try {
      saveSettings(path, { logLevel: "error" }, {});
      const gate = createLogLevelGate(path, {});
      assert.equal(gate(), "error");
      // A vanished file has no mtime to compare, so the gate holds instead of
      // re-widening the view under an already-open window.
      rmSync(path, { force: true });
      assert.equal(gate(), "error", "an unreadable file keeps the last known filter");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("keepAlive per-endpoint switches", () => {
  it("leaves endpoints absent until something is stored, so a fresh install is all-on", () => {
    const cfg = parseKeepAliveConfig({ mode: "enhanced" }, {});
    assert.equal(cfg.endpoints, undefined);
    assert.deepEqual(cfg, DEFAULT_KEEPALIVE_CONFIG);
  });

  it("normalizes stored endpoint entries to {enabled} and drops malformed ones", () => {
    const cfg = parseKeepAliveConfig({
      endpoints: { claude: { enabled: false }, kimi: true, zcode: { enabled: "no" }, "": { enabled: false }, opencode: null },
    }, {});
    assert.deepEqual(cfg.endpoints, { claude: { enabled: false }, kimi: { enabled: true } });
  });

  it("resolves an endpoint as enabled when it was never switched, and only then", () => {
    const on = parseKeepAliveConfig({}, {});
    assert.equal(resolveKeepAliveEnabled(on, "claude"), true);
    assert.equal(resolveKeepAliveEnabled(on, null), true);

    const withOff = parseKeepAliveConfig({ endpoints: { claude: { enabled: false } } }, {});
    assert.equal(resolveKeepAliveEnabled(withOff, "claude"), false);
    assert.equal(resolveKeepAliveEnabled(withOff, "kimi"), true, "an untouched endpoint inherits the master switch");

    const masterOff = parseKeepAliveConfig({ endpoints: { claude: { enabled: true } }, enabled: false }, {});
    assert.equal(resolveKeepAliveEnabled(masterOff, "claude"), false, "the master switch wins");
  });

  it("merges endpoint patches per endpoint instead of replacing the whole map", () => {
    const tmp = mkTestDir("anyswitch-settings-endpoints-");
    const path = join(tmp, "settings.json");
    try {
      saveSettings(path, { keepAlive: { endpoints: { claude: { enabled: false } } } }, {});
      const second = saveSettings(path, { keepAlive: { endpoints: { kimi: { enabled: false } } } }, {});
      assert.deepEqual(second.keepAlive.endpoints, {
        claude: { enabled: false },
        kimi: { enabled: false },
      });

      const flipped = saveSettings(path, { keepAlive: { endpoints: { claude: { enabled: true } } } }, {});
      assert.deepEqual(flipped.keepAlive.endpoints, {
        claude: { enabled: true },
        kimi: { enabled: false },
      });
      assert.equal(flipped.keepAlive.mode, "enhanced", "endpoint patches leave the master switch alone");

      const untouched = saveSettings(path, { keepAlive: { maxRetries: 4 } }, {});
      assert.deepEqual(untouched.keepAlive.endpoints, {
        claude: { enabled: true },
        kimi: { enabled: false },
      });
      assert.deepEqual(loadSettings(path, {}).keepAlive.endpoints, {
        claude: { enabled: true },
        kimi: { enabled: false },
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("legacy keepAlive keys", () => {
  it("scrubs the never-consumed disabledEndpoints key on any save", () => {
    const tmp = mkTestDir("anyswitch-settings-legacy-");
    const path = join(tmp, "settings.json");
    try {
      writeFileSync(path, JSON.stringify({
        keepAlive: { enabled: true, disabledEndpoints: [], endpoints: { claude: { enabled: false } } },
      }));
      // The scrub is not tied to keepAlive patches: any save drops the key.
      const saved = saveSettings(path, { sparkWindowPoints: 24 }, {});
      assert.equal("disabledEndpoints" in saved.raw.keepAlive, false);
      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      assert.equal("disabledEndpoints" in onDisk.keepAlive, false);
      assert.deepEqual(onDisk.keepAlive.endpoints, { claude: { enabled: false } }, "live keys survive the scrub");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("claudeTierMappings", () => {
  it("normalises to configured tiers only", () => {
    assert.deepEqual(
      parseClaudeTierMappings({ sonnet: "anthropic/a/m", opus: "", gpt: "x", haiku: 7 }),
      { sonnet: "anthropic/a/m" },
    );
    for (const unusable of [undefined, null, "sonnet", 3, []]) {
      assert.deepEqual(parseClaudeTierMappings(unusable), {});
    }
  });

  it("merges per tier, because the panel saves one row at a time", () => {
    const tmp = mkTestDir("anyswitch-tier-mapping-");
    const path = join(tmp, "settings.json");
    try {
      writeFileSync(path, JSON.stringify({ followAgent: true }));

      saveSettings(path, { claudeTierMappings: { sonnet: "anthropic/a/kimi-k3" } }, {});
      const afterSecond = saveSettings(path, { claudeTierMappings: { haiku: "anthropic/b/flash" } }, {});
      assert.deepEqual(afterSecond.claudeTierMappings, {
        sonnet: "anthropic/a/kimi-k3",
        haiku: "anthropic/b/flash",
      });
      assert.equal(afterSecond.settings.followAgent, true, "neighbouring settings ride through");

      // Clearing one row leaves the other standing.
      const cleared = saveSettings(path, { claudeTierMappings: { sonnet: "  " } }, {});
      assert.deepEqual(cleared.claudeTierMappings, { haiku: "anthropic/b/flash" });

      // Last row cleared → the key is gone, so an unset section and an emptied
      // one are the same bytes on disk.
      const emptied = saveSettings(path, { claudeTierMappings: { haiku: "" } }, {});
      assert.deepEqual(emptied.claudeTierMappings, {});
      assert.equal("claudeTierMappings" in JSON.parse(readFileSync(path, "utf8")), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("drops tiers the map does not know, so a stale row cannot match anything", () => {
    const tmp = mkTestDir("anyswitch-tier-legacy-");
    const path = join(tmp, "settings.json");
    try {
      writeFileSync(path, JSON.stringify({ claudeTierMappings: { subagent: "anthropic/a/m", opus: "anthropic/b/m" } }));
      // The read path normalises the stale row away before the relay can see it…
      assert.deepEqual(loadSettings(path, {}).claudeTierMappings, { opus: "anthropic/b/m" });
      // …and any save scrubs it from disk rather than carrying it forward, while
      // the tiers that ARE known keep their values.
      const saved = saveSettings(path, { claudeTierMappings: { sonnet: "anthropic/c/m" } }, {});
      assert.deepEqual(saved.claudeTierMappings, { sonnet: "anthropic/c/m", opus: "anthropic/b/m" });
      assert.equal("subagent" in JSON.parse(readFileSync(path, "utf8")).claudeTierMappings, false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("claudeTierMappingsEnabled", () => {
  it("defaults to on, so an upgrade keeps the old behaviour byte for byte", () => {
    assert.equal(parseClaudeTierMappingsEnabled(undefined), true);
    assert.equal(parseClaudeTierMappingsEnabled("nonsense"), true);
    assert.equal(parseClaudeTierMappingsEnabled(true), true);
    assert.equal(parseClaudeTierMappingsEnabled(false), false);
  });

  it("off pauses takeover without erasing the configured rows", () => {
    const tmp = mkTestDir("anyswitch-tier-enabled-");
    const path = join(tmp, "settings.json");
    try {
      saveSettings(path, { claudeTierMappings: { sonnet: "anthropic/a/m", haiku: "anthropic/b/m" } }, {});
      const off = saveSettings(path, { claudeTierMappingsEnabled: false }, {});
      // The relay reads through loadSettings: off means no tier is taken over.
      assert.deepEqual(off.claudeTierMappings, {});
      assert.equal(off.settings.claudeTierMappingsEnabled, false);
      // The rows themselves survive on disk and come back when re-enabled.
      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      assert.deepEqual(onDisk.claudeTierMappings, { sonnet: "anthropic/a/m", haiku: "anthropic/b/m" });
      const on = saveSettings(path, { claudeTierMappingsEnabled: true }, {});
      assert.deepEqual(on.claudeTierMappings, { sonnet: "anthropic/a/m", haiku: "anthropic/b/m" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("claudeBypassPermissions", () => {
  it("defaults to off: only an explicit true turns it on", () => {
    assert.equal(parseClaudeBypassPermissions(undefined), false);
    assert.equal(parseClaudeBypassPermissions("true"), false);
    assert.equal(parseClaudeBypassPermissions(true), true);
  });

  it("persists across saves and rides the settings payload the panel reads", () => {
    const tmp = mkTestDir("anyswitch-bypass-");
    const path = join(tmp, "settings.json");
    try {
      const off = loadSettings(path, {});
      assert.equal(off.settings.claudeBypassPermissions, false);
      const saved = saveSettings(path, { claudeBypassPermissions: true }, {});
      assert.equal(saved.settings.claudeBypassPermissions, true);
      assert.equal(loadSettings(path, {}).settings.claudeBypassPermissions, true);
      const back = saveSettings(path, { claudeBypassPermissions: false }, {});
      assert.equal(back.settings.claudeBypassPermissions, false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("autoDownloadUpdates", () => {
  it("defaults to off: only an explicit true turns it on", () => {
    assert.equal(DEFAULT_AUTO_DOWNLOAD_UPDATES, false);
    assert.equal(parseAutoDownloadUpdates(undefined), false);
    assert.equal(parseAutoDownloadUpdates("true"), false);
    assert.equal(parseAutoDownloadUpdates(1), false);
    assert.equal(parseAutoDownloadUpdates(false), false);
    assert.equal(parseAutoDownloadUpdates(true), true);
  });

  it("round-trips through saveSettings and survives unrelated patches", () => {
    const tmp = mkTestDir("anyswitch-auto-download-");
    const path = join(tmp, "settings.json");
    try {
      assert.equal(loadSettings(path, {}).settings.autoDownloadUpdates, false, "an install predating the key keeps auto-download off");
      const on = saveSettings(path, { autoDownloadUpdates: true }, {});
      assert.equal(on.settings.autoDownloadUpdates, true);
      assert.equal(loadSettings(path, {}).settings.autoDownloadUpdates, true);
      const other = saveSettings(path, { sparkWindowPoints: 30 }, {});
      assert.equal(other.settings.autoDownloadUpdates, true, "改别的设置项不会把它挤掉");
      const off = saveSettings(path, { autoDownloadUpdates: false }, {});
      assert.equal(off.settings.autoDownloadUpdates, false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("terminalHostManualStop", () => {
  it("defaults to off: only an explicit true marks a manual stop", () => {
    assert.equal(DEFAULT_TERMINAL_HOST_MANUAL_STOP, false);
    assert.equal(parseTerminalHostManualStop(undefined), false);
    assert.equal(parseTerminalHostManualStop("true"), false);
    assert.equal(parseTerminalHostManualStop(1), false);
    assert.equal(parseTerminalHostManualStop(true), true);
  });

  it("round-trips through saveSettings and survives unrelated patches", () => {
    const tmp = mkTestDir("anyswitch-terminal-stop-");
    const path = join(tmp, "settings.json");
    try {
      assert.equal(loadSettings(path, {}).settings.terminalHostManualStop, false, "an install predating the key starts the host as before");

      const stopped = saveSettings(path, { terminalHostManualStop: true }, {});
      assert.equal(stopped.settings.terminalHostManualStop, true);
      assert.equal(loadSettings(path, {}).settings.terminalHostManualStop, true);

      const other = saveSettings(path, { sparkWindowPoints: 30 }, {});
      assert.equal(other.settings.terminalHostManualStop, true, "改别的设置项不会把这个标记挤掉");

      const back = saveSettings(path, { terminalHostManualStop: false }, {});
      assert.equal(back.settings.terminalHostManualStop, false);
      assert.equal(loadSettings(path, {}).settings.terminalHostManualStop, false);

      const malformed = saveSettings(path, { terminalHostManualStop: "yes" }, {});
      assert.equal(malformed.settings.terminalHostManualStop, false, "stored value stays canonical");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("terminalRestoreSessions", () => {
  it("stays on unless explicitly switched off", () => {
    assert.equal(DEFAULT_TERMINAL_RESTORE_SESSIONS, true);
    assert.equal(parseTerminalRestoreSessions(undefined), true);
    assert.equal(parseTerminalRestoreSessions(true), true);
    assert.equal(parseTerminalRestoreSessions(false), false);
    assert.equal(parseTerminalRestoreSessions("false"), true, "a stray string is not a user's off switch");
    assert.equal(parseTerminalRestoreSessions(0), true);
  });

  it("round-trips through saveSettings and survives unrelated patches", () => {
    const tmp = mkTestDir("anyswitch-restore-sessions-");
    const path = join(tmp, "settings.json");
    try {
      writeFileSync(path, JSON.stringify({ terminalHostManualStop: true, sparkWindowPoints: 24 }));
      assert.equal(loadSettings(path, {}).settings.terminalRestoreSessions, true, "an install predating the key restores as before");

      const off = saveSettings(path, { terminalRestoreSessions: false }, {});
      assert.equal(off.settings.terminalRestoreSessions, false);
      assert.equal(loadSettings(path, {}).settings.terminalRestoreSessions, false);
      assert.equal(JSON.parse(readFileSync(path, "utf8")).terminalRestoreSessions, false, "落盘的值就是关闭");
      assert.equal(off.settings.terminalHostManualStop, true, "邻键不受影响");
      assert.equal(off.settings.sparkWindowPoints, 24);

      const other = saveSettings(path, { sparkWindowPoints: 30 }, {});
      assert.equal(other.settings.terminalRestoreSessions, false, "改别的设置项不会把这个开关挤掉");

      const back = saveSettings(path, { terminalRestoreSessions: true }, {});
      assert.equal(back.settings.terminalRestoreSessions, true);
      assert.equal(loadSettings(path, {}).settings.terminalRestoreSessions, true);

      const malformed = saveSettings(path, { terminalRestoreSessions: "no" }, {});
      assert.equal(malformed.settings.terminalRestoreSessions, true, "stored value stays canonical");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("credentialCacheEnabled", () => {
  it("defaults to ON: only an explicit false turns caching off", () => {
    // 默认开是有意的：每请求一次的密钥读取要起一个外部进程，是链路上最脆的一环，
    // 而升级上来的安装不该因为多出一个开关就默默退回更慢、更容易失败的路径。
    assert.equal(DEFAULT_CREDENTIAL_CACHE_ENABLED, true);
    assert.equal(parseCredentialCacheEnabled(undefined), true);
    assert.equal(parseCredentialCacheEnabled("false"), true, "畸形值按缺省处理，不误关");
    assert.equal(parseCredentialCacheEnabled(0), true);
    assert.equal(parseCredentialCacheEnabled(true), true);
    assert.equal(parseCredentialCacheEnabled(false), false);
  });

  it("round-trips through saveSettings and survives unrelated patches", () => {
    const tmp = mkTestDir("anyswitch-cred-cache-");
    const path = join(tmp, "settings.json");
    try {
      assert.equal(loadSettings(path, {}).settings.credentialCacheEnabled, true, "全新安装默认开");
      const off = saveSettings(path, { credentialCacheEnabled: false }, {});
      assert.equal(off.settings.credentialCacheEnabled, false);
      assert.equal(loadSettings(path, {}).settings.credentialCacheEnabled, false);
      const other = saveSettings(path, { sparkWindowPoints: 24 }, {});
      assert.equal(other.settings.credentialCacheEnabled, false, "改别的设置项不会把它挤掉");
      const back = saveSettings(path, { credentialCacheEnabled: true }, {});
      assert.equal(back.settings.credentialCacheEnabled, true);
      const malformed = saveSettings(path, { credentialCacheEnabled: "yes" }, {});
      assert.equal(malformed.settings.credentialCacheEnabled, true, "stored value stays canonical");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the live gate follows the file, so a switch flipped off takes effect without a restart", () => {
    // relay 是长活进程；关掉缓存的意图是「别再留着明文了」，如果这个开关要等重启
    // 才生效，就等于没关。
    const tmp = mkTestDir("anyswitch-cred-gate-");
    const path = join(tmp, "settings.json");
    try {
      const gate = createCredentialCacheEnabledGate(path, {});
      assert.equal(gate(), true, "缺省开");
      saveSettings(path, { credentialCacheEnabled: false }, {});
      assert.equal(gate(), false, "落盘后立刻读到关");
      saveSettings(path, { credentialCacheEnabled: true }, {});
      assert.equal(gate(), true, "再打开同样立刻生效");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
