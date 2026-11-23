import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createDesktopShortcut, shortcutPayload } from "../src/ops/desktop-shortcut.mjs";

it("migrates an old Anyswitch desktop shortcut while preserving a different same-name link", { skip: process.platform !== "win32" }, async (t) => {
  const { migrateDesktopShortcut } = await import("../src/ops/desktop-shortcut.mjs");
  const folder = mkdtempSync(join(tmpdir(), "anyswitch-links-"));
  t.after(() => rmSync(folder, { force: true, recursive: true }));
  const linkPath = join(folder, "Anyswitch.lnk");
  const exe = join(folder, "Anyswitch.exe");
  writeFileSync(exe, "");
  const shell = (cmd, linkEnv = {}) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, LINK: linkPath, ...linkEnv },
  }).trim();
  const create = '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LINK); $s.TargetPath=$env:TARGET; $s.Arguments=$env:LINK_ARGS; $s.Save()';
  const target = '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LINK); $s.TargetPath';
  const wscript = join(process.env.SystemRoot, "System32", "wscript.exe");
  shell(create, { TARGET: wscript, LINK_ARGS: '"C:\\Other App\\panel-app.vbs"' });
  assert.equal((await migrateDesktopShortcut({ installRoot: folder, linkPath })).ok, true);
  assert.equal(shell(target).toLowerCase(), wscript.toLowerCase());
  shell(create, { TARGET: wscript, LINK_ARGS: `"${join(folder, "anyswitch-silent.vbs")}" "src\\panel\\panel-launcher.mjs"` });
  assert.equal((await migrateDesktopShortcut({ installRoot: folder, linkPath })).ok, true);
  assert.equal(shell(target).toLowerCase(), exe.toLowerCase());
});

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

// ── 打包安装形态：快捷方式指安装根静默分发器 ──────────────────────────────
describe("desktop-shortcut packaged", () => {
  it("payload 指静默分发器 + src\\panel\\panel-launcher.mjs，icon 无根副本时回落活动版本 app", () => {
    const installRoot = join("C:", "Apps", "Anyswitch");
    const p = shortcutPayload({ installRoot, currentVersion: "1.2.3" });
    assert.equal(p.name, "Anyswitch.lnk");
    assert.match(p.target, /System32[\\/]wscript\.exe$/i);
    assert.equal(p.arguments, `"${join(installRoot, "anyswitch-silent.vbs")}" "src\\panel\\panel-launcher.mjs"`);
    assert.equal(p.icon, `${join(installRoot, "versions", "1.2.3", "app", "anyswitch.ico")},0`);
    assert.equal(p.workingDirectory, installRoot);
    assert.ok(!p.arguments.includes("panel-app.vbs"), "不再指 app 内 panel-app.vbs");
  });

  it("current.json 在盘时版本真读指针（安装器落点），读不出回落源码形态", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const installRoot = mkdtempSync(join(tmpdir(), "anys-shortcut-root-"));
    try {
      writeFileSync(join(installRoot, "current.json"), JSON.stringify({ schema: 1, version: "2.0.1" }));
      const p = shortcutPayload({ installRoot });
      assert.equal(p.icon, `${join(installRoot, "versions", "2.0.1", "app", "anyswitch.ico")},0`, "根副本缺失时 icon 回落指针活动版本");
      assert.equal(p.workingDirectory, installRoot);
      rmSync(join(installRoot, "current.json"), { force: true });
      const fallback = shortcutPayload({ installRoot });
      assert.ok(fallback.arguments.includes("panel-app.vbs"), "指针读不出：回落源码形态");
    } finally {
      rmSync(installRoot, { recursive: true, force: true });
    }
  });

  it("icon 优先指安装根稳定 ico（跨版本连续），根副本缺失时回落版本内 ico", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const installRoot = mkdtempSync(join(tmpdir(), "anys-shortcut-root-"));
    try {
      writeFileSync(join(installRoot, "current.json"), JSON.stringify({ schema: 1, version: "2.0.1" }));
      writeFileSync(join(installRoot, "anyswitch.ico"), "");
      const p = shortcutPayload({ installRoot });
      assert.equal(p.icon, `${join(installRoot, "anyswitch.ico")},0`, "根副本在盘即指根副本（安装器 [Files] 落点）");
      rmSync(join(installRoot, "anyswitch.ico"), { force: true });
      const fallback = shortcutPayload({ installRoot });
      assert.equal(fallback.icon, `${join(installRoot, "versions", "2.0.1", "app", "anyswitch.ico")},0`, "根副本被删后回落版本内 ico");
    } finally {
      rmSync(installRoot, { recursive: true, force: true });
    }
  });
});

// ── GBK 控制台仿真：快捷方式中文字段的编码钉 ───────────────────────────────
// 与 tests/autostart.test.mjs 的替身同理：node 恒以 UTF-8 字节写 stdin，
// 脚本没钉 [Console]::InputEncoding 时 PowerShell 按 GBK 解码，JSON 里的
// 中文 description（SHORTCUT_DESCRIPTION 含中文）落盘前已乱码。
function gbkConsolePS() {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    const call = { cmd, args, opts, stdin: null, decodedStdin: null };
    calls.push(call);
    const script = args[args.length - 1];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end: (data) => {
        call.stdin = data ?? "";
        const bytes = Buffer.from(call.stdin, "utf8");
        call.decodedStdin = script.includes(PS_INPUT_UTF8) ? bytes.toString("utf8") : new TextDecoder("gbk").decode(bytes);
      },
    };
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from("CREATED\r\n", "utf8"));
      child.emit("close", 0);
    });
    return child;
  };
  return { spawnFn, calls };
}

const PS_INPUT_UTF8 = "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)";
const PS_OUTPUT_UTF8 = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)";

describe("desktop-shortcut console encoding", () => {
  it("create pins UTF-8, so the Chinese description survives a GBK console", async () => {
    const { spawnFn, calls } = gbkConsolePS();
    const result = await createDesktopShortcut({ spawnFn });

    assert.equal(result.ok, true);
    const script = calls[0].args[3];
    assert.ok(script.includes(PS_INPUT_UTF8), "create 脚本首部钉 InputEncoding");
    assert.ok(script.includes(PS_OUTPUT_UTF8), "create 脚本首部钉 OutputEncoding");
    const fed = JSON.parse(calls[0].decodedStdin);
    assert.equal(fed.description, "Anyswitch 控制面板", "GBK 控制台下中文描述完好抵达");
    // 控制组：同一段字节按 GBK 误解码必然乱码，替身不乱码断言才算数。
    assert.ok(!new TextDecoder("gbk").decode(Buffer.from(calls[0].stdin, "utf8")).includes("控制面板"));
  });
});
