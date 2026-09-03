import { sanitizeInstanceId } from "./agent-metrics.mjs";

const SOCKET_FALLBACK_AGENT_IDS = new Set(["kimi", "opencode", "pi", "agy"]);

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
