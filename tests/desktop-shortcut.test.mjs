import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
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

  it("payload 指向的 panel-app.vbs 与 anyswitch.ico 真实随仓分发（.lnk 链与图标有落点）", () => {
    // 字符串形态对还不算数：链的每一跳文件必须真在盘上。快捷方式写死这两个
    // 仓根文件的绝对路径，挪名/漏打包时 .lnk 第一跳就断（wscript 找不到脚本）、
    // 图标丢失，而只看字符串的旧断言照样全绿。
    const p = shortcutPayload();
    const vbs = p.arguments.replace(/^"/, "").replace(/"$/, "");
    const ico = p.icon.replace(/,0$/, "");
    assert.equal(existsSync(vbs), true, "panel-app.vbs 不在仓根：Anyswitch.lnk → wscript → panel-app.vbs 第一跳就断");
    assert.equal(existsSync(ico), true, "anyswitch.ico 不在仓根：快捷方式图标丢失");
    assert.equal(dirname(vbs), p.workingDirectory, "脚本与工作目录同根：自更新原地换装时 .lnk 永远指向活代码");
    assert.equal(dirname(ico), p.workingDirectory, "图标与工作目录同根");
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
