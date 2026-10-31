// 备份位置：配置备份的存放目录。
//
// 两类备份都落在这里：导入配置包前对整份配置的备份（pre-import-<ts>/），
// 导入本地渠道并移除原配置前对原文件的备份（byok-import-<ts>/）。
// 默认 <数据根>/backups；用户可在「设置 → 高级选项」更换。位置只记在本机的
// backup-root.json，不随配置包导出——那是这台机器的路径事实，换机导入没有意义。
//
// 迁移语义（用户裁决「更换位置时已有备份一并迁移」）：
//   1. 目标里已有同名项就整次拒绝，一个字节都不动；
//   2. 先全部复制到目标，任一失败就删掉这次复制的副本，源不动；
//   3. 复制全部成功后删源；删不掉的留在原位，名字进 undeleted 交回调用方；
//   4. 源目录空了才移除，非空保留。
// 失败路径因此永远能对用户说「未做任何改动」。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { atomicWriteFile } from "./atomic-write.mjs";

export const BACKUP_ROOT_FILE = "backup-root.json";

// Windows 路径不区分大小写；比较一律走小写规范化，避免 D:\Backups 与 d:\backups
// 被当成两个目录，迁移时自己搬自己。
const norm = (p) => resolve(p).toLowerCase();

export function defaultBackupRoot(root) {
  return join(root, "backups");
}

export function backupRootFile(root) {
  return join(root, BACKUP_ROOT_FILE);
}

// 只接受绝对路径，且拒绝盘符根：把备份直接铺在 D:\ 根上不是可用配置。
function usableTarget(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;
  const abs = resolve(trimmed);
  if (abs === parse(abs).root) return null;
  return abs;
}

export function readBackupRoot(root) {
  try {
    const parsed = JSON.parse(readFileSync(backupRootFile(root), "utf8"));
    const stored = usableTarget(parsed?.root);
    if (stored) return stored;
  } catch {
    // 缺失、坏 JSON、无权限读：一律回默认。备份位置不该因为一个坏文件把导入堵死。
  }
  return defaultBackupRoot(root);
}

export function backupRootInfo(root) {
  const path = readBackupRoot(root);
  return { path, isDefault: norm(path) === norm(defaultBackupRoot(root)) };
}

function writeBackupRoot(root, target) {
  atomicWriteFile(backupRootFile(root), `${JSON.stringify({ root: target }, null, 2)}\n`);
}

function clearBackupRoot(root) {
  // force:true 时文件不存在也不报错；其余失败要抛出去——位置没删掉就等于没恢复默认。
  rmSync(backupRootFile(root), { force: true });
}

function inside(child, parent) {
  const c = norm(child);
  const p = norm(parent);
  return c !== p && c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
}

// 把 from 下的条目整体搬到 to。成功时 from 为空则连目录一起移除。
export function migrateBackups(from, to) {
  const src = usableTarget(from);
  const dst = usableTarget(to);
  if (!src || !dst) return { ok: false, error: "路径不可用" };
  if (norm(src) === norm(dst)) return { ok: true, moved: 0 };
  // 互为父子会让复制把目标建进源里（或反过来），先拦下。
  if (inside(src, dst) || inside(dst, src)) {
    return { ok: false, error: "目标与当前文件夹不能互为父子目录" };
  }

  const names = existsSync(src) ? readdirSync(src) : [];
  mkdirSync(dst, { recursive: true });
  if (!names.length) {
    try { rmdirSync(src); } catch { /* 非空或被占用就留着 */ }
    return { ok: true, moved: 0 };
  }

  const clash = names.find((name) => existsSync(join(dst, name)));
  if (clash) return { ok: false, error: `目标里已有同名项 ${clash}` };

  const copied = [];
  try {
    for (const name of names) {
      cpSync(join(src, name), join(dst, name), { recursive: true });
      copied.push(name);
    }
  } catch (error) {
    for (const name of copied) {
      try { rmSync(join(dst, name), { recursive: true, force: true }); } catch { /* 回滚尽力而为 */ }
    }
    return { ok: false, error: `复制失败：${error?.message ?? error}` };
  }

  const undeleted = [];
  for (const name of names) {
    try {
      rmSync(join(src, name), { recursive: true, force: true });
    } catch {
      undeleted.push(name);
    }
  }
  if (!undeleted.length) {
    try { rmdirSync(src); } catch { /* 还有别的写入方，留着 */ }
  }
  return { ok: true, moved: names.length, undeleted };
}

// target 为 null 表示恢复默认。迁移成功才落盘新位置，失败时本机设置保持原样。
export function applyBackupRoot({ root, target = null }) {
  const def = defaultBackupRoot(root);
  const next = target === null ? def : usableTarget(target);
  if (!next) return { ok: false, error: "路径不可用" };

  const current = readBackupRoot(root);
  const moved = migrateBackups(current, next);
  if (!moved.ok) return moved;

  try {
    if (norm(next) === norm(def)) clearBackupRoot(root);
    else writeBackupRoot(root, next);
  } catch (error) {
    // 位置没记住就不算改成功：把刚搬过去的搬回来，保持「失败 = 未做任何改动」。
    const back = migrateBackups(next, current);
    const reason = error?.message ?? error;
    return {
      ok: false,
      error: back.ok ? `位置记录失败：${reason}` : `位置记录失败：${reason}；备份现在在 ${next}`,
    };
  }

  return { ok: true, path: next, moved: moved.moved, undeleted: moved.undeleted ?? [] };
}
