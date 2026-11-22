import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { extractPanelFn } from "../test-helpers/extract-panel-fn.mjs";

const previousSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
globalThis.self = globalThis;
const { Terminal } = (await import("@xterm/xterm")).default;
if (previousSelf) Object.defineProperty(globalThis, "self", previousSelf);
else delete globalThis.self;
const panel = readFileSync(new URL("../panel-ui/panel.js", import.meta.url), "utf8");

function harness(t) {
  const state = { polls: [], renders: [], sources: [], terms: [] };
  const viewRecovery = extractPanelFn("switchView").match(/if \(terminal && !document\.hidden[^\n]*\{\n\s+resumeTerminalDataStream\(\);\n\s+\}/)?.[0];
  const controls = new Function("Terminal", "state", `
    const document = { hidden: false };
    const $ = () => ({ hidden: currentView !== "terminal" });
    const API_BASE = "";
    let currentView = "terminal", viewEntrySeq = 0;
    let terminalVisibilityWasHidden = false;
    let activeTerminalPreviewId = "synthetic-a", terminalBoundSessionId, terminalBoundAgentId;
    let terminalEventSource, terminalXterm, terminalInputDisposable;
    let terminalFrameRebuildSeq = 0, terminalReplayEpoch = 0;
    let terminalStreamWrite, terminalStreamSyncCancel, terminalWriteBurst = null;
    let terminalReplayRestoreArm, terminalReplayRestoring, terminalReplayFramePending = false;
    let terminalGeometryRealignPending = false, terminalGeometryReplayDrop = false;
    let terminalGeometryRealignStreak = 0, terminalGeometryRealignAt = Date.now();
    const TERMINAL_GEOMETRY_REALIGN_MAX_ATTEMPTS = 2, TERMINAL_GEOMETRY_REALIGN_COOLDOWN_MS = 1500;
    const terminalImeHold = null;
    ${panel.match(/  let terminalHiddenBacklog = null;[\s\S]*?(?=\n  function terminalHiddenBacklogInvalidate)/)[0]}
    ${panel.match(/  const TERMINAL_BURST_ENTER_BYTES = [\s\S]*?(?=\n\n  function flushTerminalBurst)/)[0]}
    ${["connectTerminalStream", "terminalSessionShouldRevive", "absorbTerminalSnapshot",
      "dropTerminalReplayFrame", "terminalHiddenBacklogInvalidate", "syncTerminalDataStream",
      "flushTerminalBurst", "discardTerminalBurst", "queueTerminalChunk",
      "resumeTerminalDataStream"].map(extractPanelFn).join("\n")}
    function ensureTerminalXterm() {
      const term = new Terminal({ cols: 20, rows: 3, scrollback: 30, allowProposedApi: true });
      state.terms.push(term);
      return (terminalXterm = term);
    }
    function closeTerminalStream() {
      ++terminalFrameRebuildSeq;
      terminalInputDisposable?.dispose();
      terminalStreamSyncCancel?.();
      discardTerminalBurst();
      terminalHiddenBacklog = null;
      terminalReplayFramePending = false;
    }
    function fitTerminalXterm() { return null; }
    function terminalHostMeasurable() { return true; }
    function scheduleTerminalGeometryRealign() {}
    function refreshStatus() {}
    function boardVisible() { return false; }
    function pollTerminalSessions() {
      return new Promise((resolve) => state.polls.push(resolve));
    }
    function renderTerminalPreviewSession(options) { state.renders.push(options); }
    class EventSource {
      readyState = 1;
      listeners = {};
      constructor() { state.sources.push(this); }
      addEventListener(name, callback) { this.listeners[name] = callback; }
      emit(name, payload) { this.listeners[name]({ data: JSON.stringify(payload) }); }
    }
    function visibility(hidden) {
      document.hidden = hidden;
      ${panel.match(/document\.addEventListener\("visibilitychange", \(\) => \{([\s\S]*?)\n  \}\);/)[1]}
    }
    return {
      connect(id = activeTerminalPreviewId) {
        activeTerminalPreviewId = id;
        return connectTerminalStream({ id, backend: true, shell: {} }, { revive: false });
      },
      visibility,
      view(name) {
        currentView = name;
        ++viewEntrySeq;
        const terminal = name === "terminal";
        ${viewRecovery ?? ""}
      },
      backlog: () => terminalHiddenBacklog,
    };
  `)(Terminal, state);
  t.after(() => state.terms.forEach((term) => term.dispose()));
  return { ...controls, ...state };
}

const geometry = { screenCols: 20, screenRows: 3 };
const replay = (text) => `\x1b[2J\x1b[H${text}`;

async function lines(term) {
  await new Promise((resolve) => term.write("", resolve));
  const buf = term.buffer.active;
  return Array.from({ length: buf.length }, (_, i) => buf.getLine(i).translateToString(true));
}

it("a late foreground poll cannot drain a rehidden terminal; recovery still caps later frames", async (t) => {
  const env = harness(t);
  await env.connect();
  const [source] = env.sources;
  source.emit("snapshot", geometry);
  source.emit("data", replay("base"));
  source.readyState = 0;
  env.visibility(true);
  source.emit("data", " first");
  env.visibility(false);
  env.visibility(true);
  env.polls[0]();
  await Promise.resolve();
  source.emit("data", " second");
  assert.ok(env.backlog(), "the second hidden interval must still buffer frames");
  assert.deepEqual(await lines(env.terms[0]), ["base", "", ""]);
  source.emit("data", "x".repeat(8 * 1024 * 1024));
  source.emit("data", "discard me");
  assert.equal(env.backlog().overflow, true);
  assert.deepEqual(env.backlog().chunks, []);
  env.visibility(false);
  env.polls[1]();
  await Promise.resolve();
  assert.deepEqual(env.renders, [{ revive: false, force: true }]);
});

it("only the latest foreground poll can recover on the same stream", async (t) => {
  const env = harness(t);
  await env.connect();
  const [source] = env.sources;
  source.readyState = 0;
  env.visibility(true);
  source.emit("data", "first");
  env.visibility(false);
  env.visibility(true);
  source.emit("data", "second");
  env.visibility(false);
  env.polls[0]();
  await Promise.resolve();
  assert.deepEqual(env.renders, []);
  env.polls[1]();
  await Promise.resolve();
  assert.deepEqual(await lines(env.terms[0]), ["firstsecond", "", ""]);
});

it("a late foreground poll cannot render after the terminal stream changes", async (t) => {
  const env = harness(t);
  await env.connect();
  env.sources[0].readyState = 0;
  env.visibility(true);
  env.visibility(false);
  await env.connect("synthetic-b");
  env.polls[0]();
  await Promise.resolve();
  assert.deepEqual(env.renders, []);
});

it("a foreground poll from before a view switch cannot drain the terminal on return", async (t) => {
  const env = harness(t);
  await env.connect();
  env.sources[0].readyState = 0;
  env.visibility(true);
  env.sources[0].emit("data", "buffered");
  env.visibility(false);
  env.view("board");
  env.view("terminal");
  env.polls[0]();
  await Promise.resolve();
  assert.deepEqual(env.renders, []);
  assert.deepEqual(env.backlog().chunks, ["buffered"]);
  env.polls[1]();
  await Promise.resolve();
  assert.deepEqual(await lines(env.terms[0]), ["buffered", "", ""]);
});

it("a hidden reconnect replaces old backlog and xterm writes before replaying new data in order", async (t) => {
  const env = harness(t);
  await env.connect();
  const [source] = env.sources;
  const [term] = env.terms;
  source.emit("snapshot", geometry);
  source.emit("data", replay("initial"));
  // Keep the old visible write in xterm's own queue while the next snapshot arrives.
  source.emit("data", "\r\nQUEUED".repeat(6));
  env.visibility(true);
  source.emit("data", "\r\nHIDDEN".repeat(6));
  source.emit("snapshot", geometry);
  source.emit("data", replay("fresh"));
  source.emit("data", " + delta");
  source.readyState = 0;
  env.visibility(false);
  env.polls[0]();
  await Promise.resolve();
  source.emit("data", " + live");
  const buffer = await lines(term);
  assert.deepEqual(buffer.slice(-3), ["fresh + delta + live", "", ""], "replay and both deltas stay in order on screen");
  assert.deepEqual(buffer, ["fresh + delta + live", "", ""], "the same output must have no old lines in scrollback");
});

it("a valid snapshot arriving during the foreground poll supersedes an overflowed backlog", async (t) => {
  const env = harness(t);
  await env.connect();
  const [source] = env.sources;
  source.emit("snapshot", geometry);
  source.emit("data", replay("old"));
  source.readyState = 0;
  env.visibility(true);
  source.emit("data", "x".repeat(8 * 1024 * 1024 + 1));
  env.visibility(false);
  source.emit("snapshot", geometry);
  source.emit("data", replay("new"));
  source.emit("data", " + delta");
  env.polls[0]();
  await Promise.resolve();
  assert.deepEqual(env.renders, [], "the new baseline does not need the old poll's forced rebuild");
  assert.deepEqual(await lines(env.terms[0]), ["new + delta", "", ""]);
});

it("an incompatible snapshot still discards replay and deltas and forces a rebuild on return", async (t) => {
  const env = harness(t);
  await env.connect();
  const [source] = env.sources;
  source.emit("snapshot", geometry);
  source.emit("data", replay("initial"));
  await lines(env.terms[0]);
  env.visibility(true);
  source.emit("snapshot", geometry);
  source.emit("data", replay("queued"));
  source.emit("snapshot", { ...geometry, screenCols: 30 });
  source.emit("data", replay("bad width"));
  source.emit("data", " + bad delta");
  env.visibility(false);
  env.polls[0]();
  await Promise.resolve();
  assert.deepEqual(env.renders, [{ revive: false, force: true }]);
  assert.deepEqual(await lines(env.terms[0]), ["", "", ""]);
});
