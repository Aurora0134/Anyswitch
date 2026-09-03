// Relay production wiring.
//
// Assembles the handler's injected IO surface from the real production pieces:
//   loadStore      -> store-io.mjs loadStore() against the real v2 store
//   loadCredential -> store-io.mjs readCiphertext() + dpapi.mjs unprotect(v2)
//   upstreamFetch  -> retrying wrapper around global fetch
//
// Credential rules carried over from handler.mjs: decrypt only at
// request time, hand the plaintext to exactly one upstream call, never cache,
// never log. Every ciphertext/plaintext Buffer this module controls is zeroed
// in a finally; the one unavoidable exception is the JS string handed to the
// HTTP Authorization header, whose lifetime is bounded by the runtime and
// cannot be explicitly overwritten.

import { join } from "node:path";
import { loadStore as ioLoadStore, readCiphertext, storePaths } from "./store-io.mjs";
import { unprotect } from "./dpapi.mjs";
import { createRelayServer, generateToken, listenLoopback } from "./server.mjs";
import { createSessionReporter } from "./agent-metrics.mjs";
import { createUsageJournal } from "./usage-journal.mjs";
import { loadSettings, defaultSettingsPath } from "./relay-settings.mjs";

// Per-endpoint upstream deadline. This bounds fetch() resolve time, which for
// non-streaming chat completions is the FULL generation time (headers arrive
// only after the upstream has the complete response), and for streaming is
// time-to-first-byte. The original 5s default aborted legitimate slow LLM
// generations and collapsed them to 502 (notably Claude Code's non-streaming
// small-fast classifier calls). 180s absorbs real generation/TTFB latency while
// still failing over for a genuinely hanging endpoint. Launchers do not override
// this today, so the default is the production value for every consumer.
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 180_000;

function wipe(...buffers) {
  for (const buffer of buffers) buffer?.fill?.(0);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepWithAbort(sleep, ms, signal) {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("upstream request was cancelled"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("upstream request was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(sleep(ms)).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// Build the primary-first list once per request. fallbackURLs is schema-checked
// when a store is loaded; this stays intentionally small so callers can inject
// the same pure function in tests and alternate relay frontends.
export function buildUpstreamURLs(provider, path) {
  return [provider.baseURL, ...(provider.fallbackURLs ?? [])].map(
    (baseURL) => `${baseURL.replace(/\/+$/, "")}${path}`,
  );
}

function createAttemptSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let cancelledByCaller = false;

  const onCallerAbort = () => {
    cancelledByCaller = true;
    controller.abort(signal.reason);
  };
  if (signal?.aborted) {
    onCallerAbort();
  } else {
    signal?.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    wasCancelledByCaller: () => cancelledByCaller,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

async function discardResponse(response) {
  // A retryable 5xx body is never sent to the client. Cancel it so undici can
  // release the connection before the next endpoint is attempted.
  try {
    await response.body?.cancel?.();
  } catch {
    // The body was already disturbed or the socket died; either way it cannot
    // be surfaced and the next configured endpoint remains eligible.
  }
}

// The retry boundary intentionally lives here rather than in either request
// handler. A handler performs exactly one fetch over its ordered candidate list;
// this wrapper chooses the next BaseURL only after a retryable failure.
//
// Two distinct failure classes must not be collapsed together:
//   - transport error (never reached the upstream): throw, so the handler maps
//     it to 502 "could not be reached" — the relay genuinely could not reach an
//     endpoint.
//   - upstream 5xx response (reached the upstream, it errored): return the LAST
//     5xx response instead of throwing, so the handler can pass the real status
//     through. Collapsing a reached 503 into a 502 was a semantic lie that hid
//     upstream-side faults (notably minute-scale 503 internal server error from
//     a provider站点), making them indistinguishable from relay/transport
//     failures and blocking the client SDK's 5xx retry path.
export function createRetryingFetch(
  baseFetch,
  { timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS, sleep = defaultSleep } = {},
) {
  return async function retryingFetch(urls, init = {}, { bufferResponse = true } = {}) {
    const candidates = Array.isArray(urls) ? urls : [urls];
    let lastFailure = null;
    let last5xxResponse = null;

    for (let attempt = 0; attempt < candidates.length; attempt += 1) {
      if (init.signal?.aborted) {
        throw init.signal.reason ?? new Error("upstream request was cancelled");
      }
      const deadline = createAttemptSignal(init.signal, timeoutMs);
      try {
        const response = await baseFetch(candidates[attempt], { ...init, signal: deadline.signal });
        // 2xx/3xx are successful and all 4xx responses are terminal. Only 5xx
        // responses are eligible to move to the next configured endpoint.
        if (response.status < 500) {
          if (bufferResponse && response.status < 300) {
            // fetch resolves after headers. Buffer non-streaming success while
            // its per-endpoint signal is live, so a stalled body can fall back
            // instead of holding the dialogue indefinitely.
            const text = await response.text();
            return new Response(text, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          }
          return response;
        }
        // Record the real 5xx response so it can be surfaced transparently if
        // every endpoint is exhausted. The body is discarded (never sent to the
        // client) so no upstream error payload leaks, but the status code is
        // preserved.
        last5xxResponse = response;
        await discardResponse(response);
        lastFailure = { kind: "response" };
      } catch (error) {
        if (deadline.wasCancelledByCaller()) throw error;
        lastFailure = { kind: "error", value: error };
      } finally {
        deadline.dispose();
      }

      if (attempt < candidates.length - 1) {
        await sleepWithAbort(sleep, Math.min(1_000 * 2 ** attempt, 4_000), init.signal);
      }
    }

    // If the last reachable state was an upstream 5xx response, surface that
    // response (status preserved, body discarded) so the handler can pass the
    // real status code through instead of collapsing it to a transport 502.
    // Only a pure transport failure (every endpoint threw) collapses to a throw.
    if (last5xxResponse !== null) {
      return new Response(null, {
        status: last5xxResponse.status,
        statusText: last5xxResponse.statusText,
        headers: { "content-type": "application/json" },
      });
    }
    throw lastFailure?.kind === "error"
      ? lastFailure.value
      : new Error("all upstream endpoints failed");
  };
}

// The handler passes the already-validated providerId explicitly alongside the
// provider entry, so the DPAPI entropy is derived from stable request-scoped
// input. No cross-request shared state and no object-identity reverse lookup,
// which means concurrent requests can never steer each other's credential load.
export function createProductionDeps({
  paths = storePaths(),
  upstreamFetch = fetch,
  retryOptions,
  getKeepAliveConfig,
  logger = null,
  agentId = "claude",
} = {}) {
  function loadStore() {
    const loaded = ioLoadStore(paths);
    if (!loaded.ok) return { ok: false, errors: loaded.errors };
    return { ok: true, store: loaded.store };
  }

  async function loadCredential(providerId, provider) {
    if (typeof providerId !== "string" || providerId.length === 0) {
      return { ok: false, reason: "a provider id is required to load a credential" };
    }
    if (provider === null || typeof provider !== "object" || typeof provider.credentialFile !== "string") {
      return { ok: false, reason: "a provider entry with a credentialFile is required" };
    }

    let ciphertext = null;
    let plaintext = null;
    try {
      const read = readCiphertext(provider.credentialFile, paths);
      if (!read.ok) return { ok: false, reason: read.reason };
      ciphertext = read.ciphertext;
      plaintext = await unprotect(ciphertext, providerId, { generation: "v2" });
      if (plaintext.length === 0) {
        return { ok: false, reason: "credential decrypted to an empty value" };
      }
      // The handler interpolates the value into one Authorization header. Give
      // it a string and keep the buffer lifetime entirely inside this call.
      const value = plaintext.toString("utf8");
      return { ok: true, value };
    } catch {
      // Generic by design: DPAPI/helper errors never surface (dpapi.mjs).
      return { ok: false, reason: "credential could not be decrypted" };
    } finally {
      wipe(ciphertext, plaintext);
    }
  }

  // The catalog generation binding is process-local state.
  let generation = null;

  // Per-launch session reporter: pushes cumulative per-session metrics to the
  // panel's /panel/api/session/report endpoint. The report URL targets the
  // resident panel relay on 47821. The token is bound after generateToken()
  // runs in startProductionRelay. Failure to reach the panel is silent —
  // metrics are best-effort and must never break the relay's primary job.
  //
  // The usage journal targets the SAME dir the resident relay writes to, so
  // the stats tab finally sees this endpoint's request rows (per-launch relay
  // traffic never touches the resident relay). agentId 决定 journal 行的归
  // 属端点（claude / kimi），默认 claude。Journal creation failure must
  // never block the relay: fall back to no journal, the reporter treats
  // it as absent. Cross-process single-line appends are atomic per call
  // (appendFileSync 'a' on Windows), so concurrent writers are line-safe.
  let usageJournal = null;
  try {
    usageJournal = createUsageJournal({ dir: join(paths.root, "usage") });
  } catch {
    usageJournal = null;
  }
  const sessionTracker = createSessionReporter({
    reportUrl: "http://127.0.0.1:47821/panel/api/session/report",
    journal: usageJournal,
    agentId,
  });

  return {
    token: generateToken(),
    agentId,
    loadStore,
    loadCredential,
    buildUpstreamURLs,
    upstreamFetch: createRetryingFetch(upstreamFetch, retryOptions),
    recordGeneration: (value) => {
      generation = value;
    },
    readGeneration: () => generation,
    sessionTracker,
    // Optional logger so the per-launch Claude relay's keep-alive retries and
    // stream faults reach the panel's 实时输出 (this process owns no log file).
    logger,
    // Keep-alive (抗截断) config, read from disk on every call so panel
    // saves take effect on the next request without a restart. Low-traffic
    // single-user relay: the readFileSync cost is negligible.
    getKeepAliveConfig: getKeepAliveConfig ?? (() => loadSettings(defaultSettingsPath()).keepAlive),
  };
}

// Start the relay against the real store. Resolves with
// { port, token, close, sessionTracker }. The token goes to the client
// subprocess only, via process-level environment variables; it is
// never written to disk.
export async function startProductionRelay(options = {}) {
  const deps = createProductionDeps(options);

  // Preflight: refuse to listen at all if the store is not readable and valid.
  const probe = deps.loadStore();
  if (!probe.ok) {
    throw new Error("the ApiCred global store is not usable; refusing to start the relay");
  }

  // Bind the session reporter to this relay's token so the panel can
  // correlate reports back to the session.
  deps.sessionTracker.setToken(deps.token);

  const server = createRelayServer(deps);
  const { port, close } = await listenLoopback(server);
  return { port, token: deps.token, close, sessionTracker: deps.sessionTracker };
}
