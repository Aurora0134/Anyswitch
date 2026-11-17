// 终端会话栏的视图状态存储：会话归档清单 + 已移除分组目录清单 + 分组显示顺序
// + 会话置顶清单。
//
// 机制：
//   1. 归档 = 持久化标记 + 视图过滤。磁盘上的会话文件一概不动，取消归档只是从
//      清单移除，会话回到列表。键 = endpoint + session id——同一会话 id 在不同
//      agent 端点的存档里是不同对话，必须端点+会话双键才指得准。归档同时摘掉
//      该会话的置顶：两态互斥，且都落在同一份持久化写里，崩溃窗口内不会出现
//      「又归档又置顶」的行。
//   2. 分组移除 = 把目录路径记进「已移除」清单。我们的分组按会话目录派生、没有
//      注册清单，所以「移除」动的只是这份视图状态：被移除目录的会话渲染进
//      「未分组」，会话记录与文件夹都不动。全局生效（不分 agent）。盘上保留
//      用户看到的原始拼写（恢复区的 title 要给完整路径），
//      归一化只用于比较与去重。
//   3. 分组顺序 = 目录清单。会话活跃与否不参与分组定位——组在左栏的位置只随
//      这份清单变（拖拽重排、新目录首现登记都由前端算出终序后全量落盘，这里
//      只认「整表替换」一种写法：两种写入方共用一条幂等路径，不给部分更新留
//      出错面）。移除分组时同步摘掉它的顺序条目：目录经自愈重现后按「新组」
//      重新登记进最顶，而不是回到被移除前的旧位置。
//   4. 会话置顶 = endpoint + session id 清单，最近置顶的在最前。置顶行在左栏
//      任何排序模式下都排在所属分组的最前；已归档的会话拒绝置顶（前端不给
//      入口，这里兜底拒写，两边判据同源）。
//
// 落点 %LOCALAPPDATA%\Anyswitch\terminal-rail.json（与
// terminal-conversation-bindings.json 同目录），原子写沿用 atomic-write.mjs。
// 读缓存 + 惰性加载：唯一写入方是本面板进程，与绑定库同一纪律。
// 文件格式向后兼容：老盘面没有 groupOrder/pinned 字段时按空清单起步，新写
// 一律带全字段。

import { readFileSync } from "node:fs";
import { atomicWriteFile } from "../store/atomic-write.mjs";

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

// 会话引用条目（归档/置顶共用形状）的清洗：endpoint 与 id 都必须是实言实的
// 非空串（端点 id 同时会进查询键，长度封顶与 terminalRailAgentId 的白名单同
// 基调，防异常值把文件撑坏）。
function sanitizeSessionRef(value) {
  if (!value || typeof value !== "object") return null;
  const endpoint = typeof value.endpoint === "string" ? value.endpoint.trim() : "";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!endpoint || !id || endpoint.length > 64 || id.length > 256) return null;
  return { endpoint, id };
}

// 目录清单的清洗：保留原始拼写（盘上给恢复区显示完整路径用），按归一化键去重，
// 非字符串与纯空白直接拒。removedGroups 的顺序即用户移除的先后，groupOrder 的
// 顺序即分组显示序——同一份清洗管两种语义，顺序都不重排。
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
  // pinned 用数组保持「最近置顶在前」的顺序语义；查成员走线性扫（清单量级是
  // 用户手动置顶过的会话数，不值得再上第二套键结构）。
  let loaded = null; // { archived: Map<`${endpoint}\u0000${id}`, entry>, removedGroups: string[], groupOrder: string[], pinned: {endpoint,id}[] }

  function ensureLoaded() {
    if (loaded !== null) return;
    loaded = { archived: new Map(), removedGroups: [], groupOrder: [], pinned: [] };
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return; // 文件不存在或损坏：从空开始（视图状态丢了不挡面板主流程）
    }
    const archived = Array.isArray(raw?.archived) ? raw.archived : [];
    for (const entry of archived) {
      const clean = sanitizeSessionRef(entry);
      if (clean) loaded.archived.set(`${clean.endpoint}\u0000${clean.id}`, clean);
    }
    loaded.removedGroups = sanitizeDirList(raw?.removedGroups);
    loaded.groupOrder = sanitizeDirList(raw?.groupOrder);
    const pinned = Array.isArray(raw?.pinned) ? raw.pinned : [];
    const seenPinned = new Set();
    for (const entry of pinned) {
      const clean = sanitizeSessionRef(entry);
      if (!clean || seenPinned.has(`${clean.endpoint}\u0000${clean.id}`)) continue;
      seenPinned.add(`${clean.endpoint}\u0000${clean.id}`);
      loaded.pinned.push(clean);
    }
  }

  function save() {
    const archived = [...loaded.archived.values()];
    atomicWriteFile(
      file,
      JSON.stringify(
        { version: 1, archived, removedGroups: loaded.removedGroups, groupOrder: loaded.groupOrder, pinned: loaded.pinned },
        null,
        2,
      ),
    );
  }

  return {
    // 全量快照（调用方拿到的是副本，改它不影响存储）。
    list() {
      ensureLoaded();
      return {
        archived: [...loaded.archived.values()],
        removedGroups: [...loaded.removedGroups],
        groupOrder: [...loaded.groupOrder],
        pinned: loaded.pinned.map((entry) => ({ ...entry })),
      };
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
    // 归档即摘置顶：互斥态收进同一份写，见文件头机制 1/4。
    archive(endpoint, id) {
      ensureLoaded();
      const clean = sanitizeSessionRef({ endpoint, id });
      if (!clean) return false;
      const key = `${clean.endpoint}\u0000${clean.id}`;
      if (loaded.archived.has(key)) return false;
      loaded.archived.set(key, clean);
      loaded.pinned = loaded.pinned.filter((entry) => `${entry.endpoint}\u0000${entry.id}` !== key);
      save();
      return true;
    },
    unarchive(endpoint, id) {
      ensureLoaded();
      const clean = sanitizeSessionRef({ endpoint, id });
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
      // 同步摘顺序条目（机制 3）：自愈重现的目录按新组重新登记进最顶。
      loaded.groupOrder = loaded.groupOrder.filter((item) => normalizeRailDir(item) !== key);
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
    // 分组显示序的全量替换。入参先过 sanitizeDirList（去重/拒空），与现值逐条
    // 相同即无变化不落盘；返回是否真的改了序（幂等重放＝false，调用方不必重渲）。
    setGroupOrder(dirs) {
      ensureLoaded();
      const next = sanitizeDirList(dirs);
      const same = next.length === loaded.groupOrder.length
        && next.every((item, index) => normalizeRailDir(item) === normalizeRailDir(loaded.groupOrder[index]));
      if (same) return false;
      loaded.groupOrder = next;
      save();
      return true;
    },
    groupOrder() {
      ensureLoaded();
      return [...loaded.groupOrder];
    },
    // 置顶：前置插入（最近置顶在最前）。已置顶＝无变化；已归档＝拒写（互斥，
    // 见机制 4——前端不提供入口，这里兜底，两判据同源）。
    pin(endpoint, id) {
      ensureLoaded();
      const clean = sanitizeSessionRef({ endpoint, id });
      if (!clean) return false;
      const key = `${clean.endpoint}\u0000${clean.id}`;
      if (loaded.archived.has(key)) return false;
      if (loaded.pinned.some((entry) => `${entry.endpoint}\u0000${entry.id}` === key)) return false;
      loaded.pinned = [clean, ...loaded.pinned];
      save();
      return true;
    },
    unpin(endpoint, id) {
      ensureLoaded();
      const clean = sanitizeSessionRef({ endpoint, id });
      if (!clean) return false;
      const key = `${clean.endpoint}\u0000${clean.id}`;
      const next = loaded.pinned.filter((entry) => `${entry.endpoint}\u0000${entry.id}` !== key);
      if (next.length === loaded.pinned.length) return false;
      loaded.pinned = next;
      save();
      return true;
    },
    pinned() {
      ensureLoaded();
      return loaded.pinned.map((entry) => ({ ...entry }));
    },
    // 测试与排查用：当前缓存的条目数。
    get size() {
      ensureLoaded();
      return loaded.archived.size + loaded.removedGroups.length;
    },
  };
}
