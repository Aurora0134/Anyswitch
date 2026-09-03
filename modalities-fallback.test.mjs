import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fallbackModalities,
  modalitiesFromStoreModel,
  TEXT_ONLY,
  IMAGE_OUT,
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
    assert.deepEqual(fallbackModalities("text-embedding-3-large").input, [...TEXT_ONLY.input]);
    assert.deepEqual(fallbackModalities("whisper-1").output, [...TEXT_ONLY.output]);
    assert.deepEqual(fallbackModalities("tts-1-hd").input, ["text"]);
  });

  it("treats image-generation families as image output", () => {
    assert.deepEqual(fallbackModalities("gpt-image-2"), {
      input: [...IMAGE_OUT.input],
      output: [...IMAGE_OUT.output],
    });
  });
});

describe("modalitiesFromStoreModel", () => {
  it("prefers store lists over the family fallback", () => {
    assert.deepEqual(
      modalitiesFromStoreModel(
        { inputModalities: ["text"], outputModalities: ["text"] },
        "claude-opus-5",
      ),
      { input: ["text"], output: ["text"] },
    );
  });
});
