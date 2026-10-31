import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { derivePoolPseudoProviders, deriveVisibleChannels } from "./pool-providers.mjs";

const STORE = {
  version: 2,
  providers: {
    alpha: {
      displayName: "Alpha",
      baseURL: "https://alpha.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "alpha.dpapi",
      models: {
        "model-a": { displayName: "Model A", contextWindow: 100000 },
        "model-shared": { displayName: "Shared (alpha)", contextWindow: 111 },
      },
    },
    beta: {
      displayName: "Beta",
      baseURL: "https://beta.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "beta.dpapi",
      models: {
        "model-shared": { displayName: "Shared (beta)", contextWindow: 222 },
        "model-b": { displayName: "Model B", contextWindow: 200000 },
      },
    },
  },
  pools: {
    "pool-ab": { displayName: "Pool AB", members: ["alpha", "beta"] },
  },
};

describe("derivePoolPseudoProviders", () => {
  it("returns an empty map when the store has no pools", () => {
    assert.deepEqual(derivePoolPseudoProviders({ version: 2, providers: {} }), {});
    assert.deepEqual(derivePoolPseudoProviders({}), {});
    assert.deepEqual(derivePoolPseudoProviders(null), {});
  });

  it("unions member models in pool member order, first occurrence wins metadata", () => {
    const pseudo = derivePoolPseudoProviders(STORE);
    const pool = pseudo["pool-ab"];
    assert.ok(pool);
    assert.deepEqual(Object.keys(pool.models), ["model-a", "model-shared", "model-b"]);
    // model-shared is offered by both members; alpha (first in pool order) wins.
    assert.deepEqual(pool.models["model-shared"], { displayName: "Shared (alpha)", contextWindow: 111 });
  });

  it("labels the channel with the pool displayName, falling back to the pool id", () => {
    const pseudo = derivePoolPseudoProviders(STORE);
    assert.equal(pseudo["pool-ab"].displayName, "Pool AB");
    assert.equal(pseudo["pool-ab"].channelName, "Pool AB");

    // Runtime leniency beyond the store schema (validatePools requires a
    // non-empty displayName): the derivation must still never emit an empty
    // channelName, so the merge modules can rely on `channelName ?? providerId`.
    const unnamed = derivePoolPseudoProviders({
      providers: STORE.providers,
      pools: { "pool-ab": { displayName: "", members: ["alpha", "beta"] } },
    });
    assert.equal(unnamed["pool-ab"].channelName, "pool-ab");
  });

  it("skips members missing from providers and pools with no usable models", () => {
    const pseudo = derivePoolPseudoProviders({
      providers: STORE.providers,
      pools: {
        "pool-partial": { displayName: "Partial", members: ["ghost", "beta"] },
        "pool-empty": { displayName: "Empty", members: ["ghost", "also-ghost"] },
      },
    });
    assert.deepEqual(Object.keys(pseudo["pool-partial"].models), ["model-shared", "model-b"]);
    assert.equal(pseudo["pool-empty"], undefined);
  });

  it("does not mutate the store and isolates the derived model metadata", () => {
    const before = structuredClone(STORE);
    const pseudo = derivePoolPseudoProviders(STORE);
    pseudo["pool-ab"].models["model-a"].contextWindow = 1;
    assert.deepEqual(STORE, before);
  });
});

describe("deriveVisibleChannels ordering", () => {
  it("surfaces a pool at its earliest member's slot, matching the panel's visible order", () => {
    const channels = deriveVisibleChannels({
      providers: {
        "solo-1": { models: { "m-1": {} } },
        alpha: { models: { "model-a": {} } },
        beta: { models: { "model-b": {} } },
        "solo-2": { models: { "m-2": {} } },
      },
      pools: { "pool-ab": { displayName: "Pool AB", members: ["alpha", "beta"] } },
    });
    assert.deepEqual(Object.keys(channels), ["solo-1", "pool-ab", "solo-2"]);
    assert.equal(channels["pool-ab"].channelName, "Pool AB");
    assert.equal(channels.alpha, undefined, "members stay absorbed");
    assert.equal(channels.beta, undefined, "members stay absorbed");
  });

  it("takes the earliest member's slot in providers key order, not members[0]", () => {
    // s0 sits between the two members so the slot choice is observable: the
    // pool must surface at alpha's slot (first member in providers key order);
    // a members[0] implementation would push it behind s0.
    const channels = deriveVisibleChannels({
      providers: {
        alpha: { models: { "model-a": {} } },
        s0: { models: { "m-0": {} } },
        beta: { models: { "model-b": {} } },
      },
      pools: { "pool-ab": { displayName: "Pool AB", members: ["beta", "alpha"] } },
    });
    assert.deepEqual(Object.keys(channels), ["pool-ab", "s0"]);
  });

  it("skips providers without models while keeping the pool at its member's slot", () => {
    const channels = deriveVisibleChannels({
      providers: {
        empty: {},
        alpha: { models: { "model-a": {} } },
        filler: { models: { "m-0": {} } },
        "solo-1": { models: { "m-1": {} } },
      },
      pools: { "pool-ab": { displayName: "Pool AB", members: ["alpha", "filler"] } },
    });
    assert.deepEqual(Object.keys(channels), ["pool-ab", "solo-1"]);
  });

  it("lets a pool win a pool-id/provider-id tie in place", () => {
    // Defensive path: validatePools rejects a pool id colliding with a
    // NON-member provider id, but the relay resolves pools before providers
    // (resolvePool), so the derivation must keep that pool-first precedence
    // even for stores that bypassed validation. `after` sits behind `twin` so
    // winning "in place" (not at the tail) stays observable.
    const channels = deriveVisibleChannels({
      providers: {
        "solo-1": { models: { "m-1": {} } },
        twin: { models: { "model-a": {} } },
        after: { models: { "m-2": {} } },
        other: { models: { "model-b": {} } },
        another: { models: { "model-c": {} } },
      },
      pools: { twin: { displayName: "Twin Pool", members: ["other", "another"] } },
    });
    assert.deepEqual(Object.keys(channels), ["solo-1", "twin", "after"]);
    // channelName only exists on pool pseudo-channels — a provider winning the
    // tie would leave it undefined.
    assert.equal(channels.twin.channelName, "Twin Pool", "the pool pseudo-channel wins the tie");
    assert.equal(channels.twin.displayName, "Twin Pool");
  });

  it("surfaces nothing for a pool whose members currently have no models", () => {
    const channels = deriveVisibleChannels({
      providers: {
        "solo-1": { models: { "m-1": {} } },
        alpha: { models: {} },
        beta: { models: {} },
      },
      pools: { "pool-empty": { displayName: "Empty", members: ["alpha", "beta"] } },
    });
    // The empty pool must not surface — not even as a model-less channel —
    // and it must not disturb the channels around it.
    assert.deepEqual(Object.keys(channels), ["solo-1"]);
  });

  it("lists at the tail a pool whose members were all claimed by an earlier pool", () => {
    // Beyond schema validation: validatePools forbids a provider belonging to
    // two pools, so only a store that bypassed validation can leave a
    // surfacing pool without any unclaimed member slot. The documented
    // fallback still lists such a pool, at the tail.
    const channels = deriveVisibleChannels({
      providers: {
        "solo-1": { models: { "m-1": {} } },
        alpha: { models: { "model-a": {} } },
        a2: { models: { "m-2": {} } },
      },
      pools: {
        "pool-first": { displayName: "First", members: ["alpha", "a2"] },
        "pool-second": { displayName: "Second", members: ["alpha", "a2"] },
      },
    });
    assert.deepEqual(Object.keys(channels), ["solo-1", "pool-first", "pool-second"]);
  });
});
