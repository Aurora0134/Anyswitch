// Context-window fallback tiers.
// Pure functions only. No IO, no DPAPI, no network.
//
// This module is the LAST resort of the context-window priority chain:
//   1. store contextWindow — the real value L1 discovery captured from the
//      upstream /models response; always wins when present
//   2. keyword tier below — for families whose tier is stable and well known
//   3. UNMATCHED_CONTEXT_FALLBACK (1M) — everything else
//
// It is a *tier map*, not a static model knowledge base. Rules must describe
// slow-moving per-family tiers, never per-model rows: upstreams iterate faster
// than any curated list, and L1 discovery is the primary source of truth. When
// in doubt, leave a rule out — the unmatched default applies.
//
// The unmatched default is 1M, deliberately not 999M: large enough that long
// sessions stop tripping the IDE's context-compression boundary on models that
// genuinely exceed 128K, small enough that the boundary still exists as
// protection.

// Ordered: first keyword (case-insensitive substring of the model id) wins.
// Keep prefixes specific enough not to shadow later rules.
//
// Tier values verified against the 2026-08-16 context-window survey of all
// 303 store models (227 verified from vendor docs). The survey's core
// finding: underestimation is the only dangerous direction (it drops live
// context when the IDE compresses early), so specific prefixes whose family
// outgrew the generic tier get an earlier, larger rule:
//   - claude-opus: Opus 4.6/4.7/4.8/5 are all 1M while Sonnet/Haiku stay 200K
//   - gpt-5.5 / gpt-5.6: 400K-default/1M vs the generic 272K gpt-5 tier
export const CONTEXT_TIER_RULES = [
  { keyword: "gpt-5.5", contextWindow: 1_000_000 },
  { keyword: "gpt-5.6", contextWindow: 1_000_000 },
  { keyword: "gpt-5", contextWindow: 272000 },
  { keyword: "gpt-4", contextWindow: 128000 },
  { keyword: "claude-opus", contextWindow: 1_000_000 },
  { keyword: "claude", contextWindow: 200000 },
];

export const UNMATCHED_CONTEXT_FALLBACK = 1_000_000;

// Fallback context window for a model the store has no real contextWindow for.
// Unknown/non-string ids resolve to the unmatched default, never to undefined.
export function fallbackContextWindow(modelId) {
  const id = typeof modelId === "string" ? modelId.toLowerCase() : "";
  for (const rule of CONTEXT_TIER_RULES) {
    if (id.includes(rule.keyword)) return rule.contextWindow;
  }
  return UNMATCHED_CONTEXT_FALLBACK;
}
