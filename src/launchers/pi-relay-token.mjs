import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, unlinkSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_FILENAME = "pi-relay-token";
const CHAIN_FILENAME = "pi-relay-token-chain.json";
const USAGE_FILENAME = "pi-relay-token-usage.json";

export function getTokenPath(root) {
  return join(root, TOKEN_FILENAME);
}

export function getChainPath(root) {
  return join(root, CHAIN_FILENAME);
}

export function getUsagePath(root) {
  return join(root, USAGE_FILENAME);
}

export function loadOrGenerateToken(root) {
  const path = getTokenPath(root);
  if (existsSync(path)) {
    return readFileSync(path, "utf8").trim();
  }
  const token = randomBytes(32).toString("hex");
  // First boot on an empty data root: the root directory may not exist yet,
  // so create it before writing (otherwise the relay dies on ENOENT before
  // its friendly preflight can run).
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, "utf8");
  return token;
}

// ---- Automatic rotation ------------------------------------------------------
//
// The token used to be an install-time constant: create-if-missing was the
// only write path, the relay compared strictly against its boot-time copy, and
// every endpoint config embedded the value in plaintext — so a leak had no
// remedy, because rotating by hand broke every running session (the relay
// kept validating the old value while new launches picked up the new one).
//
// This block adds the missing lifecycle (2026-11-07 design, see the STATUS
// entry in the bridge repo for the three-face root cause):
//
//   * rotateRelayToken() replaces the current generation and records the
//     previous one in a chain file, so sessions born before the rotation keep
//     working.
//   * createRelayTokenValidator() accepts the current generation plus any
//     chained generation whose last use is within RELAY_TOKEN_IDLE_TTL_MS.
//     Every request refreshes ("touches") its generation's clock, so an
//     actively used session survives any number of rotations; only a session
//     idle longer than the TTL finds its generation retired and must be
//     restarted (conversation identity survives via the existing resume
//     paths, which re-read the current token).
//   * checkAndRotateRelayToken() drives the schedule from the resident
//     relay's daily tick; the caller owns the post-rotation agent-config
//     resync that propagates the new generation to every endpoint.
//
// The TTL also bounds how long a leaked copy of an old generation stays
// usable: it dies 24h after the last legitimate request on that generation.
//
// File layout under the data root:
//   pi-relay-token              current generation (unchanged name: every
//                              launcher / revive / sync path reads it at use)
//   pi-relay-token-chain.json  rotation history, newest first, capped
//   pi-relay-token-usage.json  per-generation last-used map. Advisory
//                              state written by every process that runs a
//                              validator (resident relay, terminal host):
//                              each throttles its own writes and last
//                              writer wins, so a dropped touch only
//                              shortens that generation's grace window.

// Weekly cadence, checked daily (plus once shortly after boot so an install
// that was offline catches up immediately).
export const RELAY_TOKEN_ROTATE_INTERVAL_MS = 7 * 24 * 3600_000;
// A generation with no request for a day is retired: covers terminals left
// open overnight, retires abandoned sessions' credentials, and is the upper
// bound on a leaked old-generation copy's useful life.
export const RELAY_TOKEN_IDLE_TTL_MS = 24 * 3600_000;
// History cap: at the weekly cadence this covers two months of generations,
// far beyond any plausible live session, while keeping the chain file small.
export const RELAY_TOKEN_CHAIN_CAP = 8;
// Usage-map persistence cadence (the map is advisory state: losing the last
// few minutes only shortens a generation's remaining grace by the same amount).
const USAGE_PERSIST_INTERVAL_MS = 60_000;

// Constant-time comparison, the discipline the relay's token gates have
// always used: length mismatch is reported without short-circuiting on
// content, and both temporary copies are zeroed on every path.
function tokenEquals(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  try {
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } finally {
    a.fill(0);
    b.fill(0);
  }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, value, "utf8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

// Windows merges the mtimes of back-to-back writes into the same clock tick,
// and the token file's size never changes (always the same 64-char hex
// string), so the stat key the validator caches can come out identical
// before and after a rotation — and the rotation would then be missed
// forever. Restamp each rotation's files with a strictly increasing mtime,
// derived from what the write actually produced, so the new key is
// guaranteed to differ from the old one.
let lastRotationStamp = 0;
function stampRotationWrite(path) {
  try {
    const produced = Math.ceil(statSync(path).mtimeMs);
    lastRotationStamp = Math.max(Date.now(), produced + 1, lastRotationStamp + 1);
    const stamp = new Date(lastRotationStamp);
    utimesSync(path, stamp, stamp);
  } catch {
    /* best-effort: keep the natural mtime */
  }
}

function loadTokenChain(root) {
  try {
    const parsed = JSON.parse(readFileSync(getChainPath(root), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((g) => typeof g?.token === "string") : [];
  } catch {
    return [];
  }
}

export function rotateRelayToken(root, { now = Date.now } = {}) {
  const previous = loadOrGenerateToken(root);
  const next = randomBytes(32).toString("hex");
  writeFileSync(getTokenPath(root), next, "utf8");
  stampRotationWrite(getTokenPath(root));
  const rotatedAt = now();
  const chain = loadTokenChain(root);
  const previousEntry = chain.find((g) => g.token === previous);
  // Seed the chain with the pre-rotation generation so the very first
  // rotation on a legacy install (which never had a chain file) is just as
  // seamless as every later one.
  const updated = [
    { token: next, createdAt: rotatedAt },
    { token: previous, createdAt: previousEntry?.createdAt ?? rotatedAt },
    ...chain.filter((g) => g.token !== previous && g.token !== next),
  ].slice(0, RELAY_TOKEN_CHAIN_CAP);
  try {
    writeJsonAtomic(getChainPath(root), JSON.stringify(updated));
    stampRotationWrite(getChainPath(root));
  } catch {
    /* a failed chain write must not undo the rotation itself; the previous
       generation simply loses its grace window, which is the pre-rotation
       behavior and never worse than status quo */
  }
  return { token: next, previous, rotatedAt };
}

// Age of the current generation: the chain head's createdAt once rotations
// are running, the token file's mtime for legacy installs (mtime is the
// generation's birth moment — nothing but rotation rewrites this file).
export function currentGenerationAgeMs(root, { now = Date.now } = {}) {
  const chain = loadTokenChain(root);
  if (typeof chain[0]?.createdAt === "number") return Math.max(0, now() - chain[0].createdAt);
  try {
    return Math.max(0, now() - statSync(getTokenPath(root)).mtimeMs);
  } catch {
    return 0; // no token on disk yet — nothing to rotate
  }
}

export function checkAndRotateRelayToken(root, { now = Date.now, intervalMs = RELAY_TOKEN_ROTATE_INTERVAL_MS } = {}) {
  if (currentGenerationAgeMs(root, { now }) < intervalMs) return null;
  return rotateRelayToken(root, { now });
}

export function createRelayTokenValidator(root, {
  now = Date.now,
  idleTtlMs = RELAY_TOKEN_IDLE_TTL_MS,
  persistIntervalMs = USAGE_PERSIST_INTERVAL_MS,
} = {}) {
  let current = null;
  let chain = [];
  let usage = new Map();
  const fileKeys = new Map(); // path -> stat key of the last load
  let persistTimer = null;

  // Reload any file whose stat key changed. The validator is created once
  // per process and lives across rotations: this is how a running relay
  // adopts a rotated generation without a restart.
  function reload(path, apply) {
    let key;
    try {
      const st = statSync(path);
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      key = "missing";
    }
    if (fileKeys.get(path) === key) return;
    fileKeys.set(path, key);
    let raw = null;
    if (key !== "missing") {
      try { raw = readFileSync(path, "utf8"); } catch { raw = null; }
    }
    apply(raw);
  }

  function refresh() {
    reload(getTokenPath(root), (raw) => { current = raw ? raw.trim() : null; });
    reload(getChainPath(root), (raw) => {
      try {
        const parsed = raw ? JSON.parse(raw) : [];
        chain = Array.isArray(parsed) ? parsed.filter((g) => typeof g?.token === "string") : [];
      } catch {
        chain = [];
      }
    });
    reload(getUsagePath(root), (raw) => {
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        usage = new Map(Object.entries(parsed).filter(([k, v]) => typeof k === "string" && typeof v === "number"));
      } catch {
        usage = new Map();
      }
    });
  }

  function persist() {
    persistTimer = null;
    const alive = new Set([current, ...chain.map((g) => g.token)]);
    const cutoff = now() - idleTtlMs;
    const next = {};
    for (const [token, last] of usage) {
      if (!alive.has(token) || last < cutoff) continue;
      next[token] = last;
    }
    try { writeJsonAtomic(getUsagePath(root), JSON.stringify(next)); } catch { /* advisory state, best-effort */ }
  }

  function touch(token) {
    usage.set(token, now());
    if (persistTimer === null) {
      persistTimer = setTimeout(persist, persistIntervalMs);
      persistTimer.unref?.();
    }
  }

  function isValid(presented) {
    if (typeof presented !== "string" || presented.length === 0) return false;
    refresh();
    if (current !== null && tokenEquals(presented, current)) {
      touch(current);
      return true;
    }
    for (const gen of chain) {
      if (gen.token === current) continue; // already compared
      if (!tokenEquals(presented, gen.token)) continue;
      const lastUsedAt = usage.get(gen.token) ?? gen.createdAt ?? 0;
      if (now() - lastUsedAt > idleTtlMs) return false; // idle beyond TTL: retired
      touch(gen.token);
      return true;
    }
    return false;
  }

  return {
    isValid,
    // The current generation, for callers that mint outbound requests and
    // must never send a value the relay cached at boot.
    getCurrent() {
      refresh();
      return current;
    },
    // Force the throttled usage write now (tests, shutdown paths).
    flush() {
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      persist();
    },
  };
}

// Single seam for every inbound token check in the relay surface. Prefers
// the rotation-aware validator; falls back to the strict constant-time
// comparison against deps.token so per-launch relays and tests that pass a
// bare {token} keep their exact pre-rotation behavior.
export function relayTokenAccepted(deps, presented) {
  const validator = deps?.tokenValidator;
  if (validator && typeof validator.isValid === "function") return validator.isValid(presented);
  return typeof deps?.token === "string" && tokenEquals(presented, deps.token);
}
