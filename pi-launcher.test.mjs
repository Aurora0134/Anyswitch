import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildInstanceId, buildPiLauncherEnv, runPiLauncher, writePiModels, resolvePiExecutable } from "./pi-launcher.mjs";
import { readSidecar } from "./pi-merge-models.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

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
    assert.equal(env.ANYSWITCH_RELAY_TOKEN, "tok");
    assert.equal(env.ANYSWITCH_INSTANCE_ID, "ws-1");
    assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
    assert.equal(env.no_proxy, "127.0.0.1,localhost");
    assert.equal(env.A, "1");
  });

  it("generates an instance id when none is passed", () => {
    const env = buildPiLauncherEnv({ port: 4321, token: "tok", base: {} });
    assert.match(env.ANYSWITCH_INSTANCE_ID, /^[A-Za-z0-9._:-]{1,64}$/);
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
        calls.push(`spawnPi:${env.ANYSWITCH_RELAY_TOKEN}:${env.NO_PROXY}`);
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

  it("passes a generated ANYSWITCH_INSTANCE_ID into the spawned env", async () => {
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
    assert.match(spawnedEnv.ANYSWITCH_INSTANCE_ID, /^[A-Za-z0-9._:-]{1,64}$/);
    // The shared scheme is "<cwd basename>-<launcher pid>"; this process IS
    // the launcher here, so the id ends with our own pid.
    assert.ok(spawnedEnv.ANYSWITCH_INSTANCE_ID.endsWith(`-${process.pid}`));
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

  it("launches pi with the plain base env when the relay cannot be acquired", async () => {
    const logs = [];
    let writeCalled = false;
    let spawned = null;
    const code = await runPiLauncher({
      startRelay: async () => {
        throw new Error("port 47821 is held by a foreign process");
      },
      writeModels: async () => {
        writeCalled = true;
        return { unchanged: true };
      },
      spawnPi: async ({ env, args }) => {
        spawned = { env, args };
        return 3;
      },
      log: (line) => logs.push(line),
      base: { PATH: "x" },
      piArgs: ["--help"],
    });
    assert.equal(code, 3, "pi's own exit code passes through");
    assert.equal(writeCalled, false, "models sync must not run without a relay");
    assert.deepEqual(spawned.env, { PATH: "x" }, "no relay env is injected on the fallback path");
    assert.deepEqual(spawned.args, ["--help"]);
    assert.ok(logs.some((line) => line.includes("relay unavailable")), "stderr explains the fallback");
  });

  // 托管条目的盘上形态：静态 token + "direct" 实例值，直启不崩；launcher 拉起前
  // 改写为本次启动值、退出后恢复静态值。
  const managedModelsJson = () => ({
    providers: {
      _poke: {
        name: "poke",
        baseUrl: "http://127.0.0.1:7000/openai/poke/v1",
        apiKey: "stable-token",
        api: "openai-completions",
        headers: { "x-agent-id": "pi", "x-agent-instance": "direct" },
        models: [{ id: "m1" }],
      },
      "user-own": {
        name: "mine",
        baseUrl: "https://x.example/v1",
        apiKey: "sk-user",
        headers: { "x-agent-id": "custom" },
        models: [{ id: "u1" }],
      },
    },
  });

  it("retags managed providers for the launch and restores the static values on exit", async () => {
    const dir = mkTestDir("pi-launch-tag-");
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, JSON.stringify(managedModelsJson(), null, 2) + "\n", "utf8");
    let duringSpawn = null;
    let spawnedInstance = null;
    const code = await runPiLauncher({
      startRelay: async () => ({ port: 7000, token: "relay-tok", close: async () => {} }),
      writeModels: async () => ({ unchanged: true }),
      spawnPi: async ({ env }) => {
        spawnedInstance = env.ANYSWITCH_INSTANCE_ID;
        duringSpawn = JSON.parse(readFileSync(modelsPath, "utf8"));
        return 0;
      },
      base: {},
      modelsPath,
    });
    assert.equal(code, 0);
    assert.equal(duringSpawn.providers._poke.apiKey, "relay-tok", "launch token on disk while pi runs");
    assert.equal(duringSpawn.providers._poke.headers["x-agent-instance"], spawnedInstance);
    assert.notEqual(spawnedInstance, "direct");
    assert.equal(duringSpawn.providers["user-own"].apiKey, "sk-user", "foreign provider never retagged");
    const after = JSON.parse(readFileSync(modelsPath, "utf8"));
    assert.equal(after.providers._poke.headers["x-agent-instance"], "direct", "static value restored after exit");
  });

  it("leaves a concurrent launcher's retag in place on exit", async () => {
    const dir = mkTestDir("pi-launch-tag-");
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, JSON.stringify(managedModelsJson(), null, 2) + "\n", "utf8");
    await runPiLauncher({
      startRelay: async () => ({ port: 7000, token: "relay-tok", close: async () => {} }),
      writeModels: async () => ({ unchanged: true }),
      spawnPi: async () => {
        // A second launcher retags the same entry while this pi is running.
        const config = JSON.parse(readFileSync(modelsPath, "utf8"));
        config.providers._poke.headers["x-agent-instance"] = "other-launcher-999";
        writeFileSync(modelsPath, JSON.stringify(config, null, 2) + "\n", "utf8");
        return 0;
      },
      base: {},
      modelsPath,
    });
    const after = JSON.parse(readFileSync(modelsPath, "utf8"));
    assert.equal(
      after.providers._poke.headers["x-agent-instance"],
      "other-launcher-999",
      "restore must not clobber a tag this launch did not write",
    );
  });

  it("restores the static instance value even when spawn throws", async () => {
    const dir = mkTestDir("pi-launch-tag-");
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, JSON.stringify(managedModelsJson(), null, 2) + "\n", "utf8");
    await assert.rejects(
      runPiLauncher({
        startRelay: async () => ({ port: 7000, token: "relay-tok", close: async () => {} }),
        writeModels: async () => ({ unchanged: true }),
        spawnPi: async () => {
          throw new Error("spawn failed");
        },
        base: {},
        modelsPath,
      }),
      /spawn failed/,
    );
    const after = JSON.parse(readFileSync(modelsPath, "utf8"));
    assert.equal(after.providers._poke.headers["x-agent-instance"], "direct");
  });
});

describe("writePiModels", () => {
  it("returns unchanged when there are no Anyswitch providers with models", async () => {
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
    const dir = mkTestDir("pi-write-test-");
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
    // 落盘的是稳定 relay token（token 文件就在 sidecarRoot 下），不是占位符——
    // 直启 pi 时 pi CLI 不再因缺变量抛错。
    assert.equal(written.providers["_poke-api"].apiKey, loadOrGenerateToken(dir));
    assert.equal(written.providers["_poke-api"].headers["x-agent-instance"], "direct");
    assert.equal(written.providers["_poke-api"].models[0].id, "claude-opus-5");
    const sidecar = JSON.parse(readFileSync(join(dir, "pi-sidecar.json"), "utf8"));
    assert.deepEqual(sidecar.providers, ["poke-api"]);
  });

  it("clears the managed providers after the last channel is deleted", async () => {
    const dir = mkTestDir("pi-write-cleanup-");
    try {
      const modelsPath = join(dir, "models.json");
      const store = {
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
      const first = await writePiModels(store, 47821, dir, modelsPath);
      assert.equal(first.ok, true);
      assert.equal(first.unchanged, false);
      assert.ok(JSON.parse(readFileSync(modelsPath, "utf8")).providers["_poke-api"]);
      assert.deepEqual(readSidecar(dir), { providers: ["poke-api"] });

      // 渠道删空：sidecar 记着上一轮托管过什么，所以这一轮不能早退——必须
      // 走完合并把 models.json 里的托管渠道删掉，否则脏模型列表永久残留。
      const emptied = await writePiModels({ version: 2, providers: {} }, 47821, dir, modelsPath);
      assert.equal(emptied.ok, true);
      assert.equal(emptied.unchanged, false, "the stale managed channel must be rewritten away, not skipped");
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(modelsPath, "utf8")).providers), []);
      assert.deepEqual(readSidecar(dir), { providers: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});