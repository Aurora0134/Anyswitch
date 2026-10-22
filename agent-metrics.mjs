import { exec, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.mjs";
import { DEFAULT_SPARK_WINDOW_POINTS, parseSparkWindowPoints, loadSettings } from "./relay-settings.mjs";
import { createModelStabilityTracker, STABILITY_FILENAME } from "./model-stability.mjs";
import { readKimiServerInstances, resolveKimiCodeHome } from "./kimi-server-registry.mjs";
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
// display history on the model-stability cadence: the run's accounting and
// the sample windows backing the card's numbers. It is display history, never
// protocol state — on restore, in-flight counts, fault latches and
// current-identity fields stay live-only (see restoreAggregateState), because
// restoring them would pin a "生成中" badge no live request owns. A run anchor
// rides along (top-level runPids: per endpoint, the process ids the last
// trusted scan attributed to it): the first trusted scan after restore decides
// per endpoint whether the pre-restart run is still alive (any anchored pid
// present) or was replaced (agent restarted during the downtime — the restored
// account is a dead run's remnant and zeroes). All card metrics are
// run-scoped, so the anchor is what keeps a restore from pinning one run's
// totals onto the next.
export const METRICS_SNAPSHOT_FILENAME = "agent-metrics-snapshot.json";
// v2 = runPids anchors + claude retirement ledger. v1 sidecars predate both
// and are discarded on sight (a v1 restore would resurrect lifetime totals
// with no anchor to zero them — the exact bug this version exists to close).
const METRICS_SNAPSHOT_VERSION = 2;
const METRICS_SNAPSHOT_EVERY_MS = 30_000;

// Per-endpoint pid set that defines "this endpoint's run": the anchor records
// it, the restore verdict compares against it, and a full-family death during
// live operation zeroes the endpoint account against the same scope. The sets
// are family-wide (dsh includes its TUI launcher shells, codex includes the
// desktop GUI shell) — a surviving family member means the run continues, and
// the scan-count scope on the cards matches.
const RUN_ANCHOR_SCOPE = {
  zcode: "zcodePids",
  claude: "claudePids",
  dsh: "dshPids",
  pi: "piPids",
  kimi: "kimiPids",
  qoder: "qoderPids",
  codex: "codexPids",
  opencode: "opencodePids",
  grok: "grokPids",
};

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

// opencode serve 子进程的上折（resolveInstanceId 的第三条折叠路径）。opencode 2.x
// 的交互主进程拉起 `opencode.exe serve --service`，持有到 relay 的 keep-alive 连接
// 并发出全部 LLM 流量（live 2026-10-16：netstat 属主、journal 实例号、实例行三处
// 全是子进程 pid）——socket 兜底合成的 "opencode-<serve pid>" 必须上折到交互主
// 进程：终端 join 绑的是交互进程（离 shell 最近），占位行/检测面也只认它，两套
// 形状靠这一折合流。与 codex 的下折（GUI 壳是引擎的父、从壳 pid 折到引擎）互为
// 镜像。门只对扫描明确分类出的 serve 子进程开（精确集合，不做模糊认领），父链
// 走不通（主进程已退、子进程滞留）返回 null，原始号维持原样、行走家族存活判定。
function opencodeServeAncestorPid(tailPid, agentId, clientPids, procSnapshot) {
  if (agentId !== "opencode") return null;
  const servePids = procSnapshot?.opencodeServePids;
  const ppidByPid = procSnapshot?.ppidByPid;
  if (!(servePids instanceof Set) || !servePids.has(tailPid)) return null;
  if (!(clientPids instanceof Set) || !(ppidByPid instanceof Map)) return null;
  let current = tailPid;
  const seen = new Set([current]);
  for (let depth = 0; depth < INSTANCE_LINEAGE_MAX_DEPTH; depth += 1) {
    const parent = ppidByPid.get(current);
    if (parent === undefined || seen.has(parent)) return null;
    if (clientPids.has(parent)) return parent;
    seen.add(parent);
    current = parent;
  }
  return null;
}

// Normalize a (already well-formed or not) instance id against a process-scan
// snapshot-ish ({ [`${agentId}Pids`]: Set, ppidByPid: Map }, both optional; an
// endpoint that tracks an engine subset folds against `${agentId}EnginePids`
// instead — codex and dsh do, see their bucket comments).
// Returns { id, label, clientPid }: id is the canonical "<agentId>-<client pid>"
// when the numeric tail resolves, otherwise the input unchanged; label is the
// id's prefix (cwd basename) on a successful fold, else null; clientPid is the
// resolved client pid (null when the tail did not resolve). The desktop-row
// generation settlement needs that pid at the fold site, which is why the
// detailed shape exists — normalizeInstanceId below is the compatibility
// wrapper for callers that only read id/label. Returns null for an invalid
// rawId (same rule as sanitizeInstanceId).
function resolveInstanceId(agentId, rawId, procSnapshot = null) {
  const id = sanitizeInstanceId(rawId);
  if (id === null || typeof agentId !== "string" || agentId.length === 0) return null;
  // 会话粒度行（codex-sess- / opencode-sess-）声明不了属主 pid：id 里的数字
  // 尾巴是会话 id 的一部分而不是进程号，归一对它们是恒等映射。
  if (isSessionRowId(id)) return { id, label: null, clientPid: null };
  const tail = id.match(/-(\d+)$/);
  if (tail === null) return { id, label: null, clientPid: null };
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
  if (clientPid === null) {
    clientPid = opencodeServeAncestorPid(tailPid, agentId, clientPids, procSnapshot);
  }
  if (clientPid === null) return { id, label: null, clientPid: null };
  // DSH 桌面宿主与 kimi 桌面主进程折稳定行：canonical 尾解析到桌面 App 的
  // 宿主/主进程时，id 落到各自的面级稳定行（DSH/KIMI_DESKTOP_INSTANCE_ID）。
  // 行身份跨代稳定，但账目是否延续由代际结算另判（见桌面代际锚注释）——
  // 这里只负责「请求归属哪一行」。
  // TUI/web 引擎不受影响，保持逐 pid。判据用各自的宿主集合而非 profile/面名
  // （CLI 自建同名 profile 不是桌面 App；kimi 的面来自镜像名，集合语义同源）。
  if (agentId === "dsh" && procSnapshot?.dshDesktopHostPids instanceof Set
    && procSnapshot.dshDesktopHostPids.has(clientPid)) {
    return { id: DSH_DESKTOP_INSTANCE_ID, label: null, clientPid };
  }
  if (agentId === "kimi" && procSnapshot?.kimiDesktopPids instanceof Set
    && procSnapshot.kimiDesktopPids.has(clientPid)) {
    return { id: KIMI_DESKTOP_INSTANCE_ID, label: null, clientPid };
  }
  const prefix = id.slice(0, tail.index);
  return { id: `${agentId}-${clientPid}`, label: prefix.length > 0 && prefix !== agentId ? prefix : null, clientPid };
}

export function normalizeInstanceId(agentId, rawId, procSnapshot = null) {
  const resolved = resolveInstanceId(agentId, rawId, procSnapshot);
  return resolved === null ? null : { id: resolved.id, label: resolved.label };
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

// Same rule for opencode session rows, minus the placeholder: an opencode
// session always carries a working directory (session_v2.directory is NOT
// NULL), and a row that still finds nothing shows its raw id like every other
// unmatched instance row instead of inventing a label.
function opencodeSessionRowTitle(instId, sessionById) {
  const sessionId = instId.slice(OPENCODE_SESSION_ID_PREFIX.length);
  const meta = sessionById?.get(sessionId) ?? null;
  if (typeof meta?.title === "string" && meta.title.trim() !== "") return meta.title;
  if (typeof meta?.project === "string" && meta.project !== "") {
    const base = meta.project.split(/[\\/]/).filter(Boolean).pop();
    if (base) return base;
  }
  return instId;
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

// opencode session rows (ids "opencode-sess-<opencode session id>", derived
// from the x-opencode-session request header — see opencodeSessionInstanceId in
// openai-server.mjs). Same no-owning-PID situation as codex: one resident
// `serve --service` process carries every TUI's traffic, so a pid-shaped row
// cannot name the session that sent a request. Lifetime differs on purpose: an
// opencode session row lives exactly as long as the interactive family does
// (see the housekeeping note — a TUI that is merely idle still has its
// conversation on screen, while codex's GUI never exits and therefore needs a
// TTL).
export const OPENCODE_SESSION_ID_PREFIX = "opencode-sess-";

// Session-granular row ids, keyed by the endpoint that mints them. Both declare
// no owning PID: liveness is the endpoint's process family (plus, for codex
// only, an idle TTL).
const SESSION_ROW_PREFIXES = Object.freeze({
  codex: CODEX_SESSION_ID_PREFIX,
  opencode: OPENCODE_SESSION_ID_PREFIX,
});
const SESSION_ROW_IDLE_TTL_MS = Object.freeze({
  codex: CODEX_SESSION_IDLE_TTL_MS,
  opencode: null,
});

// How many consecutive trusted scan rounds must report the endpoint's family as
// absent before its session rows are evicted. One round is not a verdict: the
// process probe can be truncated under its time budget, and a family that is
// restarting shows up as zero for exactly one round — evicting then drops rows
// that are still in use (terminal row binding falls back to null). Two rounds
// is still immediate in human terms (the scan window is a couple of seconds).
const SESSION_ROW_FAMILY_MISS_ROUNDS = 2;

function isSessionRowId(id) {
  return id.startsWith(CODEX_SESSION_ID_PREFIX) || id.startsWith(OPENCODE_SESSION_ID_PREFIX);
}

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
  // Qoder CLI 的官方形态是 Bun 单文件 qodercli.exe（resolveQoderCliExecutable，
  // 终端一键启动用的就是它）：不收进认领表的话 CLI 进程永远不进 detected feed，
  // 虚拟终端的 Qoder 会话归属不到端点（2026-10-15 取证）。它自带的
  // `--internal-sites-mcp` 内部子进程同镜像名，计数在 qoder 桶分支里滤掉。
  ["qodercli.exe", "qoder"],
  ["codex.exe", "codex"],
  ["codex-code-mode-host.exe", "codex"],
  ["codex-command-runner.exe", "codex"],
  ["chatgpt.exe", "codex"],
  ["zcode.exe", "zcode"],
  ["claude.exe", "claude"],
  ["opencode.exe", "opencode"],
  ["dsh.exe", "dsh"],
  // pi 的原生形态（上游发布的原生二进制，若在）：镜像名即会话进程，由 pi 桶
  // 分支照 dsh.exe 的 accept-by-name 直接计数——isPiNode 那套 @earendil-works
  // 包路径谓词对原生行的命令行不适用。白名单（PS_PROCESS_SCAN_QUERY）本就
  // 拉取 pi.exe 行，桶表缺席时该行只进谱系表不进任何计数，原生形态整段漏计
  // （2026-10-25 体检确认的潜伏缺陷）。与 node.exe 形态（npm 包）是同一会话
  // 可能的两种形态，「pi.exe 父＋node 子」谱系的双计防护见 parseTasklistCsv
  // 循环后的裁决。
  ["pi.exe", "pi"],
  ["grok.exe", "grok"],
  // Kimi Code 的官方桌面端是原生 Electron 包：镜像名 `Kimi Code.exe`，命令行里
  // 没有任何 `kimi-code` 安装路径特征，下面 node.exe 分支的那套路径谓词永远匹配
  // 不到它（步 1 of kimi-desktop-integration-plan.md §3：桌面端在进程面全盲）。
  ["kimi code.exe", "kimi"],
  // The official DSH desktop app is Electron too, but its image name must not
  // in itself make a DSH session: the app spawns itself as the harness host,
  // and the desktop branch claims only the child that carries the host flag
  // (see the DSH_DESKTOP_* block above). The row exists so the shell — and the
  // helpers it spawns — are at least visible to the lineage table.
  ["deepseek harness.exe", "dsh-desktop"],
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

// ---------------------------------------------------------------------------
// DSH Desktop (the official Electron package, 0.2). Same endpoint, third
// interface — the "one product, several interfaces" shape kimi already has,
// so nothing here introduces an endpoint of its own (dsh-tui-integration-plan
// §8, still binding).
//
// It is invisible on the process plane for a reason worth writing down: the
// app does not boot the harness as a script we can recognize. `DeepSeek
// Harness.exe` spawns the SAME image as a child with
// `--expose-internals <runtimeDir>/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`,
// which is where the profile `desktop` is booted from, so the child's command
// line carries no `--profile` and no `\dsh\lib\bin.js` — neither the engine
// signature nor the profile parse matches it. And unlike kimi's desktop app,
// the main process is not a session owner either: it is the Electron shell
// (its `--type=` children are renderers), while the session lives in the host
// child the same image runs. So the image name must NOT join the engine set —
// one boot would then read as two sessions.
//
// The surface label is the profile directory name `desktop`, which is the same
// fact the profile map carries for every other interface; only its display
// text is DSH's own and carries no local invention (kimi's `kimiSurfaceLabel`
// draws the same line).
const DSH_DESKTOP_PROFILE = "desktop";
// The Electron shell's image name — the row that owns `--type=` children and
// the parent of the host child, never a session itself.
const DSH_DESKTOP_SHELL_IMAGE = "deepseek harness.exe";
// `…\@deepseek-ai\dsh-desktop-host\lib\index.js` on the host child's command
// line. A user's own profile may be named `desktop` too, so the flag is what
// makes the profile map entry honest — a bare `desktop` profile name from a
// CLI boot would otherwise be relabeled as the desktop app.
const DSH_DESKTOP_HOST_RE = /dsh-desktop-host[\\/]lib[\\/]index\.js/;

// 稳定行 id：DSH 桌面端的实例行按「面」记账，不按引擎 pid。桌面 App 每轮对话
// 都换宿主引擎进程（journal 实测 2026-10-04 一天 11 个 pid），逐 pid 行在每次
// 换代时删旧建新——请求数、工时、折线全部从零，看板上读作「历史凭空消失」。
// 桌面宿主进程统一折到这个 id，换代对看板不可见。判据必须是宿主子进程集合
// （上面的 HOST_RE），不能只看 profile 名：CLI 自建 `--profile desktop` 的
// 会话 profile 同名，却不是桌面 App。
//
// 行身份与账目是两件事，各自的判据都锚在进程上、与空闲时长无关：
// 行可见性 = 面的进程存活（宿主或壳任一在，行就在；全灭即收，与逐 pid 行
// 同权即时），账目 = 面的当前一代（DSH 的一代 = 一次 App 运行，锚是宿主
// 引擎的父进程即 Electron 壳：壳不变，换代续账；壳换了且旧壳全灭 = 真重启，
// 重开账）。见 settleDesktopGenerationOnFold 的注释。
const DSH_DESKTOP_INSTANCE_ID = "dsh-desktop";

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

// Is this DSH-family command line the desktop app's host child? The image name
// is the desktop shell's, so the flag on the row is what decides — see the
// DSH_DESKTOP_* block above.
function isDshDesktopCommandLine(lower, image) {
  return image === DSH_DESKTOP_SHELL_IMAGE && DSH_DESKTOP_HOST_RE.test(lower);
}

// Panel display names for the profiles whose UI form is not the directory
// name: `web` is DSH's browser UI (also spelled by its `dsh web` alias), and
// the community terminal front end installs itself as profile `dsh-tui`
// (`dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui`).
// `desktop` is the official Electron package's own profile directory, so the
// map is a display-name table, not a surface enum: it is keyed by the very
// name DSH uses on disk (DSH_DESKTOP_PROFILE), which is why a user profile of
// the same name is only held to it when the desktop host is really on the
// command line (isDshDesktopCommandLine).
// The badge axis is the interface, not the product: unknown profiles show
// the product name (bare `dsh` is a real bootable profile) — the badge's
// "which surface is this" question has no answer there.
const DSH_SURFACE_LABELS = { web: "Web", "dsh-tui": "TUI", tui: "TUI", desktop: "Desktop" };
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

// dsh 0.2.0 的 profile 委托把引擎作为子进程再拉起一遍，命令行与宿主完全相同
// （同一个全局 `dsh\lib\bin.js --profile <name>`），上面的谓词从此分不出宿主与
// 引擎。进程树分得出：引擎集里「自己是另一个引擎进程的父进程」的那个就是委托
// 宿主。扫描落地前把宿主折出引擎集（留在 dshPids 家族集保活性），等价于旧形态
// 里 `bin/dsh-tui.js` 壳排除所给的语义。桌面宿主豁免：桌面稳定行的身份按设计
// 锚在宿主 pid 上（见 resolveInstanceId 的桌面折稳定行）。
function foldDshDelegatingHosts(counts) {
  const engine = counts.dshEnginePids;
  if (!(engine instanceof Set) || engine.size < 2) return;
  const ppid = counts.ppidByPid;
  if (!(ppid instanceof Map) || ppid.size === 0) return;
  const desktopHosts = counts.dshDesktopHostPids instanceof Set ? counts.dshDesktopHostPids : null;
  const profiles = counts.dshProfileByPid instanceof Map ? counts.dshProfileByPid : null;
  // 一遍收敛：收集阶段读的是删除前的集合，任意深度的委托链一次全折掉，
  // 只留最深那个（真正持有连接、承载会话的进程）。
  const hosts = [];
  for (const pid of engine) {
    if (desktopHosts !== null && desktopHosts.has(pid)) continue;
    for (const other of engine) {
      if (other !== pid && ppid.get(other) === pid) { hosts.push(pid); break; }
    }
  }
  for (const pid of hosts) {
    // 子进程读不出自己的 profile 时，把宿主读出的传下去——徽标与副行都读子进程。
    const profile = profiles?.get(pid) ?? null;
    if (profile !== null && profiles !== null) {
      for (const other of engine) {
        if (other !== pid && ppid.get(other) === pid && !profiles.has(other)) profiles.set(other, profile);
      }
    }
    engine.delete(pid);
    profiles?.delete(pid);
    counts.dsh = Math.max(0, (counts.dsh ?? 0) - 1);
  }
}

// ---------------------------------------------------------------------------
// Kimi Code 的分面（步 1/2 of bridge/anyswitch/kimi-desktop-integration-plan.md）。
//
// 一个 kimi 端点 id、一份 ~/.kimi-code 家目录之上有三个界面：终端客户端
// （`kimi`）、`kimi web`（在终端里前台起的 server，浏览器只是它的观看端）、
// 以及官方原生桌面端。与 DSH 的差别在于面的读法：kimi 不需要命令行正则——
// 镜像名 `Kimi Code.exe` 本身就说明它是桌面端；剩下的 node 进程里，谁在
// `server/instances/` 名下有一条以自己 pid 署名的登记，谁就在服务一个带浏览器
// 的界面，没有登记的就是终端客户端。会写这张表的只有客户端起 server 的那四条路
// （清单见 kimi-server-registry.mjs 顶部），纯 TUI 一条都不碰，所以它能当分面
// 证据用；但桌面端的 pid 也记在同一张表里，故注册表只能把 tui 提为 web，永远
// 不能把桌面端降级或提级，也不能把扫描里不存在的进程号算成一个面。旧档的时效
// 按客户端 15 秒心跳节律收在 90 秒，判旧与退化的口径都写在那个模块里。
// TUI 里把当前会话交给浏览器会让同一个进程号中途从终端面换成 Web 面——面是每轮
// 扫描重算的，卡头副行与实例行在同一轮里一起跟上，不需要额外的换面逻辑。
//
// 面是封闭集合：集合外的值只可能是我们自己读错了，如实落「未知」，不原样上屏
// （DSH 那一档不同——那里的未知值是用户自己起的 profile 目录名，本身就是界面名）。
// ---------------------------------------------------------------------------
const KIMI_SURFACE_LABELS = { tui: "TUI", web: "Web", desktop: "Desktop" };

export function kimiSurfaceLabel(surface) {
  if (typeof surface !== "string" || !(surface in KIMI_SURFACE_LABELS)) return DSH_UNKNOWN_SURFACE_LABEL;
  return KIMI_SURFACE_LABELS[surface];
}

// Kimi 家目录（resolveKimiCodeHome：KIMI_CODE_HOME 优先，否则 ~/.kimi-code）
// 之下的 node 行一律不是会话。桌面端把托管的插件/MCP 帮手进程放在这棵树下
// 孵化（真机 2026-10-22：桌面主进程 → `cmd /c bin\kimi-cu-mcp.cmd` →
// `node %USERPROFILE%\.kimi-code\plugins\managed\kimi-cu-win\bin\launch.mjs`，
// computer-use 插件）：那条命令行里的 `.kimi-code\` 恰好包含 node 谓词的
// 裸安装 token `kimi-code\`，`dist\main.mjs` + `kimi` 的回退分支同样会被
// 家目录下的插件入口命中——原先一条零请求的幻影 TUI 会话行（kimi-<pid>）
// 就此挂上卡头。家目录是数据目录（config.toml、server/instances/ 注册表、
// 托管插件），不是安装目录，跑在里面的 node 都是帮手而非客户端；豁免只做
// 减法，scoped 安装路径（@moonshot-ai\kimi-code\）上的真实 TUI/Web 不受
// 影响。家目录由调用方按轮解析传入（KIMI_CODE_HOME 挪家当轮生效）；命令行
// 分隔符先归一成 `\` 再比，/ 与 \ 混拼的路径形态同样命中。
function isUnderKimiCodeHome(lower, kimiHomeLower) {
  const back = lower.replaceAll("/", "\\");
  const home = typeof kimiHomeLower === "string"
    ? kimiHomeLower.replaceAll("/", "\\").replace(/\\+$/, "")
    : "";
  if (home && back.includes(home + "\\")) return true;
  return back.includes(".kimi-code\\");
}

// Kimi 桌面端的面级稳定行：主进程（"Kimi Code.exe"，无 --type=）是会话属主，
// Electron 辅助子进程（--type=）只进家族集、永不进宿主集合 kimiDesktopPids。
// 行身份与账目分治（与 DSH 同款，2026-10-06 b26a776 先落 DSH 侧）：行可见性
// = 主进程集合非空；账目 = 主进程的一生——journal 实证（2026-10-02~06）主
// 进程换代都发生在会话尺度（旧死隔至少数分钟新生，或新旧短暂共存），不存在
// 活跃期内的静默换血，所以「旧主全灭 + 新主出现」即真重启，重开账；共存则
// 续账。判据见 settleDesktopGenerationOnFold。
const KIMI_DESKTOP_INSTANCE_ID = "kimi-desktop";

// 桌面稳定行的账目代际锚：hostPids 记本代喂过账的宿主/主进程，shellPids 仅
// DSH 有意义（宿主引擎的父进程 = Electron 壳 = 一次 App 运行的锚）。行对象
// 上的可缺字段——旧快照还原的行没有它，首次折叠/扫描证据到来时补建。
function ensureDesktopGen(entry) {
  if (!entry.desktopGen || !(entry.desktopGen.hostPids instanceof Set)) {
    entry.desktopGen = { hostPids: new Set(), shellPids: new Set() };
  }
  if (!(entry.desktopGen.shellPids instanceof Set)) entry.desktopGen.shellPids = new Set();
  return entry.desktopGen;
}

// 把源行的已完成计数并入目标行（重折叠合并路径用）。只累加累计量与样本环，
// 不碰在途/活跃字段（调用侧保证源行 activeRequests === 0）；样本按「目标在
// 前、源在后」拼接——源的请求必然更晚，时序天然成立，超窗从头裁掉。
function absorbAggregateState(target, source, keep) {
  target.totalRequests += source.totalRequests;
  target.totalActiveDurationMs += source.totalActiveDurationMs;
  target.totalGenerationDurationMs += source.totalGenerationDurationMs;
  target.activeWallClockMs += source.activeWallClockMs;
  target.totalPromptTokens += source.totalPromptTokens;
  target.totalCompletionTokens += source.totalCompletionTokens;
  target.totalCachedTokens += source.totalCachedTokens;
  target.keepAliveRetries += source.keepAliveRetries;
  target.keepAliveRecoveries += source.keepAliveRecoveries;
  target.keepAliveExhausted += source.keepAliveExhausted;
  if (source.recentSamples.length > 0) {
    target.recentSamples.push(...source.recentSamples);
    while (target.recentSamples.length > keep) target.recentSamples.shift();
  }
  if (source.ttftHistory.length > 0) {
    target.ttftHistory.push(...source.ttftHistory);
    while (target.ttftHistory.length > keep) target.ttftHistory.shift();
  }
  if (source.lastTtftMs !== null) target.lastTtftMs = source.lastTtftMs;
  if (target.firstRequestAt === null) target.firstRequestAt = source.firstRequestAt;
  if (source.lastRequestAt !== null) target.lastRequestAt = source.lastRequestAt;
  if (source.totalRequests > 0) {
    if (source.lastModel !== null) target.lastModel = source.lastModel;
    if (source.lastProvider !== null) target.lastProvider = source.lastProvider;
    target.lastViaAuto = source.lastViaAuto;
    target.lastChainKey = source.lastChainKey ?? null;
  }
  if (source.lastError !== null
    && (target.lastError === null || (source.lastError.time ?? 0) > (target.lastError.time ?? 0))) {
    target.lastError = source.lastError;
  }
}

// Claude client-form labels are derived from process classification. They are
// independent from the transport used to attribute metrics: Desktop uses the
// resident relay, while CLI normally uses a per-launch reporter.
const CLAUDE_SURFACE_LABELS = { cli: "TUI", desktop: "Desktop" };

export function claudeSurfaceLabel(surface) {
  if (typeof surface !== "string" || !(surface in CLAUDE_SURFACE_LABELS)) return null;
  return CLAUDE_SURFACE_LABELS[surface];
}

// The card summary follows logical client groups, not raw process count: one
// Desktop app may own several claude.exe processes. CLI rows remain one group
// per client PID, matching the instance rows below.
// CLI 只统计「分型明确是 CLI」的进程号：原先「不在桌面集合里就算 CLI」的写法，
// 在命令行读不到的那一轮会把整个桌面端的进程数报成 CLI 客户端数。既读不出、
// 又不算 CLI 的那部分不写进副行——这一档的存在由实例行上不贴徽标如实表达。
export function summarizeClaudeSurfaces(procCounts) {
  const desktopPids = procCounts?.claudeDesktopPids instanceof Set
    ? procCounts.claudeDesktopPids
    : new Set();
  const claudePids = procCounts?.claudePids instanceof Set
    ? procCounts.claudePids
    : new Set();
  const surfaceByPid = procCounts?.claudeSurfaceByPid instanceof Map
    ? procCounts.claudeSurfaceByPid
    : new Map();
  const rows = [];
  if (desktopPids.size > 0) rows.push({ surface: "desktop", label: "Desktop", count: 1 });
  const cliCount = [...claudePids].filter((pid) => surfaceByPid.get(pid) === "cli").length;
  if (cliCount > 0) rows.push({ surface: "cli", label: "TUI", count: cliCount });
  return rows;
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
// 每轮扫描的结果对象自带一个「桶内计数可信」位 countsAuthoritative，回答的是
// 读侧唯一关心的那个问题：这一轮各端点的进程数能不能当成事实用（0 就是真没了）。
//
// - 常驻 PowerShell 探针那一路带命令行与父进程列，是唯一能认全 node 型客户端
//   的扫描形状 → 可信。
// - 退回到 `tasklist /NH /FO CSV` 那一路，每一行都没有命令行，node.exe 行认不出
//   属于哪个 agent，靠安装路径识别的 kimi/pi/dsh/opencode 在这一轮是全盲的
//   （镜像名原生可辨的 claude/codex/qoder/grok/zcode 不受影响）→ 不可信：这一轮
//   的 0 是「没看见」，不是「不在了」。唯一的例外是回落也报了零行——两份探针都
//   说没有任何进程，此时没有可误判归属的行，沿用「端点已关闭」这一既有语义。
//
// 读侧据此区分「这轮没看见」与「这些进程真的不在了」：不可信轮不得据桶内 pid 集
// 删实例行、不得据零进程数清在途计数——这是「生成中永不出现 / 实例行被删 / 最近
// 请求永远为空」那一串症状的共同根因。seenPids 是这一轮探针报上来的全部 pid
// （tasklist 那一路即全机进程），只在轮次不可信时用来回答「这个 pid 还在不在」：
// 进程真死了照样淘汰，只是不再因为「这轮认不出它是谁」而淘汰。
function createEmptyProcessScan() {
  return { zcode: 0, claude: 0, opencode: 0, dsh: 0, pi: 0, kimi: 0, qoder: 0, codex: 0, grok: 0, zcodePids: new Set(), claudePids: new Set(), claudeDesktopPids: new Set(), claudeSurfaceByPid: new Map(), opencodePids: new Set(), opencodeEnginePids: new Set(), opencodeServePids: new Set(), dshPids: new Set(), dshEnginePids: new Set(), dshDesktopHostPids: new Set(), dshProfileByPid: new Map(), piPids: new Set(), kimiPids: new Set(), kimiEnginePids: new Set(), kimiDesktopPids: new Set(), kimiSurfaceByPid: new Map(), qoderPids: new Set(), codexPids: new Set(), codexEnginePids: new Set(), grokPids: new Set(), ppidByPid: new Map(), countsAuthoritative: false, seenPids: new Set() };
}

// Claude 桌面形态的镜像路径分型。桌面壳是 MSIX 应用（包名 Claude，真机
// 取证 1.37937.1.0），镜像落在 C:\Program Files\WindowsApps\Claude_<版本>_…\
// 下——同一形态约 5 个进程，逐 PID 成行会把一个桌面端拆成一排幽灵分身。
// 桌面托管引擎按 <根>\claude-code\<semver>\…\claude.exe 落位，semver 与 exe
// 之间至多垫一层目录：旧布局零层（真机取证 Claude-3p\claude-code\2.1.246\
// claude.exe），Desktop ≥2.37337 起垫一层构建哈希目录（真机取证 2.1.295\
// d2e29494ec83\claude.exe，连盘上残留的旧版目录也被重组为该形态），更深的
// 嵌套不在白名单形状内。根只认
// %LOCALAPPDATA%\Claude-3p、%LOCALAPPDATA%\Claude、%USERPROFILE%\.claude
// 三个，且锚定用户目录
// 布局：Claude-3p / Claude 必须在 …\Users\<用户>\AppData\Local\ 之下，.claude
// 必须在 …\Users\<用户>\ 正下——任意其他深度下同名的 claude 目录（用户手工
// 维护的同形副本，如 D:\tools\claude\claude-code\<semver>\claude.exe）不折。
// npm 全局 CLI 的下一段是 bin（…\node_modules\@anthropic-ai\claude-code\
// bin\claude.exe），天然不命中引擎形状，保持逐 PID 旧行为。命中返回
// "desktop"；无命令行或路径不在白名单一律返回 null——调用侧对 null 保持
// 旧行为：宁可漏折，不可误折。
const CLAUDE_DESKTOP_SHELL_PATH_RE = /[\\/]windowsapps[\\/]claude_\d/;
const CLAUDE_DESKTOP_ENGINE_PATH_RE = /[\\/]users[\\/][^\\/]+[\\/](?:appdata[\\/]local[\\/]claude(?:-3p)?|\.claude)[\\/]claude-code[\\/]\d+\.\d+\.\d+(?:[-+][0-9a-z.]+)?(?:[\\/][^\\/]+)?[\\/]claude\.exe(?:[\s"']|$)/;

export function claudeDesktopForm(commandLine) {
  if (typeof commandLine !== "string" || commandLine.length === 0) return null;
  const lower = commandLine.toLowerCase();
  if (CLAUDE_DESKTOP_SHELL_PATH_RE.test(lower)) return "desktop";
  if (CLAUDE_DESKTOP_ENGINE_PATH_RE.test(lower)) return "desktop";
  return null;
}

// 环境检测（environment-service）对本地版本无清单可读的原生 CLI
// （PROBE_VERSION_CLIENTS：qoder-cli、grok）探版本的方式是 spawn `<exe>
// --version`——进程秒退（qodercli 实测 0.32s）。扫描若照常认领会把它当活
// 客户端：占位实例行起行、processCount 1，看板卡翻「运行中/待命」一个扫描
// 窗口再回落（2026-10-24 取证：重启后页面重载触发首次检测，恰好撞上扫描
// 节奏，看板闪悬空 qoder 卡数秒）。只豁免无歧义形状——探针是唯一「参数
// 只有 --version、后面再无别的」的调用；真实会话不可能裸 --version 常驻
//（它打印即退），漏判不会掩盖会话，误判方向只会多算不漏算。
function isVersionProbeRow(commandLine) {
  if (typeof commandLine !== "string" || commandLine.length === 0) return false;
  // 可执行体 token：带引号路径取闭引号之后，裸 token 取首个空格之后；
  // 只看尾段。解析不出形状（引号残缺等）按非探针处理，宁可多算不漏算。
  const rest = commandLine.startsWith('"')
    ? commandLine.slice(commandLine.indexOf('"', 1) + 1)
    : commandLine.slice(commandLine.indexOf(" ") + 1);
  return rest.trim() === "--version";
}

// 命令行读不出的行。这不只发生在 tasklist 降级轮：进程正被系统收尾时，可信轮
// （带命令行的 CIM 行 dump）也会把 CommandLine 报成空。2026-10-26 实测：
// qodercli 探针 0.32s 的生命里最后一段正是这个状态——对探针进程高频采样 20 次，
// 12 次看到「先读到 --version、随后读空」，且空值只在收尾阶段出现。只看形状的
// isVersionProbeRow 认不出这种行，它于是落进「认不出即计数」的兜底，把一次环境
// 检测变成一张悬空卡（症状与 2026-10-24 那笔同形，只是触发面从重启扩到任何时候
// 的环境检测——启动面板、关于页重新检测、检查更新、更新收尾刷新都算）。
// 现场抓到的原始行：`<pid>,<ppid>,qodercli.exe,`（命令行字段为空）。
function isCommandLineUnreadable(commandLine) {
  return typeof commandLine !== "string" || commandLine.trim().length === 0;
}

// 读不出命令行的行凭什么还能算客户端：只认「连续性」——上一轮可信扫描已经把它
// 算进同一个桶的 pid。据此，两种行被分开处理：
//   · 探针（活不到下一次扫描，永远进不了上一轮集合）→ 不计数，不起占位行、
//     不翻卡。降级轮同此：整轮都没有命令行，探针照样不在集合里。
//   · 真会话被收尾窗口/降级轮撞上读空 → 它一直在集合里，照常计数，既不会因
//     读空被当轮删行（那会把卡闪灭一次），也不会漏掉这一轮的计数。
// 代价只有一档：真会话「第一次出现就读空」这种罕见组合要等下一轮（≤ 一个扫描
// 窗口）才被计数；漏判方向仍是少算一轮，不会掩盖会话。
function priorCountedIn(priorCounted, bucket, pid) {
  const set = priorCounted?.[bucket];
  return pid !== null && set instanceof Set && set.has(pid);
}

function parseTasklistCsv(stdout, priorCounted = null) {
  const result = createEmptyProcessScan();
  if (typeof stdout !== "string" || stdout.length === 0) return result;

  // pi 双计防护的工作区（写入见 pi 桶分支与 node 分支，裁决在循环后）：
  // nativePiPids 收原生 pi.exe 行的 pid；piNodeCandidates 收命中 isPiNode 的
  // node 行 pid。探测输出里行序不定（pi.exe 父行可能排在 node 子行之后），
  // 祖链裁决只能等 ppidByPid 收全后统一做。
  const nativePiPids = new Set();
  const piNodeCandidates = [];

  // 本轮的 kimi 家目录口径：isKimiNode 的家目录豁免（isUnderKimiCodeHome）
  // 用它按轮解析，KIMI_CODE_HOME 挪家后无需重启即可跟上。
  const kimiHomeLower = resolveKimiCodeHome().toLowerCase();

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
    // 本轮报上来的全部 pid，含下面所有分支都不认领的行（node.exe 启动器、cmd
    // 垫片、无关进程）：不完整轮只能靠它回答「这个 pid 还在不在」。
    if (pid !== null) result.seenPids.add(pid);

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
      // zcode so only main processes count as the endpoint process. The CLI's
      // qodercli.exe runs under the same bucket: its `--internal-sites-mcp`
      // child is an internal helper the main CLI spawns (observed live: same
      // image, no relay connection of its own) and is skipped the same way —
      // the lineage table still sees its parent pointer (every row feeds
      // ppidByPid), and the main CLI is what joins terminal sessions.
      // Bare `--version` rows are the environment page's version probe
      // (isVersionProbeRow), not a session — same skip. A row whose command line
      // could not be read at all counts only on continuity (priorCountedIn):
      // the probe's teardown window and the tasklist fallback both read empty,
      // and a process that was never counted before is not a session.
      if (commandLine?.includes("--type=") || commandLine?.includes("--internal-sites-mcp")
        || isVersionProbeRow(commandLine)
        || (isCommandLineUnreadable(commandLine) && !priorCountedIn(priorCounted, "qoder", pid))) {
        // helper child / version probe / unclassifiable row, skip
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
      // The managed app-server daemon is a different beast: spawned under
      // ~/.codex/packages/app-server-daemon on first use, then resident
      // forever (`codex.exe app-server ... --managed-daemon`, plus its
      // `codex.exe daemon pid-update-loop` sibling). It owns no session, so
      // counting it pins a permanent standby card while no Codex client is
      // actually running — skip it entirely. Per-session app-servers spawned
      // by the GUI carry neither marker and still count. Plain-tasklist rows
      // carry no command line and cannot be told apart on that fallback
      // round; they count, same accepted limit as the other endpoints.
      if ((image === "chatgpt.exe" || image === "codex.exe") && commandLine?.includes("--type=")) {
        // Electron helper child process, skip
      } else if (image === "codex.exe" && (commandLine?.includes("--managed-daemon") || commandLine?.includes("pid-update-loop"))) {
        // resident managed daemon, not a session: skip
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
        if (pid) result.zcodePids.add(pid);
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
        if (pid) {
          result.claudePids.add(pid);
          // 桌面形态标记（实例行折叠的唯一直接依据）：只认镜像路径白名单
          // 形状，认不出不标——未标的 pid 维持逐 PID 成行。
          if (claudeDesktopForm(commandLine) !== null) {
            result.claudeDesktopPids.add(pid);
            result.claudeSurfaceByPid.set(pid, "desktop");
          } else if (commandLine !== null) {
            // 读得到命令行、又不在桌面形状白名单里，才谈得上 CLI 形态：这是正证。
            // 回落 tasklist 那一轮根本没有命令行列，认不出不等于「那就是 CLI」——
            // 当时把这些 pid 一律标成 cli，会把一个桌面端的壳与子进程报成一排
            // CLI 会话（2026-10-05 报障）。读不到就留空，呈现侧按「读不出形态」
            // 处理：不贴徽标。
            result.claudeSurfaceByPid.set(pid, "cli");
          }
        }
      }
    } else if (bucket === "opencode") {
      // The interactive opencode.exe spawns a same-image child running
      // `opencode.exe serve --service`. Live forensics 2026-10-16 (netstat +
      // journal + agents payload) settled the division of labor: the serve
      // child is the process that holds the relay keep-alive connection and
      // issues ALL LLM traffic, while the interactive process owns the
      // terminal-side surfaces (session count, placeholder row, detected
      // feed, terminal join). Counting the child by image name alone put a
      // second instance card on the board; leaving its traffic on its own pid
      // instead put that traffic on a row nothing ever binds. The child stays
      // family (lineage / row liveness) and its socket-synthesized instance
      // id folds up to the interactive parent in resolveInstanceId, so the
      // account lands on the one row every consumer keys on. Plain tasklist
      // rows carry no command line and keep the accept-by-name behavior
      // (last fallback) — unclassifiable there, so no fold either.
      if (commandLine === null || !commandLine.includes("serve")) {
        result.opencode += 1;
      }
      // Family set (lineage / pid liveness) takes every same-image process,
      // helper child included: the interactive process can in principle exit
      // while its serve child lingers, and family-scoped row liveness must
      // not flash the card away mid-teardown.
      if (pid) result.opencodePids.add(pid);
      // Card status / placeholder rows / detected feed follow the interactive
      // processes only — the engine-subset mechanism already used by
      // codex/dsh/kimi.
      if (pid && (commandLine === null || !commandLine.includes("serve"))) {
        result.opencodeEnginePids.add(pid);
      }
      // The serve subset is the instance-id fold's gate (resolveInstanceId):
      // only a pid the scan positively classified as a serve child folds up,
      // never a fuzzy ancestor walk.
      if (pid && commandLine !== null && commandLine.includes("serve")) {
        result.opencodeServePids.add(pid);
      }
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
      // tasklist rows carry no command line: they count, but claim no host and
      // no surface (see the note below). Helper children feed the family pid
      // set only (lineage / liveness).
      //
      // 命令行列缺席的那一轮不得主张宿主/引擎/面（2026-10-07 报障：看板加载中间态副行
      // 报出「Desktop ×5」，一张卡还挂着空数据行）：「这是主进程还是 --type= 子进程」只有
      // 命令行能答，靠镜像名整批收进宿主集合就是把一个桌面端报成五次会话——那是误折，
      // 99e4d9c 立的「宁可漏折不可误折」正好禁止它。宿主与面由 carry 从可信轮供回（用例
      // 「降级轮里桌面端仍然只算一个会话宿主」），可信轮没见过的新进程等下一轮可信轮说话。
      // 进程数与家族 pid 照旧由本轮给（50a41fc 的边界不动）。
      if (commandLine?.includes("--type=")) {
        if (pid) result.kimiPids.add(pid);
      } else {
        result.kimi += 1;
        if (pid) {
          result.kimiPids.add(pid);
          if (commandLine !== null) {
            result.kimiEnginePids.add(pid);
            // 宿主集合：面级稳定行的折叠与存活判据，只收主进程。
            result.kimiDesktopPids.add(pid);
            result.kimiSurfaceByPid.set(pid, "desktop");
          }
        }
      }
    } else if (bucket === "dsh-desktop") {
      // `DeepSeek Harness.exe` (the official Electron package). Only the child
      // whose command line names the bundled host is a session: it is the
      // process that boots the `desktop` profile and talks to the relay. The
      // Electron shell itself is the app, not a session (its helper children
      // carry --type=), so neither joins the count — one desktop boot is one
      // DSH process, exactly like one terminal boot.
      if (isDshDesktopCommandLine(lower, image)) {
        result.dsh += 1;
        if (pid) {
          result.dshPids.add(pid);
          result.dshEnginePids.add(pid);
          // 宿主集合：稳定行折叠与存活判据的唯一依据。profile 图里 CLI 自建
          // 的 `--profile desktop` 同名，区分只在这条命令行谓词上。
          result.dshDesktopHostPids.add(pid);
          result.dshProfileByPid.set(pid, DSH_DESKTOP_PROFILE);
        }
      }
    } else if (bucket === "grok") {
      // Grok Build is a native binary (one grok.exe per terminal session,
      // kimi-style multi-instance) — no helper-image filtering applies, with
      // one exception: bare `--version` is the environment page's version
      // probe (grok is a PROBE_VERSION_CLIENT — isVersionProbeRow), not a
      // session. Unreadable rows follow the same continuity rule as qoder
      // (the probe's teardown window reads empty; see priorCountedIn).
      // Its bin dir also ships agent.exe / grove*.exe: deliberately
      // NOT bucketed (agent.exe is a generic name third-party software may
      // carry).
      if (isVersionProbeRow(commandLine)
        || (isCommandLineUnreadable(commandLine) && !priorCountedIn(priorCounted, "grok", pid))) {
        // version probe / unclassifiable row, skip
      } else {
        result.grok += 1;
        if (pid) result.grokPids.add(pid);
      }
    } else if (bucket === "pi") {
      // pi 原生形态：镜像名即会话进程，accept-by-name 直接计数（无命令列的
      // tasklist 降级轮同此，与其余端点的残差一致）。原生二进制的辅助子进程
      // 形状无本机取证，先不设过滤——宁可多算不漏算，等真形态落地再收。
      // 双计防护的数据面：原生启动器若拉起 node 跑包路径（「pi.exe 父＋node
      // 子」谱系），node 子行会同时命中 isPiNode——pid 先记入 nativePiPids，
      // 循环后的裁决把这类 node 行压掉，一个会话只算一次。
      result.pi += 1;
      if (pid) {
        result.piPids.add(pid);
        nativePiPids.add(pid);
      }
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
        if (pid) {
          result.claudePids.add(pid);
          // node.exe 跑的是 @anthropic-ai/claude-code 包：命令行读得出来，形态就
          // 是终端里敲的 CLI——同上面镜像名分支一样属正证，不留给呈现侧猜。
          result.claudeSurfaceByPid.set(pid, "cli");
        }
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
        // 计数裁决推迟到循环后（pi 双计防护）：node 行与 pi.exe 父行在探测
        // 输出里的先后不定，祖链压制要等 ppidByPid 收全。无 pi.exe 祖链时
        // 循环后照旧逐行计数，npm 形态行为不变。
        piNodeCandidates.push(pid);
      }
      // Same install-path rule as claude: `npm view @moonshot-ai/kimi-code`
      // style maintenance processes must not register as kimi instances.
      // 家目录之下的行先行豁免（isUnderKimiCodeHome）：桌面端孵化的插件
      // 帮手就住在那棵树下，token 碰撞的来龙去脉见该谓词的注释。
      const isKimiNode = !isUnderKimiCodeHome(lower, kimiHomeLower) && (
        lower.includes("kimi-code/") ||
        lower.includes("kimi-code\\") ||
        (lower.includes("dist\\main.mjs") && lower.includes("kimi")) ||
        (lower.includes("dist/main.mjs") && lower.includes("kimi"))
      );
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

  // pi 双计裁决：命中 isPiNode 的 node 行若祖链上有原生 pi.exe 行（原生启动
  // 器拉起 node 跑 @earendil-works 包；链上可能隔着 cmd /c 垫片——启动链穿
  // 垫片是本仓既有谱系形状），会话属 pi.exe、node 行不重复计数。ppidByPid
  // 在循环里已收全（每行入表先于分派），行序无关。走查与
  // findDescendantClientPid 同款：深度上限＋visited 防环/防脏指针。npm 形态
  // （祖链无 pi.exe）不受影响，逐行照旧计数。pid 解析失败的 node 行无法走
  // 查，维持既有「认出即计数」。
  for (const nodePid of piNodeCandidates) {
    let claimedByNativePi = false;
    if (nodePid !== null) {
      let current = nodePid;
      const seen = new Set([current]);
      for (let depth = 0; depth < INSTANCE_LINEAGE_MAX_DEPTH; depth += 1) {
        const parent = result.ppidByPid.get(current);
        if (parent === undefined || seen.has(parent)) break;
        if (nativePiPids.has(parent)) {
          claimedByNativePi = true;
          break;
        }
        seen.add(parent);
        current = parent;
      }
    }
    if (!claimedByNativePi) {
      result.pi += 1;
      if (nodePid !== null) result.piPids.add(nodePid);
    }
  }

  return result;
}

// 折线视窗（「折线画几个请求」）是进程级设置，不是某个态的私产：每个聚合态
// 出生时就带上当前设置。不带参数时取默认值，只为兼容「设置还没读进来」的
// 构造时机；实例行与端点卡必须同窗，否则同一份历史会按两套窗口画。
function createAggregateState(sparkWindowPoints = DEFAULT_SPARK_WINDOW_POINTS) {
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
    // 与 lastModel/lastViaAuto 配对的链身份：端点链 = 端点 id，虚拟模型链 = 模型名。
    // 面板靠它把胶囊定位到「哪条链的第几跳」；同一（渠道,模型）可出现在多条链里，
    // 只按配对查会找错链。
    currentChainKey: null,
    lastChainKey: null,
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
    sparkWindowPoints: parseSparkWindowPoints(sparkWindowPoints),
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
    lastChainKey: state.lastChainKey,
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
  state.lastChainKey = typeof raw.lastChainKey === "string" ? raw.lastChainKey : null;
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

function trackAggregateRequest(state, meta, nowFn, recentSampleWindow, stability, journal, agentId, onTransition = null) {
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
  // onTransition fires only at busy-idle boundaries (0→N on this start, N→0 in
  // recordEnd); the activity publisher fans it out as an absolute-state frame.
  const crossedIdleToActive = state.activeRequests === 0;
  if (crossedIdleToActive) state.activeWallStart = startTime;
  state.activeRequests += 1;
  if (crossedIdleToActive) onTransition?.(state.activeRequests);
  state.totalRequests += 1;
  if (state.firstRequestAt === null) state.firstRequestAt = startTime;
  state.lastRequestAt = startTime;
  // activeTargets 记账：一条请求在（渠道,模型）组合上进/出各一次。viaAuto 由调用方
  // 给出——只有链计划解析出的成员归因才是 true（服务归因语义），直连/池请求恒 false。
  // chainKey 与 viaAuto 同源（成员归因给出）：它记录这条服务来自哪条链，面板据此
  // 把徽标定位到该链里的跳位。键仍是（渠道,模型），chainKey 只作为携带字段。
  const bookTarget = (providerId, model, viaAuto, chainKey, delta) => {
    const key = `${providerId ?? ""}\u0000${model}`;
    const entry = state.activeTargets.get(key);
    if (delta > 0) {
      if (entry) {
        entry.count += 1;
        if (viaAuto) entry.autoCount += 1;
        // 同一（渠道,模型）被两条链同时服务时无法判定位次：保留 null（面板只挂
        // auto 标、不报位次），而不是让后到的链覆盖前者、报一个可能错的跳位。
        if (chainKey && entry.chainKey !== chainKey) entry.chainKey = null;
        else if (chainKey) entry.chainKey = chainKey;
      } else {
        state.activeTargets.set(key, {
          providerId: providerId ?? null,
          model,
          count: 1,
          autoCount: viaAuto ? 1 : 0,
          chainKey: chainKey ?? null,
        });
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
    bookTarget(meta.providerId, meta.model, false, null, +1);
    state.currentViaAuto = false;
    state.lastViaAuto = false;
    state.currentChainKey = null;
    state.lastChainKey = null;
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
  // displayChainKey：与 displayModel/displayViaAuto 同源的链身份（端点 id / 虚拟
  // 模型名）。直连请求恒 null；链服务请求随成员宣布一起更新。
  let displayChainKey = null;
  const setDisplayModel = (model, providerId, viaAuto, chainKey) => {
    if (typeof model !== "string" || !model) return;
    const nextProvider = typeof providerId === "string" && providerId ? providerId : null;
    const nextChainKey = viaAuto && typeof chainKey === "string" && chainKey ? chainKey : null;
    if (model === displayModel && nextProvider === displayProvider && viaAuto === displayViaAuto
      && nextChainKey === displayChainKey) return;
    if (displayModel !== null) {
      // 同名同渠道才动模型名计数；跨渠道同名（A/a→B/a）只换 activeTargets 的键。
      if (model !== displayModel) {
        const prev = state.activeModels.get(displayModel) || 0;
        if (prev <= 1) state.activeModels.delete(displayModel);
        else state.activeModels.set(displayModel, prev - 1);
        state.activeModels.set(model, (state.activeModels.get(model) || 0) + 1);
      }
      bookTarget(displayProvider, displayModel, displayViaAuto, displayChainKey, -1);
      bookTarget(nextProvider, model, viaAuto, nextChainKey, +1);
    } else {
      state.activeModels.set(model, (state.activeModels.get(model) || 0) + 1);
      bookTarget(nextProvider, model, viaAuto, nextChainKey, +1);
    }
    displayModel = model;
    displayProvider = nextProvider;
    displayViaAuto = viaAuto;
    displayChainKey = nextChainKey;
    state.currentModel = model;
    state.lastModel = model;
    state.currentProvider = nextProvider;
    state.lastProvider = nextProvider;
    state.currentViaAuto = viaAuto;
    state.lastViaAuto = viaAuto;
    state.currentChainKey = nextChainKey;
    state.lastChainKey = nextChainKey;
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
    // memberId -> { providerId, model, chainKey } resolver. Both are no-ops
    // elsewhere.
    setCurrentMember: (memberId) => {
      currentMemberId = typeof memberId === "string" && memberId.length > 0 ? memberId : null;
      // Re-point the display model at the announced member's bound model so
      // the panel badges show the real serving model during flight. The
      // resolver's presence IS the chain provenance — only chain plans install
      // one — so an announcement that resolves here books the composite target
      // with viaAuto (服务归因语义：auto 角标跟徽章条目自身走，不读链位置快照).
      // chainKey rides along so the panel can find the hop in the chain that
      // actually served it (endpoint chain vs virtual model chain).
      const attr = resolvedAttributeFor(currentMemberId);
      if (attr?.model) setDisplayModel(attr.model, attr.providerId, true, attr.chainKey);
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
        const { prompt, cached } = normalizeUsageTokens(usage);
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
      if (state.activeRequests === 0) onTransition?.(0);
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
        bookTarget(displayProvider, displayModel, displayViaAuto, displayChainKey, -1);
      }
      if (state.activeRequests === 0) {
        state.currentModel = null;
        state.currentProvider = null;
        state.activeModels.clear();
        state.activeTargets.clear();
        state.currentViaAuto = null;
        state.currentChainKey = null;
      } else if (state.activeModels.size > 0) {
        // If other models still generating, currentModel is latest or combined
        state.currentModel = Array.from(state.activeModels.keys()).join(" + ");
        // 多条请求并存时「当前模型的链身份」不再唯一，与拼接后的 currentModel 配对
        // 只会给出错的位次；最近身份（lastChainKey）不受影响。
        state.currentChainKey = null;
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
        const { prompt, completion, cached } = normalizeUsageTokens(usage);

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
        const { prompt, cached } = normalizeUsageTokens(usage);
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
          const status = Number(info.error?.status ?? info.status) || null;
          const { prompt, completion, cached } = normalizeUsageTokens(usage);
          journal.appendRequest({
            ts: endTime,
            agentId,
            providerId: attr?.providerId || meta.providerId || memberId || state.lastProvider || "",
            model: attr?.model || meta.model || state.lastModel || null,
            prompt,
            completion,
            cached,
            ttftMs: hadError ? null : journalTtftMs,
            durationMs: reqDuration,
            ok: !hadError,
            status,
            errKind: hadError
              ? classifyErrKind({ status, message: info.error?.message })
              : null,
            // 上游真实错误文本，仅失败行携带（成功行不带键，行形状不变）；
            // 消毒（折叠空白/截 200）由 journal 写侧统一做。
            ...(hadError ? { errMsg: info.error?.message ?? null } : {}),
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
// chainKey 与 autoCount 同源（只有链服务请求才带）：面板据此把徽标定位到
// 「哪条链的第几跳」，同一（渠道,模型）出现在多条链里时也不会找错链。
// 直连条目（以及旧 relay 的口径）没有这个字段，面板按「链身份未知」处理。
function activeTargetList(state) {
  if (state.activeRequests <= 0) return [];
  return Array.from(state.activeTargets.values()).map((t) => {
    const entry = {
      providerId: t.providerId,
      model: t.model,
      count: t.count,
      autoCount: t.autoCount,
    };
    if (t.chainKey) entry.chainKey = t.chainKey;
    return entry;
  });
}

// Authoritative spark history for one aggregate state: one point per measured
// request, from the very samples the card's numbers are computed over. Shared by
// the endpoint cards and by the claude session rows mirrored off the resident
// relay, so a curve is always the same population as the figure beside it.
function sparkHistoryForState(state) {
  const sparkLimit = parseSparkWindowPoints(state.sparkWindowPoints);
  return {
    ttft: state.ttftHistory.slice(-sparkLimit).map((ms) => Number((ms / 1000).toFixed(2))),
    tps: state.recentSamples.map(sampleTps).filter((v) => v !== null).slice(-sparkLimit),
    cache: state.recentSamples.map((s) => {
      if (s.prompt > 0) return Number(((s.cached / s.prompt) * 100).toFixed(1));
      return 0;
    }).slice(-sparkLimit),
  };
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
      currentChainKey: state.currentChainKey ?? null,
      lastChainKey: state.lastChainKey ?? null,
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

  const sparkHistory = sparkHistoryForState(state);

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
    currentChainKey: state.currentChainKey ?? null,
    lastChainKey: state.lastChainKey ?? null,
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
// rows followed by a unique end-marker line. Queries are NOT equal: the process
// scan is what a round is FOR, the DSH console recheck riding the same child is
// optional extra work. A timeout is therefore penalised per kind —
//   · scan timeout  → the data is untrustworthy: drop the child, fall back to
//     tasklist for this round (unchanged behaviour).
//   · optional timeout → give up this round's recheck only. The child just
//     answered the scan, so killing it converts an optional miss into a cold
//     respawn on the next round (measured on this machine: cold round 556ms vs
//     warm 160ms) and the recheck then re-compiles its P/Invoke helper in the
//     fresh child (measured 188ms) — murder is self-sustaining, so the penalty
//     is deferred until the same child has failed the optional query twice.
// An idle child is still killed after PS_PROBE_IDLE_MS so a hidden panel leaves
// zero resident processes behind. Children are unref'd (they never keep the
// host process alive) and are killed from one shared process-exit hook.
// ---------------------------------------------------------------------------
export const PS_PROBE_TIMEOUT_MS = 3000;
export const PS_PROBE_OPTIONAL_TIMEOUT_MS = 1200;
// 同一只子进程被放弃几次可选查询之后就认定它卡住了。1 次太松（真卡死的会一直占着
// 序列），3 次以上就把可选工作的代价重新堆回整轮。
const PS_PROBE_OPTIONAL_KILL_LIMIT = 2;
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
// the lineage table — no counting branch claims them. powershell.exe /
// pwsh.exe join for the same reason on the other side of the chain: the
// virtual terminal's shell IS a powershell.exe process, so attributing a
// terminal session to an agent client (shell pid → client pid) walks the
// lineage table through the shell row. They too feed only the lineage table.
const PS_PROCESS_SCAN_QUERY =
  "Get-CimInstance Win32_Process -Filter \"name='node.exe' or name='claude.exe' or name='ZCode.exe' or name='dsh.exe' or name='pi.exe' or name='opencode.exe' or name='Qoder.exe' or name='qodercli.exe' or name='codex.exe' or name='codex-code-mode-host.exe' or name='codex-command-runner.exe' or name='ChatGPT.exe' or name='grok.exe' or name='Kimi Code.exe' or name='DeepSeek Harness.exe' or name='cmd.exe' or name='powershell.exe' or name='pwsh.exe'\" | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId),$($_.Name),$($_.CommandLine)\" }";

const livePsProbeChildren = new Set();
let psProbeExitHookInstalled = false;

function createPersistentPsProbe({
  spawnFn,
  queryText,
  timeoutMs = PS_PROBE_TIMEOUT_MS,
  optionalTimeoutMs = PS_PROBE_OPTIONAL_TIMEOUT_MS,
}) {
  let child = null;
  let stdoutBuf = "";
  let pending = null; // { marker, resolve, reject, timer, optional }
  let querySeq = 0;
  let idleTimer = null;
  // 被放弃那条查询的标记。REPL 单线程按行读-执-印，所以它日后若回话，一定排在后续
  // 查询的答案之前——不整段切掉丢掉，下一轮就会把上一轮的字节当本轮进程行读。
  let staleMarkers = [];
  let optionalTimeoutsOnChild = 0;

  // 探针自己的账。这条链以前完全静默：两处调用点各自 `.catch(() => null)` 把超时
  // 错误吞掉，既不计数也不落日志，于是「降级轮为什么概率出现」在机器上不留凭据，
  // 报障只能靠用户截图。这组数字只进日志，不进界面。
  const stats = {
    spawns: 0,
    scanTimeouts: 0,
    optionalTimeouts: 0,
    childKills: 0,
    lateAnswersDiscarded: 0,
    consecutiveTimeouts: 0,
  };

  function logPenalty() {
    // 连续超时才有报道价值：单次抖动是常态。一条连胜链只在第 2 次时落一行
    // （计数继续走，日志不刷屏）；链断开重起时会再报一次。
    if (stats.consecutiveTimeouts === 2) {
      console.warn(`[agent-metrics] ps probe wedged: ${stats.consecutiveTimeouts} timeouts in a row `
        + `(scan=${stats.scanTimeouts} optional=${stats.optionalTimeouts} childKills=${stats.childKills} spawns=${stats.spawns})`);
    }
  }

  const dropChild = (err) => {
    const c = child;
    child = null;
    stdoutBuf = "";
    staleMarkers = [];
    optionalTimeoutsOnChild = 0;
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
    stats.spawns += 1;
    optionalTimeoutsOnChild = 0;
    staleMarkers = [];
    const c = spawnFn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_REPL_COMMAND], { windowsHide: true });
    stdoutBuf = "";
    c.stdout.setEncoding("utf8");
    c.stderr.resume(); // drain so the pipe never back-pressures; content is noise
    c.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      if (pending === null) return;
      const markerIdx = stdoutBuf.indexOf(pending.marker);
      if (markerIdx === -1) return;
      let out = stdoutBuf.slice(0, markerIdx);
      stdoutBuf = stdoutBuf.slice(markerIdx + pending.marker.length);
      // 迟到段整段丢掉：被放弃的查询若日后回话，它的字节（含它自己那枚标记）排在
      // 本轮答案之前，留着就会被 parseTasklistCsv 当本轮进程行计数。
      let cut = 0;
      const consumed = [];
      for (const stale of staleMarkers) {
        const at = out.indexOf(stale, cut);
        if (at === -1) continue;
        cut = at + stale.length;
        consumed.push(stale);
      }
      if (cut > 0) {
        out = out.slice(cut);
        stats.lateAnswersDiscarded += consumed.length;
        staleMarkers = staleMarkers.filter((stale) => !consumed.includes(stale));
      }
      const p = pending;
      pending = null;
      clearTimeout(p.timer);
      stats.consecutiveTimeouts = 0;
      if (p.optional) optionalTimeoutsOnChild = 0;
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
    // `optional: true` marks work a round can afford to skip: it gets the short
    // budget and, on its first miss, costs only itself.
    query(text, { optional = false } = {}) {
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
          optional,
          timer: setTimeout(() => {
            const p = pending;
            pending = null;
            clearTimeout(p.timer);
            stats.consecutiveTimeouts += 1;
            if (!p.optional) {
              // 必需查询：这一轮的数据不可信，判罚照旧（换子进程 + 调用方回落
              // tasklist）。放宽它就是把「没看见」当「不在」，那条口径不动。
              stats.scanTimeouts += 1;
              stats.childKills += 1;
              logPenalty();
              p.reject(new Error("ps probe query timeout"));
              dropChild(new Error("ps probe query timeout"));
              return;
            }
            stats.optionalTimeouts += 1;
            optionalTimeoutsOnChild += 1;
            staleMarkers.push(marker);
            if (staleMarkers.length > 8) staleMarkers.shift();
            p.reject(new Error("ps probe optional query timeout"));
            logPenalty();
            if (optionalTimeoutsOnChild >= PS_PROBE_OPTIONAL_KILL_LIMIT) {
              stats.childKills += 1;
              dropChild(new Error("ps probe optional query wedged twice"));
            }
          }, optional ? optionalTimeoutMs : timeoutMs),
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
    stats,
  };
}

export function createAgentMetricsCollector(options = {}) {
  const execFn = options.execFn ?? exec;
  const nowFn = options.nowFn ?? Date.now;
  const psProbe = createPersistentPsProbe({
    spawnFn: options.spawnFn ?? spawn,
    queryText: PS_PROCESS_SCAN_QUERY,
    timeoutMs: options.psProbeTimeoutMs ?? PS_PROBE_TIMEOUT_MS,
    optionalTimeoutMs: options.psProbeOptionalTimeoutMs ?? PS_PROBE_OPTIONAL_TIMEOUT_MS,
  });
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

  // In-flight activity push surface: subscribers receive one absolute-state
  // frame per 0↔N transition of an endpoint aggregate or an instance mirror
  // (never for 1→2-style intra-busy deltas). Fan-out is synchronous and each
  // listener is isolated — a throwing subscriber must never break the request
  // path it just observed.
  const activityListeners = new Set();
  function publishActivity(endpointId, instanceId, activeRequests) {
    const frame = { type: "activity", endpointId, instanceId, activeRequests, at: Date.now() };
    for (const listener of activityListeners) {
      try {
        listener(frame);
      } catch {
        // Subscriber bug: drop the frame, never the request.
      }
    }
  }
  function onActivity(listener) {
    if (typeof listener !== "function") return () => {};
    activityListeners.add(listener);
    return () => activityListeners.delete(listener);
  }
  function offActivity(listener) {
    activityListeners.delete(listener);
  }

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
  // 缓存窗口默认 2500ms；调用方可以按自己的用途放宽——看门狗只要「有没有 agent
  // 活着」这种粗判，它每 3s 一拍、每拍都读，窗口比拍节短就等于每拍强制重扫一次
  // 常驻 CIM 行 dump（并发路数是这条链超时的燃料，见 createPersistentPsProbe 上方）。
  const PROCESS_SCAN_TTL_MS = options.processScanTtlMs ?? 2500;
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
    const out = await psProbe.query(query, { optional: true }).catch(() => null);
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
      counts.dshDesktopHostPids?.delete(pid);
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

  // 降级轮的分类延续（2026-10-05 报障：只开一个 Claude Desktop，claude 卡上却
  // 出现十几个带 CLI 徽标的实例行）。回落 tasklist 的那一轮读不到命令行，而
  // 「这个进程是什么形态」「它是谁的子进程」「哪个进程算会话宿主」三件事全都
  // 只有命令行能给答案——于是桌面端被拆成逐进程行、kimi 的桌面子进程被当成会话
  // 宿主、终端会话的父子链路折不回主进程行。
  //
  // 延续的范围只在「分型与归属」：本轮真看到的进程号、进程数、存活判定一概用
  // 本轮自己的数据，所以「不可信轮的零进程是没看见，不是不在」这条既有口径不
  // 受影响。分型的取法：可信轮认过的进程号沿用可信轮的值；可信轮没认过的（盲
  // 轮期间刚起的新进程）保持「读不出」——不贴徽标、不折叠，宁可漏折不可误折。
  // 时窗是给 PID 复用的兜底：超过窗口的旧分型不再沿用，免得把窗口结束后起来的
  // 真 CLI 并进桌面那一行。
  const TRUSTED_FORM_CARRY_MS = 30_000;
  const CARRIED_FORM_KEYS = [
    ["claudeSurfaceByPid", "map"],
    ["claudeDesktopPids", "set"],
    ["kimiSurfaceByPid", "map"],
    ["kimiEnginePids", "set"],
    ["kimiDesktopPids", "set"],
    ["dshProfileByPid", "map"],
    ["dshDesktopHostPids", "set"],
    ["ppidByPid", "map"],
  ];
  let lastTrustedScan = null;
  let lastTrustedScanTime = 0;

  // 上一轮可信扫描里两个探针端点各自的家族集，喂给本轮的「读不出命令行按连续性
  // 判定」（priorCountedIn）。只读不搬：命中的 pid 是本轮真看见的进程号，集合仅
  // 用来回答「这个进程以前算不算这个端点的客户端」。可信轮与降级轮共用同一份
  // 来源——降级轮整轮没有命令行，正好靠它把探针挡在门外、把真会话留在门内。
  // 首轮（还没有可信快照）时为空：这一轮读不出命令行的行一律不计数，宁可少算
  // 一轮，也不能把一次环境检测变成一张悬空卡。
  const priorCountedPids = () => (lastTrustedScan === null
    ? null
    : { qoder: lastTrustedScan.qoderPids ?? null, grok: lastTrustedScan.grokPids ?? null });

  // 把可信轮的一份归属并进降级轮：先收本轮还活着的可信值，再补上可信轮根本没
  // 枚举过的进程号的本轮答案（后者通常为空——命令行读不出就没有归属可言）。
  function mergeCarriedForm(trusted, blind, trustedSaw, alive) {
    const isMap = trusted instanceof Map;
    if (isMap !== (blind instanceof Map) || !(trustedSaw instanceof Set) || !(alive instanceof Set)) {
      return blind;
    }
    const merged = isMap ? new Map() : new Set();
    for (const key of (isMap ? blind.keys() : blind)) {
      if (!trustedSaw.has(key) && alive.has(key)) {
        if (isMap) merged.set(key, blind.get(key)); else merged.add(key);
      }
    }
    for (const [key, value] of (isMap ? trusted : [...trusted].map((pid) => [pid, pid]))) {
      if (alive.has(key)) {
        if (isMap) merged.set(key, value); else merged.add(key);
      }
    }
    return merged;
  }

  function carryTrustedForm(blind) {
    if (lastTrustedScan === null || nowFn() - lastTrustedScanTime > TRUSTED_FORM_CARRY_MS) return;
    // 本轮的全量进程号是唯一判据：可信轮没见过、本轮也没列出的进程一律不再出现。
    if (!(blind.seenPids instanceof Set)) return;
    for (const [key, kind] of CARRIED_FORM_KEYS) {
      const trusted = lastTrustedScan[key];
      if (!(kind === "map" ? trusted instanceof Map : trusted instanceof Set)) continue;
      blind[key] = mergeCarriedForm(trusted, blind[key] ?? (kind === "map" ? new Map() : new Set()), lastTrustedScan.seenPids, blind.seenPids);
    }
  }

  function startProcessScan() {
    pendingScanPromise = (async () => {
      const land = (counts) => {
        if (counts.countsAuthoritative === true) {
          lastTrustedScan = counts;
          lastTrustedScanTime = nowFn();
          // 判决先于刷新：判决要读的是「还原进来的旧锚」，刷新会把锚改写成
          // 本轮扫描——顺序反了就永远比不出「旧 run 是否还活着」。
          resolvePendingRunVerdicts(counts);
          refreshRunAnchors(counts);
        }
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
        const counts = parseTasklistCsv(psOut, priorCountedPids());
        // 常驻探针这一路带命令行与父进程列，是唯一能认全 node 型客户端的
        // 扫描形状——桶内计数可信（见 createEmptyProcessScan 上方）。
        counts.countsAuthoritative = true;
        // 折叠在落地前：同步纯计算不占探针预算，首读与 lastTrustedScan 拿到的
        // 都是折过的形态（降级轮的形态延续也就自带折叠结果）。
        foldDshDelegatingHosts(counts);
        // 先落地，再跑本轮的附加工作。读路径的判据是「本轮进程事实到手」，不是
        // 「这条子进程今天所有事都办完」：可选复查曾排在 land 之前，于是一条慢复查
        // 会把已经拿到手的数据一起扣住（本机实测：扫描 20ms 答完、整轮 3032ms 才
        // 落地），而面板给 relay 的拉取预算只有 1500ms。
        land(counts);
        // 附加工作仍在本轮 Promise 里 await 到底，不许改成 fire-and-forget：探针只有
        // 一个在飞槽位，复查还在飞时放下一轮扫描进去会被「already in flight」直接
        // 拒掉，整轮白降到 tasklist——那比多等一会儿糟得多。
        // reap 就地修正已落地的同一份快照，所以下一次读仍能看到被回收的会话，
        // 语义与改前一致（只是不再挡住第一次读）。
        await reapDshTerminalOrphans(counts);
        await attachKimiSurfaces(counts);
        return cachedProcessCounts;
      }

      // 2. Ultimate fallback: standard tasklist CSV. No parent column on
      // this path — the lineage table stays empty and ancestor-based
      // instance-id normalization degrades to a no-op (ids pass through).
      await new Promise((resolve) => {
        execFn('tasklist /NH /FO CSV', { timeout: 3000, windowsHide: true }, async (err, stdout) => {
          if (!err && typeof stdout === "string") {
            const counts = parseTasklistCsv(stdout, priorCountedPids());
            // 这半张视图认不出 node 型客户端：报了行的轮次其桶内计数不可信
            // （见 createEmptyProcessScan 上方）；零行则没有可误判归属的行，
            // 沿用「端点已关闭」这一既有语义。
            counts.countsAuthoritative = counts.seenPids.size === 0;
            // 只有真读不到命令行的轮次才需要延续；零行的可信轮不需要（也没有
            // 任何进程号可挂）。放在 kimi 注册表提级之前：注册表能把沿用下来的
            // 终端那一档照样提成 web。
            if (counts.countsAuthoritative === false) carryTrustedForm(counts);
            // 降级轮里形态延续带下来的 ppid 表若仍在，折叠照样成立；读不到
            // 父子表的轮次它在函数头部就空转（引擎集只剩镜像行时同样空转）。
            foldDshDelegatingHosts(counts);
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

  // Terminal-session attribution surface: the live agent client processes the
  // latest scan enumerated, each carrying its ancestor chain walked up the
  // lineage table. The panel joins this list against terminal-host sessions
  // by shell pid — a virtual-terminal session's shell IS a powershell/pwsh
  // process, so the chain from a client to its shell crosses exactly the rows
  // the probe scans. Engine-subset scoping mirrors normalizeInstanceId
  // (codex/dsh/kimi fold against their engine sets, everyone else against the
  // bucket set), so GUI shells and launcher wrappers never surface here.
  // Served from the cached scan (≤ scan TTL old); an empty lineage table
  // (tasklist fallback path) yields empty ancestor lists — the panel then
  // cannot attribute and sessions stay plain shells.
  const DETECTED_CLIENT_ENDPOINTS = ["codex", "dsh", "kimi", "claude", "opencode", "grok", "pi", "qoder"];

  function getDetectedClientProcesses() {
    const counts = cachedProcessCounts ?? createEmptyProcessScan();
    const out = [];
    for (const agentId of DETECTED_CLIENT_ENDPOINTS) {
      const pids = counts[`${agentId}EnginePids`] ?? counts[`${agentId}Pids`];
      if (!(pids instanceof Set) || pids.size === 0) continue;
      for (const pid of pids) {
        const ancestors = [];
        let current = pid;
        const seen = new Set([current]);
        for (let depth = 0; depth < INSTANCE_LINEAGE_MAX_DEPTH; depth++) {
          const parent = counts.ppidByPid?.get(current);
          if (parent === undefined || seen.has(parent)) break;
          ancestors.push(parent);
          seen.add(parent);
          current = parent;
        }
        out.push({ agentId, pid, ancestors });
      }
    }
    return out;
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

  // Session-metadata lookup for session-granular rows (codex-sess- /
  // opencode-sess-): row titles and the terminal join both read it. The default
  // walks the endpoint's own store through session-scan's adapter — far too
  // heavy for the panel's 1s poll, so the result is cached per endpoint and the
  // import is lazy (launchers and the watchdog import this module too; they
  // never list session rows and must not pay session-scan's sqlite/zlib imports
  // for nothing). Tests inject codexSessionLookup / opencodeSessionLookup.
  const sessionLookups = {
    codex: options.codexSessionLookup ?? null,
    opencode: options.opencodeSessionLookup ?? null,
  };
  const SESSION_LOOKUP_TTL_MS = 15000;
  const sessionInfoCache = new Map(); // agentId -> { at, byId }

  async function loadSessionInfo(agentId) {
    const now = nowFn();
    const cached = sessionInfoCache.get(agentId);
    if (cached !== undefined && now - cached.at < SESSION_LOOKUP_TTL_MS) return cached.byId;
    const injected = sessionLookups[agentId] ?? null;
    let sessions = [];
    try {
      sessions = injected !== null
        ? await injected()
        : await (await import("./session-scan.mjs")).defaultScanner.adapters.get(agentId).scan();
    } catch {
      sessions = []; // a scan failure must never break the status read
    }
    const byId = new Map();
    for (const meta of Array.isArray(sessions) ? sessions : []) {
      if (meta && typeof meta.id === "string") byId.set(meta.id, meta);
    }
    sessionInfoCache.set(agentId, { at: now, byId });
    return byId;
  }

  // Terminal-join feed for the session-granular instance identities. The
  // pid-shaped join in terminal-attribution can never bind them (their rows are
  // <agent>-sess-<id>, and the process behind the traffic is shared across
  // sessions — process granularity does not hold), so the panel bridge matches
  // terminal sessions to scanned sessions by cwd. These getters serve the same
  // 15s cache the row titles use; the exposure layer (openai-server's
  // detected-processes handler) shapes raw session ids into the row-id form so
  // the join never re-derives it. A scan failure yields an empty list — the
  // bridge degrades to unbound sessions.
  async function getCodexSessionsForTerminalJoin() {
    return [...(await loadSessionInfo("codex")).values()];
  }

  async function getOpencodeSessionsForTerminalJoin() {
    return [...(await loadSessionInfo("opencode")).values()];
  }

  // Aggregate metrics state
  const zcodeState = createAggregateState(sparkWindowPoints);
  const dshState = createAggregateState(sparkWindowPoints);
  const piState = createAggregateState(sparkWindowPoints);
  const kimiState = createAggregateState(sparkWindowPoints);
  const qoderState = createAggregateState(sparkWindowPoints);
  const opencodeState = createAggregateState(sparkWindowPoints);
  const claudeState = createAggregateState(sparkWindowPoints);
  const codexState = createAggregateState(sparkWindowPoints);
  const grokState = createAggregateState(sparkWindowPoints);
  const bucketAggregateState = { dsh: dshState, kimi: kimiState, opencode: opencodeState, pi: piState, codex: codexState, grok: grokState, qoder: qoderState, claude: claudeState };

  // 桌面稳定行的账目代际与生死结算（折叠路径与读取家务共用，所以挂工厂层，
  // 能同时够到 cachedProcessCounts / nowFn / 聚合桶）。语义细节见各函数注释。
  // 在途请求的属主行被收走/重开时，它在端点聚合里占的那份在途计数要就地
  // 结算（与 settleAbandonedAggregateState 同一处境）：行自己的计数随行消亡，
  // 聚合侧不能凭空多出永远收不了的 in-flight。
  function settleLeakedInstanceRequests(bucket, state, at) {
    const leaked = state.activeRequests;
    if (leaked <= 0) return;
    const agg = bucketAggregateState[bucket];
    agg.activeRequests = Math.max(0, agg.activeRequests - leaked);
    if (agg.activeRequests === 0 && agg.activeWallStart !== null) {
      agg.activeWallClockMs += Math.max(1, at - agg.activeWallStart);
      agg.activeWallStart = null;
      agg.currentModel = null;
      agg.currentProvider = null;
      agg.activeModels.clear();
    }
  }
  // 重开账：真重启（DSH 换壳、kimi 旧主全灭后来新主）在稳定行上就地清零
  // 请求数/token/工时/折线，行 id 与标签不动。旧账的在途请求按上面的规矩
  // 结算进端点聚合。代际锚替换为新宿主（dsh 连同新壳）。
  function reopenDesktopAccount(bucket, entry, clientPid, parentPid) {
    settleLeakedInstanceRequests(bucket, entry.state, nowFn());
    entry.state = createAggregateState(sparkWindowPoints);
    entry.firstSeen = nowFn();
    entry.desktopGen = {
      hostPids: new Set([clientPid]),
      shellPids: parentPid != null ? new Set([parentPid]) : new Set(),
    };
    markMetricsDirty();
  }
  // 账目代际结算：一个确认活着的桌面宿主/主进程 pid 要落进稳定行时，先判
  // 它和行上现有账目是否同一代。
  // kimi：行上记过的主进程还有活口（共存换代，journal 实证的唯一非重启换
  // 代形状）就续账；全灭 = App 真死过，重开账。
  // DSH：折叠 pid 的父进程（ppidByPid）还是行上记过的 Electron 壳 = 同一次
  // App 运行内的引擎换代，续账（任意长的换代空档都不断账）；壳换了且旧壳
  // 全灭 = 真重启，重开账。父指针缺席（降级形状没有命令行列）仲裁不了，
  // 保守续账——宁可少清一次，不可误清活跃账。
  // 行上还没有锚（占位行/旧快照行）时只收编不重开：空账没有可清的东西。
  // 扫描看不见 pid 生死（seenPids 缺席）时同样保守续账。
  function settleDesktopGenerationOnFold(bucket, entry, clientPid, procCounts) {
    if (clientPid == null) return;
    const gen = ensureDesktopGen(entry);
    if (gen.hostPids.has(clientPid)) return;
    const seen = procCounts?.seenPids instanceof Set ? procCounts.seenPids : null;
    if (bucket === "kimi") {
      if (gen.hostPids.size > 0 && seen !== null) {
        const oldAlive = [...gen.hostPids].some((pid) => seen.has(pid));
        if (!oldAlive) {
          reopenDesktopAccount(bucket, entry, clientPid, null);
          return;
        }
      }
      gen.hostPids.add(clientPid);
      return;
    }
    const parent = procCounts?.ppidByPid instanceof Map ? procCounts.ppidByPid.get(clientPid) : undefined;
    if (parent != null && gen.shellPids.has(parent)) {
      gen.hostPids.add(clientPid);
      return;
    }
    if (gen.shellPids.size > 0 && seen !== null) {
      const shellAlive = [...gen.shellPids].some((pid) => seen.has(pid));
      if (!shellAlive) {
        reopenDesktopAccount(bucket, entry, clientPid, parent);
        return;
      }
    }
    gen.hostPids.add(clientPid);
    if (parent != null) gen.shellPids.add(parent);
  }
  // 读取时的同款结算：把本轮扫描里的每个宿主 pid 都过一遍折叠判据。这是
  // 隐藏期桥接的收敛路径——App 在无人观看时重启，折叠时缓存跟不上，请求落
  // 在原始 pid 行；面板回来后的第一轮读在这里把旧账收口、按新代呈现。
  function settleDesktopGenerationOnRead(bucket, entry, procCounts) {
    const hosts = bucket === "dsh" ? procCounts.dshDesktopHostPids : procCounts.kimiDesktopPids;
    if (!(hosts instanceof Set)) return;
    for (const pid of hosts) {
      if (ensureDesktopGen(entry).hostPids.has(pid)) continue;
      settleDesktopGenerationOnFold(bucket, entry, pid, procCounts);
    }
  }
  // 行可见性 = 面的进程家族还在：kimi 看主进程集合，DSH 看宿主集合或 Electron
  // 壳（引擎换代的任意长空档里壳都活着，座席不该消失）。降级轮不进这条判据
  // （调用侧 countsTrusted 门），与逐 pid 行「旧形状不淘汰」同一保守守卫。
  function isDesktopFamilyAlive(bucket, entry, procCounts) {
    const hosts = bucket === "dsh" ? procCounts.dshDesktopHostPids : procCounts.kimiDesktopPids;
    if (hosts instanceof Set && hosts.size > 0) return true;
    if (bucket !== "dsh") return false;
    const gen = ensureDesktopGen(entry);
    const seen = procCounts.seenPids;
    return gen.shellPids.size > 0 && seen instanceof Set
      && [...gen.shellPids].some((pid) => seen.has(pid));
  }

  // 无归属请求的专用承载态：不进 endpointStates（看板不可见、快照不持久化）、
  // 不进 instanceBuckets（无实例行），存在只为让 tracker 生命周期复用
  // trackAggregateRequest 的既有记账逻辑、给 journal 留 agentId: null 的
  // 审计行。渠道×模型稳定性是与端点无关的上游健康视图，照常记录。
  const unattributedState = createAggregateState(sparkWindowPoints);

  // Per-instance buckets for the multi-instance endpoints (kimi / opencode /
  // pi / codex / grok / dsh / qoder / claude): instanceId -> { state, firstSeen }.
  // Only requests carrying a valid instanceId land here, and they ALSO land in the
  // endpoint aggregate above, so the existing cards are unchanged. zcode stays
  // aggregate-only by design. qoder joined the multi-instance set 2026-10-15:
  // its provider config cannot carry custom request headers, so the netstat
  // socket reverse lookup (SOCKET_FALLBACK_AGENT_IDS in late-socket-instance,
  // same list as this map) is the only instance identity its CLI has — without
  // it the virtual terminal's Qoder sessions can never bind an instance row.
  // dsh joins on the same socket-reverse-lookup mechanism the other CLI
  // endpoints use: every DSH surface (web UI, TUI, any custom profile) talks to
  // the loopback relay over its own keep-alive connection, so one row per
  // process is reachable without asking the client to send anything. The row
  // identity is the ENGINE pid from the process scan, never a conversation id:
  // DSH carries its session id as far as the LLM adapter but never puts it on
  // the wire (its compat gate withholds the session-affinity headers), so
  // per-conversation truth stays on the ~/.dsh/sessions scan, where it is
  // already accurate.
  // claude's bucket does NOT feed an `instances` array (the claude card stays
  // per-session — see the card assembly): it is the accumulation slot for the
  // resident relay's claude traffic, which getActiveClaudeSessions merges into
  // the card's session rows by PID. It exists in this map so the request path,
  // the late-attach mechanism and the PID housekeeping all work unmodified —
  // the desktop app points its gateway straight at the resident relay, so it
  // has no session reporter and the socket reverse lookup is its only identity.
  const instanceBuckets = { dsh: new Map(), kimi: new Map(), opencode: new Map(), pi: new Map(), codex: new Map(), grok: new Map(), qoder: new Map(), claude: new Map() };

  // Consecutive trusted scan rounds in which a session row's endpoint family was
  // absent, keyed "<bucket>:<instId>". A session row names a conversation, not
  // a process, so its only liveness source is the endpoint's process family —
  // and a single round can miss a live family (probe output truncated under its
  // time budget, a process starting/restarting inside the round). Evicting on
  // the first such round wipes rows that are still in use: the terminal panel's
  // row binding drops to null and the card looks like the session never
  // existed. Two consecutive trusted zero rounds is the verdict; any round that
  // sees the family clears the streak.
  const sessionRowFamilyMisses = new Map();

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

  // ── 运行锚（run anchor）──────────────────────────────────────────
  // 端点的「一次运行」= 其进程家族当前活着的这批 pid。锚记的是最近一轮可信扫描
  // 看到的家族 pid 集（RUN_ANCHOR_SCOPE 决定每个端点对哪个集合认家族）：家族
  // 全灭过宽限即全账清零、下次启动从 0 计；锚随快照落盘，relay 重启后由还原
  // 的旧锚在首轮可信扫描上做「续账 or 重开」判决——判决读的是旧锚，必须先于
  // refreshRunAnchors 的改写执行（见 land() 内的顺序注释）。
  const runAnchors = new Map(); // endpointId -> Set(pid)：本轮运行认下的家族 pid
  const pendingRunVerdicts = new Map(); // endpointId -> Set(pid)：还原的旧锚，等首轮可信扫描
  // Claude 退役账：会话行消亡（正常退出过窗或 PID 被复用）时把行累计并入这个
  // 端点级累加器，卡片聚合 = 活行 + 退役账，行的历史不随行消亡。与端点账同生
  // 共死：claude 家族全灭清零时直接归零（不并账——行删、账清，各自归零即可）。
  const claudeRetiredLedger = {
    requests: 0,
    activeDurationMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    lastTtftMs: null,
    lastSeen: null,
  };

  function absorbClaudeRetiredLedger(session) {
    claudeRetiredLedger.requests += session.requests || 0;
    claudeRetiredLedger.activeDurationMs += session.activeDurationMs || 0;
    claudeRetiredLedger.promptTokens += session.promptTokens || 0;
    claudeRetiredLedger.completionTokens += session.completionTokens || 0;
    claudeRetiredLedger.cachedTokens += session.cachedTokens || 0;
    if (typeof session.lastTtftMs === "number") {
      claudeRetiredLedger.lastTtftMs = session.lastTtftMs;
    }
    if (typeof session.lastSeen === "number"
      && (claudeRetiredLedger.lastSeen === null || session.lastSeen > claudeRetiredLedger.lastSeen)) {
      claudeRetiredLedger.lastSeen = session.lastSeen;
    }
  }

  // 端点全账清零：原位重置（保住对象身份，在途请求/看板持有的引用随之归零），
  // claude 连会话行与退役账一起清。实例桶不清——行有独立的生死机制（见
  // settleAndResetRunAccount 注释），恢复的旧行（无活 pid）由逐行淘汰收走。
  // sparkWindowPoints 是视窗设置不是账目，保留。触发方一律自己负责
  //「可信轮 + 过宽限」的门，这里只管清。
  function resetEndpointRunAccount(id) {
    const state = endpointStates[id];
    if (state === undefined) return;
    Object.assign(state, createAggregateState(state.sparkWindowPoints));
    if (id === "claude") {
      claudeSessions.clear();
      sessionStabilitySeq.clear();
      reportedChainStates.clear();
      claudeRetiredLedger.requests = 0;
      claudeRetiredLedger.activeDurationMs = 0;
      claudeRetiredLedger.promptTokens = 0;
      claudeRetiredLedger.completionTokens = 0;
      claudeRetiredLedger.cachedTokens = 0;
      claudeRetiredLedger.lastTtftMs = null;
      claudeRetiredLedger.lastSeen = null;
    }
    markMetricsDirty();
  }

  // 每轮可信扫描刷新锚：家族 pid 集与锚不同即改写（快照随之落盘）。空集也是
  // 一次合法改写——家族全灭后锚指向空集，落盘的空锚在下次 relay 重启时判
  // 「没有活锚」→ 还原的零账照旧归零，语义自洽。
  function refreshRunAnchors(counts) {
    for (const [id, scopeKey] of Object.entries(RUN_ANCHOR_SCOPE)) {
      const pids = counts[scopeKey];
      if (!(pids instanceof Set)) continue;
      const anchor = runAnchors.get(id);
      const unchanged = anchor !== undefined && anchor.size === pids.size
        && [...pids].every((pid) => anchor.has(pid));
      if (unchanged) continue;
      runAnchors.set(id, new Set(pids));
      markMetricsDirty();
    }
  }

  // 还原锚的续账判决（只在可信轮跑）：旧锚里任一 pid 还在本轮家族集里 → 同一
  // 次运行还在，账续着；一个都不在（或没有可用家族集）→ 旧运行已终结，还原
  // 进来的账整体归零。判决一次性：无论结果如何都出列，之后交给常规路径。
  function resolvePendingRunVerdicts(counts) {
    if (pendingRunVerdicts.size === 0) return;
    for (const [id, anchorPids] of pendingRunVerdicts) {
      pendingRunVerdicts.delete(id);
      const scopeKey = RUN_ANCHOR_SCOPE[id];
      const livePids = scopeKey !== undefined ? counts[scopeKey] : undefined;
      const continuing = livePids instanceof Set
        && [...anchorPids].some((pid) => livePids.has(pid));
      if (continuing) {
        runAnchors.set(id, new Set(livePids));
        markMetricsDirty();
        continue;
      }
      resetEndpointRunAccount(id);
    }
  }

  function serializeMetricsSnapshot(now) {
    const endpoints = {};
    for (const [id, state] of Object.entries(endpointStates)) {
      endpoints[id] = serializeAggregateState(state);
    }
    const instances = {};
    for (const [bucket, instMap] of Object.entries(instanceBuckets)) {
      instances[bucket] = [...instMap.entries()].map(([id, entry]) => {
        const row = {
          id,
          firstSeen: entry.firstSeen,
          label: entry.label,
          state: serializeAggregateState(entry.state),
        };
        // 桌面稳定行的账目代际锚随行落盘：relay 重启期间 App 若重启过，还原
        // 后的第一次结算要能认出「旧代全灭 + 新代出现」并重开账。
        if (entry.desktopGen) {
          row.desktopGen = {
            hostPids: [...entry.desktopGen.hostPids],
            shellPids: [...entry.desktopGen.shellPids],
          };
        }
        return row;
      });
    }
    // 运行锚随账落盘：relay 重启后由还原的旧锚在首轮可信扫描上判「续账 or
    // 重开」（见 pendingRunVerdicts）。claude 退役账是端点账的一部分，同车落盘。
    const runPids = {};
    for (const [id, pids] of runAnchors) {
      runPids[id] = [...pids];
    }
    return {
      version: METRICS_SNAPSHOT_VERSION,
      savedAt: now,
      endpoints,
      instances,
      runPids,
      claudeRetiredLedger: {
        requests: claudeRetiredLedger.requests,
        activeDurationMs: claudeRetiredLedger.activeDurationMs,
        promptTokens: claudeRetiredLedger.promptTokens,
        completionTokens: claudeRetiredLedger.completionTokens,
        cachedTokens: claudeRetiredLedger.cachedTokens,
        lastTtftMs: claudeRetiredLedger.lastTtftMs,
        lastSeen: claudeRetiredLedger.lastSeen,
      },
    };
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
            state: createAggregateState(sparkWindowPoints),
            firstSeen: snapshotFinite(row.firstSeen) || nowFn(),
            label: typeof row.label === "string" ? row.label : null,
          };
          restoreAggregateState(entry.state, row.state, sampleKeep);
          // 代际锚容忍缺字段（旧版快照没写它）：缺了就当空锚，首次结算按
          // 「还没有账」收编，不触发重开。字段在就按数组还原，非数值项丢弃。
          if (row.desktopGen && Array.isArray(row.desktopGen.hostPids)) {
            entry.desktopGen = {
              hostPids: new Set(row.desktopGen.hostPids.filter((pid) => Number.isFinite(pid))),
              shellPids: new Set(Array.isArray(row.desktopGen.shellPids)
                ? row.desktopGen.shellPids.filter((pid) => Number.isFinite(pid))
                : []),
            };
          }
          instMap.set(row.id, entry);
        }
      }
    }
    // 还原的运行锚不直接当活锚：进 pendingRunVerdicts，等首轮可信扫描判
    // 「旧 run 还活着（任一锚 pid 在本轮家族集里）→ 续账；全灭 → 重开」。
    // 判决在 land() 里跑，先于 refreshRunAnchors 改写锚（见其顺序注释）。
    // 空锚照判：锚为空的端点还原的零账判「重开」，归零操作是幂等的。
    if (raw.runPids && typeof raw.runPids === "object") {
      for (const id of Object.keys(endpointStates)) {
        const arr = raw.runPids[id];
        if (!Array.isArray(arr)) continue;
        const pids = new Set(arr.filter((pid) => Number.isFinite(pid)));
        pendingRunVerdicts.set(id, pids);
      }
    }
    // claude 退役账还原：字段级防御，坏值退化为 0/null，不抛不信任形状。
    const ledger = raw.claudeRetiredLedger;
    if (ledger && typeof ledger === "object") {
      claudeRetiredLedger.requests = snapshotFinite(ledger.requests);
      claudeRetiredLedger.activeDurationMs = snapshotFinite(ledger.activeDurationMs);
      claudeRetiredLedger.promptTokens = snapshotFinite(ledger.promptTokens);
      claudeRetiredLedger.completionTokens = snapshotFinite(ledger.completionTokens);
      claudeRetiredLedger.cachedTokens = snapshotFinite(ledger.cachedTokens);
      claudeRetiredLedger.lastTtftMs = snapshotNullableNumber(ledger.lastTtftMs);
      claudeRetiredLedger.lastSeen = snapshotNullableNumber(ledger.lastSeen);
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

  // 一个聚合态的折线视窗：记下窗口长度，并把样本环裁到 keep（环可以比窗口长，
  // 视窗收窄时超窗的历史才丢得掉）。端点态、实例镜像态、无归属态共用这一条。
  function applySparkWindowToState(state, keep) {
    state.sparkWindowPoints = sparkWindowPoints;
    while (state.ttftHistory.length > keep) state.ttftHistory.shift();
    while (state.recentSamples.length > keep) state.recentSamples.shift();
  }

  function applySparkWindow(n) {
    sparkWindowPoints = parseSparkWindowPoints(n);
    const keep = Math.max(recentSampleWindow, sparkWindowPoints);
    for (const state of [zcodeState, dshState, piState, kimiState, qoderState, opencodeState, claudeState, codexState, grokState, unattributedState]) {
      applySparkWindowToState(state, keep);
    }
    // 实例行（dsh / kimi / opencode / pi / codex / grok，以及 claude 卡会话行
    // 所镜像的那份）与端点卡同窗：面板的折线视窗设置只推给端点态时，实例行会
    // 一直停在出生时的窗口上，把视窗调大也看不出变化。
    for (const instMap of Object.values(instanceBuckets)) {
      for (const entry of instMap.values()) applySparkWindowToState(entry.state, keep);
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
      ? resolveInstanceId(bucketAgentId, rawInstanceId, cachedProcessCounts)
      : null;
    const effMeta = normalized !== null && normalized.id !== rawInstanceId
      ? { ...meta, instanceId: normalized.id }
      : meta;
    const primary = trackAggregateRequest(targetState, effMeta, nowFn, recentSampleWindow, stability, journal, bucketAgentId,
      (count) => publishActivity(bucketAgentId, null, count));
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
      const isDesktopStableRow = instanceId === DSH_DESKTOP_INSTANCE_ID || instanceId === KIMI_DESKTOP_INSTANCE_ID;
      let entry = instMap.get(instanceId);
      if (entry !== undefined && isDesktopStableRow) {
        // 折叠入稳定行先结算账目代际：真重启在此就地重开账，本请求的计数落进
        // 新账——清零不依赖任何读取时机（面板隐藏期间的重启也在此收敛）。
        settleDesktopGenerationOnFold(bucketAgentId, entry, norm.clientPid, cachedProcessCounts);
      }
      if (!entry) {
        entry = { state: createAggregateState(sparkWindowPoints), firstSeen: nowFn(), label: null };
        if (isDesktopStableRow) {
          ensureDesktopGen(entry);
          settleDesktopGenerationOnFold(bucketAgentId, entry, norm.clientPid, cachedProcessCounts);
        }
        instMap.set(instanceId, entry);
        markMetricsDirty();
      }
      if (norm.label !== null) entry.label = norm.label;
      const mirror = trackAggregateRequest(entry.state, { ...effMeta, instanceId }, nowFn, recentSampleWindow, null, null, bucketAgentId,
        (count) => publishActivity(bucketAgentId, instanceId, count));
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
      bindInstance(resolveInstanceId(bucketAgentId, raw, cachedProcessCounts));
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
        // 退役账吸收：旧会话的累计不随行删除消失，并入端点级累加器，聚合
        //（活行 + 退役账）保持不变。占位行（token === null）计数全 0，免吸收。
        absorbClaudeRetiredLedger(existing);
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
      // Canonical `<agentId>-<pid>` id — the same key terminal attribution
      // joins against (`<agentId>-<detected client pid>`), so a virtual
      // terminal binds and the activity frame identity below matches the
      // row the panel highlights.
      id: `claude-${pid}`,
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
      clientForm: "cli",
      transport: "per-launch",
      identitySource: "reporter",
    };

    session.lastSeen = now;
    session.token = token;
    if (typeof report.requests === "number") session.requests = report.requests;
    if (typeof report.activeRequests === "number") {
      const prevActive = session.activeRequests;
      session.activeRequests = report.activeRequests;
      // 0↔N jump of the merged per-session counter — publish the absolute
      // state; same busy-idle boundary semantics as the aggregate trackers.
      if ((prevActive === 0) !== (session.activeRequests === 0)) {
        publishActivity("claude", session.id, session.activeRequests);
      }
    }
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
    if ("chainKey" in report) session.chainKey = typeof report.chainKey === "string" ? report.chainKey : null;
    if ("model" in report) {
      session.model = report.model ?? null;
      if (session.model) {
        session.lastModel = session.model;
        session.lastProvider = session.providerId;
        session.lastViaAuto = session.viaAuto === true;
        session.lastChainKey = session.chainKey ?? null;
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

  // Claude 桌面形态收敛：MSIX 桌面壳（单形态约 5 个进程）与桌面托管引擎
  // 同属一个桌面形态，逐 PID 成行会把一个桌面端拆成一排幽灵分身（Claude
  // 3p 桌面端验证现场实测约 5 行）。扫描按镜像路径分型（claudeDesktopPids），
  // 本轮读取时把分型命中的会话折成一条合成行 claude-desktop：计数类求和，
  // 速率/错误/模型/spark 类取 lastSeen 最新的有值成员，startedAt 取最早、
  // lastSeen 取最晚，形态标注 surface: "desktop" 供面板贴 Desktop 徽标。
  // 折叠是纯读取侧呈现：claudeSessions 仍按 PID 跟踪生灭，PID 全灭时成员
  // 一个不剩，合成行自然消失。分型读不出的行（CLI、无命令行的 tasklist
  // 兜底、白名单外路径）原样逐 PID 保留——宁可漏折，不可误折。行序保持
  // 首个桌面成员的原位置。
  function groupClaudeClientInstances(sessions, desktopPids) {
    if (!(desktopPids instanceof Set)) return sessions;
    const members = sessions.filter((s) => desktopPids.has(s.pid));
    if (members.length === 0) return sessions;
    // 「lastSeen 最新的有值成员」读取器：合成行的速率/错误/模型类字段全部
    // 走它，值与它的时间戳永远来自同一个成员会话。
    const newestWith = (field) => {
      let best = null;
      for (const m of members) {
        if (m[field] === null || m[field] === undefined) continue;
        if (best === null || m.lastSeen >= best.lastSeen) best = m;
      }
      return best;
    };
    const ttftHolder = newestWith("lastTtftMs");
    const sparkHolder = newestWith("sparkHistory");
    const samplesHolder = newestWith("samples");
    const modelHolder = newestWith("model");
    const lastModelHolder = newestWith("lastModel");
    const folded = {
      id: "claude-desktop",
      pid: null,
      token: null,
      surface: "desktop",
      clientForm: "desktop",
      transport: "resident",
      identitySource: members.some((m) => m.identitySource === "socket-pid") ? "socket-pid" : "process-scan",
      startedAt: Math.min(...members.map((m) => m.startedAt)),
      lastSeen: Math.max(...members.map((m) => m.lastSeen)),
      requests: members.reduce((sum, m) => sum + m.requests, 0),
      activeRequests: members.reduce((sum, m) => sum + m.activeRequests, 0),
      activeDurationMs: members.reduce((sum, m) => sum + m.activeDurationMs, 0),
      promptTokens: members.reduce((sum, m) => sum + m.promptTokens, 0),
      completionTokens: members.reduce((sum, m) => sum + m.completionTokens, 0),
      cachedTokens: members.reduce((sum, m) => sum + m.cachedTokens, 0),
      lastTtftMs: ttftHolder?.lastTtftMs ?? null,
      lastError: newestWith("lastError")?.lastError ?? null,
      errorActive: members.some((m) => m.errorActive),
      sparkHistory: sparkHolder?.sparkHistory ?? null,
      samples: samplesHolder?.samples ?? null,
      model: modelHolder?.model ?? null,
      providerId: modelHolder?.providerId ?? null,
      viaAuto: modelHolder?.viaAuto === true,
      chainKey: modelHolder?.chainKey ?? null,
      lastModel: lastModelHolder?.lastModel ?? null,
      lastProvider: lastModelHolder?.lastProvider ?? null,
      lastViaAuto: lastModelHolder?.lastViaAuto === true,
      lastChainKey: lastModelHolder?.lastChainKey ?? null,
      ended: false,
    };
    const out = [];
    let inserted = false;
    for (const s of sessions) {
      if (desktopPids.has(s.pid)) {
        if (!inserted) {
          out.push(folded);
          inserted = true;
        }
        continue;
      }
      out.push(s);
    }
    return out;
  }

  // Liveness is decided by the process list, not by a TTL. A session is alive
  // if its claude.exe PID is still running. Sessions whose PID has vanished
  // are marked ended; ended sessions linger for ENDED_DISPLAY_MS then purge.
  //
  // Resident-relay attribution: a claude process that talks to the resident relay
  // itself (the desktop app, or `claude` started with our base URL) has no
  // session reporter — nothing would ever fill its row. The request path already
  // mirrors that traffic into instanceBuckets.claude keyed by the reverse-looked-up
  // owner PID; here it is merged onto the same per-PID row the process scan
  // created. The two sources are mutually exclusive by construction: a row that
  // HAS a reporter (token !== null) is never merged, so one request is counted
  // once — the per-launch relay and the resident relay never serve the same
  // request.
  function mergeResidentClaudeMetrics(session, now) {
    if (session.token !== null || session.pid === null) return;
    const entry = instanceBuckets.claude.get(`claude-${session.pid}`);
    if (entry === undefined) return;
    const state = entry.state;
    session.requests = state.totalRequests;
    session.activeRequests = state.activeRequests;
    session.activeDurationMs = state.activeWallClockMs
      + (state.activeWallStart !== null ? Math.max(0, now - state.activeWallStart) : 0);
    session.promptTokens = state.totalPromptTokens;
    session.completionTokens = state.totalCompletionTokens;
    session.cachedTokens = state.totalCachedTokens;
    if (state.lastTtftMs !== null) session.lastTtftMs = state.lastTtftMs;
    session.lastError = state.lastError ?? null;
    session.errorActive = state.errorActive;
    session.samples = state.recentSamples.length > 0 ? state.recentSamples.slice() : null;
    // Same window rule and same population as an endpoint card's sparkline (see
    // sparkHistoryForState), so the session curve matches the number beside it.
    session.sparkHistory = state.recentSamples.length > 0 || state.ttftHistory.length > 0
      ? sparkHistoryForState(state)
      : null;
    session.model = state.currentModel;
    session.providerId = state.currentProvider;
    session.viaAuto = state.currentViaAuto === true;
    session.chainKey = state.currentChainKey ?? null;
    if (state.lastModel !== null) {
      session.lastModel = state.lastModel;
      session.lastProvider = state.lastProvider;
      session.lastViaAuto = state.lastViaAuto === true;
      session.lastChainKey = state.lastChainKey ?? null;
    }
    if (state.lastRequestAt !== null && state.lastRequestAt > session.lastSeen) {
      session.lastSeen = state.lastRequestAt;
    }
  }

  async function getActiveClaudeSessions() {
    const procCounts = await scanProcesses();
    const livePids = procCounts.claudePids;
    const now = nowFn();
    const active = [];

    // Ensure all currently running claude.exe PIDs have a session tracked immediately
    //
    // 冷/降级轮的例外（2026-10-07 报障：看板加载中间态概率出现数个空实例卡）：读不到
    // 命令行列的那一轮，「这个 pid 是不是会话进程、是什么形态」答不出，而这里给桶里每个
    // pid 都建一行。本机实测：冷降级轮一次出 10 行「会话 #N / 待命 / 0 请求 / tokens 全 0
    // / 无徽标」的空实例卡——一个桌面端裂成一排。
    //
    // 闸门只认一种状态：这一轮是降级轮，**且此刻手里没有任何可信依据**（从未落地过可信轮，
    // 或可信轮已过 99e4d9c 的 30s 沿用窗）。前者是面板/中继刚起的第一轮，后者是探针被闲置
    // 回收后再冷启动的那一轮——两者都一样「每个 pid 都陌生」，逐 pid 成行必然是一排空卡。
    // 沿用窗之内的降级轮维持既有裁决：可信轮没见过的新进程照样建行、只是不贴徽标
    // （用例「盲轮期间刚起的、可信轮没见过的进程不贴形态徽标」钉着，不在这里动）。
    // 边界同 99e4d9c：只管「分型与归属」，进程数与存活判定仍由本轮说了算（50a41fc）。
    const blindWithoutBasis = procCounts.countsAuthoritative !== true
      && (lastTrustedScan === null || nowFn() - lastTrustedScanTime > TRUSTED_FORM_CARRY_MS);
    for (const pid of livePids) {
      if (!claudeSessions.has(pid)) {
        if (blindWithoutBasis) continue;
        claudeSessions.set(pid, {
          id: `claude-${pid}`,
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
          clientForm: null,
          transport: "resident",
          identitySource: "process-scan",
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
            // 退役账吸收：行到期清除前把累计并入端点级累加器。占位行与空行
            // 计数为 0，吸收是加 0 的空操作，无需单独豁免。
            absorbClaudeRetiredLedger(s);
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
      // Process classification is the source of client form. Reporter
      // presence only describes transport and attribution quality.
      // 读不出形态就是读不出：这里曾经把落空一律当成 "cli"，于是命令行读不到的
      // 那一轮（回落 tasklist）会把一个桌面端的每个进程都报成 CLI 会话，卡片
      // 因此多出十几个带 CLI 徽标的实例行（2026-10-05 报障）。留 null 时行上不
      // 贴徽标，与下发侧「未分型行不贴」的口径一致。
      s.surface = procCounts.claudeSurfaceByPid?.get(s.pid) ?? null;
      s.clientForm = s.surface;
      s.transport = s.token !== null ? "per-launch" : "resident";
      s.identitySource = s.token !== null
        ? "reporter"
        : (instanceBuckets.claude.has(`claude-${s.pid}`) ? "socket-pid" : "process-scan");
      mergeResidentClaudeMetrics(s, now);
      active.push(s);
    }
    return groupClaudeClientInstances(active, procCounts.claudeDesktopPids);
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
    // 这一轮的桶内计数可信吗（口径见 createEmptyProcessScan 上方）。不可信轮的
    // 「零进程」是看不见而不是不在：据进程归属做的破坏性收敛整批跳过，实例淘汰
    // 降级为「本轮全量 pid」存活判定。可信轮一切照旧。
    const countsTrusted = procCounts.countsAuthoritative === true;

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
    // 「已工作时间」同属本次运行期：进程全灭（过同一道宽限）即清零，下次启动
    // 从 0 重计。本函数只结算活动量（在飞请求、挂起故障、进行时标识）——
    // 累计量（请求数/tokens/样本窗/身份/故障史）的重置在结算之外单独做
    //（settleAndResetRunAccount），因为它还收走随账而生的行（claude 会话行、
    // 退役账），这些不归逐实例行的结算调用点管。
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
      state.activeWallClockMs = 0;
    }

    // 端点级全账重置（run zeroing）：与 settleAbandonedAggregateState 同门
    //（可信轮 + 家族全灭）同宽限（3s），过线即把「本次运行」的账整体归零
    //——请求数、tokens、已工作时间、折线样本、模型/渠道身份、lastSeen、故障
    // 史，及随账而生的 claude 会话行与退役账。实例桶不在此清：实例行有自己
    // 的生死机制（pid 规则、desktopGen 代际、家族连失判定），且 run 判决
    //（resolvePendingRunVerdicts）路径上「新代流量先到、判决后到」时新代行
    // 必须存活；恢复的旧实例行（无活 pid）由既有逐行淘汰自行收走。
    function settleAndResetRunAccount(id, processCount) {
      if (processCount > 0) return;
      const state = endpointStates[id];
      let idleSince = state.activeWallStart ?? state.lastRequestAt;
      if (idleSince === null && id === "claude" && claudeSessions.size > 0) {
        // per-launch 会话流量只落会话行、不进端点聚合态：宽限锚点退到会话行
        // 的最近活动，否则 claude 的账永远等不到过线的一轮。
        for (const s of claudeSessions.values()) {
          if (typeof s.lastSeen === "number" && (idleSince === null || s.lastSeen > idleSince)) {
            idleSince = s.lastSeen;
          }
        }
      }
      if (idleSince === null) idleSince = now;
      if (now - idleSince <= PROCESS_GONE_ACTIVE_REQUEST_TTL_MS) return;
      // 幂等闸：全零态重跑一整圈重置是浪费（多数轮看板读起来端点都静止）。
      const hadAccount = state.totalRequests > 0 || state.activeRequests > 0
        || state.lastRequestAt !== null || state.lastModel !== null;
      const hasClaudeRows = id === "claude"
        && (claudeSessions.size > 0 || claudeRetiredLedger.requests > 0
          || claudeRetiredLedger.promptTokens > 0 || claudeRetiredLedger.completionTokens > 0
          || claudeRetiredLedger.activeDurationMs > 0);
      if (!hadAccount && !hasClaudeRows) {
        // 仍需 settle：恢复自旧快照的活动量（activeFaults 等）不走 hadAccount。
        settleAbandonedAggregateState(state, 0);
        return;
      }
      settleAbandonedAggregateState(state, 0);
      resetEndpointRunAccount(id);
    }

    // 只在完整轮结算：不完整轮的零进程数是「没看见」，不是「进程没了」。
    if (countsTrusted) {
      settleAndResetRunAccount("zcode", procCounts.zcode || 0);
      settleAndResetRunAccount("dsh", procCounts.dsh || 0);
      settleAndResetRunAccount("pi", procCounts.pi || 0);
      settleAndResetRunAccount("kimi", procCounts.kimi || 0);
      settleAndResetRunAccount("qoder", procCounts.qoder || 0);
      settleAndResetRunAccount("codex", procCounts.codex || 0);
      settleAndResetRunAccount("opencode", procCounts.opencode || 0);
      settleAndResetRunAccount("grok", procCounts.grok || 0);
      settleAndResetRunAccount("claude", procCounts.claude || 0);
    }

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
    // Session-granular rows (codex-sess- / opencode-sess-) declare no PID at
    // all: they clear the moment the whole endpoint's process family exits, or
    // after their idle TTL without traffic — whichever comes first.
    // DSH 的桌面稳定行（DSH_DESKTOP_INSTANCE_ID）与 kimi 的桌面稳定行
    // （KIMI_DESKTOP_INSTANCE_ID）也是无属主 pid 一档，但生死判据是「面的
    // 进程家族还在」而非空闲时长：宿主在（DSH 壳也在）行就在，家族全灭即
    // 当轮收行——与逐 pid 行同权即时，空闲 TTL 从稳定行的生死里彻底出局。
    // Remaining custom ids (no numeric tail —
    // normalizeInstanceId already had its say at ingest) keep the idle TTL; an
    // instance with in-flight requests never expires on that path.
    for (const [bucket, instMap] of Object.entries(instanceBuckets)) {
      const count = procCounts[bucket] || 0;
      // Endpoints with an ENGINE subset reconcile their canonical rows against
      // it: codex's full pid set also holds the desktop GUI shell (ChatGPT.exe)
      // and short-lived helpers, and dsh's holds the two TUI launcher shells,
      // none of which own a session. Card status/process count keeps the
      // bucket's own scope (codex = whole family, dsh = engines only); only
      // instance liveness narrows to the set that can hold traffic.
      // opencode is the exception that widens back to the family set: its
      // `serve --service` helper child is family but never an engine, and the
      // interactive process can in principle exit while the child lingers —
      // evicting the row off the engine set would flash the card away
      // mid-teardown.
      const livePids = bucket === "opencode"
        ? (procCounts.opencodePids ?? new Set())
        : (procCounts[`${bucket}EnginePids`] ?? procCounts[`${bucket}Pids`] ?? new Set());
      // 占位行的面比存活判定窄：起行只认「能扛流量的进程」——opencode 的
      // serve 子进程在家族集里兜底存活判定，但它永不发请求，不能起占位行。
      const placeholderPids = procCounts[`${bucket}EnginePids`]
        ?? procCounts[`${bucket}Pids`] ?? new Set();
      const pidIdRe = new RegExp(`^${bucket}-(\\d+)$`);
      for (const [instId, entry] of instMap) {
        const pidMatch = instId.match(pidIdRe);
        const sessionRowPrefix = SESSION_ROW_PREFIXES[bucket] ?? null;
        const isSessionRow = sessionRowPrefix !== null && instId.startsWith(sessionRowPrefix);
        // 冷缓存收敛：启动器注入的 "<cwd>-<launcher pid>" 在扫描缓存没赶上
        // 会话启动（或看板关闭期间缓存不刷新——请求路径只同步读缓存、从
        // 不触发扫描）时折不进规范形，落成自定义 id 行；缓存跟上后后续请
        // 求折回 "<agentId>-<pid>"，两行并排——单会话看板显示两个实例，
        // 临时行要等 10 分钟空闲 TTL 才消失（pi 现场 2026-09-14）。这里
        // 拿本读的新快照重试折叠：目标行不存在就把整行改名归位（在途镜
        // 像写的是同一 state 对象，随之归位，不受改名影响）；目标行已存
        // 在且本行无在途请求就清行（桌面稳定行把已完成计数并账保住，见
        // 下；其余行这些计数随空闲 TTL 本来也要丢，journal 已逐请求落账
        // 不受影响）；有在途请求留到其收尾后的下一轮读再收敛。
        // 重折叠读的是本轮快照里的 pid 归属：不完整轮答不出归属，跳过。
        // dsh 与 kimi 的 pid 形行也在列：冷缓存窗口里桌面宿主/主进程的请求
        // 没折进稳定行（归一化当时读不到宿主集合），落在原始 "dsh-<pid>" /
        // "kimi-<pid>" 上；缓存跟上后这里折回各自的 DSH/KIMI_DESKTOP_INSTANCE_ID。
        // opencode 的 pid 形行同列：serve 子进程刚起、扫描还没把它分类进 serve 集
        // 时，请求落在原始 "opencode-<serve pid>" 上；缓存跟上后折回交互主进程
        // 行（归一化的上折，目标行就是 pid 形占位行）。
        // 对 TUI/web 的 pid 行，归一化是恒等映射，重折叠空转。
        if (countsTrusted && !isSessionRow
          && (pidMatch === null || bucket === "dsh" || bucket === "kimi" || bucket === "opencode")) {
          const refold = resolveInstanceId(bucket, instId, procCounts);
          if (refold !== null && refold.id !== instId) {
            const target = instMap.get(refold.id);
            if (target === undefined) {
              instMap.delete(instId);
              if (refold.label !== null) entry.label = refold.label;
              if (refold.id === DSH_DESKTOP_INSTANCE_ID || refold.id === KIMI_DESKTOP_INSTANCE_ID) {
                // 冷缓存窗口的整行改名归位：raw 行的计数本来就是当前代攒下的，
                // 随行落稳定行，同时初始化代际锚（宿主 = 折叠 pid，dsh 连记父壳）。
                ensureDesktopGen(entry);
                settleDesktopGenerationOnFold(bucket, entry, refold.clientPid, procCounts);
              }
              instMap.set(refold.id, entry);
              continue;
            }
            if (target.label === null && refold.label !== null) target.label = refold.label;
            if (entry.state.activeRequests === 0) {
              if (refold.id === DSH_DESKTOP_INSTANCE_ID || refold.id === KIMI_DESKTOP_INSTANCE_ID) {
                // 合并保账：先结算目标行的账目代际（App 在冷缓存窗口里重启过就
                // 在此重开），再把临时行的已完成计数并入。这个窗口横跨整个隐藏
                // 期时临时行可能攒了大量当前代计数，直接丢弃等于重演「历史凭空
                // 消失」；并账对同代合并同样成立（relay 重启还原 + 冷缓存继续跑）。
                settleDesktopGenerationOnFold(bucket, target, refold.clientPid, procCounts);
                absorbAggregateState(target.state, entry.state,
                  Math.max(recentSampleWindow, target.state.sparkWindowPoints ?? DEFAULT_SPARK_WINDOW_POINTS));
              }
              instMap.delete(instId);
              continue;
            }
          }
        }
        let evict = false;
        if (pidMatch !== null) {
          // 完整轮：桶内 pid 集说了算（认不出这个桶即视为该行已不属于此端点）。
          // 不完整轮：桶内集对 node 型端点是空的，改用本轮全量 pid——只判生死，
          // 不判归属，进程真死了照样即时淘汰。快照里没有全量 pid（外部注入的
          // 旧形状）时不淘汰，宁可留一行也不误删。
          if (countsTrusted) {
            evict = !livePids.has(Number(pidMatch[1]));
          } else {
            const seenPids = procCounts.seenPids;
            evict = seenPids instanceof Set && !seenPids.has(Number(pidMatch[1]));
          }
        } else if (countsTrusted && isSessionRow) {
          const missKey = `${bucket}:${instId}`;
          if (count === 0) {
            const misses = (sessionRowFamilyMisses.get(missKey) ?? 0) + 1;
            sessionRowFamilyMisses.set(missKey, misses);
            evict = misses >= SESSION_ROW_FAMILY_MISS_ROUNDS;
          } else {
            sessionRowFamilyMisses.delete(missKey);
          }
        } else if (countsTrusted && bucket === "codex") {
          const tail = instId.match(/-(\d+)$/);
          evict = tail !== null && scanPidLiveness(Number(tail[1]), procCounts) === false;
        } else if (countsTrusted
          && (instId === DSH_DESKTOP_INSTANCE_ID || instId === KIMI_DESKTOP_INSTANCE_ID)) {
          // 稳定桌面行：先结算账目代际（App 在无人观看时重启的收敛点，见上），
          // 再按「面的进程家族还在」即时判生死——空闲时长不参与，与逐 pid 行
          // 同权：家族在行就在，家族灭行即收。
          settleDesktopGenerationOnRead(bucket, entry, procCounts);
          evict = !isDesktopFamilyAlive(bucket, entry, procCounts);
        }
        if (evict) {
          // The owning process is gone — evict now. Its in-flight requests
          // are orphans the transport layer will never finish (same
          // situation as settleAbandonedAggregateState), and they were ALSO
          // counted in the endpoint aggregate, so settle that share there;
          // the instance's own counters vanish with the entry.
          settleLeakedInstanceRequests(bucket, entry.state, now);
          instMap.delete(instId);
          sessionRowFamilyMisses.delete(`${bucket}:${instId}`);
          continue;
        }
        // 同上：结算依据是「这个端点本轮没有进程」，不完整轮答不出这件事。
        if (countsTrusted) settleAbandonedAggregateState(entry.state, count);
        pruneStaleAggregateFaults(entry.state, nowFn, faultIdleTtlMs);
        if (pidMatch === null && instId !== DSH_DESKTOP_INSTANCE_ID && instId !== KIMI_DESKTOP_INSTANCE_ID) {
          const lastSeen = entry.state.lastRequestAt ?? entry.firstSeen;
          // opencode 的会话行不设空闲档：它的「家族」就是用户开着的那些 TUI，
          // TUI 一关家族即灭、行当轮收走；反过来一条开着的 TUI 只是没在打字，
          // 它的对话仍在屏幕上——按空闲时长收行会让终端右栏与看板在静置几分钟
          // 后突然认不出这条会话（现场：复活回去的对话静置 5 分钟，行消失、
          // 绑定回落 null）。codex 相反：它的 GUI 是常驻进程，家族长期不灭，
          // 只能靠空闲档收行，否则每次开机以来的会话行都会挂着。
          const idleTtlMs = isSessionRow ? SESSION_ROW_IDLE_TTL_MS[bucket] : INSTANCE_IDLE_TTL_MS;
          // 空闲 TTL 只管剩下这档「声明不了属主、判不了进程生死」的自定义行
          // （启动器注入的临时 id 等）；codex 会话行用自己的 5 分钟档。稳定
          // 桌面行的生死走上面的进程家族判据，与空闲时长无关。
          if (idleTtlMs !== null && entry.state.activeRequests === 0 && now - lastSeen > idleTtlMs) {
            instMap.delete(instId);
            sessionRowFamilyMisses.delete(`${bucket}:${instId}`);
          }
        }
      }
      // Process-start placeholders: a scanned live PID with no bucket yet
      // gets a zero-count row immediately (process start → panel) instead of
      // the row appearing only when its first tagged request arrives.
      // Mirrors the claude placeholder sessions in getActiveClaudeSessions:
      // a real request with the same "<agentId>-<pid>" id takes the entry
      // over in startRequest, and once the process dies the reconciliation
      // above evicts it on the next read. codex and opencode are the
      // exceptions: their rows are session-scoped (traffic-born), so their
      // processes — codex's shared GUI engine, opencode's resident
      // `serve --service` — never spawn placeholder rows. A placeholder there
      // would sit beside the session row with a permanent 0 请求, and the
      // terminal panel (which reads its row by id) would show the empty one.
      if (bucket !== "codex" && bucket !== "opencode") {
        for (const pid of placeholderPids) {
          // 桌面宿主（dsh 宿主引擎 / kimi 桌面主进程）的占位行挂稳定 id：起进
          // 程即可见的那一行，就是请求将要落的那一行——换代换 pid 不换行。其
          // 余引擎照旧逐 pid 占位。
          const desktopSet = bucket === "dsh" ? procCounts.dshDesktopHostPids
            : bucket === "kimi" ? procCounts.kimiDesktopPids : null;
          const placeholderId = desktopSet instanceof Set && desktopSet.has(pid)
            ? (bucket === "dsh" ? DSH_DESKTOP_INSTANCE_ID : KIMI_DESKTOP_INSTANCE_ID)
            : `${bucket}-${pid}`;
          if (!instMap.has(placeholderId)) {
            const placeholder = { state: createAggregateState(sparkWindowPoints), firstSeen: now, label: null };
            if (placeholderId !== `${bucket}-${pid}`) {
              // 桌面占位行直接带代际锚起账：宿主 = 本 pid，dsh 连记父壳。这样
              // App 开着还没发过请求时，读取侧的代际结算与生死判据就有锚可用。
              ensureDesktopGen(placeholder);
              settleDesktopGenerationOnFold(bucket, placeholder, pid, procCounts);
            }
            instMap.set(placeholderId, placeholder);
          }
        }
      }
    }

    // Session-granular rows get user-readable titles from the endpoint's own
    // session scan (codex rollouts / opencode's db). Worth the walk only when
    // such a row is actually listed.
    const sessionRowTitles = { codex: null, opencode: null };
    for (const agentId of Object.keys(sessionRowTitles)) {
      const prefix = SESSION_ROW_PREFIXES[agentId];
      for (const instId of instanceBuckets[agentId].keys()) {
        if (instId.startsWith(prefix)) {
          sessionRowTitles[agentId] = await loadSessionInfo(agentId);
          break;
        }
      }
    }

    // DSH row badge: which surface (profile) the process behind this row is.
    // The row carries no client-side identity (see the instanceBuckets note),
    // so the profile comes from the same process-scan map that feeds the card
    // subline. An unreadable profile yields no badge instead of a guess.
    const dshInstanceSurface = (instId) => {
      // 稳定行无 pid 尾，面由行语义直接给出（折叠判据保证了进来的一定是
      // 桌面宿主流量）。
      if (instId === DSH_DESKTOP_INSTANCE_ID) return dshSurfaceLabel(DSH_DESKTOP_PROFILE);
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
      // 稳定行无 pid 尾，面由行语义直接给出（折叠判据保证了进来的一定是桌面
      // 主进程流量）。
      if (instId === KIMI_DESKTOP_INSTANCE_ID) return kimiSurfaceLabel("desktop");
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
                ? codexSessionRowTitle(instId, sessionRowTitles.codex)
                : bucket === "opencode" && instId.startsWith(OPENCODE_SESSION_ID_PREFIX)
                  ? opencodeSessionRowTitle(instId, sessionRowTitles.opencode)
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
        clientForm: s.clientForm ?? null,
        transport: s.transport ?? null,
        identitySource: s.identitySource ?? null,
        // 形态徽标：仅桌面合成行（claude-desktop）携带，贴 "Desktop"；
        // 逐 PID 的 CLI/未分型行不贴，外观与折叠前逐字一致。
        ...(s.surface ? { surface: claudeSurfaceLabel(s.surface) } : {}),
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
      let lastChainKey = null;
      for (const s of claudeRawSessions) {
        const model = typeof s.model === "string" && s.model ? s.model : null;
        if (!model) {
          // 无身份快照（自动路由节点待定 / 无流量）不抹掉「最近」：粘性字段由
          // reportSession 保留，渠道同理。
          if (typeof s.lastModel === "string" && s.lastModel) {
            last = s.lastModel;
            lastProvider = typeof s.lastProvider === "string" && s.lastProvider ? s.lastProvider : null;
            lastViaAuto = s.lastViaAuto === true;
            lastChainKey = typeof s.lastChainKey === "string" ? s.lastChainKey : null;
          }
          continue;
        }
        const providerId = typeof s.providerId === "string" && s.providerId ? s.providerId : null;
        const viaAuto = s.viaAuto === true;
        const chainKey = viaAuto && typeof s.chainKey === "string" ? s.chainKey : null;
        last = model;
        lastProvider = providerId;
        lastViaAuto = viaAuto;
        lastChainKey = chainKey;
        if (s.activeRequests > 0) {
          active.push(model);
          current = model;
          currentProvider = providerId;
          currentViaAuto = viaAuto;
          const key = `${providerId ?? ""}\u0000${model}`;
          const entry = targets.get(key) ?? { providerId, model, count: 0, autoCount: 0 };
          entry.count += s.activeRequests;
          if (viaAuto) entry.autoCount += s.activeRequests;
          if (chainKey) entry.chainKey = chainKey;
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
        lastChainKey,
        activeTargets: Array.from(targets.values()),
      };
    })();

    const claudeAgent = {
      id: "claude",
      name: "Claude Code",
      status: claudeIsRunning ? "running" : "stopped",
      processCount: claudeProcessCount,
      sessionMode: "per_instance",
      sessionsCount: claudeSessionsFormatted.length,
      sessions: claudeSessionsFormatted,
      // The card form summary and instance rows come from the same process
      // snapshot. Desktop's several helper processes are one logical group.
      surfaces: summarizeClaudeSurfaces(procCounts),
      // Claude now follows the same public instance contract as Kimi. The
      // legacy sessions field remains above for older panel consumers.
      instances: claudeSessionsFormatted,
      // 退役账：已消亡会话行的累计（退出过窗或 PID 复用吸收而来）。面板的全局
      // 汇总 = 活行 + 退役账；claude 家族全灭时随端点账一起归零。
      retiredMetrics: {
        requests: claudeRetiredLedger.requests,
        activeDurationMs: claudeRetiredLedger.activeDurationMs,
        promptTokens: claudeRetiredLedger.promptTokens,
        completionTokens: claudeRetiredLedger.completionTokens,
        cachedTokens: claudeRetiredLedger.cachedTokens,
        lastTtftMs: claudeRetiredLedger.lastTtftMs,
        lastSeen: claudeRetiredLedger.lastSeen,
      },
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
      // 链身份与 lastModel 配对：常驻桶优先（它填了才有 lastModel 的常驻来源），
      // 否则用 per-launch 会话派生值。
      lastChainKey: claudeState.lastModel !== null
        ? (claudeState.lastChainKey ?? null)
        : (claudeSessionsDerived.lastChainKey ?? null),
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
        name: "DeepSeek Harness",
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

    // Qoder Agent Status（汇总卡 + 实例桶；qodercli.exe 每终端一进程，kimi/grok
    // 同款多实例语义，实例号由 socket 反查合成 qoder-<pid>）
    const qoderAgent = buildAggregateAgentStatus({
      id: "qoder",
      name: "Qoder",
      state: qoderState,
      processCount: procCounts.qoder || 0,
      tpsWindow: recentSampleWindow,
      nowFn,
      instances: instanceSnapshots("qoder"),
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
    onActivity,
    offActivity,
    getModelStability: () => stability.snapshot(nowFn()),
    // Latest route-chain runtime dump per live per-launch session, in the
    // same { positions, nodes } shape buildChainRuntime merges — lets the
    // resident relay's /api/internal/route-chain-runtime see chain positions
    // held inside ephemeral per-launch relay processes.
    getReportedChainRuntime: () => Array.from(reportedChainStates.values()),
    scanProcesses,
    // 探针自己的账（spawns / scanTimeouts / optionalTimeouts / childKills /
    // lateAnswersDiscarded / consecutiveTimeouts）。只给日志和测试用，不进任何
    // 面板接口——这条链的可见性是运维凭据，不是给用户看的产品文案。
    getProbeStats: () => ({ ...psProbe.stats }),
    // Terminal-session attribution: live agent client pids + ancestor chains
    // from the cached scan (see the function's note above).
    getDetectedClientProcesses,
    // Session metas (raw ids) for the terminal join's session-granular bridge,
    // one getter per endpoint that mints session rows — shaped into row-id form
    // by the exposure layer.
    getCodexSessionsForTerminalJoin,
    getOpencodeSessionsForTerminalJoin,
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

// usage 归一：OpenAI 形状（prompt_tokens/completion_tokens）与 Anthropic 形状
// （input_tokens/output_tokens/cache_read_input_tokens）都能提出
// {prompt, completion, cached}。上游两种形状都会原样到达记账口（stream-pipe
// 的 Anthropic 上行、OpenAI 透传、会话 reporter），只认一种形状会让另一条
// 渠道的 token 恒记 0。session reporter 的 normalizedUsage 与本函数同口径。
function normalizeUsageTokens(usage) {
  if (!usage || typeof usage !== "object") return { prompt: 0, completion: 0, cached: 0 };
  return {
    prompt: Number(usage.prompt_tokens ?? usage.input_tokens) || 0,
    completion: Number(usage.completion_tokens ?? usage.output_tokens) || 0,
    cached: extractCachedTokens(usage),
  };
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
    if (attr?.model) {
      return {
        model: attr.model,
        providerId: attr.providerId ?? null,
        viaAuto: true,
        chainKey: typeof attr.chainKey === "string" ? attr.chainKey : null,
      };
    }
    const model = ctx.meta?.model;
    if (typeof model !== "string" || !model || model === AUTO_MODEL) return null;
    return { model, providerId: ctx.meta?.providerId ?? null, viaAuto: false, chainKey: null };
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
  const identityFingerprint = (ident) => (ident
    ? `${ident.providerId ?? ""}\u0000${ident.model}\u0000${ident.viaAuto}\u0000${ident.chainKey ?? ""}`
    : "");
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
          chainKey: ident?.chainKey ?? null,
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
    const norm = normalizeUsageTokens(usage);
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
          // Terminal-attribution identity, `<agentId>-<pid>`: the same key
          // the panel's session row id and the attribution join use, so a
          // bound terminal's request tail matches its own rows. Absent until
          // the launcher declares its pid (setClaudePid) — claiming no
          // identity beats claiming the wrong process's.
          ...(claudePid ? { instanceId: `${agentId}-${claudePid}` } : {}),
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
          // 与常驻 collector 写点同款：仅失败行携带上游错误原文，消毒在 journal 侧。
          ...(hadError ? { errMsg: error?.message ?? null } : {}),
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
