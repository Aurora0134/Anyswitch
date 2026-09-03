import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { derivePoolPseudoProviders } from "./pool-providers.mjs";

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
