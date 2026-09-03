// Store-management pure functions for the panel backend, ported near-verbatim
// from an early CLI implementation so the panel and the CLI agree on
// validation, discovery classification and refresh semantics. Pure functions
// only: no IO, no DPAPI, no network.
//
// Ported: validateProviderId, validateBaseURL, normalizeBaseURL, parseBaseURLs,
// providerModelsURL, sanitizeModelIds, classifyDiscovery, mergeModelIds,
// planDiscoveredRefresh, computeMigrationSeed, materializeModels,
// planAddModels, planRemoveModels, planStoreRefresh, buildV2AddEntry, mergeV2RotateEntry,
// validateFilterSave, effectiveSetChanged, plus the private helpers they depend
// on (parseJsonc is exported because planStoreRefresh consumes raw config text).

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateProviderId(providerId) {
  if (typeof providerId !== "string" || !PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error("Provider ID must use letters, digits, periods, underscores, or hyphens");
  }
  return providerId;
}

export function parseJsonc(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  // Trailing commas are stripped here, inside the scanner that knows whether
  // it is inside a string, instead of a post-pass regex over the whole text —
  // a regex cannot tell string contents from structure and would rewrite
  // values like "x,]". A pending comma is held back until the next structural
  // character: } or ] drops it, anything but whitespace/comments flushes it.
  let pendingComma = false;
  const source = typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (source.startsWith("//", i)) {
      const newline = source.indexOf("\n", i + 2);
      if (newline === -1) break;
      output += "\n";
      i = newline;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) throw new Error("Unterminated JSONC comment");
      i = end + 1;
      continue;
    }
    if (pendingComma) {
      if (char === "}" || char === "]") {
        pendingComma = false; // trailing comma: drop it, keep the closer
      } else if (!/\s/.test(char)) {
        output += ",";
        pendingComma = false;
      }
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      pendingComma = true;
      continue;
    }
    output += char;
  }
  if (pendingComma) output += ",";
  return JSON.parse(output);
}

export function validateBaseURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Base URL is invalid");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Base URL must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Base URL cannot contain embedded credentials");
  if (url.search || url.hash) throw new Error("Base URL cannot contain a query string or fragment");
  const local = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error("Base URL must use HTTPS unless it is loopback");
  return url.toString().replace(/\/$/, "");
}

export function normalizeBaseURL(value) {
  const input = String(value ?? "").trim();
  if (/^https?:\/\//i.test(input)) return validateBaseURL(input);
  let candidate;
  try {
    candidate = new URL(`http://${input}`);
  } catch {
    throw new Error("Base URL is invalid");
  }
  const loopback = isLoopbackHost(candidate.hostname);
  return validateBaseURL(`${loopback ? "http" : "https"}://${input}`);
}

// Parse a comma-separated Base URL answer (the add/rotate prompt) into the
// primary endpoint plus an ordered fallback list: the first URL becomes
// provider.baseURL — the endpoint the relay always tries first — and the rest
// become provider.fallbackURLs in answering order. Empty segments around stray
// or trailing commas are ignored, every URL gets the same scheme completion as
// a single-URL answer, and duplicates collapse so an endpoint is never retried
// as its own fallback. Throws on an answer with no usable URL at all.
export function parseBaseURLs(value) {
  const parts = String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error("Base URL is invalid");
  const urls = [];
  for (const part of parts) {
    const url = normalizeBaseURL(part);
    if (!urls.includes(url)) urls.push(url);
  }
  const [baseURL, ...fallbackURLs] = urls;
  return fallbackURLs.length > 0 ? { baseURL, fallbackURLs } : { baseURL };
}

function isLoopbackHost(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(hostname.replace(/^\[|\]$/g, ""));
}

export function sanitizeModelIds(values) {
  const modelIds = cleanModelIds(values);
  if (!modelIds.length) throw new Error("Provider returned no usable model IDs");
  return modelIds;
}

// Same cleaning rules as sanitizeModelIds (trim, drop control characters,
// dedupe, cap at 200) but never throws — callers that treat "nothing usable"
// as an ordinary result instead of an error use this directly.
function cleanModelIds(values) {
  const modelIds = [];
  const seen = new Set();
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const modelId = value.trim();
    if (!modelId || modelId.length > 256 || /[\u0000-\u001f\u007f]/.test(modelId) || seen.has(modelId)) continue;
    seen.add(modelId);
    modelIds.push(modelId);
    if (modelIds.length === 200) break;
  }
  return modelIds;
}

export function providerModelsURL(baseURL) {
  return `${validateBaseURL(baseURL).replace(/\/$/, "")}/models`;
}

function usableRawModelIdCount(rawIds) {
  const seen = new Set();
  for (const value of rawIds ?? []) {
    if (typeof value !== "string") continue;
    const modelId = value.trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
  }
  return seen.size;
}

export function classifyDiscovery({ rawIds, sanitizedIds }) {
  const sanitized = Array.isArray(sanitizedIds) ? sanitizedIds : [];
  if (sanitized.length === 0) return { complete: false, canPrune: false, reason: "empty" };
  if (sanitized.length >= 200) return { complete: false, canPrune: false, reason: "capped" };
  if (usableRawModelIdCount(rawIds) > sanitized.length) return { complete: false, canPrune: false, reason: "dropped" };
  return { complete: true, canPrune: true, reason: null };
}

export function mergeModelIds({ existing, upstreamIds, canPrune, makeEntry }) {
  const source = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const upstream = Array.isArray(upstreamIds) ? upstreamIds : [];
  const upstreamSet = new Set(upstream);
  const merged = {};
  for (const [modelId, entry] of Object.entries(source)) {
    // Manually backfilled models (manual === true) are exempt from pruning:
    // a complete upstream /v1/models response that omits them reflects an
    // upstream reporting gap, not a real removal.
    if (upstreamSet.has(modelId)) merged[modelId] = structuredClone(entry);
    else if (!canPrune || (entry && typeof entry === "object" && entry.manual === true)) merged[modelId] = structuredClone(entry);
  }
  for (const modelId of upstream) {
    if (!Object.hasOwn(source, modelId) && !Object.hasOwn(merged, modelId)) merged[modelId] = makeEntry(modelId);
  }
  return merged;
}

function sameKeySet(before, after) {
  if (before.length !== after.length) return false;
  const beforeSet = new Set(before);
  return after.every((key) => beforeSet.has(key));
}

export function computeMigrationSeed({ storeModels, configModels }) {
  const store = storeModels && typeof storeModels === "object" && !Array.isArray(storeModels) ? storeModels : {};
  const config = configModels && typeof configModels === "object" && !Array.isArray(configModels) ? configModels : {};
  const discovered = {};
  for (const [modelId, entry] of Object.entries(store)) {
    discovered[modelId] = structuredClone(entry);
  }
  for (const modelId of Object.keys(config)) {
    if (!Object.hasOwn(discovered, modelId)) discovered[modelId] = { displayName: modelId };
  }
  const modelFilter = Object.keys(discovered);
  const drifted = !sameKeySet(Object.keys(store), Object.keys(config));
  return { discovered, modelFilter, drifted };
}

export function planDiscoveredRefresh({ rawIds, sanitizedIds, discovered }) {
  const classification = classifyDiscovery({ rawIds, sanitizedIds });
  const source = discovered && typeof discovered === "object" && !Array.isArray(discovered) ? discovered : {};
  const upstreamIds = classification.reason === "empty" ? [] : (Array.isArray(sanitizedIds) ? sanitizedIds : []);
  const canPrune = classification.canPrune;
  const existingKeys = new Set(Object.keys(source));
  const upstreamSet = new Set(upstreamIds);
  const added = upstreamIds.filter((modelId) => !existingKeys.has(modelId));
  // Manual models (manual === true) are never reported as pruned: they are
  // kept by mergeModelIds below, so listing them would misreport the refresh.
  const pruned = canPrune
    ? [...existingKeys].filter((modelId) => !upstreamSet.has(modelId) && source[modelId]?.manual !== true)
    : [];
  const nextDiscovered = mergeModelIds({
    existing: source,
    upstreamIds,
    canPrune,
    makeEntry: (modelId) => ({ displayName: modelId }),
  });
  const changed = added.length > 0 || pruned.length > 0;
  return { classification, added, pruned, discovered: nextDiscovered, changed };
}

export function materializeModels({ discovered, modelFilter, configModels }) {
  const discoveredSource = discovered && typeof discovered === "object" && !Array.isArray(discovered) ? discovered : {};
  const configSource = configModels && typeof configModels === "object" && !Array.isArray(configModels) ? configModels : {};
  const filter = Array.isArray(modelFilter) ? modelFilter : [];
  const effective = [];
  const seen = new Set();
  for (const modelId of filter) {
    if (typeof modelId !== "string" || seen.has(modelId) || !Object.hasOwn(discoveredSource, modelId)) continue;
    seen.add(modelId);
    effective.push(modelId);
  }
  const storeModels = {};
  const nextConfigModels = {};
  for (const modelId of effective) {
    storeModels[modelId] = structuredClone(discoveredSource[modelId]);
    nextConfigModels[modelId] = Object.hasOwn(configSource, modelId) ? structuredClone(configSource[modelId]) : { name: modelId };
  }
  return { effective, storeModels, configModels: nextConfigModels };
}

/**
 * Plan a manual model backfill for one provider entry — for cases where the
 * upstream /v1/models response omits a callable model. The entry is never
 * mutated; the result carries a brand-new nextEntry.
 *
 * Order of operations: ① clean modelIds with the same rules as
 * sanitizeModelIds (but without throwing — an all-invalid input collapses to
 * the "empty" failure); ② lazily seed discovered/modelFilter via
 * computeMigrationSeed when the entry lacks either; ③ reject the whole batch
 * when any cleaned id already exists in discovered; ④ merge each new id into
 * discovered as `{ displayName: id, manual: true }` (the manual flag exempts
 * it from refresh pruning) and append it to modelFilter (deduped, order
 * preserved); ⑤ rematerialize models via materializeModels.
 *
 * @param {object} entry provider store entry (may lack discovered/modelFilter)
 * @param {string[]} modelIds raw model ids to backfill
 * @returns {{ ok: true, added: string[], nextEntry: object }
 *   | { ok: false, reason: "empty" }
 *   | { ok: false, reason: "model-exists", duplicates: string[] }}
 */
export function planAddModels(entry, modelIds) {
  const ids = cleanModelIds(modelIds);
  if (ids.length === 0) return { ok: false, reason: "empty" };
  const source = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
  const seed = computeMigrationSeed({ storeModels: source.models, configModels: {} });
  const discovered = source.discovered && typeof source.discovered === "object" && !Array.isArray(source.discovered)
    ? structuredClone(source.discovered)
    : seed.discovered;
  const modelFilter = Array.isArray(source.modelFilter) ? source.modelFilter.slice() : seed.modelFilter;
  const duplicates = ids.filter((modelId) => Object.hasOwn(discovered, modelId));
  if (duplicates.length > 0) return { ok: false, reason: "model-exists", duplicates };
  for (const modelId of ids) {
    discovered[modelId] = { displayName: modelId, manual: true };
    if (!modelFilter.includes(modelId)) modelFilter.push(modelId);
  }
  const { storeModels } = materializeModels({ discovered, modelFilter, configModels: {} });
  return { ok: true, added: ids, nextEntry: { ...source, discovered, modelFilter, models: storeModels } };
}

/**
 * Plan a model removal for one provider entry — the mirror image of
 * planAddModels. Works for both manually backfilled (manual) models and
 * upstream-discovered ones. The entry is never mutated; the result carries a
 * brand-new nextEntry.
 *
 * Order of operations: ① clean modelIds with the same rules as
 * sanitizeModelIds (but without throwing — an all-invalid input collapses to
 * the "empty" failure); ② lazily seed discovered/modelFilter via
 * computeMigrationSeed when the entry lacks either (identical to
 * planAddModels); ③ reject the whole batch when any cleaned id is not in
 * discovered — no partial deletions; ④ drop the ids from discovered and from
 * modelFilter (order preserved); ⑤ rematerialize models via
 * materializeModels.
 *
 * Semantics: removing a discovered model is soft — if the upstream still
 * reports it, the next refresh re-adds it to discovered, but because
 * modelFilter no longer lists it, it stays out of models (unchecked in the
 * panel). Removing a manual model is final: it disappears entirely unless it
 * is backfilled again.
 *
 * @param {object} entry provider store entry (may lack discovered/modelFilter)
 * @param {string[]} modelIds raw model ids to remove
 * @returns {{ ok: true, removed: string[], nextEntry: object }
 *   | { ok: false, reason: "empty" }
 *   | { ok: false, reason: "model-not-found", missing: string[] }}
 */
export function planRemoveModels(entry, modelIds) {
  const ids = cleanModelIds(modelIds);
  if (ids.length === 0) return { ok: false, reason: "empty" };
  const source = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
  const seed = computeMigrationSeed({ storeModels: source.models, configModels: {} });
  const discovered = source.discovered && typeof source.discovered === "object" && !Array.isArray(source.discovered)
    ? structuredClone(source.discovered)
    : seed.discovered;
  const modelFilter = Array.isArray(source.modelFilter) ? source.modelFilter.slice() : seed.modelFilter;
  const missing = ids.filter((modelId) => !Object.hasOwn(discovered, modelId));
  if (missing.length > 0) return { ok: false, reason: "model-not-found", missing };
  const removing = new Set(ids);
  for (const modelId of ids) delete discovered[modelId];
  const nextModelFilter = modelFilter.filter((modelId) => !removing.has(modelId));
  const { storeModels } = materializeModels({ discovered, modelFilter: nextModelFilter, configModels: {} });
  return { ok: true, removed: ids, nextEntry: { ...source, discovered, modelFilter: nextModelFilter, models: storeModels } };
}

function dedupeModelIds(values) {
  const ids = [];
  const seen = new Set();
  for (const value of values ?? []) {
    if (typeof value !== "string" || seen.has(value)) continue;
    seen.add(value);
    ids.push(value);
  }
  return ids;
}

// Seed a fresh v2 rich entry from a successful add probe. The just-probed model
// ids become both the discovered cache and a fully-permissive modelFilter, so
// filter/refresh/relay see the provider immediately. models is the materialized
// discovered ∩ modelFilter intersection. fallbackURLs is relay routing metadata
// from the multi-URL prompt answer: recorded only when at least one backup
// endpoint was named, never as an empty array (the store schema rejects one).
export function buildV2AddEntry({ displayName, baseURL, fallbackURLs, credentialFile, modelIds }) {
  const ids = dedupeModelIds(modelIds);
  const discovered = {};
  for (const modelId of ids) discovered[modelId] = { displayName: modelId };
  const modelFilter = ids.slice();
  const { storeModels } = materializeModels({ discovered, modelFilter, configModels: {} });
  const entry = { displayName, baseURL, protocol: "openai-compatible", credentialFile, discovered, modelFilter, models: storeModels };
  if (fallbackURLs?.length) entry.fallbackURLs = fallbackURLs.slice();
  return entry;
}

// Rotate an existing v2 entry: preserve the user's curated modelFilter/discovered/
// models and only swap in the rotated baseURL and credentialFile. Never mutates
// the passed-in entry. fallbackURLs follows the rotate prompt's whole-group
// semantics: undefined keeps the existing group (plain key rotation, or Enter
// to keep), any array replaces it, and an empty array drops the fallbacks.
export function mergeV2RotateEntry({ existing, baseURL, fallbackURLs, credentialFile }) {
  const merged = structuredClone(existing);
  merged.baseURL = baseURL;
  merged.credentialFile = credentialFile;
  if (fallbackURLs !== undefined) {
    if (fallbackURLs.length > 0) merged.fallbackURLs = fallbackURLs.slice();
    else delete merged.fallbackURLs;
  }
  return merged;
}

export function validateFilterSave({ discovered, modelFilter }) {
  const discoveredSource = discovered && typeof discovered === "object" && !Array.isArray(discovered) ? discovered : {};
  if (Object.keys(discoveredSource).length === 0) return { ok: false, reason: "no-discovered" };
  const filter = Array.isArray(modelFilter) ? modelFilter : [];
  const hasEffective = filter.some((modelId) => typeof modelId === "string" && Object.hasOwn(discoveredSource, modelId));
  if (!hasEffective) return { ok: false, reason: "empty-effective" };
  return { ok: true };
}

export function effectiveSetChanged({ before, after }) {
  const beforeIds = Array.isArray(before) ? before : [];
  const afterIds = Array.isArray(after) ? after : [];
  return !sameKeySet(beforeIds, afterIds);
}

// Batch refresh under the discovered/modelFilter model. The v2 store is the
// single source of truth. For each provider:
//   1. Lazy migration: if the provider predates this feature (has `models` but
//      no `discovered`/`modelFilter`), seed both from the old store∪config union
//      so the effective set is unchanged on first touch.
//   2. Apply the upstream discovery to `discovered` through planDiscoveredRefresh,
//      which honours the existing safety gates (empty/capped/dropped never prune).
//   3. Re-materialize `models` as discovered ∩ modelFilter. modelFilter is the
//      user-owned allow-list and is never modified by refresh.
// A discovery error or an empty upstream result is reported as failed and never
// prunes discovered. Returns { store, reports }; config is derived by the caller.
export function planStoreRefresh({ configText, store, discoveries }) {
  const parsedConfig = parseJsonc(configText);
  const nextStore = structuredClone(store);
  const reports = [];
  for (const discovery of discoveries ?? []) {
    const providerId = discovery.providerId;
    const entry = nextStore.providers?.[providerId];
    if (!entry) {
      reports.push({ providerId, status: "failed", reason: "unknown-provider", added: [], pruned: [] });
      continue;
    }
    if (!entry.discovered || typeof entry.discovered !== "object" || Array.isArray(entry.discovered) || !Array.isArray(entry.modelFilter)) {
      const seed = computeMigrationSeed({
        storeModels: entry.models,
        configModels: parsedConfig.provider?.[providerId]?.models,
      });
      if (!entry.discovered || typeof entry.discovered !== "object" || Array.isArray(entry.discovered)) {
        entry.discovered = seed.discovered;
      }
      if (!Array.isArray(entry.modelFilter)) {
        entry.modelFilter = seed.modelFilter;
      }
    }
    if (discovery.error !== undefined && discovery.error !== null) {
      reports.push({ providerId, status: "failed", reason: String(discovery.error), added: [], pruned: [] });
      continue;
    }
    const plan = planDiscoveredRefresh({
      rawIds: discovery.rawIds,
      sanitizedIds: discovery.sanitizedIds,
      discovered: entry.discovered,
    });
    entry.discovered = plan.discovered;
    // Enrich discovered entries with upstream metadata (contextWindow,
    // maxOutputTokens) that defaultDiscoverModels extracted from the GET
    // /v1/models response. Without this step the metadata would be lost:
    // planDiscoveredRefresh only tracks model ids, not their properties.
    // Reasoning fields are deliberately absent here — discovery does not
    // collect them (no upstream ships them; see store-service.mjs
    // discoverModels), effort metadata comes from store annotations and the
    // pi-ai knowledge base.
    if (Array.isArray(discovery.rawModels)) {
      for (const raw of discovery.rawModels) {
        if (!raw || typeof raw.id !== "string") continue;
        const disc = entry.discovered[raw.id];
        if (!disc) continue;
        if (raw.contextWindow !== undefined) disc.contextWindow = raw.contextWindow;
        if (raw.maxOutputTokens !== undefined) disc.maxOutputTokens = raw.maxOutputTokens;
      }
    }
    const { storeModels } = materializeModels({
      discovered: entry.discovered,
      modelFilter: entry.modelFilter,
      configModels: {},
    });
    entry.models = storeModels;
    if (plan.classification.reason === "empty") {
      reports.push({ providerId, status: "failed", reason: "empty", added: [], pruned: [] });
      continue;
    }
    const changed = plan.added.length > 0 || plan.pruned.length > 0;
    reports.push({
      providerId,
      status: changed ? "updated" : "unchanged",
      reason: plan.classification.reason,
      added: plan.added,
      pruned: plan.pruned,
    });
  }
  return { store: nextStore, reports };
}
