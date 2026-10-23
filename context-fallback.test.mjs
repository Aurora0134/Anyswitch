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
    assert.equal(fallbackContextWindow("[SQUALL]k3"), 1_048_576);
    assert.equal(fallbackContextWindow("[Cloud][SQUALL]K3"), 1_048_576);
    assert.equal(fallbackContextWindow("squall/k3"), 1_048_576);
    assert.equal(fallbackContextWindow("vendor/path/k3"), 1_048_576);
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

  it("maps SenseNova 6.7/6.8 flash variants to the 256K tier", () => {
    assert.equal(fallbackContextWindow("sensenova-6.7-flash-lite"), 262_144);
    assert.equal(fallbackContextWindow("sensenova-6.8-flash-lite"), 262_144);
    assert.equal(fallbackContextWindow("SenseNova-6.8-Flash"), 262_144);
  });

  it("keeps non-flash SenseNova base models on the unmatched default", () => {
    // The 256K tier is documented for the flash variants only; the bare
    // 6.7/6.8 ids must not be squeezed down to it.
    assert.equal(fallbackContextWindow("sensenova-6.7"), UNMATCHED_CONTEXT_FALLBACK);
    assert.equal(fallbackContextWindow("sensenova-6.8"), UNMATCHED_CONTEXT_FALLBACK);
    assert.equal(fallbackContextWindow("sensenova-6.8-pro"), UNMATCHED_CONTEXT_FALLBACK);
  });

  it("maps MiniMax M3.1 Flash ids to the 1M tier, including channel decorations", () => {
    // Vendor documents 1,000,000 for MiniMax-M3.1-Flash. The keyword is scoped
    // to the m3.1 sub-family, so the bare "minimax" spelling a gateway might
    // carry for an older M row stays on the unmatched default.
    assert.equal(fallbackContextWindow("MiniMax-M3.1-Flash"), 1_000_000);
    assert.equal(fallbackContextWindow("minimax-m3.1-flash"), 1_000_000);
    assert.equal(fallbackContextWindow("[Cloud]MiniMax-M3.1-Flash"), 1_000_000);
    assert.equal(fallbackContextWindow("[次][Cloud]MiniMax-M3.1-Flash"), 1_000_000);
    assert.equal(fallbackContextWindow("go/minimax-m3.1-flash"), 1_000_000);
    assert.equal(fallbackContextWindow("minimax-m3.1-flash-free"), 1_000_000);
  });

  it("maps Step 5 Preview to the 1M tier", () => {
    assert.equal(fallbackContextWindow("step-5-preview"), 1_000_000);
    assert.equal(fallbackContextWindow("Step-5-Preview"), 1_000_000);
    assert.equal(fallbackContextWindow("[Cloud]step-5-preview"), 1_000_000);
  });

  it("leaves non-m3.1 MiniMax ids on the unmatched default", () => {
    assert.equal(fallbackContextWindow("minimax-m3"), UNMATCHED_CONTEXT_FALLBACK);
    assert.equal(fallbackContextWindow("MiniMax-M2.7"), UNMATCHED_CONTEXT_FALLBACK);
  });

  it("never returns undefined for malformed ids", () => {
    assert.equal(fallbackContextWindow(null), UNMATCHED_CONTEXT_FALLBACK);
    assert.equal(fallbackContextWindow(undefined), UNMATCHED_CONTEXT_FALLBACK);
    assert.equal(fallbackContextWindow(""), UNMATCHED_CONTEXT_FALLBACK);
    assert.equal(fallbackContextWindow(12345), UNMATCHED_CONTEXT_FALLBACK);
  });
});
