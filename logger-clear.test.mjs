// logger.clear tests: clearing the ring buffer must also tell live SSE
// subscribers, so a panel page's 清空 stays cleared across refreshes and
// every other open panel window clears together.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "./logger.mjs";

describe("logger.clear", () => {
  it("empties getHistory and pushes a clear frame to subscribers", () => {
    const logger = createLogger({ sink: () => {} });
    logger.info("one");
    logger.warn("two");

    const frames = [];
    const unsubscribe = logger.subscribe((entry) => frames.push(entry));

    logger.clear();

    assert.equal(logger.getHistory().length, 0, "history is empty after clear");
    assert.equal(frames.length, 1, "exactly one frame reaches subscribers");
    assert.equal(frames[0].type, "clear", "the frame is marked as a clear, not a log line");

    unsubscribe();
  });

  it("logs after a clear only replay the new entries, never the cleared ones", () => {
    const logger = createLogger({ sink: () => {} });
    logger.info("before-clear");
    logger.clear();
    logger.info("after-clear");

    const history = logger.getHistory();
    assert.equal(history.length, 1, "only the post-clear entry remains");
    assert.ok(history[0].message.includes("after-clear"));
  });
});
