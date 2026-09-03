import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreService } from "./store-service.mjs";
import { storePaths, ensureLayout, loadStore, writeStore } from "./store-io.mjs";
import { MAX_CHAIN_NODES } from "./store-schema.mjs";

// Store-management service against a real mkdtemp store root with real
// store-io; only fetch and dpapi are faked. Credential "ciphertext" here is a
// reversible fake (`enc:<plaintext>`), so tests can assert exactly what the
// service persisted without touching real DPAPI.

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-store-service-"));
  const paths = storePaths(root);
  ensureLayout(paths);
  return paths;
}

function fakeProtect(plaintext) {
  return Buffer.from(`enc:${plaintext.toString("utf8")}`, "utf8");
}

function fakeUnprotect(ciphertext) {
  const text = ciphertext.toString("utf8");
  assert.ok(text.startsWith("enc:"), "fake ciphertext prefix");
  return Buffer.from(text.slice(4), "utf8");
}

function modelsResponse(ids) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: ids.map((id) => ({ id, context_length: 8192 })) }),
  };
}

function makeService(paths, { fetchImpl, writeStoreImpl, ...extra } = {}) {
  return createStoreService({
    paths,
    protect: async (plaintext) => fakeProtect(plaintext),
    unprotect: async (ciphertext) => fakeUnprotect(ciphertext),
    fetchImpl: fetchImpl ?? (async () => modelsResponse(["model-a", "model-b"])),
    ...(writeStoreImpl ? { writeStore: writeStoreImpl } : {}),
    ...extra,
  });
}

function seedStore(paths, providers, extra = {}) {
  const written = writeStore({ version: 2, providers, ...extra }, { paths });
  assert.equal(written.ok, true, written.reason);
  return written.hash;
}

function readStore(paths) {
  const loaded = loadStore(paths);
  assert.equal(loaded.ok, true, loaded.reason);
  return loaded;
}

function richEntry(id, modelIds, over = {}) {
  const discovered = {};
  for (const modelId of modelIds) discovered[modelId] = { displayName: modelId };
  return {
    displayName: id,
    baseURL: "https://api.example.com/v1",
    protocol: "openai-compatible",
    credentialFile: `${id}.dpapi`,
    discovered: structuredClone(discovered),
    modelFilter: modelIds.slice(),
    models: structuredClone(discovered),
    ...over,
  };
}

function writeCredential(paths, id, key = "sk-test") {
  writeFileSync(join(paths.credentialsDir, `${id}.dpapi`), fakeProtect(Buffer.from(key, "utf8")));
}

describe("store-service addProvider", () => {
  it("discovers models, writes the credential first, then CAS-writes the store", async () => {
    const paths = makeRoot();
    const svc = makeService(paths);
    const result = await svc.addProvider({
      id: "newp",
      displayName: "New Provider",
      baseURLs: "https://api.example.com/v1, https://backup.example.com/v1",
      apiKey: "sk-secret",
    });
    assert.equal(result.ok, true);
    assert.equal(result.modelCount, 2);
    assert.equal(JSON.stringify(result).includes("sk-secret"), false);

    const entry = readStore(paths).store.providers.newp;
    assert.equal(entry.displayName, "New Provider");
    assert.deepEqual(entry.fallbackURLs, ["https://backup.example.com/v1"]);
    assert.deepEqual(Object.keys(entry.models).sort(), ["model-a", "model-b"]);
    assert.deepEqual(entry.modelFilter, ["model-a", "model-b"]);
    assert.equal(entry.discovered["model-a"].contextWindow, undefined); // add path uses ids only
    const credential = readFileSync(join(paths.credentialsDir, "newp.dpapi"), "utf8");
    assert.equal(credential, "enc:sk-secret");
  });

  it("falls back to manual modelIds when discovery fails, and errors without them", async () => {
    const paths = makeRoot();
    const failFetch = async () => ({ ok: false, status: 401, body: { cancel: async () => {} } });
    const svc = makeService(paths, { fetchImpl: failFetch });

    const refused = await svc.addProvider({ id: "p1", baseURLs: "https://x.example.com", apiKey: "k" });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /HTTP 401/);
    assert.match(refused.error, /modelIds/);
    assert.equal(existsSync(join(paths.credentialsDir, "p1.dpapi")), false);

    const manual = await svc.addProvider({
      id: "p1",
      baseURLs: "https://x.example.com",
      apiKey: "k",
      modelIds: ["hand-one", "hand-two"],
    });
    assert.equal(manual.ok, true);
    assert.deepEqual(Object.keys(readStore(paths).store.providers.p1.models).sort(), ["hand-one", "hand-two"]);
  });

  it("is fail-closed: a failed store write removes the orphaned credential of a NEW provider", async () => {
    const paths = makeRoot();
    const svc = makeService(paths, {
      writeStoreImpl: () => ({ ok: false, reason: "store changed since it was read" }),
    });
    const result = await svc.addProvider({ id: "ghost", baseURLs: "https://x.example.com", apiKey: "k" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "cas-conflict");
    assert.equal(existsSync(join(paths.credentialsDir, "ghost.dpapi")), false);
    const loaded = loadStore(paths);
    assert.equal(loaded.ok, false); // nothing was ever written
    assert.equal(loaded.reason, "store-absent");
  });

  it("refuses a duplicate provider id before writing anything", async () => {
    const paths = makeRoot();
    seedStore(paths, { dupe: richEntry("dupe", ["m1"]) });
    const svc = makeService(paths);
    const result = await svc.addProvider({ id: "dupe", baseURLs: "https://x.example.com", apiKey: "k" });
    assert.equal(result.ok, false);
    assert.match(result.error, /already exists/);
    assert.equal(existsSync(join(paths.credentialsDir, "dupe.dpapi")), false);
  });

  it("rejects an invalid provider id and an invalid baseURLs string", async () => {
    const paths = makeRoot();
    const svc = makeService(paths);
    const badId = await svc.addProvider({ id: "bad/id", baseURLs: "https://x.example.com", apiKey: "k" });
    assert.equal(badId.ok, false);
    const badUrl = await svc.addProvider({ id: "ok", baseURLs: "http://", apiKey: "k" });
    assert.equal(badUrl.ok, false);
  });
});

describe("store-service rotateProvider", () => {
  it("preserves discovered/modelFilter/models and rewrites the credential only with a new key", async () => {
    const paths = makeRoot();
    const entry = richEntry("prov", ["m1", "m2"]);
    entry.modelFilter = ["m2"];
    entry.models = { m2: { displayName: "m2" } };
    seedStore(paths, { prov: entry });
    writeCredential(paths, "prov", "sk-old");
    const svc = makeService(paths);

    const rotated = await svc.rotateProvider({ id: "prov", apiKey: "sk-new" });
    assert.equal(rotated.ok, true);
    const after = readStore(paths).store.providers.prov;
    assert.deepEqual(after.discovered, entry.discovered);
    assert.deepEqual(after.modelFilter, ["m2"]);
    assert.deepEqual(after.models, { m2: { displayName: "m2" } });
    assert.equal(readFileSync(join(paths.credentialsDir, "prov.dpapi"), "utf8"), "enc:sk-new");
    assert.equal(JSON.stringify(rotated).includes("sk-new"), false);
  });

  it("changes the URL group when asked and keeps it when baseURLs is empty", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1"], { fallbackURLs: ["https://b1.example.com"] }) });
    const svc = makeService(paths);

    const changed = await svc.rotateProvider({ id: "prov", baseURLs: "https://new.example.com/v1, https://b2.example.com" });
    assert.equal(changed.ok, true);
    let entry = readStore(paths).store.providers.prov;
    assert.equal(entry.baseURL, "https://new.example.com/v1");
    assert.deepEqual(entry.fallbackURLs, ["https://b2.example.com"]);

    const kept = await svc.rotateProvider({ id: "prov", apiKey: "k2", baseURLs: "" });
    assert.equal(kept.ok, true);
    entry = readStore(paths).store.providers.prov;
    assert.equal(entry.baseURL, "https://new.example.com/v1");
    assert.deepEqual(entry.fallbackURLs, ["https://b2.example.com"]);
  });

  it("refuses to change the built-in opencode endpoint", async () => {
    const paths = makeRoot();
    seedStore(paths, { opencode: richEntry("opencode", ["m1"]) });
    const svc = makeService(paths);
    const result = await svc.rotateProvider({ id: "opencode", baseURLs: "https://evil.example.com" });
    assert.equal(result.ok, false);
    assert.match(result.error, /opencode/);
    assert.equal(readStore(paths).store.providers.opencode.baseURL, "https://api.example.com/v1");
  });

  it("refuses a no-op rotate and an unknown provider", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1"]) });
    const svc = makeService(paths);
    const noop = await svc.rotateProvider({ id: "prov" });
    assert.equal(noop.ok, false);
    assert.match(noop.error, /nothing to rotate/);
    const unknown = await svc.rotateProvider({ id: "nope", apiKey: "k" });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /not managed/);
  });
});

describe("store-service testProvider", () => {
  it("verifies the stored credential against live /models without writing anything", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1"]) });
    writeCredential(paths, "prov");
    const before = readStore(paths).hash;
    const svc = makeService(paths);
    const result = await svc.testProvider("prov");
    assert.deepEqual(result, { ok: true, modelCount: 2 });
    assert.equal(readStore(paths).hash, before);
  });

  it("reports credential and discovery failures as ok:false", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1"]) });
    const svc = makeService(paths);
    const missing = await svc.testProvider("prov");
    assert.equal(missing.ok, false);
    assert.match(missing.error, /credential unavailable/);

    writeCredential(paths, "prov");
    const failing = makeService(paths, { fetchImpl: async () => { throw new Error("boom"); } });
    const result = await failing.testProvider("prov");
    assert.equal(result.ok, false);
  });
});

describe("store-service refreshProviders", () => {
  it("lazily migrates a legacy entry and applies discovered semantics", async () => {
    const paths = makeRoot();
    // Legacy entry: models only, no discovered/modelFilter.
    const legacy = {
      displayName: "prov",
      baseURL: "https://api.example.com/v1",
      protocol: "openai-compatible",
      credentialFile: "prov.dpapi",
      models: { "model-a": { displayName: "model-a" }, "model-old": { displayName: "model-old" } },
    };
    seedStore(paths, { prov: legacy });
    writeCredential(paths, "prov");
    const svc = makeService(paths); // discovers model-a + model-b

    const result = await svc.refreshProviders();
    assert.equal(result.ok, true);
    assert.equal(result.reports.length, 1);
    assert.equal(result.reports[0].status, "updated");
    assert.deepEqual(result.reports[0].added, ["model-b"]);
    assert.deepEqual(result.reports[0].pruned, ["model-old"]);
    const entry = readStore(paths).store.providers.prov;
    assert.deepEqual(Object.keys(entry.discovered).sort(), ["model-a", "model-b"]);
    // modelFilter was seeded from the legacy union, then models = discovered ∩ filter.
    assert.deepEqual(entry.modelFilter.sort(), ["model-a", "model-old"]);
    // models = discovered ∩ modelFilter: model-b is discovered but not yet
    // allow-listed (the seed keeps the legacy filter), model-old was pruned.
    assert.deepEqual(Object.keys(entry.models).sort(), ["model-a"]);
    // Upstream metadata enrichment landed on discovered.
    assert.equal(entry.discovered["model-a"].contextWindow, 8192);
  });

  it("never prunes on an empty upstream and reports it as failed", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1", "m2"]) });
    writeCredential(paths, "prov");
    const svc = makeService(paths, { fetchImpl: async () => modelsResponse([]) });
    const before = readStore(paths).hash;

    const result = await svc.refreshProviders("prov");
    assert.equal(result.ok, true);
    assert.equal(result.reports[0].status, "failed");
    assert.equal(result.reports[0].reason, "empty");
    assert.equal(readStore(paths).hash, before); // nothing written
  });

  it("a single provider failure does not interrupt the batch; opencode is skipped on refresh-all", async () => {
    const paths = makeRoot();
    seedStore(paths, {
      good: richEntry("good", ["m1"]),
      bad: richEntry("bad", ["m1"]),
      opencode: richEntry("opencode", ["m1"]),
    });
    writeCredential(paths, "good");
    // bad has no credential file → its discovery fails.
    const svc = makeService(paths);

    const result = await svc.refreshProviders();
    assert.equal(result.ok, true);
    assert.equal(result.anyFailed, true);
    const byId = Object.fromEntries(result.reports.map((r) => [r.providerId, r]));
    assert.equal(byId.good.status, "updated"); // m1 -> model-a/model-b
    assert.equal(byId.bad.status, "failed");
    assert.match(byId.bad.reason, /credential unavailable/);
    assert.equal(byId.opencode, undefined); // skipped, not even reported
  });

  it("surfaces a lost CAS race as cas-conflict", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1"]) });
    writeCredential(paths, "prov");
    const svc = makeService(paths, {
      writeStoreImpl: () => ({ ok: false, reason: "store changed since it was read" }),
    });
    const result = await svc.refreshProviders("prov");
    assert.equal(result.ok, false);
    assert.equal(result.error, "cas-conflict");
  });
});

describe("store-service saveFilter", () => {
  it("requires a discovered cache (refresh first) and a non-empty effective set", async () => {
    const paths = makeRoot();
    const legacy = {
      displayName: "prov",
      baseURL: "https://api.example.com/v1",
      protocol: "openai-compatible",
      credentialFile: "prov.dpapi",
      models: {},
    };
    seedStore(paths, { prov: legacy });
    const svc = makeService(paths);
    const result = await svc.saveFilter({ id: "prov", modelFilter: ["m1"] });
    assert.equal(result.ok, false);
    assert.match(result.error, /refresh first/);

    seedStore(paths, { prov: richEntry("prov", ["m1"]) });
    const empty = await svc.saveFilter({ id: "prov", modelFilter: ["nope"] });
    assert.equal(empty.ok, false);
    assert.match(empty.error, /enables no discovered model/);
  });

  it("materializes models from discovered ∩ modelFilter", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1", "m2", "m3"]) });
    const svc = makeService(paths);
    const result = await svc.saveFilter({ id: "prov", modelFilter: ["m2", "m3", "ghost"] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.effective, ["m2", "m3"]);
    const entry = readStore(paths).store.providers.prov;
    assert.deepEqual(entry.modelFilter, ["m2", "m3", "ghost"]);
    assert.deepEqual(Object.keys(entry.models).sort(), ["m2", "m3"]);
    assert.deepEqual(Object.keys(entry.discovered).sort(), ["m1", "m2", "m3"]); // untouched
  });

  it("is a no-op without a store write when the effective set is unchanged", async () => {
    const paths = makeRoot();
    const entry = richEntry("prov", ["m1", "m2"]);
    entry.modelFilter = ["m1"];
    entry.models = { m1: { displayName: "m1" } };
    seedStore(paths, { prov: entry });
    const before = readStore(paths).hash;
    const svc = makeService(paths);
    const result = await svc.saveFilter({ id: "prov", modelFilter: ["m1", "ghost"] });
    assert.equal(result.ok, true);
    assert.equal(result.noop, true);
    assert.equal(readStore(paths).hash, before);
  });

  it("lazily migrates a legacy entry on save and writes even when effective is unchanged", async () => {
    const paths = makeRoot();
    const legacy = {
      displayName: "prov",
      baseURL: "https://api.example.com/v1",
      protocol: "openai-compatible",
      credentialFile: "prov.dpapi",
      models: { m1: { displayName: "m1" } },
    };
    seedStore(paths, { prov: legacy });
    const svc = makeService(paths);
    const result = await svc.saveFilter({ id: "prov", modelFilter: ["m1"] });
    assert.equal(result.ok, true);
    assert.equal(result.noop, undefined);
    const entry = readStore(paths).store.providers.prov;
    assert.deepEqual(entry.modelFilter, ["m1"]);
    assert.deepEqual(Object.keys(entry.discovered), ["m1"]);
  });
});

describe("store-service addModels", () => {
  it("tags new ids manual:true, extends modelFilter, and CAS-writes re-materialized models", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1"]) });
    const svc = makeService(paths);

    const result = await svc.addModels("prov", [" m2 ", "m3", "m2"]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.added, ["m2", "m3"]);
    assert.deepEqual(result.models, ["m1", "m2", "m3"]);

    const entry = readStore(paths).store.providers.prov;
    assert.equal(entry.discovered.m2.manual, true);
    assert.equal(entry.discovered.m3.manual, true);
    assert.equal(entry.discovered.m1.manual, undefined);
    assert.deepEqual(entry.modelFilter, ["m1", "m2", "m3"]);
    assert.deepEqual(Object.keys(entry.models), ["m1", "m2", "m3"]);
  });

  it("lazily migrates a legacy entry before adding", async () => {
    const paths = makeRoot();
    const legacy = {
      displayName: "prov",
      baseURL: "https://api.example.com/v1",
      protocol: "openai-compatible",
      credentialFile: "prov.dpapi",
      models: { m1: { displayName: "m1" } },
    };
    seedStore(paths, { prov: legacy });
    const svc = makeService(paths);

    const result = await svc.addModels("prov", ["hand-one"]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.added, ["hand-one"]);
    const entry = readStore(paths).store.providers.prov;
    assert.deepEqual(Object.keys(entry.discovered).sort(), ["hand-one", "m1"]);
    assert.equal(entry.discovered["hand-one"].manual, true);
    assert.deepEqual(entry.modelFilter, ["m1", "hand-one"]);
    assert.deepEqual(Object.keys(entry.models).sort(), ["hand-one", "m1"]);
  });

  it("reports an unknown provider without writing", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1"]) });
    const before = readStore(paths).hash;
    const svc = makeService(paths);
    const result = await svc.addModels("nope", ["m2"]);
    assert.deepEqual(result, { ok: false, reason: "unknown-provider" });
    assert.equal(readStore(paths).hash, before);
  });

  it("rejects empty input and existing ids without writing", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1"]) });
    const before = readStore(paths).hash;
    const svc = makeService(paths);

    const empty = await svc.addModels("prov", ["  ", ""]);
    assert.deepEqual(empty, { ok: false, reason: "empty" });

    const dupe = await svc.addModels("prov", ["m1", "new-one"]);
    assert.equal(dupe.ok, false);
    assert.equal(dupe.reason, "model-exists");
    assert.deepEqual(dupe.duplicates, ["m1"]);

    assert.equal(readStore(paths).hash, before); // both rejected before any write
  });

  it("surfaces a lost CAS race as cas-conflict", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1"]) });
    const svc = makeService(paths, {
      writeStoreImpl: () => ({ ok: false, reason: "store changed since it was read" }),
    });
    const result = await svc.addModels("prov", ["m2"]);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "cas-conflict");
  });
});

describe("store-service removeModels", () => {
  it("removes manual and discovered ids, prunes modelFilter, and CAS-writes re-materialized models", async () => {
    const paths = makeRoot();
    const entry = richEntry("prov", ["m1", "m2", "hand"]);
    entry.discovered.hand.manual = true;
    seedStore(paths, { prov: entry });
    const svc = makeService(paths);

    const result = await svc.removeModels("prov", [" m2 ", "hand", "m2"]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.removed, ["m2", "hand"]);
    assert.deepEqual(result.models, ["m1"]);

    const next = readStore(paths).store.providers.prov;
    assert.deepEqual(Object.keys(next.discovered), ["m1"]);
    assert.deepEqual(next.modelFilter, ["m1"]);
    assert.deepEqual(Object.keys(next.models), ["m1"]);
  });

  it("reports an unknown provider without writing", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1"]) });
    const before = readStore(paths).hash;
    const svc = makeService(paths);
    const result = await svc.removeModels("nope", ["m1"]);
    assert.deepEqual(result, { ok: false, reason: "unknown-provider" });
    assert.equal(readStore(paths).hash, before);
  });

  it("rejects empty input and unknown ids wholesale without writing", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1", "m2"]) });
    const before = readStore(paths).hash;
    const svc = makeService(paths);

    const empty = await svc.removeModels("prov", ["  ", ""]);
    assert.deepEqual(empty, { ok: false, reason: "empty" });

    const missing = await svc.removeModels("prov", ["m1", "ghost"]);
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "model-not-found");
    assert.deepEqual(missing.missing, ["ghost"]);

    assert.equal(readStore(paths).hash, before); // both rejected before any write
  });

  it("surfaces a lost CAS race as cas-conflict", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1"]) });
    const svc = makeService(paths, {
      writeStoreImpl: () => ({ ok: false, reason: "store changed since it was read" }),
    });
    const result = await svc.removeModels("prov", ["m1"]);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "cas-conflict");
  });

  it("re-adds a removed discovered model to discovered (not modelFilter) on refresh", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1", "m2"]) });
    writeCredential(paths, "prov");
    // upstream keeps reporting both ids, including the one about to be removed
    const svc = makeService(paths, { fetchImpl: async () => modelsResponse(["m1", "m2"]) });

    const removal = await svc.removeModels("prov", ["m2"]);
    assert.equal(removal.ok, true);

    // the removed id returns to discovered on refresh, but stays out of
    // modelFilter/models (panel 未勾选)
    const refreshed = await svc.refreshProviders("prov");
    assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
    assert.equal(refreshed.reports[0].status, "updated");
    assert.deepEqual(refreshed.reports[0].added, ["m2"]);

    const next = readStore(paths).store.providers.prov;
    assert.deepEqual(Object.keys(next.discovered).sort(), ["m1", "m2"]);
    assert.deepEqual(Object.keys(next.models), ["m1"]);
    assert.deepEqual(next.modelFilter, ["m1"]);
  });
});

describe("store-service deleteProvider", () => {
  it("journals pending, removes the store entry, then deletes the credential last", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1", "m2"]) });
    writeCredential(paths, "prov");
    const svc = makeService(paths);

    const result = await svc.deleteProvider("prov");
    assert.equal(result.ok, true);
    assert.equal(result.deleted, true);
    assert.equal(result.modelCount, 2);
    assert.equal(Object.hasOwn(readStore(paths).store.providers, "prov"), false);
    assert.equal(existsSync(join(paths.credentialsDir, "prov.dpapi")), false);
    const journal = JSON.parse(readFileSync(join(paths.root, "delete-journal.json"), "utf8"));
    assert.deepEqual(journal.pending, []);
    assert.deepEqual(journal.completed.map((e) => e.providerId), ["prov"]);
  });

  it("aborts entirely and retains the credential when the store is unavailable", async () => {
    const paths = makeRoot();
    writeFileSync(paths.storeFile, "{ not json");
    writeCredential(paths, "prov");
    const svc = makeService(paths);
    const result = await svc.deleteProvider("prov");
    assert.equal(result.ok, false);
    assert.match(result.error, /unavailable/);
    assert.match(result.error, /credential retained/);
    assert.equal(existsSync(join(paths.credentialsDir, "prov.dpapi")), true);
  });

  it("surfaces cas-conflict from the store removal write", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1"]) });
    writeCredential(paths, "prov");
    const svc = makeService(paths, {
      writeStoreImpl: () => ({ ok: false, reason: "store changed since it was read" }),
    });
    const result = await svc.deleteProvider("prov");
    assert.equal(result.ok, false);
    assert.equal(result.error, "cas-conflict");
    assert.equal(existsSync(join(paths.credentialsDir, "prov.dpapi")), true);
  });

  it("getState resumes a pending journal deletion", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1"]) });
    writeCredential(paths, "prov");
    // Simulate a crash between the store removal and the credential removal:
    // store entry already gone, journal still pending, credential still on disk.
    const loaded = readStore(paths);
    const nextProviders = { ...loaded.store.providers };
    delete nextProviders.prov;
    writeStore({ ...loaded.store, providers: nextProviders }, { paths, expectedHash: loaded.hash });
    writeFileSync(
      join(paths.root, "delete-journal.json"),
      JSON.stringify({ pending: [{ providerId: "prov", credentialFile: "prov.dpapi", recordedAt: "x" }], completed: [] }),
    );

    const svc = makeService(paths);
    const state = await svc.getState();
    assert.equal(state.ok, true);
    assert.deepEqual(state.resumeResult.resumed, ["prov"]);
    assert.equal(existsSync(join(paths.credentialsDir, "prov.dpapi")), false);
    const journal = JSON.parse(readFileSync(join(paths.root, "delete-journal.json"), "utf8"));
    assert.deepEqual(journal.pending, []);
    assert.deepEqual(journal.completed.map((e) => e.providerId), ["prov"]);
  });

  it("refuses to delete through an unsafe credential path", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1"]) });
    // A directory where the credential file should be: lstat says not-a-file.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(paths.credentialsDir, "prov.dpapi"));
    const svc = makeService(paths);
    const result = await svc.deleteProvider("prov");
    assert.equal(result.ok, false);
    assert.match(result.error, /unsafe|retained/);
  });
});

describe("store-service getState", () => {
  it("aggregates provider metadata without any secret material", async () => {
    const paths = makeRoot();
    const entry = richEntry("prov", ["m1", "m2", "m3"]);
    entry.modelFilter = ["m1", "m2"];
    entry.models = { m1: { displayName: "m1" }, m2: { displayName: "m2" } };
    seedStore(paths, { prov: entry, empty: richEntry("empty", ["x"], { modelFilter: [], models: {} }) });
    writeCredential(paths, "prov");
    const svc = makeService(paths);

    const state = await svc.getState();
    assert.equal(state.ok, true);
    assert.equal(state.storeOk, true);
    assert.equal(typeof state.hash, "string");
    const prov = state.providers.find((p) => p.id === "prov");
    assert.equal(prov.modelCount, 2);
    assert.equal(prov.discoveredCount, 3);
    assert.equal(prov.filterCount, 2);
    assert.equal(prov.hasCredential, true);
    // The full entry payloads power the filter editor (no secrets by schema).
    assert.deepEqual(Object.keys(prov.models).sort(), ["m1", "m2"]);
    assert.deepEqual(prov.modelFilter, ["m1", "m2"]);
    assert.deepEqual(Object.keys(prov.discovered).sort(), ["m1", "m2", "m3"]);
    assert.equal(JSON.stringify(state).includes("sk-"), false);
    const empty = state.providers.find((p) => p.id === "empty");
    assert.equal(empty.filterCount, 0);
    assert.equal(empty.hasCredential, false);
  });

  it("reports storeOk:false with no providers when the store is unreadable", async () => {
    const paths = makeRoot();
    writeFileSync(paths.storeFile, "{ not json");
    const svc = makeService(paths);
    const state = await svc.getState();
    assert.equal(state.ok, true);
    assert.equal(state.storeOk, false);
    assert.deepEqual(state.providers, []);
    assert.equal(state.storeError, "store-unparsable");
  });
});

describe("store-service getBoardState", () => {
  it("returns routingChains + id→displayName maps, no models/discovered/modelFilter payloads", async () => {
    const paths = makeRoot();
    seedStore(paths, {
      "prov-a": richEntry("prov-a", ["m1", "m2"]),
      "prov-b": richEntry("prov-b", ["m2", "m3"]),
    }, {
      pools: { "pool-x": { displayName: "主号池", members: ["prov-a", "prov-b"] } },
    });
    const svc = makeService(paths);
    const chain = [{ node: "pool-x", model: "m1" }];
    assert.equal((await svc.saveRouteChain("claude", chain)).ok, true);

    const state = await svc.getBoardState();
    assert.equal(state.ok, true);
    assert.equal(state.storeOk, true);
    assert.deepEqual(state.routingChains, [{ endpointId: "claude", chain, enabled: true }]);
    assert.deepEqual(state.providerNames, { "prov-a": "prov-a", "prov-b": "prov-b" });
    assert.deepEqual(state.poolNames, { "pool-x": "主号池" });
    // 裁剪形状：只有这六个键，不存在 providers/models/discovered/modelFilter 全量 payload。
    assert.deepEqual(Object.keys(state).sort(), ["hash", "ok", "poolNames", "providerNames", "routingChains", "storeOk"]);
    assert.equal(JSON.stringify(state).includes("modelFilter"), false);
  });

  it("enabled 口径与 getState 一致（absent = 开，显式 false 下发 false）", async () => {
    const paths = makeRoot();
    seedStore(paths, { "prov-a": richEntry("prov-a", ["m1"]) });
    const svc = makeService(paths);
    const chain = [{ node: "prov-a", model: "m1" }];
    assert.equal((await svc.saveRouteChain("claude", chain)).ok, true);

    let board = await svc.getBoardState();
    assert.equal(board.routingChains[0].enabled, true);

    assert.equal((await svc.setRouteChainEnabled("claude", false)).ok, true);
    board = await svc.getBoardState();
    const full = await svc.getState();
    assert.equal(board.routingChains[0].enabled, false);
    assert.equal(board.routingChains[0].enabled, full.routingChains[0].enabled);
  });

  it("reports storeOk:false with empty maps when the store is unreadable (恒 ok:true)", async () => {
    const paths = makeRoot();
    writeFileSync(paths.storeFile, "{ not json");
    const svc = makeService(paths);
    const state = await svc.getBoardState();
    assert.equal(state.ok, true);
    assert.equal(state.storeOk, false);
    assert.equal(state.storeError, "store-unparsable");
    assert.deepEqual(state.routingChains, []);
    assert.deepEqual(state.providerNames, {});
    assert.deepEqual(state.poolNames, {});
  });

  it("triggers resumeDeletions fire-and-forget: 不进响应、不阻塞，但最终完成", async () => {
    const paths = makeRoot();
    seedStore(paths, { prov: richEntry("prov", ["m1"]) });
    writeCredential(paths, "prov");
    // Same crash-between-steps fixture as the getState resume test: store entry
    // gone, journal pending, credential still on disk.
    const loaded = readStore(paths);
    const nextProviders = { ...loaded.store.providers };
    delete nextProviders.prov;
    writeStore({ ...loaded.store, providers: nextProviders }, { paths, expectedHash: loaded.hash });
    writeFileSync(
      join(paths.root, "delete-journal.json"),
      JSON.stringify({ pending: [{ providerId: "prov", credentialFile: "prov.dpapi", recordedAt: "x" }], completed: [] }),
    );

    const svc = makeService(paths);
    const state = await svc.getBoardState();
    assert.equal(state.ok, true);
    assert.equal("resumeResult" in state, false, "resume 结果不进响应");
    const credentialPath = join(paths.credentialsDir, "prov.dpapi");
    // Fire-and-forget: the response already returned; the resume finishes later.
    for (let i = 0; i < 500 && existsSync(credentialPath); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(credentialPath), false, "fire-and-forget resume 最终删除残留凭据");
  });
});

describe("store-service pools (号池)", () => {
  function poolSeed(paths) {
    seedStore(paths, {
      "prov-a": richEntry("prov-a", ["m1", "m2"]),
      "prov-b": richEntry("prov-b", ["m2", "m3"]),
      "prov-c": richEntry("prov-c", ["m4"]),
    });
  }

  it("createPool writes the top-level pools map and getState reports membership", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);

    const result = await svc.createPool({ poolId: "pool-x", displayName: "主号池", members: ["prov-a", "prov-b"] });
    assert.equal(result.ok, true, result.error);
    const stored = readStore(paths).store;
    assert.deepEqual(stored.pools, { "pool-x": { displayName: "主号池", members: ["prov-a", "prov-b"] } });

    const state = await svc.getState();
    assert.deepEqual(state.pools, [{ id: "pool-x", displayName: "主号池", members: ["prov-a", "prov-b"] }]);
    assert.equal(state.providers.find((p) => p.id === "prov-a").poolId, "pool-x");
    assert.equal(state.providers.find((p) => p.id === "prov-b").poolId, "pool-x");
    assert.equal(state.providers.find((p) => p.id === "prov-c").poolId, null);
    assert.equal(JSON.stringify(state).includes("sk-"), false);
  });

  it("createPool rejects more than 5 members with the recognizable message", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    const result = await svc.createPool({
      poolId: "pool-x",
      displayName: "x",
      members: ["prov-a", "prov-b", "prov-c", "prov-a", "prov-b", "prov-c"],
    });
    // 6 entries (with duplicates) trips the count gate before dedupe.
    assert.equal(result.ok, false);
    assert.match(result.error, /最多联立 5 个渠道/);
  });

  it("createPool rejects fewer than 2 members", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    const result = await svc.createPool({ poolId: "pool-x", displayName: "x", members: ["prov-a"] });
    assert.equal(result.ok, false);
    assert.match(result.error, /至少 2 个/);
  });

  it("createPool rejects an id colliding with a non-member provider (case-insensitive)", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    const result = await svc.createPool({ poolId: "PROV-A", displayName: "x", members: ["prov-b", "prov-c"] });
    assert.equal(result.ok, false);
    assert.match(result.error, /differs only by case|collides/);
  });

  it("createPool accepts an id reusing one of its own members' ids", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    const result = await svc.createPool({ poolId: "prov-a", displayName: "收编池", members: ["prov-a", "prov-b"] });
    assert.equal(result.ok, true, result.error);
    const state = await svc.getState();
    assert.equal(state.providers.find((p) => p.id === "prov-a").poolId, "prov-a");
    const caseVariant = await svc.createPool({ poolId: "PROV-C", displayName: "y", members: ["prov-c", "prov-a"] });
    assert.equal(caseVariant.ok, false);
    assert.match(caseVariant.error, /already belongs to pool/);
  });

  it("createPool rejects unknown and already-pooled members", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    assert.equal((await svc.createPool({ poolId: "p1", displayName: "x", members: ["prov-a", "ghost"] })).ok, false);
    const first = await svc.createPool({ poolId: "p1", displayName: "x", members: ["prov-a", "prov-b"] });
    assert.equal(first.ok, true, first.error);
    const second = await svc.createPool({ poolId: "p2", displayName: "y", members: ["prov-b", "prov-c"] });
    assert.equal(second.ok, false);
    assert.match(second.error, /already belongs to pool/);
  });

  it("createPool rejects the built-in opencode provider as a member", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const loaded = readStore(paths);
    const next = structuredClone(loaded.store);
    next.providers.opencode = richEntry("opencode", ["oc"]);
    writeStore(next, { paths, expectedHash: loaded.hash });
    const svc = makeService(paths);
    const result = await svc.createPool({ poolId: "p1", displayName: "x", members: ["prov-a", "opencode"] });
    assert.equal(result.ok, false);
    assert.match(result.error, /opencode/);
  });

  it("createPool surfaces cas-conflict from the store write", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths, {
      writeStoreImpl: () => ({ ok: false, reason: "store changed since it was read" }),
    });
    const result = await svc.createPool({ poolId: "p1", displayName: "x", members: ["prov-a", "prov-b"] });
    assert.equal(result.ok, false);
    assert.equal(result.error, "cas-conflict");
  });

  it("updatePoolMembers adds a member and reorders, persisting the full ordered list", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    await svc.createPool({ poolId: "pool-x", displayName: "主号池", members: ["prov-a", "prov-b"] });

    const result = await svc.updatePoolMembers({ poolId: "pool-x", members: ["prov-c", "prov-a", "prov-b"] });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.poolId, "pool-x");
    const stored = readStore(paths).store;
    // displayName 不动，members 整体替换为新顺序
    assert.deepEqual(stored.pools["pool-x"], { displayName: "主号池", members: ["prov-c", "prov-a", "prov-b"] });
    const state = await svc.getState();
    assert.deepEqual(state.pools.find((p) => p.id === "pool-x").members, ["prov-c", "prov-a", "prov-b"]);
    assert.equal(state.providers.find((p) => p.id === "prov-c").poolId, "pool-x");
  });

  it("updatePoolMembers accepts a pure reorder of the same members", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    await svc.createPool({ poolId: "pool-x", displayName: "主号池", members: ["prov-a", "prov-b"] });

    const result = await svc.updatePoolMembers({ poolId: "pool-x", members: ["prov-b", "prov-a"] });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(readStore(paths).store.pools["pool-x"].members, ["prov-b", "prov-a"]);
  });

  it("updatePoolMembers rejects an unknown pool", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    const result = await svc.updatePoolMembers({ poolId: "nope", members: ["prov-a", "prov-b"] });
    assert.equal(result.ok, false);
    assert.match(result.error, /does not exist/);
  });

  it("updatePoolMembers rejects growing past 5 members (existing 3 + new 3)", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    await svc.createPool({ poolId: "pool-x", displayName: "x", members: ["prov-a", "prov-b", "prov-c"] });
    const result = await svc.updatePoolMembers({
      poolId: "pool-x",
      members: ["prov-a", "prov-b", "prov-c", "prov-d", "prov-e", "prov-f"],
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /最多联立 5 个渠道/);
    // 拒绝后落盘内容不变
    assert.deepEqual(readStore(paths).store.pools["pool-x"].members, ["prov-a", "prov-b", "prov-c"]);
  });

  it("updatePoolMembers rejects shrinking below 2 members", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    await svc.createPool({ poolId: "pool-x", displayName: "x", members: ["prov-a", "prov-b"] });
    const result = await svc.updatePoolMembers({ poolId: "pool-x", members: ["prov-a"] });
    assert.equal(result.ok, false);
    assert.match(result.error, /至少 2 个/);
    assert.deepEqual(readStore(paths).store.pools["pool-x"].members, ["prov-a", "prov-b"]);
  });

  it("updatePoolMembers rejects unknown candidate providers", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    await svc.createPool({ poolId: "pool-x", displayName: "x", members: ["prov-a", "prov-b"] });
    const result = await svc.updatePoolMembers({ poolId: "pool-x", members: ["prov-a", "prov-b", "ghost"] });
    assert.equal(result.ok, false);
    assert.match(result.error, /not managed/);
  });

  it("updatePoolMembers rejects the built-in opencode provider as a member", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const loaded = readStore(paths);
    const next = structuredClone(loaded.store);
    next.providers.opencode = richEntry("opencode", ["oc"]);
    writeStore(next, { paths, expectedHash: loaded.hash });
    const svc = makeService(paths);
    await svc.createPool({ poolId: "pool-x", displayName: "x", members: ["prov-a", "prov-b"] });
    const result = await svc.updatePoolMembers({ poolId: "pool-x", members: ["prov-a", "opencode"] });
    assert.equal(result.ok, false);
    assert.match(result.error, /opencode/);
  });

  it("updatePoolMembers rejects a candidate already in another pool", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const loaded = readStore(paths);
    const next = structuredClone(loaded.store);
    next.providers["prov-d"] = richEntry("prov-d", ["m9"]);
    writeStore(next, { paths, expectedHash: loaded.hash });
    const svc = makeService(paths);
    await svc.createPool({ poolId: "pool-x", displayName: "x", members: ["prov-a", "prov-b"] });
    await svc.createPool({ poolId: "pool-y", displayName: "y", members: ["prov-c", "prov-d"] });

    const result = await svc.updatePoolMembers({ poolId: "pool-x", members: ["prov-a", "prov-c"] });
    assert.equal(result.ok, false);
    assert.match(result.error, /already belongs to pool "pool-y"/);
    // 本池既有成员不在拒绝范围内：pool-y 自己调序不受影响
    const reorder = await svc.updatePoolMembers({ poolId: "pool-y", members: ["prov-d", "prov-c"] });
    assert.equal(reorder.ok, true, reorder.error);
  });

  it("updatePoolMembers rejects duplicates within the member list", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    await svc.createPool({ poolId: "pool-x", displayName: "x", members: ["prov-a", "prov-b"] });
    const result = await svc.updatePoolMembers({ poolId: "pool-x", members: ["prov-a", "prov-a"] });
    assert.equal(result.ok, false);
    assert.match(result.error, /duplicates/);
  });

  it("updatePoolMembers surfaces cas-conflict from the store write", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    await svc.createPool({ poolId: "pool-x", displayName: "x", members: ["prov-a", "prov-b"] });
    const failing = makeService(paths, {
      writeStoreImpl: () => ({ ok: false, reason: "store changed since it was read" }),
    });
    const result = await failing.updatePoolMembers({ poolId: "pool-x", members: ["prov-b", "prov-a"] });
    assert.equal(result.ok, false);
    assert.equal(result.error, "cas-conflict");
  });

  it("deletePool dissolves the pool and keeps member providers untouched", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    await svc.createPool({ poolId: "pool-x", displayName: "主号池", members: ["prov-a", "prov-b"] });

    const result = await svc.deletePool("pool-x");
    assert.equal(result.ok, true, result.error);
    const stored = readStore(paths).store;
    assert.equal(Object.hasOwn(stored, "pools"), false, "empty pools map is dropped");
    assert.deepEqual(Object.keys(stored.providers).sort(), ["prov-a", "prov-b", "prov-c"]);
    const state = await svc.getState();
    assert.deepEqual(state.pools, []);
    assert.equal(state.providers.find((p) => p.id === "prov-a").poolId, null);
  });

  it("deletePool rejects an unknown pool", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    const result = await svc.deletePool("nope");
    assert.equal(result.ok, false);
    assert.match(result.error, /does not exist/);
  });

  it("deleteProvider refuses a pooled provider until the pool is dissolved", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    writeCredential(paths, "prov-a");
    const svc = makeService(paths);
    await svc.createPool({ poolId: "pool-x", displayName: "主号池", members: ["prov-a", "prov-b"] });

    const blocked = await svc.deleteProvider("prov-a");
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /belongs to pool "pool-x"/);
    assert.equal(existsSync(join(paths.credentialsDir, "prov-a.dpapi")), true);
    assert.equal(Object.hasOwn(readStore(paths).store.providers, "prov-a"), true);
    // 业务拒绝不得留下 journal pending——否则 resumeDeletions 会在解池后重放删除
    const journalPath = join(paths.root, "delete-journal.json");
    const journal = existsSync(journalPath)
      ? JSON.parse(readFileSync(journalPath, "utf8"))
      : { pending: [] };
    assert.deepEqual(journal.pending, []);

    // 解池后的 getState（内部跑 resumeDeletions）不得顺手删掉 prov-a
    await svc.deletePool("pool-x");
    const state = await svc.getState();
    assert.deepEqual(state.resumeResult.resumed, []);
    assert.equal(Object.hasOwn(readStore(paths).store.providers, "prov-a"), true);
    assert.equal(existsSync(join(paths.credentialsDir, "prov-a.dpapi")), true);

    const freed = await svc.deleteProvider("prov-a");
    assert.equal(freed.ok, true, freed.error);
    assert.equal(Object.hasOwn(readStore(paths).store.providers, "prov-a"), false);
  });

  it("getState reports pools:[] when the store is unreadable", async () => {
    const paths = makeRoot();
    writeFileSync(paths.storeFile, "{ not json");
    const svc = makeService(paths);
    const state = await svc.getState();
    assert.equal(state.storeOk, false);
    assert.deepEqual(state.pools, []);
  });

  it("renameProvider updates displayName only and getState reflects it", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);

    const result = await svc.renameProvider("prov-a", "  新名字  ");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.displayName, "新名字");
    const stored = readStore(paths).store;
    assert.equal(stored.providers["prov-a"].displayName, "新名字");
    // id/baseURL/models 等其余字段原样保留
    assert.equal(stored.providers["prov-a"].baseURL, richEntry("prov-a", ["m1", "m2"]).baseURL);
    assert.deepEqual(Object.keys(stored.providers["prov-a"].models), ["m1", "m2"]);

    const state = await svc.getState();
    assert.equal(state.providers.find((p) => p.id === "prov-a").displayName, "新名字");
  });

  it("renameProvider rejects an empty name and an unknown provider", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    assert.match((await svc.renameProvider("prov-a", "   ")).error, /non-empty/);
    assert.equal((await svc.renameProvider("ghost", "x")).ok, false);
    assert.match((await svc.renameProvider("ghost", "x")).error, /not managed/);
    assert.equal(readStore(paths).store.providers["prov-a"].displayName, "prov-a");
  });

  it("renameProvider surfaces cas-conflict from the store write", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths, {
      writeStoreImpl: () => ({ ok: false, reason: "store changed since it was read" }),
    });
    const result = await svc.renameProvider("prov-a", "x");
    assert.equal(result.ok, false);
    assert.equal(result.error, "cas-conflict");
  });

  it("renamePool updates displayName only and keeps members untouched", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    await svc.createPool({ poolId: "pool-x", displayName: "主号池", members: ["prov-a", "prov-b"] });

    const result = await svc.renamePool("pool-x", "备用号池");
    assert.equal(result.ok, true, result.error);
    const stored = readStore(paths).store;
    assert.deepEqual(stored.pools["pool-x"], { displayName: "备用号池", members: ["prov-a", "prov-b"] });
    const state = await svc.getState();
    assert.equal(state.pools.find((p) => p.id === "pool-x").displayName, "备用号池");
  });

  it("renamePool rejects an empty name and an unknown pool", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    await svc.createPool({ poolId: "pool-x", displayName: "主号池", members: ["prov-a", "prov-b"] });
    assert.match((await svc.renamePool("pool-x", "")).error, /non-empty/);
    assert.match((await svc.renamePool("nope", "x")).error, /does not exist/);
    assert.equal(readStore(paths).store.pools["pool-x"].displayName, "主号池");
  });

  it("renamePool surfaces cas-conflict from the store write", async () => {
    const paths = makeRoot();
    poolSeed(paths);
    const svc = makeService(paths);
    await svc.createPool({ poolId: "pool-x", displayName: "主号池", members: ["prov-a", "prov-b"] });
    const failing = makeService(paths, {
      writeStoreImpl: () => ({ ok: false, reason: "store changed since it was read" }),
    });
    const result = await failing.renamePool("pool-x", "x");
    assert.equal(result.ok, false);
    assert.equal(result.error, "cas-conflict");
  });
});

describe("store-service routingChains (自动路由)", () => {
  function chainSeed(paths) {
    seedStore(paths, {
      "prov-a": richEntry("prov-a", ["m1", "m2"]),
      "prov-b": richEntry("prov-b", ["m2", "m3"]),
      "prov-c": richEntry("prov-c", ["m4"]),
    }, {
      pools: { "pool-x": { displayName: "主号池", members: ["prov-a", "prov-b"] } },
    });
  }

  it("saveRouteChain writes {node,model} entries and getState reports them", async () => {
    const paths = makeRoot();
    chainSeed(paths);
    const svc = makeService(paths);
    const chain = [
      { node: "pool-x", model: "m1" },
      { node: "prov-c", model: "m4" },
    ];

    const result = await svc.saveRouteChain("claude", chain);
    assert.equal(result.ok, true, result.error);
    const stored = readStore(paths).store;
    assert.deepEqual(stored.routingChains, { claude: { chain } });

    const state = await svc.getState();
    assert.deepEqual(state.routingChains, [{ endpointId: "claude", chain, enabled: true }]);
    assert.equal(JSON.stringify(state).includes("sk-"), false);
  });

  it("saveRouteChain accepts the same node multiple times with different models", async () => {
    const paths = makeRoot();
    chainSeed(paths);
    const svc = makeService(paths);
    // 复合键去重：同 node 不同 model 可多次入链；同 node+model 才算重复。
    const chain = [
      { node: "prov-a", model: "m1" },
      { node: "prov-a", model: "m2" },
      { node: "pool-x", model: "m1" },
    ];
    const result = await svc.saveRouteChain("claude", chain);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(readStore(paths).store.routingChains, { claude: { chain } });
  });

  it("saveRouteChain replaces an existing chain and keeps other endpoints' chains", async () => {
    const paths = makeRoot();
    chainSeed(paths);
    const svc = makeService(paths);
    await svc.saveRouteChain("claude", [{ node: "prov-a", model: "m1" }]);
    await svc.saveRouteChain("kimi", [{ node: "prov-b", model: "m2" }]);
    const next = [
      { node: "prov-c", model: "m4" },
      { node: "pool-x", model: "m3" },
    ];

    const result = await svc.saveRouteChain("claude", next);
    assert.equal(result.ok, true, result.error);
    const stored = readStore(paths).store;
    assert.deepEqual(stored.routingChains, {
      claude: { chain: next },
      kimi: { chain: [{ node: "prov-b", model: "m2" }] },
    });
  });

  it("saveRouteChain rejects invalid input before touching the store", async () => {
    const paths = makeRoot(); // no store.json at all: any load would fail "store-absent"
    const svc = makeService(paths);
    assert.match((await svc.saveRouteChain("cursor", [{ node: "prov-a", model: "m1" }])).error, /unknown endpoint/i);
    assert.match((await svc.saveRouteChain("claude", [])).error, /non-empty/i);
    assert.match((await svc.saveRouteChain("claude", "prov-a")).error, /array/i);
    // 元素必须是 { node, model } 对象
    assert.match((await svc.saveRouteChain("claude", ["prov-a"])).error, /must be an object|\{ node, model \}/i);
    assert.match((await svc.saveRouteChain("claude", [{ node: "prov-a" }])).error, /model/i);
    assert.match((await svc.saveRouteChain("claude", [{ model: "m1" }])).error, /node/i);
    assert.match((await svc.saveRouteChain("claude", [{ node: "prov-a", model: "  " }])).error, /model/i);
    // 同 node 不同 model 合法（复合键去重）；同 node+model 出现两次即重复
    const dup = [
      { node: "prov-a", model: "m1" },
      { node: "prov-a", model: "m1" },
    ];
    assert.match((await svc.saveRouteChain("claude", dup)).error, /duplicate/i);
    // 同 node 不同 model 不触发重复校验（之后的失败来自 store-absent，而非去重）
    const sameNode = [
      { node: "prov-a", model: "m1" },
      { node: "prov-a", model: "m2" },
    ];
    assert.doesNotMatch((await svc.saveRouteChain("claude", sameNode)).error, /duplicate/i);
    assert.match((await svc.saveRouteChain("claude", [{ node: "bad/id", model: "m1" }])).error, /letters, digits/i);
    const tooMany = Array.from({ length: MAX_CHAIN_NODES + 1 }, (_, i) => ({ node: `n${i + 1}`, model: "m" }));
    assert.match((await svc.saveRouteChain("claude", tooMany)).error, new RegExp(`最多 ${MAX_CHAIN_NODES} 个节点`));
    // 恰好 MAX_CHAIN_NODES 个节点不触发链长校验（之后的失败来自 store-absent，而非长度）
    const exact = Array.from({ length: MAX_CHAIN_NODES }, (_, i) => ({ node: `n${i + 1}`, model: "m" }));
    assert.doesNotMatch((await svc.saveRouteChain("claude", exact)).error, /最多/);
    assert.equal(existsSync(paths.storeFile), false, "validation failures must not create the store");
  });

  it("saveRouteChain rejects nodes that are neither provider nor pool", async () => {
    const paths = makeRoot();
    chainSeed(paths);
    const svc = makeService(paths);
    const result = await svc.saveRouteChain("claude", [
      { node: "prov-a", model: "m1" },
      { node: "ghost", model: "m1" },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.error, /ghost/);
    assert.equal(Object.hasOwn(readStore(paths).store, "routingChains"), false);
  });

  it("saveRouteChain does NOT validate the bound model against the node catalog", async () => {
    const paths = makeRoot();
    chainSeed(paths);
    const svc = makeService(paths);
    // 目录随 discovered 刷新变化，硬校验会被刷新打破——这里 "no-such-model" 必须能存。
    const result = await svc.saveRouteChain("claude", [{ node: "prov-a", model: "no-such-model" }]);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(readStore(paths).store.routingChains.claude.chain, [{ node: "prov-a", model: "no-such-model" }]);
  });

  it("saveRouteChain surfaces cas-conflict from the store write", async () => {
    const paths = makeRoot();
    chainSeed(paths);
    const svc = makeService(paths, {
      writeStoreImpl: () => ({ ok: false, reason: "store changed since it was read" }),
    });
    const result = await svc.saveRouteChain("claude", [{ node: "prov-a", model: "m1" }]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "cas-conflict");
  });

  it("deleteRouteChain removes the chain and drops an empty routingChains map", async () => {
    const paths = makeRoot();
    chainSeed(paths);
    const svc = makeService(paths);
    await svc.saveRouteChain("claude", [{ node: "prov-a", model: "m1" }]);

    const result = await svc.deleteRouteChain("claude");
    assert.equal(result.ok, true, result.error);
    const stored = readStore(paths).store;
    assert.equal(Object.hasOwn(stored, "routingChains"), false, "empty routingChains map is dropped");
    const state = await svc.getState();
    assert.deepEqual(state.routingChains, []);
  });

  it("deleteRouteChain keeps other endpoints' chains", async () => {
    const paths = makeRoot();
    chainSeed(paths);
    const svc = makeService(paths);
    await svc.saveRouteChain("claude", [{ node: "prov-a", model: "m1" }]);
    await svc.saveRouteChain("kimi", [{ node: "prov-b", model: "m2" }]);

    const result = await svc.deleteRouteChain("claude");
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(readStore(paths).store.routingChains, { kimi: { chain: [{ node: "prov-b", model: "m2" }] } });
  });

  it("deleteRouteChain rejects an unknown endpoint and an endpoint without a chain", async () => {
    const paths = makeRoot();
    chainSeed(paths);
    const svc = makeService(paths);
    assert.match((await svc.deleteRouteChain("cursor")).error, /unknown endpoint/i);
    const result = await svc.deleteRouteChain("claude");
    assert.equal(result.ok, false);
    assert.match(result.error, /does not exist/);
  });

  it("deleteRouteChain surfaces cas-conflict from the store write", async () => {
    const paths = makeRoot();
    chainSeed(paths);
    const svc = makeService(paths);
    await svc.saveRouteChain("claude", [{ node: "prov-a", model: "m1" }]);
    const failing = makeService(paths, {
      writeStoreImpl: () => ({ ok: false, reason: "store changed since it was read" }),
    });
    const result = await failing.deleteRouteChain("claude");
    assert.equal(result.ok, false);
    assert.equal(result.error, "cas-conflict");
  });

  it("getState reports routingChains:[] when the store is unreadable", async () => {
    const paths = makeRoot();
    writeFileSync(paths.storeFile, "{ not json");
    const svc = makeService(paths);
    const state = await svc.getState();
    assert.equal(state.storeOk, false);
    assert.deepEqual(state.routingChains, []);
  });
});

describe("store-service routingChains enabled 开关（自动路由 per-endpoint 启用）", () => {
  function chainSeed(paths) {
    seedStore(paths, {
      "prov-a": richEntry("prov-a", ["m1", "m2"]),
    });
  }

  it("getState 缺省把已配链报告为 enabled: true（向后兼容存量链）", async () => {
    const paths = makeRoot();
    chainSeed(paths);
    const svc = makeService(paths);
    const chain = [{ node: "prov-a", model: "m1" }];
    await svc.saveRouteChain("claude", chain);
    const state = await svc.getState();
    assert.deepEqual(state.routingChains, [{ endpointId: "claude", chain, enabled: true }]);
  });

  it("setRouteChainEnabled(false) 持久化 enabled:false，getState 同步口径，且可再开回", async () => {
    const paths = makeRoot();
    chainSeed(paths);
    const svc = makeService(paths);
    await svc.saveRouteChain("claude", [{ node: "prov-a", model: "m1" }]);

    const off = await svc.setRouteChainEnabled("claude", false);
    assert.equal(off.ok, true, off.error);
    assert.equal(readStore(paths).store.routingChains.claude.enabled, false);
    let state = await svc.getState();
    assert.equal(state.routingChains[0].enabled, false);

    const on = await svc.setRouteChainEnabled("claude", true);
    assert.equal(on.ok, true, on.error);
    assert.equal(readStore(paths).store.routingChains.claude.enabled, true);
    state = await svc.getState();
    assert.equal(state.routingChains[0].enabled, true);
  });

  it("setRouteChainEnabled 拒绝未知端点 / 未配链端点 / 非布尔值", async () => {
    const paths = makeRoot();
    chainSeed(paths);
    const svc = makeService(paths);
    assert.match((await svc.setRouteChainEnabled("cursor", true)).error, /unknown endpoint/i);
    assert.match((await svc.setRouteChainEnabled("claude", true)).error, /does not exist/i);
    await svc.saveRouteChain("claude", [{ node: "prov-a", model: "m1" }]);
    assert.match((await svc.setRouteChainEnabled("claude", "yes")).error, /boolean/i);
    assert.equal(readStore(paths).store.routingChains.claude.enabled, undefined,
      "失败的开关写入不得落盘");
  });

  it("saveRouteChain 重存链时保留既有 enabled 标志（编辑链不把开关弹回开）", async () => {
    const paths = makeRoot();
    chainSeed(paths);
    const svc = makeService(paths);
    await svc.saveRouteChain("claude", [{ node: "prov-a", model: "m1" }]);
    await svc.setRouteChainEnabled("claude", false);

    const next = [{ node: "prov-a", model: "m2" }];
    const result = await svc.saveRouteChain("claude", next);
    assert.equal(result.ok, true, result.error);
    const entry = readStore(paths).store.routingChains.claude;
    assert.deepEqual(entry.chain, next);
    assert.equal(entry.enabled, false, "重存链必须保留 enabled:false");
  });
});

describe("store-service reorderProviders (渠道排序)", () => {
  function orderSeed(paths) {
    seedStore(paths, {
      "prov-a": richEntry("prov-a", ["m1"]),
      "prov-b": richEntry("prov-b", ["m2"]),
      "prov-c": richEntry("prov-c", ["m3"]),
      "prov-d": richEntry("prov-d", ["m4"]),
    });
  }

  it("按 order 重写 providers 插入序，getState 顺序同步变化", async () => {
    const paths = makeRoot();
    orderSeed(paths);
    const svc = makeService(paths);

    const result = await svc.reorderProviders(["prov-c", "prov-a", "prov-d", "prov-b"]);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(Object.keys(readStore(paths).store.providers), ["prov-c", "prov-a", "prov-d", "prov-b"]);
    const state = await svc.getState();
    assert.deepEqual(state.providers.map((p) => p.id), ["prov-c", "prov-a", "prov-d", "prov-b"]);
    // 同 key 同值仅换序：条目内容不被改动
    assert.equal(readStore(paths).store.providers["prov-a"].displayName, "prov-a");
  });

  it("拒绝缺 id / 多 id / 重复 id，且不落盘", async () => {
    const paths = makeRoot();
    orderSeed(paths);
    const svc = makeService(paths);
    const beforeHash = readStore(paths).hash;

    const missing = await svc.reorderProviders(["prov-a", "prov-b", "prov-c"]);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /permutation|order/);
    const extra = await svc.reorderProviders(["prov-a", "prov-b", "prov-c", "prov-d", "ghost"]);
    assert.equal(extra.ok, false);
    const duplicate = await svc.reorderProviders(["prov-a", "prov-b", "prov-c", "prov-c"]);
    assert.equal(duplicate.ok, false);
    const unknown = await svc.reorderProviders(["prov-a", "prov-b", "prov-c", "ghost"]);
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /not managed/);

    assert.equal(readStore(paths).hash, beforeHash, "拒绝后 store 不得被重写");
    assert.deepEqual(Object.keys(readStore(paths).store.providers), ["prov-a", "prov-b", "prov-c", "prov-d"]);
  });

  it("拒绝把号池成员拆散（members 在 order 中必须连续成块）", async () => {
    const paths = makeRoot();
    orderSeed(paths);
    const svc = makeService(paths);
    await svc.createPool({ poolId: "pool-x", displayName: "主号池", members: ["prov-a", "prov-b"] });
    const beforeHash = readStore(paths).hash;

    const result = await svc.reorderProviders(["prov-a", "prov-c", "prov-b", "prov-d"]);
    assert.equal(result.ok, false);
    assert.match(result.error, /pool-x|连续|contiguous/);
    assert.equal(readStore(paths).hash, beforeHash, "拒绝后 store 不得被重写");
  });

  it("号池整体移动：成员相对序不变，getState 池显示位置跟随成员块", async () => {
    const paths = makeRoot();
    orderSeed(paths);
    const svc = makeService(paths);
    await svc.createPool({ poolId: "pool-x", displayName: "主号池", members: ["prov-a", "prov-b"] });

    const result = await svc.reorderProviders(["prov-c", "prov-d", "prov-a", "prov-b"]);
    assert.equal(result.ok, true, result.error);
    const state = await svc.getState();
    assert.deepEqual(state.providers.map((p) => p.id), ["prov-c", "prov-d", "prov-a", "prov-b"]);
    // 池成员相对顺序不变，池显示位置 = 首个成员出现处（索引 2）
    assert.deepEqual(state.pools.find((p) => p.id === "pool-x").members, ["prov-a", "prov-b"]);
    const firstMemberIndex = state.providers.findIndex((p) => p.poolId === "pool-x");
    assert.equal(firstMemberIndex, 2);
    assert.deepEqual(readStore(paths).store.pools["pool-x"].members, ["prov-a", "prov-b"]);
  });
});
