// Gemini REST transport for the antigravity (agy) frontend.
//
// handleGeminiRoute(req, res, deps) is mounted inside the resident relay's
// createOpenAIRelayServer (see openai-server.mjs): it returns true when it
// handled the request (Gemini path), false otherwise so the caller falls through
// to the OpenAI / panel / hello routes. This keeps the single 127.0.0.1:47821
// binding serving OpenAI, Anthropic (per-launch), the panel, and now Gemini,
// with no port juggling.
//
// Loopback-only, 32 MB body cap, generic errors — same boundaries as the other
// two frontends. Streaming responses are translated from upstream OpenAI SSE to
// Gemini alt=sse SSE via GeminiStreamTranslator.

import { createGeminiHandler, geminiError, extractPresentedGeminiKey, matchGeminiKey } from "./gemini-handler.mjs";
import { sendJson, runStreamWithKeepAlive, geminiStreamChannel } from "./stream-pipe.mjs";
import { isPoolFailoverStatus } from "./pool-routing.mjs";
import { isChainFailoverStatus } from "./chain-routing.mjs";
import { instanceIdFromSocket, bindLateSocketInstance } from "./late-socket-instance.mjs";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const VERSION_PREFIX = "/v1beta/";

export class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        if (!tooLarge) {
          tooLarge = true;
          reject(new BodyTooLargeError());
        }
        chunk.fill(0);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

// The handler carries the pool sticky table in its closure, so it must be
// created once per deps set — not per request, or every request would start
// with an empty sticky table. Hot reload is unaffected: the handler re-reads
// the store and re-resolves the alias on every call. Keyed by deps so each
// relay instance (and each test server) gets its own table.
const handlerCache = new WeakMap();
function geminiHandlerFor(deps) {
  if (deps.geminiHandler) return deps.geminiHandler;
  let handler = handlerCache.get(deps);
  if (handler === undefined) {
    handler = createGeminiHandler(deps);
    handlerCache.set(deps, handler);
  }
  return handler;
}

// Introspection for the relay's /api/internal/route-chain-runtime endpoint:
// the chain state of the cached per-deps gemini handler. Creating the handler
// here on first access is harmless — its tables start empty, exactly what the
// runtime view should report before any gemini request.
export function geminiChainStateFor(deps) {
  return geminiHandlerFor(deps).chainState;
}

// Mounted by the resident relay. Returns true if the request was a Gemini route
// (handled), false if the caller should try other routes. Non-loopback peers are
// rejected by the caller before this is called (openai-server.mjs guards the
// whole server), so we do not re-check here.
export async function handleGeminiRoute(req, res, deps) {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;
  if (!path.startsWith(VERSION_PREFIX)) return false;

  const handler = geminiHandlerFor(deps);
  const query = Object.fromEntries(url.searchParams.entries());

  try {
    if (path === "/v1beta/models" && req.method === "GET") {
      const result = await handler.handleModels(req.headers, query);
      sendJson(res, result.status, result.body);
      return true;
    }

    if (req.method === "POST") {
      // Match :generateContent / :streamGenerateContent / :countTokens. A cheap
      // structural check first, then read the body only for the POST routes.
      if (/:generateContent$/.test(path) || /:streamGenerateContent$/.test(path) || /:countTokens$/.test(path)) {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, geminiError(400, "request body is not valid JSON"));
          return true;
        }

        // Pre-parse slug to create metrics tracker. Resolve the alias so the
        // panel's model-stability card and agent status always show the correct
        // providerId — without this, agy-endpoint models had an empty provider.
        // Pool routing (phase 2): when the alias target names a pool, the pool
        // id is the tracker's providerId (the main key); individual member ids
        // ride the failure/retry records instead.
        const parsedSlugMatch = path.match(/^\/v1beta\/models\/([^:]+):/);
        const requestSlug = parsedSlugMatch ? parsedSlugMatch[1] : null;
        let resolvedProviderId = null;
        let resolvedModelId = null;
        if (requestSlug && deps.aliasResolver) {
          try {
            const resolved = deps.aliasResolver.resolve(requestSlug);
            if (resolved.ok) {
              resolvedProviderId = resolved.providerId;
              resolvedModelId = resolved.modelId;
            }
          } catch {
            // alias resolution is best-effort for metrics; the handler will
            // independently validate the slug and return a 404 if needed
          }
        }

        const isStream = /:streamGenerateContent$/.test(path);

        // Per-instance tag: the relay key may carry a "token.instanceId"
        // suffix (agy's GEMINI_API_KEY passes through verbatim). Only a key
        // that actually authenticates may tag an instance — a wrong base must
        // not spray instance ids into metrics. The handler re-checks auth
        // independently below; this is purely the metrics view of the key.
        // The suffix (launcher-injected "<cwd基名>-<launcher pid>") is
        // normalized consumer-side inside collector.startRequest — the same
        // normalizeInstanceId fold as the openai header path.
        const presentedKey = extractPresentedGeminiKey(req.headers, query);
        const keyMatch = matchGeminiKey(presentedKey, deps.token);

        // Socket→PID 兜底（与 openai 路径同一机制，见 instance-socket-owner.mjs
        // 与 openai-server.mjs 的 instanceIdForRequest）：relay key 不带
        // ".instanceId" 后缀时（用户绕过 launcher 直连），用 netstat 快照反查
        // keep-alive 连接对端进程，合成 "agy-<pid>"。仅鉴权通过的 key 可以
        // 兜底——错误 key 连实例都不该打（同上 keyMatch 注释的口径）；
        // pid === process.pid 是 relay 自环，不兜底。
        let geminiInstanceId = keyMatch.ok ? keyMatch.instanceId : null;
        if (geminiInstanceId === null && keyMatch.ok) {
          geminiInstanceId = instanceIdFromSocket(req, "agy", deps);
        }

        const tracker = deps.metricsCollector?.startRequest({
          agentId: "agy",
          providerId: resolvedProviderId,
          model: resolvedModelId || requestSlug,
          userAgent: req.headers["user-agent"],
          stream: isStream,
          path: "gemini",
          instanceId: geminiInstanceId,
        });
        if (keyMatch.ok) {
          bindLateSocketInstance(req, "agy", deps, tracker, { explicitId: keyMatch.instanceId });
        }

        const abortController = new AbortController();
        const onResAborted = () => {
          if (!res.writableEnded) {
            abortController.abort();
            tracker?.recordEnd({ aborted: true });
          }
        };
        res.on("close", onResAborted);

        try {
          // Chain routing (virtual model "auto"): the slug "auto" has no
          // alias, so when the agy endpoint has a chain in
          // store.routingChains the request walks the chain before any alias
          // resolution. agentId is "agy" — the same constant this transport
          // already hardcodes for metrics; the Gemini path serves no other
          // agent. planChainGenerate returns null for every other slug.
          const chainPlan = (await handler.planChainGenerate?.(path, req.headers, query, body, { agentId: "agy" })) ?? null;
          if (chainPlan !== null && !chainPlan.ok) {
            tracker?.recordEnd({ status: chainPlan.status, error: { status: chainPlan.status, message: chainPlan.body?.error?.message || "Error" } });
            sendJson(res, chainPlan.status, chainPlan.body);
            return true;
          }

          // Pool routing (phase 2): when the slug's alias target names a pool,
          // the request fans out across the pool's candidate members (sticky
          // member first, then pool order). planPoolGenerate returns null for
          // plain provider aliases — those take the classic path below
          // untouched. Skipped when the chain plan already claimed the request.
          const poolPlan = chainPlan === null
            ? ((await handler.planPoolGenerate?.(path, req.headers, query, body)) ?? null)
            : null;
          if (poolPlan !== null && !poolPlan.ok) {
            tracker?.recordEnd({ status: poolPlan.status, error: { status: poolPlan.status, message: poolPlan.body?.error?.message || "Error" } });
            sendJson(res, poolPlan.status, poolPlan.body);
            return true;
          }

          // Chain and pool plans share one shape ({ members, noteSuccess }),
          // so the non-stream loop and the keep-alive stream below run either
          // unchanged. The label only feeds the failover log line.
          const routePlan = chainPlan ?? poolPlan;
          const routeLabel = chainPlan ? `chain "${chainPlan.endpointId}"` : `pool "${poolPlan?.poolId}"`;
          // Failover semantics differ by plan kind: chain plans treat an
          // upstream 404 as a node-level failure (the node cannot serve its
          // bound model), pool plans keep 404 request-shaped (passthrough).
          const isFailoverStatus = chainPlan ? isChainFailoverStatus : isPoolFailoverStatus;
          // Auto-route stats attribution: journal/stability rows land on the
          // serving chain node (node + bound model). Without it, "auto" has no
          // alias and the tracker's providerId is null, so rows fell back to a
          // stale lastProvider. Pool plans keep pool-level attribution.
          if (chainPlan) tracker?.setAttributeResolver?.((memberId) => chainPlan.attributeOf?.(memberId) ?? null);

          if (routePlan && !isStream) {
            // Non-streaming routed request: one attempt per member (no
            // keep-alive, same as the classic path), failing over on
            // plan-kind channel-level faults (chain: any 4xx, pool:
            // isPoolFailoverStatus). The client receives the LAST member's
            // error when all fail.
            let result;
            for (let index = 0; index < routePlan.members.length; index += 1) {
              const member = routePlan.members[index];
              tracker?.setCurrentMember?.(member.memberId);
              result = await member.call({ signal: abortController.signal });
              if (result.status < 400) {
                routePlan.noteSuccess(member.memberId);
                break;
              }
              const isLastMember = index === routePlan.members.length - 1;
              if (isLastMember || !isFailoverStatus(result.status)) break;
              tracker?.recordRetry?.({ reason: `upstream_${result.status}`, memberId: member.memberId, usage: result.usage });
              deps.logger?.warn?.(`${routeLabel}: member "${member.memberId}" returned ${result.status}; failing over to the next member`);
              routePlan.noteFailure?.(member.memberId);
            }
            if (result.status >= 400) {
              tracker?.recordEnd({ status: result.status, error: { status: result.status, message: result.body?.error?.message || "Error" }, usage: result.usage });
            } else {
              tracker?.recordEnd({ status: result.status, usage: result.usage });
            }
            sendJson(res, result.status, result.body);
            return true;
          }

          await runStreamWithKeepAlive(res, geminiStreamChannel({
            res,
            tracker,
            abortController,
            deps,
            ...(routePlan
              ? {
                  // One callable per candidate member; the keep-alive loop
                  // gives each member its own retry budget and only the last
                  // member's failure goes terminal. The failover class comes
                  // from the plan kind (chain: any 4xx, pool:
                  // isPoolFailoverStatus); a committed stream never switches
                  // members.
                  callUpstreams: routePlan.members.map((member) => ({
                    memberId: member.memberId,
                    memberNoun: member.memberNoun,
                    call: () => member.call({ signal: abortController.signal }),
                  })),
                  shouldFailover: (result) => isFailoverStatus(result.status),
                  onMemberSuccess: (member) => routePlan.noteSuccess(member.memberId),
                  onMemberFailover: (member) => routePlan.noteFailure?.(member.memberId),
                }
              : {
                  callUpstream: () => handler.handleGenerate(path, req.headers, query, body, { signal: abortController.signal }),
                }),
          }));
        } finally {
          res.removeListener("close", onResAborted);
        }
        return true;
      }
    }

    // A /v1beta/ path we do not handle — return false so the caller emits its
    // own 404 (consistent with the OpenAI frontend's catch-all), rather than a
    // Gemini-specific 404 that might confuse a non-Gemini client.
    return false;
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      if (!res.headersSent) sendJson(res, 413, geminiError(413, "request body exceeds the maximum allowed size"));
      return true;
    }
    if (!res.headersSent) {
      sendJson(res, 500, geminiError(500, "the relay failed to handle this request"));
    } else {
      res.end();
    }
    return true;
  }
}

// Re-export for callers that want a standalone Gemini server (e.g. tests / a
// dedicated ephemeral-port relay like the Anthropic launcher path).
export { isLoopback };
