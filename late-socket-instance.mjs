import { sanitizeInstanceId } from "./agent-metrics.mjs";

// Endpoints whose per-process rows come from the netstat reverse lookup when
// no x-agent-instance header is present. dsh joins on the same basis kimi/pi/
// opencode have: each DSH surface (web UI, TUI, custom profile) is its own
// process holding its own keep-alive connection to the loopback relay, and it
// sends no instance header of its own — the terminal user launches `dsh`/`dst`,
// not an Anyswitch launcher. zcode stays aggregate-only.
// qoder joins from the client side for the same reason: its provider config
// (settings.json openai-compatible connections) cannot carry custom request
// headers, so the CLI's keep-alive connection is its only instance identity —
// without the fallback the virtual terminal's Qoder sessions never bind an
// instance row (2026-10-15 forensics; the terminal one-click launch ships no
// tag either, so the synthesized qoder-<pid> is the row the process scan and
// the terminal join both key on). This set mirrors agent-metrics' instanceBuckets.
//
// claude joins because its desktop app never crosses our launcher: the app
// points its gateway at the resident relay itself (no per-launch relay, hence no
// session reporter), so the reverse lookup is the only way to tell which claude
// process a resident request belongs to. Requests from a launcher-started Claude
// Code still arrive on their own per-launch relay and keep their reporter rows;
// a request whose owner cannot be resolved stays on the aggregate bucket, and
// the card falls back to the process scan for liveness (unchanged behavior).
const SOCKET_FALLBACK_AGENT_IDS = new Set(["dsh", "kimi", "opencode", "pi", "codex", "grok", "qoder", "claude"]);

// pi 的 x-agent-instance 头值对折进程身份没有贡献：models.json 落静态值
//（sync 写盘为 direct；launcher 拉起时改写成 <cwd>-<pid> 实例值、退出恢复——
// pi-merge-models.mjs），即使改写生效 relay 也忽略头值，实例身份以连接属主进
// 程为唯一来源；socket 未解析时按无身份处理，走 bindLateSocketInstance 迟到绑定。
export const SOCKET_OVERRIDE_AGENT_IDS = new Set(["pi"]);

export function instanceIdFromSocket(req, agentId, deps) {
  if (!deps.socketOwner || !SOCKET_FALLBACK_AGENT_IDS.has(agentId ?? "")) return null;
  const pid = deps.socketOwner.lookup({ localPort: req.socket.localPort, remotePort: req.socket.remotePort });
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0 || pid === process.pid) return null;
  return sanitizeInstanceId(`${agentId}-${pid}`) ?? null;
}

// First-request netstat miss: startRequest already ran with no instanceId.
// Subscribe once to the shared snapshot refresh and attach the in-flight
// tracker if a PID appears before the request ends. options.explicitId 是
// 调用方在请求开始时算出的最终身份（override 端点即 socket 归一结果，不是
// 头值）——已有身份不订阅，无身份才等快照。Unsub on first hit and when the
// caller unbinds so a keep-alive socket cannot leak listeners.
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
