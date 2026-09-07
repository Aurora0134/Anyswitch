// Follow-agent auto-heal watcher.
//
// When the user enables "跟随 Coding Agent 启动" in settings.json (followAgent),
// this watcher polls every few seconds: if any coding agent (ZCode, Claude
// Code, OpenCode, DSH) is running AND the relay (47821) is down,
// it silently starts the relay. This revives the relay even with no human at
// the panel — opening a coding agent brings the link back in milliseconds.
//
// All external capabilities (process scan, relay start, relay status, settings
// read) are INJECTED, so this module has no hard imports and is trivially
// testable. The polling timer is unref'd so it never keeps the event loop
// alive on its own.

const DEFAULT_INTERVAL_MS = 3000;

export function createAgentWatcher({
  root,
  scanProcesses,
  startRelay,
  getRelayStatus,
  loadSettings,
  intervalMs = DEFAULT_INTERVAL_MS,
  logger,
}) {
  let timer = null;
  let inFlight = false;

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      let settings = {};
      try {
        settings = loadSettings(root)?.settings ?? {};
      } catch {
        return;
      }
      if (!settings.followAgent) return;

      const procs = scanProcesses();
      const anyAgent = (procs?.zcode || 0) + (procs?.claude || 0) + (procs?.opencode || 0) + (procs?.dsh || 0) + (procs?.pi || 0) + (procs?.kimi || 0) + (procs?.reasonix || 0) > 0;
      if (!anyAgent) return;

      const relay = await getRelayStatus();
      if (relay?.status === "running") return;

      logger?.info("followAgent: coding agent running and relay down; auto-starting relay");
      try {
        await startRelay();
      } catch (err) {
        logger?.error(`followAgent auto-start failed: ${err.message}`);
      }
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
    timer.unref();
    // Fire once immediately so we don't wait a full interval on startup.
    tick().catch(() => {});
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tick };
}
