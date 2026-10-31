import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildPiProviderEntry,
  mergeModelsJson,
  readModelsJson,
  writeModelsJsonWithBackup,
  extractManagedProviders,
  validatePiModelsConfig,
  UnparseableModelsError,
  deriveAutoRouteChannel,
  DIRECT_INSTANCE_ID,
  piProviderId,
  tagManagedProvidersForLaunch,
  restoreManagedProvidersAfterLaunch,
} from "./pi-merge-models.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

// Stands in for the stable per-install relay token (loadOrGenerateToken) the
// merge now writes into managed entries instead of a ${VAR} placeholder.
const RELAY_TOKEN = "test-relay-token";

const STORE = {
  version: 2,
  providers: {
    "poke-api": {
      baseURL: "https://poke.example/v1",
      protocol: "openai-compatible",
      credentialFile: "poke-api.dpapi",
      models: {
        "claude-opus-5": { displayName: "Claude Opus 5" },
        "claude-sonnet-4": { displayName: "Claude Sonnet 4" },
      },
    },
    "deepseek": {
      baseURL: "https://deepseek.example/v1",
      protocol: "openai-compatible",
      credentialFile: "deepseek.dpapi",
      models: {
        "deepseek-v4": { displayName: "DeepSeek V4" },
      },
    },
  },
};

describe("buildPiProviderEntry", () => {
  it("generates provider-level entry with _ prefix", () => {
    const entry = buildPiProviderEntry("poke-api", STORE.providers["poke-api"], 47821, null, RELAY_TOKEN);
    assert.ok(entry["_poke-api"]);
    const p = entry["_poke-api"];
    assert.equal(p.name, "poke-api");
    assert.equal(p.baseUrl, "http://127.0.0.1:47821/openai/poke-api/v1");
    assert.equal(p.apiKey, RELAY_TOKEN);
    assert.equal(p.api, "openai-completions");
    assert.deepEqual(p.headers, { "x-agent-id": "pi", "x-agent-instance": "direct" });
    assert.equal(p.models.length, 2);
    assert.equal(p.models[0].id, "claude-opus-5");
    assert.equal(p.models[0].name, "Claude Opus 5");
    assert.equal(p.models[0].apiKey, undefined);
    assert.equal(p.models[0].provider, undefined);
    assert.equal(p.models[0].baseUrl, undefined);
    // No store contextWindow — the claude-opus tier fills in 1M.
    assert.equal(p.models[0].contextWindow, 1_000_000);
    assert.equal(p.models[1].contextWindow, 200_000);
  });

  it("omits the model name when no displayName (id stays the modelId)", () => {
    // No modelId-to-name fallback exists (pi-merge-models.mjs writes `name`
    // only when the store carries a displayName) — the entry simply has no
    // name field, and pi falls back to the model id on its own.
    const provider = {
      baseURL: "https://x.example/v1",
      protocol: "openai-compatible",
      credentialFile: "x.dpapi",
      models: { "bare-model": {} },
    };
    const entry = buildPiProviderEntry("test", provider, 47821);
    const p = entry["_test"];
    assert.equal(p.models[0].name, undefined);
    assert.equal(p.models[0].id, "bare-model");
    // Unmatched model id falls to the 1M default, never undefined.
    assert.equal(p.models[0].contextWindow, 1_000_000);
  });

  it("includes contextWindow and maxTokens when present", () => {
    const provider = {
      baseURL: "https://x.example/v1",
      protocol: "openai-compatible",
      credentialFile: "x.dpapi",
      models: {
        "big-model": {
          displayName: "Big Model",
          contextWindow: 100000,
          maxOutputTokens: 65536,
        },
      },
    };
    const entry = buildPiProviderEntry("test", provider, 47821);
    const p = entry["_test"];
    assert.equal(p.models[0].contextWindow, 100000);
    assert.equal(p.models[0].maxTokens, 65536);
  });

  it("falls back to the keyword tier when the store carries no contextWindow", () => {
    // The common case: most upstream /models responses omit context_length, so
    // the store model has no real value. The pi merge must mirror the other
    // five agents and write the tier-map fallback instead of dropping the
    // field, or pi's binary silently defaults every model to 128k.
    const provider = {
      baseURL: "https://x.example/v1",
      protocol: "openai-compatible",
      credentialFile: "x.dpapi",
      models: {
        "gpt-5.5-codex": { displayName: "GPT 5.5 Codex" },
        "gpt-4.1": { displayName: "GPT 4.1" },
        "claude-sonnet-5": { displayName: "Claude Sonnet 5" },
        "unknown-thing": { displayName: "Unknown" },
      },
    };
    const entry = buildPiProviderEntry("test", provider, 47821);
    const p = entry["_test"];
    assert.equal(p.models.find((m) => m.id === "gpt-5.5-codex").contextWindow, 1_050_000);
    assert.equal(p.models.find((m) => m.id === "gpt-4.1").contextWindow, 128_000);
    assert.equal(p.models.find((m) => m.id === "claude-sonnet-5").contextWindow, 1_000_000);
    assert.equal(p.models.find((m) => m.id === "unknown-thing").contextWindow, 1_000_000);
  });

  it("store contextWindow wins over the fallback tier", () => {
    // A real upstream value (e.g. an OpenAI-compatible server that does report
    // context_length) must always outrank the keyword tier — underestimation
    // drops live context, but so does ignoring the vendor's advertised limit.
    const provider = {
      baseURL: "https://x.example/v1",
      protocol: "openai-compatible",
      credentialFile: "x.dpapi",
      models: {
        "gpt-5": { displayName: "GPT 5", contextWindow: 500_000 },
      },
    };
    const entry = buildPiProviderEntry("test", provider, 47821);
    assert.equal(entry["_test"].models[0].contextWindow, 500_000);
  });
});

describe("mergeModelsJson", () => {
  it("adds managed providers with _ prefix to empty existing", () => {
    const { config, managed } = mergeModelsJson({ providers: {} }, STORE.providers, 47821);
    assert.ok(config.providers["_poke-api"]);
    assert.ok(config.providers["_deepseek"]);
    assert.equal(managed.length, 2);
    assert.ok(managed.includes("poke-api"));
    assert.ok(managed.includes("deepseek"));
  });

  it("preserves foreign providers", () => {
    const existing = { providers: { "my-custom-provider": { baseUrl: "https://x", models: [{ id: "custom" }] } } };
    const { config } = mergeModelsJson(existing, STORE.providers, 47821);
    assert.ok(config.providers["my-custom-provider"]);
    assert.equal(config.providers["my-custom-provider"].models[0].id, "custom");
  });

  it("removes previously managed providers no longer in store", () => {
    const existing = { providers: { "_poke-api": { name: "poke-api", models: [] } } };
    const { config, managed } = mergeModelsJson(existing, {}, 47821, ["poke-api"]);
    assert.equal(config.providers["_poke-api"], undefined);
    assert.equal(managed.length, 0);
  });

  it("cleanup only removes disk keys derived from previously-managed ids", () => {
    // The cleanup loop deletes piProviderId(prevId) for prevId in
    // previousManaged and nothing else (pi-merge-models.mjs). A managed-shaped
    // entry — "_" key plus the pi fingerprint — that is NOT in
    // previousManaged must therefore survive; a plain foreign key can never
    // even be a cleanup candidate.
    const existing = {
      providers: {
        "my-custom": { models: [] },
        "_deepseek": { name: "deepseek", headers: { "x-agent-id": "pi" }, models: [] },
      },
    };
    const { config } = mergeModelsJson(existing, {}, 47821, ["poke-api"]);
    assert.ok(config.providers["my-custom"]);
    assert.ok(config.providers["_deepseek"], "a _-prefixed entry outside previousManaged is not cleanup's to remove");
  });
});

describe("readModelsJson", () => {
  it("returns empty providers for missing file", () => {
    // Isolated fixture dir — a fixed name under the shared %TEMP% would go red
    // the moment any other process drops a file with the same name there.
    const dir = mkTestDir("pi-merge-test-");
    assert.deepEqual(readModelsJson(join(dir, "models.json")), { providers: {} });
  });

  it("throws UnparseableModelsError for a corrupt file instead of treating it as empty", () => {
    const dir = mkTestDir("pi-merge-test-");
    const filePath = join(dir, "models.json");
    writeFileSync(filePath, "{ not valid json", "utf8");
    assert.throws(() => readModelsJson(filePath), UnparseableModelsError);
    // The original file must be left untouched.
    assert.equal(readFileSync(filePath, "utf8"), "{ not valid json");
  });

  it("parses a UTF-8 BOM-prefixed file", () => {
    const dir = mkTestDir("pi-merge-test-");
    const filePath = join(dir, "models.json");
    writeFileSync(filePath, "\uFEFF" + JSON.stringify({ providers: { "poke-api": {} } }), "utf8");
    const parsed = readModelsJson(filePath);
    assert.ok(parsed.providers["poke-api"]);
  });
});

describe("writeModelsJsonWithBackup", () => {
  it("writes data and creates backup for existing file", () => {
    const dir = mkTestDir("pi-merge-test-");
    const filePath = join(dir, "models.json");
    writeFileSync(filePath, JSON.stringify({ providers: {} }), "utf8");
    const result = writeModelsJsonWithBackup(filePath, { providers: { new: true } });
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);
    assert.ok(existsSync(result.backupPath));
    const written = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(written.providers.new, true);
  });

  it("skips backup when file does not exist yet", () => {
    const dir = mkTestDir("pi-merge-test-");
    const filePath = join(dir, "models.json");
    const result = writeModelsJsonWithBackup(filePath, { providers: { first: true } });
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);
    assert.equal(result.backupPath, undefined);
  });

  it("returns unchanged when content is identical", () => {
    const dir = mkTestDir("pi-merge-test-");
    const filePath = join(dir, "models.json");
    writeFileSync(filePath, JSON.stringify({ providers: { a: 1 } }, null, 2) + "\n", "utf8");
    const result = writeModelsJsonWithBackup(filePath, { providers: { a: 1 } });
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
  });

  it("prunes to the newest 5 backups and never touches pi's own models-store.backup.*", () => {
    const dir = mkTestDir("pi-merge-test-");
    const filePath = join(dir, "models.json");
    for (let i = 1; i <= 6; i++) {
      writeFileSync(join(dir, `models.backup.2020-01-0${i}T00-00-00-000Z.json`), `old${i}`, "utf8");
    }
    // pi writes its own backups (models-store.backup.*) into ~/.pi/agent; the
    // exact "models.backup." prefix must never match them.
    const foreign = join(dir, "models-store.backup.2020-01-01T00-00-00-000Z.json");
    writeFileSync(foreign, "foreign", "utf8");
    writeFileSync(filePath, JSON.stringify({ providers: {} }), "utf8");
    const result = writeModelsJsonWithBackup(filePath, { providers: { new: true } });
    assert.equal(result.ok, true);
    const backups = readdirSync(dir).filter((n) => n.startsWith("models.backup.")).sort();
    assert.equal(backups.length, 5);
    assert.equal(backups[0], "models.backup.2020-01-03T00-00-00-000Z.json", "oldest backups pruned");
    assert.ok(backups.includes(result.backupPath.split(/[\\/]/).pop()), "fresh backup kept");
    assert.equal(existsSync(foreign), true, "pi's own models-store.backup.* must survive");
  });
});

describe("extractManagedProviders", () => {
  it("extracts providers with non-empty models", () => {
    const extracted = extractManagedProviders(STORE);
    assert.equal(Object.keys(extracted).length, 2);
    assert.ok(extracted["poke-api"]);
    assert.ok(extracted["deepseek"]);
  });

  it("skips providers with empty models", () => {
    const store = {
      version: 2,
      providers: {
        empty: { baseURL: "https://x", models: {} },
        full: { baseURL: "https://y", models: { m: {} } },
      },
    };
    const extracted = extractManagedProviders(store);
    assert.equal(Object.keys(extracted).length, 1);
    assert.ok(extracted["full"]);
    assert.equal(extracted["empty"], undefined);
  });
});

describe("validatePiModelsConfig", () => {
  it("accepts valid config", () => {
    const result = validatePiModelsConfig({
      providers: {
        "_test": { baseUrl: "http://x", models: [{ id: "m1" }] },
      },
    });
    assert.equal(result.valid, true);
  });

  it("rejects non-object config", () => {
    assert.equal(validatePiModelsConfig(null).valid, false);
    assert.equal(validatePiModelsConfig("str").valid, false);
    assert.equal(validatePiModelsConfig([]).valid, false);
  });

  it("rejects config without providers", () => {
    assert.equal(validatePiModelsConfig({}).valid, false);
  });

  it("rejects provider with invalid model entry", () => {
    const result = validatePiModelsConfig({
      providers: {
        "_test": { models: [{ id: "" }] },
      },
    });
    assert.equal(result.valid, false);
  });
});

// Sidecar semantics are the shared merge-common implementation's contract and
// are pinned there (merge-common.test.mjs: missing-file read-empty, sorted
// round-trip, exact on-disk format). The pi-specific part — the wrapper's
// pi-sidecar.json filename — is exercised end-to-end elsewhere:
// pi-launcher.test.mjs "writes models.json with _ prefixed providers and
// sidecar" drives the production writeSidecar path and asserts the literal
// filename; uninstall-agent.test.mjs seeds/asserts pi-sidecar.json against the
// sidecarPath-based cleanup.

describe("pool channels", () => {
  const POOL_STORE = {
    version: 2,
    providers: {
      "poke-api": {
        ...STORE.providers["poke-api"],
        models: {
          "claude-opus-5": { displayName: "Claude Opus 5" },
          "claude-sonnet-4": { displayName: "Claude Sonnet 4", contextWindow: 200000 },
        },
      },
      deepseek: {
        ...STORE.providers.deepseek,
        models: {
          "claude-opus-5": { displayName: "DS Opus" },
          "deepseek-v4": { displayName: "DeepSeek V4", maxOutputTokens: 8000 },
        },
      },
    },
    pools: {
      "pool-claude": { displayName: "Claude Pool", members: ["poke-api", "deepseek"] },
    },
  };

  it("surfaces a pool as one provider with unioned, deduped models", () => {
    const { config, managed } = mergeModelsJson({ providers: {} }, extractManagedProviders(POOL_STORE), 47821, [], null, null, RELAY_TOKEN);
    const pool = config.providers["_pool-claude"];
    assert.ok(pool);
    assert.equal(pool.name, "Claude Pool");
    assert.equal(pool.baseUrl, "http://127.0.0.1:47821/openai/pool-claude/v1");
    assert.equal(pool.apiKey, RELAY_TOKEN);
    assert.deepEqual(pool.headers, { "x-agent-id": "pi", "x-agent-instance": "direct" });
    assert.deepEqual(pool.models.map((m) => m.id), ["claude-opus-5", "claude-sonnet-4", "deepseek-v4"]);
    // First member in pool order wins the shared model's metadata.
    assert.equal(pool.models[0].name, "Claude Opus 5");
    assert.equal(pool.models[2].maxTokens, 8000);
    // Member channels are absorbed into the pool channel — every endpoint sees
    // one provider per pool, exactly like the wire catalog.
    assert.equal(config.providers["_poke-api"], undefined);
    assert.equal(config.providers["_deepseek"], undefined);
    assert.ok(managed.includes("pool-claude"));
  });

  it("removes the pool provider after the pool is dissolved", () => {
    const withPool = mergeModelsJson({ providers: {} }, extractManagedProviders(POOL_STORE), 47821, []);
    const withoutPool = mergeModelsJson(
      withPool.config,
      extractManagedProviders({ version: 2, providers: POOL_STORE.providers }),
      47821,
      withPool.managed,
    );
    assert.equal(withoutPool.config.providers["_pool-claude"], undefined);
    assert.ok(withoutPool.config.providers["_poke-api"]);
  });

  it("lets a pool reuse a member provider id as a single channel", () => {
    const store = {
      ...POOL_STORE,
      pools: { "poke-api": { displayName: "Poke Pool", members: ["poke-api", "deepseek"] } },
    };
    const { config, managed } = mergeModelsJson({ providers: {} }, extractManagedProviders(store), 47821, []);
    const channel = config.providers["_poke-api"];
    assert.equal(channel.name, "Poke Pool");
    assert.equal(channel.baseUrl, "http://127.0.0.1:47821/openai/poke-api/v1");
    assert.deepEqual(channel.models.map((m) => m.id), ["claude-opus-5", "claude-sonnet-4", "deepseek-v4"]);
    // The other member is absorbed too; only the pool channel remains managed.
    assert.equal(config.providers["_deepseek"], undefined);
    assert.deepEqual(managed, ["poke-api"]);
  });
});

describe("auto routing channel (Anyswitch)", () => {
  const CHAIN_STORE = {
    ...STORE,
    routingChains: {
      pi: {
        chain: [
          { node: "poke-api", model: "claude-opus-5" },
          { node: "deepseek", model: "deepseek-v4" },
        ],
      },
    },
  };

  it("keys the pseudo-channel by its display name so the picker badge reads [Anyswitch]", () => {
    const auto = deriveAutoRouteChannel(CHAIN_STORE, "pi");
    const { config, managed } = mergeModelsJson(
      { providers: {} },
      extractManagedProviders(CHAIN_STORE),
      47821,
      [],
      auto,
      null,
      RELAY_TOKEN,
    );
    // pi 的模型选择器每行只渲染 [provider id]，所以伪渠道的 key 必须是可见渠道名。
    const entry = config.providers.Anyswitch;
    assert.ok(entry, "Anyswitch pseudo-channel must be injected");
    assert.equal(config.providers._auto, undefined, "the old _auto key must not be written");
    assert.equal(entry.name, "Anyswitch");
    // The base URL points at the chain HEAD node, not at a literal "auto" segment.
    assert.equal(entry.baseUrl, "http://127.0.0.1:47821/openai/poke-api/v1");
    assert.equal(entry.api, "openai-completions");
    assert.deepEqual(entry.headers, { "x-agent-id": "pi", "x-agent-instance": "direct" });
    assert.deepEqual(entry.models.map((m) => m.id), ["auto"]);
    assert.ok(managed.includes("auto"), "sidecar tracks the pseudo-channel as managed");
    assert.equal(validatePiModelsConfig(config).valid, true);
  });

  it("does not inject the pseudo-channel when the endpoint has no route chain", () => {
    const { config, managed } = mergeModelsJson(
      { providers: {} },
      extractManagedProviders(STORE),
      47821,
      [],
      deriveAutoRouteChannel(STORE, "pi"),
    );
    assert.equal(config.providers.Anyswitch, undefined);
    assert.equal(config.providers._auto, undefined);
    assert.ok(!managed.includes("auto"));
  });

  it("cleans up the pseudo-channel on the re-sync after the chain is deleted", () => {
    const first = mergeModelsJson(
      { providers: {} },
      extractManagedProviders(CHAIN_STORE),
      47821,
      [],
      deriveAutoRouteChannel(CHAIN_STORE, "pi"),
    );
    assert.ok(first.config.providers.Anyswitch);
    const second = mergeModelsJson(
      first.config,
      extractManagedProviders(STORE),
      47821,
      first.managed,
      deriveAutoRouteChannel(STORE, "pi"),
    );
    assert.equal(second.config.providers.Anyswitch, undefined, "stale pseudo-channel removed once the chain is gone");
    assert.ok(second.config.providers["_poke-api"], "real channels survive the cleanup");
    assert.ok(!second.managed.includes("auto"));
  });

  it("drops the legacy _auto managed entry on the first sync after the rename", () => {
    const legacy = {
      providers: {
        _auto: {
          name: "Anyswitch",
          baseUrl: "http://127.0.0.1:47821/openai/poke-api/v1",
          apiKey: "old-token",
          api: "openai-completions",
          headers: { "x-agent-id": "pi", "x-agent-instance": "direct" },
          models: [{ id: "auto" }],
        },
      },
    };
    const { config } = mergeModelsJson(
      legacy,
      extractManagedProviders(CHAIN_STORE),
      47821,
      ["auto"],
      deriveAutoRouteChannel(CHAIN_STORE, "pi"),
      null,
      RELAY_TOKEN,
    );
    assert.equal(config.providers._auto, undefined, "legacy _auto entry removed");
    assert.ok(config.providers.Anyswitch, "the renamed pseudo-channel is written");
  });

  it("leaves a user-written _auto provider without the pi fingerprint alone", () => {
    const mine = {
      providers: {
        _auto: {
          name: "my own",
          baseUrl: "https://mine.example/v1",
          apiKey: "sk-mine",
          models: [{ id: "m1" }],
        },
      },
    };
    const { config } = mergeModelsJson(
      mine,
      extractManagedProviders(CHAIN_STORE),
      47821,
      ["auto"],
      deriveAutoRouteChannel(CHAIN_STORE, "pi"),
      null,
      RELAY_TOKEN,
    );
    assert.equal(config.providers._auto.name, "my own", "a user provider is never excised");
    assert.ok(config.providers.Anyswitch);
  });
});

describe("pi provider id mapping", () => {
  it("maps the pseudo-channel to the display name and real channels to the managed prefix", () => {
    assert.equal(piProviderId("auto"), "Anyswitch");
    assert.equal(piProviderId("poke-api"), "_poke-api");
  });
});
describe("static on-disk auth values (direct-launch decoupling)", () => {
  // 结论（2026-10，证据为本机安装 @earendil-works/pi-coding-agent 1.0.4）：
  // pi 对 apiKey 与 header 值做 ${VAR} 模板展开、缺变量即抛错
  // （dist/core/resolve-config-value.js resolveConfigValueOrThrow /
  // resolveHeadersOrThrow），且模板语法没有 ${VAR:-default} 默认值形式——
  // "${...}" 内容不匹配变量名正则时按字面量原样保留。占位符路径因此必然把
  // 直启（绕过 launcher）锁死在启动抛错上。新方案：models.json 落真实值
  // （apiKey = 稳定 relay token，x-agent-instance = 静态 "direct"），按实例
  // 标签改由 launcher 启动前改写、退出后恢复承担（见下方 launch-time retag
  // 测试）。本组测试钉住「真实值落盘、直启不崩」这一前提。
  it("preserves ${VAR} placeholders in a non-managed provider's headers verbatim", () => {
    const existing = {
      providers: {
        "my-custom": {
          baseUrl: "http://x",
          headers: { "x-instance-id": "${ANYSWITCH_INSTANCE_ID}" },
          models: [{ id: "m1" }],
        },
      },
    };
    const { config } = mergeModelsJson(existing, STORE.providers, 47821);
    assert.equal(config.providers["my-custom"].headers["x-instance-id"], "${ANYSWITCH_INSTANCE_ID}");
  });

  it("writes real values (never placeholders) into every managed provider", () => {
    const { config } = mergeModelsJson({ providers: {} }, STORE.providers, 47821, [], null, null, RELAY_TOKEN);
    for (const id of ["_poke-api", "_deepseek"]) {
      assert.equal(config.providers[id].apiKey, RELAY_TOKEN);
      assert.equal(config.providers[id].headers["x-agent-instance"], DIRECT_INSTANCE_ID);
      // 已有的 x-agent-id 静态头保留不动。
      assert.equal(config.providers[id].headers["x-agent-id"], "pi");
      assert.ok(!JSON.stringify(config.providers[id]).includes("${"), "no ${VAR} placeholder may reach the disk file");
    }
  });

  it("keeps the real values through a write/read round-trip on disk", () => {
    const dir = mkTestDir("pi-merge-test-");
    const filePath = join(dir, "models.json");
    const { config } = mergeModelsJson({ providers: {} }, STORE.providers, 47821, [], null, null, RELAY_TOKEN);
    writeModelsJsonWithBackup(filePath, config);
    const reread = readModelsJson(filePath);
    assert.equal(reread.providers["_poke-api"].apiKey, RELAY_TOKEN);
    assert.equal(reread.providers["_poke-api"].headers["x-agent-instance"], DIRECT_INSTANCE_ID);
  });

  it("omits apiKey entirely when no token reaches the merge", () => {
    // 调用方拿不到 token 时宁可写一个无 key 的 provider（pi 仅在使用该
    // provider 时才报鉴权问题），也不能让占位符或 null 落盘把直启崩掉。
    const entry = buildPiProviderEntry("poke-api", STORE.providers["poke-api"], 47821);
    assert.equal("apiKey" in entry["_poke-api"], false);
  });
});

describe("launch-time instance retag", () => {
  const managedConfig = () => ({
    providers: {
      _poke: {
        name: "poke",
        baseUrl: "http://127.0.0.1:47821/openai/poke/v1",
        apiKey: "stable-token",
        api: "openai-completions",
        headers: { "x-agent-id": "pi", "x-agent-instance": DIRECT_INSTANCE_ID },
        models: [{ id: "m1" }],
      },
      "user-own": {
        name: "mine",
        baseUrl: "https://x.example/v1",
        apiKey: "sk-user",
        headers: { "x-agent-id": "custom" },
        models: [{ id: "u1" }],
      },
    },
  });

  it("rewrites managed entries to the launch values and leaves foreign providers alone", () => {
    const dir = mkTestDir("pi-retag-");
    const filePath = join(dir, "models.json");
    writeFileSync(filePath, JSON.stringify(managedConfig(), null, 2) + "\n", "utf8");
    const result = tagManagedProvidersForLaunch(filePath, { token: "launch-token", instanceId: "proj-123" });
    assert.deepEqual(result, { ok: true, tagged: ["_poke"] });
    const written = readModelsJson(filePath);
    assert.equal(written.providers._poke.apiKey, "launch-token");
    assert.equal(written.providers._poke.headers["x-agent-instance"], "proj-123");
    assert.equal(written.providers["user-own"].apiKey, "sk-user", "foreign provider untouched");
  });

  it("retags the Anyswitch pseudo-channel key, which has no managed prefix", () => {
    const dir = mkTestDir("pi-retag-");
    const filePath = join(dir, "models.json");
    const config = managedConfig();
    config.providers.Anyswitch = {
      name: "Anyswitch",
      baseUrl: "http://127.0.0.1:47821/openai/poke/v1",
      apiKey: "stable-token",
      api: "openai-completions",
      headers: { "x-agent-id": "pi", "x-agent-instance": DIRECT_INSTANCE_ID },
      models: [{ id: "auto" }],
    };
    writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf8");
    const result = tagManagedProvidersForLaunch(filePath, { token: "launch-token", instanceId: "proj-123" });
    assert.deepEqual(result.tagged.sort(), ["Anyswitch", "_poke"]);
    assert.equal(readModelsJson(filePath).providers.Anyswitch.headers["x-agent-instance"], "proj-123");
    const restore = restoreManagedProvidersAfterLaunch(filePath, { token: "launch-token", instanceId: "proj-123" });
    assert.deepEqual(restore.restored.sort(), ["Anyswitch", "_poke"]);
    assert.equal(readModelsJson(filePath).providers.Anyswitch.headers["x-agent-instance"], DIRECT_INSTANCE_ID);
  });

  it("never retags a user provider that happens to be named Anyswitch", () => {
    const dir = mkTestDir("pi-retag-");
    const filePath = join(dir, "models.json");
    const config = {
      providers: {
        Anyswitch: {
          name: "my own",
          baseUrl: "https://mine.example/v1",
          apiKey: "sk-mine",
          headers: { "x-agent-id": "custom" },
          models: [{ id: "m1" }],
        },
      },
    };
    writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf8");
    const result = tagManagedProvidersForLaunch(filePath, { token: "launch-token", instanceId: "proj-123" });
    assert.deepEqual(result, { ok: true, tagged: [] });
    assert.equal(readModelsJson(filePath).providers.Anyswitch.apiKey, "sk-mine");
  });

  it("restores the static instance value after the launch", () => {
    const dir = mkTestDir("pi-retag-");
    const filePath = join(dir, "models.json");
    writeFileSync(filePath, JSON.stringify(managedConfig(), null, 2) + "\n", "utf8");
    tagManagedProvidersForLaunch(filePath, { token: "launch-token", instanceId: "proj-123" });
    const restore = restoreManagedProvidersAfterLaunch(filePath, { token: "launch-token", instanceId: "proj-123" });
    assert.deepEqual(restore, { ok: true, restored: ["_poke"] });
    const written = readModelsJson(filePath);
    assert.equal(written.providers._poke.headers["x-agent-instance"], DIRECT_INSTANCE_ID);
    // The launch token equals the static token in production (same
    // loadOrGenerateToken source), so restore keeps it as-is.
    assert.equal(written.providers._poke.apiKey, "launch-token");
  });

  it("restore leaves a concurrent launcher's retag alone", () => {
    const dir = mkTestDir("pi-retag-");
    const filePath = join(dir, "models.json");
    writeFileSync(filePath, JSON.stringify(managedConfig(), null, 2) + "\n", "utf8");
    tagManagedProvidersForLaunch(filePath, { token: "launch-token", instanceId: "proj-123" });
    // A second launcher retags the same entry with its own instance id.
    tagManagedProvidersForLaunch(filePath, { token: "launch-token", instanceId: "other-456" });
    const restore = restoreManagedProvidersAfterLaunch(filePath, { token: "launch-token", instanceId: "proj-123" });
    assert.deepEqual(restore, { ok: true, restored: [] });
    assert.equal(readModelsJson(filePath).providers._poke.headers["x-agent-instance"], "other-456");
  });

  it("is a no-op when no managed entries exist", () => {
    const dir = mkTestDir("pi-retag-");
    const filePath = join(dir, "models.json");
    const original = JSON.stringify({ providers: { "user-own": managedConfig().providers["user-own"] } }, null, 2) + "\n";
    writeFileSync(filePath, original, "utf8");
    const result = tagManagedProvidersForLaunch(filePath, { token: "t", instanceId: "i" });
    assert.deepEqual(result, { ok: true, tagged: [] });
    assert.equal(readFileSync(filePath, "utf8"), original, "file untouched");
  });

  it("treats a missing models.json as nothing to tag", () => {
    const dir = mkTestDir("pi-retag-");
    const result = tagManagedProvidersForLaunch(join(dir, "models.json"), { token: "t", instanceId: "i" });
    assert.deepEqual(result, { ok: true, tagged: [] });
    assert.equal(existsSync(join(dir, "models.json")), false, "no file is created");
  });

  it("returns ok:false instead of throwing on an unparseable models.json", () => {
    const dir = mkTestDir("pi-retag-");
    const filePath = join(dir, "models.json");
    writeFileSync(filePath, "{ not valid json", "utf8");
    const tag = tagManagedProvidersForLaunch(filePath, { token: "t", instanceId: "i" });
    assert.equal(tag.ok, false);
    assert.equal(tag.tagged.length, 0);
    const restore = restoreManagedProvidersAfterLaunch(filePath, { token: "t", instanceId: "i" });
    assert.equal(restore.ok, false);
    assert.equal(readFileSync(filePath, "utf8"), "{ not valid json", "corrupt file left untouched");
  });
});

describe("pi thinking effort levels", () => {
  const catalog = {
    models: new Map([
      ["claude-opus-5", { kind: "reasoning", levels: ["high", "xhigh", "max"], default: "high", wire: {}, thinkingFormat: null }],
      ["claude-sonnet-4", { kind: "reasoning", levels: ["low", "high"], default: "high", wire: { low: "medium" }, thinkingFormat: "openai" }],
      ["deepseek-v4", { kind: "non-text", levels: [], default: null, wire: {}, thinkingFormat: null }],
    ]),
  };
  const modelOf = (entry, id) => entry["_poke-api"].models.find((m) => m.id === id);

  it("writes nothing effort-related when no catalog reaches the builder", () => {
    const entry = buildPiProviderEntry("poke-api", STORE.providers["poke-api"], 47821);
    assert.equal(modelOf(entry, "claude-opus-5").reasoning, undefined);
    assert.equal(modelOf(entry, "claude-opus-5").thinkingLevelMap, undefined);
  });

  it("offers the levels with off: null and the level name as wire", () => {
    const entry = buildPiProviderEntry("poke-api", STORE.providers["poke-api"], 47821, catalog);
    assert.deepEqual(modelOf(entry, "claude-opus-5"), {
      id: "claude-opus-5",
      name: "Claude Opus 5",
      contextWindow: 1_000_000,
      reasoning: true,
      thinkingLevelMap: { off: null, high: "high", xhigh: "xhigh", max: "max" },
    });
  });

  it("sends the library wire spelling and names the dialect only when there is one", () => {
    const entry = buildPiProviderEntry("poke-api", STORE.providers["poke-api"], 47821, catalog);
    const model = modelOf(entry, "claude-sonnet-4");
    assert.deepEqual(model.thinkingLevelMap, { off: null, low: "medium", high: "high" });
    assert.deepEqual(model.compat, { thinkingFormat: "openai" });
    assert.equal(modelOf(entry, "claude-opus-5").compat, undefined);
  });

  it("leaves a model the library declares non-text alone", () => {
    const entry = buildPiProviderEntry("deepseek", STORE.providers.deepseek, 47821, catalog);
    assert.deepEqual(entry["_deepseek"].models, [{ id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 1_000_000 }]);
  });

  it("mergeModelsJson forwards the catalog to every provider", () => {
    const { config } = mergeModelsJson({ providers: {} }, STORE.providers, 47821, [], null, catalog);
    assert.equal(config.providers["_poke-api"].models[0].reasoning, true);
    assert.equal(config.providers["_deepseek"].models[0].reasoning, undefined);
  });
});
