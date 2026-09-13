// 渠道限定模型 slug：<channelId>~<modelId> —— 与 wire-id.mjs 的
// anthropic/<provider>/<model> 同构的「渠道编码进模型 id」方案，面向 codex
// 这类模型选择器是全局扁平命名空间、provider 只是全局单选的客户端：同名模型
// 跨渠道不再归并、渠道名随 display_name 可见、选模型即选渠道。
//
// 分隔符为什么是 "~"：store-schema 的 PROVIDER_ID 字符集是 [A-Za-z0-9._-]，
// 渠道 id 永不含 "~"，所以首个 "~" 就是渠道/模型边界，模型 id 自身含 "/"
// （openai/gpt-5.6-luna 等）甚至含 "~"（右段原样保留）都不影响解析。
//
// 解析以「左段是 store 已知渠道」为准，杜绝把碰巧含 "~" 的普通模型 id 拆错：
// 池优先（池 id 可复用成员 id，池赢），被池吸收的成员保持可解析（运行时宽容，
// 与 unpackWireId 同款纪律——配置尚未同步的旧 slug 不至于立刻 404）。左段不是
// 已知渠道时返回 null，调用侧原样透传，裸模型 id 的行为完全不变。
//
// 纯函数，无 IO。

import { resolvePool } from "./pool-routing.mjs";
import { deriveVisibleChannels } from "./pool-providers.mjs";

export const CHANNEL_MODEL_SEPARATOR = "~";

export function packChannelModelSlug(channelId, modelId) {
  if (typeof channelId !== "string" || channelId.length === 0) {
    throw new Error("packChannelModelSlug: channelId must be a non-empty string");
  }
  if (channelId.includes(CHANNEL_MODEL_SEPARATOR)) {
    throw new Error(`packChannelModelSlug: channel id "${channelId}" must not contain '${CHANNEL_MODEL_SEPARATOR}'`);
  }
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new Error("packChannelModelSlug: modelId must be a non-empty string");
  }
  return `${channelId}${CHANNEL_MODEL_SEPARATOR}${modelId}`;
}

// Returns { channelId, modelId, pool } when the slug's left segment names a
// known channel in the store, null otherwise (bare model ids, unknown
// channels, malformed shapes — all pass through untouched).
export function unpackChannelModelSlug(slug, store) {
  if (typeof slug !== "string") return null;
  const cut = slug.indexOf(CHANNEL_MODEL_SEPARATOR);
  if (cut <= 0 || cut === slug.length - 1) return null;
  const channelId = slug.slice(0, cut);
  const modelId = slug.slice(cut + CHANNEL_MODEL_SEPARATOR.length);
  // Pools resolve before providers, mirroring unpackWireId: a pool id may
  // reuse one of its member's ids, and the pool wins the tie.
  if (resolvePool(store, channelId)) return { channelId, modelId, pool: true };
  if (store?.providers?.[channelId] !== undefined) return { channelId, modelId, pool: false };
  return null;
}

// One entry per (channel, model) pair across the visible channel view — the
// same derivation the merge modules consume, so the slug catalog can never
// drift from the endpoint configs. displayName carries the channel label
// because several channels legitimately offer the same model id; a bare model
// name would make those rows visually identical (wire-id.mjs 同款理由).
export function buildChannelModelSlugCatalog(store) {
  const entries = [];
  for (const [channelId, channel] of Object.entries(deriveVisibleChannels(store))) {
    const channelName = channel?.channelName ?? channel?.displayName ?? channelId;
    for (const [modelId, model] of Object.entries(channel?.models ?? {})) {
      const modelLabel =
        typeof model?.displayName === "string" && model.displayName.length > 0 ? model.displayName : modelId;
      entries.push({
        slug: packChannelModelSlug(channelId, modelId),
        channelId,
        modelId,
        displayName: `${modelLabel} · ${channelName}`,
      });
    }
  }
  return entries;
}
