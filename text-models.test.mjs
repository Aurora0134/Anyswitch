import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIRMED_TEXT_ONLY_MODELS,
  normalizeModelId,
  isConfirmedTextOnlyModel,
  modelDeclaresTextOnly,
  requestModelIsTextOnly,
  looksLikeTextOnlyRejection,
} from "./text-models.mjs";

describe("isConfirmedTextOnlyModel", () => {
  it("matches the registry exactly, case-insensitively", () => {
    for (const name of CONFIRMED_TEXT_ONLY_MODELS) {
      assert.equal(isConfirmedTextOnlyModel(name), true, name);
      assert.equal(isConfirmedTextOnlyModel(name.toUpperCase()), true, name);
    }
  });

  it("normalizes namespaces, the 1M marker, and channel bracket labels", () => {
    assert.equal(isConfirmedTextOnlyModel("deepseek/deepseek-chat"), true);
    assert.equal(isConfirmedTextOnlyModel("models/glm-5.2"), true);
    assert.equal(isConfirmedTextOnlyModel("GLM-5.3[1M]"), true);
    assert.equal(isConfirmedTextOnlyModel("glm-5.2 [1m]"), true);
    // 上游渠道的带标签形态：方括号是渠道标签，不是模型名。
    assert.equal(isConfirmedTextOnlyModel("[云]GLM-5.3"), true);
    assert.equal(isConfirmedTextOnlyModel("[特价]DeepSeek-Chat"), true);
  });

  it("fails open on every unconfirmed shape", () => {
    // 视觉后缀不继承（智谱 v 惯例、通用 vision/vl 惯例）。
    for (const name of [
      "glm-5.2v",
      "glm-5.3v",
      "glm-5.3-vision",
      "qwen3.8-omni-flash",
      "deepseek-v4-flash-vision",
      "minimax-m2.7-vision",
    ]) {
      assert.equal(isConfirmedTextOnlyModel(name), false, name);
    }
    // 本机在用但未确认的模型/后缀：fail-open，名单不越权。
    for (const name of [
      "deepseek-v4-flash",
      "deepseek-v4.1-flash",
      "deepseek-v4-pro-0813",
      "deepseek-flash",
      "DeepSeek-V4-Flash-0731",
      "glm-5.3-flash",
      "glm-5.3-flashx",
      "kimi-k3",
      "kimi-k2.8",
      "qwen3.8-flash",
      "qwen3.8-max",
      "mimo-v2.6-pro",
      "mimo-v2.6-flash",
      "MiniMax-M2.7-free",
      "MiniMax-M3",
      "step-5-preview",
      "intern-s2",
      "hy4-preview",
      "gemini-4-argon",
      "grok-4.7",
      "claude-opus-5",
      "gpt-6.1-sol",
      "glm-5.4",
    ]) {
      assert.equal(isConfirmedTextOnlyModel(name), false, name);
    }
    // 带标签的未确认形态同样不命中（前缀剥离后仍需精确匹配）。
    assert.equal(isConfirmedTextOnlyModel("[云]GLM-5.3-Flash"), false);
    assert.equal(isConfirmedTextOnlyModel("[云]Kimi-K3"), false);
    assert.equal(isConfirmedTextOnlyModel("[渠]gemini-3.8-flash-thinking"), false);
  });

  it("never matches an empty or non-string id", () => {
    assert.equal(isConfirmedTextOnlyModel(""), false);
    assert.equal(isConfirmedTextOnlyModel(null), false);
    assert.equal(isConfirmedTextOnlyModel(undefined), false);
    assert.equal(isConfirmedTextOnlyModel(42), false);
  });

  it("normalizeModelId surfaces are stable", () => {
    assert.equal(normalizeModelId("  GLM-5.3 "), "glm-5.3");
    assert.equal(normalizeModelId("models/deepseek-chat"), "deepseek-chat");
    assert.equal(normalizeModelId("GLM-5.2[1M]"), "glm-5.2");
    assert.equal(normalizeModelId("[云]GLM-5.3"), "glm-5.3");
    assert.equal(normalizeModelId("[特价] GLM-5.3-Flash "), "glm-5.3-flash");
    assert.equal(normalizeModelId(""), "");
    assert.equal(normalizeModelId(null), "");
  });
});

describe("modelDeclaresTextOnly", () => {
  it("a declared list without image is text-only", () => {
    assert.equal(modelDeclaresTextOnly({ inputModalities: ["text"] }), true);
    assert.equal(modelDeclaresTextOnly({ inputModalities: ["text", "TEXT"] }), true);
    assert.equal(modelDeclaresTextOnly({ inputModalities: ["audio"] }), true);
  });

  it("a declared image input is not text-only, whatever the case", () => {
    assert.equal(modelDeclaresTextOnly({ inputModalities: ["text", "image"] }), false);
    assert.equal(modelDeclaresTextOnly({ inputModalities: ["Text", " Image "] }), false);
  });

  it("an absent or empty list is unknown, never text-only", () => {
    assert.equal(modelDeclaresTextOnly({}), false);
    assert.equal(modelDeclaresTextOnly(null), false);
    assert.equal(modelDeclaresTextOnly({ inputModalities: [] }), false);
    assert.equal(modelDeclaresTextOnly({ inputModalities: "text" }), false);
  });
});

describe("requestModelIsTextOnly", () => {
  it("a store declaration answers regardless of both switches", () => {
    // 声明纯文本：预判子开关关着也照判（声明是事实，不是猜测）。
    assert.equal(requestModelIsTextOnly({ inputModalities: ["text"] }, "whatever", false), true);
    assert.equal(requestModelIsTextOnly({ inputModalities: ["text"] }, "whatever", true), true);
    // 声明支持图片：名单命中也被声明推翻（ccswitch resolve 语义）。
    assert.equal(requestModelIsTextOnly({ inputModalities: ["text", "image"] }, "glm-5.3", true), false);
  });

  it("the registry tier is gated by the 预判 sub-switch", () => {
    assert.equal(requestModelIsTextOnly({}, "glm-5.3", true), true);
    assert.equal(requestModelIsTextOnly({}, "glm-5.3", false), false);
    assert.equal(requestModelIsTextOnly(null, "deepseek-chat", false), false);
    assert.equal(requestModelIsTextOnly(null, "deepseek-chat", true), true);
  });

  it("unknown models stay image-capable (fail-open)", () => {
    assert.equal(requestModelIsTextOnly({}, "deepseek-v4.1-flash", true), false);
    assert.equal(requestModelIsTextOnly({}, "kimi-k3", true), false);
    assert.equal(requestModelIsTextOnly({}, "", true), false);
    assert.equal(requestModelIsTextOnly({}, undefined, true), false);
  });
});

describe("looksLikeTextOnlyRejection", () => {
  const textOnlyError = (message, status = 400) =>
    new Response(JSON.stringify({ error: { message } }), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("matches the ccswitch wording samples (real gateway phrasings)", async () => {
    // 常见明确措辞。
    assert.equal(looksLikeTextOnlyRejection(400, "This model does not support image input"), true);
    assert.equal(looksLikeTextOnlyRejection(400, "this model does not support image input"), true);
    // 火山方舟（issue #5025）：全程不出现 image，且英文缺三单 s。
    assert.equal(looksLikeTextOnlyRejection(400, "Model only support text input Request id: 021783"), true);
    assert.equal(looksLikeTextOnlyRejection(400, "Model only supports text input"), true);
    // 反序列化报错把 image_url 当未知变体。
    assert.equal(
      looksLikeTextOnlyRejection(
        400,
        "Failed to deserialize the JSON body into the target type: messages[11]: unknown variant `image_url`, expected `text`",
      ),
      true,
    );
    // media / attachment 措辞。
    assert.equal(looksLikeTextOnlyRejection(400, "This model cannot process media inputs"), true);
    assert.equal(looksLikeTextOnlyRejection(422, "attachments are not supported by this model"), true);
    assert.equal(looksLikeTextOnlyRejection(415, "unsupported media type: image/png"), true);
    // 单复数放宽（s 变体经子串命中）。
    assert.equal(looksLikeTextOnlyRejection(400, "only supports texts"), true);
  });

  it("reads the message out of a JSON error body", async () => {
    const body = await textOnlyError("This model does not support image input").text();
    assert.equal(looksLikeTextOnlyRejection(400, body), true);
    const detail = JSON.stringify({ detail: "image input is not supported by this model" });
    assert.equal(looksLikeTextOnlyRejection(422, detail), true);
    const bareMessage = JSON.stringify({ message: "image inputs are not supported" });
    assert.equal(looksLikeTextOnlyRejection(400, bareMessage), true);
    const stringError = JSON.stringify({ error: "this model does not support image input" });
    assert.equal(looksLikeTextOnlyRejection(400, stringError), true);
    // JSON 但无消息字段：压缩原文继续按措辞搜（字段名/结构词可命中）。
    const structural = JSON.stringify({ unsupported: "image", note: "x" });
    assert.equal(looksLikeTextOnlyRejection(400, structural), true);
  });

  it("refuses statuses outside the 4xx body-is-wrong class", () => {
    assert.equal(looksLikeTextOnlyRejection(500, "This model does not support image input"), false);
    assert.equal(looksLikeTextOnlyRejection(429, "Model only support text input"), false);
    assert.equal(looksLikeTextOnlyRejection(501, "This model does not support image input"), false);
    assert.equal(looksLikeTextOnlyRejection(200, "only supports text"), false);
  });

  it("refuses error texts that are not modality verdicts", () => {
    assert.equal(looksLikeTextOnlyRejection(400, "Invalid API key"), false);
    assert.equal(looksLikeTextOnlyRejection(400, "quota exceeded"), false);
    // 提到 image 但没有拒绝措辞：不是模态判决。
    assert.equal(looksLikeTextOnlyRejection(400, "the image was 800px wide"), false);
    // 措辞是拒绝但与图片无关（effort 域）：两兜底互不越界。
    assert.equal(looksLikeTextOnlyRejection(400, "Unsupported parameter: 'reasoning_effort'"), false);
    assert.equal(looksLikeTextOnlyRejection(400, "unknown field effort"), false);
    // 空文本。
    assert.equal(looksLikeTextOnlyRejection(400, ""), false);
    assert.equal(looksLikeTextOnlyRejection(400, null), false);
    assert.equal(looksLikeTextOnlyRejection(400, undefined), false);
  });
});
