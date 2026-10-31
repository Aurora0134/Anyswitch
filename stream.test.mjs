// OpenAI chat.completion.chunk -> Anthropic Messages SSE translation tests.
// Pure state machine: no IO, no network.
//
// The load-bearing invariant: an upstream that never emits reasoning must
// translate byte-for-byte the same as it always has. Reasoning support is an
// additive path, never a rewrite of the existing one. The two byte-for-byte
// tests below enforce that against literal golden frame text — the full raw
// SSE string, never parsed back into objects — so framing, JSON key order and
// payload shape all count, not just the event names.

import { test } from "node:test";
import assert from "node:assert/strict";

import { StreamTranslator, SSEParser, sseEvent, REASONING_FIELDS } from "./stream.mjs";
import { NARRATION_THINKING_SIGNATURE } from "./thinking-signature.mjs";

// Feed one parsed OpenAI chunk through a fresh translator and return the raw
// Anthropic SSE frames as a single string — the bytes a client would read.
function translateRaw(chunks, wireId = "anthropic/poke-api/claude-opus-5") {
  const translator = new StreamTranslator(wireId);
  let out = "";
  for (const chunk of chunks) out += translator.chunk(chunk);
  out += translator.finish();
  return out;
}

// Same, with the frames parsed into [{ event, data }] pairs for structural
// assertions.
function translate(chunks, wireId) {
  return parseEvents(translateRaw(chunks, wireId));
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

// Literal golden frames for the two no-reasoning streams: the exact bytes the
// relay has always put on the wire. Pinned as raw text — not built with
// sseEvent(), not parsed back into objects — so framing, JSON key order and
// payload shape are all under test. Every frame ends with a blank line,
// including the last one. (The tool golden's \\" renders the single
// backslash-quote pair JSON.stringify puts around the argument fragment.)
const TEXT_ONLY_GOLDEN = `event: message_start
data: {"type":"message_start","message":{"id":"c1","type":"message","role":"assistant","model":"anthropic/poke-api/claude-opus-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}

`;

const TOOL_CALL_GOLDEN = `event: message_start
data: {"type":"message_start","message":{"id":"c2","type":"message","role":"assistant","model":"anthropic/poke-api/claude-opus-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"Bash","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":0}}

event: message_stop
data: {"type":"message_stop"}

`;

// ---------- zero-regression guard: no reasoning upstream ----------

test("a text-only stream translates byte-for-byte as before", () => {
  const chunks = [
    { id: "c1", choices: [{ index: 0, delta: { role: "assistant" } }] },
    { id: "c1", choices: [{ index: 0, delta: { content: "你" } }] },
    { id: "c1", choices: [{ index: 0, delta: { content: "好" } }] },
    { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
  ];
  const raw = translateRaw(chunks);
  assert.equal(raw, TEXT_ONLY_GOLDEN);
  const events = parseEvents(raw);
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
  const chunks = [
    { id: "c2", choices: [{ index: 0, delta: { role: "assistant" } }] },
    { id: "c2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Bash", arguments: "" } }] } }] },
    { id: "c2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] } }] },
    { id: "c2", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  const raw = translateRaw(chunks);
  assert.equal(raw, TOOL_CALL_GOLDEN);
  const events = parseEvents(raw);
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
