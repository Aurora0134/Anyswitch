import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assignClaudeSessions,
  claudeProcStartQuery,
  defaultClaudeSessionsDir,
  parseClaudeProcStartOutput,
  parseClaudeSessionRegistryEntry,
  readClaudeSessionRegistry,
} from "../src/agents/claude-session-registry.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

// CC 会话注册表读侧（pid → 会话 id）的纪律是「只信正证」：坏文件、缺字段、
// 刻度对不上、目录读不出，一律不归属——宁可漏折，不可误折。

describe("parseClaudeSessionRegistryEntry", () => {
  it("parses a well-formed registry file (procStart stays a string)", () => {
    const entry = parseClaudeSessionRegistryEntry(JSON.stringify({
      pid: 6924,
      sessionId: "7b12538f-f2ca-4cb1-adc5-6e8f10b43051",
      cwd: "C:\\Users\\tester",
      startedAt: 1762380912000,
      procStart: "134375573401776626",
      kind: "interactive",
    }));
    assert.deepEqual(entry, {
      pid: 6924,
      sessionId: "7b12538f-f2ca-4cb1-adc5-6e8f10b43051",
      procStart: "134375573401776626",
    });
  });

  it("rejects malformed JSON, non-object roots and empty input", () => {
    assert.equal(parseClaudeSessionRegistryEntry("{not json"), null);
    assert.equal(parseClaudeSessionRegistryEntry("[1,2]"), null);
    assert.equal(parseClaudeSessionRegistryEntry("42"), null);
    assert.equal(parseClaudeSessionRegistryEntry(""), null);
    assert.equal(parseClaudeSessionRegistryEntry(null), null);
  });

  it("rejects entries without a positive integer pid (numeric strings coerce, junk does not)", () => {
    const coerced = parseClaudeSessionRegistryEntry(JSON.stringify({ pid: "6924", sessionId: "s", procStart: "123" }));
    assert.equal(coerced.pid, 6924);
    assert.equal(parseClaudeSessionRegistryEntry(JSON.stringify({ pid: "abc", sessionId: "s", procStart: "123" })), null);
    assert.equal(parseClaudeSessionRegistryEntry(JSON.stringify({ pid: -3, sessionId: "s", procStart: "123" })), null);
    assert.equal(parseClaudeSessionRegistryEntry(JSON.stringify({ pid: 1.5, sessionId: "s", procStart: "123" })), null);
  });

  it("rejects entries with a missing or blank sessionId", () => {
    assert.equal(parseClaudeSessionRegistryEntry(JSON.stringify({ pid: 6924, procStart: "123" })), null);
    assert.equal(parseClaudeSessionRegistryEntry(JSON.stringify({ pid: 6924, sessionId: "   ", procStart: "123" })), null);
  });

  it("rejects a procStart that is not a pure decimal string (FILETIME precision guard)", () => {
    // FILETIME is an 18-digit count: Number() would lose precision, so the
    // compare is string equality and anything not all-digits is no evidence.
    assert.equal(parseClaudeSessionRegistryEntry(JSON.stringify({ pid: 6924, sessionId: "s", procStart: 134375573401776626 })), null);
    assert.equal(parseClaudeSessionRegistryEntry(JSON.stringify({ pid: 6924, sessionId: "s", procStart: "12a3" })), null);
    assert.equal(parseClaudeSessionRegistryEntry(JSON.stringify({ pid: 6924, sessionId: "s" })), null);
  });
});

describe("readClaudeSessionRegistry", () => {
  const fixture = (pid, sessionId, procStart) => JSON.stringify({ pid, sessionId, procStart, kind: "interactive" });

  it("returns an empty Map without touching disk when no candidates are given", () => {
    const out = readClaudeSessionRegistry(join(mkTestDir(), "does-not-exist"), new Set());
    assert.ok(out instanceof Map);
    assert.equal(out.size, 0);
  });

  it("treats an unreadable sessions dir as 'nothing registered' (per-file reads simply fail)", () => {
    const out = readClaudeSessionRegistry(join(mkTestDir(), "missing"), new Set([6924]));
    assert.ok(out instanceof Map);
    assert.equal(out.size, 0);
  });

  it("returns null only for an invalid dir argument (defensive branch)", () => {
    assert.equal(readClaudeSessionRegistry(null, new Set([6924])), null);
    assert.equal(readClaudeSessionRegistry("", new Set([6924])), null);
  });

  it("reads only the candidate pids' files and parses them", () => {
    const dir = mkTestDir();
    writeFileSync(join(dir, "6924.json"), fixture(6924, "sess-a", "111"));
    writeFileSync(join(dir, "17932.json"), fixture(17932, "sess-a", "222"));
    writeFileSync(join(dir, "9999.json"), fixture(9999, "sess-b", "333")); // not a candidate
    const out = readClaudeSessionRegistry(dir, new Set([6924, 17932]));
    assert.equal(out.size, 2);
    assert.equal(out.get(6924).sessionId, "sess-a");
    assert.equal(out.get(17932).procStart, "222");
  });

  it("skips files whose inner pid disagrees with the filename", () => {
    const dir = mkTestDir();
    writeFileSync(join(dir, "6924.json"), fixture(7777, "sess-a", "111"));
    const out = readClaudeSessionRegistry(dir, new Set([6924]));
    assert.equal(out.size, 0);
  });

  it("skips malformed and field-missing files without failing the round", () => {
    const dir = mkTestDir();
    writeFileSync(join(dir, "6924.json"), "{broken");
    writeFileSync(join(dir, "17932.json"), JSON.stringify({ pid: 17932, sessionId: "sess-a" })); // no procStart
    writeFileSync(join(dir, "4444.json"), fixture(4444, "sess-c", "444"));
    const out = readClaudeSessionRegistry(dir, new Set([6924, 17932, 4444]));
    assert.equal(out.size, 1);
    assert.equal(out.get(4444).sessionId, "sess-c");
  });

  it("a pid with no registry file is simply absent (old CC / non-interactive process)", () => {
    const dir = mkTestDir();
    const out = readClaudeSessionRegistry(dir, new Set([6924]));
    assert.ok(out instanceof Map);
    assert.equal(out.size, 0);
  });
});

describe("claudeProcStartQuery / parseClaudeProcStartOutput", () => {
  it("builds no query for an empty candidate set", () => {
    assert.equal(claudeProcStartQuery([]), null);
    assert.equal(claudeProcStartQuery([0, -1, 1.5]), null);
  });

  it("queries Get-Process StartTime as FILETIME for the candidate pids", () => {
    const q = claudeProcStartQuery([6924, 17932]);
    assert.match(q, /^Get-Process -Id 6924,17932 /);
    assert.match(q, /StartTime\.ToFileTime\(\)/);
  });

  it("parses pid,filetime lines and ignores junk", () => {
    const out = parseClaudeProcStartOutput(
      "6924,134375573401776626\r\n" +
      "garbage line\r\n" +
      "17932,134375573505771122\n" +
      ",123\r\n" +
      "1,\r\n",
    );
    assert.deepEqual([...out.entries()], [
      [6924, "134375573401776626"],
      [17932, "134375573505771122"],
    ]);
  });

  it("parses empty and non-string input to an empty map", () => {
    assert.equal(parseClaudeProcStartOutput("").size, 0);
    assert.equal(parseClaudeProcStartOutput(null).size, 0);
  });
});

describe("assignClaudeSessions", () => {
  const registry = new Map([
    [6924, { pid: 6924, sessionId: "sess-a", procStart: "111" }],
    [17932, { pid: 17932, sessionId: "sess-a", procStart: "222" }],
  ]);

  it("assigns only when the live process start tick matches the registry entry", () => {
    const out = assignClaudeSessions(registry, new Map([[6924, "111"], [17932, "222"]]));
    assert.deepEqual([...out.entries()], [[6924, "sess-a"], [17932, "sess-a"]]);
  });

  it("refuses a pid whose live start tick disagrees (PID reuse: stale file meets a new process)", () => {
    const out = assignClaudeSessions(registry, new Map([[6924, "999"], [17932, "222"]]));
    assert.deepEqual([...out.entries()], [[17932, "sess-a"]]);
  });

  it("refuses a pid the process query never answered (no evidence, no guess)", () => {
    const out = assignClaudeSessions(registry, new Map([[17932, "222"]]));
    assert.deepEqual([...out.entries()], [[17932, "sess-a"]]);
  });

  it("compares FILETIME as strings (number-coerced ticks would round differently)", () => {
    const out = assignClaudeSessions(registry, new Map([[6924, 111]]));
    assert.equal(out.size, 0);
  });

  it("tolerates non-Map inputs", () => {
    assert.equal(assignClaudeSessions(null, new Map()).size, 0);
    assert.equal(assignClaudeSessions(registry, null).size, 0);
  });
});

describe("defaultClaudeSessionsDir", () => {
  it("prefers USERPROFILE over the OS home dir", () => {
    const dir = defaultClaudeSessionsDir({ USERPROFILE: "C:\\Users\\tester" });
    assert.equal(dir, join("C:\\Users\\tester", ".claude", "sessions"));
  });

  it("falls back to the OS home dir when USERPROFILE is absent", () => {
    const dir = defaultClaudeSessionsDir({});
    assert.match(dir, /\.claude/);
    assert.match(dir, /sessions$/);
  });
});
