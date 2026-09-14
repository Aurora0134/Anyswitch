// Request-time reasoning-depth injection (the relay's own injection surface).
//
// Seven of the eight endpoints can be handed a level picker through their config
// file; the relay covers what every endpoint shares on top of that — a client
// that simply never picks one, and a client that picks one in a shape the
// upstream does not speak. Qoder has no level surface at all, and kimi's global
// switch can pin its default path off, so without this the upstream would be
// asked for "the model's own default", which for most gateway models means no
// thinking.
//
// This is the request half of the same feature the config writers implement;
// both are governed by the one 「注入推理强度」 switch, so turning it off means
// no endpoint is told about levels AND no default is filled in at request time.
//
// Five rules, in order:
//   1. the switch is off → nothing happens (the request goes upstream exactly
//      as the client wrote it);
//   2. a client that put the field on the wire itself is never overridden (the
//      field is left alone even when its value is null — saying "no thinking" is
//      a choice);
//   3. a client that named a level in another protocol's shape (the Anthropic
//      surface has no `reasoning_effort`) gets that level forwarded, clipped to
//      the deepest level this model's stated ladder actually carries;
//   4. a client that named nothing gets the library default: a store row that
//      states its own levels answers first (`reasoningEffortLevels` /
//      `reasoningVariants`, with `defaultEffort` naming the level when it is
//      legal), and the level is never `max` by construction (the a6api gateway
//      kills a deep-thinking agentic request at ~296s wall clock and bills it
//      anyway);
//   5. if a channel answers that it does not take the parameter, the field is
//      dropped and the request is sent again, and that channel stops being
//      injected for.
//
// The rejection memory is deliberately process-local. The store file belongs to
// the panel process (writes go through its CAS + delete journal), so a relay
// that wrote machine state into it would race the UI; losing one flag on restart
// costs one retried request.

import {
  EFFORT_LEVELS_ORDER,
  getEffortCatalog,
  resolveModelEfforts,
  resolveDeclaredEfforts,
  modelDeclaresOwnEfforts,
  pickDefaultEffort,
  defaultEffortDbPath,
} from "./effort-catalog.mjs";
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

  /**
   * The level to send for one request, or null when there is nothing to add.
   *
   * A store row that states its own levels answers first, exactly as it does
   * on the config face: the operator's declaration is the authority, and the
   * library only fills the gap. `defaultEffort` names the level when it is
   * present and legal; otherwise the deepest declared level the preference
   * order allows.
   */
  function defaultLevelFor(rawId, model, provider) {
    if (typeof rawId !== "string" || rawId.length === 0) return null;
    if (modelDeclaresOwnEfforts(model, provider)) {
      const declared = resolveDeclaredEfforts(rawId, { catalog: currentCatalog(), model, provider });
      if (declared.levels.length === 0) return null;
      const stated = typeof model?.defaultEffort === "string" ? model.defaultEffort : null;
      if (stated && declared.levels.includes(stated)) return stated;
      return pickDefaultEffort(declared.levels);
    }
    const resolved = resolveModelEfforts(rawId, currentCatalog());
    if (resolved.kind === "non-text" || resolved.levels.length === 0) return null;
    return resolved.default;
  }

  /**
   * The level ladder someone has actually stated for this model, or null when
   * nobody has. Only a library row or a store declaration counts as stated: the
   * optimistic fallback set is what the catalog invents for an unknown model,
   * and clipping a client's own choice to an invented list would silently
   * downgrade a request that the upstream might have honored.
   */
  function statedLevelsFor(rawId, model, provider) {
    if (typeof rawId !== "string" || rawId.length === 0) return null;
    const catalog = currentCatalog();
    if (modelDeclaresOwnEfforts(model, provider)) {
      return resolveDeclaredEfforts(rawId, { catalog, model, provider }).levels;
    }
    const resolved = resolveModelEfforts(rawId, catalog);
    return resolved.origin === "library" ? resolved.levels : null;
  }

  /**
   * The client's level as this model can actually take it, or null when the
   * client asked for no thinking at all.
   *
   * With a stated ladder, the level is clipped to the nearest level the ladder
   * carries (a tie resolves to the shallower one) so what goes upstream is always
   * a value the model is known to take — an unsupported one would come back as a
   * refusal and switch injection off for the whole channel. Without one, or for a
   * name the shared ladder does not know, the client's own value is forwarded:
   * nothing here is qualified to translate it, and the refusal retry still
   * catches a gateway that turns out not to want it.
   */
  function clampToStatedLevels(rawId, level, model, provider) {
    const lower = level.toLowerCase();
    if (lower === "off" || lower === "none") return null;
    const stated = statedLevelsFor(rawId, model, provider);
    if (stated === null || stated.length === 0) return level;
    if (stated.includes(level)) return level;
    const asked = EFFORT_LEVELS_ORDER.indexOf(level);
    if (asked === -1) return level;
    let best = null;
    let bestDistance = Infinity;
    for (const candidate of stated) {
      const depth = EFFORT_LEVELS_ORDER.indexOf(candidate);
      if (depth === -1) continue;
      const distance = Math.abs(depth - asked);
      if (distance < bestDistance || (distance === bestDistance && depth < EFFORT_LEVELS_ORDER.indexOf(best))) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best ?? level;
  }

  /**
   * @param {{ providerId: string, body: object, clientEffort?: {stated: boolean,
   *           level: string|null}|null, model?: object, provider?: object }} args
   * @returns {{ body: object, injected: string|null }} the body to send and the
   *          level added, if any. `injected` is what the caller may drop on a
   *          rejection retry, so it must be exact.
   */
  function inject({ providerId, body, clientEffort = null, model = null, provider = null }) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return { body, injected: null };
    if (!enabled()) return { body, injected: null };
    if (EFFORT_REQUEST_FIELD in body) return { body, injected: null };
    if (rejectedChannels.has(providerId)) return { body, injected: null };
    if (clientEffort?.stated) {
      if (typeof clientEffort.level !== "string" || clientEffort.level.length === 0) {
        return { body, injected: null };
      }
      const level = clampToStatedLevels(body.model, clientEffort.level, model, provider);
      if (!level) return { body, injected: null };
      return { body: { ...body, [EFFORT_REQUEST_FIELD]: level }, injected: level };
    }
    const level = defaultLevelFor(body.model, model, provider);
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
      `渠道 "${providerId}" 不接受思考深度参数，已停用该渠道的注入：Claude Code 选的档位与未选档时的代填都不再下发。`,
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
 * The persisted 「注入推理强度」 switch, read from disk on every call so a panel
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
