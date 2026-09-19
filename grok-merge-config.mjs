// Grok Build config.toml merge — writes Anyswitch store channels into
// ~/.grok/config.toml as [model."anyswitch-<channelId>~<modelId>"] tables so
// the grok CLI routes through the local relay's OpenAI chat/completions
// surface (POST /openai/<seg>/v1/chat/completions).
//
// Same pure-text surgery family as codex-merge-config.mjs: no TOML parser,
// the managed block is regenerated wholesale on every merge and marked with
// comment markers, and any [model.anyswitch-*] table found outside the
// markers is stripped as a stale leftover before the fresh block is appended
// — that is what keeps a serializer rewrite (or a hand-deleted marker) from
// producing duplicate TOML table declarations.
//
// grok differs from codex in ways that shape this module (all per
// ~/.grok/docs/user-guide/11-custom-models.md and 26-config-reference.md):
//   - There is no provider/model split and no model catalog file: one
//     [model.<name>] table carries both the endpoint (base_url) and the model
//     id, so granularity is one table per (channel, model) pair — the channel
//     is folded into the catalog key, and picking a model picks the channel.
//   - api_backend defaults to "chat_completions", exactly the relay's surface,
//     so the key is never written.
//   - api_key is a first-class per-model field (credential resolution rank 1),
//     sent as the bearer credential — no Authorization header assembly needed.
//   - env_http_headers maps a header to an env var NAME and is silently
//     skipped when the variable is unset, so a grok launch without the
//     launcher-exported ANYSWITCH_INSTANCE_ID simply omits the header.
//   - reasoning_efforts is an array of tables on the model table, so each
//     level becomes its own [[model.<name>.reasoning_efforts]] entry; without
//     the declaration grok's agent mode drops any reasoning_effort the model
//     would have sent (15-agent-mode.md), which is why the writer fills it
//     from the shared effort library the same way the kimi writer does.
//
// Default model pointer: grok's selector is the `default` key inside a user
// [models] table (26-config-reference.md `models.default`, matched against
// catalog keys). Same policy as codex's protectModelProvider: the key is the
// user's own choice, only re-pointed when it names a stale managed catalog
// key that no longer exists; an absent key, a user's own entry, and any
// built-in/remote model id are all left untouched. The managed block never
// declares a [models] table — TOML rejects duplicate table declarations, and
// the user's own [models] (web_search, global defaults, …) is sacred.

import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { contentHash, atomicWriteFile, pruneBackups } from "./atomic-write.mjs";
import { readSidecar as readSidecarFile, writeSidecar as writeSidecarFile, AUTO_CHANNEL_KEY, deriveAutoRouteChannel } from "./merge-common.mjs";
import { fallbackContextWindow } from "./context-fallback.mjs";
import { resolveEndpointEfforts, catalogForRoot, effortSupplementEnabled } from "./effort-catalog.mjs";
// Shared endpoint-aware derivation of the virtual auto-routing channel
// (merge-common.mjs) — re-exported so the launcher/tests import one module.
export { deriveAutoRouteChannel } from "./merge-common.mjs";
// Single shared implementation (pool-providers.mjs) — the merge modules must
// never carry their own catalog semantics again.
export { extractManagedProviders } from "./pool-providers.mjs";
import { extractManagedProviders } from "./pool-providers.mjs";
// Channel-qualified key packing, shared with codex's catalog slugs — see
// managedModelKey for why the separator has to be "~".
import { packChannelModelSlug } from "./channel-model-slug.mjs";

const SIDECAR_FILENAME = "grok-sidecar.json";
export const MANAGED_BEGIN = "# >>> anyswitch-managed-grok (managed by Anyswitch; do not edit) >>>";
export const MANAGED_END = "# <<< anyswitch-managed-grok <<<";
// relay 认这个端点时用的 id（须与 store-schema 的 ROUTING_ENDPOINT_IDS 成员一致，
// relay 侧按 x-agent-id 同一条白名单校验）。
const GROK_AGENT_ID = "grok";
const MANAGED_ID_PREFIX = "anyswitch-";
// The auto pseudo-channel collapses channel and model into one catalog key:
// its only model is the virtual "auto", so "anyswitch-auto~auto" would just
// stutter. The key keeps the managed prefix so the stale-table strip catches
// it like every other managed entry — and because the branch fires on the
// channel alone, every model of that channel lands on this one key, which is
// what the duplicate-key gate in buildGrokManagedToml guards.
export const AUTO_MODEL_KEY = `${MANAGED_ID_PREFIX}${AUTO_CHANNEL_KEY}`;
// Picker copy for the reasoning_efforts sub-tables: low→xhigh mirror the
// wording of grok's built-in model catalog (extracted from the binary's
// bundled definitions); none/minimal/max extend the same style because the
// built-ins never ship those levels.
const EFFORT_PRESENTATION = {
  none: { label: "No Reasoning", description: "Disable reasoning for the fastest responses" },
  minimal: { label: "Minimal Effort", description: "Lightest reasoning for simple tasks" },
  low: { label: "Low Effort", description: "Quick, fast implementations" },
  medium: { label: "Medium Effort", description: "Balanced effort with standard implementation and testing" },
  high: { label: "High Effort", description: "Higher implementation quality with extensive reasoning" },
  xhigh: { label: "Extra High Effort", description: "Highest effort and reasoning level" },
  max: { label: "Max Effort", description: "Maximum effort and reasoning level" },
};

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

// Resolve the grok config.toml path from a process env-style base.
export function grokConfigPath(base = process.env) {
  return join(base.USERPROFILE ?? "", ".grok", "config.toml");
}

// Catalog key for one (channel, model) pair: the channel folds into the key
// because grok's model namespace is global and flat — a model id offered by
// several channels would otherwise collapse onto one entry and pin every call
// to whichever entry survived.
//
// The join is codex's own packChannelModelSlug (channel-model-slug.mjs), i.e.
// "<channel>~<model>". "-" was the separator here before and it is ambiguous:
// both channel ids and model ids may contain "-", so channel "a" + model "b-c"
// and channel "a-b" + model "c" packed onto the same key — two identically
// named TOML tables, which makes grok reject the whole config and leaves the
// user with zero models. Channel ids never hold a "~" (store-schema's
// PROVIDER_ID is [A-Za-z0-9._-], pools included), so the first "~" is the one
// and only channel/model boundary whatever the model id itself contains ("/",
// even another "~").
export function managedModelKey(channelId, modelId) {
  if (channelId === AUTO_CHANNEL_KEY) return AUTO_MODEL_KEY;
  return `${MANAGED_ID_PREFIX}${packChannelModelSlug(channelId, modelId)}`;
}

// One table per (channel, model) pair. base_url points at the channel's relay
// segment; pseudo-channels (auto routing) name a different URL segment than
// their own id (the chain head), real channels never set baseUrlSegment.
export function buildGrokManagedToml(managedProviders, port, token, effort = null) {
  const lines = [MANAGED_BEGIN, "# OpenAI chat/completions models routed through the local Anyswitch relay.", ""];
  const managed = [];
  const modelKeys = [];
  // Duplicate keys are unrepresentable in TOML: two [model.<same key>] tables
  // make grok reject the whole config, so a repeat is dropped instead of
  // emitted and recorded in `skipped` for the caller to report. Losing one
  // catalog entry is recoverable; an unloadable config is not.
  const skipped = [];
  const seenKeys = new Set();

  for (const [providerId, provider] of Object.entries(managedProviders)) {
    const segment = provider?.baseUrlSegment ?? providerId;
    const baseUrl = `http://127.0.0.1:${port}/openai/${encodeURIComponent(segment)}/v1`;
    const channelLabel = provider?.channelName ?? provider?.displayName ?? providerId;
    for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
      const key = managedModelKey(providerId, modelId);
      if (seenKeys.has(key)) {
        skipped.push({
          key,
          channelId: providerId,
          modelId,
          reason: `duplicate catalog key "${key}" for channel "${providerId}" model "${modelId}"; skipped to keep config.toml loadable`,
        });
        continue;
      }
      seenKeys.add(key);
      const modelLabel =
        typeof model?.displayName === "string" && model.displayName.length > 0 ? model.displayName : modelId;
      // 渠道名进显示名：grok 的选择器每行只读 name，跨渠道同名模型不带渠道名
      // 就是无法区分的重复行（codex 目录 display_name 同款理由）。auto 伪渠道
      // 与 codex 一致保持裸名 "auto"——它是链路由触发词，不是真模型。
      const displayName = providerId === AUTO_CHANNEL_KEY ? modelLabel : `${modelLabel} · ${channelLabel}`;
      // Same chain as the kimi/dsh writers (context-fallback.mjs): the store's
      // discovered contextWindow wins; without it the keyword tier table
      // answers, and an unmatched id lands on the 1M default. grok's own
      // fallback for a keyless custom model is only 200,000
      // (26-config-reference.md), so the key is always written explicitly.
      const contextWindow =
        Number.isInteger(model?.contextWindow) && model.contextWindow > 0
          ? model.contextWindow
          : fallbackContextWindow(modelId);
      // The 「注入推理强度」 switch gates the whole config face: with no
      // catalog handed in, the model simply gets no reasoning_efforts, and
      // grok's agent mode drops any reasoning_effort it would have sent
      // (15-agent-mode.md).
      const efforts = effort?.catalog
        ? resolveEndpointEfforts(modelId, { catalog: effort.catalog, agent: "grok", model, provider })
        : null;
      lines.push(`[model.${tomlString(key)}]`);
      lines.push(`model = ${tomlString(modelId)}`);
      lines.push(`name = ${tomlString(displayName)}`);
      lines.push(`base_url = ${tomlString(baseUrl)}`);
      lines.push(`api_key = ${tomlString(token)}`);
      lines.push(`context_window = ${String(contextWindow)}`);
      lines.push(`extra_headers = { "x-agent-id" = ${tomlString(GROK_AGENT_ID)} }`);
      // env var NAME, not a value: the launcher exports ANYSWITCH_INSTANCE_ID
      // per CLI launch; a bare grok launch has no such variable and grok then
      // just skips the header (11-custom-models.md env_http_headers).
      lines.push(`env_http_headers = { "x-agent-instance" = "ANYSWITCH_INSTANCE_ID" }`);
      if (efforts) {
        // Allowed-effort declaration: one [[model.<key>.reasoning_efforts]]
        // array-of-tables entry per level (26-config-reference.md; the
        // value/label/description/default sub-table shape comes from the
        // bundled model catalog inside the grok binary). Deepest-first
        // matches the built-in entries; `default = true` on the library
        // default makes a session that never touches the picker send it.
        for (const level of [...efforts.levels].reverse()) {
          const presentation = EFFORT_PRESENTATION[level] ?? { label: level, description: "" };
          lines.push(`[[model.${tomlString(key)}.reasoning_efforts]]`);
          lines.push(`value = ${tomlString(level)}`);
          lines.push(`label = ${tomlString(presentation.label)}`);
          if (presentation.description) lines.push(`description = ${tomlString(presentation.description)}`);
          if (level === efforts.default) lines.push("default = true");
          lines.push("");
        }
      }
      lines.push("");
      modelKeys.push(key);
    }
    managed.push(providerId);
  }

  lines.push(MANAGED_END);
  return { text: lines.join("\n") + "\n", managed, modelKeys, skipped };
}

// Self-heal for a rewrite that dropped the comment markers: the `anyswitch-`
// prefix is reserved for managed catalog keys, so any [model.anyswitch-*]
// table outside the managed block — including serializer-expanded sub-tables
// like [model."anyswitch-x".extra_headers] and our own array-of-tables
// entries [[model."anyswitch-x".reasoning_efforts]] — is a stale leftover and
// must go before the fresh block is appended. The `\[+` opener absorbs the
// double bracket of an array-of-tables header; note the `model\.` anchor: a
// [models] table (plural, user-owned) is never matched.
export function stripManagedTables(text) {
  if (!text) return text ?? "";
  const lines = text.split(/\r?\n/);
  const out = [];
  let inManagedTable = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[+([^\]]*)\]/);
    if (header) {
      const name = header[1];
      inManagedTable = /^model\."?anyswitch-/.test(name);
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
    const err = new Error("refusing to overwrite grok config.toml with a truncated Anyswitch managed block");
    err.code = "UNPARSEABLE_GROK_CONFIG";
    throw err;
  }
  const before = text.slice(0, begin).replace(/\s+$/, "");
  const after = text.slice(end + MANAGED_END.length).replace(/^\s+/, "");
  const parts = [];
  if (before) parts.push(before);
  if (after) parts.push(after);
  return parts.length ? parts.join("\n\n") + "\n" : "";
}

const MODELS_HEADER_RE = /^\s*\[models\]\s*(?:#.*)?$/;
const MODELS_DEFAULT_RE = /^(\s*default\s*=\s*)(["'])([^"']*)\2(\s*(?:#.*)?)$/;

// Default-model protection, run on the fully merged text (so current managed
// tables count as defined). The [models] default key is the user's own choice
// and is only re-pointed when it names a stale managed catalog key — a
// deleted channel/model, or a leftover from a serializer rewrite. Anything
// else — a current managed key, a built-in model id, a remote-catalog id, a
// key the user hand-wrote — is left untouched, as is an absent default. Only
// the first [models] table is scanned; keys in any other table (a [model.*]
// sub-table could carry its own "default"-named field) are never touched.
export function protectModelsDefault(text, modelKeys) {
  if (!Array.isArray(modelKeys) || modelKeys.length === 0) return text;
  const current = new Set(modelKeys);
  const target = current.has(AUTO_MODEL_KEY) ? AUTO_MODEL_KEY : modelKeys[0];

  const lines = text.split("\n");
  let inModels = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      if (inModels) break; // left the [models] table region
      inModels = MODELS_HEADER_RE.test(lines[index]);
      continue;
    }
    if (!inModels) continue;
    const kv = lines[index].match(MODELS_DEFAULT_RE);
    if (!kv) continue;
    const value = kv[3];
    if (value.startsWith(MANAGED_ID_PREFIX) && !current.has(value)) {
      lines[index] = `${kv[1]}${tomlString(target)}${kv[4]}`;
      return lines.join("\n");
    }
    return text;
  }
  return text;
}

export function mergeGrokConfigToml(existingText, managedProviders, port, token, autoChannel = null, effort = null) {
  const preserved = stripManagedTables(stripManagedBlock(existingText ?? ""));
  // The managed block is regenerated wholesale on every merge, so appending
  // the virtual auto-routing channel here is also its whole cleanup story:
  // once the endpoint's chain is deleted, autoChannel derives as null and the
  // next sync's block simply no longer contains `anyswitch-auto`.
  const providers = autoChannel ? { ...managedProviders, [AUTO_CHANNEL_KEY]: autoChannel } : managedProviders;
  const { text: managedText, managed, modelKeys, skipped } = buildGrokManagedToml(providers, port, token, effort);
  const trimmedHead = preserved.replace(/\s+$/, "");
  const merged = trimmedHead ? `${trimmedHead}\n\n${managedText}` : managedText;
  const protectedText = protectModelsDefault(merged, modelKeys);
  return { text: protectedText, managed, modelKeys, skipped };
}

export function readGrokConfigToml(filePath) {
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf8");
}

export function writeGrokConfigTomlWithBackup(filePath, text) {
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

// High-level write: read existing config, merge managed models, write back
// with backup. Returns { ok, unchanged, backupPath?, reason? }. Fail-closed: a
// config whose managed block cannot be parsed is reported, never overwritten.
// The effort catalog defaults from the sidecar root, same contract as kimi's
// writer: the 「注入推理强度」 switch gates the whole config face, so with the
// switch off no catalog is loaded and the regenerated block omits every
// reasoning_efforts sub-table (wholesale regeneration is also the cleanup).
export function writeGrokConfig(store, port, token, sidecarRoot, configPath = grokConfigPath(), effort = null) {
  const managedProviders = extractManagedProviders(store);
  const autoChannel = deriveAutoRouteChannel(store, "grok");
  const previousManaged = readSidecar(sidecarRoot).providers;
  if (Object.keys(managedProviders).length === 0 && !autoChannel && previousManaged.length === 0) {
    return { ok: true, unchanged: true, reason: "no Anyswitch providers with models" };
  }
  const effortOptions = effort ?? {
    catalog: effortSupplementEnabled(sidecarRoot) ? catalogForRoot(sidecarRoot) : null,
  };
  let existing;
  try {
    existing = readGrokConfigToml(configPath);
  } catch (error) {
    return { ok: false, unchanged: true, reason: error.message };
  }
  let merged;
  try {
    merged = mergeGrokConfigToml(existing, managedProviders, port, token, autoChannel, effortOptions);
  } catch (error) {
    if (error?.code === "UNPARSEABLE_GROK_CONFIG") {
      return { ok: false, unchanged: true, reason: error.message };
    }
    throw error;
  }
  const writeResult = writeGrokConfigTomlWithBackup(configPath, merged.text);
  if (writeResult.ok) {
    writeSidecar(sidecarRoot, merged.managed);
  }
  // skipped travels with the result so the caller can surface why a catalog
  // entry is missing (see agent-sync's warning path).
  return { ...writeResult, skipped: merged.skipped };
}
