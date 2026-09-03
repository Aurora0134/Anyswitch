import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { contentHash, atomicWriteFile, pruneBackups } from "./atomic-write.mjs";
import { readSidecar as readSidecarFile, writeSidecar as writeSidecarFile, AUTO_CHANNEL_KEY } from "./merge-common.mjs";
// Shared endpoint-aware derivation of the virtual auto-routing channel
// (merge-common.mjs) — re-exported so the launcher/tests import one module.
export { deriveAutoRouteChannel } from "./merge-common.mjs";
// Single shared implementation (pool-providers.mjs) — the merge modules must
// never carry their own catalog semantics again.
export { extractManagedProviders } from "./pool-providers.mjs";

const SIDECAR_FILENAME = "pi-sidecar.json";

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

export function buildPiProviderEntry(providerId, provider, port) {
  const prefixedId = `_${providerId}`;
  // Pseudo-channels (auto routing) name a different relay URL segment than
  // their own id; real channels never set baseUrlSegment.
  const segment = provider.baseUrlSegment ?? providerId;
  const baseUrl = `http://127.0.0.1:${port}/openai/${encodeURIComponent(segment)}/v1`;
  const models = Object.keys(provider.models ?? {}).map((modelId) => {
    const m = { id: modelId };
    const sm = provider.models[modelId];
    if (sm?.displayName) m.name = sm.displayName;
    if (sm?.contextWindow !== undefined) m.contextWindow = sm.contextWindow;
    if (sm?.maxOutputTokens !== undefined) m.maxTokens = sm.maxOutputTokens;
    return m;
  });
  return {
    [prefixedId]: {
      name: provider.channelName ?? providerId,
      baseUrl,
      apiKey: "${ANYSWITCH_RELAY_TOKEN}",
      api: "openai-completions",
      // Tag all Pi-managed providers so the relay can route their requests to
      // the Pi metrics bucket instead of the default ZCode bucket. The
      // x-agent-instance placeholder stays literal on disk — the pi CLI
      // expands ${VAR} in header values at runtime (same mechanism as apiKey)
      // from ANYSWITCH_INSTANCE_ID, which the launcher always sets.
      headers: { "x-agent-id": "pi", "x-agent-instance": "${ANYSWITCH_INSTANCE_ID}" },
      models,
    },
  };
}

export function mergeModelsJson(existing, managedProviders, port, previousManaged = [], autoChannel = null) {
  const merged = { ...existing, providers: { ...(existing.providers ?? {}) } };
  const currentManaged = [];
  // Append the virtual auto-routing channel outside the entry-builder system:
  // it flows through the same cleanup/inject loops as any real channel, so
  // deleting the endpoint's chain makes the next sync drop `_auto` via the
  // ordinary previousManaged path.
  const providers = autoChannel ? { ...managedProviders, [AUTO_CHANNEL_KEY]: autoChannel } : managedProviders;

  for (const prevId of previousManaged) {
    const prefixed = `_${prevId}`;
    if (!providers[prevId] && merged.providers[prefixed] !== undefined) {
      delete merged.providers[prefixed];
    }
  }

  for (const [providerId, provider] of Object.entries(providers)) {
    const entry = buildPiProviderEntry(providerId, provider, port);
    Object.assign(merged.providers, entry);
    currentManaged.push(providerId);
  }

  return { config: merged, managed: currentManaged };
}

export class UnparseableModelsError extends Error {
  constructor(filePath) {
    super(`refusing to overwrite unparseable pi models.json: ${filePath}`);
    this.name = "UnparseableModelsError";
    this.code = "UNPARSEABLE_MODELS";
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readModelsJson(filePath) {
  if (!existsSync(filePath)) return { providers: {} };
  try {
    return JSON.parse(stripBom(readFileSync(filePath, "utf8")));
  } catch {
    // Fail closed: a config we cannot parse must never be treated as empty
    // and then overwritten, or the user's entire config would be lost.
    throw new UnparseableModelsError(filePath);
  }
}

export function writeModelsJsonWithBackup(filePath, data) {
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
    backupPath = join(dir, `models.backup.${timestamp()}.json`);
    copyFileSync(filePath, backupPath);
  }

  atomicWriteFile(filePath, text);
  // Trim to the newest 5 backups. The prefix is exactly "models.backup." so
  // pi's own models-store.backup.* files in the same directory are never
  // touched (a loose "models.backup"-style match would risk catching them).
  pruneBackups(dir, "models.backup.");
  return { ok: true, unchanged: false, backupPath };
}

export function validatePiModelsConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, error: "config must be a non-null object" };
  }
  if (!config.providers || typeof config.providers !== "object" || Array.isArray(config.providers)) {
    return { valid: false, error: "config must have a 'providers' object" };
  }
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (typeof provider !== "object" || provider === null) {
      return { valid: false, error: `provider "${providerId}" must be a non-null object` };
    }
    if (provider.models && Array.isArray(provider.models)) {
      for (let i = 0; i < provider.models.length; i++) {
        const m = provider.models[i];
        if (typeof m !== "object" || m === null) {
          return { valid: false, error: `provider "${providerId}" models[${i}] must be an object` };
        }
        if (typeof m.id !== "string" || m.id.length === 0) {
          return { valid: false, error: `provider "${providerId}" models[${i}] must have a non-empty 'id'` };
        }
      }
    }
  }
  return { valid: true };
}