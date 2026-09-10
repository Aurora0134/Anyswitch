// Session scan data layer for the panel「会话管理」tab: stateless on-demand
// scan of each managed agent's on-disk session stores. No index, no DB of our
// own — every list call re-reads the agents' files (cc-switch's session_manager
// pattern, translated to Node).
//
// One adapter per endpoint, unified shape:
//   { id, roots(), scan(), loadMessages(file), delete(file) }
// scan() returns SessionMeta[] with the 9-field contract (REVIEW-FINDINGS B1):
//   endpoint / id / title / summary / project / file / createdAt / lastActive /
//   resumeCommand
// loadMessages(file) returns { role, content, ts }[] (or a degraded note for
// endpoints without a real transcript). delete(file) removes the session after
// a canonicalize + roots() whitelist check (path-traversal guard).
//
// Privacy red line: session CONTENT is never written to any log/journal — this
// module only reads from disk and returns data to the panel router.
//
// Adapter roots are overridable per instance (createSessionScanner({ roots:
// { claude: [dir] } })) so tests run entirely against temp dirs.

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Shared constants & small helpers (translations of cc-switch providers/utils.rs)
// ---------------------------------------------------------------------------

// Max chars for session titles, shared across adapters (cc-switch TITLE_MAX_CHARS).
const TITLE_MAX_CHARS = 80;
// Summary preview cap on the list rows (cc-switch truncate_summary(.., 160)).
const SUMMARY_MAX_CHARS = 160;

// Resume-command template table — the single place commands are assembled.
// The frontend treats resumeCommand as an opaque string and never builds one
// itself (REVIEW-FINDINGS B2). Empty string = syntax not verified with
// `--help`; the UI greys out the resume button for those endpoints.
// Verified 2026-09-08 on this machine:
//   claude --resume <id>     (claude --help: "-r, --resume [value] Resume a conversation by session ID")
//   kimi --session <id>      (kimi --help: "-S, --session [id] Resume a session. With ID: resume that session.")
//   pi --session <path|id>   (pi --help: "--session <path|id> Use specific session file or partial UUID")
//   opencode --session <id>  (opencode --help: "-s, --session  session id to continue")
// Not verified (no resume flag in --help): dsh (chat has no resume option),
// zcode / qoder / reasonix (no CLI on PATH to check) → left empty.
const RESUME_COMMAND = Object.freeze({
  claude: (meta) => `claude --resume ${meta.id}`,
  kimi: (meta) => `kimi --session ${meta.id}`,
  pi: (meta) => `pi --session ${meta.file}`,
  opencode: (meta) => `opencode --session ${meta.id}`,
});

function resumeCommandFor(endpoint, meta) {
  const build = RESUME_COMMAND[endpoint];
  return build ? build(meta) : "";
}

// cc-switch truncate_summary: trim, cap at maxChars, append "..." when cut.
function truncateText(text, maxChars) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0) return "";
  if ([...trimmed].length <= maxChars) return trimmed;
  return [...trimmed].slice(0, maxChars).join("") + "...";
}

// cc-switch path_basename: last non-empty path segment, both separators.
function pathBasename(value) {
  const trimmed = String(value ?? "").trim().replace(/[/\\]+$/, "");
  if (!trimmed) return null;
  const segments = trimmed.split(/[/\\]/).filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

// cc-switch parse_timestamp_to_ms: integer (ms if >1e12 else s) or RFC3339.
function parseTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.trunc(value);
    return n > 1_000_000_000_000 ? n : n * 1000;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

// cc-switch extract_text: string | content-block array | {text} object.
// tool_use/toolCall blocks render as "[Tool: <name>]".
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(extractTextFromItem)
      .filter((t) => t !== null && t.trim() !== "")
      .join("\n");
  }
  if (content && typeof content === "object") {
    return typeof content.text === "string" ? content.text : "";
  }
  return "";
}

function extractTextFromItem(item) {
  if (!item || typeof item !== "object") return null;
  const type = typeof item.type === "string" ? item.type : "";
  if (type === "tool_use" || type === "toolCall" || type === "tool") {
    const name = typeof item.name === "string" ? item.name : "unknown";
    return `[Tool: ${name}]`;
  }
  if (type === "tool_result" || type === "toolResult") {
    if (item.content !== undefined) {
      const text = extractText(item.content);
      return text !== "" ? text : null;
    }
    return null;
  }
  if (typeof item.text === "string") return item.text;
  if (typeof item.input_text === "string") return item.input_text;
  if (typeof item.output_text === "string") return item.output_text;
  if (item.content !== undefined) {
    const text = extractText(item.content);
    return text !== "" ? text : null;
  }
  return null;
}

// Parse one JSONL text into objects, skipping blank/corrupt lines (never throw).
function parseJsonl(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // corrupt/truncated line — skip, never blow up the scan
    }
  }
  return out;
}

// cc-switch read_head_tail_lines: first headN + last tailN lines without
// reading the whole file when it is large. Small files (<16KB) are read once.
// Uses fs.open + positioned reads so multi-MB transcripts stay cheap.
// The head is read LINE BY LINE (not one 16KB split): a single JSONL row can
// exceed 16KB on its own (kimi profile.bind rows are ~16KB), and a fixed chunk
// split would truncate it and hide every later line from the head parse.
function readHeadTailLines(path, headN, tailN) {
  const SMALL_FILE_BYTES = 16_384;
  const CHUNK = 16_384;
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    if (size < SMALL_FILE_BYTES) {
      const all = readFileSync(fd, "utf8").split("\n");
      const head = all.slice(0, headN);
      const tail = all.slice(Math.max(0, all.length - tailN));
      return { head, tail };
    }
    // Head: stream chunks from position 0, emitting complete lines until headN.
    const head = [];
    let pos = 0;
    let carry = "";
    const buf = Buffer.alloc(CHUNK);
    while (head.length < headN && pos < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      carry += buf.toString("utf8", 0, n);
      let nl;
      while (head.length < headN && (nl = carry.indexOf("\n")) !== -1) {
        head.push(carry.slice(0, nl));
        carry = carry.slice(nl + 1);
      }
    }
    // Tail: read the last 16KB chunk; drop the first (likely partial) line.
    const tailPos = size - SMALL_FILE_BYTES;
    const tailBuf = Buffer.alloc(SMALL_FILE_BYTES);
    const tailRead = readSync(fd, tailBuf, 0, SMALL_FILE_BYTES, tailPos);
    const tailLines = tailBuf.toString("utf8", 0, tailRead).split("\n").slice(1);
    const tail = tailLines.slice(Math.max(0, tailLines.length - tailN));
    return { head, tail };
  } finally {
    closeSync(fd);
  }
}

// Recursive *.jsonl collector. Dir entries that fail to stat are skipped.
function collectJsonlFiles(root, { skipDirs = () => false, skipFiles = () => false } = {}) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // dir vanished or unreadable — nothing to collect
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs(entry.name, path)) walk(path);
      } else if (entry.name.endsWith(".jsonl") && !skipFiles(entry.name, path)) {
        out.push(path);
      }
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Delete path safety (translation of cc-switch delete_session_with_roots):
// canonicalize the candidate file and every existing root, then require the
// file to live under one of the adapter's roots. Anything else is refused —
// the path comes from the frontend and is not trusted.
// ---------------------------------------------------------------------------

function canonicalizeExisting(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} not found: ${path}`);
  }
  return realpathSync(path);
}

function assertUnderRoots(file, roots) {
  const canonicalFile = canonicalizeExisting(file, "session source");
  let sawExistingRoot = false;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    sawExistingRoot = true;
    const canonicalRoot = canonicalizeExisting(root, "session root");
    if (isPathUnder(canonicalFile, canonicalRoot)) return canonicalFile;
  }
  if (!sawExistingRoot) {
    throw new Error(`session root not found: ${roots[0] ?? "<none>"}`);
  }
  throw new Error(`session source path is outside endpoint roots: ${file}`);
}

// Prefix check that cannot be fooled by "C:\\a\\root2" vs "C:\\a\\root":
// compare on segment boundary, case-insensitively (Windows FS).
function isPathUnder(file, root) {
  const f = file.toLowerCase();
  const r = root.toLowerCase().replace(/[/\\]+$/, "");
  return f === r || f.startsWith(r + sep) || f.startsWith(r + "/") || f.startsWith(r + "\\");
}

function makeMeta({ endpoint, id, title = null, summary = null, project = null, file = null, createdAt = null, lastActive = null }) {
  const meta = { endpoint, id, title, summary, project, file, createdAt, lastActive, resumeCommand: "" };
  meta.resumeCommand = resumeCommandFor(endpoint, meta);
  return meta;
}

// ---------------------------------------------------------------------------
// claude — translation of cc-switch providers/claude.rs.
// Layout: ~/.claude/projects/<munged-cwd>/<sessionId>.jsonl (+ same-name
// sidecar dir, subagents/, journal.jsonl). Head 30 / tail 30 local reads;
// title priority custom-title > first real user message > dir basename.
// (cc-switch uses head 10, but real sessions often carry 10+ lines of
// mode/permission/snapshot/command noise before the first real user message.)
// ---------------------------------------------------------------------------

function createClaudeAdapter(roots) {
  const isExcludedName = (name) => name.startsWith("agent-") || name === "journal.jsonl";

  function parseSession(path) {
    const { head, tail } = readHeadTailLines(path, 30, 30);

    let sessionId = null;
    let project = null;
    let createdAt = null;
    let firstUserMessage = null;

    for (const line of head) {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (sessionId === null && typeof value.sessionId === "string") sessionId = value.sessionId;
      if (project === null && typeof value.cwd === "string") project = value.cwd;
      if (createdAt === null) createdAt = parseTimestampMs(value.timestamp);
      // First REAL user message as title candidate — skip system-injected
      // caveats and slash-command wrappers (/clear, /model, ...).
      if (firstUserMessage === null) {
        const isUser =
          value.type === "user" || (value.message && value.message.role === "user");
        if (isUser && value.message) {
          const text = extractText(value.message.content).trim();
          if (
            text !== "" &&
            !text.includes("<local-command-caveat>") &&
            !text.includes("<local-command-stdout>") &&
            !text.startsWith("<command-name>")
          ) {
            firstUserMessage = text;
          }
        }
      }
      if (sessionId !== null && project !== null && createdAt !== null && firstUserMessage !== null) break;
    }

    let lastActive = null;
    let summary = null;
    let customTitle = null;

    for (let i = tail.length - 1; i >= 0; i--) {
      let value;
      try {
        value = JSON.parse(tail[i]);
      } catch {
        continue;
      }
      if (lastActive === null) lastActive = parseTimestampMs(value.timestamp);
      // custom-title entry: last one wins (first hit walking backwards).
      if (customTitle === null && value.type === "custom-title") {
        const t = typeof value.customTitle === "string" ? value.customTitle.trim() : "";
        if (t !== "") customTitle = t;
      }
      if (summary === null) {
        if (value.isMeta === true) continue;
        if (value.message) {
          const text = extractText(value.message.content);
          if (text.trim() !== "") summary = text;
        }
      }
      if (lastActive !== null && summary !== null && customTitle !== null) break;
    }

    // Fall back to the file stem when no line carried a sessionId.
    if (sessionId === null) sessionId = basename(path).replace(/\.jsonl$/, "");
    if (sessionId === "") return null;

    // Sessions with no real user message at all (pure /exit, /model,
    // local-command noise) carry no conversation — exclude from the list.
    if (customTitle === null && firstUserMessage === null) return null;

    const title =
      (customTitle !== null && truncateText(customTitle, TITLE_MAX_CHARS)) ||
      (firstUserMessage !== null && truncateText(firstUserMessage, TITLE_MAX_CHARS)) ||
      (project !== null ? pathBasename(project) : null);

    return makeMeta({
      endpoint: "claude",
      id: sessionId,
      title: title || null,
      summary: summary !== null ? truncateText(summary, SUMMARY_MAX_CHARS) || null : null,
      project,
      file: path,
      createdAt,
      lastActive,
    });
  }

  return {
    id: "claude",
    roots: () => roots,
    async scan() {
      const sessions = [];
      for (const root of roots) {
        // subagents/ holds child-agent transcripts — not main sessions.
        const files = collectJsonlFiles(root, {
          skipDirs: (name) => name === "subagents",
          skipFiles: (name) => isExcludedName(name),
        });
        for (const file of files) {
          try {
            const meta = parseSession(file);
            if (meta) sessions.push(meta);
          } catch {
            // unreadable/corrupt file — skip, never fail the whole scan
          }
        }
      }
      return sessions;
    },
    async loadMessages(file) {
      const target = assertUnderRoots(file, roots);
      const messages = [];
      for (const value of parseJsonl(readFileSync(target, "utf8"))) {
        if (value.isMeta === true) continue;
        const message = value.message;
        if (!message || typeof message !== "object") continue;
        let role = typeof message.role === "string" ? message.role : "unknown";
        // Claude wraps tool_result inside user messages; reclassify as "tool".
        if (role === "user" && Array.isArray(message.content)) {
          const items = message.content;
          const allToolResults =
            items.length > 0 &&
            items.every((item) => item && typeof item === "object" && item.type === "tool_result");
          if (allToolResults) role = "tool";
        }
        const content = extractText(message.content);
        if (content.trim() === "") continue;
        messages.push({ role, content, ts: parseTimestampMs(value.timestamp) });
      }
      return messages;
    },
    async delete(file) {
      const target = assertUnderRoots(file, roots);
      // Sidecar cleanup first: <sessionId>/ holds subagents/tool-results.
      const sidecar = join(dirname(target), basename(target).replace(/\.jsonl$/, ""));
      if (existsSync(sidecar)) rmSync(sidecar, { recursive: true, force: true });
      rmSync(target);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// kimi — ~/.kimi-code/session_index.jsonl is a ready-made index of
// { sessionId, sessionDir, workDir }; lastActive comes from the sessionDir
// mtime. Transcript is the wire.jsonl event stream (protocol_version 1.5):
// user turns are "prompt.accepted" events; agent text and tool activity are
// nested inside "context.append_loop_event" (content.part / tool.call /
// tool.result) — they never appear as top-level events.
// ---------------------------------------------------------------------------

function createKimiAdapter(roots) {
  // roots[0] = ~/.kimi-code (the dir holding session_index.jsonl)
  function readIndex() {
    const entries = [];
    for (const root of roots) {
      let text;
      try {
        text = readFileSync(join(root, "session_index.jsonl"), "utf8");
      } catch {
        continue; // no index → no kimi sessions
      }
      for (const value of parseJsonl(text)) {
        if (typeof value.sessionId === "string" && typeof value.sessionDir === "string") {
          entries.push(value);
        }
      }
    }
    return entries;
  }

  // Title candidate: first real user text in wire.jsonl. Two event shapes
  // carry it: "prompt.accepted" (interactive prompt) and user-role
  // "context.append_message" (swarm/injected turns). Skip system-reminder
  // wrappers — they are injected context, not the user's own words.
  function firstPrompt(sessionDir) {
    try {
      const wire = join(sessionDir, "agents", "main", "wire.jsonl");
      const { head } = readHeadTailLines(wire, 60, 0);
      for (const line of head) {
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        let text = null;
        if (value.type === "prompt.accepted") {
          text = extractText(value.content).trim();
        } else if (
          value.type === "context.append_message" &&
          value.message && value.message.role === "user"
        ) {
          text = extractText(value.message.content).trim();
        }
        if (text !== null && text !== "" && !text.startsWith("<system-reminder>")) return text;
      }
    } catch {
      // no wire.jsonl or unreadable — title falls back to workDir basename
    }
    return null;
  }

  // Last activity = newest `agents/<id>/wire.jsonl`. Reached via one readdir +
  // one stat per agent instead of a full recursive walk of the session dir,
  // which on this machine meant stat'ing up to 1970 files per session just to
  // answer "when was this conversation last active". Semantic change: tool
  // results and task logs written after the last transcript append no longer
  // count — the transcripts are what "session activity" means here.
  function latestWireMtime(sessionDir) {
    const agentsDir = join(sessionDir, "agents");
    let entries;
    try {
      entries = readdirSync(agentsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    let latest = null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const m = statSync(join(agentsDir, entry.name, "wire.jsonl")).mtimeMs;
        if (latest === null || m > latest) latest = m;
      } catch {
        // agent dir with no transcript of its own — not an activity source
      }
    }
    return latest;
  }

  return {
    id: "kimi",
    roots: () => roots,
    async scan() {
      const sessions = [];
      for (const entry of readIndex()) {
        try {
          if (!existsSync(entry.sessionDir)) continue; // index row outlived its dir
          const prompt = firstPrompt(entry.sessionDir);
          // Sessions whose wire.jsonl carries no real user text (only
          // metadata/binding/system-reminder injections) are not conversations.
          if (prompt === null) continue;
          const lastActive = latestWireMtime(entry.sessionDir) ?? statSync(entry.sessionDir).mtimeMs;
          const project = typeof entry.workDir === "string" ? entry.workDir : null;
          sessions.push(
            makeMeta({
              endpoint: "kimi",
              id: entry.sessionId,
              title:
                (prompt !== null && truncateText(prompt, TITLE_MAX_CHARS)) ||
                (project !== null ? pathBasename(project) : null),
              project,
              file: entry.sessionDir,
              createdAt: null, // index carries no creation time
              lastActive,
            }),
          );
        } catch {
          // single broken index row — skip
        }
      }
      return sessions;
    },
    async loadMessages(file) {
      const target = assertUnderRoots(file, roots);
      const wire = join(target, "agents", "main", "wire.jsonl");
      const messages = [];
      // Real wire.jsonl shape (census of 1033 on-disk transcripts, 2026-09-10):
      // assistant text and tool activity NEVER appear as top-level "text" /
      // "tool.call" events — they are nested inside "context.append_loop_event"
      // as content.part / tool.call / tool.result. The two top-level branches
      // this loop used to have matched zero events across every real file.
      for (const value of parseJsonl(readFileSync(wire, "utf8"))) {
        if (value.type === "prompt.accepted") {
          // turn.prompt carries the same user input — not read here, or every
          // user turn would appear twice.
          const content = extractText(value.content);
          if (content.trim() !== "") {
            messages.push({ role: "user", content, ts: parseTimestampMs(value.time) });
          }
        } else if (value.type === "context.append_loop_event") {
          const ev = value.event;
          if (!ev || typeof ev !== "object") continue;
          // Inner events carry no timestamp of their own; the wrapper's
          // `time` is the only clock.
          const ts = parseTimestampMs(value.time);
          if (ev.type === "content.part" && ev.part && ev.part.type === "text") {
            // part.type "think" is the model's reasoning draft, not dialogue.
            const content = typeof ev.part.text === "string" ? ev.part.text : "";
            if (content.trim() !== "") {
              messages.push({ role: "assistant", content, ts });
            }
          } else if (ev.type === "tool.call") {
            const name = typeof ev.name === "string" ? ev.name : "unknown";
            messages.push({ role: "tool", content: `[Tool: ${name}]`, ts });
          } else if (ev.type === "tool.result") {
            const output =
              ev.result && typeof ev.result.output === "string" ? ev.result.output : "";
            if (output.trim() !== "") {
              messages.push({ role: "tool", content: output, ts });
            }
          }
        }
      }
      return messages;
    },
    async delete(file) {
      const target = assertUnderRoots(file, roots);
      rmSync(target, { recursive: true, force: true });
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// dsh — ~/.dsh/sessions/--<munged-cwd>--/<uuid>/session.jsonl.zstd, zstd-
// compressed JSONL (node:zlib zstdDecompressSync, verified on Node v24.18.0).
// First line is a {"type":"session"} header with id/cwd/createdAt.
// ---------------------------------------------------------------------------

function createDshAdapter(roots) {
  function readSessionFile(path) {
    return parseJsonl(zstdDecompressSync(readFileSync(path)).toString("utf8"));
  }

  return {
    id: "dsh",
    roots: () => roots,
    async scan() {
      const sessions = [];
      for (const root of roots) {
        let projectDirs;
        try {
          projectDirs = readdirSync(root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const projectDir of projectDirs) {
          if (!projectDir.isDirectory()) continue;
          const projectPath = join(root, projectDir.name);
          let sessionDirs;
          try {
            sessionDirs = readdirSync(projectPath, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const sessionDir of sessionDirs) {
            if (!sessionDir.isDirectory()) continue;
            const sessionFile = join(projectPath, sessionDir.name, "session.jsonl.zstd");
            if (!existsSync(sessionFile)) continue;
            try {
              const lines = readSessionFile(sessionFile);
              const header = lines.find((v) => v.type === "session") ?? {};
              // 只有 header 行的空壳会话（本机 dsh 现状：全部是 subagent 派生
              // 的单行文件）不进列表——没有消息可展示，标题也只能兜底目录名。
              if (lines.every((v) => v.type === "session")) continue;
              const id =
                typeof header.id === "string" && header.id !== "" ? header.id : sessionDir.name;
              const project = typeof header.cwd === "string" ? header.cwd : null;
              const createdAt = parseTimestampMs(header.createdAt);
              const firstUser = lines.find((v) => v.type !== "session" && v.role === "user");
              const last = lines.length > 0 ? lines[lines.length - 1] : null;
              sessions.push(
                makeMeta({
                  endpoint: "dsh",
                  id,
                  title:
                    (firstUser && truncateText(extractText(firstUser.content), TITLE_MAX_CHARS)) ||
                    (project !== null ? pathBasename(project) : null),
                  project,
                  file: sessionFile,
                  createdAt,
                  lastActive:
                    parseTimestampMs(last?.timestamp) ??
                    parseTimestampMs(last?.time) ??
                    statSync(sessionFile).mtimeMs,
                }),
              );
            } catch {
              // corrupt zstd/json — skip this session
            }
          }
        }
      }
      return sessions;
    },
    async loadMessages(file) {
      const target = assertUnderRoots(file, roots);
      const messages = [];
      for (const value of readSessionFile(target)) {
        if (value.type === "session") continue; // header line
        const role = typeof value.role === "string" ? value.role : null;
        if (role === null) continue;
        const content = extractText(value.content);
        if (content.trim() === "") continue;
        messages.push({ role, content, ts: parseTimestampMs(value.timestamp ?? value.time) });
      }
      return messages;
    },
    async delete(file) {
      const target = assertUnderRoots(file, roots);
      // The .zstd file is the only artifact inside its <uuid>/ dir — remove both.
      rmSync(target);
      const dir = dirname(target);
      try {
        if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
      } catch {
        // dir already gone or not empty — nothing more to do
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// pi — ~/.pi/agent/sessions/<munged-cwd>/<ts>_<uuid>.jsonl. First line is
// {"type":"session","id",...,"cwd"}; messages are {"type":"message"} entries
// wrapping {role, content}. Resume by exact file path (cc-switch pi.rs).
// ---------------------------------------------------------------------------

function createPiAdapter(roots) {
  function parseSession(path) {
    const { head, tail } = readHeadTailLines(path, 10, 30);
    const headValues = [];
    for (const line of head) {
      try {
        headValues.push(JSON.parse(line));
      } catch {
        // skip corrupt line
      }
    }
    const header = headValues.find((v) => v.type === "session");
    const id =
      (header && typeof header.id === "string" && header.id) ||
      basename(path).replace(/\.jsonl$/, "").replace(/^.*_/, "");
    if (!id) return null;
    const project = header && typeof header.cwd === "string" ? header.cwd : null;
    const createdAt = header ? parseTimestampMs(header.timestamp) : null;
    const firstUser = headValues.find(
      (v) => v.type === "message" && v.message && v.message.role === "user",
    );

    let lastActive = null;
    let summary = null;
    for (let i = tail.length - 1; i >= 0; i--) {
      let value;
      try {
        value = JSON.parse(tail[i]);
      } catch {
        continue;
      }
      if (value.type !== "message" || !value.message) continue;
      if (lastActive === null) {
        // Prefer the inner message timestamp over the entry timestamp.
        lastActive = parseTimestampMs(value.message.timestamp) ?? parseTimestampMs(value.timestamp);
      }
      if (summary === null) {
        const text = extractText(value.message.content);
        if (text.trim() !== "") summary = text;
      }
      if (lastActive !== null && summary !== null) break;
    }

    return makeMeta({
      endpoint: "pi",
      id,
      title:
        (firstUser && truncateText(extractText(firstUser.message.content), TITLE_MAX_CHARS)) ||
        (project !== null ? pathBasename(project) : null),
      summary: summary !== null ? truncateText(summary, SUMMARY_MAX_CHARS) || null : null,
      project,
      file: path,
      createdAt,
      lastActive: lastActive ?? createdAt,
    });
  }

  return {
    id: "pi",
    roots: () => roots,
    async scan() {
      const sessions = [];
      for (const root of roots) {
        for (const file of collectJsonlFiles(root)) {
          try {
            const meta = parseSession(file);
            if (meta) sessions.push(meta);
          } catch {
            // unreadable file — skip
          }
        }
      }
      return sessions;
    },
    async loadMessages(file) {
      const target = assertUnderRoots(file, roots);
      const messages = [];
      for (const value of parseJsonl(readFileSync(target, "utf8"))) {
        if (value.type !== "message" || !value.message) continue;
        let role = typeof value.message.role === "string" ? value.message.role : "unknown";
        if (role === "toolResult") role = "tool";
        const content = extractText(value.message.content);
        if (content.trim() === "") continue;
        messages.push({
          role,
          content,
          ts: parseTimestampMs(value.message.timestamp) ?? parseTimestampMs(value.timestamp),
        });
      }
      return messages;
    },
    async delete(file) {
      const target = assertUnderRoots(file, roots);
      rmSync(target);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// qoder — real chat transcripts live at ~/.qoder/projects/<munged-cwd>/<uuid>.jsonl
// (claude-style lines: workspace-directories / runtime-config / user / assistant /
// attachment / active-leaf / file-history-snapshot). ~/.qoder/logs/sessions/ is
// only segmented RUN logs (headless plugin installs, config probes) — not a
// conversation source, and not read here.
// ---------------------------------------------------------------------------

function createQoderAdapter(roots) {
  function parseTranscript(path) {
    const { head, tail } = readHeadTailLines(path, 30, 30);

    let sessionId = null;
    let project = null;
    let createdAt = null;
    let firstUserMessage = null;

    for (const line of head) {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (sessionId === null && typeof value.sessionId === "string") sessionId = value.sessionId;
      if (value.type === "workspace-directories" && project === null) {
        const dirs = value.directories;
        if (Array.isArray(dirs) && typeof dirs[0] === "string" && dirs[0] !== "") project = dirs[0];
      }
      if (createdAt === null) createdAt = parseTimestampMs(value.timestamp);
      if (firstUserMessage === null && value.type === "user" && value.message) {
        const text = extractText(value.message.content).trim();
        if (text !== "") firstUserMessage = text;
      }
      if (sessionId !== null && project !== null && createdAt !== null && firstUserMessage !== null) break;
    }

    let lastActive = null;
    let summary = null;
    for (let i = tail.length - 1; i >= 0; i--) {
      let value;
      try {
        value = JSON.parse(tail[i]);
      } catch {
        continue;
      }
      if (lastActive === null) lastActive = parseTimestampMs(value.timestamp);
      if (summary === null && (value.type === "assistant" || value.type === "user") && value.message) {
        const text = extractText(value.message.content);
        if (text.trim() !== "") summary = text;
      }
      if (lastActive !== null && summary !== null) break;
    }

    if (sessionId === null) sessionId = basename(path).replace(/\.jsonl$/, "");
    if (sessionId === "") return null;
    // No real user turn → not a conversation (shouldn't happen in projects/,
    // but keep the same guard as claude).
    if (firstUserMessage === null) return null;

    return makeMeta({
      endpoint: "qoder",
      id: sessionId,
      title:
        truncateText(firstUserMessage, TITLE_MAX_CHARS) ||
        (project !== null ? pathBasename(project) : null),
      summary: summary !== null ? truncateText(summary, SUMMARY_MAX_CHARS) || null : null,
      project,
      file: path,
      createdAt,
      lastActive: lastActive ?? createdAt,
    });
  }

  return {
    id: "qoder",
    roots: () => roots,
    async scan() {
      const sessions = [];
      for (const root of roots) {
        let projectDirs;
        try {
          projectDirs = readdirSync(root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const projectDir of projectDirs) {
          if (!projectDir.isDirectory()) continue;
          const projectPath = join(root, projectDir.name);
          let files;
          try {
            files = readdirSync(projectPath, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const f of files) {
            if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
            try {
              const meta = parseTranscript(join(projectPath, f.name));
              if (meta !== null) sessions.push(meta);
            } catch {
              // unreadable file — skip
            }
          }
        }
      }
      return sessions;
    },
    async loadMessages(file) {
      const target = assertUnderRoots(file, roots);
      const messages = [];
      for (const value of parseJsonl(readFileSync(target, "utf8"))) {
        if (value.type !== "user" && value.type !== "assistant") continue;
        if (!value.message) continue;
        const role = value.message.role === "assistant" ? "assistant" : "user";
        const content = extractText(value.message.content);
        if (content.trim() === "") continue;
        messages.push({
          role,
          content,
          ts: parseTimestampMs(value.timestamp),
        });
      }
      return messages;
    },
    async delete(file) {
      const target = assertUnderRoots(file, roots);
      rmSync(target);
      // Best-effort: remove the same-name companion dir (compression-v2/,
      // state.json) if present — it holds no user-authored content.
      const companion = target.replace(/\.jsonl$/, "");
      try {
        if (existsSync(companion)) rmSync(companion, { recursive: true, force: true });
      } catch {
        // companion cleanup is best-effort
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite adapters (zcode / opencode / reasonix). All open read-only via a
// file:...?mode=ro URI so active WAL stores are safe to read concurrently.
// Open/query failure degrades the adapter to an empty list — it must never
// blow up the combined scan.
// ---------------------------------------------------------------------------

function openSqliteReadOnly(path) {
  const uri = `file:${path.replace(/\\/g, "/")}?mode=ro`;
  return new DatabaseSync(uri);
}

// Shared row shape for zcode/opencode `session` tables (same columns on both):
// id / title / directory / time_created / time_updated (ms since epoch).
function scanSessionTable({ endpoint, dbPath }) {
  const db = openSqliteReadOnly(dbPath);
  try {
    const rows = db
      .prepare(
        "SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC",
      )
      .all();
    return rows.map((row) =>
      makeMeta({
        endpoint,
        id: String(row.id),
        title: typeof row.title === "string" && row.title.trim() !== "" ? truncateText(row.title, TITLE_MAX_CHARS) : null,
        project: typeof row.directory === "string" ? row.directory : null,
        file: `sqlite:${dbPath}#${row.id}`,
        createdAt: typeof row.time_created === "number" ? row.time_created : null,
        lastActive: typeof row.time_updated === "number" ? row.time_updated : null,
      }),
    );
  } finally {
    db.close();
  }
}

// Shared message loader for zcode/opencode: message.data holds {role,...},
// part.data holds content blocks ({type:"text",text} etc.).
function loadSqliteMessages(dbPath, sessionId) {
  const db = openSqliteReadOnly(dbPath);
  try {
    const messages = db
      .prepare("SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC")
      .all(sessionId);
    const partStmt = db.prepare(
      "SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC",
    );
    const out = [];
    for (const message of messages) {
      let data;
      try {
        data = JSON.parse(message.data);
      } catch {
        continue;
      }
      const role = typeof data.role === "string" ? data.role : "unknown";
      const parts = partStmt.all(message.id);
      const content = parts
        .map((part) => {
          try {
            return extractTextFromItem(JSON.parse(part.data));
          } catch {
            return null;
          }
        })
        .filter((t) => t !== null && t.trim() !== "")
        .join("\n");
      if (content.trim() === "") continue;
      out.push({
        role,
        content,
        ts: typeof message.time_created === "number" ? message.time_created : null,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

// Delete one session row; WAL stores accept writes from a ro-URI? No — mode=ro
// forbids DELETE, so deletion opens a normal read-write connection instead.
function deleteSqliteSession(dbPath, sessionId) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("DELETE FROM session WHERE id = ?").run(sessionId);
  } finally {
    db.close();
  }
  return true;
}

// file is the "sqlite:<dbPath>#<sessionId>" locator built at scan time.
function parseSqliteLocator(file, dbPath) {
  const prefix = `sqlite:${dbPath}#`;
  if (typeof file !== "string" || !file.startsWith(prefix)) {
    throw new Error(`invalid sqlite session locator: ${file}`);
  }
  const id = file.slice(prefix.length);
  if (id === "") throw new Error(`invalid sqlite session locator: ${file}`);
  return id;
}

function createZcodeAdapter(roots) {
  const dbPath = () => join(roots[0], "cli", "db", "db.sqlite");
  return {
    id: "zcode",
    roots: () => roots,
    async scan() {
      return scanSessionTable({ endpoint: "zcode", dbPath: dbPath() });
    },
    async loadMessages(file) {
      return loadSqliteMessages(dbPath(), parseSqliteLocator(file, dbPath()));
    },
    async delete(file) {
      return deleteSqliteSession(dbPath(), parseSqliteLocator(file, dbPath()));
    },
  };
}

function createOpencodeAdapter(roots) {
  const dbPath = () => join(roots[0], "opencode.db");
  return {
    id: "opencode",
    roots: () => roots,
    async scan() {
      return scanSessionTable({ endpoint: "opencode", dbPath: dbPath() });
    },
    async loadMessages(file) {
      return loadSqliteMessages(dbPath(), parseSqliteLocator(file, dbPath()));
    },
    async delete(file) {
      return deleteSqliteSession(dbPath(), parseSqliteLocator(file, dbPath()));
    },
  };
}

// reasonix — read its own session catalog (catalog_sessions has path /
// topic_title / custom_title / preview / created_at / last_activity_at).
// Session files are plain JSONL message snapshots (one {role,content} per
// line, possibly multi-line records with revisioned "replace" snapshots).
function createReasonixAdapter(roots) {
  const dbPath = () => join(roots[0], "session-catalog", "v5.sqlite");
  return {
    id: "reasonix",
    roots: () => roots,
    async scan() {
      const db = openSqliteReadOnly(dbPath());
      try {
        const rows = db
          .prepare(
            `SELECT path, directory, topic_title, custom_title, preview, created_at, last_activity_at
             FROM catalog_sessions ORDER BY last_activity_at DESC`,
          )
          .all();
        const sessions = [];
        for (const row of rows) {
          if (typeof row.path !== "string" || row.path === "") continue;
          const title =
            (typeof row.custom_title === "string" && row.custom_title.trim() !== "" && truncateText(row.custom_title, TITLE_MAX_CHARS)) ||
            (typeof row.topic_title === "string" && row.topic_title.trim() !== "" && truncateText(row.topic_title, TITLE_MAX_CHARS)) ||
            null;
          sessions.push(
            makeMeta({
              endpoint: "reasonix",
              // The file path is the catalog primary key and the only durable id.
              id: basename(row.path).replace(/\.jsonl$/, ""),
              title,
              summary:
                typeof row.preview === "string" && row.preview.trim() !== ""
                  ? truncateText(row.preview, SUMMARY_MAX_CHARS)
                  : null,
              project: typeof row.directory === "string" ? row.directory : null,
              file: row.path,
              createdAt: typeof row.created_at === "number" && row.created_at > 0 ? row.created_at : null,
              lastActive:
                typeof row.last_activity_at === "number" && row.last_activity_at > 0
                  ? row.last_activity_at
                  : null,
            }),
          );
        }
        return sessions;
      } finally {
        db.close();
      }
    },
    async loadMessages(file) {
      // Root check: the catalog db lives under roots[0]; session files live
      // under %APPDATA%\reasonix\projects — the caller passes that as roots[1].
      const target = assertUnderRoots(file, roots.slice(1).length > 0 ? roots.slice(1) : roots);
      const messages = [];
      for (const value of parseJsonl(readFileSync(target, "utf8"))) {
        // Snapshot records carry the whole message list; plain records are one
        // message per line. Both shapes hold {role, content}.
        const list = Array.isArray(value.messages) ? value.messages : [value];
        for (const message of list) {
          const role = typeof message.role === "string" ? message.role : null;
          if (role === null || role === "system") continue;
          const content = extractText(message.content);
          if (content.trim() === "") continue;
          messages.push({ role, content, ts: parseTimestampMs(message.timestamp ?? message.time) });
        }
      }
      return messages;
    },
    async delete(file) {
      const target = assertUnderRoots(file, roots.slice(1).length > 0 ? roots.slice(1) : roots);
      rmSync(target);
      // Best-effort catalog cleanup — the catalog rebuilds itself, so a
      // failure here must not fail the delete.
      try {
        const db = new DatabaseSync(dbPath());
        try {
          db.prepare("DELETE FROM catalog_sessions WHERE path = ?").run(target);
        } finally {
          db.close();
        }
      } catch {
        // catalog row left behind — reasonix prunes missing files itself
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Top-level orchestration (called by panel.mjs routes)
// ---------------------------------------------------------------------------

function defaultRoots(home = homedir()) {
  return {
    claude: [join(home, ".claude", "projects")],
    kimi: [join(home, ".kimi-code")],
    zcode: [join(home, ".zcode")],
    dsh: [join(home, ".dsh", "sessions")],
    pi: [join(home, ".pi", "agent", "sessions")],
    opencode: [join(home, ".local", "share", "opencode")],
    qoder: [join(home, ".qoder", "projects")],
    reasonix: [
      join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "reasonix"),
      join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "reasonix", "projects"),
    ],
  };
}

const ADAPTER_FACTORIES = {
  claude: createClaudeAdapter,
  kimi: createKimiAdapter,
  zcode: createZcodeAdapter,
  dsh: createDshAdapter,
  pi: createPiAdapter,
  opencode: createOpencodeAdapter,
  qoder: createQoderAdapter,
  reasonix: createReasonixAdapter,
};

export function createSessionScanner({ roots: rootOverrides } = {}) {
  const roots = { ...defaultRoots(), ...rootOverrides };
  const adapters = new Map(
    Object.entries(ADAPTER_FACTORIES).map(([id, create]) => [id, create(roots[id] ?? [])]),
  );

  function adapterFor(endpoint) {
    const adapter = adapters.get(endpoint);
    if (!adapter) throw new Error(`unknown endpoint: ${endpoint}`);
    return adapter;
  }

  return {
    adapters,

    // Scan every endpoint in parallel; one adapter's failure degrades to an
    // endpointErrors entry, never a whole-list failure (B5 response shape).
    async scanAll() {
      const results = await Promise.all(
        [...adapters.values()].map(async (adapter) => {
          try {
            return { endpoint: adapter.id, sessions: await adapter.scan(), error: null };
          } catch (error) {
            return { endpoint: adapter.id, sessions: [], error: error?.message ?? String(error) };
          }
        }),
      );
      const sessions = [];
      const endpointErrors = [];
      for (const result of results) {
        sessions.push(...result.sessions);
        if (result.error !== null) {
          endpointErrors.push({ endpoint: result.endpoint, reason: result.error });
        }
      }
      sessions.sort(
        (a, b) => (b.lastActive ?? b.createdAt ?? 0) - (a.lastActive ?? a.createdAt ?? 0),
      );
      return { sessions, endpointErrors };
    },

    async loadMessages(endpoint, file) {
      return adapterFor(endpoint).loadMessages(file);
    },

    // Serial per-item deletes: { ok: [...], fail: [{ endpoint, file, reason }] }.
    // Items carry {endpoint, file} (REVIEW-FINDINGS B3) so the roots whitelist
    // check runs inside the right adapter without a lookup race.
    async deleteSessions(items) {
      const ok = [];
      const fail = [];
      for (const item of items) {
        try {
          await adapterFor(item?.endpoint).delete(item?.file);
          ok.push({ endpoint: item.endpoint, file: item.file });
        } catch (error) {
          fail.push({
            endpoint: item?.endpoint ?? null,
            file: item?.file ?? null,
            reason: error?.message ?? String(error),
          });
        }
      }
      return { ok, fail };
    },
  };
}

// Shared default instance for the panel router (tests build their own with
// temp-dir roots via createSessionScanner).
export const defaultScanner = createSessionScanner();

export const scanAll = () => defaultScanner.scanAll();
export const loadMessages = (endpoint, file) => defaultScanner.loadMessages(endpoint, file);
export const deleteSessions = (items) => defaultScanner.deleteSessions(items);
