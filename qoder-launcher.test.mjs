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
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  buildQoderLauncherEnv,
  resolveQoderExecutable,
  runQoderLauncher,
  realSpawnQoder,
  RELAY_PORT,
} from "./qoder-launcher.mjs";
import { QODER_CDP_PORT } from "./qoder-cdp-refresh.mjs";

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
  const env = buildQoderLauncherEnv({
    token: "tok",
    base: { QODER_CLI_BIN: "C:\\tools\\qodercli.exe", QODER_BIG_MODEL_ENDPOINT: "https://example.invalid/v1" },
  });
  assert.equal(env.QODER_CLI_BIN, "C:\\tools\\qodercli.exe");
  assert.equal(env.QODER_BIG_MODEL_ENDPOINT, "https://example.invalid/v1");
  assert.equal("QODER_OPENAPI_ENDPOINT" in env, false);
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
  const dir = mkdtempSync(join(tmpdir(), "qoder-exe-"));
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
  // hook whose warm-up never settles must not stall the launch.
  const deps = recordingDeps();

  const code = await runQoderLauncher({
    ...deps,
    ...relayReturning(deps),
    spawnQoder: async ({ onSpawned }) => {
      assert.equal(typeof onSpawned, "function");
      onSpawned();
      onSpawned();
      return 0;
    },
    base: FAKE_BASE,
    probeRelay: async () => false,
  });

  assert.equal(code, 0);
  assert.deepEqual(
    deps.calls.filter((c) => c.startsWith("refreshCatalog")),
    [`refreshCatalog:${QODER_CDP_PORT}`, `refreshCatalog:${QODER_CDP_PORT}`],
  );
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
  // This is the whole point of injecting the machine-touching deps instead of
  // calling them directly: an isolated test that forgets one must crash here,
  // not fall through to the real qoder-merge-config writer and overwrite the
  // user's ~/.qoder/settings.json with a fake token (happened 2026-09-09).
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

test("main() wires every machine-touching dep to its real implementation", async () => {
  // No defaults means main() is the only place the real writers get through —
  // if a wiring line is dropped the desktop launcher stops syncing BYOK loudly,
  // so pin the wiring here rather than letting it rot silently.
  const source = readFileSync(fileURLToPath(new URL("./qoder-launcher.mjs", import.meta.url)), "utf8");
  const body = source.slice(source.indexOf("export async function main"));
  assert.ok(body.length > 0, "main() must stay in qoder-launcher.mjs");
  assert.match(body, /writeConfig: \([\s\S]{0,120}writeQoderConfig\(/);
  assert.match(body, /loadStore[,\s]/);
  assert.match(body, /loadToken: \([\s\S]{0,60}loadOrGenerateToken\(/);
  assert.match(body, /refreshCatalog: \([\s\S]{0,60}refreshQoderModelCatalog\(/);
});

test("realSpawnQoder prepends the CDP debugging port and fires onSpawned", async () => {
  // Drive the real spawn path through a stand-in .cmd dispatcher (the same
  // COMSPEC /d /c branch production uses). The batch echoes every argument it
  // receives to a file so we can assert the CDP flag was injected ahead of the
  // caller's args. onSpawned must fire on "spawn", and the promise must resolve
  // with the child's exit code.
  const dir = mkdtempSync(join(tmpdir(), "qoder-spawn-"));
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
  const dir = mkdtempSync(join(tmpdir(), "qoder-spawn-"));
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
