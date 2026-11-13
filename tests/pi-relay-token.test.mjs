import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  loadOrGenerateToken,
  getChainPath,
  getUsagePath,
  rotateRelayToken,
  checkAndRotateRelayToken,
  createRelayTokenValidator,
  relayTokenAccepted,
  RELAY_TOKEN_ROTATE_INTERVAL_MS,
  RELAY_TOKEN_IDLE_TTL_MS,
  RELAY_TOKEN_CHAIN_CAP,
} from "../src/launchers/pi-relay-token.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

// Note: the token filename contract ("pi-relay-token") is asserted directly by
// these tests via existsSync/readFileSync/writeFileSync, which also covers the
// exported getTokenPath used internally by loadOrGenerateToken.

describe("loadOrGenerateToken", () => {
  it("generates and persists a token when none exists", () => {
    const dir = mkTestDir("pi-token-test-");
    const token = loadOrGenerateToken(dir);
    assert.equal(typeof token, "string");
    assert.equal(token.length, 64);
    assert.ok(existsSync(join(dir, "pi-relay-token")));
    const read = readFileSync(join(dir, "pi-relay-token"), "utf8").trim();
    assert.equal(read, token);
  });

  it("returns the same token on subsequent calls", () => {
    const dir = mkTestDir("pi-token-test-");
    const first = loadOrGenerateToken(dir);
    const second = loadOrGenerateToken(dir);
    assert.equal(first, second);
  });

  it("creates a missing root directory before writing (first boot on empty data root)", () => {
    const dir = mkTestDir("pi-token-test-");
    const root = join(dir, "empty-root");
    const token = loadOrGenerateToken(root);
    assert.equal(token.length, 64);
    assert.ok(existsSync(join(root, "pi-relay-token")));
  });

  it("reads existing token file", () => {
    const dir = mkTestDir("pi-token-test-");
    const path = join(dir, "pi-relay-token");
    writeFileSync(path, "my-persisted-token\n", "utf8");
    const token = loadOrGenerateToken(dir);
    assert.equal(token, "my-persisted-token");
  });
});

function makeClock(start) {
  const clock = { t: start };
  clock.now = () => clock.t;
  return clock;
}

describe("rotateRelayToken", () => {
  it("replaces the current generation and seeds the chain with the previous one", () => {
    const dir = mkTestDir("pi-token-test-");
    const first = loadOrGenerateToken(dir);
    const clock = makeClock(1_000_000);
    const rotated = rotateRelayToken(dir, { now: clock.now });
    assert.notEqual(rotated.token, first);
    assert.equal(rotated.previous, first);
    assert.equal(rotated.rotatedAt, 1_000_000);
    assert.equal(readFileSync(join(dir, "pi-relay-token"), "utf8").trim(), rotated.token);
    const chain = JSON.parse(readFileSync(getChainPath(dir), "utf8"));
    assert.equal(chain.length, 2);
    assert.equal(chain[0].token, rotated.token);
    assert.equal(chain[1].token, first);
    // The legacy generation is seeded at the first rotation's timestamp.
    assert.equal(chain[1].createdAt, 1_000_000);
  });

  it("preserves each generation's birth time across later rotations", () => {
    const dir = mkTestDir("pi-token-test-");
    const legacy = loadOrGenerateToken(dir);
    const clock = makeClock(1000);
    const r1 = rotateRelayToken(dir, { now: clock.now });
    clock.t = 5000;
    const r2 = rotateRelayToken(dir, { now: clock.now });
    const chain = JSON.parse(readFileSync(getChainPath(dir), "utf8"));
    assert.deepEqual(chain.map((g) => g.token), [r2.token, r1.token, legacy]);
    assert.equal(chain[1].createdAt, 1000);
    assert.equal(chain[2].createdAt, 1000);
  });

  it("caps the chain across many rotations", () => {
    const dir = mkTestDir("pi-token-test-");
    loadOrGenerateToken(dir);
    const clock = makeClock(0);
    for (let i = 0; i < RELAY_TOKEN_CHAIN_CAP + 3; i++) {
      clock.t += 1000;
      rotateRelayToken(dir, { now: clock.now });
    }
    const chain = JSON.parse(readFileSync(getChainPath(dir), "utf8"));
    assert.ok(chain.length <= RELAY_TOKEN_CHAIN_CAP);
  });
});

describe("checkAndRotateRelayToken", () => {
  it("is a no-op before the interval", () => {
    const dir = mkTestDir("pi-token-test-");
    const first = loadOrGenerateToken(dir);
    // Age the legacy token to just short of the exported weekly cadence (the
    // default interval): it must still hold fire — a default decoupled from the
    // constant, or the boundary itself off by one, rotates here and goes red.
    const clock = makeClock(Date.now());
    const justBeforeInterval = new Date(clock.t - (RELAY_TOKEN_ROTATE_INTERVAL_MS - 1000));
    utimesSync(join(dir, "pi-relay-token"), justBeforeInterval, justBeforeInterval);
    assert.equal(checkAndRotateRelayToken(dir, { now: clock.now }), null);
    assert.equal(readFileSync(join(dir, "pi-relay-token"), "utf8").trim(), first);
  });

  it("fires on legacy installs via the token file's mtime", () => {
    const dir = mkTestDir("pi-token-test-");
    const first = loadOrGenerateToken(dir);
    // Just past the exported weekly cadence: the default schedule fires.
    const clock = makeClock(Date.now());
    const justPastInterval = new Date(clock.t - (RELAY_TOKEN_ROTATE_INTERVAL_MS + 1000));
    utimesSync(join(dir, "pi-relay-token"), justPastInterval, justPastInterval);
    const rotated = checkAndRotateRelayToken(dir, { now: clock.now });
    assert.ok(rotated);
    assert.equal(rotated.previous, first);
  });

  it("resets the age after a rotation and re-fires once the interval passes", () => {
    const dir = mkTestDir("pi-token-test-");
    loadOrGenerateToken(dir);
    const tokenPath = join(dir, "pi-relay-token");
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    utimesSync(tokenPath, tenSecondsAgo, tenSecondsAgo);
    const clock = makeClock(Date.now());
    const rotated = checkAndRotateRelayToken(dir, { now: clock.now, intervalMs: 5000 });
    assert.ok(rotated);
    // The chain head was just born: a second check immediately after is a no-op.
    assert.equal(checkAndRotateRelayToken(dir, { now: clock.now, intervalMs: 5000 }), null);
    clock.t += 6000;
    assert.ok(checkAndRotateRelayToken(dir, { now: clock.now, intervalMs: 5000 }));
  });
});

describe("createRelayTokenValidator", () => {
  it("accepts the current generation and reports it via getCurrent", () => {
    const dir = mkTestDir("pi-token-test-");
    const first = loadOrGenerateToken(dir);
    const validator = createRelayTokenValidator(dir);
    assert.ok(validator.isValid(first));
    assert.equal(validator.getCurrent(), first);
    assert.ok(!validator.isValid("0".repeat(64)));
    validator.flush();
  });

  it("keeps a used chained generation alive and retires it after the idle TTL", () => {
    const dir = mkTestDir("pi-token-test-");
    const first = loadOrGenerateToken(dir);
    const clock = makeClock(1_000_000);
    const rotated = rotateRelayToken(dir, { now: clock.now });
    const validator = createRelayTokenValidator(dir, { now: clock.now });
    assert.ok(validator.isValid(rotated.token));
    assert.ok(validator.isValid(first));
    // Still alive well into the grace window (every accepted request refreshes
    // the generation's clock — sessions in use never hit the TTL).
    clock.t += 1000;
    assert.ok(validator.isValid(first));
    // Keep using it up to the end of the birth window, then once more with the
    // birth age already past the TTL: the refreshed last-used clock (2s ago)
    // must keep it alive — a retirement keyed on gen.createdAt alone would
    // already reject it here, so this point tells the two models apart.
    clock.t += RELAY_TOKEN_IDLE_TTL_MS - 2000;
    assert.ok(validator.isValid(first));
    clock.t += 2000;
    assert.ok(validator.isValid(first));
    // Idle for longer than the TTL with no use: retired. The generation stays
    // dead even though it is still chained.
    clock.t += RELAY_TOKEN_IDLE_TTL_MS + 1;
    assert.ok(!validator.isValid(first));
    // The current generation is never subject to the TTL.
    assert.ok(validator.isValid(rotated.token));
    validator.flush();
  });

  it("is strictly current-only while no chain file exists", () => {
    const dir = mkTestDir("pi-token-test-");
    const first = loadOrGenerateToken(dir);
    const other = loadOrGenerateToken(mkTestDir("pi-token-test-"));
    const validator = createRelayTokenValidator(dir);
    assert.ok(validator.isValid(first));
    assert.ok(!validator.isValid(other));
    validator.flush();
  });

  it("adopts an external rotation through its mtime cache", () => {
    const dir = mkTestDir("pi-token-test-");
    const first = loadOrGenerateToken(dir);
    const clock = makeClock(1_000_000);
    const validator = createRelayTokenValidator(dir, { now: clock.now });
    assert.ok(validator.isValid(first));
    // Rotate behind the validator's back, the way a running relay experiences it.
    const rotated = rotateRelayToken(dir, { now: clock.now });
    assert.equal(validator.getCurrent(), rotated.token);
    assert.ok(validator.isValid(rotated.token));
    assert.ok(validator.isValid(first));
    validator.flush();
  });

  it("restores last-used state across restarts and keeps retired generations retired", () => {
    const dir = mkTestDir("pi-token-test-");
    const first = loadOrGenerateToken(dir);
    const clock = makeClock(1_000_000);
    rotateRelayToken(dir, { now: clock.now });
    const v1 = createRelayTokenValidator(dir, { now: clock.now });
    assert.ok(v1.isValid(first));
    // Use the session deep into its birth window, then persist: the file must
    // carry the last touch, not the birth time, or a restart has nothing to
    // restore beyond gen.createdAt.
    clock.t += RELAY_TOKEN_IDLE_TTL_MS - 1000;
    assert.ok(v1.isValid(first));
    v1.flush();
    assert.deepEqual(JSON.parse(readFileSync(getUsagePath(dir), "utf8")), { [first]: clock.t });
    // Restart with the birth age already past the TTL: only the restored
    // last-used clock (2s ago) can keep the generation alive — a validator
    // falling back to gen.createdAt would retire it here.
    clock.t += 2000;
    const v2 = createRelayTokenValidator(dir, { now: clock.now });
    assert.ok(v2.isValid(first));
    // Idle past the TTL after the restart: retired again, restored state and all.
    clock.t += RELAY_TOKEN_IDLE_TTL_MS + 1;
    assert.ok(!v2.isValid(first));
    v2.flush();
  });

  it("prunes retired and unknown generations from the persisted usage map", () => {
    const dir = mkTestDir("pi-token-test-");
    const first = loadOrGenerateToken(dir);
    // An entry for a generation no file knows about (state from a chain that
    // was capped away or a manual edit) must not survive a persist.
    writeFileSync(getUsagePath(dir), JSON.stringify({ "orphan-generation": 1 }), "utf8");
    const clock = makeClock(1_000_000);
    rotateRelayToken(dir, { now: clock.now });
    const validator = createRelayTokenValidator(dir, { now: clock.now });
    assert.ok(validator.isValid(first));
    clock.t += 1000;
    validator.flush();
    assert.deepEqual(JSON.parse(readFileSync(getUsagePath(dir), "utf8")), { [first]: 1_000_000 });
    clock.t += RELAY_TOKEN_IDLE_TTL_MS + 1;
    validator.flush();
    // Once the generation is retired, its entry is dropped instead of
    // carrying dead state across a restart.
    assert.deepEqual(JSON.parse(readFileSync(getUsagePath(dir), "utf8")), {});
    validator.flush();
  });

  it("rejection does not refresh a retired generation's clock", () => {
    const dir = mkTestDir("pi-token-test-");
    const first = loadOrGenerateToken(dir);
    const clock = makeClock(1_000_000);
    const rotated = rotateRelayToken(dir, { now: clock.now });
    const validator = createRelayTokenValidator(dir, { now: clock.now });
    assert.ok(validator.isValid(first));
    clock.t += RELAY_TOKEN_IDLE_TTL_MS + 1;
    assert.ok(!validator.isValid(first));
    // If the rejection itself refreshed the generation's clock, each retry
    // a tick later would look freshly used and revive it forever.
    clock.t += 1000;
    assert.ok(!validator.isValid(first));
    clock.t += 1000;
    assert.ok(!validator.isValid(first));
    // The current generation is never subject to the TTL.
    assert.ok(validator.isValid(rotated.token));
    validator.flush();
  });
});

describe("relayTokenAccepted", () => {
  it("delegates to the validator when present", () => {
    let asked = null;
    const deps = { tokenValidator: { isValid: (presented) => { asked = presented; return presented === "ok"; } } };
    assert.ok(relayTokenAccepted(deps, "ok"));
    assert.equal(asked, "ok");
    assert.ok(!relayTokenAccepted(deps, "no"));
  });

  it("keeps the strict constant-time compare as the {token} fallback", () => {
    const token = "a".repeat(64);
    assert.ok(relayTokenAccepted({ token }, token));
    assert.ok(!relayTokenAccepted({ token }, "b".repeat(64)));
    assert.ok(!relayTokenAccepted({ token }, ""));
    assert.ok(!relayTokenAccepted({ token }, null));
    assert.ok(!relayTokenAccepted({}, token));
    assert.ok(!relayTokenAccepted({}, null));
  });
});
