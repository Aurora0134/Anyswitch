// OpenAI chat.completion.chunk -> Anthropic Messages SSE translation tests.
// Pure state machine: no IO, no network.
//
// The load-bearing invariant: an upstream that never emits reasoning must
// translate byte-for-byte the same as it always has. Reasoning support is an
// additive path, never a rewrite of the existing one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { StreamTranslator, SSEParser, sseEvent, REASONING_FIELDS } from "./stream.mjs";
import { NARRATION_THINKING_SIGNATURE } from "./thinking-signature.mjs";

// Feed one parsed OpenAI chunk through a fresh translator and return the
// emitted Anthropic event frames as [{ event, data }] pairs.
function translate(chunks, wireId = "anthropic/poke-api/claude-opus-5") {
  const translator = new StreamTranslator(wireId);
  let out = "";
  for (const chunk of chunks) out += translator.chunk(chunk);
  out += translator.finish();
  return parseEvents(out);
}

function parseEvents(text) {
  const events = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const dataLine = lines.find((l) => l.startsWith("data: "));
    events.push({ event, data: dataLine ? JSON.parse(dataLine.slice(6)) : null });
  }
  return events;
}

const delta = (d, extra = {}) => ({ choices: [{ index: 0, delta: d, ...extra }] });

// ---------- zero-regression guard: no reasoning upstream ----------

test("a text-only stream translates byte-for-byte as before", () => {
  const events = translate([
    { id: "c1", choices: [{ index: 0, delta: { role: "assistant" } }] },
    { id: "c1", choices: [{ index: 0, delta: { content: "你" } }] },
    { id: "c1", choices: [{ index: 0, delta: { content: "好" } }] },
    { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
  ]);
  assert.deepEqual(
    events.map((e) => e.event),
    ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.equal(events[1].data.content_block.type, "text");
  assert.equal(events[2].data.delta.type, "text_delta");
  assert.equal(events[2].data.delta.text, "你");
  assert.equal(events[3].data.delta.text, "好");
  assert.equal(events[5].data.delta.stop_reason, "end_turn");
  assert.equal(events[5].data.usage.output_tokens, 2);
});

test("a tool-call-only stream translates byte-for-byte as before", () => {
  const events = translate([
    { id: "c2", choices: [{ index: 0, delta: { role: "assistant" } }] },
    { id: "c2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Bash", arguments: "" } }] } }] },
    { id: "c2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] } }] },
    { id: "c2", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
  assert.deepEqual(
    events.map((e) => e.event),
    ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.equal(events[1].data.content_block.type, "tool_use");
  assert.equal(events[1].data.content_block.name, "Bash");
  assert.equal(events[2].data.delta.type, "input_json_delta");
  assert.equal(events[4].data.delta.stop_reason, "tool_use");
});

test("text then tool_use closes the text block before the tool block starts", () => {
  const events = translate([
    { id: "c3", choices: [{ index: 0, delta: { content: "先看一眼" } }] },
    { id: "c3", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: "" } }] } }] },
    { id: "c3", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
  assert.deepEqual(
    events.map((e) => e.event),
    ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.equal(events[1].data.content_block.type, "text");
  assert.equal(events[3].data.index, 0, "the text block is closed at its own index");
  assert.equal(events[4].data.content_block.type, "tool_use");
  assert.equal(events[4].data.index, 1);
});

// ---------- reasoning -> thinking blocks ----------

test("reasoning deltas translate to a thinking block with thinking_delta events", () => {
  const events = translate([
    { id: "c4", choices: [{ index: 0, delta: { role: "assistant" } }] },
    { id: "c4", choices: [{ index: 0, delta: { reasoning_content: "想" } }] },
    { id: "c4", choices: [{ index: 0, delta: { reasoning_content: "想" } }] },
    { id: "c4", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);
  assert.deepEqual(
    events.map((e) => e.event),
    ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.equal(events[1].data.content_block.type, "thinking");
  assert.equal(events[2].data.delta.type, "thinking_delta");
  assert.equal(events[2].data.delta.thinking, "想");
  assert.equal(events[3].data.delta.thinking, "想");
  assert.equal(events[4].data.delta.type, "signature_delta", "the block closes with a narration signature");
});

test("thinking then text closes the thinking block before the text block starts", () => {
  const events = translate([
    { id: "c5", choices: [{ index: 0, delta: { reasoning_content: "想一下" } }] },
    { id: "c5", choices: [{ index: 0, delta: { content: "你好" } }] },
    { id: "c5", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);
  assert.deepEqual(
    events.map((e) => e.event),
    ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.equal(events[1].data.content_block.type, "thinking");
  assert.equal(events[4].data.index, 0, "the thinking block is closed at its own index");
  assert.equal(events[5].data.content_block.type, "text");
  assert.equal(events[5].data.index, 1);
  assert.equal(events[6].data.delta.text, "你好");
});

test("thinking then tool_use closes the thinking block before the tool block starts", () => {
  const events = translate([
    { id: "c6", choices: [{ index: 0, delta: { reasoning_content: "要调工具" } }] },
    { id: "c6", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Bash", arguments: "" } }] } }] },
    { id: "c6", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
  assert.deepEqual(
    events.map((e) => e.event),
    ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "content_block_start", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.equal(events[1].data.content_block.type, "thinking");
  assert.equal(events[5].data.content_block.type, "tool_use");
});

test("every reasoning field alias maps to thinking", () => {
  assert.deepEqual(REASONING_FIELDS, ["reasoning_content", "reasoning", "thought", "thinking"]);
  for (const field of REASONING_FIELDS) {
    const events = translate([
      { id: "c7", choices: [{ index: 0, delta: { [field]: "想" } }] },
      { id: "c7", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    assert.equal(events[1].data.content_block.type, "thinking", field);
    assert.equal(events[2].data.delta.type, "thinking_delta", field);
    assert.equal(events[2].data.delta.thinking, "想", field);
  }
});

test("an unclosed thinking block is closed by finish()", () => {
  const translator = new StreamTranslator("anthropic/poke-api/claude-opus-5");
  let out = translator.chunk({ id: "c8", choices: [{ index: 0, delta: { reasoning_content: "想" } }] });
  out += translator.finish();
  const events = parseEvents(out);
  assert.deepEqual(
    events.map((e) => e.event),
    ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
  );
});

test("usage and stop_reason are unchanged by a thinking block", () => {
  const events = translate([
    { id: "c9", choices: [{ index: 0, delta: { reasoning_content: "想" } }] },
    { id: "c9", choices: [{ index: 0, delta: { content: "答" } }] },
    { id: "c9", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 42 } },
  ]);
  const messageDelta = events.find((e) => e.event === "message_delta");
  assert.equal(messageDelta.data.delta.stop_reason, "end_turn");
  assert.equal(messageDelta.data.usage.output_tokens, 42);
});

// ---------- interleaving: reasoning and content in one chunk ----------

test("reasoning and content arriving in the same chunk emit thinking first, then text", () => {
  const events = translate([
    { id: "c10", choices: [{ index: 0, delta: { reasoning_content: "想", content: "答" } }] },
    { id: "c10", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);
  assert.deepEqual(
    events.map((e) => e.event),
    ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.equal(events[1].data.content_block.type, "thinking");
  assert.equal(events[5].data.content_block.type, "text");
});

// ---------- the narration signature ----------

test("a closing thinking block carries its narration signature before the stop", () => {
  const events = translate([
    { id: "c11", choices: [{ index: 0, delta: { reasoning_content: "想" } }] },
    { id: "c11", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);
  const lastThinkingAt = events.findIndex((e) => e.event === "content_block_delta" && e.data.delta.type === "thinking_delta");
  const signatureAt = events.findIndex((e) => e.event === "content_block_delta" && e.data.delta.type === "signature_delta");
  const stopAt = events.findIndex((e) => e.event === "content_block_stop");
  assert.ok(signatureAt !== -1, "a signature_delta must be emitted");
  assert.ok(signatureAt > lastThinkingAt && signatureAt < stopAt, "the signature lands after the last thinking_delta and before the stop");
  assert.equal(events[signatureAt].data.delta.signature, NARRATION_THINKING_SIGNATURE);
  assert.equal(events[signatureAt].data.index, events[1].data.index, "the signature rides on the thinking block's own index");
});

test("a thinking block closed for a tool_use block also carries the signature", () => {
  const events = translate([
    { id: "c12", choices: [{ index: 0, delta: { reasoning_content: "要调工具" } }] },
    { id: "c12", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Bash", arguments: "{}" } }] } }] },
    { id: "c12", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
  const signature = events.find((e) => e.event === "content_block_delta" && e.data.delta.type === "signature_delta");
  assert.ok(signature, "the signature must be emitted when the thinking block closes mid-stream");
  assert.equal(signature.data.delta.signature, NARRATION_THINKING_SIGNATURE);
});

// ---------- SSEParser: untouched by the translator change ----------

test("SSEParser still yields parsed payloads and stops at [DONE]", () => {
  const parser = new SSEParser();
  const payloads = parser.push('data: {"a":1}\n\ndata: [DONE]\n\ndata: {"b":2}\n\n');
  assert.deepEqual(payloads, [{ a: 1 }]);
});

test("sseEvent frames a type and JSON payload", () => {
  assert.equal(sseEvent("ping", { ok: true }), 'event: ping\ndata: {"ok":true}\n\n');
});
