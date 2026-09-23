// Claude tier-entry mapping unit tests. Synthetic data only — the module is
// pure, so every row below is a name Claude Code really puts on the wire plus
// the neighbours that must NOT be taken over.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CLAUDE_TIERS,
  parseClaudeTierMappings,
  classifyTierEntryName,
  resolveTierEntry,
} from "./claude-tier-mapping.mjs";

test("tiers are exactly Claude's four, in the panel's row order", () => {
  assert.deepEqual([...CLAUDE_TIERS], ["sonnet", "opus", "fable", "haiku"]);
});

test("parseClaudeTierMappings keeps only configured tiers", () => {
  assert.deepEqual(
    parseClaudeTierMappings({
      sonnet: "anthropic/a/kimi-k3",
      opus: "  ",
      fable: "anthropic/b/glm-5.3",
      haiku: 42,
      gpt: "anthropic/c/x",
    }),
    { sonnet: "anthropic/a/kimi-k3", fable: "anthropic/b/glm-5.3" },
  );
});

test("parseClaudeTierMappings survives every unusable shape", () => {
  for (const raw of [undefined, null, "sonnet", 7, ["sonnet"], {}]) {
    assert.deepEqual(parseClaudeTierMappings(raw), {});
  }
});

test("bare tier words classify to their own tier", () => {
  for (const tier of CLAUDE_TIERS) {
    assert.deepEqual(classifyTierEntryName(tier), { ok: true, tier });
  }
  // A sub-agent definition spells it however the model felt like writing.
  assert.deepEqual(classifyTierEntryName("Sonnet"), { ok: true, tier: "sonnet" });
  assert.deepEqual(classifyTierEntryName("  opus  "), { ok: true, tier: "opus" });
});

test("Anthropic official ids classify by their family segment", () => {
  assert.deepEqual(classifyTierEntryName("claude-sonnet-4-5-20250929"), { ok: true, tier: "sonnet" });
  assert.deepEqual(classifyTierEntryName("claude-opus-5"), { ok: true, tier: "opus" });
  assert.deepEqual(classifyTierEntryName("claude-haiku-4-5"), { ok: true, tier: "haiku" });
  assert.deepEqual(classifyTierEntryName("claude-fable-5"), { ok: true, tier: "fable" });
  // Catalog-qualified and dated spellings carry the family after a separator.
  assert.deepEqual(classifyTierEntryName("anthropic.claude-sonnet-4-5"), { ok: true, tier: "sonnet" });
  assert.deepEqual(classifyTierEntryName("us.anthropic.claude-opus-4-1"), { ok: true, tier: "opus" });
});

test("the trailing capability marker is not part of the name", () => {
  assert.deepEqual(classifyTierEntryName("claude-sonnet-4-5-20250929[1m]"), { ok: true, tier: "sonnet" });
  assert.deepEqual(classifyTierEntryName("sonnet[1M]"), { ok: true, tier: "sonnet" });
  // A bracketed prefix is not a separator: "[cloud]claude-…" is some channel's
  // own model id, and a name that specific resolves under the strict rules.
  assert.equal(classifyTierEntryName("[cloud]claude-sonnet-5").reason, "not-claude-family");
});

test("names that are not Claude's tier vocabulary are refused, not guessed", () => {
  // Another vendor's model that happens to carry a tier word: not this map's
  // business, and taking it over would move traffic to a different channel.
  assert.equal(classifyTierEntryName("deepseek-v4-sonnet-lite").ok, false);
  assert.equal(classifyTierEntryName("deepseek-v4-sonnet-lite").reason, "not-claude-family");
  assert.equal(classifyTierEntryName("kimi-k3").reason, "not-claude-family");
  // Claude's own name, but no tier in it.
  assert.equal(classifyTierEntryName("claude-2.1").reason, "no-tier-word");
  assert.equal(classifyTierEntryName("claude-code-router").reason, "no-tier-word");
  // Two tiers in one name: there is no honest winner.
  assert.equal(classifyTierEntryName("claude-sonnet-opus-mix").reason, "ambiguous-tier");
  // Nothing to classify.
  assert.equal(classifyTierEntryName(undefined).reason, "not-a-string");
  assert.equal(classifyTierEntryName(42).reason, "not-a-string");
  assert.equal(classifyTierEntryName("  [1m]").reason, "empty");
  // Anyswitch's own vocabulary belongs to the strict path, never to this one.
  assert.equal(classifyTierEntryName("auto").reason, "not-claude-family");
  assert.equal(classifyTierEntryName("<synthetic>").reason, "not-claude-family");
});

test("resolveTierEntry maps a configured tier onto its destination", () => {
  const mappings = { sonnet: "anthropic/a6api/kimi-k3", haiku: "anthropic/s3ai/flash-lite" };
  assert.deepEqual(
    resolveTierEntry({ model: "claude-sonnet-4-5-20250929", mappings }),
    { ok: true, tier: "sonnet", entry: "claude-sonnet-4-5-20250929", wireId: "anthropic/a6api/kimi-k3" },
  );
  assert.deepEqual(resolveTierEntry({ model: "haiku", mappings }), {
    ok: true,
    tier: "haiku",
    entry: "haiku",
    wireId: "anthropic/s3ai/flash-lite",
  });
});

test("an unfilled tier is refused, never degraded onto another tier", () => {
  // The behaviour ccs does not have: it folds fable onto opus and unknowns onto
  // its main model. Both turn "configure this row" into a silent destination.
  assert.deepEqual(resolveTierEntry({ model: "claude-fable-5", mappings: { opus: "anthropic/a/x" } }), {
    ok: false,
    reason: "tier-unmapped",
    tier: "fable",
  });
  assert.equal(resolveTierEntry({ model: "claude-opus-5", mappings: {} }).reason, "tier-unmapped");
});

test("a tier mapped onto its own entry name is refused as a loop", () => {
  assert.deepEqual(resolveTierEntry({ model: "sonnet", mappings: { sonnet: "sonnet" } }), {
    ok: false,
    reason: "self-mapping",
    tier: "sonnet",
  });
});

test("a destination the relay cannot resolve is refused before the rewrite", () => {
  const resolves = (target) => target.startsWith("anthropic/");
  assert.deepEqual(
    resolveTierEntry({ model: "opus", mappings: { opus: "claude-opus-5" }, targetResolves: resolves }),
    { ok: false, reason: "target-unresolvable", tier: "opus" },
  );
  assert.equal(
    resolveTierEntry({ model: "opus", mappings: { opus: "anthropic/a/x" }, targetResolves: resolves }).ok,
    true,
  );
});

test("resolveTierEntry does not invent a tier for a non-Claude name", () => {
  assert.equal(resolveTierEntry({ model: "glm-5.3", mappings: { opus: "anthropic/a/x" } }).reason, "not-claude-family");
});
