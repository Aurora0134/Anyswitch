// Shared keep-alive streaming pipeline for all three relay frontends
// (OpenAI passthrough, resident Anthropic, per-launch Anthropic).
//
// One parameterized pipe (pipeGuardedStream) plus one
// parameterized keep-alive retry loop (runStreamWithKeepAlive); each server
// contributes only a thin channel descriptor carrying its wire format, error
// body shape, log labels and tracker bookkeeping. Behavior is the union of
// the three former per-server copies — flag semantics, silent 5xx retries and
// tracker/log semantics are unchanged.
//
// Common guarantees preserved from the copies:
//   - OpenAIStreamGuard valves the upstream bytes; nothing is forwarded until
//     the stream proves itself usable (holdEntireTurn under enhanced mode).
//   - committed means real content bytes were sent; keep-alive pings do not
//     count, so a pre-content fault stays retryable.
//   - A stream that ends while still holding surfaces as retryable instead of
//     fabricating terminators; a malformation after content was delivered
//     terminates with a structured error frame instead of [DONE].
//   - The retry loop latches the 502 fault exactly once, at exhaustion; a
//     departed client records an abort instead of a fault.

import { OpenAIStreamGuard } from "./openai-stream-guard.mjs";
import { StreamTranslator, SSEParser, sseEvent } from "./stream.mjs";
import { computeRetryDelay } from "./keepalive-backoff.mjs";
import { openAIError } from "./openai-handler.mjs";
import { errorBody } from "./handler.mjs";

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

// Backoff sleep that an AbortSignal can cut short.
export function sleepWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Pipe an upstream OpenAI SSE stream to the client, either verbatim (OpenAI
// passthrough) or translated to Anthropic SSE events. Returns an outcome
// describing whether the stream committed content, ended retryably before any
// content, or failed terminally. The keep-alive loop owns the retry decision;
// tracker recordEnd lives here for the OpenAI passthrough and in the channel's
// onSettled slot for the Anthropic channels (unchanged from the copies).
//
// opts:
//   format:  "openai" (verbatim + raw-line usage scan, pipe records tracker
//            ends itself) | "anthropic" (StreamTranslator translation)
//   wireId:  Anthropic channel only — translator session id
//   enhanced: whole-turn hold (Plan A anti-truncation)
//   pings:   emit ": ping" SSE comments while the turn is held (OpenAI and
//            per-launch Anthropic channels; the resident Anthropic channel
//            sends no pings)
export async function pipeGuardedStream(res, upstreamBody, { format, wireId, enhanced = false, pings = false, tracker = null, abortController = null }) {
  const isOpenAI = format === "openai";
  const guard = new OpenAIStreamGuard({ holdEntireTurn: enhanced });
  const translator = isOpenAI ? null : new StreamTranslator(wireId);
  const parser = isOpenAI ? null : new SSEParser();
  const decoder = new TextDecoder();
  let committed = false; // real content bytes were sent (pings do not count)
  let firstChunkObserved = false;
  let usageExtracted = null;
  let clientAborted = false;
  let sseBuffer = ""; // OpenAI passthrough: raw-line buffer for usage extraction

  // Take the stream lock ourselves: the pipe reads through this reader, and a
  // client abort cancels through the SAME lock holder. Node 24 rejects (rather
  // than throws) a stream-level cancel() while the stream is locked by an
  // in-flight read — that rejected promise escaped the old try/catch, surfaced
  // as an unhandledRejection, and killed the relay process the moment a client
  // pressed ESC mid-stream. Bodies without getReader (async-generator mocks,
  // node streams) keep the for-await path below.
  const streamReader = typeof upstreamBody?.getReader === "function" ? upstreamBody.getReader() : null;

  const cancelUpstream = () => {
    try {
      const pending = (streamReader ?? upstreamBody)?.cancel?.();
      pending?.catch?.(() => {}); // a refused cancel is never fatal
    } catch {
      // stream body might not support cancel or already closed
    }
  };

  const onResClose = () => {
    // Watch res, not req: on Node >= 16 the IncomingMessage "close" event
    // fires as soon as the request body is consumed, so a listener attached
    // after readBody() never fires — the previous clientAborted detection was
    // dead code. The ServerResponse "close" does fire when the client socket
    // is destroyed mid-response, and also after a normal finish (guarded by
    // the writableEnded check below).
    if (!res.writableEnded) {
      clientAborted = true;
      cancelUpstream();
      if (isOpenAI) tracker?.recordEnd({ aborted: true, usage: usageExtracted });
    }
  };

  res.on("close", onResClose);

  const commit = () => {
    if (!committed) {
      if (!res.headersSent) {
        res.writeHead(200, SSE_HEADERS);
      }
      committed = true;
    }
  };

  const markFirstChunk = () => {
    if (!firstChunkObserved) {
      firstChunkObserved = true;
      tracker?.recordFirstChunk();
    }
  };

  // OpenAI passthrough: forward guarded text verbatim. firstChunk is marked by
  // the caller before emit, never inside it — under whole-turn hold the pass
  // verdict flushes the turn through emit without a recordFirstChunk, exactly
  // as the original copy did.
  const emit = (text) => {
    if (!text) return;
    commit();
    res.write(text);
  };

  // Anthropic: parse + translate guarded text; only real translated events
  // count as a first chunk.
  const feed = (text) => {
    if (!text) return;
    for (const parsed of parser.push(text)) {
      if (parsed?.usage) usageExtracted = parsed.usage;
      const events = translator.chunk(parsed);
      if (events.length > 0) {
        markFirstChunk();
        commit();
        res.write(events);
      }
    }
  };

  // Plan A (enhanced anti-truncation): the whole turn is withheld until the
  // guard's verdict, so the client would otherwise see dead air for the
  // entire generation. SSE comment pings keep the connection observably
  // alive; they commit the headers, so any terminal fault after this point
  // must ride an SSE error frame instead of a 5xx status line.
  let pingTimer = null;
  if (pings) {
    const ping = () => {
      if (clientAborted || res.destroyed || res.writableEnded) return;
      try {
        if (!res.headersSent) {
          res.writeHead(200, SSE_HEADERS);
        }
        res.write(": ping\n\n");
      } catch {
        // client socket already gone
      }
    };
    ping();
    pingTimer = setInterval(ping, 5000);
    pingTimer.unref?.();
  }

  // OpenAI passthrough only: scan raw decoded lines for a usage payload,
  // including bytes the guard still holds.
  const processSseLine = (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    if (data.includes('"usage"')) {
      try {
        const parsed = JSON.parse(data);
        if (parsed && parsed.usage) {
          usageExtracted = parsed.usage;
        }
      } catch {
        // ignore parsing error for metrics extraction
      }
    }
  };

  const processChunk = (chunk) => {
    const text = decoder.decode(chunk, { stream: true });

    if (isOpenAI) {
      // Buffer and process complete lines across TCP packet boundaries
      sseBuffer += text;
      let newlineIdx;
      while ((newlineIdx = sseBuffer.indexOf("\n")) !== -1) {
        const line = sseBuffer.slice(0, newlineIdx).replace(/\r$/, "");
        sseBuffer = sseBuffer.slice(newlineIdx + 1);
        processSseLine(line);
      }
      const safe = guard.chunk(text);
      // Enhanced hold: the bytes stay withheld (safe stays empty), but the
      // upstream first token must still timestamp the tracker — TPS divides
      // by the generation segment, not the whole request.
      if (safe) markFirstChunk();
      else if (enhanced && guard.hasProvenContent()) markFirstChunk();
      emit(safe);
    } else {
      const guarded = guard.chunk(text);
      // Enhanced hold: the bytes stay withheld, but the upstream first token
      // must still timestamp the tracker — TPS divides by the generation
      // segment, not the whole request.
      if (enhanced && guard.hasProvenContent()) markFirstChunk();
      feed(guarded);
    }
  };

  try {
    if (streamReader) {
      for (;;) {
        if (clientAborted || abortController?.signal?.aborted) break;
        // A concurrent cancelUpstream() resolves this pending read with
        // done:true, so the loop exits promptly on client abort.
        const { done, value } = await streamReader.read();
        if (done) break;
        processChunk(value);
      }
    } else {
      for await (const chunk of upstreamBody) {
        if (clientAborted || abortController?.signal?.aborted) break;
        processChunk(chunk);
      }
    }

    const flushTail = decoder.decode();
    if (flushTail) {
      if (isOpenAI) {
        sseBuffer += flushTail;
        const safeTail = guard.chunk(flushTail);
        if (safeTail) markFirstChunk();
        else if (enhanced && guard.hasProvenContent()) markFirstChunk();
        emit(safeTail);
      } else {
        const guarded = guard.chunk(flushTail);
        if (enhanced && guard.hasProvenContent()) markFirstChunk();
        feed(guarded);
      }
    }
    if (isOpenAI && sseBuffer.trim().length > 0) {
      processSseLine(sseBuffer.replace(/\r$/, ""));
      sseBuffer = "";
    }

    if (clientAborted || abortController?.signal?.aborted) {
      if (isOpenAI) tracker?.recordEnd({ aborted: true, usage: usageExtracted });
      return { outcome: "terminal", committed, clientAborted: true, usage: usageExtracted };
    }

    const verdict = guard.finish();

    // 1/2. The stream ended while still holding (incomplete tool call,
    // mid-turn cut under whole-turn hold, or a clean but provably empty
    // stream) -> retryable candidate, as long as no content was delivered.
    // The Anthropic copies asked the guard only — holding implies uncommitted
    // there — while the OpenAI copy also tested !committed explicitly; both
    // conditions are preserved.
    if (verdict.action === "reject" || verdict.action === "empty") {
      if (!isOpenAI || !committed) {
        return {
          outcome: "retryable",
          reason: verdict.reason || (verdict.action === "reject" ? "incomplete_tool_call" : "empty_stream"),
          committed: isOpenAI ? false : committed,
          error: verdict.error,
          usage: usageExtracted,
        };
      }
    }

    // Anthropic: pass / error both release the withheld terminator tail first.
    if (!isOpenAI && verdict.tail) feed(verdict.tail);

    // 3. Normal healthy stream completion
    if (verdict.action === "pass") {
      if (isOpenAI) {
        commit();
        emit(verdict.tail);
        tracker?.recordEnd({ usage: usageExtracted });
      } else {
        const finalEvents = translator.finish();
        if (finalEvents.length > 0) {
          commit();
          res.write(finalEvents);
        }
      }
      return { outcome: "ok", committed, usage: usageExtracted };
    }

    // Malformation only surfaced after content was already delivered. A
    // truncated=true verdict (mid-word cut, or tool args that never parse)
    // is an upstream fault: the error frame replaces [DONE] / message_stop
    // client-side, and the panel sees a 502 instead of a healthy-looking
    // completion.
    if (isOpenAI) {
      emit(verdict.errorLine);
      const message = verdict.error?.error?.message || "the upstream stream ended malformed after content was delivered";
      if (verdict.truncated) {
        tracker?.recordEnd({ status: 502, error: { status: 502, message }, usage: usageExtracted });
      } else {
        tracker?.recordEnd({ usage: usageExtracted });
      }
      return {
        outcome: verdict.truncated ? "terminal" : "ok",
        committed: true,
        error: verdict.truncated ? message : undefined,
        usage: usageExtracted,
      };
    }
    commit();
    // The guard's error is OpenAI-shaped; this channel speaks Anthropic SSE,
    // so it must go out as an `event: error` frame. A bare data line without
    // an event name reads as an unterminated stream to Claude Code, which
    // misreports it as "ended before any complete data" and falls back to an
    // unprotected non-streaming retry.
    const errorType = verdict.error?.error?.type || "api_error";
    const errorMessage = verdict.error?.error?.message
      || "the upstream stream was truncated after content was delivered";
    res.write(sseEvent("error", errorBody(errorType, errorMessage)));
    if (verdict.truncated) {
      // The content was cut (mid-word, or tool args that never parse). The
      // error event above replaces message_stop client-side; surface the
      // fault so the caller latches a 502 on the panel.
      return { outcome: "terminal", committed, error: errorMessage, usage: usageExtracted };
    }
    return { outcome: "ok", committed, usage: usageExtracted };
  } catch (streamErr) {
    if (clientAborted || abortController?.signal?.aborted) {
      if (isOpenAI) tracker?.recordEnd({ aborted: true, usage: usageExtracted });
      return { outcome: "terminal", committed, clientAborted: true, usage: usageExtracted };
    }

    // Upstream died before any content was delivered -> retryable candidate
    if (!committed) {
      return { outcome: "retryable", reason: "stream_error_before_content", committed, error: isOpenAI ? streamErr : undefined, usage: usageExtracted };
    }

    // Upstream died mid-stream after content was already delivered -> emit an
    // error frame and terminate
    if (isOpenAI) {
      tracker?.recordEnd({ status: 502, error: { status: 502, message: streamErr?.message || "upstream stream error" }, usage: usageExtracted });
      try {
        res.write(`data: ${JSON.stringify(openAIError("api_error", "the upstream stream failed mid-response"))}\n\n`);
      } catch {
        // socket already gone
      }
      return { outcome: "terminal", committed, error: streamErr };
    }
    commit();
    res.write(sseEvent("error", errorBody("api_error", "the upstream stream failed mid-response")));
    return { outcome: "terminal", committed, error: "the upstream stream failed mid-response", usage: usageExtracted };
  } finally {
    if (pingTimer) clearInterval(pingTimer);
    res.removeListener("close", onResClose);
    // Belt-and-braces upstream teardown for early exits (client abort, stream
    // error). On normal completion the stream is already closed and this
    // resolves as a no-op.
    cancelUpstream();
    if (committed) {
      res.end();
    }
  }
}

// Keep-alive retry loop shared by all three channels: retry an empty /
// pre-content upstream (bounded by keepAlive.maxRetries, with exponential
// backoff + jitter) before latching a fault, silently absorb a one-shot
// upstream 5xx, and let a departed client abort instead of faulting.
//
// The channel descriptor carries everything wire-specific:
//   callUpstream()                    -> one upstream attempt's result
//   callUpstreams                     -> pool routing (phase 2): an array of
//                                        { memberId, call } entries, one per
//                                        candidate pool member, sticky first.
//                                        Each member gets its own keep-alive
//                                        budget; a member whose budget is
//                                        spent on a retryable fault (or that
//                                        answers a failover-class status)
//                                        backs off to the next member, and
//                                        only the LAST member's failure goes
//                                        terminal. Overrides callUpstream.
//   shouldFailover(result)            -> pool routing: whether an error status
//                                        result backs off to the next member
//                                        (default: status >= 500). Channels
//                                        pass a plan-kind classifier: chain
//                                        plans fail over on any 4xx, pool
//                                        plans keep other 4xx terminal.
//   onMemberSuccess(member)           -> pool routing: a member's stream
//                                        completed ok (sticky-table update)
//   onMemberFailover(member, reason)  -> optional: a member's failure actually
//                                        advanced to the next member. Chain
//                                        plans use it to feed the node-level
//                                        failure counter that gates demotion
//                                        (只计真正切换的失败，最后一个成员的
//                                        终端失败不在此列).
//   memberNoun                        -> failover-log noun fallback (default
//                                        "pool member"); callUpstreams entries
//                                        may carry their own — chain plans tag
//                                        bare channel nodes "chain node".
//   pipe(result, keepAliveConfig)     -> forward result.stream; outcome object
//   onCallError(err)                  -> upstream call threw: recordEnd + 500
//   onTerminalResult(result, member?) -> status >= 400 or non-stream terminal
//   onSettled(outcome, attempt)       -> non-retryable pipe outcome
//   exhaustedMessage(lastOutcome, retryCtx) -> definitive 502 message;
//                                        retryCtx = { mode, maxRetries,
//                                        attemptsUsed } lets the wording tell
//                                        a spent retry budget from a never-
//                                        configured one
//   onExhaustedLog(message, lastOutcome, retryCtx) (optional)
//   sendExhausted(message, lastOutcome)
//   logLabel                          -> "request" / "anthropic request" / ...
export async function runStreamWithKeepAlive(res, channel) {
  const { deps, tracker, abortController, pipe, logLabel } = channel;
  const keepAliveConfig = deps?.getKeepAliveConfig ? deps.getKeepAliveConfig() : { enabled: true, maxRetries: 1, backoffMs: 500 };
  const maxRetries = keepAliveConfig.enabled ? (keepAliveConfig.maxRetries ?? 1) : 0;
  const backoffMs = keepAliveConfig.backoffMs ?? 500;
  const logger = deps?.logger;

  // Single-provider channels carry one callUpstream; normalize both shapes to
  // a one-entry member list so the loop below is identical for both.
  const callUpstreams = channel.callUpstreams ?? [{ memberId: null, call: channel.callUpstream }];
  const shouldFailover = channel.shouldFailover ?? ((result) => result.status >= 500);

  let lastOutcome = null;
  // Attempts actually made by the member that falls to exhaustion: the wording
  // and the exhausted counter below must not claim a spent retry budget when
  // none was configured (keep-alive off tier or maxRetries 0).
  let attemptsUsed = 0;

  // A member's definitive failure before the last member: count the failed
  // attempt against the actual member and log the failover, then advance.
  const noteMemberFailover = (member, reason, usage) => {
    tracker?.recordRetry?.({ reason, memberId: member.memberId ?? undefined, usage });
    logger?.warn?.(`keep-alive: ${logLabel} failing over from ${member.memberNoun ?? channel.memberNoun ?? "pool member"} "${member.memberId}" (${reason})`);
    channel.onMemberFailover?.(member, reason);
  };

  for (let memberIndex = 0; memberIndex < callUpstreams.length; memberIndex += 1) {
    const member = callUpstreams[memberIndex];
    // Auto-route attribution: pipe-internal terminal ends carry no memberId,
    // so the tracker learns which member is being attempted. Single-provider
    // channels carry memberId null, which clears any stale value.
    tracker?.setCurrentMember?.(member.memberId ?? null);
    const isLastMember = memberIndex === callUpstreams.length - 1;
    let advanceToNextMember = false;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      attemptsUsed = attempt + 1;
      if (abortController.signal.aborted || res.writableEnded) {
        // Race guard: the abort can land between backoff sleep resolving and
        // this check. With the fault latch deferred, this return must still
        // close the tracker request or it leaks an in-flight entry.
        tracker?.recordEnd?.({ aborted: true });
        return;
      }

      let result;
      try {
        result = await member.call();
      } catch (err) {
        if (abortController.signal.aborted) {
          tracker?.recordEnd({ aborted: true });
          return;
        }
        channel.onCallError(err);
        return;
      }

      if (result.status >= 400 || !result.stream) {
        if (result.status >= 500 && attempt < maxRetries && !res.writableEnded && !res.destroyed && !abortController.signal.aborted) {
          // Transient upstream fault (e.g. a Cloudflare 522 when the provider's
          // origin hiccups). Nothing has been committed to the client response
          // on this attempt yet, so retry silently — a one-shot 5xx is exactly
          // the kind of blip a single retry absorbs.
          tracker?.recordRetry?.({ reason: `upstream_${result.status}`, attempt: attempt + 1, usage: result.body?.usage, memberId: member.memberId ?? undefined });
          logger?.warn?.(`keep-alive: retrying ${logLabel} (upstream status ${result.status}, attempt ${attempt + 1}/${maxRetries})`);
          try {
            await sleepWithAbort(computeRetryDelay(backoffMs, attempt + 1), abortController.signal);
          } catch {
            tracker?.recordEnd({ aborted: true });
            return;
          }
          continue;
        }
        if (!isLastMember && result.status >= 400 && shouldFailover(result)) {
          // Pool routing: channel-level fault (5xx past the member's own
          // budget, or a failover-class 4xx) — back off to the next member.
          // What counts as failover-class is plan-kind: chain plans treat
          // every upstream 4xx as node-level, pool plans keep the other 4xx
          // request-shaped (terminal passthrough below even with members
          // left).
          noteMemberFailover(member, `upstream_${result.status}`, result.body?.usage);
          advanceToNextMember = true;
          break;
        }
        // Non-stream or non-2xx status is terminal for the stream handler. A
        // non-stream success (per-launch Anthropic drives those through this
        // loop too) counts for pool stickiness, same as a piped ok stream.
        if (result.status < 400) channel.onMemberSuccess?.(member);
        channel.onTerminalResult(result, member);
        return;
      }

      // Stream received; attempt to forward via the channel's pipe
      const outcome = await pipe(result, keepAliveConfig);
      if (outcome.outcome !== "retryable" || outcome.reason !== "empty_stream" || attempt === 0) {
        lastOutcome = outcome;
      }

      if (outcome.outcome !== "retryable") {
        // Success or already committed/aborted/terminal. A committed stream
        // (real content bytes written) never fails over — the red line.
        if (outcome.outcome === "ok") channel.onMemberSuccess?.(member);
        channel.onSettled(outcome, attempt);
        return;
      }

      // Retryable failure detected before any content was delivered — unless the
      // client is already gone. Coding agents routinely drop the connection the
      // moment they have what they need (e.g. entering an ask-user confirmation
      // pause); that is not an upstream fault and must not latch a panel 502.
      if (res.destroyed || abortController.signal.aborted) {
        tracker?.recordEnd?.({ aborted: true, usage: outcome.usage });
        return;
      }

      // The fault is deliberately NOT latched at verdict time: a tracker
      // request records exactly one end, so an early 502 would make the
      // definitive outcome (client walking away during backoff, or a retry
      // recovering) invisible to the panel. Latch once, at exhaustion below.
      if (attempt < maxRetries && !res.writableEnded && !abortController.signal.aborted) {
        tracker?.recordRetry?.({ reason: outcome.reason, attempt: attempt + 1, usage: outcome.usage, memberId: member.memberId ?? undefined });
        logger?.warn?.(`keep-alive: retrying ${logLabel} (${outcome.reason}, attempt ${attempt + 1}/${maxRetries})`);
        try {
          await sleepWithAbort(computeRetryDelay(backoffMs, attempt + 1), abortController.signal);
        } catch {
          // Aborted during backoff sleep
          tracker?.recordEnd({ aborted: true });
          return;
        }
        continue;
      }

      // The member's keep-alive budget is spent on a retryable pre-content
      // fault. Pool routing: back off to the next member; the last member
      // falls out to the exhaustion path below.
      if (!isLastMember) {
        noteMemberFailover(member, outcome.reason, outcome.usage);
        advanceToNextMember = true;
      }
      break;
    }

    if (!advanceToNextMember) break;
  }

  // All keep-alive retries exhausted — the definitive terminal outcome for
  // the request, so the fault latches here and only here.
  if (res.destroyed || abortController.signal.aborted) {
    // The client left after the last attempt: the definitive outcome is the
    // abort, not the exhaustion. No fault may latch.
    tracker?.recordEnd?.({ aborted: true, usage: lastOutcome?.usage });
    return;
  }
  const lastMember = callUpstreams[callUpstreams.length - 1];
  const retryCtx = { mode: keepAliveConfig?.mode ?? "enhanced", maxRetries, attemptsUsed };
  const message = channel.exhaustedMessage(lastOutcome, retryCtx);
  tracker?.recordEnd?.({
    status: 502,
    error: { status: 502, message },
    usage: lastOutcome?.usage,
    memberId: lastMember.memberId ?? undefined,
  });
  // The exhausted counter only latches when the retry budget was actually
  // spent (≥2 attempts on the last member): with the off tier or maxRetries 0
  // nothing was exhausted, so an empty upstream must not pollute the metric.
  if (attemptsUsed > 1) tracker?.noteKeepAliveExhausted?.();
  channel.onExhaustedLog?.(message, lastOutcome, retryCtx);
  channel.sendExhausted(message, lastOutcome);
}

// ── Channel descriptors ────────────────────────────────────────────────────

// OpenAI passthrough channel (resident relay /openai/.../chat/completions).
// The pipe records tracker ends itself; the loop only logs and recovers.
// Pool routing (phase 2): the server passes callUpstreams (one callable per
// candidate member), a plan-kind shouldFailover classifier (chain: any 4xx
// fails over, pool: other 4xx stays terminal), and onMemberSuccess for the
// sticky-table update.
export function openAIStreamChannel({ res, tracker, abortController, deps, callUpstream, callUpstreams, shouldFailover, onMemberSuccess, onMemberFailover }) {
  const logger = deps?.logger;
  return {
    deps,
    tracker,
    abortController,
    callUpstream,
    callUpstreams,
    shouldFailover,
    onMemberSuccess,
    onMemberFailover,
    logLabel: "request",
    pipe: (result, keepAliveConfig) => {
      const enhanced = keepAliveConfig?.mode === "enhanced";
      return pipeGuardedStream(res, result.stream, { format: "openai", enhanced, pings: enhanced, tracker, abortController });
    },
    onCallError: (err) => {
      tracker?.recordEnd({ status: 500, error: { status: 500, message: err.message } });
      if (!res.headersSent) {
        sendJson(res, 500, openAIError("api_error", "the relay failed to handle this request"));
      }
    },
    onTerminalResult: (result, member) => {
      if (result.status >= 400) {
        tracker?.recordEnd({ status: result.status, error: { status: result.status, message: result.body?.error?.message || "Error" }, usage: result.body?.usage, memberId: member?.memberId ?? undefined });
      } else {
        tracker?.recordEnd({ status: result.status, usage: result.body?.usage });
      }
      if (res.headersSent) {
        // An earlier attempt's enhanced-mode pings already committed the SSE
        // headers; the definitive error must ride an SSE error line instead
        // of a status line the wire can no longer carry.
        try {
          res.write(`data: ${JSON.stringify(result.body)}\n\n`);
        } catch {
          // socket already gone
        }
        res.end();
      } else {
        sendJson(res, result.status, result.body);
      }
    },
    onSettled: (outcome, attempt) => {
      if (attempt > 0 && outcome.outcome === "ok") {
        tracker?.noteKeepAliveRecovery?.();
        logger?.info?.(`keep-alive: recovered on attempt ${attempt + 1}`);
      }
      if (outcome.outcome === "terminal" && outcome.error) {
        logger?.warn?.(`stream fault after content was delivered: ${outcome.error}`);
      }
    },
    exhaustedMessage: (lastOutcome, retryCtx) => {
      const retryableReason = lastOutcome?.reason;
      if (retryableReason && retryableReason !== "empty_stream" && retryableReason !== "stream_error_before_content" && lastOutcome.error) {
        return lastOutcome.error.error?.message || lastOutcome.error.message;
      }
      if (retryableReason === "stream_error_before_content") {
        return "the upstream stream failed before any content was delivered";
      }
      // "已耗尽" only after the retry budget was actually spent; a zero-retry
      // config (off tier or maxRetries 0) never retried and must say so.
      return (retryCtx?.attemptsUsed ?? 1) > 1
        ? "模型未返回任何内容 (上游流在首字前结束或为空，保活重试已耗尽)"
        : "模型未返回任何内容 (上游流在首字前结束或为空；未配置重试)";
    },
    onExhaustedLog: (message, lastOutcome, retryCtx) => {
      const head = (retryCtx?.attemptsUsed ?? 1) > 1
        ? "keep-alive: exhausted"
        : "keep-alive: empty upstream (no retry configured)";
      logger?.warn?.(`${head} (${lastOutcome?.reason ?? "empty_stream"}): ${message}`);
    },
    sendExhausted: (message, lastOutcome) => {
      // Under whole-turn hold the SSE headers were already committed by the
      // keep-alive pings, so the definitive error must ride an SSE data line,
      // not a 5xx status line the wire can no longer carry.
      if (res.headersSent) {
        try {
          res.write(`data: ${JSON.stringify(openAIError("api_error", message))}\n\n`);
        } catch {
          // socket already gone
        }
        res.end();
        return;
      }
      const retryableReason = lastOutcome?.reason;
      if (retryableReason && retryableReason !== "empty_stream" && retryableReason !== "stream_error_before_content" && lastOutcome.error) {
        sendJson(res, 502, lastOutcome.error);
      } else if (retryableReason === "stream_error_before_content") {
        sendJson(
          res,
          502,
          openAIError("api_error", "the upstream stream failed before any content was delivered"),
        );
      } else {
        // The final branch is exactly the empty-stream set of exhaustedMessage,
        // so the wording (spent budget vs 未配置重试) must come from `message`
        // rather than a private copy of the text.
        sendJson(res, 502, openAIError("api_error", message));
      }
    },
  };
}

// Anthropic channels (resident relay /v1/messages and per-launch relay).
// name/logLabel carry the two variants' log wording; the resident channel
// sends no keep-alive pings and stays silent once headers are committed at
// exhaustion, while the per-launch channel pings and rides an `event: error`
// frame — both quirks preserved from the copies.
// Pool routing (phase 2): the server passes callUpstreams (one callable per
// candidate member), a plan-kind shouldFailover classifier (chain: any 4xx
// fails over, pool: other 4xx stays terminal), and onMemberSuccess for the
// sticky-table update.
export function anthropicStreamChannel({ res, tracker, abortController, deps, callUpstream, callUpstreams, shouldFailover, onMemberSuccess, onMemberFailover, name, logLabel, pings, writeFrameWhenHeadersSent }) {
  const logger = deps?.logger;
  return {
    deps,
    tracker,
    abortController,
    callUpstream,
    callUpstreams,
    shouldFailover,
    onMemberSuccess,
    onMemberFailover,
    logLabel,
    pipe: (result, keepAliveConfig) => {
      const enhanced = keepAliveConfig?.mode === "enhanced";
      return pipeGuardedStream(res, result.stream, { format: "anthropic", wireId: result.wireId, enhanced, pings: pings && enhanced, tracker, abortController });
    },
    onCallError: (err) => {
      tracker?.recordEnd({ error: { status: 500, message: err?.message || "relay error" } });
      if (!res.headersSent) sendJson(res, 500, errorBody("api_error", "the relay failed to handle this request"));
    },
    onTerminalResult: (result, member) => {
      if (result.status >= 400) {
        tracker?.recordEnd({ status: result.status, error: { status: result.status, message: result.body?.error?.message || "Error" }, usage: result.body?.usage, memberId: member?.memberId ?? undefined });
      } else {
        tracker?.recordEnd({
          usage: result.body?.usage
            ? {
                prompt_tokens: result.body.usage.input_tokens,
                completion_tokens: result.body.usage.output_tokens,
                cache_read_input_tokens: result.body.usage.cache_read_input_tokens,
              }
            : undefined,
        });
      }
      if (res.headersSent) {
        // An earlier attempt already committed the SSE headers; the
        // definitive error must ride an `event: error` frame instead of a
        // status line the wire can no longer carry.
        try {
          res.write(sseEvent("error", result.body));
        } catch {
          // socket already gone
        }
        res.end();
      } else {
        sendJson(res, result.status, result.body);
      }
    },
    onSettled: (outcome, attempt) => {
      if (outcome.outcome === "ok") {
        tracker?.recordEnd?.({ usage: outcome.usage });
        if (attempt > 0) {
          tracker?.noteKeepAliveRecovery?.();
          logger?.info?.(`keep-alive: ${logLabel} recovered on attempt ${attempt + 1}`);
        }
      } else if (outcome.clientAborted) {
        tracker?.recordEnd?.({ aborted: true, usage: outcome.usage });
      } else {
        // Terminal fault: a mid-stream failure after content was committed.
        tracker?.recordEnd?.({ status: 502, error: { status: 502, message: outcome.error || "the upstream stream failed" }, usage: outcome.usage });
        logger?.warn?.(`${name} stream fault after content was delivered: ${outcome.error || "the upstream stream failed"}`);
      }
    },
    exhaustedMessage: anthropicExhaustedMessage,
    onExhaustedLog: (message, lastOutcome, retryCtx) => {
      const head = (retryCtx?.attemptsUsed ?? 1) > 1
        ? `${name} relay: keep-alive exhausted`
        : `${name} relay: keep-alive empty upstream (no retry configured)`;
      logger?.warn?.(`${head} (${lastOutcome?.reason ?? "empty_stream"}): ${message}`);
    },
    sendExhausted: (message) => {
      if (res.headersSent) {
        if (!writeFrameWhenHeadersSent) return;
        // Whole-turn hold committed the headers via keep-alive pings; the
        // definitive error must ride an `event: error` SSE frame instead of a
        // 5xx status line the wire can no longer carry.
        try {
          res.write(sseEvent("error", errorBody("api_error", message)));
        } catch {
          // socket already gone
        }
        res.end();
      } else {
        sendJson(res, 502, errorBody("api_error", message));
      }
    },
  };
}

// Exhaustion message for the Anthropic channel. retryCtx
// (from the keep-alive loop) separates a spent retry budget from a never-
// configured one — "已耗尽" must not claim retries that never ran.
function anthropicExhaustedMessage(lastOutcome, retryCtx) {
  let exhaustedMessage = (retryCtx?.attemptsUsed ?? 1) > 1
    ? "模型未返回任何内容 (上游流在首字前结束或为空，保活重试已耗尽)"
    : "模型未返回任何内容 (上游流在首字前结束或为空；未配置重试)";
  if (
    (lastOutcome?.reason === "incomplete_tool_call" ||
      lastOutcome?.reason === "truncated_tool_args" ||
      lastOutcome?.reason === "mid_word_truncation") &&
    lastOutcome.error
  ) {
    exhaustedMessage = lastOutcome.error.error?.message || lastOutcome.error.message || exhaustedMessage;
  } else if (lastOutcome?.reason === "stream_error_before_content") {
    exhaustedMessage = "the upstream stream failed before any content was delivered";
  }
  return exhaustedMessage;
}
