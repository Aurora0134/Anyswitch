import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DSH_TUI_PACKAGE,
  alignDshTuiPlugins,
  dshTuiSessionRunning,
  dshVersionSatisfiesRange,
  findDshTuiProfiles,
  ignoredSharpOptionalPatterns,
  peerRangesCompatible,
  pickCompatiblePluginVersion,
  seedProfileWorkspace,
} from "./dsh-tui-align.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

test("区间匹配：精确版与 caret 两种实测形状", () => {
  const range = "^0.1.0-rc.6 || ^0.1.1-rc.1 || 0.1.2-alpha.3 || 0.1.5-rc.1 || 0.1.7-rc.1 || 0.1.7-rc.2";
  assert.equal(dshVersionSatisfiesRange("0.1.7-rc.2", range), true, "精确枚举命中");
  assert.equal(dshVersionSatisfiesRange("0.1.7-rc.1", range), true);
  assert.equal(dshVersionSatisfiesRange("0.1.6-rc.1", range), false, "没枚举到的预发行不接");
  assert.equal(dshVersionSatisfiesRange("0.1.5-rc.1", range), true, "精确版自身");
});

test("区间匹配：caret 的边界与预发行元组规则", () => {
  assert.equal(dshVersionSatisfiesRange("0.1.5-rc.1", "^0.1.5-alpha.1"), true, "同元组预发行，rc 晚于 alpha");
  assert.equal(dshVersionSatisfiesRange("0.1.5-alpha.0", "^0.1.5-alpha.1"), false, "同元组但更早");
  assert.equal(dshVersionSatisfiesRange("0.1.5", "^0.1.5-alpha.2"), true, "正式版晚于同元组预发行下界");
  assert.equal(dshVersionSatisfiesRange("0.1.7-rc.2", "^0.1.5-alpha.1"), false, "预发行只被同 [major,minor,patch] 的档接住");
  assert.equal(dshVersionSatisfiesRange("0.1.9", "^0.1.5"), true, "0.x caret 到 minor 进位前");
  assert.equal(dshVersionSatisfiesRange("0.2.0", "^0.1.5"), false, "0.x caret 上界 <0.2.0");
  assert.equal(dshVersionSatisfiesRange("4.5.0", "^4.0.1"), true);
  assert.equal(dshVersionSatisfiesRange("5.0.0", "^4.0.1"), false);
  assert.equal(dshVersionSatisfiesRange("4.0.0", "^4.0.1"), false, "低于下界");
  assert.equal(dshVersionSatisfiesRange("0.1.7-rc.2", "^0.1.5"), false, "caret 无预发行档位时预发行版本不接");
});

test("区间匹配：认不出的形状一律判不满足，不做无把握的安装", () => {
  for (const bad of [">=0.1.7", "<0.2.0", ">=0.1.5 <0.2.0", "0.1.x", "*", "~0.1.5", "0.1.5 - 0.1.7"]) {
    assert.equal(dshVersionSatisfiesRange("0.1.7-rc.2", bad), false, bad);
  }
  assert.equal(dshVersionSatisfiesRange("not-a-version", "0.1.7-rc.2"), false);
  assert.equal(dshVersionSatisfiesRange("0.1.7-rc.2", ""), false);
});

test("peer 适配判定：只有 @deepseek-ai/dsh* 一族参与，cordis/schemastery 不随 CLI 版本", () => {
  const peers = {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/schemastery": "^3.18.1",
    "@deepseek-ai/dsh-llm": "^0.1.5-alpha.1 || 0.1.7-rc.2",
  };
  assert.equal(peerRangesCompatible(peers, "0.1.7-rc.2"), true);
  assert.equal(peerRangesCompatible(peers, "0.1.9-rc.1"), false, "dsh 族任何一条不满足即不适配");
  assert.equal(peerRangesCompatible({}, "0.1.7-rc.2"), true, "没声明 dsh 约束即不挡");
  assert.equal(peerRangesCompatible(peers, "garbage"), false, "dsh 版本读不出时无从证明适配");
});

test("挑选目标版：适配且新于本地的最高版", () => {
  const candidates = [
    { version: "0.12.0", peerDependencies: { "@deepseek-ai/dsh-llm": "0.1.9-rc.1" } },
    { version: "0.11.0", peerDependencies: { "@deepseek-ai/dsh-llm": "0.1.7-rc.2" } },
    { version: "0.10.2", peerDependencies: { "@deepseek-ai/dsh-llm": "^0.1.5-alpha.1 || 0.1.5-rc.1" } },
  ];
  const { pick, sawNewer } = pickCompatiblePluginVersion(candidates, "0.1.7-rc.2", "0.10.2");
  assert.equal(pick?.version, "0.11.0", "跳过不适配的 0.12.0");
  assert.equal(sawNewer, true);
  const { pick: pick015 } = pickCompatiblePluginVersion(candidates, "0.1.5-rc.1", "0.10.2");
  assert.equal(pick015, null, "0.1.5 下没有适配且更新的候选");
});

test("挑选目标版：新版全不适配与本地已领先要区分开", () => {
  const incompatibleNewer = [{ version: "0.12.0", peerDependencies: { "@deepseek-ai/dsh-llm": "0.1.9-rc.1" } }];
  assert.deepEqual(pickCompatiblePluginVersion(incompatibleNewer, "0.1.7-rc.2", "0.11.1"), { pick: null, sawNewer: true });
  assert.deepEqual(pickCompatiblePluginVersion(incompatibleNewer, "0.1.9-rc.1", "0.12.0"), { pick: null, sawNewer: false });
});

test("挑选目标版：本地读不到或不可解析时，适配即入选（顺带修复装坏的 profile）", () => {
  const candidates = [{ version: "0.11.1", peerDependencies: { "@deepseek-ai/dsh-llm": "0.1.7-rc.2" } }];
  assert.equal(pickCompatiblePluginVersion(candidates, "0.1.7-rc.2", null).pick?.version, "0.11.1");
  assert.equal(pickCompatiblePluginVersion(candidates, "0.1.7-rc.2", "corrupt").pick?.version, "0.11.1");
  assert.equal(pickCompatiblePluginVersion(candidates, "0.1.7-rc.2", "0.11.1").pick, null, "同版不重装");
});

const FIXTURE_HOME = "C:/fixture/home";

// io 替身按内存文件系统建模：files 存文件内容，目录由登记文件的逐级父目录补齐
// （真实 profile 目录因为装着 package.json 必然存在），writeFileSync 与真实 fs
// 同口径——只允许写进已存在的目录。早先的替身只登记文件、不认目录、没有
// writeFileSync，而源码在安装前必经 seedProfileWorkspace：rewriteWorkspaceBlock
// 第一道闸就是「目录不存在即返回」，写盘又走 io.writeFileSync，两处异常都被
// try/catch 吞掉——预置三道闸在旧夹具下静默空转，用例自称全流程却零覆盖。
function fakeIo({ profiles = [], manifests = {}, installed = {}, npmCliExists = true } = {}) {
  const files = new Map();
  const dirs = new Set();
  const addFile = (path, content) => {
    files.set(path, content);
    for (let dir = dirname(path); dir !== dirname(dir) && !dirs.has(dir); dir = dirname(dir)) dirs.add(dir);
  };
  for (const [profile, manifest] of Object.entries(manifests)) addFile(join(FIXTURE_HOME, "profiles", profile, "package.json"), JSON.stringify(manifest));
  for (const [profile, version] of Object.entries(installed)) {
    if (version === null) continue;
    addFile(join(FIXTURE_HOME, "profiles", profile, "node_modules", ...DSH_TUI_PACKAGE.split("/"), "package.json"), JSON.stringify({ version }));
  }
  return {
    existsSync: (path) => (String(path).endsWith("npm-cli.js") ? npmCliExists : files.has(path) || dirs.has(path)),
    readFileSync: (path) => {
      if (files.has(path)) return files.get(path);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    writeFileSync: (path, content) => {
      if (!dirs.has(dirname(path))) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      addFile(path, String(content));
    },
    readdirSync: () => profiles.map((name) => ({ name, isDirectory: () => true })),
  };
}

// 路由：args[1]==="view" 的是元数据查询（args[3]==="versions" 为全量列表，args[2]
// 带 @ 的是指定版本，裸包名是 latest）；其余是 plugin add 安装命令。
function fakeSpawn(routes) {
  const calls = [];
  const respond = (callback, route) => {
    if (!route || route.error) return callback(Object.assign(new Error("exit 1"), { code: 1 }), route?.stdout ?? "", route?.stderr ?? "boom");
    return callback(null, route.json !== undefined ? JSON.stringify(route.json) : (route.stdout ?? ""), "");
  };
  const spawn = (file, args, options, callback) => {
    calls.push({ file, args });
    if (args[1] === "view") {
      if (args[3] === "versions") return respond(callback, routes.versions);
      if (args[2] === DSH_TUI_PACKAGE) return respond(callback, routes.latest);
      return respond(callback, routes.bySpec?.[args[2]]);
    }
    return respond(callback, routes.run);
  };
  return { calls, spawn };
}

const BASE = { DSH_HOME: FIXTURE_HOME, DSH_EXECUTABLE: "C:/fixture/dsh.cmd", COMSPEC: "C:/fixture/cmd.exe" };
const NPM_CLI = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const TUI_PROFILE = { dependencies: { [DSH_TUI_PACKAGE]: "^0.10.2" } };

test("对齐全流程：latest 适配且更新时，按 dsh 文档原样的 plugin add 命令落地", async () => {
  const io = fakeIo({
    profiles: ["dsh-tui", "web"],
    manifests: { "dsh-tui": TUI_PROFILE, web: { dependencies: { "@deepseek-ai/dsh-web-app": "0.1.7-rc.2" } } },
    installed: { "dsh-tui": "0.10.2" },
  });
  const { calls, spawn } = fakeSpawn({
    latest: { json: { version: "0.11.1", peerDependencies: { "@deepseek-ai/dsh-llm": "^0.1.5-alpha.1 || 0.1.7-rc.2" } } },
    run: { stdout: "added" },
  });
  const result = await alignDshTuiPlugins({ dshVersion: "0.1.7-rc.2", spawn, io, base: BASE });
  assert.equal(result.state, "updated");
  assert.deepEqual(result.profiles, [{ profile: "dsh-tui", state: "updated", from: "0.10.2", to: "0.11.1", output: "added" }]);
  assert.deepEqual(calls[0], { file: process.execPath, args: [NPM_CLI, "view", DSH_TUI_PACKAGE, "version", "peerDependencies", "--json"] }, "元数据查询与 npm 腿同口径");
  assert.deepEqual(calls[1], {
    file: "C:/fixture/cmd.exe",
    args: ["/d", "/c", "C:/fixture/dsh.cmd", "plugin", "--profile", "dsh-tui", "add", "-w", `${DSH_TUI_PACKAGE}@0.11.1`],
  }, "安装命令与 dsh-tui 自带升级提示逐字一致");
  assert.equal(calls.length, 2, "latest 一跳命中，不翻历史版本");
  // 安装前的三道闸预置要真实落盘：allowBuilds 四键、发版当天的 release-age
  // 豁免（目标版在前、旧本地版留作豁免）、sharp 平台过滤（当前平台绝不忽略）。
  const yaml = io.readFileSync(join(FIXTURE_HOME, "profiles", "dsh-tui", "pnpm-workspace.yaml"), "utf8");
  const sharpLines = ignoredSharpOptionalPatterns(process.platform, process.arch, "glibc").map((pattern) => `  - '${pattern}'`);
  assert.equal(yaml, [
    "allowBuilds:",
    "  '@google/genai': false",
    "  esbuild: false",
    "  koffi: false",
    "  protobufjs: false",
    "",
    "minimumReleaseAgeExclude:",
    `  - '${DSH_TUI_PACKAGE}@0.11.1'`,
    `  - '${DSH_TUI_PACKAGE}@0.10.2'`,
    "",
    "ignoredOptionalDependencies:",
    ...sharpLines,
  ].join("\n") + "\n", "三道闸按上游同一套纪律写入 pnpm-workspace.yaml");
  assert.throws(() => io.readFileSync(join(FIXTURE_HOME, "profiles", "web", "pnpm-workspace.yaml"), "utf8"), /ENOENT/, "没声明插件的 profile 不被预置");
});

test("对齐全流程：latest 不适配时向下翻，挑到适配旧版", async () => {
  const io = fakeIo({ profiles: ["dsh-tui"], manifests: { "dsh-tui": TUI_PROFILE }, installed: { "dsh-tui": "0.10.2" } });
  const { spawn } = fakeSpawn({
    latest: { json: { version: "0.12.0", peerDependencies: { "@deepseek-ai/dsh-llm": "0.1.9-rc.1" } } },
    versions: { json: { versions: ["0.10.2", "0.11.1", "0.12.0"] } },
    bySpec: { [`${DSH_TUI_PACKAGE}@0.11.1`]: { json: { version: "0.11.1", peerDependencies: { "@deepseek-ai/dsh-llm": "0.1.7-rc.2" } } } },
    run: { stdout: "added" },
  });
  const result = await alignDshTuiPlugins({ dshVersion: "0.1.7-rc.2", spawn, io, base: BASE });
  assert.equal(result.state, "updated");
  assert.equal(result.profiles[0].to, "0.11.1", "跳过不适配的 0.12.0，落到适配的 0.11.1");
});

test("对齐全流程：已最新与新版未适配各归其位，且都不触发安装", async () => {
  const io = fakeIo({ profiles: ["dsh-tui"], manifests: { "dsh-tui": TUI_PROFILE }, installed: { "dsh-tui": "0.11.1" } });
  const run = { error: true, stderr: "不应触发安装" };
  const current = fakeSpawn({
    latest: { json: { version: "0.11.1", peerDependencies: { "@deepseek-ai/dsh-llm": "0.1.7-rc.2" } } },
    run,
  });
  let r = await alignDshTuiPlugins({ dshVersion: "0.1.7-rc.2", spawn: current.spawn, io, base: BASE });
  assert.equal(r.state, "current");
  assert.equal(current.calls.length, 1, "只问一次元数据");

  const newerOnly = fakeSpawn({
    latest: { json: { version: "0.12.0", peerDependencies: { "@deepseek-ai/dsh-llm": "0.1.9-rc.1" } } },
    versions: { json: { versions: ["0.11.1", "0.12.0"] } },
    run,
  });
  r = await alignDshTuiPlugins({ dshVersion: "0.1.7-rc.2", spawn: newerOnly.spawn, io, base: BASE });
  assert.equal(r.state, "incompatible-newer");
  assert.ok(newerOnly.calls.every((c) => c.args[1] === "view"), "没有适配候选时绝不安装");
});

test("对齐全流程：安装失败留档输出，dsh 版本读不出则沉默", async () => {
  const io = fakeIo({ profiles: ["dsh-tui"], manifests: { "dsh-tui": TUI_PROFILE }, installed: { "dsh-tui": "0.10.2" } });
  const failing = fakeSpawn({
    latest: { json: { version: "0.11.1", peerDependencies: { "@deepseek-ai/dsh-llm": "0.1.7-rc.2" } } },
    run: { error: true, stderr: "pnpm broke" },
  });
  let r = await alignDshTuiPlugins({ dshVersion: "0.1.7-rc.2", spawn: failing.spawn, io, base: BASE });
  assert.equal(r.state, "failed");
  assert.equal(r.profiles[0].output, "pnpm broke", "失败输出留给 detail");
  assert.equal(failing.calls.length, 2, "一次失败的对齐 = npm view + plugin add 两次 spawn");

  // 增量断言：记下第二次调用前的累计数，只认「这一次调用没起新进程」，
  // 而不是两次调用的累计值——累计值分不清「第二次 0 次」和「第一次少 1 次」。
  const spawnsBefore = failing.calls.length;
  r = await alignDshTuiPlugins({ dshVersion: "unknown", spawn: failing.spawn, io, base: BASE });
  assert.equal(r.state, "unknown");
  assert.equal(failing.calls.length, spawnsBefore, "dsh 版本读不出时一个进程都不起");
});

test("对齐全流程：TUI 会话在跑时跳过对齐，状态落 failed 且不起任何进程", async () => {
  const io = fakeIo({ profiles: ["dsh-tui"], manifests: { "dsh-tui": TUI_PROFILE }, installed: { "dsh-tui": "0.10.2" } });
  const { calls, spawn } = fakeSpawn({
    latest: { json: { version: "0.11.1", peerDependencies: { "@deepseek-ai/dsh-llm": "0.1.7-rc.2" } } },
    run: { stdout: "added" },
  });
  const r = await alignDshTuiPlugins({ dshVersion: "0.1.7-rc.2", spawn, io, base: BASE, sessionRunning: () => true });
  assert.equal(r.state, "failed", "复用「自动更新未完成，可稍后手工更新」的既有结果状态");
  assert.deepEqual(r.profiles, []);
  assert.equal(calls.length, 0, "会话在跑时连元数据查询都不发");
  assert.throws(() => io.readFileSync(join(FIXTURE_HOME, "profiles", "dsh-tui", "pnpm-workspace.yaml"), "utf8"), /ENOENT/, "profile 也不被预置");
});

test("对齐全流程：没声明插件的 profile 不被代装，npm 缺失如实失败", async () => {
  const io = fakeIo({ profiles: ["web"], manifests: { web: { dependencies: {} } } });
  const { calls, spawn } = fakeSpawn({});
  const r = await alignDshTuiPlugins({ dshVersion: "0.1.7-rc.2", spawn, io, base: BASE });
  assert.equal(r.state, "none");
  assert.equal(calls.length, 0, "没有对齐对象时一个进程都不起");

  const noNpm = fakeIo({
    profiles: ["dsh-tui"],
    manifests: { "dsh-tui": TUI_PROFILE },
    installed: { "dsh-tui": "0.10.2" },
    npmCliExists: false,
  });
  const r2 = await alignDshTuiPlugins({ dshVersion: "0.1.7-rc.2", spawn, io: noNpm, base: BASE });
  assert.equal(r2.state, "failed");
  assert.equal(calls.length, 0, "npm 缺失时连元数据查询都不发");
});

test("profile 发现：readdir 失败按无对齐对象处理，不抛出", () => {
  const io = { existsSync: () => false, readFileSync: () => { throw new Error("x"); }, readdirSync: () => { throw new Error("EPERM"); } };
  assert.deepEqual(findDshTuiProfiles({ dshHome: "C:/nowhere", io }), []);
});

test("dshTuiSessionRunning：以 ~/.dsh-tui/last-run.json 的存活 pid 判定，读不出一律按没在跑", () => {
  const home = "C:/fixture/user";
  const recordPath = join(home, ".dsh-tui", "last-run.json");
  const ioWith = (body) => ({
    readFileSync: (path) => {
      if (path === recordPath && body !== undefined) return JSON.stringify(body);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });
  const alive = (pid) => pid === 4321;
  assert.equal(dshTuiSessionRunning({ base: { USERPROFILE: home }, io: ioWith({ pid: 4321 }), alive }), true, "记录存在且 pid 活着");
  assert.equal(dshTuiSessionRunning({ base: { USERPROFILE: home }, io: ioWith({ pid: 999 }), alive }), false, "pid 已退出按没在跑");
  assert.equal(dshTuiSessionRunning({ base: { HOME: home }, io: ioWith({ pid: 4321 }), alive }), true, "USERPROFILE 缺失时 HOME 兜底");
  assert.equal(dshTuiSessionRunning({ base: { USERPROFILE: home }, io: ioWith(undefined), alive }), false, "记录读不出按没在跑");
  assert.equal(dshTuiSessionRunning({ base: { USERPROFILE: home }, io: ioWith({ pid: "4321" }), alive }), false, "pid 不是整数按没在跑");
  assert.equal(dshTuiSessionRunning({ base: { USERPROFILE: home }, io: ioWith({ pid: 0 }), alive }), false, "pid 非正数按没在跑");
  assert.equal(dshTuiSessionRunning({ base: {}, io: ioWith({ pid: 4321 }), alive }), false, "家目录缺失绝不拿相对路径碰当前工作目录");

  // 真盘再走一遍读写路径：临时 USERPROFILE + 真实 fs（alive 注入，免碰真进程）。
  const realHome = mkTestDir("dsh-tui-session-");
  mkdirSync(join(realHome, ".dsh-tui"), { recursive: true });
  writeFileSync(join(realHome, ".dsh-tui", "last-run.json"), JSON.stringify({ pid: 4321 }));
  assert.equal(dshTuiSessionRunning({ base: { USERPROFILE: realHome }, alive: (pid) => pid === 4321 }), true);
});

test("profile 预置：三道闸幂等，用户已写的决定与无关条目不被覆盖", () => {
  const profileDir = join(FIXTURE_HOME, "profiles", "dsh-tui");
  const yamlPath = join(profileDir, "pnpm-workspace.yaml");
  const files = new Map();
  const dirs = new Set([profileDir]);
  const io = {
    existsSync: (path) => dirs.has(path) || files.has(path),
    readFileSync: (path) => {
      if (files.has(path)) return files.get(path);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    writeFileSync: (path, content) => {
      if (!dirs.has(dirname(path))) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      files.set(path, String(content));
    },
  };
  // 用户已写的 allowBuilds 决定（显式 true）与别人的 release-age 条目先就位。
  files.set(yamlPath, [
    "allowBuilds:",
    "  esbuild: true",
    "",
    "minimumReleaseAgeExclude:",
    "  - '@other/pkg@1.0.0'",
  ].join("\n") + "\n");
  const seed = () => seedProfileWorkspace({ io, profileDir, targetVersion: "0.11.1", installedVersion: "0.10.2", platform: "win32", cpu: "x64" });
  seed();
  const text = io.readFileSync(yamlPath, "utf8");
  assert.match(text, /^  esbuild: true$/mu, "用户显式 true 保留，不重写为 false");
  assert.match(text, /^  '@google\/genai': false$/mu, "只补缺失的键");
  assert.match(text, /^  - '@other\/pkg@1\.0\.0'$/mu, "别人的 release-age 条目逐字保留");
  assert.match(text, /^  - '@deepseek-harness-tui\/dsh-tui@0\.11\.1'$/mu);
  assert.match(text, /^  - '@deepseek-harness-tui\/dsh-tui@0\.10\.2'$/mu);
  assert.ok(text.indexOf(`- '${DSH_TUI_PACKAGE}@0.11.1'`) < text.indexOf(`- '${DSH_TUI_PACKAGE}@0.10.2'`), "本包条目目标版在前（11.7.x 只认第一条）");
  assert.ok(!text.includes("'@img/sharp-win32-x64'"), "当前平台的原生包绝不忽略");
  assert.match(text, /^  - '@img\/sharp-win32-arm64'$/mu, "其它平台照单忽略");

  const second = seed();
  assert.deepEqual(second, { allowBuilds: { changed: false }, releaseAge: { changed: false }, sharp: { changed: false } }, "第二轮无变化即不改写");
  assert.equal(io.readFileSync(yamlPath, "utf8"), text, "幂等：第二轮不再动文件");
});
