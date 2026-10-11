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
// rewritten in our older shape. The read → merge → write of a sync runs under
// the same directory lock ZCode itself takes (atomic-write.mjs
// withDirectoryLock), because the running client rewrites this file with the
// user's default model selection — an unlocked sync could silently overwrite
// that write, and a client write landing mid-sync would be lost from ours.

import { readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { contentHash, atomicWriteFile, pruneBackups, withDirectoryLock, LockTimeoutError } from "./atomic-write.mjs";
import { AUTO_CHANNEL_KEY, readSidecar, writeSidecar } from "./merge-common.mjs";

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
 * @param {object} [options]
 * @param {object} [options.defaultModelSelection] used only when the file has no
 *   defaultModelSelection of its own (CLI slot bootstrap; the desktop slot never
 *   passes one, so its document shape is unchanged)
 * @returns {{ config: object, managed: string[] }} managed is the new prefixed id set
 */
export function mergePersonalProviderConfig(existing, managedEntries, previousManaged = [], options = {}) {
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
  // The rebuilt rules for managed providers are ours, but ZCode mixes one
  // piece of client state into them: config.enabled, the per-model toggle in
  // its model list. Dropping it on every sync would silently re-enable a model
  // the user switched off, so the client-written flag rides along on the rule
  // we regenerate. (Non-boolean values are not carried: the write gate would
  // reject the document.)
  const managedEnabled = new Map();
  for (const rule of existingModelRules) {
    if (typeof rule?.providerId !== "string" || !managed.has(rule.providerId)) continue;
    if (typeof rule?.config?.enabled === "boolean") {
      if (!managedEnabled.has(rule.providerId)) managedEnabled.set(rule.providerId, new Map());
      managedEnabled.get(rule.providerId).set(rule.modelId, rule.config.enabled);
    }
  }
  const nextModelRules = [...keptModelRules];
  for (const providerId of managedIds) {
    for (const rule of built.get(providerId).modelRules) {
      if (manualKeys.has(`${rule.providerId}\u0000${rule.modelId}`)) continue;
      const enabled = managedEnabled.get(rule.providerId)?.get(rule.modelId);
      nextModelRules.push(enabled === undefined ? rule : { ...rule, config: { enabled, ...rule.config } });
    }
  }

  const config = {
    ...source.providerOrder === undefined ? {} : { providerOrder: source.providerOrder },
    providerConfigRules: { providerRules },
    modelConfigRules: {
      providerModelRules: nextModelRules,
      // ZCode 的 schema 把 manualProviderModelRules 定为必填（zcode-src
      // packages/provider/src/config/rule-data-schema.ts
      // personalModelConfigRulesSchema）：缺这个键的文件会被 CLI 整份拒收、静默
      // recovery 成空 personal 层（界面报 Select a model before continuing）。
      // 恒输出——没有手动规则就是 []——也与客户端自己回写的 canonical 形态一致。
      manualProviderModelRules: manualRules ?? [],
    },
    // The user's own picked model survives untouched; only a file that has no
    // selection at all may take the caller-supplied one.
    ...source.defaultModelSelection !== undefined
      ? { defaultModelSelection: source.defaultModelSelection }
      : options.defaultModelSelection
        ? { defaultModelSelection: options.defaultModelSelection }
        : {},
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

/* ---------- CLI 槽位的默认模型选择 ---------- */

// The CLI refuses to run headless against a fresh provider_config.json — the
// registry validator (compiled zcode.cjs validateModelSelectionOptions) rejects
// a defaultModelSelection without options.reasoningLevel
// (reasoning-level-missing) or with a level outside the model's resolved
// reasoningLevel.values (reasoning-level-not-supported), both silently falling
// back, and with no selection at all it stops at "Select a model before
// continuing". A fresh CLI slot therefore gets one generated selection whose
// reasoningLevel is provably legal for the chosen model.
//
// Anchor verified by the acceptance run with real requests: _free-pool's
// mimo-v2.6-flash-free resolves to reasoningLevel.values ["disabled","enabled"],
// so "disabled" is a legal, working level there. "free-pool" is a channel id
// from the operator's store, not a code-level constant — hence the literal.
const CLI_AUTO_PROVIDER_ID = `_${AUTO_CHANNEL_KEY}`;
const CLI_FALLBACK_PROVIDER_ID = "_free-pool";
const CLI_FALLBACK_REASONING_LEVEL = "disabled";

function firstModelIdOf(entry) {
  const modelIds = Object.keys(entry?.models ?? {});
  return modelIds.length > 0 ? modelIds[0] : undefined;
}

// Rule matching mirrors ModelConfigRules.resolve (zcode-src
// packages/provider/src/config/model-config.ts): modelMatch is
// case-insensitive, apiTypeMatch/baseUrlMatch are case-sensitive, and the
// baseUrl is normalized (trailing slashes stripped) before matching.
function rulePatternMatches(pattern, value, ignoreCase) {
  if (typeof pattern !== "string" || typeof value !== "string") return false;
  try {
    return new RegExp(`^(?:${pattern})$`, ignoreCase ? "i" : undefined).test(value);
  } catch {
    return false;
  }
}

function normalizeBaseUrlForRuleMatch(value) {
  try {
    const parsed = new URL(value);
    const suffix = `${parsed.search}${parsed.hash}`;
    const serialized = parsed.toString();
    const endpoint = suffix.length === 0 ? serialized : serialized.slice(0, -suffix.length);
    return `${endpoint.replace(/\/+$/, "")}${suffix}`;
  } catch {
    return undefined;
  }
}

/**
 * Resolve one model's legal reasoningLevel values the way the CLI does: walk
 * the builtin rules in document order (modelRules → modelApiRules →
 * providerSiteRules — template-model rules need a templateId and
 * builtin-provider rules name builtin provider ids, neither can match a
 * personal provider) and let every matching rule overlay
 * optionSpecs.reasoningLevel.values onto the running result.
 *
 * @param {object|null} rules parsed zcode-builtin.json's config.modelConfigRules
 * @returns {string[]|null} the resolved legal values, or null when the model's
 *   values cannot be resolved (no builtin rules, the spec explicitly cleared, …)
 */
export function resolveBuiltinReasoningLevels(rules, { modelId, apiType, baseUrl } = {}) {
  if (!isRecord(rules)) return null;
  const flat = [
    ...(Array.isArray(rules.modelRules) ? rules.modelRules : []).map((rule) => ({ kind: "model", ...rule })),
    ...(Array.isArray(rules.modelApiRules) ? rules.modelApiRules : []).map((rule) => ({ kind: "model-api", ...rule })),
    ...(Array.isArray(rules.providerSiteRules) ? rules.providerSiteRules : []).map((rule) => ({ kind: "provider-site", ...rule })),
  ];
  const normalizedBaseUrl = normalizeBaseUrlForRuleMatch(baseUrl);
  let values;
  for (const rule of flat) {
    if (!isRecord(rule)) continue;
    if (!rulePatternMatches(rule.modelMatch, modelId, true)) continue;
    if ((rule.kind === "model-api" || rule.kind === "provider-site") && rule.apiTypeMatch !== undefined) {
      if (apiType == null || !rulePatternMatches(rule.apiTypeMatch, apiType, false)) continue;
    }
    if (
      rule.kind === "provider-site" &&
      (normalizedBaseUrl === undefined || !rulePatternMatches(rule.baseUrlMatch, normalizedBaseUrl, false))
    ) {
      continue;
    }
    const spec = isRecord(rule.config) ? rule.config.optionSpecs?.reasoningLevel : undefined;
    if (spec === undefined) continue;
    // ConfigOverlay 语义：null 显式清除整份 spec；spec 里只有 values 键出现才
    // 覆盖取值集合（只带 map 的规则不动 values）。
    if (spec === null) {
      values = null;
      continue;
    }
    if (isRecord(spec) && "values" in spec) values = spec.values;
  }
  return Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === "string" && v.length > 0)
    ? values
    : null;
}

// 合法项里优先 "disabled"（思考关闭，与验收锚点同形态）；模型不支持时退到解析
// 集合的第一项——值一定来自解析结果，保证过 validateModelSelectionOptions。
function pickLegalReasoningLevel(values) {
  return values.includes(CLI_FALLBACK_REASONING_LEVEL) ? CLI_FALLBACK_REASONING_LEVEL : values[0];
}

/**
 * The default selection a fresh CLI slot file gets. 通用规则：优先 _auto 渠道
 * （首模型，reasoningLevel 取该模型经 builtin 规则解析后的合法项）；不可解析
 * （builtin 规则不可用或没解析出取值集合）则回落到验收锚点形态——_free-pool
 * 首模型 + "disabled"。两个锚点都不在时取第一个有模型的托管渠道，同样先解析、
 * 解析不出才用 "disabled" 兜底：兜底值即便不合法，CLI 也只是静默退回
 * registry-fallback，仍好过没有选择直接报 Select a model before continuing。
 *
 * @param {object} managedEntries { [prefixedProviderId]: config.json provider entry }
 * @param {object|null} builtinModelRules parsed zcode-builtin.json's config.modelConfigRules
 * @returns {{ providerId: string, modelId: string, options: { reasoningLevel: string } } | null}
 */
export function defaultCliModelSelection(managedEntries, builtinModelRules) {
  const entries = isRecord(managedEntries) ? managedEntries : {};
  const buildSelection = (providerId, entry, { requireResolved }) => {
    const modelId = firstModelIdOf(entry);
    if (modelId === undefined) return undefined;
    const values = resolveBuiltinReasoningLevels(builtinModelRules, {
      modelId,
      // Managed entries always reach the client as one openai-chat-completions
      // api block (personalRuleFromProviderEntry), so that is the apiType the
      // CLI resolves these models with.
      apiType: CHAT_COMPLETIONS_API,
      baseUrl: entry?.options?.baseURL,
    });
    if (values === null) {
      return requireResolved
        ? undefined
        : { providerId, modelId, options: { reasoningLevel: CLI_FALLBACK_REASONING_LEVEL } };
    }
    return { providerId, modelId, options: { reasoningLevel: pickLegalReasoningLevel(values) } };
  };

  const autoSelection = buildSelection(CLI_AUTO_PROVIDER_ID, entries[CLI_AUTO_PROVIDER_ID], { requireResolved: true });
  if (autoSelection) return autoSelection;
  const fallbackSelection = buildSelection(CLI_FALLBACK_PROVIDER_ID, entries[CLI_FALLBACK_PROVIDER_ID], { requireResolved: false });
  if (fallbackSelection) return fallbackSelection;
  for (const [providerId, entry] of Object.entries(entries)) {
    const selection = buildSelection(providerId, entry, { requireResolved: false });
    if (selection) return selection;
  }
  return null;
}

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "config"]);
const CONFIG_KEYS = new Set(["providerOrder", "providerConfigRules", "modelConfigRules", "defaultModelSelection"]);
const PROVIDER_RULE_KEYS = new Set(["providerId", "templateId", "providerName", "enabled", "config"]);
const PROVIDER_CONFIG_KEYS = new Set([
  "group", "logo", "access", "api", "builtinModelIds", "personalModelIds", "modelOrder", "visibility",
]);
const MODEL_RULE_KEYS = new Set(["providerId", "modelId", "config"]);
const MODEL_RULE_CONFIG_KEYS = new Set(["properties", "optionSpecs", "enabled"]);
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
      if (label === "providerModelRules" && !isNonEmptyString(rule.config.providerId)) {
        // 「enabled」是客户端模型列表里的逐模型开关，由 ZCode 自己写入；
        // 白名单不认它会把整份文件拒写，同步因此卡死。
        const unknown = Object.keys(rule.config).find((k) => !MODEL_RULE_CONFIG_KEYS.has(k));
        if (unknown) return fail(`providerModelRules[${index}].config has unknown key "${unknown}"`);
        if (rule.config.enabled !== undefined && typeof rule.config.enabled !== "boolean") {
          return fail(`providerModelRules[${index}].config.enabled must be a boolean`);
        }
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
 *
 * Unchanged 判定有两层：先比字节哈希（我们产出的形态与客户端写回的一致时直接
 * 短路）；字节不等再做语义比较（忽略 JSON 键序）。第二层是给「客户端规范化
 * 重写」准备的——ZCode 桌面版和 CLI 读取时都会把文件 decode→encode 成自己的
 * canonical 键序（模型规则变成 {modelId, config, providerId}）重写一次，只看
 * 字节会让每次同步都无意义重写+滚备份（乒乓），而客户端的变化检测本身就建立在
 * canonical 内容上（revision = decode→encode 后的哈希），键序差异对它不可见。
 *
 * The unchanged-check → backup → write sequence runs inside the
 * ZCode-compatible directory lock (atomic-write.mjs withDirectoryLock): the
 * running ZCode client rewrites this same file (default model selection,
 * per-model toggles), so the check-and-write must not interleave with it. A
 * lock timeout fails closed — `{ ok: false, unchanged: true }`, nothing
 * written — and the next sync retries.
 */
export function writePersonalConfigWithBackup(filePath, data, { lockWaitMs } = {}) {
  try {
    return withDirectoryLock(
      filePath,
      () => writePersonalConfigWithBackupUnlocked(filePath, data),
      lockWaitMs === undefined ? {} : { waitMs: lockWaitMs },
    );
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      return { ok: false, unchanged: true, reason: error.message };
    }
    throw error;
  }
}

// 语义比较只看 JSON 结构（对象忽略键序，数组保序）；两边都是 JSON.parse 能产
// 生的值，不存在 undefined/function/NaN。
function sameJsonSemantics(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJsonSemantics(item, b[index]))
    );
  }
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return (
      keysA.length === keysB.length &&
      keysA.every((key) => Object.hasOwn(b, key) && sameJsonSemantics(a[key], b[key]))
    );
  }
  return false;
}

// The write itself, for callers already holding the directory lock
// (syncZcodePersonalConfig locks around the whole read → merge → write).
// `existing` is the already-parsed on-disk document when the caller has it,
// saving the semantic check a re-read.
function writePersonalConfigWithBackupUnlocked(filePath, data, existing) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const text = JSON.stringify(data, null, 2);
  const hash = contentHash(text);

  if (existsSync(filePath)) {
    if (contentHash(readFileSync(filePath, "utf8")) === hash) return { ok: true, unchanged: true };
    const onDisk =
      existing !== undefined
        ? existing
        : (() => {
            try {
              return JSON.parse(readFileSync(filePath, "utf8"));
            } catch {
              return undefined;
            }
          })();
    // 客户端规范化重写（canonical 键序）后的内容视为未变更：跳过重写，乒乓止息。
    if (onDisk !== undefined && sameJsonSemantics(onDisk, data)) return { ok: true, unchanged: true };
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
 * a document that would not decode, or a lock the client keeps holding comes
 * back as `{ ok: false }` with the file left exactly as it was, because ZCode
 * falls back to an empty list when this file is unusable — overwriting it with
 * guesses would clear every channel. The whole read → merge → write runs under
 * the directory lock so a defaultModelSelection the client writes cannot land
 * between our read and our write and be silently overwritten.
 *
 * @param {string} configPath path of the injected config.json
 * @param {object} managedEntries { [prefixedProviderId]: config.json provider entry }
 * @param {string[]} previousManaged prefixed ids injected by the last sync；
 *   sidecarPath 传入时该参数被忽略（上一轮记忆改由锁内读 sidecar 得到）
 * @param {object} [defaultModelSelection] CLI 槽位专用：只在文件本身没有
 *   defaultModelSelection 时补进文档（桌面版槽位不传，行为不变）
 * @param {string} [sidecarPath] 与本文件同生死的 sidecar：传入后它的读
 *   （previousManaged 的唯一来源）与写（本轮托管集合的落账）都收进同一把目录
 *   锁——锁外读到的可能是另一轮同步的中间态，锁外落账则可能与文件终态分属两
 *   轮，sidecar 失真会把托管条目当用户条目永久留下。不传则完全不碰 sidecar
 *   （桌面版槽位的 sidecar 归调用方管，行为不变）。
 * @param {string[]} [sidecarManaged] 同步成功后记进 sidecar 的托管 id 集合
 *   （merge-common 形态：config.json 的未前缀 id，加 `_` 前缀才是本文件的规
 *   则 id）；sidecarPath 传入时必传。
 */
export function syncZcodePersonalConfig({ configPath, managedEntries, previousManaged = [], lockWaitMs, defaultModelSelection, sidecarPath, sidecarManaged }) {
  const path = personalConfigPath(configPath);
  try {
    return withDirectoryLock(
      path,
      () => {
        // 上一轮记忆的权威读取在锁内：锁外先读再传参，读到的可能已被另一轮同
        // 步改写（跨进程交错时文件终态与 sidecar 终态分属两轮，正是要堵的洞）。
        const wasManaged = sidecarPath === undefined
          ? previousManaged
          : readSidecar(sidecarPath).providers.map((id) => `_${id}`);
        let existing;
        try {
          existing = readPersonalConfig(path);
        } catch (error) {
          if (error?.code === "UNPARSEABLE_PERSONAL_CONFIG") return { ok: false, unchanged: true, path, reason: error.message };
          throw error;
        }

        const { config, managed } = mergePersonalProviderConfig(
          existing,
          managedEntries,
          wasManaged,
          defaultModelSelection === undefined ? {} : { defaultModelSelection },
        );
        const gate = validatePersonalProviderConfig(config);
        if (!gate.valid) {
          return { ok: false, unchanged: true, path, reason: `zcode provider_config.json would be invalid: ${gate.error}` };
        }

        const written = writePersonalConfigWithBackupUnlocked(path, config, existing ?? undefined);
        // 同步成功才落账 sidecar：失败时保留上一轮记忆，下一轮退役清理才认得出
        // 残留。文件内容未变（unchanged）也照常落账——sidecar 缺的可能正是这一
        // 次（上一轮写完文件后崩在落账前）。
        if (sidecarPath !== undefined) {
          writeSidecar(sidecarPath, sidecarManaged ?? []);
        }
        return { ...written, path, managed };
      },
      lockWaitMs === undefined ? {} : { waitMs: lockWaitMs },
    );
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      return { ok: false, unchanged: true, path, reason: error.message };
    }
    throw error;
  }
}
