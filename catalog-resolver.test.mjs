import assert from "node:assert/strict";
import test from "node:test";
import { resolveProviderModels } from "./catalog-resolver.mjs";

// Contract (anyswitch update.txt lines 104-108):
//   modelId       = model.id   ?? config key
//   displayName   = model.name ?? config key
//   contextWindow = model.limit.context  (write only when present)
//   maxOutputTokens = model.limit.output (write only when present)
// The built-in `opencode` provider contributes whitelist ∪ models.
// All resolution is pure; no IO, no network. Synthetic input only.

test("uses config key as modelId and displayName when overrides absent", () => {
  const models = resolveProviderModels("deepseek", {
    models: { "deepseek-chat": {} },
  });
  assert.deepEqual(models, { "deepseek-chat": { displayName: "deepseek-chat" } });
});

test("model.id overrides the config key as modelId", () => {
  const models = resolveProviderModels("acme", {
    models: { "cfg-key": { id: "real-model-id" } },
  });
  assert.equal("real-model-id" in models, true);
  assert.equal("cfg-key" in models, false);
});

test("model.name overrides the config key as displayName", () => {
  const models = resolveProviderModels("acme", {
    models: { "m1": { name: "Pretty Name" } },
  });
  assert.equal(models["m1"].displayName, "Pretty Name");
});

test("contextWindow is written only when limit.context present", () => {
  const models = resolveProviderModels("acme", {
    models: {
      withCtx: { limit: { context: 128000 } },
      withoutCtx: { limit: {} },
      noLimit: {},
    },
  });
  assert.equal(models.withCtx.contextWindow, 128000);
  assert.equal("contextWindow" in models.withoutCtx, false);
  assert.equal("contextWindow" in models.noLimit, false);
});

test("maxOutputTokens is written only when limit.output present", () => {
  const models = resolveProviderModels("acme", {
    models: {
      withOut: { limit: { output: 16384 } },
      withoutOut: { limit: {} },
    },
  });
  assert.equal(models.withOut.maxOutputTokens, 16384);
  assert.equal("maxOutputTokens" in models.withoutOut, false);
});

test("both optional limits omitted when absent, displayName always present", () => {
  const models = resolveProviderModels("acme", { models: { m: {} } });
  assert.deepEqual(models.m, { displayName: "m" });
});

test("opencode provider contributes whitelist union models", () => {
  const models = resolveProviderModels("opencode", {
    whitelist: ["gpt-a", "gpt-b", "gpt-c"],
    models: { "gpt-a": { name: "GPT A override" } },
  });
  // whitelist entries all present
  assert.equal("gpt-a" in models, true);
  assert.equal("gpt-b" in models, true);
  assert.equal("gpt-c" in models, true);
  // explicit model override wins for displayName
  assert.equal(models["gpt-a"].displayName, "GPT A override");
  // whitelist-only entries fall back to key as displayName
  assert.equal(models["gpt-b"].displayName, "gpt-b");
});

test("non-opencode provider ignores whitelist", () => {
  const models = resolveProviderModels("acme", {
    whitelist: ["should-be-ignored"],
    models: { real: {} },
  });
  assert.equal("should-be-ignored" in models, false);
  assert.equal("real" in models, true);
});

test("empty or missing models yields empty catalog for non-opencode", () => {
  assert.deepEqual(resolveProviderModels("acme", {}), {});
  assert.deepEqual(resolveProviderModels("acme", { models: {} }), {});
});

test("opencode with model.id override remaps whitelist key when id differs", () => {
  // A whitelist key with an explicit id override should resolve under the id.
  const models = resolveProviderModels("opencode", {
    whitelist: ["wl-key"],
    models: { "wl-key": { id: "resolved-id" } },
  });
  assert.equal("resolved-id" in models, true);
});

// ---- reviewer blocking 3-resolver: contract fidelity --------------------
// Contract (anyswitch update.txt lines 104-108):
//   displayName = model.name ?? CONFIG KEY  (not the resolved id)
//   limit fields are written when PRESENT (value passed through as-is);
//   legality of the value is enforced by store-schema, not silently dropped
//   here, so an invalid catalog surfaces as a schema error instead of vanishing.

test("displayName falls back to the CONFIG KEY, not the resolved model id", () => {
  const models = resolveProviderModels("acme", {
    models: { "cfg-key": { id: "real-model-id" } },
  });
  // model resolves under its id...
  assert.equal("real-model-id" in models, true);
  // ...but with no explicit name, displayName must be the config key.
  assert.equal(models["real-model-id"].displayName, "cfg-key");
});

test("limit.context is written through as-is when the property is present", () => {
  const models = resolveProviderModels("acme", {
    models: { m: { limit: { context: 128000 } } },
  });
  assert.equal("contextWindow" in models.m, true);
  assert.equal(models.m.contextWindow, 128000);
});

test("a present-but-invalid limit is passed through (schema rejects it later), not silently dropped", () => {
  const models = resolveProviderModels("acme", {
    models: { bad: { limit: { context: 1.5, output: 0 } } },
  });
  // "write only when present" => the properties exist because limit had them.
  assert.equal("contextWindow" in models.bad, true);
  assert.equal("maxOutputTokens" in models.bad, true);
  assert.equal(models.bad.contextWindow, 1.5);
  assert.equal(models.bad.maxOutputTokens, 0);
});

test("absent limit fields are omitted", () => {
  const models = resolveProviderModels("acme", {
    models: {
      noLimit: {},
      emptyLimit: { limit: {} },
    },
  });
  assert.equal("contextWindow" in models.noLimit, false);
  assert.equal("maxOutputTokens" in models.noLimit, false);
  assert.equal("contextWindow" in models.emptyLimit, false);
  assert.equal("maxOutputTokens" in models.emptyLimit, false);
});
