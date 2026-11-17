// Claude Desktop 3p 配置的密钥保鲜写手（agent-sync 第 claude 步）。
//
// Claude 是唯一没有 launcher 的端点：3p 部署从 configLibrary/<id>.json 读一份
// 静态 bearer 密钥（inferenceGatewayApiKey），安装时写入后没有任何组件会再碰它。
// relay token 7 天代次轮换（旧代次 24h 闲置退役）后，这份静态密钥就是桌面端
// /v1/models 401、模型列表全空的唯一根因面（2026-11-17 案）。本模块把该配置
// 接进同步面：每次同步把「指向本 relay」的 gateway 配置里的密钥重指到现行代次。
//
// 只认 configLibrary 下形如 <uuid>.json 的配置文件（_meta.json 是注册表、
// .bak* 是备份，均不碰）；守卫三条——inferenceProvider 必须是 "gateway"、
// baseUrl 必须解析成环回地址、端口必须是本 relay 端口——不满足的配置属于
// 用户自己的部署，只读不写。解析不了的文件一律不覆写（改写路径是
// parse→改一字段→stringify，读不出来就写不回去）。模型目录仍由中继动态发现，
// 这里不维护 inferenceModels ——密钥是 3p 部署仅有的本地可写状态。

import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../store/atomic-write.mjs";

// 备份命名沿用 configLibrary 既有惯例（.bak-anys-<date> 一次性文件）的语义，
// 但收成单份滚动覆写：桌面目录是 Claude 自己的地盘，每 7 天一次轮换逐份累积
// 会在别人的目录里堆文件；且旧代次密钥本就退役，备份只为「改坏了能还原」。
const BACKUP_SUFFIX = ".bak-anys";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function claudeDesktopProfileDir(base = process.env) {
  return join(
    base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"),
    "Claude-3p",
    "configLibrary",
  );
}

// 本轮要看的配置文件：JSON 文件、排除注册表与任何备份形态。备份若不排除，
// 它的内容同样过 gateway 守卫，密钥永远不等于现行代次，会被无限重写。
export function claudeProfileFiles(entries) {
  return entries
    .filter((name) => typeof name === "string" && name.endsWith(".json"))
    .filter((name) => name !== "_meta.json" && !name.includes(".bak"))
    .sort();
}

// 一份 3p 配置是否指向本 relay：gateway 形态 + 环回主机 + 本 relay 端口。
// 其余（首方部署、别的网关、别的端口）都不是我们的保鲜对象。
export function profileTargetsRelay(profile, port) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return false;
  if (profile.inferenceProvider !== "gateway") return false;
  if (typeof profile.inferenceGatewayBaseUrl !== "string") return false;
  let url;
  try {
    url = new URL(profile.inferenceGatewayBaseUrl);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
  return url.port === String(port);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// 刷新 configLibrary 里所有指向本 relay 的配置密钥。返回
// { ok, unchanged, notInstalled?, refreshed?, backupPaths?, reason? }：
// 目录不存在／没有指向本 relay 的配置 → notInstalled 跳过（不新建任何文件）；
// 密钥已是现行代次 → unchanged；有改写 → refreshed 计数＋备份路径。单个文件
// 的备份或写入失败按端点级失败上报（reason 带文件名），不拖垮其余文件的改写。
export function writeClaudeDesktopConfig(port, token, dir, { log } = {}) {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "relay token unavailable" };
  }
  if (!existsSync(dir)) {
    log?.info?.("claude 3p profile library not found; nothing to refresh");
    return { ok: true, unchanged: true, notInstalled: true };
  }
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    return { ok: false, reason: `configLibrary not readable: ${error.message}` };
  }

  const refreshed = [];
  const backupPaths = [];
  const failures = [];
  let ours = 0;
  for (const name of claudeProfileFiles(entries)) {
    const filePath = join(dir, name);
    let profile;
    try {
      profile = JSON.parse(stripBom(readFileSync(filePath, "utf8")));
    } catch {
      // 读不出就写不回（上面的守卫依赖 parse）；绝不覆写不明形状的文件。
      log?.warn?.(`claude 3p profile "${name}" is unparseable; leaving it untouched`);
      continue;
    }
    if (!profileTargetsRelay(profile, port)) continue;
    ours += 1;
    if (profile.inferenceGatewayApiKey === token) continue;

    const backupPath = `${filePath}${BACKUP_SUFFIX}`;
    try {
      copyFileSync(filePath, backupPath);
    } catch (error) {
      failures.push(`backup for "${name}" failed: ${error.message}`);
      continue;
    }
    try {
      atomicWriteFile(filePath, `${JSON.stringify({ ...profile, inferenceGatewayApiKey: token }, null, "\t")}\n`);
    } catch (error) {
      failures.push(`write for "${name}" failed: ${error.message}`);
      continue;
    }
    refreshed.push(name);
    backupPaths.push(backupPath);
  }

  if (failures.length > 0) {
    return { ok: false, reason: failures.join("; "), refreshed: refreshed.length };
  }
  if (ours === 0) {
    log?.info?.("claude 3p profiles found, but none target this relay; nothing to refresh");
    return { ok: true, unchanged: true, notInstalled: true };
  }
  if (refreshed.length === 0) {
    return { ok: true, unchanged: true, refreshed: 0, backupPaths };
  }
  log?.info?.(`claude 3p profile credential refreshed (${refreshed.join(", ")})`);
  return { ok: true, unchanged: false, refreshed: refreshed.length, backupPaths };
}
