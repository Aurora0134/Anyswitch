import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncAllAgentConfigs, createStoreWatcher } from "./agent-sync.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";

describe("agent-sync", () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "agent-sync-test-"));
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
    assert.ok(res.results.reasonix);

    const { existsSync, readFileSync } = await import("node:fs");
    const kimiPath = join(tmpRoot, ".kimi-code", "config.toml");
    assert.equal(existsSync(kimiPath), true, "kimi config.toml must land under the injected USERPROFILE");
    const kimiText = readFileSync(kimiPath, "utf8");
    assert.match(kimiText, /\[providers\."_alpha"\]/);
    assert.match(kimiText, /api_key = "test-token"/);
    assert.match(kimiText, /\[models\."_alpha\/model-1"\]/);

    const reasonixPath = join(tmpRoot, "reasonix", "config.toml");
    assert.equal(existsSync(reasonixPath), true, "reasonix config.toml must land under the injected APPDATA");
    const reasonixText = readFileSync(reasonixPath, "utf8");
    assert.match(reasonixText, /name\s+= "_alpha"/);
    assert.match(reasonixText, /"model-1"/);
    assert.match(reasonixText, /base_url\s+= "http:\/\/127\.0\.0\.1:47821\/openai\/alpha\/v1"/);
    const reasonixEnv = readFileSync(join(tmpRoot, "reasonix", ".env"), "utf8");
    assert.match(reasonixEnv, /APICRED_RELAY_TOKEN=test-token/);

    const zcodePath = join(tmpRoot, ".zcode", "v2", "config.json");
    assert.equal(existsSync(zcodePath), true, "zcode config must land under the injected USERPROFILE");
    const zcode = JSON.parse(readFileSync(zcodePath, "utf8"));
    assert.ok(zcode.provider?._alpha, "alpha provider must be written into the sandbox zcode config");
    assert.equal(zcode.provider._alpha.options.apiKey, "test-token");
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
    tmpRoot = mkdtempSync(join(tmpdir(), "agent-sync-pool-test-"));
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

    const reasonixText = readFileSync(join(tmpRoot, "reasonix", "config.toml"), "utf8");
    assert.match(reasonixText, /name\s+= "_pool-ab"/);
    assert.match(reasonixText, /base_url\s+= "http:\/\/127\.0\.0\.1:47821\/openai\/pool-ab\/v1"/);

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

    const reasonixText2 = readFileSync(join(tmpRoot, "reasonix", "config.toml"), "utf8");
    assert.doesNotMatch(reasonixText2, /_pool-ab/);
  });
});

describe("agent-sync auto routing channel", () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "agent-sync-auto-test-"));
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

    // Delete the chains and re-sync: _auto disappears everywhere.
    const second = await syncAllAgentConfigs(syncOpts(chainStore(false)));
    assert.equal(second.ok, true);

    const zcode2 = JSON.parse(readFileSync(join(tmpRoot, ".zcode", "v2", "config.json"), "utf8"));
    assert.equal(zcode2.provider._auto, undefined, "zcode _auto cleaned up after chain deletion");
    assert.ok(zcode2.provider._alpha, "real channels survive the cleanup");

    const kimiText2 = readFileSync(join(tmpRoot, ".kimi-code", "config.toml"), "utf8");
    assert.doesNotMatch(kimiText2, /_auto/, "kimi _auto cleaned up after chain deletion");
    assert.match(kimiText2, /\[providers\."_alpha"\]/);
  });
});
