// Shared loopback listener fixture for tests that fetch their own server.
//
// Node's built-in fetch (undici) refuses to open a connection to a WHATWG
// fetch "bad port" (TypeError: fetch failed, cause "bad port") before any TCP
// traffic happens. A server bound with listen(0) can land on one of the ports
// below — on this project's Windows target the dynamic range 1024-15000 holds
// 18 of them (~0.13% per bind) — and the test then fails with a transport
// error unrelated to the behavior under test. Bind through listenLoopback
// instead: a hit is closed and rebound, bounded by maxAttempts, and every
// intermediate listener is closed before the next attempt.
//
// The table is the WHATWG fetch "bad port" list as Node actually implements
// it. Do not swap in Chromium's net/base/port_util.cc list — it differs (it
// has 49/81/88, lacks 77/87/95/101-104/4190/6679). The exhaustive live-fetch
// sweep over 1..10080 in tests/loopback-helper.test.mjs pins this table to
// the running runtime; that test is the authority when Node updates undici.
export const FETCH_BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25,
  37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139,
  143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526,
  530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636,
  989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export function isFetchBadPort(port) {
  return FETCH_BAD_PORTS.has(Number(port));
}

// Default bind used by listenLoopback, exported so tests can compose seams
// that really bind (and therefore really close) a listener per attempt.
// Bind errors — EACCES, a server already listening, misuse — reject here and
// propagate through listenLoopback untouched.
export function bindOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { cleanup(); reject(err); };
    const onListening = () => { cleanup(); resolve(server.address().port); };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

// Resolves once the server is no longer accepting; an already-closed server
// resolves too, so retry paths and teardown can both call it unconditionally.
export function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

const DEFAULT_MAX_ATTEMPTS = 32;

// Minimal adapter over `server.listen(0, "127.0.0.1")` and the production
// `listenLoopback(server, 0)` shape: same { port, close } return, but the
// bound port is guaranteed usable by fetch. Ephemeral only — anything else
// is a misuse (tests must never bind the production relay port).
//
// opts.bind replaces the default binder for tests that need to force the
// blocked-port path; it receives (server, 0, host) and resolves with the
// port the caller should believe was bound. Everything it throws is a
// product error and is never retried or swallowed here.
export async function listenLoopback(server, port = 0, opts = {}) {
  if (port !== 0) {
    throw new TypeError("test-helpers/loopback binds ephemeral ports only: listenLoopback(server, 0)");
  }
  const { host = "127.0.0.1", maxAttempts = DEFAULT_MAX_ATTEMPTS, bind = bindOnce } = opts;
  let lastBadPort = null;
  for (let attempts = 1; ; attempts += 1) {
    const assigned = await bind(server, 0, host);
    if (!isFetchBadPort(assigned)) {
      return { port: assigned, close: () => closeServer(server) };
    }
    lastBadPort = assigned;
    await closeServer(server);
    if (attempts >= maxAttempts) {
      const err = new Error(
        `no fetch-usable loopback port after ${maxAttempts} ephemeral binds (last hit: bad port ${lastBadPort})`,
      );
      err.attempts = maxAttempts;
      err.lastPort = lastBadPort;
      throw err;
    }
  }
}
