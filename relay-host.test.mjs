// relay-host unit tests: startup log rotation and the
// synchronous crash-log path used by the fatal handlers. All file work happens
// in an os.tmpdir() sandbox — the production logs/relay-host.log is never
// touched.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLogIfNeeded, appendCrashLog, warmProcessScanCache } from "./relay-host.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

function makeLogPath() {
  return join(mkTestDir("anyswitch-rh-"), "relay-host.log");
}

test("rotateLogIfNeeded leaves a small log untouched", () => {
  const logPath = makeLogPath();
  writeFileSync(logPath, "small\n", "utf8");

  assert.equal(rotateLogIfNeeded(logPath, 1024), false);
  assert.equal(existsSync(logPath), true);
  assert.equal(existsSync(`${logPath}.old`), false);
});

test("rotateLogIfNeeded renames an oversized log to .old", () => {
  const logPath = makeLogPath();
  writeFileSync(logPath, "x".repeat(2048), "utf8");

  assert.equal(rotateLogIfNeeded(logPath, 1024), true);
  assert.equal(existsSync(logPath), false, "the live log is renamed away");
  assert.equal(readFileSync(`${logPath}.old`, "utf8"), "x".repeat(2048));
});

test("rotateLogIfNeeded overwrites a previous .old", () => {
  const logPath = makeLogPath();
  writeFileSync(`${logPath}.old`, "previous generation\n", "utf8");
  writeFileSync(logPath, "y".repeat(4096), "utf8");

  assert.equal(rotateLogIfNeeded(logPath, 1024), true);
  assert.equal(readFileSync(`${logPath}.old`, "utf8"), "y".repeat(4096), "only one .old generation is kept");
});

test("rotateLogIfNeeded is a no-op when no log exists yet", () => {
  const logPath = makeLogPath(); // never written
  assert.equal(rotateLogIfNeeded(logPath, 1024), false);
  assert.equal(existsSync(`${logPath}.old`), false);
});

test("appendCrashLog synchronously appends the labelled crash trace", () => {
  const logPath = makeLogPath();
  writeFileSync(logPath, "before\n", "utf8");

  const err = new Error("boom");
  appendCrashLog(logPath, "uncaughtException", err);

  const text = readFileSync(logPath, "utf8");
  assert.match(text, /^before\n/);
  assert.match(text, /\[uncaughtException\] Error: boom/);
  assert.match(text, /at /, "the full stack trace lands in the crash log");
});

test("appendCrashLog never throws on an unwritable path", () => {
  appendCrashLog(join(tmpdir(), "anyswitch-no-such-dir", "relay-host.log"), "unhandledRejection", "lost");
});

// Startup warm-up of the collector's process-scan cache. The regression shape:
// the relay restarts while the panel tab is hidden, no poll ever primes the
// scan cache, and the first read after switching back pays the cold ~1s probe
// inline — past the panel's pull budget, so the panel falls back to its own
// zero-traffic collector and shows a "0 requests" frame for busy endpoints.
test("warmProcessScanCache kicks the collector's first scan round immediately", () => {
  let calls = 0;
  warmProcessScanCache({ scanProcesses: () => { calls += 1; return Promise.resolve({}); } });
  assert.equal(calls, 1, "startup must kick the scan round synchronously");
});

test("warmProcessScanCache does not wait for the scan round to land", () => {
  // A scan promise that never resolves: if the warm-up awaited it, the relay
  // startup path would hang right here.
  warmProcessScanCache({ scanProcesses: () => new Promise(() => {}) });
});

test("warmProcessScanCache swallows a rejected scan round without an unhandled rejection", async () => {
  const stray = [];
  const onRejection = (reason) => stray.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    assert.doesNotThrow(() => warmProcessScanCache({ scanProcesses: () => Promise.reject(new Error("probe dead")) }));
    await new Promise((r) => setTimeout(r, 20)); // give any stray rejection a tick to fire
    assert.deepEqual(stray, [], "warm-up failure must surface nowhere");
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("warmProcessScanCache tolerates missing or throwing collectors", () => {
  assert.doesNotThrow(() => warmProcessScanCache(null));
  assert.doesNotThrow(() => warmProcessScanCache(undefined));
  assert.doesNotThrow(() => warmProcessScanCache({}), "injected double without scanProcesses");
  assert.doesNotThrow(() => warmProcessScanCache({
    scanProcesses: () => { throw new Error("sync boom"); },
  }), "injected double that throws synchronously");
});
