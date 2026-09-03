// Gemini REST <-> OpenAI Chat Completions protocol translation for the antigravity
// (agy) Gemini API-key frontend. Pure functions only. No IO, no network.
//
// The relay speaks the Google Gemini REST API to agy and OpenAI Chat Completions
// to the upstream store provider (every store provider is openai-compatible).
// Only the fields agy actually emits are translated; anything else is dropped.
//
// `modelId` passed to geminiToOpenAI is the bare upstream store model id produced
// by the alias resolver — never the agy slug, never the wire path.
//
// Real agy request shape (Phase 0 capture, 2026-08-19):
//   {
//     contents: [{ role, parts: [{ text } | { functionCall } | { functionResponse } | { inlineData }] }],
//     systemInstruction: { parts: [{ text }] },
//     tools: [{ functionDeclarations: [{ name, description, parametersJsonSchema }] }],
//     toolConfig: { functionCallingConfig: { mode, allowedFunctionNames } },
//     generationConfig: { temperature, topP, topK, maxOutputTokens, stopSequences, candidateCount, thinkingConfig: { thinkingBudget, includeThoughts } }
//   }

// ---------- Gemini request -> OpenAI request ----------

// Map a Gemini content part to OpenAI message content pieces. Text becomes a
// string or text part; inlineData/fileData become image_url parts; functionCall
// and functionResponse are handled at the message level, not here.
function convertPartToOpenAI(part) {
  if (part === null || typeof part !== "object") return null;
  if (part.text !== undefined) {
    return { type: "text", text: String(part.text) };
  }
  if (part.inlineData) {
    return {
      type: "image_url",
      image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` },
    };
  }
  if (part.fileData) {
    return { type: "image_url", image_url: { url: part.fileData.fileUri } };
  }
  return null;
}

const GEMINI_ROLE_TO_OPENAI = { user: "user", model: "assistant", function: "tool" };

// Synthetic tool_call id for a functionCall/functionResponse that carries no
// id: `call_${name}` for the FIRST same-name occurrence inside one content,
// `call_${name}__2`/`__3`/... for later ones, so parallel same-name calls keep
// distinct ids. The scheme is deliberately per-content (never global): a lone
// same-name call in any other content keeps the bare id, so cross-turn history
// and the by-name functionResponse fallback stay byte-identical to the
// historical unsuffixed form.
function syntheticToolCallId(name, occurrenceIndex) {
  return occurrenceIndex === 0 ? `call_${name}` : `call_${name}__${occurrenceIndex + 1}`;
}

// Convert one Gemini content entry into one or more OpenAI messages. A Gemini
// assistant turn can carry both text and functionCall parts; that fans out into
// an assistant message (text + tool_calls) here. A Gemini user turn carrying
// functionResponse parts becomes standalone role:"tool" messages (mirroring how
// the Anthropic translator handles tool_result).
function convertContent(content) {
  const role = GEMINI_ROLE_TO_OPENAI[content.role] ?? "user";
  const parts = Array.isArray(content.parts) ? content.parts : [];

  const textParts = [];
  const functionCalls = [];
  const functionResponses = [];
  const imageParts = [];
  for (const part of parts) {
    if (part && typeof part === "object") {
      if (part.functionCall) functionCalls.push(part.functionCall);
      else if (part.functionResponse) functionResponses.push(part.functionResponse);
      else {
        const converted = convertPartToOpenAI(part);
        if (converted) {
          if (converted.type === "text") textParts.push(converted);
          else imageParts.push(converted);
        }
      }
    }
  }

  const out = [];

  // Build the assistant tool_calls first so we can generate consistent IDs
  // that the tool results can reference. The tool_call id must match between
  // the assistant's tool_calls and the subsequent role:"tool" messages.
  // Parallel same-name calls would otherwise collide on `call_${name}`, so
  // same-name calls are numbered by occurrence order (see
  // syntheticToolCallId).
  const callOccurrence = new Map();
  const assistantToolCalls = functionCalls.map((call) => {
    const occurrence = callOccurrence.get(call.name) ?? 0;
    callOccurrence.set(call.name, occurrence + 1);
    return {
      id: typeof call.id === "string" ? call.id : syntheticToolCallId(call.name, occurrence),
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    };
  });

  // functionResponse parts become role:"tool" messages. When fr.id is missing
  // (agy's SDK may not echo back the tool_call id), fall back to the synthetic
  // ID scheme above so the LLM can correlate the result with the call: a lone
  // same-name response pairs with the bare `call_${name}`, and same-name
  // responses pair back to same-name calls by occurrence order (second ->
  // `call_${name}__2`, ...). Using bare `fr.name` would mismatch the
  // assistant's id and cause the LLM to re-issue the call.
  const responseOccurrence = new Map();
  for (const fr of functionResponses) {
    const occurrence = responseOccurrence.get(fr.name) ?? 0;
    responseOccurrence.set(fr.name, occurrence + 1);
    let toolCallId;
    if (typeof fr.id === "string" && fr.id.length > 0) {
      toolCallId = fr.id;
    } else {
      // Match the synthetic ID from the tool_calls block above
      toolCallId = syntheticToolCallId(fr.name, occurrence);
    }
    out.push({
      role: "tool",
      tool_call_id: toolCallId,
      content: typeof fr.response === "string" ? fr.response : JSON.stringify(fr.response ?? {}),
    });
  }

  if (assistantToolCalls.length > 0) {
    const assistantContent =
      textParts.length > 0
        ? textParts.length === 1 && imageParts.length === 0
          ? textParts[0].text
          : [...textParts, ...imageParts]
        : imageParts.length > 0
          ? imageParts
          : null;
    out.push({
      role: "assistant",
      content: assistantContent,
      tool_calls: assistantToolCalls,
    });
  } else if (textParts.length > 0 || imageParts.length > 0) {
    const content =
      textParts.length === 1 && imageParts.length === 0
        ? textParts[0].text
        : [...textParts, ...imageParts];
    out.push({ role, content });
  }

  return out;
}

// Gemini tools[].functionDeclarations[] use parametersJsonSchema (a JSON Schema).
// OpenAI tools use function.parameters (also a JSON Schema). The shapes are
// compatible; pass through.
function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = [];
  for (const entry of tools) {
    if (!entry || typeof entry !== "object") continue;
    const decls = Array.isArray(entry.functionDeclarations) ? entry.functionDeclarations : [];
    for (const decl of decls) {
      if (!decl || typeof decl.name !== "string") continue;
      converted.push({
        type: "function",
        function: {
          name: decl.name,
          description: decl.description ?? "",
          parameters: decl.parametersJsonSchema ?? decl.parameters ?? { type: "object", properties: {} },
        },
      });
    }
  }
  return converted.length > 0 ? converted : undefined;
}

function convertToolConfig(toolConfig) {
  const mode = toolConfig?.functionCallingConfig?.mode;
  switch (mode) {
    case "AUTO":
      return "auto";
    case "ANY":
      return "required";
    case "NONE":
      return "none";
    default:
      return undefined;
  }
}

function convertGenerationConfig(gc) {
  if (!gc || typeof gc !== "object") return {};
  const out = {};
  if (typeof gc.temperature === "number") out.temperature = gc.temperature;
  if (typeof gc.topP === "number") out.top_p = gc.topP;
  // topK has no OpenAI equivalent; dropped.
  if (typeof gc.maxOutputTokens === "number") out.max_tokens = gc.maxOutputTokens;
  if (Array.isArray(gc.stopSequences) && gc.stopSequences.length > 0) out.stop = gc.stopSequences;
  // candidateCount > 1 has no OpenAI equivalent; dropped (n is rarely supported).
  // thinkingConfig has no OpenAI equivalent; reasoning is fully upstream-controlled.
  return out;
}

export function geminiToOpenAI(body, modelId) {
  const messages = [];

  const sysText = Array.isArray(body?.systemInstruction?.parts)
    ? body.systemInstruction.parts
        .filter((p) => p && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
    : "";
  if (sysText.length > 0) messages.push({ role: "system", content: sysText });

  for (const content of body?.contents ?? []) {
    if (content === null || typeof content !== "object") continue;
    messages.push(...convertContent(content));
  }

  const request = { model: modelId, messages };

  const sampling = convertGenerationConfig(body?.generationConfig);
  Object.assign(request, sampling);

  const tools = convertTools(body?.tools);
  if (tools) request.tools = tools;
  const toolChoice = convertToolConfig(body?.toolConfig);
  if (toolChoice !== undefined) request.tool_choice = toolChoice;

  return request;
}

// ---------- OpenAI response -> Gemini response ----------

const FINISH_REASON = {
  stop: "STOP",
  length: "MAX_TOKENS",
  tool_calls: "STOP",
  function_call: "STOP",
  content_filter: "SAFETY",
};

function parseToolArgs(raw) {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparsed_arguments: raw };
  }
}

// Non-streaming. agy always streams in practice, but a correct non-streaming
// response is needed for the /countTokens-style single-shot path and for clients
// that request generateContent without alt=sse.
export function openAIToGemini(response, slug) {
  const choice = response?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const parts = [];

  if (typeof message.content === "string" && message.content.length > 0) {
    parts.push({ text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    if (!call || typeof call !== "object") continue;
    parts.push({
      functionCall: {
        name: call.function?.name ?? "",
        args: parseToolArgs(call.function?.arguments),
        id: call.id,
      },
    });
  }

  const usage = response?.usage ?? {};
  // Cached-token fallback chain, mirroring agent-metrics' aggregate tracker:
  // different upstreams report cache hits under different OpenAI-shape keys.
  const cachedTokens = Number(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.prompt_cache_hit_tokens ??
      usage.cached_tokens ??
      0,
  ) || 0;
  return {
    candidates: [
      {
        content: { role: "model", parts: parts.length > 0 ? parts : [{ text: "" }] },
        finishReason: FINISH_REASON[choice.finish_reason] ?? "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: usage.prompt_tokens ?? 0,
      candidatesTokenCount: usage.completion_tokens ?? 0,
      totalTokenCount: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
      cachedContentTokenCount: cachedTokens,
    },
    // Echo the slug agy asked for so it recognises the response.
    modelVersion: slug,
  };
}

// Gemini error body shape (Google's REST convention). Never carries a key,
// ciphertext, token or raw upstream body — same secret boundary as the other
// frontends.
export function geminiError(code, message) {
  return { error: { code, message, status: "INVALID_ARGUMENT" } };
}

// ---------- discovery ----------

// GET /v1beta/models payload. agy does not consume this in API-key mode (its
// allowlist is hardcoded), but a correct list response is useful for OpenAI-
// style clients pointed at the same Gemini frontend and for relay health checks.
export function buildGeminiModelsResponse(entries) {
  return {
    models: entries.map((entry) => ({
      name: `models/${entry.slug}`,
      displayName: entry.displayName,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
    })),
  };
}
