import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createTerminalHost, stripTerminalReplyProbes, watchParentProcess, PARENT_WATCHDOG_INTERVAL_MS } from "./terminal-host.mjs";

class FakePty {
  constructor() {
    this.pid = 4321;
    this.cols = 80;
    this.rows = 24;
    this.dataListener = null;
    this.exitListener = null;
  }
  onData(fn) { this.dataListener = fn; }
  onExit(fn) { this.exitListener = fn; }
  write(data) { this.dataListener?.(`echo:${data}`); }
  resize(cols, rows) { this.cols = cols; this.rows = rows; }
  kill() { this.exitListener?.({ exitCode: 0 }); }
}

function headers(host) {
  return { authorization: `Bearer ${host.token}`, "content-type": "application/json" };
}

async function listen(host) {
  await new Promise((resolve, reject) => {
    host.server.once("error", reject);
    host.server.listen(0, "127.0.0.1", resolve);
  });
  return host.server.address().port;
}

test("terminal host owns persistent session metadata and PTY controls", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-test-`);
  const host = createTerminalHost({
    root,
    port: 0,
    ptyModule: { spawn: () => new FakePty() },
    logger: { warn() {} },
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const unauthorized = await fetch(url("/terminal/sessions"));
    assert.equal(unauthorized.status, 401);

    const createdResponse = await fetch(url("/terminal/sessions"), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({ label: "测试终端", cwd: root, shell: "powershell", cols: 100, rows: 30 }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.label, "测试终端");
    assert.equal(created.pid, 4321);
    assert.equal(created.status, "running");

    const inputResponse = await fetch(url(`/terminal/sessions/${created.id}/input`), {
      method: "POST", headers: headers(host), body: JSON.stringify({ data: "hello\r" }),
    });
    assert.equal(inputResponse.status, 200);
    const resized = await fetch(url(`/terminal/sessions/${created.id}/resize`), {
      method: "POST", headers: headers(host), body: JSON.stringify({ cols: 120, rows: 40 }),
    }).then((response) => response.json());
    assert.deepEqual({ cols: resized.cols, rows: resized.rows }, { cols: 120, rows: 40 });

    const state = await fetch(url(`/terminal/sessions/${created.id}`), { headers: headers(host) }).then((response) => response.json());
    assert.equal(state.status, "running");
    assert.ok(state.buffer.some((chunk) => chunk.includes("echo:hello")));

    await host.close();
    const restored = createTerminalHost({ root, port: 0, ptyModule: { spawn: () => new FakePty() }, logger: { warn() {} } });
    const restoredPort = await listen(restored);
    const listed = await fetch(`http://127.0.0.1:${restoredPort}/terminal/sessions`, { headers: headers(restored) }).then((response) => response.json());
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].id, created.id);
    assert.equal(listed.sessions[0].status, "exited", "restored metadata waits for explicit restart");
    await restored.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stripTerminalReplyProbes strips each query class", () => {
  const probes = {
    "DA1": "\x1b[c",
    "DA1 with zero param": "\x1b[0c",
    "DA2": "\x1b[>c",
    "DA2 with param": "\x1b[>0c",
    "DA3": "\x1b[=c",
    "DECRQM private": "\x1b[?1049$p",
    "DECRQM private multi-param": "\x1b[?2026;1$p",
    "DECRQM ANSI": "\x1b[2$p",
    "DSR cursor position": "\x1b[6n",
    "DSR status": "\x1b[5n",
    "DSR private": "\x1b[?6n",
    "DECRQSS with ST": "\x1bP$qm\x1b\\",
    "DECRQSS with BEL": "\x1bP$qm\x07",
    "XTGETTCAP": "\x1bP+q544e\x1b\\",
    "kitty keyboard query": "\x1b[?u",
    "kitty keyboard push": "\x1b[>7u",
    "kitty keyboard push multi-param": "\x1b[>1;2u",
  };
  for (const [name, probe] of Object.entries(probes)) {
    assert.equal(stripTerminalReplyProbes(probe), "", name);
  }
});

test("stripTerminalReplyProbes keeps drawing, answer bytes and text untouched", () => {
  const drawing = "\x1b[2J\x1b[H\x1b[1;31m红字\x1b[0m \x1b[?1004h\x1b[?9001h\x1b[?1049h\x1b[!p\x1b[2 q\x1b[\"q\x1b[?25l";
  assert.equal(stripTerminalReplyProbes(drawing), drawing, "colors, cursor moves, DECSET and other CSI pass through");
  const answers = "\x1b[?1;2c\x1b[>0;276;0c\x1b[?1049;2$y\x1b[1;1R\x1b[0n";
  assert.equal(stripTerminalReplyProbes(answers), answers, "terminal answers are not queries");
  const text = "Microsoft Windows PowerShell 提示符：路径 C:\用户\桌面 ✓";
  assert.equal(stripTerminalReplyProbes(text), text, "plain text with Chinese survives byte-identical");
  assert.equal(stripTerminalReplyProbes(""), "");
});

test("stripTerminalReplyProbes only acts on complete sequences", () => {
  assert.equal(stripTerminalReplyProbes(["前缀\x1b[", ">c后缀"].join("")), "前缀后缀", "probe split across chunks is caught after join");
  const cutTail = "输出\x1b[?1049";
  assert.equal(stripTerminalReplyProbes(cutTail), cutTail, "incomplete tail stays put");
  const cutDcs = "输出\x1bP$qm";
  assert.equal(stripTerminalReplyProbes(cutDcs), cutDcs, "unterminated DCS stays put");
  // 真实缓冲实物：PSReadLine 启动握手与 CLI 键盘协商（取自 terminal-sessions.json）
  assert.equal(stripTerminalReplyProbes("\x1b[c\x1b[?1004h\x1b[?9001h"), "\x1b[?1004h\x1b[?9001h");
  assert.equal(stripTerminalReplyProbes("\x1b[>7u\x1b[?u\x1b[c"), "");
});

test("stream() strips probes from replayed history but passes live chunks through", async () => {
  const root = mkdtempSync(`${tmpdir()}\anyswitch-terminal-test-`);
  let pty = null;
  const host = createTerminalHost({
    root,
    port: 0,
    ptyModule: { spawn: () => (pty = new FakePty()) },
    logger: { warn() {} },
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  const controller = new AbortController();
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({ label: "回放", cwd: root, shell: "powershell" }),
    }).then((response) => response.json());
    const session = host.sessions.get(created.id);
    session.buffer.push("启动横幅\r\n", "\x1b[c", "\x1b[?1049$p", "\x1b[1;32mPS> \x1b[0m", "\x1b[?u");

    const response = await fetch(url(`/terminal/sessions/${created.id}/stream`), {
      headers: { authorization: `Bearer ${host.token}` },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const readUntil = async (needle) => {
      while (!received.includes(needle)) {
        const { done, value } = await reader.read();
        assert.ok(!done, `stream ended before receiving ${JSON.stringify(needle)}`);
        received += decoder.decode(value, { stream: true });
      }
    };
    const frame = (payload) => `event: data\ndata: ${JSON.stringify(payload)}\n\n`;

    const strippedHistory = "启动横幅\r\n\x1b[1;32mPS> \x1b[0m";
    await readUntil(frame(strippedHistory));
    const replaySection = received.slice(0, received.indexOf(frame(strippedHistory)) + frame(strippedHistory).length);
    for (const probe of ["\x1b[c", "\x1b[?1049$p", "\x1b[?u"]) {
      assert.ok(!replaySection.includes(JSON.stringify(probe).slice(1, -1)), `replay must not contain ${JSON.stringify(probe)}`);
    }

    pty.dataListener("live:\x1b[c\x1b[6n");
    await readUntil(frame("live:\x1b[c\x1b[6n"));
    assert.ok(received.includes(frame("live:\x1b[c\x1b[6n")), "live chunks carry probes verbatim");
  } finally {
    controller.abort();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// watchParentProcess: the relay-owned child's death pact. Without a parent
// pid env (single runs, tests) nothing is scheduled; with one, a dead parent
// fires onDead exactly once. The timer is captured through an injected
// setIntervalFn — no real clock is armed here.
test("watchParentProcess fires onDead once when the parent is gone", () => {
  let tick = null;
  let interval = null;
  const timer = { unref() {} };
  let dead = 0;
  const handle = watchParentProcess({
    parentPid: 4242,
    isAlive: () => false,
    setIntervalFn: (fn, ms) => {
      tick = fn;
      interval = ms;
      return timer;
    },
    onDead: () => {
      dead += 1;
    },
  });

  assert.equal(handle, timer);
  assert.equal(interval, PARENT_WATCHDOG_INTERVAL_MS, "the pact polls on the 5s cadence");
  assert.equal(dead, 0, "arming the watcher never fires it");
  tick();
  assert.equal(dead, 1, "a dead parent triggers the host shutdown path");
  tick();
  assert.equal(dead, 1, "the shutdown path fires exactly once");
});

test("watchParentProcess stays quiet while the parent lives", () => {
  let tick = null;
  let dead = 0;
  watchParentProcess({
    parentPid: 4242,
    isAlive: () => true,
    setIntervalFn: (fn) => {
      tick = fn;
      return { unref() {} };
    },
    onDead: () => {
      dead += 1;
    },
  });

  tick();
  tick();
  assert.equal(dead, 0);
});

test("watchParentProcess without a parent pid leaves behavior untouched", () => {
  let scheduled = 0;
  const setIntervalFn = () => {
    scheduled += 1;
    return { unref() {} };
  };
  assert.equal(watchParentProcess({ parentPid: Number.NaN, setIntervalFn, onDead: () => {} }), null);
  assert.equal(watchParentProcess({ parentPid: 0, setIntervalFn, onDead: () => {} }), null);
  assert.equal(watchParentProcess({ parentPid: -5, setIntervalFn, onDead: () => {} }), null);
  assert.equal(scheduled, 0, "no parent pid, no poller — manual runs behave exactly as before");
});
