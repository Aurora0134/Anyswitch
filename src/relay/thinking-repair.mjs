// Purify upstream chat-completions thinking that arrives inside `content`
// wrapped in literal <thinking>…</thinking> tags.
//
// Some reverse-proxy channels wrap a Responses-protocol backend and convert
// its reasoning into the chat-completions `reasoning_content` field — and
// that conversion fails on a per-response basis (observed in production
// 2026-11 on a GPT channel: same request, same parameters, one turn arrives
// field-separated, the next leaks the raw thinking into `content` with the
// tags still on). Field-driven clients (DSH, Claude Code, codex, every
// mainstream agent) then render that thinking as body text, and the tagged
// text replays into history, teaching the model to keep leaking.
//
// The tag is an explicit structural signal, so this repair is deterministic
// marker parsing, not content guessing: only a tag span that opens at the
// very start of the answer stream is extracted (every observed leak was a
// leading block), and once real answer text has started nothing is ever
// reclassified — an answer that quotes the tag literally mid-stream keeps
// its bytes. A clean stream never matches and stays byte-identical.
//
// Streaming: ThinkingTagRepair is a pure state machine over content
// strings — feed each content delta, get back the {text, reasoning} pieces
// to forward (either may be empty while a split tag is still assembling).
// The stream guard applies it to every chunk before tracking, so the guard
// classifies the stream the client actually sees, and all three faces (the
// OpenAI passthrough plus the Anthropic and Responses translators, which
// consume the guard's output) render the extracted text as thinking.
//
// Non-streaming: repairNonStreamThinking splits a leading block out of
// message.content at the two upstream exit points (attemptMessages /
// attemptChatCompletion), before any protocol translation.
//
// Pure functions over strings and parsed JSON. No IO.

import { REASONING_FIELDS } from "./stream.mjs";

export const THINKING_OPEN = "<thinking>";
export const THINKING_CLOSE = "</thinking>";

const NO_OUTPUT = { text: "", reasoning: "" };

// The longest suffix of `buffer` that is a proper prefix of the close tag —
// the bytes a split `</thinking>` might still grow into, held back while
// the rest of the body streams out.
function closePrefixLength(buffer) {
  const max = Math.min(buffer.length, THINKING_CLOSE.length - 1);
  for (let k = max; k > 0; k -= 1) {
    if (buffer.slice(buffer.length - k) === THINKING_CLOSE.slice(0, k)) return k;
  }
  return 0;
}

export class ThinkingTagRepair {
  constructor() {
    this.mode = "detecting"; // no answer yet; the stream may still open a tag
    this.buffer = ""; // undecided prefix (detecting) / tag body (reasoning)
    this.stripLeadingWs = false; // after </thinking>: swallow separator runs
  }

  // Feed one content delta. Returns the pieces safe to forward now; both
  // empty while a tag is still assembling across chunk boundaries.
  push(delta) {
    if (typeof delta !== "string" || delta.length === 0) return NO_OUTPUT;
    this.buffer += delta;
    if (this.mode === "detecting") return this.detect();
    if (this.mode === "reasoning") return this.drain();
    return this.emitText();
  }

  // End of stream: an unterminated thinking block is still thinking; an
  // undecided prefix never became a tag, so it is text.
  finish() {
    if (this.mode === "reasoning") {
      const reasoning = this.buffer;
      this.buffer = "";
      this.mode = "text";
      return { text: "", reasoning };
    }
    if (this.mode === "detecting") {
      const text = this.buffer;
      this.buffer = "";
      this.mode = "text";
      return { text, reasoning: "" };
    }
    return NO_OUTPUT;
  }

  // Leading whitespace before the tag is separator noise (the same call
  // thinkPrefixDecision makes for ild blocks); whitespace before ordinary
  // answer text is the answer's own bytes and passes through.
  detect() {
    const trimmed = this.buffer.replace(/^\s+/, "");
    if (trimmed.length < THINKING_OPEN.length && THINKING_OPEN.startsWith(trimmed)) {
      return NO_OUTPUT; // could still grow into the open tag
    }
    if (trimmed.startsWith(THINKING_OPEN)) {
      this.mode = "reasoning";
      this.buffer = trimmed.slice(THINKING_OPEN.length);
      return this.drain();
    }
    this.mode = "text";
    const text = this.buffer;
    this.buffer = "";
    return { text, reasoning: "" };
  }

  drain() {
    const closeAt = this.buffer.indexOf(THINKING_CLOSE);
    if (closeAt !== -1) {
      const reasoning = this.buffer.slice(0, closeAt);
      const rest = this.buffer.slice(closeAt + THINKING_CLOSE.length);
      this.buffer = "";
      this.mode = "text";
      // The run right after </thinking> is the separator, not the answer's
      // first bytes (splitLeadingThinkingBlock strips the same run).
      const text = rest.replace(/^[\r\n\t ]+/, "");
      this.stripLeadingWs = text.length === 0;
      return { text, reasoning };
    }
    // No close tag yet: forward the body that cannot be part of a split
    // close tag and hold the possible partial suffix back.
    const hold = closePrefixLength(this.buffer);
    if (hold === 0) {
      const reasoning = this.buffer;
      this.buffer = "";
      return { text: "", reasoning };
    }
    const reasoning = this.buffer.slice(0, this.buffer.length - hold);
    this.buffer = this.buffer.slice(this.buffer.length - hold);
    return { text: "", reasoning };
  }

  emitText() {
    if (this.stripLeadingWs) {
      const text = this.buffer.replace(/^[\r\n\t ]+/, "");
      this.stripLeadingWs = text.length === 0;
      this.buffer = "";
      return { text, reasoning: "" };
    }
    const text = this.buffer;
    this.buffer = "";
    return { text, reasoning: "" };
  }
}

// A leading <thinking>…</thinking> block in string content splits into
// {reasoning, answer}; anything else returns null. Mirrors
// splitLeadingThinkBlock's shape, its whitespace handling, and its refusal
// on an unterminated block (the streaming machine is the one that flushes
// an unclosed block as thinking).
export function splitLeadingThinkingBlock(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.replace(/^\s+/, "");
  if (!trimmed.startsWith(THINKING_OPEN)) return null;
  const bodyStart = text.length - trimmed.length + THINKING_OPEN.length;
  const closeRelative = text.slice(bodyStart).indexOf(THINKING_CLOSE);
  if (closeRelative === -1) return null;
  const closeStart = bodyStart + closeRelative;
  const answerStart = closeStart + THINKING_CLOSE.length;
  return {
    reasoning: text.slice(bodyStart, closeStart).trim(),
    answer: text.slice(answerStart).replace(/^[\r\n\t ]+/, ""),
  };
}

// Move a leading <thinking> block from message.content into the reasoning
// channel of a non-streaming chat-completions payload. The extracted text
// joins the reasoning field the message already speaks (a second populated
// field would be dropped by first-match readers); reasoning_content is only
// created when none exists. Copy-on-touch: a payload with nothing to fix
// returns as the same reference, and a fixed one leaves the input object
// untouched.
export function repairNonStreamThinking(payload) {
  if (payload === null || typeof payload !== "object") return payload;
  if (!Array.isArray(payload.choices)) return payload;
  let touched = false;
  const choices = payload.choices.map((choice) => {
    const message = choice?.message;
    if (message === null || typeof message !== "object") return choice;
    if (typeof message.content !== "string" || message.content.length === 0) return choice;
    const split = splitLeadingThinkingBlock(message.content);
    if (!split) return choice;
    touched = true;
    const next = { ...message, content: split.answer };
    const field = REASONING_FIELDS.find((f) => typeof message[f] === "string") ?? "reasoning_content";
    next[field] = (message[field] ?? "") + split.reasoning;
    return { ...choice, message: next };
  });
  return touched ? { ...payload, choices } : payload;
}
