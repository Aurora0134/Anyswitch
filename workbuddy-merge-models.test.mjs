// WorkBuddy models.json 写入器测试：全部跑在临时目录，绝不触碰真实
// ~/.workbuddy。覆盖对象/数组/坏 JSON 三态、托管项认领剔除、用户条目与未知
// 顶层键保留、availableModels 的「仅既有键维护」、slug/伪渠道 id 与 url 拼接。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildWorkbuddyModels,
  buildWorkbuddyModelEntry,
  mergeWorkbuddyModels,
  writeWorkbuddyModels,
  readWorkbuddyModels,
  selectManagedModels,
  workbuddyModelsPath,
  workbuddyModelId,
  sidecarPath,
  readSidecar,
  extractManagedProviders,
  deriveAnyswitchChannel,
  isManagedModel,
  UnparseableWorkbuddyModelsError,
} from "./workbuddy-merge-models.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

const PORT = 47821;
const TOKEN = "relay-token";

const STORE = {
  version: 2,
  providers: {
    "poke-api": {
      displayName: "Poke API",
      baseURL: "https://poke.example/v1",
      protocol: "openai-compatible",
      models: {
        "gpt-6-astra": {
          displayName: "GPT 6 Astra",
          contextWindow: 256000,
          modalities: { input: ["text", "image"], output: ["text"] },
          reasoningEffortLevels: ["low", "high"],
        },
        plain: {},
      },
    },
  },
};

const CHAIN_STORE = {
  ...STORE,
  routingChains: { workbuddy: { chain: [{ node: "poke-api", model: "gpt-6-astra" }] } },
  virtualModels: [{ name: "vm-a", chain: [{ node: "poke-api", model: "gpt-6-astra" }] }],
};

function managedUrl(segment = "poke-api", port = PORT) {
  return `http://127.0.0.1:${port}/openai/workbuddy~${segment}/v1/chat/completions`;
}

describe("workbuddy-merge-models", () => {
  it("builds the fixed entry template against the object shape", () => {
    const existing = JSON.stringify({
      models: [{ id: "user-1", name: "Mine", url: "https://mine.example/v1/chat/completions" }],
      theme: "dark",
    });
    const { config, managed, modelIds } = buildWorkbuddyModels(
      existing,
      extractManagedProviders(STORE),
      PORT,
      TOKEN,
    );
    assert.deepEqual(managed, ["poke-api"]);
    assert.deepEqual(modelIds, ["poke-api~gpt-6-astra", "poke-api~plain"]);
    // 用户条目在前、未知顶层键原样保留。
    assert.equal(config.models[0].id, "user-1");
    assert.equal(config.theme, "dark");
    assert.deepEqual(config.models[1], {
      id: "poke-api~gpt-6-astra",
      name: "GPT 6 Astra · Poke API",
      vendor: "Anyswitch",
      url: managedUrl(),
      apiKey: TOKEN,
      useCustomProtocol: true,
      supportsToolCall: true,
      supportsImages: true,
      supportsReasoning: true,
      maxInputTokens: 256000,
    });
    // 无 contextWindow 的条目走共享 tier 兜底，modalities/reasoning 缺失即 false。
    const plain = config.models[2];
    assert.equal(plain.id, "poke-api~plain");
    assert.equal(plain.name, "plain · Poke API");
    assert.equal(plain.supportsImages, false);
    assert.equal(plain.supportsReasoning, false);
    assert.ok(Number.isInteger(plain.maxInputTokens) && plain.maxInputTokens > 0);
    assert.equal(plain.useCustomProtocol, true);
    assert.equal(plain.vendor, "Anyswitch");
  });

  it("normalizes a top-level array into the object shape on write", () => {
    const { config } = buildWorkbuddyModels(
      JSON.stringify([{ id: "user-1", url: "https://mine.example/v1" }]),
      extractManagedProviders(STORE),
      PORT,
      TOKEN,
    );
    assert.equal(Array.isArray(config), false);
    assert.equal(config.models[0].id, "user-1");
    assert.equal(config.models.length, 3);
  });

  it("treats null and an empty string as an empty model list", () => {
    const fromNull = buildWorkbuddyModels(null, {}, PORT, TOKEN);
    assert.deepEqual(fromNull.config, { models: [] });
    const fromEmpty = buildWorkbuddyModels("", {}, PORT, TOKEN);
    assert.deepEqual(fromEmpty.config, { models: [] });
  });

  it("fails closed on bad JSON instead of overwriting", () => {
    assert.throws(() => buildWorkbuddyModels("{not json", {}, PORT, TOKEN), (error) => {
      assert.ok(error instanceof UnparseableWorkbuddyModelsError);
      assert.equal(error.code, "UNPARSEABLE_WORKBUDDY_MODELS");
      return true;
    });
    // 顶层标量同样不可解析。
    assert.throws(() => parseScalar("\"hello\""), /unparseable/);
  });

  function parseScalar(text) {
    return buildWorkbuddyModels(text, {}, PORT, TOKEN);
  }

  it("claims and rebuilds relay-signed entries while user entries survive", () => {
    const existing = JSON.stringify({
      models: [
        { id: "user-1", url: "https://mine.example/v1/chat/completions" },
        { id: "stale~old", url: managedUrl("stale", 9999) },
        // 指向回环但段不是 workbuddy~ 的条目不是我们的，必须留下。
        { id: "other", url: "http://127.0.0.1:47821/openai/grok~x/v1/chat/completions" },
      ],
    });
    const { config } = buildWorkbuddyModels(existing, extractManagedProviders(STORE), PORT, TOKEN);
    const ids = config.models.map((entry) => entry.id);
    assert.deepEqual(ids, ["user-1", "other", "poke-api~gpt-6-astra", "poke-api~plain"]);
    assert.ok(!ids.includes("stale~old"));
    assert.equal(isManagedModel({ url: managedUrl("x", 1234) }), true);
    assert.equal(isManagedModel({ url: "http://127.0.0.1:1234/openai/workbuddyx~x/v1" }), false);
  });

  it("maintains availableModels only when the existing object already has it", () => {
    const withKey = buildWorkbuddyModels(
      JSON.stringify({ models: [], availableModels: ["user-1", "poke-api~gpt-6-astra"] }),
      extractManagedProviders(STORE),
      PORT,
      TOKEN,
    );
    assert.deepEqual(withKey.config.availableModels, [
      "user-1",
      "poke-api~gpt-6-astra",
      "poke-api~plain",
    ]);
    const withoutKey = buildWorkbuddyModels(
      JSON.stringify({ models: [] }),
      extractManagedProviders(STORE),
      PORT,
      TOKEN,
    );
    assert.equal("availableModels" in withoutKey.config, false, "缺键不创建：创建会藏起用户模型");
    // 托管项被剔除时，它的 id 也从 availableModels 回收。
    const reclaim = buildWorkbuddyModels(
      JSON.stringify({
        models: [{ id: "stale~old", url: managedUrl("stale") }],
        availableModels: ["stale~old", "user-1"],
      }),
      {},
      PORT,
      TOKEN,
    );
    assert.deepEqual(reclaim.config.availableModels, ["user-1"]);
  });

  it("uses packed slugs for real channels and bare names for the Anyswitch pseudo-channel", () => {
    const { config, managed } = buildWorkbuddyModels(
      null,
      extractManagedProviders(CHAIN_STORE),
      PORT,
      TOKEN,
      deriveAnyswitchChannel(CHAIN_STORE, "workbuddy"),
    );
    const byId = new Map(config.models.map((entry) => [entry.id, entry]));
    assert.deepEqual(managed, ["poke-api", "auto"]);
    assert.ok(byId.has("poke-api~gpt-6-astra"));
    assert.ok(byId.has("auto"), "auto 是链路由触发词，id 必须是裸名");
    assert.ok(byId.has("vm-a"), "虚拟模型 id 必须是裸名");
    assert.equal(byId.get("auto").name, "auto · Anyswitch");
    assert.equal(byId.get("vm-a").name, "vm-a · Anyswitch");
    assert.equal(workbuddyModelId("auto", "vm-a"), "vm-a");
    assert.equal(workbuddyModelId("chan", "m"), "chan~m");
  });

  it("builds the full chat/completions URL with the agent-prefixed segment", () => {
    const entry = buildWorkbuddyModelEntry(
      "poke-api",
      { models: {} },
      "gpt-6-astra",
      {},
      47821,
      "tok",
    );
    assert.equal(entry.url, "http://127.0.0.1:47821/openai/workbuddy~poke-api/v1/chat/completions");
    const auto = buildWorkbuddyModelEntry(
      "auto",
      { baseUrlSegment: "head-node", models: {} },
      "auto",
      {},
      47821,
      "tok",
    );
    assert.equal(auto.url, "http://127.0.0.1:47821/openai/workbuddy~head-node/v1/chat/completions");
  });

  it("respects WORKBUDDY_CONFIG_DIR when resolving the models path", () => {
    assert.equal(
      workbuddyModelsPath({ USERPROFILE: "C:\\Users\\me" }),
      join("C:\\Users\\me", ".workbuddy", "models.json"),
    );
    assert.equal(
      workbuddyModelsPath({ WORKBUDDY_CONFIG_DIR: "D:\\wb-home" }),
      join("D:\\wb-home", "models.json"),
    );
  });

  it("writes atomically with a backup, sidecar, and reports unchanged on re-sync", () => {
    const root = mkTestDir("workbuddy-merge-write-");
    const filePath = join(root, ".workbuddy", "models.json");
    const sidecarRoot = join(root, "Anyswitch");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ models: [{ id: "user-1", url: "https://mine.example/v1" }], ui: { theme: "dark" } }) + "\n");

    const first = writeWorkbuddyModels(STORE, PORT, TOKEN, sidecarRoot, filePath);
    assert.equal(first.ok, true);
    assert.equal(first.unchanged, false);
    assert.ok(first.backupPath && existsSync(first.backupPath));
    const written = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(written.ui.theme, "dark");
    assert.deepEqual(written.models.map((entry) => entry.id), [
      "user-1",
      "poke-api~gpt-6-astra",
      "poke-api~plain",
    ]);
    assert.deepEqual(readSidecar(sidecarRoot).providers, ["poke-api"]);
    assert.equal(readdirSync(dirname(filePath)).filter((name) => name.startsWith("models.backup.")).length, 1);

    const second = writeWorkbuddyModels(STORE, PORT, TOKEN, sidecarRoot, filePath);
    assert.equal(second.ok, true);
    assert.equal(second.unchanged, true);
    // 备份保留 5 份上限。
    for (let i = 0; i < 8; i += 1) {
      writeFileSync(filePath, JSON.stringify({ models: [{ id: `u-${i}`, url: "https://mine.example/v1" }] }) + "\n");
      assert.equal(writeWorkbuddyModels(STORE, PORT, TOKEN, sidecarRoot, filePath).ok, true);
    }
    assert.ok(readdirSync(dirname(filePath)).filter((name) => name.startsWith("models.backup.")).length <= 5);
  });

  it("refuses to overwrite an unparseable models.json", () => {
    const root = mkTestDir("workbuddy-merge-bad-");
    const filePath = join(root, "models.json");
    writeFileSync(filePath, "{broken");
    const result = writeWorkbuddyModels(STORE, PORT, TOKEN, join(root, "Anyswitch"), filePath);
    assert.equal(result.ok, false);
    assert.equal(result.unchanged, true);
    assert.match(result.reason, /unparseable/);
    assert.equal(readFileSync(filePath, "utf8"), "{broken");
  });

  it("reports unchanged when there are no channels and no pseudo-channel and an empty sidecar", () => {
    const root = mkTestDir("workbuddy-merge-empty-");
    const result = writeWorkbuddyModels({}, PORT, TOKEN, join(root, "Anyswitch"), join(root, "models.json"));
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.equal(existsSync(join(root, "models.json")), false);
  });

  it("selectManagedModels removes only relay-signed entries and keeps the rest", () => {
    const config = {
      models: [
        { id: "keep", url: "https://mine.example/v1" },
        { id: "drop", url: managedUrl("chan") },
      ],
      availableModels: ["keep", "drop"],
      extra: 1,
    };
    assert.deepEqual(selectManagedModels(config), ["drop"]);
    assert.deepEqual(config.models.map((entry) => entry.id), ["keep"]);
    assert.deepEqual(config.availableModels, ["keep"]);
    assert.equal(config.extra, 1);
  });

  it("readWorkbuddyModels fakes a missing file as an empty object but rejects bad JSON", () => {
    const root = mkTestDir("workbuddy-merge-read-");
    assert.deepEqual(readWorkbuddyModels(join(root, "missing.json")), { models: [] });
    const bad = join(root, "bad.json");
    writeFileSync(bad, "[");
    assert.throws(() => readWorkbuddyModels(bad), (error) => error.code === "UNPARSEABLE_WORKBUDDY_MODELS");
    assert.equal(sidecarPath(root), join(root, "workbuddy-sidecar.json"));
  });
});
