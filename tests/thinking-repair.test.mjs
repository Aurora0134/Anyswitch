// thinking-repair tests: the streaming state machine, the non-streaming
// split, the stream guard integration (purification, verdict, resume
// shadow), and the server faces end-to-end against a leaky upstream.
//
// The defect under test (observed 2026-11 on a GPT reverse-proxy channel):
// per response, the channel's reasoning→field conversion fails and the
// model's thinking arrives in delta.content wrapped in literal
// <thinking>…</thinking> tags; field-driven clients render it as body text.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkTestDir } from "../test-helpers/tmp.mjs";
import { listenLoopback } from "../test-helpers/loopback.mjs";
import {
  ThinkingTagRepair,
  splitLeadingThinkingBlock,
  repairNonStreamThinking,
} from "../src/relay/thinking-repair.mjs";
import { OpenAIStreamGuard } from "../src/relay/openai-stream-guard.mjs";
import { createOpenAIRelayServer } from "../src/relay/openai-server.mjs";
import { createEffortInjector } from "../src/catalog/effort-injection.mjs";

// Isolation fixture: redirect the per-user data root for this whole test
// process (same idea as openai-server-anthropic-stream.test.mjs — not every
// settings reader goes through injectable deps). node --test runs each file
// in its own process, so this cannot leak into sibling suites;
// test-helpers/tmp.mjs sweeps it on exit.
const envRoot = mkTestDir("anys-thinking-repair-env-");
process.env.LOCALAPPDATA = envRoot;
process.env.APPDATA = envRoot;
process.env.USERPROFILE = envRoot;

const TOKEN = "test-token-thinking-repair";

const STORE = {
  version: 2,
  providers: {
    "test-prov": {
      displayName: "Test Provider",
      baseURL: "https://upstream.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "test.dpapi",
      models: { "test-model": { displayName: "Test Model" } },
    },
  },
};

function createMockDeps({ upstreamFetch }) {
  return {
    token: TOKEN,
    loadStore: () => ({ ok: true, store: STORE }),
    loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
    upstreamFetch,
    recordGeneration: () => {},
    readGeneration: () => null,
    effortInjector: createEffortInjector({ isEnabled: () => false }),
    imageFallbackGate: () => false,
    imageHeuristicGate: () => false,
  };
}

function pump(guard, parts) {
  let out = "";
  for (const part of parts) out += guard.chunk(part);
  return out;
}

function frame(delta, choice = {}) {
  return `data: ${JSON.stringify({ id: "cmpl-1", choices: [{ index: 0, delta, finish_reason: null, ...choice }] })}\n\n`;
}

// Concatenate the per-delta increments a field-driven client would join:
// each SSE chunk carries only its own piece of the reasoning and the text.
function collectDeltaFields(text) {
  const reasoning = [];
  const content = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    const delta = parsed?.choices?.[0]?.delta;
    if (!delta) continue;
    for (const field of ["reasoning_content", "reasoning", "thought", "thinking"]) {
      if (typeof delta[field] === "string" && delta[field].length > 0) reasoning.push(delta[field]);
    }
    if (typeof delta.content === "string" && delta.content.length > 0) content.push(delta.content);
  }
  return { reasoning: reasoning.join(""), content: content.join("") };
}

// Every frame must reach the client as its own SSE event: exactly one
// `data:` line per event (openai-node joins an event's data lines before
// JSON.parse, so two lines in one event kill the turn).
function assertOneDataLinePerEvent(text, label) {
  const events = text.split("\n\n").filter((event) => event.trim() !== "");
  for (const [index, event] of events.entries()) {
    const dataLines = event.split("\n").filter((line) => line.startsWith("data:"));
    assert.equal(dataLines.length, 1, `${label}: event #${index} must hold exactly one data line`);
    const payload = dataLines[0].slice(5).trim();
    if (payload === "[DONE]") continue;
    assert.doesNotThrow(() => JSON.parse(payload), `${label}: event #${index} payload must parse as JSON`);
  }
}

// Subsequence scan over the emitted Anthropic SSE event names; the cursor
// advances past each matched frame so a repeated name in `order` cannot be
// satisfied by the same earlier occurrence.
function assertSseEventOrder(text, order) {
  let cursor = 0;
  for (const event of order) {
    const needle = `event: ${event}`;
    const at = text.indexOf(needle, cursor);
    assert.ok(at !== -1, `missing ${event}`);
    cursor = at + needle.length;
  }
}

function sseStream(chunks) {
  return (async function* () {
    const enc = new TextEncoder();
    for (const c of chunks) yield enc.encode(c);
  })();
}

async function withServer(deps, fn) {
  const server = createOpenAIRelayServer(deps);
  const { port, close } = await listenLoopback(server, 0);
  try {
    return await fn(port);
  } finally {
    await close();
  }
}

describe("ThinkingTagRepair (streaming state machine)", () => {
  it("passes ordinary answer text through untouched", () => {
    const repair = new ThinkingTagRepair();
    assert.deepEqual(repair.push("He"), { text: "He", reasoning: "" });
    assert.deepEqual(repair.push("llo"), { text: "llo", reasoning: "" });
    assert.deepEqual(repair.finish(), { text: "", reasoning: "" });
  });

  it("extracts a leading tag block in one delta", () => {
    const repair = new ThinkingTagRepair();
    assert.deepEqual(
      repair.push("<thinking>look before leap</thinking>\nthe answer"),
      { text: "the answer", reasoning: "look before leap" },
    );
  });

  it("keeps a tag split across many deltas fully out of the text channel", () => {
    const repair = new ThinkingTagRepair();
    const pieces = [
      "<", "th", "inking", ">", "look", " before", " leap", "</", "thi", "nking", ">", "\n", "the", " answer",
    ];
    let text = "";
    let reasoning = "";
    for (const piece of pieces) {
      const out = repair.push(piece);
      text += out.text;
      reasoning += out.reasoning;
    }
    assert.equal(text, "the answer");
    assert.equal(reasoning, "look before leap");
    assert.equal(text.includes("<"), false, "no tag fragment may reach the text channel");
  });

  it("keeps a stream that never closes its tag as pure reasoning", () => {
    const repair = new ThinkingTagRepair();
    assert.deepEqual(repair.push("<thinking>think A"), { text: "", reasoning: "think A" });
    assert.deepEqual(repair.push(" think B"), { text: "", reasoning: " think B" });
    assert.deepEqual(repair.finish(), { text: "", reasoning: "" });
  });

  it("releases a held partial close tag as reasoning at finish", () => {
    const repair = new ThinkingTagRepair();
    // "…text</thi": the tail might still grow into </thinking>, so it is
    // held; the stream ends first, and the unterminated body is thinking
    // (the same call the Responses face makes at its boundary flush).
    assert.deepEqual(repair.push("<thinking>text</thi"), { text: "", reasoning: "text" });
    assert.deepEqual(repair.finish(), { text: "", reasoning: "</thi" });
  });

  it("flushes an undecided prefix as text at finish", () => {
    const repair = new ThinkingTagRepair();
    assert.deepEqual(repair.push("<thi"), { text: "", reasoning: "" });
    assert.deepEqual(repair.finish(), { text: "<thi", reasoning: "" });
  });

  it("never reclassifies after real answer text has started", () => {
    const repair = new ThinkingTagRepair();
    assert.deepEqual(repair.push("answer starts now"), { text: "answer starts now", reasoning: "" });
    // A tag quoted mid-stream is the answer's own bytes: it stays body text.
    assert.deepEqual(
      repair.push("<thinking>late</thinking>"),
      { text: "<thinking>late</thinking>", reasoning: "" },
    );
  });

  it("tolerates separator whitespace before the tag", () => {
    const repair = new ThinkingTagRepair();
    assert.deepEqual(repair.push("  <th"), { text: "", reasoning: "" });
    assert.deepEqual(
      repair.push("inking>think</thinking>\nanswer"),
      { text: "answer", reasoning: "think" },
    );
  });

  it("keeps whitespace that belongs to the answer", () => {
    const repair = new ThinkingTagRepair();
    assert.deepEqual(repair.push("  spaced answer"), { text: "  spaced answer", reasoning: "" });
  });
});

describe("splitLeadingThinkingBlock (non-streaming split)", () => {
  it("splits a leading block, stripping the separator run", () => {
    assert.deepEqual(
      splitLeadingThinkingBlock("<thinking>think</thinking>\nanswer"),
      { reasoning: "think", answer: "answer" },
    );
  });

  it("returns null for content without the leading tag", () => {
    assert.equal(splitLeadingThinkingBlock("plain answer"), null);
    assert.equal(splitLeadingThinkingBlock("mentions <thinking> mid-sentence"), null);
  });

  it("returns null for an unterminated block (left alone, like splitLeadingThinkBlock)", () => {
    assert.equal(splitLeadingThinkingBlock("<thinking>never closed"), null);
  });

  it("tolerates whitespace before the tag and in the separator", () => {
    assert.deepEqual(
      splitLeadingThinkingBlock("  <thinking>t</thinking>  a"),
      { reasoning: "t", answer: "a" },
    );
  });
});

describe("repairNonStreamThinking (non-streaming payload repair)", () => {
  const payload = (message) => ({
    id: "cmpl-1",
    object: "chat.completion",
    choices: [{ index: 0, message, finish_reason: "stop" }],
  });

  it("returns the same reference when nothing matches", () => {
    const p = payload({ role: "assistant", content: "plain answer" });
    assert.equal(repairNonStreamThinking(p), p);
  });

  it("moves a leading block into reasoning_content and leaves the input untouched", () => {
    const p = payload({ role: "assistant", content: "<thinking>think</thinking>\nanswer" });
    const fixed = repairNonStreamThinking(p);
    assert.notEqual(fixed, p);
    assert.equal(
      p.choices[0].message.content,
      "<thinking>think</thinking>\nanswer",
      "the input object must not be mutated",
    );
    assert.equal(fixed.choices[0].message.content, "answer");
    assert.equal(fixed.choices[0].message.reasoning_content, "think");
  });

  it("joins the extracted text into the reasoning field the message already speaks", () => {
    const p = payload({ role: "assistant", content: "<thinking>detail</thinking>answer", reasoning: "summary" });
    const fixed = repairNonStreamThinking(p);
    assert.equal(fixed.choices[0].message.reasoning, "summarydetail");
    assert.equal(
      "reasoning_content" in fixed.choices[0].message,
      false,
      "no second populated reasoning field",
    );
  });

  it("passes payloads without choices through", () => {
    assert.equal(repairNonStreamThinking(null), null);
    assert.deepEqual(repairNonStreamThinking({ error: "x" }), { error: "x" });
  });
});

describe("OpenAIStreamGuard thinking purification", () => {
  it("keeps a clean stream byte-identical (no tag ever matches)", () => {
    const sse = [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"lo <t"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [sse.slice(0, 45), sse.slice(45, 120), sse.slice(120)]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
    assert.equal(emitted + verdict.tail, sse, "a clean stream must stay byte-identical");
  });

  it("moves a leading tag block from content into the reasoning channel", () => {
    const guard = new OpenAIStreamGuard();
    const out = pump(guard, [
      frame({ content: "<thinking>think" }),
      frame({ content: " more</thinking>\n" }),
      frame({ content: "the answer" }),
      frame({}, { finish_reason: "stop" }),
      "data: [DONE]\n\n",
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
    // Per-delta pieces (the client concatenates them): the reasoning channel
    // carries the tag body, the text channel only the answer.
    assert.deepEqual(collectDeltaFields(out + verdict.tail), {
      reasoning: "think more",
      content: "the answer",
    });
    assert.equal((out + verdict.tail).includes("<thinking>"), false, "no literal tag may reach the client");
    assert.ok((out + verdict.tail).includes("[DONE]"));
    assertOneDataLinePerEvent(out + verdict.tail, "leaky stream");
  });

  it("the resume shadow carries the purified form", () => {
    const guard = new OpenAIStreamGuard();
    pump(guard, [
      frame({ content: "<thinking>think</thinking>answer" }),
      frame({}, { finish_reason: "stop" }),
      "data: [DONE]\n\n",
    ]);
    const shadow = guard.resumeShadow();
    assert.equal(shadow.reasoning, "think");
    assert.equal(shadow.text, "answer");
  });

  it("appends the extracted thinking to the reasoning field the upstream already uses", () => {
    const guard = new OpenAIStreamGuard();
    const out = pump(guard, [
      // One delta carrying both channels (LiteLLM-style aggregation): the
      // extracted text must join the field the delta already speaks.
      frame({ reasoning: "summary", content: "<thinking>detail</thinking>answer" }),
      frame({}, { finish_reason: "stop" }),
      "data: [DONE]\n\n",
    ]);
    assert.ok(out.includes('"reasoning":"summarydetail"'), "the extracted text joins the existing field");
    assert.ok(out.includes('"content":"answer"'));
    assert.equal(out.includes("reasoning_content"), false, "no second reasoning field is created");
    assert.equal(out.includes("<thinking>"), false);
  });

  it("classifies a tag-only stream (thinking moved, no answer) as a think-only turn", () => {
    const guard = new OpenAIStreamGuard();
    pump(guard, [
      frame({ content: "<thinking>just think</thinking>" }),
      frame({}, { finish_reason: "stop" }),
      "data: [DONE]\n\n",
    ]);
    const verdict = guard.finish();
    // Post-repair the turn delivered thinking and nothing to act on: the
    // guard's think-only verdict applies to the stream the client saw, so
    // the keep-alive budget can retry the flaky channel instead of handing
    // back an empty answer.
    assert.equal(verdict.reason, "think_only_incomplete");
  });

  it("flushes an undecided prefix as text at stream end, before [DONE]", () => {
    const guard = new OpenAIStreamGuard();
    const out = pump(guard, [
      frame({ content: "<thin" }),
      frame({ tool_calls: [{ index: 0, id: "call_a", function: { name: "read", arguments: "{}" } }] }),
      frame({}, { finish_reason: "tool_calls" }),
      "data: [DONE]\n\n",
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
    const flushAt = verdict.tail.indexOf('"content":"<thin"');
    assert.ok(flushAt !== -1, "the undecided prefix flushes as answer text");
    assert.ok(verdict.tail.indexOf("[DONE]") > flushAt, "the flush frame precedes the terminator");
    assertOneDataLinePerEvent(out + verdict.tail, "flush tail");
  });

  it("flushes an unterminated thinking block into the tail", () => {
    const guard = new OpenAIStreamGuard();
    const out = pump(guard, [
      frame({ content: "<thinking>text</thi" }),
      frame({}, { finish_reason: "stop" }),
      "data: [DONE]\n\n",
    ]);
    assert.ok(out.includes('"reasoning_content":"text"'), "the reasoning streamed as it arrived");
    const verdict = guard.finish();
    assert.equal(verdict.reason, "think_only_incomplete");
    assert.ok(verdict.tail.includes('"reasoning_content":"</thi"'), "the held partial close flushes into the tail");
  });
});

describe("server faces against a leaky upstream", () => {
  it("OpenAI passthrough (streaming): the thinking arrives field-separated and the tags are gone", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"reasoning_content":"summary"}}]}\n\n',
        'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"<thinking>det"}}]}\n\n',
        'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"ail</thinking>\\nthe answer"}}]}\n\n',
        'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":5}}\n\n',
        "data: [DONE]\n\n",
      ]),
    });

    await withServer(createMockDeps({ upstreamFetch }), async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/openai/test-prov/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ model: "test-model", stream: true, messages: [{ role: "user", content: "hello" }] }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('"reasoning_content":"summary"'), "the field-separated reasoning passes through");
      assert.ok(text.includes('"reasoning_content":"det"'), "the first tag fragment streams as reasoning");
      assert.ok(text.includes('"reasoning_content":"ail"'), "the tag tail joins the reasoning channel");
      assert.ok(text.includes('"content":"the answer"'), "the answer text is clean");
      assert.equal(text.includes("<thinking>"), false, "no literal tag may reach the client");
      assert.ok(text.includes("[DONE]"));
      assertOneDataLinePerEvent(text, "passthrough leaky stream");
    });
  });

  it("Anthropic face (streaming): a thinking block renders instead of tag text", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"<th"}}]}\n\n',
        'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"inking>think</thinking>\\nthe answer"}}]}\n\n',
        'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":5}}\n\n',
        "data: [DONE]\n\n",
      ]),
    });

    await withServer(createMockDeps({ upstreamFetch }), async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/test-prov/test-model",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      const order = [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ];
      assertSseEventOrder(text, order);
      assert.ok(text.includes('"thinking_delta"'), "the extracted tag text streams as thinking");
      assert.ok(text.includes('"thinking":"think"'));
      assert.ok(text.includes('"text_delta"'));
      assert.ok(text.includes('"text":"the answer"'));
      assert.equal(text.includes("<th"), false, "no tag fragment may reach the client");
      assert.equal(text.includes("inking>"), false);
    });
  });

  it("OpenAI passthrough (non-streaming): message.content loses the leading block to reasoning_content", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "cmpl-1",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "<thinking>think</thinking>\nthe answer" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    });

    await withServer(createMockDeps({ upstreamFetch }), async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/openai/test-prov/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ model: "test-model", stream: false, messages: [{ role: "user", content: "hello" }] }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.choices[0].message.content, "the answer");
      assert.equal(body.choices[0].message.reasoning_content, "think");
    });
  });

  it("Anthropic face (non-streaming): the thinking block precedes the text block", async () => {
    const upstreamFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "cmpl-1",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "<thinking>think</thinking>\nthe answer" },
          finish_reason: "stop",
        }],
      }),
    });

    await withServer(createMockDeps({ upstreamFetch }), async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: TOKEN, "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/test-prov/test-model",
          max_tokens: 64,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.content[0].type, "thinking");
      assert.equal(body.content[0].thinking, "think");
      assert.equal(body.content[1].type, "text");
      assert.equal(body.content[1].text, "the answer");
    });
  });
});
