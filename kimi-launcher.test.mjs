// Kimi launcher tests. Same injected-dependency pattern as launcher.test.mjs:
// ZERO real spawn, ZERO real relay, ZERO real credentials.

import test from "node:test";
import assert from "node:assert/strict";
import { runKimiLauncher, buildKimiLauncherEnv, buildInstanceId } from "./kimi-launcher.mjs";
import { sanitizeInstanceId } from "./agent-metrics.mjs";

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
// a mock session tracker.
function fakeRelay({ tracker = null } = {}) {
  const state = { closed: false };
  return {
    state,
    handle: {
      port: 54321,
      token: "relay-session-token",
      sessionTracker: tracker,
      close: async () => {
        state.closed = true;
      },
    },
  };
}

function fakeTracker() {
  const calls = { pids: [], endCount: 0 };
  return {
    calls,
    tracker: {
      setClaudePid: (pid) => calls.pids.push(pid),
      reportEnd: () => {
        calls.endCount += 1;
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
  // 实例 id 必须通过 relay 侧的字符集校验，否则会被静默丢弃。
  assert.equal(sanitizeInstanceId("ws-1"), "ws-1");
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
  assert.ok(captured.instanceId.endsWith(`-${process.pid}`), "launcher pid is the discriminator");
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
  const { calls, tracker } = fakeTracker();
  const { state, handle } = fakeRelay({ tracker });
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
  assert.equal(calls.endCount, 1, "session end is reported before the relay is torn down");
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
