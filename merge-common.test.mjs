// Shared sidecar read/write (merge-common.mjs) — the single implementation
// behind the five per-agent merge modules' readSidecar/writeSidecar wrappers.
// These tests pin the on-disk contract those wrappers must keep exposing:
// one JSON object { "providers": [ids…] } — sorted, 2-space indent, trailing
// newline, written atomically — and a fail-open read (missing or corrupt file
// reads back as an empty managed list, because the sidecar is a cache of
// "what we injected last time", never user data).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSidecar, writeSidecar, deriveAutoRouteChannel } from "./merge-common.mjs";

describe("merge-common sidecar", () => {
  it("reads a missing sidecar as an empty managed list", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-common-"));
    assert.deepEqual(readSidecar(join(dir, "x-sidecar.json")), { providers: [] });
  });

  it("reads a corrupt sidecar as an empty managed list", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-common-"));
    const path = join(dir, "x-sidecar.json");
    writeFileSync(path, "{ not json");
    assert.deepEqual(readSidecar(path), { providers: [] });
  });

  it("round-trips a provider list sorted", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-common-"));
    const path = join(dir, "x-sidecar.json");
    writeSidecar(path, ["zeta", "alpha", "mid"]);
    assert.deepEqual(readSidecar(path), { providers: ["alpha", "mid", "zeta"] });
  });

  it("writes the exact on-disk format the merge modules always used", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-common-"));
    const path = join(dir, "x-sidecar.json");
    writeSidecar(path, ["b", "a"]);
    assert.equal(
      readFileSync(path, "utf8"),
      '{\n  "providers": [\n    "a",\n    "b"\n  ]\n}\n',
    );
  });

  it("creates the parent directory when it does not exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-common-"));
    const path = join(dir, "nested", "deeper", "x-sidecar.json");
    writeSidecar(path, ["only"]);
    assert.deepEqual(readSidecar(path), { providers: ["only"] });
  });
});

describe("deriveAutoRouteChannel", () => {
  const chainStore = {
    providers: {
      "poke-api": { models: { "claude-opus-5": {} } },
      "nvidia-nim": { models: { "deepseek-chat": {} } },
    },
    routingChains: {
      zcode: {
        chain: [
          { node: "poke-api", model: "claude-opus-5" },
          { node: "nvidia-nim", model: "deepseek-chat" },
        ],
      },
    },
  };

  it("derives the virtual auto channel from the endpoint's chain head", () => {
    const channel = deriveAutoRouteChannel(chainStore, "zcode");
    assert.equal(channel.channelName, "自动路由");
    // The base URL segment is the chain HEAD node, never the literal "auto".
    assert.equal(channel.baseUrlSegment, "poke-api");
    assert.deepEqual(Object.keys(channel.models), ["auto"]);
    // 模型显示名 = "auto"（与 provider 显示名「自动路由」对调后的口径）。
    assert.equal(channel.models.auto.displayName, "auto");
  });

  it("returns null when the endpoint has no route chain", () => {
    assert.equal(deriveAutoRouteChannel(chainStore, "dsh"), null);
    assert.equal(deriveAutoRouteChannel({ providers: {} }, "zcode"), null);
    assert.equal(deriveAutoRouteChannel({}, "zcode"), null);
    assert.equal(deriveAutoRouteChannel(null, "zcode"), null);
    assert.equal(deriveAutoRouteChannel(undefined, "zcode"), null);
  });

  it("returns null for an empty or malformed chain", () => {
    assert.equal(deriveAutoRouteChannel({ routingChains: { zcode: { chain: [] } } }, "zcode"), null);
    assert.equal(deriveAutoRouteChannel({ routingChains: { zcode: { chain: "nope" } } }, "zcode"), null);
    assert.equal(deriveAutoRouteChannel({ routingChains: { zcode: {} } }, "zcode"), null);
    assert.equal(deriveAutoRouteChannel({ routingChains: { zcode: { chain: [{ model: "m" }] } } }, "zcode"), null);
    assert.equal(deriveAutoRouteChannel({ routingChains: { zcode: { chain: [{ node: "", model: "m" }] } } }, "zcode"), null);
  });

  it("returns null when the chain is disabled (enabled: false)；缺省/显式 true 照常派生", () => {
    // per-endpoint 启用开关：关 = 链配置保留，但 _auto 伪渠道不再同步进 agent 配置。
    const disabled = {
      ...chainStore,
      routingChains: { zcode: { ...chainStore.routingChains.zcode, enabled: false } },
    };
    assert.equal(deriveAutoRouteChannel(disabled, "zcode"), null);
    const enabled = {
      ...chainStore,
      routingChains: { zcode: { ...chainStore.routingChains.zcode, enabled: true } },
    };
    assert.ok(deriveAutoRouteChannel(enabled, "zcode") !== null);
    assert.ok(deriveAutoRouteChannel(chainStore, "zcode") !== null, "absent enabled = enabled");
  });
});
