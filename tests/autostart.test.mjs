import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildTaskXml,
  disableAutostart,
  disablePanelAutostart,
  disableWatchdogAutostart,
  enableAutostart,
  enablePanelAutostart,
  enableWatchdogAutostart,
  getAutostartCommand,
  isAutostartEnabled,
  isPanelAutostartEnabled,
  isWatchdogAutostartEnabled,
  reconcileAutostart,
  taskAction,
  xmlEscape,
} from "../src/ops/autostart.mjs";

const PANEL_SCRIPT = join("..", "panel", "panel-host.mjs");
const WATCHDOG_SCRIPT = join("..", "agents", "agent-watchdog.mjs");

// Fake powershell child: records the invocation, then replays stdout/stderr
// and closes (or errors) asynchronously like the real spawn handle.
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

// Same shape, but each spawn replays the next scripted response — reconcile
// probes once and may then re-register, so the two calls differ.
function fakePSSeries(responses) {
  const calls = [];
  let index = 0;
  const spawnFn = (cmd, args, opts) => {
    const call = { cmd, args, opts, stdin: null };
    calls.push(call);
    const plan = responses[Math.min(index++, responses.length - 1)] ?? {};
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end: (data) => {
        call.stdin = data ?? "";
      },
    };
    queueMicrotask(() => {
      if (plan.stdout) child.stdout.emit("data", plan.stdout);
      if (plan.stderr) child.stderr.emit("data", plan.stderr);
      if (plan.error) child.emit("error", plan.error);
      else child.emit("close", plan.code ?? 0);
    });
    return child;
  };
  return { spawnFn, calls };
}

function psCommandOf(call) {
  return call.args[call.args.length - 1];
}

// What the probe script prints for the given tasks — one TASK=/COMMAND=/ARGS=
// trio each, absent tasks omitted (same as the real script).
function probeOutput(entries) {
  return Object.entries(entries)
    .map(([name, action]) => `TASK=${name}\r\nCOMMAND=${action.command}\r\nARGS=${action.arguments}\r\n`)
    .join("");
}

describe("xmlEscape", () => {
  it("escapes all XML-special characters", () => {
    assert.equal(xmlEscape(`a&b<c>d"e`), "a&amp;b&lt;c&gt;d&quot;e");
  });

  it("leaves plain text untouched and coerces non-strings", () => {
    assert.equal(xmlEscape("plain path"), "plain path");
    assert.equal(xmlEscape(42), "42");
    assert.equal(xmlEscape(null), "null");
  });
});

describe("getAutostartCommand", () => {
  it("returns the quoted node command for the app script", () => {
    const command = getAutostartCommand();
    assert.ok(command.startsWith('node "'));
    assert.ok(command.includes("relay-host.mjs"));
    assert.ok(command.endsWith('"'));
  });
});

describe("buildTaskXml", () => {
  it("starts silent-start.vbs via wscript with no execution time limit", () => {
    const xml = buildTaskXml("relay-host.mjs");
    assert.ok(xml.includes("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
    assert.ok(xml.includes("<LogonType>InteractiveToken</LogonType>"));
    assert.ok(xml.includes("<RunLevel>LeastPrivilege</RunLevel>"));
    assert.ok(xml.includes("wscript.exe</Command>"));
    assert.ok(xml.includes("silent-start.vbs"));
    assert.ok(xml.includes("relay-host.mjs"));
  });

  it("escapes the quoted arguments for XML", () => {
    const xml = buildTaskXml("relay-host.mjs");
    const args = xml.match(/<Arguments>([\s\S]*?)<\/Arguments>/)?.[1] ?? "";
    // The raw action is `"<vbs>" "<script>"` — both quotes must be XML-escaped
    // and no raw quote may survive inside the element.
    assert.ok(args.includes("&quot;"));
    assert.ok(!args.includes('"'));
  });

  it("carries the current user as principal when USERNAME is set", () => {
    const xml = buildTaskXml("relay-host.mjs");
    if (process.env.USERNAME) {
      assert.ok(xml.includes("<UserId>"));
    } else {
      assert.ok(!xml.includes("<UserId>"));
    }
  });
});

describe("enableAutostart", () => {
  it("registers the relay and panel tasks with the XML over stdin", async () => {
    const { spawnFn, calls } = fakePS({ stdout: "REGISTERED\r\n" });
    const result = await enableAutostart({ spawnFn });

    assert.deepEqual(result, { ok: true, stdout: "REGISTERED\r\n" });
    assert.equal(calls.length, 2);
    const relay = calls[0];
    assert.equal(relay.cmd, "powershell.exe");
    assert.deepEqual(relay.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    assert.ok(psCommandOf(relay).includes("Register-ScheduledTask -TaskName 'AnyswitchRelay'"));
    // The task XML must travel over stdin, never the command line.
    assert.ok(relay.stdin.includes("<Task"));
    assert.ok(relay.stdin.includes("relay-host.mjs"));
    assert.ok(!psCommandOf(relay).includes("<Task"));
    const panel = calls[1];
    assert.ok(psCommandOf(panel).includes("Register-ScheduledTask -TaskName 'AnyswitchPanel'"));
    assert.ok(panel.stdin.includes("panel-host.mjs"));
  });

  it("reports failure with the PowerShell stderr", async () => {
    const { spawnFn } = fakePS({ code: 1, stderr: "Register-ScheduledTask : 拒绝访问\r\n" });
    const result = await enableAutostart({ spawnFn });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("拒绝访问"));
  });

  it("reports failure when the panel task registration fails after the relay's", async () => {
    const { spawnFn, calls } = fakePSSeries([
      { stdout: "REGISTERED\r\n" },
      { code: 1, stderr: "Register-ScheduledTask : 拒绝访问\r\n" },
    ]);
    const result = await enableAutostart({ spawnFn });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("panel task:"));
    assert.ok(result.error.includes("拒绝访问"));
    assert.equal(calls.length, 2);
  });

  it("reports failure when powershell cannot be spawned", async () => {
    const { spawnFn } = fakePS({ error: new Error("spawn powershell ENOENT") });
    const result = await enableAutostart({ spawnFn });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("ENOENT"));
  });
});

describe("disableAutostart", () => {
  it("unregisters the relay and panel tasks and sends no stdin", async () => {
    const { spawnFn, calls } = fakePS({ stdout: "UNREGISTERED\r\n" });
    const result = await disableAutostart({ spawnFn });

    assert.equal(result.ok, true);
    const command = psCommandOf(calls[0]);
    assert.ok(command.includes("Unregister-ScheduledTask -TaskName 'AnyswitchRelay'"));
    assert.ok(command.includes("-Confirm:$false"));
    assert.equal(calls[0].stdin, "");
    assert.ok(psCommandOf(calls[1]).includes("Unregister-ScheduledTask -TaskName 'AnyswitchPanel'"));
  });

  it("also unregisters the pre-rename legacy task", async () => {
    const { spawnFn, calls } = fakePS({ stdout: "UNREGISTERED\r\n" });
    await disableAutostart({ spawnFn });

    assert.equal(calls.length, 3);
    assert.ok(psCommandOf(calls[2]).includes("Unregister-ScheduledTask -TaskName 'ApiCredRelay'"));
  });
});

describe("isAutostartEnabled", () => {
  it("is true when the task is present", async () => {
    const { spawnFn, calls } = fakePS({ stdout: probeOutput({ AnyswitchRelay: taskAction() }) });
    assert.equal(await isAutostartEnabled({ spawnFn }), true);
    assert.ok(psCommandOf(calls[0]).includes("$names = @('AnyswitchRelay')"));
    assert.ok(psCommandOf(calls[0]).includes("Get-ScheduledTask -TaskName $n"));
    // An absent task is a non-terminating error, which alone makes powershell
    // exit 1; without the forced 0 the whole probe reads as a failure.
    assert.ok(psCommandOf(calls[0]).includes("exit 0"));
    assert.ok(psCommandOf(calls[0]).includes("$ErrorActionPreference = 'Stop'"));
  });

  it("is false when the task is absent", async () => {
    const { spawnFn } = fakePS({ stdout: "" });
    assert.equal(await isAutostartEnabled({ spawnFn }), false);
  });

  it("is false when the PowerShell probe fails", async () => {
    const failed = fakePS({ code: 1, stderr: "boom" });
    assert.equal(await isAutostartEnabled({ spawnFn: failed.spawnFn }), false);
    const errored = fakePS({ error: new Error("spawn failed") });
    assert.equal(await isAutostartEnabled({ spawnFn: errored.spawnFn }), false);
  });
});

describe("taskAction", () => {
  it("names the vbs launcher and the relay script, both quoted", () => {
    const action = taskAction();
    assert.ok(action.command.toLowerCase().endsWith("wscript.exe"));
    assert.match(action.arguments, /^".+silent-start\.vbs" ".+relay-host\.mjs"$/);
  });

  it("points at files that exist in this tree", () => {
    // Same regression the 2026-11 src/ split produced: a task registered from
    // a path this build no longer has. Both halves are covered here.
    for (const path of taskAction().arguments.match(/"([^"]+)"/g).map((quoted) => quoted.slice(1, -1))) {
      assert.ok(existsSync(path), `task action path must exist: ${path}`);
    }
    const watchdog = taskAction(WATCHDOG_SCRIPT);
    assert.match(watchdog.arguments, /agent-watchdog\.mjs"$/);
    const panel = taskAction(PANEL_SCRIPT);
    assert.match(panel.arguments, /panel-host\.mjs"$/);
    for (const path of panel.arguments.match(/"([^"]+)"/g).map((quoted) => quoted.slice(1, -1))) {
      assert.ok(existsSync(path), `panel task action path must exist: ${path}`);
    }
  });
});

describe("reconcileAutostart", () => {
  it("re-registers a task still pointing at the pre-refactor tree", async () => {
    const stale = {
      command: taskAction().command,
      arguments: '"C:\\Anyswitch\\app\\silent-start.vbs" "C:\\Anyswitch\\app\\relay-host.mjs"',
    };
    const { spawnFn, calls } = fakePSSeries([
      { stdout: probeOutput({ AnyswitchRelay: stale, AnyswitchPanel: taskAction(PANEL_SCRIPT) }) },
      { stdout: "REGISTERED\r\n" },
    ]);

    const result = await reconcileAutostart({ spawnFn });

    assert.equal(result.ok, true);
    const relay = result.tasks.find((task) => task.task === "AnyswitchRelay");
    assert.equal(relay.state, "healed");
    assert.equal(relay.was, stale.arguments);
    assert.equal(calls.length, 2);
    assert.ok(psCommandOf(calls[1]).includes("Register-ScheduledTask -TaskName 'AnyswitchRelay'"));
    assert.ok(calls[1].stdin.includes("relay-host.mjs"));
    // The repair must write THIS tree's path, not the stale one.
    assert.ok(calls[1].stdin.includes("src\\relay\\relay-host.mjs") || calls[1].stdin.includes("src/relay/relay-host.mjs"));
  });

  it("leaves a correct registration alone — one probe, no writes", async () => {
    const { spawnFn, calls } = fakePSSeries([
      { stdout: probeOutput({ AnyswitchRelay: taskAction(), AnyswitchWatchdog: taskAction(WATCHDOG_SCRIPT), AnyswitchPanel: taskAction(PANEL_SCRIPT) }) },
    ]);

    const result = await reconcileAutostart({ spawnFn });

    assert.deepEqual(result.tasks.map((task) => task.state), ["ok", "ok", "ok"]);
    assert.equal(calls.length, 1);
  });

  it("backfills the panel task on installs from before panel coverage", async () => {
    // Relay task present and healthy, panel task absent: the user turned
    // autostart on when the toggle only covered the relay. Absence here is
    // not the user's own 关闭, so reconcile creates the panel task.
    const { spawnFn, calls } = fakePSSeries([
      { stdout: probeOutput({ AnyswitchRelay: taskAction() }) },
      { stdout: "REGISTERED\r\n" },
    ]);

    const result = await reconcileAutostart({ spawnFn });

    assert.deepEqual(result.tasks.map((task) => task.state), ["ok", "absent", "backfilled"]);
    assert.equal(calls.length, 2);
    assert.ok(psCommandOf(calls[1]).includes("Register-ScheduledTask -TaskName 'AnyswitchPanel'"));
    assert.ok(calls[1].stdin.includes("panel-host.mjs"));
  });

  it("backfills the panel task when only the legacy relay task survives", async () => {
    const { spawnFn, calls } = fakePSSeries([
      { stdout: probeOutput({ ApiCredRelay: taskAction() }) },
      { stdout: "REGISTERED\r\n" },
    ]);

    const result = await reconcileAutostart({ spawnFn });

    assert.deepEqual(result.tasks.map((task) => task.state), ["legacy", "absent", "backfilled"]);
    assert.equal(calls.length, 2);
    assert.ok(psCommandOf(calls[1]).includes("Register-ScheduledTask -TaskName 'AnyswitchPanel'"));
  });

  it("ignores a path that differs only by case", async () => {
    // actionMatches folds case alone: command and quoted paths (actionPaths)
    // are compared lowercased. Separator differences (/ vs \) are NOT
    // normalised — those count as a stale registration and get healed.
    const action = taskAction();
    const shouty = { command: action.command.toUpperCase(), arguments: action.arguments.toUpperCase() };
    const panel = taskAction(PANEL_SCRIPT);
    const { spawnFn, calls } = fakePSSeries([{ stdout: probeOutput({ AnyswitchRelay: shouty, AnyswitchPanel: panel }) }]);

    const result = await reconcileAutostart({ spawnFn });

    assert.equal(result.tasks[0].state, "ok");
    assert.equal(calls.length, 1);
  });

  it("never creates a task that is absent — that is the user's own off switch", async () => {
    const { spawnFn, calls } = fakePSSeries([{ stdout: "" }]);

    const result = await reconcileAutostart({ spawnFn });

    // Relay absent too — autostart is OFF, so the absent panel task is left
    // alone instead of backfilled.
    assert.deepEqual(result.tasks.map((task) => task.state), ["absent", "absent", "absent"]);
    assert.equal(calls.length, 1);
  });

  it("reports a failed repair without throwing", async () => {
    const stale = { command: taskAction().command, arguments: '"C:\\old\\silent-start.vbs" "C:\\old\\relay-host.mjs"' };
    const { spawnFn } = fakePSSeries([
      { stdout: probeOutput({ AnyswitchRelay: stale }) },
      { code: 1, stderr: "Register-ScheduledTask : 拒绝访问\r\n" },
    ]);

    const result = await reconcileAutostart({ spawnFn });

    assert.equal(result.ok, true);
    const relay = result.tasks.find((task) => task.task === "AnyswitchRelay");
    assert.equal(relay.state, "heal-failed");
    assert.ok(relay.error.includes("拒绝访问"));
    // Relay present (however stale) still proves the toggle was ON, so the
    // panel backfill is attempted — and fails the same way.
    const panel = result.tasks.find((task) => task.task === "AnyswitchPanel");
    assert.equal(panel.state, "heal-failed");
  });

  it("stays out of the way when the probe itself fails", async () => {
    const { spawnFn, calls } = fakePSSeries([{ code: 1, stderr: "Get-ScheduledTask : boom\r\n" }]);

    const result = await reconcileAutostart({ spawnFn });

    assert.equal(result.ok, false);
    assert.deepEqual(result.tasks, []);
    assert.equal(calls.length, 1);
  });
});

describe("watchdog autostart variants", () => {
  it("registers the AnyswitchWatchdog task pointing at agent-watchdog.mjs", async () => {
    const { spawnFn, calls } = fakePS({ stdout: "REGISTERED\r\n" });
    const result = await enableWatchdogAutostart({ spawnFn });

    assert.equal(result.ok, true);
    assert.ok(psCommandOf(calls[0]).includes("Register-ScheduledTask -TaskName 'AnyswitchWatchdog'"));
    assert.ok(calls[0].stdin.includes("agent-watchdog.mjs"));
  });

  it("unregisters the AnyswitchWatchdog task", async () => {
    const { spawnFn, calls } = fakePS({ stdout: "UNREGISTERED\r\n" });
    const result = await disableWatchdogAutostart({ spawnFn });
    assert.equal(result.ok, true);
    assert.ok(psCommandOf(calls[0]).includes("Unregister-ScheduledTask -TaskName 'AnyswitchWatchdog'"));
  });

  it("probes the AnyswitchWatchdog task name", async () => {
    const { spawnFn, calls } = fakePS({ stdout: "" });
    assert.equal(await isWatchdogAutostartEnabled({ spawnFn }), false);
    assert.ok(psCommandOf(calls[0]).includes("$names = @('AnyswitchWatchdog')"));
  });
});

describe("panel autostart variants", () => {
  it("registers the AnyswitchPanel task pointing at panel-host.mjs", async () => {
    const { spawnFn, calls } = fakePS({ stdout: "REGISTERED\r\n" });
    const result = await enablePanelAutostart({ spawnFn });

    assert.equal(result.ok, true);
    assert.ok(psCommandOf(calls[0]).includes("Register-ScheduledTask -TaskName 'AnyswitchPanel'"));
    assert.ok(calls[0].stdin.includes("panel-host.mjs"));
    // The task starts the host, not the launcher — no browser window at logon.
    assert.ok(!calls[0].stdin.includes("panel-launcher.mjs"));
  });

  it("unregisters the AnyswitchPanel task", async () => {
    const { spawnFn, calls } = fakePS({ stdout: "UNREGISTERED\r\n" });
    const result = await disablePanelAutostart({ spawnFn });
    assert.equal(result.ok, true);
    assert.ok(psCommandOf(calls[0]).includes("Unregister-ScheduledTask -TaskName 'AnyswitchPanel'"));
  });

  it("probes the AnyswitchPanel task name", async () => {
    const { spawnFn, calls } = fakePS({ stdout: "" });
    assert.equal(await isPanelAutostartEnabled({ spawnFn }), false);
    assert.ok(psCommandOf(calls[0]).includes("$names = @('AnyswitchPanel')"));
  });
});

// ── 打包安装形态：任务 Exec 指安装根静默分发器 ────────────────────────────
describe("autostart packaged", () => {
  const INSTALL_ROOT = join("C:", "Apps", "Anyswitch");

  it("taskAction 指 anyswitch-silent.vbs + app 相对入口（换版本零重写）", () => {
    const action = taskAction(PANEL_SCRIPT, INSTALL_ROOT);
    assert.match(action.command, /System32[\\/]wscript\.exe$/i);
    assert.equal(action.arguments, `"${join(INSTALL_ROOT, "anyswitch-silent.vbs")}" "src/panel/panel-host.mjs"`);
    // entry 换算：相对 src/ops/ 的 ../panel/panel-host.mjs → app 相对 src/panel/panel-host.mjs
    const relayAction = taskAction(join("..", "relay", "relay-host.mjs"), INSTALL_ROOT);
    assert.equal(relayAction.arguments, `"${join(INSTALL_ROOT, "anyswitch-silent.vbs")}" "src/relay/relay-host.mjs"`);
    assert.ok(!action.arguments.includes(silentStartVbs()), "不再指 app 内 silent-start.vbs");
  });

  it("getAutostartCommand 打包形态给 anyswitch.cmd 形态", () => {
    assert.equal(getAutostartCommand(PANEL_SCRIPT, INSTALL_ROOT), `"${join(INSTALL_ROOT, "anyswitch.cmd")}" "src/panel/panel-host.mjs"`);
  });

  it("appEntryOf 拒绝越出 src 的路径（逃逸防御）", () => {
    assert.throws(() => taskAction(join("..", "..", "outside", "x.mjs"), INSTALL_ROOT), /unexpected entry path/);
  });
});

function silentStartVbs() {
  return join("silent-start.vbs");
}

// ── GBK 控制台仿真：stdin/stdout 双向编码钉 ────────────────────────────────
// zh-CN 控制台的真实行为：node 恒以 UTF-8 字节写管道，脚本没钉
// [Console]::InputEncoding 时 PowerShell 按 OEM 码页（936/GBK）解码；stdout
// 方向镜像，没钉 OutputEncoding 时 PS 按 GBK 发字节，node 又恒按 UTF-8 读。
// 替身按脚本是否钉 UTF-8 前置选择编解码——没钉就真乱码，测试因此能抓住
// 回归。GBK 编码只覆盖本组测试用到的几个字，码点经 TextDecoder('gbk') 核对。
const GBK_BYTES = {
  张: [0xd5, 0xc5],
  三: [0xc8, 0xfd],
  测: [0xb2, 0xe2],
  试: [0xca, 0xd4],
  机: [0xbb, 0xfa],
};

function gbkEncode(text) {
  const bytes = [];
  for (const ch of text) bytes.push(...(GBK_BYTES[ch] ?? Buffer.from(ch, "utf8")));
  return Buffer.from(bytes);
}

const PS_INPUT_UTF8 = "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)";
const PS_OUTPUT_UTF8 = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)";

function gbkConsolePS({ probeStdout = "" } = {}) {
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
      let text = null;
      if (script.includes("Get-ScheduledTask")) text = probeStdout;
      else if (script.includes("Register-ScheduledTask")) text = "REGISTERED\r\n";
      if (text) {
        child.stdout.emit("data", script.includes(PS_OUTPUT_UTF8) ? Buffer.from(text, "utf8") : gbkEncode(text));
      }
      child.emit("close", 0);
    });
    return child;
  };
  return { spawnFn, calls };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("PowerShell console encoding", () => {
  it("register pins UTF-8, so a Chinese UserId survives a GBK console", async () => {
    const savedUser = process.env.USERNAME;
    const savedDomain = process.env.USERDOMAIN;
    process.env.USERNAME = "张三";
    process.env.USERDOMAIN = "测试机";
    try {
      const { spawnFn, calls } = gbkConsolePS();
      const result = await enableAutostart({ spawnFn });

      assert.equal(result.ok, true);
      const script = psCommandOf(calls[0]);
      assert.ok(script.includes(PS_INPUT_UTF8), "register 脚本首部钉 InputEncoding");
      assert.ok(script.includes(PS_OUTPUT_UTF8), "register 脚本首部钉 OutputEncoding");
      assert.ok(calls[0].decodedStdin.includes("<UserId>测试机\\张三</UserId>"), "GBK 控制台下 XML 中文字段完好抵达");
      // 控制组：同一段字节按 GBK 误解码必然乱码，替身不乱码断言才算数。
      assert.ok(!new TextDecoder("gbk").decode(Buffer.from(calls[0].stdin, "utf8")).includes("张三"));
    } finally {
      restoreEnv("USERNAME", savedUser);
      restoreEnv("USERDOMAIN", savedDomain);
    }
  });

  it("probe readback pins UTF-8, so Chinese stored paths reach reconcile unmangled", async () => {
    const stale = {
      command: taskAction().command,
      arguments: '"C:\\Users\\张三\\silent-start.vbs" "C:\\Users\\张三\\relay-host.mjs"',
    };
    const probe = probeOutput({ AnyswitchRelay: stale, AnyswitchPanel: taskAction(PANEL_SCRIPT) });
    const { spawnFn, calls } = gbkConsolePS({ probeStdout: probe });

    const result = await reconcileAutostart({ spawnFn });

    assert.equal(result.ok, true);
    const relay = result.tasks.find((task) => task.task === "AnyswitchRelay");
    assert.equal(relay.state, "healed");
    assert.equal(relay.was, stale.arguments, "GBK 控制台读回的中文路径原样进入比对");
    assert.ok(psCommandOf(calls[0]).includes(PS_OUTPUT_UTF8), "probe 脚本首部钉 OutputEncoding");
    // 控制组：GBK 字节按 UTF-8 读必然乱码（node 侧恒按 UTF-8 解码管道）。
    assert.ok(!gbkEncode(probe).toString("utf8").includes("张三"));
  });
});
