import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runPanelHostRestartHelper,
  spawnPanelHostRestartHelper,
} from "./panel-host-restart-helper.mjs";

// Deterministic clock: every probe() tick advances by a fixed step, so the
// helper's release/ready deadlines are reached without real waiting.
function fakeClock(stepMs = 100) {
  let t = 0;
  return {
    now: () => t,
    advance: () => { t += stepMs; },
    sleep: async () => { /* instant, but yields a microtask like the real one */ },
  };
}

// probe() driven by a scripted answer sequence (true = 47820 answering).
function scriptedProbe(answers, clock) {
  let i = 0;
  return async () => {
    clock.advance();
    const at = Math.min(i, answers.length - 1);
    i += 1;
    return answers[at];
  };
}

describe("panel-host restart helper orchestration", () => {
  it("waits for the old host to release 47820, then spawns and confirms the replacement", async () => {
    const clock = fakeClock();
    const order = [];
    const logs = [];
    // answering, answering (old host still alive), gone, gone (spawn happens),
    // then the new host answers.
    const probe = scriptedProbe([true, true, false, false, true], clock);
    const code = await runPanelHostRestartHelper({
      probe,
      spawnPanelHost: () => order.push("spawn"),
      sleep: clock.sleep,
      log: (line) => logs.push(line),
      now: clock.now,
    });
    assert.equal(code, 0);
    assert.deepEqual(order, ["spawn"]);
    assert.match(logs.join("\n"), /released the port; spawning/);
    assert.match(logs.join("\n"), /back up/);
  });

  it("never spawns while the port is still held, and gives up as failure", async () => {
    const clock = fakeClock();
    const logs = [];
    let spawns = 0;
    // The dying host never lets go: every probe says "someone is answering".
    const probe = scriptedProbe([true], clock);
    const code = await runPanelHostRestartHelper({
      probe,
      spawnPanelHost: () => { spawns += 1; },
      sleep: clock.sleep,
      log: (line) => logs.push(line),
      now: clock.now,
      releaseTimeoutMs: 1_000,
    });
    assert.equal(code, 1);
    assert.equal(spawns, 0, "spawning against a held port only produces an instance that exits");
    assert.match(logs.join("\n"), /still held after 1000ms; not spawning/);
  });

  it("reports failure when the replacement never answers", async () => {
    const clock = fakeClock();
    const logs = [];
    // released immediately, and nobody ever comes back up.
    const probe = scriptedProbe([false], clock);
    const code = await runPanelHostRestartHelper({
      probe,
      spawnPanelHost: () => {},
      sleep: clock.sleep,
      log: (line) => logs.push(line),
      now: clock.now,
      readyTimeoutMs: 2_000,
    });
    assert.equal(code, 1);
    assert.match(logs.join("\n"), /did not become ready within 2000ms/);
  });

  it("surfaces a spawn error instead of exiting 0", async () => {
    const clock = fakeClock();
    const logs = [];
    const probe = scriptedProbe([false], clock);
    const code = await runPanelHostRestartHelper({
      probe,
      spawnPanelHost: () => { throw new Error("node.exe vanished"); },
      sleep: clock.sleep,
      log: (line) => logs.push(line),
      now: clock.now,
    });
    assert.equal(code, 1);
    assert.match(logs.join("\n"), /failed to spawn panel-host: node\.exe vanished/);
  });
});

describe("spawnPanelHostRestartHelper (the call the dying host makes)", () => {
  function fakeChild() {
    const events = [];
    return {
      events,
      unrefCalls: 0,
      on(event, fn) { events.push([event, typeof fn]); return this; },
      unref() { this.unrefCalls += 1; },
    };
  }

  it("detaches the helper, points stderr at the restart log, and unrefs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anyswitch-restart-spawn-"));
    try {
      const logPath = join(dir, "panel-host-restart.log");
      const calls = [];
      const child = fakeChild();
      const result = spawnPanelHostRestartHelper({
        spawnFn: (exec, args, opts) => { calls.push({ exec, args, opts }); return child; },
        execPath: "C:/node/node.exe",
        scriptPath: "C:/app/panel-host-restart-helper.mjs",
        logPath,
      });
      assert.equal(result, child);
      assert.equal(calls.length, 1);
      const { exec, args, opts } = calls[0];
      assert.equal(exec, "C:/node/node.exe");
      assert.deepEqual(args, ["C:/app/panel-host-restart-helper.mjs"]);
      // Detached + hidden + no shell: the helper must outlive the panel host
      // that is about to exit, exactly like the launcher's panel-host spawn.
      assert.equal(opts.detached, true);
      assert.equal(opts.windowsHide, true);
      assert.equal(opts.shell, false);
      assert.deepEqual(opts.stdio.slice(0, 2), ["ignore", "ignore"], "no console/stdin for a background one-shot");
      assert.equal(typeof opts.stdio[2], "number", "stderr is a real fd so the trail lands in the log file");
      // The parent must not keep its own copy of the handle after spawning.
      assert.throws(() => writeSync(opts.stdio[2], "x"), "the inherited-by-child fd must be closed in the spawner");
      assert.deepEqual(child.events.map((e) => e[0]), ["error"], "an unhandled spawn 'error' would crash the dying host");
      assert.equal(child.events[0][1], "function");
      assert.equal(child.unrefCalls, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still restarts when the log file cannot be opened", async () => {
    const calls = [];
    const child = fakeChild();
    // Put the log path UNDER a plain file: mkdirSync cannot descend into a
    // non-directory, so the trail really cannot be opened (on Windows,
    // openSync() of a directory would have succeeded and proven nothing).
    const dir = mkdtempSync(join(tmpdir(), "anyswitch-restart-nolog-"));
    try {
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "not a directory");
      spawnPanelHostRestartHelper({
        spawnFn: (exec, args, opts) => { calls.push({ opts }); return child; },
        scriptPath: "C:/app/helper.mjs",
        logPath: join(blocker, "nested", "panel-host-restart.log"),
      });
      assert.equal(calls.length, 1, "a missing diagnostic trail must never block the restart");
      assert.deepEqual(calls[0].opts.stdio, ["ignore", "ignore", "ignore"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a spawn that returns no child object", () => {
    const dir = mkdtempSync(join(tmpdir(), "anyswitch-restart-tolerant-"));
    try {
      assert.doesNotThrow(() => spawnPanelHostRestartHelper({
        spawnFn: () => undefined,
        scriptPath: "C:/app/helper.mjs",
        logPath: dir,
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
