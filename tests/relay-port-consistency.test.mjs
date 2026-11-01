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
//      relay-process-manager.mjs re-exports the shared constant (panel.mjs
//      builds from it); relay-host.mjs keeps its constant module-private —
//      surfaced at runtime through an exported function (getRelayStatus's
//      injectable probe, describeRelayStartupFailure's foreign-port detail);
//      agent-sync-run.mjs exports nothing at all, so its DEFAULT_PORT is
//      pinned by source text.
//   4. The converged surfaces carry no bare literal at all: panel.mjs,
//      launch.mjs and agent-metrics.mjs must build every relay-facing URL,
//      origin and port from the shared constant (a negative pin turns any
//      re-appearance of the hand-written literal red), uninstall-agent.mjs's
//      strip placeholder aliases the constant by source text, and the
//      module-free browser face carries exactly one mirror constant in
//      panel-ui/panel.js while panel.html's static placeholders are pinned
//      by source text.

import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_RELAY_PORT } from "../src/relay/openai-server.mjs";
import { RELAY_PORT as ZCODE_RELAY_PORT } from "../src/launchers/zcode-launcher.mjs";
import { RELAY_PORT as ZCODE_CLI_RELAY_PORT } from "../src/launchers/zcode-cli-launcher.mjs";
import { RELAY_PORT as DSH_RELAY_PORT } from "../src/launchers/dsh-launcher.mjs";
import { RELAY_PORT as PI_RELAY_PORT } from "../src/launchers/pi-launcher.mjs";
import { RELAY_PORT as OPENCODE_RELAY_PORT } from "../src/launchers/opencode-launcher.mjs";
import { RELAY_PORT as QODER_RELAY_PORT } from "../src/launchers/qoder-launcher.mjs";
import { RELAY_PORT as CODEX_RELAY_PORT } from "../src/launchers/codex-launcher.mjs";
import { RELAY_PORT as GROK_RELAY_PORT } from "../src/launchers/grok-launcher.mjs";
import { AGENT_RELAY_PORT } from "../src/agents/agent-session-env.mjs";
import { getRelayStatus, RELAY_PORT } from "../src/relay/relay-process-manager.mjs";
import { describeRelayStartupFailure } from "../src/relay/relay-host.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

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
    const source = readFileSync(new URL("../src/agents/agent-sync-run.mjs", import.meta.url), "utf8");
    assert.match(source, new RegExp(`const DEFAULT_PORT = ${DEFAULT_RELAY_PORT};`), "agent-sync-run.mjs drifted off the shared relay port");
  });

  it("relay-process-manager re-exports the shared port constant", () => {
    assert.equal(RELAY_PORT, DEFAULT_RELAY_PORT, "relay-process-manager.mjs drifted off the shared relay port");
  });

  it("panel.mjs builds every relay-facing URL and port from the shared constant", () => {
    // Converged surface: no bare literal anywhere (comments included), and the
    // canonical build shapes must stay in place — the negative half is what
    // turns a re-appearance of a hand-written port red.
    const source = readFileSync(new URL("../src/panel/panel.mjs", import.meta.url), "utf8");
    assert.ok(!source.includes(String(DEFAULT_RELAY_PORT)), "panel.mjs still carries a bare relay-port literal; build it from RELAY_PORT instead");
    assert.match(source, /url\.port === String\(RELAY_PORT\)/, "panel.mjs's mutation-port check must compare against RELAY_PORT");
    assert.match(source, /`http:\/\/127\.0\.0\.1:\$\{RELAY_PORT\}/, "panel.mjs's relay fetches must build URLs from RELAY_PORT");
    assert.match(source, /port: RELAY_PORT[,}]/, "panel.mjs's status frame and sync spawns must carry RELAY_PORT");
  });

  it("launch.mjs builds the session report URL from the shared constant", () => {
    const source = readFileSync(new URL("../src/launchers/launch.mjs", import.meta.url), "utf8");
    assert.ok(!source.includes(String(DEFAULT_RELAY_PORT)), "launch.mjs still carries a bare relay-port literal");
    assert.match(source, /reportUrl: `http:\/\/127\.0\.0\.1:\$\{DEFAULT_RELAY_PORT\}\/panel\/api\/session\/report`/, "launch.mjs drifted off the shared relay port");
  });

  it("uninstall-agent's strip placeholder aliases the shared port", () => {
    const source = readFileSync(new URL("../src/ops/uninstall-agent.mjs", import.meta.url), "utf8");
    assert.match(source, /const STRIP_PORT = DEFAULT_RELAY_PORT;/, "uninstall-agent.mjs drifted off the shared relay port");
  });

  it("agent-metrics derives the report origin from the report URL itself", () => {
    const source = readFileSync(new URL("../src/agents/agent-metrics.mjs", import.meta.url), "utf8");
    assert.ok(!source.includes(String(DEFAULT_RELAY_PORT)), "agent-metrics.mjs still carries a bare relay-port literal");
    assert.match(source, /origin: new URL\(reportUrl\)\.origin/, "the session reporter's Origin header must be derived from reportUrl");
  });

  it("the browser face carries exactly one mirror constant and pinned HTML placeholders", () => {
    // panel.js is a module-free browser script: it cannot import the shared
    // constant, so it keeps a single mirror whose value this pin controls.
    const panelJs = readFileSync(new URL("../panel-ui/panel.js", import.meta.url), "utf8");
    assert.equal(panelJs.split(String(DEFAULT_RELAY_PORT)).length - 1, 1, "panel-ui/panel.js must carry the relay port only as the RELAY_PORT mirror constant");
    assert.match(panelJs, new RegExp(`const RELAY_PORT = ${DEFAULT_RELAY_PORT};`), "panel-ui/panel.js's RELAY_PORT mirror drifted off the shared relay port");
    const panelHtml = readFileSync(new URL("../panel-ui/panel.html", import.meta.url), "utf8");
    assert.match(panelHtml, new RegExp(`Relay 运行中 \\(${DEFAULT_RELAY_PORT}\\)`), "panel.html's relay status placeholder drifted off the shared relay port");
    assert.match(panelHtml, new RegExp(`127\\.0\\.0\\.1:${DEFAULT_RELAY_PORT}`), "panel.html's host placeholder drifted off the shared relay port");
  });
});
