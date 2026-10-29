import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalHost, createTerminalQueryScanner, stripTerminalReplyProbes, watchParentProcess, installTerminalHostFaultHandlers, PARENT_WATCHDOG_INTERVAL_MS, WATCHDOG_MISSES_REQUIRED, TERMINAL_STATE_FILE } from "./terminal-host.mjs";
import { createScreenMirror } from "./terminal-screen.mjs";

class FakePty {
  constructor() {
    this.pid = 4321;
    this.cols = 80;
    this.rows = 24;
    this.dataListener = null;
    this.exitListener = null;
    this.resizeCalls = [];
    this.writeLog = [];
  }
  onData(fn) { this.dataListener = fn; }
  onExit(fn) { this.exitListener = fn; }
  write(data) { this.writeLog.push(data); this.dataListener?.(`echo:${data}`); }
  resize(cols, rows) {
    this.resizeCalls.push([cols, rows]);
    this.cols = cols;
    this.rows = rows;
  }
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 落盘形态：索引（成员表 id + 主题）＋ 每会话一份记录文件。要读某条会话的正文
// 就走 host.sessionStatePath(id)——路径由宿主给出，测试不自己拼目录。
function readSessionRecord(host, id) {
  return JSON.parse(readFileSync(host.sessionStatePath(id), "utf8"));
}

// 记录的恢复原料是渲染快照（screen，v2 起）。要判「某段输出到没到盘上」，看快照
// 里的渲染行：屏幕行 + 滚动区行的序列化文本。快照的行格式就是镜像自己的
// serializeRow 输出（SGR 标注串），字面标记直接 includes 就能认。
function recordScreenText(record) {
  const screen = record.screen && Array.isArray(record.screen.screen) ? record.screen.screen : [];
  const history = record.screen && Array.isArray(record.screen.history) ? record.screen.history : [];
  return [...history, ...screen].map((row) => (row && typeof row.t === "string" ? row.t : "")).join("\n");
}

// SSE 帧采集器：后台持续读流、按 "\n\n" 切帧、解析 event:/data: 两行、追加进
// frames，直到连接结束或被 abort 打断。合帧用例要数「一个窗口内出了几帧」，
// 任何一次被半途弃置的读取都会吞掉后续数据让帧数失真，所以这里从不停读：
// 断言在任意时刻看 frames 快照即可。等特定帧用 waitForSseFrame 轮询（带
// 上限防挂死）。
function startSseCollector(response) {
  const frames = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const settled = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const eventLine = raw.split("\n").find((line) => line.startsWith("event: "));
          if (!eventLine) continue; // 心跳注释帧（": keep-alive"）没有 event 行
          const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
          frames.push({ event: eventLine.slice(7), data: dataLine?.slice(6) });
        }
      }
    } catch {
      /* abort 打断了流——采集到此为止 */
    }
  })();
  return { frames, settled };
}

async function waitForSseFrame(collector, eventName, { timeoutMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!collector.frames.some((frame) => frame.event === eventName)) {
    if (Date.now() >= deadline) return false;
    await sleep(5);
  }
  return true;
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

// 工作态信号收窄（dsh 语义对齐·信号层）：出生不再播种 lastActiveAt（出生≠活跃，
// 播种会让刚打开的空会话在前 5s 误转圈、M12 内切门误判 working 走保护性新开）；
// 键入改记 lastInputAt、不刷新 lastActiveAt（PTY 回显的判忙交给面板键入抑制窗）；
// spawn 记 spawnedAt（孵化豁免窗锚点——内切/复活保记录换进程，createdAt 不动，
// 只有它跟着每次 spawn 走）。pty 用不回显的哑件：把「键入→回显走 emit 刷新
// lastActiveAt」的老通路断开，才能单独观察 input 路由写字段的效果。
test("会话信号面：出生不播种 lastActiveAt、键入记 lastInputAt、spawn 记 spawnedAt（restart 换新生日）", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-signal-`);
  const silentPty = () => ({
    pid: 7777,
    onData() {}, onExit() {}, write() {}, resize() {}, kill() {},
  });
  const host = createTerminalHost({ root, port: 0, ptyModule: { spawn: () => silentPty() }, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "信号", cwd: root, shell: "cmd" }),
    }).then((response) => response.json());
    assert.equal(created.lastActiveAt, undefined, "出生不播种 lastActiveAt（出生≠活跃）");
    assert.equal(created.lastInputAt, undefined, "从未键入没有 lastInputAt");
    assert.ok(Number.isFinite(created.spawnedAt), "快照透传进程生日 spawnedAt（孵化豁免窗锚点）");

    await fetch(url(`/terminal/sessions/${created.id}/input`), {
      method: "POST", headers: headers(host), body: JSON.stringify({ data: "ls\r" }),
    });
    const afterInput = await fetch(url(`/terminal/sessions/${created.id}`), { headers: headers(host) }).then((response) => response.json());
    assert.ok(Number.isFinite(afterInput.lastInputAt), "键入记 lastInputAt");
    assert.equal(afterInput.lastActiveAt, undefined, "键入不再刷新 lastActiveAt（回显判忙交给面板键入抑制窗）");

    // restart（内切/复活共用咽喉）：换进程换新生日，记录生日 createdAt 原地不动。
    await sleep(5);
    const restarted = await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST", headers: headers(host), body: JSON.stringify({}),
    }).then((response) => response.json());
    assert.ok(Number.isFinite(restarted.spawnedAt) && restarted.spawnedAt > created.spawnedAt,
      "重 spawn 换新生日（孵化窗跟着新进程的 banner/续接重放走）");
    assert.equal(restarted.createdAt, created.createdAt, "记录生日 createdAt 不随 restart 漂移（会话绑定窗口不吃换壳）");
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
test("回放窗口按字节裁尾：整块丢、最新块必留、列表不带窗口、落盘换渲染快照", async () => {
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
    // persistNow 异步化后，防抖拍到点 ≠ 写已落定：显式等泵尾兜底（没脏时它是
    // 纯空跳，脏还在就直接冲），下面两次读盘不再跟在途写赛跑。
    await host.persistNow();
    const onDisk = readSessionRecord(host, created.id);
    // 落盘原料换成渲染快照（v2）：记录含 screen、不再带字节尾
    assert.equal(onDisk.buffer, undefined, "字节尾不再落盘（恢复原料换成渲染快照）");
    assert.ok(onDisk.screen && typeof onDisk.screen === "object", "落盘的是渲染快照");
    assert.equal(onDisk.screen.screen.length, onDisk.rows, "屏幕行整屏落盘（最低交付物）");
    assert.ok(onDisk.screen.consumedBytes > 0, "consumedBytes 随快照落盘（stream 的渲染回放门槛）");
    const snapText = recordScreenText(onDisk);
    assert.ok(snapText.includes("echo:#199"), "最新内容在快照里（画面+滚动区）");
    await host.close();
    hostClosed = true;

    // 从盘上恢复：画面按快照整屏回来，不再按字节尾近似重建
    const second = capturingPtyModule();
    restoredHost = createTerminalHost({ root, port: 0, ptyModule: second.ptyModule, logger: { warn() {} } });
    const restoredPort = await listen(restoredHost);
    const restoredSession = restoredHost.sessions.get(created.id);
    assert.equal(restoredSession.pty, null, "恢复的会话不自动复活");
    assert.ok(restoredSession.screen.info().consumedBytes > 0, "恢复的会话过渲染回放门槛");
    assert.ok(restoredSession.screen.toReplay().includes("echo:#199"), "恢复画面带最新内容");
    assert.equal(restoredSession.bufferBytes, 0, "字节尾不落盘：恢复的内存窗口从空起");
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
    // 巨行的开头早被镜像 5000 行滚动上限甩出去（快照只装最新画面），
    // 再补一个小标记当「最新内容」的判据
    revived.write("after-mega");

    // 落盘快照同样「屏幕行无条件留」：下一笔记录至少带整份当前屏
    await waitPersist();
    await restoredHost.persistNow();
    const diskAgain = readSessionRecord(restoredHost, created.id);
    assert.equal(diskAgain.screen.screen.length, diskAgain.rows, "屏幕行整屏保留");
    assert.ok(recordScreenText(diskAgain).includes("echo:after-mega"), "最新内容在快照里");
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

test("stream() 回放与活流都不携带宿主已认领的询问；未认领的照常转发", async () => {
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

    // 活流同口径：宿主认领的询问（DA1 / OSC 11 背景色）就地作答并从转发流里
    // 摘掉，免得渲染器再答一遍；没认领的（这里的 DSR 光标位置询问）原样转发。
    // FakePty 会把写回的字节当输入回显，回显与活块落在同一帧里（合帧窗口内），
    // 因此按「帧里出现过这段活块文本」判定，而不是整帧相等。
    pty.dataListener("live:\x1b[c\x1b]11;?\x07\x1b[6n");
    const liveNeedle = JSON.stringify("live:\x1b[6n").slice(1, -1);
    await readUntil(liveNeedle);
    const liveSection = received.slice(received.indexOf(liveNeedle));
    assert.ok(!liveSection.includes(JSON.stringify("\x1b[c").slice(1, -1)), "DA1 询问不进活流");
    assert.ok(!liveSection.includes(JSON.stringify("\x1b]11;?").slice(1, -1)), "OSC 11 询问不进活流");
    assert.deepEqual(pty.writeLog, ["\x1b[?1;2c", "\x1b]11;rgb:0b0b/1212/2020\x07"], "宿主即答 DA1 与背景色");
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

// ---------------------------------------------------------------------------
// 性能改造钉子。三处病灶各自的回归防线：同尺寸 resize 短路（①）、SSE data 帧
// 合帧（②）、脏位门控与异步原子写（③④）、落盘不再随会话数线性膨胀（⑥⑦⑧）。
// 观察手段说明：
//   - 「写没写盘」用 mtimeMs 判：内容比对分不出「重写了同样的内容」和「没写」，
//     NTFS 的 100ns 时间戳分得出；断言前 sleep 25ms 只为跨过时钟粒度，不是在
//     等异步写落定——落定一律走 await host.persistNow()（等泵尾，没脏时空跳）。
//   - 「帧数/帧序」用 SSE 帧读取器数：窗口值由测试注入，让每个断言都不依赖
//     真实时钟的运气（合帧用小窗口，exit/阈值冲刷用大到永不到点的窗口）。
//   - 「落盘成本随会话数怎么变」用相对口径（⑥⑦）：仓里没有假时钟，绝对毫秒
//     阈值必然 flaky，而「N 翻倍时单拍写了几份/多少字节」是纯结构量，可判死。

// ① 前端 fit 后无条件补发 resize：同尺寸请求不得再走 ConPTY 重排与整份落盘。
test("① 同尺寸 resize 短路：不调 pty.resize、不重写状态文件", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-samesize-"));
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "同尺寸", cwd: root, shell: "powershell", cols: 100, rows: 30 }),
    }).then((r) => r.json());
    const pty = calls[0].pty;
    assert.deepEqual(pty.resizeCalls, [], "起点：创建后的 FakePty 未被重排过");

    const before = statSync(host.sessionStatePath(created.id));
    await sleep(25); // 只为跨过 mtime 粒度，让「没写」可判

    const same = await fetch(url(`/terminal/sessions/${created.id}/resize`), {
      method: "POST", headers: headers(host), body: JSON.stringify({ cols: 100, rows: 30 }),
    });
    assert.equal(same.status, 200);
    assert.deepEqual(await same.json(), { ok: true, cols: 100, rows: 30 }, "短路响应与全路径同形");
    await host.persistNow(); // 没脏即空跳；有脏即冲净——两种结果都算落定
    assert.deepEqual(pty.resizeCalls, [], "同尺寸 resize 不调 pty.resize（ConPTY 重排是多开卡顿源之一）");
    const after = statSync(host.sessionStatePath(created.id));
    assert.equal(after.mtimeMs, before.mtimeMs, "同尺寸 resize 不重写这条会话的记录文件");

    // 对照组：尺寸真变了，全路径照旧——重排发生、盘上尺寸更新。
    const changed = await fetch(url(`/terminal/sessions/${created.id}/resize`), {
      method: "POST", headers: headers(host), body: JSON.stringify({ cols: 120, rows: 40 }),
    }).then((r) => r.json());
    assert.deepEqual(changed, { ok: true, cols: 120, rows: 40 });
    assert.deepEqual(pty.resizeCalls, [[120, 40]], "尺寸不同时 pty.resize 照常调用");
    const persisted = readSessionRecord(host, created.id);
    assert.equal(persisted.cols, 120, "实际变化的 resize 照常落盘");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ②-a 合帧本体：同一窗口内的多块输出合并成一个 data 帧（拼接语义不变），且
// 多连接共享同一会话时各自独立合帧；下一批输出进入下一个窗口，节律持续。
test("② SSE data 帧合帧：一个窗口多块合一帧、多连接各自独立", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-coalesce-"));
  let pty = null;
  const host = createTerminalHost({
    root,
    port: 0,
    ptyModule: { spawn: () => (pty = new FakePty()) },
    logger: { warn() {} },
    sseCoalesceWindowMs: 4,
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  const controllers = [];
  const collectors = [];
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "合帧", cwd: root, shell: "powershell" }),
    }).then((r) => r.json());

    for (let i = 0; i < 2; i += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(url(`/terminal/sessions/${created.id}/stream`), {
        headers: { authorization: `Bearer ${host.token}` }, signal: controller.signal,
      });
      assert.equal(response.status, 200);
      collectors.push(startSseCollector(response));
    }

    // 同一个 tick 连写五块：正确行为是攒进缓冲、窗口到点合成一帧。
    for (const piece of ["块一", "块二", "块三", "块四", "块五"]) pty.dataListener(piece);
    await sleep(60); // 窗口 4ms 的十倍以上，定时器必然已到点
    for (const [index, collector] of collectors.entries()) {
      const data = collector.frames.filter((frame) => frame.event === "data");
      assert.equal(data.length, 1, `连接 ${index}：五块输出只出一个 data 帧（逐块一帧是回归）`);
      assert.equal(collector.frames[0].event, "snapshot", "snapshot 帧仍在最前，不被合帧器吞并");
      assert.equal(JSON.parse(data[0].data), "块一块二块三块四块五", `连接 ${index}：合并帧的拼接语义不变`);
    }

    // 第二批进入下一个窗口：合帧是持续节律，不是只有第一帧。
    pty.dataListener("块六");
    pty.dataListener("块七");
    await sleep(60);
    for (const [index, collector] of collectors.entries()) {
      const data = collector.frames.filter((frame) => frame.event === "data");
      assert.equal(data.length, 2, `连接 ${index}：第二批同样只出一帧`);
      assert.equal(JSON.parse(data[1].data), "块六块七", `连接 ${index}：第二批内容正确`);
    }
  } finally {
    for (const controller of controllers) controller.abort();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ②-b exit 顺序：窗口拉大到永不到点，pending 只能靠 exit 的前置冲净出来——
// 最后一屏排在退出帧之前，帧序不能倒。整段在同一个 tick 内完成，零时钟依赖。
test("② SSE exit 先冲净 pending 再发 exit 帧：最后一屏不丢、帧序不倒", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-exitorder-"));
  let pty = null;
  const host = createTerminalHost({
    root,
    port: 0,
    ptyModule: { spawn: () => (pty = new FakePty()) },
    logger: { warn() {} },
    sseCoalesceWindowMs: 5000,
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  const controller = new AbortController();
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "退出顺序", cwd: root, shell: "powershell" }),
    }).then((r) => r.json());
    const response = await fetch(url(`/terminal/sessions/${created.id}/stream`), {
      headers: { authorization: `Bearer ${host.token}` }, signal: controller.signal,
    });
    const collector = startSseCollector(response);

    pty.dataListener("最后一块");
    pty.kill(); // 同一 tick：pending 还在缓冲里，只有 exit 的冲净能把它送出去
    assert.ok(
      await waitForSseFrame(collector, "exit", { timeoutMs: 300 }),
      "exit 帧必须及时出现（窗口永不到点也等得到，否则就是 exit 前没冲净）",
    );
    assert.deepEqual(collector.frames.map((frame) => frame.event), ["snapshot", "data", "exit"], "帧序：快照 → 数据 → 退出");
    assert.equal(JSON.parse(collector.frames[1].data), "最后一块", "exit 前先冲净 pending：最后一屏不丢");
  } finally {
    controller.abort();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ②-c 阈值冲刷：窗口大到永不到点，能在时限内收到的 data 帧只能来自 32KB 阈值
// 的立即冲刷。两块恰好 32KB（不「超」不冲），第三块压过线即冲——顺带钉住边界
// 是「超」不是「达到」。
test("② SSE 待发缓冲超 32KB 立即冲刷：不等窗口定时器", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-flushtail-"));
  let pty = null;
  const host = createTerminalHost({
    root,
    port: 0,
    ptyModule: { spawn: () => (pty = new FakePty()) },
    logger: { warn() {} },
    sseCoalesceWindowMs: 60000,
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  const controller = new AbortController();
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "阈值冲刷", cwd: root, shell: "powershell" }),
    }).then((r) => r.json());
    const response = await fetch(url(`/terminal/sessions/${created.id}/stream`), {
      headers: { authorization: `Bearer ${host.token}` }, signal: controller.signal,
    });
    const collector = startSseCollector(response);

    const half = "x".repeat(16 * 1024);
    pty.dataListener(half); // 累计 16KB：入缓冲，只有定时器（永不到点）
    pty.dataListener(half); // 累计 32KB：恰好等于，仍未「超」
    pty.dataListener("尾"); // 压过 32KB：立即冲
    assert.ok(
      await waitForSseFrame(collector, "data", { timeoutMs: 250 }),
      "阈值冲刷不等窗口定时器（60s 窗口下 250ms 内必须见到帧）",
    );
    await sleep(30); // 收尾观察：阈值冲刷之后不该再跟着冒出第二帧
    const data = collector.frames.filter((frame) => frame.event === "data");
    assert.equal(data.length, 1, "阈值冲刷合并成一帧（拆两帧=把「达到」当成了「超」）");
    assert.equal(JSON.parse(data[0].data), half + half + "尾", "冲出去的是全部三块拼接");
  } finally {
    controller.abort();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ③ 脏位门控：内存没变过，persistNow 整笔跳过（连 stringify 都不做）——
// 「写盘与否」用 mtime 判，落定用 await persistNow() 判，不写 sleep 等待。
test("③ 脏位门控：无变化不写盘；有变化才写", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-dirty-"));
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "脏位", cwd: root, shell: "powershell", cols: 100, rows: 30 }),
    }).then((r) => r.json());

    // 创建路由已等过落盘；此后内存再无变化，两次显式 persistNow 都必须是空跳。
    // 探针读会话自己那份记录（索引只在成员/主题变化时重写，出字不碰它）。
    const settled = statSync(host.sessionStatePath(created.id)).mtimeMs;
    await sleep(25); // 跨过 mtime 粒度，让「没写」可判
    await host.persistNow();
    await host.persistNow();
    assert.equal(statSync(host.sessionStatePath(created.id)).mtimeMs, settled, "无变化时 persistNow 不写盘");

    // 一条「走完整路径但无实际变化」的 mutate：杀掉 PTY 后发同尺寸 resize——
    // 旧实现这里照样整份重写；脏位门控下 persistNow 是纯空跳。
    calls[0].pty.kill(); // onExit 置脏并触发一笔写，路由会等它落定
    await fetch(url(`/terminal/sessions/${created.id}/resize`), {
      method: "POST", headers: headers(host), body: JSON.stringify({ cols: 100, rows: 30 }),
    }).then((r) => r.json());
    const afterExit = statSync(host.sessionStatePath(created.id)).mtimeMs;
    await sleep(25);
    await host.persistNow();
    assert.equal(statSync(host.sessionStatePath(created.id)).mtimeMs, afterExit, "PTY 已退出的同尺寸 resize（无实际变化）不写盘");

    // 对照组：emit 一块输出 → 置脏 → 真写盘，盘上带得上这块。
    calls[0].pty.dataListener("新输出");
    await host.persistNow();
    const persisted = readSessionRecord(host, created.id);
    assert.ok(recordScreenText(persisted).includes("新输出"), "置脏后的变更落盘");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ④ 异步原子写的可观察性质：写进行中的任意时刻，落盘文件都是完整可解析的 JSON
// （读者要么看到旧版全文、要么看到新版全文，永不看到半份）。大块输出拖长
// writeFile(临时文件) 阶段，并发读者与写真正在时间上叠起来。读的是这条会话的
// 记录文件——快照写的就是它（索引只有几百字节，叠不上写）。
test("④ 状态文件任意时刻可解析：原子替换不暴露半份文件", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-atomic-"));
  let pty = null;
  const host = createTerminalHost({
    root,
    port: 0,
    ptyModule: { spawn: () => (pty = new FakePty()) },
    logger: { warn() {} },
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "原子", cwd: root, shell: "powershell" }),
    }).then((r) => r.json());
    const recordPath = host.sessionStatePath(created.id);

    const big = "x".repeat(96 * 1024);
    const reads = [];
    let stopReading = false;
    const reader = (async () => {
      while (!stopReading) {
        reads.push(readFileSync(recordPath, "utf8"));
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    for (let round = 0; round < 4; round += 1) {
      pty.dataListener(big);
      await host.persistNow();
    }
    stopReading = true;
    await reader;

    assert.ok(reads.length > 8, `并发读得真跑起来（实得 ${reads.length} 次，否则没叠上写）`);
    for (const [index, text] of reads.entries()) {
      let parsed = null;
      assert.doesNotThrow(() => { parsed = JSON.parse(text); }, `第 ${index} 次读必须是完整 JSON`);
      assert.ok(parsed.screen && typeof parsed.screen === "object", `第 ${index} 次读必须是完整会话记录`);
    }
    // 终态也完整：最后一轮的大块按快照预算留在盘上。
    const final = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.ok(final.screen.screen.length >= 1, "终态快照内容完好");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ⑤ 评审修正钉（写失败语义）：删除级路由（close、clear-all）「响应前等落盘」
// 的契约在写失败时必须以 500 拒答，不能答一个盘上其实没清的假 200——relay 的
// stop({clearSessions}) 只对非 2xx 转进 clearFailed → 宿主停稳后删除状态文件
// 的兜底（requestClearAllSessions 见 relay-host.mjs），面板关页签同理拿 200 当
// 凭据；假 200 直通杀宿主，已关页签就在下次重启时从盘上复活。旧同步写失败在
// 这里本来就是路由 500，这条防线不许被异步化顺手抹掉。构造必败：把状态文件
// 路径占成一个目录，rename 落不上去，每笔写都失败（EPERM 走有界退避后上抛）。
test("⑤ 写盘失败时 close/clear-all 回 500 拒答，不答假 200", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-persistfail-"));
  mkdirSync(join(root, TERMINAL_STATE_FILE)); // 占位目录：restore() 读它抛错按无状态处理
  const { ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  const post = (path, body) => fetch(url(path), {
    method: "POST", headers: headers(host), body: JSON.stringify(body ?? {}),
  });
  try {
    // 非删除级路由刻意软失败：会话在内存里照常可用，脏位保着、每个防抖拍重试，
    // 没有谁拿它们的 200 去杀宿主——这与 close/clear-all 的硬失败是两份不同的
    // 契约，钉在一起防止以后被「顺手统一」。
    const created = await post("/terminal/sessions", { label: "写失败", cwd: root, shell: "powershell" });
    assert.equal(created.status, 201, "create 对写盘失败软失败：会话照常建立");
    assert.equal(host.sessions.size, 1);
    const createdBody = await created.json();

    const closeResponse = await post(`/terminal/sessions/${createdBody.id}/close`);
    assert.equal(closeResponse.status, 500, "close 写盘失败必须 500，不答假 200");
    assert.deepEqual(await closeResponse.json(), { error: "state_persist_failed" });

    const clearResponse = await post("/terminal/sessions/clear-all");
    assert.equal(clearResponse.status, 500, "clear-all 写盘失败必须 500，不答假 200");
    assert.deepEqual(await clearResponse.json(), { error: "state_persist_failed" });
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑥⑦⑧ 落盘不再随会话数线性膨胀。
//
// 病灶（S3 报告 §2.1）：旧实现把「全部会话 + 每会话 128KB 尾部」序列化成一份
// JSON，防抖每 250ms 整份重写。一个会话在出字，全部空闲会话的尾部也要跟着重写
// 一遍——单拍成本 O(N)，现场实测 N=2 12ms/301KB、N=8 27ms/1.2MB、N=20 45ms/3MB，
// 而且 `persistChain` 单笔超 250ms 就无界积压。用户点 ⊕ 不断新增会话，这条路径
// 就是延迟的放大器。
//
// 观察面只用文件系统（不看宿主自报的计数）：一拍落盘的可观察结果是「哪些 .json
// 的 mtime 变了、变了几个字节」。这样断言的是**行为**而不是某套内部计数，旧实现
// 上没有这套计数也照样能被判红——正是回归钉该有的性质。
// 口径仍是相对的（N 增长时看结构量的变化），不写绝对毫秒阈值：仓里没有假时钟，
// 绝对阈值必然 flaky。

const KB_ = 1024;

// 根目录下全部 .json 的 { mtimeMs, size }。原子写留下的 .tmp 不在其中（它们是
// 写完就 rename 掉的中间态，后缀不是 .json）。
function snapshotStateFiles(root) {
  const map = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        const stats = statSync(path);
        map.set(path, { mtimeMs: stats.mtimeMs, size: stats.size });
      }
    }
  };
  walk(root);
  return map;
}

// 等「下一次落盘」落定：轮询到至少一个 .json 的 mtime/大小变了为止。返回这一拍
// 写了哪些文件、合计多少字节——这就是单拍落盘成本的直接读数。
async function waitForStateWrite(root, before, { timeoutMs = 2500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = snapshotStateFiles(root);
    const changed = [];
    for (const [path, info] of now) {
      const prev = before.get(path);
      if (!prev || prev.mtimeMs !== info.mtimeMs || prev.size !== info.size) {
        changed.push({ path, bytes: info.size });
      }
    }
    if (changed.length > 0) {
      return { files: changed.length, bytes: changed.reduce((total, item) => total + item.bytes, 0), changed };
    }
    if (Date.now() >= deadline) return { files: 0, bytes: 0, changed: [] };
    await sleep(10);
  }
}

// 建 N 个会话并把每条喂满落盘尾部预算（128KB），返回能直接 dataListener 的假 PTY。
async function seedSessions(host, url, root, n) {
  const ptys = [];
  for (let i = 0; i < n; i += 1) {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: `会话${i}`, cwd: root, shell: "powershell", cols: 120, rows: 34 }),
    }).then((r) => r.json());
    ptys.push(host.sessions.get(created.id).pty);
  }
  // 128KB 尾部：8 块 × 16KB。内容带 SGR，落盘时 ESC 会膨胀成 \u001b（六倍字节），
  // 这正是现场状态文件 425KB ↔ 内存 262KB 那个比例。
  const line = "\x1b[1;36m␣\x1b[0m 正在读取文件 abcdefghijklmnopqrstuvwxyz\r\n";
  const chunk = line.repeat(Math.ceil((16 * KB_) / Buffer.byteLength(line)));
  for (const pty of ptys) {
    for (let k = 0; k < 8; k += 1) pty.dataListener(chunk);
  }
  await host.persistNow(); // 先把种子全部落定，再开始量
  await sleep(120); // 让切片解析的续排跑完，别把镜像排空算进落盘
  return ptys;
}

test("⑥ 单会话出字的防抖拍成本不随会话数增长：N=2 与 N=20 写同样字节", async () => {
  const measured = [];
  for (const n of [2, 20]) {
    const root = mkdtempSync(join(tmpdir(), `anyswitch-terminal-scale-${n}-`));
    const { calls, ptyModule } = capturingPtyModule();
    const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
    const port = await listen(host);
    const url = (path) => `http://127.0.0.1:${port}${path}`;
    try {
      const ptys = await seedSessions(host, url, root, n);
      assert.equal(calls.length, n, `前置：${n} 个会话都真的 spawn 了`);
      // 只让第一个会话出字——这就是「开了一个页签在跑 agent、其它页签闲着」的形态
      const before = snapshotStateFiles(root);
      ptys[0].dataListener("tick");
      const pass = await waitForStateWrite(root, before);
      assert.ok(pass.files > 0, `N=${n}：防抖拍到点必须真的落盘（250ms + 写，2.5s 内没动静就是丢了变更）`);
      measured.push({ n, ...pass });
    } finally {
      await host.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }
  const [small, large] = measured;
  // 这一条就是病灶本身：一个会话出字，写出去的量与会话总数无关。
  // 旧实现写的是整份状态文件，N=2 ≈ 301KB、N=20 ≈ 3MB（十倍）。
  assert.ok(large.bytes <= small.bytes * 1.5,
    `单拍写量不随会话数增长（N=${small.n} 写 ${small.bytes}B，N=${large.n} 写 ${large.bytes}B；`
    + `旧实现是整份重写，会从 ${small.n} 份尾部涨到 ${large.n} 份尾部）`);
  // ⑦ 对照组：那一拍必须真写了东西（否则「都不写」也能让上面的比值成立）。
  assert.ok(small.bytes > 0 && large.bytes > 0, "两拍都必须有真实写量");
});

test("⑧ N 个会话同时出字：单拍被上限截断、欠账自己续上，最终全部收敛", async () => {
  const n = 20;
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-scale-all-"));
  const { ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const ptys = await seedSessions(host, url, root, n);

    // 全部 20 个会话在同一拍里出字。旧实现一轮写 20 份、约 3MB。
    // 种子阶段的显式冲净会写满 20 份（那是 full 路径，不受单拍上限约束），
    // 所以把「最大单拍份数」的观测归零，只看下面这几拍。
    host.persistStats.maxPassSessionWrites = 0;
    const before = snapshotStateFiles(root);
    for (const pty of ptys) pty.dataListener("tick");
    const first = await waitForStateWrite(root, before);
    assert.ok(first.files > 0, "第一拍必须真的落盘");
    // 上限：单拍写量必须落在「序列化上限 + 一份超限整写」的量级内，不能是 N×尾部。
    // 快照的落盘预算按原始字节计（128KB），但记录序列化成 JSON 时 ESC 密集内容
    // 膨胀到约 2 倍——泵的 PERSIST_PASS_MAX_BYTES（512KB 序列化）截断后，超限的
    // 那一份仍整份写，所以上界 = 512KB + 一份（≈128KB×2.4），给到 1.5 倍余量。
    const capBytes = 512 * KB_ * 1.5;
    assert.ok(first.bytes <= capBytes,
      `单拍写量 ${first.bytes}B 必须落在上限量级内（≤ ${Math.round(capBytes)}B）；旧实现一轮写 ${n}×128KB ≈ 2.5MB`);

    // 欠账不许等下一次输出来叫醒：没有新输出，后续拍也要自己续上把欠账写完。
    const afterFirst = snapshotStateFiles(root);
    const second = await waitForStateWrite(root, afterFirst, { timeoutMs: 1500 });
    assert.ok(second.files > 0,
      "有界单拍留下的欠账必须自己续下一拍（没有新输出也该继续写）——否则会话记录会长期停在旧内容");

    // 判据要落在「这一拍的总量」上，不是「第一次看到变化」（评审 P2-4）：
    // waitForStateWrite 一见到任何文件变化就返回，读到的是下界。等泵静默后取
    // persistStats 记下的那一拍真实份数/字节——这才是「每拍 ≤4 份」的判据。
    await waitForQuiescence(root);
    assert.ok(host.persistStats.maxPassSessionWrites <= 4,
      `任何一拍的份数不得超过上限 4（实得最大 ${host.persistStats.maxPassSessionWrites} 份）——`
      + `这条才真正钉住「单拍有界」；只看到首帧变化的观测会让上限被改成 8 也照样绿`);
    // 单拍字节上界同样按上限判：4 份 × 单份实际序列化大小。种子尾部约 137KB，
    // 给到 4×128KB 的 1.5 倍余量吸收 ESC 膨胀比例差异。
    assert.ok(host.persistStats.lastPassBytes <= 4 * 128 * KB_ * 1.5,
      `单拍序列化字节 ${host.persistStats.lastPassBytes}B 必须落在 4 份的量级内`);

    // 收敛：所有会话的记录都落到盘上，每条都守住 128KB 快照落盘预算。
    await host.persistNow();
    for (const session of host.sessions.values()) {
      const record = readSessionRecord(host, session.id);
      const snapBytes = Buffer.byteLength(recordScreenText(record));
      assert.ok(snapBytes <= 128 * KB_ * 1.15,
        `收敛后每条快照守 128KB 落盘预算（${session.id} 实得 ${snapBytes}B；余量吸收逐行开销与屏幕行）`);
    }
    // 一拍写完的份数确实少于会话总数——上限真的在截断，不是「恰好一轮写完」。
    assert.ok(first.files < n || n <= 4,
      `一轮不许把 ${n} 个会话全写完（实写 ${first.files} 份）——单拍成本必须被上限截断`);
  } finally {
    await host.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("⑨ 新码读得回旧格式（v1 整份文件）：逐字段恢复、尾部照用，并自然迁移成 v2", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-v1compat-"));
  const { writeFileSync } = await import("node:fs");
  // v1 形态：sessions 是完整对象数组，正文（含 buffer）就在里面。这段字节是旧宿主
  // 真实会写出来的形状，一个字段都不少。
  const legacyBuffer = ["旧宿主留下的第一屏\r\n", "\x1b[1;32m旧宿主留下的第二屏\x1b[0m\r\n"];
  writeFileSync(join(root, TERMINAL_STATE_FILE), JSON.stringify({
    version: 1,
    theme: { dark: false, background: "#101010" },
    sessions: [{
      id: "legacy-session-1", label: "旧会话", cwd: root, shell: "powershell",
      pid: 4321, createdAt: 111, lastActiveAt: 222, spawnedAt: 222,
      cols: 90, rows: 20, buffer: legacyBuffer, status: "running", exitCode: null,
      agentId: "kimi", agentName: "Kimi Code",
      resume: { endpoint: "kimi", id: "s-old" },
    }],
  }, null, 2));
  const restored = createTerminalHost({ root, port: 0, ptyModule: { spawn: () => new FakePty() }, isAliveFn: () => false, logger: { warn() {} } });
  try {
    const session = restored.sessions.get("legacy-session-1");
    assert.ok(session, "旧格式里的会话必须读得回来（读不回来就是字段/形状对不上）");
    assert.equal(session.label, "旧会话");
    assert.equal(session.cols, 90, "元数据逐字段还原");
    assert.equal(session.agentId, "kimi", "agent 元数据不丢");
    assert.deepEqual(session.resume, { endpoint: "kimi", id: "s-old" }, "续接身份不丢");
    assert.deepEqual(session.buffer, legacyBuffer, "落盘尾部原样读回（不重排、不丢块）");
    assert.equal(session.bufferBytes, Buffer.byteLength(legacyBuffer.join("")), "字节位按读回的尾部重算");
    assert.equal(session.pty, null, "旧宿主留下的 running 状态不许当成活进程");
    assert.ok(session.screen.screenLines().join("|").includes("旧宿主留下的第二屏"), "镜像已由尾部重喂出来");

    // 自然迁移：下一次落盘把 v1 换成 v2（索引点 id，正文进每会话记录），不需要
    // 一次性迁移脚本，也不留迁移义务。迁移后的正文是渲染快照——字节尾不再落盘，
    // 旧字节已按旧路径重喂进镜像，画面由快照承载。
    await restored.persistNow();
    const index = JSON.parse(readFileSync(join(root, TERMINAL_STATE_FILE), "utf8"));
    assert.equal(index.version, 2, "索引升到 v2");
    assert.deepEqual(index.sessions, ["legacy-session-1"], "索引只点名 id");
    assert.deepEqual(index.theme, { dark: false, background: "#101010", foreground: "", palette: null }, "主题随索引保留（v1 无前景/调色板，按未上报落档）");
    const record = JSON.parse(readFileSync(restored.sessionStatePath("legacy-session-1"), "utf8"));
    assert.equal(record.version, 2, "记录升到 v2");
    assert.equal(record.buffer, undefined, "字节尾不再落盘");
    assert.ok(record.screen && typeof record.screen === "object", "迁移后的记录落渲染快照");
    assert.ok(recordScreenText(record).includes("旧宿主留下的第二屏"), "旧内容由快照承载");
  } finally {
    await restored.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ⑩ 双上限与「最新一块必留」在渲染快照落盘之后仍成立。
// 契约（不许因落盘形态换代而破）：内存环 512KB + 4000 块；裁尾只整块从头部丢；
// 最新一块无条件保留；落盘快照守 128KB 预算、屏幕行无条件整屏保留（它是恢复的
// 最低交付物）；session.bufferBytes 三处维护（emit 累加 / restart 归零 / restore
// 重算）任何一处漏掉都让裁尾静默失效。
test("⑩ 双上限（512KB / 4000 块）与最新一块必留在渲染快照落盘后仍成立", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-dualcap-"));
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  const whole = /^#\d+ \d+$/;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "双上限", cwd: root, shell: "powershell" }),
    }).then((r) => r.json());
    const pty = calls[0].pty;

    // 块数上限：4000 块 × 每块 12 字节 = 48KB，远低于 512KB，字节上界不会先命中。
    for (let i = 0; i < 6000; i += 1) pty.dataListener(`#${i} 000`);
    const session = host.sessions.get(created.id);
    assert.ok(session.buffer.length <= 4000, `块数上限：留下 ${session.buffer.length} 块，超 4000`);
    assert.ok(session.buffer.length > 3900, `块数上限没有裁得过狠（留 ${session.buffer.length} 块）`);
    assert.ok(Number.isFinite(session.bufferBytes) && session.bufferBytes > 0,
      "字节位保持有限值（NaN 比较会让裁尾静默失效）");
    assert.equal(session.buffer[session.buffer.length - 1], "#5999 000", "最新一块无条件保留");
    // 裁尾只整块从头部丢：留下的每一块都是完整的 `#序号 序号`，没有半块。
    for (const kept of session.buffer) assert.ok(whole.test(kept), `只许整块丢：${JSON.stringify(kept)}`);

    // 字节上限：再灌满，让 512KB 字节预算成为约束
    for (let i = 0; i < 60; i += 1) pty.dataListener(`${"z".repeat(16 * KB_)}#${i}`);
    const bytes = Buffer.byteLength(session.buffer.join(""));
    assert.ok(bytes <= 512 * KB_, `内存窗口 ${bytes}B 超 512KB 字节上限`);
    assert.ok(session.buffer[session.buffer.length - 1].includes("#59"), "字节裁剪后最新一块仍在");

    // 落盘快照：屏幕行无条件整屏保留、最新内容在快照里。
    await host.persistNow();
    const diskRecord = readSessionRecord(host, created.id);
    assert.ok(diskRecord.screen && Array.isArray(diskRecord.screen.screen), "落盘的是渲染快照");
    assert.equal(diskRecord.screen.screen.length, diskRecord.rows, "屏幕行整屏落盘（最低交付物）");
    assert.ok(recordScreenText(diskRecord).includes("#59"), "最新内容在快照里");

    // 单块超预算：屏幕行照样整屏保留（恢复的最低交付物，不参与裁剪）
    pty.dataListener(`#MEGA ${"y".repeat(400 * KB_)}`);
    await host.persistNow();
    const megaRecord = readSessionRecord(host, created.id);
    assert.equal(megaRecord.screen.screen.length, megaRecord.rows, "超预算下屏幕行照样整屏落盘");

    // 宿主重启：恢复按快照重建镜像（画面非空、过渲染回放门槛）；
    // 内存窗口从空起（字节尾不再落盘），字节位保持有限值
    await host.close();
    const restored = createTerminalHost({
      root, port: 0, ptyModule: { spawn: () => new FakePty() }, isAliveFn: () => false, logger: { warn() {} },
    });
    try {
      const revived = restored.sessions.get(created.id);
      assert.ok(revived, "盘上落过的会话读得回来");
      assert.ok(revived.screen.info().consumedBytes > 0, "恢复的会话过渲染回放门槛");
      assert.ok(revived.screen.screenLines().some((line) => line !== ""), "恢复画面非空");
      assert.equal(revived.bufferBytes, 0, "字节尾不落盘：恢复窗口从空起");
    } finally {
      await restored.close();
    }
  } finally {
    await host.close().catch(() => {});
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
    probeLiveness: () => "dead",
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

// 等落盘泵静默：连续 quietMs 没有任何 .json 变化才算这一拍彻底结束。用来观察
// 「一拍总共写了多少」——只看「第一次看到变化」拿到的是下界（评审 P2-4 指出的
// 判据错位就是这么来的）。
async function waitForQuiescence(root, { quietMs = 150, timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = snapshotStateFiles(root);
  let lastChangeAt = Date.now();
  for (;;) {
    await sleep(15);
    const now = snapshotStateFiles(root);
    let changed = now.size !== previous.size;
    if (!changed) {
      for (const [path, info] of now) {
        const prev = previous.get(path);
        if (!prev || prev.mtimeMs !== info.mtimeMs || prev.size !== info.size) { changed = true; break; }
      }
    }
    if (changed) lastChangeAt = Date.now();
    previous = now;
    if (Date.now() - lastChangeAt >= quietMs) return;
    if (Date.now() >= deadline) return;
  }
}

// ⑪ 写盘进行中置的脏不许被那一笔成功的写顺手抹掉（评审 P0 的钉子）。
//
// 机制：序列化发生在 await 之前。若「清脏」发生在 write 回来之后（或哪怕只是挪到
// 中间某个 await 之后），这段窗口里新到的变更就会「不在文本里、却被当成已写」——
// 那一块永久只活在内存里。旧写法（base 的注释专门警告过）正是这么写的。
//
// 注入点：persistNow 同步走进泵、序列化、清脏，在第一个 I/O await 上挂起。排队一个
// 微任务，它必然在「已清脏、写未完」的窗口内执行——不赌磁盘快慢（快照化后记录从
// 8MB 降到 128KB 量级，旧的 sleep(3) 观测窗口已经窄到测不住）。微任务里 emit 带
// 标记的块，然后落定，断言标记必须在盘上。修前实测：脏被抹成 0，随后的
// persistNow() 是纯空跳，标记不在盘上。
test("⑪ 写盘期间到达的输出块必须落盘，不被那一笔成功的写抹掉", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-lostupdate-"));
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  const marker = "MARKER-INSIDE-WRITE-WINDOW";
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "丢更新", cwd: root, shell: "powershell" }),
    }).then((r) => r.json());
    const pty = calls[0].pty;

    pty.dataListener("seed");
    await host.persistNow();
    const passesBefore = host.persistStats.passes;
    const inFlight = host.persistNow();
    // 微任务注入点：此刻必然已过「序列化＋清脏」、尚未完成写盘
    await Promise.resolve();
    assert.equal(host.persistStats.passes, passesBefore,
      "前置：第二笔写盘此刻必须仍在进行（passes 未增加）");
    // 就在写盘窗口内：新到一个块
    pty.dataListener(marker);
    const late = host.persistNow();
    await Promise.all([inFlight, late]);
    await host.persistNow();

    const record = readSessionRecord(host, created.id);
    assert.ok(recordScreenText(record).includes(marker),
      "写盘期间到达的块必须在盘上（不在盘上 = 那一笔成功的写把新脏抹掉了，关停前最后一块会永久丢）");
  } finally {
    await host.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

// ⑫ 建/关混合压力下，索引与记录文件始终自洽（**不变量守卫钉，非红钉**）。
//
// 要防的状态是「索引点名了一个既不在内存、也没有记录文件的 id」——评审在
// 34e472d 上用 12 轮 ×（12 并发建 + 6 关 + 4 建）跑到过 4/12 轮。**诚实记录：
// 同一形状在本装置上复现不出来（修前修后都绿）**，所以它不能作为 P0-c 的红证，
// 只能作为「这个不变量以后不许被破」的守卫。P0-c 的机制红证由 ⑪ 承担——两者
// 同一个根因（写成功后才清脏），⑪ 能稳定复现。
// 反过来「文件在、索引不点名」是允许的（崩溃窗口的孤儿，下次启动由 prune 收）。
//
// 判据取在**静默之后**：中间不插显式全量冲净，否则那一笔会把坏索引顺手修好，
// 把要抓的状态洗掉。
test("⑫ 建关混合压力下索引与记录文件自洽：不许出现「索引点名但文件不存在」", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-indexrace-"));
  const { ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  const post = (path) => fetch(url(path), { method: "POST", headers: headers(host), body: "{}" });
  const problems = [];
  // 静默后取盘上真状态：索引点名却读不回来的 id = 脏位被抹过（写盘窗口里置的
  // indexDirty / removedSessionIds 被那一笔成功的写顺手清了）。
  const checkInvariant = async (round, phase) => {
    await waitForQuiescence(root);
    const index = JSON.parse(readFileSync(host.statePath, "utf8"));
    const indexIds = index.sessions;
    const onDisk = new Set(readdirSync(host.sessionStateDir).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)));
    const inMemory = new Set(host.sessions.keys());
    const missingFiles = indexIds.filter((id) => !onDisk.has(id));
    const notInMemory = indexIds.filter((id) => !inMemory.has(id));
    if (missingFiles.length > 0 || notInMemory.length > 0) {
      problems.push({ round, phase, missingFiles, notInMemory });
    }
    // 内存里的会话必须全被索引点名（否则下次启动它就消失）
    const unlisted = [...inMemory].filter((id) => !indexIds.includes(id));
    if (unlisted.length > 0) problems.push({ round, phase, unlistedInIndex: unlisted });
  };
  try {
    for (let round = 0; round < 12; round += 1) {
      // 并发建 12 条、关掉其中 6 条、再建 4 条：建与关都在写盘窗口里交错
      const created = await Promise.all(Array.from({ length: 12 }, (_, i) => (
        fetch(url("/terminal/sessions"), {
          method: "POST", headers: headers(host),
          body: JSON.stringify({ label: `r${round}-${i}`, cwd: root, shell: "powershell" }),
        }).then((r) => r.json())
      )));
      await Promise.all(created.slice(0, 6).map((session) => post(`/terminal/sessions/${session.id}/close`)));
      // 关页签之后立刻看：此时若索引还点着已删的会话，下一次建会话会把坏态「修好」，
      // 所以这一拍必须单独看。
      await checkInvariant(round, "after-close");
      await Promise.all(Array.from({ length: 4 }, (_, i) => (
        fetch(url("/terminal/sessions"), {
          method: "POST", headers: headers(host),
          body: JSON.stringify({ label: `r${round}-late${i}`, cwd: root, shell: "powershell" }),
        }).then((r) => r.json())
      )));
      await checkInvariant(round, "after-late-create");
      // 收干净，进入下一轮
      await post("/terminal/sessions/clear-all");
    }
    assert.deepEqual(problems, [], "索引与盘上记录必须自洽（missingFiles/notInMemory 都说明脏位被抹过）");
  } finally {
    await host.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

// ⑬ 关停全量冲净不许被并发的定向冲净降级（评审 P1 的钉子）。
//
// 形态：一批会话置脏 → 250ms 防抖起一轮**有界**写盘（只写 4 份）→ 在那一轮飞行
// 期间来一个 only 请求（resize 路由）和一个 full 请求（close() 的 flush）。修前：
// 泵把两者合并成一轮、only 优先，full 只写掉那一条就返回，`backlog` 还剩一批——
// SIGTERM 紧接着 process.exit(0)，那些尾部就没了。修后：full 单独成轮并优先，
// 且写到没有欠账才返回。
//
// 窗口只有几毫秒，所以重试多次（修后每次都必须 0 欠账；修前只需命中一次即红）。
test("⑬ 全量冲净不被定向冲净降级：返回时不留欠账", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-fullflush-"));
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const ids = [];
    for (let i = 0; i < 12; i += 1) {
      const created = await fetch(url("/terminal/sessions"), {
        method: "POST", headers: headers(host),
        body: JSON.stringify({ label: `会话${i}`, cwd: root, shell: "powershell", cols: 100, rows: 30 }),
      }).then((r) => r.json());
      ids.push(created.id);
    }
    await host.persistNow();

    for (let attempt = 0; attempt < 12; attempt += 1) {
      // 12 条全部置脏：防抖拍只写 4 份，剩 8 份欠账
      for (const pty of calls.map((call) => call.pty)) pty.dataListener(`flush-${attempt}`);
      // 等防抖拍到点并进入有界那一拍（250ms 窗口 + 几毫秒飞行），再插 only + full
      await sleep(252);
      const resize = fetch(url(`/terminal/sessions/${ids[attempt % ids.length]}/resize`), {
        method: "POST", headers: headers(host),
        body: JSON.stringify({ cols: 120 + (attempt % 7), rows: 40 }),
      });
      const full = host.persistNow();
      await Promise.all([resize, full]);

      assert.equal(host.persistStats.backlog, 0,
        `第 ${attempt} 次：全量冲净返回时必须没有欠账（实得 ${host.persistStats.backlog}）——关停时 SIGTERM 紧接着 exit(0)，欠账就是丢尾部`);
    }
    // 落盘实证：每条会话的快照里都有最后一批输出
    for (const id of ids) {
      const record = readSessionRecord(host, id);
      assert.ok(recordScreenText(record).includes("flush-11"), `会话 ${id} 的最后一批输出必须在盘上`);
    }
  } finally {
    await host.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

// ⑭ 全量冲净必须「写到没有欠账」，不是「跑一轮」。
//
// 评审 r2 §3.2：上一版 `pumpWantFull` 是**一次性请求位**，每轮开头就被消费掉。
// 第 1 轮（full）跑完若仍有欠账 → 进第 2 轮，但第 2 轮的 full 位已是 false，于是
// 第 2 轮退化成有界单拍（≤4 份）；第 2 轮后既不再 continue 也没人置位 → 泵退出、
// 欠账留给 250ms 后的防抖拍。而 close() 只 await 泵、不等那个定时器，SIGTERM 紧接
// 着 exit(0)——欠账就跟着没了。PERSIST_FULL_FLUSH_MAX_ROUNDS 因此是死代码。
//
// 复现形状与评审一致：N=12 每条喂满 128KB 尾部 → 全部 emit 置脏 → persistNow()
// （full）→ **在飞行期间**再对全部会话 emit 一个带标记的块 → await → 断言
// backlog === 0 且每条记录的盘上内容含那个标记块。修前实测 backlog = 8。
test("⑭ 全量冲净写期间又置脏：返回时必须没有欠账，且最后一块在盘上", async () => {
  const n = 12;
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-fullclean-"));
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  const marker = "TAIL-DURING-FULL-FLUSH";
  try {
    const ids = [];
    for (let i = 0; i < n; i += 1) {
      const created = await fetch(url("/terminal/sessions"), {
        method: "POST", headers: headers(host),
        body: JSON.stringify({ label: `会话${i}`, cwd: root, shell: "powershell", cols: 120, rows: 34 }),
      }).then((r) => r.json());
      ids.push(created.id);
    }
    // 每条喂满 128KB 落盘尾部：一轮全量写 12 份要十几毫秒，飞行窗口足够插进 emit。
    const line = "\x1b[1;36m␣\x1b[0m 正在读取文件 abcdefghijklmnopqrstuvwxyz\r\n";
    const chunk = line.repeat(Math.ceil((16 * KB_) / Buffer.byteLength(line)));
    for (const call of calls) for (let k = 0; k < 8; k += 1) call.pty.dataListener(chunk);
    await host.persistNow();

    // 全部置脏，然后起一轮全量冲净
    for (const call of calls) call.pty.dataListener("pre-flush");
    const flush = host.persistNow();
    // 飞行期间：再给全部会话各来一个标记块（这就是「full 之后又有新脏」）
    for (const call of calls) call.pty.dataListener(marker);
    await flush;

    assert.equal(host.persistStats.backlog, 0,
      `全量冲净返回时必须没有欠账（实得 ${host.persistStats.backlog}）——`
      + `欠账跟着 SIGTERM 的 exit(0) 一起没了就是丢尾部`);
    assert.equal(host.persistStats.lastFullFlushIncomplete, null,
      "正常路径不该留下「冲净不完整」的记录");
    for (const id of ids) {
      const record = readSessionRecord(host, id);
      assert.ok(recordScreenText(record).includes(marker),
        `会话 ${id}：飞行期间到达的标记块必须在盘上（不在 = 那一轮之后泵提前退出了）`);
    }
  } finally {
    await host.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

// ⑮ close() 把「盘上是不是整份状态」这个结果返回出来，不再静默。
// 撞轮次上限（"输出永不停"）时必须有可观测的记法（lastFullFlushIncomplete）；
// 正常关停则 complete=true、backlog=0。
test("⑮ close() 返回「还有没有欠账」：正常关停 complete=true", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-closecomplete-"));
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    for (let i = 0; i < 6; i += 1) {
      await fetch(url("/terminal/sessions"), {
        method: "POST", headers: headers(host),
        body: JSON.stringify({ label: `会话${i}`, cwd: root, shell: "powershell" }),
      });
    }
    for (const call of calls) call.pty.dataListener("last-block-before-close");
    const result = await host.close();
    assert.ok(result && typeof result === "object", "close() 必须返回结果对象");
    assert.equal(result.backlog, 0, `关停返回时不许有欠账（实得 ${result.backlog}）`);
    assert.equal(result.complete, true, "正常关停 complete=true");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ⑯ 全量冲净没能兑现时必须有可观测的记法，不许静默。
// 构造必败：索引路径占成目录，每笔索引写都失败 → 欠账留到 close() 仍存在。
// 该用例钉的是「结果被返回出来 + lastFullFlushIncomplete 有记录」这条可观测性，
// 不是写失败本身的 500 语义（那条在 ⑤）。
test("⑯ 全量冲净未完成时 close() 返回 complete=false 且留下可观测记录", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-incomplete-"));
  mkdirSync(join(root, TERMINAL_STATE_FILE)); // 占位目录：索引写必败
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "写失败", cwd: root, shell: "powershell" }),
    }).then((r) => r.json());
    calls[0].pty.dataListener("tail");
    // 索引写失败 → 索引的脏位被置回 → 全量冲净无法兑现
    const result = await host.close();
    assert.ok(result && typeof result === "object", "close() 必须返回结果对象");
    assert.equal(result.complete, false, "有欠账时 complete 必须为 false（不许静默返回成功）");
    // 欠账可能落在会话记录上，也可能只落在索引上（本例是索引写失败）：两处都要如实上报。
    assert.ok(result.backlog > 0 || result.indexDirty === true,
      `欠账必须如实反映（backlog=${result.backlog}, indexDirty=${result.indexDirty}）`);
    assert.ok(host.persistStats.lastFullFlushIncomplete,
      "撞上限或写失败时 lastFullFlushIncomplete 必须有记录（这是「盘上不是整份状态」的机器可判信号）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watchParentProcess stays quiet while the parent lives", () => {
  let tick = null;
  let dead = 0;
  watchParentProcess({
    parentPid: 4242,
    probeLiveness: () => "alive",
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

// 单次探不到不该触发死亡契约：只要其间拿到一次存活判定，之前累积的确认死亡就作废。
test("watchParentProcess 单次 miss 不触发：死亡判定之后出现存活即清零", () => {
  const verdicts = ["dead", "alive", "dead", "alive"];
  let call = 0;
  let tick = null;
  let dead = 0;
  watchParentProcess({
    parentPid: 4242,
    probeLiveness: () => verdicts[call++ % verdicts.length],
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
    probeLiveness: () => "dead",
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
  const verdicts = ["dead", "dead", "alive", "dead", "dead", "dead"];
  let call = 0;
  let tick = null;
  let dead = 0;
  watchParentProcess({
    parentPid: 4242,
    probeLiveness: () => verdicts[call++ % verdicts.length],
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
    probeLiveness: () => "dead",
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

// 「系统确认父进程不在」与「这次探针没探出结论」是两件事。把后者读成前者，
// 就是健康宿主被自己的看门狗杀掉的根因（tasklist 探针在负载尖峰下超时/报错
// 也返回 false），而宿主一死整个终端服务静默下线、不会再回来。误杀一个健康
// 宿主的代价，远高于晚一点回收一个真孤儿。
test("watchParentProcess 探针拿不到结论时永不触发死亡契约", () => {
  let tick = null;
  let dead = 0;
  watchParentProcess({
    parentPid: 4242,
    probeLiveness: () => "unknown",
    missesRequired: 3,
    setIntervalFn: (fn) => {
      tick = fn;
      return { unref() {} };
    },
    onDead: () => {
      dead += 1;
    },
  });

  for (let i = 0; i < 10; i += 1) tick();
  assert.equal(dead, 0, "再多次无法定论的探针也换不来一次误杀");
});

test("watchParentProcess 无法定论的结果不作废已确认的死亡计数", () => {
  const verdicts = ["dead", "unknown", "dead", "unknown", "dead"];
  let call = 0;
  let tick = null;
  let dead = 0;
  watchParentProcess({
    parentPid: 4242,
    probeLiveness: () => verdicts[call++ % verdicts.length],
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
  tick();
  tick();
  assert.equal(dead, 0, "unknown 只是透明：既不算存活，也不算死亡");
  tick();
  assert.equal(dead, 1, "第三次确认死亡即达阈值");
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

    // 密不上盘：落盘的两份文件（索引 + 这条会话的记录）都无 env 键、也不含令牌明文。
    const index = JSON.parse(readFileSync(host.statePath, "utf8"));
    assert.deepEqual(index.sessions, [snapshot.id], "索引点名这条会话");
    const persisted = readSessionRecord(host, snapshot.id);
    assert.equal("env" in persisted, false, "env 绝不落盘");
    assert.equal(persisted.agentId, "kimi");
    assert.equal(persisted.agentName, "Kimi Code");
    assert.ok(persisted.launch, "非密 launch 元数据随会话落盘");
    const raw = readFileSync(host.sessionStatePath(snapshot.id), "utf8") + readFileSync(host.statePath, "utf8");
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

test("restart 接受 resume 身份与 label/agentId/agentName 同步（M12-A 内切）", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-test-`);
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  let revived = null;
  try {
    // 空白外壳（无 agent 归属）——内切接管的目标形态
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({ label: "Anyswitch", cwd: root, shell: "powershell" }),
    }).then((r) => r.json());
    assert.equal(created.agentId, undefined, "建成时无 agent 归属");

    const restarted = await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({
        label: "重构权限矩阵",
        agentId: "kimi",
        agentName: "Kimi Code",
        resume: { endpoint: "kimi", id: "conv-123" },
        launch: { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\kimi.cmd", "--session", "conv-123"] },
      }),
    });
    assert.equal(restarted.status, 200);
    assert.equal(calls.length, 2, "内切＝同记录 terminate+spawn");
    const body = await restarted.json();
    assert.equal(body.label, "重构权限矩阵", "label 同步进响应");
    assert.equal(body.agentId, "kimi", "agentId 同步进响应");
    assert.equal(body.agentName, "Kimi Code", "agentName 同步进响应");
    assert.deepEqual(body.resume, { endpoint: "kimi", id: "conv-123" }, "resume 身份同步进响应（去重数据源）");

    // 形状非法的 resume 一律 400，不建不换（normalizeResume 同款校验）
    const bad = await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({ resume: { endpoint: "kimi" } }),
    });
    assert.equal(bad.status, 400, "缺 id 的 resume 拒换");
    const badBody = await bad.json();
    assert.equal(badBody.error, "invalid_resume");

    // 落盘持久化：重启宿主后身份还在（不是只活在内存响应里）
    await host.close();
    revived = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
    const revivedPort = await listen(revived);
    const listed = await fetch(`http://127.0.0.1:${revivedPort}/terminal/sessions`, { headers: headers(revived) }).then((r) => r.json());
    assert.equal(listed.sessions[0].label, "重构权限矩阵", "label 落盘");
    assert.equal(listed.sessions[0].agentId, "kimi", "agentId 落盘");
    assert.deepEqual(listed.sessions[0].resume, { endpoint: "kimi", id: "conv-123" }, "resume 落盘");
  } finally {
    if (revived) await revived.close().catch(() => {});
    await host.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart 接受 clearResume（全新内切）：显式清空旧 resume，缺省沿用，非布尔拒换", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-test-`);
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  let revived = null;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({ label: "Anyswitch", cwd: root, shell: "powershell" }),
    }).then((r) => r.json());

    // 先带身份内切一次，落一个旧 resume 进记录
    await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({
        label: "旧会话", agentId: "kimi", agentName: "Kimi Code",
        resume: { endpoint: "kimi", id: "conv-123" },
        launch: { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\kimi.cmd", "--session", "conv-123"] },
      }),
    });

    // 全新内切：clearResume 显式清空，缺省「不更新」语义不会残留旧身份
    const fresh = await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({
        label: "新会话", agentId: "kimi", agentName: "Kimi Code", clearResume: true,
        launch: { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\kimi.cmd"] },
      }),
    });
    assert.equal(fresh.status, 200, "全新内切换绑成功");
    const freshBody = await fresh.json();
    assert.equal(freshBody.resume, undefined, "旧 resume 被显式清空（快照不再下发；兜底行/去重按 falsy 口径判新会话）");
    assert.equal(freshBody.agentId, "kimi", "agent 身份照常同步");
    assert.equal(calls.length, 3, "创建＋两次换绑各一次 spawn");

    // 非布尔一律拒（换绑是显式动作，半途丢字段比报错更难查）
    const bad = await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({ clearResume: "yes" }),
    });
    assert.equal(bad.status, 400, "非布尔 clearResume 拒换");
    assert.equal((await bad.json()).error, "invalid_clearResume");

    // 落盘持久化：重启宿主后清空仍在盘上
    await host.close();
    revived = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
    const revivedPort = await listen(revived);
    const listed = await fetch(`http://127.0.0.1:${revivedPort}/terminal/sessions`, { headers: headers(revived) }).then((r) => r.json());
    assert.equal(listed.sessions[0].resume, undefined, "清空落盘（字段不再随列表下发）");
    assert.equal(listed.sessions[0].spawnedAt, freshBody.spawnedAt, "本轮进程生日随会话落盘，恢复后不拿 createdAt 抢绑旧历史");
    assert.equal(listed.sessions[0].label, "新会话", "新身份落盘");
  } finally {
    if (revived) await revived.close().catch(() => {});
    await host.close().catch(() => {});
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

test("restart 保史：镜像与字节窗原地保留，新进程续写在旧画面下方", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-keep-history-`);
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, isAliveFn: () => false, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "保史", cwd: root, shell: "powershell", cols: 20, rows: 4 }),
    }).then((r) => r.json());
    for (let i = 1; i <= 8; i += 1) calls[0].pty.dataListener?.(`行 ${i}\r\n`);
    const session = host.sessions.get(created.id);
    const historyBefore = session.screen.info().historyLines;
    const bufferBefore = session.buffer.length;
    assert.ok(historyBefore > 0, "前置：已有滚动历史");
    assert.ok(bufferBefore >= 8, "前置：字节窗已有输出块");

    const restarted = await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST", headers: headers(host),
    });
    assert.equal(restarted.status, 200);
    assert.equal(calls.length, 2, "restart 重新 spawn");
    assert.equal((await restarted.json()).status, "running", "重开后回到 running");

    assert.equal(session.screen.info().historyLines, historyBefore + 4, "重开不清镜像滚动区，旧屏整屏归档（历史归页签＋干净基底，2026-10-29 拍板）");
    assert.ok(session.buffer.length >= bufferBefore, "重开不得清字节窗");
    assert.ok(session.screen.screenLines().every((line) => line === ""), "新进程画在干净屏上（旧屏不留在可见区被无擦除 TUI 叠画）");
    assert.ok(session.screen.historyLines().join("|").includes("行 8"), "旧屏内容在滚动区里可回翻");

    // 续写：新进程从干净屏顶部起笔（归档后光标在行首，首行不触发滚动）
    calls[1].pty.dataListener?.("新进程行 1\r\n");
    assert.equal(session.screen.info().historyLines, historyBefore + 4, "归档后历史只增不减");
    assert.ok(session.screen.screenLines()[0].includes("新进程行 1"), "新进程输出落在干净屏顶部");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("迟到退出不判死新一代：旧进程的 onExit 晚到时只记一笔，状态保持 running", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-stale-exit-"));
  let pidSeq = 6100;
  const spawned = [];
  class DeferredExitPty extends FakePty {
    constructor() { super(); this.pid = pidSeq += 1; this.exitFired = false; }
    kill() { /* 退出通知由用例手动迟到送达 */ }
    fireExit(code = 0) { if (this.exitFired) return; this.exitFired = true; this.exitListener?.({ exitCode: code }); }
  }
  const host = createTerminalHost({
    root, port: 0, logger: { warn() {} },
    ptyModule: { spawn: () => { const p = new DeferredExitPty(); spawned.push(p); return p; } },
    killTreeFn: async () => {},
    isAliveFn: () => false,
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "迟到退出", cwd: root, shell: "cmd" }),
    }).then((r) => r.json());
    const oldPty = spawned[0];
    const restarted = await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST", headers: headers(host),
    }).then((r) => r.json());
    assert.equal(restarted.status, "running", "前置：重启后新进程在跑");
    assert.notEqual(spawned[1], oldPty, "前置：确实换了新一代进程");

    oldPty.fireExit(1);
    const after = await fetch(url(`/terminal/sessions/${created.id}`), { headers: headers(host) }).then((r) => r.json());
    assert.equal(after.status, "running", "旧进程迟到的退出不得把新一代判死");
    assert.equal(host.sessions.get(created.id).pty, spawned[1], "当前句柄仍是新一代");

    // 新一代自己退出时照常落已退出态。
    spawned[1].fireExit(0);
    const exited = await fetch(url(`/terminal/sessions/${created.id}`), { headers: headers(host) }).then((r) => r.json());
    assert.equal(exited.status, "exited", "本代退出照常生效");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("并发 restart 合并成一次 spawn：两个请求拿到同一份快照", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-restart-merge-"));
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, isAliveFn: () => false, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "并发", cwd: root, shell: "cmd" }),
    }).then((r) => r.json());
    assert.equal(calls.length, 1, "前置：建会话 spawn 一次");

    const [a, b] = await Promise.all([
      fetch(url(`/terminal/sessions/${created.id}/restart`), { method: "POST", headers: headers(host) }).then((r) => r.json()),
      fetch(url(`/terminal/sessions/${created.id}/restart`), { method: "POST", headers: headers(host) }).then((r) => r.json()),
    ]);
    assert.equal(calls.length, 2, "两个并发重启只允许一次重新 spawn");
    assert.equal(a.pid, b.pid, "两个响应指向同一个新进程");
    assert.equal(a.status, "running");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart 衔接卫生：死在备屏先弹回主画面、旧屏归档进滚动区，合成字节入 journal", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-keep-history-`);
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, isAliveFn: () => false, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "衔接", cwd: root, shell: "powershell", cols: 20, rows: 4 }),
    }).then((r) => r.json());
    // 主屏光标停半行后死进备屏（kimi 崩溃/TUI 退出形态）
    calls[0].pty.dataListener?.("主屏半行");
    calls[0].pty.dataListener?.("\u001b[?1049h");
    calls[0].pty.dataListener?.("备屏帧 A\r\n");
    const session = host.sessions.get(created.id);
    assert.equal(session.screen.info().inAlt, true, "前置：死在备屏");
    assert.equal(session.screen.info().col, 0, "前置：备屏内光标在行首（半行状态在主屏的保存位上）");

    const restarted = await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST", headers: headers(host),
    });
    assert.equal(restarted.status, 200);

    const info = session.screen.info();
    assert.equal(info.inAlt, false, "重开前必须弹回主画面——否则新进程输出画进备屏、退屏时整段丢");
    assert.equal(info.col, 0, "弹回并归档后光标在行首");
    assert.ok(session.screen.screenLines().every((line) => line === ""), "旧屏整屏归档：可见区干净（无擦除 TUI 叠不出残影）");
    assert.ok(session.screen.historyLines().join("|").includes("主屏半行"), "旧屏内容进滚动区可回翻");
    // 合成字节走 emit 单咽喉：进字节窗，在线客户端与宿主重启恢复同拍复现同一衔接
    assert.ok(session.buffer.some((chunk) => chunk.includes("\u001b[?1049l")), "弹屏字节入 journal");
    assert.ok(session.buffer.some((chunk) => chunk.includes("\u001b[r\u001b[4;1H")), "旧屏归档序列入 journal（重置滚动区＋滚到底＋整屏 LF）");

    // 续写从干净屏顶部起笔
    calls[1].pty.dataListener?.("新壳起笔");
    assert.ok(session.screen.screenLines()[0].includes("新壳起笔"), "新进程首行落在干净屏顶部");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("内切换换 agent：镜像按身份重置，新会话页不回填老会话画面（claude→kimi 显形根治）", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-identity-reset-`);
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, isAliveFn: () => false, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    // 老 agent（claude）会话：整屏都是它的画面，底部已滚出历史
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({
        label: "老会话", cwd: root, shell: "cmd", cols: 20, rows: 4,
        agentId: "claude", agentName: "Claude Code",
        resume: { endpoint: "claude", id: "c-old" },
        launch: { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\claude.cmd"] },
      }),
    }).then((r) => r.json());
    for (let i = 1; i <= 8; i += 1) calls[0].pty.dataListener?.(`CLAUDE帧-${i}\r\n`);
    const session = host.sessions.get(created.id);
    assert.ok(session.screen.info().historyLines > 0, "前置：老 agent 画面已滚出历史");
    assert.ok(session.screen.screenLines().join("|").includes("CLAUDE帧-8"), "前置：老画面占满当前屏");

    // 内切成 kimi 纯新会话（换 agentId ＋ clearResume 显式清旧 resume）
    const switched = await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({
        label: "新会话", agentId: "kimi", agentName: "Kimi Code", clearResume: true,
        launch: { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\kimi.cmd"] },
      }),
    });
    assert.equal(switched.status, 200, "内切换绑成功");

    // 重挂即按镜像整屏重绘：新镜像必须查不到老 agent 的任何帧
    const replay = session.screen.toReplay();
    assert.ok(!replay.includes("CLAUDE帧"), "回放里不得残留老 agent 画面（客户端重挂不回填）");
    // 纯新会话界面：新镜像必须与同尺寸全新会话的镜像逐字节一致（替代无钉力的
    // 「以清屏序列开场」——toReplay 无条件以该前缀开场，钉不住任何东西）。
    assert.equal(replay, createScreenMirror({ cols: 20, rows: 4 }).toReplay(), "新镜像与全新会话逐字节一致");
    assert.equal(session.screen.info().historyLines, 0, "镜像历史一并清空（重建镜像，不靠 3J no-op）");
    // 字节窗是宿主重启恢复的原料：旧 agent 字节全部作废，只剩重置序列（旧帧不再跨重挂常驻）
    assert.equal(session.buffer.join(""), "\u001b[0m\u001b[2J\u001b[H", "清窗后 journal 只剩清屏序列");
    assert.equal(session.bufferBytes, 11, "字节计数同步归零后只剩清屏序列的字节");

    // 新 agent 从干净屏顶部起笔
    calls[1].pty.dataListener?.("KIMI开场\r\n");
    assert.ok(session.screen.screenLines()[0].includes("KIMI开场"), "新输出落在干净屏顶部");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("内切换换 agent（老进程死在备屏）：先弹备屏再清屏，1049l 先于 2J 发出", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-identity-reset-alt-`);
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, isAliveFn: () => false, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({
        label: "老会话", cwd: root, shell: "cmd", cols: 20, rows: 4,
        agentId: "claude", agentName: "Claude Code",
        launch: { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\claude.cmd"] },
      }),
    }).then((r) => r.json());
    // claude 被整树 terminate 来不及退屏：死在备屏，主屏还留着它进场前的画面
    calls[0].pty.dataListener?.("主屏CLAUDE底\r\n");
    calls[0].pty.dataListener?.("\u001b[?1049h");
    calls[0].pty.dataListener?.("备屏CLAUDE帧\r\n");
    const session = host.sessions.get(created.id);
    assert.equal(session.screen.info().inAlt, true, "前置：老 agent 死在备屏");

    const switched = await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({
        label: "新会话", agentId: "kimi", agentName: "Kimi Code", clearResume: true,
        launch: { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\kimi.cmd"] },
      }),
    });
    assert.equal(switched.status, 200, "内切换绑成功");

    // 顺序硬要求：先弹备屏（让已挂客户端离备屏）再清屏——反了清屏落进备屏，
    // 应用退屏时主画面又回来。journal 一根咽喉，顺序即字节序。
    assert.equal(session.buffer.join(""), "\u001b[?1049l\u001b[0m\u001b[2J\u001b[H", "先 1049l 后 SGR0+2J+H");
    assert.equal(session.screen.info().inAlt, false, "新镜像在主屏");
    assert.ok(!session.screen.toReplay().includes("CLAUDE"), "老帧（含备屏帧）不回填");
    assert.equal(session.screen.info().historyLines, 0, "镜像历史清空");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("同身份 restart 保史：同 agentId/resume 重开仍走衔接卫生（防回退钉）", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-identity-keep-`);
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, isAliveFn: () => false, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({
        label: "保史会话", cwd: root, shell: "cmd", cols: 20, rows: 4,
        agentId: "kimi", agentName: "Kimi Code",
        resume: { endpoint: "kimi", id: "conv-1" },
        launch: { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\kimi.cmd"] },
      }),
    }).then((r) => r.json());
    for (let i = 1; i <= 8; i += 1) calls[0].pty.dataListener?.(`行 ${i}\r\n`);
    const session = host.sessions.get(created.id);
    const historyBefore = session.screen.info().historyLines;
    const bufferBefore = session.buffer.length;
    assert.ok(historyBefore > 0, "前置：已有滚动历史");

    // 面板带全量身份字段复活/重挂：agentId 与 resume 原样带回＝身份没变
    const same = await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({
        label: "保史会话", agentId: "kimi", agentName: "Kimi Code",
        resume: { endpoint: "kimi", id: "conv-1" },
        launch: { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\kimi.cmd"] },
      }),
    });
    assert.equal(same.status, 200, "同身份重开成功");
    assert.equal(session.screen.info().historyLines, historyBefore + 4, "同身份重开不清镜像滚动区，旧屏归档后只增不减（回滚历史归页签）");
    assert.ok(session.buffer.length >= bufferBefore, "同身份重开不得清字节窗");
    assert.ok(session.screen.historyLines().join("|").includes("行 8"), "旧画面内容在滚动区可回翻");
    calls[1].pty.dataListener?.("续写行\r\n");
    assert.ok(session.screen.screenLines()[0].includes("续写行"), "新输出落在干净屏顶部");

    // 换成另一段会话（同 agent、resume id 不同）＝身份变了：镜像按身份重置
    for (let i = 1; i <= 3; i += 1) calls[1].pty.dataListener?.(`切换前帧-${i}\r\n`);
    const otherConv = await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({
        agentId: "kimi", agentName: "Kimi Code",
        resume: { endpoint: "kimi", id: "conv-2" },
      }),
    });
    assert.equal(otherConv.status, 200, "换 resume 重开成功");
    assert.ok(!session.screen.toReplay().includes("行 8"), "换 resume 后旧会话画面不回填");
    assert.ok(!session.screen.toReplay().includes("切换前帧"), "换 resume 后上一会话画面不回填");
    assert.equal(session.screen.info().historyLines, 0, "换 resume 后镜像历史清空");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("同 agent 全新内切：同 agentId ＋ clearResume 清旧 resume，重置由 clearResume 项独立兜住", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-identity-clear-`);
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, isAliveFn: () => false, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({
        label: "旧会话", cwd: root, shell: "cmd", cols: 20, rows: 4,
        agentId: "kimi", agentName: "Kimi Code",
        resume: { endpoint: "kimi", id: "conv-1" },
        launch: { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\kimi.cmd"] },
      }),
    }).then((r) => r.json());
    for (let i = 1; i <= 8; i += 1) calls[0].pty.dataListener?.(`旧会话帧-${i}\r\n`);
    const session = host.sessions.get(created.id);
    assert.ok(session.screen.info().historyLines > 0, "前置：旧会话已滚出历史");

    // 生产唯一触发形态（panel.mjs 全新内切恒发）：同一 agentId ＋ clearResume、
    // 不带 resume——identityChanged 三分项里只有 clearResume 项为真，重置必须
    // 由它独立兜住；该项回退，同 agent 新会话回填旧画面的 bug 原地复活。
    const switched = await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({
        label: "新会话", agentId: "kimi", agentName: "Kimi Code", clearResume: true,
        launch: { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\kimi.cmd"] },
      }),
    });
    assert.equal(switched.status, 200, "同 agent 全新内切成功");
    assert.ok(!session.screen.toReplay().includes("旧会话帧"), "同 agent 新会话不得回填旧会话画面");
    assert.equal(session.screen.info().historyLines, 0, "镜像历史清空");
    assert.equal(session.buffer.join(""), "\u001b[0m\u001b[2J\u001b[H", "journal 只剩清屏序列");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("内切换 agentId 单独变化（不带 resume/clearResume）：重置由 agentId 项独立兜住", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-identity-agentid-`);
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, isAliveFn: () => false, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    // 老会话没有 resume（session.resume 未落过）——三分项里 clearResume 项恒假，
    // 只有 agentId 项能为真
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({
        label: "老会话", cwd: root, shell: "cmd", cols: 20, rows: 4,
        agentId: "claude", agentName: "Claude Code",
        launch: { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\claude.cmd"] },
      }),
    }).then((r) => r.json());
    for (let i = 1; i <= 8; i += 1) calls[0].pty.dataListener?.(`CLAUDE帧-${i}\r\n`);
    const session = host.sessions.get(created.id);
    assert.ok(session.screen.info().historyLines > 0, "前置：老画面已滚出历史");

    const switched = await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({
        label: "新会话", agentId: "kimi", agentName: "Kimi Code",
        launch: { file: process.env.ComSpec, args: ["/d", "/c", "C:\\fake\\kimi.cmd"] },
      }),
    });
    assert.equal(switched.status, 200, "内切换绑成功");
    assert.ok(!session.screen.toReplay().includes("CLAUDE帧"), "仅 agentId 变化也要重置：老画面不回填");
    assert.equal(session.screen.info().historyLines, 0, "镜像历史清空");
    assert.equal(session.buffer.join(""), "\u001b[0m\u001b[2J\u001b[H", "journal 只剩清屏序列");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart 幂等：连续重开不重复注水、历史只增不减", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-keep-history-`);
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, isAliveFn: () => false, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "幂等", cwd: root, shell: "powershell", cols: 20, rows: 4 }),
    }).then((r) => r.json());
    for (let i = 1; i <= 8; i += 1) calls[0].pty.dataListener?.(`行 ${i}\r\n`);
    await fetch(url(`/terminal/sessions/${created.id}/restart`), { method: "POST", headers: headers(host) });
    const session = host.sessions.get(created.id);
    const historyFirst = session.screen.info().historyLines;
    const bufferFirst = session.buffer.length;
    assert.ok(historyFirst > 0, "前置：第一次重开已保史");

    // 第二次重开：其间无新输出，光标已在行首且不在备屏——不得再注入合成字节
    await fetch(url(`/terminal/sessions/${created.id}/restart`), { method: "POST", headers: headers(host) });
    assert.equal(calls.length, 3, "第二次照常重 spawn");
    assert.equal(session.screen.info().historyLines, historyFirst, "无新输出时历史不动");
    assert.equal(session.buffer.length, bufferFirst, "已在行首且非备屏时不注水（幂等）");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("宿主重启后 revive 保史：恢复的镜像不被重开路由抹掉（重启劫回归钉）", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-keep-history-`);
  const first = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule: first.ptyModule, isAliveFn: () => false, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  let hostClosed = false;
  let secondHost = null;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "重启劫", cwd: root, shell: "powershell", cols: 20, rows: 4 }),
    }).then((r) => r.json());
    for (let i = 1; i <= 8; i += 1) first.calls[0].pty.dataListener?.(`历史源 ${i}\r\n`);
    await host.persistNow();
    await host.close();
    hostClosed = true;

    // 宿主重启：restore 从盘上尾窗重喂镜像——这就是面板 attach 自动 revive 的起点
    const second = capturingPtyModule();
    secondHost = createTerminalHost({ root, port: 0, ptyModule: second.ptyModule, isAliveFn: () => false, logger: { warn() {} } });
    const port2 = await listen(secondHost);
    const url2 = (path) => `http://127.0.0.1:${port2}${path}`;
    const restored = secondHost.sessions.get(created.id);
    assert.equal(restored.pty, null, "恢复的会话不自动复活");
    assert.ok(restored.screen.info().historyLines > 0, "前置：恢复即已带历史");

    const revived = await fetch(url2(`/terminal/sessions/${created.id}/restart`), { method: "POST", headers: headers(secondHost) });
    assert.equal(revived.status, 200);
    assert.ok(restored.screen.info().historyLines > 0, "revive 不得把恢复的镜像抹成空屏（历史归页签）");
    assert.ok(restored.screen.historyLines().join("|").includes("历史源"), "恢复的旧屏归档进滚动区，内容可回翻");
    assert.ok(restored.screen.screenLines().every((line) => line === ""), "revive 后可见区干净，新进程画在干净屏上");
    // 续写从干净屏顶部起笔
    second.calls[0].pty.dataListener?.("revive 续写\r\n");
    assert.ok(restored.screen.screenLines()[0].includes("revive 续写"), "revive 后新输出落在干净屏顶部");
  } finally {
    if (!hostClosed) await host.close().catch(() => {});
    if (secondHost) await secondHost.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

// 恢复的端到端判据是「逐字节一致」而不是「有内容」：重启后 F5 看到的画面必须
// 就是关停前那张——快照经 JSON 落盘再读回，任何编解码损失都会在这里现形。
test("快照恢复端到端：落盘→重启→重建的画面与关停前逐字节一致", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-snapshot-e2e-`);
  const first = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule: first.ptyModule, isAliveFn: () => false, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  let secondHost = null;
  let hostClosed = false;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "端到端", cwd: root, shell: "powershell", cols: 20, rows: 4 }),
    }).then((r) => r.json());
    const pty = first.calls[0].pty;
    pty.dataListener?.("普通行\r\n\x1b[1m粗体\x1b[0m中文🏴‍☠️宽\r\n");
    for (let i = 1; i <= 9; i += 1) pty.dataListener?.(`历史 ${i}\r\n`);
    pty.dataListener?.("\x1b7\x1b[?1049h备屏帧\x1b[?2004h");
    await host.persistNow();
    const before = host.sessions.get(created.id).screen.toReplay();
    await host.close();
    hostClosed = true;

    secondHost = createTerminalHost({
      root, port: 0, ptyModule: { spawn: () => new FakePty() }, isAliveFn: () => false, logger: { warn() {} },
    });
    const restored = secondHost.sessions.get(created.id);
    assert.ok(restored, "盘上落过的会话读得回来");
    assert.equal(restored.screen.toReplay(), before, "恢复画面与关停前逐字节一致（含备屏语态）");
    assert.equal(restored.screen.info().inAlt, true, "备屏语态随快照恢复");
    // 恢复后备屏语义连续：退屏落到同一张主屏、同一个保存点
    restored.screen.write("\x1b[?1049l\x1b8");
    assert.ok(restored.screen.screenLines().join("|").includes("历史 9"), "退屏后主屏画面在（保存点与可见内容随快照回来）");
  } finally {
    if (!hostClosed) await host.close().catch(() => {});
    if (secondHost) await secondHost.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

// 归档只针对「看得见东西」的屏：零输出会话重开不注入任何合成字节——
// 不把一排空行推进历史，也不给在线客户端发无意义帧。
test("衔接卫生对空白屏是纯空跳：零输出会话重开不注入任何合成字节", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-hygiene-blank-`);
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, isAliveFn: () => false, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "空白", cwd: root, shell: "powershell", cols: 20, rows: 4 }),
    }).then((r) => r.json());
    const session = host.sessions.get(created.id);
    assert.equal(session.buffer.length, 0, "前置：零输出");
    await fetch(url(`/terminal/sessions/${created.id}/restart`), { method: "POST", headers: headers(host) });
    assert.equal(session.buffer.length, 0, "空白屏重开不注入合成字节（无归档、无补行）");
    assert.equal(session.screen.info().historyLines, 0, "历史不被空行污染");
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

// relay 关停宿主前的清场（stop 带 clearSessions）：存活 PTY 杀掉、挂着流的
// 监听器收到退出通知、内存表与落盘文件一起归零。
test("POST /terminal/sessions/clear-all 杀掉存活 PTY、清空内存表与落盘文件", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-clearall-`);
  const { calls, ptyModule } = capturingPtyModule();
  const host = createTerminalHost({ root, port: 0, ptyModule, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host), body: JSON.stringify({ label: "甲", cwd: root, shell: "powershell" }),
    });
    const second = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host), body: JSON.stringify({ label: "乙", cwd: root, shell: "cmd" }),
    }).then((r) => r.json());
    // 已退出的会话同样在清空范围内；它挂着的流靠 clear-all 自己通知。
    calls[1].pty.kill();
    const exitNotices = [];
    host.sessions.get(second.id).listeners.add((chunk) => {
      if (chunk === null) exitNotices.push(second.id);
    });

    const response = await fetch(url("/terminal/sessions/clear-all"), { method: "POST", headers: headers(host) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, cleared: 2 });
    assert.equal(host.sessions.size, 0, "内存会话表清空");
    assert.deepEqual(exitNotices, [second.id], "挂着流的会话收到退出通知");
    assert.deepEqual(JSON.parse(readFileSync(host.statePath, "utf8")).sessions, [], "落盘文件写成空");

    const listed = await fetch(url("/terminal/sessions"), { headers: headers(host) }).then((r) => r.json());
    assert.deepEqual(listed.sessions, []);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /terminal/sessions/clear-all 空表也是 ok，且不许被当成会话 id", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-clearall-`);
  const host = createTerminalHost({ root, port: 0, ptyModule: { spawn: () => new FakePty() }, logger: { warn() {} } });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const response = await fetch(url("/terminal/sessions/clear-all"), { method: "POST", headers: headers(host) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, cleared: 0 });
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// installTerminalHostFaultHandlers: the host normally runs windowless with its
// stderr tee'd into logs/terminal-host.log by the spawning relay. These tests
// drive the returned handlers directly — emitting real process events would
// race the test runner's own listeners.
test("installTerminalHostFaultHandlers records uncaughtException and unhandledRejection to the log file and stderr sink", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-faults-"));
  const logPath = join(root, "logs", "terminal-host.log"); // logs/ does not exist yet — the handler must create it
  const written = [];
  const handle = installTerminalHostFaultHandlers({ logPath, write: (line) => written.push(line) });
  try {
    handle.onUncaught(new Error("socket exploded"));
    handle.onUnhandled(new Error("stray rejection"));
  } finally {
    handle.dispose();
  }
  const text = readFileSync(logPath, "utf8");
  assert.ok(text.includes("[uncaughtException]"), "the uncaught exception is labelled");
  assert.ok(text.includes("socket exploded"), "and carries the trace");
  assert.ok(text.includes("[unhandledRejection]"), "the rejection is labelled");
  assert.ok(text.includes("stray rejection"));
  assert.equal(written.length, 2, "the stderr sink receives the same two lines");
  assert.ok(/^\[\d{4}-\d{2}-\d{2} /m.test(text), "every line carries a wall-clock stamp");
  rmSync(root, { recursive: true, force: true });
});

test("installTerminalHostFaultHandlers registers and disposes its process listeners", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-faults-"));
  const beforeU = process.listenerCount("uncaughtException");
  const beforeR = process.listenerCount("unhandledRejection");
  const handle = installTerminalHostFaultHandlers({ logPath: join(root, "terminal-host.log"), write: () => {} });
  assert.equal(process.listenerCount("uncaughtException"), beforeU + 1);
  assert.equal(process.listenerCount("unhandledRejection"), beforeR + 1);
  handle.dispose();
  assert.equal(process.listenerCount("uncaughtException"), beforeU, "dispose removes the listener");
  assert.equal(process.listenerCount("unhandledRejection"), beforeR);
  rmSync(root, { recursive: true, force: true });
});

test("installTerminalHostFaultHandlers never throws on an unwritable log path", () => {
  const handle = installTerminalHostFaultHandlers({ logPath: "Z:\no-such-drive\terminal-host.log", write: () => {} });
  try {
    assert.doesNotThrow(() => handle.onUncaught(new Error("boom")), "a dead log file must not kill the crash handler");
  } finally {
    handle.dispose();
  }
});


// ---------------------------------------------------------------------------
// 关闭路径的进程树终结。病灶（2026-10-16 幽灵 kimi 实证）：close 只调
// pty.kill()，而 ConPTY 的 DLL 模式 kill 只销毁输入句柄＋关伪控制台——kimi 的
// node 主进程与控制台生命周期解耦，会话记录删了、页签没了，进程还挂在看板
// 卡上永「待命」，用户找不到任何关它的入口。修法是宿主收回「进程死没死」的
// 所有权：close / clear-all / restart 统一走「pty.kill 关控制台 → 对登记的
// shell pid 树杀」，树杀不依赖 node-pty 内部行为（父子链不随控制台解耦而断）。
// 测试注入 killTreeFn（记录 pid 列表，不动真进程）与 isAliveFn（控制 pid 死活）。

test("close 路由在 pty.kill 之后对会话 shell 树杀，会话照常删除", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-treekill-"));
  const { ptyModule } = capturingPtyModule();
  const killed = [];
  const host = createTerminalHost({
    root, port: 0, ptyModule, logger: { warn() {} },
    killTreeFn: async (pid) => { killed.push(pid); },
    isAliveFn: () => true,
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "树杀", cwd: root, shell: "cmd" }),
    }).then((r) => r.json());
    const shellPid = created.pid;
    const res = await fetch(url(`/terminal/sessions/${created.id}/close`), {
      method: "POST", headers: headers(host),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(killed, [shellPid], "close 必须对登记的 shell pid 补树杀");
    assert.equal(host.sessions.has(created.id), false, "会话照常从表里删除");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell 已先退（pty=null）的会话 close 不做树杀——pid 可能已复用，宁漏勿错", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-treekill-skip-"));
  const { calls, ptyModule } = capturingPtyModule();
  const killed = [];
  const host = createTerminalHost({
    root, port: 0, ptyModule, logger: { warn() {} },
    killTreeFn: async (pid) => { killed.push(pid); },
    isAliveFn: () => true,
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "先退", cwd: root, shell: "powershell" }),
    }).then((r) => r.json());
    calls[0].pty.kill();
    const res = await fetch(url(`/terminal/sessions/${created.id}/close`), {
      method: "POST", headers: headers(host),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(killed, [], "pty 已置空的会话不许碰它留下的 pid");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart 在新 spawn 前对旧 shell 树杀，控制台解耦的旧 agent 不双开", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-treekill-restart-"));
  const { calls, ptyModule } = capturingPtyModule();
  const killed = [];
  const host = createTerminalHost({
    root, port: 0, ptyModule, logger: { warn() {} },
    killTreeFn: async (pid) => { killed.push(pid); },
    isAliveFn: () => true,
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ label: "重启", cwd: root, shell: "cmd" }),
    }).then((r) => r.json());
    const oldPid = created.pid;
    await fetch(url(`/terminal/sessions/${created.id}/restart`), {
      method: "POST", headers: headers(host), body: "{}",
    }).then((r) => r.json());
    assert.deepEqual(killed, [oldPid], "restart 前必须先终结旧 shell 的树");
    assert.equal(calls.length, 2, "restart 照旧重 spawn");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear-all 对每个存活会话树杀，清场后不留控制台解耦的进程", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-treekill-clear-"));
  const { ptyModule } = capturingPtyModule();
  const killed = [];
  const host = createTerminalHost({
    root, port: 0, ptyModule, logger: { warn() {} },
    killTreeFn: async (pid) => { killed.push(pid); },
    isAliveFn: () => true,
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    for (const label of ["甲", "乙"]) {
      await fetch(url("/terminal/sessions"), {
        method: "POST", headers: headers(host),
        body: JSON.stringify({ label, cwd: root, shell: "cmd" }),
      }).then((r) => r.json());
    }
    const res = await fetch(url("/terminal/sessions/clear-all"), {
      method: "POST", headers: headers(host),
    }).then((r) => r.json());
    assert.equal(res.cleared, 2);
    assert.deepEqual(killed, [4321, 4321], "两个会话的 shell 各吃一次树杀（FakePty pid 相同）");
    assert.equal(host.sessions.size, 0, "会话表清空");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("恢复时一键启动会话的进程还活着→杀树后按已退出恢复（幽灵根治）", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-treekill-reap-"));
  const ghostShellPid = 19596;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(root, "terminal-sessions.json"), JSON.stringify({
    version: 1,
    sessions: [{
      id: "ghost-session-1", label: "Kimi Code", cwd: root, shell: "cmd",
      pid: ghostShellPid, createdAt: 1, lastActiveAt: 1, cols: 120, rows: 34,
      buffer: [], status: "exited", exitCode: null,
      agentId: "kimi", agentName: "Kimi Code",
    }],
  }, null, 2));
  const killed = [];
  const host = createTerminalHost({
    root, port: 0,
    ptyModule: { spawn: () => new FakePty() }, logger: { warn() {} },
    killTreeFn: async (pid) => { killed.push(pid); },
    isAliveFn: (pid) => pid === ghostShellPid,
    // 命令行对得上本会话的启动执行体，才允许清扫动手。
    getCommandLineFn: async () => "C:\\Windows\\System32\\cmd.exe /d /c kimi.exe",
  });
  try {
    await host.restoreSweep;
    assert.deepEqual(killed, [ghostShellPid], "恢复即对上代泄漏的 shell 树杀");
    const session = host.sessions.get("ghost-session-1");
    assert.equal(session.pty, null, "恢复的会话保持已退出态，不自动复活");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("恢复时命令行只有 cmd 包装、没有 agent 执行体（pid 被复用给无关 cmd）→ 不树杀", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-treekill-wrapper-"));
  const reusedPid = 19599;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(root, "terminal-sessions.json"), JSON.stringify({
    version: 1,
    sessions: [{
      id: "wrapper-only", label: "Kimi Code", cwd: root, shell: "cmd",
      pid: reusedPid, createdAt: 1, lastActiveAt: 1, cols: 120, rows: 34,
      buffer: [], status: "exited", exitCode: null, agentId: "kimi", agentName: "Kimi Code",
      launch: { file: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/c", "chcp", "65001", ">nul", "&", "C:\\tools\\kimi.exe"] },
    }],
  }, null, 2));
  const killed = [];
  const host = createTerminalHost({
    root, port: 0,
    ptyModule: { spawn: () => new FakePty() }, logger: { warn() {} },
    killTreeFn: async (pid) => { killed.push(pid); },
    isAliveFn: () => true,
    // 只对得上 cmd.exe，对不上 agent 执行体：这不是本会话那棵树。
    getCommandLineFn: async () => "C:\\Windows\\System32\\cmd.exe /c something-else",
  });
  try {
    await host.restoreSweep;
    assert.deepEqual(killed, [], "只命中包装壳不算身份吻合");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("恢复时命令行同时含包装壳与 agent 执行体→认定本会话并树杀", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-treekill-full-"));
  const ghostPid = 19600;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(root, "terminal-sessions.json"), JSON.stringify({
    version: 1,
    sessions: [{
      id: "full-match", label: "Kimi Code", cwd: root, shell: "cmd",
      pid: ghostPid, createdAt: 1, lastActiveAt: 1, cols: 120, rows: 34,
      buffer: [], status: "exited", exitCode: null, agentId: "kimi", agentName: "Kimi Code",
      launch: { file: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/c", "chcp", "65001", ">nul", "&", "C:\\tools\\kimi.exe"] },
    }],
  }, null, 2));
  const killed = [];
  const host = createTerminalHost({
    root, port: 0,
    ptyModule: { spawn: () => new FakePty() }, logger: { warn() {} },
    killTreeFn: async (pid) => { killed.push(pid); },
    isAliveFn: () => true,
    getCommandLineFn: async () => "C:\\Windows\\System32\\cmd.exe /d /c chcp 65001 >nul & C:\\tools\\kimi.exe",
  });
  try {
    await host.restoreSweep;
    assert.deepEqual(killed, [ghostPid], "包装壳与执行体都在，才认本会话");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("恢复时 pid 活着但命令行对不上（pid 被复用）→ 不树杀", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-treekill-reuse-"));
  const reusedPid = 19597;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(root, "terminal-sessions.json"), JSON.stringify({
    version: 1,
    sessions: [{
      id: "reused-session", label: "Kimi Code", cwd: root, shell: "cmd",
      pid: reusedPid, createdAt: 1, lastActiveAt: 1, cols: 120, rows: 34,
      buffer: [], status: "exited", exitCode: null,
      agentId: "kimi", agentName: "Kimi Code",
    }],
  }, null, 2));
  const killed = [];
  const host = createTerminalHost({
    root, port: 0,
    ptyModule: { spawn: () => new FakePty() }, logger: { warn() {} },
    killTreeFn: async (pid) => { killed.push(pid); },
    isAliveFn: () => true,
    getCommandLineFn: async () => "C:\\Windows\\System32\\notepad.exe",
  });
  try {
    await host.restoreSweep;
    assert.deepEqual(killed, [], "命令行不属于本会话的 pid 不许碰");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("恢复时命令行查不到（查询失败）→ 不树杀", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-treekill-nocmd-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(root, "terminal-sessions.json"), JSON.stringify({
    version: 1,
    sessions: [{
      id: "unknown-cmd", label: "Kimi Code", cwd: root, shell: "cmd",
      pid: 19598, createdAt: 1, lastActiveAt: 1, cols: 120, rows: 34,
      buffer: [], status: "exited", exitCode: null, agentId: "kimi", agentName: "Kimi Code",
    }],
  }, null, 2));
  const killed = [];
  const host = createTerminalHost({
    root, port: 0,
    ptyModule: { spawn: () => new FakePty() }, logger: { warn() {} },
    killTreeFn: async (pid) => { killed.push(pid); },
    isAliveFn: () => true,
    getCommandLineFn: async () => null,
  });
  try {
    await host.restoreSweep;
    assert.deepEqual(killed, [], "查不到身份就按「不是本会话」处理");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("恢复时进程已死（pid 可能已被复用）→ 不树杀，纯按已退出恢复", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-treekill-dead-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(root, "terminal-sessions.json"), JSON.stringify({
    version: 1,
    sessions: [{
      id: "dead-session", label: "Kimi Code", cwd: root, shell: "cmd",
      pid: 99999, createdAt: 1, lastActiveAt: 1, cols: 120, rows: 34,
      buffer: [], status: "exited", exitCode: null, agentId: "kimi", agentName: "Kimi Code",
    }],
  }, null, 2));
  const killed = [];
  const host = createTerminalHost({
    root, port: 0,
    ptyModule: { spawn: () => new FakePty() }, logger: { warn() {} },
    killTreeFn: async (pid) => { killed.push(pid); },
    isAliveFn: () => false,
  });
  try {
    assert.deepEqual(killed, [], "死 pid 不许碰");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("纯外壳会话（无 agentId）即使 pid 活着也不树杀——泄漏面只属一键启动会话", async () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-terminal-treekill-plain-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(root, "terminal-sessions.json"), JSON.stringify({
    version: 1,
    sessions: [{
      id: "plain-shell", label: "终端", cwd: root, shell: "powershell",
      pid: 4321, createdAt: 1, lastActiveAt: 1, cols: 120, rows: 34,
      buffer: [], status: "exited", exitCode: null,
    }],
  }, null, 2));
  const killed = [];
  const host = createTerminalHost({
    root, port: 0,
    ptyModule: { spawn: () => new FakePty() }, logger: { warn() {} },
    killTreeFn: async (pid) => { killed.push(pid); },
    isAliveFn: () => true,
  });
  try {
    assert.deepEqual(killed, [], "纯外壳不在清扫面内");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("终端询问扫描器：整段/跨块各认领一次，询问字节从转发流里摘掉，纯绘制不误伤", () => {
  const whole = createTerminalQueryScanner();
  const theme = whole.push("hi\x1b[?996n!");
  assert.deepEqual(theme.probes, ["theme"], "996n 认领");
  assert.equal(theme.text, "hi!", "询问字节不得留在转发流里");

  const split = createTerminalQueryScanner();
  const splitHead = split.push("x\x1b[?9");
  assert.deepEqual(splitHead.probes, [], "前半段悬而不认领");
  assert.equal(splitHead.text, "x", "拼齐前的可见字节照常转发");
  const finished = split.push("96n");
  assert.deepEqual(finished.probes, ["theme"], "跨块拼齐认领一次");
  assert.equal(finished.text, "", "询问字节不转发");

  const splitNotify = createTerminalQueryScanner();
  assert.deepEqual(splitNotify.push("\x1b[?2").probes, []);
  assert.deepEqual(splitNotify.push("031h").probes, ["notifyOn"], "2031 开关同样跨块可拼");

  // OSC 11 背景色询问：BEL 与 ST 两种终止符都认，终止符没到之前一律悬着
  const bel = createTerminalQueryScanner();
  assert.deepEqual(bel.push("\x1b]11;?").probes, [], "终止符没到不算完整询问");
  assert.deepEqual(bel.push("\x07").probes, ["background"], "BEL 补齐即认领");
  const st = createTerminalQueryScanner();
  assert.deepEqual(st.push("\x1b]11;?\x1b").probes, []);
  assert.deepEqual(st.push("\\").probes, ["background"], "ST 补齐同样认领");
  assert.deepEqual(createTerminalQueryScanner().push("\x1b]11;?\x07").text, "", "询问不转发");

  // DA1：ESC[c 与 ESC[0c 都认
  assert.deepEqual(createTerminalQueryScanner().push("\x1b[c").probes, ["deviceAttributes"]);
  assert.deepEqual(createTerminalQueryScanner().push("\x1b[0c").probes, ["deviceAttributes"]);

  // 普通绘制、光标定位、OSC 8 超链接原样通过
  const plain = createTerminalQueryScanner();
  const drawn = plain.push("hello \x1b[1;1H world \x1b]8;;http://x\x07link\x1b]8;;\x07");
  assert.deepEqual(drawn.probes, []);
  assert.equal(drawn.text, "hello \x1b[1;1H world \x1b]8;;http://x\x07link\x1b]8;;\x07");

  // 落单的 ESC 先扣住，下一块补齐后原样放出（问询不成形就只是普通转义序列）
  const tailEsc = createTerminalQueryScanner();
  assert.equal(tailEsc.push("abc\x1b").text, "abc", "落单 ESC 先扣住");
  assert.equal(tailEsc.push("[1;1H").text, "\x1b[1;1H", "补齐后原样放出");
});

test("终端主题契约：996n/OSC11/DA1 即问即答、问过主题即收 997 扇出、同值幂等", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-theme-`);
  const spawned = [];
  const host = createTerminalHost({
    root, port: 0,
    ptyModule: { spawn: () => { const pty = new FakePty(); spawned.push(pty); return pty; } },
    logger: { warn() {} },
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  const create = async (label) => (await fetch(url("/terminal/sessions"), {
    method: "POST", headers: headers(host), body: JSON.stringify({ label, cwd: root, shell: "powershell" }),
  })).json();
  const setTheme = async (body) => {
    const response = await fetch(url("/terminal/theme"), {
      method: "POST", headers: headers(host), body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const themeReports = (pty) => pty.writeLog.filter((log) => log.startsWith("\x1b[?997;"));
  try {
    await create("订阅者");
    await create("旁听者");
    await create("只问底色");
    const [subscriber, bystander] = spawned;

    // 未上报过主题时按暗色默认应答：996n 答 1，OSC 11 答兜底暗色
    subscriber.dataListener("\x1b[?996n");
    assert.deepEqual(subscriber.writeLog, ["\x1b[?997;1n"], "996n 按默认暗色即答");
    subscriber.dataListener("\x1b]11;?\x07");
    assert.deepEqual(subscriber.writeLog.slice(-1), ["\x1b]11;rgb:0b0b/1212/2020\x07"], "OSC 11 答兜底暗色");

    // DA1 由宿主代答，且询问字节不进转发流——回放不得让渲染器再答一遍
    const da1 = await create("问 DA1");
    const da1Pty = spawned[3];
    da1Pty.dataListener("\x1b[c");
    assert.deepEqual(da1Pty.writeLog, ["\x1b[?1;2c"], "DA1 即答");
    assert.ok(!host.sessions.get(da1.id).buffer.join("").includes("\x1b[c"), "DA1 询问不进回放缓冲");

    // 订阅者开 2031，翻转亮暗即收 997；从没问过主题的会话零扇出
    subscriber.dataListener("\x1b[?2031h");
    const flipped = await setTheme({ dark: false, background: "#f8fafc" });
    assert.equal(flipped.status, 200);
    assert.deepEqual(flipped.body, { ok: true, dark: false, background: "#f8fafc" });
    assert.deepEqual(subscriber.writeLog.slice(-1), ["\x1b[?997;2n"], "订阅者收到亮色 997 扇出");
    assert.deepEqual(bystander.writeLog, [], "从没问过主题的会话零扇出");

    // 同值重报幂等：不追加报告
    await setTheme({ dark: false, background: "#f8fafc" });
    assert.equal(themeReports(subscriber).length, 2, "同值重报不扇出");

    // 只问过背景色、没发 2031h 的会话也算在意主题（claude code 的实际形状）
    const passive = spawned[2];
    passive.dataListener("\x1b]11;?\x07");
    assert.deepEqual(passive.writeLog, ["\x1b]11;rgb:f8f8/fafa/fcfc\x07"], "OSC 11 答上报的亮色");
    await setTheme({ dark: true, background: "#0b1220" });
    assert.deepEqual(passive.writeLog.slice(-1), ["\x1b[?997;1n"], "问过主题的会话同样收到扇出");

    // 显式退订（2031l）说话算数
    passive.dataListener("\x1b[?2031l");
    await setTheme({ dark: false, background: "#f8fafc" });
    assert.equal(themeReports(passive).filter((log) => log === "\x1b[?997;2n").length, 0, "退订后不再扇出");
    // 退订只是不再推送，询问照答
    passive.dataListener("\x1b[?996n");
    assert.deepEqual(passive.writeLog.slice(-1), ["\x1b[?997;2n"], "退订后查询仍即答");

    // 非法报文 400
    assert.equal((await setTheme({ dark: "yes" })).status, 400);
    assert.equal((await setTheme({ dark: true, background: "teal" })).status, 400);

    // 跨块 996n（拆成两段 PTY 输出）也只应答一次
    await create("跨块");
    const splitPty = spawned[4];
    splitPty.dataListener("\x1b[?9");
    splitPty.dataListener("96n");
    assert.deepEqual(splitPty.writeLog, ["\x1b[?997;2n"], "跨块查询拼齐即答，一次不多");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("主题状态随状态文件跨宿主重启保留：重启后第一问就答真值", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-theme-restore-`);
  const boot = (spawned) => createTerminalHost({
    root, port: 0,
    ptyModule: { spawn: () => { const pty = new FakePty(); spawned?.push(pty); return pty; } },
    logger: { warn() {} },
  });
  let host = boot();
  let port = await listen(host);
  try {
    await fetch(`http://127.0.0.1:${port}/terminal/theme`, {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({ dark: false, background: "#f8fafc" }),
    });
    await host.close();

    // 新一代宿主：面板还没补报，agent 就已经开始问了
    const spawned = [];
    host = boot(spawned);
    port = await listen(host);
    const created = await fetch(`http://127.0.0.1:${port}/terminal/sessions`, {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({ label: "重启后", cwd: root, shell: "powershell" }),
    }).then((response) => response.json());
    assert.ok(created.id);
    spawned[0].dataListener("\x1b]11;?\x07");
    assert.deepEqual(spawned[0].writeLog, ["\x1b]11;rgb:f8f8/fafa/fcfc\x07"], "重启后底色不回落默认暗色");
    spawned[0].dataListener("\x1b[?996n");
    assert.deepEqual(spawned[0].writeLog.slice(-1), ["\x1b[?997;2n"], "重启后亮暗不回落默认暗色");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 完整颜色契约：宿主是 OSC 10 / 11 / 4 颜色询问的唯一应答者 ----
// Pi 的 TUI 启动即发 OSC 10 + OSC 11 + 16×OSC 4 + DA1，并以「DA1 收齐、缺一即
// 弃」消费应答：旧实现只认 OSC 11 与 DA1，前景色/调色板询问被转发给渲染器——
// 后台页签没有挂 xterm 就永远无答，挂着的也要等一轮网络往返，而宿主的 DA1
// 应答先到，询问方按「不完整」收场。宿主必须对全部颜色询问按序即答、DA1
// 收尾，查询字节一个都不进转发流。
const colorHex = (hex) => {
  const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((c) => c.repeat(2));
  return `rgb:${r}/${g}/${b}`;
};

test("颜色询问扫描：OSC 10/OSC 4 查询认领并摘除，设色与其他 OSC 号原样放行", () => {
  assert.deepEqual(createTerminalQueryScanner().push("\x1b]10;?\x07").probes, ["foreground"], "OSC 10 BEL 形");
  assert.deepEqual(createTerminalQueryScanner().push("\x1b]10;?\x1b\\").probes, ["foreground"], "OSC 10 ST 形");
  assert.equal(createTerminalQueryScanner().push("\x1b]10;?\x07").text, "", "询问字节不转发");

  assert.deepEqual(createTerminalQueryScanner().push("\x1b]4;7;?\x07").probes, [{ palette: 7 }], "OSC 4 带索引");
  assert.deepEqual(createTerminalQueryScanner().push("\x1b]4;12;?\x1b\\").probes, [{ palette: 12 }], "OSC 4 ST 形");
  assert.equal(createTerminalQueryScanner().push("\x1b]4;7;?\x07").text, "", "询问字节不转发");

  // 跨块：OSC 号、索引、终止符各拆一段都悬而不认领，拼齐即认领一次
  const split = createTerminalQueryScanner();
  const head = split.push("x\x1b]4;1");
  assert.deepEqual(head.probes, [], "前半段悬而不认领");
  assert.equal(head.text, "x", "可见字节照常转发");
  const joined = split.push("2;?\x07");
  assert.deepEqual(joined.probes, [{ palette: 12 }], "拼齐认领一次");
  assert.equal(joined.text, "", "询问字节不转发");

  const splitFg = createTerminalQueryScanner();
  assert.deepEqual(splitFg.push("\x1b]1").probes, [], "OSC 号没拼齐先悬着");
  assert.deepEqual(splitFg.push("0;?\x07").probes, ["foreground"], "拼齐认领");

  // OSC 4 设色（agent 改调色板）不是询问：字节必须原样交给渲染器应用
  const set = createTerminalQueryScanner();
  const passed = set.push("\x1b]4;1;#ff5500\x07");
  assert.deepEqual(passed.probes, [], "设色不认领");
  assert.equal(passed.text, "\x1b]4;1;#ff5500\x07", "设色字节必须转发");

  // 其他 OSC 号（8 超链接、12 光标色）照旧放行
  const other = createTerminalQueryScanner();
  const untouched = other.push("\x1b]8;;http://x\x07link\x1b]8;;\x07\x1b]12;?\x07");
  assert.deepEqual(untouched.probes, [], "非颜色询问零认领");
  assert.equal(untouched.text, "\x1b]8;;http://x\x07link\x1b]8;;\x07\x1b]12;?\x07", "非颜色 OSC 原样放行");

  // 老回放里的 OSC 10/4 询问同样要摘掉：宿主换代重挂渲染器时不得让它再答一遍
  // （设色字节是内容，保留）
  assert.equal(
    stripTerminalReplyProbes("a\x1b]10;?\x07b\x1b]4;3;?\x1b\\c\x1b]4;3;#00ff00\x07"),
    "abc\x1b]4;3;#00ff00\x07",
    "回放剥离问询、保留设色",
  );
});

test("完整颜色契约：Pi 形整串（OSC10+OSC11+16×OSC4+DA1）逐条按序应答，DA1 收尾且零转发", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-color-full-`);
  const spawned = [];
  const host = createTerminalHost({
    root, port: 0,
    ptyModule: { spawn: () => { const pty = new FakePty(); spawned.push(pty); return pty; } },
    logger: { warn() {} },
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    // 面板先上报真值：亮色 + 前景 + 全 16 色调色板
    const palette = ["#1f2937", "#dc2626", "#16a34a", "#b45309", "#2563eb", "#9333ea", "#0e7490", "#d1d5db",
      "#6b7280", "#ef4444", "#22c55e", "#d97706", "#3b82f6", "#a855f7", "#0891b2", "#111827"];
    const reported = await fetch(url("/terminal/theme"), {
      method: "POST", headers: headers(host),
      body: JSON.stringify({ dark: false, background: "#f8fafc", foreground: "#1e293b", palette }),
    });
    assert.equal(reported.status, 200, "前景+调色板随亮暗一起入档");

    const created = await (await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host), body: JSON.stringify({ label: "pi 形", cwd: root, shell: "powershell" }),
    })).json();
    const pty = spawned[0];
    pty.dataListener("\x1b]10;?\x07\x1b]11;?\x07" + palette.map((_, i) => `\x1b]4;${i};?\x07`).join("") + "\x1b[c");
    assert.deepEqual(pty.writeLog, [
      `\x1b]10;${colorHex("#1e293b")}\x07`,
      `\x1b]11;${colorHex("#f8fafc")}\x07`,
      ...palette.map((hex, i) => `\x1b]4;${i};${colorHex(hex)}\x07`),
      "\x1b[?1;2c",
    ], "逐条按序应答，DA1 收尾");
    const replayed = host.sessions.get(created.id).buffer.join("");
    assert.ok(!replayed.includes("\x1b]10;?") && !replayed.includes("\x1b]11;?")
      && !replayed.includes("\x1b]4;0;?") && !replayed.includes("\x1b]4;15;?") && !replayed.includes("\x1b[c"),
      "询问字节零转发——渲染器不可能再答出第二份");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("颜色兜底与扩展色：未上报按模式兜底，16-255 按确定性表答，设色照常转发", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-color-fallback-`);
  const spawned = [];
  const host = createTerminalHost({
    root, port: 0,
    ptyModule: { spawn: () => { const pty = new FakePty(); spawned.push(pty); return pty; } },
    logger: { warn() {} },
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await (await fetch(url("/terminal/sessions"), {
      method: "POST", headers: headers(host), body: JSON.stringify({ label: "兜底", cwd: root, shell: "powershell" }),
    })).json();
    const pty = spawned[0];
    const last = () => pty.writeLog[pty.writeLog.length - 1];
    // 未上报过：暗色默认——前景取面板暗态兜底，调色板取 xterm 内核默认
    pty.dataListener("\x1b]10;?\x07");
    assert.equal(last(), `\x1b]10;${colorHex("#d5e2f4")}\x07`, "前景按暗色兜底");
    pty.dataListener("\x1b]4;0;?\x07");
    assert.equal(last(), `\x1b]4;0;${colorHex("#2e3436")}\x07`, "调色板按暗色兜底");
    pty.dataListener("\x1b]4;15;?\x07");
    assert.equal(last(), `\x1b]4;15;${colorHex("#eeeeec")}\x07`, "亮白兜底");
    // 扩展位按 xterm 确定性表：196＝纯红、232/255＝灰阶两端
    pty.dataListener("\x1b]4;196;?\x07");
    assert.equal(last(), `\x1b]4;196;${colorHex("#ff0000")}\x07`, "216 立方");
    pty.dataListener("\x1b]4;232;?\x07");
    assert.equal(last(), `\x1b]4;232;${colorHex("#080808")}\x07`, "灰阶起点");
    pty.dataListener("\x1b]4;255;?\x07");
    assert.equal(last(), `\x1b]4;255;${colorHex("#eeeeee")}\x07`, "灰阶终点");
    // 设色不是询问：字节进转发流交给渲染器
    pty.dataListener("\x1b]4;1;#ff5500\x07");
    assert.ok(host.sessions.get(created.id).buffer.join("").includes("\x1b]4;1;#ff5500\x07"), "设色字节必须转发");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("主题上报扩展：foreground/palette 非法值 400，入档值跨宿主重启后第一问即答", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-color-restore-`);
  const spawned = [];
  const boot = () => createTerminalHost({
    root, port: 0,
    ptyModule: { spawn: () => { const pty = new FakePty(); spawned.push(pty); return pty; } },
    logger: { warn() {} },
  });
  const setTheme = async (host, port, body) => (await fetch(`http://127.0.0.1:${port}/terminal/theme`, {
    method: "POST", headers: headers(host), body: JSON.stringify(body),
  })).status;
  let host = boot();
  let port = await listen(host);
  try {
    assert.equal(await setTheme(host, port, { dark: false, foreground: "teal" }), 400, "非法前景色拒收");
    assert.equal(await setTheme(host, port, { dark: false, palette: ["#12345"] }), 400, "非六位十六进制拒收");
    assert.equal(await setTheme(host, port, { dark: false, palette: "nope" }), 400, "调色板必须是数组");
    assert.equal(await setTheme(host, port, {
      dark: false, background: "#f8fafc", foreground: "#1e293b",
      palette: ["#1f2937", "#dc2626", "#16a34a", "#b45309", "#2563eb", "#9333ea", "#0e7490", "#d1d5db",
        "#6b7280", "#ef4444", "#22c55e", "#d97706", "#3b82f6", "#a855f7", "#0891b2", "#111827"],
    }), 200, "全字段落档");
    await host.close();

    // 新一代宿主：面板还没补报，agent 的第一问就要拿到上一代记下的真值
    host = boot();
    port = await listen(host);
    const created = await (await fetch(`http://127.0.0.1:${port}/terminal/sessions`, {
      method: "POST", headers: headers(host), body: JSON.stringify({ label: "重启后", cwd: root, shell: "powershell" }),
    })).json();
    const pty = spawned[spawned.length - 1];
    pty.dataListener("\x1b]10;?\x07");
    assert.equal(pty.writeLog[0], `\x1b]10;${colorHex("#1e293b")}\x07`, "重启后前景不回落兜底");
    pty.dataListener("\x1b]4;6;?\x07");
    assert.equal(pty.writeLog[1], `\x1b]4;6;${colorHex("#0e7490")}\x07`, "重启后调色板不回落兜底");
    pty.dataListener("\x1b]11;?\x07");
    assert.equal(pty.writeLog[2], `\x1b]11;${colorHex("#f8fafc")}\x07`, "重启后底色不回落兜底");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 镜像解析切片：一次大块输出不得把事件循环按整块时长卡住 ----
// 这个进程的事件循环同时承载所有会话的 PTY 回调、SSE 投递与输入 POST。一次 resume
// 会来六七个 60KB 的块，整块同步解析要 40–110ms，期间别的页签收不到帧。切片后
// emit 的同步部分只占一个预算，剩下的用 setImmediate 续排。
test("大块输出经 emit 的同步耗时受限，续排后镜像仍完整", async () => {
  const root = mkdtempSync(`${tmpdir()}\anyswitch-terminal-slice-`);
  let pty = null;
  const host = createTerminalHost({
    root,
    port: 0,
    ptyModule: { spawn: () => (pty = new FakePty()) },
    logger: { warn() {} },
  });
  const port = await listen(host);
  try {
    const created = await fetch(`http://127.0.0.1:${port}/terminal/sessions`, {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({ label: "切片", cwd: root, shell: "powershell" }),
    }).then((response) => response.json());
    const session = host.sessions.get(created.id);

    // 换行密集是镜像最坏的形态：每个字符都触发一次滚动与历史行序列化。
    const heavy = "\n".repeat(64 * 1024);
    const started = performance.now();
    pty.dataListener(heavy);
    const syncElapsed = performance.now() - started;
    // 旧实现整块同步解析这一块要数百毫秒；切片后同步部分只剩一个预算。
    assert.ok(syncElapsed < 60, `emit 的同步部分 ${syncElapsed.toFixed(1)}ms 必须落在预算量级内`);

    // 续排走 setImmediate：让出事件循环直到镜像排空。
    for (let i = 0; i < 500 && session.mirrorDrainScheduled; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(session.screen.info().pendingChars, 0, "续排结束后不得残留待解析字节");
    assert.ok(session.screen.info().historyLines > 0, "续排后历史必须已经生成");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("排空中途 attach：回放包含全部已喂字节，且与整块解析结果一致", async () => {
  const root = mkdtempSync(`${tmpdir()}\anyswitch-terminal-slice2-`);
  let pty = null;
  const host = createTerminalHost({
    root,
    port: 0,
    ptyModule: { spawn: () => (pty = new FakePty()) },
    logger: { warn() {} },
  });
  const port = await listen(host);
  const controller = new AbortController();
  try {
    const created = await fetch(`http://127.0.0.1:${port}/terminal/sessions`, {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({ label: "中途 attach", cwd: root, shell: "powershell" }),
    }).then((response) => response.json());
    const session = host.sessions.get(created.id);
    const payload = "line one\r\nline two\r\nline three\r\n" + "x".repeat(64 * 1024);
    pty.dataListener(payload);

    // 此刻镜像很可能还在续排：直接建流，回放必须等积压排完再生成。
    const response = await fetch(`http://127.0.0.1:${port}/terminal/sessions/${created.id}/stream`, {
      headers: { authorization: `Bearer ${host.token}` },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    // 等到一个完整的 data 帧（结尾 \n\n）再解析：回放本身有几十 KB，只等
    // "event: data" 前缀会读到半个 JSON。
    const replayStart = () => received.indexOf("event: data\ndata: ");
    while (replayStart() < 0 || received.indexOf("\n\n", replayStart()) < 0) {
      const { done, value } = await reader.read();
      assert.ok(!done, "stream ended before the replay frame");
      received += decoder.decode(value, { stream: true });
    }
    const from = replayStart() + "event: data\ndata: ".length;
    const replay = JSON.parse(received.slice(from, received.indexOf("\n\n", from)));
    assert.ok(replay.includes("line three"), "回放必须包含已喂入的完整内容");
    // 回放是逐行重绘的，连续 200 个 x 会被行边界切断；按总出现次数核对块尾内容。
    const xCount = (replay.match(/x/g) || []).length;
    assert.ok(xCount > 2000, `回放必须包含块尾的大量内容（实际 ${xCount} 个 x）`);

    // 与同一段字节整块解析的结果对照：切片不得改变画面。
    const reference = createScreenMirror({ cols: session.screen.info().cols, rows: session.screen.info().rows });
    reference.write(payload);
    assert.equal(replay, reference.toReplay(), "中途 attach 的回放必须与整块解析一致");
  } finally {
    controller.abort();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 建连不得同步排空镜像积压 ----
// 复审发现：如果 info() 顺手排空积压，那么每次建连（stream 判断要不要发回放）
// 都会把整批积压同步做掉——一次 resume 之后是几十毫秒，正是本次要消除的卡顿。
// 现在建连改成按预算分轮排空，回放帧晚几轮到达。
test("建连遇到镜像积压时不同步排空：回放分轮到达且内容完整", async () => {
  const root = mkdtempSync(`${tmpdir()}\anyswitch-terminal-attach-`);
  let pty = null;
  const host = createTerminalHost({
    root,
    port: 0,
    ptyModule: { spawn: () => (pty = new FakePty()) },
    logger: { warn() {} },
  });
  const port = await listen(host);
  const controller = new AbortController();
  try {
    const created = await fetch(`http://127.0.0.1:${port}/terminal/sessions`, {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({ label: "积压建连", cwd: root, shell: "powershell" }),
    }).then((response) => response.json());
    const session = host.sessions.get(created.id);

    // 制造一段确定存在的积压。不能靠「4ms 预算解析不完」来间接制造——机器快时
    // 十几 KB 一次就排完了，前置条件会随机不成立（本用例最初就这么 flaky）。
    // 这里先喂一小段建立镜像，再用极小预算入队，保证 pendingChars > 0。
    // 行数控制在 5000 行历史上限以内：超出的话开头标记会被历史裁剪吃掉，那属于
    // 既有的回放预算语义，不是本用例要验的东西。
    pty.dataListener("warm\r\n");
    const payload = "HEAD-MARKER\r\n" + "line\r\n".repeat(2000) + "TAIL-MARKER\r\n";
    session.screen.writeSliced(payload, 0.001);
    assert.ok(session.screen.info().pendingChars > 0, "前置条件：镜像必须还有积压");

    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/terminal/sessions/${created.id}/stream`, {
      headers: { authorization: `Bearer ${host.token}` },
      signal: controller.signal,
    });
    const attachSync = performance.now() - started;
    assert.equal(response.status, 200);
    // 建连（含 snapshot 帧）不得把积压同步解析完；门槛按「一个预算量级」给。
    assert.ok(attachSync < 40, `建连同步耗时 ${attachSync.toFixed(1)}ms 必须落在预算量级内`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const replayStart = () => received.indexOf("event: data\ndata: ");
    while (replayStart() < 0 || received.indexOf("\n\n", replayStart()) < 0) {
      const { done, value } = await reader.read();
      assert.ok(!done, "stream ended before the replay frame");
      received += decoder.decode(value, { stream: true });
    }
    const from = replayStart() + "event: data\ndata: ".length;
    const replay = JSON.parse(received.slice(from, received.indexOf("\n\n", from)));
    // 分轮排空之后回放必须仍然覆盖整段积压，且与整块解析逐字节一致。
    assert.ok(replay.includes("HEAD-MARKER"), "回放必须包含积压开头的标记");
    assert.ok(replay.includes("TAIL-MARKER"), "回放必须包含积压末尾的标记");
    assert.equal(session.screen.info().pendingChars, 0, "回放发出前积压必须排空");
    const info = session.screen.info();
    const reference = createScreenMirror({ cols: info.cols, rows: info.rows });
    // 参照实现必须喂同一串字节（含建立镜像时的 warm 行），否则画面天然不同。
    reference.write("warm\r\n");
    reference.write(payload);
    assert.equal(replay, reference.toReplay(), "分轮排空后的回放必须与整块解析一致");
  } finally {
    controller.abort();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// M7 S5：续接创建的终端把「替哪条会话续接的」记进会话记录，随列表下发——
// 面板历史会话点击先查它做去重聚焦（同 endpoint＋同会话 id 的终端已开着就聚焦，
// 不重复建）。terminal-host 存活期内有效，页面刷新不丢（随状态文件持久化）。
test("续接身份落会话记录：创建带 resume、快照与落盘都带，重启原样读回", async () => {
  const root = mkdtempSync(`${tmpdir()}\anyswitch-terminal-test-`);
  const host = createTerminalHost({
    root,
    port: 0,
    ptyModule: { spawn: () => new FakePty() },
    logger: { warn() {} },
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const created = await fetch(url("/terminal/sessions"), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({
        label: "Kimi Code", cwd: root, shell: "cmd", agentId: "kimi",
        resume: { endpoint: "kimi", id: "s-1", file: "C:\\Users\\x\\.kimi\\sessions\\s-1.jsonl" },
      }),
    }).then((response) => response.json());
    // 只记 endpoint + 会话 id 两个非密字段（file 是路径，去重不需要，不进记录）
    assert.deepEqual(created.resume, { endpoint: "kimi", id: "s-1" }, "创建响应带续接身份");

    const listed = await fetch(url("/terminal/sessions"), { headers: headers(host) }).then((response) => response.json());
    assert.deepEqual(listed.sessions[0].resume, { endpoint: "kimi", id: "s-1" }, "列表路由随会话下发");

    // 落盘：状态文件里带着（宿主重启/页面刷新后面板重拉列表还能认）
    await host.close();
    const persisted = JSON.parse(readFileSync(join(root, TERMINAL_STATE_FILE), "utf8"));
    assert.deepEqual(persisted.sessions, [created.id], "索引点名这条会话");
    assert.deepEqual(readSessionRecord(host, created.id).resume, { endpoint: "kimi", id: "s-1" }, "会话记录带续接身份");
    const restored = createTerminalHost({ root, port: 0, ptyModule: { spawn: () => new FakePty() }, logger: { warn() {} } });
    const restoredPort = await listen(restored);
    const relisted = await fetch(`http://127.0.0.1:${restoredPort}/terminal/sessions`, { headers: headers(restored) }).then((response) => response.json());
    assert.deepEqual(relisted.sessions[0].resume, { endpoint: "kimi", id: "s-1" }, "重启原样读回");
    await restored.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("无 resume 的普通创建不新增字段；坏 resume 一律 400 不建会话", async () => {
  const root = mkdtempSync(`${tmpdir()}\anyswitch-terminal-test-`);
  const host = createTerminalHost({
    root,
    port: 0,
    ptyModule: { spawn: () => new FakePty() },
    logger: { warn() {} },
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const plain = await fetch(url("/terminal/sessions"), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({ label: "新终端", cwd: root, shell: "powershell" }),
    }).then((response) => response.json());
    assert.ok(!("resume" in plain), "普通创建的响应不新增 resume 字段（M3 契约逐位不变）");

    // resume:null/undefined 按 M3 契约＝无续接（普通创建），不是非法
    for (const extra of [{ resume: null }, { resume: undefined }, {}]) {
      const none = await fetch(url("/terminal/sessions"), {
        method: "POST",
        headers: headers(host),
        body: JSON.stringify({ label: "y", cwd: root, ...extra }),
      });
      assert.equal(none.status, 201, `resume=${JSON.stringify(extra)} 按普通创建`);
    }

    for (const bad of ["kimi", 42, [], {}, { endpoint: "kimi" }, { id: "s-1" }, { endpoint: "", id: "s-1" }, { endpoint: "kimi", id: "  " }, { endpoint: "kimi", id: 7 }]) {
      const response = await fetch(url("/terminal/sessions"), {
        method: "POST",
        headers: headers(host),
        body: JSON.stringify({ label: "x", cwd: root, resume: bad }),
      });
      assert.equal(response.status, 400, `resume=${JSON.stringify(bad)} 判非法`);
      assert.equal((await response.json()).error, "invalid_resume", "回机器可判的错码");
    }
    const listed = await fetch(url("/terminal/sessions"), { headers: headers(host) }).then((response) => response.json());
    // 普通创建 1 条 + resume 缺省三形（null/undefined/不带）3 条；坏 resume 一条不进
    assert.equal(listed.sessions.length, 4, "坏 resume 一条会话都不建（只留普通创建那几条）");
    assert.ok(listed.sessions.every((session) => !("resume" in session)), "普通创建的会话记录也不带 resume 键");
    await host.close(); // 不收服务器句柄会挂住事件循环，node --test 永不退出
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
