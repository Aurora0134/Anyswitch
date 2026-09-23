import { exec, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.mjs";
import { DEFAULT_SPARK_WINDOW_POINTS, parseSparkWindowPoints, loadSettings } from "./relay-settings.mjs";
import { createModelStabilityTracker, STABILITY_FILENAME } from "./model-stability.mjs";
import { readKimiServerInstances } from "./kimi-server-registry.mjs";
// AUTO_MODEL is the virtual chain model ("auto"): routing glue, never a real
// model on any channel. The reporters must never publish it as a model name.
import { AUTO_MODEL } from "./chain-routing.mjs";

export const TTFT_THRESHOLDS = Object.freeze({
  GREEN_MAX_MS: 5000,
  YELLOW_MAX_MS: 15000,
});

// How long an ended Claude session stays visible on the panel before purge.
// This is a display window, NOT a liveness signal — liveness is decided by
// whether the claude.exe PID is still in the process list.
const ENDED_DISPLAY_MS = 60000;

// How long an idle fault stays latched in activeFaults before it expires on
// the next status read. A fault is cleared by first-token / non-streaming
// success on the SAME provider+model pair — not at retry begin, so a looping
// retry that never recovers keeps the panel banner visible. This TTL is the
// fallback for a model that errored and was then abandoned (user switched
// models, no new attempt ever arrives), which would otherwise keep its fault
// entry forever. A model that keeps failing refreshes entry.time on every
// error, so live faults never expire. Expiry is read-driven (no timer),
// consistent with liveness being decided at read time.
const FAULT_IDLE_TTL_MS = 60000;

// When an aggregate agent's OS process vanishes, any in-flight requests it
// owned become orphans: the transport layer will never see them finish, so
// activeRequests would stay > 0 and the panel would keep showing "generating".
// Settle those counters once the process has been gone for longer than the
// process-scan cache window (2500ms) plus a small safety margin.
const PROCESS_GONE_ACTIVE_REQUEST_TTL_MS = 3000;

// How often the per-launch session reporter re-posts its snapshot while a
// request is in flight. Reporter events otherwise fire only on request
// start/end, so without a heartbeat a single long generation (a 10-minute
// turn) would look silent to the panel's lastSeen-based settling below and
// be mistaken for a dead session mid-turn.
const SESSION_REPORTER_HEARTBEAT_MS = 10000;

// A claude session claiming in-flight requests whose reporter has gone
// silent past this threshold is stuck: the final zeroing snapshot was lost
// (panel/relay restart, a recordEnd swallowed by the old single-flight
// wiring) and no event will ever arrive to clear it. Live generations
// heartbeat every SESSION_REPORTER_HEARTBEAT_MS, so 45s (≥3 missed beats)
// of silence is conclusive. Settled on read, no timers — same style as
// PROCESS_GONE_ACTIVE_REQUEST_TTL_MS above.
const SESSION_SILENT_ACTIVE_REQUEST_TTL_MS = 45000;

// Display-metric snapshot across relay restarts. Aggregates and instance
// buckets live only in this process's memory; a relay restart (upgrade,
// crash, or a manual stop/start) used to zero them, and the board then showed
// an empty card until the endpoint's next request finished settling — for a
// coding agent that is a whole turn (~30s+). The snapshot persists the
// display history on the model-stability cadence: cumulative accounting and
// the sample windows backing the card's numbers. It is display history, never
// protocol state — on restore, in-flight counts, fault latches and
// current-identity fields stay live-only (see restoreAggregateState), because
// restoring them would pin a "生成中" badge no live request owns.
export const METRICS_SNAPSHOT_FILENAME = "agent-metrics-snapshot.json";
const METRICS_SNAPSHOT_VERSION = 1;
const METRICS_SNAPSHOT_EVERY_MS = 30_000;

// Sliding window of recent successful requests. TPS and cache-hit rate are
// computed from this window, NOT from process-lifetime totals. A lifetime
// average is dominated by the first few requests: one early high-throughput
// or heavily-cached request permanently inflates the displayed number, and
// later requests only drag it down glacially as they dilute the accumulated
// denominator. The window is a last-N request count, never a wall-clock TTL.
const RECENT_SAMPLE_WINDOW = 18;

// Minimum generation window for a request to count as a speed measurement.
// Mirrors the statistics page's rule (usage-stats.mjs TPS_MIN_GEN_SEC): below
// this the wall-clock between the first and the last token is a packet burst,
// not a rate — the reply arrived in one or two TCP segments, so the quotient
// says nothing about how fast the model writes. The guard is window-based on
// purpose, never rate-based. A rate threshold ("over N tok/s must be an
// artifact — divide by the FULL request duration instead") under-reports every
// fast model once real speeds pass N, because the whole-request denominator
// carries the first-token wait. Windowing has no such cliff.
const TPS_MIN_GEN_MS = 200;

// The one speed statistic the panel and the statistics page share: completion
// tokens over the generation windows of the samples that carry a real one.
// Token-weighted, NOT an average of per-request quotients (which gives a
// 30-token reply the same vote as a 3000-token one), and never cumulative
// tokens over cumulative busy time (which folds first-token waits and idle gaps
// into the denominator — that is what put a 12 tok/s reading next to a 57 tok/s
// curve on the same Claude session card).
// Samples are { completion, genDurationMs }; genDurationMs is null when the
// request never streamed a first chunk (no measurable window).
function isMeasuredSample(sample) {
  const tokens = Number(sample?.completion) || 0;
  const gen = Number(sample?.genDurationMs);
  return tokens > 0 && Number.isFinite(gen) && gen >= TPS_MIN_GEN_MS;
}

// One request's own speed, or null when it carries no measurement (see
// isMeasuredSample). The sparklines plot exactly this population, so a curve and
// the number printed next to it can never be built from different requests.
export function sampleTps(sample) {
  if (!isMeasuredSample(sample)) return null;
  return Number((Number(sample.completion) / (Number(sample.genDurationMs) / 1000)).toFixed(1));
}

export function windowTps(samples, window = RECENT_SAMPLE_WINDOW) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  let completion = 0;
  let genMs = 0;
  for (const sample of samples.slice(-window)) {
    if (!isMeasuredSample(sample)) continue;
    completion += Number(sample.completion);
    genMs += Number(sample.genDurationMs);
  }
  if (genMs <= 0) return null;
  return Number((completion / (genMs / 1000)).toFixed(1));
}

// Cache-hit rate over the same window: cached prompt tokens over total prompt
// tokens. A per-request mean of hit rates would let a 200-token request outvote
// a 200k-token one.
export function windowCacheHitRate(samples, window = RECENT_SAMPLE_WINDOW) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  let prompt = 0;
  let cached = 0;
  for (const sample of samples.slice(-window)) {
    prompt += Number(sample?.prompt) || 0;
    cached += Number(sample?.cached) || 0;
  }
  if (prompt <= 0) return null;
  return Number(((cached / prompt) * 100).toFixed(1));
}

// Fallback for a Claude session whose launcher predates the window-sample field:
// the reporter's per-request speeds, averaged. This is the statistic windowTps
// replaced (a tiny reply votes as loudly as a long one), but it stays in the
// right order of magnitude and it disappears as soon as that session is
// relaunched with the current launcher.
function meanRecentTps(values, window = RECENT_SAMPLE_WINDOW) {
  if (!Array.isArray(values)) return null;
  const valid = values.slice(-window).filter((v) => typeof v === "number" && v > 0);
  if (valid.length === 0) return null;
  return Number((valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(1));
}

// Instance-id rules shared by the injection channel (the x-agent-instance
// header on the OpenAI/Anthropic paths): trimmed, length-capped, charset
// whitelist. Unlike
// x-agent-id this is NOT a whitelist value domain — any well-formed string is
// a valid instance id. A malformed tag is dropped silently; it must never
// reject the request it rides on.
export const INSTANCE_ID_MAX_LEN = 64;
const INSTANCE_ID_RE = /^[A-Za-z0-9._:-]+$/;
export function sanitizeInstanceId(raw) {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (id.length === 0 || id.length > INSTANCE_ID_MAX_LEN || !INSTANCE_ID_RE.test(id)) return null;
  return id;
}

// ---------------------------------------------------------------------------
// Instance-id normalization. The CLIENT pid is the single identity baseline
// (canonical form "<agentId>-<client pid>", what the socket fallback
// synthesizes). Launcher-injected ids look like "<cwd基名>-<launcher pid>"
// (all four endpoint launchers share the buildInstanceId scheme) and are
// folded into the canonical form at ingest via normalizeInstanceId: a numeric
// tail that IS a live client pid of the endpoint resolves directly; a tail
// that is an ANCESTOR of a client pid (launcher → cmd /c → client) resolves
// through the ParentProcessId lineage table (ppidByPid on the scan result).
// Anything else is a genuine custom id and passes through unchanged (idle-TTL
// path). On a successful fold the id's prefix (the cwd basename) is returned
// as a display label — null when the prefix is the endpoint id itself (a cwd
// literally named e.g. "kimi").
// ---------------------------------------------------------------------------

// Ancestor-walk cap for lineage resolution. Real launcher chains are 2-3
// hops (launcher → cmd /c → client); the cap and the visited set bound the
// walk on corrupted or cyclic parent pointers.
const INSTANCE_LINEAGE_MAX_DEPTH = 16;

// Find the client pid (a member of clientPids) whose ancestor chain contains
// ancestorPid, walking the ppidByPid parent pointers upward. Returns null
// when no client descends from ancestorPid — including the tasklist fallback
// path, whose rows carry no parent column (empty lineage table).
export function findDescendantClientPid(ancestorPid, clientPids, ppidByPid) {
  if (!Number.isFinite(ancestorPid) || !(clientPids instanceof Set) || !(ppidByPid instanceof Map)) return null;
  for (const pid of clientPids) {
    let current = pid;
    const seen = new Set([current]);
    for (let depth = 0; depth < INSTANCE_LINEAGE_MAX_DEPTH; depth++) {
      const parent = ppidByPid.get(current);
      if (parent === undefined) break; // chain leaves the scanned table
      if (parent === ancestorPid) return pid;
      if (seen.has(parent)) break; // parent-pointer cycle
      seen.add(parent);
      current = parent;
    }
  }
  return null;
}

// Normalize a (already well-formed or not) instance id against a process-scan
// snapshot-ish ({ [`${agentId}Pids`]: Set, ppidByPid: Map }, both optional; an
// endpoint that tracks an engine subset folds against `${agentId}EnginePids`
// instead — codex and dsh do, see their bucket comments).
// Returns { id, label }: id is the canonical "<agentId>-<client pid>" when
// the numeric tail resolves, otherwise the input unchanged; label is the
// id's prefix (cwd basename) on a successful fold, else null. Returns null
// for an invalid rawId (same rule as sanitizeInstanceId).
export function normalizeInstanceId(agentId, rawId, procSnapshot = null) {
  const id = sanitizeInstanceId(rawId);
  if (id === null || typeof agentId !== "string" || agentId.length === 0) return null;
  const tail = id.match(/-(\d+)$/);
  if (tail === null) return { id, label: null };
  const tailPid = Number(tail[1]);
  // Endpoints that own an engine subset fold against it, not the whole bucket:
  // codex's ChatGPT.exe (the desktop GUI shell — typically the engine's PARENT,
  // so a GUI-pid tag still folds through the lineage table) and its short-lived
  // helpers, and dsh's two TUI launcher shells, sit in `${agentId}Pids` but
  // never own a session. Same scope the instance housekeeping reconciles
  // against, so a folded id is never evicted as a dead pid.
  const clientPids = procSnapshot?.[`${agentId}EnginePids`] ?? procSnapshot?.[`${agentId}Pids`];
  let clientPid = clientPids instanceof Set && clientPids.has(tailPid) ? tailPid : null;
  if (clientPid === null) {
    clientPid = findDescendantClientPid(tailPid, clientPids, procSnapshot?.ppidByPid);
  }
  if (clientPid === null) return { id, label: null };
  const prefix = id.slice(0, tail.index);
  return { id: `${agentId}-${clientPid}`, label: prefix.length > 0 && prefix !== agentId ? prefix : null };
}

// Liveness verdict for a custom id's numeric tail — a launcher pid that
// never folded into canonical "<agentId>-<pid>" form. The tail names a
// process outside the endpoint's own pid set (the launcher is a node.exe
// row), so reconcile against EVERYTHING the scan enumerated: any counted pid
// set, or the lineage table whose keys cover every probed row, launcher and
// cmd shim included. Returns null when the scan cannot arbitrate (the
// plain-tasklist fallback carries no parent column, so launcher rows leave
// no trace) — callers keep the idle TTL in that case.
function scanPidLiveness(pid, procCounts) {
  if (procCounts === null || typeof procCounts !== "object") return null;
  for (const value of Object.values(procCounts)) {
    if (value instanceof Set && value.has(pid)) return true;
  }
  if (procCounts.ppidByPid instanceof Map) {
    if (procCounts.ppidByPid.has(pid)) return true;
    if (procCounts.ppidByPid.size > 0) return false;
  }
  return null;
}

// Panel title for a codex session row: the scanned session's own title
// (session-scan's codex adapter already prioritizes thread name → first
// user message → cwd basename), else the session's working-directory
// basename, else a short-id placeholder. GUI and CLI sessions share the
// shape — both write the same rollout files. Rows with no scan match (the
// session file not written yet, or the id capped by INSTANCE_ID_MAX_LEN)
// land on the placeholder.
function codexSessionRowTitle(instId, sessionById) {
  const sessionId = instId.slice(CODEX_SESSION_ID_PREFIX.length);
  const meta = sessionById?.get(sessionId) ?? null;
  if (typeof meta?.title === "string" && meta.title.trim() !== "") return meta.title;
  if (typeof meta?.project === "string" && meta.project !== "") {
    const base = meta.project.split(/[\\/]/).filter(Boolean).pop();
    if (base) return base;
  }
  return `Codex 会话 ${sessionId.slice(0, 8)}`;
}

// How long an idle instance stays listed after its last request. Only custom
// ids rely on this TTL: an id of the strict "<agentId>-<pid>" form (socket-
// fallback synthesized, launcher-injected and then folded by
// normalizeInstanceId at ingest, or the process-start placeholder created on
// read) declares its owning PID, so liveness is reconciled against the
// process scan — a live PID keeps the row regardless of idle time, a dead PID
// evicts it immediately. Normalization means launcher ids of the
// "<cwd基名>-<launcher pid>" shape only reach a bucket already folded to the
// client pid; the unresolvable remainder (no numeric tail, or a tail pid with
// no client link in the process snapshot) stays a custom id on this TTL.
// 10 minutes covers a thinking pause between turns without letting long-dead
// custom-tagged instances linger on the panel.
const INSTANCE_IDLE_TTL_MS = 10 * 60 * 1000;

// codex session rows (ids "codex-sess-<prompt_cache_key>", derived upstream
// from the Responses request body's prompt_cache_key — the codex session id,
// identical for the GUI and the CLI) declare no owning PID: every GUI
// conversation shares one app-server engine process and the CLI exits per
// session, so process liveness cannot arbitrate them. They clear on the
// first of two conditions: the whole codex process family is gone
// (procCounts.codex === 0 — GUI app and every CLI exited), or this TTL
// lapses with no traffic. 5 minutes, deliberately shorter than the generic
// custom-id TTL above: a closed session has nothing left that could hold its
// row open, so the card drops it soon after the user moves on instead of
// lingering the way the old process rows did.
export const CODEX_SESSION_ID_PREFIX = "codex-sess-";
const CODEX_SESSION_IDLE_TTL_MS = 5 * 60 * 1000;

export function getTtftColor(ttftMs) {
  if (typeof ttftMs !== "number" || isNaN(ttftMs) || ttftMs <= 0) return "gray";
  if (ttftMs < TTFT_THRESHOLDS.GREEN_MAX_MS) return "green";
  if (ttftMs <= TTFT_THRESHOLDS.YELLOW_MAX_MS) return "yellow";
  return "red";
}

export function formatDuration(ms) {
  if (typeof ms !== "number" || isNaN(ms) || ms <= 0) return "0秒";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分${seconds}秒`;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

function extractPidFromLine(line) {
  // 1. Tasklist CSV format: "image.exe","12345",...
  const tasklistMatch = line.match(/^"[^"]+",\s*"(\d+)"/);
  if (tasklistMatch) return Number(tasklistMatch[1]);
  // 2. PowerShell custom format: 12345,<ppid>,image.exe,... (PID first)
  const psMatch = line.match(/^(\d+),/);
  if (psMatch) return Number(psMatch[1]);
  // 3. WMIC CSV format: Node,CommandLine,Name,ParentProcessId,ProcessId (PID at line end)
  const wmicMatch = line.match(/,\s*(\d+)\s*$/);
  if (wmicMatch) return Number(wmicMatch[1]);
  return null;
}

// Parent pid for the lineage table (ppidByPid) used by instance-id
// normalization. Returns null when the line has no parent column — plain
// tasklist rows (the last fallback) never carry one, so ancestor resolution
// degrades gracefully to null on that path.
function extractParentPid(line) {
  // PowerShell custom format: <pid>,<ppid>,<name>,<command line...> — the ppid
  // is the second field. Old-shape rows (<pid>,<name>,...) have a non-numeric
  // second field and simply yield null.
  const ps = line.match(/^\d+,(\d+),/);
  if (ps) return Number(ps[1]);
  // WMIC CSV: ...,Name,ParentProcessId,ProcessId — the last two numeric
  // fields. Old-shape rows (no ParentProcessId column) end in a single
  // numeric field and yield null.
  const wmic = line.match(/,\s*(\d+),\s*\d+\s*$/);
  if (wmic) return Number(wmic[1]);
  return null;
}

// Image-name → counting-bucket table, mirroring the probe's WHERE list in
// scanProcesses. Rows are claimed by their image NAME field — authoritative
// in every probe shape — never by a substring of the whole line: the probe's
// own cmd.exe wrapper (child_process.exec shells out on Windows) shows up in
// the result carrying every agent name literal inside its command line, so
// bucketing must key off the IMAGE NAME field only — a whole-line substring
// match lets a cmd wrapper impersonate whichever bucket is tested first, which
// shows the panel a 启动/待命 card for a client that never ran. cmd.exe maps to a
// bucket of its own purely so the dispatch can send it to the lineage table and
// nowhere else.
const AGENT_IMAGE_BUCKETS = [
  ["qoder.exe", "qoder"],
  ["codex.exe", "codex"],
  ["codex-code-mode-host.exe", "codex"],
  ["codex-command-runner.exe", "codex"],
  ["chatgpt.exe", "codex"],
  ["zcode.exe", "zcode"],
  ["claude.exe", "claude"],
  ["opencode.exe", "opencode"],
  ["dsh.exe", "dsh"],
  ["grok.exe", "grok"],
  // Kimi Code 的官方桌面端是原生 Electron 包：镜像名 `Kimi Code.exe`，命令行里
  // 没有任何 `kimi-code` 安装路径特征，下面 node.exe 分支的那套路径谓词永远匹配
  // 不到它（步 1 of kimi-desktop-integration-plan.md §3：桌面端在进程面全盲）。
  ["kimi code.exe", "kimi"],
  ["node.exe", "node"],
  ["cmd.exe", "cmd"],
];

// Tail-anchored matchers for WMIC-shaped rows, one per candidate. WMIC output
// is <node>,<command line...>,<name>[,<ppid>],<pid> and command lines carry
// commas (quoted flags) plus quoted name literals (name='Qoder.exe'), so
// neither a comma split nor a bare substring works; anchoring on the trailing
// pid (plus optional parent column) is what keeps a name literal inside a
// command line — the probe wrapper's WHERE clause, an npm path — from
// claiming the row, because a real Name field is always the token right
// before that numeric tail. The captured command line is the text before the
// Name field, cut at the LAST field separator before it (comma boundary is
// part of the tail anchor, never of the capture); rows whose image token
// only appears inside a path (old 3-column dumps: Node,CommandLine,ProcessId,
// no Name field — "…\claude.exe,4321") capture an empty command line and so
// degrade to accept-by-name, matching the pre-structured behavior for that
// shape instead of rejecting every row whose path merely ends in the name.
const AGENT_IMAGE_ROW_MATCHERS = AGENT_IMAGE_BUCKETS.map(([image, bucket]) => [
  image,
  bucket,
  new RegExp(`^[^,]+,(.*),${image.replace(/\./g, "\\.")}(?:,\\s*\\d+)?,\\s*\\d+\\s*$`),
]);

// Fallback for rows with no Name field at all (old 3-column wmic dumps:
// Node,CommandLine,ProcessId). There the second field IS the command line
// and the image is argv[0]'s basename — its leading token, not a tail: the
// probe wrapper row starts with cmd.exe (→ lineage-only bucket, safe), and
// helper rows carry --type= in that same field so the per-bucket filters
// keep working. Only consulted when the comma-boundary matchers above all
// miss, so it cannot over-claim 4/5-column rows (their Name field already
// matched with an exact boundary).
function resolveImageFromCommandLineField(lower) {
  const field = lower.match(/^[^,]+,(.*),\s*\d+\s*$/);
  if (!field) return null;
  // The image token may contain a space: `Kimi Code.exe` is argv[0] there just
  // like anywhere else, and dropping it would make the desktop surface invisible
  // on exactly this legacy 3-column probe shape.
  const image = field[1].match(/^"?(?:[^"\\\/]*[\\\/])*([a-z0-9_. -]+\.exe)(?:\s|"|$)/);
  if (!image) return null;
  return AGENT_IMAGE_BUCKETS.some(([img]) => img === image[1])
    ? { image: image[1], commandLine: field[1] }
    : null;
}

// Structurally resolve one probe row into { image, commandLine }:
// - tasklist CSV: "image.exe","pid",... — name from the first quoted field;
//   these rows carry no command line (null) and keep accept-by-name behavior.
// - PowerShell custom: <pid>[,<ppid>],<name>[,<command line...>] — the name
//   sits right after the pid, so prefix anchoring is position-exact.
// - WMIC CSV: matched by the precompiled tail anchorers above.
// image is null for rows outside every known shape/candidate (headers,
// third-party images) — callers keep them lineage-only.
function resolveProbeRow(lower) {
  const tasklist = lower.match(/^"([^"]+)"/);
  if (tasklist) return { image: tasklist[1], commandLine: null };
  const ps = lower.match(/^\d+(?:,\d+)?,([^,]*)(?:,(.*))?$/);
  if (ps) return { image: ps[1], commandLine: ps[2] ?? "" };
  for (const [image, , rowRe] of AGENT_IMAGE_ROW_MATCHERS) {
    const m = lower.match(rowRe);
    if (m) return { image, commandLine: m[1] };
  }
  const trailing = resolveImageFromCommandLineField(lower);
  if (trailing) return trailing;
  return { image: null, commandLine: null };
}

// ---------------------------------------------------------------------------
// DSH surface classification (步 1 of bridge/anyswitch/dsh-tui-integration-plan.md).
//
// One community-TUI launch in npm form is THREE node.exe rows: the global
// launcher, the profile-copy launcher it delegates to, and the real
// `dsh --profile dsh-tui` process it spawns (replayed against the shipped
// bin/dsh-tui.js + the npm dsh.cmd shim — see the plan's §2/§3). All three
// used to land in the DSH count because the loose `bin\dsh` matcher is a
// prefix of `bin\dsh-tui.js`, so the card read 3 processes per terminal. Only
// the last one is a session: the two shells are stdio-inherit stubs that live
// and die with it. Same split as codex's family/engine pair, with one
// deliberate difference — the DSH card counts the ENGINE set (a DSH launcher
// shell is a stub, while codex's ChatGPT.exe is the desktop app itself, so
// that card keeps the family).
//
// The harness entry file is the engine signature: npm, pnpm and profile-dir
// layouts all keep `@deepseek-ai/dsh/…/lib/bin.js` on the command line (the
// package manifest declares bin = lib/bin.js). The entry file, not the
// package path: the harness also spawns transient helpers under its own
// node_modules (`dsh-subprocess-local/lib/runner.js`, `dsh-sandbox-windows-acl`,
// `dsh-host-directory-picker-native`, `dsh-web-app`), and every one of those
// command lines carries the `@deepseek-ai\dsh\` prefix — a package-path
// signature counted them as sessions (the third unbadged card, 2026-09-22).
// Management invocations of the same entry are excluded: `dsh plugin
// --profile x add <pkg>` forwards to pnpm and `--dump-config` prints and
// exits — neither boots a session.
// ---------------------------------------------------------------------------
const DSH_HARNESS_PATH_RE = /dsh[\\/]lib[\\/]bin\.js/;
const DSH_LAUNCHER_SHELL_RE = /[\\/]bin[\\/]dsh-tui\.js/;
const DSH_MANAGEMENT_RE = /[\s"']plugin\s+--profile|--dump-config|--dump-default-config/;
// `--profile <name>` and `--profile=<name>`; the value stops at the first
// space or quote so a following flag cannot be swallowed.
const DSH_PROFILE_ARG_RE = /--profile(?:=|\s+)("([^"]*)"|(\S+))/;
// The `web` subcommand is a hardcoded alias of `--profile web` (dsh's own
// bin.js), so a web boot carries no --profile token: the alias sits as the
// first token after the script path.
const DSH_WEB_ALIAS_RE = /bin\.js["']?\s+web(?:\s|$)/;
// Anything that is not a bare profile directory name (spaces, quotes, path
// separators) is treated as unreadable rather than pasted into a badge.
const DSH_PROFILE_NAME_RE = /^[^"'\\\s/]{1,40}$/;

// Profile name this DSH command line boots, or null when it cannot be read
// (management invocation, plain-tasklist rows with no command line, a custom
// profile launched through a wrapper that dropped the flag). Case is preserved:
// the name is a directory name the user chose.
export function dshProfileNameFrom(commandLine) {
  if (typeof commandLine !== "string" || commandLine.length === 0) return null;
  if (DSH_MANAGEMENT_RE.test(commandLine)) return null;
  const arg = commandLine.match(DSH_PROFILE_ARG_RE);
  if (arg !== null) {
    const name = arg[2] ?? arg[3] ?? "";
    return DSH_PROFILE_NAME_RE.test(name) ? name : null;
  }
  return DSH_WEB_ALIAS_RE.test(commandLine) ? "web" : null;
}

// Is this DSH-family command line the harness itself (vs a launcher shell or a
// management invocation)? Image-name rows (dsh.exe — the pip packaging ships
// Scripts\dsh.exe) never reach here: they are authoritative by name.
function isDshEngineCommandLine(lower) {
  return DSH_HARNESS_PATH_RE.test(lower)
    && !DSH_LAUNCHER_SHELL_RE.test(lower)
    && !DSH_MANAGEMENT_RE.test(lower);
}

// Panel display names for the profiles whose UI form is not the directory
// name: `web` is DSH's browser UI (also spelled by its `dsh web` alias), and
// the community terminal front end installs itself as profile `dsh-tui`
// (`dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui`).
// The badge axis is the interface, not the product: unknown profiles show
// the product name (bare `dsh` is a real bootable profile) — the badge's
// "which surface is this" question has no answer there.
const DSH_SURFACE_LABELS = { web: "Web", "dsh-tui": "TUI", tui: "TUI" };
const DSH_UNKNOWN_SURFACE_LABEL = "未知";

export function dshSurfaceLabel(profile) {
  if (typeof profile !== "string" || profile.length === 0) return DSH_UNKNOWN_SURFACE_LABEL;
  return DSH_SURFACE_LABELS[profile] ?? profile;
}

// Card subline data: how many live DSH session processes belong to each
// surface. The process scan is the only source that can tell web from TUI
// before the first request — every DSH surface shares one `x-agent-id: dsh`,
// so the request plane cannot. Engine pids whose profile could not be read
// group under null and display as "未知 ×n", so the subline always adds up to
// the card's process count (the badge axis is the interface; an unreadable
// profile is honest "unknown", never a product name — see DSH_SURFACE_LABELS).
export function summarizeDshSurfaces(procCounts) {
  const enginePids = procCounts?.dshEnginePids instanceof Set ? procCounts.dshEnginePids : [];
  return groupSurfaceCounts(enginePids, procCounts?.dshProfileByPid).map(
    ([profile, count]) => ({ profile, label: dshSurfaceLabel(profile), count }),
  );
}

// ---------------------------------------------------------------------------
// Kimi Code 的分面（步 1/2 of bridge/anyswitch/kimi-desktop-integration-plan.md）。
//
// 一个 kimi 端点 id、一份 ~/.kimi-code 家目录之上有三个界面：终端客户端
// （`kimi`）、`kimi web`（在终端里前台起的 server，浏览器只是它的观看端）、
// 以及官方原生桌面端。与 DSH 的差别在于面的读法：kimi 不需要命令行正则——
// 镜像名 `Kimi Code.exe` 本身就说明它是桌面端；剩下的 node 进程里，谁在
// `server/instances/` 名下有一条自己的登记，谁就是 `kimi web` 的 server，
// 没有登记的就是终端客户端（纯 TUI 不起 server，实测：213 个历史会话只对应
// 一条登记，而那条是桌面端写的）。注册表只能把 tui 提为 web，永远不能把桌面
// 端降级或提级，也不能把扫描里不存在的进程号算成一个面。
//
// 面是封闭集合：集合外的值只可能是我们自己读错了，如实落「未知」，不原样上屏
// （DSH 那一档不同——那里的未知值是用户自己起的 profile 目录名，本身就是界面名）。
// ---------------------------------------------------------------------------
const KIMI_SURFACE_LABELS = { tui: "TUI", web: "Web", desktop: "Desktop" };

export function kimiSurfaceLabel(surface) {
  if (typeof surface !== "string" || !(surface in KIMI_SURFACE_LABELS)) return DSH_UNKNOWN_SURFACE_LABEL;
  return KIMI_SURFACE_LABELS[surface];
}

// 共用的分面计数：按面聚合 engine 进程号，读不出的那一档（null）排在最后，
// 于是「副行加总 = 卡上进程数」是恒等式而不是巧合。
function groupSurfaceCounts(enginePids, surfaceByPid) {
  const counts = new Map();
  for (const pid of enginePids) {
    const surface = surfaceByPid?.get(pid) ?? null;
    counts.set(surface, (counts.get(surface) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => {
      if (a[0] === b[0]) return 0;
      if (a[0] === null) return 1;
      if (b[0] === null) return -1;
      return a[0] < b[0] ? -1 : 1;
    });
}

export function summarizeKimiSurfaces(procCounts) {
  const enginePids = procCounts?.kimiEnginePids instanceof Set ? procCounts.kimiEnginePids : [];
  return groupSurfaceCounts(enginePids, procCounts?.kimiSurfaceByPid).map(
    ([surface, count]) => ({ surface, label: kimiSurfaceLabel(surface), count }),
  );
}

// Terminal (console) liveness for TUI-profile DSH engines. Windows lets a
// process outlive its terminal: when the console host dies abruptly
// (terminal crash, taskkill) the attached harness is not notified and keeps
// running with a dead console — measured live 2026-09-22 and reproduced in a
// sandbox. Such an orphan is a session that can never serve the user again,
// so the scan reaps it instead of listing an empty TUI row forever.
// AttachConsole is the probe: it returns 0 while the terminal lives. A dead
// console reports as a nonzero error that is not ERROR_INVALID_HANDLE (6 =
// the process never had a console object at all, like the panel host): the
// object exists but its terminal is gone. Measured flavors: 233
// (ERROR_PIPE_NOT_CONNECTED) on long-dead orphans whose parent is long gone,
// 87 (ERROR_INVALID_PARAMETER) on freshly orphaned processes whose parent is
// still alive, 5 (ERROR_ACCESS_DENIED) in between — enumerating flavors is a
// losing game, so any nonzero non-6 verdict counts as closed-terminal. The
// web surface is never probed at all — a headless web boot keeps today's
// behavior.
const DSH_TUI_CONSOLE_PROFILES = new Set(["dsh-tui", "tui"]);
const DSH_NO_CONSOLE_ERR = 6;
// A reap needs two dead verdicts one scan window apart: one flaky attach
// failure must never cost the user a live session.
const DSH_DEAD_CONSOLE_CONFIRM_ROUNDS = 2;
const DSH_CONSOLE_PROBE_TYPE = "Anys.CP";
const DSH_CONSOLE_PROBE_CS =
  '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId); ' +
  '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole(); ' +
  'public static int AttachErr(uint dwProcessId) { return AttachConsole(dwProcessId) ? 0 : System.Runtime.InteropServices.Marshal.GetLastWin32Error(); }';

// One PowerShell line for the resident REPL probe (its read-line/eval loop
// cannot take a multi-line here-string): compile the P/Invoke helper once,
// drop the probe's own console, then attach to each target pid and report
// `c=<pid>/<err>`. FreeConsole after every successful attach so the probe
// never stays attached to a user terminal between rounds.
export function buildDshConsoleQuery(pids) {
  if (!Array.isArray(pids) || pids.length === 0) return null;
  const list = pids.join(",");
  return (
    `if (-not ("${DSH_CONSOLE_PROBE_TYPE}" -as [type])) { Add-Type -Namespace Anys -Name CP -MemberDefinition '${DSH_CONSOLE_PROBE_CS}' }; ` +
    `[${DSH_CONSOLE_PROBE_TYPE}]::FreeConsole() | Out-Null; ` +
    `foreach ($p in ${list}) { $e = [${DSH_CONSOLE_PROBE_TYPE}]::AttachErr([uint32]$p); if ($e -eq 0) { [${DSH_CONSOLE_PROBE_TYPE}]::FreeConsole() | Out-Null }; Write-Output "c=$p/$e" }`
  );
}

// Console-probe answer: one `c=<pid>/<err>` line per probed pid. Anything
// else (process-scan rows from a shim that cannot distinguish queries, an
// error line, nothing at all) parses to an empty map — an unreadable round
// never reaps anything.
export function parseDshConsoleQueryOutput(out) {
  const verdicts = new Map();
  if (typeof out !== "string") return verdicts;
  for (const m of out.matchAll(/^c=(\d+)\/(\d+)$/gm)) {
    verdicts.set(Number(m[1]), Number(m[2]));
  }
  return verdicts;
}

// The empty scan result both parseTasklistCsv and the collector's cache init
// start from: zero counts, empty pid sets, empty lineage table.
function createEmptyProcessScan() {
  return { zcode: 0, claude: 0, opencode: 0, dsh: 0, pi: 0, kimi: 0, qoder: 0, codex: 0, grok: 0, claudePids: new Set(), opencodePids: new Set(), dshPids: new Set(), dshEnginePids: new Set(), dshProfileByPid: new Map(), piPids: new Set(), kimiPids: new Set(), kimiEnginePids: new Set(), kimiSurfaceByPid: new Map(), qoderPids: new Set(), codexPids: new Set(), codexEnginePids: new Set(), grokPids: new Set(), ppidByPid: new Map() };
}

function parseTasklistCsv(stdout) {
  const result = createEmptyProcessScan();
  if (typeof stdout !== "string" || stdout.length === 0) return result;

  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    const pid = extractPidFromLine(trimmed);
    // Lineage table for instance-id normalization: EVERY row contributes its
    // parent pointer, including rows no counting branch below claims (cmd.exe
    // shims, launcher node.exe) — launcher → cmd /c → client chains cross
    // them. tasklist rows yield ppid null and simply never enter the map.
    const ppid = extractParentPid(trimmed);
    if (pid !== null && ppid !== null) result.ppidByPid.set(pid, ppid);

    // Claim by image name only (see resolveProbeRow). The probe wrapper's
    // command line embeds every agent name literal; a whole-line includes()
    // here would resurrect the phantom-client class of bugs (9613914's
    // ghost card), so command lines are consulted only AFTER the
    // name has claimed the row, and cmd.exe-named rows feed nothing but the
    // lineage table above.
    const { image, commandLine } = resolveProbeRow(lower);
    const bucket = image !== null
      ? (AGENT_IMAGE_BUCKETS.find(([img]) => img === image)?.[1] ?? null)
      : null;
    if (bucket === null) continue;

    if (bucket === "cmd") continue;

    if (bucket === "qoder") {
      // Qoder IDE is an Electron app: filter --type= helper children like
      // zcode so only main processes count as the endpoint process.
      if (commandLine?.includes("--type=")) {
        // Electron helper child process, skip
      } else {
        result.qoder += 1;
        if (pid) result.qoderPids.add(pid);
      }
    } else if (bucket === "codex") {
      // The engine family under %LOCALAPPDATA%\OpenAI\Codex\bin\*\ (codex.exe,
      // codex-code-mode-host.exe, codex-command-runner.exe) counts as-is.
      // ChatGPT.exe is the desktop GUI's Electron shell: filter --type=
      // helper children like qoder so only its main process counts. codex.exe
      // gets the same guard so a helper-shaped row on the no-Name-field
      // fallback path (argv[0] claims the row, --type= sits in the captured
      // command line) cannot inflate the count. An idling GUI alone never
      // marks the endpoint active — the active-session engine is the
      // codex.exe app-server child the GUI spawns per session, and activity
      // itself is relay-traffic driven.
      if ((image === "chatgpt.exe" || image === "codex.exe") && commandLine?.includes("--type=")) {
        // Electron helper child process, skip
      } else {
        result.codex += 1;
        if (pid) result.codexPids.add(pid);
        // Instance liveness is engine-scoped for the pid-shaped rows: only
        // the codex.exe app-server owns sessions, so it alone feeds the pid
        // set that id normalization folds against and housekeeping
        // reconciles "<pid>"-tailed rows against. procCounts.codex /
        // codexPids keep the whole family for the card's process count.
        if (pid && image === "codex.exe") result.codexEnginePids.add(pid);
      }
    } else if (bucket === "zcode") {
      // If CommandLine is present (from wmic / tasklist verbose output), count only main processes
      // that don't have --type= or .cjs arguments.
      // If plain tasklist output is provided, match plain rows (fallback).
      if (commandLine?.includes('--type=') || commandLine?.includes('.cjs')) {
        // Electron helper child process, skip
      } else {
        result.zcode += 1;
      }
    } else if (bucket === "claude") {
      // claude.exe is a multi-call binary: the interactive session spawns
      // short-lived children that keep the claude.exe image name but run as
      // an embedded tool (observed live: the session's claude.exe spawns a
      // child whose CommandLine is `rg --version`). Those helpers are not
      // sessions — counting them flashes phantom session rows on the panel.
      // When the probe output carries a CommandLine column (WMIC /
      // PowerShell), only accept the process if its command line actually
      // invokes claude. Plain tasklist rows carry no command line, so they
      // keep the accept-by-name behavior (last fallback).
      if (commandLine === null || commandLine.includes("claude")) {
        result.claude += 1;
        if (pid) result.claudePids.add(pid);
      }
    } else if (bucket === "opencode") {
      result.opencode += 1;
      if (pid) result.opencodePids.add(pid);
    } else if (bucket === "dsh") {
      // dsh.exe is the harness's own executable (the pip packaging ships
      // Scripts\dsh.exe), so the image name alone already makes it a session
      // process — count it as engine exactly as before. Its command line
      // still carries the profile flag, so reuse the parse when the probe
      // supplied one; plain-tasklist rows carry none and stay unlabeled.
      result.dsh += 1;
      if (pid) {
        result.dshPids.add(pid);
        result.dshEnginePids.add(pid);
      }
      if (pid && commandLine !== null) {
        const imageProfile = dshProfileNameFrom(commandLine);
        if (imageProfile !== null) result.dshProfileByPid.set(pid, imageProfile);
      }
    } else if (bucket === "kimi") {
      // "Kimi Code.exe" is the desktop app's Electron shell: one main process
      // per app, plus --type= helper children that are filtered exactly like
      // qoder's and ChatGPT.exe's. The main process IS the session owner (the
      // kimi core runs embedded inside it and holds the relay connection), so
      // unlike DSH's launcher shells it counts and it joins the engine set —
      // and the image name alone is what makes it the Desktop surface. Plain
      // tasklist rows carry no command line, so they stay accept-by-name.
      // Helper children feed the family pid set only (lineage / liveness).
      if (commandLine?.includes("--type=")) {
        if (pid) result.kimiPids.add(pid);
      } else {
        result.kimi += 1;
        if (pid) {
          result.kimiPids.add(pid);
          result.kimiEnginePids.add(pid);
          result.kimiSurfaceByPid.set(pid, "desktop");
        }
      }
    } else if (bucket === "grok") {
      // Grok Build is a native binary (one grok.exe per terminal session,
      // kimi-style multi-instance) — no helper-image filtering applies. Its
      // bin dir also ships agent.exe / grove*.exe: deliberately NOT bucketed
      // (agent.exe is a generic name third-party software may carry).
      result.grok += 1;
      if (pid) result.grokPids.add(pid);
    } else if (bucket === "node") {
      // The scoped package name must appear as an install PATH (trailing
      // separator): Claude Code's auto-update check spawns
      // `npm view @anthropic-ai/claude-code@latest`, and a bare substring
      // match would register that maintenance node process as a session.
      const isClaudeNode =
        lower.includes("@anthropic-ai/claude-code/") ||
        lower.includes("@anthropic-ai\\claude-code\\") ||
        lower.includes("claude-code/cli-wrapper.cjs") ||
        lower.includes("claude-code\\cli-wrapper.cjs") ||
        lower.includes("claude-code/bin/claude.js") ||
        lower.includes("claude-code\\bin\\claude.js");
      if (isClaudeNode) {
        result.claude += 1;
        if (pid) result.claudePids.add(pid);
      }
      const isDshNode =
        lower.includes("@deepseek-ai/dsh") ||
        lower.includes("@deepseek-ai\\dsh") ||
        lower.includes("dsh/lib/bin.js") ||
        lower.includes("dsh\\lib\\bin.js") ||
        lower.includes("bin\\dsh") ||
        lower.includes("bin/dsh") ||
        lower.includes("node_modules\\dsh") ||
        lower.includes("node_modules/dsh");
      if (isDshNode) {
        // Family vs engine: every DSH-family row (harness, TUI launcher shell,
        // pnpm-forwarding `dsh plugin`) enters dshPids so pid liveness keeps
        // working for the whole family, but only the harness boot counts as a
        // DSH process on the card and feeds the instance buckets.
        if (pid) result.dshPids.add(pid);
        if (isDshEngineCommandLine(lower)) {
          result.dsh += 1;
          if (pid) {
            result.dshEnginePids.add(pid);
            const profile = dshProfileNameFrom(commandLine);
            if (profile !== null) result.dshProfileByPid.set(pid, profile);
          }
        }
      }
      const isPiNode =
        lower.includes("pi") &&
        (lower.includes("node_modules\\pi\\") ||
         lower.includes("node_modules/pi/") ||
         lower.includes("pi\\bin\\") ||
         lower.includes("pi/bin/") ||
         lower.includes("pi.cmd") ||
         lower.includes("@earendil-works/pi-coding-agent/") ||
         lower.includes("@earendil-works\\pi-coding-agent\\"));
      if (isPiNode) {
        result.pi += 1;
        if (pid) result.piPids.add(pid);
      }
      // Same install-path rule as claude: `npm view @moonshot-ai/kimi-code`
      // style maintenance processes must not register as kimi instances.
      const isKimiNode =
        lower.includes("kimi-code/") ||
        lower.includes("kimi-code\\") ||
        (lower.includes("dist\\main.mjs") && lower.includes("kimi")) ||
        (lower.includes("dist/main.mjs") && lower.includes("kimi"));
      if (isKimiNode) {
        result.kimi += 1;
        if (pid) {
          result.kimiPids.add(pid);
          result.kimiEnginePids.add(pid);
          // Terminal client by default: the registration table promotes the
          // subset that owns a server to "web" later in the same scan round
          // (attachKimiSurfaces), because a `kimi web` boot is the same node
          // row with the same install path and no distinguishing flag.
          result.kimiSurfaceByPid.set(pid, "tui");
        }
      }
    }
  }
  return result;
}

function createAggregateState() {
  return {
    totalRequests: 0,
    activeRequests: 0,
    // Active duration is a wall-clock UNION of busy intervals, not a sum of
    // per-request durations: concurrent dialogues overlap in physical time and
    // must not multiply the counter. activeWallStart marks the moment
    // activeRequests went 0 -> 1; the interval settles when it returns to 0.
    activeWallClockMs: 0,
    activeWallStart: null,
    totalActiveDurationMs: 0,
    totalGenerationDurationMs: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCachedTokens: 0,
    // Last N successful requests: { completion, genDurationMs, prompt, cached }.
    // Raw measurements, never derived numbers: windowTps turns them into the
    // card's value and sampleTps into the sparkline points, from the same
    // population of measured requests.
    recentSamples: [],
    ttftHistory: [],
    lastTtftMs: null,
    firstRequestAt: null,
    lastRequestAt: null,
    currentModel: null,
    lastModel: null,
    activeModels: new Map(), // modelName -> activeCount
    // 渠道×模型维度的活跃请求计数，供面板端点卡的模型徽章逐条渲染
    //（同名模型跨渠道各出一枚徽章）：key = `${providerId}\0${model}`，
    // value = { providerId, model, count, autoCount }。autoCount>0 表示该组合
    // 当前有经 auto 路由链服务的请求（服务归因，与徽章上的 displayModel 同源），
    // 直连请求只进 count 不进 autoCount。
    activeTargets: new Map(),
    currentViaAuto: null, // 面板当前展示的模型是否来自 auto 链（null = 无展示中）
    lastViaAuto: false, // 与 lastModel 配对的来源标记（面板最近一次展示是否链服务）
    currentProvider: null,
    lastProvider: null,
    lastError: null, // { status, message, time, model, providerId } — history; kept after recovery
    errorActive: false, // true while any provider+model pair still has an uncleared fault
    activeFaults: new Map(), // `${providerId}\0${model}` -> { providerId, model, status, message, time }
    keylessFaultAt: null, // timestamp of the last fault that had no provider+model key; expires like a Map entry
    keepAliveRetries: 0,
    keepAliveRecoveries: 0,
    keepAliveExhausted: 0,
    lastKeepAliveAt: null,
    sparkWindowPoints: DEFAULT_SPARK_WINDOW_POINTS,
  };
}

// Snapshot wire shape (see the METRICS_SNAPSHOT_* block above). Only the
// display-history fields cross the restart: cumulative counters, the sample
// windows (recentSamples / ttftHistory — a window shorn of its history would
// print a different number than the card showed a second before the restart),
// the sticky "最近" identity, and the keep-alive ledger. Everything
// liveness-scoped is excluded: activeRequests / activeWallStart /
// currentModel / currentProvider / activeModels / activeTargets /
// currentViaAuto / errorActive / activeFaults / keylessFaultAt / lastError
// describe what THIS process is doing right now and start empty again.
function serializeAggregateState(state) {
  return {
    totalRequests: state.totalRequests,
    activeWallClockMs: state.activeWallClockMs,
    totalActiveDurationMs: state.totalActiveDurationMs,
    totalGenerationDurationMs: state.totalGenerationDurationMs,
    totalPromptTokens: state.totalPromptTokens,
    totalCompletionTokens: state.totalCompletionTokens,
    totalCachedTokens: state.totalCachedTokens,
    recentSamples: state.recentSamples,
    ttftHistory: state.ttftHistory,
    lastTtftMs: state.lastTtftMs,
    firstRequestAt: state.firstRequestAt,
    lastRequestAt: state.lastRequestAt,
    lastModel: state.lastModel,
    lastProvider: state.lastProvider,
    lastViaAuto: state.lastViaAuto,
    keepAliveRetries: state.keepAliveRetries,
    keepAliveRecoveries: state.keepAliveRecoveries,
    keepAliveExhausted: state.keepAliveExhausted,
    lastKeepAliveAt: state.lastKeepAliveAt,
  };
}

function snapshotFinite(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function snapshotNullableNumber(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Defensive field-by-field restore: a corrupt or older/newer sidecar must
// degrade to "no data" per field, never throw, never trust the file's shape.
function restoreAggregateState(state, raw, sampleKeep) {
  if (!raw || typeof raw !== "object") return;
  state.totalRequests = snapshotFinite(raw.totalRequests);
  state.activeWallClockMs = snapshotFinite(raw.activeWallClockMs);
  state.totalActiveDurationMs = snapshotFinite(raw.totalActiveDurationMs);
  state.totalGenerationDurationMs = snapshotFinite(raw.totalGenerationDurationMs);
  state.totalPromptTokens = snapshotFinite(raw.totalPromptTokens);
  state.totalCompletionTokens = snapshotFinite(raw.totalCompletionTokens);
  state.totalCachedTokens = snapshotFinite(raw.totalCachedTokens);
  state.lastTtftMs = snapshotNullableNumber(raw.lastTtftMs);
  state.firstRequestAt = snapshotNullableNumber(raw.firstRequestAt);
  state.lastRequestAt = snapshotNullableNumber(raw.lastRequestAt);
  state.lastModel = typeof raw.lastModel === "string" ? raw.lastModel : null;
  state.lastProvider = typeof raw.lastProvider === "string" ? raw.lastProvider : null;
  state.lastViaAuto = raw.lastViaAuto === true;
  state.keepAliveRetries = snapshotFinite(raw.keepAliveRetries);
  state.keepAliveRecoveries = snapshotFinite(raw.keepAliveRecoveries);
  state.keepAliveExhausted = snapshotFinite(raw.keepAliveExhausted);
  state.lastKeepAliveAt = snapshotNullableNumber(raw.lastKeepAliveAt);
  if (Array.isArray(raw.recentSamples)) {
    state.recentSamples = raw.recentSamples
      .filter((s) => s && typeof s === "object")
      .map((s) => ({
        completion: Number(s.completion) || 0,
        genDurationMs: snapshotNullableNumber(s.genDurationMs),
        prompt: Number(s.prompt) || 0,
        cached: Number(s.cached) || 0,
      }))
      .slice(-sampleKeep);
  }
  if (Array.isArray(raw.ttftHistory)) {
    state.ttftHistory = raw.ttftHistory
      .filter((v) => typeof v === "number" && Number.isFinite(v))
      .slice(-sampleKeep);
  }
}

// errKind taxonomy for the usage journal (see usage-journal.mjs header).
// Message-based timeout/network detection runs BEFORE the status buckets:
// the relay's catch paths synthesize status 500 around a thrown transport
// error ("fetch failed", "read ECONNRESET", ...), and the message is the
// more truthful signal there; genuine upstream error bodies don't carry
// those keywords. A failure with no recognizable message and no HTTP
// status is filed as "network" — the conservative transport-level guess.
function classifyErrKind({ status, message } = {}) {
  const msg = typeof message === "string" ? message.toLowerCase() : "";
  if (/timeout|timed out|etimedout/.test(msg)) return "timeout";
  if (/econn\w*|enotfound|eai_again|fetch failed|network|socket hang up/.test(msg)) return "network";
  if (status === 429) return "http_429";
  if (typeof status === "number" && status >= 500) return "http_5xx";
  if (typeof status === "number" && status >= 400) return "http_4xx";
  return "network";
}

function faultKey(providerId, model) {
  if (typeof providerId !== "string" || providerId.length === 0) return null;
  if (typeof model !== "string" || model.length === 0) return null;
  return `${providerId}\0${model}`;
}

function syncAggregateFaultLatch(state) {
  state.errorActive = state.activeFaults.size > 0;
  if (state.activeFaults.size === 0) return;
  let latest = null;
  for (const fault of state.activeFaults.values()) {
    if (!latest || fault.time >= latest.time) latest = fault;
  }
  state.lastError = { ...latest };
}

function clearMatchingAggregateFault(state, meta) {
  const key = faultKey(meta.providerId, meta.model);
  if (key !== null) {
    if (!state.activeFaults.has(key)) return;
    state.activeFaults.delete(key);
    syncAggregateFaultLatch(state);
    return;
  }
  // Keyless recovery (no providerId): first token or a
  // non-streaming success is the only signal that the last unkeyed fault is
  // over. Retry begin must not clear it.
  if (state.keylessFaultAt !== null) {
    state.keylessFaultAt = null;
    if (state.activeFaults.size === 0) state.errorActive = false;
  }
}

// Drop fault entries whose provider+model pair has been idle (no new error to
// refresh entry.time) for longer than faultIdleTtlMs. Read-driven: called when
// the panel status is built, never from a timer.
function pruneStaleAggregateFaults(state, nowFn, ttlMs) {
  const now = nowFn();
  let removed = false;
  for (const [key, fault] of state.activeFaults.entries()) {
    if (now - fault.time >= ttlMs) {
      state.activeFaults.delete(key);
      removed = true;
    }
  }
  if (removed) syncAggregateFaultLatch(state);
  if (
    state.keylessFaultAt !== null &&
    state.activeFaults.size === 0 &&
    now - state.keylessFaultAt >= ttlMs
  ) {
    state.errorActive = false;
    state.keylessFaultAt = null;
  }
}

function trackAggregateRequest(state, meta, nowFn, recentSampleWindow, stability, journal, agentId) {
  const startTime = nowFn();
  // 后台请求（codex 引擎/GUI 自发流量——记忆整理、guardian、预热、线程标题/
  // 摘要生成等，由 openai-server 的分类器打上 meta.background）与全部展示面
  // 双向隔离：不进实例行；失败不写 lastError/activeFaults/errorActive（卡片
  // 报错横幅的数据源），成功也不清用户流量挂起的故障；卡片模型徽章
  // （currentModel/lastModel/currentProvider/lastProvider/activeModels/
  // activeTargets）、TTFT/TPS 样本窗、模型稳定性行同样不碰——这些面只描述
  // 用户流量。totalRequests/token/时长/journal 照实结算——流量不藏，但也不
  // 惊动用户。journal 行同样不带实例身份。
  const background = meta.background === true;
  // Optional per-instance tag (multi-instance endpoints). Validated once here
  // so the journal row and the instance bucket never see a raw header value.
  const journalInstanceId = background ? null : sanitizeInstanceId(meta.instanceId);
  if (state.activeRequests === 0) state.activeWallStart = startTime;
  state.activeRequests += 1;
  state.totalRequests += 1;
  if (state.firstRequestAt === null) state.firstRequestAt = startTime;
  state.lastRequestAt = startTime;
  // activeTargets 记账：一条请求在（渠道,模型）组合上进/出各一次。viaAuto 由调用方
  // 给出——只有链计划解析出的成员归因才是 true（服务归因语义），直连/池请求恒 false。
  const bookTarget = (providerId, model, viaAuto, delta) => {
    const key = `${providerId ?? ""}\u0000${model}`;
    const entry = state.activeTargets.get(key);
    if (delta > 0) {
      if (entry) {
        entry.count += 1;
        if (viaAuto) entry.autoCount += 1;
      } else {
        state.activeTargets.set(key, { providerId: providerId ?? null, model, count: 1, autoCount: viaAuto ? 1 : 0 });
      }
    } else if (entry) {
      entry.count -= 1;
      if (viaAuto) entry.autoCount = Math.max(0, entry.autoCount - 1);
      if (entry.count <= 0) state.activeTargets.delete(key);
    }
  };
  // 虚拟模型 AUTO_MODEL 不是任何渠道上的真实模型，只是路由胶水：它从不进入展示
  // 口径（currentModel/lastModel/activeModels/activeTargets）。链成员一宣布，
  // setDisplayModel 会把身份改指到节点的绑定模型 + 渠道；宣布之前（以及预检失败
  // 这类永远等不到宣布的请求）这条请求没有可展示身份，胶囊按既有语义回落到
  // 「最近」或「待命」，而不是打印 auto。后台请求整段跳过：卡片模型徽章只描述
  // 用户流量（硬编码后台模型的 404 不该改写「最近模型」）。
  if (!background && meta.model && meta.model !== AUTO_MODEL) {
    state.currentModel = meta.model;
    state.lastModel = meta.model;
    const count = state.activeModels.get(meta.model) || 0;
    state.activeModels.set(meta.model, count + 1);
    bookTarget(meta.providerId, meta.model, false, +1);
    state.currentViaAuto = false;
    state.lastViaAuto = false;
  }
  if (!background && meta.providerId) {
    state.currentProvider = meta.providerId;
    state.lastProvider = meta.providerId;
  }

  let firstChunkTime = null;
  let ended = false;
  let endedWithAbort = false;
  let endedWithFault = false;
  // Per-request TTFT for the usage journal: real first-chunk latency for
  // streams, the full-duration proxy for non-streaming successes (mirrors
  // the state.lastTtftMs rules below), null for failures/aborts.
  let journalTtftMs = null;
  // Auto-route attribution: the member currently being attempted (set by the
  // server's member loop) and the chain plan's resolver mapping a memberId to
  // the serving node + bound model. When both are present, the usage journal
  // and model-stability rows attribute to the NODE that actually served the
  // request instead of the virtual "auto" model — "auto" is routing glue, not
  // a statistical endpoint. Direct (non-chain) requests never set a resolver
  // and keep their existing attribution.
  let currentMemberId = null;
  let attributeResolver = null;
  // The model name shown on the panel (the active/last model badges on each
  // endpoint card). It starts as the requested model ("auto" for chain
  // requests) and is re-pointed at the serving node's bound model the moment
  // the member loop announces a member — the badge must never display the
  // virtual "auto". displayProvider/displayViaAuto ride along: the badge's
  // channel segment and auto-tag provenance describe the SAME serving target
  // as the model name (keyed by providerId×model, so a same-named model
  // switching channels is not a no-op).
  // background 请求从 null 起步：recordEnd 的反向记账以 displayModel 为准，
  // 起步即 null 让后台请求在结束侧对称空转（start 侧本就没记账）。
  let displayModel = !background && typeof meta.model === "string" && meta.model && meta.model !== AUTO_MODEL ? meta.model : null;
  let displayProvider = typeof meta.providerId === "string" && meta.providerId ? meta.providerId : null;
  let displayViaAuto = false;
  const setDisplayModel = (model, providerId, viaAuto) => {
    if (typeof model !== "string" || !model) return;
    const nextProvider = typeof providerId === "string" && providerId ? providerId : null;
    if (model === displayModel && nextProvider === displayProvider && viaAuto === displayViaAuto) return;
    if (displayModel !== null) {
      // 同名同渠道才动模型名计数；跨渠道同名（A/a→B/a）只换 activeTargets 的键。
      if (model !== displayModel) {
        const prev = state.activeModels.get(displayModel) || 0;
        if (prev <= 1) state.activeModels.delete(displayModel);
        else state.activeModels.set(displayModel, prev - 1);
        state.activeModels.set(model, (state.activeModels.get(model) || 0) + 1);
      }
      bookTarget(displayProvider, displayModel, displayViaAuto, -1);
      bookTarget(nextProvider, model, viaAuto, +1);
    } else {
      state.activeModels.set(model, (state.activeModels.get(model) || 0) + 1);
      bookTarget(nextProvider, model, viaAuto, +1);
    }
    displayModel = model;
    displayProvider = nextProvider;
    displayViaAuto = viaAuto;
    state.currentModel = model;
    state.lastModel = model;
    state.currentProvider = nextProvider;
    state.lastProvider = nextProvider;
    state.currentViaAuto = viaAuto;
    state.lastViaAuto = viaAuto;
  };
  const resolvedAttributeFor = (memberId) => {
    const source = memberId ?? currentMemberId;
    if (!attributeResolver || source === null) return null;
    const attr = attributeResolver(source);
    return attr && typeof attr === "object" ? attr : null;
  };

  return {
    attachInstance() {},
    // 链归属快照（迟到挂载的镜像靠它重放，见 bindInstance）：memberId 是
    // 成员循环最近一次宣布的成员（null = 尚未宣布/非成员循环），resolver
    // 只有链计划会安装。两个值都读实时闭包，快照随成员切换自动前进。
    getAttribution: () => ({ memberId: currentMemberId, resolver: attributeResolver }),
    recordFirstChunk: () => {
      // First genuine token on this provider+model pair clears only that pair's fault.
      // 后台请求不参与故障闩锁：它的首 token 不能替用户流量宣布故障恢复。卡片的
      // TTFT 展示（lastTtftMs/ttftHistory）同理只描述用户流量；journal 行仍带
      // 真实 TTFT（journalTtftMs 照实结算，与展示面无关）。
      if (!background) clearMatchingAggregateFault(state, meta);
      if (firstChunkTime !== null || ended) return;
      firstChunkTime = nowFn();
      const ttft = Math.max(1, firstChunkTime - startTime);
      journalTtftMs = ttft;
      if (background) return;
      state.lastTtftMs = ttft;
      state.ttftHistory.push(ttft);
      const keep = Math.max(recentSampleWindow, state.sparkWindowPoints || recentSampleWindow);
      if (state.ttftHistory.length > keep) state.ttftHistory.shift();
    },
    // Server wiring for auto-route attribution: the member loop announces the
    // member about to be attempted, and the chain plan installs its
    // memberId -> { providerId, model } resolver. Both are no-ops elsewhere.
    setCurrentMember: (memberId) => {
      currentMemberId = typeof memberId === "string" && memberId.length > 0 ? memberId : null;
      // Re-point the display model at the announced member's bound model so
      // the panel badges show the real serving model during flight. The
      // resolver's presence IS the chain provenance — only chain plans install
      // one — so an announcement that resolves here books the composite target
      // with viaAuto (服务归因语义：auto 角标跟徽章条目自身走，不读链位置快照).
      const attr = resolvedAttributeFor(currentMemberId);
      if (attr?.model) setDisplayModel(attr.model, attr.providerId, true);
    },
    setAttributeResolver: (fn) => {
      attributeResolver = typeof fn === "function" ? fn : null;
    },
    recordRetry: ({ reason, attempt, usage, memberId } = {}) => {
      state.keepAliveRetries += 1;
      state.lastKeepAliveAt = nowFn();
      // A retry means the upstream attempt failed before delivering content.
      // Count that failed attempt in model-stability so silent recovery does
      // not paint a misleading 100% success rate for the model/provider pair.
      // Pool routing: the tracker's providerId IS the pool id, and the pool is
      // one statistical unit (attempt-level) — every member attempt, failed or
      // not, counts into the pool row. meta.providerId is the URL segment, so
      // it is never empty; memberId stays only as a non-pool legacy fallback.
      if (stability && meta.model) {
        const u = usage && typeof usage === "object" ? usage : {};
        const prompt = Number(u.prompt_tokens) || 0;
        const cached = Number(
          u.prompt_tokens_details?.cached_tokens ??
          u.prompt_cache_hit_tokens ??
          u.cached_tokens ??
          0,
        ) || 0;
        const attr = resolvedAttributeFor(memberId ?? null);
        stability.record({
          providerId: attr?.providerId || meta.providerId || memberId || state.lastProvider || "",
          model: attr?.model || meta.model,
          ok: false,
          latencyMs: 0,
          prompt,
          cached,
          at: nowFn(),
        });
      }
    },
    noteKeepAliveRecovery: () => {
      state.keepAliveRecoveries += 1;
      state.lastKeepAliveAt = nowFn();
    },
    noteKeepAliveExhausted: () => {
      state.keepAliveExhausted += 1;
      state.lastKeepAliveAt = nowFn();
    },
    recordEnd: (info = {}) => {
      if (ended) return;
      // First terminal record wins, including across abort-vs-fault races:
      // a client abort observed by the transport layer and an upstream fault
      // observed by the keep-alive loop can race on the same request; the
      // earliest definitive signal is the truthful one (late-arriving 502s
      // must not overwrite a recorded abort with a phantom fault).
      if (info?.aborted && endedWithFault) return;
      if (endedWithAbort) return;
      if (info?.aborted) endedWithAbort = true;
      else if (info?.error || (typeof info?.status === "number" && info.status >= 400)) endedWithFault = true;
      ended = true;
      state.activeRequests = Math.max(0, state.activeRequests - 1);
      // Decrement the key this request currently occupies — displayModel, not
      // meta.model, because setCurrentMember may have re-pointed an "auto"
      // request at the serving node's bound model. The composite ledger
      // unbooks the same (channel, model, provenance) triple.
      if (displayModel !== null && state.activeModels.has(displayModel)) {
        const count = state.activeModels.get(displayModel) - 1;
        if (count <= 0) state.activeModels.delete(displayModel);
        else state.activeModels.set(displayModel, count);
      }
      if (displayModel !== null) {
        bookTarget(displayProvider, displayModel, displayViaAuto, -1);
      }
      if (state.activeRequests === 0) {
        state.currentModel = null;
        state.currentProvider = null;
        state.activeModels.clear();
        state.activeTargets.clear();
        state.currentViaAuto = null;
      } else if (state.activeModels.size > 0) {
        // If other models still generating, currentModel is latest or combined
        state.currentModel = Array.from(state.activeModels.keys()).join(" + ");
      }
      const endTime = nowFn();
      const reqDuration = Math.max(1, endTime - startTime);
      state.totalActiveDurationMs += reqDuration;
      if (state.activeRequests === 0 && state.activeWallStart !== null) {
        // Wall-clock union: settle the busy interval only when the LAST
        // concurrent request finishes — overlapping requests contributed the
        // same physical seconds exactly once.
        state.activeWallClockMs += Math.max(1, endTime - state.activeWallStart);
        state.activeWallStart = null;
      }
      state.lastRequestAt = endTime;

      // Fault lifecycle: a failed request raises errorActive. Clearance is
      // first-token (recordFirstChunk) or a non-streaming success on the same
      // pair — retry begin must not hide a still-failing upstream. Empty or
      // truncated streams never look like success because the stream guard
      // retries them before the first token; if this attempt fails, recordEnd
      // re-latches. 后台请求（background）全程不碰这条闩锁：失败不 raise
      // （记忆流水线硬编码模型的 404 不该伪装成用户故障横幅），成功也不走
      // 下面的 clear 分支替用户流量宣布恢复。
      const hadError = Boolean(info.error) || (typeof info.status === "number" && info.status >= 400);
      const aborted = Boolean(info.aborted);
      // Pool routing: the actual failing member (when the channel reports one)
      // rides the failure entry as a display field and owns the stability
      // attribution below; the fault latch itself stays keyed by the tracker
      // provider (the pool id) so a later first-chunk on the same pool+model
      // still clears it.
      const memberId = typeof info.memberId === "string" && info.memberId.length > 0 ? info.memberId : null;
      // Auto-route attribution for the terminal record: the serving member is
      // either the one the caller recorded (exhaustion/terminal passthrough)
      // or the one last attempted (pipe-internal ends carry no memberId).
      const attr = resolvedAttributeFor(memberId);

      if (hadError && !background) {
        const model = meta.model || state.lastModel;
        const providerId = meta.providerId || state.lastProvider;
        const entry = {
          status: Number(info.error?.status ?? info.status) || 500,
          message: info.error?.message || (typeof info.status === "number" ? `HTTP ${info.status}` : "Upstream Error"),
          time: endTime,
          model,
          providerId,
        };
        if (memberId !== null) entry.memberId = memberId;
        const key = faultKey(providerId, model);
        state.lastError = entry;
        if (key !== null) {
          state.activeFaults.set(key, entry);
          syncAggregateFaultLatch(state);
        } else {
          state.errorActive = true;
          state.keylessFaultAt = endTime;
        }
      } else if (!hadError && !background && !aborted && firstChunkTime === null) {
        clearMatchingAggregateFault(state, meta);
      }

      // The generation window is the honest wall-clock between the first token
      // and the end of the request — no rate-based rewriting of the denominator.
      // A request that never streamed a first chunk has no measurable window at
      // all (null); the statistics page drops those rows from TPS for the same
      // reason, so the card must not invent a denominator for them either.
      // Failed/aborted requests never generated tokens, so their wall-clock
      // duration must not feed TPS or the window.
      let genDurationMs = null;
      if (firstChunkTime !== null) {
        genDurationMs = Math.max(1, endTime - firstChunkTime);
        state.totalGenerationDurationMs += genDurationMs;
      } else if (!hadError && !aborted) {
        // Non-streaming success: the full request duration is the best TTFT
        // proxy available. Failed/aborted requests never produced a first
        // token — recording their failure duration would fabricate a
        // healthy-looking TTFT and mask the fault from the panel.
        // journal 与总时长照实结算；卡片 TTFT 展示面（lastTtftMs/ttftHistory）
        // 只描述用户流量，后台请求跳过。
        journalTtftMs = reqDuration;
        state.totalGenerationDurationMs += reqDuration;
        if (!background) {
          state.lastTtftMs = reqDuration;
          state.ttftHistory.push(reqDuration);
          const keep = Math.max(recentSampleWindow, state.sparkWindowPoints || recentSampleWindow);
          if (state.ttftHistory.length > keep) state.ttftHistory.shift();
        }
      }
      // Errors/aborts before any content: no generation happened — nothing to add.

      const usage = info.usage;
      if (usage && typeof usage === "object") {
        const prompt = Number(usage.prompt_tokens) || 0;
        const completion = Number(usage.completion_tokens) || 0;
        const cached = Number(
          usage.prompt_tokens_details?.cached_tokens ??
          usage.prompt_cache_hit_tokens ??
          usage.cached_tokens ??
          0,
        ) || 0;

        state.totalPromptTokens += prompt;
        state.totalCompletionTokens += completion;
        state.totalCachedTokens += cached;

        // Feed the sliding window only from requests that genuinely produced
        // completion tokens. windowTps turns these samples into the card's
        // number, sampleTps into the sparkline points — one rule, one population,
        // and the same statistic the statistics page publishes.
        // 后台请求即便成功也不进窗：卡片 TPS/缓存率/折线图只描述用户流量。
        if (!background && !hadError && !aborted && completion > 0) {
          state.recentSamples.push({
            completion,
            genDurationMs,
            prompt,
            cached,
          });
          const keep = Math.max(recentSampleWindow, state.sparkWindowPoints || recentSampleWindow);
          if (state.recentSamples.length > keep) {
            state.recentSamples.shift();
          }
        }
      }

      // 模型稳定性是用户流量的路由健康信号：后台请求（硬编码后台模型的
      // 404 之类）不写入，否则稳定性页会留下永不恢复的全红行。
      if (stability && meta.model && !aborted && !background) {
        const u = usage && typeof usage === "object" ? usage : {};
        const prompt = Number(u.prompt_tokens) || 0;
        const cached = Number(
          u.prompt_tokens_details?.cached_tokens ??
          u.prompt_cache_hit_tokens ??
          u.cached_tokens ??
          0,
        ) || 0;
        // Same pool-level attribution as recordRetry: meta.providerId is the
        // pool id for pool requests, and successes and failures both belong
        // to the pool's single stability row. Chain (auto) requests override
        // via the resolved attribute, attributing to the serving node.
        // ttftMs mirrors the usage-journal rule: the real first-chunk TTFT
        // for streams, the full-duration proxy for non-streaming successes,
        // and none for failures — a failed attempt has no first token, and
        // feeding its wait duration would paint a dead node yellow/green.
        stability.record({
          providerId: attr?.providerId || meta.providerId || memberId || state.lastProvider || "",
          model: attr?.model || meta.model,
          ok: !hadError,
          latencyMs: reqDuration,
          prompt,
          cached,
          ttftMs: hadError ? null : journalTtftMs,
          at: endTime,
        });
      }

      // Usage journal: exactly one line per client request, written here at
      // the terminal recordEnd. The `ended`/`endedWithAbort` guards at the
      // top of recordEnd make this first-terminal-record-wins, so retried
      // attempts (recordRetry) and late duplicate recordEnd calls never
      // produce extra lines. Aborted requests are skipped outright, matching
      // the model-stability attribution above.
      if (journal && !aborted) {
        try {
          const u = usage && typeof usage === "object" ? usage : {};
          const status = Number(info.error?.status ?? info.status) || null;
          journal.appendRequest({
            ts: endTime,
            agentId,
            providerId: attr?.providerId || meta.providerId || memberId || state.lastProvider || "",
            model: attr?.model || meta.model || state.lastModel || null,
            prompt: Number(u.prompt_tokens) || 0,
            completion: Number(u.completion_tokens) || 0,
            cached: Number(
              u.prompt_tokens_details?.cached_tokens ??
              u.prompt_cache_hit_tokens ??
              u.cached_tokens ??
              0,
            ) || 0,
            ttftMs: hadError ? null : journalTtftMs,
            durationMs: reqDuration,
            ok: !hadError,
            status,
            errKind: hadError
              ? classifyErrKind({ status, message: info.error?.message })
              : null,
            stream: meta.stream === true,
            path: typeof meta.path === "string" ? meta.path : null,
            // 有则写：未注入实例的客户端不产生这个键，保持旧行形状不变。
            ...(journalInstanceId !== null ? { instanceId: journalInstanceId } : {}),
          });
        } catch (error) {
          console.warn(`[agent-metrics] usage journal append failed: ${error.message}`);
        }
      }
    },
  };
}

// Fan a request's lifecycle events out to the endpoint aggregate tracker and
// its per-instance mirror. The mirror is created with journal/stability null,
// so the side-band writes (usage journal, model stability) stay single-writer
// on the aggregate tracker and never double-count.
function composeInstanceTracker(primary, mirror) {
  const both = (method) => (arg) => {
    primary[method]?.(arg);
    mirror[method]?.(arg);
  };
  return {
    recordFirstChunk: both("recordFirstChunk"),
    setCurrentMember: both("setCurrentMember"),
    setAttributeResolver: both("setAttributeResolver"),
    recordRetry: both("recordRetry"),
    noteKeepAliveRecovery: both("noteKeepAliveRecovery"),
    noteKeepAliveExhausted: both("noteKeepAliveExhausted"),
    recordEnd: both("recordEnd"),
    attachInstance: primary.attachInstance,
  };
}

// Snapshot shape for activeTargets (channel×model in-flight counts). Entries
// only exist while their requests are in flight; a zero activeRequests state
// must never leak phantom entries (orphan-settle paths clear activeModels but
// cannot know this map's keys), so the snapshot gates on activeRequests.
function activeTargetList(state) {
  if (state.activeRequests <= 0) return [];
  return Array.from(state.activeTargets.values()).map((t) => ({
    providerId: t.providerId,
    model: t.model,
    count: t.count,
    autoCount: t.autoCount,
  }));
}

function buildAggregateAgentStatus({ id, name, state, processCount, tpsWindow = RECENT_SAMPLE_WINDOW, nowFn = Date.now, instances = null }) {
  const isRunning = processCount > 0 || state.activeRequests > 0;

  // Display duration = settled busy intervals + the still-running tail, so the
  // number grows smoothly while a request is in flight and never exceeds
  // physical elapsed time no matter how many requests overlap.
  let activeDurationMs = state.activeWallClockMs;
  if (state.activeWallStart !== null) {
    activeDurationMs += Math.max(0, nowFn() - state.activeWallStart);
  }

  const tpsSamples = state.recentSamples.slice(-tpsWindow);
  const ttftForAvg = state.ttftHistory.slice(-tpsWindow);

  // One statistic for the card and the statistics page: token-weighted speed
  // over the samples that carry a real generation window (windowTps), and cached
  // tokens over prompt tokens for the hit rate. Both are windowed — never
  // process-lifetime, and never a mean of per-request quotients.
  const tps = windowTps(tpsSamples, tpsWindow);
  const cacheHitRate = windowCacheHitRate(tpsSamples, tpsWindow);

  let avgTtft = null;
  if (ttftForAvg.length > 0) {
    const sum = ttftForAvg.reduce((a, b) => a + b, 0);
    avgTtft = Math.round(sum / ttftForAvg.length);
  }

  const ttftColor = getTtftColor(state.lastTtftMs);

  const activeErrors = Array.from(state.activeFaults.values()).sort((a, b) => a.time - b.time);

  const sessions = [
    {
      id: `${id}-global`,
      title: "全局汇总",
      status: state.activeRequests > 0 ? "active" : (isRunning ? "idle" : "stopped"),
      tps,
      cacheHitRate,
      lastTtftMs: state.lastTtftMs,
      avgTtftMs: avgTtft,
      ttftColor,
      activeDurationMs,
      activeDurationFormatted: formatDuration(activeDurationMs),
      requests: state.totalRequests,
      activeRequests: state.activeRequests,
      // 模型×渠道展示配对字段：全局汇总 session 与 per-instance 快照同形
      // （instanceSnapshots 展开本对象），实例行「模型 @ 渠道」标签直接取用。
      currentModel: state.currentModel,
      lastModel: state.lastModel,
      currentProvider: state.currentProvider,
      lastProvider: state.lastProvider,
      currentViaAuto: state.currentViaAuto ?? false,
      lastViaAuto: Boolean(state.lastViaAuto),
      activeTargets: activeTargetList(state),
      lastError: state.lastError,
      errorActive: state.errorActive,
      activeErrors,
      tokens: {
        prompt: state.totalPromptTokens,
        completion: state.totalCompletionTokens,
        cached: state.totalCachedTokens,
      },
      lastSeen: state.lastRequestAt,
    },
  ];

  const sparkLimit = parseSparkWindowPoints(state.sparkWindowPoints);
  const sparkHistory = {
    ttft: state.ttftHistory.slice(-sparkLimit).map((ms) => Number((ms / 1000).toFixed(2))),
    tps: state.recentSamples.map(sampleTps).filter((v) => v !== null).slice(-sparkLimit),
    cache: state.recentSamples.map((s) => {
      if (s.prompt > 0) return Number(((s.cached / s.prompt) * 100).toFixed(1));
      return 0;
    }).slice(-sparkLimit),
  };

  return {
    id,
    name,
    status: isRunning ? "running" : "stopped",
    processCount,
    sessionMode: "aggregate",
    currentModel: state.currentModel,
    lastModel: state.lastModel,
    activeModels: Array.from(state.activeModels.keys()),
    currentProvider: state.currentProvider,
    lastProvider: state.lastProvider,
    currentViaAuto: state.currentViaAuto ?? false,
    lastViaAuto: Boolean(state.lastViaAuto),
    activeTargets: activeTargetList(state),
    lastError: state.lastError,
    errorActive: state.errorActive,
    activeErrors,
    metrics: {
      tps,
      cacheHitRate,
      lastTtftMs: state.lastTtftMs,
      avgTtftMs: avgTtft,
      ttftColor,
      activeDurationMs,
      activeDurationFormatted: formatDuration(activeDurationMs),
      totalRequests: state.totalRequests,
      activeRequests: state.activeRequests,
      currentModel: state.currentModel,
      lastModel: state.lastModel,
      activeModels: Array.from(state.activeModels.keys()),
      keepAlive: {
        retries: state.keepAliveRetries,
        recoveries: state.keepAliveRecoveries,
        exhausted: state.keepAliveExhausted,
        lastAt: state.lastKeepAliveAt,
      },
      sparkHistory,
      tokens: {
        prompt: state.totalPromptTokens,
        completion: state.totalCompletionTokens,
        cached: state.totalCachedTokens,
      },
    },
    sessions,
    // Per-instance snapshots for multi-instance endpoints (null elsewhere —
    // aggregate-only endpoints never carry the key).
    ...(instances === null ? {} : { instances }),
  };
}

// ---------------------------------------------------------------------------
// Persistent PowerShell process-scan probe.
//
// Why a resident child instead of one `exec` per round: wmic no longer exists
// on Win11 24H2, so the old probe chain paid a full powershell.exe cold start
// (~0.5s measured on this machine) every 2.5s while the board was open — that
// process-creation churn is what made the panel feel sticky again. Spawning
// once and reusing stdin/stdout drops a round to tens of milliseconds; the
// query itself is the same Get-CimInstance row dump the fallback used to run.
//
// Protocol: each query is one line on the child's stdin, answered by the CSV
// rows followed by a unique end-marker line. A query that times out, or a
// child that dies mid-query, rejects — the caller then falls back to tasklist
// for that round, and the next query spawns a fresh child. An idle child is
// killed after PS_PROBE_IDLE_MS so a hidden panel leaves zero resident
// processes behind. Children are unref'd (they never keep the host process
// alive) and are killed from one shared process-exit hook.
// ---------------------------------------------------------------------------
const PS_PROBE_TIMEOUT_MS = 3000;
const PS_PROBE_IDLE_MS = 60000;

// `-Command -` would buffer stdin to EOF before executing — useless for a
// resident probe. This read-eval loop runs each line as it arrives with no
// prompt and no input echo, which is what makes stdin/stdout reuse possible.
const PS_REPL_COMMAND =
  "while (($line = [Console]::In.ReadLine()) -ne $null) { try { Invoke-Expression $line } catch { Write-Output \"ERR: $_\" } }";

// Same row dump the old per-round PowerShell fallback ran: ParentProcessId
// rides the same query to build the lineage table instance-id normalization
// walks; cmd.exe joins the name filter because launcher → client chains pass
// through a `cmd /c` shim (the launchers spawn via COMSPEC) and a missing
// intermediate hop would break ancestor resolution. cmd.exe rows feed only
// the lineage table — no counting branch claims them.
const PS_PROCESS_SCAN_QUERY =
  "Get-CimInstance Win32_Process -Filter \"name='node.exe' or name='claude.exe' or name='ZCode.exe' or name='dsh.exe' or name='pi.exe' or name='opencode.exe' or name='Qoder.exe' or name='codex.exe' or name='codex-code-mode-host.exe' or name='codex-command-runner.exe' or name='ChatGPT.exe' or name='grok.exe' or name='Kimi Code.exe' or name='cmd.exe'\" | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId),$($_.Name),$($_.CommandLine)\" }";

const livePsProbeChildren = new Set();
let psProbeExitHookInstalled = false;

function createPersistentPsProbe({ spawnFn, queryText }) {
  let child = null;
  let stdoutBuf = "";
  let pending = null; // { marker, resolve, reject, timer }
  let querySeq = 0;
  let idleTimer = null;

  const dropChild = (err) => {
    const c = child;
    child = null;
    stdoutBuf = "";
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (pending !== null) {
      const p = pending;
      pending = null;
      clearTimeout(p.timer);
      p.reject(err);
    }
    if (c !== null) {
      livePsProbeChildren.delete(c);
      try { c.kill(); } catch { /* already dead */ }
    }
  };

  const armIdleTimer = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => dropChild(new Error("ps probe idle")), PS_PROBE_IDLE_MS);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  };

  const ensureChild = () => {
    if (child !== null) return child;
    const c = spawnFn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_REPL_COMMAND], { windowsHide: true });
    stdoutBuf = "";
    c.stdout.setEncoding("utf8");
    c.stderr.resume(); // drain so the pipe never back-pressures; content is noise
    c.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      if (pending === null) return;
      const markerIdx = stdoutBuf.indexOf(pending.marker);
      if (markerIdx === -1) return;
      const out = stdoutBuf.slice(0, markerIdx);
      stdoutBuf = stdoutBuf.slice(markerIdx + pending.marker.length);
      const p = pending;
      pending = null;
      clearTimeout(p.timer);
      p.resolve(out);
    });
    c.on("error", (err) => dropChild(err));
    c.on("exit", () => dropChild(new Error("ps probe child exited")));
    if (typeof c.unref === "function") c.unref();
    for (const stream of [c.stdin, c.stdout, c.stderr]) {
      if (stream && typeof stream.unref === "function") stream.unref();
    }
    livePsProbeChildren.add(c);
    if (!psProbeExitHookInstalled) {
      psProbeExitHookInstalled = true;
      process.once("exit", () => {
        for (const live of livePsProbeChildren) {
          try { live.kill(); } catch { /* best effort */ }
        }
      });
    }
    child = c;
    return c;
  };

  return {
    // `text` defaults to the probe's standing query (the process scan); the
    // DSH console check passes its own one-liner through the same REPL.
    query(text) {
      return new Promise((resolve, reject) => {
        if (pending !== null) {
          reject(new Error("ps probe query already in flight"));
          return;
        }
        let c;
        try {
          c = ensureChild();
        } catch (err) {
          reject(err);
          return;
        }
        const marker = `__ANYSWITCH_PS_PROBE_END_${++querySeq}__`;
        pending = {
          marker,
          resolve,
          reject,
          timer: setTimeout(() => {
            // A wedged child never answers: drop it so the next round respawns.
            dropChild(new Error("ps probe query timeout"));
          }, PS_PROBE_TIMEOUT_MS),
        };
        // NOTE: the query timer stays REF'd on purpose. Child and stdio are
        // unref'd so an idle probe never holds the host's event loop — but
        // with everything unref'd the loop can drain mid-query and the answer
        // never arrives (observed: unsettled top-level await). The pending
        // timer is the one handle that keeps the loop alive until the answer
        // (or the timeout) lands; it is always cleared on settle.
        armIdleTimer();
        stdoutBuf = ""; // discard any tail of a previous answer before asking
        try {
          c.stdin.write(`${text ?? queryText} ; Write-Output '${marker}'\n`);
        } catch (err) {
          dropChild(err);
        }
      });
    },
  };
}

export function createAgentMetricsCollector(options = {}) {
  const execFn = options.execFn ?? exec;
  const nowFn = options.nowFn ?? Date.now;
  const psProbe = createPersistentPsProbe({ spawnFn: options.spawnFn ?? spawn, queryText: PS_PROCESS_SCAN_QUERY });
  let sparkWindowPoints = parseSparkWindowPoints(options.sparkWindowPoints ?? DEFAULT_SPARK_WINDOW_POINTS);
  const recentSampleWindow = options.recentSampleWindow ?? RECENT_SAMPLE_WINDOW;
  const faultIdleTtlMs = options.faultIdleTtlMs ?? FAULT_IDLE_TTL_MS;
  const loadSparkSettings = options.loadSparkSettings === undefined
    ? loadSettings
    : (options.loadSparkSettings || null);
  const persistRoot = options.persistRoot;
  // Optional usage journal (usage-journal.mjs). Only the relay process wires
  // one in; the panel and per-launch launcher collectors pass nothing and
  // behave exactly as before.
  const journal = options.journal ?? null;
  const stability = options.stability ?? createModelStabilityTracker({
    nowFn,
    persistPath: options.stabilityPath ?? (persistRoot ? join(persistRoot, STABILITY_FILENAME) : null),
  });

  // Process detection cache — stale-while-revalidate, never blocking past the
  // first snapshot.
  //
  // The probe is one RESIDENT powershell.exe per collector (see
  // createPersistentPsProbe): wmic is gone on Win11 24H2, and a per-round
  // powershell cold start cost ~0.5s every TTL window while the board was
  // open. Reads therefore never wait for a scan once any snapshot exists: the
  // first reader past the TTL kicks a background round and gets the previous
  // snapshot, however old. Serving a few extra seconds of staleness on a
  // display-only path beats what the old "stale ceiling" did — it made every
  // first frame after an idle gap (hidden tab pauses polling; the panel is
  // revisited minutes later) wait a full probe round, which is exactly the
  // stall a user feels when switching back to the panel. The only blocking
  // case left is a collector with no snapshot at all (process startup), where
  // there is nothing to serve.
  const PROCESS_SCAN_TTL_MS = 2500;
  let lastProcessScanTime = 0;
  // No snapshot has landed since this collector was created. Until one does,
  // there is nothing worth serving: the initial empty scan is not process state.
  let hasProcessScanResult = false;
  let cachedProcessCounts = createEmptyProcessScan();
  let pendingScanPromise = null;

  // DSH terminal-orphan reap (see the console-probe block above). Runs inside
  // every resident scan round, only when a TUI-profile engine pid exists.
  // Mutates `counts` in place so the landed snapshot already excludes the
  // reaped session, and kills the process only after two dead verdicts one
  // round apart. `options.killFn` exists so tests can observe the kill.
  const killProcessFn = options.killFn ?? ((pid) => process.kill(pid, "SIGTERM"));
  const dshDeadConsoleStreak = new Map(); // TUI engine pid -> consecutive dead rounds
  async function reapDshTerminalOrphans(counts) {
    const enginePids = counts.dshEnginePids instanceof Set ? counts.dshEnginePids : new Set();
    const tuiPids = [];
    for (const pid of enginePids) {
      if (DSH_TUI_CONSOLE_PROFILES.has(counts.dshProfileByPid?.get(pid))) tuiPids.push(pid);
    }
    // Streak bookkeeping only tracks pids the current scan still lists, so a
    // reused pid can never inherit an old verdict.
    for (const pid of dshDeadConsoleStreak.keys()) {
      if (!enginePids.has(pid)) dshDeadConsoleStreak.delete(pid);
    }
    if (tuiPids.length === 0) return;
    const query = buildDshConsoleQuery(tuiPids);
    if (query === null) return;
    const out = await psProbe.query(query).catch(() => null);
    const verdicts = parseDshConsoleQueryOutput(out);
    if (verdicts.size === 0) return; // unreadable round: every pid keeps its row
    const reaped = [];
    for (const pid of tuiPids) {
      const err = verdicts.get(pid);
      if (err === undefined) continue; // no verdict for this pid this round
      if (err !== 0 && err !== DSH_NO_CONSOLE_ERR) {
        const streak = (dshDeadConsoleStreak.get(pid) ?? 0) + 1;
        dshDeadConsoleStreak.set(pid, streak);
        if (streak >= DSH_DEAD_CONSOLE_CONFIRM_ROUNDS) reaped.push(pid);
      } else {
        dshDeadConsoleStreak.delete(pid); // live terminal resets the streak
      }
    }
    for (const pid of reaped) {
      counts.dsh = Math.max(0, (counts.dsh ?? 0) - 1);
      counts.dshEnginePids?.delete(pid);
      counts.dshPids?.delete(pid);
      counts.dshProfileByPid?.delete(pid);
      dshDeadConsoleStreak.delete(pid);
      try {
        killProcessFn(pid);
      } catch {
        // Gone between scan and kill: the sets above already dropped it and
        // the next scan will not list it either.
        continue;
      }
      console.warn(`[agent-metrics] reaped DSH TUI process ${pid}: terminal closed, process stayed`);
    }
  }

  // Kimi 面提级（分面口径见 summarizeKimiSurfaces 上方）。注册表只回答一件事：
  // 「这个 node 进程自己起了 server」——所以进程号必须已经被本轮扫描认作 kimi
  // engine，且只提级「终端」那一档；桌面端由镜像名定性，注册表无权改动它。
  // 读不出（目录缺失、无权限、整轮抛错）就整批不动，退化成今天的行为：所有
  // kimi 进程都算终端面，卡片照常计数、副行照常加总。
  const kimiRegistryLookup = options.kimiRegistryLookup ?? readKimiServerInstances;
  async function attachKimiSurfaces(counts) {
    const enginePids = counts.kimiEnginePids instanceof Set ? counts.kimiEnginePids : new Set();
    if (enginePids.size === 0) return;
    let registered;
    try {
      registered = await kimiRegistryLookup({ env: options.env ?? process.env, nowFn });
    } catch {
      return;
    }
    if (!(registered instanceof Map) || registered.size === 0) return;
    for (const pid of enginePids) {
      if (counts.kimiSurfaceByPid?.get(pid) !== "tui") continue;
      if (registered.has(pid)) counts.kimiSurfaceByPid.set(pid, "web");
    }
  }

  function startProcessScan() {
    pendingScanPromise = (async () => {
      const land = (counts) => {
        cachedProcessCounts = counts;
        // Stamped where the data lands, not when the probe started, so the age
        // math in scanProcesses() means "how fresh is what I'm serving".
        lastProcessScanTime = nowFn();
        hasProcessScanResult = true;
      };

      // 1. Resident PowerShell probe (fast path). Empty output counts as a
      // failed round — the tasklist fallback still gets its say.
      const psOut = await psProbe.query().catch(() => null);
      if (typeof psOut === "string" && psOut.trim().length > 0) {
        const counts = parseTasklistCsv(psOut);
        // Terminal-orphan reap before landing: the snapshot the panel reads
        // must already exclude the reaped session.
        await reapDshTerminalOrphans(counts);
        await attachKimiSurfaces(counts);
        land(counts);
        return cachedProcessCounts;
      }

      // 2. Ultimate fallback: standard tasklist CSV. No parent column on
      // this path — the lineage table stays empty and ancestor-based
      // instance-id normalization degrades to a no-op (ids pass through).
      await new Promise((resolve) => {
        execFn('tasklist /NH /FO CSV', { timeout: 3000, windowsHide: true }, async (err, stdout) => {
          if (!err && typeof stdout === "string") {
            const counts = parseTasklistCsv(stdout);
            await attachKimiSurfaces(counts);
            land(counts);
          } else {
            // Every probe failed. Stamp the window anyway so a broken probe
            // chain retries once per cache window rather than once per reader;
            // do NOT mark a result landed — this round produced nothing.
            lastProcessScanTime = nowFn();
          }
          resolve();
        });
      });
      return cachedProcessCounts;
    })();

    // Clear the in-flight marker after the scan settles so the next call
    // past the cache window re-scans. Using .then keeps this correct for both
    // async probes (real child processes) and sync ones (test mocks): the
    // clear runs after the resolve, never before the outer assignment lands.
    pendingScanPromise.then(() => {
      pendingScanPromise = null;
    });

    return pendingScanPromise;
  }

  async function scanProcesses() {
    const age = nowFn() - lastProcessScanTime;
    // Revalidate in the background; this reader (and every reader until the round
    // lands) keeps being served the previous snapshot. Coalescing stays with
    // pendingScanPromise, so one round is ever in flight.
    if (age >= PROCESS_SCAN_TTL_MS && pendingScanPromise === null) startProcessScan();
    // Nothing has landed yet: there is no snapshot to serve stale, so join the
    // round in flight (or hand back the empty scan while a failed round's retry
    // window is still closed — the same answer the blocking path gave before).
    if (!hasProcessScanResult) return pendingScanPromise ?? cachedProcessCounts;
    return cachedProcessCounts;
  }

  // Session-title lookup for codex session rows. The default walks
  // ~/.codex/sessions/**.jsonl through session-scan's codex adapter — far too
  // heavy for the panel's 1s poll, so the result is cached and the import is
  // lazy (launchers and the watchdog import this module too; they never list
  // codex session rows and must not pay session-scan's sqlite/zlib imports
  // for nothing). Tests inject codexSessionLookup instead.
  const codexSessionLookup = options.codexSessionLookup ?? null;
  const CODEX_SESSION_LOOKUP_TTL_MS = 15000;
  let codexSessionInfoCache = null; // { at, byId } | null

  async function loadCodexSessionInfo() {
    const now = nowFn();
    if (codexSessionInfoCache !== null && now - codexSessionInfoCache.at < CODEX_SESSION_LOOKUP_TTL_MS) {
      return codexSessionInfoCache.byId;
    }
    let sessions = [];
    try {
      sessions = codexSessionLookup !== null
        ? await codexSessionLookup()
        : await (await import("./session-scan.mjs")).defaultScanner.adapters.get("codex").scan();
    } catch {
      sessions = []; // a scan failure must never break the status read
    }
    const byId = new Map();
    for (const meta of Array.isArray(sessions) ? sessions : []) {
      if (meta && typeof meta.id === "string") byId.set(meta.id, meta);
    }
    codexSessionInfoCache = { at: now, byId };
    return byId;
  }

  // Aggregate metrics state
  const zcodeState = createAggregateState();
  const dshState = createAggregateState();
  const piState = createAggregateState();
  const kimiState = createAggregateState();
  const qoderState = createAggregateState();
  const opencodeState = createAggregateState();
  const claudeState = createAggregateState();
  const codexState = createAggregateState();
  const grokState = createAggregateState();

  // 无归属请求的专用承载态：不进 endpointStates（看板不可见、快照不持久化）、
  // 不进 instanceBuckets（无实例行），存在只为让 tracker 生命周期复用
  // trackAggregateRequest 的既有记账逻辑、给 journal 留 agentId: null 的
  // 审计行。渠道×模型稳定性是与端点无关的上游健康视图，照常记录。
  const unattributedState = createAggregateState();

  // Per-instance buckets for the multi-instance endpoints (kimi / opencode /
  // pi / codex / grok / dsh): instanceId -> { state, firstSeen }. Only requests
  // carrying a valid instanceId land here, and they ALSO land in the endpoint
  // aggregate above, so the existing cards are unchanged. claude is
  // per-session already; zcode/qoder stay aggregate-only by design.
  // dsh joins on the same socket-reverse-lookup mechanism the other CLI
  // endpoints use: every DSH surface (web UI, TUI, any custom profile) talks to
  // the loopback relay over its own keep-alive connection, so one row per
  // process is reachable without asking the client to send anything. The row
  // identity is the ENGINE pid from the process scan, never a conversation id:
  // DSH carries its session id as far as the LLM adapter but never puts it on
  // the wire (its compat gate withholds the session-affinity headers), so
  // per-conversation truth stays on the ~/.dsh/sessions scan, where it is
  // already accurate.
  const instanceBuckets = { dsh: new Map(), kimi: new Map(), opencode: new Map(), pi: new Map(), codex: new Map(), grok: new Map() };

  // Cross-restart snapshot wiring (see the METRICS_SNAPSHOT_* constants). The
  // relay process wires persistRoot in, so it owns the file; the panel and
  // watchdog collectors (no persistRoot) skip every step and behave exactly
  // as before.
  const metricsSnapshotPath = options.metricsSnapshotPath
    ?? (persistRoot ? join(persistRoot, METRICS_SNAPSHOT_FILENAME) : null);
  const metricsSnapshotEveryMs = options.metricsSnapshotEveryMs ?? METRICS_SNAPSHOT_EVERY_MS;
  const endpointStates = {
    zcode: zcodeState,
    claude: claudeState,
    dsh: dshState,
    pi: piState,
    kimi: kimiState,
    qoder: qoderState,
    codex: codexState,
    opencode: opencodeState,
    grok: grokState,
  };
  let metricsSnapshotDirty = false;
  let lastMetricsSnapshotAt = 0;

  function markMetricsDirty() {
    metricsSnapshotDirty = true;
  }

  function serializeMetricsSnapshot(now) {
    const endpoints = {};
    for (const [id, state] of Object.entries(endpointStates)) {
      endpoints[id] = serializeAggregateState(state);
    }
    const instances = {};
    for (const [bucket, instMap] of Object.entries(instanceBuckets)) {
      instances[bucket] = [...instMap.entries()].map(([id, entry]) => ({
        id,
        firstSeen: entry.firstSeen,
        label: entry.label,
        state: serializeAggregateState(entry.state),
      }));
    }
    return { version: METRICS_SNAPSHOT_VERSION, savedAt: now, endpoints, instances };
  }

  function persistMetricsSnapshot(now = nowFn()) {
    if (metricsSnapshotPath === null) return false;
    try {
      atomicWriteFile(metricsSnapshotPath, JSON.stringify(serializeMetricsSnapshot(now), null, 2));
      metricsSnapshotDirty = false;
      lastMetricsSnapshotAt = now;
      return true;
    } catch {
      // Best-effort like model-stability: the in-memory collector stays the
      // source of truth; a locked/unwritable dir must never reach a request.
      return false;
    }
  }

  function maybePersistMetricsSnapshot(now = nowFn()) {
    if (!metricsSnapshotDirty) return;
    if (now - lastMetricsSnapshotAt < metricsSnapshotEveryMs) return;
    persistMetricsSnapshot(now);
  }

  function restoreMetricsSnapshot() {
    if (metricsSnapshotPath === null || !existsSync(metricsSnapshotPath)) return;
    let raw;
    try {
      raw = JSON.parse(readFileSync(metricsSnapshotPath, "utf8"));
    } catch {
      return; // corrupt sidecar: start empty; the next persist overwrites it
    }
    if (!raw || raw.version !== METRICS_SNAPSHOT_VERSION) return;
    const sampleKeep = Math.max(recentSampleWindow, sparkWindowPoints);
    if (raw.endpoints && typeof raw.endpoints === "object") {
      for (const [id, state] of Object.entries(endpointStates)) {
        restoreAggregateState(state, raw.endpoints[id], sampleKeep);
      }
    }
    if (raw.instances && typeof raw.instances === "object") {
      for (const [bucket, rows] of Object.entries(raw.instances)) {
        const instMap = instanceBuckets[bucket];
        if (instMap === undefined || !Array.isArray(rows)) continue;
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          // Only ids that survive their own sanitizer are trusted back in —
          // the file is a sidecar, not a trusted channel.
          if (sanitizeInstanceId(row.id) !== row.id) continue;
          if (instMap.has(row.id)) continue;
          const entry = {
            state: createAggregateState(),
            firstSeen: snapshotFinite(row.firstSeen) || nowFn(),
            label: typeof row.label === "string" ? row.label : null,
          };
          restoreAggregateState(entry.state, row.state, sampleKeep);
          instMap.set(row.id, entry);
        }
      }
    }
    // Liveness reconciliation is deliberately NOT repeated here: the first
    // getAgentsStatus read already evicts rows whose owning PID is dead (the
    // "<agentId>-<pid>" id-shape rule) and expires custom ids past the idle
    // TTL — duplicating that verdict here would fork its logic.
  }

  restoreMetricsSnapshot();
  const metricsSnapshotTimer = metricsSnapshotPath !== null
    ? setInterval(() => maybePersistMetricsSnapshot(), metricsSnapshotEveryMs)
    : null;
  metricsSnapshotTimer?.unref?.();

  function applySparkWindow(n) {
    sparkWindowPoints = parseSparkWindowPoints(n);
    const keep = Math.max(recentSampleWindow, sparkWindowPoints);
    for (const state of [zcodeState, dshState, piState, kimiState, qoderState, opencodeState, claudeState, codexState, grokState]) {
      state.sparkWindowPoints = sparkWindowPoints;
      while (state.ttftHistory.length > keep) state.ttftHistory.shift();
      while (state.recentSamples.length > keep) state.recentSamples.shift();
    }
  }
  applySparkWindow(sparkWindowPoints);

  function isDshRequest(meta = {}) {
    if (typeof meta.agentId === "string" && meta.agentId.toLowerCase().trim() === "dsh") return true;
    if (typeof meta.userAgent === "string") {
      const ua = meta.userAgent.toLowerCase();
      if (ua.includes("deepseek") || ua.includes("dsh")) return true;
    }
    return false;
  }

  function isPiRequest(meta = {}) {
    if (typeof meta.agentId === "string") {
      const id = meta.agentId.toLowerCase().trim();
      if (id === "pi") return true;
    }
    if (typeof meta.userAgent === "string") {
      const ua = meta.userAgent.toLowerCase();
      if (ua.includes("pi/") || ua.includes("pi-client")) return true;
    }
    return false;
  }

  function isQoderRequest(meta = {}) {
    if (typeof meta.agentId === "string") {
      const id = meta.agentId.toLowerCase().trim();
      if (id === "qoder") return true;
    }
    if (typeof meta.userAgent === "string") {
      const ua = meta.userAgent.toLowerCase();
      if (ua.includes("qoder")) return true;
    }
    return false;
  }

  function isCodexRequest(meta = {}) {
    if (typeof meta.agentId === "string") {
      const id = meta.agentId.toLowerCase().trim();
      if (id === "codex") return true;
    }
    if (typeof meta.userAgent === "string") {
      const ua = meta.userAgent.toLowerCase();
      if (ua.includes("codex_cli_rs") || ua.includes("codex-tui")) return true;
    }
    return false;
  }

  function isKimiRequest(meta = {}) {
    if (typeof meta.agentId === "string") {
      const id = meta.agentId.toLowerCase().trim();
      if (id === "kimi" || id === "kimi-code") return true;
    }
    if (typeof meta.userAgent === "string") {
      const ua = meta.userAgent.toLowerCase();
      if (ua.includes("kimi-code") || ua.includes("kimi/")) return true;
    }
    return false;
  }

  function isOpencodeRequest(meta = {}) {
    if (typeof meta.agentId === "string") {
      const id = meta.agentId.toLowerCase().trim();
      if (id === "opencode") return true;
    }
    if (typeof meta.userAgent === "string") {
      const ua = meta.userAgent.toLowerCase();
      if (ua.includes("opencode")) return true;
    }
    return false;
  }

  // Grok Build tags agentId "grok" through the launchers; its own HTTP layer
  // sends User-Agent "grok-cli/<version>" (grok docs: user-guide
  // 05-configuration / 07-mcp-servers), so both channels are recognized.
  function isGrokRequest(meta = {}) {
    if (typeof meta.agentId === "string") {
      const id = meta.agentId.toLowerCase().trim();
      if (id === "grok") return true;
    }
    if (typeof meta.userAgent === "string") {
      const ua = meta.userAgent.toLowerCase();
      if (ua.includes("grok-cli/")) return true;
    }
    return false;
  }

  // ZCode aggregate bucket. agentId-only: real ZCode traffic arrives with the
  // x-agent-id header its merge config injects; there is deliberately no UA
  // branch — an unrecognized UA must become unattributed (null upstream), never
  // be guessed into a real endpoint's bucket. The old default-to-zcode bucket
  // is gone; this bucket only keeps positively-identified ZCode traffic.
  function isZcodeRequest(meta = {}) {
    return typeof meta.agentId === "string" && meta.agentId.toLowerCase().trim() === "zcode";
  }

  // Claude aggregate bucket. agentId-only on purpose: the resident relay's
  // /v1/messages path already maps the Anthropic client UA to agentId
  // "claude" upstream, while the chat/completions path reports null for
  // unknown clients — a UA sniff here would wrongly override that tag.
  // Claude's per-session panel card is a separate reporter path; this bucket
  // only keeps positively-identified relay traffic.
  function isClaudeRequest(meta = {}) {
    return typeof meta.agentId === "string" && meta.agentId.toLowerCase().trim() === "claude";
  }

  // Track an in-flight request.
  //
  // 归属解析：agentId（白名单值）或 UA 特征命中即落对应端点桶；两者都落空
  // 时 bucketAgentId 为 null，请求落进 unattributedState——不计入任何端点
  // 卡、不出实例行、不进快照，只在 journal 留一行 agentId: null 的审计账
  // （「未知来源不显示」）。历史默认桶是 zcode（一个真实端点），任何认不出
  // 来源的流量都会污染 ZCode 的看板与统计，已于 09-19 废弃。
  function startRequest(meta = {}) {
    let targetState = unattributedState;
    let bucketAgentId = null;
    if (isZcodeRequest(meta)) {
      targetState = zcodeState;
      bucketAgentId = "zcode";
    } else if (isDshRequest(meta)) {
      targetState = dshState;
      bucketAgentId = "dsh";
    } else if (isPiRequest(meta)) {
      targetState = piState;
      bucketAgentId = "pi";
    } else if (isKimiRequest(meta)) {
      targetState = kimiState;
      bucketAgentId = "kimi";
    } else if (isQoderRequest(meta)) {
      targetState = qoderState;
      bucketAgentId = "qoder";
    } else if (isCodexRequest(meta)) {
      targetState = codexState;
      bucketAgentId = "codex";
    } else if (isOpencodeRequest(meta)) {
      targetState = opencodeState;
      bucketAgentId = "opencode";
    } else if (isGrokRequest(meta)) {
      targetState = grokState;
      bucketAgentId = "grok";
    } else if (isClaudeRequest(meta)) {
      targetState = claudeState;
      bucketAgentId = "claude";
    }
    // Instance-id normalization against the process-scan cache (a SYNC read
    // of the 2500ms cache — never a fresh spawn on the request path; the
    // panel's status polling keeps the cache warm in practice). Both
    // injection channels land here: the x-agent-instance header (openai/
    // anthropic paths). A launcher-injected
    // "<cwd基名>-<launcher pid>" folds into the canonical
    // "<agentId>-<client pid>" so PID reconciliation governs it; the socket
    // fallback already synthesizes the canonical form and passes through
    // unchanged, as do unresolvable custom ids. The normalized id also
    // reaches the usage journal (effMeta), keeping journal and bucket
    // attribution consistent.
    // Trade-off (cold-cache window): when the relay has just started
    // and cachedProcessCounts is still the empty scan, a launcher-injected
    // "<cwd基名>-<launcher pid>" id cannot resolve and is tracked under the
    // RAW id as a custom (idle-TTL) row. Once the cache warms, later requests
    // fold into the canonical "<agentId>-<client pid>" row, so the panel can
    // briefly show two rows for one logical instance and the counts split
    // across both buckets. The raw row self-heals: it is a custom id on the
    // 10-minute idle TTL (INSTANCE_IDLE_TTL_MS) and expires on its own.
    // 后台请求（codex 引擎/GUI 自发流量：记忆整理、guardian、预热、线程
    // 标题/摘要生成等）永远不出实例行：openai-server 侧已把实例 id 置空，
    // 这里再压一道——即便调用方误传 instanceId 也不归一、不建桶，迟挂
    // attachInstance 对它是 no-op。
    const background = meta.background === true;
    const rawInstanceId = background ? null : sanitizeInstanceId(meta.instanceId);
    const instMap = instanceBuckets[bucketAgentId];
    const normalized = rawInstanceId !== null && instMap !== undefined
      ? normalizeInstanceId(bucketAgentId, rawInstanceId, cachedProcessCounts)
      : null;
    const effMeta = normalized !== null && normalized.id !== rawInstanceId
      ? { ...meta, instanceId: normalized.id }
      : meta;
    const primary = trackAggregateRequest(targetState, effMeta, nowFn, recentSampleWindow, stability, journal, bucketAgentId);
    // A request start already moved totalRequests/activeRequests: mark the
    // snapshot dirty so a restart mid-turn still carries the start forward.
    markMetricsDirty();

    // Per-instance mirror (multi-instance endpoints only): a tagged request
    // is tracked twice — once in the endpoint aggregate above, once in its
    // instance bucket. Untagged requests and aggregate-only endpoints return
    // the plain aggregate tracker, behavior unchanged.
    //
    // Late attach: socket-fallback miss at startRequest leaves the request on
    // the aggregate only. When netstat lands (or a caller learns the id) the
    // same in-flight handle can attachInstance once — the mirror starts from
    // this moment (in-flight +1) without bumping the aggregate again. Ended
    // requests refuse attach so a late snapshot cannot revive a settled row.
    let composed = primary;
    let instanceAttached = false;

    function bindInstance(norm) {
      if (instanceAttached || instMap === undefined || !norm) return composed;
      const instanceId = norm.id;
      let entry = instMap.get(instanceId);
      if (!entry) {
        entry = { state: createAggregateState(), firstSeen: nowFn(), label: null };
        instMap.set(instanceId, entry);
        markMetricsDirty();
      }
      if (norm.label !== null) entry.label = norm.label;
      const mirror = trackAggregateRequest(entry.state, { ...effMeta, instanceId }, nowFn, recentSampleWindow, null, null, bucketAgentId);
      instanceAttached = true;
      composed = composeInstanceTracker(primary, mirror);
      // 迟到挂载补标：链归属（resolver + 当前成员）只在请求开头的成员循环里
      // 宣布一次，netstat 快照补挂的镜像从创建起就错过了那次宣布，会把链服务
      // 请求整段错记为直连（实例镜像的链归因 autoCount 恒空）。挂载
      // 瞬间把主 tracker 已宣布的归属重放给镜像；尚未宣布（memberId null）
      // 时只预置 resolver，随后的 setCurrentMember 会经 composed 扇出到镜像。
      const attribution = primary.getAttribution?.();
      if (attribution?.resolver) mirror.setAttributeResolver?.(attribution.resolver);
      if (attribution?.memberId) mirror.setCurrentMember?.(attribution.memberId);
      return composed;
    }

    function attachInstance(rawId) {
      if (background) return;
      if (bucketAgentId === null) return; // 无归属请求永远没有实例行
      const raw = sanitizeInstanceId(rawId);
      if (raw === null) return;
      bindInstance(normalizeInstanceId(bucketAgentId, raw, cachedProcessCounts));
    }

    if (normalized !== null) {
      bindInstance(normalized);
      return {
        recordFirstChunk: (arg) => { markMetricsDirty(); return composed.recordFirstChunk?.(arg); },
        setCurrentMember: (arg) => composed.setCurrentMember?.(arg),
        setAttributeResolver: (arg) => composed.setAttributeResolver?.(arg),
        recordRetry: (arg) => composed.recordRetry?.(arg),
        noteKeepAliveRecovery: (arg) => composed.noteKeepAliveRecovery?.(arg),
        noteKeepAliveExhausted: (arg) => composed.noteKeepAliveExhausted?.(arg),
        recordEnd: (arg) => { markMetricsDirty(); return composed.recordEnd?.(arg); },
        attachInstance,
      };
    }

    let ended = false;
    const endOnce = (arg) => {
      ended = true;
      markMetricsDirty();
      return composed.recordEnd?.(arg);
    };
    return {
      recordFirstChunk: (arg) => { markMetricsDirty(); return composed.recordFirstChunk?.(arg); },
      setCurrentMember: (arg) => composed.setCurrentMember?.(arg),
      setAttributeResolver: (arg) => composed.setAttributeResolver?.(arg),
      recordRetry: (arg) => composed.recordRetry?.(arg),
      noteKeepAliveRecovery: (arg) => composed.noteKeepAliveRecovery?.(arg),
      noteKeepAliveExhausted: (arg) => composed.noteKeepAliveExhausted?.(arg),
      recordEnd: endOnce,
      attachInstance: (rawId) => {
        if (ended) return;
        attachInstance(rawId);
      },
    };
  }

  // Claude per-session reports. Keyed by PID (the claude.exe process id,
  // which uniquely identifies a per-launch session). The relay token is kept
  // as a secondary guard against PID reuse by the OS. Only claude reports
  // belong here: a non-claude agentId (e.g. the kimi launcher riding the same
  // reporter) is journaled by the panel under its own bucket, and its pid is
  // a cmd wrapper's — writing it here would only produce a garbage row that
  // latches ended on the next read (or worse, gets revived if the OS recycles
  // the pid for a real claude.exe).
  const claudeSessions = new Map();
  // Per-session dedup cursors for the stability batch, and the latest
  // per-launch route-chain runtime dump — both ride session-report POSTs
  // because a per-launch relay has neither a stability tracker nor a
  // panel-reachable chain state of its own.
  const sessionStabilitySeq = new Map();
  const reportedChainStates = new Map();

  function reportSession(token, report) {
    if (!token || typeof report !== "object") return;
    // agentId verdict aligned with the panel's journal side
    // (panel.mjs journalSessionEnd): a non-string or whitespace-only agentId
    // is treated as missing → claude; a string is trimmed before the compare.
    // Both sides must file the same report under the same bucket.
    const reportAgentId = typeof report.agentId === "string" && report.agentId.trim()
      ? report.agentId.trim()
      : "claude";
    if (reportAgentId !== "claude") return;
    const pid = Number(report.pid);
    if (!Number.isFinite(pid) || pid <= 0) return; // PID is required

    const now = nowFn();
    const key = pid;
    const existing = claudeSessions.get(key);
    // PID reuse guard: same PID but a different token means a new process
    // recycled the PID — treat the old session as ended, start fresh.
    // Placeholder replacement: if process scanning created a placeholder session
    // (token === null) before the real session report arrived, drop it silently
    // so the panel never briefly shows two sessions for the same PID. A real
    // prior session (token !== null) with a different token is PID reuse —
    // mark it ended for its display window instead.
    if (existing && existing.token !== token) {
      if (existing.token !== null) {
        existing.ended = true;
        existing.lastSeen = now;
      }
      claudeSessions.delete(key);
      // A recycled PID is a new reporter process: its batch seqs restart at
      // 1, so the dedup cursor and the chain runtime dump must restart too —
      // keeping the old cursor would silently drop every record of the new
      // session.
      sessionStabilitySeq.delete(key);
      reportedChainStates.delete(key);
    }

    const session = claudeSessions.get(key) || {
      id: report.sessionId || `pid-${pid}`,
      pid,
      token,
      startedAt: now,
      requests: 0,
      activeRequests: 0,
      activeDurationMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      lastTtftMs: null,
      lastError: null,
      errorActive: false,
      sparkHistory: null,
      samples: null,
      lastSeen: now,
      ended: false,
    };

    session.lastSeen = now;
    session.token = token;
    if (typeof report.requests === "number") session.requests = report.requests;
    if (typeof report.activeRequests === "number") session.activeRequests = report.activeRequests;
    if (typeof report.activeDurationMs === "number") session.activeDurationMs = report.activeDurationMs;
    if (typeof report.promptTokens === "number") session.promptTokens = report.promptTokens;
    if (typeof report.completionTokens === "number") session.completionTokens = report.completionTokens;
    if (typeof report.cachedTokens === "number") session.cachedTokens = report.cachedTokens;
    if (typeof report.lastTtftMs === "number") session.lastTtftMs = report.lastTtftMs;
    // Reports are cumulative snapshots — the reporter's error state is the
    // truth, so overwrite unconditionally (not merge).
    if ("lastError" in report) session.lastError = report.lastError ?? null;
    if (typeof report.errorActive === "boolean") session.errorActive = report.errorActive;
    // Authoritative sparkline history from the reporter's per-request ring
    // (same shape as the aggregate metrics.sparkHistory). Overwrite on every
    // report: the ring is the truth, and snapshots are idempotent replays of
    // it (heartbeat re-posts included).
    if (report.sparkHistory && typeof report.sparkHistory === "object" && Array.isArray(report.sparkHistory.tps)) {
      session.sparkHistory = report.sparkHistory;
    }
    // Raw recent samples (current launchers only): the panel derives this
    // session's speed and cache rate from them with the very same window rule
    // the endpoint cards use. Same overwrite semantics as the ring above; a
    // launcher that predates the field simply leaves it null and the reader
    // falls back to the ring's per-request mean.
    if (Array.isArray(report.samples)) {
      session.samples = report.samples;
    }
    // Model identity for the panel's per-session model badge. Same overwrite
    // semantics as lastError: the reporter's latest snapshot wins. A snapshot
    // with no model means "in flight, serving node not decided yet" (auto
    // routing) or "no request at all" — the CURRENT identity is cleared, while
    // the sticky last* fields keep the previous real 渠道/模型 so the card's
    // grey 最近 capsule survives a request that never got attributed.
    if ("providerId" in report) session.providerId = report.providerId ?? null;
    if ("viaAuto" in report) session.viaAuto = report.viaAuto === true;
    if ("model" in report) {
      session.model = report.model ?? null;
      if (session.model) {
        session.lastModel = session.model;
        session.lastProvider = session.providerId;
        session.lastViaAuto = session.viaAuto === true;
      }
    }
    if (report.ended === true) session.ended = true;

    // Stability batch: the per-launch relay's request outcomes, recorded into
    // THIS process's tracker on the reporter's behalf (a per-launch relay has
    // no tracker of its own; the 状态检测 card and the store availability
    // lamps both read only the resident side). Dedup by the reporter's
    // monotonic seq — a failed POST is re-carried by the next snapshot.
    if (Array.isArray(report.stabilityBatch)) {
      const lastSeq = sessionStabilitySeq.get(key) ?? 0;
      let maxSeq = lastSeq;
      for (const rec of report.stabilityBatch) {
        const seq = Number(rec?.seq) || 0;
        if (seq === 0 || seq <= lastSeq) continue;
        if (seq > maxSeq) maxSeq = seq;
        stability.record({
          providerId: typeof rec.providerId === "string" ? rec.providerId : "",
          model: typeof rec.model === "string" ? rec.model : null,
          ok: rec.ok === true,
          latencyMs: Number(rec.latencyMs) || 0,
          prompt: Number(rec.prompt) || 0,
          cached: Number(rec.cached) || 0,
          ttftMs: typeof rec.ttftMs === "number" ? rec.ttftMs : null,
          at: typeof rec.at === "number" ? rec.at : now,
        });
      }
      if (maxSeq > lastSeq) sessionStabilitySeq.set(key, maxSeq);
    }

    // Per-launch route-chain runtime (positions + per-startup node outcomes).
    // Overwrite per session: the reporter's dump is the whole truth of its
    // process, not a delta. /api/internal/route-chain-runtime merges these.
    if (report.chainRuntime && typeof report.chainRuntime === "object") {
      reportedChainStates.set(key, {
        positions: Array.isArray(report.chainRuntime.positions) ? report.chainRuntime.positions : [],
        nodes: Array.isArray(report.chainRuntime.nodes) ? report.chainRuntime.nodes : [],
      });
    }

    claudeSessions.set(key, session);
  }

  // Liveness is decided by the process list, not by a TTL. A session is alive
  // if its claude.exe PID is still running. Sessions whose PID has vanished
  // are marked ended; ended sessions linger for ENDED_DISPLAY_MS then purge.
  async function getActiveClaudeSessions() {
    const procCounts = await scanProcesses();
    const livePids = procCounts.claudePids;
    const now = nowFn();
    const active = [];

    // Ensure all currently running claude.exe PIDs have a session tracked immediately
    for (const pid of livePids) {
      if (!claudeSessions.has(pid)) {
        claudeSessions.set(pid, {
          id: `pid-${pid}`,
          pid,
          token: null,
          startedAt: now,
          requests: 0,
          activeRequests: 0,
          activeDurationMs: 0,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          lastTtftMs: null,
          lastError: null,
          errorActive: false,
          sparkHistory: null,
          samples: null,
          lastSeen: now,
          ended: false,
        });
      }
    }

    for (const [key, s] of claudeSessions.entries()) {
      if (s.ended) {
        if (livePids.has(s.pid)) {
          // The PID is alive again: either a stale scan-cache read latched
          // this session ended while its process was still starting, or the
          // OS recycled the PID for a new claude.exe. Revive the row — a live
          // process must not stay hidden behind an ended latch (the latch
          // also blocked placeholder recreation above, which pinned the panel
          // at fewer session rows than running claude processes).
          s.ended = false;
          s.lastSeen = now;
        } else {
          if (now - s.lastSeen > ENDED_DISPLAY_MS) {
            claudeSessions.delete(key);
            sessionStabilitySeq.delete(key);
            reportedChainStates.delete(key);
          }
          continue;
        }
      }
      if (!livePids.has(s.pid)) {
        // Process is gone — mark ended (covers both normal exit and forced kill)
        s.ended = true;
        continue;
      }
      if (s.activeRequests > 0 && now - s.lastSeen > SESSION_SILENT_ACTIVE_REQUEST_TTL_MS) {
        // The reporter went silent mid-generation: its zeroing snapshot was
        // lost and no further event will arrive. Settle the counters on read
        // so the badge stops showing 生成中 forever. lastError history is
        // kept — only the active latch is ended, mirroring
        // settleAbandonedAggregateState. A genuinely generating session
        // heartbeats every ~10s, so its lastSeen never reaches this age.
        s.activeRequests = 0;
        s.errorActive = false;
      }
      active.push(s);
    }
    return active;
  }

  async function getAgentsStatus() {
    try {
      const loaded = typeof loadSparkSettings === "function" ? loadSparkSettings() : loadSettings();
      if (loaded && loaded.sparkWindowPoints !== sparkWindowPoints) {
        applySparkWindow(loaded.sparkWindowPoints);
      }
    } catch {
      /* keep in-memory window */
    }
    const procCounts = await scanProcesses();
    const now = nowFn();

    // Expire abandoned-model faults (idle > faultIdleTtlMs) before building
    // status so the panel banner reflects only still-live faults.
    for (const state of [zcodeState, dshState, piState, kimiState, qoderState, opencodeState, claudeState, codexState, grokState]) {
      pruneStaleAggregateFaults(state, nowFn, faultIdleTtlMs);
    }

    // If an aggregate agent's process has vanished, any still-counted active
    // requests are orphans: the client that owned them is gone, so the transport
    // layer will never finish them. Settle their wall-clock interval and reset
    // the counters so the panel doesn't keep showing "generating" forever.
    // The same applies to latched faults: the endpoint's lifecycle ended, so
    // its banner must fold now instead of lingering until the idle fault TTL.
    // lastError history is kept — only the active latch is ended.
    function settleAbandonedAggregateState(state, processCount) {
      if (processCount > 0) return;
      const idleSince = state.activeWallStart ?? state.lastRequestAt ?? now;
      if (now - idleSince <= PROCESS_GONE_ACTIVE_REQUEST_TTL_MS) return;
      if (state.activeRequests > 0) {
        if (state.activeWallStart !== null) {
          state.activeWallClockMs += Math.max(1, now - state.activeWallStart);
          state.activeWallStart = null;
        }
        state.activeRequests = 0;
        state.currentModel = null;
        state.currentProvider = null;
        state.activeModels.clear();
      }
      if (state.activeFaults.size > 0 || state.keylessFaultAt !== null) {
        state.activeFaults.clear();
        state.keylessFaultAt = null;
        state.errorActive = false;
      }
    }

    settleAbandonedAggregateState(zcodeState, procCounts.zcode || 0);
    settleAbandonedAggregateState(dshState, procCounts.dsh || 0);
    settleAbandonedAggregateState(piState, procCounts.pi || 0);
    settleAbandonedAggregateState(kimiState, procCounts.kimi || 0);
    settleAbandonedAggregateState(qoderState, procCounts.qoder || 0);
    settleAbandonedAggregateState(codexState, procCounts.codex || 0);
    settleAbandonedAggregateState(opencodeState, procCounts.opencode || 0);
    settleAbandonedAggregateState(grokState, procCounts.grok || 0);
    settleAbandonedAggregateState(claudeState, procCounts.claude || 0);

    // Instance housekeeping mirrors the endpoint-level one: settle orphans,
    // expire stale fault latches, drop stale entries. Read-driven, no timers.
    // Liveness splits by id shape. An id of the strict "<agentId>-<pid>"
    // form (socket-fallback synthesized, or launcher-injected and folded by
    // normalizeInstanceId at ingest) declares its owning PID, so the process
    // scan is authoritative: a live PID keeps the row listed regardless of
    // idle time, a dead PID evicts it now — the idle TTL would otherwise
    // leave a dead instance showing 待命 until lastSeen+10min. The codex
    // bucket extends the same verdict to custom ids with a numeric tail
    // (launcher-injected "<cwd>-<launcher pid>" rows that never folded): the
    // tail pid is no client of the endpoint, so it reconciles against every
    // process the scan saw, and a dead pid drops the leftover row now.
    // codex session rows ("codex-sess-<session id>") declare no PID at all:
    // they clear the moment the whole codex process family exits, or after
    // CODEX_SESSION_IDLE_TTL_MS without traffic — whichever comes first.
    // Remaining custom ids (no numeric tail — normalizeInstanceId already
    // had its say at ingest) keep the idle TTL; an instance with in-flight
    // requests never expires on that path.
    const bucketAggregateState = { dsh: dshState, kimi: kimiState, opencode: opencodeState, pi: piState, codex: codexState, grok: grokState };
    for (const [bucket, instMap] of Object.entries(instanceBuckets)) {
      const count = procCounts[bucket] || 0;
      // Endpoints with an ENGINE subset reconcile their canonical rows against
      // it: codex's full pid set also holds the desktop GUI shell (ChatGPT.exe)
      // and short-lived helpers, and dsh's holds the two TUI launcher shells,
      // none of which own a session. Card status/process count keeps the
      // bucket's own scope (codex = whole family, dsh = engines only); only
      // instance liveness narrows to the set that can hold traffic.
      const livePids = procCounts[`${bucket}EnginePids`] ?? procCounts[`${bucket}Pids`] ?? new Set();
      const pidIdRe = new RegExp(`^${bucket}-(\\d+)$`);
      for (const [instId, entry] of instMap) {
        const pidMatch = instId.match(pidIdRe);
        const isCodexSessionRow = bucket === "codex" && instId.startsWith(CODEX_SESSION_ID_PREFIX);
        // 冷缓存收敛：启动器注入的 "<cwd>-<launcher pid>" 在扫描缓存没赶上
        // 会话启动（或看板关闭期间缓存不刷新——请求路径只同步读缓存、从
        // 不触发扫描）时折不进规范形，落成自定义 id 行；缓存跟上后后续请
        // 求折回 "<agentId>-<pid>"，两行并排——单会话看板显示两个实例，
        // 临时行要等 10 分钟空闲 TTL 才消失（pi 现场 2026-09-14）。这里
        // 拿本读的新快照重试折叠：目标行不存在就把整行改名归位（在途镜
        // 像写的是同一 state 对象，随之归位，不受改名影响）；目标行已存
        // 在且本行无在途请求就清行（这些计数随空闲 TTL 本来也要丢，
        // journal 已逐请求落账不受影响）；有在途请求留到其收尾后的下一
        // 轮读再收敛。
        if (pidMatch === null && !isCodexSessionRow) {
          const refold = normalizeInstanceId(bucket, instId, procCounts);
          if (refold !== null && refold.id !== instId) {
            const target = instMap.get(refold.id);
            if (target === undefined) {
              instMap.delete(instId);
              if (refold.label !== null) entry.label = refold.label;
              instMap.set(refold.id, entry);
              continue;
            }
            if (target.label === null && refold.label !== null) target.label = refold.label;
            if (entry.state.activeRequests === 0) {
              instMap.delete(instId);
              continue;
            }
          }
        }
        let evict = false;
        if (pidMatch !== null) {
          evict = !livePids.has(Number(pidMatch[1]));
        } else if (isCodexSessionRow) {
          evict = count === 0;
        } else if (bucket === "codex") {
          const tail = instId.match(/-(\d+)$/);
          evict = tail !== null && scanPidLiveness(Number(tail[1]), procCounts) === false;
        }
        if (evict) {
          // The owning process is gone — evict now. Its in-flight requests
          // are orphans the transport layer will never finish (same
          // situation as settleAbandonedAggregateState), and they were ALSO
          // counted in the endpoint aggregate, so settle that share there;
          // the instance's own counters vanish with the entry.
          const leaked = entry.state.activeRequests;
          if (leaked > 0) {
            const agg = bucketAggregateState[bucket];
            agg.activeRequests = Math.max(0, agg.activeRequests - leaked);
            if (agg.activeRequests === 0 && agg.activeWallStart !== null) {
              agg.activeWallClockMs += Math.max(1, now - agg.activeWallStart);
              agg.activeWallStart = null;
              agg.currentModel = null;
              agg.currentProvider = null;
              agg.activeModels.clear();
            }
          }
          instMap.delete(instId);
          continue;
        }
        settleAbandonedAggregateState(entry.state, count);
        pruneStaleAggregateFaults(entry.state, nowFn, faultIdleTtlMs);
        if (pidMatch === null) {
          const lastSeen = entry.state.lastRequestAt ?? entry.firstSeen;
          const idleTtlMs = isCodexSessionRow ? CODEX_SESSION_IDLE_TTL_MS : INSTANCE_IDLE_TTL_MS;
          if (entry.state.activeRequests === 0 && now - lastSeen > idleTtlMs) {
            instMap.delete(instId);
          }
        }
      }
      // Process-start placeholders: a scanned live PID with no bucket yet
      // gets a zero-count row immediately (process start → panel) instead of
      // the row appearing only when its first tagged request arrives.
      // Mirrors the claude placeholder sessions in getActiveClaudeSessions:
      // a real request with the same "<agentId>-<pid>" id takes the entry
      // over in startRequest, and once the process dies the reconciliation
      // above evicts it on the next read. codex is the exception: its rows
      // are session-scoped (traffic-born), so its processes — the shared GUI
      // engine included — never spawn placeholder rows.
      if (bucket !== "codex") {
        for (const pid of livePids) {
          const placeholderId = `${bucket}-${pid}`;
          if (!instMap.has(placeholderId)) {
            instMap.set(placeholderId, { state: createAggregateState(), firstSeen: now, label: null });
          }
        }
      }
    }

    // codex session rows get user-readable titles from the on-disk session
    // scan (session-scan's codex adapter over ~/.codex/sessions/**.jsonl).
    // Worth the walk only when a session row is actually listed.
    let codexSessionById = null;
    for (const instId of instanceBuckets.codex.keys()) {
      if (instId.startsWith(CODEX_SESSION_ID_PREFIX)) {
        codexSessionById = await loadCodexSessionInfo();
        break;
      }
    }

    // DSH row badge: which surface (profile) the process behind this row is.
    // The row carries no client-side identity (see the instanceBuckets note),
    // so the profile comes from the same process-scan map that feeds the card
    // subline. An unreadable profile yields no badge instead of a guess.
    const dshInstanceSurface = (instId) => {
      const pidMatch = instId.match(/^dsh-(\d+)$/);
      if (pidMatch === null) return null;
      const profile = procCounts.dshProfileByPid?.get(Number(pidMatch[1])) ?? null;
      return profile === null ? null : dshSurfaceLabel(profile);
    };

    // Kimi row badge: the same rule on a different source — the face comes from
    // the process scan (image name, plus the server registration that promotes
    // a terminal row to web), never from the request plane. A row whose process
    // the scan cannot resolve stays unbadged instead of guessing.
    const kimiInstanceSurface = (instId) => {
      const pidMatch = instId.match(/^kimi-(\d+)$/);
      if (pidMatch === null) return null;
      const surface = procCounts.kimiSurfaceByPid?.get(Number(pidMatch[1])) ?? null;
      return surface === null ? null : kimiSurfaceLabel(surface);
    };

    const instanceSurfaceFor = (bucket, instId) => {
      if (bucket === "dsh") return dshInstanceSurface(instId);
      if (bucket === "kimi") return kimiInstanceSurface(instId);
      return null;
    };

    // Per-instance snapshots for one endpoint. Reuses the aggregate card's
    // 全局汇总 session shape field-for-field; ordering is deterministic
    // (firstSeen, then id) so the panel API output is stable.
    function instanceSnapshots(bucket) {
      return [...instanceBuckets[bucket].entries()]
        .sort((a, b) => a[1].firstSeen - b[1].firstSeen || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([instId, entry]) => {
          const built = buildAggregateAgentStatus({
            id: `${bucket}-${instId}`,
            name: instId,
            state: entry.state,
            processCount: 0,
            tpsWindow: recentSampleWindow,
            nowFn,
          });
          const s = built.sessions[0];
          const rowSurface = instanceSurfaceFor(bucket, instId);
          return {
            ...s,
            // Authoritative spark history (same shape as the endpoint-level
            // metrics.sparkHistory) so per-instance sparklines survive page
            // reloads — the panel seeds its buffers from it, mirroring the
            // aggregate cards.
            sparkHistory: built.metrics.sparkHistory,
            id: instId,
            // The cwd basename a launcher-injected id folded in with (null
            // for socket-fallback/placeholder rows). The panel numbers its
            // rows 会话 #N and keeps `title` off screen except on the pseudo
            // 全局汇总 row; codex session rows never fold (no pid tail), so
            // they take the session scan's title (thread / first message /
            // cwd), falling back to "Codex 会话 <短id>" when nothing associates.
            title: entry.label
              ?? (bucket === "codex" && instId.startsWith(CODEX_SESSION_ID_PREFIX)
                ? codexSessionRowTitle(instId, codexSessionById)
                : instId),
            // DSH and Kimi rows carry the surface they belong to, which the row
            // number cannot express: a web server, a TUI terminal and the
            // desktop app are all one endpoint id. Other buckets never set it.
            ...(rowSurface !== null ? { surface: rowSurface } : {}),
            // An instance listed at all is alive (idle TTL for custom ids,
            // PID reconciliation for "<agentId>-<pid>" ids), so idle — never
            // "stopped" just because no OS process count fed its build.
            status: s.activeRequests > 0 ? "active" : "idle",
            firstSeen: entry.firstSeen,
            lastSeen: entry.state.lastRequestAt ?? entry.firstSeen,
          };
        });
    }

    // 1. ZCode Agent Status
    const zcodeAgent = buildAggregateAgentStatus({
      id: "zcode",
      name: "ZCode",
      state: zcodeState,
      processCount: procCounts.zcode || 0,
      tpsWindow: recentSampleWindow,
      nowFn,
    });

    // 2. Claude Code Agent Status
    const claudeRawSessions = await getActiveClaudeSessions();
    const claudeProcessCount = procCounts.claude || 0;
    const claudeIsRunning = claudeRawSessions.length > 0 || claudeProcessCount > 0;

    const claudeSessionsFormatted = claudeRawSessions.map((s, idx) => {
      // Speed and cache rate come from the reporter's per-request window — the
      // same statistic every other card publishes. The cumulative form this
      // replaced (total output tokens over total busy wall-clock) booked each
      // request's first-token wait as generation time, which on Claude Code
      // (6-7s TTFT against a ~2s generation) reported about a fifth of the real
      // speed, and drifted further the longer the session ran. A launcher that
      // predates the window field falls back to the reporter's recent
      // per-request mean, in the right order of magnitude either way.
      const tps = windowTps(s.samples) ?? meanRecentTps(s.sparkHistory?.tps);
      const cacheHitRate = windowCacheHitRate(s.samples) ?? (
        s.promptTokens > 0 ? Number(((s.cachedTokens / s.promptTokens) * 100).toFixed(1)) : null
      );
      return {
        id: s.id,
        title: `实例 #${idx + 1}`,
        status: s.activeRequests > 0 ? "active" : "idle",
        tps,
        cacheHitRate,
        lastTtftMs: s.lastTtftMs,
        ttftColor: getTtftColor(s.lastTtftMs),
        activeDurationMs: s.activeDurationMs,
        activeDurationFormatted: formatDuration(s.activeDurationMs),
        requests: s.requests,
        activeRequests: s.activeRequests,
        lastError: s.lastError ?? null,
        errorActive: !!s.errorActive,
        tokens: {
          prompt: s.promptTokens,
          completion: s.completionTokens,
          cached: s.cachedTokens,
        },
        lastSeen: s.lastSeen,
        // Authoritative sparkline history (from the reporter's per-request
        // ring, absent until its first report) — feeds the cc card's instance
        // sparkline reconnection after a page reload, same contract as the
        // per-instance sparkHistory on kimi/opencode/pi/codex/grok.
        sparkHistory: s.sparkHistory ?? null,
        // Model identity from the session reporter's snapshot (null until the
        // reporter starts sending it) — feeds the per-session model badge.
        model: s.model ?? null,
        providerId: s.providerId ?? null,
      };
    });

    // Card-level model derivation from the per-session snapshots: Claude Code
    // rides the per-launch relay, whose reporter only feeds each session's
    // model field — the resident relay's aggregate claude bucket never sees
    // that traffic. When the bucket is empty, derive the card fields here so
    // the badge row (renderModelBadges) has a data source.
    //
    // The derived shape is the SAME composite account the aggregate endpoints
    // publish (渠道×模型 + 服务归因), because that is what the endpoint capsule
    // reads: one entry per (渠道,模型) so a same-named model served by two
    // sessions does not collapse into one capsule. A session in flight whose
    // node is not decided yet carries no model — it contributes nothing here,
    // so the capsule falls back to 最近/待命 instead of printing the virtual
    // "auto" or a stale model.
    const claudeSessionsDerived = (() => {
      const active = [];
      const targets = new Map();
      let current = null;
      let currentProvider = null;
      let currentViaAuto = false;
      let last = null;
      let lastProvider = null;
      let lastViaAuto = false;
      for (const s of claudeRawSessions) {
        const model = typeof s.model === "string" && s.model ? s.model : null;
        if (!model) {
          // 无身份快照（自动路由节点待定 / 无流量）不抹掉「最近」：粘性字段由
          // reportSession 保留，渠道同理。
          if (typeof s.lastModel === "string" && s.lastModel) {
            last = s.lastModel;
            lastProvider = typeof s.lastProvider === "string" && s.lastProvider ? s.lastProvider : null;
            lastViaAuto = s.lastViaAuto === true;
          }
          continue;
        }
        const providerId = typeof s.providerId === "string" && s.providerId ? s.providerId : null;
        const viaAuto = s.viaAuto === true;
        last = model;
        lastProvider = providerId;
        lastViaAuto = viaAuto;
        if (s.activeRequests > 0) {
          active.push(model);
          current = model;
          currentProvider = providerId;
          currentViaAuto = viaAuto;
          const key = `${providerId ?? ""}\u0000${model}`;
          const entry = targets.get(key) ?? { providerId, model, count: 0, autoCount: 0 };
          entry.count += s.activeRequests;
          if (viaAuto) entry.autoCount += s.activeRequests;
          targets.set(key, entry);
        }
      }
      return {
        activeModels: active,
        currentModel: current,
        lastModel: last,
        currentProvider,
        lastProvider,
        currentViaAuto,
        lastViaAuto,
        activeTargets: Array.from(targets.values()),
      };
    })();

    const claudeAgent = {
      id: "claude",
      name: "Claude Code",
      status: claudeIsRunning ? "running" : "stopped",
      processCount: claudeProcessCount,
      sessionMode: "per_session",
      sessionsCount: claudeSessionsFormatted.length,
      sessions: claudeSessionsFormatted,
      // Model fields ride the aggregate claude tracker bucket (resident
      // /v1/messages traffic, UA-sniffed agentId "claude") so the panel's
      // auto-route chain indicator works on the claude card the same way it
      // does on the aggregate endpoint cards. That bucket only fills when a
      // client talks to the resident relay directly; per-launch session
      // traffic falls back to the derivation above.
      currentModel: claudeState.currentModel ?? claudeSessionsDerived.currentModel,
      lastModel: claudeState.lastModel ?? claudeSessionsDerived.lastModel,
      activeModels: claudeState.activeModels.size > 0
        ? Array.from(claudeState.activeModels.keys())
        : claudeSessionsDerived.activeModels,
      // 渠道 × 服务归因：与聚合端点同形的复合账本，端点卡胶囊的「渠道/模型」
      // 双段与 auto 角标都靠它。常驻桶只在客户端直连常驻 relay 时才填。
      currentProvider: claudeState.currentProvider ?? claudeSessionsDerived.currentProvider,
      lastProvider: claudeState.lastProvider ?? claudeSessionsDerived.lastProvider,
      currentViaAuto: claudeState.currentViaAuto || claudeSessionsDerived.currentViaAuto,
      lastViaAuto: claudeState.lastViaAuto || claudeSessionsDerived.lastViaAuto,
      activeTargets: activeTargetList(claudeState).length > 0
        ? activeTargetList(claudeState)
        : claudeSessionsDerived.activeTargets,
    };

    // 3. DSH Agent Status（汇总卡 + 实例桶；一行 = 一个 DSH 进程，profile 决定
    // 它是 web 还是 TUI 还是用户自建的面。会话粒度不在这里——见 instanceBuckets
    // 上方注释，请求面拿不到 DSH 的会话 id）
    const dshAgent = {
      ...buildAggregateAgentStatus({
        id: "dsh",
        name: "DSH",
        state: dshState,
        processCount: procCounts.dsh || 0,
        tpsWindow: recentSampleWindow,
        nowFn,
        instances: instanceSnapshots("dsh"),
      }),
      // 卡内分面汇总（"Web ×1 · TUI ×2"）：只有进程扫描能在第一条请求之前
      // 分辨面，请求面上 web 与 TUI 同像（同一条 x-agent-id: dsh）。
      surfaces: summarizeDshSurfaces(procCounts),
    };

    // 4. Pi Agent Status
    const piAgent = buildAggregateAgentStatus({
      id: "pi",
      name: "Pi",
      state: piState,
      processCount: procCounts.pi || 0,
      tpsWindow: recentSampleWindow,
      nowFn,
      instances: instanceSnapshots("pi"),
    });

    // 5. Kimi Code Agent Status
    // 卡内分面汇总（"Desktop ×1 · TUI ×1"）：与 DSH 同一形状、不同来源——kimi 的
    // 面读自镜像名与它自己的 server 登记表（口径见 summarizeKimiSurfaces 上方），
    // 请求面上三个面共用同一条 kimi 归属、本期不承担分面（计划 §8）。
    const kimiAgent = {
      ...buildAggregateAgentStatus({
        id: "kimi",
        name: "Kimi Code",
        state: kimiState,
        processCount: procCounts.kimi || 0,
        tpsWindow: recentSampleWindow,
        nowFn,
        instances: instanceSnapshots("kimi"),
      }),
      surfaces: summarizeKimiSurfaces(procCounts),
    };

    const qoderAgent = buildAggregateAgentStatus({
      id: "qoder",
      name: "Qoder",
      state: qoderState,
      processCount: procCounts.qoder || 0,
      tpsWindow: recentSampleWindow,
      nowFn,
    });

    // Codex Agent Status（汇总卡 + 实例桶；实例按会话一行 codex-sess-<会话 id>，
    // GUI/CLI 同构，进程家族只决定卡片运行状态与会话行的生灭）
    const codexAgent = buildAggregateAgentStatus({
      id: "codex",
      name: "Codex",
      state: codexState,
      processCount: procCounts.codex || 0,
      tpsWindow: recentSampleWindow,
      nowFn,
      instances: instanceSnapshots("codex"),
    });

    // 6. OpenCode Agent Status（汇总卡 + 实例桶，经 openai relay 的 UA / x-agent-id 归类）
    const opencodeAgent = buildAggregateAgentStatus({
      id: "opencode",
      name: "OpenCode",
      state: opencodeState,
      processCount: procCounts.opencode || 0,
      tpsWindow: recentSampleWindow,
      nowFn,
      instances: instanceSnapshots("opencode"),
    });

    // Grok Build Agent Status（汇总卡 + 实例桶；grok.exe 每终端一进程，
    // kimi 同款多实例语义）
    const grokAgent = buildAggregateAgentStatus({
      id: "grok",
      name: "Grok Build",
      state: grokState,
      processCount: procCounts.grok || 0,
      tpsWindow: recentSampleWindow,
      nowFn,
      instances: instanceSnapshots("grok"),
    });

    return [zcodeAgent, claudeAgent, dshAgent, piAgent, kimiAgent, qoderAgent, codexAgent, opencodeAgent, grokAgent];
  }

  return {
    startRequest,
    reportSession,
    getAgentsStatus,
    getModelStability: () => stability.snapshot(nowFn()),
    // Latest route-chain runtime dump per live per-launch session, in the
    // same { positions, nodes } shape buildChainRuntime merges — lets the
    // resident relay's /api/internal/route-chain-runtime see chain positions
    // held inside ephemeral per-launch relay processes.
    getReportedChainRuntime: () => Array.from(reportedChainStates.values()),
    scanProcesses,
    // Final flush for process-exit paths (graceful shutdown and the crash
    // handler): the 30s debounce alone would drop the last segment of
    // accounting exactly when a restart is about to need it.
    persistMetricsSnapshot,
    setSparkWindowPoints: applySparkWindow,
    getSparkWindowPoints: () => sparkWindowPoints,
  };
}

// ---------------------------------------------------------------------------
// Session reporter — lives inside the launcher process (the per-launch relay).
// Accumulates per-session metrics as requests flow through, and POSTs
// cumulative snapshots to the panel's /panel/api/session/report endpoint.
// Liveness is NOT this reporter's job — the panel decides liveness by scanning
// for the child PID. This reporter only pushes numbers + an ended signal.
// agentId（默认 "claude"，kimi launcher 传 "kimi"）决定 usage journal 行与
// 上报快照的端点归属。
// ---------------------------------------------------------------------------

function extractCachedTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  return Number(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.prompt_cache_hit_tokens ??
      usage.cache_read_input_tokens ??
      usage.cached_tokens ??
      0,
  ) || 0;
}

export function createSessionReporter({ token = null, reportUrl, journal = null, nowFn = Date.now, fetchFn = fetch, agentId = "claude", heartbeatIntervalMs = SESSION_REPORTER_HEARTBEAT_MS }) {
  let sessionToken = token;
  let claudePid = null;
  const state = {
    requests: 0,
    activeRequests: 0,
    totalDurationMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    lastTtftMs: null,
    lastError: null, // { status, message, time } — kept after recovery for context
    errorActive: false, // true from the last failed request until first token / clean success
  };

  // Wall-clock union of busy intervals, mirroring the aggregate collector:
  // concurrent requests overlap in physical time and must count once.
  let activeWallStart = null;

  // Per-request contexts in start order. Claude Code fires concurrent
  // in-session requests (side queries, rapid re-send after Esc), so terminal
  // bookkeeping lives on the context — each recordEnd settles exactly its own
  // request and an interleaved end can never be swallowed.
  const openRequests = [];

  // Per-request sample ring for the panel's session sparklines, mirroring the
  // aggregate collector's recentSamples (last-N successful requests, never a
  // wall-clock TTL). The panel buffers sparklines in page memory only, so a
  // reload wipes them; this ring rides every snapshot so the cc card can
  // redraw the full curve from the first poll after a reload. Failures and
  // aborts are skipped — same rule as the aggregate samples.
  // Each entry keeps the raw measurement ({ completion, genDurationMs, prompt,
  // cached, ttftMs }), not a pre-computed speed, so the panel can apply the one
  // shared window rule to this session exactly as it does to an endpoint card.
  const sessionSamples = [];
  const SESSION_SAMPLE_WINDOW = 128;
  const pushSessionSample = (sample) => {
    sessionSamples.push(sample);
    while (sessionSamples.length > SESSION_SAMPLE_WINDOW) sessionSamples.shift();
  };

  // Pending model-stability records riding the snapshot POSTs. A per-launch
  // relay has no stability tracker of its own (ephemeral port — the panel
  // cannot reach it), so the resident relay records these into ITS tracker on
  // this session's behalf; the 状态检测 card and the store availability lamps
  // both read only the resident side. Each entry carries a monotonic seq: a
  // failed POST keeps the entries and the next snapshot re-carries them, and
  // the resident side dedups by seq. Bounded — if the resident relay stays
  // unreachable the oldest entries drop first.
  const stabilityPending = [];
  const STABILITY_PENDING_MAX = 500;
  let stabilitySeq = 0;
  const pushStability = (rec) => {
    if (!rec || typeof rec.model !== "string" || !rec.model) return;
    stabilityPending.push({ seq: ++stabilitySeq, ...rec });
    while (stabilityPending.length > STABILITY_PENDING_MAX) stabilityPending.shift();
  };

  // This process's route-chain state (positions + per-startup node outcomes),
  // wired by server.mjs via setChainState. Rides every snapshot so the
  // resident relay can merge it into the panel's Flow Rail — per-launch chain
  // state is otherwise as invisible as the stability rows were.
  let chainStateRef = null;

  // Heartbeat: events only fire on request start/end, so a single long
  // generation would otherwise leave the panel without a fresh snapshot for
  // minutes and its lastSeen-based settling would mistake a live session for
  // a dead one. While any request is in flight, re-post the snapshot every
  // heartbeatIntervalMs; idle sessions stay silent. The timer is unref'd so
  // it never holds the launcher process open.
  let heartbeatTimer = null;
  const ensureHeartbeat = () => {
    if (heartbeatTimer !== null || state.activeRequests <= 0) return;
    heartbeatTimer = setInterval(() => {
      // A tick already queued when the last recordEnd ran must not post a
      // stale "still generating" snapshot after the session went idle.
      if (state.activeRequests <= 0) return;
      sendSnapshot();
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  };
  const stopHeartbeat = () => {
    if (heartbeatTimer === null) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  // Journal + auto-route attribution for the per-launch claude relay. The
  // member wiring (resolver/member id) lives on the request context, exactly
  // like the resident relay's aggregate tracker: Claude Code fires concurrent
  // in-session requests (side queries, rapid re-send after Esc), and session
  // level wiring let one request's end erase the attribution of another. The
  // outer setters below stay as a legacy surface and target the newest open
  // request, so callers that never take the per-request handle keep working.
  const resolvedAttributeFor = (ctx, memberId) => {
    const source = memberId ?? ctx?.memberId ?? null;
    if (!ctx?.resolver || source === null) return null;
    const attr = ctx.resolver(source);
    return attr && typeof attr === "object" ? attr : null;
  };
  // 展示身份（模型 + 渠道 + 是否走链）：链成员已宣布 → 节点绑定的模型与渠道；
  // 否则用请求自带的 meta，但虚拟模型 AUTO_MODEL 不算身份——它是路由胶水，不是
  // 任何渠道上的真实模型，报上去只会被面板当成模型名显示出来。
  //
  // 节点未定时返回 null，且绝不回落到上一次的身份：那会把上一个模型说成正在服
  // 务的模型。此时胶囊按既有语义回落到「最近」（粘性最近身份）或「待命」。
  const identityOf = (ctx) => {
    if (!ctx) return null;
    const attr = resolvedAttributeFor(ctx, null);
    if (attr?.model) return { model: attr.model, providerId: attr.providerId ?? null, viaAuto: true };
    const model = ctx.meta?.model;
    if (typeof model !== "string" || !model || model === AUTO_MODEL) return null;
    return { model, providerId: ctx.meta?.providerId ?? null, viaAuto: false };
  };
  // 快照展示的是最新的在飞请求（Claude Code 会并发发侧查询）；没有在飞请求时
  // 沿用最近一次拿到过的身份，让「最近」胶囊与会话行都有真实渠道/模型。
  //
  // 在飞但拿不到身份（自动路由节点待定）时返回 null，绝不回落到上一次的身份：
  // 那会把上一个模型说成正在服务的模型。
  let lastIdentity = null;
  const displayIdentity = () => {
    for (let i = openRequests.length - 1; i >= 0; i -= 1) {
      const ident = identityOf(openRequests[i]);
      if (ident) {
        lastIdentity = ident;
        return ident;
      }
    }
    return openRequests.length > 0 ? null : lastIdentity;
  };
  // 已经推给面板的身份指纹：成员宣布时只在身份真的变了才重发，一次故障切换
  // 至多一次回环 POST（心跳与请求结束照常发）。
  let postedIdentity = "";
  const identityFingerprint = (ident) => (ident ? `${ident.providerId ?? ""}\u0000${ident.model}\u0000${ident.viaAuto}` : "");
  function sendSnapshot() {
    postedIdentity = identityFingerprint(displayIdentity());
    post(snapshot());
  }
  const sendSnapshotIfIdentityChanged = () => {
    if (identityFingerprint(displayIdentity()) !== postedIdentity) sendSnapshot();
  };
  // 链成员宣布（含故障切换时改投下一跳）：节点身份一定下来就上报，面板不必等
  // 10s 心跳才看到「渠道/模型」。
  const bindMember = (ctx, memberId) => {
    ctx.memberId = typeof memberId === "string" && memberId.length > 0 ? memberId : null;
    sendSnapshotIfIdentityChanged();
  };
  const normalizedUsage = (usage) => {
    if (!usage || typeof usage !== "object") return { prompt: 0, completion: 0, cached: 0 };
    return {
      prompt: Number(usage.prompt_tokens ?? usage.input_tokens) || 0,
      completion: Number(usage.completion_tokens ?? usage.output_tokens) || 0,
      cached: extractCachedTokens(usage),
    };
  };

  async function post(report) {
    // The batch this report carries is acknowledged (dropped) only after the
    // POST succeeds; a failed POST keeps the entries so the next snapshot
    // re-carries them. Overlapping posts can re-carry the same entries — the
    // resident side dedups by seq, so re-sends are safe.
    const batch = Array.isArray(report.stabilityBatch) && report.stabilityBatch.length > 0
      ? report.stabilityBatch
      : null;
    try {
      const headers = {
        "content-type": "application/json",
        "x-anyswitch-panel": "1",
        origin: "http://127.0.0.1:47821",
      };
      if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
      const res = await fetchFn(reportUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(report),
      });
      // A resolved non-error response acknowledges the batch. Test doubles
      // that resolve undefined count as success; only an explicit ok:false
      // keeps the entries (same "never break the relay" best-effort rule).
      if (batch && res?.ok !== false) {
        const ackedSeq = batch[batch.length - 1].seq;
        let drop = 0;
        while (drop < stabilityPending.length && stabilityPending[drop].seq <= ackedSeq) drop += 1;
        if (drop > 0) stabilityPending.splice(0, drop);
      }
    } catch {
      // Panel unreachable or relay down — metrics are best-effort, never
      // break the relay's primary function over a reporting failure.
    }
  }

  function snapshot() {
    // Reported duration = settled busy intervals + the still-running tail, so
    // snapshots are monotonic and reflect wall-clock active time even while a
    // request is in flight.
    let activeDurationMs = state.totalDurationMs;
    if (activeWallStart !== null) {
      activeDurationMs += Math.max(0, nowFn() - activeWallStart);
    }
    return {
      pid: claudePid,
      agentId,
      requests: state.requests,
      activeRequests: state.activeRequests,
      activeDurationMs,
      promptTokens: state.promptTokens,
      completionTokens: state.completionTokens,
      cachedTokens: state.cachedTokens,
      lastTtftMs: state.lastTtftMs,
      lastError: state.lastError,
      errorActive: state.errorActive,
      // Authoritative sparkline history (same shape as the aggregate
      // collector's metrics.sparkHistory): lets the cc card redraw the full
      // per-session curve from the first poll after a page reload.
      // ttft in seconds (endpoint-level rule); tps from successful samples;
      // cache as per-request hit-rate percentages.
      sparkHistory: {
        ttft: sessionSamples.map((s) => s.ttftMs).filter((v) => v !== null).map((ms) => Number((ms / 1000).toFixed(2))),
        // Per-request speed over the measured population only — the same
        // requests the card's number is built from (sampleTps), so curve and
        // number never disagree.
        tps: sessionSamples.map(sampleTps).filter((v) => v !== null),
        cache: sessionSamples.map((s) => (s.prompt > 0 ? Number(((s.cached / s.prompt) * 100).toFixed(1)) : 0)),
      },
      // Recent raw samples: the panel turns these into this session's speed and
      // cache rate with the shared window rule (windowTps / windowCacheHitRate),
      // so a Claude session card and an endpoint card are the same measurement.
      samples: sessionSamples.slice(-RECENT_SAMPLE_WINDOW).map((s) => ({
        completion: s.completion,
        genDurationMs: s.genDurationMs,
        prompt: s.prompt,
        cached: s.cached,
      })),
      // Pending stability records for the resident relay's tracker (the
      // per-launch blind-spot fix): terminal request outcomes plus
      // attempt-level retry failures, deduped resident-side by seq.
      stabilityBatch: stabilityPending.slice(),
      // Per-launch route-chain runtime for the panel's Flow Rail merge.
      // Absent until server.mjs wires this process's chainState.
      ...(chainStateRef
        ? { chainRuntime: { positions: chainStateRef.snapshot(), nodes: chainStateRef.nodeStats() } }
        : {}),
      // Model identity of the request currently in flight (chain attribution
      // wins, then the transport-supplied meta), so the panel can render a
      // per-session model badge.
      //
      // Two rules the panel's capsule depends on:
      //   - the virtual chain model "auto" is never published as a model name;
      //   - an in-flight request whose chain node is not announced yet publishes
      //     no identity at all (model null), so the capsule falls back to
      //     "最近" (sticky, panel-side) or "待命" instead of printing routing
      //     glue or a stale model.
      // The sticky "最近" fallback lives panel-side (reportSession.lastModel).
      ...(() => {
        const ident = displayIdentity();
        return {
          model: ident?.model ?? null,
          providerId: ident?.providerId ?? null,
          viaAuto: ident?.viaAuto === true,
        };
      })(),
    };
  }

  function recordFirstChunkCtx(ctx) {
    if (ctx.firstChunk !== null || ctx.ended) return;
    ctx.firstChunk = nowFn();
    state.lastTtftMs = Math.max(1, ctx.firstChunk - ctx.startTime);
    // First genuine token recovers the session fault. Retry begin must
    // not have cleared it, or a looping retry never surfaces on the panel.
    state.errorActive = false;
  }

  // Attempt-level failure recording, mirroring the aggregate collector's
  // recordRetry: a retried attempt failed before delivering content, and
  // counting it keeps silent recovery from painting a misleading 100%
  // success rate on the 状态检测 card. Attempts carry no TTFT (they never
  // produced a first token) and zero latency, exactly like the resident side.
  function recordRetryCtx(ctx, { usage, memberId } = {}) {
    const u = usage && typeof usage === "object" ? usage : {};
    const attr = resolvedAttributeFor(ctx, memberId ?? null);
    pushStability({
      providerId: attr?.providerId || ctx?.meta?.providerId || memberId || "",
      model: attr?.model || ctx?.meta?.model || null,
      ok: false,
      latencyMs: 0,
      prompt: Number(u.prompt_tokens ?? u.input_tokens) || 0,
      cached: extractCachedTokens(u),
      ttftMs: null,
      at: nowFn(),
    });
  }

  function recordEndCtx(ctx, { usage, error, status, aborted } = {}) {
    if (ctx.ended) return;
    ctx.ended = true;
    const idx = openRequests.indexOf(ctx);
    if (idx !== -1) openRequests.splice(idx, 1);
    state.activeRequests = Math.max(0, state.activeRequests - 1);
    const endTime = nowFn();
    if (state.activeRequests === 0 && activeWallStart !== null) {
      state.totalDurationMs += Math.max(1, endTime - activeWallStart);
      activeWallStart = null;
    }

    // Same fault lifecycle as the panel-side collector: error raises the
    // active fault, next clean success clears it, aborts change nothing.
    const hadError = Boolean(error) || (typeof status === "number" && status >= 400);
    if (hadError) {
      state.lastError = {
        status: Number(error?.status ?? status) || 500,
        message: error?.message || (typeof status === "number" ? `HTTP ${status}` : "Upstream Error"),
        time: endTime,
        // Same attribution as the journal row: the serving chain node's
        // bound model for auto requests, the transport-supplied model for
        // direct ones. The panel banner renders `HTTP <status> · <model>`
        // from this field.
        model: resolvedAttributeFor(ctx, null)?.model || ctx.meta?.model || null,
      };
      state.errorActive = true;
    } else if (!aborted) {
      state.errorActive = false;
    }
    // lastTtftMs is only ever set by recordFirstChunk: a failed request that
    // never produced a first token cannot fabricate a plausible TTFT.

    if (usage && typeof usage === "object") {
      // Anthropic-shaped usage (from openAIToAnthropic) uses input_tokens /
      // output_tokens; OpenAI-shaped usage uses prompt_tokens / completion_tokens.
      // Accept both so the reporter works regardless of which path fed it.
      state.promptTokens += Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
      state.completionTokens += Number(usage.completion_tokens ?? usage.output_tokens) || 0;
      state.cachedTokens += extractCachedTokens(usage);
    }

    // Sparkline sample: successful requests only, same eligibility as the
    // aggregate collector's recentSamples (failures/aborts/empty completions
    // produce no tps point). TPS mirrors its cap rule too (300 tok/s guard
    // against degenerate sub-100ms generations).
    const reqDuration = Math.max(1, endTime - ctx.startTime);
    const norm = normalizedUsage(usage);
    if (!hadError && !aborted) {
      if (norm.completion > 0) {
        pushSessionSample({
          completion: norm.completion,
          // null for a non-streaming reply: there is no window between first and
          // last token to measure, and the statistics page drops those rows too.
          genDurationMs: ctx.firstChunk !== null ? Math.max(1, endTime - ctx.firstChunk) : null,
          prompt: norm.prompt,
          cached: norm.cached,
          ttftMs: ctx.firstChunk !== null ? Math.max(1, ctx.firstChunk - ctx.startTime) : null,
        });
      }
    }

    // Usage journal: one request row per terminal recordEnd (the ctx.ended
    // guard makes this first-terminal-record-wins, mirroring the aggregate
    // collector). Per-launch relay traffic (claude / kimi) only ever flows
    // through these relays, so without this row the stats tab's endpoint
    // trends never saw the endpoint at all. agentId 归属由配置决定（默认
    // claude）。Aborts are skipped, same as the collector. Auto-route
    // requests attribute to the serving chain node + its bound model.
    if (journal && !aborted) {
      try {
        const attr = resolvedAttributeFor(ctx, null);
        const httpStatus = Number(error?.status ?? status) || null;
        journal.appendRequest({
          ts: endTime,
          agentId,
          providerId: attr?.providerId || ctx.meta?.providerId || "",
          model: attr?.model || ctx.meta?.model || null,
          prompt: norm.prompt,
          completion: norm.completion,
          cached: norm.cached,
          // Same TTFT rule as the aggregate collector: real first-chunk
          // latency for streams, full duration as the proxy for
          // non-streaming successes, none for failures.
          ttftMs: hadError ? null : (ctx.firstChunk !== null ? Math.max(1, ctx.firstChunk - ctx.startTime) : reqDuration),
          durationMs: reqDuration,
          ok: !hadError,
          status: httpStatus,
          errKind: hadError ? classifyErrKind({ status: httpStatus, message: error?.message }) : null,
          stream: ctx.meta?.stream === true,
          path: typeof ctx.meta?.path === "string" ? ctx.meta.path : "anthropic",
        });
      } catch (journalError) {
        console.warn(`[session-reporter] usage journal append failed: ${journalError.message}`);
      }
    }

    // Model-stability record for the resident relay's tracker — a per-launch
    // relay has none of its own (the blind spot this closes). Same rules as
    // the aggregate collector's terminal record: first terminal end wins
    // (ctx.ended guard above), aborts skipped, failures carry no TTFT (a
    // failed request has no first token; feeding its wait would paint a dead
    // node green), attribution mirrors the journal row exactly (serving chain
    // node wins, then the pool id / channel id from the transport meta).
    if (!aborted) {
      const attr = resolvedAttributeFor(ctx, null);
      pushStability({
        providerId: attr?.providerId || ctx.meta?.providerId || "",
        model: attr?.model || ctx.meta?.model || null,
        ok: !hadError,
        latencyMs: reqDuration,
        prompt: norm.prompt,
        cached: norm.cached,
        ttftMs: hadError ? null : (ctx.firstChunk !== null ? Math.max(1, ctx.firstChunk - ctx.startTime) : reqDuration),
        at: endTime,
      });
    }

    sendSnapshot();
    // Per-request wiring dies with the request: the ctx owns its member id and
    // resolver, so a concurrent request's end never touches another's attribution.
    if (openRequests.length === 0) stopHeartbeat();
  }

  return {
    setToken(t) {
      sessionToken = t;
    },

    setClaudePid(pid) {
      claudePid = Number(pid) || null;
      if (claudePid) {
        sendSnapshot();
      }
    },

    // Server wiring for auto-route attribution + usage journaling: the
    // transport layer (server.mjs) passes the request meta here and installs
    // the chain plan's memberId -> { providerId, model } resolver; the member
    // loop inside stream-pipe announces each attempted member. Both belong to
    // the request being served: the per-request handle from startRequest is the
    // precise surface, these legacy outer setters fall back to the newest open
    // request so callers that ignore the handle keep working.
    setCurrentMember(memberId) {
      const ctx = openRequests[openRequests.length - 1];
      if (ctx) bindMember(ctx, memberId);
    },
    setAttributeResolver(fn) {
      const ctx = openRequests[openRequests.length - 1];
      if (ctx) ctx.resolver = typeof fn === "function" ? fn : null;
    },

    startRequest(meta = {}) {
      const ctx = {
        startTime: nowFn(),
        firstChunk: null,
        ended: false,
        meta: meta && typeof meta === "object" ? meta : null,
        // Per-request auto-route wiring (mirrors the resident relay's aggregate
        // tracker): the member being attempted and the chain plan's resolver
        // belong to THIS request, so concurrent in-session requests never
        // overwrite each other's attribution.
        memberId: null,
        resolver: null,
      };
      if (state.activeRequests === 0) activeWallStart = ctx.startTime;
      state.requests += 1;
      state.activeRequests += 1;
      openRequests.push(ctx);
      ensureHeartbeat();

      sendSnapshot();

      return {
        recordFirstChunk: () => recordFirstChunkCtx(ctx),
        recordEnd: (info) => recordEndCtx(ctx, info),
        recordRetry: (info) => recordRetryCtx(ctx, info),
        setCurrentMember: (memberId) => bindMember(ctx, memberId),
        setAttributeResolver: (fn) => { ctx.resolver = typeof fn === "function" ? fn : null; },
      };
    },

    // Legacy outer API — operates on the most recently started in-flight
    // request. Sequential callers may ignore the handle; concurrent callers
    // MUST use the per-request handle returned by startRequest so an
    // interleaved end settles its own request (see server.mjs).
    recordFirstChunk() {
      const ctx = openRequests[openRequests.length - 1];
      if (ctx) recordFirstChunkCtx(ctx);
    },

    recordEnd(info = {}) {
      const ctx = openRequests[openRequests.length - 1];
      if (ctx) recordEndCtx(ctx, info);
    },

    // Legacy outer surface for stream-pipe's retry hook — same newest-open
    // fallback as recordEnd. Retried attempts count as failed stability
    // records so silent recovery never paints a fake 100% success rate.
    recordRetry(info = {}) {
      const ctx = openRequests[openRequests.length - 1];
      if (ctx) recordRetryCtx(ctx, info);
    },

    // server.mjs wires the handler's chainState here once, so heartbeat
    // snapshots carry this per-launch process's route-chain runtime
    // (positions + node outcomes) for the resident relay's Flow Rail merge.
    setChainState(cs) {
      chainStateRef = cs && typeof cs.snapshot === "function" && typeof cs.nodeStats === "function" ? cs : null;
    },

    reportEnd() {
      stopHeartbeat();
      post({ ...snapshot(), ended: true });
    },
  };
}
