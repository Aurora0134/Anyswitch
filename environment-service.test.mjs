import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_ENTRY_FORMS, createEnvironmentService, probeExecutableVersion } from "./environment-service.mjs";

function fixture(t) {
  // 临时目录放测试文件旁（.cptest 已 gitignore，与本文件同生共死）。URL.pathname
  // 是百分号编码的，仓库路径含空格/中文时拿它拼 mkdtemp 会 ENOENT，须经
  // fileURLToPath 解码成真实路径。
  const parent = fileURLToPath(new URL("./.cptest/", import.meta.url));
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(join(parent, "environment-"));
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

// opencode 的执行体位置由宿主包清单的 optionalDependencies 说了算（解析器侧），
// 版本则由被选中的那个平台包自己的清单提供。fixture 按 npm 真实落盘写两层。
function installOpencodePlatform(f, hostName, platformName) {
  const host = join(f.base.APPDATA, "npm/node_modules", ...hostName.split("/"));
  const root = join(host, "node_modules", ...platformName.split("/"));
  f.put(join(host, "package.json"), JSON.stringify({
    name: hostName, version: "9.9.9", bin: { opencode: "./bin/opencode.exe" },
    optionalDependencies: { [platformName]: "9.9.9" },
  }));
  const entry = f.put(join(root, "bin/opencode.exe"));
  return { root, entry };
}

test("OpenCode uses its selected platform package instead of the embedded Bun version", async (t) => {
  const f = fixture(t);
  const { root, entry } = installOpencodePlatform(f, "opencode-ai", "opencode-windows-x64");
  f.put(join(root, "package.json"), JSON.stringify({ name: "opencode-windows-x64", version: "1.18.31" }));
  const service = f.service({ readVersionResource: async () => ({ ProductName: "Bun", ProductVersion: "1.3.14" }) });
  assert.equal(installation(await service.getState(), "opencode").version, "1.18.31");
  fs.unlinkSync(join(root, "package.json"));
  const item = installation(await service.getState({ force: true }), "opencode");
  assert.equal(item.status, "found");
  assert.equal(item.path, entry);
  assert.equal(item.version, null);
  assert.equal(item.issue, "version_unavailable");
});

test("OpenCode detects the baseline platform package this machine actually carries", async (t) => {
  // 上游按 CPU 档位把平台依赖拆成 x64 与 x64-baseline 两个可选包，机器上落盘
  // 哪一个都可能（本机 2026-10-11 重装起只有 baseline）。检测必须认实际装的那个。
  const f = fixture(t);
  const { root, entry } = installOpencodePlatform(f, "opencode-ai", "opencode-windows-x64-baseline");
  f.put(join(root, "package.json"), JSON.stringify({ name: "opencode-windows-x64-baseline", version: "1.19.0" }));
  const item = installation(await f.service().getState(), "opencode");
  assert.equal(item.status, "found");
  assert.equal(item.path, entry);
  assert.equal(item.version, "1.19.0");
  assert.equal(item.versionSource, "package.json");
  assert.equal(item.issue, null);
});

test("OpenCode detects the 2.x scoped package after upstream renamed it", async (t) => {
  // 本机 2026-10-14 13:18 起官方包整组改名：opencode-ai → @opencode/cli，平台包
  // opencode-windows-x64 → @opencode/cli-windows-x64。这一改把只认旧名的一版修复
  // 打回「本地 未找到 + 新建终端菜单缺项」，所以新布局要钉在用例里。
  // 平台包目录名是 scope 去掉后的 `cli-windows-x64`，版本身份认的是「清单名去
  // scope 等于所在目录名」，不再逐个列举上游的包名。
  const f = fixture(t);
  const { root, entry } = installOpencodePlatform(f, "@opencode/cli", "@opencode/cli-windows-x64");
  f.put(join(root, "package.json"), JSON.stringify({ name: "@opencode/cli-windows-x64", version: "2.0.28" }));
  const item = installation(await f.service().getState(), "opencode");
  assert.equal(item.status, "found");
  assert.equal(item.path, entry);
  assert.equal(item.version, "2.0.28");
  assert.equal(item.versionSource, "package.json");
  assert.equal(item.issue, null);
});

test("OpenCode 不接受平台目录旁对不上号的包清单版本", async (t) => {
  // 身份防线：所在目录名必须就是那份清单的名字（去 scope 后），否则是别人家的目录。
  const f = fixture(t);
  const { root, entry } = installOpencodePlatform(f, "@opencode/cli", "@opencode/cli-windows-x64");
  f.put(join(root, "package.json"), JSON.stringify({ name: "somebody-elses-package", version: "7.0.0" }));
  const item = installation(await f.service().getState(), "opencode");
  assert.equal(item.status, "found");
  assert.equal(item.path, entry);
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

test("ZCode CLI row reports not_found, never error, when no CLI entry is configured", async (t) => {
  const f = fixture(t);
  // 显式配置制：产品不内置任何默认路径，未配置 ZCODE_CLI_EXECUTABLE 时
  // resolveZcodeCliExecutable 返回 null——必须如实 not_found，不能把 null 交给
  // isFile 炸成 error（关于页不挂装不出的记录）。默认值若被重新引入，
  // agent-discovery.test 的「unconfigured is null」钉点会先红。无官方 release
  // 渠道：remoteId 恒为 null，关于页不为它发查询。
  const item = installation(await f.service().getState(), "zcode", 1);
  assert.equal(item.kind, "cli");
  assert.equal(item.remoteId, null);
  assert.equal(item.status, "not_found");
  assert.equal(item.path, null);
  assert.equal(item.version, null);
  assert.equal(item.versionSource, null);
  assert.equal(item.issue, "entry_missing");
});

test("ZCode CLI row honors ZCODE_CLI_EXECUTABLE and degrades to version_unavailable without a manifest", async (t) => {
  const f = fixture(t);
  const tree = join(f.root, "custom-zcode");
  const entry = f.put(join(tree, "bin/zcode.mjs"), "export {};");
  f.put(join(tree, "package.json"), JSON.stringify({ name: "zcode-runtime", version: "3.14.3" }));
  const service = f.service({ base: { ...f.base, ZCODE_CLI_EXECUTABLE: entry } });
  const found = installation(await service.getState(), "zcode", 1);
  assert.equal(found.status, "found");
  assert.equal(found.path, entry);
  assert.equal(found.version, "3.14.3");
  assert.equal(found.versionSource, "package.json");

  fs.unlinkSync(join(tree, "package.json"));
  const degraded = installation(await service.getState({ force: true }), "zcode", 1);
  assert.equal(degraded.status, "found");
  assert.equal(degraded.path, entry);
  assert.equal(degraded.version, null);
  assert.equal(degraded.versionSource, null);
  assert.equal(degraded.issue, "version_unavailable");
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
  const rootOnly = installation(await service.getState(), "qoder", 1);
  assert.equal(rootOnly.path, executable);
  assert.equal(rootOnly.version, "0.1.3");
  for (const version of ["0.2.9", "0.2.10", "0.3.4"]) {
    const payload = join(installRoot, ".qoder-versions", version, "Qoder.exe");
    f.put(payload);
    asarPackage(f, payload, "qoder", version);
  }
  f.put(join(installRoot, ".qoder-versions/0.4.0/Qoder.exe"));
  f.put(join(installRoot, ".qoder-versions/pending/Qoder.exe"));
  const item = installation(await service.getState({ force: true }), "qoder", 1);
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
  const item = installation(await f.service().getState(), "qoder", 1);
  assert.equal(item.status, "found");
  assert.equal(item.path, payload);
  assert.equal(item.version, null);
  assert.equal(item.issue, "version_unavailable");
});

test("Qoder CLI row reads its version from qodercli.exe's own --version report", async (t) => {
  const f = fixture(t);
  const exe = f.put(join(f.base.USERPROFILE, ".qoder/bin/qodercli/qodercli.exe"));
  const ok = await f.service({ probeVersion: async (path) => (assert.equal(path, exe), { missing: false, version: "1.1.64" }) }).getState();
  const found = installation(ok, "qoder", 0);
  assert.equal(found.kind, "cli");
  assert.equal(found.remoteId, "qoder-cli");
  assert.equal(found.status, "found");
  assert.equal(found.path, exe);
  assert.equal(found.version, "1.1.64");
  assert.equal(found.versionSource, "cli --version");
  assert.equal(found.issue, null);
  // 桌面条原样留在 index 1，与 CLI 条互不干扰。
  const desktop = installation(ok, "qoder", 1);
  assert.equal(desktop.kind, "desktop");
  assert.equal(desktop.remoteId, "qoder");
  assert.equal(desktop.status, "not_found");

  const broken = installation(await f.service({ probeVersion: async () => ({ missing: false, version: null }) }).getState(), "qoder", 0);
  assert.equal(broken.status, "found");
  assert.equal(broken.version, null);
  assert.equal(broken.issue, "not_runnable");

  // 文件在 isFile 与探针之间被挪走：按未找到报，不把半个安装留成 error。
  const vanished = installation(await f.service({ probeVersion: async () => ({ missing: true, version: null }) }).getState(), "qoder", 0);
  assert.equal(vanished.status, "not_found");
  assert.equal(vanished.path, null);
  assert.equal(vanished.issue, "entry_missing");
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

test("Claude desktop row reads the official MSIX manifest and never disturbs the CLI row", async (t) => {
  const f = fixture(t);
  const { entry } = npmInstall(f, "claude", "@anthropic-ai/claude-code", "2.1.276", "bin/claude.exe");
  const location = "C:\\Program Files\\WindowsApps\\Claude_2.9939.2.0_x64__pzs8sxrjxfjjc";
  let pkg = { Name: "Claude", Version: "2.9939.2.0", InstallLocation: location };
  const service = f.service({ readAppxPackage: async (name) => (assert.equal(name, "Claude"), pkg) });
  const found = installation(await service.getState(), "claude", 1);
  assert.equal(found.kind, "desktop");
  assert.equal(found.remoteId, "claude-desktop");
  assert.equal(found.status, "found");
  assert.equal(found.path, location);
  assert.equal(found.version, "2.9939.2");
  assert.equal(found.versionSource, "appx manifest");
  assert.equal(found.issue, null);

  pkg = { ...pkg, Version: "2.9939.2" };
  const threeSegment = installation(await service.getState({ force: true }), "claude", 1);
  assert.equal(threeSegment.version, "2.9939.2", "三段版本原样保留");

  const failed = await f.service({ readAppxPackage: async () => { throw Object.assign(new Error(), { code: "RESOURCE_FAILED" }); } }).getState();
  const cli = installation(failed, "claude", 0);
  assert.equal(cli.kind, "cli");
  assert.equal(cli.status, "found");
  // claude 执行体路径按 agent-discovery 的约定是正斜杠（与 codex 的 npmTarget 反斜杠不同形）
  assert.ok(cli.path.endsWith("node_modules/@anthropic-ai/claude-code/bin/claude.exe"));
  assert.equal(cli.version, "2.1.276");
  assert.equal(cli.issue, null);
  const desktop = installation(failed, "claude", 1);
  assert.equal(desktop.status, "error");
  assert.equal(desktop.path, null);
  assert.equal(desktop.version, null);
  assert.equal(desktop.issue, "discovery_failed");

  const absent = installation(await f.service().getState(), "claude", 1);
  assert.equal(absent.kind, "desktop");
  assert.equal(absent.remoteId, "claude-desktop");
  assert.equal(absent.status, "not_found");
  assert.equal(absent.issue, "entry_missing");
});

test("Kimi desktop row reads the app package from its Electron archive", async (t) => {
  const f = fixture(t);
  const executable = f.put(join(f.base.LOCALAPPDATA, "Programs/Kimi Code/Kimi Code.exe"));
  asarPackage(f, executable, "kimi-code-app", "1.0.4");
  const found = installation(await f.service().getState(), "kimi", 1);
  assert.equal(found.kind, "desktop");
  assert.equal(found.remoteId, "kimi-desktop");
  assert.equal(found.status, "found");
  assert.equal(found.path, executable);
  assert.equal(found.version, "1.0.4");
  assert.equal(found.versionSource, "app.asar/package.json");
  assert.equal(found.issue, null);

  // 只认归档确实属于这个产品：包名对不上就不报版本，与 qoder / zcode 同一条防线。
  asarPackage(f, executable, "some-other-app", "9.9.9");
  const unreadable = installation(await f.service().getState({ force: true }), "kimi", 1);
  assert.equal(unreadable.status, "found");
  assert.equal(unreadable.path, executable);
  assert.equal(unreadable.version, null);
  assert.equal(unreadable.issue, "version_unavailable");

  const g = fixture(t);
  const absent = installation(await g.service().getState(), "kimi", 1);
  assert.equal(absent.kind, "desktop");
  assert.equal(absent.remoteId, "kimi-desktop");
  assert.equal(absent.status, "not_found");
  assert.equal(absent.issue, "entry_missing");
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

test("Kimi CLI 的两种官方安装形态：npm 包读包清单，原生执行体回退到 --version", async (t) => {
  const f = fixture(t);
  // npm 形态：shim 是 npm 生成的（带 %dp0% + node_modules），解析到 dist/main.mjs，
  // 版本读它旁边的 package.json。
  const { entry } = npmInstall(f, "kimi", "@moonshot-ai/kimi-code", "2.1.1", "dist/main.mjs");
  const npm = installation(await f.service({ probeVersion: async () => { throw new Error("npm 形态不该走探针"); } }).getState(), "kimi", 0);
  assert.equal(npm.status, "found");
  assert.equal(npm.path, entry);
  assert.equal(npm.version, "2.1.1");
  assert.equal(npm.versionSource, "package.json");

  // 原生形态：shim 由官方安装器写成、直指原生 SEA 执行体（既没有 %dp0% 也没有
  // node_modules），执行体旁没有 package.json，版本只能靠 --version。
  const f2 = fixture(t);
  const native = f2.put(join(f2.base.USERPROFILE, ".kimi-code/bin/kimi.exe"));
  f2.put(join(f2.base.APPDATA, "npm/kimi.cmd"), `@echo off\r\n"%USERPROFILE%\\.kimi-code\\bin\\kimi.exe" %*\r\n`);
  const probed = [];
  const bare = installation(await f2.service({ probeVersion: async (path) => (probed.push(path), { missing: false, version: "2.0.2" }) }).getState(), "kimi", 0);
  assert.equal(bare.status, "found", "非 npm 格式的 shim 不得再被判成未找到");
  assert.equal(bare.path, native, "shim 解不出 npm 入口时按原路径报，不返回 null");
  assert.equal(bare.version, "2.0.2");
  assert.equal(bare.versionSource, "cli --version");
  assert.equal(bare.issue, null);
  assert.deepEqual(probed, [native], "探针只打在执行体上，不打在 shim 上");

  // 执行体在、却跑不起来：如实报 not_runnable，不谎报未安装。
  const notRunnable = installation(await f2.service({ probeVersion: async () => ({ missing: false, version: null }) }).getState(), "kimi", 0);
  assert.equal(notRunnable.status, "found");
  assert.equal(notRunnable.issue, "not_runnable");
});

test("解不出的 shim 按「未找到」报：npmTarget 兜底只保留给 kimi", async (t) => {
  // codex / pi / dsh 与 kimi 共用 npmTarget。损坏/残缺的 shim（既非 npm 生成式、
  // 也解不出执行体）在这些客户端上维持旧语义——报未找到，而不是用「已安装 +
  // 版本无法读取」掩盖入口缺失。
  const f = fixture(t);
  f.put(join(f.base.APPDATA, "npm/codex.cmd"), "");
  const item = installation(await f.service().getState(), "codex", 0);
  assert.equal(item.status, "not_found");
  assert.equal(item.path, null);
  assert.equal(item.issue, "entry_missing");
});

test("kimi 解不出的 shim 原样返回：已安装、版本读不出、不打探针", async (t) => {
  const f = fixture(t);
  const shim = f.put(join(f.base.APPDATA, "npm/kimi.cmd"), "not a parseable shim");
  const probed = [];
  const item = installation(await f.service({ probeVersion: async (path) => (probed.push(path), { missing: false, version: "9.9.9" }) }).getState(), "kimi", 0);
  assert.equal(item.status, "found");
  assert.equal(item.path, shim);
  assert.equal(item.version, null);
  assert.equal(item.issue, "version_unavailable");
  assert.deepEqual(probed, [], "shim 不是执行体，--version 探针不得开火");
});

test("引 node.exe 的手写 shim 不把 Node 当成客户端执行体", async (t) => {
  // 手写 shim 用 node.exe 拉脚本：node 不是客户端执行体，解析到它会误报安装
  // 位置，kimi 的 --version 探针还会把 Node 自身版本当成客户端版本。
  const f = fixture(t);
  const shim = f.put(join(f.base.APPDATA, "npm/kimi.cmd"), `@echo off\r\n"%~dp0\\node.exe" "C:\\app\\main.mjs" %*\r\n`);
  f.put(join(f.base.APPDATA, "npm/node.exe"));
  const probed = [];
  const item = installation(await f.service({ probeVersion: async (path) => (probed.push(path), { missing: false, version: "22.14.0" }) }).getState(), "kimi", 0);
  assert.equal(item.status, "found");
  assert.equal(item.path, shim, "解析到 shim 自身，不得解析到 node.exe");
  assert.equal(item.version, null, "Node 自身版本不得被当作 Kimi 版本报出");
  assert.equal(item.issue, "version_unavailable");
  assert.deepEqual(probed, [], "探针不得打在 node.exe 上");
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

test("an empty installation reports all ten clients, with the registered installation records", async (t) => {
  const f = fixture(t);
  const state = await f.service({ now: () => Date.parse("2026-09-18T08:00:00Z") }).getState();
  assert.equal(state.checkedAt, "2026-09-18T08:00:00.000Z");
  assert.equal(state.platform, process.platform);
  assert.equal(state.nodeVersion, process.version);
  assert.deepEqual(state.clients.map((c) => c.id), ["claude", "codex", "opencode", "pi", "kimi", "dsh", "zcode", "qoder", "grok", "workbuddy"]);
  assert.deepEqual(state.clients[1].installations.map((i) => [i.kind, i.remoteId]), [["cli", "codex"], ["desktop", "codex-desktop"]]);
  // Qoder 与 Codex 同序 [cli, desktop]：index 0 是 qodercli.exe（remoteId qoder-cli）。
  const qoder = state.clients.find((c) => c.id === "qoder");
  assert.deepEqual(qoder.installations.map((i) => [i.kind, i.remoteId]), [["cli", "qoder-cli"], ["desktop", "qoder"]]);
  // DSH 官方桌面端上线后同样是两条安装记录：index 0 是 npm 全局 CLI（更新按钮装的
  // 就是这个包），index 1 是官方桌面端（官方发布文件渠道，remoteId dsh-desktop）。
  // 终端形态的第二个组件 dsh-tui 追加为 index 2，前两条的顺序与语义不动。
  const dsh = state.clients.find((c) => c.id === "dsh");
  assert.deepEqual(dsh.installations.map((i) => [i.kind, i.remoteId]), [["cli", "dsh"], ["desktop", "dsh-desktop"], ["tui", "dsh-tui"]]);
  // Claude 与 Kimi 各补一条官方桌面端副记录：index 0 仍是面板代管更新的 npm CLI，
  // index 1 的官方来源各自走 claude-desktop / kimi-desktop 远端。
  const claude = state.clients.find((c) => c.id === "claude");
  assert.deepEqual(claude.installations.map((i) => [i.kind, i.remoteId]), [["cli", "claude"], ["desktop", "claude-desktop"]]);
  const kimi = state.clients.find((c) => c.id === "kimi");
  assert.deepEqual(kimi.installations.map((i) => [i.kind, i.remoteId]), [["cli", "kimi"], ["desktop", "kimi-desktop"]]);
  // ZCode 与 Qoder 同为双安装记录但主形态相反：index 0 是桌面主形态，index 1 是
  // 显式配置制的 CLI——CLI 没有官方 release 渠道，remoteId 恒为 null。
  const zcode = state.clients.find((c) => c.id === "zcode");
  assert.deepEqual(zcode.installations.map((i) => [i.kind, i.remoteId]), [["desktop", "zcode"], ["cli", null]]);
  // WorkBuddy 两条记录都是本地读版本：没有可核验的官方源，remoteId 一律 null，
  // 关于页不会为它发 404 查询。
  const workbuddy = state.clients.find((c) => c.id === "workbuddy");
  assert.deepEqual(workbuddy.installations.map((i) => [i.kind, i.remoteId]), [["cli", null], ["desktop", null]]);
  for (const client of state.clients) {
    assert.equal(typeof client.name, "string");
    assert.equal(client.entryForms, CLIENT_ENTRY_FORMS[client.id], "每个 client 携带注册表里同一份冻结形态枚举");
    assert.equal(client.installations.length, client.id === "dsh" ? 3 : ["codex", "qoder", "claude", "kimi", "zcode", "workbuddy"].includes(client.id) ? 2 : 1);
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

// WorkBuddy 的安装树：桌面壳在 Programs/WorkBuddy/WorkBuddy.exe，CLI 内核在
// 同一目录的 resources/app.asar.unpacked/cli/bin/codebuddy，CLI 版本在入口上两级
// 的 cli/package.json（包名 @genie/agent-cli，bin 指回入口）。
function installWorkbuddy(f, { cliName = "@genie/agent-cli", cliVersion = "2.165.0", desktopVersion = "5.9.3" } = {}) {
  const root = join(f.base.LOCALAPPDATA, "Programs", "WorkBuddy");
  const cliEntry = f.put(join(root, "resources/app.asar.unpacked/cli/bin/codebuddy"), "#!/usr/bin/env node\n");
  f.put(join(root, "resources/app.asar.unpacked/cli/package.json"), JSON.stringify({
    name: cliName, version: cliVersion, bin: { codebuddy: "bin/codebuddy" },
  }));
  const desktopExe = f.put(join(root, "WorkBuddy.exe"));
  asarPackage(f, desktopExe, "@genie/workbuddy-desktop", desktopVersion);
  return { root, cliEntry, desktopExe };
}

test("WorkBuddy reads the bundled CLI and the desktop shell, both without a remote source", async (t) => {
  const f = fixture(t);
  const installed = installWorkbuddy(f);
  const state = await f.service().getState();
  const client = state.clients.find((c) => c.id === "workbuddy");
  assert.deepEqual(client.entryForms, ["Desktop", "CLI"]);
  const [cli, desktop] = client.installations;
  assert.deepEqual([cli.kind, cli.remoteId, cli.status], ["cli", null, "found"]);
  assert.equal(cli.path, installed.cliEntry);
  assert.equal(cli.version, "2.165.0");
  assert.equal(cli.versionSource, "package.json");
  assert.equal(cli.issue, null);
  assert.deepEqual([desktop.kind, desktop.remoteId, desktop.status], ["desktop", null, "found"]);
  assert.equal(desktop.path, installed.desktopExe);
  assert.equal(desktop.version, "5.9.3");
  assert.equal(desktop.versionSource, "app.asar/package.json");
  assert.equal(desktop.issue, null);
});

test("WorkBuddy degrades to found/version_unavailable instead of erroring the page", async (t) => {
  const f = fixture(t);
  // 包名对不上 → 不报版本；asar 头坏掉 → 版本不可得。两条都要留在 found，
  // 走既有降级路径（关于页显示「查询失败」而不是整页炸）。
  installWorkbuddy(f, { cliName: "@genie/not-agent-cli" });
  fs.writeFileSync(join(f.base.LOCALAPPDATA, "Programs/WorkBuddy/resources/app.asar"), "not an asar");
  const client = (await f.service().getState()).clients.find((c) => c.id === "workbuddy");
  for (const item of client.installations) {
    assert.equal(item.status, "found");
    assert.equal(item.version, null);
    assert.equal(item.issue, "version_unavailable");
  }
});

test("dsh 终端插件 dsh-tui：从 profile 落点读实装版本，未装如实 not_found", async (t) => {
  // 插件装在 ~/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui，
  // 入口是包里的 bin/dsh-tui.js（清单 bin 同时声明 dsh-tui 与 dst）。关于页主行
  // 的 CLI 段摆的就是它，所以检测必须认这个落点、读包清单而不是猜。
  const f = fixture(t);
  const profileRoot = join(f.base.USERPROFILE, ".dsh", "profiles", "dsh-tui");
  const packageRoot = join(profileRoot, "node_modules", "@deepseek-harness-tui", "dsh-tui");
  f.put(join(packageRoot, "package.json"), JSON.stringify({
    name: "@deepseek-harness-tui/dsh-tui", version: "0.15.0", bin: { "dsh-tui": "./bin/dsh-tui.js", dst: "./bin/dsh-tui.js" },
  }));
  const entry = f.put(join(packageRoot, "bin", "dsh-tui.js"), "export {};");
  const found = installation(await f.service().getState(), "dsh", 2);
  assert.equal(found.kind, "tui");
  assert.equal(found.remoteId, "dsh-tui");
  assert.equal(found.status, "found");
  assert.equal(found.path, entry);
  assert.equal(found.version, "0.15.0");
  assert.equal(found.versionSource, "package.json");
  assert.equal(found.issue, null);

  // 清单名对不上号的目录不报版本（与其它 npm 客户端同一条身份防线）。
  f.put(join(packageRoot, "package.json"), JSON.stringify({ name: "somebody-elses-package", version: "9.9.9", bin: { "dsh-tui": "./bin/dsh-tui.js" } }));
  const foreign = installation(await f.service().getState({ force: true }), "dsh", 2);
  assert.equal(foreign.status, "found");
  assert.equal(foreign.version, null);
  assert.equal(foreign.issue, "version_unavailable");

  // 插件未装：该条如实 not_found（主行 CLI 段不占位），前两条主记录不受影响。
  fs.rmSync(join(profileRoot, "node_modules"), { recursive: true, force: true });
  const missing = await f.service().getState({ force: true });
  const absent = installation(missing, "dsh", 2);
  assert.equal(absent.status, "not_found");
  assert.equal(absent.path, null);
  assert.equal(absent.issue, "entry_missing");
  assert.deepEqual(missing.clients.find((client) => client.id === "dsh").installations.map((item) => item.kind), ["cli", "desktop", "tui"],
    "插件未装也不改变主记录的顺序");
});

test("dsh 终端插件读 DSH_HOME 指定的家目录", async (t) => {
  const f = fixture(t);
  const home = join(f.root, "dsh-home");
  const packageRoot = join(home, "profiles", "dsh-tui", "node_modules", "@deepseek-harness-tui", "dsh-tui");
  f.put(join(packageRoot, "package.json"), JSON.stringify({ name: "@deepseek-harness-tui/dsh-tui", version: "0.16.1", bin: { "dsh-tui": "./bin/dsh-tui.js" } }));
  f.put(join(packageRoot, "bin", "dsh-tui.js"), "export {};");
  const service = createEnvironmentService({ base: { ...f.base, DSH_HOME: home }, readVersionResource: async () => null, readAppxPackage: async () => null });
  const item = installation(await service.getState(), "dsh", 2);
  assert.equal(item.status, "found");
  assert.equal(item.version, "0.16.1");
});

test("CLIENT_ENTRY_FORMS is frozen and mirrors the client registry one to one", async (t) => {
  assert.ok(Object.isFrozen(CLIENT_ENTRY_FORMS));
  for (const forms of Object.values(CLIENT_ENTRY_FORMS)) assert.ok(Object.isFrozen(forms), "形态数组同样冻结");
  assert.deepEqual(CLIENT_ENTRY_FORMS, {
    kimi: ["CLI", "Desktop", "Web"],
    codex: ["CLI", "Desktop"],
    qoder: ["CLI", "Desktop"],
    claude: ["CLI", "Desktop"],
    dsh: ["CLI", "Desktop"],
    pi: ["CLI"],
    opencode: ["CLI"],
    grok: ["CLI"],
    zcode: ["Desktop", "CLI"],
    workbuddy: ["Desktop", "CLI"],
  });
  const f = fixture(t);
  const state = await f.service().getState();
  assert.deepEqual(Object.keys(CLIENT_ENTRY_FORMS).sort(), state.clients.map((client) => client.id).sort(),
    "注册表里每个客户端都有形态枚举，没有遗漏也没有多余");
});
