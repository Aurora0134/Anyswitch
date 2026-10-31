import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  readZcodeConfig,
  writeZcodeConfigWithBackup,
  UnparseableConfigError,
  buildZcodeProviderEntry,
  mergeZcodeConfig,
  extractManagedProviders,
  validateZcodeConfig,
  readSidecar,
  writeSidecar,
  sidecarPath,
  deriveAutoRouteChannel,
} from "./zcode-merge-config.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

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
    // A fresh fixture directory guarantees absence; a fixed name in the shared
    // temp dir only passed while nothing else happened to own that name.
    const dir = mkTestDir("zcode-merge-test-");
    assert.deepEqual(readZcodeConfig(join(dir, "absent.json")), { provider: {} });
  });

  it("throws UnparseableConfigError for a corrupt file instead of treating it as empty", () => {
    const dir = mkTestDir("zcode-merge-test-");
    const filePath = join(dir, "config.json");
    writeFileSync(filePath, "{ not valid json", "utf8");
    assert.throws(() => readZcodeConfig(filePath), UnparseableConfigError);
    // The original file must be left untouched.
    assert.equal(readFileSync(filePath, "utf8"), "{ not valid json");
  });

  it("parses a UTF-8 BOM-prefixed file", () => {
    const dir = mkTestDir("zcode-merge-test-");
    const filePath = join(dir, "config.json");
    writeFileSync(filePath, "\uFEFF" + JSON.stringify({ provider: { "my-custom": {} } }), "utf8");
    const parsed = readZcodeConfig(filePath);
    assert.ok(parsed.provider["my-custom"]);
  });
});

describe("mergeZcodeConfig", () => {
  it("adds managed providers and keeps existing custom providers", () => {
    const existing = { provider: { "my-custom": { kind: "custom" } } };
    const managedProviders = extractManagedProviders(STORE);
    const { config, managed } = mergeZcodeConfig(existing, managedProviders, 47821, "tok");
    assert.ok(config.provider["my-custom"]);
    assert.ok(config.provider["_poke-api"]);
    assert.ok(config.provider["_nvidia-nim"]);
    assert.deepEqual(managed.sort(), ["nvidia-nim", "poke-api"]);
  });

  it("keeps top-level fields the merge does not own", () => {
    // config.json carries more than the provider map ($schema, user keys the
    // current ZCode schema passes through); a sync must not strip them.
    const existing = {
      $schema: "https://example.invalid/zcode-config.schema.json",
      provider: { "my-custom": { kind: "custom" } },
      userKey: { nested: [1, 2, 3] },
    };
    const { config } = mergeZcodeConfig(existing, extractManagedProviders(STORE), 47821, "tok");
    assert.equal(config.$schema, "https://example.invalid/zcode-config.schema.json");
    assert.deepEqual(config.userKey, { nested: [1, 2, 3] });
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
    // (context-fallback.mjs) gives it the claude-opus tier (1M) rather than a
    // conservative default.
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
    const dir = mkTestDir("zcode-merge-test-");
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
    const dir = mkTestDir("zcode-merge-test-");
    const filePath = join(dir, "config.json");
    const data = { provider: {} };
    writeZcodeConfigWithBackup(filePath, data);
    const result = writeZcodeConfigWithBackup(filePath, data);
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
  });

  it("prunes backups down to the newest 5 after a write", () => {
    const dir = mkTestDir("zcode-merge-test-");
    const filePath = join(dir, "config.json");
    // The write's own backup carries the wall clock (zcode-merge-config.mjs
    // timestamp()), so the fixture names are anchored to the same clock rather
    // than a hardcoded 2020 date — otherwise the expected prune order depends
    // on the machine's date being later than the hardcoded stamps.
    const now = Date.now();
    const stamp = (msAgo) => new Date(now - msAgo).toISOString().replace(/[:.]/g, "-");
    for (let i = 1; i <= 6; i++) {
      writeFileSync(join(dir, `config.backup.${stamp(i * 60_000)}.json`), `old${i}`, "utf8");
    }
    writeFileSync(filePath, JSON.stringify({ provider: {} }), "utf8");
    const result = writeZcodeConfigWithBackup(filePath, { provider: { new: true } });
    assert.equal(result.ok, true);
    const backups = readdirSync(dir).filter((n) => n.startsWith("config.backup.")).sort();
    assert.equal(backups.length, 5);
    assert.equal(backups[0], `config.backup.${stamp(4 * 60_000)}.json`, "oldest backups pruned");
    assert.ok(backups.includes(result.backupPath.split(/[\\/]/).pop()), "fresh backup kept");
  });

  it("fails closed while a live ZCode-style lock is held, then writes after release", () => {
    const dir = mkTestDir("zcode-merge-test-");
    const filePath = join(dir, "config.json");
    const before = JSON.stringify({ provider: { existing: true } });
    writeFileSync(filePath, before, "utf8");

    // A running ZCode holding its directory lock looks exactly like this.
    const lockPath = `${filePath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, "owner-1234-1-foreign.json"),
      `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "foreign" })}\n`,
      "utf8",
    );

    const refused = writeZcodeConfigWithBackup(filePath, { provider: { new: true } }, { lockWaitMs: 120 });
    assert.equal(refused.ok, false);
    assert.equal(refused.unchanged, true);
    assert.match(refused.reason, /directory lock/);
    assert.equal(readFileSync(filePath, "utf8"), before, "a refused write never touches the file");
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("config.backup.")), [], "no backup either");
    assert.ok(existsSync(join(lockPath, "owner-1234-1-foreign.json")), "the live foreign lock survives");

    rmSync(lockPath, { recursive: true, force: true });
    const written = writeZcodeConfigWithBackup(filePath, { provider: { new: true } }, { lockWaitMs: 120 });
    assert.equal(written.ok, true);
    assert.equal(written.unchanged, false);
    assert.equal(JSON.parse(readFileSync(filePath, "utf8")).provider.new, true);
    assert.equal(existsSync(lockPath), false, "our own lock is released afterwards");
  });
});

describe("validateZcodeConfig", () => {
  it("accepts a valid merged config", () => {
    const { config } = mergeZcodeConfig({ provider: {} }, extractManagedProviders(STORE), 47821, "tok");
    assert.deepEqual(validateZcodeConfig(config), { valid: true });
  });

  it("rejects config without a provider object", () => {
    assert.equal(validateZcodeConfig({}).valid, false);
  });
});

describe("sidecar", () => {
  it("round-trips managed provider ids", () => {
    const dir = mkTestDir("zcode-merge-test-");
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
    const managedProviders = extractManagedProviders(store);
    const { config, managed } = mergeZcodeConfig({ provider: {} }, managedProviders, 47821, "tok");
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
    const managedProviders = extractManagedProviders(POOL_STORE);
    const { config } = mergeZcodeConfig({ provider: {} }, managedProviders, 47821, "tok");
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
    const managedProviders = extractManagedProviders({ version: 2, providers: POOL_STORE.providers });
    const { config, managed } = mergeZcodeConfig(existing, managedProviders, 47821, "tok", ["pool-claude", "poke-api"]);
    assert.equal(config.provider["_pool-claude"], undefined);
    assert.ok(config.provider["_poke-api"]);
    assert.deepEqual(managed.sort(), ["nvidia-nim", "poke-api"]);
  });

  it("lets a pool reuse a member provider id as a single channel", () => {
    const store = {
      ...POOL_STORE,
      pools: { "poke-api": { displayName: "Poke Pool", members: ["poke-api", "nvidia-nim"] } },
    };
    const managedProviders = extractManagedProviders(store);
    assert.ok(managedProviders["poke-api"].channelName, "pool pseudo-provider replaces the member entry");
    const { config, managed } = mergeZcodeConfig({ provider: {} }, managedProviders, 47821, "tok");
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
      extractManagedProviders(CHAIN_STORE),
      47821,
      "tok",
      [],
      auto,
    );
    const entry = config.provider._auto;
    assert.ok(entry, "_auto channel must be injected");
    assert.equal(entry.name, "Anyswitch");
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
      extractManagedProviders(STORE),
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
      extractManagedProviders(CHAIN_STORE),
      47821,
      "tok",
      [],
      deriveAutoRouteChannel(CHAIN_STORE, "zcode"),
    );
    assert.ok(first.config.provider._auto);
    const second = mergeZcodeConfig(
      first.config,
      extractManagedProviders(STORE),
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

describe("zcode thinking effort levels", () => {
  const PROVIDER = {
    channelName: "poke-api",
    models: {
      "glm-5.3": { displayName: "GLM 5.3", contextWindow: 200000 },
      "agnes-image-2.0-flash": { displayName: "Agnes Image", contextWindow: 8192 },
    },
  };
  const catalog = {
    models: new Map([
      ["glm-5.3", { kind: "reasoning", levels: ["medium", "high", "xhigh", "max"], default: "high", wire: {}, thinkingFormat: null }],
    ]),
  };
  const entryOf = (entry) => entry["_poke-api"].models;

  it("writes no reasoning block without a catalog", () => {
    const entry = buildZcodeProviderEntry("poke-api", PROVIDER, 47821, "tok");
    assert.deepEqual(entryOf(entry)["glm-5.3"], {
      limit: { context: 200000 },
      modalities: { input: ["text", "image"], output: ["text"] },
    });
  });

  it("offers the library levels with the default variant among them", () => {
    const entry = buildZcodeProviderEntry("poke-api", PROVIDER, 47821, "tok", catalog);
    assert.deepEqual(entryOf(entry)["glm-5.3"].reasoning, {
      enabled: true,
      variants: ["medium", "high", "xhigh", "max"],
      defaultVariant: "high",
    });
  });

  // A library row is only load-bearing when the id does not already match the
  // library's non-text name rules (NON_TEXT_RE in effort-catalog.mjs): an
  // agnes-style id stays silent with or without its row, so a row for it would
  // prove nothing. quiet-media-1 matches no name rule — the row is the only
  // thing between it and the optimistic levels.
  it("stays silent for a model the library marks non-text", () => {
    const provider = {
      channelName: "poke-api",
      models: { "quiet-media-1": { displayName: "Quiet Media", contextWindow: 8192 } },
    };
    const row = { kind: "non-text", levels: [], default: null, wire: {}, thinkingFormat: null };
    const withRow = buildZcodeProviderEntry(
      "poke-api",
      provider,
      47821,
      "tok",
      { models: new Map([["quiet-media-1", row]]) },
    );
    assert.equal(withRow["_poke-api"].models["quiet-media-1"].reasoning, undefined);
    // Counterfactual: without the row the optimistic fallback offers levels,
    // so the assertion above genuinely depends on the row.
    const withoutRow = buildZcodeProviderEntry("poke-api", provider, 47821, "tok", { models: new Map() });
    assert.deepEqual(withoutRow["_poke-api"].models["quiet-media-1"].reasoning, {
      enabled: true,
      variants: ["high", "xhigh", "max"],
      defaultVariant: "high",
    });
  });

  // The name rules stay the backstop when the library holds no row at all.
  it("stays silent for a non-text name even with an empty library", () => {
    const entry = buildZcodeProviderEntry("poke-api", PROVIDER, 47821, "tok", { models: new Map() });
    assert.equal(entryOf(entry)["agnes-image-2.0-flash"].reasoning, undefined);
  });

  it("mergeZcodeConfig forwards the catalog", () => {
    const { config } = mergeZcodeConfig({ provider: {} }, { "poke-api": PROVIDER }, 47821, "tok", [], null, catalog);
    assert.deepEqual(
      config.provider["_poke-api"].models["glm-5.3"].reasoning.variants,
      ["medium", "high", "xhigh", "max"],
    );
  });

  // A store row that states its own levels is treated as already correct: the
  // library fills the gap a gateway leaves, it does not overrule the operator.
  it("prefers the store's own declaration over the library", () => {
    const provider = {
      ...PROVIDER,
      models: { ...PROVIDER.models, "glm-5.3": { ...PROVIDER.models["glm-5.3"], reasoningEffortLevels: ["low", "high"] } },
    };
    const entry = buildZcodeProviderEntry("poke-api", provider, 47821, "tok", catalog);
    assert.deepEqual(entryOf(entry)["glm-5.3"].reasoning.variants, ["low", "high"]);
  });

  it("prefers the channel's own declaration over the library", () => {
    const provider = { ...PROVIDER, reasoningVariants: ["low", "medium"] };
    const entry = buildZcodeProviderEntry("poke-api", provider, 47821, "tok", catalog);
    assert.deepEqual(entryOf(entry)["glm-5.3"].reasoning.variants, ["low", "medium"]);
  });
});
