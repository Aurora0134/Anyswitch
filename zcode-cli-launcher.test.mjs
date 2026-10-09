import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildZcodeCliLauncherEnv,
  buildZcodeCliNativeEnv,
  resolveZcodeCliBuiltinConfig,
  runZcodeCliLauncher,
  realSpawnZcodeCli,
  writeZcodeCliConfig,
  zcodeCliDataDir,
  RELAY_PORT,
} from "./zcode-cli-launcher.mjs";
import { readSidecar } from "./merge-common.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

const ENTRY = "C:\\build\\dist\\zcode\\debug\\zcode\\bin\\zcode.mjs";
const BUNDLED_BUILTIN = "C:\\build\\dist\\zcode\\debug\\zcode\\agent\\provider\\zcode-builtin.json";
const SOURCE_BUILTIN = resolve("C:\\build", "config", "provider", "zcode-builtin.json");

describe("buildZcodeCliLauncherEnv", () => {
  it("injects the personal slot + builtin pin + NO_PROXY, never the relay token", () => {
    const env = buildZcodeCliLauncherEnv({
      base: { A: "1", HTTP_PROXY: "http://proxy" },
      personalConfigPath: "C:\\slot\\provider_config.json",
      builtinConfigPath: BUNDLED_BUILTIN,
    });
    assert.equal(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, "C:\\slot\\provider_config.json");
    assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, BUNDLED_BUILTIN);
    assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
    assert.equal(env.no_proxy, "127.0.0.1,localhost");
    assert.equal(env.A, "1");
    // relay 令牌只落在槽位 provider_config.json 的 apiKey 里，不走环境变量。
    assert.equal("ANYSWITCH_RELAY_TOKEN" in env, false);
  });
});

describe("buildZcodeCliNativeEnv", () => {
  it("drops the personal injection but keeps the builtin pin", () => {
    const env = buildZcodeCliNativeEnv({
      base: { A: "1", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "C:\\stray\\provider_config.json" },
      builtinConfigPath: BUNDLED_BUILTIN,
    });
    assert.equal("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE" in env, false, "外层残留的 personal 注入也要摘掉");
    assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, BUNDLED_BUILTIN, "builtin 指向与 relay 无关，保留");
    assert.equal("NO_PROXY" in env, false);
    assert.equal(env.A, "1");
  });
});

describe("resolveZcodeCliBuiltinConfig", () => {
  it("prefers the builtin config bundled in the dist tree", () => {
    assert.equal(resolveZcodeCliBuiltinConfig(ENTRY, { existsSync: () => true }), BUNDLED_BUILTIN);
  });

  it("falls back to the source tree when the bundled file is missing", () => {
    const io = { existsSync: (p) => p === SOURCE_BUILTIN };
    assert.equal(resolveZcodeCliBuiltinConfig(ENTRY, io), SOURCE_BUILTIN);
  });

  it("refuses to launch when neither candidate exists", () => {
    assert.throws(
      () => resolveZcodeCliBuiltinConfig(ENTRY, { existsSync: () => false }),
      /refusing to launch/,
    );
  });

  it("the real local build tree matches the derivation", (t) => {
    // 一次性核验收款闸用的真实布局：dist 树随包 builtin 配置必须命中第一候选。
    // 该测试依赖本机构建产物；构建树移动时随之更新，而不是放宽断言。
    const realEntry = join(
      process.env.USERPROFILE ?? "",
      "Desktop", "agent-home", "zcode-src", "dist", "zcode", "debug", "zcode", "bin", "zcode.mjs",
    );
    if (!existsSync(realEntry)) {
      t.skip("local zcode build tree absent");
      return;
    }
    const derived = resolveZcodeCliBuiltinConfig(realEntry);
    assert.ok(derived.endsWith(join("agent", "provider", "zcode-builtin.json")));
  });
});

describe("realSpawnZcodeCli", () => {
  it("spawns node with the CLI entry as argv[1] and passes args through verbatim", async () => {
    const seen = {};
    const child = new EventEmitter();
    const promise = realSpawnZcodeCli({
      env: { A: "1" },
      args: ["-p", "hi there"],
      entry: ENTRY,
      nodeExe: "C:\\node\\node.exe",
      spawnFn: (cmd, args, options) => {
        seen.cmd = cmd;
        seen.args = args;
        seen.options = options;
        return child;
      },
    });
    child.emit("exit", 5, null);
    assert.equal(await promise, 5);
    assert.equal(seen.cmd, "C:\\node\\node.exe", "Windows 不能直接执行 .mjs，必须由 node 拉起");
    assert.deepEqual(seen.args, [ENTRY, "-p", "hi there"]);
    assert.equal(seen.options.stdio, "inherit");
    assert.equal(seen.options.shell, false);
    assert.deepEqual(seen.options.env, { A: "1" });
  });

  it("rejects on spawn error", async () => {
    const child = new EventEmitter();
    const promise = realSpawnZcodeCli({
      env: {},
      args: [],
      entry: ENTRY,
      spawnFn: () => child,
    });
    child.emit("error", new Error("spawn node ENOENT"));
    await assert.rejects(promise, /spawn node ENOENT/);
  });
});

describe("runZcodeCliLauncher", () => {
  // 全部门禁都走注入：startRelay/writeConfig/loadStore/loadToken/spawnZcodeCli
  // 无默认值，测试不会碰到真实 store、token 文件或进程表。
  function doors(overrides = {}) {
    return {
      startRelay: async () => ({ port: RELAY_PORT, token: "launch-tok", close: async () => {} }),
      writeConfig: async () => ({ ok: true, unchanged: true }),
      loadStore: () => ({ ok: true, store: { version: 2, providers: {} } }),
      loadToken: () => "resident-tok",
      spawnZcodeCli: async () => 0,
      resolveExecutable: () => ENTRY,
      resolveBuiltinConfig: () => BUNDLED_BUILTIN,
      base: {},
      ...overrides,
    };
  }

  it("reuses the resident relay on probe hit, syncs, then spawns with the slot env", async () => {
    const dir = mkTestDir("zcode-cli-resident-");
    const calls = [];
    let captured = null;
    const base = { USERPROFILE: join(dir, "home"), LOCALAPPDATA: join(dir, "local"), CUSTOM_VAR: "kept" };
    const code = await runZcodeCliLauncher(doors({
      startRelay: async () => {
        calls.push("startRelay");
        throw new Error("must not be called when the resident probe hits");
      },
      writeConfig: async (store, port, token, slotRoot) => {
        calls.push(`writeConfig:${port}:${token}:${slotRoot}`);
        return { ok: true, unchanged: true };
      },
      spawnZcodeCli: async ({ env, args, entry }) => {
        calls.push("spawn");
        captured = { env, args, entry };
        return 7;
      },
      probeRelay: async () => true,
      base,
      zcodeArgs: ["-p", "hello"],
    }));

    assert.equal(code, 7, "子进程退出码原样透传");
    const slotRoot = join(dir, "local", "Anyswitch", "zcode-cli");
    assert.deepEqual(calls, [`writeConfig:${RELAY_PORT}:resident-tok:${slotRoot}`, "spawn"]);
    assert.equal(captured.entry, ENTRY);
    assert.deepEqual(captured.args, ["-p", "hello"]);
    assert.equal(captured.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, join(slotRoot, "provider_config.json"));
    assert.equal(captured.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, BUNDLED_BUILTIN);
    assert.equal(captured.env.NO_PROXY, "127.0.0.1,localhost");
    assert.equal(captured.env.CUSTOM_VAR, "kept");
    assert.equal("ANYSWITCH_RELAY_TOKEN" in captured.env, false);
  });

  it("starts a per-launch relay on probe miss and closes it after the CLI exits", async () => {
    const calls = [];
    const code = await runZcodeCliLauncher(doors({
      startRelay: async () => {
        calls.push("startRelay");
        return { port: 47821, token: "launch-tok", close: async () => calls.push("closeRelay") };
      },
      writeConfig: async (store, port, token) => {
        calls.push(`writeConfig:${port}:${token}`);
        return { ok: true, unchanged: false, backupPath: "C:\\slot\\provider_config.backup.json" };
      },
      spawnZcodeCli: async () => {
        calls.push("spawn");
        return 0;
      },
    }));

    assert.equal(code, 0);
    assert.deepEqual(calls, ["startRelay", `writeConfig:47821:launch-tok`, "spawn", "closeRelay"]);
  });

  it("launches natively when both relay levels fail: personal injection dropped, builtin pin kept, sync still runs", async () => {
    const calls = [];
    let capturedEnv = null;
    const code = await runZcodeCliLauncher(doors({
      startRelay: async () => {
        calls.push("startRelay");
        throw Object.assign(new Error("port 47821 is in use by another process"), { code: "RELAY_PORT_FOREIGN" });
      },
      writeConfig: async (store, port, token) => {
        calls.push(`writeConfig:${port}:${token}`);
        return { ok: true, unchanged: true };
      },
      spawnZcodeCli: async ({ env }) => {
        calls.push("spawn");
        capturedEnv = env;
        return 4;
      },
      base: { CUSTOM_VAR: "kept", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "C:\\stray\\provider_config.json" },
    }));

    assert.equal(code, 4, "native mode 下退出码同样透传");
    // native mode 也照常同步（对熟知端口），令牌来自共享 token 文件。
    assert.deepEqual(calls, ["startRelay", `writeConfig:${RELAY_PORT}:resident-tok`, "spawn"]);
    assert.equal("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE" in capturedEnv, false, "外层残留的 personal 注入也要摘掉");
    assert.equal(capturedEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, BUNDLED_BUILTIN);
    assert.equal("NO_PROXY" in capturedEnv, false);
    assert.equal(capturedEnv.CUSTOM_VAR, "kept");
  });

  it("native fallback logs the relay-unavailable line", async () => {
    const logs = [];
    await runZcodeCliLauncher(doors({
      startRelay: async () => {
        throw new Error("store unusable");
      },
      log: (line) => logs.push(line),
    }));
    assert.ok(
      logs.some((l) => l.includes("Anyswitch relay unavailable") && l.includes("launching zcode-cli with its native configuration")),
      `expected the native-fallback line, got: ${JSON.stringify(logs)}`,
    );
  });

  it("a throwing sync only logs a warning and never blocks the launch", async () => {
    const logs = [];
    let spawned = false;
    const code = await runZcodeCliLauncher(doors({
      writeConfig: async () => {
        throw new Error("lock timeout");
      },
      spawnZcodeCli: async () => {
        spawned = true;
        return 2;
      },
      log: (line) => logs.push(line),
    }));
    assert.equal(code, 2);
    assert.equal(spawned, true);
    assert.ok(logs.some((l) => l.includes("zcode CLI provider config sync failed") && l.includes("lock timeout")));
  });

  it("a failed sync result only logs a warning and never blocks the launch", async () => {
    const logs = [];
    let spawned = false;
    await runZcodeCliLauncher(doors({
      writeConfig: async () => ({ ok: false, unchanged: true, reason: "provider_config.json would be invalid" }),
      spawnZcodeCli: async () => {
        spawned = true;
        return 0;
      },
      log: (line) => logs.push(line),
    }));
    assert.equal(spawned, true);
    assert.ok(logs.some((l) => l.includes("zcode CLI provider config not updated") && l.includes("would be invalid")));
  });

  it("an unreadable store skips the sync with a warning and still launches", async () => {
    const calls = [];
    const logs = [];
    const code = await runZcodeCliLauncher(doors({
      loadStore: () => ({ ok: false }),
      writeConfig: async () => {
        calls.push("writeConfig");
        return { ok: true, unchanged: true };
      },
      spawnZcodeCli: async () => {
        calls.push("spawn");
        return 0;
      },
      log: (line) => logs.push(line),
    }));
    assert.equal(code, 0);
    assert.deepEqual(calls, ["spawn"]);
    assert.ok(logs.some((l) => l.includes("store could not be read")));
  });

  it("refuses to start when the CLI entry is missing — before touching the relay", async () => {
    const calls = [];
    await assert.rejects(
      runZcodeCliLauncher(doors({
        resolveExecutable: () => null,
        startRelay: async () => {
          calls.push("startRelay");
          return { port: 47821, token: "t", close: async () => {} };
        },
        spawnZcodeCli: async () => {
          calls.push("spawn");
          return 0;
        },
      })),
      /ZCODE_CLI_EXECUTABLE/,
    );
    assert.deepEqual(calls, [], "入口缺失时不占 relay、不 spawn");
  });

  it("refuses to start when the builtin config cannot be derived — before touching the relay", async () => {
    const calls = [];
    await assert.rejects(
      runZcodeCliLauncher(doors({
        resolveBuiltinConfig: () => {
          throw new Error("cannot locate the zcode builtin provider config");
        },
        startRelay: async () => {
          calls.push("startRelay");
          return { port: 47821, token: "t", close: async () => {} };
        },
        spawnZcodeCli: async () => {
          calls.push("spawn");
          return 0;
        },
      })),
      /cannot locate the zcode builtin provider config/,
    );
    assert.deepEqual(calls, []);
  });

  it("closes the per-launch relay even when the spawn throws", async () => {
    let closed = false;
    await assert.rejects(
      runZcodeCliLauncher(doors({
        startRelay: async () => ({ port: 47821, token: "t", close: async () => { closed = true; } }),
        spawnZcodeCli: async () => {
          throw new Error("spawn blew up");
        },
      })),
      /spawn blew up/,
    );
    assert.equal(closed, true);
  });

  it("requires the machine-touching doors to be injected", async () => {
    await assert.rejects(runZcodeCliLauncher(doors({ writeConfig: undefined })), /requires writeConfig/);
    await assert.rejects(runZcodeCliLauncher(doors({ loadStore: undefined })), /requires loadStore/);
    await assert.rejects(runZcodeCliLauncher(doors({ loadToken: undefined })), /requires loadToken/);
    await assert.rejects(runZcodeCliLauncher(doors({ spawnZcodeCli: undefined })), /requires spawnZcodeCli/);
    await assert.rejects(runZcodeCliLauncher(doors({ startRelay: undefined })), /requires startRelay/);
  });
});

describe("writeZcodeCliConfig", () => {
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
    const dir = mkTestDir("zcode-cli-write-");
    const result = await writeZcodeCliConfig({ version: 2, providers: {} }, 47821, "tok", dir, join(dir, "zcode-cli-sidecar.json"));
    assert.deepEqual(result, { ok: true, unchanged: true, reason: "no Anyswitch providers with models" });
    assert.equal(existsSync(join(dir, "provider_config.json")), false, "空轮次不得在槽位落文件");
  });

  it("writes the slot provider_config.json and sidecar, then drops the rule when the channel is deleted", async () => {
    const dir = mkTestDir("zcode-cli-write-");
    const sidecar = join(dir, "zcode-cli-sidecar.json");
    const first = await writeZcodeCliConfig(channelStore(), 47821, "tok", dir, sidecar);
    assert.equal(first.ok, true);
    assert.equal(first.unchanged, false);

    const doc = JSON.parse(readFileSync(join(dir, "provider_config.json"), "utf8"));
    const rule = doc.config.providerConfigRules.providerRules.find((r) => r.providerId === "_poke-api");
    assert.ok(rule, "托管渠道进入 CLI 槽位的 provider 列表");
    assert.equal(rule.config.group, "standard-personal");
    assert.equal(rule.config.access.apiKey, "tok", "relay 令牌只落在槽位文件的 apiKey 里");
    assert.equal(rule.config.api.baseUrl, `http://127.0.0.1:47821/openai/poke-api/v1`);
    assert.equal(rule.config.api.headers["x-agent-id"], "zcode");
    assert.deepEqual(readSidecar(sidecar), { providers: ["poke-api"] });

    // 渠道删空：sidecar 记着上一轮托管过什么，这一轮必须走完合并把规则删掉。
    const emptied = await writeZcodeCliConfig({ version: 2, providers: {} }, 47821, "tok", dir, sidecar);
    assert.equal(emptied.ok, true);
    const after = JSON.parse(readFileSync(join(dir, "provider_config.json"), "utf8"));
    assert.deepEqual(after.config.providerConfigRules.providerRules, []);
    assert.deepEqual(readSidecar(sidecar), { providers: [] });
  });

  it("derives the default sidecar next to the desktop's, shared with the periodic sync", async () => {
    // 生产布局：slotRoot = <数据根>\zcode-cli，sidecar 默认推导为
    // <数据根>\zcode-cli-sidecar.json——与周期同步（zcode-launcher 的
    // syncZcodeCliSlot）读写同一份，两个写入者共用一份托管记忆。
    const dir = mkTestDir("zcode-cli-write-");
    const slotRoot = join(dir, "zcode-cli");
    const first = await writeZcodeCliConfig(channelStore(), 47821, "tok", slotRoot);
    assert.equal(first.ok, true);
    assert.deepEqual(readSidecar(join(dir, "zcode-cli-sidecar.json")), { providers: ["poke-api"] });
  });
});

describe("zcodeCliDataDir", () => {
  it("lives under the Anyswitch data root as the zcode-cli slot", () => {
    assert.equal(
      zcodeCliDataDir({ LOCALAPPDATA: "C:\\local" }),
      join("C:\\local", "Anyswitch", "zcode-cli"),
    );
  });
});
