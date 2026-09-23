import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDshLauncherEnv,
  resolveDshExecutable,
  runDshLauncher,
  writeDshConfig,
} from "./dsh-launcher.mjs";
import { getYamlModule, readDshSettings, readSidecar } from "./dsh-merge-config.mjs";
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
    const result = await writeDshConfig({ version: 2, providers: {} }, 47821, dir, join(dir, "settings.yaml"));
    assert.deepEqual(result, { ok: true, unchanged: true, reason: "no Anyswitch providers with models" });
    assert.equal(existsSync(join(dir, "settings.yaml")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDshConfig clears the managed providers after the last channel is deleted", async () => {
  const dir = mkTestDir("dsh-write-");
  try {
    const settingsPath = join(dir, "settings.yaml");
    const first = await writeDshConfig(dshChannelStore(), 47821, dir, settingsPath);
    assert.equal(first.ok, true);
    assert.equal(first.unchanged, false);
    const yaml = await getYamlModule();
    const written = readDshSettings(settingsPath, yaml);
    assert.ok(written["llm-pi-ai"].providers["_poke-api"]);
    assert.deepEqual(readSidecar(dir), { providers: ["poke-api"] });

    // 渠道删空：sidecar 记着上一轮托管过什么，所以这一轮不能早退——必须走完
    // 合并把 settings.yaml 里的托管渠道删掉，否则脏模型列表永久残留。
    const emptied = await writeDshConfig({ version: 2, providers: {} }, 47821, dir, settingsPath);
    assert.equal(emptied.ok, true);
    assert.equal(emptied.unchanged, false, "the stale managed channel must be rewritten away, not skipped");
    const cleaned = readDshSettings(settingsPath, yaml);
    assert.deepEqual(Object.keys(cleaned["llm-pi-ai"].providers), []);
    assert.deepEqual(readSidecar(dir), { providers: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

