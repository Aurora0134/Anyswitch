import test from "node:test";
import assert from "node:assert/strict";
import { probePanelAppInfo, defaultSpawnPanelHost, spawnSelfUpdateWorker, runSelfUpdate, SELF_UPDATE_CLIENT_ID } from "../src/ops/app-self-update.mjs";
import { writeClientUpdateRun } from "../src/agents/client-update-journal.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN_ID = "00000000-0000-4000-8000-000000000000";

test("panel identity probe accepts only its bounded version and commit payload", async () => {
  const requests = [];
  const result = await probePanelAppInfo(47820, async (url, init) => {
    requests.push({ url, signal: init.signal });
    return { ok: true, json: async () => ({ version: "1.2.3", commit: "abc1234", extra: "ignored" }) };
  });
  assert.deepEqual(result, { version: "1.2.3", commit: "abc1234" });
  assert.equal(requests[0].url, "http://127.0.0.1:47820/panel/api/app-info");
  assert.ok(requests[0].signal instanceof AbortSignal);
});

test("panel identity probe maps HTTP, transport, and JSON failures to no identity", async () => {
  assert.equal(await probePanelAppInfo(47820, async () => ({ ok: false })), null);
  assert.equal(await probePanelAppInfo(47820, async () => { throw new Error("offline"); }), null);
  assert.equal(await probePanelAppInfo(47820, async () => ({ ok: true, json: async () => { throw new Error("bad json"); } })), null);
  assert.deepEqual(await probePanelAppInfo(47820, async () => ({ ok: true, json: async () => ({ version: 4, commit: null }) })), { version: null, commit: null });
});

test("default panel host dispatcher spawns the target runtime node directly with detached process flags", () => {
  let call, unref = false;
  const pid = defaultSpawnPanelHost({ installRoot: "C:/Anyswitch", appRoot: "C:/Anyswitch/versions/1.2.3/app", nodePath: "C:/Anyswitch/versions/1.2.3/runtime/node.exe", env: { PATH: "C:/Windows" }, spawnFn: (...args) => { call = args; return { pid: 999, unref() { unref = true; } }; } });
  assert.equal(pid, 999); assert.equal(call[0], "C:/Anyswitch/versions/1.2.3/runtime/node.exe");
  assert.deepEqual(call[1], [join("C:/Anyswitch/versions/1.2.3/app", "src", "panel", "panel-host.mjs")]);
  assert.ok([call[0], ...call[1]].every((arg) => !String(arg).includes('\\"')), "spawn argv 不得含内嵌 \\\"（cmd /s 剥引号后残留的旧形态）");
  assert.equal(call[2].detached, true); assert.equal(call[2].windowsHide, true); assert.equal(call[2].stdio, "ignore"); assert.equal(call[2].shell, false);
  assert.equal(call[2].env.ANYSWITCH_APP_ROOT, "C:/Anyswitch/versions/1.2.3/app"); assert.equal(call[2].env.ANYSWITCH_NODE_PATH, "C:/Anyswitch/versions/1.2.3/runtime/node.exe"); assert.ok(call[2].env.PATH.startsWith("C:/Anyswitch/versions/1.2.3/runtime")); assert.equal(unref, true);
});

test("self-update worker refuses foreign and non-running journal records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anys-update-journal-"));
  const row = { runId: RUN_ID, clientId: "claude", state: "running" };
  writeClientUpdateRun(dir, row);
  try {
    assert.equal(await runSelfUpdate({ runId: RUN_ID, journalDir: dir }), null);
    writeClientUpdateRun(dir, { ...row, clientId: SELF_UPDATE_CLIENT_ID, state: "done" });
    assert.equal(await runSelfUpdate({ runId: RUN_ID, journalDir: dir }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detached self-update worker preserves request, env root, and shutdown independence", () => {
  let call, unref = false;
  const pid = spawnSelfUpdateWorker({ runId: RUN_ID, journalDir: "C:/data/client-updates", execPath: "C:/Anyswitch/runtime/node.exe", workerPath: "C:/Anyswitch/app/src/ops/self-update-worker.mjs", env: { ANYSWITCH_INSTALL_ROOT: "C:/Anyswitch", ANYSWITCH_APP_ROOT: "C:/Anyswitch/versions/1.2.3/app" }, spawnFn: (...args) => { call = args; return { pid: 100, unref() { unref = true; } }; } });
  assert.equal(pid, 100); assert.equal(call[0], "C:/Anyswitch/runtime/node.exe");
  assert.deepEqual(call[1], ["C:/Anyswitch/app/src/ops/self-update-worker.mjs", RUN_ID, "C:/data/client-updates"]);
  assert.equal(call[2].detached, true); assert.equal(call[2].windowsHide, true); assert.equal(call[2].stdio, "ignore"); assert.equal(call[2].shell, false);
  assert.equal(call[2].env.ANYSWITCH_INSTALL_ROOT, "C:/Anyswitch"); assert.equal(call[2].env.ANYSWITCH_APP_ROOT, "C:/Anyswitch/versions/1.2.3/app"); assert.equal(unref, true);
});
