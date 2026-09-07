import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readQoderSettings,
  writeQoderSettingsWithBackup,
  UnparseableQoderSettingsError,
  mergeQoderSettings,
  buildQoderCustomModels,
  extractManagedProviders,
  readSidecar,
  writeSidecar,
  sidecarPath,
  deriveAutoRouteChannel,
  writeQoderConfig,
  qoderSettingsPath,
} from "./qoder-merge-config.mjs";

const STORE = {
  version: 2,
  providers: {
    "poke-api": {
      displayName: "Poke API",
      baseURL: "https://upstream.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "poke-api.dpapi",
      models: {
        "claude-opus-5": { displayName: "Claude Opus 5" },
        "claude-sonnet-5": { displayName: "Claude Sonnet 5" },
      },
    },
    "nvidia-nim": {
      displayName: "NVIDIA NIM",
      baseURL: "https://nim.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "nvidia-nim.dpapi",
      models: {
        "deepseek-chat": { displayName: "DeepSeek Chat" },
      },
    },
  },
};

const TOKEN = "a".repeat(64);
const PORT = 47821;

describe("readQoderSettings", () => {
  it("returns empty object for missing file", () => {
    assert.deepEqual(readQoderSettings(join(tmpdir(), "nonexistent-qoder.json")), {});
  });

  it("throws UnparseableQoderSettingsError for a corrupt file instead of treating it as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-merge-test-"));
    const filePath = join(dir, "settings.json");
    writeFileSync(filePath, "{ not valid json", "utf8");
    assert.throws(() => readQoderSettings(filePath), UnparseableQoderSettingsError);
    // The original file must be left untouched.
    assert.equal(readFileSync(filePath, "utf8"), "{ not valid json");
  });

  it("parses a UTF-8 BOM-prefixed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-merge-test-"));
    const filePath = join(dir, "settings.json");
    writeFileSync(filePath, "\uFEFF" + JSON.stringify({ enabledPlugins: { foo: true } }), "utf8");
    const parsed = readQoderSettings(filePath);
    assert.ok(parsed.enabledPlugins.foo);
  });
});

describe("mergeQoderSettings", () => {
  it("writes providers as per-model customModels entries", () => {
    const managedProviders = extractManagedProviders(STORE);
    const { config, managed } = mergeQoderSettings({}, managedProviders, PORT, TOKEN);
    const models = config.modelConfigs.customModels;
    // poke-api has 2 models, nvidia-nim has 1 → 3 entries total
    assert.equal(models.length, 3);
    assert.deepEqual(managed.sort(), ["nvidia-nim", "poke-api"]);

    const opus = models.find((m) => m.key === "_poke-api/claude-opus-5");
    assert.ok(opus);
    assert.equal(opus.provider, "_poke-api");
    assert.equal(opus.model, "claude-opus-5");
    assert.equal(opus.apiKey, TOKEN);
    assert.equal(opus.baseURL, `http://127.0.0.1:${PORT}/openai/poke-api/v1`);
    assert.equal(opus.format, "openai");
    assert.equal(opus.displayName, "Claude Opus 5");
    assert.equal(typeof opus.maxInputTokens, "number");
  });

  it("preserves non-managed settings.json fields", () => {
    const existing = {
      enabledPlugins: { "qoder-context@qoderapp-bundler": true },
      theme: "dark",
      fontSize: 14,
    };
    const managedProviders = extractManagedProviders(STORE);
    const { config } = mergeQoderSettings(existing, managedProviders, PORT, TOKEN);
    assert.deepEqual(config.enabledPlugins, { "qoder-context@qoderapp-bundler": true });
    assert.equal(config.theme, "dark");
    assert.equal(config.fontSize, 14);
    assert.ok(Array.isArray(config.modelConfigs.customModels));
  });

  it("replaces the entire customModels array (stale entries removed)", () => {
    const existing = {
      modelConfigs: {
        customModels: [
          { provider: "_old-provider", apiKey: "old", model: "old-model", key: "_old-provider/old-model", displayName: "Old", baseURL: "http://old", format: "openai", maxInputTokens: 128000 },
        ],
        otherModelConfigField: "preserved",
      },
    };
    const managedProviders = extractManagedProviders(STORE);
    const { config } = mergeQoderSettings(existing, managedProviders, PORT, TOKEN);
    // Old entry is gone, replaced by managed entries
    assert.equal(config.modelConfigs.customModels.length, 3);
    assert.ok(!config.modelConfigs.customModels.find((m) => m.provider === "_old-provider"));
    // Other modelConfigs fields preserved
    assert.equal(config.modelConfigs.otherModelConfigField, "preserved");
  });
});

describe("buildQoderCustomModels", () => {
  it("uses store contextWindow when present", () => {
    const providers = {
      "test-p": {
        models: {
          "test-model": { displayName: "Test", contextWindow: 999000 },
        },
      },
    };
    const entries = buildQoderCustomModels(providers, PORT, TOKEN);
    assert.equal(entries[0].maxInputTokens, 999000);
  });

  it("falls back to tier-based contextWindow when store has none", () => {
    const providers = {
      "test-p": {
        models: {
          "claude-opus-5": { displayName: "Opus" },
        },
      },
    };
    const entries = buildQoderCustomModels(providers, PORT, TOKEN);
    // claude-opus tier → 1M per context-fallback.mjs
    assert.equal(entries[0].maxInputTokens, 1_000_000);
  });

  it("uses modelId as displayName when displayName is absent", () => {
    const providers = {
      "test-p": {
        models: {
          "some-model": {},
        },
      },
    };
    const entries = buildQoderCustomModels(providers, PORT, TOKEN);
    assert.equal(entries[0].displayName, "some-model");
  });
});

describe("writeQoderSettingsWithBackup", () => {
  it("writes data and creates backup for existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-merge-test-"));
    const filePath = join(dir, "settings.json");
    writeFileSync(filePath, JSON.stringify({ modelConfigs: { customModels: [] } }), "utf8");
    const result = writeQoderSettingsWithBackup(filePath, { modelConfigs: { customModels: [{ model: "new" }] } });
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);
    assert.ok(result.backupPath);
    const written = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(written.modelConfigs.customModels[0].model, "new");
  });

  it("reports unchanged when content hash matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-merge-test-"));
    const filePath = join(dir, "settings.json");
    const data = { modelConfigs: { customModels: [] } };
    writeQoderSettingsWithBackup(filePath, data);
    const result = writeQoderSettingsWithBackup(filePath, data);
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
  });

  it("prunes backups down to the newest 5 after a write", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-merge-test-"));
    const filePath = join(dir, "settings.json");
    for (let i = 1; i <= 6; i++) {
      writeFileSync(join(dir, `settings.backup.2020-01-0${i}T00-00-00-000Z.json`), `old${i}`, "utf8");
    }
    writeFileSync(filePath, JSON.stringify({ modelConfigs: {} }), "utf8");
    const result = writeQoderSettingsWithBackup(filePath, { modelConfigs: { customModels: [{ model: "new" }] } });
    assert.equal(result.ok, true);
    const backups = readdirSync(dir).filter((n) => n.startsWith("settings.backup.")).sort();
    assert.equal(backups.length, 5);
    assert.equal(backups[0], "settings.backup.2020-01-03T00-00-00-000Z.json", "oldest backups pruned");
    assert.ok(backups.includes(result.backupPath.split(/[\\/]/).pop()), "fresh backup kept");
  });
});

describe("sidecar", () => {
  it("round-trips managed provider ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-merge-test-"));
    writeSidecar(dir, ["poke-api", "nvidia-nim"]);
    assert.deepEqual(readSidecar(dir).providers, ["nvidia-nim", "poke-api"]);
    assert.equal(sidecarPath(dir), join(dir, "qoder-sidecar.json"));
  });
});

describe("auto routing channel (_auto)", () => {
  const CHAIN_STORE = {
    ...STORE,
    routingChains: {
      qoder: {
        chain: [
          { node: "poke-api", model: "claude-opus-5" },
          { node: "nvidia-nim", model: "deepseek-chat" },
        ],
      },
    },
  };

  it("injects the _auto entry when the endpoint has a route chain", () => {
    const auto = deriveAutoRouteChannel(CHAIN_STORE, "qoder");
    const { config, managed } = mergeQoderSettings(
      {},
      extractManagedProviders(CHAIN_STORE),
      PORT,
      TOKEN,
      auto,
    );
    const autoEntry = config.modelConfigs.customModels.find((m) => m.key === "_auto/auto");
    assert.ok(autoEntry, "_auto entry must be injected");
    assert.equal(autoEntry.provider, "_auto");
    assert.equal(autoEntry.model, "auto");
    assert.equal(autoEntry.apiKey, TOKEN);
    // The base URL points at the chain HEAD node, not at a literal "auto" segment.
    assert.equal(autoEntry.baseURL, `http://127.0.0.1:${PORT}/openai/poke-api/v1`);
    assert.equal(autoEntry.format, "openai");
    assert.ok(managed.includes("auto"), "sidecar tracks the _auto channel as managed");
  });

  it("does not inject _auto when the endpoint has no route chain", () => {
    const { config, managed } = mergeQoderSettings(
      {},
      extractManagedProviders(STORE),
      PORT,
      TOKEN,
      deriveAutoRouteChannel(STORE, "qoder"),
    );
    assert.equal(config.modelConfigs.customModels.find((m) => m.key === "_auto/auto"), undefined);
    assert.ok(!managed.includes("auto"));
  });

  it("cleans up _auto on the re-sync after the chain is deleted", () => {
    const first = mergeQoderSettings(
      {},
      extractManagedProviders(CHAIN_STORE),
      PORT,
      TOKEN,
      deriveAutoRouteChannel(CHAIN_STORE, "qoder"),
    );
    assert.ok(first.config.modelConfigs.customModels.find((m) => m.key === "_auto/auto"));
    const second = mergeQoderSettings(
      first.config,
      extractManagedProviders(STORE),
      PORT,
      TOKEN,
      deriveAutoRouteChannel(STORE, "qoder"),
    );
    assert.equal(second.config.modelConfigs.customModels.find((m) => m.key === "_auto/auto"), undefined, "stale _auto removed once the chain is gone");
    assert.ok(second.config.modelConfigs.customModels.find((m) => m.key === "_poke-api/claude-opus-5"), "real channels survive the cleanup");
    assert.ok(!second.managed.includes("auto"));
  });
});

describe("writeQoderConfig (high-level)", () => {
  it("basic merge with providers", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-write-test-"));
    const settingsPath = join(dir, ".qoder", "settings.json");
    const result = writeQoderConfig(STORE, PORT, TOKEN, dir, settingsPath);
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(written.modelConfigs.customModels.length, 3);
    assert.ok(written.modelConfigs.customModels.find((m) => m.key === "_poke-api/claude-opus-5"));
    assert.ok(written.modelConfigs.customModels.find((m) => m.key === "_nvidia-nim/deepseek-chat"));

    // Sidecar was written
    const sidecar = readSidecar(dir);
    assert.deepEqual(sidecar.providers.sort(), ["nvidia-nim", "poke-api"]);
  });

  it("includes auto channel when chain exists", () => {
    const chainStore = {
      ...STORE,
      routingChains: {
        qoder: {
          chain: [{ node: "poke-api", model: "claude-opus-5" }],
        },
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "qoder-write-test-"));
    const settingsPath = join(dir, ".qoder", "settings.json");
    const result = writeQoderConfig(chainStore, PORT, TOKEN, dir, settingsPath);
    assert.equal(result.ok, true);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    const autoEntry = written.modelConfigs.customModels.find((m) => m.key === "_auto/auto");
    assert.ok(autoEntry, "_auto entry must be present");
    assert.equal(autoEntry.baseURL, `http://127.0.0.1:${PORT}/openai/poke-api/v1`);
  });

  it("preserves non-managed settings.json fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-write-test-"));
    const settingsPath = join(dir, ".qoder", "settings.json");
    mkdirSync(join(dir, ".qoder"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ enabledPlugins: { "qoder-context@qoderapp-bundler": true }, theme: "dark" }),
      "utf8",
    );
    const result = writeQoderConfig(STORE, PORT, TOKEN, dir, settingsPath);
    assert.equal(result.ok, true);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(written.enabledPlugins, { "qoder-context@qoderapp-bundler": true });
    assert.equal(written.theme, "dark");
    assert.ok(Array.isArray(written.modelConfigs.customModels));
  });

  it("cleans up stale entries via sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-write-test-"));
    const settingsPath = join(dir, ".qoder", "settings.json");

    // First sync: both providers
    writeQoderConfig(STORE, PORT, TOKEN, dir, settingsPath);
    let written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(written.modelConfigs.customModels.length, 3);

    // Second sync: remove nvidia-nim from store
    const reducedStore = {
      version: 2,
      providers: { "poke-api": STORE.providers["poke-api"] },
    };
    const result = writeQoderConfig(reducedStore, PORT, TOKEN, dir, settingsPath);
    assert.equal(result.ok, true);

    written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(written.modelConfigs.customModels.length, 2);
    assert.ok(!written.modelConfigs.customModels.find((m) => m.key.startsWith("_nvidia-nim/")));
    assert.ok(written.modelConfigs.customModels.find((m) => m.key === "_poke-api/claude-opus-5"));
  });

  it("returns unchanged for empty store with no providers and no chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-write-test-"));
    const settingsPath = join(dir, ".qoder", "settings.json");
    const emptyStore = { version: 2, providers: {} };
    const result = writeQoderConfig(emptyStore, PORT, TOKEN, dir, settingsPath);
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.equal(result.reason, "no Anyswitch providers with models");
  });

  it("content-hash skip: no-op when settings are already up to date", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-write-test-"));
    const settingsPath = join(dir, ".qoder", "settings.json");

    const first = writeQoderConfig(STORE, PORT, TOKEN, dir, settingsPath);
    assert.equal(first.ok, true);
    assert.equal(first.unchanged, false);

    const second = writeQoderConfig(STORE, PORT, TOKEN, dir, settingsPath);
    assert.equal(second.ok, true);
    assert.equal(second.unchanged, true);
  });

  it("returns error for unparseable settings.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-write-test-"));
    const settingsPath = join(dir, ".qoder", "settings.json");
    mkdirSync(join(dir, ".qoder"), { recursive: true });
    writeFileSync(settingsPath, "{ broken json", "utf8");
    const result = writeQoderConfig(STORE, PORT, TOKEN, dir, settingsPath);
    assert.equal(result.ok, false);
    assert.equal(result.unchanged, true);
    assert.ok(result.reason.includes("unparseable"));
  });
});

describe("qoderSettingsPath", () => {
  it("resolves to <base>/.qoder/settings.json", () => {
    assert.equal(qoderSettingsPath("/home/user"), join("/home/user", ".qoder", "settings.json"));
  });
});
