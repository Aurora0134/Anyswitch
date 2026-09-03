import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDshProviderEntry,
  mergeDshSettings,
  readDshSettings,
  writeDshSettingsWithBackup,
  extractManagedProviders,
  readSidecar,
  writeSidecar,
  validateDshSettings,
  UnparseableDshSettingsError,
  getYamlModule,
  deriveAutoRouteChannel,
} from "./dsh-merge-config.mjs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("buildDshProviderEntry creates valid dsh profile", () => {
  const provider = {
    models: {
      "deepseek-chat": {
        displayName: "DeepSeek V3",
        contextWindow: 64000,
        maxOutputTokens: 8000,
      },
    },
  };
  const entry = buildDshProviderEntry("deepseek", provider, 47821);
  assert.ok(entry._deepseek);
  assert.equal(entry._deepseek.displayName, "deepseek");
  assert.equal(entry._deepseek.api, "openai-completions");
  assert.equal(entry._deepseek.baseURL, "http://127.0.0.1:47821/openai/deepseek/v1");
  assert.equal(entry._deepseek.apiKeyEnv, "ANYSWITCH_RELAY_TOKEN");
  assert.deepEqual(entry._deepseek.headers, { "x-agent-id": "dsh" });
  assert.equal(entry._deepseek.models.length, 1);
  assert.equal(entry._deepseek.models[0].id, "deepseek-chat");
  assert.equal(entry._deepseek.models[0].name, "DeepSeek V3");
  assert.equal(entry._deepseek.models[0].contextWindow, 64000);
  assert.equal(entry._deepseek.models[0].maxTokens, 8000);
});

test("buildDshProviderEntry attaches compat and reasoningEfforts when reasoning configured", () => {
  const provider = {
    reasoningVariants: ["low", "high"],
    models: {
      "r1": {
        displayName: "DeepSeek R1",
        contextWindow: 128000,
      },
    },
  };
  const entry = buildDshProviderEntry("deepseek-r1", provider, 47821);
  assert.ok(entry["_deepseek-r1"].compat);
  assert.equal(entry["_deepseek-r1"].compat.thinkingFormat, "deepseek");
  assert.equal(entry["_deepseek-r1"].compat.supportsReasoningEffort, true);
  assert.deepEqual(entry["_deepseek-r1"].models[0].reasoningEfforts, {
    off: null,
    low: "low",
    high: "high",
  });
});

test("buildDshProviderEntry falls back to the pi-ai knowledge base by model id", () => {
  // Store carries no reasoning metadata at all — today's production shape —
  // so the knowledge tier is the only thing that can produce efforts.
  const knowledge = new Map([
    ["glm-5.2", {
      hasMap: true,
      levels: ["low", "medium", "high", "max"],
      wireValues: { minimal: null, low: "high", medium: "high", high: "high", max: "max" },
      thinkingFormat: "zai",
    }],
    ["kimi-k3", {
      hasMap: true,
      levels: ["low", "high", "max"],
      wireValues: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
      thinkingFormat: "openai",
    }],
    ["embedding-bge-m3", {
      hasMap: true,
      levels: [],
      wireValues: { enabled: "auto", off: null },
      thinkingFormat: "deepseek",
    }],
  ]);
  const provider = {
    models: {
      "glm-5.2": { displayName: "GLM 5.2" },
      "kimi-k3": {},
      "embedding-bge-m3": {},
    },
  };
  const entry = buildDshProviderEntry("vendorb", provider, 47821, knowledge);
  const models = Object.fromEntries(entry._vendorb.models.map((m) => [m.id, m]));

  // glm-5.2: DSH "low" dispatches as zai wire "high"
  assert.deepEqual(models["glm-5.2"].reasoningEfforts, {
    off: null,
    low: "high",
    medium: "high",
    high: "high",
    max: "max",
  });
  assert.equal(models["glm-5.2"].compat.thinkingFormat, "zai");

  // kimi-k3: wire values match level names; per-model openai format
  assert.deepEqual(models["kimi-k3"].reasoningEfforts, {
    off: null,
    low: "low",
    high: "high",
    max: "max",
  });
  assert.equal(models["kimi-k3"].compat.thinkingFormat, "openai");

  // embedding-bge-m3: binary toggle collapses to off/low
  assert.deepEqual(models["embedding-bge-m3"].reasoningEfforts, {
    off: null,
    low: "auto",
  });

  // Mixed formats on the route: no single route-level winner, but compat
  // still present with supportsReasoningEffort for the plain-effort models.
  assert.ok(entry._vendorb.compat);
  assert.equal(entry._vendorb.compat.supportsReasoningEffort, true);
});

test("buildDshProviderEntry knowledge tier never overrides store-declared levels", () => {
  const knowledge = new Map([
    ["my-model", {
      hasMap: true,
      levels: ["low", "high"],
      wireValues: { low: "low", high: "high" },
      thinkingFormat: "deepseek",
    }],
  ]);
  const provider = {
    models: {
      "my-model": { reasoningEffortLevels: ["medium", "max"] },
    },
  };
  const entry = buildDshProviderEntry("p", provider, 47821, knowledge);
  assert.deepEqual(entry._p.models[0].reasoningEfforts, {
    off: null,
    medium: "medium",
    max: "max",
  });
  assert.ok(!entry._p.models[0].compat, "store-declared levels carry no per-model format");
});

test("mergeDshSettings manages lifecycle and preserves user sections", () => {
  const existing = {
    "ui-theme": { preference: "dark" },
    "llm-pi-ai": {
      providers: {
        custom_manual: {
          baseURL: "https://api.custom.com",
          api: "openai-completions",
          models: [{ id: "m1" }],
        },
        _old_provider: {
          baseURL: "http://127.0.0.1:47821/openai/old/v1",
          api: "openai-completions",
          models: [{ id: "old-m" }],
        },
      },
    },
  };

  const activeProviders = {
    new_provider: {
      models: { "m-new": { contextWindow: 32000 } },
    },
  };

  const { config, managed } = mergeDshSettings(existing, activeProviders, 47821, ["old_provider"]);

  assert.equal(config["ui-theme"].preference, "dark");
  assert.ok(config["llm-pi-ai"].providers.custom_manual, "user custom provider preserved");
  assert.equal(config["llm-pi-ai"].providers._old_provider, undefined, "stale managed provider removed");
  assert.ok(config["llm-pi-ai"].providers._new_provider, "new managed provider injected");
  assert.deepEqual(managed, ["new_provider"]);
});

test("extractManagedProviders filters providers without models", () => {
  const store = {
    providers: {
      valid: { models: { m1: {} } },
      empty: { models: {} },
      none: {},
    },
  };
  const result = extractManagedProviders(store);
  assert.deepEqual(Object.keys(result), ["valid"]);
});

test("validateDshSettings validates structure", () => {
  assert.equal(validateDshSettings({}).valid, true);
  assert.equal(validateDshSettings(null).valid, false);
  assert.equal(validateDshSettings({ "llm-pi-ai": "invalid" }).valid, false);
  assert.equal(
    validateDshSettings({
      "llm-pi-ai": {
        providers: {
          p1: { baseURL: "http://test", api: "openai-completions", models: [{ id: "m1" }] },
        },
      },
    }).valid,
    true,
  );
});

test("round-trip read/write settings with yaml backup", async () => {
  const yaml = await getYamlModule();
  const dir = mkdtempSync(join(tmpdir(), "dsh-merge-test-"));
  try {
    const filePath = join(dir, "settings.yaml");
    const initial = { "ui-theme": { preference: "light" } };

    const w1 = writeDshSettingsWithBackup(filePath, initial, yaml);
    assert.equal(w1.ok, true);
    assert.equal(w1.unchanged, false);

    const r1 = readDshSettings(filePath, yaml);
    assert.equal(r1["ui-theme"].preference, "light");

    const w2 = writeDshSettingsWithBackup(filePath, initial, yaml);
    assert.equal(w2.ok, true);
    assert.equal(w2.unchanged, true);

    const updated = { "ui-theme": { preference: "dark" } };
    const w3 = writeDshSettingsWithBackup(filePath, updated, yaml);
    assert.equal(w3.ok, true);
    assert.equal(w3.unchanged, false);
    assert.ok(w3.backupPath);

    // Corrupt test
    writeFileSync(filePath, "::invalid: yaml: [", "utf8");
    assert.throws(() => readDshSettings(filePath, yaml), UnparseableDshSettingsError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDshSettingsWithBackup prunes settings backups to the newest 5", async () => {
  const yaml = await getYamlModule();
  const dir = mkdtempSync(join(tmpdir(), "dsh-merge-test-"));
  try {
    const filePath = join(dir, "settings.yaml");
    for (let i = 1; i <= 6; i++) {
      writeFileSync(join(dir, `settings.backup.2020-01-0${i}T00-00-00-000Z.yaml`), `old${i}`, "utf8");
    }
    writeFileSync(filePath, yaml.dump({ "ui-theme": { preference: "light" } }), "utf8");
    const result = writeDshSettingsWithBackup(filePath, { "ui-theme": { preference: "dark" } }, yaml);
    assert.equal(result.ok, true);
    const backups = readdirSync(dir).filter((n) => n.startsWith("settings.backup.")).sort();
    assert.equal(backups.length, 5);
    assert.equal(backups[0], "settings.backup.2020-01-03T00-00-00-000Z.yaml", "oldest backups pruned");
    assert.ok(backups.includes(result.backupPath.split(/[\\/]/).pop()), "fresh backup kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sidecar read and write round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-sidecar-test-"));
  try {
    assert.deepEqual(readSidecar(dir), { providers: [] });
    writeSidecar(dir, ["p2", "p1"]);
    assert.deepEqual(readSidecar(dir), { providers: ["p1", "p2"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pool surfaces as one dsh channel with unioned models and dissolves cleanly", () => {
  const store = {
    version: 2,
    providers: {
      alpha: {
        displayName: "Alpha",
        baseURL: "https://alpha.invalid/v1",
        protocol: "openai-compatible",
        credentialFile: "alpha.dpapi",
        models: {
          "model-a": { displayName: "Model A", contextWindow: 100000 },
          "model-shared": { displayName: "Shared (alpha)" },
        },
      },
      beta: {
        displayName: "Beta",
        baseURL: "https://beta.invalid/v1",
        protocol: "openai-compatible",
        credentialFile: "beta.dpapi",
        models: {
          "model-shared": { displayName: "Shared (beta)" },
          "model-b": { displayName: "Model B" },
        },
      },
    },
    pools: {
      "pool-ab": { displayName: "Pool AB", members: ["alpha", "beta"] },
    },
  };

  const managedProviders = extractManagedProviders(store);
  const { config, managed } = mergeDshSettings({}, managedProviders, 47821, []);
  const providers = config["llm-pi-ai"].providers;
  const pool = providers["_pool-ab"];
  assert.ok(pool);
  assert.equal(pool.displayName, "Pool AB");
  assert.equal(pool.baseURL, "http://127.0.0.1:47821/openai/pool-ab/v1");
  assert.equal(pool.apiKeyEnv, "ANYSWITCH_RELAY_TOKEN");
  assert.deepEqual(pool.headers, { "x-agent-id": "dsh" });
  assert.deepEqual(pool.models.map((m) => m.id), ["model-a", "model-shared", "model-b"]);
  // First member in pool order wins the shared model's metadata.
  assert.equal(pool.models[1].name, "Shared (alpha)");
  // Member channels are absorbed into the pool channel — every endpoint sees
  // one provider per pool, exactly like the wire catalog.
  assert.equal(providers._alpha, undefined);
  assert.equal(providers._beta, undefined);
  assert.ok(managed.includes("pool-ab"));

  // Dissolve the pool: the stale managed entry is removed via the sidecar list.
  const withoutPool = mergeDshSettings(
    config,
    extractManagedProviders({ version: 2, providers: store.providers }),
    47821,
    managed,
  );
  assert.equal(withoutPool.config["llm-pi-ai"].providers["_pool-ab"], undefined);
  assert.ok(withoutPool.config["llm-pi-ai"].providers._alpha);
});

test("pool id equal to a member provider id absorbs all members into one channel", () => {
  const store = {
    version: 2,
    providers: {
      alpha: { models: { "model-a": { displayName: "Model A" } } },
      beta: { models: { "model-b": { displayName: "Model B" } } },
    },
    pools: {
      alpha: { displayName: "Alpha Pool", members: ["alpha", "beta"] },
    },
  };
  const { config, managed } = mergeDshSettings({}, extractManagedProviders(store), 47821, []);
  const providers = config["llm-pi-ai"].providers;
  assert.equal(providers._alpha.displayName, "Alpha Pool");
  assert.equal(providers._alpha.baseURL, "http://127.0.0.1:47821/openai/alpha/v1");
  assert.deepEqual(providers._alpha.models.map((m) => m.id), ["model-a", "model-b"]);
  // beta is absorbed even though its id differs from the pool id.
  assert.equal(providers._beta, undefined);
  assert.deepEqual(managed, ["alpha"]);
});

// Virtual "auto" routing channel (chain routing, wave 2): injected when the
// dsh endpoint has a route chain, cleaned up when the chain is deleted.
const DSH_CHAIN_STORE = {
  version: 2,
  providers: {
    "poke-api": {
      baseURL: "https://poke.example/v1",
      models: { "claude-opus-5": { displayName: "Claude Opus 5" } },
    },
  },
  routingChains: {
    dsh: { chain: [{ node: "poke-api", model: "claude-opus-5" }] },
  },
};

test("mergeDshSettings injects the _auto channel when the endpoint has a route chain", () => {
  const auto = deriveAutoRouteChannel(DSH_CHAIN_STORE, "dsh");
  const { config, managed } = mergeDshSettings(
    {},
    extractManagedProviders(DSH_CHAIN_STORE),
    47821,
    [],
    null,
    auto,
  );
  const entry = config["llm-pi-ai"].providers._auto;
  assert.ok(entry, "_auto channel must be injected");
  assert.equal(entry.displayName, "自动路由");
  assert.equal(entry.api, "openai-completions");
  // The base URL points at the chain HEAD node, not at a literal "auto" segment.
  assert.equal(entry.baseURL, "http://127.0.0.1:47821/openai/poke-api/v1");
  assert.equal(entry.apiKeyEnv, "ANYSWITCH_RELAY_TOKEN");
  assert.deepEqual(entry.headers, { "x-agent-id": "dsh" });
  assert.deepEqual(entry.models.map((m) => m.id), ["auto"]);
  assert.ok(!entry.models[0].reasoningEfforts, "the virtual model carries no reasoning levels");
  assert.ok(managed.includes("auto"), "sidecar tracks the _auto channel as managed");
  assert.equal(validateDshSettings(config).valid, true);
});

test("mergeDshSettings does not inject _auto without a route chain", () => {
  const { config, managed } = mergeDshSettings(
    {},
    extractManagedProviders(DSH_CHAIN_STORE),
    47821,
    [],
    null,
    deriveAutoRouteChannel({ providers: DSH_CHAIN_STORE.providers }, "dsh"),
  );
  assert.equal(config["llm-pi-ai"].providers._auto, undefined);
  assert.ok(!managed.includes("auto"));
});

test("mergeDshSettings cleans up _auto on the re-sync after the chain is deleted", () => {
  const first = mergeDshSettings(
    {},
    extractManagedProviders(DSH_CHAIN_STORE),
    47821,
    [],
    null,
    deriveAutoRouteChannel(DSH_CHAIN_STORE, "dsh"),
  );
  assert.ok(first.config["llm-pi-ai"].providers._auto);
  const second = mergeDshSettings(
    first.config,
    extractManagedProviders(DSH_CHAIN_STORE),
    47821,
    first.managed,
    null,
    deriveAutoRouteChannel({ providers: DSH_CHAIN_STORE.providers }, "dsh"),
  );
  assert.equal(
    second.config["llm-pi-ai"].providers._auto,
    undefined,
    "stale _auto removed once the chain is gone",
  );
  assert.ok(second.config["llm-pi-ai"].providers["_poke-api"], "real channels survive the cleanup");
  assert.ok(!second.managed.includes("auto"));
});
