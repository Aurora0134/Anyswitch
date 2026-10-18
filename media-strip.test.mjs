import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  UNSUPPORTED_IMAGE_MARKER,
  requestHasImages,
  stripImages,
  noteImageFallback,
  imageFallbackStats,
  resetImageFallbackStats,
} from "./media-strip.mjs";

const IMAGE_PART = { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } };
const OTHER_IMAGE_PART = { type: "image_url", image_url: { url: "https://example.invalid/a.png" } };

describe("requestHasImages", () => {
  it("detects image_url parts anywhere in messages", () => {
    assert.equal(
      requestHasImages({ messages: [{ role: "user", content: [IMAGE_PART] }] }),
      true,
    );
    assert.equal(
      requestHasImages({
        messages: [
          { role: "user", content: "plain text first" },
          { role: "user", content: [{ type: "text", text: "look" }, IMAGE_PART] },
        ],
      }),
      true,
    );
  });

  it("string content, text parts and absent messages are not images", () => {
    assert.equal(requestHasImages({ messages: [{ role: "user", content: "hi" }] }), false);
    assert.equal(
      requestHasImages({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
      false,
    );
    assert.equal(requestHasImages({}), false);
    assert.equal(requestHasImages({ messages: "nope" }), false);
    assert.equal(requestHasImages(null), false);
  });
});

describe("stripImages", () => {
  it("replaces every image_url part with the fixed marker text part", () => {
    const body = {
      model: "some-model",
      stream: true,
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }, IMAGE_PART, OTHER_IMAGE_PART] },
      ],
    };
    const { body: stripped, count } = stripImages(body);
    assert.equal(count, 2);
    assert.equal(stripped.messages[0].content.length, 3);
    assert.deepEqual(stripped.messages[0].content[1], { type: "text", text: UNSUPPORTED_IMAGE_MARKER });
    assert.deepEqual(stripped.messages[0].content[2], { type: "text", text: UNSUPPORTED_IMAGE_MARKER });
    // 其他消息与顶层字段原样保留。
    assert.equal(stripped.model, "some-model");
    assert.equal(stripped.stream, true);
    assert.deepEqual(stripped.messages[0].content[0], { type: "text", text: "look" });
  });

  it("collapses a content array left with a single text part (protocol.mjs convention)", () => {
    const body = { messages: [{ role: "user", content: [IMAGE_PART] }] };
    const { body: stripped, count } = stripImages(body);
    assert.equal(count, 1);
    // 单 text part 折叠成字符串形态——与 convertContentToOpenAI 同款惯例。
    assert.equal(stripped.messages[0].content, UNSUPPORTED_IMAGE_MARKER);
    assert.equal(stripped.messages[0].role, "user");
  });

  it("never mutates the input body", () => {
    const content = [{ type: "text", text: "look" }, IMAGE_PART];
    const message = { role: "user", content };
    const body = { model: "m", messages: [message] };
    const { body: stripped } = stripImages(body);
    assert.equal(stripped === body, false);
    assert.equal(stripped.messages[0] === message, false);
    assert.equal(stripped.messages[0].content === content, false);
    // 原体原样：image part 还在。
    assert.deepEqual(body.messages[0].content[1], IMAGE_PART);
    assert.equal(message.content, content);
  });

  it("is idempotent: a stripped body strips to nothing", () => {
    const body = { messages: [{ role: "user", content: [{ type: "text", text: "look" }, IMAGE_PART] }] };
    const first = stripImages(body);
    const second = stripImages(first.body);
    assert.equal(second.count, 0);
    assert.equal(second.body === first.body, true);
    assert.deepEqual(second.body, first.body);
  });

  it("returns the input reference untouched when there is nothing to strip", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const { body: same, count } = stripImages(body);
    assert.equal(count, 0);
    assert.equal(same === body, true);
  });

  it("keeps tool and assistant message shapes that carry no image parts", () => {
    const messages = [
      { role: "tool", tool_call_id: "call_1", content: "raw tool output" },
      { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "user", content: "hi" },
    ];
    const body = { messages };
    const { body: same, count } = stripImages(body);
    assert.equal(count, 0);
    assert.equal(same === body, true);
  });

  it("honours an explicit marker argument", () => {
    const body = { messages: [{ role: "user", content: [IMAGE_PART] }] };
    const { body: stripped, count } = stripImages(body, "[custom marker]");
    assert.equal(count, 1);
    assert.equal(stripped.messages[0].content, "[custom marker]");
  });

  it("tolerates bodies without messages", () => {
    assert.deepEqual(stripImages({}), { body: {}, count: 0 });
    const nothing = stripImages(null);
    assert.equal(nothing.body, null);
    assert.equal(nothing.count, 0);
  });

  it("the marker value is the approved byte-identical constant", () => {
    assert.equal(UNSUPPORTED_IMAGE_MARKER, "[Unsupported Image]");
  });
});

describe("degradation ledger", () => {
  beforeEach(() => resetImageFallbackStats());

  it("counts requests and images across both via paths", () => {
    noteImageFallback({ providerId: "ch-a", modelId: "glm-5.3", count: 2, via: "predict" });
    noteImageFallback({ providerId: "ch-b", modelId: "deepseek-v4.1-flash", count: 1, via: "fallback" });
    assert.deepEqual(imageFallbackStats(), { requests: 2, images: 3 });
    resetImageFallbackStats();
    assert.deepEqual(imageFallbackStats(), { requests: 0, images: 0 });
  });

  it("logs one info line per degraded request, wording the via path", () => {
    const lines = [];
    const logger = { info: (line) => lines.push(line) };
    noteImageFallback({ providerId: "ch-a", modelId: "glm-5.3", count: 2, via: "predict", logger });
    noteImageFallback({ providerId: "ch-b", modelId: "deepseek-v4.1-flash", count: 1, via: "fallback", logger });
    noteImageFallback({ providerId: "ch-c", modelId: "m", count: 1, via: "predict", logger: null });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /图片降级（预判）/);
    assert.match(lines[0], /"ch-a"/);
    assert.match(lines[0], /"glm-5.3"/);
    assert.match(lines[0], /2 张图片/);
    assert.match(lines[1], /图片降级（兜底）/);
    assert.match(lines[1], /重试一次/);
  });
});
