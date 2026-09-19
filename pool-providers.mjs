// Visible-channel derivation — the SINGLE source for "which channels and
// models do endpoints see".
// Pure functions only: no IO, no DPAPI, no network.
//
// Every catalog-producing surface consumes this module so the endpoint-facing
// view can never drift between them:
//   - wire-id.mjs buildWireCatalog (Anthropic /v1/models)
//   - the agent-sync merge modules via extractManagedProviders
//     (kimi / pi / dsh / zcode / qoder / codex / opencode / grok endpoint configs)
// The OpenAI runtime path shares the same union semantics through
// poolModelsUnion (pool-routing.mjs), which this module also delegates to.
//
// Rules of the visible view:
//   1. A pool surfaces as ONE channel whose id is the pool id. Its model list
//      is the union of the members' models in pool member order — the first
//      member to offer a model id also wins its metadata (displayName,
//      contextWindow, ...). Merge modules point it at /openai/<poolId>/v1
//      exactly like a provider channel (pool-aware routing lives relay-side).
//   2. Providers that are pool members are ABSORBED: they never surface as
//      their own channel, whatever their id. A pool id may equal one of its
//      member's ids (the store schema allows that); absorption makes the
//      pool/member tie unambiguous everywhere instead of relying on same-id
//      replacement alone.
//   3. Providers without models produce no channel; pools whose members
//      currently expose no models produce no channel either.
//   4. Channel order is the panel's visible order: store providers key order,
//      with each pool surfacing at its earliest member's slot. Codex's picker
//      only fetches the first catalog page, so this order decides what is
//      selectable — it is load-bearing, not cosmetic.
//
// Runtime leniency is a separate matter: absorbed members stay resolvable for
// requests (unpackWireId, /openai/<id>/v1) so configs written before the
// absorption keep working until their next sync — they are only unlisted.
//
// channelName is the endpoint-facing channel label (the pool displayName). It
// is a sync-only field: real store providers never carry it, so the merge
// modules can read `provider.channelName ?? providerId` without changing how
// standalone channels are named.

import { poolModelsUnion } from "./pool-routing.mjs";

export function poolMemberIdSet(store) {
  const memberIds = new Set();
  for (const pool of Object.values(store?.pools ?? {})) {
    for (const memberId of pool?.members ?? []) memberIds.add(memberId);
  }
  return memberIds;
}

export function derivePoolPseudoProviders(store) {
  const pools = store?.pools ?? {};
  const pseudo = {};
  for (const [poolId, pool] of Object.entries(pools)) {
    const union = poolModelsUnion(store, pool);
    // Clone so consumers can never mutate back into a loaded store object.
    const models = {};
    for (const [modelId, model] of Object.entries(union)) {
      models[modelId] = structuredClone(model);
    }
    // A pool whose members currently expose no models produces no channel,
    // matching how model-less providers are skipped by extractManagedProviders.
    if (Object.keys(models).length === 0) continue;
    const channelName =
      typeof pool?.displayName === "string" && pool.displayName.length > 0 ? pool.displayName : poolId;
    pseudo[poolId] = { displayName: channelName, channelName, models };
  }
  return pseudo;
}

// The endpoint-visible channel table: standalone (non-member) providers with
// models, plus one pseudo-provider per pool. Pool ids win any tie with a
// provider id by construction, mirroring the relay's pool-first resolution.
//
// The walk follows store providers key order — the panel's visible order. An
// absorbed member never surfaces on its own; its pool takes the slot of the
// earliest member instead, so dragging a channel in the panel moves the same
// row in every endpoint config and in codex's paginated catalog. A pool that
// never gets a slot during the walk (every member claimed by an earlier pool)
// still lists, at the tail.
export function deriveVisibleChannels(store) {
  const providers = store?.providers ?? {};
  const pseudo = derivePoolPseudoProviders(store);
  const memberIds = poolMemberIdSet(store);
  // First pool to claim a member wins the member's slot, mirroring the
  // pool-first tie resolution everywhere else.
  const poolByMember = new Map();
  for (const [poolId, pool] of Object.entries(store?.pools ?? {})) {
    if (pseudo[poolId] === undefined) continue;
    for (const memberId of pool?.members ?? []) {
      if (!poolByMember.has(memberId)) poolByMember.set(memberId, poolId);
    }
  }
  const channels = {};
  for (const [providerId, provider] of Object.entries(providers)) {
    const poolId = poolByMember.get(providerId);
    if (poolId !== undefined) {
      if (channels[poolId] === undefined) channels[poolId] = pseudo[poolId];
      continue;
    }
    // Absorbed member of a pool that currently surfaces no channel.
    if (memberIds.has(providerId)) continue;
    // A pool id may reuse a provider id; the pool wins the tie in place.
    if (pseudo[providerId] !== undefined) {
      channels[providerId] = pseudo[providerId];
      continue;
    }
    if (!(provider?.models && Object.keys(provider.models).length > 0)) continue;
    channels[providerId] = provider;
  }
  for (const [poolId, channel] of Object.entries(pseudo)) {
    if (channels[poolId] === undefined) channels[poolId] = channel;
  }
  return channels;
}

// Shared entry point for the per-agent merge modules. They consume the same
// visible-channel derivation as the wire catalog, so what an endpoint sees can
// never differ between the config it is handed and the catalog it is told.
export function extractManagedProviders(store) {
  return deriveVisibleChannels(store);
}
