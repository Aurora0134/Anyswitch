// Qoder settings.json merge — writes Anyswitch store providers into the
// settings.json `providers` map so Qoder's BYOK (Bring Your Own Key) feature
// routes through the Anyswitch relay.
//
// Why `providers` and not `modelConfigs.customModels`: Qoder 0.2.x persists
// BYOK custom-endpoint connections in settings.json under `providers`
// (keyed by a "qoder-custom-…" connection id). The older
// `modelConfigs.customModels` array is no longer read by the main process at
// all — it is dead data. The daemon loads `providers` on cold start and the
// model picker lists them under the "自定义" (custom) category.
//
// One Anyswitch provider becomes ONE custom-endpoint connection whose `models`
// array is that provider's whole model list. The connection baseUrl points at
// the local Anyswitch relay; apiKey is the relay token. Injection is
// idempotent: managed connection ids carry a deterministic
// "qoder-custom-anyswitch-<hash>" suffix derived from the Anyswitch provider
// id, and a sync deletes the previously-managed set before writing the current
// one, so removed providers/chains drop out on the next sync.

import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { contentHash, atomicWriteFile, pruneBackups } from "./atomic-write.mjs";
import { readSidecar as readSidecarFile, writeSidecar as writeSidecarFile, AUTO_CHANNEL_KEY, deriveAutoRouteChannel } from "./merge-common.mjs";
// Re-exported so the launcher/tests import one module.
export { deriveAutoRouteChannel } from "./merge-common.mjs";
import { fallbackContextWindow } from "./context-fallback.mjs";
import { extractManagedProviders } from "./pool-providers.mjs";
import { buildAgentPrefixedSegment } from "./openai-path.mjs";

const SIDECAR_FILENAME = "qoder-sidecar.json";
const MANAGED_PREFIX = "qoder-custom-anyswitch-";
const MAX_MODELS_PER_CONNECTION = 32;
// relay 认这个端点时用的 id，也是 URL 身份前缀的字面值（须与 store-schema 的
// ROUTING_ENDPOINT_IDS 成员一致，relay 侧按 x-agent-id 同一条白名单校验）。
const QODER_AGENT_ID = "qoder";

export function sidecarPath(root) {
  return join(root, SIDECAR_FILENAME);
}

// Sidecar storage is shared (merge-common.mjs); only the filename is
// module-specific.
export function readSidecar(root) {
  return readSidecarFile(sidecarPath(root));
}

export function writeSidecar(root, providerIds) {
  writeSidecarFile(sidecarPath(root), providerIds);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export { extractManagedProviders } from "./pool-providers.mjs";

// Resolve the Qoder settings.json path from a base directory (USERPROFILE).
export function qoderSettingsPath(base) {
  return join(base, ".qoder", "settings.json");
}

// Deterministic managed connection id for an Anyswitch provider id, so a sync
// can find and replace exactly the connections it owns without touching
// user-created BYOK entries.
export function managedConnectionId(providerId) {
  const digest = createHash("sha256").update(providerId, "utf8").digest("hex").slice(0, 16);
  return `${MANAGED_PREFIX}${digest}`;
}

// Build one model entry in Qoder's `providers[].models[]` shape.
function buildModelEntry(modelId, model) {
  const context = Number(model.contextWindow ?? fallbackContextWindow(modelId));
  const isReasoning = model.isReasoning === true;
  return {
    model: modelId,
    displayName: model.displayName ?? modelId,
    contextWindow: context,
    capabilities: {
      vision: model.isVision === true,
      thinking: {
        modes: isReasoning ? ["enabled"] : [],
        supportsEffort: false,
        supportedEffortLevels: [],
      },
    },
  };
}

// Build one custom-endpoint connection for a single Anyswitch provider.
// Pseudo-channels (auto routing) name a different relay URL segment than their
// own id; real channels never set baseUrlSegment.
function buildConnection(providerId, provider, port, token) {
  const segment = provider?.baseUrlSegment ?? providerId;
  // 身份前缀 `qoder~`：Qoder 的 provider 配置放不进自定义请求头、UA 里也没有自家
  // 标识，relay 原本的三条认端点通道（x-agent-id / UA / 兜底）对它全部落空，请求
  // 一律记成 zcode——看板 Qoder 卡恒 0 请求，zcode 指标被反向污染。URL 段本来就是我
  // 们自己写的，那就把身份写进 URL。relay 侧按 '~' 剥离后再查 store（语法见
  // openai-path），渠道查找/404 文案/stats 用的都是剥离后的真实 id。
  // 连接 id 仍由真实 providerId 派生（managedConnectionId 不经这里），所以加前缀
  // 不会让 sidecar 托管集漂移，旧条目照常被下一轮 sync 精确替换。
  const baseUrl = `http://127.0.0.1:${port}/openai/${buildAgentPrefixedSegment(QODER_AGENT_ID, segment)}/v1`;
  const models = Object.entries(provider.models ?? {})
    .slice(0, MAX_MODELS_PER_CONNECTION)
    .map(([modelId, model]) => buildModelEntry(modelId, model));
  const displayName = provider?.channelName ?? provider?.displayName ?? providerId;
  return {
    baseUrl,
    apiKey: token,
    type: "openai-compatible",
    protocol: "openai",
    authType: "bearer",
    displayName,
    model: models[0]?.model,
    models,
  };
}

// Build the full managed `providers` map from the managed providers map.
// Keys are the deterministic managed connection ids.
export function buildQoderProviders(managedProviders, port, token) {
  const providers = {};
  for (const [providerId, provider] of Object.entries(managedProviders)) {
    const connection = buildConnection(providerId, provider, port, token);
    if (connection.models.length === 0) continue;
    providers[managedConnectionId(providerId)] = connection;
  }
  return providers;
}

// Merge managed providers into the settings.json object.
// Replaces the managed subset of `providers` (tracked by sidecar) and removes
// the dead `modelConfigs.customModels` array. All other settings.json fields
// are preserved untouched, including user-created `providers` entries.
export function mergeQoderSettings(existing, managedProviders, port, token, previousManagedIds = [], autoChannel = null) {
  const settings = typeof existing === "object" && existing !== null ? { ...existing } : {};
  // Append the virtual auto-routing channel outside the entry-builder system:
  // it flows through the same cleanup/inject loops as any real channel, so
  // deleting the endpoint's chain makes the next sync drop it via the ordinary
  // previousManaged path.
  const providers = autoChannel ? { ...managedProviders, [AUTO_CHANNEL_KEY]: autoChannel } : managedProviders;

  const managedMap = buildQoderProviders(providers, port, token);
  const currentManagedIds = Object.keys(providers).map(managedConnectionId);

  // Start from the user's own providers, drop previously-managed connections,
  // then layer the current managed set on top.
  const existingProviders = { ...(settings.providers ?? {}) };
  for (const id of previousManagedIds) delete existingProviders[id];
  for (const id of currentManagedIds) delete existingProviders[id];
  settings.providers = { ...existingProviders, ...managedMap };

  // Remove the dead customModels array Qoder 0.2.x no longer reads.
  if (settings.modelConfigs && typeof settings.modelConfigs === "object") {
    const modelConfigs = { ...settings.modelConfigs };
    delete modelConfigs.customModels;
    if (Object.keys(modelConfigs).length === 0) {
      delete settings.modelConfigs;
    } else {
      settings.modelConfigs = modelConfigs;
    }
  }

  return { config: settings, managed: Object.keys(providers) };
}

export class UnparseableQoderSettingsError extends Error {
  constructor(filePath) {
    super(`refusing to overwrite unparseable qoder settings: ${filePath}`);
    this.name = "UnparseableQoderSettingsError";
    this.code = "UNPARSEABLE_QODER_SETTINGS";
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readQoderSettings(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(stripBom(readFileSync(filePath, "utf8")));
  } catch {
    // Fail closed: a config we cannot parse must never be treated as empty
    // and then overwritten, or the user's entire settings would be lost.
    throw new UnparseableQoderSettingsError(filePath);
  }
}

export function writeQoderSettingsWithBackup(filePath, data) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const text = JSON.stringify(data, null, 2) + "\n";
  const hash = contentHash(text);

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf8");
    if (contentHash(existing) === hash) return { ok: true, unchanged: true };
  }

  let backupPath;
  if (existsSync(filePath)) {
    backupPath = join(dir, `settings.backup.${timestamp()}.json`);
    copyFileSync(filePath, backupPath);
  }

  atomicWriteFile(filePath, text);
  // Trim to the newest 5 backups: unbounded retention accumulates
  // token-bearing settings copies on disk.
  pruneBackups(dir, "settings.backup.");
  return { ok: true, unchanged: false, backupPath };
}

// High-level write: read existing settings, merge managed providers, write
// back with backup. Returns { ok, unchanged, backupPath?, reason? }.
export function writeQoderConfig(store, port, token, sidecarRoot, settingsPath) {
  const managedProviders = extractManagedProviders(store);
  const autoChannel = deriveAutoRouteChannel(store, "qoder");
  const previousManaged = readSidecar(sidecarRoot).providers;
  if (Object.keys(managedProviders).length === 0 && !autoChannel && previousManaged.length === 0) {
    return { ok: true, unchanged: true, reason: "no Anyswitch providers with models" };
  }
  let existing;
  try {
    existing = readQoderSettings(settingsPath);
  } catch (error) {
    if (error?.code === "UNPARSEABLE_QODER_SETTINGS") {
      return { ok: false, unchanged: true, reason: error.message };
    }
    throw error;
  }
  const previousManagedIds = previousManaged.map(managedConnectionId);
  const { config, managed } = mergeQoderSettings(existing, managedProviders, port, token, previousManagedIds, autoChannel);

  const writeResult = writeQoderSettingsWithBackup(settingsPath, config);
  if (writeResult.ok) {
    writeSidecar(sidecarRoot, managed);
  }
  return writeResult;
}
