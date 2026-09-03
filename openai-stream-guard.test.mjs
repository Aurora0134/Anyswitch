// OpenAIStreamGuard tests: pure state machine over decoded upstream SSE text.
//
// A tool call that never receives an id or a function name is malformed:
// strict OpenAI clients (the Vercel AI SDK among them) validate accumulated
// tool calls at stream flush and abort the whole request on such streams.
// The guard therefore either rejects the response before any byte is
// forwarded (the client sees a plain retryable 5xx) or terminates an
// already-started response with a structured error event instead of [DONE].

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpenAIStreamGuard } from "./openai-stream-guard.mjs";

function pump(guard, parts) {
  let out = "";
  for (const part of parts) out += guard.chunk(part);
  return out;
}

describe("OpenAIStreamGuard", () => {
  it("holds a stream whose only tool call never gets a name and rejects it before anything is forwarded", () => {
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_a","function":{"arguments":"{\\"cmd\\":"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.equal(emitted, "", "nothing may be forwarded while the verdict is unknown");

    const verdict = guard.finish();
    assert.equal(verdict.action, "reject");
    assert.equal(verdict.error.error.type, "api_error");
    assert.match(verdict.error.error.message, /tool call/i);
  });

  it("forwards a healthy stream verbatim across split chunks, releasing [DONE] only at finish", () => {
    const sse = [
      ": keepalive\n",
      "\n",
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"bash","arguments":"{\\"c\\":1}"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [sse.slice(0, 45), sse.slice(45, 120), sse.slice(120)]);

    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
    assert.equal(emitted + verdict.tail, sse, "a healthy stream must be byte-identical");
  });

  it("waits for a tool name that arrives in a later delta before releasing the stream", () => {
    // Under whole-turn hold a pure tool-call stream
    // stays held even once the call has id + name + parseable args: the name
    // arriving late no longer releases mid-stream, but the stream still
    // passes at finish with all bytes flushed verbatim.
    const guard = new OpenAIStreamGuard({ holdEntireTurn: true });
    const before = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a"}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n',
    ]);
    assert.equal(before, "", "an id-only tool call is not yet proof of a usable stream");

    const after = guard.chunk(
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"read"}}]}}]}\n\n',
    );
    assert.equal(after, "", "a complete tool call no longer releases the hold mid-stream");

    const tail = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.equal(tail, "", "held until the verdict");
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
    assert.ok(verdict.tail.includes('"id":"call_a"'), "the held bytes flush at finish");
    assert.ok(verdict.tail.includes('"name":"read"'));
  });

  it("converts a nameless tool call after forwarded text into an error event and withholds [DONE]", () => {
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"He"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"arguments":"{}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.ok(emitted.includes('"content":"He"'), "already-delivered content must survive");

    const verdict = guard.finish();
    assert.equal(verdict.action, "error");
    assert.ok(verdict.errorLine.includes('"error"'));
    assert.ok(verdict.errorLine.includes("api_error"));
    assert.equal(
      (emitted + verdict.errorLine).includes("[DONE]"),
      false,
      "a rejected stream must not look like a normal completion",
    );
  });

  it("rejects a tool call that never receives an id", () => {
    const guard = new OpenAIStreamGuard();
    pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"bash","arguments":"{}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "reject");
  });

  it("classifies a clean stream with no content and no tool calls as empty", () => {
    const sse = [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [sse]);
    assert.equal(emitted, "", "no proof of usable content means the hold lasts to the end");

    const verdict = guard.finish();
    assert.equal(verdict.action, "empty");
    assert.equal(emitted + verdict.tail, sse);
  });

  it("holds non-JSON data lines instead of releasing; a stream of only non-JSON lines is empty", () => {
    // A bare `data:` line (or any non-JSON payload) used to disarm the guard
    // entirely — truncated streams then passed as normal completions and the
    // keep-alive retry never fired. It must prove nothing and stay held.
    const guard = new OpenAIStreamGuard();
    const weird = "data: not-json-at-all\n\n";
    const emitted = pump(guard, [weird, "data: [DONE]\n\n"]);
    assert.equal(emitted, "", "non-JSON lines may not be forwarded while the verdict is unknown");

    const verdict = guard.finish();
    assert.equal(verdict.action, "empty", "a stream with no provable content is empty (retryable)");
    assert.ok((verdict.tail || "").includes(weird.trim()), "held bytes stay buffered verbatim");
  });

  it("flushes held non-JSON data lines verbatim once real content releases the hold", () => {
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      "data:\n\n", // empty data line: a keep-alive ping shape, proves nothing
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.ok(emitted.includes("data:\n\n"), "the held non-JSON line flushes byte-identical");
    assert.ok(emitted.includes('"content":"Hi"'));

    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
  });

  it("an empty data: line at stream start must not disarm the guard", () => {
    // Production shape: gateway keep-alive `data:` ping first, then an empty
    // delta and [DONE] — no content at all. This is a truncation and must be
    // classified empty so the relay retries it.
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      "data:\n\n",
      'data: {"id":"1","choices":[{"delta":{}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.equal(emitted, "");
    assert.equal(guard.finish().action, "empty");
  });

  it("flags the production shape: one complete tool call plus a nameless fragment", () => {
    // Shape observed against a live upstream: a complete tool call, then a
    // second tool-call index that only ever receives an argument fragment --
    // no id, no name. Strict clients validate accumulated tool calls at
    // flush and abort on exactly this. Under whole-turn hold the
    // whole turn stays held, so the verdict is a retryable reject.
    const guard = new OpenAIStreamGuard({ holdEntireTurn: true });
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"TodoWrite","arguments":""}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"x\\":"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.equal(emitted, "", "nothing is forwarded while the verdict is unknown");

    const verdict = guard.finish();
    assert.equal(verdict.action, "reject", "the orphaned fragment must not pass as a completion");
    assert.equal(verdict.reason, "incomplete_tool_call");
  });

  it("releases a stream immediately when receiving reasoning content deltas", () => {
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"step 1 thinking"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.ok(emitted.includes("step 1 thinking"), "reasoning_content must release the stream immediately");

    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
  });

  it("releases a stream when receiving reasoning or thought field deltas", () => {
    const guardReasoning = new OpenAIStreamGuard();
    const emittedReasoning = pump(guardReasoning, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"reasoning":"pondering"}}]}\n\n',
    ]);
    assert.ok(emittedReasoning.includes("pondering"));

    const guardThought = new OpenAIStreamGuard();
    const emittedThought = pump(guardThought, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"thought":"deep thought"}}]}\n\n',
    ]);
    assert.ok(emittedThought.includes("deep thought"));
  });

  it("flags mid-word truncation: content delivered, stream ends with no [DONE] and no finish_reason", () => {
    // The "字中截断" shape: text was flowing, then the TCP stream simply ends.
    // No terminator, no error — previously classified "pass", which made the
    // client treat partial output as a complete response.
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"Here is some partial out"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"put that got cut mid-"}}]}\n\n',
    ]);
    assert.ok(emitted.includes("partial out"), "content is already delivered and must survive");

    const verdict = guard.finish();
    assert.equal(verdict.action, "error");
    assert.equal(verdict.truncated, true);
    assert.match(verdict.error.error.message, /截断|truncat/i);
    assert.equal((emitted + verdict.errorLine).includes("data: [DONE]"), false);
  });

  it("a [DONE] alone (no finish_reason) is enough to prove clean termination", () => {
    // Some upstreams omit finish_reason on the final delta but always send
    // [DONE]. Either signal proves the stream was not cut mid-word.
    const guard = new OpenAIStreamGuard();
    pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"done text"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
  });

  it("a finish_reason alone (no [DONE]) is enough to prove clean termination", () => {
    const guard = new OpenAIStreamGuard();
    pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"done text"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
  });

  it("flags silent truncation: stream ends cleanly but a tool call's arguments are not valid JSON", () => {
    // The "静默截断" shape: [DONE] and finish_reason present, the stream looks
    // perfectly healthy — but the accumulated argument string was cut midway,
    // so it never parses. Under whole-turn hold a pure tool-call
    // turn stays held, so this is a retryable reject — nothing was sent.
    const guard = new OpenAIStreamGuard({ holdEntireTurn: true });
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"bash","arguments":"{\\"comma"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"nd\\":\\"ls -"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.equal(emitted, "", "a pure tool-call turn stays held to the end");

    const verdict = guard.finish();
    assert.equal(verdict.action, "reject", "held bytes were never sent, so the turn is retryable");
    assert.equal(verdict.reason, "truncated_tool_args");
    assert.equal(verdict.truncated, true);
    assert.match(verdict.error.error.message, /JSON|参数/);
  });

  it("still flags silent truncation as a post-content error when text preceded the tool call", () => {
    // Mixed turn: text released the hold, then the tool call's arguments were
    // cut. The text is already delivered and cannot be recalled, so this
    // stays a terminal error verdict (not retryable).
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"Let me check."}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"bash","arguments":"{\\"comma"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"nd\\":\\"ls -"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.ok(emitted.includes("Let me check."), "already-delivered text must survive");

    const verdict = guard.finish();
    assert.equal(verdict.action, "error");
    assert.equal(verdict.truncated, true);
    assert.match(verdict.error.error.message, /JSON|参数/);
  });

  it("rejects a held pure tool-call turn that ends with no terminator (mid-turn cut)", () => {
    // The tool calls parse but [DONE] and finish_reason never arrived:
    // anything after the last delta may have been lost. Held to the end, so
    // reject — retryable.
    const guard = new OpenAIStreamGuard({ holdEntireTurn: true });
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"bash","arguments":"{}"}}]}}]}\n\n',
    ]);
    assert.equal(emitted, "");
    const verdict = guard.finish();
    assert.equal(verdict.action, "reject");
    assert.equal(verdict.reason, "mid_word_truncation");
    assert.equal(verdict.truncated, true);
  });

  it("multi-chunk tool arguments that assemble into valid JSON pass cleanly", () => {
    const guard = new OpenAIStreamGuard({ holdEntireTurn: true });
    pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"bash","arguments":"{\\"comma"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"nd\\":\\"ls -la\\""}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
  });

  it("empty tool arguments (no argument string at all) are valid and pass", () => {
    const guard = new OpenAIStreamGuard({ holdEntireTurn: true });
    pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"ping","arguments":""}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
  });

  it("basic mode releases a complete tool call immediately (empty-stream retry only)", () => {
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"bash","arguments":"{\\"c\\":"}}]}}]}\n\n',
    ]);
    assert.ok(emitted.includes('"name":"bash"'), "basic mode must stream tool calls live");
    const verdict = guard.finish();
    assert.equal(verdict.action, "error");
    assert.equal(verdict.truncated, true);
  });
});

describe("holdEntireTurn (plan A: whole-turn hold in enhanced mode)", () => {
  it("reasoning first does NOT release the hold; healthy turn flushes byte-identical at finish", () => {
    const sse = [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"let me think"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const guard = new OpenAIStreamGuard({ holdEntireTurn: true });
    const emitted = pump(guard, [sse.slice(0, 40), sse.slice(40)]);
    assert.equal(emitted, "", "nothing is forwarded before the verdict");
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
    assert.equal(emitted + verdict.tail, sse, "a healthy turn must flush byte-identical");
  });

  it("mid-word truncation after reasoning is retryable, not terminal", () => {
    const guard = new OpenAIStreamGuard({ holdEntireTurn: true });
    pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"thinking..."}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"partial answ"}}]}\n\n',
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "reject");
    assert.equal(verdict.reason, "mid_word_truncation");
    assert.equal(verdict.truncated, true);
  });

  it("tool-arg truncation after reasoning is retryable", () => {
    const guard = new OpenAIStreamGuard({ holdEntireTurn: true });
    pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"reasoning_content":"plan"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"bash","arguments":"{\\"cmd\\":\\"ls"}}]}}]}\n\n',
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "reject");
    assert.equal(verdict.reason, "truncated_tool_args");
  });

  it("basic mode is untouched: reasoning still releases the hold live", () => {
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}\n\n',
    ]);
    assert.ok(emitted.includes("reasoning_content"), "basic mode must stream live");
  });

  it("single-flag signature: the legacy holdToolCalls option no longer holds anything", () => {
    // The constructor now takes only holdEntireTurn. A caller still passing
    // the removed holdToolCalls option gets basic-mode behavior: a complete
    // tool call releases the hold live.
    const guard = new OpenAIStreamGuard({ holdToolCalls: true });
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"bash","arguments":"{}"}}]}}]}\n\n',
    ]);
    assert.ok(emitted.includes('"name":"bash"'), "without holdEntireTurn a complete tool call must release live");
  });

  it("rejects a truncated JSON data line even when later chunks terminate cleanly", () => {
    // Production: glm-5.3 cut a reasoning chunk mid-object (missing closing
    // braces). JSON.parse failed at the client (AI_JSONParseError) because
    // the guard treated the malformed line as a no-op ping and flushed it
    // verbatim once finish_reason / [DONE] arrived.
    const truncated =
      'data: {"choices":[{"delta":{"reasoning_content":" DNS","role":"assistant"},"index":0}],"created":1787675299,"id":"9fd0847c-f8a8-4b7a-b499-c8c8e95306ba","model":"glm-5.3","object":"chat.completion.chunk"\n\n';
    const guard = new OpenAIStreamGuard({ holdEntireTurn: true });
    const emitted = pump(guard, [
      truncated,
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.equal(emitted, "", "whole-turn hold must not emit until finish");
    const verdict = guard.finish();
    assert.equal(verdict.action, "reject");
    assert.equal(verdict.reason, "malformed_json_chunk");
    assert.equal(verdict.truncated, true);
    assert.equal((verdict.tail || "").includes("chat.completion.chunk"), false);
  });

  it("hasProvenContent: the upstream first token is observable while whole-turn hold keeps bytes withheld", () => {
    const guard = new OpenAIStreamGuard({ holdEntireTurn: true });
    assert.equal(guard.hasProvenContent(), false, "an empty stream proves nothing");
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
    ]);
    assert.equal(emitted, "", "whole-turn hold must not emit");
    assert.equal(guard.hasProvenContent(), true, "text must prove usability even when held");
  });

  it("hasProvenContent: a complete tool call (id + name) proves content under whole-turn hold", () => {
    const guard = new OpenAIStreamGuard({ holdEntireTurn: true });
    pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"bash","arguments":""}}]}}]}\n\n',
    ]);
    assert.equal(guard.hasProvenContent(), true, "a complete tool call must prove usability even when held");
  });
});
