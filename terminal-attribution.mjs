// Terminal-session attribution — pure join/filter helpers shared by the panel
// router. Terminal-host session snapshots carry the real shell pid; the
// relay's detected-client-processes feed lists each live agent client pid with
// its ancestor chain (walked up the process-scan lineage table). A session is
// attributed when its shell pid appears in a client process's ancestor chain.
// Ownership is process-and-instance only (virtual-terminal-preview-notes.md
// 「会话归属模型」): nothing here parses terminal output text.

// Join terminal sessions with detected client processes + the agents payload.
//   sessions: terminal-host snapshots ({ id, pid, ... }) — NOT mutated.
//   detected: [{ agentId, pid, ancestors: [pid, ...] }] | null (relay feed)
//   agents:   [{ id, name, instances?: [{ id, ... }] }] | null (display names
//             + the pid-tailed instance rows that decide instanceId binding)
// Returns a NEW array; each attributed session gains
//   agent: { endpointId, name, pid, instanceId | null }
// instanceId binds only when a matching "<agentId>-<pid>" instance row exists
// in the agents payload — codex ships no placeholder rows, so a freshly
// detected codex client attributes with instanceId null until its first
// request materializes one. Sessions whose shell pid matches no ancestor
// chain, and all sessions when `detected` is null/empty, pass through
// unannotated.
export function attributeTerminalSessions(sessions, detected, agents) {
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
    }
  }
  return sessions.map((session) => {
    if (!session || !Number.isFinite(session.pid)) return session;
    const candidates = byAncestor.get(session.pid);
    if (!candidates || candidates.length === 0) return session;
    candidates.sort((a, b) => a.distance - b.distance);
    const best = candidates[0];
    const canonicalId = `${best.agentId}-${best.pid}`;
    return {
      ...session,
      agent: {
        endpointId: best.agentId,
        name: agentName.get(best.agentId) ?? best.agentId,
        pid: best.pid,
        instanceId: instanceRow.has(`${best.agentId}:${canonicalId}`) ? canonicalId : null,
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
