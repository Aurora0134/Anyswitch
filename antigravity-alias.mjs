// Dynamic alias table mapping antigravity's hardcoded Gemini slugs to store
// provider/model pairs. Pure functions + a small in-memory overlay for hot reload.
//
// WHY THIS EXISTS (and why it is dynamic, not static):
//
// agy's model allowlist is hardcoded in its Go binary (checked against 1.1.27,
// 2026-09-06): the catalog presents effort-suffixed entries (gemini-3.8-flash-high
// etc.) but strips the suffix client-side, so the relay only ever receives the
// base slugs below, plus a hidden helper slug gemini-3.1-flash-lite-preview.
// gemini-3.5-flash left the catalog in 1.1.27 (no catalog entry resolves to it
// anymore) but stays in the table: an old agy binary must keep working.
// agy refuses every other --model value before it ever reaches the SDK, so the
// relay cannot make agy request an arbitrary store model name — it can only
// receive one of these slugs and decide which store model that slug should *mean*.
//
// A static, fixed alias would permanently lock each slug to one backend and
// leave the rest of the store unreachable. Instead this module makes the binding
// a mutable file (`antigravity.json`) layered with an in-memory overlay, so the
// panel (or any control endpoint) can re-point a slug to a different store model
// at any time without restarting agy. Every store model stays reachable; at most
// one is live per slug at a given moment.
//
// On-disk shape (at %LOCALAPPDATA%\Anyswitch\antigravity.json):
//   {
//     "aliases": {
//       "gemini-3.1-pro-preview": "poke-api/claude-opus-4-8",
//       "gemini-3.5-flash": "deepseek/deepseek-v4-flash",
//       ...
//     }
//   }
// Each value is "<providerId>/<modelId>" (split on the first '/').

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

export const ALIAS_FILENAME = "antigravity.json";

// The slugs agy's binary actually emits on the wire in API-key mode. The alias
// table must cover all of them or a request for an uncovered slug would 404 even
// when the user expected a default. gemini-3.1-flash-lite-preview is a hidden
// helper agy uses for conversation-title generation; it is not in `agy models`
// but appears in live traffic. gemini-3.1-pro-high/low still emit the old
// gemini-3.1-pro-preview slug.
export const AGY_SLUGS = [
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
  "gemini-3.1-flash-lite-preview",
];

// The same slugs, split by how the settings UI must treat them. Normal slugs
// are user-visible chat models: each maps one-to-one to a store model of the
// same name (different providers offering that name are the alternatives). The
// small slug is agy's hidden helper for conversation-title generation: it may
// point at ANY enabled store model, chosen freely from the filtered catalog.
export const AGY_NORMAL_SLUGS = [
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
];
export const AGY_SMALL_SLUG = "gemini-3.1-flash-lite-preview";

export function aliasFilePath(root) {
  return join(root, ALIAS_FILENAME);
}

export function splitTarget(target) {
  if (typeof target !== "string" || target.length === 0) {
    return { ok: false, reason: "alias target must be a non-empty string" };
  }
  const cut = target.indexOf("/");
  if (cut === -1) {
    return { ok: false, reason: `alias target "${target}" has no '/' separating provider from model` };
  }
  const providerId = target.slice(0, cut);
  const modelId = target.slice(cut + 1);
  if (providerId.length === 0) {
    return { ok: false, reason: `alias target "${target}" has an empty provider segment` };
  }
  if (modelId.length === 0) {
    return { ok: false, reason: `alias target "${target}" has an empty model segment` };
  }
  return { ok: true, providerId, modelId };
}

// Build the default alias file contents: every agy slug → defaultTarget.
// Used when no file exists yet. The caller picks defaultTarget (a store model).
export function buildDefaultAliases(defaultTarget, slugs = AGY_SLUGS) {
  const aliases = {};
  for (const slug of slugs) {
    aliases[slug] = defaultTarget;
  }
  return { aliases };
}

class UnparseableAliasError extends Error {
  constructor(filePath) {
    super(`refusing to overwrite unparseable alias file: ${filePath}`);
    this.name = "UnparseableAliasError";
    this.code = "UNPARSEABLE_ALIAS";
  }
}
export { UnparseableAliasError };

// Read the on-disk alias file. Returns { aliases: {} } when absent. Throws
// UnparseableAliasError (fail-closed, like the zcode merge-config) when present
// but unparseable, so a corrupt file is never silently replaced.
export function readAliasFile(filePath) {
  if (!existsSync(filePath)) return { aliases: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new UnparseableAliasError(filePath);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { aliases: {} };
  }
  const aliases = parsed.aliases;
  if (aliases === null || typeof aliases !== "object" || Array.isArray(aliases)) {
    return { aliases: {} };
  }
  return { aliases };
}

export function writeAliasFile(filePath, data) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// Ensure an alias file exists with every agy slug covered. Existing entries are
// preserved; missing slugs are filled with defaultTarget. Returns the written
// contents (or the existing contents if nothing changed).
export function ensureAliasFile(filePath, defaultTarget, slugs = AGY_SLUGS) {
  const { aliases } = readAliasFile(filePath);
  let changed = false;
  const next = { ...aliases };
  for (const slug of slugs) {
    if (typeof next[slug] !== "string" || next[slug].length === 0) {
      next[slug] = defaultTarget;
      changed = true;
    }
  }
  if (changed) writeAliasFile(filePath, { aliases: next });
  return { aliases: next, changed };
}

// In-memory alias resolver. Layered: overlay (hot-reloaded by the panel) wins
// over the on-disk file. This is the object the Gemini handler calls per request.
//
// The file layer is cross-process live: the relay (47821) and the standalone
// panel host (47820) each own a resolver over the SAME antigravity.json, and a
// save from the panel process must take effect on the relay without a restart.
// Every resolve()/snapshot() therefore stats the file first and reloads the
// disk layer (dropping the overlay, which is by then stale) when (mtimeMs,
// size) changed. The POST /panel/api/antigravity/aliases flow writes the file
// BEFORE setAlias, so after its own reload the disk already carries the just-
// saved value — overlay and disk never disagree in practice. A stat failure
// (transient lock, antivirus hold) keeps the cached layers rather than
// dropping traffic to 404.
export function createAliasResolver({ filePath, overlay = {} }) {
  let disk = readAliasFile(filePath).aliases;
  let stamp = fileStamp(filePath);
  function fileStamp(path) {
    try {
      const s = statSync(path);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return null;
    }
  }
  function refreshIfChanged() {
    const next = fileStamp(filePath);
    if (next === stamp) return;
    stamp = next;
    disk = readAliasFile(filePath).aliases;
    for (const slug of Object.keys(overlay)) delete overlay[slug];
  }
  return {
    reload() {
      disk = readAliasFile(filePath).aliases;
      stamp = fileStamp(filePath);
    },
    // Returns { ok, providerId, modelId } or { ok:false, reason }.
    resolve(slug) {
      refreshIfChanged();
      const target = overlay[slug] ?? disk[slug];
      if (target === undefined) {
        return { ok: false, reason: `slug "${slug}" has no alias binding` };
      }
      return splitTarget(target);
    },
    setAlias(slug, target) {
      const split = splitTarget(target);
      if (!split.ok) return split;
      overlay[slug] = target;
      return { ok: true, providerId: split.providerId, modelId: split.modelId };
    },
    clearAlias(slug) {
      delete overlay[slug];
    },
    snapshot() {
      refreshIfChanged();
      const out = {};
      for (const slug of Object.keys(disk)) out[slug] = disk[slug];
      for (const slug of Object.keys(overlay)) out[slug] = overlay[slug];
      return out;
    },
    _disk: () => disk,
    _overlay: overlay,
  };
}
