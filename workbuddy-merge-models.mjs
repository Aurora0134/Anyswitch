// WorkBuddy 自定义模型写入器 —— 把 Anyswitch 渠道/模型写进
// ~/.workbuddy/models.json，让 WorkBuddy 的模型选择器出现「渠道 · 模型」条目，
// 请求按条目里的 url 直连本地 relay 的 OpenAI chat/completions 面
// （POST /openai/workbuddy~<segment>/v1/chat/completions）。
//
// 与 TOML 家族（grok/codex/kimi）的关键差异：
//   - JSON 没有注释锚点，也没有托管块。清理靠「url 签名」：凡 url 命中
//     /openai/workbuddy~ 的条目即我方托管项，整类剔除后按当前 store 重建；
//     用户自己的模型条目与未知顶层键原样保留。
//   - 两种读法并存（workbuddy-integration-research.md §2.3）：GUI 同时接受顶层
//     数组与对象，CLI 的 parseModelsJson 只认对象 {models, availableModels}，传
//     数组直接得到空表且不报错。**写入形状固定为对象**，读入时数组兼容归一。
//   - 更要紧的是：GUI 的模型设置一保存就把整份文件归一成顶层数组，CLI 那边随即
//     静默得到空模型表。所以**每次启动/同步都必须重写一遍**，写后回读校验形状，
//     被抢改就重写一次、仍被抢改就如实报失败（writeWorkbuddyModelsWithBackup）。
//     不要新增文件监听去和 GUI 抢写：历史教训是两边互踩，谁最后落地谁说了算。
//   - availableModels 只在既有对象里已有该键时维护：缺键的语义是「全部自定义
//     模型可选」，凭空创建反而会把用户的模型藏起来。
//   - 坏 JSON 一律 fail-closed：解析失败返回 {ok:false, unchanged:true}，
//     绝不把用户的文件当空对象覆盖。models 键存在却不是数组同样按不可解析处理
//     （对象里塞个 {} 是坏形状，静默当空表会丢掉用户数据）。
//
// 身份：本端点的主通道是 URL 段前缀（CLI 发请求前 delete user-agent，UA 不可
// 依赖），段由 buildAgentPrefixedSegment("workbuddy", <segment>) 拼出；模型 id
// 里再带渠道（真渠道 packChannelModelSlug，伪渠道用裸模型名）供 relay 的链拦截
// 按 body.model 字面匹配。

import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import {
  contentHash,
  atomicWriteFile,
  casWriteFile,
  pruneBackups,
  PreconditionFailedError,
} from "./atomic-write.mjs";
import {
  readSidecar as readSidecarFile,
  writeSidecar as writeSidecarFile,
  AUTO_CHANNEL_KEY,
  deriveAnyswitchChannel,
} from "./merge-common.mjs";
import { fallbackContextWindow } from "./context-fallback.mjs";
import { modalitiesFromStoreModel } from "./modalities-fallback.mjs";
import { buildAgentPrefixedSegment } from "./openai-path.mjs";
import { packChannelModelSlug } from "./channel-model-slug.mjs";
// 共享端点感知的虚拟渠道派生（merge-common.mjs）—— 和 launcher/tests 共用一份。
export { deriveAutoRouteChannel, deriveAnyswitchChannel } from "./merge-common.mjs";
// 单一共享实现（pool-providers.mjs）：merge 模块不再自带目录语义。
export { extractManagedProviders } from "./pool-providers.mjs";
import { extractManagedProviders } from "./pool-providers.mjs";

const SIDECAR_FILENAME = "workbuddy-sidecar.json";
// relay 认这个端点时用的 id（须与 KNOWN_AGENT_IDS / ROUTING_ENDPOINT_IDS 成员
// 一致，前缀被白名单忽略时归属会落 null）。
const WORKBUDDY_AGENT_ID = "workbuddy";
// 托管条目的识别签名：url 段前缀 + 可选的端口。relay 只监听回环，端口随实例变。
const MANAGED_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/openai\/workbuddy~/;
// 模型条目厂牌字段（用户裁决：统一 Anyswitch，不写 Custom）。
const VENDOR = "Anyswitch";

export function sidecarPath(root) {
  return join(root, SIDECAR_FILENAME);
}

// sidecar 存储走共享实现（merge-common.mjs），这里只定文件名。
export function readSidecar(root) {
  return readSidecarFile(sidecarPath(root));
}

export function writeSidecar(root, providerIds) {
  writeSidecarFile(sidecarPath(root), providerIds);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// WorkBuddy 的配置根——唯一解析口径。取值顺序与产品自己读模型配置时一致：
// WORKBUDDY_CONFIG_DIR → CODEBUDDY_CONFIG_DIR → <home>/.workbuddy。两个变量都先
// trim，空串/纯空白视同未设置。home 默认取进程的真实主目录；调用方若自带
// base/home（面板、测试、卸载驱动），必须把同一份 home 传进来，别在这里二次猜。
export function workbuddyConfigRoot(base = process.env, home = homedir()) {
  return envDir(base?.WORKBUDDY_CONFIG_DIR) ?? envDir(base?.CODEBUDDY_CONFIG_DIR) ?? join(home, ".workbuddy");
}

function envDir(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function workbuddyModelsPath(base = process.env, home = homedir()) {
  return join(workbuddyConfigRoot(base, home), "models.json");
}

// 模型 id：真渠道用 <channelId>~<modelId>（号段唯一、选模型即选渠道）；Anyswitch
// 伪渠道（auto / 虚拟模型）用裸模型名——relay 的链拦截按 body.model 字面匹配，
// 加前缀反而匹配不到触发词。
export function workbuddyModelId(channelId, modelId) {
  if (channelId === AUTO_CHANNEL_KEY) return modelId;
  return packChannelModelSlug(channelId, modelId);
}

function modelLabel(model, modelId) {
  return typeof model?.displayName === "string" && model.displayName.length > 0 ? model.displayName : modelId;
}

function channelLabel(providerId, provider) {
  return provider?.channelName ?? provider?.displayName ?? providerId;
}

// 条目模板逐字固定（plan §1.2）：字段顺序也是模板的一部分，别顺手重排。
export function buildWorkbuddyModelEntry(providerId, provider, modelId, model, port, token) {
  const segment = provider?.baseUrlSegment ?? providerId;
  const url = `http://127.0.0.1:${port}/openai/${buildAgentPrefixedSegment(WORKBUDDY_AGENT_ID, segment)}/v1/chat/completions`;
  const contextWindow =
    Number.isInteger(model?.contextWindow) && model.contextWindow > 0
      ? model.contextWindow
      : fallbackContextWindow(modelId);
  return {
    id: workbuddyModelId(providerId, modelId),
    name: `${modelLabel(model, modelId)} · ${channelLabel(providerId, provider)}`,
    vendor: VENDOR,
    url,
    apiKey: token,
    useCustomProtocol: true,
    supportsToolCall: true,
    // 图像能力走 store 的真实字段（inputModalities），缺省时由共享 fallback
    // 按模型族兜底——未声明的聊天模型默认允许图像输入，与注入链同一口径。
    supportsImages: modalitiesFromStoreModel(model, modelId).input.includes("image"),
    supportsReasoning: Array.isArray(model?.reasoningEffortLevels) && model.reasoningEffortLevels.length > 0,
    maxInputTokens: contextWindow,
  };
}

export function isManagedModel(entry) {
  return !!entry && typeof entry === "object" && typeof entry.url === "string" && MANAGED_URL_RE.test(entry.url);
}

export class UnparseableWorkbuddyModelsError extends Error {
  constructor(source) {
    super(`refusing to overwrite unparseable WorkBuddy models.json${source ? `: ${source}` : ""}`);
    this.name = "UnparseableWorkbuddyModelsError";
    this.code = "UNPARSEABLE_WORKBUDDY_MODELS";
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// 读入归一：null/空串 → {models:[]}；顶层数组 → {models:数组}；顶层对象 →
// 原样；坏 JSON 与「models 存在但不是数组」→ 抛 UnparseableWorkbuddyModelsError
// （fail-closed：静默把用户条目当空表丢掉是最坏的一种「成功」）。
export function parseWorkbuddyModels(existingText) {
  if (existingText === null || existingText === undefined || existingText === "") return { models: [] };
  if (typeof existingText !== "string") throw new UnparseableWorkbuddyModelsError();
  let parsed;
  try {
    parsed = JSON.parse(stripBom(existingText));
  } catch {
    throw new UnparseableWorkbuddyModelsError();
  }
  if (Array.isArray(parsed)) return { models: parsed };
  if (parsed && typeof parsed === "object") {
    if (parsed.models !== undefined && !Array.isArray(parsed.models)) {
      throw new UnparseableWorkbuddyModelsError();
    }
    return parsed;
  }
  // 顶层是字符串/数字/布尔/null：不是 WorkBuddy 认的形状，按不可解析处理。
  throw new UnparseableWorkbuddyModelsError();
}

// 纯函数：读入既有文本 + 当前可见渠道，产出合并后的对象、托管 provider 名单与
// 被去重跳过的 id。autoChannel 由调用方按端点链派生（null 表示无伪渠道）。
export function buildWorkbuddyModels(existingText, providers, port, token, autoChannel = null) {
  const config = parseWorkbuddyModels(existingText);
  const merged = { ...config };
  const allProviders = autoChannel ? { ...providers, [AUTO_CHANNEL_KEY]: autoChannel } : providers ?? {};

  // 整类剔除托管项后重建：即便 sidecar 丢了，url 签名也能认领并自愈。
  const existingModels = Array.isArray(config.models) ? config.models : [];
  const userModels = existingModels.filter((entry) => !isManagedModel(entry));

  const managed = [];
  const modelIds = [];
  const skipped = [];
  const seen = new Set();
  const entries = [];

  for (const [providerId, provider] of Object.entries(allProviders)) {
    const models = provider?.models ?? {};
    for (const [modelId, model] of Object.entries(models)) {
      const entry = buildWorkbuddyModelEntry(providerId, provider, modelId, model, port, token);
      if (seen.has(entry.id)) {
        skipped.push({ id: entry.id, channelId: providerId, modelId, reason: `duplicate model id "${entry.id}"` });
        continue;
      }
      seen.add(entry.id);
      entries.push(entry);
      modelIds.push(entry.id);
    }
    if (Object.keys(models).length > 0 && !managed.includes(providerId)) managed.push(providerId);
  }

  merged.models = [...userModels, ...entries];

  // availableModels 仅当既有对象已有该键时维护（缺键 = 全部自定义模型可选，
  // 创建它会藏起用户模型）。追加去重、保序；剔除托管项时也一并回收。
  if (Array.isArray(config.availableModels)) {
    const removedIds = new Set(existingModels.filter(isManagedModel).map((entry) => entry.id).filter(Boolean));
    const kept = config.availableModels.filter((id) => !removedIds.has(id));
    for (const id of modelIds) if (!kept.includes(id)) kept.push(id);
    merged.availableModels = kept;
  }

  return { config: merged, managed, modelIds, skipped };
}

export function mergeWorkbuddyModels(existingText, providers, port, token, autoChannel = null) {
  return buildWorkbuddyModels(existingText, providers, port, token, autoChannel);
}

// 本模块的默认 IO 面（测试可整份替换，用来注入并发抢写与写失败）。
export const workbuddyModelsIo = Object.freeze({
  existsSync,
  readFileSync,
  mkdirSync,
  copyFileSync,
  atomicWriteFile,
  casWriteFile,
  pruneBackups,
});

export function readWorkbuddyModels(filePath, io = workbuddyModelsIo) {
  if (!io.existsSync(filePath)) return { models: [] };
  try {
    return parseWorkbuddyModels(io.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "UNPARSEABLE_WORKBUDDY_MODELS") throw new UnparseableWorkbuddyModelsError(filePath);
    throw error;
  }
}

// 写后回读：顶层必须是对象（CLI 的 parseModelsJson 只认它）。
function isModelsObject(filePath, io) {
  try {
    const parsed = JSON.parse(stripBom(io.readFileSync(filePath, "utf8")));
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

// expectedHash 给了就走 CAS：'<hash>' 要求目标仍是读入时那份原文，null 要求目标
// 仍不存在；不给（卸载清扫等无并发语义的调用）保持原来的原子覆盖。
// 写后立刻回读形状——GUI 的模型设置保存会把文件归一成顶层数组，CLI 随即读成空
// 表；发现被抢改就重写一次，第二次仍被抢改则如实返回失败，绝不谎报成功。
export function writeWorkbuddyModelsWithBackup(filePath, config, { expectedHash, io = workbuddyModelsIo } = {}) {
  const dir = dirname(filePath);
  io.mkdirSync(dir, { recursive: true });

  const text = JSON.stringify(config, null, 2) + "\n";
  const hash = contentHash(text);

  if (io.existsSync(filePath) && contentHash(io.readFileSync(filePath, "utf8")) === hash) {
    return { ok: true, unchanged: true };
  }

  let backupPath;
  if (io.existsSync(filePath)) {
    backupPath = join(dir, `models.backup.${timestamp()}.json`);
    io.copyFileSync(filePath, backupPath);
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt === 0 && expectedHash !== undefined) {
      io.casWriteFile(filePath, text, { expectedHash });
    } else {
      io.atomicWriteFile(filePath, text);
    }
    if (isModelsObject(filePath, io)) {
      // 只保留最近 5 份：无界保留会在盘上堆满带 token 的配置副本。
      io.pruneBackups(dir, "models.backup.");
      return { ok: true, unchanged: false, backupPath };
    }
  }
  return { ok: false, reason: "models.json was rewritten concurrently" };
}

// 托管项剔除（卸载的 sidecar 丢失路径）：从对象里删掉所有 url 签名命中的模型，
// 顺带从 availableModels 回收它们的 id。返回被删除的 id 列表。
export function selectManagedModels(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const models = Array.isArray(config.models) ? config.models : [];
  const kept = [];
  const removed = [];
  for (const entry of models) (isManagedModel(entry) ? removed : kept).push(entry);
  if (removed.length === 0) return [];
  config.models = kept;
  if (Array.isArray(config.availableModels)) {
    const removedIds = new Set(removed.map((entry) => entry.id).filter(Boolean));
    config.availableModels = config.availableModels.filter((id) => !removedIds.has(id));
  }
  return removed.map((entry) => entry.id ?? "<unnamed>");
}

// 读入快照：原文（用于 CAS 的 expectedHash）与解析结果一起返回。目标不存在时
// hash 为 null，表示 expect-absent 创建。
function readModelsSnapshot(filePath, io) {
  if (!io.existsSync(filePath)) return { config: null, hash: null };
  const text = io.readFileSync(filePath, "utf8");
  return { config: parseWorkbuddyModels(text), hash: contentHash(text) };
}

// 高层写入：读既有 models.json → 剔除托管项并按当前 store 重建 → CAS 原子写 + 备份。
// 返回 {ok, unchanged?, backupPath?, reason?, skipped?}。坏 JSON 走 fail-closed：
// 报告原因，绝不覆盖（plan §1.2）。
// 读—改—写之间有并发窗口：写冲突（读入后的原文已被改动）就重读重合并一次，仍
// 冲突则返回失败，不拿旧快照盖掉别人刚写进去的内容。
export function writeWorkbuddyModels(
  store,
  port,
  token,
  sidecarRoot,
  filePath = workbuddyModelsPath(),
  io = workbuddyModelsIo,
) {
  const managedProviders = extractManagedProviders(store);
  const autoChannel = deriveAnyswitchChannel(store, WORKBUDDY_AGENT_ID);
  const previousManaged = readSidecar(sidecarRoot).providers;
  const nothingManaged = Object.keys(managedProviders).length === 0 && !autoChannel;
  if (nothingManaged && previousManaged.length === 0) {
    return { ok: true, unchanged: true, reason: "no Anyswitch providers with models" };
  }
  // 目录被用户删掉了、只剩 sidecar 残留时，别把它重新建出来：目标文件不存在、
  // 本轮没有任何托管条目、也就没有用户条目要保，清掉 sidecar 收工。
  if (nothingManaged && !io.existsSync(filePath)) {
    writeSidecar(sidecarRoot, []);
    return { ok: true, unchanged: true, reason: "no Anyswitch providers with models" };
  }

  let remergedOnce = false;
  for (;;) {
    let snapshot;
    try {
      snapshot = readModelsSnapshot(filePath, io);
    } catch (error) {
      if (error?.code === "UNPARSEABLE_WORKBUDDY_MODELS") {
        return { ok: false, unchanged: true, reason: error.message };
      }
      return { ok: false, unchanged: true, reason: error?.message ?? String(error) };
    }
    const merged = mergeWorkbuddyModels(
      snapshot.config === null ? null : JSON.stringify(snapshot.config),
      managedProviders,
      port,
      token,
      autoChannel,
    );
    let writeResult;
    try {
      writeResult = writeWorkbuddyModelsWithBackup(filePath, merged.config, {
        expectedHash: snapshot.hash,
        io,
      });
    } catch (error) {
      if (error instanceof PreconditionFailedError && !remergedOnce) {
        remergedOnce = true;
        continue;
      }
      if (error instanceof PreconditionFailedError) {
        return { ok: false, unchanged: true, reason: "models.json changed concurrently", skipped: merged.skipped };
      }
      return {
        ok: false,
        unchanged: true,
        reason: error?.message ?? String(error),
        skipped: merged.skipped,
      };
    }
    if (writeResult.ok) writeSidecar(sidecarRoot, merged.managed);
    return { ...writeResult, skipped: merged.skipped };
  }
}
