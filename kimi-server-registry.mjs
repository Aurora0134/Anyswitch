// Kimi Code 的 server 实例注册表读取（步 1 of
// bridge/anyswitch/kimi-desktop-integration-plan.md）。
//
// 背景：Kimi Code 的每一个「带 server 的界面」启动时都会在自己家目录的
// server/instances/ 下登记一条 <server_id>.json（字段 server_id / pid / host /
// port / started_at / heartbeat_at / host_version，多实例共用同一份家目录、各取
// 下一个空闲端口）。写入方一共四条，全部经过客户端里唯一的那个 register 调用点
// （2026-09-23 读自本机实际执行的 @moonshot-ai/kimi-code 安装包）：`kimi web`、
// `kimi rc`（远程控制面板）、在 TUI 里把当前会话交给浏览器（TUI 退出后同一个
// 进程就地变成 server），以及内嵌同一份 server 代码的官方桌面端。纯交互式 TUI
// 不起 server、不留记录。于是这条注册表是 anyswitch 现有所有端点里第一份
// 「客户端自己写好的结构化实例清单」——DSH 三个面只能靠命令行 `--profile`
// 正则与 netstat 反查，Kimi 不需要。
//
// 口径（与计划 §7 步 1 同源，越出这条就不是本模块的职责）：
// - **注册表只用来分面，不用来判活。** 判活正源永远是进程扫描：这里返回的 pid
//   由调用方与扫描结果取交集，扫描里没有的记录一律不产生任何效果。一条残档
//   既不能撑出一行实例，也不能把卡片点亮。
// - 桌面端与 web 共用同一张表，所以「有登记」只说明这个进程在服务一个带窗口
//   或带浏览器的界面，不说明是哪一种界面。调用方据此只能提级终端那一档。
// - 读不出的一律降级为空，绝不抛错：进程扫描与面板轮询不能被一个第三方
//   目录的权限、半写文件或格式变更拖红。

import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";

// 心跳时效：一条登记的 heartbeat_at 距 now 超过这个窗口就当旧档丢弃。取值依据
// 是客户端自己的节律——它每 15 秒重写一次这条登记（安装包内 createInstanceRegistry
// 的默认心跳间隔，与有没有活动无关，进程活着就写），90 秒相当于连漏 6 拍才判旧：
// 够容忍一次唤醒或一次慢盘，又远小于一个进程号被新起的 kimi 复用、冒充成另一张面
// 的时间窗。不能指望客户端替我们清档：它的清理只发生在「下一次有人登记」时，判据
// 是进程号死活而非心跳时间，而且桌面端退出时根本不删自己那条（真机 2026-09-23
// 12:55 那次退出后，登记文件原样留在盘上）。旧档被丢掉时那张面退化成终端档，
// 而不是多出一个界面。
export const KIMI_REGISTRY_HEARTBEAT_MAX_AGE_MS = 90 * 1000;

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
