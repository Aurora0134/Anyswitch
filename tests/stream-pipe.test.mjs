import test from "node:test";
import assert from "node:assert/strict";
import { runStreamWithKeepAlive } from "../src/relay/stream-pipe.mjs";

test("a resume exhausted on the first member keeps its identity and does not invent a second attempted upstream", async () => {
  const calls = [];
  const ends = [];
  const logs = [];
  const member = (memberId) => ({
    memberId,
    memberNoun: "pool member",
    call: async () => {
      calls.push(memberId);
      return { status: 200, stream: {} };
    },
  });
  const tracker = { recordEnd: (row) => ends.push(row) };
  await runStreamWithKeepAlive(
    { writableEnded: false, destroyed: false },
    {
      deps: {
        getKeepAliveConfig: () => ({ enabled: true, mode: "on", maxRetries: 1, backoffMs: 0 }),
      },
      tracker,
      abortController: new AbortController(),
      pipe: async () => ({ outcome: "resume", reason: "upstream_incomplete", shadow: null }),
      callUpstreams: [member("member-a"), member("member-b")],
      onCallError: (error) => { throw error; },
      onTerminalResult: () => { throw new Error("unexpected terminal result"); },
      onSettled: () => { throw new Error("unexpected settled result"); },
      exhaustedMessage: () => "upstream incomplete",
      onExhaustedLog: (message) => logs.push(message),
      sendExhausted: () => {},
      logLabel: "request",
      agentId: "zcode",
    },
  );

  assert.deepEqual(calls, ["member-a", "member-a"]);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].memberId, "member-a", "the terminal ledger belongs to the member actually tried");
  assert.doesNotMatch(ends[0].error.message, /已尝试 2 个上游/, "an untried member is not an upstream failure");
  assert.doesNotMatch(logs[0], /已尝试 2 个上游/);
});
