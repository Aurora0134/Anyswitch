// Prompt presets injection plane: renders the effective preset set of each
// endpoint into that endpoint's home-level global instructions file as a
// managed block. Every preset is rendered as a titled section (heading +
// body) — the agent reads the preset's subject and its rules together.
//
// Target facts this module depends on:
//   - kimi/opencode re-read their file at runtime (hot); the other six read
//     it once at session start — surfaced to the UI as `hotReload`.
//   - qoder: `~/.qoder/rules/**/*.md` is a user-level injection surface in
//     Qoder Desktop, and its loaded text is observable in model context. A
//     rule file with no loading frontmatter defaults to `always_on`, and
//     Qoder keeps watching a rule file once loaded, so edits land on the next
//     turn → hotReload true. `~/.qoder/AGENTS.md` injects too but is read only
//     at session start and is the user's own file — hence rules.
//   - grok: `$GROK_HOME/rules/` (default `~/.grok/rules/`) is a home-level
//     rules directory Grok always scans — every *.md directly inside it loads
//     as a user rule. Rules are read at session start with no file watcher
//     (same treatment as codex) → hotReload false. Anyswitch never touches
//     ~/.grok/AGENTS.md — hence a dedicated file under rules/.
//   - workbuddy: Electron desktop shell + bundled CodeBuddy Code CLI. No
//     WorkBuddy code path reads ~/.workbuddy/AGENTS.md; the user-level injection surface is
//     the rules dir `<config dir>/rules` (default `~/.workbuddy/rules`), whose
//     *.md files load as user rules when no `paths` frontmatter is present
//     (alwaysApply defaults true, single-file cap 40k chars). Read once at
//     session start → hotReload false. A dedicated file under rules/, never
//     the user's own AGENTS.md.
//
// Managed-block semantics:
//   - empty effective set removes the block; when the file holds only the
//     block the file itself is deleted, and the one blank separator line we
//     appended is reclaimed (inject → remove restores the original bytes).
//   - non-empty set replaces an existing block, or appends after a blank
//     separator line.
//   - a dangling begin marker (no end) swallows the rest of the file; the
//     next sync rewrites that whole region (safest recovery from hand edits).
//   - writes go through atomicWriteFile; a missing file is treated as empty
//     and only created when there is content to inject; an unchanged result
//     is not written (idempotent).
//   - per-endpoint failures are isolated: syncAll collects per-endpoint
//     { ok:true } / { ok:false, error } and never aborts the batch.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../store/atomic-write.mjs";

export const MANAGED_BEGIN = "# >>> anyswitch-managed-prompts";
export const MANAGED_END = "# <<< anyswitch-managed-prompts";

// `home` parts are relative to the user's home directory. `targetRel` is the
// human-facing display string for the panel.
export const PROMPT_ENDPOINTS = Object.freeze([
  { id: "claude", label: "Claude Code", hotReload: false, targetRel: "~/.claude/CLAUDE.md", home: [".claude", "CLAUDE.md"] },
  { id: "kimi", label: "Kimi Code", hotReload: true, targetRel: "~/.kimi-code/AGENTS.md", home: [".kimi-code", "AGENTS.md"] },
  { id: "zcode", label: "ZCode", hotReload: false, targetRel: "~/.zcode/AGENTS.md", home: [".zcode", "AGENTS.md"] },
  { id: "dsh", label: "DeepSeek Harness", hotReload: false, targetRel: "~/.dsh/AGENTS.md", home: [".dsh", "AGENTS.md"] },
  { id: "pi", label: "Pi", hotReload: false, targetRel: "~/.pi/agent/AGENTS.md", home: [".pi", "agent", "AGENTS.md"] },
  { id: "opencode", label: "OpenCode", hotReload: true, targetRel: "~/.config/opencode/AGENTS.md", home: [".config", "opencode", "AGENTS.md"] },
  { id: "qoder", label: "Qoder", hotReload: true, targetRel: "~/.qoder/rules/anyswitch-managed-prompts.md", home: [".qoder", "rules", "anyswitch-managed-prompts.md"] },
  { id: "codex", label: "Codex", hotReload: false, targetRel: "~/.codex/AGENTS.md", home: [".codex", "AGENTS.md"] },
  { id: "grok", label: "Grok Build", hotReload: false, targetRel: "~/.grok/rules/anyswitch-managed-prompts.md", home: [".grok", "rules", "anyswitch-managed-prompts.md"] },
  // WorkBuddy（Electron 桌面壳 + 内置 CodeBuddy Code CLI）：用户级规则目录
  // ~/.workbuddy/rules 是唯一会被会话读取的全局面（AGENTS.md 无人读）；会话
  // 启动时扫描一次，故 hotReload:false。
  { id: "workbuddy", label: "WorkBuddy", hotReload: false, targetRel: "~/.workbuddy/rules/anyswitch-managed-prompts.md", home: [".workbuddy", "rules", "anyswitch-managed-prompts.md"] },
]);

/**
 * Normalize a preset title into one heading line: newlines fold to spaces,
 * whitespace collapses, a leading `#` run is dropped, and a trailing ATX
 * closing sequence is dropped — so the title cannot nest inside the host
 * document's own heading structure. The closing `#`s must be preceded by
 * whitespace: `C#` is a word, not a closing sequence.
 */
function normalizeTitle(title) {
  if (typeof title !== "string") return "";
  return title
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/\s+#+$/, "")
    .trim();
}

/**
 * Render the managed block for a non-empty preset set. Each preset becomes a
 * titled section — the heading carries the preset's subject, the body its
 * rules — so the agent reads subject and rules together instead of a wall of
 * unlabelled paragraphs. A preset with no usable title falls back to a body
 * paragraph (no empty heading); a preset with a title but no body keeps the
 * heading, so every enabled preset stays countable in the file.
 *
 * Bodies are injected verbatim: a body carrying its own markdown heading would
 * break out of the preset's section, so the authoring rules keep headings out
 * of bodies rather than the injector rewriting user text.
 */
export function buildManagedBlock(presets) {
  const lines = [MANAGED_BEGIN];
  for (const preset of presets) {
    const title = normalizeTitle(preset.title);
    const body = typeof preset.content === "string" ? preset.content.trimEnd() : "";
    if (title) lines.push("", `## ${title}`);
    if (body) lines.push("", body);
  }
  lines.push("", MANAGED_END);
  return lines.join("\n");
}

/**
 * Apply (block !== null) or remove (block === null) the managed block in
 * `text`, returning the new file content. Pure string transform — the caller
 * decides whether the result warrants a write or a file delete.
 */
export function applyManagedBlock(text, block) {
  const beginIdx = text.indexOf(MANAGED_BEGIN);

  if (beginIdx === -1) {
    if (block === null) return text;
    if (text === "") return `${block}\n`;
    const sep = text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${sep}${block}\n`;
  }

  const endIdx = text.indexOf(MANAGED_END, beginIdx);
  // A dangling begin marker swallows the rest of the file.
  let after = endIdx === -1 ? "" : text.slice(endIdx + MANAGED_END.length);
  if (after.startsWith("\r\n")) after = after.slice(2);
  else if (after.startsWith("\n")) after = after.slice(1);

  if (block !== null) {
    const before = text.slice(0, beginIdx);
    return after === "" ? `${before}${block}\n` : `${before}${block}\n${after}`;
  }

  // Removal: reclaim the one blank separator line the append added, so an
  // inject → remove round-trip restores the original bytes.
  let start = beginIdx;
  if (beginIdx >= 2 && text.slice(beginIdx - 2, beginIdx) === "\n\n") start = beginIdx - 1;
  const before = text.slice(0, start);
  return after === "" ? before : `${before}${after}`;
}

/**
 * Injection service. `homeDir` is injectable so tests run entirely against
 * temp directories; production derives it from os.
 */
export function createPromptsInjector({ homeDir = homedir() } = {}) {
  function targetFor(def) {
    return join(homeDir, ...def.home);
  }

  function listEndpoints() {
    return PROMPT_ENDPOINTS.map((def) => ({
      id: def.id,
      label: def.label,
      hotReload: def.hotReload,
      targetRel: def.targetRel,
      target: targetFor(def),
    }));
  }

  function findDef(endpointId) {
    const def = PROMPT_ENDPOINTS.find((d) => d.id === endpointId);
    if (!def) {
      const error = new Error(`未知端点: ${endpointId}`);
      error.statusCode = 400;
      throw error;
    }
    return def;
  }

  /**
   * Sync one endpoint's instructions file to its effective preset set.
   * Returns { ok:true, changed, removed?, target }.
   */
  function syncEndpoint(endpointId, presets) {
    const def = findDef(endpointId);
    const target = targetFor(def);
    const block = presets.length > 0 ? buildManagedBlock(presets) : null;
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;

    if (current === null && block === null) return { ok: true, changed: false, target };

    const next = applyManagedBlock(current ?? "", block);
    if (current !== null && next === current) return { ok: true, changed: false, target };

    // The file held only the managed block: remove the file itself.
    if (next === "") {
      rmSync(target, { force: true });
      return { ok: true, changed: true, removed: true, target };
    }
    mkdirSync(dirname(target), { recursive: true });
    atomicWriteFile(target, next);
    return { ok: true, changed: true, target };
  }

  /**
   * Sync every endpoint. `resolveFn(endpointId)` must return that endpoint's
   * effective preset array. Per-endpoint failures are collected, never thrown.
   */
  function syncAll(resolveFn) {
    const results = {};
    for (const def of PROMPT_ENDPOINTS) {
      try {
        syncEndpoint(def.id, resolveFn(def.id));
        results[def.id] = { ok: true };
      } catch (error) {
        results[def.id] = { ok: false, error: error?.message ?? String(error) };
      }
    }
    return results;
  }

  return {
    listEndpoints,
    hasEndpoint: (endpointId) => PROMPT_ENDPOINTS.some((d) => d.id === endpointId),
    syncEndpoint,
    syncAll,
  };
}
