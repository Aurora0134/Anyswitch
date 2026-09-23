import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  syncAllAgentConfigs,
  createStoreWatcher,
  buildSyncSummary,
  formatSyncSummaryLine,
  parseSyncSummaryLine,
  codexCatalogLogMessage,
  SYNC_RESULT_PREFIX,
} from "./agent-sync.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";
import { managedConnectionId } from "./qoder-merge-config.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

describe("agent-sync", () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkTestDir("agent-sync-test-");
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

      // File update triggering watcher (allow time for fs events & debounce)
      writeFileSync(storeFile, JSON.stringify({ version: 2, providers: { a: {} } }), "utf8");
      await new Promise((r) => setTimeout(r, 150));
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
      await new Promise((r) => setTimeout(r, 200));
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
    assert.equal(zcode.provider._auto.name, "自动路由");
    assert.equal(zcode.provider._auto.options.baseURL, "http://127.0.0.1:47821/openai/alpha/v1");
    assert.deepEqual(Object.keys(zcode.provider._auto.models), ["auto"]);

    // kimi has a chain headed by beta: alias _auto/auto maps to literal model auto.
    const kimiText = readFileSync(join(tmpRoot, ".kimi-code", "config.toml"), "utf8");
    assert.match(kimiText, /\[providers\."_auto"\]/);
    assert.match(kimiText, /base_url = "http:\/\/127\.0\.0\.1:47821\/openai\/beta\/v1"/);
    assert.match(kimiText, /\[models\."_auto\/auto"\]/);
    assert.match(kimiText, /model = "auto"/);

    // pi has NO chain: no _auto channel.
    const pi = JSON.parse(readFileSync(join(tmpRoot, ".pi", "agent", "models.json"), "utf8"));
    assert.equal(pi.providers._auto, undefined, "pi without a chain gets no _auto channel");
    assert.ok(pi.providers._alpha);

    // qoder has NO chain: no auto connection in providers.
    const qoderSettings = JSON.parse(readFileSync(join(tmpRoot, ".qoder", "settings.json"), "utf8"));
    assert.equal(qoderSettings.providers?.[managedConnectionId("auto")], undefined, "qoder without a chain gets no auto connection");
    assert.ok(qoderSettings.providers?.[managedConnectionId("alpha")]);

    // opencode has a chain headed by beta: the auto channel points at the head segment.
    const opencode = JSON.parse(readFileSync(join(tmpRoot, ".config", "opencode", "opencode.json"), "utf8"));
    assert.ok(opencode.provider.auto, "opencode gets the auto channel");
    assert.equal(opencode.provider.auto.name, "自动路由");
    assert.equal(opencode.provider.auto.options.baseURL, "http://127.0.0.1:47821/openai/beta/v1");
    assert.deepEqual(Object.keys(opencode.provider.auto.models), ["auto"]);

    // grok has a chain headed by beta: the auto entry is the virtual "auto"
    // model on the head's URL segment, keyed with the managed prefix.
    const grokText = readFileSync(join(tmpRoot, ".grok", "config.toml"), "utf8");
    assert.match(grokText, /\[model\."anyswitch-auto"\]/);
    assert.match(grokText, /model = "auto"/);
    assert.match(grokText, /name = "auto"/);
    assert.match(grokText, /base_url = "http:\/\/127\.0\.0\.1:47821\/openai\/beta\/v1"/);

    // Delete the chains and re-sync: _auto disappears everywhere.
    const second = await syncAllAgentConfigs(syncOpts(chainStore(false)));
    assert.equal(second.ok, true);

    const zcode2 = JSON.parse(readFileSync(join(tmpRoot, ".zcode", "v2", "config.json"), "utf8"));
    assert.equal(zcode2.provider._auto, undefined, "zcode _auto cleaned up after chain deletion");
    assert.ok(zcode2.provider._alpha, "real channels survive the cleanup");

    const kimiText2 = readFileSync(join(tmpRoot, ".kimi-code", "config.toml"), "utf8");
    assert.doesNotMatch(kimiText2, /_auto/, "kimi _auto cleaned up after chain deletion");
    assert.match(kimiText2, /\[providers\."_alpha"\]/);

    const opencode2 = JSON.parse(readFileSync(join(tmpRoot, ".config", "opencode", "opencode.json"), "utf8"));
    assert.equal(opencode2.provider.auto, undefined, "opencode auto cleaned up after chain deletion");
    assert.ok(opencode2.provider.alpha);

    const grokText2 = readFileSync(join(tmpRoot, ".grok", "config.toml"), "utf8");
    assert.doesNotMatch(grokText2, /anyswitch-auto/, "grok auto cleaned up after chain deletion");
    assert.match(grokText2, /\[model\."anyswitch-beta~model-2"\]/, "real grok channels survive the cleanup");
  });
});

describe("agent-sync 同步结果摘要", () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkTestDir("agent-sync-summary-test-");
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
    assert.equal(summary.synced.length + summary.failed.length, 8, "八个端点各归一个名单");
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

