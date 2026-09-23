import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildGrokManagedToml,
  mergeGrokConfigToml,
  stripManagedBlock,
  stripManagedTables,
  writeGrokConfigTomlWithBackup,
  writeGrokConfig,
  extractManagedProviders,
  deriveAutoRouteChannel,
  readSidecar,
  writeSidecar,
  sidecarPath,
  grokConfigPath,
  managedModelKey,
  MANAGED_BEGIN,
  MANAGED_END,
  AUTO_MODEL_KEY,
} from "./grok-merge-config.mjs";
import {
  packChannelModelSlug,
  unpackChannelModelSlug,
  CHANNEL_MODEL_SEPARATOR,
} from "./channel-model-slug.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

const STORE = {
  version: 2,
  providers: {
    "poke-api": {
      displayName: "Poke API",
      baseURL: "https://poke.example/v1",
      protocol: "openai-compatible",
      credentialFile: "poke-api.dpapi",
      models: {
        "gpt-6-astra": { displayName: "GPT 6 Astra", contextWindow: 256000 },
      },
    },
  },
};

const CHAIN_STORE = {
  ...STORE,
  routingChains: {
    grok: { chain: [{ node: "poke-api", model: "gpt-6-astra" }] },
  },
};

describe("grok-merge-config", () => {
  it("builds one chat/completions model table per (channel, model) pair", () => {
    const providers = extractManagedProviders(STORE);
    const { text, managed, modelKeys } = buildGrokManagedToml(providers, 47821, "tok");
    assert.deepEqual(managed, ["poke-api"]);
    assert.deepEqual(modelKeys, ["anyswitch-poke-api~gpt-6-astra"]);
    assert.match(text, /\[model\."anyswitch-poke-api~gpt-6-astra"\]/);
    assert.match(text, /model = "gpt-6-astra"/);
    // name 带渠道后缀：选择器每行只读 name，跨渠道同名模型靠它区分。
    assert.match(text, /name = "GPT 6 Astra · Poke API"/);
    assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:47821\/openai\/poke-api\/v1"/);
    assert.match(text, /api_key = "tok"/);
    assert.match(text, /context_window = 256000/);
    assert.match(text, /extra_headers = \{ "x-agent-id" = "grok" \}/);
    assert.match(text, /env_http_headers = \{ "x-agent-instance" = "ANYSWITCH_INSTANCE_ID" \}/);
    // 刻意不写的键：api_backend（文档默认即 chat_completions）、env_key（token
    // 是文件里读的轮换值，env 引用无意义）。reasoning_efforts 只在拿到挡位库
    // 时才写（见下一个 describe）——这里没传 catalog，托管块保持无挡位。
    assert.doesNotMatch(text, /api_backend/);
    assert.doesNotMatch(text, /env_key/);
    assert.doesNotMatch(text, /reasoning_efforts/);
    // 托管块永不声明 [models] 表（TOML 拒绝重复表声明，用户的 [models] 不可碰）。
    assert.doesNotMatch(text, /^\[models\]$/m);
  });

  it("falls back through the shared context tier table when the store omits contextWindow", () => {
    const providers = { alpha: { models: { "m-1": {}, "gpt-5-thing": {} } } };
    const { text } = buildGrokManagedToml(providers, 47821, "tok");
    // 关键词档位命中 gpt-5 → 272000；未命中落 1M 兜底（不是 grok 自带的 200000）。
    assert.match(text, /\[model\."anyswitch-alpha~gpt-5-thing"\]\nmodel = "gpt-5-thing"[\s\S]*?context_window = 272000/);
    assert.match(text, /\[model\."anyswitch-alpha~m-1"\]\nmodel = "m-1"[\s\S]*?context_window = 1000000/);
    assert.doesNotMatch(text, /context_window = 200000/);
    assert.match(text, /name = "m-1 · alpha"/, "model label falls back to the model id");
  });

  it("keys same-named models on two channels as distinct entries with channel-suffixed names", () => {
    const store = {
      version: 2,
      providers: {
        alpha: { displayName: "Alpha", models: { "m-one": { displayName: "M One" } } },
        beta: { displayName: "Beta", models: { "m-one": {} } },
      },
    };
    const { text } = buildGrokManagedToml(extractManagedProviders(store), 47821, "tok");
    assert.match(text, /\[model\."anyswitch-alpha~m-one"\]/);
    assert.match(text, /\[model\."anyswitch-beta~m-one"\]/);
    assert.match(text, /name = "M One · Alpha"/);
    assert.match(text, /name = "m-one · Beta"/);
    assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:47821\/openai\/alpha\/v1"/);
    assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:47821\/openai\/beta\/v1"/);
  });

  it("preserves foreign sections verbatim and replaces a previous managed block", () => {
    const existing = [
      "[cli]",
      'installer = "internal"',
      "",
      "[marketplace]",
      "default_skills_installs_purged = true",
      "",
      "[marketplace.keep]",
      "x = 1",
      "",
      MANAGED_BEGIN,
      '[model."anyswitch-old-model"]',
      'base_url = "http://127.0.0.1:47821/openai/old/v1"',
      MANAGED_END,
      "",
    ].join("\n");
    const { text } = mergeGrokConfigToml(existing, extractManagedProviders(STORE), 47821, "tok");
    assert.match(text, /\[cli\]\ninstaller = "internal"/);
    assert.match(text, /\[marketplace\]/);
    assert.match(text, /\[marketplace\.keep\]\nx = 1/);
    assert.doesNotMatch(text, /anyswitch-old-model/);
    assert.match(text, /\[model\."anyswitch-poke-api~gpt-6-astra"\]/);
    // Foreign sections stay in front; the managed block is always appended last.
    assert.ok(text.indexOf("[cli]") < text.indexOf(MANAGED_BEGIN));
    assert.equal(text.trimEnd().endsWith(MANAGED_END), true);
  });

  it("is idempotent: merging the merged output changes nothing", () => {
    const once = mergeGrokConfigToml("", extractManagedProviders(CHAIN_STORE), 47821, "tok", deriveAutoRouteChannel(CHAIN_STORE, "grok"));
    const twice = mergeGrokConfigToml(once.text, extractManagedProviders(CHAIN_STORE), 47821, "tok", deriveAutoRouteChannel(CHAIN_STORE, "grok"));
    assert.equal(twice.text, once.text);
  });

  it("refuses a truncated managed block", () => {
    assert.throws(
      () => stripManagedBlock(`${MANAGED_BEGIN}\n[model."anyswitch-x"]\n`),
      (err) => err.code === "UNPARSEABLE_GROK_CONFIG",
    );
  });

  it("strips unmarked anyswitch tables left by a marker-dropping rewrite, including expanded sub-tables", () => {
    const rewritten = [
      "[models]",
      'default = "anyswitch-poke-api~gpt-6-astra"',
      "",
      "[cli]",
      'installer = "internal"',
      "",
      "[model.anyswitch-poke-api~gpt-6-astra]",
      'model = "gpt-6-astra"',
      'api_key = "old-tok"',
      "",
      "[model.anyswitch-poke-api~gpt-6-astra.extra_headers]",
      '"x-agent-id" = "grok"',
      "",
      "[[model.anyswitch-poke-api~gpt-6-astra.reasoning_efforts]]",
      'value = "high"',
      'label = "High Effort"',
      "",
    ].join("\n");
    const { text } = mergeGrokConfigToml(rewritten, extractManagedProviders(STORE), 47821, "tok");
    const modelHeaders = text.match(/^\[model\..*\]/gm) ?? [];
    assert.deepEqual(modelHeaders, ['[model."anyswitch-poke-api~gpt-6-astra"]']);
    assert.match(text, /api_key = "tok"/);
    assert.doesNotMatch(text, /old-tok/);
    // 新块的字段回到行内 inline-table 形态，没有独立的子表残留。
    assert.doesNotMatch(text, /\.extra_headers\]$/m);
    // 序列化器展开的 reasoning_efforts 数组子表同属残留，整段被剥掉。
    assert.doesNotMatch(text, /reasoning_efforts/);
    assert.doesNotMatch(text, /label = "High Effort"/);
  });

  it("writes no model entries for an empty channel set but keeps foreign sections", () => {
    const { text, managed, modelKeys } = mergeGrokConfigToml("[cli]\nx = 1\n", {}, 47821, "tok");
    assert.deepEqual(managed, []);
    assert.deepEqual(modelKeys, []);
    assert.doesNotMatch(text, /\[model\./);
    assert.match(text, /\[cli\]\nx = 1/);
  });

  it("auto routing channel: virtual model on the chain head, dropped on the re-sync after deletion", () => {
    const auto = deriveAutoRouteChannel(CHAIN_STORE, "grok");
    const { text, managed } = mergeGrokConfigToml("", extractManagedProviders(CHAIN_STORE), 47821, "tok", auto);
    assert.match(text, /\[model\."anyswitch-auto"\]/);
    const autoBlock = text.match(/\[model\."anyswitch-auto"\][^[]*/)[0];
    assert.match(autoBlock, /model = "auto"/);
    // grok 侧与 codex 的裸 slug "auto" 对应：目录键带 managed 前缀、显示名裸 auto。
    assert.match(autoBlock, /name = "auto"/);
    assert.match(autoBlock, /base_url = "http:\/\/127\.0\.0\.1:47821\/openai\/poke-api\/v1"/);
    assert.ok(managed.includes("auto"), "sidecar tracks the auto channel as managed");
    assert.equal(managedModelKey("auto", "auto"), AUTO_MODEL_KEY);

    const second = mergeGrokConfigToml(text, extractManagedProviders(STORE), 47821, "tok", deriveAutoRouteChannel(STORE, "grok"));
    assert.doesNotMatch(second.text, /anyswitch-auto/, "stale auto removed once the chain is gone");
    assert.match(second.text, /\[model\."anyswitch-poke-api~gpt-6-astra"\]/, "real channels survive the cleanup");
  });

  it("does not inject anyswitch-auto when the endpoint has no route chain", () => {
    const { text, managed } = mergeGrokConfigToml("", extractManagedProviders(STORE), 47821, "tok", deriveAutoRouteChannel(STORE, "grok"));
    assert.doesNotMatch(text, /anyswitch-auto/);
    assert.ok(!managed.includes("auto"));
  });
});

describe("grok catalog key packing", () => {
  it("keeps hyphen-ambiguous channel/model pairs on distinct keys, never emitting a duplicate table", () => {
    // 旧分隔符 "-" 下这两个组合撞成同一个键（渠道 a + 模型 b-c 与 渠道 a-b +
    // 模型 c）：两张同名 [model.*] 表会让 grok 整份配置拒绝加载、一个模型都选不到。
    const providers = {
      a: { displayName: "A", models: { "b-c": {} } },
      "a-b": { displayName: "A B", models: { c: {} } },
    };
    const { text, modelKeys, skipped } = buildGrokManagedToml(providers, 47821, "tok");
    assert.deepEqual(modelKeys, ["anyswitch-a~b-c", "anyswitch-a-b~c"]);
    assert.equal(new Set(modelKeys).size, modelKeys.length, "no key repeats");
    const headers = text.match(/^\[model\..*\]$/gm) ?? [];
    assert.deepEqual(headers, ['[model."anyswitch-a~b-c"]', '[model."anyswitch-a-b~c"]']);
    assert.deepEqual(skipped, []);
  });

  it("skips a repeated catalog key instead of emitting a second identically named table", () => {
    // auto 伪渠道的特例只看渠道 id：一个 id 就叫 auto 的渠道挂了多条模型时，
    // 每条都会落到 AUTO_MODEL_KEY 上，第二条必须跳过而不是写出同名表。
    const { text, managed, modelKeys, skipped } = buildGrokManagedToml(
      { auto: { models: { auto: {}, "m-2": {} } } },
      47821,
      "tok",
    );
    assert.deepEqual(modelKeys, [AUTO_MODEL_KEY]);
    assert.deepEqual(text.match(/^\[model\..*\]$/gm) ?? [], ['[model."' + AUTO_MODEL_KEY + '"]']);
    assert.deepEqual(managed, ["auto"], "the channel itself stays managed");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].key, AUTO_MODEL_KEY);
    assert.equal(skipped[0].modelId, "m-2");
    assert.match(skipped[0].reason, /duplicate catalog key/);
  });

  it("packs the key with codex's ~ separator so the first ~ is the only channel/model boundary", () => {
    const store = { version: 2, providers: { "poke-api": { models: { "openai/gpt-5.6-luna": {}, "m~x": {} } } } };
    const key = managedModelKey("poke-api", "openai/gpt-5.6-luna");
    // 与 codex 目录 slug 同一个打包函数：键就是 anyswitch- 前缀 + codex 的 slug。
    assert.equal(key, "anyswitch-" + packChannelModelSlug("poke-api", "openai/gpt-5.6-luna"));
    const slug = key.slice("anyswitch-".length);
    const [channelId, ...modelParts] = slug.split(CHANNEL_MODEL_SEPARATOR);
    assert.equal(channelId, "poke-api");
    assert.equal(modelParts.join(CHANNEL_MODEL_SEPARATOR), "openai/gpt-5.6-luna");
    // 同一边界交给 codex 的解析器验证：模型 id 自带 "/" 或 "~" 都不移动它。
    assert.deepEqual(unpackChannelModelSlug(slug, store), {
      channelId: "poke-api",
      modelId: "openai/gpt-5.6-luna",
      pool: false,
    });
    assert.equal(unpackChannelModelSlug(managedModelKey("poke-api", "m~x").slice("anyswitch-".length), store)?.modelId, "m~x");
    // auto 伪渠道仍是裸触发词键；真渠道里叫 auto 的模型仍带渠道限定。
    assert.equal(managedModelKey("auto", "auto"), AUTO_MODEL_KEY);
    assert.equal(managedModelKey("poke-api", "auto").includes(CHANNEL_MODEL_SEPARATOR), true);
  });
});

describe("grok legacy key cleanup", () => {
  it("replaces an old '-'-joined managed table with the new key, leaving no orphan", () => {
    const legacy = [
      MANAGED_BEGIN,
      '[model."anyswitch-poke-api-gpt-6-astra"]',
      'model = "gpt-6-astra"',
      'base_url = "http://127.0.0.1:47821/openai/poke-api/v1"',
      MANAGED_END,
      "",
    ].join("\n");
    const { text, modelKeys, skipped } = mergeGrokConfigToml(legacy, extractManagedProviders(STORE), 47821, "tok");
    assert.doesNotMatch(text, /anyswitch-poke-api-gpt-6-astra/, "no orphan table under the old key");
    assert.deepEqual(modelKeys, ["anyswitch-poke-api~gpt-6-astra"]);
    assert.deepEqual(text.match(/^\[model\..*\]$/gm) ?? [], ['[model."anyswitch-poke-api~gpt-6-astra"]']);
    assert.deepEqual(skipped, []);
  });

  it("strips a legacy-key table that a serializer rewrite left outside the markers", () => {
    const rewritten = [
      '[model."anyswitch-alpha-model-1"]',
      'model = "model-1"',
      'api_key = "old-tok"',
      "",
      "[cli]",
      "x = 1",
      "",
    ].join("\n");
    const { text } = mergeGrokConfigToml(rewritten, extractManagedProviders(STORE), 47821, "tok");
    assert.doesNotMatch(text, /anyswitch-alpha-model-1/);
    assert.doesNotMatch(text, /old-tok/);
    assert.match(text, /\[cli\]\nx = 1/, "foreign sections survive");
    assert.deepEqual(text.match(/^\[model\..*\]$/gm) ?? [], ['[model."anyswitch-poke-api~gpt-6-astra"]']);
  });

  it("re-points a [models] default that still names an old '-' key", () => {
    const { text } = mergeGrokConfigToml(
      '[models]\ndefault = "anyswitch-poke-api-gpt-6-astra" # 我选的\n',
      extractManagedProviders(STORE),
      47821,
      "tok",
    );
    assert.match(text, /^default = "anyswitch-poke-api~gpt-6-astra" # 我选的$/m);
  });
});

describe("[models] default protection", () => {
  it("re-points a stale managed default onto auto when a chain exists, keeping the comment", () => {
    const existing = '[models]\ndefault = "anyswitch-gone-model" # 我选的\n';
    const { text } = mergeGrokConfigToml(
      existing,
      extractManagedProviders(CHAIN_STORE),
      47821,
      "tok",
      deriveAutoRouteChannel(CHAIN_STORE, "grok"),
    );
    assert.match(text, /^default = "anyswitch-auto" # 我选的$/m);
    assert.doesNotMatch(text, /anyswitch-gone-model/);
  });

  it("re-points a stale managed default onto the first catalog entry when no chain exists", () => {
    const { text } = mergeGrokConfigToml('[models]\ndefault = "anyswitch-gone-model"\n', extractManagedProviders(STORE), 47821, "tok");
    assert.match(text, /^default = "anyswitch-poke-api~gpt-6-astra"$/m);
  });

  it("leaves a current managed default, a user's own model id, and an absent default alone", () => {
    const current = mergeGrokConfigToml('[models]\ndefault = "anyswitch-poke-api~gpt-6-astra"\n', extractManagedProviders(STORE), 47821, "tok");
    assert.match(current.text, /^default = "anyswitch-poke-api~gpt-6-astra"$/m);

    const builtin = mergeGrokConfigToml('[models]\ndefault = "grok-4.5"\nweb_search = "grok-4.5"\n', extractManagedProviders(STORE), 47821, "tok");
    assert.match(builtin.text, /^default = "grok-4.5"$/m);
    assert.match(builtin.text, /^web_search = "grok-4.5"$/m);

    const absent = mergeGrokConfigToml("[models]\nweb_search = \"grok-4.5\"\n", extractManagedProviders(STORE), 47821, "tok");
    assert.doesNotMatch(absent.text, /^default/m);
  });

  it("never touches a default-named key outside the [models] table", () => {
    const existing = '[cli]\ndefault = "anyswitch-gone-model"\n';
    const { text } = mergeGrokConfigToml(existing, extractManagedProviders(STORE), 47821, "tok");
    assert.match(text, /\[cli\]\ndefault = "anyswitch-gone-model"/);
  });

  it("is idempotent after re-pointing", () => {
    const existing = '[models]\ndefault = "anyswitch-gone-model"\n';
    const once = mergeGrokConfigToml(existing, extractManagedProviders(STORE), 47821, "tok");
    const twice = mergeGrokConfigToml(once.text, extractManagedProviders(STORE), 47821, "tok");
    assert.equal(twice.text, once.text);
  });
});

describe("writeGrokConfigTomlWithBackup", () => {
  it("writes atomically, backs up the previous file, and prunes to the newest 5 backups", () => {
    const dir = mkTestDir("grok-merge-test-");
    const filePath = join(dir, "config.toml");
    for (let i = 1; i <= 6; i++) {
      writeFileSync(join(dir, `config.backup.2020-01-0${i}T00-00-00-000Z.toml`), `old${i}`, "utf8");
    }
    writeFileSync(filePath, "# old", "utf8");
    const result = writeGrokConfigTomlWithBackup(filePath, "# new");
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);
    assert.ok(result.backupPath);
    assert.equal(readFileSync(filePath, "utf8"), "# new");
    const backups = readdirSync(dir).filter((n) => n.startsWith("config.backup.")).sort();
    assert.equal(backups.length, 5);
    assert.equal(backups[0], "config.backup.2020-01-03T00-00-00-000Z.toml", "oldest backups pruned");
    assert.ok(backups.includes(result.backupPath.split(/[\\/]/).pop()), "fresh backup kept");
  });

  it("reports unchanged without creating a backup", () => {
    const dir = mkTestDir("grok-merge-test-");
    const filePath = join(dir, "config.toml");
    writeGrokConfigTomlWithBackup(filePath, "# same");
    const before = readdirSync(dir);
    const result = writeGrokConfigTomlWithBackup(filePath, "# same");
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.equal(result.backupPath, undefined);
    assert.deepEqual(readdirSync(dir), before);
  });
});

describe("grok sidecar", () => {
  it("readSidecar returns empty list for missing file", () => {
    const dir = mkTestDir("grok-sidecar-");
    assert.deepEqual(readSidecar(dir), { providers: [] });
  });

  it("writeSidecar and readSidecar round-trip sorted in the shared format", () => {
    const dir = mkTestDir("grok-sidecar-");
    writeSidecar(dir, ["zeta", "alpha"]);
    assert.deepEqual(readSidecar(dir), { providers: ["alpha", "zeta"] });
    assert.equal(
      readFileSync(sidecarPath(dir), "utf8"),
      '{\n  "providers": [\n    "alpha",\n    "zeta"\n  ]\n}\n',
    );
  });
});

describe("writeGrokConfig", () => {
  it("writes config and sidecar, then reports unchanged on a second run", () => {
    const dir = mkTestDir("grok-write-");
    const configPath = join(dir, ".grok", "config.toml");
    const first = writeGrokConfig(STORE, 47821, "tok", dir, configPath);
    assert.equal(first.ok, true);
    assert.equal(first.unchanged, false);
    const text = readFileSync(configPath, "utf8");
    assert.match(text, /\[model\."anyswitch-poke-api~gpt-6-astra"\]/);
    assert.match(text, /api_key = "tok"/);
    assert.deepEqual(readSidecar(dir), { providers: ["poke-api"] });

    const second = writeGrokConfig(STORE, 47821, "tok", dir, configPath);
    assert.equal(second.ok, true);
    assert.equal(second.unchanged, true);
  });

  it("injects the auto channel when the grok chain exists", () => {
    const dir = mkTestDir("grok-write-");
    const configPath = join(dir, ".grok", "config.toml");
    const result = writeGrokConfig(CHAIN_STORE, 47821, "tok", dir, configPath);
    assert.equal(result.ok, true);
    const text = readFileSync(configPath, "utf8");
    assert.match(text, /\[model\."anyswitch-auto"\]/);
    assert.deepEqual(readSidecar(dir), { providers: ["auto", "poke-api"] });
  });

  it("returns a no-op reason when the store has no channels and nothing was managed before", () => {
    const dir = mkTestDir("grok-write-");
    const result = writeGrokConfig({ version: 2, providers: {} }, 47821, "tok", dir, join(dir, ".grok", "config.toml"));
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.equal(result.reason, "no Anyswitch providers with models");
    assert.equal(existsSync(join(dir, ".grok", "config.toml")), false);
  });

  it("still cleans up after the last channel is removed, using the sidecar", () => {
    const dir = mkTestDir("grok-write-");
    const configPath = join(dir, ".grok", "config.toml");
    writeGrokConfig(STORE, 47821, "tok", dir, configPath);
    const result = writeGrokConfig({ version: 2, providers: {} }, 47821, "tok", dir, configPath);
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /anyswitch-poke-api/);
    assert.deepEqual(readSidecar(dir), { providers: [] });
  });

  it("reports duplicate catalog keys that had to be skipped", () => {
    const dir = mkTestDir("grok-write-");
    const configPath = join(dir, ".grok", "config.toml");
    // 渠道 id 就叫 auto 且挂了多条模型时，第二条会撞上 auto 触发词键。
    const store = { version: 2, providers: { auto: { displayName: "Auto", models: { auto: {}, "m-2": {} } } } };
    const result = writeGrokConfig(store, 47821, "tok", dir, configPath);
    assert.equal(result.ok, true);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /duplicate catalog key/);
    const text = readFileSync(configPath, "utf8");
    assert.equal((text.match(/^\[model\..*\]$/gm) ?? []).length, 1, "one table, never two with the same name");
  });

  it("fails closed on a truncated managed block and leaves the file untouched", () => {
    const dir = mkTestDir("grok-write-");
    const configPath = join(dir, ".grok", "config.toml");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${MANAGED_BEGIN}\n[model."anyswitch-x"]\n`, "utf8");
    const before = readFileSync(configPath, "utf8");
    const result = writeGrokConfig(STORE, 47821, "tok", dir, configPath);
    assert.equal(result.ok, false);
    assert.equal(result.unchanged, true);
    assert.match(result.reason, /truncated/);
    assert.equal(readFileSync(configPath, "utf8"), before);
    assert.equal(existsSync(sidecarPath(dir)), false, "no sidecar written for a refused merge");
  });

  it("grokConfigPath resolves under USERPROFILE", () => {
    assert.equal(grokConfigPath({ USERPROFILE: "/home/u" }), join("/home/u", ".grok", "config.toml"));
  });
});

describe("grok reasoning_efforts injection", () => {
  it("writes one array-of-tables entry per library level, deepest first, default flagged", () => {
    const library = {
      models: new Map([
        ["grok-4-6", { levels: ["low", "high", "xhigh", "max"], default: "high", wire: {}, thinkingFormat: null, kind: "reasoning" }],
      ]),
    };
    const providers = { "S3AI-Grok": { displayName: "S3AI Grok", models: { "grok-4.6": {} } } };
    const { text } = buildGrokManagedToml(providers, 47821, "tok", { catalog: library });
    const headers = text.match(/^\[\[model\."anyswitch-S3AI-Grok~grok-4\.6"\.reasoning_efforts\]\]$/gm) ?? [];
    assert.equal(headers.length, 4);
    const values = [...text.matchAll(/^\s*value = "([a-z]+)"$/gm)].map((m) => m[1]);
    assert.deepEqual(values, ["max", "xhigh", "high", "low"], "deepest level offered first");
    assert.equal((text.match(/^default = true$/gm) ?? []).length, 1, "exactly one default marker");
    assert.match(
      text,
      /value = "high"\nlabel = "High Effort"\ndescription = [^\n]+\ndefault = true/,
      "the library default carries the flag",
    );
  });

  it("clips store-declared levels to grok's vocabulary and renames the default", () => {
    const providers = { alpha: { models: { "m-1": { reasoningEffortLevels: ["ultra", "low"] } } } };
    const { text } = buildGrokManagedToml(providers, 47821, "tok", { catalog: { models: new Map() } });
    assert.match(text, /value = "low"/);
    assert.doesNotMatch(text, /ultra/, "levels outside grok's vocabulary are clipped");
    assert.match(text, /value = "low"\nlabel = "Low Effort"\ndescription = [^\n]+\ndefault = true/);
  });

  it("resolves the store contextWindow before any fallback tier", () => {
    const providers = { alpha: { models: { "gpt-5-thing": { contextWindow: 640000 } } } };
    const { text } = buildGrokManagedToml(providers, 47821, "tok");
    assert.match(text, /context_window = 640000/);
    assert.doesNotMatch(text, /context_window = 272000/);
  });

  it("writeGrokConfig: no settings file → injection on, optimistic levels written", () => {
    const dir = mkTestDir("grok-effort-");
    const configPath = join(dir, ".grok", "config.toml");
    const result = writeGrokConfig(STORE, 47821, "tok", dir, configPath);
    assert.equal(result.ok, true);
    const text = readFileSync(configPath, "utf8");
    const headers = text.match(/^\[\[model\."anyswitch-poke-api~gpt-6-astra"\.reasoning_efforts\]\]$/gm) ?? [];
    assert.deepEqual(
      [...text.matchAll(/^\s*value = "([a-z]+)"$/gm)].map((m) => m[1]),
      ["max", "xhigh", "high"],
      "library-missing optimistic default set",
    );
    assert.equal(headers.length, 3);
    assert.match(text, /value = "high"\nlabel = "High Effort"\ndescription = [^\n]+\ndefault = true/);
  });

  it("writeGrokConfig: injection switch off → the block omits every reasoning_efforts entry", () => {
    const dir = mkTestDir("grok-effort-");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ injectThinkingEffort: false }));
    const configPath = join(dir, ".grok", "config.toml");
    const result = writeGrokConfig(STORE, 47821, "tok", dir, configPath);
    assert.equal(result.ok, true);
    const text = readFileSync(configPath, "utf8");
    assert.doesNotMatch(text, /reasoning_efforts/);
    assert.match(text, /context_window = 256000/, "context resolution is independent of the switch");
  });
});
