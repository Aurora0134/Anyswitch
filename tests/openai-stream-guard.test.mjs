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
import { OpenAIStreamGuard } from "../src/relay/openai-stream-guard.mjs";

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

  it("a late-arriving tool name releases the stream once the call is complete", () => {
    // A call proves the stream usable only at id + name. Until then the
    // pre-content hold keeps its bytes; once complete, the whole call is
    // released as one frame (per-call hold), so the client never sees a
    // half-formed call.
    const guard = new OpenAIStreamGuard();
    const before = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a"}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n',
    ]);
    assert.equal(before, "", "an id-only tool call is not yet proof of a usable stream");

    const after = guard.chunk(
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"read"}}]}}]}\n\n',
    );
    assert.ok(after.includes('"id":"call_a"'), "a complete call is released");
    assert.ok(after.includes('"name":"read"'));

    const verdict = guard.finish();
    assert.equal(guard.finish().action, "error");
    assert.equal(verdict.reason, "mid_word_truncation", "no terminator ever arrived");
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
    // A bare `data:` line (or any non-JSON payload) must not disarm the guard:
    // if it did, a truncated stream would pass as a normal completion and the
    // keep-alive retry would never fire. It proves nothing and stays held.
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
    // flush and abort on exactly this. The complete call is already on the
    // wire (per-call hold releases it whole), so the verdict is a terminal
    // error, never a silent completion.
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"TodoWrite","arguments":""}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"x\\":"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.ok(emitted.includes('"name":"TodoWrite"'), "the complete call reaches the client");

    const verdict = guard.finish();
    assert.equal(verdict.action, "error", "the orphaned fragment must not pass as a completion");
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

    // The turn thought but never answered and never called a tool: the
    // reasoning was released, yet the agent has nothing to act on. That is
    // the think-only verdict, not a clean completion (see the think-only
    // suite below).
    const verdict = guard.finish();
    assert.equal(verdict.action, "error");
    assert.equal(verdict.reason, "think_only_incomplete");
  });

  it("passes a reasoning-then-answer turn (reasoning alone never makes a turn incomplete)", () => {
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"the answer"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.ok(emitted.includes("the answer"));

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
    // No terminator, no error — classifying this as "pass" would let the client
    // treat partial output as a complete response.
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"Here is some partial out"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"put that got cut mid-"}}]}\n\n',
    ]);
    assert.ok(emitted.includes("partial out"), "content is already delivered and must survive");

    const verdict = guard.finish();
    assert.equal(verdict.action, "error");
    assert.equal(verdict.truncated, true);
    assert.match(verdict.error.error.message, /中断|截断|truncat/i);
    assert.equal(verdict.error.error.code, 502, "the cut carries the upstream-incomplete code");
    assert.match(verdict.errorLine, /^data: \{"error":/, "the cut ends in a structured error event, not a terminator line");
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
    // so it never parses. The call never completed, so its bytes stayed with
    // the per-call hold — the client saw no broken call, only a turn that
    // ended in a truncation verdict.
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"bash","arguments":"{\\"comma"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"nd\\":\\"ls -"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.equal(emitted.includes("bash"), false, "an unparseable call is withheld to the end");
    assert.equal(emitted.includes("{\"comma"), false, "no argument fragment leaks");

    const verdict = guard.finish();
    assert.equal(verdict.action, "error", "the incomplete call never reached the client");
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

  it("flags a complete tool call that ends with no terminator (mid-turn cut)", () => {
    // The tool call parses but [DONE] and finish_reason never arrived:
    // anything after the last delta may have been lost. The call itself was
    // forwarded whole, so this is a post-content truncation verdict.
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"bash","arguments":"{}"}}]}}]}\n\n',
    ]);
    assert.ok(emitted.includes('"name":"bash"'), "the complete call was released");
    const verdict = guard.finish();
    assert.equal(verdict.action, "error");
    assert.equal(verdict.reason, "mid_word_truncation");
    assert.equal(verdict.truncated, true);
  });

  it("multi-chunk tool arguments that assemble into valid JSON pass cleanly", () => {
    const guard = new OpenAIStreamGuard();
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
    const guard = new OpenAIStreamGuard();
    pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"ping","arguments":""}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
  });

  it("per-call hold keeps an open tool call until its arguments parse; truncation still errors", () => {
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"bash","arguments":"{\\"c\\":"}}]}}]}\n\n',
    ]);
    // The call's args do not parse yet, so the frame is withheld — the
    // client never sees a call's deltas one at a time.
    assert.ok(!emitted.includes('"name":"bash"'), "an open tool call is withheld until it closes");
    const verdict = guard.finish();
    assert.equal(verdict.action, "error");
    assert.equal(verdict.truncated, true);
  });
});

describe("malformed JSON chunk", () => {
  it("rejects a truncated JSON data line even when later chunks terminate cleanly", () => {
    // Production: glm-5.3 cut a reasoning chunk mid-object (missing closing
    // braces). JSON.parse failed at the client (AI_JSONParseError) because
    // the guard treated the malformed line as a no-op ping and flushed it
    // verbatim once finish_reason / [DONE] arrived. The line is now dropped on
    // sight; the turn still ends as a truncation, never as a clean completion.
    const truncated =
      'data: {"choices":[{"delta":{"reasoning_content":" DNS","role":"assistant"},"index":0}],"created":1787675299,"id":"9fd0847c-f8a8-4b7a-b499-c8c8e95306ba","model":"glm-5.3","object":"chat.completion.chunk"\n\n';
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      truncated,
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.equal(emitted.includes("chat.completion.chunk"), false, "the malformed line never reaches the client");
    assert.ok(emitted.includes("hello"), "clean lines around it still flow");
    const verdict = guard.finish();
    assert.equal(verdict.action, "error");
    assert.equal(verdict.reason, "malformed_json_chunk");
    assert.equal(verdict.truncated, true);
    assert.equal(JSON.stringify(verdict).includes("chat.completion.chunk"), false, "the malformed line's bytes must not appear anywhere in the verdict, especially not as a flushable tail");
  });
});

describe("tool-call delta normalization (upstream repeats empty strings on continuation frames)", () => {
  function parseFrames(text) {
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      out.push(JSON.parse(payload));
    }
    return out;
  }

  it("strips empty-string id/type/name from continuation frames so overwrite-merging clients keep the real values", () => {
    // Wire shape observed against a live stepfun streaming response: the first
    // tool-call delta carries the real id/type/name, every continuation delta
    // repeats them as empty strings. Canonical streams omit those keys instead.
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-abc","type":"function","function":{"name":"list_directory","arguments":"{"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"","type":"","function":{"name":"","arguments":"\\"target_directory\\": \\"/tmp/x\\""}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"","type":"","function":{"name":"","arguments":"}"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
    const out = emitted + (verdict.tail || "");
    assert.ok(out.includes('"id":"chatcmpl-tool-abc"'), "the first frame's real id must survive");
    assert.ok(out.includes('"name":"list_directory"'), "the first frame's real name must survive");
    assert.ok(!out.includes('"id":""'), "empty-string id must not reach the client");
    assert.ok(!out.includes('"name":""'));
    assert.ok(!out.includes('"type":""'));
    for (const frame of parseFrames(out)) {
      for (const choice of frame.choices ?? []) {
        for (const call of choice?.delta?.tool_calls ?? []) {
          assert.notEqual(call.id, "");
          assert.notEqual(call.type, "");
          assert.notEqual(call.function?.name, "");
        }
      }
    }
    // the non-tool-call frames must pass through untouched
    assert.ok(out.includes('"finish_reason":"tool_calls"'));
    assert.ok(out.includes("[DONE]"));
  });

  it("treats a tool call that only ever carries empty-string id/name as incomplete (reject while holding)", () => {
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"","type":"","function":{"name":"","arguments":"{}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.equal(emitted, "", "an unusable tool call must not be forwarded as a completion");
    const verdict = guard.finish();
    assert.equal(verdict.action, "reject");
    assert.equal(verdict.reason, "incomplete_tool_call");
  });

  it("a nameless empty-string tool call after delivered text terminates with the structured error instead of [DONE]", () => {
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"Let me check."}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"","function":{"name":"","arguments":"{}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    assert.ok(emitted.includes("Let me check."), "already-delivered text must survive");
    const verdict = guard.finish();
    assert.equal(verdict.action, "error");
    assert.equal((emitted + verdict.errorLine).includes("[DONE]"), false);
  });

  it("does not rewrite frames that already use the canonical shape", () => {
    const sse = [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"bash","arguments":"{\\"c\\":"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [sse]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
    // The per-call hold releases a completed call's withheld bytes verbatim
    // in one go, so the concatenated output is the canonical stream — just
    // not in the same chunk order the upstream produced it in. Compare
    // frame payloads, not raw bytes.
    const framePayloads = (text) =>
      text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((payload) => payload && payload !== "[DONE]")
        .map((payload) => JSON.stringify(JSON.parse(payload)));
    const expected = framePayloads(sse);
    const actual = framePayloads(emitted + (verdict.tail || ""));
    assert.deepEqual(
      actual.sort(),
      expected.sort(),
      "canonical streams must produce the same frames (order may differ under per-call hold)",
    );
  });
});

describe("chunk-envelope repair (opt-in, grok's strict ChatCompletionChunk struct)", () => {
  // The exact wire shape a live deepseek-channel stream produced: choices + object
  // only, no id/created/model. grok aborts the whole turn on the first such
  // chunk (is_retryable=false), while every other client reads it fine.
  const capturedFrames = [
    'data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null,"index":0}],"object":"chat.completion.chunk"}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"The user"},"finish_reason":null,"index":0}],"object":"chat.completion.chunk"}\n\n',
    'data: {"choices":[{"delta":{"content":"hello"},"index":0}],"object":"chat.completion.chunk"}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"object":"chat.completion.chunk"}\n\n',
    "data: [DONE]\n\n",
  ];

  function frames(text) {
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim();
      if (!p || p === "[DONE]") continue;
      out.push(JSON.parse(p));
    }
    return out;
  }

  const on = () => new OpenAIStreamGuard({ fillChunkEnvelope: { model: "deepseek-v4.1-flash" } });

  it("fills id/created/model on every data chunk when enabled", () => {
    const guard = on();
    const emitted = pump(guard, capturedFrames);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
    const parsed = frames(emitted + (verdict.tail || ""));
    assert.equal(parsed.length, 4);
    for (const f of parsed) {
      assert.equal(typeof f.id, "string");
      assert.ok(f.id.length > 0, "id must be non-empty");
      assert.equal(typeof f.created, "number");
      assert.equal(typeof f.model, "string");
      assert.ok(f.model.length > 0, "model must be non-empty");
    }
    // the synthesized id is stable for the whole turn
    assert.equal(new Set(parsed.map((f) => f.id)).size, 1);
  });

  it("leaves the stream byte-identical when the repair is off (every non-grok client)", () => {
    const sse = capturedFrames.join("");
    const guard = new OpenAIStreamGuard();
    const emitted = pump(guard, [sse]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
    assert.equal(emitted + (verdict.tail || ""), sse);
  });

  it("echoes the first real value instead of the synthesized fallback when upstream supplies one", () => {
    const guard = on();
    const emitted = pump(guard, [
      'data: {"id":"real-id-1","created":123,"model":"real-model","choices":[{"delta":{"content":"hi"},"index":0}]}\n\n',
      // continuation omits all three: must inherit the first real values
      'data: {"choices":[{"delta":{"content":" there"},"index":0}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
    const parsed = frames(emitted + (verdict.tail || ""));
    assert.equal(parsed.length, 2);
    for (const f of parsed) {
      assert.equal(f.id, "real-id-1");
      assert.equal(f.created, 123);
      assert.equal(f.model, "real-model");
    }
  });

  it("treats an empty-string id/created/model as a gap and fills it", () => {
    const guard = on();
    const emitted = pump(guard, [
      'data: {"id":"","model":"","choices":[{"delta":{"content":"hi"},"index":0}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
    const [f] = frames(emitted + (verdict.tail || ""));
    assert.ok(f.id.length > 0, "empty-string id must be replaced");
    assert.ok(f.model.length > 0, "empty-string model must be replaced");
    assert.equal(typeof f.created, "number");
  });

  it("repairs the whole stream, including the frames the guards hold back", () => {
    const guard = new OpenAIStreamGuard({ fillChunkEnvelope: { model: "m" } });
    const emitted = pump(guard, capturedFrames);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
    const parsed = frames(emitted + (verdict.tail || ""));
    assert.equal(parsed.length, 4);
    for (const f of parsed) assert.ok(f.id.length > 0 && f.model.length > 0 && typeof f.created === "number");
  });

  it("repairs tool-call chunks as well, without disturbing the tool payload", () => {
    const guard = on();
    const emitted = pump(guard, [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"bash","arguments":"{}"}}]},"index":0}],"object":"chat.completion.chunk"}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}],"object":"chat.completion.chunk"}\n\n',
      "data: [DONE]\n\n",
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
    const parsed = frames(emitted + (verdict.tail || ""));
    const call = parsed[0].choices[0].delta.tool_calls[0];
    assert.equal(call.id, "call_a");
    assert.equal(call.function.name, "bash");
    for (const f of parsed) assert.ok(f.id.length > 0 && typeof f.created === "number");
  });

  it("falls back to \"unknown\" rather than a null model when neither the stream nor the request names one", () => {
    const guard = new OpenAIStreamGuard({ fillChunkEnvelope: { model: "" } });
    const emitted = pump(guard, capturedFrames);
    const verdict = guard.finish();
    const [f] = frames(emitted + (verdict.tail || ""));
    assert.equal(f.model, "unknown");
  });
});

// The think-only verdict and the numeric error code.
//
// A turn that carries reasoning but neither answer text nor a tool call
// terminates cleanly and looks healthy to every other check — yet for the
// agent loop it delivers nothing to act on. kimi-cli classifies the same
// shape as an incomplete response and retries it (1.31.0).
//
// Every incomplete-upstream verdict carries the numeric code 502 so
// downstream agents that auto-retry on a status code can recognise it
// instead of aborting the turn on an uncoded error.
describe("think-only turn and the 502 error code", () => {
  it("rejects a held think-only turn as incomplete", () => {
    const guard = new OpenAIStreamGuard();
    pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"reasoning_content":"let me think"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    // Reasoning releases the hold (the bytes were forwarded), so the verdict
    // lands in the post-content path: the turn ends with an error frame
    // rather than a terminator.
    const verdict = guard.finish();
    assert.equal(verdict.action, "error");
    assert.equal(verdict.reason, "think_only_incomplete");
    assert.equal(verdict.truncated, true);
    assert.equal(verdict.error.error.code, 502);
  });

  it("rejects a think-only turn whose terminator is [DONE] alone", () => {
    const guard = new OpenAIStreamGuard();
    pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"thinking":"pondering"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.reason, "think_only_incomplete");
  });

  it("does not flag a turn cut by the token budget (finish_reason length)", () => {
    // A budget stop is a different fault class: the Responses translator
    // reports it as an "incomplete" response and codex reads that as a
    // normal completion. Flagging it here would turn it into a retry.
    const guard = new OpenAIStreamGuard();
    pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
  });

  it("does not flag a turn that thought and then called a tool", () => {
    const guard = new OpenAIStreamGuard();
    pump(guard, [
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"ls","arguments":"{}"}}]}}]}\n\n',
      'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const verdict = guard.finish();
    assert.equal(verdict.action, "pass");
  });

  it("carries the 502 code on every post-content truncation verdict", () => {
    const cases = [
      {
        name: "mid-word truncation",
        parts: [
          'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
        ],
      },
      {
        name: "truncated tool args",
        parts: [
          'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"ls","arguments":"{\\"x\\":"}}]}}]}\n\n',
          'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        ],
      },
    ];
    for (const { name, parts } of cases) {
      const guard = new OpenAIStreamGuard();
      pump(guard, parts);
      const verdict = guard.finish();
      assert.equal(verdict.action, "error", name);
      assert.equal(verdict.error.error.code, 502, `${name} must carry the 502 code`);
      const parsed = JSON.parse(verdict.errorLine.slice("data: ".length));
      assert.equal(parsed.error.code, 502, `${name} error line must carry the 502 code`);
      assert.equal(parsed.error.type, "api_error", `${name} must keep the api_error type`);
      assert.ok(parsed.error.message.length > 0, `${name} must keep a readable message`);
    }
  });
});
