// Codex launcher tests. Same injected-dependency pattern as qoder-launcher.test.mjs:
// ZERO real codex, ZERO real relay, ZERO real credentials.
//
// runCodexLauncher touches the user's machine only through writeConfig and
// loadStore, and neither has a default — so every launcher test injects a
// recorder and needs no temp HOME to keep ~/.codex/config.toml out of reach.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  buildCodexLauncherEnv,
  buildInstanceId,
  resolveCodexExecutable,
  runCodexLauncher,
  realSpawnCodex,
  RELAY_PORT,
} from "./codex-launcher.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

// Opaque on purpose: writeConfig is mocked, so no test here depends on the
// real Anyswitch store schema.
const FAKE_STORE = { providers: { "fake-channel": { models: {} } } };

// Never created on disk. The launcher only hands these to the mocks, so a stray
// real implementation would fail on a nonexistent path rather than clobber the
// live config.toml.
const FAKE_HOME = join(tmpdir(), "anyswitch-codex-test-home");
const FAKE_LOCAL = join(tmpdir(), "anyswitch-codex-test-local");
const FAKE_BASE = { USERPROFILE: FAKE_HOME, LOCALAPPDATA: FAKE_LOCAL };

function recordingDeps(overrides = {}) {
  const calls = [];
  const logs = [];
  const deps = {
    calls,
    logs,
    log: (line) => logs.push(line),
    loadStore: () => ({ ok: true, store: FAKE_STORE }),
    writeConfig: async (store, port, token, sidecarRoot, configPath) => {
      calls.push("writeConfig");
      deps.written = { store, port, token, sidecarRoot, configPath };
      return { ok: true, unchanged: true };
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
    spawnCodex: async () => {
      deps.calls.push("spawnCodex");
      return exitCode;
    },
  };
}

test("buildCodexLauncherEnv injects ANYSWITCH_INSTANCE_ID and NO_PROXY, never the token", () => {
  const env = buildCodexLauncherEnv({
    instanceId: "ws-1",
    base: { PATH: "/usr/bin" },
  });
  assert.equal(env.ANYSWITCH_INSTANCE_ID, "ws-1");
  assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(env.no_proxy, "127.0.0.1,localhost");
  assert.equal(env.PATH, "/usr/bin");
  // The token only ever lives as a literal Authorization header inside the
  // managed config block — it must never ride the spawned environment (the
  // desktop GUI could not see it there anyway).
  assert.equal("ANYSWITCH_RELAY_TOKEN" in env, false);
});

test("buildCodexLauncherEnv generates an instance id when none is passed", () => {
  const env = buildCodexLauncherEnv({ base: {} });
  assert.match(env.ANYSWITCH_INSTANCE_ID, /^[A-Za-z0-9._:-]{1,64}$/);
});

test("buildInstanceId follows the shared '<cwd basename>-<pid>' scheme", () => {
  assert.equal(buildInstanceId({ cwd: "/home/me/my-proj", pid: 123 }), "my-proj-123");
  assert.equal(buildInstanceId({ cwd: "/home/me/my proj! (2)", pid: 7 }), "my-proj---2--7");
  assert.equal(buildInstanceId({ cwd: "", pid: 42 }), "codex-42");
  const id = buildInstanceId({ cwd: `/home/me/${"a".repeat(100)}`, pid: 9 });
  assert.equal(id.length, 64);
  assert.match(id, /^[A-Za-z0-9._:-]+$/);
});

test("resolveCodexExecutable accepts absolute override and rejects relative", () => {
  const explicit = resolveCodexExecutable({
    CODEX_EXECUTABLE: "C:\\custom\\codex.exe",
  });
  assert.equal(explicit, "C:\\custom\\codex.exe");

  assert.throws(
    () => resolveCodexExecutable({ CODEX_EXECUTABLE: "codex" }),
    /must be an absolute path/,
  );
});

test("resolveCodexExecutable glob-discovers codex.exe under the hash dir", () => {
  const dir = mkTestDir("codex-exe-");
  try {
    const local = join(dir, "local");
    // The hash directory name must not be hardcoded: any subdirectory of bin/
    // containing codex.exe is a candidate.
    const hashDir = join(local, "OpenAI", "Codex", "bin", "deadbeeff00dbabe");
    mkdirSync(hashDir, { recursive: true });
    writeFileSync(join(hashDir, "codex.exe"), "MZ");
    // A sibling hash dir without codex.exe (upgrade leftover) is ignored.
    const staleDir = join(local, "OpenAI", "Codex", "bin", "olderhash");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "rg.exe"), "MZ");

    assert.equal(
      resolveCodexExecutable({ LOCALAPPDATA: local }),
      join(hashDir, "codex.exe"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCodexExecutable picks the newest codex.exe when several hash dirs linger", () => {
  const dir = mkTestDir("codex-exe-");
  try {
    const local = join(dir, "local");
    const binRoot = join(local, "OpenAI", "Codex", "bin");
    const oldExe = join(binRoot, "aaaahash", "codex.exe");
    const newExe = join(binRoot, "zzzzhash", "codex.exe");
    mkdirSync(join(binRoot, "aaaahash"), { recursive: true });
    mkdirSync(join(binRoot, "zzzzhash"), { recursive: true });
    writeFileSync(oldExe, "MZ");
    writeFileSync(newExe, "MZ");
    utimesSync(oldExe, new Date("2026-01-01"), new Date("2026-01-01"));
    utimesSync(newExe, new Date("2026-09-01"), new Date("2026-09-01"));

    assert.equal(resolveCodexExecutable({ LOCALAPPDATA: local }), newExe);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCodexExecutable throws a clear error when no codex.exe is installed", () => {
  const dir = mkTestDir("codex-exe-");
  try {
    assert.throws(
      () => resolveCodexExecutable({ LOCALAPPDATA: join(dir, "local") }),
      /no codex\.exe found under/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCodexLauncher starts relay, writes config, spawns codex, closes relay", async () => {
  const deps = recordingDeps();
  let capturedEnv = null;

  const code = await runCodexLauncher({
    ...deps,
    ...relayReturning(deps),
    spawnCodex: async ({ env, args }) => {
      deps.calls.push("spawnCodex");
      capturedEnv = env;
      assert.deepEqual(args, ["exec", "--json"]);
      return 0;
    },
    base: FAKE_BASE,
    codexArgs: ["exec", "--json"],
  });

  assert.equal(code, 0);
  assert.deepEqual(deps.calls, ["startRelay", "writeConfig", "spawnCodex", "closeRelay"]);
  assert.match(capturedEnv.ANYSWITCH_INSTANCE_ID, /^[A-Za-z0-9._:-]{1,64}$/);
  // The shared scheme is "<cwd basename>-<launcher pid>"; this process IS the
  // launcher here, so the id ends with our own pid.
  assert.ok(capturedEnv.ANYSWITCH_INSTANCE_ID.endsWith(`-${process.pid}`));
  assert.equal(capturedEnv.NO_PROXY, "127.0.0.1,localhost");
  assert.equal("ANYSWITCH_RELAY_TOKEN" in capturedEnv, false, "token must not leak into the child env");
});

test("runCodexLauncher syncs config.toml with the relay port, token and resolved paths", async () => {
  const deps = recordingDeps({
    writeConfig: async (store, port, token, sidecarRoot, configPath) => {
      deps.calls.push("writeConfig");
      deps.written = { store, port, token, sidecarRoot, configPath };
      return { ok: true, unchanged: false, backupPath: "config.toml.backup.1" };
    },
  });

  await runCodexLauncher({
    ...deps,
    ...relayReturning(deps),
    base: FAKE_BASE,
  });

  assert.deepEqual(deps.written, {
    store: FAKE_STORE,
    port: RELAY_PORT,
    token: "per-launch-token",
    sidecarRoot: join(FAKE_LOCAL, "Anyswitch"),
    configPath: join(FAKE_HOME, ".codex", "config.toml"),
  });
  // A changed sync is reported with its backup so the user can undo it.
  assert.ok(deps.logs.some((l) => l.includes("config.toml updated") && l.includes("config.toml.backup.1")));
});

test("runCodexLauncher passes the child exit code through", async () => {
  const deps = recordingDeps();

  const code = await runCodexLauncher({
    ...deps,
    ...relayReturning(deps, { exitCode: 7 }),
    base: FAKE_BASE,
  });

  assert.equal(code, 7);
});

test("runCodexLauncher tears the relay down even when spawn fails", async () => {
  const deps = recordingDeps();

  await assert.rejects(
    () =>
      runCodexLauncher({
        ...deps,
        ...relayReturning(deps),
        spawnCodex: async () => { throw new Error("spawn failed"); },
        base: FAKE_BASE,
      }),
    /spawn failed/,
  );

  assert.ok(deps.calls.includes("closeRelay"));
});

test("runCodexLauncher skips the config write when the store is unusable", async () => {
  const deps = recordingDeps({ loadStore: () => ({ ok: false, reason: "store-absent" }) });

  const code = await runCodexLauncher({
    ...deps,
    ...relayReturning(deps),
    base: FAKE_BASE,
  });

  assert.equal(code, 0);
  assert.deepEqual(deps.calls, ["startRelay", "spawnCodex", "closeRelay"]);
  assert.ok(deps.logs.some((l) => l.includes("Anyswitch store could not be read")));
});

test("runCodexLauncher reports a refused config write but still launches", async () => {
  const deps = recordingDeps({
    writeConfig: async () => ({ ok: false, reason: "config.toml would be invalid" }),
  });

  const code = await runCodexLauncher({
    ...deps,
    ...relayReturning(deps),
    base: FAKE_BASE,
  });

  assert.equal(code, 0);
  assert.ok(deps.logs.some((l) => l.includes("config.toml not updated: config.toml would be invalid")));
});

test("runCodexLauncher never lets a throwing config sync fail the launch", async () => {
  const deps = recordingDeps({ writeConfig: async () => { throw new Error("disk on fire"); } });

  const code = await runCodexLauncher({
    ...deps,
    ...relayReturning(deps),
    base: FAKE_BASE,
  });

  assert.equal(code, 0);
  assert.ok(deps.calls.includes("spawnCodex"));
  assert.ok(deps.calls.includes("closeRelay"));
  assert.ok(deps.logs.some((l) => l.includes("codex config sync failed") && l.includes("disk on fire")));
});

test("runCodexLauncher rejects a caller that omits writeConfig before any side effect", async () => {
  // This is the whole point of injecting the machine-touching deps instead of
  // calling them directly: an isolated test that forgets one must crash here,
  // not fall through to the real codex-merge-config writer and overwrite the
  // user's ~/.codex/config.toml.
  const deps = recordingDeps();
  const { writeConfig, ...withoutWriteConfig } = deps;

  await assert.rejects(
    () =>
      runCodexLauncher({
        ...withoutWriteConfig,
        ...relayReturning(deps),
        base: FAKE_BASE,
      }),
    /runCodexLauncher requires writeConfig to be a function/,
  );

  assert.deepEqual(deps.calls, [], "the guard must run before the relay is touched");
});

test("main() wires every machine-touching dep to its real implementation", async () => {
  // No defaults means main() is the only place the real writers get through —
  // if a wiring line is dropped the launcher stops syncing config.toml loudly,
  // so pin the wiring here rather than letting it rot silently.
  const source = readFileSync(fileURLToPath(new URL("./codex-launcher.mjs", import.meta.url)), "utf8");
  const body = source.slice(source.indexOf("export async function main"));
  assert.ok(body.length > 0, "main() must stay in codex-launcher.mjs");
  assert.match(body, /await import\("\.\/codex-merge-config\.mjs"\)/);
  assert.match(body, /writeConfig: \([\s\S]{0,120}writeCodexConfig\(/);
  assert.match(body, /loadStore[,\s]/);
  assert.match(body, /spawnCodex: realSpawnCodex/);
});

test("realSpawnCodex passes the caller's args through the dispatcher", async () => {
  // Drive the real spawn path through a stand-in .cmd dispatcher (the same
  // COMSPEC /d /c branch production uses for .cmd overrides). The batch echoes
  // every argument it receives to a file so we can assert passthrough, and the
  // promise must resolve with the child's exit code.
  const dir = mkTestDir("codex-spawn-");
  try {
    const outFile = join(dir, "argv.txt");
    const cmdPath = join(dir, "codex.cmd");
    // %* expands to every argument the dispatcher was invoked with.
    writeFileSync(cmdPath, `@echo off\r\n@echo %* > "${outFile}"\r\n@exit /b 0\r\n`);
    const code = await realSpawnCodex({
      env: { ...process.env, CODEX_EXECUTABLE: cmdPath },
      args: ["exec", "--json"],
    });
    assert.equal(code, 0);
    const childArgs = readFileSync(outFile, "utf8").trim().split(/\s+/);
    assert.deepEqual(childArgs, ["exec", "--json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
