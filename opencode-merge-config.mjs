// OpenCode config merge (opencode.json) — the fully external injection path
// that retired the ~/.config/opencode/plugins/apicred plugin (2026-09-15).
//
// OpenCode MERGES opencode.json + opencode.jsonc from the same directory
// (verified against the real 1.18.30 binary: providers from both files are
// listed side by side), so the managed block lives in the plain-JSON
// opencode.json — a wholesale-managed file — and the user's hand-written
// opencode.jsonc (permissions, theme, plugin lines) is never touched.
//
// Managed provider ids are written WITHOUT any prefix (unlike zcode's "_"
// namespacing): OpenCode model references are "provider/model" and existing
// scripts/muscle memory point at raw store ids. Collision discipline instead
// comes from the sidecar, exactly as in the other merge modules: entries are
// rebuilt wholesale for current managed ids, and an id is only ever DELETED
// when it appeared in the previous sync's managed list — a user-defined
// provider that was never managed is left alone.
//
// apiKey is an opencode `{file:<abs path>}` reference to the relay token file
// (verified: the reference is expanded into the outbound Authorization
// header). Nothing secret lands in opencode.json, token rotation needs no
// re-sync, and the reference form reads as non-literal to credential audits.
//
// Instance tags ride the config too, plugin-free: the header value
// `{env:ANYSWITCH_AGENT_INSTANCE}` is expanded per process (verified), so a
// launcher-started OpenCode sends its per-launch id while a directly started
// one sends an empty header — which the relay's sanitizeInstanceId drops,
// falling through to the socket-pid fallback exactly as before.

import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { contentHash, atomicWriteFile, pruneBackups } from "./atomic-write.mjs";
import { readSidecar as readSidecarFile, writeSidecar as writeSidecarFile, AUTO_CHANNEL_KEY } from "./merge-common.mjs";
// Shared endpoint-aware derivation of the virtual auto-routing channel
// (merge-common.mjs) — re-exported so the launcher/tests import one module.
export { deriveAutoRouteChannel } from "./merge-common.mjs";
import { resolveEndpointEfforts, effortWireValue } from "./effort-catalog.mjs";

const SIDECAR_FILENAME = "opencode-sidecar.json";

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

// The `{file:...}` operand for options.apiKey. Forward slashes only: opencode
// expands the reference verbatim into a path, and backslashes inside a JSON
// string would have to be escaped pairs — the slash form is unambiguous on
// Windows and matches what the expansion was verified with.
export function relayTokenFileRef(root) {
  return `{file:${join(root, "pi-relay-token").replace(/\\/g, "/")}}`;
}

export function buildOpencodeProviderEntry(providerId, provider, port, tokenFileRef, catalog = null) {
  // Pseudo-channels (auto routing) name a different relay URL segment than
  // their own id; real channels never set baseUrlSegment.
  const segment = provider.baseUrlSegment ?? providerId;
  const baseURL = `http://127.0.0.1:${port}/openai/${encodeURIComponent(segment)}/v1`;
  const models = {};
  for (const [modelId, m] of Object.entries(provider.models ?? {})) {
    const displayName =
      typeof m?.displayName === "string" && m.displayName.trim() !== "" ? m.displayName : modelId;
    const entry = { name: displayName };
    if (catalog && m?.supportsReasoning !== false) {
      // opencode renders `variants` verbatim as its reasoning picker (same
      // contract as zcode), so no vocabulary clipping applies — the shared
      // resolver passes levels through for the "opencode" agent key.
      const efforts = resolveEndpointEfforts(modelId, { catalog, agent: "opencode", model: m, provider });
      if (efforts) {
        const variants = {};
        for (const level of efforts.levels) {
          // An "off" variant is only offered with an explicit usable wire
          // value (the retired plugin's rule): without one the model cannot
          // be switched off from here, so no half-working off entry.
          if (level === "off") {
            const offWire = efforts.wire?.off;
            if (typeof offWire !== "string" || offWire.length === 0) continue;
          }
          variants[level] = { reasoningEffort: effortWireValue(efforts, level) };
        }
        if (Object.keys(variants).length > 0) entry.variants = variants;
      }
    }
    models[modelId] = entry;
  }
  return {
    [providerId]: {
      npm: "@ai-sdk/openai-compatible",
      name: provider.channelName ?? provider.displayName ?? providerId,
      options: {
        baseURL,
        apiKey: tokenFileRef,
        // 显式端点身份（x-agent-id）+ 每进程实例标签（{env:} 引用，由
        // launcher 导出的 ANYSWITCH_AGENT_INSTANCE 在 opencode 进程内展开）。
        headers: { "x-agent-id": "opencode", "x-agent-instance": "{env:ANYSWITCH_AGENT_INSTANCE}" },
      },
      models,
    },
  };
}

export function mergeOpencodeConfig(existing, managedProviders, port, tokenFileRef, previousManaged = [], autoChannel = null, catalog = null) {
  const merged = { ...existing, provider: { ...(existing.provider ?? {}) } };
  const currentManaged = [];
  // The virtual auto-routing channel flows through the same cleanup/inject
  // loops as any real channel: deleting the endpoint's chain (or disabling
  // it) makes the next sync drop "auto" via the ordinary previousManaged path.
  const providers = autoChannel ? { ...managedProviders, [AUTO_CHANNEL_KEY]: autoChannel } : managedProviders;

  for (const prevId of previousManaged) {
    if (!providers[prevId] && merged.provider[prevId] !== undefined) {
      delete merged.provider[prevId];
    }
  }

  for (const [providerId, provider] of Object.entries(providers)) {
    Object.assign(merged.provider, buildOpencodeProviderEntry(providerId, provider, port, tokenFileRef, catalog));
    currentManaged.push(providerId);
  }

  return { config: merged, managed: currentManaged };
}

export class UnparseableConfigError extends Error {
  constructor(filePath) {
    super(`refusing to overwrite unparseable opencode config: ${filePath}`);
    this.name = "UnparseableConfigError";
    this.code = "UNPARSEABLE_CONFIG";
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readOpencodeConfig(filePath) {
  if (!existsSync(filePath)) return { provider: {} };
  try {
    return JSON.parse(stripBom(readFileSync(filePath, "utf8")));
  } catch {
    // Fail closed: a config we cannot parse must never be treated as empty
    // and then overwritten, or the user's entire config would be lost.
    throw new UnparseableConfigError(filePath);
  }
}

export function writeOpencodeConfigWithBackup(filePath, data) {
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
    backupPath = join(dir, `opencode.backup.${timestamp()}.json`);
    copyFileSync(filePath, backupPath);
  }

  atomicWriteFile(filePath, text);
  // Retain only the newest few backups (same bound as the other writers).
  pruneBackups(dir, "opencode.backup.");
  return { ok: true, unchanged: false, backupPath };
}

export { extractManagedProviders } from "./pool-providers.mjs";

export function validateOpencodeConfig(config) {
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
    if (provider.npm !== undefined && typeof provider.npm !== "string") {
      return { valid: false, error: `provider "${providerId}" must have a 'npm' string` };
    }
    if (provider.models !== undefined) {
      if (typeof provider.models !== "object" || provider.models === null || Array.isArray(provider.models)) {
        return { valid: false, error: `provider "${providerId}" models must be an object` };
      }
    }
  }
  return { valid: true };
}
