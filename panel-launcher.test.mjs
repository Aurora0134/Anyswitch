import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideAction, waitForPanelReady, runPanelLauncher } from "./panel-launcher.mjs";

// A controllable probe stub: returns true only after `hitsBeforeReady` calls,
// then stays true. Lets a test drive waitForPanelReady through both the
// "answers immediately", "answers after a few polls", and "never answers" paths.
function makeProbe(hitsBeforeReady) {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls >= hitsBeforeReady;
  };
}

describe("decideAction", () => {
  it("returns open when the panel answers", () => {
    assert.deepEqual(decideAction(true), { kind: "open" });
  });
  it("returns spawn when the panel does not answer", () => {
    assert.deepEqual(decideAction(false), { kind: "spawn" });
  });
});

describe("waitForPanelReady", () => {
  it("resolves true as soon as probe answers", async () => {
    const sleeps = [];
    const ready = await waitForPanelReady({
      probe: makeProbe(1),
      sleep: (ms) => { sleeps.push(ms); },
      now: () => 1000,
    });
    assert.equal(ready, true);
    assert.deepEqual(sleeps, []);
  });

  it("polls until probe answers, sleeping between attempts", async () => {
    const sleeps = [];
    const ready = await waitForPanelReady({
      probe: makeProbe(3), // miss, miss, hit
      sleep: (ms) => { sleeps.push(ms); },
      intervalMs: 250,
      now: () => 1000,
    });
    assert.equal(ready, true);
    assert.deepEqual(sleeps, [250, 250]); // sleep after miss #1 and miss #2
  });

  it("resolves false when the deadline passes before probe answers", async () => {
    // now() advances 5s per call so the deadline (timeoutMs=1000) is hit on
    // the second check, before the probe (which would answer on call 999) ever
    // succeeds.
    let time = 0;
    const ready = await waitForPanelReady({
      probe: makeProbe(999),
      sleep: () => {},
      timeoutMs: 1000,
      now: () => { time += 5000; return time; },
    });
    assert.equal(ready, false);
  });
});

describe("runPanelLauncher", () => {
  it("opens the startup panel URL immediately when it is already up (no spawn)", async () => {
    const calls = [];
    const code = await runPanelLauncher({
      probe: async () => { calls.push("probe"); return true; },
      spawnPanelHost: () => { calls.push("spawnPanelHost"); },
      openBrowser: async (url) => { calls.push(["openBrowser", url]); },
      sleep: () => { calls.push("sleep"); },
      log: () => {},
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, ["probe", ["openBrowser", "http://127.0.0.1:47820/panel?startup=1"]]);
  });

  it("spawns the panel host, waits for readiness, then opens the startup panel URL", async () => {
    const calls = [];
    const code = await runPanelLauncher({
      // miss on first probe (decideAction), then hit on the readiness poll
      probe: makeProbe(2),
      spawnPanelHost: () => { calls.push("spawnPanelHost"); },
      openBrowser: async (url) => { calls.push(["openBrowser", url]); },
      sleep: () => { calls.push("sleep"); },
      log: () => {},
      intervalMs: 100,
    });
    assert.equal(code, 0);
    // probe(miss) -> spawn -> probe(hit) -> openBrowser. No sleep because the
    // second probe (the first readiness poll) already hits.
    assert.deepEqual(calls, ["spawnPanelHost", ["openBrowser", "http://127.0.0.1:47820/panel?startup=1"]]);
  });

  it("returns 1 and does not open the panel if spawnPanelHost throws", async () => {
    const calls = [];
    const code = await runPanelLauncher({
      probe: async () => false,
      spawnPanelHost: () => { calls.push("spawnPanelHost"); throw new Error("ENOENT"); },
      openBrowser: async () => { calls.push("openBrowser"); },
      sleep: () => {},
      log: () => {},
    });
    assert.equal(code, 1);
    assert.deepEqual(calls, ["spawnPanelHost"]);
  });

  it("returns 1 and does not open the panel if it never becomes ready", async () => {
    const calls = [];
    const code = await runPanelLauncher({
      probe: async () => false, // never answers
      spawnPanelHost: () => { calls.push("spawnPanelHost"); },
      openBrowser: async () => { calls.push("openBrowser"); },
      sleep: () => { calls.push("sleep"); },
      log: () => {},
      timeoutMs: 100,
      intervalMs: 30,
    });
    assert.equal(code, 1);
    assert.ok(calls.includes("spawnPanelHost"), "should have spawned the panel host");
    assert.ok(!calls.includes("openBrowser"), "must not open the panel on timeout");
  });
});
