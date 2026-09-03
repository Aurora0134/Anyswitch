// OpenAI SSE chat.completion.chunk -> Gemini streamGenerateContent?alt=sse
// translation. Pure state machine. No IO, no network.
//
// Reuses SSEParser from stream.mjs (the Anthropic frontend) so the upstream byte
// stream is parsed identically.
//
// Gemini's SSE wire shape (alt=sse) is a sequence of JSON objects, one per
// `data:` line, each carrying a partial candidate:
//
//   data: {"candidates":[{"content":{"role":"model","parts":[{"text":"..."}]},"index":0}]}
//   ...
//   data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{...}}]},"index":0}]}
//   data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP","index":0}],"usageMetadata":{...}}
//
// agy's SDK assembles text by concatenating the `text` parts across chunks, and
// assembles a tool call by reading `functionCall` parts. For tool calls, the
// OpenAI wire delivers arguments as a streaming JSON string across many chunks;
// we buffer the raw argument string per tool call and emit a single
// functionCall part when the call's arguments are complete (finish_reason or a
// new call), because Gemini's functionCall expects an object, not a partial
// string. This is the one place streaming semantics diverge from the non-
// streaming translator, and it mirrors how the Anthropic StreamTranslator emits
// input_json_delta fragments — except Gemini wants the assembled object.
//
// Risk: the exact incremental functionCall semantics should be
// validated against a real agy tool-calling turn after the relay is wired. The
// buffering strategy below is the conservative choice that always yields a valid
// Gemini functionCall; if agy's SDK turns out to prefer partial functionCall
// deltas, this is the single place to adjust.

import { SSEParser } from "./stream.mjs";
import { OpenAIStreamGuard } from "./openai-stream-guard.mjs";

const FINISH_REASON = {
  stop: "STOP",
  length: "MAX_TOKENS",
  tool_calls: "STOP",
  function_call: "STOP",
  content_filter: "SAFETY",
};

// Cached-token fallback chain, mirroring agent-metrics' aggregate tracker:
// different upstreams report cache hits under different OpenAI-shape keys.
function extractCachedTokens(usage) {
  return usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? usage?.cached_tokens;
}

function dataLine(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export class GeminiStreamTranslator {
  constructor(slug) {
    this.slug = slug;
    this.started = false;
    // OpenAI tool_call index -> { id, name, argsBuffer, emitted }
    this.toolCalls = new Map();
    this.finishReason = "STOP";
    this.usage = { promptTokenCount: 0, candidatesTokenCount: 0, cachedTokenCount: 0 };
    this.finished = false;
  }

  // Emit one text chunk as a Gemini candidate with a single text part.
  emitText(text) {
    return dataLine({
      candidates: [
        { content: { role: "model", parts: [{ text }] }, index: 0 },
      ],
    });
  }

  // Flush a completed tool call as a Gemini functionCall part.
  flushToolCall(block) {
    let args = {};
    if (block.argsBuffer.length > 0) {
      try {
        args = JSON.parse(block.argsBuffer);
      } catch {
        args = { __unparsed_arguments: block.argsBuffer };
      }
    }
    block.emitted = true;
    return dataLine({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name: block.name, args, id: block.id } }],
          },
          index: 0,
        },
      ],
    });
  }

  // Translate one parsed OpenAI chunk into zero or more Gemini SSE lines.
  chunk(parsed) {
    let out = "";
    this.started = true;

    const usage = parsed?.usage;
    if (usage) {
      this.usage = {
        promptTokenCount: usage.prompt_tokens ?? this.usage.promptTokenCount,
        candidatesTokenCount: usage.completion_tokens ?? this.usage.candidatesTokenCount,
        cachedTokenCount: extractCachedTokens(usage) ?? this.usage.cachedTokenCount,
      };
    }

    const choice = parsed?.choices?.[0];
    if (!choice) return out;

    const delta = choice.delta ?? {};

    if (typeof delta.content === "string" && delta.content.length > 0) {
      out += this.emitText(delta.content);
    }

    for (const call of delta.tool_calls ?? []) {
      if (!call || typeof call !== "object") continue;
      const key = call.index ?? 0;
      let block = this.toolCalls.get(key);
      if (!block) {
        block = {
          id: call.id ?? `call_${key}`,
          name: call.function?.name ?? "",
          argsBuffer: "",
          emitted: false,
        };
        this.toolCalls.set(key, block);
      }
      if (call.id && block.id === `call_${key}`) block.id = call.id;
      if (call.function?.name && !block.name) block.name = call.function.name;
      if (typeof call.function?.arguments === "string") {
        block.argsBuffer += call.function.arguments;
      }
    }

    if (choice.finish_reason) {
      this.finishReason = FINISH_REASON[choice.finish_reason] ?? "STOP";
    }

    return out;
  }

  // Close out: flush any pending tool calls, then a terminal candidate carrying
  // finishReason + usageMetadata. Idempotent.
  finish() {
    if (this.finished) return "";
    this.finished = true;
    let out = "";
    for (const block of this.toolCalls.values()) {
      if (!block.emitted) out += this.flushToolCall(block);
    }
    out += dataLine({
      candidates: [
        {
          content: { role: "model", parts: [] },
          finishReason: this.finishReason,
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: this.usage.promptTokenCount,
        candidatesTokenCount: this.usage.candidatesTokenCount,
        totalTokenCount: this.usage.promptTokenCount + this.usage.candidatesTokenCount,
        cachedContentTokenCount: this.usage.cachedTokenCount,
      },
      modelVersion: this.slug,
    });
    return out;
  }
}

// Convenience: translate an entire upstream byte stream to Gemini SSE and write
// it to the response. Mirrors the Anthropic pipeStream's structure.
//
// An OpenAIStreamGuard valves the raw upstream bytes: nothing is forwarded to
// the translator until the stream proves itself usable (real text, reasoning,
// or a complete tool call). A stream that ends while still holding — the
// truncation shape — returns a retryable outcome instead of fabricating a
// terminal candidate, so the keep-alive caller can retry before any Gemini
// bytes reach the client.
export async function translateGeminiStream(upstreamBody, slug, write, options = {}) {
  const translator = new GeminiStreamTranslator(slug);
  const parser = new SSEParser();
  const decoder = new TextDecoder();
  const guard = new OpenAIStreamGuard({ holdEntireTurn: options.holdEntireTurn === true });
  const onFirstChunk = options.onFirstChunk;
  let firstChunkObserved = false;
  let committed = false;
  const usage = () => ({
    prompt_tokens: translator.usage.promptTokenCount,
    completion_tokens: translator.usage.candidatesTokenCount,
    total_tokens: translator.usage.promptTokenCount + translator.usage.candidatesTokenCount,
    cached_tokens: translator.usage.cachedTokenCount,
  });

  const feed = (text) => {
    if (!text) return;
    for (const parsed of parser.push(text)) {
      const line = translator.chunk(parsed);
      if (line.length > 0) {
        if (!firstChunkObserved && onFirstChunk) {
          firstChunkObserved = true;
          try { onFirstChunk(); } catch { /* ignore */ }
        }
        committed = true;
        write(line);
      }
    }
  };

  try {
    for await (const chunk of upstreamBody) {
      const text = decoder.decode(chunk, { stream: true });
      const guarded = guard.chunk(text);
      // Enhanced hold: the bytes stay withheld, but the upstream first token
      // must still fire onFirstChunk — TPS divides by the generation segment,
      // not the whole request.
      if (!firstChunkObserved && onFirstChunk && options.holdEntireTurn && guard.hasProvenContent()) {
        firstChunkObserved = true;
        try { onFirstChunk(); } catch { /* ignore */ }
      }
      feed(guarded);
    }
    feed(guard.chunk(decoder.decode()));

    const verdict = guard.finish();
    if (verdict.action === "empty" || verdict.action === "reject") {
      // No provable content before the stream ended — including a pure
      // tool-call turn whose held bytes never validated. Do NOT call
      // finish(): fabricating a terminal candidate would present truncation
      // as a normal completion. Surface as retryable so the caller retries
      // cleanly; the guard's reason distinguishes the failure shape.
      return {
        ok: false,
        retryable: true,
        reason: verdict.reason || (verdict.action === "reject" ? "incomplete_tool_call" : "empty_stream"),
        error: verdict.error,
        usage: usage(),
      };
    }
    // pass / error: release the withheld terminator tail, then close out.
    if (verdict.tail) feed(verdict.tail);
    if (verdict.action === "error") {
      if (verdict.truncated) {
        // The content was cut (mid-word, or tool args that never parse).
        // Emit a legible error candidate — NOT a clean finishReason: STOP,
        // which would present the truncation as a normal completion — and
        // surface the fault so the caller latches a 502 on the panel.
        committed = true;
        write(dataLine({
          candidates: [
            {
              content: { role: "model", parts: [{ text: `[stream truncated] ${verdict.error?.error?.message ?? ""}`.trim() }] },
              finishReason: "STOP",
              index: 0,
            },
          ],
        }));
        return { ok: false, error: new Error(verdict.error?.error?.message || "the upstream stream was truncated"), usage: usage() };
      }
      // Malformation only surfaced after content was already committed: emit a
      // legible error candidate instead of fabricating a clean finish.
      committed = true;
      write(dataLine({
        candidates: [
          { content: { role: "model", parts: [{ text: "[stream malformed]" }] }, finishReason: "STOP", index: 0 },
        ],
      }));
      return { ok: true, usage: usage() };
    } else {
      const finalTail = translator.finish();
      if (finalTail.length > 0) {
        if (!firstChunkObserved && onFirstChunk) {
          firstChunkObserved = true;
          try { onFirstChunk(); } catch { /* ignore */ }
        }
        write(finalTail);
      }
    }
    return { ok: true, usage: usage() };
  } catch (err) {
    // Upstream died mid-stream. If nothing was committed, the caller can retry;
    // otherwise emit a minimal error candidate so the client surfaces the failure.
    if (!committed) {
      return { ok: false, retryable: true, reason: "stream_error_before_content", usage: usage() };
    }
    try {
      write(
        dataLine({
          candidates: [
            { content: { role: "model", parts: [{ text: "[stream interrupted]" }] }, finishReason: "STOP", index: 0 },
          ],
        }),
      );
    } catch {
      /* socket already gone */
    }
    return { ok: false, error: err, usage: usage() };
  }
}
