// Anthropic <-> OpenAI-compatible protocol translation.
// Pure functions only. No IO, no network.
//
// The relay speaks Anthropic Messages API to Claude and OpenAI Chat Completions
// to the upstream provider. Only an explicit allow-list of the fields Claude
// Code actually emits is translated; anything else is dropped. New fields must
// be added only when the client contract and relay behavior require them.
//
// The upstream model name is the bare <model-id>: never the wire ID, never
// prefixed with the provider id.

// ---------- Anthropic request -> OpenAI request ----------

// Anthropic content blocks -> OpenAI message content.
// A single text block collapses to a plain string (what most providers expect);
// mixed/multimodal content keeps the array form.
function convertContentToOpenAI(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text ?? "" });
    } else if (block.type === "image") {
      const source = block.source ?? {};
      if (source.type === "base64") {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${source.media_type};base64,${source.data}` },
        });
      } else if (source.type === "url") {
        parts.push({ type: "image_url", image_url: { url: source.url } });
      }
    }
  }
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

// Anthropic tool_use / tool_result blocks map onto OpenAI tool_calls and
// role:"tool" messages. Returns the list of OpenAI messages for one Anthropic
// message, because a single Anthropic message can fan out into several.
function convertMessage(message) {
  const role = message.role;
  const content = message.content;

  if (!Array.isArray(content)) {
    return [{ role, content: convertContentToOpenAI(content) }];
  }

  const toolUses = content.filter((b) => b && b.type === "tool_use");
  const toolResults = content.filter((b) => b && b.type === "tool_result");
  const plain = content.filter((b) => b && b.type !== "tool_use" && b.type !== "tool_result");

  const out = [];

  // tool_result blocks become standalone role:"tool" messages and must precede
  // any assistant content in the same turn.
  for (const result of toolResults) {
    out.push({
      role: "tool",
      tool_call_id: result.tool_use_id,
      content:
        typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content ?? ""),
    });
  }

  if (toolUses.length > 0) {
    const assistant = {
      role: "assistant",
      content: plain.length > 0 ? convertContentToOpenAI(plain) : null,
      tool_calls: toolUses.map((use) => ({
        id: use.id,
        type: "function",
        function: { name: use.name, arguments: JSON.stringify(use.input ?? {}) },
      })),
    };
    out.push(assistant);
  } else if (plain.length > 0) {
    out.push({ role, content: convertContentToOpenAI(plain) });
  }

  return out;
}

// `system` in Anthropic is a top-level field; OpenAI wants a leading message.
function convertSystem(system) {
  if (system === undefined || system === null) return null;
  if (typeof system === "string") {
    return system.length > 0 ? { role: "system", content: system } : null;
  }
  if (Array.isArray(system)) {
    const text = system
      .filter((b) => b && b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    return text.length > 0 ? { role: "system", content: text } : null;
  }
  return null;
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = tools
    .filter((t) => t && typeof t === "object" && typeof t.name === "string")
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
  return converted.length > 0 ? converted : undefined;
}

function convertToolChoice(toolChoice) {
  if (toolChoice === null || typeof toolChoice !== "object") return undefined;
  switch (toolChoice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: toolChoice.name } };
    case "none":
      return "none";
    default:
      return undefined;
  }
}

// `modelId` is the bare upstream model id produced by unpackWireId.
export function anthropicToOpenAI(body, modelId) {
  const messages = [];
  const system = convertSystem(body.system);
  if (system) messages.push(system);

  for (const message of body.messages ?? []) {
    if (message === null || typeof message !== "object") continue;
    messages.push(...convertMessage(message));
  }

  const request = { model: modelId, messages };

  // max_tokens is required by Anthropic and optional upstream; pass it through.
  if (typeof body.max_tokens === "number") request.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") request.temperature = body.temperature;
  if (typeof body.top_p === "number") request.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    request.stop = body.stop_sequences;
  }
  if (body.stream === true) request.stream = true;

  const tools = convertTools(body.tools);
  if (tools) request.tools = tools;
  const toolChoice = convertToolChoice(body.tool_choice);
  if (toolChoice !== undefined) request.tool_choice = toolChoice;

  return request;
}

// ---------- OpenAI response -> Anthropic response ----------

const STOP_REASON = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "end_turn",
};

function parseToolArguments(raw) {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Preserve the unparsable payload instead of inventing an empty object, so
    // a malformed upstream response is visible rather than silently normalised.
    return { __unparsed_arguments: raw };
  }
}

export function openAIToAnthropic(response, wireId) {
  const choice = response?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = [];

  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    if (call === null || typeof call !== "object") continue;
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function?.name ?? "",
      input: parseToolArguments(call.function?.arguments),
    });
  }

  const usage = response?.usage ?? {};
  return {
    id: response?.id ?? "msg_relay",
    type: "message",
    role: "assistant",
    // Echo the wire ID Claude asked for, so the client sees the id it selected.
    model: wireId,
    content,
    stop_reason: STOP_REASON[choice.finish_reason] ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

// ---------- discovery ----------

// GET /v1/models payload. Non-secret metadata only.
export function buildModelsResponse(entries) {
  return {
    data: entries.map((entry) => ({
      type: "model",
      id: entry.wireId,
      display_name: entry.displayName,
      created_at: "2026-01-01T00:00:00Z",
    })),
    has_more: false,
    first_id: entries.length > 0 ? entries[0].wireId : null,
    last_id: entries.length > 0 ? entries[entries.length - 1].wireId : null,
  };
}
