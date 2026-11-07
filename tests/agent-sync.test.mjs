import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  syncAllAgentConfigs,
  createStoreWatcher,
  buildSyncSummary,
  formatSyncSummaryLine,
  parseSyncSummaryLine,
  codexCatalogLogMessage,
  AGENT_ENDPOINTS,
  SYNC_RESULT_PREFIX,
} from "../src/agents/agent-sync.mjs";
import { atomicWriteFile } from "../src/store/atomic-write.mjs";
import { managedConnectionId } from "../src/launchers/qoder-merge-config.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

// 九端点「已安装」的盘上形状，落点取自 agent-discovery 各解析器的候选路径
// （每端点一份主形态）。同步闸门上线后，happy-path 断言「配置被写入」的用例
// 都要先让端点在盘上「在装」，否则整轮被跳过。opencode 的解析器不认 npm 垫片
// （Anyswitch 接管 shim 会绕回启动器），须摆真实包布局。
function installAgentShapes(home) {
  const mark = (path) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "stub");
  };
  const npm = join(home.APPDATA, "npm");
  mark(join(home.LOCALAPPDATA, "Programs", "zcode", "ZCode.exe"));
  mark(join(npm, "dsh.cmd"));
  mark(join(npm, "pi.cmd"));
  mark(join(npm, "kimi.cmd"));
  mark(join(home.USERPROFILE, ".qoder", "bin", "qodercli", "qodercli.exe"));
  mark(join(npm, "codex.cmd"));
  const ocPkg = join(npm, "node_modules", "@opencode", "cli");
  mkdirSync(ocPkg, { recursive: true });
  writeFileSync(join(ocPkg, "package.json"), JSON.stringify({
    name: "@opencode/cli",
    bin: { opencode: "bin/opencode.js" },
    optionalDependencies: { "@opencode/cli-windows-x64": "1.0.0" },
  }));
  mark(join(ocPkg, "node_modules", "@opencode", "cli-windows-x64", "bin", "opencode.js"));
  mark(join(home.USERPROFILE, ".grok", "bin", "grok.exe"));
  mark(join(home.LOCALAPPDATA, "Programs", "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy"));
}

describe("agent-sync", () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkTestDir("agent-sync-test-");
    installAgentShapes({ USERPROFILE: tmpRoot, LOCALAPPDATA: tmpRoot, APPDATA: tmpRoot });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("syncAllAgentConfigs syncs valid store across supported agent paths", async () => {
    const store = {
      version: 2,
      providers: {
        alpha: {
          displayName: "Alpha",
          baseURL: "https://alpha.invalid/v1",
          protocol: "openai-compatible",
          credentialFile: "alpha.dpapi",
          models: {
            "model-1": { contextWindow: 4096 },
          },
        },
      },
    };

    const dummyLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
    };

    const res = await syncAllAgentConfigs({
      store,
      port: 47821,
      token: "test-token",
      root: tmpRoot,
      logger: dummyLogger,
      base: { USERPROFILE: tmpRoot, LOCALAPPDATA: tmpRoot, APPDATA: tmpRoot },
    });

    assert.equal(res.ok, true);
    assert.ok(res.results.zcode);
    assert.ok(res.results.dsh);
    assert.ok(res.results.pi);
    assert.ok(res.results.kimi);
    assert.ok(res.results.qoder);
    assert.ok(res.results.codex);

    const { existsSync, readFileSync } = await import("node:fs");
    const codexPath = join(tmpRoot, ".codex", "config.toml");
    assert.equal(existsSync(codexPath), true, "codex config.toml must land under the injected USERPROFILE");
    const codexText = readFileSync(codexPath, "utf8");
    assert.match(codexText, /\[model_providers\."anyswitch-alpha"\]/);
    assert.match(codexText, /wire_api = "responses"/);
    assert.match(codexText, /http_headers = \{ "Authorization" = "Bearer test-token", "x-agent-id" = "codex" \}/);

    const kimiPath = join(tmpRoot, ".kimi-code", "config.toml");
    assert.equal(existsSync(kimiPath), true, "kimi config.toml must land under the injected USERPROFILE");
    const kimiText = readFileSync(kimiPath, "utf8");
    assert.match(kimiText, /\[providers\."_alpha"\]/);
    assert.match(kimiText, /api_key = "test-token"/);
    assert.match(kimiText, /\[models\."_alpha\/model-1"\]/);

    const zcodePath = join(tmpRoot, ".zcode", "v2", "config.json");
    assert.equal(existsSync(zcodePath), true, "zcode config must land under the injected USERPROFILE");
    const zcode = JSON.parse(readFileSync(zcodePath, "utf8"));
    assert.ok(zcode.provider?._alpha, "alpha provider must be written into the sandbox zcode config");
    assert.equal(zcode.provider._alpha.options.apiKey, "test-token");

    const qoderPath = join(tmpRoot, ".qoder", "settings.json");
    assert.equal(existsSync(qoderPath), true, "qoder settings.json must land under the injected USERPROFILE");
    const qoder = JSON.parse(readFileSync(qoderPath, "utf8"));
    const alphaConn = qoder.providers?.[managedConnectionId("alpha")];
    assert.ok(alphaConn, "alpha provider must be written into the sandbox qoder settings");
    assert.equal(alphaConn.apiKey, "test-token");
    assert.equal(alphaConn.model, "model-1");
    // Qoder 段带 `qoder~` 身份前缀：它发不出 x-agent-id、UA 无自家标识，relay 只能
    // 从 URL 认端点（其余端点靠各自的头，段仍是裸渠道 id）。
    assert.equal(alphaConn.baseUrl, "http://127.0.0.1:47821/openai/qoder~alpha/v1");

    assert.ok(res.results.opencode);
    const opencodePath = join(tmpRoot, ".config", "opencode", "opencode.json");
    assert.equal(existsSync(opencodePath), true, "opencode.json must land under the injected USERPROFILE");
    const opencode = JSON.parse(readFileSync(opencodePath, "utf8"));
    const ocAlpha = opencode.provider?.alpha;
    assert.ok(ocAlpha, "alpha provider must be written into the sandbox opencode.json under its raw id");
    assert.equal(ocAlpha.npm, "@ai-sdk/openai-compatible");
    assert.equal(ocAlpha.options.baseURL, "http://127.0.0.1:47821/openai/alpha/v1");
    // apiKey 是 {file:} 引用而非字面 token：盘上零秘密，轮换免重同步。
    assert.equal(ocAlpha.options.apiKey, `{file:${join(tmpRoot, "pi-relay-token").replace(/\\/g, "/")}}`);
    assert.equal(ocAlpha.options.headers["x-agent-id"], "opencode");
    assert.equal(ocAlpha.options.headers["x-agent-instance"], "{env:ANYSWITCH_AGENT_INSTANCE}");
    assert.deepEqual(Object.keys(ocAlpha.models), ["model-1"]);

    assert.ok(res.results.grok);
    const grokPath = join(tmpRoot, ".grok", "config.toml");
    assert.equal(existsSync(grokPath), true, "grok config.toml must land under the injected USERPROFILE");
    const grokText = readFileSync(grokPath, "utf8");
    assert.match(grokText, /\[model\."anyswitch-alpha~model-1"\]/);
    assert.match(grokText, /base_url = "http:\/\/127\.0\.0\.1:47821\/openai\/alpha\/v1"/);
    assert.match(grokText, /api_key = "test-token"/);
    assert.match(grokText, /name = "model-1 · Alpha"/);
    assert.match(grokText, /context_window = 4096/, "store contextWindow lands verbatim");
    assert.match(grokText, /extra_headers = \{ "x-agent-id" = "grok" \}/);
    assert.match(grokText, /env_http_headers = \{ "x-agent-instance" = "ANYSWITCH_INSTANCE_ID" \}/);

    assert.ok(res.results.workbuddy);
    const workbuddyPath = join(tmpRoot, ".workbuddy", "models.json");
    assert.equal(existsSync(workbuddyPath), true, "workbuddy models.json must land under the injected USERPROFILE");
    const workbuddy = JSON.parse(readFileSync(workbuddyPath, "utf8"));
    // 写形状固定为对象：CLI 的 parseModelsJson 只认 {models, availableModels}。
    assert.equal(Array.isArray(workbuddy), false);
    assert.deepEqual(workbuddy.models.map((model) => model.id), ["alpha~model-1"]);
    const workbuddyEntry = workbuddy.models[0];
    // name 与 id 逐字相同：WorkBuddy 对自定义模型按 `${name}:${id}` 拼下拉
    // 标签，name 写「模型 · 渠道」会让含渠道的 id 再被念一遍。
    assert.equal(workbuddyEntry.name, "alpha~model-1");
    assert.equal(workbuddyEntry.vendor, "Anyswitch");
    assert.equal(workbuddyEntry.url, "http://127.0.0.1:47821/openai/workbuddy~alpha/v1/chat/completions");
    assert.equal(workbuddyEntry.apiKey, "test-token");
    assert.equal(workbuddyEntry.useCustomProtocol, true);
    assert.equal(workbuddyEntry.maxInputTokens, 4096, "store contextWindow lands verbatim");
    assert.equal("availableModels" in workbuddy, false, "既有文件没有该键就不创建");
  });

  it("createStoreWatcher triggers callback when store.json changes", async () => {
    const storeFile = join(tmpRoot, "store.json");
    writeFileSync(storeFile, JSON.stringify({ version: 2, providers: {} }), "utf8");

    let changeCount = 0;
    const watcher = createStoreWatcher({
      storeFile,
      debounceMs: 50,
      onStoreChange: async () => {
        changeCount += 1;
      },
    });

    try {
      // Direct trigger
      await watcher.trigger();
      assert.equal(changeCount, 1);

      // File update triggering watcher. Poll instead of one fixed sleep — the
      // event rides real fs.watch delivery plus the debounce timer, both of
      // which drift under full-suite load; a deadline can only wait longer,
      // never assert less.
      writeFileSync(storeFile, JSON.stringify({ version: 2, providers: { a: {} } }), "utf8");
      const deadline = Date.now() + 2000;
      while (changeCount < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.ok(changeCount >= 2, `expected changeCount >= 2, got ${changeCount}`);
    } finally {
      watcher.close();
    }
  });

  it("createStoreWatcher fires on atomicWriteFile temp+rename of store.json", async () => {
    const storeFile = join(tmpRoot, "store.json");
    writeFileSync(storeFile, JSON.stringify({ version: 2, providers: {} }), "utf8");
    let changeCount = 0;
    const watcher = createStoreWatcher({
      storeFile,
      debounceMs: 40,
      onStoreChange: async () => {
        changeCount += 1;
      },
    });
    try {
      atomicWriteFile(storeFile, JSON.stringify({ version: 2, providers: { b: {} } }));
      // Poll instead of one fixed sleep — same reason as above: fs event
      // delivery + debounce is wall-clock bound, a deadline only waits longer.
      const deadline = Date.now() + 2000;
      while (changeCount < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.ok(changeCount >= 1, `atomic replace must notify, got ${changeCount}`);
    } finally {
      watcher.close();
    }
  });

  it("createStoreWatcher reruns after a change that arrives while a sync is in flight", async () => {
    const storeFile = join(tmpRoot, "store.json");
    writeFileSync(storeFile, JSON.stringify({ version: 2, providers: {} }), "utf8");
    let runs = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const watcher = createStoreWatcher({
      storeFile,
      debounceMs: 20,
      onStoreChange: async () => {
        runs += 1;
        if (runs === 1) await gate;
      },
    });
    try {
      const first = watcher.trigger();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(runs, 1);
      const skipped = watcher.trigger();
      release();
      await first;
      await skipped;
      assert.ok(runs >= 2, `queued store change must rerun, got ${runs}`);
    } finally {
      watcher.close();
    }
  });
});

describe("agent-sync pools", () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkTestDir("agent-sync-pool-test-");
    installAgentShapes({ USERPROFILE: tmpRoot, LOCALAPPDATA: tmpRoot, APPDATA: tmpRoot });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function poolStore(withPool) {
    const store = {
      version: 2,
      providers: {
        alpha: {
          displayName: "Alpha",
          baseURL: "https://alpha.invalid/v1",
          protocol: "openai-compatible",
          credentialFile: "alpha.dpapi",
          models: { "model-1": { displayName: "Model 1", contextWindow: 4096 } },
        },
        beta: {
          displayName: "Beta",
          baseURL: "https://beta.invalid/v1",
          protocol: "openai-compatible",
          credentialFile: "beta.dpapi",
          models: { "model-2": { displayName: "Model 2", contextWindow: 8192 } },
        },
      },
    };
    if (withPool) {
      store.pools = { "pool-ab": { displayName: "Pool AB", members: ["alpha", "beta"] } };
    }
    return store;
  }

  const base = () => ({ USERPROFILE: tmpRoot, LOCALAPPDATA: tmpRoot, APPDATA: tmpRoot });
  const syncOpts = (store) => ({ store, port: 47821, token: "test-token", root: tmpRoot, base: base() });

  it("syncs a pool as a single channel into every agent config and removes it on dissolve", async () => {
    const first = await syncAllAgentConfigs(syncOpts(poolStore(true)));
    assert.equal(first.ok, true);

    const zcode = JSON.parse(readFileSync(join(tmpRoot, ".zcode", "v2", "config.json"), "utf8"));
    assert.ok(zcode.provider["_pool-ab"], "pool channel in zcode config");
    assert.equal(zcode.provider["_pool-ab"].name, "Pool AB");
    assert.equal(zcode.provider["_pool-ab"].options.baseURL, "http://127.0.0.1:47821/openai/pool-ab/v1");
    assert.deepEqual(Object.keys(zcode.provider["_pool-ab"].models), ["model-1", "model-2"]);
    // Members are absorbed into the pool channel — no endpoint lists them.
    assert.equal(zcode.provider._alpha, undefined);
    assert.equal(zcode.provider._beta, undefined);

    const kimiText = readFileSync(join(tmpRoot, ".kimi-code", "config.toml"), "utf8");
    assert.match(kimiText, /\[providers\."_pool-ab"\]/);
    assert.match(kimiText, /\[models\."_pool-ab\/model-1"\]/);
    assert.match(kimiText, /\[models\."_pool-ab\/model-2"\]/);
    assert.doesNotMatch(kimiText, /\[providers\."_alpha"\]/);
    assert.doesNotMatch(kimiText, /\[providers\."_beta"\]/);

    const qoderSettings = JSON.parse(readFileSync(join(tmpRoot, ".qoder", "settings.json"), "utf8"));
    const poolConn = qoderSettings.providers?.[managedConnectionId("pool-ab")];
    assert.ok(poolConn, "pool channel in qoder settings");
    assert.equal(poolConn.baseUrl, "http://127.0.0.1:47821/openai/qoder~pool-ab/v1");
    assert.deepEqual(poolConn.models.map((m) => m.model), ["model-1", "model-2"]);
    assert.equal(qoderSettings.providers?.[managedConnectionId("alpha")], undefined);
    assert.equal(qoderSettings.providers?.[managedConnectionId("beta")], undefined);

    const opencode = JSON.parse(readFileSync(join(tmpRoot, ".config", "opencode", "opencode.json"), "utf8"));
    assert.ok(opencode.provider["pool-ab"], "pool channel in opencode.json");
    assert.equal(opencode.provider["pool-ab"].name, "Pool AB");
    assert.equal(opencode.provider["pool-ab"].options.baseURL, "http://127.0.0.1:47821/openai/pool-ab/v1");
    assert.deepEqual(Object.keys(opencode.provider["pool-ab"].models), ["model-1", "model-2"]);
    // Members are absorbed into the pool channel — no endpoint lists them.
    assert.equal(opencode.provider.alpha, undefined);
    assert.equal(opencode.provider.beta, undefined);

    const grokText = readFileSync(join(tmpRoot, ".grok", "config.toml"), "utf8");
    assert.match(grokText, /\[model\."anyswitch-pool-ab~model-1"\]/);
    assert.match(grokText, /\[model\."anyswitch-pool-ab~model-2"\]/);
    assert.match(grokText, /base_url = "http:\/\/127\.0\.0\.1:47821\/openai\/pool-ab\/v1"/);
    assert.doesNotMatch(grokText, /anyswitch-alpha/);
    assert.doesNotMatch(grokText, /anyswitch-beta/);

    // Dissolve the pool and re-sync: the pool channel disappears everywhere,
    // the absorbed member channels resurface as standalone channels.
    const second = await syncAllAgentConfigs(syncOpts(poolStore(false)));
    assert.equal(second.ok, true);

    const zcode2 = JSON.parse(readFileSync(join(tmpRoot, ".zcode", "v2", "config.json"), "utf8"));
    assert.equal(zcode2.provider["_pool-ab"], undefined);
    assert.ok(zcode2.provider._alpha);
    assert.ok(zcode2.provider._beta);

    const kimiText2 = readFileSync(join(tmpRoot, ".kimi-code", "config.toml"), "utf8");
    assert.doesNotMatch(kimiText2, /_pool-ab/);

    const qoderSettings2 = JSON.parse(readFileSync(join(tmpRoot, ".qoder", "settings.json"), "utf8"));
    assert.equal(qoderSettings2.providers?.[managedConnectionId("pool-ab")], undefined);
    assert.ok(qoderSettings2.providers?.[managedConnectionId("alpha")]);
    assert.ok(qoderSettings2.providers?.[managedConnectionId("beta")]);

    const opencode2 = JSON.parse(readFileSync(join(tmpRoot, ".config", "opencode", "opencode.json"), "utf8"));
    assert.equal(opencode2.provider["pool-ab"], undefined);
    assert.ok(opencode2.provider.alpha);
    assert.ok(opencode2.provider.beta);

    const grokText2 = readFileSync(join(tmpRoot, ".grok", "config.toml"), "utf8");
    assert.doesNotMatch(grokText2, /anyswitch-pool-ab/, "grok pool channel cleaned up after dissolve");
    assert.match(grokText2, /\[model\."anyswitch-alpha~model-1"\]/);
    assert.match(grokText2, /\[model\."anyswitch-beta~model-2"\]/);
  });
});

describe("agent-sync auto routing channel", () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkTestDir("agent-sync-auto-test-");
    installAgentShapes({ USERPROFILE: tmpRoot, LOCALAPPDATA: tmpRoot, APPDATA: tmpRoot });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function chainStore(withChains) {
    const store = {
      version: 2,
      providers: {
        alpha: {
          displayName: "Alpha",
          baseURL: "https://alpha.invalid/v1",
          protocol: "openai-compatible",
          credentialFile: "alpha.dpapi",
          models: { "model-1": { displayName: "Model 1", contextWindow: 4096 } },
        },
        beta: {
          displayName: "Beta",
          baseURL: "https://beta.invalid/v1",
          protocol: "openai-compatible",
          credentialFile: "beta.dpapi",
          models: { "model-2": { displayName: "Model 2", contextWindow: 8192 } },
        },
      },
    };
    if (withChains) {
      store.routingChains = {
        zcode: { chain: [{ node: "alpha", model: "model-1" }, { node: "beta", model: "model-2" }] },
        kimi: { chain: [{ node: "beta", model: "model-2" }] },
        opencode: { chain: [{ node: "beta", model: "model-2" }] },
        grok: { chain: [{ node: "beta", model: "model-2" }] },
      };
    }
    return store;
  }

  const base = () => ({ USERPROFILE: tmpRoot, LOCALAPPDATA: tmpRoot, APPDATA: tmpRoot });
  const syncOpts = (store) => ({ store, port: 47821, token: "test-token", root: tmpRoot, base: base() });

  it("injects _auto only into endpoints with a route chain and removes it on chain deletion", async () => {
    const first = await syncAllAgentConfigs(syncOpts(chainStore(true)));
    assert.equal(first.ok, true);

    // zcode has a chain: _auto points at the chain head (alpha) and lists "auto".
    const zcode = JSON.parse(readFileSync(join(tmpRoot, ".zcode", "v2", "config.json"), "utf8"));
    assert.ok(zcode.provider._auto, "zcode gets the _auto channel");
    assert.equal(zcode.provider._auto.name, "Anyswitch");
    assert.equal(zcode.provider._auto.options.baseURL, "http://127.0.0.1:47821/openai/alpha/v1");
    assert.deepEqual(Object.keys(zcode.provider._auto.models), ["auto"]);

    // kimi has a chain headed by beta: the pseudo-channel's provider id is its
    // display name, model aliases keep the historical _auto/ prefix.
    const kimiText = readFileSync(join(tmpRoot, ".kimi-code", "config.toml"), "utf8");
    assert.match(kimiText, /\[providers\."Anyswitch"\]/);
    assert.doesNotMatch(kimiText, /\[providers\."_auto"\]/);
    assert.match(kimiText, /base_url = "http:\/\/127\.0\.0\.1:47821\/openai\/beta\/v1"/);
    assert.match(kimiText, /\[models\."_auto\/auto"\]/);
    assert.match(kimiText, /provider = "Anyswitch"/);
    assert.match(kimiText, /model = "auto"/);

    // pi has NO chain: no pseudo-channel.
    const pi = JSON.parse(readFileSync(join(tmpRoot, ".pi", "agent", "models.json"), "utf8"));
    assert.equal(pi.providers.Anyswitch, undefined, "pi without a chain gets no pseudo-channel");
    assert.ok(pi.providers._alpha);

    // qoder has NO chain: no auto connection in providers.
    const qoderSettings = JSON.parse(readFileSync(join(tmpRoot, ".qoder", "settings.json"), "utf8"));
    assert.equal(qoderSettings.providers?.[managedConnectionId("auto")], undefined, "qoder without a chain gets no auto connection");
    assert.ok(qoderSettings.providers?.[managedConnectionId("alpha")]);

    // opencode has a chain headed by beta: the auto channel points at the head segment.
    const opencode = JSON.parse(readFileSync(join(tmpRoot, ".config", "opencode", "opencode.json"), "utf8"));
    assert.ok(opencode.provider.auto, "opencode gets the auto channel");
    assert.equal(opencode.provider.auto.name, "Anyswitch");
    assert.equal(opencode.provider.auto.options.baseURL, "http://127.0.0.1:47821/openai/beta/v1");
    assert.deepEqual(Object.keys(opencode.provider.auto.models), ["auto"]);

    // grok has a chain headed by beta: the auto entry is the virtual "auto"
    // model on the head's URL segment, keyed with the managed prefix; its name
    // carries the Anyswitch channel label.
    const grokText = readFileSync(join(tmpRoot, ".grok", "config.toml"), "utf8");
    assert.match(grokText, /\[model\."anyswitch-auto"\]/);
    assert.match(grokText, /model = "auto"/);
    assert.match(grokText, /name = "auto · Anyswitch"/);
    assert.match(grokText, /base_url = "http:\/\/127\.0\.0\.1:47821\/openai\/beta\/v1"/);

    // Delete the chains and re-sync: the pseudo-channel disappears everywhere.
    const second = await syncAllAgentConfigs(syncOpts(chainStore(false)));
    assert.equal(second.ok, true);

    const zcode2 = JSON.parse(readFileSync(join(tmpRoot, ".zcode", "v2", "config.json"), "utf8"));
    assert.equal(zcode2.provider._auto, undefined, "zcode pseudo-channel cleaned up after chain deletion");
    assert.ok(zcode2.provider._alpha, "real channels survive the cleanup");

    const kimiText2 = readFileSync(join(tmpRoot, ".kimi-code", "config.toml"), "utf8");
    assert.doesNotMatch(kimiText2, /_auto/, "kimi pseudo-channel cleaned up after chain deletion");
    assert.doesNotMatch(kimiText2, /\[providers\."Anyswitch"\]/);
    assert.match(kimiText2, /\[providers\."_alpha"\]/);

    const opencode2 = JSON.parse(readFileSync(join(tmpRoot, ".config", "opencode", "opencode.json"), "utf8"));
    assert.equal(opencode2.provider.auto, undefined, "opencode auto cleaned up after chain deletion");
    assert.ok(opencode2.provider.alpha);

    const grokText2 = readFileSync(join(tmpRoot, ".grok", "config.toml"), "utf8");
    assert.doesNotMatch(grokText2, /anyswitch-auto/, "grok auto cleaned up after chain deletion");
    assert.match(grokText2, /\[model\."anyswitch-beta~model-2"\]/, "real grok channels survive the cleanup");
  });
});

describe("agent-sync Anyswitch 渠道名（八端点回归闸）", () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkTestDir("agent-sync-channel-name-test-");
    installAgentShapes({ USERPROFILE: tmpRoot, LOCALAPPDATA: tmpRoot, APPDATA: tmpRoot });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // 每个端点都配一条链、且存在一个虚拟模型：伪渠道（auto + 虚拟模型）会进全部
  // 九个配置文件型端点。回归闸只认「用户在模型选择器里能看到的渠道文字」。
  function fullStore() {
    const endpoints = ["zcode", "dsh", "pi", "kimi", "qoder", "codex", "opencode", "grok", "workbuddy"];
    const store = {
      version: 2,
      providers: {
        alpha: {
          displayName: "Alpha",
          baseURL: "https://alpha.invalid/v1",
          protocol: "openai-compatible",
          credentialFile: "alpha.dpapi",
          models: {
            "model-1": { displayName: "Model 1", contextWindow: 4096 },
            "model-2": { displayName: "Model 2", contextWindow: 8192 },
          },
        },
      },
      routingChains: Object.fromEntries(
        endpoints.map((id) => [id, { chain: [{ node: "alpha", model: "model-1" }] }]),
      ),
      virtualModels: [{ name: "vm-a", chain: [{ node: "alpha", model: "model-1" }] }],
    };
    return store;
  }

  it("九个配置文件型端点的伪渠道都显示为 Anyswitch", async () => {
    mkdirSync(join(tmpRoot, ".dsh", "profiles", "desktop"), { recursive: true });
    const res = await syncAllAgentConfigs({
      store: fullStore(),
      port: 47821,
      token: "test-token",
      root: tmpRoot,
      base: { USERPROFILE: tmpRoot, LOCALAPPDATA: tmpRoot, APPDATA: tmpRoot },
    });
    assert.equal(res.ok, true);

    // ZCode 桌面：分组显示名（name）。
    const zcode = JSON.parse(readFileSync(join(tmpRoot, ".zcode", "v2", "config.json"), "utf8"));
    assert.equal(zcode.provider._auto.name, "Anyswitch");
    assert.deepEqual(Object.keys(zcode.provider._auto.models), ["auto", "vm-a"]);

    // DSH：伪渠道以渠道名为 key（选择器的最近使用行/补全直接打印 key），displayName 同名。
    const dshPatch = readFileSync(join(tmpRoot, ".dsh", "profiles", "desktop", "cordis.patch.yml"), "utf8");
    assert.match(dshPatch, /Anyswitch:\n\s+displayName: Anyswitch/);
    assert.doesNotMatch(dshPatch, /_auto:/);

    // pi：模型选择器每行渲染 [provider id]，伪渠道的 key 就是 Anyswitch。
    const pi = JSON.parse(readFileSync(join(tmpRoot, ".pi", "agent", "models.json"), "utf8"));
    assert.ok(pi.providers.Anyswitch, "pi 的伪渠道 key 是 Anyswitch");
    assert.equal(pi.providers.Anyswitch.name, "Anyswitch");
    assert.deepEqual(pi.providers.Anyswitch.models.map((m) => m.id), ["auto", "vm-a"]);
    assert.equal(pi.providers._auto, undefined);

    // Kimi：模型选择器 tab 读 provider id，模型行读 provider 字段。
    const kimiText = readFileSync(join(tmpRoot, ".kimi-code", "config.toml"), "utf8");
    assert.match(kimiText, /\[providers\."Anyswitch"\]/);
    assert.match(kimiText, /\[models\."_auto\/auto"\]/);
    assert.match(kimiText, /\[models\."_auto\/vm-a"\]/);
    assert.match(kimiText, /provider = "Anyswitch"/);

    // Qoder：连接 displayName 与每行模型名后缀。
    const qoder = JSON.parse(readFileSync(join(tmpRoot, ".qoder", "settings.json"), "utf8"));
    const qoderAuto = qoder.providers?.[managedConnectionId("auto")];
    assert.ok(qoderAuto, "qoder 伪渠道连接存在");
    assert.equal(qoderAuto.displayName, "Anyswitch");
    assert.deepEqual(qoderAuto.models.map((m) => m.displayName), ["auto · Anyswitch", "vm-a · Anyswitch"]);

    // Codex：目录 display_name（选择器每行只读它）。
    const codexCatalog = JSON.parse(
      readFileSync(join(tmpRoot, ".codex", "model-catalogs", "anyswitch-models.json"), "utf8"),
    );
    const codexBySlug = new Map(codexCatalog.models.map((m) => [m.slug, m.display_name]));
    assert.equal(codexBySlug.get("auto"), "auto · Anyswitch");
    assert.equal(codexBySlug.get("vm-a"), "vm-a · Anyswitch");

    // OpenCode：provider name。
    const opencode = JSON.parse(readFileSync(join(tmpRoot, ".config", "opencode", "opencode.json"), "utf8"));
    assert.equal(opencode.provider.auto.name, "Anyswitch");
    assert.deepEqual(Object.keys(opencode.provider.auto.models), ["auto", "vm-a"]);

    // Grok：每行模型 name。
    const grokText = readFileSync(join(tmpRoot, ".grok", "config.toml"), "utf8");
    assert.match(grokText, /\[model\."anyswitch-auto"\]\nmodel = "auto"[\s\S]*?name = "auto · Anyswitch"/);
    assert.match(grokText, /\[model\."anyswitch-auto~vm-a"\]\nmodel = "vm-a"[\s\S]*?name = "vm-a · Anyswitch"/);

    // WorkBuddy：条目行读 name，显示名与 id 逐字相同（WorkBuddy 对自定义模型
    // 按 `${name}:${id}` 拼下拉标签，name 与 id 不等就把含渠道的 id 再念一遍）；
    // id 用裸模型名（链拦截按 body.model 字面匹配），url 段带 workbuddy~ 身份前缀。
    const workbuddy = JSON.parse(readFileSync(join(tmpRoot, ".workbuddy", "models.json"), "utf8"));
    const workbuddyById = new Map(workbuddy.models.map((model) => [model.id, model]));
    assert.equal(workbuddyById.get("auto").name, "auto");
    assert.equal(workbuddyById.get("vm-a").name, "vm-a");
    assert.equal(workbuddyById.get("auto").url, "http://127.0.0.1:47821/openai/workbuddy~alpha/v1/chat/completions");
  });
});

describe("agent-sync 同步结果摘要", () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkTestDir("agent-sync-summary-test-");
    installAgentShapes({ USERPROFILE: tmpRoot, LOCALAPPDATA: tmpRoot, APPDATA: tmpRoot });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const base = () => ({ USERPROFILE: tmpRoot, LOCALAPPDATA: tmpRoot, APPDATA: tmpRoot });

  function summaryStore() {
    return {
      version: 2,
      providers: {
        alpha: {
          displayName: "Alpha",
          baseURL: "https://alpha.invalid/v1",
          protocol: "openai-compatible",
          credentialFile: "alpha.dpapi",
          models: { "model-1": { displayName: "Model 1", contextWindow: 4096 } },
        },
      },
    };
  }

  it("登记了端点但没有写手：完整性守卫把它点名进失败名单，不再静默缺席", async () => {
    // results 键从 AGENT_ENDPOINTS 单源派生；往清单里塞一个没有写手块的端点
    // （即「加端点忘写手」的漂移现场），该端点必须以端点级失败回到 results 并
    // 进 failed 名单——面板看到的同步面不得虚报。测完从清单上摘掉。
    AGENT_ENDPOINTS.push("ghost");
    try {
      const res = await syncAllAgentConfigs({
        store: summaryStore(),
        port: 47821,
        token: "test-token",
        root: tmpRoot,
        base: base(),
      });
      assert.equal(res.ok, true);
      assert.deepEqual(Object.keys(res.results), AGENT_ENDPOINTS, "results 键单源派生自 AGENT_ENDPOINTS");
      assert.equal(res.results.ghost.ok, false, "无写手端点按端点级失败点名");
      assert.ok(typeof res.results.ghost.reason === "string" && res.results.ghost.reason.length > 0, "带失败原因");
      const summary = buildSyncSummary(res);
      assert.ok(summary.failed.includes("ghost"), "缺口端点进失败名单");
      assert.ok(!summary.synced.includes("ghost"), "不进成功名单");
    } finally {
      AGENT_ENDPOINTS.pop();
    }
  });

  it("单个端点写不进去时整体仍算成功，失败名单列出该端点", async () => {
    // 拿目录顶住 codex 的配置文件：只有 codex 这一步读不出来，其余端点照常写。
    mkdirSync(join(tmpRoot, ".codex", "config.toml"), { recursive: true });
    const res = await syncAllAgentConfigs({
      store: summaryStore(),
      port: 47821,
      token: "test-token",
      root: tmpRoot,
      base: base(),
    });
    assert.equal(res.ok, true, "单个端点失败不再拖垮整次同步");
    assert.equal(res.results.codex.ok, false);

    const summary = buildSyncSummary(res);
    assert.equal(summary.ok, true, "有端点失败但整次同步仍算跑完");
    assert.ok(summary.failed.includes("codex"), "失败名单列出没写进去的端点");
    assert.ok(!summary.synced.includes("codex"), "失败端点不进成功名单");
    assert.ok(summary.synced.includes("zcode"), "其余端点照常进成功名单");
    for (const name of summary.failed) {
      assert.ok(!summary.synced.includes(name), `${name} 不能同时出现在两个名单里`);
    }
    assert.equal(summary.synced.length + summary.failed.length, 9, "九个端点各归一个名单");
  });

  it("仓库数据读不出来时整体失败，不给面板任何端点名单", async () => {
    // store.json 是个目录：存在但读不出来。
    mkdirSync(join(tmpRoot, "store.json"), { recursive: true });
    const res = await syncAllAgentConfigs({
      port: 47821,
      token: "test-token",
      root: tmpRoot,
      base: base(),
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "store-unreadable");

    const summary = buildSyncSummary(res);
    assert.equal(summary.ok, false, "仓库数据读不出来是真失败");
    assert.deepEqual(summary.synced, [], "没有端点结果可言，成功名单留空");
    assert.deepEqual(summary.failed, [], "失败原因走 error，不塞进端点名单");
  });

  it("home 变量缺失时全部端点判失败，绝不往进程 CWD 落盘", async () => {
    // node --test 并行跑时各测试进程共享仓库目录作 CWD，直接对它做前后清单
    // 会吃进并发进程的增删。把进程 CWD 切进本用例私有的夹具目录再观测：
    // 断言语义不变（回归时相对路径落盘仍会被清单 diff 抓住），夹具由
    // afterEach 统一清扫，也不会误删并发进程的文件。
    const prevCwd = process.cwd();
    const cwd = tmpRoot;
    process.chdir(cwd);
    let res;
    try {
      const before = readdirSync(cwd);
      res = await syncAllAgentConfigs({
        store: summaryStore(),
        port: 47821,
        token: "test-token",
        root: tmpRoot,
        base: {}, // USERPROFILE 缺失：各端点路径解析退化成相对路径
      });
      const after = readdirSync(cwd);
      assert.deepEqual(after, before, "CWD 目录清单不变：没有任何新文件落盘");
    } finally {
      process.chdir(prevCwd);
    }
    assert.equal(res.ok, true, "home 缺失是端点级失败，不拖垮整次同步");
    for (const name of AGENT_ENDPOINTS) {
      const entry = res.results[name];
      assert.ok(entry, `${name} 有结果`);
      assert.equal(entry.ok, false, `${name} 判失败`);
      assert.equal(typeof entry.reason, "string", `${name} 带失败原因`);
      assert.ok(entry.reason.length > 0, `${name} 的失败原因非空`);
    }
    const summary = buildSyncSummary(res);
    assert.deepEqual([...summary.failed].sort(), [...AGENT_ENDPOINTS].sort(), "九个端点全进失败名单");
    assert.deepEqual(summary.synced, [], "成功名单为空");
  });

  it("摘要行可被解析，缺这行或这行坏了都不报错", () => {
    const summary = {
      ok: true,
      synced: ["zcode", "pi"],
      failed: ["codex"],
      codexCatalog: { state: "written", entries: 7 },
    };
    const line = formatSyncSummaryLine(summary);
    assert.ok(line.startsWith(SYNC_RESULT_PREFIX), "行首就是约定的标记");
    assert.deepEqual(parseSyncSummaryLine(line), summary, "摘要行能原样解析回来");

    const stdout = `[agent-sync] zcode config.json synced
${line}
[agent-sync] WARN codex config.toml not updated: nope
`;
    assert.deepEqual(parseSyncSummaryLine(stdout), summary, "摘要行混在普通日志里也能捞出来");

    assert.equal(parseSyncSummaryLine("[agent-sync] all agent configurations synced\n"), null, "没有摘要行就返回 null");
    assert.equal(parseSyncSummaryLine(""), null);
    assert.equal(parseSyncSummaryLine(undefined), null);
    assert.equal(parseSyncSummaryLine(`${SYNC_RESULT_PREFIX}{oops`), null, "摘要行坏了也只返回 null");

    // 目录字段由 codex 写入器给出，还没给的时候摘要里就没有这一项。
    const plain = { ok: true, synced: ["pi"], failed: [] };
    assert.deepEqual(parseSyncSummaryLine(formatSyncSummaryLine(plain)), plain);
  });

  it("目录重写过就记一条日志，没重写过或没这个字段都不记", () => {
    // codex 写入器给的目录状态固定五个取值，重写过就是 written，其余四个都不算更新。
    const withEntries = codexCatalogLogMessage({ state: "written", entries: 12 });
    assert.equal(withEntries, "Codex 模型列表已更新，共 12 个模型");
    assert.doesNotMatch(withEntries, /catalog|state|entries|unchanged|written/i, "日志文案不提内部字段名");
    assert.equal(codexCatalogLogMessage({ state: "written" }), "Codex 模型列表已更新");
    assert.equal(codexCatalogLogMessage({ state: "something-else", entries: 3 }), null, "不认识的状态不记日志");
    assert.equal(codexCatalogLogMessage({ state: "unchanged", entries: 12 }), null, "目录没重写就不记");
    assert.equal(codexCatalogLogMessage({ state: "removed", entries: 0 }), null, "目录撤掉不算更新");
    assert.equal(codexCatalogLogMessage({ state: "skipped", entries: 0 }), null, "这次没生成目录就不记");
    assert.equal(codexCatalogLogMessage({ state: "user-pointer", entries: 0 }), null, "用的是用户自己的目录就不记");
    assert.equal(codexCatalogLogMessage(undefined), null, "写入器还没给这个字段时安静跳过");
  });

  it("整轮同步的摘要带上目录状态，写入器不给这一项就没有它", async () => {
    const res = await syncAllAgentConfigs({
      store: summaryStore(),
      port: 47821,
      token: "test-token",
      root: tmpRoot,
      base: base(),
    });
    assert.equal(res.ok, true);
    const summary = buildSyncSummary(res);
    const catalog = res.results.codex?.catalog;
    if (catalog) {
      // 目录状态由 codex 写入器给出，摘要原样透传给面板。
      assert.equal(summary.codexCatalog.state, catalog.state);
      assert.equal(summary.codexCatalog.entries, catalog.entries);
      assert.equal(catalog.state, "written", "有模型可同步时目录这次重写过");
      assert.ok(catalog.entries > 0, "条目数是真实写进目录的模型数");
      assert.ok(codexCatalogLogMessage(catalog), "真实同步里这条目录日志确实会记");
    } else {
      assert.equal(summary.codexCatalog, undefined, "写入器没给目录状态时摘要里就不带这一项");
    }
  });
});

describe("agent-sync 未安装端点闸门", () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkTestDir("agent-sync-gate-test-");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const base = (extra) => ({ USERPROFILE: tmpRoot, LOCALAPPDATA: tmpRoot, APPDATA: tmpRoot, ...extra });
  // store 必须带真渠道：空 store 是「无托管面可写」，写入器本来就不建文件，
  // 那样「端点在装 → 配置被写入」的断言什么都证明不了。
  const homeOpts = (extra) => ({
    store: {
      version: 2,
      providers: {
        alpha: {
          displayName: "Alpha",
          baseURL: "https://alpha.invalid/v1",
          protocol: "openai-compatible",
          credentialFile: "alpha.dpapi",
          models: { "model-1": { contextWindow: 4096 } },
        },
      },
    },
    port: 47821,
    token: "test-token",
    root: tmpRoot,
    base: base(extra),
  });

  it("空机器：九端点全部跳过，一个配置文件都不建", async () => {
    const res = await syncAllAgentConfigs(homeOpts());
    assert.equal(res.ok, true);
    for (const name of AGENT_ENDPOINTS) {
      assert.equal(res.results[name].ok, true, `${name} 跳过不是失败`);
      assert.equal(res.results[name].notInstalled, true, `${name} 带跳过标记`);
      assert.equal(res.results[name].unchanged, true, `${name} 没写盘`);
    }
    const summary = buildSyncSummary(res);
    assert.deepEqual(summary.synced, [], "跳过不上成功名单");
    assert.deepEqual(summary.failed, [], "跳过不上失败名单");
    for (const dir of [".zcode", ".dsh", ".pi", ".kimi-code", ".qoder", ".codex", ".config", ".grok", ".workbuddy"]) {
      assert.equal(existsSync(join(tmpRoot, dir)), false, `${dir} 不被凭空创建`);
    }
  });

  it("卸载残留不被刷新：既有配置一字不动", async () => {
    const stalePath = join(tmpRoot, ".kimi-code", "config.toml");
    mkdirSync(dirname(stalePath), { recursive: true });
    const residue = "# residue left by the uninstalled kimi\n";
    writeFileSync(stalePath, residue);
    await syncAllAgentConfigs(homeOpts());
    assert.equal(readFileSync(stalePath, "utf8"), residue, "残留配置不被改写也不被清掉");
  });

  it("端点重新出现在盘上后，下一次同步恢复写入", async () => {
    const first = await syncAllAgentConfigs(homeOpts());
    assert.equal(first.results.zcode.notInstalled, true);
    installAgentShapes({ USERPROFILE: tmpRoot, LOCALAPPDATA: tmpRoot, APPDATA: tmpRoot });
    const second = await syncAllAgentConfigs(homeOpts());
    assert.equal(second.results.zcode.notInstalled, undefined, "重装后不再跳过");
    assert.equal(second.results.zcode.ok, true);
    assert.ok(existsSync(join(tmpRoot, ".zcode", "v2", "config.json")), "端点回来后配置照写");
  });

  it("覆盖变量指向真实文件时视为在装", async () => {
    const exe = join(tmpRoot, "tools", "grok.exe");
    mkdirSync(dirname(exe), { recursive: true });
    writeFileSync(exe, "stub");
    const res = await syncAllAgentConfigs(homeOpts({ GROK_EXECUTABLE: exe }));
    assert.equal(res.results.grok.notInstalled, undefined, "覆盖生效不跳过");
    assert.equal(res.results.grok.ok, true);
    assert.ok(existsSync(join(tmpRoot, ".grok", "config.toml")));
  });

  it("判定拿不准时 fail-open 照写：覆盖变量写坏不再作跳过依据", async () => {
    const res = await syncAllAgentConfigs(homeOpts({ GROK_EXECUTABLE: "relative/grok.exe" }));
    assert.equal(res.results.grok.notInstalled, undefined, "拿不准不跳过");
    assert.equal(res.results.grok.ok, true);
    assert.ok(existsSync(join(tmpRoot, ".grok", "config.toml")), "fail-open：宁可多写不误伤");
  });
});

