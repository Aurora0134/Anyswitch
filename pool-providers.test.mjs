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

  it("takes the earliest member in providers key order, not members[0]", () => {
    const channels = deriveVisibleChannels({
      providers: {
        alpha: { models: { "model-a": {} } },
        beta: { models: { "model-b": {} } },
      },
      pools: { "pool-ab": { members: ["beta", "alpha"] } },
    });
    assert.deepEqual(Object.keys(channels), ["pool-ab"]);
  });

  it("skips providers without models while keeping the pool at its member's slot", () => {
    const channels = deriveVisibleChannels({
      providers: {
        empty: {},
        alpha: { models: { "model-a": {} } },
        "solo-1": { models: { "m-1": {} } },
      },
      pools: { "pool-ab": { members: ["alpha"] } },
    });
    assert.deepEqual(Object.keys(channels), ["pool-ab", "solo-1"]);
  });

  it("lets a pool win a pool-id/provider-id tie in place", () => {
    const channels = deriveVisibleChannels({
      providers: {
        "solo-1": { models: { "m-1": {} } },
        twin: { models: { "model-a": {} } },
      },
      pools: { twin: { displayName: "Twin Pool", members: ["twin"] } },
    });
    assert.deepEqual(Object.keys(channels), ["solo-1", "twin"]);
    assert.equal(channels.twin.channelName, "Twin Pool", "the pool pseudo-channel wins the tie");
  });

  it("surfaces nothing for members of a pool that currently has no models", () => {
    const channels = deriveVisibleChannels({
      providers: { alpha: {}, beta: { models: {} } },
      pools: { "pool-empty": { members: ["alpha", "beta"] } },
    });
    assert.deepEqual(Object.keys(channels), []);
  });

  it("lists at the tail a pool whose members were all claimed by an earlier pool", () => {
    const channels = deriveVisibleChannels({
      providers: {
        "solo-1": { models: { "m-1": {} } },
        alpha: { models: { "model-a": {} } },
      },
      pools: {
        "pool-first": { members: ["alpha"] },
        "pool-second": { members: ["alpha"] },
      },
    });
    assert.deepEqual(Object.keys(channels), ["solo-1", "pool-first", "pool-second"]);
  });
});
