// Codex config.toml merge — writes Anyswitch store channels into
// ~/.codex/config.toml as [model_providers.anyswitch-<seg>] tables so the
// codex CLI / desktop app routes through the local relay's Responses API
// surface (POST /openai/<seg>/v1/responses).
//
// Same pure-text surgery family as kimi-merge-config.mjs: no TOML parser, the
// managed block is regenerated wholesale on every merge and marked with
// comment markers, and because the desktop app rewrites config.toml itself and
// drops every comment line (the kimi :113-121 incident, same disease), any
// [model_providers.anyswitch-*] table found outside the markers is stripped as
// a stale leftover before the fresh block is appended — that is what keeps a
// rewrite from producing duplicate TOML table declarations.
//
// Auth header is a literal: the desktop GUI never sees the launcher's env, so
// env_key would be an unrecoverable hard failure there. env_http_headers only
// carries the per-instance id (value is an env var NAME, not a secret); when
// no launcher supplies ANYSWITCH_INSTANCE_ID (GUI), codex simply omits the
// header and traffic folds into the single codex bucket — acceptable.
//
// Model catalog (model_catalog_json): codex's picker lists the built-in 9
// official models unless config.toml points at a static ModelsResponse file.
// writeCodexConfig therefore also generates
// ~/.codex/model-catalogs/anyswitch-models.json from the same channel view as
// the provider tables and anchors a top-level `model_catalog_json` pointer on
// it. The pointer is managed state but lives outside the managed block —
// top-level keys must precede every table, so it can never sit between the
// markers. A pointer naming any other file is the user's own catalog and is
// left untouched (codex++ semantics); an empty model set writes neither file
// nor pointer, because codex hard-fails config load on an empty catalog.
//
// Features gate: the desktop GUI's cross-session memory pipeline fires its
// own background model calls (hardcoded model, separate session ids), which
// surface on the panel as phantom session rows and unexpected 404 banners.
// `[features] memories = false` is the hard gate. The KEY is managed state —
// forced to false on every sync, restored when hand-deleted — but the TABLE
// is not: TOML rejects duplicate table declarations, so a config that
// already carries its own [features] table absorbs the key instead (other
// keys untouched), and only a config without one gets the table inside the
// managed block.

import { readFileSync, existsSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash, atomicWriteFile, pruneBackups } from "./atomic-write.mjs";
import { readSidecar as readSidecarFile, writeSidecar as writeSidecarFile, AUTO_CHANNEL_KEY, deriveAutoRouteChannel } from "./merge-common.mjs";
// Shared endpoint-aware derivation of the virtual auto-routing channel
// (merge-common.mjs) — re-exported so the launcher/tests import one module.
export { deriveAutoRouteChannel } from "./merge-common.mjs";
// Single shared implementation (pool-providers.mjs) — the merge modules must
// never carry their own catalog semantics again.
export { extractManagedProviders } from "./pool-providers.mjs";
import { extractManagedProviders } from "./pool-providers.mjs";

const SIDECAR_FILENAME = "codex-sidecar.json";
export const MANAGED_BEGIN = "# >>> anyswitch-managed-codex (managed by Anyswitch; do not edit) >>>";
export const MANAGED_END = "# <<< anyswitch-managed-codex <<<";
// relay 认这个端点时用的 id（须与 store-schema 的 ROUTING_ENDPOINT_IDS 成员一致，
// relay 侧按 x-agent-id 同一条白名单校验）。
const CODEX_AGENT_ID = "codex";
const MANAGED_ID_PREFIX = "anyswitch-";
export const AUTO_PROVIDER_ID = `${MANAGED_ID_PREFIX}${AUTO_CHANNEL_KEY}`;
// codex-rs reserved built-in provider ids (config load errors out when a custom
// table reuses one). "openai" is handled by the legacy migration instead.
const BUILTIN_PROVIDER_IDS = new Set(["amazon-bedrock", "amazon-bedrock-runtime", "ollama", "lmstudio"]);

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

// Resolve the codex config.toml path from a process env-style base.
export function codexConfigPath(base = process.env) {
  return join(base.USERPROFILE ?? "", ".codex", "config.toml");
}

// The auto pseudo-channel lands on `anyswitch-auto` by construction
// (AUTO_CHANNEL_KEY is "auto").
export function managedProviderId(providerId) {
  return `${MANAGED_ID_PREFIX}${providerId}`;
}

// --- model catalog (ModelsResponse for codex's ModelsManager) ---

const CATALOG_TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "codex-model-catalog-template.json");
// The pointer value is relative: codex resolves a relative model_catalog_json
// against the codex home dir (~/.codex), and the file travels with the config.
export const CATALOG_POINTER_VALUE = "model-catalogs/anyswitch-models.json";
const CATALOG_POINTER_RE = /^\s*model_catalog_json\s*=\s*(["'])((?:[^"\\]|\\.)*)\1\s*(?:#.*)?$/;

// The field template for generated catalog entries: one verbatim upstream
// models.json entry (shipped as a sibling asset, refreshable from
// openai/codex codex-rs/models-manager/models.json). Returns null when the
// asset is unreadable — the catalog feature then stays off for the sync,
// because a pointer to a catalog we cannot regenerate would hard-fail codex's
// config load, while a missing pointer never breaks the provider tables.
export function loadCodexCatalogTemplate() {
  try {
    return JSON.parse(readFileSync(CATALOG_TEMPLATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

// Flatten the endpoint-visible channels into the catalog's model list: the
// first channel to offer a model id also wins its metadata (pool-union
// semantics, same as deriveVisibleChannels).
export function collectCodexCatalogModels(providers) {
  const models = new Map();
  for (const provider of Object.values(providers ?? {})) {
    for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
      if (!models.has(modelId)) models.set(modelId, model ?? {});
    }
  }
  return models;
}

// One catalog entry per routable model. The upstream entry is cloned verbatim
// so every capability codex gates features on (reasoning levels, truncation
// policy, per-model instructions, …) survives; only identity and the fields
// that would shape requests in ways non-OpenAI upstreams reject are
// overridden:
//   - supports_search_tool: a hosted web_search tool spec would 400 upstreams
//     that do not implement OpenAI's server-side tools (codex enables it by
//     default for custom providers otherwise)
//   - prefer_websockets: the template carries upstream's true, but the relay
//     has no WebSocket surface — openai-server.mjs answers upgrade requests
//     with 404 so the client falls back to HTTP; a model codex insists on
//     reaching over WS would hang every request through the catalog
//   - support_verbosity / supports_image_detail_original: request knobs only
//     OpenAI's own backend honors
// multi_agent_version is forced to "v2" even though the template entry leaves
// it null — without it codex disables the subagent tools (codex++ #2161).
export function buildCodexModelCatalog(models, template) {
  const entries = [];
  let index = 0;
  for (const [modelId, model] of models) {
    const entry = structuredClone(template);
    entry.slug = modelId;
    entry.display_name =
      typeof model?.displayName === "string" && model.displayName.length > 0 ? model.displayName : modelId;
    entry.description = null;
    if (Number.isInteger(model?.contextWindow) && model.contextWindow > 0) {
      entry.context_window = model.contextWindow;
      entry.max_context_window = model.contextWindow;
    }
    // Same lowercase text/image/audio alphabet on both sides (store-schema
    // ALLOWED_MODALITIES == codex's InputModality wire values).
    if (Array.isArray(model?.inputModalities) && model.inputModalities.length > 0) {
      entry.input_modalities = [...model.inputModalities];
    }
    entry.priority = index + 1;
    entry.multi_agent_version = "v2";
    entry.supports_search_tool = false;
    entry.prefer_websockets = false;
    entry.support_verbosity = false;
    entry.default_verbosity = null;
    entry.supports_image_detail_original = false;
    entries.push(entry);
    index += 1;
  }
  return entries.length > 0 ? { models: entries } : null;
}

function unquoteTomlString(raw) {
  return raw.replace(/\\(["\\])/g, "$1");
}

// Strip OUR catalog pointer from the top-level key region (a pointer naming
// our generated catalog is managed state, regenerated on every sync). A
// pointer naming any other file is the user's own catalog: reported back,
// never touched.
function extractCatalogPointer(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inTopLevel = true;
  let userPointer = null;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) inTopLevel = false;
    if (inTopLevel) {
      const kv = line.match(CATALOG_POINTER_RE);
      if (kv) {
        const value = unquoteTomlString(kv[2]);
        if (value === CATALOG_POINTER_VALUE) continue;
        userPointer ??= value;
      }
    }
    out.push(line);
  }
  return { text: out.join("\n"), userPointer };
}

// A top-level key must sit before the first table header.
function insertTopLevelKey(text, keyLine) {
  const tableMatch = text.match(/^\s*\[/m);
  if (!tableMatch) {
    const head = text.replace(/\s+$/, "");
    return (head ? `${head}\n\n` : "") + keyLine + "\n";
  }
  const before = text.slice(0, tableMatch.index).replace(/\s+$/, "");
  const after = text.slice(tableMatch.index);
  return (before ? `${before}\n${keyLine}\n\n` : `${keyLine}\n\n`) + after;
}

// One table per channel. codex speaks only the Responses API
// (wire_api="responses"); base_url is a plain string concat target with no
// auto "/v1" suffix, so the full prefix is written out. Pseudo-channels (auto
// routing) name a different relay URL segment than their own id; real channels
// never set baseUrlSegment. includeFeaturesGate is false once the merge has
// absorbed the memories key into a user [features] table (see
// mergeMemoriesGate) — the managed block then must not re-declare it.
export function buildCodexManagedToml(managedProviders, port, token, includeFeaturesGate = true) {
  const lines = [MANAGED_BEGIN, "# OpenAI Responses API channels routed through the local Anyswitch relay.", ""];
  const managed = [];

  for (const [providerId, provider] of Object.entries(managedProviders)) {
    const segment = provider?.baseUrlSegment ?? providerId;
    const baseUrl = `http://127.0.0.1:${port}/openai/${encodeURIComponent(segment)}/v1`;
    const displayName = provider?.channelName ?? provider?.displayName ?? providerId;
    lines.push(`[model_providers.${tomlString(managedProviderId(providerId))}]`);
    lines.push(`name = ${tomlString(displayName)}`);
    lines.push(`base_url = ${tomlString(baseUrl)}`);
    lines.push(`wire_api = "responses"`);
    lines.push(`http_headers = { "Authorization" = ${tomlString(`Bearer ${token}`)}, "x-agent-id" = ${tomlString(CODEX_AGENT_ID)} }`);
    // env var NAME, not a value: the launcher exports ANYSWITCH_INSTANCE_ID per
    // CLI launch; the GUI has no env and codex then just skips the header.
    lines.push(`env_http_headers = { "x-agent-instance" = "ANYSWITCH_INSTANCE_ID" }`);
    lines.push("");
    managed.push(providerId);
  }

  // Hard gate on the desktop GUI's background memory pipeline. Declared only
  // when the user config carries no [features] table of its own — TOML table
  // names must be unique across the whole file.
  if (includeFeaturesGate) {
    lines.push("[features]");
    lines.push(MEMORIES_GATE_LINE);
    lines.push("");
  }
  lines.push(MANAGED_END);
  return { text: lines.join("\n") + "\n", managed };
}

// Self-heal for the desktop-app rewrite that drops comment markers: the
// `anyswitch-` prefix is reserved for managed ids, so any model_providers table
// under it outside the managed block — including serializer-expanded
// sub-tables like [model_providers.anyswitch-x.http_headers] — is a stale
// leftover and must go before the fresh block is appended.
export function stripManagedTables(text) {
  if (!text) return text ?? "";
  const lines = text.split(/\r?\n/);
  const out = [];
  let inManagedTable = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]*)\]/);
    if (header) {
      const name = header[1];
      inManagedTable = /^model_providers\."?anyswitch-/.test(name);
      if (inManagedTable) continue;
    }
    if (!inManagedTable) out.push(line);
  }
  return out.join("\n").replace(/\s+$/, "") + (text.length ? "\n" : "");
}

export function stripManagedBlock(text) {
  const begin = text.indexOf(MANAGED_BEGIN);
  if (begin === -1) return text.replace(/\s+$/, "") + (text.length ? "\n" : "");
  const end = text.indexOf(MANAGED_END, begin);
  if (end === -1) {
    const err = new Error("refusing to overwrite codex config.toml with a truncated Anyswitch managed block");
    err.code = "UNPARSEABLE_CODEX_CONFIG";
    throw err;
  }
  const before = text.slice(0, begin).replace(/\s+$/, "");
  const after = text.slice(end + MANAGED_END.length).replace(/^\s+/, "");
  const parts = [];
  if (before) parts.push(before);
  if (after) parts.push(after);
  return parts.length ? parts.join("\n\n") + "\n" : "";
}

// Legacy migration: the pre-integration manual config pairs a top-level
// `openai_base_url` pointing at the relay root (where /responses 404s) with
// `model_provider = "openai"`. The stray key is dropped wholesale; the
// selector is re-anchored onto a managed entry by protectModelProvider below.
function dropLegacyKeys(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inTopLevel = true;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) inTopLevel = false;
    if (inTopLevel && /^\s*openai_base_url\s*=/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

// --- [features] memories gate ---

const FEATURES_HEADER_RE = /^\s*\[features\]\s*(?:#.*)?$/;
// The forced value keeps the user's own spacing and trailing comment (the
// protectModelProvider convention): only the boolean itself is managed.
const MEMORIES_KEY_RE = /^(\s*memories\s*=\s*)(\S+)(\s*(?:#.*)?)$/;
const MEMORIES_GATE_LINE = "memories = false";

// Force the managed key inside a user-owned [features] table, run on the
// preserved text before the fresh block is built: an existing same-name key
// is overridden (managed semantics — memories = true is pressed back to
// false), a hand-deleted key is restored, every other key stays verbatim.
// Reports whether a table was found so mergeCodexConfigToml knows whether
// the managed block may declare [features] itself — a duplicate table
// declaration would invalidate the whole config.
function mergeMemoriesGate(text) {
  const lines = text.split(/\r?\n/);
  let inFeatures = false;
  let headerIndex = -1;
  let keyIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      // Only the first [features] table is absorbed; a second declaration is
      // already the user's own duplicate-table breakage, not ours to heal.
      inFeatures = headerIndex === -1 && FEATURES_HEADER_RE.test(lines[index]);
      if (inFeatures) headerIndex = index;
      continue;
    }
    if (inFeatures && keyIndex === -1 && MEMORIES_KEY_RE.test(lines[index])) keyIndex = index;
  }
  if (headerIndex === -1) return { text, hasFeaturesTable: false };
  if (keyIndex === -1) {
    // Directly under the header: the key must land in the parent table even
    // when [features.*] sub-tables follow.
    lines.splice(headerIndex + 1, 0, MEMORIES_GATE_LINE);
  } else {
    const kv = lines[keyIndex].match(MEMORIES_KEY_RE);
    if (kv[2] !== "false") lines[keyIndex] = `${kv[1]}false${kv[3]}`;
  }
  return { text: lines.join("\n"), hasFeaturesTable: true };
}

// Selector protection, run on the fully merged text (so current managed tables
// count as defined). The top-level `model_provider` is the user's own choice
// and is only re-pointed when it can no longer resolve: the legacy "openai"
// selector, a stale `anyswitch-*` id from a previous managed set, or a
// dangling id with no table anywhere. Anything else — a current managed id, a
// user-defined provider, another built-in — is left untouched, as is an absent
// selector (codex's default is the user's business, not ours).
export function protectModelProvider(text, managed) {
  const managedIds = managed.map(managedProviderId);
  if (managedIds.length === 0) return text;
  const target = managedIds.includes(AUTO_PROVIDER_ID) ? AUTO_PROVIDER_ID : managedIds[0];

  const defined = new Set(managedIds);
  for (const match of text.matchAll(/^\s*\[model_providers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(?:\.[^\]]*)?\]\s*$/gm)) {
    defined.add(match[1] ?? match[2]);
  }

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) break; // top-level keys end at the first table
    const kv = lines[index].match(/^(\s*model_provider\s*=\s*)(["'])([^"']*)\2(\s*(?:#.*)?)$/);
    if (!kv) continue;
    const value = kv[3];
    const staleManaged = value.startsWith(MANAGED_ID_PREFIX) && !defined.has(value);
    const dangling = !value.startsWith(MANAGED_ID_PREFIX) && value !== "openai"
      && !defined.has(value) && !BUILTIN_PROVIDER_IDS.has(value);
    if (value === "openai" || staleManaged || dangling) {
      lines[index] = `${kv[1]}${tomlString(target)}${kv[4]}`;
      return lines.join("\n");
    }
    return text;
  }
  return text;
}

export function mergeCodexConfigToml(existingText, managedProviders, port, token, autoChannel = null, catalogTemplate = null) {
  const preserved = dropLegacyKeys(stripManagedTables(stripManagedBlock(existingText ?? "")));
  // The memories gate is decided on the preserved text (after the old managed
  // block and stale tables are gone): a surviving user [features] table
  // absorbs the managed key and the fresh block stays silent on [features];
  // with no table anywhere the block declares it.
  const gate = mergeMemoriesGate(preserved);
  // The managed block is regenerated wholesale on every merge, so appending
  // the virtual auto-routing channel here is also its whole cleanup story:
  // once the endpoint's chain is deleted, autoChannel derives as null and the
  // next sync's block simply no longer contains `anyswitch-auto`.
  const providers = autoChannel ? { ...managedProviders, [AUTO_CHANNEL_KEY]: autoChannel } : managedProviders;
  const { text: managedText, managed } = buildCodexManagedToml(providers, port, token, !gate.hasFeaturesTable);
  // The catalog pointer is regenerated from the same channel view as the
  // provider tables. A null catalogTemplate (asset unreadable) keeps the
  // feature off: our stale pointer is stripped and no fresh one is written.
  const catalogModels = catalogTemplate ? collectCodexCatalogModels(providers) : new Map();
  const pointer = extractCatalogPointer(gate.text);
  let head = pointer.text;
  let catalogPointer = "none";
  if (pointer.userPointer !== null) {
    catalogPointer = "user";
  } else if (catalogModels.size > 0) {
    head = insertTopLevelKey(head, `model_catalog_json = ${tomlString(CATALOG_POINTER_VALUE)}`);
    catalogPointer = "ours";
  }
  const trimmedHead = head.replace(/\s+$/, "");
  const merged = trimmedHead ? `${trimmedHead}\n\n${managedText}` : managedText;
  return { text: protectModelProvider(merged, managed), managed, catalogModels, catalogPointer, memoriesGate: gate.hasFeaturesTable ? "absorbed" : "managed-block" };
}

export function readCodexConfigToml(filePath) {
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf8");
}

export function writeCodexConfigTomlWithBackup(filePath, text) {
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

// Catalog file sync, called around the config write. The file is synced even
// when config.toml itself was unchanged: the model set is not part of the
// config text, so a model-only edit would otherwise never reach the picker.
function catalogFilePath(codexDir) {
  return join(codexDir, "model-catalogs", "anyswitch-models.json");
}

function writeCatalogFile(codexDir, catalogModels, template) {
  const catalog = buildCodexModelCatalog(catalogModels, template);
  if (!catalog) return; // unreachable: the "ours" pointer implies non-empty models
  const filePath = catalogFilePath(codexDir);
  const text = JSON.stringify(catalog, null, 2) + "\n";
  if (existsSync(filePath) && contentHash(readFileSync(filePath, "utf8")) === contentHash(text)) return;
  mkdirSync(dirname(filePath), { recursive: true });
  atomicWriteFile(filePath, text);
}

function removeCatalogFile(codexDir) {
  try {
    rmSync(catalogFilePath(codexDir), { force: true });
  } catch {
    // best-effort: the pointer is already gone from the config just written,
    // so a leftover file is inert and the next sync retries the removal
  }
}

// High-level write: read existing config, merge managed providers, write back
// with backup. Returns { ok, unchanged, backupPath?, reason? }. Fail-closed: a
// config whose managed block cannot be parsed is reported, never overwritten.
export function writeCodexConfig(store, port, token, sidecarRoot, configPath = codexConfigPath()) {
  const managedProviders = extractManagedProviders(store);
  const autoChannel = deriveAutoRouteChannel(store, "codex");
  const previousManaged = readSidecar(sidecarRoot).providers;
  if (Object.keys(managedProviders).length === 0 && !autoChannel && previousManaged.length === 0) {
    return { ok: true, unchanged: true, reason: "no Anyswitch providers with models" };
  }
  let existing;
  try {
    existing = readCodexConfigToml(configPath);
  } catch (error) {
    return { ok: false, unchanged: true, reason: error.message };
  }
  const catalogTemplate = loadCodexCatalogTemplate();
  let merged;
  try {
    merged = mergeCodexConfigToml(existing, managedProviders, port, token, autoChannel, catalogTemplate);
  } catch (error) {
    if (error?.code === "UNPARSEABLE_CODEX_CONFIG") {
      return { ok: false, unchanged: true, reason: error.message };
    }
    throw error;
  }
  // The catalog file lands before the config that points at it, so a codex
  // launch racing the sync can never meet a dangling model_catalog_json
  // pointer; the stale-file removal below runs after the config write for the
  // same reason (an outdated-but-present catalog still loads, a missing one
  // fails config load outright). Removal fires whenever the pointer is not
  // ours — "none" (empty model set) and "user" alike: a hand-written pointer
  // at another file leaves our previously generated catalog as inert clutter
  // (the user's own file sits at their path and is never touched).
  if (merged.catalogPointer === "ours") {
    writeCatalogFile(dirname(configPath), merged.catalogModels, catalogTemplate);
  }
  const writeResult = writeCodexConfigTomlWithBackup(configPath, merged.text);
  if (writeResult.ok) {
    writeSidecar(sidecarRoot, merged.managed);
    if (merged.catalogPointer !== "ours") removeCatalogFile(dirname(configPath));
  }
  return writeResult;
}
