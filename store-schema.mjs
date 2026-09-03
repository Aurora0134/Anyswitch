// Global ApiCred v2 Store schema validator.
// Pure functions only. No IO, no DPAPI, no network.
// Contract: the store never carries secrets; credentialFile is a
// Store-root-relative reference. The reference is validated here through
// validateCredentialRef so that "schema valid" implies a safe credential path,
// closing the escape vector before any DPAPI read.
import { validateCredentialRef } from "./credential-ref.mjs";
import { chainNodeKey } from "./chain-routing.mjs";

// A field name is secret-like when one of its `-`/`_`-delimited segments is a
// known secret word. Segment-based matching avoids false positives on legit
// names like `maxOutputTokens` (contains "token") or `displayName`.
const SECRET_WORDS = new Set([
  "apikey",
  "key",
  "token",
  "secret",
  "password",
  "authorization",
  "auth",
  "bearer",
  "credential",
  "credentials",
]);

function isSecretFieldName(name) {
  // Whole-name compound like "apiKey" -> "apikey".
  if (SECRET_WORDS.has(name.toLowerCase())) return true;
  // Split camelCase on the original name first, then on -/_ separators, then
  // lowercase each segment. This catches `apiKeyValue` while leaving
  // `maxOutputTokens` (segment "tokens", not "token") untouched.
  const segments = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_\s]+/)
    .map((segment) => segment.toLowerCase())
    .filter(Boolean);
  return segments.some((segment) => SECRET_WORDS.has(segment));
}
const PROVIDER_ID = /^[A-Za-z0-9._-]+$/;

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

const ALLOWED_MODALITIES = new Set(["text", "image", "audio"]);

function validateModalitiesList(where, field, value, errors) {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || !ALLOWED_MODALITIES.has(item))
  ) {
    errors.push(
      `${where}.${field}: must be a non-empty array of text/image/audio when present`,
    );
  }
}

// Recursively flag any key that looks like a secret, except the allowed
// non-secret reference field `credentialFile`.
function findSecretKeys(node, path, errors) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item, index) => findSecretKeys(item, `${path}[${index}]`, errors));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "credentialFile") continue;
    if (isSecretFieldName(key)) {
      errors.push(`${path}.${key}: secret-like field is not allowed in the store`);
    }
    findSecretKeys(value, `${path}.${key}`, errors);
  }
}

function validateModel(providerId, modelId, model, errors) {
  const where = `providers.${providerId}.models.${modelId}`;
  if (model === null || typeof model !== "object" || Array.isArray(model)) {
    errors.push(`${where}: model must be an object`);
    return;
  }
  if (typeof model.displayName !== "string" || model.displayName.length === 0) {
    errors.push(`${where}.displayName: must be a non-empty string`);
  }
  if ("contextWindow" in model && !isPositiveInteger(model.contextWindow)) {
    errors.push(`${where}.contextWindow: must be a positive integer when present`);
  }
  if ("maxOutputTokens" in model && !isPositiveInteger(model.maxOutputTokens)) {
    errors.push(`${where}.maxOutputTokens: must be a positive integer when present`);
  }
  if ("supportsReasoning" in model && typeof model.supportsReasoning !== "boolean") {
    errors.push(`${where}.supportsReasoning: must be a boolean when present`);
  }
  if ("reasoningEffortLevels" in model) {
    if (
      !Array.isArray(model.reasoningEffortLevels) ||
      model.reasoningEffortLevels.length === 0 ||
      model.reasoningEffortLevels.some((item) => typeof item !== "string" || item.length === 0)
    ) {
      errors.push(`${where}.reasoningEffortLevels: must be a non-empty array of strings when present`);
    }
  }
  if ("defaultEffort" in model) {
    if (typeof model.defaultEffort !== "string" || model.defaultEffort.length === 0) {
      errors.push(`${where}.defaultEffort: must be a non-empty string when present`);
    }
  }
  validateModalitiesList(where, "inputModalities", model.inputModalities, errors);
  validateModalitiesList(where, "outputModalities", model.outputModalities, errors);
}

function validateProvider(providerId, provider, errors) {
  const where = `providers.${providerId}`;
  // '/' is a v2 store hard invariant, not just a whitelist side
  // effect. The Claude wire ID `anthropic/<provider-id>/<model-id>` is unpacked
  // by splitting on the first '/' after the prefix, so a provider id that
  // contains '/' would make that decoding ambiguous. Flag it explicitly, naming
  // the slash / wire-ID reason and the offending id, before the generic message.
  if (providerId.includes("/")) {
    errors.push(
      `${where}: provider id "${providerId}" must not contain '/' (wire-ID invariant: the slash separates provider from model in the Claude wire ID)`,
    );
  } else if (!PROVIDER_ID.test(providerId)) {
    errors.push(`${where}: provider id may only contain letters, digits, '.', '_', '-'`);
  }
  if (provider === null || typeof provider !== "object" || Array.isArray(provider)) {
    errors.push(`${where}: provider must be an object`);
    return;
  }
  if (typeof provider.displayName !== "string" || provider.displayName.length === 0) {
    errors.push(`${where}.displayName: must be a non-empty string`);
  }
  if (typeof provider.baseURL !== "string" || provider.baseURL.length === 0) {
    errors.push(`${where}.baseURL: must be a non-empty string`);
  }
  if (provider.fallbackURLs !== undefined) {
    if (!Array.isArray(provider.fallbackURLs) || provider.fallbackURLs.length === 0) {
      errors.push(`${where}.fallbackURLs: must be a non-empty array when present`);
    } else {
      provider.fallbackURLs.forEach((fallbackURL, index) => {
        if (typeof fallbackURL !== "string" || fallbackURL.length === 0) {
          errors.push(`${where}.fallbackURLs[${index}]: must be a non-empty string`);
        }
      });
    }
  }
  if (provider.reasoningVariants !== undefined) {
    if (
      !Array.isArray(provider.reasoningVariants) ||
      provider.reasoningVariants.length === 0 ||
      provider.reasoningVariants.some((item) => typeof item !== "string" || item.length === 0)
    ) {
      errors.push(`${where}.reasoningVariants: must be a non-empty array of strings when present`);
    }
  }
  if (provider.protocol !== "openai-compatible") {
    errors.push(`${where}.protocol: must be "openai-compatible"`);
  }
  if (typeof provider.credentialFile !== "string" || provider.credentialFile.length === 0) {
    errors.push(`${where}.credentialFile: must be a non-empty string`);
  } else {
    const ref = validateCredentialRef(provider.credentialFile);
    if (!ref.valid) {
      errors.push(`${where}.credentialFile: ${ref.reason}`);
    }
  }
  if (provider.models === null || typeof provider.models !== "object" || Array.isArray(provider.models)) {
    errors.push(`${where}.models: must be an object`);
  } else {
    for (const [modelId, model] of Object.entries(provider.models)) {
      validateModel(providerId, modelId, model, errors);
    }
  }
}

function validateClientPolicies(clientPolicies, errors) {
  if (clientPolicies === undefined) return;
  if (clientPolicies === null || typeof clientPolicies !== "object" || Array.isArray(clientPolicies)) {
    errors.push(`clientPolicies: must be an object when present`);
    return;
  }
  const opencode = clientPolicies.opencode;
  if (opencode === undefined) return;
  if (opencode === null || typeof opencode !== "object" || Array.isArray(opencode)) {
    errors.push(`clientPolicies.opencode: must be an object when present`);
    return;
  }
  const exceptions = opencode.literalCredentialExceptions;
  if (exceptions === undefined) return;
  if (!Array.isArray(exceptions) || exceptions.some((e) => typeof e !== "string")) {
    errors.push(`clientPolicies.opencode.literalCredentialExceptions: must be an array of strings`);
  }
}

// Pools (provider pools). A pool groups 2-5 providers under its own
// id/displayName for merged panel display; membership is read-time derived.
// The relay resolves pools at request time: an
// /openai/<pool-id>/... route fans out across the pool's members (sticky on
// the last successful member, then pool order; channel-level faults back off
// to the next member). Resolution checks pools before providers, so pool ids
// share the provider id alphabet and must not collide with non-member
// provider ids — a pool may reuse the id of one of its own members (the
// member is absorbed into the pool's merged display and routing), which is
// what lets `/openai/<pool-id>/...` route without an id migration.
const MIN_POOL_MEMBERS = 2;
const MAX_POOL_MEMBERS = 5;

function validatePools(store, errors) {
  const pools = store.pools;
  if (pools === undefined) return;
  if (pools === null || typeof pools !== "object" || Array.isArray(pools)) {
    errors.push(`pools: must be an object when present`);
    return;
  }
  const providerIds = new Set(Object.keys(store.providers ?? {}));
  const providerIdsLower = new Map();
  for (const id of providerIds) providerIdsLower.set(id.toLowerCase(), id);
  const membership = new Map(); // providerId -> poolId that claims it
  for (const [poolId, pool] of Object.entries(pools)) {
    const where = `pools.${poolId}`;
    if (poolId.includes("/")) {
      errors.push(
        `${where}: pool id "${poolId}" must not contain '/' (wire-ID invariant, same as provider ids)`,
      );
    } else if (!PROVIDER_ID.test(poolId)) {
      errors.push(`${where}: pool id may only contain letters, digits, '.', '_', '-'`);
    }
    if (pool === null || typeof pool !== "object" || Array.isArray(pool)) {
      errors.push(`${where}: pool must be an object`);
      continue;
    }
    if (typeof pool.displayName !== "string" || pool.displayName.length === 0) {
      errors.push(`${where}.displayName: must be a non-empty string`);
    }
    if (!Array.isArray(pool.members)) {
      errors.push(`${where}.members: must be an array of provider ids`);
      continue;
    }
    if (pool.members.length < MIN_POOL_MEMBERS || pool.members.length > MAX_POOL_MEMBERS) {
      errors.push(
        `${where}.members: must contain ${MIN_POOL_MEMBERS}-${MAX_POOL_MEMBERS} provider ids`,
      );
    }
    const seen = new Set();
    pool.members.forEach((memberId, index) => {
      const memberWhere = `${where}.members[${index}]`;
      if (typeof memberId !== "string" || memberId.length === 0) {
        errors.push(`${memberWhere}: must be a non-empty string`);
        return;
      }
      if (!providerIds.has(memberId)) {
        errors.push(`${memberWhere}: provider "${memberId}" does not exist`);
        return;
      }
      if (seen.has(memberId)) {
        errors.push(`${memberWhere}: duplicate member "${memberId}" in this pool`);
        return;
      }
      seen.add(memberId);
      const claim = membership.get(memberId);
      if (claim !== undefined && claim !== poolId) {
        errors.push(`${memberWhere}: provider "${memberId}" already belongs to pool "${claim}"`);
      } else {
        membership.set(memberId, poolId);
      }
    });
    // A pool may reuse the id of one of its own members; colliding with a
    // non-member provider (even only by case) is an error.
    const memberIds = new Set(pool.members);
    if (providerIds.has(poolId) && !memberIds.has(poolId)) {
      errors.push(`${where}: pool id collides with a provider id`);
    }
    const caseClash = providerIdsLower.get(poolId.toLowerCase());
    if (caseClash !== undefined && caseClash !== poolId && !memberIds.has(caseClash)) {
      errors.push(`${where}: pool id differs only by case from provider id "${caseClash}"`);
    }
  }
}

// Routing chains (自动路由). Each coding-agent endpoint may carry one route
// chain: an ordered array of { node, model } entries. node names a provider
// OR a pool (resolution checks pools before providers — the pool-routing.mjs
// resolvePool convention); model is the concrete upstream model the node is
// asked for when the chain routes to it. The relay walks the chain in order
// and backs off to the next node on failure. An entry may also carry an
// optional boolean `enabled` — the per-endpoint 自动路由 switch: false keeps
// the chain config but stops exposing/serving the virtual model "auto"
// (absent = enabled, so existing chains keep working).
// ROUTING_ENDPOINT_IDS must be kept in sync with ENDPOINT_DEFS in
// agent-skills.mjs; it is re-declared here because importing agent-skills
// would pull its relay-settings/atomic-write dependency chain into this
// pure module.
export const ROUTING_ENDPOINT_IDS = Object.freeze([
  "claude",
  "zcode",
  "opencode",
  "pi",
  "kimi",
  "dsh",
  "agy",
  "reasonix",
]);
// Exported so the service layer (store-service.saveRouteChain) enforces the
// same chain length limit instead of carrying its own magic number.
export const MAX_CHAIN_NODES = 8;

function validateRoutingChains(store, errors) {
  const routingChains = store.routingChains;
  if (routingChains === undefined) return;
  if (routingChains === null || typeof routingChains !== "object" || Array.isArray(routingChains)) {
    errors.push(`routingChains: must be an object when present`);
    return;
  }
  const nodeIds = new Set([
    ...Object.keys(store.providers ?? {}),
    ...Object.keys(store.pools ?? {}),
  ]);
  for (const [endpointId, entry] of Object.entries(routingChains)) {
    const where = `routingChains.${endpointId}`;
    if (!ROUTING_ENDPOINT_IDS.includes(endpointId)) {
      errors.push(`${where}: unknown endpoint id (known: ${ROUTING_ENDPOINT_IDS.join(", ")})`);
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${where}: route chain entry must be an object`);
      continue;
    }
    // enabled: per-endpoint 自动路由启用开关（可选；缺省 = 开，向后兼容存量链）。
    if ("enabled" in entry && typeof entry.enabled !== "boolean") {
      errors.push(`${where}.enabled: must be a boolean when present`);
    }
    if (!Array.isArray(entry.chain) || entry.chain.length === 0) {
      errors.push(`${where}.chain: must be a non-empty array of node ids`);
      continue;
    }
    if (entry.chain.length > MAX_CHAIN_NODES) {
      errors.push(`${where}.chain: must contain 1-${MAX_CHAIN_NODES} node ids`);
    }
    const seen = new Set();
    entry.chain.forEach((item, index) => {
      const itemWhere = `${where}.chain[${index}]`;
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`${itemWhere}: must be an object { node, model }`);
        return;
      }
      const { node, model } = item;
      if (typeof node !== "string" || node.length === 0) {
        errors.push(`${itemWhere}.node: must be a non-empty string`);
        return;
      }
      if (!PROVIDER_ID.test(node)) {
        errors.push(`${itemWhere}.node: node id may only contain letters, digits, '.', '_', '-'`);
        return;
      }
      if (!nodeIds.has(node)) {
        errors.push(`${itemWhere}.node: node "${node}" does not exist as a provider or pool`);
        return;
      }
      // 去重按 node+model 复合键：同一节点可绑定不同模型多次入链，
      // 只有 node 与 model 完全相同的条目才算重复。
      const pairKey = chainNodeKey(node, model);
      if (seen.has(pairKey)) {
        errors.push(`${itemWhere}: duplicate node "${node}" with model "${model}" in this chain`);
        return;
      }
      seen.add(pairKey);
      // model is deliberately NOT checked against the node's catalog:
      // catalogs shift with discovered refreshes, so a hard check would break
      // a saved chain on the next refresh. Only non-emptiness is enforced;
      // an unservable model fails upstream at request time instead.
      if (typeof model !== "string" || model.trim().length === 0) {
        errors.push(`${itemWhere}.model: must be a non-empty string`);
      }
    });
  }
}

export function validateStore(store) {
  const errors = [];
  if (store === null || typeof store !== "object" || Array.isArray(store)) {
    return { valid: false, errors: ["store: must be an object"] };
  }
  if (store.version !== 2) {
    errors.push(`version: must be 2`);
  }
  if (store.providers === null || typeof store.providers !== "object" || Array.isArray(store.providers)) {
    errors.push(`providers: must be an object`);
  } else {
    const ids = Object.keys(store.providers);
    const lowered = new Map();
    for (const id of ids) {
      const key = id.toLowerCase();
      if (lowered.has(key)) {
        errors.push(`providers.${id}: duplicate provider id differing only by case from "${lowered.get(key)}"`);
      } else {
        lowered.set(key, id);
      }
    }
    for (const [providerId, provider] of Object.entries(store.providers)) {
      validateProvider(providerId, provider, errors);
    }
  }
  validateClientPolicies(store.clientPolicies, errors);
  validatePools(store, errors);
  validateRoutingChains(store, errors);
  findSecretKeys(store.providers ?? {}, "providers", errors);
  if (store.pools !== undefined) {
    findSecretKeys(store.pools, "pools", errors);
  }
  if (store.routingChains !== undefined) {
    findSecretKeys(store.routingChains, "routingChains", errors);
  }
  return { valid: errors.length === 0, errors };
}
