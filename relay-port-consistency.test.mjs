// Relay-port consistency guardrail.
//
// The relay port used to be hardcoded in six places (five launchers plus
// openai-server.mjs). It is now defined exactly once — openai-server.mjs's
// DEFAULT_RELAY_PORT — and every launcher binds that shared constant instead
// of a private copy. These tests pin the invariant so a future re-hardcoded
// port fails here instead of drifting into a launcher that probes or binds a
// different port than the resident relay owns.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RELAY_PORT } from "./openai-server.mjs";
import { RELAY_PORT as ZCODE_RELAY_PORT } from "./zcode-launcher.mjs";
import { RELAY_PORT as DSH_RELAY_PORT } from "./dsh-launcher.mjs";
import { RELAY_PORT as PI_RELAY_PORT } from "./pi-launcher.mjs";
import { RELAY_PORT as REASONIX_RELAY_PORT } from "./reasonix-launcher.mjs";
import { RELAY_PORT as OPENCODE_RELAY_PORT } from "./opencode-launcher.mjs";

describe("relay port has a single source of truth", () => {
  it("keeps the production relay port", () => {
    assert.equal(DEFAULT_RELAY_PORT, 47821);
  });

  it("every launcher binds the shared port, not a private copy", () => {
    assert.equal(ZCODE_RELAY_PORT, DEFAULT_RELAY_PORT);
    assert.equal(DSH_RELAY_PORT, DEFAULT_RELAY_PORT);
    assert.equal(PI_RELAY_PORT, DEFAULT_RELAY_PORT);
    assert.equal(REASONIX_RELAY_PORT, DEFAULT_RELAY_PORT);
    assert.equal(OPENCODE_RELAY_PORT, DEFAULT_RELAY_PORT);
  });
});
