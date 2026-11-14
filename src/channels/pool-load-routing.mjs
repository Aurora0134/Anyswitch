// Pool load-balancing routing (智能分流).
// Pure functions plus one in-memory balancer. No IO.
//
// An alternative to the sticky table for fanning a pool request across its
// members. Instead of pinning every request to the last successful member
// until it collapses, it spreads load proactively:
//   - each member carries a live in-flight count (requests currently being
//     served, from dispatch until the response settles);
//   - each (member, model) carries a sliding-window quality rate — the share
//     of recent requests that succeeded AND delivered their first token within
//     LOAD_TTFT_GOOD_MS. Quality is the ground-truth feedback for upstream
//     RPM-style pressure, which surfaces as slow first tokens or 503s;
//   - selection is weighted least-load: argmin (inflight + 1) / weight, where
//     weight = max(LOAD_WEIGHT_FLOOR, quality). Concurrency is the fast,
//     leading signal (a proxy for RPM pressure); quality is the slow corrective
//     signal. A member with fewer samples than LOAD_MIN_SAMPLES is treated as
//     neutral so a cold member is neither favoured nor starved;
//   - a session affinity keeps the same conversation on the same member while
//     it is healthy (prompt-cache locality), re-binding to whichever member
//     actually answers;
//   - the hard failover layer is unchanged: LOAD_DEMOTE_AFTER_FAILURES
//     consecutive request-level failures latch a member to the back of the
//     order (still tried as a last resort), mirroring the sticky demotion gate.
//
// This module is consulted only when the operator enables poolLoadBalancing;
// with the setting off the relays keep using the sticky table untouched.

// A request is "quality" when it succeeded and its first token arrived within
// this many milliseconds. Non-streaming requests proxy first-token latency
// with the full request duration (the tracker's TTFT fallback).
export const LOAD_TTFT_GOOD_MS = 15000;
// Sliding window over which the quality rate is measured.
export const LOAD_WINDOW_MS = 300000;
// Below this many samples in the window the quality rate is not trusted and
// the member is scored neutral.
export const LOAD_MIN_SAMPLES = 5;
// Weight used while a member is below the sample threshold.
export const LOAD_NEUTRAL_WEIGHT = 0.5;
// Lower bound on weight so a poor member is deprioritized, never zeroed (a
// zero weight would make the least-load score divide by zero and could starve
// the only member that can serve a model).
export const LOAD_WEIGHT_FLOOR = 0.1;
// Consecutive request-level failures that latch a member to the back. Same
// product rule as the sticky/chain demotion gate (失败才降级).
export const LOAD_DEMOTE_AFTER_FAILURES = 2;
// An idle session affinity expires after this long, aligned with the quality
// window so a returning conversation re-balances instead of pinning a member
// it last used long ago.
export const LOAD_AFFINITY_TTL_MS = 300000;

export function createLoadBalancer({ nowFn = Date.now } = {}) {
  // memberId -> requests currently being served by that member.
  const inflight = new Map();
  // memberId\0modelId -> [{ t, good }] quality samples inside the window.
  const samples = new Map();
  // memberId\0modelId -> consecutive request-level failures.
  const failures = new Map();
  // sessionKey\0poolId\0modelId -> { memberId, t } last answering member.
  const affinity = new Map();

  const memberKey = (memberId, modelId) => `${memberId}\0${modelId}`;
  const affinityKey = (sessionKey, poolId, modelId) => `${sessionKey}\0${poolId}\0${modelId}`;

  const pruneSamples = (memberId, modelId, now) => {
    const k = memberKey(memberId, modelId);
    const list = samples.get(k);
    if (list === undefined) return [];
    const cutoff = now - LOAD_WINDOW_MS;
    const kept = list.filter((sample) => sample.t >= cutoff);
    if (kept.length === 0) samples.delete(k);
    else if (kept.length !== list.length) samples.set(k, kept);
    return kept;
  };

  const weightOf = (memberId, modelId, now) => {
    const list = pruneSamples(memberId, modelId, now);
    if (list.length < LOAD_MIN_SAMPLES) return LOAD_NEUTRAL_WEIGHT;
    const good = list.reduce((count, sample) => count + (sample.good ? 1 : 0), 0);
    return Math.max(LOAD_WEIGHT_FLOOR, good / list.length);
  };

  const isLatched = (memberId, modelId) =>
    (failures.get(memberKey(memberId, modelId)) ?? 0) >= LOAD_DEMOTE_AFTER_FAILURES;

  const recordSample = (memberId, modelId, good, now) => {
    const k = memberKey(memberId, modelId);
    const list = pruneSamples(memberId, modelId, now);
    list.push({ t: now, good });
    samples.set(k, list);
  };

  return {
    // Order candidates by weighted least-load, healthy members first and
    // latched members last (pool order within each group). A healthy session
    // affinity member is moved to the front so a conversation keeps its member
    // and its prompt cache. sessionKey may be null (no affinity).
    order(poolId, modelId, candidates, sessionKey = null) {
      const now = nowFn();
      const healthy = [];
      const latched = [];
      candidates.forEach((candidate, index) => {
        if (isLatched(candidate.memberId, modelId)) {
          latched.push(candidate);
          return;
        }
        const load = inflight.get(candidate.memberId) ?? 0;
        const score = (load + 1) / weightOf(candidate.memberId, modelId, now);
        healthy.push({ candidate, score, index });
      });
      healthy.sort((a, b) => (a.score - b.score) || (a.index - b.index));
      const ordered = healthy.map((entry) => entry.candidate);

      if (sessionKey !== null && sessionKey !== undefined) {
        const k = affinityKey(sessionKey, poolId, modelId);
        const entry = affinity.get(k);
        if (entry !== undefined) {
          if (entry.t + LOAD_AFFINITY_TTL_MS < now) {
            affinity.delete(k);
          } else {
            const index = ordered.findIndex((candidate) => candidate.memberId === entry.memberId);
            if (index > 0) ordered.unshift(...ordered.splice(index, 1));
            else if (index === -1) affinity.delete(k);
          }
        }
      }
      return [...ordered, ...latched];
    },

    // A request began being served by this member (dispatch).
    begin(memberId) {
      inflight.set(memberId, (inflight.get(memberId) ?? 0) + 1);
    },
    // A request finished being served by this member (success, fault, abort).
    end(memberId) {
      const next = (inflight.get(memberId) ?? 0) - 1;
      if (next <= 0) inflight.delete(memberId);
      else inflight.set(memberId, next);
    },

    // A member answered the request. ttftMs is the first-token latency (or the
    // request duration for non-streaming); null counts as not-quality. Resets
    // the failure counter and re-binds the session affinity to the winner.
    noteSuccess(poolId, modelId, memberId, ttftMs = null, sessionKey = null) {
      const now = nowFn();
      recordSample(memberId, modelId, ttftMs !== null && ttftMs <= LOAD_TTFT_GOOD_MS, now);
      failures.set(memberKey(memberId, modelId), 0);
      if (sessionKey !== null && sessionKey !== undefined) {
        affinity.set(affinityKey(sessionKey, poolId, modelId), { memberId, t: now });
      }
    },

    // One request-level failure of a member (last candidate included). Counts
    // a not-quality sample and advances the demotion counter; a latched member
    // loses any session affinity pointing at it so the next request re-picks.
    noteFailure(poolId, modelId, memberId, sessionKey = null) {
      const now = nowFn();
      recordSample(memberId, modelId, false, now);
      const k = memberKey(memberId, modelId);
      const count = (failures.get(k) ?? 0) + 1;
      failures.set(k, count);
      if (count >= LOAD_DEMOTE_AFTER_FAILURES && sessionKey !== null && sessionKey !== undefined) {
        const ak = affinityKey(sessionKey, poolId, modelId);
        if (affinity.get(ak)?.memberId === memberId) affinity.delete(ak);
      }
    },

    // Introspection for tests and diagnostics.
    weight(memberId, modelId) {
      return weightOf(memberId, modelId, nowFn());
    },
    inflightOf(memberId) {
      return inflight.get(memberId) ?? 0;
    },
    consecutive(memberId, modelId) {
      return failures.get(memberKey(memberId, modelId)) ?? 0;
    },
    sampleCount(memberId, modelId) {
      return pruneSamples(memberId, modelId, nowFn()).length;
    },
    affinityOf(poolId, modelId, sessionKey) {
      if (sessionKey === null || sessionKey === undefined) return undefined;
      return affinity.get(affinityKey(sessionKey, poolId, modelId))?.memberId;
    },
  };
}