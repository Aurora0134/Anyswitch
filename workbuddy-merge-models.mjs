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
//   - availableModels 只在既有对象里已有该键时维护：缺键的语义是「全部自定义
//     模型可选」，凭空创建反而会把用户的模型藏起来。
//   - 坏 JSON 一律 fail-closed：解析失败返回 {ok:false, unchanged:true}，
//     绝不把用户的文件当空对象覆盖。
//
// 身份：本端点的主通道是 URL 段前缀（CLI 发请求前 delete user-agent，UA 不可
// 依赖），段由 buildAgentPrefixedSegment("workbuddy", <segment>) 拼出；模型 id
// 里再带渠道（真渠道 packChannelModelSlug，伪渠道用裸模型名）供 relay 的链拦截
// 按 body.model 字面匹配。

import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { contentHash, atomicWriteFile, pruneBackups } from "./atomic-write.mjs";
import {
  readSidecar as readSidecarFile,
  writeSidecar as writeSidecarFile,
  AUTO_CHANNEL_KEY,
  deriveAnyswitchChannel,
} from "./merge-common.mjs";
import { fallbackContextWindow } from "./context-fallback.mjs";
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

// WorkBuddy 的配置根：WORKBUDDY_CONFIG_DIR 可改根，默认 ~/.workbuddy。
export function workbuddyConfigRoot(base = process.env) {
  const override = base.WORKBUDDY_CONFIG_DIR;
  if (typeof override === "string" && override.length > 0) return override;
  return join(base.USERPROFILE ?? "", ".workbuddy");
}

export function workbuddyModelsPath(base = process.env) {
  return join(workbuddyConfigRoot(base), "models.json");
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
    supportsImages: Array.isArray(model?.modalities?.input) && model.modalities.input.includes("image"),
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
// 原样；坏 JSON → 抛 UnparseableWorkbuddyModelsError（fail-closed）。
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
  if (parsed && typeof parsed === "object") return parsed;
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

export function readWorkbuddyModels(filePath) {
  if (!existsSync(filePath)) return { models: [] };
  try {
    return parseWorkbuddyModels(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "UNPARSEABLE_WORKBUDDY_MODELS") throw new UnparseableWorkbuddyModelsError(filePath);
    throw error;
  }
}

export function writeWorkbuddyModelsWithBackup(filePath, config) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const text = JSON.stringify(config, null, 2) + "\n";
  const hash = contentHash(text);

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf8");
    if (contentHash(existing) === hash) return { ok: true, unchanged: true };
  }

  let backupPath;
  if (existsSync(filePath)) {
    backupPath = join(dir, `models.backup.${timestamp()}.json`);
    copyFileSync(filePath, backupPath);
  }

  atomicWriteFile(filePath, text);
  // 只保留最近 5 份：无界保留会在盘上堆满带 token 的配置副本。
  pruneBackups(dir, "models.backup.");
  return { ok: true, unchanged: false, backupPath };
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

// 高层写入：读既有 models.json → 剔除托管项并按当前 store 重建 → 原子写 + 备份。
// 返回 {ok, unchanged?, backupPath?, reason?, skipped?}。坏 JSON 走 fail-closed：
// 报告原因，绝不覆盖（plan §1.2）。
export function writeWorkbuddyModels(store, port, token, sidecarRoot, filePath = workbuddyModelsPath()) {
  const managedProviders = extractManagedProviders(store);
  const autoChannel = deriveAnyswitchChannel(store, WORKBUDDY_AGENT_ID);
  const previousManaged = readSidecar(sidecarRoot).providers;
  if (Object.keys(managedProviders).length === 0 && !autoChannel && previousManaged.length === 0) {
    return { ok: true, unchanged: true, reason: "no Anyswitch providers with models" };
  }
  let existing;
  try {
    existing = readWorkbuddyModels(filePath);
  } catch (error) {
    if (error?.code === "UNPARSEABLE_WORKBUDDY_MODELS") {
      return { ok: false, unchanged: true, reason: error.message };
    }
    return { ok: false, unchanged: true, reason: error?.message ?? String(error) };
  }
  const merged = mergeWorkbuddyModels(
    JSON.stringify(existing),
    managedProviders,
    port,
    token,
    autoChannel,
  );
  const writeResult = writeWorkbuddyModelsWithBackup(filePath, merged.config);
  if (writeResult.ok) writeSidecar(sidecarRoot, merged.managed);
  return { ...writeResult, skipped: merged.skipped };
}
