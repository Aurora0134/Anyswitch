// Qoder launcher tests. Same injected-dependency pattern as dsh-launcher.test.mjs:
// ZERO real spawn, ZERO real relay, ZERO real credentials.
//
// runQoderLauncher touches the user's machine only through writeConfig,
// loadStore, loadToken and refreshCatalog, and none of those four have a
// default — so every launcher test injects a recorder and needs no temp HOME
// to keep ~/.qoder/settings.json out of reach.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  buildQoderLauncherEnv,
  resolveQoderExecutable,
  runQoderLauncher,
  realSpawnQoder,
  main,
  RELAY_PORT,
} from "./qoder-launcher.mjs";
import { QODER_CDP_PORT } from "./qoder-cdp-refresh.mjs";
import { getTokenPath } from "./pi-relay-token.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

// Opaque on purpose: writeConfig is mocked, so no test here depends on the
// real Anyswitch store schema.
const FAKE_STORE = { providers: { "fake-channel": { models: {} } } };

// Never created on disk. The launcher only hands these to the mocks, so a stray
// real implementation would fail on a nonexistent path rather than clobber the
// live settings.json.
const FAKE_HOME = join(tmpdir(), "anyswitch-qoder-test-home");
const FAKE_LOCAL = join(tmpdir(), "anyswitch-qoder-test-local");
const FAKE_BASE = { USERPROFILE: FAKE_HOME, LOCALAPPDATA: FAKE_LOCAL };

function recordingDeps(overrides = {}) {
  const calls = [];
  const logs = [];
  const deps = {
    calls,
    logs,
    log: (line) => logs.push(line),
    loadStore: () => ({ ok: true, store: FAKE_STORE }),
    loadToken: () => {
      calls.push("loadToken");
      return "resident-token";
    },
    writeConfig: async (store, port, token, sidecarRoot, settingsPath) => {
      calls.push("writeConfig");
      deps.written = { store, port, token, sidecarRoot, settingsPath };
      return { ok: true, unchanged: true };
    },
    refreshCatalog: async ({ port }) => {
      calls.push(`refreshCatalog:${port}`);
    },
    ...overrides,
  };
  return deps;
}

function relayReturning(deps, { token = "per-launch-token", exitCode = 0 } = {}) {
  return {
    startRelay: async () => {
      deps.calls.push("startRelay");
      return {
        port: RELAY_PORT,
        token,
        close: async () => { deps.calls.push("closeRelay"); },
      };
    },
    spawnQoder: async () => {
      deps.calls.push("spawnQoder");
      return exitCode;
    },
  };
}

test("buildQoderLauncherEnv injects ANYSWITCH_RELAY_TOKEN and NO_PROXY", () => {
  const env = buildQoderLauncherEnv({
    token: "test-secret-token",
    base: { PATH: "/usr/bin" },
  });
  assert.equal(env.ANYSWITCH_RELAY_TOKEN, "test-secret-token");
  assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(env.no_proxy, "127.0.0.1,localhost");
  assert.equal(env.PATH, "/usr/bin");
});

test("buildQoderLauncherEnv inherits Qoder-side endpoint overrides verbatim", () => {
  // Qoder's own endpoint env vars are the user's channel to redirect the CLI;
  // the launcher must pass them through untouched, never invent values.
  // Both documented vars (qoder-launcher.mjs header) ride in the base so the
  // passthrough assertions below can actually fail if either is dropped or
  // rewritten.
  const env = buildQoderLauncherEnv({
    token: "tok",
    base: {
      QODER_CLI_BIN: "C:\\tools\\qodercli.exe",
      QODER_BIG_MODEL_ENDPOINT: "https://example.invalid/v1",
      QODER_OPENAPI_ENDPOINT: "https://example.invalid/openapi",
    },
  });
  assert.equal(env.QODER_CLI_BIN, "C:\\tools\\qodercli.exe");
  assert.equal(env.QODER_BIG_MODEL_ENDPOINT, "https://example.invalid/v1");
  assert.equal(env.QODER_OPENAPI_ENDPOINT, "https://example.invalid/openapi");
  // And neither endpoint var may be invented when the caller omits it.
  const bare = buildQoderLauncherEnv({ token: "tok", base: { PATH: "/usr/bin" } });
  assert.equal("QODER_BIG_MODEL_ENDPOINT" in bare, false);
  assert.equal("QODER_OPENAPI_ENDPOINT" in bare, false);
});

test("resolveQoderExecutable accepts absolute override and rejects relative", () => {
  const explicit = resolveQoderExecutable({
    QODER_EXECUTABLE: "C:\\custom\\qodercli.exe",
  });
  assert.equal(explicit, "C:\\custom\\qodercli.exe");

  assert.throws(
    () => resolveQoderExecutable({ QODER_EXECUTABLE: "relative/qodercli" }),
    /must be an absolute path/,
  );
});

test("resolveQoderExecutable prefers the entry dispatcher, then the direct CLI", () => {
  const dir = mkTestDir("qoder-exe-");
  try {
    const home = join(dir, "home");
    // No entry dir, no bin dir: falls back to the direct CLI path.
    assert.equal(
      resolveQoderExecutable({ USERPROFILE: home }),
      join(home, ".qoder", "bin", "qodercli", "qodercli.exe"),
    );
    // entry/qoder.cmd present: the dispatcher wins.
    const entryDir = join(home, ".qoder", "entry");
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(join(entryDir, "qoder.cmd"), "@echo off\r\n");
    assert.equal(
      resolveQoderExecutable({ USERPROFILE: home }),
      join(entryDir, "qoder.cmd"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runQoderLauncher reuses the resident relay and passes the token through env", async () => {
  const deps = recordingDeps();
  let capturedEnv = null;

  const code = await runQoderLauncher({
    ...deps,
    ...relayReturning(deps),
    spawnQoder: async ({ env, args, onSpawned }) => {
      deps.calls.push("spawnQoder");
      capturedEnv = env;
      // The launcher must hand every spawnQoder implementation an onSpawned
      // hook (drives the CDP model-catalog warm-up in realSpawnQoder).
      assert.equal(typeof onSpawned, "function");
      assert.deepEqual(args, ["--resume"]);
      return 0;
    },
    base: FAKE_BASE,
    qoderArgs: ["--resume"],
    // Resident relay answering: no per-launch relay must be spawned.
    probeRelay: async () => true,
  });

  assert.equal(code, 0);
  assert.deepEqual(deps.calls, ["loadToken", "writeConfig", "spawnQoder"]);
  assert.equal(deps.calls.includes("startRelay"), false, "resident relay must be reused, not re-bound");
  assert.equal(deps.calls.includes("closeRelay"), false, "the reused resident relay must not be torn down");
  assert.equal(capturedEnv.ANYSWITCH_RELAY_TOKEN, "resident-token");
  assert.equal(capturedEnv.NO_PROXY, "127.0.0.1,localhost");
});

test("runQoderLauncher syncs BYOK config with the relay port, token and resolved paths", async () => {
  const deps = recordingDeps({
    writeConfig: async (store, port, token, sidecarRoot, settingsPath) => {
      deps.calls.push("writeConfig");
      deps.written = { store, port, token, sidecarRoot, settingsPath };
      // The real writeQoderConfig is synchronous; awaiting it must stay legal.
      return { ok: true, unchanged: false, backupPath: "settings.backup.test.json" };
    },
  });

  await runQoderLauncher({
    ...deps,
    ...relayReturning(deps),
    base: FAKE_BASE,
    probeRelay: async () => false,
  });

  assert.deepEqual(deps.written, {
    store: FAKE_STORE,
    port: RELAY_PORT,
    token: "per-launch-token",
    sidecarRoot: join(FAKE_LOCAL, "Anyswitch"),
    settingsPath: join(FAKE_HOME, ".qoder", "settings.json"),
  });
  // A changed sync is reported with its backup so the user can undo it.
  assert.ok(deps.logs.some((l) => l.includes("settings.json updated") && l.includes("settings.backup.test.json")));
});

test("runQoderLauncher starts a per-launch relay when the resident one is down", async () => {
  const deps = recordingDeps();
  let capturedToken = null;

  const code = await runQoderLauncher({
    ...deps,
    startRelay: async () => {
      deps.calls.push("startRelay");
      return { port: RELAY_PORT, token: "per-launch-token", close: async () => { deps.calls.push("closeRelay"); } };
    },
    spawnQoder: async ({ env }) => {
      deps.calls.push("spawnQoder");
      capturedToken = env.ANYSWITCH_RELAY_TOKEN;
      return 7;
    },
    base: FAKE_BASE,
    probeRelay: async () => false,
  });

  assert.equal(code, 7);
  assert.deepEqual(deps.calls, ["startRelay", "writeConfig", "spawnQoder", "closeRelay"]);
  assert.equal(capturedToken, "per-launch-token");
  assert.equal(deps.calls.includes("loadToken"), false, "per-launch path must not read the shared token file");
});

test("runQoderLauncher launches natively when both relay levels fail", async () => {
  const deps = recordingDeps({ probeRelay: async () => false });
  let capturedEnv = null;

  const code = await runQoderLauncher({
    ...deps,
    startRelay: async () => {
      deps.calls.push("startRelay");
      throw Object.assign(new Error("port 47821 is in use by another process"), { code: "RELAY_PORT_FOREIGN" });
    },
    spawnQoder: async ({ env, args, onSpawned }) => {
      deps.calls.push("spawnQoder");
      capturedEnv = env;
      // The onSpawned hook (CDP catalog warm-up) is not relay-specific and
      // stays wired in native mode.
      assert.equal(typeof onSpawned, "function");
      assert.deepEqual(args, ["--resume"]);
      return 7;
    },
    base: FAKE_BASE,
    qoderArgs: ["--resume"],
  });

  assert.equal(code, 7, "the child exit code passes through in native mode too");
  assert.deepEqual(deps.calls, ["startRelay", "loadToken", "writeConfig", "spawnQoder"]);
  // Native mode: no relay token, no NO_PROXY — the environment passes through
  // verbatim.
  assert.equal("ANYSWITCH_RELAY_TOKEN" in capturedEnv, false);
  assert.equal("NO_PROXY" in capturedEnv, false);
  // The BYOK sync still runs, against the well-known port with the shared
  // token file's token, so the managed providers revive with the resident relay.
  assert.deepEqual(deps.written, {
    store: FAKE_STORE,
    port: RELAY_PORT,
    token: "resident-token",
    sidecarRoot: join(FAKE_LOCAL, "Anyswitch"),
    settingsPath: join(FAKE_HOME, ".qoder", "settings.json"),
  });
  assert.equal(deps.calls.includes("closeRelay"), false, "native mode has no relay to tear down");
  assert.ok(deps.logs.some((l) => l.includes("Anyswitch relay unavailable") && l.includes("launching qoder with its native configuration")));
});

test("runQoderLauncher tears the relay down even when spawn fails", async () => {
  const deps = recordingDeps();

  await assert.rejects(
    () =>
      runQoderLauncher({
        ...deps,
        ...relayReturning(deps),
        spawnQoder: async () => { throw new Error("spawn failed"); },
        base: FAKE_BASE,
        probeRelay: async () => false,
      }),
    /spawn failed/,
  );

  assert.ok(deps.calls.includes("closeRelay"));
});

test("runQoderLauncher hands spawnQoder an onSpawned hook that never blocks the launch", async () => {
  // The launcher awaits spawnQoder (i.e. Qoder's exit code), so an onSpawned
  // hook whose warm-up never settles must not stall the launch — not even for
  // a spawnQoder implementation that awaits the hook's return. The warm-up
  // below stalls until the launch has already resolved: a hook that ever
  // starts awaiting refreshCatalog trips the failsafe race instead of
  // hanging the suite.
  const releases = [];
  const deps = recordingDeps({
    refreshCatalog: ({ port }) => {
      deps.calls.push(`refreshCatalog:${port}`);
      return new Promise((resolve) => releases.push(resolve));
    },
  });
  let failsafe = null;
  try {
    const code = await Promise.race([
      runQoderLauncher({
        ...deps,
        ...relayReturning(deps),
        spawnQoder: async ({ onSpawned }) => {
          assert.equal(typeof onSpawned, "function");
          // Even a conscientious spawnQoder that awaits the hook's return must
          // sail through: the launcher's hook hands back nothing that waits on
          // the warm-up.
          const warmup = onSpawned();
          if (warmup) await warmup;
          onSpawned();
          return 0;
        },
        base: FAKE_BASE,
        probeRelay: async () => false,
      }),
      new Promise((_, reject) => {
        failsafe = setTimeout(() => reject(new Error("the launch stalled on the unresolved catalog warm-up")), 2000);
      }),
    ]);

    assert.equal(code, 0);
    // Every spawn fired the warm-up against the CDP port while it was still
    // pending.
    assert.deepEqual(
      deps.calls.filter((c) => c.startsWith("refreshCatalog")),
      [`refreshCatalog:${QODER_CDP_PORT}`, `refreshCatalog:${QODER_CDP_PORT}`],
    );
  } finally {
    clearTimeout(failsafe);
    for (const release of releases) release();
  }
});

test("runQoderLauncher logs a failing catalog warm-up without failing the launch", async () => {
  const deps = recordingDeps({ refreshCatalog: async () => { throw new Error("cdp refused"); } });
  let hook = null;

  const code = await runQoderLauncher({
    ...deps,
    ...relayReturning(deps),
    spawnQoder: async ({ onSpawned }) => { hook = onSpawned; return 0; },
    base: FAKE_BASE,
    probeRelay: async () => false,
  });
  hook();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(code, 0);
  assert.ok(deps.logs.some((l) => l.includes("model catalog warm-up failed") && l.includes("cdp refused")));
});

test("runQoderLauncher skips the config write when the store is unusable", async () => {
  const deps = recordingDeps({ loadStore: () => ({ ok: false, reason: "store-absent" }) });

  const code = await runQoderLauncher({
    ...deps,
    ...relayReturning(deps),
    base: FAKE_BASE,
    probeRelay: async () => false,
  });

  assert.equal(code, 0);
  assert.deepEqual(deps.calls, ["startRelay", "spawnQoder", "closeRelay"]);
  assert.ok(deps.logs.some((l) => l.includes("Anyswitch store could not be read")));
});

test("runQoderLauncher reports a refused config write but still launches", async () => {
  const deps = recordingDeps({
    writeConfig: async () => ({ ok: false, reason: "settings.json would be invalid" }),
  });

  const code = await runQoderLauncher({
    ...deps,
    ...relayReturning(deps),
    base: FAKE_BASE,
    probeRelay: async () => false,
  });

  assert.equal(code, 0);
  assert.ok(deps.logs.some((l) => l.includes("settings.json not updated: settings.json would be invalid")));
});

test("runQoderLauncher never lets a throwing config sync fail the launch", async () => {
  const deps = recordingDeps({ writeConfig: async () => { throw new Error("disk on fire"); } });

  const code = await runQoderLauncher({
    ...deps,
    ...relayReturning(deps),
    base: FAKE_BASE,
    probeRelay: async () => false,
  });

  assert.equal(code, 0);
  assert.ok(deps.calls.includes("spawnQoder"));
  assert.ok(deps.calls.includes("closeRelay"));
  assert.ok(deps.logs.some((l) => l.includes("BYOK config sync failed") && l.includes("disk on fire")));
});

test("runQoderLauncher rejects a caller that omits writeConfig before any side effect", async () => {
  // Machine-touching deps are injected rather than called directly so that a
  // test which forgets one crashes here, instead of falling through to the real
  // qoder-merge-config writer and overwriting the user's
  // ~/.qoder/settings.json with a fake token.
  const deps = recordingDeps();
  const { writeConfig, ...withoutWriteConfig } = deps;

  await assert.rejects(
    () =>
      runQoderLauncher({
        ...withoutWriteConfig,
        ...relayReturning(deps),
        base: FAKE_BASE,
        probeRelay: async () => false,
      }),
    /runQoderLauncher requires writeConfig to be a function/,
  );

  assert.deepEqual(deps.calls, [], "the guard must run before the relay is touched");
});

test("main() threads argv through runQoderLauncher and returns the child exit code", async () => {
  // Every machine-touching dep is overridden, so main() runs its full wiring
  // without touching the real relay, the real settings.json or a real spawn.
  // (refreshCatalog's default wiring is intentionally not exercised here: the
  // real refresh polls a live CDP endpoint, and its hook-side contract — the
  // launcher handing spawnQoder a working hook — is pinned by the
  // runQoderLauncher tests below via injection.)
  const deps = recordingDeps();

  const code = await main(["--resume", "--user-flag"], {
    ...deps,
    ...relayReturning(deps),
    spawnQoder: async ({ env, args }) => {
      deps.calls.push("spawnQoder");
      deps.spawned = { env, args };
      return 7;
    },
    base: FAKE_BASE,
    probeRelay: async () => false,
  });

  assert.equal(code, 7, "main() returns the child's exit code");
  assert.deepEqual(deps.spawned.args, ["--resume", "--user-flag"], "argv must reach spawnQoder verbatim");
  assert.equal(deps.spawned.env.ANYSWITCH_RELAY_TOKEN, "per-launch-token");
  assert.deepEqual(deps.calls, ["startRelay", "writeConfig", "spawnQoder", "closeRelay"]);
});

test("main() wires the real shared-token reader as loadToken", async () => {
  // Resident-relay mode sources the child's token from loadToken, so main
  // must wire the real token-file reader. The assertion reads the file the
  // real reader creates under the fixture LOCALAPPDATA back: a dropped wiring
  // fails runQoderLauncher's dep guard, a stand-in reader cannot produce it.
  const dir = mkTestDir("qoder-main-token-");
  try {
    const base = { USERPROFILE: join(dir, "home"), LOCALAPPDATA: join(dir, "local") };
    const deps = recordingDeps();
    const { loadToken, ...depsButLoadToken } = deps;
    let capturedToken = null;

    const code = await main([], {
      ...depsButLoadToken,
      spawnQoder: async ({ env }) => {
        deps.calls.push("spawnQoder");
        capturedToken = env.ANYSWITCH_RELAY_TOKEN;
        return 0;
      },
      base,
      probeRelay: async () => true,
    });

    assert.equal(code, 0);
    // loadToken is main's real default here, so it is not recorded by the
    // recorder — the file read-back below is what proves it ran.
    assert.deepEqual(deps.calls, ["writeConfig", "spawnQoder"]);
    const tokenFile = readFileSync(getTokenPath(join(dir, "local", "Anyswitch")), "utf8").trim();
    assert.equal(capturedToken, tokenFile, "the child token must be the real token file's content under base.LOCALAPPDATA");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main() wires the real store reader as loadStore", async () => {
  // The real loadStore resolves its root from process.env.LOCALAPPDATA at
  // call time (store-io.mjs defaultRoot), so redirect the env at an empty
  // fixture root: the real reader must classify the store as absent and the
  // launch must degrade loudly. A dropped wiring fails the dep guard; a
  // stand-in reader that reports ok would reach writeConfig instead.
  const dir = mkTestDir("qoder-main-store-");
  const localRoot = join(dir, "local");
  const savedLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = localRoot;
  try {
    const deps = recordingDeps();
    const { loadStore, ...depsButLoadStore } = deps;

    const code = await main([], {
      ...depsButLoadStore,
      ...relayReturning(deps),
      base: { USERPROFILE: join(dir, "home"), LOCALAPPDATA: localRoot },
      probeRelay: async () => false,
    });

    assert.equal(code, 0);
    assert.deepEqual(deps.calls, ["startRelay", "spawnQoder", "closeRelay"], "no config write without a readable store");
    assert.ok(deps.logs.some((l) => l.includes("Anyswitch store could not be read")), "the real store reader must classify the absent fixture store");
  } finally {
    if (savedLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = savedLocal;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main() wires the real settings.json writer as writeConfig", async () => {
  // A text pin passes as long as the string "writeQoderConfig(" survives
  // anywhere in main(); this pin makes the real writer prove itself: the
  // managed connection must actually land in settings.json under
  // base.USERPROFILE carrying the relay port and token. A dropped wiring
  // fails the dep guard; a stand-in writer writes nothing.
  const dir = mkTestDir("qoder-main-write-");
  try {
    const base = { USERPROFILE: join(dir, "home"), LOCALAPPDATA: join(dir, "local") };
    const deps = recordingDeps({
      loadStore: () => ({
        ok: true,
        // Minimal visible-channel shape: one provider with one model is all
        // deriveVisibleChannels (pool-providers.mjs) needs to surface one
        // managed connection for the real writer.
        store: { providers: { "fake-channel": { models: { "fake-model": {} } } } },
      }),
    });
    const { writeConfig, ...depsButWriteConfig } = deps;

    const code = await main([], {
      ...depsButWriteConfig,
      ...relayReturning(deps),
      base,
      probeRelay: async () => false,
    });

    assert.equal(code, 0);
    const settings = JSON.parse(readFileSync(join(dir, "home", ".qoder", "settings.json"), "utf8"));
    const managed = Object.values(settings.providers ?? {}).filter((c) => c.apiKey === "per-launch-token");
    assert.equal(managed.length, 1, "the real writer must land exactly one managed connection carrying the relay token");
    assert.ok(
      managed[0].baseUrl.startsWith(`http://127.0.0.1:${RELAY_PORT}/`),
      `the connection must point at the relay port, got ${managed[0].baseUrl}`,
    );
    assert.deepEqual(managed[0].models.map((m) => m.model), ["fake-model"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("realSpawnQoder prepends the CDP debugging port and fires onSpawned", async () => {
  // Drive the real spawn path through a stand-in .cmd dispatcher (the same
  // COMSPEC /d /c branch production uses). The batch echoes every argument it
  // receives to a file so we can assert the CDP flag was injected ahead of the
  // caller's args. onSpawned must fire on "spawn", and the promise must resolve
  // with the child's exit code.
  const dir = mkTestDir("qoder-spawn-");
  try {
    const outFile = join(dir, "argv.txt");
    const cmdPath = join(dir, "qoder.cmd");
    // %* expands to every argument the dispatcher was invoked with.
    writeFileSync(cmdPath, `@echo off\r\n@echo %* > "${outFile}"\r\n@exit /b 0\r\n`);
    let spawned = false;
    const code = await realSpawnQoder({
      env: { ...process.env, QODER_EXECUTABLE: cmdPath },
      args: ["--resume", "--user-flag"],
      onSpawned: () => { spawned = true; },
    });
    assert.equal(code, 0);
    assert.equal(spawned, true, "onSpawned must fire once the child process spawns");
    const childArgs = readFileSync(outFile, "utf8").trim().split(/\s+/);
    assert.equal(QODER_CDP_PORT, 9223);
    assert.equal(childArgs[0], `--remote-debugging-port=${QODER_CDP_PORT}`);
    assert.deepEqual(childArgs.slice(1), ["--resume", "--user-flag"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("realSpawnQoder never lets a throwing onSpawned hook fail the launch", async () => {
  const dir = mkTestDir("qoder-spawn-");
  try {
    const cmdPath = join(dir, "qoder.cmd");
    writeFileSync(cmdPath, `@echo off\r\n@exit /b 0\r\n`);
    const code = await realSpawnQoder({
      env: { ...process.env, QODER_EXECUTABLE: cmdPath },
      args: [],
      onSpawned: () => { throw new Error("hook exploded"); },
    });
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
