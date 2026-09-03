import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { contentHash, atomicWriteFile, pruneBackups } from "./atomic-write.mjs";
import { readSidecar as readSidecarFile, writeSidecar as writeSidecarFile, AUTO_CHANNEL_KEY } from "./merge-common.mjs";
// Shared endpoint-aware derivation of the virtual auto-routing channel
// (merge-common.mjs) — re-exported so the launcher/tests import one module.
export { deriveAutoRouteChannel } from "./merge-common.mjs";
import { fallbackContextWindow } from "./context-fallback.mjs";
import { loadPiAiReasoningIndex, resolveKnowledgeReasoning } from "./reasoning-fallback.mjs";

const SIDECAR_FILENAME = "dsh-sidecar.json";

function resolveYamlModule() {
  const dshYaml = join(
    process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming"),
    "npm",
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "node_modules",
    "js-yaml",
  );
  if (existsSync(dshYaml)) {
    return dshYaml;
  }
  return "js-yaml";
}

let cachedYaml = null;
export async function getYamlModule() {
  if (!cachedYaml) {
    const modPath = resolveYamlModule();
    try {
      cachedYaml = await import(modPath);
    } catch {
      // Fallback in case of CJS export wrapper
      cachedYaml = (await import("node:module")).createRequire(import.meta.url)(modPath);
    }
  }
  return cachedYaml.default ?? cachedYaml;
}

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

export function resolveModelReasoningLevels(model, provider, knowledge) {
  if (model?.supportsReasoning === false) {
    return { exempt: true, levels: null, wireValues: null, thinkingFormat: null };
  }
  if (Array.isArray(model?.reasoningEffortLevels) && model.reasoningEffortLevels.length > 0) {
    return { exempt: false, levels: model.reasoningEffortLevels, wireValues: null, thinkingFormat: null };
  }
  if (Array.isArray(provider?.reasoningVariants) && provider.reasoningVariants.length > 0) {
    return { exempt: false, levels: provider.reasoningVariants, wireValues: null, thinkingFormat: null };
  }
  // Tier 4: the pi-ai knowledge base entry for this model id — the same
  // database DSH's own dispatch reads, so wire spellings match exactly.
  // Gateway-prefixed ids ("go/mimo-v2.5-pro") fall back to the bare last
  // segment, which is how the vendor's own entry is indexed.
  if (knowledge) {
    const id = modelIdOf(model);
    const bare = typeof id === "string" && id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : null;
    const resolved =
      resolveKnowledgeReasoning(knowledge.get(id)) ??
      (bare !== id ? resolveKnowledgeReasoning(knowledge.get(bare)) : null);
    if (resolved) {
      return { exempt: false, levels: resolved.levels, wireValues: resolved.wireValues, thinkingFormat: resolved.thinkingFormat };
    }
  }
  return { exempt: false, levels: null, wireValues: null, thinkingFormat: null };
}

function modelIdOf(model) {
  return typeof model?.id === "string" ? model.id : null;
}

export function buildReasoningEffortsMap(levels, wireValues) {
  if (!levels || !Array.isArray(levels) || levels.length === 0) return undefined;
  const map = { off: null };
  for (const lvl of levels) {
    if (typeof lvl === "string" && lvl.length > 0) {
      // Wire values from the knowledge base win: they are what pi-ai's
      // dispatch would send for this exact level (e.g. DSH "low" is zai
      // "high"). Store-declared levels send the level verbatim.
      const wire = wireValues?.[lvl];
      map[lvl] = typeof wire === "string" && wire.length > 0 ? wire : lvl;
    }
  }
  return map;
}

export function buildDshProviderEntry(providerId, provider, port, knowledge) {
  const prefixedId = `_${providerId}`;
  // Pseudo-channels (auto routing) name a different relay URL segment than
  // their own id; real channels never set baseUrlSegment.
  const segment = provider.baseUrlSegment ?? providerId;
  const baseURL = `http://127.0.0.1:${port}/openai/${encodeURIComponent(segment)}/v1`;
  const models = [];

  let hasAnyReasoning = false;
  let providerThinkingFormat = null;
  for (const [modelId, m] of Object.entries(provider.models ?? {})) {
    const entry = {
      id: modelId,
      name: m.displayName ?? modelId,
      contextWindow: m.contextWindow ?? fallbackContextWindow(modelId),
    };
    if (m.maxOutputTokens !== undefined) {
      entry.maxTokens = m.maxOutputTokens;
    }

    const resolved = resolveModelReasoningLevels({ ...m, id: modelId }, provider, knowledge);
    if (!resolved.exempt && resolved.levels && resolved.levels.length > 0) {
      const reasoningEfforts = buildReasoningEffortsMap(resolved.levels, resolved.wireValues);
      if (reasoningEfforts) {
        entry.reasoningEfforts = reasoningEfforts;
        hasAnyReasoning = true;
        // Per-model wire format from the knowledge base (zai/deepseek/openai
        // …). A route-level format only makes sense when every reasoning
        // model on the route agrees on one; mixed routes stay format-free
        // (plain reasoning_effort) unless each model names its own.
        if (resolved.thinkingFormat) {
          entry.compat = { thinkingFormat: resolved.thinkingFormat };
          providerThinkingFormat = providerThinkingFormat === null ? resolved.thinkingFormat : providerThinkingFormat;
        }
      }
    }

    models.push(entry);
  }

  const profile = {
    displayName: provider.channelName ?? providerId,
    api: "openai-completions",
    baseURL,
    apiKeyEnv: "APICRED_RELAY_TOKEN",
    headers: {
      "x-agent-id": "dsh",
    },
    models,
  };

  if (hasAnyReasoning) {
    profile.compat = {
      thinkingFormat: providerThinkingFormat ?? "deepseek",
      supportsReasoningEffort: true,
    };
  }

  return {
    [prefixedId]: profile,
  };
}

export function mergeDshSettings(existingSettings, apiCredProviders, port, previousManaged = [], knowledge = null, autoChannel = null) {
  const settings = typeof existingSettings === "object" && existingSettings !== null ? { ...existingSettings } : {};
  const llmPiAi = { ...(settings["llm-pi-ai"] ?? {}) };
  const existingProviders = { ...(llmPiAi.providers ?? {}) };
  // Append the virtual auto-routing channel outside the entry-builder system:
  // it flows through the same cleanup/inject loops as any real channel, so
  // deleting the endpoint's chain makes the next sync drop `_auto` via the
  // ordinary previousManaged path.
  const providers = autoChannel ? { ...apiCredProviders, [AUTO_CHANNEL_KEY]: autoChannel } : apiCredProviders;

  // 1. Clean up stale managed providers
  for (const prevId of previousManaged) {
    const prefixed = `_${prevId}`;
    if (!providers[prevId] && existingProviders[prefixed] !== undefined) {
      delete existingProviders[prefixed];
    }
  }

  // 2. Inject current active providers
  const currentManaged = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    const entry = buildDshProviderEntry(providerId, provider, port, knowledge);
    Object.assign(existingProviders, entry);
    currentManaged.push(providerId);
  }

  llmPiAi.providers = existingProviders;
  settings["llm-pi-ai"] = llmPiAi;

  return { config: settings, managed: currentManaged };
}

export class UnparseableDshSettingsError extends Error {
  constructor(filePath) {
    super(`refusing to overwrite unparseable dsh settings: ${filePath}`);
    this.name = "UnparseableDshSettingsError";
    this.code = "UNPARSEABLE_DSH_SETTINGS";
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readDshSettings(filePath, yaml) {
  if (!existsSync(filePath)) return {};
  try {
    const text = stripBom(readFileSync(filePath, "utf8"));
    const parsed = yaml.load(text);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    throw new UnparseableDshSettingsError(filePath);
  }
}

export function writeDshSettingsWithBackup(filePath, data, yaml) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const text = yaml.dump(data, { indent: 2, lineWidth: -1, noRefs: true });
  const hash = contentHash(text);

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf8");
    if (contentHash(existing) === hash) return { ok: true, unchanged: true };
  }

  let backupPath;
  if (existsSync(filePath)) {
    backupPath = join(dir, `settings.backup.${timestamp()}.yaml`);
    copyFileSync(filePath, backupPath);
  }

  atomicWriteFile(filePath, text);
  // Trim to the newest 5 backups: unbounded retention accumulates
  // token-bearing settings copies on disk.
  pruneBackups(dir, "settings.backup.");
  return { ok: true, unchanged: false, backupPath };
}

export { extractApiCredProviders } from "./pool-providers.mjs";

export function validateDshSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return { valid: false, error: "settings must be a non-null object" };
  }
  const llmPiAi = settings["llm-pi-ai"];
  if (llmPiAi !== undefined) {
    if (typeof llmPiAi !== "object" || llmPiAi === null || Array.isArray(llmPiAi)) {
      return { valid: false, error: "'llm-pi-ai' must be an object" };
    }
    if (llmPiAi.providers !== undefined) {
      if (typeof llmPiAi.providers !== "object" || llmPiAi.providers === null || Array.isArray(llmPiAi.providers)) {
        return { valid: false, error: "'llm-pi-ai.providers' must be an object" };
      }
      for (const [pId, p] of Object.entries(llmPiAi.providers)) {
        if (typeof p !== "object" || p === null) {
          return { valid: false, error: `provider "${pId}" must be an object` };
        }
        if (typeof p.baseURL !== "string" || p.baseURL.length === 0) {
          return { valid: false, error: `provider "${pId}" must have a non-empty baseURL` };
        }
        if (typeof p.api !== "string" || p.api.length === 0) {
          return { valid: false, error: `provider "${pId}" must have a non-empty api` };
        }
        if (!Array.isArray(p.models) || p.models.length === 0) {
          return { valid: false, error: `provider "${pId}" must have a non-empty models array` };
        }
      }
    }
  }
  return { valid: true };
}
