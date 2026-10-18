// Hub-owned text-only model knowledge (not an endpoint catalog).
// Pure functions only. No IO, no DPAPI, no network.
//
// Three judgment sources, strictly ordered:
//   1. store inputModalities — the operator's own declaration. Never gated by
//      a switch: a declaration is a fact, not a guess, and a declared
//      image-capable model must not be second-guessed by the registry below;
//   2. the confirmed text-only registry — exact match, fail-open: a new model
//      or new suffix never inherits (a future -vision variant stays
//      image-capable until confirmed), so a miss costs one upstream refusal,
//      never a silently dropped image. Gated by the 纯文本预判 sub-switch;
//   3. an upstream 4xx whose wording says the model only takes text — the
//      报错兜底 retry path, gated by the 图片降级 master switch. The wording
//      library is ported from ccswitch's media_sanitizer (issue #5025 real
//      samples), lower-cased and plural-tolerant.
//
// The starting registry is ccswitch's CONFIRMED_TAILS trimmed to the model
// families this install actually routes (see the per-entry notes).

// Trimmed to families present in this machine's store (checked 2026-10-19):
// deepseek (v4-* gateway aliases), glm (5.2/5.3 base tiers, incl. the
// sta1n channel's "[Cloud]GLM-5.3" labelled ids), mimo (v2.5-pro), minimax
// (m2.7 family via the -free gateway variant). ccswitch families this store
// never routes (kat/ling/longcat/ark-code/qwen3-coder/step-3.5/us.deepseek)
// are dropped; unconfirmed local variants (glm-5.3-flash, glm-5.3-flashx,
// kimi-k3, qwen3.8-*, mimo-v2.6-*, MiniMax-M2.7-free, deepseek-v4-*) stay out
// on the fail-open rule — deepseek-v4-flash/v4-pro deliberately so: the
// vendor routes those aliases to vision-capable endpoints.
export const CONFIRMED_TEXT_ONLY_MODELS = Object.freeze([
  "deepseek-chat",
  "deepseek-reasoner",
  "glm-5.1",
  "glm-5.2",
  "glm-5.3",
  "mimo-v2.5-pro",
  "minimax-m2.7",
]);

const CONFIRMED_TEXT_ONLY_SET = new Set(CONFIRMED_TEXT_ONLY_MODELS);

// Channel-decorated ids this store actually carries: a leading "[Cloud]"/
// "[特价]"-style bracket label (sta1n channel) is the gateway's tag, not part
// of the model name, so it is peeled before the exact match. The trailing
// "[1m]" context marker is what Claude clients append to the 1M variant (the
// relay's own inbound normalization usually removes it first; kept here so
// the registry is safe on the openai path too). "models/" is the OpenRouter
// namespace prefix, stripped for registry parity.
export function normalizeModelId(value) {
  let id = typeof value === "string" ? value.trim() : "";
  if (id.length === 0) return "";
  id = id.toLowerCase();
  if (id.startsWith("models/")) id = id.slice("models/".length).trim();
  const labelled = /^\[[^\]]*\]\s*(.+)$/.exec(id);
  if (labelled) id = labelled[1].trim();
  if (id.endsWith("[1m]")) id = id.slice(0, -"[1m]".length).trim();
  return id;
}

/** Exact-match registry lookup, after id normalization. Fail-open by list. */
export function isConfirmedTextOnlyModel(modelId) {
  const normalized = normalizeModelId(modelId);
  if (normalized.length === 0) return false;
  // Provider-qualified ids ("deepseek/deepseek-chat") match on the tail.
  const tail = normalized.slice(normalized.lastIndexOf("/") + 1);
  return CONFIRMED_TEXT_ONLY_SET.has(tail);
}

/**
 * Whether a store model row declares itself text-only for image input.
 *
 * A row that states inputModalities at all is the operator's answer, and only
 * an answer that omits "image" (case-insensitive, trimmed) counts as
 * text-only; an absent or empty list is "unknown", never text-only — the
 * request path must not strip images off a guess.
 */
export function modelDeclaresTextOnly(model) {
  const declared = Array.isArray(model?.inputModalities) ? model.inputModalities : [];
  if (declared.length === 0) return false;
  return !declared.some(
    (item) => typeof item === "string" && item.trim().toLowerCase() === "image",
  );
}

/**
 * The request-path judgment: is this model text-only for image input?
 *
 * `registryEnabled` is the 纯文本预判 sub-switch — it gates ONLY the registry
 * tier. A store declaration answers regardless of both switches (a declared
 * image-capable model wins over a registry hit, exactly like ccswitch's
 * resolve_image_input_capability).
 */
export function requestModelIsTextOnly(model, modelId, registryEnabled) {
  const row = model ?? null;
  const declares = Array.isArray(row?.inputModalities) && row.inputModalities.length > 0;
  if (declares) {
    return !row.inputModalities.some(
      (item) => typeof item === "string" && item.trim().toLowerCase() === "image",
    );
  }
  return registryEnabled === true && isConfirmedTextOnlyModel(modelId);
}

// ---------- upstream rejection wording ----------

// The "your request body is wrong" codes. 415 (Unsupported Media Type) is the
// honest code for a modality refusal; 5xx are upstream trouble, not a verdict
// about the request, so a text-only wording on them is not trusted here.
const REJECTION_STATUSES = new Set([400, 415, 422]);

// Self-evident phrasings: these assert "only text is accepted" by themselves,
// with no need to mention image/media at all — 火山方舟 answers
// "Model only support text input" without the word image (issue #5025).
// Gateway English often drops the third-person s, so both spellings are
// listed; substring matching makes plural variants ("texts") fall in too.
const TEXT_ONLY_SELF_EVIDENT = ["only support text", "only supports text"];

const IMAGE_MENTION_WORDS = [
  "image",
  "vision",
  "multimodal",
  "multi-modal",
  "modality",
  "modalities",
  "media",
  "attachment",
];

const UNSUPPORTED_WORDS = [
  "unsupported",
  "not supported",
  "does not support",
  "doesn't support",
  "do not support",
  "don't support",
  "text only",
  "text-only",
  "invalid content type",
  "invalid message content",
  "unknown variant",
  "unknown content type",
  "unrecognized content type",
  "cannot process",
  "cannot handle",
  "can't process",
  "can't handle",
  "unable to process",
];

// The upstream's own words: a JSON error body contributes its message field
// (error.message / message / detail / a string error), anything else is
// searched as raw text so a schema dump naming `image_url` still matches.
function errorTextOf(rawText) {
  const text = typeof rawText === "string" ? rawText : "";
  if (text.length === 0) return "";
  try {
    const value = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const candidates = [value.error?.message, value.message, value.detail, value.error];
      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.length > 0) return candidate;
      }
      return JSON.stringify(value);
    }
  } catch {
    /* not JSON: search the raw text */
  }
  return text;
}

/**
 * Whether an upstream error says this model only accepts text.
 *
 * Status-narrow, wording-wide, case-insensitive: the same refusal arrives as
 * "This model does not support image input", 火山方舟's "Model only support
 * text input", or a deserializer dump "unknown variant `image_url`, expected
 * `text`". A message that mentions images but no refusal phrasing ("image
 * was 800px wide") is NOT a text-only verdict.
 */
export function looksLikeTextOnlyRejection(status, responseText) {
  if (!REJECTION_STATUSES.has(status)) return false;
  const message = errorTextOf(responseText).toLowerCase();
  if (message.length === 0) return false;
  if (TEXT_ONLY_SELF_EVIDENT.some((hint) => message.includes(hint))) return true;
  if (!IMAGE_MENTION_WORDS.some((word) => message.includes(word))) return false;
  return UNSUPPORTED_WORDS.some((hint) => message.includes(hint));
}
