// Claude Code 会话注册表读侧：pid → 会话 id 的权威映射。
//
// CC 2.1 的交互会话在 ~/.claude/sessions/ 下登记 <pid>.json（真机取证：
// {pid, sessionId, cwd, startedAt, procStart, kind:"interactive", ...}，另有
// 同前缀的 <pid>.<hash>.key 对等认证文件）。同一条对话被第二个进程
// resume/continue 附着时，两个进程各发各的请求——逐 PID 成行会把一条对话
// 拆成两张卡（2026-11-01 夜间报障：单会话两张 TUI 卡、各带活跃数据）。本模块
// 给出的映射让看板把它们折回一行。
//
// 纪律只信正证，与桌面形态折叠同一条「宁可漏折，不可误折」：
//   · 文件缺字段 / JSON 坏 / 文件名不是 <pid>.json → 跳过；
//   · pid 不在本轮扫描的 claude 进程集里（陈旧文件，进程已死）→ 跳过；
//   · 进程启动刻度对不上（PID 复用：旧文件碰上同名新进程）→ 跳过；
//   · 刻度根本没读到（可选查询失败/降级轮）→ 本轮整个不归属，回落逐进程行。
// procStart 是 FILETIME 字符串（100ns 刻度，与 Get-Process StartTime.ToFileTime()
// 同源），进程表一侧答不出来时不猜。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function defaultClaudeSessionsDir(env = process.env) {
  const home = typeof env.USERPROFILE === "string" && env.USERPROFILE ? env.USERPROFILE : homedir();
  return join(home, ".claude", "sessions");
}

// 解析一行注册表文件内容。返回 { pid, sessionId, procStart } 或 null。
// procStart 保留字符串形态：FILETIME 是 18 位十进制数，Number 精度不够，比对
// 一律走字符串相等。
export function parseClaudeSessionRegistryEntry(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  let row;
  try {
    row = JSON.parse(text);
  } catch {
    return null;
  }
  if (!row || typeof row !== "object") return null;
  const pid = Number(row.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const sessionId = typeof row.sessionId === "string" ? row.sessionId.trim() : "";
  if (sessionId.length === 0) return null;
  const procStart = typeof row.procStart === "string" && /^\d+$/.test(row.procStart) ? row.procStart : null;
  if (procStart === null) return null;
  return { pid, sessionId, procStart };
}

// 只读候选 pid 的注册表文件（不为无关 pid 付 IO）。返回值语义：
//   Map（可为空）= 本轮按文件内容归属；目录缺失/权限不足时逐文件读失败，
//     效果同「都没登记过」，同样落到空 Map；
//   null = 调用参数本身不是有效目录串（防御性分支，正常路径到不了）。
// 候选集合为空时不碰盘，直接返回空 Map。
export function readClaudeSessionRegistry(dir, candidatePids) {
  if (!(candidatePids instanceof Set) || candidatePids.size === 0) return new Map();
  if (typeof dir !== "string" || dir.length === 0) return null;
  const out = new Map();
  for (const pid of candidatePids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let text = null;
    try {
      text = readFileSync(join(dir, `${pid}.json`), "utf8");
    } catch {
      continue; // 该 pid 没登记过（老版本 CC / 非交互进程）——跳过，不是错
    }
    const entry = parseClaudeSessionRegistryEntry(text);
    if (entry === null || entry.pid !== pid) continue;
    out.set(pid, entry);
  }
  return out;
}

// 进程启动刻度查询（PID 复用防护的正证来源）：随常驻探针走一条可选查询，
// 输出逐行 `<pid>,<filetime>`。候选集为空时返回 null（调用侧省一次探针往返）。
export function claudeProcStartQuery(candidatePids) {
  const list = [...candidatePids].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (list.length === 0) return null;
  return `Get-Process -Id ${list.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id),$($_.StartTime.ToFileTime())" }`;
}

export function parseClaudeProcStartOutput(text) {
  const map = new Map();
  if (typeof text !== "string" || text.length === 0) return map;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+),(\d+)\s*$/);
    if (!m) continue;
    map.set(Number(m[1]), m[2]);
  }
  return map;
}

// 最终归属：注册表条目 × 进程启动刻度对账，两边都正证命中才承认
// pid → sessionId。返回 Map<pid, sessionId>（只含通过校验的 pid）。
export function assignClaudeSessions(registry, procStartByPid) {
  const out = new Map();
  if (!(registry instanceof Map) || !(procStartByPid instanceof Map)) return out;
  for (const [pid, entry] of registry) {
    const filetime = procStartByPid.get(pid);
    if (typeof filetime !== "string" || filetime.length === 0) continue;
    if (filetime !== entry.procStart) continue;
    out.set(pid, entry.sessionId);
  }
  return out;
}
