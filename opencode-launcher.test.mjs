import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildInstanceId,
  buildOpencodeLauncherEnv,
  isEntryModule,
  resolveOpencodeExecutable,
  runOpencodeLauncher,
  startOpenAIRelay,
} from "./opencode-launcher.mjs";

// Minimal fake child for the injected spawnFn: emits either "error" or
// "exit" asynchronously, exactly like a real child_process handle.
function fakeOpencodeChild({ code = 0, signal = null, error = null } = {}) {
  const child = new EventEmitter();
  queueMicrotask(() => {
    if (error) child.emit("error", error);
    else child.emit("exit", code, signal);
  });
  return child;
}

describe("buildInstanceId", () => {
  it("builds <cwd basename>-<pid> and scrubs characters outside the relay charset", () => {
    assert.equal(buildInstanceId({ cwd: "C:\\work\\my proj", pid: 1234 }), "my-proj-1234");
  });

  it("keeps every character the relay accepts", () => {
    assert.equal(buildInstanceId({ cwd: "/home/u/a.b_c:d-e", pid: 42 }), "a.b_c:d-e-42");
  });

  it("falls back to opencode-<pid> when the cwd has no basename", () => {
    assert.equal(buildInstanceId({ cwd: "C:\\", pid: 7 }), "opencode-7");
  });

  it("caps the whole id at 64 characters", () => {
    const id = buildInstanceId({ cwd: `C:\\work\\${"a".repeat(100)}`, pid: 999 });
    assert.equal(id.length, 64);
    assert.match(id, /^a+-\d*$|^a+$/);
  });
});

describe("buildOpencodeLauncherEnv", () => {
  it("injects relay token and NO_PROXY for loopback", () => {
    const env = buildOpencodeLauncherEnv({ token: "tok", base: { A: "1", HTTP_PROXY: "http://proxy" } });
    assert.equal(env.ANYSWITCH_RELAY_TOKEN, "tok");
    assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
    assert.equal(env.no_proxy, "127.0.0.1,localhost");
    assert.equal(env.A, "1");
    assert.equal(env.HTTP_PROXY, "http://proxy");
    assert.equal(env.ANYSWITCH_AGENT_INSTANCE, undefined);
  });

  it("injects the per-instance tag for the plugin when given an instanceId", () => {
    const env = buildOpencodeLauncherEnv({ token: "tok", instanceId: "ws-1", base: {} });
    assert.equal(env.ANYSWITCH_AGENT_INSTANCE, "ws-1");
  });
});

describe("resolveOpencodeExecutable", () => {
  const base = { APPDATA: "C:\\AppData\\Roaming", USERPROFILE: "C:\\Users\\tester" };

  it("defaults to the real opencode binary under the roaming npm root", () => {
    assert.equal(
      resolveOpencodeExecutable(base),
      "C:\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
    );
  });

  it("falls back to USERPROFILE when APPDATA is unset", () => {
    assert.equal(
      resolveOpencodeExecutable({ USERPROFILE: "C:\\Users\\tester" }),
      "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
    );
  });

  it("accepts an absolute override", () => {
    assert.equal(
      resolveOpencodeExecutable({ ...base, OPENCODE_EXECUTABLE: "D:\\tools\\opencode\\opencode.exe" }),
      "D:\\tools\\opencode\\opencode.exe",
    );
  });

  it("ignores an empty override and keeps the default", () => {
    assert.equal(
      resolveOpencodeExecutable({ ...base, OPENCODE_EXECUTABLE: "" }),
      "C:\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
    );
  });

  it("rejects a relative override to avoid launcher recursion", () => {
    assert.throws(
      () => resolveOpencodeExecutable({ ...base, OPENCODE_EXECUTABLE: "opencode" }),
      /OPENCODE_EXECUTABLE must be an absolute path/,
    );
  });
});

describe("runOpencodeLauncher", () => {
  const base = {
    APPDATA: "C:\\AppData\\Roaming",
    USERPROFILE: "C:\\Users\\tester",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    CUSTOM_VAR: "kept",
  };

  it("starts relay, spawns opencode via cmd.exe with relay env, closes relay on exit", async () => {
    const calls = [];
    const code = await runOpencodeLauncher({
      startRelay: async () => {
        calls.push("startRelay");
        return { port: 47821, token: "tok", close: async () => calls.push("closeRelay") };
      },
      base,
      opencodeArgs: ["--model", "x"],
      spawnFn: (cmd, args, opts) => {
        calls.push({
          cmd,
          args,
          env: opts.env,
          stdio: opts.stdio,
          shell: opts.shell,
          windowsHide: opts.windowsHide,
        });
        return fakeOpencodeChild({ code: 0 });
      },
    });

    assert.equal(code, 0);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], "startRelay");
    const spawn = calls[1];
    assert.equal(spawn.cmd, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(spawn.args, [
      "/d",
      "/c",
      "C:\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
      "--model",
      "x",
    ]);
    assert.equal(spawn.env.ANYSWITCH_RELAY_TOKEN, "tok");
    assert.equal(spawn.env.NO_PROXY, "127.0.0.1,localhost");
    assert.equal(spawn.env.no_proxy, "127.0.0.1,localhost");
    assert.equal(spawn.env.CUSTOM_VAR, "kept");
    assert.equal(spawn.env.COMSPEC, "C:\\Windows\\System32\\cmd.exe");
    assert.equal(spawn.stdio, "inherit");
    assert.equal(spawn.shell, false);
    assert.equal(spawn.windowsHide, true);
    assert.deepEqual(calls[2], "closeRelay");
  });

  it("tags the child env with the per-launch instance id", async () => {
    let spawnedEnv = null;
    const code = await runOpencodeLauncher({
      startRelay: async () => ({ port: 47821, token: "tok", close: async () => {} }),
      base,
      instanceId: "ws-A-4242",
      spawnFn: (cmd, args, opts) => {
        spawnedEnv = opts.env;
        return fakeOpencodeChild({ code: 0 });
      },
    });
    assert.equal(code, 0);
    assert.equal(spawnedEnv.ANYSWITCH_AGENT_INSTANCE, "ws-A-4242");
  });

  it("defaults COMSPEC to cmd.exe when base lacks it", async () => {
    let seenCmd = null;
    const code = await runOpencodeLauncher({
      startRelay: async () => ({ port: 47821, token: "tok", close: async () => {} }),
      base: { APPDATA: "C:\\AppData\\Roaming" },
      spawnFn: (cmd) => {
        seenCmd = cmd;
        return fakeOpencodeChild({ code: 0 });
      },
    });
    assert.equal(seenCmd, "cmd.exe");
    assert.equal(code, 0);
  });

  it("forwards the child exit code", async () => {
    const code = await runOpencodeLauncher({
      startRelay: async () => ({ port: 47821, token: "tok", close: async () => {} }),
      base,
      spawnFn: () => fakeOpencodeChild({ code: 3 }),
    });
    assert.equal(code, 3);
  });

  it("maps a signal-only exit to 1 and a clean exit with null code to 0", async () => {
    const signalled = await runOpencodeLauncher({
      startRelay: async () => ({ port: 47821, token: "tok", close: async () => {} }),
      base,
      spawnFn: () => fakeOpencodeChild({ code: null, signal: "SIGTERM" }),
    });
    assert.equal(signalled, 1);

    const clean = await runOpencodeLauncher({
      startRelay: async () => ({ port: 47821, token: "tok", close: async () => {} }),
      base,
      spawnFn: () => fakeOpencodeChild({ code: null, signal: null }),
    });
    assert.equal(clean, 0);
  });

  it("rejects on spawn error and still closes the relay", async () => {
    let closed = false;
    await assert.rejects(
      runOpencodeLauncher({
        startRelay: async () => ({ port: 47821, token: "tok", close: async () => { closed = true; } }),
        base,
        spawnFn: () => fakeOpencodeChild({ error: new Error("spawn ENOENT") }),
      }),
      /spawn ENOENT/,
    );
    assert.equal(closed, true);
  });
});

describe("startOpenAIRelay", () => {
  // Unlike the zcode/pi/dsh launchers, the opencode relay has no degrade path:
  // an unusable store is fatal before any socket is opened (fail-closed).
  it("refuses to start when the Anyswitch store is not usable", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-relay-"));
    mkdirSync(join(root, "Anyswitch"), { recursive: true });
    const base = { LOCALAPPDATA: root, USERPROFILE: root };
    await assert.rejects(
      startOpenAIRelay({
        base,
        paths: {
          root,
          storeFile: join(root, "store.json"),
          credentialsDir: join(root, "credentials"),
          appDir: join(root, "app"),
        },
      }),
      /store is not usable/,
    );
  });
});

describe("isEntryModule", () => {
  it("matches when argv[1] is this module's real path", () => {
    assert.equal(isEntryModule(fileURLToPath(import.meta.url), import.meta.url), true);
  });

  it("does not match a different module path", () => {
    assert.equal(isEntryModule("C:\\definitely\\not\\this\\module.mjs", import.meta.url), false);
  });

  it("rejects empty or non-string argv", () => {
    assert.equal(isEntryModule("", import.meta.url), false);
    assert.equal(isEntryModule(undefined, import.meta.url), false);
    assert.equal(isEntryModule(null, import.meta.url), false);
  });

  it("falls back to raw string comparison when realpath fails on both sides", () => {
    // Neither path exists, so realpath throws on both and the norm() catch
    // returns the raw strings — equal literals therefore still match.
    const missing = "C:\\definitely\\not\\here\\launcher.mjs";
    assert.equal(isEntryModule(missing, pathToFileURL(missing).href), true);
  });

  it("returns false for an unparsable metaUrl", () => {
    assert.equal(isEntryModule(fileURLToPath(import.meta.url), "not a url"), false);
  });
});
