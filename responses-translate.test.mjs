// Responses <-> Chat Completions translation tests. Pure state machines:
// no IO, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  translateResponsesRequest,
  translateChatResponse,
  ResponsesSseTranslator,
  responseIdFromChatId,
  chatUsageToResponsesUsage,
  splitLeadingThinkBlock,
} from "./responses-translate.mjs";
import { SSEParser } from "./stream.mjs";

// ---------- request side ----------

describe("translateResponsesRequest", () => {
  it("maps instructions to a leading system message and a string input to user", () => {
    const out = translateResponsesRequest({
      model: "gpt-x",
      instructions: "be brief",
      input: "hello",
    });
    assert.deepEqual(out.messages, [
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
    ]);
  });

  it("maps message items by role, folding developer/system into system", () => {
    const out = translateResponsesRequest({
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "dev rules" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "yo" }] },
      ],
    });
    assert.deepEqual(out.messages, [
      { role: "system", content: "dev rules" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]);
  });

  it("merges instructions and system items into one pinned system message", () => {
    const out = translateResponsesRequest({
      instructions: "top",
      input: [
        { type: "message", role: "system", content: "middle" },
        { type: "message", role: "user", content: "u1" },
        { type: "message", role: "developer", content: "tail" },
        { type: "message", role: "user", content: "u2" },
      ],
    });
    assert.deepEqual(out.messages, [
      { role: "system", content: "top\n\nmiddle\n\ntail" },
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
    ]);
  });

  it("aggregates consecutive function_call items into one assistant tool_calls message", () => {
    const out = translateResponsesRequest({
      input: [
        { type: "message", role: "user", content: "run it" },
        { type: "function_call", call_id: "call_1", name: "Bash", arguments: '{"command":"ls"}' },
        { type: "function_call", call_id: "call_2", name: "Read", arguments: { path: "a.txt" } },
        { type: "function_call_output", call_id: "call_1", output: "file list" },
        { type: "function_call_output", call_id: "call_2", output: "file body" },
      ],
    });
    assert.deepEqual(out.messages, [
      { role: "user", content: "run it" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "Calling the requested tool.",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
          { id: "call_2", type: "function", function: { name: "Read", arguments: '{"path":"a.txt"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file list" },
      { role: "tool", tool_call_id: "call_2", content: "file body" },
    ]);
  });

  it("attaches a reasoning item to the next assistant message as reasoning_content", () => {
    const out = translateResponsesRequest({
      input: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "thought A" }] },
        { type: "function_call", call_id: "call_1", name: "Bash", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "thought B" }] },
        { type: "message", role: "assistant", content: "done" },
      ],
    });
    assert.deepEqual(out.messages, [
      {
        role: "assistant",
        content: "",
        reasoning_content: "thought A",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "Bash", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
      { role: "assistant", content: "done", reasoning_content: "thought B" },
    ]);
  });

  it("degrades an orphan function_call_output to user text", () => {
    const out = translateResponsesRequest({
      input: [
        { type: "message", role: "user", content: "q" },
        { type: "function_call_output", call_id: "call_gone", output: "late result" },
      ],
    });
    assert.deepEqual(out.messages, [
      { role: "user", content: "q" },
      { role: "user", content: "Function call output (call_gone): late result" },
    ]);
  });

  it("degrades an unanswered mid-history function_call to assistant text, but exempts the tail call", () => {
    const out = translateResponsesRequest({
      input: [
        { type: "function_call", call_id: "call_old", name: "Bash", arguments: "{}" },
        { type: "message", role: "user", content: "never mind" },
        { type: "function_call", call_id: "call_new", name: "Read", arguments: "{}" },
      ],
    });
    assert.deepEqual(out.messages, [
      { role: "assistant", content: "Abandoned function call (call_old): Bash" },
      { role: "user", content: "never mind" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "Calling the requested tool.",
        tool_calls: [{ id: "call_new", type: "function", function: { name: "Read", arguments: "{}" } }],
      },
    ]);
  });

  it("proxies custom_tool_call history as a generic function with an {\"input\": ...} argument", () => {
    const out = translateResponsesRequest({
      input: [
        { type: "custom_tool_call", call_id: "call_9", name: "apply_patch", input: "*** Begin Patch\n..." },
        { type: "custom_tool_call_output", call_id: "call_9", output: "patched" },
      ],
    });
    assert.deepEqual(out.messages, [
      {
        role: "assistant",
        content: "",
        reasoning_content: "Calling the requested tool.",
        tool_calls: [
          { id: "call_9", type: "function", function: { name: "apply_patch", arguments: '{"input":"*** Begin Patch\\n..."}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_9", content: "patched" },
    ]);
  });

  it("normalizes non-object arguments strings into an {\"input\": ...} wrapper", () => {
    const out = translateResponsesRequest({
      input: [{ type: "function_call", call_id: "c1", name: "f", arguments: "not json" }],
    });
    assert.equal(out.messages[0].tool_calls[0].function.arguments, '{"input":"not json"}');
  });

  it("maps function tools with a parameters skeleton and inlines local $refs with siblings", () => {
    const out = translateResponsesRequest({
      tools: [
        { type: "function", name: "Bash", description: "run", parameters: { properties: { command: { type: "string" } }, required: ["command"] } },
        {
          type: "function",
          name: "Read",
          parameters: {
            $defs: { Path: { type: "object", properties: { p: { type: "string" } } } },
            properties: { target: { $ref: "#/$defs/Path", description: "the file" } },
          },
        },
      ],
    });
    assert.deepEqual(out.tools[0], {
      type: "function",
      function: {
        name: "Bash",
        description: "run",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    });
    assert.deepEqual(out.tools[1].function.parameters.properties.target, {
      type: "object",
      properties: { p: { type: "string" } },
      description: "the file",
    });
  });

  it("proxies custom tools as generic functions and leaves a bare $ref untouched", () => {
    const out = translateResponsesRequest({
      tools: [
        { type: "custom", name: "apply_patch", description: "edit files" },
        { type: "function", name: "Aliased", parameters: { $ref: "#/$defs/Whole" } },
      ],
    });
    assert.equal(out.tools[0].function.name, "apply_patch");
    assert.deepEqual(Object.keys(out.tools[0].function.parameters.properties), ["input"]);
    assert.deepEqual(out.tools[0].function.parameters.required, ["input"]);
    assert.deepEqual(out.tools[1].function.parameters, { $ref: "#/$defs/Whole" });
  });

  it("converts tool_choice and only emits it when tools are present", () => {
    const withTools = translateResponsesRequest({
      tools: [{ type: "function", name: "Bash", parameters: {} }],
      tool_choice: { type: "function", name: "Bash" },
      parallel_tool_calls: false,
    });
    assert.deepEqual(withTools.tool_choice, { type: "function", function: { name: "Bash" } });
    assert.equal(withTools.parallel_tool_calls, false);

    const withoutTools = translateResponsesRequest({ tool_choice: { type: "function", name: "Bash" } });
    assert.equal("tool_choice" in withoutTools, false);

    const auto = translateResponsesRequest({
      tools: [{ type: "function", name: "Bash", parameters: {} }],
      tool_choice: "auto",
    });
    assert.equal(auto.tool_choice, "auto");
  });

  it("maps max_output_tokens to max_tokens and passes the scalar whitelist through", () => {
    const out = translateResponsesRequest({
      max_output_tokens: 1024,
      temperature: 0.2,
      top_p: 0.9,
      stop: ["\n"],
      seed: 7,
      response_format: { type: "json_object" },
      store: false,
      include: ["reasoning.encrypted_content"],
    });
    assert.equal(out.max_tokens, 1024);
    assert.equal(out.temperature, 0.2);
    assert.equal(out.top_p, 0.9);
    assert.deepEqual(out.stop, ["\n"]);
    assert.equal(out.seed, 7);
    assert.deepEqual(out.response_format, { type: "json_object" });
    assert.equal("store" in out, false, "store is a Responses-only field");
    assert.equal("include" in out, false);
  });

  it("forces stream_options.include_usage on a streaming request", () => {
    const out = translateResponsesRequest({ stream: true, stream_options: { chunk_size: 4 } });
    assert.deepEqual(out.stream_options, { chunk_size: 4, include_usage: true });
    const noStream = translateResponsesRequest({ stream: false });
    assert.equal("stream_options" in noStream, false);
  });

  it("folds codex reasoning.effort into reasoning_effort on the library vocabulary", () => {
    assert.equal(translateResponsesRequest({ reasoning: { effort: "high" } }).reasoning_effort, "high");
    assert.equal(translateResponsesRequest({ reasoning: { effort: "none" } }).reasoning_effort, "off");
    assert.equal(translateResponsesRequest({ reasoning: { effort: "ultra" } }).reasoning_effort, "max");
    assert.equal(translateResponsesRequest({ reasoning: { effort: "persistent" } }).reasoning_effort, "max");
    assert.equal("reasoning" in translateResponsesRequest({ reasoning: { effort: "high", summary: "auto" } }), false);
  });
});

// ---------- response side ----------

const chatJson = (message, extra = {}) => ({
  id: "chatcmpl-123",
  created: 1720000000,
  model: "gpt-x",
  choices: [{ index: 0, message, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  ...extra,
});

describe("translateChatResponse", () => {
  it("builds the top-level response shape with resp_ id and prefixed item ids", () => {
    const out = translateChatResponse(chatJson({ role: "assistant", content: "hi" }));
    assert.equal(out.id, "resp_chatcmpl-123");
    assert.equal(out.object, "response");
    assert.equal(out.created_at, 1720000000);
    assert.equal(out.status, "completed");
    assert.equal(out.model, "gpt-x");
    assert.equal(out.output.length, 1);
    assert.equal(out.output[0].type, "message");
    assert.ok(out.output[0].id.startsWith("msg_"), `message id needs the msg_ prefix, got ${out.output[0].id}`);
    assert.deepEqual(out.output[0].content, [{ type: "output_text", text: "hi", annotations: [] }]);
    assert.deepEqual(out.usage.output_tokens_details, { reasoning_tokens: 0 });
  });

  it("keeps an already-prefixed resp_ id", () => {
    assert.equal(responseIdFromChatId("resp_abc"), "resp_abc");
    assert.equal(responseIdFromChatId("chatcmpl-1"), "resp_chatcmpl-1");
    assert.equal(responseIdFromChatId(undefined), "resp_compat");
  });

  it("orders output reasoning -> message -> function_call", () => {
    const out = translateChatResponse(
      chatJson({
        role: "assistant",
        reasoning_content: "hmm",
        content: "answer",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } }],
      }),
    );
    assert.deepEqual(out.output.map((item) => item.type), ["reasoning", "message", "function_call"]);
    assert.ok(out.output[0].id.startsWith("rs_"));
    assert.equal(out.output[0].summary[0].text, "hmm");
    assert.ok(out.output[2].id.startsWith("fc_"));
    assert.equal(out.output[2].call_id, "call_1");
    assert.equal(out.output[2].arguments, '{"command":"ls"}');
  });

  it("maps finish_reason length to incomplete plus incomplete_details", () => {
    const out = translateChatResponse(chatJson({ role: "assistant", content: "cut" }));
    assert.equal(out.status, "completed");
    const incomplete = translateChatResponse({
      ...chatJson({ role: "assistant", content: "cut" }),
      choices: [{ index: 0, message: { role: "assistant", content: "cut" }, finish_reason: "length" }],
    });
    assert.equal(incomplete.status, "incomplete");
    assert.deepEqual(incomplete.incomplete_details, { reason: "max_output_tokens" });
  });

  it("completes usage in all three forms: details present, key missing, usage missing", () => {
    const withDetails = chatUsageToResponsesUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      completion_tokens_details: { reasoning_tokens: 3, accepted_prediction_tokens: 5 },
    });
    assert.deepEqual(withDetails.output_tokens_details, { reasoning_tokens: 3, accepted_prediction_tokens: 5 });

    const missingKey = chatUsageToResponsesUsage({ prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: {} });
    assert.deepEqual(missingKey.output_tokens_details, { reasoning_tokens: 0 });

    const missingAll = chatUsageToResponsesUsage(undefined);
    assert.deepEqual(missingAll, {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });

  it("subtracts cached tokens counted inside prompt_tokens", () => {
    const usage = chatUsageToResponsesUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 30 },
    });
    assert.equal(usage.input_tokens, 70);
    assert.equal(usage.total_tokens, 120);
    assert.deepEqual(usage.input_tokens_details, { cached_tokens: 30 });
  });

  it("strips a leading <think> block out of string content into the reasoning item", () => {
    const out = translateChatResponse(chatJson({ role: "assistant", content: "<think>plan first</think>\n\nanswer" }));
    assert.deepEqual(out.output.map((item) => item.type), ["reasoning", "message"]);
    assert.equal(out.output[0].reasoning_content, "plan first");
    assert.equal(out.output[1].content[0].text, "answer");
  });

  it("splitLeadingThinkBlock only fires on a leading closed block", () => {
    assert.deepEqual(splitLeadingThinkBlock("  <think>r</think> a"), { reasoning: "r", answer: "a" });
    assert.equal(splitLeadingThinkBlock("text <think>r</think>"), null);
    assert.equal(splitLeadingThinkBlock("<think>unterminated"), null);
  });

  it("reconstructs a custom tool call back into a custom_tool_call item with ctc_ id", () => {
    const request = { tools: [{ type: "custom", name: "apply_patch" }] };
    const out = translateChatResponse(
      chatJson({
        role: "assistant",
        tool_calls: [{ id: "call_9", type: "function", function: { name: "apply_patch", arguments: '{"input":"*** Begin Patch"}' } }],
      }),
      { request },
    );
    assert.deepEqual(out.output.map((item) => item.type), ["custom_tool_call"]);
    assert.ok(out.output[0].id.startsWith("ctc_"));
    assert.equal(out.output[0].input, "*** Begin Patch");
  });

  it("echoes the request fields codex expects back", () => {
    const request = {
      instructions: "be brief",
      tools: [{ type: "function", name: "Bash", parameters: {} }],
      tool_choice: "auto",
      reasoning: { effort: "high", summary: "auto" },
      temperature: 0.2,
      max_output_tokens: 512,
    };
    const out = translateChatResponse(chatJson({ role: "assistant", content: "hi" }), request);
    assert.equal(out.instructions, "be brief");
    assert.deepEqual(out.tools, request.tools);
    assert.equal(out.tool_choice, "auto");
    assert.deepEqual(out.reasoning, { effort: "high", summary: "auto" });
    assert.equal(out.temperature, 0.2);
    assert.equal(out.max_output_tokens, 512);
  });

  it("throws on a chat body without a message", () => {
    assert.throws(() => translateChatResponse({ choices: [] }), /missing choices/);
  });
});

// ---------- streaming: ResponsesSseTranslator ----------

// Feed a raw chat SSE byte stream through the parser + translator and return
// the emitted frames as [{ event, data }] pairs; a bare [DONE] frame parses
// as { event: "[DONE]", data: null }.
function translateStream(sseText, ctx) {
  const parser = new SSEParser();
  const translator = new ResponsesSseTranslator(ctx);
  let out = "";
  for (const payload of parser.push(sseText)) out += translator.chunk(payload);
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
    const data = dataLine ? dataLine.slice(6) : null;
    events.push({ event: event ?? (data === "[DONE]" ? "[DONE]" : undefined), data: data && data !== "[DONE]" ? JSON.parse(data) : null });
  }
  return events;
}

const sseChunk = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const chunkDelta = (d, extra = {}) => ({ id: "chatcmpl-9", created: 1720000000, model: "gpt-x", choices: [{ index: 0, delta: d, ...extra }] });

describe("ResponsesSseTranslator", () => {
  it("translates a plain text stream into the full ordered event sequence ending in [DONE]", () => {
    const events = translateStream(
      sseChunk(chunkDelta({ role: "assistant" }))
        + sseChunk(chunkDelta({ content: "你" }))
        + sseChunk(chunkDelta({ content: "好" }))
        + sseChunk({ ...chunkDelta({}, { finish_reason: "stop" }), usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })
        + "data: [DONE]\n\n",
      { model: "gpt-x" },
    );
    assert.deepEqual(events.map((e) => e.event), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
      "[DONE]",
    ]);
    const added = events[2];
    assert.equal(added.data.item.type, "message");
    assert.ok(added.data.item.id.startsWith("msg_"), `message item id needs msg_ prefix, got ${added.data.item.id}`);
    assert.equal(added.data.item.status, "in_progress");

    const completed = events.find((e) => e.event === "response.completed");
    assert.equal(completed.data.response.status, "completed");
    assert.equal(completed.data.response.id, "resp_chatcmpl-9");
    assert.deepEqual(completed.data.response.output, [
      {
        id: added.data.item.id,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "你好", annotations: [] }],
      },
    ]);
    // usage rides only the completed frame, with reasoning_tokens guaranteed.
    assert.deepEqual(completed.data.response.usage, {
      input_tokens: 5,
      output_tokens: 2,
      total_tokens: 7,
      output_tokens_details: { reasoning_tokens: 0 },
    });
    const created = events[0];
    assert.deepEqual(created.data.response.usage, {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
    });
    assert.equal(events[10].data, null, "[DONE] is a literal line, not JSON");
  });

  it("emits the reasoning group before the text group", () => {
    const events = translateStream(
      sseChunk(chunkDelta({ reasoning_content: "想" }))
        + sseChunk(chunkDelta({ reasoning_content: "想" }))
        + sseChunk(chunkDelta({ content: "答" }))
        + sseChunk(chunkDelta({}, { finish_reason: "stop" })),
    );
    assert.deepEqual(events.map((e) => e.event), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
      "[DONE]",
    ]);
    assert.ok(events[2].data.item.id.startsWith("rs_"));
    const reasoningDone = events[8];
    assert.equal(reasoningDone.data.item.reasoning_content, "想想");
    assert.deepEqual(reasoningDone.data.item.summary, [{ type: "summary_text", text: "想想" }]);
    const completed = events.find((e) => e.event === "response.completed");
    assert.deepEqual(completed.data.response.output.map((item) => item.type), ["reasoning", "message"]);
  });

  it("aggregates streamed tool_call fragments by chat index into one function_call item", () => {
    const events = translateStream(
      sseChunk(chunkDelta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "Bash", arguments: "" } }] }))
        + sseChunk(chunkDelta({ tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] }))
        + sseChunk(chunkDelta({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }))
        + sseChunk(chunkDelta({ tool_calls: [{ index: 1, id: "call_2", function: { name: "Read", arguments: '{"path":"a"}' } }] }))
        + sseChunk(chunkDelta({}, { finish_reason: "tool_calls" })),
    );
    assert.deepEqual(events.map((e) => e.event), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
      "[DONE]",
    ]);
    assert.ok(events[2].data.item.id.startsWith("fc_"));
    assert.equal(events[2].data.item.arguments, "");
    assert.equal(events[3].data.delta, '{"command":');
    assert.equal(events[7].data.arguments, '{"command":"ls"}');
    const completed = events.find((e) => e.event === "response.completed");
    assert.deepEqual(completed.data.response.output.map((item) => [item.type, item.call_id]), [
      ["function_call", "call_1"],
      ["function_call", "call_2"],
    ]);
  });

  it("strips a streamed leading <think> block into reasoning, buffering the undecided prefix", () => {
    const events = translateStream(
      sseChunk(chunkDelta({ content: "<thi" }))
        + sseChunk(chunkDelta({ content: "nk>plan</think>" }))
        + sseChunk(chunkDelta({ content: "answer" }))
        + sseChunk(chunkDelta({}, { finish_reason: "stop" })),
    );
    const kinds = events.map((e) => e.event);
    assert.ok(kinds.indexOf("response.reasoning_summary_text.delta") < kinds.indexOf("response.output_text.delta"));
    const reasoningDelta = events.find((e) => e.event === "response.reasoning_summary_text.delta");
    assert.equal(reasoningDelta.data.delta, "plan");
    const textDeltas = events.filter((e) => e.event === "response.output_text.delta").map((e) => e.data.delta).join("");
    assert.equal(textDeltas, "answer");
  });

  it("flushes undecided buffered text as text when the stream ends mid-prefix", () => {
    const events = translateStream(
      sseChunk(chunkDelta({ content: "<th" }))
        + sseChunk(chunkDelta({}, { finish_reason: "stop" })),
    );
    const textDeltas = events.filter((e) => e.event === "response.output_text.delta").map((e) => e.data.delta).join("");
    assert.equal(textDeltas, "<th");
  });

  it("routes a custom tool stream to a ctc_ custom_tool_call item, input reconstructed at done", () => {
    const events = translateStream(
      sseChunk(chunkDelta({ tool_calls: [{ index: 0, id: "call_9", function: { name: "apply_patch", arguments: '{"input":"*** Begin Patch"}' } }] }))
        + sseChunk(chunkDelta({}, { finish_reason: "tool_calls" })),
      { tools: [{ type: "custom", name: "apply_patch" }] },
    );
    const added = events.find((e) => e.event === "response.output_item.added");
    assert.equal(added.data.item.type, "custom_tool_call");
    assert.ok(added.data.item.id.startsWith("ctc_"));
    assert.equal(events.some((e) => e.event === "response.function_call_arguments.delta"), false, "custom input holds until done");
    const inputDelta = events.find((e) => e.event === "response.custom_tool_call_input.delta");
    assert.equal(inputDelta.data.delta, "*** Begin Patch");
    const completed = events.find((e) => e.event === "response.completed");
    assert.equal(completed.data.response.output[0].type, "custom_tool_call");
    assert.equal(completed.data.response.output[0].input, "*** Begin Patch");
  });

  it("ends on response.failed without [DONE] when an upstream error frame arrives", () => {
    const events = translateStream(
      sseChunk(chunkDelta({ content: "partial" }))
        + sseChunk({ error: { message: "upstream blew up", type: "server_error" } }),
    );
    assert.deepEqual(events.map((e) => e.event), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.failed",
    ]);
    const failed = events[5];
    assert.equal(failed.data.response.status, "failed");
    assert.deepEqual(failed.data.response.error, { message: "upstream blew up", type: "server_error" });
    // finish() after a failure is a no-op: no completed, no [DONE].
  });

  it("finish() on an empty stream still emits created/in_progress/completed/[DONE]", () => {
    const events = translateStream("");
    assert.deepEqual(events.map((e) => e.event), ["response.created", "response.in_progress", "response.completed", "[DONE]"]);
    assert.equal(events[2].data.response.id, "resp_compat");
  });

  it("finish_reason length streams out as status incomplete", () => {
    const events = translateStream(sseChunk(chunkDelta({ content: "cut" })) + sseChunk(chunkDelta({}, { finish_reason: "length" })));
    const completed = events.find((e) => e.event === "response.completed");
    assert.equal(completed.data.response.status, "incomplete");
    assert.deepEqual(completed.data.response.incomplete_details, { reason: "max_output_tokens" });
  });

  it("echoes request fields onto the completed response", () => {
    const events = translateStream(sseChunk(chunkDelta({ content: "hi" })), {
      instructions: "be brief",
      reasoning: { effort: "high" },
      tools: [{ type: "function", name: "Bash", parameters: {} }],
    });
    const completed = events.find((e) => e.event === "response.completed");
    assert.equal(completed.data.response.instructions, "be brief");
    assert.deepEqual(completed.data.response.reasoning, { effort: "high" });
    assert.deepEqual(completed.data.response.tools, [{ type: "function", name: "Bash", parameters: {} }]);
  });
});
