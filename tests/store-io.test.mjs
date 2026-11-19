// store-io.mjs tests. Temp directories only: never touches the real
// %LOCALAPPDATA%\Anyswitch store or the real v1 scope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  storePaths,
  loadStore,
  writeStore,
  ensureLayout,
  resolveCredentialPath,
  readCiphertext,
  loadV1Store,
  LOAD_REASON,
} from "../src/store/store-io.mjs";
import { createStoreService } from "../src/store/store-service.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

function tempPaths() {
  const root = mkTestDir("anyswitch-storeio-");
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

// ---------- legacy v1 (read-only) ----------

// loadV1Store → v1Paths reads %LOCALAPPDATA% on every call (store-io.mjs:125),
// so pointing that env var at a temp dir gives a disposable v1 scope. Restored
// in finally so later tests in this process keep their environment.
function withV1LocalAppData(run) {
  const local = mkTestDir("anyswitch-v1-scope-");
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = local;
  try {
    return run(local);
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  }
}

test("loadV1Store parses a v1 scope whose entries carry only credentialFile and baseURL", () => {
  // The v1 field shape is asserted against what loadV1Store actually parses,
  // documenting the migration gap the v2 loader has to close.
  withV1LocalAppData((local) => {
    const scope = "scope-valid";
    const scopeDir = join(local, "OpenCodeApiCred", "scopes", scope);
    mkdirSync(scopeDir, { recursive: true });
    writeFileSync(
      join(scopeDir, "store.json"),
      JSON.stringify({
        version: 1,
        providers: {
          "prov-one": {
            credentialFile: "credential-11111111-1111-1111-1111-111111111111.dpapi",
            baseURL: "https://example.test/v1",
          },
        },
      }),
    );

    const result = loadV1Store(scope);
    assert.equal(result.ok, true);
    assert.deepEqual(Object.entries(result.store.providers), [
      ["prov-one", { credentialFile: "credential-11111111-1111-1111-1111-111111111111.dpapi", baseURL: "https://example.test/v1" }],
    ]);
    assert.equal(result.store.providers["prov-one"].displayName, undefined);
    assert.equal(result.store.providers["prov-one"].protocol, undefined);
    assert.equal(result.store.providers["prov-one"].models, undefined);
    // v1 keeps credentials in the scope dir itself.
    assert.equal(result.paths.credentialsDir, scopeDir);
  });
});

test("loadV1Store classifies absent, unparsable and invalid v1 scopes", () => {
  withV1LocalAppData((local) => {
    // Absent: the scope directory was never created.
    assert.equal(loadV1Store("scope-absent").reason, LOAD_REASON.ABSENT);

    const brokenDir = join(local, "OpenCodeApiCred", "scopes", "scope-broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "store.json"), "{ not json");
    assert.equal(loadV1Store("scope-broken").reason, LOAD_REASON.UNPARSABLE);

    for (const [scope, body] of [
      ["scope-wrong-version", { version: 2, providers: {} }],
      ["scope-null-providers", { version: 1, providers: null }],
    ]) {
      const dir = join(local, "OpenCodeApiCred", "scopes", scope);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "store.json"), JSON.stringify(body));
      assert.equal(loadV1Store(scope).reason, LOAD_REASON.INVALID);
    }
  });
});

// ---- delete-journal 重放的触发语义（store-service getBoardState）-------------
// resumeDeletions 是 store IO 层的事务：读清 delete-journal、CAS 写 store、
// 删凭据。getBoardState 把它挂成 fire-and-forget（不 await、结果不进响应）。
// 重放链路本身全是同步 fs，「void 直调」与「await」在默认装配下不可区分——
// 所以经 scheduleResume 注入缝把事务闸在可控调度上：闸门还关时看板必须已返回，
// 闸门放开后事务必须完整落地。放 store-io.test.mjs 而非 store-service.test.mjs，
// 是因为后者不在本任务的文件所有权内，而这里钉的正是 journal/凭据这两份 IO 状态。
function journalFixture() {
  const paths = tempPaths();
  ensureLayout(paths);
  assert.equal(writeStore({ version: 2, providers: {} }, { paths }).ok, true);
  writeFileSync(join(paths.credentialsDir, "prov.dpapi"), Buffer.from("enc:sk-test", "utf8"));
  writeFileSync(
    join(paths.root, "delete-journal.json"),
    JSON.stringify({ pending: [{ providerId: "prov", credentialFile: "prov.dpapi", recordedAt: "x" }], completed: [] }),
  );
  return paths;
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test("getBoardState 触发 delete-journal 重放：响应不等事务，闸门放开后事务完整落地", async () => {
  const paths = journalFixture();

  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let scheduled = false;
  const svc = createStoreService({
    paths,
    scheduleResume: (task) => {
      scheduled = true;
      return gate.then(task);
    },
  });

  let boardSettled = false;
  const boardPromise = svc.getBoardState();
  boardPromise.then(() => { boardSettled = true; }, () => { boardSettled = true; });

  // setImmediate 在微任务队列清空后运行：这一拍之前所有能结算的 promise 都
  // 已结算。若实现把重放挂进了响应链（await），boardPromise 链在闸门后面，
  // 不可能在这拍之前结算。
  await nextTick();

  assert.equal(scheduled, true, "重放事务已被调度启动");
  assert.equal(boardSettled, true, "getBoardState 不等重放事务返回（fire-and-forget 实语义）");
  // 闸门还关着：事务没落地，残留凭据与 pending 原样。
  assert.equal(existsSync(join(paths.credentialsDir, "prov.dpapi")), true);
  let journal = JSON.parse(readFileSync(join(paths.root, "delete-journal.json"), "utf8"));
  assert.deepEqual(journal.pending.map((e) => e.providerId), ["prov"]);
  assert.deepEqual(journal.completed, []);

  releaseGate();
  const board = await boardPromise;
  assert.equal(board.ok, true);
  assert.equal("resumeResult" in board, false, "重放结果不进响应");
  await nextTick();

  // 事务随后完整落地：凭据删除、journal 结账，一步不少。
  assert.equal(existsSync(join(paths.credentialsDir, "prov.dpapi")), false, "重放删掉残留凭据");
  journal = JSON.parse(readFileSync(join(paths.root, "delete-journal.json"), "utf8"));
  assert.deepEqual(journal.pending, []);
  assert.deepEqual(journal.completed.map((e) => e.providerId), ["prov"]);
});

test("delete-journal 重放经默认 scheduleResume 与直调同序：重放不丢", async () => {
  // 默认装配（scheduleResume 同步直调）下行为不得变化：getBoardState 返回时
  // 重放事务（全同步 fs）已跑完，残留凭据与 pending 当场清掉。用例名里的
  // 「与直调同序」在这里是真的比出来的：同夹具另起一份，绕过 getBoardState
  // 的 fire-and-forget 调度缝直接 await svc.resumeDeletions()，两条路径的
  // 落盘终态必须逐位一致（completedAt 是结账时间戳，两条路径各自取当下时刻，
  // 比对前剥掉）。只跑默认装配、无直调对照的旧形态与
  // store-service.test.mjs 的 getBoardState 触发用例完全重复，已并入本对照。
  const readJournal = (paths) => JSON.parse(readFileSync(join(paths.root, "delete-journal.json"), "utf8"));
  const settledShape = (paths) => ({
    credential: existsSync(join(paths.credentialsDir, "prov.dpapi")),
    pending: readJournal(paths).pending,
    completed: readJournal(paths).completed.map(({ completedAt, ...entry }) => entry),
  });

  // 直调对照：不经 getBoardState 的调度缝，直接等事务本身返回。
  const directPaths = journalFixture();
  const direct = createStoreService({ paths: directPaths });
  assert.deepEqual(await direct.resumeDeletions(), { resumed: ["prov"], failed: [] }, "直调事务完整重放");

  const paths = journalFixture();
  const svc = createStoreService({ paths });

  const board = await svc.getBoardState();
  assert.equal(board.ok, true);
  assert.equal("resumeResult" in board, false);
  assert.deepEqual(settledShape(paths), settledShape(directPaths),
    "经默认 scheduleResume 与直调的落盘终态一致：重放不丢");
  assert.equal(existsSync(join(paths.credentialsDir, "prov.dpapi")), false, "同步重放当场删掉残留凭据");
  const journal = readJournal(paths);
  assert.deepEqual(journal.pending, []);
  assert.deepEqual(journal.completed.map((e) => e.providerId), ["prov"]);
});
