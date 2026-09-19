import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readSidecar } from "./opencode-merge-config.mjs";
import {
  buildInstanceId,
  buildOpencodeLauncherEnv,
  isEntryModule,
  opencodeConfigPath,
  resolveOpencodeExecutable,
  runOpencodeLauncher,
  startOpenAIRelay,
  writeOpencodeConfig,
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

  it("defaults to the real opencode binary inside the platform optional dependency", () => {
    // The top-level opencode-ai\bin\opencode.exe is a placeholder batch when
    // npm blocks the postinstall copy — never resolve to it.
    assert.equal(
      resolveOpencodeExecutable(base),
      "C:\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\node_modules\\opencode-windows-x64\\bin\\opencode.exe",
    );
  });

  it("falls back to USERPROFILE when APPDATA is unset", () => {
    assert.equal(
      resolveOpencodeExecutable({ USERPROFILE: "C:\\Users\\tester" }),
      "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\node_modules\\opencode-windows-x64\\bin\\opencode.exe",
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
      "C:\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\node_modules\\opencode-windows-x64\\bin\\opencode.exe",
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
      "C:\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\node_modules\\opencode-windows-x64\\bin\\opencode.exe",
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

  it("runs the wired writeConfig between relay start and spawn, with the data root", async () => {
    const calls = [];
    const code = await runOpencodeLauncher({
      startRelay: async () => {
        calls.push("startRelay");
        return { port: 47821, token: "tok", close: async () => calls.push("closeRelay") };
      },
      base,
      writeConfig: async (store, port, sidecarRoot) => {
        calls.push({ writeConfig: { storeVersion: store?.version, port, sidecarRoot } });
        return { ok: true, unchanged: false, backupPath: "B" };
      },
      log: (line) => calls.push({ log: line }),
      spawnFn: () => {
        calls.push("spawn");
        return fakeOpencodeChild({ code: 0 });
      },
    });
    assert.equal(code, 0);
    assert.equal(calls[0], "startRelay");
    assert.deepEqual(calls[1], {
      writeConfig: {
        storeVersion: 2,
        port: 47821,
        sidecarRoot: "C:\\Users\\tester\\AppData\\Local\\Anyswitch",
      },
    });
    assert.deepEqual(calls[2], { log: "opencode.json updated (backup: B)" });
    assert.equal(calls[3], "spawn");
    assert.equal(calls[4], "closeRelay");
  });

  it("logs a warning and still spawns when writeConfig reports failure", async () => {
    const calls = [];
    const code = await runOpencodeLauncher({
      startRelay: async () => ({ port: 47821, token: "tok", close: async () => {} }),
      base,
      writeConfig: async () => ({ ok: false, unchanged: true, reason: "unparseable" }),
      log: (line) => calls.push(line),
      spawnFn: () => fakeOpencodeChild({ code: 0 }),
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, ["warning: opencode.json not updated: unparseable"]);
  });

  it("skips config sync entirely when no writeConfig is wired (default no-op)", async () => {
    // The existing runOpencodeLauncher tests above all exercise this default:
    // none of them wires writeConfig and none touches the disk. Pin it so a
    // future default change cannot silently start rewriting the real config.
    const code = await runOpencodeLauncher({
      startRelay: async () => ({ port: 47821, token: "tok", close: async () => {} }),
      base,
      spawnFn: () => fakeOpencodeChild({ code: 0 }),
    });
    assert.equal(code, 0);
    assert.equal(existsSync(join("C:\\Users\\tester", ".config", "opencode", "opencode.json")), false);
  });
});

describe("writeOpencodeConfig", () => {
  function pooledStore() {
    return {
      version: 2,
      providers: {
        alpha: {
          displayName: "Alpha",
          baseURL: "https://alpha.invalid/v1",
          protocol: "openai-compatible",
          credentialFile: "alpha.dpapi",
          models: { "model-1": { displayName: "Model 1", contextWindow: 4096 } },
        },
        beta: {
          displayName: "Beta",
          baseURL: "https://beta.invalid/v1",
          protocol: "openai-compatible",
          credentialFile: "beta.dpapi",
          models: { "model-2": { displayName: "Model 2", contextWindow: 8192 } },
        },
        gamma: {
          displayName: "Gamma",
          baseURL: "https://gamma.invalid/v1",
          protocol: "openai-compatible",
          credentialFile: "gamma.dpapi",
          models: { "model-3": { displayName: "Model 3", contextWindow: 2048 } },
        },
      },
      pools: { "pool-ab": { displayName: "Pool AB", members: ["alpha", "beta"] } },
    };
  }

  it("writes the pool as ONE channel with a {file:} apiKey, absorbs members, and is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-write-"));
    try {
      const configPath = join(root, "opencode.json");
      const result = await writeOpencodeConfig(pooledStore(), 47821, root, configPath);
      assert.equal(result.ok, true);
      assert.equal(result.unchanged, false);

      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const ids = Object.keys(config.provider).sort();
      assert.deepEqual(ids, ["gamma", "pool-ab"], "pool members must not surface as their own channels");
      const pool = config.provider["pool-ab"];
      assert.equal(pool.name, "Pool AB");
      assert.equal(pool.options.baseURL, "http://127.0.0.1:47821/openai/pool-ab/v1");
      assert.equal(pool.options.apiKey, `{file:${root.replace(/\\/g, "/")}/pi-relay-token}`);
      assert.equal(pool.options.headers["x-agent-id"], "opencode");
      assert.equal(pool.options.headers["x-agent-instance"], "{env:ANYSWITCH_AGENT_INSTANCE}");
      assert.deepEqual(Object.keys(pool.models), ["model-1", "model-2"]);
      // The sandbox root has no effort db, so unknown text models get the
      // optimistic levels — the point here is that the variants path is wired.
      assert.ok(pool.models["model-1"].variants, "reasoning variants must be written when the effort switch is on");

      const again = await writeOpencodeConfig(pooledStore(), 47821, root, configPath);
      assert.equal(again.ok, true);
      assert.equal(again.unchanged, true, "a second sync with the same store must be a no-op");

      // Effort switch off: wholesale rebuild strips the variants again.
      const stripped = await writeOpencodeConfig(pooledStore(), 47821, root, configPath, undefined, false);
      assert.equal(stripped.unchanged, false);
      const off = JSON.parse(readFileSync(configPath, "utf8"));
      assert.equal(off.provider["pool-ab"].models["model-1"].variants, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports instead of writing when there are no providers with models", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-write-empty-"));
    try {
      const result = await writeOpencodeConfig({ version: 2, providers: {} }, 47821, root, join(root, "opencode.json"));
      assert.deepEqual(result, { ok: true, unchanged: true, reason: "no Anyswitch providers with models" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on an unparseable existing config", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-write-bad-"));
    try {
      const configPath = join(root, "opencode.json");
      const bad = "{ definitely not json";
      writeFileSync(configPath, bad, "utf8");
      const result = await writeOpencodeConfig(pooledStore(), 47821, root, configPath);
      assert.equal(result.ok, false);
      assert.equal(result.unchanged, true);
      assert.match(result.reason, /refusing to overwrite unparseable opencode config/);
      assert.equal(readFileSync(configPath, "utf8"), bad);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears the managed providers after the last channel is deleted", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-write-cleanup-"));
    try {
      const configPath = join(root, "opencode.json");
      const first = await writeOpencodeConfig(pooledStore(), 47821, root, configPath);
      assert.equal(first.ok, true);
      assert.equal(first.unchanged, false);
      const written = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(Object.keys(written.provider).sort(), ["gamma", "pool-ab"]);
      assert.deepEqual(readSidecar(root), { providers: ["gamma", "pool-ab"] });

      // 渠道删空：sidecar 记着上一轮托管过什么，所以这一轮不能早退——必须
      // 走完合并把 opencode.json 里的托管渠道删掉，否则脏模型列表永久残留。
      const emptied = await writeOpencodeConfig({ version: 2, providers: {} }, 47821, root, configPath);
      assert.equal(emptied.ok, true);
      assert.equal(emptied.unchanged, false, "the stale managed channels must be rewritten away, not skipped");
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(configPath, "utf8")).provider), []);
      assert.deepEqual(readSidecar(root), { providers: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("opencodeConfigPath lands under the injected USERPROFILE", () => {
    assert.equal(
      opencodeConfigPath({ USERPROFILE: "C:\\Users\\tester" }),
      "C:\\Users\\tester\\.config\\opencode\\opencode.json",
    );
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
