// Catalog generation binding.
// Pure functions only. No IO.
//
// discovery (GET /v1/models) records a generation = content digest of the parts
// of the store that decide WHERE a request goes. POST /v1/messages recomputes it
// and refuses (409) on mismatch, so a provider deleted and recreated under the
// same id but a different endpoint cannot silently receive traffic.
//
// The digest covers, per provider: baseURL, fallbackURLs, protocol,
// credentialFile and the model id set. displayName / contextWindow /
// maxOutputTokens / inputModalities / outputModalities are presentation
// metadata and deliberately excluded: changing them must not invalidate a live
// session. The digest carries no secrets (the store has none by contract).
//
// Note: protocol is a routing-relevant field even though the current schema
// only accepts "openai-compatible". If the schema ever opens to multiple
// protocols, protocol must remain in the digest so a routing change invalidates
// a live session — the same reason baseURL is included.

import { contentHash } from "./atomic-write.mjs";

export function catalogGeneration(store) {
  const providers = store?.providers ?? {};
  const shape = Object.keys(providers)
    .sort()
    .map((providerId) => {
      const p = providers[providerId] ?? {};
      return {
        providerId,
        baseURL: p.baseURL ?? null,
        fallbackURLs: p.fallbackURLs ?? null,
        protocol: p.protocol ?? null,
        credentialFile: p.credentialFile ?? null,
        models: Object.keys(p.models ?? {}).sort(),
      };
    });
  return contentHash(JSON.stringify({ version: store?.version ?? null, providers: shape }));
}

// Strict equality only. No "provider id still present so allow it" leniency.
export function generationMatches(recorded, current) {
  return typeof recorded === "string" && recorded.length > 0 && recorded === current;
}
