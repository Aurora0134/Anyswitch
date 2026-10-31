// logger.mjs tests: the two contracts the log bus holds — a persisted line carries
// a wall-clock stamp, and the level lives in exactly ONE place (the entry field),
// never duplicated into the message text — plus the live on/off gate that the
// 运行日志 switch drives, and the level order a viewer uses to filter what it shows.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger, formatLogStamp, logLevelAllows, LOG_LEVEL_ORDER } from "./logger.mjs";

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
    // field stopped being trustworthy. The prose below carries a level word of
    // its own that DISAGREES with the call — a text-sniffing implementation
    // would flip the field to "warn"; the field must win and the prose must
    // survive verbatim.
    const logger = createLogger({ sink: () => {}, now: () => FIXED_TS });
    logger.info("[warn] sync finished with failures: zcode, dsh");
    const [entry] = logger.getHistory();
    assert.equal(entry.level, "info", "the field decides, not the prose");
    assert.equal(entry.message, "[warn] sync finished with failures: zcode, dsh", "the prose is kept verbatim, hand-written level word and all");
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

describe("level order for a viewer's minimum-level filter", () => {
  it("ranks by severity, not alphabetically", () => {
    // 字典序会把 error 排在 info 之前（e < i < w），拿它当严重度排序，最吵的一档
    // 会被当成最紧急的。表里只有这三个级别，序必须写死在这里。
    assert.ok(LOG_LEVEL_ORDER.info < LOG_LEVEL_ORDER.warn);
    assert.ok(LOG_LEVEL_ORDER.warn < LOG_LEVEL_ORDER.error);
    assert.deepEqual(Object.keys(LOG_LEVEL_ORDER).sort(), ["error", "info", "warn"]);
  });

  it("shows an entry when it is at or above the floor", () => {
    assert.equal(logLevelAllows("info", "info"), true);
    assert.equal(logLevelAllows("warn", "info"), true);
    assert.equal(logLevelAllows("error", "info"), true);
    assert.equal(logLevelAllows("info", "warn"), false);
    assert.equal(logLevelAllows("warn", "warn"), true);
    assert.equal(logLevelAllows("error", "warn"), true);
    assert.equal(logLevelAllows("info", "error"), false);
    assert.equal(logLevelAllows("warn", "error"), false);
    assert.equal(logLevelAllows("error", "error"), true);
  });

  it("passes anything it cannot rank, in either direction", () => {
    // 认不出来的条目级别：将来真加第四级时，它不该因为一个显示过滤器不认识它就从
    // 面板上消失——那将是查无此行的故障。认不出来的门槛：等于没有门槛。
    assert.equal(logLevelAllows("debug", "error"), true);
    assert.equal(logLevelAllows(undefined, "error"), true, "控制帧没有 level，必须放行");
    assert.equal(logLevelAllows("info", "bogus"), true);
    assert.equal(logLevelAllows("info", undefined), true);
  });
});
