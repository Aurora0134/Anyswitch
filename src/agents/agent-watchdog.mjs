// Standalone follow-agent watchdog process.
//
// The followAgent setting ("跟随 Coding Agent 启动") has to work before anyone
// opens the panel, so it cannot be hosted by panel-host — that would require a
// human to open the panel once per login just to get the relay started. This
// process breaks that bootstrap deadlock: it is registered as the
// "AnyswitchWatchdog" scheduled task (see
// autostart.mjs), so Windows starts it at login, and the agent-watcher poll
// inside it revives the relay with nobody at the panel. The relay itself stays
// lazily started: nothing runs on 47821 until a coding agent appears.
//
// Single-instance guard: binds loopback port 47822 as a marker. EADDRINUSE
// means another watchdog is already alive → exit quietly (same pattern as
// relay-host on 47821 and panel-host on 47820). The listening socket also
// holds the event loop open; the watcher's own poll timer is unref'd.

import { createServer } from "node:http";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync, readFileSync, unlinkSync, realpathSync, appendFileSync, mkdirSync, openSync, closeSync, statSync, renameSync } from "node:fs";
import { createAgentWatcher } from "./agent-watcher.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";
import { startRelay, restartRelay, getRelayStatus, findPortOwnerPid, isPidAlive, getProcessCommandLineAsync, isOwnProcess } from "../relay/relay-process-manager.mjs";
import { loadSettings, defaultSettingsPath, relayDataRoot, createLoggingEnabledGate } from "../relay/relay-settings.mjs";
import { createLogger, formatLogStamp, createPanelForwardingLogger } from "../shared/logger.mjs";

export const WATCHDOG_PORT = 47822;
// 看门狗那份收集器的进程扫描缓存窗口，必须宽于 agent-watcher 的巡检拍节
// （3000ms）：否则每拍都过一次期，等于常驻一路 CIM 全行 dump。上限钉在 10s——
// 再宽就开始拖慢「发现 agent 起来了要把 relay 拉起来」那件事。
export const WATCHDOG_PROCESS_SCAN_TTL_MS = 6000;
const WATCHDOG_SCRIPT = fileURLToPath(new URL("agent-watchdog.mjs", import.meta.url));

const SPAWN_POLL_MS = 300;
const SPAWN_TIMEOUT_MS = 8000;
const STOP_POLL_MS = 300;
const STOP_TIMEOUT_MS = 6000;

// ---------------------------------------------------------------------------
// 看门狗日志面（A1 整改）
//
// 历史根因：spawnWatchdog 用 stdio:"ignore" 拉起子进程，开机自启路径（计划任务 /
// Run 项）的 stderr 同样无人接收，于是 followAgent 自愈家族（谁在重启、第几次、
// 什么原因）面板与磁盘都看不到。现在双通道：
//   1. 落盘 logs/watchdog.log——与 relay-host.log 同目录同 [ts] [level] 封套，
//      进程内 logger sink 直写，不依赖任何父进程重定向；
//   2. 转发面板 ingest（47820）——行进面板「运行日志」总线，best-effort。
// spawnWatchdog 另把子进程 stdout/stderr 接进同一文件（fd 转发），兜住模块加载
// 崩溃、原生 abort 这类「日志系统还没来得及活」的输出；logger 行走的收口过的
// 行，裸子进程噪音不上总线。
// ---------------------------------------------------------------------------
// 与 relay-host 的 logs/relay-host.log 同目录、同款 join 惯写法（不走
// import.meta.url 自指——module-graph 守卫要求自指 URL 在盘，而 logs/
// 是运行时产物，仓库里不该存在）。
const WATCHDOG_LOG_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../logs", "watchdog.log");
const WATCHDOG_LOG_ROTATE_THRESHOLD_BYTES = 5 * 1024 * 1024;

// relay-host.mjs rotateLogIfNeeded 的看门狗份（启动时轮替一次，运行中不动——
// 进程持有追加写，Windows 上 rename 会失败）。不复用原函数：import relay-host
// 会把整个 relay 模块图拖进这个常驻小进程。
function rotateWatchdogLogIfNeeded(logPath) {
  let size;
  try {
    size = statSync(logPath).size;
  } catch {
    return;
  }
  if (size <= WATCHDOG_LOG_ROTATE_THRESHOLD_BYTES) return;
  try {
    // Windows 上 rename 不覆盖既有目标：先摘旧 .old，与 relay-host 同款顺序。
    if (existsSync(`${logPath}.old`)) unlinkSync(`${logPath}.old`);
  } catch {
    /* 旧 .old 被占用就让下面的 rename 把它暴露出来 */
  }
  try {
    renameSync(logPath, `${logPath}.old`);
  } catch {
    /* rotation must never block watchdog startup */
  }
}

// 崩溃留痕：同步直写、不受运行日志开关影响（与 relay-host 的 appendCrashLog
// 同口径——关掉记录的人正是事后要问「进程为什么死了」的人）。
function appendWatchdogCrashLog(logPath, label, detail) {
  try {
    appendFileSync(logPath, `[${formatLogStamp(Date.now())}] [${label}] ${detail?.stack ?? detail}\n`, "utf8");
  } catch {
    /* log file may be unwritable; the process is exiting anyway */
  }
}

// 看门狗默认 logger：createLogger 封套 + 文件 sink 落盘，每行同时转发面板
// ingest。sink 只写文件不写 stderr——spawnWatchdog 已把 stderr 接进同一个文件，
// 再写一遍就是双行。isEnabled 是「记录运行日志」开关的活闸门（relay-host 同款），
// 关掉时落盘与转发一起停。
export function createWatchdogLogger({ logPath = WATCHDOG_LOG_PATH, isEnabled, fetchFn } = {}) {
  rotateWatchdogLogIfNeeded(logPath);
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    /* the sink retries per line and drops silently if the dir stays missing */
  }
  const file = createLogger({
    ...(isEnabled ? { isEnabled } : {}),
    sink: (line) => {
      try {
        appendFileSync(logPath, line, "utf8");
      } catch {
        /* 日志文件不可写不得拖垮看门狗 */
      }
    },
  });
  const panel = createPanelForwardingLogger(fetchFn ? { fetchFn } : {});
  const write = (level) => (message) => {
    file[level](message);
    if (file.isEnabled()) panel[level](message);
  };
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

// ---------------------------------------------------------------------------
// PID bookkeeping (mirrors relay-process-manager's relay.pid handling).
// ---------------------------------------------------------------------------

export function getWatchdogPidPath(root) {
  return join(root, "watchdog.pid");
}

function writeWatchdogPid(pid, pidPath) {
  try {
    writeFileSync(pidPath, String(pid), "utf8");
  } catch {
    /* best-effort; a missing pid file just means we can't stop by PID */
  }
}

export function readWatchdogPid(pidPath) {
  try {
    if (!existsSync(pidPath)) return null;
    const text = readFileSync(pidPath, "utf8").trim();
    const pid = Number.parseInt(text, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearWatchdogPid(pidPath) {
  try {
    if (existsSync(pidPath)) unlinkSync(pidPath);
  } catch {
    /* already gone or locked */
  }
}

// ---------------------------------------------------------------------------
// Liveness / lifecycle (usable from any process — panel-host migration,
// panel.mjs settings coordination).
// ---------------------------------------------------------------------------

// Liveness + identity probe: the marker port must answer a JSON body with
// watchdog === true (listenMarkerPort's response), not just any 200 — a
// foreign loopback service on 47822 must not count as a live watchdog.
export function probeWatchdog(port = WATCHDOG_PORT) {
  return new Promise((resolve) => {
    const req = request(`http://127.0.0.1:${port}/`, { method: "GET", timeout: 1500 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(false);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body)?.watchdog === true);
        } catch {
          resolve(false);
        }
      });
      res.on("error", () => resolve(false));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export async function spawnWatchdog(env = process.env, options = {}) {
  const probe = options.probe ?? (() => probeWatchdog());
  if (await probe()) return { ok: true, reused: true };

  const root = relayDataRoot(env);
  clearWatchdogPid(getWatchdogPidPath(root));
  // stdio 不再是裸 "ignore"：子进程的 stdout/stderr 经 fd 转发进
  // logs/watchdog.log（terminal host 的 openChildLog 同款），兜住模块加载崩溃、
  // 原生 abort 这类发生在 logger 存活之前的输出。文件打不开就退回 "ignore"——
  // 日志缺失不该挡住拉起。
  const logPath = options.logPath ?? WATCHDOG_LOG_PATH;
  let logFd = null;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    logFd = openSync(logPath, "a");
  } catch {
    logFd = null;
  }
  const spawnFn = options.spawnFn ?? spawn;
  let child;
  try {
    child = spawnFn(process.execPath, [WATCHDOG_SCRIPT], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      detached: true,
      stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
      windowsHide: true,
      env,
    });
  } finally {
    // fd 已随 spawn 过继给子进程；父进程这份留着只会漏句柄、顶住日志轮替。
    if (logFd !== null) {
      try { closeSync(logFd); } catch { /* already closed — the child owns its copy either way */ }
    }
  }
  child.unref();
  if (child.pid) writeWatchdogPid(child.pid, getWatchdogPidPath(root));

  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe()) return { ok: true, reused: false };
    await new Promise((r) => setTimeout(r, SPAWN_POLL_MS));
  }
  return { ok: false, reused: false };
}

function terminatePid(pid) {
  if (!pid || pid <= 0) return;
  try {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch {
    /* process may already be gone */
  }
}

export async function stopWatchdog(env = process.env, deps = {}) {
  // Kill path: UNCACHED port-owner lookup (same rule as stopRelay) — the kill
  // gate must see the fresh owner PID, never a cached one.
  const findOwner = deps.findPortOwnerPid ?? findPortOwnerPid.uncached;
  const isAlive = deps.isPidAlive ?? isPidAlive;
  // Async by default so a fallback query never blocks the event loop; injected
  // sync doubles keep working because awaiting a non-promise is a no-op.
  const getCommandLine = deps.getProcessCommandLine ?? getProcessCommandLineAsync;
  const kill = deps.terminatePid ?? terminatePid;
  const probe = deps.probe ?? (() => probeWatchdog());
  const delay = deps.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = deps.stopPollMs ?? STOP_POLL_MS;
  const timeoutMs = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;

  const root = relayDataRoot(env);
  const pidPath = getWatchdogPidPath(root);
  const filePid = readWatchdogPid(pidPath);
  // Same safety red line as relay-process-manager.stopRelay: kill at most
  // these two specific PIDs (pid file + marker-port owner), never a global
  // node.exe sweep — and only after each PID's command line positively
  // identifies it as an Anyswitch app process.
  const ownerPid = await findOwner(WATCHDOG_PORT);

  const refused = [];
  for (const pid of new Set([filePid, ownerPid].filter((p) => Number.isFinite(p) && p > 0))) {
    if (!isAlive(pid)) continue; // dead PID: taskkill would no-op, not a refusal
    if (!isOwnProcess(await getCommandLine(pid))) {
      refused.push(pid);
      continue;
    }
    kill(pid);
  }

  const deadline = Date.now() + timeoutMs;
  let down = false;
  while (Date.now() < deadline) {
    if (!(await probe())) {
      down = true;
      break;
    }
    await delay(pollMs);
  }
  if (down) clearWatchdogPid(pidPath);
  if (refused.length > 0) {
    return {
      ok: false,
      reason: `refused to kill PID ${refused.join(", ")}: command line does not identify it as an Anyswitch app process`,
    };
  }
  return { ok: down };
}

// ---------------------------------------------------------------------------
// Entry-point host: marker port + real-deps agent watcher.
// ---------------------------------------------------------------------------

function listenMarkerPort(port = WATCHDOG_PORT) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, watchdog: true }));
    });
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") resolve({ reused: true, close: async () => {} });
      else reject(err);
    });
    server.listen(port, "127.0.0.1", () => {
      resolve({ reused: false, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

export async function startWatchdogHost(options = {}) {
  const logger = options.logger ?? createWatchdogLogger({
    ...(options.logPath ? { logPath: options.logPath } : {}),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    isEnabled: createLoggingEnabledGate(defaultSettingsPath(options.base ?? process.env)),
  });
  const { reused, close } = await listenMarkerPort(options.port ?? WATCHDOG_PORT);
  if (reused) {
    // Another watchdog owns the marker port; the HKCU Run entry starting a
    // second copy simply succeeds as a no-op, same as relay-host on 47821.
    return { reused: true, close };
  }
  logger.info(`Anyswitch follow-agent watchdog alive on 127.0.0.1:${WATCHDOG_PORT}`);

  const root = relayDataRoot(options.base ?? process.env);
  // 认领标记端口之后立刻写下自己的 pid。这条路径正是开机自启（计划任务 / Run 项）
  // 走的，而写 pid 原本只发生在 spawnWatchdog 里，于是开机起的那个 watchdog 从来
  // 没写过 pid 文件——磁盘上一直留着一个早已死掉的 pid，stopWatchdog 的 pid 候选
  // 因此长期是错的（靠标记端口属主兜住才没出事）。谁在服务，pid 文件就该是谁。
  const pidPath = getWatchdogPidPath(root);
  writeWatchdogPid(process.pid, pidPath);

  // 看门狗用的扫描缓存窗口：宽于 watcher 的 3s 拍节，让它不再每拍都踢一次常驻
  // CIM 行 dump。代价是「发现 agent 起来了 → 拉起 relay」的延迟从 ≤3s 变成 ≤本值，
  // 只影响 relay 已经不在的那个分支；换来的是常驻并发少一路，即探针超时那条链
  // 少一份燃料（判罚与代价见 agent-metrics.mjs 的 createPersistentPsProbe 上方）。
  // createMetricsCollector 只为测试存在：用例借它捕获真实入参、验证上面这个
  // 常量确实接进自建收集器，且 watcher 的 scanProcesses 喂的就是这个收集器。
  // 生产路径不传它，走 createAgentMetricsCollector，行为与副作用顺序不变。
  const createCollector = options.createMetricsCollector ?? createAgentMetricsCollector;
  const metricsCollector = options.metricsCollector ?? createCollector({
    processScanTtlMs: WATCHDOG_PROCESS_SCAN_TTL_MS,
    // 收集器内部的旁路告警（ps 探针楔住、DSH 孤进程收割等）也走看门狗 logger：
    // 落盘 + 上面板总线，不再只往无人接收的 stderr 写。
    logger,
  });
  // watcherDeps exists so tests can observe the follow-agent path without real
  // process/port side effects; production passes nothing and gets the real deps.
  const deps = options.watcherDeps ?? {};
  createAgentWatcher({
    root,
    scanProcesses: deps.scanProcesses ?? (() => metricsCollector.scanProcesses()),
    startRelay: deps.startRelay ?? (() => startRelay(root)),
    // 服务异常走重启（先停后起），不是再拉一个：端口被自己占着时「启动」是空操作。
    restartRelay: deps.restartRelay ?? (() => restartRelay(root)),
    getRelayStatus: deps.getRelayStatus ?? (() => getRelayStatus(root)),
    // The watcher passes the data ROOT directory, not a file path — forwarding
    // it made readFileSync fail on a directory and the tick saw empty settings
    // every poll (followAgent silently dead). Resolve the real settings file.
    loadSettings: deps.loadSettings ?? (() => loadSettings(defaultSettingsPath(options.base ?? process.env))),
    intervalMs: options.watcherIntervalMs,
    logger,
  }).start();

  const shutdown = async (signal) => {
    logger.info(`${signal} received, watchdog exiting`);
    clearWatchdogPid(pidPath);
    try {
      await close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // Windows 上 SIGTERM 未必送达（任务结束 / 注销），exit 兜住另一条路。
  process.on("exit", () => clearWatchdogPid(pidPath));

  return { reused: false, close };
}

function isEntryModule(argv1, metaUrl) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  const norm = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  try {
    return norm(metaUrl) === norm(argv1);
  } catch {
    return false;
  }
}

if (isEntryModule(process.argv[1], fileURLToPath(import.meta.url))) {
  // 崩溃留痕装在入口守卫而不是 startWatchdogHost：装配测试反复起宿主，钩子
  // 挂在宿主里会随测试进程累积。开机自启路径的 stderr 无人接收，这份文件是
  // 进程为什么死的唯一证据；与 relay-host 同口径——同步错误退出，悬置
  // rejection 只记不死。
  try {
    mkdirSync(dirname(WATCHDOG_LOG_PATH), { recursive: true });
  } catch {
    /* appendWatchdogCrashLog 自己再兜一次 */
  }
  process.on("uncaughtException", (err) => {
    appendWatchdogCrashLog(WATCHDOG_LOG_PATH, "uncaughtException", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    appendWatchdogCrashLog(WATCHDOG_LOG_PATH, "unhandledRejection", reason);
  });
  startWatchdogHost().then(
    () => {
      // keep alive; marker-port listen() holds the event loop open
    },
    (error) => {
      appendWatchdogCrashLog(WATCHDOG_LOG_PATH, "watchdog failed", error);
      process.stderr.write(`watchdog failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
