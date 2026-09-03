// relay-host unit tests (B·进程与端口安全): startup log rotation and the
// synchronous crash-log path used by the fatal handlers. All file work happens
// in an os.tmpdir() sandbox — the production logs/relay-host.log is never
// touched.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLogIfNeeded, appendCrashLog } from "./relay-host.mjs";

function makeLogPath() {
  return join(mkdtempSync(join(tmpdir(), "apicred-rh-")), "relay-host.log");
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
  appendCrashLog(join(tmpdir(), "apicred-no-such-dir", "relay-host.log"), "unhandledRejection", "lost");
});
