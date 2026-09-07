// Qoder settings.json merge — writes Anyswitch store providers into
// modelConfigs.customModels so Qoder's BYOK (Bring Your Own Key) feature
// routes through the Anyswitch relay.
//
// Qoder's BYOK is per-model: each entry in customModels is a single
// provider+model pair, not a provider with a model list. The merge strategy
// replaces the entire customModels array with managed entries (tracked by
// sidecar), preserving all other settings.json fields untouched.

import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { contentHash, atomicWriteFile, pruneBackups } from "./atomic-write.mjs";
import { readSidecar as readSidecarFile, writeSidecar as writeSidecarFile, AUTO_CHANNEL_KEY, deriveAutoRouteChannel } from "./merge-common.mjs";
// Re-exported so the launcher/tests import one module.
export { deriveAutoRouteChannel } from "./merge-common.mjs";
import { fallbackContextWindow } from "./context-fallback.mjs";
import { extractManagedProviders } from "./pool-providers.mjs";

const SIDECAR_FILENAME = "qoder-sidecar.json";

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

// Build one customModels entry for a single provider+model pair.
// Qoder's BYOK schema: each entry is a flat object with provider, apiKey,
// model, key, displayName, baseURL, format, maxInputTokens.
function buildQoderModelEntry(providerId, modelId, model, port, token, provider) {
  // Pseudo-channels (auto routing) name a different relay URL segment than
  // their own id; real channels never set baseUrlSegment.
  const segment = provider?.baseUrlSegment ?? providerId;
  const baseURL = `http://127.0.0.1:${port}/openai/${encodeURIComponent(segment)}/v1`;
  const context = model.contextWindow ?? fallbackContextWindow(modelId);
  const displayName = model.displayName ?? modelId;
  return {
    provider: `_${providerId}`,
    apiKey: token,
    model: modelId,
    key: `_${providerId}/${modelId}`,
    displayName,
    baseURL,
    format: "openai",
    maxInputTokens: Number(context),
  };
}

// Build the full managed customModels array from the managed providers map.
// Each provider contributes one entry per model. The auto channel contributes
// a single entry with model "auto".
export function buildQoderCustomModels(managedProviders, port, token) {
  const entries = [];
  for (const [providerId, provider] of Object.entries(managedProviders)) {
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      entries.push(buildQoderModelEntry(providerId, modelId, model, port, token, provider));
    }
  }
  return entries;
}

// Merge managed providers into the settings.json object.
// Replaces modelConfigs.customModels entirely with managed entries.
// All other settings.json fields are preserved untouched.
export function mergeQoderSettings(existing, managedProviders, port, token, autoChannel = null) {
  const settings = typeof existing === "object" && existing !== null ? { ...existing } : {};
  // Append the virtual auto-routing channel outside the entry-builder system:
  // it flows through the same cleanup/inject loops as any real channel, so
  // deleting the endpoint's chain makes the next sync drop `_auto` via the
  // ordinary previousManaged path.
  const providers = autoChannel ? { ...managedProviders, [AUTO_CHANNEL_KEY]: autoChannel } : managedProviders;

  const customModels = buildQoderCustomModels(providers, port, token);
  const currentManaged = Object.keys(providers);

  const modelConfigs = { ...(settings.modelConfigs ?? {}) };
  modelConfigs.customModels = customModels;
  settings.modelConfigs = modelConfigs;

  return { config: settings, managed: currentManaged };
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
  if (Object.keys(managedProviders).length === 0 && !autoChannel) {
    return { ok: true, unchanged: true, reason: "no Anyswitch providers with models" };
  }
  const previousManaged = readSidecar(sidecarRoot).providers;
  let existing;
  try {
    existing = readQoderSettings(settingsPath);
  } catch (error) {
    if (error?.code === "UNPARSEABLE_QODER_SETTINGS") {
      return { ok: false, unchanged: true, reason: error.message };
    }
    throw error;
  }
  const { config, managed } = mergeQoderSettings(existing, managedProviders, port, token, autoChannel);

  const writeResult = writeQoderSettingsWithBackup(settingsPath, config);
  if (writeResult.ok) {
    writeSidecar(sidecarRoot, managed);
  }
  return writeResult;
}
