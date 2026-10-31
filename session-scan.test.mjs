// session-scan unit tests: every adapter runs against temp-dir fixtures, never
// the real home dirs. Coverage includes: custom-title priority, caveat
// skipping, dir-name fallback,
// title truncation, journal/agent exclusion, subagents exclusion, delete root
// whitelist (refuse + accept), claude sidecar cleanup, sqlite read-only open
// failure degradation, and the scanAll/loadMessages/deleteSessions contract.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { createSessionScanner, buildTurns } from "./session-scan.mjs";
import { createSessionScanOffload } from "./session-scan-worker.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

function makeTmp() {
  return mkTestDir("anyswitch-session-scan-");
}

// Build a scanner where EVERY endpoint root is a fresh empty temp dir except
// the ones the test overrides — an unspecified adapter must scan nothing,
// never the real home dirs.
function testScanner(overrides = {}) {
  const roots = {};
  for (const id of ["claude", "kimi", "zcode", "dsh", "pi", "opencode", "qoder", "codex", "grok", "workbuddy"]) {
    roots[id] = [makeTmp()];
  }
  Object.assign(roots, overrides);
  return createSessionScanner({ roots });
}

// --- claude fixtures ---------------------------------------------------------

function claudeLine(overrides) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: "hello" },
    timestamp: "2026-09-01T10:00:00.000Z",
    cwd: "C:\\work\\myproj",
    sessionId: "sess-1",
    ...overrides,
  });
}

function writeClaudeSession(root, dirName, fileName, lines) {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, fileName);
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

function claudeScanner(root) {
  return testScanner({ claude: [root] });
}

test("claude: custom-title beats first user message", async () => {
  const root = makeTmp();
  writeClaudeSession(root, "C--work-myproj", "sess-1.jsonl", [
    claudeLine({ message: { role: "user", content: "real first question" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "answer" }, timestamp: "2026-09-01T10:01:00.000Z" }),
    JSON.stringify({ type: "custom-title", customTitle: "我的自定义标题" }),
  ]);
  const { sessions, endpointErrors } = await claudeScanner(root).scanAll();
  // sqlite adapters report their (empty) temp roots as endpoint errors — only
  // claude must be clean here.
  assert.deepEqual(endpointErrors.filter((e) => e.endpoint === "claude"), []);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "我的自定义标题");
  assert.equal(sessions[0].endpoint, "claude");
  assert.equal(sessions[0].id, "sess-1");
  assert.equal(sessions[0].project, "C:\\work\\myproj");
  assert.equal(sessions[0].resumeCommand, "claude --resume sess-1");
  assert.equal(sessions[0].createdAt, Date.parse("2026-09-01T10:00:00.000Z"));
  assert.equal(sessions[0].lastActive, Date.parse("2026-09-01T10:01:00.000Z"));
});

test("claude: caveat and slash-command lines are skipped for the title", async () => {
  const root = makeTmp();
  writeClaudeSession(root, "C--work-myproj", "sess-2.jsonl", [
    claudeLine({
      isMeta: true,
      message: { role: "user", content: "<local-command-caveat>Caveat: do not respond</local-command-caveat>" },
    }),
    claudeLine({
      message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>" },
    }),
    claudeLine({
      message: { role: "user", content: "<local-command-stdout>Set model to x</local-command-stdout>" },
    }),
    claudeLine({ message: { role: "user", content: "actual question here" } }),
  ]);
  const { sessions } = await claudeScanner(root).scanAll();
  assert.equal(sessions[0].title, "actual question here");
});

test("claude: sessions with no real user message are excluded (pure command noise)", async () => {
  const root = makeTmp();
  writeClaudeSession(root, "C--work-myproj", "sess-3.jsonl", [
    claudeLine({
      isMeta: true,
      message: { role: "user", content: "<local-command-caveat>only caveat</local-command-caveat>" },
    }),
    claudeLine({
      message: { role: "user", content: "<command-name>/exit</command-name>\n<command-message>exit</command-message>" },
    }),
    claudeLine({
      message: { role: "user", content: "<local-command-stdout>See ya!</local-command-stdout>" },
    }),
  ]);
  const { sessions } = await claudeScanner(root).scanAll();
  assert.deepEqual(sessions, []);
});

test("claude: titles are truncated to 80 chars with ellipsis", async () => {
  const root = makeTmp();
  const long = "一二三四五六七八九十".repeat(10); // 100 chars
  writeClaudeSession(root, "C--work-myproj", "sess-4.jsonl", [
    claudeLine({ message: { role: "user", content: long } }),
  ]);
  const { sessions } = await claudeScanner(root).scanAll();
  assert.equal([...sessions[0].title].length, 83); // 80 + "..."
  assert.ok(sessions[0].title.endsWith("..."));
});

test("claude: agent-*.jsonl, journal.jsonl and subagents/ are excluded", async () => {
  const root = makeTmp();
  writeClaudeSession(root, "C--work-myproj", "agent-abc123.jsonl", [claudeLine({ sessionId: "agent-x" })]);
  writeClaudeSession(root, "C--work-myproj", "journal.jsonl", [claudeLine({ sessionId: "journal-x" })]);
  const sub = join(root, "C--work-myproj", "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "nested.jsonl"), claudeLine({ sessionId: "nested-x" }) + "\n", "utf8");
  writeClaudeSession(root, "C--work-myproj", "sess-5.jsonl", [claudeLine({ sessionId: "sess-5" })]);
  const { sessions } = await claudeScanner(root).scanAll();
  assert.deepEqual(sessions.map((s) => s.id), ["sess-5"]);
});

test("claude: sessionId falls back to the file stem", async () => {
  const root = makeTmp();
  const dir = join(root, "C--work-myproj");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "11111111-2222-3333-4444-555555555555.jsonl"),
    JSON.stringify({ type: "mode", mode: "normal" }) + "\n" +
      claudeLine({ sessionId: null, message: { role: "user", content: "真实提问" } }) + "\n",
    "utf8",
  );
  const { sessions } = await claudeScanner(root).scanAll();
  assert.equal(sessions[0].id, "11111111-2222-3333-4444-555555555555");
  assert.equal(sessions[0].title, "真实提问");
});

test("claude: head/tail local read handles files larger than 16KB", async () => {
  const root = makeTmp();
  const filler = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: "x".repeat(2000) },
    timestamp: "2026-09-01T10:00:30.000Z",
  });
  const lines = [
    claudeLine({ message: { role: "user", content: "first question" } }),
    ...Array.from({ length: 20 }, () => filler),
    JSON.stringify({ type: "custom-title", customTitle: "tail title" }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: "final answer" },
      timestamp: "2026-09-01T11:00:00.000Z",
    }),
  ];
  writeClaudeSession(root, "C--work-myproj", "sess-big.jsonl", lines);
  const { sessions } = await claudeScanner(root).scanAll();
  assert.equal(sessions[0].title, "tail title");
  assert.equal(sessions[0].summary, "final answer");
  assert.equal(sessions[0].lastActive, Date.parse("2026-09-01T11:00:00.000Z"));
});

test("claude: loadMessages reclassifies all-tool_result user rows as tool", async () => {
  const root = makeTmp();
  const file = writeClaudeSession(root, "C--work-myproj", "sess-6.jsonl", [
    claudeLine({ message: { role: "user", content: "question" } }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "tool output" }] },
      timestamp: "2026-09-01T10:02:00.000Z",
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Write" }] },
      timestamp: "2026-09-01T10:03:00.000Z",
    }),
  ]);
  const messages = await claudeScanner(root).loadMessages("claude", file);
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "question"],
      ["tool", "tool output"],
      ["assistant", "[Tool: Write]"],
    ],
  );
});

// --- delete safety ------------------------------------------------------------

test("delete refuses a file outside the adapter roots", async () => {
  const root = makeTmp();
  const outside = makeTmp();
  const foreign = join(outside, "evil.jsonl");
  writeFileSync(foreign, claudeLine({}) + "\n", "utf8");
  const scanner = claudeScanner(root);
  const result = await scanner.deleteSessions([{ endpoint: "claude", file: foreign }]);
  assert.equal(result.ok.length, 0);
  assert.equal(result.fail.length, 1);
  assert.match(result.fail[0].reason, /outside endpoint roots/);
  assert.ok(existsSync(foreign), "the foreign file must survive");
});

test("delete refuses a traversal that escapes the root via ..", async () => {
  const root = makeTmp();
  const sibling = makeTmp();
  const foreign = join(sibling, "evil.jsonl");
  writeFileSync(foreign, claudeLine({}) + "\n", "utf8");
  const scanner = claudeScanner(root);
  const traversal = join(root, "..", sibling.split(/[/\\]/).pop(), "evil.jsonl");
  const result = await scanner.deleteSessions([{ endpoint: "claude", file: traversal }]);
  assert.equal(result.ok.length, 0);
  assert.match(result.fail[0].reason, /outside endpoint roots/);
  assert.ok(existsSync(foreign));
});

test("claude delete removes the session file and its same-name sidecar dir", async () => {
  const root = makeTmp();
  const file = writeClaudeSession(root, "C--work-myproj", "sess-7.jsonl", [claudeLine({})]);
  const sidecar = join(root, "C--work-myproj", "sess-7");
  mkdirSync(join(sidecar, "tool-results"), { recursive: true });
  writeFileSync(join(sidecar, "tool-results", "out.txt"), "data", "utf8");
  const result = await claudeScanner(root).deleteSessions([{ endpoint: "claude", file }]);
  assert.equal(result.ok.length, 1);
  assert.equal(result.fail.length, 0);
  assert.ok(!existsSync(file));
  assert.ok(!existsSync(sidecar));
});

test("deleteSessions reports per-item outcomes and keeps going after a failure", async () => {
  const root = makeTmp();
  const file = writeClaudeSession(root, "C--work-myproj", "sess-8.jsonl", [claudeLine({})]);
  const scanner = claudeScanner(root);
  const result = await scanner.deleteSessions([
    { endpoint: "claude", file: join(root, "does-not-exist.jsonl") },
    { endpoint: "claude", file },
    { endpoint: "nope", file },
  ]);
  assert.equal(result.ok.length, 1);
  assert.equal(result.fail.length, 2);
  // The panel surfaces this string to the user, so it must not leak a path.
  assert.match(result.fail[0].reason, /源文件已不在磁盘上/);
  assert.match(result.fail[1].reason, /unknown endpoint/);
  assert.ok(!existsSync(file));
});

// --- kimi ---------------------------------------------------------------------

test("kimi: scans session_index.jsonl and titles from wire.jsonl prompt.accepted", async () => {
  const root = makeTmp();
  const sessionDir = join(root, "sessions", "wd_x", "session_abc");
  mkdirSync(join(sessionDir, "agents", "main"), { recursive: true });
  writeFileSync(
    join(sessionDir, "agents", "main", "wire.jsonl"),
    [
      JSON.stringify({ type: "metadata", protocol_version: "1.5", created_at: 1788000000000 }),
      JSON.stringify({
        type: "prompt.accepted",
        content: [{ type: "text", text: "修复登录页样式" }],
        time: 1788000001000,
      }),
      // Real wire.jsonl shape: assistant text and tool activity are nested
      // inside context.append_loop_event, never top-level events.
      JSON.stringify({
        type: "context.append_loop_event",
        event: { type: "content.part", part: { type: "text", text: "好的，我来处理" } },
        time: 1788000002000,
      }),
      JSON.stringify({
        type: "context.append_loop_event",
        event: { type: "tool.call", name: "Bash", args: { command: "ls" } },
        time: 1788000003000,
      }),
      JSON.stringify({
        type: "context.append_loop_event",
        event: { type: "tool.result", result: { output: "file.txt", isError: false } },
        time: 1788000004000,
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  writeFileSync(
    join(root, "session_index.jsonl"),
    JSON.stringify({ sessionId: "session_abc", sessionDir, workDir: "C:\\work\\kimi-proj" }) + "\n",
    "utf8",
  );
  const scanner = testScanner({ kimi: [root] });
  const { sessions } = await scanner.scanAll();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "session_abc");
  assert.equal(sessions[0].title, "修复登录页样式");
  assert.equal(sessions[0].project, "C:\\work\\kimi-proj");
  assert.equal(sessions[0].resumeCommand, "kimi --session session_abc");
  assert.ok(typeof sessions[0].lastActive === "number");

  const messages = await scanner.loadMessages("kimi", sessionDir);
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "tool", "tool"],
  );
  assert.equal(messages[1].content, "好的，我来处理");
  assert.equal(messages[2].content, "[Tool: Bash]");
  assert.equal(messages[3].content, "file.txt");
  assert.deepEqual(
    messages.map((m) => m.ts),
    [1788000001000, 1788000002000, 1788000003000, 1788000004000],
  );

  const del = await scanner.deleteSessions([{ endpoint: "kimi", file: sessionDir }]);
  assert.equal(del.ok.length, 1);
  assert.ok(!existsSync(sessionDir));
});

test("kimi: loadMessages skips think parts and empty tool results", async () => {
  const root = makeTmp();
  const sessionDir = join(root, "sessions", "wd_x", "session_think");
  mkdirSync(join(sessionDir, "agents", "main"), { recursive: true });
  writeFileSync(
    join(sessionDir, "agents", "main", "wire.jsonl"),
    [
      JSON.stringify({
        type: "prompt.accepted",
        content: [{ type: "text", text: "查一下日志" }],
        time: 1788000001000,
      }),
      // Reasoning draft — not dialogue, must not surface as a message.
      JSON.stringify({
        type: "context.append_loop_event",
        event: { type: "content.part", part: { type: "think", think: "先看看目录结构……" } },
        time: 1788000002000,
      }),
      JSON.stringify({
        type: "context.append_loop_event",
        event: { type: "content.part", part: { type: "text", text: "我来看日志。" } },
        time: 1788000003000,
      }),
      // Empty tool output — skipped rather than rendered as a blank row.
      JSON.stringify({
        type: "context.append_loop_event",
        event: { type: "tool.result", result: { output: "   ", isError: false } },
        time: 1788000004000,
      }),
      // turn.prompt mirrors prompt.accepted — must not duplicate the user turn.
      JSON.stringify({
        type: "turn.prompt",
        input: [{ type: "text", text: "查一下日志" }],
        time: 1788000001000,
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  writeFileSync(
    join(root, "session_index.jsonl"),
    JSON.stringify({ sessionId: "session_think", sessionDir, workDir: "C:\\work\\k" }) + "\n",
    "utf8",
  );
  const messages = await testScanner({ kimi: [root] }).loadMessages("kimi", sessionDir);
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.equal(messages[0].content, "查一下日志");
  assert.equal(messages[1].content, "我来看日志。");
});

test("kimi: lastActive is the newest agents/*/wire.jsonl, ignoring tool-result noise", async () => {
  const root = makeTmp();
  const sessionDir = join(root, "sessions", "wd_x", "session_abc");
  const mainDir = join(sessionDir, "agents", "main");
  const subDir = join(sessionDir, "agents", "agent-1", "tool-results");
  mkdirSync(mainDir, { recursive: true });
  mkdirSync(subDir, { recursive: true });

  const T_MAIN = 1788000000000;
  const T_SUB = T_MAIN + 5000;
  const T_TOOL_NOISE = T_MAIN + 900000;
  const wire = (text) =>
    JSON.stringify({ type: "prompt.accepted", content: [{ type: "text", text }], time: T_MAIN }) + "\n";

  const mainWire = join(mainDir, "wire.jsonl");
  const subWire = join(subDir, "..", "wire.jsonl");
  const toolResult = join(subDir, "Read-1.txt");
  writeFileSync(mainWire, wire("主会话提问"), "utf8");
  writeFileSync(subWire, wire("子会话提问"), "utf8");
  writeFileSync(toolResult, "工具输出", "utf8");
  utimesSync(mainWire, new Date(T_MAIN), new Date(T_MAIN));
  utimesSync(subWire, new Date(T_SUB), new Date(T_SUB));
  utimesSync(toolResult, new Date(T_TOOL_NOISE), new Date(T_TOOL_NOISE));

  writeFileSync(
    join(root, "session_index.jsonl"),
    JSON.stringify({ sessionId: "session_abc", sessionDir, workDir: "C:\\work\\k" }) + "\n",
    "utf8",
  );

  const { sessions } = await testScanner({ kimi: [root] }).scanAll();
  assert.equal(sessions.length, 1);
  // Subagent transcripts count as activity; later-written tool output does not.
  assert.equal(sessions[0].lastActive, T_SUB);
});

test("kimi: index rows whose sessionDir vanished are skipped", async () => {
  const root = makeTmp();
  writeFileSync(
    join(root, "session_index.jsonl"),
    JSON.stringify({ sessionId: "gone", sessionDir: join(root, "sessions", "gone"), workDir: "C:\\x" }) + "\n",
    "utf8",
  );
  const { sessions, endpointErrors } = await testScanner({ kimi: [root] }).scanAll();
  assert.deepEqual(sessions, []);
  assert.deepEqual(endpointErrors.filter((e) => e.endpoint === "kimi"), []);
});

// --- dsh ----------------------------------------------------------------------
// DSH writes a session as a CHAIN of independently decodable zstd frames (a
// checksummed header frame plus one frame per durable write batch) whose
// records are {type,seq,time,data} events. A single-frame fixture holding
// top-level role/content lines is what let the original adapter ship broken:
// it matched neither the container nor the record shape.

function dshHeader(id, cwd, createdAt = 1788000000000) {
  return { type: "session", version: 0, id, createdAt, cwd, delegationDepth: 0 };
}

// One frame per batch, exactly like the harness container. `fileName` selects
// the format generation and the physical encoding: `session.jsonl.zstd` is
// released v0 compressed, `session.v<N>.jsonl.zstd` every later generation,
// and the same names without `.zstd` are a root configured `compression: none`.
function writeDshSession(root, dirName, id, batches, { tornTail = false, fileName = "session.jsonl.zstd" } = {}) {
  const sessionDir = join(root, dirName, id);
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, fileName);
  if (!fileName.endsWith(".zstd")) {
    writeFileSync(file, batches.flat().map((record) => JSON.stringify(record)).join("\n") + "\n");
    return { sessionDir, file };
  }
  const frames = batches.map((records) =>
    zstdCompressSync(
      Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8"),
    ),
  );
  if (tornTail) {
    // An interrupted append leaves a partial final frame behind.
    frames.push(frames.pop().subarray(0, 12));
  }
  writeFileSync(file, Buffer.concat(frames));
  return { sessionDir, file };
}

test("dsh: reads the concatenated-frame session container", async () => {
  const root = makeTmp();
  const id = "11111111-2222-3333-4444-555555555555";
  const { sessionDir, file } = writeDshSession(root, "--C-work-dshproj--", id, [
    [dshHeader(id, "C:\\work\\dshproj")],
    [
      { type: "step/start", seq: 1, time: 1788000000500, data: { turn: 1, step: 1 } },
      {
        type: "user/message",
        seq: 2,
        time: 1788000001000,
        data: { content: [{ type: "text", text: "压缩会话问题" }] },
      },
    ],
    [
      {
        type: "assistant/chunk",
        seq: 3,
        time: 1788000001500,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "回答" } },
      },
      {
        type: "text-chunks",
        seq0: 3,
        time0: 1788000001500,
        data: { turn: 1, step: 1, index: 0, dt: [0, 1], texts: ["回", "答"] },
      },
      {
        type: "assistant/message",
        seq: 5,
        time: 1788000002000,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: "assistant",
            content: [
              { type: "reasoning", text: "先想一下" },
              { type: "text", text: "回答" },
              { type: "tool-call", id: "call_1", name: "run_code", arguments: "{}" },
            ],
          },
        },
      },
      {
        type: "tool/result",
        seq: 6,
        time: 1788000003000,
        data: {
          turn: 1,
          step: 1,
          message: {
            // Real logs wrap tool output in a USER-role message — it must still
            // be displayed as a tool result, never as the user's own words.
            role: "user",
            source: { kind: "tool" },
            content: [{ type: "tool-result", content: [{ type: "text", text: "工具输出" }] }],
          },
        },
      },
    ],
  ]);

  const scanner = testScanner({ dsh: [root] });
  const { sessions } = await scanner.scanAll();
  assert.equal(sessions.length, 1, "a multi-frame container must yield its session");
  assert.equal(sessions[0].id, id);
  assert.equal(sessions[0].title, "压缩会话问题");
  assert.equal(sessions[0].project, "C:\\work\\dshproj");
  assert.equal(sessions[0].createdAt, 1788000000000);
  assert.equal(sessions[0].lastActive, 1788000003000, "last activity comes from the final frame");
  assert.equal(sessions[0].resumeCommand, `dsh --profile dsh-tui --resume ${id}`, "dsh 续接带 profile（裸 dsh 拒启动，复制条要独立可跑）");

  const messages = await scanner.loadMessages("dsh", file);
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "压缩会话问题"],
      // The reasoning draft and the chunk deltas stay out: the assembled
      // assistant/message is the single source for that turn.
      ["assistant", "回答\n[Tool: run_code]"],
      ["tool", "工具输出"],
    ],
  );

  const del = await scanner.deleteSessions([{ endpoint: "dsh", file }]);
  assert.equal(del.ok.length, 1);
  assert.ok(!existsSync(sessionDir), "the emptied <uuid> dir is removed too");
});

test("dsh: a torn trailing frame does not hide the session", async () => {
  const root = makeTmp();
  const id = "22222222-3333-4444-5555-666666666666";
  const { file } = writeDshSession(
    root,
    "--C-work-dshproj--",
    id,
    [
      [dshHeader(id, "C:\\work\\dshproj")],
      [
        {
          type: "user/message",
          seq: 1,
          time: 1788000001000,
          data: { content: [{ type: "text", text: "半帧" }] },
        },
      ],
      [
        {
          type: "assistant/message",
          seq: 2,
          time: 1788000002000,
          data: { message: { role: "assistant", content: [{ type: "text", text: "没写完" }] } },
        },
      ],
    ],
    { tornTail: true },
  );

  const scanner = testScanner({ dsh: [root] });
  const { sessions } = await scanner.scanAll();
  assert.equal(sessions.length, 1, "an interrupted append must not hide the session");
  assert.equal(sessions[0].title, "半帧");
  const messages = await scanner.loadMessages("dsh", file);
  assert.deepEqual(
    messages.map((m) => m.content),
    ["半帧"],
    "only the complete frames are readable",
  );
});

test("dsh: header-only shell sessions are excluded from the list", async () => {
  const root = makeTmp();
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  writeDshSession(root, "--C-work-dshproj--", id, [[dshHeader(id, "C:\\work\\dshproj")]]);

  const { sessions } = await testScanner({ dsh: [root] }).scanAll();
  assert.deepEqual(sessions, []);
});

test("dsh: a session written in a later format generation is listed", async () => {
  // 0.2 writes `session.v4.jsonl.zstd`; the adapter's fixed `session.jsonl.zstd`
  // matched none of them, so every session since the upgrade was invisible.
  const root = makeTmp();
  const id = "33333333-4444-5555-6666-777777777777";
  const { file } = writeDshSession(
    root,
    "--C-work-dshproj--",
    id,
    [
      [dshHeader(id, "C:\\work\\dshproj")],
      [
        {
          type: "user/message",
          seq: 1,
          time: 1788000001000,
          data: { content: [{ type: "text", text: "升级后的会话" }] },
        },
      ],
    ],
    { fileName: "session.v4.jsonl.zstd" },
  );

  const scanner = testScanner({ dsh: [root] });
  const { sessions } = await scanner.scanAll();
  assert.equal(sessions.length, 1, "v4 代际的会话必须在列表里");
  assert.equal(sessions[0].id, id);
  assert.equal(sessions[0].title, "升级后的会话");
  assert.equal(sessions[0].file, file);
  const messages = await scanner.loadMessages("dsh", file);
  assert.deepEqual(messages.map((m) => m.content), ["升级后的会话"]);
});

test("dsh: a directory holding two generations lists once, from the newest", async () => {
  // A session continued across the upgrade keeps its old file next to the new
  // one; the harness reads the numerically highest generation, so listing the
  // older one (or both) would show a stale transcript twice.
  const root = makeTmp();
  const id = "55555555-6666-7777-8888-999999999999";
  writeDshSession(root, "--C-work-dshproj--", id, [
    [dshHeader(id, "C:\\work\\dshproj")],
    [
      {
        type: "user/message",
        seq: 1,
        time: 1788000001000,
        data: { content: [{ type: "text", text: "升级前" }] },
      },
    ],
  ], { fileName: "session.v3.jsonl.zstd" });
  const { sessionDir, file } = writeDshSession(root, "--C-work-dshproj--", id, [
    [dshHeader(id, "C:\\work\\dshproj")],
    [
      {
        type: "user/message",
        seq: 1,
        time: 1788000001000,
        data: { content: [{ type: "text", text: "升级前" }] },
      },
      {
        type: "assistant/message",
        seq: 2,
        time: 1788000002000,
        data: { message: { role: "assistant", content: [{ type: "text", text: "升级后" }] } },
      },
    ],
  ], { fileName: "session.v4.jsonl.zstd" });

  const scanner = testScanner({ dsh: [root] });
  const { sessions } = await scanner.scanAll();
  assert.equal(sessions.length, 1, "两代同目录只出一行");
  assert.equal(sessions[0].file, file, "读的是最高代际");
  const messages = await scanner.loadMessages("dsh", file);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);

  // Deleting the session has to take the older generation with it: leaving it
  // behind would put the session back on the list under v3.
  const del = await scanner.deleteSessions([{ endpoint: "dsh", file }]);
  assert.equal(del.ok.length, 1);
  assert.ok(!existsSync(sessionDir), "整目录删除，不留下旧代际");
});

test("dsh: an uncompressed root is read as well", async () => {
  // `compression: 'none'` writes the same generation names without `.zstd`.
  const root = makeTmp();
  const id = "66666666-7777-8888-9999-aaaaaaaaaaaa";
  const { file } = writeDshSession(
    root,
    "--C-work-dshproj--",
    id,
    [
      [dshHeader(id, "C:\\work\\dshproj")],
      [
        {
          type: "user/message",
          seq: 1,
          time: 1788000001000,
          data: { content: [{ type: "text", text: "未压缩" }] },
        },
      ],
    ],
    { fileName: "session.v4.jsonl" },
  );

  const scanner = testScanner({ dsh: [root] });
  const { sessions } = await scanner.scanAll();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "未压缩");
  const messages = await scanner.loadMessages("dsh", file);
  assert.deepEqual(messages.map((m) => m.content), ["未压缩"]);
});

test("dsh: a non-canonical name is not a session log", async () => {
  // The harness refuses `.v0`, leading zeros and uppercase; a directory holding
  // only such a name has no session (and must not be read as one).
  const root = makeTmp();
  const id = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
  const sessionDir = join(root, "--C-work-dshproj--", id);
  mkdirSync(sessionDir, { recursive: true });
  for (const name of ["session.v0.jsonl.zstd", "session.v04.jsonl.zstd", "SESSION.jsonl.zstd", "session.v4.jsonl.zstd.tmp"]) {
    writeFileSync(join(sessionDir, name), Buffer.from([]));
  }

  const { sessions } = await testScanner({ dsh: [root] }).scanAll();
  assert.deepEqual(sessions, []);
});

// --- pi -----------------------------------------------------------------------

test("pi: parses the session header line and message entries", async () => {
  const root = makeTmp();
  const dir = join(root, "--C--work-piproj--");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-09-01T10-00-00-000Z_019fb399-0000-7d24-a26b-39732b7ce85b.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "019fb399-0000-7d24-a26b-39732b7ce85b",
        timestamp: "2026-09-01T10:00:00.000Z",
        cwd: "C:\\work\\piproj",
      }),
      JSON.stringify({ type: "model_change", id: "11d8f309", timestamp: "2026-09-01T10:00:01.000Z" }),
      JSON.stringify({
        type: "message",
        id: "6dfd7014",
        timestamp: "2026-09-01T10:00:02.000Z",
        message: { role: "user", content: [{ type: "text", text: "pi 用户问题" }], timestamp: 1788000002000 },
      }),
      JSON.stringify({
        type: "message",
        id: "2223b648",
        timestamp: "2026-09-01T10:00:05.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "pi 回答" }], timestamp: 1788000005000 },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  const scanner = testScanner({ pi: [root] });
  const { sessions } = await scanner.scanAll();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "019fb399-0000-7d24-a26b-39732b7ce85b");
  assert.equal(sessions[0].title, "pi 用户问题");
  assert.equal(sessions[0].summary, "pi 回答");
  assert.equal(sessions[0].project, "C:\\work\\piproj");
  assert.equal(sessions[0].lastActive, 1788000005000, "inner message timestamp wins");
  assert.equal(sessions[0].resumeCommand, `pi --session ${file}`);

  const messages = await scanner.loadMessages("pi", file);
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "pi 用户问题"],
      ["assistant", "pi 回答"],
    ],
  );
});

// kimi 桌面端/swarm 驱动的会话只写 context.append_message，没有 prompt.accepted
// （本机 200 个会话目录里 27 个是这种），而交互输入的同一文本会先出现在
// prompt.accepted、再以 append 回声出现（实测同文本配对 313:19 次都是这个方向）。
// 只读 prompt.accepted 会让前者的目录整条空白，回声无脑收则会让后者翻倍。
test("kimi: user turns come from context.append_message without doubling prompts", async () => {
  const root = makeTmp();
  const sessionDir = join(root, "sessions", "wd_desk", "session_desk");
  mkdirSync(join(sessionDir, "agents", "main"), { recursive: true });
  writeFileSync(
    join(sessionDir, "agents", "main", "wire.jsonl"),
    [
      JSON.stringify({ type: "prompt.accepted", content: [{ type: "text", text: "继续" }], time: 1788000001000 }),
      JSON.stringify({ type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "继续" }] }, time: 1788000001500 }),
      JSON.stringify({ type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "把右栏修好" }] }, time: 1788000002000 }),
      // 人连着打了两次「继续」：第二条仍是独立一轮，不能被去重吃掉
      JSON.stringify({ type: "prompt.accepted", content: [{ type: "text", text: "继续" }], time: 1788000003000 }),
      JSON.stringify({ type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "继续" }] }, time: 1788000003500 }),
      // 助手侧的 append 不参与：正文由 loop event 承担，收了会重复
      JSON.stringify({ type: "context.append_message", message: { role: "assistant", content: [{ type: "text", text: "收到" }] }, time: 1788000004000 }),
    ].join("\n") + "\n",
    "utf8",
  );
  const messages = await testScanner({ kimi: [root] }).loadMessages("kimi", sessionDir);
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "继续"],
      ["user", "把右栏修好"],
      ["user", "继续"],
    ],
  );
});

// --- qoder --------------------------------------------------------------------

function writeQoderSession(root, projectDir, fileName, lines) {
  const dir = join(root, projectDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), lines.join("\n") + "\n", "utf8");
}

test("qoder: scans projects/ transcripts and loads messages", async () => {
  const root = makeTmp();
  writeQoderSession(root, "C--work-qoderproj", "00548ece-46f7-4bc8-8e63-d216659bd48e.jsonl", [
    JSON.stringify({ type: "workspace-directories", sessionId: "00548ece-46f7-4bc8-8e63-d216659bd48e", directories: ["C:\\work\\qoderproj"] }),
    JSON.stringify({ type: "runtime-config", sessionId: "00548ece-46f7-4bc8-8e63-d216659bd48e", model: "auto", timestamp: 1788000000000 }),
    JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-01T01:13:50.000Z", message: { role: "user", content: [{ type: "text", text: "qoder 真实提问" }] } }),
    JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-09-01T01:13:55.000Z", message: { role: "assistant", content: [{ type: "text", text: "qoder 回答" }] } }),
  ]);
  const scanner = testScanner({ qoder: [root] });
  const { sessions } = await scanner.scanAll();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "00548ece-46f7-4bc8-8e63-d216659bd48e");
  assert.equal(sessions[0].title, "qoder 真实提问");
  assert.equal(sessions[0].project, "C:\\work\\qoderproj");
  assert.equal(sessions[0].resumeCommand, "qodercli --resume 00548ece-46f7-4bc8-8e63-d216659bd48e");

  const messages = await scanner.loadMessages("qoder", sessions[0].file);
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "qoder 真实提问"],
      ["assistant", "qoder 回答"],
    ],
  );

  const del = await scanner.deleteSessions([{ endpoint: "qoder", file: sessions[0].file }]);
  assert.equal(del.ok.length, 1);
  assert.ok(!existsSync(sessions[0].file));
});

test("qoder: transcripts without any user turn are excluded", async () => {
  const root = makeTmp();
  writeQoderSession(root, "C--work-qoderproj", "deadc0de-0000-1111-2222-333344445555.jsonl", [
    JSON.stringify({ type: "workspace-directories", sessionId: "deadc0de", directories: ["C:\\work\\qoderproj"] }),
    JSON.stringify({ type: "runtime-config", sessionId: "deadc0de", model: "auto", timestamp: 1788000000000 }),
  ]);
  const { sessions } = await testScanner({ qoder: [root] }).scanAll();
  assert.deepEqual(sessions, []);
});

// Qoder 与 claude 同形：工具结果以 user 角色回写。缺了 claude 那条重标规则时，
// 本机一条会话把 1231 条 user 记录里的 1216 条工具输出当成了用户轮。
test("qoder: tool results wrapped in user records are not human turns", async () => {
  const root = makeTmp();
  const sessionId = "aaaa1111-0000-0000-0000-000000000001";
  writeQoderSession(root, "C--work-qoderproj", `${sessionId}.jsonl`, [
    JSON.stringify({ type: "workspace-directories", sessionId, directories: ["C:\\work\\qoderproj"] }),
    JSON.stringify({ type: "runtime-config", sessionId, model: "auto", timestamp: 1788000000000 }),
    JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-01T01:13:50.000Z", message: { role: "user", content: [{ type: "text", text: "把右栏修好" }] } }),
    JSON.stringify({ type: "user", uuid: "u2", timestamp: "2026-09-01T01:13:51.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Successfully modified file: panel.css" }] } }),
    JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-09-01T01:13:55.000Z", message: { role: "assistant", content: [{ type: "text", text: "改好了" }] } }),
    // 混合块（人打的字 + 附带的工具结果）仍是人的一轮，不能被重标吞掉
    JSON.stringify({ type: "user", uuid: "u3", timestamp: "2026-09-01T01:13:56.000Z", message: { role: "user", content: [{ type: "text", text: "继续" }, { type: "tool_result", tool_use_id: "t2", content: "ok" }] } }),
  ]);
  const messages = await testScanner({ qoder: [root] }).loadMessages("qoder", join(root, "C--work-qoderproj", `${sessionId}.jsonl`));
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "tool", "assistant", "user"],
  );
  assert.deepEqual(buildTurns(messages).map((t) => t.index), [0, 3]);
});

// --- turn/目录 rules (shared by every adapter) --------------------------------

test("buildTurns: 目录只列人打的字，注入的 user 文本不算轮", () => {
  const long = "这".repeat(60);
  const messages = [
    { role: "user", content: "# AGENTS.md instructions <INSTRUCTIONS>读代码</INSTRUCTIONS>", ts: 1 },
    { role: "user", content: "把 TOC 修好", ts: 2 },
    { role: "tool", content: "Successfully modified file: panel.css", ts: 3 },
    { role: "user", content: "<command-name>/effort</command-name>\n<command-args>max</command-args>", ts: 4 },
    { role: "assistant", content: "好", ts: 5 },
    { role: "user", content: "<system-reminder>\nThe TodoWrite tool has not been used\n</system-reminder>", ts: 6 },
    { role: "user", content: "The TodoWrite tool hasn't been used recently; consider cleaning up", ts: 7 },
    { role: "user", content: "Called the Read tool with the following input: {\"path\":\"x\"}", ts: 8 },
    { role: "user", content: "   ", ts: 9 },
    { role: "user", content: "这条里带了 <system-reminder> 字样但确实是人在说话", ts: 10 },
    { role: "user", content: "[Request interrupted by user]", ts: 11 },
    { role: "user", content: "This session is being continued from a previous conversation that ran out of context", ts: 12 },
    { role: "user", content: "<task-notification>swarm agent-3 finished</task-notification>", ts: 13 },
    { role: "user", content: long, ts: 14 },
  ];
  const turns = buildTurns(messages);
  // 命中的三条按 messages 下标回指，长文本压成单行并截到预览宽度
  assert.deepEqual(turns.map((t) => t.index), [1, 9, 13]);
  assert.deepEqual(
    turns.map((t) => [t.preview, t.ts]),
    [["把 TOC 修好", 2], ["这条里带了 <system-reminder> 字样但确实是人在说话", 10], [`${"这".repeat(40)}...`, 14]],
  );
});

// 对话目录与标题共用同一份注入块判据（isInjectedUserBlock）：workbuddy 会把
// `<system-reminder data-role="user-context">` / `<teammate-message ...>` /
// `<user-context ...>` 三种整块上下文写成 user 消息。前缀表只列了 system-reminder
// 家族时，另两种会原样变成目录行——这里锁定三条都不进目录，只留人打的那条。
test("buildTurns: 三种注入块都不进目录，只留人打的那条（workbuddy 转录）", async () => {
  const root = makeTmp();
  const id = "sess-wb-injected-blocks";
  const file = writeWorkbuddySession(root, WORKBUDDY_PROJECT_DIR, id, [
    { type: "session-meta", sessionId: id, cwd: WORKBUDDY_CWD, timestamp: 1788000000000 },
    workbuddyMessageEvent("user", '<system-reminder data-role="user-context">\n当前工作目录：C:\\Users\\me\\proj\n</system-reminder>', 1788000000500),
    workbuddyMessageEvent("user", '<teammate-message from="researcher">\n调研已完成\n</teammate-message>', 1788000000800),
    workbuddyMessageEvent("user", "<user-context>\n- OS: Windows 11\n</user-context>", 1788000000900),
    workbuddyMessageEvent("user", "把目录行修好", 1788000001000),
    workbuddyMessageEvent("assistant", "好", 1788000002000),
  ]);

  const messages = await testScanner({ workbuddy: [root] }).loadMessages("workbuddy", file);
  assert.equal(messages.length, 5, "注入块仍是 transcript 的一部分，只在目录里被过滤");
  assert.deepEqual(
    buildTurns(messages).map((turn) => [turn.index, turn.preview]),
    [[3, "把目录行修好"]],
  );
});

// --- codex ------------------------------------------------------------------

function codexLine(type, payload, timestamp = "2026-09-01T10:00:00.000Z") {
  return JSON.stringify({ timestamp, type, payload });
}

// root is the sessions dir (<home>/sessions); the thread-name index lives one
// level up (<home>/session_index.jsonl), same as ~/.codex in production.
function writeCodexSession(root, dateDir, fileName, lines) {
  const dir = join(root, dateDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, fileName);
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

test("codex: scans rollout envelopes, titles from session_index, loads messages", async () => {
  const home = makeTmp();
  const root = join(home, "sessions");
  const id = "019fb399-0000-7d24-a26b-39732b7ce85b";
  const file = writeCodexSession(root, join("2026", "09", "01"), `rollout-2026-09-01T10-00-00-${id}.jsonl`, [
    codexLine("session_meta", { id, timestamp: "2026-09-01T10:00:00.000Z", cwd: "C:\\work\\codexproj", originator: "codex_cli" }),
    codexLine("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "base instructions" }] }, "2026-09-01T10:00:01.000Z"),
    codexLine("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>C:\\work\\codexproj</cwd>\n</environment_context>" }] }, "2026-09-01T10:00:02.000Z"),
    codexLine("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "codex 用户问题" }] }, "2026-09-01T10:00:03.000Z"),
    codexLine("response_item", { type: "function_call", name: "shell", arguments: "{\"command\":\"ls\"}" }, "2026-09-01T10:00:04.000Z"),
    codexLine("response_item", { type: "function_call_output", call_id: "c1", output: "文件清单" }, "2026-09-01T10:00:05.000Z"),
    codexLine("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "codex 回答" }] }, "2026-09-01T10:00:06.000Z"),
    // world_state / turn_context envelopes must be tolerated, never fatal.
    codexLine("world_state", { full: true, state: {} }, "2026-09-01T10:00:07.000Z"),
    codexLine("turn_context", { turn_id: "t1", cwd: "C:\\work\\codexproj" }, "2026-09-01T10:00:08.000Z"),
  ]);
  writeFileSync(join(home, "session_index.jsonl"), JSON.stringify({ id, thread_name: "桌面线程名", updated_at: "2026-09-01T10:00:08.000Z" }) + "\n", "utf8");
  const scanner = testScanner({ codex: [root] });
  const { sessions } = await scanner.scanAll();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].endpoint, "codex");
  assert.equal(sessions[0].id, id);
  assert.equal(sessions[0].title, "桌面线程名");
  assert.equal(sessions[0].summary, "codex 回答");
  assert.equal(sessions[0].project, "C:\\work\\codexproj");
  assert.equal(sessions[0].originator, "codex_cli", "session_meta 的客户端面标记随 meta 带出（终端 join 分面用）");
  assert.equal(sessions[0].createdAt, Date.parse("2026-09-01T10:00:00.000Z"));
  assert.equal(sessions[0].lastActive, Date.parse("2026-09-01T10:00:08.000Z"));
  assert.equal(sessions[0].resumeCommand, `codex resume ${id}`);

  const messages = await scanner.loadMessages("codex", file);
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "codex 用户问题"],
      ["assistant", "[Tool: shell]"],
      ["tool", "文件清单"],
      ["assistant", "codex 回答"],
    ],
  );

  const del = await scanner.deleteSessions([{ endpoint: "codex", file }]);
  assert.equal(del.ok.length, 1);
  assert.ok(!existsSync(file));
});

test("codex: without session_index the title is the first user-typed text", async () => {
  const home = makeTmp();
  const root = join(home, "sessions");
  writeCodexSession(root, join("2026", "09", "02"), "rollout-2026-09-02T09-00-00-019fb399-1111-7d24-a26b-39732b7ce85b.jsonl", [
    codexLine("session_meta", { id: "019fb399-1111-7d24-a26b-39732b7ce85b", timestamp: "2026-09-02T09:00:00.000Z", cwd: "C:\\work\\codexproj" }),
    // The injected context dump must not become the title…
    codexLine("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…</environment_context>" }] }, "2026-09-02T09:00:01.000Z"),
    // …the event_msg mirror carries what the user actually typed.
    codexLine("event_msg", { type: "user_message", message: "event 里的真实提问" }, "2026-09-02T09:00:02.000Z"),
  ]);
  const { sessions } = await testScanner({ codex: [root] }).scanAll();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "event 里的真实提问");
});

test("codex: envelopes with no user turn, thread name, or cwd are excluded", async () => {
  const home = makeTmp();
  const root = join(home, "sessions");
  // Nothing to title by: no user-typed turn, no session_index thread name,
  // and no cwd on the session_meta — the one combination that still means
  // "not a conversation worth listing".
  writeCodexSession(root, join("2026", "09", "03"), "rollout-2026-09-03T08-00-00-deadc0de-0000-1111-2222-333344445555.jsonl", [
    codexLine("session_meta", { id: "deadc0de-0000-1111-2222-333344445555", timestamp: "2026-09-03T08:00:00.000Z" }),
    codexLine("turn_context", { turn_id: "t1" }),
    codexLine("world_state", { full: false, state: {} }),
  ]);
  const { sessions } = await testScanner({ codex: [root] }).scanAll();
  assert.deepEqual(sessions, []);
});

test("codex: the '# AGENTS.md instructions' synthetic envelope never titles a session", async () => {
  const home = makeTmp();
  const root = join(home, "sessions");
  const id = "01a09627-ee1d-77a3-9f4e-5ef68e2a65a6";
  // Mirrors the observed production rollout shape: session_meta, developer
  // preludes, then a user-role synthetic envelope (starts with
  // "# AGENTS.md instructions", embeds <environment_context><cwd>), then
  // world_state / turn_context, and only THEN the first real user message.
  writeCodexSession(root, join("2026", "09", "12"), `rollout-2026-09-12T23-06-34-${id}.jsonl`, [
    codexLine("session_meta", { id, timestamp: "2026-09-12T23:06:34.000Z", cwd: "C:\\work\\codexproj" }),
    codexLine("event_msg", { type: "task_started" }, "2026-09-12T23:06:34.100Z"),
    codexLine("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "base instructions" }] }, "2026-09-12T23:06:34.200Z"),
    codexLine("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>\n…\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>C:\\work\\codexproj</cwd>\n</environment_context>" }] }, "2026-09-12T23:06:34.300Z"),
    codexLine("world_state", { full: true, state: {} }, "2026-09-12T23:06:34.400Z"),
    codexLine("turn_context", { turn_id: "t1", cwd: "C:\\work\\codexproj" }, "2026-09-12T23:06:34.500Z"),
    codexLine("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Reply with exactly: sess-ok" }] }, "2026-09-12T23:06:35.000Z"),
  ]);
  const { sessions } = await testScanner({ codex: [root] }).scanAll();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "Reply with exactly: sess-ok", "the first real user message titles, not the injected envelope");
});

test("codex: without any real user message the title falls back to the cwd basename", async () => {
  const home = makeTmp();
  const root = join(home, "sessions");
  const id = "01a09627-0000-77a3-9f4e-5ef68e2a65a6";
  writeCodexSession(root, join("2026", "09", "13"), `rollout-2026-09-13T08-00-00-${id}.jsonl`, [
    codexLine("session_meta", { id, timestamp: "2026-09-13T08:00:00.000Z", cwd: "C:\\work\\codexproj" }),
    codexLine("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>\n…\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>C:\\work\\codexproj</cwd>\n</environment_context>" }] }, "2026-09-13T08:00:01.000Z"),
  ]);
  const { sessions } = await testScanner({ codex: [root] }).scanAll();
  assert.equal(sessions.length, 1, "an envelope-only session still lists");
  assert.equal(sessions[0].title, "codexproj", "cwd basename is the title of last resort");
  assert.equal(sessions[0].project, "C:\\work\\codexproj");
});

test("codex: a thread name still beats the envelope and the first real user message", async () => {
  const home = makeTmp();
  const root = join(home, "sessions");
  const id = "01a09627-1111-77a3-9f4e-5ef68e2a65a6";
  writeCodexSession(root, join("2026", "09", "14"), `rollout-2026-09-14T08-00-00-${id}.jsonl`, [
    codexLine("session_meta", { id, timestamp: "2026-09-14T08:00:00.000Z", cwd: "C:\\work\\codexproj" }),
    codexLine("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n<environment_context>\n  <cwd>C:\\work\\codexproj</cwd>\n</environment_context>" }] }, "2026-09-14T08:00:01.000Z"),
    codexLine("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "真实提问" }] }, "2026-09-14T08:00:02.000Z"),
  ]);
  writeFileSync(join(home, "session_index.jsonl"), JSON.stringify({ id, thread_name: "桌面命名线程", updated_at: "2026-09-14T08:00:03.000Z" }) + "\n", "utf8");
  const { sessions } = await testScanner({ codex: [root] }).scanAll();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "桌面命名线程", "thread-name priority over every message-derived title is unchanged");
});

test("codex: session id falls back to the rollout filename uuid", async () => {
  const home = makeTmp();
  const root = join(home, "sessions");
  const id = "019fb399-2222-7d24-a26b-39732b7ce85b";
  writeCodexSession(root, join("2026", "09", "04"), `rollout-2026-09-04T08-00-00-${id}.jsonl`, [
    "{corrupt",
    codexLine("event_msg", { type: "user_message", message: "无 meta 的会话" }),
  ]);
  const { sessions } = await testScanner({ codex: [root] }).scanAll();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, id);
  assert.equal(sessions[0].project, null);
  assert.equal(sessions[0].resumeCommand, `codex resume ${id}`);
});

// --- grok --------------------------------------------------------------------

// root is the sessions dir (~/.grok/sessions): <encoded-cwd>/<session-id>/
// holds summary.json (the index entry) and updates.jsonl (the ACP update
// stream). Fixture shapes follow user-guide/17-sessions.md and the ACP sample
// in README.md (update.sessionUpdate, update.content.text, update.tool).
function writeGrokSession(root, projectDir, sessionId, { summary, updates = [] } = {}) {
  const dir = join(root, projectDir, sessionId);
  mkdirSync(dir, { recursive: true });
  if (summary !== null) writeFileSync(join(dir, "summary.json"), JSON.stringify(summary), "utf8");
  if (updates.length > 0) {
    writeFileSync(join(dir, "updates.jsonl"), updates.map((u) => JSON.stringify(u)).join("\n") + "\n", "utf8");
  }
  return dir;
}

test("grok: scans summary.json entries and loads the ACP update stream", async () => {
  const root = makeTmp();
  const id = "01912345-6789-7abc-8def-0123456789ab";
  const dir = writeGrokSession(root, "C%3A%5Cwork%5Cgrokproj", id, {
    summary: {
      info: { session_id: id, cwd: "C:\\work\\grokproj" },
      title: "手动重命名的标题",
      generated_title: "自动生成的标题",
      title_is_manual: true,
      created_at: "2026-09-01T10:00:00.000Z",
      updated_at: "2026-09-01T10:30:00.000Z",
      num_messages: 6,
      current_model_id: "grok-4.6",
      agent_name: "default",
      last_turn_summary: "最后一轮的小结",
    },
    updates: [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "grok " } },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "用户问题" } },
      // The reasoning draft is not dialogue and never surfaces.
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "先想想……" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "回答" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "全文" } },
      { sessionUpdate: "tool_call", tool: "read_file", title: "Read", status: "pending" },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: "文件内容" },
      // ACP notification envelopes wrap the same update — same rendering.
      { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "收尾" } } } },
    ],
  });
  const scanner = testScanner({ grok: [root] });
  const { sessions, endpointErrors } = await scanner.scanAll();
  assert.deepEqual(endpointErrors.filter((e) => e.endpoint === "grok"), []);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].endpoint, "grok");
  assert.equal(sessions[0].id, id);
  assert.equal(sessions[0].title, "手动重命名的标题", "a manual /rename always wins");
  assert.equal(sessions[0].summary, "最后一轮的小结");
  assert.equal(sessions[0].project, "C:\\work\\grokproj");
  assert.equal(sessions[0].file, dir);
  assert.equal(sessions[0].createdAt, Date.parse("2026-09-01T10:00:00.000Z"));
  assert.equal(sessions[0].lastActive, Date.parse("2026-09-01T10:30:00.000Z"));
  assert.equal(sessions[0].resumeCommand, `grok --resume ${id}`);

  const messages = await scanner.loadMessages("grok", dir);
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "grok 用户问题"],          // chunk fragments of one turn merge
      ["assistant", "回答全文"],
      ["assistant", "[Tool: read_file]"],
      ["tool", "文件内容"],
      ["assistant", "收尾"],              // envelope-wrapped update, new turn
    ],
  );
});

test("grok: generated title, then cwd basename, then exclusion when there is nothing", async () => {
  const root = makeTmp();
  const id = "01912345-0000-7000-8000-000000000001";
  writeGrokSession(root, "proj", id, {
    summary: {
      sessionId: id, cwd: "C:\\work\\flatproj", // flat fields, no `info`
      generated_title: "自动生成的标题",
      created_at: 1788000000000, updated_at: 1788000001000, num_messages: 4,
    },
  });
  const shellId = "01912345-0000-7000-8000-000000000002";
  writeGrokSession(root, "proj", shellId, {
    summary: { sessionId: shellId, num_messages: 0 }, // saved without a single message
  });
  // No summary.json at all → not a listable session.
  writeGrokSession(root, "proj", "01912345-0000-7000-8000-000000000003", { summary: null });
  const { sessions } = await testScanner({ grok: [root] }).scanAll();
  assert.deepEqual(sessions.map((s) => s.id), [id]);
  assert.equal(sessions[0].title, "自动生成的标题");
  assert.equal(sessions[0].createdAt, 1788000000000);
  assert.equal(sessions[0].lastActive, 1788000001000);
});

test("grok: delete removes only the session dir and never the global search index", async () => {
  const root = makeTmp();
  const id = "01912345-0000-7000-8000-0000000000ff";
  // Grok keeps one FTS search index at the sessions root (session_search.sqlite).
  const index = join(root, "session_search.sqlite");
  writeFileSync(index, "search index", "utf8");
  const dir = writeGrokSession(root, "proj", id, {
    summary: { sessionId: id, cwd: "C:\\work\\p", generated_title: "t", num_messages: 2, created_at: 1788000000000 },
  });
  const result = await testScanner({ grok: [root] }).deleteSessions([{ endpoint: "grok", file: dir }]);
  assert.equal(result.ok.length, 1);
  assert.ok(!existsSync(dir));
  assert.ok(existsSync(index), "the search index is Grok's own state — left untouched");
});


// --- workbuddy ---------------------------------------------------------------
// root is ~/.workbuddy/projects: <cwd-slug>/<sessionId>.jsonl, one event per
// line; the same-name directory holds subagents/ + tool-results/ sidecars.

const WORKBUDDY_PROJECT_DIR = "c--users-me-proj";
const WORKBUDDY_CWD = "C:\\Users\\me\\proj";

function writeWorkbuddySession(root, projectDir, sessionId, events, { sidecar = true } = {}) {
  const dir = join(root, projectDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(
    file,
    events.map((event) => (typeof event === "string" ? event : JSON.stringify(event))).join("\n") + "\n",
    "utf8",
  );
  if (sidecar) {
    mkdirSync(join(dir, sessionId, "subagents"), { recursive: true });
    writeFileSync(join(dir, sessionId, "subagents", "child.jsonl"), "{}\n", "utf8");
    mkdirSync(join(dir, sessionId, "tool-results"), { recursive: true });
    writeFileSync(join(dir, sessionId, "tool-results", "r1.txt"), "tool output", "utf8");
  }
  return file;
}

// One workbuddy message event: role + [{type:"input_text"|"output_text", text}].
function workbuddyMessageEvent(role, text, timestamp, overrides = {}) {
  return {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    timestamp,
    cwd: WORKBUDDY_CWD,
    ...overrides,
  };
}

test("workbuddy: ai-title 标题、首条用户消息摘要、cwd 与会话 id 全部落位", async () => {
  const root = makeTmp();
  const id = "0f4b7c1e-1111-4a2b-8c3d-222233334444";
  const file = writeWorkbuddySession(root, WORKBUDDY_PROJECT_DIR, id, [
    { type: "session-meta", sessionId: id, cwd: WORKBUDDY_CWD, timestamp: 1788000000000 },
    workbuddyMessageEvent("user", "帮我改一下构建脚本", 1788000001000),
    // 内部事件：reasoning / function_call / function_call_result / credit-usage
    { type: "reasoning", text: "模型草稿", timestamp: 1788000001500 },
    { type: "function_call", name: "Read", input: { path: "a" }, timestamp: 1788000002000 },
    { type: "function_call_result", output: "文件内容", timestamp: 1788000002500 },
    { type: "credit-usage", credits: 3, timestamp: 1788000003000 },
    workbuddyMessageEvent("assistant", "好的，我先看构建脚本", 1788000004000),
    { type: "ai-title", aiTitle: "构建脚本修订", timestamp: 1788000005000 },
    { type: "file-history-snapshot", snapshot: { n: 1 }, timestamp: 1788000006000 },
  ]);

  const scanner = testScanner({ workbuddy: [root] });
  const { sessions, endpointErrors } = await scanner.scanAll();
  assert.deepEqual(endpointErrors.filter((entry) => entry.endpoint === "workbuddy"), []);
  const rows = sessions.filter((row) => row.endpoint === "workbuddy");
  assert.equal(rows.length, 1);
  const meta = rows[0];
  assert.equal(meta.id, id, "id 取会话 id（与文件名同源）");
  assert.equal(meta.title, "构建脚本修订", "ai-title 优先于首条用户消息");
  assert.equal(meta.summary, "帮我改一下构建脚本", "列表预览是首条用户消息");
  assert.equal(meta.project, WORKBUDDY_CWD);
  assert.equal(meta.cwd, WORKBUDDY_CWD, "cwd 取自事件行内字段——续接要在原目录起");
  assert.equal(meta.file, file);
  assert.equal(meta.createdAt, 1788000000000);
  assert.equal(meta.lastActive, 1788000006000, "lastActive 取最后一个事件的 timestamp");
  assert.equal(meta.resumeCommand, `workbuddy --resume ${id}`, "resume 模板是新增的 shim 命令");
  assert.deepEqual(
    Object.keys(meta),
    ["endpoint", "id", "title", "summary", "project", "cwd", "originator", "file", "createdAt", "lastActive", "resumeCommand"],
    "makeMeta 的字段一个不少（originator 无来源时落 null，不自造）",
  );

  // 只留用户与助手可见消息；reasoning/function_call*/credit-usage/ai-title 等
  // 内部事件不进 transcript。
  const messages = await scanner.loadMessages("workbuddy", file);
  assert.deepEqual(
    messages.map((message) => [message.role, message.content]),
    [["user", "帮我改一下构建脚本"], ["assistant", "好的，我先看构建脚本"]],
  );
  assert.equal(messages[0].ts, 1788000001000);
  assert.equal(messages[1].ts, 1788000004000);
});

test("workbuddy: 没有 ai-title 时回落到首条用户消息，再没有才用目录名", async () => {
  const root = makeTmp();
  const withUser = "sess-wb-plain";
  writeWorkbuddySession(root, WORKBUDDY_PROJECT_DIR, withUser, [
    { type: "session-meta", sessionId: withUser, cwd: WORKBUDDY_CWD, timestamp: 1788000000000 },
    workbuddyMessageEvent("user", "  这条才是标题候选  ", 1788000001000),
  ]);
  // 只有元数据、没有一条对话：标题回落到项目目录名（cwd-slug），不自造文案。
  const bare = "sess-wb-bare";
  writeWorkbuddySession(root, "c--users-me-bareproject", bare, [
    { type: "session-meta", sessionId: bare, timestamp: 1788000000000 },
  ]);

  const { sessions } = await testScanner({ workbuddy: [root] }).scanAll();
  const byId = new Map(sessions.filter((row) => row.endpoint === "workbuddy").map((row) => [row.id, row]));
  assert.equal(byId.get(withUser).title, "这条才是标题候选", "首条用户消息去空白后作标题");
  assert.equal(byId.get(withUser).summary, "这条才是标题候选");
  assert.equal(byId.get(withUser).project, WORKBUDDY_CWD, "从 message 行也能取到 cwd");
  assert.equal(byId.get(bare).title, "c--users-me-bareproject", "无 ai-title 无消息 → 目录名");
  assert.equal(byId.get(bare).summary, null, "没有可摘要的对话就落 null（既有空态）");
  assert.equal(byId.get(bare).cwd, "", "取不到 cwd 就空串，不从 slug 反推");
});

test("workbuddy: 大文件里只在头窗的 ai-title 也认（尾窗 16KB 之外）", async () => {
  const root = makeTmp();
  const id = "sess-wb-bigtail";
  const events = [
    { type: "session-meta", sessionId: id, cwd: WORKBUDDY_CWD, timestamp: 1788000000000 },
    workbuddyMessageEvent("user", "首条提问", 1788000001000),
    // 标题只生成过一次，落在会话开头；后面几十 KB 的快照把它顶出尾窗。
    { type: "ai-title", aiTitle: "只出现在开头的标题", timestamp: 1788000002000 },
  ];
  for (let i = 0; i < 200; i++) {
    events.push({ type: "file-history-snapshot", snapshot: { index: i, blob: "x".repeat(200) }, timestamp: 1788000003000 + i });
  }
  events.push(workbuddyMessageEvent("assistant", "回答", 1788000100000));
  writeWorkbuddySession(root, WORKBUDDY_PROJECT_DIR, id, events);

  const { sessions } = await testScanner({ workbuddy: [root] }).scanAll();
  const row = sessions.find((session) => session.endpoint === "workbuddy" && session.id === id);
  assert.equal(row.title, "只出现在开头的标题", "ai-title 优先于首条用户消息，不因文件大而丢");
  assert.equal(row.lastActive, 1788000100000, "lastActive 仍取最后一条事件");
});

// 真机会话的裁剪版（2026-10-31 本机复现）：1343 行、ai-title（"优化应用启动动画
// 效果"）落在第 119 行，既不在头 60 行也不在尾 60 行；首条 user 消息是客户端注入
// 的 `<system-reminder data-role="user-context">` 整块，不是人打的字。样本内容
// （路径、标题文案）按原样脱敏后复制进临时目录，不读真实 ~/.workbuddy。
const REAL_WORKBUDDY_TITLE = "优化应用启动动画效果";
const REAL_WORKBUDDY_PROMPT = "启动动画掉帧，帮我看看";
const REAL_WORKBUDDY_REMINDER =
  '<system-reminder data-role="user-context">\n当前工作目录：C:\\Users\\me\\proj\n今天日期：2026-10-31\n</system-reminder>';

function realWorkbuddySessionEvents({ aiTitleAt = 119, withAiTitle = true } = {}) {
  const id = "9c1d2e3f-4a5b-4c6d-8e7f-001122334455";
  const head = [
    { type: "session-meta", sessionId: id, cwd: WORKBUDDY_CWD, timestamp: 1788000000000 },
    // 客户端注入块：真机上它就是首条 user 消息，标题曾退化成这段机器文本。
    workbuddyMessageEvent("user", REAL_WORKBUDDY_REMINDER, 1788000000500),
    workbuddyMessageEvent("user", REAL_WORKBUDDY_PROMPT, 1788000001000),
  ];
  const events = [...head];
  for (let i = events.length; i < 1343; i++) {
    // ai-title 落在第 aiTitleAt 行（1-based）：中间段，两个窗口都看不见。
    if (withAiTitle && i + 1 === aiTitleAt) {
      events.push({ type: "ai-title", aiTitle: REAL_WORKBUDDY_TITLE, timestamp: 1788000002000 + i });
      continue;
    }
    events.push(
      i % 3 === 0
        ? workbuddyMessageEvent("assistant", `第 ${i} 步的说明文字，用来把文件撑到 16KB 以上`, 1788000002000 + i)
        : { type: "file-history-snapshot", snapshot: { index: i, blob: "x".repeat(120) }, timestamp: 1788000002000 + i },
    );
  }
  return { id, events };
}

test("workbuddy: 中段 ai-title 也能读到，注入块不当标题/摘要（真机裁剪样本）", async () => {
  const root = makeTmp();
  const { id, events } = realWorkbuddySessionEvents();
  const file = writeWorkbuddySession(root, WORKBUDDY_PROJECT_DIR, id, events);
  // 样本仍是「大文件」：头 60 行之外、尾 16KB 之外的那一行只有全文件扫描能看见。
  assert.ok(readFileSync(file).byteLength > 16_384, "样本必须走分块读路径");

  const { sessions } = await testScanner({ workbuddy: [root] }).scanAll();
  const row = sessions.find((session) => session.endpoint === "workbuddy" && session.id === id);
  assert.equal(row.title, REAL_WORKBUDDY_TITLE, "ai-title 在第 119 行也要读到");
  assert.ok(!row.summary.startsWith("<system-reminder"), `摘要不得是注入块开头：${row.summary}`);
  assert.equal(row.summary, REAL_WORKBUDDY_PROMPT, "摘要取首条真正由人输入的话");
  assert.equal(row.cwd, WORKBUDDY_CWD);
});

test("workbuddy: 全文件无 ai-title → 回落首条真实用户消息，跳过注入块", async () => {
  const root = makeTmp();
  const { id, events } = realWorkbuddySessionEvents({ withAiTitle: false });
  writeWorkbuddySession(root, WORKBUDDY_PROJECT_DIR, id, events);

  const { sessions } = await testScanner({ workbuddy: [root] }).scanAll();
  const row = sessions.find((session) => session.endpoint === "workbuddy" && session.id === id);
  assert.equal(row.title, REAL_WORKBUDDY_PROMPT, "无 ai-title 时回落到首条真实用户消息");
  assert.equal(row.summary, REAL_WORKBUDDY_PROMPT, "摘要同口径，不回落到注入块");
  assert.ok(!row.summary.includes("<system-reminder"), "注入块整块不参与标题/摘要");
});

test("workbuddy: 多字节字符压在 16KB 块边界上，该行仍能解析（会话 id 与 cwd 不丢）", async () => {
  const root = makeTmp();
  const id = "sess-wb-utf8-edge";
  const cwd = "C:\\Users\\me\\中文项目\\动画";
  // 构造：让 cwd 里「中」的第一个字节落在 16383（0-based），即 16KB 块的最后一
  // 个字节——第 1 块结尾只剩它的首字节。逐块 toString("utf8") 会把它变成
  // U+FFFD，这行 JSON 也跟着坏掉；StringDecoder 则把半个字符留到下一块。
  const skeleton = JSON.stringify({ type: "session-meta", pad: "", cwd, sessionId: id, timestamp: 1788000000000 });
  const at = skeleton.indexOf("中");
  const padBytes = 16_383 - Buffer.byteLength(skeleton.slice(0, at), "utf8");
  assert.ok(padBytes > 0, "pad 需要能补齐到边界前一字节");
  const metaLine = skeleton.replace('"pad":""', `"pad":"${"x".repeat(padBytes)}"`);
  assert.equal(Buffer.byteLength(metaLine.slice(0, metaLine.indexOf("中")), "utf8"), 16_383, "「中」正好跨块");

  const events = [metaLine];
  for (let i = 0; i < 40; i++) {
    events.push(JSON.stringify({ type: "file-history-snapshot", snapshot: { index: i, blob: "y".repeat(200) }, timestamp: 1788000001000 + i }));
  }
  const file = writeWorkbuddySession(root, WORKBUDDY_PROJECT_DIR, id, events, { sidecar: false });
  assert.ok(readFileSync(file).byteLength > 16_384);

  const { sessions } = await testScanner({ workbuddy: [root] }).scanAll();
  const row = sessions.find((session) => session.endpoint === "workbuddy" && session.id === id);
  assert.ok(row, "跨块边界的会话行没有被当成坏行丢掉");
  assert.equal(row.id, id, "sessionId 完整");
  assert.equal(row.cwd, cwd, "cwd 完整（含中文目录名）");
  assert.ok(!row.cwd.includes("\uFFFD"), "没有 U+FFFD 替换字符");
});

test("workbuddy: 坏行与半截 JSON 跳过，不炸整轮，也不连坐其他会话", async () => {
  const root = makeTmp();
  const good = "sess-wb-good";
  const garbage = "sess-wb-garbage";
  writeWorkbuddySession(root, WORKBUDDY_PROJECT_DIR, good, [
    "not json at all {",
    '{"type":"message",', // 半截 JSON
    { type: "session-meta", sessionId: good, cwd: WORKBUDDY_CWD, timestamp: 1788000000000 },
    "",
    workbuddyMessageEvent("user", "坏行夹在中间也要能读", 1788000001000),
    '{"type":"ai-title","aiTitle":', // 尾部半截
  ]);
  // 整份文件都是垃圾：仍然只算一条坏文件，扫描继续
  writeWorkbuddySession(root, WORKBUDDY_PROJECT_DIR, garbage, ["garbage", "}{", ""]);

  const { sessions, endpointErrors } = await testScanner({ workbuddy: [root] }).scanAll();
  assert.deepEqual(endpointErrors.filter((entry) => entry.endpoint === "workbuddy"), []);
  const rows = sessions.filter((row) => row.endpoint === "workbuddy");
  assert.equal(rows.length, 2, "两条会话文件都在，坏行一条都没炸掉整轮");
  const goodRow = rows.find((row) => row.id === good);
  assert.equal(goodRow.title, "坏行夹在中间也要能读");
  assert.equal(goodRow.cwd, WORKBUDDY_CWD);
  // loadMessages 同样跳过坏行
  const messages = await testScanner({ workbuddy: [root] }).loadMessages("workbuddy", goodRow.file);
  assert.deepEqual(messages.map((message) => message.content), ["坏行夹在中间也要能读"]);
});

test("workbuddy: 越界路径被 assertUnderRoots 拒绝（读与删同一守卫）", async () => {
  const root = makeTmp();
  const outside = makeTmp();
  const foreign = join(outside, "sess-foreign.jsonl");
  writeFileSync(foreign, JSON.stringify({ type: "session-meta", sessionId: "x" }) + "\n", "utf8");

  const scanner = testScanner({ workbuddy: [root] });
  await assert.rejects(() => scanner.loadMessages("workbuddy", foreign), /outside endpoint roots/);
  const result = await scanner.deleteSessions([{ endpoint: "workbuddy", file: foreign }]);
  assert.equal(result.ok.length, 0);
  assert.equal(result.fail.length, 1);
  assert.match(result.fail[0].reason, /outside endpoint roots/);
  assert.ok(existsSync(foreign), "越界文件一个字节都不动");
});

test("workbuddy: delete 只删会话文件与同名目录，不碰全局索引与其他会话", async () => {
  const root = makeTmp();
  const id = "sess-wb-delete";
  const sibling = "sess-wb-sibling";
  // 根上的“全局索引”（模拟客户端自己的索引/数据库）必须原样留着
  const globalIndex = join(root, "session-index.json");
  writeFileSync(globalIndex, '{"sessions":[]}', "utf8");
  const file = writeWorkbuddySession(root, WORKBUDDY_PROJECT_DIR, id, [
    { type: "session-meta", sessionId: id, cwd: WORKBUDDY_CWD, timestamp: 1788000000000 },
  ]);
  writeWorkbuddySession(root, WORKBUDDY_PROJECT_DIR, sibling, [
    { type: "session-meta", sessionId: sibling, cwd: WORKBUDDY_CWD, timestamp: 1788000000000 },
  ]);

  const result = await testScanner({ workbuddy: [root] }).deleteSessions([{ endpoint: "workbuddy", file }]);
  assert.equal(result.ok.length, 1);
  assert.equal(existsSync(file), false, "会话文件已删");
  assert.equal(existsSync(join(root, WORKBUDDY_PROJECT_DIR, id)), false, "同名 sidecar 目录一起清掉");
  assert.ok(existsSync(join(root, WORKBUDDY_PROJECT_DIR, sibling, "subagents", "child.jsonl")),
    "同一项目里的其他会话原样保留");
  assert.equal(existsSync(globalIndex), true, "全局索引/数据库绝不碰（grok 先例）");
});


// One real zcode/opencode assistant turn. A "tool" part carries the call AND
// its result (state.output when completed, state.error when it failed, neither
// while running), and the call's name sits under "tool" — not "name". The
// fixture with no tool part at all would let "[Tool: unknown]" for every zcode
// call pass unnoticed, so the fixtures always carry one.
function toolPart(overrides = {}) {
  return {
    type: "tool",
    callID: "call_fixture",
    tool: "Bash",
    state: { status: "completed", input: { command: "ls" }, output: "文件清单" },
    ...overrides,
  };
}

const FIXTURE_TURN = [
  { type: "text", text: "数据库里的回答" },
  toolPart(),
  toolPart({ callID: "call_err", tool: "Read", state: { status: "error", error: "读取失败" } }),
  toolPart({ callID: "call_run", tool: "Grep", state: { status: "running", input: {} } }),
];

// Shared 1.x-shape store: session/message/part only, no session_v2 table.
// zcode 用它建自家 db；opencode 用它模拟 1.x 安装——无 v2 表仍可扫可载的
// 语义由下面「opencode: scans its own db」用例钉住（同一夹具、同一路径）。
function makeSessionDb(dir, fileName = "db.sqlite", turnParts = FIXTURE_TURN) {
  const dbPath = join(dir, fileName);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id text primary key, directory text, title text,
      time_created integer not null, time_updated integer not null
    );
    CREATE TABLE message (
      id text primary key, session_id text not null,
      time_created integer not null, time_updated integer not null, data text not null
    );
    CREATE TABLE part (
      id text primary key, message_id text not null, session_id text not null,
      time_created integer not null, time_updated integer not null, data text not null
    );
  `);
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)").run(
    "sess_db1",
    "C:\\work\\dbproj",
    "数据库会话标题",
    1788000000000,
    1788000009000,
  );
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    "msg_1",
    "sess_db1",
    1788000001000,
    1788000001000,
    JSON.stringify({ role: "user" }),
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "part_1",
    "msg_1",
    "sess_db1",
    1788000001000,
    1788000001000,
    JSON.stringify({ type: "text", text: "数据库里的问题" }),
  );
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    "msg_2",
    "sess_db1",
    1788000002000,
    1788000002000,
    JSON.stringify({ role: "assistant" }),
  );
  turnParts.forEach((part, i) => {
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
      `part_t${i}`,
      "msg_2",
      "sess_db1",
      1788000002000 + i,
      1788000002000 + i,
      JSON.stringify(part),
    );
  });
  db.close();
  return dbPath;
}

// opencode 2.x store: sessions in session_v2, messages in session_message. The
// 1.x tables are created too (the upgrade leaves them in place) so a test can
// seed rows only the old table carries.
function makeOpencodeV2Db(dir, fileName = "opencode.db") {
  const dbPath = join(dir, fileName);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id text primary key, directory text, title text,
      time_created integer not null, time_updated integer not null
    );
    CREATE TABLE message (
      id text primary key, session_id text not null,
      time_created integer not null, time_updated integer not null, data text not null
    );
    CREATE TABLE part (
      id text primary key, message_id text not null, session_id text not null,
      time_created integer not null, time_updated integer not null, data text not null
    );
    CREATE TABLE session_v2 (
      id text primary key, directory text not null, title text,
      time_created integer not null, time_updated integer not null
    );
    CREATE TABLE session_message (
      id text primary key, session_id text not null, type text not null,
      seq integer not null, time_created integer not null, data text not null
    );
  `);
  const insertV2 = db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)");
  // Migrated row: present in BOTH stores under the same id (the real upgrade
  // copies 1.x sessions into session_v2 rather than moving them).
  insertV2.run("ses_both", "C:\\work\\v2proj", "升级前就有的会话", 1788000000000, 1788000005000);
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)").run(
    "ses_both",
    "C:\\work\\v2proj",
    "升级前就有的会话",
    1788000000000,
    1788000005000,
  );
  // 2.x-only session with no title of its own.
  insertV2.run("ses_v2new", "C:\\work\\v2proj", null, 1788000010000, 1788000090000);
  // 1.x-only session (upgrade never copied it).
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)").run(
    "sess_legacy_only",
    "C:\\work\\oldproj",
    "只在旧表里的会话",
    1788000000000,
    1788000001000,
  );
  const insertMessage = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)");
  insertMessage.run("sm_1", "ses_v2new", "user", 1, 1788000010000,
    JSON.stringify({ time: { created: 1788000010000 }, text: "二点零里的问题" }));
  insertMessage.run("sm_2", "ses_v2new", "assistant", 2, 1788000011000,
    JSON.stringify({
      time: { created: 1788000011000 },
      content: [
        { type: "reasoning", text: "先看代码" },
        { type: "text", text: "二点零里的回答" },
        { type: "tool", name: "shell", state: { status: "completed", content: [{ type: "text", text: "文件清单" }] } },
      ],
    }));
  // Engine bookkeeping rows: never part of the transcript.
  insertMessage.run("sm_3", "ses_v2new", "synthetic", 3, 1788000012000,
    JSON.stringify({ time: { created: 1788000012000 }, text: "<system-reminder>\nPlan mode\n</system-reminder>" }));
  insertMessage.run("sm_4", "ses_v2new", "model-switched", 4, 1788000013000,
    JSON.stringify({ time: { created: 1788000013000 }, model: { id: "m" } }));
  insertMessage.run("sm_5", "ses_v2new", "assistant", 5, 1788000014000,
    JSON.stringify({
      time: { created: 1788000014000 },
      content: [
        { type: "tool", name: "shell", state: { status: "error", error: { type: "tool.execution", message: "读取失败" } } },
      ],
    }));
  db.close();
  return dbPath;
}

test("zcode: scans the session table read-only and loads messages", async () => {
  const root = makeTmp();
  mkdirSync(join(root, "cli", "db"), { recursive: true });
  const dbPath = makeSessionDb(join(root, "cli", "db"));
  const scanner = testScanner({ zcode: [root] });
  const { sessions } = await scanner.scanAll();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "sess_db1");
  assert.equal(sessions[0].title, "数据库会话标题");
  assert.equal(sessions[0].project, "C:\\work\\dbproj");
  assert.equal(sessions[0].file, `sqlite:${dbPath}#sess_db1`);
  assert.equal(sessions[0].createdAt, 1788000000000);
  assert.equal(sessions[0].lastActive, 1788000009000);
  assert.equal(sessions[0].resumeCommand, "zcode --resume sess_db1", "zcode CLI 自带 --resume <sessionId>（session_<hex> 即 db 主键）");

  const messages = await scanner.loadMessages("zcode", sessions[0].file);
  // The turn's tool calls keep their real names ([Tool: Bash], never
  // "[Tool: unknown]"), and every finished call contributes its output as its
  // own "tool"-role message — a still-running call contributes none.
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "数据库里的问题"],
      ["assistant", "数据库里的回答\n[Tool: Bash]\n[Tool: Read]\n[Tool: Grep]"],
      ["tool", "文件清单"],
      ["tool", "读取失败"],
    ],
  );

  const del = await scanner.deleteSessions([{ endpoint: "zcode", file: sessions[0].file }]);
  assert.equal(del.ok.length, 1);
  const check = new DatabaseSync(`file:${dbPath.replace(/\\/g, "/")}?mode=ro`);
  assert.equal(check.prepare("SELECT count(*) n FROM session").get().n, 0);
  check.close();
});

test("opencode: scans its own db and builds a verified resume command", async () => {
  const root = makeTmp();
  makeSessionDb(root, "opencode.db");
  const scanner = testScanner({ opencode: [root] });
  const { sessions } = await scanner.scanAll();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].endpoint, "opencode");
  assert.equal(sessions[0].resumeCommand, "opencode --session sess_db1");

  // Same loader as zcode, so the same tool shape must resolve there too.
  const messages = await scanner.loadMessages("opencode", sessions[0].file);
  assert.equal(messages[1].content, "数据库里的回答\n[Tool: Bash]\n[Tool: Read]\n[Tool: Grep]");
  assert.deepEqual(messages.filter((m) => m.role === "tool").map((m) => m.content), [
    "文件清单",
    "读取失败",
  ]);
});

test("opencode 2.x: reads session_v2 + session_message and still lists 1.x-only rows", async () => {
  const root = makeTmp();
  const dbPath = makeOpencodeV2Db(root);
  const scanner = testScanner({ opencode: [root] });
  const { sessions } = await scanner.scanAll();
  // 2.x sessions first (newest activity wins), the migrated row appears once,
  // and the row only the old table carries is not lost.
  assert.deepEqual(
    sessions.map((s) => s.id),
    ["ses_v2new", "ses_both", "sess_legacy_only"],
  );
  const v2 = sessions.find((s) => s.id === "ses_v2new");
  assert.equal(v2.project, "C:\\work\\v2proj");
  assert.equal(v2.createdAt, 1788000010000);
  assert.equal(v2.lastActive, 1788000090000);
  assert.equal(v2.resumeCommand, "opencode --session ses_v2new");
  assert.equal(sessions.find((s) => s.id === "ses_both").title, "升级前就有的会话");

  const messages = await scanner.loadMessages("opencode", v2.file);
  // Turn shape matches the 1.x loader: the user turn, the assistant turn with
  // its tool calls, then each finished call's output as its own tool message.
  // Engine bookkeeping rows (synthetic envelopes, model switches) stay out.
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "二点零里的问题"],
      ["assistant", "先看代码\n二点零里的回答\n[Tool: shell]"],
      ["tool", "文件清单"],
      ["assistant", "[Tool: shell]"],
      ["tool", "读取失败"],
    ],
  );

  // Deleting has to clear the new store and its message rows (cascades need
  // foreign keys on, which is not the SQLite default).
  const del = await scanner.deleteSessions([{ endpoint: "opencode", file: v2.file }]);
  assert.equal(del.ok.length, 1);
  const check = new DatabaseSync(`file:${dbPath.replace(/\\/g, "/")}?mode=ro`);
  assert.equal(check.prepare("SELECT count(*) n FROM session_v2 WHERE id = 'ses_v2new'").get().n, 0);
  assert.equal(check.prepare("SELECT count(*) n FROM session_message WHERE session_id = 'ses_v2new'").get().n, 0);
  assert.equal(check.prepare("SELECT count(*) n FROM session_v2").get().n, 1, "only the target row is gone");
  check.close();
});

test("sqlite tool blocks without a usable name fall back to [Tool: unknown]", async () => {
  const root = makeTmp();
  mkdirSync(join(root, "cli", "db"), { recursive: true });
  makeSessionDb(join(root, "cli", "db"), "db.sqlite", [
    // empty name → fallback; "name" spelling from the other clients still wins
    toolPart({ tool: "" }),
    toolPart({ callID: "call_named", tool: undefined, name: "Write" }),
  ]);
  const scanner = testScanner({ zcode: [root] });
  const { sessions } = await scanner.scanAll();
  const messages = await scanner.loadMessages("zcode", sessions[0].file);
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "数据库里的问题"],
      ["assistant", "[Tool: unknown]\n[Tool: Write]"],
      ["tool", "文件清单"],
      ["tool", "文件清单"],
    ],
  );
});

test("sqlite adapters degrade to endpointErrors when the db cannot be opened", async () => {
  const root = makeTmp();
  mkdirSync(join(root, "cli", "db"), { recursive: true });
  writeFileSync(join(root, "cli", "db", "db.sqlite"), "this is not a sqlite file", "utf8");
  const scanner = testScanner({ zcode: [root] });
  const { sessions, endpointErrors } = await scanner.scanAll();
  assert.deepEqual(sessions.filter((s) => s.endpoint === "zcode"), []);
  const zcodeError = endpointErrors.find((e) => e.endpoint === "zcode");
  assert.ok(zcodeError, "zcode must surface an endpoint error");
  assert.ok(zcodeError.reason.length > 0);
});

test("sqlite adapters degrade cleanly when the db file is missing", async () => {
  const root = makeTmp();
  const { sessions, endpointErrors } = await testScanner({ zcode: [root] }).scanAll();
  assert.deepEqual(sessions.filter((s) => s.endpoint === "zcode"), []);
  assert.ok(endpointErrors.some((e) => e.endpoint === "zcode"));
});

// --- orchestration ---------------------------------------------------------------

test("scanAll merges adapters, sorts by lastActive desc, isolates failures", async () => {
  const claudeRoot = makeTmp();
  writeClaudeSession(claudeRoot, "C--work-a", "sess-a.jsonl", [
    claudeLine({ sessionId: "sess-a", timestamp: "2026-09-01T10:00:00.000Z" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "a" }, timestamp: "2026-09-01T10:10:00.000Z" }),
  ]);
  const piRoot = makeTmp();
  const piDir = join(piRoot, "--C--work-b--");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "2026-09-01T11-00-00-000Z_pi-id-1.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3, id: "pi-id-1", timestamp: "2026-09-01T11:00:00.000Z", cwd: "C:\\work\\b" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "b", timestamp: 1788264000000 }, timestamp: "2026-09-01T12:00:00.000Z" }),
    ].join("\n") + "\n",
    "utf8",
  );
  // zcode root without a db → endpoint error, must not affect the others.
  const zcodeRoot = makeTmp();
  const scanner = testScanner({ claude: [claudeRoot], pi: [piRoot], zcode: [zcodeRoot] });
  const { sessions, endpointErrors } = await scanner.scanAll();
  const endpoints = sessions.map((s) => s.endpoint);
  assert.ok(endpoints.includes("claude") && endpoints.includes("pi"));
  assert.equal(sessions[0].endpoint, "pi", "pi is more recent and sorts first");
  assert.equal(sessions[1].endpoint, "claude");
  assert.ok(endpointErrors.some((e) => e.endpoint === "zcode"));
});

test("scanEndpoint: 只扫指定端点，名单外与读盘失败都降级为空表", async () => {
  const claudeRoot = makeTmp();
  writeClaudeSession(claudeRoot, "C--work-e", "sess-e.jsonl", [claudeLine({ sessionId: "sess-e" })]);
  // 另一个端点也备好真实会话：单端点扫描的结果里不许混进它。
  const qoderRoot = makeTmp();
  writeQoderSession(qoderRoot, "C--work-e", "sess-q.jsonl", [
    JSON.stringify({ type: "workspace-directories", sessionId: "sess-q", directories: ["C:\\work\\e"] }),
    JSON.stringify({ type: "runtime-config", sessionId: "sess-q", model: "auto", timestamp: 1788000000000 }),
    JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-01T01:13:50.000Z", message: { role: "user", content: [{ type: "text", text: "qoder 问题" }] } }),
  ]);
  const scanner = testScanner({ claude: [claudeRoot], qoder: [qoderRoot] });
  const metas = await scanner.scanEndpoint("claude");
  assert.deepEqual(
    metas.map((m) => [m.endpoint, m.id]),
    [["claude", "sess-e"]],
    "只出指定端点的行",
  );
  // 绑定捕获/复活兜底的调用纪律：判不出就空表，绝不让调用方吃到异常。
  assert.deepEqual(await scanner.scanEndpoint("not-an-endpoint"), []);
  // adapter 在册但 scan() 抛错（坏 db）同样降级为空表——catch 分支不许漏。
  const badRoot = makeTmp();
  mkdirSync(join(badRoot, "cli", "db"), { recursive: true });
  writeFileSync(join(badRoot, "cli", "db", "db.sqlite"), "this is not a sqlite file", "utf8");
  assert.deepEqual(await testScanner({ zcode: [badRoot] }).scanEndpoint("zcode"), []);
});

// --- 扫描离线程（session-scan-worker.mjs） -----------------------------------
// 面板进程的请求路径绝不许直接跑这段同步 fs 扫描：修前实测 2927 条会话
// 2.7–8.0s，期间整个面板（含终端字节流）停摆。这两条钉住承载的两件事：
// 结果与 in-process 调用逐字段一致；worker 起不来时退回本进程而不是丢结果。

test("scan offload: 结果与 in-process 扫描逐字段一致", async () => {
  const claudeRoot = makeTmp();
  writeClaudeSession(claudeRoot, "C--work-w", "sess-w.jsonl", [
    claudeLine({ sessionId: "sess-w", timestamp: "2026-09-01T10:00:00.000Z" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "w" }, timestamp: "2026-09-01T10:05:00.000Z" }),
  ]);
  const scanner = testScanner({ claude: [claudeRoot] });
  const inProcess = await scanner.scanAll();
  // worker 侧也给全套临时根（workerData.roots）：跨线程跑的是同一份扫描代码，
  // 但绝不去读真 home 下的存档。注意 createSessionScanner 是「覆盖式合并默认
  // 根」，所以十个端点都要给临时目录，漏一个就会去扫真 home。
  const workerRoots = {};
  for (const id of ["claude", "kimi", "zcode", "dsh", "pi", "opencode", "qoder", "codex", "grok", "workbuddy"]) {
    workerRoots[id] = [makeTmp()];
  }
  workerRoots.claude = [claudeRoot];
  const offload = createSessionScanOffload({
    workerData: { roots: workerRoots },
    fallback: { scanAll: () => scanner.scanAll(), scanAgent: (id) => scanner.scanEndpoint(id) },
  });
  try {
    const offloaded = await offload.scanAll();
    const only = (rows) => rows.sessions.filter((session) => session.endpoint === "claude");
    assert.deepEqual(only(offloaded), only(inProcess), "全量扫描跨线程后逐字段一致");
    const agentMetas = await offload.scanAgent("claude");
    assert.equal(agentMetas.length, 1);
    assert.equal(agentMetas[0].id, inProcess.sessions[0].id);
  } finally {
    offload.close();
  }
});

test("scan offload: worker 起不来时退回本进程扫，不丢结果", async () => {
  const warns = [];
  const claudeRoot = makeTmp();
  writeClaudeSession(claudeRoot, "C--work-d", "sess-d.jsonl", [claudeLine({ sessionId: "sess-d" })]);
  const scanner = testScanner({ claude: [claudeRoot] });
  const offload = createSessionScanOffload({
    // 不存在的 worker 模块 → 构造即失败，走降级路径。
    workerFile: join(makeTmp(), "no-such-worker.mjs"),
    logger: { warn: (line) => warns.push(line) },
    fallback: { scanAll: () => scanner.scanAll(), scanAgent: (id) => scanner.scanEndpoint(id) },
  });
  try {
    const result = await offload.scanAll();
    assert.equal(result.sessions.length, 1, "降级后仍出结果");
    const agentMetas = await offload.scanAgent("claude");
    assert.equal(agentMetas.length, 1, "单端点扫描同样降级可用");
    assert.equal(warns.length, 1, "降级只记一条 warn，不每拍刷日志");
  } finally {
    offload.close();
  }
});

test("scan offload: 降级不是终点——冷却窗过后会重建 worker（评审 F8）", async () => {
  // 一次抖动（worker 崩一次、某次扫描撞上超时）不许把整个进程生命周期永久
  // 打回「扫描占住事件循环」。冷却窗到点后允许重建，重建成功就该重新离线程。
  const dir = makeTmp();
  const workerFile = join(dir, "reviving-worker.mjs");
  // 先放一个必然崩溃的 worker：顶层直接退出非 0 → 承载判定不可用。
  writeFileSync(workerFile, "process.exit(1);\n", "utf8");
  let fallbackCalls = 0;
  const offload = createSessionScanOffload({
    workerFile,
    // 冷却窗压到 0：下一次扫描立刻允许重建（生产是 5 分钟）。
    reviveCooldownMs: 0,
    logger: { warn: () => {} },
    fallback: {
      scanAll: () => {
        fallbackCalls += 1;
        return { sessions: [], endpointErrors: [] };
      },
      scanAgent: () => [],
    },
  });
  try {
    const first = await offload.scanAll();
    assert.deepEqual(first, { sessions: [], endpointErrors: [] });
    assert.equal(fallbackCalls, 1, "第一次扫描走进程内兜底");
    assert.equal(offload.stats().failures, 1);
    // 修好 worker 模块：冷却窗已过，下一次扫描应当重建并真的走 worker。
    writeFileSync(workerFile, `
import { parentPort } from "node:worker_threads";
parentPort.on("message", (message) => {
  parentPort.postMessage({ id: message?.id, ok: true, result: { sessions: [{ id: "from-worker" }], endpointErrors: [] } });
});
`, "utf8");
    const second = await offload.scanAll();
    assert.equal(second.sessions[0]?.id, "from-worker", "冷却窗过后必须重建 worker 并重新离线程");
    assert.equal(fallbackCalls, 1, "重建成功后不该再走进程内兜底");
    assert.equal(offload.stats().workerStarts, 2, "worker 应当被重建一次");
  } finally {
    offload.close();
  }
});

test("scan offload: 冷却窗内不反复重建 worker（评审 F8 的另一半）", async () => {
  const dir = makeTmp();
  const workerFile = join(dir, "broken-worker.mjs");
  writeFileSync(workerFile, "process.exit(1);\n", "utf8");
  let fallbackCalls = 0;
  const offload = createSessionScanOffload({
    workerFile,
    reviveCooldownMs: 60_000, // 一分钟内不许重建
    logger: { warn: () => {} },
    fallback: {
      scanAll: () => {
        fallbackCalls += 1;
        return { sessions: [], endpointErrors: [] };
      },
      scanAgent: () => [],
    },
  });
  try {
    await offload.scanAll();
    await offload.scanAll();
    await offload.scanAll();
    assert.equal(fallbackCalls, 3, "冷却窗内三次扫描都走进程内兜底");
    assert.equal(offload.stats().workerStarts, 1, "冷却窗内只起过一次 worker（不每拍重建）");
    assert.equal(offload.stats().degraded, true);
  } finally {
    offload.close();
  }
});

test("loadMessages rejects files outside the endpoint roots", async () => {
  const root = makeTmp();
  const outside = makeTmp();
  const foreign = join(outside, "x.jsonl");
  writeFileSync(foreign, claudeLine({}) + "\n", "utf8");
  await assert.rejects(() => claudeScanner(root).loadMessages("claude", foreign), /outside endpoint roots/);
});

// --- SessionMeta.cwd（续接要在会话自己的项目目录里起） -----------------------

test("cwd: 与 project 同源同值（claude 取自 jsonl 行内 cwd）", async () => {
  const root = makeTmp();
  writeClaudeSession(root, "C--work-myproj", "sess-cwd-1.jsonl", [claudeLine({})]);
  const { sessions } = await claudeScanner(root).scanAll();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].project, "C:\\work\\myproj");
  assert.equal(sessions[0].cwd, "C:\\work\\myproj", "cwd 与会话所属项目目录一致");
});

test("cwd: head 窗里没有 cwd 时从 tail 补——别让长前导把它挤出取证窗", async () => {
  const root = makeTmp();
  const lines = [];
  // 首行就是真实提问（在 head 窗内，会话不会被过滤），但这一行不带 cwd；
  // 后面 40 行模式/快照噪声把带 cwd 的那一行挤出 head 30 行，只留在 tail 里。
  lines.push(JSON.stringify({
    type: "user",
    message: { role: "user", content: "真实提问" },
    timestamp: "2026-09-01T10:00:00.000Z",
    sessionId: "sess-cwd-tail",
  }));
  for (let i = 0; i < 40; i++) {
    lines.push(JSON.stringify({ type: "file-history-snapshot", snapshot: { n: i }, timestamp: "2026-09-01T09:00:00.000Z" }));
  }
  lines.push(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: "回答" },
    timestamp: "2026-09-01T10:01:00.000Z",
    cwd: "C:\\Users\\me\\Desktop\\work",
  }));
  writeClaudeSession(root, "C--Users-me-Desktop-work", "sess-cwd-tail.jsonl", lines);
  const { sessions } = await claudeScanner(root).scanAll();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].cwd, "C:\\Users\\me\\Desktop\\work",
    "头窗没有就从尾窗取——否则续接会落在错目录");
});

test("cwd: 拿不到就空串，绝不猜（不从 munged 目录名反推）", async () => {
  const root = makeTmp();
  // 全篇没有 cwd 字段
  writeClaudeSession(root, "C--work-unknown", "sess-cwd-none.jsonl", [
    JSON.stringify({ type: "user", message: { role: "user", content: "没有 cwd 的会话" }, timestamp: "2026-09-01T10:00:00.000Z", sessionId: "sess-cwd-none" }),
  ]);
  const { sessions } = await claudeScanner(root).scanAll();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].project, null, "project 语义不变");
  assert.equal(sessions[0].cwd, "", "cwd 落空串（不是目录名猜测、不是 null）");
});

// 同一段对话被复制到第二个项目目录（真实成因：worktree 里接着聊，claude 在新 cwd 下
// 另起一份 jsonl，sessionId 原样沿用）——扫描按文件各出一行，同一个 id 在列表里出现
// 两次。会话栏按 id 做身份，重复行会互相覆盖动效旧位（收起下方组时单行向下抽搐）。
// 列表层只认「一个会话一行」：同 endpoint 同 id 保留最近活跃的那份。
test("重复 id：同一段对话出现在两个项目目录时只出一行，保留最近活跃的那份", async () => {
  const root = makeTmp();
  const older = writeClaudeSession(root, "C--work-proj", "sess-dup.jsonl", [
    claudeLine({ sessionId: "sess-dup", message: { role: "user", content: "原目录里的那段对话" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "答" }, timestamp: "2026-09-01T10:01:00.000Z", sessionId: "sess-dup" }),
  ]);
  const newer = writeClaudeSession(root, "C--work-proj--claude-worktrees-x", "sess-dup.jsonl", [
    claudeLine({ sessionId: "sess-dup", message: { role: "user", content: "原目录里的那段对话" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "答" }, timestamp: "2026-09-02T10:01:00.000Z", sessionId: "sess-dup" }),
  ]);
  const { sessions } = await claudeScanner(root).scanAll();
  const dup = sessions.filter((row) => row.endpoint === "claude" && row.id === "sess-dup");
  assert.equal(dup.length, 1, "同 id 只留一行");
  assert.equal(dup[0].file, newer, "留下的是最近活跃那份（旧目录副本不顶替）");
  assert.equal(dup[0].lastActive, Date.parse("2026-09-02T10:01:00.000Z"));
  assert.ok(existsSync(older), "去重只在列表层，磁盘文件一个都不动");
});

test("重复 id：不同端点的同 id 不是同一个会话，不许合并", async () => {
  // 两个端点各自产出同 id 会话：若去重键漏掉 endpoint 分量，qoder 那行会被 claude 吃掉。
  const claudeRoot = makeTmp();
  writeClaudeSession(claudeRoot, "C--work-proj", "sess-shared.jsonl", [claudeLine({ sessionId: "sess-shared" })]);
  const qoderRoot = makeTmp();
  writeQoderSession(qoderRoot, "C--work-proj", "sess-shared.jsonl", [
    JSON.stringify({ type: "workspace-directories", sessionId: "sess-shared", directories: ["C:\\work\\proj"] }),
    JSON.stringify({ type: "runtime-config", sessionId: "sess-shared", model: "auto", timestamp: 1788000000000 }),
    JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-01T01:13:50.000Z", message: { role: "user", content: [{ type: "text", text: "qoder 端的同 id 会话" }] } }),
  ]);
  const { sessions } = await testScanner({ claude: [claudeRoot], qoder: [qoderRoot] }).scanAll();
  const rows = sessions.filter((row) => row.id === "sess-shared");
  assert.equal(rows.length, 2, "两个端点各出一行——按裸 id 去重这里就只剩一行");
  assert.deepEqual(
    rows.map((row) => row.endpoint).sort(),
    ["claude", "qoder"],
  );
});

test("cwd: 每个 adapter 的 SessionMeta 都带这个字段（契约不靠个别 adapter 自觉）", async () => {
  // 九个端点各备一个可列出的最小会话：任何一家绕开 makeMeta 漏掉 cwd 都会被抓到。
  const roots = {};

  const claudeRoot = makeTmp();
  writeClaudeSession(claudeRoot, "C--work-myproj", "sess-contract.jsonl", [claudeLine({})]);
  roots.claude = [claudeRoot];

  const kimiRoot = makeTmp();
  const kimiDir = join(kimiRoot, "sessions", "wd_x", "session_kc");
  mkdirSync(join(kimiDir, "agents", "main"), { recursive: true });
  writeFileSync(
    join(kimiDir, "agents", "main", "wire.jsonl"),
    JSON.stringify({ type: "prompt.accepted", content: [{ type: "text", text: "kimi 提问" }], time: 1788000001000 }) + "\n",
    "utf8",
  );
  writeFileSync(
    join(kimiRoot, "session_index.jsonl"),
    JSON.stringify({ sessionId: "session_kc", sessionDir: kimiDir, workDir: "C:\\work\\k" }) + "\n",
    "utf8",
  );
  roots.kimi = [kimiRoot];

  const dshRoot = makeTmp();
  const dshId = "88888888-9999-aaaa-bbbb-cccccccccccc";
  writeDshSession(dshRoot, "--C-work-dshproj--", dshId, [
    [dshHeader(dshId, "C:\\work\\dshproj")],
    [{ type: "user/message", seq: 1, time: 1788000001000, data: { content: [{ type: "text", text: "dsh 提问" }] } }],
  ]);
  roots.dsh = [dshRoot];

  const piRoot = makeTmp();
  const piDir = join(piRoot, "--C--work-piproj--");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "2026-09-01T10-00-00-000Z_019fb399-cccc-7d24-a26b-39732b7ce85b.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3, id: "019fb399-cccc-7d24-a26b-39732b7ce85b", timestamp: "2026-09-01T10:00:00.000Z", cwd: "C:\\work\\piproj" }),
      JSON.stringify({ type: "message", timestamp: "2026-09-01T10:00:02.000Z", message: { role: "user", content: "pi 提问", timestamp: 1788000002000 } }),
    ].join("\n") + "\n",
    "utf8",
  );
  roots.pi = [piRoot];

  const qoderRoot = makeTmp();
  writeQoderSession(qoderRoot, "C--work-qoderproj", "019fb399-dddd-7d24-a26b-39732b7ce85b.jsonl", [
    JSON.stringify({ type: "workspace-directories", sessionId: "019fb399-dddd-7d24-a26b-39732b7ce85b", directories: ["C:\\work\\qoderproj"] }),
    JSON.stringify({ type: "runtime-config", sessionId: "019fb399-dddd-7d24-a26b-39732b7ce85b", model: "auto", timestamp: 1788000000000 }),
    JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-01T01:13:50.000Z", message: { role: "user", content: [{ type: "text", text: "qoder 提问" }] } }),
  ]);
  roots.qoder = [qoderRoot];

  const codexRoot = makeTmp();
  writeCodexSession(codexRoot, join("2026", "09", "01"), "rollout-2026-09-01T10-00-00-019fb399-eeee-7d24-a26b-39732b7ce85b.jsonl", [
    codexLine("session_meta", { id: "019fb399-eeee-7d24-a26b-39732b7ce85b", timestamp: "2026-09-01T10:00:00.000Z", cwd: "C:\\work\\codexproj" }),
    codexLine("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "codex 提问" }] }, "2026-09-01T10:00:03.000Z"),
  ]);
  roots.codex = [codexRoot];

  const grokRoot = makeTmp();
  writeGrokSession(grokRoot, "proj", "01912345-cccc-7000-8000-000000000009", {
    summary: {
      sessionId: "01912345-cccc-7000-8000-000000000009",
      cwd: "C:\\work\\grokproj", // flat fields, no `info`
      generated_title: "grok 会话",
      num_messages: 2,
      created_at: 1788000000000,
      updated_at: 1788000001000,
    },
  });
  roots.grok = [grokRoot];

  const zcodeRoot = makeTmp();
  mkdirSync(join(zcodeRoot, "cli", "db"), { recursive: true });
  makeSessionDb(join(zcodeRoot, "cli", "db"));
  roots.zcode = [zcodeRoot];

  const opencodeRoot = makeTmp();
  makeSessionDb(opencodeRoot, "opencode.db");
  roots.opencode = [opencodeRoot];

  const { sessions } = await testScanner(roots).scanAll();
  const byEndpoint = new Map(sessions.map((s) => [s.endpoint, s]));
  for (const endpoint of ["claude", "kimi", "zcode", "dsh", "pi", "opencode", "qoder", "codex", "grok"]) {
    const row = byEndpoint.get(endpoint);
    assert.ok(row, `${endpoint} 的夹具会话在列表里`);
    assert.equal(typeof row.cwd, "string", `${endpoint} 的 cwd 是字符串（缺失时为 ""）`);
    assert.notEqual(row.cwd, "", `${endpoint} 的 cwd 落到夹具给的项目目录，不是空串`);
  }
  // 字段是 additive：既有九个一个不少
  for (const key of ["endpoint", "id", "title", "summary", "project", "file", "createdAt", "lastActive", "resumeCommand"]) {
    assert.ok(key in byEndpoint.get("claude"), `既有字段 ${key} 原样在册`);
  }
});
