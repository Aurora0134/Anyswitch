import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDshLauncherEnv,
  resolveDshExecutable,
  runDshLauncher,
} from "./dsh-launcher.mjs";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

test("buildDshLauncherEnv injects ANYSWITCH_RELAY_TOKEN and NO_PROXY", () => {
  const env = buildDshLauncherEnv({
    port: 47821,
    token: "test-secret-token",
    base: { PATH: "/usr/bin" },
  });
  assert.equal(env.ANYSWITCH_RELAY_TOKEN, "test-secret-token");
  assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(env.PATH, "/usr/bin");
});

test("resolveDshExecutable accepts absolute path and rejects relative override", () => {
  const explicit = resolveDshExecutable({
    DSH_EXECUTABLE: "C:\\custom\\dsh.exe",
  });
  assert.equal(explicit, "C:\\custom\\dsh.exe");

  assert.throws(
    () => resolveDshExecutable({ DSH_EXECUTABLE: "relative/dsh" }),
    /must be an absolute path/,
  );
});

test("resolveDshExecutable never returns the unspawnable .ps1 shim", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-exe-"));
  try {
    const roamingNpm = join(dir, "npm");
    mkdirSync(roamingNpm, { recursive: true });

    // Only dsh.ps1 present: realSpawnDsh spawns non-.cmd paths directly,
    // and Windows cannot execute a .ps1 that way, so the resolver must fall
    // through to the extensionless shim instead of returning the .ps1.
    writeFileSync(join(roamingNpm, "dsh.ps1"), "# npm pwsh shim\n");
    assert.equal(resolveDshExecutable({ APPDATA: dir }), join(roamingNpm, "dsh"));

    // dsh.cmd wins when present.
    writeFileSync(join(roamingNpm, "dsh.cmd"), "@echo off\r\n");
    assert.equal(resolveDshExecutable({ APPDATA: dir }), join(roamingNpm, "dsh.cmd"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDshLauncher reuses resident relay and skips duplicate spawn", async () => {
  let relayStarted = false;
  let relayClosed = false;
  let configWritten = false;
  let dshSpawned = false;

  const code = await runDshLauncher({
    startRelay: async () => {
      relayStarted = true;
      return { port: 47821, token: "tok", close: async () => { relayClosed = true; } };
    },
    writeConfig: async () => {
      configWritten = true;
      return { ok: true, unchanged: false };
    },
    spawnDsh: async ({ env, args }) => {
      dshSpawned = true;
      assert.equal(env.ANYSWITCH_RELAY_TOKEN !== undefined, true);
      assert.deepEqual(args, ["web", "--port", "3080"]);
      return 0;
    },
    probeRelay: async () => true, // Simulate resident relay running
    dshArgs: ["web", "--port", "3080"],
  });

  assert.equal(code, 0);
  assert.equal(relayStarted, false, "should not start new relay when resident probe succeeds");
  assert.equal(configWritten, true);
  assert.equal(dshSpawned, true);
});

test("runDshLauncher falls back to per-launch relay when resident probe fails", async () => {
  let relayStarted = false;
  let relayClosed = false;
  let dshSpawned = false;

  const code = await runDshLauncher({
    startRelay: async () => {
      relayStarted = true;
      return { port: 47821, token: "per-launch-tok", close: async () => { relayClosed = true; } };
    },
    writeConfig: async () => {
      return { ok: true, unchanged: true };
    },
    spawnDsh: async ({ env }) => {
      dshSpawned = true;
      assert.equal(env.ANYSWITCH_RELAY_TOKEN, "per-launch-tok");
      return 0;
    },
    probeRelay: async () => false, // No resident relay
    dshArgs: [],
  });

  assert.equal(code, 0);
  assert.equal(relayStarted, true);
  assert.equal(relayClosed, true);
  assert.equal(dshSpawned, true);
});
