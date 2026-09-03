import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";
import { createUsageJournal, dayKey } from "./usage-journal.mjs";

function fakeJournal() {
  const lines = [];
  return { lines, appendRequest: (entry) => lines.push(entry) };
}

function testCollector(opts) {
  return createAgentMetricsCollector({ loadSparkSettings: false, ...opts });
}

describe("usage journal wiring", () => {
  it("appends a complete line for a streaming success", () => {
    let t = 1000;
    const journal = fakeJournal();
    const collector = testCollector({ nowFn: () => t, journal });

    const req = collector.startRequest({
      providerId: "furry",
      model: "kimi-k3",
      agentId: "kimi",
      stream: true,
      path: "openai",
    });
    t = 1800; // 800ms TTFT
    req.recordFirstChunk();
    t = 4000; // 3000ms total
    req.recordEnd({
      status: 200,
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 30 },
      },
    });

    assert.equal(journal.lines.length, 1);
    assert.deepEqual(journal.lines[0], {
      ts: 4000,
      agentId: "kimi",
      providerId: "furry",
      model: "kimi-k3",
      prompt: 100,
      completion: 20,
      cached: 30,
      ttftMs: 800,
      durationMs: 3000,
      ok: true,
      status: 200,
      errKind: null,
      stream: true,
      path: "openai",
    });
  });

  it("uses the full duration as the TTFT proxy for a non-streaming success", () => {
    let t = 5000;
    const journal = fakeJournal();
    const collector = testCollector({ nowFn: () => t, journal });

    const req = collector.startRequest({ providerId: "p1", model: "m1", stream: false, path: "anthropic" });
    t = 7500;
    req.recordEnd({ status: 200, usage: { prompt_tokens: 10, completion_tokens: 5 } });

    assert.equal(journal.lines.length, 1);
    assert.equal(journal.lines[0].ttftMs, 2500);
    assert.equal(journal.lines[0].durationMs, 2500);
    assert.equal(journal.lines[0].stream, false);
    assert.equal(journal.lines[0].cached, 0);
    assert.equal(journal.lines[0].errKind, null);
    // agentId omitted from meta falls back to the zcode bucket
    assert.equal(journal.lines[0].agentId, "zcode");
  });

  it("classifies failure rows into the errKind taxonomy", () => {
    let t = 1000;
    const journal = fakeJournal();
    const collector = testCollector({ nowFn: () => t, journal });

    const cases = [
      [{ status: 429, error: { status: 429, message: "rate limited" } }, "http_429", 429],
      [{ status: 502, error: { status: 502, message: "bad gateway" } }, "http_5xx", 502],
      [{ status: 400, error: { status: 400, message: "bad request" } }, "http_4xx", 400],
      [{ status: 500, error: { status: 500, message: "fetch failed" } }, "network", 500],
      [{ error: { message: "read ECONNRESET" } }, "network", null],
      [{ error: { message: "connect ETIMEDOUT 10.0.0.1:443" } }, "timeout", null],
    ];

    for (const [info, expectedKind, expectedStatus] of cases) {
      const req = collector.startRequest({ providerId: "p1", model: "m1", path: "openai" });
      t += 100;
      req.recordEnd(info);
    }

    assert.equal(journal.lines.length, cases.length);
    cases.forEach(([, expectedKind, expectedStatus], i) => {
      assert.equal(journal.lines[i].ok, false);
      assert.equal(journal.lines[i].errKind, expectedKind);
      assert.equal(journal.lines[i].status, expectedStatus);
      assert.equal(journal.lines[i].ttftMs, null); // failures never report a TTFT
    });
  });

  it("writes exactly one line when a retry is followed by success", () => {
    let t = 1000;
    const journal = fakeJournal();
    const collector = testCollector({ nowFn: () => t, journal });

    const req = collector.startRequest({ providerId: "pool-1", model: "m1", stream: true });
    t = 1500;
    req.recordRetry({ reason: "upstream_502", attempt: 1 });
    t = 2000;
    req.recordRetry({ reason: "upstream_502", attempt: 2 });
    t = 2600;
    req.recordFirstChunk();
    t = 4000;
    req.recordEnd({ status: 200, usage: { prompt_tokens: 5, completion_tokens: 3 } });

    assert.equal(journal.lines.length, 1);
    assert.equal(journal.lines[0].ok, true);
    assert.equal(journal.lines[0].durationMs, 3000);
  });

  it("writes exactly one line when the terminal state is a failure after retries", () => {
    let t = 1000;
    const journal = fakeJournal();
    const collector = testCollector({ nowFn: () => t, journal });

    const req = collector.startRequest({ providerId: "pool-1", model: "m1" });
    req.recordRetry({ reason: "upstream_502", attempt: 1 });
    t = 2000;
    req.recordEnd({ status: 502, error: { status: 502, message: "Error" } });
    // A late duplicate terminal record must not add a second line.
    req.recordEnd({ status: 500, error: { status: 500, message: "late" } });

    assert.equal(journal.lines.length, 1);
    assert.equal(journal.lines[0].ok, false);
    assert.equal(journal.lines[0].errKind, "http_5xx");
  });

  it("does not write a line for aborted requests, even on an abort/fault race", () => {
    let t = 1000;
    const journal = fakeJournal();
    const collector = testCollector({ nowFn: () => t, journal });

    const aborted = collector.startRequest({ providerId: "p1", model: "m1" });
    t = 1500;
    aborted.recordEnd({ aborted: true });
    // Late-arriving upstream fault must not overwrite the recorded abort.
    aborted.recordEnd({ status: 502, error: { status: 502, message: "late 502" } });

    assert.equal(journal.lines.length, 0);
  });

  it("keeps the pool id as providerId for pool requests", () => {
    let t = 1000;
    const journal = fakeJournal();
    const collector = testCollector({ nowFn: () => t, journal });

    const okReq = collector.startRequest({ providerId: "pool-9", model: "m1" });
    t = 1200;
    okReq.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });

    const failReq = collector.startRequest({ providerId: "pool-9", model: "m1" });
    t = 1600;
    failReq.recordEnd({ status: 503, error: { status: 503, message: "Error" }, memberId: "member-a" });

    assert.equal(journal.lines.length, 2);
    assert.equal(journal.lines[0].providerId, "pool-9");
    // meta.providerId (the pool id) wins over the failing memberId
    assert.equal(journal.lines[1].providerId, "pool-9");
    assert.equal(journal.lines[1].errKind, "http_5xx");
  });

  it("is a no-op when no journal is injected", () => {
    let t = 1000;
    const collector = testCollector({ nowFn: () => t });

    const ok = collector.startRequest({ providerId: "p1", model: "m1" });
    t = 1500;
    ok.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });

    const fail = collector.startRequest({ providerId: "p1", model: "m1" });
    t = 1800;
    fail.recordEnd({ status: 500, error: { status: 500, message: "boom" } });

    const stab = collector.getModelStability();
    assert.equal(stab.models.length, 1);
    assert.equal(stab.models[0].total, 2);
  });

  it("survives a throwing journal without breaking recordEnd", () => {
    let t = 1000;
    const collector = testCollector({
      nowFn: () => t,
      journal: {
        appendRequest: () => {
          throw new Error("disk on fire");
        },
      },
    });
    const req = collector.startRequest({ providerId: "p1", model: "m1" });
    t = 1200;
    req.recordEnd({ status: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const stab = collector.getModelStability();
    assert.equal(stab.models[0].successRate, 100);
  });
});

describe("usage journal roundtrip through a real journal dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "apicred-journal-wiring-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("persists the collector's line as JSONL and reads it back", () => {
    let t = Date.now();
    const journal = createUsageJournal({ dir, now: () => t });
    const collector = testCollector({ nowFn: () => t, journal });

    const req = collector.startRequest({ providerId: "furry", model: "kimi-k3", agentId: "zcode", stream: true, path: "openai" });
    t += 500;
    req.recordFirstChunk();
    t += 1500;
    req.recordEnd({ status: 200, usage: { prompt_tokens: 42, completion_tokens: 7, prompt_cache_hit_tokens: 11 } });

    const rows = journal.readRequests({ fromDay: dayKey(t - 60000), toDay: dayKey(t) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].providerId, "furry");
    assert.equal(rows[0].model, "kimi-k3");
    assert.equal(rows[0].prompt, 42);
    assert.equal(rows[0].cached, 11);
    assert.equal(rows[0].ttftMs, 500);
    assert.equal(rows[0].ok, true);
    assert.equal(rows[0].errKind, null);
    assert.equal(rows[0].stream, true);
    assert.equal(rows[0].path, "openai");
  });
});
