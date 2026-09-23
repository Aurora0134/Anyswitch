// Kimi Code 的 server 实例注册表读取（步 1 of
// bridge/anyswitch/kimi-desktop-integration-plan.md）。
//
// 背景：Kimi Code 的每一个「带 server 的界面」启动时都会在自己家目录的
// server/instances/ 下登记一条 <server_id>.json（字段 server_id / pid / host /
// port / started_at / heartbeat_at / host_version，多实例共用同一份家目录、各取
// 下一个空闲端口）。官方桌面端内嵌的就是同一个 server，`kimi web` 走的是同一条
// 登记路；纯终端 TUI 不起 server、不留记录。于是这条注册表是 anyswitch 现有
// 所有端点里第一份「客户端自己写好的结构化实例清单」——DSH 三个面只能靠命令行
// `--profile` 正则与 netstat 反查，Kimi 不需要。
//
// 口径（与计划 §7 步 1 同源，越出这条就不是本模块的职责）：
// - **注册表只用来分面，不用来判活。** 判活正源永远是进程扫描：这里返回的 pid
//   由调用方与扫描结果取交集，扫描里没有的记录一律不产生任何效果。一条残档
//   既不能撑出一行实例，也不能把卡片点亮。
// - 心跳时效只用来挡「长期残留的旧档」被 pid 复用冒充，不用来判进程死活。
//   真机心跳间隔未实测（计划 §9-5），所以窗口取宽：宁可让一条老记录退化成
//   「读不出面」，也不把它当成一次 web 界面。
// - 读不出的一律降级为空，绝不抛错：进程扫描与面板轮询不能被一个第三方
//   目录的权限、半写文件或格式变更拖红。

import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";

// 一条登记的 heartbeat_at 距 now 超过这个窗口就当旧档丢弃。取值只需覆盖
// 「进程还活着但心跳长期不写」的反面情形——那种进程本就进不了扫描交集。
export const KIMI_REGISTRY_HEARTBEAT_MAX_AGE_MS = 30 * 60 * 1000;

// Kimi Code 家目录：环境变量优先，否则 `~/.kimi-code`。与桌面端内嵌核心的
// 解析顺序一致（它的配置路径就是「家目录 + config.toml」），所以 anyswitch
// 读到的注册表和它写的注册表在同一棵树下。
export function resolveKimiCodeHome(env = process.env, homeDirFn = homedir) {
  const override = typeof env?.KIMI_CODE_HOME === "string" ? env.KIMI_CODE_HOME.trim() : "";
  if (override.length > 0) return override;
  return join(homeDirFn(), ".kimi-code");
}

export function kimiServerInstancesDir(homeDir) {
  return join(homeDir, "server", "instances");
}

// 一条注册文件 → { pid, port, hostVersion, heartbeatAt }；字段不齐、类型不对、
// pid 非法（0/负数在 Windows 上是 System Idle 或伪造值）一律返回 null。
// host_version 在 kimi 的实现里是可选字段，缺它不影响分面，故不作准入条件。
export function decodeKimiServerInstance(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { pid, port, heartbeat_at: heartbeatAt, host_version: hostVersion } = parsed;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(heartbeatAt) || heartbeatAt <= 0) return null;
  return {
    pid,
    port: Number.isInteger(port) && port > 0 ? port : null,
    heartbeatAt,
    hostVersion: typeof hostVersion === "string" && hostVersion.length > 0 ? hostVersion : null,
  };
}

// 注册表 → Map<pid, info>。目录不存在、无权限、单个文件畸形或过期都只丢那一条。
// 同名 pid 的多条记录（进程号复用后的新旧档）保留心跳更新的那条。
export async function readKimiServerInstances({ env = process.env, nowFn = Date.now, io = { readdir, readFile } } = {}) {
  const byPid = new Map();
  const dir = kimiServerInstancesDir(resolveKimiCodeHome(env));
  let names;
  try {
    names = await io.readdir(dir);
  } catch {
    return byPid;
  }
  const now = nowFn();
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name !== "string" || !name.endsWith(".json")) continue;
    let raw;
    try {
      raw = await io.readFile(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const info = decodeKimiServerInstance(raw);
    if (info === null) continue;
    if (now - info.heartbeatAt > KIMI_REGISTRY_HEARTBEAT_MAX_AGE_MS) continue;
    const held = byPid.get(info.pid);
    if (held !== undefined && held.heartbeatAt >= info.heartbeatAt) continue;
    byPid.set(info.pid, info);
  }
  return byPid;
}
