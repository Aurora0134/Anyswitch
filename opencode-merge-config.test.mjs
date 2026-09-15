import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpencodeProviderEntry,
  mergeOpencodeConfig,
  readOpencodeConfig,
  writeOpencodeConfigWithBackup,
  readSidecar,
  writeSidecar,
  relayTokenFileRef,
  validateOpencodeConfig,
  extractManagedProviders,
  deriveAutoRouteChannel,
  sidecarPath,
} from "./opencode-merge-config.mjs";

let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "opencode-merge-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeStore({ withPool = false } = {}) {
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

describe("relayTokenFileRef", () => {
  it("builds a {file:...} reference with forward slashes to the relay token file", () => {
    const ref = relayTokenFileRef("C:\\Users\\tester\\AppData\\Local\\Anyswitch");
    assert.equal(ref, "{file:C:/Users/tester/AppData/Local/Anyswitch/pi-relay-token}");
  });
});

describe("buildOpencodeProviderEntry", () => {
  it("builds an openai-compatible provider entry with relay URL, {file:} apiKey and identity headers", () => {
    const store = makeStore();
    const managed = extractManagedProviders(store);
    const entry = buildOpencodeProviderEntry("alpha", managed.alpha, 47821, "{file:C:/tok}");
    const alpha = entry.alpha;
    assert.equal(alpha.npm, "@ai-sdk/openai-compatible");
    assert.equal(alpha.name, "Alpha");
    assert.equal(alpha.options.baseURL, "http://127.0.0.1:47821/openai/alpha/v1");
    assert.equal(alpha.options.apiKey, "{file:C:/tok}");
    assert.equal(alpha.options.headers["x-agent-id"], "opencode");
    assert.equal(alpha.options.headers["x-agent-instance"], "{env:ANYSWITCH_AGENT_INSTANCE}");
    assert.deepEqual(alpha.models, { "model-1": { name: "Model 1" } });
  });

  it("falls back to the ids when display names are missing, and never writes literal secrets", () => {
    const entry = buildOpencodeProviderEntry("alpha", { models: { "m-1": {} } }, 47821, "{file:C:/tok}");
    assert.equal(entry.alpha.name, "alpha");
    assert.equal(entry.alpha.models["m-1"].name, "m-1");
    const text = JSON.stringify(entry);
    assert.doesNotMatch(text, /Bearer /);
  });

  it("uses baseUrlSegment for the auto pseudo-channel instead of its own id", () => {
    const autoChannel = deriveAutoRouteChannel(
      { routingChains: { opencode: { chain: [{ node: "alpha", model: "model-1" }] } } },
      "opencode",
    );
    const entry = buildOpencodeProviderEntry("auto", autoChannel, 47821, "{file:C:/tok}");
    assert.equal(entry.auto.name, "自动路由");
    assert.equal(entry.auto.options.baseURL, "http://127.0.0.1:47821/openai/alpha/v1");
    assert.deepEqual(Object.keys(entry.auto.models), ["auto"]);
  });

  it("writes reasoning variants from declared model levels, skipping a wire-less off", () => {
    const provider = {
      displayName: "Alpha",
      models: {
        "model-r": { displayName: "Model R", reasoningEffortLevels: ["off", "low", "high"] },
      },
    };
    // A non-null catalog unlocks the effort path; declared levels need no db.
    const entry = buildOpencodeProviderEntry("alpha", provider, 47821, "{file:C:/tok}", { models: {} });
    assert.deepEqual(entry.alpha.models["model-r"].variants, {
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    });
  });

  it("writes no variants when the model is declared non-reasoning or no catalog is given", () => {
    const provider = {
      displayName: "Alpha",
      models: {
        "model-nr": { displayName: "NR", supportsReasoning: false, reasoningEffortLevels: ["low"] },
        "model-plain": { displayName: "Plain" },
      },
    };
    const withCatalog = buildOpencodeProviderEntry("alpha", provider, 47821, "{file:C:/tok}", { models: {} });
    assert.equal(withCatalog.alpha.models["model-nr"].variants, undefined);
    const noCatalog = buildOpencodeProviderEntry("alpha", provider, 47821, "{file:C:/tok}", null);
    assert.equal(noCatalog.alpha.models["model-plain"].variants, undefined);
  });
});

describe("mergeOpencodeConfig", () => {
  it("manages raw (unprefixed) provider ids so existing provider/model references keep working", () => {
    const managed = extractManagedProviders(makeStore());
    const { config, managed: ids } = mergeOpencodeConfig({ provider: {} }, managed, 47821, "{file:C:/tok}");
    assert.deepEqual(ids.sort(), ["alpha", "beta"]);
    assert.ok(config.provider.alpha);
    assert.ok(config.provider.beta);
    assert.equal(config.provider._alpha, undefined);
  });

  it("preserves user-owned providers and top-level fields, deleting only previously managed ids", () => {
    const managed = extractManagedProviders(makeStore());
    const first = mergeOpencodeConfig(
      { $schema: "https://opencode.ai/config.json", provider: { "user-own": { npm: "@ai-sdk/openai-compatible", models: {} } } },
      managed,
      47821,
      "{file:C:/tok}",
    );
    // Second sync: beta leaves the store. It was managed last time, so it is
    // deleted; alpha stays; the user provider is never touched.
    const alphaOnly = { alpha: managed.alpha };
    const second = mergeOpencodeConfig(first.config, alphaOnly, 47821, "{file:C:/tok}", first.managed);
    assert.equal(second.config.provider.beta, undefined);
    assert.ok(second.config.provider.alpha);
    assert.ok(second.config.provider["user-own"], "user-owned provider must survive every sync");
    assert.equal(second.config.$schema, "https://opencode.ai/config.json");
    assert.deepEqual(second.managed, ["alpha"]);
  });

  it("surfaces a pool as ONE channel and absorbs its members, then dissolves cleanly", () => {
    const pooled = extractManagedProviders(makeStore({ withPool: true }));
    assert.deepEqual(Object.keys(pooled), ["pool-ab"]);
    assert.equal(pooled["pool-ab"].channelName, "Pool AB");
    assert.deepEqual(Object.keys(pooled["pool-ab"].models), ["model-1", "model-2"]);

    const first = mergeOpencodeConfig({ provider: {} }, pooled, 47821, "{file:C:/tok}");
    assert.ok(first.config.provider["pool-ab"]);
    assert.equal(first.config.provider["pool-ab"].name, "Pool AB");
    assert.equal(first.config.provider["pool-ab"].options.baseURL, "http://127.0.0.1:47821/openai/pool-ab/v1");
    assert.equal(first.config.provider.alpha, undefined);
    assert.equal(first.config.provider.beta, undefined);

    // Dissolve: members resurface as standalone channels, the pool is deleted
    // through the ordinary previousManaged path.
    const dissolved = extractManagedProviders(makeStore());
    const second = mergeOpencodeConfig(first.config, dissolved, 47821, "{file:C:/tok}", first.managed);
    assert.equal(second.config.provider["pool-ab"], undefined);
    assert.ok(second.config.provider.alpha);
    assert.ok(second.config.provider.beta);
  });

  it("appends the auto channel and removes it when the chain disappears", () => {
    const store = makeStore();
    store.routingChains = { opencode: { chain: [{ node: "alpha", model: "model-1" }] } };
    const managed = extractManagedProviders(store);
    const auto = deriveAutoRouteChannel(store, "opencode");
    const first = mergeOpencodeConfig({ provider: {} }, managed, 47821, "{file:C:/tok}", [], auto);
    assert.ok(first.config.provider.auto);
    assert.equal(first.config.provider.auto.name, "自动路由");
    assert.deepEqual(first.managed.sort(), ["alpha", "auto", "beta"]);

    const second = mergeOpencodeConfig(first.config, managed, 47821, "{file:C:/tok}", first.managed, null);
    assert.equal(second.config.provider.auto, undefined);
  });
});

describe("readOpencodeConfig / writeOpencodeConfigWithBackup", () => {
  it("returns an empty provider object when the file is missing", () => {
    assert.deepEqual(readOpencodeConfig(join(tmpRoot, "opencode.json")), { provider: {} });
  });

  it("fails closed on an unparseable config instead of overwriting it", () => {
    const configPath = join(tmpRoot, "opencode.json");
    writeFileSync(configPath, "{ not json", "utf8");
    assert.throws(() => readOpencodeConfig(configPath), /refusing to overwrite unparseable opencode config/);
    assert.equal(readFileSync(configPath, "utf8"), "{ not json");
  });

  it("writes, short-circuits when unchanged, and keeps a timestamped backup on change", () => {
    const configPath = join(tmpRoot, "opencode.json");
    const first = writeOpencodeConfigWithBackup(configPath, { provider: { alpha: { npm: "x", models: {} } } });
    assert.equal(first.ok, true);
    assert.equal(first.unchanged, false);
    assert.equal(first.backupPath, undefined);

    const same = writeOpencodeConfigWithBackup(configPath, { provider: { alpha: { npm: "x", models: {} } } });
    assert.equal(same.ok, true);
    assert.equal(same.unchanged, true);

    const changed = writeOpencodeConfigWithBackup(configPath, { provider: { alpha: { npm: "x", models: {} }, beta: { npm: "y", models: {} } } });
    assert.equal(changed.unchanged, false);
    assert.ok(changed.backupPath, "a backup of the previous content must exist");
    assert.ok(changed.backupPath.includes("opencode.backup."));
    assert.deepEqual(JSON.parse(readFileSync(changed.backupPath, "utf8")), { provider: { alpha: { npm: "x", models: {} } } });
  });
});

describe("validateOpencodeConfig", () => {
  it("accepts a well-formed managed config and rejects broken shapes", () => {
    assert.equal(validateOpencodeConfig({ provider: {} }).valid, true);
    assert.equal(validateOpencodeConfig({ provider: { alpha: { npm: "@ai-sdk/openai-compatible", models: {} } } }).valid, true);
    assert.equal(validateOpencodeConfig(null).valid, false);
    assert.equal(validateOpencodeConfig({}).valid, false);
    assert.equal(validateOpencodeConfig({ provider: [] }).valid, false);
    assert.equal(validateOpencodeConfig({ provider: { alpha: null } }).valid, false);
    assert.equal(validateOpencodeConfig({ provider: { alpha: { npm: 5 } } }).valid, false);
    assert.equal(validateOpencodeConfig({ provider: { alpha: { models: [] } } }).valid, false);
  });
});

describe("sidecar", () => {
  it("round-trips the managed provider list through the opencode sidecar file", () => {
    assert.deepEqual(readSidecar(tmpRoot), { providers: [] });
    writeSidecar(tmpRoot, ["beta", "alpha"]);
    assert.deepEqual(readSidecar(tmpRoot), { providers: ["alpha", "beta"] });
    assert.equal(existsSync(sidecarPath(tmpRoot)), true);
  });
});
