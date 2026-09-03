import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildPiProviderEntry,
  mergeModelsJson,
  readModelsJson,
  writeModelsJsonWithBackup,
  extractManagedProviders,
  validatePiModelsConfig,
  readSidecar,
  writeSidecar,
  sidecarPath,
  UnparseableModelsError,
  deriveAutoRouteChannel,
} from "./pi-merge-models.mjs";

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
    const entry = buildPiProviderEntry("poke-api", STORE.providers["poke-api"], 47821);
    assert.ok(entry["_poke-api"]);
    const p = entry["_poke-api"];
    assert.equal(p.name, "poke-api");
    assert.equal(p.baseUrl, "http://127.0.0.1:47821/openai/poke-api/v1");
    assert.equal(p.apiKey, "${ANYSWITCH_RELAY_TOKEN}");
    assert.equal(p.api, "openai-completions");
    assert.deepEqual(p.headers, { "x-agent-id": "pi", "x-agent-instance": "${ANYSWITCH_INSTANCE_ID}" });
    assert.equal(p.models.length, 2);
    assert.equal(p.models[0].id, "claude-opus-5");
    assert.equal(p.models[0].name, "Claude Opus 5");
    assert.equal(p.models[0].apiKey, undefined);
    assert.equal(p.models[0].provider, undefined);
    assert.equal(p.models[0].baseUrl, undefined);
  });

  it("uses modelId as fallback name when no displayName", () => {
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

  it("does not remove non-managed providers during cleanup", () => {
    const existing = { providers: { "my-custom": { models: [] } } };
    const { config } = mergeModelsJson(existing, {}, 47821, ["poke-api"]);
    assert.ok(config.providers["my-custom"]);
  });
});

describe("readModelsJson", () => {
  it("returns empty providers for missing file", () => {
    assert.deepEqual(readModelsJson(join(tmpdir(), "nonexistent.json")), { providers: {} });
  });

  it("throws UnparseableModelsError for a corrupt file instead of treating it as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-merge-test-"));
    const filePath = join(dir, "models.json");
    writeFileSync(filePath, "{ not valid json", "utf8");
    assert.throws(() => readModelsJson(filePath), UnparseableModelsError);
    // The original file must be left untouched.
    assert.equal(readFileSync(filePath, "utf8"), "{ not valid json");
  });

  it("parses a UTF-8 BOM-prefixed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-merge-test-"));
    const filePath = join(dir, "models.json");
    writeFileSync(filePath, "\uFEFF" + JSON.stringify({ providers: { "poke-api": {} } }), "utf8");
    const parsed = readModelsJson(filePath);
    assert.ok(parsed.providers["poke-api"]);
  });
});

describe("writeModelsJsonWithBackup", () => {
  it("writes data and creates backup for existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-merge-test-"));
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
    const dir = mkdtempSync(join(tmpdir(), "pi-merge-test-"));
    const filePath = join(dir, "models.json");
    const result = writeModelsJsonWithBackup(filePath, { providers: { first: true } });
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);
    assert.equal(result.backupPath, undefined);
  });

  it("returns unchanged when content is identical", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-merge-test-"));
    const filePath = join(dir, "models.json");
    writeFileSync(filePath, JSON.stringify({ providers: { a: 1 } }, null, 2) + "\n", "utf8");
    const result = writeModelsJsonWithBackup(filePath, { providers: { a: 1 } });
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
  });

  it("prunes to the newest 5 backups and never touches pi's own models-store.backup.*", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-merge-test-"));
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

describe("sidecar", () => {
  it("readSidecar returns empty list for missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sidecar-"));
    assert.deepEqual(readSidecar(dir), { providers: [] });
  });

  it("writeSidecar and readSidecar round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sidecar-"));
    writeSidecar(dir, ["deepseek", "poke-api"]);
    const read = readSidecar(dir);
    assert.deepEqual(read.providers, ["deepseek", "poke-api"]);
    assert.ok(existsSync(sidecarPath(dir)));
  });
});
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
    const { config, managed } = mergeModelsJson({ providers: {} }, extractManagedProviders(POOL_STORE), 47821, []);
    const pool = config.providers["_pool-claude"];
    assert.ok(pool);
    assert.equal(pool.name, "Claude Pool");
    assert.equal(pool.baseUrl, "http://127.0.0.1:47821/openai/pool-claude/v1");
    assert.equal(pool.apiKey, "${ANYSWITCH_RELAY_TOKEN}");
    assert.deepEqual(pool.headers, { "x-agent-id": "pi", "x-agent-instance": "${ANYSWITCH_INSTANCE_ID}" });
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

describe("auto routing channel (_auto)", () => {
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

  it("injects the _auto channel when the endpoint has a route chain", () => {
    const auto = deriveAutoRouteChannel(CHAIN_STORE, "pi");
    const { config, managed } = mergeModelsJson(
      { providers: {} },
      extractManagedProviders(CHAIN_STORE),
      47821,
      [],
      auto,
    );
    const entry = config.providers._auto;
    assert.ok(entry, "_auto channel must be injected");
    assert.equal(entry.name, "自动路由");
    // The base URL points at the chain HEAD node, not at a literal "auto" segment.
    assert.equal(entry.baseUrl, "http://127.0.0.1:47821/openai/poke-api/v1");
    assert.equal(entry.api, "openai-completions");
    assert.deepEqual(entry.headers, { "x-agent-id": "pi", "x-agent-instance": "${ANYSWITCH_INSTANCE_ID}" });
    assert.deepEqual(entry.models.map((m) => m.id), ["auto"]);
    assert.ok(managed.includes("auto"), "sidecar tracks the _auto channel as managed");
    assert.equal(validatePiModelsConfig(config).valid, true);
  });

  it("does not inject _auto when the endpoint has no route chain", () => {
    const { config, managed } = mergeModelsJson(
      { providers: {} },
      extractManagedProviders(STORE),
      47821,
      [],
      deriveAutoRouteChannel(STORE, "pi"),
    );
    assert.equal(config.providers._auto, undefined);
    assert.ok(!managed.includes("auto"));
  });

  it("cleans up _auto on the re-sync after the chain is deleted", () => {
    const first = mergeModelsJson(
      { providers: {} },
      extractManagedProviders(CHAIN_STORE),
      47821,
      [],
      deriveAutoRouteChannel(CHAIN_STORE, "pi"),
    );
    assert.ok(first.config.providers._auto);
    const second = mergeModelsJson(
      first.config,
      extractManagedProviders(STORE),
      47821,
      first.managed,
      deriveAutoRouteChannel(STORE, "pi"),
    );
    assert.equal(second.config.providers._auto, undefined, "stale _auto removed once the chain is gone");
    assert.ok(second.config.providers["_poke-api"], "real channels survive the cleanup");
    assert.ok(!second.managed.includes("auto"));
  });
});
describe("per-instance header env expansion feasibility", () => {
  // 可行性结论：pi CLI 对 provider headers 的值做与 apiKey 相同的 ${VAR} 展开，
  // 证据（本机安装 @earendil-works/pi-coding-agent）：
  //   dist/core/resolve-config-value.js:222 resolveHeaders —— 逐值走 resolveConfigValue 模板展开
  //   dist/core/provider-composer.js:242 —— models.json 的 provider headers 经 resolveHeadersOrThrow 解析
  // 因此 launcher 每次启动生成 ANYSWITCH_INSTANCE_ID 即可实现 per-instance 头注入，
  // 前提是 merge 管线把 ${VAR} 占位符原样写进 models.json。以下测试钉住该前提与注入行为。
  // 注意：resolveHeadersOrThrow 对缺失变量会抛错，注入的变量必须由 launcher 保证存在。
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

  it("keeps the literal ${VAR} placeholder through a write/read round-trip on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-merge-test-"));
    const filePath = join(dir, "models.json");
    const { config } = mergeModelsJson(
      {
        providers: {
          "my-custom": {
            baseUrl: "http://x",
            headers: { "x-instance-id": "${ANYSWITCH_INSTANCE_ID}" },
            models: [{ id: "m1" }],
          },
        },
      },
      STORE.providers,
      47821,
    );
    writeModelsJsonWithBackup(filePath, config);
    const reread = readModelsJson(filePath);
    assert.equal(reread.providers["my-custom"].headers["x-instance-id"], "${ANYSWITCH_INSTANCE_ID}");
    // apiKey 侧的 ${ANYSWITCH_RELAY_TOKEN} 占位符同样原样落盘。
    assert.equal(reread.providers["_poke-api"].apiKey, "${ANYSWITCH_RELAY_TOKEN}");
  });

  it("injects the ${ANYSWITCH_INSTANCE_ID} header into every managed provider", () => {
    const { config } = mergeModelsJson({ providers: {} }, STORE.providers, 47821);
    for (const id of ["_poke-api", "_deepseek"]) {
      assert.equal(config.providers[id].headers["x-agent-instance"], "${ANYSWITCH_INSTANCE_ID}");
      // 已有的 x-agent-id 静态头保留不动。
      assert.equal(config.providers[id].headers["x-agent-id"], "pi");
    }
  });

  it("keeps the managed provider's instance placeholder through a disk round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-merge-test-"));
    const filePath = join(dir, "models.json");
    const { config } = mergeModelsJson({ providers: {} }, STORE.providers, 47821);
    writeModelsJsonWithBackup(filePath, config);
    const reread = readModelsJson(filePath);
    assert.equal(reread.providers["_poke-api"].headers["x-agent-instance"], "${ANYSWITCH_INSTANCE_ID}");
  });
});
