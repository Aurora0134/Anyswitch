// Qoder launcher tests. Same injected-dependency pattern as dsh-launcher.test.mjs:
// ZERO real spawn, ZERO real relay, ZERO real credentials.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQoderLauncherEnv,
  resolveQoderExecutable,
  runQoderLauncher,
  realSpawnQoder,
} from "./qoder-launcher.mjs";
import { QODER_CDP_PORT } from "./qoder-cdp-refresh.mjs";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

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
  let relayStarted = false;
  let relayClosed = false;
  let qoderSpawned = false;
  let capturedEnv = null;

  // Isolated data root so the reuse path's token derivation never touches the
  // real %LOCALAPPDATA%\Anyswitch.
  const sandboxRoot = mkdtempSync(join(tmpdir(), "qoder-relay-"));
  try {
    const code = await runQoderLauncher({
      startRelay: async () => {
        relayStarted = true;
        return { port: 47821, token: "fresh-token", close: async () => { relayClosed = true; } };
      },
      spawnQoder: async ({ env, args, onSpawned }) => {
        qoderSpawned = true;
        capturedEnv = env;
        // The launcher must hand every spawnQoder implementation an onSpawned
        // hook (drives the CDP model-catalog warm-up in realSpawnQoder).
        assert.equal(typeof onSpawned, "function");
        assert.deepEqual(args, ["--resume"]);
        return 0;
      },
      log: () => {},
      base: { LOCALAPPDATA: sandboxRoot, USERPROFILE: sandboxRoot },
      qoderArgs: ["--resume"],
      // Resident relay answering: no per-launch relay must be spawned.
      probeRelay: async () => true,
    });

    assert.equal(code, 0);
    assert.equal(qoderSpawned, true);
    assert.equal(relayStarted, false, "resident relay must be reused, not re-bound");
    assert.equal(relayClosed, false, "the reused resident relay must not be torn down");
    // Reuse path derives the token from the shared token file, so the env still
    // carries the relay token contract.
    assert.equal(typeof capturedEnv.ANYSWITCH_RELAY_TOKEN, "string");
    assert.ok(capturedEnv.ANYSWITCH_RELAY_TOKEN.length > 0);
    assert.equal(capturedEnv.NO_PROXY, "127.0.0.1,localhost");
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test("runQoderLauncher starts a per-launch relay when the resident one is down", async () => {
  let relayStarted = false;
  let relayClosed = false;
  let capturedToken = null;

  const code = await runQoderLauncher({
    startRelay: async () => {
      relayStarted = true;
      return { port: 47821, token: "per-launch-token", close: async () => { relayClosed = true; } };
    },
    spawnQoder: async ({ env }) => {
      capturedToken = env.ANYSWITCH_RELAY_TOKEN;
      return 7;
    },
    log: () => {},
    probeRelay: async () => false,
  });

  assert.equal(code, 7);
  assert.equal(relayStarted, true);
  assert.equal(capturedToken, "per-launch-token");
  assert.equal(relayClosed, true, "the per-launch relay dies with the client");
});

test("runQoderLauncher tears the relay down even when spawn fails", async () => {
  let relayClosed = false;
  await assert.rejects(
    () =>
      runQoderLauncher({
        startRelay: async () => ({ port: 47821, token: "tok", close: async () => { relayClosed = true; } }),
        spawnQoder: async () => {
          throw new Error("spawn failed");
        },
        log: () => {},
        probeRelay: async () => false,
      }),
    /spawn failed/,
  );
  assert.equal(relayClosed, true);
});

test("runQoderLauncher onSpawned fires without blocking the launch", async () => {
  // The launcher awaits spawnQoder (i.e. Qoder's exit code), so an onSpawned
  // hook that never settles must not stall the launch — and a throwing hook
  // must not fail it either (realSpawnQoder swallows hook errors).
  const code = await runQoderLauncher({
    startRelay: async () => ({ port: 47821, token: "tok", close: async () => {} }),
    spawnQoder: async ({ onSpawned }) => {
      assert.equal(typeof onSpawned, "function");
      onSpawned(); // fires the CDP warm-up; launched detached, never awaited
      onSpawned();
      return 0;
    },
    log: () => {},
    probeRelay: async () => false,
  });
  assert.equal(code, 0);
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
