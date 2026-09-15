// Relay-port consistency guardrail.
//
// The relay port is defined exactly once — openai-server.mjs's
// DEFAULT_RELAY_PORT — and every launcher binds that shared constant instead
// of a private copy. These tests pin the invariant so a hardcoded port fails
// here rather than drifting into a launcher that probes or binds a port other
// than the one the resident relay owns.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RELAY_PORT } from "./openai-server.mjs";
import { RELAY_PORT as ZCODE_RELAY_PORT } from "./zcode-launcher.mjs";
import { RELAY_PORT as DSH_RELAY_PORT } from "./dsh-launcher.mjs";
import { RELAY_PORT as PI_RELAY_PORT } from "./pi-launcher.mjs";
import { RELAY_PORT as OPENCODE_RELAY_PORT } from "./opencode-launcher.mjs";
import { RELAY_PORT as QODER_RELAY_PORT } from "./qoder-launcher.mjs";

describe("relay port has a single source of truth", () => {
  it("keeps the production relay port", () => {
    assert.equal(DEFAULT_RELAY_PORT, 47821);
  });

  it("every launcher binds the shared port, not a private copy", () => {
    assert.equal(ZCODE_RELAY_PORT, DEFAULT_RELAY_PORT);
    assert.equal(DSH_RELAY_PORT, DEFAULT_RELAY_PORT);
    assert.equal(PI_RELAY_PORT, DEFAULT_RELAY_PORT);
    assert.equal(OPENCODE_RELAY_PORT, DEFAULT_RELAY_PORT);
    assert.equal(QODER_RELAY_PORT, DEFAULT_RELAY_PORT);
  });
});
