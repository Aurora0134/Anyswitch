// Grok launcher tests. Same injected-dependency pattern as codex-launcher.test.mjs
// and dsh-launcher.test.mjs: ZERO real grok, ZERO real relay, ZERO real
// credentials, ZERO writes under the live ~/.grok or the Anyswitch data dir.
//
// runGrokLauncher touches the user's machine only through writeConfig,
// loadStore, loadToken and createTracker, and none of them has a default — so
// every launcher test injects a recorder and needs no real temp HOME to keep
// ~/.grok/config.toml out of reach.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  buildGrokLauncherEnv,
  buildInstanceId,
  grokConfigPath,
  resolveGrokExecutable,
  runGrokLauncher,
  realSpawnGrok,
  RELAY_PORT,
} from "./grok-launcher.mjs";
import { sanitizeInstanceId } from "./agent-metrics.mjs";

// Opaque on purpose: writeConfig is mocked, so no test here depends on the
// real Anyswitch store schema.
const FAKE_STORE = { providers: { "fake-channel": { models: {} } } };

// Never created on disk. The launcher only hands these to the mocks, so a stray
// real implementation would fail on a nonexistent path rather than clobber the
// live config.toml.
const FAKE_HOME = join(tmpdir(), "anyswitch-grok-test-home");
const FAKE_LOCAL = join(tmpdir(), "anyswitch-grok-test-local");
const FAKE_BASE = { USERPROFILE: FAKE_HOME, LOCALAPPDATA: FAKE_LOCAL };

function recordingDeps(overrides = {}) {
  const calls = [];
  const logs = [];
  const deps = {
    calls,
    logs,
    log: (line) => logs.push(line),
    base: FAKE_BASE,
    probeRelay: async () => false,
    loadStore: () => ({ ok: true, store: FAKE_STORE }),
    loadToken: () => "shared-resident-token",
    writeConfig: async (store, port, token, sidecarRoot, configPath) => {
      calls.push("writeConfig");
      deps.written = { store, port, token, sidecarRoot, configPath };
      return { ok: true, unchanged: true };
    },
    createTracker: ({ token }) => {
      calls.push("createTracker");
      deps.trackerToken = token;
      const tracker = { pids: [], endCount: 0 };
      deps.tracker = tracker;
      return {
        setClaudePid: (pid) => tracker.pids.push(pid),
        reportEnd: () => {
          tracker.endCount += 1;
          calls.push("reportEnd");
        },
      };
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
    spawnGrok: async ({ env, args, onPid }) => {
      deps.calls.push("spawnGrok");
      deps.spawned = { env, args };
      onPid?.(4321);
      return exitCode;
    },
  };
}

test("buildGrokLauncherEnv injects ANYSWITCH_INSTANCE_ID and NO_PROXY, never the token", () => {
  const env = buildGrokLauncherEnv({
    instanceId: "ws-1",
    base: { PATH: "/usr/bin", GROK_HOME: "C:\\grok-home" },
  });
  assert.equal(env.ANYSWITCH_INSTANCE_ID, "ws-1");
  assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(env.no_proxy, "127.0.0.1,localhost");
  assert.equal(env.PATH, "/usr/bin");
  // GROK_HOME only moves grok's config/state root — it must survive untouched.
  assert.equal(env.GROK_HOME, "C:\\grok-home");
  // The token only ever lives as the literal api_key inside the managed tables
  // — it must never ride the spawned environment.
  assert.equal("ANYSWITCH_RELAY_TOKEN" in env, false);
});

test("buildGrokLauncherEnv strips the real xAI keys so grok cannot bypass the relay", () => {
  const env = buildGrokLauncherEnv({
    instanceId: "ws-1",
    base: {
      XAI_API_KEY: "xai-real-key",
      GROK_CODE_XAI_API_KEY: "grok-code-real-key",
      PATH: "/usr/bin",
    },
  });
  assert.equal("XAI_API_KEY" in env, false);
  assert.equal("GROK_CODE_XAI_API_KEY" in env, false);
  assert.equal(env.PATH, "/usr/bin");
});

test("buildGrokLauncherEnv generates an instance id when none is passed", () => {
  const env = buildGrokLauncherEnv({ base: {} });
  assert.match(env.ANYSWITCH_INSTANCE_ID, /^[A-Za-z0-9._:-]{1,64}$/);
  assert.equal(sanitizeInstanceId(env.ANYSWITCH_INSTANCE_ID), env.ANYSWITCH_INSTANCE_ID);
});

test("buildInstanceId follows the shared '<cwd basename>-<pid>' scheme", () => {
  assert.equal(buildInstanceId({ cwd: "/home/me/my-proj", pid: 123 }), "my-proj-123");
  assert.equal(buildInstanceId({ cwd: "/home/me/my proj! (2)", pid: 7 }), "my-proj---2--7");
  assert.equal(buildInstanceId({ cwd: "", pid: 42 }), "grok-42");
  const id = buildInstanceId({ cwd: `/home/me/${"a".repeat(100)}`, pid: 9 });
  assert.equal(id.length, 64);
  assert.match(id, /^[A-Za-z0-9._:-]+$/);
});

test("resolveGrokExecutable accepts an absolute .exe override and rejects other forms", () => {
  assert.equal(
    resolveGrokExecutable({ GROK_EXECUTABLE: "C:\\custom\\grok.exe" }),
    "C:\\custom\\grok.exe",
  );
  // A bare name or relative path could resolve back to the shim → recursion.
  assert.throws(() => resolveGrokExecutable({ GROK_EXECUTABLE: "grok" }), /must be an absolute path/);
  // The managed install is a native binary; a .cmd/.ps1 target is refused too.
  assert.throws(
    () => resolveGrokExecutable({ GROK_EXECUTABLE: "C:\\custom\\grok.cmd" }),
    /must point at a \.exe/,
  );
});

test("resolveGrokExecutable defaults to the Grok Build install under ~/.grok/bin", () => {
  assert.equal(
    resolveGrokExecutable({ USERPROFILE: "C:\\Users\\tester" }),
    join("C:\\Users\\tester", ".grok", "bin", "grok.exe"),
  );
});

test("grokConfigPath resolves under ~/.grok/config.toml", () => {
  assert.equal(grokConfigPath(FAKE_BASE), join(FAKE_HOME, ".grok", "config.toml"));
});

test("runGrokLauncher starts relay, writes config, spawns grok, reports session end, closes relay", async () => {
  const deps = recordingDeps();

  const code = await runGrokLauncher({
    ...deps,
    ...relayReturning(deps),
    grokArgs: ["--resume", "sess-1"],
  });

  assert.equal(code, 0);
  assert.deepEqual(deps.calls, ["startRelay", "createTracker", "writeConfig", "spawnGrok", "reportEnd", "closeRelay"]);
  assert.deepEqual(deps.spawned.args, ["--resume", "sess-1"]);
  assert.match(deps.spawned.env.ANYSWITCH_INSTANCE_ID, /^[A-Za-z0-9._:-]{1,64}$/);
  // The shared scheme is "<cwd basename>-<launcher pid>"; this process IS the
  // launcher here, so the id ends with our own pid.
  assert.ok(deps.spawned.env.ANYSWITCH_INSTANCE_ID.endsWith(`-${process.pid}`));
  assert.equal(deps.spawned.env.NO_PROXY, "127.0.0.1,localhost");
  assert.equal("ANYSWITCH_RELAY_TOKEN" in deps.spawned.env, false, "token must not leak into the child env");
  // The child pid is bound on the tracker while grok runs; ended fires before
  // the relay is torn down.
  assert.deepEqual(deps.tracker.pids, [4321]);
  assert.equal(deps.tracker.endCount, 1);
});

test("runGrokLauncher passes the child exit code through", async () => {
  const deps = recordingDeps();

  const code = await runGrokLauncher({
    ...deps,
    ...relayReturning(deps, { exitCode: 7 }),
  });

  assert.equal(code, 7);
});

test("runGrokLauncher reuses the resident relay and skips spawning a new one", async () => {
  const deps = recordingDeps({ probeRelay: async () => true });

  const code = await runGrokLauncher({
    ...deps,
    ...relayReturning(deps),
  });

  assert.equal(code, 0);
  assert.equal(deps.calls.includes("startRelay"), false, "resident probe success must not start a relay");
  assert.equal(deps.calls.includes("closeRelay"), false, "a reused resident relay is never torn down");
  // The shared relay token file supplies the token used both for the managed
  // api_key and the session-report correlation.
  assert.equal(deps.trackerToken, "shared-resident-token");
  assert.deepEqual(deps.written, {
    store: FAKE_STORE,
    port: RELAY_PORT,
    token: "shared-resident-token",
    sidecarRoot: join(FAKE_LOCAL, "Anyswitch"),
    configPath: join(FAKE_HOME, ".grok", "config.toml"),
  });
  assert.ok(deps.logs.some((l) => l.includes(`resident relay already running on ${RELAY_PORT}`)));
});

test("runGrokLauncher falls back to a per-launch relay when the probe throws", async () => {
  const deps = recordingDeps({
    probeRelay: async () => { throw new Error("connect ECONNREFUSED"); },
  });

  const code = await runGrokLauncher({
    ...deps,
    ...relayReturning(deps, { token: "fallback-token" }),
  });

  assert.equal(code, 0);
  assert.equal(deps.calls.includes("startRelay"), true);
  assert.equal(deps.calls.includes("closeRelay"), true, "the fallback relay dies with the launch");
  assert.equal(deps.trackerToken, "fallback-token");
  assert.ok(deps.logs.some((l) => l.includes("probe failed") && l.includes("falling back to per-launch relay")));
});

test("runGrokLauncher syncs config.toml with the relay port, token and resolved paths", async () => {
  const deps = recordingDeps({
    writeConfig: async (store, port, token, sidecarRoot, configPath) => {
      deps.calls.push("writeConfig");
      deps.written = { store, port, token, sidecarRoot, configPath };
      return { ok: true, unchanged: false, backupPath: "config.backup.1.toml" };
    },
  });

  await runGrokLauncher({
    ...deps,
    ...relayReturning(deps, { token: "per-launch-token" }),
  });

  assert.deepEqual(deps.written, {
    store: FAKE_STORE,
    port: RELAY_PORT,
    token: "per-launch-token",
    sidecarRoot: join(FAKE_LOCAL, "Anyswitch"),
    configPath: join(FAKE_HOME, ".grok", "config.toml"),
  });
  // A changed sync is reported with its backup so the user can undo it.
  assert.ok(deps.logs.some((l) => l.includes("config.toml updated") && l.includes("config.backup.1.toml")));
});

test("runGrokLauncher reports a refused config write but still launches", async () => {
  const deps = recordingDeps({
    writeConfig: async () => ({ ok: false, reason: "config.toml would be invalid" }),
  });

  const code = await runGrokLauncher({
    ...deps,
    ...relayReturning(deps),
  });

  assert.equal(code, 0);
  assert.equal(deps.calls.includes("spawnGrok"), true);
  assert.ok(deps.logs.some((l) => l.includes("config.toml not updated: config.toml would be invalid")));
});

test("runGrokLauncher never lets a throwing config sync fail the launch", async () => {
  const deps = recordingDeps({
    writeConfig: async () => { throw new Error("disk on fire"); },
  });

  const code = await runGrokLauncher({
    ...deps,
    ...relayReturning(deps),
  });

  assert.equal(code, 0);
  assert.equal(deps.calls.includes("spawnGrok"), true);
  assert.equal(deps.calls.includes("closeRelay"), true);
  assert.ok(deps.logs.some((l) => l.includes("grok config sync failed") && l.includes("disk on fire")));
});

test("runGrokLauncher skips the config write when the store is unusable", async () => {
  const deps = recordingDeps({ loadStore: () => ({ ok: false, reason: "store-absent" }) });

  const code = await runGrokLauncher({
    ...deps,
    ...relayReturning(deps),
  });

  assert.equal(code, 0);
  assert.equal(deps.calls.includes("writeConfig"), false);
  assert.equal(deps.calls.includes("spawnGrok"), true);
  assert.ok(deps.logs.some((l) => l.includes("Anyswitch store could not be read")));
});

test("runGrokLauncher reports session end and closes the relay even when spawn fails", async () => {
  const deps = recordingDeps();

  await assert.rejects(
    () =>
      runGrokLauncher({
        ...deps,
        ...relayReturning(deps),
        spawnGrok: async () => { throw new Error("spawn failed"); },
      }),
    /spawn failed/,
  );

  assert.equal(deps.tracker.endCount, 1, "session end is reported before the relay is torn down");
  assert.equal(deps.calls.includes("closeRelay"), true);
});

test("runGrokLauncher rejects a caller that omits a machine-touching dep before any side effect", async () => {
  // This is the whole point of injecting the machine-touching deps instead of
  // calling them directly: an isolated test that forgets one must crash here,
  // not fall through to the real grok-merge-config writer and overwrite the
  // user's ~/.grok/config.toml.
  for (const name of ["writeConfig", "loadStore", "loadToken", "createTracker"]) {
    const deps = recordingDeps();
    const without = { ...deps };
    delete without[name];

    await assert.rejects(
      () => runGrokLauncher({ ...without, ...relayReturning(deps) }),
      new RegExp(`runGrokLauncher requires ${name} to be a function`),
    );
    assert.deepEqual(deps.calls, [], `the guard for ${name} must run before the relay is touched`);
  }
});

test("main() wires every machine-touching dep to its real implementation", async () => {
  // No defaults means main() is the only place the real writers get through —
  // if a wiring line is dropped the launcher stops syncing config.toml loudly,
  // so pin the wiring here rather than letting it rot silently.
  const source = readFileSync(fileURLToPath(new URL("./grok-launcher.mjs", import.meta.url)), "utf8");
  const body = source.slice(source.indexOf("export async function main"));
  assert.ok(body.length > 0, "main() must stay in grok-launcher.mjs");
  assert.match(body, /writeConfig: \([\s\S]{0,160}writeGrokConfig\(/);
  assert.match(body, /loadToken: \([\s\S]{0,80}loadOrGenerateToken\(/);
  assert.match(body, /createTracker: \([\s\S]{0,400}createSessionReporter\(/);
  assert.match(body, /agentId: "grok"/);
  assert.match(body, /spawnGrok: realSpawnGrok/);
  assert.match(body, /probeRelay: probeRelay/);
});

test("realSpawnGrok passes the caller's args through and reports the child pid", async () => {
  // Drive the real spawn path with node.exe standing in for grok.exe (the
  // override must be a .exe, so npm's .cmd shims are unusable as stand-ins).
  // The script echoes its own argv to a file so we can assert passthrough, and
  // the promise must resolve with the child's exit code.
  const dir = mkdtempSync(join(tmpdir(), "grok-spawn-"));
  try {
    const outFile = join(dir, "argv.json");
    const script = "require('node:fs').writeFileSync(process.env.GROK_SPAWN_OUT, JSON.stringify(process.argv))";
    const pids = [];
    const code = await realSpawnGrok({
      env: { ...process.env, GROK_EXECUTABLE: process.execPath, GROK_SPAWN_OUT: outFile },
      args: ["-e", script, "exec", "--json"],
      onPid: (pid) => pids.push(pid),
    });
    assert.equal(code, 0);
    const argv = JSON.parse(readFileSync(outFile, "utf8"));
    // Node's -e argv layout is not the point: the last two entries must be the
    // caller's args, in order, verbatim.
    assert.deepEqual(argv.slice(-2), ["exec", "--json"]);
    assert.equal(pids.length, 1);
    assert.ok(Number.isInteger(pids[0]) && pids[0] > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
