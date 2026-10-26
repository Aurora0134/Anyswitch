// Persistent loopback terminal host.
//
// The panel is a disposable browser client. PTYs live in this separate
// process so a panel reload/restart only drops the browser stream, not the
// shell or CLI process behind it.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, rmSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import * as pty from "node-pty";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { createScreenMirror } from "./terminal-screen.mjs";
import { TERMINAL_PARENT_PID_ENV } from "./terminal-process-manager.mjs";
import { probePidLiveness, getProcessCommandLineAsync } from "./relay-process-manager.mjs";
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
// 每会话一份记录文件的目录（与索引文件同目录）。索引只放成员 id 与主题，会话
// 正文——元数据 + 128KB 落盘尾部——在 <root>/terminal-sessions/<id>.json。
export const TERMINAL_SESSION_DIR = "terminal-sessions";
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
// The durable tail is budgeted tighter than the live one: enough to repaint after a
// host restart without making every debounce tick a half-megabyte write per session.
// It is the per-session record's budget now (see the persist section), so a session's
// cost on disk no longer depends on how many other sessions exist.
const TERMINAL_BUFFER_PERSIST_MAX_BYTES = 128 * 1024;
// SSE data 帧合帧的冲刷阈值：单连接待发缓冲累计超过这个字节数立即冲，不等窗口
// 定时器。窗口是给「TUI 把一帧拆成好几个小块」省帧数用的，不是给一次粘贴一大
// 屏白添延迟用的——大块输出攒在缓冲里只会推迟它到达浏览器的时间。
const SSE_PENDING_FLUSH_BYTES = 32 * 1024;
// 落盘防抖窗口：一个窗口内的多块输出合成一拍写。
const PERSIST_DEBOUNCE_MS = 250;
// 单拍最多写几份会话文件、最多写多少（**序列化后**）字节。防抖拍到的写是「有界
// 单拍」：N 个会话同时出字时一轮只写这么多，剩下的留在脏集合里下一拍继续——单拍
// 成本因此不随会话数增长。两个上限都要有：份数挡住「一堆小记录」，字节数挡住
// 「一份就几百 KB」的极端尾部（序列化字节，不是内存原始字节——ESC 密集内容落盘
// 会六倍膨胀，按内存字节算的预算不是代码能保证的量）。
// 单份超预算时仍然写（最新一块必留），所以真实上界是「≤份数上限，且除单份超预算
// 外 ≤字节上限」。代价是最坏情况下某条记录的落盘推迟 ⌈份数/上限⌉ 拍（250ms/拍），
// 积压上限是会话总数（不再是无界增长的 promise 链）。
// 显式等落定的路径不受这个上限约束：定向冲净（建会话/resize/重开/退出）只写那一条，
// 全量冲净（关停）必须写到没有欠账。
const PERSIST_SESSION_WRITES_PER_PASS = 4;
const PERSIST_PASS_MAX_BYTES = 512 * 1024;
// 全量冲净最多连跑几轮。它本来该一轮写完，多轮只用于收编「写期间新到的脏」；
// 上限防的是输出永不停止时的活锁。
const PERSIST_FULL_FLUSH_MAX_ROUNDS = 32;

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

// 恢复时的幽灵清扫闸：pid 可被系统复用，「活着」不等于「还是本会话那一代进程」。
// 只认命令行里出现本会话的启动执行体（launch 的可执行文件，没有 launch 时用
// shell 的执行体）。查不到命令行（进程刚好退了、权限不够）一律判「不是本会话」——
// 宁漏勿错：漏杀一个孤儿只是多一个进程，错杀别人的进程不可挽回。
function sessionCommandTokens(session) {
  const spec = session.launch ?? shellSpec(session.shell);
  const tokens = [spec.file, ...(spec.args ?? [])]
    .filter((token) => typeof token === "string" && token.length > 3)
    .filter((token) => /\.exe$/i.test(token.trim().replace(/^"|"$/g, "")) || /[\\/]/.test(token))
    .map((token) => basename(token.trim().replace(/^"|"$/g, "")).toLowerCase());
  return [...new Set(tokens)];
}

function commandLineOwnsSession(commandLine, session) {
  if (typeof commandLine !== "string" || commandLine.trim() === "") return false;
  const tokens = sessionCommandTokens(session);
  if (tokens.length === 0) return false;
  const haystack = commandLine.toLowerCase();
  // 全部命中才算本会话：agent 会话的清单里既有 cmd.exe 包装也有 agent 执行体，
  // 只认 cmd.exe 的话，pid 被复用给任何一条无关的 cmd 都会被误杀。
  return tokens.every((token) => haystack.includes(token));
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
  String.raw`\x1b\]11;\?(?:\x07|\x1b\\)`, // OSC 11 background query
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

// ---- Terminal interrogation: color scheme, background, device attributes ----
// A TUI asks the terminal two things before it can paint: "are you dark or
// light?" (kimi-code's "Auto (match terminal)") and "what is your background
// color?" (kimi-code and claude code both turn an incoming theme report into a
// fresh background query). xterm.js answers OSC 11 and DA1 on its own, but only
// for the session a browser column is attached to — a session in a background
// tab, or one that asks before its column attaches, waits forever. Every PTY
// byte passes through this host whatever is on screen, so the host answers and
// drops the query from the forwarded stream: exactly one answer must exist,
// because a second unmatched reply lands in the CLI as unhandled input.
//
//   CSI ? 996 n        -> CSI ? 997 ; 1 n / ; 2 n   dark / light report
//   CSI ? 2031 h | l   -> subscribe / unsubscribe  theme-change pushes (997)
//   OSC 11 ; ? BEL/ST  -> OSC 11 ; rgb:RRRR/GGGG/BBBB BEL
//   CSI c / CSI 0 c    -> CSI ? 1 ; 2 c            primary device attributes
//
// DA1 looks unrelated but is not: claude code parks its background query behind
// a DA1 sentinel and keeps a single in-flight guard, so one unanswered sentinel
// wedges its theme watcher for the rest of the process lifetime.
const THEME_QUERY = "\x1b[?996n";
const THEME_NOTIFY_ON = "\x1b[?2031h";
const THEME_NOTIFY_OFF = "\x1b[?2031l";
const THEME_BACKGROUND_QUERY = "\x1b]11;?";
const DA1_QUERY_ZERO = "\x1b[0c";
const DA1_QUERY = "\x1b[c";
const DA1_REPORT = "\x1b[?1;2c";
const themeReport = (dark) => `\x1b[?997;${dark ? 1 : 2}n`;
// 底色由面板上报（--terminal-bg 的现值）。未上报时按亮暗取兜底色：应答永远
// 存在，agent 不会因为宿主还没收到上报就卡在超时里。
const BACKGROUND_FALLBACK_DARK = "#0b1220";
const BACKGROUND_FALLBACK_LIGHT = "#f8fafc";
const BACKGROUND_HEX_PATTERN = /^#[0-9a-f]{6}$/;
function effectiveBackground(dark, background) {
  if (typeof background === "string" && BACKGROUND_HEX_PATTERN.test(background)) return background;
  return dark ? BACKGROUND_FALLBACK_DARK : BACKGROUND_FALLBACK_LIGHT;
}
function themeBackgroundReport(hex) {
  const channel = (start) => hex.slice(start, start + 2).repeat(2);
  return `\x1b]11;rgb:${channel(1)}/${channel(3)}/${channel(5)}\x07`;
}

// Stream-safe scanner: every form above is short and can straddle PTY chunks,
// so the scanner keeps a tail and only fires for queries completed by the newly
// pushed text. Bytes that merely begin like a query stay held until the next
// push resolves them; the hold is bounded by the longest form (9 bytes) and only
// ever covers control bytes nobody can see. Queries are removed from the
// returned text — the host is the only party allowed to answer them.
export function createTerminalQueryScanner() {
  const QUERY_FORMS = [
    { text: THEME_QUERY, probe: "theme" },
    { text: THEME_NOTIFY_ON, probe: "notifyOn" },
    { text: THEME_NOTIFY_OFF, probe: "notifyOff" },
    { text: DA1_QUERY_ZERO, probe: "deviceAttributes" },
    { text: DA1_QUERY, probe: "deviceAttributes" },
  ];
  const HOLD_MAX = 9;
  // 只在 ESC 处试探，其余字符一路跳过——大块输出（一次 resume 六七十 KB）里
  // 逐字符 slice 会退化成二次拷贝，这里必须按索引走。
  function matchAt(hay, index) {
    if (hay.startsWith(THEME_BACKGROUND_QUERY, index)) {
      const prefixLength = THEME_BACKGROUND_QUERY.length;
      const rest = hay.length - index;
      const after = index + prefixLength;
      if (rest <= prefixLength) return "pending";
      const terminator = hay[after];
      if (terminator === "\x07") return { length: prefixLength + 1, probe: "background" };
      if (terminator === "\x1b") {
        if (rest <= prefixLength + 1) return "pending";
        return hay[after + 1] === "\\" ? { length: prefixLength + 2, probe: "background" } : null;
      }
      return null;
    }
    for (const form of QUERY_FORMS) {
      if (hay.startsWith(form.text, index)) return { length: form.text.length, probe: form.probe };
    }
    return null;
  }
  function heldPrefixAt(hay, index) {
    if (hay.length - index >= HOLD_MAX) return false;
    const rest = hay.slice(index);
    if (THEME_BACKGROUND_QUERY.startsWith(rest)) return true;
    return QUERY_FORMS.some((form) => form.text.startsWith(rest));
  }
  let tail = "";
  return {
    push(text) {
      const hay = tail + String(text ?? "");
      const probes = [];
      let out = "";
      let copied = 0;
      let index = 0;
      const flushUntil = (end) => {
        if (end > copied) out += hay.slice(copied, end);
      };
      while (index < hay.length) {
        if (hay.charCodeAt(index) !== 0x1b) {
          index += 1;
          continue;
        }
        const match = matchAt(hay, index);
        if (match === "pending") {
          flushUntil(index);
          tail = hay.slice(index);
          return { text: out, probes };
        }
        if (match) {
          flushUntil(index);
          probes.push(match.probe);
          index += match.length;
          copied = index;
          continue;
        }
        if (heldPrefixAt(hay, index)) {
          flushUntil(index);
          tail = hay.slice(index);
          return { text: out, probes };
        }
        index += 1;
      }
      flushUntil(hay.length);
      tail = "";
      return { text: out, probes };
    },
  };
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
    // 续接身份（M7 S5）：这条终端是替哪条会话续接建的。只记 endpoint + 会话 id
    // 两个非密字段（file 是路径，去重聚焦用不到，不进记录）。面板历史会话点击时
    // 先查它——同 endpoint＋同会话 id 的终端已开着就直接聚焦，不重复建。
    ...(session.resume ? { resume: session.resume } : {}),
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
    // 工作态判定的两只输入信号（面板 terminalBusyByOutput 消费）：
    // lastInputAt＝最近一次用户键入（键入抑制窗的锚点，出生起未键入则缺省）；
    // spawnedAt＝最近一次进程出生（孵化豁免窗的锚点——内切/复活保记录换进程，
    // createdAt 不动，只有它跟着每次 spawn 走）。
    lastInputAt: session.lastInputAt,
    spawnedAt: session.spawnedAt,
    cols: session.cols,
    rows: session.rows,
    ...agentMetadata(session),
  };
}

// ---------------------------------------------------------------------------
// 落盘文件的异步原子替换（索引与每会话记录共用）。
//
// 仓库现成的 atomic-write.mjs 是同步纪律：writeFileSync + renameSync，rename 撞上
// 杀软/索引器还要用 Atomics.wait 同步睡眠重试——搬过来等于把「写盘阻塞事件
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

async function atomicWriteJsonFile(target, content) {
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

// 续接身份的宿主侧归一化：{ endpoint, id } 两个非空串，长度封顶（与面板
// buildAgentResumeArgs 同一基调——两端独立校验，坏数据进不了会话记录）。缺省/
// null = 普通创建（不带这个字段）；形状不对一律 400 invalid_resume，不建会话。
// file 之类多余字段直接忽略：宿主只认去重需要的两个键。
function normalizeResume(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "invalid_resume" };
  const endpoint = typeof raw.endpoint === "string" ? raw.endpoint.trim() : "";
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!endpoint || !id || endpoint.length > 64 || id.length > 256) return { error: "invalid_resume" };
  return { resume: { endpoint, id } };
}

// M12-A 内切身份同步三件：restart 路由的可选 body 字段。缺省/空串＝不更新（沿用
// 原值）；带了但形状不对一律拒（error 码与 create 路由的同款字段口径），不静默
// 忽略——换绑是显式动作，半途丢字段比报错更难查。resume 走 normalizeResume。
// clearResume（全新内切）：布尔，true＝把记录里的 resume 显式清空。缺省沿用
// 「不更新」语义；只有 true 一个有效取值，false 与缺省等价，非布尔拒换——没有
// 清除语义时内切成新会话会残留旧会话身份，去重聚焦与兜底行判定都会拿旧身份误判。
function normalizeIdentityUpdate(body) {
  const fields = {};
  const text = (key, max) => {
    const value = body?.[key];
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !value.trim() || value.trim().length > max) return { error: `invalid_${key}` };
    return value.trim();
  };
  const label = text("label", 80);
  if (label && label.error) return label;
  const agentId = text("agentId", 64);
  if (agentId && agentId.error) return agentId;
  const agentName = text("agentName", 80);
  if (agentName && agentName.error) return agentName;
  const resumeInput = normalizeResume(body?.resume);
  if (resumeInput && resumeInput.error) return { error: resumeInput.error };
  if (label) fields.label = label;
  if (agentId) fields.agentId = agentId;
  if (agentName) fields.agentName = agentName;
  if (resumeInput) fields.resume = resumeInput.resume;
  const clearResume = body?.clearResume;
  if (clearResume !== undefined && clearResume !== null) {
    if (typeof clearResume !== "boolean") return { error: "invalid_clearResume" };
    if (clearResume) fields.clearResume = true;
  }
  return { fields };
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
  // 恢复清扫的身份校验：只有命令行对得上本会话启动执行体的 pid 才允许树杀。
  // 查询失败（null）按「对不上」处理，测试注入固定字符串。
  getCommandLineFn = (pid) => getProcessCommandLineAsync(pid),
} = {}) {
  const dataRoot = root || join(process.env.LOCALAPPDATA || process.cwd(), "Anyswitch");
  mkdirSync(dataRoot, { recursive: true });
  const statePath = join(dataRoot, TERMINAL_STATE_FILE);
  const sessionStateDir = join(dataRoot, TERMINAL_SESSION_DIR);
  const sessions = new Map();
  const token = loadOrGenerateToken(dataRoot);
  let persistTimer = null;
  const coalesceWindowMs = Math.max(0, sseCoalesceWindowMs);
  // 终端当前亮暗与底色：996n / OSC 11 的即问即答、997 扇出都按这里的值走。
  // 面板 POST /terminal/theme 上报生效值；两者随状态文件落盘，宿主重启后接着
  // 用（面板首连/重连也会补报一次，两条路互为兜底）。底色为空表示还没上报过，
  // 应答时按亮暗取兜底色——见 effectiveBackground。
  let terminalThemeDark = true;
  let terminalThemeBackground = "";

  // ---------------------------------------------------------------------------
  // 落盘：一份索引 + 每会话一份记录
  //
  // 病灶：旧实现把「全部会话 + 每会话 128KB 尾部」序列化成一份 JSON，防抖每
  // 250ms 整份重写。单拍成本 O(N)——实测 N=2 12ms/301KB、N=8 27ms/1.2MB、
  // N=20 45ms/3.0MB——而且每个出字的会话都在替所有空闲会话付这笔钱（S3 报告
  // §2.1 是宿主侧唯一的 O(N) 热点）。
  //
  // 形态：索引（成员表 + 主题，几百字节）＋ 每会话一份记录文件
  // <root>/terminal-sessions/<id>.json（该会话的元数据 + 128KB 落盘尾部）。
  // 每个会话自己一位脏标：出字只重写它自己那份；索引只在成员或主题变化时重写。
  // 于是「一个会话在出字」的单拍成本与会话总数无关——这是本改造的全部目的。
  //
  // 为什么不选追加日志 + 周期压实：那要把「内存环裁尾」「最新一块必留」两条既有
  // 契约翻译成「日志前缀 + 压实点」，restore 得先重放再压实，等于把窗口语义写两
  // 遍；而本仓没有假时钟，压实时机只能靠真实节律观察，验收面反而更薄。每会话一
  // 份记录让落盘内容与内存态逐字段同构，restore 仍是「读回 → 重算字节位 → 同步
  // 重喂镜像」这条老路，老文件也能逐字段直接读回（见 restore 的 v1 分支）。
  //
  // 一致性：一份文件一个原子 rename。跨会话不再有「整份一致」的瞬间，换来的是每
  // 份文件各自完整——状态文件是可恢复快照而非事务日志，混合快照无害（每个会话的
  // 尾部仍是它自己那一代的完整切片）。顺序保证：会话文件先落、索引后落（索引里
  // 出现某个 id 就等于宣称那份文件已写过），删除先删文件再写索引，且处理删除的那
  // 一轮**无条件重写索引**——崩溃与并发下都只会留下「索引没点名」的孤儿文件，
  // restore 会清掉；反向的「索引点名、文件没了」在任何路径上都不会出现。索引是
  // 成员表的唯一权威：relay 的 clearSessions 兜底只 unlink 索引（relay-host.mjs
  // 里那份 TERMINAL_STATE_FILE 副本），正好落在「索引没了 = 会话全没」这条语义上。
  //
  // ⚠️ 格式换代是**单向**的：v1 → v2 就地升级，没有回退路径。v2 的索引里 sessions
  // 是 id 字符串数组，旧码读它会把字符串展开成 `{0:'x',…}`、id 为 undefined，恢复
  // 出一排无 id 的幽灵页签。所以「降级回旧版宿主」不是受支持的操作；要回退只能先
  // 删掉状态文件与 terminal-sessions/ 目录（会话页签全部丢失，用户手工重开）。
  let indexDirty = false;
  const dirtySessions = new Set();
  const removedSessionIds = new Set();
  // 「盘上还没有这份记录文件」的 id。它把「索引里出现某个 id 就等于宣称那份文件已
  // 落过盘」这条顺序保证钉成可判的闸：只有在集合空的时候才允许写索引。新建会话与
  // v1 恢复出来的会话会进这个集合，记录写成功后离开。
  const unpersistedIds = new Set();
  // 落盘观测：单拍写了几份、多少字节、多久，积压多深。slowPasses 是「单笔写超过
  // 防抖窗」的计数——旧实现里它就是 persistChain 无界积压的起点信号。
  const persistStats = {
    passes: 0,
    sessionWrites: 0,
    coalescedRequests: 0,
    slowPasses: 0,
    backlog: 0,
    maxBacklog: 0,
    lastPassMs: 0,
    maxPassMs: 0,
    lastPassSessionWrites: 0,
    maxPassSessionWrites: 0,
    lastPassBytes: 0,
  };

  // 会话 id 会直接进文件名，所以只认「安全文件名」形状的 id（randomUUID 的子集）。
  // 盘上的 id 是外部数据：一个被改坏的索引不该能把删除操作指到目录外去。
  const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

  function sessionStatePath(id) {
    return join(sessionStateDir, `${id}.json`);
  }

  // 会话级脏标：出字 / 退出 / resize / 重开都只改这一份记录。
  function markSessionDirty(session) {
    if (!session) return;
    dirtySessions.add(session);
    persistStats.backlog = dirtySessions.size;
    if (dirtySessions.size > persistStats.maxBacklog) persistStats.maxBacklog = dirtySessions.size;
  }

  // 索引级脏标：成员表（建 / 关 / 清场）或主题变了。索引只有几百字节，但它代表
  // 「成员表换代」，不该跟着每个输出块一起重写。
  function markIndexDirty() {
    indexDirty = true;
  }

  // 会话记录的正文。字段与旧版整份文件里的 sessions[i] 逐位相同——老文件按「一
  // 个会话一个对象」直接读回，迁移没有字段映射，也没有丢字段的风险。
  function sessionRecord(session) {
    return {
      version: 1,
      id: session.id,
      label: session.label,
      cwd: session.cwd,
      shell: session.shell,
      pid: session.pid,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      spawnedAt: session.spawnedAt,
      cols: session.cols,
      rows: session.rows,
      buffer: persistedBufferTail(session.buffer),
      status: session.pty ? "running" : "exited",
      exitCode: session.exitCode,
      ...agentMetadata(session),
    };
  }

  // 索引正文。成员表只放 id，正文在各自那份文件里；键名仍叫 sessions——老读者
  // （面板、relay 的清场兜底）只关心「有没有这条」，version:2 是格式换代标记。
  function indexRecord() {
    return {
      version: 2,
      // 亮暗/底色随索引落盘：宿主重启后 agent 立刻发问也能得到真值，不必等面板
      // 补报那一拍。
      theme: { dark: terminalThemeDark, background: terminalThemeBackground },
      sessions: [...sessions.keys()],
    };
  }

  // 一轮落盘。
  //   full=false：防抖拍到的「有界单拍」，最多写 PERSIST_SESSION_WRITES_PER_PASS
  //   份会话文件、最多 PERSIST_PASS_MAX_BYTES 序列化字节，剩下的留在脏集合里等
  //   下一拍——单拍成本因此不随会话数增长。
  //   full=true：全量冲净（关停、清场），不受上限约束。
  //   only 非空：只冲这几条会话（建会话 / resize / 重开这类「只改了一条记录」的
  //   显式等待），别的会话的欠账留给防抖拍去摊。**只有 full 为假时 only 才生效**
  //   ——全量冲净不许被降级成定向冲净（关停要的是「内存态整份在盘上」）。
  // 返回本轮是否全部写成功；写失败的留在脏集合里重试。
  //
  // 脏位纪律（这条是评审打回的那条 P0，base 的注释也专门警告过）：
  //   **入队即清、写成功不回头清**。每一条要写的记录在 await 之前就退出脏集合，
  //   写失败再置回。反过来（写成功后才清）会把「写进行中」新置的脏一并抹掉：
  //   序列化发生在 await 之前，写期间新到的输出块不在那份文本里，脏却被清了，
  //   于是那一块永久只活在内存里（关停前最后一块就直接丢）。索引同理。
  async function persistPass(full, only = null) {
    const startedAt = performance.now();
    let ok = true;
    let written = 0;
    let bytes = 0;
    try {
      // 先把这一轮要写的记录**序列化**出来：批次的选取按序列化后的真实字节数
      // 计量（内存原始字节会低估 ESC 密集内容的落盘体积，六倍膨胀是常态），
      // 顺带把「快照时刻」钉在 await 之前——后面再到的变更属于下一轮。
      //
      // 清脏就在这一刻做，与快照同拍：不能等 write 回来再清（那是 P0），也不能
      // 等下面 mkdir 的 await 之后再清（同一个洞，只是窗口小一点——两者之间到达
      // 的变更会被这一笔成功的写顺手抹掉：序列化时它不在文本里，清脏时它被当成
      // 已写）。写失败再置回。
      const batch = [];
      const consider = (session) => {
        // 写之前就被关掉的会话：收尾由 removedSessionIds 负责，不必再写。
        if (sessions.get(session.id) !== session) {
          dirtySessions.delete(session);
          return null;
        }
        try {
          // 紧凑序列化：这份文件是给机器读的，两空格缩进会白添每块一个换行，
          // 128KB 级尾部上就是几十 KB 的额外写量。
          const text = JSON.stringify(sessionRecord(session));
          const size = Buffer.byteLength(text);
          dirtySessions.delete(session);
          unpersistedIds.delete(session.id);
          return { session, text, size };
        } catch (error) {
          ok = false;
          logger.warn?.(`[terminal-host] session record serialize failed (${session.id}): ${error.message}`);
          return null;
        }
      };
      if (only) {
        for (const session of only) {
          if (!dirtySessions.has(session)) continue;
          const item = consider(session);
          if (item) batch.push(item);
        }
      } else {
        let batchBytes = 0;
        for (const session of dirtySessions) {
          // 「至少写一份」兜底：单份超预算也必须写出去（最新一块必留），所以两个
          // 上限都在 batch 非空之后才判。
          if (batch.length > 0) {
            if (!full && batch.length >= PERSIST_SESSION_WRITES_PER_PASS) break;
            if (!full && batchBytes >= PERSIST_PASS_MAX_BYTES) break;
          }
          const item = consider(session);
          if (!item) continue;
          batch.push(item);
          batchBytes += item.size;
        }
      }
      if (batch.length > 0) {
        try {
          await mkdir(sessionStateDir, { recursive: true });
        } catch (error) {
          ok = false;
          logger.warn?.(`[terminal-host] session state dir unavailable: ${error.message}`);
        }
        for (const item of batch) {
          const { session, text, size } = item;
          try {
            await atomicWriteJsonFile(sessionStatePath(session.id), text);
            written += 1;
            bytes += size;
            persistStats.sessionWrites += 1;
          } catch (error) {
            // 写失败置回脏标：下一拍重试。单份写失败不该打断输出转发，也不该把
            // 没有清场后果的路由打成 500——需要失败冒头的调用方走 persistIndexNowOrThrow。
            ok = false;
            if (sessions.get(session.id) === session) {
              dirtySessions.add(session);
              if (!existsSync(sessionStatePath(session.id))) unpersistedIds.add(session.id);
            }
            logger.warn?.(`[terminal-host] session state persist failed (${session.id}): ${error.message}`);
          }
        }
      }
      // 索引只在「没有待落盘的记录文件」时写：索引里出现某个 id 就等于宣称那份
      // 文件已落盘。别的会话的尾部欠账不拦索引——它们的文件早就在盘上了。
      // 有待删除的 id 时**无条件重写索引**：索引必须立刻不再点名它们，否则盘上
      // 留下「索引点名、文件已删」这种读不回来的悬空项。
      const indexDue = indexDirty || removedSessionIds.size > 0;
      if (indexDue && unpersistedIds.size === 0) {
        for (const id of [...removedSessionIds]) {
          try {
            await rm(sessionStatePath(id), { force: true });
            removedSessionIds.delete(id);
          } catch (error) {
            ok = false;
            logger.warn?.(`[terminal-host] session state remove failed (${id}): ${error.message}`);
          }
        }
        // 走到这里就一定要重写索引：要么 indexDirty 为真，要么刚删过会话（索引
        // 必须立刻不再点名它们）。快照与清脏都在 await 之前（同会话记录的纪律）：
        // 写期间新置的 indexDirty 会留在集合里，下一轮补写。
        //
        // 但上面 rm 的 await 期间可能新建了会话（它的记录文件还没落）：这时索引
        // 不能点名它，否则「索引点名 = 文件已写过」这条顺序保证就破了。留到下一轮。
        if (unpersistedIds.size === 0) {
          const text = JSON.stringify(indexRecord(), null, 2);
          indexDirty = false;
          try {
            await atomicWriteJsonFile(statePath, text);
            bytes += Buffer.byteLength(text);
          } catch (error) {
            indexDirty = true;
            ok = false;
            logger.warn?.(`[terminal-host] state index persist failed: ${error.message}`);
          }
        }
      }
    } catch (error) {
      // 兜底：这一层不该有异常逃逸（下面全是 catch 住的），但落盘是发后不管的
      // 路径，一个意外异常会变成未处理 rejection 炸掉宿主。
      ok = false;
      logger.warn?.(`[terminal-host] state persist failed: ${error.message}`);
    }
    const elapsed = performance.now() - startedAt;
    persistStats.passes += 1;
    persistStats.lastPassMs = elapsed;
    if (elapsed > persistStats.maxPassMs) persistStats.maxPassMs = elapsed;
    persistStats.lastPassSessionWrites = written;
    if (written > persistStats.maxPassSessionWrites) persistStats.maxPassSessionWrites = written;
    persistStats.lastPassBytes = bytes;
    persistStats.backlog = dirtySessions.size;
    if (elapsed > PERSIST_DEBOUNCE_MS) {
      // 单笔超过防抖窗：旧实现里下一拍会叠上来、链无界积压。现在有界单拍加合并
      // 请求把它挡在源头，这条日志是「该看这里了」的信号，不是失败。
      persistStats.slowPasses += 1;
      logger.warn?.(`[terminal-host] persist pass took ${elapsed.toFixed(0)}ms (sessions=${written}, bytes=${bytes}, backlog=${dirtySessions.size})`);
    }
    return ok;
  }

  // 落盘泵：同一时刻只有一轮在写；写期间到达的请求合并成「再跑一轮」的标记，不
  // 排成一条随负载无界增长的 promise 链（旧实现每拍 append 一个 .then，单笔超过
  // 防抖窗就无界积压）。返回的 promise 恒 resolve：值是「泵停下时最后一轮是否全
  // 部写成功」的布尔，没有脏位时直接继承上一轮的结果。
  let pumpRunning = false;
  let pumpPromise = Promise.resolve(true);
  let pumpWantFull = false;
  let pumpWantSlice = false;
  let pumpWantOnly = null;
  let lastPassOk = true;

  function hasPendingWork() {
    return indexDirty || dirtySessions.size > 0 || removedSessionIds.size > 0;
  }

  function requestPersist({ full = false, only = null } = {}) {
    pumpWantFull = pumpWantFull || full;
    pumpWantSlice = true;
    if (only) {
      // 定向请求：只冲这几条会话。它在泵里与「再跑一轮」的标记一起被收编，所以
      // 不会与正在写的那一份撞车（同一时刻只有一轮在写）。
      if (!pumpWantOnly) pumpWantOnly = new Set();
      for (const session of only) pumpWantOnly.add(session);
    }
    if (pumpRunning) {
      // 在飞的泵会看到这两个标记并续一轮，请求不会丢；合并计数就是积压的可见面。
      persistStats.coalescedRequests += 1;
      return pumpPromise;
    }
    // 脏位门控：内存没变过（空闲会话的轮询、心跳、无变化 resize）连一轮都不跑。
    if (!hasPendingWork()) {
      pumpWantFull = false;
      pumpWantSlice = false;
      pumpWantOnly = null;
      return Promise.resolve(lastPassOk);
    }
    pumpRunning = true;
    pumpPromise = (async () => {
      let ok = true;
      let rounds = 0;
      for (;;) {
        rounds += 1;
        // full 与 only 不合并进同一轮：full 优先，且 only 在 full 轮里自然被满足
        // （全量写本来就覆盖它们）。两者合并会让 close() 的全量冲净被降级成定向
        // 冲净——关停时 SIGTERM 紧接着 process.exit(0)，没写完的尾部就没了。
        const fullPass = pumpWantFull;
        const onlyPass = fullPass ? null : pumpWantOnly;
        pumpWantFull = false;
        pumpWantOnly = null;
        pumpWantSlice = false;
        let passOk = false;
        try {
          passOk = await persistPass(fullPass, onlyPass);
        } catch (error) {
          logger.warn?.(`[terminal-host] state persist failed: ${error.message}`);
        }
        ok = passOk && ok;
        // 全量冲净的语义是「返回时内存态整份在盘上」：写期间新置的脏（输出还在
        // 流、有人刚关了页签）必须在这一轮里继续写完，不能留给下一次防抖。上限
        // 防的是「输出永不停止」时的活锁——关停路径下输出几拍内就断了。
        if (fullPass && passOk && hasPendingWork() && rounds < PERSIST_FULL_FLUSH_MAX_ROUNDS) continue;
        // 这个判断必须是同步的：写期间到达的请求在这里被收编，泵不会「已经决定
        // 退出却又漏掉一个请求」。
        if (pumpWantFull || pumpWantSlice) continue;
        pumpRunning = false;
        lastPassOk = ok;
        if (fullPass && passOk && hasPendingWork()) {
          // 撞到轮次上限还有欠账：记一笔，剩下的交给防抖拍继续收（有界单拍不会
          // 让它无界增长）。正常关停路径走不到这里。
          logger.warn?.(`[terminal-host] full flush stopped at ${rounds} rounds with backlog=${dirtySessions.size}`);
          schedulePersist();
        } else if ((dirtySessions.size > 0 || removedSessionIds.size > 0 || indexDirty) && ok) {
          // 有界单拍留下的欠账：自己续下一拍，不必等下一次输出把它叫醒。写失败时
          // 不续（否则永久失败会变成每 250ms 一次的空转），等下一次变更再来。
          schedulePersist();
        }
        return ok;
      }
    })();
    return pumpPromise;
  }

  // 立即落盘（相对 250ms 防抖而言）。改异步后调用方分三类：删除级路由
  // （close、clear-all）经 persistIndexNowOrThrow 拿结果、写失败上抛 500（旧同步写
  // 失败就是路由 500，这条防线喂着 relay 的清场链路，见 persistIndexNowOrThrow 的
  // 注释）；close() 与 create/restart/resize 路由只等完成（拿 200 后没有谁拿
  // 它去杀宿主，软失败保脏位等下一拍重试更好）；onExit 这类回调路径发后不
  // 管——写失败会被捕获、记日志并保持脏位，不会以未处理 rejection 的形式
  // 炸掉宿主。
  // 默认全量冲净：删除级路径要的就是「内存态整份在盘上」。只改了一条记录的路径
  // 用 persistSession，别让它们替其它会话的尾部欠账付账。
  function persistNow() {
    return requestPersist({ full: true });
  }

  // 只冲这一条会话的记录（连同待写的索引）：建会话 / resize / 重开 / 退出这类
  // 「会话元数据变化必须即时落盘」的路径走这里。成本是 O(1) 于会话数——这正是
  // 多开时点一下不该卡住的理由。待落盘集合里的会话（刚建或 v1 迁移遗留）一并带上：
  // 索引不允许在「有 id 还没落文件」时写，否则那条会话在下次重启时就成了孤儿。
  function persistSession(session) {
    const only = new Set([session]);
    for (const pending of dirtySessions) {
      if (unpersistedIds.has(pending.id)) only.add(pending);
    }
    return requestPersist({ only: [...only] });
  }

  // 只冲索引（连同删除与待落盘的记录文件）：关页签 / 清场这类「成员表变了」的
  // 显式等待。语义上要的是「响应到达时盘上已经没有这个会话」——索引不点名它、
  // 记录文件也不在，这不需要把别的会话的尾部重写一遍。
  function persistIndexNow() {
    const only = new Set();
    for (const pending of dirtySessions) {
      if (unpersistedIds.has(pending.id)) only.add(pending);
    }
    return requestPersist({ only: [...only] });
  }

  // 删除级路由的落盘等待：失败必须以 500 拒答，不能答一个「盘上其实没清」的
  // 200。relay 的 stop({clearSessions}) 收到 200 就杀宿主子进程（它对非 2xx 才
  // 走 clearFailed → 宿主停稳后删除状态文件的兜底，见 relay-host.mjs 的
  // requestClearAllSessions），面板关页签同理拿 200 当凭据——写失败藏在 200
  // 里，已关的页签就会在下次宿主重启时从盘上复活。这恢复了旧同步写的防线：
  // writeFileSync 当年在这里抛出去，路由答的本来就是 500。
  async function persistIndexNowOrThrow() {
    const persisted = await persistIndexNow();
    if (!persisted) throw Object.assign(new Error("state_persist_failed"), { statusCode: 500 });
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      requestPersist({ full: false });
    }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  }

  // 恢复清扫在后台跑，句柄挂在返回值上给测试做确定性等待：命令行查询要拉起
  // PowerShell（几百毫秒），不能在 restore 的同步循环里做——宿主启动会因此卡住。
  let restoreSweep = Promise.resolve();

  // 从盘上读回会话记录。两种形态都认：
  //   v2（当前）——索引的 sessions 是 id 数组，正文在 <root>/terminal-sessions/<id>.json；
  //   v1（旧）——索引的 sessions 是完整对象数组，正文（含 buffer）就在里面。
  // 判据是元素类型：字符串＝v2 的 id，对象＝v1 的整份记录。这样新码读旧文件不需要
  // 版本分支也不留迁移义务：v1 文件在第一次落盘时自然变成 v2，而 v1 永远读得回来。
  //
  // 返回值里 indexIds 与 records 是**两件事**：indexIds 是「索引点名的全部合法 id」
  // （不管这次读没读成功），records 是「这次真读出来的记录」。清理孤儿必须用前者
  // ——用后者的话，一次瞬时读失败（杀软锁、EACCES）就会被当成「索引没点名」而把
  // 那份记录当场删掉，瞬时故障变成永久丢尾部。
  function readPersistedRecords(raw) {
    const items = Array.isArray(raw?.sessions) ? raw.sessions : [];
    const records = [];
    const indexIds = new Set();
    for (const item of items) {
      if (typeof item === "string") {
        if (!SESSION_ID_PATTERN.test(item)) {
          logger.warn?.(`[terminal-host] session id rejected from index: ${JSON.stringify(item)}`);
          continue;
        }
        indexIds.add(item);
        try {
          const record = JSON.parse(readFileSync(sessionStatePath(item), "utf8"));
          if (record && typeof record === "object") records.push(record);
        } catch (error) {
          // 索引点名但文件读不回来（索引落盘后崩在文件落盘之前、文件被外部删掉）：
          // 按「没有这条记录」处理。没有元数据与尾部的会话恢复出来只是一排白屏
          // 页签，面板的历史会话入口还能把它重建回来。
          logger.warn?.(`[terminal-host] session record missing (${item}): ${error.message}`);
        }
        continue;
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        if (SESSION_ID_PATTERN.test(String(item.id ?? ""))) indexIds.add(String(item.id));
        records.push(item);
      }
    }
    return { records: records.filter((record) => SESSION_ID_PATTERN.test(String(record?.id ?? ""))), indexIds };
  }

  // 清理索引没点名的残留记录文件（崩溃窗口的孤儿、v1 时代的旧文件、原子写留下的
  // 临时文件）。索引是成员表的唯一权威，所以这里只删「不在索引里」的：relay 的
  // clearSessions 兜底只 unlink 索引，留下的正是这一批。
  function pruneSessionRecords(keepIds) {
    let entries;
    try {
      entries = readdirSync(sessionStateDir, { withFileTypes: true });
    } catch {
      return; // 目录还不存在：没东西可清
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      const stale = name.endsWith(".tmp") || (name.endsWith(".json") && !keepIds.has(name.slice(0, -".json".length)));
      if (!stale) continue;
      try {
        rmSync(join(sessionStateDir, name), { force: true });
      } catch {
        // 清不动就留着：它不影响恢复，下次启动再试。
      }
    }
  }

  function restore() {
    const sweeps = [];
    try {
      const raw = JSON.parse(readFileSync(statePath, "utf8"));
      // 主题状态先于会话恢复：恢复出来的会话可能马上被重开，重开的 agent 会在
      // 第一帧就问亮暗/底色，那时该答上来的是上一代宿主记下的真值。
      if (raw?.theme && typeof raw.theme === "object") {
        if (typeof raw.theme.dark === "boolean") terminalThemeDark = raw.theme.dark;
        if (typeof raw.theme.background === "string" && BACKGROUND_HEX_PATTERN.test(raw.theme.background)) {
          terminalThemeBackground = raw.theme.background;
        }
      }
      const { records, indexIds } = readPersistedRecords(raw);
      for (const item of records) {
        const buffer = Array.isArray(item.buffer) ? item.buffer : [];
        const { version: _recordVersion, ...rest } = item;
        const session = {
          ...rest,
          pty: null,
          // 进程代际：每次 spawn 换一个记号，onExit/onData 只认自己那一代。
          // 盘上恢复的会话没有活进程，代际从 0 起。
          ptyGeneration: 0,
          // 本代宿主见过并可能还活着的 shell pid（含已被 onExit 摘掉的代）。
          // 树杀按这份清单走：session.pty 为空不代表上一代进程已经死了。
          livePids: new Set(),
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
        // 泄漏面，不碰。pid 已死的也不碰（pid 复用，宁漏勿错）；pid 活着但
        // 命令行对不上本会话启动执行体的同样不碰——那是系统把号发给了别人。
        if (item.agentId && Number.isInteger(item.pid) && item.pid > 0 && isAliveFn(item.pid)) {
          sweeps.push(verifyAndSweep(session, item.pid));
        }
        // Rebuild the rendered picture from the durable tail. The tail is trimmed,
        // so a restored session repaints approximately — no worse than replaying
        // those same bytes raw, and it gets exact again on the next output chunk.
        // 恢复走同步 write 而不是切片：这是一次性启动成本（盘上每会话上限 128KB，
        // 实测 10–14ms；512KB 的极端尾巴 29–52ms），而恢复完就要立刻能被 attach，
        // 引入跨轮次续排状态只会让建连路径更难推理。同步 write 与切片共用同一
        // 解析内核，跨块转义暂留一并生效。
        for (const chunk of buffer) feedMirrorSync(session, String(chunk));
        sessions.set(item.id, session);
        // 盘上还没有这条会话的记录文件（v1 旧格式、或 v2 索引点名但文件被外部删
        // 掉）：进待落盘集合并置脏。索引里出现某个 id 就等于宣称那份文件已写过，
        // 所以这一批必须先落，索引才允许写。文件已经存在的会话不置脏——宿主启动
        // 不该把整排 128KB 尾部重写一遍。
        if (!existsSync(sessionStatePath(item.id))) {
          unpersistedIds.add(item.id);
          markSessionDirty(session);
        }
      }
      // 孤儿清理用**索引点名的 id**做保留集，不是「这次读成功的记录」：一次瞬时
      // 读失败不该把那份记录当场删掉（那会把瞬时故障变成永久丢尾部）。
      pruneSessionRecords(indexIds);
      // 盘上是旧格式（v1 整份文件）：把索引改成 v2 的成员表。迁移只有这一次，之后
      // 索引已是 v2，启动不再动盘。
      const indexIsCurrent = raw?.version === 2 && Array.isArray(raw.sessions)
        && raw.sessions.every((entry) => typeof entry === "string");
      if (!indexIsCurrent) markIndexDirty();
      if (indexDirty || dirtySessions.size > 0) schedulePersist();
    } catch (error) {
      // 首次启动、或状态文件半截写坏：从空表起。
      //
      // 但「索引不存在」与「索引读不出来」要分开对待：索引是成员表的唯一权威，
      // **它不在盘上就等于「没有会话」**——relay 的 clearSessions 兜底就是
      // unlinkSync(索引)，此时那些记录文件全是无人认领的终端内容，必须一起清掉，
      // 否则 N×128KB 的屏幕内容会一直留在盘上直到下一次「索引读成功」的启动。
      // 索引存在却读不出来（杀软锁、EACCES、半截 JSON）则什么都不删——那是瞬时
      // 故障，删了就把可恢复的数据变成不可恢复。
      if (error?.code === "ENOENT" || !existsSync(statePath)) {
        pruneSessionRecords(new Set());
      }
    }
    if (sweeps.length > 0) restoreSweep = Promise.all(sweeps);
  }

  // 恢复清扫的异步身份校验：命令行查询要拉起 PowerShell（几百毫秒），不能在
  // restore 的同步循环里做——宿主启动会因此卡住。查不到（null）按「不是本会话」
  // 处理，绝不动手。
  async function verifyAndSweep(session, pid) {
    let commandLine = null;
    try {
      commandLine = await getCommandLineFn(pid);
    } catch {
      commandLine = null;
    }
    if (!commandLineOwnsSession(commandLine, session)) return;
    if (!isAliveFn(pid)) return;
    try {
      await killTreeFn(pid);
    } catch (error) {
      logger.warn?.(`[terminal-host] restore sweep pid=${pid} failed: ${error.message}`);
    }
  }

  // The mirror renders what a client replays on connect. It is deliberately a
  // one-way passenger: a parser bug or a sequence we do not model must degrade to
  // "that chunk was not rendered", never to "output stopped forwarding".
  //
  // 有预算的切片解析：这个进程的事件循环同时跑着所有会话的 PTY 读回调、SSE 投递
  // 与输入 POST。一次 resume 会来六七个 60KB 的块，整块同步解析要 40–110ms，期间
  // 别的页签收不到帧、输入回显变慢（实测同进程另一会话帧间隔 16ms → 68ms）。
  // 所以每轮只给镜像 4ms，剩下的用 setImmediate 续排——emit 的监听器扇出因此最多
  // 被推迟 4ms，而不是整块解析时间。待解析字节由镜像自己持有，顺序天然保序。
  const MIRROR_SLICE_MS = 4;
  function feedMirror(session, text) {
    try {
      if (!session.screen) session.screen = createScreenMirror({ cols: session.cols, rows: session.rows });
      const result = session.screen.writeSliced(text, MIRROR_SLICE_MS);
      if (!result.done) scheduleMirrorDrain(session);
    } catch (error) {
      skipMirrorChunk(session, error);
    }
  }

  // 同步喂送：恢复路径专用（见 restore 里的注释）。与 feedMirror 共用同一容错。
  function feedMirrorSync(session, text) {
    try {
      if (!session.screen) session.screen = createScreenMirror({ cols: session.cols, rows: session.rows });
      session.screen.write(text);
    } catch (error) {
      skipMirrorChunk(session, error);
    }
  }

  // 解析中途抛错时偏移量可能已经和字节流脱节，后续每一块都会画错位；丢掉待解析
  // 缓冲回到干净状态，代价只是这一段没画上（与"跳过该块"的既有契约一致）。
  function skipMirrorChunk(session, error) {
    try { session.screen?.discardPending(); } catch { /* 镜像已不可用，下面只记日志 */ }
    logger.warn?.(`[terminal-host] screen mirror skipped (${session.id}): ${error.message}`);
  }

  function scheduleMirrorDrain(session) {
    if (session.mirrorDrainScheduled) return;
    session.mirrorDrainScheduled = true;
    setImmediate(() => {
      session.mirrorDrainScheduled = false;
      try {
        if (!session.screen) return;
        if (!session.screen.drain(MIRROR_SLICE_MS).done) scheduleMirrorDrain(session);
      } catch (error) {
        skipMirrorChunk(session, error);
      }
    });
  }

  // 终端询问的应答侧（清单见文件头）：宿主是唯一应答者，浏览器渲染器只会看到
  // 摘掉询问之后的字节流。任何一条主题询问都算「这条会话在意亮暗」，不只
  // 2031h——claude code 从不订阅，它把收到的 997 当作「变了，我重问一次」，
  // 只按订阅扇出就永远通知不到它。2031l 是显式退订，仍然说话算数。
  function answerTerminalQuery(session, probe) {
    if (probe === "deviceAttributes") {
      writePty(session, DA1_REPORT);
      return;
    }
    if (probe === "notifyOff") {
      session.themeNotify = false;
      return;
    }
    session.themeNotify = true;
    if (probe === "theme") writePty(session, themeReport(terminalThemeDark));
    else if (probe === "background") {
      writePty(session, themeBackgroundReport(effectiveBackground(terminalThemeDark, terminalThemeBackground)));
    }
  }

  function writePty(session, data) {
    try {
      session.pty?.write(data);
    } catch {
      /* pty 死在半途：读的人已经没了，这份报告无处可送 */
    }
  }

  function emit(session, chunk) {
    // 询问一律在这里认领并摘掉，再看剩下什么要转发。跨块被拆开的询问留在
    // 扫描器尾巴里，等到下一块拼齐才应答——应答永远只有一份。
    if (!session.queryScanner) session.queryScanner = createTerminalQueryScanner();
    const scanned = session.queryScanner.push(chunk);
    for (const probe of scanned.probes) answerTerminalQuery(session, probe);
    const text = scanned.text;
    // 整块都是已应答的询问：没有可转发、可记录的内容，也不算一次活动。
    if (!text) return;
    session.buffer.push(text);
    session.bufferBytes += chunkBytes(text);
    trimReplayBuffer(session, TERMINAL_BUFFER_MAX_BYTES, TERMINAL_BUFFER_MAX_CHUNKS);
    feedMirror(session, text);
    session.lastActiveAt = Date.now();
    // 每个输出块都改写这条会话的记录（buffer 尾部与 lastActiveAt）：只置这一条
    // 会话的脏标，250ms 防抖到点的那一拍只重写它自己那份文件——别的会话空闲与
    // 否不再影响这个会话的单拍成本。
    markSessionDirty(session);
    for (const listener of session.listeners) listener(text);
    schedulePersist();
  }

  // 重开衔接卫生（回滚归页签的另一半）：旧进程死在备屏时，新进程的输出会被画
  // 进备屏、等应用退屏时整段丢掉——先弹回主画面；光标停在半行时补一个换行，
  // 防新进程首行拼进旧行尾。合成字节走 emit 单咽喉：镜像、在线 SSE 客户端、
  // 盘上回放三方同拍一致（入了 journal，宿主重启的 restore 重喂复现同一衔接）。
  function restartHygiene(session) {
    try {
      // 这里读的是「镜像当前画面」的 inAlt / col，必须先排空切片留下的积压，
      // 否则会按落后若干毫秒的状态补衔接字节。重开是一次性动作，同步排空的
      // 代价可以接受（info() 本身刻意不排空，见 terminal-screen.mjs）。
      session.screen.flush();
      if (session.screen.info().inAlt) emit(session, "\u001b[?1049l");
      if (session.screen.info().col !== 0) emit(session, "\r\n");
    } catch (error) {
      // 卫生失败不拦重开：镜像解析面坏了时照常 respawn（feedMirror 同款容错）。
      logger.warn?.(`[terminal-host] restart hygiene skipped (${session.id}): ${error.message}`);
    }
  }

  // 进程代际护栏：重启会在旧进程的退出通知到达之前就 spawn 新一代（ConPTY 的
  // exit 通知要晚几十到几百毫秒）。没有代际判断时，旧进程迟到的 onExit 会把
  // session.pty 置空、把状态翻成 exited——新一代进程明明活着却被判死，面板
  // 于是再复活一次，一轮轮空转并留下没人认领的孤儿。回调只认自己那一代：
  // 不是当前代就只记一笔，不碰会话状态、不通知流端。
  function attach(session, child) {
    const generation = (session.ptyGeneration ?? 0) + 1;
    session.ptyGeneration = generation;
    session.pty = child;
    session.pid = child.pid ?? session.pid;
    if (Number.isInteger(session.pid) && session.pid > 0) {
      if (!session.livePids) session.livePids = new Set();
      session.livePids.add(session.pid);
    }
    const isCurrent = () => session.ptyGeneration === generation;
    child.onData((data) => {
      if (!isCurrent()) return;
      emit(session, data);
    });
    child.onExit(({ exitCode }) => {
      // 这一代进程已经结束：无论是不是当前代，都把它从待杀清单里摘掉——死 pid
      // 会被系统复用，留在清单里就等于把号发给别人的进程当成本会话的树。
      if (Number.isInteger(child.pid)) session.livePids?.delete(child.pid);
      if (!isCurrent()) {
        logger.warn?.(`[terminal-host] stale exit ignored (pid=${child.pid}, generation=${generation}, current=${session.ptyGeneration})`);
        return;
      }
      session.exitCode = exitCode;
      session.pty = null;
      session.lastActiveAt = Date.now();
      // 退出改写的是落盘记录里的 exitCode/状态/lastActiveAt 三样：置脏后再触发
      // 立即写，退出码不能只活在内存里（宿主随后被杀时盘上还是 running）。
      markSessionDirty(session);
      persistSession(session);
      for (const listener of session.listeners) listener(null);
    });
    // spawn 落定了 pid 与运行状态（新建与 restart 共用这条路径）：置脏。
    markSessionDirty(session);
    persistSession(session);
  }

  // 终结一个会话的进程树：先 pty.kill 关伪控制台（守规矩的进程拿
  // CTRL_CLOSE 优雅退出），再对**本代宿主 spawn 过、且还没见到退出通知**的
  // 每一代 shell pid 树杀（控制台解耦的进程由这一步终结）。清单而不是
  // session.pid：迟到退出或上一代解耦进程都可能还挂着，只看当前句柄正是孤儿
  // 泄漏的来源；反过来也不碰清单外的 pid——pid 可被系统复用，宁漏勿错。
  async function terminateSessionTree(session) {
    if (!session) return;
    // 候选清单必须在 kill 之前取：pty.kill() 会同步触发这一代的 onExit，
    // 而 onExit 会把 pid 从清单里摘掉——先 kill 再读清单等于什么都没杀。
    // 树杀要收的正是「控制台已经关了、解耦的 agent 还活着」这类进程，
    // 它们不会随 pty 一起死，所以这一代的 pid 无论如何都要过一遍树杀。
    const candidates = [...(session.livePids ?? [])];
    try {
      session.pty?.kill();
    } catch {
      /* 已经死了的 pty 杀第二次不拦后面的树杀 */
    }
    for (const pid of candidates) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (!isAliveFn(pid)) {
        session.livePids?.delete(pid);
        continue;
      }
      try {
        await killTreeFn(pid);
        session.livePids?.delete(pid);
      } catch (error) {
        // 杀失败保留登记：下一轮重启/关闭还要再试一次，丢了登记就等于放弃
        // 那棵树（pid 可被复用，之后想杀也不敢动手了）。
        logger.warn?.(`[terminal-host] tree kill pid=${pid} failed: ${error.message}`);
      }
    }
  }

  // 重开一个会话的进程。并发重启（面板轮询 + 用户点击同时打进来）必须合并成
  // 一次 spawn：两次 terminate+spawn 交错时，后一次的树杀会落在前一次刚起来的
  // 新进程上，最终留下的进程与响应里的 pid 对不上，多出来的那个成了孤儿。
  // 同会话的重启请求串成一条：在飞时直接返回同一份结果快照。
  function restartSession(session, { envDelta = null, launch = null, cwd = null, resume = null, clearResume = false, label = null, agentId = null, agentName = null } = {}) {
    if (session.restartInFlight) return session.restartInFlight;
    const run = (async () => {
      if (envDelta) session.env = mergeInjectedEnv(session.env ?? {}, envDelta);
      // 启动参数可按当前安装与设置追平（可执行文件升级、权限开关变更、工作目录
      // 漂移）。只认调用方校验过的值，缺失则沿用会话原值。
      if (launch) session.launch = launch;
      if (cwd) session.cwd = cwd;
      // 身份同步（M12-A 内切）：这条终端就地换成目标会话——label/agentId/agentName
      // 与 resume 身份（endpoint＋会话 id）一并改写，落盘随本轮的 persistNow 走。
      // 缺省字段一律沿用原值（restart 的既有语义：只更新带来的）。clearResume 是
      // 全新内切的显式清除位：内切成新会话时旧 resume 必须清空，残留会让面板的
      // 去重聚焦与「新会话」兜底行拿旧身份误判。
      if (label) session.label = label;
      if (agentId) session.agentId = agentId;
      if (agentName) session.agentName = agentName;
      if (resume) session.resume = resume;
      if (clearResume) session.resume = null;
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
      // 只等这一条会话的记录——重开不改成员表，不必替别的会话的尾部欠账付账。
      await persistSession(session);
      return snapshot(session);
    })();
    session.restartInFlight = run.finally(() => {
      session.restartInFlight = null;
    });
    return session.restartInFlight;
  }

  function spawnSession(session) {
    // 进程生日（新建与 restart/内切/复活都走这一咽喉）：面板的孵化豁免窗锚点。
    // 记在这而不是 createdAt 上——restart 保记录换进程，createdAt 不动，拿它当
    // 生日会把换壳后的 banner/续接重放漏出豁免窗（误转圈＋内切门误判 working）。
    // 落盘保留的是「上一代进程生日」：恢复出的 exited 会话需靠它界定本轮
    // 对话，不能拿页签 createdAt 抢绑更早的存档；下次复活会覆盖为新生日。
    session.spawnedAt = Date.now();
    // 进程换代即订阅作废：2031 与「问过主题」都是进程内行为，新进程（新 shell
    // 或新 agent 实例）尚未表态；旧进程留下的半截询问尾巴也可能与新输出拼出
    // 幽灵询问，一并清零。新 agent 起来后自会再问一遍（OSC 11 / 996n / 2031h）。
    session.themeNotify = false;
    session.queryScanner = null;
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

  // data 帧合帧器，每个 SSE 连接独立一份：多连接共享同一会话，各攒各的缓冲、
  // 各冲各的定时器。PTY 输出在小时间尺度上是一串碎块（TUI 常把一帧拆成好几
  // 次 onData），逐块一帧等于把 N 次网络往返和 N 次 term.write 强加给一次重
  // 绘——这就是多开卡顿时 SSE 侧的病灶。攒进待发缓冲、窗口定时器到点合并成
  // 一个 data 帧转发；客户端本来就是 JSON.parse 后 term.write，拼接语义不变。
  // 边界：超 SSE_PENDING_FLUSH_BYTES 立即冲（大输出不陪窗口攒延迟）；exit 先
  // 冲净 pending 再发退出帧（最后一屏必须排在退出之前，帧序不能倒）；连接断
  // 开清定时器弃缓冲（人已走，送无可送）。回放帧、snapshot 帧、心跳注释帧都
  // 不经过这里——回放是挂监听前的直发路径，帧序保持不变。
  function attachStream(session, res) {
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
    res.on("close", () => {
      clearInterval(heartbeat);
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pendingChunks = [];
      pendingBytes = 0;
      session.listeners.delete(listener);
    });
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
    //
    // 镜像可能还有没解析完的积压（切片解析在续排）。这里不能一口气同步排空：一次
    // resume 之后的积压排空要几十毫秒，而建连本来就不该把事件循环按住——那正是
    // 本次改动要消除的卡顿形态。改成按预算分几轮排空再发回放帧：客户端先拿到
    // snapshot，回放帧晚几轮到达，语义不变（帧序仍是 snapshot → 回放 → 实时）。
    // 监听器在回放发出后才挂上，因此这期间到达的实时块只进 buffer 与镜像，不会
    // 既被回放覆盖又被单独转发一遍。
    const emitReplay = () => {
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
      attachStream(session, res);
    };
    if (session.screen && session.screen.info().pendingChars > 0) {
      const pump = () => {
        if (res.writableEnded) return; // 人已走：别再为这条连接排空镜像
        let done = true;
        try {
          done = session.screen.drain(MIRROR_SLICE_MS).done;
        } catch (error) {
          skipMirrorChunk(session, error);
        }
        if (done) emitReplay();
        else setImmediate(pump);
      };
      setImmediate(pump);
      return;
    }
    emitReplay();
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
        // 续接身份（M7 S5）：先校验再建——坏形状连会话都不建（面板那边已按模板
        // 校验过一遍，这里是宿主自己的独立一道闸）。
        const resumeInput = normalizeResume(body.resume);
        if (resumeInput && resumeInput.error) return json(res, 400, { error: resumeInput.error });
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
          // 不播种 lastActiveAt（出生≠活跃）：输出活跃窗只认 emit 真出过字。播种会让
          // 刚打开的空会话在前 5s 误转圈、M12 内切门误判 working 走保护性新开。
          cols: Math.max(2, Math.min(240, Number(body.cols) || 120)),
          rows: Math.max(1, Math.min(120, Number(body.rows) || 34)),
          exitCode: null,
          buffer: [],
          bufferBytes: 0,
          screen: createScreenMirror({ cols: Math.max(2, Math.min(240, Number(body.cols) || 120)), rows: Math.max(1, Math.min(120, Number(body.rows) || 34)) }),
          pty: null,
          ptyGeneration: 0,
          livePids: new Set(),
          listeners: new Set(),
          // 续接身份随会话记录一起进内存/落盘（见 normalizeResume）
          ...(resumeInput && resumeInput.resume ? { resume: resumeInput.resume } : {}),
        };
        sessions.set(session.id, session);
        // 会话入表即改写持久化状态：先置脏。即便随后的 spawn 失败，这个「存在
        // 过」的会话也该在关停冲刷时落上盘——与旧同步写的可观察行为一致。
        // unpersistedIds 是「索引还不许点名它」的闸：记录文件落定后它才离开集合，
        // 索引才跟着写（顺序：先文件、后索引）。
        unpersistedIds.add(session.id);
        markIndexDirty();
        markSessionDirty(session);
        spawnSession(session);
        // 旧实现 attach 里的同步写盘发生在 201 响应之前；异步化后路由等这笔写
        // 落定再答，响应到达即会话已在盘上（宿主紧跟着崩溃也不丢这条记录）。只等
        // 这一条会话 + 索引：新建一条不该把 N 个会话的尾部重写一遍。
        await persistSession(session);
        return json(res, 201, snapshot(session));
      }
      // 面板亮暗/底色上报：存下生效值（996n 与 OSC 11 的应答来源），深浅变化即
      // 向所有在意主题的活会话扇出 997 报告。同值重报幂等不扇出。底色只换颜色
      // 不改深浅时（换肤）静默更新——agent 的调色板按深浅走，重绘没有意义。
      if (url.pathname === "/terminal/theme" && req.method === "POST") {
        const body = await readBody(req);
        if (body.dark !== true && body.dark !== false) return json(res, 400, { error: "invalid_theme" });
        let background = terminalThemeBackground;
        if (body.background !== undefined) {
          if (typeof body.background !== "string" || !BACKGROUND_HEX_PATTERN.test(body.background)) {
            return json(res, 400, { error: "invalid_background" });
          }
          background = body.background;
        }
        const darkChanged = body.dark !== terminalThemeDark;
        const backgroundChanged = background !== terminalThemeBackground;
        terminalThemeDark = body.dark;
        terminalThemeBackground = background;
        if (darkChanged) {
          const report = themeReport(terminalThemeDark);
          for (const session of sessions.values()) {
            if (session.themeNotify) writePty(session, report);
          }
        }
        if (darkChanged || backgroundChanged) {
          // 主题住在索引里（几百字节），不牵动任何会话记录。
          markIndexDirty();
          schedulePersist();
        }
        return json(res, 200, {
          ok: true,
          dark: terminalThemeDark,
          background: effectiveBackground(terminalThemeDark, terminalThemeBackground),
        });
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
          // 每个被清掉的会话都要连记录文件一起消失：索引写空之后盘上若还留着这些
          // 文件，它们就成了永远读不到的孤儿（下次启动由 restore 的清理收尾）。
          dirtySessions.delete(session);
          unpersistedIds.delete(session.id);
          removedSessionIds.add(session.id);
          cleared += 1;
        }
        // 清场是删除级变化：置脏后这笔写必须真的把空表落上盘，并在响应前等它
        // 写完——relay 的 stop({clearSessions}) 收到 200 就杀宿主子进程，盘上
        // 残留旧会话会让下次启动凭空复活一排已关的页签。写失败走 500 拒答，
        // relay 才会转进「宿主停稳后删除状态文件」的兜底。
        markIndexDirty();
        await persistIndexNowOrThrow();
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
        // 键入不再刷新 lastActiveAt（PTY 回显会走 emit 把它顶进活跃窗，把「用户
        // 在打字」误归因成「agent 在跑」）——改记 lastInputAt，面板的键入抑制窗
        // 拿它当锚点。不落盘：它是分秒级信号，恢复后的老会话按缺省（无抑制）走。
        session.lastInputAt = Date.now();
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
        // 但没有任何状态变化，这笔 persistNow 在脏位门控下是纯空跳。尺寸住在会话
        // 自己那份记录里，所以只置这一条会话的脏标。
        if (sizeChanged) markSessionDirty(session);
        await persistSession(session);
        return json(res, 200, { ok: true, cols, rows });
      }
      if (action === "restart" && req.method === "POST") {
        // Optional env re-injection: a caller that holds fresh credentials
        // (e.g. a relay restart) merges them in before the respawn. Merged,
        // never echoed — the response snapshot carries no env.
        const body = await readBody(req);
        const envDelta = body?.env !== undefined && body.env !== null ? normalizeInjectedEnv(body.env) : null;
        // 复活通路会带上按当前安装重新组装的 launch 与 cwd：可执行文件升级、
        // 权限开关变更、工作目录漂移都在重开时追平。缺省则沿用会话原值。
        const launch = body?.launch !== undefined && body.launch !== null ? normalizeLaunch(body.launch) : null;
        const cwd = typeof body?.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null;
        if (cwd !== null && !existsSync(cwd)) return json(res, 400, { error: "invalid_cwd" });
        // 身份同步三件（M12-A 内切）：随 restart 带上即改写会话记录，缺省/空串
        // 视为「不更新」沿用原值；形状不对拒 400，不静默忽略（换绑是显式动作）。
        const identity = normalizeIdentityUpdate(body);
        if (identity.error) return json(res, 400, { error: identity.error });
        const restarted = await restartSession(session, { envDelta, launch, cwd, ...identity.fields });
        return json(res, 200, restarted);
      }
      if (action === "close" && req.method === "POST") {
        await terminateSessionTree(session);
        sessions.delete(session.id);
        // 会话从内存表移除是删除级变化：置脏后等这笔写落定再答——响应到达时
        // 盘上已经没有这个会话（与旧同步写的外部时序契约一致）。写失败走 500
        // 拒答：面板拿 200 当「盘上已清」的凭据，假 200 会让已关页签在宿主下
        // 次重启时从盘上复活。记录文件与索引在同一笔里清：先 rm 文件再写索引。
        dirtySessions.delete(session);
        unpersistedIds.delete(session.id);
        removedSessionIds.add(session.id);
        markIndexDirty();
        await persistIndexNowOrThrow();
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
    // 索引文件（成员表 + 主题）。会话正文不在这里——见 sessionStatePath。
    statePath,
    sessionStateDir,
    sessionStatePath,
    sessions,
    // 落盘观测面：单拍写了几份/多少字节/多久、积压多深、合并了多少请求。测试用它
    // 断言「单拍成本不随会话数增长」，运维用它判断该不该看落盘。
    persistStats,
    // 恢复清扫的等入口：清扫要查命令行（异步、几百毫秒），restore 本身不等它。
    // 测试 await 它即可确定清扫已落定；生产路径没人等，跑完即止。
    get restoreSweep() { return restoreSweep; },
    // 异步化后「已落盘」不再随路由响应自动成立（onExit 这类回调路径是发后不管
    // 的），把这个等链入口暴露出来给测试做确定性等待：await 它即等完泵上全部
    // 在途写与欠账（没脏时是纯空跳）。
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
