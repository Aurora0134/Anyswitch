// Process-local logger with a ring buffer and pub/sub.
//
// The relay historically wrote single lines to process.stderr. A control panel
// needs to *subscribe* to that stream over SSE, so this module turns the
// fire-and-forget writes into a bus: every log() also fans out to live
// subscribers (the SSE endpoint) while keeping a bounded history (ring buffer)
// for late joiners to replay.
//
// No external state, no filesystem writes here — the host (relay-host.mjs) owns
// stderr redirection to a log file. This module only shapes the in-memory stream.
//
// Two contracts this module holds, both learned the hard way:
//
//   * A persisted line carries a wall-clock stamp. The on-disk log gets read
//     next to a user's report of when something broke, and a line with no time
//     on it cannot be lined up against that report at all.
//   * The level lives in exactly ONE place — the entry's `level` field. The
//     message text is bare prose. An earlier shape kept the level in both, which
//     is how a line reading `[info] ... WARN ...` became possible: the field and
//     the text could disagree, and consumers had to parse the text to recover a
//     level they already had.

const DEFAULT_CAPACITY = 500;

// The level vocabulary this bus knows, ranked so "at least WARN" can be answered
// honestly. Never compare level strings: alphabetically that orders error < info
// < warn, which would rank the noisiest level as the most urgent.
export const LOG_LEVEL_ORDER = { info: 10, warn: 20, error: 30 };

// Whether an entry clears a minimum-level filter used by a viewer (the panel's
// 实时输出). Both unknowns pass: an entry whose level is not in the table must not
// vanish from the panel because of someone else's display preference, and an
// unrecognised filter value means "no filter", not "filter everything out".
// This is a read-side predicate only — it never gates what is buffered or written.
export function logLevelAllows(entryLevel, minLevel) {
  const floor = LOG_LEVEL_ORDER[minLevel];
  if (floor === undefined) return true;
  const at = LOG_LEVEL_ORDER[entryLevel];
  if (at === undefined) return true;
  return at >= floor;
}

// Local wall-clock, deliberately not UTC: the file is read beside a user's
// "it broke around 3pm", and a UTC stamp would silently disagree with that.
export function formatLogStamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function createLogger(options = {}) {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const sink = options.sink ?? ((line) => process.stderr.write(line));
  const now = options.now ?? Date.now;
  // Live on/off gate, re-evaluated on every write so a settings toggle takes
  // effect without restarting the process. Absent → always on.
  const isEnabled = options.isEnabled ?? (() => true);
  // Fixed-size ring buffer: O(1) per write. `head` is the next write index;
  // `size` tracks occupancy until the buffer first fills. getHistory walks the
  // ring in insertion order regardless of wrap.
  const ring = new Array(capacity);
  let head = 0;
  let size = 0;
  const subscribers = new Set();

  function format(level, message, ts) {
    // Single-line, stamped, level-prefixed, newline-terminated. The stamp and
    // the level tag exist for the FILE (greppable, time-ordered); the in-memory
    // entry keeps them as separate fields instead — see the header.
    const text = typeof message === "string" ? message : String(message);
    return `[${formatLogStamp(ts)}] [${level}] ${text}\n`;
  }

  function log(level, message) {
    if (!isEnabled()) return;
    const ts = now();
    sink(format(level, message, ts));
    const entry = { ts, level, message: typeof message === "string" ? message : String(message) };
    ring[head] = entry;
    head = (head + 1) % capacity;
    if (size < capacity) size++;
    // Fan out to live SSE subscribers. A throwing/closed subscriber is dropped
    // silently rather than poisoning the relay's log path.
    for (const fn of subscribers) {
      try {
        fn(entry);
      } catch {
        subscribers.delete(fn);
      }
    }
  }

  // Reset the ring and notify subscribers with a control frame. A "clear" is
  // not a log line: subscribers forward the frame to viewers so every open
  // panel window empties together, and an SSE reconnect does not replay lines
  // the user has already cleared. The frame itself never enters the history.
  // Deliberately NOT gated: emptying the buffer is a control operation, and a
  // viewer that clears while recording is off must not keep stale rows.
  function clear() {
    ring.fill(undefined);
    head = 0;
    size = 0;
    const entry = { ts: now(), type: "clear" };
    for (const fn of subscribers) {
      try {
        fn(entry);
      } catch {
        subscribers.delete(fn);
      }
    }
  }

  return {
    info: (m) => log("info", m),
    warn: (m) => log("warn", m),
    error: (m) => log("error", m),
    log,
    clear,
    // Whether a write would currently land. Callers whose only reason to do
    // work is producing a log line can ask first.
    isEnabled,
    // Subscribe to live entries. Returns an unsubscribe function. The SSE
    // endpoint calls this; on disconnect it calls the returned fn to stop
    // pushing into a dead response.
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    // Bounded history for late-joiner replay (e.g. an SSE client reconnecting).
    // Walks the ring in insertion order, oldest first.
    getHistory() {
      const out = [];
      const start = size < capacity ? 0 : head;
      for (let i = 0; i < size; i++) {
        out.push(ring[(start + i) % capacity]);
      }
      return out;
    },
  };
}
