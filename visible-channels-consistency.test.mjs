// Cross-surface catalog consistency guardrail.
//
// The endpoint-facing model list reaches agents through several surfaces: the
// Anthropic wire catalog (/v1/models), the five agent-sync endpoint configs,
// and the OpenAI runtime path. They are only correct if they all express ONE
// set of catalog semantics — the visible-channel derivation in
// pool-providers.mjs. These tests pin that invariant so any future drift
// between the surfaces fails here instead of appearing later as a stale or
// split model list on some endpoint.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWireCatalog } from "./wire-id.mjs";
import {
  deriveVisibleChannels,
  derivePoolPseudoProviders,
  extractApiCredProviders,
  poolMemberIdSet,
} from "./pool-providers.mjs";
import { poolModelsUnion, resolvePool } from "./pool-routing.mjs";

function makeStore() {
  return {
    version: 2,
    providers: {
      "member-a": {
        displayName: "Member A",
        baseURL: "http://a.invalid/v1",
        models: {
          "shared-model": { displayName: "Shared from A", contextWindow: 100 },
          "only-a": { displayName: "Only A" },
        },
      },
      "member-b": {
        displayName: "Member B",
        baseURL: "http://b.invalid/v1",
        models: {
          "shared-model": { displayName: "Shared from B", contextWindow: 200 },
          "only-b": { displayName: "Only B" },
        },
      },
      // A member that also lends its id to a pool (the sensenova shape).
      "member-c": {
        displayName: "Member C",
        baseURL: "http://c.invalid/v1",
        models: { "c-model": { displayName: "C Model" } },
      },
      solo: {
        displayName: "Solo",
        baseURL: "http://solo.invalid/v1",
        models: { "solo-model": { displayName: "Solo Model" } },
      },
      // Providers without models surface nowhere.
      empty: { displayName: "Empty", baseURL: "http://empty.invalid/v1", models: {} },
    },
    pools: {
      "pool-ab": { displayName: "Pool AB", members: ["member-a", "member-b"] },
      // Pool id reuses one of its member's ids.
      "member-c": { displayName: "Pool C", members: ["member-c"] },
    },
  };
}

function wireCatalogByProvider(store) {
  const byProvider = new Map();
  for (const entry of buildWireCatalog(store)) {
    if (!byProvider.has(entry.providerId)) byProvider.set(entry.providerId, new Set());
    byProvider.get(entry.providerId).add(entry.modelId);
  }
  return byProvider;
}

describe("visible-channel derivation is the single catalog source", () => {
  it("emits standalone providers and one absorbed channel per pool", () => {
    const channels = deriveVisibleChannels(makeStore());
    assert.deepEqual(Object.keys(channels).sort(), ["member-c", "pool-ab", "solo"]);
    // Members are absorbed whatever their id — including the pool-id twin.
    for (const memberId of ["member-a", "member-b"]) {
      assert.equal(channels[memberId], undefined, `member "${memberId}" must not surface`);
    }
    assert.equal(channels.empty, undefined, "model-less providers surface nowhere");
    // The pool channel carries the pool displayName as its channel label.
    assert.equal(channels["pool-ab"].channelName, "Pool AB");
  });

  it("extractApiCredProviders is the shared implementation, not a copy", () => {
    assert.deepEqual(extractApiCredProviders(makeStore()), deriveVisibleChannels(makeStore()));
  });

  it("pool pseudo-channels carry exactly the poolModelsUnion the relay serves", () => {
    // The OpenAI runtime path answers /openai/<poolId>/v1/models from
    // poolModelsUnion; the synced configs carry derivePoolPseudoProviders'
    // models. If these ever diverge, an endpoint's listed model stops matching
    // what the relay actually serves for it.
    const store = makeStore();
    const pseudo = derivePoolPseudoProviders(store);
    for (const [poolId, pool] of Object.entries(store.pools)) {
      assert.deepEqual(
        Object.keys(pseudo[poolId].models).sort(),
        Object.keys(poolModelsUnion(store, pool)).sort(),
        `pool "${poolId}" listed models must equal the relay-served union`,
      );
      // First member in pool order wins the shared model's metadata.
      assert.equal(pseudo["pool-ab"].models["shared-model"].displayName, "Shared from A");
    }
  });
});

describe("wire catalog ≡ visible channels (Anthropic surface)", () => {
  it("emits the same channel ids and the same model sets", () => {
    const store = makeStore();
    const channels = deriveVisibleChannels(store);
    const wireByProvider = wireCatalogByProvider(store);

    assert.deepEqual(
      [...wireByProvider.keys()].sort(),
      Object.keys(channels).sort(),
      "wire catalog channel ids must equal the visible channel table",
    );
    for (const [channelId, channel] of Object.entries(channels)) {
      assert.deepEqual(
        [...wireByProvider.get(channelId)].sort(),
        Object.keys(channel.models).sort(),
        `channel "${channelId}" model sets must match between surfaces`,
      );
    }
  });

  it("never lists an absorbed member under any surface", () => {
    const store = makeStore();
    const wireByProvider = wireCatalogByProvider(store);
    for (const memberId of poolMemberIdSet(store)) {
      if (resolvePool(store, memberId)) continue; // a pool may reuse a member id
      assert.equal(wireByProvider.has(memberId), false, `member "${memberId}" leaked into the wire catalog`);
      assert.equal(deriveVisibleChannels(store)[memberId], undefined);
    }
  });

  it("keeps the [channel] displayName prefix convention", () => {
    const entries = buildWireCatalog(makeStore());
    for (const entry of entries) {
      assert.ok(
        entry.displayName.startsWith(`[${entry.providerId}] `),
        `display name "${entry.displayName}" must be prefixed with the channel id`,
      );
    }
  });
});
