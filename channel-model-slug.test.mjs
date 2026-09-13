import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CHANNEL_MODEL_SEPARATOR,
  packChannelModelSlug,
  unpackChannelModelSlug,
  buildChannelModelSlugCatalog,
} from "./channel-model-slug.mjs";

const STORE = {
  version: 2,
  providers: {
    "poke-api": {
      displayName: "Poke API",
      baseURL: "https://upstream.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "poke-api.dpapi",
      models: {
        "claude-opus-5": { displayName: "Claude Opus 5" },
        "openai/gpt-5.6-luna": {},
      },
    },
    nim: {
      baseURL: "https://nim.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "nim.dpapi",
      models: { "claude-opus-5": {} },
    },
    "absorbed-member": {
      baseURL: "https://member.invalid/v1",
      protocol: "openai-compatible",
      credentialFile: "member.dpapi",
      models: { "m-1": {} },
    },
  },
  pools: {
    "my-pool": { displayName: "My Pool", members: ["absorbed-member"] },
  },
};

describe("packChannelModelSlug", () => {
  it("joins channel and model with the separator", () => {
    assert.equal(packChannelModelSlug("poke-api", "claude-opus-5"), "poke-api~claude-opus-5");
  });

  it("rejects empty parts and a separator in the channel id", () => {
    assert.throws(() => packChannelModelSlug("", "m"));
    assert.throws(() => packChannelModelSlug("c", ""));
    assert.throws(() => packChannelModelSlug("a~b", "m"));
  });
});

describe("unpackChannelModelSlug", () => {
  it("splits on the FIRST separator, keeping slashes and later tildes in the model id", () => {
    assert.deepEqual(unpackChannelModelSlug("poke-api~openai/gpt-5.6-luna", STORE), {
      channelId: "poke-api",
      modelId: "openai/gpt-5.6-luna",
      pool: false,
    });
    assert.deepEqual(unpackChannelModelSlug("poke-api~m~x", STORE)?.modelId, "m~x");
  });

  it("resolves pools before providers", () => {
    assert.deepEqual(unpackChannelModelSlug("my-pool~m-1", STORE), {
      channelId: "my-pool",
      modelId: "m-1",
      pool: true,
    });
  });

  it("keeps pool-absorbed members resolvable (runtime leniency)", () => {
    assert.deepEqual(unpackChannelModelSlug("absorbed-member~m-1", STORE), {
      channelId: "absorbed-member",
      modelId: "m-1",
      pool: false,
    });
  });

  it("returns null for bare model ids, unknown channels and malformed shapes", () => {
    assert.equal(unpackChannelModelSlug("claude-opus-5", STORE), null);
    assert.equal(unpackChannelModelSlug("no-such-channel~m", STORE), null);
    assert.equal(unpackChannelModelSlug("~m", STORE), null);
    assert.equal(unpackChannelModelSlug("poke-api~", STORE), null);
    assert.equal(unpackChannelModelSlug(undefined, STORE), null);
    assert.equal(unpackChannelModelSlug(42, STORE), null);
  });
});

describe("buildChannelModelSlugCatalog", () => {
  it("emits one entry per (channel, model) pair with the channel label in displayName", () => {
    const catalog = buildChannelModelSlugCatalog(STORE);
    const bySlug = new Map(catalog.map((entry) => [entry.slug, entry]));
    // The absorbed member does not surface; the pool does (visible-channel semantics).
    assert.deepEqual(
      [...bySlug.keys()].sort(),
      ["my-pool~m-1", "nim~claude-opus-5", "poke-api~claude-opus-5", "poke-api~openai/gpt-5.6-luna"].sort(),
    );
    assert.equal(bySlug.get("poke-api~claude-opus-5").displayName, "Claude Opus 5 · Poke API");
    assert.equal(bySlug.get("nim~claude-opus-5").displayName, "claude-opus-5 · nim", "falls back to model id and provider id");
    assert.equal(bySlug.get("my-pool~m-1").displayName, "m-1 · My Pool", "pools label with the pool displayName");
  });

  it("uses the literal separator constant", () => {
    assert.equal(CHANNEL_MODEL_SEPARATOR, "~");
  });
});
