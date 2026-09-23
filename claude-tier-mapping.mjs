// Claude Code 档位入口名 → Anyswitch 托管模型映射.
// Pure functions only. No IO, no DPAPI, no network.
//
// Claude Code owns four model TIERS of its own (Sonnet / Opus / Fable / Haiku).
// Wherever the client names one of those tiers rather than an Anyswitch wire ID
// — a sub-agent whose definition pins `model: sonnet`, the tier default it
// resolves to (`claude-sonnet-4-5-20250929`), a quick side query on the haiku
// tier — the request arrives at the relay asking for a model this relay does not
// proxy, and the strict wire-ID contract answers 400. That is the failure this
// mapping removes: the tier name is a ROUTING KEY, the operator's configured
// Anyswitch model is the destination, and everything downstream (routing,
// journal, model stability, the echoed response model) sees the destination.
//
// Scope limits are load-bearing, not polish. This is the ONE place where the
// relay resolves a model name that is not an Anyswitch model, so it is bounded
// as tightly as the contract it opens:
//   1. Only the Claude endpoint. The five tier names are Claude's vocabulary;
//      OpenCode / Pi / Kimi send their own model names, and a name they mean
//      literally must never be steered into a Claude tier's destination.
//   2. Only after strict resolution failed. A full wire ID and an unqualified
//      model that names exactly one channel are both real Anyswitch models and
//      always win — including when their id happens to contain a tier word.
//      An ambiguous unqualified hit is refused too: several channels carry that
//      name and only the operator knows which one was meant.
//   3. Only names that are unmistakably Claude's. The bare tier word, or an id
//      whose family segment is literally `claude` and which carries exactly one
//      tier word. Anything else stays a loud 400 — silently routing an
//      unrecognisable name to some pinned channel would turn a visible failure
//      into a wrong-channel billing row.
//   4. Only tiers the operator actually configured. An unfilled tier is not
//      collapsed onto another tier and not collapsed onto a default: ccs
//      degrades fable onto opus and folds unknowns onto its main model, and
//      both of those turn "go configure this row" into "worked, on a model you
//      never picked".

export const CLAUDE_TIERS = Object.freeze(["sonnet", "opus", "fable", "haiku"]);

// settings.json key holding the map. Values are wire IDs exactly as the panel
// picker produces them ("anthropic/<channel>/<model>"); the key is absent until
// the operator configures a tier, which keeps a fresh install behaviour-identical.
export const CLAUDE_TIER_MAPPING_SETTINGS_KEY = "claudeTierMappings";

// The only endpoint identity allowed to consult the map. Per-launch relays carry
// their own agentId (the Claude launcher's default), the resident relay derives
// it from the explicit x-agent-id header or the UA, so this is a fact about
// which process is serving the request — never a guess about the request body.
export const CLAUDE_TIER_AGENT_ID = "claude";

// Claude declares local context capability with a trailing bracketed marker
// (the `[1m]` family suffix); it is not part of any model name upstream
// accepts, so classification strips it first. Only this marker: Anyswitch
// model ids legitimately contain brackets elsewhere (a channel can carry
// "[cloud]deepseek-…"), and no other bracket suffix is Claude's.
const CAPABILITY_MARKER = /\[1m\]$/i;

// Where a model-family segment can begin: the start of the name, or after a
// vendor/path separator. Covers `claude-sonnet-4-5-20250929`, the catalog's
// `anthropic.claude-…` spelling and any `<vendor>/claude-…` path form, while
// still refusing a name that merely mentions "claude" mid-token.
const CLAUDE_FAMILY_RE = /(^|[./])claude-/i;

/**
 * Normalise the raw settings value into `{ tier: wireId }`.
 *
 * Unknown keys are dropped rather than passed through: a stale key left by an
 * older build must not keep matching. Empty or non-string values are dropped so
 * "cleared the row in the panel" and "never configured it" are the same state —
 * no takeover for that tier.
 */
export function parseClaudeTierMappings(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const mappings = {};
  for (const tier of CLAUDE_TIERS) {
    const value = raw[tier];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    mappings[tier] = trimmed;
  }
  return mappings;
}

/**
 * Decide whether a model name is one of Claude's four tier entries.
 *
 * Returns `{ ok: true, tier }` or `{ ok: false, reason }` with reasons that are
 * stable identifiers so the caller can log why it refused to intervene:
 *   not-a-string      — no name to classify
 *   empty             — blank after the marker was stripped
 *   not-claude-family — some vendor's model whose name happens to hold a tier word
 *   no-tier-word      — Claude's own id, but of a family with no tier here
 *   ambiguous-tier    — two or three tier words in one name; no honest winner
 */
export function classifyTierEntryName(model) {
  if (typeof model !== "string") return { ok: false, reason: "not-a-string" };
  const stripped = model.replace(CAPABILITY_MARKER, "").trim();
  if (stripped.length === 0) return { ok: false, reason: "empty" };
  if (!CLAUDE_FAMILY_RE.test(stripped) && !CLAUDE_TIERS.includes(stripped.toLowerCase())) {
    return { ok: false, reason: "not-claude-family" };
  }
  const lowered = stripped.toLowerCase();
  const exact = CLAUDE_TIERS.find((tier) => lowered === tier);
  if (exact !== undefined) return { ok: true, tier: exact };
  const hits = CLAUDE_TIERS.filter((tier) => lowered.includes(tier));
  if (hits.length === 1) return { ok: true, tier: hits[0] };
  return { ok: false, reason: hits.length === 0 ? "no-tier-word" : "ambiguous-tier" };
}

/**
 * Resolve a request model name against the configured map.
 *
 * `targetResolves` is an injected predicate (normally "does this name resolve to
 * an Anyswitch channel under the strict rules"), used only to reject a mapping
 * whose destination would itself be unroutable. Rejecting here rather than
 * rewriting and letting the 400 land on the destination names the misconfigured
 * row instead of looking like a channel outage.
 *
 * Returns `{ ok: true, tier, entry, wireId }` or `{ ok: false, reason, tier? }`.
 */
export function resolveTierEntry({ model, mappings, targetResolves = () => true } = {}) {
  const kind = classifyTierEntryName(model);
  if (!kind.ok) return { ok: false, reason: kind.reason };

  const wireId = mappings?.[kind.tier];
  if (typeof wireId !== "string" || wireId.length === 0) {
    return { ok: false, reason: "tier-unmapped", tier: kind.tier };
  }
  // A tier mapped onto its own entry name is a configuration loop: the rewrite
  // would produce the exact string that failed to resolve, so refuse it by name.
  if (wireId === model) {
    return { ok: false, reason: "self-mapping", tier: kind.tier };
  }
  if (!targetResolves(wireId)) {
    return { ok: false, reason: "target-unresolvable", tier: kind.tier };
  }
  return { ok: true, tier: kind.tier, entry: model, wireId };
}
