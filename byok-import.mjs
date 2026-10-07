// BYOK import service: scan the local configs of the 8 supported endpoints
// (zcode/kimi/codex/opencode/pi/dsh/qoder/grok — Claude Code has no local
// config surface and is out of scope) for user-configured OpenAI-compatible
// channels, present them as checkable candidates, and import the selected ones
// into the central store (store.json + a DPAPI-sealed credential per channel).
//
// Read side: every endpoint reuses its existing merge module's parser and
// ownership rules — managed entries (sidecar名单、保留前缀、TOML 注释标记块、
// zcode/opencode 的 relay URL 指纹） are never listed, so an import can never
// adopt (and a deleteLocal can never touch) an Anyswitch-managed entry.
//
// Write side: the add transaction mirrors store-service.mjs's addProvider
// (store-service.mjs:591-628) minus the live HTTP discovery — models come from
// the endpoint config verbatim through buildV2AddEntry (discovered =
// modelFilter = models). Credential file first, then a CAS store write; a
// failed write removes the orphaned credential, same as addProvider.
//
// Secrets discipline: plaintext keys live only inside in-memory ticket records
// as Buffers (keyPlaintext). They are zeroed on every exit path — after a
// record's import attempt, on ticket expiry, and via dropTickets() — and never
// appear in anything serialized toward the frontend.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  loadStore as defaultLoadStore,
  writeStore as defaultWriteStore,
  readCiphertext as defaultReadCiphertext,
  resolveCredentialPath as defaultResolveCredentialPath,
  ensureLayout as defaultEnsureLayout,
  storePaths as defaultStorePaths,
} from "./store-io.mjs";
import { protect as defaultProtect } from "./dpapi.mjs";
import { atomicWriteFile as defaultAtomicWriteFile } from "./atomic-write.mjs";
import { buildV2AddEntry, normalizeBaseURL, parseJsonc, validateProviderId } from "./store-core.mjs";
import { readSidecar } from "./merge-common.mjs";
import { readZcodeConfig } from "./zcode-merge-config.mjs";
import { readPersonalConfig, personalConfigPath } from "./zcode-personal-config.mjs";
import {
  readKimiConfigToml,
  stripManagedBlock as stripKimiManagedBlock,
  stripPrefixedTables as stripKimiPrefixedTables,
} from "./kimi-merge-config.mjs";
import {
  readCodexConfigToml,
  stripManagedBlock as stripCodexManagedBlock,
  stripManagedTables as stripCodexManagedTables,
} from "./codex-merge-config.mjs";
import {
  readGrokConfigToml,
  stripManagedBlock as stripGrokManagedBlock,
  stripManagedTables as stripGrokManagedTables,
} from "./grok-merge-config.mjs";
import { readOpencodeConfig } from "./opencode-merge-config.mjs";
import { readModelsJson } from "./pi-merge-models.mjs";
import { dshProfilePatchPaths, getYamlModule, dshYamlSchema } from "./dsh-merge-config.mjs";
import { readQoderSettings } from "./qoder-merge-config.mjs";

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export const BYOK_IMPORT_AGENTS = Object.freeze(["zcode", "kimi", "codex", "opencode", "pi", "dsh", "qoder", "grok"]);

const AGENT_NAMES = {
  zcode: "ZCode",
  kimi: "Kimi Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  dsh: "DeepSeek Harness",
  qoder: "Qoder",
  grok: "Grok Build",
};

// The relay fingerprint an injected entry always carries (zcode-personal-config
// .mjs's RELAY_OPENAI_PATH, same pattern): a loopback /openai/ base URL can
// only point back at this relay, so such an entry is managed even when no
// sidecar names it.
const RELAY_OPENAI_PATH = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/openai\//;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSidecarIds(storeRoot, agentId) {
  const sidecar = readSidecar(join(storeRoot, `${agentId}-sidecar.json`));
  return new Set(Array.isArray(sidecar?.providers) ? sidecar.providers : []);
}

// ─────────────────────────────────────────────────────────────
// Minimal TOML table scanner (read-only)
//
// The merge modules do pure text surgery and deliberately ship no TOML parser;
// scanning only needs table paths and string-valued keys, so this walks the
// (already managed-stripped) text line by line: `[a."b c"]` headers, and
// `key = "value" | 'value' | bare` pairs. Anything it cannot recognize it
// skips — scanning degrades, it never rewrites.
// ─────────────────────────────────────────────────────────────

function unescapeTomlBasic(raw) {
  return raw.replace(/\\(.)/g, (all, ch) => {
    if (ch === "n") return "\n";
    if (ch === "t") return "\t";
    if (ch === "r") return "\r";
    return ch; // \" \\ and anything else keep the escaped char
  });
}

// Split a table header's inner text on dots that sit outside quotes.
function splitTomlPath(inner) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < inner.length; index += 1) {
    const ch = inner[index];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        current += ch + (inner[index + 1] ?? "");
        index += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ".") {
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current.trim());
  return segments.map((segment) => unescapeTomlBasic(segment));
}

function parseTomlValue(raw) {
  const text = raw.trim();
  const basic = text.match(/^"((?:[^"\\]|\\.)*)"/);
  if (basic) return unescapeTomlBasic(basic[1]);
  const literal = text.match(/^'([^']*)'/);
  if (literal) return literal[1];
  // Bare value: cut trailing comment, keep the raw token.
  const hash = text.indexOf("#");
  return (hash === -1 ? text : text.slice(0, hash)).trim();
}

// Returns [{ path: string[], keys: { [name]: string } }] — one row per table.
function scanTomlTables(text) {
  const tables = [];
  let current = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const header = line.match(/^\s*\[+([^\]]+)\]+\s*(?:#.*)?$/);
    if (header) {
      current = { path: splitTomlPath(header[1]), keys: {} };
      tables.push(current);
      continue;
    }
    if (!current) continue;
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (!kv) continue;
    current.keys[kv[1]] = parseTomlValue(kv[2]);
  }
  return tables;
}

// ─────────────────────────────────────────────────────────────
// Per-endpoint scanners. Each returns raw candidates:
//   { sourceId, sourcePath, displayName, baseURL, models:[{id,displayName}],
//     keySource: {kind:"literal",value} | {kind:"env",name} | {kind:"file",path} | {kind:"none"} }
// Managed entries are filtered out here, reusing each merge module's rules.
// ─────────────────────────────────────────────────────────────

function literalKey(value) {
  return typeof value === "string" && value.length > 0 ? { kind: "literal", value } : { kind: "none" };
}

function scanZcode(homeDir, sidecarIds) {
  const configPath = join(homeDir, ".zcode", "v2", "config.json");
  const candidates = new Map(); // sourceId -> candidate, provider_config wins

  // Authoritative client list: provider_config.json rules.
  const personalPath = personalConfigPath(configPath);
  const personal = readPersonalConfig(personalPath); // null when absent
  const rules = Array.isArray(personal?.config?.providerConfigRules?.providerRules)
    ? personal.config.providerConfigRules.providerRules
    : [];
  for (const rule of rules) {
    if (!isRecord(rule) || typeof rule.providerId !== "string") continue;
    const id = rule.providerId;
    const baseURL = rule.config?.api?.baseUrl;
    if (typeof baseURL !== "string" || baseURL.length === 0) continue;
    if (id.startsWith("_") || sidecarIds.has(id) || sidecarIds.has(id.replace(/^_/, ""))) continue;
    if (RELAY_OPENAI_PATH.test(baseURL)) continue;
    const modelIds = Array.isArray(rule.config?.personalModelIds) ? rule.config.personalModelIds : [];
    candidates.set(id, {
      sourceId: id,
      sourcePath: personalPath,
      displayName: typeof rule.providerName === "string" && rule.providerName ? rule.providerName : id,
      baseURL,
      models: modelIds.filter((m) => typeof m === "string" && m.length > 0).map((m) => ({ id: m, displayName: m })),
      keySource: literalKey(rule.config?.access?.apiKey),
    });
  }

  // Side evidence: config.json provider map (the file the client imported from).
  const config = readZcodeConfig(configPath); // { provider: {} } when absent
  for (const [id, provider] of Object.entries(config?.provider ?? {})) {
    if (!isRecord(provider)) continue;
    const baseURL = provider.options?.baseURL;
    if (typeof baseURL !== "string" || baseURL.length === 0) continue;
    if (id.startsWith("_") || sidecarIds.has(id) || sidecarIds.has(id.replace(/^_/, ""))) continue;
    if (RELAY_OPENAI_PATH.test(baseURL)) continue;
    if (candidates.has(id)) continue; // provider_config.json already covers it
    candidates.set(id, {
      sourceId: id,
      sourcePath: configPath,
      displayName: typeof provider.name === "string" && provider.name ? provider.name : id,
      baseURL,
      models: Object.keys(isRecord(provider.models) ? provider.models : {})
        .filter((m) => m.length > 0)
        .map((m) => ({ id: m, displayName: m })),
      keySource: literalKey(provider.options?.apiKey),
    });
  }
  return [...candidates.values()];
}

function scanKimi(homeDir, sidecarIds) {
  const configPath = join(homeDir, ".kimi-code", "config.toml");
  // Reuse the merge module's ownership surgery: the managed comment block and
  // any stray `_`-prefixed tables (leftovers of a kimi-side rewrite) are
  // stripped before scanning, so neither can surface as a candidate.
  const preserved = stripKimiPrefixedTables(stripKimiManagedBlock(readKimiConfigToml(configPath)));
  const tables = scanTomlTables(preserved);
  const providers = new Map();
  const modelsByProvider = new Map();
  for (const table of tables) {
    if (table.path[0] === "providers" && table.path.length === 2) {
      providers.set(table.path[1], table);
    } else if (table.path[0] === "models" && table.path.length === 2) {
      const alias = table.path[1];
      const slash = alias.indexOf("/");
      if (slash === -1) continue;
      const pid = alias.slice(0, slash);
      const modelId = typeof table.keys.model === "string" && table.keys.model ? table.keys.model : alias.slice(slash + 1);
      if (!modelsByProvider.has(pid)) modelsByProvider.set(pid, []);
      modelsByProvider.get(pid).push({
        id: modelId,
        displayName: typeof table.keys.display_name === "string" && table.keys.display_name ? table.keys.display_name : modelId,
      });
    }
  }
  const candidates = [];
  for (const [id, table] of providers) {
    if (id.startsWith("_") || sidecarIds.has(id)) continue;
    const baseURL = table.keys.base_url;
    if (typeof baseURL !== "string" || baseURL.length === 0) continue;
    candidates.push({
      sourceId: id,
      sourcePath: configPath,
      displayName: id,
      baseURL,
      models: modelsByProvider.get(id) ?? [],
      keySource: literalKey(table.keys.api_key),
    });
  }
  return candidates;
}

function scanCodex(homeDir, sidecarIds) {
  const configPath = join(homeDir, ".codex", "config.toml");
  // Same reuse: managed comment block + stray anyswitch-* tables stripped by
  // the merge module's own surgery. ~/.codex/auth.json is the official login
  // state and is deliberately never read; OAuth credentials are out of scope.
  const preserved = stripCodexManagedTables(stripCodexManagedBlock(readCodexConfigToml(configPath)));
  const candidates = [];
  for (const table of scanTomlTables(preserved)) {
    if (table.path[0] !== "model_providers" || table.path.length !== 2) continue;
    const id = table.path[1];
    if (id.startsWith("anyswitch-") || sidecarIds.has(id)) continue;
    const baseURL = table.keys.base_url;
    if (typeof baseURL !== "string" || baseURL.length === 0) continue;
    let keySource = { kind: "none" };
    if (typeof table.keys.env_key === "string" && table.keys.env_key.length > 0) {
      keySource = { kind: "env", name: table.keys.env_key };
    } else {
      // Some hand configs carry a literal Authorization header instead.
      const headers = table.keys.http_headers;
      const bearer = typeof headers === "string" ? headers.match(/"Authorization"\s*=\s*"Bearer\s+([^"]+)"/) : null;
      if (bearer) keySource = { kind: "literal", value: bearer[1] };
    }
    candidates.push({
      sourceId: id,
      sourcePath: configPath,
      displayName: typeof table.keys.name === "string" && table.keys.name ? table.keys.name : id,
      baseURL,
      models: [], // codex keeps no per-provider model list in config.toml
      keySource,
    });
  }
  return candidates;
}

function opencodeCandidatesFromConfig(config, sourcePath, sidecarIds) {
  const candidates = [];
  for (const [id, provider] of Object.entries(config?.provider ?? {})) {
    if (!isRecord(provider)) continue;
    // opencode managed ids carry no prefix; the sidecar is the only ownership
    // record, with the relay URL fingerprint as backstop.
    if (sidecarIds.has(id)) continue;
    const baseURL = provider.options?.baseURL;
    if (typeof baseURL !== "string" || baseURL.length === 0) continue;
    if (RELAY_OPENAI_PATH.test(baseURL)) continue;
    const apiKey = provider.options?.apiKey;
    let keySource = { kind: "none" };
    if (typeof apiKey === "string" && apiKey.length > 0) {
      const envRef = apiKey.match(/^\{env:([^}]+)\}$/);
      const fileRef = apiKey.match(/^\{file:([^}]+)\}$/);
      if (envRef) keySource = { kind: "env", name: envRef[1] };
      else if (fileRef) keySource = { kind: "file", path: fileRef[1] };
      else keySource = { kind: "literal", value: apiKey };
    }
    candidates.push({
      sourceId: id,
      sourcePath,
      displayName: typeof provider.name === "string" && provider.name ? provider.name : id,
      baseURL,
      models: Object.entries(isRecord(provider.models) ? provider.models : {})
        .filter(([modelId]) => modelId.length > 0)
        .map(([modelId, model]) => ({
          id: modelId,
          displayName: typeof model?.name === "string" && model.name ? model.name : modelId,
        })),
      keySource,
    });
  }
  return candidates;
}

function scanOpencode(homeDir, sidecarIds) {
  const dir = join(homeDir, ".config", "opencode");
  const jsonPath = join(dir, "opencode.json");
  const jsoncPath = join(dir, "opencode.jsonc");
  const byId = new Map(); // union of both files, plain JSON wins ties
  for (const candidate of opencodeCandidatesFromConfig(readOpencodeConfig(jsonPath), jsonPath, sidecarIds)) {
    byId.set(candidate.sourceId, candidate);
  }
  let jsoncConfig = null;
  if (existsSync(jsoncPath)) {
    jsoncConfig = parseJsonc(readFileSync(jsoncPath, "utf8"));
  }
  if (jsoncConfig) {
    for (const candidate of opencodeCandidatesFromConfig(jsoncConfig, jsoncPath, sidecarIds)) {
      if (!byId.has(candidate.sourceId)) byId.set(candidate.sourceId, candidate);
    }
  }
  return [...byId.values()];
}

const PI_ENV_REF = /^\$\{([^}]+)\}$/;

function scanPi(homeDir, sidecarIds) {
  const modelsPath = join(homeDir, ".pi", "agent", "models.json");
  const config = readModelsJson(modelsPath); // { providers: {} } when absent
  const candidates = [];
  for (const [id, provider] of Object.entries(config?.providers ?? {})) {
    if (!isRecord(provider)) continue;
    if (id.startsWith("_") || sidecarIds.has(id)) continue;
    const baseURL = provider.baseUrl;
    if (typeof baseURL !== "string" || baseURL.length === 0) continue;
    const apiKey = provider.apiKey;
    let keySource = { kind: "none" };
    if (typeof apiKey === "string" && apiKey.length > 0) {
      const ref = apiKey.match(PI_ENV_REF);
      keySource = ref ? { kind: "env", name: ref[1] } : { kind: "literal", value: apiKey };
    }
    candidates.push({
      sourceId: id,
      sourcePath: modelsPath,
      displayName: typeof provider.name === "string" && provider.name ? provider.name : id,
      baseURL,
      models: (Array.isArray(provider.models) ? provider.models : [])
        .filter((m) => isRecord(m) && typeof m.id === "string" && m.id.length > 0)
        .map((m) => ({ id: m.id, displayName: typeof m.name === "string" && m.name ? m.name : m.id })),
      keySource,
    });
  }
  return candidates;
}

async function scanDsh(homeDir, sidecarIds) {
  const dshHome = join(homeDir, ".dsh");
  // dsh profile patches carry cordis's !!js custom tags, so they must be read
  // through the merge module's own loader/schema — a bare js-yaml load throws.
  const yaml = await getYamlModule();
  const schema = dshYamlSchema(yaml);
  // dsh's ownership record is the sidecar alone (its merge protects even
  // `_`-prefixed user entries): on-disk managed keys are `_`+sidecar id.
  const managedKeys = new Set(
    [...sidecarIds].map((id) => (String(id).startsWith("_") ? String(id) : `_${id}`)),
  );
  const byIdAndUrl = new Map();
  for (const patchPath of dshProfilePatchPaths(dshHome)) {
    if (!existsSync(patchPath)) continue;
    let parsed;
    try {
      parsed = yaml.load(readFileSync(patchPath, "utf8").replace(/^\uFEFF/, ""), { schema });
    } catch {
      continue; // one broken profile must not sink the scan (same rule as the writer)
    }
    if (!Array.isArray(parsed)) continue;
    const row = parsed.find((entry) => isRecord(entry) && entry.id === "llm-pi-ai");
    const providers = row?.config?.providers;
    if (!isRecord(providers)) continue;
    const profileName = patchPath.replace(/\\/g, "/").split("/").slice(-2, -1)[0] ?? "";
    for (const [id, provider] of Object.entries(providers)) {
      if (!isRecord(provider)) continue;
      if (managedKeys.has(id)) continue;
      const baseURL = provider.baseURL;
      if (typeof baseURL !== "string" || baseURL.length === 0) continue;
      const dedupeKey = `${id}|${baseURL}`;
      if (byIdAndUrl.has(dedupeKey)) continue;
      let keySource = { kind: "none" };
      if (typeof provider.apiKey === "string" && provider.apiKey.length > 0) {
        keySource = { kind: "literal", value: provider.apiKey };
      } else if (typeof provider.apiKeyEnv === "string" && provider.apiKeyEnv.length > 0) {
        keySource = { kind: "env", name: provider.apiKeyEnv };
      }
      // The same provider id in a second profile with a different baseURL needs
      // a distinct sourceId (key = agentId::sourceId must stay unique).
      let sourceId = id;
      if ([...byIdAndUrl.values()].some((c) => c.sourceId === sourceId)) {
        sourceId = `${id}@${profileName}`;
      }
      byIdAndUrl.set(dedupeKey, {
        sourceId,
        sourcePath: patchPath,
        displayName: typeof provider.displayName === "string" && provider.displayName ? provider.displayName : id,
        baseURL,
        models: (Array.isArray(provider.models) ? provider.models : [])
          .filter((m) => isRecord(m) && typeof m.id === "string" && m.id.length > 0)
          .map((m) => ({ id: m.id, displayName: typeof m.name === "string" && m.name ? m.name : m.id })),
        keySource,
      });
    }
  }
  return [...byIdAndUrl.values()];
}

const QODER_MANAGED_ID = /^qoder-custom-anyswitch-[0-9a-f]{16}$/;

function scanQoder(homeDir, sidecarIds) {
  const settingsPath = join(homeDir, ".qoder", "settings.json");
  const settings = readQoderSettings(settingsPath); // {} when absent
  const candidates = [];
  for (const [id, connection] of Object.entries(settings?.providers ?? {})) {
    if (!isRecord(connection)) continue;
    if (QODER_MANAGED_ID.test(id) || sidecarIds.has(id)) continue;
    const baseURL = connection.baseUrl;
    if (typeof baseURL !== "string" || baseURL.length === 0) continue;
    candidates.push({
      sourceId: id,
      sourcePath: settingsPath,
      displayName: typeof connection.displayName === "string" && connection.displayName ? connection.displayName : id,
      baseURL,
      models: (Array.isArray(connection.models) ? connection.models : [])
        .filter((m) => isRecord(m) && typeof m.model === "string" && m.model.length > 0)
        .map((m) => ({ id: m.model, displayName: typeof m.displayName === "string" && m.displayName ? m.displayName : m.model })),
      keySource: literalKey(connection.apiKey),
    });
  }
  return candidates;
}

function scanGrok(homeDir, sidecarIds) {
  const configPath = join(homeDir, ".grok", "config.toml");
  const preserved = stripGrokManagedTables(stripGrokManagedBlock(readGrokConfigToml(configPath)));
  const candidates = [];
  for (const table of scanTomlTables(preserved)) {
    // One [model.<name>] table = one candidate channel: grok has no
    // provider/model split, base_url and api_key sit on the model table. The
    // plural [models] table (user defaults) is never a candidate.
    if (table.path[0] !== "model" || table.path.length !== 2) continue;
    const name = table.path[1];
    if (name.startsWith("anyswitch-") || sidecarIds.has(name)) continue;
    const baseURL = table.keys.base_url;
    if (typeof baseURL !== "string" || baseURL.length === 0) continue;
    const modelId = typeof table.keys.model === "string" && table.keys.model ? table.keys.model : name;
    candidates.push({
      sourceId: name,
      sourcePath: configPath,
      displayName: typeof table.keys.name === "string" && table.keys.name ? table.keys.name : name,
      baseURL,
      models: [{ id: modelId, displayName: typeof table.keys.name === "string" && table.keys.name ? table.keys.name : modelId }],
      keySource: literalKey(table.keys.api_key),
    });
  }
  return candidates;
}

// ─────────────────────────────────────────────────────────────
// Shared pipeline: key resolution, duplicate detection, id suggestion
// ─────────────────────────────────────────────────────────────

function resolveKeySource(keySource, env) {
  switch (keySource.kind) {
    case "literal":
      return { status: "ok", plaintext: Buffer.from(keySource.value, "utf8") };
    case "env": {
      const value = env?.[keySource.name];
      if (typeof value === "string" && value.length > 0) {
        return { status: "ok", plaintext: Buffer.from(value, "utf8") };
      }
      return { status: "unresolved-key", reason: `env ${keySource.name} is not set` };
    }
    case "file": {
      try {
        const value = readFileSync(keySource.path, "utf8").trim();
        if (value.length > 0) return { status: "ok", plaintext: Buffer.from(value, "utf8") };
      } catch {
        // fall through to unresolved
      }
      return { status: "unresolved-key", reason: `file ${keySource.path} could not be read` };
    }
    default:
      return { status: "no-key" };
  }
}

function normalizedOrNull(value) {
  try {
    return normalizeBaseURL(value);
  } catch {
    return null;
  }
}

// Fold a source id into the provider-id alphabet (^[A-Za-z0-9][A-Za-z0-9._-]
// {0,127}$): invalid runs collapse to "-", leading non-alphanumerics are
// stripped, the result is capped at 128 chars, and an all-invalid id falls
// back to "channel".
export function suggestBaseId(sourceId) {
  let candidate = String(sourceId ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  if (candidate.length > 128) candidate = candidate.slice(0, 128);
  if (!/^[A-Za-z0-9]/.test(candidate)) candidate = "channel";
  return candidate;
}

function uniqueSuggestedId(base, takenLower) {
  if (!takenLower.has(base.toLowerCase())) return base;
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, 128 - tail.length)}${tail}`;
    if (!takenLower.has(candidate.toLowerCase())) return candidate;
  }
}

function zeroRecord(record) {
  if (record.keyPlaintext) {
    record.keyPlaintext.fill(0);
    record.keyPlaintext = null;
  }
}

// ─────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────

export function createByokImportService({
  storeRoot,
  homeDir = homedir(),
  env = process.env,
  removeFn = null,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  paths = defaultStorePaths(storeRoot),
  loadStore = (p) => defaultLoadStore(p),
  writeStore = (store, options) => defaultWriteStore(store, options),
  resolveCredentialPath = (credentialFile, p) => defaultResolveCredentialPath(credentialFile, p),
  ensureLayout = (p) => defaultEnsureLayout(p),
  atomicWriteFile = defaultAtomicWriteFile,
  protect = (plaintext, providerId) => defaultProtect(plaintext, providerId, { generation: "v2" }),
  fsOps = { remove: (path) => rmSync(path, { force: true }) },
} = {}) {
  const load = () => loadStore(paths);
  const write = (store, options) => writeStore(store, { paths, ...options });
  const tickets = new Map(); // ticketId -> { expiresAt, records: Map<key, record> }

  function dropTicket(ticketId) {
    const ticket = tickets.get(ticketId);
    if (!ticket) return;
    for (const record of ticket.records.values()) zeroRecord(record);
    tickets.delete(ticketId);
  }

  function purgeExpiredTickets() {
    const at = now();
    for (const [ticketId, ticket] of tickets) {
      if (at >= ticket.expiresAt) dropTicket(ticketId);
    }
  }

  const scanners = {
    zcode: () => scanZcode(homeDir, readSidecarIds(paths.root, "zcode")),
    kimi: () => scanKimi(homeDir, readSidecarIds(paths.root, "kimi")),
    codex: () => scanCodex(homeDir, readSidecarIds(paths.root, "codex")),
    opencode: () => scanOpencode(homeDir, readSidecarIds(paths.root, "opencode")),
    pi: () => scanPi(homeDir, readSidecarIds(paths.root, "pi")),
    dsh: () => scanDsh(homeDir, readSidecarIds(paths.root, "dsh")),
    qoder: () => scanQoder(homeDir, readSidecarIds(paths.root, "qoder")),
    grok: () => scanGrok(homeDir, readSidecarIds(paths.root, "grok")),
  };

  async function scanLocalConfigs() {
    purgeExpiredTickets();
    const scannedAt = new Date(now()).toISOString();

    // Store view for duplicate detection and id collision checks. A store that
    // cannot be loaded never fails the scan — detection just runs on an empty
    // library.
    const loaded = load();
    const storeProviders = loaded.ok ? (loaded.store.providers ?? {}) : {};
    const storePools = loaded.ok ? (loaded.store.pools ?? {}) : {};
    const takenIdLower = new Set(
      [...Object.keys(storeProviders), ...Object.keys(storePools)].map((id) => id.toLowerCase()),
    );
    const storeURLs = [];
    for (const provider of Object.values(storeProviders)) {
      for (const url of [provider?.baseURL, ...(Array.isArray(provider?.fallbackURLs) ? provider.fallbackURLs : [])]) {
        const normalized = normalizedOrNull(url);
        if (normalized) storeURLs.push(normalized);
      }
    }

    const groups = [];
    const records = new Map();
    for (const agentId of BYOK_IMPORT_AGENTS) {
      let raw;
      try {
        raw = await scanners[agentId]();
      } catch {
        continue; // one unreadable endpoint must not sink the scan
      }
      const entries = [];
      for (const candidate of raw) {
        const key = `${agentId}::${candidate.sourceId}`;
        if (records.has(key)) continue;
        const resolved = resolveKeySource(candidate.keySource, env);
        const normalized = normalizedOrNull(candidate.baseURL);
        let status = resolved.status;
        let reason = resolved.reason;
        if (normalized === null) continue; // no usable address: cannot be imported, not listed
        if (storeURLs.includes(normalized)) {
          status = "duplicate";
          reason = "same base URL as a provider already in the library";
        }
        const suggestedId = uniqueSuggestedId(suggestBaseId(candidate.sourceId), takenIdLower);
        takenIdLower.add(suggestedId.toLowerCase());
        records.set(key, {
          key,
          agentId,
          sourcePath: candidate.sourcePath,
          sourceId: candidate.sourceId,
          displayName: candidate.displayName,
          baseURL: candidate.baseURL,
          models: candidate.models,
          keyPlaintext: resolved.plaintext ?? null,
          suggestedId,
          status,
        });
        const entry = {
          key,
          displayName: candidate.displayName,
          suggestedId,
          baseURL: candidate.baseURL,
          modelCount: candidate.models.length,
          status,
        };
        if (reason !== undefined) entry.reason = reason;
        entries.push(entry);
      }
      if (entries.length > 0) {
        groups.push({ agentId, agentName: AGENT_NAMES[agentId] ?? agentId, entries });
      }
    }

    if (groups.length === 0) {
      return { ok: true, ticket: null, groups: [], scannedAt };
    }
    const ticket = randomUUID();
    tickets.set(ticket, { expiresAt: now() + ttlMs, records });
    return { ok: true, ticket, groups, scannedAt };
  }

  // One addProvider-shaped transaction without live discovery: DPAPI credential
  // file first, then a CAS store write built through buildV2AddEntry
  // (discovered = modelFilter = models from the endpoint config); a failed
  // store write removes the orphaned credential.
  async function importRecord(record) {
    const id = record.suggestedId;
    try {
      validateProviderId(id);
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const loaded = load();
    if (!loaded.ok && loaded.reason !== "store-absent") {
      return { ok: false, error: `the Anyswitch v2 store is unavailable: ${loaded.reason}` };
    }
    const store = loaded.ok ? loaded.store : { version: 2, providers: {} };
    const expectedHash = loaded.ok ? loaded.hash : null;
    if (store.providers?.[id]) return { ok: false, error: `Provider ${id} already exists` };
    const baseURL = normalizedOrNull(record.baseURL);
    if (baseURL === null) return { ok: false, error: "Base URL is invalid" };

    const plaintext = record.keyPlaintext ?? Buffer.alloc(0);
    let ciphertext;
    let credentialWritten = false;
    let credentialPath = null;
    try {
      const modelIds = record.models.map((model) => model.id);
      const entry = buildV2AddEntry({
        displayName: typeof record.displayName === "string" && record.displayName.trim() ? record.displayName.trim() : id,
        baseURL,
        credentialFile: `${id}.dpapi`,
        modelIds,
      });
      ciphertext = await protect(plaintext, id);
      ensureLayout(paths);
      const resolvedPath = resolveCredentialPath(`${id}.dpapi`, paths);
      if (!resolvedPath.ok) return { ok: false, error: `refusing to write the credential: ${resolvedPath.reason}` };
      credentialPath = resolvedPath.path;
      atomicWriteFile(credentialPath, ciphertext);
      credentialWritten = true;

      const nextStore = structuredClone(store);
      nextStore.providers[id] = entry;
      const written = write(nextStore, { expectedHash });
      if (!written.ok) {
        // Fail-closed cleanup only because this provider is NEW (addProvider's
        // early-CLI enroll semantics): the fresh credential is a true orphan.
        if (credentialPath) await removeFile(credentialPath);
        credentialWritten = false;
        return { ok: false, error: written.reason ?? "store write failed" };
      }
      return { ok: true, id };
    } catch (error) {
      if (credentialWritten && credentialPath) {
        try {
          await removeFile(credentialPath);
        } catch {
          /* best-effort orphan cleanup */
        }
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      ciphertext?.fill?.(0);
      zeroRecord(record); // the plaintext's only home is the ticket; it leaves with the attempt
    }
  }

  async function removeFile(path) {
    await fsOps.remove(path);
  }

  async function applyImport({ ticket: ticketId, keys, deleteLocal }) {
    purgeExpiredTickets();
    const ticket = typeof ticketId === "string" ? tickets.get(ticketId) : undefined;
    if (!ticket) return { ok: false, error: "ticket-expired" };
    if (!Array.isArray(keys) || keys.length === 0 || new Set(keys).size !== keys.length) {
      return { ok: false, error: "unknown-selection" };
    }
    const selected = [];
    for (const key of keys) {
      const record = typeof key === "string" ? ticket.records.get(key) : undefined;
      if (!record || record.status !== "ok") return { ok: false, error: "unknown-selection" };
      selected.push(record);
    }

    let imported = 0;
    const failed = [];
    const succeeded = [];
    for (const record of selected) {
      const result = await importRecord(record);
      if (result.ok) {
        imported += 1;
        succeeded.push(record);
      } else {
        failed.push({ key: record.key, error: result.error });
      }
    }

    // Local removal only ever runs on entries that actually imported, and only
    // when the user kept the delete-local checkbox on.
    let removed = [];
    let removeFailed = [];
    let backupDir = null;
    if (deleteLocal === true && succeeded.length > 0) {
      const remover = removeFn
        ?? ((entries) => ({
          removed: [],
          failed: entries.map((entry) => ({ key: entry.key, error: "local removal is unavailable" })),
          backupDir: null,
        }));
      try {
        const outcome = await remover(succeeded, {
          backupRoot: join(paths.root, "backups"),
          now,
        });
        removed = Array.isArray(outcome?.removed) ? outcome.removed : [];
        removeFailed = Array.isArray(outcome?.failed) ? outcome.failed : [];
        backupDir = typeof outcome?.backupDir === "string" ? outcome.backupDir : null;
      } catch (error) {
        removeFailed = succeeded.map((record) => ({
          key: record.key,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    // The ticket is single-use: every record's plaintext has already been
    // zeroed by the import attempts; drop the unselected remainder too.
    dropTicket(ticketId);
    return { ok: true, imported, failed, removed, removeFailed, backupDir };
  }

  function dropTickets() {
    for (const ticketId of [...tickets.keys()]) dropTicket(ticketId);
  }

  return { scanLocalConfigs, applyImport, dropTickets };
}
