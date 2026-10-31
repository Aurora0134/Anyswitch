// WorkBuddy models.json 写入器测试：全部跑在临时目录，绝不触碰真实
// ~/.workbuddy。覆盖对象/数组/坏 JSON 三态、托管项认领剔除、用户条目与未知
// 顶层键保留、availableModels 的「仅既有键维护」、slug/伪渠道 id 与 url 拼接，
// 以及并发抢写（GUI 把文件归一成数组）、CAS 冲突与写失败三条路径。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  buildWorkbuddyModels,
  buildWorkbuddyModelEntry,
  mergeWorkbuddyModels,
  writeWorkbuddyModels,
  writeWorkbuddyModelsWithBackup,
  readWorkbuddyModels,
  selectManagedModels,
  workbuddyConfigRoot,
  workbuddyModelsPath,
  workbuddyModelsIo,
  workbuddyModelId,
  sidecarPath,
  readSidecar,
  writeSidecar,
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
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
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
    // 无 contextWindow 的条目走共享 tier 兜底；modalities 未声明时图像能力按
    // modalitiesFromStoreModel 的兜底方向走（未声明的聊天模型默认允许图像输入），
    // reasoning 缺失即 false。
    const plain = config.models[2];
    assert.equal(plain.id, "poke-api~plain");
    assert.equal(plain.name, "plain · Poke API");
    assert.equal(plain.supportsImages, true);
    assert.equal(plain.supportsReasoning, false);
    assert.ok(Number.isInteger(plain.maxInputTokens) && plain.maxInputTokens > 0);
    assert.equal(plain.useCustomProtocol, true);
    assert.equal(plain.vendor, "Anyswitch");
  });

  it("reads image support from the store's real inputModalities field", () => {
    const textOnly = buildWorkbuddyModelEntry(
      "poke-api",
      { models: {} },
      "gpt-6-text",
      { inputModalities: ["text"], outputModalities: ["text"] },
      PORT,
      TOKEN,
    );
    assert.equal(textOnly.supportsImages, false, "只声明 text 就不该报图像能力");
    const imageIn = buildWorkbuddyModelEntry(
      "poke-api",
      { models: {} },
      "gpt-6-astra",
      { inputModalities: ["text", "image"], outputModalities: ["text"] },
      PORT,
      TOKEN,
    );
    assert.equal(imageIn.supportsImages, true);
    // 未声明 → 共享 fallback 兜底（聊天模型默认允许图像输入）。
    const undeclared = buildWorkbuddyModelEntry("poke-api", { models: {} }, "gpt-6-astra", {}, PORT, TOKEN);
    assert.equal(undeclared.supportsImages, true);
    // 明确的非聊天族（embedding）兜底为纯文本。
    const embedding = buildWorkbuddyModelEntry("poke-api", { models: {} }, "text-embedding-3", {}, PORT, TOKEN);
    assert.equal(embedding.supportsImages, false);
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

  it("resolves the config root from the two env vars, then the home directory", () => {
    // 产品自己读模型配置的顺序：WORKBUDDY_CONFIG_DIR 优先，其次 CODEBUDDY_CONFIG_DIR。
    assert.equal(workbuddyConfigRoot({ WORKBUDDY_CONFIG_DIR: " D:\\wb-home " }, "/home/me"), "D:\\wb-home");
    assert.equal(
      workbuddyConfigRoot({ WORKBUDDY_CONFIG_DIR: "D:\\wb-home", CODEBUDDY_CONFIG_DIR: "E:\\codebuddy" }, "/home/me"),
      "D:\\wb-home",
    );
    assert.equal(workbuddyConfigRoot({ CODEBUDDY_CONFIG_DIR: "E:\\codebuddy" }, "/home/me"), "E:\\codebuddy");
    // 都没有（或只有空白）→ 回落 home。
    assert.equal(workbuddyConfigRoot({}, "/home/me"), join("/home/me", ".workbuddy"));
    assert.equal(
      workbuddyConfigRoot({ WORKBUDDY_CONFIG_DIR: "   ", CODEBUDDY_CONFIG_DIR: "" }, "/home/me"),
      join("/home/me", ".workbuddy"),
    );
    assert.equal(workbuddyModelsPath({}, "/home/me"), join("/home/me", ".workbuddy", "models.json"));
    assert.equal(
      workbuddyModelsPath({ WORKBUDDY_CONFIG_DIR: "D:\\wb-home" }),
      join("D:\\wb-home", "models.json"),
    );
    // 默认 home 是进程真实主目录（不是注入 base 里的 USERPROFILE）。
    assert.equal(workbuddyModelsPath({}), join(homedir(), ".workbuddy", "models.json"));
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

  it("refuses to overwrite a models key that is not an array", () => {
    const root = mkTestDir("workbuddy-merge-shape-");
    const filePath = join(root, "models.json");
    const original = '{"models":{}}\n';
    writeFileSync(filePath, original);
    assert.throws(() => buildWorkbuddyModels(original, {}, PORT, TOKEN), (error) => {
      assert.ok(error instanceof UnparseableWorkbuddyModelsError);
      return true;
    });
    const result = writeWorkbuddyModels(STORE, PORT, TOKEN, join(root, "Anyswitch"), filePath);
    assert.equal(result.ok, false);
    assert.equal(result.unchanged, true);
    assert.match(result.reason, /unparseable/);
    assert.equal(readFileSync(filePath, "utf8"), original, "原文件必须逐字节不变");
  });

  it("reports unchanged when there are no channels and no pseudo-channel and an empty sidecar", () => {
    const root = mkTestDir("workbuddy-merge-empty-");
    const result = writeWorkbuddyModels({}, PORT, TOKEN, join(root, "Anyswitch"), join(root, "models.json"));
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.equal(existsSync(join(root, "models.json")), false);
  });

  it("does not revive a deleted config directory from a stale sidecar", () => {
    const root = mkTestDir("workbuddy-merge-gone-");
    const sidecarRoot = join(root, "Anyswitch");
    const configRoot = join(root, ".workbuddy");
    const filePath = join(configRoot, "models.json");
    writeSidecar(sidecarRoot, ["gone-channel"]);

    const result = writeWorkbuddyModels({}, PORT, TOKEN, sidecarRoot, filePath);
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.equal(existsSync(configRoot), false, "用户删掉的配置目录不许被 sidecar 复活");
    assert.equal(existsSync(filePath), false);
    assert.deepEqual(readSidecar(sidecarRoot).providers, [], "残留 sidecar 一并清空");
  });

  it("rewrites once when the GUI normalizes the file right after our write", () => {
    const root = mkTestDir("workbuddy-merge-clobber-");
    const filePath = join(root, "models.json");
    let writes = 0;
    const io = {
      ...workbuddyModelsIo,
      atomicWriteFile: (target, content) => {
        writes += 1;
        workbuddyModelsIo.atomicWriteFile(target, content);
        if (writes === 1) writeFileSync(target, "[]\n"); // GUI 保存把文件归一成数组
      },
    };

    const result = writeWorkbuddyModelsWithBackup(filePath, { models: [{ id: "ours" }] }, { io });
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);
    assert.equal(writes, 2, "回读发现不是对象 → 重写一次");
    assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")).models, [{ id: "ours" }]);
  });

  it("reports failure when the file is clobbered after every write", () => {
    const root = mkTestDir("workbuddy-merge-clobber2-");
    const filePath = join(root, "models.json");
    let writes = 0;
    const io = {
      ...workbuddyModelsIo,
      atomicWriteFile: (target, content) => {
        writes += 1;
        workbuddyModelsIo.atomicWriteFile(target, content);
        writeFileSync(target, "[]\n");
      },
    };

    const result = writeWorkbuddyModelsWithBackup(filePath, { models: [{ id: "ours" }] }, { io });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "models.json was rewritten concurrently");
    assert.equal(writes, 2, "只重写一次，不无限循环");
    assert.equal(readFileSync(filePath, "utf8"), "[]\n", "末态是抢写方的内容，不是半截");
    assert.deepEqual(
      readdirSync(root).filter((name) => name.endsWith(".tmp")),
      [],
      "不留临时文件",
    );
  });

  it("re-reads and re-merges once when another writer wins the CAS", () => {
    const root = mkTestDir("workbuddy-merge-cas-");
    const filePath = join(root, "models.json");
    const sidecarRoot = join(root, "Anyswitch");
    const original = JSON.stringify({ models: [{ id: "user-1", url: "https://mine.example/v1" }] }) + "\n";
    writeFileSync(filePath, original);

    let casCalls = 0;
    const io = {
      ...workbuddyModelsIo,
      casWriteFile: (target, content, options) => {
        casCalls += 1;
        // 第一次写前，另一个写者插进一条用户模型 → 读入快照的 hash 失效。
        if (casCalls === 1) {
          const current = JSON.parse(readFileSync(target, "utf8"));
          current.models.push({ id: "racer-1", url: "https://racer.example/v1" });
          writeFileSync(target, JSON.stringify(current, null, 2) + "\n");
        }
        return workbuddyModelsIo.casWriteFile(target, content, options);
      },
    };

    const result = writeWorkbuddyModels(STORE, PORT, TOKEN, sidecarRoot, filePath, io);
    assert.equal(result.ok, true);
    assert.equal(casCalls, 2, "冲突后重读重合并，只重试一次");
    const ids = JSON.parse(readFileSync(filePath, "utf8")).models.map((entry) => entry.id);
    assert.ok(ids.includes("racer-1"), "并发写进来的用户条目不能被旧快照盖掉");
    assert.ok(ids.includes("user-1"));
    assert.ok(ids.includes("poke-api~gpt-6-astra"));
  });

  it("fails closed when the CAS keeps losing", () => {
    const root = mkTestDir("workbuddy-merge-cas2-");
    const filePath = join(root, "models.json");
    const sidecarRoot = join(root, "Anyswitch");
    writeFileSync(filePath, JSON.stringify({ models: [{ id: "user-1", url: "https://mine.example/v1" }] }) + "\n");

    let casCalls = 0;
    const io = {
      ...workbuddyModelsIo,
      casWriteFile: (target, content, options) => {
        casCalls += 1;
        const current = JSON.parse(readFileSync(target, "utf8"));
        current.models.push({ id: `racer-${casCalls}`, url: "https://racer.example/v1" });
        writeFileSync(target, JSON.stringify(current, null, 2) + "\n");
        return workbuddyModelsIo.casWriteFile(target, content, options);
      },
    };

    const result = writeWorkbuddyModels(STORE, PORT, TOKEN, sidecarRoot, filePath, io);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "models.json changed concurrently");
    assert.equal(casCalls, 2);
    const ids = JSON.parse(readFileSync(filePath, "utf8")).models.map((entry) => entry.id);
    assert.deepEqual(ids, ["user-1", "racer-1", "racer-2"], "没写进去就不留托管残渣");
    assert.equal(existsSync(sidecarPath(sidecarRoot)), false, "失败不更新 sidecar");
  });

  it("reports failure and keeps the file intact when the target is read-only", () => {
    const root = mkTestDir("workbuddy-merge-readonly-");
    const filePath = join(root, "models.json");
    const original = JSON.stringify({ models: [{ id: "user-1", url: "https://mine.example/v1" }] }) + "\n";
    writeFileSync(filePath, original);
    chmodSync(filePath, 0o444);
    try {
      const result = writeWorkbuddyModels(STORE, PORT, TOKEN, join(root, "Anyswitch"), filePath);
      assert.equal(result.ok, false);
      assert.equal(result.unchanged, true, "没写进去就不能报改动过");
      assert.ok(result.reason);
      assert.equal(readFileSync(filePath, "utf8"), original, "原文件逐字节不变");
      assert.equal(existsSync(sidecarPath(join(root, "Anyswitch"))), false);
    } finally {
      chmodSync(filePath, 0o666);
    }
  });

  it("reports failure when the models path is a directory and touches no sibling", () => {
    const root = mkTestDir("workbuddy-merge-dirtarget-");
    const filePath = join(root, "models.json");
    mkdirSync(filePath);
    const sibling = join(root, "sibling.json");
    writeFileSync(sibling, "keep-me");

    const result = writeWorkbuddyModels(STORE, PORT, TOKEN, join(root, "Anyswitch"), filePath);
    assert.equal(result.ok, false);
    assert.ok(result.reason);
    assert.equal(existsSync(filePath), true);
    assert.equal(readdirSync(filePath).length, 0, "目标目录内容原样");
    assert.equal(readFileSync(sibling, "utf8"), "keep-me", "兄弟文件不许被删");
    assert.deepEqual(
      readdirSync(root).filter((name) => name.startsWith("models.backup.")),
      [],
    );
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
