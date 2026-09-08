// session-scan unit tests: every adapter runs against temp-dir fixtures, never
// the real home dirs. Coverage follows the REVIEW-FINDINGS / research-report
// acceptance list: custom-title priority, caveat skipping, dir-name fallback,
// title truncation, journal/agent exclusion, subagents exclusion, delete root
// whitelist (refuse + accept), claude sidecar cleanup, sqlite read-only open
// failure degradation, and the scanAll/loadMessages/deleteSessions contract.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { createSessionScanner } from "./session-scan.mjs";

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "anyswitch-session-scan-"));
}

// Build a scanner where EVERY endpoint root is a fresh empty temp dir except
// the ones the test overrides — an unspecified adapter must scan nothing,
// never the real home dirs.
function testScanner(overrides = {}) {
  const roots = {};
  for (const id of ["claude", "kimi", "zcode", "dsh", "pi", "opencode", "qoder", "reasonix"]) {
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
  assert.match(result.fail[0].reason, /not found/);
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
      JSON.stringify({ type: "text", text: "好的，我来处理", time: 1788000002000 }),
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
    ["user", "assistant"],
  );

  const del = await scanner.deleteSessions([{ endpoint: "kimi", file: sessionDir }]);
  assert.equal(del.ok.length, 1);
  assert.ok(!existsSync(sessionDir));
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

test("dsh: reads zstd-compressed session files", async () => {
  const root = makeTmp();
  const sessionDir = join(root, "--C-work-dshproj--", "11111111-2222-3333-4444-555555555555");
  mkdirSync(sessionDir, { recursive: true });
  const payload = [
    JSON.stringify({
      type: "session",
      version: 0,
      id: "11111111-2222-3333-4444-555555555555",
      createdAt: 1788000000000,
      cwd: "C:\\work\\dshproj",
    }),
    JSON.stringify({ role: "user", content: "压缩会话问题", time: 1788000001000 }),
    JSON.stringify({ role: "assistant", content: "回答", time: 1788000002000 }),
  ].join("\n");
  writeFileSync(join(sessionDir, "session.jsonl.zstd"), zstdCompressSync(Buffer.from(payload, "utf8")));

  const scanner = testScanner({ dsh: [root] });
  const { sessions } = await scanner.scanAll();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "11111111-2222-3333-4444-555555555555");
  assert.equal(sessions[0].title, "压缩会话问题");
  assert.equal(sessions[0].project, "C:\\work\\dshproj");
  assert.equal(sessions[0].createdAt, 1788000000000);
  assert.equal(sessions[0].resumeCommand, "", "dsh has no verified resume syntax");

  const messages = await scanner.loadMessages("dsh", join(sessionDir, "session.jsonl.zstd"));
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "压缩会话问题"],
      ["assistant", "回答"],
    ],
  );

  const del = await scanner.deleteSessions([{ endpoint: "dsh", file: join(sessionDir, "session.jsonl.zstd") }]);
  assert.equal(del.ok.length, 1);
  assert.ok(!existsSync(sessionDir), "the emptied <uuid> dir is removed too");
});

test("dsh: header-only shell sessions are excluded from the list", async () => {
  const root = makeTmp();
  const sessionDir = join(root, "--C-work-dshproj--", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  mkdirSync(sessionDir, { recursive: true });
  const payload = JSON.stringify({
    type: "session",
    version: 0,
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    createdAt: 1788000000000,
    cwd: "C:\\work\\dshproj",
  });
  writeFileSync(join(sessionDir, "session.jsonl.zstd"), zstdCompressSync(Buffer.from(payload, "utf8")));

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
  assert.equal(sessions[0].resumeCommand, "");

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

// --- sqlite adapters ------------------------------------------------------------

function makeSessionDb(dir, fileName = "db.sqlite") {
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
  assert.equal(sessions[0].resumeCommand, "", "zcode resume syntax not verified");

  const messages = await scanner.loadMessages("zcode", sessions[0].file);
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [["user", "数据库里的问题"]],
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

// --- reasonix -------------------------------------------------------------------

test("reasonix: reads its session catalog and prefers custom_title", async () => {
  const localRoot = makeTmp();
  const projectsRoot = makeTmp();
  mkdirSync(join(localRoot, "session-catalog"), { recursive: true });
  const dbPath = join(localRoot, "session-catalog", "v5.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE catalog_sessions (
    path TEXT PRIMARY KEY, directory TEXT NOT NULL, scope TEXT NOT NULL,
    topic_title TEXT NOT NULL DEFAULT '', custom_title TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0,
    last_activity_at INTEGER NOT NULL DEFAULT 0
  )`);
  const sessionFile = join(projectsRoot, "c--work-rxproj", "sessions", "20260901-100000.1-model.jsonl");
  mkdirSync(join(projectsRoot, "c--work-rxproj", "sessions"), { recursive: true });
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ role: "system", content: "You are Reasonix." }),
      JSON.stringify({ role: "user", content: "rx 问题" }),
      JSON.stringify({ role: "assistant", content: "rx 回答" }),
    ].join("\n") + "\n",
    "utf8",
  );
  db.prepare("INSERT INTO catalog_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    sessionFile,
    join(projectsRoot, "c--work-rxproj", "sessions"),
    "workspace",
    "自动标题",
    "用户改的标题",
    "preview text",
    1788000000000,
    1788000009000,
  );
  db.close();

  const scanner = testScanner({ reasonix: [localRoot, projectsRoot] });
  const { sessions } = await scanner.scanAll();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "用户改的标题");
  assert.equal(sessions[0].summary, "preview text");
  assert.equal(sessions[0].file, sessionFile);
  assert.equal(sessions[0].id, "20260901-100000.1-model");

  const messages = await scanner.loadMessages("reasonix", sessionFile);
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "rx 问题"],
      ["assistant", "rx 回答"],
    ],
  );

  const del = await scanner.deleteSessions([{ endpoint: "reasonix", file: sessionFile }]);
  assert.equal(del.ok.length, 1);
  assert.ok(!existsSync(sessionFile));
  const check = new DatabaseSync(`file:${dbPath.replace(/\\/g, "/")}?mode=ro`);
  assert.equal(check.prepare("SELECT count(*) n FROM catalog_sessions").get().n, 0);
  check.close();
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

test("loadMessages rejects files outside the endpoint roots", async () => {
  const root = makeTmp();
  const outside = makeTmp();
  const foreign = join(outside, "x.jsonl");
  writeFileSync(foreign, claudeLine({}) + "\n", "utf8");
  await assert.rejects(() => claudeScanner(root).loadMessages("claude", foreign), /outside endpoint roots/);
});
