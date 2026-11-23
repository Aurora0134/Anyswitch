import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInitialStore, isHostCommand, runDesktopLifecycle } from "../src/ops/desktop-lifecycle.mjs";
import { connectResidentRelay } from "../src/launchers/launcher-native-fallback.mjs";

test("desktop creates an empty store on first launch and preserves existing data", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "anyswitch-desktop-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "data");
  const settings = join(root, "store.json");
  ensureInitialStore(root);
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { version: 2, providers: {} });
  writeFileSync(settings, "unreadable store data");
  ensureInitialStore(root);
  assert.equal(readFileSync(settings, "utf8"), "unreadable store data");
});

test("opening the panel from a running tray does not start a stopped Relay", async () => {
  let panelOpened = false;
  assert.equal(await runDesktopLifecycle("open", {
    root: ".",
    openPanel: async () => { panelOpened = true; return true; },
    start: async () => assert.fail("opening the panel started Relay"),
  }), true);
  assert.equal(panelOpened, true);
});

test("shutdown identifies the app's host and refuses the same script name elsewhere", () => {
  const root = "C:/Anyswitch App";
  assert.equal(isHostCommand(`"node.exe" "${root}/versions/1.2.3/app/src/panel/panel-host.mjs"`, "panel", [], root), true);
  assert.equal(isHostCommand(`"node.exe" "${root}-backup/versions/1.2.3/app/src/panel/panel-host.mjs"`, "panel", [], root), false);
  assert.equal(isHostCommand(`"node.exe" "C:/other.mjs" "${root}/versions/1.2.3/app/src/panel/panel-host.mjs"`, "panel", [], root), false);
});

test("shutdown waits for an update before stopping Relay and the web panel", async () => {
  let updateInProgress = true;
  assert.equal(await runDesktopLifecycle("stop", {
    root: ".",
    retire: async () => true,
    waitForUpdate: async () => { updateInProgress = false; return true; },
    stop: async () => { assert.equal(updateInProgress, false); return { ok: true }; },
    closePanel: async () => { assert.equal(updateInProgress, false); return true; },
  }), true);
});

test("an Agent cannot acquire Relay when the service is stopped", async () => {
  await assert.rejects(connectResidentRelay({
    root: ".",
    probe: async () => false,
    readToken: () => assert.fail("read Relay token while stopped"),
  }), /Relay is not running/);
});
