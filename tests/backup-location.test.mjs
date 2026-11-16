import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  BACKUP_ROOT_FILE,
  applyBackupRoot,
  backupRootInfo,
  defaultBackupRoot,
  deleteBackup,
  listBackups,
  migrateBackups,
  readBackupRoot,
} from "../src/ops/backup-location.mjs";
import { createDataBundleService } from "../src/store/data-bundle.mjs";
import { ensureLayout, storePaths, writeStore } from "../src/store/store-io.mjs";
import { createPanelRouter } from "../src/panel/panel.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

// 备份位置是纯文件系统逻辑：全部在临时目录里跑，不碰真实 LOCALAPPDATA。
function machine() {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-backup-location-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function seed(dir, names = {}) {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(names)) writeFileSync(join(dir, name), text, "utf8");
}

test("默认位置是数据根下的 backups，没有本机记录时 info 标默认", () => {
  const m = machine();
  try {
    assert.equal(readBackupRoot(m.root), join(m.root, "backups"));
    assert.deepEqual(backupRootInfo(m.root), { path: join(m.root, "backups"), isDefault: true });
  } finally { m.cleanup(); }
});

test("本机记录损坏、相对路径、盘符根一律回默认——坏文件不能把导入堵死", () => {
  const m = machine();
  try {
    for (const text of ["{ 不是 JSON", JSON.stringify({ root: "relative\\backups" }), JSON.stringify({ root: "C:\\" })]) {
      writeFileSync(join(m.root, BACKUP_ROOT_FILE), text, "utf8");
      assert.equal(readBackupRoot(m.root), join(m.root, "backups"));
    }
  } finally { m.cleanup(); }
});

test("换位置：历史备份整体迁走、源目录清空、位置落盘", () => {
  const m = machine();
  try {
    const from = join(m.root, "backups");
    const to = join(m.root, "elsewhere", "backups");
    seed(join(from, "pre-import-20261031-120000"), { "store.json": "{\"beta\":1}" });
    seed(join(from, "byok-import-20261031-121000", "kimi"), { "config.toml": "x" });

    const result = applyBackupRoot({ root: m.root, target: to });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.path, to);
    assert.equal(result.moved, 2);
    assert.equal(existsSync(from), false, "源目录空了要移除");
    assert.equal(readFileSync(join(to, "pre-import-20261031-120000", "store.json"), "utf8"), "{\"beta\":1}");
    assert.equal(existsSync(join(to, "byok-import-20261031-121000", "kimi", "config.toml")), true);
    assert.deepEqual(JSON.parse(readFileSync(join(m.root, BACKUP_ROOT_FILE), "utf8")), { root: to });
    assert.deepEqual(backupRootInfo(m.root), { path: to, isDefault: false });
  } finally { m.cleanup(); }
});

test("恢复默认：备份搬回默认目录并删掉本机记录", () => {
  const m = machine();
  try {
    const custom = join(m.root, "D-drive", "backups");
    seed(join(custom, "pre-import-1"), { "store.json": "{}" });
    writeFileSync(join(m.root, BACKUP_ROOT_FILE), JSON.stringify({ root: custom }), "utf8");

    const result = applyBackupRoot({ root: m.root, target: null });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.path, defaultBackupRoot(m.root));
    assert.equal(existsSync(join(defaultBackupRoot(m.root), "pre-import-1", "store.json")), true);
    assert.equal(existsSync(join(m.root, BACKUP_ROOT_FILE)), false);
    assert.equal(backupRootInfo(m.root).isDefault, true);
  } finally { m.cleanup(); }
});

test("目标有同名项：整次拒绝，源、目标、本机记录一个字节都不动", () => {
  const m = machine();
  try {
    const from = join(m.root, "backups");
    const to = join(m.root, "elsewhere");
    seed(join(from, "pre-import-1"), { "store.json": "source" });
    seed(join(to, "pre-import-1"), { "store.json": "target" });

    const result = applyBackupRoot({ root: m.root, target: to });
    assert.equal(result.ok, false);
    assert.match(result.error, /pre-import-1/);
    assert.equal(readFileSync(join(from, "pre-import-1", "store.json"), "utf8"), "source");
    assert.equal(readFileSync(join(to, "pre-import-1", "store.json"), "utf8"), "target");
    assert.equal(existsSync(join(m.root, BACKUP_ROOT_FILE)), false, "失败不落盘新位置");
    assert.equal(readBackupRoot(m.root), from);
  } finally { m.cleanup(); }
});

test("目标与当前目录互为父子：拒绝，不递归搬自己", () => {
  const m = machine();
  try {
    const from = join(m.root, "backups");
    seed(join(from, "pre-import-1"), { "store.json": "{}" });
    for (const to of [join(from, "nested"), m.root]) {
      const result = applyBackupRoot({ root: m.root, target: to });
      assert.equal(result.ok, false);
      assert.match(result.error, /父子目录/);
    }
    assert.equal(readFileSync(join(from, "pre-import-1", "store.json"), "utf8"), "{}");
  } finally { m.cleanup(); }
});

test("同一路径是空操作：不复制、不删源、成功返回", () => {
  const m = machine();
  try {
    const from = join(m.root, "backups");
    seed(join(from, "pre-import-1"), { "store.json": "{}" });
    const result = migrateBackups(from, from);
    assert.deepEqual(result, { ok: true, moved: 0 });
    assert.equal(existsSync(join(from, "pre-import-1", "store.json")), true);
  } finally { m.cleanup(); }
});

test("源目录不存在：只建目标目录，不报错", () => {
  const m = machine();
  try {
    const to = join(m.root, "fresh");
    const result = applyBackupRoot({ root: m.root, target: to });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.moved, 0);
    assert.equal(existsSync(to), true);
    assert.equal(backupRootInfo(m.root).path, to);
  } finally { m.cleanup(); }
});

// ── 位置记录失败后的回滚分支（backup-location.mjs 迁移成功、落盘/清除失败）──
// 不注入 fs 的复现方式：在 backup-root.json 的路径上摆一个同名目录——写记录的
// rename 与清记录的 rmSync 都会原地失败，迁移却已经真实发生。
test("换位置时记录写失败：已搬走的备份搬回原位，整次拒绝", () => {
  const m = machine();
  try {
    const from = join(m.root, "backups");
    const to = join(m.root, "elsewhere", "backups");
    seed(join(from, "pre-import-20261115-100000"), { "store.json": "{\"beta\":1}" });
    seed(join(from, "byok-import-20261115-101000", "kimi"), { "config.toml": "x" });
    // 摆一个目录占住记录路径：写记录必败，且之后还能断言「位置没被记住」。
    mkdirSync(join(m.root, BACKUP_ROOT_FILE), { recursive: true });

    const result = applyBackupRoot({ root: m.root, target: to });
    assert.equal(result.ok, false, "位置没记住就不算改成功");
    assert.match(result.error, /位置记录失败/);
    assert.equal(result.error.includes("备份现在在"), false, "回滚成功时不得报「留在新位置」的变体");

    // 回滚：两份备份都回到默认目录，新位置不留副本。
    assert.equal(readFileSync(join(defaultBackupRoot(m.root), "pre-import-20261115-100000", "store.json"), "utf8"), "{\"beta\":1}");
    assert.equal(existsSync(join(defaultBackupRoot(m.root), "byok-import-20261115-101000", "kimi", "config.toml")), true);
    assert.equal(existsSync(join(to, "pre-import-20261115-100000")), false, "新位置不留副本");
    // 位置没被记住：记录路径仍是占位目录，读取仍回默认。
    assert.equal(statSync(join(m.root, BACKUP_ROOT_FILE)).isDirectory(), true);
    assert.equal(readBackupRoot(m.root), defaultBackupRoot(m.root));
  } finally { m.cleanup(); }
});

test("恢复默认时记录清除失败：备份已在默认位，整次拒绝不落盘新记录", () => {
  const m = machine();
  try {
    seed(join(defaultBackupRoot(m.root), "pre-import-1"), { "store.json": "{}" });
    mkdirSync(join(m.root, BACKUP_ROOT_FILE), { recursive: true });

    const result = applyBackupRoot({ root: m.root, target: null });
    assert.equal(result.ok, false);
    assert.match(result.error, /位置记录失败/);
    assert.equal(readFileSync(join(defaultBackupRoot(m.root), "pre-import-1", "store.json"), "utf8"), "{}", "备份原位不动");
    assert.equal(statSync(join(m.root, BACKUP_ROOT_FILE)).isDirectory(), true, "记录路径没被换成文件");
    assert.equal(backupRootInfo(m.root).isDefault, true);
  } finally { m.cleanup(); }
});

// ── 接线：用户改过的备份位置要真实生效 ─────────────────────────────────────
// store.json 同目录的 backup-root.json 是唯一的用户意图记录；两条备份链路都
// 从它取位置。这两条用例故意不注入 backupRoot / backupRootFn，走产品默认装配，
// 防止「读不到记录就静默落回默认目录」的回归在默认缝上溜过去。

// 导出→预览→落定走真 bsdtar（包格式本身是被测对象之一），protect/unprotect 换
// 可逆假实现；%TEMP% 重定向到私有沙箱，预览暂存与过期清扫都只看得到沙箱。
const BUNDLE_FAKE_MARK = "enc:";
const bundleFakeProtect = async (plaintext) => Buffer.from(BUNDLE_FAKE_MARK + Buffer.from(plaintext).toString("utf8"), "utf8");
const bundleFakeUnprotect = async (ciphertext) => Buffer.from(String(ciphertext).replace(BUNDLE_FAKE_MARK, ""), "utf8");

function bundleStore(id) {
  return {
    version: 2,
    providers: {
      [id]: {
        displayName: id,
        baseURL: `https://${id}.example/v1`,
        protocol: "openai-compatible",
        credentialFile: `${id}.dpapi`,
        models: { "model-one": { displayName: "Model One" } },
      },
    },
    pools: {},
    routingChains: {},
  };
}

test("导入前备份接线：换过的备份位置生效，默认目录不再被创建", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "anyswitch-backup-wiring-"));
  const savedTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = sandbox;
  process.env.TMP = sandbox;
  delete process.env.TMPDIR;
  try {
    // 服务根按 relayDataRoot(base) 推导：<LOCALAPPDATA>\Anyswitch——种子全部落在
    // 这里，服务与断言看的是同一棵树。
    const localAppData = join(sandbox, "localappdata");
    const root = join(localAppData, "Anyswitch");
    const paths = storePaths(root);
    ensureLayout(paths);
    const beforeStoreText = JSON.stringify(bundleStore("alpha"), null, 2) + "\n";
    assert.equal(writeStore(JSON.parse(beforeStoreText), { paths }).ok, true);
    writeFileSync(join(root, "settings.json"), JSON.stringify({ followAgent: false }) + "\n", "utf8");
    writeFileSync(join(root, "prompts.json"), JSON.stringify({ presets: [] }) + "\n", "utf8");
    writeFileSync(join(paths.credentialsDir, "alpha.dpapi"), BUNDLE_FAKE_MARK + "sk-alpha", "utf8");

    // 用户改过的备份位置，只通过本机记录表达——服务用默认 backupRootFn 装配。
    const customRoot = join(sandbox, "moved-backups");
    writeFileSync(join(root, BACKUP_ROOT_FILE), JSON.stringify({ root: customRoot }) + "\n", "utf8");

    const homeDir = join(sandbox, "home");
    const exportTarget = join(sandbox, "export-target");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(exportTarget, { recursive: true });
    const service = createDataBundleService({
      base: { LOCALAPPDATA: localAppData },
      homeDir,
      protect: bundleFakeProtect,
      unprotect: bundleFakeUnprotect,
    });
    const exp = await service.exportBundle({ targetDir: exportTarget });
    assert.equal(exp.ok, true, exp.error);
    const preview = await service.previewBundle(exp.path);
    assert.equal(preview.ok, true, preview.error);
    assert.equal(typeof preview.token, "string");

    const applied = await service.applyBundle({ token: preview.token, skillsMode: "skip" });
    assert.equal(applied.ok, true, applied.error);
    assert.equal(applied.backupDir, join(customRoot, `pre-import-${applied.backupId}`), "备份落在用户改过的位置");

    // 备份内容是导入前的原样：store.json 是落定前的文本，清单记录全部已存项。
    assert.equal(readFileSync(join(applied.backupDir, "store.json"), "utf8"), beforeStoreText);
    const manifest = JSON.parse(readFileSync(join(applied.backupDir, "manifest.json"), "utf8"));
    for (const name of ["store.json", "settings.json", "prompts.json", "credentials/"]) {
      assert.ok(manifest.saved.includes(name), `manifest.saved 应含 ${name}，实得 ${JSON.stringify(manifest.saved)}`);
    }
    // 默认目录没有被静默创建：接线没读到记录时才会落回那里。
    assert.equal(existsSync(join(root, "backups")), false, "默认备份目录不应存在");
    assert.equal(readBackupRoot(root), customRoot);
  } finally {
    for (const [name, value] of Object.entries(savedTemp)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// 面板是组合根：removeFn 绑定删除器时把 readBackupRoot(relayRoot) 盖过服务的
// 默认备份目录（panel.mjs byokImportServiceLazy）。这条用例起真路由器走
// scan→apply 全链，伪造的 home 只含一个 qoder 渠道，绝不碰真实 profile。
function panelReq(router, url, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: null,
      body: "",
      _events: {},
      once(event, fn) { (this._events[event] ??= []).push(fn); return res; },
      emit(event) { for (const fn of this._events?.[event] ?? []) fn(); return true; },
      writeHead(code, h) { this.statusCode = code; this.headers = h || {}; },
      end(data) { if (data !== undefined) this.body += data; },
    };
    const listeners = {};
    const req = {
      url,
      method,
      headers: {
        host: "127.0.0.1",
        origin: "http://127.0.0.1:47820",
        "x-anyswitch-panel": "1",
      },
      on(event, fn) { listeners[event] = fn; return req; },
    };
    queueMicrotask(() => {
      try {
        if (body !== null) listeners.data?.(Buffer.from(JSON.stringify(body)));
        listeners.end?.();
      } catch (error) { reject(error); }
    });
    router.handle(req, res).then(() => {
      resolve({ statusCode: res.statusCode, payload: res.body ? JSON.parse(res.body) : null });
    }, reject);
  });
}

test("BYOK 移除接线：删除备份落在用户改过的位置，服务默认目录不被创建", async () => {
  const sandbox = mkTestDir("anyswitch-backup-wiring-byok-");
  const fakeHome = join(sandbox, "home");
  const localAppData = join(sandbox, "localappdata");
  const appData = join(sandbox, "appdata");
  const root = join(localAppData, "Anyswitch");
  const qoderSettings = join(fakeHome, ".qoder", "settings.json");
  const savedEnv = {
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };
  try {
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(appData, { recursive: true });
    mkdirSync(root, { recursive: true });
    mkdirSync(join(fakeHome, ".qoder"), { recursive: true });
    writeFileSync(qoderSettings, JSON.stringify({
      providers: {
        mine: { baseUrl: "https://q.example.com/v1", apiKey: "q-secret", models: [] },
      },
    }, null, 2) + "\n", "utf8");
    const customRoot = join(sandbox, "moved-backups");
    writeFileSync(join(root, BACKUP_ROOT_FILE), JSON.stringify({ root: customRoot }) + "\n", "utf8");

    process.env.USERPROFILE = fakeHome;
    process.env.APPDATA = appData;
    process.env.LOCALAPPDATA = localAppData;

    const router = createPanelRouter({
      storePaths: { root },
      logger: null,
      metricsCollector: null,
      startTime: 123456,
      getRelayStatusFn: async () => ({ status: "stopped", pid: null, port: 47821 }),
      startRelayFn: async () => ({ ok: true, relay: { status: "running", pid: 4242, port: 47821 } }),
      stopRelayFn: async () => ({ ok: true, relay: { status: "stopped", pid: null, port: 47821 } }),
      restartRelayFn: async () => ({ ok: true, relay: { status: "running", pid: 4243, port: 47821 } }),
      fetchRelayAgents: async () => null,
      fetchTerminalHostStatus: async () => null,
    });

    const scan = await panelReq(router, "/panel/api/byok-import/scan", "POST");
    assert.equal(scan.statusCode, 200, scan.payload && scan.payload.error);
    assert.equal(scan.payload.ok, true);
    const key = "qoder::mine";
    const group = scan.payload.groups.find((g) => g.agentId === "qoder");
    assert.ok(group?.entries.some((e) => e.key === key), "伪造 home 里的 qoder 渠道被扫出");

    const apply = await panelReq(router, "/panel/api/byok-import/apply", "POST", {
      ticket: scan.payload.ticket,
      keys: [key],
      deleteLocal: true,
    });
    assert.equal(apply.statusCode, 200, apply.payload && apply.payload.error);
    assert.equal(apply.payload.ok, true);
    assert.equal(apply.payload.imported, 1);
    assert.deepEqual(apply.payload.removed, [key]);

    // 删除备份落在用户改过的位置：byok-import-<stamp>/qoder/settings.json。
    const backupDir = apply.payload.backupDir;
    assert.equal(typeof backupDir, "string");
    assert.equal(basename(backupDir).startsWith("byok-import-"), true);
    assert.ok(
      backupDir.toLowerCase().startsWith(customRoot.toLowerCase() + "\\"),
      `备份目录就在用户位置下：${backupDir} 不在 ${customRoot} 内`,
    );
    assert.ok(readdirSync(join(backupDir, "qoder")).includes("settings.json"), "原 settings.json 已备份");
    // 本地原始条目真的被删了（渠道已入库）。
    const after = JSON.parse(readFileSync(qoderSettings, "utf8"));
    assert.equal(after.providers.mine, undefined);
    assert.equal(existsSync(join(root, "credentials", "mine.dpapi")), true, "渠道已入中心库");
    // 服务自带的默认备份目录没有被静默创建。
    assert.equal(existsSync(join(root, "backups")), false, "默认备份目录不应存在");
  } finally {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ── 备份列表与删除（「配置备份」卡的备份文件段）──────────────────────────────

test("listBackups：两族目录按名倒序（mission 口径：name 降序），createdAt 优先 manifest、回退名解析", () => {
  const m = machine();
  try {
    const dir = defaultBackupRoot(m.root);
    seed(join(dir, "pre-import-20261031-120000"), {
      "store.json": "{\"beta\":1}",
      "manifest.json": JSON.stringify({ backupId: "20261031-120000", createdAt: "2026-10-31T04:00:00.000Z", saved: ["store.json"] }),
    });
    seed(join(dir, "byok-import-20261115-101000", "kimi"), { "config.toml": "xxxx" });

    const items = listBackups(m.root);
    // 名字内嵌零填充时间戳，同族内字典序即时间序；跨族按字典序分组（pre 恒在 byok 前）。
    assert.deepEqual(items.map((i) => i.name), ["pre-import-20261031-120000", "byok-import-20261115-101000"], "按 name 降序");
    const [pre, byok] = items;
    assert.equal(byok.kind, "byok-import");
    assert.equal(pre.kind, "pre-import");
    assert.equal(pre.createdAt, "2026-10-31T04:00:00.000Z", "manifest 里的 ISO 原样采用");
    assert.equal(pre.sizeBytes, Buffer.byteLength("{\"beta\":1}") + Buffer.byteLength(JSON.stringify({ backupId: "20261031-120000", createdAt: "2026-10-31T04:00:00.000Z", saved: ["store.json"] })), "大小递归求和");
    assert.equal(byok.sizeBytes, 4, "byok 目录递归求和");
    // 无 manifest 回退名解析：目录名时间戳是本地时间拼的，还原成同一时刻的 ISO。
    const parsed = new Date(2026, 10, 15, 10, 10, 0);
    assert.equal(new Date(byok.createdAt).getTime(), parsed.getTime(), "名解析回退到目录名时间戳");
  } finally { m.cleanup(); }
});

test("listBackups：异物与散文件不进列表；备份根不存在回空；坏 manifest 回退名解析", () => {
  const m = machine();
  try {
    assert.deepEqual(listBackups(m.root), [], "备份根不存在回空，不报错");
    const dir = defaultBackupRoot(m.root);
    seed(join(dir, "pre-import-20261031-120000"), { "store.json": "{}" });
    seed(join(dir, "pre-import-20261031-120000-冗余项"), { "store.json": "{}" });
    seed(join(dir, "my-own-folder"), { "a.txt": "x" });
    seed(join(dir, "pre-import-20261101-090000"), {
      "store.json": "{}",
      "manifest.json": "{ 不是 JSON",
    });
    writeFileSync(join(dir, "loose-file.txt"), "x", "utf8");

    const items = listBackups(m.root);
    assert.deepEqual(items.map((i) => i.name), ["pre-import-20261101-090000", "pre-import-20261031-120000"],
      "同名异物、用户自建目录、散文件一律不进列表");
    assert.equal(new Date(items[0].createdAt).getTime(), new Date(2026, 10, 1, 9, 0, 0).getTime(), "坏 manifest 回退名解析");
  } finally { m.cleanup(); }
});

test("listBackups：用户改过的备份位置同样生效", () => {
  const m = machine();
  try {
    const custom = join(m.root, "moved");
    seed(join(custom, "pre-import-20261031-120000"), { "store.json": "{}" });
    writeFileSync(join(m.root, BACKUP_ROOT_FILE), JSON.stringify({ root: custom }), "utf8");
    const items = listBackups(m.root);
    assert.deepEqual(items.map((i) => i.name), ["pre-import-20261031-120000"]);
  } finally { m.cleanup(); }
});

test("deleteBackup：删掉指定备份目录；锚定外的名字与不存在的一律拒绝", () => {
  const m = machine();
  try {
    const dir = defaultBackupRoot(m.root);
    seed(join(dir, "pre-import-20261031-120000"), { "store.json": "{}" });
    seed(join(dir, "my-own-folder"), { "a.txt": "x" });

    const done = deleteBackup(m.root, "pre-import-20261031-120000");
    assert.deepEqual(done, { ok: true });
    assert.equal(existsSync(join(dir, "pre-import-20261031-120000")), false);

    for (const bad of ["my-own-folder", "../backups", "pre-import-20261031-120000/x", "pre-import-1", "", 42]) {
      const refused = deleteBackup(m.root, bad);
      assert.equal(refused.ok, false, `应拒绝：${bad}`);
    }
    assert.equal(existsSync(join(dir, "my-own-folder", "a.txt")), true, "用户自建目录一个字节不动");
    assert.equal(deleteBackup(m.root, "byok-import-20261031-120000").error, "备份不存在");
  } finally { m.cleanup(); }
});
