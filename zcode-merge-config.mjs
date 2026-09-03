import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { contentHash, atomicWriteFile, pruneBackups } from "./atomic-write.mjs";
import { readSidecar as readSidecarFile, writeSidecar as writeSidecarFile, AUTO_CHANNEL_KEY } from "./merge-common.mjs";
// Shared endpoint-aware derivation of the virtual auto-routing channel
// (merge-common.mjs) — re-exported so the launcher/tests import one module.
export { deriveAutoRouteChannel } from "./merge-common.mjs";
import { fallbackContextWindow } from "./context-fallback.mjs";
import { modalitiesFromStoreModel } from "./modalities-fallback.mjs";

const SIDECAR_FILENAME = "zcode-sidecar.json";

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

export function buildZcodeProviderEntry(providerId, provider, port, token) {
  const prefixedId = `_${providerId}`;
  // Pseudo-channels (auto routing) name a different relay URL segment than
  // their own id; real channels never set baseUrlSegment.
  const segment = provider.baseUrlSegment ?? providerId;
  const baseURL = `http://127.0.0.1:${port}/openai/${encodeURIComponent(segment)}/v1`;
  const models = {};
  for (const [modelId, m] of Object.entries(provider.models ?? {})) {
    const entry = {
      // Real store value (L1 discovery) first; tier map / 1M default only
      // when the upstream never reported one (context-fallback.mjs).
      limit: { context: m.contextWindow ?? fallbackContextWindow(modelId) },
      modalities: modalitiesFromStoreModel(m, modelId),
    };
    if (m.maxOutputTokens !== undefined) {
      entry.limit.output = m.maxOutputTokens;
    }
    models[modelId] = entry;
  }
  return {
    [prefixedId]: {
      name: provider.channelName ?? providerId,
      kind: "openai-compatible",
      options: {
        apiKey: token,
        baseURL,
        apiKeyRequired: true,
      },
      // 显式端点身份：ZCode 请求天然不带 x-agent-id，relay 的 openai 路径
      // 目前把「无头 + 未知 UA」兜底归 zcode（openai-server.mjs
      // openaiAgentIdFrom）。显式声明后，该兜底只接住真正未知的客户端，
      // 任何端点流量静默串入 zcode 指标的问题就此闭环。
      headers: { "x-agent-id": "zcode" },
      source: "custom",
      models,
    },
  };
}

export function mergeZcodeConfig(existing, managedProviders, port, token, previousManaged = [], autoChannel = null) {
  const merged = { ...existing, provider: { ...(existing.provider ?? {}) } };
  const currentManaged = [];
  // Append the virtual auto-routing channel outside the entry-builder system:
  // it flows through the same cleanup/inject loops as any real channel, so
  // deleting the endpoint's chain makes the next sync drop `_auto` via the
  // ordinary previousManaged path.
  const providers = autoChannel ? { ...managedProviders, [AUTO_CHANNEL_KEY]: autoChannel } : managedProviders;

  for (const prevId of previousManaged) {
    const prefixed = `_${prevId}`;
    if (!providers[prevId] && merged.provider[prefixed] !== undefined) {
      delete merged.provider[prefixed];
    }
  }

  for (const [providerId, provider] of Object.entries(providers)) {
    const entry = buildZcodeProviderEntry(providerId, provider, port, token);
    Object.assign(merged.provider, entry);
    currentManaged.push(providerId);
  }

  return { config: merged, managed: currentManaged };
}

export class UnparseableConfigError extends Error {
  constructor(filePath) {
    super(`refusing to overwrite unparseable zcode config: ${filePath}`);
    this.name = "UnparseableConfigError";
    this.code = "UNPARSEABLE_CONFIG";
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readZcodeConfig(filePath) {
  if (!existsSync(filePath)) return { provider: {} };
  try {
    return JSON.parse(stripBom(readFileSync(filePath, "utf8")));
  } catch {
    // Fail closed: a config we cannot parse must never be treated as empty
    // and then overwritten, or the user's entire config would be lost.
    throw new UnparseableConfigError(filePath);
  }
}

export function writeZcodeConfigWithBackup(filePath, data) {
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
    backupPath = join(dir, `config.backup.${timestamp()}.json`);
    copyFileSync(filePath, backupPath);
  }

  atomicWriteFile(filePath, text);
  // Trim to the newest 5 backups: unbounded retention had already piled up
  // 233 token-bearing config copies in ~/.zcode/v2.
  pruneBackups(dir, "config.backup.");
  return { ok: true, unchanged: false, backupPath };
}

export { extractManagedProviders } from "./pool-providers.mjs";

export function validateZcodeConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, error: "config must be a non-null object" };
  }
  if (!config.provider || typeof config.provider !== "object" || Array.isArray(config.provider)) {
    return { valid: false, error: "config must have a 'provider' object" };
  }
  for (const [providerId, provider] of Object.entries(config.provider)) {
    if (typeof provider !== "object" || provider === null) {
      return { valid: false, error: `provider "${providerId}" must be a non-null object` };
    }
    if (typeof provider.kind !== "string") {
      return { valid: false, error: `provider "${providerId}" must have a 'kind' string` };
    }
    if (provider.models !== undefined) {
      if (typeof provider.models !== "object" || Array.isArray(provider.models)) {
        return { valid: false, error: `provider "${providerId}" models must be an object` };
      }
    }
  }
  return { valid: true };
}
