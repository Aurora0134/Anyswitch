// Qoder model-catalog warm-up via the Chrome DevTools Protocol.
//
// Qoder 0.2.x has a cold-start race: the workbench composer reads the model
// catalog with the "cache" strategy the moment the daemon core commits, before
// the platform models have finished loading, so the picker renders with an
// empty model list and the model button stays disabled until something forces
// a reload. The store exposes `refreshByokModelCatalogs()`, which re-runs the
// load and repopulates the picker.
//
// This module attaches to a running Qoder over CDP (the launcher spawns Qoder
// with --remote-debugging-port) and invokes that refresh once the workbench
// renderer is up. It is best-effort: any failure (CDP disabled, renderer not
// ready, bridge shape changed) is logged and swallowed so it never blocks or
// crashes the launch.

import http from "node:http";

const DEFAULT_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 500;

function httpGetJson(port, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`CDP returned non-JSON: ${error.message}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("CDP request timed out"));
    });
  });
}

// Find the workbench renderer page target.
async function findWorkbenchTarget(port, timeoutMs) {
  const targets = await httpGetJson(port, "/json", timeoutMs);
  return targets.find((t) => t.type === "page" && typeof t.url === "string" && t.url.includes("workbench"));
}

// The expression evaluated in the renderer: locate the model-catalog store on
// the React fiber tree and call refreshByokModelCatalogs(). Returns true when
// the store was found and the refresh awaited.
const REFRESH_EXPRESSION = `(async () => {
  const container = document.getElementById('root');
  if (!container) return 'no-root';
  const key = Object.keys(container).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
  if (!key) return 'no-root-fiber';
  const seen = new Set();
  const queue = [container[key]];
  let steps = 0;
  let store = null;
  while (queue.length && steps < 60000 && !store) {
    const node = queue.shift(); steps++;
    if (!node || seen.has(node)) continue; seen.add(node);
    let h = node.memoizedState; let hi = 0;
    const bags = [];
    while (h && hi < 50) { bags.push(h.memoizedState, h.queue, h.baseState); h = h.next; hi++; }
    bags.push(node.memoizedProps, node.memoizedState);
    for (const bag of bags) {
      if (!bag || typeof bag !== 'object') continue;
      if (typeof bag.refreshByokModelCatalogs === 'function' && bag.modelObs) { store = bag; break; }
      for (const k of Object.keys(bag)) {
        const v = bag[k];
        if (v && typeof v === 'object' && typeof v.refreshByokModelCatalogs === 'function' && v.modelObs) { store = v; break; }
      }
      if (store) break;
    }
    if (node.child) queue.push(node.child);
    if (node.sibling) queue.push(node.sibling);
  }
  if (!store) return 'store-not-found';
  await store.refreshByokModelCatalogs();
  return 'refreshed';
})()`;

function evaluateOnTarget(wsUrl, expression, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("CDP evaluate timed out")), timeoutMs);
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      finish(error);
      return;
    }
    let nextId = 0;
    const pending = new Map();

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* ignore */ }
      if (error) reject(error); else resolve(value);
    }

    ws.onopen = () => {
      const id = ++nextId;
      pending.set(id, (msg) => {
        if (msg.error) finish(new Error(msg.error.message || "CDP evaluate error"));
        else finish(null, msg.result?.result?.value);
      });
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs } }));
    };
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    ws.onerror = () => finish(new Error("CDP websocket error"));
  });
}

// Attach to a running Qoder on the given CDP port and trigger one model-catalog
// refresh. Polls until the workbench renderer appears or the deadline passes.
// Returns 'refreshed' | 'store-not-found' | 'no-renderer' | 'timeout'.
export async function refreshQoderModelCatalog({
  port,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = () => {},
} = {}) {
  if (!Number.isInteger(port) || port <= 0) return "no-port";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let target = null;
    try {
      target = await findWorkbenchTarget(port, 2000);
    } catch {
      target = null;
    }
    if (target?.webSocketDebuggerUrl) {
      try {
        const result = await evaluateOnTarget(target.webSocketDebuggerUrl, REFRESH_EXPRESSION, 8000);
        log(`qoder model catalog refresh: ${result}`);
        return result === "refreshed" ? "refreshed" : result;
      } catch (error) {
        log(`qoder model catalog refresh evaluate failed: ${error.message}`);
        return "evaluate-failed";
      }
    }
    if (Date.now() >= deadline) return "timeout";
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// Pick a CDP port that is unlikely to collide. Fixed port keeps the launcher
// deterministic; Qoder ignores the flag if the port is taken (Chromium falls
// back to an ephemeral port), in which case the refresh simply times out.
export const QODER_CDP_PORT = 9223;
