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

const DEFAULT_CAPACITY = 500;

export function createLogger(options = {}) {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const sink = options.sink ?? ((line) => process.stderr.write(line));
  // Fixed-size ring buffer: O(1) per write. `head` is the next write index;
  // `size` tracks occupancy until the buffer first fills. getHistory walks the
  // ring in insertion order regardless of wrap.
  const ring = new Array(capacity);
  let head = 0;
  let size = 0;
  const subscribers = new Set();

  function format(level, message) {
    // Single-line, level-prefixed, newline-terminated — matches the existing
    // stderr convention so log files stay greppable.
    const text = typeof message === "string" ? message : String(message);
    return `[${level}] ${text}\n`;
  }

  function log(level, message) {
    const line = format(level, message);
    sink(line);
    const entry = { ts: Date.now(), level, message: line.replace(/\n$/, "") };
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
  // panel window empties together, and SSE reconnects no longer replay what
  // the user just cleared. The frame itself never enters the history.
  function clear() {
    ring.fill(undefined);
    head = 0;
    size = 0;
    const entry = { ts: Date.now(), type: "clear" };
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
