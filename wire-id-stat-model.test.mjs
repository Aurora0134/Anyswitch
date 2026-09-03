// wireIdToStatModel tests (statistics model-name normalization). Pure
// functions, no IO. The transport layer feeds Claude Code's raw body.model —
// a full wire ID "anthropic/<provider>/<model>" — into the metrics tracker;
// journals and the panel must only ever see the bare model id.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wireIdToStatModel, wireIdToTargetId } from "./wire-id.mjs";

describe("wireIdToStatModel", () => {
  it("strips the wire prefix and the provider segment, keeping the bare model", () => {
    assert.equal(wireIdToStatModel("anthropic/sensenova/sensenova-6.8-flash-lite"), "sensenova-6.8-flash-lite");
    assert.equal(wireIdToStatModel("anthropic/acme-main/claude-opus-5"), "claude-opus-5");
  });

  it("keeps model ids that themselves contain '/' (first cut is the boundary)", () => {
    // Model ids may contain '/' (store invariant only constrains provider
    // ids); the provider segment is split off on the FIRST '/'.
    assert.equal(wireIdToStatModel("anthropic/vendorb-go/go/qwen3.8-max"), "go/qwen3.8-max");
  });

  it("passes plain (non-wire-id) model names through unchanged", () => {
    assert.equal(wireIdToStatModel("kimi-k3"), "kimi-k3");
    assert.equal(wireIdToStatModel("glm-5.3"), "glm-5.3");
    // The virtual chain model is not a wire id either; chain attribution
    // replaces it at the tracker level, and passing it through keeps that
    // replacement logic the single owner of "auto".
    assert.equal(wireIdToStatModel("auto"), "auto");
  });

  it("returns null for non-strings and empty input (never crashes the tracker)", () => {
    assert.equal(wireIdToStatModel(null), null);
    assert.equal(wireIdToStatModel(undefined), null);
    assert.equal(wireIdToStatModel(123), null);
    assert.equal(wireIdToStatModel(""), null);
  });

  it("keeps a malformed tail without '/' as its stripped form", () => {
    // "anthropic/<provider>" with no model segment: degenerate input, the
    // stripped provider segment is the best available label.
    assert.equal(wireIdToStatModel("anthropic/sensenova"), "sensenova");
  });

  it("does not double-strip (single-strip mirrors unpackWireId)", () => {
    // A model id legitimately starting with "anthropic/" after its provider
    // segment must survive intact.
    assert.equal(wireIdToStatModel("anthropic/prov/anthropic/weird-model"), "anthropic/weird-model");
  });
});

describe("wireIdToTargetId", () => {
  it("extracts the provider segment of a channel wire id (first '/' is the boundary)", () => {
    assert.equal(wireIdToTargetId("anthropic/sensenova/sensenova-6.8-flash-lite"), "sensenova");
    // Model ids may contain '/'; the provider segment never does.
    assert.equal(wireIdToTargetId("anthropic/vendorb-go/go/glm-5.3-flash"), "vendorb-go");
  });

  it("extracts the pool segment of a pool wire id (same wire shape)", () => {
    assert.equal(wireIdToTargetId("anthropic/sensenova/kimi-k3"), "sensenova");
  });

  it("returns null for non-wire-id input (auto, bare models, non-strings)", () => {
    assert.equal(wireIdToTargetId("auto"), null);
    assert.equal(wireIdToTargetId("kimi-k3"), null);
    assert.equal(wireIdToTargetId(null), null);
    assert.equal(wireIdToTargetId(undefined), null);
    assert.equal(wireIdToTargetId(123), null);
    assert.equal(wireIdToTargetId(""), null);
  });

  it("returns null for a malformed wire tail without a separator or empty segment", () => {
    // "anthropic/<provider>" has no model segment and "anthropic//m" has no
    // provider segment — neither yields an attributable target id.
    assert.equal(wireIdToTargetId("anthropic/sensenova"), null);
    assert.equal(wireIdToTargetId("anthropic//kimi-k3"), null);
  });

  it("does not double-strip (segment taken after exactly one prefix strip)", () => {
    assert.equal(wireIdToTargetId("anthropic/prov/anthropic/weird-model"), "prov");
  });
});
