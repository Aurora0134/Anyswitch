import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractReleaseArchive } from "../src/ops/update-archive.mjs";
import { runSelfUpdate, spawnSelfUpdateWorker, probePanelAppInfo, defaultSpawnPanelHost, SELF_UPDATE_CLIENT_ID, verifyReleaseManifest, parseCurrentPointer, resolveInstallRoot } from "../src/ops/app-self-update.mjs";
import { readClientUpdateRun, writeClientUpdateRun } from "../src/agents/client-update-journal.mjs";

const RUN_ID = "00000000-0000-4000-8000-000000000000";
const keyPair = generateKeyPairSync("ed25519");
const testPublicKey = keyPair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

function crc32(data) { let c = 0xffffffff; for (const b of data) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function zip(entries, opts = {}) {
  const locals = [], centrals = []; let offset = 0;
  for (const row of entries) {
    const name = Buffer.from(row.name), localName = Buffer.from(opts.localNames?.[row.name] ?? row.name), bytes = Buffer.from(row.content ?? "");
    const crc = opts.crcs?.[row.name] ?? crc32(bytes), flags = opts.flags?.[row.name] ?? 0, method = opts.methods?.[row.name] ?? 0;
    const local = Buffer.alloc(30 + localName.length + bytes.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(opts.localSizes?.[row.name] ?? bytes.length, 22); local.writeUInt16LE(localName.length, 26); localName.copy(local, 30); bytes.copy(local, 30 + localName.length); locals.push(local);
    const central = Buffer.alloc(46 + name.length); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((row.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42); name.copy(central, 46); centrals.push(central); offset += local.length;
  }
  const localsData = Buffer.concat(locals), centralsData = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralsData.length, 12); end.writeUInt32LE(localsData.length, 16); return Buffer.concat([localsData, centralsData, end]);
}
const payloadEntries = (version = "1.2.3") => [{ name: "app/package.json", content: JSON.stringify({ version }) }, { name: "runtime/node.exe", content: "node-runtime" }];
function fixture({ version = "1.2.3", channel = "stable", archive = zip(payloadEntries(version)), digestMetadata = true } = {}) {
  const sha = createHash("sha256").update(archive).digest("hex"), zipName = "anyswitch-v" + version + "-win-x64-desktop.zip";
  const manifest = Buffer.from(JSON.stringify({ schema: 1, version, channel, platform: "win-x64", asset: zipName, sha256: sha, size: archive.length }));
  const signature = Buffer.from(sign(null, manifest, keyPair.privateKey).toString("base64"));
  const names = [zipName, zipName.replace(/\.zip$/, ".manifest.json"), zipName.replace(/\.zip$/, ".manifest.sig")], blobs = [archive, manifest, signature];
  assert.deepEqual(names, [`anyswitch-v${version}-win-x64-desktop.zip`, `anyswitch-v${version}-win-x64-desktop.manifest.json`, `anyswitch-v${version}-win-x64-desktop.manifest.sig`]);
  const assets = names.map((name, i) => ({ name, state: "uploaded", size: blobs[i].length, browser_download_url: "https://release-assets.githubusercontent.com/" + encodeURIComponent(name), digest: i === 0 && digestMetadata ? "sha256:" + sha : null }));
  const release = { tag_name: "v" + version, draft: false, prerelease: channel === "preview", assets };
  return { archive, manifest, signature, release, bodies: new Map(assets.map((asset, i) => [asset.browser_download_url, blobs[i]])) };
}
function response({ ok = true, json = null, bytes = Buffer.alloc(0) } = {}) { const body = Buffer.from(bytes); return { ok, status: ok ? 200 : 404, headers: { get: (key) => key === "content-length" ? String(body.length) : null }, json: async () => json, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }; }
function fakeFetch(f, release = f.release) { const calls = []; const fetchFn = async (url) => { calls.push(String(url)); if (String(url).startsWith("https://api.github.com/")) return response({ json: release }); const bytes = f.bodies.get(String(url)); return bytes !== undefined ? response({ bytes }) : response({ ok: false }); }; return { fetchFn, calls }; }
function setup({ version = "1.2.3", channel = "stable", step = "download", autoApply = false, fetchFn, probePanelFn, restartRelayFn, spawnPanelHostFn, publicKey = testPublicKey } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "anys-update-test-")), installRoot = join(temp, "install"), dataRoot = join(temp, "data"), journalDir = join(dataRoot, "client-updates"), current = "1.2.2";
  const old = join(installRoot, "versions", current); mkdirSync(join(old, "app"), { recursive: true }); mkdirSync(join(old, "runtime"), { recursive: true }); writeFileSync(join(old, "app", "package.json"), JSON.stringify({ version: current })); writeFileSync(join(old, "runtime", "node.exe"), "node"); writeFileSync(join(installRoot, "current.json"), JSON.stringify({ schema: 1, version: current }));
  const run = { runId: RUN_ID, clientId: SELF_UPDATE_CLIENT_ID, action: "update", step, state: "running", startedAt: new Date().toISOString(), targetVersion: version, targetTag: "v" + version, channel, autoApply, beforeVersion: current, appDir: join(old, "app"), relayRoot: dataRoot };
  writeClientUpdateRun(journalDir, run);
  let clock = 0;
  return { temp, installRoot, journalDir, run, fns: { runId: RUN_ID, journalDir, env: { ANYSWITCH_INSTALL_ROOT: installRoot, ANYSWITCH_APP_DIR: join(old, "app"), LOCALAPPDATA: temp }, fetchFn, publicKey, panelDownTimeoutMs: 100, panelUpTimeoutMs: 100, nowMs: () => clock, delay: async (ms) => { clock += ms; }, probePanelFn: probePanelFn ?? (async () => null), restartRelayFn: restartRelayFn ?? (async () => ({ ok: true })), relayRunning: async () => true, spawnPanelHostFn: spawnPanelHostFn ?? (() => 42), now: () => "2026-11-20T00:00:00.000Z" }, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

test("signed manifest verifies exact bytes, SemVer, channel, optional GitHub digest, and strict signature encoding", () => {
  const f = fixture({ version: "1.2.3-preview.1", channel: "preview" }), sig = f.signature.toString("utf8"), sha = JSON.parse(f.manifest).sha256;
  const options = { publicKey: testPublicKey, assetName: f.release.assets[0].name, channel: "preview", prerelease: true, assetDigest: "sha256:" + sha, assetSize: f.archive.length };
  assert.equal(verifyReleaseManifest(f.manifest, sig, options).version, "1.2.3-preview.1");
  assert.equal(verifyReleaseManifest(f.manifest, sig, { ...options, assetDigest: undefined }).version, "1.2.3-preview.1");
  for (const version of ["1.2.3-01", "1.2.3-rc.01"]) { const bad = fixture({ version, channel: "preview" }); assert.throws(() => verifyReleaseManifest(bad.manifest, bad.signature.toString("utf8"), { ...options, assetName: bad.release.assets[0].name })); }
  assert.throws(() => verifyReleaseManifest(f.manifest, sig + "\\n", options)); assert.throws(() => verifyReleaseManifest(Buffer.concat([f.manifest, Buffer.from(" ")]), sig, options)); assert.throws(() => verifyReleaseManifest(f.manifest, sig, { ...options, channel: "stable" })); assert.throws(() => verifyReleaseManifest(f.manifest, sig, { ...options, assetDigest: "sha256:" + "0".repeat(64) })); assert.throws(() => verifyReleaseManifest(f.manifest, sig, { ...options, publicKey: null }));
});

test("current pointer accepts only schema 1 safe versions", () => { assert.deepEqual(parseCurrentPointer('{"schema":1,"version":"1.2.3"}'), { schema: 1, version: "1.2.3" }); for (const raw of ['{}', '{"schema":2,"version":"1.2.3"}', '{"schema":1,"version":"../legacy"}']) assert.throws(() => parseCurrentPointer(raw)); });

test("install root derives from packaged ANYSWITCH_APP_ROOT before the data root", () => {
  assert.equal(resolveInstallRoot({ env: { ANYSWITCH_APP_ROOT: "C:/Apps/Anyswitch/versions/1.2.3/app", ANYSWITCH_INSTALL_ROOT: "C:/fallback" } }).replaceAll("\\", "/"), "C:/Apps/Anyswitch");
  assert.equal(resolveInstallRoot({ env: { ANYSWITCH_APP_ROOT: "C:/Users/x/AppData/Local/Anyswitch/app" } }), null);
});

test("archive extracts valid app/runtime entries", () => { const parent = mkdtempSync(join(tmpdir(), "anys-zip-ok-")), dest = join(parent, "stage"); try { assert.equal(extractReleaseArchive(zip(payloadEntries()), dest).version, "1.2.3"); assert.equal(readFileSync(join(dest, "runtime", "node.exe"), "utf8"), "node-runtime"); } finally { rmSync(parent, { recursive: true, force: true }); } });

test("archive rejects traversal, backslash, case-fold collisions, duplicate paths, and symlinks with cleanup", () => { const bad = [zip([{ name: "../x", content: "x" }]), zip([{ name: "app\\\\x", content: "x" }]), zip([{ name: "app/a", content: "1" }, { name: "APP/A", content: "2" }]), zip([{ name: "app/a", content: "1" }, { name: "app/a", content: "2" }]), zip([{ name: "app/link", content: "x", mode: 0o120777 }])]; for (const archive of bad) { const parent = mkdtempSync(join(tmpdir(), "anys-zip-reject-")), dest = join(parent, "stage"); try { assert.throws(() => extractReleaseArchive(archive, dest)); assert.equal(existsSync(dest), false); } finally { rmSync(parent, { recursive: true, force: true }); } } });

test("archive validates local/central headers, CRC, cumulative size, staging parent, and pre-existing destination", () => {
  const bad = [zip(payloadEntries(), { localNames: { "app/package.json": "app/no.json" } }), zip(payloadEntries(), { crcs: { "app/package.json": 0 } }), zip(payloadEntries(), { localSizes: { "app/package.json": 99 } })];
  for (const archive of bad) { const parent = mkdtempSync(join(tmpdir(), "anys-zip-meta-")), dest = join(parent, "stage"); try { assert.throws(() => extractReleaseArchive(archive, dest)); assert.equal(existsSync(dest), false); } finally { rmSync(parent, { recursive: true, force: true }); } }
  const parent = mkdtempSync(join(tmpdir(), "anys-zip-total-")), stage = join(parent, "stage"), real = join(parent, "real"), link = join(parent, "link"); mkdirSync(real); symlinkSync(real, link, "junction");
  try { assert.throws(() => extractReleaseArchive(zip(payloadEntries()), stage, { maxExpandedBytes: 8 }), /size limit/); assert.equal(existsSync(stage), false); assert.throws(() => extractReleaseArchive(zip(payloadEntries()), join(link, "stage"))); mkdirSync(stage); writeFileSync(join(stage, "foreign"), "keep"); assert.throws(() => extractReleaseArchive(zip(payloadEntries()), stage)); assert.equal(readFileSync(join(stage, "foreign"), "utf8"), "keep"); }
  finally { rmSync(parent, { recursive: true, force: true }); }
});

test("stable download verifies GitHub release and stages without activating", async () => { const f = fixture(), net = fakeFetch(f), s = setup({ fetchFn: net.fetchFn }); try { const result = await runSelfUpdate(s.fns); assert.equal(result.outcome, "downloaded", JSON.stringify(result)); assert.deepEqual(parseCurrentPointer(readFileSync(join(s.installRoot, "current.json"), "utf8")), { schema: 1, version: "1.2.2" }); assert.equal(existsSync(join(s.installRoot, "staging", RUN_ID, f.release.assets[0].name)), true); assert.ok(net.calls.some((url) => url.endsWith("/releases/tags/v1.2.3"))); } finally { s.cleanup(); } });

test("preview release requires prerelease metadata and matching signed channel", async () => { const f = fixture({ version: "1.3.0-preview.1", channel: "preview" }), net = fakeFetch(f), s = setup({ version: "1.3.0-preview.1", channel: "preview", fetchFn: net.fetchFn }); try { assert.equal((await runSelfUpdate(s.fns)).outcome, "downloaded"); } finally { s.cleanup(); } const bad = fakeFetch(f, { ...f.release, prerelease: false }), other = setup({ version: "1.3.0-preview.1", channel: "preview", fetchFn: bad.fetchFn }); try { assert.equal((await runSelfUpdate(other.fns)).outcome, "failed"); } finally { other.cleanup(); } });

test("downloaded archive hash is verified even without GitHub asset.digest", async () => { const f = fixture({ digestMetadata: false }), s = setup({ fetchFn: fakeFetch(f).fetchFn }); try { assert.equal((await runSelfUpdate(s.fns)).outcome, "downloaded"); } finally { s.cleanup(); } });

test("health success activates pointer; failed relay or panel health restores prior pointer", async () => { const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn }); try { assert.equal((await runSelfUpdate(s.fns)).outcome, "downloaded"); const staged = readClientUpdateRun(s.journalDir, RUN_ID); writeClientUpdateRun(s.journalDir, { ...staged, state: "running", step: "apply", finishedAt: null, result: null }); let probe = 0; const apply = { ...s.fns, probePanelFn: async () => ++probe === 1 ? null : { version: "1.2.3" }, restartRelayFn: async () => ({ ok: true }) }; const activated = await runSelfUpdate(apply); assert.equal(activated.outcome, "updated", JSON.stringify(activated)); assert.deepEqual(parseCurrentPointer(readFileSync(join(s.installRoot, "current.json"), "utf8")), { schema: 1, version: "1.2.3" }); assert.deepEqual(readdirSync(join(s.installRoot, "staging")), [], "成功路径不得留 staging 暂存（stageDir 与 extractRoot 都不留）"); } finally { s.cleanup(); }
  const f2 = fixture(), s2 = setup({ fetchFn: fakeFetch(f2).fetchFn }); try { await runSelfUpdate(s2.fns); const staged = readClientUpdateRun(s2.journalDir, RUN_ID); writeClientUpdateRun(s2.journalDir, { ...staged, state: "running", step: "apply", finishedAt: null, result: null }); let probes = 0; const failed = await runSelfUpdate({ ...s2.fns, restartRelayFn: async () => ({ ok: false }), probePanelFn: async () => { probes++; return probes === 1 ? null : { version: "1.2.3" }; } }); assert.equal(failed.outcome, "failed"); assert.equal(failed.message, "已恢复到更新前版本，但服务未能自动恢复。请从开始菜单启动 Anyswitch。"); assert.deepEqual(parseCurrentPointer(readFileSync(join(s2.installRoot, "current.json"), "utf8")), { schema: 1, version: "1.2.2" }); } finally { s2.cleanup(); }
});

test("worker rejects invalid journal, panel probe is bounded, and worker remains detached", async () => { assert.equal(await runSelfUpdate({ runId: RUN_ID, journalDir: "missing" }), null); const seen = []; assert.deepEqual(await probePanelAppInfo(undefined, async (url) => { seen.push(url); return { ok: true, json: async () => ({ version: "1.2.3", commit: "abc" }) }; }), { version: "1.2.3", commit: "abc" }); assert.equal(seen[0], "http://127.0.0.1:47820/panel/api/app-info"); let spawn, unref = false; spawnSelfUpdateWorker({ runId: RUN_ID, journalDir: "C:/data/client-updates", workerPath: "worker.mjs", spawnFn: (...args) => { spawn = args; return { unref() { unref = true; } }; } }); assert.equal(spawn[2].detached, true); assert.equal(spawn[2].stdio, "ignore"); assert.equal(unref, true); });

test("apply rejects staged manifest tampering without switching current pointer", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn });
  try {
    assert.equal((await runSelfUpdate(s.fns)).outcome, "downloaded");
    const staged = readClientUpdateRun(s.journalDir, RUN_ID);
    const stagedManifest = join(s.installRoot, "staging", RUN_ID, f.release.assets[1].name);
    writeFileSync(stagedManifest, Buffer.concat([readFileSync(stagedManifest), Buffer.from(" ")]));
    writeClientUpdateRun(s.journalDir, { ...staged, state: "running", step: "apply", result: null, finishedAt: null });
    const result = await runSelfUpdate(s.fns);
    assert.equal(result.outcome, "failed");
    assert.match(result.detail, /staged release metadata changed/);
    assert.deepEqual(parseCurrentPointer(readFileSync(join(s.installRoot, "current.json"), "utf8")), { schema: 1, version: "1.2.2" });
  } finally { s.cleanup(); }
});


test("user-authorized autoApply continues from verified download into package activation", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn, autoApply: true });
  try {
    let probes = 0;
    const result = await runSelfUpdate({ ...s.fns, probePanelFn: async () => ++probes === 1 ? null : { version: "1.2.3" } });
    assert.equal(result.outcome, "updated");
    assert.equal(readClientUpdateRun(s.journalDir, RUN_ID).step, "apply");
    assert.deepEqual(parseCurrentPointer(readFileSync(join(s.installRoot, "current.json"), "utf8")), { schema: 1, version: "1.2.3" });
  } finally { s.cleanup(); }
});

test("updating the panel leaves a stopped Relay stopped", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn, autoApply: true });
  try {
    let probes = 0;
    let restarts = 0;
    const result = await runSelfUpdate({
      ...s.fns,
      relayRunning: async () => false,
      restartRelayFn: async () => { restarts += 1; return { ok: true }; },
      probePanelFn: async () => ++probes === 1 ? null : { version: "1.2.3" },
    });
    assert.equal(result.outcome, "updated");
    assert.equal(restarts, 0);
  } finally {
    s.cleanup();
  }
});


test("first packaged activation removes the pointer when target panel or Relay health fails", async () => {
  for (const scenario of [{ relayOk: false, panelHealthy: true }, { relayOk: true, panelHealthy: false }]) {
    const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn });
    try {
      const noPointer = join(s.installRoot, "current.json"); rmSync(noPointer, { force: true });
      assert.equal((await runSelfUpdate(s.fns)).outcome, "downloaded");
      const staged = readClientUpdateRun(s.journalDir, RUN_ID);
      writeClientUpdateRun(s.journalDir, { ...staged, state: "running", step: "apply", result: null, finishedAt: null });
      let probes = 0;
      const result = await runSelfUpdate({ ...s.fns, restartRelayFn: async () => ({ ok: scenario.relayOk }), probePanelFn: async () => { probes++; return probes === 1 ? null : scenario.panelHealthy ? { version: "1.2.3" } : null; } });
      assert.equal(result.outcome, "failed");
      assert.equal(existsSync(noPointer), false);
    } finally { s.cleanup(); }
  }
});

test("target runtime root and node path are passed to relay and panel activation", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn }); let relayEnv, panelRequest;
  try {
    assert.equal((await runSelfUpdate(s.fns)).outcome, "downloaded");
    const staged = readClientUpdateRun(s.journalDir, RUN_ID);
    writeClientUpdateRun(s.journalDir, { ...staged, state: "running", step: "apply", result: null, finishedAt: null });
    let probes = 0;
    const result = await runSelfUpdate({ ...s.fns, restartRelayFn: async (dataRoot, env) => { relayEnv = env; return { ok: true }; }, spawnPanelHostFn: (request) => { panelRequest = request; return 77; }, probePanelFn: async () => ++probes === 1 ? null : { version: "1.2.3" } });
    assert.equal(result.outcome, "updated");
    assert.equal(relayEnv.ANYSWITCH_APP_ROOT, join(s.installRoot, "versions", "1.2.3", "app"));
    assert.equal(relayEnv.ANYSWITCH_NODE_PATH, join(s.installRoot, "versions", "1.2.3", "runtime", "node.exe"));
    assert.deepEqual(panelRequest.env, relayEnv);
  } finally { s.cleanup(); }
});


test("panel probe aborts a stalled request after its real timeout", async () => {
  let seen, timeout;
  const pending = probePanelAppInfo(47820, (url, init) => new Promise((resolve, reject) => { seen = { url, signal: init.signal }; init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }), { setTimeoutFn: (fn, ms) => { assert.equal(ms, 1500); timeout = fn; return 1; }, clearTimeoutFn: () => {} });
  timeout(); assert.equal(await pending, null); assert.equal(seen.url, "http://127.0.0.1:47820/panel/api/app-info"); assert.equal(seen.signal.aborted, true);
});

test("default panel replacement spawns the target node with the app panel entry directly", () => {
  let call, detached = false; const pid = defaultSpawnPanelHost({ installRoot: "C:/Tools/Anyswitch", appDir: "C:/Tools/Anyswitch/versions/1.2.3/app", env: { PATH: "C:/Windows" }, spawnFn: (...args) => { call = args; return { pid: 7, unref() { detached = true; } }; } });
  assert.equal(pid, 7); assert.equal(call[0], process.execPath);
  assert.deepEqual(call[1], [join("C:/Tools/Anyswitch/versions/1.2.3/app", "src", "panel", "panel-host.mjs")]);
  assert.ok([call[0], ...call[1]].every((arg) => !String(arg).includes('\\"')), "spawn argv 不得含内嵌 \\\"（cmd /s 剥引号后残留的旧形态）");
  assert.equal(call[2].shell, false); assert.equal(call[2].detached, true);
  assert.equal(call[2].env.ANYSWITCH_INSTALL_ROOT, "C:/Tools/Anyswitch"); assert.equal(detached, true);
});

test("existing target version directory is rejected rather than trusted by filename", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn });
  try {
    await runSelfUpdate(s.fns);
    const target = join(s.installRoot, "versions", "1.2.3"); mkdirSync(join(target, "app"), { recursive: true }); mkdirSync(join(target, "runtime"), { recursive: true }); writeFileSync(join(target, "app", "package.json"), JSON.stringify({ version: "1.2.3" })); writeFileSync(join(target, "runtime", "node.exe"), "unverified runtime");
    const staged = readClientUpdateRun(s.journalDir, RUN_ID); writeClientUpdateRun(s.journalDir, { ...staged, state: "running", step: "apply", result: null, finishedAt: null });
    const result = await runSelfUpdate(s.fns); assert.equal(result.outcome, "failed"); assert.match(result.detail, /version already exists/); assert.deepEqual(parseCurrentPointer(readFileSync(join(s.installRoot, "current.json"), "utf8")), { schema: 1, version: "1.2.2" });
  } finally { s.cleanup(); }
});

test("rolled-back activation removes the failed target dir and staging so the same version retries cleanly", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn, autoApply: true });
  try {
    let probes = 0;
    const rolled = await runSelfUpdate({ ...s.fns, probePanelFn: async () => ++probes === 1 ? null : { version: "1.2.2" } });
    assert.equal(rolled.outcome, "rolled_back");
    assert.equal(rolled.message, "新面板未能启动，已恢复到更新前版本", "无残留时既有回滚句原样保留");
    assert.equal(existsSync(join(s.installRoot, "versions", "1.2.3")), false, "失败目标目录必须清走（否则同版本重试永远撞 version already exists）");
    assert.equal(existsSync(join(s.installRoot, "staging", RUN_ID)), false, "staging 一并清走");
    assert.deepEqual(parseCurrentPointer(readFileSync(join(s.installRoot, "current.json"), "utf8")), { schema: 1, version: "1.2.2" });
    // 同版本重试：指针回旧版、目标目录已清，重跑到健康面板即成。
    writeClientUpdateRun(s.journalDir, { ...readClientUpdateRun(s.journalDir, RUN_ID), state: "running", step: "download", result: null, finishedAt: null });
    let retryProbes = 0;
    const retry = await runSelfUpdate({ ...s.fns, probePanelFn: async () => ++retryProbes === 1 ? null : { version: "1.2.3" } });
    assert.equal(retry.outcome, "updated");
  } finally { s.cleanup(); }
});

test("staging cleanup failure after a healthy swap still reports updated and carries residue", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn });
  try {
    assert.equal((await runSelfUpdate(s.fns)).outcome, "downloaded");
    const staged = readClientUpdateRun(s.journalDir, RUN_ID);
    writeClientUpdateRun(s.journalDir, { ...staged, state: "running", step: "apply", result: null, finishedAt: null });
    const stageDir = join(s.installRoot, "staging", RUN_ID);
    const io = { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, rmSync: (path, opts) => { if (String(path) === stageDir) throw Object.assign(new Error("EPERM (injected)"), { code: "EPERM" }); return rmSync(path, opts); } };
    let probes = 0;
    const result = await runSelfUpdate({ ...s.fns, io, probePanelFn: async () => ++probes === 1 ? null : { version: "1.2.3" } });
    assert.equal(result.outcome, "updated", JSON.stringify(result));
    assert.deepEqual(result.residue, [stageDir]);
    assert.ok(existsSync(stageDir), "注入 EPERM 后 staging 应真实残留");
    assert.deepEqual(parseCurrentPointer(readFileSync(join(s.installRoot, "current.json"), "utf8")), { schema: 1, version: "1.2.3" });
  } finally { s.cleanup(); }
});

test("rollback cleanup failure keeps rolled_back outcome and reports residue", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn, autoApply: true });
  try {
    const targetDir = join(s.installRoot, "versions", "1.2.3"), stageDir = join(s.installRoot, "staging", RUN_ID);
    const io = { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, rmSync: (path, opts) => { if ((String(path) === targetDir || String(path) === stageDir) && existsSync(path)) throw Object.assign(new Error("EPERM (injected)"), { code: "EPERM" }); return rmSync(path, opts); } };
    let probes = 0;
    const result = await runSelfUpdate({ ...s.fns, io, probePanelFn: async () => ++probes === 1 ? null : { version: "1.2.2" } });
    assert.equal(result.outcome, "rolled_back", JSON.stringify(result));
    assert.deepEqual(result.residue, [targetDir, stageDir]);
    assert.equal(result.message, "新面板未能启动，已恢复到更新前版本。残留目录未清走：" + [targetDir, stageDir].join("、") + "，可手动删除。");
    assert.equal(result.relayRestartFailed, false);
    assert.ok(existsSync(targetDir), "注入 EPERM 后目标目录应真实残留");
    assert.deepEqual(parseCurrentPointer(readFileSync(join(s.installRoot, "current.json"), "utf8")), { schema: 1, version: "1.2.2" });
  } finally { s.cleanup(); }
});

test("rolled_back result carries relay restart and panel relaunch failure flags", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn, autoApply: true });
  try {
    let probes = 0;
    const result = await runSelfUpdate({ ...s.fns,
      restartRelayFn: async (dataRoot, env) => ({ ok: !String(env.ANYSWITCH_APP_ROOT).includes(join("versions", "1.2.3")) }),
      spawnPanelHostFn: () => { throw new Error("spawn refused"); },
      probePanelFn: async () => { probes += 1; return probes === 1 ? null : { version: "1.2.2" }; } });
    assert.equal(result.outcome, "rolled_back", JSON.stringify(result));
    assert.equal(result.relayRestartFailed, true);
    assert.equal(result.panelRelaunchFailed, true);
  } finally { s.cleanup(); }
});

test("rollback that cannot restore relay or panel health reports failed with manual-start guidance", async () => {
  for (const scenario of [{ rollbackRelayOk: false, panelAnswers: true }, { rollbackRelayOk: true, panelAnswers: false }]) {
    const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn, autoApply: true });
    try {
      let probes = 0;
      const result = await runSelfUpdate({ ...s.fns,
        restartRelayFn: async (dataRoot, env) => ({ ok: String(env.ANYSWITCH_APP_ROOT).includes(join("versions", "1.2.3")) || scenario.rollbackRelayOk }),
        probePanelFn: async () => { probes += 1; if (probes === 1) return null; return { version: scenario.panelAnswers ? "1.2.2" : "0.0.0" }; } });
      assert.equal(result.outcome, "failed", JSON.stringify(result));
      assert.equal(result.message, "已恢复到更新前版本，但服务未能自动恢复。请从开始菜单启动 Anyswitch。");
      assert.equal(result.afterVersion, "1.2.2");
      assert.deepEqual(parseCurrentPointer(readFileSync(join(s.installRoot, "current.json"), "utf8")), { schema: 1, version: "1.2.2" }, "回滚指针必须已退回旧版");
    } finally { s.cleanup(); }
  }
});

test("resumed apply rolls back to beforeVersion instead of deleting the pointer when health fails again", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn });
  try {
    assert.equal((await runSelfUpdate(s.fns)).outcome, "downloaded");
    // 模拟上一尝试断点：目标目录完整、指针已切目标版，随后被瞬时异常打断收场。
    const target = join(s.installRoot, "versions", "1.2.3");
    mkdirSync(join(target, "app"), { recursive: true }); mkdirSync(join(target, "runtime"), { recursive: true });
    writeFileSync(join(target, "app", "package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(target, "runtime", "node.exe"), "node");
    writeFileSync(join(s.installRoot, "current.json"), JSON.stringify({ schema: 1, version: "1.2.3" }));
    const staged = readClientUpdateRun(s.journalDir, RUN_ID);
    writeClientUpdateRun(s.journalDir, { ...staged, state: "running", step: "apply", result: null, finishedAt: null });
    let probes = 0;
    const result = await runSelfUpdate({ ...s.fns, probePanelFn: async () => { probes += 1; return probes === 1 ? null : { version: "1.2.2" }; } });
    assert.equal(result.outcome, "rolled_back", JSON.stringify(result));
    assert.equal(result.beforeVersion, "1.2.2");
    assert.equal(result.afterVersion, "1.2.2");
    assert.deepEqual(parseCurrentPointer(readFileSync(join(s.installRoot, "current.json"), "utf8")), { schema: 1, version: "1.2.2" }, "resume 再失败必须回滚到 beforeVersion，不得删指针");
    assert.ok(existsSync(join(s.installRoot, "versions", "1.2.2")), "旧版目录不动");
    assert.equal(existsSync(target), false, "失败目标目录照常清走");
  } finally { s.cleanup(); }
});

test("first-install failure cleanup is best-effort and keeps the failed outcome with residue", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn });
  try {
    const noPointer = join(s.installRoot, "current.json"); rmSync(noPointer, { force: true });
    assert.equal((await runSelfUpdate(s.fns)).outcome, "downloaded");
    const staged = readClientUpdateRun(s.journalDir, RUN_ID);
    writeClientUpdateRun(s.journalDir, { ...staged, state: "running", step: "apply", result: null, finishedAt: null });
    const targetDir = join(s.installRoot, "versions", "1.2.3");
    const io = { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, rmSync: (path, opts) => { if (String(path) === targetDir && existsSync(path)) throw Object.assign(new Error("EPERM (injected)"), { code: "EPERM" }); return rmSync(path, opts); } };
    const result = await runSelfUpdate({ ...s.fns, io, probePanelFn: async () => null });
    assert.equal(result.outcome, "failed", JSON.stringify(result));
    assert.deepEqual(result.residue, [targetDir]);
    assert.ok(existsSync(targetDir), "注入 EPERM 后目标目录应真实残留");
    assert.equal(existsSync(noPointer), false, "指针清理不受目标目录占用影响");
    assert.equal(result.message, "新面板未能启动，且没有可恢复的旧版本。残留目录未清走：" + targetDir + "，可手动删除。");
  } finally { s.cleanup(); }
});

test("extract temp dir joins the cleanup radius when activation fails after extraction", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn });
  try {
    assert.equal((await runSelfUpdate(s.fns)).outcome, "downloaded");
    const staged = readClientUpdateRun(s.journalDir, RUN_ID);
    writeClientUpdateRun(s.journalDir, { ...staged, state: "running", step: "apply", result: null, finishedAt: null });
    const io = { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, renameSync: () => { throw new Error("rename denied"); } };
    const result = await runSelfUpdate({ ...s.fns, io });
    assert.equal(result.outcome, "failed", JSON.stringify(result));
    assert.match(result.detail, /rename denied/);
    assert.deepEqual(readdirSync(join(s.installRoot, "staging")), [], "stageDir 与 extractRoot 都必须进 catch 清理半径");
  } finally { s.cleanup(); }
});

test("apply-stage failure cleans staging in the catch path", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn });
  try {
    assert.equal((await runSelfUpdate(s.fns)).outcome, "downloaded");
    const staged = readClientUpdateRun(s.journalDir, RUN_ID);
    const stagedManifest = join(s.installRoot, "staging", RUN_ID, f.release.assets[1].name);
    writeFileSync(stagedManifest, Buffer.concat([readFileSync(stagedManifest), Buffer.from(" ")]));
    writeClientUpdateRun(s.journalDir, { ...staged, state: "running", step: "apply", result: null, finishedAt: null });
    const result = await runSelfUpdate(s.fns);
    assert.equal(result.outcome, "failed");
    assert.match(result.detail, /staged release metadata changed/);
    assert.equal(existsSync(join(s.installRoot, "staging", RUN_ID)), false, "异常收场应尽力清掉本 run 的 staging");
  } finally { s.cleanup(); }
});

test("same-version retry resumes to health verification when the pointer already switched and the target dir is complete", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn });
  try {
    assert.equal((await runSelfUpdate(s.fns)).outcome, "downloaded");
    // 模拟上一尝试：目标目录已落成、指针已切新版，随后被瞬时异常打断收场。
    const target = join(s.installRoot, "versions", "1.2.3");
    mkdirSync(join(target, "app"), { recursive: true }); mkdirSync(join(target, "runtime"), { recursive: true });
    writeFileSync(join(target, "app", "package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(target, "runtime", "node.exe"), "node");
    writeFileSync(join(s.installRoot, "current.json"), JSON.stringify({ schema: 1, version: "1.2.3" }));
    const staged = readClientUpdateRun(s.journalDir, RUN_ID);
    writeClientUpdateRun(s.journalDir, { ...staged, state: "running", step: "apply", result: null, finishedAt: null });
    let probes = 0;
    const result = await runSelfUpdate({ ...s.fns, probePanelFn: async () => ++probes === 1 ? null : { version: "1.2.3" } });
    assert.equal(result.outcome, "updated", JSON.stringify(result));
    assert.deepEqual(parseCurrentPointer(readFileSync(join(s.installRoot, "current.json"), "utf8")), { schema: 1, version: "1.2.3" });
  } finally { s.cleanup(); }
});

test("same-version retry still rejects an incomplete target dir even when the pointer switched", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn });
  try {
    assert.equal((await runSelfUpdate(s.fns)).outcome, "downloaded");
    const target = join(s.installRoot, "versions", "1.2.3");
    mkdirSync(join(target, "app"), { recursive: true });
    writeFileSync(join(target, "app", "package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(s.installRoot, "current.json"), JSON.stringify({ schema: 1, version: "1.2.3" }));
    const staged = readClientUpdateRun(s.journalDir, RUN_ID);
    writeClientUpdateRun(s.journalDir, { ...staged, state: "running", step: "apply", result: null, finishedAt: null });
    const result = await runSelfUpdate(s.fns);
    assert.equal(result.outcome, "failed");
    assert.match(result.detail, /version already exists/);
  } finally { s.cleanup(); }
});

test("target panel launch retries within the up window until the new identity answers", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn, autoApply: true });
  try {
    let probes = 0, spawns = 0;
    const result = await runSelfUpdate({ ...s.fns, panelUpTimeoutMs: 2000, pollMs: 100,
      spawnPanelHostFn: () => { spawns += 1; return 55; },
      probePanelFn: async () => { probes += 1; return probes <= 3 ? null : { version: "1.2.3" }; } });
    assert.equal(result.outcome, "updated", JSON.stringify(result));
    assert.equal(spawns, 3, "探测持续为空时应按节拍重拉，直到新身份应答");
  } finally { s.cleanup(); }
});

test("target panel launch retries are capped inside the up window", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn, autoApply: true });
  try {
    let spawns = 0, rolledBack = false;
    const result = await runSelfUpdate({ ...s.fns, panelUpTimeoutMs: 500, pollMs: 100,
      spawnPanelHostFn: (request) => { if (String(request.appRoot).includes(join("versions", "1.2.3"))) spawns += 1; else rolledBack = true; return 55; },
      probePanelFn: async () => rolledBack ? { version: "1.2.2" } : null });
    assert.equal(result.outcome, "rolled_back", JSON.stringify(result));
    assert.equal(spawns, Math.max(1, Math.floor(500 / 100)), "重拉次数应有界且不超 UP 窗（回滚拉旧面板不计入）");
  } finally { s.cleanup(); }
});

test("download clears stale staging for the same run id, so retries do not hit wx EEXIST", async () => {
  const f = fixture(), s = setup({ fetchFn: fakeFetch(f).fetchFn });
  try {
    mkdirSync(join(s.installRoot, "staging", RUN_ID), { recursive: true });
    writeFileSync(join(s.installRoot, "staging", RUN_ID, f.release.assets[0].name), "stale");
    assert.equal((await runSelfUpdate(s.fns)).outcome, "downloaded");
  } finally { s.cleanup(); }
});

test("panel UI retains the existing staged update and swap API contract", () => {
  const panelJs = readFileSync(new URL("../panel-ui/panel.js", import.meta.url), "utf8"), panelHtml = readFileSync(new URL("../panel-ui/panel.html", import.meta.url), "utf8");
  assert.match(panelHtml, /id="aboutSelfUpdate"/); assert.match(panelJs, /aboutSelfUpdate/); assert.match(panelJs, /anyswitch:self-update-swap/); assert.match(panelJs, /\/api\/self-update\/active/); assert.match(panelJs, /\/api\/self-update\/apply/); assert.match(panelJs, /\/api\/self-update\/last/);
});

