// WorkBuddy launcher 测试：零真实进程、零真实 relay、零真实凭据、零真实
// ~/.workbuddy 写入。runWorkbuddyLauncher 的每个副作用入口都是必填注入项，
// 漏注入会直接 TypeError——测试不可能穿透到真实路径。

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  buildInstanceId,
  buildWorkbuddyLauncherEnv,
  realSpawnWorkbuddy,
  resolveBundledNode,
  resolvePathNode,
  resolveWorkbuddyNode,
  runWorkbuddyLauncher,
  RELAY_PORT,
} from "./workbuddy-launcher.mjs";

const FAKE_HOME = "C:\\Users\\fixture";
const FAKE_LOCAL = join(FAKE_HOME, "AppData", "Local");
// 配置根显式钉在 fixture 上：没有 WORKBUDDY_CONFIG_DIR 时解析口径回落进程真实的
// os.homedir()（产品行为），测试不能依赖真机的主目录。
const FAKE_CONFIG_ROOT = join(FAKE_HOME, ".workbuddy");
const FAKE_BASE = {
  USERPROFILE: FAKE_HOME,
  LOCALAPPDATA: FAKE_LOCAL,
  WORKBUDDY_CONFIG_DIR: FAKE_CONFIG_ROOT,
  PATH: "",
};
const FAKE_STORE = { providers: { "fake-channel": { models: {} } } };

function fakeIo({ files = [], dirs = {} } = {}) {
  const existing = new Set(files.map((path) => path.toLowerCase()));
  const listing = new Map(Object.entries(dirs).map(([dir, entries]) => [dir.toLowerCase(), entries]));
  return {
    existsSync: (path) => existing.has(path.toLowerCase()),
    readdirSync: (path) => {
      const entries = listing.get(path.toLowerCase());
      if (!entries) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return entries;
    },
  };
}

function recordingDeps(overrides = {}) {
  const calls = [];
  const logs = [];
  const deps = {
    calls,
    logs,
    log: (line) => logs.push(line),
    base: FAKE_BASE,
    args: [],
    probeRelay: async () => false,
    resolveNode: () => "C:\\node\\node.exe",
    loadStore: () => ({ ok: true, store: FAKE_STORE }),
    loadToken: () => "shared-resident-token",
    writeConfig: async (store, port, token, sidecarRoot, modelsPath) => {
      calls.push("writeConfig");
      deps.written = { store, port, token, sidecarRoot, modelsPath };
      return { ok: true, unchanged: false, backupPath: "C:\\backup.json" };
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
    spawnWorkbuddy: async ({ env, args, node, cli, onPid }) => {
      calls.push("spawnWorkbuddy");
      deps.spawned = { env, args, node, cli };
      onPid?.(4321);
      return 0;
    },
    ...overrides,
  };
  return deps;
}

function perLaunchRelay(deps, { token = "per-launch-token", exitCode = 0 } = {}) {
  return {
    startRelay: async () => {
      deps.calls.push("startRelay");
      return {
        port: RELAY_PORT,
        token,
        close: async () => {
          deps.calls.push("closeRelay");
        },
      };
    },
    spawnWorkbuddy: async ({ env, args, node, cli, onPid }) => {
      deps.calls.push("spawnWorkbuddy");
      deps.spawned = { env, args, node, cli };
      onPid?.(4321);
      return exitCode;
    },
  };
}

test("buildWorkbuddyLauncherEnv injects the instance id and NO_PROXY, never the token", () => {
  const env = buildWorkbuddyLauncherEnv({
    instanceId: "ws-1",
    base: { PATH: "/usr/bin", WORKBUDDY_CONFIG_DIR: "C:\\wb-home" },
  });
  assert.equal(env.ANYSWITCH_INSTANCE_ID, "ws-1");
  assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(env.no_proxy, "127.0.0.1,localhost");
  assert.ok(env.NO_PROXY.includes("127.0.0.1"));
  assert.equal("ANYSWITCH_RELAY_TOKEN" in env, false, "token 只作为 models.json 条目的 apiKey 落盘");
  // 身份走 URL 段前缀：启动器不得注入 x-agent-id。
  assert.equal("x-agent-id" in env, false);
  // 配置根是功能变量，必须原样穿过。
  assert.equal(env.WORKBUDDY_CONFIG_DIR, "C:\\wb-home");
});

test("buildWorkbuddyLauncherEnv strips upstream gateway overrides but keeps CODEBUDDY_API_KEY", () => {
  const env = buildWorkbuddyLauncherEnv({
    instanceId: "ws-1",
    base: {
      CODEBUDDY_API_KEY: "user-built-in-key",
      CODEBUDDY_BASE_URL: "https://gateway.example",
      CODEBUDDY_API_BASE: "https://gateway.example",
      CODEBUDDY_AUTH_TOKEN: "auth",
      CODEBUDDY_TOKEN: "token",
      PATH: "/usr/bin",
    },
  });
  assert.equal(env.CODEBUDDY_API_KEY, "user-built-in-key");
  assert.equal("CODEBUDDY_BASE_URL" in env, false);
  assert.equal("CODEBUDDY_API_BASE" in env, false);
  assert.equal("CODEBUDDY_AUTH_TOKEN" in env, false);
  assert.equal("CODEBUDDY_TOKEN" in env, false);
  assert.equal(env.PATH, "/usr/bin");
});

test("buildInstanceId keeps the shared <cwd>-<pid> scheme with a workbuddy fallback", () => {
  assert.equal(buildInstanceId({ cwd: "C:\\work\\my app", pid: 77 }), "my-app-77");
  assert.equal(buildInstanceId({ cwd: "C:\\", pid: 78 }), "workbuddy-78");
  assert.ok(buildInstanceId({ cwd: "C:\\" + "x".repeat(200), pid: 1 }).length <= 64);
});

test("resolveBundledNode picks the newest bundled node and falls back to PATH", () => {
  const configRoot = "C:\\wb-home";
  const versions = join(configRoot, "binaries", "node", "versions");
  const io = fakeIo({
    files: [join(versions, "22.9.0", "node.exe"), join(versions, "22.10.0", "node.exe")],
    dirs: { [versions]: ["22.9.0", "22.10.0", "not-a-version"] },
  });
  assert.equal(
    resolveBundledNode({ WORKBUDDY_CONFIG_DIR: configRoot }, io),
    join(versions, "22.10.0", "node.exe"),
    "版本号最高的那份胜出，且忽略非版本目录",
  );
  assert.equal(resolveBundledNode({ WORKBUDDY_CONFIG_DIR: "C:\\empty" }, fakeIo()), null);

  const pathIo = fakeIo({ files: [join("C:\\tools", "node.exe")] });
  assert.equal(resolvePathNode({ PATH: "C:\\nope;C:\\tools" }, pathIo), join("C:\\tools", "node.exe"));
  assert.equal(resolvePathNode({ PATH: "" }, pathIo), null);

  // 两者都缺 → null，由 launcher 明确报错。
  assert.equal(resolveWorkbuddyNode({ WORKBUDDY_CONFIG_DIR: "C:\\empty", PATH: "" }, fakeIo()), null);
});

test("resident relay: reuses the shared token, writes models.json, binds pid and reports end", async () => {
  const deps = recordingDeps({ probeRelay: async () => true });
  const code = await runWorkbuddyLauncher(deps);
  assert.equal(code, 0);
  assert.deepEqual(deps.calls, ["createTracker", "writeConfig", "spawnWorkbuddy", "reportEnd"]);
  assert.equal(deps.written.port, RELAY_PORT);
  assert.equal(deps.written.token, "shared-resident-token");
  assert.equal(deps.written.modelsPath, join(FAKE_HOME, ".workbuddy", "models.json"));
  assert.equal(deps.written.sidecarRoot, join(FAKE_LOCAL, "Anyswitch"));
  assert.equal(deps.tracker.pids[0], 4321);
  assert.equal(deps.tracker.endCount, 1, "finally 里必须 reportEnd");
  assert.equal(typeof deps.spawned.env.ANYSWITCH_INSTANCE_ID, "string");
  assert.ok(deps.spawned.env.ANYSWITCH_INSTANCE_ID.length > 0);
  assert.equal(deps.spawned.node, "C:\\node\\node.exe");
  assert.equal(deps.spawned.cli, join(FAKE_LOCAL, "Programs", "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy"));
});

test("per-launch relay: uses its token, closes it in finally, argv passes through verbatim", async () => {
  const deps = recordingDeps({ args: ["-p", "hello world", "--acp"] });
  const parts = perLaunchRelay(deps, { token: "per-launch-token" });
  const code = await runWorkbuddyLauncher({ ...deps, ...parts });
  assert.equal(code, 0);
  assert.equal(deps.written.token, "per-launch-token");
  assert.deepEqual(deps.spawned.args, ["-p", "hello world", "--acp"]);
  assert.deepEqual(deps.calls, ["startRelay", "createTracker", "writeConfig", "spawnWorkbuddy", "reportEnd", "closeRelay"]);
});

test("native fallback: passes the environment through and still syncs the config", async () => {
  const deps = recordingDeps({
    startRelay: async () => {
      throw new Error("port busy");
    },
  });
  const code = await runWorkbuddyLauncher(deps);
  assert.equal(code, 0);
  assert.equal(deps.calls.includes("createTracker"), false, "native 模式没有 relay token，也没有可达面板");
  assert.equal("ANYSWITCH_INSTANCE_ID" in deps.spawned.env, false);
  assert.equal("NO_PROXY" in deps.spawned.env, false);
  assert.equal(deps.written.token, "shared-resident-token");
  assert.equal(deps.written.port, RELAY_PORT);
  assert.ok(deps.logs.some((line) => line.includes("native configuration")));
});

test("config sync failure is logged, never blocks the launch", async () => {
  const deps = recordingDeps({
    probeRelay: async () => true,
    writeConfig: async () => ({ ok: false, unchanged: true, reason: "unparseable" }),
  });
  const code = await runWorkbuddyLauncher(deps);
  assert.equal(code, 0);
  assert.ok(deps.calls.includes("spawnWorkbuddy"));
  assert.ok(deps.logs.some((line) => line.includes("workbuddy models.json not updated: unparseable")));
});

test("a missing node runtime is an explicit error: no spawn, no config write", async () => {
  const deps = recordingDeps({ resolveNode: () => null });
  await assert.rejects(() => runWorkbuddyLauncher(deps), /no node runtime found for the WorkBuddy CLI/);
  assert.deepEqual(deps.calls, []);
});

test("realSpawnWorkbuddy runs node with the CLI entry first and the argv verbatim", async () => {
  const invocations = [];
  let exitHandler = null;
  const spawnFn = (file, args, options) => {
    invocations.push({ file, args, options });
    return {
      pid: 999,
      on: (event, handler) => {
        if (event === "exit") exitHandler = handler;
      },
    };
  };
  const pids = [];
  const promise = realSpawnWorkbuddy({
    env: { PATH: "" },
    args: ["--version"],
    node: "C:\\node\\node.exe",
    cli: "C:\\wb\\cli\\bin\\codebuddy",
    spawnFn,
    onPid: (pid) => pids.push(pid),
  });
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].file, "C:\\node\\node.exe");
  assert.deepEqual(invocations[0].args, ["C:\\wb\\cli\\bin\\codebuddy", "--version"]);
  assert.equal(invocations[0].options.shell, false);
  assert.deepEqual(pids, [999]);
  exitHandler(0, null);
  assert.equal(await promise, 0);
});
