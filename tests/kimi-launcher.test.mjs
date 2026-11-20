// Kimi launcher tests. Same injected-dependency pattern as launcher.test.mjs:
// ZERO real spawn, ZERO real relay, ZERO real credentials.

import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runKimiLauncher, buildKimiLauncherEnv, buildKimiNativeFallbackEnv, buildInstanceId, writeKimiConfig, main } from "../src/launchers/kimi-launcher.mjs";
import { readSidecar } from "../src/launchers/kimi-merge-config.mjs";
import { sanitizeInstanceId } from "../src/agents/agent-metrics.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

// Mirror of kimi-code's parseKimiCodeCustomHeaders (dist/main.mjs): the env
// value is newline-separated "Name: value" lines, split at the first colon.
function parseKimiCodeCustomHeaders(raw) {
  const headers = {};
  for (const line of String(raw ?? "").trim().split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (name.length === 0) continue;
    headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

// A fake relay handle that records whether it was closed, optionally carrying
// a mock session tracker. Pass the same `events` array to fakeTracker so one
// test can observe the teardown order (reportEnd must precede relay close).
function fakeRelay({ tracker = null, events = [] } = {}) {
  const state = { closed: false };
  return {
    state,
    handle: {
      port: 54321,
      token: "relay-session-token",
      sessionTracker: tracker,
      close: async () => {
        state.closed = true;
        events.push("relay-close");
      },
    },
  };
}

function fakeTracker(events = []) {
  const calls = { pids: [], endCount: 0, events };
  return {
    calls,
    tracker: {
      setClaudePid: (pid) => calls.pids.push(pid),
      reportEnd: () => {
        calls.endCount += 1;
        events.push("reportEnd");
      },
    },
  };
}

test("buildKimiLauncherEnv points kimi at the loopback relay and injects the token", () => {
  const env = buildKimiLauncherEnv({ port: 8080, token: "abc123", base: { PATH: "/usr/bin" } });
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8080");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "abc123");
  assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(env.no_proxy, "127.0.0.1,localhost");
  assert.equal(env.PATH, "/usr/bin");
});

test("buildKimiLauncherEnv injects endpoint identity and instance tag via KIMI_CODE_CUSTOM_HEADERS", () => {
  const env = buildKimiLauncherEnv({ port: 8080, token: "abc123", base: {}, instanceId: "ws-1" });
  // 格式钉住 kimi-code parseKimiCodeCustomHeaders 的解析契约：换行分隔的
  // "Name: value" 行。x-agent-id 替补被移出 config.toml 的身份头（relay 的
  // 归属白名单与 auto 链查询仍靠它），x-agent-instance 打实例标签。
  assert.equal(env.KIMI_CODE_CUSTOM_HEADERS, "x-agent-id: kimi\nx-agent-instance: ws-1");
  assert.deepEqual(parseKimiCodeCustomHeaders(env.KIMI_CODE_CUSTOM_HEADERS), {
    "x-agent-id": "kimi",
    "x-agent-instance": "ws-1",
  });
});

test("buildKimiLauncherEnv strips an inherited ANTHROPIC_API_KEY so the relay token is the sole auth", () => {
  // kimi 也读 ANTHROPIC_API_KEY：剥除缺失时，继承的真 key 会绕开 relay 会话
  // 令牌直连上游。功能性变量（PATH）照常随行。
  const env = buildKimiLauncherEnv({
    port: 8080,
    token: "abc123",
    base: { ANTHROPIC_API_KEY: "sk-real-anthropic-key", PATH: "/usr/bin" },
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "abc123");
  assert.equal(env.PATH, "/usr/bin");
});

test("runKimiLauncher strips ANTHROPIC_API_KEY on the full relay-mode path", async () => {
  const { state, handle } = fakeRelay();
  let spawnedEnv = null;
  const code = await runKimiLauncher({
    startRelay: async () => handle,
    buildEnv: buildKimiLauncherEnv,
    spawnKimi: async ({ env }) => {
      spawnedEnv = env;
      return 0;
    },
    base: { ANTHROPIC_API_KEY: "sk-real-anthropic-key" },
  });
  assert.equal(code, 0);
  assert.equal(spawnedEnv.ANTHROPIC_API_KEY, undefined, "继承的真 key 不得随 relay 模式子进程出站");
  assert.equal(spawnedEnv.ANTHROPIC_AUTH_TOKEN, "relay-session-token");
  assert.equal(state.closed, true);
  // 原生回落不剥 key 的口径已由「falls back to the native configuration」用例钉住。
});

test("buildKimiLauncherEnv always carries x-agent-id, even without an instanceId", () => {
  const env = buildKimiLauncherEnv({ port: 8080, token: "abc123", base: {} });
  assert.deepEqual(parseKimiCodeCustomHeaders(env.KIMI_CODE_CUSTOM_HEADERS), { "x-agent-id": "kimi" });
});

test("buildInstanceId follows the unified <cwd basename>-<pid> scheme", () => {
  assert.equal(buildInstanceId({ cwd: "/work/myproj", pid: 1234 }), "myproj-1234");
  // 基名清洗：非法字符替换为 '-'（空格、感叹号都非法）。
  assert.equal(buildInstanceId({ cwd: "/work/my proj!", pid: 1234 }), "my-proj--1234");
  // 基名为空（如文件系统根）时回落 <端点名>-<pid>。
  assert.equal(buildInstanceId({ cwd: "/", pid: 1234 }), "kimi-1234");
});

test("buildInstanceId caps the id at 64 chars and stays charset-valid", () => {
  const id = buildInstanceId({ cwd: `/work/${"a".repeat(100)}`, pid: 1234 });
  assert.equal(id.length, 64);
  assert.equal(sanitizeInstanceId(id), id, "the generated id must survive relay-side validation");
});

test("runKimiLauncher generates the instance id and passes it to buildEnv", async () => {
  const { state, handle } = fakeRelay();
  let captured = null;

  const code = await runKimiLauncher({
    startRelay: async () => handle,
    buildEnv: (args) => {
      captured = args;
      return buildKimiLauncherEnv(args);
    },
    spawnKimi: async () => 0,
  });

  assert.equal(code, 0);
  assert.equal(typeof captured.instanceId, "string");
  // The shared scheme is "<cwd basename>-<launcher pid>" and this process IS
  // the launcher here, so the id must be exactly what buildInstanceId()
  // computes for this process. Equality rather than a pid-suffix check: the
  // 64-char cap (pinned in buildInstanceId's own test) can truncate the pid
  // tail when the run directory's basename is long, and that must not depend
  // on where the suite happens to run.
  assert.equal(captured.instanceId, buildInstanceId());
  assert.equal(sanitizeInstanceId(captured.instanceId), captured.instanceId);
  const headers = parseKimiCodeCustomHeaders(
    buildKimiLauncherEnv({ port: 1, token: "t", base: {}, instanceId: captured.instanceId }).KIMI_CODE_CUSTOM_HEADERS,
  );
  assert.equal(headers["x-agent-instance"], captured.instanceId);
  assert.equal(state.closed, true);
});

test("runKimiLauncher registers the child PID on the session tracker and reports session end", async () => {
  // 与 claude 的 runLauncher 对齐：子进程 PID 上报给 session reporter
  // （reportSession 要求 PID），退出时发 ended 信号，relay 随之拆除。
  const events = [];
  const { calls, tracker } = fakeTracker(events);
  const { state, handle } = fakeRelay({ tracker, events });
  let capturedOnPid = null;

  const code = await runKimiLauncher({
    startRelay: async () => handle,
    buildEnv: buildKimiLauncherEnv,
    spawnKimi: async ({ onPid }) => {
      capturedOnPid = onPid;
      onPid(4321);
      return 0;
    },
  });

  assert.equal(code, 0);
  assert.equal(typeof capturedOnPid, "function");
  assert.deepEqual(calls.pids, [4321]);
  assert.equal(calls.endCount, 1);
  // 面板先收到 ended 再失去 relay：两桩共享同一条时间线，顺序回归（先拆
  // relay 再上报）会在这里被抓到。
  assert.deepEqual(calls.events, ["reportEnd", "relay-close"], "session end is reported before the relay is torn down");
  assert.equal(state.closed, true);
});

test("runKimiLauncher reports session end and closes the relay even when spawn fails", async () => {
  const { calls, tracker } = fakeTracker();
  const { state, handle } = fakeRelay({ tracker });

  await assert.rejects(
    () =>
      runKimiLauncher({
        startRelay: async () => handle,
        buildEnv: buildKimiLauncherEnv,
        spawnKimi: async () => {
          throw new Error("spawn failed");
        },
      }),
    /spawn failed/,
  );
  assert.equal(calls.endCount, 1);
  assert.equal(state.closed, true);
});

test("runKimiLauncher works without a session tracker (older relay handles)", async () => {
  const { state, handle } = fakeRelay({ tracker: null });
  delete handle.sessionTracker;

  const code = await runKimiLauncher({
    startRelay: async () => handle,
    buildEnv: buildKimiLauncherEnv,
    spawnKimi: async ({ onPid }) => {
      onPid(4321);
      return 3;
    },
  });
  assert.equal(code, 3);
  assert.equal(state.closed, true);
});

test("buildKimiNativeFallbackEnv passes the inherited environment through untouched", () => {
  const base = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-real", KIMI_CODE_CUSTOM_HEADERS: "x-user: 1" };
  const env = buildKimiNativeFallbackEnv({ base });
  assert.deepEqual(env, base);
  assert.notEqual(env, base, "a copy, so callers may mutate it without touching process.env");
});

test("runKimiLauncher falls back to the native configuration when the relay cannot start", async () => {
  const spawned = [];
  const logs = [];
  let buildEnvCalled = false;

  const code = await runKimiLauncher({
    startRelay: async () => {
      throw new Error("the Anyswitch global store is not usable; refusing to start the relay");
    },
    buildEnv: (args) => {
      buildEnvCalled = true;
      return buildKimiLauncherEnv(args);
    },
    spawnKimi: async ({ env, args }) => {
      spawned.push({ env, args });
      return 0;
    },
    log: (line) => logs.push(line),
    base: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-real-anthropic-key" },
    kimiArgs: ["--resume", "session-1"],
  });

  assert.equal(code, 0);
  assert.equal(spawned.length, 1);
  // 原生回落：不注入 relay 三件套与身份头，也不删用户自己的 ANTHROPIC_API_KEY。
  assert.equal(spawned[0].env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(spawned[0].env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(spawned[0].env.KIMI_CODE_CUSTOM_HEADERS, undefined);
  assert.equal(spawned[0].env.ANTHROPIC_API_KEY, "sk-real-anthropic-key");
  assert.equal(spawned[0].env.PATH, "/usr/bin");
  assert.equal(buildEnvCalled, false, "the relay-mode env builder must not run on the fallback path");
  assert.deepEqual(spawned[0].args, ["--resume", "session-1"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /not usable/);
  assert.match(logs[0], /native configuration/);
});

describe("writeKimiConfig", () => {
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
    const dir = mkTestDir("kimi-write-");
    try {
      const result = await writeKimiConfig({ version: 2, providers: {} }, 47821, "tok", dir, join(dir, "config.toml"));
      assert.deepEqual(result, { ok: true, unchanged: true, reason: "no Anyswitch providers with models" });
      assert.equal(existsSync(join(dir, "config.toml")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears the managed block after the last channel is deleted", async () => {
    const dir = mkTestDir("kimi-write-");
    try {
      const configPath = join(dir, "config.toml");
      const first = await writeKimiConfig(channelStore(), 47821, "tok", dir, configPath);
      assert.equal(first.ok, true);
      assert.equal(first.unchanged, false);
      assert.match(readFileSync(configPath, "utf8"), /_poke-api/);
      assert.deepEqual(readSidecar(dir), { providers: ["poke-api"] });

      // 渠道删空：sidecar 还记着上一轮托管过什么，所以这一轮不能早退——
      // 必须走完合并把 config.toml 里的托管块清掉，否则脏模型列表永久残留。
      const emptied = await writeKimiConfig({ version: 2, providers: {} }, 47821, "tok", dir, configPath);
      assert.equal(emptied.ok, true);
      assert.equal(emptied.unchanged, false, "the stale managed block must be rewritten, not skipped");
      assert.doesNotMatch(readFileSync(configPath, "utf8"), /_poke-api/);
      assert.deepEqual(readSidecar(dir), { providers: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeKimiConfig 注入推理强度总开关的默认接线", () => {
  // effort 参数留空（生产形态）时的默认解析就是这段接线：开关缺省为开，
  // 开着才允许接管用户的 [thinking] 表、才把库里的档位写进托管块。
  // operator 库文件（thinking-efforts.db.json）按测试目录各自落盘——缓存按
  // 路径区分，夹具互不串线。
  const OPERATOR_DB = {
    models: {
      "mocha-9-thinker": { kind: "reasoning", levels: ["low", "high"], default: "high", wire: {}, thinkingFormat: null },
    },
  };
  function effortStore() {
    return {
      version: 2,
      providers: {
        "poke-api": {
          displayName: "Poke API",
          baseURL: "https://poke.example/v1",
          protocol: "openai-compatible",
          credentialFile: "poke-api.dpapi",
          models: { "mocha-9-thinker": { displayName: "Mocha", contextWindow: 100000 } },
        },
      },
    };
  }
  const seedThinkingConfig = (configPath) =>
    writeFileSync(configPath, 'default_model = "_x/m"\n\n[thinking]\nenabled = false\n', "utf8");

  it("缺省（无 settings.json）＝开：档位写进托管块、[thinking] 被接管、状态随结果返回", async () => {
    const dir = mkTestDir("kimi-effort-default-on-");
    writeFileSync(join(dir, "thinking-efforts.db.json"), JSON.stringify(OPERATOR_DB, null, 2), "utf8");
    const configPath = join(dir, "config.toml");
    seedThinkingConfig(configPath);

    const result = await writeKimiConfig(effortStore(), 47821, "tok", dir, configPath);
    assert.equal(result.ok, true);
    assert.equal(result.thinking, "updated", "接管状态必须随结果返回（面板文案消费它）");
    const text = readFileSync(configPath, "utf8");
    assert.match(text, /^enabled = true$/m, "总开关开着：用户的全局开关被接管");
    assert.match(text, /support_efforts = \["low", "high"\]/);
    assert.match(text, /default_effort = "high"/);
    assert.match(text, /capabilities = \["image_in", "thinking"\]/);
  });

  it("settings.json 写 injectThinkingEffort:false＝关：不写档位也不接管 [thinking]", async () => {
    const dir = mkTestDir("kimi-effort-off-");
    writeFileSync(join(dir, "thinking-efforts.db.json"), JSON.stringify(OPERATOR_DB, null, 2), "utf8");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ injectThinkingEffort: false }), "utf8");
    const configPath = join(dir, "config.toml");
    seedThinkingConfig(configPath);

    const result = await writeKimiConfig(effortStore(), 47821, "tok", dir, configPath);
    assert.equal(result.ok, true);
    assert.equal(result.thinking, undefined, "没接管就没有 thinking 状态");
    const text = readFileSync(configPath, "utf8");
    assert.match(text, /^enabled = false$/m, "开关关着：用户的 [thinking] 原样保留");
    assert.doesNotMatch(text, /support_efforts/);
    assert.doesNotMatch(text, /default_effort/);
    assert.doesNotMatch(text, /capabilities = \["image_in", "thinking"\]/);
    assert.match(text, /capabilities = \["image_in"\]/, "档位随开关停，image_in 不停：客户端图片入口与思考档位解耦");
  });

  it("settings.json 存在但没写这个键＝仍是默认开", async () => {
    const dir = mkTestDir("kimi-effort-unset-");
    writeFileSync(join(dir, "thinking-efforts.db.json"), JSON.stringify(OPERATOR_DB, null, 2), "utf8");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ keepAlive: { enabled: true, mode: "on" } }), "utf8");
    const configPath = join(dir, "config.toml");
    seedThinkingConfig(configPath);

    const result = await writeKimiConfig(effortStore(), 47821, "tok", dir, configPath);
    assert.equal(result.ok, true);
    assert.equal(result.thinking, "updated");
    assert.match(readFileSync(configPath, "utf8"), /support_efforts = \["low", "high"\]/);
  });
});

describe("main() argv 接线", () => {
  // main 的每个副作用入口都是注入缝：这里的 fake 全程零真实 relay、零真实
  // spawn。argv 被静默吞掉（kimiArgs 接错变量、丢参）时这里翻红。
  it("argv 原样跟队给子进程，退出码透传，relay 随之拆除", async () => {
    const { state, handle } = fakeRelay();
    const spawned = [];
    const code = await main(["--resume", "session-1"], {
      startRelay: async () => handle,
      spawnKimi: async ({ env, args }) => {
        spawned.push({ env, args });
        return 5;
      },
    });
    assert.equal(code, 5);
    assert.deepEqual(spawned[0].args, ["--resume", "session-1"]);
    assert.equal(spawned[0].env.ANTHROPIC_BASE_URL, "http://127.0.0.1:54321", "relay 形态的 env 注入照常生效");
    assert.equal(state.closed, true);
  });

  it("relay 起不来时 argv 仍原样跟队（原生回落）", async () => {
    const spawned = [];
    const logs = [];
    // main() 没有 base 注入缝，回落 env 是真实 process.env 的副本——宿主
    // shell 若已导出 ANTHROPIC_BASE_URL（anyswitch 注入型终端即会导出），
    // 断言会随宿主环境假红。这里先删掉该变量，钉住「继承环境里没有它」的
    // 前提，断言才专测回落路径自身不注入；跑完恢复原值，不漏给同进程
    // 的其他用例。
    const hadBaseUrl = "ANTHROPIC_BASE_URL" in process.env;
    const savedBaseUrl = process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
    try {
      const code = await main(["-p", "hi"], {
        startRelay: async () => {
          throw new Error("the Anyswitch global store is not usable");
        },
        spawnKimi: async ({ env, args }) => {
          spawned.push({ env, args });
          return 0;
        },
        log: (line) => logs.push(line),
        base: { PATH: "/usr/bin" },
      });
      assert.equal(code, 0);
      assert.deepEqual(spawned[0].args, ["-p", "hi"]);
      assert.equal(spawned[0].env.ANTHROPIC_BASE_URL, undefined, "回落形态不注入");
      assert.ok(logs.some((line) => line.includes("native configuration")));
    } finally {
      if (hadBaseUrl) process.env.ANTHROPIC_BASE_URL = savedBaseUrl;
    }
  });
});

