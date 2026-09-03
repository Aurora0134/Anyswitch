import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  buildTaskXml,
  disableAutostart,
  disableWatchdogAutostart,
  enableAutostart,
  enableWatchdogAutostart,
  getAutostartCommand,
  isAutostartEnabled,
  isWatchdogAutostartEnabled,
  xmlEscape,
} from "./autostart.mjs";

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

function psCommandOf(call) {
  return call.args[call.args.length - 1];
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
  it("registers the AnyswitchRelay task with the XML over stdin", async () => {
    const { spawnFn, calls } = fakePS({ stdout: "REGISTERED\r\n" });
    const result = await enableAutostart({ spawnFn });

    assert.deepEqual(result, { ok: true, stdout: "REGISTERED\r\n" });
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.cmd, "powershell.exe");
    assert.deepEqual(call.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    assert.ok(psCommandOf(call).includes("Register-ScheduledTask -TaskName 'AnyswitchRelay'"));
    // The task XML must travel over stdin, never the command line.
    assert.ok(call.stdin.includes("<Task"));
    assert.ok(call.stdin.includes("relay-host.mjs"));
    assert.ok(!psCommandOf(call).includes("<Task"));
  });

  it("reports failure with the PowerShell stderr", async () => {
    const { spawnFn } = fakePS({ code: 1, stderr: "Register-ScheduledTask : 拒绝访问\r\n" });
    const result = await enableAutostart({ spawnFn });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("拒绝访问"));
  });

  it("reports failure when powershell cannot be spawned", async () => {
    const { spawnFn } = fakePS({ error: new Error("spawn powershell ENOENT") });
    const result = await enableAutostart({ spawnFn });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("ENOENT"));
  });
});

describe("disableAutostart", () => {
  it("unregisters the AnyswitchRelay task and sends no stdin", async () => {
    const { spawnFn, calls } = fakePS({ stdout: "UNREGISTERED\r\n" });
    const result = await disableAutostart({ spawnFn });

    assert.equal(result.ok, true);
    const command = psCommandOf(calls[0]);
    assert.ok(command.includes("Unregister-ScheduledTask -TaskName 'AnyswitchRelay'"));
    assert.ok(command.includes("-Confirm:$false"));
    assert.equal(calls[0].stdin, "");
  });

  it("also unregisters the pre-rename legacy task", async () => {
    const { spawnFn, calls } = fakePS({ stdout: "UNREGISTERED\r\n" });
    await disableAutostart({ spawnFn });

    assert.equal(calls.length, 2);
    assert.ok(psCommandOf(calls[1]).includes("Unregister-ScheduledTask -TaskName 'ApiCredRelay'"));
  });
});

describe("isAutostartEnabled", () => {
  it("is true when the task is PRESENT", async () => {
    const { spawnFn, calls } = fakePS({ stdout: "PRESENT\r\n" });
    assert.equal(await isAutostartEnabled({ spawnFn }), true);
    assert.ok(psCommandOf(calls[0]).includes("Get-ScheduledTask -TaskName 'AnyswitchRelay'"));
  });

  it("is false when the task is ABSENT", async () => {
    const { spawnFn } = fakePS({ stdout: "ABSENT\r\n" });
    assert.equal(await isAutostartEnabled({ spawnFn }), false);
  });

  it("is false when the PowerShell probe fails", async () => {
    const failed = fakePS({ code: 1, stderr: "boom" });
    assert.equal(await isAutostartEnabled({ spawnFn: failed.spawnFn }), false);
    const errored = fakePS({ error: new Error("spawn failed") });
    assert.equal(await isAutostartEnabled({ spawnFn: errored.spawnFn }), false);
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
    const { spawnFn, calls } = fakePS({ stdout: "ABSENT\r\n" });
    assert.equal(await isWatchdogAutostartEnabled({ spawnFn }), false);
    assert.ok(psCommandOf(calls[0]).includes("Get-ScheduledTask -TaskName 'AnyswitchWatchdog'"));
  });
});
