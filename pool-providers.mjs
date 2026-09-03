// Visible-channel derivation — the SINGLE source for "which channels and
// models do endpoints see" (provider pools, phase 2 → single-surface refactor).
// Pure functions only: no IO, no DPAPI, no network.
//
// Every catalog-producing surface consumes this module so the endpoint-facing
// view can never drift between them:
//   - wire-id.mjs buildWireCatalog (Anthropic /v1/models)
//   - the five agent-sync merge modules via extractManagedProviders
//     (kimi / pi / dsh / zcode / reasonix endpoint configs)
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
export function deriveVisibleChannels(store) {
  const providers = store?.providers ?? {};
  const memberIds = poolMemberIdSet(store);
  const channels = {};
  for (const [providerId, provider] of Object.entries(providers)) {
    if (memberIds.has(providerId)) continue;
    if (!(provider?.models && Object.keys(provider.models).length > 0)) continue;
    channels[providerId] = provider;
  }
  Object.assign(channels, derivePoolPseudoProviders(store));
  return channels;
}

// Shared entry point for all five agent-sync merge modules. Previously each
// merge module carried its own byte-identical copy; that duplication let the
// catalog semantics drift (a change landing on one surface but not the
// others). The single implementation lives here.
export function extractManagedProviders(store) {
  return deriveVisibleChannels(store);
}
