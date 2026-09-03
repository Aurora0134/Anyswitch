// Pool-aware wire ID resolution tests (phase 2). Pure functions, no IO.
// Covers: qualified pool targets (pools-before-providers tie break), a pool
// id that reuses a member's id, and the unqualified scan where each pool is
// ONE match unit matched on its members' catalog union (matching members are
// absorbed into their pool's unit).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { unpackWireId, buildWireCatalog, UNPACK_REASON } from "./wire-id.mjs";

function makeStore() {
  return {
    version: 2,
    providers: {
      "member-a": {
        displayName: "Member A",
        baseURL: "http://a.invalid/v1",
        models: { "claude-pool": { displayName: "Pool from A" }, "claude-a-only": {} },
      },
      "member-b": {
        displayName: "Member B",
        baseURL: "http://b.invalid/v1",
        models: { "claude-pool": { displayName: "Pool from B" } },
      },
      solo: {
        displayName: "Solo",
        baseURL: "http://solo.invalid/v1",
        models: { "claude-solo": {} },
      },
    },
    pools: {
      "test-pool": { displayName: "Test Pool", members: ["member-a", "member-b"] },
    },
  };
}

describe("unpackWireId pool awareness: qualified form", () => {
  it("resolves anthropic/<poolId>/<modelId> as a pool target", () => {
    const out = unpackWireId("anthropic/test-pool/claude-pool", makeStore());
    assert.equal(out.ok, true);
    assert.equal(out.pool, true);
    assert.equal(out.poolId, "test-pool");
    assert.equal(out.providerId, "test-pool", "providerId mirrors the segment for legacy consumers");
    assert.equal(out.modelId, "claude-pool");
    assert.equal(out.canonicalId, "test-pool/claude-pool");
  });

  it("checks pools before providers: a pool id that reuses a member id wins", () => {
    const store = makeStore();
    // Pool id identical to a member provider id.
    store.pools["member-a"] = { displayName: "Same-name Pool", members: ["member-a", "member-b"] };
    const out = unpackWireId("anthropic/member-a/claude-pool", store);
    assert.equal(out.ok, true);
    assert.equal(out.pool, true, "the pool must win the tie over the provider with the same id");
    assert.equal(out.poolId, "member-a");
  });

  it("does not check model membership: an unknown model on a pool still unpacks", () => {
    // The caller's pool plan answers 404; unpacking stays syntactic.
    const out = unpackWireId("anthropic/test-pool/claude-nonexistent", makeStore());
    assert.equal(out.ok, true);
    assert.equal(out.pool, true);
    assert.equal(out.modelId, "claude-nonexistent");
  });

  it("keeps the plain provider shape for non-pool segments", () => {
    const out = unpackWireId("anthropic/solo/claude-solo", makeStore());
    assert.equal(out.ok, true);
    assert.equal(out.pool, undefined);
    assert.equal(out.providerId, "solo");
  });

  it("stays purely syntactic when no store is supplied", () => {
    const out = unpackWireId("anthropic/test-pool/claude-pool");
    assert.equal(out.ok, true);
    assert.equal(out.pool, undefined);
    assert.equal(out.providerId, "test-pool");
  });
});

describe("unpackWireId pool awareness: unqualified scan", () => {
  it("resolves a pool-union hit to the pool, absorbing the matching member", () => {
    // claude-pool lives in member-a and member-b, both members of test-pool.
    // The member provider matches are absorbed into the pool's single unit.
    const out = unpackWireId("claude-pool", makeStore());
    assert.equal(out.ok, true);
    assert.equal(out.pool, true);
    assert.equal(out.poolId, "test-pool");
    assert.equal(out.modelId, "claude-pool");
    assert.equal(out.legacy, true);
    assert.equal(out.canonicalId, "test-pool/claude-pool");
  });

  it("absorbs even when only one member carries the model", () => {
    const out = unpackWireId("claude-a-only", makeStore());
    assert.equal(out.ok, true);
    assert.equal(out.pool, true, "member-a's match is absorbed into test-pool's unit");
    assert.equal(out.poolId, "test-pool");
    assert.equal(out.modelId, "claude-a-only");
  });

  it("a model in a standalone provider AND a pool union is ambiguous (conservative)", () => {
    const store = makeStore();
    store.providers.solo.models["claude-pool"] = { displayName: "Solo copy" };
    const out = unpackWireId("claude-pool", store);
    assert.equal(out.ok, false);
    assert.equal(out.reason, UNPACK_REASON.AMBIGUOUS_UNQUALIFIED);
  });

  it("a model carried by two pools is ambiguous", () => {
    const store = makeStore();
    store.pools["other-pool"] = { displayName: "Other Pool", members: ["member-b"] };
    const out = unpackWireId("claude-pool", store);
    assert.equal(out.ok, false);
    assert.equal(out.reason, UNPACK_REASON.AMBIGUOUS_UNQUALIFIED);
  });

  it("a model in two standalone providers stays ambiguous, pools or not", () => {
    const store = makeStore();
    store.providers.solo.models["claude-solo-2"] = {};
    store.providers.extra = { displayName: "Extra", baseURL: "http://x.invalid/v1", models: { "claude-solo-2": {} } };
    const out = unpackWireId("claude-solo-2", store);
    assert.equal(out.ok, false);
    assert.equal(out.reason, UNPACK_REASON.AMBIGUOUS_UNQUALIFIED);
  });

  it("applies dated -YYYYMMDD stripping to pool unions too", () => {
    const store = makeStore();
    store.providers["member-a"].models["claude-haiku-4-5"] = {};
    const out = unpackWireId("claude-haiku-4-5-20251001", store);
    assert.equal(out.ok, true);
    assert.equal(out.pool, true, "the dated candidate strips to the member catalog, hence the pool union");
    assert.equal(out.poolId, "test-pool");
    assert.equal(out.modelId, "claude-haiku-4-5");
  });

  it("still resolves a plain single-provider match untouched", () => {
    const out = unpackWireId("claude-solo", makeStore());
    assert.equal(out.ok, true);
    assert.equal(out.pool, undefined);
    assert.equal(out.providerId, "solo");
    assert.equal(out.legacy, true);
  });

  it("still reports unknown when neither providers nor pools carry the model", () => {
    const out = unpackWireId("claude-nowhere", makeStore());
    assert.equal(out.ok, false);
    assert.equal(out.reason, UNPACK_REASON.UNKNOWN_UNQUALIFIED);
  });
});

describe("buildWireCatalog pool awareness", () => {
  it("emits each pool as ONE unit with the union of member catalogs", () => {
    const entries = buildWireCatalog(makeStore());
    const wireIds = entries.map((e) => e.wireId);
    // Pool union: claude-pool + claude-a-only from member-a, claude-pool from
    // member-b (dedup), plus the standalone provider's model.
    assert.deepEqual(wireIds.sort(), [
      "anthropic/solo/claude-solo",
      "anthropic/test-pool/claude-a-only",
      "anthropic/test-pool/claude-pool",
    ]);
    const poolEntry = entries.find((e) => e.modelId === "claude-pool");
    assert.equal(poolEntry.displayName, "[test-pool] Pool from A", "first member wins duplicate model metadata");
  });

  it("absorbs member providers: they never appear as standalone entries", () => {
    const entries = buildWireCatalog(makeStore());
    assert.equal(entries.some((e) => e.providerId === "member-a" || e.providerId === "member-b"), false);
  });

  it("survives a pool id that reuses a member id (no wire-ID collision)", () => {
    const store = makeStore();
    // Pool id identical to a member provider id — schema-legal. Without
    // member absorption this is a §1.5 collision that fails the whole catalog.
    delete store.pools["test-pool"];
    store.pools["member-a"] = { displayName: "Same-name Pool", members: ["member-a", "member-b"] };
    const entries = buildWireCatalog(store);
    const wireIds = entries.map((e) => e.wireId).sort();
    assert.deepEqual(wireIds, [
      "anthropic/member-a/claude-a-only",
      "anthropic/member-a/claude-pool",
      "anthropic/solo/claude-solo",
    ]);
    // The emitted pool wireIds still unpack back to pool targets.
    const out = unpackWireId("anthropic/member-a/claude-pool", store);
    assert.equal(out.ok, true);
    assert.equal(out.pool, true);
    assert.equal(out.poolId, "member-a");
  });

  it("keeps standalone providers untouched when no pools exist", () => {
    const store = makeStore();
    delete store.pools;
    const entries = buildWireCatalog(store);
    assert.deepEqual(entries.map((e) => e.wireId).sort(), [
      "anthropic/member-a/claude-a-only",
      "anthropic/member-a/claude-pool",
      "anthropic/member-b/claude-pool",
      "anthropic/solo/claude-solo",
    ]);
  });
});
