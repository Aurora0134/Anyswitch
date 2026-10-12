// Shared relay acquisition for the OpenAI-family launchers
// (grok / codex / qoder / opencode / dsh / zcode).
//
// The acquisition is two-level:
//   1. probe the resident relay on 47821 (only for launchers that wire a
//      probe) — a hit yields the caller-built resident handle, which borrows
//      the shared relay token file and closes as a no-op;
//   2. otherwise start a per-launch relay that dies with the tool.
//
// When BOTH levels fail (store unusable, 47821 held by a foreign process,
// token file unreadable, ...) the launch must NOT be refused: acquireRelayOrNative
// returns null and the launcher falls back to a native launch — the tool is
// spawned with its own configuration, exactly as if Anyswitch were not
// installed. Native mode means:
//   - no relay-related env is injected (no ANYSWITCH_*, no NO_PROXY);
//   - the tool's own credential variables are left untouched (relay mode's
//     stripping, e.g. grok's XAI_API_KEY removal, does not happen);
//   - one clear stderr line says the relay is unavailable and the tool is
//     starting on its native configuration.
// The managed-config sync still runs in native mode (best-effort, log-only on
// failure as before): the managed entries point at the well-known port and
// revive on their own once the watchdog-held resident relay answers again.

// probeRelay / residentRelay are optional as a pair (codex/opencode have no
// resident-probe level — their resident reuse happens inside listenLoopback).
// Returns the relay handle, or null when both levels failed and the caller
// must launch natively.
export async function acquireRelayOrNative({
  endpoint,
  port,
  log,
  probeRelay = null,
  residentRelay = null,
  startRelay,
}) {
  if (probeRelay && residentRelay) {
    let probeHit = false;
    try {
      probeHit = await probeRelay(port);
    } catch (error) {
      log(`probe failed (${error.message}); falling back to per-launch relay`);
    }
    if (probeHit) {
      try {
        const relay = await residentRelay();
        log(`resident relay already running on ${port}; reusing, no spawn of a new relay`);
        return relay;
      } catch (error) {
        log(`resident relay reuse failed (${error.message}); falling back to per-launch relay`);
      }
    }
  }
  try {
    return await startRelay();
  } catch (error) {
    log(`Anyswitch relay unavailable (${error.message}); launching ${endpoint} with its native configuration (no relay environment injected)`);
    return null;
  }
}

// Native-fallback child environment: the caller's environment passed through
// verbatim. Relay mode injects ANYSWITCH_* / NO_PROXY and (for grok) strips
// the tool's own credential variables; native mode must do neither, so the
// tool behaves exactly as if it had been started without Anyswitch.
export function buildNativeLauncherEnv({ base = {} } = {}) {
  return { ...base };
}

// Native-mode token for the managed-config sync: read the shared relay token
// file (the same file a started relay would use). A failure only downgrades
// the sync — it is logged and skipped, never blocks the launch.
export function loadNativeSyncToken({ loadToken, root, endpoint, log }) {
  try {
    return loadToken(root);
  } catch (error) {
    log(`warning: relay token unavailable (${error.message}); ${endpoint} config not updated`);
    return null;
  }
}
