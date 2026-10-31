import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fallbackModalities,
  modalitiesFromStoreModel,
} from "./modalities-fallback.mjs";

describe("fallbackModalities", () => {
  it("defaults unmatched chat models to text+image input", () => {
    assert.deepEqual(fallbackModalities("claude-opus-5"), {
      input: ["text", "image"],
      output: ["text"],
    });
    assert.deepEqual(fallbackModalities("gpt-4o"), {
      input: ["text", "image"],
      output: ["text"],
    });
    assert.deepEqual(fallbackModalities("gemini-2.5-pro"), {
      input: ["text", "image"],
      output: ["text"],
    });
    assert.deepEqual(fallbackModalities("deepseek-chat"), {
      input: ["text", "image"],
      output: ["text"],
    });
  });

  it("keeps embedding/tts/whisper text-only", () => {
    // Pinned literals, not the exported constants: the rules table spreads
    // TEXT_ONLY itself, so asserting against it could never catch a content
    // regression in the constant.
    assert.deepEqual(fallbackModalities("text-embedding-3-large"), {
      input: ["text"],
      output: ["text"],
    });
    assert.deepEqual(fallbackModalities("whisper-1"), {
      input: ["text"],
      output: ["text"],
    });
    assert.deepEqual(fallbackModalities("tts-1-hd"), {
      input: ["text"],
      output: ["text"],
    });
  });

  it("treats image-generation families as image output", () => {
    assert.deepEqual(fallbackModalities("gpt-image-2"), {
      input: ["text"],
      output: ["image"],
    });
  });
});

describe("modalitiesFromStoreModel", () => {
  it("prefers store lists over the family fallback", () => {
    // Store output must differ from the claude-opus-5 fallback (['text']) so
    // the output half of this assertion actually proves the store value wins.
    assert.deepEqual(
      modalitiesFromStoreModel(
        { inputModalities: ["text"], outputModalities: ["text", "image"] },
        "claude-opus-5",
      ),
      { input: ["text"], output: ["text", "image"] },
    );
  });

  it("falls back to family modalities when store omits or empties lists", () => {
    assert.deepEqual(modalitiesFromStoreModel(null, "claude-opus-5"), {
      input: ["text", "image"],
      output: ["text"],
    });
    assert.deepEqual(modalitiesFromStoreModel({}, "claude-opus-5"), {
      input: ["text", "image"],
      output: ["text"],
    });
    assert.deepEqual(
      modalitiesFromStoreModel({ inputModalities: [], outputModalities: [] }, "claude-opus-5"),
      { input: ["text", "image"], output: ["text"] },
    );
  });
});
