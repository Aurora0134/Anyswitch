import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildInstanceId, buildPiLauncherEnv, runPiLauncher, writePiModels, resolvePiExecutable } from "./pi-launcher.mjs";

describe("buildInstanceId", () => {
  it("is '<cwd basename>-<pid>'", () => {
    assert.equal(buildInstanceId({ cwd: "/home/me/my-proj", pid: 123, endpoint: "pi" }), "my-proj-123");
  });

  it("replaces off-whitelist basename characters with '-'", () => {
    assert.equal(buildInstanceId({ cwd: "/home/me/my proj! (2)", pid: 7 }), "my-proj---2--7");
  });

  it("falls back to '<endpoint>-<pid>' when the basename is empty", () => {
    assert.equal(buildInstanceId({ cwd: "", pid: 42, endpoint: "pi" }), "pi-42");
  });

  it("caps the total length at 64 chars", () => {
    const id = buildInstanceId({ cwd: `/home/me/${"a".repeat(100)}`, pid: 9 });
    assert.equal(id.length, 64);
    assert.match(id, /^[A-Za-z0-9._:-]+$/);
  });

  it("defaults to the launcher's own cwd and pid", () => {
    assert.match(buildInstanceId(), /^[A-Za-z0-9._:-]{1,64}$/);
  });
});

describe("buildPiLauncherEnv", () => {
  it("injects relay token, instance id and NO_PROXY for loopback", () => {
    const env = buildPiLauncherEnv({ port: 4321, token: "tok", instanceId: "ws-1", base: { A: "1", HTTP_PROXY: "http://proxy" } });
    assert.equal(env.APICRED_RELAY_TOKEN, "tok");
    assert.equal(env.APICRED_INSTANCE_ID, "ws-1");
    assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
    assert.equal(env.no_proxy, "127.0.0.1,localhost");
    assert.equal(env.A, "1");
  });

  it("generates an instance id when none is passed", () => {
    const env = buildPiLauncherEnv({ port: 4321, token: "tok", base: {} });
    assert.match(env.APICRED_INSTANCE_ID, /^[A-Za-z0-9._:-]{1,64}$/);
  });
});

describe("resolvePiExecutable", () => {
  it("defaults to npm pi.cmd", () => {
    const exe = resolvePiExecutable({ APPDATA: "C:\\AppData", USERPROFILE: "C:\\Users\\me" });
    assert.equal(exe, "C:\\AppData\\npm\\pi.cmd");
  });

  it("accepts absolute override", () => {
    const exe = resolvePiExecutable({
      PI_EXECUTABLE: "C:\\tools\\pi-custom\\pi.exe",
      APPDATA: "C:\\AppData",
    });
    assert.equal(exe, "C:\\tools\\pi-custom\\pi.exe");
  });

  it("rejects relative override to avoid recursion", () => {
    assert.throws(
      () => resolvePiExecutable({ PI_EXECUTABLE: "pi", APPDATA: "C:\\AppData" }),
      /absolute path/,
    );
  });
});

describe("runPiLauncher", () => {
  it("starts relay, writes models, spawns pi, closes relay", async () => {
    const calls = [];
    const code = await runPiLauncher({
      startRelay: async () => {
        calls.push("startRelay");
        return { port: 7000, token: "tok", close: async () => calls.push("closeRelay") };
      },
      writeModels: async (store, port, sidecarRoot) => {
        calls.push(`writeModels:${port}`);
        return { unchanged: false, backupPath: "backup.json" };
      },
      spawnPi: async ({ env }) => {
        calls.push(`spawnPi:${env.APICRED_RELAY_TOKEN}:${env.NO_PROXY}`);
        return 0;
      },
      log: () => {},
      base: {},
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, [
      "startRelay",
      "writeModels:7000",
      "spawnPi:tok:127.0.0.1,localhost",
      "closeRelay",
    ]);
  });

  it("passes a generated APICRED_INSTANCE_ID into the spawned env", async () => {
    let spawnedEnv = null;
    await runPiLauncher({
      startRelay: async () => ({ port: 7000, token: "tok", close: async () => {} }),
      writeModels: async () => ({ unchanged: true }),
      spawnPi: async ({ env }) => {
        spawnedEnv = env;
        return 0;
      },
      base: {},
    });
    assert.match(spawnedEnv.APICRED_INSTANCE_ID, /^[A-Za-z0-9._:-]{1,64}$/);
    // The shared scheme is "<cwd basename>-<launcher pid>"; this process IS
    // the launcher here, so the id ends with our own pid.
    assert.ok(spawnedEnv.APICRED_INSTANCE_ID.endsWith(`-${process.pid}`));
  });

  it("closes relay even when spawn throws", async () => {
    let closed = false;
    await assert.rejects(
      runPiLauncher({
        startRelay: async () => ({ port: 7000, token: "tok", close: async () => { closed = true; } }),
        writeModels: async () => ({ unchanged: true }),
        spawnPi: async () => {
          throw new Error("spawn failed");
        },
        base: {},
      }),
      /spawn failed/,
    );
    assert.equal(closed, true);
  });

  it("continues when store is unreadable, logging a warning", async () => {
    const logs = [];
    const code = await runPiLauncher({
      startRelay: async () => ({ port: 7000, token: "tok", close: async () => {} }),
      writeModels: async () => ({ unchanged: true }),
      spawnPi: async () => 1,
      log: (line) => logs.push(line),
      base: process.env,
    });
    assert.equal(code, 1);
  });
});

describe("writePiModels", () => {
  it("returns unchanged when there are no ApiCred providers with models", async () => {
    const result = await writePiModels(
      { version: 2, providers: { empty: { models: {} } } },
      47821,
      tmpdir(),
      join(tmpdir(), "models.json"),
    );
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
  });

  it("writes models.json with _ prefixed providers and sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-write-test-"));
    const modelsPath = join(dir, "models.json");
    const store = {
      version: 2,
      providers: {
        "poke-api": {
          baseURL: "https://poke.example/v1",
          protocol: "openai-compatible",
          credentialFile: "poke-api.dpapi",
          models: { "claude-opus-5": { displayName: "Claude Opus 5" } },
        },
      },
    };
    const result = await writePiModels(store, 47821, dir, modelsPath);
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);
    const written = JSON.parse(readFileSync(modelsPath, "utf8"));
    assert.ok(written.providers["_poke-api"]);
    assert.equal(written.providers["_poke-api"].baseUrl, "http://127.0.0.1:47821/openai/poke-api/v1");
    assert.equal(written.providers["_poke-api"].apiKey, "${APICRED_RELAY_TOKEN}");
    assert.equal(written.providers["_poke-api"].models[0].id, "claude-opus-5");
    const sidecar = JSON.parse(readFileSync(join(dir, "pi-sidecar.json"), "utf8"));
    assert.deepEqual(sidecar.providers, ["poke-api"]);
  });
});