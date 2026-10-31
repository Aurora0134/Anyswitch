// launcher-native-fallback tests. Pure dependency injection — no sockets, no
// disk, no real relay. The launchers' own test files cover the per-endpoint
// wiring; this file pins the shared acquisition contract itself.

import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireRelayOrNative,
  buildNativeLauncherEnv,
  loadNativeSyncToken,
} from "./launcher-native-fallback.mjs";

function recording(overrides = {}) {
  const logs = [];
  return {
    logs,
    log: (line) => logs.push(line),
    endpoint: "grok",
    port: 47821,
    ...overrides,
  };
}

const perLaunchRelay = { port: 47821, token: "per-launch-token", close: async () => {} };

test("resident probe hit returns the resident handle and never starts a relay", async () => {
  const deps = recording({
    probeRelay: async () => true,
    residentRelay: async () => ({ port: 47821, token: "shared-token", close: async () => {}, reused: true }),
    startRelay: async () => { throw new Error("must not be called"); },
  });

  const relay = await acquireRelayOrNative(deps);

  assert.equal(relay.token, "shared-token");
  assert.equal(relay.reused, true);
  assert.ok(deps.logs.some((l) => l.includes("resident relay already running on 47821")));
});

test("probe miss starts the per-launch relay", async () => {
  let started = 0;
  let residentCalls = 0;
  const deps = recording({
    probeRelay: async () => false,
    residentRelay: async () => { residentCalls += 1; return perLaunchRelay; },
    startRelay: async () => { started += 1; return perLaunchRelay; },
  });

  const relay = await acquireRelayOrNative(deps);

  assert.equal(relay, perLaunchRelay);
  assert.equal(started, 1);
  assert.equal(residentCalls, 0, "a probe miss must go straight to startRelay, never consult the resident handle");
});

test("a throwing probe falls through to the per-launch relay", async () => {
  let residentCalls = 0;
  const deps = recording({
    probeRelay: async () => { throw new Error("connect ECONNREFUSED"); },
    residentRelay: async () => { residentCalls += 1; return perLaunchRelay; },
    startRelay: async () => perLaunchRelay,
  });

  const relay = await acquireRelayOrNative(deps);

  assert.equal(relay, perLaunchRelay);
  assert.equal(residentCalls, 0, "a throwing probe must not consult the resident handle");
  assert.ok(deps.logs.some((l) => l.includes("probe failed") && l.includes("falling back to per-launch relay")));
});

test("a failing resident-handle build falls through to the per-launch relay", async () => {
  const deps = recording({
    probeRelay: async () => true,
    residentRelay: async () => { throw new Error("token file unreadable"); },
    startRelay: async () => perLaunchRelay,
  });

  const relay = await acquireRelayOrNative(deps);

  assert.equal(relay, perLaunchRelay);
  assert.ok(deps.logs.some((l) => l.includes("resident relay reuse failed") && l.includes("token file unreadable")));
});

test("both levels failing returns null and logs the native launch instead of throwing", async () => {
  let residentCalls = 0;
  const deps = recording({
    probeRelay: async () => false,
    residentRelay: async () => { residentCalls += 1; return perLaunchRelay; },
    startRelay: async () => {
      throw Object.assign(new Error("port 47821 is in use by another process"), { code: "RELAY_PORT_FOREIGN" });
    },
  });

  const relay = await acquireRelayOrNative(deps);

  assert.equal(relay, null);
  assert.equal(residentCalls, 0, "a probe miss must not consult the resident handle even when startRelay also fails");
  assert.ok(
    deps.logs.some((l) =>
      l.includes("Anyswitch relay unavailable") &&
      l.includes("port 47821 is in use by another process") &&
      l.includes("launching grok with its native configuration")),
  );
});

test("a launcher without a probe level (codex/opencode) goes native when startRelay fails", async () => {
  const deps = recording({
    endpoint: "codex",
    startRelay: async () => { throw new Error("the Anyswitch global store is not usable"); },
  });

  const relay = await acquireRelayOrNative(deps);

  assert.equal(relay, null);
  assert.ok(deps.logs.some((l) => l.includes("launching codex with its native configuration")));
});

test("buildNativeLauncherEnv passes the base through verbatim — no injection, no stripping", () => {
  const base = {
    PATH: "/usr/bin",
    XAI_API_KEY: "xai-real-key",
    HTTP_PROXY: "http://proxy",
  };
  const env = buildNativeLauncherEnv({ base });
  assert.deepEqual(env, base);
  assert.notEqual(env, base, "must be a copy, not the caller's object");
  assert.equal("ANYSWITCH_RELAY_TOKEN" in env, false);
  assert.equal("ANYSWITCH_INSTANCE_ID" in env, false);
  assert.equal("ANYSWITCH_AGENT_INSTANCE" in env, false);
  assert.equal("NO_PROXY" in env, false);
});

test("loadNativeSyncToken returns the shared token, and only logs + skips when it is unreadable", async () => {
  const deps = recording({ loadToken: () => "shared-token" });
  assert.equal(loadNativeSyncToken({ loadToken: deps.loadToken, root: "R", endpoint: "grok", log: deps.log }), "shared-token");

  const broken = recording();
  const token = loadNativeSyncToken({
    loadToken: () => { throw new Error("disk on fire"); },
    root: "R",
    endpoint: "grok",
    log: broken.log,
  });
  assert.equal(token, null);
  assert.ok(broken.logs.some((l) => l.includes("relay token unavailable") && l.includes("disk on fire")));
});
