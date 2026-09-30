import { sanitizeInstanceId } from "./agent-metrics.mjs";

// Endpoints whose per-process rows come from the netstat reverse lookup when
// no x-agent-instance header is present. dsh joins on the same basis kimi/pi/
// opencode have: each DSH surface (web UI, TUI, custom profile) is its own
// process holding its own keep-alive connection to the loopback relay, and it
// sends no instance header of its own — the terminal user launches `dsh`/`dst`,
// not an Anyswitch launcher. zcode stays aggregate-only.
//
// claude joins because its desktop app never crosses our launcher: the app
// points its gateway at the resident relay itself (no per-launch relay, hence no
// session reporter), so the reverse lookup is the only way to tell which claude
// process a resident request belongs to. Requests from a launcher-started Claude
// Code still arrive on their own per-launch relay and keep their reporter rows;
// a request whose owner cannot be resolved stays on the aggregate bucket, and
// the card falls back to the process scan for liveness (unchanged behavior).
const SOCKET_FALLBACK_AGENT_IDS = new Set(["dsh", "kimi", "opencode", "pi", "codex", "grok", "claude"]);

export function instanceIdFromSocket(req, agentId, deps) {
  if (!deps.socketOwner || !SOCKET_FALLBACK_AGENT_IDS.has(agentId ?? "")) return null;
  const pid = deps.socketOwner.lookup({ localPort: req.socket.localPort, remotePort: req.socket.remotePort });
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0 || pid === process.pid) return null;
  return sanitizeInstanceId(`${agentId}-${pid}`) ?? null;
}

// First-request netstat miss: startRequest already ran with no instanceId.
// Subscribe once to the shared snapshot refresh and attach the in-flight
// tracker if a PID appears before the request ends. Header-tagged requests
// never subscribe. Unsub on first hit and when the caller unbinds so a
// keep-alive socket cannot leak listeners.
export function bindLateSocketInstance(req, agentId, deps, tracker, options = {}) {
  if (!tracker?.attachInstance) return () => {};
  if (options.explicitId) return () => {};
  if (!deps.socketOwner?.onRefresh || !SOCKET_FALLBACK_AGENT_IDS.has(agentId ?? "")) return () => {};
  let unsub = () => {};
  const stop = () => { unsub(); };
  const tryAttach = () => {
    const id = instanceIdFromSocket(req, agentId, deps);
    if (id === null) return;
    tracker.attachInstance(id);
    stop();
  };
  unsub = deps.socketOwner.onRefresh(tryAttach);
  const originalEnd = tracker.recordEnd;
  tracker.recordEnd = (arg) => {
    stop();
    return originalEnd?.(arg);
  };
  tryAttach();
  return stop;
}
