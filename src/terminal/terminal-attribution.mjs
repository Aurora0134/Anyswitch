// Terminal-session attribution — pure join/filter helpers shared by the panel
// router. Terminal-host session snapshots carry the real shell pid; the
// relay's detected-client-processes feed lists each live agent client pid with
// its ancestor chain (walked up the process-scan lineage table). A session is
// attributed when its shell pid appears in a client process's ancestor chain.
// Ownership is process-and-instance only (virtual-terminal-preview-notes.md
// 「会话归属模型」): nothing here parses terminal output text.
//
// Each detected entry may also carry `busy` — the relay's verdict on whether
// that client's process tree holds a running command, computed with the same
// predicate the switch guard probes with (see terminal-switch-guard.mjs). It
// rides through to `agent.busy` so the panel's working determination can see
// the phase the relay metrics are blind to: the agent has finished its turn
// but a process it spawned is still running. true / false when the scan could
// read command lines, null when it could not (degraded round) — never a guess.

// Endpoints whose instance rows are session-granular (see sessionRowInstanceIdFor).
const SESSION_ROW_AGENT_IDS = Object.freeze(["codex", "opencode", "workbuddy", "zcode"]);
// Of those, the endpoints whose session row beats a pid-shaped row when both
// exist (see the priority note in attributeTerminalSessions).
// workbuddy 同 opencode：它的 pid 形行是 socket 兜底合成（runtime 是池化的，
// 同一会话换 pid 不换行），pid 形行的语义是「某个 runtime 进程」，而会话行
// 才是「哪条对话」——会话行是更准的答案，优先。
// zcode 不在此列：它不进 socket 兜底白名单（late-socket-instance.mjs），pid
// 形行从不存在，pidRowId 恒 null，先后次序无从谈起。
const SESSION_ROW_FIRST_AGENT_IDS = new Set(["opencode", "workbuddy"]);

// Windows-path key for cwd matching: lowercase, one separator, no trailing
// slash. A terminal session's cwd and a codex rollout's project cwd name the
// same directory with different separator/case spellings.
function cwdKey(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "" ? null : normalized;
}

// Session-row bridge: codex, opencode and zcode mint session-granular instance
// rows (<agent>-sess-<session id>) because the pid-shaped canonical join can
// never name their conversations — codex's traffic runs in a GUI engine shared
// across sessions, opencode's in a resident `serve --service`, and zcode 从不
// 产 pid 形行（relay 按请求头 x-session-id 铸会话行，进程身份对它没有实例
// 语义）. The relay's per-endpoint session feeds (row-id-shaped ids with
// cwd/lastActive/originator, from the on-disk session scan) bridge the gap.
// The match rule splits by endpoint. codex/opencode: a terminal session binds
// the most-recently-active session of that endpoint whose cwd matches the
// terminal's. Desktop-originated sessions are excluded (their originator
// carries "desktop") so a GUI session in the same directory cannot steal the
// binding. The residual ambiguity is two concurrent CLI sessions in one cwd —
// both bind the latest-active one, the other waits until it becomes the most
// recent; the endpoint-level card aggregates both regardless. zcode binds
// exactly instead: the terminal's own resume.id names the row directly
// (zcodeResumeRowId), and only when that misses does a cwd fallback run —
// which binds only on a unique match (zcodeCwdRowId; same-cwd rows are the
// norm there and picking by recency would be a guess), so two same-cwd
// sessions never both collapse onto the latest-active one under zcode. Only
// rows that exist in the agents payload bind, mirroring the pid path.
// opencode 2.1.x breaks the cwd premise itself (see soleInteractiveTui): its
// TUI can display a session in any project, so the recency rule supersedes the
// cwd match there while it is the machine's only TUI.
function sessionRowInstanceIdFor(cwd, feed, instanceRow) {
  const key = cwdKey(cwd);
  if (key === null) return null;
  let best = null;
  for (const meta of feed) {
    if (!meta || typeof meta.id !== "string") continue;
    if (cwdKey(meta.cwd) !== key) continue;
    if (String(meta.originator ?? "").toLowerCase().includes("desktop")) continue;
    if (!instanceRow.has(`${meta.agentId}:${meta.id}`)) continue;
    const lastActive = typeof meta.lastActive === "number" && Number.isFinite(meta.lastActive) ? meta.lastActive : 0;
    if (best === null || lastActive > best.lastActive || (lastActive === best.lastActive && meta.id < best.id)) {
      best = { id: meta.id, lastActive };
    }
  }
  return best === null ? null : best.id;
}

// zcode 的会话行 id 与请求路径同源的构造规则：resume.id 是客户端原始值（带
// sess_ / subagent_agent_ 内部前缀），relay 铸行前会把这两个前缀顺序各剥一次再
// 清洗字符集。这里逐字复刻，只用于「拿终端自带的身份去 instanceRow 里精确查」，
// 对不上就返回 null（不命中比错绑安全）。规则出处见 relay/openai-server.mjs 的
// zcodeSessionRowIdForJoin / sessionRowId。
const ZCODE_SESSION_INTERNAL_PREFIXES = ["sess_", "subagent_agent_"];
const ZCODE_SESSION_ROW_PREFIX = "zcode-sess-";
const INSTANCE_ID_MAX_LEN = 64;
function zcodeSessionRowIdForJoin(rawId) {
  if (typeof rawId !== "string") return null;
  let id = rawId;
  for (const prefix of ZCODE_SESSION_INTERNAL_PREFIXES) {
    if (id.startsWith(prefix) && id.length > prefix.length) id = id.slice(prefix.length);
  }
  const cleaned = id.trim().replace(/[^A-Za-z0-9._:-]+/g, "-");
  if (cleaned.length === 0) return null;
  const rowId = ZCODE_SESSION_ROW_PREFIX + cleaned.slice(0, INSTANCE_ID_MAX_LEN - ZCODE_SESSION_ROW_PREFIX.length);
  if (rowId.length > INSTANCE_ID_MAX_LEN || !/^[A-Za-z0-9._:-]+$/.test(rowId)) return null;
  return rowId;
}

// 终端的续接身份就是「这条终端在跑哪段会话」的正源：能精确命中时，优先于任何
// cwd 猜测。endpoint 必须同为 zcode——resume 是跨端点共用的字段，别的端点的
// 会话 id 在 zcode 行里必然查不到，先挡掉免得白查。
function zcodeResumeRowId(session, instanceRow) {
  const resume = session?.resume;
  if (!resume || resume.endpoint !== "zcode") return null;
  const rowId = zcodeSessionRowIdForJoin(resume.id);
  if (rowId === null) return null;
  return instanceRow.has(`zcode:${rowId}`) ? rowId : null;
}

// actor / subagent 行是**辅助执行者**，不是用户在这条终端里打开的会话：现场
// 1058 行里 254 条 actor 行，且它们恰好最热、originator 为 null——按 cwd+最近
// 活跃挑必中它们（M13 已复现 activeRequests=8 抢绑）。它们一律不参与 cwd 兜底。
function isZcodeAuxiliaryRow(id) {
  const lower = id.toLowerCase();
  return lower.endsWith("-actor") || lower.includes("subagent");
}

// zcode 的 cwd 兜底：排除 actor/subagent 与 desktop 行后，**唯一**命中才绑。
// 多行同 cwd 是同机多会话的常态，按最近活跃挑就是猜——判不准返回 null，与
// 「归属判不准不猜」的既有裁决一致。
function zcodeCwdRowId(cwd, feed, instanceRow) {
  const key = cwdKey(cwd);
  if (key === null) return null;
  const matches = new Set();
  for (const meta of feed) {
    if (!meta || typeof meta.id !== "string") continue;
    if (cwdKey(meta.cwd) !== key) continue;
    if (String(meta.originator ?? "").toLowerCase().includes("desktop")) continue;
    if (isZcodeAuxiliaryRow(meta.id)) continue;
    if (!instanceRow.has(`zcode:${meta.id}`)) continue;
    matches.add(meta.id);
  }
  return matches.size === 1 ? matches.values().next().value : null;
}

// Recency pick over one endpoint's session feed: the most-recently-active row
// that exists in the agents payload (ties on lastActive resolve by id, same as
// the cwd bridge). Used by the sole-owner fallback below.
function latestActiveSessionRowId(feed, instanceRow) {
  let best = null;
  for (const meta of feed) {
    if (!meta || typeof meta.id !== "string") continue;
    if (String(meta.originator ?? "").toLowerCase().includes("desktop")) continue;
    if (!instanceRow.has(`${meta.agentId}:${meta.id}`)) continue;
    const lastActive = typeof meta.lastActive === "number" && Number.isFinite(meta.lastActive) ? meta.lastActive : 0;
    if (best === null || lastActive > best.lastActive || (lastActive === best.lastActive && meta.id < best.id)) {
      best = { id: meta.id, lastActive };
    }
  }
  return best === null ? null : best.id;
}

// Whether this terminal session runs every interactive opencode TUI on the
// machine. opencode 2.1.x decoupled a TUI's session directory from its launch
// directory (project switching / restoring the last project — the terminal's
// launch directory and the live session's project differ), so the cwd bridge
// misses exactly the
// sessions a user is working in and the right rail falls empty. When a single
// TUI exists it owns every session row of the endpoint — the most recently
// active one is the session it is displaying. With a second TUI running the
// recency answer could name the other terminal's session, so the bridge stays
// cwd-only and unbound rather than guessing.
function soleInteractiveTui(detected, candidates, agentId) {
  let total = 0;
  let mine = 0;
  for (const proc of detected) {
    if (!proc || proc.agentId !== agentId || !Number.isFinite(proc.pid)) continue;
    total += 1;
    if (candidates.some((entry) => entry.agentId === agentId && entry.pid === proc.pid)) mine += 1;
  }
  return mine > 0 && mine === total;
}

// Join terminal sessions with detected client processes + the agents payload.
//   sessions: terminal-host snapshots ({ id, pid, ... }) — NOT mutated.
//   detected: [{ agentId, pid, ancestors: [pid, ...] }] | null (relay feed)
//   agents:   [{ id, name, instances?: [{ id, ... }], sessions?: [{ id, ... }] }]
//             (display names + the pid-tailed rows that decide instanceId
//             binding; Claude publishes both `instances` and legacy `sessions`)
//   sessionFeeds: { codex?: [...], opencode?: [...], zcode?: [...] } | null
//             (relay feed; the session-row bridges above; absent/empty on old relays)
// Returns a NEW array; each attributed session gains
//   agent: { endpointId, name, pid, instanceId | null }
// instanceId binds only when a matching row exists in the agents payload's
// instances or sessions: the pid-shaped "<agentId>-<pid>" row for every
// endpoint but the session-row ones, and — for the session-row endpoints, after
// the pid shape misses — the bridged <agent>-sess-<id> row (see
// sessionRowInstanceIdFor). Neither ships placeholder rows, so a freshly
// detected client attributes with instanceId null until its first request
// materializes one. Sessions whose shell pid matches no ancestor chain, and all
// sessions when `detected` is null/empty, pass through unannotated.
export function attributeTerminalSessions(sessions, detected, agents, sessionFeeds = null) {
  if (!Array.isArray(sessions)) return [];
  if (!Array.isArray(detected) || detected.length === 0) return sessions.slice();
  // shell pid -> candidate clients, tagged with their hop distance from the
  // shell (direct child = 1). Two clients under one shell resolve to the
  // nearest; a distance tie keeps detected order.
  const byAncestor = new Map();
  for (const proc of detected) {
    if (!proc || typeof proc.agentId !== "string" || !Number.isFinite(proc.pid)) continue;
    const ancestors = Array.isArray(proc.ancestors) ? proc.ancestors : [];
    for (let index = 0; index < ancestors.length; index++) {
      const ancestorPid = ancestors[index];
      if (!Number.isFinite(ancestorPid)) continue;
      const list = byAncestor.get(ancestorPid);
      const entry = { agentId: proc.agentId, pid: proc.pid, distance: index + 1, busy: proc.busy ?? null };
      if (list) list.push(entry);
      else byAncestor.set(ancestorPid, [entry]);
    }
  }
  const agentName = new Map();
  const instanceRow = new Map(); // `${agentId}:${instanceId}` presence
  // 折叠行的成员 pid → 行 id（claude 会话行 / claude-desktop 合成行携带
  // memberPids）：pid 形 canonical id 查不到行时，按成员进程反查折叠行——
  // 折叠后行 id 是会话身份，join 手里的进程号必须先映回行身份。
  const memberPidRow = new Map(); // `${agentId}:${pid}` -> row id
  const indexRow = (agentId, row) => {
    if (!row || typeof row.id !== "string") return;
    instanceRow.set(`${agentId}:${row.id}`, true);
    if (Array.isArray(row.memberPids)) {
      for (const pid of row.memberPids) {
        if (Number.isInteger(pid) && !memberPidRow.has(`${agentId}:${pid}`)) {
          memberPidRow.set(`${agentId}:${pid}`, row.id);
        }
      }
    }
  };
  if (Array.isArray(agents)) {
    for (const agent of agents) {
      if (!agent || typeof agent.id !== "string") continue;
      if (typeof agent.name === "string" && agent.name.length > 0) agentName.set(agent.id, agent.name);
      // claude 的行在 sessions 桶（不产 instances），其余 agent 在 instances——
      // 两个桶都可能携带折叠行，memberPids 索引必须都建。
      for (const inst of Array.isArray(agent.instances) ? agent.instances : []) indexRow(agent.id, inst);
      for (const sess of Array.isArray(agent.sessions) ? agent.sessions : []) indexRow(agent.id, sess);
    }
  }
  const feeds = {};
  for (const agentId of SESSION_ROW_AGENT_IDS) {
    const feed = Array.isArray(sessionFeeds?.[agentId]) ? sessionFeeds[agentId] : [];
    feeds[agentId] = feed.map((meta) => (meta && typeof meta === "object" ? { ...meta, agentId } : meta));
  }
  return sessions.map((session) => {
    if (!session || !Number.isFinite(session.pid)) return session;
    const candidates = byAncestor.get(session.pid);
    if (!candidates || candidates.length === 0) return session;
    candidates.sort((a, b) => a.distance - b.distance);
    const best = candidates[0];
    const canonicalId = `${best.agentId}-${best.pid}`;
    const pidRowId = instanceRow.has(`${best.agentId}:${canonicalId}`)
      ? canonicalId
      : (memberPidRow.get(`${best.agentId}:${best.pid}`) ?? null);
    const feed = feeds[best.agentId];
    // zcode 走精确绑定：终端自带的 resume.id 命中优先（feed 有没有都能用）；未命中
    // 才走「排除 actor/subagent 后唯一 cwd」兜底，判不准返回 null。其它端点保持
    // 原行为一字不变。
    let bridgedId = null;
    if (best.agentId === "zcode") {
      const resumeId = zcodeResumeRowId(session, instanceRow);
      bridgedId = resumeId ?? (feed !== undefined && feed.length > 0 ? zcodeCwdRowId(session.cwd, feed, instanceRow) : null);
    } else if (feed !== undefined && feed.length > 0) {
      bridgedId = sessionRowInstanceIdFor(session.cwd, feed, instanceRow);
    }
    // opencode only: when this terminal runs the machine's only interactive
    // TUI, recency is the authoritative answer (see soleInteractiveTui) and
    // beats a cwd match — the TUI may be working in a session whose directory
    // is not the shell's, and a stale same-cwd row would freeze the rail on
    // another project's numbers. Other session-row endpoints keep cwd-only.
    const sessionRowId = best.agentId === "opencode" && soleInteractiveTui(detected, candidates, "opencode")
      ? (latestActiveSessionRowId(feed ?? [], instanceRow) ?? bridgedId)
      : bridgedId;
    // Which shape wins when both exist depends on what a pid row means there.
    // codex: a codex-<pid> row only ever comes from launcher-tagged traffic, so
    // it names the session that actually ran in that process — keep it first.
    // opencode: its pid row is the resident service's placeholder (the process
    // that started opencode, which never carries the conversation's requests),
    // so the bridged session row is strictly the more accurate answer.
    const instanceId = SESSION_ROW_FIRST_AGENT_IDS.has(best.agentId)
      ? (sessionRowId ?? pidRowId)
      : (pidRowId ?? sessionRowId);
    return {
      ...session,
      agent: {
        endpointId: best.agentId,
        name: agentName.get(best.agentId) ?? best.agentId,
        pid: best.pid,
        instanceId,
        // 「这个 agent 的进程树里有没有正在执行的命令」。面板的 working 判定原本
        // 只有「在途请求＋PTY 输出窗＋回合闸」，对「回合已结束、agent 留下的子进
        // 程还在跑」完全失明——那一刻面板显示空闲，而内切杀前探测探到活子进程就
        // 拒换（409），前端静默新开页签。这一位把守卫同源判据补进面板的视野。
        // null（降级轮读不出命令行）时不猜，面板回落既有信号。
        busy: best.busy ?? null,
      },
    };
  });
}

// Tail of today's usage-journal request rows for one terminal attribution.
// Rows are append-ordered (oldest first); the newest `limit` matching rows
// come back newest-first, raw (the frontend owns display shaping).
//   instanceId: strict filter when given (bound instance only); absent rows
//               (clients that never declared an id) never match — an
//               attributed-but-unbound session (codex pre-traffic) therefore
//               gets an empty list instead of someone else's requests.
//   instanceIds: 集合形过滤（会话折叠行的成员键）：journal 账目是逐进程的，
//               折叠行的请求分布在其全部成员的 pid 键下，任一命中即算本行。
//               与 instanceId 同传时两键并集生效。
export function filterTerminalRequestRows(rows, { agentId, instanceId, instanceIds } = {}, limit = 10) {
  if (!Array.isArray(rows) || typeof agentId !== "string" || agentId.length === 0) return [];
  const boundSet = new Set();
  if (typeof instanceId === "string" && instanceId.length > 0) boundSet.add(instanceId);
  if (Array.isArray(instanceIds)) {
    for (const id of instanceIds) {
      if (typeof id === "string" && id.length > 0) boundSet.add(id);
    }
  }
  const out = [];
  for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    const row = rows[i];
    if (!row || row.agentId !== agentId) continue;
    if (boundSet.size > 0 && !boundSet.has(row.instanceId)) continue;
    out.push(row);
  }
  return out;
}
