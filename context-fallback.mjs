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
// in doubt, leave a rule out — the unmatched default applies. Version-scoped
// rows are still allowed when vendor documentation pins one sub-family off the
// generic tier; each such rule below cites its basis.
//
// The unmatched default is 1M, deliberately not 999M: large enough that long
// sessions stop tripping the IDE's context-compression boundary on models that
// genuinely exceed 128K, small enough that the boundary still exists as
// protection.

// Ordered: first keyword (case-insensitive substring of the model id) wins.
// Keep prefixes specific enough not to shadow later rules.
//
// Tier values come from vendor documentation and the models.dev aggregate
// catalog (snapshot 2026-09-23). Underestimation drops live context when the
// IDE compresses early; overestimation lets a session grow past the upstream
// limit and hard-fails the request, so specific prefixes whose family moved
// off the generic tier get an earlier rule in either direction:
//   - gpt-5.x / gpt-6: the whole family sits at 1.05M (user call 2026-09-23:
//     no native-vs-gateway split; the old generic 272K gpt-5 tier is gone)
//   - claude-opus: Opus 4.6/4.7/4.8/5/5.5 are 1M; only Opus 4.5 stays 200K
//   - claude-sonnet-5 / claude-sonnet-4.6 / claude-fable: 1M, while
//     Sonnet 4.5 and Haiku stay at the generic 200K claude tier
//   - kimi-k3 is exactly 1048576 per Moonshot's own Codex config; kimi-k2
//     (2.6 / 2.7-code) is 262144 and would otherwise sit at the 1M default
//   - grok-4.5/4.6/4.7 are 500000 per xAI's model table, not the 1M default
//   - sensenova-6.7/6.8 flash variants (flash / flash-lite) are 262144 per the
//     same-family channel whose upstream actually reports context_length; the
//     keyword stops at "-flash" so the non-flash base models stay unmatched
export const CONTEXT_TIER_RULES = [
  { keyword: "gpt-6", contextWindow: 1_050_000 },
  { keyword: "gpt-5", contextWindow: 1_050_000 },
  { keyword: "gpt-4", contextWindow: 128_000 },
  { keyword: "claude-opus-4.5", contextWindow: 200_000 },
  { keyword: "claude-opus-4-5", contextWindow: 200_000 },
  { keyword: "claude-opus", contextWindow: 1_000_000 },
  { keyword: "claude-sonnet-5", contextWindow: 1_000_000 },
  { keyword: "claude-sonnet-4.6", contextWindow: 1_000_000 },
  { keyword: "claude-sonnet-4-6", contextWindow: 1_000_000 },
  { keyword: "claude-fable", contextWindow: 1_000_000 },
  { keyword: "claude", contextWindow: 200_000 },
  { keyword: "kimi-k3", contextWindow: 1_048_576 },
  { keyword: "kimi-k2", contextWindow: 262_144 },
  { keyword: "grok-4.5", contextWindow: 500_000 },
  { keyword: "grok-4.6", contextWindow: 500_000 },
  { keyword: "grok-4.7", contextWindow: 500_000 },
  { keyword: "sensenova-6.7-flash", contextWindow: 262_144 },
  { keyword: "sensenova-6.8-flash", contextWindow: 262_144 },
];

export const UNMATCHED_CONTEXT_FALLBACK = 1_000_000;

// One channel (SAIL-kimi) lists the model under the bare alias "k3" instead of
// the vendor id; normalize it so the k3 tier rule catches both spellings. The
// decorated spellings seen in the store get the same peel effort-catalog uses:
// leading [Channel] brackets in a loop, then a "vendor/model" namespace keeps
// its last segment — so "[SAIL]k3" and "sail/k3" normalize too. Only the
// peeled spelling is alias-checked; non-alias ids keep their original form for
// the substring keyword match.
function normalizeContextModelId(id) {
  let bare = id;
  while (/^\[[^\]]*\]/.test(bare)) bare = bare.replace(/^\[[^\]]*\]/, "").trim();
  while (bare.includes("/")) bare = bare.slice(bare.indexOf("/") + 1);
  return bare === "k3" ? "kimi-k3" : id;
}

// Fallback context window for a model the store has no real contextWindow for.
// Unknown/non-string ids resolve to the unmatched default, never to undefined.
export function fallbackContextWindow(modelId) {
  const id = normalizeContextModelId(typeof modelId === "string" ? modelId.toLowerCase() : "");
  for (const rule of CONTEXT_TIER_RULES) {
    if (id.includes(rule.keyword)) return rule.contextWindow;
  }
  return UNMATCHED_CONTEXT_FALLBACK;
}
