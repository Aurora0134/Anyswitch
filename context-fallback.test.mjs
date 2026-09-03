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

  it("keeps tier rules to a small curated set, not a static model library", () => {
    // A growing per-model table is exactly what the compat plan rejects
    // (兜底层 4.1): tiers go stale as upstreams iterate. Six is the surveyed
    // 2026-08 set: gpt-5.5/gpt-5.6/gpt-5/gpt-4/claude-opus/claude.
    assert.ok(CONTEXT_TIER_RULES.length <= 6);
  });
});

describe("fallbackContextWindow", () => {
  it("maps GPT-5.5/5.6 family ids to the 1M tier ahead of the generic gpt-5 rule", () => {
    assert.equal(fallbackContextWindow("gpt-5.5-turbo"), 1_000_000);
    assert.equal(fallbackContextWindow("gpt-5.6-terra"), 1_000_000);
    assert.equal(fallbackContextWindow("GPT-5.6"), 1_000_000);
  });

  it("maps generic GPT-5.x family ids to the 272K tier", () => {
    assert.equal(fallbackContextWindow("gpt-5.4-preview"), 272000);
    assert.equal(fallbackContextWindow("gpt-5"), 272000);
    assert.equal(fallbackContextWindow("GPT-5-MINI"), 272000);
  });

  it("maps GPT-4.x family ids to the 128K tier", () => {
    assert.equal(fallbackContextWindow("gpt-4o"), 128000);
    assert.equal(fallbackContextWindow("gpt-4.1-mini"), 128000);
  });

  it("maps Claude Opus ids to the 1M tier ahead of the generic claude rule", () => {
    assert.equal(fallbackContextWindow("claude-opus-5"), 1_000_000);
    assert.equal(fallbackContextWindow("Claude-Opus-4-6"), 1_000_000);
  });

  it("maps non-Opus Claude family ids to the 200K tier", () => {
    assert.equal(fallbackContextWindow("claude-sonnet-5"), 200000);
    assert.equal(fallbackContextWindow("Claude-Sonnet-4"), 200000);
    assert.equal(fallbackContextWindow("claude-haiku-4-5"), 200000);
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
