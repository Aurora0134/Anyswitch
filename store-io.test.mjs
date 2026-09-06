// store-io.mjs tests. Temp directories only: never touches the real
// %LOCALAPPDATA%\Anyswitch store or the real v1 scope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  storePaths,
  loadStore,
  writeStore,
  ensureLayout,
  resolveCredentialPath,
  readCiphertext,
  LOAD_REASON,
} from "./store-io.mjs";

function tempPaths() {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-storeio-"));
  return storePaths(root);
}

function validStore() {
  return {
    version: 2,
    providers: {
      alpha: {
        displayName: "Alpha",
        baseURL: "https://alpha.example/v1",
        protocol: "openai-compatible",
        credentialFile: "alpha.dpapi",
        models: { "model-one": { displayName: "Model One" } },
      },
    },
  };
}

// ---------- layout ----------

test("ensureLayout creates root, credentials and app dirs", () => {
  const paths = tempPaths();
  ensureLayout(paths);
  assert.equal(existsSync(paths.root), true);
  assert.equal(existsSync(paths.credentialsDir), true);
  assert.equal(existsSync(paths.appDir), true);
});

test("storePaths keeps every path under the given root", () => {
  const paths = storePaths("C:\\tmp\\AnySwitchTest");
  assert.equal(paths.storeFile, "C:\\tmp\\AnySwitchTest\\store.json");
  assert.equal(paths.credentialsDir, "C:\\tmp\\AnySwitchTest\\credentials");
  assert.equal(paths.appDir, "C:\\tmp\\AnySwitchTest\\app");
});

// ---------- load classification ----------

test("absent store is classified, not thrown", () => {
  const paths = tempPaths();
  const result = loadStore(paths);
  assert.equal(result.ok, false);
  assert.equal(result.reason, LOAD_REASON.ABSENT);
});

test("unparsable store is classified", () => {
  const paths = tempPaths();
  ensureLayout(paths);
  writeFileSync(paths.storeFile, "{ not json");
  const result = loadStore(paths);
  assert.equal(result.ok, false);
  assert.equal(result.reason, LOAD_REASON.UNPARSABLE);
});

test("schema-invalid store is classified with errors", () => {
  const paths = tempPaths();
  ensureLayout(paths);
  writeFileSync(paths.storeFile, JSON.stringify({ version: 1, providers: {} }));
  const result = loadStore(paths);
  assert.equal(result.ok, false);
  assert.equal(result.reason, LOAD_REASON.INVALID);
  assert.ok(result.errors.some((e) => e.includes("version")));
});

test("valid store loads with a hash usable for CAS", () => {
  const paths = tempPaths();
  ensureLayout(paths);
  const written = writeStore(validStore(), { paths });
  assert.equal(written.ok, true);

  const loaded = loadStore(paths);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.hash, written.hash);
  assert.equal(loaded.store.providers.alpha.baseURL, "https://alpha.example/v1");
});

test("fallbackURLs is optional and persists an ordered list of non-empty URLs", () => {
  const paths = tempPaths();
  ensureLayout(paths);
  const store = validStore();
  store.providers.alpha.fallbackURLs = [
    "https://backup-one.example/v1",
    "https://backup-two.example/v1",
  ];

  assert.equal(writeStore(store, { paths }).ok, true);
  assert.deepEqual(loadStore(paths).store.providers.alpha.fallbackURLs, store.providers.alpha.fallbackURLs);
});

test("fallbackURLs rejects empty arrays and invalid entries", () => {
  for (const fallbackURLs of [[], "https://backup.example/v1", [""], [42]]) {
    const paths = tempPaths();
    ensureLayout(paths);
    const store = validStore();
    store.providers.alpha.fallbackURLs = fallbackURLs;

    const result = writeStore(store, { paths });
    assert.equal(result.ok, false, JSON.stringify(fallbackURLs));
    assert.ok(result.errors.some((error) => error.includes("fallbackURLs")));
  }
});

test("reasoningVariants and supportsReasoning schema validation and persistence", () => {
  const paths = tempPaths();
  ensureLayout(paths);
  const store = validStore();
  store.providers.alpha.reasoningVariants = ["low", "medium", "high", "max"];
  store.providers.alpha.models["model-one"].supportsReasoning = false;
  store.providers.alpha.models["model-one"].reasoningEffortLevels = ["low", "high"];
  store.providers.alpha.models["model-one"].defaultEffort = "high";

  assert.equal(writeStore(store, { paths }).ok, true);
  const loaded = loadStore(paths).store;
  assert.deepEqual(loaded.providers.alpha.reasoningVariants, ["low", "medium", "high", "max"]);
  assert.equal(loaded.providers.alpha.models["model-one"].supportsReasoning, false);
  assert.deepEqual(loaded.providers.alpha.models["model-one"].reasoningEffortLevels, ["low", "high"]);
  assert.equal(loaded.providers.alpha.models["model-one"].defaultEffort, "high");

  // Rejections
  for (const reasoningVariants of [[], "high", [""], [123]]) {
    const s = validStore();
    s.providers.alpha.reasoningVariants = reasoningVariants;
    const res = writeStore(s, { paths });
    assert.equal(res.ok, false, JSON.stringify(reasoningVariants));
    assert.ok(res.errors.some((e) => e.includes("reasoningVariants")));
  }

  for (const supportsReasoning of ["yes", 0, null, []]) {
    const s = validStore();
    s.providers.alpha.models["model-one"].supportsReasoning = supportsReasoning;
    const res = writeStore(s, { paths });
    assert.equal(res.ok, false, JSON.stringify(supportsReasoning));
    assert.ok(res.errors.some((e) => e.includes("supportsReasoning")));
  }

  const okMod = validStore();
  okMod.providers.alpha.models["model-one"].inputModalities = ["text", "image"];
  okMod.providers.alpha.models["model-one"].outputModalities = ["text"];
  assert.equal(writeStore(okMod, { paths }).ok, true);

  for (const inputModalities of [[], ["video"], "image", ["text", ""]]) {
    const s = validStore();
    s.providers.alpha.models["model-one"].inputModalities = inputModalities;
    const res = writeStore(s, { paths });
    assert.equal(res.ok, false, JSON.stringify(inputModalities));
    assert.ok(res.errors.some((e) => e.includes("inputModalities")));
  }
});

// ---------- write guards ----------

test("writeStore refuses to persist a schema-invalid store", () => {
  const paths = tempPaths();
  ensureLayout(paths);
  const bad = validStore();
  bad.providers.alpha.protocol = "grpc";

  const result = writeStore(bad, { paths });
  assert.equal(result.ok, false);
  assert.match(result.reason, /schema-invalid/);
  // Nothing was written.
  assert.equal(existsSync(paths.storeFile), false);
});

test("writeStore refuses a provider id containing '/' (wire-ID invariant)", () => {
  const paths = tempPaths();
  ensureLayout(paths);
  const bad = { version: 2, providers: {} };
  bad.providers["a/b"] = validStore().providers.alpha;

  const result = writeStore(bad, { paths });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("wire-ID invariant")));
  assert.equal(existsSync(paths.storeFile), false);
});

test("writeStore with expectedHash:null requires absence", () => {
  const paths = tempPaths();
  ensureLayout(paths);
  const first = writeStore(validStore(), { paths, expectedHash: null });
  assert.equal(first.ok, true);

  const second = writeStore(validStore(), { paths, expectedHash: null });
  assert.equal(second.ok, false);
  assert.match(second.reason, /changed since it was read/);
});

test("writeStore CAS rejects a stale snapshot", () => {
  const paths = tempPaths();
  ensureLayout(paths);
  writeStore(validStore(), { paths });
  const stale = loadStore(paths).hash;

  // Someone else writes in between.
  const other = validStore();
  other.providers.alpha.displayName = "Changed";
  writeStore(other, { paths });

  const result = writeStore(validStore(), { paths, expectedHash: stale });
  assert.equal(result.ok, false);
  assert.match(result.reason, /changed since it was read/);
  // The other writer's content survives.
  assert.equal(loadStore(paths).store.providers.alpha.displayName, "Changed");
});

test("writeStore emits stable pretty JSON with trailing newline", () => {
  const paths = tempPaths();
  ensureLayout(paths);
  writeStore(validStore(), { paths });
  const text = readFileSync(paths.storeFile, "utf8");
  assert.ok(text.endsWith("\n"));
  assert.ok(text.includes('\n  "version": 2'));
});

// ---------- credential path containment ----------

test("credential paths resolve under the credentials root only", () => {
  const paths = tempPaths();
  const resolved = resolveCredentialPath("alpha.dpapi", paths);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.path, join(paths.credentialsDir, "alpha.dpapi"));
});

test("traversal, separators, UNC and drive letters are all refused", () => {
  const paths = tempPaths();
  const hostile = [
    "..\\..\\Windows\\System32\\config\\SAM",
    "../outside.dpapi",
    "sub\\dir.dpapi",
    "sub/dir.dpapi",
    "C:\\absolute.dpapi",
    "C:relative.dpapi",
    "\\\\server\\share\\cred.dpapi",
    "..",
    ".",
    "nul",
    "con.dpapi",
    "trailing.",
    "trailing ",
  ];
  for (const ref of hostile) {
    const resolved = resolveCredentialPath(ref, paths);
    assert.equal(resolved.ok, false, `expected refusal for ${JSON.stringify(ref)}`);
  }
});

test("readCiphertext refuses a hostile ref before touching the filesystem", () => {
  const paths = tempPaths();
  ensureLayout(paths);
  // Plant a file that a traversal would reach if containment failed.
  const outside = join(paths.root, "outside.dpapi");
  writeFileSync(outside, "SHOULD-NOT-BE-READ");

  const result = readCiphertext("..\\outside.dpapi", paths);
  assert.equal(result.ok, false);
  assert.equal(result.ciphertext, undefined);
});

test("readCiphertext reports a missing credential without throwing", () => {
  const paths = tempPaths();
  ensureLayout(paths);
  const result = readCiphertext("absent.dpapi", paths);
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing/);
});

test("readCiphertext returns the raw bytes for a valid ref", () => {
  const paths = tempPaths();
  ensureLayout(paths);
  const bytes = Buffer.from([1, 2, 3, 250, 251]);
  writeFileSync(join(paths.credentialsDir, "alpha.dpapi"), bytes);

  const result = readCiphertext("alpha.dpapi", paths);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ciphertext, bytes);
});

// ---------- v1 store field shape ----------

test("v1 entries carry only credentialFile and baseURL, so v2 must synthesise the rest", () => {
  // Documents the migration gap the v2 loader has to close. Uses a synthetic v1 object,
  // not the real scope directory.
  const v1Entry = {
    credentialFile: "credential-11111111-1111-1111-1111-111111111111.dpapi",
    baseURL: "https://example.test/v1",
  };
  assert.deepEqual(Object.keys(v1Entry).sort(), ["baseURL", "credentialFile"]);
  assert.equal(v1Entry.displayName, undefined);
  assert.equal(v1Entry.protocol, undefined);
  assert.equal(v1Entry.models, undefined);
});
