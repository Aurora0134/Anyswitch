import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { createEnvironmentService, probeExecutableVersion } from "./environment-service.mjs";

function fixture(t) {
  const parent = new URL("./.cptest/", import.meta.url);
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(join(parent.pathname.replace(/^\/(?=[A-Za-z]:)/, ""), "environment-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = { USERPROFILE: root, APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local"), PATH: "" };
  const put = (path, content = "MZ") => {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, content);
    return path;
  };
  return { root, base, put, service: (options = {}) => createEnvironmentService({ base, readVersionResource: async () => null, readAppxPackage: async () => null, ...options }) };
}

function npmInstall(f, id, name, version, bin) {
  const npm = join(f.base.APPDATA, "npm");
  const root = join(npm, "node_modules", name);
  f.put(join(root, "package.json"), JSON.stringify({ name, version, bin: { [id]: bin } }));
  const entry = f.put(join(root, bin), "export {};");
  f.put(join(npm, `${id}.cmd`), `@echo off\n"%_prog%" "%dp0%\\node_modules\\${name.replaceAll("/", "\\")}\\${bin.replaceAll("/", "\\")}" %*`);
  return { root, entry };
}

test("npm wrappers report the selected product package version, including prereleases", async (t) => {
  const f = fixture(t);
  const cases = [
    ["pi", "@earendil-works/pi-coding-agent", "0.85.1", "dist/bundle/cli.js"],
    ["kimi", "@moonshot-ai/kimi-code", "0.43.1", "dist/main.mjs"],
    ["dsh", "@deepseek-ai/dsh", "0.1.0-rc.6", "lib/bin.js"],
  ];
  const installed = cases.map(([id, name, version, bin]) => npmInstall(f, id, name, version, bin));
  const state = await f.service().getState();
  cases.forEach(([id, , version], index) => {
    const item = installation(state, id);
    assert.equal(item.status, "found");
    assert.equal(item.path, installed[index].entry);
    assert.equal(item.version, version);
    assert.equal(item.versionSource, "package.json");
    assert.equal(item.issue, null);
  });
});

test("OpenCode uses its selected platform package instead of the embedded Bun version", async (t) => {
  const f = fixture(t);
  const root = join(f.base.APPDATA, "npm/node_modules/opencode-ai/node_modules/opencode-windows-x64");
  f.put(join(root, "bin/opencode.exe"));
  f.put(join(root, "package.json"), JSON.stringify({ name: "opencode-windows-x64", version: "1.18.31" }));
  const service = f.service({ readVersionResource: async () => ({ ProductName: "Bun", ProductVersion: "1.3.14" }) });
  assert.equal(installation(await service.getState(), "opencode").version, "1.18.31");
  fs.unlinkSync(join(root, "package.json"));
  const item = installation(await service.getState({ force: true }), "opencode");
  assert.equal(item.status, "found");
  assert.equal(item.version, null);
  assert.equal(item.issue, "version_unavailable");
});

test("Claude normalizes its own PE version and exposes disagreement with its selected package", async (t) => {
  const f = fixture(t);
  npmInstall(f, "claude", "@anthropic-ai/claude-code", "2.1.274", "bin/claude.exe");
  let productVersion = "2.1.274.0";
  const service = f.service({ readVersionResource: async () => ({ ProductName: "Claude Code", ProductVersion: productVersion }) });
  const good = installation(await service.getState(), "claude");
  assert.equal(good.version, "2.1.274");
  assert.equal(good.versionSource, "package.json+pe");
  assert.equal(good.issue, null);
  productVersion = "2.1.275.0";
  const conflict = installation(await service.getState({ force: true }), "claude");
  assert.equal(conflict.status, "found");
  assert.equal(conflict.version, null);
  assert.equal(conflict.issue, "version_conflict");
});

function asarPackage(f, executable, name, version) {
  const pkg = Buffer.from(JSON.stringify({ name, version }));
  const header = Buffer.from(JSON.stringify({ files: { "package.json": { size: pkg.length, offset: "9" } } }));
  const headerSize = 8 + Math.ceil(header.length / 4) * 4;
  const prefix = Buffer.alloc(8 + headerSize);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerSize, 4);
  prefix.writeUInt32LE(headerSize - 4, 8);
  prefix.writeUInt32LE(header.length, 12);
  header.copy(prefix, 16);
  f.put(join(dirname(executable), "resources/app.asar"), Buffer.concat([prefix, Buffer.alloc(9), pkg, Buffer.alloc(1024)]));
}

test("ZCode reads only the selected desktop package from ASAR, not Electron or PE build versions", async (t) => {
  const f = fixture(t);
  const executable = f.put(join(f.base.LOCALAPPDATA, "Programs/zcode/ZCode.exe"));
  asarPackage(f, executable, "zcode", "3.11.2");
  const io = { ...fs, readFileSync(path, ...args) {
    assert.ok(!String(path).endsWith("app.asar"), "ASAR must be read by bounded ranges");
    return fs.readFileSync(path, ...args);
  } };
  const item = installation(await f.service({ io, readVersionResource: async () => ({ ProductName: "Electron", ProductVersion: "40.0.0", FileVersion: "3.11.2.6792" }) }).getState(), "zcode");
  assert.equal(item.path, executable);
  assert.equal(item.version, "3.11.2");
  assert.equal(item.versionSource, "app.asar/package.json");
});

function installation(state, id, index = 0) {
  return state.clients.find((client) => client.id === id).installations[index];
}

test("Qoder reads its version from the newest installed payload, not the stale install root", async (t) => {
  const f = fixture(t);
  const installRoot = join(f.base.LOCALAPPDATA, "Programs/Qoder");
  const executable = f.put(join(installRoot, "Qoder.exe"));
  asarPackage(f, executable, "qoder", "0.1.3");
  const service = f.service();
  const rootOnly = installation(await service.getState(), "qoder");
  assert.equal(rootOnly.path, executable);
  assert.equal(rootOnly.version, "0.1.3");
  for (const version of ["0.2.9", "0.2.10", "0.3.4"]) {
    const payload = join(installRoot, ".qoder-versions", version, "Qoder.exe");
    f.put(payload);
    asarPackage(f, payload, "qoder", version);
  }
  f.put(join(installRoot, ".qoder-versions/0.4.0/Qoder.exe"));
  f.put(join(installRoot, ".qoder-versions/pending/Qoder.exe"));
  const item = installation(await service.getState({ force: true }), "qoder");
  assert.equal(item.status, "found");
  assert.equal(item.path, join(installRoot, ".qoder-versions/0.3.4/Qoder.exe"));
  assert.equal(item.version, "0.3.4");
  assert.equal(item.versionSource, "app.asar/package.json");
  assert.equal(item.issue, null);
});

test("An unreadable newest payload is reported as unreadable, never as the stale install root version", async (t) => {
  const f = fixture(t);
  const installRoot = join(f.base.LOCALAPPDATA, "Programs/Qoder");
  asarPackage(f, f.put(join(installRoot, "Qoder.exe")), "qoder", "0.1.3");
  const payload = join(installRoot, ".qoder-versions/0.3.4/Qoder.exe");
  f.put(payload);
  f.put(join(installRoot, ".qoder-versions/0.3.4/resources/app.asar"), "garbage long enough to attempt a header read from");
  const item = installation(await f.service().getState(), "qoder");
  assert.equal(item.status, "found");
  assert.equal(item.path, payload);
  assert.equal(item.version, null);
  assert.equal(item.issue, "version_unavailable");
});

test("Codex reads its CLI version from the npm package manifest, never from a probe", async (t) => {
  const f = fixture(t);
  const { root, entry } = npmInstall(f, "codex", "@openai/codex", "0.155.1", "bin/codex.js");
  const probeVersion = async () => { throw new Error("codex must not be probed"); };
  const service = f.service({ probeVersion });
  const found = installation(await service.getState(), "codex");
  assert.equal(found.kind, "cli");
  assert.equal(found.status, "found");
  assert.equal(found.path, entry);
  assert.equal(found.version, "0.155.1");
  assert.equal(found.versionSource, "package.json");
  assert.equal(found.issue, null);

  fs.unlinkSync(join(root, "package.json"));
  const degraded = installation(await service.getState({ force: true }), "codex");
  assert.equal(degraded.status, "found");
  assert.equal(degraded.path, entry);
  assert.equal(degraded.version, null);
  assert.equal(degraded.versionSource, null);
  assert.equal(degraded.issue, "version_unavailable");
});

test("Codex desktop row reads the Microsoft Store package manifest", async (t) => {
  const f = fixture(t);
  const location = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.915.4065.0_x64__2db5s4fq7sg1g";
  let pkg = { Name: "OpenAI.Codex", Version: "26.915.4065.0", InstallLocation: location };
  const service = f.service({ readAppxPackage: async (name) => (assert.equal(name, "OpenAI.Codex"), pkg) });
  const found = installation(await service.getState(), "codex", 1);
  assert.equal(found.kind, "desktop");
  assert.equal(found.remoteId, "codex-desktop");
  assert.equal(found.status, "found");
  assert.equal(found.path, location);
  assert.equal(found.version, "26.915.4065");
  assert.equal(found.versionSource, "appx manifest");
  assert.equal(found.issue, null);

  pkg = { ...pkg, Version: "27.0.1" };
  const threeSegment = installation(await service.getState({ force: true }), "codex", 1);
  assert.equal(threeSegment.status, "found");
  assert.equal(threeSegment.version, "27.0.1");
  assert.equal(threeSegment.versionSource, "appx manifest");
  assert.equal(threeSegment.issue, null);

  pkg = { ...pkg, Version: "26.915" };
  const unreadable = installation(await service.getState({ force: true }), "codex", 1);
  assert.equal(unreadable.status, "found");
  assert.equal(unreadable.path, location);
  assert.equal(unreadable.version, null);
  assert.equal(unreadable.versionSource, null);
  assert.equal(unreadable.issue, "version_unavailable");
});

test("Codex desktop row reports an absent package and a failed probe without disturbing the CLI row", async (t) => {
  const f = fixture(t);
  const { entry } = npmInstall(f, "codex", "@openai/codex", "0.155.1", "bin/codex.js");
  const absent = installation(await f.service().getState(), "codex", 1);
  assert.equal(absent.kind, "desktop");
  assert.equal(absent.remoteId, "codex-desktop");
  assert.equal(absent.status, "not_found");
  assert.equal(absent.path, null);
  assert.equal(absent.version, null);
  assert.equal(absent.versionSource, null);
  assert.equal(absent.issue, "entry_missing");

  const failed = await f.service({ readAppxPackage: async () => { throw Object.assign(new Error(), { code: "RESOURCE_FAILED" }); } }).getState();
  const cli = installation(failed, "codex", 0);
  assert.equal(cli.kind, "cli");
  assert.equal(cli.status, "found");
  assert.equal(cli.path, entry);
  assert.equal(cli.version, "0.155.1");
  assert.equal(cli.versionSource, "package.json");
  assert.equal(cli.issue, null);
  const desktop = installation(failed, "codex", 1);
  assert.equal(desktop.status, "error");
  assert.equal(desktop.path, null);
  assert.equal(desktop.version, null);
  assert.equal(desktop.issue, "discovery_failed");
});

test("Grok Build reads its version from the CLI's own report", async (t) => {
  const f = fixture(t);
  const exe = f.put(join(f.base.USERPROFILE, ".grok/bin/grok.exe"));
  const ok = await f.service({ probeVersion: async (path) => (assert.equal(path, exe), { missing: false, version: "1.0.30" }) }).getState();
  const found = installation(ok, "grok");
  assert.equal(found.status, "found");
  assert.equal(found.path, exe);
  // 本地版本读执行体自报，官方最新仍查 @xai-official/grok 的 npm dist-tag（remoteId 交出去）
  assert.equal(found.remoteId, "grok");
  assert.equal(found.version, "1.0.30");
  assert.equal(found.versionSource, "cli --version");
  assert.equal(found.issue, null);

  const broken = installation(await f.service({ probeVersion: async () => ({ missing: false, version: null }) }).getState(), "grok");
  assert.equal(broken.status, "found");
  assert.equal(broken.version, null);
  assert.equal(broken.issue, "not_runnable");
});

test("probeExecutableVersion parses the first SemVer and classifies spawn failures", async () => {
  const run = (error, stdout = "", stderr = "") => probeExecutableVersion("codex.exe", { exec: (_path, _args, _options, cb) => cb(error, stdout, stderr) });
  assert.deepEqual(await run(null, "codex-cli 0.155.0\n"), { missing: false, version: "0.155.0" });
  assert.deepEqual(await run(null, "codex-cli 0.154.0-alpha.6.2\n"), { missing: false, version: "0.154.0-alpha.6.2" });
  // Grok Build 1.0.30's real --version line: name, SemVer, then a build hash.
  assert.deepEqual(await run(null, "grok 1.0.30 (04b7ffed98c6)\n"), { missing: false, version: "1.0.30" });
  assert.deepEqual(await run(null, "usage: codex\n"), { missing: false, version: null });
  const enoent = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
  assert.deepEqual(await run(enoent), { missing: true, version: null });
  const timedOut = Object.assign(new Error("killed"), { killed: true });
  assert.deepEqual(await run(timedOut), { missing: false, version: null });
});

test("an empty installation reports all nine clients and Qoder as one desktop product", async (t) => {
  const f = fixture(t);
  const state = await f.service({ now: () => Date.parse("2026-09-18T08:00:00Z") }).getState();
  assert.equal(state.checkedAt, "2026-09-18T08:00:00.000Z");
  assert.equal(state.platform, process.platform);
  assert.equal(state.nodeVersion, process.version);
  assert.deepEqual(state.clients.map((c) => c.id), ["claude", "codex", "opencode", "pi", "kimi", "dsh", "zcode", "qoder", "grok"]);
  assert.deepEqual(state.clients[1].installations.map((i) => [i.kind, i.remoteId]), [["cli", "codex"], ["desktop", "codex-desktop"]]);
  assert.deepEqual(state.clients.at(-2).installations.map((i) => [i.kind, i.remoteId]), [["desktop", "qoder"]]);
  for (const client of state.clients) {
    assert.equal(typeof client.name, "string");
    assert.equal(client.installations.length, client.id === "codex" ? 2 : 1);
    for (const item of client.installations) {
      assert.deepEqual(Object.keys(item).sort(), ["issue", "kind", "path", "remoteId", "status", "version", "versionSource"]);
      assert.equal(item.status, "not_found");
      assert.equal(item.path, null);
      assert.equal(item.version, null);
      assert.equal(item.versionSource, null);
      assert.equal(item.issue, "entry_missing");
    }
  }
});
