// Guards an upstream OpenAI-compatible SSE stream against tool calls that
// never receive an id or a function name. Strict OpenAI clients (the Vercel
// AI SDK among them) validate accumulated tool calls at stream flush and
// abort the whole request on such streams, so a relay that pipes them
// through turns an upstream glitch into a client-side crash.
//
// Strategy: hold every byte until the stream proves itself usable. Proof
// of usability depends on the keep-alive mode:
//   - basic (default): real text, reasoning, or a complete tool call
//     (id + name) releases the hold. Empty streams stay held so the
//     caller can retry; mid-word / silent tool-arg cuts after release
//     surface as a terminal error event.
//   - enhanced (holdEntireTurn): nothing releases the hold — the whole
//     turn is withheld until finish() validates terminators and tool args
//     atomically, so any mid-stream cut (reasoning, text, or args) stays
//     retryable because not a single byte reached the client. The channel
//     keeps the client patient with SSE comment pings.
// If the stream ends while still holding and nothing usable was proven,
// nothing was forwarded and the caller can reject (a plain 5xx the client
// can retry). If the malformation only appears after content was already
// forwarded, the caller terminates with a structured error event instead
// of [DONE], so the client fails loudly but legibly.
//
// Non-JSON or scalar data lines (empty `data:` keep-alive pings included)
// prove nothing and stay held — releasing on them let truncated streams
// pass as normal completions.
//
// Post-content truncation detection: once content has been delivered the
// bytes cannot be recalled, so the guard instead checks that the stream
// terminated properly. A healthy OpenAI SSE stream always ends with a
// [DONE] line and/or a finish_reason on a choice; a stream that ends with
// neither was cut mid-word. And a tool call whose accumulated arguments
// fail to parse as JSON was silently truncated even though the stream
// shape looked clean. While holding, both surface as a "reject" verdict
// (retryable — nothing was sent); after content was delivered they surface
// as an "error" verdict with truncated=true so the channel can emit a
// legible error event and latch a fault instead of letting the client
// treat partial output as complete.
//
// Pure state machine over decoded text. No IO.

import { REASONING_FIELDS } from "./stream.mjs";

const ERROR_TYPE = "api_error";
const INCOMPLETE_TOOL_CALL_MESSAGE =
  "the upstream stream contained an incomplete tool call (missing id or function name); the response was aborted";
const MID_WORD_TRUNCATION_MESSAGE =
  "上游流在输出中途结束（缺少 [DONE] / finish_reason 终止信号），内容可能被截断";
const TRUNCATED_TOOL_ARGS_MESSAGE =
  "上游工具调用的参数不是合法 JSON（疑似在参数中途被静默截断），内容可能不完整";
const MALFORMED_JSON_CHUNK_MESSAGE =
  "上游流包含无法解析的 JSON 数据行（疑似 SSE 块在对象中途被截断），内容可能不完整";

function streamError(message) {
  return { error: { type: ERROR_TYPE, message } };
}

function toolCallError() {
  return streamError(INCOMPLETE_TOOL_CALL_MESSAGE);
}

function streamErrorLine(message) {
  return `data: ${JSON.stringify(streamError(message))}\n\n`;
}

function toolCallErrorLine() {
  return streamErrorLine(INCOMPLETE_TOOL_CALL_MESSAGE);
}

// Payload of a `data:` line (line keeps its trailing newline), or null when
// the line is not a data line (comments, event lines, blank separators).
function looksLikeJsonObjectOrArray(payload) {
  if (!payload) return false;
  const c = payload[0];
  return c === "{" || c === "[";
}

function dataPayload(line) {
  if (!line.startsWith("data:")) return null;
  let payload = line.slice(5, -1); // drop "data:" and the trailing newline
  if (payload.startsWith(" ")) payload = payload.slice(1);
  return payload.endsWith("\r") ? payload.slice(0, -1) : payload;
}

export class OpenAIStreamGuard {
  constructor({ holdEntireTurn = false } = {}) {
    this.partial = ""; // decoded text not yet forming a complete line
    this.holding = true; // nothing forwarded yet
    this.held = ""; // verbatim text withheld during the hold phase
    this.pendingDone = ""; // [DONE] line withheld until the verdict
    this.holdBlank = false; // also withhold the blank line right after [DONE]
    this.calls = new Map(); // tool_call index -> { firstHadId, hasId, hasName, args }
    this.sawDone = false; // a [DONE] terminator line was seen
    this.sawFinishReason = false; // a choice carried a finish_reason
    this.sawContent = false; // some text/reasoning was proven mid-stream
    this.sawMalformedJson = false; // a data: line looked like JSON but failed to parse
    this.finished = false;
    // enhanced keep-alive (plan A): nothing releases the hold — the whole turn
    // is withheld until finish() validates terminators and tool args, so any
    // mid-stream cut (reasoning, text, or args) stays retryable because not
    // a single byte reached the client. The channel keeps the client patient
    // with SSE comment pings.
    this.holdEntireTurn = holdEntireTurn === true;
  }

  // Feed decoded upstream text; returns the text safe to forward now.
  chunk(text) {
    if (this.finished) return "";
    this.partial += text;
    let out = "";
    let nl;
    while ((nl = this.partial.indexOf("\n")) !== -1) {
      const line = this.partial.slice(0, nl + 1);
      this.partial = this.partial.slice(nl + 1);
      out += this.line(line);
    }
    return out;
  }

  line(line) {
    if (this.holdBlank) {
      // Keep the blank separator with its withheld [DONE] so a healthy
      // stream is still forwarded byte for byte.
      this.holdBlank = false;
      if (line === "\n" || line === "\r\n") {
        this.pendingDone += line;
        return "";
      }
    }
    const payload = dataPayload(line);
    if (payload === null) return this.holdOrEmit(line);
    if (payload === "[DONE]") {
      // Withhold the terminator until the verdict: a rejected stream must
      // not look like a normal completion.
      this.sawDone = true;
      if (this.holding) this.held += line;
      else {
        this.pendingDone = line;
        this.holdBlank = true;
      }
      return "";
    }
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // Empty / comment-like data lines (keep-alive pings) prove nothing.
      // A payload that *looks* like a JSON object/array but fails to parse
      // is a truncated SSE chunk — forwarding it makes strict clients
      // (Vercel AI SDK) throw AI_JSONParseError and abort the turn.
      if (looksLikeJsonObjectOrArray(payload)) {
        this.sawMalformedJson = true;
        return "";
      }
      return this.holdOrEmit(line);
    }
    if (parsed === null || typeof parsed !== "object") {
      // A JSON scalar is equally unproving; hold it too.
      return this.holdOrEmit(line);
    }

    this.trackToolCalls(parsed);
    if (!this.holding) return line;
    this.held += line;
    if (this.isHealthy(parsed)) {
      this.sawContent = true;
      if (!this.holdEntireTurn) {
        this.holding = false;
        return this.held;
      }
    }
    return "";
  }

  holdOrEmit(line) {
    if (!this.holding) return line;
    this.held += line;
    return "";
  }

  trackToolCalls(parsed) {
    for (const choice of parsed.choices ?? []) {
      if (choice?.finish_reason) this.sawFinishReason = true;
      const calls = choice?.delta?.tool_calls;
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        if (call === null || typeof call !== "object" || call.index == null) continue;
        let rec = this.calls.get(call.index);
        if (rec === undefined) {
          // A first delta without an id is itself malformed for strict
          // clients; remember it so the verdict can account for it.
          rec = { firstHadId: call.id != null, hasId: false, hasName: false, args: "" };
          this.calls.set(call.index, rec);
        }
        if (call.id != null) rec.hasId = true;
        if (call.function?.name != null) rec.hasName = true;
        if (typeof call.function?.arguments === "string") rec.args += call.function.arguments;
      }
    }
  }

  // Proof the stream is usable. Text/reasoning always releases. A complete
  // tool call (id + name) also releases unless the whole turn is held —
  // then nothing releases and finish() validates the turn atomically.
  isHealthy(parsed) {
    for (const choice of parsed.choices ?? []) {
      const delta = choice?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content.length > 0) return true;
      for (const field of REASONING_FIELDS) {
        if (typeof delta[field] === "string" && delta[field].length > 0) return true;
      }
      if (!this.holdEntireTurn && Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (call === null || typeof call !== "object") continue;
          const key = call.index ?? 0;
          const rec = this.calls.get(key);
          if (rec !== undefined && rec.hasId && rec.hasName) return true;
        }
      }
    }
    return false;
  }

  hasIncompleteToolCall() {
    for (const rec of this.calls.values()) {
      if (!rec.firstHadId || !rec.hasId || !rec.hasName) return true;
    }
    return false;
  }

  // True once the upstream has proven usable content (text/reasoning, or a
  // complete tool call id+name) even while the bytes stay withheld under
  // holdEntireTurn. The pipes use it to timestamp the upstream first token
  // for TPS, which the hold would otherwise defer to the verdict flush —
  // folding the whole TTFT into the speed denominator.
  hasProvenContent() {
    if (this.sawContent) return true;
    for (const rec of this.calls.values()) {
      if (rec.hasId && rec.hasName) return true;
    }
    return false;
  }

  // A tool call whose accumulated arguments string fails to parse as JSON.
  // Empty args are valid (a call with no arguments); only a non-empty string
  // that JSON.parse rejects proves the argument stream was cut mid-way.
  hasTruncatedToolArgs() {
    for (const rec of this.calls.values()) {
      if (rec.args.length === 0) continue;
      try {
        JSON.parse(rec.args);
      } catch {
        return true;
      }
    }
    return false;
  }

  // Verdict after the upstream stream ended. Flushing any decoder tail into
  // chunk() first is the caller's job.
  finish() {
    this.finished = true;
    const tail = (this.holding ? this.held : this.pendingDone) + this.partial;
    this.partial = "";
    if (this.holding) {
      // Nothing was forwarded yet, so every failure shape is safely
      // retryable. Whole-turn hold (enhanced) lands every provable-content
      // turn here by design and validates it atomically before its bytes
      // flush. Basic mode only reaches here when no text/reasoning/complete
      // tool call ever arrived (true empty / incomplete-id-name).
      if (this.hasIncompleteToolCall()) {
        return { action: "reject", reason: "incomplete_tool_call", error: toolCallError() };
      }
      if (this.sawMalformedJson) {
        return {
          action: "reject",
          reason: "malformed_json_chunk",
          truncated: true,
          error: streamError(MALFORMED_JSON_CHUNK_MESSAGE),
        };
      }
      if (this.holdEntireTurn && (this.calls.size > 0 || this.sawContent)) {
        if (this.hasTruncatedToolArgs()) {
          return {
            action: "reject",
            reason: "truncated_tool_args",
            truncated: true,
            error: streamError(TRUNCATED_TOOL_ARGS_MESSAGE),
          };
        }
        if (!this.sawDone && !this.sawFinishReason) {
          return {
            action: "reject",
            reason: "mid_word_truncation",
            truncated: true,
            error: streamError(MID_WORD_TRUNCATION_MESSAGE),
          };
        }
        return { action: "pass", tail };
      }
      return { action: "empty", tail };
    }
    if (this.hasIncompleteToolCall()) {
      return { action: "error", errorLine: toolCallErrorLine() };
    }
    if (this.sawMalformedJson) {
      return {
        action: "error",
        truncated: true,
        error: streamError(MALFORMED_JSON_CHUNK_MESSAGE),
        errorLine: streamErrorLine(MALFORMED_JSON_CHUNK_MESSAGE),
        tail,
      };
    }
    // Content was already delivered. The OpenAI SSE protocol requires a
    // [DONE] terminator, and every healthy completion carries a
    // finish_reason on a choice; a stream that ends with neither was cut
    // mid-word. The client already holds partial output, so this must not
    // look like a normal completion.
    if (!this.sawDone && !this.sawFinishReason) {
      return {
        action: "error",
        truncated: true,
        error: streamError(MID_WORD_TRUNCATION_MESSAGE),
        errorLine: streamErrorLine(MID_WORD_TRUNCATION_MESSAGE),
        tail,
      };
    }
    // The stream terminated cleanly but a tool call's arguments do not parse
    // as JSON: the argument string was silently truncated mid-way.
    if (this.hasTruncatedToolArgs()) {
      return {
        action: "error",
        truncated: true,
        error: streamError(TRUNCATED_TOOL_ARGS_MESSAGE),
        errorLine: streamErrorLine(TRUNCATED_TOOL_ARGS_MESSAGE),
        tail,
      };
    }
    return { action: "pass", tail };
  }
}
