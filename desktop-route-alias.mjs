// Claude Desktop 3p picker brand filter + deterministic route aliasing.
// Pure functions only. No IO, no network, no DPAPI.
//
// The official 3p deployment's model picker only lists route ids that look
// like Anthropic models. The test (verbatim from the Claude Desktop 2.9939.2
// app.asar, applied to BOTH discovery results and a static inferenceModels
// list, with no config switch to disable it): the id must not mention a
// competitor brand (the blocklist below) and must either be a bare tier name
// or contain a Claude-family word. The refusal text names the contract for
// gateways: "Name routes to match the underlying model" — the real name rides
// the display_name / labelOverride fields, which are never filtered.
//
// So the desktop catalog view renames exactly the entries whose wire id fails
// that test to a deterministic single-segment route alias
// ("anthropic/<code>"). A single-segment alias can never collide with a real
// two-segment wire id (the same property the auto/virtual-model ids rely on);
// "auto" and every served single-segment virtual-model id are reserved
// explicitly anyway. The code is a salted sha256-base36 hash of the wire id's
// tail — stable across restarts, re-derivable at request time from the live
// catalog without any persisted mapping, and re-salted on blocklist hits and
// in-table collisions so the table is always injective.

import { createHash } from "node:crypto";

export const DESKTOP_PICKER_BLOCKLIST =
  /ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|\bk2\.|\bm2\.|jamba|arctic|solar|mercury|zamba|kat-coder|\bds-|dpsk/;

const TIER_NAME_RE = /^(sonnet|opus|haiku|fable|mythos)(-[\d.]+)?$/;
const ANTHROPIC_FAMILY_WORDS = ["claude", "sonnet", "opus", "haiku", "fable", "mythos", "anthropic"];

// The desktop picker's admission test, verbatim semantics: not a blocked
// brand, and either a bare tier name or carrying a Claude-family word.
export function passesDesktopPickerFilter(id) {
  const t = String(id).toLowerCase();
  return (
    !DESKTOP_PICKER_BLOCKLIST.test(t) &&
    (TIER_NAME_RE.test(t) || ANTHROPIC_FAMILY_WORDS.some((word) => t.includes(word)))
  );
}

const ALIAS_PREFIX = "anthropic/";
const ALIAS_CODE_LEN = 6;

function tailOf(wireId) {
  return wireId.slice(ALIAS_PREFIX.length);
}

function aliasCodeFor(tail, salt) {
  const digest = createHash("sha256").update(`${salt}:${tail}`).digest();
  return digest.readUInt32BE(0).toString(36).padStart(ALIAS_CODE_LEN, "0").slice(0, ALIAS_CODE_LEN);
}

// Deterministic alias table for one catalog. Entries whose wire id passes the
// desktop filter keep their id; every failing one is re-issued as
// "anthropic/<code>". Returns the mapped entries plus alias -> real wire id.
export function buildDesktopCatalogView(entries) {
  const reserved = new Set(["auto"]);
  const failing = [];
  for (const entry of entries) {
    const wireId = entry?.wireId;
    if (typeof wireId !== "string" || !wireId.startsWith(ALIAS_PREFIX)) continue;
    if (passesDesktopPickerFilter(wireId)) {
      // Single-segment served ids (virtual models) occupy their own tail.
      if (!tailOf(wireId).includes("/")) reserved.add(tailOf(wireId));
      continue;
    }
    failing.push(entry);
  }

  const used = new Set(reserved);
  const aliases = new Map(); // alias -> real wire id（对外：反解用）
  const aliasByReal = new Map(); // real -> alias（对内：改写目录行用）
  for (const entry of failing) {
    const tail = tailOf(entry.wireId);
    let code;
    for (let salt = 0; ; salt++) {
      code = aliasCodeFor(tail, salt);
      if (!used.has(code) && !DESKTOP_PICKER_BLOCKLIST.test(code)) break;
    }
    used.add(code);
    const alias = `${ALIAS_PREFIX}${code}`;
    aliases.set(alias, entry.wireId);
    aliasByReal.set(entry.wireId, alias);
  }

  return {
    entries: entries.map((entry) =>
      aliasByReal.has(entry?.wireId) ? { ...entry, wireId: aliasByReal.get(entry.wireId) } : entry,
    ),
    aliases,
  };
}

// Reverse lookup: a desktop-served alias back to the real wire id. Only
// single-segment "anthropic/<code>" strings can be aliases — every real wire
// id has a provider segment. Re-derives the table from the same entries the
// catalog served, so no mapping is persisted anywhere.
export function resolveDesktopAlias(model, entries) {
  if (typeof model !== "string" || !model.startsWith(ALIAS_PREFIX)) return null;
  const tail = tailOf(model);
  if (tail.length === 0 || tail.includes("/")) return null;
  return buildDesktopCatalogView(entries).aliases.get(model) ?? null;
}
