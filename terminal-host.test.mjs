import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createTerminalHost, stripTerminalReplyProbes, watchParentProcess, PARENT_WATCHDOG_INTERVAL_MS, WATCHDOG_MISSES_REQUIRED } from "./terminal-host.mjs";
import { createScreenMirror } from "./terminal-screen.mjs";

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

// PTY 已退出的会话此前会把输入无声丢弃还回 200（面板侧 .catch 看不到失败）。
// 这里走真实退出路径（FakePty.kill → onExit → session.pty 置空）钉住显式 409。
test("PTY 已退出的会话 POST input 返回 409 session_exited", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-test-`);
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({ label: "exited-input", cwd: root, shell: "powershell" }),
    }).then((response) => response.json());
    calls[0].pty.kill();
    const inputResponse = await fetch(url(`/terminal/sessions/${created.id}/input`), {
      method: "POST", headers: headers(host), body: JSON.stringify({ data: "hello\r" }),
    });
    assert.equal(inputResponse.status, 409);
    assert.deepEqual(await inputResponse.json(), { error: "session_exited" });
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// 回放窗口按字节计，不按块数计：忙的 TUI 每 ~80ms 一块，旧的 400 块上限只装得下
// 约 31 秒输出，而它喂的 xterm 留着 5000 行滚屏——整页刷新等于把用户眼前的历史丢掉。
// 这里钉四件事：窗口按字节裁、只整块从头部丢、轮询列表不带走窗口、落盘尾部另按更紧
// 的预算（整文件按防抖重写）。最后一件顺带钉住「从盘上恢复的会话，字节位是重算的」
// ——不重算就是 NaN 比较，裁尾静默失效，窗口无上限地长。
test("回放窗口按字节裁尾：整块丢、最新块必留、列表不带窗口、落盘尾部更紧", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-budget-`);
  const first = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule: first.ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path, base = port) => `http://127.0.0.1:${base}${path}`;
  const token = (h) => ({ authorization: `Bearer ${h.token}` });
  const waitPersist = () => new Promise((resolve) => setTimeout(resolve, 320));
  const KB = 1024;
  // FakePty 把写入原样回显成 "echo:<data>"，所以整块判据要连前缀一起认。
  const whole = /^echo:#\d+ x+$/;
  let restoredHost = null;
  let hostClosed = false;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: { ...token(host), "content-type": "application/json" },
      body: JSON.stringify({ label: "预算", cwd: root, shell: "powershell" }),
    }).then((response) => response.json());
    const pty = first.calls[first.calls.length - 1].pty;
    const marker = (index) => `#${index} `;
    const bigChunk = (index) => `${marker(index)}${"x".repeat(4 * KB)}`;
    for (let i = 0; i < 200; i += 1) pty.write(bigChunk(i));

    const live = await fetch(url(`/terminal/sessions/${created.id}`), { headers: token(host) }).then((r) => r.json());
    const liveBytes = Buffer.byteLength(live.buffer.join(""));
    assert.ok(live.buffer.length < 200, `裁尾后仍存 ${live.buffer.length} 块，等于按块数没裁动`);
    assert.ok(liveBytes <= 512 * KB, `内存窗口 ${liveBytes} 字节，超 512KB 预算`);
    assert.ok(liveBytes > 400 * KB, `内存窗口只剩 ${liveBytes} 字节，比改前的 400 块还小`);
    for (const kept of live.buffer) assert.ok(whole.test(kept), "只许整块丢，留下的每块都完整");
    assert.ok(live.buffer[live.buffer.length - 1].includes(marker(199)), "最新一块必留");
    assert.ok(!live.buffer.some((chunk) => chunk.includes(marker(0))), "最旧一块已丢出窗口");

    const listed = await fetch(url("/terminal/sessions"), { headers: token(host) }).then((r) => r.json());
    assert.equal(listed.sessions[0].buffer, undefined, "窗口属 SSE 流，不上百秒一轮的轮询列表");

    await waitPersist();
    const onDisk = JSON.parse(readFileSync(`${root}\\terminal-sessions.json`, "utf8"));
    const diskBytes = Buffer.byteLength(onDisk.sessions[0].buffer.join(""));
    assert.ok(diskBytes <= 128 * KB, `落盘尾部 ${diskBytes} 字节，超 128KB 预算`);
    assert.ok(diskBytes > 100 * KB, `落盘尾部只剩 ${diskBytes} 字节，裁得比预算狠`);
    assert.ok(diskBytes < liveBytes, "落盘尾部紧于内存窗口：整文件重写按防抖跑");
    assert.ok(onDisk.sessions[0].buffer.every((chunk) => whole.test(chunk)), "落盘尾部同样整块");
    await host.close();
    hostClosed = true;

    // 从盘上恢复后继续输出：裁尾仍按字节生效（字节位重算过，不是 undefined/NaN）
    const second = capturingPtyModule();
    restoredHost = createTerminalHost({ root, port: 0, ptyModule: second.ptyModule, logger: { warn() {} } });
    const restoredPort = await listen(restoredHost);
    const restoredSession = restoredHost.sessions.get(created.id);
    assert.equal(restoredSession.pty, null, "恢复的会话不自动复活");
    assert.ok(restoredSession.bufferBytes > 100 * KB && restoredSession.bufferBytes <= 128 * KB,
      `恢复即按盘上尾部重算字节位（实得 ${restoredSession.bufferBytes}）`);
    await fetch(url(`/terminal/sessions/${created.id}/restart`, restoredPort), {
      method: "POST", headers: { ...token(restoredHost), "content-type": "application/json" }, body: "{}",
    });
    const revived = second.calls[second.calls.length - 1].pty;
    // 单块就超整份预算：最新一块必须留着，窗口不得变成无上限
    revived.write(`${marker(900)}${"y".repeat(600 * KB)}`);
    const afterRestore = await fetch(url(`/terminal/sessions/${created.id}`, restoredPort), { headers: token(restoredHost) }).then((r) => r.json());
    assert.equal(afterRestore.buffer.length, 1, "超预算的单块独占窗口，旧块整块让位");
    assert.ok(afterRestore.buffer[0].includes(marker(900)), "留下的就是最新那块");
    const restoredLive = restoredHost.sessions.get(created.id);
    assert.ok(Number.isFinite(restoredLive.bufferBytes) && restoredLive.bufferBytes > 0,
      "字节位保持有限值（NaN 比较会让裁尾静默失效）");

    // 落盘尾部同样「最新一块无条件留」：单块超 128KB 预算也得存下去，
    // 否则宿主再重启一次，恢复回来的就是一块白屏而不是那张画满的屏。
    await waitPersist();
    const diskAgain = JSON.parse(readFileSync(`${root}\\terminal-sessions.json`, "utf8"));
    assert.equal(diskAgain.sessions[0].buffer.length, 1, "超预算的单块照样落盘");
    assert.ok(diskAgain.sessions[0].buffer[0].includes(marker(900)), "落的就是最新那块");
  } finally {
    if (!hostClosed) await host.close().catch(() => {});
    if (restoredHost) await restoredHost.close().catch(() => {});
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

// SSE 是长连接：读一帧就要主动 abort，等 response.text() 会永远挂住。
async function firstReplayFrame(response, controller) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = "";
  try {
    while (true) {
      const start = received.indexOf("event: data\ndata:");
      if (start >= 0) {
        const end = received.indexOf("\n\n", start + 17);
        if (end > 0) return JSON.parse(received.slice(start + 17, end));
      }
      const { done, value } = await reader.read();
      if (done) throw new Error("stream ended before the replay frame");
      received += decoder.decode(value, { stream: true });
    }
  } finally {
    controller.abort();
  }
}

// A full-screen TUI repaints with relative moves, so replaying a head-truncated byte
// window leaves the picture floating (measured on a live kimi session: zero scrolls,
// ~20 blank rows under the frame, nothing above the frame reachable). The host now
// replays its rendered mirror instead. This drives the HTTP route end to end and
// re-parses the replay exactly as xterm would.
test("stream() 回放走渲染镜像：TUI 重绘后画面落底、历史逐行回得来", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-mirror-`);
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
  const frame = (index, height = 10) => {
    let out = "\x1b[?2026h\x1b[" + height + "A";
    for (let line = 0; line < height; line += 1) out += `\r\x1b[2K帧${index}第${line}行${"z".repeat(8)}\r\n`;
    return out + `\x1b[${height - 3}B\x1b[6G\x1b[?2026l`;
  };
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({ label: "镜像", cwd: root, shell: "powershell", cols: 60, rows: 12 }),
    }).then((response) => response.json());
    for (let i = 1; i <= 40; i += 1) pty.dataListener(`转录行 ${i} ${"y".repeat(20)}\r\n`);
    for (let f = 0; f < 25; f += 1) pty.dataListener(frame(f));

    const response = await fetch(url(`/terminal/sessions/${created.id}/stream`), {
      headers: { authorization: `Bearer ${host.token}` },
      signal: controller.signal,
    });
    const replay = await firstReplayFrame(response, controller);
    assert.ok(replay.includes("\x1b[2J"), "回放必须是自足重绘（先清屏）");
    assert.ok(/\x1b\[\d+;1H/.test(replay), "回放必须用绝对定位落位，而不是靠相对位移猜");
    assert.ok(!/\x1b\[6n|\x1b\[c/.test(replay), "渲染出来的回放里不该再有查询探针");

    const again = createScreenMirror({ cols: 60, rows: 12 });
    again.write(replay);
    const lines = again.screenLines();
    let last = 0;
    for (let r = lines.length - 1; r >= 0; r -= 1) if (lines[r].trim() !== "") { last = r + 1; break; }
    assert.ok(last >= 9, `回放后画面必须落在底部区，实得第 ${last}/12 行（浮空即用户看到的「每刷一次上移一段」）`);
    assert.ok(lines.join("|").includes("帧24第9行"), "最后一帧的内容必须原样回来");
    const history = again.historyLines();
    const live = host.sessions.get(created.id).screen.info();
    assert.equal(history.length, live.historyLines, "滚动区必须逐行等价，不多不少");
    assert.ok(history.some((line) => line.includes("转录行 5")), "刷新前视窗之上的内容必须还能滚回去");
  } finally {
    controller.abort();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// The durable format is still the raw byte tail this round: after a host restart the
// mirror is rebuilt from that tail, so the replay must still come back painted and
// still carry what the tail covered.
test("宿主换新进程后由盘上尾部重建镜像，回放仍出画面不出白屏", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-restore-mirror-`);
  const first = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule: first.ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path, base = port) => `http://127.0.0.1:${base}${path}`;
  let restoredPort = null;
  let restored = null;
  const controller = new AbortController();
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: { ...headers(host), authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ label: "重启", cwd: root, shell: "powershell", cols: 40, rows: 8 }),
    }).then((response) => response.json());
    const pty = first.calls[first.calls.length - 1].pty;
    for (let i = 1; i <= 12; i += 1) pty.dataListener(`盘上行 ${i}\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 320));
    await host.close();

    restored = createTerminalHost({
      root,
      port: 0,
      ptyModule: { spawn: () => new FakePty() },
      logger: { warn() {} },
    });
    restoredPort = await listen(restored);
    const session = restored.sessions.get(created.id);
    assert.ok(session.screen.info().consumedBytes > 0, "恢复即把盘上尾部喂进镜像");
    const response = await fetch(url(`/terminal/sessions/${created.id}/stream`, restoredPort), {
      headers: { authorization: `Bearer ${restored.token}` },
      signal: controller.signal,
    });
    const replay = await firstReplayFrame(response, controller);
    assert.ok(replay.includes("盘上行 12"), `重建后的回放要带回首屏内容，实得 ${JSON.stringify(replay.slice(-80))}`);
  } finally {
    controller.abort();
    if (restored) await restored.close();
    rmSync(root, { recursive: true, force: true });
  }
});


// watchParentProcess: the relay-owned child's death pact. Without a parent
// pid env (single runs, tests) nothing is scheduled; with one, a dead parent
// fires onDead exactly once after missesRequired consecutive dead verdicts
// (any live verdict resets the count). The timer is captured through an
// injected setIntervalFn — no real clock is armed here.
test("watchParentProcess fires onDead once when the parent is gone", () => {
  let tick = null;
  let interval = null;
  const timer = { unref() {} };
  let dead = 0;
  const handle = watchParentProcess({
    parentPid: 4242,
    isAlive: () => false,
    missesRequired: 1,
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

// isPidAlive 是 tasklist 同步探测，负载抖动下一次超时/报错就会被判成 false——
// 单次 miss 不该触发死亡契约，存活判定要清零重新计数。
test("watchParentProcess 单次 miss 不触发：false 之后出现 true 即清零", () => {
  const verdicts = [false, true, false, true];
  let call = 0;
  let tick = null;
  let dead = 0;
  watchParentProcess({
    parentPid: 4242,
    isAlive: () => verdicts[call++ % verdicts.length],
    missesRequired: 2,
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
  tick();
  tick();
  assert.equal(dead, 0, "isolated misses never fire the pact");
});

test("watchParentProcess 连续 miss 达到 missesRequired 才恰好触发一次", () => {
  let tick = null;
  let dead = 0;
  watchParentProcess({
    parentPid: 4242,
    isAlive: () => false,
    missesRequired: 3,
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
  assert.equal(dead, 0, "below missesRequired the host stays up");
  tick();
  assert.equal(dead, 1, "the consecutive-miss threshold fires the pact");
  tick();
  assert.equal(dead, 1, "the shutdown path fires exactly once");
});

test("watchParentProcess 存活判定复位计数：复位后重新数满才触发", () => {
  const verdicts = [false, false, true, false, false, false];
  let call = 0;
  let tick = null;
  let dead = 0;
  watchParentProcess({
    parentPid: 4242,
    isAlive: () => verdicts[call++ % verdicts.length],
    missesRequired: 3,
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
  tick(); // 存活：前两次 miss 作废
  tick();
  tick();
  assert.equal(dead, 0, "the count restarts from zero after a live verdict");
  tick();
  assert.equal(dead, 1, "only misses counted after the reset reach the threshold");
});

// 默认不注入 missesRequired 时取 WATCHDOG_MISSES_REQUIRED：误杀两次实锤的代价比
// 晚触发约 25 秒（5 次 × 5s 轮询）高得多，这个值不许被悄悄改小。
test("watchParentProcess 默认阈值取 WATCHDOG_MISSES_REQUIRED", () => {
  let tick = null;
  let dead = 0;
  watchParentProcess({
    parentPid: 4242,
    isAlive: () => false,
    setIntervalFn: (fn) => {
      tick = fn;
      return { unref() {} };
    },
    onDead: () => {
      dead += 1;
    },
  });

  assert.equal(WATCHDOG_MISSES_REQUIRED, 5);
  for (let i = 1; i <= WATCHDOG_MISSES_REQUIRED; i += 1) {
    tick();
    assert.equal(dead, i < WATCHDOG_MISSES_REQUIRED ? 0 : 1, `tick ${i}`);
  }
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
