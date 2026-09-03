import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReasonixLauncherEnv,
  resolveReasonixExecutable,
  runReasonixLauncher,
} from "./reasonix-launcher.mjs";
import { join } from "node:path";

test("buildReasonixLauncherEnv injects APICRED_RELAY_TOKEN and NO_PROXY", () => {
  const env = buildReasonixLauncherEnv({
    port: 47821,
    token: "test-secret-token",
    base: { PATH: "/usr/bin" },
  });
  assert.equal(env.APICRED_RELAY_TOKEN, "test-secret-token");
  assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(env.PATH, "/usr/bin");
});

test("resolveReasonixExecutable accepts absolute path and rejects relative override", () => {
  const explicit = resolveReasonixExecutable({
    REASONIX_EXECUTABLE: "C:\\custom\\reasonix-cli.exe",
  });
  assert.equal(explicit, "C:\\custom\\reasonix-cli.exe");

  assert.throws(
    () => resolveReasonixExecutable({ REASONIX_EXECUTABLE: "relative/reasonix" }),
    /must be an absolute path/,
  );
});

test("resolveReasonixExecutable defaults to the installed Reasonix CLI under Programs", () => {
  const exe = resolveReasonixExecutable({
    LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local",
    USERPROFILE: "C:\\Users\\x",
  });
  assert.equal(
    exe.toLowerCase(),
    join("C:\\Users\\x\\AppData\\Local", "Programs", "Reasonix", "reasonix-cli.exe").toLowerCase(),
  );
});

test("runReasonixLauncher reuses resident relay and writes config with relay token", async () => {
  let relayStarted = false;
  let configWritten = false;
  let reasonixSpawned = false;

  const code = await runReasonixLauncher({
    startRelay: async () => {
      relayStarted = true;
      return { port: 47821, token: "tok", close: async () => {} };
    },
    writeConfig: async (store, port, token, sidecarRoot) => {
      configWritten = true;
      assert.equal(port, 47821);
      assert.equal(typeof token, "string");
      assert.ok(token.length > 0);
      return { ok: true, unchanged: false };
    },
    spawnReasonix: async ({ env, args }) => {
      reasonixSpawned = true;
      assert.equal(env.APICRED_RELAY_TOKEN !== undefined, true);
      assert.deepEqual(args, ["--resume"]);
      return 0;
    },
    probeRelay: async () => true, // Simulate resident relay running
    reasonixArgs: ["--resume"],
  });

  assert.equal(code, 0);
  assert.equal(relayStarted, false, "should not start new relay when resident probe succeeds");
  assert.equal(configWritten, true);
  assert.equal(reasonixSpawned, true);
});

test("runReasonixLauncher falls back to per-launch relay when resident probe fails", async () => {
  let relayStarted = false;
  let relayClosed = false;
  let reasonixSpawned = false;

  const code = await runReasonixLauncher({
    startRelay: async () => {
      relayStarted = true;
      return { port: 47821, token: "per-launch-tok", close: async () => { relayClosed = true; } };
    },
    writeConfig: async (store, port, token) => {
      assert.equal(token, "per-launch-tok");
      return { ok: true, unchanged: true };
    },
    spawnReasonix: async ({ env }) => {
      reasonixSpawned = true;
      assert.equal(env.APICRED_RELAY_TOKEN, "per-launch-tok");
      return 0;
    },
    probeRelay: async () => false, // No resident relay
    reasonixArgs: [],
  });

  assert.equal(code, 0);
  assert.equal(relayStarted, true);
  assert.equal(relayClosed, true);
  assert.equal(reasonixSpawned, true);
});
