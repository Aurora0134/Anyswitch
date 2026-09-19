import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildZcodeLauncherEnv, resolveZcodeExecutable, runZcodeLauncher, writeZcodeConfig } from "./zcode-launcher.mjs";
import { readSidecar } from "./zcode-merge-config.mjs";

describe("buildZcodeLauncherEnv", () => {
  it("injects relay token and NO_PROXY for loopback", () => {
    const env = buildZcodeLauncherEnv({ port: 4321, token: "tok", base: { A: "1", HTTP_PROXY: "http://proxy" } });
    assert.equal(env.ANYSWITCH_RELAY_TOKEN, "tok");
    assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
    assert.equal(env.no_proxy, "127.0.0.1,localhost");
    assert.equal(env.A, "1");
  });
});

describe("resolveZcodeExecutable", () => {
  const base = { LOCALAPPDATA: "C:\\AppData\\Local" };

  it("defaults to LocalAppData Programs zcode", () => {
    assert.equal(resolveZcodeExecutable(base), "C:\\AppData\\Local\\Programs\\zcode\\ZCode.exe");
  });

  it("accepts absolute override", () => {
    assert.equal(
      resolveZcodeExecutable({ ...base, ZCODE_EXECUTABLE: "D:\\tools\\zcode\\ZCode.exe" }),
      "D:\\tools\\zcode\\ZCode.exe",
    );
  });

  it("rejects relative override to avoid recursion", () => {
    assert.throws(
      () => resolveZcodeExecutable({ ...base, ZCODE_EXECUTABLE: "ZCode.exe" }),
      /absolute path/,
    );
  });
});

describe("runZcodeLauncher", () => {
  const relayStub = async (calls) => ({
    port: 47821,
    token: "tok",
    close: async () => calls.push("closeRelay"),
  });

  it("when ZCode is already running: attach, wait for exit, close relay (no spawn)", async () => {
    const calls = [];
    const code = await runZcodeLauncher({
      startRelay: () => relayStub(calls),
      writeConfig: async () => {
        calls.push("writeConfig");
        return { unchanged: true };
      },
      spawnZcode: async () => {
        calls.push("spawnZcode");
        return 7;
      },
      isZcodeRunning: async () => {
        calls.push("checkRunning");
        return true;
      },
      waitForZcodeExit: async () => {
        calls.push("waitForZcodeExit");
      },
      log: () => {},
      base: {},
    });

    assert.equal(code, 0);
    assert.deepEqual(calls, ["writeConfig", "checkRunning", "waitForZcodeExit", "closeRelay"]);
  });

  it("when ZCode is not running: spawn it, relay closes on exit", async () => {
    const calls = [];
    const code = await runZcodeLauncher({
      startRelay: () => relayStub(calls),
      writeConfig: async () => {
        calls.push("writeConfig");
        return { unchanged: true };
      },
      spawnZcode: async ({ env }) => {
        calls.push(`spawnZcode:${env.ANYSWITCH_RELAY_TOKEN}:${env.NO_PROXY}`);
        return 0;
      },
      isZcodeRunning: async () => false,
      waitForZcodeExit: async () => {
        calls.push("waitForZcodeExit");
      },
      log: () => {},
      base: {},
    });

    assert.equal(code, 0);
    assert.deepEqual(calls, ["writeConfig", "spawnZcode:tok:127.0.0.1,localhost", "closeRelay"]);
  });

  it("closes relay even when waitForZcodeExit throws", async () => {
    let closed = false;
    await assert.rejects(
      runZcodeLauncher({
        startRelay: async () => ({ port: 47821, token: "tok", close: async () => { closed = true; } }),
        writeConfig: async () => ({ unchanged: true }),
        spawnZcode: async () => 0,
        isZcodeRunning: async () => true,
        waitForZcodeExit: async () => {
          throw new Error("monitor failed");
        },
        base: {},
      }),
      /monitor failed/,
    );
    assert.equal(closed, true);
  });

  it("continues when store is unreadable, logging a warning", async () => {
    const logs = [];
    const code = await runZcodeLauncher({
      startRelay: async () => ({ port: 47821, token: "tok", close: async () => {} }),
      writeConfig: async () => ({ unchanged: true }),
      spawnZcode: async () => 3,
      isZcodeRunning: async () => false,
      waitForZcodeExit: async () => {},
      log: (line) => logs.push(line),
      base: process.env,
    });
    assert.equal(code, 3);
  });
});

describe("writeZcodeConfig", () => {
  function channelStore() {
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

  it("reports a no-op when the store has no channels and nothing was managed before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-write-"));
    try {
      const result = await writeZcodeConfig({ version: 2, providers: {} }, 47821, "tok", dir, join(dir, "config.json"));
      assert.deepEqual(result, { ok: true, unchanged: true, reason: "no Anyswitch providers with models" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears the managed providers after the last channel is deleted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-write-"));
    try {
      const configPath = join(dir, "config.json");
      const first = await writeZcodeConfig(channelStore(), 47821, "tok", dir, configPath);
      assert.equal(first.ok, true);
      assert.equal(first.unchanged, false);
      assert.ok(JSON.parse(readFileSync(configPath, "utf8")).provider["_poke-api"]);
      assert.deepEqual(readSidecar(dir), { providers: ["poke-api"] });

      // 渠道删空：sidecar 记着上一轮托管过什么，所以这一轮不能早退——必须
      // 走完合并把 config.json 里的托管渠道删掉，否则脏模型列表永久残留。
      const emptied = await writeZcodeConfig({ version: 2, providers: {} }, 47821, "tok", dir, configPath);
      assert.equal(emptied.ok, true);
      assert.equal(emptied.unchanged, false, "the stale managed channel must be rewritten away, not skipped");
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(configPath, "utf8")).provider), []);
      assert.deepEqual(readSidecar(dir), { providers: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
