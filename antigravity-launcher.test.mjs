import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  buildAntigravityEnv,
  buildInstanceId,
  launchAntigravity,
  main,
} from "./antigravity-launcher.mjs";

describe("antigravity launcher", () => {
  it("throws clear error when binary path does not exist", () => {
    assert.throws(
      () => launchAntigravity({ agyPath: "C:/nonexistent/path/agy.exe" }),
      /antigravity executable not found/,
    );
  });
});

describe("main", () => {
  // Regression: the entry point used to call launchAntigravity() with no
  // args, silently swallowing CLI flags like `--version` / `-p`.
  it("forwards CLI argv to launchAntigravity as spawn args", () => {
    const calls = [];
    const fakeChild = new EventEmitter(); // never emits "exit" in this test
    main(["--version", "-p", "hello"], (opts) => {
      calls.push(opts);
      return fakeChild;
    });
    assert.deepEqual(calls, [{ args: ["--version", "-p", "hello"] }]);
  });
});

describe("buildAntigravityEnv", () => {
  it("injects token, relay base URLs and NO_PROXY for loopback", () => {
    const env = buildAntigravityEnv({
      token: "tok",
      relayPort: 47821,
      base: { PATH: "C:\\Windows\\System32", HTTP_PROXY: "http://proxy:8080" },
    });
    assert.equal(env.GEMINI_API_KEY, "tok");
    assert.equal(env.GOOGLE_GEMINI_BASE_URL, "http://127.0.0.1:47821");
    assert.equal(env.GEMINI_BASE_URL, "http://127.0.0.1:47821");
    // Load-bearing: with HTTP_PROXY set, relay traffic must bypass the proxy
    // and stay on loopback (both variable casings, matching kimi-launcher).
    assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
    assert.equal(env.no_proxy, "127.0.0.1,localhost");
    assert.equal(env.HTTP_PROXY, "http://proxy:8080");
  });

  it("honors relayPort override and lets extraEnv win over built-ins", () => {
    const env = buildAntigravityEnv({
      token: "tok",
      relayPort: 9999,
      base: {},
      extraEnv: { GEMINI_API_KEY: "custom" },
    });
    assert.equal(env.GEMINI_BASE_URL, "http://127.0.0.1:9999");
    assert.equal(env.GEMINI_API_KEY, "custom");
    assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
  });

  it("appends .instanceId to GEMINI_API_KEY, leaving other fields unchanged", () => {
    const withId = buildAntigravityEnv({
      token: "tok",
      instanceId: "proj-123",
      relayPort: 47821,
      base: { PATH: "C:\\Windows\\System32", HTTP_PROXY: "http://proxy:8080" },
    });
    assert.equal(withId.GEMINI_API_KEY, "tok.proj-123");
    const withoutId = buildAntigravityEnv({
      token: "tok",
      relayPort: 47821,
      base: { PATH: "C:\\Windows\\System32", HTTP_PROXY: "http://proxy:8080" },
    });
    const { GEMINI_API_KEY: _a, ...restWith } = withId;
    const { GEMINI_API_KEY: _b, ...restWithout } = withoutId;
    assert.deepEqual(restWith, restWithout);
  });

  it("keeps GEMINI_API_KEY as the bare token when instanceId is absent/empty", () => {
    assert.equal(
      buildAntigravityEnv({ token: "tok", base: {} }).GEMINI_API_KEY,
      "tok",
    );
    assert.equal(
      buildAntigravityEnv({ token: "tok", instanceId: "", base: {} })
        .GEMINI_API_KEY,
      "tok",
    );
  });
});

describe("buildInstanceId", () => {
  it("builds <cwd basename>-<pid> and scrubs illegal characters", () => {
    assert.equal(
      buildInstanceId({ cwd: "C:\\work\\my proj [v2]", pid: 4242 }),
      "my-proj--v2--4242",
    );
    assert.equal(buildInstanceId({ cwd: "/home/u/app.dev", pid: 7 }), "app.dev-7");
  });

  it("falls back to <endpoint>-<pid> when the basename scrubs to empty", () => {
    assert.equal(buildInstanceId({ cwd: "/", pid: 99 }), "agy-99");
    assert.equal(buildInstanceId({ cwd: "C:\\", pid: 99 }), "agy-99");
  });

  it("caps the id at 64 characters", () => {
    const id = buildInstanceId({ cwd: `/x/${"a".repeat(100)}`, pid: 12345 });
    assert.equal(id.length, 64);
    assert.match(id, /^[A-Za-z0-9._:-]+$/);
  });
});
