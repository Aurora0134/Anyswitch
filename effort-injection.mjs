// Request-time thinking-depth injection (the relay's own injection surface).
//
// Seven of the eight endpoints can be handed a level picker through their config
// file; the relay covers the case every endpoint shares — a client that simply
// never picks one. Qoder has no level surface at all, and kimi's global switch
// can pin its default path off, so without this the upstream would be asked for
// "the model's own default", which for most gateway models means no thinking.
//
// Three rules, in order:
//   1. a client that named a level is never overridden (the field is left alone
//      even when its value is null — saying "no thinking" is a choice);
//   2. the level sent is the library's default for that model, which is never
//      `max` by construction (the a6api gateway kills a deep-thinking agentic
//      request at ~296s wall clock and bills it anyway);
//   3. if a channel answers that it does not take the parameter, the field is
//      dropped and the request is sent again, and that channel stops being
//      injected for.
//
// The rejection memory is deliberately process-local. The store file belongs to
// the panel process (writes go through its CAS + delete journal), so a relay
// that wrote machine state into it would race the UI; losing one flag on restart
// costs one retried request.

import { getEffortCatalog, resolveModelEfforts, defaultEffortDbPath } from "./effort-catalog.mjs";
import { loadSettings, defaultSettingsPath } from "./relay-settings.mjs";

export const EFFORT_REQUEST_FIELD = "reasoning_effort";
const REJECTION_STATUSES = new Set([400, 422]);

/**
 * Whether an upstream error names the thinking-depth parameter.
 *
 * Deliberately narrow on the status side (only the two "your request body is
 * wrong" codes) and wide on the wording side: gateways phrase the same
 * rejection as `Unsupported parameter: 'reasoning_effort'`, `unknown field
 * effort`, or a bare mention of the parameter inside a schema dump.
 */
export function looksLikeEffortRejection(status, responseText) {
  if (!REJECTION_STATUSES.has(status)) return false;
  const text = typeof responseText === "string" ? responseText : "";
  if (text.length === 0) return false;
  if (/reasoning[_\s-]*effort/i.test(text)) return true;
  return /\beffort\b/i.test(text)
    && /(unsupported|unknown|unrecognized|unrecognised|invalid|unexpected|not allowed|not supported|extra field)/i.test(text);
}

/**
 * The upstream's own words about a failed request, or "" when there are none.
 * Both relay paths need it to judge a rejection, and neither may let a missing
 * body turn into an exception on the error path.
 */
export async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export function createEffortInjector({
  isEnabled = null,
  catalog = null,
  logger = null,
  dbPath = defaultEffortDbPath(),
} = {}) {
  const rejectedChannels = new Set();

  function enabled() {
    // Read per request so a panel save takes effect on the next request
    // without a relay restart (same contract as keep-alive's config thunk).
    try {
      return isEnabled ? isEnabled() !== false : true;
    } catch {
      return true;
    }
  }

  function currentCatalog() {
    if (catalog) return typeof catalog === "function" ? catalog() : catalog;
    try {
      return getEffortCatalog(dbPath);
    } catch {
      return null;
    }
  }

  /** The level to send for one model, or null when there is nothing to add. */
  function defaultLevelFor(modelId) {
    if (typeof modelId !== "string" || modelId.length === 0) return null;
    const resolved = resolveModelEfforts(modelId, currentCatalog());
    if (resolved.kind === "non-text" || resolved.levels.length === 0) return null;
    return resolved.default;
  }

  /**
   * @param {{ providerId: string, body: object, clientChoseEffort?: boolean }} args
   * @returns {{ body: object, injected: string|null }} the body to send and the
   *          level added, if any. `injected` is what the caller may drop on a
   *          rejection retry, so it must be exact.
   */
  function inject({ providerId, body, clientChoseEffort = false }) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return { body, injected: null };
    if (!enabled()) return { body, injected: null };
    if (clientChoseEffort) return { body, injected: null };
    if (EFFORT_REQUEST_FIELD in body) return { body, injected: null };
    if (rejectedChannels.has(providerId)) return { body, injected: null };
    const level = defaultLevelFor(body.model);
    if (!level) return { body, injected: null };
    return { body: { ...body, [EFFORT_REQUEST_FIELD]: level }, injected: level };
  }

  /** Same body with the injected field removed — used for the one retry. */
  function withoutEffort(body) {
    if (body === null || typeof body !== "object" || !(EFFORT_REQUEST_FIELD in body)) return body;
    const copy = { ...body };
    delete copy[EFFORT_REQUEST_FIELD];
    return copy;
  }

  function noteRejected(providerId) {
    if (rejectedChannels.has(providerId)) return;
    rejectedChannels.add(providerId);
    logger?.warn?.(
      `渠道 "${providerId}" 不接受思考深度参数，已停用该渠道的注入：模型档位仍可手动选择，未选档时不再代填。`,
    );
  }

  return {
    inject,
    withoutEffort,
    noteRejected,
    isRejected: (providerId) => rejectedChannels.has(providerId),
  };
}

/**
 * The persisted 「注入思考强度」 switch, read from disk on every call so a panel
 * save takes effect on the next request without restarting the relay (same
 * contract as the keep-alive config thunk).
 */
export function settingsEffortInjectionEnabled(base = process.env) {
  return loadSettings(defaultSettingsPath(base), base).injectThinkingEffort;
}

/** The injector every relay path should use unless it is handed one explicitly. */
export function defaultEffortInjector({ logger = null, base = process.env } = {}) {
  return createEffortInjector({ logger, isEnabled: () => settingsEffortInjectionEnabled(base) });
}
