import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fallbackContextWindow,
  CONTEXT_TIER_RULES,
  UNMATCHED_CONTEXT_FALLBACK,
} from "./context-fallback.mjs";

describe("CONTEXT_TIER_RULES", () => {
  it("is an ordered list of well-formed keyword tiers", () => {
    assert.ok(Array.isArray(CONTEXT_TIER_RULES));
    assert.ok(CONTEXT_TIER_RULES.length > 0);
    for (const rule of CONTEXT_TIER_RULES) {
      assert.equal(typeof rule.keyword, "string");
      assert.ok(rule.keyword.length > 0);
      assert.ok(Number.isInteger(rule.contextWindow));
      assert.ok(rule.contextWindow > 0);
    }
  });

  it("keeps every rule reachable: no earlier rule shadows a later one", () => {
    // First keyword wins, so a rule whose own keyword resolves to a different
    // tier is either dead weight or an ordering bug.
    for (const rule of CONTEXT_TIER_RULES) {
      assert.equal(
        fallbackContextWindow(rule.keyword),
        rule.contextWindow,
        `rule "${rule.keyword}" is shadowed by an earlier rule`,
      );
    }
  });
});

describe("fallbackContextWindow", () => {
  it("maps the whole GPT-5.x / GPT-6 family to the 1.05M tier", () => {
    assert.equal(fallbackContextWindow("gpt-5"), 1_050_000);
    assert.equal(fallbackContextWindow("gpt-5.4-preview"), 1_050_000);
    assert.equal(fallbackContextWindow("gpt-5.5-turbo"), 1_050_000);
    assert.equal(fallbackContextWindow("gpt-5.6-terra"), 1_050_000);
    assert.equal(fallbackContextWindow("GPT-5.6"), 1_050_000);
    assert.equal(fallbackContextWindow("gpt-6-astra"), 1_050_000);
    assert.equal(fallbackContextWindow("openai/gpt-6-luna"), 1_050_000);
  });

  it("maps GPT-4.x family ids to the 128K tier", () => {
    assert.equal(fallbackContextWindow("gpt-4o"), 128000);
    assert.equal(fallbackContextWindow("gpt-4.1-mini"), 128000);
  });

  it("maps Claude Opus 4.6+ ids to the 1M tier while Opus 4.5 stays at 200K", () => {
    assert.equal(fallbackContextWindow("claude-opus-5"), 1_000_000);
    assert.equal(fallbackContextWindow("Claude-Opus-4-6"), 1_000_000);
    assert.equal(fallbackContextWindow("claude-opus-5-5"), 1_000_000);
    assert.equal(fallbackContextWindow("claude-opus-4.5"), 200_000);
    assert.equal(fallbackContextWindow("claude-opus-4-5"), 200_000);
  });

  it("maps Claude Sonnet 5 / Sonnet 4.6 / Fable to the 1M tier ahead of generic claude", () => {
    assert.equal(fallbackContextWindow("claude-sonnet-5"), 1_000_000);
    assert.equal(fallbackContextWindow("claude-sonnet-5-thinking"), 1_000_000);
    assert.equal(fallbackContextWindow("claude-sonnet-4.6"), 1_000_000);
    assert.equal(fallbackContextWindow("claude-sonnet-4-6-thinking"), 1_000_000);
    assert.equal(fallbackContextWindow("claude-fable-5"), 1_000_000);
    assert.equal(fallbackContextWindow("claude-fable-5.1"), 1_000_000);
  });

  it("keeps older Claude tiers at 200K", () => {
    assert.equal(fallbackContextWindow("Claude-Sonnet-4"), 200_000);
    assert.equal(fallbackContextWindow("claude-sonnet-4-5"), 200_000);
    assert.equal(fallbackContextWindow("claude-haiku-4-5"), 200_000);
  });

  it("maps Kimi tiers, including the bare k3 alias and bracketed channel prefixes", () => {
    assert.equal(fallbackContextWindow("kimi-k3"), 1_048_576);
    assert.equal(fallbackContextWindow("Kimi-K3"), 1_048_576);
    assert.equal(fallbackContextWindow("[Cloud]Kimi-K3"), 1_048_576);
    assert.equal(fallbackContextWindow("k3"), 1_048_576);
    assert.equal(fallbackContextWindow("kimi-k2.6"), 262_144);
    assert.equal(fallbackContextWindow("Kimi-K2.6-free"), 262_144);
    assert.equal(fallbackContextWindow("[Cloud]Kimi-K2.7-Code"), 262_144);
  });

  it("maps Grok 4.5/4.6/4.7 to the 500K tier instead of the 1M default", () => {
    assert.equal(fallbackContextWindow("grok-4.5"), 500_000);
    assert.equal(fallbackContextWindow("grok-4.6"), 500_000);
    assert.equal(fallbackContextWindow("grok-4.6-free"), 500_000);
    assert.equal(fallbackContextWindow("grok-4.7"), 500_000);
  });

  it("maps SenseNova 6.7/6.8 flash-lite to the 256K tier", () => {
    assert.equal(fallbackContextWindow("sensenova-6.7-flash-lite"), 262_144);
    assert.equal(fallbackContextWindow("sensenova-6.8-flash-lite"), 262_144);
  });

  it("falls back to 1M for unmatched model families", () => {
    assert.equal(fallbackContextWindow("deepseek-v4-pro"), UNMATCHED_CONTEXT_FALLBACK);
    assert.equal(fallbackContextWindow("gemini-3.6-flash"), UNMATCHED_CONTEXT_FALLBACK);
    assert.equal(fallbackContextWindow("glm-5.2"), UNMATCHED_CONTEXT_FALLBACK);
    assert.equal(UNMATCHED_CONTEXT_FALLBACK, 1_000_000);
  });

  it("never returns undefined for malformed ids", () => {
    assert.equal(fallbackContextWindow(null), UNMATCHED_CONTEXT_FALLBACK);
    assert.equal(fallbackContextWindow(undefined), UNMATCHED_CONTEXT_FALLBACK);
    assert.equal(fallbackContextWindow(""), UNMATCHED_CONTEXT_FALLBACK);
    assert.equal(fallbackContextWindow(12345), UNMATCHED_CONTEXT_FALLBACK);
  });
});
