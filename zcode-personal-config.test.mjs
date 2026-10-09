import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync, existsSync, rmSync, mkdirSync } from "node:fs";
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
  defaultCliModelSelection,
  resolveBuiltinReasoningLevels,
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

  it("always emits manualProviderModelRules, [] when the user has no manual rules", () => {
    // CLI 的 zod schema 把 manualProviderModelRules 定为必填：缺键的文件被整份
    // 拒收、静默 recovery 成空 personal 层（报 Select a model before
    // continuing）。恒输出也是客户端自己回写的 canonical 形态。
    const { prefixedId, entry } = injectedEntry({ providerId: "poke-api" });
    const { config } = mergePersonalProviderConfig(null, { [prefixedId]: entry }, []);
    assert.deepEqual(config.config.modelConfigRules.manualProviderModelRules, []);
    assert.equal(validatePersonalProviderConfig(config).valid, true);
  });

  it("repairs an existing file that lacks manualProviderModelRules", () => {
    // 旧同步/旧客户端留下的缺键形态：下一轮 merge 把键补上（[]），不再透传缺失。
    const { prefixedId, entry } = injectedEntry({ providerId: "poke-api" });
    const existing = {
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [] },
      },
    };
    const { config } = mergePersonalProviderConfig(existing, { [prefixedId]: entry }, []);
    assert.deepEqual(config.config.modelConfigRules.manualProviderModelRules, []);
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

  it("carries the client-side per-model enabled toggle over a rebuilt managed rule", () => {
    const { doc, pokeId } = seededDisk();
    // ZCode writes config.enabled into providerModelRules when the user toggles
    // a model in its list — including models of providers we manage. The rule
    // is ours to rebuild, the toggle is not ours to drop.
    doc.config.modelConfigRules.providerModelRules[0].config.enabled = false;
    const fresh = injectedEntry({
      providerId: "poke-api",
      models: { "m-alpha": { contextWindow: 1000000 }, "m-new": { contextWindow: 8192 } },
    });
    const { config } = mergePersonalProviderConfig(doc, { [pokeId]: fresh.entry }, [pokeId]);

    const rebuilt = config.config.modelConfigRules.providerModelRules.filter((r) => r.providerId === pokeId);
    assert.deepEqual(
      rebuilt.find((r) => r.modelId === "m-alpha"),
      { providerId: pokeId, modelId: "m-alpha", config: { enabled: false, properties: { contextWindow: 1000000 } } },
      "the disabled toggle survives the sync",
    );
    assert.deepEqual(
      rebuilt.find((r) => r.modelId === "m-new"),
      { providerId: pokeId, modelId: "m-new", config: { properties: { contextWindow: 8192 } } },
      "a model the client never toggled gets no enabled key",
    );
    assert.equal(validatePersonalProviderConfig(config).valid, true);
  });

  it("passes unknown config-level keys through the merge instead of dropping them", () => {
    const { doc, pokeId } = seededDisk();
    doc.config.experimentalField = { future: true };
    const same = injectedEntry({ providerId: "poke-api", models: { "m-alpha": { contextWindow: 1000000 } } });
    const { config } = mergePersonalProviderConfig(doc, { [pokeId]: same.entry }, [pokeId]);
    assert.deepEqual(config.config.experimentalField, { future: true });
    // The strict gate then refuses the document, so the sync fails closed with
    // the file untouched — an unknown key is never written back stripped.
    assert.equal(validatePersonalProviderConfig(config).valid, false);
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

  it("accepts the per-model enabled toggle ZCode writes into auto model rules", () => {
    // ZCode 的模型列表给每个模型一个启用开关，写在 providerModelRules 的
    // config.enabled 里。白名单不认识它时整份文件被写入闸拒写，同步卡死。
    const withRule = (config) => ({
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: {
          providerModelRules: [{ providerId: "account:bigmodel-start-plan", modelId: "glm-5.3-flash", config }],
        },
      },
    });
    assert.equal(validatePersonalProviderConfig(withRule({ enabled: true })).valid, true);
    assert.equal(validatePersonalProviderConfig(withRule({ enabled: false, properties: { contextWindow: 128000 } })).valid, true);
    assert.equal(validatePersonalProviderConfig(withRule({ enabled: "yes" })).valid, false);
    assert.equal(validatePersonalProviderConfig(withRule({ bogus: 1 })).valid, false);
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

  it("matches ZCode's byte format: 2-space indent and no trailing newline", () => {
    const root = tmpRoot();
    const path = join(root, PERSONAL_CONFIG_FILENAME);
    const doc = {
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [{ providerId: "_x", config: { group: "standard-personal" } }] },
        modelConfigRules: { providerModelRules: [] },
      },
    };
    const result = writePersonalConfigWithBackup(path, doc);
    assert.equal(result.ok, true);
    const text = readFileSync(path, "utf8");
    assert.equal(text, JSON.stringify(doc, null, 2), "byte-identical to ZCode's own serialization");
    assert.equal(text.endsWith("\n"), false, "ZCode writes this file with no trailing newline");
    assert.ok(text.includes('\n  "schemaVersion"'), "2-space indent");
  });

  it("fails closed under a live foreign lock and leaves no backup behind", () => {
    const root = tmpRoot();
    const path = join(root, PERSONAL_CONFIG_FILENAME);
    const doc = { schemaVersion: 1, config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [] } } };
    writePersonalConfigWithBackup(path, doc);
    const before = readFileSync(path, "utf8");

    // A running ZCode holding its directory lock looks exactly like this.
    const lockPath = `${path}.lock`;
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, "owner-4321-1-zcode.json"),
      `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "zcode" })}\n`,
    );

    const next = {
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [{ providerId: "_x", config: { group: "standard-personal" } }] },
        modelConfigRules: { providerModelRules: [{ providerId: "_x", modelId: "m-1", config: { properties: { contextWindow: 1 } } }] },
      },
    };
    const refused = writePersonalConfigWithBackup(path, next, { lockWaitMs: 120 });
    assert.equal(refused.ok, false);
    assert.equal(refused.unchanged, true);
    assert.equal(readFileSync(path, "utf8"), before, "a refused write never touches the file");
    assert.deepEqual(
      readdirSync(root).filter((f) => f.startsWith("provider_config.backup.")),
      [],
      "no backup is taken for a write that never happened",
    );
    assert.ok(existsSync(join(lockPath, "owner-4321-1-zcode.json")), "the live foreign lock survives");
    rmSync(lockPath, { recursive: true, force: true });
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

  it("syncs past a client-side model rule that carries the enabled toggle", async () => {
    // 2026-10 事故：ZCode 客户端往自己的 provider_config.json 写了
    // config.enabled（模型列表的逐模型开关），写入闸把它当未知键，整次同步拒写。
    const dir = tmpRoot();
    try {
      const configPath = join(dir, "config.json");
      const accountRule = { providerId: "account:bigmodel-start-plan", modelId: "glm-5.3-flash", config: { enabled: true } };
      writeFileSync(
        join(dir, PERSONAL_CONFIG_FILENAME),
        JSON.stringify({
          schemaVersion: 1,
          config: {
            providerConfigRules: {
              providerRules: [{ providerId: "account:bigmodel-start-plan", config: { group: "bigmodel-family" } }],
            },
            modelConfigRules: { providerModelRules: [accountRule] },
          },
        }),
      );

      const result = await writeZcodeConfig(channelStore(), 47821, "tok-1", dir, configPath);
      assert.equal(result.ok, true, result.reason);

      const doc = readPersonal(dir);
      assert.deepEqual(
        doc.config.modelConfigRules.providerModelRules.find((r) => r.providerId === "account:bigmodel-start-plan"),
        accountRule,
        "客户端自己写的开关规则逐字节保留",
      );
      assert.ok(ruleOf(doc, "_poke-api"), "托管渠道照常进客户端列表");
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

  it("keeps the user's default model selection and ordering through a sync", async () => {
    const dir = tmpRoot();
    try {
      const configPath = join(dir, "config.json");
      // What ZCode leaves on disk while it runs: the user's picked default
      // model and provider ordering live in the same file we rewrite.
      writeFileSync(
        join(dir, PERSONAL_CONFIG_FILENAME),
        JSON.stringify({
          schemaVersion: 1,
          config: {
            providerOrder: ["builtin:zai"],
            defaultModelSelection: { providerId: "builtin:zai", modelId: "GLM-5.3" },
            providerConfigRules: {
              providerRules: [{ providerId: "builtin:zai", config: { group: "zai-family", access: { type: "zhipu-coding-plan-api-key" } } }],
            },
            modelConfigRules: { providerModelRules: [] },
          },
        }),
      );

      const result = await writeZcodeConfig(channelStore(), 47821, "tok-1", dir, configPath);
      assert.equal(result.ok, true, result.reason);

      const doc = readPersonal(dir);
      assert.deepEqual(doc.config.defaultModelSelection, { providerId: "builtin:zai", modelId: "GLM-5.3" });
      assert.deepEqual(doc.config.providerOrder, ["builtin:zai"]);
      assert.deepEqual(
        doc.config.providerConfigRules.providerRules.map((r) => r.providerId),
        ["builtin:zai", "_poke-api", "_sail-api"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a file carrying an unknown config-level key byte-identical (fail closed)", async () => {
    const dir = tmpRoot();
    try {
      const configPath = join(dir, "config.json");
      const seeded = {
        schemaVersion: 1,
        config: {
          experimentalField: { future: true },
          providerConfigRules: { providerRules: [] },
          modelConfigRules: { providerModelRules: [] },
        },
      };
      const before = JSON.stringify(seeded, null, 2);
      writeFileSync(join(dir, PERSONAL_CONFIG_FILENAME), before);

      const result = await writeZcodeConfig(channelStore(), 47821, "tok-1", dir, configPath);
      assert.equal(result.ok, false);
      assert.match(result.reason, /would be invalid/);
      assert.equal(
        readFileSync(join(dir, PERSONAL_CONFIG_FILENAME), "utf8"),
        before,
        "a field the writer does not own is never silently stripped",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed while ZCode holds the file lock and syncs once it is released", async () => {
    const dir = tmpRoot();
    try {
      const configPath = join(dir, "config.json");
      const personalPath = join(dir, PERSONAL_CONFIG_FILENAME);
      const seeded = {
        schemaVersion: 1,
        config: {
          defaultModelSelection: { providerId: "builtin:zai", modelId: "GLM-5.3" },
          providerConfigRules: {
            providerRules: [{ providerId: "builtin:zai", config: { group: "zai-family", access: { type: "zhipu-coding-plan-api-key" } } }],
          },
          modelConfigRules: { providerModelRules: [] },
        },
      };
      const before = JSON.stringify(seeded, null, 2);
      writeFileSync(personalPath, before);

      // The running client holds its directory lock (a live owner pid).
      const lockPath = `${personalPath}.lock`;
      mkdirSync(lockPath);
      writeFileSync(
        join(lockPath, "owner-4321-1-zcode.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "zcode" })}\n`,
      );

      const managedEntries = {
        "_poke-api": buildZcodeProviderEntry(
          "poke-api",
          { channelName: "poke-api", models: { "m-alpha": { contextWindow: 1000000 } } },
          47821,
          "tok-1",
        )["_poke-api"],
      };
      const refused = syncZcodePersonalConfig({ configPath, managedEntries, previousManaged: [], lockWaitMs: 120 });
      assert.equal(refused.ok, false);
      assert.equal(refused.unchanged, true);
      assert.equal(readFileSync(personalPath, "utf8"), before, "the client file is never written under a held lock");

      rmSync(lockPath, { recursive: true, force: true });
      const synced = syncZcodePersonalConfig({ configPath, managedEntries, previousManaged: [], lockWaitMs: 120 });
      assert.equal(synced.ok, true, synced.reason);
      const doc = readPersonal(dir);
      assert.ok(doc.config.providerConfigRules.providerRules.some((r) => r.providerId === "_poke-api"));
      assert.deepEqual(
        doc.config.defaultModelSelection,
        { providerId: "builtin:zai", modelId: "GLM-5.3" },
        "the client's own writes survive the sync that follows",
      );
      assert.ok(doc.config.providerConfigRules.providerRules.some((r) => r.providerId === "builtin:zai"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("defaultCliModelSelection（CLI 槽位的默认模型选择）", () => {
  // 与 CLI 随包 zcode-builtin.json 同构的最小规则集：catch-all 提供
  // ["disabled","enabled"]，更具体的规则按文档序覆盖；apiType/baseUrl 限定的
  // 规则只在条件命中时参与覆盖。
  const builtinRules = {
    modelRules: [
      { modelMatch: ".*", config: { optionSpecs: { reasoningLevel: { values: ["disabled", "enabled"] } } } },
      { modelMatch: ".*kimi-k3(?:[.\\-:/\\[].*)?", config: { optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } } } },
    ],
    modelApiRules: [
      { modelMatch: ".*kimi-k3(?:[.\\-:/\\[].*)?", apiTypeMatch: "anthropic-messages", config: { optionSpecs: { reasoningLevel: { values: ["max"] } } } },
    ],
    providerSiteRules: [
      { modelMatch: "kimi-k3", baseUrlMatch: "https://opencode\\.ai/zen/go/v1/?", apiTypeMatch: "openai-chat-completions", config: { optionSpecs: { reasoningLevel: { values: ["max"] } } } },
    ],
  };

  function cliEntryOf(providerId, modelIds) {
    return injectedEntry({
      providerId,
      models: Object.fromEntries(modelIds.map((modelId) => [modelId, {}])),
    }).entry;
  }

  it("prefers the _auto channel: first model, level from the resolved legal set", () => {
    const selection = defaultCliModelSelection({ _auto: cliEntryOf("auto", ["auto", "kimi-k3-mix"]) }, builtinRules);
    assert.deepEqual(selection, { providerId: "_auto", modelId: "auto", options: { reasoningLevel: "disabled" } });
  });

  it("picks a value inside the resolved set when the model does not offer \"disabled\"", () => {
    // kimi-k3-mix 命中更具体的 builtin 规则，解析值域 ["low","high","max"] 不含
    // disabled——默认选择必须取值域内的项（值不配会被 CLI 校验器静默退回
    // registry-fallback），而不是机械写 disabled。
    const selection = defaultCliModelSelection({ _auto: cliEntryOf("auto", ["kimi-k3-mix"]) }, builtinRules);
    assert.deepEqual(selection, { providerId: "_auto", modelId: "kimi-k3-mix", options: { reasoningLevel: "low" } });
  });

  it("ignores rules gated on an apiType or baseUrl the managed entry does not have", () => {
    // kimi-k3：anthropic-messages 的 modelApi 规则（→["max"]）和 opencode.ai
    // 的站点规则（→["max"]）都不该命中——托管条目是 openai-chat-completions +
    // 回环 baseUrl，只有 modelRules 里的 kimi-k3 规则生效（→["low","high","max"]）。
    const selection = defaultCliModelSelection({ _auto: cliEntryOf("auto", ["kimi-k3"]) }, builtinRules);
    assert.deepEqual(selection, { providerId: "_auto", modelId: "kimi-k3", options: { reasoningLevel: "low" } });
  });

  it("falls back to _free-pool's first model + disabled when builtin rules cannot be resolved", () => {
    // 验收锚点：_free-pool/mimo-v2.6-flash-free + disabled 是真实请求跑通过的形态。
    const entries = {
      _auto: cliEntryOf("auto", ["auto"]),
      "_free-pool": cliEntryOf("free-pool", ["mimo-v2.6-flash-free", "other-model"]),
    };
    assert.deepEqual(defaultCliModelSelection(entries, null), {
      providerId: "_free-pool",
      modelId: "mimo-v2.6-flash-free",
      options: { reasoningLevel: "disabled" },
    });
  });

  it("resolves the free-pool anchor too when rules are available", () => {
    const entries = { "_free-pool": cliEntryOf("free-pool", ["mimo-v2.6-flash-free"]) };
    assert.deepEqual(defaultCliModelSelection(entries, builtinRules), {
      providerId: "_free-pool",
      modelId: "mimo-v2.6-flash-free",
      options: { reasoningLevel: "disabled" },
    });
  });

  it("falls back to the first managed channel when neither _auto nor _free-pool exists", () => {
    const entries = { _poke: cliEntryOf("poke", ["some-model"]) };
    assert.deepEqual(defaultCliModelSelection(entries, null), {
      providerId: "_poke",
      modelId: "some-model",
      options: { reasoningLevel: "disabled" },
    });
  });

  it("returns null when there is nothing to select", () => {
    assert.equal(defaultCliModelSelection({}, builtinRules), null);
    assert.equal(defaultCliModelSelection({ _auto: cliEntryOf("auto", []) }, builtinRules), null);
  });

  it("treats a rule that explicitly clears the reasoning spec as unresolvable", () => {
    const clearing = {
      modelRules: [
        { modelMatch: ".*", config: { optionSpecs: { reasoningLevel: { values: ["disabled", "enabled"] } } } },
        { modelMatch: ".*", config: { optionSpecs: { reasoningLevel: null } } },
      ],
    };
    assert.equal(
      resolveBuiltinReasoningLevels(clearing, {
        modelId: "auto",
        apiType: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:47821/openai/auto/v1",
      }),
      null,
    );
  });
});

describe("mergePersonalProviderConfig 的 defaultModelSelection 选项", () => {
  it("applies the caller-supplied selection only to a file that has none", () => {
    const { prefixedId, entry } = injectedEntry({ providerId: "poke-api" });
    const selection = { providerId: prefixedId, modelId: "m-alpha", options: { reasoningLevel: "disabled" } };
    const fresh = mergePersonalProviderConfig(null, { [prefixedId]: entry }, [], { defaultModelSelection: selection });
    assert.deepEqual(fresh.config.config.defaultModelSelection, selection);
    assert.equal(validatePersonalProviderConfig(fresh.config).valid, true);

    // 已有选择的文件（无论选择长什么样）原样保留——生成值绝不覆盖用户选择。
    const seeded = {
      schemaVersion: 1,
      config: {
        defaultModelSelection: { providerId: "builtin:zai", modelId: "GLM-5.3" },
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [] },
      },
    };
    const merged = mergePersonalProviderConfig(seeded, { [prefixedId]: entry }, [], { defaultModelSelection: selection });
    assert.deepEqual(merged.config.config.defaultModelSelection, { providerId: "builtin:zai", modelId: "GLM-5.3" });
  });

  it("keeps the desktop slot shape: no selection is invented without the option", () => {
    const { prefixedId, entry } = injectedEntry({ providerId: "poke-api" });
    const { config } = mergePersonalProviderConfig(null, { [prefixedId]: entry }, []);
    assert.equal("defaultModelSelection" in config.config, false);
  });
});

describe("防乒乓：客户端 canonical 重写后的同步", () => {
  function readDoc(dir) {
    return JSON.parse(readFileSync(join(dir, PERSONAL_CONFIG_FILENAME), "utf8"));
  }

  // 验收实测：CLI（与桌面版同一套 NodePersonalProviderConfigRepository）读取时
  // 会把文件规范化为自己的 canonical 键序重写一次——模型规则变成
  // {modelId, config, providerId}，选择变成 {providerId, modelId, options}。
  function cliCanonicalRewrite(doc) {
    const clone = JSON.parse(JSON.stringify(doc));
    const rules = clone.config?.modelConfigRules;
    if (Array.isArray(rules?.providerModelRules)) {
      rules.providerModelRules = rules.providerModelRules.map((rule) => {
        const { modelId, config, providerId, ...rest } = rule;
        return { modelId, config, ...rest, providerId };
      });
    }
    const selection = clone.config?.defaultModelSelection;
    if (selection) {
      const { providerId, modelId, ...rest } = selection;
      clone.config.defaultModelSelection = { providerId, modelId, ...rest };
    }
    return clone;
  }

  it("treats a client-canonicalized rewrite as unchanged instead of rewriting and rolling backups", () => {
    const root = tmpRoot();
    try {
      const configPath = join(root, "config.json");
      const { prefixedId, entry } = injectedEntry({ providerId: "poke-api", models: { "m-alpha": { contextWindow: 1000000 } } });
      const first = syncZcodePersonalConfig({ configPath, managedEntries: { [prefixedId]: entry }, previousManaged: [] });
      assert.equal(first.ok, true, first.reason);
      assert.equal(first.unchanged, false);

      // 客户端规范化重写落盘：键序变了，语义没变。
      const personalPath = join(root, PERSONAL_CONFIG_FILENAME);
      writeFileSync(personalPath, JSON.stringify(cliCanonicalRewrite(readDoc(root)), null, 2));
      const before = readFileSync(personalPath, "utf8");

      const second = syncZcodePersonalConfig({ configPath, managedEntries: { [prefixedId]: entry }, previousManaged: [prefixedId] });
      assert.equal(second.ok, true, second.reason);
      assert.equal(second.unchanged, true, "canonical 键序差异不得触发重写");
      assert.equal(readFileSync(personalPath, "utf8"), before, "文件保持客户端的 canonical 形态");
      assert.deepEqual(readdirSync(root).filter((f) => f.includes("backup")), [], "只有无意义重写才会滚备份");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still rewrites when the content actually changed under a canonicalized file", () => {
    const root = tmpRoot();
    try {
      const configPath = join(root, "config.json");
      const firstEntry = injectedEntry({ providerId: "poke-api", models: { "m-alpha": { contextWindow: 1000000 } } });
      syncZcodePersonalConfig({ configPath, managedEntries: { [firstEntry.prefixedId]: firstEntry.entry }, previousManaged: [] });
      writeFileSync(join(root, PERSONAL_CONFIG_FILENAME), JSON.stringify(cliCanonicalRewrite(readDoc(root)), null, 2));

      const grown = injectedEntry({
        providerId: "poke-api",
        models: { "m-alpha": { contextWindow: 1000000 }, "m-beta": { contextWindow: 8192 } },
      });
      const result = syncZcodePersonalConfig({ configPath, managedEntries: { [grown.prefixedId]: grown.entry }, previousManaged: [grown.prefixedId] });
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.unchanged, false, "真实内容变化照常重写");
      assert.deepEqual(
        readDoc(root).config.providerConfigRules.providerRules[0].config.personalModelIds,
        ["m-alpha", "m-beta"],
      );
      assert.equal(readdirSync(root).filter((f) => f.includes("backup")).length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
