// OpenAI SSE chat.completion.chunk -> Anthropic Messages SSE event translation.
// Pure state machine. No IO, no network.
//
// Claude Code sends `stream: true`, so a non-streaming-only relay would not be
// usable in practice. The Anthropic event order this emits is:
//
//   message_start
//   (content_block_start / content_block_delta* / content_block_stop)*
//   message_delta   (carries stop_reason + output token usage)
//   message_stop
//
// Text and tool_use blocks are indexed in first-seen order. Tool argument JSON
// arrives as input_json_delta fragments, matching Anthropic's own wire shape.

const STOP_REASON = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "end_turn",
};

export function sseEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Upstream field names that carry reasoning, in the order they are checked.
// openai-stream-guard.mjs imports this same table so the guard's "is this
// stream healthy" check and the translator's "what do I forward" check can
// never disagree about which fields count as thinking.
export const REASONING_FIELDS = ["reasoning_content", "reasoning", "thought", "thinking"];

// The first non-empty reasoning string on a delta, or null.
function reasoningText(delta) {
  for (const field of REASONING_FIELDS) {
    const value = delta?.[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export class StreamTranslator {
  constructor(wireId) {
    this.wireId = wireId;
    this.started = false;
    this.nextIndex = 0;
    this.textIndex = null;
    this.thinkingIndex = null;
    // openai tool_call index -> { index, started }
    this.toolBlocks = new Map();
    this.stopReason = "end_turn";
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.finished = false;
  }

  // Emitted once, lazily, so upstream usage/id is available if it arrived.
  start(chunk) {
    if (this.started) return "";
    this.started = true;
    return sseEvent("message_start", {
      type: "message_start",
      message: {
        id: chunk?.id ?? "msg_relay",
        type: "message",
        role: "assistant",
        model: this.wireId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: this.usage,
      },
    });
  }

  // Translate one parsed OpenAI chunk into zero or more Anthropic SSE events.
  chunk(parsed) {
    let out = this.start(parsed);

    const usage = parsed?.usage;
    if (usage) {
      this.usage = {
        input_tokens: usage.prompt_tokens ?? this.usage.input_tokens,
        output_tokens: usage.completion_tokens ?? this.usage.output_tokens,
      };
    }

    const choice = parsed?.choices?.[0];
    if (!choice) return out;

    const delta = choice.delta ?? {};

    // A content block closes the moment the stream switches kinds: Anthropic
    // event order forbids a thinking_delta on a text block (and vice versa),
    // and Claude Code aborts the stream on a type mismatch. Reasoning and
    // content can share one delta, so thinking is emitted first.
    const thinking = reasoningText(delta);
    if (thinking !== null) {
      out += this.closeText();
      out += this.closeToolBlocks();
      if (this.thinkingIndex === null) {
        this.thinkingIndex = this.nextIndex++;
        out += sseEvent("content_block_start", {
          type: "content_block_start",
          index: this.thinkingIndex,
          content_block: { type: "thinking", thinking: "" },
        });
      }
      out += sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: this.thinkingIndex,
        delta: { type: "thinking_delta", thinking },
      });
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      out += this.closeThinking();
      out += this.closeToolBlocks();
      if (this.textIndex === null) {
        this.textIndex = this.nextIndex++;
        out += sseEvent("content_block_start", {
          type: "content_block_start",
          index: this.textIndex,
          content_block: { type: "text", text: "" },
        });
      }
      out += sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: this.textIndex,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    for (const call of delta.tool_calls ?? []) {
      if (call === null || typeof call !== "object") continue;
      const key = call.index ?? 0;
      let block = this.toolBlocks.get(key);
      if (!block) {
        out += this.closeThinking();
        out += this.closeText();
        block = { index: this.nextIndex++ };
        this.toolBlocks.set(key, block);
        out += sseEvent("content_block_start", {
          type: "content_block_start",
          index: block.index,
          content_block: {
            type: "tool_use",
            id: call.id ?? `toolu_${key}`,
            name: call.function?.name ?? "",
            input: {},
          },
        });
      }
      const args = call.function?.arguments;
      if (typeof args === "string" && args.length > 0) {
        out += sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: block.index,
          delta: { type: "input_json_delta", partial_json: args },
        });
      }
    }

    if (choice.finish_reason) {
      this.stopReason = STOP_REASON[choice.finish_reason] ?? "end_turn";
    }

    return out;
  }

  // Emit content_block_stop for the open block of one kind, if any. These are
  // the only places a block closes mid-stream; finish() closes whatever is
  // still open at the end.
  closeThinking() {
    if (this.thinkingIndex === null) return "";
    const index = this.thinkingIndex;
    this.thinkingIndex = null;
    return sseEvent("content_block_stop", { type: "content_block_stop", index });
  }

  closeText() {
    if (this.textIndex === null) return "";
    const index = this.textIndex;
    this.textIndex = null;
    return sseEvent("content_block_stop", { type: "content_block_stop", index });
  }

  closeToolBlocks() {
    let out = "";
    for (const block of this.toolBlocks.values()) {
      out += sseEvent("content_block_stop", { type: "content_block_stop", index: block.index });
    }
    this.toolBlocks.clear();
    return out;
  }

  // Close every open block, then message_delta + message_stop. Idempotent.
  finish() {
    if (this.finished) return "";
    this.finished = true;
    let out = this.started ? "" : this.start(null);

    out += this.closeThinking();
    out += this.closeText();
    out += this.closeToolBlocks();
    out += sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: { output_tokens: this.usage.output_tokens },
    });
    out += sseEvent("message_stop", { type: "message_stop" });
    return out;
  }
}

// Incremental SSE line parser for the upstream byte stream. Feed decoded text,
// get back parsed JSON payloads. Handles chunk boundaries splitting a line and
// stops yielding after [DONE].
export class SSEParser {
  constructor() {
    this.buffer = "";
    this.done = false;
  }

  push(text) {
    if (this.done) return [];
    this.buffer += text;
    const payloads = [];
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        this.done = true;
        break;
      }
      if (data.length === 0) continue;
      try {
        payloads.push(JSON.parse(data));
      } catch {
        // Skip an unparsable SSE line rather than aborting the whole stream.
      }
    }
    return payloads;
  }
}
