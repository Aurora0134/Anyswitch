// Local-delete half of the BYOK import flow ("从端点本地配置导入渠道入中央库").
// After the import service (byok-import.mjs) has copied the user-checked
// channels into the central store, applyImport hands the same candidate
// records here to remove the originals from each endpoint's own config file.
//
// Internal record shape (never serialized to the frontend):
//   { key, agentId, sourcePath, sourceId, displayName, baseURL, models, keyPlaintext }
// with key === `${agentId}::${sourceId}`. This module reads only
// key/agentId/sourcePath/sourceId/baseURL.
//
// Three hard rules, enforced per entry before any byte is written:
//   1. Identity re-verification: the source file is re-read at deletion time;
//      the entry must still be present and its baseURL must match the
//      candidate's after normalization (trim + trailing-slash strip). A
//      mismatch means something else changed the file since the scan — the
//      entry fails and nothing is deleted blindly.
//   2. Backup before first change: every file about to be modified is copied
//      verbatim into <backupRoot>/byok-import-<yyyymmdd-HHmmss>/<agentId>/
//      <filename> — one timestamped directory per removeImportedEntries call,
//      created lazily (an all-failed call reports backupDir: null).
//   3. Only the named entry: Anyswitch-managed content is never touched —
//      TOML managed-block marker regions are off-limits, ids carrying the
//      managed prefixes (`_`, `anyswitch-`, `qoder-custom-anyswitch-`) are
//      refused outright, and any entry whose on-disk baseURL carries the
//      loopback relay fingerprint (same regex zcode-personal-config.mjs uses
//      to recognise injected rules) is refused. Emptied structures stay
//      valid (empty maps are kept, files are never deleted) and every write
//      goes through atomic-write.mjs.
//
// Text surgery follows the merge modules' own discipline rather than
// inventing a new one: TOML tables are excised line-wise with marker/comment
// lines preserved (the strip family in kimi/codex/grok merge configs);
// zcode's provider_config.json keeps ZCode's exact byte shape (2-space
// indent, NO trailing newline — the 1s-poll lesson recorded for
// zcode-personal-config.mjs) while config.json keeps its writer's trailing
// newline; dsh patches are parsed with dsh-merge-config.mjs's !!js-tolerant
// js-yaml schema and edited row-locally, and a patch that does not parse
// fails the entry untouched (the 2026-09-29 broken-patch incident: never
// "repair" by rewrite); opencode.jsonc keeps every comment via a token-level
// splice (opencode-merge-config.mjs only ever writes the plain-JSON twin, so
// there is no shared JSONC helper to reuse — the minimal tokenizer below is
// local to this module and exposed as jsoncToJsonText for the scanner side).

import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { atomicWriteFile } from "./atomic-write.mjs";
import {
  readPersonalConfig,
  validatePersonalProviderConfig,
  PERSONAL_CONFIG_FILENAME,
} from "./zcode-personal-config.mjs";
import { MANAGED_BEGIN as KIMI_MANAGED_BEGIN, MANAGED_END as KIMI_MANAGED_END } from "./kimi-merge-config.mjs";
import { MANAGED_BEGIN as CODEX_MANAGED_BEGIN, MANAGED_END as CODEX_MANAGED_END } from "./codex-merge-config.mjs";
import { MANAGED_BEGIN as GROK_MANAGED_BEGIN, MANAGED_END as GROK_MANAGED_END } from "./grok-merge-config.mjs";
import { getYamlModule, dshYamlSchema, DSH_LLM_ENTRY_ID } from "./dsh-merge-config.mjs";
import { ANYSWITCH_CHANNEL_NAME } from "./merge-common.mjs";

// Per-entry failure carrier. `code` is the stable machine-readable prefix of
// the `failed[].error` string the API contract propagates.
class RemovalError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "RemovalError";
    this.code = code;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// The whole baseURL comparison contract: whitespace around the URL and any
// number of trailing slashes are the same address. Anything else differing
// means the file drifted since the scan.
function normalizeBaseURL(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Same fingerprint zcode-personal-config.mjs (isAnyswitchRule) uses to
// recognise relay-injected entries. An entry pointing at the loopback relay
// is managed state regardless of how it reached the candidate list.
const RELAY_FINGERPRINT_RE = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/openai\//;

// Managed-id prefixes per endpoint (merge modules' own conventions). The
// scanner already filters managed entries; this is the deletion-side
// backstop so a managed id can never be excised even if a ticket is forged.
const MANAGED_ID_PREFIXES = {
  zcode: ["_"],
  kimi: ["_"],
  codex: ["anyswitch-"],
  opencode: [], // managed ids are unprefixed by design; the relay fingerprint guards them
  pi: ["_"],
  dsh: ["_"],
  qoder: ["qoder-custom-anyswitch-"],
  grok: ["anyswitch-"],
};

// Managed ids that are not prefix-shaped: the Anyswitch pseudo-channel's
// provider id is its visible channel name (kimi/pi render provider ids
// verbatim), so it must be matched exactly or a forged ticket could delete it.
const MANAGED_ID_EXACT = {
  kimi: [ANYSWITCH_CHANNEL_NAME],
  pi: [ANYSWITCH_CHANNEL_NAME],
};

function assertNotManagedId(entry) {
  for (const prefix of MANAGED_ID_PREFIXES[entry.agentId] ?? []) {
    if (entry.sourceId.startsWith(prefix)) {
      throw new RemovalError("managed-entry", `id "${entry.sourceId}" carries the managed prefix "${prefix}"`);
    }
  }
  if ((MANAGED_ID_EXACT[entry.agentId] ?? []).includes(entry.sourceId)) {
    throw new RemovalError("managed-entry", `id "${entry.sourceId}" is an Anyswitch-managed channel name`);
  }
}

function assertEntryIdentity(entry, foundBaseURL) {
  const expected = normalizeBaseURL(entry.baseURL);
  const found = normalizeBaseURL(foundBaseURL);
  if (!found || found !== expected) {
    throw new RemovalError(
      "identity-mismatch",
      `expected baseURL ${expected || "(absent)"}, found ${found || "(absent)"}`,
    );
  }
  if (RELAY_FINGERPRINT_RE.test(found)) {
    throw new RemovalError("managed-entry", "entry points at the Anyswitch loopback relay");
  }
}

// --- backup / write context ------------------------------------------------

function resolveNow(now) {
  const value = typeof now === "function" ? now() : now;
  if (value === undefined || value === null) return new Date();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function formatStamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function makeWriteContext(backupRoot, now) {
  const state = { stamp: null, dir: null, backups: new Map() };
  const stamp = () => (state.stamp ??= formatStamp(resolveNow(now)));

  // One backup per file per call, taken from the pre-call bytes. Files sharing
  // a basename (dsh profiles all carry a cordis.patch.yml) disambiguate with
  // their parent directory name, then a counter.
  function backupOnce(filePath, agentId) {
    if (state.backups.has(filePath)) return;
    if (typeof backupRoot !== "string" || backupRoot.length === 0) {
      throw new RemovalError("no-backup-root");
    }
    state.dir ??= join(backupRoot, `byok-import-${stamp()}`);
    const dir = join(state.dir, agentId);
    mkdirSync(dir, { recursive: true });
    const taken = new Set(state.backups.values());
    const base = basename(filePath);
    const parent = basename(dirname(filePath));
    let name = base;
    if (taken.has(join(dir, name)) || existsSync(join(dir, name))) name = `${parent}__${base}`;
    let n = 2;
    while (taken.has(join(dir, name)) || existsSync(join(dir, name))) {
      name = `${parent}__${n}__${base}`;
      n += 1;
    }
    const dest = join(dir, name);
    copyFileSync(filePath, dest);
    state.backups.set(filePath, dest);
  }

  function writeFile(filePath, agentId, text) {
    if (existsSync(filePath) && readFileSync(filePath, "utf8") === text) return;
    backupOnce(filePath, agentId);
    atomicWriteFile(filePath, text);
  }

  return { writeFile, backupDir: () => state.dir };
}

// --- line utilities ---------------------------------------------------------

function splitLinesKeepEnds(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function lineBody(line) {
  return line.endsWith("\n") ? line.slice(0, -1).replace(/\r$/, "") : line;
}

function isBlankLine(line) {
  return lineBody(line).trim() === "";
}

function isCommentLine(line) {
  return lineBody(line).trimStart().startsWith("#");
}

// --- TOML table excision (kimi / codex / grok) ------------------------------
//
// Line-wise surgery in the same family as the merge modules' strip helpers:
// no TOML parser, headers matched by regex, dotted keys split quote-aware.
// Differences from the strip helpers, demanded by this flow's contract:
// comments and marker lines are never dropped (a table's removal range is
// trimmed back over trailing blank/comment lines so text belonging to the
// NEXT table survives), and tables inside a managed marker block are not
// eligible for matching at all.

function splitTomlKeyPath(name) {
  const segments = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const ch of name) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === "\\" && quote === '"') {
        escaped = true;
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
  return segments;
}

const TOML_HEADER_RE = /^\s*\[+([^\]]*)\]/;
const TOML_BASE_URL_RE = /^\s*base_url\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/;

function findTomlBaseUrl(lines, start, end) {
  for (let i = start + 1; i < end; i += 1) {
    const match = lineBody(lines[i]).match(TOML_BASE_URL_RE);
    if (match) return (match[1] ?? match[2]).replace(/\\(["\\])/g, "$1");
  }
  return null;
}

function managedLineRanges(lines, markerPairs) {
  const ranges = [];
  for (const [begin, end] of markerPairs) {
    for (let i = 0; i < lines.length; i += 1) {
      if (lineBody(lines[i]).trim() !== begin) continue;
      let j = i + 1;
      while (j < lines.length && lineBody(lines[j]).trim() !== end) j += 1;
      // A truncated marker block (the merge modules' fail-closed case): treat
      // the rest of the file as managed so nothing inside it can match.
      ranges.push([i, j === lines.length ? lines.length - 1 : j]);
      i = j;
    }
  }
  return ranges;
}

// classify(segments) → "primary" (the entry's own table; identity is read
// from it), "related" (dependent tables removed alongside, e.g. kimi's
// [models."<id>/*"]), or null.
function stripTomlTables(text, markerPairs, classify) {
  const lines = splitLinesKeepEnds(text);
  const ranges = managedLineRanges(lines, markerPairs);
  const inManaged = (index) => ranges.some(([s, e]) => index >= s && index <= e);
  const headerAt = (index) => {
    const match = lineBody(lines[index]).match(TOML_HEADER_RE);
    return match ? match[1].trim() : null;
  };

  const removals = [];
  let found = false;
  let baseURL = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (inManaged(i)) continue;
    const header = headerAt(i);
    if (header === null) continue;
    const kind = classify(splitTomlKeyPath(header));
    if (!kind) continue;
    // A table ends at the next header anywhere — including one inside a
    // managed block — or at EOF.
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (headerAt(j) !== null) {
        end = j;
        break;
      }
    }
    if (kind === "primary") {
      found = true;
      baseURL ??= findTomlBaseUrl(lines, i, end);
    }
    removals.push([i, end]);
    i = end - 1;
  }
  if (!found) return { found: false };

  const drop = new Uint8Array(lines.length);
  let trimLeading = false;
  for (const [start, end] of removals) {
    if (start === 0) trimLeading = true;
    let trimmedEnd = end;
    while (trimmedEnd - 1 > start && (isBlankLine(lines[trimmedEnd - 1]) || isCommentLine(lines[trimmedEnd - 1]))) {
      trimmedEnd -= 1;
    }
    for (let k = start; k < trimmedEnd; k += 1) drop[k] = 1;
  }
  let next = lines.filter((_, index) => !drop[index]).join("");
  if (trimLeading) next = next.replace(/^(?:[ \t]*\r?\n)+/, "");
  if (next.length > 0 && !next.endsWith("\n")) next += "\n";
  return { found: true, baseURL, text: next };
}

function removeTomlEntry(entry, ctx, markerPairs, classify) {
  const filePath = entry.sourcePath;
  if (!existsSync(filePath)) throw new RemovalError("entry-not-found", filePath);
  const text = readFileSync(filePath, "utf8");
  const result = stripTomlTables(text, markerPairs, classify);
  if (!result.found) throw new RemovalError("entry-not-found", `${entry.sourceId} in ${filePath}`);
  assertEntryIdentity(entry, result.baseURL);
  ctx.writeFile(filePath, entry.agentId, result.text);
}

// kimi pre-rename marker pair (kimi-merge-config.mjs's LEGACY_MANAGED_* are
// module-private there); a block with either marker family is off-limits.
const KIMI_MARKER_PAIRS = [
  [KIMI_MANAGED_BEGIN, KIMI_MANAGED_END],
  [
    "# >>> apicred-managed-kimi (managed by ApiCred; do not edit) >>>",
    "# <<< apicred-managed-kimi <<<",
  ],
];
const CODEX_MARKER_PAIRS = [[CODEX_MANAGED_BEGIN, CODEX_MANAGED_END]];
const GROK_MARKER_PAIRS = [[GROK_MANAGED_BEGIN, GROK_MANAGED_END]];

function removeKimiEntry(entry, ctx) {
  const id = entry.sourceId;
  removeTomlEntry(entry, ctx, KIMI_MARKER_PAIRS, (segments) => {
    if (segments[0] === "providers" && segments.length >= 2 && segments[1] === id) return "primary";
    if (segments[0] === "models" && segments.length === 2 && segments[1].startsWith(`${id}/`)) return "related";
    return null;
  });
}

function removeCodexEntry(entry, ctx) {
  const id = entry.sourceId;
  // Sub-tables ([model_providers.<id>.http_headers] from a serializer rewrite)
  // die with their parent; the top-level model_provider/model selector keys
  // and the model_catalog_json pointer are not tables and never match.
  removeTomlEntry(entry, ctx, CODEX_MARKER_PAIRS, (segments) => {
    if (segments[0] === "model_providers" && segments.length >= 2 && segments[1] === id) return "primary";
    return null;
  });
}

function removeGrokEntry(entry, ctx) {
  const id = entry.sourceId;
  // [model.<name>] plus its sub-tables / array-of-tables entries. The plural
  // [models] table (user defaults) has a different first segment and never
  // matches — same anchor discipline as grok's own stripManagedTables.
  removeTomlEntry(entry, ctx, GROK_MARKER_PAIRS, (segments) => {
    if (segments[0] === "model" && segments.length >= 2 && segments[1] === id) return "primary";
    return null;
  });
}

// --- whole-file JSON endpoints (pi / qoder) ---------------------------------

function readJsonStrict(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(stripBom(readFileSync(filePath, "utf8")));
  } catch (error) {
    throw new RemovalError("unparseable-source", `${filePath}: ${error.message}`);
  }
  if (!isRecord(parsed)) throw new RemovalError("unparseable-source", `${filePath}: root is not an object`);
  return parsed;
}

function removeJsonMappedEntry(entry, ctx, { mapKey, baseUrlField, serialize }) {
  const filePath = entry.sourcePath;
  if (!existsSync(filePath)) throw new RemovalError("entry-not-found", filePath);
  const original = readFileSync(filePath, "utf8");
  const data = readJsonStrict(filePath);
  const map = data[mapKey];
  if (!isRecord(map)) {
    if (map === undefined) throw new RemovalError("entry-not-found", `no "${mapKey}" map in ${filePath}`);
    throw new RemovalError("unsupported-layout", `"${mapKey}" in ${filePath} is not an object`);
  }
  if (!Object.hasOwn(map, entry.sourceId)) {
    throw new RemovalError("entry-not-found", `${entry.sourceId} in ${filePath}`);
  }
  assertEntryIdentity(entry, map[entry.sourceId]?.[baseUrlField]);
  const next = { ...data, [mapKey]: { ...map } };
  delete next[mapKey][entry.sourceId];
  ctx.writeFile(filePath, entry.agentId, serialize(next, original));
}

// pi's models.json keeps the file's own indent style / line endings instead
// of imposing the writer's canonical shape on a hand-maintained file.
function removePiEntry(entry, ctx) {
  removeJsonMappedEntry(entry, ctx, {
    mapKey: "providers",
    baseUrlField: "baseUrl",
    serialize(next, original) {
      const indentMatch = original.match(/\n([ \t]+)\S/);
      let text = indentMatch ? JSON.stringify(next, null, indentMatch[1]) : JSON.stringify(next);
      if (original.includes("\r\n")) text = text.replace(/\n/g, "\r\n");
      if (original.endsWith("\n") && !text.endsWith("\n")) text += "\n";
      return text;
    },
  });
}

function removeQoderEntry(entry, ctx) {
  removeJsonMappedEntry(entry, ctx, {
    mapKey: "providers",
    baseUrlField: "baseUrl",
    serialize: (next) => JSON.stringify(next, null, 2) + "\n",
  });
}

// --- zcode (config.json + provider_config.json) -----------------------------

// Returns the new file text, or null when this file does not carry the entry
// (secondary-file tolerance). With verify=true the file is the candidate's
// source: absence of the file or the entry is a failure.
function planZcodeConfigJson(filePath, entry, verify) {
  if (!existsSync(filePath)) {
    if (verify) throw new RemovalError("entry-not-found", filePath);
    return null;
  }
  const data = readJsonStrict(filePath);
  const providers = isRecord(data.provider) ? data.provider : {};
  if (!Object.hasOwn(providers, entry.sourceId)) {
    if (verify) throw new RemovalError("entry-not-found", `${entry.sourceId} in ${filePath}`);
    return null;
  }
  if (verify) assertEntryIdentity(entry, providers[entry.sourceId]?.options?.baseURL);
  const next = { ...data, provider: { ...providers } };
  delete next.provider[entry.sourceId];
  // zcode-merge-config.mjs's writer shape: 2-space indent, trailing newline.
  return JSON.stringify(next, null, 2) + "\n";
}

function planZcodePersonalConfig(filePath, entry, verify) {
  let doc;
  try {
    doc = readPersonalConfig(filePath);
  } catch (error) {
    throw new RemovalError("unparseable-source", error.message);
  }
  if (doc === null) {
    if (verify) throw new RemovalError("entry-not-found", filePath);
    return null;
  }
  // The client rejects the whole document on any schema violation, so a file
  // that does not pass the gate is left exactly as it is — in both directions.
  const before = validatePersonalProviderConfig(doc);
  if (!before.valid) throw new RemovalError("unparseable-source", `${filePath}: ${before.error}`);
  const rules = doc.config.providerConfigRules.providerRules;
  const index = rules.findIndex((rule) => rule?.providerId === entry.sourceId);
  if (index === -1) {
    if (verify) throw new RemovalError("entry-not-found", `${entry.sourceId} in ${filePath}`);
    return null;
  }
  if (verify) assertEntryIdentity(entry, rules[index]?.config?.api?.baseUrl);
  const next = {
    ...doc,
    config: {
      ...doc.config,
      providerConfigRules: { providerRules: rules.filter((rule) => rule?.providerId !== entry.sourceId) },
      modelConfigRules: {
        ...doc.config.modelConfigRules,
        providerModelRules: doc.config.modelConfigRules.providerModelRules.filter(
          (rule) => rule?.providerId !== entry.sourceId,
        ),
      },
    },
  };
  const after = validatePersonalProviderConfig(next);
  if (!after.valid) throw new RemovalError("invalid-result", after.error);
  // ZCode's own byte shape (the 1s-poll lesson): 2-space indent, NO trailing
  // newline — an added newline would register as a client-side list change.
  return JSON.stringify(next, null, 2);
}

function removeZcodeEntry(entry, ctx) {
  const dir = dirname(entry.sourcePath);
  const configPath = join(dir, "config.json");
  const personalPath = join(dir, PERSONAL_CONFIG_FILENAME);
  const primaryIsPersonal = basename(entry.sourcePath).toLowerCase() === PERSONAL_CONFIG_FILENAME;
  // Plan both files before writing either: a failure anywhere leaves the pair
  // untouched rather than half-removed.
  const plans = primaryIsPersonal
    ? [
        [personalPath, planZcodePersonalConfig(personalPath, entry, true)],
        [configPath, planZcodeConfigJson(configPath, entry, false)],
      ]
    : [
        [configPath, planZcodeConfigJson(configPath, entry, true)],
        [personalPath, planZcodePersonalConfig(personalPath, entry, false)],
      ];
  for (const [filePath, text] of plans) {
    if (text !== null) ctx.writeFile(filePath, entry.agentId, text);
  }
}

// --- opencode (opencode.json / opencode.jsonc) -------------------------------
//
// opencode.jsonc is the user's hand-written file and carries comments, so a
// parse-into-JSON-reserialize pass is not an option. The minimal JSONC
// tokenizer below supports exactly what the surgery needs: strings, the six
// punctuation tokens, literals, and the two comment forms.

function tokenizeJsonc(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\uFEFF") {
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const start = i;
      while (i < n && text[i] !== "\n") i += 1;
      tokens.push({ kind: "comment", start, end: i });
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      if (i >= n) throw new Error("unterminated block comment");
      i += 2;
      tokens.push({ kind: "comment", start, end: i });
      continue;
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      let closed = false;
      while (i < n) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) throw new Error("unterminated string");
      tokens.push({ kind: "string", start, end: i, raw: text.slice(start, i) });
      continue;
    }
    if ("{}[],:".includes(ch)) {
      tokens.push({ kind: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    const start = i;
    while (i < n) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\uFEFF" || "{}[],:".includes(c)) break;
      if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) break;
      if (c === '"') break;
      i += 1;
    }
    if (i === start) throw new Error(`unexpected character at offset ${start}`);
    tokens.push({ kind: "literal", start, end: i });
  }
  return tokens;
}

function skipJsonValue(tokens, i) {
  const token = tokens[i];
  if (!token) throw new Error("missing value");
  if (token.kind === "string" || token.kind === "literal") return i + 1;
  if (token.kind === "{" || token.kind === "[") {
    const open = token.kind;
    const close = open === "{" ? "}" : "]";
    let depth = 1;
    let j = i + 1;
    while (j < tokens.length && depth > 0) {
      if (tokens[j].kind === open) depth += 1;
      else if (tokens[j].kind === close) depth -= 1;
      j += 1;
    }
    if (depth > 0) throw new Error("unterminated value");
    return j;
  }
  throw new Error("unexpected token where a value was expected");
}

// tokens[openIdx] must be "{". Returns one record per member with character
// offsets into the original text plus the member's trailing comma token.
function objectMembers(tokens, openIdx) {
  const members = [];
  const skipComments = (j) => {
    while (tokens[j]?.kind === "comment") j += 1;
    return j;
  };
  let i = skipComments(openIdx + 1);
  if (tokens[i]?.kind === "}") return { members, closeIdx: i };
  for (;;) {
    const keyToken = tokens[i];
    if (keyToken?.kind !== "string") throw new Error("expected an object key");
    let key;
    try {
      key = JSON.parse(keyToken.raw);
    } catch {
      throw new Error("invalid object key string");
    }
    i = skipComments(i + 1);
    if (tokens[i]?.kind !== ":") throw new Error("expected a colon");
    i = skipComments(i + 1);
    const valueStart = tokens[i]?.start;
    const valueEndIdx = skipJsonValue(tokens, i);
    const member = { key, keyStart: keyToken.start, valueStart, valueEnd: tokens[valueEndIdx - 1].end, commaAfter: null };
    i = skipComments(valueEndIdx);
    if (tokens[i]?.kind === ",") {
      member.commaAfter = tokens[i];
      i = skipComments(i + 1);
    }
    members.push(member);
    if (tokens[i]?.kind === "}") return { members, closeIdx: i };
    if (member.commaAfter === null) throw new Error("expected a comma or a closing brace");
  }
}

// Comment-stripping, trailing-comma-dropping JSON view of a JSONC text. Used
// here to sanity-check splice results; exported so the import scanner can
// read opencode.jsonc with the exact same semantics.
export function jsoncToJsonText(text) {
  const tokens = tokenizeJsonc(text);
  let out = "";
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind === "comment") continue;
    if (token.kind === ",") {
      let j = i + 1;
      while (j < tokens.length && tokens[j].kind === "comment") j += 1;
      if (tokens[j]?.kind === "}" || tokens[j]?.kind === "]") continue;
    }
    out += text.slice(token.start, token.end);
  }
  return out;
}

function removeOpencodeEntry(entry, ctx) {
  const filePath = entry.sourcePath;
  if (!existsSync(filePath)) throw new RemovalError("entry-not-found", filePath);
  const text = readFileSync(filePath, "utf8");
  let tokens;
  try {
    tokens = tokenizeJsonc(text);
  } catch (error) {
    throw new RemovalError("unparseable-source", `${filePath}: ${error.message}`);
  }
  const openIdx = tokens.findIndex((token) => token.kind !== "comment");
  if (tokens[openIdx]?.kind !== "{") {
    throw new RemovalError("unsupported-layout", `${filePath}: root is not an object`);
  }
  let root;
  try {
    root = objectMembers(tokens, openIdx);
  } catch (error) {
    throw new RemovalError("unparseable-source", `${filePath}: ${error.message}`);
  }
  const providerMember = root.members.find((member) => member.key === "provider");
  if (!providerMember) throw new RemovalError("entry-not-found", `no "provider" map in ${filePath}`);
  const providerOpenIdx = tokens.findIndex((token) => token.start === providerMember.valueStart);
  if (tokens[providerOpenIdx]?.kind !== "{") {
    throw new RemovalError("unsupported-layout", `"provider" in ${filePath} is not an object`);
  }
  let providerObject;
  try {
    providerObject = objectMembers(tokens, providerOpenIdx);
  } catch (error) {
    throw new RemovalError("unparseable-source", `${filePath}: ${error.message}`);
  }
  const target = providerObject.members.find((member) => member.key === entry.sourceId);
  if (!target) throw new RemovalError("entry-not-found", `${entry.sourceId} in ${filePath}`);

  let value;
  try {
    value = JSON.parse(jsoncToJsonText(text.slice(target.valueStart, target.valueEnd)));
  } catch (error) {
    throw new RemovalError("unparseable-source", `${filePath}: ${error.message}`);
  }
  assertEntryIdentity(entry, value?.options?.baseURL);

  // Remove [keyStart, valueEnd] plus exactly one separating comma: the one
  // after the member, or — for the last member — the one after its
  // predecessor. Comments and whitespace outside those spans survive.
  const spans = [[target.keyStart, target.valueEnd]];
  if (target.commaAfter) {
    spans.push([target.commaAfter.start, target.commaAfter.end]);
  } else {
    const index = providerObject.members.indexOf(target);
    const previous = providerObject.members[index - 1];
    if (previous?.commaAfter) spans.push([previous.commaAfter.start, previous.commaAfter.end]);
  }
  spans.sort((a, b) => b[0] - a[0]);
  let next = text;
  for (const [start, end] of spans) next = next.slice(0, start) + next.slice(end);

  // Sanity gate: the splice must parse and must hold exactly the old provider
  // set minus the removed id. Any surprise leaves the file untouched.
  let check;
  try {
    check = JSON.parse(jsoncToJsonText(next));
  } catch (error) {
    throw new RemovalError("surgery-failed", `${filePath}: ${error.message}`);
  }
  const remaining = isRecord(check?.provider) ? Object.keys(check.provider) : [];
  if (remaining.includes(entry.sourceId) || remaining.length !== providerObject.members.length - 1) {
    throw new RemovalError("surgery-failed", `${filePath}: post-splice provider set mismatch`);
  }
  ctx.writeFile(filePath, entry.agentId, next);
}

// --- dsh (per-profile cordis.patch.yml) --------------------------------------
//
// Row-local text surgery with the same anchoring as dsh-merge-config.mjs's
// spliceProfileRow: the parse (js-yaml + the !!js-tolerant schema) answers
// "is the entry really there and what is its baseURL", and the text pass then
// excises exactly that provider's block inside the llm-pi-ai row. Anything
// that does not line up — unparseable file, non-array root, flow-style
// mappings, a key the text pass cannot locate — fails the entry with the file
// byte-for-byte untouched (the 2026-09-29 incident: broken patches are never
// "repaired" by rewrite).

const DSH_ROW_START_RE = new RegExp(`^([ \\t]*)- id:[ \\t]+${escapeRegExp(DSH_LLM_ENTRY_ID)}[ \\t]*(?:#.*)?$`);

function findDshBlockKeyLine(lines, from, to, key, minIndentLength) {
  const re = new RegExp(`^([ \\t]*)${key}[ \\t]*:[ \\t]*(?:#.*)?$`);
  for (let i = from; i < to; i += 1) {
    const match = re.exec(lines[i]);
    if (match && match[1].length > minIndentLength) return { index: i, indent: match[1] };
  }
  return null;
}

function exciseDshProvider(text, sourceId, emptied) {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  let rowStart = -1;
  let rowIndent = "";
  for (let i = 0; i < lines.length; i += 1) {
    const match = DSH_ROW_START_RE.exec(lines[i]);
    if (match) {
      rowStart = i;
      rowIndent = match[1];
      break;
    }
  }
  if (rowStart === -1) throw new RemovalError("unsupported-layout", `${DSH_LLM_ENTRY_ID} row not found in patch text`);
  let rowEnd = lines.length;
  const siblingRe = new RegExp(`^${escapeRegExp(rowIndent)}- `);
  for (let i = rowStart + 1; i < lines.length; i += 1) {
    if (siblingRe.test(lines[i])) {
      rowEnd = i;
      break;
    }
  }

  // Flow-style `config: {...}` / `providers: {...}` never matches these
  // block-mapping anchors and fails closed as unsupported-layout.
  const configLine = findDshBlockKeyLine(lines, rowStart + 1, rowEnd, "config", rowIndent.length);
  if (!configLine) throw new RemovalError("unsupported-layout", "config is not a block mapping");
  const providersLine = findDshBlockKeyLine(lines, configLine.index + 1, rowEnd, "providers", configLine.indent.length);
  if (!providersLine) throw new RemovalError("unsupported-layout", "providers is not a block mapping");

  const escaped = escapeRegExp(sourceId);
  const keyRe = new RegExp(`^([ \\t]+)(?:"${escaped}"|'${escaped}'|${escaped})[ \\t]*:[ \\t]*(?:\\S.*)?$`);
  let keyIndex = -1;
  let keyIndent = "";
  for (let i = providersLine.index + 1; i < rowEnd; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) {
      const indent = lines[i].match(/^[ \t]*/)[0];
      if (indent.length <= providersLine.indent.length) break; // left the providers map
    }
    const match = keyRe.exec(lines[i]);
    if (match && match[1].length > providersLine.indent.length) {
      keyIndex = i;
      keyIndent = match[1];
      break;
    }
  }
  if (keyIndex === -1) {
    throw new RemovalError("unsupported-layout", `provider key "${sourceId}" not found in patch text`);
  }

  // The block runs to the next content line at its own indent or shallower
  // (a sibling provider key, or the end of the map). Blank/comment lines at
  // the tail of that range stay — they may belong to what follows.
  let end = rowEnd;
  for (let i = keyIndex + 1; i < rowEnd; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = lines[i].match(/^[ \t]*/)[0];
    if (indent.length <= keyIndent.length) {
      end = i;
      break;
    }
  }
  while (end - 1 > keyIndex && (lines[end - 1].trim() === "" || lines[end - 1].trim().startsWith("#"))) end -= 1;

  const next = [...lines.slice(0, keyIndex), ...lines.slice(end)];
  // An emptied map must stay an explicit empty map: a bare `providers:` line
  // would parse back as null instead of {}.
  if (emptied) next[providersLine.index] = `${providersLine.indent}providers: {}`;
  const out = next.join("\n").replace(/\n+$/, "");
  return out.length ? `${out}\n` : "";
}

async function removeDshEntry(entry, ctx) {
  const filePath = entry.sourcePath;
  if (!existsSync(filePath)) throw new RemovalError("entry-not-found", filePath);
  const text = readFileSync(filePath, "utf8");
  const yaml = await getYamlModule();
  let entries;
  try {
    entries = yaml.load(stripBom(text), { schema: dshYamlSchema(yaml) });
  } catch (error) {
    throw new RemovalError("unparseable-source", `${filePath}: ${error.message}`);
  }
  if (!Array.isArray(entries)) {
    throw new RemovalError("unparseable-source", `${filePath}: root is not an array`);
  }
  const row = entries.find((item) => item && typeof item === "object" && item.id === DSH_LLM_ENTRY_ID);
  if (!row) throw new RemovalError("entry-not-found", `no ${DSH_LLM_ENTRY_ID} row in ${filePath}`);
  const providers = isRecord(row.config) && isRecord(row.config.providers) ? row.config.providers : null;
  if (!providers || !Object.hasOwn(providers, entry.sourceId)) {
    throw new RemovalError("entry-not-found", `${entry.sourceId} in ${filePath}`);
  }
  assertEntryIdentity(entry, providers[entry.sourceId]?.baseURL);
  const emptied = Object.keys(providers).length === 1;
  ctx.writeFile(filePath, entry.agentId, exciseDshProvider(text, entry.sourceId, emptied));
}

// --- driver ------------------------------------------------------------------

const HANDLERS = {
  zcode: removeZcodeEntry,
  kimi: removeKimiEntry,
  codex: removeCodexEntry,
  opencode: removeOpencodeEntry,
  pi: removePiEntry,
  dsh: removeDshEntry,
  qoder: removeQoderEntry,
  grok: removeGrokEntry,
};

/**
 * Remove the imported entries from their endpoint-local config files.
 *
 * @param {Array} entries candidate records from the import service's ticket
 * @param {{ backupRoot: string, now?: Date|number|Function }} options
 * @returns {Promise<{ removed: string[], failed: Array<{key, error}>, backupDir: string|null }>}
 */
export async function removeImportedEntries(entries, { backupRoot, now } = {}) {
  const removed = [];
  const failed = [];
  const ctx = makeWriteContext(backupRoot, now);
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key =
      typeof entry?.key === "string" && entry.key
        ? entry.key
        : `${entry?.agentId ?? "?"}::${entry?.sourceId ?? "?"}`;
    try {
      if (!isRecord(entry)) throw new RemovalError("invalid-entry");
      const { agentId, sourcePath, sourceId } = entry;
      if (typeof agentId !== "string" || typeof sourcePath !== "string" || typeof sourceId !== "string" || !sourcePath || !sourceId) {
        throw new RemovalError("invalid-entry");
      }
      if (typeof entry.baseURL !== "string" || entry.baseURL.trim() === "") {
        throw new RemovalError("invalid-entry", "baseURL");
      }
      const handler = HANDLERS[agentId];
      if (!handler) throw new RemovalError("unknown-agent", agentId);
      assertNotManagedId(entry);
      await handler(entry, ctx);
      removed.push(key);
    } catch (error) {
      failed.push({
        key,
        error: error instanceof RemovalError ? error.message : `unexpected: ${error?.message ?? String(error)}`,
      });
    }
  }
  return { removed, failed, backupDir: ctx.backupDir() };
}
