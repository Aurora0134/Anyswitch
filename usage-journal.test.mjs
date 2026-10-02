// Usage journal unit tests. Real fs on temp dirs only; injected fake `now`
// makes day-rollover and retention assertions exact — no wall-clock coupling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUsageJournal, dayKey } from "./usage-journal.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function tempDir() {
  return mkTestDir("usage-journal-test-");
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

// ── errMsg 消毒（写侧单点，R-22） ──

test("errMsg is sanitized: whitespace collapsed, trimmed, truncated to 200 chars", () => {
  const dir = tempDir();
  const journal = createUsageJournal({ dir });
  journal.appendRequest({ ts: 1, ok: false, errMsg: "  rate   limited\n\nplease   slow\t down  " });
  journal.appendRequest({ ts: 2, ok: false, errMsg: "x".repeat(300) });
  const rows = journal.readRequests();
  assert.equal(rows[0].errMsg, "rate limited please slow down");
  assert.equal(rows[1].errMsg, "x".repeat(200));
  assert.equal(rows[1].errMsg.length, 200);
});

test("errMsg key is dropped for success rows, non-strings and blanks; old keyless rows stay compatible", () => {
  const dir = tempDir();
  const journal = createUsageJournal({ dir });
  journal.appendRequest({ ts: 1, ok: true, errMsg: null }); // 成功行传 null
  journal.appendRequest({ ts: 2, ok: true }); // 成功行不传
  journal.appendRequest({ ts: 3, ok: false, errMsg: 12345 }); // 非字符串
  journal.appendRequest({ ts: 4, ok: false, errMsg: "   " }); // 折叠后为空串
  journal.appendRequest({ ts: 5, ok: false, errMsg: "boom" });
  const rows = journal.readRequests();
  for (const row of rows.slice(0, 4)) {
    assert.ok(!("errMsg" in row), `no errMsg key on ${JSON.stringify(row)}`);
  }
  assert.equal(rows[4].errMsg, "boom");
  // 旧行（无 errMsg 键）原样读回，形状不变
  assert.deepEqual(Object.keys(rows[0]).sort(), ["ok", "ts"]);
});

// ── readRequestsLog（请求日志查询面） ──

function logRow(over = {}) {
  return {
    ts: 1000, agentId: "kimi", providerId: "p1", model: "m1",
    prompt: 1, completion: 1, cached: 0, ttftMs: 100, durationMs: 1000,
    ok: true, status: 200, errKind: null, stream: true, path: "openai",
    ...over,
  };
}

test("readRequestsLog defaults to ts desc and reports total/page/pageSize", () => {
  const dir = tempDir();
  const journal = createUsageJournal({ dir });
  journal.appendRequest(logRow({ ts: 100 }));
  journal.appendRequest(logRow({ ts: 300 }));
  journal.appendRequest(logRow({ ts: 200 }));
  const res = journal.readRequestsLog();
  assert.deepEqual(res.rows.map((r) => r.ts), [300, 200, 100]);
  assert.equal(res.total, 3);
  assert.equal(res.page, 1);
  assert.equal(res.pageSize, 20);
});

test("readRequestsLog day range is a closed interval over local days", () => {
  const dir = tempDir();
  const t0 = Date.parse("2026-08-28T10:00:00");
  let current = t0;
  const journal = createUsageJournal({ dir, now: () => current });
  const day0 = dayKey(t0);
  const day1 = dayKey(t0 + DAY_MS);
  const day2 = dayKey(t0 + 2 * DAY_MS);
  journal.appendRequest(logRow({ ts: t0, model: "d0" }));
  current = t0 + DAY_MS;
  journal.appendRequest(logRow({ ts: t0 + DAY_MS, model: "d1" }));
  current = t0 + 2 * DAY_MS;
  journal.appendRequest(logRow({ ts: t0 + 2 * DAY_MS, model: "d2" }));

  const one = journal.readRequestsLog({ fromDay: day1, toDay: day1 });
  assert.deepEqual(one.rows.map((r) => r.model), ["d1"]);
  assert.equal(one.total, 1);
  const all = journal.readRequestsLog({ fromDay: day0, toDay: day2 });
  assert.equal(all.total, 3, "both ends of the interval are inclusive");
  const none = journal.readRequestsLog({ fromDay: day2, toDay: day0 });
  assert.equal(none.total, 0, "inverted range matches nothing");
});

test("readRequestsLog filters: exact agentId/providerId/model, __none__ sentinel, ok, errKind", () => {
  const dir = tempDir();
  const journal = createUsageJournal({ dir });
  journal.appendRequest(logRow({ ts: 1, agentId: "kimi", providerId: "p1", model: "m1", ok: true, errKind: null }));
  journal.appendRequest(logRow({ ts: 2, agentId: null, providerId: "p2", model: "m2", ok: false, errKind: "http_429", status: 429 }));
  journal.appendRequest(logRow({ ts: 3, agentId: "zcode", providerId: "p1", model: "m2", ok: false, errKind: "network", status: null }));

  assert.equal(journal.readRequestsLog({ agentId: "kimi" }).total, 1);
  const none = journal.readRequestsLog({ agentId: "__none__" });
  assert.equal(none.total, 1, "sentinel matches the null-agentId row");
  assert.equal(none.rows[0].agentId, null);
  assert.deepEqual(journal.readRequestsLog({ providerId: "p1" }).rows.map((r) => r.ts), [3, 1]);
  assert.equal(journal.readRequestsLog({ model: "m2" }).total, 2);
  assert.equal(journal.readRequestsLog({ model: "m3" }).total, 0);
  assert.equal(journal.readRequestsLog({ ok: true }).total, 1);
  assert.equal(journal.readRequestsLog({ ok: false }).total, 2);
  assert.equal(journal.readRequestsLog({ errKind: "http_429" }).total, 1);
  assert.equal(journal.readRequestsLog({ errKind: "network" }).total, 1);
  assert.equal(journal.readRequestsLog({ providerId: "p1", ok: false }).total, 1);
});

test("readRequestsLog sorts by durationMs in both directions with ts desc tiebreak", () => {
  const dir = tempDir();
  const journal = createUsageJournal({ dir });
  journal.appendRequest(logRow({ ts: 10, durationMs: 500 }));
  journal.appendRequest(logRow({ ts: 20, durationMs: 100 }));
  journal.appendRequest(logRow({ ts: 30, durationMs: 500 })); // ties with ts:10 → ts desc wins
  const desc = journal.readRequestsLog({ sortBy: "durationMs", sortDir: "desc" });
  assert.deepEqual(desc.rows.map((r) => r.ts), [30, 10, 20]);
  const asc = journal.readRequestsLog({ sortBy: "durationMs", sortDir: "asc" });
  assert.deepEqual(asc.rows.map((r) => r.ts), [20, 30, 10]);
  const tsAsc = journal.readRequestsLog({ sortBy: "ts", sortDir: "asc" });
  assert.deepEqual(tsAsc.rows.map((r) => r.ts), [10, 20, 30]);
});

test("readRequestsLog clamps page/pageSize and keeps total truthful beyond the last page", () => {
  const dir = tempDir();
  const journal = createUsageJournal({ dir });
  for (let i = 1; i <= 5; i += 1) journal.appendRequest(logRow({ ts: i }));

  const p0 = journal.readRequestsLog({ page: 0, pageSize: 2 });
  assert.equal(p0.page, 1, "page clamps to >= 1");
  assert.deepEqual(p0.rows.map((r) => r.ts), [5, 4]);
  assert.equal(journal.readRequestsLog({ page: -3, pageSize: 2 }).page, 1);
  assert.equal(journal.readRequestsLog({ page: "abc", pageSize: 2 }).page, 1);
  assert.equal(journal.readRequestsLog({ pageSize: 500 }).pageSize, 100, "pageSize clamps to <= 100");
  assert.equal(journal.readRequestsLog({ pageSize: 0 }).pageSize, 1, "pageSize clamps to >= 1");

  const p2 = journal.readRequestsLog({ page: 2, pageSize: 2 });
  assert.deepEqual(p2.rows.map((r) => r.ts), [3, 2]);
  const p3 = journal.readRequestsLog({ page: 3, pageSize: 2 });
  assert.deepEqual(p3.rows.map((r) => r.ts), [1]);
  const deep = journal.readRequestsLog({ page: 99, pageSize: 20 });
  assert.deepEqual(deep.rows, [], "out-of-range page returns empty rows");
  assert.equal(deep.total, 5, "total stays truthful");
  assert.equal(deep.page, 99);
});

test("readRequestsLog facets come from the time-range-only row set (filters never shrink them)", () => {
  const dir = tempDir();
  const t0 = Date.parse("2026-08-28T10:00:00");
  let current = t0;
  const journal = createUsageJournal({ dir, now: () => current });
  journal.appendRequest(logRow({ ts: t0, agentId: "kimi", providerId: "p1", model: "m1", ok: true }));
  journal.appendRequest(logRow({ ts: t0 + 1, agentId: null, providerId: "p2", model: "m2", ok: false, errKind: "http_429" }));
  journal.appendRequest(logRow({ ts: t0 + 2, agentId: "zcode", providerId: "p1", model: "m1", ok: true }));
  current = t0 + DAY_MS;
  journal.appendRequest(logRow({ ts: t0 + DAY_MS, agentId: "dsh", providerId: "p9", model: "m9", ok: true }));

  const res = journal.readRequestsLog({ agentId: "kimi", ok: true });
  assert.equal(res.total, 1, "filters apply to rows/total");
  assert.deepEqual(res.facets.agents, [null, "dsh", "kimi", "zcode"], "null first, then alphabetical");
  assert.deepEqual(res.facets.providers, ["p1", "p2", "p9"]);
  assert.deepEqual(res.facets.models, ["m1", "m2", "m9"]);

  const narrowed = journal.readRequestsLog({ fromDay: dayKey(t0 + DAY_MS), toDay: dayKey(t0 + DAY_MS) });
  assert.deepEqual(narrowed.facets.models, ["m9"], "only the time range shrinks facets");
  assert.deepEqual(narrowed.facets.agents, ["dsh"]);
});
