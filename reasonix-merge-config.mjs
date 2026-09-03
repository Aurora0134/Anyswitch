import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { contentHash, atomicWriteFile, pruneBackups } from "./atomic-write.mjs";
import { readSidecar as readSidecarFile, writeSidecar as writeSidecarFile, AUTO_CHANNEL_KEY } from "./merge-common.mjs";
// Shared endpoint-aware derivation of the virtual auto-routing channel
// (merge-common.mjs) — re-exported so the launcher/tests import one module.
export { deriveAutoRouteChannel } from "./merge-common.mjs";
import { fallbackContextWindow } from "./context-fallback.mjs";

const SIDECAR_FILENAME = "reasonix-sidecar.json";
// legacy marker names kept for compatibility after product rename ApiCred → Anyswitch
export const MANAGED_BEGIN = "# >>> apicred-managed-reasonix (managed by ApiCred; do not edit) >>>";
export const MANAGED_END = "# <<< apicred-managed-reasonix <<<";

// legacy env var name kept for compatibility after product rename ApiCred → Anyswitch
export const RELAY_TOKEN_ENV = "APICRED_RELAY_TOKEN";

const BUILTIN_DEEPSEEK_TOML = [
  "[[providers]]",
  'name            = "deepseek-flash"',
  'kind            = "anthropic"',
  'base_url        = "https://api.deepseek.com/anthropic"',
  'model           = "deepseek-v4-flash"',
  'models          = ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]',
  'api_key_env     = "DEEPSEEK_API_KEY"',
  "context_window  = 1000000",
  "",
  "[[providers]]",
  'name            = "deepseek-pro"',
  'kind            = "anthropic"',
  'base_url        = "https://api.deepseek.com/anthropic"',
  'model           = "deepseek-v4-pro"',
  'models          = ["deepseek-v4-pro"]',
  'api_key_env     = "DEEPSEEK_API_KEY"',
  "context_window  = 1000000",
  "",
].join("\n");

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

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export { extractApiCredProviders } from "./pool-providers.mjs";

export function prefixedProviderId(providerId) {
  return `_${providerId}`;
}

export function reasonixEnvPathFromConfig(configPath) {
  return join(dirname(configPath), ".env");
}

export function mergeReasonixEnv(existingText, token) {
  const lines = (existingText ?? "").split(/\r?\n/);
  let found = false;
  const out = [];
  for (const line of lines) {
    if (/^\s*APICRED_RELAY_TOKEN\s*=/.test(line)) {
      out.push(`${RELAY_TOKEN_ENV}=${token}`);
      found = true;
    } else if (line.length > 0 || out.length === 0 || out[out.length - 1] !== "") {
      out.push(line);
    }
  }
  if (!found) {
    while (out.length && out[out.length - 1] === "") out.pop();
    if (out.length) out.push("");
    out.push(`${RELAY_TOKEN_ENV}=${token}`);
  }
  return out.join("\n").replace(/\s+$/, "") + "\n";
}

export function writeReasonixEnvWithBackup(filePath, token) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const text = mergeReasonixEnv(existing, token);
  if (contentHash(existing) === contentHash(text)) return { ok: true, unchanged: true };
  let backupPath;
  if (existing) {
    backupPath = join(dir, `.env.backup.${timestamp()}`);
    copyFileSync(filePath, backupPath);
  }
  atomicWriteFile(filePath, text);
  // Trim to the newest 5 backups: unbounded retention accumulates
  // token-bearing .env copies on disk.
  pruneBackups(dir, ".env.backup.");
  return { ok: true, unchanged: false, backupPath };
}

export function buildReasonixManagedToml(apiCredProviders, port) {
  const lines = [
    MANAGED_BEGIN,
    "# OpenAI-compatible ApiCred relay providers. Token is APICRED_RELAY_TOKEN in .env.",
    "",
  ];
  const managed = [];

  for (const [providerId, provider] of Object.entries(apiCredProviders)) {
    const name = prefixedProviderId(providerId);
    // Pseudo-channels (auto routing) name a different relay URL segment than
    // their own id; real channels never set baseUrlSegment.
    const segment = provider.baseUrlSegment ?? providerId;
    const baseUrl = `http://127.0.0.1:${port}/openai/${encodeURIComponent(segment)}/v1`;
    const modelIds = Object.keys(provider.models ?? {});
    const firstId = modelIds[0] ?? "";
    const firstModel = provider.models?.[firstId];
    const context = firstModel?.contextWindow ?? fallbackContextWindow(firstId);

    lines.push("[[providers]]");
    lines.push(`name            = ${tomlString(name)}`);
    lines.push(`kind            = "openai"`);
    lines.push(`base_url        = ${tomlString(baseUrl)}`);
    if (firstId) lines.push(`model           = ${tomlString(firstId)}`);
    if (modelIds.length > 0) {
      lines.push("models          = [");
      for (const modelId of modelIds) {
        lines.push(`  ${tomlString(modelId)},`);
      }
      lines.push("]");
    }
    lines.push(`api_key_env     = ${tomlString(RELAY_TOKEN_ENV)}`);
    lines.push(`context_window  = ${Number(context)}`);
    lines.push(`headers         = { "x-agent-id" = "reasonix" }`);
    lines.push("");

    for (const modelId of modelIds) {
      const sm = provider.models[modelId];
      const cw = sm?.contextWindow;
      const maxOut = sm?.maxOutputTokens;
      if (cw === undefined && maxOut === undefined) continue;
      lines.push(`[providers.model_overrides.${tomlString(modelId)}]`);
      if (cw !== undefined) lines.push(`context_window     = ${Number(cw)}`);
      if (typeof maxOut === "number") lines.push(`max_output_tokens  = ${maxOut}`);
      lines.push("");
    }
    managed.push(providerId);
  }

  lines.push(MANAGED_END);
  return { text: lines.join("\n") + "\n", managed };
}

export function stripPrefixedProviderTables(text) {
  if (!text) return text ?? "";
  const parts = text.split(/(\[\[providers\]\])/);
  if (parts.length === 1) return text;
  const out = [parts[0]];
  for (let i = 1; i < parts.length; i += 2) {
    const marker = parts[i];
    const body = parts[i + 1] ?? "";
    const nameMatch = body.match(/^\s*name\s*=\s*"([^"]+)"/m);
    const name = nameMatch?.[1] ?? "";
    if (name.startsWith("_")) continue;
    out.push(marker, body);
  }
  return out.join("").replace(/\s+$/, "") + (text.length ? "\n" : "");
}

export function stripManagedBlock(text) {
  const begin = text.indexOf(MANAGED_BEGIN);
  if (begin === -1) return text.replace(/\s+$/, "") + (text.length ? "\n" : "");
  const end = text.indexOf(MANAGED_END, begin);
  if (end === -1) {
    const err = new Error("refusing to overwrite reasonix config.toml with a truncated ApiCred managed block");
    err.code = "UNPARSEABLE_REASONIX_CONFIG";
    throw err;
  }
  const before = text.slice(0, begin).replace(/\s+$/, "");
  const after = text.slice(end + MANAGED_END.length).replace(/^\s+/, "");
  const parts = [];
  if (before) parts.push(before);
  if (after) parts.push(after);
  return parts.length ? parts.join("\n\n") + "\n" : "";
}

export function mergeReasonixConfigToml(existingText, apiCredProviders, port, autoChannel = null) {
  let preserved = stripPrefixedProviderTables(stripManagedBlock(existingText ?? ""));
  if (!/\[\[providers\]\]/.test(preserved)) {
    preserved = preserved.replace(/\s+$/, "");
    preserved = preserved ? `${preserved}\n\n${BUILTIN_DEEPSEEK_TOML}` : BUILTIN_DEEPSEEK_TOML;
  }
  // The managed block is regenerated wholesale on every merge, so appending
  // the virtual auto-routing channel here is also its whole cleanup story:
  // once the endpoint's chain is deleted, autoChannel derives as null and the
  // next sync's block simply no longer contains `_auto`.
  const providers = autoChannel ? { ...apiCredProviders, [AUTO_CHANNEL_KEY]: autoChannel } : apiCredProviders;
  const { text: managedText, managed } = buildReasonixManagedToml(providers, port);
  const merged = preserved ? `${preserved.replace(/\s+$/, "")}\n\n${managedText}` : managedText;
  return { text: merged, managed };
}

export function readReasonixConfigToml(filePath) {
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf8");
}

export function writeReasonixConfigTomlWithBackup(filePath, text) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const hash = contentHash(text);
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf8");
    if (contentHash(existing) === hash) return { ok: true, unchanged: true };
  }
  let backupPath;
  if (existsSync(filePath)) {
    backupPath = join(dir, `config.backup.${timestamp()}.toml`);
    copyFileSync(filePath, backupPath);
  }
  atomicWriteFile(filePath, text);
  // Trim to the newest 5 backups: unbounded retention accumulates
  // token-bearing config copies on disk.
  pruneBackups(dir, "config.backup.");
  return { ok: true, unchanged: false, backupPath };
}
