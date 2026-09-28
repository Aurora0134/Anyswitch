// Shared sidecar read/write (merge-common.mjs) — the single implementation
// behind the five per-agent merge modules' readSidecar/writeSidecar wrappers.
// These tests pin the on-disk contract those wrappers must keep exposing:
// one JSON object { "providers": [ids…] } — sorted, 2-space indent, trailing
// newline, written atomically — and a fail-open read (missing or corrupt file
// reads back as an empty managed list, because the sidecar is a cache of
// "what we injected last time", never user data).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSidecar, writeSidecar, deriveAutoRouteChannel, deriveAnyswitchChannel } from "./merge-common.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

describe("merge-common sidecar", () => {
  it("reads a missing sidecar as an empty managed list", () => {
    const dir = mkTestDir("merge-common-");
    assert.deepEqual(readSidecar(join(dir, "x-sidecar.json")), { providers: [] });
  });

  it("reads a corrupt sidecar as an empty managed list", () => {
    const dir = mkTestDir("merge-common-");
    const path = join(dir, "x-sidecar.json");
    writeFileSync(path, "{ not json");
    assert.deepEqual(readSidecar(path), { providers: [] });
  });

  it("round-trips a provider list sorted", () => {
    const dir = mkTestDir("merge-common-");
    const path = join(dir, "x-sidecar.json");
    writeSidecar(path, ["zeta", "alpha", "mid"]);
    assert.deepEqual(readSidecar(path), { providers: ["alpha", "mid", "zeta"] });
  });

  it("writes the exact on-disk format the merge modules always used", () => {
    const dir = mkTestDir("merge-common-");
    const path = join(dir, "x-sidecar.json");
    writeSidecar(path, ["b", "a"]);
    assert.equal(
      readFileSync(path, "utf8"),
      '{\n  "providers": [\n    "a",\n    "b"\n  ]\n}\n',
    );
  });

  it("creates the parent directory when it does not exist yet", () => {
    const dir = mkTestDir("merge-common-");
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
    assert.equal(channel.channelName, "Anyswitch");
    // The base URL segment is the chain HEAD node, never the literal "auto".
    assert.equal(channel.baseUrlSegment, "poke-api");
    assert.deepEqual(Object.keys(channel.models), ["auto"]);
    // 模型显示名 = "auto"（provider 显示名已归「Anyswitch」分组，模型侧保
    // 留裸触发词——它是链路由触发词，不是真模型）。
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

describe("deriveAnyswitchChannel（Anyswitch 分组：auto + 虚拟模型）", () => {
  const store = {
    providers: { "poke-api": { models: { m1: {} } }, "nim": { models: { m2: {} } } },
    routingChains: {
      zcode: { chain: [{ node: "poke-api", model: "claude-opus-5" }] },
    },
    virtualModels: [
      { name: "my-chain", chain: [{ node: "nim", model: "deepseek-chat" }] },
      { name: "off-one", enabled: false, chain: [{ node: "poke-api", model: "m1" }] },
    ],
  };

  it("auto 与启用的虚拟模型同组，provider 显示名 Anyswitch", () => {
    const channel = deriveAnyswitchChannel(store, "zcode");
    assert.equal(channel.channelName, "Anyswitch");
    assert.deepEqual(Object.keys(channel.models), ["auto", "my-chain"], "auto + 启用中的虚拟模型");
    assert.equal(channel.models["my-chain"].displayName, "my-chain", "虚拟模型显示名 = 裸名");
    assert.equal(channel.baseUrlSegment, "poke-api", "有 auto 链时段取 auto 链头");
  });

  it("端点无 auto 链时 URL 段取第一个虚拟模型的链头；停用虚拟模型不出组", () => {
    const channel = deriveAnyswitchChannel(store, "dsh");
    assert.deepEqual(Object.keys(channel.models), ["my-chain"], "无 auto 链则无 auto 模型");
    assert.equal(channel.baseUrlSegment, "nim");
  });

  it("无 auto 链且无启用虚拟模型 → null（托管块由既有清理路径移除）", () => {
    assert.equal(deriveAnyswitchChannel({ providers: {} }, "kimi"), null);
    const onlyOff = { providers: store.providers, virtualModels: [{ name: "off-one", enabled: false, chain: [{ node: "poke-api", model: "m1" }] }] };
    assert.equal(deriveAnyswitchChannel(onlyOff, "kimi"), null);
  });

  it("链为空的虚拟模型不出组；缺 helpers 的脏数据不至于抛", () => {
    const dirty = { providers: store.providers, virtualModels: [{ name: "empty", chain: [] }, "oops", null, { chain: [{ node: "nim", model: "m2" }] }] };
    assert.equal(deriveAnyswitchChannel(dirty, "kimi"), null);
  });
});
