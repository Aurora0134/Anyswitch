// 终端会话栏的视图状态存储：会话归档清单 + 已移除分组目录清单（M7）。
//
// 照搬 dsh 的机制（missions/m6 §1.4 / §2.4）：
//   1. 归档 = 持久化标记 + 视图过滤。磁盘上的会话文件一概不动，取消归档只是从
//      清单移除，会话回到列表。键 = endpoint + session id——同一会话 id 在不同
//      agent 端点的存档里是不同对话，必须端点+会话双键才指得准。
//   2. 分组移除 = 把目录路径记进「已移除」清单。我们的分组按会话目录派生、没有
//      注册清单，所以「移除」动的只是这份视图状态：被移除目录的会话渲染进
//      「未分组」，会话记录与文件夹都不动。全局生效（不分 agent，dsh 工作区清单
//      同为全局）。盘上保留用户看到的原始拼写（恢复区的 title 要给完整路径），
//      归一化只用于比较与去重。
//
// 落点 %LOCALAPPDATA%\Anyswitch\terminal-rail.json（与
// terminal-conversation-bindings.json 同目录），原子写沿用 atomic-write.mjs。
// 读缓存 + 惰性加载：唯一写入方是本面板进程，与绑定库同一纪律。

import { readFileSync } from "node:fs";
import { atomicWriteFile } from "./atomic-write.mjs";

export const TERMINAL_RAIL_STORE_FILE = "terminal-rail.json";

// 目录归一化口径：与前端 terminalRailSameDir 逐字同源（小写、统一分隔符、去尾
// 斜杠）——前端拿 project 路径、后端拿用户点选时的目录路径，两侧必须是同一把尺，
// 否则「移除了还显示原分组」。多一道 trim：纯空白不是目录，真实路径也不带首尾
// 空白（带了的那是坏数据，按空值处理最安全）。
export function normalizeRailDir(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return normalized === "" ? null : normalized;
}

// 归档条目的清洗：endpoint 与 id 都必须是实言实的非空串（端点 id 同时会进查询
// 键，长度封顶与 terminalRailAgentId 的白名单同基调，防异常值把文件撑坏）。
function sanitizeArchiveEntry(value) {
  if (!value || typeof value !== "object") return null;
  const endpoint = typeof value.endpoint === "string" ? value.endpoint.trim() : "";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!endpoint || !id || endpoint.length > 64 || id.length > 256) return null;
  return { endpoint, id };
}

// 目录清单的清洗：保留原始拼写（盘上给恢复区显示完整路径用），按归一化键去重，
// 非字符串与纯空白直接拒。顺序即用户移除的先后。
function sanitizeDirList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") continue;
    const key = normalizeRailDir(item);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
export function createRailStore({ file }) {
  let loaded = null; // { archived: Map<`${endpoint}\u0000${id}`, entry>, removedGroups: string[] }

  function ensureLoaded() {
    if (loaded !== null) return;
    loaded = { archived: new Map(), removedGroups: [] };
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return; // 文件不存在或损坏：从空开始（视图状态丢了不挡面板主流程）
    }
    const archived = Array.isArray(raw?.archived) ? raw.archived : [];
    for (const entry of archived) {
      const clean = sanitizeArchiveEntry(entry);
      if (clean) loaded.archived.set(`${clean.endpoint}\u0000${clean.id}`, clean);
    }
    loaded.removedGroups = sanitizeDirList(raw?.removedGroups);
  }

  function save() {
    const archived = [...loaded.archived.values()];
    atomicWriteFile(file, JSON.stringify({ version: 1, archived, removedGroups: loaded.removedGroups }, null, 2));
  }

  return {
    // 全量快照（调用方拿到的是副本，改它不影响存储）。
    list() {
      ensureLoaded();
      return { archived: [...loaded.archived.values()], removedGroups: [...loaded.removedGroups] };
    },
    isArchived(endpoint, id) {
      ensureLoaded();
      return loaded.archived.has(`${endpoint}\u0000${id}`);
    },
    isGroupRemoved(dir) {
      ensureLoaded();
      const key = normalizeRailDir(dir);
      return key !== null && loaded.removedGroups.some((item) => normalizeRailDir(item) === key);
    },
    // 返回是否真的改变了状态（重复归档同一会话 = 无变化，调用方不必重渲）。
    archive(endpoint, id) {
      ensureLoaded();
      const clean = sanitizeArchiveEntry({ endpoint, id });
      if (!clean) return false;
      const key = `${clean.endpoint}\u0000${clean.id}`;
      if (loaded.archived.has(key)) return false;
      loaded.archived.set(key, clean);
      save();
      return true;
    },
    unarchive(endpoint, id) {
      ensureLoaded();
      const clean = sanitizeArchiveEntry({ endpoint, id });
      if (!clean) return false;
      const removed = loaded.archived.delete(`${clean.endpoint}\u0000${clean.id}`);
      if (removed) save();
      return removed;
    },
    removeGroup(dir) {
      ensureLoaded();
      if (typeof dir !== "string" || dir.trim() === "") return false;
      const key = normalizeRailDir(dir);
      if (loaded.removedGroups.some((item) => normalizeRailDir(item) === key)) return false;
      loaded.removedGroups.push(dir);
      save();
      return true;
    },
    restoreGroup(dir) {
      ensureLoaded();
      const key = normalizeRailDir(dir);
      if (key === null) return false;
      const next = loaded.removedGroups.filter((item) => normalizeRailDir(item) !== key);
      if (next.length === loaded.removedGroups.length) return false;
      loaded.removedGroups = next;
      save();
      return true;
    },
    // 测试与排查用：当前缓存的条目数。
    get size() {
      ensureLoaded();
      return loaded.archived.size + loaded.removedGroups.length;
    },
  };
}
