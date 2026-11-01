// Guards an upstream OpenAI-compatible SSE stream against tool calls that
// never receive an id or a function name. Strict OpenAI clients (the Vercel
// AI SDK among them) validate accumulated tool calls at stream flush and
// abort the whole request on such streams, so a relay that pipes them
// through turns an upstream glitch into a client-side crash.
//
// Strategy: hold every byte until the stream proves itself usable. Proof
// of usability depends on the keep-alive mode:
//   - pre-content hold (always on): real text, reasoning, or a complete tool
//     call (id + name) releases the hold. Empty streams stay held so the
//     caller can retry; a cut after release surfaces as a truncation verdict.
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
// Chunk-envelope repair: grok's ChatCompletionChunk struct requires id,
// created and model on EVERY data chunk and aborts the whole turn
// (is_retryable=false, session dead until /new) when any is absent. The
// upstream channels that omit them on continuation chunks are otherwise
// valid — every other client tolerates the gap — so this repair is opt-in
// per endpoint and disabled by default. It only fills genuine gaps, echoing
// the first real value seen so a well-formed stream stays byte-identical.
//
// Pure state machine over decoded text. No IO.

import { randomUUID } from "node:crypto";
import { REASONING_FIELDS } from "./stream.mjs";

const ERROR_TYPE = "api_error";
// Numeric error code for an upstream response that arrived incomplete. 502 is
// the closest semantic fit: RFC-wise it means "the gateway received an invalid
// or incomplete response from the upstream", which is exactly a mid-stream
// truncation (or a turn that produced nothing usable). 500 is too broad, 504
// is a timeout, 503 is the gateway's own overload. The relay already records
// this fault class as 502 internally (tracker.recordEnd({status:502})), so the
// wire code and the panel metric now speak the same vocabulary. Downstream
// agents that retry on 502/503 can recognise it; those that only read the
// message still have a Chinese text.
const UPSTREAM_INCOMPLETE_CODE = 502;
export { UPSTREAM_INCOMPLETE_CODE };
const INCOMPLETE_TOOL_CALL_MESSAGE =
  "the upstream stream contained an incomplete tool call (missing id or function name); the response was aborted";
const MID_WORD_TRUNCATION_MESSAGE =
  "上游响应在输出中途中断（缺少 [DONE] / finish_reason 终止信号），内容可能不完整";
const TRUNCATED_TOOL_ARGS_MESSAGE =
  "上游工具调用的参数不是合法 JSON（疑似在参数中途被静默截断），内容可能不完整";
const MALFORMED_JSON_CHUNK_MESSAGE =
  "上游流包含无法解析的 JSON 数据行（疑似 SSE 块在对象中途被截断），内容可能不完整";
const THINK_ONLY_MESSAGE =
  "上游响应只有思考内容，没有正文也没有工具调用，内容可能不完整";

// The guard holds a tool call per call: once a call carries id + name it is
// legal to forward, but its arguments stream as text and a mid-stream cut
// leaves half a JSON string that would blow up the client's parser. The
// guard therefore keeps an open call's deltas until its arguments parse as
// JSON, then releases the whole call as one frame. Answer text and reasoning
// are never held by this path.
const PER_CALL_HOLD_TOOL_ARGS = true;

function streamError(message, code = null) {
  const error = { type: ERROR_TYPE, message };
  if (code !== null && code !== undefined) error.code = code;
  return { error };
}

function toolCallError() {
  return streamError(INCOMPLETE_TOOL_CALL_MESSAGE, UPSTREAM_INCOMPLETE_CODE);
}

function streamErrorLine(message, code = null) {
  return `data: ${JSON.stringify(streamError(message, code))}\n\n`;
}

function toolCallErrorLine() {
  return streamErrorLine(INCOMPLETE_TOOL_CALL_MESSAGE, UPSTREAM_INCOMPLETE_CODE);
}

function parsesAsJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function looksLikeJsonObjectOrArray(payload) {
  if (!payload) return false;
  const c = payload[0];
  return c === "{" || c === "[";
}

// Payload of a `data:` line (line keeps its trailing newline), or null when
// the line is not a data line (comments, event lines, blank separators).
function dataPayload(line) {
  if (!line.startsWith("data:")) return null;
  let payload = line.slice(5, -1); // drop "data:" and the trailing newline
  if (payload.startsWith(" ")) payload = payload.slice(1);
  return payload.endsWith("\r") ? payload.slice(0, -1) : payload;
}

// A present-but-empty tool-call id/type/name is as unusable as a missing one:
// clients that merge deltas object-style (`{...acc, ...delta}` or `??`) keep
// the later "" and overwrite the real values the first delta carried.
function hasText(value) {
  return typeof value === "string" && value.length > 0;
}

// Some upstreams (observed: stepfun) repeat `id`/`type`/`function.name` on
// every tool-call continuation delta with the value "" instead of omitting
// the keys — the canonical shape every other upstream emits. Drop the emptied
// keys so strict clients keep the first delta's values; a call that never
// carries real values anywhere is left for the guard's incomplete-tool-call
// verdict to reject below. Mutates `parsed`; returns whether it changed it.
function stripEmptyToolCallKeys(parsed) {
  let touched = false;
  for (const choice of parsed.choices ?? []) {
    const calls = choice?.delta?.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (call === null || typeof call !== "object") continue;
      for (const key of ["id", "type"]) {
        if (call[key] === "") { delete call[key]; touched = true; }
      }
      const fn = call.function;
      if (fn !== null && typeof fn === "object" && fn.name === "") { delete fn.name; touched = true; }
    }
  }
  return touched;
}

// Fill the id/created/model envelope grok's strict struct requires (see the
// header note). `envelope` doubles as the memory of what to echo: the first
// real value of each field wins, so continuation chunks that omit a field get
// the value the opening chunk established, and a stream that never carried a
// field at all falls back to the synthesized id / timestamp / request model.
// Mutates `parsed`; returns whether it changed it.
function fillChunkEnvelope(parsed, envelope) {
  if (envelope === null) return false;
  let touched = false;
  if (hasText(parsed.id)) envelope.id = parsed.id;
  else { parsed.id = envelope.id; touched = true; }
  if (typeof parsed.created === "number") envelope.created = parsed.created;
  else { parsed.created = envelope.created; touched = true; }
  if (hasText(parsed.model)) envelope.model = parsed.model;
  else { parsed.model = envelope.model; touched = true; }
  return touched;
}

// Apply every per-line repair in a single pass, so a line is re-serialized at
// most once. Returns the original line untouched when no repair applies — the
// byte-identical passthrough every non-opted-in channel still relies on.
function rewriteDataLine(line, parsed, envelope) {
  const strippedEmptyKeys = stripEmptyToolCallKeys(parsed);
  const filledEnvelope = fillChunkEnvelope(parsed, envelope);
  if (!strippedEmptyKeys && !filledEnvelope) return line;
  const nl = line.endsWith("\r\n") ? "\r\n" : "\n";
  const body = line.slice(0, line.length - nl.length);
  const sep = body.slice(5, 6) === " " ? " " : "";
  return `data:${sep}${JSON.stringify(parsed)}${nl}`;
}

export class OpenAIStreamGuard {
  constructor({ fillChunkEnvelope = null, envelopeSeed = null, priorCalls = [] } = {}) {
    // Chunk-envelope repair state (null = off). Only the OpenAI passthrough
    // channel enables it, and only for grok; see the header note. The request
    // model is the fallback for a stream that never names a model itself, and
    // must be a non-empty string — grok rejects a missing field, and a null
    // would read as one.
    //
    // envelopeSeed hands a resumed attempt the envelope the client already
    // saw: the upstream's second generation carries its own id, and letting
    // it through would change the response id mid-stream.
    this.envelope = fillChunkEnvelope === null
      ? null
      : envelopeSeed !== null
        ? { ...envelopeSeed }
        : {
            id: `chatcmpl-${randomUUID()}`,
            created: Math.floor(Date.now() / 1000),
            model: hasText(fillChunkEnvelope.model) ? fillChunkEnvelope.model : "unknown",
          };
    this.partial = ""; // decoded text not yet forming a complete line
    this.holding = true; // nothing forwarded yet
    this.held = ""; // verbatim text withheld during the hold phase
    this.pendingDone = ""; // [DONE] line withheld until the verdict
    this.holdBlank = false; // also withhold the blank line right after [DONE]
    this.calls = new Map(); // tool_call index -> { firstHadId, hasId, hasName, args }
    // Shadow copy of what the caller has already forwarded, kept separately
    // per kind: the resume path turns it back into an assistant prefill. Tool
    // call arguments are NOT shadowed here — they only reach the client once
    // the whole call is complete (see below), so a completed call is already
    // recoverable from the completedCalls snapshot.
    this.forwardedText = "";
    this.forwardedReasoning = "";
    // Completed tool calls, in the order the client saw them. A call is
    // "complete" once its arguments parse as JSON (and it has id + name);
    // before that it is the openCall below and its bytes stay with the guard.
    this.completedCalls = []; // [{ id, name, args }]
    // Calls the client already saw during an earlier segment of this same
    // response. A resumed model occasionally re-emits a call it had already
    // finished before the cut; forwarding it would run the tool twice. Same
    // name + same arguments = the same call, dropped on sight.
    this.priorCalls = Array.isArray(priorCalls) ? priorCalls.map((c) => ({ ...c })) : [];
    // The tool call whose arguments are still streaming. Held per call: the
    // deltas the client has not seen yet. One open call at a time — a turn
    // that interleaves two open calls is malformed upstream behaviour, and
    // the guard treats the second one as a new open call.
    this.openCall = null; // { index, id, name, args, withheld, sawFinish }
    // The last open call that was dropped for being incomplete: the verdict
    // needs to know a call was cut even though its bytes never left the guard.
    this.droppedOpenCall = null;
    this.sawDone = false; // a [DONE] terminator line was seen
    this.sawFinishReason = false; // a choice carried a finish_reason
    this.sawContent = false; // some text/reasoning was proven mid-stream
    this.sawText = false; // the stream carried actual answer text
    this.sawReasoning = false; // the stream carried reasoning/thinking text
    this.sawLengthFinish = false; // a choice carried finish_reason "length"
    this.sawMalformedJson = false; // a data: line looked like JSON but failed to parse
    this.finished = false;
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
    this.trackContent(parsed);
    // The pre-content hold phase: nothing is forwarded until the stream proves
    // usable, so a first-word failure is still a clean retry; the per-call hold
    // below is orthogonal to it.
    if (this.holding) {
      this.held += rewriteDataLine(line, parsed, this.envelope);
      if (this.isHealthy(parsed)) {
        this.sawContent = true;
        this.holding = false;
        return this.releaseHeld();
      }
      return "";
    }
    // Per-call hold: a tool call whose arguments are still streaming is kept
    // until it parses; everything else (text, reasoning, usage) goes through
    // immediately and is shadowed for the resume path.
    if (PER_CALL_HOLD_TOOL_ARGS) {
      return this.routeForward(rewriteDataLine(line, parsed, this.envelope), parsed);
    }
    this.shadowForward(parsed);
    return rewriteDataLine(line, parsed, this.envelope);
  }

  holdOrEmit(line) {
    if (!this.holding) return line;
    this.held += line;
    return "";
  }

  // Flush the pre-content hold: the held bytes contain both the first content
  // and the frames that preceded it. The shadow and the per-call hold are
  // applied to each frame inside — a frame that only opens a tool call is
  // withheld, a text/reasoning frame is shadowed, and the open call's
  // withheld bytes stay held.
  releaseHeld() {
    let out = "";
    let partial = "";
    const text = this.held;
    this.held = "";
    for (let i = 0; i < text.length; i += 1) {
      partial += text[i];
      if (text[i] === "\n") {
        out += this.releaseHeldLine(partial);
        partial = "";
      }
    }
    this.held = partial;
    return out;
  }

  releaseHeldLine(line) {
    const payload = dataPayload(line);
    if (payload === null) return line;
    if (payload === "[DONE]") {
      this.pendingDone = line;
      this.holdBlank = true;
      return "";
    }
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return line;
    }
    if (parsed === null || typeof parsed !== "object") return line;
    if (PER_CALL_HOLD_TOOL_ARGS) {
      return this.routeForward(line, parsed);
    }
    this.shadowForward(parsed);
    return line;
  }

  // The shadow copy of a forwarded frame. Tool-call deltas are not shadowed
  // — a completed call is recovered from completedCalls, and an open call's
  // bytes stay with the guard until it closes.
  shadowForward(parsed) {
    const delta = parsed?.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === "string") this.forwardedText += delta.content;
    for (const field of REASONING_FIELDS) {
      if (typeof delta[field] === "string") this.forwardedReasoning += delta[field];
    }
  }

  // The per-call hold decides whether a frame reaches the client now.
  // Returns the text safe to forward: usually the frame itself, sometimes
  // the completed call released as one frame, sometimes nothing.
  routeForward(forward, parsed) {
    const delta = parsed?.choices?.[0]?.delta;
    const calls = Array.isArray(delta?.tool_calls)
      ? delta.tool_calls.filter((call) => call !== null && typeof call === "object" && call.index != null)
      : [];
    if (calls.length === 0) {
      if (this.openCall === null) {
        this.shadowForward(parsed);
        return forward;
      }
      // Text, reasoning, finish_reason, or a usage frame while arguments are
      // still arriving: it belongs to the open call's turn and is withheld
      // with it, so the client never sees the call's tail before its args.
      this.openCall.withheld += forward;
      // finish_reason proves no further argument deltas are coming, which is
      // what makes an argument-less call whole.
      if (delta?.finish_reason) this.openCall.sawFinish = true;
      return "";
    }
    let out = "";
    // A different call index means the open call will receive no more
    // arguments: close it before absorbing this frame.
    if (this.openCall !== null && calls[0].index !== this.openCall.index) {
      // The next index proves this call's arguments are final, so an
      // argument-less call here is whole rather than merely unfinished.
      out += this.closeOpenCall(true);
      this.openCall = this.newOpenCall(calls[0]);
    } else if (this.openCall === null) {
      this.openCall = this.newOpenCall(calls[0]);
    }
    out += this.absorbCallFrame(calls, forward);
    return out;
  }

  newOpenCall(call) {
    return {
      index: call.index,
      id: hasText(call.id) ? call.id : "",
      name: hasText(call.function?.name) ? call.function.name : "",
      args: "",
      withheld: "",
    };
  }

  // Append one frame's tool-call payloads to the open call. The frame's bytes
  // are withheld whole: the client sees a call open and its arguments arrive
  // in one piece, never delta by delta.
  absorbCallFrame(calls, forward) {
    const open = this.openCall;
    if (open === null) return "";
    open.withheld += forward;
    for (const call of calls) {
      if (call.index !== open.index) continue;
      if (typeof call.function?.arguments === "string") open.args += call.function.arguments;
      if (hasText(call.id)) open.id = call.id;
      if (hasText(call.function?.name)) open.name = call.function.name;
    }
    // Completeness is judged from what this call has seen so far, never from
    // the live `calls` map: held frames are replayed through this path, and
    // the map already knows about fields that a replayed frame has not
    // reached yet.
    const complete =
      hasText(open.id) &&
      hasText(open.name) &&
      // Empty arguments stay open until the call is closed by the next index
      // or by the end of the stream: more argument deltas may still arrive.
      open.args.length > 0 &&
      parsesAsJson(open.args);
    return complete ? this.closeOpenCall(false) : "";
  }

  // Release the open call's withheld bytes. A call that is whole (id + name,
  // and arguments that are absent or parse) is released verbatim; one that is
  // not is DROPPED — the client never saw it, so a truncated call leaves no
  // broken state behind. `final` marks the end of the stream, where empty
  // arguments are legal (a call with no arguments at all).
  closeOpenCall(final) {
    const open = this.openCall;
    if (open === null) return "";
    this.openCall = null;
    const whole =
      hasText(open.id) &&
      hasText(open.name) &&
      (open.args.length === 0 ? final || open.sawFinish : parsesAsJson(open.args));
    if (!whole) {
      // Dropped: an incomplete call is invisible to the client, so the turn
      // can be resumed instead of poisoning the client's parser.
      this.droppedOpenCall = open;
      return "";
    }
    // A resumed segment may replay a call the client already has. Drop this
    // one copy (and only this one: a genuine third call with the same shape
    // still goes through) — executing a tool twice is worse than a missing
    // call the model can re-request.
    const prior = this.priorCalls.findIndex((c) => c.name === open.name && c.args === open.args);
    if (prior !== -1) {
      this.priorCalls.splice(prior, 1);
      return "";
    }
    this.completedCalls.push({ id: open.id, name: open.name, args: open.args });
    return open.withheld;
  }

  // Answer text and reasoning are tracked separately: the think-only verdict
  // needs to tell "the model thought and stopped" from "the model answered".
  trackContent(parsed) {
    for (const choice of parsed.choices ?? []) {
      const delta = choice?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content.length > 0) this.sawText = true;
      for (const field of REASONING_FIELDS) {
        if (typeof delta[field] === "string" && delta[field].length > 0) this.sawReasoning = true;
      }
    }
  }

  trackToolCalls(parsed) {
    for (const choice of parsed.choices ?? []) {
      if (choice?.finish_reason) this.sawFinishReason = true;
      if (choice?.finish_reason === "length") this.sawLengthFinish = true;
      const calls = choice?.delta?.tool_calls;
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        if (call === null || typeof call !== "object" || call.index == null) continue;
        let rec = this.calls.get(call.index);
        if (rec === undefined) {
          // A first delta without an id is itself malformed for strict
          // clients; remember it so the verdict can account for it. An
          // empty string counts as missing — a "" id/name is as unusable
          // as an absent one, and some upstreams stream "" continuations.
          rec = { firstHadId: hasText(call.id), hasId: false, hasName: false, args: "" };
          this.calls.set(call.index, rec);
        }
        if (hasText(call.id)) rec.hasId = true;
        if (hasText(call.function?.name)) rec.hasName = true;
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
      if (Array.isArray(delta.tool_calls)) {
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

  // A turn that terminated cleanly but produced nothing the agent can act on:
  // reasoning text only, no answer text and no tool call. The stream looks
  // perfectly healthy — it carries a finish_reason and a [DONE] — so every
  // other check passes it, yet for an agent the turn is empty. kimi-cli
  // classifies the same shape as an incomplete response and retries it
  // (1.31.0: "fix the agent loop silently stopping when the model response
  // contains only thinking content"); this guard learned it from there.
  //
  // A reasoning-only turn is not necessarily a fault: a model asked to think
  // without answering produces exactly this. But for the agent loop it
  // delivers nothing to act on, and the caller decides whether to retry
  // (on tier) or surface it (off tier) — the guard only classifies.
  hasThinkOnlyTurn() {
    if (this.sawText) return false;
    if (this.calls.size > 0) return false;
    if (!this.sawReasoning) return false;
    // A turn cut by the token budget is a different fault class: the
    // Responses translator already reports it as an "incomplete" response
    // (finish_reason "length"), and codex reads that as a normal
    // completion — flagging it here would turn a budget stop into a retry.
    if (this.sawLengthFinish) return false;
    // A turn with no terminator at all is a mid-word cut, not a think-only
    // turn — the truncation verdict owns that case.
    return this.sawDone || this.sawFinishReason;
  }

  hasIncompleteToolCall() {
    for (const rec of this.calls.values()) {
      if (!rec.firstHadId || !rec.hasId || !rec.hasName) return true;
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

  // The shadow copy the resume path turns into a continuation request.
  // Everything the client has already seen (forwarded text and reasoning)
  // plus every completed tool call (released to the client when it closed)
  // goes back upstream as the assistant's partial output. An open call's
  // withheld bytes never reach the client, so they are not part of the
  // shadow — the continuation re-generates that call from scratch.
  //
  // Returns null when the turn produced nothing the client saw (empty
  // stream, or a cut before any content): there is nothing to continue
  // from, so the caller retries the original request unchanged.
  resumeShadow() {
    const text = this.forwardedText;
    const reasoning = this.forwardedReasoning;
    const calls = this.completedCalls;
    if (!text && !reasoning && calls.length === 0) return null;
    return { text, reasoning, calls: calls.slice() };
  }

  // Verdict after the upstream stream ended. Flushing any decoder tail into
  // chunk() first is the caller's job.
  finish() {
    this.finished = true;
    // A call still open at the end of the stream: release it if it is whole
    // (an argument-less call is legal), otherwise it stays dropped — the
    // client never saw it, so it cannot poison the turn's output.
    const openTail = this.openCall === null ? "" : this.closeOpenCall(true);
    const tail = openTail + (this.holding ? this.held : this.pendingDone) + this.partial;
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
          error: streamError(MALFORMED_JSON_CHUNK_MESSAGE, UPSTREAM_INCOMPLETE_CODE),
        };
      }
      // A turn that thought but never answered and never called a tool: the
      // stream is over and healthy-looking, yet the agent has nothing to act
      // on. Same shape kimi-cli retries as an incomplete response.
      if (this.hasThinkOnlyTurn()) {
        return {
          action: "reject",
          reason: "think_only_incomplete",
          truncated: true,
          error: streamError(THINK_ONLY_MESSAGE, UPSTREAM_INCOMPLETE_CODE),
        };
      }
      return { action: "empty", tail };
    }
    if (this.hasIncompleteToolCall()) {
      return { action: "error", reason: "incomplete_tool_call", errorLine: toolCallErrorLine() };
    }
    if (this.sawMalformedJson) {
      return {
        action: "error",
        reason: "malformed_json_chunk",
        truncated: true,
        error: streamError(MALFORMED_JSON_CHUNK_MESSAGE, UPSTREAM_INCOMPLETE_CODE),
        errorLine: streamErrorLine(MALFORMED_JSON_CHUNK_MESSAGE, UPSTREAM_INCOMPLETE_CODE),
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
        reason: "mid_word_truncation",
        truncated: true,
        error: streamError(MID_WORD_TRUNCATION_MESSAGE, UPSTREAM_INCOMPLETE_CODE),
        errorLine: streamErrorLine(MID_WORD_TRUNCATION_MESSAGE, UPSTREAM_INCOMPLETE_CODE),
        tail,
      };
    }
    // The stream terminated cleanly but a tool call's arguments do not parse
    // as JSON: the argument string was silently truncated mid-way.
    if (this.hasTruncatedToolArgs()) {
      return {
        action: "error",
        reason: "truncated_tool_args",
        truncated: true,
        error: streamError(TRUNCATED_TOOL_ARGS_MESSAGE, UPSTREAM_INCOMPLETE_CODE),
        errorLine: streamErrorLine(TRUNCATED_TOOL_ARGS_MESSAGE, UPSTREAM_INCOMPLETE_CODE),
        tail,
      };
    }
    // The stream terminated cleanly and carried a terminator, but the turn
    // held nothing but reasoning: the agent got no answer and no tool call.
    if (this.hasThinkOnlyTurn()) {
      return {
        action: "error",
        reason: "think_only_incomplete",
        truncated: true,
        error: streamError(THINK_ONLY_MESSAGE, UPSTREAM_INCOMPLETE_CODE),
        errorLine: streamErrorLine(THINK_ONLY_MESSAGE, UPSTREAM_INCOMPLETE_CODE),
        tail,
      };
    }
    return { action: "pass", tail };
  }
}
