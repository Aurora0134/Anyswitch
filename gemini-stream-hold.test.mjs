// translateGeminiStream under holdEntireTurn (enhanced anti-truncation): the
// whole turn is withheld from the client, but the upstream-first-token
// timestamp (onFirstChunk → tracker.recordFirstChunk) must still fire when the
// upstream proves content — TPS divides completion tokens by the generation
// segment, which the hold would otherwise defer to the verdict flush.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { translateGeminiStream } from "./gemini-stream.mjs";

function openAiChunk(body) {
  return `data: ${JSON.stringify(body)}\n\n`;
}

describe("translateGeminiStream holdEntireTurn upstream-first-token timestamp", () => {
  it("fires onFirstChunk when the upstream proves content, not only at the verdict flush", async () => {
    let fakeNow = 1000;
    const firstChunkAt = [];
    const upstream = (async function* () {
      const enc = new TextEncoder();
      await new Promise((r) => setTimeout(r, 20)); // ordering only; the clock is fakeNow
      fakeNow += 400; // upstream TTFT
      yield enc.encode(openAiChunk({ id: "1", choices: [{ index: 0, delta: { content: "hello" } }] }));
      await new Promise((r) => setTimeout(r, 20));
      fakeNow += 300; // generation segment
      yield enc.encode(openAiChunk({
        id: "1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    })();

    const out = [];
    const outcome = await translateGeminiStream(upstream, "test-slug", (t) => out.push(t), {
      holdEntireTurn: true,
      onFirstChunk: () => firstChunkAt.push(fakeNow),
    });

    assert.equal(outcome.ok, true, "a healthy held turn must pass");
    assert.equal(firstChunkAt.length, 1, "onFirstChunk must fire exactly once");
    assert.equal(firstChunkAt[0], 1400, "onFirstChunk must fire at the upstream first token, not at the end");
    assert.equal(out.join("").includes("candidates"), true, "the withheld turn must be delivered at the flush");
  });

  it("basic mode is untouched: onFirstChunk fires on the released first chunk", async () => {
    let fakeNow = 1000;
    const firstChunkAt = [];
    const upstream = (async function* () {
      const enc = new TextEncoder();
      await new Promise((r) => setTimeout(r, 20));
      fakeNow += 400;
      yield enc.encode(openAiChunk({ id: "1", choices: [{ index: 0, delta: { content: "hello" } }] }));
      await new Promise((r) => setTimeout(r, 20));
      fakeNow += 300;
      yield enc.encode(openAiChunk({
        id: "1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    })();

    const out = [];
    const outcome = await translateGeminiStream(upstream, "test-slug", (t) => out.push(t), {
      onFirstChunk: () => firstChunkAt.push(fakeNow),
    });

    assert.equal(outcome.ok, true);
    assert.equal(firstChunkAt.length, 1);
    assert.equal(firstChunkAt[0], 1400);
  });
});
