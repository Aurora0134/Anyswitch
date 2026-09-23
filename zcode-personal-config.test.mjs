import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  PERSONAL_CONFIG_FILENAME,
  PERSONAL_SCHEMA_VERSION,
  personalConfigPath,
  readPersonalConfig,
  UnparseablePersonalConfigError,
  personalRuleFromProviderEntry,
  mergePersonalProviderConfig,
  validatePersonalProviderConfig,
  writePersonalConfigWithBackup,
  syncZcodePersonalConfig,
} from "./zcode-personal-config.mjs";
import { buildZcodeProviderEntry } from "./zcode-merge-config.mjs";
import { writeZcodeConfig } from "./zcode-launcher.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

// ZCode reads its model list from ~/.zcode/v2/provider_config.json and only
// imports the injected config.json while that file is still absent. Anyswitch
// therefore has to maintain that file too, or every later sync lands in a file
// the client never looks at again.
//
// These tests pin the file to ZCode's own strict schema: the shape is the one
// its importLegacyPersonalProviderConfig() produces, decoded against
// {schemaVersion, config:{providerConfigRules, modelConfigRules, providerOrder?,
// defaultModelSelection?}} where every object is strict (unknown keys reject).

function tmpRoot() {
  return mkTestDir("zc-personal-");
}

// A provider entry exactly as it is written into ZCode's config.json.
function injectedEntry(overrides = {}) {
  const { providerId = "poke-api", models = { "m-alpha": {}, "m-beta": {} }, ...rest } = overrides;
  const provider = {
    channelName: overrides.channelName,
    models,
    ...rest.provider,
  };
  const [prefixed] = Object.keys(buildZcodeProviderEntry(providerId, provider, 47821, "tok-1"));
  const entry = buildZcodeProviderEntry(providerId, provider, 47821, "tok-1", rest.catalog ?? null)[prefixed];
  return { prefixedId: prefixed, entry };
}

describe("personalRuleFromProviderEntry", () => {
  it("mirrors ZCode's legacy import shape, key for key", () => {
    const { prefixedId, entry } = injectedEntry({
      providerId: "poke-api",
      models: { "m-alpha": { contextWindow: 1000000 }, "m-beta": {} },
    });
    entry.name = "Poke API";
    const { rule, modelRules } = personalRuleFromProviderEntry(prefixedId, entry);

    assert.deepEqual(Object.keys(rule).sort(), ["config", "providerId", "providerName"]);
    assert.equal(rule.providerId, "_poke-api");
    assert.equal(rule.providerName, "Poke API");
    assert.deepEqual(Object.keys(rule.config).sort(), [
      "access", "api", "group", "modelOrder", "personalModelIds",
    ]);
    assert.equal(rule.config.group, "standard-personal");
    assert.deepEqual(rule.config.access, { type: "api-key", apiKey: "tok-1" });
    assert.equal(rule.config.api.type, "openai-chat-completions");
    assert.equal(rule.config.api.baseUrl, "http://127.0.0.1:47821/openai/poke-api/v1");
    assert.deepEqual(rule.config.api.headers, { "x-agent-id": "zcode" });
    assert.deepEqual(rule.config.personalModelIds, ["m-alpha", "m-beta"]);
    assert.deepEqual(rule.config.modelOrder, ["m-alpha", "m-beta"]);
    assert.deepEqual(modelRules.map((r) => r.modelId), ["m-alpha", "m-beta"]);
    assert.deepEqual(modelRules[0], {
      providerId: "_poke-api", modelId: "m-alpha", config: { properties: { contextWindow: 1000000 } },
    });
    // A model the store never got a context window for still reaches the client
    // with the fallback Anyswitch already wrote into config.json, so the two
    // files stay describing the same channel.
    assert.equal(Number.isInteger(modelRules[1].config.properties.contextWindow), true);
  });

  it("omits providerName when it repeats the id, like ZCode does", () => {
    const { prefixedId, entry } = injectedEntry({ providerId: "poke-api" });
    entry.name = prefixedId;
    const { rule } = personalRuleFromProviderEntry(prefixedId, entry);
    assert.equal("providerName" in rule, false);
  });

  it("writes neither model list when the provider has no models", () => {
    const { prefixedId, entry } = injectedEntry({ providerId: "poke-api", models: {} });
    const { rule } = personalRuleFromProviderEntry(prefixedId, entry);
    assert.deepEqual(Object.keys(rule.config).sort(), ["access", "api", "group"]);
    assert.equal("personalModelIds" in rule.config, false);
    assert.equal("modelOrder" in rule.config, false);
  });

  it("drops a non-integer or non-positive context window instead of failing the sync", () => {
    // config.json always carries a numeric limit.context for every model, so a
    // bad value here can only come from a hand-edited file: the model stays
    // selectable, it just gets no context-window rule.
    const { prefixedId, entry } = injectedEntry({
      providerId: "poke-api",
      models: {
        "m-good": { contextWindow: 262144 },
        "m-zero": { contextWindow: 0 },
        "m-fraction": { contextWindow: 1.5 },
        "m-string": { contextWindow: "1000000" },
      },
    });
    const { modelRules } = personalRuleFromProviderEntry(prefixedId, entry);
    assert.deepEqual(modelRules.map((r) => r.modelId), ["m-good"]);
  });

  it("keeps a percent-encoded relay segment untouched", () => {
    const { prefixedId, entry } = injectedEntry({ providerId: "poke api/2" });
    const { rule } = personalRuleFromProviderEntry(prefixedId, entry);
    assert.equal(rule.config.api.baseUrl, "http://127.0.0.1:47821/openai/poke%20api%2F2/v1");
  });
});

describe("mergePersonalProviderConfig on a fresh file", () => {
  it("creates a schema-versioned document holding only managed rules", () => {
    const { prefixedId, entry } = injectedEntry({ providerId: "poke-api", models: { "m-alpha": { contextWindow: 1000000 } } });
    const { config, managed } = mergePersonalProviderConfig(null, { [prefixedId]: entry }, []);

    assert.equal(config.schemaVersion, PERSONAL_SCHEMA_VERSION);
    assert.deepEqual(Object.keys(config).sort(), ["config", "schemaVersion"]);
    assert.deepEqual(Object.keys(config.config).sort(), ["modelConfigRules", "providerConfigRules"]);
    assert.deepEqual(config.config.providerConfigRules.providerRules.map((r) => r.providerId), ["_poke-api"]);
    assert.deepEqual(config.config.modelConfigRules.providerModelRules.map((r) => r.modelId), ["m-alpha"]);
    assert.deepEqual(managed, ["_poke-api"]);
    assert.equal(validatePersonalProviderConfig(config).valid, true);
  });
});

describe("mergePersonalProviderConfig against an existing file", () => {
  function seededDisk() {
    const a = injectedEntry({ providerId: "poke-api", models: { "m-alpha": { contextWindow: 1000000 } } });
    const ghost = injectedEntry({ providerId: "gone-api", models: { "m-ghost": {} } });
    return {
      doc: {
        schemaVersion: 1,
        config: {
          providerOrder: ["_poke-api", "builtin:zai"],
          defaultModelSelection: { modelId: "GLM-5.3", providerId: "builtin:zai" },
          providerConfigRules: {
            providerRules: [
              personalRuleFromProviderEntry(a.prefixedId, a.entry).rule,
              { providerId: "builtin:zai", config: { group: "zai-family", access: { type: "zhipu-coding-plan-api-key" } } },
              personalRuleFromProviderEntry(ghost.prefixedId, ghost.entry).rule,
            ],
          },
          modelConfigRules: {
            providerModelRules: [
              ...personalRuleFromProviderEntry(a.prefixedId, a.entry).modelRules,
              { providerId: "builtin:zai", modelId: "GLM-5.3", config: { properties: { contextWindow: 200000 } } },
              { providerId: "_gone-api", modelId: "m-ghost", config: { properties: {} } },
            ],
            manualProviderModelRules: [
              { providerId: "_poke-api", modelId: "m-manual", config: { properties: { contextWindow: 8 } } },
            ],
          },
        },
      },
      pokeId: a.prefixedId,
    };
  }

  it("replaces a managed provider's model set in place, keeping foreign rules and order", () => {
    const { doc, pokeId } = seededDisk();
    const fresh = injectedEntry({
      providerId: "poke-api",
      models: { "m-alpha": { contextWindow: 1000000 }, "m-new": { contextWindow: 8192 } },
    });
    const { config } = mergePersonalProviderConfig(doc, { [pokeId]: fresh.entry }, [pokeId, "_gone-api"]);

    const rules = config.config.providerConfigRules.providerRules;
    assert.deepEqual(rules.map((r) => r.providerId), ["_poke-api", "builtin:zai"]);
    assert.deepEqual(rules[0].config.personalModelIds, ["m-alpha", "m-new"]);
    assert.deepEqual(
      config.config.modelConfigRules.providerModelRules.filter((r) => r.providerId === "_poke-api").map((r) => r.modelId),
      ["m-alpha", "m-new"],
    );
    assert.deepEqual(
      config.config.modelConfigRules.providerModelRules.filter((r) => r.providerId === "builtin:zai").map((r) => r.modelId),
      ["GLM-5.3"],
    );
  });

  it("retires a managed provider that disappeared, rule and model rules together", () => {
    const { doc } = seededDisk();
    const fresh = injectedEntry({ providerId: "poke-api", models: { "m-alpha": {} } });
    const { config, managed } = mergePersonalProviderConfig(doc, { [fresh.prefixedId]: fresh.entry }, [fresh.prefixedId, "_gone-api"]);

    assert.equal(
      config.config.providerConfigRules.providerRules.some((r) => r.providerId === "_gone-api"),
      false,
      "a channel deleted on the panel must vanish from the client list too",
    );
    assert.equal(
      config.config.modelConfigRules.providerModelRules.some((r) => r.providerId === "_gone-api"),
      false,
    );
    assert.deepEqual(managed, ["_poke-api"]);
  });

  it("never touches rules it did not manage last time", () => {
    const { doc } = seededDisk();
    const fresh = injectedEntry({ providerId: "poke-api", models: { "m-alpha": {} } });
    const { config } = mergePersonalProviderConfig(doc, { [fresh.prefixedId]: fresh.entry }, [fresh.prefixedId, "_gone-api"]);

    const foreign = config.config.providerConfigRules.providerRules.find((r) => r.providerId === "builtin:zai");
    assert.deepEqual(foreign, doc.config.providerConfigRules.providerRules[1]);
  });

  it("carries the user's own client-side settings through untouched", () => {
    const { doc } = seededDisk();
    const fresh = injectedEntry({ providerId: "poke-api", models: { "m-alpha": {} } });
    const { config } = mergePersonalProviderConfig(doc, { [fresh.prefixedId]: fresh.entry }, [fresh.prefixedId]);

    assert.deepEqual(config.config.providerOrder, ["_poke-api", "builtin:zai"]);
    assert.deepEqual(config.config.defaultModelSelection, { modelId: "GLM-5.3", providerId: "builtin:zai" });
  });

  it("keeps manual model rules and never emits a duplicate for the same provider+model", () => {
    const { doc } = seededDisk();
    const fresh = injectedEntry({
      providerId: "poke-api",
      models: { "m-manual": { contextWindow: 4096 }, "m-plain": {} },
    });
    const { config } = mergePersonalProviderConfig(doc, { [fresh.prefixedId]: fresh.entry }, [fresh.prefixedId]);

    assert.deepEqual(config.config.modelConfigRules.manualProviderModelRules, [
      { providerId: "_poke-api", modelId: "m-manual", config: { properties: { contextWindow: 8 } } },
    ]);
    assert.deepEqual(
      config.config.modelConfigRules.providerModelRules.filter((r) => r.providerId === "_poke-api").map((r) => r.modelId),
      ["m-plain"],
      "ZCode rejects a model declared both automatically and manually",
    );
  });

  it("produces a document that satisfies ZCode's strict schema", () => {
    const { doc } = seededDisk();
    const fresh = injectedEntry({ providerId: "poke-api", models: { "m-alpha": { contextWindow: 1 } } });
    const { config } = mergePersonalProviderConfig(doc, { [fresh.prefixedId]: fresh.entry }, [fresh.prefixedId, "_gone-api"]);
    const gate = validatePersonalProviderConfig(config);
    assert.equal(gate.valid, true, gate.error);
  });

  it("returns the same document unchanged when nothing moved", () => {
    const { doc, pokeId } = seededDisk();
    const same = injectedEntry({ providerId: "poke-api", models: { "m-alpha": { contextWindow: 1000000 } } });
    const before = JSON.stringify(doc.config.providerConfigRules.providerRules[0]);
    const { config } = mergePersonalProviderConfig(doc, { [pokeId]: same.entry }, [pokeId]);
    assert.equal(JSON.stringify(config.config.providerConfigRules.providerRules[0]), before);
  });
});

describe("validatePersonalProviderConfig", () => {
  it("rejects unknown top-level and config-level keys", () => {
    assert.equal(validatePersonalProviderConfig({ schemaVersion: 1, config: {}, extra: 1 }).valid, false);
    assert.equal(
      validatePersonalProviderConfig({
        schemaVersion: 1,
        config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [] }, bogus: 1 },
      }).valid,
      false,
    );
  });

  it("rejects an unknown api type and a duplicate provider id", () => {
    assert.equal(
      validatePersonalProviderConfig({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              { providerId: "_a", config: { group: "standard-personal", access: { type: "api-key" }, api: { type: "openai", baseUrl: "http://127.0.0.1:1/v1" } } },
            ],
          },
          modelConfigRules: { providerModelRules: [] },
        },
      }).valid,
      false,
    );
    assert.equal(
      validatePersonalProviderConfig({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              { providerId: "_a", config: { group: "standard-personal" } },
              { providerId: "_a", config: { group: "standard-personal" } },
            ],
          },
          modelConfigRules: { providerModelRules: [] },
        },
      }).valid,
      false,
    );
  });

  it("accepts the document ZCode itself leaves on disk today", () => {
    const real = {
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "_sta1n-default",
              providerName: "sta1n-default",
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKey: "c72b5630" },
                api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:47821/openai/sta1n-default/v1", headers: { "x-agent-id": "zcode" } },
                personalModelIds: ["glm-5.3"],
                modelOrder: ["glm-5.3"],
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [
            { providerId: "_sta1n-default", modelId: "glm-5.3", config: { properties: { contextWindow: 1000000 } } },
          ],
        },
      },
    };
    assert.equal(validatePersonalProviderConfig(real).valid, true);
  });
});

describe("which client-side rules Anyswitch owns", () => {
  // What a previous sync of ours left on disk, for a channel that no longer
  // exists on the panel. The sidecar only remembers the last round, so a
  // leftover from further back is recognised by the fingerprint our entries
  // carry instead — otherwise a deleted channel stays selectable forever.
  function injectedBefore(providerId, segment) {
    return {
      providerId,
      config: {
        group: "standard-personal",
        access: { type: "api-key", apiKey: "tok-1" },
        api: {
          type: "openai-chat-completions",
          baseUrl: `http://127.0.0.1:47821/openai/${segment}/v1`,
          headers: { "x-agent-id": "zcode" },
        },
        personalModelIds: ["m-old"],
        modelOrder: ["m-old"],
      },
    };
  }

  function handMade(providerId, baseUrl, headers) {
    return {
      providerId,
      config: {
        group: "standard-personal",
        access: { type: "api-key", apiKey: "sk-user" },
        api: { type: "openai-chat-completions", baseUrl, ...(headers ? { headers } : {}) },
        personalModelIds: ["m-user"],
        modelOrder: ["m-user"],
      },
    };
  }

  function diskWith(rules) {
    return {
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: rules },
        modelConfigRules: {
          providerModelRules: rules.flatMap((r) =>
            (r.config.personalModelIds ?? []).map((modelId) => ({
              providerId: r.providerId, modelId, config: { properties: { contextWindow: 1000000 } },
            })),
          ),
        },
      },
    };
  }

  function merged(existing, managedEntries) {
    return mergePersonalProviderConfig(existing, managedEntries, []);
  }

  it("reclaims a leftover channel that points at the relay with our marker", () => {
    const existing = diskWith([injectedBefore("_S3AI-Gemini", "S3AI-Gemini")]);
    const { prefixedId, entry } = injectedEntry({ providerId: "poke-api" });
    const { config } = merged(existing, { [prefixedId]: entry });

    assert.deepEqual(config.config.providerConfigRules.providerRules.map((r) => r.providerId), ["_poke-api"]);
    assert.deepEqual(config.config.modelConfigRules.providerModelRules.map((r) => r.modelId), ["m-alpha", "m-beta"]);
  });

  it("keeps a channel the user added by hand against a real upstream", () => {
    const existing = diskWith([handMade("_my-key", "https://upstream.example/v1")]);
    const { prefixedId, entry } = injectedEntry({ providerId: "poke-api" });
    const { config } = merged(existing, { [prefixedId]: entry });

    assert.deepEqual(config.config.providerConfigRules.providerRules.map((r) => r.providerId), [
      "_my-key", "_poke-api",
    ]);
    assert.deepEqual(config.config.modelConfigRules.providerModelRules.map((r) => `${r.providerId}/${r.modelId}`), [
      "_my-key/m-user", "_poke-api/m-alpha", "_poke-api/m-beta",
    ]);
  });

  it("keeps a hand-made channel that happens to name the relay port without our marker", () => {
    const existing = diskWith([handMade("_lookalike", "http://127.0.0.1:47821/openai/other/v1", { "x-agent-id": "pi" })]);
    const { prefixedId, entry } = injectedEntry({ providerId: "poke-api" });
    const { config } = merged(existing, { [prefixedId]: entry });

    assert.ok(config.config.providerConfigRules.providerRules.some((r) => r.providerId === "_lookalike"));
    assert.ok(config.config.modelConfigRules.providerModelRules.some((r) => r.providerId === "_lookalike"));
  });
});

describe("personal config IO", () => {
  it("derives the filename next to the injected config.json", () => {
    assert.equal(personalConfigPath(join("C:", "zcode", "v2", "config.json")), join("C:", "zcode", "v2", PERSONAL_CONFIG_FILENAME));
  });

  it("reads a missing file as an empty document", () => {
    const root = tmpRoot();
    assert.deepEqual(readPersonalConfig(join(root, PERSONAL_CONFIG_FILENAME)), null);
  });

  it("fails closed on a file it cannot parse rather than treating it as empty", () => {
    const root = tmpRoot();
    const path = join(root, PERSONAL_CONFIG_FILENAME);
    writeFileSync(path, "{ not json");
    assert.throws(() => readPersonalConfig(path), UnparseablePersonalConfigError);
  });

  it("refuses a parsable file whose schemaVersion is newer than supported", () => {
    const root = tmpRoot();
    const path = join(root, PERSONAL_CONFIG_FILENAME);
    writeFileSync(path, JSON.stringify({ schemaVersion: 99, config: {} }));
    assert.throws(() => readPersonalConfig(path), /schemaVersion/);
  });

  it("writes atomically with one backup and short-circuits identical content", () => {
    const root = tmpRoot();
    const path = join(root, PERSONAL_CONFIG_FILENAME);
    const doc = { schemaVersion: 1, config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [] } } };

    const first = writePersonalConfigWithBackup(path, doc);
    assert.equal(first.ok, true);
    assert.equal(first.unchanged, false);
    // ZCode writes this file itself with no trailing newline, so the bytes we
    // leave have to match what it would have written: any difference reads back
    // as a changed model list to a running client.
    assert.equal(readFileSync(path, "utf8"), JSON.stringify(doc, null, 2));

    const second = writePersonalConfigWithBackup(path, doc);
    assert.equal(second.ok, true);
    assert.equal(second.unchanged, true);
    assert.deepEqual(readdirSync(root).filter((f) => f.includes("backup")), []);
  });

  it("backs up the previous content before overwriting it", () => {
    const root = tmpRoot();
    const path = join(root, PERSONAL_CONFIG_FILENAME);
    const doc = { schemaVersion: 1, config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [] } } };
    writePersonalConfigWithBackup(path, doc);
    const next = {
      schemaVersion: 1,
      config: { providerConfigRules: { providerRules: [{ providerId: "_x", config: { group: "standard-personal" } }] }, modelConfigRules: { providerModelRules: [] } },
    };
    const result = writePersonalConfigWithBackup(path, next);
    assert.equal(result.unchanged, false);
    assert.ok(existsSync(result.backupPath));
    assert.equal(JSON.parse(readFileSync(result.backupPath, "utf8")).config.providerConfigRules.providerRules.length, 0);
    assert.deepEqual(readdirSync(root).filter((f) => f.startsWith("provider_config.backup.")).length, 1);
  });
});

describe("ZCode sync end to end", () => {
  function channelStore(extra = {}) {
    return {
      version: 2,
      providers: {
        "poke-api": {
          displayName: "Poke API",
          baseURL: "https://poke.example/v1",
          protocol: "openai-compatible",
          credentialFile: "poke-api.dpapi",
          models: {
            "claude-opus-5": { displayName: "Claude Opus 5", contextWindow: 200000 },
            "glm-5.3": { displayName: "GLM 5.3" },
          },
          ...extra["poke-api"],
        },
        "sail-api": {
          displayName: "SAIL",
          baseURL: "https://sail.example/v1",
          protocol: "openai-compatible",
          credentialFile: "sail-api.dpapi",
          models: { "kimi-k3": { displayName: "Kimi K3", contextWindow: 262144 } },
          ...extra["sail-api"],
        },
      },
    };
  }

  function readPersonal(dir) {
    return JSON.parse(readFileSync(join(dir, PERSONAL_CONFIG_FILENAME), "utf8"));
  }

  function ruleOf(doc, providerId) {
    return doc.config.providerConfigRules.providerRules.find((r) => r.providerId === providerId);
  }

  it("publishes every managed channel into the list ZCode renders", async () => {
    const dir = tmpRoot();
    try {
      const configPath = join(dir, "config.json");
      const result = await writeZcodeConfig(channelStore(), 47821, "tok-1", dir, configPath);
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.unchanged, false);

      const doc = readPersonal(dir);
      assert.equal(doc.schemaVersion, PERSONAL_SCHEMA_VERSION);
      assert.equal(validatePersonalProviderConfig(doc).valid, true);
      assert.deepEqual(
        doc.config.providerConfigRules.providerRules.map((r) => r.providerId),
        ["_poke-api", "_sail-api"],
      );
      const poke = ruleOf(doc, "_poke-api");
      // A plain channel is labelled with its own id; only pools and route
      // chains carry a display name, and whatever config.json says is what the
      // client list repeats.
      assert.equal(poke.providerName, "poke-api");
      assert.deepEqual(poke.config.personalModelIds, ["claude-opus-5", "glm-5.3"]);
      assert.equal(poke.config.api.baseUrl, "http://127.0.0.1:47821/openai/poke-api/v1");
      assert.deepEqual(poke.config.access, { type: "api-key", apiKey: "tok-1" });
      assert.deepEqual(
        doc.config.modelConfigRules.providerModelRules.map((r) => `${r.providerId}/${r.modelId}`).sort(),
        ["_poke-api/claude-opus-5", "_poke-api/glm-5.3", "_sail-api/kimi-k3"],
      );
      assert.equal(
        doc.config.modelConfigRules.providerModelRules.find((r) => r.modelId === "claude-opus-5").config.properties.contextWindow,
        200000,
      );
      // Every listed model carries a usable context window, including the ones
      // the store never got a real number for.
      assert.ok(doc.config.modelConfigRules.providerModelRules.every(
        (r) => Number.isInteger(r.config.properties.contextWindow) && r.config.properties.contextWindow > 0,
      ));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("follows a model added to a channel on the next sync", async () => {
    const dir = tmpRoot();
    try {
      const configPath = join(dir, "config.json");
      await writeZcodeConfig(channelStore(), 47821, "tok-1", dir, configPath);
      const store = channelStore();
      store.providers["poke-api"].models["mimo-v2.5-pro"] = { displayName: "MiMo" };
      await writeZcodeConfig(store, 47821, "tok-1", dir, configPath);

      assert.deepEqual(ruleOf(readPersonal(dir), "_poke-api").config.personalModelIds, [
        "claude-opus-5", "glm-5.3", "mimo-v2.5-pro",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops a deleted channel and its model rules from the client list", async () => {
    const dir = tmpRoot();
    try {
      const configPath = join(dir, "config.json");
      await writeZcodeConfig(channelStore(), 47821, "tok-1", dir, configPath);
      const store = channelStore();
      delete store.providers["sail-api"];
      const result = await writeZcodeConfig(store, 47821, "tok-1", dir, configPath);
      assert.equal(result.ok, true, result.reason);

      const doc = readPersonal(dir);
      assert.deepEqual(doc.config.providerConfigRules.providerRules.map((r) => r.providerId), ["_poke-api"]);
      assert.deepEqual(
        doc.config.modelConfigRules.providerModelRules.map((r) => `${r.providerId}/${r.modelId}`).sort(),
        ["_poke-api/claude-opus-5", "_poke-api/glm-5.3"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a provider the user created inside ZCode", async () => {
    const dir = tmpRoot();
    try {
      const configPath = join(dir, "config.json");
      writeFileSync(
        join(dir, PERSONAL_CONFIG_FILENAME),
        JSON.stringify({
          schemaVersion: 1,
          config: {
            providerOrder: ["_handmade", "_poke-api"],
            providerConfigRules: {
              providerRules: [{ providerId: "_handmade", config: { group: "standard-personal", personalModelIds: ["m-mine"], modelOrder: ["m-mine"] } }],
            },
            modelConfigRules: {
              providerModelRules: [{ providerId: "_handmade", modelId: "m-mine", config: { properties: { contextWindow: 4096 } } }],
            },
          },
        }),
      );
      await writeZcodeConfig(channelStore(), 47821, "tok-1", dir, configPath);

      const doc = readPersonal(dir);
      assert.deepEqual(doc.config.providerConfigRules.providerRules.map((r) => r.providerId), [
        "_handmade", "_poke-api", "_sail-api",
      ]);
      assert.deepEqual(doc.config.providerOrder, ["_handmade", "_poke-api"]);
      assert.deepEqual(
        doc.config.modelConfigRules.providerModelRules.filter((r) => r.providerId === "_handmade"),
        [{ providerId: "_handmade", modelId: "m-mine", config: { properties: { contextWindow: 4096 } } }],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves an unreadable client list exactly as it is and reports the sync as failed", async () => {
    const dir = tmpRoot();
    try {
      const configPath = join(dir, "config.json");
      const personalPath = join(dir, PERSONAL_CONFIG_FILENAME);
      const broken = "{ not json at all";
      writeFileSync(personalPath, broken);

      const result = await writeZcodeConfig(channelStore(), 47821, "tok-1", dir, configPath);
      assert.equal(result.ok, false);
      assert.match(result.reason, /provider_config\.json/);
      assert.equal(readFileSync(personalPath, "utf8"), broken, "never overwrite a client file we cannot read");
      // The injection itself did land, so the next sync can retry from here.
      assert.ok(JSON.parse(readFileSync(configPath, "utf8")).provider["_poke-api"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing on a second identical sync", async () => {
    const dir = tmpRoot();
    try {
      const configPath = join(dir, "config.json");
      const first = await writeZcodeConfig(channelStore(), 47821, "tok-1", dir, configPath);
      assert.equal(first.personal.unchanged, false);
      const second = await writeZcodeConfig(channelStore(), 47821, "tok-1", dir, configPath);
      assert.equal(second.ok, true, second.reason);
      assert.equal(second.unchanged, true);
      assert.equal(second.personal.unchanged, true);
      assert.deepEqual(readdirSync(dir).filter((f) => f.includes("backup")), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs a client list that fell behind the injected config.json", async () => {
    const dir = tmpRoot();
    try {
      const configPath = join(dir, "config.json");
      await writeZcodeConfig(channelStore(), 47821, "tok-1", dir, configPath);
      // A client file frozen at an older model set, plus a channel that no
      // longer exists on the panel — the exact state that made re-syncing look
      // like it did nothing.
      writeFileSync(
        join(dir, PERSONAL_CONFIG_FILENAME),
        JSON.stringify({
          schemaVersion: 1,
          config: {
            providerConfigRules: {
              providerRules: [
                { providerId: "_poke-api", config: { group: "standard-personal", personalModelIds: ["claude-opus-5"], modelOrder: ["claude-opus-5"] } },
                { providerId: "_gone-api", config: { group: "standard-personal", personalModelIds: ["m-ghost"], modelOrder: ["m-ghost"] } },
              ],
            },
            modelConfigRules: {
              providerModelRules: [
                { providerId: "_poke-api", modelId: "claude-opus-5", config: { properties: { contextWindow: 1 } } },
                { providerId: "_gone-api", modelId: "m-ghost", config: { properties: { contextWindow: 1 } } },
              ],
            },
          },
        }),
      );

      const sync = syncZcodePersonalConfig({
        configPath,
        managedEntries: { "_poke-api": JSON.parse(readFileSync(configPath, "utf8")).provider["_poke-api"] },
        previousManaged: ["_poke-api", "_gone-api"],
      });
      assert.equal(sync.ok, true, sync.reason);
      assert.equal(sync.unchanged, false);
      const doc = readPersonal(dir);
      assert.deepEqual(doc.config.providerConfigRules.providerRules.map((r) => r.providerId), ["_poke-api"]);
      assert.deepEqual(ruleOf(doc, "_poke-api").config.personalModelIds, ["claude-opus-5", "glm-5.3"]);
      assert.deepEqual(
        doc.config.modelConfigRules.providerModelRules.filter((r) => r.providerId === "_poke-api").map((r) => r.modelId),
        ["claude-opus-5", "glm-5.3"],
      );
      assert.equal(
        doc.config.modelConfigRules.providerModelRules.find((r) => r.modelId === "claude-opus-5").config.properties.contextWindow,
        200000,
        "the stale rule from the frozen file must be replaced, not kept",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
