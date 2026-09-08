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
  buildQoderProviders,
  managedConnectionId,
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

describe("managedConnectionId", () => {
  it("returns a deterministic qoder-custom-anyswitch-<hash> id", () => {
    const id = managedConnectionId("poke-api");
    assert.match(id, /^qoder-custom-anyswitch-[0-9a-f]{16}$/);
    // Same input → same id (deterministic).
    assert.equal(id, managedConnectionId("poke-api"));
    // Different provider ids → different connection ids.
    assert.notEqual(id, managedConnectionId("nvidia-nim"));
  });
});

describe("buildQoderProviders", () => {
  it("builds one connection per provider keyed by managedConnectionId", () => {
    const managedProviders = extractManagedProviders(STORE);
    const providers = buildQoderProviders(managedProviders, PORT, TOKEN);
    const keys = Object.keys(providers).sort();
    assert.deepEqual(keys, [managedConnectionId("nvidia-nim"), managedConnectionId("poke-api")].sort());

    const poke = providers[managedConnectionId("poke-api")];
    assert.equal(poke.baseUrl, `http://127.0.0.1:${PORT}/openai/poke-api/v1`);
    assert.equal(poke.apiKey, TOKEN);
    assert.equal(poke.type, "openai-compatible");
    assert.equal(poke.protocol, "openai");
    assert.equal(poke.authType, "bearer");
    assert.equal(poke.displayName, "Poke API");
    assert.equal(poke.models.length, 2);
    // connection.model defaults to the first model entry
    assert.equal(poke.model, poke.models[0].model);
  });

  it("emits the full model entry shape including capabilities/thinking", () => {
    const providers = {
      "test-p": {
        models: {
          "test-model": { displayName: "Test", contextWindow: 999000, isVision: true, isReasoning: true },
        },
      },
    };
    const map = buildQoderProviders(providers, PORT, TOKEN);
    const conn = map[managedConnectionId("test-p")];
    assert.equal(conn.models.length, 1);
    const m = conn.models[0];
    assert.equal(m.model, "test-model");
    assert.equal(m.displayName, "Test");
    assert.equal(m.contextWindow, 999000);
    assert.deepEqual(m.capabilities, {
      vision: true,
      thinking: {
        modes: ["enabled"],
        supportsEffort: false,
        supportedEffortLevels: [],
      },
    });
  });

  it("uses store contextWindow when present, tier fallback when absent", () => {
    const providers = {
      "test-p": {
        models: {
          explicit: { displayName: "Explicit", contextWindow: 999000 },
          "claude-opus-5": { displayName: "Opus" },
        },
      },
    };
    const map = buildQoderProviders(providers, PORT, TOKEN);
    const models = Object.fromEntries(map[managedConnectionId("test-p")].models.map((m) => [m.model, m]));
    assert.equal(models.explicit.contextWindow, 999000);
    // claude-opus tier → 1M per context-fallback.mjs
    assert.equal(models["claude-opus-5"].contextWindow, 1_000_000);
  });

  it("uses modelId as displayName when displayName is absent", () => {
    const providers = {
      "test-p": {
        models: {
          "some-model": {},
        },
      },
    };
    const map = buildQoderProviders(providers, PORT, TOKEN);
    assert.equal(map[managedConnectionId("test-p")].models[0].displayName, "some-model");
  });

  it("skips providers whose models array is empty", () => {
    const providers = {
      "empty-p": { models: {} },
      "real-p": { models: { m: {} } },
    };
    const map = buildQoderProviders(providers, PORT, TOKEN);
    assert.equal(map[managedConnectionId("empty-p")], undefined);
    assert.ok(map[managedConnectionId("real-p")]);
  });

  it("honours baseUrlSegment for pseudo-channels (auto routing)", () => {
    const providers = {
      auto: {
        channelName: "自动路由",
        baseUrlSegment: "poke-api",
        models: { auto: { displayName: "auto" } },
      },
    };
    const map = buildQoderProviders(providers, PORT, TOKEN);
    const conn = map[managedConnectionId("auto")];
    // The base URL points at the chain HEAD node, not at a literal "auto" segment.
    assert.equal(conn.baseUrl, `http://127.0.0.1:${PORT}/openai/poke-api/v1`);
    assert.equal(conn.displayName, "自动路由");
  });
});

describe("mergeQoderSettings", () => {
  it("writes managed connections into settings.providers", () => {
    const managedProviders = extractManagedProviders(STORE);
    const { config, managed } = mergeQoderSettings({}, managedProviders, PORT, TOKEN);
    assert.deepEqual(managed.sort(), ["nvidia-nim", "poke-api"]);

    const providers = config.providers;
    assert.ok(providers, "settings.providers must exist");
    const poke = providers[managedConnectionId("poke-api")];
    assert.ok(poke, "poke-api connection injected");
    assert.equal(poke.baseUrl, `http://127.0.0.1:${PORT}/openai/poke-api/v1`);
    assert.equal(poke.apiKey, TOKEN);
    assert.equal(poke.type, "openai-compatible");
    assert.equal(poke.protocol, "openai");
    assert.equal(poke.authType, "bearer");
    assert.equal(poke.displayName, "Poke API");
    assert.equal(poke.models.length, 2);
    assert.ok(providers[managedConnectionId("nvidia-nim")], "nvidia-nim connection injected");
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
    assert.ok(config.providers[managedConnectionId("poke-api")]);
  });

  it("preserves user-created providers entries untouched", () => {
    const existing = {
      providers: {
        "qoder-custom-user-built": {
          baseUrl: "https://user.example/v1",
          apiKey: "user-key",
          type: "openai-compatible",
          protocol: "openai",
          authType: "bearer",
          displayName: "My Own",
          model: "m1",
          models: [{ model: "m1", displayName: "M1", contextWindow: 128000, capabilities: { vision: false, thinking: { modes: [], supportsEffort: false, supportedEffortLevels: [] } } }],
        },
      },
    };
    const managedProviders = extractManagedProviders(STORE);
    const { config } = mergeQoderSettings(existing, managedProviders, PORT, TOKEN);
    assert.ok(config.providers["qoder-custom-user-built"], "user BYOK entry preserved");
    assert.equal(config.providers["qoder-custom-user-built"].apiKey, "user-key");
    // Managed entries layered alongside.
    assert.ok(config.providers[managedConnectionId("poke-api")]);
  });

  it("deletes previously-managed connections listed in previousManagedIds", () => {
    const staleId = managedConnectionId("old-provider");
    const existing = {
      providers: {
        [staleId]: {
          baseUrl: "http://127.0.0.1:1/openai/old/v1",
          apiKey: "old",
          type: "openai-compatible",
          protocol: "openai",
          authType: "bearer",
          displayName: "Old",
          model: "old-model",
          models: [{ model: "old-model", displayName: "Old", contextWindow: 128000, capabilities: { vision: false, thinking: { modes: [], supportsEffort: false, supportedEffortLevels: [] } } }],
        },
        "qoder-custom-user-built": { displayName: "Keep me", models: [{ model: "x" }] },
      },
    };
    const managedProviders = extractManagedProviders(STORE);
    const { config } = mergeQoderSettings(existing, managedProviders, PORT, TOKEN, [staleId]);
    assert.equal(config.providers[staleId], undefined, "stale managed connection removed");
    assert.ok(config.providers["qoder-custom-user-built"], "user entry survives stale cleanup");
    assert.ok(config.providers[managedConnectionId("poke-api")], "current managed set injected");
  });

  it("replaces the current managed set even without previousManagedIds (idempotent re-sync)", () => {
    const managedProviders = extractManagedProviders(STORE);
    const first = mergeQoderSettings({}, managedProviders, PORT, TOKEN);
    // Second merge over the first result with no previousManagedIds: the
    // currentManagedIds deletion pass must still drop the old managed entries
    // before re-adding them, so no duplicates/stale keys accumulate.
    const second = mergeQoderSettings(first.config, managedProviders, PORT, TOKEN);
    assert.deepEqual(Object.keys(second.config.providers).sort(), Object.keys(first.config.providers).sort());
  });

  it("removes the dead modelConfigs.customModels array", () => {
    const existing = {
      modelConfigs: {
        customModels: [
          { provider: "_poke-api", apiKey: "old", model: "old-model", key: "_poke-api/old-model" },
        ],
        otherModelConfigField: "preserved",
      },
    };
    const managedProviders = extractManagedProviders(STORE);
    const { config } = mergeQoderSettings(existing, managedProviders, PORT, TOKEN);
    assert.equal(config.modelConfigs.customModels, undefined, "dead customModels removed");
    assert.equal(config.modelConfigs.otherModelConfigField, "preserved", "other modelConfigs fields preserved");
  });

  it("drops the modelConfigs key entirely when customModels was its only field", () => {
    const existing = {
      modelConfigs: { customModels: [{ model: "x" }] },
    };
    const { config } = mergeQoderSettings(existing, extractManagedProviders(STORE), PORT, TOKEN);
    assert.equal(config.modelConfigs, undefined, "empty modelConfigs shell removed");
  });

  it("tolerates a non-object existing value", () => {
    const { config } = mergeQoderSettings(null, extractManagedProviders(STORE), PORT, TOKEN);
    assert.ok(config.providers[managedConnectionId("poke-api")]);
  });
});

describe("writeQoderSettingsWithBackup", () => {
  it("writes data and creates backup for existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-merge-test-"));
    const filePath = join(dir, "settings.json");
    writeFileSync(filePath, JSON.stringify({ providers: {} }), "utf8");
    const result = writeQoderSettingsWithBackup(filePath, { providers: { "qoder-custom-anyswitch-x": { model: "new" } } });
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);
    assert.ok(result.backupPath);
    const written = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(written.providers["qoder-custom-anyswitch-x"].model, "new");
  });

  it("reports unchanged when content hash matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-merge-test-"));
    const filePath = join(dir, "settings.json");
    const data = { providers: {} };
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
    writeFileSync(filePath, JSON.stringify({ providers: {} }), "utf8");
    const result = writeQoderSettingsWithBackup(filePath, { providers: { "qoder-custom-anyswitch-x": { model: "new" } } });
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

  it("reads a missing sidecar as an empty managed list", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-merge-test-"));
    assert.deepEqual(readSidecar(dir), { providers: [] });
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

  it("injects the auto connection when the endpoint has a route chain", () => {
    const auto = deriveAutoRouteChannel(CHAIN_STORE, "qoder");
    const { config, managed } = mergeQoderSettings(
      {},
      extractManagedProviders(CHAIN_STORE),
      PORT,
      TOKEN,
      [],
      auto,
    );
    const autoConn = config.providers[managedConnectionId("auto")];
    assert.ok(autoConn, "auto connection must be injected");
    assert.equal(autoConn.displayName, "自动路由");
    assert.equal(autoConn.apiKey, TOKEN);
    // The base URL points at the chain HEAD node, not at a literal "auto" segment.
    assert.equal(autoConn.baseUrl, `http://127.0.0.1:${PORT}/openai/poke-api/v1`);
    assert.deepEqual(autoConn.models.map((m) => m.model), ["auto"]);
    assert.ok(managed.includes("auto"), "sidecar tracks the auto channel as managed");
  });

  it("does not inject auto when the endpoint has no route chain", () => {
    const { config, managed } = mergeQoderSettings(
      {},
      extractManagedProviders(STORE),
      PORT,
      TOKEN,
      [],
      deriveAutoRouteChannel(STORE, "qoder"),
    );
    assert.equal(config.providers[managedConnectionId("auto")], undefined);
    assert.ok(!managed.includes("auto"));
  });

  it("cleans up auto on the re-sync after the chain is deleted", () => {
    const first = mergeQoderSettings(
      {},
      extractManagedProviders(CHAIN_STORE),
      PORT,
      TOKEN,
      [],
      deriveAutoRouteChannel(CHAIN_STORE, "qoder"),
    );
    assert.ok(first.config.providers[managedConnectionId("auto")]);
    const second = mergeQoderSettings(
      first.config,
      extractManagedProviders(STORE),
      PORT,
      TOKEN,
      first.managed.map(managedConnectionId),
      deriveAutoRouteChannel(STORE, "qoder"),
    );
    assert.equal(second.config.providers[managedConnectionId("auto")], undefined, "stale auto removed once the chain is gone");
    assert.ok(second.config.providers[managedConnectionId("poke-api")], "real channels survive the cleanup");
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
    assert.ok(written.providers[managedConnectionId("poke-api")]);
    assert.ok(written.providers[managedConnectionId("nvidia-nim")]);
    assert.equal(written.providers[managedConnectionId("poke-api")].models.length, 2);

    // Sidecar was written with provider ids (not connection ids).
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
    const autoConn = written.providers[managedConnectionId("auto")];
    assert.ok(autoConn, "auto connection must be present");
    assert.equal(autoConn.baseUrl, `http://127.0.0.1:${PORT}/openai/poke-api/v1`);
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
    assert.ok(written.providers[managedConnectionId("poke-api")]);
  });

  it("cleans up stale connections via sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-write-test-"));
    const settingsPath = join(dir, ".qoder", "settings.json");

    // First sync: both providers
    writeQoderConfig(STORE, PORT, TOKEN, dir, settingsPath);
    let written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.ok(written.providers[managedConnectionId("nvidia-nim")]);

    // Second sync: remove nvidia-nim from store
    const reducedStore = {
      version: 2,
      providers: { "poke-api": STORE.providers["poke-api"] },
    };
    const result = writeQoderConfig(reducedStore, PORT, TOKEN, dir, settingsPath);
    assert.equal(result.ok, true);

    written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(written.providers[managedConnectionId("nvidia-nim")], undefined, "removed provider's connection dropped");
    assert.ok(written.providers[managedConnectionId("poke-api")], "remaining provider survives");

    // Sidecar now tracks only poke-api.
    assert.deepEqual(readSidecar(dir).providers, ["poke-api"]);
  });

  it("removes dead customModels from an existing settings.json on write", () => {
    const dir = mkdtempSync(join(tmpdir(), "qoder-write-test-"));
    const settingsPath = join(dir, ".qoder", "settings.json");
    mkdirSync(join(dir, ".qoder"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ modelConfigs: { customModels: [{ model: "dead" }], keep: 1 } }),
      "utf8",
    );
    const result = writeQoderConfig(STORE, PORT, TOKEN, dir, settingsPath);
    assert.equal(result.ok, true);
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(written.modelConfigs.customModels, undefined);
    assert.equal(written.modelConfigs.keep, 1);
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
    // The broken file must be left untouched.
    assert.equal(readFileSync(settingsPath, "utf8"), "{ broken json");
  });
});

describe("qoderSettingsPath", () => {
  it("resolves to <base>/.qoder/settings.json", () => {
    assert.equal(qoderSettingsPath("/home/user"), join("/home/user", ".qoder", "settings.json"));
  });
});
