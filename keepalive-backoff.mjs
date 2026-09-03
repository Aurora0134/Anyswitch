// Shared keep-alive retry backoff for all four relay pipelines
// (openai-server.mjs x2, server.mjs, gemini-server.mjs).
//
// Pure and injectable-rng so tests can pin exact values: delay for the nth
// retry (1-based) is backoffMs * 2^(n-1) scaled by a jitter factor in
// [0.5, 1.0]. The upper bound equals the plain exponential delay, so the
// worst case stays predictable and maxRetries=1 keeps the old fixed-delay
// ceiling (backoffMs).

export function computeRetryDelay(backoffMs, attempt, rng = Math.random) {
  const base = Math.max(0, backoffMs) * 2 ** (Math.max(1, attempt) - 1);
  return base * (0.5 + rng() * 0.5);
}
