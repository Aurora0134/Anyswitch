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
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStore, storePaths as defaultStorePaths } from "./store-io.mjs";
import { enableAutostart, disableAutostart, isAutostartEnabled, enableWatchdogAutostart, disableWatchdogAutostart, isWatchdogAutostartEnabled } from "./autostart.mjs";
import { spawnWatchdog, stopWatchdog, probeWatchdog } from "./agent-watchdog.mjs";
import { loadSettings, saveSettings, defaultSettingsPath, createLogLevelGate } from "./relay-settings.mjs";
import { logLevelAllows } from "./logger.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { getRelayStatus, startRelay, stopRelay, restartRelay } from "./relay-process-manager.mjs";
import { spawnAgentSync } from "./agent-sync-spawn.mjs";
import { readSyncStatus, writeSyncStatus, syncStatusFromResult } from "./sync-status.mjs";
import { createSkillsService, pickFile, pickFolder } from "./agent-skills.mjs";
import { createDataBundleService } from "./data-bundle.mjs";
import { createPromptsService } from "./agent-prompts.mjs";
import { createPromptsInjector } from "./agent-prompts-inject.mjs";
import { createStoreService } from "./store-service.mjs";
import { createUsageJournal, dayKey } from "./usage-journal.mjs";
import { attributeTerminalSessions, filterTerminalRequestRows } from "./terminal-attribution.mjs";
import { AGENT_TERMINAL_TARGETS, AGENT_RELAY_PORT, buildAgentSessionLaunch } from "./agent-session-env.mjs";
import { createUsageStats, clampStatDays, stripWirePrefix } from "./usage-stats.mjs";
import { spawnPanelHostRestartHelper } from "./panel-host-restart-helper.mjs";
import {
  clientUpdateJournalDir,
  clientUpdateStatus,
  listClientUpdateRuns,
  readClientUpdateRun,
  reapDeadClientUpdateRuns,
  runningClientUpdate,
  spawnClientUpdateWorker,
  writeClientUpdateRun,
} from "./client-update-journal.mjs";
import { APP_REPO_URL, SELF_UPDATE_CLIENT_ID, spawnSelfUpdateWorker } from "./app-self-update.mjs";
import { readLocalHead as readLocalHeadDefault, readRemoteRefs as readRemoteRefsDefault, readRemoteHeadRelation as readRemoteHeadRelationDefault } from "./app-git-identity.mjs";
import { compareVersions as compareVersionsDefault, parseVersion as parseVersionDefault } from "./version-check.mjs";
import { loadMessages as sessionLoadMessages, deleteSessions as sessionDeleteSessions, buildTurns as sessionBuildTurns, defaultScanner as sessionScanner } from "./session-scan.mjs";
import { createSessionScanOffload } from "./session-scan-worker.mjs";
import { TERMINAL_HOST_PORT } from "./terminal-process-manager.mjs";
import { probeTerminalCommandTree as defaultProbeTerminalCommandTree } from "./terminal-switch-guard.mjs";
import {
  RESUMABLE_AGENTS,
  TERMINAL_CONVERSATION_BINDINGS_FILE,
  bindingFromMeta,
  createBindingStore,
  pickConversationMeta,
  pickRefreshedMeta,
  resumeArgsFor,
  sameCwd,
} from "./terminal-conversation-bindings.mjs";
import { createRailStore, TERMINAL_RAIL_STORE_FILE } from "./terminal-rail-store.mjs";

// 面板自身的安装目录：git 身份查询（HEAD）与自更新登记都锚在这里。放在
// APP_VERSION 之前——panel-environment 的 VM 切片从版本声明起、到面板 HTML
// 路径常量止，只圈版本声明，不圈路径常量。
const APP_DIR = dirname(fileURLToPath(import.meta.url));
const APP_VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const APP_INFO = Object.freeze({
  version: APP_VERSION,
  platform: process.platform,
  nodeVersion: process.version,
  prerelease: APP_VERSION.includes("-"),
});

const REPO_PANEL_HTML = join(APP_DIR, "panel-ui", "panel.html");
const REPO_PANEL_CSS = join(APP_DIR, "panel-ui", "panel.css");
const REPO_PANEL_JS = join(APP_DIR, "panel-ui", "panel.js");
const REPO_PANEL_LOGO = join(APP_DIR, "docs", "assets", "logo.png");
const REPO_XTERM_JS = join(APP_DIR, "node_modules", "@xterm", "xterm", "lib", "xterm.js");
const REPO_XTERM_CSS = join(APP_DIR, "node_modules", "@xterm", "xterm", "css", "xterm.css");
const REPO_XTERM_FIT_JS = join(APP_DIR, "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js");
const REPO_XTERM_UNICODE11_JS = join(APP_DIR, "node_modules", "@xterm", "addon-unicode11", "lib", "addon-unicode11.js");
const REPO_XTERM_WEBGL_JS = join(APP_DIR, "node_modules", "@xterm", "addon-webgl", "lib", "addon-webgl.js");
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
// time — a PowerShell Get-ScheduledTask spawn plus an HTTP liveness probe —
// and the panel page fetches /api/settings on every load to hydrate the 抗截断
// toggle, so paying them per GET made that toggle wait on the probes.
// The snapshot is stale-while-revalidate: once a probe round has settled,
// GETs return instantly (stale values past the TTL) while one shared
// background round refreshes. POST followAgent invalidates so the next GET
// re-probes synchronously and never reports pre-toggle drift.
const WATCHDOG_SNAPSHOT_TTL_MS = 30_000;

// 会话列表快照的 TTL（见 createSessionsListSnapshot）。同样是 stale-while-
// revalidate：TTL 内复用上一次全盘扫描结果，过期后先交旧值再后台补一拍。
// 30s 远大于最坏扫描（实测 8s），所以正常使用下不会出现「扫描刚完又该扫了」。
const SESSIONS_LIST_TTL_MS = 30_000;

// 请求日志路由（/panel/api/stats/logs）的枚举与钳制口径：range 档位 → 含当天
// 往前推的天数（all = 90 天 retention 窗口）；status 档位同时是 errKind 枚举
// 子集（ok 单独映射 ok=true）；pageSize 白名单。非法值一律回落默认。
const LOG_RANGES = ["today", "7d", "30d", "all"];
const LOG_RANGE_BACK_DAYS = { today: 0, "7d": 6, "30d": 29, all: 89 };
const LOG_STATUSES = ["all", "ok", "http_429", "http_5xx", "http_4xx", "network", "timeout"];
const LOG_PAGE_SIZES = [20, 50, 100];

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

// 「Agent 装在本机」的判定规则（环境检测 clients → 可见 id 集）：
// 任一安装形态（CLI/桌面）status 非 not_found（found 或 error）即算在——检测
// 出错按在（fail-open，宁可多显示也不藏掉真实存在的 Agent）；全部形态都
// not_found 才算不在。清单缺失/为空/null 返回 null = 检测异常形态，调用方
// 一律按「不过滤」处理。前端 panel.js loadInstalledAgentIds 用同一规则手抄
// 一份（前端无模块通道），改判定时两处同步。
export function deriveVisibleEndpointIds(clients) {
  if (!Array.isArray(clients) || !clients.length) return null;
  const visible = new Set();
  for (const client of clients) {
    const installations = Array.isArray(client.installations) ? client.installations : [];
    if (installations.some((item) => item && item.status !== "not_found")) visible.add(client.id);
  }
  return visible;
}

// Prompts tab facade: pairs the prompts data plane (agent-prompts.mjs) with
// the injector (agent-prompts-inject.mjs). Every mutation is followed by a
// full syncAll across all endpoints; per-endpoint failures land in the
// `sync` snapshot served by getState and never fail the mutation itself.
// `homeDir` is injectable so tests can keep all writes inside temp dirs.
// `isEndpointVisible`（panel.mjs 注入，缺省恒 true 供测试）按「装在本机」
// 收口：getState 的端点清单不含未安装的 Agent；syncAll 对未安装的 Agent 按
// 空预设集处理——既有移除语义会把残留的托管块摘掉（文件只剩块时连文件一起
// 删），等于顺带清理「装过又卸载」留下的注入，也不会给新机器造文件。
export function createPromptsPanelService({ base = process.env, homeDir, isEndpointVisible = () => true } = {}) {
  const data = createPromptsService({ base });
  const injector = createPromptsInjector({ ...(homeDir ? { homeDir } : {}) });
  let lastSync = {};
  const mutateAndSync = (result) => {
    lastSync = injector.syncAll((endpointId) =>
      (isEndpointVisible(endpointId) ? data.resolveForEndpoint(endpointId) : []));
    return result;
  };
  return {
    getState() {
      return {
        ...data.getState(),
        endpoints: injector.listEndpoints()
          .filter((ep) => isEndpointVisible(ep.id))
          .map(({ id, label, hotReload, targetRel }) => ({ id, label, hotReload, targetRel })),
        sync: lastSync,
      };
    },
    setMaster: (enabled) => mutateAndSync(data.setMaster(enabled)),
    createPreset: (fields) => mutateAndSync(data.createPreset(fields)),
    updatePreset: (fields) => mutateAndSync(data.updatePreset(fields)),
    deletePreset: (id) => mutateAndSync(data.deletePreset(id)),
    setPresetEnabled: (args) => mutateAndSync(data.setPresetEnabled(args)),
    reorderPresets: (order) => mutateAndSync(data.reorderPresets(order)),
    setOverride: (args) => {
      if (!injector.hasEndpoint(args?.endpointId)) {
        const error = new Error(`未知端点: ${args?.endpointId}`);
        error.statusCode = 400;
        throw error;
      }
      if (!isEndpointVisible(args?.endpointId)) {
        const error = new Error("该 Agent 未安装，无法配置注入");
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

// 会话列表快照：GET /panel/api/sessions/list 是九家存档的全盘扫描（S2 实测
// 2927 条会话 2.7–8.0s / 1.6MB 响应）。修前每个请求都重扫一遍，面板进程的
// 事件循环被整段按住——终端字节流、SSE 握手、1s 轮询一起停摆。
// 现在：{ at, value } 快照 + 短 TTL + 在飞去重 + 过期先返回旧值、后台补一拍。
// TTL 取 30s 的理由：会话栏是粗粒度清单（列表本身不带 buffer，行只用于选一
// 条去读/去删），而最坏扫描实测 8s——TTL 远大于扫描时长，不会背靠背排队重扫；
// 本进程自己的删除会先就地摘掉对应行再置脏（见 dropRows），用户删完立刻看不
// 到那行；别处新建/删除的会话最多晚 TTL 一拍出现，对「进终端页填左栏历史」
// 这条唯一消费路径没有可感知代价。
function createSessionsListSnapshot(load, ttlMs) {
  const inFlight = { p: null };
  let snap = null;

  function refresh() {
    if (inFlight.p) return inFlight.p;
    const round = (async () => {
      try {
        const value = await load();
        snap = { at: Date.now(), value };
        return value;
      } finally {
        // 微任务延迟一拍再摘，避免「round 已落定但等待者还没读到」时的同步重扫。
        await Promise.resolve();
        inFlight.p = null;
      }
    })();
    inFlight.p = round;
    return round;
  }

  return {
    // 冷缓存（本进程还没扫过）：只能等这一拍——没有旧值可交，列表不能凭空
    // 空着。失败照实抛给路由（500），与修前一致。
    // 有过结果：TTL 内直接复用；过期则交旧值、后台补一拍，请求绝不等刷新。
    async get() {
      if (!snap) return refresh();
      if (Date.now() - snap.at < ttlMs) return snap.value;
      refresh().catch(() => {});
      return snap.value;
    },
    // 本进程刚删掉的行就地摘掉（响应里立刻不再出现），并把快照置为过期：
    // 下一拍请求先拿这份（已摘掉那行）的旧值，同时后台补一扫与盘面对齐。
    // 没有快照时什么都不做——下一拍自然是冷扫。
    dropRows(predicate) {
      if (!snap || !Array.isArray(snap.value?.sessions)) return;
      snap = {
        at: 0,
        value: { ...snap.value, sessions: snap.value.sessions.filter((session) => !predicate(session)) },
      };
    },
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
//
// 「拉不到」有两种完全不同的含义，只有一种该让面板自己的收集器顶上：
// - relay 没在听（停止、还没起、端口被占）：它确实不经任何流量，0 请求就是事实；
// - relay 活着只是这一拍没答上（1500ms 预算撞上冷探针，本机实测冷探针一轮
//   0.64–0.87s，承压时更久）：流量全在它那边，自家收集器交出的是一幅结构相同
//   的假帧——端点显示运行中、请求数与四宫格全空。
// 所以超时单独返回 `{ pullTimeout: true }`（不是数组，调用侧据此分路），注入的
// 测试替身照旧返回数组或 null，两条既有分支都不受影响。
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
  } catch (err) {
    // AbortSignal.timeout 抛的是 TimeoutError：连接已建立、只是没在预算内答完。
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      return { pullTimeout: true };
    }
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

// Pull-mode terminal attribution: the relay's live agent client processes,
// each with its ancestor chain (47821/api/internal/detected-processes), for
// joining terminal-host sessions by shell pid — plus each session-granular
// endpoint's session metas (row-id-shaped ids with cwd/lastActive/originator):
// codex-sess-* and opencode-sess-* are the bridge data for those two endpoints,
// whose instance rows name a conversation rather than a process. Returns
// { processes, codexSessions, opencodeSessions }, or null on failure — the
// caller degrades to unannotated sessions rather than erroring the whole
// session list. An old relay without a given field yields an empty list (that
// bridge then simply never binds, same as before).
async function defaultFetchRelayDetectedProcesses(root, token) {
  if (!token) return null;
  try {
    const response = await fetch("http://127.0.0.1:47821/api/internal/detected-processes", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data && Array.isArray(data.processes)) {
      return {
        processes: data.processes,
        codexSessions: Array.isArray(data.codexSessions) ? data.codexSessions : [],
        opencodeSessions: Array.isArray(data.opencodeSessions) ? data.opencodeSessions : [],
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Direct terminal-host session-list fetch (47823). Injectable so the router
// is unit-testable without a live terminal-host; the real one resolves the
// same pi-relay-token the proxy uses.
async function defaultFetchTerminalSessionsList(root) {
  let token = null;
  try {
    token = loadOrGenerateToken(root);
  } catch {
    return null;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${TERMINAL_HOST_PORT}/terminal/sessions`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data && Array.isArray(data.sessions)) return data.sessions;
    return null;
  } catch {
    return null;
  }
}

// One-click CLI Agent launch: the assembled launch + env delta go straight to
// terminal-host as a session-create body. Injectable like the list fetch so
// the router is unit-testable without a live host; the real one authorises with
// the same pi-relay-token the proxy uses. Returns { status, body }, or null
// when the host is unreachable (the caller answers 503).
async function defaultCreateTerminalSession(body, { token } = {}) {
  if (!token) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${TERMINAL_HOST_PORT}/terminal/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, body: payload };
  } catch {
    return null;
  }
}

// 复活一条已退出的会话：先读它的身份（agentId/cwd），再按当前安装与设置重新
// 组装 launch 与 env，最后交给宿主重开。env 从不落盘，所以凭据只能在这里重建；
// 宿主自己重启一个 agent 会话时拿不到这些值，起来的就是 agent 的原生实例。
// 读的是列表路由而不是单条：单条会连回放窗一起送过来（可达数百 KB），复活只
// 需要身份三件套，而列表本来就不带 buffer。
async function defaultFetchTerminalSession(id, { token } = {}) {
  if (!token) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${TERMINAL_HOST_PORT}/terminal/sessions`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const list = Array.isArray(payload?.sessions) ? payload.sessions : [];
    return list.find((item) => item && item.id === id) ?? null;
  } catch {
    return null;
  }
}

async function defaultRestartTerminalSession(id, body, { token } = {}) {
  if (!token) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${TERMINAL_HOST_PORT}/terminal/sessions/${encodeURIComponent(id)}/restart`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, body: payload };
  } catch {
    return null;
  }
}

// 绑定捕获/复活兜底共用的单端点对话存档扫描：只扫该 agent 一家（全量 scanAll
// 要读九家存档，列表轮询路径用不起）。名单外与读盘失败降级为空表的纪律在
// session-scan 的 scanEndpoint 里（匹配层拿到空表自然判不出，按「宁可不接」
// 回落）。真正的执行位置由扫描承载决定——见 createPanelRouter 里的 scanHost：
// 默认进 worker 线程，面板进程不被这段同步 fs 扫描按住。

// Terminal-host lifecycle pull: the relay (47821) owns the host child and
// reports its state at /terminal-host/status (same pi-relay-token guard as
// /api/internal/*). Returns the parsed payload, or null when the relay is
// unreachable so callers degrade instead of erroring.
async function defaultFetchTerminalHostStatus(root, token) {
  if (!token) return null;
  try {
    const response = await fetch("http://127.0.0.1:47821/terminal-host/status", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data && typeof data === "object") return data;
    return null;
  } catch {
    // Relay may be stopped, starting, or not yet listening.
    return null;
  }
}

// start/stop against the same relay routes. The stop route waits for the child
// to actually exit (plus the optional session sweep), so the action budget sits
// well above the status pull's. Returns { status, body }, or null when the
// relay is unreachable (the caller answers 503 relay_unavailable).
async function defaultCallTerminalHostAction(action, body, { token } = {}) {
  if (!token) return null;
  try {
    const response = await fetch(`http://127.0.0.1:47821/terminal-host/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, body: payload };
  } catch {
    return null;
  }
}

// The relay answers with the state nested under `host`; the panel-facing
// payload is flat. The state vocabulary itself (running / stopped /
// stopped-manual / crashed) passes through verbatim — the panel page renders
// it directly — and manualStop is derived when the relay only encodes it in
// the state name.
function normalizeTerminalHostStatus(data) {
  const raw = data?.host && typeof data.host === "object" ? data.host : data;
  const state = typeof raw?.state === "string" ? raw.state : "unknown";
  return {
    state,
    pid: typeof raw?.pid === "number" ? raw.pid : null,
    manualStop: raw?.manualStop === true || state === "stopped-manual",
    lastExit: raw?.lastExit && typeof raw.lastExit === "object" ? raw.lastExit : null,
  };
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
              // 级别只取字段。中继自 0.6.x 起不再把级别写进消息文本，但升级过程中
              // 面板可能先重启、对面还是旧进程，旧格式的消息自带 "[level] " 前缀；
              // 原样透传会让窗口里出现两个级别标签，所以这里剥掉一个前导级别标记。
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

// Bridge the relay's agent-activity stream (47821 /api/internal/agents-activity,
// same pi-relay-token guard as the agents pull) into this panel process. The
// relay pushes absolute activeRequests states for (endpointId, instanceId)
// pairs: a snapshot frame first, then activity frames only on 0↔N transitions,
// with comment-line heartbeats in between. The bridge keeps a latest-state Map
// so the browser-side /panel/api/agents-activity route can send a fresh client
// the cached snapshot the moment it connects, then forwards frames verbatim;
// relay heartbeat comment lines pass straight through to keep the panel→
// browser SSE alive too. The relay being down is not an error: the bridge
// retries with exponential backoff and the cache keeps the last known truth.
//
// Unlike the log bridge, subscribing the relay to its own stream would only be
// wasteful, not self-amplifying (nothing re-enters the source bus) — still,
// the bridge is created lazily on the first browser subscription, and the
// panel page lives on panel-host only, so relay-host never starts one in
// practice.
export function startRelayActivityBridge(relayRoot) {
  let stopped = false;
  let controller = null;
  let retryTimer = null;
  let failures = 0;
  const subscribers = new Set();
  const latest = new Map();

  const keyOf = (endpointId, instanceId) => `${endpointId} ${instanceId ?? ""}`;

  // The session model every browser client aligns to on connect: one
  // snapshot frame built from the latest per-key state.
  function snapshotFrame() {
    return { type: "snapshot", instances: [...latest.values()] };
  }

  function publish(block) {
    for (const subscriber of subscribers) {
      try {
        subscriber(block);
      } catch {
        // A broken subscriber must never kill the bridge.
      }
    }
  }

  function absorbLine(line) {
    if (line.startsWith(":")) {
      publish(`${line}\n\n`);
      return;
    }
    if (!line.startsWith("data:")) return;
    let frame = null;
    try {
      frame = JSON.parse(line.slice(5).trim());
    } catch {
      // Malformed frame: skip it, never kill the bridge.
      return;
    }
    if (frame?.type === "snapshot" && Array.isArray(frame.instances)) {
      latest.clear();
      for (const inst of frame.instances) {
        if (!inst || typeof inst.endpointId !== "string") continue;
        latest.set(keyOf(inst.endpointId, inst.instanceId ?? null), {
          endpointId: inst.endpointId,
          instanceId: inst.instanceId ?? null,
          activeRequests: typeof inst.activeRequests === "number" ? inst.activeRequests : 0,
          at: typeof inst.at === "number" ? inst.at : null,
        });
      }
    } else if (frame?.type === "activity" && typeof frame.endpointId === "string") {
      latest.set(keyOf(frame.endpointId, frame.instanceId ?? null), {
        endpointId: frame.endpointId,
        instanceId: frame.instanceId ?? null,
        activeRequests: typeof frame.activeRequests === "number" ? frame.activeRequests : 0,
        at: typeof frame.at === "number" ? frame.at : null,
      });
    } else {
      return;
    }
    publish(`${line}\n\n`);
  }

  // 指数退避：1s 起翻倍，30s 封顶；一次成功握手即归零。
  function scheduleRetry() {
    if (stopped) return;
    retryTimer = setTimeout(connect, Math.min(30_000, 1_000 * 2 ** failures));
    failures += 1;
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
      const response = await fetch("http://127.0.0.1:47821/api/internal/agents-activity", {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        scheduleRetry();
        return;
      }
      failures = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Frames are single JSON lines; blank lines and the blank line that
        // terminates each SSE block are skipped by absorbLine.
        let sep;
        while ((sep = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 1);
          absorbLine(line.replace(/\r$/, ""));
        }
      }
    } catch {
      // Relay stopped mid-stream or fetch failed — fall through to retry.
    }
    scheduleRetry();
  }

  connect();
  return {
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    snapshotFrame,
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      controller?.abort();
    },
  };
}

export function createPanelRouter({
  storePaths,
  logger,
  metricsCollector,
  base = process.env,
  startTime = Date.now(),
  appInfo = APP_INFO,
  // Relay lifecycle is owned by relay-process-manager (a separate process on
  // 47821). These default to the real supervisor but are injectable so the
  // router is unit-testable without spawning processes or binding sockets.
  //
  // The agent-config sync spawner gets the same treatment: the reasoning-level
  // setting governs what every endpoint's config is told, so saving it fires a
  // sync. The default spawns a real child process that rewrites the user's own
  // endpoint configs under ~/.zcode, ~/.pi, ~/.codex and friends — a unit test
  // must never do that, so this is injectable like the relay controls.
  spawnAgentSyncFn = spawnAgentSync,
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
   fetchRelayDetectedProcesses = defaultFetchRelayDetectedProcesses,
   fetchTerminalSessionsList = defaultFetchTerminalSessionsList,
   createTerminalSession = defaultCreateTerminalSession,
   fetchTerminalSessionFn = defaultFetchTerminalSession,
   restartTerminalSessionFn = defaultRestartTerminalSession,
   // 内切换内容前的杀前兜底探测（terminal-switch-guard.mjs）：会话 PTY 树里有没有
   // 活着的命令子进程。默认真跑 PowerShell 全表；单测注入桩，不碰真进程枚举。
   probeTerminalCommandTreeFn = defaultProbeTerminalCommandTree,
  // 判「忙」后复探的间隔：agent 启动期的瞬时子进程（环境探测、chcp、一次性包装壳）
   // 与一次探测超时都会让单次判定落到「忙」，隔一拍再探一次即能分清瞬时与真在跑。
   switchGuardRecheckDelayMs = 700,
   // 复探的单次超时：只用来确认「刚才那波子进程还在不在」，不需要首探那么宽。
   switchGuardRecheckTimeoutMs = 2000,
   // 终端会话 ↔ agent 对话存档的绑定（terminal-conversation-bindings.mjs）：
   // 复活时按绑定/兜底扫描给 launch 追加 resume 参数。store 为 null 时按
   // relayRoot 惰性建真库；扫描与刷新拍节可注入，单测不碰真存档、不挂真定时器。
   terminalBindingStore = null,
   // 单端点对话存档扫描（绑定捕获 / 复活兜底共用）。`null` = 走扫描承载
   // （session-scan-worker.mjs：worker 线程里跑，面板进程零阻塞）；单测注入
   // 假扫描函数时原地同步跑，不碰真存档、也不起 worker。
   scanAgentConversationsFn = null,
   // 扫描承载的 worker 模块（session-scan-worker.mjs）。默认 null＝用模块自带的
   // 那一个（同文件既是主线程壳也是 worker 体）。给单测一个替换口：把「扫描」
   // 换成忙等块，用来钉住「扫描不占面板事件循环」——修前这条会红。
   sessionScanWorkerFile = null,
   // 终端会话栏的视图状态（归档清单 + 已移除分组目录清单，M7）：store 为 null 时
   // 按 relayRoot 惰性建真库，单测注入内存/临时文件库。
   terminalRailStore = null,
   bindingCaptureDebounceMs = 5000,
   bindingRefreshDelayMs = 10_000,
   bindingRefreshScheduleFn = (fn, ms) => {
     const timer = setTimeout(fn, ms);
     timer.unref?.();
     return timer;
   },
   // Terminal-host lifecycle against the relay (47821 /terminal-host/*): the
   // relay owns the host child, so status/start/stop all live there behind the
   // same pi-relay-token guard as /api/internal/*. Injectable so tests never
   // touch a live relay.
   fetchTerminalHostStatus = defaultFetchTerminalHostStatus,
   callTerminalHostAction = defaultCallTerminalHostAction,
  // Agent-activity push bridge (startRelayActivityBridge): this process's
  // subscription to the relay's agents-activity SSE plus its latest-state
  // cache. Injectable so tests never touch 47821; `null` lazily builds the
  // real bridge on the first browser subscription, so a panel-host nobody is
  // watching does not hold a relay connection open.
  agentsActivityBridge = null,
  // Skills tab service (agent-skills.mjs). Injectable so the router is
  // unit-testable without real home directories, junctions, or PowerShell.
  // `null` lazily builds the real service on first skills request.
  skillsService = null,
  // 数据搬迁包服务（data-bundle.mjs）。可注入以便单测；`null` 时首次请求
  // 按当前 base 惰性建真服务。两个原生选择框同样可注入，单测不起对话框进程。
  dataBundleService = null,
  pickFolderFn = pickFolder,
  pickFileFn = pickFile,
  // BYOK 渠道导入服务（byok-import.mjs 装配 byok-remove.mjs）。可注入以便单测；
  // `null` 时首次请求按当前 relayRoot 惰性建真服务。真实模块经动态 import 装入
  // （见路由块注释），所以注入假服务的测试永远不会加载真模块。
  byokImportService = null,
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
  // deleteSessions() over the nine agents' on-disk session stores.
  // Injectable for tests; `null` lazily binds the real module's exports on
  // the first sessions request.
  sessionScanService = null,
  // 会话列表快照的 TTL（见 createSessionsListSnapshot）。注入给单测：0 = 每一拍
  // 都视为过期（验「先返回旧值、后台刷新」），默认 30s。
  sessionsListTtlMs = SESSIONS_LIST_TTL_MS,
  environmentService = null,
  releaseService = null,
  // 客户端更新的脱离进程。注入给测试；`null` 用真实的脱离拉起。
  // 安装不在面板进程里跑：面板退出会把还没脱离的子进程一起带走，全局目录留半截。
  spawnClientUpdateWorkerFn = null,
  clientUpdateJournalDir: clientUpdateDir = null,
  // 自身更新的脱离进程与面板内换装监听器，同一注入纪律：单测不起真进程、不挂
  // 真定时器，监听器的点火由测试手动泵（捕获 scheduleFn 的回调后自行调用）。
  spawnSelfUpdateWorkerFn = null,
  selfUpdateWatchScheduleFn = (fn, ms) => setInterval(fn, ms),
  selfUpdateWatchCancelFn = (timer) => clearInterval(timer),
  // 自动检测并下载更新的调度（首开一拍 + 周期拍），同一注入纪律。默认 null =
  // 不布拍节：createPanelRouter 的默认 hostKind 就是 panel-host，单测里到处建
  // 路由器，真实拍节只能由 panel-host.mjs 显式传入——否则测试进程里 60 秒后
  // 会真的去查更新、真的拉起 worker。
  selfUpdateAutoDownloadScheduleFn = null,
  // git 身份查询（app-git-identity.mjs）：本地 rev-parse / 远端 ls-remote，先行
  // 轨道与「本地安装 vs 官方发布」一致性判定共用。注入给单测——真 git 在测试里
  // 既慢又不稳定；默认走真模块。
  readLocalHeadFn = readLocalHeadDefault,
  readRemoteRefsFn = readRemoteRefsDefault,
  // 远端尖端 vs 本地 HEAD 的祖先后系（先行轨防倒退）：判不了时保持既有邀请行为。
  readRemoteHeadRelationFn = readRemoteHeadRelationDefault,
  // 远端身份短缓存 TTL：进页自动检查吃缓存，refresh=1 的强制检查绕过。
  remoteIdentityTtlMs = 60_000,
 }) {
  const settingsFile = defaultSettingsPath(base);
  // 实时输出级别过滤的活读闸门：面板一开就是几小时甚至几天，用户在设置页改了级别，
  // 已经建着的日志流必须当场按新级别走，不能等下次重启面板。它只读设置，不写。
  const logLevelGate = createLogLevelGate(settingsFile, base);
  const relayRoot = storePaths?.root ?? defaultStorePaths().root;
  // 扫描承载（session-scan-worker.mjs）：session-scan 的九个 adapter 全是同步 fs，
  // 在哪调用就在哪按住事件循环。这里把「九家全量」与「单端点」两种扫描都送进
  // 独立 worker 线程；worker 不可用时退回本进程（面板仍出列表，只那一拍会卡），
  // 降级路径在承载里一次性收敛并记一条 warn。
  const scanHost = createSessionScanOffload({
    ...(sessionScanWorkerFile ? { workerFile: sessionScanWorkerFile } : {}),
    logger,
    fallback: {
      scanAll: () => sessionScanner.scanAll(),
      scanAgent: (agentId) => sessionScanner.scanEndpoint(agentId),
    },
  });
  // 注入的假扫描函数（单测）原地同步跑——不碰真存档，也不起 worker；显式指定
  // 了 worker 模块时一律走 worker（离线钉靠这条证明扫描不占事件循环）。
  const scanAgentConversations = scanAgentConversationsFn && !sessionScanWorkerFile
    ? scanAgentConversationsFn
    : (agentId) => scanHost.scanAgent(agentId);
  // 会话列表快照（短 TTL + 在飞去重 + 过期先返回旧值）。首次用到时才建，
  // 装载函数指向最终绑定的 session-scan 服务（注入的或真模块）。
  let sessionListSnapshot = null;
  // 按「谁提供 scanAll」建快照：注入假服务的单测与真模块各走各的，且只建一次
  // （快照一旦建好就一直服务这个 router 的列表路由）。
  function sessionsListSnapshotFor(svc) {
    if (!sessionListSnapshot) {
      sessionListSnapshot = createSessionsListSnapshot(() => svc.scanAll(), sessionsListTtlMs);
    }
    return sessionListSnapshot;
  }
  // Watchdog drift snapshot (see createWatchdogSnapshot above): GET /api/settings
  // answers instantly once a probe round has settled; POST followAgent invalidates.
  const watchdogSnapshot = createWatchdogSnapshot(isWatchdogAutostartEnabledFn, probeWatchdogFn, watchdogSnapshotTtlMs);

  // Lookup chain: ANYSWITCH_PANEL_HTML env override → bundled panel-ui/panel.html.
  // A missing file falls through to servePanelFile's readFileSync failure → 404.
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

  function terminalPullToken() {
    try {
      return loadOrGenerateToken(relayRoot);
    } catch {
      return null;
    }
  }

  async function proxyTerminal(req, res, targetPath, method = req.method, body = undefined) {
    const token = terminalPullToken();
    if (!token) return sendJson(res, 503, { ok: false, error: "terminal_host_unavailable" });
    try {
      const response = await fetch(`http://127.0.0.1:${TERMINAL_HOST_PORT}${targetPath}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const contentType = response.headers.get("content-type") || "application/json";
      res.writeHead(response.status, { "content-type": contentType, "cache-control": "no-cache" });
      if (!response.body) return res.end();
      const reader = response.body.getReader();
      req.on("close", () => reader.cancel().catch(() => {}));
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (!res.write(Buffer.from(part.value))) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
      return res.end();
    } catch (error) {
      if (!res.headersSent) return sendJson(res, 503, { ok: false, error: "terminal_host_unavailable", detail: error.message });
      res.end();
    }
  }

  // ---- Terminal session attribution (virtual terminal) ----
  // The session list stopped being a blind passthrough the moment sessions
  // had to carry owner info: the list joins terminal-host snapshots (shell
  // pid) with the relay's detected client processes (ancestor chains) into a
  // per-session `agent` field. Relay outage degrades to plain shell sessions
  // — never to a failed list.
  const PULLED_DETECTED_STALE_MAX_MS = 5000;
  // 谱系盲可疑轮的回退窗口：relay 有应答但 ancestors 全空（探针单次超时落
  // tasklist 兜底轮）时允许回退到的上一份好 feed 的最大年龄。比拉取失败路
  // 径宽——兜底轮之后要等下一整轮探针扫描好谱系才回来。
  const PULLED_DETECTED_SUSPECT_STALE_MAX_MS = 10000;
  let lastPulledDetected = null; // { at, feed } where feed = { processes, codexSessions }

  // 谱系盲判定：processes 为空数组，或非空但每行 ancestors 都是空数组——
  // tasklist 兜底轮的 feed 形状（谱系表为空但 relay 有应答）。空 ancestors
  // 意味着 shell pid join 断了，可进程面还在：直接当事实会让全部 agent 终端
  // 丢归属一轮（前端侧栏塌缩回弹的「抽搐」源头）。
  function isLineageBlindFeed(feed) {
    const processes = Array.isArray(feed?.processes) ? feed.processes : [];
    if (processes.length === 0) return true;
    return processes.every((row) => !Array.isArray(row?.ancestors) || row.ancestors.length === 0);
  }

  async function pulledDetectedProcesses(token) {
    const pulled = await fetchRelayDetectedProcesses(relayRoot, token);
    if (pulled) {
      if (isLineageBlindFeed(pulled)) {
        // 可疑轮：窗口内有上一份好 feed 就回退那份——只有好轮写缓存，所以
        // 缓存在册的一定是好 feed，可疑轮绝不覆盖它。窗口外或没有缓存才透
        // 传：没有 agent 在跑的机器 relay 本来就答空 processes，现状语义保持。
        if (lastPulledDetected && Date.now() - lastPulledDetected.at <= PULLED_DETECTED_SUSPECT_STALE_MAX_MS) {
          return lastPulledDetected.feed;
        }
        return pulled;
      }
      lastPulledDetected = { at: Date.now(), feed: pulled };
      return pulled;
    }
    if (lastPulledDetected && Date.now() - lastPulledDetected.at <= PULLED_DETECTED_STALE_MAX_MS) {
      return lastPulledDetected.feed;
    }
    // Last resort, mirroring handleAgents' local-collector fallback: this
    // process's own collector scans processes too (it owns no traffic, but
    // the lineage table is traffic-independent), and its per-endpoint session
    // caches can feed the session bridges the same way. A collector without
    // those getters (older shape) degrades to empty lists.
    if (metricsCollector?.getDetectedClientProcesses) {
      try {
        const processes = metricsCollector.getDetectedClientProcesses();
        if (processes === null || processes === undefined) return null;
        const pull = async (name) => {
          if (typeof metricsCollector[name] !== "function") return [];
          try {
            const metas = await metricsCollector[name]();
            return Array.isArray(metas) ? metas : [];
          } catch {
            return [];
          }
        };
        return {
          processes,
          codexSessions: await pull("getCodexSessionsForTerminalJoin"),
          opencodeSessions: await pull("getOpencodeSessionsForTerminalJoin"),
        };
      } catch {
        return null;
      }
    }
    return null;
  }

  // Fresh agents for the attribution join: live pull, then the same bounded
  // staleness window handleAgents serves, else null (names and instance
  // binding fall back inside attributeTerminalSessions).
  async function pulledAgentsForJoin(token) {
    const pulled = await fetchRelayAgents(relayRoot, token);
    // 超时标记不是 agents 数组（见 defaultFetchRelayAgents），不能当成一份快照存进缓存。
    if (Array.isArray(pulled)) {
      lastPulledAgents = { at: Date.now(), agents: pulled };
      return pulled;
    }
    if (lastPulledAgents && Date.now() - lastPulledAgents.at <= PULLED_AGENTS_STALE_MAX_MS) {
      return lastPulledAgents.agents;
    }
    return null;
  }

  async function handleTerminalSessionsList(res) {
    const list = await fetchTerminalSessionsList(relayRoot);
    if (list === null) return sendJson(res, 503, { ok: false, error: "terminal_host_unavailable" });
    // Output buffers belong to the SSE stream, not the polling list.
    const sessions = list.map(({ buffer, ...rest }) => rest);
    // 绑定捕获只在控制面进程跑：relay 侧也挂着同一套路由器，绑定库只认
    // panel-host 一个写入方（页面本来就只由 47820 服务，relay 实际收不到
    // 这个轮询，这里把「实际」钉成「制度」）。
    if (hostKind === "panel-host") captureTerminalConversationBindings(sessions);
    const feed = await pulledDetectedProcesses(terminalPullToken());
    const detected = feed ? feed.processes : null;
    if (!detected || detected.length === 0) return sendJson(res, 200, { ok: true, sessions });
    const agents = await pulledAgentsForJoin(terminalPullToken());
    const sessionFeeds = {
      codex: feed && Array.isArray(feed.codexSessions) ? feed.codexSessions : [],
      opencode: feed && Array.isArray(feed.opencodeSessions) ? feed.opencodeSessions : [],
    };
    sendJson(res, 200, { ok: true, sessions: attributeTerminalSessions(sessions, detected, agents, sessionFeeds) });
  }

  // ---- 终端会话 ↔ agent 对话存档绑定（复活带回原对话） ----
  // 存储在 relayRoot（%LOCALAPPDATA%\Anyswitch）下，与 terminal-sessions.json
  // 同目录；匹配纪律全在 terminal-conversation-bindings.mjs，这里只做调度。
  function terminalBindings() {
    if (!terminalBindingStore) {
      terminalBindingStore = createBindingStore({ file: join(relayRoot, TERMINAL_CONVERSATION_BINDINGS_FILE) });
    }
    return terminalBindingStore;
  }

  // ---- 终端会话栏视图状态（M7：归档 / 分组移除） ----
  // 与绑定库同一条惰性装配：存储在 relayRoot 下，读写失败不影响面板主流程——
  // 归档与分组移除是视图状态，丢了最坏回到「没归档过」，不该把列表路由带崩。
  function terminalRailPrefs() {
    if (!terminalRailStore) {
      terminalRailStore = createRailStore({ file: join(relayRoot, TERMINAL_RAIL_STORE_FILE) });
    }
    return terminalRailStore;
  }

  // 视图状态全量快照。进终端会话栏时拉一次，之后每个动作的响应里也带最新快照，
  // 前端不必为了刷新状态再补一发 GET。
  function handleTerminalRailPrefs(res) {
    const { archived, removedGroups } = terminalRailPrefs().list();
    sendJson(res, 200, { ok: true, archived, removedGroups });
  }

  // 归档动作的入参校验：endpoint 与 id 都必须是实言实的非空串。store 自己也会
  // 清洗，这里提前拒是为了回 400 让前端知道「这条没存上」。
  function railArchiveBody(body) {
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!endpoint || !id) return null;
    return { endpoint, id };
  }

  async function handleTerminalRailArchive(req, res, action) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, error.statusCode ?? 400, { ok: false, error: error.message });
    }
    try {
      if (action === "archive" || action === "unarchive") {
        const entry = railArchiveBody(body);
        if (!entry) return sendJson(res, 400, { ok: false, error: "会话身份不完整" });
        const store = terminalRailPrefs();
        if (action === "archive") store.archive(entry.endpoint, entry.id);
        else store.unarchive(entry.endpoint, entry.id);
        const snap = store.list();
        return sendJson(res, 200, { ok: true, archived: snap.archived });
      }
      const dir = typeof body?.dir === "string" ? body.dir.trim() : "";
      if (!dir) return sendJson(res, 400, { ok: false, error: "目录不能为空" });
      const store = terminalRailPrefs();
      if (action === "remove-group") store.removeGroup(dir);
      else store.restoreGroup(dir);
      const snap = store.list();
      return sendJson(res, 200, { ok: true, removedGroups: snap.removedGroups });
    } catch (error) {
      // 落盘失败如实回 500：视图状态没存上，前端要能知道（否则本地显示已归档、
      // 刷新回来还在，比报错更难理解）。
      logger?.warn?.(`terminal rail prefs persist failed: ${error?.message}`);
      return sendJson(res, 500, { ok: false, error: "视图状态保存失败，请重试" });
    }
  }

  // 捕获防抖：同一会话两次扫描尝试的最小间隔。记的是「尝试」而非「成功」——
  // 扫描慢/空表同样占一拍，1s 轮询的列表路由才不会每拍都重扫一遍盘。
  const bindingCaptureLastAttempt = new Map(); // sessionId → ms
  // 内切保终端 id：捕获扫描必须跟随最新一代身份，旧代返回不得覆盖新代。
  const terminalBindingGenerations = new Map(); // sessionId → 递增代际

  // 列表路由的异步旁路：给「未绑定且 running 的可续会 agent 会话」补绑定，
  // 顺手清掉会话已消失的孤儿绑定。绝不阻塞、绝不让列表请求失败——全部
  // fire-and-forget，扫描 promise 自己吞错。
  function captureTerminalConversationBindings(sessions) {
    let store;
    let keepIds;
    try {
      store = terminalBindings();
      keepIds = new Set(sessions.map((session) => session?.id).filter(Boolean));
      store.prune(keepIds);
    } catch {
      return; // 绑定库读写失败不影响列表主流程
    }
    // 防抖表同步收：会话消失后它的防抖条目没有存在意义。
    for (const sessionId of [...bindingCaptureLastAttempt.keys()]) {
      if (!keepIds.has(sessionId)) bindingCaptureLastAttempt.delete(sessionId);
    }
    for (const sessionId of [...terminalBindingGenerations.keys()]) {
      if (!keepIds.has(sessionId)) terminalBindingGenerations.delete(sessionId);
    }
    const now = Date.now();
    for (const session of sessions) {
      if (!session || typeof session.id !== "string" || session.id === "") continue;
      if (session.status !== "running" || !RESUMABLE_AGENTS.has(session.agentId)) continue;
      if (store.get(session.id)) continue;
      const lastAttempt = bindingCaptureLastAttempt.get(session.id) ?? 0;
      if (now - lastAttempt < bindingCaptureDebounceMs) continue;
      const generation = terminalBindingGenerations.get(session.id) ?? 0;
      const captured = { agentId: session.agentId, cwd: session.cwd };
      bindingCaptureLastAttempt.set(session.id, now);
      Promise.resolve()
        .then(() => scanAgentConversations(session.agentId))
        .then((metas) => {
          // 内切保 id，createdAt 不能代表本轮新对话的起点。以最近一次进程
          // 出生为界；扫描返回时身份/目录/代际已变即整份结果作废，防跨代抢绑。
          if ((terminalBindingGenerations.get(session.id) ?? 0) !== generation) return;
          const picked = pickConversationMeta(metas, {
            agentId: captured.agentId,
            cwd: captured.cwd,
            createdAt: session.spawnedAt ?? session.createdAt ?? null,
            lastActiveAt: null,
          });
          // 扫描期间可能已被兜底路径绑上：已有绑定不覆盖。
          if (picked && !store.get(session.id)) {
            store.set(session.id, bindingFromMeta(picked, { agentId: session.agentId, cwd: session.cwd }, "bound"));
          }
        })
        .catch(() => {});
    }
  }

  // 复活要追加的 resume 参数。三级判定：绑定在且存档还在 → 按绑定；绑定没有
  // 或已失效 → 生命周期重叠兜底扫描；还判不出 → null（维持现状空白复活）。
  // 扫描本身失败时：有绑定按绑定用（它先前是对的，扫描失败多半是暂时的），
  // 没绑定就是不接。
  async function resolveResumeArgsForRevive(session) {
    if (!RESUMABLE_AGENTS.has(session.agentId)) return null;
    const store = terminalBindings();
    const identity = { agentId: session.agentId, cwd: session.cwd };
    let metas = null;
    try {
      metas = await scanAgentConversations(session.agentId);
    } catch {
      metas = null;
    }
    const existing = store.get(session.id);
    if (existing) {
      const staleIdentity = existing.agentId !== session.agentId || !sameCwd(existing.cwd, session.cwd);
      if (!staleIdentity) {
        if (metas === null) return resumeArgsFor(session.agentId, existing);
        const found = metas.find((meta) => meta && meta.id === existing.conversationId);
        if (found) {
          const refreshed = { ...existing, file: typeof found.file === "string" && found.file !== "" ? found.file : existing.file };
          if (refreshed.file !== existing.file) store.set(session.id, refreshed);
          return resumeArgsFor(session.agentId, refreshed);
        }
        // 绑定的存档已从盘上消失：绑定失效，落兜底。
      }
      store.delete(session.id);
    }
    if (metas === null) return null;
    const picked = pickConversationMeta(metas, {
      ...identity,
      createdAt: session.createdAt ?? null,
      lastActiveAt: session.lastActiveAt ?? null,
    });
    if (!picked) return null;
    const binding = store.set(session.id, bindingFromMeta(picked, identity, "scanned"));
    return resumeArgsFor(session.agentId, binding);
  }

  // 复活成功后的自愈换绑：有的 agent resume 会另起新对话存档（绑定里的旧 id
  // 从此不再前进）。延迟一拍重扫，复活时刻之后「唯一活跃」的存档若是新 id
  // 就换绑；零条（还没落笔）或多条（同目录另有对话）都维持原绑定。
  function scheduleBindingRefresh(session, sinceMs) {
    bindingRefreshScheduleFn(() => {
      Promise.resolve()
        .then(() => scanAgentConversations(session.agentId))
        .then((metas) => {
          const picked = pickRefreshedMeta(metas, { agentId: session.agentId, cwd: session.cwd, sinceMs });
          if (!picked) return;
          const store = terminalBindings();
          const current = store.get(session.id);
          if (current && current.conversationId !== picked.id) {
            store.set(session.id, bindingFromMeta(picked, { agentId: session.agentId, cwd: session.cwd }, current.source));
          }
        })
        .catch(() => {});
    }, bindingRefreshDelayMs);
  }

  // 内切切换（M12-A）：把一条已开着的终端就地换成目标会话——宿主同记录内
  // terminate 旧进程树→spawn 目标会话→身份换绑，页签不新增。与复活路由的分工：
  // 复活用会话自己的身份重组装；内切用请求体给的目标会话身份（endpoint/id/file）
  // 重组装，cwd 用目标会话的项目目录（claude 这类按项目分存档，目录错了 --resume
  // 找不到会话）。body 不带 resume＝全新内切：把这条终端就地换成一个全新 agent
  // 会话（「新建会话」入口对齐 M12 矩阵），身份侧清空旧 resume（clearResume），
  // 绑定重扫不做——没有目标身份可扫，新对话存档由既有绑定捕获路径自然接管。
  // working 判定与在飞闸在面板侧（panel.js terminalRailSwitchOrCreate），本路由
  // 接「已决定内切」的请求，但杀进程前再做一道 switch-guard 复核（见下）：
  // 前端信号覆盖不了静默执行中的命令，不可逆动作的最后一道闸留在服务端。
  async function handleTerminalSessionSwitch(req, res, id, body) {
    const token = terminalPullToken();
    if (!token) return sendJson(res, 503, { ok: false, error: "terminal_host_unavailable" });
    const session = await fetchTerminalSessionFn(id, { token });
    if (!session) return sendJson(res, 404, { ok: false, error: "terminal_session_not_found" });
    const resume = body?.resume ?? null;
    // 目标身份：resume 路径＝endpoint＋会话 id（两键缺一即拒）；全新路径＝agentId
    // 必在册。两条都要求 cwd（全新路径用面板「记住上次」，resume 路径用目标会话
    // 项目目录）。错误码全走机器判短码，全新路径不用 resume- 前缀族——前端对那
    // 族落的是续接专用句，全新创建的失败该走通用启动句。
    let endpoint = "";
    let conversationId = "";
    let resumeFile = null;
    if (resume !== null) {
      endpoint = typeof resume?.endpoint === "string" ? resume.endpoint.trim() : "";
      conversationId = typeof resume?.id === "string" ? resume.id.trim() : "";
      if (!endpoint || !conversationId || endpoint.length > 64 || conversationId.length > 256) {
        return sendJson(res, 400, { ok: false, code: "resume-invalid", error: "resume-invalid" });
      }
      if (!Object.prototype.hasOwnProperty.call(AGENT_TERMINAL_TARGETS, endpoint)) {
        return sendJson(res, 400, { ok: false, code: "resume-unsupported", error: "resume-unsupported" });
      }
      if (typeof resume.file === "string" && resume.file.trim()) resumeFile = resume.file.trim();
    } else {
      endpoint = typeof body?.agentId === "string" ? body.agentId.trim() : "";
      if (!endpoint || endpoint.length > 64 || !Object.prototype.hasOwnProperty.call(AGENT_TERMINAL_TARGETS, endpoint)) {
        return sendJson(res, 400, { ok: false, code: "agent-invalid", error: "agent-invalid" });
      }
    }
    const cwd = typeof body?.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : "";
    if (!cwd) {
      return sendJson(res, 400, { ok: false, code: resume !== null ? "resume-invalid" : "invalid_cwd", error: resume !== null ? "resume-invalid" : "invalid_cwd" });
    }
    let claudeBypassPermissions = false;
    try {
      claudeBypassPermissions = loadSettings(settingsFile, base).settings.claudeBypassPermissions === true;
    } catch {
      /* 读取失败不挡切换本身：权限开关按默认（关）组装 */
    }
    let launch;
    try {
      launch = buildAgentSessionLaunch({
        agentId: endpoint,
        cwd,
        port: AGENT_RELAY_PORT,
        token,
        base,
        claudeBypassPermissions,
        ...(resume !== null
          ? {
              resume: {
                endpoint,
                id: conversationId,
                ...(resumeFile ? { file: resumeFile } : {}),
              },
            }
          : {}),
      });
    } catch (error) {
      // 续接相关失败回机器可判的短码（resume-unsupported / resume-invalid，连字符族
      // ——前端 startsWith("resume-") 门据此落已批准续接句，error 字段即码本身、零
      // 文案）；其余组装错误维持原有响应形状。
      const code = error.code === "resume-unsupported" || error.code === "resume-invalid" ? error.code : null;
      return sendJson(res, 400, { ok: false, ...(code ? { code } : {}), error: error.message });
    }
    // 杀前复核（switch-guard）：前端判定门的 working 只覆盖「LLM 请求在途＋输出
    // 活跃窗」，静默执行中的命令（无请求也无输出）两头都够不着，而本路由的落点
    // 是整棵进程树 terminate——不可逆动作前按需探测一次「PTY 树里有没有活着的
    // 命令子进程」。探测失败（null）同样拒：宁多开勿错杀。exited 不探测，树里已
    // 没有活进程，restart 的树杀只剩残留登记的收尾。前端收到 switch_busy 静默转
    // 新开（新开本就是点击历史会话的合法落点，无需提示）。
    if (session.status === "running") {
      // 归属锚：relay 检测面里这个会话的 agent 主进程 pid——有锚时探测从锚起
      //（锚之下的进程才是在跑命令，agent 本体不算），无锚按根形态判（见
      // terminal-switch-guard）。join 复用轮询的拉取缓存，纯内存计算；失败或
      // 无归属都按无锚形态继续判。
      let anchorPid = null;
      try {
        const feed = await pulledDetectedProcesses(token);
        const detected = Array.isArray(feed?.processes) ? feed.processes : null;
        if (detected && detected.length > 0) {
          const agents = await pulledAgentsForJoin(token);
          const [joined] = attributeTerminalSessions([session], detected, agents, {
            codex: Array.isArray(feed.codexSessions) ? feed.codexSessions : [],
            opencode: Array.isArray(feed.opencodeSessions) ? feed.opencodeSessions : [],
          });
          const pid = joined && joined.agent && joined.agent.pid;
          if (Number.isInteger(pid) && pid > 0) anchorPid = pid;
        }
      } catch {
        /* 归属失败按无锚形态判 */
      }
      const busy = await probeTerminalCommandTreeFn(session.pid, { anchorPid });
      if (busy !== false) {
        // 复探一拍再判：单次探测把「agent 自己的启动期瞬时子进程」或一次超时
        // 也算成在跑命令，会把空闲新会话的内切误拒（前端再把 409 静默落成新开
        // 页签）。真在跑的命令跨得住两次探测，瞬时子进程跨不住——复探只滤掉
        // 误拒，不动「探测失败亦拒」的保护语义。
        //
        // 代价是忙路径的往返变长：首探实测 1.4–1.6s，加这次间隔与复探约 3.7s，
        // 两次都撞满超时则约 8.7s。干净路径（首探 false）零额外开销；这段期间前端
        // 的在飞闸会吞掉后续点击，所以复探用更短的超时（只滤瞬时误判，真在跑的
        // 命令首探就够判），把最坏耗时压回 6s 量级。
        await new Promise((resolve) => setTimeout(resolve, switchGuardRecheckDelayMs));
        const recheck = await probeTerminalCommandTreeFn(session.pid, {
          anchorPid,
          timeoutMs: switchGuardRecheckTimeoutMs,
        });
        if (recheck !== false) {
          return sendJson(res, 409, { ok: false, code: "switch_busy", error: "switch_busy" });
        }
      }
    }
    const switchStartedAt = Date.now();
    const restarted = await restartTerminalSessionFn(id, {
      launch: launch.launch,
      cwd: launch.cwd,
      env: launch.env,
      // 身份同步三件＋resume：宿主 restart 路由写进会话记录（M12-A），去重聚焦、
      // 页签与栏行展示都读它们；env 只走请求体，不经响应回显。全新内切带
      // clearResume 显式清空旧 resume——缺省「不更新」语义会残留旧会话身份。
      ...(resume !== null
        ? { resume: { endpoint, id: conversationId } }
        : { clearResume: true }),
      label: launch.label,
      agentId: launch.agentId,
      agentName: launch.agentName,
    }, { token });
    if (!restarted) return sendJson(res, 503, { ok: false, error: "terminal_host_unavailable" });
    // 每次切换都开启新代：在飞的旧代扫描不得把上一段身份绑回来。全新内切
    // 还须清旧对话绑定，否则复活会接回旧会话；历史续接的既有绑定语义不变。
    terminalBindingGenerations.set(session.id, (terminalBindingGenerations.get(session.id) ?? 0) + 1);
    if (resume === null) terminalBindings().delete(session.id);
    // 换绑自愈：延迟重扫目标目录下「切换时刻之后唯一活跃」的存档——有的 agent
    // resume 会另起新对话存档，届时把绑定改到新 id；判不出维持原绑定。传的是新
    // 身份（endpoint＋目标 cwd），不是宿主记录里的旧归属——空白壳那一栏根本没有
    // 旧身份可言（复活路由传 session 是因它复活的正是会话自己的归属）。全新内切
    // 无目标身份可扫，不走这条——新对话存档由绑定捕获既有路径接管。
    if (resume !== null) scheduleBindingRefresh({ id: session.id, agentId: endpoint, cwd: launch.cwd }, switchStartedAt);
    return sendJson(res, restarted.status || 200, restarted.body ?? {});
  }

  // 一键启动 CLI Agent：本路由只做组装与转发。launch（cmd /c 包装——归属链
  // 的硬前提，见 agent-session-env.mjs）与 env（Anyswitch 凭证，只走环境变
  // 量）在服务端拼好后交给 terminal-host 起 PTY；env 不落盘，也不经响应回
  // 显。写 agent 配置文件、把密钥拼进行面的事一概不做。
  async function handleTerminalAgentSessionCreate(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, error.statusCode ?? 400, { ok: false, error: error.message });
    }
    const agentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
    if (!Object.prototype.hasOwnProperty.call(AGENT_TERMINAL_TARGETS, agentId)) {
      return sendJson(res, 400, { ok: false, error: "请选择一个要启动的 CLI Agent" });
    }
    const token = terminalPullToken();
    if (!token) return sendJson(res, 503, { ok: false, error: "终端服务不在运行，请稍后重试" });
    // bypassPermissions 开关现读现用：保存后下一次一键启动即生效。loadSettings
    // 吞掉解析错误回退默认（关），读取失败不会挡住启动本身。
    let claudeBypassPermissions = false;
    try {
      claudeBypassPermissions = loadSettings(settingsFile, base).settings.claudeBypassPermissions === true;
    } catch {
      claudeBypassPermissions = false;
    }
    let launch;
    try {
      // resume 可选：带它时同一次组装多收一项会话身份（endpoint/id/file），
      // 命令行由服务端按模板重建；不带时走原调用，行为逐位不变。
      launch = body?.resume === undefined || body?.resume === null
        ? buildAgentSessionLaunch({ agentId, cwd: body?.cwd, port: AGENT_RELAY_PORT, token, base, claudeBypassPermissions })
        : buildAgentSessionLaunch({ agentId, cwd: body?.cwd, port: AGENT_RELAY_PORT, token, base, claudeBypassPermissions, resume: body.resume });
    } catch (error) {
      // 续接相关的失败回机器可判的 code（前端据此提示「这个 Agent 不支持续接」
      // 还是「会话信息不全」），其余组装错误维持原有响应形状。
      const code = error.code === "resume-unsupported" || error.code === "resume-invalid" ? error.code : null;
      return sendJson(res, 400, { ok: false, ...(code ? { code } : {}), error: error.message });
    }
    let created = null;
    try {
      created = await createTerminalSession({
        label: launch.label,
        cwd: launch.cwd,
        shell: "cmd",
        cols: Math.max(2, Math.min(240, Number(body?.cols) || 120)),
        rows: Math.max(1, Math.min(120, Number(body?.rows) || 34)),
        launch: launch.launch,
        env: launch.env,
        agentId: launch.agentId,
        agentName: launch.agentName,
        // 续接身份随创建一并记进宿主会话记录（M7 S5 去重聚焦的数据源）：只递
        // endpoint + 会话 id 两个非密字段。能走到这儿 resume 已过
        // buildAgentResumeArgs 校验（端点匹配、id/file 形状合法），宿主还会按
        // 自己的形状再验一遍；file 不递——去重不需要路径。
        ...(body?.resume && typeof body.resume === "object"
          && typeof body.resume.endpoint === "string" && typeof body.resume.id === "string"
          ? { resume: { endpoint: body.resume.endpoint, id: body.resume.id } }
          : {}),
      }, { token });
    } catch {
      created = null;
    }
    if (!created) return sendJson(res, 503, { ok: false, error: "终端服务不在运行，请稍后重试" });
    return sendJson(res, created.status || 201, created.body ?? {});
  }

  // 复活一条已退出的终端会话。与创建路由的分工：创建要 agentId 与工作目录，
  // 复活只用会话自己的身份（agentId + cwd）重新组装启动参数——凭据从不落盘，
  // 这是唯一能让它重新拿到 relay 地址与 token 的通路。纯外壳会话没有可重建的
  // 东西，直接转发重开。
  async function handleTerminalSessionRevive(req, res, id) {
    const token = terminalPullToken();
    if (!token) return sendJson(res, 503, { ok: false, error: "terminal_host_unavailable" });
    const session = await fetchTerminalSessionFn(id, { token });
    if (!session) return sendJson(res, 404, { ok: false, error: "terminal_session_not_found" });
    let body = {};
    let resumeArgs = null;
    if (session.agentId) {
      if (!Object.prototype.hasOwnProperty.call(AGENT_TERMINAL_TARGETS, session.agentId)) {
        return sendJson(res, 400, { ok: false, error: "unknown_agent" });
      }
      let claudeBypassPermissions = false;
      try {
        claudeBypassPermissions = loadSettings(settingsFile, base).settings.claudeBypassPermissions === true;
      } catch {
        claudeBypassPermissions = false;
      }
      let launch;
      try {
        launch = buildAgentSessionLaunch({
          agentId: session.agentId,
          cwd: session.cwd,
          port: AGENT_RELAY_PORT,
          token,
          base,
          claudeBypassPermissions,
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }
      // launch 与 cwd 一并带上：可执行文件升级、权限开关变更、工作目录漂移
      // 都在重开时追平。env 只走请求体，不经响应回显。
      // resume 接线：绑定/兜底扫描判得出原对话就追加续会参数，判不出维持
      // 空白复活——接线失败绝不挡复活本身（catch 回落 null）。只在控制面
      // 进程接（绑定库单写入方，同列表捕获的门）。
      resumeArgs = hostKind === "panel-host" ? await resolveResumeArgsForRevive(session).catch(() => null) : null;
      // 已确认要续接的对话同时写回宿主身份：进程生日随复活前移后，
      // 兜底行若只看无 resume 会把旧对话误显示成「新会话」。
      const binding = resumeArgs ? terminalBindings().get(session.id) : null;
      const resumeIdentity = binding && binding.agentId === session.agentId && sameCwd(binding.cwd, session.cwd)
        ? { endpoint: session.agentId, id: binding.conversationId } : null;
      body = {
        launch: resumeArgs ? { ...launch.launch, args: [...launch.launch.args, ...resumeArgs] } : launch.launch,
        cwd: launch.cwd,
        env: launch.env,
        ...(resumeIdentity ? { resume: resumeIdentity } : {}),
      };
    }
    const reviveStartedAt = Date.now();
    const restarted = await restartTerminalSessionFn(id, body, { token });
    if (!restarted) return sendJson(res, 503, { ok: false, error: "terminal_host_unavailable" });
    // 有的 agent resume 会另起新对话存档：复活落稳后延迟重扫，唯一活跃的新
    // 存档换绑进绑定库；判不出就维持原绑定。
    if (resumeArgs) scheduleBindingRefresh(session, reviveStartedAt);
    return sendJson(res, restarted.status || 200, restarted.body ?? {});
  }

  // Recent requests for one attributed terminal instance, read off today's
  // usage journal (the only durable per-request ledger). filterTerminalRequest-
  // Rows returns the matching tail newest-first; display shaping stays with
  // the frontend.
  function handleTerminalRequests(url, res) {
    const agentId = url.searchParams.get("agentId") || "";
    const instanceId = url.searchParams.get("instanceId") || "";
    let rows = [];
    try {
      const today = dayKey(Date.now());
      rows = usageJournalLazy().readRequests({ fromDay: today, toDay: today });
    } catch (err) {
      logger?.warn?.(`terminal requests journal read failed: ${err.message}`);
      rows = [];
    }
    sendJson(res, 200, { ok: true, requests: filterTerminalRequestRows(rows, { agentId, instanceId }) });
  }

  // ---- Terminal host lifecycle (relay-owned child, panel drives it) ----
  // /api/status 每秒一拍，host 状态随帧下发；若每拍都直取 relay 等于给它多开
  // 一条轮询，所以轮询侧走短 TTL 缓存。终端页进页要拿现值判态（等不起上一帧），
  // 专用端点永远直取并顺手刷新缓存；start/stop 落地后作废缓存，下一拍立即重取。
  const TERMINAL_HOST_STATUS_TTL_MS = 1500;
  let terminalHostStatusCache = null; // { at, value: object|null }

  async function pullTerminalHostStatus() {
    let value = null;
    try {
      value = await fetchTerminalHostStatus(relayRoot, relayPullToken());
    } catch {
      value = null; // 注入实现抛错与 relay 不可达同等待遇：轮询链不炸
    }
    terminalHostStatusCache = { at: Date.now(), value };
    return value;
  }

  async function getTerminalHostStatusCached() {
    if (terminalHostStatusCache && Date.now() - terminalHostStatusCache.at < TERMINAL_HOST_STATUS_TTL_MS) {
      return terminalHostStatusCache.value;
    }
    return pullTerminalHostStatus();
  }

  async function handleTerminalHostStatus(res) {
    const data = await pullTerminalHostStatus();
    if (!data) return sendJson(res, 200, { ok: true, state: "unknown", pid: null, manualStop: false, lastExit: null });
    sendJson(res, 200, { ok: true, ...normalizeTerminalHostStatus(data) });
  }

  async function handleTerminalHostStart(res) {
    logger?.info("Terminal host start requested from panel control");
    const result = await callTerminalHostAction("start", {}, { token: relayPullToken() });
    if (!result) return sendJson(res, 503, { ok: false, error: "relay_unavailable" });
    terminalHostStatusCache = null;
    const payload = result.body;
    if (payload?.ok === true) return sendJson(res, 200, { ok: true, state: normalizeTerminalHostStatus(payload).state });
    return sendJson(res, result.status || 500, payload ?? { ok: false, error: "terminal_host_start_failed" });
  }

  async function handleTerminalHostStop(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, error.statusCode ?? 400, { ok: false, error: error.message });
    }
    logger?.info("Terminal host stop requested from panel control");
    const result = await callTerminalHostAction("stop", body, { token: relayPullToken() });
    if (!result) return sendJson(res, 503, { ok: false, error: "relay_unavailable" });
    terminalHostStatusCache = null;
    const payload = result.body;
    if (payload?.ok === true) return sendJson(res, 200, { ok: true });
    return sendJson(res, result.status || 500, payload ?? { ok: false, error: "terminal_host_stop_failed" });
  }

  // 导入是整份覆盖 settings.json，走不到设置路由那条副作用链上，而
  // followAgent 恰好是唯一带持久副作用的开关：值与登录计划、自愈进程脱节时，
  // 「包里关、本机开」会留下一个界面写着关、登录照旧自启、每 3 秒把 relay 拉
  // 回来的常驻进程，没有任何路径会自愈它。导入落定后按刚写进盘的值把两者对齐
  // 回来，顺序沿用设置路由：计划先、进程后。计划写失败就停在这里只出警告——
  // 数据已经换过位置了，回滚比短暂不一致更糟。
  async function reconcileFollowAgentAfterImport(desired) {
    // warnings 是写给日志的；reasons 只放裸原因，界面上的成句文案归前端
    // （panel.js）——服务层不参与用户可见措辞，否则一处话两个地方说。
    const outcome = { desired, task: "unchanged", process: "unchanged", warnings: [], reasons: {} };
    let touched = false;

    let registered = false;
    try {
      registered = await isWatchdogAutostartEnabledFn();
    } catch (err) {
      outcome.task = "unknown";
      outcome.reasons.task = err.message;
      outcome.warnings.push(`登录计划状态读不出来：${err.message}`);
      return outcome;
    }
    if (registered !== desired) {
      const reg = desired ? await enableWatchdogAutostartFn() : await disableWatchdogAutostartFn();
      if (!reg?.ok) {
        outcome.task = "failed";
        outcome.reasons.task = reg?.error ?? "写入失败";
        outcome.warnings.push(`登录计划未同步（${outcome.reasons.task}），设置与下次登录后的实际行为暂不一致`);
        return outcome;
      }
      outcome.task = desired ? "registered" : "unregistered";
      touched = true;
    }

    let alive = false;
    try {
      alive = await probeWatchdogFn();
    } catch (err) {
      outcome.process = "unknown";
      outcome.reasons.process = err.message;
      outcome.warnings.push(`自愈进程状态读不出来：${err.message}`);
      if (touched) watchdogSnapshot.invalidate();
      return outcome;
    }
    if (alive !== desired) {
      // spawnWatchdog / stopWatchdog 都不抛错：等不到就返回 ok:false（stop 还带
      // reason）。只 catch 异常会把「没做成」报成「已对齐」。
      try {
        const moved = desired ? await spawnWatchdogFn() : await stopWatchdogFn();
        if (moved?.ok === false) {
          outcome.process = "failed";
          outcome.reasons.process = moved.reason ?? "未达到预期状态";
          outcome.warnings.push(`自愈进程未${desired ? "拉起" : "停止"}：${outcome.reasons.process}`);
        } else {
          outcome.process = desired ? "started" : "stopped";
          touched = true;
        }
      } catch (err) {
        outcome.process = "failed";
        outcome.reasons.process = err.message;
        outcome.warnings.push(`自愈进程未${desired ? "拉起" : "停止"}：${err.message}`);
      }
    }

    // 计划或进程刚被改动：丢掉探测快照，下一次 GET /api/settings 重新探，
    // 而不是把改动前的漂移读数继续端到界面上。
    if (touched) watchdogSnapshot.invalidate();
    return outcome;
  }

  // store.json mtime 微缓存。handleStatus 每秒只读 provider 计数，每请求
  // 一次 statSync（元数据读，微秒级）按 mtimeMs:size 校验，不变即复用上次解析
  // 结果。跨进程安全：relay 写 store 走 atomic rename，mtime 必变。
  // 契约：缓存命中返回的是共享 parsed 引用——调用方只读、禁止原地修改。
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
    // 终端宿主状态随状态帧下发：真值在 relay（宿主是它的子进程），面板进程本地
    // 没有等价物。走短 TTL 缓存避免秒级轮询翻倍 relay 压力；relay 不可达时报
    // unknown，不拖垮状态帧本身。
    let terminalHost = { state: "unknown", manualStop: false };
    const hostStatus = await getTerminalHostStatusCached();
    if (hostStatus) {
      const normalized = normalizeTerminalHostStatus(hostStatus);
      terminalHost = { state: normalized.state, manualStop: normalized.manualStop };
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
      terminalHost,
      selfUpdate: selfUpdateStatusFrame(),
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
  // 自杀换新共用的编排：拉起一次性 helper（等 47820 释放再拉起新 panel-host），
  // 并武装兜底退出。退出时机交给调用方——HTTP 重启钩在响应 flush 上，自更新
  // 监听器没有响应可等，进宽限即退。spawn 失败返回 null：调用方如实应答，不退出。
  function startPanelHostReplacement({ onSpawnError } = {}) {
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
      onSpawnError?.(err);
      return null;
    }
    backstopTimer = setTimeout(scheduleExit, PANEL_HOST_EXIT_BACKSTOP_MS);
    return scheduleExit;
  }

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
    let spawnError = null;
    const scheduleExit = startPanelHostReplacement({ onSpawnError: (err) => { spawnError = err; } });
    if (!scheduleExit) {
      return sendJson(res, 500, { ok: false, error: spawnError?.message ?? "restart helper failed" });
    }
    res.once("finish", scheduleExit);
    sendJson(res, 200, { ok: true, pid: process.pid });
    // Backstop is armed inside startPanelHostReplacement: if the client is gone
    // before the flush completes, "finish" never fires — and the frontend
    // deliberately reads a dropped response as "restart started" (the exit can
    // beat the flush), so it is sitting in its recovery poll waiting for a port
    // we still owe it.
  }

  async function getEnvironmentService() {
    if (!environmentService) {
      const { createEnvironmentService } = await import("./environment-service.mjs");
      environmentService ??= createEnvironmentService({ base });
    }
    return environmentService;
  }

  // ── Agent 可见性（环境检测为唯一真值源）──────────────────────────────
  // 「端点装在本机」沿用关于页同一份检测：任一形态（CLI/桌面）检测到即算在，
  // 全部形态都未找到才算不在；任一形态检测出错按在（fail-open——宁可多显示，
  // 也不能把真实存在的 Agent 藏掉）。快照喂给 skills / prompts 两个会向 Agent
  // 家目录写盘的面（服务创建时闭包注入，始终读最新快照）。检测整体不可用或
  // 客户端清单为空（检测异常形态）时快照为 null：不过滤，一切按可见。
  let endpointVisibility = null;
  let endpointVisibilityRefresh = null; // in-flight 去重：并发请求共享同一次检测
  let endpointVisibilityTimer = null;
  async function refreshEndpointVisibility() {
    if (endpointVisibilityRefresh) return endpointVisibilityRefresh;
    endpointVisibilityRefresh = (async () => {
      try {
        const service = await getEnvironmentService();
        const state = await service.getState();
        endpointVisibility = deriveVisibleEndpointIds(state.clients);
      } catch {
        endpointVisibility = null;
      } finally {
        endpointVisibilityRefresh = null;
      }
    })();
    return endpointVisibilityRefresh;
  }
  const isEndpointVisible = (endpointId) =>
    endpointVisibility === null || endpointVisibility.has(endpointId);
  // 定时刷新让进程长驻期间新装/新卸的 Agent 一分钟内反映到面板；unref 掉，
  // 定时器不单独拖住进程退出。只在第一个真实（非注入）skills/prompts 服务
  // 创建时启动，注入 mock 服务的测试永远不会碰到真检测。
  function ensureEndpointVisibilityFreshness() {
    if (endpointVisibilityTimer) return;
    endpointVisibilityTimer = setInterval(() => { refreshEndpointVisibility(); }, 60_000);
    endpointVisibilityTimer.unref?.();
  }

  async function getReleaseService() {
    if (!releaseService) {
      const { createReleaseService } = await import("./release-service.mjs");
      releaseService ??= createReleaseService({ currentVersion: appInfo.version });
    }
    return releaseService;
  }

  // ── git 身份（先行轨道与不一致判定的地基）──────────────────────────────
  // 本地 HEAD：工作树身份在本进程生命周期内不变（换装必重启面板），一次查询终身
  // 复用。镜像安装可能没有 .git——如实 null，调用方按无身份降级。
  let localHeadPromise = null;
  function getLocalHead() {
    localHeadPromise ??= Promise.resolve()
      .then(() => readLocalHeadFn({ appDir: APP_DIR }))
      .catch(() => null);
    return localHeadPromise;
  }
  async function getAppCommit() {
    const head = await getLocalHead();
    return head?.short ?? null;
  }
  // 远端身份（默认分支 HEAD + 全部 v-tag 的 SHA）：ls-remote 一次往返。短缓存让进页
  // 自动检查不吃满速网络，强制检查（refresh=1 / 登记更新 / 回退计划）绕过。
  // 失败或超时如实 null——各调用方降级，不新增报错形态。
  let remoteIdentityCache = { at: 0, value: null };
  async function getRemoteIdentity(force) {
    if (!force && remoteIdentityCache.value && Date.now() - remoteIdentityCache.at < remoteIdentityTtlMs) {
      return remoteIdentityCache.value;
    }
    const value = await Promise.resolve()
      .then(() => readRemoteRefsFn({ repoUrl: APP_REPO_URL }))
      .catch(() => null);
    remoteIdentityCache = { at: Date.now(), value };
    return value;
  }

  // 检查更新的轨道组装（HTTP 面与自动下载、自更新登记共用的唯一口径）：
  // release-service 只答正式发布（稳定轨）；先行轨与不一致判定在这里叠 git 身份。
  // 先行轨无 git 身份（镜像安装未引导）时按稳定轨口径回答，行为与未开启时一致。
  async function getAppUpdateState(force) {
    let bleeding = false;
    try { bleeding = loadSettings(settingsFile, base).settings.bleedingEdgeMode === true; } catch { bleeding = false; }
    if (bleeding) {
      const local = await getLocalHead();
      if (!local) {
        const stable = await getReleaseService().then((service) => service.getAppUpdate({ force }));
        return { ...stable, track: "bleeding", identity: false };
      }
      const remote = await getRemoteIdentity(force);
      const base = {
        track: "bleeding", identity: true,
        currentVersion: appInfo.version, currentCommit: local.short,
        remoteCommit: remote ? remote.headSha.slice(0, 7) : null,
        checkedAt: new Date().toISOString(),
      };
      if (!remote) return { ...base, state: "error", release: null, errorCode: null };
      if (local.sha === remote.headSha) {
        return { ...base, state: "current", release: null, errorCode: null };
      }
      // 防倒退门：远端尖端已在本仓时判祖先后系。本地不落后（远端尖端是本地祖先，
      // 或互不为祖先——换装会丢本地独有提交）就不发「发现先行新提交」邀请；只有
      // 本地严格落后、或判不了（对象不在本仓／git 故障）才保持既有邀请。
      const relation = await readRemoteHeadRelationFn({ appDir: APP_DIR, remoteSha: remote.headSha });
      return relation === "remote_newer" || relation === "absent" || relation === null
        ? { ...base, state: "update_available", remoteSha: remote.headSha, release: null, errorCode: null }
        : { ...base, state: "current", release: null, errorCode: null };
    }
    const result = await getReleaseService().then((service) => service.getAppUpdate({ force }));
    const drift = await buildStableDrift(result, force);
    return { ...result, track: "stable", drift };
  }

  // 不一致家族（先行轨关闭时）：本地版本高于官方最新（ahead），或本地 HEAD 不在
  // 官方发布节点上（off-tag）。有可用更新时不判——更新通道自己会说；无 git 身份
  // 时跳过 HEAD 维度，ahead 仍可判（纯版本号比较）。
  async function buildStableDrift(result, force) {
    if (result.state !== "current" && result.state !== "ahead") return null;
    const ahead = result.state === "ahead";
    const local = await getLocalHead();
    let offTag = null;
    if (local) {
      const remote = await getRemoteIdentity(force);
      if (remote) offTag = ![...remote.tags.values()].includes(local.sha);
    }
    if (!ahead && !offTag) return null;
    return {
      ahead,
      offTag,
      localVersion: appInfo.version,
      remoteVersion: result.release?.version ?? null,
      localCommit: local?.short ?? null,
    };
  }

  // 客户端更新（安装/升级）作业登记。锁按客户端分：npm 全局目录里一个包只有一份
  // 落点，两个并发的同一个包安装会把对方的目录搬走再删（实测 5 次里 2 次把安装搬坏，
  // npm 报 ENOTEMPTY、包清单与命令入口一起消失），所以同一个客户端同时只允许一个
  // 任务，同客户端并发 409。不同客户端各装各的包、互不触碰对方的目录，可以并行——
  // 关于页因此能同时开多个更新，而不是一次只放行一个。
  // 安装跑在脱离面板的进程里，进度记在本机数据目录：关掉或重启面板不会杀掉正在
  // 进行的安装，新面板读同一份记录继续报进度。进程已经不在、记录却还写着进行中
  // 的，按中断收尾，否则这个客户端会被永久锁住。
  const updateJournalDir = clientUpdateDir ?? clientUpdateJournalDir(relayRoot);
  const spawnUpdateWorker = spawnClientUpdateWorkerFn ?? ((request) => spawnClientUpdateWorker(request));
  // 自身更新的 worker 拉起：与客户端更新同一形态（脱离、丢管道、unref）。
  const spawnSelfUpdate = spawnSelfUpdateWorkerFn ?? ((request) => spawnSelfUpdateWorker(request));

  function refreshClientUpdates() {
    reapDeadClientUpdateRuns(updateJournalDir, (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
  }

  async function handleClientUpdate(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.statusCode ?? 400, { ok: false, error: "bad_request", message: err.message });
    }
    const id = typeof body?.id === "string" ? body.id : null;
    const action = typeof body?.action === "string" ? body.action : null;
    const { clientLifecycleKind, clientLifecycleActions } = await import("./client-lifecycle.mjs");
    const kind = clientLifecycleKind(id);
    if (!id || !kind) {
      return sendJson(res, 404, { ok: false, error: "unknown_client", message: "未找到这个客户端" });
    }
    if (!clientLifecycleActions(id).includes(action)) {
      return sendJson(res, 400, { ok: false, error: "unsupported_action", message: "不支持的操作" });
    }
    refreshClientUpdates();
    const active = runningClientUpdate(updateJournalDir, id);
    if (active) {
      return sendJson(res, 409, {
        ok: false,
        error: "busy",
        message: `已有客户端任务在进行中（${id}），请等待完成`,
      });
    }
    const before = (await getEnvironmentService().then((service) => service.getState()))
      .clients.find((client) => client.id === id);
    // 原生自更新的客户端（Grok Build）要把官方最新版本钉进降级安装命令，
    // 所以先读一次官方版本再动手；查不到就只跑它自身的升级命令，不拿 dist-tag 兜底。
    // 查询渠道按被更新那条安装项的 remoteId 取：qoder 的客户端 id 挂在桌面端渠道上，
    // CLI 形态的官方版本要走 installations[0] 的 "qoder-cli"。
    const targetVersion = kind === "native"
      ? await getReleaseService()
        .then((service) => service.getClientLatest(before?.installations?.[0]?.remoteId ?? id))
        .then((data) => (data?.state === "ok" ? data.version : null))
        .catch(() => null)
      : null;
    const runId = randomUUID();
    const run = {
      runId,
      clientId: id,
      action,
      state: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      result: null,
      workerPid: null,
      targetVersion,
      commandPath: before?.installations?.[0]?.path ?? null,
      beforeVersion: before?.installations?.[0]?.version ?? null,
      // 逐形态 before 版本与 beforeVersion 是同一刻快照：worker 不再自己读。
      beforeByForm: Object.fromEntries((before?.installations ?? []).map((i) => [i.kind, i.version ?? null])),
    };
    // 先落盘再拉起：进程抢在登记之前退出时，不能留下一个没有记录的安装。
    writeClientUpdateRun(updateJournalDir, run);
    let workerPid = null;
    try {
      workerPid = spawnUpdateWorker({ runId, journalDir: updateJournalDir });
    } catch {
      workerPid = null;
    }
    if (!Number.isInteger(workerPid) || workerPid <= 0) {
      writeClientUpdateRun(updateJournalDir, {
        ...run,
        state: "done",
        finishedAt: new Date().toISOString(),
        result: { outcome: "failed", message: "更新失败，请重新检测确认结果" },
      });
      return sendJson(res, 500, { ok: false, error: "spawn_failed", message: "更新失败，请重新检测确认结果" });
    }
    writeClientUpdateRun(updateJournalDir, { ...run, workerPid });
    return sendJson(res, 202, { ok: true, runId, clientId: id, action });
  }

  function handleClientUpdateStatus(res, runId) {
    refreshClientUpdates();
    const run = readClientUpdateRun(updateJournalDir, runId);
    if (!run) {
      return sendJson(res, 404, { ok: false, error: "unknown_run", message: "没有找到这个更新任务，请重新检测确认结果" });
    }
    return sendJson(res, 200, clientUpdateStatus(run));
  }

  function handleClientUpdatesActive(res) {
    refreshClientUpdates();
    const runs = listClientUpdateRuns(updateJournalDir)
      // 自身更新记录与客户端更新同住一个 journal 目录，但接回通道是它自己的
      // /api/self-update/active——这里若把它放出去，关于页会把同一条任务接回两次，
      // 结论提示也跟着弹两次。
      .filter((run) => run.state === "running" && run.clientId !== SELF_UPDATE_CLIENT_ID)
      .map((run) => clientUpdateStatus(run));
    return sendJson(res, 200, { ok: true, runs });
  }

  // ── 自身更新（下载 → 应用 两步）──────────────────────────────────────
  // 目标版本与「检查更新」同源：releaseService.getAppUpdate 给出的 release
  // （tag + 版本，预览版/稳定版渠道判定都在那一层）。执行跑在脱离 worker 里
  // （app-self-update.mjs），按记录里的 step 分两阶段：download 只把目标 tag
  // 浅拉进本地仓库并核版本（不动工作树、不动进程），完成后记录停在
  // 「已下载待应用」（phase=staged）；apply 由用户再点一次触发，做换装、装
  // 依赖、重启 relay，最后等本进程经 startPanelHostReplacement 退场、新面板接管。
  // journal 复用 client-updates 目录与记录形态：running 记录即单飞锁，worker
  // 崩溃由既有惰性 reap 收割；多出来的 phase 字段是 worker → 监听器/页面的进度通道。
  const SELF_UPDATE_WATCH_MS = 1000;
  let selfUpdateWatchTimer = null;

  function selfUpdateStatusPayload(run) {
    return { ...clientUpdateStatus(run), phase: run.phase ?? null, step: run.step ?? "download", track: run.track ?? "stable", targetVersion: run.targetVersion ?? null, targetTag: run.targetTag ?? null, targetSha: run.targetSha ?? null };
  }

  // 状态帧捎带（/api/status 的 selfUpdate 字段）：页面级观察者的唯一数据源——
  // 关于页之外的完成提示与换装接管都从这一帧读，不新增轮询请求。/api/status 是
  // 秒级热路径，journal 读取走短 TTL 缓存（与终端宿主状态帧同一手法）；有
  // running 记录返回它，否则返回 15 分钟内最近一条 done（新完成的结论让观察者
  // 补一次提示），再没有就 null。读取失败按 null 处理，不拖垮状态帧本身。
  const SELF_UPDATE_FRAME_TTL_MS = 3000;
  let selfUpdateFrameCache = null; // { at, value }
  function selfUpdateStatusFrame() {
    const at = Date.now();
    if (selfUpdateFrameCache && at - selfUpdateFrameCache.at < SELF_UPDATE_FRAME_TTL_MS) return selfUpdateFrameCache.value;
    let value = null;
    try {
      refreshClientUpdates();
      const runs = listClientUpdateRuns(updateJournalDir).filter((run) => run.clientId === SELF_UPDATE_CLIENT_ID);
      const running = runs.find((run) => run.state === "running") ?? null;
      if (running) {
        value = selfUpdateStatusPayload(running);
      } else {
        const recent = runs
          .filter((run) => run.state === "done" && run.finishedAt && at - Date.parse(run.finishedAt) <= 15 * 60 * 1000)
          .sort((a, b) => String(b.finishedAt ?? "").localeCompare(String(a.finishedAt ?? "")))[0] ?? null;
        value = recent ? selfUpdateStatusPayload(recent) : null;
      }
    } catch {
      value = null;
    }
    selfUpdateFrameCache = { at, value };
    return value;
  }

  // 最近一条「已下载待应用」的记录（finishedAt 最新的为准）。有效性现场判定：
  // 目标不比当前身份更新的记录视为过期——稳定/回退轨目标版本 ≤ 当前版本（下载后
  // 本地经别的途径已经到过或超过它），先行轨目标提交已是本地 HEAD。过期当场写上
  // stale 标记，之后不再捞起：横幅与「应用更新」按钮随之消失，应用端点因找不到
  // staged 而拒绝——陈旧记录从此没有机会把工作树换回旧版（本地领先远端时的降级）。
  async function findStagedSelfUpdate() {
    const staged = listClientUpdateRuns(updateJournalDir)
      .filter((run) => run.clientId === SELF_UPDATE_CLIENT_ID && run.state === "done" && run.result?.outcome === "downloaded" && run.stale !== true)
      .sort((a, b) => String(b.finishedAt ?? "").localeCompare(String(a.finishedAt ?? "")))[0] ?? null;
    if (!staged) return null;
    const reason = await stagedRunStaleReason(staged);
    if (!reason) return staged;
    writeClientUpdateRun(updateJournalDir, { ...staged, stale: true, staleReason: reason, staleAt: new Date().toISOString() });
    return null;
  }
  async function stagedRunStaleReason(run) {
    if (run.track === "bleeding") {
      const targetSha = typeof run.targetSha === "string" ? run.targetSha : "";
      if (!/^[0-9a-f]{7,40}$/i.test(targetSha)) return "malformed_target";
      const local = await getLocalHead();
      return local && local.sha === targetSha ? "already_at_target" : null;
    }
    const target = run.targetVersion;
    if (typeof target !== "string") return "no_target_version";
    const order = compareVersionsDefault(appInfo.version, target);
    return order !== null && order >= 0 ? "target_not_newer" : null;
  }

  // 登记 + 拉起下载 worker。轨道与目标身份一起登记：稳定轨带 release 的
  // version/tag；先行轨只带 targetSha（版本号要等下载后从 FETCH_HEAD 读出、由
  // worker 回填）。HTTP 面与自动下载调度共用；返回登记好的 run，拉起失败时记录
  // 如实落 failed 并返回 null。autoApply 只由用户一键确认的入口置真：worker 在
  // 下载核验通过后原地续跑应用段；自动下载调度不带它（只下载，绝不自动应用）。
  function registerSelfUpdateDownload({ track = "stable", targetVersion = null, targetTag = null, targetSha = null, autoApply = false }) {
    const runId = randomUUID();
    const run = {
      runId,
      clientId: SELF_UPDATE_CLIENT_ID,
      action: "update",
      step: "download",
      state: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      result: null,
      workerPid: null,
      track,
      autoApply: autoApply === true,
      targetVersion,
      targetTag,
      targetSha,
      beforeVersion: appInfo.version,
      appDir: APP_DIR,
      repoUrl: APP_REPO_URL,
      relayRoot,
      phase: "staging",
    };
    // 先落盘再拉起：进程抢在登记之前退出时，不能留下一个没有记录的安装。
    writeClientUpdateRun(updateJournalDir, run);
    let workerPid = null;
    try {
      workerPid = spawnSelfUpdate({ runId, journalDir: updateJournalDir });
    } catch {
      workerPid = null;
    }
    if (!Number.isInteger(workerPid) || workerPid <= 0) {
      writeClientUpdateRun(updateJournalDir, {
        ...run,
        state: "done",
        finishedAt: new Date().toISOString(),
        result: { outcome: "failed", message: "更新未能启动，请稍后重试" },
      });
      return null;
    }
    writeClientUpdateRun(updateJournalDir, { ...run, workerPid });
    return run;
  }

  async function handleSelfUpdateStart(req, res) {
    if (hostKind !== "panel-host") {
      // 与 panel-host/restart 同一条红线：relay 副本只是 API 面，换装自杀必须
      // 由 47820 的控制面自己做。
      return sendJson(res, 409, { ok: false, error: "self update must be requested from the control panel on 47820" });
    }
    let update = null;
    try {
      update = await getAppUpdateState(true);
    } catch {
      update = null;
    }
    // 先行轨按提交身份登记（remoteSha 来自强制检查，秒级新鲜）；稳定轨照旧按
    // release 的 version/tag。两轨共用单飞锁与「已下载待应用」停留态；一键入口
    // 带 autoApply——用户确认弹层里授权的就是「下载并应用」，worker 一条道跑完。
    if (update?.track === "bleeding" && update.identity !== false) {
      if (update.state !== "update_available" || !update.remoteSha) {
        return sendJson(res, 409, { ok: false, error: "no_update", message: "当前没有可安装的更新，请先检查更新" });
      }
      refreshClientUpdates();
      if (runningClientUpdate(updateJournalDir, SELF_UPDATE_CLIENT_ID)) {
        return sendJson(res, 409, { ok: false, error: "busy", message: "已有更新任务在进行中，请等待完成" });
      }
      const run = registerSelfUpdateDownload({ track: "bleeding", targetSha: update.remoteSha, autoApply: true });
      if (!run) {
        return sendJson(res, 500, { ok: false, error: "spawn_failed", message: "更新未能启动，请稍后重试" });
      }
      return sendJson(res, 202, { ok: true, runId: run.runId, clientId: SELF_UPDATE_CLIENT_ID, action: "update", step: "download", targetVersion: run.targetVersion, targetSha: run.targetSha });
    }
    if (update?.state !== "update_available" || !update.release?.tag || !update.release?.version) {
      return sendJson(res, 409, { ok: false, error: "no_update", message: "当前没有可安装的更新，请先检查更新" });
    }
    refreshClientUpdates();
    if (runningClientUpdate(updateJournalDir, SELF_UPDATE_CLIENT_ID)) {
      return sendJson(res, 409, { ok: false, error: "busy", message: "已有更新任务在进行中，请等待完成" });
    }
    const run = registerSelfUpdateDownload({ targetVersion: update.release.version, targetTag: update.release.tag, autoApply: true });
    if (!run) {
      return sendJson(res, 500, { ok: false, error: "spawn_failed", message: "更新未能启动，请稍后重试" });
    }
    return sendJson(res, 202, { ok: true, runId: run.runId, clientId: SELF_UPDATE_CLIENT_ID, action: "update", step: "download", targetVersion: run.targetVersion });
  }

  // 应用已下载的更新：同一条记录翻回 running、step=apply，worker 以同一 runId 再起。
  // body.runId 钉住要应用的那条（防「点应用时下载刚换了新目标」的错位）。
  async function handleSelfUpdateApply(req, res) {
    if (hostKind !== "panel-host") {
      return sendJson(res, 409, { ok: false, error: "self update must be requested from the control panel on 47820" });
    }
    const body = await readJsonBody(req);
    const wantRunId = typeof body?.runId === "string" ? body.runId : null;
    refreshClientUpdates();
    if (runningClientUpdate(updateJournalDir, SELF_UPDATE_CLIENT_ID)) {
      return sendJson(res, 409, { ok: false, error: "busy", message: "已有更新任务在进行中，请等待完成" });
    }
    const staged = await findStagedSelfUpdate();
    if (!staged || (wantRunId && staged.runId !== wantRunId)) {
      return sendJson(res, 409, { ok: false, error: "no_staged", message: "没有已下载待应用的更新，请先检查更新" });
    }
    const next = {
      ...staged,
      step: "apply",
      state: "running",
      phase: "installing",
      result: null,
      finishedAt: null,
      startedAt: new Date().toISOString(),
      workerPid: null,
    };
    writeClientUpdateRun(updateJournalDir, next);
    let workerPid = null;
    try {
      workerPid = spawnSelfUpdate({ runId: staged.runId, journalDir: updateJournalDir });
    } catch {
      workerPid = null;
    }
    if (!Number.isInteger(workerPid) || workerPid <= 0) {
      // 拉起失败：记录翻回「已下载待应用」，不吞掉这次已下载的成果。
      writeClientUpdateRun(updateJournalDir, staged);
      return sendJson(res, 500, { ok: false, error: "spawn_failed", message: "更新未能启动，请稍后重试" });
    }
    writeClientUpdateRun(updateJournalDir, { ...next, workerPid });
    armSelfUpdateWatcher();
    return sendJson(res, 202, { ok: true, runId: staged.runId, clientId: SELF_UPDATE_CLIENT_ID, action: "update", step: "apply", targetVersion: staged.targetVersion });
  }

  function handleSelfUpdateRunStatus(res, runId) {
    refreshClientUpdates();
    const run = readClientUpdateRun(updateJournalDir, runId);
    if (!run || run.clientId !== SELF_UPDATE_CLIENT_ID) {
      return sendJson(res, 404, { ok: false, error: "unknown_run", message: "没有找到这个更新任务" });
    }
    return sendJson(res, 200, selfUpdateStatusPayload(run));
  }

  async function handleSelfUpdateActive(res) {
    refreshClientUpdates();
    const runs = listClientUpdateRuns(updateJournalDir)
      .filter((run) => run.state === "running" && run.clientId === SELF_UPDATE_CLIENT_ID)
      .map((run) => selfUpdateStatusPayload(run));
    const staged = await findStagedSelfUpdate();
    return sendJson(res, 200, { ok: true, runs, staged: staged ? selfUpdateStatusPayload(staged) : null });
  }

  // 最近一次自身更新结论：换装后的新页面靠它把最终结局（尤其 Relay 子句）补显
  // 一次——旧页面在换装瞬间带走一切，结论不能只活在那最后一帧里。
  function handleSelfUpdateLast(res) {
    refreshClientUpdates();
    const last = listClientUpdateRuns(updateJournalDir)
      .filter((run) => run.clientId === SELF_UPDATE_CLIENT_ID && run.state === "done")
      .sort((a, b) => String(b.finishedAt ?? "").localeCompare(String(a.finishedAt ?? "")))[0] ?? null;
    if (!last) return sendJson(res, 404, { ok: false, error: "no_runs" });
    return sendJson(res, 200, selfUpdateStatusPayload(last));
  }

  // ── 关闭先行版的回退计划与逆更新 ──────────────────────────────────────
  // 目标语义＝「本地之下的最近稳定 tag」：
  //   1) 本地 HEAD 恰在某个远端 v-tag 上（先行期间远端把它发布了）→ 就地关闭，
  //      无需换装；
  //   2) 否则取版本号不高于本地版本的最新的 v-tag——浅拉仓库没有祖先链可查，
  //      版本号是「脚下最近」的判定；一个候选都没有则取最新 tag（本地比所有
  //      tag 都旧，回退即升到稳定轨道前端）；
  //   3) 远端一个 v-tag 都没有 → 无法判定，返回 null，调用方按「暂时无法检查」
  //      如实呈现。
  // 无本地 git 身份（镜像安装未引导）无从回退：按 1 处理，关闭后版本级检查接管。
  async function resolveBleedingClosePlan() {
    const local = await getLocalHead();
    if (!local) return { onStableNode: true, baseTag: null, baseVersion: null };
    const remote = await getRemoteIdentity(true);
    if (!remote) return null;
    const tagVersion = (tag) => tag.replace(/^v/, "");
    const tags = [...remote.tags.keys()].filter((tag) => parseVersionDefault(tagVersion(tag)) !== null);
    if (!tags.length) return null;
    const newest = (candidates) => [...candidates].sort((a, b) => compareVersionsDefault(tagVersion(b), tagVersion(a)))[0];
    const onTag = [...remote.tags.entries()]
      .filter(([, sha]) => sha === local.sha)
      .map(([tag]) => tag)
      .filter((tag) => parseVersionDefault(tagVersion(tag)) !== null);
    if (onTag.length) {
      const baseTag = newest(onTag);
      return { onStableNode: true, baseTag, baseVersion: tagVersion(baseTag) };
    }
    const under = tags.filter((tag) => {
      const order = compareVersionsDefault(appInfo.version, tagVersion(tag));
      return order !== null && order >= 0;
    });
    const baseTag = newest(under.length ? under : tags);
    return { onStableNode: false, baseTag, baseVersion: tagVersion(baseTag) };
  }

  // 逆更新登记：直接落一条 step=apply 的 rollback run（没有下载阶段——tag 的
  // 比特由 worker 的幂等补拉完成），换装、依赖、重启、验证、回滚点全部走既有
  // apply 骨架，终态文案按回退口径（「已回到稳定版 X」）。
  function registerSelfUpdateRollback({ targetTag, targetVersion }) {
    const runId = randomUUID();
    const run = {
      runId,
      clientId: SELF_UPDATE_CLIENT_ID,
      action: "update",
      step: "apply",
      state: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      result: null,
      workerPid: null,
      track: "rollback",
      targetVersion,
      targetTag,
      targetSha: null,
      beforeVersion: appInfo.version,
      appDir: APP_DIR,
      repoUrl: APP_REPO_URL,
      relayRoot,
      phase: "installing",
    };
    writeClientUpdateRun(updateJournalDir, run);
    let workerPid = null;
    try {
      workerPid = spawnSelfUpdate({ runId, journalDir: updateJournalDir });
    } catch {
      workerPid = null;
    }
    if (!Number.isInteger(workerPid) || workerPid <= 0) {
      writeClientUpdateRun(updateJournalDir, {
        ...run,
        state: "done",
        finishedAt: new Date().toISOString(),
        result: { outcome: "failed", message: "更新未能启动，请稍后重试" },
      });
      return null;
    }
    writeClientUpdateRun(updateJournalDir, { ...run, workerPid });
    return run;
  }

  // GET /panel/api/self-update/bleeding-plan：关闭前的回退计划——前端据它决定
  // 确认弹层是「直接关闭」还是「回退并关闭」形态。
  async function handleBleedingPlan(res) {
    const plan = await resolveBleedingClosePlan();
    if (!plan) return sendJson(res, 200, { ok: false });
    return sendJson(res, 200, { ok: true, ...plan });
  }

  // POST /panel/api/self-update/rollback：换装回稳定节点。计划现场重解——确认弹
  // 层里的版本号来自 GET，若远端在确认间隙变化，以执行时重解为准（终态文案会
  // 如实给出实际版本）。
  async function handleSelfUpdateRollback(res) {
    if (hostKind !== "panel-host") {
      return sendJson(res, 409, { ok: false, error: "self update must be requested from the control panel on 47820" });
    }
    refreshClientUpdates();
    if (runningClientUpdate(updateJournalDir, SELF_UPDATE_CLIENT_ID)) {
      return sendJson(res, 409, { ok: false, error: "busy", message: "已有更新任务在进行中，请等待完成" });
    }
    const plan = await resolveBleedingClosePlan();
    if (!plan || plan.onStableNode || !plan.baseTag) {
      return sendJson(res, 409, { ok: false, error: "no_rollback", message: "没有需要回退的更新" });
    }
    const run = registerSelfUpdateRollback({ targetTag: plan.baseTag, targetVersion: plan.baseVersion });
    if (!run) {
      return sendJson(res, 500, { ok: false, error: "spawn_failed", message: "更新未能启动，请稍后重试" });
    }
    armSelfUpdateWatcher();
    return sendJson(res, 202, { ok: true, runId: run.runId, clientId: SELF_UPDATE_CLIENT_ID, action: "update", step: "apply", track: "rollback", targetVersion: run.targetVersion });
  }

  // 「自动检测并下载更新」（设置项，默认关）：面板常驻期间按拍节检查，有更新且
  // 没有在跑/待应用的任务就登记一次下载。只走 download 阶段，绝不自动应用。
  async function maybeAutoDownloadSelfUpdate() {
    if (hostKind !== "panel-host") return;
    try {
      if (loadSettings(settingsFile, base).settings.autoDownloadUpdates !== true) return;
    } catch {
      return; // 设置读不出就不动：自动下载是便览功能，不为它冒险
    }
    let update = null;
    try {
      update = await getAppUpdateState(false);
    } catch {
      return;
    }
    if (update?.track === "bleeding" && update.identity !== false) {
      if (update.state !== "update_available" || !update.remoteSha) return;
    } else if (update?.state !== "update_available" || !update.release?.tag || !update.release?.version) {
      return;
    }
    refreshClientUpdates();
    if (runningClientUpdate(updateJournalDir, SELF_UPDATE_CLIENT_ID)) return;
    if (await findStagedSelfUpdate()) return;
    const run = update.track === "bleeding"
      ? registerSelfUpdateDownload({ track: "bleeding", targetSha: update.remoteSha })
      : registerSelfUpdateDownload({ targetVersion: update.release.version, targetTag: update.release.tag });
    logger?.info(run
      ? `Self update auto-download registered: ${run.targetTag ?? run.targetSha}`
      : "Self update auto-download failed to spawn its worker");
  }

  function firePanelSwap() {
    stopSelfUpdateWatcher();
    logger?.info("Self update reached swap phase; scheduling panel host replacement");
    const scheduleExit = startPanelHostReplacement({ onSpawnError: (err) => logger?.error(`Self update restart helper failed: ${err?.message}`) });
    if (scheduleExit) scheduleExit(); // 没有响应 flush 可等：进宽限即退
    return true;
  }

  // 换装监听器：worker 把阶段推到 ready-to-restart / waiting-panel 后，等的就是
  // 这一枪——拉起 helper 并按宽限自退。本进程已是目标身份时绝不点火：换装后的
  // 新面板接管时会扫到进行中的 run（worker 正在验证复活），点火等于自杀刚接班
  // 的自己。定时器只在有进行中的自更新任务时存在。
  function stopSelfUpdateWatcher() {
    if (selfUpdateWatchTimer !== null) {
      selfUpdateWatchCancelFn(selfUpdateWatchTimer);
      selfUpdateWatchTimer = null;
    }
  }

  function pumpSelfUpdateWatcher() {
    if (hostKind !== "panel-host") return false;
    let run = null;
    try {
      refreshClientUpdates();
      run = runningClientUpdate(updateJournalDir, SELF_UPDATE_CLIENT_ID);
    } catch {
      run = null;
    }
    if (!run) {
      stopSelfUpdateWatcher();
      return false;
    }
    const atSwap = run.phase === "ready-to-restart" || run.phase === "waiting-panel";
    if (!atSwap) return false;
    // 先行轨的目标身份是提交 SHA，本地身份数据在异步查询后面：交给同拍的异步
    // 续体判定，泵本身保持同步（稳定/回退轨走版本号，零额外往返）。
    if (run.track === "bleeding") {
      void maybeFireBleedingPanelSwap(run);
      return false;
    }
    if (appInfo.version === run.targetVersion) return false;
    return firePanelSwap();
  }

  async function maybeFireBleedingPanelSwap(run) {
    const shortTarget = typeof run.targetSha === "string" ? run.targetSha.slice(0, 7) : null;
    const commit = await getAppCommit();
    if (commit && commit === shortTarget) return; // 已是目标提交：不自杀刚接班的自己
    // 异步窗口里任务可能已收场或翻面：重读再决定，别拿过期快照点火。
    let current = null;
    try {
      refreshClientUpdates();
      current = runningClientUpdate(updateJournalDir, SELF_UPDATE_CLIENT_ID);
    } catch {
      current = null;
    }
    if (!current || current.runId !== run.runId) return;
    if (current.phase !== "ready-to-restart" && current.phase !== "waiting-panel") return;
    firePanelSwap();
  }

  function armSelfUpdateWatcher() {
    if (hostKind !== "panel-host" || selfUpdateWatchTimer !== null) return;
    selfUpdateWatchTimer = selfUpdateWatchScheduleFn(pumpSelfUpdateWatcher, SELF_UPDATE_WATCH_MS);
  }

  // 面板启动时接管：上一个进程可能死在自更新进行中（手动重启、崩溃）。有进行中的
  // 自更新任务就把监听器重新布上——worker 在换装阶段等的正是这一枪。
  if (hostKind === "panel-host") {
    try {
      refreshClientUpdates();
      if (runningClientUpdate(updateJournalDir, SELF_UPDATE_CLIENT_ID)) armSelfUpdateWatcher();
    } catch { /* journal 尚不存在：无需接管 */ }
    // 「自动检测并下载更新」的常驻拍节：首开一拍 + 每 6 小时。开关每拍现读设置。
    // 只有显式传入调度器才布点——见注入项注释（单测到处建路由器，不能默认挂真定时器）。
    selfUpdateAutoDownloadScheduleFn?.(() => maybeAutoDownloadSelfUpdate());
  }

  // Push the current store to every agent endpoint config (zcode, dsh, pi,
  // kimi, qoder, codex, opencode, grok). Runs the standalone sync runner so the
  // merge logic loads from disk — catalog-writer fixes apply here without a
  // panel/relay restart.
  async function handleAgentSync(res) {
    logger?.info("agent endpoint sync requested from panel");
    try {
      const { parseSyncSummaryLine, SYNC_RESULT_PREFIX } = await import("./agent-sync.mjs");
      // 同步进程把那行机器可读摘要混在 stdout 里回传：它是给前端解析用的，不该
      // 出现在用户看的实时输出里，交给子进程前先把这行从日志里滤掉。
      const uiLogger = logger
        ? {
            info: (message) => {
              if (!String(message).includes(SYNC_RESULT_PREFIX)) logger.info?.(message);
            },
            warn: (message) => logger.warn?.(message),
            error: (message) => logger.error?.(message),
          }
        : null;
      const result = await spawnAgentSyncFn({ port: 47821, logger: uiLogger });
      // 失败上屏的落盘点（source "manual"）：结果写进 sync-status.json，面板轮询
      // 渲染「上次同步未成功」。运行日志关掉时日志行会被活闸门丢弃，这份文件是
      // 失败最后剩下的可见面。落盘失败不影响本路由的响应。
      try {
        writeSyncStatus(relayRoot, syncStatusFromResult(result, "manual"));
      } catch (err) {
        logger?.warn?.(`sync status write failed: ${err.message}`);
      }
      // 同步进程在 stdout 上留了一行机器可读摘要。个别端点写不进去不再算整次
      // 失败：其余端点已经同步好，按钮只把没写进去的端点报出来。仓库数据读不
      // 出来或同步进程自己崩了，才是真的失败。
      const summary = parseSyncSummaryLine(result.stdout);
      const ok = summary ? summary.ok : result.ok;
      sendJson(res, ok ? 200 : 500, {
        ok,
        failed: summary?.failed ?? [],
        synced: summary?.synced ?? [],
        codexCatalog: summary?.codexCatalog,
        error: ok ? undefined : "同步没能完成，请稍后重试",
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // 最近一次同步的结果（sync-status.json，每次同步后落盘）。文件不存在或读不出
  // ＝「无从报告」：按无异常返回 ok:true/at:null，前端据此不渲染任何提示——
  // 这份文件不是错误证据，读不出来本身也不构成一次失败。
  function handleSyncStatus(res) {
    const status = readSyncStatus(relayRoot);
    if (!status) return sendJson(res, 200, { ok: true, at: null, failed: [], synced: [] });
    return sendJson(res, 200, status);
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
    // 记录关着时这条流永远不会有内容：直接 204 收尾，比挂一条只会干等的 SSE 诚实。
    if (typeof logger.isEnabled === "function" && !logger.isEnabled()) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // 必须显式冲头。本端点在没有历史可重放时一个字节都不写，而浏览器要等响应头落地
    // 才算建连成功：不冲头就会一直停在「正在重连」，直到下一条日志写入才恢复（点完
    // 「清空」再刷新页面正是这个形状）。中继侧的同类端点早已这么做，这份漏了。
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    // 级别过滤只发生在这一个出口。写入侧照旧全量：日志文件与环形缓冲都不因用户选了
    // 高级别而少一行，档案是排障时唯一的凭据。逐帧现读闸门，是为了让已经打开的其它
    // 窗口不必重连就不再收到低于门槛的新行；它们屏幕上已经显示出去的旧行，随客户端
    // 25 行上限自然滚掉。清空帧没有 level，判定一律放行——它不是日志。
    const writeEntryFrame = (entry) => {
      if (!logLevelAllows(entry.level, logLevelGate())) return;
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    // Replay history for late joiners, then stream live entries.
    for (const entry of logger.getHistory()) {
      writeEntryFrame(entry);
    }
    const unsubscribe = logger.subscribe((entry) => {
      try {
        writeEntryFrame(entry);
      } catch {
        // socket gone; unsubscribe will happen on close below
      }
    });
    const cleanup = () => unsubscribe();
    req.on("close", cleanup);
    req.on("error", cleanup);
  }

  // 活跃真值浏览器出口。与日志流同型：GET 免 token（loopback 是网络边界，
  // 只有写操作才过 CSRF 闸）。客户端建连即收到桥缓存的当前快照整帧对齐，其后
  // 逐帧转发桥事件；relay 侧的注释心跳行由桥原样直通，保浏览器侧连接。
  let agentsActivityBridgeInstance = agentsActivityBridge;
  function getAgentsActivityBridge() {
    if (!agentsActivityBridgeInstance) agentsActivityBridgeInstance = startRelayActivityBridge(storePaths.root);
    return agentsActivityBridgeInstance;
  }

  function handleAgentsActivitySSE(res, req) {
    const bridge = getAgentsActivityBridge();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(bridge.snapshotFrame())}\n\n`);
    const unsubscribe = bridge.subscribe((block) => {
      try {
        res.write(block);
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
  // budget", and only the first justifies the local collector — which owns no
  // traffic at all. Serving the collector on a timeout yields a structurally
  // identical blind frame (running, but 0 requests / no lastSeen / no
  // sparkHistory), so bounded staleness beats a false zero.
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
    //
    // frame.ready 是看板「这一帧能不能当事实说」的唯一判据（2026-10-07 报障：从出现到
    // 加载出数据那段中间态，卡面把「还没取到数」画成「什么都没跑」）。ready:false 只可能
    // 出现在两种地方：relay 活着但这一拍没答上且手里没有可续的陈旧快照；以及这个进程压根
    // 没有数据源。此时不发一份看起来像数据的空壳，看板自己盖加载态。
    // 超时这一路明确不去叫自家收集器：它不经流量，交回来的是「运行中 + 全空读数」的假帧。
    const token = relayPullToken();
    const pulled = await fetchRelayAgents(relayRoot, token);
    if (Array.isArray(pulled)) {
      lastPulledAgents = { at: Date.now(), agents: pulled };
      sendJson(res, 200, { ok: true, agents: pulled, frame: { ready: true, source: "relay" } });
      return;
    }
    if (pulled && pulled.pullTimeout === true) {
      if (lastPulledAgents && Date.now() - lastPulledAgents.at <= PULLED_AGENTS_STALE_MAX_MS) {
        sendJson(res, 200, {
          ok: true, agents: lastPulledAgents.agents, frame: { ready: true, source: "relay-stale" },
        });
        return;
      }
      sendJson(res, 200, {
        ok: true, agents: [], frame: { ready: false, reason: "relay-timeout" },
      });
      return;
    }
    if (lastPulledAgents && Date.now() - lastPulledAgents.at <= PULLED_AGENTS_STALE_MAX_MS) {
      sendJson(res, 200, {
        ok: true, agents: lastPulledAgents.agents, frame: { ready: true, source: "relay-stale" },
      });
      return;
    }
    if (!metricsCollector) {
      sendJson(res, 200, {
        ok: true, agents: [], frame: { ready: false, reason: "no-source" },
      });
      return;
    }
    try {
      const agents = await metricsCollector.getAgentsStatus();
      sendJson(res, 200, {
        ok: true, agents, frame: { ready: true, source: "panel-local" },
      });
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

  // BYOK 导入服务惰性装配：storeRoot 用面板同一个数据根（store.json 所在），
  // 端点本地配置扫 homeDir 下的各端点目录；removeFn 绑定删除器，备份落数据根
  // backups/（与数据搬迁同一备份约定；面板是组合根，backupRoot 以这里为准，
  // 服务自带的默认备份目录不生效）。两个真模块由并行工人交付，动态 import
  // 让它们缺席或半成品时只拖垮这两条路由，不影响 panel.mjs 整体加载。
  async function byokImportServiceLazy() {
    if (!byokImportService) {
      const [{ createByokImportService }, { removeImportedEntries }] = await Promise.all([
        import("./byok-import.mjs"),
        import("./byok-remove.mjs"),
      ]);
      byokImportService = createByokImportService({
        storeRoot: relayRoot,
        homeDir: homedir(),
        env: base,
        removeFn: (entries, opts = {}) =>
          removeImportedEntries(entries, { ...opts, backupRoot: join(relayRoot, "backups") }),
      });
    }
    return byokImportService;
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

  // panel.html/panel.css/panel.js 内存缓存 + ETag/304。每请求 statSync 校验
  // mtimeMs:size，不变即复用内存 body；ETag 由 size+mtimeMs 派生；
  // Cache-Control: no-cache 强制每次 revalidate，If-None-Match 命中回 304。
  // 缓存键含 resolved 路径（测试会切 ANYSWITCH_PANEL_HTML env override，防串内容）。
  // statSync 失败不命中/不写缓存，404 JSON 语义原样保留。
  let panelHtmlCache = null; // { path, mtimeMs, size, body, etag }
  function servePanelFile(res, req, htmlPath, contentType) {
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
        res.writeHead(200, { "content-type": contentType });
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
    res.writeHead(200, { "content-type": contentType, ...revalidateHeaders });
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
      return servePanelFile(res, req, resolvePanelHtmlPath(), "text/html; charset=utf-8");
    }

    if (path === "/panel/assets/panel.css" && (method === "GET" || method === "HEAD")) {
      if (hostKind !== "panel-host") {
        res.writeHead(302, { location: CONTROL_PLANE_PANEL_URL });
        return res.end();
      }
      return servePanelFile(res, req, REPO_PANEL_CSS, "text/css; charset=utf-8");
    }

    if (path === "/panel/assets/panel.js" && (method === "GET" || method === "HEAD")) {
      if (hostKind !== "panel-host") {
        res.writeHead(302, { location: CONTROL_PLANE_PANEL_URL });
        return res.end();
      }
      return servePanelFile(res, req, REPO_PANEL_JS, "text/javascript; charset=utf-8");
    }
    if (path === "/panel/assets/xterm.js" && (method === "GET" || method === "HEAD")) {
      if (hostKind !== "panel-host") {
        res.writeHead(302, { location: CONTROL_PLANE_PANEL_URL });
        return res.end();
      }
      return servePanelFile(res, req, REPO_XTERM_JS, "text/javascript; charset=utf-8");
    }
    if (path === "/panel/assets/xterm.css" && (method === "GET" || method === "HEAD")) {
      if (hostKind !== "panel-host") {
        res.writeHead(302, { location: CONTROL_PLANE_PANEL_URL });
        return res.end();
      }
      return servePanelFile(res, req, REPO_XTERM_CSS, "text/css; charset=utf-8");
    }
    if (path === "/panel/assets/xterm-fit.js" && (method === "GET" || method === "HEAD")) {
      if (hostKind !== "panel-host") {
        res.writeHead(302, { location: CONTROL_PLANE_PANEL_URL });
        return res.end();
      }
      return servePanelFile(res, req, REPO_XTERM_FIT_JS, "text/javascript; charset=utf-8");
    }
    if (path === "/panel/assets/xterm-unicode11.js" && (method === "GET" || method === "HEAD")) {
      if (hostKind !== "panel-host") {
        res.writeHead(302, { location: CONTROL_PLANE_PANEL_URL });
        return res.end();
      }
      return servePanelFile(res, req, REPO_XTERM_UNICODE11_JS, "text/javascript; charset=utf-8");
    }
    if (path === "/panel/assets/xterm-webgl.js" && (method === "GET" || method === "HEAD")) {
      if (hostKind !== "panel-host") {
        res.writeHead(302, { location: CONTROL_PLANE_PANEL_URL });
        return res.end();
      }
      return servePanelFile(res, req, REPO_XTERM_WEBGL_JS, "text/javascript; charset=utf-8");
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

    if (path === "/panel/api/app-info" && method === "GET") {
      // commit＝本地 HEAD 短哈希（进程生命周期内不变，一次查询终身复用）。先行
      // 版的版本号后缀与 worker 的复活验证都认它；无 git 身份时不带这个键。
      const commit = await getAppCommit();
      return sendJson(res, 200, commit ? { ...appInfo, commit } : appInfo);
    }
    if (path === "/panel/api/updates" && method === "GET") {
      try {
        return sendJson(res, 200, await getAppUpdateState(url.searchParams.get("refresh") === "1"));
      } catch {
        return sendJson(res, 200, { currentVersion: appInfo.version, state: "error", checkedAt: new Date().toISOString(), release: null, errorCode: "update_unavailable", track: "stable", drift: null });
      }
    }
    if (path.startsWith("/panel/api/environment/latest/") && method === "GET") {
      const id = path.slice("/panel/api/environment/latest/".length);
      if (!["claude", "codex", "codex-desktop", "opencode", "pi", "kimi", "dsh", "dsh-desktop", "dsh-tui", "zcode", "qoder", "qoder-cli", "grok", "claude-desktop", "kimi-desktop"].includes(id)) {
        return sendJson(res, 404, { error: "unknown_client", message: "未找到这个客户端" });
      }
      try {
        const service = await getReleaseService();
        const result = await service.getClientLatest(id, { force: url.searchParams.get("refresh") === "1" });
        const localVersion = url.searchParams.get("localVersion");
        let comparison = "unknown";
        if (result.state === "ok" && localVersion && localVersion.length <= 128) {
          const { compareVersions } = await import("./version-check.mjs");
          const order = compareVersions(localVersion, result.version);
          if (order !== null) comparison = order < 0 ? "update_available" : order > 0 ? "ahead" : "current";
        }
        return sendJson(res, 200, { ...result, comparison });
      } catch {
        return sendJson(res, 200, { state: "error", version: null, url: null, source: "", checkedAt: new Date().toISOString(), errorCode: "update_unavailable", comparison: "unknown" });
      }
    }
    if (path === "/panel/api/environment/update" && method === "POST") return handleClientUpdate(req, res);
    if (path === "/panel/api/environment/updates/active" && method === "GET") return handleClientUpdatesActive(res);
    if (path.startsWith("/panel/api/environment/update/") && method === "GET") {
      return handleClientUpdateStatus(res, path.slice("/panel/api/environment/update/".length));
    }
    if (path === "/panel/api/self-update" && method === "POST") return handleSelfUpdateStart(req, res);
    if (path === "/panel/api/self-update/apply" && method === "POST") return handleSelfUpdateApply(req, res);
    if (path === "/panel/api/self-update/bleeding-plan" && method === "GET") return handleBleedingPlan(res);
    if (path === "/panel/api/self-update/rollback" && method === "POST") return handleSelfUpdateRollback(res);
    if (path === "/panel/api/self-update/active" && method === "GET") return handleSelfUpdateActive(res);
    if (path === "/panel/api/self-update/last" && method === "GET") return handleSelfUpdateLast(res);
    if (path.startsWith("/panel/api/self-update/") && method === "GET") return handleSelfUpdateRunStatus(res, path.slice("/panel/api/self-update/".length));
    if (path === "/panel/api/environment" && method === "GET") {
      try {
        const service = await getEnvironmentService();
        return sendJson(res, 200, await service.getState({ force: url.searchParams.get("refresh") === "1" }));
      } catch {
        return sendJson(res, 500, { error: "environment_unavailable", message: "暂时无法检测本地环境" });
      }
    }
    if (path === "/panel/api/status" && method === "GET") return handleStatus(res);
    if (path === "/panel/api/relay/status" && method === "GET") return handleRelayStatus(res);
    if (path === "/panel/api/relay/start" && method === "POST") return handleRelayStart(res);
    if (path === "/panel/api/relay/stop" && method === "POST") return handleRelayStop(res);
    if (path === "/panel/api/relay/restart" && method === "POST") return handleRelayRestart(res);
    if (path === "/panel/api/panel-host/restart" && method === "POST") return handlePanelHostRestart(res);
    if (path === "/panel/api/sync-agents" && method === "POST") return handleAgentSync(res);
    if (path === "/panel/api/sync-status" && method === "GET") return handleSyncStatus(res);
    if (path === "/panel/api/agents" && method === "GET") return handleAgents(res);
    if (path === "/panel/api/model-stability" && method === "GET") return handleModelStability(res);
    if (path === "/panel/api/route-chain/runtime" && method === "GET") return handleRouteChainRuntime(res);
    if (path === "/panel/api/session/report" && method === "POST") return handleSessionReport(req, res);
    if (path === "/panel/api/terminal/default-cwd" && method === "GET") return proxyTerminal(req, res, "/terminal/default-cwd", "GET");
    if (path === "/panel/api/terminal/host/status" && method === "GET") return handleTerminalHostStatus(res);
    if (path === "/panel/api/terminal/host/start" && method === "POST") return handleTerminalHostStart(res);
    if (path === "/panel/api/terminal/host/stop" && method === "POST") return handleTerminalHostStop(req, res);
    if (path === "/panel/api/terminal/sessions" && method === "GET") return handleTerminalSessionsList(res);
    // 终端亮暗上报（match terminal 契约）：面板是亮暗的事实源，直通宿主存值
    // 并扇出 997。与 sessions POST 同款读体+错误回包形制。
    if (path === "/panel/api/terminal/theme" && method === "POST") {
      try {
        return proxyTerminal(req, res, "/terminal/theme", "POST", await readJsonBody(req));
      } catch (error) {
        return sendJson(res, error.statusCode ?? 400, { ok: false, error: error.message });
      }
    }
    if (path === "/panel/api/terminal/sessions" && method === "POST") {
      try {
        return proxyTerminal(req, res, "/terminal/sessions", "POST", await readJsonBody(req));
      } catch (error) {
        return sendJson(res, error.statusCode ?? 400, { ok: false, error: error.message });
      }
    }
    if (path === "/panel/api/terminal/agent-sessions" && method === "POST") return handleTerminalAgentSessionCreate(req, res);
    if (path.startsWith("/panel/api/terminal/sessions/")) {
      const suffix = path.slice("/panel/api/terminal/sessions/".length);
      const reviveMatch = suffix.match(/^([a-f0-9-]{8,64})\/revive$/i);
      if (reviveMatch && method === "POST") {
        try {
          await readJsonBody(req);
        } catch (error) {
          return sendJson(res, error.statusCode ?? 400, { ok: false, error: error.message });
        }
        return handleTerminalSessionRevive(req, res, reviveMatch[1]);
      }
      // 内切切换（M12-A）：路由体带目标会话身份，与 revive（无体、用会话自己的
      // 身份）分工；先收体再进处理器，读体失败按 400 拒。
      const switchMatch = suffix.match(/^([a-f0-9-]{8,64})\/switch$/i);
      if (switchMatch && method === "POST") {
        let switchBody;
        try {
          switchBody = await readJsonBody(req);
        } catch (error) {
          return sendJson(res, error.statusCode ?? 400, { ok: false, error: error.message });
        }
        return handleTerminalSessionSwitch(req, res, switchMatch[1], switchBody);
      }
      if (!/^[a-f0-9-]+(?:\/(?:input|resize|stream|restart|close))?$/i.test(suffix)) return sendJson(res, 400, { ok: false, error: "invalid_terminal_session" });
      if (method === "GET") return proxyTerminal(req, res, `/terminal/sessions/${suffix}`);
      if (method === "POST") {
        try {
          return proxyTerminal(req, res, `/terminal/sessions/${suffix}`, "POST", await readJsonBody(req));
        } catch (error) {
          return sendJson(res, error.statusCode ?? 400, { ok: false, error: error.message });
        }
      }
    }
    if (path === "/panel/api/terminal/requests" && method === "GET") return handleTerminalRequests(url, res);
    // 终端会话栏视图状态（M7）：归档清单与已移除分组目录清单。GET 全量 + 四个
    // 动作 POST，落点与绑定库同目录（见 terminalRailPrefs）。
    if (path === "/panel/api/terminal/rail/prefs" && method === "GET") return handleTerminalRailPrefs(res);
    for (const action of ["archive", "unarchive", "remove-group", "restore-group"]) {
      if (path === `/panel/api/terminal/rail/${action}` && method === "POST") {
        return handleTerminalRailArchive(req, res, action);
      }
    }
    if (path === "/panel/api/logs" && method === "GET") return handleLogsSSE(res, req);
    if (path === "/panel/api/agents-activity" && method === "GET") return handleAgentsActivitySSE(res, req);
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
        // 关掉运行日志时把已缓冲的内容一并丢掉。不丢的话，重新打开会先涌出一批关闭
        // 之前的旧行，看着像「关掉没生效」；clear() 同时向所有打开的面板窗口广播清空
        // 帧，所以这一下不只清当前这个页面。重新开启时窗口从新日志开始，符合预期。
        if (body.loggingEnabled === false) {
          try {
            logger?.clear?.();
          } catch (err) {
            logger?.warn?.(`运行日志已关闭，但缓冲清空失败：${err.message}`);
          }
        }
        // 注入推理强度 controls what every endpoint's config is told about
        // levels, and those configs are only rewritten by a sync. Fire one so
        // the toggle takes effect immediately instead of waiting for the next
        // store change. Best-effort: the setting is already saved, and a failed
        // sync just leaves the endpoints as they were until the next one.
        if (typeof body.injectThinkingEffort === "boolean") {
          try {
            const syncResult = await spawnAgentSyncFn({ port: 47821, logger });
            // 与启动/监视器两处同口径落盘（source "settings"），让这条路径的
            // 失败同样能上屏；落盘失败不影响设置保存的既有行为。
            try {
              writeSyncStatus(relayRoot, syncStatusFromResult(syncResult, "settings"));
            } catch (err) {
              logger?.warn?.(`sync status write failed: ${err.message}`);
            }
          } catch (err) {
            logger?.warn?.(`推理强度设置已保存，但端点重新同步失败：${err.message}`);
          }
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

      // 看板轻量端点：只下发 routingChains + 名字映射，不带全量 store payload。
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
          if (path === "/panel/api/store/virtual-model/save") {
            // Route layer checks shape only (name string, chain array, optional
            // previousName string); per-element {node, model} validation and
            // the rename rules live in the service.
            if (typeof body.name !== "string" || !body.name.trim()) {
              return sendJson(res, 400, { ok: false, error: "name must be a non-empty string" });
            }
            if (!Array.isArray(body.chain)) {
              return sendJson(res, 400, { ok: false, error: "chain must be an array of { node, model } entries" });
            }
            if (body.previousName !== undefined
              && (typeof body.previousName !== "string" || !body.previousName.trim())) {
              return sendJson(res, 400, { ok: false, error: "previousName must be a non-empty string when present" });
            }
            const result = await svc.saveVirtualModel(
              body.name.trim(),
              body.chain,
              body.previousName === undefined ? undefined : body.previousName.trim(),
            );
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/virtual-model/enabled") {
            if (typeof body.name !== "string" || !body.name.trim()) {
              return sendJson(res, 400, { ok: false, error: "name must be a non-empty string" });
            }
            if (typeof body.enabled !== "boolean") {
              return sendJson(res, 400, { ok: false, error: "enabled must be a boolean" });
            }
            const result = await svc.setVirtualModelEnabled(body.name.trim(), body.enabled);
            return sendJson(res, 200, result);
          }
          if (path === "/panel/api/store/virtual-model/delete") {
            if (typeof body.name !== "string" || !body.name.trim()) {
              return sendJson(res, 400, { ok: false, error: "name must be a non-empty string" });
            }
            const result = await svc.deleteVirtualModel(body.name.trim());
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

      // 请求日志（统计页「请求日志」子 tab）：journal 行级透传查询，不聚合。
      // range=today|7d|30d|all 映射到本地自然日闭区间（all=90 天 retention 窗，
      // 日历运算推起点防 DST）；status=ok→ok=true，其余失败档→errKind；
      // agent/provider/model 原值直传（agent="__none__" 是「未知来源」哨兵，
      // 由 journal 匹配 agentId 为 null 的行）；非法 range/status/sort/dir 一律
      // 回落默认，pageSize 只认 {20,50,100}。GET 无 CSRF 门（与 stats 一致）。
      if (path === "/panel/api/stats/logs" && method === "GET") {
        try {
          const sp = url.searchParams;
          const rangeRaw = sp.get("range");
          const range = LOG_RANGES.includes(rangeRaw) ? rangeRaw : "today";
          const nowTs = Date.now();
          const todayKey = dayKey(nowTs);
          const [yy, mm, dd] = todayKey.split("-").map(Number);
          const fromDay = dayKey(new Date(yy, mm - 1, dd - LOG_RANGE_BACK_DAYS[range]).getTime());
          const statusRaw = sp.get("status");
          const status = LOG_STATUSES.includes(statusRaw) ? statusRaw : "all";
          const sortRaw = sp.get("sort");
          const sortBy = sortRaw === "durationMs" ? "durationMs" : "ts";
          const dirRaw = sp.get("dir");
          const sortDir = dirRaw === "asc" ? "asc" : "desc";
          let page = Number.parseInt(sp.get("page") ?? "", 10);
          if (!Number.isFinite(page) || page < 1) page = 1;
          const pageSizeRaw = Number.parseInt(sp.get("pageSize") ?? "", 10);
          const pageSize = LOG_PAGE_SIZES.includes(pageSizeRaw) ? pageSizeRaw : 20;
          const q = (name) => {
            const v = sp.get(name);
            return v === null || v === "" ? undefined : v;
          };
          const result = usageJournalLazy().readRequestsLog({
            fromDay,
            toDay: todayKey,
            agentId: q("agent"),
            providerId: q("provider"),
            model: q("model"),
            ok: status === "ok" ? true : undefined,
            errKind: status !== "all" && status !== "ok" ? status : undefined,
            sortBy,
            sortDir,
            page,
            pageSize,
          });
          // 渠道显示名读取时解析（同 stats 契约：id→displayName，失败回落裸 id）；
          // modelDisplay 剥 wire 前缀（stripWirePrefix 与聚合层同一实现）。
          // journal 行是共享缓存对象，禁止原地改——映射出新对象。
          const labelChannel = (id) => statsChannelLabels.map.get(id) ?? id;
          const rows = result.rows.map((r) => ({
            ...r,
            providerLabel: labelChannel(r.providerId ?? ""),
            modelDisplay: stripWirePrefix(r.model).model,
          }));
          const facets = {
            // agents 的 label 就是 id 原值（null 保持 null，前端翻成「未知来源」）；
            // providers/models 过滤 null/空串——无哨兵语义的维度里它们不可选。
            agents: result.facets.agents.map((id) => ({ id, label: id })),
            providers: result.facets.providers
              .filter((id) => typeof id === "string" && id !== "")
              .map((id) => ({ id, label: labelChannel(id) })),
            models: result.facets.models
              .filter((raw) => typeof raw === "string" && raw !== "")
              .map((raw) => ({ raw, display: stripWirePrefix(raw).model })),
          };
          return sendJson(res, 200, {
            ok: true,
            generatedAt: nowTs,
            range,
            rows,
            total: result.total,
            page: result.page,
            pageSize: result.pageSize,
            facets,
          });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err.message });
        }
      }

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
    // Stateless live scan of the nine agents' on-disk session stores
    // (session-scan.mjs). A single adapter's failure degrades into
    // endpointErrors (drives the UI banner) instead of failing the whole
    // list. GETs carry no CSRF gate; POST delete is covered by the
    // dual-header mutation gate above. Path traversal defense (canonicalize
    // + per-adapter roots whitelist) lives inside session-scan's delete —
    // the router only validates the request shape.
    if (path.startsWith("/panel/api/sessions/")) {
      if (!sessionScanService) {
        sessionScanService = {
          // 列表扫描走扫描承载（worker 线程）：修前这里直接绑 session-scan 的
          // scanAll，九个 adapter 的同步 fs 全跑在面板进程的事件循环上。
          scanAll: () => scanHost.scanAll(),
          loadMessages: sessionLoadMessages,
          deleteSessions: sessionDeleteSessions,
        };
      }
      const svc = sessionScanService;

      if (path === "/panel/api/sessions/list" && method === "GET") {
        // 响应契约：{ sessions, endpointErrors } 由 scanAll 装配，单 adapter 失败
        // 降级进 endpointErrors，路由原样透传。
        // 但这一拍不再每次都扫盘：见 createSessionsListSnapshot——TTL 内复用上次
        // 结果，过期后先返回旧值、后台补一拍，请求绝不等刷新（冷缓存那一拍除外，
        // 没有旧值可交）。扫描本身在 worker 线程里跑，不占本进程事件循环。
        try {
          return sendJson(res, 200, await sessionsListSnapshotFor(svc).get());
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err.message });
        }
      }

      if (path === "/panel/api/sessions/messages" && method === "GET") {
        const endpoint = url.searchParams.get("endpoint");
        const file = url.searchParams.get("path");
        if (!endpoint || !file) {
          return sendJson(res, 400, { ok: false, error: "endpoint and path query params are required" });
        }
        try {
          const messages = await svc.loadMessages(endpoint, file);
          // The directory (「对话目录」) rides along with the transcript: session-scan
          // owns what counts as a round a human typed, so the panel draws turns
          // instead of re-judging nine transcript formats in the browser.
          return sendJson(res, 200, { ok: true, messages, turns: sessionBuildTurns(messages) });
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
            return sendJson(res, 400, { ok: false, error: "items must be a non-empty array of { endpoint, file }" });
          }
          const result = await svc.deleteSessions(body.items);
          // 删掉的行就地摘出快照：用户刚删完再看列表不该还看到它，也不必为
          // 此把整份快照作废（下一拍后台刷新会与盘面对齐）。
          const goneFiles = new Set((result?.ok ?? []).map((entry) => entry?.file ?? entry));
          sessionListSnapshot?.dropRows((session) => goneFiles.has(session?.file));
          // 响应契约：逐项成败，ok/fail 是数组（不是外层布尔包装）。
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
      if (!skillsService) {
        // 首个真实请求先等一次可见性快照：界面要拿到按已安装过滤的端点清单
        // 才能渲染部署行（检测进程内 60s TTL，只在冷缓存这一次付费）；之后由
        // 定时刷新保持新鲜，后续请求不再等待。
        await refreshEndpointVisibility();
        ensureEndpointVisibilityFreshness();
        skillsService = createSkillsService({ base, isEndpointVisible });
      }
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
            const result = svc.setRepoPath(requireString(body.repoPath, "repoPath"), {
              allowEmpty: body.allowEmpty === true,
            });
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
              return sendJson(res, 400, { ok: false, error: 'direction must be "repo" or "local"' });
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
          // 逐行左右对照（异常卡「查看差异」弹窗）。与上一条同校验、不同粒度：
          // 这里连"没比"的文件（二进制 / 超限）也一并回清单，弹窗要说清哪些没比。
          if (path === "/panel/api/skills/diff/content") {
            const result = await svc.diffSkillContent({
              endpointId: requireString(body.endpointId, "endpointId"),
              skillName: requireString(body.skillName, "skillName"),
            });
            return sendJson(res, 200, { ok: true, files: result.files || [] });
          }
          if (path === "/panel/api/skills/body") {
            const result = await svc.readSkillBody(requireString(body.relPath, "relPath"));
            return sendJson(res, 200, { ok: true, ...result });
          }
        } catch (err) {
          // err.code 是服务端给的机读信号（如 skills_repo_empty），随响应透出供前端分支
          return sendJson(res, err.statusCode ?? 500, { ok: false, error: err.message, ...(err.code ? { code: err.code } : {}) });
        }
      }
    }

    // ── Prompts tab routes ─────────────────────────────────────────────
    // Every mutation POST persists via the data plane, then immediately
    // re-syncs all nine endpoint instruction files. Sync failures land in
    // the `sync` snapshot (GET state) and never fail the mutation itself;
    // thrown validation errors become { ok:false, error }.
    if (path.startsWith("/panel/api/prompts/")) {
      if (!promptsService) {
        // 与 skills 同款：先等一次可见性快照再建服务，注入行/全部注入的分母
        // 天然只剩已安装的 Agent；syncAll 对未安装的按空预设集清理（见 facade）。
        await refreshEndpointVisibility();
        ensureEndpointVisibilityFreshness();
        promptsService = createPromptsPanelService({ base, isEndpointVisible });
      }
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
          if (path === "/panel/api/prompts/preset/reorder") {
            // 预设拖拽重排：order 为预设 id 的完整排列，业务校验在数据层。
            if (!Array.isArray(body.order)) {
              const error = new Error("order 必须是预设 id 数组");
              error.statusCode = 400;
              throw error;
            }
            const result = svc.reorderPresets(body.order);
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

    // ── 数据搬迁（高级选项 tab 的导出 / 导入）──────────────────────────
    // 导出与导入都只把「路径」过 API：文件本体由后端在磁盘上读写，所以包体积
    // 与面板那条 1 MiB 请求体上限无关。导入分两步：preview 回摘要与一次性票据，
    // apply 只认这张票据，路径不由界面传入。业务失败一律 200 + { ok:false, error }。
    if (path.startsWith("/panel/api/data/")) {
      if (!dataBundleService) dataBundleService = createDataBundleService({ base });
      const svc = dataBundleService;

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

          if (path === "/panel/api/data/export-pick" || path === "/panel/api/data/import-pick") {
            const exporting = path.endsWith("/export-pick");
            const picked = exporting
              ? await pickFolderFn({ base, title: "选择导出包的保存位置" })
              : await pickFileFn({ base, title: "选择要导入的 anyswitch 导出包" });
            if (picked.cancelled) return sendJson(res, 200, { ok: true, cancelled: true });
            const result = exporting
              ? await svc.exportBundle({ targetDir: picked.path })
              : await svc.previewBundle(picked.path);
            return sendJson(res, 200, { ok: result.ok !== false, pickedPath: picked.path, ...result });
          }
          if (path === "/panel/api/data/export") {
            const result = await svc.exportBundle({ targetDir: requireString(body.targetDir, "targetDir") });
            return sendJson(res, 200, { ok: result.ok !== false, ...result });
          }
          if (path === "/panel/api/data/import-preview") {
            const result = await svc.previewBundle(requireString(body.zipPath, "zipPath"));
            return sendJson(res, 200, { ok: result.ok !== false, ...result });
          }
          if (path === "/panel/api/data/import-apply") {
            const result = await svc.applyBundle({
              token: requireString(body.token, "token"),
              skillsMode: typeof body.skillsMode === "string" ? body.skillsMode : undefined,
              skillsTarget: typeof body.skillsTarget === "string" ? body.skillsTarget.trim() : undefined,
            });
            // 只有真的换掉了 settings.json 才有对齐的必要；包里没带设置文件时
            // 盘上还是原来那份，计划与进程本来就和它对应，别去动。
            if (result.ok !== false && result.applied?.settings === true) {
              result.watchdog = await reconcileFollowAgentAfterImport(result.applied.followAgent === true);
              for (const w of result.watchdog.warnings) logger?.warn?.(`导入后 followAgent 对齐：${w}`);
            }
            return sendJson(res, 200, { ok: result.ok !== false, ...result });
          }
        } catch (err) {
          return sendJson(res, err.statusCode ?? 500, { ok: false, error: err.message });
        }
      }
    }

    // ── BYOK 渠道导入（扫端点本地手配渠道 → 勾选入库 → 默认删本地原始条目）──
    // 与数据搬迁同一惯例：业务失败一律 200 + { ok:false, error }（ticket-expired、
    // unknown-selection 都是可用信息，不是异常）；校验错抛 statusCode 按码落地。
    // scan 无 body；响应形状由服务保证（entries 不含明文 key）。票据只活在内存，
    // 面板宿主退出时经 dropByokImportTickets 丢掉。
    if (path.startsWith("/panel/api/byok-import/")) {
      if (method === "POST") {
        try {
          if (path === "/panel/api/byok-import/scan") {
            const svc = await byokImportServiceLazy();
            const result = await svc.scanLocalConfigs();
            return sendJson(res, 200, { ok: result.ok !== false, ...result });
          }
          if (path === "/panel/api/byok-import/apply") {
            // readJsonBody 必须在第一个 await 之前挂上 data/end 监听：客户端的
            // 请求体可能随微任务立刻到达，先 await 装配服务会永久丢 body。
            const bodyPromise = readJsonBody(req);
            const svc = await byokImportServiceLazy();
            const body = await bodyPromise;
            const requireString = (value, field) => {
              if (typeof value !== "string" || !value.trim()) {
                const error = new Error(`${field} 不能为空`);
                error.statusCode = 400;
                throw error;
              }
              return value.trim();
            };
            if (!Array.isArray(body.keys) || body.keys.some((k) => typeof k !== "string" || !k.trim())) {
              const error = new Error("keys 必须是非空字符串数组");
              error.statusCode = 400;
              throw error;
            }
            if (typeof body.deleteLocal !== "boolean") {
              const error = new Error("deleteLocal 必须是布尔值");
              error.statusCode = 400;
              throw error;
            }
            const result = await svc.applyImport({
              ticket: requireString(body.ticket, "ticket"),
              keys: body.keys.map((k) => k.trim()),
              deleteLocal: body.deleteLocal,
            });
            return sendJson(res, 200, { ok: result.ok !== false, ...result });
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
    // 面板宿主退出时调用：把导入预览留在 %TEMP% 的暂存目录、以及票据内存里的
    // 明文密钥副本一并丢掉。没被调用过时，弃用票据靠新建票据时的过期清扫兜底。
    // BYOK 导入票据同样攥着明文 key 内存副本，随同一退出钩子丢掉（panel-host
    // 只调 dropDataBundleTickets，所以这里一并带上；单独清理走下面的方法）。
    dropDataBundleTickets() {
      try {
        dataBundleService?.dropAllTickets?.();
      } catch (err) {
        logger?.warn?.(`导入暂存清理失败：${err.message}`);
      }
      this.dropByokImportTickets();
    },
    // BYOK 导入票据清理：服务还没建起来时静默跳过（不能为了清理而把服务建起来），
    // 清理失败也不能卡住退出路径。
    dropByokImportTickets() {
      try {
        byokImportService?.dropTickets?.();
      } catch (err) {
        logger?.warn?.(`BYOK 导入票据清理失败：${err.message}`);
      }
    },
  };
}
