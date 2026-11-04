// 垫片对账测试——三个面：
//   1. 纯函数：isEndpointWired（渠道/虚拟模型/端点链三入口）、shimSetIsOurs
//      （当前形态/根路径旧形态/手写异形）。
//   2. reconcileShims 全注入跑真盘（USERPROFILE 指向临时目录、PATH 走内存假
//      件、store 与安装态注入）：装齐、幂等零写、旧形态改写、掉线撤下、装侧
//      与撤侧手写都不动、退役清理、共享 bin/ 部分在册、store 不可读整体不
//      动、PATH 期望终态一次性写入、广播恰一次、广播失败不翻红。
//   3. 路由器接线：/panel/api/sync-agents 完成后触发对账（注入即触发）；
//      不注入即不触发——「默认 null 不碰真实注册表」本身是被测行为。bare 路由
//      器配探针 logger＋进程 env 指向沙箱：默认被改成真实 reconcileShims 时，
//      真实现读沙箱 store（不存在）走整体不动分支，零落盘零注册表写，但探针
//      里会留下 "shim reconcile skipped" 日志——断言据此翻红。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHIM_SPECS, renderShimScripts, shimFileNames } from "../src/agents/shim-manager.mjs";
import { isEndpointWired, shimSetIsOurs, reconcileShims } from "../src/agents/shim-reconcile.mjs";
import { createPanelRouter } from "../src/panel/panel.mjs";

const specOf = (id) => SHIM_SPECS.find((s) => s.id === id);
const wiredStore = () => ({
  providers: { upstreamA: { models: { "model-a": { displayName: "model-a" } } } },
  routingChains: {},
  virtualModels: [],
});
const emptyStore = () => ({ providers: {}, routingChains: {}, virtualModels: [] });
// 分域重构（af65661）前的根路径形态：识别它才能改写/撤下 ≤0.7.0 的产品门牌。
const legacyFormOf = (spec) => ({ ...spec, launcher: spec.launcher.split("/").pop() });

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "shim-reconcile-test-"));
  return { home, env: { USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local") } };
}
function writeTriplet(spec, dir, form) {
  mkdirSync(dir, { recursive: true });
  const rendered = renderShimScripts(form);
  const [sh, cmd, ps1] = shimFileNames(spec);
  writeFileSync(join(dir, sh), rendered.sh);
  writeFileSync(join(dir, cmd), rendered.cmd);
  writeFileSync(join(dir, ps1), rendered.ps1);
}
function fakePathStore(initial = null) {
  const state = { value: initial, writes: [], reads: 0 };
  return {
    read: async () => { state.reads += 1; return state.value; },
    write: async (v) => { state.value = v; state.writes.push(v); },
    state,
  };
}
function makeRunner(home, { pathInitial = null, installed = () => true } = {}) {
  const storeBox = { value: wiredStore() };
  const installedBox = { value: installed };
  const pathStore = fakePathStore(pathInitial);
  const broadcast = { count: 0, fail: false };
  const logs = [];
  const run = () => reconcileShims({
    env: home.env,
    pathStore,
    broadcastFn: async () => { broadcast.count += 1; if (broadcast.fail) throw new Error("broadcast down"); },
    loadStoreFn: async () => ({ ok: true, store: storeBox.value }),
    isEndpointInstalled: (id, base) => installedBox.value(id, base),
    log: (level, message) => logs.push([level, message]),
  });
  return { run, storeBox, installedBox, pathStore, broadcast, logs };
}

test("isEndpointWired：渠道/虚拟模型/端点链三入口，链是端点维度", () => {
  assert.equal(isEndpointWired(wiredStore(), "grok"), true, "共享渠道在，全体端点接线");
  assert.equal(isEndpointWired(emptyStore(), "zcode"), false, "空 store 不接线");
  const chainStore = { providers: {}, routingChains: { zcode: { chain: [{ node: "member-a" }] } }, virtualModels: [] };
  assert.equal(isEndpointWired(chainStore, "zcode"), true, "自己的 auto 链在即接线");
  assert.equal(isEndpointWired(chainStore, "grok"), false, "别的端点的链不算");
  assert.equal(
    isEndpointWired(
      { providers: {}, routingChains: { zcode: { enabled: false, chain: [{ node: "member-a" }] } }, virtualModels: [] },
      "zcode",
    ),
    false,
    "关掉的链不算",
  );
  const vmStore = { providers: {}, routingChains: {}, virtualModels: [{ name: "vm-a", enabled: true, chain: [{ node: "member-b" }] }] };
  assert.equal(isEndpointWired(vmStore, "pi"), true, "启用的虚拟模型是共享面");
  assert.equal(
    isEndpointWired({ providers: {}, routingChains: {}, virtualModels: [{ name: "vm-a", enabled: false, chain: [{ node: "member-b" }] }] }, "pi"),
    false,
    "停用的虚拟模型不算",
  );
});

test("shimSetIsOurs：当前形态与根路径旧形态认领，手写异形不认", () => {
  const home = makeHome();
  try {
    const grok = specOf("grok");
    const dir = join(home.home, ".config", "anyswitch-bin", "bin-grok");
    writeTriplet(grok, dir, grok);
    assert.equal(shimSetIsOurs(grok, dir, { existsSync: () => true, readFileSync: (p) => "hand-made" }), false, "全手写不认");
    writeTriplet(grok, dir, grok);
    const realFs = { existsSync: (p) => true, readFileSync: (p) => readFileSync(p, "utf8") };
    assert.equal(shimSetIsOurs(grok, dir, realFs), true, "当前形态认");
    writeTriplet(grok, dir, legacyFormOf(grok));
    assert.equal(shimSetIsOurs(grok, dir, realFs), true, "根路径旧形态认");
    // 手改一个文件，其余保持我们的形态：整个三件套按异形处理（宁可不动）
    writeFileSync(join(dir, "grok.cmd"), "custom launcher\n");
    assert.equal(shimSetIsOurs(grok, dir, realFs), false, "三件套之一被手改即整体不认");
  } finally {
    rmSync(home.home, { recursive: true, force: true });
  }
});

test("reconcile：装齐已接线且已安装的命令，目录按稳定序置顶 PATH，广播恰一次", async (t) => {
  const home = makeHome();
  t.after(() => rmSync(home.home, { recursive: true, force: true }));
  const runner = makeRunner(home, {
    pathInitial: "C:\\Windows\\System32;C:\\Windows",
    installed: (id) => id === "grok" || id === "zcode",
  });
  const report = await runner.run();
  assert.equal(report.ok, true);
  assert.deepEqual([...report.installed].sort(), ["grok", "zcode"]);
  assert.deepEqual(report.removed, []);
  const binGrok = join(home.home, ".config", "anyswitch-bin", "bin-grok");
  const bin = join(home.home, ".config", "anyswitch-bin", "bin");
  const grokRendered = renderShimScripts(specOf("grok"));
  assert.equal(readFileSync(join(binGrok, "grok.cmd"), "utf8"), grokRendered.cmd);
  assert.equal(readFileSync(join(binGrok, "grok"), "utf8"), grokRendered.sh);
  assert.equal(readFileSync(join(binGrok, "grok.ps1"), "utf8"), grokRendered.ps1);
  assert.equal(readFileSync(join(bin, "zcode.cmd"), "utf8"), renderShimScripts(specOf("zcode")).cmd);
  // PATH 期望终态一次写入：在册目录在前（SHIM_SPECS 序：grok 早于 zcode，故
  // bin-grok 在 bin 前），原有条目原样跟后
  assert.equal(runner.pathStore.state.writes.length, 1);
  assert.equal(runner.pathStore.state.value, `${binGrok};${bin};C:\\Windows\\System32;C:\\Windows`);
  assert.equal(runner.broadcast.count, 1);
  assert.ok(!runner.logs.some(([level]) => level === "warn"), "无警告");
});

test("reconcile：幂等——第二轮零写入、零广播、终态不变", async (t) => {
  const home = makeHome();
  t.after(() => rmSync(home.home, { recursive: true, force: true }));
  const runner = makeRunner(home, {
    pathInitial: "C:\\Windows\\System32;C:\\Windows",
    installed: (id) => id === "grok" || id === "zcode",
  });
  await runner.run();
  const valueAfterFirst = runner.pathStore.state.value;
  const second = await runner.run();
  assert.equal(second.ok, true);
  assert.deepEqual(second.installed, []);
  assert.deepEqual(second.rewrote, []);
  assert.deepEqual(second.removed, []);
  assert.equal(runner.pathStore.state.writes.length, 1, "PATH 不再写");
  assert.equal(runner.pathStore.state.value, valueAfterFirst);
  assert.equal(runner.broadcast.count, 1, "不再广播");
});

test("reconcile：旧根路径形态改写成当前形态（升级路径自愈的核心）", async (t) => {
  const home = makeHome();
  t.after(() => rmSync(home.home, { recursive: true, force: true }));
  const grok = specOf("grok");
  const binGrok = join(home.home, ".config", "anyswitch-bin", "bin-grok");
  writeTriplet(grok, binGrok, legacyFormOf(grok));
  const runner = makeRunner(home, { installed: (id) => id === "grok" });
  const report = await runner.run();
  assert.deepEqual(report.installed, []);
  assert.deepEqual(report.rewrote, ["grok"]);
  assert.equal(readFileSync(join(binGrok, "grok.cmd"), "utf8"), renderShimScripts(grok).cmd);
  assert.match(readFileSync(join(binGrok, "grok.cmd"), "utf8"), /src\\launchers\\grok-launcher\.mjs/);
});

test("reconcile：掉线撤下——文件清、目录清、死 PATH 条目一并清", async (t) => {
  const home = makeHome();
  t.after(() => rmSync(home.home, { recursive: true, force: true }));
  const binGrok = join(home.home, ".config", "anyswitch-bin", "bin-grok");
  const runner = makeRunner(home, {
    pathInitial: `${binGrok};C:\\Windows\\System32`,
    installed: (id) => id === "grok",
  });
  await runner.run();
  assert.ok(existsSync(join(binGrok, "grok.cmd")), "首轮已装");
  runner.storeBox.value = emptyStore();
  const second = await runner.run();
  assert.deepEqual(second.removed, ["grok"]);
  assert.ok(!existsSync(binGrok), "目录随清空移除");
  assert.equal(runner.pathStore.state.value, "C:\\Windows\\System32", "死条目随目录消失而清");
});

test("reconcile：撤侧手写门牌不动，PATH 条目保留", async (t) => {
  const home = makeHome();
  t.after(() => rmSync(home.home, { recursive: true, force: true }));
  const grok = specOf("grok");
  const binGrok = join(home.home, ".config", "anyswitch-bin", "bin-grok");
  mkdirSync(binGrok, { recursive: true });
  writeFileSync(join(binGrok, "grok.cmd"), "custom launcher\n");
  const runner = makeRunner(home, {
    pathInitial: `${binGrok};C:\\Windows`,
    installed: (id) => id === "grok",
  });
  runner.storeBox.value = emptyStore();
  const report = await runner.run();
  assert.deepEqual(report.keptForeign, ["grok"]);
  assert.equal(readFileSync(join(binGrok, "grok.cmd"), "utf8"), "custom launcher\n");
  assert.equal(runner.pathStore.state.value, `${binGrok};C:\\Windows`, "目录在，条目保留");
});

test("reconcile：装侧手写门牌不覆盖（尊重自定义启动器，宁可少装）", async (t) => {
  const home = makeHome();
  t.after(() => rmSync(home.home, { recursive: true, force: true }));
  const grok = specOf("grok");
  const binGrok = join(home.home, ".config", "anyswitch-bin", "bin-grok");
  mkdirSync(binGrok, { recursive: true });
  writeFileSync(join(binGrok, "grok.cmd"), "custom launcher\n");
  const runner = makeRunner(home, { installed: (id) => id === "grok" });
  const report = await runner.run();
  assert.deepEqual(report.keptForeign, ["grok"]);
  assert.deepEqual(report.installed, []);
  assert.equal(readFileSync(join(binGrok, "grok.cmd"), "utf8"), "custom launcher\n");
  assert.equal(runner.pathStore.state.writes.length, 0, "无目录在册，PATH 不动");
});

test("reconcile：退役命令（agy）的产品形态文件自愈清除", async (t) => {
  const home = makeHome();
  t.after(() => rmSync(home.home, { recursive: true, force: true }));
  const agy = specOf("agy");
  assert.equal(agy.retired, true);
  const bin = join(home.home, ".config", "anyswitch-bin", "bin");
  writeTriplet(agy, bin, legacyFormOf(agy));
  const runner = makeRunner(home, { pathInitial: `${bin};C:\\Windows`, installed: () => false });
  const report = await runner.run();
  assert.deepEqual(report.removed, ["agy"]);
  assert.ok(!existsSync(bin), "bin 清空后移除");
  assert.equal(runner.pathStore.state.value, "C:\\Windows");
});

test("reconcile：共享 bin/ 部分在册——未要的命令清掉，目录与 PATH 条目保留", async (t) => {
  const home = makeHome();
  t.after(() => rmSync(home.home, { recursive: true, force: true }));
  const dsh = specOf("dsh");
  const zcode = specOf("zcode");
  const bin = join(home.home, ".config", "anyswitch-bin", "bin");
  writeTriplet(dsh, bin, legacyFormOf(dsh)); // 旧形态的 dsh-cli 三件套
  const runner = makeRunner(home, {
    pathInitial: "C:\\Windows\\System32",
    installed: (id) => id === "zcode",
  });
  const report = await runner.run();
  assert.deepEqual(report.installed, ["zcode"]);
  assert.deepEqual(report.removed, ["dsh"]);
  assert.equal(readFileSync(join(bin, "zcode.cmd"), "utf8"), renderShimScripts(zcode).cmd);
  assert.ok(!existsSync(join(bin, "dsh-cli.cmd")), "未在册命令清掉");
  assert.ok(existsSync(bin), "zcode 还在，共享目录保留");
  assert.equal(runner.pathStore.state.value, `${bin};C:\\Windows\\System32`, "共享目录条目恰一条");
});

test("reconcile：store 不可读——整体不动，PATH 零读零写", async (t) => {
  const home = makeHome();
  t.after(() => rmSync(home.home, { recursive: true, force: true }));
  const pathStore = fakePathStore("C:\\Windows");
  const logs = [];
  const report = await reconcileShims({
    env: home.env,
    pathStore,
    broadcastFn: async () => {},
    loadStoreFn: async () => ({ ok: false, reason: "absent" }),
    isEndpointInstalled: () => true,
    log: (level, message) => logs.push([level, message]),
  });
  assert.equal(report.ok, false);
  assert.equal(report.reason, "store_unreadable");
  assert.equal(pathStore.state.reads, 0, "PATH 根本不读");
  assert.equal(pathStore.state.writes.length, 0);
  assert.ok(!existsSync(join(home.home, ".config", "anyswitch-bin")), "零落盘");
  assert.ok(logs.some(([level, message]) => level === "warn" && message.includes("store not usable")));
});

test("reconcile：PATH 写入失败降级为 pathError，文件面照常收敛", async (t) => {
  const home = makeHome();
  t.after(() => rmSync(home.home, { recursive: true, force: true }));
  const pathStore = {
    read: async () => "C:\\Windows",
    write: async () => { throw new Error("registry locked"); },
  };
  const report = await reconcileShims({
    env: home.env,
    pathStore,
    broadcastFn: async () => {},
    loadStoreFn: async () => ({ ok: true, store: wiredStore() }),
    isEndpointInstalled: (id) => id === "grok",
    log: () => {},
  });
  assert.equal(report.ok, true);
  assert.equal(report.pathError, "registry locked");
  assert.equal(report.pathChanged, false);
  assert.deepEqual(report.installed, ["grok"], "文件照装");
});

test("reconcile：广播失败不翻红（PATH 已写、ok 仍真）", async (t) => {
  const home = makeHome();
  t.after(() => rmSync(home.home, { recursive: true, force: true }));
  const runner = makeRunner(home, { installed: (id) => id === "grok" });
  runner.broadcast.fail = true;
  const report = await runner.run();
  assert.equal(report.ok, true);
  assert.equal(report.pathChanged, true);
  assert.equal(runner.pathStore.state.writes.length, 1);
  assert.ok(runner.logs.some(([level, message]) => level === "warn" && message.includes("broadcast failed")));
});

test("路由器：同步完成后触发对账；不注入（默认 null）即不触发", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "shim-reconcile-route-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const baseOptions = {
    storePaths: { root },
    logger: null,
    metricsCollector: null,
    spawnAgentSyncFn: async () => ({ ok: true, stdout: "" }),
  };
  const router = createPanelRouter({
    ...baseOptions,
    reconcileShimsFn: async (deps) => { calls.push(deps); return { ok: true }; },
  });
  const first = fakeReqRes("/panel/api/sync-agents", "POST");
  await router.handle(first.req, first.res);
  assert.equal(first.res.statusCode, 200);
  assert.equal(calls.length, 1, "同步完成即触发对账（fire-and-forget 但调用本身同步发生）");

  // 后半段：bare（不注入 reconcileShimsFn）必须真的什么都不做。只断
  // calls.length 挡不住「默认从 null 改成真实 reconcileShims」的回归——calls
  // 只被上面注入的闭包 push，bare 结构上碰不到，用例会静默全绿，而真实实现
  // 会拿默认依赖（真 process.env、真注册表 pathStore、loadStore(storePaths())）
  // 去改写开发机。这里换成可观测探针：给 bare 配探针 logger（reconcileShims
  // 的 log 参数经 panel.mjs 桥接到 logger 上），并把进程 env 临时指向沙箱。
  // 真实实现若真跑起来，默认 loadStoreFn 读的是沙箱 store（不存在 →
  // store_unreadable 整体不动：不建目录、不碰注册表），既保证零落盘零写，
  // 又会在探针里留下一条 "shim reconcile skipped" warn——那条日志就是本断
  // 言红/绿的判据。默认 null 时 fire-and-forget 链路整个不存在，探针保持无
  // 任何垫片对账日志。
  const bareLogs = [];
  const bare = createPanelRouter({
    ...baseOptions,
    logger: {
      info: (message) => bareLogs.push(["info", message]),
      warn: (message) => bareLogs.push(["warn", message]),
      error: (message) => bareLogs.push(["error", message]),
    },
  });
  const envBackup = { USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA };
  try {
    process.env.USERPROFILE = root;
    process.env.LOCALAPPDATA = join(root, "AppData", "Local");
    const second = fakeReqRes("/panel/api/sync-agents", "POST");
    await bare.handle(second.req, second.res);
    assert.equal(second.res.statusCode, 200);
    // fire-and-forget：真实 reconcile（若默认被改成真实现）在这几拍里跑完
    // 才把日志落进探针，drain 之后才能下断言。
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      !bareLogs.some(([, message]) => String(message).includes("shim")),
      "不注入即不触发——bare 的同步不得产生任何垫片对账日志（默认 null 被改成真实 reconcileShims 时这里必须红）",
    );
    assert.equal(calls.length, 1, "实例隔离：bare 的同步不触发第一个路由器注入的对账函数");
  } finally {
    process.env.USERPROFILE = envBackup.USERPROFILE;
    process.env.LOCALAPPDATA = envBackup.LOCALAPPDATA;
  }
});

function fakeReqRes(path, method) {
  const req = new EventEmitter();
  req.method = method;
  req.url = path;
  req.headers = { host: "127.0.0.1", origin: "http://127.0.0.1:47820", "x-anyswitch-panel": "1" };
  req.socket = { remoteAddress: "127.0.0.1" };
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = {};
  res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers ?? {}); };
  const chunks = [];
  res.end = (chunk) => { if (chunk) chunks.push(String(chunk)); };
  res.json = () => JSON.parse(chunks.join("") || "null");
  return { req, res, json: () => res.json() };
}
