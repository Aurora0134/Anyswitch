const PREFIX = "/openai/";

export const PARSE_REASON = {
  NOT_OPENAI: "not-an-openai-path",
  NOT_A_STRING: "path-not-a-string",
  NO_PROVIDER: "no-provider-segment",
  EMPTY_PROVIDER: "empty-provider-segment",
  INVALID_PROVIDER: "invalid-provider-character",
};

export function parseOpenAIPath(path) {
  if (typeof path !== "string") {
    return { ok: false, reason: PARSE_REASON.NOT_A_STRING, message: "path must be a string" };
  }
  if (!path.startsWith(PREFIX)) {
    return { ok: false, reason: PARSE_REASON.NOT_OPENAI, message: `path must start with "${PREFIX}"` };
  }
  const rest = path.slice(PREFIX.length);
  const cut = rest.indexOf("/");
  if (cut === -1) {
    return { ok: false, reason: PARSE_REASON.NO_PROVIDER, message: "no provider segment after /openai/" };
  }
  let providerId = rest.slice(0, cut);
  try {
    providerId = decodeURIComponent(providerId);
  } catch {
    return { ok: false, reason: PARSE_REASON.INVALID_PROVIDER, message: "provider segment is not valid percent-encoded" };
  }
  if (providerId.length === 0) {
    return { ok: false, reason: PARSE_REASON.EMPTY_PROVIDER, message: "provider segment is empty" };
  }
  if (providerId.includes("/")) {
    return { ok: false, reason: PARSE_REASON.INVALID_PROVIDER, message: `provider id "${providerId}" must not contain '/' (v2 store invariant)` };
  }
  const subpath = rest.slice(cut);
  return { ok: true, providerId, subpath };
}

export function buildOpenAIPath(providerId, subpath = "/v1/chat/completions") {
  if (typeof providerId !== "string" || providerId.length === 0) {
    throw new Error("buildOpenAIPath: providerId must be a non-empty string");
  }
  if (providerId.includes("/")) {
    throw new Error(`buildOpenAIPath: provider id "${providerId}" must not contain '/'`);
  }
  return `${PREFIX}${encodeURIComponent(providerId)}${subpath}`;
}