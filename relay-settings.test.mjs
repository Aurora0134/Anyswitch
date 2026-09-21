import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_KEEPALIVE_CONFIG,
  DEFAULT_SPARK_WINDOW_POINTS,
  parseKeepAliveConfig,
  resolveKeepAliveEnabled,
  parseSparkWindowPoints,
  parseInjectThinkingEffort,
  DEFAULT_INJECT_THINKING_EFFORT,
  loadSettings,
  saveSettings,
} from "./relay-settings.mjs";

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

    const tmp = mkdtempSync(join(tmpdir(), "anyswitch-settings-migrate-"));
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
    const tmp = mkdtempSync(join(tmpdir(), "anyswitch-settings-test-"));
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
    const tmp = mkdtempSync(join(tmpdir(), "anyswitch-settings-spark-"));
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
    const tmp = mkdtempSync(join(tmpdir(), "anyswitch-settings-corrupt-"));
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
    const tmp = mkdtempSync(join(tmpdir(), "anyswitch-settings-noroot-"));
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
    const tmp = mkdtempSync(join(tmpdir(), "anyswitch-settings-clean-"));
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
    const tmp = mkdtempSync(join(tmpdir(), "anyswitch-settings-retries-"));
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
    const tmp = mkdtempSync(join(tmpdir(), "anyswitch-settings-retries-env-"));
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
    const tmp = mkdtempSync(join(tmpdir(), "anyswitch-effort-setting-"));
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
    const tmp = mkdtempSync(join(tmpdir(), "anyswitch-settings-endpoints-"));
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
    const tmp = mkdtempSync(join(tmpdir(), "anyswitch-settings-legacy-"));
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
