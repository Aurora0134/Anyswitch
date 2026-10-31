import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BACKUP_ROOT_FILE,
  applyBackupRoot,
  backupRootInfo,
  defaultBackupRoot,
  migrateBackups,
  readBackupRoot,
} from "./backup-location.mjs";

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
