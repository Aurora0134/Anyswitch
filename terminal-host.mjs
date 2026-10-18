// Persistent loopback terminal host.
//
// The panel is a disposable browser client. PTYs live in this separate
// process so a panel reload/restart only drops the browser stream, not the
// shell or CLI process behind it.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import * as pty from "node-pty";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { createScreenMirror } from "./terminal-screen.mjs";
import { TERMINAL_PARENT_PID_ENV } from "./terminal-process-manager.mjs";
import { probePidLiveness } from "./relay-process-manager.mjs";
import { formatLogStamp } from "./logger.mjs";

export const TERMINAL_HOST_PORT = 47823;
export const PARENT_WATCHDOG_INTERVAL_MS = 5000;
// The watchdog is the backstop for the relay's hard-exit paths only (a graceful
// relay stop kills this child first), so firing late costs nothing while firing
// wrongly kills a healthy host — and a wrongly killed host takes the whole
// terminal service down with it, silently and without coming back. Death
// therefore has to be a POSITIVE finding (see probePidLiveness): only "dead"
// counts, and onDead additionally requires this many consecutive dead
// verdicts, any live reading resetting the count.
export const WATCHDOG_MISSES_REQUIRED = 5;
export const TERMINAL_STATE_FILE = "terminal-sessions.json";
const APP_DIR = fileURLToPath(new URL(".", import.meta.url));
// Raw output window, budgeted in bytes rather than chunk counts. Chunks are dropped
// whole from the head so no escape sequence is ever cut in half.
//
// This is NOT what a client replays with any more — see terminal-screen.mjs. A
// full-screen TUI's byte stream is a run of relative repaints, so a head-truncated
// slice of it repaints the wrong rows (measured on a live kimi session: 512KB, 1400
// frames, 0 scrolls, ~20 blank rows below the frame). The replay now comes from the
// session's rendered mirror. The raw window stays because it is what survives in the
// state file, and the mirror is rebuilt from it after a host restart — that restart
// path inherits the trim, which is why the durable format is the next thing to move
// to rendered lines.
const TERMINAL_BUFFER_MAX_BYTES = 512 * 1024;
const TERMINAL_BUFFER_MAX_CHUNKS = 4000;
// The state file is rewritten whole on a 250ms debounce, so the durable tail is
// budgeted tighter than the live one: enough to repaint after a host restart
// without turning every debounce tick into a half-megabyte write.
const TERMINAL_BUFFER_PERSIST_MAX_BYTES = 128 * 1024;
// SSE data 帧合帧的冲刷阈值：单连接待发缓冲累计超过这个字节数立即冲，不等窗口
// 定时器。窗口是给「TUI 把一帧拆成好几个小块」省帧数用的，不是给一次粘贴一大
// 屏白添延迟用的——大块输出攒在缓冲里只会推迟它到达浏览器的时间。
const SSE_PENDING_FLUSH_BYTES = 32 * 1024;

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function readBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > maxBytes) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error("invalid json"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function safeCwd(cwd) {
  if (typeof cwd !== "string" || cwd.trim() === "") return process.cwd();
  const value = cwd.trim();
  return existsSync(value) ? value : process.cwd();
}

function shellSpec(shell) {
  if (shell === "cmd") return { file: process.env.ComSpec || "cmd.exe", args: [], name: "命令提示符" };
  return {
    file: join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile"],
    name: "PowerShell",
  };
}

// One-click CLI Agent launches arrive as an optional `launch` (what to spawn —
// the cmd /c wrapper around the agent executable, see agent-session-env.mjs)
// plus an optional `env` delta (Anyswitch credentials, environment variables
// only). Both are validated here so a malformed body can never reach spawn:
// the launch file must be an absolute path, args a flat string array, and the
// env a flat string→string map — with null meaning "delete this key from the
// inherited environment" (how upstream real keys are kept out of the PTY).
// The env is NEVER persisted or echoed back: it lives in memory for the
// session's lifetime only.
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_ENTRIES = 512;
const MAX_ENV_VALUE_BYTES = 32_000;
const MAX_ENV_TOTAL_BYTES = 256 * 1024;
const MAX_LAUNCH_ARG_BYTES = 4096;
const MAX_LAUNCH_ARGS = 64;

function badRequest(error) {
  return Object.assign(new Error(error), { statusCode: 400 });
}

function normalizeLaunch(launch) {
  if (launch === undefined || launch === null) return null;
  if (typeof launch !== "object" || Array.isArray(launch)) throw badRequest("invalid_launch");
  const file = launch.file;
  if (typeof file !== "string" || !isAbsolute(file) || file.length > MAX_LAUNCH_ARG_BYTES) throw badRequest("invalid_launch");
  if (!Array.isArray(launch.args) || launch.args.length > MAX_LAUNCH_ARGS) throw badRequest("invalid_launch");
  const args = launch.args.map((arg) => {
    if (typeof arg !== "string" || arg.length > MAX_LAUNCH_ARG_BYTES) throw badRequest("invalid_launch");
    return arg;
  });
  return { file, args };
}

function normalizeInjectedEnv(env) {
  if (env === undefined || env === null) return null;
  if (typeof env !== "object" || Array.isArray(env)) throw badRequest("invalid_env");
  const out = {};
  let total = 0;
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_PATTERN.test(key)) throw badRequest("invalid_env");
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (typeof value !== "string" || value.length > MAX_ENV_VALUE_BYTES) throw badRequest("invalid_env");
    total += key.length + value.length;
    if (total > MAX_ENV_TOTAL_BYTES) throw badRequest("invalid_env");
    out[key] = value;
  }
  if (Object.keys(out).length > MAX_ENV_ENTRIES) throw badRequest("invalid_env");
  return out;
}

// Merge an injected env delta over a base environment: a string value
// overrides the inherited one (injected values must win), null deletes the key
// from the inherited environment.
function mergeInjectedEnv(base, injected) {
  const env = { ...base };
  for (const [key, value] of Object.entries(injected ?? {})) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

// Request-response probe sequences PTY programs send to interrogate the
// terminal (device attributes, mode/status reports, DECRQSS/XTGETTCAP
// payloads, kitty keyboard negotiation). Replaying them into xterm makes it
// auto-answer again and the answers land in the PTY as stray visible input.
// Only complete query forms match; the answer bytes (ESC[?1;2c, ESC[?1049;2$y,
// ESC[row;colR, ...) and any partial tail never match, so plain drawing,
// colors and text pass through untouched.
const REPLY_PROBE_PATTERN = new RegExp([
  String.raw`\x1b\[0?c`, // DA1: ESC[c / ESC[0c
  String.raw`\x1b\[>0?c`, // DA2: ESC[>c / ESC[>0c
  String.raw`\x1b\[=0?c`, // DA3: ESC[=c
  String.raw`\x1b\[\?\d+(?:;\d+)*\$p`, // DECRQM private: ESC[?N$p
  String.raw`\x1b\[\d+(?:;\d+)*\$p`, // DECRQM ANSI: ESC[N$p
  String.raw`\x1b\[(?:5|6)n`, // DSR / cursor position report: ESC[5n / ESC[6n
  String.raw`\x1b\[\?\d+n`, // private DSR: ESC[?Nn (DECDSR answers carry params, kept)
  String.raw`\x1bP\$q[^\x1b\x07]*(?:\x1b\\|\x07)`, // DECRQSS: DCS $q ... ST
  String.raw`\x1bP\+q[^\x1b\x07]*(?:\x1b\\|\x07)`, // XTGETTCAP: DCS +q ... ST
  String.raw`\x1b\[\?u`, // kitty keyboard query: ESC[?u
  String.raw`\x1b\[>\d+(?:;\d+)*u`, // kitty keyboard flag push: ESC[>Nu
].join("|"), "g");

export function stripTerminalReplyProbes(text) {
  if (!text) return "";
  return String(text).replace(REPLY_PROBE_PATTERN, "");
}

// Byte accounting for the replay ring is in UTF-8 bytes — the unit the budget is
// stated in and the unit the state file costs on disk.
function chunkBytes(chunk) {
  return Buffer.byteLength(chunk);
}

// Drop whole chunks from the head until the window fits both budgets. The newest
// chunk always survives: a single repaint over budget is a session that replays
// nothing at all if it gets dropped too.
function trimReplayBuffer(session, maxBytes, maxChunks) {
  const buffer = session.buffer;
  while (buffer.length > 1 && (buffer.length > maxChunks || session.bufferBytes > maxBytes)) {
    session.bufferBytes -= chunkBytes(buffer.shift());
  }
}

// Tail slice for the state file: walk back from the newest chunk while the
// running total fits the durable budget. The newest chunk is kept unconditionally
// (same rule as the live window) — a single repaint over budget must still come
// back as a painted screen after a host restart, not as a blank terminal.
function persistedBufferTail(buffer) {
  if (buffer.length === 0) return [];
  let bytes = chunkBytes(buffer[buffer.length - 1]);
  let start = buffer.length - 1;
  while (start > 0) {
    const size = chunkBytes(buffer[start - 1]);
    if (bytes + size > TERMINAL_BUFFER_PERSIST_MAX_BYTES) break;
    bytes += size;
    start -= 1;
  }
  return buffer.slice(start);
}

// Non-secret session metadata for agent-launched sessions: what runs here and
// how it was started. The env delta is deliberately absent — credentials stay
// in memory, never in a snapshot, never on disk.
function agentMetadata(session) {
  return {
    ...(session.agentId ? { agentId: session.agentId } : {}),
    ...(session.agentName ? { agentName: session.agentName } : {}),
    ...(session.launch ? { launch: session.launch } : {}),
  };
}

// Session metadata shape for the API. The replay buffer is deliberately absent:
// the list route is the panel's 1s poll, and carrying the window there would put
// it on the wire every tick (the panel strips it before the browser sees it — an
// old host sending it is still handled). Callers that want the window read one
// session directly, or attach to the SSE stream that repaints a terminal.
function snapshot(session) {
  return {
    id: session.id,
    label: session.label,
    cwd: session.cwd,
    shell: session.shell,
    pid: session.pid,
    status: session.pty ? "running" : "exited",
    exitCode: session.exitCode,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    cols: session.cols,
    rows: session.rows,
    ...agentMetadata(session),
  };
}

// ---------------------------------------------------------------------------
// 状态文件的异步原子替换。
//
// 仓库现成的 atomic-write.mjs 是同步纪律：writeFileSync + renameSync，rename 撞上
// 杀软/索引器还要用 Atomics.wait 同步睡眠重试——搬过来等于把「全量重写阻塞事件
// 循环」的病灶原样搬了个家。这里用 fs.promises 复刻同一套语义：兄弟临时文件 +
// 原子 rename、EPERM/EACCES 有界退避重试、失败清残留且绝不留半份目标文件；差别
// 只有睡眠换成不占事件循环的定时等待。重试参数与 atomic-write.mjs 保持一致。
const STATE_RENAME_RETRY_ATTEMPTS = 3;
const STATE_RENAME_RETRY_BASE_MS = 25;

const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 默认树杀实现：taskkill /T /F 整棵树连根拔。宿主拥有会话时就拥有「这棵树
// 该在哪天死」的决定权，关伪控制台只是给守规矩的进程一个优雅退出的机会，
// 解耦进程必须由宿主亲手终结。杀失败（进程刚好自己退了、权限不够）只记日志
// 不抛——关闭路径的语义是「尽力终结」，一个杀不动的进程不值得把 close 打成 500。
function defaultKillTree(pid) {
  return new Promise((resolve) => {
    execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, (error) => {
      if (error) console.warn?.(`[terminal-host] tree kill pid=${pid} failed: ${error.message}`);
      resolve();
    });
  });
}

async function renameWithRetry(temp, target) {
  let lastError;
  for (let attempt = 0; attempt <= STATE_RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      // 与 atomic-write.mjs 同判：只有 Windows 杀软/索引器短暂掐住目标文件造成的
      // EPERM/EACCES 值得重试，其余错误立即上抛。
      if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
      lastError = error;
      if (attempt < STATE_RENAME_RETRY_ATTEMPTS) await waitMs(STATE_RENAME_RETRY_BASE_MS * 2 ** attempt);
    }
  }
  throw lastError;
}

async function atomicWriteStateFile(target, content) {
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, "utf8");
    await renameWithRetry(temp, target);
  } catch (error) {
    try {
      await rm(temp, { force: true });
    } catch {
      // 尽力清理残留的临时文件；上抛的仍是原始错误。
    }
    throw error;
  }
}

export function createTerminalHost({
  root,
  port = TERMINAL_HOST_PORT,
  ptyModule = pty,
  spawnFn = spawn,
  logger = console,
  // SSE data 帧合帧窗口，毫秒：默认 16ms（约一帧渲染周期，肉眼无感又足以跨过
  // TUI 拆块输出的间隔）。测试可注入小值或 0；用 ?? 而非 || 默认值，0 是合法
  // 值（下一个宏任务即冲刷）。
  sseCoalesceWindowMs = 16,
  // 关闭路径的进程树终结（2026-10-16 幽灵 kimi 病灶的修法）。pty.kill 在
  // ConPTY DLL 模式下只销毁输入句柄＋关伪控制台，与控制台生命周期解耦的进程
  // （kimi 的 node 主进程）不会随它退——会话记录删了进程还活着，看板卡永远
  // 失去关闭入口。宿主是会话的拥有者，「进程死没死」不能外包给 node-pty 的
  // 内部行为：树杀直接对登记的 shell pid 动手，父子链不随控制台解耦而断。
  // 测试注入记录桩，不动真进程。
  killTreeFn = defaultKillTree,
  // 树杀前的误杀闸：pid 可被系统复用，「宁漏勿错」。复活判据复用 relay 的
  // 死活探针（原生 kill(0) + tasklist 交叉验证），测试注入布尔桩控制死活。
  isAliveFn = (pid) => probePidLiveness(pid) === "alive",
} = {}) {
  const dataRoot = root || join(process.env.LOCALAPPDATA || process.cwd(), "Anyswitch");
  mkdirSync(dataRoot, { recursive: true });
  const statePath = join(dataRoot, TERMINAL_STATE_FILE);
  const sessions = new Map();
  const token = loadOrGenerateToken(dataRoot);
  let persistTimer = null;
  const coalesceWindowMs = Math.max(0, sseCoalesceWindowMs);
  // 脏位与写链。脏位回答「内存态相对盘上那份变没变」；写链保证落盘写一笔接
  // 一笔串行、绝不交错。两者合起来把 persistNow 变成一个「有变化才做、做完
  // 一定写完整」的后台作业，事件循环全程不被同步写盘卡住。
  let stateDirty = false;
  let persistChain = Promise.resolve();

  function markStateDirty() {
    stateDirty = true;
  }

  // 立即落盘（相对 250ms 防抖而言）。改异步后调用方分三类：删除级路由
  // （close、clear-all）经 persistNowOrThrow 拿结果、写失败上抛 500（旧同步写
  // 失败就是路由 500，这条防线喂着 relay 的清场链路，见 persistNowOrThrow 的
  // 注释）；close() 与 create/restart/resize 路由只等完成（拿 200 后没有谁拿
  // 它去杀宿主，软失败保脏位等下一拍重试更好）；onExit 这类回调路径发后不
  // 管——链上写失败会被捕获、记日志并保持脏位，不会以未处理 rejection 的形式
  // 炸掉宿主。返回的 promise 恒 resolve：值是「等到链尾时最后一笔写是否成
  // 功」的布尔，跳过路径继承上一笔的结果。
  function persistNow() {
    // 脏位门控：上一笔成功落盘后内存没再变过的每个防抖拍（空闲会话的轮询、心
    // 跳、无变化 resize 都会走到这里）连 JSON.stringify 都不做，直接原样返回当
    // 前链。返回值恒为「含在途写」的链尾——跳过时它就是已落定的旧链，close()
    // 与 SIGINT/SIGTERM 路径 await 它就是等完最后一笔。
    if (!stateDirty) return persistChain;
    // 入队即清脏、写败再置回，且状态文本在链内执行时才取快照：落盘期间发生的
    // 变更要么赶在本笔快照之前被一并收编，要么在本笔写完之后仍处于置脏状态、
    // 由下一拍补写——两条路都不丢变更。若改成「写成功后才清脏」，写进行中置的
    // 脏就会被成功一笔顺手抹掉，那正是丢变更的写法。
    stateDirty = false;
    persistChain = persistChain.then(async () => {
      let persisted = false;
      try {
        await mkdir(dataRoot, { recursive: true });
        const state = [...sessions.values()].map((session) => ({
          id: session.id,
          label: session.label,
          cwd: session.cwd,
          shell: session.shell,
          pid: session.pid,
          createdAt: session.createdAt,
          lastActiveAt: session.lastActiveAt,
          cols: session.cols,
          rows: session.rows,
          buffer: persistedBufferTail(session.buffer),
          status: session.pty ? "running" : "exited",
          exitCode: session.exitCode,
          ...agentMetadata(session),
        }));
        await atomicWriteStateFile(statePath, JSON.stringify({ version: 1, sessions: state }, null, 2));
        persisted = true;
      } catch (error) {
        // 写失败保持脏位：下一拍重试。状态文件是内存态的可恢复快照而非事务日志，
        // 一次写失败不值得打断输出转发或把没有清场后果的路由打成 500——需要
        // 失败冒头的调用方走 persistNowOrThrow。
        stateDirty = true;
        logger.warn?.(`[terminal-host] state persist failed: ${error.message}`);
      }
      return persisted;
    });
    return persistChain;
  }

  // 删除级路由的落盘等待：失败必须以 500 拒答，不能答一个「盘上其实没清」的
  // 200。relay 的 stop({clearSessions}) 收到 200 就杀宿主子进程（它对非 2xx 才
  // 走 clearFailed → 宿主停稳后删除状态文件的兜底，见 relay-host.mjs 的
  // requestClearAllSessions），面板关页签同理拿 200 当凭据——写失败藏在 200
  // 里，已关的页签就会在下次宿主重启时从盘上复活。这恢复了旧同步写的防线：
  // writeFileSync 当年在这里抛出去，路由答的本来就是 500。
  async function persistNowOrThrow() {
    const persisted = await persistNow();
    if (!persisted) throw Object.assign(new Error("state_persist_failed"), { statusCode: 500 });
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, 250);
    persistTimer.unref?.();
  }

  function restore() {
    try {
      const raw = JSON.parse(readFileSync(statePath, "utf8"));
      for (const item of Array.isArray(raw?.sessions) ? raw.sessions : []) {
        const buffer = Array.isArray(item.buffer) ? item.buffer : [];
        const session = {
          ...item,
          pty: null,
          listeners: new Set(),
          buffer,
          bufferBytes: buffer.reduce((total, chunk) => total + chunkBytes(String(chunk)), 0),
          screen: createScreenMirror({ cols: item.cols || 120, rows: item.rows || 34 }),
        };
        // 上一代宿主留下的泄漏清扫：带一键启动标记的会话，其登记的 shell pid
        // 若还活着，就是「会话记录删了/宿主换了代、控制台解耦的 agent 没跟着
        // 退」的幽灵实证（2026-10-16 幽灵 kimi：会话早已不在任何面板，node 主
        // 进程 8756 挂着跑了 65 分钟）。杀树是恢复时的唯一兜底——本代的三条
        // 关闭路径已堵住复发，这里收的是历史遗留与宿主崩溃两类漏网。纯外壳
        // 会话（无 agentId）的面不同：控制台死亡时 shell 必随之死，不存在
        // 泄漏面，不碰。pid 已死的也不碰（pid 复用，宁漏勿错）。
        if (item.agentId && Number.isInteger(item.pid) && item.pid > 0 && isAliveFn(item.pid)) {
          killTreeFn(item.pid).catch((error) => {
            logger.warn?.(`[terminal-host] restore sweep pid=${item.pid} failed: ${error.message}`);
          });
        }
        // Rebuild the rendered picture from the durable tail. The tail is trimmed,
        // so a restored session repaints approximately — no worse than replaying
        // those same bytes raw, and it gets exact again on the next output chunk.
        for (const chunk of buffer) feedMirror(session, String(chunk));
        sessions.set(item.id, session);
      }
    } catch {
      // First start or a partially written state file: start empty.
    }
  }

  // The mirror renders what a client replays on connect. It is deliberately a
  // one-way passenger: a parser bug or a sequence we do not model must degrade to
  // "that chunk was not rendered", never to "output stopped forwarding".
  function feedMirror(session, text) {
    try {
      if (!session.screen) session.screen = createScreenMirror({ cols: session.cols, rows: session.rows });
      session.screen.write(text);
    } catch (error) {
      logger.warn?.(`[terminal-host] screen mirror skipped (${session.id}): ${error.message}`);
    }
  }

  function emit(session, chunk) {
    const text = String(chunk);
    session.buffer.push(text);
    session.bufferBytes += chunkBytes(text);
    trimReplayBuffer(session, TERMINAL_BUFFER_MAX_BYTES, TERMINAL_BUFFER_MAX_CHUNKS);
    feedMirror(session, text);
    session.lastActiveAt = Date.now();
    // 每个输出块都改写持久化状态（buffer 尾部与 lastActiveAt）：先置脏，250ms
    // 防抖到点的 persistNow 才是真的要写，而不是被脏位门控空跳掉。
    markStateDirty();
    for (const listener of session.listeners) listener(String(chunk));
    schedulePersist();
  }

  // 重开衔接卫生（回滚归页签的另一半）：旧进程死在备屏时，新进程的输出会被画
  // 进备屏、等应用退屏时整段丢掉——先弹回主画面；光标停在半行时补一个换行，
  // 防新进程首行拼进旧行尾。合成字节走 emit 单咽喉：镜像、在线 SSE 客户端、
  // 盘上回放三方同拍一致（入了 journal，宿主重启的 restore 重喂复现同一衔接）。
  function restartHygiene(session) {
    try {
      if (session.screen.info().inAlt) emit(session, "\u001b[?1049l");
      if (session.screen.info().col !== 0) emit(session, "\r\n");
    } catch (error) {
      // 卫生失败不拦重开：镜像解析面坏了时照常 respawn（feedMirror 同款容错）。
      logger.warn?.(`[terminal-host] restart hygiene skipped (${session.id}): ${error.message}`);
    }
  }

  function attach(session, child) {
    session.pty = child;
    session.pid = child.pid ?? session.pid;
    child.onData((data) => emit(session, data));
    child.onExit(({ exitCode }) => {
      session.exitCode = exitCode;
      session.pty = null;
      session.lastActiveAt = Date.now();
      // 退出改写的是落盘快照里的 exitCode/状态/lastActiveAt 三样：置脏后再触发
      // 立即写，退出码不能只活在内存里（宿主随后被杀时盘上还是 running）。
      markStateDirty();
      persistNow();
      for (const listener of session.listeners) listener(null);
    });
    // spawn 落定了 pid 与运行状态（新建与 restart 共用这条路径）：置脏。
    markStateDirty();
    persistNow();
  }

  // 终结一个会话的进程树：先 pty.kill 关伪控制台（守规矩的进程拿
  // CTRL_CLOSE 优雅退出），再对登记的 shell pid 树杀（控制台解耦的进程由这
  // 一步终结）。闸是「会话登记的 shell 还在」——pty 置空（onExit 已跑）或
  // pid 已死的会话不碰：pid 可被系统复用，那棵树已不归本会话管，宁漏勿错。
  async function terminateSessionTree(session) {
    if (!session?.pty || !Number.isInteger(session.pid) || session.pid <= 0) return;
    try {
      session.pty.kill();
    } catch {
      /* 已经死了的 pty 杀第二次不拦后面的树杀 */
    }
    const shellPid = session.pid;
    if (!isAliveFn(shellPid)) return;
    await killTreeFn(shellPid);
  }

  function spawnSession(session) {
    // An agent launch replaces the shell spec entirely (the cmd /c wrapper is
    // already in the launch args); a plain shell session behaves exactly as
    // before. The env delta is merged over this process's environment with
    // injected values winning, then the two terminal-identity variables are
    // pinned last so nothing inherited or injected can shadow them.
    const spec = session.launch ?? shellSpec(session.shell);
    const env = mergeInjectedEnv(process.env, session.env);
    env.TERM = "xterm-256color";
    env.ANYSWITCH_TERMINAL_SESSION = session.id;
    const child = ptyModule.spawn(spec.file, spec.args, {
      name: "xterm-256color",
      cols: session.cols,
      rows: session.rows,
      cwd: safeCwd(session.cwd),
      env,
      useConpty: true,
      useConptyDll: true,
      windowsHide: true,
    });
    attach(session, child);
  }

  function requireSession(id) {
    const session = sessions.get(id);
    if (!session) throw Object.assign(new Error("terminal session not found"), { statusCode: 404 });
    return session;
  }

  function authorized(req) {
    const value = req.headers.authorization || "";
    return value === `Bearer ${token}`;
  }

  function stream(session, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot(session))}\n\n`);
    // Replay comes from the rendered mirror: an absolutely positioned repaint plus
    // the rows that scrolled away, so it is correct regardless of where the raw
    // window's head fell and it restores a scrollable scrollback. The raw byte path
    // stays as the fallback for a session whose mirror was skipped (a parser fault,
    // a state file written before the mirror existed) — degraded, never dead.
    let rendered = "";
    try {
      rendered = session.screen && session.screen.info().consumedBytes > 0 ? session.screen.toReplay() : "";
    } catch (error) {
      logger.warn?.(`[terminal-host] rendered replay unavailable (${session.id}): ${error.message}`);
    }
    // Live chunks pass through verbatim; the raw replay is probe-stripped so a query
    // split between PTY writes is still recognized.
    const replay = rendered || stripTerminalReplyProbes(session.buffer.join(""));
    if (replay) res.write(`event: data\ndata: ${JSON.stringify(replay)}\n\n`);
    // data 帧合帧器，每个 SSE 连接独立一份：多连接共享同一会话，各攒各的缓冲、
    // 各冲各的定时器。PTY 输出在小时间尺度上是一串碎块（TUI 常把一帧拆成好几
    // 次 onData），逐块一帧等于把 N 次网络往返和 N 次 term.write 强加给一次重
    // 绘——这就是多开卡顿时 SSE 侧的病灶。攒进待发缓冲、窗口定时器到点合并成
    // 一个 data 帧转发；客户端本来就是 JSON.parse 后 term.write，拼接语义不变。
    // 边界：超 SSE_PENDING_FLUSH_BYTES 立即冲（大输出不陪窗口攒延迟）；exit 先
    // 冲净 pending 再发退出帧（最后一屏必须排在退出之前，帧序不能倒）；连接断
    // 开清定时器弃缓冲（人已走，送无可送）。回放帧、snapshot 帧、心跳注释帧都
    // 不经过这里——挂监听前的回放是既有直发路径，帧序保持不变。
    let pendingChunks = [];
    let pendingBytes = 0;
    let flushTimer = null;
    const writeDataFrame = (text) => res.write(`event: data\ndata: ${JSON.stringify(text)}\n\n`);
    const flushPending = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pendingChunks.length === 0) return;
      const merged = pendingChunks.join("");
      pendingChunks = [];
      pendingBytes = 0;
      writeDataFrame(merged);
    };
    const listener = (chunk) => {
      if (chunk === null) {
        flushPending();
        res.write("event: exit\ndata: {}\n\n");
        return;
      }
      const text = String(chunk);
      pendingChunks.push(text);
      pendingBytes += chunkBytes(text);
      if (pendingBytes > SSE_PENDING_FLUSH_BYTES) {
        flushPending();
        return;
      }
      if (!flushTimer) {
        flushTimer = setTimeout(flushPending, coalesceWindowMs);
        flushTimer.unref?.();
      }
    };
    session.listeners.add(listener);
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15000);
    const close = () => {
      clearInterval(heartbeat);
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pendingChunks = [];
      pendingBytes = 0;
      session.listeners.delete(listener);
    };
    res.on("close", close);
  }

  restore();

  const server = createServer(async (req, res) => {
    if (req.socket.remoteAddress !== "127.0.0.1" && req.socket.remoteAddress !== "::1" && req.socket.remoteAddress !== "::ffff:127.0.0.1") {
      return json(res, 403, { error: "loopback_only" });
    }
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      // 新建终端的默认工作目录：跟随当前用户主目录，谁的机器就是谁的，绝不回落
      // 到面板自己的安装目录（那会把 agent 的工作区写进软件本体）。
      if (url.pathname === "/terminal/default-cwd" && req.method === "GET") {
        return json(res, 200, { cwd: process.env.USERPROFILE || process.cwd() });
      }
      if (url.pathname === "/terminal/sessions" && req.method === "GET") {
        return json(res, 200, { sessions: [...sessions.values()].map(snapshot) });
      }
      if (url.pathname === "/terminal/sessions" && req.method === "POST") {
        const body = await readBody(req);
        const launch = normalizeLaunch(body.launch);
        const env = normalizeInjectedEnv(body.env);
        // An agent launch must not fall back to a silent default directory: a
        // wrong cwd would start the agent somewhere the user never chose.
        const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
        if (launch && (!cwd || !existsSync(cwd))) return json(res, 400, { error: "invalid_cwd" });
        const session = {
          id: randomUUID(),
          label: typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : "新终端",
          cwd: launch ? cwd : safeCwd(body.cwd),
          shell: body.shell === "cmd" ? "cmd" : "powershell",
          launch,
          env,
          agentId: typeof body.agentId === "string" && body.agentId.trim() ? body.agentId.trim().slice(0, 64) : null,
          agentName: typeof body.agentName === "string" && body.agentName.trim() ? body.agentName.trim().slice(0, 80) : null,
          pid: null,
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          cols: Math.max(2, Math.min(240, Number(body.cols) || 120)),
          rows: Math.max(1, Math.min(120, Number(body.rows) || 34)),
          exitCode: null,
          buffer: [],
          bufferBytes: 0,
          screen: createScreenMirror({ cols: Math.max(2, Math.min(240, Number(body.cols) || 120)), rows: Math.max(1, Math.min(120, Number(body.rows) || 34)) }),
          pty: null,
          listeners: new Set(),
        };
        sessions.set(session.id, session);
        // 会话入表即改写持久化状态：先置脏。即便随后的 spawn 失败，这个「存在
        // 过」的会话也该在关停冲刷时落上盘——与旧同步写的可观察行为一致。
        markStateDirty();
        spawnSession(session);
        // 旧实现 attach 里的同步写盘发生在 201 响应之前；异步化后路由等这笔写
        // 落定再答，响应到达即会话已在盘上（宿主紧跟着崩溃也不丢这条记录）。
        await persistNow();
        return json(res, 201, snapshot(session));
      }
      // 清空全部会话（relay 关停宿主前的清场）：杀掉存活 PTY、通知流端退出、
      // 内存表与落盘文件一起归零。必须在下面的按 id 匹配之前，否则 "clear-all"
      // 会被当成会话 id 走到 404。
      if (url.pathname === "/terminal/sessions/clear-all" && req.method === "POST") {
        let cleared = 0;
        for (const session of [...sessions.values()]) {
          // 清场同样走树杀：relay 收到 200 就杀宿主子进程，任何一个会话的控制台
          // 解耦进程漏网，relay 重启后它就成了一代新幽灵。
          await terminateSessionTree(session);
          for (const listener of session.listeners) listener(null);
          session.listeners.clear();
          sessions.delete(session.id);
          cleared += 1;
        }
        // 清场是删除级变化：置脏后这笔写必须真的把空表落上盘，并在响应前等它
        // 写完——relay 的 stop({clearSessions}) 收到 200 就杀宿主子进程，盘上
        // 残留旧会话会让下次启动凭空复活一排已关的页签。写失败走 500 拒答，
        // relay 才会转进「宿主停稳后删除状态文件」的兜底。
        markStateDirty();
        await persistNowOrThrow();
        return json(res, 200, { ok: true, cleared });
      }
      const match = url.pathname.match(/^\/terminal\/sessions\/([^/]+)(?:\/(input|resize|stream|restart|close))?$/);
      if (!match) return json(res, 404, { error: "not_found" });
      const session = requireSession(match[1]);
      const action = match[2];
      // One session read on demand: the replay window comes along with it. The
      // list route is the polled surface, and that one stays buffer-free.
      if (!action && req.method === "GET") return json(res, 200, { ...snapshot(session), buffer: session.buffer });
      if (action === "stream" && req.method === "GET") return stream(session, res);
      if (action === "input" && req.method === "POST") {
        const body = await readBody(req);
        if (typeof body.data !== "string" || body.data.length > 64 * 1024) return json(res, 400, { error: "invalid_input" });
        if (!session.pty) return json(res, 409, { error: "session_exited" });
        session.pty?.write(body.data);
        session.lastActiveAt = Date.now();
        return json(res, 200, { ok: true });
      }
      if (action === "resize" && req.method === "POST") {
        const body = await readBody(req);
        const cols = Math.max(2, Math.min(240, Number(body.cols) || session.cols));
        const rows = Math.max(1, Math.min(120, Number(body.rows) || session.rows));
        // 前端 fit 完成后无条件补发 resize（xterm 的 proposeDimensions 不去重），
        // 多开几个页签后这里每小时要吃几百次「尺寸其实没变」的请求，旧实现每一
        // 次都白走一遍 ConPTY 重排加整份状态文件重写。钳制后与当前尺寸一致且
        // PTY 还活着，就地短路：不重排、不动镜像、不落盘，回一个与全路径同形
        // 的 200。PTY 已退出的会话没有重排可省，照走完整路径（含 persistNow，
        // 由脏位门控决定是否真写）。
        if (session.pty && cols === session.cols && rows === session.rows) {
          return json(res, 200, { ok: true, cols, rows });
        }
        const sizeChanged = cols !== session.cols || rows !== session.rows;
        session.cols = cols;
        session.rows = rows;
        try {
          if (!session.screen) session.screen = createScreenMirror({ cols, rows });
          else session.screen.resize(cols, rows);
        } catch (error) {
          logger.warn?.(`[terminal-host] screen mirror resize skipped (${session.id}): ${error.message}`);
        }
        session.pty?.resize(cols, rows);
        // 有实际变化的 resize 才置脏：已退出会话收到的同尺寸 resize 走完整路径
        // 但没有任何状态变化，这笔 persistNow 在脏位门控下是纯空跳。
        if (sizeChanged) markStateDirty();
        await persistNow();
        return json(res, 200, { ok: true, cols, rows });
      }
      if (action === "restart" && req.method === "POST") {
        // Optional env re-injection: a caller that holds fresh credentials
        // (e.g. a relay restart) merges them in before the respawn. Merged,
        // never echoed — the response snapshot carries no env.
        const body = await readBody(req);
        if (body?.env !== undefined && body.env !== null) {
          session.env = mergeInjectedEnv(session.env ?? {}, normalizeInjectedEnv(body.env) ?? {});
        }
        // 重 spawn 前必须把旧树终结干净：控制台解耦的旧 agent（kimi）不会被
        // pty.kill 带走，不补树杀就会新旧两个 agent 同屏双开。
        await terminateSessionTree(session);
        session.exitCode = null;
        // 回滚历史归页签（2026-10-18 拍板：重启/清回滚不丢史）：重开只是换进程，
        // 字节窗与镜像原地保留、新进程输出续写在旧画面下方（与 VS Code 同屏重开
        // 终端同一语义）；宿主重启后恢复的深度以盘上尾窗预算为限（既有上限）。
        // 衔接卫生只在镜像存在时做；缺失则兜底新建（空镜像无需卫生）。
        if (!session.screen) session.screen = createScreenMirror({ cols: session.cols, rows: session.rows });
        else restartHygiene(session);
        spawnSession(session);
        // 与新建路由同款：等 spawn 引起的那笔写落定再答，响应语义与旧同步写一致。
        await persistNow();
        return json(res, 200, snapshot(session));
      }
      if (action === "close" && req.method === "POST") {
        await terminateSessionTree(session);
        sessions.delete(session.id);
        // 会话从内存表移除是删除级变化：置脏后等这笔写落定再答——响应到达时
        // 盘上已经没有这个会话（与旧同步写的外部时序契约一致）。写失败走 500
        // 拒答：面板拿 200 当「盘上已清」的凭据，假 200 会让已关页签在宿主下
        // 次重启时从盘上复活。
        markStateDirty();
        await persistNowOrThrow();
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: "method_not_allowed" });
    } catch (error) {
      logger.warn?.(`[terminal-host] ${error.message}`);
      return json(res, error.statusCode || 500, { error: error.message });
    }
  });

  return {
    server,
    port,
    token,
    statePath,
    sessions,
    // 异步化后「已落盘」不再随路由响应自动成立（onExit 这类回调路径是发后不管
    // 的），把这个等链入口暴露出来给测试做确定性等待：await 它即等完链上全部
    // 在途写（没脏时是纯空跳）。
    persistNow,
    close: async () => {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      // 关停冲刷：SIGINT/SIGTERM 的处理器在 close() 返回后立刻 process.exit(0)，
      // 不等完在途写，最后一批输出或清场结果就会被 exit 截胡成盘上的旧状态。
      // 但监听必须在没有 await 间隔的情况下立即停：undici 这类客户端在被断开的
      // 连接死后几毫秒内会补开一条空闲连接，监听先停，补连就被直接拒绝；若先
      // 等落盘再关监听，那条没有请求挂靠的连接会被 server.close() 当成在场
      // 连接等满一个客户端 keep-alive 周期（实测约 4 秒）。
      const flush = persistNow();
      for (const session of sessions.values()) session.listeners.clear();
      const closed = new Promise((resolve) => server.close(resolve));
      await flush;
      await closed;
    },
  };
}

export async function startTerminalHost(options = {}) {
  const host = createTerminalHost(options);
  await new Promise((resolve, reject) => {
    host.server.once("error", reject);
    host.server.listen(host.port, "127.0.0.1", resolve);
  });
  return host;
}

// Crash-evidence channel for the windowless host. The relay tees this
// process's stdout/stderr into logs/terminal-host.log (see
// createTerminalHostSupervisor's logPath), and these handlers append the two
// fatal-ish JS events synchronously so they survive even a follow-on abort:
// appendFileSync lands BEFORE anything else can go wrong, the stderr write is
// best-effort on top.
//
// Both handlers LOG AND CONTINUE — deliberately different from a generic
// "crash on uncaught" service:
//   * The reachable uncaught sources here are node-pty's per-socket error
//     rethrows (upstream microsoft/node-pty#960 / #942: a broken ConPTY pipe
//     becomes a thrown 'error' event). The socket in question is already dead;
//     the fault is session-scoped. Exiting would kill every OTHER healthy PTY
//     session to answer one dead pipe — that trade is exactly the outage this
//     handler exists to soften.
//   * unhandledRejection has never killed anything useful; Node's default
//     crash-on-rejection would turn a stray promise into a full terminal
//     service outage.
// The native abort class (0xC0000409, node-pty/microsoft#951) never reaches
// JS handlers at all — that evidence comes from the teed stderr, not here.
// Returns the handlers plus dispose() so tests can register/drive/remove them
// without racing the test runner's own process listeners.
export function installTerminalHostFaultHandlers({ logPath, write = (line) => process.stderr.write(line) } = {}) {
  const record = (label, detail) => {
    const line = `[${formatLogStamp(Date.now())}] [${label}] ${detail?.stack ?? detail}\n`;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line, "utf8");
    } catch {
      /* the log file may be unwritable; the stderr mirror below still runs */
    }
    try {
      write(line);
    } catch {
      /* a dead stderr must not take the crash handler down with it */
    }
  };
  const onUncaught = (error) => record("uncaughtException", error);
  const onUnhandled = (reason) => record("unhandledRejection", reason);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  return {
    onUncaught,
    onUnhandled,
    dispose() {
      process.removeListener("uncaughtException", onUncaught);
      process.removeListener("unhandledRejection", onUnhandled);
    },
  };
}

// Death pact with the owning relay: a non-detached Windows child does NOT die
// with its parent, and the pre-update history of this host (detached and
// ownerless, outliving every app update) is exactly the failure being closed
// out. While TERMINAL_PARENT_PID_ENV names a live relay, the relay's graceful
// shutdown kills this child first; this poller is the backstop for every path
// that doesn't (hard kill of the relay alone, fatal exit).
//
// The probe answers in three states, and only one of them is death. An
// inconclusive probe ("the probe failed") is transparent here: it neither
// counts toward the pact nor resets it. That is the difference between "the
// relay is gone" and "we could not tell this time", and reading the second as
// the first is how healthy hosts used to be killed by their own watchdog.
// onDead only fires after missesRequired consecutive CONFIRMED dead verdicts.
// Returns null when no valid parent pid was supplied, leaving manual/test runs
// untouched.
export function watchParentProcess({
  parentPid,
  probeLiveness = probePidLiveness,
  intervalMs = PARENT_WATCHDOG_INTERVAL_MS,
  missesRequired = WATCHDOG_MISSES_REQUIRED,
  setIntervalFn = setInterval,
  onDead,
}) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return null;
  let fired = false;
  let misses = 0;
  const timer = setIntervalFn(() => {
    if (fired) return;
    const verdict = probeLiveness(parentPid);
    if (verdict === "alive") {
      misses = 0;
      return;
    }
    if (verdict !== "dead") return;
    misses += 1;
    if (misses < missesRequired) return;
    fired = true;
    onDead?.();
  }, intervalMs);
  timer.unref?.();
  return timer;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase();
if (isMain) {
  installTerminalHostFaultHandlers({ logPath: join(APP_DIR, "logs", "terminal-host.log") });
  startTerminalHost().then((host) => {
    // Startup anchor for the tee'd log: every crash line after this one belongs
    // to this process incarnation.
    process.stderr.write(`[${formatLogStamp(Date.now())}] [info] terminal host listening on 127.0.0.1:${host.port} (pid ${process.pid})\n`);
    process.on("SIGINT", () => host.close().then(() => process.exit(0)));
    process.on("SIGTERM", () => host.close().then(() => process.exit(0)));
    // Relay-owned mode: the parent relay pid arrives via env; when the relay
    // is gone this host must follow. Without the env var (tests, single
    // runs) nothing changes.
    const parentPid = Number.parseInt(process.env[TERMINAL_PARENT_PID_ENV] ?? "", 10);
    watchParentProcess({
      parentPid,
      onDead: () => host.close().then(() => process.exit(0)),
    });
  }).catch((error) => {
    process.stderr.write(`[terminal-host] failed: ${error.stack || error}\n`);
    process.exit(1);
  });
}
