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
  return { root, base, put, service: (options = {}) => createEnvironmentService({ base, readVersionResource: async () => null, ...options }) };
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

test("Codex reads its version from the CLI's own report and flags an unresponsive install", async (t) => {
  const f = fixture(t);
  const exe = f.put(join(f.base.LOCALAPPDATA, "OpenAI/Codex/bin/9f1c/codex.exe"));
  const ok = await f.service({ probeVersion: async (path) => (assert.equal(path, exe), { missing: false, version: "0.155.0" }) }).getState();
  const found = installation(ok, "codex");
  assert.equal(found.status, "found");
  assert.equal(found.version, "0.155.0");
  assert.equal(found.versionSource, "cli --version");
  assert.equal(found.issue, null);

  const broken = installation(await f.service({ probeVersion: async () => ({ missing: false, version: null }) }).getState(), "codex");
  assert.equal(broken.status, "found");
  assert.equal(broken.version, null);
  assert.equal(broken.issue, "not_runnable");

  const raced = installation(await f.service({ probeVersion: async () => ({ missing: true }) }).getState(), "codex");
  assert.equal(raced.status, "not_found");
  assert.equal(raced.path, null);
  assert.equal(raced.issue, "entry_missing");
});

test("Grok Build reads its version from the CLI's own report, like codex", async (t) => {
  const f = fixture(t);
  const exe = f.put(join(f.base.USERPROFILE, ".grok/bin/grok.exe"));
  const ok = await f.service({ probeVersion: async (path) => (assert.equal(path, exe), { missing: false, version: "1.0.30" }) }).getState();
  const found = installation(ok, "grok");
  assert.equal(found.status, "found");
  assert.equal(found.path, exe);
  assert.equal(found.remoteId, null);
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
  assert.deepEqual(state.clients.at(-2).installations.map((i) => [i.kind, i.remoteId]), [["desktop", "qoder"]]);
  for (const client of state.clients) {
    assert.equal(typeof client.name, "string");
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
