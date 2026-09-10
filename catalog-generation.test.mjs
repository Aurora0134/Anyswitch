// Catalog routing-shape tests. Synthetic data only: no IO, no network.
//
// The invariant under test is narrow on purpose: the recorded snapshot must
// cover exactly what decides WHERE a request goes, so that editing one channel
// cannot invalidate a session that never touches it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { providerRoutingShapes, findStaleTargets } from "./catalog-generation.mjs";

function syntheticStore() {
  return {
    version: 2,
    providers: {
      "poke-api": {
        displayName: "Poke API",
        baseURL: "https://upstream.invalid/v1",
        protocol: "openai-compatible",
        credentialFile: "poke-api.dpapi",
        models: {
          "claude-opus-5": { displayName: "Claude Opus 5", contextWindow: 200000, maxOutputTokens: 32000 },
          "claude-sonnet-5": { displayName: "Claude Sonnet 5" },
        },
      },
      "nvidia-nim": {
        displayName: "NVIDIA NIM",
        baseURL: "https://nim.invalid/v1",
        protocol: "openai-compatible",
        credentialFile: "nvidia-nim.dpapi",
        models: { "deepseek-ai/deepseek-v4-pro": { displayName: "DeepSeek V4 Pro" } },
      },
    },
    pools: { "poke-pool": { displayName: "Pool", members: ["poke-api", "nvidia-nim"] } },
    routingChains: { claude: { chain: [{ node: "poke-api", model: "claude-opus-5" }] } },
  };
}

test("shapes are keyed by provider id and hold no secret material", () => {
  const shapes = providerRoutingShapes(syntheticStore());
  assert.deepEqual(Object.keys(shapes).sort(), ["nvidia-nim", "poke-api"]);
  for (const [providerId, value] of Object.entries(shapes)) {
    assert.equal(typeof value, "string");
    assert.ok(value.length > 0, providerId);
    assert.ok(!value.includes("dpapi"), "the hash must not echo the credential file name");
  }
});

test("presentation metadata never changes a provider shape", () => {
  const base = providerRoutingShapes(syntheticStore());

  const renamed = syntheticStore();
  renamed.providers["poke-api"].displayName = "Renamed Provider";
  renamed.providers["poke-api"].models["claude-opus-5"].displayName = "Renamed Model";
  assert.deepEqual(base, providerRoutingShapes(renamed));

  const budget = syntheticStore();
  budget.providers["poke-api"].models["claude-opus-5"].contextWindow = 1;
  budget.providers["poke-api"].models["claude-opus-5"].maxOutputTokens = 1;
  budget.providers["poke-api"].models["claude-opus-5"].inputModalities = ["text"];
  assert.deepEqual(base, providerRoutingShapes(budget));
});

test("the model set is out of the shape: adding or deleting a model keeps live routes valid", () => {
  const base = providerRoutingShapes(syntheticStore());

  const added = syntheticStore();
  added.providers["poke-api"].models["glm-5.3"] = { displayName: "GLM" };
  assert.deepEqual(base, providerRoutingShapes(added));

  const removed = syntheticStore();
  delete removed.providers["poke-api"].models["claude-sonnet-5"];
  assert.deepEqual(base, providerRoutingShapes(removed));
});

test("pools, route chains and store version are out of the shape", () => {
  const base = providerRoutingShapes(syntheticStore());

  const pools = syntheticStore();
  pools.pools["poke-pool"].members = ["nvidia-nim", "poke-api"];
  assert.deepEqual(base, providerRoutingShapes(pools));

  const chains = syntheticStore();
  chains.routingChains.claude.chain[0].model = "claude-sonnet-5";
  assert.deepEqual(base, providerRoutingShapes(chains));

  const version = syntheticStore();
  version.version = 3;
  assert.deepEqual(base, providerRoutingShapes(version));
});

test("every routing-relevant field changes the shape", () => {
  const base = providerRoutingShapes(syntheticStore());
  const mutations = {
    baseURL: (s) => { s.providers["poke-api"].baseURL = "https://elsewhere.invalid/v1"; },
    fallbackURLs: (s) => { s.providers["poke-api"].fallbackURLs = ["https://backup.invalid/v1"]; },
    protocol: (s) => { s.providers["poke-api"].protocol = "anthropic"; },
    credentialFile: (s) => { s.providers["poke-api"].credentialFile = "other.dpapi"; },
  };
  for (const [field, mutate] of Object.entries(mutations)) {
    const store = syntheticStore();
    mutate(store);
    assert.notEqual(base["poke-api"], providerRoutingShapes(store)["poke-api"], field);
    // The sibling channel is untouched either way.
    assert.equal(base["nvidia-nim"], providerRoutingShapes(store)["nvidia-nim"], field);
  }
});

test("provider key order does not change the shape", () => {
  const store = syntheticStore();
  const shuffled = {
    ...store,
    providers: Object.fromEntries(Object.entries(store.providers).reverse()),
  };
  assert.deepEqual(providerRoutingShapes(store), providerRoutingShapes(shuffled));
});

test("stale targets: an empty recording gates nothing (discovery has not run)", () => {
  for (const recorded of [null, undefined, {}]) {
    const store = syntheticStore();
    store.providers["poke-api"].baseURL = "https://elsewhere.invalid/v1";
    assert.deepEqual(findStaleTargets(recorded, store, ["poke-api"]), []);
  }
});

test("stale targets: a re-pointed provider in this request is reported", () => {
  const recorded = providerRoutingShapes(syntheticStore());
  const store = syntheticStore();
  store.providers["poke-api"].fallbackURLs = ["https://attacker.invalid/v1"];
  assert.deepEqual(findStaleTargets(recorded, store, ["poke-api"]), ["poke-api"]);
});

test("stale targets: a change to a channel this request never touches is not reported", () => {
  const recorded = providerRoutingShapes(syntheticStore());
  const store = syntheticStore();
  store.providers["nvidia-nim"].baseURL = "https://elsewhere.invalid/v1";
  assert.deepEqual(findStaleTargets(recorded, store, ["poke-api"]), []);
});

test("stale targets: a provider created after discovery is not stale", () => {
  const recorded = providerRoutingShapes(syntheticStore());
  const store = syntheticStore();
  store.providers["new-api"] = {
    baseURL: "https://new.invalid/v1",
    protocol: "openai-compatible",
    credentialFile: "new.dpapi",
    models: { m: { displayName: "M" } },
  };
  assert.deepEqual(findStaleTargets(recorded, store, ["new-api"]), []);
});

test("stale targets: a deleted provider is left to the 404 path", () => {
  const recorded = providerRoutingShapes(syntheticStore());
  const store = syntheticStore();
  delete store.providers["poke-api"];
  assert.deepEqual(findStaleTargets(recorded, store, ["poke-api"]), []);
});

test("stale targets: deleted then recreated under the same id with another endpoint is stale", () => {
  // The exact case the gate exists for: same wire ID, different upstream.
  const recorded = providerRoutingShapes(syntheticStore());
  const store = syntheticStore();
  store.providers["poke-api"] = {
    displayName: "Poke API",
    baseURL: "https://attacker.invalid/v1",
    protocol: "openai-compatible",
    credentialFile: "poke-api.dpapi",
    models: { "claude-opus-5": { displayName: "Claude Opus 5" } },
  };
  assert.deepEqual(findStaleTargets(recorded, store, ["poke-api"]), ["poke-api"]);
});

test("stale targets: deleted then recreated identically is not stale", () => {
  const recorded = providerRoutingShapes(syntheticStore());
  const store = syntheticStore();
  const poke = store.providers["poke-api"];
  delete store.providers["poke-api"];
  store.providers["poke-api"] = poke;
  assert.deepEqual(findStaleTargets(recorded, store, ["poke-api"]), []);
});

test("stale targets: reports every named provider that moved, once each", () => {
  const recorded = providerRoutingShapes(syntheticStore());
  const store = syntheticStore();
  store.providers["poke-api"].baseURL = "https://a.invalid/v1";
  store.providers["nvidia-nim"].credentialFile = "moved.dpapi";
  assert.deepEqual(
    findStaleTargets(recorded, store, ["poke-api", "nvidia-nim", "poke-api"]),
    ["poke-api", "nvidia-nim"],
  );
});

test("stale targets: a request naming no provider gates nothing", () => {
  const recorded = providerRoutingShapes(syntheticStore());
  const store = syntheticStore();
  store.providers["poke-api"].baseURL = "https://elsewhere.invalid/v1";
  assert.deepEqual(findStaleTargets(recorded, store, []), []);
});
