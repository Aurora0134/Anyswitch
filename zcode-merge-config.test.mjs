import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readZcodeConfig,
  writeZcodeConfigWithBackup,
  UnparseableConfigError,
  buildZcodeProviderEntry,
  mergeZcodeConfig,
  extractApiCredProviders,
  validateZcodeConfig,
  readSidecar,
  writeSidecar,
  sidecarPath,
  deriveAutoRouteChannel,
} from "./zcode-merge-config.mjs";

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

describe("readZcodeConfig", () => {
  it("returns empty provider for missing file", () => {
    assert.deepEqual(readZcodeConfig(join(tmpdir(), "nonexistent.json")), { provider: {} });
  });

  it("throws UnparseableConfigError for a corrupt file instead of treating it as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-merge-test-"));
    const filePath = join(dir, "config.json");
    writeFileSync(filePath, "{ not valid json", "utf8");
    assert.throws(() => readZcodeConfig(filePath), UnparseableConfigError);
    // The original file must be left untouched.
    assert.equal(readFileSync(filePath, "utf8"), "{ not valid json");
  });

  it("parses a UTF-8 BOM-prefixed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-merge-test-"));
    const filePath = join(dir, "config.json");
    writeFileSync(filePath, "\uFEFF" + JSON.stringify({ provider: { "my-custom": {} } }), "utf8");
    const parsed = readZcodeConfig(filePath);
    assert.ok(parsed.provider["my-custom"]);
  });
});

describe("mergeZcodeConfig", () => {
  it("adds managed providers and keeps existing custom providers", () => {
    const existing = { provider: { "my-custom": { kind: "custom" } } };
    const apiCredProviders = extractApiCredProviders(STORE);
    const { config, managed } = mergeZcodeConfig(existing, apiCredProviders, 47821, "tok");
    assert.ok(config.provider["my-custom"]);
    assert.ok(config.provider["_poke-api"]);
    assert.ok(config.provider["_nvidia-nim"]);
    assert.deepEqual(managed.sort(), ["nvidia-nim", "poke-api"]);
  });

  it("removes previously managed providers that disappeared from the store", () => {
    const existing = {
      provider: { "_poke-api": { kind: "openai-compatible" }, "my-custom": { kind: "custom" } },
    };
    const { config } = mergeZcodeConfig(existing, {}, 47821, "tok", ["poke-api"]);
    assert.equal(config.provider["_poke-api"], undefined);
    assert.ok(config.provider["my-custom"]);
  });
});

describe("buildZcodeProviderEntry", () => {
  it("projects models without contextWindow through the tier fallback", () => {
    const entry = buildZcodeProviderEntry("poke-api", STORE.providers["poke-api"], 47821, "tok");
    // claude-opus-5 has no store contextWindow; the compat-fix fallback chain
    // (context-fallback.mjs) gives it the claude-opus tier (1M per the
    // 2026-08-16 survey) instead of the old 128K hardcoded default.
    const model = entry["_poke-api"].models["claude-opus-5"];
    assert.equal(model.limit.context, 1_000_000);
    assert.deepEqual(model.modalities, { input: ["text", "image"], output: ["text"] });
    assert.equal(entry["_poke-api"].options.baseURL, "http://127.0.0.1:47821/openai/poke-api/v1");
    assert.equal(entry["_poke-api"].options.apiKey, "tok");
    // 显式端点身份头：relay 的 openai 路径靠它把流量钉在 zcode，兜底桶
    // 只留给未知客户端（ZCode 的 provider schema 支持条目级 headers）。
    assert.deepEqual(entry["_poke-api"].headers, { "x-agent-id": "zcode" });
  });

  it("keeps the real store contextWindow over any fallback tier", () => {
    const provider = {
      ...STORE.providers["poke-api"],
      models: {
        "claude-opus-5": { displayName: "Claude Opus 5", contextWindow: 999000 },
      },
    };
    const entry = buildZcodeProviderEntry("poke-api", provider, 47821, "tok");
    assert.equal(entry["_poke-api"].models["claude-opus-5"].limit.context, 999000);
  });

  it("gives unmatched families the 1M fallback, not the old 128K default", () => {
    const entry = buildZcodeProviderEntry("nvidia-nim", STORE.providers["nvidia-nim"], 47821, "tok");
    // deepseek-chat matches no tier rule -> UNMATCHED_CONTEXT_FALLBACK (1M).
    assert.equal(entry["_nvidia-nim"].models["deepseek-chat"].limit.context, 1_000_000);
  });

  it("projects hub modalities onto ZCode and keeps embeddings text-only", () => {
    const provider = {
      displayName: "Poke API",
      models: {
        "text-embedding-3-large": { displayName: "Embed" },
        "vision-chat": {
          displayName: "Vision",
          inputModalities: ["text", "image", "audio"],
          outputModalities: ["text"],
        },
      },
    };
    const entry = buildZcodeProviderEntry("poke-api", provider, 47821, "tok");
    assert.deepEqual(entry["_poke-api"].models["text-embedding-3-large"].modalities, {
      input: ["text"],
      output: ["text"],
    });
    assert.deepEqual(entry["_poke-api"].models["vision-chat"].modalities, {
      input: ["text", "image", "audio"],
      output: ["text"],
    });
  });
});

describe("writeZcodeConfigWithBackup", () => {
  it("writes data and creates backup for existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-merge-test-"));
    const filePath = join(dir, "config.json");
    writeFileSync(filePath, JSON.stringify({ provider: {} }), "utf8");
    const result = writeZcodeConfigWithBackup(filePath, { provider: { new: true } });
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);
    assert.ok(result.backupPath);
    const written = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(written.provider.new, true);
  });

  it("reports unchanged when content hash matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-merge-test-"));
    const filePath = join(dir, "config.json");
    const data = { provider: {} };
    writeZcodeConfigWithBackup(filePath, data);
    const result = writeZcodeConfigWithBackup(filePath, data);
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
  });

  it("prunes backups down to the newest 5 after a write", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-merge-test-"));
    const filePath = join(dir, "config.json");
    for (let i = 1; i <= 6; i++) {
      writeFileSync(join(dir, `config.backup.2020-01-0${i}T00-00-00-000Z.json`), `old${i}`, "utf8");
    }
    writeFileSync(filePath, JSON.stringify({ provider: {} }), "utf8");
    const result = writeZcodeConfigWithBackup(filePath, { provider: { new: true } });
    assert.equal(result.ok, true);
    const backups = readdirSync(dir).filter((n) => n.startsWith("config.backup.")).sort();
    assert.equal(backups.length, 5);
    assert.equal(backups[0], "config.backup.2020-01-03T00-00-00-000Z.json", "oldest backups pruned");
    assert.ok(backups.includes(result.backupPath.split(/[\\/]/).pop()), "fresh backup kept");
  });
});

describe("validateZcodeConfig", () => {
  it("accepts a valid merged config", () => {
    const { config } = mergeZcodeConfig({ provider: {} }, extractApiCredProviders(STORE), 47821, "tok");
    assert.deepEqual(validateZcodeConfig(config), { valid: true });
  });

  it("rejects config without a provider object", () => {
    assert.equal(validateZcodeConfig({}).valid, false);
  });
});

describe("sidecar", () => {
  it("round-trips managed provider ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-merge-test-"));
    writeSidecar(dir, ["poke-api", "nvidia-nim"]);
    assert.deepEqual(readSidecar(dir).providers, ["nvidia-nim", "poke-api"]);
    assert.equal(sidecarPath(dir), join(dir, "zcode-sidecar.json"));
  });
});

describe("pool channels", () => {
  const POOL_STORE = {
    version: 2,
    providers: {
      "poke-api": STORE.providers["poke-api"],
      "nvidia-nim": STORE.providers["nvidia-nim"],
    },
    pools: {
      "pool-claude": { displayName: "Claude Pool", members: ["poke-api", "nvidia-nim"] },
    },
  };

  it("surfaces a pool as one channel with the union of member models, deduped in pool order", () => {
    const store = {
      ...POOL_STORE,
      providers: {
        "poke-api": {
          ...STORE.providers["poke-api"],
          models: { "claude-opus-5": { displayName: "Claude Opus 5" } },
        },
        "nvidia-nim": {
          ...STORE.providers["nvidia-nim"],
          models: {
            "claude-opus-5": { displayName: "NIM Opus", contextWindow: 999000 },
            "deepseek-chat": { displayName: "DeepSeek Chat" },
          },
        },
      },
    };
    const apiCredProviders = extractApiCredProviders(store);
    const { config, managed } = mergeZcodeConfig({ provider: {} }, apiCredProviders, 47821, "tok");
    const pool = config.provider["_pool-claude"];
    assert.ok(pool);
    assert.equal(pool.name, "Claude Pool");
    assert.equal(pool.options.baseURL, "http://127.0.0.1:47821/openai/pool-claude/v1");
    assert.equal(pool.options.apiKey, "tok");
    assert.deepEqual(Object.keys(pool.models), ["claude-opus-5", "deepseek-chat"]);
    // First member in pool order wins the shared model's metadata.
    assert.equal(pool.models["claude-opus-5"].limit.context, 1_000_000);
    assert.ok(managed.includes("pool-claude"));
  });

  it("absorbs member channels into the pool channel", () => {
    const apiCredProviders = extractApiCredProviders(POOL_STORE);
    const { config } = mergeZcodeConfig({ provider: {} }, apiCredProviders, 47821, "tok");
    assert.ok(config.provider["_pool-claude"]);
    // Members never surface as their own channels — every endpoint sees one
    // provider per pool, exactly like the wire catalog.
    assert.equal(config.provider["_poke-api"], undefined);
    assert.equal(config.provider["_nvidia-nim"], undefined);
  });

  it("removes the pool channel after the pool is dissolved", () => {
    const existing = {
      provider: { "_pool-claude": { kind: "openai-compatible" }, "_poke-api": { kind: "openai-compatible" } },
    };
    const apiCredProviders = extractApiCredProviders({ version: 2, providers: POOL_STORE.providers });
    const { config, managed } = mergeZcodeConfig(existing, apiCredProviders, 47821, "tok", ["pool-claude", "poke-api"]);
    assert.equal(config.provider["_pool-claude"], undefined);
    assert.ok(config.provider["_poke-api"]);
    assert.deepEqual(managed.sort(), ["nvidia-nim", "poke-api"]);
  });

  it("lets a pool reuse a member provider id as a single channel", () => {
    const store = {
      ...POOL_STORE,
      pools: { "poke-api": { displayName: "Poke Pool", members: ["poke-api", "nvidia-nim"] } },
    };
    const apiCredProviders = extractApiCredProviders(store);
    assert.ok(apiCredProviders["poke-api"].channelName, "pool pseudo-provider replaces the member entry");
    const { config, managed } = mergeZcodeConfig({ provider: {} }, apiCredProviders, 47821, "tok");
    const channel = config.provider["_poke-api"];
    assert.equal(channel.name, "Poke Pool");
    assert.equal(channel.options.baseURL, "http://127.0.0.1:47821/openai/poke-api/v1");
    assert.deepEqual(Object.keys(channel.models), ["claude-opus-5", "claude-sonnet-5", "deepseek-chat"]);
    // The other member is absorbed too; only the pool channel remains managed.
    assert.equal(config.provider["_nvidia-nim"], undefined);
    assert.deepEqual(managed, ["poke-api"]);
  });
});

describe("auto routing channel (_auto)", () => {
  const CHAIN_STORE = {
    ...STORE,
    routingChains: {
      zcode: {
        chain: [
          { node: "poke-api", model: "claude-opus-5" },
          { node: "nvidia-nim", model: "deepseek-chat" },
        ],
      },
    },
  };

  it("injects the _auto channel when the endpoint has a route chain", () => {
    const auto = deriveAutoRouteChannel(CHAIN_STORE, "zcode");
    const { config, managed } = mergeZcodeConfig(
      { provider: {} },
      extractApiCredProviders(CHAIN_STORE),
      47821,
      "tok",
      [],
      auto,
    );
    const entry = config.provider._auto;
    assert.ok(entry, "_auto channel must be injected");
    assert.equal(entry.name, "自动路由");
    assert.equal(entry.kind, "openai-compatible");
    // The base URL points at the chain HEAD node, not at a literal "auto" segment.
    assert.equal(entry.options.baseURL, "http://127.0.0.1:47821/openai/poke-api/v1");
    assert.equal(entry.options.apiKey, "tok");
    assert.deepEqual(Object.keys(entry.models), ["auto"]);
    assert.ok(managed.includes("auto"), "sidecar tracks the _auto channel as managed");
    assert.equal(validateZcodeConfig(config).valid, true);
  });

  it("does not inject _auto when the endpoint has no route chain", () => {
    const { config, managed } = mergeZcodeConfig(
      { provider: {} },
      extractApiCredProviders(STORE),
      47821,
      "tok",
      [],
      deriveAutoRouteChannel(STORE, "zcode"),
    );
    assert.equal(config.provider._auto, undefined);
    assert.ok(!managed.includes("auto"));
  });

  it("cleans up _auto on the re-sync after the chain is deleted", () => {
    const first = mergeZcodeConfig(
      { provider: {} },
      extractApiCredProviders(CHAIN_STORE),
      47821,
      "tok",
      [],
      deriveAutoRouteChannel(CHAIN_STORE, "zcode"),
    );
    assert.ok(first.config.provider._auto);
    const second = mergeZcodeConfig(
      first.config,
      extractApiCredProviders(STORE),
      47821,
      "tok",
      first.managed,
      deriveAutoRouteChannel(STORE, "zcode"),
    );
    assert.equal(second.config.provider._auto, undefined, "stale _auto removed once the chain is gone");
    assert.ok(second.config.provider["_poke-api"], "real channels survive the cleanup");
    assert.ok(!second.managed.includes("auto"));
  });
});
