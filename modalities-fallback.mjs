// Hub-owned modality fallback (not an endpoint catalog).
// Pure functions only. No IO, no DPAPI, no network.
//
// Priority:
//   1. store inputModalities / outputModalities when present
//   2. family rules below
//   3. unmatched chat default: input text+image, output text
//
// Unknown chat models default to allowing image input so a missing row cannot
// strip vision from a multimodal model (the inject bug this module replaces).
// Narrow families that cannot accept images are listed first.

export const TEXT_ONLY = Object.freeze({
  input: Object.freeze(["text"]),
  output: Object.freeze(["text"]),
});

export const TEXT_IMAGE_IN = Object.freeze({
  input: Object.freeze(["text", "image"]),
  output: Object.freeze(["text"]),
});

export const IMAGE_OUT = Object.freeze({
  input: Object.freeze(["text"]),
  output: Object.freeze(["image"]),
});

export const UNMATCHED_MODALITIES_FALLBACK = TEXT_IMAGE_IN;

// First matching keyword (case-insensitive substring of the model id) wins.
export const MODALITY_TIER_RULES = [
  { keyword: "embedding", ...TEXT_ONLY },
  { keyword: "embed", ...TEXT_ONLY },
  { keyword: "whisper", ...TEXT_ONLY },
  { keyword: "tts", ...TEXT_ONLY },
  { keyword: "speech", ...TEXT_ONLY },
  { keyword: "transcribe", ...TEXT_ONLY },
  { keyword: "nai-diffusion", ...IMAGE_OUT },
  { keyword: "dall-e", ...IMAGE_OUT },
  { keyword: "imagen", ...IMAGE_OUT },
  { keyword: "gpt-image", ...IMAGE_OUT },
  { keyword: "flux", ...IMAGE_OUT },
  { keyword: "stable-diffusion", ...IMAGE_OUT },
];

export function fallbackModalities(modelId) {
  const id = typeof modelId === "string" ? modelId.toLowerCase() : "";
  for (const rule of MODALITY_TIER_RULES) {
    if (id.includes(rule.keyword)) {
      return { input: [...rule.input], output: [...rule.output] };
    }
  }
  return {
    input: [...UNMATCHED_MODALITIES_FALLBACK.input],
    output: [...UNMATCHED_MODALITIES_FALLBACK.output],
  };
}

export function modalitiesFromStoreModel(model, modelId) {
  const fallback = fallbackModalities(modelId);
  const input =
    model && Array.isArray(model.inputModalities) && model.inputModalities.length > 0
      ? [...model.inputModalities]
      : fallback.input;
  const output =
    model && Array.isArray(model.outputModalities) && model.outputModalities.length > 0
      ? [...model.outputModalities]
      : fallback.output;
  return { input, output };
}
