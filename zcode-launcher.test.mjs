import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildZcodeLauncherEnv, resolveZcodeExecutable, runZcodeLauncher, writeZcodeConfig, syncZcodeCliSlot, loadZcodeCliBuiltinModelRules, zcodeCliSlotDir, zcodeCliSidecarPath } from "./zcode-launcher.mjs";
import { readSidecar } from "./zcode-merge-config.mjs";
import { readSidecar as readSidecarFile } from "./merge-common.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

// runZcodeLauncher 的 store 读取走模块级 loadStore()——store-io.mjs 的
// defaultRoot() 在调用时读 process.env.LOCALAPPDATA，注入的 base 影响不到它，
// 所以隔离必须落在真实进程环境上：LOCALAPPDATA/APPDATA/USERPROFILE 重定向进
// 临时夹具，用例自行决定是否种一份 store.json。读与不读、读到什么，从此与
// 宿主机真实的 Anyswitch 数据脱钩（思路同 panel-self-update.test.mjs 的
// base 隔离，只是这里 loadStore 的门在 env 上）。
async function withIsolatedProfileEnv(prefix, run) {
  const dir = mkTestDir(prefix);
  const saved = {};
  for (const name of ["LOCALAPPDATA", "APPDATA", "USERPROFILE"]) {
    saved[name] = process.env[name];
  }
  process.env.LOCALAPPDATA = join(dir, "local");
  process.env.APPDATA = join(dir, "roaming");
  process.env.USERPROFILE = join(dir, "home");
  try {
    return await run(dir);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// 最小合法 store.json（store-schema 只要求 version:2 + providers 对象），
// 种进被重定向的 LOCALAPPDATA，让 loadStore() 走「可读」分支。
function plantStore() {
  const root = join(process.env.LOCALAPPDATA, "Anyswitch");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "store.json"), `${JSON.stringify({ version: 2, providers: {} })}\n`, "utf8");
}

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
    await withIsolatedProfileEnv("zcode-launch-", async () => {
      plantStore();
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
  });

  it("when ZCode is not running: spawn it, relay closes on exit", async () => {
    await withIsolatedProfileEnv("zcode-launch-", async () => {
      plantStore();
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
  });

  it("closes relay even when waitForZcodeExit throws", async () => {
    await withIsolatedProfileEnv("zcode-launch-", async () => {
      plantStore();
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
  });

  it("continues when store is unreadable, logging a warning", async () => {
    await withIsolatedProfileEnv("zcode-store-unreadable-", async () => {
      // 不种 store.json：被重定向的 LOCALAPPDATA 下没有全局 store，loadStore()
      // 按无法读取分类失败——「不可读」由夹具真实构造，而不是靠本机数据碰巧
      // 走到哪条分支。断言补齐三件事：启动继续（退出码透传）、不写客户端配置、
      // 留一条 warning（zcode-launcher.mjs 的 store 不可读分支，全仓无其他覆盖）。
      const logs = [];
      let writeConfigCalled = false;
      const code = await runZcodeLauncher({
        startRelay: async () => ({ port: 47821, token: "tok", close: async () => {} }),
        writeConfig: async () => {
          writeConfigCalled = true;
          return { unchanged: true };
        },
        spawnZcode: async () => 3,
        isZcodeRunning: async () => false,
        waitForZcodeExit: async () => {},
        log: (line) => logs.push(line),
        base: {},
      });
      assert.equal(code, 3, "store 不可读只降级配置同步，启动照常继续");
      assert.equal(writeConfigCalled, false, "store 不可读时不得写客户端配置");
      assert.ok(
        logs.some((l) => l.includes("Anyswitch store could not be read") && l.includes("zcode config not updated")),
        "必须留一条 store 不可读的 warning",
      );
    });
  });

  it("launches natively when both relay levels fail (ZCode not running)", async () => {
    // Native mode reads/generates the shared relay token file under the data
    // root for the config sync — point base at the fixture so nothing lands
    // under the live profile or the repo cwd. The env redirect covers the
    // other door: the module-level loadStore() reads process.env.LOCALAPPDATA,
    // which the injected base cannot reach.
    await withIsolatedProfileEnv("zcode-native-", async (dir) => {
      plantStore();
      const calls = [];
      const logs = [];
      let capturedEnv = null;
      const code = await runZcodeLauncher({
        startRelay: async () => {
          calls.push("startRelay");
          throw Object.assign(new Error("port 47821 is in use by another process"), { code: "RELAY_PORT_FOREIGN" });
        },
        writeConfig: async (store, port, token, sidecarRoot) => {
          calls.push(`writeConfig:${port}:${token.length > 0}`);
          return { ok: true, unchanged: true };
        },
        spawnZcode: async ({ env }) => {
          calls.push("spawnZcode");
          capturedEnv = env;
          return 4;
        },
        isZcodeRunning: async () => false,
        waitForZcodeExit: async () => {
          calls.push("waitForZcodeExit");
        },
        log: (line) => logs.push(line),
        base: { USERPROFILE: join(dir, "home"), LOCALAPPDATA: join(dir, "local"), CUSTOM_VAR: "kept" },
      });

      assert.equal(code, 4, "the child exit code passes through in native mode too");
      assert.deepEqual(calls, ["startRelay", "writeConfig:47821:true", "spawnZcode"]);
      // Native mode: verbatim environment — no relay token, no NO_PROXY.
      assert.equal("ANYSWITCH_RELAY_TOKEN" in capturedEnv, false);
      assert.equal("NO_PROXY" in capturedEnv, false);
      assert.equal(capturedEnv.CUSTOM_VAR, "kept");
      assert.ok(logs.some((l) => l.includes("Anyswitch relay unavailable") && l.includes("launching zcode with its native configuration")));
    });
  });

  it("native mode with ZCode already running: nothing to attach, exits without waiting or spawning", async () => {
    await withIsolatedProfileEnv("zcode-native-running-", async (dir) => {
      plantStore();
      const calls = [];
      const logs = [];
      const code = await runZcodeLauncher({
        startRelay: async () => {
          throw new Error("the Anyswitch global store is not usable");
        },
        writeConfig: async () => ({ unchanged: true }),
        spawnZcode: async () => {
          calls.push("spawnZcode");
          return 0;
        },
        isZcodeRunning: async () => true,
        waitForZcodeExit: async () => {
          calls.push("waitForZcodeExit");
        },
        log: (line) => logs.push(line),
        base: { USERPROFILE: join(dir, "home"), LOCALAPPDATA: join(dir, "local") },
      });

      assert.equal(code, 0);
      assert.equal(calls.includes("spawnZcode"), false, "an already-running ZCode is left alone");
      assert.equal(calls.includes("waitForZcodeExit"), false, "no relay to babysit — the wait only holds a per-launch relay alive");
      assert.ok(logs.some((l) => l.includes("already running") && l.includes("native mode")));
    });
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
    const dir = mkTestDir("zcode-write-");
    try {
      const result = await writeZcodeConfig({ version: 2, providers: {} }, 47821, "tok", dir, join(dir, "config.json"));
      assert.deepEqual(result, { ok: true, unchanged: true, reason: "no Anyswitch providers with models" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears the managed providers after the last channel is deleted", async () => {
    const dir = mkTestDir("zcode-write-");
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

describe("writeZcodeConfig 的 CLI 槽位同步", () => {
  // CLI 随包 zcode-builtin.json 的最小同构规则集：catch-all 让所有模型都解析
  // 出 ["disabled","enabled"]。
  const builtinModelRules = {
    modelRules: [
      { modelMatch: ".*", config: { optionSpecs: { reasoningLevel: { values: ["disabled", "enabled"] } } } },
    ],
  };
  // 源码树回落候选用另一份规则：断言才能区分读到的是随包文件还是回落文件。
  const fallbackBuiltinModelRules = {
    modelRules: [
      { modelMatch: ".*", config: { optionSpecs: { reasoningLevel: { values: ["off", "on"] } } } },
    ],
  };

  function twoChannelStore() {
    return {
      version: 2,
      providers: {
        "poke-api": {
          displayName: "Poke API",
          baseURL: "https://poke.example/v1",
          protocol: "openai-compatible",
          credentialFile: "poke-api.dpapi",
          models: { "m-alpha": { displayName: "Alpha", contextWindow: 1000000 } },
        },
        "relay-api": {
          displayName: "RELAY",
          baseURL: "https://relay.example/v1",
          protocol: "openai-compatible",
          credentialFile: "relay-api.dpapi",
          models: { "kimi-k3": { displayName: "Kimi K3", contextWindow: 262144 } },
        },
      },
    };
  }

  // 摆出一棵假 CLI 发行树：bin\zcode.mjs 的兄弟 agent\provider\zcode-builtin.json，
  // 与真实发行树同一布局——同步的 builtin 定位不靠注入规则数据。
  function plantCliTree(dir) {
    const cliRoot = join(dir, "cli");
    mkdirSync(join(cliRoot, "agent", "provider"), { recursive: true });
    writeFileSync(
      join(cliRoot, "agent", "provider", "zcode-builtin.json"),
      JSON.stringify({ schemaVersion: 1, revision: 1, config: { modelConfigRules: builtinModelRules } }),
    );
    return { resolveExecutable: () => join(cliRoot, "bin", "zcode.mjs") };
  }

  function readSlotDoc(dir) {
    return JSON.parse(readFileSync(join(zcodeCliSlotDir(dir), "provider_config.json"), "utf8"));
  }

  it("skips without creating anything when the CLI slot directory does not exist", async () => {
    const dir = mkTestDir("zcode-cli-slot-");
    try {
      const result = await writeZcodeConfig(twoChannelStore(), 47821, "tok", dir, join(dir, "config.json"), null, false, {
        resolveExecutable: () => join(dir, "cli", "bin", "zcode.mjs"),
      });
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.cli.ok, true);
      assert.equal(result.cli.skipped, true);
      assert.equal(existsSync(zcodeCliSlotDir(dir)), false, "周期同步不为未启用的 CLI 建目录");
      assert.equal(existsSync(zcodeCliSidecarPath(dir)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips when the CLI is not installed, even if the slot directory exists", async () => {
    const dir = mkTestDir("zcode-cli-slot-");
    try {
      mkdirSync(zcodeCliSlotDir(dir));
      const result = await writeZcodeConfig(twoChannelStore(), 47821, "tok", dir, join(dir, "config.json"), null, false, {
        resolveExecutable: () => null,
      });
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.cli.skipped, true);
      assert.match(result.cli.reason, /not installed/);
      assert.equal(existsSync(join(zcodeCliSlotDir(dir), "provider_config.json")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("syncs the CLI slot with a fresh file: required keys, legal default selection, separate sidecar", async () => {
    const dir = mkTestDir("zcode-cli-slot-");
    try {
      mkdirSync(zcodeCliSlotDir(dir));
      const result = await writeZcodeConfig(twoChannelStore(), 47821, "tok", dir, join(dir, "config.json"), null, false, plantCliTree(dir));
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.cli.ok, true, result.cli.reason);
      assert.equal(result.cli.skipped, false);

      const doc = readSlotDoc(dir);
      assert.deepEqual(doc.config.providerConfigRules.providerRules.map((r) => r.providerId), ["_poke-api", "_relay-api"]);
      // 全新文件恒含 manualProviderModelRules（CLI schema 必填），无手动规则即 []。
      assert.deepEqual(doc.config.modelConfigRules.manualProviderModelRules, []);
      // 没有 _auto 时回落到第一个有模型的托管渠道，reasoningLevel 经
      // builtin 规则解析合法（catch-all ["disabled","enabled"] → disabled）。
      assert.deepEqual(doc.config.defaultModelSelection, {
        providerId: "_poke-api",
        modelId: "m-alpha",
        options: { reasoningLevel: "disabled" },
      });
      // sidecar 分槽：与桌面版 zcode-sidecar.json 是两个文件。
      assert.deepEqual(readSidecar(dir), { providers: ["poke-api", "relay-api"] });
      assert.deepEqual(readSidecarFile(zcodeCliSidecarPath(dir)), { providers: ["poke-api", "relay-api"] });

      // 桌面版槽位行为不变：不生成默认选择，但 manualProviderModelRules 同样恒输出。
      const desktopDoc = JSON.parse(readFileSync(join(dir, "provider_config.json"), "utf8"));
      assert.equal("defaultModelSelection" in desktopDoc.config, false);
      assert.deepEqual(desktopDoc.config.modelConfigRules.manualProviderModelRules, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans a retired channel from the CLI slot via its own sidecar, not the desktop one", async () => {
    const dir = mkTestDir("zcode-cli-slot-");
    try {
      mkdirSync(zcodeCliSlotDir(dir));
      const cliSlot = plantCliTree(dir);
      await writeZcodeConfig(twoChannelStore(), 47821, "tok", dir, join(dir, "config.json"), null, false, cliSlot);

      // 桌面版 sidecar 丢失（分槽的意义所在：CLI 槽位的记忆不跟它同生死）。
      rmSync(join(dir, "zcode-sidecar.json"));
      const store = twoChannelStore();
      delete store.providers["relay-api"];
      const result = await writeZcodeConfig(store, 47821, "tok", dir, join(dir, "config.json"), null, false, cliSlot);
      assert.equal(result.cli.ok, true, result.cli.reason);

      const doc = readSlotDoc(dir);
      assert.deepEqual(doc.config.providerConfigRules.providerRules.map((r) => r.providerId), ["_poke-api"]);
      assert.equal(
        doc.config.modelConfigRules.providerModelRules.some((r) => r.providerId === "_relay-api"),
        false,
        "退役渠道的模型规则一并清掉",
      );
      assert.deepEqual(readSidecarFile(zcodeCliSidecarPath(dir)), { providers: ["poke-api"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not rewrite or roll backups after the CLI normalizes the file to its canonical key order", async () => {
    const dir = mkTestDir("zcode-cli-slot-");
    try {
      mkdirSync(zcodeCliSlotDir(dir));
      const cliSlot = plantCliTree(dir);
      await writeZcodeConfig(twoChannelStore(), 47821, "tok", dir, join(dir, "config.json"), null, false, cliSlot);

      // 模拟 CLI 读取时的规范化重写：模型规则键序变 {modelId, config, providerId}。
      const slotPath = join(zcodeCliSlotDir(dir), "provider_config.json");
      const doc = readSlotDoc(dir);
      doc.config.modelConfigRules.providerModelRules = doc.config.modelConfigRules.providerModelRules.map((rule) => {
        const { modelId, config, providerId, ...rest } = rule;
        return { modelId, config, ...rest, providerId };
      });
      writeFileSync(slotPath, JSON.stringify(doc, null, 2));
      const before = readFileSync(slotPath, "utf8");

      const second = await writeZcodeConfig(twoChannelStore(), 47821, "tok", dir, join(dir, "config.json"), null, false, cliSlot);
      assert.equal(second.ok, true, second.reason);
      assert.equal(second.cli.ok, true, second.cli.reason);
      assert.equal(second.cli.unchanged, true, "CLI 规范化重写后的内容视为未变更");
      assert.equal(readFileSync(slotPath, "utf8"), before, "文件保持 CLI 的 canonical 形态");
      assert.deepEqual(readdirSync(zcodeCliSlotDir(dir)).filter((f) => f.includes("backup")), []);
      assert.equal(second.personal.unchanged, true, "桌面版槽位同样不重写");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a default model selection the user changed inside the CLI", async () => {
    const dir = mkTestDir("zcode-cli-slot-");
    try {
      mkdirSync(zcodeCliSlotDir(dir));
      const cliSlot = plantCliTree(dir);
      await writeZcodeConfig(twoChannelStore(), 47821, "tok", dir, join(dir, "config.json"), null, false, cliSlot);

      // 用户在 CLI 里改选了模型——CLI 写回的选择带自己的 reasoningLevel。
      const slotPath = join(zcodeCliSlotDir(dir), "provider_config.json");
      const doc = readSlotDoc(dir);
      doc.config.defaultModelSelection = { providerId: "_relay-api", modelId: "kimi-k3", options: { reasoningLevel: "enabled" } };
      writeFileSync(slotPath, JSON.stringify(doc, null, 2));

      const second = await writeZcodeConfig(twoChannelStore(), 47821, "tok", dir, join(dir, "config.json"), null, false, cliSlot);
      assert.equal(second.cli.ok, true, second.cli.reason);
      assert.deepEqual(readSlotDoc(dir).config.defaultModelSelection, {
        providerId: "_relay-api",
        modelId: "kimi-k3",
        options: { reasoningLevel: "enabled" } },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("locates the CLI's bundled builtin rules next to the entry, tolerating missing or broken files", () => {
    const dir = mkTestDir("zcode-cli-builtin-");
    try {
      // 入口钉在夹具内五层深处：源码树回落候选自入口上溯五级，正好落进夹具根的
      // config\provider\——两个候选都受夹具控制，null 断言不再取决于宿主机上
      // <%TEMP%> 上溯两级之外的路径是否碰巧存在那份文件。
      const cliRoot = join(dir, "opt", "vendor", "cli", "bundle");
      const entry = join(cliRoot, "bin", "zcode.mjs");
      const bundledPath = join(cliRoot, "agent", "provider", "zcode-builtin.json");
      const fallbackPath = join(dir, "config", "provider", "zcode-builtin.json");

      assert.equal(loadZcodeCliBuiltinModelRules(null), null);
      assert.equal(loadZcodeCliBuiltinModelRules(entry), null, "两个候选都缺失 → null");

      mkdirSync(join(cliRoot, "agent", "provider"), { recursive: true });
      writeFileSync(bundledPath, "{ broken");
      assert.equal(loadZcodeCliBuiltinModelRules(entry), null, "坏 JSON 按不可解析处理");

      // 随包文件坏掉时回落源码树候选：缺失 → null；存在 → 读它。
      assert.equal(loadZcodeCliBuiltinModelRules(entry), null);
      mkdirSync(join(dir, "config", "provider"), { recursive: true });
      writeFileSync(fallbackPath, JSON.stringify({ schemaVersion: 1, config: { modelConfigRules: fallbackBuiltinModelRules } }));
      assert.deepEqual(loadZcodeCliBuiltinModelRules(entry), fallbackBuiltinModelRules, "随包文件坏掉时回落候选被读取");

      // 随包文件修好后优先于回落候选（候选一先试）。
      writeFileSync(bundledPath, JSON.stringify({ schemaVersion: 1, config: { modelConfigRules: builtinModelRules } }));
      assert.deepEqual(loadZcodeCliBuiltinModelRules(entry), builtinModelRules);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("syncZcodeCliSlot leaves a locked slot file alone and keeps the sidecar memory", async () => {
    const dir = mkTestDir("zcode-cli-slot-");
    try {
      const slotDir = zcodeCliSlotDir(dir);
      mkdirSync(slotDir);
      const cliSlot = { ...plantCliTree(dir), lockWaitMs: 120 };

      // CLI 正握着槽位目录锁（live owner pid）。
      const lockPath = `${join(slotDir, "provider_config.json")}.lock`;
      mkdirSync(lockPath);
      writeFileSync(
        join(lockPath, "owner-4321-1-zcode.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "zcode" })}\n`,
      );

      const managedEntries = {
        "_poke-api": { name: "poke-api", options: { apiKey: "tok", baseURL: "http://127.0.0.1:47821/openai/poke-api/v1" }, models: { "m-alpha": { limit: { context: 1000000 } } } },
      };
      const refused = syncZcodeCliSlot({ sidecarRoot: dir, managedEntries, managedIds: ["poke-api"], ...cliSlot });
      assert.equal(refused.ok, false);
      assert.equal(refused.skipped, false);
      assert.equal(existsSync(join(slotDir, "provider_config.json")), false, "锁占用时不写文件");
      assert.equal(existsSync(zcodeCliSidecarPath(dir)), false, "同步失败不更新 sidecar——下一轮仍记得要补");

      rmSync(lockPath, { recursive: true, force: true });
      const synced = syncZcodeCliSlot({ sidecarRoot: dir, managedEntries, managedIds: ["poke-api"], ...cliSlot });
      assert.equal(synced.ok, true, synced.reason);
      assert.deepEqual(readSlotDoc(dir).config.defaultModelSelection, {
        providerId: "_poke-api",
        modelId: "m-alpha",
        options: { reasoningLevel: "disabled" },
      });
      assert.deepEqual(readSidecarFile(zcodeCliSidecarPath(dir)), { providers: ["poke-api"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cli.ok === false 不翻整体 ok，但向注入的 log 通道发一条 warn", async () => {
    const dir = mkTestDir("zcode-cli-slot-");
    try {
      const slotDir = zcodeCliSlotDir(dir);
      mkdirSync(slotDir);
      const cliSlot = { ...plantCliTree(dir), lockWaitMs: 120 };

      // CLI 正握着槽位目录锁（live owner pid）：cli 分支必败，桌面版照常。
      const lockPath = `${join(slotDir, "provider_config.json")}.lock`;
      mkdirSync(lockPath);
      writeFileSync(
        join(lockPath, "owner-4321-1-zcode.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "zcode" })}\n`,
      );

      const warns = [];
      const log = { warn: (line) => warns.push(line) };
      const refused = await writeZcodeConfig(
        twoChannelStore(), 47821, "tok", dir, join(dir, "config.json"), null, false, cliSlot, { log },
      );
      assert.equal(refused.ok, true, "CLI 槽位失败不拖垮桌面版的同步结论");
      assert.equal(refused.cli.ok, false);
      assert.equal(warns.length, 1, "cli 分支失败必须留痕");
      assert.match(warns[0], /zcode CLI slot sync failed/);

      // 锁释放后重跑：cli 分支成功，不再发 warn。
      rmSync(lockPath, { recursive: true, force: true });
      const synced = await writeZcodeConfig(
        twoChannelStore(), 47821, "tok", dir, join(dir, "config.json"), null, false, cliSlot, { log },
      );
      assert.equal(synced.cli.ok, true, synced.cli.reason);
      assert.equal(warns.length, 1, "cli 分支成功时不发 warn");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
