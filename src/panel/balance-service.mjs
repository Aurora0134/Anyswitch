// Upstream balance poller for the panel.
//
// For each managed provider with a readable credential, GET
// <baseURL>/dashboard/billing/credit_grants and cache the result. The panel
// reads the cache only — every upstream call happens here, on a fixed
// interval, so the page never waits on an external request and upstream rate
// limits see at most one request per provider per interval.
//
// Currency resolution per provider: manual override (provider.balanceCurrency
// in the store) wins; otherwise a currency hint in the upstream response is
// honoured when present; otherwise USD is assumed — the upstreams this
// feature targets speak OpenAI-style billing, which is USD-denominated.
//
// A provider whose upstream does not expose the endpoint (HTTP 404, or a 200
// payload without a numeric total_available) is marked "unsupported" and is
// retried only occasionally — most 404s are permanent, and probing them every
// minute would be pure noise. Transient failures (network, 5xx, timeout) keep
// the previous good value and are retried every interval.
//
// All IO is injectable so tests can run with a fake fetch/store/dpapi against
// a virtual interval scheduler.

const FETCH_TIMEOUT_MS = 15000;
const DEFAULT_INTERVAL_MS = 60000;
const UNSUPPORTED_RETRY_EVERY = 60;

export const CURRENCIES = Object.freeze(["usd", "cny"]);

function detectCurrency(payload) {
  const raw = payload?.currency ?? payload?.unit;
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "usd" || v === "$" || v === "dollar" || v === "dollars") return "usd";
  if (v === "cny" || v === "rmb" || v === "¥" || v === "￥" || v === "yuan") return "cny";
  return null;
}

function creditsURL(baseURL) {
  const trimmed = String(baseURL).replace(/\/+$/, "");
  return `${trimmed}/dashboard/billing/credit_grants`;
}

export function createBalanceService({
  loadStore,
  readCiphertext,
  unprotect,
  fetchImpl = fetch,
  now = () => Date.now(),
  intervalMs = DEFAULT_INTERVAL_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  unsupportedRetryEvery = UNSUPPORTED_RETRY_EVERY,
  enabledFn = () => true,
} = {}) {
  // providerId -> { status, available?, currency?, fetchedAt, attempts? }
  const cache = new Map();
  let timer = null;
  let roundInFlight = false;

  function manualOverride(entry) {
    const raw = entry?.balanceCurrency;
    return typeof raw === "string" && CURRENCIES.includes(raw) ? raw : null;
  }

  async function fetchOne(id, entry) {
    const fetchedAt = now();
    const previous = cache.get(id);
    const markTransient = () => {
      cache.set(id, previous && previous.status === "ok"
        ? { ...previous, fetchedAt, stale: true }
        : { status: "error", fetchedAt });
    };
    const read = readCiphertext(entry.credentialFile ?? `${id}.dpapi`);
    if (!read.ok) {
      cache.set(id, { status: "error", fetchedAt });
      return;
    }
    const ciphertext = read.ciphertext;
    let plaintext;
    try {
      plaintext = await unprotect(ciphertext, id);
    } catch {
      cache.set(id, { status: "error", fetchedAt });
      return;
    } finally {
      ciphertext?.fill?.(0);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await fetchImpl(creditsURL(entry.baseURL), {
          headers: { Authorization: `Bearer ${plaintext.toString("utf8")}` },
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        markTransient();
        return;
      } finally {
        plaintext.fill?.(0);
      }
      if (response.status === 404) {
        await response.body?.cancel();
        cache.set(id, { status: "unsupported", fetchedAt, attempts: 0 });
        return;
      }
      if (!response.ok) {
        await response.body?.cancel();
        markTransient();
        return;
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        cache.set(id, { status: "unsupported", fetchedAt, attempts: 0 });
        return;
      }
      const available = payload?.total_available;
      if (typeof available !== "number" || !Number.isFinite(available)) {
        cache.set(id, { status: "unsupported", fetchedAt, attempts: 0 });
        return;
      }
      const currency = manualOverride(entry) ?? detectCurrency(payload) ?? "usd";
      cache.set(id, { status: "ok", available, currency, fetchedAt });
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshRound() {
    if (roundInFlight) return;
    if (!enabledFn()) return;
    roundInFlight = true;
    try {
      const loaded = loadStore();
      if (!loaded.ok) return;
      const providers = loaded.store.providers ?? {};
      for (const [id, entry] of Object.entries(providers)) {
        if (!entry || typeof entry.baseURL !== "string" || !entry.baseURL) continue;
        const cached = cache.get(id);
        if (cached?.status === "unsupported") {
          cached.attempts = (cached.attempts ?? 0) + 1;
          if (cached.attempts < unsupportedRetryEvery) continue;
          cached.attempts = 0;
        }
        await fetchOne(id, entry);
      }
      for (const id of cache.keys()) {
        if (!Object.hasOwn(providers, id)) cache.delete(id);
      }
    } catch {
      // A round must never take the poller down; next interval retries.
    } finally {
      roundInFlight = false;
    }
  }

  return {
    refreshRound,
    start() {
      if (timer) return;
      void refreshRound();
      timer = setIntervalImpl(() => void refreshRound(), intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) clearIntervalImpl(timer);
      timer = null;
    },
    snapshot() {
      const out = {};
      for (const [id, entry] of cache) {
        if (entry.status !== "ok") continue;
        out[id] = {
          available: entry.available,
          currency: entry.currency,
          fetchedAt: entry.fetchedAt,
        };
      }
      return out;
    },
  };
}
