// Hub-owned reasoning effort fallback backed by the pi-ai model knowledge base.
// Pure functions over a preloaded index (buildReasoningIndex /
// resolveKnowledgeReasoning); the loader below is the only IO touchpoint.
//
// Why this exists: DSH materializes a custom provider route's reasoning
// capability ONLY from settings.yaml (`entry.reasoningEfforts`); for a route
// the installed pi-ai catalog does not describe (every apicred `_provider`
// route), `base` is undefined and `resolveModelReasoning` returns
// `reasoning: false` — the reasoning effort selector never renders. The
// upstream `/v1/models` listing carries no reasoning fields either, so
// discovery cannot source them. But the pi-ai package DSH itself runs on
// ships `dist/providers/data/*.json` — the same database pi-ai's dispatch
// reads — keyed by model id, including `thinkingLevelMap` (level → wire
// spelling) and `compat.thinkingFormat`. Matching those entries by MODEL id
// (not provider route name) resolves the wire-exact effort levels.
//
// Priority inside resolveModelReasoningLevels callers (dsh-merge-config.mjs):
//   1. store model.reasoningEffortLevels (per-model, explicit)
//   2. provider.reasoningVariants (provider-level template)
//   3. pi-ai knowledge base entry matched by model id  ← this module
//
// DSH thinking levels (dsh-llm-pi-ai THINKING_LEVELS): off, minimal, low,
// medium, high, xhigh, max. A catalog `thinkingLevelMap` key outside that set
// (e.g. "enabled") is normalized to the binary off/low toggle the model
// actually speaks.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const nodeFs = { readdirSync, readFileSync, existsSync };

const DSH_THINKING_LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

// Wire formats pi-ai's openai-completions dispatch implements branches for
// (openai-completions.js: thinkingFormat === "zai" | "qwen" | ...). Anything
// else — or none — means plain OpenAI-style reasoning_effort, which needs no
// thinkingFormat in settings.yaml. "qwen-chat-template" and "chat-template"
// are deliberately excluded: dsh-llm-pi-ai withholds them from profiles.
const WIRE_THINKING_FORMATS = new Set([
  "openai",
  "deepseek",
  "openrouter",
  "together",
  "zai",
  "qwen",
  "string-thinking",
  "ant-ling",
]);

/**
 * Build the model-id → knowledge index from parsed pi-ai provider data files.
 *
 * Files are shaped `{ "<api>": { "<modelId>": { ...model } } }`. The same
 * model id often appears in several files (the vendor's own entry plus
 * gateway mirrors); the entry with the most dispatch knowledge — a
 * thinkingLevelMap plus a wire thinkingFormat — wins, and an exact tie keeps
 * the first file, deterministically.
 *
 * @param {Array<Record<string, Record<string, any>>>} files - parsed provider data JSON documents.
 * @returns {Map<string, {levels: string[], wireValues: Record<string, string|null>, thinkingFormat: string|null}>}
 */
export function buildReasoningIndex(files) {
  const index = new Map();
  const entryScore = (entry) => (entry.hasMap ? 2 : 0) + (entry.thinkingFormat ? 1 : 0);
  const add = (id, entry) => {
    const existing = index.get(id);
    if (existing && entryScore(existing) >= entryScore(entry)) return;
    index.set(id, entry);
  };
  for (const doc of files) {
    if (!doc || typeof doc !== "object") continue;
    for (const apiBlock of Object.values(doc)) {
      if (!apiBlock || typeof apiBlock !== "object") continue;
      for (const [id, model] of Object.entries(apiBlock)) {
        if (!model || typeof model !== "object") continue;
        if (model.reasoning !== true) continue;
        const map = model.thinkingLevelMap;
        const hasMap = map && typeof map === "object";
        const format = model.compat?.thinkingFormat;
        add(id, {
          hasMap,
          levels: hasMap
            ? Object.keys(map).filter((l) => map[l] !== null)
            : [],
          wireValues: hasMap ? { ...map } : {},
          thinkingFormat:
            typeof format === "string" && WIRE_THINKING_FORMATS.has(format)
              ? format
              : null,
        });
      }
    }
  }
  return index;
}

/** Whether a level name is a DSH thinking level. */
function isDshLevel(level) {
  return DSH_THINKING_LEVELS.includes(level);
}

/**
 * Resolve the reasoning efforts DSH should offer for one model from a
 * knowledge index entry, in the shape settings.yaml consumes:
 * `{ levels: [...], wireValues: {level: wire}, thinkingFormat }`.
 *
 * Non-DSH level spellings ("enabled" and friends) collapse to a binary
 * off/low declaration — the model either thinks or does not, so the lowest
 * DSH level carries the toggle and `off` disables it. Levels whose wire
 * value is null are dropped (pi-ai pins them unsupported).
 *
 * An entry with NO thinkingLevelMap at all is a reasoning model pi-ai treats
 * with its base-level default: the five base levels (minimal..max) are
 * "supported, send the level verbatim" — only xhigh/max can be unsupported.
 * That is exactly `reasoningEfforts: { off: null, low: "low", ... }` with the
 * base levels spelled out, so an entry with no map and no usable level
 * resolves to the base levels rather than null. Null is reserved for entries
 * that cannot serve any effort.
 *
 * @param {{levels: string[], wireValues: Record<string, string|null>, thinkingFormat: string|null}|undefined} entry
 * @returns {{levels: string[], wireValues: Record<string, string|null>, thinkingFormat: string|null}|null}
 */
export function resolveKnowledgeReasoning(entry) {
  if (!entry) return null;
  const levels = [];
  const wireValues = {};
  for (const raw of entry.levels) {
    if (!isDshLevel(raw)) continue;
    const wire = entry.wireValues[raw];
    if (wire === null || wire === undefined) continue;
    levels.push(raw);
    wireValues[raw] = wire;
  }
  if (levels.length === 0) {
    const toggles = Object.entries(entry.wireValues).filter(
      ([, wire]) => typeof wire === "string" && wire.length > 0,
    );
    if (toggles.length > 0) {
      // Binary-toggle model (e.g. thinkingLevelMap { enabled: "...", off: null }):
      // any non-DSH truthy level means the model thinks on demand.
      levels.push("low");
      wireValues.low = toggles[0][1];
    } else if (!entry.hasMap) {
      // No map: pi-ai's default — the five base levels send verbatim.
      for (const lvl of ["minimal", "low", "medium", "high", "max"]) {
        levels.push(lvl);
        wireValues[lvl] = lvl;
      }
    } else {
      return null;
    }
  }
  return { levels, wireValues, thinkingFormat: entry.thinkingFormat };
}

/**
 * Build the knowledge index from the pi-ai package installed under DSH's
 * node_modules — the exact database the running DSH dispatches with, so the
 * wire spellings injected into settings.yaml match what pi-ai sends upstream.
 * Returns an empty index (not a throw) when the package is missing or
 * unreadable: reasoning fallback is best-effort and must never block the
 * DSH settings sync.
 *
 * @param {string} dshPackageRoot - the `@deepseek-ai/dsh` package directory.
 * @param {{readdirSync?: Function, readFileSync?: Function, existsSync?: Function}} [io] - injectable IO for tests.
 * @returns {Map<string, any>}
 */
export function loadPiAiReasoningIndex(dshPackageRoot, io = {}) {
  const readdir = io.readdirSync ?? nodeFs.readdirSync;
  const readFile = io.readFileSync ?? nodeFs.readFileSync;
  const exists = io.existsSync ?? nodeFs.existsSync;
  const dataDir = join(
    dshPackageRoot,
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "providers",
    "data",
  );
  if (!exists(dataDir)) return new Map();
  let files;
  try {
    files = readdir(dataDir).filter((f) => f.endsWith(".json"));
  } catch {
    return new Map();
  }
  const docs = [];
  for (const f of files) {
    try {
      docs.push(JSON.parse(readFile(join(dataDir, f), "utf8")));
    } catch {
      // one malformed file must not sink the index
    }
  }
  return buildReasoningIndex(docs);
}
