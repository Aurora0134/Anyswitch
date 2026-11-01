// Image degrading for text-only routes (图片降级).
//
// The two relay exit points (handler.mjs attemptMessages /
// openai-handler.mjs attemptChatCompletion) call these when a request that
// carries images is headed to a model that cannot take them: every image_url
// part of messages[*].content is replaced by a text part carrying the fixed
// placeholder marker, and the request is sent anyway — a placeholder answer
// beats a dead turn.
//
// Pure transforms only (no IO, no logger): requestHasImages / stripImages.
// The note/stats pair at the bottom is the process-internal degradation
// ledger — one info log per degraded request plus counters for a future
// panel surface — and is deliberately module-level so both relay handlers
// (anthropic / openai) share one process-wide count.

// The approved wire placeholder, byte-identical to ccswitch's marker. It
// enters the conversation content, so the value is a user-facing contract.
export const UNSUPPORTED_IMAGE_MARKER = "[Unsupported Image]";

function isImagePart(part) {
  return part !== null && typeof part === "object" && part.type === "image_url";
}

/** Does any message carry an image_url content part? Chat shape only. */
export function requestHasImages(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of messages) {
    if (Array.isArray(message?.content) && message.content.some(isImagePart)) return true;
  }
  return false;
}

/**
 * Replace every image_url part with a text part carrying `marker`.
 *
 * Returns { body, count }: count is the number of parts replaced; body is a
 * new object (the input is never mutated) when count > 0, else the input
 * reference unchanged. After replacement, a content array left with a single
 * text part collapses to the plain string form — the same chat convention
 * protocol.mjs's convertContentToOpenAI applies. Idempotent by construction:
 * a stripped body carries no image_url parts, so a second call is a no-op.
 */
export function stripImages(body, marker = UNSUPPORTED_IMAGE_MARKER) {
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (messages === null) return { body, count: 0 };

  let count = 0;
  let touched = false;
  const rewritten = messages.map((message) => {
    const content = Array.isArray(message?.content) ? message.content : null;
    if (content === null || !content.some(isImagePart)) return message;
    touched = true;
    const parts = content.map((part) =>
      isImagePart(part) ? { type: "text", text: marker } : part,
    );
    count += content.filter(isImagePart).length;
    const collapsed = parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts;
    return { ...message, content: collapsed };
  });
  return touched ? { body: { ...body, messages: rewritten }, count } : { body, count };
}

// ---------- process-internal degradation ledger ----------
// 计数是进程级单例：两个 relay handler 共享同一份，重启清零（与 effort 的
// 渠道拉黑表同一生命周期哲学）。日志与计数同源，供将来面板浮出时呈现
// 「本次运行已为 N 个请求降级 M 张图」。

const ledger = { requests: 0, images: 0 };

/**
 * Record one degraded request: one info log (渠道 / 模型 / 张数 / 预判或兜底
 * 路径) plus the process counters. `via` is "predict" (send 前预判剥图) or
 * "fallback" (上游报错后剥图重试).
 */
export function noteImageFallback({ providerId, modelId, count, via, logger = null }) {
  ledger.requests += 1;
  ledger.images += count;
  const headline = via === "fallback" ? "图片降级（兜底）" : "图片降级（预判）";
  const tail = via === "fallback"
    ? "上游回报只支持文本，已把图替换为占位标记后重试一次"
    : "该模型只接受文本，已把图替换为占位标记后发送";
  logger?.info?.(
    `${headline}：渠道 "${providerId}" 的模型 "${modelId}" 本次请求 ${count} 张图片，${tail}`,
  );
}

/** Snapshot of the process counters (read-only copy). */
export function imageFallbackStats() {
  return { requests: ledger.requests, images: ledger.images };
}

/** Test seam: zero the process counters. */
export function resetImageFallbackStats() {
  ledger.requests = 0;
  ledger.images = 0;
}
