// Terminal-session attribution — pure join/filter helpers shared by the panel
// router. Terminal-host session snapshots carry the real shell pid; the
// relay's detected-client-processes feed lists each live agent client pid with
// its ancestor chain (walked up the process-scan lineage table). A session is
// attributed when its shell pid appears in a client process's ancestor chain.
// Ownership is process-and-instance only (virtual-terminal-preview-notes.md
// 「会话归属模型」): nothing here parses terminal output text.

// Windows-path key for cwd matching: lowercase, one separator, no trailing
// slash. A terminal session's cwd and a codex rollout's project cwd name the
// same directory with different separator/case spellings.
function cwdKey(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "" ? null : normalized;
}

// Codex bridge: codex's instance rows are session-granular codex-sess-<id>
// (GUI sessions deliberately share one engine process, so "<agentId>-<pid>"
// rows cannot exist for it — the join's canonical shape never binds codex).
// The relay's codexSessions feed (row-id-shaped ids with cwd/lastActive/
// originator, from the on-disk session scan) bridges the gap: a codex
// terminal session binds the most-recently-active codex session whose cwd
// matches the session's. Desktop-originated sessions are excluded (their
// originator carries "desktop") so a GUI session in the same directory cannot
// steal the binding. The residual ambiguity is two concurrent CLI sessions in
// one cwd — both bind the latest-active one, the other waits until it becomes
// the most recent; the endpoint-level card aggregates both regardless.
// Only rows that exist in the agents payload bind, mirroring the pid path.
function codexSessionInstanceIdFor(cwd, codexSessions, instanceRow) {
  const key = cwdKey(cwd);
  if (key === null) return null;
  let best = null;
  for (const meta of codexSessions) {
    if (!meta || typeof meta.id !== "string") continue;
    if (cwdKey(meta.cwd) !== key) continue;
    if (String(meta.originator ?? "").toLowerCase().includes("desktop")) continue;
    if (!instanceRow.has(`codex:${meta.id}`)) continue;
    const lastActive = typeof meta.lastActive === "number" && Number.isFinite(meta.lastActive) ? meta.lastActive : 0;
    if (best === null || lastActive > best.lastActive || (lastActive === best.lastActive && meta.id < best.id)) {
      best = { id: meta.id, lastActive };
    }
  }
  return best === null ? null : best.id;
}

// Join terminal sessions with detected client processes + the agents payload.
//   sessions: terminal-host snapshots ({ id, pid, ... }) — NOT mutated.
//   detected: [{ agentId, pid, ancestors: [pid, ...] }] | null (relay feed)
//   agents:   [{ id, name, instances?: [{ id, ... }], sessions?: [{ id, ... }] }]
//             (display names + the pid-tailed rows that decide instanceId
//             binding; Claude publishes both `instances` and legacy `sessions`)
//   codexSessions: [{ id, cwd, lastActive, originator }] | null (relay feed;
//             the codex bridge above; absent/empty on old relays)
// Returns a NEW array; each attributed session gains
//   agent: { endpointId, name, pid, instanceId | null }
// instanceId binds only when a matching row exists in the agents payload's
// instances or sessions: the pid-shaped "<agentId>-<pid>" row for every
// endpoint but codex, and — for codex only, after the pid shape misses — the
// bridged codex-sess-<id> row (see codexSessionInstanceIdFor). Codex ships no
// placeholder rows, so a freshly detected codex client attributes with
// instanceId null until its first request materializes one. Sessions whose
// shell pid matches no ancestor chain, and all sessions when `detected` is
// null/empty, pass through unannotated.
export function attributeTerminalSessions(sessions, detected, agents, codexSessions = null) {
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
  const codexFeed = Array.isArray(codexSessions) ? codexSessions : [];
  return sessions.map((session) => {
    if (!session || !Number.isFinite(session.pid)) return session;
    const candidates = byAncestor.get(session.pid);
    if (!candidates || candidates.length === 0) return session;
    candidates.sort((a, b) => a.distance - b.distance);
    const best = candidates[0];
    const canonicalId = `${best.agentId}-${best.pid}`;
    let instanceId = instanceRow.has(`${best.agentId}:${canonicalId}`) ? canonicalId : null;
    if (instanceId === null && best.agentId === "codex" && codexFeed.length > 0) {
      instanceId = codexSessionInstanceIdFor(session.cwd, codexFeed, instanceRow);
    }
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
