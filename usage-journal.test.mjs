// Usage journal unit tests. Real fs on temp dirs only; injected fake `now`
// makes day-rollover and retention assertions exact — no wall-clock coupling.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUsageJournal, dayKey } from "./usage-journal.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "usage-journal-test-"));
}

test("appendRequest/appendSession round-trip through read", () => {
  const dir = tempDir();
  const journal = createUsageJournal({ dir });

  const req = {
    ts: 1724900000000, agentId: "kimi", providerId: "pool-1", model: "kimi-k3",
    prompt: 1234, completion: 567, cached: 100, ttftMs: 850, durationMs: 5200,
    ok: true, status: 200, errKind: null, stream: true, path: "openai",
  };
  const sess = {
    ts: 1724900000000, agentId: "claude", event: "end", startTs: 1724890000000,
    durationMs: 3600000, prompt: 0, completion: 0, cached: 0,
  };
  journal.appendRequest(req);
  journal.appendRequest({ ...req, ts: 1724900001000, ok: false, status: 429, errKind: "http_429" });
  journal.appendSession(sess);

  assert.deepEqual(journal.readRequests(), [
    req,
    { ...req, ts: 1724900001000, ok: false, status: 429, errKind: "http_429" },
  ]);
  assert.deepEqual(journal.readSessions(), [sess]);
  // kinds stay in separate files
  const names = readdirSync(dir).sort();
  assert.equal(names.filter((n) => n.startsWith("requests-")).length, 1);
  assert.equal(names.filter((n) => n.startsWith("sessions-")).length, 1);
});

test("read returns entries sorted by ts ascending even across files", () => {
  const dir = tempDir();
  const t0 = Date.parse("2026-08-28T10:00:00"); // local parse, matches dayKey local day
  let current = t0;
  const journal = createUsageJournal({ dir, now: () => current });

  current = t0 + DAY_MS; // next local day
  journal.appendRequest({ ts: 300 });
  current = t0;
  journal.appendRequest({ ts: 100 });
  journal.appendRequest({ ts: 200 });

  assert.deepEqual(
    journal.readRequests().map((e) => e.ts),
    [100, 200, 300],
  );
});

test("fake now crossing days lands in different files; range read filters", () => {
  const dir = tempDir();
  const t0 = Date.parse("2026-08-28T10:00:00");
  let current = t0;
  const journal = createUsageJournal({ dir, now: () => current });

  const day0 = dayKey(t0);
  const day1 = dayKey(t0 + DAY_MS);
  const day2 = dayKey(t0 + 2 * DAY_MS);
  assert.notEqual(day0, day1);
  assert.notEqual(day1, day2);

  journal.appendRequest({ ts: t0, tag: "d0" });
  current = t0 + DAY_MS;
  journal.appendRequest({ ts: t0 + DAY_MS, tag: "d1" });
  current = t0 + 2 * DAY_MS;
  journal.appendRequest({ ts: t0 + 2 * DAY_MS, tag: "d2" });

  assert.ok(existsSync(join(dir, `requests-${day0}.jsonl`)));
  assert.ok(existsSync(join(dir, `requests-${day1}.jsonl`)));
  assert.ok(existsSync(join(dir, `requests-${day2}.jsonl`)));

  assert.deepEqual(
    journal.readRequests({ fromDay: day1, toDay: day1 }).map((e) => e.tag),
    ["d1"],
  );
  assert.deepEqual(
    journal.readRequests({ fromDay: day1 }).map((e) => e.tag),
    ["d1", "d2"],
  );
  assert.deepEqual(
    journal.readRequests({ toDay: day0 }).map((e) => e.tag),
    ["d0"],
  );
});

test("corrupt lines are skipped without breaking the rest", () => {
  const dir = tempDir();
  const journal = createUsageJournal({ dir });
  journal.appendRequest({ ts: 1, tag: "good-1" });
  journal.appendRequest({ ts: 3, tag: "good-2" });

  const file = join(dir, `requests-${dayKey(Date.now())}.jsonl`);
  appendFileSync(file, '{"ts":2,"tag":"broken"\n'); // truncated JSON
  appendFileSync(file, "not json at all\n");
  appendFileSync(file, "\n"); // blank line

  assert.deepEqual(
    journal.readRequests().map((e) => e.tag),
    ["good-1", "good-2"],
  );
});

test("cleanup deletes files older than retentionDays and keeps the rest", () => {
  const dir = tempDir();
  const now = Date.now();
  const day90 = dayKey(now - 90 * DAY_MS);
  const day91 = dayKey(now - 91 * DAY_MS);
  for (const day of [day90, day91]) {
    writeFileSync(join(dir, `requests-${day}.jsonl`), '{"ts":1}\n');
    writeFileSync(join(dir, `sessions-${day}.jsonl`), '{"ts":1}\n');
  }
  writeFileSync(join(dir, "unrelated.txt"), "keep me");

  const journal = createUsageJournal({ dir, now: () => now });
  journal.cleanup();

  assert.equal(existsSync(join(dir, `requests-${day91}.jsonl`)), false);
  assert.equal(existsSync(join(dir, `sessions-${day91}.jsonl`)), false);
  assert.equal(existsSync(join(dir, `requests-${day90}.jsonl`)), true);
  assert.equal(existsSync(join(dir, `sessions-${day90}.jsonl`)), true);
  assert.equal(existsSync(join(dir, "unrelated.txt")), true, "non-journal files untouched");
});

test("cleanup runs at create and again when now() crosses a day", () => {
  const dir = tempDir();
  const t0 = Date.now();
  const staleDay = dayKey(t0 - 91 * DAY_MS);
  const staleFile = join(dir, `requests-${staleDay}.jsonl`);
  writeFileSync(staleFile, '{"ts":1}\n');

  // create-time sweep
  let current = t0;
  const journal = createUsageJournal({ dir, now: () => current });
  assert.equal(existsSync(staleFile), false, "create must run cleanup once");

  // a file that becomes stale after the day rolls over
  const borderlineDay = dayKey(t0 - 90 * DAY_MS);
  const borderlineFile = join(dir, `requests-${borderlineDay}.jsonl`);
  writeFileSync(borderlineFile, '{"ts":1}\n');
  journal.appendRequest({ ts: current, tag: "same-day" });
  assert.equal(existsSync(borderlineFile), true, "no re-scan within the same day");

  current = t0 + DAY_MS; // cross a day boundary -> 90-day file is now 91 days old
  journal.appendRequest({ ts: current, tag: "next-day" });
  assert.equal(existsSync(borderlineFile), false, "day rollover triggers cleanup");
});

test("append auto-creates a missing dir", () => {
  const dir = join(tempDir(), "nested", "usage");
  const journal = createUsageJournal({ dir });
  journal.appendRequest({ ts: 1, tag: "x" });
  journal.appendSession({ ts: 2, tag: "y" });
  assert.deepEqual(journal.readRequests().map((e) => e.tag), ["x"]);
  assert.deepEqual(journal.readSessions().map((e) => e.tag), ["y"]);
});

test("read against a missing dir or empty dir returns []", () => {
  const missing = createUsageJournal({ dir: join(tempDir(), "nope") });
  assert.deepEqual(missing.readRequests(), []);
  assert.deepEqual(missing.readSessions(), []);

  const empty = createUsageJournal({ dir: tempDir() });
  assert.deepEqual(empty.readRequests(), []);
  assert.deepEqual(empty.readSessions(), []);
});

test("append failure warns but never throws back at the caller", () => {
  const blocker = join(tempDir(), "blocked");
  writeFileSync(blocker, "i am a file, not a dir");
  const journal = createUsageJournal({ dir: join(blocker, "usage") });
  const originalWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned += 1; };
  try {
    journal.appendRequest({ ts: 1 });
    journal.appendSession({ ts: 2 });
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warned >= 2, "each failed append must warn");
});

test("read parse cache invalidates after append (read → append → read)", () => {
  const dir = tempDir();
  const journal = createUsageJournal({ dir });
  journal.appendRequest({ ts: 1, tag: "a" });
  // first read parses + caches the file
  assert.deepEqual(journal.readRequests().map((e) => e.tag), ["a"]);

  journal.appendRequest({ ts: 2, tag: "b" }); // append changes size -> cache miss
  assert.deepEqual(journal.readRequests().map((e) => e.tag), ["a", "b"]);
});

test("raw appendFileSync from another process is seen on the next read", () => {
  const dir = tempDir();
  const a = createUsageJournal({ dir });
  a.appendRequest({ ts: 1, tag: "first" });
  assert.equal(a.readRequests().length, 1); // warm the cache

  const file = join(dir, `requests-${dayKey(Date.now())}.jsonl`);
  appendFileSync(file, '{"ts":2,"tag":"external"}\n'); // other process appends

  // same instance (stale cache must invalidate) and a fresh instance both see it
  assert.deepEqual(a.readRequests().map((e) => e.tag), ["first", "external"]);
  const b = createUsageJournal({ dir });
  assert.deepEqual(b.readRequests().map((e) => e.tag), ["first", "external"]);
});

test("file removed externally is skipped, not cached as empty; rebuilt file is read again", () => {
  const dir = tempDir();
  const journal = createUsageJournal({ dir });
  journal.appendRequest({ ts: 1, tag: "kept" });
  const oldFile = join(dir, `requests-${dayKey(Date.now() - DAY_MS)}.jsonl`);
  writeFileSync(oldFile, '{"ts":0,"tag":"old"}\n');
  assert.deepEqual(journal.readRequests().map((e) => e.tag), ["old", "kept"]); // cache both

  rmSync(oldFile); // e.g. retention cleanup in another process
  assert.deepEqual(journal.readRequests().map((e) => e.tag), ["kept"]);

  writeFileSync(oldFile, '{"ts":2,"tag":"rebuilt"}\n');
  assert.deepEqual(journal.readRequests().map((e) => e.tag), ["kept", "rebuilt"]);
});

test("dayKey uses the local timezone date", () => {
  // Construct a ts whose UTC and local dates could differ; just verify shape
  // and round-trip consistency with Date's local getters.
  const ts = Date.parse("2026-08-30T23:30:00");
  const d = new Date(ts);
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  assert.equal(dayKey(ts), expected);
  assert.match(dayKey(0), /^\d{4}-\d{2}-\d{2}$/);
});
