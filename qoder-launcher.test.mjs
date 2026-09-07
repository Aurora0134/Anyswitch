// Qoder launcher tests. Same injected-dependency pattern as dsh-launcher.test.mjs:
// ZERO real spawn, ZERO real relay, ZERO real credentials.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQoderLauncherEnv,
  resolveQoderExecutable,
  runQoderLauncher,
} from "./qoder-launcher.mjs";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
      spawnQoder: async ({ env, args }) => {
        qoderSpawned = true;
        capturedEnv = env;
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
