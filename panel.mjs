// Control-panel HTTP routes. Mounted on both:
//   - panel-host.mjs (127.0.0.1:47820) — the desktop control plane; stays up
//     when the relay is stopped. This is the ONLY place the panel page is
//     served, and the only place that owns panel-host lifecycle.
//   - relay-host.mjs (127.0.0.1:47821) — data plane. It mounts the same router
//     for its API surface (per-launch relays POST session/report here), but its
//     `/panel` document 302s to 47820: two live copies of the page on two ports
//     would mean lifecycle buttons acting on whichever process happens to serve
//     them, and a relay-restart request handled BY the relay is self-kill.
//
// Authentication: NONE. Loopback binding is the network boundary (non-127
// peers already 403). Writes (start/stop/restart, settings, autostart,
// session report) additionally require Origin/Referer on :47820 or
// :47821 plus header X-AnySwitch-Panel: 1, so a random page on this machine
// cannot POST those routes. Credentials are never echoed. The relay Bearer
// token still guards /v1/* and /openai/* and is not pasted into the browser.

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStore, storePaths as defaultStorePaths } from "./store-io.mjs";
import { enableAutostart, disableAutostart, isAutostartEnabled, enableWatchdogAutostart, disableWatchdogAutostart, isWatchdogAutostartEnabled } from "./autostart.mjs";
import { spawnWatchdog, stopWatchdog, probeWatchdog } from "./agent-watchdog.mjs";
import { loadSettings, saveSettings, defaultSettingsPath } from "./relay-settings.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { getRelayStatus, startRelay, stopRelay, restartRelay } from "./relay-process-manager.mjs";
import { spawnAgentSync } from "./agent-sync-spawn.mjs";
import { createSkillsService } from "./agent-skills.mjs";
import { createPromptsService } from "./agent-prompts.mjs";
import { createPromptsInjector } from "./agent-prompts-inject.mjs";
import { createStoreService } from "./store-service.mjs";
import { createUsageJournal } from "./usage-journal.mjs";
import { createUsageStats, clampStatDays } from "./usage-stats.mjs";
import { spawnPanelHostRestartHelper } from "./panel-host-restart-helper.mjs";
import { scanAll as sessionScanAll, loadMessages as sessionLoadMessages, deleteSessions as sessionDeleteSessions } from "./session-scan.mjs";

const REPO_PANEL_HTML = join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html");
const REPO_PANEL_LOGO = join(dirname(fileURLToPath(import.meta.url)), "docs", "assets", "logo.png");
// The one place the panel page lives. relay-host's copy of this router sends
// document requests here instead of serving a second, indistinguishable copy.
const CONTROL_PLANE_PANEL_URL = "http://127.0.0.1:47820/panel";
// Panel self-restart timing: how long after the response has flushed we let the
// socket settle before exiting, and the ceiling for the case where the flush
// never completes because the client already hung up.
const PANEL_HOST_EXIT_GRACE_MS = 150;
const PANEL_HOST_EXIT_BACKSTOP_MS = 1_200;

// GET /api/settings decorates its response with watchdog drift visibility
// (registry task present vs watchdog process answering). Both probes cost real
// time — a PowerShell Get-ScheduledTask spawn (~0.9s measured) plus an HTTP
// liveness probe — and the panel page fetches /api/settings on every load to
// hydrate the 抗截断 toggle, so paying them per GET delayed that toggle >1s.
// The snapshot is stale-while-revalidate: once a probe round has settled,
// GETs return instantly (stale values past the TTL) while one shared
// background round refreshes. POST followAgent invalidates so the next GET
// re-probes synchronously and never reports pre-toggle drift.
const WATCHDOG_SNAPSHOT_TTL_MS = 30_000;

// All legitimate panel bodies are KB-scale JSON (settings, aliases, store
// writes). Anything past 1MB is a malfunctioning or hostile client, so the
// body reader cuts it off instead of buffering it. Same class shape as the
// BodyTooLargeError in server.mjs / openai-server.mjs,
// defined locally so the panel does not drag in the relay's dep chain.
const MAX_BODY_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
    this.statusCode = 413;
  }
}

// Prompts tab facade: pairs the prompts data plane (agent-prompts.mjs) with
// the injector (agent-prompts-inject.mjs). Every mutation is followed by a
// full syncAll across all eight endpoints; per-endpoint failures land in the
// `sync` snapshot served by getState and never fail the mutation itself.
// `homeDir` is injectable so tests can keep all writes inside temp dirs.
export function createPromptsPanelService({ base = process.env, homeDir } = {}) {
  const data = createPromptsService({ base });
  const injector = createPromptsInjector({ base, ...(homeDir ? { homeDir } : {}) });
  let lastSync = {};
  const mutateAndSync = (result) => {
    lastSync = injector.syncAll((endpointId) => data.resolveForEndpoint(endpointId));
    return result;
  };
  return {
    getState() {
      return {
        ...data.getState(),
        endpoints: injector.listEndpoints().map(({ id, label, hotReload, targetRel }) => ({ id, label, hotReload, targetRel })),
        sync: lastSync,
      };
    },
    setMaster: (enabled) => mutateAndSync(data.setMaster(enabled)),
    createPreset: (fields) => mutateAndSync(data.createPreset(fields)),
    updatePreset: (fields) => mutateAndSync(data.updatePreset(fields)),
    deletePreset: (id) => mutateAndSync(data.deletePreset(id)),
    setPresetEnabled: (args) => mutateAndSync(data.setPresetEnabled(args)),
    setOverride: (args) => {
      if (!injector.hasEndpoint(args?.endpointId)) {
        const error = new Error(`未知端点: ${args?.endpointId}`);
        error.statusCode = 400;
        throw error;
      }
      return mutateAndSync(data.setOverride(args));
    },
  };
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

// One in-flight probe round (registry + liveness, parallel) shared by every
// waiter; consecutive rounds wait for the previous one to finish so refreshes
// never pile up. Each round's resolved value becomes the new snapshot.
function createWatchdogProbeRound(isWatchdogAutostartEnabledFn, probeWatchdogFn) {
  const inFlight = { p: null };
  return () => {
    if (inFlight.p) return inFlight.p;
    const round = (async () => {
      try {
        return await Promise.all([isWatchdogAutostartEnabledFn(), probeWatchdogFn()]);
      } finally {
        // Microtask delay so a waiter that stores the promise BEFORE the round
        // settles still finds it (avoiding a synchronous restart loop between
        // round N+1 and the settle microtask of round N).
        await Promise.resolve();
        inFlight.p = null;
      }
    })();
    inFlight.p = round;
    return round;
  };
}

// Per-router state machine: { at, value } | null. Serves GETs instantly once
// primed; fires (at most) one shared background round when the TTL lapses.
// `watchdogSnapshotTtlMs` is injectable for tests; 0 = every GET revalidates.
function createWatchdogSnapshot(isWatchdogAutostartEnabledFn, probeWatchdogFn, ttlMs) {
  const runProbeRound = createWatchdogProbeRound(isWatchdogAutostartEnabledFn, probeWatchdogFn);
  let snap = null;

  function refresh() {
    const p = runProbeRound();
    p.then(([autostart, running]) => {
      snap = { at: Date.now(), value: { autostart, running } };
    }).catch(() => {
      // Probe round rejected (shouldn't — both probes are fail-soft) — keep
      // serving the old snapshot.
    });
    return p;
  }

  return {
    async get() {
      if (snap) {
        const expired = Date.now() - snap.at >= ttlMs;
        if (!expired) return snap.value;
        // SWR: hand back the stale value now; refresh once in the background.
        // The rejection handler inside refresh keeps old values; this catch
        // only stops the raw round from surfacing as unhandledRejection.
        refresh().catch(() => {});
        return snap.value;
      }
      // Cold path: wait for the settling prewarm round (or our own if none).
      // Fail-soft mirrors the old inline probes: a rejected round (both real
      // probes resolve instead; only mocked deps could throw) serves the
      // legacy nulls and is NOT cached — the next GET re-probes.
      try {
        const [autostart, running] = await refresh();
        return { autostart, running };
      } catch {
        return { autostart: null, running: null };
      }
    },
    invalidate() { snap = null; },
    // Kick the first probe round without waiting for it (panel-host calls
    // this at startup); the settled value becomes the initial snapshot.
    prewarm() { refresh().catch(() => {}); },
  };
}

function loopbackHttpOrigin(origin) {
  if (!origin || typeof origin !== "string") return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:") return null;
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
    return url;
  } catch {
    return null;
  }
}

export function isTrustedPanelOrigin(origin, hostHeader) {
  const url = loopbackHttpOrigin(origin);
  if (!url) return false;
  const host = typeof hostHeader === "string" ? hostHeader.toLowerCase() : "";
  if (host) {
    const hostUrl = loopbackHttpOrigin(`http://${host}`);
    if (hostUrl && hostUrl.host === url.host) return true;
  }
  return url.port === "47820" || url.port === "47821";
}

export function isTrustedPanelMutation(req) {
  // Dual-header read: resident processes spawned before the header rename
  // still send x-apicred-panel until the next relay/panel restart.
  const header = req?.headers?.["x-anyswitch-panel"] ?? req?.headers?.["x-apicred-panel"];
  if (header !== "1") return false;
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (origin) return isTrustedPanelOrigin(origin, host);
  const referer = req.headers.referer;
  if (!referer) return false;
  try {
    const url = new URL(referer);
    return isTrustedPanelOrigin(`${url.protocol}//${url.host}`, host);
  } catch {
    return false;
  }
}

// Pull-mode telemetry: fetch the relay's authoritative live agent metrics from
// its internal loopback endpoint (47821/api/internal/agents). Returns the agents
// array, or null if the relay is down/unreachable so the caller can fall back.
// Loopback-only and Bearer pi-relay-token guarded on the relay side.
async function defaultFetchRelayAgents(root, token) {
  if (!token) return null;
  try {
    const response = await fetch("http://127.0.0.1:47821/api/internal/agents", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data && Array.isArray(data.agents)) return data.agents;
    return null;
  } catch {
    // Relay may be stopped, starting, or not yet listening.
    return null;
  }
}

async function defaultFetchRelayStability(root, token) {
  if (!token) return null;
  try {
    const response = await fetch("http://127.0.0.1:47821/api/internal/model-stability", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data && Array.isArray(data.models)) return data;
    return null;
  } catch {
    return null;
  }
}

// Pull the resident relay's route-chain runtime (which chain node each
// endpoint's 自动路由 currently sits on + when it backed off). Returns the
// { endpoints } payload, or null when the relay is unreachable so the caller
// falls back to an empty map — unlike model-stability there is no local
// collector equivalent in the panel process (no chain state ever lives here).
async function defaultFetchRelayChainRuntime(root, token) {
  if (!token) return null;
  try {
    const response = await fetch("http://127.0.0.1:47821/api/internal/route-chain-runtime", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data && typeof data.endpoints === "object" && data.endpoints !== null) return { endpoints: data.endpoints };
    return null;
  } catch {
    return null;
  }
}

// Bridge the relay's logger (a separate process on 47821) into this panel
// process's log bus. The 实时输出 window subscribes to the panel-host's own
// logger, so after the panel/relay split relay-side entries (keep-alive
// retries, stream faults) stopped appearing. This opens a long-lived SSE
// subscription to the relay's /api/internal/logs (same pi-relay-token guard
// as the agents pull) and re-publishes each entry through this logger's
// subscriber fan-out. The relay being down is not an error: the bridge
// retries on a timer and the panel keeps showing its own entries.
//
// MUST only be started by the standalone panel-host (47820). The relay-host
// mounts the same router and streams its own logger natively — starting the
// bridge there would subscribe the relay to its own log endpoint and
// amplify every entry into an infinite loop.
export function startRelayLogBridge(logger, relayRoot) {
  let stopped = false;
  let controller = null;
  let retryTimer = null;

  function scheduleRetry() {
    if (stopped) return;
    retryTimer = setTimeout(connect, 5000);
  }

  async function connect() {
    if (stopped) return;
    let token;
    try {
      token = loadOrGenerateToken(relayRoot);
    } catch {
      scheduleRetry();
      return;
    }
    if (!token) {
      scheduleRetry();
      return;
    }
    controller = new AbortController();
    try {
      // live=1: entries already bridged into this bus must not re-arrive as
      // duplicates whenever the relay restarts and this bridge reconnects.
      const response = await fetch("http://127.0.0.1:47821/api/internal/logs?live=1", {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        scheduleRetry();
        return;
      }
      // Re-publish relay entries through this process's bus: log() writes to
      // this sink AND fans out to the panel's SSE subscribers.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            const entry = JSON.parse(line.slice(5).trim());
            if (entry && entry.level && entry.message) {
              // The relay entry's message already carries its own "[level] "
              // prefix; strip it so logger.log() doesn't double it up.
              const message = entry.message.replace(/^\[(info|warn|error)\]\s?/, "");
              logger.log(entry.level, message);
            }
          } catch {
            // Malformed frame: skip it, never kill the bridge.
          }
        }
      }
    } catch {
      // Relay stopped mid-stream or fetch failed — fall through to retry.
    }
    scheduleRetry();
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    controller?.abort();
  };
}

export function createPanelRouter({
  storePaths,
  logger,
  metricsCollector,
  base = process.env,
  startTime = Date.now(),
  // Relay lifecycle is owned by relay-process-manager (a separate process on
  // 47821). These default to the real supervisor but are injectable so the
  // router is unit-testable without spawning processes or binding sockets.
  getRelayStatusFn = (root) => getRelayStatus(root),
  startRelayFn = (root) => startRelay(root),
  stopRelayFn = (root) => stopRelay(root),
  restartRelayFn = (root) => restartRelay(root),
  // Which process owns this router copy: "panel-host" = the control plane on
  // 47820 (serves the page, owns panel lifecycle), "relay-host" = the data
  // plane on 47821 (API surface only; its /panel document redirects).
  hostKind = "panel-host",
  // Panel-host restart: fire the detached one-shot that waits for 47820 to be
  // released and brings the replacement up. Both this and the self-exit are
  // injectable so the router is unit-testable without spawning processes or
  // the test runner killing itself.
  spawnPanelHostRestartFn = spawnPanelHostRestartHelper,
  exitPanelHostFn = (code) => process.exit(code),
  // Watchdog coordination for followAgent: registry first (durable, survives
  // reboots), then process control (effective this session). Injectable so
  // the router is unit-testable without reg.exe or real watchdog processes.
  enableWatchdogAutostartFn = enableWatchdogAutostart,
  disableWatchdogAutostartFn = disableWatchdogAutostart,
  isWatchdogAutostartEnabledFn = isWatchdogAutostartEnabled,
  spawnWatchdogFn = spawnWatchdog,
  stopWatchdogFn = stopWatchdog,
  probeWatchdogFn = probeWatchdog,
  // Pull-mode telemetry: where handleAgents fetches live metrics from. Kept
  // injectable so tests don't need a real relay bound on 47821.
   fetchRelayAgents = defaultFetchRelayAgents,
   fetchRelayStability = defaultFetchRelayStability,
   fetchRelayChainRuntime = defaultFetchRelayChainRuntime,
  // Skills tab service (agent-skills.mjs). Injectable so the router is
  // unit-testable without real home directories, junctions, or PowerShell.
  // `null` lazily builds the real service on first skills request.
  skillsService = null,
  // Prompts tab facade (createPromptsPanelService). Injectable for tests;
  // `null` lazily builds the real facade on the first prompts request.
  promptsService = null,
  // Store tab service (store-service.mjs). Injectable so the router is
  // unit-testable with a mock; `null` lazily builds the real service on the
  // first store request, rooted at the same storePaths the router uses.
  storeService = null,
  // Usage-stats service (usage-stats.mjs) backing GET /panel/api/stats/state.
  // Injectable for tests; `null` lazily builds the real one on first stats
  // request over a journal rooted at <Anyswitch data root>/usage.
  statsService = null,
  // Watchdog probe snapshot TTL (panel.mjs). Injectable so tests can force
  // revalidation; production default is WATCHDOG_SNAPSHOT_TTL_MS.
  watchdogSnapshotTtlMs = WATCHDOG_SNAPSHOT_TTL_MS,
  // Journal used for claude session-end rows (and shared with the lazily
  // built statsService). Injectable so tests can capture appendSession
  // without touching the real usage dir; `null` lazily creates one.
  usageJournal = null,
  // Sessions tab service (session-scan.mjs): scanAll() / loadMessages() /
  // deleteSessions() over the eight agents' on-disk session stores.
  // Injectable for tests; `null` lazily binds the real module's exports on
  // the first sessions request.
  sessionScanService = null,
 }) {
  const settingsFile = defaultSettingsPath(base);
  const relayRoot = storePaths?.root ?? defaultStorePaths().root;
  // Watchdog drift snapshot (see createWatchdogSnapshot above): GET /api/settings
  // answers instantly once a probe round has settled; POST followAgent invalidates.
  const watchdogSnapshot = createWatchdogSnapshot(isWatchdogAutostartEnabledFn, probeWatchdogFn, watchdogSnapshotTtlMs);

  // Lookup chain: ANYSWITCH_PANEL_HTML env override → bundled panel-ui/panel.html.
  // A missing file falls through to servePanelHtml's readFileSync failure → 404.
  function resolvePanelHtmlPath() {
    if (process.env.ANYSWITCH_PANEL_HTML) return process.env.ANYSWITCH_PANEL_HTML;
    return REPO_PANEL_HTML;
  }

  // The relay token lives under %LOCALAPPDATA%\Anyswitch (= relayRoot). Reading it
  // here (NOT dirname(storePaths.v2Path), which is undefined after path
  // flattening and silently throws TypeError) is the fix for the decoupled panel
  // seeing empty metrics: the token is what authorises /api/internal/agents.
  function relayPullToken() {
    try {
      return loadOrGenerateToken(relayRoot);
    } catch {
      return null;
    }
  }

  // A3: store.json mtime 微缓存。handleStatus 每秒只读 provider 计数，每请求
  // 一次 statSync（元数据读，微秒级）按 mtimeMs:size 校验，不变即复用上次解析
  // 结果。跨进程安全：relay 写 store 走 atomic rename，mtime 必变。
  // 契约：缓存命中返回的是共享 parsed 引用——调用方只读、禁止原地修改
  // （已核对 panel.mjs 内全部 loadStore 调用方均为只读）。
  // statSync 失败（store.json 缺失）落入 uncached 分支，绝不返回上次 ok:true
  // 缓存（否则 storeOk 外显变化）；只缓存 stat 成功且 ok:true 的结果。
  let storeLoadCache = null; // { path, mtimeMs, size, loaded }
  function loadStoreCached() {
    const storeFile = typeof storePaths?.storeFile === "string" ? storePaths.storeFile : null;
    let st = null;
    if (storeFile) {
      try {
        st = statSync(storeFile);
      } catch {
        st = null; // 缺失/不可读 → uncached，且不得命中旧缓存
      }
    }
    if (st && storeLoadCache
      && storeLoadCache.path === storeFile
      && storeLoadCache.mtimeMs === st.mtimeMs
      && storeLoadCache.size === st.size) {
      return storeLoadCache.loaded;
    }
    const loaded = loadStore(storePaths);
    if (st && loaded.ok) {
      storeLoadCache = { path: storeFile, mtimeMs: st.mtimeMs, size: st.size, loaded };
    }
    return loaded;
  }

  async function handleStatus(res) {
    // Provider count from the store — metadata only, never credentials.
    let providerCount = 0;
    let storeOk = false;
    try {
      const loaded = loadStoreCached();
      if (loaded.ok) {
        storeOk = true;
        providerCount = Object.keys(loaded.store.providers ?? {}).length;
      }
    } catch {
      // store-io is part of the same app dir; a failure here is "store unreadable",
      // surfaced as storeOk:false rather than a crash.
    }
    // Relay lifecycle is owned by relay-process-manager (a separate process on
    // 47821). The panel (this process, 47820) reports its own PID + the relay's
    // live status so the UI can render running/stopped/starting + a start button.
    let relay = { status: "stopped", pid: null, port: 47821 };
    try {
      relay = await getRelayStatusFn(relayRoot);
    } catch (err) {
      logger?.error(`relay status probe failed: ${err.message}`);
    }
    sendJson(res, 200, {
      running: relay.status === "running",
      panelPort: 47820,
      pid: process.pid,
      port: 47821,
      startTime,
      storeOk,
      providers: providerCount,
      relay,
    });
  }

  async function handleRelayStatus(res) {
    try {
      const relay = await getRelayStatusFn(relayRoot);
      sendJson(res, 200, { ok: true, relay });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  async function handleRelayStart(res) {
    logger?.info("Relay start requested from panel control");
    try {
      const result = await startRelayFn(relayRoot);
      sendJson(res, result.ok ? 200 : 500, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  async function handleRelayStop(res) {
    logger?.info("Relay stop requested from panel control");
    try {
      const result = await stopRelayFn(relayRoot);
      sendJson(res, result.ok ? 200 : 500, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  async function handleRelayRestart(res) {
    logger?.info("Relay restart requested from panel control");
    try {
      const result = await restartRelayFn(relayRoot);
      sendJson(res, result.ok ? 200 : 500, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // Restart THIS process so the next page load runs the code on disk. Cannot
  // be done in place: the replacement can only bind 47820 after we release it
  // (listenLoopbackPanel returns {reused:true} without serving when the port is
  // taken), and nothing else supervises panel-host — hence the detached helper
  // that waits for the release and spawns the new host. Order matters: answer
  // first, exit after the response has flushed, or the browser sees a dead
  // connection with no way to tell "restarting" from "failed".
  async function handlePanelHostRestart(res) {
    if (hostKind !== "panel-host") {
      // The relay is not the control plane, and a lifecycle request it handled
      // would be one process reaching across to kill another. relay-host's
      // /panel redirects to 47820, so this is unreachable from the UI.
      return sendJson(res, 409, {
        ok: false,
        error: "panel host restart must be requested from the control panel on 47820",
      });
    }
    logger?.info("Panel host restart requested from panel control");
    let scheduled = false;
    let backstopTimer = null;
    const scheduleExit = () => {
      if (scheduled) return;
      scheduled = true;
      if (backstopTimer) clearTimeout(backstopTimer); // the flush landed; no need for the ceiling
      setTimeout(() => exitPanelHostFn(0), PANEL_HOST_EXIT_GRACE_MS);
    };
    try {
      spawnPanelHostRestartFn();
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
    res.once("finish", scheduleExit);
    sendJson(res, 200, { ok: true, pid: process.pid });
    // Backstop: if the client is gone before the flush completes, "finish"
    // never fires — and the frontend deliberately reads a dropped response as
    // "restart started" (the exit can beat the flush), so it is sitting in its
    // recovery poll waiting for a port we still owe it.
    backstopTimer = setTimeout(scheduleExit, PANEL_HOST_EXIT_BACKSTOP_MS);
  }

  // Push the current store to every agent endpoint config (zcode, dsh, pi,
  // kimi, reasonix). Runs the standalone sync runner so the merge logic loads
  // from disk — catalog-writer fixes apply here without a panel/relay restart.
  async function handleAgentSync(res) {
    logger?.info("agent endpoint sync requested from panel");
    try {
      const result = await spawnAgentSync({ port: 47821, logger });
      sendJson(res, result.ok ? 200 : 500, {
        ok: result.ok,
        error: result.ok ? undefined : (result.error ?? `sync runner exit ${result.code}`),
        output: result.stdout?.trim() || undefined,
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // Log ingest for per-launch Claude relays. Each Claude Code session runs its
  // own relay process on an ephemeral port with no stderr file of its own;
  // without this endpoint its keep-alive retries and stream faults are
  // invisible in the panel's 实时输出. The entry re-enters this logger's bus
  // (sink + SSE fan-out), so bridged viewers see it like any resident-relay
  // entry. Strict level validation: a garbage level must 400, never log.
  async function handleLogIngest(req, res) {
    if (!logger) {
      sendJson(res, 200, { ok: true });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const level = body?.level;
      const message = body?.message;
      if (level !== "info" && level !== "warn" && level !== "error") {
        sendJson(res, 400, { ok: false, error: "level must be info, warn or error" });
        return;
      }
      if (typeof message !== "string" || message.length === 0 || message.length > 2000) {
        sendJson(res, 400, { ok: false, error: "message must be a non-empty string of at most 2000 chars" });
        return;
      }
      logger[level](message);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, err.statusCode ?? 400, { ok: false, error: err.message });
    }
  }

  // 真清空: wiping the in-memory history AND telling live viewers means a
  // refresh can no longer resurrect cleared logs, and every open panel window
  // empties together. On-disk log files are archival and stay untouched.
  function handleLogClear(res) {
    if (!logger?.clear) {
      sendJson(res, 200, { ok: true });
      return;
    }
    try {
      logger.clear();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  function handleLogsSSE(res, req) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // Replay history for late joiners, then stream live entries.
    for (const entry of logger.getHistory()) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    const unsubscribe = logger.subscribe((entry) => {
      try {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      } catch {
        // socket gone; unsubscribe will happen on close below
      }
    });
    const cleanup = () => unsubscribe();
    req.on("close", cleanup);
    req.on("error", cleanup);
  }

  async function handleAutostartStatus(res) {
    const enabled = await isAutostartEnabled();
    sendJson(res, 200, { enabled });
  }

  async function handleAutostartEnable(res) {
    const result = await enableAutostart();
    sendJson(res, result.ok ? 200 : 500, { ok: result.ok, error: result.error ?? null });
  }

  async function handleAutostartDisable(res) {
    const result = await disableAutostart();
    sendJson(res, result.ok ? 200 : 500, { ok: result.ok, error: result.error ?? null });
  }

  // 状态检测的号池聚合：号池是单一统计单元，按 store 的 pools 把池行和
  // 成员直连行（过渡期存量客户端仍指成员渠道）合并为每 (池, 模型) 一行，
  // 尝试级口径——成功、失败尝试都计入。计数/延迟/缓存命中率按 total 加权
  // 重建；ttftMs 同样按 total 加权，但 null（无样本）侧按 0 权重忽略，两侧
  // 皆 null 时为 null；cells 逐桶合并（ok 由 n×rate 反推）。store 读不出或池已解除时
  // 原样透传，非池渠道行不受影响。池 id 与成员 id 撞名无害：两条路径都
  // 归并到同一池行。
  function annotateStabilityModels(models) {
    if (!Array.isArray(models)) return models;
    let store;
    try {
      const loaded = loadStore(storePaths);
      if (!loaded.ok) return models;
      store = loaded.store;
    } catch {
      return models;
    }
    const pools = store.pools ?? {};
    if (Object.keys(pools).length === 0) return models;
    const poolNameById = new Map();
    const memberToPool = new Map();
    for (const [poolId, pool] of Object.entries(pools)) {
      poolNameById.set(poolId, pool.displayName || poolId);
      for (const memberId of pool.members ?? []) memberToPool.set(memberId, poolId);
    }
    // success-rate thresholds mirror model-stability.mjs so re-derived rows
    // keep the same traffic-light semantics as relay-computed ones.
    const statusOf = (rate) => (rate >= 85 ? "green" : rate >= 70 ? "yellow" : "red");
    const rowTotal = (m) => Number(m?.total) || 0;
    const plain = [];
    const poolRows = new Map();
    for (const m of models) {
      const provider = typeof m?.provider === "string" ? m.provider : "";
      if (!provider || typeof m?.model !== "string") {
        plain.push(m);
        continue;
      }
      const poolId = poolNameById.has(provider)
        ? provider
        : (memberToPool.get(provider) ?? null);
      if (poolId === null) {
        plain.push(m);
        continue;
      }
      const key = `${poolId}\0${m.model}`;
      const total = rowTotal(m);
      const cells = Array.isArray(m.cells)
        ? m.cells.map((c) => ({
          n: Number(c?.n) || 0,
          ok: ((Number(c?.n) || 0) * (Number(c?.rate) || 0)) / 100,
        }))
        : [];
      let row = poolRows.get(key);
      if (!row) {
        row = {
          model: m.model,
          poolId,
          poolName: poolNameById.get(poolId),
          total: 0,
          ok: 0,
          latencyWeighted: 0,
          cacheWeighted: 0,
          ttftWeighted: 0,
          ttftWeight: 0,
          cells: [],
        };
        poolRows.set(key, row);
      }
      row.total += total;
      row.ok += (total * (Number(m.successRate) || 0)) / 100;
      row.latencyWeighted += (Number(m.latencyMs) || 0) * total;
      row.cacheWeighted += (Number(m.cacheHit) || 0) * total;
      // ttftMs 为 null 表示该侧无样本：按 0 权重忽略，不稀释有样本的一侧。
      if (typeof m.ttftMs === "number" && Number.isFinite(m.ttftMs)) {
        row.ttftWeighted += m.ttftMs * total;
        row.ttftWeight += total;
      }
      while (row.cells.length < cells.length) row.cells.push({ n: 0, ok: 0 });
      for (let i = 0; i < cells.length; i += 1) {
        row.cells[i].n += cells[i].n;
        row.cells[i].ok += cells[i].ok;
      }
    }
    const merged = Array.from(poolRows.values(), (row) => {
      const total = row.total;
      const successRate = total > 0 ? (row.ok / total) * 100 : 0;
      return {
        model: row.model,
        provider: row.poolId,
        poolId: row.poolId,
        poolName: row.poolName,
        total,
        successRate: total > 0 ? Number(successRate.toFixed(1)) : 0,
        status: total > 0 ? statusOf(successRate) : "gray",
        latencyMs: total > 0 ? Math.round(row.latencyWeighted / total) : 0,
        cacheHit: total > 0 ? Number((row.cacheWeighted / total).toFixed(1)) : 0,
        ttftMs: row.ttftWeight > 0 ? Math.round(row.ttftWeighted / row.ttftWeight) : null,
        cells: row.cells.map((c) => {
          const rate = c.n > 0 ? (c.ok / c.n) * 100 : 0;
          return {
            n: c.n,
            rate: c.n > 0 ? Number(rate.toFixed(1)) : 0,
            status: c.n > 0 ? statusOf(rate) : "idle",
          };
        }),
      };
    });
    return [...plain, ...merged].sort((a, b) => rowTotal(b) - rowTotal(a));
  }

  async function handleModelStability(res) {
    const token = relayPullToken();
    const pulled = await fetchRelayStability(relayRoot, token);
    if (pulled) {
      return sendJson(res, 200, { ok: true, ...pulled, models: annotateStabilityModels(pulled.models) });
    }
    if (!metricsCollector?.getModelStability) {
      sendJson(res, 200, { ok: true, window: "8h", buckets: 48, models: [] });
      return;
    }
    try {
      const snap = metricsCollector.getModelStability();
      sendJson(res, 200, { ok: true, ...snap, models: annotateStabilityModels(snap.models) });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // 监测页「当前落在第几跳/退避剩余重试时间」:proxy the resident relay's
  // merged route-chain runtime. Relay down -> empty map (no local source:
  // chain state only exists inside relay handler processes).
  async function handleRouteChainRuntime(res) {
    const token = relayPullToken();
    const pulled = await fetchRelayChainRuntime(relayRoot, token);
    if (pulled) {
      return sendJson(res, 200, { ok: true, endpoints: pulled.endpoints });
    }
    sendJson(res, 200, { ok: true, endpoints: {} });
  }

  // Last authoritative relay snapshot: { at, agents }. A failed pull means
  // either "relay unreachable" or "relay answered slower than the 1500ms pull
  // budget" — and only the first used to justify the local collector, which owns
  // no traffic at all. Serving it on a timeout produced a structurally identical
  // blind frame (running, but 0 requests / no lastSeen / no sparkHistory) and the
  // board flashed "no data" for a beat. Bounded staleness beats a false zero.
  const PULLED_AGENTS_STALE_MAX_MS = 5000;
  let lastPulledAgents = null;

  async function handleAgents(res) {
    // PULL mode: when the panel runs as a separate process (panel-host, 47820),
    // the authoritative live metrics live INSIDE the relay process (47821). So
    // first try to fetch them cross-process via the relay's internal telemetry
    // endpoint. On failure, serve the last pull while it is still young, and only
    // then fall back to this process's own collector — which keeps the UI from
    // erroring when the relay really is stopped and lets it recover the instant
    // the relay is back. (A relay restart zeroes the relay's counters; the cache
    // can then show a few seconds of pre-restart numbers, and the next successful
    // pull overwrites it.)
    const token = relayPullToken();
    const pulled = await fetchRelayAgents(relayRoot, token);
    if (pulled) {
      lastPulledAgents = { at: Date.now(), agents: pulled };
      return sendJson(res, 200, { ok: true, agents: pulled });
    }
    if (lastPulledAgents && Date.now() - lastPulledAgents.at <= PULLED_AGENTS_STALE_MAX_MS) {
      return sendJson(res, 200, { ok: true, agents: lastPulledAgents.agents });
    }
    if (!metricsCollector) {
      sendJson(res, 200, { ok: true, agents: [] });
      return;
    }
    try {
      const agents = await metricsCollector.getAgentsStatus();
      sendJson(res, 200, { ok: true, agents });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let tooLarge = false;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          if (!tooLarge) {
            tooLarge = true;
            reject(new BodyTooLargeError());
          }
          // Keep draining (and zero) further chunks so the socket does not
          // hang on unread request data; panel bodies can carry API keys.
          if (Buffer.isBuffer(c)) c.fill(0);
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (tooLarge) return;
        try {
          const str = Buffer.concat(chunks).toString("utf8");
          resolve(str ? JSON.parse(str) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });
  }

  // Shared usage journal: appends claude session-end rows here and doubles as
  // the read source for the lazily built statsService. Same-dir appendFileSync
  // 'a' appends are safe within this single process.
  function usageJournalLazy() {
    if (!usageJournal) usageJournal = createUsageJournal({ dir: join(relayRoot, "usage") });
    return usageJournal;
  }

  // Session-end journaling. The per-launch reporter POSTs cumulative
  // snapshots and a final { ended:true }; that final report is the session's
  // durable end record for the usage stats (the requests journal only covers
  // the resident relay paths, so there is no double counting). Dedupe key is
  // PID + relay token: the token distinguishes a recycled PID's new session,
  // and repeat ended reports for the same session journal exactly one row.
  // agentId 取自上报体（老 reporter 不带 → 回落 claude，行为不变）。
  const journaledSessions = new Set();
  const sessionFirstSeen = new Map();
  function journalSessionEnd(token, body) {
    const pid = Number(body?.pid);
    if (!Number.isFinite(pid) || pid <= 0) return;
    const key = `${pid}:${token}`;
    if (body.ended !== true) {
      if (!sessionFirstSeen.has(key)) sessionFirstSeen.set(key, Date.now());
      return;
    }
    if (journaledSessions.has(key)) return;
    if (journaledSessions.size >= 4096) journaledSessions.clear(); // bound; ended fires once per session
    journaledSessions.add(key);
    const endTs = Date.now();
    const startTs = sessionFirstSeen.get(key) ?? endTs;
    sessionFirstSeen.delete(key);
    const agentId = typeof body.agentId === "string" && body.agentId.trim() ? body.agentId.trim() : "claude";
    usageJournalLazy().appendSession({
      ts: endTs,
      agentId,
      event: "end",
      startTs,
      durationMs: Math.max(0, endTs - startTs),
      prompt: Number(body.promptTokens) || 0,
      completion: Number(body.completionTokens) || 0,
      cached: Number(body.cachedTokens) || 0,
    });
  }

  async function handleSessionReport(req, res) {
    try {
      const body = await readJsonBody(req);
      const authHeader = req.headers["authorization"] || "";
      const token = authHeader.replace(/^Bearer\s+/i, "");
      if (token) {
        journalSessionEnd(token, body);
        metricsCollector?.reportSession(token, body);
      }
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, err.statusCode ?? 400, { ok: false, error: err.message });
    }
  }

  // A4: panel.html 内存缓存 + ETag/304。每请求 statSync 校验 mtimeMs:size，不变
  // 即复用内存 body；ETag 由 size+mtimeMs 派生（package.json 无 version 字段，
  // 「版本派生」不存在）；Cache-Control: no-cache 强制每次 revalidate，
  // If-None-Match 命中回 304。缓存键含 resolved htmlPath（测试会切
  // ANYSWITCH_PANEL_HTML env override，防串内容）。statSync 失败不命中/不写缓存，
  // 404 JSON 语义原样保留。
  let panelHtmlCache = null; // { path, mtimeMs, size, body, etag }
  function servePanelHtml(res, req) {
    const htmlPath = resolvePanelHtmlPath();
    let st = null;
    try {
      st = statSync(htmlPath);
    } catch {
      st = null; // 缺失/不可读 → 不命中不写缓存，走原 404 语义
    }
    let cached = panelHtmlCache;
    if (!(st && cached && cached.path === htmlPath
      && cached.mtimeMs === st.mtimeMs && cached.size === st.size)) {
      cached = null;
      let body;
      try {
        body = readFileSync(htmlPath, "utf8");
      } catch {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "panel.html not found", path: htmlPath }));
      }
      if (!st) {
        // statSync 失败但读到了内容（竞态）：不写缓存、不发 ETag，原样直出。
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(body);
      }
      cached = { path: htmlPath, mtimeMs: st.mtimeMs, size: st.size, body, etag: `"${st.size}-${st.mtimeMs}"` };
      panelHtmlCache = cached;
    }
    const revalidateHeaders = { etag: cached.etag, "cache-control": "no-cache" };
    if (req?.headers?.["if-none-match"] === cached.etag) {
      res.writeHead(304, revalidateHeaders);
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...revalidateHeaders });
    return res.end(cached.body);
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method;

    if (method === "POST" && path.startsWith("/panel/api/") && !isTrustedPanelMutation(req)) {
      return sendJson(res, 403, { ok: false, error: "csrf" });
    }

    // The panel page is served to any loopback peer. No login box. Writes are
    // gated above; GETs stay tokenless. Only the control plane serves it: two
    // byte-identical pages on two ports would put every lifecycle button at the
    // mercy of whichever process happens to answer, and on 47821 that process is
    // the relay — which cannot restart itself without dying mid-request.
    if (path === "/panel" && (method === "GET" || method === "HEAD")) {
      if (hostKind !== "panel-host") {
        res.writeHead(302, { location: CONTROL_PLANE_PANEL_URL });
        return res.end();
      }
      if (method === "HEAD") {
        res.writeHead(200, { "content-length": 0 });
        return res.end();
      }
      return servePanelHtml(res, req);
    }

    if (path === "/panel/assets/logo.png" && (method === "GET" || method === "HEAD")) {
      let body;
      try {
        body = readFileSync(REPO_PANEL_LOGO);
      } catch {
        return sendJson(res, 404, { error: "logo.png not found" });
      }
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": body.length,
        "cache-control": "no-cache",
      });
      return res.end(method === "HEAD" ? undefined : body);
    }

    if (path === "/panel/api/status" && method === "GET") return handleStatus(res);
    if (path === "/panel/api/relay/status" && method === "GET") return handleRelayStatus(res);
    if (path === "/panel/api/relay/start" && method === "POST") return handleRelayStart(res);
    if (path === "/panel/api/relay/stop" && method === "POST") return handleRelayStop(res);
    if (path === "/panel/api/relay/restart" && method === "POST") return handleRelayRestart(res);
    if (path === "/panel/api/panel-host/restart" && method === "POST") return handlePanelHostRestart(res);
    if (path === "/panel/api/sync-agents" && method === "POST") return handleAgentSync(res);
    if (path === "/panel/api/agents" && method === "GET") return handleAgents(res);
    if (path === "/panel/api/model-stability" && method === "GET") return handleModelStability(res);
    if (path === "/panel/api/route-chain/runtime" && method === "GET") return handleRouteChainRuntime(res);
    if (path === "/panel/api/session/report" && method === "POST") return handleSessionReport(req, res);
    if (path === "/panel/api/logs" && method === "GET") return handleLogsSSE(res, req);
    if (path === "/panel/api/logs/ingest" && method === "POST") return handleLogIngest(req, res);
    if (path === "/panel/api/logs/clear" && method === "POST") return handleLogClear(res);
    if (path === "/panel/api/autostart" && method === "GET") return handleAutostartStatus(res);
    if (path === "/panel/api/autostart/enable" && method === "POST") return handleAutostartEnable(res);
    if (path === "/panel/api/autostart/disable" && method === "POST") return handleAutostartDisable(res);

    if (path === "/panel/api/settings" && method === "GET") {
      try {
        const loaded = loadSettings(settingsFile, base);
        // Watchdog drift visibility: what the registry/process ACTUALLY do,
        // next to what settings.json says. Served from a probe snapshot
        // (stale-while-revalidate, see createWatchdogSnapshot) — both probes
        // cost ~1s+ and this endpoint is fetched on every panel page load.
        const watchdog = await watchdogSnapshot.get();
        return sendJson(res, 200, {
          ok: true,
          settings: loaded.settings,
          keepAlive: loaded.keepAlive,
          sparkWindowPoints: loaded.sparkWindowPoints,
          watchdog,
        });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    if (path === "/panel/api/settings" && method === "POST") {
      try {
        const body = await readJsonBody(req);
        // followAgent is backed by the standalone watchdog: registry entry
        // FIRST (durable across reboots) — if reg.exe fails, refuse to save so
        // settings.json never claims a follow mode that will not survive a
        // reboot. Only then persist and bring the process up/down for this
        // session (best-effort; the registry entry is the durable path).
        const togglesWatchdog = typeof body.followAgent === "boolean";
        if (togglesWatchdog) {
          const reg = body.followAgent ? await enableWatchdogAutostartFn() : await disableWatchdogAutostartFn();
          if (!reg.ok) {
            return sendJson(res, 500, { ok: false, error: `watchdog autostart: ${reg.error ?? "registry write failed"}` });
          }
        }
        const updated = saveSettings(settingsFile, body, base);
        if (metricsCollector && typeof metricsCollector.setSparkWindowPoints === "function") {
          metricsCollector.setSparkWindowPoints(updated.sparkWindowPoints);
        }
        if (togglesWatchdog) {
          try {
            if (body.followAgent) await spawnWatchdogFn();
            else await stopWatchdogFn();
          } catch (err) {
            logger?.warn?.(`watchdog process control failed: ${err.message}`);
          }
          // followAgent just toggled the registry task / watchdog process:
          // drop the drift snapshot after the transition settles so the next
          // GET re-probes instead of serving pre-toggle values until the TTL
          // lapses.
          watchdogSnapshot.invalidate();
        }
        return sendJson(res, 200, {
          ok: true,
          settings: updated.settings,
          keepAlive: updated.keepAlive,
          sparkWindowPoints: updated.sparkWindowPoints,
        });
      } catch (err) {
        return sendJson(res, err.statusCode ?? 500, { ok: false, error: err.message });
      }
    }

    // ── Store tab routes ───────────────────────────────────────────────
    // Write-side store management (add/rotate/test/refresh/filter/delete).
    // Business validation failures and CAS conflicts are 200s carrying
    // { ok:false, error } ("cas-conflict" for a lost compare-and-swap race)
    // so the UI can surface them inline; missing parameters are 400s.
    // Plaintext keys never appear in any response.
    if (path.startsWith("/panel/api/store/")) {
      if (!storeService) {
        storeService = createStoreService({ paths: defaultStorePaths(storePaths?.root) });
      }
      const svc = storeService;

      if (path === "/panel/api/store/state" && method === "GET") {
        try {
          return sendJson(res, 200, await svc.getState());
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err.message });
        }
      }

      // A5: 看板轻量端点——只下发 routingChains + 名字映射，不带全量 store payload。
      if (path === "/panel/api/store/board-state" && method === "GET") {
        try {
          return sendJson(res, 200, await svc.getBoardState());
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err.message });
        }
      }

      if (method === "POST") {
        try {
          const body = await readJsonBody(req);
          const requireString = (value, field) => {
            if (typeof value !== "string" || !value.trim()) {
              const error = new Error(`${field} must be a non-empty string`);
              error.statusCode = 400;
              throw error;
            }
            return value.trim();
          };

          if (path === "/panel/api/store/add") {
            const result = await svc.addProvider({
              id: requireString(body.id, "id"),
              displayName: body.displayName,
              baseURLs: requireString(body.baseURLs, "baseURLs"),
              apiKey: requireString(body.apiKey, "apiKey"),
              ...(Array.isArray(body.modelIds) ? { modelIds: body.modelIds } : {}),
            });
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/rotate") {
            const result = await svc.rotateProvider({
              id: requireString(body.id, "id"),
              ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
              ...(typeof body.baseURLs === "string" ? { baseURLs: body.baseURLs } : {}),
            });
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/test") {
            const result = await svc.testProvider(requireString(body.id, "id"));
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/refresh") {
            const result = await svc.refreshProviders(
              typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined,
            );
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/filter") {
            if (!Array.isArray(body.modelFilter)) {
              return sendJson(res, 400, { ok: false, error: "modelFilter must be an array of model IDs" });
            }
            const result = await svc.saveFilter({
              id: requireString(body.id, "id"),
              modelFilter: body.modelFilter,
            });
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/models/add") {
            const providerId = requireString(body.providerId, "providerId");
            if (!Array.isArray(body.modelIds)) {
              return sendJson(res, 400, { ok: false, reason: "bad-request", message: "modelIds must be an array of model IDs" });
            }
            const result = await svc.addModels(providerId, body.modelIds);
            if (!result.ok) {
              const message =
                result.reason === "model-exists"
                  ? `模型已存在: ${(result.duplicates ?? []).join(", ")}`
                  : result.reason === "unknown-provider"
                    ? `Provider ${providerId} is not managed by Anyswitch`
                    : (result.error ?? result.reason);
              return sendJson(res, 400, { ok: false, reason: result.reason, message });
            }
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/models/remove") {
            const providerId = requireString(body.providerId, "providerId");
            if (!Array.isArray(body.modelIds)) {
              return sendJson(res, 400, { ok: false, reason: "bad-request", message: "modelIds must be an array of model IDs" });
            }
            const result = await svc.removeModels(providerId, body.modelIds);
            if (!result.ok) {
              const message =
                result.reason === "model-not-found"
                  ? `模型不存在: ${(result.missing ?? []).join(", ")}`
                  : result.reason === "unknown-provider"
                    ? `Provider ${providerId} is not managed by Anyswitch`
                    : (result.error ?? result.reason);
              return sendJson(res, 400, { ok: false, reason: result.reason, message });
            }
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/pool/create") {
            if (!Array.isArray(body.members)) {
              return sendJson(res, 400, { ok: false, error: "members must be an array of provider ids" });
            }
            const result = await svc.createPool({
              poolId: requireString(body.poolId, "poolId"),
              displayName: requireString(body.displayName, "displayName"),
              members: body.members,
            });
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/pool/delete") {
            const result = await svc.deletePool(requireString(body.poolId, "poolId"));
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/rename") {
            const result = await svc.renameProvider(
              requireString(body.id, "id"),
              requireString(body.displayName, "displayName"),
            );
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/pool/rename") {
            const result = await svc.renamePool(
              requireString(body.poolId, "poolId"),
              requireString(body.displayName, "displayName"),
            );
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/pool/members/update") {
            if (!Array.isArray(body.members)) {
              return sendJson(res, 400, { ok: false, error: "members must be an array of provider ids" });
            }
            const result = await svc.updatePoolMembers({
              poolId: requireString(body.poolId, "poolId"),
              members: body.members,
            });
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/reorder") {
            // 渠道拖拽重排：order 为 provider id 的排列，业务校验（排列完整性、
            // 池成员连续成块）在 service 层。
            if (!Array.isArray(body.order)) {
              return sendJson(res, 400, { ok: false, error: "order must be an array of provider ids" });
            }
            const result = await svc.reorderProviders(body.order);
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/route-chain/save") {
            // Route layer checks shape only (endpointId string, chain array);
            // per-element {node, model} validation lives in the service.
            if (typeof body.endpointId !== "string" || !body.endpointId.trim()) {
              return sendJson(res, 400, { ok: false, error: "endpointId must be a non-empty string" });
            }
            if (!Array.isArray(body.chain)) {
              return sendJson(res, 400, { ok: false, error: "chain must be an array of { node, model } entries" });
            }
            const result = await svc.saveRouteChain(body.endpointId.trim(), body.chain);
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/route-chain/enabled") {
            // 自动路由 per-endpoint 启用开关：开关状态存 store.routingChains
            // [endpointId].enabled，链路本身不动。
            if (typeof body.endpointId !== "string" || !body.endpointId.trim()) {
              return sendJson(res, 400, { ok: false, error: "endpointId must be a non-empty string" });
            }
            if (typeof body.enabled !== "boolean") {
              return sendJson(res, 400, { ok: false, error: "enabled must be a boolean" });
            }
            const result = await svc.setRouteChainEnabled(body.endpointId.trim(), body.enabled);
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/route-chain/delete") {
            if (typeof body.endpointId !== "string" || !body.endpointId.trim()) {
              return sendJson(res, 400, { ok: false, error: "endpointId must be a non-empty string" });
            }
            const result = await svc.deleteRouteChain(body.endpointId.trim());
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/delete") {
            const result = await svc.deleteProvider(requireString(body.id, "id"));
            return sendJson(res, 200, result);
          }
        } catch (err) {
          return sendJson(res, err.statusCode ?? 500, { ok: false, error: err.message });
        }
      }
    }

    // ── Usage stats routes ───────────────────────────────────────────
    // Read-only aggregation over the on-disk usage journal; both the panel
    // and the relay process read the same files, so no cross-process pull is
    // needed. GETs carry no CSRF gate. days defaults to 7 and clamps onto
    // the supported {1, 7} windows.
    //
    // 渠道显示名解析：journal 行按不可变的渠道/号池 id 分键，统计视图的
    // id→displayName 映射在这里做（读取时解析，改名即时生效、删渠道回退裸
    // id）。池 id 可复用成员渠道 id（wire 语义 pools-before-providers 同
    // 款），同名时池的显示名赢。getBoardState 只带名字映射不带模型全量，
    // 快照 15s TTL，读失败沿用旧表。
    let statsChannelLabels = { at: 0, map: new Map() };
    const refreshStatsChannelLabels = async () => {
      if (Date.now() - statsChannelLabels.at < 15000) return;
      try {
        if (!storeService) {
          storeService = createStoreService({ paths: defaultStorePaths(storePaths?.root) });
        }
        const board = await storeService.getBoardState();
        // 先池后渠道、占用键不覆盖 —— 同名共存时池赢
        const map = { ...board.providerNames, ...board.poolNames };
        statsChannelLabels = { at: Date.now(), map: new Map(Object.entries(map)) };
      } catch {
        // store 不可读：保留旧映射（首次失败则全部回退裸 id），不阻塞统计
        statsChannelLabels.at = Date.now();
      }
    };
    if (path.startsWith("/panel/api/stats/")) {
      if (!statsService) {
        statsService = createUsageStats({
          journal: usageJournalLazy(),
          channelLabel: (id) => statsChannelLabels.map.get(id) ?? null,
        });
      }
      await refreshStatsChannelLabels();
      const svc = statsService;

      if (path === "/panel/api/stats/state" && method === "GET") {
        try {
          const raw = url.searchParams.get("days");
          // Missing ?days= keeps the 7-day default; everything else clamps
          // onto the supported {1, 7} windows (shared clampStatDays).
          const days = clampStatDays(raw === null ? NaN : raw);
          return sendJson(res, 200, await svc.getState({ days }));
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err.message });
        }
      }
    }

    // ── Sessions tab routes ────────────────────────────────────────────
    // Stateless live scan of the eight agents' on-disk session stores
    // (session-scan.mjs). A single adapter's failure degrades into
    // endpointErrors (drives the UI banner) instead of failing the whole
    // list. GETs carry no CSRF gate; POST delete is covered by the
    // dual-header mutation gate above. Path traversal defense (canonicalize
    // + per-adapter roots whitelist) lives inside session-scan's delete —
    // the router only validates the request shape.
    if (path.startsWith("/panel/api/sessions/")) {
      if (!sessionScanService) {
        sessionScanService = {
          scanAll: sessionScanAll,
          loadMessages: sessionLoadMessages,
          deleteSessions: sessionDeleteSessions,
        };
      }
      const svc = sessionScanService;

      if (path === "/panel/api/sessions/list" && method === "GET") {
        try {
          // B5 裁定契约：{ sessions, endpointErrors } 由 scanAll 装配，
          // 单 adapter 失败已降级进 endpointErrors，路由原样透传。
          return sendJson(res, 200, await svc.scanAll());
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err.message });
        }
      }

      if (path === "/panel/api/sessions/messages" && method === "GET") {
        const endpoint = url.searchParams.get("endpoint");
        const file = url.searchParams.get("path");
        if (!endpoint || !file) {
          return sendJson(res, 400, { ok: false, error: "endpoint 和 path 参数不能为空" });
        }
        try {
          const messages = await svc.loadMessages(endpoint, file);
          return sendJson(res, 200, { ok: true, messages });
        } catch (err) {
          return sendJson(res, err.statusCode ?? 500, { ok: false, error: err.message });
        }
      }

      if (path === "/panel/api/sessions/delete" && method === "POST") {
        try {
          const body = await readJsonBody(req);
          if (!Array.isArray(body?.items) || body.items.length === 0
            || body.items.some((it) => typeof it?.endpoint !== "string" || !it.endpoint
              || typeof it?.file !== "string" || !it.file)) {
            return sendJson(res, 400, { ok: false, error: "items 必须是非空的 {endpoint, file} 数组" });
          }
          const result = await svc.deleteSessions(body.items);
          // B3 裁定契约：逐项成败，ok/fail 是数组（不是外层布尔包装）。
          return sendJson(res, 200, {
            ok: result?.ok ?? [],
            fail: result?.fail ?? [],
          });
        } catch (err) {
          return sendJson(res, err.statusCode ?? 500, { ok: false, error: err.message });
        }
      }

      return sendJson(res, 404, { ok: false, error: "not found" });
    }

    // ── Skills tab routes ──────────────────────────────────────────────
    // Deployment state is derived live from the filesystem; only repoPath
    // persists (skills.json). Conflict outcomes are 200s carrying
    // { ok:false, conflict:true, diffs } so the UI can run its confirm flow;
    // thrown errors become { ok:false, error }.
    if (path.startsWith("/panel/api/skills/")) {
      if (!skillsService) skillsService = createSkillsService({ base });
      const svc = skillsService;

      if (path === "/panel/api/skills/state" && method === "GET") {
        try {
          return sendJson(res, 200, { ok: true, ...svc.getState() });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err.message });
        }
      }

      if (method === "POST") {
        try {
          const body = await readJsonBody(req);
          const requireString = (value, field) => {
            if (typeof value !== "string" || !value.trim()) {
              const error = new Error(`${field} 不能为空`);
              error.statusCode = 400;
              throw error;
            }
            return value.trim();
          };

          if (path === "/panel/api/skills/repo") {
            const result = svc.setRepoPath(requireString(body.repoPath, "repoPath"));
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (path === "/panel/api/skills/repo/pick") {
            const result = await svc.pickFolder();
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (path === "/panel/api/skills/repo/import") {
            const result = await svc.importSkill(requireString(body.sourcePath, "sourcePath"));
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (path === "/panel/api/skills/repo/import-pick") {
            const result = await svc.importPickedSkill();
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (path === "/panel/api/skills/repo/import-pick-zip") {
            const result = await svc.importPickedZip();
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (path === "/panel/api/skills/repo/delete") {
            const result = await svc.deleteRepoSkill(requireString(body.skillName, "skillName"));
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (path === "/panel/api/skills/deploy") {
            const result = await svc.deploy({
              endpointId: requireString(body.endpointId, "endpointId"),
              skillName: requireString(body.skillName, "skillName"),
              force: body.force === true,
            });
            return sendJson(res, 200, { ok: result.ok !== false, ...result });
          }
          if (path === "/panel/api/skills/undeploy") {
            const result = await svc.undeploy({
              endpointId: requireString(body.endpointId, "endpointId"),
              skillName: requireString(body.skillName, "skillName"),
            });
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (path === "/panel/api/skills/merge-local") {
            const result = await svc.mergeLocalSkill({
              endpointId: requireString(body.endpointId, "endpointId"),
              skillName: requireString(body.skillName, "skillName"),
            });
            return sendJson(res, 200, { ok: result.ok !== false, ...result });
          }
          if (path === "/panel/api/skills/local/delete") {
            const result = await svc.deleteLocalSkill({
              endpointId: requireString(body.endpointId, "endpointId"),
              skillName: requireString(body.skillName, "skillName"),
            });
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (path === "/panel/api/skills/resolve-conflict") {
            const direction = requireString(body.direction, "direction");
            if (direction !== "repo" && direction !== "local") {
              return sendJson(res, 400, { ok: false, error: 'direction 必须是 "repo" 或 "local"' });
            }
            const result = await svc.resolveConflictSkill({
              endpointId: requireString(body.endpointId, "endpointId"),
              skillName: requireString(body.skillName, "skillName"),
              direction,
            });
            return sendJson(res, 200, { ok: result.ok !== false, ...result });
          }
          if (path === "/panel/api/skills/diff") {
            const result = await svc.diffLocalSkill({
              endpointId: requireString(body.endpointId, "endpointId"),
              skillName: requireString(body.skillName, "skillName"),
            });
            return sendJson(res, 200, { ok: true, diffs: result.diffs || [] });
          }
          if (path === "/panel/api/skills/body") {
            const result = await svc.readSkillBody(requireString(body.relPath, "relPath"));
            return sendJson(res, 200, { ok: true, ...result });
          }
        } catch (err) {
          return sendJson(res, err.statusCode ?? 500, { ok: false, error: err.message });
        }
      }
    }

    // ── Prompts tab routes ─────────────────────────────────────────────
    // Every mutation POST persists via the data plane, then immediately
    // re-syncs all eight endpoint instruction files. Sync failures land in
    // the `sync` snapshot (GET state) and never fail the mutation itself;
    // thrown validation errors become { ok:false, error }.
    if (path.startsWith("/panel/api/prompts/")) {
      if (!promptsService) promptsService = createPromptsPanelService({ base });
      const svc = promptsService;

      if (path === "/panel/api/prompts/state" && method === "GET") {
        try {
          return sendJson(res, 200, { ok: true, ...svc.getState() });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err.message });
        }
      }

      if (method === "POST") {
        try {
          const body = await readJsonBody(req);
          const requireString = (value, field) => {
            if (typeof value !== "string" || !value.trim()) {
              const error = new Error(`${field} 不能为空`);
              error.statusCode = 400;
              throw error;
            }
            return value.trim();
          };
          const requireBoolean = (value, field) => {
            if (typeof value !== "boolean") {
              const error = new Error(`${field} 必须是布尔值`);
              error.statusCode = 400;
              throw error;
            }
            return value;
          };
          // tag is optional; content may be empty but must be a string.
          const requireContent = (value) => {
            if (typeof value !== "string") {
              const error = new Error("content 必须是字符串");
              error.statusCode = 400;
              throw error;
            }
            return value;
          };

          if (path === "/panel/api/prompts/master") {
            const result = svc.setMaster(requireBoolean(body.enabled, "enabled"));
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (path === "/panel/api/prompts/preset/create") {
            const result = svc.createPreset({
              title: requireString(body.title, "title"),
              tag: body.tag ?? "",
              content: requireContent(body.content),
            });
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (path === "/panel/api/prompts/preset/update") {
            const result = svc.updatePreset({
              id: requireString(body.id, "id"),
              title: requireString(body.title, "title"),
              tag: body.tag ?? "",
              content: requireContent(body.content),
            });
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (path === "/panel/api/prompts/preset/delete") {
            const result = svc.deletePreset(requireString(body.id, "id"));
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (path === "/panel/api/prompts/preset/enable") {
            const result = svc.setPresetEnabled({
              id: requireString(body.id, "id"),
              enabled: requireBoolean(body.enabled, "enabled"),
            });
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (path === "/panel/api/prompts/override") {
            const result = svc.setOverride({
              endpointId: requireString(body.endpointId, "endpointId"),
              presetId: requireString(body.presetId, "presetId"),
              off: requireBoolean(body.off, "off"),
            });
            return sendJson(res, 200, { ok: true, ...result });
          }
        } catch (err) {
          return sendJson(res, err.statusCode ?? 500, { ok: false, error: err.message });
        }
      }
    }

    sendJson(res, 404, { error: "not found" });
  }

  return {
    handle,
    // Fire the first watchdog probe round early (panel-host calls this once at
    // startup) so even the very first GET /api/settings is snapshot-served.
    prewarmWatchdogProbes() {
      watchdogSnapshot.prewarm();
    },
  };
}
