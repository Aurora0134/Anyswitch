// Relay-port consistency guardrail.
//
// What these tests actually pin, stated exactly:
//   1. The production port value itself: openai-server.mjs's DEFAULT_RELAY_PORT
//      stays 47821. Renumbering it must be a conscious, coordinated change —
//      every guard below is phrased against this constant, so a renumber turns
//      them all red until each copy moves in the same change.
//   2. Every launcher's exported RELAY_PORT (8 launchers) equals
//      DEFAULT_RELAY_PORT. A value assertion cannot tell "imports the shared
//      constant" from "repeats the same literal"; what it does catch is any
//      launcher drifting onto a port other than the one the resident relay owns.
//   3. The copies of the number that still live outside openai-server.mjs:
//      agent-session-env.mjs exports AGENT_RELAY_PORT (asserted directly);
//      relay-process-manager.mjs and relay-host.mjs keep their constants
//      module-private — each is surfaced at runtime through an exported
//      function (getRelayStatus's injectable probe, describeRelayStartupFailure's
//      foreign-port detail); agent-sync-run.mjs exports nothing at all, so its
//      DEFAULT_PORT is pinned by source text.

import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_RELAY_PORT } from "./openai-server.mjs";
import { RELAY_PORT as ZCODE_RELAY_PORT } from "./zcode-launcher.mjs";
import { RELAY_PORT as ZCODE_CLI_RELAY_PORT } from "./zcode-cli-launcher.mjs";
import { RELAY_PORT as DSH_RELAY_PORT } from "./dsh-launcher.mjs";
import { RELAY_PORT as PI_RELAY_PORT } from "./pi-launcher.mjs";
import { RELAY_PORT as OPENCODE_RELAY_PORT } from "./opencode-launcher.mjs";
import { RELAY_PORT as QODER_RELAY_PORT } from "./qoder-launcher.mjs";
import { RELAY_PORT as CODEX_RELAY_PORT } from "./codex-launcher.mjs";
import { RELAY_PORT as GROK_RELAY_PORT } from "./grok-launcher.mjs";
import { AGENT_RELAY_PORT } from "./agent-session-env.mjs";
import { getRelayStatus } from "./relay-process-manager.mjs";
import { describeRelayStartupFailure } from "./relay-host.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

describe("relay port consistency", () => {
  it("pins the production relay port", () => {
    assert.equal(DEFAULT_RELAY_PORT, 47821);
  });

  it("every launcher exports the same port value as the shared constant", () => {
    assert.equal(ZCODE_RELAY_PORT, DEFAULT_RELAY_PORT, "zcode-launcher.mjs drifted off the shared relay port");
    assert.equal(ZCODE_CLI_RELAY_PORT, DEFAULT_RELAY_PORT, "zcode-cli-launcher.mjs drifted off the shared relay port");
    assert.equal(DSH_RELAY_PORT, DEFAULT_RELAY_PORT, "dsh-launcher.mjs drifted off the shared relay port");
    assert.equal(PI_RELAY_PORT, DEFAULT_RELAY_PORT, "pi-launcher.mjs drifted off the shared relay port");
    assert.equal(OPENCODE_RELAY_PORT, DEFAULT_RELAY_PORT, "opencode-launcher.mjs drifted off the shared relay port");
    assert.equal(QODER_RELAY_PORT, DEFAULT_RELAY_PORT, "qoder-launcher.mjs drifted off the shared relay port");
    assert.equal(CODEX_RELAY_PORT, DEFAULT_RELAY_PORT, "codex-launcher.mjs drifted off the shared relay port");
    assert.equal(GROK_RELAY_PORT, DEFAULT_RELAY_PORT, "grok-launcher.mjs drifted off the shared relay port");
  });

  it("agent-session-env rides the shared relay port", () => {
    assert.equal(AGENT_RELAY_PORT, DEFAULT_RELAY_PORT, "agent-session-env.mjs drifted off the shared relay port");
  });

  it("relay-process-manager probes and reports the shared port", async () => {
    // Its probe/ownership constant is module-private; the injected probe plus an
    // empty fixture root drive getRelayStatus down its stopped path, whose
    // status object carries that constant's real value.
    const status = await getRelayStatus(mkTestDir("relay-port-"), {
      probe: async () => false,
      findPortOwnerPid: async () => undefined,
      isPidAlive: () => false,
    });
    assert.equal(status.status, "stopped");
    assert.equal(status.port, DEFAULT_RELAY_PORT, "relay-process-manager.mjs drifted off the shared relay port");
  });

  it("relay-host's resident bind port matches the shared constant", () => {
    // relay-host.mjs's RELAY_PORT is module-private and is the port the resident
    // relay actually binds (startResidentRelay). describeRelayStartupFailure is
    // the exported pure path that surfaces that constant's value.
    const { detail } = describeRelayStartupFailure({ code: "RELAY_PORT_FOREIGN" }, 123);
    const reported = detail.match(/port (\d+) is held/)?.[1];
    assert.equal(reported, String(DEFAULT_RELAY_PORT), "relay-host.mjs drifted off the shared relay port");
  });

  it("agent-sync-run's fallback port matches the shared constant", () => {
    // agent-sync-run.mjs is an entry script that exports nothing, so its
    // DEFAULT_PORT can only be pinned by source text.
    const source = readFileSync(new URL("./agent-sync-run.mjs", import.meta.url), "utf8");
    assert.match(source, new RegExp(`const DEFAULT_PORT = ${DEFAULT_RELAY_PORT};`), "agent-sync-run.mjs drifted off the shared relay port");
  });
});
