// OpenAI Responses API <-> Chat Completions API translation, both directions.
// Pure state machines. No IO, no network.
//
// codex speaks only the Responses API; every upstream in the store speaks
// chat/completions, so this module is the entire data plane between them.
// The rules are distilled from codex++ protocol_proxy.rs, narrowed to the
// subset the relay's openai-compatible upstreams need. The load-bearing
// invariants (breaking any one disconnects or hard-fails the codex stream):
//
//   1. item id prefixes: msg_ / rs_ / fc_ / ctc_ (a {resp}_msg suffix shape is
//      the pre-#1431 codex++ bug — codex rejects ids without the prefix);
//   2. usage always carries output_tokens_details.reasoning_tokens (missing
//      details key -> fill 0, missing usage -> synthesize the zero structure);
//   3. orphan tool pairing degrades to text instead of forwarding shapes
//      chat upstreams 400 on (an unanswered tail call is the one exemption —
//      that is the in-flight turn);
//   4. all system text merges into a single first system message;
//   5. a leading <think>...</think> block in string content strips into
//      reasoning; streamed content buffers on an undecided prefix first.

import { sseEvent, REASONING_FIELDS } from "./stream.mjs";

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

// Chat Completions fields a Responses request is allowed to carry straight
// through (same set as codex++).
const EXTRA_CHAT_PASSTHROUGH_FIELDS = [
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "metadata",
  "n",
  "presence_penalty",
  "response_format",
  "seed",
  "service_tier",
  "stop",
  "stream_options",
  "top_logprobs",
  "user",
];

// Request fields echoed back onto the Responses response object.
const RESPONSE_REQUEST_COPY_FIELDS = [
  "instructions",
  "max_output_tokens",
  "parallel_tool_calls",
  "previous_response_id",
  "reasoning",
  "temperature",
  "tool_choice",
  "tools",
  "top_p",
  "metadata",
];

// codex's effort vocabulary onto the library's EFFORT_LEVELS_ORDER (see
// effort-catalog.mjs): "none" is the library's "off", and ultra/persistent
// sit above the library ceiling so they fold down to "max".
const CODEX_EFFORT_FOLD = { none: "off", ultra: "max", persistent: "max" };

// ── shared leaf helpers ────────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// JSON.stringify with sorted object keys, matching codex++ canonical_json_string
// closely enough for tool-output text (key order is the only difference, and
// no consumer parses it back positionally).
function canonicalJsonString(value) {
  return JSON.stringify(value);
}

function responseOutputText(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return canonicalJsonString(value);
}

function instructionText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === "string" ? part : part?.text))
      .filter(nonEmptyString)
      .join("\n\n");
  }
  return typeof value === "string" ? value : "";
}

// A history tool_call's `arguments` must be a JSON object string. Non-object
// payloads wrap as {"input": ...} so no information is lost.
function responsesArgumentsToChat(value) {
  if (typeof value === "string") return normalizeArgumentsString(value);
  if (isPlainObject(value)) return canonicalJsonString(value);
  if (value === null || value === undefined) return "{}";
  return canonicalJsonString({ input: value });
}

function normalizeArgumentsString(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "{}";
  try {
    const parsed = JSON.parse(trimmed);
    if (isPlainObject(parsed)) return trimmed;
    return canonicalJsonString({ input: parsed });
  } catch {
    return canonicalJsonString({ input: text });
  }
}

// ── request side: Responses request body -> chat/completions body ──────────

export function translateResponsesRequest(body) {
  const result = {};
  if (body === null || typeof body !== "object") return result;
  if (body.model !== undefined) result.model = body.model;

  const messages = [];
  const instructions = instructionText(body.instructions);
  if (instructions.length > 0) {
    messages.push({ role: "system", content: instructions });
  }
  appendResponsesInput(body.input, messages);
  enforceToolCallPairing(messages);
  ensureToolCallReasoningContent(messages);
  normalizeChatMessages(messages);
  result.messages = collapseSystemMessagesToHead(messages);

  if (body.max_output_tokens !== undefined) result.max_tokens = body.max_output_tokens;
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.max_completion_tokens !== undefined) result.max_completion_tokens = body.max_completion_tokens;

  for (const key of ["temperature", "top_p", "stream"]) {
    if (body[key] !== undefined) result[key] = body[key];
  }
  if (body.stream === true) {
    // usage rides the terminal stream chunk; codex parses completed without
    // it as a hard failure.
    result.stream_options = { ...(isPlainObject(body.stream_options) ? body.stream_options : {}), include_usage: true };
  }

  // codex's reasoning.effort maps onto the relay's own reasoning_effort
  // mechanism (effort-injection.mjs): a present field reads as client-chosen
  // there (never overridden), and that path's 400/422 rejection retry strips
  // the field for upstreams that reject it — which is what folds levels like
  // minimal/off away for upstreams that cannot take them.
  const effort = body.reasoning?.effort;
  if (nonEmptyString(effort)) {
    result.reasoning_effort = CODEX_EFFORT_FOLD[effort] ?? effort;
  }

  let hasChatTools = false;
  if (Array.isArray(body.tools)) {
    const converted = [];
    for (const tool of body.tools) converted.push(...responsesToolToChatTools(tool));
    if (converted.length > 0) {
      result.tools = converted;
      hasChatTools = true;
    }
  }
  if (hasChatTools) {
    const toolChoice = responsesToolChoiceToChat(body.tool_choice);
    if (toolChoice !== undefined) result.tool_choice = toolChoice;
    if (body.parallel_tool_calls !== undefined) result.parallel_tool_calls = body.parallel_tool_calls;
  }

  for (const key of EXTRA_CHAT_PASSTHROUGH_FIELDS) {
    if (key === "stream_options" && result.stream_options !== undefined) continue;
    if (body[key] !== undefined) result[key] = body[key];
  }

  return result;
}

function appendResponsesInput(input, messages) {
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return;
  }
  const items = Array.isArray(input) ? input : isPlainObject(input) ? [input] : [];
  const state = { pendingToolCalls: [], pendingReasoning: [], seenToolCallIds: new Set() };
  for (const item of items) {
    if (isPlainObject(item)) appendResponsesItem(item, messages, state);
  }
  flushToolCalls(messages, state);
  flushReasoning(messages, state);
}

function appendResponsesItem(item, messages, state) {
  switch (item.type) {
    case "function_call": {
      const name = historyFunctionName(item);
      const callId = nonEmptyString(item.call_id) ? item.call_id : nonEmptyString(item.id) ? item.id : "";
      if (!name || !callId) return;
      state.seenToolCallIds.add(callId);
      state.pendingToolCalls.push({
        id: callId,
        type: "function",
        function: { name, arguments: responsesArgumentsToChat(item.arguments ?? {}) },
      });
      return;
    }
    case "custom_tool_call": {
      const name = nonEmptyString(item.name) ? item.name : "";
      const callId = nonEmptyString(item.call_id) ? item.call_id : nonEmptyString(item.id) ? item.id : "";
      if (!name || !callId) return;
      // Freeform custom tools proxy as a generic function whose entire input
      // rides in a single {"input": text} argument.
      state.seenToolCallIds.add(callId);
      state.pendingToolCalls.push({
        id: callId,
        type: "function",
        function: { name, arguments: canonicalJsonString({ input: responseOutputText(item.input ?? item.arguments) }) },
      });
      return;
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const callId = nonEmptyString(item.call_id) ? item.call_id : "";
      if (!callId) return;
      flushToolCalls(messages, state);
      flushReasoning(messages, state);
      if (!state.seenToolCallIds.has(callId)) {
        // Orphan output: no such call exists upstream-side, so degrade to
        // user text instead of emitting a tool message that would 400.
        messages.push({
          role: "user",
          content: `Function call output (${callId}): ${responseOutputText(item.output)}`,
        });
        return;
      }
      messages.push({ role: "tool", tool_call_id: callId, content: toolOutputContent(item.output) });
      return;
    }
    case "reasoning": {
      const text = responsesReasoningText(item);
      if (nonEmptyString(text)) state.pendingReasoning.push(text);
      return;
    }
    default: {
      flushToolCalls(messages, state);
      if (item.content === undefined) return;
      const role = responsesRoleToChatRole(item.role);
      if (item.content === null && role !== "assistant") return;
      const message = { role, content: responsesContentToChatContent(item.content) };
      if (role === "assistant" && state.pendingReasoning.length > 0) {
        message.reasoning_content = state.pendingReasoning.join("\n");
        state.pendingReasoning = [];
      } else if (role !== "assistant") {
        flushReasoning(messages, state);
      }
      messages.push(message);
    }
  }
}

function historyFunctionName(item) {
  const name = nonEmptyString(item.name) ? item.name : "";
  const namespace = nonEmptyString(item.namespace) ? item.namespace : "";
  if (!name) return "";
  return namespace ? `${namespace}__${name}` : name;
}

function responsesRoleToChatRole(role) {
  switch (role) {
    case "developer":
    case "system":
      return "system";
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
    default:
      return "user";
  }
}

// Text typed parts join into one string; image parts upgrade the content to a
// chat multi-part array.
function responsesContentToChatContent(content) {
  if (content === null || typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const parts = [];
  let hasNonTextPart = false;
  for (const part of content) {
    switch (part?.type ?? "") {
      case "input_text":
      case "output_text":
      case "text":
        if (nonEmptyString(part.text)) parts.push({ type: "text", text: part.text });
        break;
      case "refusal":
        if (nonEmptyString(part.refusal)) parts.push({ type: "text", text: part.refusal });
        break;
      case "input_image":
      case "image_url": {
        const image = imagePartToChat(part);
        if (image) {
          parts.push(image);
          hasNonTextPart = true;
        }
        break;
      }
      default:
        break;
    }
  }
  if (!hasNonTextPart) return parts.map((part) => part.text).join("\n");
  return parts;
}

function imagePartToChat(part) {
  const raw = part?.image_url;
  if (raw === undefined || raw === null) return null;
  const imageUrl = isPlainObject(raw) ? raw : { url: typeof raw === "string" ? raw : "" };
  if (!nonEmptyString(imageUrl.url)) return null;
  return { type: "image_url", image_url: imageUrl };
}

// Chat upstreams accept only string content on tool messages, so multi-part
// tool output flattens to text; image blocks degrade to a placeholder (codex++
// relocates them into a trailing user message — not worth the machinery for
// tools that essentially never return images).
function toolOutputContent(output) {
  if (!Array.isArray(output)) return responseOutputText(output);
  const hasImages = output.some((part) => part?.type === "input_image" || part?.type === "image_url");
  if (!hasImages) return responseOutputText(output);
  const texts = [];
  let imageCount = 0;
  for (const part of output) {
    if (part?.type === "input_image" || part?.type === "image_url") {
      imageCount += 1;
      continue;
    }
    const text = nonEmptyString(part?.text) ? part.text : canonicalJsonString(part);
    if (text) texts.push(text);
  }
  if (imageCount > 0) texts.push(imageCount === 1 ? "[image]" : `[${imageCount} images]`);
  return texts.join("\n");
}

function responsesReasoningText(item) {
  const summary = item.summary;
  if (typeof summary === "string" && summary.length > 0) return summary;
  if (Array.isArray(summary)) {
    const text = summary
      .map((part) => (typeof part === "string" ? part : part?.text ?? part?.content))
      .filter(nonEmptyString)
      .join("\n\n");
    if (text) return text;
  }
  if (nonEmptyString(item.reasoning_content)) return item.reasoning_content;
  if (nonEmptyString(item.reasoning)) return item.reasoning;
  if (isPlainObject(item.reasoning)) {
    for (const key of ["content", "text", "summary"]) {
      if (nonEmptyString(item.reasoning[key])) return item.reasoning[key];
    }
  }
  return null;
}

// Consecutive pending calls flush into a single assistant tool_calls message
// (merging into the previous assistant message when one is already there).
function flushToolCalls(messages, state) {
  if (state.pendingToolCalls.length === 0) return;
  const toolCalls = state.pendingToolCalls;
  state.pendingToolCalls = [];
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    const existing = Array.isArray(last.tool_calls) ? last.tool_calls : (last.tool_calls = []);
    for (const call of toolCalls) {
      if (!existing.some((item) => item.id === call.id)) existing.push(call);
    }
    if (last.content === undefined || last.content === null) last.content = "";
    return;
  }
  const message = { role: "assistant", content: "", tool_calls: toolCalls };
  if (state.pendingReasoning.length > 0) {
    message.reasoning_content = state.pendingReasoning.join("\n");
    state.pendingReasoning = [];
  }
  messages.push(message);
}

function flushReasoning(messages, state) {
  if (state.pendingReasoning.length === 0) return;
  const reasoning = state.pendingReasoning.join("\n");
  state.pendingReasoning = [];
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    last.reasoning_content = nonEmptyString(last.reasoning_content) ? `${last.reasoning_content}\n${reasoning}` : reasoning;
    if (last.content === undefined || last.content === null) last.content = "";
    return;
  }
  messages.push({ role: "assistant", content: "", reasoning_content: reasoning });
}

// A tool_calls assistant message must be followed by a tool message for every
// call id; interrupted/rolled-back turns leave calls with no output, which
// chat upstreams 400 on. Orphaned calls strip out of tool_calls and degrade to
// a text note — except a tail call, which is the normal in-flight shape the
// upstream expects.
function enforceToolCallPairing(messages) {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) continue;
    const answered = new Set();
    let followers = 0;
    for (const follower of messages.slice(index + 1)) {
      if (follower.role !== "tool") break;
      followers += 1;
      if (nonEmptyString(follower.tool_call_id)) answered.add(follower.tool_call_id);
    }
    if (index + 1 + followers >= messages.length) continue;
    const kept = [];
    const orphaned = [];
    for (const toolCall of message.tool_calls) {
      (answered.has(toolCall.id) ? kept : orphaned).push(toolCall);
    }
    if (orphaned.length === 0) continue;
    if (kept.length === 0) delete message.tool_calls;
    else message.tool_calls = kept;
    const notes = orphaned
      .map((toolCall) => `Abandoned function call (${toolCall.id}): ${toolCall.function?.name ?? ""}`)
      .join("\n");
    appendTextToAssistantMessage(message, notes);
  }
}

function appendTextToAssistantMessage(message, text) {
  if (!text) return;
  const existing = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part) => part?.text ?? (typeof part === "string" ? part : "")).join("")
      : "";
  message.content = existing.trim().length === 0 ? text : `${existing}\n${text}`;
}

// DeepSeek-style thinking upstreams reject an assistant tool_calls message
// whose reasoning_content was never passed back; only fill the placeholder
// when both content and reasoning are empty (real reasoning is never
// overwritten).
function ensureToolCallReasoningContent(messages) {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) continue;
    const hasContent = nonEmptyString(message.content) && message.content.trim().length > 0;
    const hasReasoning = nonEmptyString(message.reasoning_content) && message.reasoning_content.trim().length > 0;
    if (!hasContent && !hasReasoning) message.reasoning_content = "Calling the requested tool.";
  }
}

function normalizeChatMessages(messages) {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const hasContent = message.content !== null && message.content !== undefined
      && (typeof message.content !== "object" || !Array.isArray(message.content) || message.content.length > 0);
    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (!hasContent && !hasToolCalls) message.content = "";
  }
}

// All system text merges into one first system message (empty strings drop);
// MiniMax-class upstreams reject anything else.
function collapseSystemMessagesToHead(messages) {
  const systemChunks = [];
  const rest = [];
  for (const message of messages) {
    if (message.role === "system" && typeof message.content === "string") {
      if (message.content.trim().length > 0) systemChunks.push(message.content);
      continue;
    }
    rest.push(message);
  }
  if (systemChunks.length === 0) return rest;
  return [{ role: "system", content: systemChunks.join("\n\n") }, ...rest];
}

// ── request tools ───────────────────────────────────────────────────────────

function responsesToolToChatTools(tool) {
  if (typeof tool === "string") return tool ? [genericCustomProxyTool(tool, "")] : [];
  switch (tool?.type) {
    case "function": {
      const chatTool = functionToolToChat(tool);
      return chatTool ? [chatTool] : [];
    }
    case "custom":
    case "web_search":
    case "local_shell":
    case "computer_use": {
      const name = nonEmptyString(tool.name) ? tool.name : tool.type;
      return [genericCustomProxyTool(name, typeof tool.description === "string" ? tool.description : "")];
    }
    default:
      return [];
  }
}

function functionToolToChat(tool) {
  if (tool?.type !== "function") return null;
  if (isPlainObject(tool.function)) {
    const chatTool = { ...tool, function: { ...tool.function } };
    if (tool.strict !== undefined) {
      chatTool.function.strict ??= tool.strict;
      delete chatTool.strict;
    }
    chatTool.function.parameters = normalizeChatToolParameters(chatTool.function.parameters ?? {});
    return chatTool;
  }
  const fn = {
    name: nonEmptyString(tool.name) ? tool.name : "",
    description: tool.description ?? null,
    parameters: normalizeChatToolParameters(tool.parameters ?? {}),
  };
  if (tool.strict !== undefined) fn.strict = tool.strict;
  return { type: "function", function: fn };
}

// Freeform custom tools ride upstream as a generic function taking one raw
// text argument; the response side unwraps {"input": ...} back into text.
function genericCustomProxyTool(name, description) {
  return {
    type: "function",
    function: {
      name,
      description: description.trim().length === 0
        ? `FREEFORM custom tool: ${name}. Put only the tool input text here.`
        : `${description.trim()}\n\nThis is a FREEFORM tool. Do not wrap the input in JSON or markdown.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { input: { type: "string", description: "Raw freeform input for this custom tool." } },
        required: ["input"],
      },
    },
  };
}

function normalizeChatToolParameters(parameters) {
  const normalized = isPlainObject(parameters) ? { ...parameters } : {};
  // A bare $ref is already a complete schema; adding defaults would
  // manufacture siblings.
  const isBareRef = Object.keys(normalized).length === 1 && "$ref" in normalized;
  if (!isBareRef) {
    normalized.type ??= "object";
    normalized.properties ??= {};
    normalized.required ??= [];
  }
  return inlineLocalRefs(normalized);
}

// Inline local "#/$defs/<name>" refs that carry sibling keys (chat upstreams
// drop the siblings otherwise); a bare $ref stays as-is. Cycles or missing
// defs hand the root back unchanged rather than failing the request.
function inlineLocalRefs(root) {
  const defs = isPlainObject(root?.$defs) ? root.$defs : null;
  const localName = (reference) => {
    if (typeof reference !== "string" || !reference.startsWith("#/$defs/")) return null;
    const name = reference.slice("#/$defs/".length);
    return name && !name.includes("/") ? name : null;
  };
  const bareRefName = (node) => (isPlainObject(node) && Object.keys(node).length === 1 ? localName(node.$ref) : null);
  const resolveDef = (name, resolving) => {
    if (!defs || !isPlainObject(defs[name])) return null;
    if (resolving.includes(name)) throw new Error("cycle");
    resolving.push(name);
    try {
      const alias = bareRefName(defs[name]);
      return alias ? resolveDef(alias, resolving) : normalizeNode(defs[name], resolving);
    } finally {
      resolving.pop();
    }
  };
  const normalizeNode = (node, resolving) => {
    if (Array.isArray(node)) return node.map((item) => normalizeNode(item, resolving));
    if (!isPlainObject(node)) return node;
    const keys = Object.keys(node);
    if (keys.length > 1) {
      const name = localName(node.$ref);
      if (name) {
        const resolved = resolveDef(name, resolving);
        if (isPlainObject(resolved) && resolved.$ref === undefined) {
          const merged = { ...resolved };
          for (const key of keys) {
            if (key !== "$ref") merged[key] = normalizeNode(node[key], resolving);
          }
          return merged;
        }
      }
    }
    const out = {};
    for (const key of keys) out[key] = normalizeNode(node[key], resolving);
    return out;
  };
  try {
    return normalizeNode(root, []);
  } catch {
    return root;
  }
}

function responsesToolChoiceToChat(toolChoice) {
  if (toolChoice === undefined || toolChoice === null) return undefined;
  if (isPlainObject(toolChoice) && (toolChoice.type === "function" || toolChoice.type === "custom")) {
    const name = nonEmptyString(toolChoice.name) ? toolChoice.name : nonEmptyString(toolChoice.function?.name) ? toolChoice.function.name : "";
    const namespace = nonEmptyString(toolChoice.namespace) ? toolChoice.namespace : nonEmptyString(toolChoice.function?.namespace) ? toolChoice.function.namespace : "";
    return { type: "function", function: { name: namespace ? `${namespace}__${name}` : name } };
  }
  return toolChoice;
}

// ── response context ────────────────────────────────────────────────────────

// The response side needs two things from the original request: which tool
// names are freeform custom proxies (their {"input": ...} arguments unwrap
// back into text), and the fields echoed onto the response object. `ctx`
// everywhere below is either the original Responses request body or
// { request: <that body> }.
function normalizeContext(ctx) {
  const request = isPlainObject(ctx?.request) ? ctx.request : isPlainObject(ctx) ? ctx : {};
  const customTools = new Set();
  if (Array.isArray(request.tools)) {
    for (const tool of request.tools) {
      if (typeof tool === "string") {
        if (tool) customTools.add(tool);
        continue;
      }
      if (tool?.type === "custom" || tool?.type === "web_search" || tool?.type === "local_shell" || tool?.type === "computer_use") {
        customTools.add(nonEmptyString(tool.name) ? tool.name : tool.type);
      }
    }
  }
  return { request, customTools, hasCustomTools: customTools.size > 0 };
}

function reconstructCustomToolInput(argumentsText) {
  try {
    const parsed = JSON.parse(argumentsText);
    if (isPlainObject(parsed) && parsed.input !== undefined) return responseOutputText(parsed.input);
  } catch {
    // not JSON — the raw text is the input
  }
  return argumentsText;
}

// ── response side: chat/completions JSON -> Responses response ─────────────

export function responseIdFromChatId(id) {
  const base = nonEmptyString(id) ? id : "compat";
  return base.startsWith("resp_") ? base : `resp_${base}`;
}

export function chatUsageToResponsesUsage(usage) {
  if (!isPlainObject(usage)) return defaultResponsesUsage();
  const cachedTokens = num(usage.prompt_tokens_details?.cached_tokens)
    ?? num(usage.input_tokens_details?.cached_tokens)
    ?? num(usage.cache_read_input_tokens)
    ?? 0;
  // prompt_tokens counts cached tokens in; a direct input_tokens does not.
  let inputTokens = num(usage.prompt_tokens) ?? num(usage.input_tokens) ?? 0;
  if (usage.prompt_tokens !== undefined && usage.input_tokens === undefined) {
    inputTokens = Math.max(0, inputTokens - cachedTokens);
  }
  const outputTokens = num(usage.completion_tokens) ?? num(usage.output_tokens) ?? 0;
  const totalTokens = num(usage.total_tokens) ?? inputTokens + outputTokens + cachedTokens;

  const result = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens };
  if (cachedTokens > 0) result.input_tokens_details = { cached_tokens: cachedTokens };
  // codex parses output_tokens_details.reasoning_tokens as a required field;
  // upstreams omit the key (or the whole details object) when a response had
  // no reasoning, which fails response.completed parsing outright.
  const details = isPlainObject(usage.completion_tokens_details) ? { ...usage.completion_tokens_details } : {};
  details.reasoning_tokens ??= 0;
  result.output_tokens_details = details;
  return result;
}

function defaultResponsesUsage() {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } };
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// A leading <think>...</think> block in string content splits into
// (reasoning, answer); anything else returns null.
export function splitLeadingThinkBlock(text) {
  if (typeof text !== "string") return null;
  const leadingWs = text.length - text.trimStart().length;
  const afterWs = text.slice(leadingWs);
  if (!afterWs.startsWith(THINK_OPEN)) return null;
  const bodyStart = leadingWs + THINK_OPEN.length;
  const closeRelative = text.slice(bodyStart).indexOf(THINK_CLOSE);
  if (closeRelative === -1) return null;
  const closeStart = bodyStart + closeRelative;
  const answerStart = closeStart + THINK_CLOSE.length;
  return {
    reasoning: text.slice(bodyStart, closeStart).trim(),
    answer: text.slice(answerStart).replace(/^[\r\n\t ]+/, ""),
  };
}

// Reasoning text on a chat message/delta: the known reasoning fields first,
// then a leading think block stripped out of string content.
function chatReasoningText(message) {
  for (const field of REASONING_FIELDS) {
    if (nonEmptyString(message?.[field])) return message[field];
  }
  if (isPlainObject(message?.reasoning)) {
    for (const key of ["content", "text", "summary"]) {
      if (nonEmptyString(message.reasoning[key])) return message.reasoning[key];
    }
  }
  if (typeof message?.content === "string") {
    const split = splitLeadingThinkBlock(message.content);
    if (split && split.reasoning) return split.reasoning;
  }
  return null;
}

function chatReasoningToOutputItem(message, responseId) {
  const reasoning = chatReasoningText(message);
  if (!reasoning) return null;
  return {
    id: `rs_${responseId}`,
    type: "reasoning",
    reasoning_content: reasoning,
    summary: [{ type: "summary_text", text: reasoning }],
  };
}

function chatMessageToOutputItem(message, responseId) {
  const content = [];
  if (typeof message.content === "string") {
    const text = splitLeadingThinkBlock(message.content)?.answer ?? message.content;
    if (text.length > 0) content.push({ type: "output_text", text, annotations: [] });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if ((part?.type === "text" || part?.type === "output_text") && nonEmptyString(part.text)) {
        content.push({ type: "output_text", text: part.text, annotations: [] });
      } else if (part?.type === "refusal" && nonEmptyString(part.refusal)) {
        content.push({ type: "refusal", refusal: part.refusal });
      }
    }
  }
  if (nonEmptyString(message.refusal)) content.push({ type: "refusal", refusal: message.refusal });
  if (content.length === 0) return null;
  return { id: `msg_${responseId}`, type: "message", status: "completed", role: "assistant", content };
}

function chatToolCallsToOutputItems(message, context) {
  const items = [];
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : null;
  if (toolCalls) {
    toolCalls.forEach((toolCall, index) => {
      items.push(responseToolCallItem(
        nonEmptyString(toolCall?.id) ? toolCall.id : `call_${index}`,
        nonEmptyString(toolCall?.function?.name) ? toolCall.function.name : "",
        responsesArgumentsToChat(toolCall?.function?.arguments ?? {}),
        context,
      ));
    });
  } else if (isPlainObject(message.function_call)) {
    items.push(responseToolCallItem(
      nonEmptyString(message.function_call.id) ? message.function_call.id : "call_0",
      nonEmptyString(message.function_call.name) ? message.function_call.name : "",
      responsesArgumentsToChat(message.function_call.arguments ?? {}),
      context,
    ));
  }
  return items;
}

function responseToolCallItem(callId, name, argumentsText, context) {
  if (context.customTools.has(name)) {
    return {
      id: `ctc_${callId}`,
      type: "custom_tool_call",
      status: "completed",
      call_id: callId,
      name,
      input: reconstructCustomToolInput(argumentsText),
    };
  }
  return { id: `fc_${callId}`, type: "function_call", status: "completed", call_id: callId, name, arguments: argumentsText };
}

function copyResponseRequestFields(response, request) {
  for (const key of RESPONSE_REQUEST_COPY_FIELDS) {
    if (request[key] !== undefined) response[key] = request[key];
  }
}

export function translateChatResponse(chatJson, ctx) {
  const context = normalizeContext(ctx);
  const choice = Array.isArray(chatJson?.choices) ? chatJson.choices[0] : null;
  const message = choice?.message;
  if (!isPlainObject(message)) throw new Error("chat response missing choices[0].message");

  const responseId = responseIdFromChatId(chatJson.id);
  const output = [];
  const reasoning = chatReasoningToOutputItem(message, responseId);
  if (reasoning) output.push(reasoning);
  const text = chatMessageToOutputItem(message, responseId);
  if (text) output.push(text);
  output.push(...chatToolCallsToOutputItems(message, context));

  const finishReason = nonEmptyString(choice.finish_reason) ? choice.finish_reason : null;
  const response = {
    id: responseId,
    object: "response",
    created_at: num(chatJson.created) ?? 0,
    status: finishReason === "length" ? "incomplete" : "completed",
    model: nonEmptyString(chatJson.model) ? chatJson.model : "",
    output,
    usage: chatUsageToResponsesUsage(chatJson.usage),
  };
  if (finishReason === "length") response.incomplete_details = { reason: "max_output_tokens" };
  copyResponseRequestFields(response, context.request);
  return response;
}

// ── streaming: chat/completions SSE chunks -> Responses SSE events ─────────
//
// The event order one turn emits is:
//
//   response.created / response.in_progress
//   (output_item.added + reasoning_summary_part.added + reasoning_summary_text.delta*
//     + reasoning_summary_text.done + reasoning_summary_part.done + output_item.done)?
//   (output_item.added + content_part.added + output_text.delta*
//     + output_text.done + content_part.done + output_item.done)?
//   (output_item.added + function_call_arguments.delta*
//     + function_call_arguments.done + output_item.done)*   (per chat tool index)
//   response.completed   (full output + final usage)
//   data: [DONE]
//
// An upstream error frame ends the stream with response.failed instead.
// Interface mirrors stream.mjs's StreamTranslator so pipeGuardedStream can
// drive it unchanged: one constructor arg (ctx), chunk(parsed) -> frames
// string, finish() -> terminal frames string, both idempotent-safe.

export class ResponsesSseTranslator {
  constructor(ctx) {
    const context = normalizeContext(ctx);
    this.request = context.request;
    this.customTools = context.customTools;
    this.hasCustomTools = context.hasCustomTools;
    this.started = false;
    this.finished = false;
    this.responseId = "resp_compat";
    this.model = "";
    this.createdAt = 0;
    this.nextOutputIndex = 0;
    // reasoning / text: { outputIndex, itemId, text, added, done }
    this.reasoning = { outputIndex: null, itemId: "", text: "", added: false, done: false };
    this.text = { outputIndex: null, itemId: "", text: "", added: false, done: false };
    // inline <think> detection on streamed string content: "detecting" |
    // "reasoning" | "text", with an undecided prefix held in buffer.
    this.inlineThink = { mode: "detecting", buffer: "" };
    // chat tool_call index -> { outputIndex, itemId, callId, name, arguments, added, done }
    this.tools = new Map();
    this.outputItems = []; // [outputIndex, item]
    this.latestUsage = null;
    this.finishReason = null;
  }

  start() {
    if (this.started) return "";
    this.started = true;
    let out = sseEvent("response.created", { type: "response.created", response: this.baseResponse("in_progress", []) });
    out += sseEvent("response.in_progress", { type: "response.in_progress", response: this.baseResponse("in_progress", []) });
    return out;
  }

  // One parsed chat.completion.chunk -> zero or more Responses SSE frames.
  chunk(parsed) {
    if (this.finished) return "";
    if (isPlainObject(parsed?.error)) {
      return this.fail(parsed.error.message ?? "upstream stream error", parsed.error.type);
    }

    if (nonEmptyString(parsed?.id)) this.responseId = responseIdFromChatId(parsed.id);
    if (nonEmptyString(parsed?.model)) this.model = parsed.model;
    if (num(parsed?.created) !== null) this.createdAt = parsed.created;
    let out = this.start();

    if (isPlainObject(parsed?.usage)) this.latestUsage = chatUsageToResponsesUsage(parsed.usage);

    const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
    if (!isPlainObject(choice)) return out;
    const delta = isPlainObject(choice.delta) ? choice.delta : {};

    const reasoningText = this.deltaReasoningText(delta);
    if (reasoningText !== null) out += this.pushReasoningDelta(reasoningText);

    if (nonEmptyString(delta.content)) out += this.pushContentDelta(delta.content);

    if (Array.isArray(delta.tool_calls)) {
      out += this.flushInlineThinkAtBoundary();
      out += this.finalizeReasoning();
      for (const toolCall of delta.tool_calls) {
        if (isPlainObject(toolCall)) out += this.pushToolCallDelta(toolCall);
      }
    }

    if (nonEmptyString(choice.finish_reason)) this.finishReason = choice.finish_reason;
    return out;
  }

  deltaReasoningText(delta) {
    for (const field of REASONING_FIELDS) {
      if (nonEmptyString(delta[field])) return delta[field];
    }
    return null;
  }

  // String content may open with an inline <think> block; the prefix decides
  // reasoning vs text, and an undecided prefix buffers until it does.
  pushContentDelta(delta) {
    if (this.inlineThink.mode === "text") {
      return this.finalizeReasoning() + this.pushTextDelta(delta);
    }
    this.inlineThink.buffer += delta;
    if (this.inlineThink.mode === "reasoning") return this.drainCompleteInlineThink();
    switch (thinkPrefixDecision(this.inlineThink.buffer)) {
      case "needmore":
        return "";
      case "reasoning":
        this.inlineThink.mode = "reasoning";
        return this.drainCompleteInlineThink();
      default: {
        this.inlineThink.mode = "text";
        const text = this.inlineThink.buffer;
        this.inlineThink.buffer = "";
        return this.finalizeReasoning() + this.pushTextDelta(text);
      }
    }
  }

  drainCompleteInlineThink() {
    const split = splitLeadingThinkBlock(this.inlineThink.buffer);
    if (!split) return "";
    this.inlineThink.mode = "text";
    this.inlineThink.buffer = "";
    let out = "";
    if (split.reasoning) out += this.pushReasoningDelta(split.reasoning) + this.finalizeReasoning();
    if (split.answer) out += this.pushTextDelta(split.answer);
    return out;
  }

  // Tool calls starting (or the stream ending) decides a still-undecided
  // prefix as text, and an unterminated think block as reasoning.
  flushInlineThinkAtBoundary() {
    const mode = this.inlineThink.mode;
    if (mode === "text") return "";
    const buffered = this.inlineThink.buffer;
    this.inlineThink.buffer = "";
    this.inlineThink.mode = "text";
    if (!buffered) return "";
    if (mode === "detecting") {
      return this.finalizeReasoning() + this.pushTextDelta(buffered);
    }
    let out = "";
    const split = splitLeadingThinkBlock(buffered);
    if (split) {
      if (split.reasoning) out += this.pushReasoningDelta(split.reasoning) + this.finalizeReasoning();
      if (split.answer) out += this.pushTextDelta(split.answer);
      return out;
    }
    const reasoning = stripLeadingThinkOpenTag(buffered) ?? buffered;
    if (reasoning) out += this.pushReasoningDelta(reasoning) + this.finalizeReasoning();
    return out;
  }

  pushReasoningDelta(delta) {
    let out = "";
    if (!this.reasoning.added) {
      const outputIndex = this.nextOutputIndex++;
      this.reasoning.outputIndex = outputIndex;
      this.reasoning.itemId = `rs_${this.responseId}`;
      this.reasoning.added = true;
      out += sseEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { id: this.reasoning.itemId, type: "reasoning", status: "in_progress", reasoning_content: "", summary: [] },
      });
      out += sseEvent("response.reasoning_summary_part.added", {
        type: "response.reasoning_summary_part.added",
        item_id: this.reasoning.itemId,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
    }
    this.reasoning.text += delta;
    out += sseEvent("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      item_id: this.reasoning.itemId,
      output_index: this.reasoning.outputIndex ?? 0,
      summary_index: 0,
      delta,
    });
    return out;
  }

  pushTextDelta(delta) {
    let out = "";
    if (!this.text.added) {
      const outputIndex = this.nextOutputIndex++;
      this.text.outputIndex = outputIndex;
      this.text.itemId = `msg_${this.responseId}`;
      this.text.added = true;
      out += sseEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { id: this.text.itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
      });
      out += sseEvent("response.content_part.added", {
        type: "response.content_part.added",
        item_id: this.text.itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    this.text.text += delta;
    out += sseEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: this.text.itemId,
      output_index: this.text.outputIndex ?? 0,
      content_index: 0,
      delta,
    });
    return out;
  }

  pushToolCallDelta(toolCall) {
    const chatIndex = num(toolCall.index) ?? 0;
    let state = this.tools.get(chatIndex);
    if (!state) {
      state = { outputIndex: null, itemId: "", callId: "", name: "", arguments: "", added: false, done: false };
      this.tools.set(chatIndex, state);
    }
    if (nonEmptyString(toolCall.id)) state.callId = toolCall.id;
    if (nonEmptyString(toolCall.function?.name)) state.name = toolCall.function.name;
    const argsDelta = nonEmptyString(toolCall.function?.arguments) ? toolCall.function.arguments : "";
    state.arguments += argsDelta;

    if (!state.added) {
      // A custom tool's id namespace is ctc_, so when the request carries
      // custom tools the item cannot be added before the name arrives (the
      // call id can precede it).
      if ((!state.callId && !state.name) || (this.hasCustomTools && !state.name)) return "";
      state.added = true;
      if (!state.callId) state.callId = `call_${chatIndex}`;
      if (!state.name) state.name = "unknown_tool";
      state.outputIndex = this.nextOutputIndex++;
      state.itemId = `${this.customTools.has(state.name) ? "ctc_" : "fc_"}${state.callId}`;
      let out = sseEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: state.outputIndex,
        item: this.customTools.has(state.name)
          ? { id: state.itemId, type: "custom_tool_call", status: "in_progress", call_id: state.callId, name: state.name, input: "" }
          : { id: state.itemId, type: "function_call", status: "in_progress", call_id: state.callId, name: state.name, arguments: "" },
      });
      if (state.arguments) out += this.toolCallArgumentsDelta(state, state.arguments);
      return out;
    }
    return argsDelta ? this.toolCallArgumentsDelta(state, argsDelta) : "";
  }

  toolCallArgumentsDelta(state, delta) {
    // A custom tool's freeform input can only be reconstructed from the
    // complete arguments, so its deltas hold until done.
    if (this.customTools.has(state.name)) return "";
    return sseEvent("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: state.itemId,
      output_index: state.outputIndex ?? 0,
      delta,
    });
  }

  finalizeReasoning() {
    if (!this.reasoning.added || this.reasoning.done) return "";
    const outputIndex = this.reasoning.outputIndex ?? 0;
    const item = {
      id: this.reasoning.itemId,
      type: "reasoning",
      reasoning_content: this.reasoning.text,
      summary: [{ type: "summary_text", text: this.reasoning.text }],
    };
    this.outputItems.push([outputIndex, item]);
    this.reasoning.done = true;
    let out = sseEvent("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: this.reasoning.itemId,
      output_index: outputIndex,
      summary_index: 0,
      text: this.reasoning.text,
    });
    out += sseEvent("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: this.reasoning.itemId,
      output_index: outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: this.reasoning.text },
    });
    out += sseEvent("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item });
    return out;
  }

  finalizeText() {
    if (!this.text.added || this.text.done) return "";
    const outputIndex = this.text.outputIndex ?? 0;
    const item = {
      id: this.text.itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: this.text.text, annotations: [] }],
    };
    this.outputItems.push([outputIndex, item]);
    this.text.done = true;
    let out = sseEvent("response.output_text.done", {
      type: "response.output_text.done",
      item_id: this.text.itemId,
      output_index: outputIndex,
      content_index: 0,
      text: this.text.text,
    });
    out += sseEvent("response.content_part.done", {
      type: "response.content_part.done",
      item_id: this.text.itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: this.text.text, annotations: [] },
    });
    out += sseEvent("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item });
    return out;
  }

  finalizeTools() {
    let out = "";
    for (const [chatIndex, state] of [...this.tools.entries()].sort((a, b) => a[0] - b[0])) {
      if (state.done) continue;
      if (!state.added) {
        state.added = true;
        if (!state.callId) state.callId = `call_${chatIndex}`;
        if (!state.name) state.name = "unknown_tool";
        state.outputIndex = this.nextOutputIndex++;
        state.itemId = `${this.customTools.has(state.name) ? "ctc_" : "fc_"}${state.callId}`;
        out += sseEvent("response.output_item.added", {
          type: "response.output_item.added",
          output_index: state.outputIndex,
          item: this.customTools.has(state.name)
            ? { id: state.itemId, type: "custom_tool_call", status: "in_progress", call_id: state.callId, name: state.name, input: "" }
            : { id: state.itemId, type: "function_call", status: "in_progress", call_id: state.callId, name: state.name, arguments: "" },
        });
      }
      const isCustom = this.customTools.has(state.name);
      const item = isCustom
        ? { id: state.itemId, type: "custom_tool_call", status: "completed", call_id: state.callId, name: state.name, input: reconstructCustomToolInput(state.arguments) }
        : { id: state.itemId, type: "function_call", status: "completed", call_id: state.callId, name: state.name, arguments: state.arguments };
      state.done = true;
      this.outputItems.push([state.outputIndex ?? 0, item]);
      out += isCustom
        ? sseEvent("response.custom_tool_call_input.delta", {
            type: "response.custom_tool_call_input.delta",
            item_id: state.itemId,
            call_id: state.callId,
            output_index: state.outputIndex ?? 0,
            delta: item.input,
          })
        : sseEvent("response.function_call_arguments.done", {
            type: "response.function_call_arguments.done",
            item_id: state.itemId,
            output_index: state.outputIndex ?? 0,
            arguments: state.arguments,
          });
      out += sseEvent("response.output_item.done", { type: "response.output_item.done", output_index: state.outputIndex ?? 0, item });
    }
    return out;
  }

  completedOutputItems() {
    return [...this.outputItems].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  }

  baseResponse(status, output) {
    return {
      id: this.responseId,
      object: "response",
      created_at: this.createdAt,
      status,
      model: this.model,
      output,
      usage: this.latestUsage ?? defaultResponsesUsage(),
    };
  }

  // Close every open item, then response.completed + a literal [DONE].
  // Idempotent.
  finish() {
    if (this.finished) return "";
    this.finished = true;
    let out = this.start();
    out += this.flushInlineThinkAtBoundary();
    out += this.finalizeReasoning();
    out += this.finalizeText();
    out += this.finalizeTools();

    const status = this.finishReason === "length" ? "incomplete" : "completed";
    const response = this.baseResponse(status, this.completedOutputItems());
    if (status === "incomplete") response.incomplete_details = { reason: "max_output_tokens" };
    copyResponseRequestFields(response, this.request);
    out += sseEvent("response.completed", { type: "response.completed", response });
    out += "data: [DONE]\n\n";
    return out;
  }

  // An upstream failure mid-stream ends the turn with response.failed; no
  // [DONE] follows a failed response.
  fail(message, type) {
    if (this.finished) return "";
    this.finished = true;
    const out = this.start();
    const error = { message: nonEmptyString(message) ? message : "upstream stream error" };
    if (nonEmptyString(type)) error.type = type;
    const response = this.baseResponse("failed", this.completedOutputItems());
    response.error = error;
    return out + sseEvent("response.failed", { type: "response.failed", response });
  }
}

// "needmore" while the buffered prefix could still grow into "<think>",
// "reasoning" once it has, "text" the moment it cannot.
function thinkPrefixDecision(buffer) {
  const trimmed = buffer.replace(/^\s+/, "");
  if (trimmed.length < THINK_OPEN.length && THINK_OPEN.startsWith(trimmed)) return "needmore";
  if (trimmed.startsWith(THINK_OPEN)) return "reasoning";
  return "text";
}

function stripLeadingThinkOpenTag(text) {
  const trimmed = text.trimStart();
  return trimmed.startsWith(THINK_OPEN) ? trimmed.slice(THINK_OPEN.length).trim() : null;
}
