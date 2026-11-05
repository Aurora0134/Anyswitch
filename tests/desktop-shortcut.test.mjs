import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createDesktopShortcut, shortcutPayload } from "../src/ops/desktop-shortcut.mjs";

// Fake powershell child, same shape as tests/autostart.test.mjs: records the
// invocation, replays stdout/stderr, then closes (or errors) asynchronously.
function fakePS({ code = 0, stdout = "", stderr = "", error = null } = {}) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    const call = { cmd, args, opts, stdin: null };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end: (data) => {
        call.stdin = data ?? "";
      },
    };
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", stdout);
      if (stderr) child.stderr.emit("data", stderr);
      if (error) child.emit("error", error);
      else child.emit("close", code);
    });
    return child;
  };
  return { spawnFn, calls };
}

describe("desktop-shortcut", () => {
  it("payload wires the documented chain: wscript → panel-app.vbs, app icon", () => {
    const p = shortcutPayload();
    assert.equal(p.name, "Anyswitch.lnk");
    assert.equal(p.description, "Anyswitch 控制面板");
    assert.match(p.target, /System32[\\/]wscript\.exe$/i);
    assert.ok(p.arguments.includes("panel-app.vbs"), "arguments point at panel-app.vbs");
    assert.match(p.icon, /anyswitch\.ico,0$/);
    assert.ok(p.workingDirectory.length > 0);
  });

  it("create spawns windowless powershell and feeds the payload over stdin", async () => {
    const { spawnFn, calls } = fakePS({ stdout: "CREATED" });
    const result = await createDesktopShortcut({ spawnFn });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.cmd, "powershell.exe");
    assert.deepEqual(call.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    assert.equal(call.opts.windowsHide, true);
    const script = call.args[3];
    assert.ok(script.includes("GetFolderPath('Desktop')"), "desktop dir resolved shell-side (OneDrive redirect)");
    assert.ok(script.includes("CreateShortcut"), "script builds the .lnk via WScript.Shell");
    const fed = JSON.parse(call.stdin);
    assert.equal(fed.name, "Anyswitch.lnk");
    assert.ok(fed.arguments.includes("panel-app.vbs"));
  });

  it("non-zero exit surfaces stderr as the error", async () => {
    const { spawnFn } = fakePS({ code: 1, stderr: "Access denied" });
    const result = await createDesktopShortcut({ spawnFn });
    assert.equal(result.ok, false);
    assert.equal(result.error, "Access denied");
  });

  it("spawn failure resolves ok:false instead of rejecting", async () => {
    const { spawnFn } = fakePS({ error: new Error("spawn powershell.exe ENOENT") });
    const result = await createDesktopShortcut({ spawnFn });
    assert.equal(result.ok, false);
    assert.match(result.error, /ENOENT/);
  });
});
