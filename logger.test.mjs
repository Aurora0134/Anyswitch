// logger.mjs tests: the two contracts the log bus holds — a persisted line carries
// a wall-clock stamp, and the level lives in exactly ONE place (the entry field),
// never duplicated into the message text — plus the live on/off gate that the
// 运行日志 switch drives.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger, formatLogStamp } from "./logger.mjs";

// 2026-09-28 14:42:16, built from LOCAL parts because the stamp is deliberately
// local wall-clock (it gets read next to a user's "it broke around 3pm"). Deriving
// it from local parts keeps the assertion true in any timezone.
const FIXED_TS = new Date(2026, 8, 28, 14, 42, 16).getTime();

describe("logger line format", () => {
  it("stamps every persisted line with local wall-clock time and the level", () => {
    const lines = [];
    const logger = createLogger({ sink: (line) => lines.push(line), now: () => FIXED_TS });
    logger.info("relay listening");
    assert.deepEqual(lines, ["[2026-09-28 14:42:16] [info] relay listening\n"]);
  });

  it("keeps the level out of the message text — it is carried by the field alone", () => {
    const logger = createLogger({ sink: () => {}, now: () => FIXED_TS });
    logger.warn("port 47821 already has a relay serving");
    const [entry] = logger.getHistory();
    assert.equal(entry.level, "warn");
    assert.equal(entry.message, "port 47821 already has a relay serving", "no [warn] prefix is baked into the text");
    assert.equal(entry.ts, FIXED_TS);
  });

  it("takes the level from the call, never from words inside the message", () => {
    // The historical failure this pins: a caller hand-wrote its own level word
    // into the text and the entry then claimed a different one, so the level
    // field stopped being trustworthy. The field is the only source of truth.
    const logger = createLogger({ sink: () => {}, now: () => FIXED_TS });
    logger.info("sync finished with failures: zcode, dsh");
    const [entry] = logger.getHistory();
    assert.equal(entry.level, "info", "the field decides, not the prose");
    assert.equal(entry.message, "sync finished with failures: zcode, dsh");
  });

  it("formats the stamp zero-padded from local parts", () => {
    assert.equal(formatLogStamp(new Date(2026, 0, 5, 3, 4, 5).getTime()), "2026-01-05 03:04:05");
  });
});

describe("logger on/off gate", () => {
  it("writes nothing — sink, history and subscribers — while off, and resumes when re-enabled", () => {
    let enabled = false;
    const lines = [];
    const logger = createLogger({ sink: (line) => lines.push(line), isEnabled: () => enabled, now: () => FIXED_TS });
    const frames = [];
    logger.subscribe((entry) => frames.push(entry));

    logger.info("dropped");
    assert.deepEqual(lines, [], "no sink write while off");
    assert.equal(logger.getHistory().length, 0, "nothing enters the history while off");
    assert.equal(frames.length, 0, "nothing fans out while off");
    assert.equal(logger.isEnabled(), false);

    enabled = true;
    logger.info("kept");
    assert.equal(lines.length, 1, "recording resumes without recreating the logger");
    assert.equal(frames.length, 1);
    assert.equal(logger.getHistory()[0].message, "kept");
  });

  it("still clears while off, so a viewer never keeps stale rows", () => {
    let enabled = true;
    const logger = createLogger({ sink: () => {}, isEnabled: () => enabled, now: () => FIXED_TS });
    logger.info("before");
    enabled = false;
    logger.clear();
    assert.equal(logger.getHistory().length, 0, "clear is a control operation, not a log write");
  });

  it("defaults to recording when no gate is supplied", () => {
    const lines = [];
    const logger = createLogger({ sink: (line) => lines.push(line), now: () => FIXED_TS });
    logger.info("on by default");
    assert.equal(lines.length, 1);
  });
});

describe("logger ring buffer", () => {
  it("keeps only the newest `capacity` entries", () => {
    const logger = createLogger({ sink: () => {}, capacity: 3, now: () => FIXED_TS });
    for (const n of ["a", "b", "c", "d"]) logger.info(n);
    assert.deepEqual(logger.getHistory().map((e) => e.message), ["b", "c", "d"]);
  });
});
