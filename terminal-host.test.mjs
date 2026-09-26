import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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

// Captures every spawn (file/args/options) the host makes, so a test can assert
// the cmd wrapper and the merged environment without a real PTY.
function capturingPtyModule() {
  const calls = [];
  return {
    calls,
    ptyModule: {
      spawn: (file, args, options) => {
        const pty = new FakePty();
        calls.push({ file, args, options, pty });
        return pty;
      },
    },
  };
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

// One-click CLI Agent launch: POST /terminal/sessions accepts an optional
// launch (the cmd /c wrapper around the agent executable) plus an env delta of
// Anyswitch credentials. The wrapper is load-bearing for attribution: under
// ConPTY a directly-spawned agent's parent is conhost, which is NOT in
// agent-metrics' process scan list, so monitoring/metrics/recent requests
// would all lose the session — session.pid must be a cmd.exe (on the list).
test("agent launch：cmd 包装 spawn、注入值覆盖继承值、真键标删、会话身份变量在最后", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-test-`);
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;

  // A hostile inherited environment: a real upstream key and a corporate proxy
  // that relay traffic must never ride. Restored no matter how the test ends.
  const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const savedNoProxy = process.env.NO_PROXY;
  process.env.ANTHROPIC_API_KEY = "leaked-real-key";
  process.env.NO_PROXY = "http://corp-proxy:8080";
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({
        label: "Kimi Code",
        cwd: root,
        shell: "cmd",
        cols: 120,
        rows: 34,
        launch: { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\kimi.cmd"] },
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:47821",
          ANTHROPIC_AUTH_TOKEN: "relay-token-xyz",
          ANTHROPIC_API_KEY: null,
          NO_PROXY: "127.0.0.1,localhost",
        },
        agentId: "kimi",
        agentName: "Kimi Code",
      }),
    });
    assert.equal(created.status, 201);
    const snapshot = await created.json();

    assert.equal(calls.length, 1, "创建即 spawn");
    const spawn_ = calls[0];
    assert.equal(spawn_.file, process.env.ComSpec, "经 cmd 启动：session.pid 落在扫描名单内，归属不断");
    assert.deepEqual(spawn_.args, ["/d", "/c", "C:\\fake\\kimi.cmd"], "命令行只有可执行路径，无凭证");
    assert.equal(spawn_.options.env.ANTHROPIC_AUTH_TOKEN, "relay-token-xyz", "注入值覆盖同名继承值");
    assert.equal(spawn_.options.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:47821");
    assert.equal(spawn_.options.env.NO_PROXY, "127.0.0.1,localhost", "回环不走公司代理");
    assert.equal(spawn_.options.env.ANTHROPIC_API_KEY, undefined, "null 标删：上游真键不进 PTY");
    assert.equal(spawn_.options.env.TERM, "xterm-256color");
    assert.equal(spawn_.options.env.ANYSWITCH_TERMINAL_SESSION, snapshot.id);
    assert.equal(spawn_.options.cwd, root);

    assert.equal(snapshot.agentId, "kimi");
    assert.equal(snapshot.agentName, "Kimi Code");
    assert.deepEqual(snapshot.launch, { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\kimi.cmd"] });
    assert.equal("env" in snapshot, false, "快照不回显 env");

    // 密不上盘：落盘状态文件既无 env 键，也不含令牌明文。
    const persisted = JSON.parse(readFileSync(host.statePath, "utf8"));
    assert.equal(persisted.sessions.length, 1);
    assert.equal("env" in persisted.sessions[0], false, "env 绝不落盘");
    assert.equal(persisted.sessions[0].agentId, "kimi");
    assert.equal(persisted.sessions[0].agentName, "Kimi Code");
    assert.ok(persisted.sessions[0].launch, "非密 launch 元数据随会话落盘");
    const raw = readFileSync(host.statePath, "utf8");
    assert.ok(!raw.includes("relay-token-xyz"), "落盘文件不含令牌明文");
    assert.ok(!raw.includes("leaked-real-key"), "落盘文件不含被删掉的上游真键");
  } finally {
    if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    if (savedNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = savedNoProxy;
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore 后快照带 agentId/agentName/launch，且不自动重新 spawn", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-test-`);
  const first = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule: first.ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  await fetch(`http://127.0.0.1:${port}/terminal/sessions`, {
    method: "POST",
    headers: headers(host),
    body: JSON.stringify({
      label: "Claude Code", cwd: root, shell: "cmd",
      launch: { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\claude.exe"] },
      env: { ANTHROPIC_AUTH_TOKEN: "relay-token-xyz" },
      agentId: "claude", agentName: "Claude Code",
    }),
  });
  await host.close();

  const second = capturingPtyModule();
  const restored = createTerminalHost({ root, port: 0, ptyModule: second.ptyModule, logger: { warn() {} } });
  const restoredPort = await listen(restored);
  try {
    assert.equal(second.calls.length, 0, "restore 只还原元数据，不代跑 spawn");
    const listed = await fetch(`http://127.0.0.1:${restoredPort}/terminal/sessions`, { headers: headers(restored) }).then((r) => r.json());
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].agentId, "claude");
    assert.equal(listed.sessions[0].agentName, "Claude Code");
    assert.deepEqual(listed.sessions[0].launch, { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\claude.exe"] });
    assert.equal(listed.sessions[0].status, "exited");
    assert.equal("env" in listed.sessions[0], false);
  } finally {
    await restored.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart 接受可选 env 合并后再 spawn，响应不回显", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-test-`);
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({
        label: "Kimi Code", cwd: root, shell: "cmd",
        launch: { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\kimi.cmd"] },
        env: { ANTHROPIC_AUTH_TOKEN: "relay-token-old", ANTHROPIC_API_KEY: null },
        agentId: "kimi", agentName: "Kimi Code",
      }),
    }).then((r) => r.json());

    const restarted = await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "relay-token-new", EXTRA_FLAG: "1" } }),
    });
    assert.equal(restarted.status, 200);
    assert.equal(calls.length, 2, "restart 重新 spawn");
    const env = calls[1].options.env;
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "relay-token-new", "新注入覆盖旧值");
    assert.equal(env.EXTRA_FLAG, "1", "合并进新键");
    assert.equal(env.ANTHROPIC_API_KEY, undefined, "上一轮的 null 标删在合并后依然生效");
    assert.equal(env.ANYSWITCH_TERMINAL_SESSION, created.id);
    const body = await restarted.json();
    assert.equal("env" in body, false, "restart 响应同样不回显 env");

    // 不带 body 的 restart 保持原 env（旧调用方不受影响）。
    await fetch(url(`/terminal/sessions/${created.id}/restart`), { method: "POST", headers: headers(host) });
    assert.equal(calls[2].options.env.ANTHROPIC_AUTH_TOKEN, "relay-token-new", "无 body 时沿用会话内 env");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch/env 输入校验：畸形一律 400，cwd 缺失不静默回落", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-test-`);
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  const post = (body) => fetch(url("/terminal/sessions"), {
    method: "POST", headers: headers(host), body: JSON.stringify(body),
  });
  try {
    const cases = [
      ["相对路径 file", { cwd: root, launch: { file: "cmd.exe", args: [] } }, "invalid_launch"],
      ["args 非字符串", { cwd: root, launch: { file: process.env.ComSpec, args: [123] } }, "invalid_launch"],
      ["args 超量", { cwd: root, launch: { file: process.env.ComSpec, args: new Array(65).fill("x") } }, "invalid_launch"],
      ["env 嵌套值", { cwd: root, env: { A: { b: "c" } } }, "invalid_env"],
      ["env 非法键名", { cwd: root, env: { "BAD KEY": "v" } }, "invalid_env"],
      ["env 超长值", { cwd: root, env: { A: "x".repeat(32_001) } }, "invalid_env"],
      ["launch 会话 cwd 不存在", { cwd: `${root}\\gone`, launch: { file: process.env.ComSpec, args: ["/d", "/c", "x"] } }, "invalid_cwd"],
      ["launch 会话 cwd 为空", { cwd: "  ", launch: { file: process.env.ComSpec, args: ["/d", "/c", "x"] } }, "invalid_cwd"],
    ];
    for (const [name, body, error] of cases) {
      const response = await post(body);
      assert.equal(response.status, 400, name);
      assert.equal((await response.json()).error, error, name);
    }
    assert.equal(calls.length, 0, "畸形请求一个都不许 spawn");

    // 普通外壳会话不受影响：cwd 不存在仍静默回落（既有行为）。
    const plain = await post({ label: "新终端", cwd: `${root}\\gone`, shell: "powershell" });
    assert.equal(plain.status, 201);
    assert.equal(calls.length, 1);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
