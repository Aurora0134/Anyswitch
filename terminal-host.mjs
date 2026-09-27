// Persistent loopback terminal host.
//
// The panel is a disposable browser client. PTYs live in this separate
// process so a panel reload/restart only drops the browser stream, not the
// shell or CLI process behind it.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as pty from "node-pty";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { createScreenMirror } from "./terminal-screen.mjs";
import { TERMINAL_PARENT_PID_ENV } from "./terminal-process-manager.mjs";
import { isPidAlive } from "./relay-process-manager.mjs";

export const TERMINAL_HOST_PORT = 47823;
export const PARENT_WATCHDOG_INTERVAL_MS = 5000;
const TERMINAL_STATE_FILE = "terminal-sessions.json";
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

export function createTerminalHost({ root, port = TERMINAL_HOST_PORT, ptyModule = pty, spawnFn = spawn, logger = console } = {}) {
  const dataRoot = root || join(process.env.LOCALAPPDATA || process.cwd(), "Anyswitch");
  mkdirSync(dataRoot, { recursive: true });
  const statePath = join(dataRoot, TERMINAL_STATE_FILE);
  const sessions = new Map();
  const token = loadOrGenerateToken(dataRoot);
  let persistTimer = null;

  function persistNow() {
    mkdirSync(dataRoot, { recursive: true });
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
    writeFileSync(statePath, JSON.stringify({ version: 1, sessions: state }, null, 2), "utf8");
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
    for (const listener of session.listeners) listener(String(chunk));
    schedulePersist();
  }

  function attach(session, child) {
    session.pty = child;
    session.pid = child.pid ?? session.pid;
    child.onData((data) => emit(session, data));
    child.onExit(({ exitCode }) => {
      session.exitCode = exitCode;
      session.pty = null;
      session.lastActiveAt = Date.now();
      persistNow();
      for (const listener of session.listeners) listener(null);
    });
    persistNow();
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
    const listener = (chunk) => {
      if (chunk === null) res.write("event: exit\ndata: {}\n\n");
      else res.write(`event: data\ndata: ${JSON.stringify(chunk)}\n\n`);
    };
    session.listeners.add(listener);
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15000);
    const close = () => {
      clearInterval(heartbeat);
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
        spawnSession(session);
        return json(res, 201, snapshot(session));
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
        session.pty?.write(body.data);
        session.lastActiveAt = Date.now();
        return json(res, 200, { ok: true });
      }
      if (action === "resize" && req.method === "POST") {
        const body = await readBody(req);
        const cols = Math.max(2, Math.min(240, Number(body.cols) || session.cols));
        const rows = Math.max(1, Math.min(120, Number(body.rows) || session.rows));
        session.cols = cols;
        session.rows = rows;
        try {
          if (!session.screen) session.screen = createScreenMirror({ cols, rows });
          else session.screen.resize(cols, rows);
        } catch (error) {
          logger.warn?.(`[terminal-host] screen mirror resize skipped (${session.id}): ${error.message}`);
        }
        session.pty?.resize(cols, rows);
        persistNow();
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
        if (session.pty) session.pty.kill();
        session.exitCode = null;
        session.buffer = [];
        session.bufferBytes = 0;
        // A respawn is a blank screen for the application too: the mirror's history
        // belongs to the process that just died.
        session.screen = createScreenMirror({ cols: session.cols, rows: session.rows });
        spawnSession(session);
        return json(res, 200, snapshot(session));
      }
      if (action === "close" && req.method === "POST") {
        session.pty?.kill();
        sessions.delete(session.id);
        persistNow();
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
    close: async () => {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      persistNow();
      for (const session of sessions.values()) session.listeners.clear();
      await new Promise((resolve) => server.close(resolve));
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

// Death pact with the owning relay: a non-detached Windows child does NOT die
// with its parent, and the pre-update history of this host (detached and
// ownerless, outliving every app update) is exactly the failure being closed
// out. While TERMINAL_PARENT_PID_ENV names a live relay, the relay's graceful
// shutdown kills this child first; this poller is the backstop for every path
// that doesn't (hard kill of the relay alone, fatal exit). Returns null when
// no valid parent pid was supplied, leaving manual/test runs untouched.
export function watchParentProcess({
  parentPid,
  isAlive = isPidAlive,
  intervalMs = PARENT_WATCHDOG_INTERVAL_MS,
  setIntervalFn = setInterval,
  onDead,
}) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return null;
  let fired = false;
  const timer = setIntervalFn(() => {
    if (fired || isAlive(parentPid)) return;
    fired = true;
    onDead?.();
  }, intervalMs);
  timer.unref?.();
  return timer;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase();
if (isMain) {
  startTerminalHost().then((host) => {
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
