// Cross-surface catalog consistency guardrail.
//
// The endpoint-facing model list reaches agents through several surfaces: the
// Anthropic wire catalog (/v1/models), the eight agent-sync endpoint configs,
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
  extractManagedProviders,
  poolMemberIdSet,
} from "./pool-providers.mjs";
import { poolModelsUnion, resolvePool } from "./pool-routing.mjs";
import { validateStore } from "./store-schema.mjs";
// The eight agent-sync endpoint config surfaces. Imported only to pin that
// each one re-exports the ONE shared derivation — a reference-identity check,
// the only form a behavior-equal copy cannot pass.
import * as dshMergeConfig from "./dsh-merge-config.mjs";
import * as codexMergeConfig from "./codex-merge-config.mjs";
import * as kimiMergeConfig from "./kimi-merge-config.mjs";
import * as grokMergeConfig from "./grok-merge-config.mjs";
import * as opencodeMergeConfig from "./opencode-merge-config.mjs";
import * as piMergeModels from "./pi-merge-models.mjs";
import * as qoderMergeConfig from "./qoder-merge-config.mjs";
import * as zcodeMergeConfig from "./zcode-merge-config.mjs";

const SYNC_SURFACES = {
  "dsh-merge-config.mjs": dshMergeConfig,
  "codex-merge-config.mjs": codexMergeConfig,
  "kimi-merge-config.mjs": kimiMergeConfig,
  "grok-merge-config.mjs": grokMergeConfig,
  "opencode-merge-config.mjs": opencodeMergeConfig,
  "pi-merge-models.mjs": piMergeModels,
  "qoder-merge-config.mjs": qoderMergeConfig,
  "zcode-merge-config.mjs": zcodeMergeConfig,
};

function makeStore() {
  return {
    version: 2,
    providers: {
      "member-a": {
        displayName: "Member A",
        baseURL: "http://a.invalid/v1",
        protocol: "openai-compatible",
        credentialFile: "member-a.dpapi",
        models: {
          "shared-model": { displayName: "Shared from A", contextWindow: 100 },
          "only-a": { displayName: "Only A" },
        },
      },
      "member-b": {
        displayName: "Member B",
        baseURL: "http://b.invalid/v1",
        protocol: "openai-compatible",
        credentialFile: "member-b.dpapi",
        models: {
          "shared-model": { displayName: "Shared from B", contextWindow: 200 },
          "only-b": { displayName: "Only B" },
        },
      },
      // A member that also lends its id to a pool (the sensenova shape).
      "member-c": {
        displayName: "Member C",
        baseURL: "http://c.invalid/v1",
        protocol: "openai-compatible",
        credentialFile: "member-c.dpapi",
        models: { "c-model": { displayName: "C Model" } },
      },
      // The twin pool's second member: c-mate-model belongs to the pool union
      // but not to the twin provider's own catalog, so "the channel under the
      // twin id is the POOL" stays observable instead of silently identical.
      "c-mate": {
        displayName: "C Mate",
        baseURL: "http://cmate.invalid/v1",
        protocol: "openai-compatible",
        credentialFile: "c-mate.dpapi",
        models: { "c-mate-model": { displayName: "C Mate Model" } },
      },
      solo: {
        displayName: "Solo",
        baseURL: "http://solo.invalid/v1",
        protocol: "openai-compatible",
        credentialFile: "solo.dpapi",
        models: { "solo-model": { displayName: "Solo Model" } },
      },
      // Providers without models surface nowhere.
      empty: {
        displayName: "Empty",
        baseURL: "http://empty.invalid/v1",
        protocol: "openai-compatible",
        credentialFile: "empty.dpapi",
        models: {},
      },
    },
    pools: {
      "pool-ab": { displayName: "Pool AB", members: ["member-a", "member-b"] },
      // Pool id reuses one of its member's ids. Two members keep the pool
      // schema-legal (validatePools requires 2-5 members).
      "member-c": { displayName: "Pool C", members: ["member-c", "c-mate"] },
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
  it("keeps the shared fixture a schema-valid store", () => {
    // The fixture models a real production store: pool-id twins, model-less
    // providers, shared model ids. If it drifts out of the store schema, the
    // expectations below would only hold for stores that cannot load.
    assert.deepEqual(validateStore(makeStore()), { valid: true, errors: [] });
  });

  it("emits standalone providers and one absorbed channel per pool", () => {
    const channels = deriveVisibleChannels(makeStore());
    assert.deepEqual(Object.keys(channels).sort(), ["member-c", "pool-ab", "solo"]);
    // Members are absorbed whatever their id — including the twin pool's
    // second member.
    for (const memberId of ["member-a", "member-b", "c-mate"]) {
      assert.equal(channels[memberId], undefined, `member "${memberId}" must not surface`);
    }
    assert.equal(channels.empty, undefined, "model-less providers surface nowhere");
    // The pool channel carries the pool displayName as its channel label.
    assert.equal(channels["pool-ab"].channelName, "Pool AB");
    // Pool-id twin: the id surfaces exactly once, as the POOL channel serving
    // the pool union — never as the member's own catalog.
    assert.equal(channels["member-c"].channelName, "Pool C", "the pool wins the twin-id tie");
    assert.deepEqual(
      Object.keys(channels["member-c"].models).sort(),
      ["c-mate-model", "c-model"],
      "the twin channel must serve the pool union, not the member's own models",
    );
  });

  it("extractManagedProviders is the shared implementation, not a copy", () => {
    // Reference identity: every agent-sync surface must re-export the one
    // shared derivation. A behavior-equal copy would pass any deepEqual, so
    // identity is the only assertion that proves "not a copy".
    for (const [surface, module] of Object.entries(SYNC_SURFACES)) {
      assert.equal(
        module.extractManagedProviders,
        extractManagedProviders,
        `${surface} must re-export pool-providers' shared extractManagedProviders`,
      );
    }
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
        pseudo[poolId].models,
        poolModelsUnion(store, pool),
        `pool "${poolId}" listed models must equal the relay-served union`,
      );
    }
    // First member in pool order wins a shared model's metadata. This line
    // pins poolModelsUnion's precedence itself: derivePoolPseudoProviders
    // delegates to the union, so the deepEqual above cannot catch a
    // precedence change on its own.
    assert.equal(pseudo["pool-ab"].models["shared-model"].displayName, "Shared from A");
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
    const channels = deriveVisibleChannels(store);
    const wireByProvider = wireCatalogByProvider(store);
    for (const memberId of poolMemberIdSet(store)) {
      if (resolvePool(store, memberId)) {
        // A pool may reuse a member's id (the twin): the id does surface, but
        // only as its pool's pseudo-channel — on both surfaces.
        const poolChannel = derivePoolPseudoProviders(store)[memberId];
        assert.deepEqual(
          channels[memberId],
          poolChannel,
          `id "${memberId}" must surface as its pool, not as the member's own channel`,
        );
        assert.deepEqual(
          [...(wireByProvider.get(memberId) ?? new Set())].sort(),
          Object.keys(poolChannel?.models ?? {}).sort(),
          `id "${memberId}" wire entries must be the pool union`,
        );
        continue;
      }
      assert.equal(wireByProvider.has(memberId), false, `member "${memberId}" leaked into the wire catalog`);
      assert.equal(channels[memberId], undefined, `member "${memberId}" leaked into the visible channels`);
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
