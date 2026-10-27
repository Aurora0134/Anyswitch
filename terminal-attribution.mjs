// Terminal-session attribution — pure join/filter helpers shared by the panel
// router. Terminal-host session snapshots carry the real shell pid; the
// relay's detected-client-processes feed lists each live agent client pid with
// its ancestor chain (walked up the process-scan lineage table). A session is
// attributed when its shell pid appears in a client process's ancestor chain.
// Ownership is process-and-instance only (virtual-terminal-preview-notes.md
// 「会话归属模型」): nothing here parses terminal output text.

// Endpoints whose instance rows are session-granular (see sessionRowInstanceIdFor).
const SESSION_ROW_AGENT_IDS = Object.freeze(["codex", "opencode"]);
// Of those, the endpoints whose session row beats a pid-shaped row when both
// exist (see the priority note in attributeTerminalSessions).
const SESSION_ROW_FIRST_AGENT_IDS = new Set(["opencode"]);

// Windows-path key for cwd matching: lowercase, one separator, no trailing
// slash. A terminal session's cwd and a codex rollout's project cwd name the
// same directory with different separator/case spellings.
function cwdKey(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "" ? null : normalized;
}

// Session-row bridge: codex and opencode mint session-granular instance rows
// (<agent>-sess-<session id>) because the process behind their traffic is
// shared across sessions — codex's GUI engine, opencode's resident
// `serve --service` — so the join's canonical "<agentId>-<pid>" shape can never
// bind them. The relay's per-endpoint session feeds (row-id-shaped ids with
// cwd/lastActive/originator, from the on-disk session scan) bridge the gap: a
// terminal session binds the most-recently-active session of that endpoint
// whose cwd matches the session's. Desktop-originated sessions are excluded
// (their originator carries "desktop") so a GUI session in the same directory
// cannot steal the binding. The residual ambiguity is two concurrent CLI
// sessions in one cwd — both bind the latest-active one, the other waits until
// it becomes the most recent; the endpoint-level card aggregates both
// regardless. Only rows that exist in the agents payload bind, mirroring the
// pid path.
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
// directory (project switching / restoring the last project — live forensics
// 2026-10-27: terminal launched at Desktop\agent-home, the TUI's live session
// belonged to an Anyswitch worktree), so the cwd bridge misses exactly the
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
//   sessionFeeds: { codex?: [...], opencode?: [...] } | null (relay feed;
//             the session-row bridges above; absent/empty on old relays)
// Returns a NEW array; each attributed session gains
//   agent: { endpointId, name, pid, instanceId | null }
// instanceId binds only when a matching row exists in the agents payload's
// instances or sessions: the pid-shaped "<agentId>-<pid>" row for every
// endpoint but the session-row ones, and — for codex and opencode only, after
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
      const entry = { agentId: proc.agentId, pid: proc.pid, distance: index + 1 };
      if (list) list.push(entry);
      else byAncestor.set(ancestorPid, [entry]);
    }
  }
  const agentName = new Map();
  const instanceRow = new Map(); // `${agentId}:${instanceId}` presence
  if (Array.isArray(agents)) {
    for (const agent of agents) {
      if (!agent || typeof agent.id !== "string") continue;
      if (typeof agent.name === "string" && agent.name.length > 0) agentName.set(agent.id, agent.name);
      for (const inst of Array.isArray(agent.instances) ? agent.instances : []) {
        if (inst && typeof inst.id === "string") instanceRow.set(`${agent.id}:${inst.id}`, true);
      }
      for (const sess of Array.isArray(agent.sessions) ? agent.sessions : []) {
        if (sess && typeof sess.id === "string") instanceRow.set(`${agent.id}:${sess.id}`, true);
      }
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
    const pidRowId = instanceRow.has(`${best.agentId}:${canonicalId}`) ? canonicalId : null;
    const feed = feeds[best.agentId];
    const bridgedId = feed !== undefined && feed.length > 0
      ? sessionRowInstanceIdFor(session.cwd, feed, instanceRow)
      : null;
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
export function filterTerminalRequestRows(rows, { agentId, instanceId } = {}, limit = 10) {
  if (!Array.isArray(rows) || typeof agentId !== "string" || agentId.length === 0) return [];
  const bound = typeof instanceId === "string" && instanceId.length > 0 ? instanceId : null;
  const out = [];
  for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    const row = rows[i];
    if (!row || row.agentId !== agentId) continue;
    if (bound !== null && row.instanceId !== bound) continue;
    out.push(row);
  }
  return out;
}
