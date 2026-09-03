// Gemini REST path parsing for the antigravity (agy) Gemini API-key frontend.
// Pure functions only. No IO, no network.
//
// agy's google-genai-sdk (Go) builds request paths of the shape:
//
//   /v1beta/models/<slug>:generateContent
//   /v1beta/models/<slug>:streamGenerateContent?alt=sse
//   /v1beta/models/<slug>:countTokens
//
// where <slug> is one of agy's hardcoded model slugs (e.g. "gemini-3.1-pro-preview").
// The relay maps each slug to a store provider/model via the alias table, so the
// parser never has to recover a provider/model from the path (unlike the OpenAI
// frontend, which encodes the provider in the URL). It only isolates the slug and
// the method.
//
// A leading "models/" inside <slug> is stripped if present (the SDK's tModel
// prepends "models/" only for bare slugs, but we tolerate both shapes so a future
// client that sends "models/<slug>" is not rejected). The slug itself must be free
// of "..", "?", "&" — the SDK already rejects these, and we re-assert it so a
// malformed slug can never smuggle path traversal or a query into the alias lookup.

const VERSION_PREFIX = "/v1beta/";
const MODELS_PREFIX = "models/";
const SEGMENT_PREFIX = "/models/";

export const PARSE_REASON = {
  NOT_A_STRING: "path-not-a-string",
  NOT_GEMINI: "not-a-gemini-path",
  NO_MODELS: "no-models-segment",
  NO_METHOD: "no-method-separator",
  EMPTY_SLUG: "empty-slug",
  INVALID_SLUG: "invalid-slug-character",
  UNKNOWN_METHOD: "unknown-method",
};

export const METHODS = {
  GENERATE: "generateContent",
  STREAM: "streamGenerateContent",
  COUNT_TOKENS: "countTokens",
};

const VALID_METHODS = new Set(Object.values(METHODS));

function reject(reason, message) {
  return { ok: false, reason, message };
}

// Parse a Gemini REST path into { ok, slug, method }.
//
// `path` is the URL pathname (no query string). The method is the substring after
// the last ':' that names a known method, so a slug that legitimately contains a
// ':' (none of agy's hardcoded slugs do) would still be handled by anchoring on
// the method suffix rather than the first colon.
export function parseGeminiPath(path) {
  if (typeof path !== "string") {
    return reject(PARSE_REASON.NOT_A_STRING, "path must be a string");
  }
  if (!path.startsWith(VERSION_PREFIX)) {
    return reject(PARSE_REASON.NOT_GEMINI, `path must start with "${VERSION_PREFIX}"`);
  }
  if (!path.startsWith(VERSION_PREFIX + "models/") && path !== VERSION_PREFIX + "models") {
    // Allow only /v1beta/models/<...> (and the bare /v1beta/models list route is
    // not handled here — it goes through the server's own listModels branch).
    return reject(PARSE_REASON.NO_MODELS, `path must be under "${VERSION_PREFIX}models/"`);
  }

  const afterModels = path.slice(VERSION_PREFIX.length + "models/".length);
  // Method is the last ':' that precedes a known method name.
  const methods = Array.from(VALID_METHODS);
  let method = null;
  let rest = afterModels;
  for (const candidate of methods) {
    const suffix = ":" + candidate;
    if (afterModels.endsWith(suffix)) {
      method = candidate;
      rest = afterModels.slice(0, afterModels.length - suffix.length);
      break;
    }
  }
  if (method === null) {
    return reject(PARSE_REASON.NO_METHOD, "path has no known :method suffix");
  }

  let slug = rest;
  // Tolerate a redundant "models/" prefix inside the slug segment.
  if (slug.startsWith(MODELS_PREFIX)) {
    slug = slug.slice(MODELS_PREFIX.length);
  }
  if (slug.length === 0) {
    return reject(PARSE_REASON.EMPTY_SLUG, "model slug segment is empty");
  }
  // Re-assert the SDK's slug rules. The slug reaches the alias table, so it must
  // never carry traversal or query characters that could be misread downstream.
  if (slug.includes("..") || slug.includes("?") || slug.includes("&")) {
    return reject(PARSE_REASON.INVALID_SLUG, `model slug "${slug}" contains a forbidden character`);
  }
  return { ok: true, slug, method };
}

// Inverse, for logging/tests. Not used on the request path.
export function buildGeminiPath(slug, method = METHODS.GENERATE) {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("buildGeminiPath: slug must be a non-empty string");
  }
  if (!VALID_METHODS.has(method)) {
    throw new Error(`buildGeminiPath: unknown method "${method}"`);
  }
  return `${VERSION_PREFIX}models/${slug}:${method}`;
}
