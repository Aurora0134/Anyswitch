import { exec } from "node:child_process";
import { join } from "node:path";
import { DEFAULT_SPARK_WINDOW_POINTS, parseSparkWindowPoints, loadSettings } from "./relay-settings.mjs";
import { createModelStabilityTracker, STABILITY_FILENAME } from "./model-stability.mjs";
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

// Sliding window of recent successful requests. TPS and cache-hit rate are
// computed from this window, NOT from process-lifetime totals. A lifetime
// average is dominated by the first few requests: one early high-throughput
// or heavily-cached request permanently inflates the displayed number, and
// later requests only drag it down glacially as they dilute the accumulated
// denominator. The window is a last-N request count, never a wall-clock TTL.
const RECENT_SAMPLE_WINDOW = 18;

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
// snapshot-ish ({ [`${agentId}Pids`]: Set, ppidByPid: Map }, both optional).
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
  const clientPids = procSnapshot?.[`${agentId}Pids`];
  let clientPid = clientPids instanceof Set && clientPids.has(tailPid) ? tailPid : null;
  if (clientPid === null) {
    clientPid = findDescendantClientPid(tailPid, clientPids, procSnapshot?.ppidByPid);
  }
  if (clientPid === null) return { id, label: null };
  const prefix = id.slice(0, tail.index);
  return { id: `${agentId}-${clientPid}`, label: prefix.length > 0 && prefix !== agentId ? prefix : null };
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
// the result carrying every agent name literal inside its command line, and
// the old whole-line includes() branches let it impersonate a client —
// reasonix sat first in the chain with no command-line check, so the panel
// held a phantom 启动/待命 reasonix card on a machine that never ran
// Reasonix. cmd.exe maps to a bucket of its own purely so the dispatch can
// send it to the lineage table and nowhere else.
const AGENT_IMAGE_BUCKETS = [
  ["reasonix.exe", "reasonix"],
  ["reasonix-cli.exe", "reasonix"],
  ["reasonix-desktop.exe", "reasonix"],
  ["reasonix-launcher.exe", "reasonix"],
  ["qoder.exe", "qoder"],
  ["zcode.exe", "zcode"],
  ["claude.exe", "claude"],
  ["opencode.exe", "opencode"],
  ["dsh.exe", "dsh"],
  ["node.exe", "node"],
  ["cmd.exe", "cmd"],
];

// Tail-anchored matchers for WMIC-shaped rows, one per candidate. WMIC output
// is <node>,<command line...>,<name>[,<ppid>],<pid> and command lines carry
// commas (quoted flags) plus quoted name literals (name='Reasonix.exe'), so
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
  const image = field[1].match(/^"?(?:[^"\\\/]*[\\\/])*([a-z0-9_.-]+\.exe)(?:\s|"|$)/);
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

// The empty scan result both parseTasklistCsv and the collector's cache init
// start from: zero counts, empty pid sets, empty lineage table.
function createEmptyProcessScan() {
  return { zcode: 0, claude: 0, opencode: 0, dsh: 0, pi: 0, kimi: 0, reasonix: 0, qoder: 0, claudePids: new Set(), opencodePids: new Set(), dshPids: new Set(), piPids: new Set(), kimiPids: new Set(), reasonixPids: new Set(), qoderPids: new Set(), ppidByPid: new Map() };
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
    // reasonix ghost card), so command lines are consulted only AFTER the
    // name has claimed the row, and cmd.exe-named rows feed nothing but the
    // lineage table above.
    const { image, commandLine } = resolveProbeRow(lower);
    const bucket = image !== null
      ? (AGENT_IMAGE_BUCKETS.find(([img]) => img === image)?.[1] ?? null)
      : null;
    if (bucket === null) continue;

    if (bucket === "cmd") continue;

    if (bucket === "reasonix") {
      if (commandLine?.includes("--type=")) {
        // Electron helper child process, skip
      } else {
        result.reasonix += 1;
        if (pid) result.reasonixPids.add(pid);
      }
    } else if (bucket === "qoder") {
      // Qoder IDE is an Electron app: filter --type= helper children like
      // reasonix/zcode so only main processes count as the endpoint process.
      if (commandLine?.includes("--type=")) {
        // Electron helper child process, skip
      } else {
        result.qoder += 1;
        if (pid) result.qoderPids.add(pid);
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
      result.dsh += 1;
      if (pid) result.dshPids.add(pid);
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
        result.dsh += 1;
        if (pid) result.dshPids.add(pid);
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
        if (pid) result.kimiPids.add(pid);
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
    recentSamples: [], // last N successful requests' {tps, completion, genDuration, prompt, cached}
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
  // Optional per-instance tag (multi-instance endpoints). Validated once here
  // so the journal row and the instance bucket never see a raw header value.
  const journalInstanceId = sanitizeInstanceId(meta.instanceId);
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
  // 「最近」或「待命」，而不是打印 auto。
  if (meta.model && meta.model !== AUTO_MODEL) {
    state.currentModel = meta.model;
    state.lastModel = meta.model;
    const count = state.activeModels.get(meta.model) || 0;
    state.activeModels.set(meta.model, count + 1);
    bookTarget(meta.providerId, meta.model, false, +1);
    state.currentViaAuto = false;
    state.lastViaAuto = false;
  }
  if (meta.providerId) {
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
  let displayModel = typeof meta.model === "string" && meta.model && meta.model !== AUTO_MODEL ? meta.model : null;
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
      clearMatchingAggregateFault(state, meta);
      if (firstChunkTime !== null || ended) return;
      firstChunkTime = nowFn();
      const ttft = Math.max(1, firstChunkTime - startTime);
      journalTtftMs = ttft;
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
      // re-latches.
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

      if (hadError) {
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
      } else if (!aborted && firstChunkTime === null) {
        clearMatchingAggregateFault(state, meta);
      }

      // Generation duration is only meaningful for requests that actually
      // produced output. Failed/aborted requests never generated tokens, so
      // their wall-clock duration must not feed TPS or the sliding window.
      let genDuration = reqDuration;
      if (firstChunkTime !== null) {
        const rawGen = Math.max(1, endTime - firstChunkTime);
        // If firstChunkTime was recorded within 150ms of endTime (e.g. tool call
        // or single fast packet where firstChunk and finish arrived in the same TCP burst),
        // fallback to full reqDuration so instantaneous TPS is not artificially
        // inflated to 2000-5000+ tok/s by a tiny denominator artifact.
        if (rawGen < 150) {
          genDuration = Math.max(rawGen, reqDuration);
        } else {
          genDuration = rawGen;
        }
        state.totalGenerationDurationMs += genDuration;
      } else if (!hadError && !aborted) {
        // Non-streaming success: the full request duration is the best TTFT
        // proxy available. Failed/aborted requests never produced a first
        // token — recording their failure duration would fabricate a
        // healthy-looking TTFT and mask the fault from the panel.
        genDuration = reqDuration;
        state.lastTtftMs = reqDuration;
        journalTtftMs = reqDuration;
        state.ttftHistory.push(reqDuration);
        const keep = Math.max(recentSampleWindow, state.sparkWindowPoints || recentSampleWindow);
        if (state.ttftHistory.length > keep) state.ttftHistory.shift();
        state.totalGenerationDurationMs += reqDuration;
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
        // completion tokens. We calculate each request's individual TPS and
        // aggregate them as an arithmetic average (平均速度) across recent dialogues/requests,
        // ensuring concurrent multi-dialogues do not accumulate into combined speed (合速度).
        if (!hadError && !aborted && completion > 0) {
          // Secondary burst check: if completion / (genDuration / 1000) > 200, re-clamp to reqDuration
          if (firstChunkTime !== null && (completion / (genDuration / 1000)) > 200) {
            genDuration = Math.max(genDuration, reqDuration);
          }
          genDuration = Math.max(genDuration, 100);
          let singleTps = Number((completion / (genDuration / 1000)).toFixed(1));
          if (singleTps > 300) singleTps = 300;

          state.recentSamples.push({
            tps: singleTps,
            completion,
            genDuration,
            prompt,
            cached,
          });
          const keep = Math.max(recentSampleWindow, state.sparkWindowPoints || recentSampleWindow);
          if (state.recentSamples.length > keep) {
            state.recentSamples.shift();
          }
        }
      }

      if (stability && meta.model && !aborted) {
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

  let tps = null;
  if (tpsSamples.length > 0) {
    const validSamples = tpsSamples.filter((s) => typeof s.tps === "number" && s.tps > 0);
    if (validSamples.length > 0) {
      const sumTps = validSamples.reduce((acc, s) => acc + s.tps, 0);
      tps = Number((sumTps / validSamples.length).toFixed(1));
    }
  }

  let cacheHitRate = null;
  if (tpsSamples.length > 0) {
    let sumPrompt = 0, sumCached = 0;
    for (const s of tpsSamples) {
      sumPrompt += s.prompt;
      sumCached += s.cached;
    }
    if (sumPrompt > 0) {
      cacheHitRate = Number(((sumCached / sumPrompt) * 100).toFixed(1));
    }
  }

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
    tps: state.recentSamples.map((s) => s.tps).filter((v) => typeof v === "number" && v > 0).slice(-sparkLimit),
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

export function createAgentMetricsCollector(options = {}) {
  const execFn = options.execFn ?? exec;
  const nowFn = options.nowFn ?? Date.now;
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

  // Process detection cache
  let lastProcessScanTime = 0;
  let cachedProcessCounts = createEmptyProcessScan();
  let pendingScanPromise = null;

  async function scanProcesses() {
    const now = nowFn();
    if (now - lastProcessScanTime < 2500 && pendingScanPromise === null) {
      return cachedProcessCounts;
    }
    if (pendingScanPromise) return pendingScanPromise;

    pendingScanPromise = new Promise((resolve) => {
      // 1. Primary probe: WMIC with CommandLine, ParentProcessId and ProcessId.
      // ParentProcessId rides the same query (zero extra spawn) to build the
      // lineage table instance-id normalization walks; cmd.exe joins the name
      // filter because launcher → client chains pass through a `cmd /c` shim
      // (the launchers spawn via COMSPEC) and a missing intermediate hop would
      // break ancestor resolution. cmd.exe rows feed only the lineage table —
      // no counting branch claims them.
      execFn('wmic process where "name=\'ZCode.exe\' or name=\'claude.exe\' or name=\'opencode.exe\' or name=\'dsh.exe\' or name=\'pi.exe\' or name=\'Reasonix.exe\' or name=\'reasonix-cli.exe\' or name=\'reasonix-desktop.exe\' or name=\'reasonix-launcher.exe\' or name=\'Qoder.exe\' or name=\'node.exe\' or name=\'cmd.exe\'" get ProcessId,ParentProcessId,CommandLine,Name /format:csv', { timeout: 3000, windowsHide: true }, (wmicErr, wmicOut) => {
        lastProcessScanTime = nowFn();
        if (!wmicErr && typeof wmicOut === "string" && wmicOut.includes("ProcessId")) {
          cachedProcessCounts = parseTasklistCsv(wmicOut);
          resolve(cachedProcessCounts);
          return;
        }

        // 2. Secondary fallback: PowerShell Get-CimInstance (preserves CommandLine on Win11 where wmic is deprecated/slow).
        // Same lineage additions as the WMIC probe: ParentProcessId column (emitted
        // as the second field) and cmd.exe in the filter.
        const psCmd = 'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter \\"name=\'node.exe\' or name=\'claude.exe\' or name=\'ZCode.exe\' or name=\'dsh.exe\' or name=\'pi.exe\' or name=\'opencode.exe\' or name=\'Reasonix.exe\' or name=\'reasonix-cli.exe\' or name=\'reasonix-desktop.exe\' or name=\'reasonix-launcher.exe\' or name=\'Qoder.exe\' or name=\'cmd.exe\'\\" | ForEach-Object { \\"$($_.ProcessId),$($_.ParentProcessId),$($_.Name),$($_.CommandLine)\\" }"';
        execFn(psCmd, { timeout: 3000, windowsHide: true }, (psErr, psOut) => {
          if (!psErr && typeof psOut === "string" && psOut.trim().length > 0) {
            cachedProcessCounts = parseTasklistCsv(psOut);
            resolve(cachedProcessCounts);
            return;
          }

          // 3. Ultimate fallback: standard tasklist CSV. No parent column on
          // this path — the lineage table stays empty and ancestor-based
          // instance-id normalization degrades to a no-op (ids pass through).
          execFn('tasklist /NH /FO CSV', { timeout: 3000, windowsHide: true }, (err, stdout) => {
            if (!err && typeof stdout === "string") {
              cachedProcessCounts = parseTasklistCsv(stdout);
            }
            resolve(cachedProcessCounts);
          });
        });
      });
    });

    // Clear the in-flight marker after the scan settles so the next call
    // past the cache window re-scans. Using .then keeps this correct for both
    // async exec (real child_process) and sync exec (test mocks): the clear
    // runs after the resolve, never before the outer assignment lands.
    pendingScanPromise.then(() => {
      pendingScanPromise = null;
    });

    return pendingScanPromise;
  }

  // Aggregate metrics state
  const zcodeState = createAggregateState();
  const dshState = createAggregateState();
  const piState = createAggregateState();
  const kimiState = createAggregateState();
  const reasonixState = createAggregateState();
  const qoderState = createAggregateState();
  const opencodeState = createAggregateState();
  const claudeState = createAggregateState();

  // Per-instance buckets for the multi-instance endpoints (kimi / opencode /
  // pi): instanceId -> { state, firstSeen }. Only requests carrying a
  // valid instanceId land here, and they ALSO land in the endpoint aggregate
  // above, so the existing cards are unchanged. claude is per-session
  // already; zcode/dsh/reasonix/qoder stay aggregate-only by design.
  const instanceBuckets = { kimi: new Map(), opencode: new Map(), pi: new Map() };

  function applySparkWindow(n) {
    sparkWindowPoints = parseSparkWindowPoints(n);
    const keep = Math.max(recentSampleWindow, sparkWindowPoints);
    for (const state of [zcodeState, dshState, piState, kimiState, reasonixState, qoderState, opencodeState, claudeState]) {
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

  function isReasonixRequest(meta = {}) {
    if (typeof meta.agentId === "string") {
      const id = meta.agentId.toLowerCase().trim();
      if (id === "reasonix") return true;
    }
    if (typeof meta.userAgent === "string") {
      const ua = meta.userAgent.toLowerCase();
      if (ua.includes("reasonix")) return true;
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

  // Claude aggregate bucket. agentId-only on purpose: the resident relay's
  // /v1/messages path already maps the Anthropic client UA to agentId
  // "claude" upstream, while the chat/completions path explicitly defaults
  // agentId to "zcode" — a UA sniff here would wrongly override that tag.
  // Claude's per-session panel card is a separate reporter path; this bucket
  // only keeps relay traffic out of the zcode fallback.
  function isClaudeRequest(meta = {}) {
    return typeof meta.agentId === "string" && meta.agentId.toLowerCase().trim() === "claude";
  }

  // Track an in-flight request
  function startRequest(meta = {}) {
    let targetState = zcodeState;
    let bucketAgentId = "zcode";
    if (isDshRequest(meta)) {
      targetState = dshState;
      bucketAgentId = "dsh";
    } else if (isPiRequest(meta)) {
      targetState = piState;
      bucketAgentId = "pi";
    } else if (isKimiRequest(meta)) {
      targetState = kimiState;
      bucketAgentId = "kimi";
    } else if (isReasonixRequest(meta)) {
      targetState = reasonixState;
      bucketAgentId = "reasonix";
    } else if (isQoderRequest(meta)) {
      targetState = qoderState;
      bucketAgentId = "qoder";
    } else if (isOpencodeRequest(meta)) {
      targetState = opencodeState;
      bucketAgentId = "opencode";
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
    // Accepted trade-off (cold-cache window): when the relay has just started
    // and cachedProcessCounts is still the empty scan, a launcher-injected
    // "<cwd基名>-<launcher pid>" id cannot resolve and is tracked under the
    // RAW id as a custom (idle-TTL) row. Once the cache warms, later requests
    // fold into the canonical "<agentId>-<client pid>" row, so the panel can
    // briefly show two rows for one logical instance and the counts split
    // across both buckets. The raw row self-heals: it is a custom id on the
    // 10-minute idle TTL (INSTANCE_IDLE_TTL_MS) and expires on its own.
    const rawInstanceId = sanitizeInstanceId(meta.instanceId);
    const instMap = instanceBuckets[bucketAgentId];
    const normalized = rawInstanceId !== null && instMap !== undefined
      ? normalizeInstanceId(bucketAgentId, rawInstanceId, cachedProcessCounts)
      : null;
    const effMeta = normalized !== null && normalized.id !== rawInstanceId
      ? { ...meta, instanceId: normalized.id }
      : meta;
    const primary = trackAggregateRequest(targetState, effMeta, nowFn, recentSampleWindow, stability, journal, bucketAgentId);

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
      const raw = sanitizeInstanceId(rawId);
      if (raw === null) return;
      bindInstance(normalizeInstanceId(bucketAgentId, raw, cachedProcessCounts));
    }

    if (normalized !== null) {
      bindInstance(normalized);
      return {
        recordFirstChunk: (arg) => composed.recordFirstChunk?.(arg),
        setCurrentMember: (arg) => composed.setCurrentMember?.(arg),
        setAttributeResolver: (arg) => composed.setAttributeResolver?.(arg),
        recordRetry: (arg) => composed.recordRetry?.(arg),
        noteKeepAliveRecovery: (arg) => composed.noteKeepAliveRecovery?.(arg),
        noteKeepAliveExhausted: (arg) => composed.noteKeepAliveExhausted?.(arg),
        recordEnd: (arg) => composed.recordEnd?.(arg),
        attachInstance,
      };
    }

    let ended = false;
    const endOnce = (arg) => {
      ended = true;
      return composed.recordEnd?.(arg);
    };
    return {
      recordFirstChunk: (arg) => composed.recordFirstChunk?.(arg),
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
          if (now - s.lastSeen > ENDED_DISPLAY_MS) claudeSessions.delete(key);
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
    for (const state of [zcodeState, dshState, piState, kimiState, reasonixState, qoderState, opencodeState, claudeState]) {
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
    settleAbandonedAggregateState(reasonixState, procCounts.reasonix || 0);
    settleAbandonedAggregateState(qoderState, procCounts.qoder || 0);
    settleAbandonedAggregateState(opencodeState, procCounts.opencode || 0);
    settleAbandonedAggregateState(claudeState, procCounts.claude || 0);

    // Instance housekeeping mirrors the endpoint-level one: settle orphans,
    // expire stale fault latches, drop stale entries. Read-driven, no timers.
    // Liveness splits by id shape. An id of the strict "<agentId>-<pid>"
    // form (socket-fallback synthesized, launcher-injected and folded by
    // normalizeInstanceId at ingest, or the placeholder below) declares its
    // owning PID, so the process scan is authoritative: a live PID keeps the
    // row listed regardless of idle time, a dead PID evicts it now — the idle
    // TTL would otherwise leave a dead instance showing 待命 until
    // lastSeen+10min. Custom ids (no numeric tail, or a tail pid that resolved
    // to no client of this endpoint — normalizeInstanceId already had its say
    // at ingest) have no reliable instanceId<->PID mapping and keep the idle
    // TTL; an instance with in-flight requests never expires on that path.
    const bucketAggregateState = { kimi: kimiState, opencode: opencodeState, pi: piState };
    for (const [bucket, instMap] of Object.entries(instanceBuckets)) {
      const count = procCounts[bucket] || 0;
      const livePids = procCounts[`${bucket}Pids`] ?? new Set();
      const pidIdRe = new RegExp(`^${bucket}-(\\d+)$`);
      for (const [instId, entry] of instMap) {
        const pidMatch = instId.match(pidIdRe);
        if (pidMatch !== null && !livePids.has(Number(pidMatch[1]))) {
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
          if (entry.state.activeRequests === 0 && now - lastSeen > INSTANCE_IDLE_TTL_MS) {
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
      // above evicts it on the next read.
      for (const pid of livePids) {
        const placeholderId = `${bucket}-${pid}`;
        if (!instMap.has(placeholderId)) {
          instMap.set(placeholderId, { state: createAggregateState(), firstSeen: now, label: null });
        }
      }
    }

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
          return {
            ...s,
            // Authoritative spark history (same shape as the endpoint-level
            // metrics.sparkHistory) so per-instance sparklines survive page
            // reloads — the panel seeds its buffers from it, mirroring the
            // aggregate cards.
            sparkHistory: built.metrics.sparkHistory,
            id: instId,
            // The cwd basename a launcher-injected id folded in with (null
            // for socket-fallback/placeholder rows) — the panel renders
            // `inst.title || iid`, so an unlabeled row shows its id as before.
            title: entry.label ?? instId,
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
      let tps = null;
      if (s.activeDurationMs > 0 && s.completionTokens > 0) {
        tps = Number((s.completionTokens / (s.activeDurationMs / 1000)).toFixed(1));
      }
      let cacheHitRate = null;
      if (s.promptTokens > 0) {
        cacheHitRate = Number(((s.cachedTokens / s.promptTokens) * 100).toFixed(1));
      }
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
        // per-instance sparkHistory on kimi/opencode/pi.
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

    // 3. DSH Agent Status
    const dshAgent = buildAggregateAgentStatus({
      id: "dsh",
      name: "DSH",
      state: dshState,
      processCount: procCounts.dsh || 0,
      tpsWindow: recentSampleWindow,
      nowFn,
    });

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
    const kimiAgent = buildAggregateAgentStatus({
      id: "kimi",
      name: "Kimi Code",
      state: kimiState,
      processCount: procCounts.kimi || 0,
      tpsWindow: recentSampleWindow,
      nowFn,
      instances: instanceSnapshots("kimi"),
    });

    const reasonixAgent = buildAggregateAgentStatus({
      id: "reasonix",
      name: "Reasonix",
      state: reasonixState,
      processCount: procCounts.reasonix || 0,
      tpsWindow: recentSampleWindow,
      nowFn,
    });

    const qoderAgent = buildAggregateAgentStatus({
      id: "qoder",
      name: "Qoder",
      state: qoderState,
      processCount: procCounts.qoder || 0,
      tpsWindow: recentSampleWindow,
      nowFn,
    });

    // 7. OpenCode Agent Status（汇总卡 + 实例桶，经 openai relay 的 UA / x-agent-id 归类）
    const opencodeAgent = buildAggregateAgentStatus({
      id: "opencode",
      name: "OpenCode",
      state: opencodeState,
      processCount: procCounts.opencode || 0,
      tpsWindow: recentSampleWindow,
      nowFn,
      instances: instanceSnapshots("opencode"),
    });

    return [zcodeAgent, claudeAgent, dshAgent, piAgent, kimiAgent, reasonixAgent, qoderAgent, opencodeAgent];
  }

  return {
    startRequest,
    reportSession,
    getAgentsStatus,
    getModelStability: () => stability.snapshot(nowFn()),
    scanProcesses,
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
  const sessionSamples = []; // {tps, genDuration, prompt, cached}
  const SESSION_SAMPLE_WINDOW = 128;
  const pushSessionSample = (sample) => {
    sessionSamples.push(sample);
    while (sessionSamples.length > SESSION_SAMPLE_WINDOW) sessionSamples.shift();
  };

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
    try {
      const headers = {
        "content-type": "application/json",
        "x-anyswitch-panel": "1",
        origin: "http://127.0.0.1:47821",
      };
      if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
      await fetchFn(reportUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(report),
      });
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
        tps: sessionSamples.map((s) => s.tps).filter((v) => typeof v === "number" && v > 0),
        cache: sessionSamples.map((s) => (s.prompt > 0 ? Number(((s.cached / s.prompt) * 100).toFixed(1)) : 0)),
      },
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
    if (!hadError && !aborted) {
      const norm = normalizedUsage(usage);
      if (norm.completion > 0) {
        const genDuration = Math.max(1, endTime - (ctx.firstChunk ?? ctx.startTime));
        pushSessionSample({
          tps: Math.min(300, Number((norm.completion / (genDuration / 1000)).toFixed(1))),
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
        const reqDuration = Math.max(1, endTime - ctx.startTime);
        const norm = normalizedUsage(usage);
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

    reportEnd() {
      stopHeartbeat();
      post({ ...snapshot(), ended: true });
    },
  };
}
