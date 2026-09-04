// Prompt presets data plane: prompts.json next to settings.json in the relay
// data root. A preset is a prompt fragment injected into every endpoint's
// global instructions file (see agent-prompts-inject.mjs); the master switch
// plus per-preset `enabled` plus per-endpoint `off` overrides decide the
// effective set for an endpoint:
//   effective = master.enabled AND preset.enabled AND NOT endpoint.off[id]
//
// Persistence discipline mirrors relay-settings.mjs:
//   - read path degrades to defaults on a corrupt file (panel stays usable);
//   - write path fails closed: the unparseable original is quarantined to
//     `prompts.json.corrupt-<ts>` and the write is refused, so a corrupt file
//     is never silently overwritten.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./atomic-write.mjs";
import { relayDataRoot } from "./relay-settings.mjs";

export const MAX_CONTENT_BYTES = 32 * 1024;
export const MAX_TITLE_LENGTH = 200;
export const MAX_TAG_LENGTH = 50;

export function promptsPath(base = process.env) {
  return join(relayDataRoot(base), "prompts.json");
}

// Mirrors UnparseableSettingsError in relay-settings.mjs: a file we cannot
// parse must never be treated as empty and then overwritten. The corrupt
// original is quarantined next to it before this error is thrown.
export class UnparseablePromptsError extends Error {
  constructor(filePath, backupPath) {
    super(`refusing to overwrite unparseable prompts: ${filePath} (backup: ${backupPath})`);
    this.name = "UnparseablePromptsError";
    this.code = "UNPARSEABLE_PROMPTS";
    this.backupPath = backupPath;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

function defaultState() {
  return { enabled: false, presets: [], endpointOverrides: {} };
}

// Coerce persisted JSON into the canonical shape; entries that cannot carry
// their role (missing id/title/content) are dropped rather than failing the
// whole read. Off lists are deduped and pruned to live preset ids.
function normalizeState(raw) {
  const state = defaultState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return state;
  state.enabled = raw.enabled === true;
  if (Array.isArray(raw.presets)) {
    for (const p of raw.presets) {
      if (!p || typeof p !== "object") continue;
      if (typeof p.id !== "string" || !p.id) continue;
      if (typeof p.title !== "string") continue;
      if (typeof p.content !== "string") continue;
      state.presets.push({
        id: p.id,
        title: p.title,
        tag: typeof p.tag === "string" ? p.tag : "",
        enabled: p.enabled !== false,
        content: p.content,
        createdAt: typeof p.createdAt === "string" ? p.createdAt : null,
        updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null,
      });
    }
  }
  const liveIds = new Set(state.presets.map((p) => p.id));
  if (raw.endpointOverrides && typeof raw.endpointOverrides === "object" && !Array.isArray(raw.endpointOverrides)) {
    for (const [endpointId, value] of Object.entries(raw.endpointOverrides)) {
      if (!value || typeof value !== "object" || !Array.isArray(value.off)) continue;
      const off = [...new Set(value.off.filter((id) => typeof id === "string" && liveIds.has(id)))];
      if (off.length > 0) state.endpointOverrides[endpointId] = { off };
    }
  }
  return state;
}

function validateTitle(title) {
  if (typeof title !== "string" || !title.trim()) throw badRequest("title 不能为空");
  const trimmed = title.trim();
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw badRequest(`title 超长（${trimmed.length} > ${MAX_TITLE_LENGTH} 字符）`);
  }
  return trimmed;
}

function validateTag(tag) {
  if (tag === undefined || tag === null) return "";
  if (typeof tag !== "string") throw badRequest("tag 必须是字符串");
  const trimmed = tag.trim();
  if (trimmed.length > MAX_TAG_LENGTH) {
    throw badRequest(`tag 超长（${trimmed.length} > ${MAX_TAG_LENGTH} 字符）`);
  }
  return trimmed;
}

function validateContent(content) {
  if (typeof content !== "string") throw badRequest("content 必须是字符串");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_CONTENT_BYTES) {
    throw badRequest(`content 超长（${bytes} > ${MAX_CONTENT_BYTES} 字节）`);
  }
  return content;
}

function validateId(id, field = "id") {
  if (typeof id !== "string" || !id.trim()) throw badRequest(`${field} 不能为空`);
  return id.trim();
}

function validateBoolean(value, field) {
  if (typeof value !== "boolean") throw badRequest(`${field} 必须是布尔值`);
  return value;
}

function newPresetId() {
  // 9 random bytes → 12 base64url characters.
  return randomBytes(9).toString("base64url");
}

function findPreset(state, id) {
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) throw notFound(`预设不存在: ${id}`);
  return preset;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Data-plane service for the Prompts tab. Every method loads the current
 * state from disk, mutates and saves atomically — no in-memory cache, so
 * concurrent panel processes never act on a stale snapshot. Injectable
 * `base` (env-like { LOCALAPPDATA }) keeps tests on temp directories.
 */
export function createPromptsService({ base = process.env } = {}) {
  const filePath = promptsPath(base);

  function load() {
    if (!existsSync(filePath)) return defaultState();
    try {
      return normalizeState(JSON.parse(readFileSync(filePath, "utf8")));
    } catch {
      return defaultState();
    }
  }

  function save(state) {
    // Fail closed on a corrupt prompts.json: load() deliberately swallows
    // parse errors (read path degrades to defaults), so re-check the raw
    // bytes here — otherwise the write below would silently destroy them.
    if (existsSync(filePath)) {
      let parseable = true;
      try {
        JSON.parse(readFileSync(filePath, "utf8"));
      } catch {
        parseable = false;
      }
      if (!parseable) {
        const backupPath = `${filePath}.corrupt-${timestamp()}`;
        copyFileSync(filePath, backupPath);
        throw new UnparseablePromptsError(filePath, backupPath);
      }
    }
    mkdirSync(dirname(filePath), { recursive: true });
    atomicWriteFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  return {
    getState() {
      return load();
    },

    setMaster(enabled) {
      const state = load();
      state.enabled = validateBoolean(enabled, "enabled");
      save(state);
      return { enabled: state.enabled };
    },

    createPreset({ title, tag, content } = {}) {
      const state = load();
      const now = new Date().toISOString();
      const preset = {
        id: newPresetId(),
        title: validateTitle(title),
        tag: validateTag(tag),
        enabled: true,
        content: validateContent(content),
        createdAt: now,
        updatedAt: now,
      };
      state.presets.push(preset);
      save(state);
      return { preset: clone(preset) };
    },

    updatePreset({ id, title, tag, content } = {}) {
      const state = load();
      const preset = findPreset(state, validateId(id));
      preset.title = validateTitle(title);
      preset.tag = validateTag(tag);
      preset.content = validateContent(content);
      preset.updatedAt = new Date().toISOString();
      save(state);
      return { preset: clone(preset) };
    },

    deletePreset(id) {
      const state = load();
      const presetId = validateId(id);
      findPreset(state, presetId);
      state.presets = state.presets.filter((p) => p.id !== presetId);
      for (const [endpointId, value] of Object.entries(state.endpointOverrides)) {
        const off = value.off.filter((offId) => offId !== presetId);
        if (off.length > 0) state.endpointOverrides[endpointId] = { off };
        else delete state.endpointOverrides[endpointId];
      }
      save(state);
      return {};
    },

    setPresetEnabled({ id, enabled } = {}) {
      const state = load();
      const preset = findPreset(state, validateId(id));
      preset.enabled = validateBoolean(enabled, "enabled");
      preset.updatedAt = new Date().toISOString();
      save(state);
      return { id: preset.id, enabled: preset.enabled };
    },

    setOverride({ endpointId, presetId, off } = {}) {
      const state = load();
      const ep = validateId(endpointId, "endpointId");
      const pid = validateId(presetId, "presetId");
      findPreset(state, pid);
      const offFlag = validateBoolean(off, "off");
      const current = state.endpointOverrides[ep]?.off ?? [];
      const next = offFlag ? [...new Set([...current, pid])] : current.filter((id) => id !== pid);
      if (next.length > 0) state.endpointOverrides[ep] = { off: next };
      else delete state.endpointOverrides[ep];
      save(state);
      return { endpointId: ep, presetId: pid, off: offFlag };
    },

    /** Effective preset set for one endpoint, in stored order. */
    resolveForEndpoint(endpointId) {
      const state = load();
      if (!state.enabled) return [];
      const off = new Set(state.endpointOverrides[endpointId]?.off ?? []);
      return state.presets.filter((p) => p.enabled && !off.has(p.id)).map(clone);
    },
  };
}
