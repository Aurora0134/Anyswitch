// Launcher tests.
//
// The launcher starts the relay, checks the Claude version, injects the relay
// endpoint + session token into a child Claude process, passes the terminal
// through, and tears the relay down when Claude exits. Every dependency is
// injected here, so these tests run with ZERO real spawn, ZERO real relay,
// ZERO real credentials and ZERO real network egress or API cost.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  runLauncher,
  buildLauncherEnv,
  EXPECTED_CLAUDE_VERSION,
  VERIFIED_CLAUDE_MINOR,
  isVerifiedDiscoveryVersion,
  resolveClaudeExecutable,
  defaultClaudeExecutable,
  DEFAULT_SMALL_FAST_MODEL_WIRE_ID,
  realGetClaudeVersion,
} from "./launcher.mjs";

// A fake relay handle that records whether it was closed.
function fakeRelay({ port = 54321, token = "relay-session-token" } = {}) {
  const state = { closed: false, closeCount: 0 };
  return {
    handle: {
      port,
      token,
      close: async () => {
        state.closed = true;
        state.closeCount += 1;
      },
    },
    state,
  };
}

function baseDeps(overrides = {}) {
  const { handle, state } = fakeRelay();
  const spawned = [];
  return {
    state,
    spawned,
    deps: {
      startRelay: async () => handle,
      getClaudeVersion: async () => EXPECTED_CLAUDE_VERSION,
      spawnClaude: async ({ env, args }) => {
        spawned.push({ env, args });
        return 0;
      },
      log: () => {},
      ...overrides,
    },
  };
}

test("buildLauncherEnv points Claude at the loopback relay and injects the token", () => {
  const env = buildLauncherEnv({
    port: 8080,
    token: "abc123",
    discovery: true,
    base: { PATH: "/usr/bin", EXISTING: "keep" },
  });
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8080");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "abc123");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.EXISTING, "keep");
});

test("buildLauncherEnv always sets NO_PROXY and no_proxy for loopback (load-bearing)", () => {
  const env = buildLauncherEnv({ port: 1, token: "t", discovery: true, base: {} });
  assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(env.no_proxy, "127.0.0.1,localhost");
});

test("buildLauncherEnv pins the classifier model to a stable wire ID by default", () => {
  const env = buildLauncherEnv({ port: 1, token: "t", discovery: true, base: {} });
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, DEFAULT_SMALL_FAST_MODEL_WIRE_ID);
  assert.match(env.ANTHROPIC_SMALL_FAST_MODEL, /^anthropic\/[^/]+\/[^/]+$/);
});

test("buildLauncherEnv honours an inherited ANTHROPIC_SMALL_FAST_MODEL override", () => {
  const env = buildLauncherEnv({
    port: 1,
    token: "t",
    discovery: true,
    base: { ANTHROPIC_SMALL_FAST_MODEL: "anthropic/my-provider/my-model" },
  });
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "anthropic/my-provider/my-model");
});

test("buildLauncherEnv honours ANYSWITCH_SMALL_FAST_MODEL when no explicit small-fast model is set", () => {
  const env = buildLauncherEnv({
    port: 1,
    token: "t",
    discovery: true,
    base: { ANYSWITCH_SMALL_FAST_MODEL: "anthropic/backup/flash" },
  });
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "anthropic/backup/flash");
});

test("buildLauncherEnv enables gateway discovery only when discovery is true", () => {
  const on = buildLauncherEnv({ port: 1, token: "t", discovery: true, base: {} });
  assert.equal(on.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");

  const off = buildLauncherEnv({ port: 1, token: "t", discovery: false, base: {} });
  assert.equal(off.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, undefined);
});

test("buildLauncherEnv strips an inherited ANTHROPIC_API_KEY so the relay token is the sole auth", () => {
  const env = buildLauncherEnv({
    port: 1,
    token: "t",
    discovery: true,
    base: { ANTHROPIC_API_KEY: "sk-real-anthropic-key" },
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("happy path: version matches, discovery enabled, token injected, relay closed after exit", async () => {
  const { deps, state, spawned } = baseDeps();
  const code = await runLauncher(deps);

  assert.equal(code, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].env.ANTHROPIC_BASE_URL, "http://127.0.0.1:54321");
  assert.equal(spawned[0].env.ANTHROPIC_AUTH_TOKEN, "relay-session-token");
  assert.equal(spawned[0].env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.equal(state.closed, true);
  assert.equal(state.closeCount, 1);
});

test("version mismatch: warns, disables discovery, still passes through, still closes relay", async () => {
  const logs = [];
  const { deps, state, spawned } = baseDeps({
    getClaudeVersion: async () => "9.9.9",
    log: (line) => logs.push(line),
  });
  const code = await runLauncher(deps);

  assert.equal(code, 0);
  assert.equal(spawned[0].env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, undefined);
  assert.ok(logs.some((l) => l.includes("9.9.9") && /discovery/i.test(l)));
  assert.equal(state.closed, true);
});

test("unknown version (Claude not found) is treated as a mismatch, discovery disabled", async () => {
  const logs = [];
  const { deps, spawned } = baseDeps({
    getClaudeVersion: async () => null,
    log: (line) => logs.push(line),
  });
  await runLauncher(deps);
  assert.equal(spawned[0].env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, undefined);
  assert.ok(logs.some((l) => /unknown/i.test(l) && /discovery/i.test(l)));
});

test("isVerifiedDiscoveryVersion accepts any patch in the verified minor family, rejects others", () => {
  // Any 2.1.x patch is verified (the discovery id-prefix filter does not change
  // across patch bumps), so a Claude auto-update within the family keeps the picker.
  assert.equal(isVerifiedDiscoveryVersion("2.1.220"), true);
  assert.equal(isVerifiedDiscoveryVersion("2.1.221"), true);
  assert.equal(isVerifiedDiscoveryVersion("2.1.0"), true);
  assert.equal(isVerifiedDiscoveryVersion("2.1.999"), true);
  // A minor or major jump is unverified until re-proven.
  assert.equal(isVerifiedDiscoveryVersion("2.2.0"), false);
  assert.equal(isVerifiedDiscoveryVersion("3.0.0"), false);
  assert.equal(isVerifiedDiscoveryVersion("2.0.220"), false);
  // Unknown / unparseable is never verified.
  assert.equal(isVerifiedDiscoveryVersion(null), false);
  assert.equal(isVerifiedDiscoveryVersion(undefined), false);
  assert.equal(isVerifiedDiscoveryVersion(""), false);
  assert.equal(isVerifiedDiscoveryVersion("2.1"), false);
  assert.equal(isVerifiedDiscoveryVersion("not-a-version"), false);
});

test("a patch bump within the verified family keeps discovery enabled (2.1.221)", async () => {
  const { deps, spawned } = baseDeps({
    getClaudeVersion: async () => "2.1.221",
  });
  const code = await runLauncher(deps);
  assert.equal(code, 0);
  assert.equal(spawned[0].env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
});

test("a minor jump outside the verified family disables discovery and warns", async () => {
  const logs = [];
  const { deps, spawned } = baseDeps({
    getClaudeVersion: async () => "2.2.0",
    log: (line) => logs.push(line),
  });
  await runLauncher(deps);
  assert.equal(spawned[0].env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, undefined);
  assert.ok(logs.some((l) => l.includes("2.2.0") && /discovery/i.test(l)));
});

test("child non-zero exit code is propagated, relay still closed", async () => {
  const { deps, state } = baseDeps({
    spawnClaude: async () => 7,
  });
  const code = await runLauncher(deps);
  assert.equal(code, 7);
  assert.equal(state.closed, true);
});

test("relay is closed even when spawning Claude throws", async () => {
  const { deps, state } = baseDeps({
    spawnClaude: async () => {
      throw new Error("spawn failed");
    },
  });
  await assert.rejects(() => runLauncher(deps), /spawn failed/);
  assert.equal(state.closed, true);
});

test("relay is closed even when the version check throws", async () => {
  const { deps, state } = baseDeps({
    getClaudeVersion: async () => {
      throw new Error("version probe failed");
    },
  });
  await assert.rejects(() => runLauncher(deps), /version probe failed/);
  assert.equal(state.closed, true);
});

test("if the relay refuses to start, Claude is never spawned", async () => {
  const spawned = [];
  await assert.rejects(
    () =>
      runLauncher({
        startRelay: async () => {
          throw new Error("the Anyswitch global store is not usable; refusing to start the relay");
        },
        getClaudeVersion: async () => EXPECTED_CLAUDE_VERSION,
        spawnClaude: async ({ env, args }) => {
          spawned.push({ env, args });
          return 0;
        },
        log: () => {},
      }),
    /not usable/,
  );
  assert.equal(spawned.length, 0);
});

test("the session token never appears in any log line", async () => {
  const logs = [];
  const { deps } = baseDeps({
    getClaudeVersion: async () => "9.9.9", // force the warning path too
    log: (line) => logs.push(line),
  });
  await runLauncher(deps);
  for (const line of logs) {
    assert.ok(!line.includes("relay-session-token"), `token leaked in log: ${line}`);
  }
});

test("claude args are forwarded to the spawned child", async () => {
  const { deps, spawned } = baseDeps({});
  await runLauncher({ ...deps, claudeArgs: ["--resume", "session-1"] });
  assert.deepEqual(spawned[0].args, ["--resume", "session-1"]);
});

test("inherited bad NO_PROXY/no_proxy values are overwritten with the loopback list (anti-bypass)", async () => {
  const { deps, spawned } = baseDeps({});
  await runLauncher({
    ...deps,
    base: { NO_PROXY: "example.com", no_proxy: "bad", PATH: "/usr/bin" },
  });
  assert.equal(spawned[0].env.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(spawned[0].env.no_proxy, "127.0.0.1,localhost");
  assert.equal(spawned[0].env.PATH, "/usr/bin");
});

test("an inherited discovery '1' cannot re-enable discovery on a version mismatch", async () => {
  const { deps, spawned } = baseDeps({
    getClaudeVersion: async () => "9.9.9",
  });
  await runLauncher({
    ...deps,
    base: { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1" },
  });
  assert.equal(spawned[0].env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, undefined);
});

test("an inherited ANTHROPIC_API_KEY is stripped on the full runLauncher path, token preserved", async () => {
  const { deps, spawned } = baseDeps({});
  await runLauncher({
    ...deps,
    base: { ANTHROPIC_API_KEY: "sk-real-anthropic-key" },
  });
  assert.equal(spawned[0].env.ANTHROPIC_API_KEY, undefined);
  assert.equal(spawned[0].env.ANTHROPIC_AUTH_TOKEN, "relay-session-token");
});

// --- CLAUDE_EXECUTABLE recursion guard -------------------------------------

test("resolveClaudeExecutable returns the default install path when no override is set", () => {
  const resolved = resolveClaudeExecutable({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" });
  assert.equal(resolved, defaultClaudeExecutable({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" }));
  assert.match(resolved, /claude\.exe$/i);
});

test("resolveClaudeExecutable honours an absolute .exe override", () => {
  const abs = "C:\\custom\\path\\claude.exe";
  assert.equal(resolveClaudeExecutable({ CLAUDE_EXECUTABLE: abs }), abs.replace(/\\/g, "/"));
});

test("resolveClaudeExecutable rejects a bare command name (would recurse into the shim)", () => {
  assert.throws(
    () => resolveClaudeExecutable({ CLAUDE_EXECUTABLE: "claude" }),
    /absolute path/i,
  );
});

test("resolveClaudeExecutable rejects a relative path override", () => {
  assert.throws(
    () => resolveClaudeExecutable({ CLAUDE_EXECUTABLE: ".\\claude.exe" }),
    /absolute path/i,
  );
});

test("resolveClaudeExecutable rejects an absolute .cmd/.ps1 shim override", () => {
  assert.throws(
    () => resolveClaudeExecutable({ CLAUDE_EXECUTABLE: "C:\\shim\\claude.cmd" }),
    /\.exe/i,
  );
  assert.throws(
    () => resolveClaudeExecutable({ CLAUDE_EXECUTABLE: "C:\\shim\\claude.ps1" }),
    /\.exe/i,
  );
});

test("resolveClaudeExecutable treats an empty override as unset", () => {
  const resolved = resolveClaudeExecutable({ CLAUDE_EXECUTABLE: "", APPDATA: "C:\\a" });
  assert.match(resolved, /claude\.exe$/i);
});

// --- realGetClaudeVersion deadline (B·进程与端口安全) ------------------------
//
// A hung `claude --version` must never block the launch forever: past the
// deadline the child is killed and the probe resolves null, which flows into
// the existing unknown-version downgrade path. Children are fakes — no real
// claude.exe is spawned.

function fakeVersionChild({ hang = false, output = "", error = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  if (error) {
    queueMicrotask(() => child.emit("error", new Error("spawn failed")));
  } else if (!hang) {
    queueMicrotask(() => {
      child.stdout.emit("data", output);
      child.emit("close", 0);
    });
  }
  return child;
}

test("realGetClaudeVersion resolves the semver token from the child's output", async () => {
  const version = await realGetClaudeVersion({
    spawnFn: () => fakeVersionChild({ output: "2.1.220 (Claude Code)\n" }),
    timeoutMs: 5_000,
  });
  assert.equal(version, "2.1.220");
});

test("realGetClaudeVersion resolves null when the child errors", async () => {
  const version = await realGetClaudeVersion({
    spawnFn: () => fakeVersionChild({ error: true }),
    timeoutMs: 5_000,
  });
  assert.equal(version, null);
});

test("realGetClaudeVersion kills a hung child at the deadline and resolves null", async () => {
  const child = fakeVersionChild({ hang: true });
  const version = await realGetClaudeVersion({
    spawnFn: () => child,
    timeoutMs: 50,
  });
  assert.equal(version, null, "timeout must downgrade to the unknown-version path, never throw");
  assert.equal(child.killed, true, "the hung child is killed at the deadline");
});
