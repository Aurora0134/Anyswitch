import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { contentHash, atomicWriteFile, pruneBackups } from "./atomic-write.mjs";
import { readSidecar as readSidecarFile, writeSidecar as writeSidecarFile, AUTO_CHANNEL_KEY } from "./merge-common.mjs";
// Shared endpoint-aware derivation of the virtual auto-routing channel
// (merge-common.mjs) — re-exported so the launcher/tests import one module.
export { deriveAutoRouteChannel } from "./merge-common.mjs";
import { fallbackContextWindow } from "./context-fallback.mjs";
// Single shared implementation (pool-providers.mjs) — the merge modules must
// never carry their own catalog semantics again.
export { extractApiCredProviders } from "./pool-providers.mjs";

const SIDECAR_FILENAME = "kimi-sidecar.json";
// legacy marker names kept for compatibility after product rename ApiCred → Anyswitch
export const MANAGED_BEGIN = "# >>> apicred-managed-kimi (managed by ApiCred; do not edit) >>>";
export const MANAGED_END = "# <<< apicred-managed-kimi <<<";

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

export function prefixedProviderId(providerId) {
  return `_${providerId}`;
}

export function kimiModelAlias(providerId, modelId) {
  return `${prefixedProviderId(providerId)}/${modelId}`;
}

export function buildKimiManagedToml(apiCredProviders, port, token) {
  const lines = [MANAGED_BEGIN, "# OpenAI-compatible ApiCred relay providers and models.", ""];
  const managed = [];

  for (const [providerId, provider] of Object.entries(apiCredProviders)) {
    const pid = prefixedProviderId(providerId);
    // Pseudo-channels (auto routing) name a different relay URL segment than
    // their own id; real channels never set baseUrlSegment.
    const segment = provider.baseUrlSegment ?? providerId;
    const baseUrl = `http://127.0.0.1:${port}/openai/${encodeURIComponent(segment)}/v1`;
    lines.push(`[providers.${tomlString(pid)}]`);
    lines.push(`type = "openai"`);
    lines.push(`base_url = ${tomlString(baseUrl)}`);
    lines.push(`api_key = ${tomlString(token)}`);
    // 端点身份头（x-agent-id: kimi）不写进 config.toml：kimi-code 的请求头
    // 合并顺序是 env（KIMI_CODE_CUSTOM_HEADERS）在最底、provider 的
    // customHeaders 最后覆盖——config.toml 里的同名头会盖掉 env 注入，身份
    // 头若分两处定义迟早漂移。改由 launcher 随 KIMI_CODE_CUSTOM_HEADERS 统一
    // 注入 x-agent-id 与 per-launch 的 x-agent-instance（kimi-launcher.mjs
    // buildKimiLauncherEnv）；未走 launcher 直连时，relay 侧的 UA 兜底识别
    // （openai-server.mjs openaiAgentIdFrom）仍是归桶防线。
    lines.push("");

    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      const alias = kimiModelAlias(providerId, modelId);
      const context = model.contextWindow ?? fallbackContextWindow(modelId);
      lines.push(`[models.${tomlString(alias)}]`);
      lines.push(`provider = ${tomlString(pid)}`);
      lines.push(`model = ${tomlString(modelId)}`);
      lines.push(`max_context_size = ${Number(context)}`);
      if (typeof model.displayName === "string" && model.displayName.length > 0) {
        lines.push(`display_name = ${tomlString(model.displayName)}`);
      }
      if (typeof model.maxOutputTokens === "number") {
        lines.push(`max_output_size = ${model.maxOutputTokens}`);
      }
      lines.push("");
    }
    managed.push(providerId);
  }

  lines.push(MANAGED_END);
  return { text: lines.join("\n") + "\n", managed };
}

// Kimi Code rewrites config.toml itself (Rust toml serializer) whenever the
// user changes settings inside the CLI, and that rewrite drops every comment
// line — including the ApiCred managed-block markers. The rewritten provider/
// model tables survive as unmarked content, so the next merge would append a
// second copy of the same tables and produce duplicate TOML declarations
// ("Cannot declare ('providers', '_x') twice"), which Kimi rejects wholesale —
// config load fails and no models are visible. The `_` prefix is reserved for
// ApiCred-generated ids, so any table under [providers._...] or [models."_..."]
// outside the managed block is a stale leftover from such a rewrite and must go.
export function stripPrefixedTables(text) {
  if (!text) return text ?? "";
  const lines = text.split(/\r?\n/);
  const out = [];
  let inPrefixedTable = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]*)\]/);
    if (header) {
      const name = header[1];
      inPrefixedTable = /^providers\."?_/.test(name) || /^models\."?_/.test(name);
      if (inPrefixedTable) continue;
    }
    if (!inPrefixedTable) out.push(line);
  }
  return out.join("\n").replace(/\s+$/, "") + (text.length ? "\n" : "");
}

export function stripManagedBlock(text) {
  const begin = text.indexOf(MANAGED_BEGIN);
  if (begin === -1) return text.replace(/\s+$/, "") + (text.length ? "\n" : "");
  const end = text.indexOf(MANAGED_END, begin);
  if (end === -1) {
    const err = new Error("refusing to overwrite kimi config.toml with a truncated ApiCred managed block");
    err.code = "UNPARSEABLE_KIMI_CONFIG";
    throw err;
  }
  const before = text.slice(0, begin).replace(/\s+$/, "");
  const after = text.slice(end + MANAGED_END.length).replace(/^\s+/, "");
  const parts = [];
  if (before) parts.push(before);
  if (after) parts.push(after);
  return parts.length ? parts.join("\n\n") + "\n" : "";
}

export function mergeKimiConfigToml(existingText, apiCredProviders, port, token, autoChannel = null) {
  const preserved = stripPrefixedTables(stripManagedBlock(existingText ?? ""));
  // The managed block is regenerated wholesale on every merge, so appending
  // the virtual auto-routing channel here is also its whole cleanup story:
  // once the endpoint's chain is deleted, autoChannel derives as null and the
  // next sync's block simply no longer contains `_auto`.
  const providers = autoChannel ? { ...apiCredProviders, [AUTO_CHANNEL_KEY]: autoChannel } : apiCredProviders;
  const { text: managedText, managed } = buildKimiManagedToml(providers, port, token);
  const merged = preserved ? `${preserved.replace(/\s+$/, "")}\n\n${managedText}` : managedText;
  return { text: merged, managed };
}

export function readKimiConfigToml(filePath) {
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf8");
}

export function writeKimiConfigTomlWithBackup(filePath, text) {
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
  // token-bearing config copies on disk (233 already in ~/.zcode/v2).
  pruneBackups(dir, "config.backup.");
  return { ok: true, unchanged: false, backupPath };
}
