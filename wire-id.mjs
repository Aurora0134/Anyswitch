// Claude wire ID packing / unpacking.
// Pure functions only. No IO, no network, no DPAPI.
//
// wire ID = "anthropic/" + <provider-id> + "/" + <model-id>
//
// Unpacking is strict and single-strip:
//   1. input must start with the literal lowercase prefix "anthropic/"
//   2. strip that prefix exactly once
//   3. split the remainder on its FIRST '/' -> provider-id | model-id
//   4. provider-id non-empty and free of '/', model-id non-empty (may contain '/')
//
// Step 3 is only unambiguous because provider ids can never contain '/'. That is
// a v2 store hard invariant enforced by store-schema.mjs validateProvider.
// If that invariant is ever dropped, this encoding fails with it.
//
// No case normalisation: "Anthropic/" / "ANTHROPIC/" do NOT start with the
// literal prefix and are rejected as non-ApiCred targets.
//
// Pool awareness. The provider segment may name a pool instead of a
// provider; resolution MUST check pools before providers (a pool id may reuse
// one of its own member's ids; the pool wins). When a store is supplied:
//   - qualified form "anthropic/<seg>/<model>": if store.pools[seg] exists the
//     result is a pool target ({ pool: true, poolId, ... }); providerId is set
//     to the same segment so store-less callers and legacy consumers keep
//     working. Model membership is NOT checked here — the caller's pool plan
//     answers 404 when no member carries the model.
//   - unqualified scan: each pool counts as ONE match unit, matched against
//     the union of its members' catalogs (dated -YYYYMMDD stripping applies
//     too). A matching provider that belongs to a matching pool is absorbed
//     into the pool's unit (its traffic would route there anyway). The
//     conservative ambiguity that remains: a model in a provider that is NOT
//     a member of a matching pool AND in a pool union is ambiguous, as is a
//     model carried by two pools.

import { resolvePool, poolModelsUnion } from "./pool-routing.mjs";
import { deriveVisibleChannels } from "./pool-providers.mjs";

export const WIRE_PREFIX = "anthropic/";

export function packWireId(providerId, modelId) {
  if (typeof providerId !== "string" || providerId.length === 0) {
    throw new Error("packWireId: providerId must be a non-empty string");
  }
  if (providerId.includes("/")) {
    throw new Error(
      `packWireId: provider id "${providerId}" must not contain '/' (wire-ID invariant)`,
    );
  }
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new Error("packWireId: modelId must be a non-empty string");
  }
  return `${WIRE_PREFIX}${providerId}/${modelId}`;
}

// Statistics-facing model name: the wire ID's MODEL segment only. Claude Code
// sends the full wire ID "anthropic/<provider>/<model>" in body.model (the
// prefix spoofs the identity the endpoint expects); journals, stability rows
// and the panel display the bare model id instead, matching the model field
// the openai-path relays already journal (model ids may themselves contain
// '/', so the provider segment is split off on the FIRST '/'). Returns null
// for non-strings (startRequest meta.model is caller-supplied and must never
// crash the tracker); passes non-wire-id strings through unchanged — plain
// model ids sent to the openai endpoints are already bare.
export function wireIdToStatModel(wireId) {
  if (typeof wireId !== "string" || wireId.length === 0) return null;
  if (!wireId.startsWith(WIRE_PREFIX)) return wireId;
  const rest = wireId.slice(WIRE_PREFIX.length);
  const cut = rest.indexOf("/");
  // Provider ids never contain '/', so the first '/' is the provider/model
  // boundary. A malformed tail with no '/' keeps its stripped form as-is.
  return cut === -1 ? rest : rest.slice(cut + 1);
}

// Statistics-facing TARGET id: the wire ID's provider/pool segment. Journals
// and stability rows group by this id; without it a plain channel wire-id
// request has no attribution fallback at all (chain plans install a resolver,
// pools pass the pool id, so this covers exactly the classic direct path).
// Same single-strip rule as unpackWireId: ids never contain '/', so the first
// '/' is the boundary. Returns null for non-wire-id input ("auto", bare model
// ids, unqualified scans — those either carry their own attribution or are
// genuinely unattributed) and for a malformed tail without a separator.
export function wireIdToTargetId(wireId) {
  if (typeof wireId !== "string" || !wireId.startsWith(WIRE_PREFIX)) return null;
  const rest = wireId.slice(WIRE_PREFIX.length);
  const cut = rest.indexOf("/");
  return cut > 0 ? rest.slice(0, cut) : null;
}

// Reasons are stable identifiers so the HTTP layer can map them to status codes
// without string matching on prose.
export const UNPACK_REASON = {
  NOT_A_STRING: "model-not-a-string",
  MISSING: "model-missing",
  NOT_WIRE_ID: "not-a-wire-id",
  NO_SEPARATOR: "no-provider-model-separator",
  EMPTY_PROVIDER: "empty-provider-segment",
  EMPTY_MODEL: "empty-model-segment",
  AMBIGUOUS_UNQUALIFIED: "ambiguous-unqualified-model",
  UNKNOWN_UNQUALIFIED: "unknown-unqualified-model",
};

function reject(reason, message) {
  return { ok: false, reason, message };
}

export function unpackWireId(wireId, store) {
  if (wireId === undefined || wireId === null) {
    return reject(UNPACK_REASON.MISSING, "request body is missing a `model` field");
  }
  if (typeof wireId !== "string") {
    return reject(UNPACK_REASON.NOT_A_STRING, "`model` must be a string");
  }
  if (!wireId.startsWith(WIRE_PREFIX)) {
    if (store !== undefined) {
      const candidates = [wireId];
      const dated = wireId.match(/^(.*)-\d{8}$/);
      if (dated) candidates.push(dated[1]);
      const providerMatches = [];
      for (const [providerId, provider] of Object.entries(store?.providers ?? {})) {
        const modelId = candidates.find((candidate) => provider?.models?.[candidate] !== undefined);
        if (modelId !== undefined) providerMatches.push({ providerId, modelId });
      }
      // Each pool is ONE match unit, matched on its members' catalog union.
      // A matching provider that belongs to a matching pool is absorbed into
      // the pool's unit — its traffic would route through the pool anyway, so
      // counting both would make every pool model permanently ambiguous. The
      // conservative ambiguity that remains: a model in a provider that is
      // NOT a member of a matching pool AND in a pool union is ambiguous, as
      // is a model carried by two pools.
      const poolMatches = [];
      for (const [poolId, pool] of Object.entries(store?.pools ?? {})) {
        const union = poolModelsUnion(store, pool);
        const modelId = candidates.find((candidate) => union[candidate] !== undefined);
        if (modelId !== undefined) poolMatches.push({ poolId, modelId, pool: true });
      }
      const absorbed = new Set();
      for (const match of poolMatches) {
        for (const memberId of store.pools[match.poolId]?.members ?? []) absorbed.add(memberId);
      }
      const matches = [
        ...providerMatches.filter((match) => !absorbed.has(match.providerId)),
        ...poolMatches,
      ];
      if (matches.length === 1) {
        const { providerId, poolId, modelId, pool } = matches[0];
        if (pool === true) {
          return { ok: true, providerId: poolId, poolId, modelId, canonicalId: `${poolId}/${modelId}`, legacy: true, pool: true };
        }
        return { ok: true, providerId, modelId, canonicalId: `${providerId}/${modelId}`, legacy: true };
      }
      if (matches.length > 1) {
        return reject(
          UNPACK_REASON.AMBIGUOUS_UNQUALIFIED,
          `model "${wireId}" is available from multiple relay providers; use the full model id from /v1/models`,
        );
      }
      return reject(
        UNPACK_REASON.UNKNOWN_UNQUALIFIED,
        `model "${wireId}" is not registered in this relay; use the full model id from /v1/models`,
      );
    }
    return reject(
      UNPACK_REASON.NOT_WIRE_ID,
      `model "${wireId}" is not an ApiCred wire ID; it must start with the literal prefix "${WIRE_PREFIX}". This relay does not proxy the official Anthropic API.`,
    );
  }
  const rest = wireId.slice(WIRE_PREFIX.length);
  const cut = rest.indexOf("/");
  if (cut === -1) {
    return reject(
      UNPACK_REASON.NO_SEPARATOR,
      `model "${wireId}" has no '/' separating provider from model after the prefix`,
    );
  }
  const providerId = rest.slice(0, cut);
  const modelId = rest.slice(cut + 1);
  if (providerId.length === 0) {
    return reject(UNPACK_REASON.EMPTY_PROVIDER, `model "${wireId}" has an empty provider segment`);
  }
  if (modelId.length === 0) {
    return reject(UNPACK_REASON.EMPTY_MODEL, `model "${wireId}" has an empty model segment`);
  }
  // Pools resolve before providers: a pool id may reuse a member's id, and
  // the pool wins the tie. Store-less callers get the plain provider shape.
  if (store !== undefined && resolvePool(store, providerId)) {
    return { ok: true, providerId, poolId: providerId, modelId, canonicalId: `${providerId}/${modelId}`, pool: true };
  }
  return { ok: true, providerId, modelId, canonicalId: `${providerId}/${modelId}` };
}

// Build the full wire catalog for a validated v2 store.
// If two canonical ids ever collapse onto the same wire ID, the WHOLE
// catalog generation fails. Never emit a partial catalog.
//
// displayName is the picker label. It is prefixed with the provider id, because
// the same model display name legitimately appears under several providers that
// differ in billing multiplier; a bare model name would make those rows visually
// identical and the cost difference invisible. The provider *id* is used rather
// than the provider displayName so the label matches the wire ID, `--model` and
// the apicred CLI exactly. This field is presentation metadata only and is
// excluded from the catalog generation digest (see catalog-generation.mjs), so
// relabelling never invalidates a live session.
//
// Pool awareness: the visible channel table comes from the single derivation
// in pool-providers.mjs — every pool appears as ONE catalog unit carrying the
// union of its members' catalogs, and member providers are absorbed (never
// listed on their own), exactly as in the agent-sync endpoint configs.
// Absorption is not just cosmetic — a pool id may reuse one of its own
// member's ids (store schema allows that), so listing both would be a
// wire-ID collision and fail the whole catalog. Routing already resolves the
// pool segment before providers (unpackWireId), so every emitted pool wireId
// stays callable.
export function buildWireCatalog(store) {
  const channels = deriveVisibleChannels(store);
  const entries = [];
  const seen = new Map();

  function emit(providerId, modelId, modelLabel) {
    const wireId = packWireId(providerId, modelId);
    if (seen.has(wireId)) {
      throw new Error(
        `wire ID collision: "${wireId}" is produced by both "${seen.get(wireId)}" and "${providerId}/${modelId}"; refusing to emit a partial catalog`,
      );
    }
    seen.set(wireId, `${providerId}/${modelId}`);
    entries.push({
      wireId,
      providerId,
      modelId,
      displayName: `[${providerId}] ${modelLabel}`,
    });
  }

  for (const [providerId, channel] of Object.entries(channels)) {
    for (const [modelId, model] of Object.entries(channel?.models ?? {})) {
      emit(providerId, modelId, model?.displayName ?? modelId);
    }
  }
  return entries;
}
