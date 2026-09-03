// Pool routing primitives (provider pools, phase 2).
// Pure functions plus one in-memory sticky table. No IO.
//
// A pool groups 2-5 providers under its own id. When a request's URL segment
// names a pool, resolution MUST check pools before providers (a pool id may
// collide with one of its own member's ids; the pool wins). The request then
// fans out across the pool's members:
//   - candidates are the members whose materialized catalog contains the
//     requested model, in pool order;
//   - a sticky table remembers the last successful member per (pool, model)
//     and puts it first — but the sticky point only moves past a member that
//     is FAILING (see POOL_DEMOTE_AFTER_FAILURES below): a single transient
//     fault fails that one request over without demoting the front member,
//     mirroring the chain demotion gate (失败才降级，黄灯不降);
//   - entries whose member left the candidate set are dropped lazily (member
//     removed from the pool, model gone, pool deleted);
//   - channel-level faults (5xx, transport errors surfaced as 502, 429,
//     401/403, and keep-alive-judged retryable stream faults) back off to the
//     next member; 400/404/422 are request-shaped and pass straight through.
//
// This module is the shared piece every relay frontend (OpenAI now,
// Anthropic/Gemini later) builds its member loop on.

// Statuses that mark a member as failed and advance to the next one. 5xx and
// 502-from-transport are covered by the >= 500 branch; everything else 4xx is
// the client's own problem and must not trigger failover.
export function isPoolFailoverStatus(status) {
  return status >= 500 || status === 429 || status === 401 || status === 403;
}

// The pool entry for an id, or null. Callers check this BEFORE falling back
// to store.providers so a pool that reuses a member's id wins the tie.
export function resolvePool(store, poolId) {
  return store?.pools?.[poolId] ?? null;
}

// Ordered candidate members for a model: pool order, only members whose
// materialized catalog (discovered ∩ modelFilter, plus manual entries — the
// store's models map is already materialized) contains modelId. Missing
// member providers are skipped; store validation normally forbids them.
export function poolMembersWithModel(store, pool, modelId) {
  const candidates = [];
  for (const memberId of pool?.members ?? []) {
    const provider = store?.providers?.[memberId];
    if (!provider) continue;
    if (provider.models?.[modelId] === undefined) continue;
    candidates.push({ memberId, provider });
  }
  return candidates;
}

// Union of all member catalogs in pool order. The first member that presents
// a model id wins its metadata, matching the pool's display precedence.
export function poolModelsUnion(store, pool) {
  const models = {};
  for (const memberId of pool?.members ?? []) {
    const provider = store?.providers?.[memberId];
    if (!provider) continue;
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      if (models[modelId] === undefined) models[modelId] = model;
    }
  }
  return models;
}

// How many CONSECUTIVE request-level member failures latch a pool demotion —
// the same product rule as the chain gate (CHAIN_DEMOTE_AFTER_FAILURES in
// chain-routing.mjs; kept as an independent constant to avoid a layering
// circle: chain-routing already imports pool-routing). One transient fault
// (a single 504/429 blip) must not demote the front member — 失败（持续红灯）
// 才降级, 黄灯（可用但慢）不降.
export const POOL_DEMOTE_AFTER_FAILURES = 2;

// Sticky routing table: (poolId, modelId) -> last successful member id.
// Process memory only — a relay restart resets it, by design.
//
// Demotion gate: noteSuccess moves the sticky point FORWARD past a member
// only once that member has failed POOL_DEMOTE_AFTER_FAILURES consecutive
// requests (noteFailure counts request-level failures; the member's keep-alive
// retries are absorbed inside its own attempt, so it fails at most once per
// request). Success at the sticky member resets its counter; success at an
// earlier member (recovery) moves the sticky point back. The failure counter
// is keyed by member+model GLOBALLY (not per pool): the failing thing is the
// upstream member, not the pool that mentioned it.
export function createStickyTable() {
  const table = new Map();
  // memberId\0modelId -> consecutive request-level failures.
  const failures = new Map();
  // pool\0model -> member order of the last order() call, so noteSuccess can
  // tell whether the answering member moved forward past failing ones.
  const orders = new Map();
  // \0 cannot appear in a provider/pool id (schema alphabet) nor collide
  // across the two segments, so the pair key is unambiguous.
  const key = (poolId, modelId) => `${poolId}\0${modelId}`;
  const memberKey = (memberId, modelId) => `${memberId}\0${modelId}`;
  const isLatched = (memberId, modelId) => (failures.get(memberKey(memberId, modelId)) ?? 0) >= POOL_DEMOTE_AFTER_FAILURES;

  return {
    // Order candidates sticky-first. A sticky entry whose member is no longer
    // a candidate (removed from the pool, lost the model) is dropped lazily
    // here and the plain pool order is used.
    order(poolId, modelId, candidates) {
      const k = key(poolId, modelId);
      orders.set(k, candidates.map((candidate) => candidate.memberId));
      const stickyMember = table.get(k);
      if (stickyMember === undefined) return candidates;
      const index = candidates.findIndex((candidate) => candidate.memberId === stickyMember);
      if (index === -1) {
        table.delete(k);
        return candidates;
      }
      return [candidates[index], ...candidates.slice(0, index), ...candidates.slice(index + 1)];
    },
    noteSuccess(poolId, modelId, memberId) {
      failures.set(memberKey(memberId, modelId), 0);
      const k = key(poolId, modelId);
      const memberOrder = orders.get(k);
      // No candidate order on record (direct noteSuccess — tests/diagnostics)
      // or the answer is not in the candidate set: just stick, as before.
      if (!memberOrder || !memberOrder.includes(memberId)) {
        table.set(k, memberId);
        return;
      }
      const newIndex = memberOrder.indexOf(memberId);
      const current = table.get(k);
      const currentIndex = current !== undefined ? memberOrder.indexOf(current) : -1;
      // The sticky member itself answered: keep the entry untouched.
      if (newIndex === currentIndex) return;
      // Pool head or an earlier member answered (recovery walk backwards).
      if (newIndex === 0 || newIndex < currentIndex) {
        table.set(k, memberId);
        return;
      }
      // Forward move: demote past the skipped members only if EVERY one of
      // them is latched-failing. Any non-latched skip means the walk crossed
      // a mere blip — leave the sticky point alone (the next request retries
      // the front row from where it was).
      const skipped = memberOrder.slice(Math.max(currentIndex, 0), newIndex);
      if (skipped.every((skippedId) => isLatched(skippedId, modelId))) {
        table.set(k, memberId);
      }
    },
    // One request-level failure of a member (called by the handler's plan
    // when a member failover advances past it). The counter latches lazily —
    // read by noteSuccess — so this is the single source of truth.
    noteFailure(poolId, modelId, memberId) {
      const k = memberKey(memberId, modelId);
      failures.set(k, (failures.get(k) ?? 0) + 1);
    },
    // Introspection for tests and diagnostics.
    get(poolId, modelId) {
      return table.get(key(poolId, modelId));
    },
    consecutive(memberId, modelId) {
      return failures.get(memberKey(memberId, modelId)) ?? 0;
    },
  };
}
