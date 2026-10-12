import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDshLauncherEnv,
  resolveDshExecutable,
  runDshLauncher,
  writeDshConfig,
} from "./dsh-launcher.mjs";
import { getYamlModule, readSidecar } from "./dsh-merge-config.mjs";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

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
  const dir = mkTestDir("dsh-exe-");
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
  let writtenToken = null;

  const code = await runDshLauncher({
    startRelay: async () => {
      relayStarted = true;
      return { port: 47821, token: "per-launch-tok", close: async () => { relayClosed = true; } };
    },
    writeConfig: async (store, port, token) => {
      writtenToken = token;
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
  // The same token the child env carries must reach the config writer, or the
  // profile headers would authenticate with a stale/other relay's secret.
  assert.equal(writtenToken, "per-launch-tok");
});

test("runDshLauncher launches natively when both relay levels fail", async () => {
  let relayStarted = false;
  let relayClosed = false;
  let dshSpawned = false;
  let configPort = null;
  let configToken = "unset";
  let capturedEnv = null;
  const logs = [];
  // LOCALAPPDATA is the data root the sync reads its token from; point it at a
  // scratch dir so the native-mode sync never mints a file beside the tests.
  const dir = mkTestDir("dsh-native-");
  try {
    const code = await runDshLauncher({
      startRelay: async () => {
        relayStarted = true;
        throw Object.assign(new Error("port 47821 is in use by another process"), { code: "RELAY_PORT_FOREIGN" });
      },
      writeConfig: async (store, port, token) => {
        configPort = port;
        configToken = token;
        return { ok: true, unchanged: true };
      },
      spawnDsh: async ({ env }) => {
        dshSpawned = true;
        capturedEnv = env;
        return 5;
      },
      probeRelay: async () => false, // No resident relay
      log: (line) => logs.push(line),
      base: { PATH: "/usr/bin", CUSTOM_VAR: "kept", LOCALAPPDATA: dir },
      dshArgs: [],
    });

    assert.equal(code, 5, "the child exit code passes through in native mode too");
    assert.equal(relayStarted, true);
    assert.equal(relayClosed, false, "native mode has no relay to close");
    assert.equal(dshSpawned, true);
    // Native mode: verbatim environment — no relay token, no NO_PROXY.
    assert.equal("ANYSWITCH_RELAY_TOKEN" in capturedEnv, false);
    assert.equal("NO_PROXY" in capturedEnv, false);
    assert.equal(capturedEnv.CUSTOM_VAR, "kept");
    // The profile sync still runs against the well-known port, so the managed
    // profiles revive with the resident relay. This data root is empty, so the
    // shared token file is minted on the spot — the same file a resident relay
    // reads, which is what makes the profiles revive with it.
    assert.equal(configPort, 47821);
    assert.equal(typeof configToken, "string");
    assert.equal(configToken.length, 64);
    assert.ok(logs.some((l) => l.includes("Anyswitch relay unavailable") && l.includes("launching dsh with its native configuration")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDshLauncher native mode writes the resident relay's on-disk token into the profiles", async () => {
  // Native fallback still points the managed profiles at the well-known port;
  // the token they authenticate with must be the shared relay token — the env
  // var that would carry it in relay mode is deliberately absent here, and a
  // desktop app launched by its own shortcut never sees even that.
  const dir = mkTestDir("dsh-native-token-");
  try {
    const root = join(dir, "Anyswitch");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "pi-relay-token"), "resident-tok\n", "utf8");
    let configToken = "unset";

    const code = await runDshLauncher({
      startRelay: async () => {
        throw Object.assign(new Error("port 47821 is in use by another process"), { code: "RELAY_PORT_FOREIGN" });
      },
      writeConfig: async (store, port, token) => {
        configToken = token;
        return { ok: true, unchanged: true };
      },
      spawnDsh: async () => 0,
      probeRelay: async () => false,
      log: () => {},
      base: { LOCALAPPDATA: dir },
      dshArgs: [],
    });

    assert.equal(code, 0);
    assert.equal(configToken, "resident-tok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function dshChannelStore() {
  return {
    version: 2,
    providers: {
      "poke-api": {
        displayName: "Poke API",
        baseURL: "https://poke.example/v1",
        protocol: "openai-compatible",
        credentialFile: "poke-api.dpapi",
        models: { "claude-opus-5": { displayName: "Claude Opus 5", contextWindow: 200000 } },
      },
    },
  };
}

test("writeDshConfig reports a no-op when there are no channels and nothing was managed before", async () => {
  const dir = mkTestDir("dsh-write-");
  try {
    const result = await writeDshConfig({ version: 2, providers: {} }, 47821, "tok", dir, join(dir, "settings.yaml"));
    assert.deepEqual(result, { ok: true, unchanged: true, reason: "no Anyswitch providers with models" });
    assert.equal(existsSync(join(dir, "profiles")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDshConfig writes every existing profile and clears them after the last channel is deleted", async () => {
  const dir = mkTestDir("dsh-write-");
  try {
    mkdirSync(join(dir, "profiles", "dsh-tui"), { recursive: true });
    const first = await writeDshConfig(dshChannelStore(), 47821, "tok", dir, join(dir, "settings.yaml"));
    assert.equal(first.ok, true);
    assert.equal(first.unchanged, false);
    assert.equal(existsSync(join(dir, "settings.yaml")), false);
    const yaml = await getYamlModule();
    const patchPath = join(dir, "profiles", "dsh-tui", "cordis.patch.yml");
    const written = yaml.load(readFileSync(patchPath, "utf8"));
    const channel = written.find((entry) => entry.id === "llm-pi-ai").config.providers["_poke-api"];
    assert.ok(channel);
    // The relay token must land in the profile's headers so a surface that
    // never ran an Anyswitch launcher (the official desktop app) can still
    // authenticate; an apiKeyEnv reference would resolve to nothing there.
    assert.equal(channel.apiKeyEnv, undefined);
    assert.equal(channel.headers.Authorization, "Bearer tok");
    assert.deepEqual(readSidecar(dir), { providers: ["poke-api"] });

    const emptied = await writeDshConfig({ version: 2, providers: {} }, 47821, "tok", dir, join(dir, "settings.yaml"));
    assert.equal(emptied.ok, true);
    assert.equal(emptied.unchanged, false, "the stale managed channel must be rewritten away, not skipped");
    const cleaned = yaml.load(readFileSync(patchPath, "utf8"));
    assert.deepEqual(Object.keys(cleaned.find((entry) => entry.id === "llm-pi-ai").config.providers), []);
    assert.deepEqual(readSidecar(dir), { providers: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

