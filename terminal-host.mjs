// Persistent loopback terminal host.
//
// The panel is a disposable browser client. PTYs live in this separate
// process so a panel reload/restart only drops the browser stream, not the
// shell or CLI process behind it.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as pty from "node-pty";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";

export const TERMINAL_HOST_PORT = 47823;
const TERMINAL_STATE_FILE = "terminal-sessions.json";
const APP_DIR = fileURLToPath(new URL(".", import.meta.url));

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
    buffer: session.buffer,
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
      buffer: session.buffer.slice(-200),
      status: session.pty ? "running" : "exited",
      exitCode: session.exitCode,
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
        sessions.set(item.id, { ...item, pty: null, listeners: new Set(), buffer: Array.isArray(item.buffer) ? item.buffer : [] });
      }
    } catch {
      // First start or a partially written state file: start empty.
    }
  }

  function emit(session, chunk) {
    session.buffer.push(String(chunk));
    if (session.buffer.length > 400) session.buffer.splice(0, session.buffer.length - 400);
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
    const spec = shellSpec(session.shell);
    const child = ptyModule.spawn(spec.file, spec.args, {
      name: "xterm-256color",
      cols: session.cols,
      rows: session.rows,
      cwd: safeCwd(session.cwd),
      env: { ...process.env, TERM: "xterm-256color", ANYSWITCH_TERMINAL_SESSION: session.id },
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
    res.write(`event: snapshot\ndata: ${JSON.stringify({ ...snapshot(session), buffer: [] })}\n\n`);
    for (const chunk of session.buffer) res.write(`event: data\ndata: ${JSON.stringify(chunk)}\n\n`);
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
        const shell = body.shell === "cmd" ? "cmd" : "powershell";
        const session = {
          id: randomUUID(),
          label: typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : "新终端",
          cwd: safeCwd(body.cwd),
          shell,
          pid: null,
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          cols: Math.max(2, Math.min(240, Number(body.cols) || 120)),
          rows: Math.max(1, Math.min(120, Number(body.rows) || 34)),
          exitCode: null,
          buffer: [],
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
      if (!action && req.method === "GET") return json(res, 200, snapshot(session));
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
        session.pty?.resize(cols, rows);
        persistNow();
        return json(res, 200, { ok: true, cols, rows });
      }
      if (action === "restart" && req.method === "POST") {
        if (session.pty) session.pty.kill();
        session.exitCode = null;
        session.buffer = [];
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

const isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase();
if (isMain) {
  startTerminalHost().then((host) => {
    process.on("SIGINT", () => host.close().then(() => process.exit(0)));
    process.on("SIGTERM", () => host.close().then(() => process.exit(0)));
  }).catch((error) => {
    process.stderr.write(`[terminal-host] failed: ${error.stack || error}\n`);
    process.exit(1);
  });
}
