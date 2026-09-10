// Catalog routing-shape binding.
// Pure functions only. No IO.
//
// Discovery (GET /v1/models, and the OpenAI-side model list) snapshots WHERE
// traffic goes, per provider id. A request then re-checks only the providers it
// is actually about to call, so editing a channel the request never touches
// cannot invalidate it. POST /v1/messages refuses (409) when one of THIS
// request's providers was re-pointed after discovery — the case the binding
// exists for is a provider deleted and recreated under the same id against a
// different endpoint, which would otherwise silently receive the session's
// traffic.
//
// Per provider the shape covers baseURL, fallbackURLs, protocol and
// credentialFile. Everything else is deliberately out:
//   - the model set — adding or deleting a model on a channel re-points no
//     traffic, and a model that has gone away is already the existing 404 path's
//     business. This is what stops "I refreshed some other provider" from
//     409-ing every live session in the process.
//   - displayName / contextWindow / maxOutputTokens / supportsReasoning /
//     reasoningEffortLevels / defaultEffort / modalities — presentation and
//     request-shaping metadata. The model id itself is what goes upstream, so no
//     model-level field steers a request.
//   - pools, route chains, store version — pool/chain membership is resolved per
//     request and never decides the endpoint; a store the loader cannot validate
//     is already a 502, not a stale catalog.
// The snapshot carries no secrets (the store has none by contract).
//
// Note: protocol is a routing-relevant field even though the current schema
// only accepts "openai-compatible". If the schema ever opens to multiple
// protocols, protocol must stay in the shape so a routing change invalidates a
// live session — the same reason baseURL is included.

import { contentHash } from "./atomic-write.mjs";

function providerShapeHash(providerId, provider) {
  const p = provider ?? {};
  return contentHash(JSON.stringify({
    providerId,
    baseURL: p.baseURL ?? null,
    fallbackURLs: p.fallbackURLs ?? null,
    protocol: p.protocol ?? null,
    credentialFile: p.credentialFile ?? null,
  }));
}

// The snapshot discovery binds to: { providerId -> routing shape }.
export function providerRoutingShapes(store) {
  const providers = store?.providers ?? {};
  const shapes = {};
  for (const providerId of Object.keys(providers).sort()) {
    shapes[providerId] = providerShapeHash(providerId, providers[providerId]);
  }
  return shapes;
}

// Which of `providerIds` — every provider this request may reach — has been
// re-pointed since the snapshot was taken. An empty list means "route it".
//
// A provider absent from the snapshot appeared after discovery, so nothing the
// client learned about it has moved. A provider absent from the store now is
// reported by the existing 404 path, not by this gate.
export function findStaleTargets(snapshot, store, providerIds) {
  const stale = [];
  const seen = new Set();
  for (const providerId of providerIds ?? []) {
    if (seen.has(providerId)) continue;
    seen.add(providerId);
    const recorded = snapshot?.[providerId];
    if (recorded === undefined) continue;
    const current = store?.providers?.[providerId];
    if (current === undefined) continue;
    if (recorded !== providerShapeHash(providerId, current)) stale.push(providerId);
  }
  return stale;
}
