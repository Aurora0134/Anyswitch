import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeClientUpdate,
  listClientUpdateRuns,
  readClientUpdateRun,
  reapDeadClientUpdateRuns,
  spawnClientUpdateWorker,
  writeClientUpdateRun,
} from "./client-update-journal.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "anys-client-update-"));
}

function running(overrides = {}) {
  return {
    runId: "11111111-1111-1111-1111-111111111111",
    clientId: "claude",
    action: "update",
    state: "running",
    startedAt: "2026-09-26T00:00:00.000Z",
    finishedAt: null,
    result: null,
    workerPid: null,
    targetVersion: null,
    commandPath: "C:/fixture/claude",
    ...overrides,
  };
}

test("进程已经不在的进行中记录按中断收尾，活着的不动", () => {
  const dir = scratch();
  try {
    writeClientUpdateRun(dir, running({ workerPid: 41 }));
    writeClientUpdateRun(dir, running({ runId: "22222222-2222-2222-2222-222222222222", clientId: "codex", workerPid: 42 }));
    reapDeadClientUpdateRuns(dir, (pid) => pid === 42, () => "2026-09-26T00:01:00.000Z");
    const dead = readClientUpdateRun(dir, "11111111-1111-1111-1111-111111111111");
    assert.equal(dead.state, "done");
    assert.equal(dead.result.outcome, "failed");
    assert.match(dead.result.message, /更新中断/);
    const live = readClientUpdateRun(dir, "22222222-2222-2222-2222-222222222222");
    assert.equal(live.state, "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("安装跑完后记录带上新版本与比对结论，面板进程不参与", async () => {
  const dir = scratch();
  try {
    writeClientUpdateRun(dir, running({ beforeVersion: "1.0.0" }));
    const seen = [];
    const result = await executeClientUpdate({
      runId: running().runId,
      journalDir: dir,
      runLifecycle: async (request) => {
        seen.push(request);
        return { ok: true, output: "" };
      },
      environment: {
        async getState(options = {}) {
          return {
            clients: [{
              id: "claude",
              installations: [{ version: options.force ? "1.1.0" : "1.0.0", path: "C:/fixture/claude", issue: null }],
            }],
          };
        },
      },
      releases: { async getClientLatest() { return { state: "ok", version: "1.1.0" }; } },
      compareVersions: (left, right) => (left === right ? 0 : -1),
      alive: () => true,
      now: () => "2026-09-26T00:02:00.000Z",
    });
    assert.equal(result.outcome, "updated");
    assert.equal(seen[0].targetVersion, null);
    assert.equal(seen[0].commandPath, "C:/fixture/claude");
    const stored = readClientUpdateRun(dir, running().runId);
    assert.equal(stored.state, "done");
    assert.equal(stored.result.afterVersion, "1.1.0");
    assert.equal(stored.result.comparison, "current");
    assert.equal(listClientUpdateRuns(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("拉起安装进程时脱离父进程并丢掉管道", () => {
  const calls = [];
  const pid = spawnClientUpdateWorker({
    runId: "33333333-3333-3333-3333-333333333333",
    journalDir: "C:/journal",
    execPath: "C:/node.exe",
    workerPath: "C:/worker.mjs",
    spawnFn: (file, args, options) => {
      calls.push({ file, args, options });
      return { pid: 77, unref() { calls[0].unrefed = true; } };
    },
  });
  assert.equal(pid, 77);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].unrefed, true);
  assert.deepEqual(calls[0].args, ["C:/worker.mjs", "33333333-3333-3333-3333-333333333333", "C:/journal"]);
});
