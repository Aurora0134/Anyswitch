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

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { atomicWriteFile } from "../store/atomic-write.mjs";

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

// 把 from 下的条目整体搬到 to。成功时 from 为空则连目录一起移除；
// 成功返回带 copied（本次实际复制的条目名），供调用方在后续步骤失败时专用回滚。
export function migrateBackups(from, to) {
  const src = usableTarget(from);
  const dst = usableTarget(to);
  if (!src || !dst) return { ok: false, error: "路径不可用" };
  if (norm(src) === norm(dst)) return { ok: true, moved: 0, copied: [] };
  // 互为父子会让复制把目标建进源里（或反过来），先拦下。
  if (inside(src, dst) || inside(dst, src)) {
    return { ok: false, error: "目标与当前文件夹不能互为父子目录" };
  }

  let names;
  try {
    names = existsSync(src) ? readdirSync(src) : [];
    mkdirSync(dst, { recursive: true });
  } catch (error) {
    // 读源目录、建目标目录同样会失败（权限、目标被同名文件占用等）：
    // 与路径校验同一类业务拒绝，一个字节未动，不让异常穿透成 500。
    return { ok: false, error: `路径不可用：${error?.message ?? error}` };
  }
  if (!names.length) {
    try { rmdirSync(src); } catch { /* 非空或被占用就留着 */ }
    return { ok: true, moved: 0, copied: [] };
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
  return { ok: true, moved: names.length, undeleted, copied };
}

// 位置落盘失败后的专用回滚：只处理本次 copied 点名的条目，目标目录里的异名
// 内容（用户预置、其他写入方）一个字节都不碰。源有同名残留说明正向迁移删源时
// 它没删掉（undeleted），残留即原数据、与副本同源，删掉目标副本即可；否则把
// 副本搬回源（rename 优先，跨卷 EXDEV 退回复制＋删副本）。逐条尽力而为；
// 没收尾的条目名交回调用方，由它决定要不要报「备份现在在 <next>」。
function rollbackMigration(src, dst, copied) {
  const pending = [];
  // 正向迁移在删净后会顺手移除源目录，搬回去之前先把它建回来。
  try { mkdirSync(src, { recursive: true }); } catch { /* 失败不拦，逐条搬回时各自再试 */ }
  for (const name of copied ?? []) {
    const copyAt = join(dst, name);
    try {
      if (existsSync(join(src, name))) {
        rmSync(copyAt, { recursive: true, force: true });
      } else {
        try {
          renameSync(copyAt, join(src, name));
        } catch (error) {
          if (error?.code !== "EXDEV") throw error;
          cpSync(copyAt, join(src, name), { recursive: true });
          rmSync(copyAt, { recursive: true, force: true });
        }
      }
    } catch {
      pending.push(name);
    }
  }
  // 只收空目录：里面还有异名内容或占用时 rmdir 自然失败，目标目录原样留给用户。
  try { rmdirSync(dst); } catch { /* 非空或被占用就留着 */ }
  return pending;
}

// target 为 null 表示恢复默认。迁移成功才落盘新位置，失败时本机设置保持原样。
export function applyBackupRoot({ root, target = null }) {
  const def = defaultBackupRoot(root);
  const next = target === null ? def : usableTarget(target);
  if (!next) return { ok: false, error: "路径不可用" };

  const current = readBackupRoot(root);
  let moved;
  try {
    moved = migrateBackups(current, next);
  } catch (error) {
    // migrateBackups 内部已把已知失败收成 {ok:false}；这层兜底双保险，
    // 任何漏网异常都不得穿透路由落成 500。
    return { ok: false, error: `路径不可用：${error?.message ?? error}` };
  }
  if (!moved.ok) return moved;

  try {
    if (norm(next) === norm(def)) clearBackupRoot(root);
    else writeBackupRoot(root, next);
  } catch (error) {
    // 位置没记住就不算改成功：本次搬过去的逐条搬回来，保持「失败 = 未做任何改动」。
    // 回滚确有没收尾的条目时才告诉用户备份还留在新位置。
    const pending = rollbackMigration(current, next, moved.copied);
    const reason = error?.message ?? error;
    return {
      ok: false,
      error: pending.length ? `位置记录失败：${reason}；备份现在在 ${next}` : `位置记录失败：${reason}`,
    };
  }

  return { ok: true, path: next, moved: moved.moved, undeleted: moved.undeleted ?? [] };
}

// ── 备份列表与删除 ─────────────────────────────────────────
// 列表与删除都只认两族备份目录：pre-import-<ts>/（导入配置包前整份备份）与
// byok-import-<ts>/（导入本地渠道并移除原配置前的原文件备份）。名字锚定全匹配，
// 用户在备份根里自建的同名异物不进列表、也删不到；名字内嵌零填充时间戳，
// 字典序即时间序，排序按名倒序（新→旧）。

const BACKUP_DIR_NAME_RE = /^(pre-import|byok-import)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;

// 与 data-bundle.mjs 的 MANIFEST_NAME 同一文件名约定：pre-import 备份落盘时
// 写入 manifest.json（含 createdAt）；byok-import 备份没有 manifest。
const BACKUP_MANIFEST_NAME = "manifest.json";

// 递归求和目录大小；个别条目读不到（权限、竞态被删）跳过，不让一个坏条目掀翻整列。
function dirSizeBytes(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSizeBytes(full);
      else if (entry.isFile()) total += statSync(full).size;
    } catch { /* 读不到的条目跳过 */ }
  }
  return total;
}

// createdAt 优先 manifest 里的 ISO 串；没有 manifest（byok-import）或值不可用时，
// 回退到从目录名的时间戳解析（写入时按本地时间拼的，还原也用本地时间）。
function backupCreatedAt(dir, match) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, BACKUP_MANIFEST_NAME), "utf8"));
    const value = parsed?.createdAt;
    if (typeof value === "string" && !Number.isNaN(new Date(value).getTime())) return value;
  } catch { /* 无 manifest 或不可读：回退名解析 */ }
  const [, , y, mo, d, h, mi, s] = match;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).toISOString();
}

export function listBackups(root) {
  const dir = readBackupRoot(root);
  let entries = [];
  try {
    if (existsSync(dir)) entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(BACKUP_DIR_NAME_RE);
    if (!match) continue;
    const full = join(dir, entry.name);
    items.push({ name: entry.name, kind: match[1], createdAt: backupCreatedAt(full, match), sizeBytes: dirSizeBytes(full) });
  }
  items.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return items;
}

// 只删名字锚定匹配的那单个目录：名字过不了全匹配就拒绝，join 出的路径不可能
// 越出备份根。
export function deleteBackup(root, name) {
  if (typeof name !== "string" || !BACKUP_DIR_NAME_RE.test(name)) return { ok: false, error: "备份名不可用" };
  const dir = join(readBackupRoot(root), name);
  if (!existsSync(dir)) return { ok: false, error: "备份不存在" };
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
  return { ok: true };
}
