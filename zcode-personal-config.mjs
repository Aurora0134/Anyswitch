// ZCode's own model list — the file it actually renders — is
// ~/.zcode/v2/provider_config.json. Reading ZCode's shipped runtime shows why
// writing config.json alone stopped being enough: the import from config.json
// runs only while provider_config.json does not exist, after which the client
// polls and rewrites its own file and never looks at the injected one again.
// So every channel, model and deletion Anyswitch pushes into config.json after
// that first import is invisible to the client, restart included.
//
// This module keeps the client-side list in step with the injected config.json.
// It writes the same document ZCode's own importer produces (group
// "standard-personal", api-key access, one openai-chat-completions api block,
// personalModelIds + modelOrder in the injected order, and one
// providerModelRules entry per model carrying only its context window), so the
// client cannot tell the difference between our write and its first import.
//
// Ownership boundaries are strict, in both directions:
//   - a rule is rewritten or dropped only when it is ours: named by the sidecar
//     record of the last sync, or carrying the relay fingerprint an injected
//     entry always has. Everything else — built-in and account providers, and
//     any channel the user added inside ZCode — copies through byte-for-byte;
//   - providerOrder and defaultModelSelection (the user's own ordering and
//     picked model) survive untouched, as do manual model rules;
//   - a managed provider that disappears is dropped from the rule list and
//     takes its model rules with it — that is what stops deleted channels from
//     staying selectable.
// The document schema is strict (unknown keys are rejected by the client), so
// there is deliberately no marker field: the sidecar written next to the relay
// store remains the only record of what we injected.
//
// Pure functions plus one guarded write: a file we cannot parse is never
// treated as empty, and a newer schemaVersion we cannot decode is never
// rewritten in our older shape.

import { readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { contentHash, atomicWriteFile, pruneBackups } from "./atomic-write.mjs";

export const PERSONAL_CONFIG_FILENAME = "provider_config.json";
export const PERSONAL_SCHEMA_VERSION = 1;

const BACKUP_PREFIX = "provider_config.backup.";

// ZCode's decode path throws UnsupportedProviderConfigVersionError for anything
// above its own version; rewriting such a file would downgrade user data.
export class UnparseablePersonalConfigError extends Error {
  constructor(filePath, detail) {
    super(`refusing to overwrite unreadable zcode provider_config.json: ${filePath}${detail ? ` (${detail})` : ""}`);
    this.name = "UnparseablePersonalConfigError";
    this.code = "UNPARSEABLE_PERSONAL_CONFIG";
  }
}

export function personalConfigPath(configPath) {
  return join(dirname(configPath), PERSONAL_CONFIG_FILENAME);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the client-side list. `null` means "no file yet", which is the one state
 * where ZCode itself would import from config.json.
 */
export function readPersonalConfig(filePath) {
  if (!existsSync(filePath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(stripBom(readFileSync(filePath, "utf8")));
  } catch (error) {
    throw new UnparseablePersonalConfigError(filePath, error.message);
  }
  if (!isRecord(parsed) || !Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion < 0) {
    throw new UnparseablePersonalConfigError(filePath, "missing schemaVersion");
  }
  if (parsed.schemaVersion > PERSONAL_SCHEMA_VERSION) {
    throw new UnparseablePersonalConfigError(
      filePath,
      `schemaVersion ${parsed.schemaVersion} is newer than the supported ${PERSONAL_SCHEMA_VERSION}`,
    );
  }
  return parsed;
}

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

const MANAGED_GROUP = "standard-personal";
const CHAT_COMPLETIONS_API = "openai-chat-completions";

/**
 * Derive one client rule from the provider entry as it was written into
 * config.json. Taking the injected entry as the only input keeps the two files
 * from ever drifting: whatever the relay publishes for this channel is what the
 * client lists for it.
 */
export function personalRuleFromProviderEntry(providerId, entry) {
  const rule = {
    providerId,
    ...(typeof entry?.name === "string" && entry.name.length > 0 && entry.name !== providerId
      ? { providerName: entry.name }
      : {}),
    config: {
      group: MANAGED_GROUP,
      access: { type: "api-key", apiKey: entry?.options?.apiKey ?? "" },
      api: {
        type: CHAT_COMPLETIONS_API,
        baseUrl: entry?.options?.baseURL ?? "",
        ...(isRecord(entry?.headers) ? { headers: { ...entry.headers } } : {}),
      },
    },
  };
  const modelIds = Object.keys(entry?.models ?? {});
  if (modelIds.length > 0) {
    rule.config.personalModelIds = modelIds;
    rule.config.modelOrder = modelIds;
  }
  const modelRules = [];
  for (const modelId of modelIds) {
    const contextWindow = entry.models[modelId]?.limit?.context;
    if (isPositiveInteger(contextWindow)) {
      modelRules.push({ providerId, modelId, config: { properties: { contextWindow } } });
    }
  }
  return { rule, modelRules };
}

// A provider id is ours only when it carries the injection prefix AND appears
// in the sidecar record of what we injected last time. Prefixed ids the user
// made by hand inside ZCode are therefore foreign data and copy through.
//
// The sidecar only remembers the previous round, so it cannot be the whole
// answer: a channel deleted before the client list started being maintained
// left a rule behind that no sidecar ever names. Such leftovers are recognised
// by the fingerprint every injected entry carries — our relay's loopback OpenAI
// path plus the explicit endpoint marker — which a hand-made channel pointing
// at a real upstream never matches.
const RELAY_OPENAI_PATH = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/openai\//;

function isAnyswitchRule(rule) {
  const cfg = rule?.config;
  if (!isRecord(cfg) || cfg.group !== MANAGED_GROUP) return false;
  const baseUrl = cfg.api?.baseUrl;
  if (typeof baseUrl !== "string" || !RELAY_OPENAI_PATH.test(baseUrl)) return false;
  return isRecord(cfg.api.headers) && cfg.api.headers["x-agent-id"] === "zcode";
}

function ownedIds(managedIds, previousManaged) {
  return { managed: new Set(managedIds), wasManaged: new Set(previousManaged) };
}

/**
 * Merge this round's injected providers into the client document.
 *
 * @param {object|null} existing parsed provider_config.json, or null when absent
 * @param {object} managedEntries { [prefixedProviderId]: config.json provider entry }
 * @param {string[]} previousManaged prefixed ids injected by the last sync
 * @returns {{ config: object, managed: string[] }} managed is the new prefixed id set
 */
export function mergePersonalProviderConfig(existing, managedEntries, previousManaged = []) {
  const managedIds = Object.keys(managedEntries ?? {});
  const { managed, wasManaged } = ownedIds(managedIds, previousManaged);
  const source = isRecord(existing?.config) ? existing.config : {};

  const existingRules = Array.isArray(source.providerConfigRules?.providerRules)
    ? source.providerConfigRules.providerRules
    : [];
  const built = new Map();
  for (const providerId of managedIds) {
    const { rule, modelRules } = personalRuleFromProviderEntry(providerId, managedEntries[providerId]);
    built.set(providerId, { rule, modelRules });
  }

  const providerRules = [];
  const placed = new Set();
  const ownedOnDisk = new Set();
  for (const rule of existingRules) {
    const providerId = rule?.providerId;
    if (typeof providerId === "string" && managed.has(providerId)) {
      providerRules.push(built.get(providerId).rule);
      placed.add(providerId);
      ownedOnDisk.add(providerId);
      continue;
    }
    // A retired channel drops its rule and takes its model rules with it —
    // that is what stops deleted channels from staying selectable.
    if (typeof providerId === "string" && (wasManaged.has(providerId) || isAnyswitchRule(rule))) {
      ownedOnDisk.add(providerId);
      continue;
    }
    providerRules.push(rule);
  }
  for (const providerId of managedIds) {
    if (placed.has(providerId)) continue;
    providerRules.push(built.get(providerId).rule);
  }

  const existingModelRules = Array.isArray(source.modelConfigRules?.providerModelRules)
    ? source.modelConfigRules.providerModelRules
    : [];
  const manualRules = Array.isArray(source.modelConfigRules?.manualProviderModelRules)
    ? source.modelConfigRules.manualProviderModelRules
    : null;
  // ZCode rejects the same provider+model being declared automatically and
  // manually in one document, so a manual rule the user wrote wins.
  const manualKeys = new Set(
    (manualRules ?? [])
      .filter((r) => isRecord(r))
      .map((r) => `${r.providerId}\u0000${r.modelId}`),
  );
  const keptModelRules = existingModelRules.filter((rule) => {
    const providerId = rule?.providerId;
    if (typeof providerId !== "string") return true;
    return !(ownedOnDisk.has(providerId) || managed.has(providerId) || wasManaged.has(providerId));
  });
  const nextModelRules = [...keptModelRules];
  for (const providerId of managedIds) {
    for (const rule of built.get(providerId).modelRules) {
      if (manualKeys.has(`${rule.providerId}\u0000${rule.modelId}`)) continue;
      nextModelRules.push(rule);
    }
  }

  const config = {
    ...source.providerOrder === undefined ? {} : { providerOrder: source.providerOrder },
    providerConfigRules: { providerRules },
    modelConfigRules: {
      providerModelRules: nextModelRules,
      ...(manualRules ? { manualProviderModelRules: manualRules } : {}),
    },
    ...source.defaultModelSelection === undefined ? {} : { defaultModelSelection: source.defaultModelSelection },
  };
  // Anything else already in the document is user or client data with no place
  // in a rule merge, but it must not be silently dropped either: pass it
  // through and let the validation gate below decide whether it is survivable.
  const knownConfigKeys = new Set(["providerOrder", "providerConfigRules", "modelConfigRules", "defaultModelSelection"]);
  for (const [key, value] of Object.entries(source)) {
    if (knownConfigKeys.has(key)) continue;
    config[key] = value;
  }

  return { config: { schemaVersion: PERSONAL_SCHEMA_VERSION, config }, managed: managedIds };
}

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "config"]);
const CONFIG_KEYS = new Set(["providerOrder", "providerConfigRules", "modelConfigRules", "defaultModelSelection"]);
const PROVIDER_RULE_KEYS = new Set(["providerId", "templateId", "providerName", "enabled", "config"]);
const PROVIDER_CONFIG_KEYS = new Set([
  "group", "logo", "access", "api", "builtinModelIds", "personalModelIds", "modelOrder", "visibility",
]);
const MODEL_RULE_KEYS = new Set(["providerId", "modelId", "config"]);
const GROUPS = new Set(["standard-personal", "zai-family", "bigmodel-family"]);
const API_TYPES = new Set(["anthropic-messages", "openai-chat-completions", "openai-responses"]);
const ACCESS_TYPES = new Set(["api-key", "zhipu-coding-plan-api-key", "zhipu-account"]);
const VISIBILITIES = new Set(["visible", "hidden"]);

function fail(error) {
  return { valid: false, error };
}

function hasUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return `${label} has unknown key "${key}"`;
  }
  return null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isNullableStringArray(value) {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value)) return false;
  return value.every((item) => isNonEmptyString(item));
}

function isUrl(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The gate in front of the write, mirroring the strict zod schema ZCode
 * decodes this file with. A document this rejects would make the client fall
 * back to an empty list, so it never reaches disk.
 */
export function validatePersonalProviderConfig(config) {
  if (!isRecord(config)) return fail("document must be an object");
  const topLevel = hasUnknownKeys(config, TOP_LEVEL_KEYS, "document");
  if (topLevel) return fail(topLevel);
  if (config.schemaVersion !== PERSONAL_SCHEMA_VERSION) return fail(`schemaVersion must be ${PERSONAL_SCHEMA_VERSION}`);
  if (!isRecord(config.config)) return fail("config must be an object");

  const doc = config.config;
  const configKeys = hasUnknownKeys(doc, CONFIG_KEYS, "config");
  if (configKeys) return fail(configKeys);
  if (!isRecord(doc.providerConfigRules)) return fail("config.providerConfigRules must be an object");
  if (!isRecord(doc.modelConfigRules)) return fail("config.modelConfigRules must be an object");

  const providerRules = doc.providerConfigRules.providerRules;
  const providerRuleKeys = hasUnknownKeys(doc.providerConfigRules, new Set(["providerRules"]), "providerConfigRules");
  if (providerRuleKeys) return fail(providerRuleKeys);
  if (!Array.isArray(providerRules)) return fail("providerConfigRules.providerRules must be an array");

  const seenProviders = new Set();
  for (const [index, rule] of providerRules.entries()) {
    if (!isRecord(rule)) return fail(`providerRules[${index}] must be an object`);
    const keys = hasUnknownKeys(rule, PROVIDER_RULE_KEYS, `providerRules[${index}]`);
    if (keys) return fail(keys);
    if (!isNonEmptyString(rule.providerId)) return fail(`providerRules[${index}].providerId must be a non-empty string`);
    if (seenProviders.has(rule.providerId)) return fail(`duplicate providerId "${rule.providerId}"`);
    seenProviders.add(rule.providerId);
    if (!isRecord(rule.config)) return fail(`providerRules[${index}].config must be an object`);
    const ruleConfig = rule.config;
    const cfgKeys = hasUnknownKeys(ruleConfig, PROVIDER_CONFIG_KEYS, `providerRules[${index}].config`);
    if (cfgKeys) return fail(cfgKeys);
    if (ruleConfig.group !== undefined && ruleConfig.group !== null && !GROUPS.has(ruleConfig.group)) {
      return fail(`providerRules[${index}].config.group is not a known group`);
    }
    if (ruleConfig.visibility !== undefined && ruleConfig.visibility !== null && !VISIBILITIES.has(ruleConfig.visibility)) {
      return fail(`providerRules[${index}].config.visibility is not a known visibility`);
    }
    if (ruleConfig.access !== undefined) {
      if (!isRecord(ruleConfig.access)) return fail(`providerRules[${index}].config.access must be an object`);
      const accessKeys = hasUnknownKeys(ruleConfig.access, new Set(["type", "apiKey", "apiKeyManagementUrl"]), `providerRules[${index}].config.access`);
      if (accessKeys) return fail(accessKeys);
      if (!ACCESS_TYPES.has(ruleConfig.access.type)) {
        return fail(`providerRules[${index}].config.access.type is not a known access type`);
      }
      if (!isUrl(ruleConfig.access.apiKeyManagementUrl)) {
        return fail(`providerRules[${index}].config.access.apiKeyManagementUrl must be a valid URL`);
      }
    }
    if (ruleConfig.api !== undefined) {
      if (!isRecord(ruleConfig.api)) return fail(`providerRules[${index}].config.api must be an object`);
      const api = ruleConfig.api;
      const apiKeys = hasUnknownKeys(api, new Set(["type", "baseUrl", "headers"]), `providerRules[${index}].config.api`);
      if (apiKeys) return fail(apiKeys);
      if (!API_TYPES.has(api.type)) return fail(`providerRules[${index}].config.api.type is not a known api type`);
      if (!isUrl(api.baseUrl)) return fail(`providerRules[${index}].config.api.baseUrl must be a valid URL`);
      if (api.headers !== undefined && api.headers !== null) {
        if (!isRecord(api.headers)) return fail(`providerRules[${index}].config.api.headers must be an object`);
        if (!Object.values(api.headers).every((v) => typeof v === "string")) {
          return fail(`providerRules[${index}].config.api.headers must hold string values`);
        }
      }
    }
    for (const listKey of ["builtinModelIds", "personalModelIds", "modelOrder"]) {
      if (!isNullableStringArray(ruleConfig[listKey])) {
        return fail(`providerRules[${index}].config.${listKey} must be an array of non-empty strings`);
      }
    }
  }

  const modelRulesKeys = hasUnknownKeys(doc.modelConfigRules, new Set(["providerModelRules", "manualProviderModelRules"]), "modelConfigRules");
  if (modelRulesKeys) return fail(modelRulesKeys);
  const autoModelRules = doc.modelConfigRules.providerModelRules;
  const manualModelRules = doc.modelConfigRules.manualProviderModelRules ?? [];
  if (!Array.isArray(autoModelRules)) return fail("modelConfigRules.providerModelRules must be an array");
  if (!Array.isArray(manualModelRules)) return fail("modelConfigRules.manualProviderModelRules must be an array");

  const pairs = new Set();
  for (const [list, label] of [[autoModelRules, "providerModelRules"], [manualModelRules, "manualProviderModelRules"]]) {
    for (const [index, rule] of list.entries()) {
      if (!isRecord(rule)) return fail(`${label}[${index}] must be an object`);
      const keys = hasUnknownKeys(rule, MODEL_RULE_KEYS, `${label}[${index}]`);
      if (keys) return fail(keys);
      if (!isNonEmptyString(rule.providerId)) return fail(`${label}[${index}].providerId must be a non-empty string`);
      if (!isNonEmptyString(rule.modelId)) return fail(`${label}[${index}].modelId must be a non-empty string`);
      if (!isRecord(rule.config)) return fail(`${label}[${index}].config must be an object`);
      if (label === "providerModelRules" && !isNonEmptyString(rule.config.providerId) && Object.keys(rule.config).some((k) => k !== "properties" && k !== "optionSpecs")) {
        return fail(`providerModelRules[${index}].config has unknown key "${Object.keys(rule.config).find((k) => k !== "properties" && k !== "optionSpecs")}"`);
      }
      const key = `${rule.providerId}\u0000${rule.modelId}`;
      if (label === "providerModelRules") {
        pairs.add(key);
      } else if (pairs.has(key)) {
        return fail(`model "${rule.modelId}" of "${rule.providerId}" is declared both automatically and manually`);
      }
    }
  }
  for (const rule of manualModelRules) {
    const key = `${rule.providerId}\u0000${rule.modelId}`;
    if (pairs.has(key)) return fail(`model "${rule.modelId}" of "${rule.providerId}" is declared both automatically and manually`);
  }

  if (doc.providerOrder !== undefined) {
    if (!isNullableStringArray(doc.providerOrder)) return fail("config.providerOrder must be an array of non-empty strings");
  }

  return { valid: true };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Write the client list. Bytes match what ZCode itself writes (2-space indent,
 * no trailing newline) so an unchanged sync cannot register as a model-list
 * change on the client side.
 */
export function writePersonalConfigWithBackup(filePath, data) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const text = JSON.stringify(data, null, 2);
  const hash = contentHash(text);

  if (existsSync(filePath)) {
    if (contentHash(readFileSync(filePath, "utf8")) === hash) return { ok: true, unchanged: true };
  }

  let backupPath;
  if (existsSync(filePath)) {
    backupPath = join(dir, `${BACKUP_PREFIX}${timestamp()}.json`);
    copyFileSync(filePath, backupPath);
  }

  atomicWriteFile(filePath, text);
  pruneBackups(dir, BACKUP_PREFIX);
  return { ok: true, unchanged: false, backupPath };
}

/**
 * One sync of the client-side list, from the config.json entries that were just
 * written. Never throws for a client-side problem: an unreadable or newer file,
 * or a document that would not decode, comes back as `{ ok: false }` with the
 * file left exactly as it was, because ZCode falls back to an empty list when
 * this file is unusable — overwriting it with guesses would clear every channel.
 *
 * @param {string} configPath path of the injected config.json
 * @param {object} managedEntries { [prefixedProviderId]: config.json provider entry }
 * @param {string[]} previousManaged prefixed ids injected by the last sync
 */
export function syncZcodePersonalConfig({ configPath, managedEntries, previousManaged = [] }) {
  const path = personalConfigPath(configPath);
  let existing;
  try {
    existing = readPersonalConfig(path);
  } catch (error) {
    if (error?.code === "UNPARSEABLE_PERSONAL_CONFIG") return { ok: false, unchanged: true, path, reason: error.message };
    throw error;
  }

  const { config, managed } = mergePersonalProviderConfig(existing, managedEntries, previousManaged);
  const gate = validatePersonalProviderConfig(config);
  if (!gate.valid) {
    return { ok: false, unchanged: true, path, reason: `zcode provider_config.json would be invalid: ${gate.error}` };
  }

  const written = writePersonalConfigWithBackup(path, config);
  return { ...written, path, managed };
}
