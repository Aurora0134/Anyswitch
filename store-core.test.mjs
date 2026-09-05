import assert from "node:assert/strict";
import test from "node:test";
import {
  buildV2AddEntry,
  classifyDiscovery,
  computeMigrationSeed,
  effectiveSetChanged,
  materializeModels,
  mergeModelIds,
  mergeV2RotateEntry,
  normalizeBaseURL,
  parseBaseURLs,
  parseJsonc,
  planAddModels,
  planDiscoveredRefresh,
  planRemoveModels,
  planStoreRefresh,
  providerModelsURL,
  sanitizeModelIds,
  validateBaseURL,
  validateFilterSave,
  validateProviderId,
} from "./store-core.mjs";

// Ported from a companion plugin's test suite (not shipped in this repository),
// keeping only the suites that cover the functions store-core.mjs carries.

test("validateProviderId accepts OpenCode provider IDs and rejects invalid ones", () => {
  assert.equal(validateProviderId("luminai-GPT-0.15x"), "luminai-GPT-0.15x");
  for (const providerId of ["", "invalid\nprovider", "a".repeat(129), 42, null]) {
    assert.throws(() => validateProviderId(providerId), /letters, digits/);
  }
});

test("providerModelsURL appends /models to a validated base URL", () => {
  assert.equal(providerModelsURL("https://api.example.com/v1"), "https://api.example.com/v1/models");
  assert.equal(providerModelsURL("https://api.example.com/v1/"), "https://api.example.com/v1/models");
  assert.equal(providerModelsURL("http://api.example.com/v1"), "http://api.example.com/v1/models");
});

test("JSONC parsing accepts a UTF-8 byte order mark", () => {
  const text = `﻿{"provider":{"first":{"options":{"baseURL":"https://first.example/v1"}}}}`;
  assert.equal(parseJsonc(text).provider.first.options.baseURL, "https://first.example/v1");
});

test("JSONC parsing accepts a UTF-8 byte order mark ahead of a leading comment", () => {
  const text = `﻿// managed by anyswitch\n{\n  "provider": {}\n}`;
  assert.deepEqual(parseJsonc(text).provider, {});
});

test("JSONC parsing tolerates trailing commas in objects and arrays, across comments", () => {
  const text = `{\n  // a comment between the comma and the closer\n  "models": ["a", "b",], /* and one here */\n  "provider": { "first": {}, },\n}`;
  const parsed = parseJsonc(text);
  assert.deepEqual(parsed.models, ["a", "b"]);
  assert.deepEqual(parsed.provider.first, {});
});

test("JSONC parsing leaves trailing-comma lookalikes inside string values verbatim", () => {
  // The comma stripper only runs outside strings: "x, }" and "x,]" are data,
  // not structure, and must survive the rewrite untouched.
  const text = `{ "hint": "x, }", "models": ["x,]"], "label": "trailing, ] too" }`;
  const parsed = parseJsonc(text);
  assert.equal(parsed.hint, "x, }");
  assert.deepEqual(parsed.models, ["x,]"]);
  assert.equal(parsed.label, "trailing, ] too");
});

test("JSONC parsing strips a trailing comma even after the last string value", () => {
  const parsed = parseJsonc(`{ "a": "x,]", }`);
  assert.equal(parsed.a, "x,]");
});

test("base URL validation allows HTTP and HTTPS for any host, rejects other schemes", () => {
  assert.equal(validateBaseURL("https://example.com/v1"), "https://example.com/v1");
  assert.equal(validateBaseURL("http://example.com/v1"), "http://example.com/v1");
  assert.equal(validateBaseURL("http://192.168.1.10:8000/v1"), "http://192.168.1.10:8000/v1");
  assert.equal(validateBaseURL("http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080/v1");
  assert.throws(() => validateBaseURL("https://user:pass@example.com/v1"), /credentials/);
  assert.throws(() => validateBaseURL("https://example.com/v1?api_key=secret"), /query/);
  assert.throws(() => validateBaseURL("file:///tmp/key"), /HTTP/);
});

test("base URL normalization adds HTTPS for bare public hosts and HTTP for loopback", () => {
  assert.equal(normalizeBaseURL("api.example.com/v1"), "https://api.example.com/v1");
  assert.equal(normalizeBaseURL("localhost:11434/v1"), "http://localhost:11434/v1");
  assert.equal(normalizeBaseURL("[::1]:11434/v1"), "http://[::1]:11434/v1");
  assert.equal(normalizeBaseURL("https://api.example.com/v1"), "https://api.example.com/v1");
  assert.equal(normalizeBaseURL("http://api.example.com/v1"), "http://api.example.com/v1");
  assert.equal(validateBaseURL("http://[::1]:11434/v1"), "http://[::1]:11434/v1");
});

// ---- parseBaseURLs: the add/rotate multi-URL prompt answer -------------
test("parseBaseURLs returns a single primary with no fallbackURLs key", () => {
  assert.deepEqual(parseBaseURLs("api.example.com/v1"), { baseURL: "https://api.example.com/v1" });
  assert.deepEqual(parseBaseURLs("  https://api.example.com/v1  "), { baseURL: "https://api.example.com/v1" });
});

test("parseBaseURLs splits a comma list primary-first with per-URL scheme completion", () => {
  assert.deepEqual(
    parseBaseURLs("api.example.com/v1, backup.example/v1/, https://other.example/v1"),
    {
      baseURL: "https://api.example.com/v1",
      fallbackURLs: ["https://backup.example/v1", "https://other.example/v1"],
    },
  );
  assert.equal(parseBaseURLs("localhost:11434/v1, localhost:11435/v1").baseURL, "http://localhost:11434/v1");
});

test("parseBaseURLs ignores empty segments around stray or trailing commas", () => {
  assert.deepEqual(
    parseBaseURLs("api.example.com/v1, , backup.example/v1,"),
    {
      baseURL: "https://api.example.com/v1",
      fallbackURLs: ["https://backup.example/v1"],
    },
  );
});

test("parseBaseURLs collapses a duplicate so a fallback never repeats the primary", () => {
  assert.deepEqual(parseBaseURLs("api.example.com/v1, api.example.com/v1"), {
    baseURL: "https://api.example.com/v1",
  });
});

test("parseBaseURLs rejects an answer with no usable URL", () => {
  assert.throws(() => parseBaseURLs(""), /Base URL is invalid/);
  assert.throws(() => parseBaseURLs(" , , "), /Base URL is invalid/);
  assert.throws(() => parseBaseURLs(null), /Base URL is invalid/);
});

test("parseBaseURLs validates fallback entries with the same rule as the primary", () => {
  assert.deepEqual(
    parseBaseURLs("api.example.com/v1, http://backup.example/v1"),
    { baseURL: "https://api.example.com/v1", fallbackURLs: ["http://backup.example/v1"] },
  );
  assert.throws(() => parseBaseURLs("api.example.com/v1, not a valid url at all"), /invalid/i);
});

test("buildV2AddEntry records ordered fallbackURLs only when at least one backup is named", () => {
  const base = { displayName: "P", baseURL: "https://api.example.com/v1", credentialFile: "p.dpapi", modelIds: ["gpt-4o"] };
  const withFallback = buildV2AddEntry({ ...base, fallbackURLs: ["https://b1.example/v1", "https://b2.example/v1"] });
  assert.deepEqual(withFallback.fallbackURLs, ["https://b1.example/v1", "https://b2.example/v1"]);

  const withoutFallback = buildV2AddEntry(base);
  assert.equal("fallbackURLs" in withoutFallback, false);

  const emptyFallback = buildV2AddEntry({ ...base, fallbackURLs: [] });
  assert.equal("fallbackURLs" in emptyFallback, false);
});

test("buildV2AddEntry seeds discovered, modelFilter and models from the probed ids", () => {
  const entry = buildV2AddEntry({
    displayName: "P",
    baseURL: "https://api.example.com/v1",
    credentialFile: "p.dpapi",
    modelIds: ["a", "b", "a"],
  });
  assert.deepEqual(Object.keys(entry.discovered), ["a", "b"]);
  assert.deepEqual(entry.modelFilter, ["a", "b"]);
  assert.deepEqual(Object.keys(entry.models), ["a", "b"]);
  assert.equal(entry.protocol, "openai-compatible");
});

test("mergeV2RotateEntry keeps, replaces, or drops the fallback group", () => {
  const existing = {
    displayName: "P",
    baseURL: "https://old.example/v1",
    fallbackURLs: ["https://old-backup.example/v1"],
    protocol: "openai-compatible",
    credentialFile: "p.dpapi",
    models: {},
    discovered: {},
    modelFilter: [],
  };
  // undefined keeps the existing group (plain key rotation / Enter to keep)
  const kept = mergeV2RotateEntry({ existing, baseURL: "https://old.example/v1", credentialFile: "p2.dpapi" });
  assert.deepEqual(kept.fallbackURLs, ["https://old-backup.example/v1"]);
  assert.equal(kept.credentialFile, "p2.dpapi");
  assert.notEqual(kept, existing);

  // a non-empty array replaces the whole group, and never mutates the input
  const replaced = mergeV2RotateEntry({
    existing,
    baseURL: "https://new.example/v1",
    fallbackURLs: ["https://new-backup.example/v1"],
    credentialFile: "p2.dpapi",
  });
  assert.equal(replaced.baseURL, "https://new.example/v1");
  assert.deepEqual(replaced.fallbackURLs, ["https://new-backup.example/v1"]);
  assert.deepEqual(existing.fallbackURLs, ["https://old-backup.example/v1"]);

  // an empty array drops the fallbacks entirely (single-URL rotate answer)
  const dropped = mergeV2RotateEntry({ existing, baseURL: "https://new.example/v1", fallbackURLs: [], credentialFile: "p2.dpapi" });
  assert.equal("fallbackURLs" in dropped, false);
});

test("model discovery data is deduplicated, trimmed, and capped", () => {
  assert.deepEqual(sanitizeModelIds([" model-a ", "model-b", "model-a", "", 42]), ["model-a", "model-b"]);
  assert.equal(sanitizeModelIds(Array.from({ length: 201 }, (_, index) => `model-${index}`)).length, 200);
  assert.throws(() => sanitizeModelIds([]), /no usable model IDs/);
});

test("classifyDiscovery marks a complete upstream result as prunable", () => {
  const result = classifyDiscovery({ rawIds: ["a", "b", "c"], sanitizedIds: ["a", "b", "c"] });
  assert.equal(result.complete, true);
  assert.equal(result.canPrune, true);
  assert.equal(result.reason, null);
});

test("classifyDiscovery refuses to prune on an empty result", () => {
  const result = classifyDiscovery({ rawIds: [], sanitizedIds: [] });
  assert.equal(result.complete, false);
  assert.equal(result.canPrune, false);
  assert.equal(result.reason, "empty");
});

test("classifyDiscovery refuses to prune when the sanitizer cap is reached", () => {
  const ids = Array.from({ length: 200 }, (_, index) => `model-${index}`);
  const result = classifyDiscovery({ rawIds: ids, sanitizedIds: ids });
  assert.equal(result.complete, false);
  assert.equal(result.canPrune, false);
  assert.equal(result.reason, "capped");
});

test("classifyDiscovery refuses to prune when the sanitizer dropped usable ids", () => {
  const result = classifyDiscovery({ rawIds: ["a", "b", "c"], sanitizedIds: ["a", "b"] });
  assert.equal(result.complete, false);
  assert.equal(result.canPrune, false);
  assert.equal(result.reason, "dropped");
});

test("mergeModelIds keeps surviving entries untouched and appends new ids with makeEntry", () => {
  const existing = {
    "[AN]claude-opus-4-6": { displayName: "[AN] Claude Opus 4-6" },
    "gpt-5.5": { displayName: "GPT 5.5", contextWindow: 922000, maxOutputTokens: 65536 },
  };
  const merged = mergeModelIds({
    existing,
    upstreamIds: ["[AN]claude-opus-4-6", "gpt-5.5", "brand-new"],
    canPrune: true,
    makeEntry: (id) => ({ displayName: id }),
  });
  assert.deepEqual(merged["[AN]claude-opus-4-6"], { displayName: "[AN] Claude Opus 4-6" });
  assert.deepEqual(merged["gpt-5.5"], { displayName: "GPT 5.5", contextWindow: 922000, maxOutputTokens: 65536 });
  assert.deepEqual(merged["brand-new"], { displayName: "brand-new" });
  assert.deepEqual(Object.keys(merged), ["[AN]claude-opus-4-6", "gpt-5.5", "brand-new"]);
  assert.notEqual(merged["gpt-5.5"], existing["gpt-5.5"]);
});

test("mergeModelIds prunes disappeared ids only when canPrune is true", () => {
  const existing = { keep: { displayName: "Keep" }, gone: { displayName: "Gone" } };
  const merged = mergeModelIds({
    existing,
    upstreamIds: ["keep"],
    canPrune: true,
    makeEntry: (id) => ({ displayName: id }),
  });
  assert.deepEqual(Object.keys(merged), ["keep"]);
});

test("mergeModelIds retains disappeared ids when canPrune is false", () => {
  const existing = { keep: { displayName: "Keep" }, gone: { displayName: "Gone" } };
  const merged = mergeModelIds({
    existing,
    upstreamIds: ["keep", "added"],
    canPrune: false,
    makeEntry: (id) => ({ displayName: id }),
  });
  assert.deepEqual(Object.keys(merged), ["keep", "gone", "added"]);
  assert.deepEqual(merged.added, { displayName: "added" });
});

test("mergeModelIds does not mutate the existing models object", () => {
  const existing = { keep: { displayName: "Keep" } };
  const merged = mergeModelIds({
    existing,
    upstreamIds: ["keep", "added"],
    canPrune: true,
    makeEntry: (id) => ({ displayName: id }),
  });
  assert.deepEqual(Object.keys(existing), ["keep"]);
  assert.notEqual(merged, existing);
});

test("computeMigrationSeed seeds discovered and modelFilter from the union so the effective set is unchanged", () => {
  const seed = computeMigrationSeed({
    storeModels: { "gpt-5.5": { displayName: "GPT 5.5", contextWindow: 922000 }, shared: { displayName: "Shared" } },
    configModels: { shared: { name: "Shared" }, "config-only": { name: "Config Only" } },
  });
  assert.deepEqual(Object.keys(seed.discovered), ["gpt-5.5", "shared", "config-only"]);
  assert.deepEqual(seed.discovered["gpt-5.5"], { displayName: "GPT 5.5", contextWindow: 922000 });
  assert.deepEqual(seed.discovered.shared, { displayName: "Shared" });
  assert.deepEqual(seed.discovered["config-only"], { displayName: "config-only" });
  assert.deepEqual(seed.modelFilter, ["gpt-5.5", "shared", "config-only"]);
  const effective = seed.modelFilter.filter((id) => Object.hasOwn(seed.discovered, id));
  assert.deepEqual(effective, ["gpt-5.5", "shared", "config-only"]);
  assert.equal(seed.drifted, true);
});

test("computeMigrationSeed reports no drift when both stores hold the same model ids", () => {
  const seed = computeMigrationSeed({
    storeModels: { a: { displayName: "A" }, b: { displayName: "B" } },
    configModels: { a: { name: "A" }, b: { name: "B" } },
  });
  assert.deepEqual(seed.modelFilter, ["a", "b"]);
  assert.equal(seed.drifted, false);
});

test("planDiscoveredRefresh merges upstream into discovered and prunes gone ids on a complete result", () => {
  const plan = planDiscoveredRefresh({
    rawIds: ["keep", "added"],
    sanitizedIds: ["keep", "added"],
    discovered: { keep: { displayName: "Keep Curated" }, gone: { displayName: "Gone" } },
  });
  assert.equal(plan.classification.complete, true);
  assert.equal(plan.classification.canPrune, true);
  assert.deepEqual(plan.added, ["added"]);
  assert.deepEqual(plan.pruned, ["gone"]);
  assert.deepEqual(Object.keys(plan.discovered), ["keep", "added"]);
  assert.deepEqual(plan.discovered.keep, { displayName: "Keep Curated" });
  assert.deepEqual(plan.discovered.added, { displayName: "added" });
  assert.equal(plan.changed, true);
});

test("planDiscoveredRefresh keeps discovered intact on an empty upstream result", () => {
  const plan = planDiscoveredRefresh({
    rawIds: [],
    sanitizedIds: [],
    discovered: { keep: { displayName: "Keep" } },
  });
  assert.equal(plan.classification.reason, "empty");
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.pruned, []);
  assert.deepEqual(Object.keys(plan.discovered), ["keep"]);
  assert.equal(plan.changed, false);
});

test("planDiscoveredRefresh adds without pruning when the sanitizer dropped usable ids", () => {
  const plan = planDiscoveredRefresh({
    rawIds: ["keep", "added", "dropped-by-sanitizer"],
    sanitizedIds: ["keep", "added"],
    discovered: { keep: { displayName: "Keep" }, gone: { displayName: "Gone" } },
  });
  assert.equal(plan.classification.reason, "dropped");
  assert.deepEqual(plan.added, ["added"]);
  assert.deepEqual(plan.pruned, []);
  assert.deepEqual(Object.keys(plan.discovered), ["keep", "gone", "added"]);
  assert.equal(plan.changed, true);
});

test("planDiscoveredRefresh does not mutate the input discovered object", () => {
  const discovered = { keep: { displayName: "Keep" } };
  planDiscoveredRefresh({ rawIds: ["keep", "added"], sanitizedIds: ["keep", "added"], discovered });
  assert.deepEqual(Object.keys(discovered), ["keep"]);
});

test("materializeModels projects the discovered-filter intersection into both store and config shapes", () => {
  const result = materializeModels({
    discovered: {
      "gpt-5.5": { displayName: "GPT 5.5", contextWindow: 922000 },
      shared: { displayName: "Shared" },
      "not-allowed": { displayName: "Not Allowed" },
    },
    modelFilter: ["shared", "gpt-5.5", "ghost-allowed"],
    configModels: { shared: { name: "Shared", modalities: { input: ["text"] } } },
  });
  assert.deepEqual(result.effective, ["shared", "gpt-5.5"]);
  assert.deepEqual(Object.keys(result.storeModels), ["shared", "gpt-5.5"]);
  assert.deepEqual(result.storeModels["gpt-5.5"], { displayName: "GPT 5.5", contextWindow: 922000 });
  assert.deepEqual(result.storeModels.shared, { displayName: "Shared" });
  assert.deepEqual(Object.keys(result.configModels), ["shared", "gpt-5.5"]);
  assert.deepEqual(result.configModels.shared, { name: "Shared", modalities: { input: ["text"] } });
  assert.deepEqual(result.configModels["gpt-5.5"], { name: "gpt-5.5" });
});

test("materializeModels yields an empty effective set when the filter selects nothing discovered", () => {
  const result = materializeModels({
    discovered: { a: { displayName: "A" } },
    modelFilter: ["ghost"],
    configModels: {},
  });
  assert.deepEqual(result.effective, []);
  assert.deepEqual(result.storeModels, {});
  assert.deepEqual(result.configModels, {});
});

test("validateFilterSave rejects an empty discovered set and points to refresh", () => {
  const result = validateFilterSave({ discovered: {}, modelFilter: ["keep"] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-discovered");
});

test("validateFilterSave rejects a filter whose intersection with discovered is empty", () => {
  const result = validateFilterSave({ discovered: { a: { displayName: "A" } }, modelFilter: ["ghost"] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty-effective");
});

test("validateFilterSave accepts a filter with a non-empty effective set", () => {
  const result = validateFilterSave({ discovered: { a: { displayName: "A" }, b: { displayName: "B" } }, modelFilter: ["a"] });
  assert.equal(result.ok, true);
});

test("effectiveSetChanged is false when the before and after id sets match regardless of order", () => {
  assert.equal(effectiveSetChanged({ before: ["a", "b", "c"], after: ["c", "a", "b"] }), false);
});

test("effectiveSetChanged is true when an id is added", () => {
  assert.equal(effectiveSetChanged({ before: ["a", "b"], after: ["a", "b", "c"] }), true);
});

test("effectiveSetChanged is true when an id is removed", () => {
  assert.equal(effectiveSetChanged({ before: ["a", "b", "c"], after: ["a", "b"] }), true);
});

test("effectiveSetChanged is false for two empty sets", () => {
  assert.equal(effectiveSetChanged({ before: [], after: [] }), false);
});

test("planStoreRefresh lazily migrates a legacy provider then applies discovered semantics as the source of truth", () => {
  const configText = `{
  "provider": {
    "alpha": {
      "options": { "baseURL": "https://alpha.example/v1" },
      "models": {
        "keep": { "name": "Keep", "modalities": { "input": ["text"] } },
        "gone": { "name": "Gone" }
      }
    }
  }
}`;
  const store = {
    version: 2,
    providers: {
      alpha: {
        displayName: "Alpha",
        baseURL: "https://alpha.example/v1",
        protocol: "openai-compatible",
        credentialFile: "alpha.dpapi",
        models: { keep: { displayName: "Keep Curated" }, gone: { displayName: "Gone" } },
      },
    },
  };
  const result = planStoreRefresh({
    configText,
    store,
    discoveries: [{ providerId: "alpha", rawIds: ["keep", "added"], sanitizedIds: ["keep", "added"] }],
  });
  const alpha = result.store.providers.alpha;
  // Migration seeds modelFilter from the old union and refresh leaves it alone (allow-list is user-owned).
  assert.deepEqual(alpha.modelFilter.sort(), ["gone", "keep"]);
  // A complete upstream prunes "gone" from discovered and adds "added".
  assert.deepEqual(Object.keys(alpha.discovered).sort(), ["added", "keep"]);
  // Effective = discovered ∩ modelFilter: only "keep" survives ("added" hidden, "gone" pruned from discovered).
  assert.deepEqual(Object.keys(alpha.models), ["keep"]);
  const report = result.reports.find((r) => r.providerId === "alpha");
  assert.equal(report.status, "updated");
});

test("planStoreRefresh keeps discovered and models intact when the upstream result is empty", () => {
  const configText = `{
  "provider": {
    "alpha": {
      "options": { "baseURL": "https://alpha.example/v1" },
      "models": { "keep": { "name": "Keep" } }
    }
  }
}`;
  const store = {
    version: 2,
    providers: {
      alpha: {
        displayName: "Alpha",
        baseURL: "https://alpha.example/v1",
        protocol: "openai-compatible",
        credentialFile: "alpha.dpapi",
        discovered: { keep: { displayName: "Keep" }, gone: { displayName: "Gone" } },
        modelFilter: ["keep"],
        models: { keep: { displayName: "Keep" } },
      },
    },
  };
  const result = planStoreRefresh({
    configText,
    store,
    discoveries: [{ providerId: "alpha", rawIds: [], sanitizedIds: [] }],
  });
  const alpha = result.store.providers.alpha;
  assert.deepEqual(Object.keys(alpha.discovered).sort(), ["gone", "keep"]);
  assert.deepEqual(alpha.modelFilter, ["keep"]);
  assert.deepEqual(Object.keys(alpha.models), ["keep"]);
  const report = result.reports.find((r) => r.providerId === "alpha");
  assert.equal(report.status, "failed");
  assert.equal(report.reason, "empty");
});

test("planStoreRefresh enriches discovered entries with rawModels metadata", () => {
  const configText = `{
  "provider": {
    "alpha": {
      "options": { "baseURL": "https://alpha.example/v1" },
      "models": { "m1": { "name": "M1" } }
    }
  }
}`;
  const store = {
    version: 2,
    providers: {
      alpha: {
        displayName: "Alpha",
        baseURL: "https://alpha.example/v1",
        protocol: "openai-compatible",
        credentialFile: "alpha.dpapi",
        discovered: { m1: { displayName: "M1" } },
        modelFilter: ["m1"],
        models: { m1: { displayName: "M1" } },
      },
    },
  };
  const result = planStoreRefresh({
    configText,
    store,
    discoveries: [{
      providerId: "alpha",
      rawIds: ["m1"],
      sanitizedIds: ["m1"],
      rawModels: [{
        id: "m1",
        contextWindow: 128000,
        maxOutputTokens: 8192,
      }],
    }],
  });
  const alpha = result.store.providers.alpha;
  const m1 = alpha.discovered.m1;
  assert.equal(m1.displayName, "M1");
  assert.equal(m1.contextWindow, 128000);
  assert.equal(m1.maxOutputTokens, 8192);
  // materializeModels deep-copies discovered → models
  const m1Model = alpha.models.m1;
  assert.equal(m1Model.contextWindow, 128000);
});

// Discovery no longer collects reasoning fields from upstream /v1/models
// (audited 2026-09-01: every provider's listing carries none, so the
// extraction only ever materialized empty metadata). Effort levels come from
// store annotations and the pi-ai knowledge base instead.
test("planStoreRefresh never copies reasoning fields from rawModels metadata", () => {
  const configText = `{
  "provider": {
    "alpha": {
      "options": { "baseURL": "https://alpha.example/v1" },
      "models": { "m1": { "name": "M1" } }
    }
  }
}`;
  const rawModels = [{
    id: "m1",
    supportsReasoning: true,
    reasoningEffortLevels: ["low", "medium", "high"],
    supports_reasoning: true,
    reasoning_effort_levels: ["low", "high"],
  }];
  const result = planStoreRefresh({
    configText,
    store: {
      version: 2,
      providers: {
        alpha: {
          displayName: "Alpha",
          baseURL: "https://alpha.example/v1",
          protocol: "openai-compatible",
          credentialFile: "alpha.dpapi",
          discovered: { m1: { displayName: "M1" } },
          modelFilter: ["m1"],
          models: { m1: { displayName: "M1" } },
        },
      },
    },
    discoveries: [{ providerId: "alpha", rawIds: ["m1"], sanitizedIds: ["m1"], rawModels }],
  });
  const m1 = result.store.providers.alpha.discovered.m1;
  assert.equal("supportsReasoning" in m1, false);
  assert.equal("reasoningEffortLevels" in m1, false);
  assert.equal("supports_reasoning" in m1, false);
  assert.equal("reasoning_effort_levels" in m1, false);
});

// ---- planAddModels: manual model add for upstream-missed models ----------
test("planAddModels rejects an input with no usable id as empty", () => {
  const entry = { discovered: { a: { displayName: "A" } }, modelFilter: ["a"], models: { a: { displayName: "A" } } };
  assert.deepEqual(planAddModels(entry, ["", "   ", 42, null]), { ok: false, reason: "empty" });
  assert.deepEqual(planAddModels(entry, []), { ok: false, reason: "empty" });
});

test("planAddModels rejects wholesale when any cleaned id is already discovered", () => {
  const entry = {
    discovered: { "kimi-k3": { displayName: "Kimi K3" }, other: { displayName: "Other" } },
    modelFilter: ["kimi-k3"],
    models: { "kimi-k3": { displayName: "Kimi K3" } },
  };
  const result = planAddModels(entry, ["brand-new", " kimi-k3 ", "other"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "model-exists");
  assert.deepEqual(result.duplicates, ["kimi-k3", "other"]);
  // wholesale rejection: the input entry is untouched, nothing partially added
  assert.deepEqual(Object.keys(entry.discovered), ["kimi-k3", "other"]);
  assert.deepEqual(entry.modelFilter, ["kimi-k3"]);
});

test("planAddModels cleans ids, marks them manual, appends the filter and re-materializes", () => {
  const entry = {
    displayName: "P",
    discovered: { a: { displayName: "A", contextWindow: 128000 } },
    modelFilter: ["a"],
    models: { a: { displayName: "A", contextWindow: 128000 } },
  };
  const result = planAddModels(entry, [" kimi-k3 ", "kimi-k3", "new-b", "bad\nid", 42]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.added, ["kimi-k3", "new-b"]);
  const next = result.nextEntry;
  assert.notEqual(next, entry);
  assert.deepEqual(next.discovered["kimi-k3"], { displayName: "kimi-k3", manual: true });
  assert.deepEqual(next.discovered["new-b"], { displayName: "new-b", manual: true });
  // existing discovered metadata is preserved
  assert.deepEqual(next.discovered.a, { displayName: "A", contextWindow: 128000 });
  assert.deepEqual(next.modelFilter, ["a", "kimi-k3", "new-b"]);
  assert.deepEqual(Object.keys(next.models), ["a", "kimi-k3", "new-b"]);
  assert.deepEqual(next.models["kimi-k3"], { displayName: "kimi-k3", manual: true });
  // the input entry is not mutated
  assert.deepEqual(Object.keys(entry.discovered), ["a"]);
  assert.deepEqual(entry.modelFilter, ["a"]);
  assert.deepEqual(Object.keys(entry.models), ["a"]);
});

test("planAddModels lazily migrates a legacy entry before adding", () => {
  const legacy = {
    displayName: "P",
    models: { "legacy-a": { displayName: "Legacy A" } },
  };
  const result = planAddModels(legacy, ["kimi-k3"]);
  assert.equal(result.ok, true);
  const next = result.nextEntry;
  // seed: legacy models become discovered + modelFilter
  assert.deepEqual(next.discovered["legacy-a"], { displayName: "Legacy A" });
  assert.deepEqual(next.modelFilter, ["legacy-a", "kimi-k3"]);
  assert.deepEqual(Object.keys(next.models), ["legacy-a", "kimi-k3"]);
  assert.equal("discovered" in legacy, false);

  // the duplicate check sees the lazily seeded ids too
  const dup = planAddModels(legacy, ["legacy-a"]);
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, "model-exists");
  assert.deepEqual(dup.duplicates, ["legacy-a"]);
});

// ---- planRemoveModels: removal of manual and discovered models -----------
test("planRemoveModels rejects an input with no usable id as empty", () => {
  const entry = { discovered: { a: { displayName: "A" } }, modelFilter: ["a"], models: { a: { displayName: "A" } } };
  assert.deepEqual(planRemoveModels(entry, ["", "   ", 42, null]), { ok: false, reason: "empty" });
  assert.deepEqual(planRemoveModels(entry, []), { ok: false, reason: "empty" });
});

test("planRemoveModels rejects wholesale when any cleaned id is not discovered", () => {
  const entry = {
    discovered: { "kimi-k3": { displayName: "Kimi K3" }, other: { displayName: "Other" } },
    modelFilter: ["kimi-k3", "other"],
    models: { "kimi-k3": { displayName: "Kimi K3" }, other: { displayName: "Other" } },
  };
  const result = planRemoveModels(entry, ["kimi-k3", " ghost ", "missing-too"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "model-not-found");
  assert.deepEqual(result.missing, ["ghost", "missing-too"]);
  // wholesale rejection: the input entry is untouched, nothing partially removed
  assert.deepEqual(Object.keys(entry.discovered), ["kimi-k3", "other"]);
  assert.deepEqual(entry.modelFilter, ["kimi-k3", "other"]);
});

test("planRemoveModels removes manual and discovered ids, keeps filter order and re-materializes", () => {
  const entry = {
    displayName: "P",
    discovered: {
      a: { displayName: "A", contextWindow: 128000 },
      "kimi-k3": { displayName: "kimi-k3", manual: true },
      b: { displayName: "B" },
    },
    modelFilter: ["a", "kimi-k3", "b"],
    models: {
      a: { displayName: "A", contextWindow: 128000 },
      "kimi-k3": { displayName: "kimi-k3", manual: true },
      b: { displayName: "B" },
    },
  };
  const result = planRemoveModels(entry, [" kimi-k3 ", "kimi-k3", "a", "bad\nid", 42]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, ["kimi-k3", "a"]);
  const next = result.nextEntry;
  assert.notEqual(next, entry);
  assert.deepEqual(Object.keys(next.discovered), ["b"]);
  assert.deepEqual(next.discovered.b, { displayName: "B" });
  // modelFilter order is preserved for the survivors
  assert.deepEqual(next.modelFilter, ["b"]);
  assert.deepEqual(Object.keys(next.models), ["b"]);
  // the input entry is not mutated
  assert.deepEqual(Object.keys(entry.discovered), ["a", "kimi-k3", "b"]);
  assert.deepEqual(entry.modelFilter, ["a", "kimi-k3", "b"]);
  assert.deepEqual(Object.keys(entry.models), ["a", "kimi-k3", "b"]);
});

test("planRemoveModels lazily migrates a legacy entry before removing", () => {
  const legacy = {
    displayName: "P",
    models: { "legacy-a": { displayName: "Legacy A" }, "legacy-b": { displayName: "Legacy B" } },
  };
  const result = planRemoveModels(legacy, ["legacy-a"]);
  assert.equal(result.ok, true);
  const next = result.nextEntry;
  // seed: legacy models become discovered + modelFilter, then legacy-a is dropped
  assert.deepEqual(Object.keys(next.discovered), ["legacy-b"]);
  assert.deepEqual(next.modelFilter, ["legacy-b"]);
  assert.deepEqual(Object.keys(next.models), ["legacy-b"]);
  assert.equal("discovered" in legacy, false);

  // the missing check sees the lazily seeded ids too
  const ghost = planRemoveModels(legacy, ["ghost"]);
  assert.equal(ghost.ok, false);
  assert.equal(ghost.reason, "model-not-found");
  assert.deepEqual(ghost.missing, ["ghost"]);
});

test("mergeModelIds keeps manual entries when pruning a complete upstream", () => {
  const existing = {
    keep: { displayName: "Keep" },
    manual: { displayName: "manual", manual: true },
    gone: { displayName: "Gone" },
  };
  const merged = mergeModelIds({
    existing,
    upstreamIds: ["keep"],
    canPrune: true,
    makeEntry: (id) => ({ displayName: id }),
  });
  assert.deepEqual(Object.keys(merged), ["keep", "manual"]);
  assert.deepEqual(merged.manual, { displayName: "manual", manual: true });
});

test("planDiscoveredRefresh excludes manual entries from the pruned list on a complete result", () => {
  const plan = planDiscoveredRefresh({
    rawIds: ["keep"],
    sanitizedIds: ["keep"],
    discovered: {
      keep: { displayName: "Keep" },
      manual: { displayName: "manual", manual: true },
      gone: { displayName: "Gone" },
    },
  });
  assert.equal(plan.classification.canPrune, true);
  assert.deepEqual(plan.pruned, ["gone"]);
  assert.deepEqual(Object.keys(plan.discovered).sort(), ["keep", "manual"]);
});

test("planStoreRefresh keeps a manually added model alive across a complete refresh", () => {
  const configText = `{
  "provider": {
    "sensenova": {
      "options": { "baseURL": "https://sensenova.example/v1" },
      "models": { "upstream-a": { "name": "Upstream A" } }
    }
  }
}`;
  const store = {
    version: 2,
    providers: {
      sensenova: {
        displayName: "SenseNova",
        baseURL: "https://sensenova.example/v1",
        protocol: "openai-compatible",
        credentialFile: "sensenova.dpapi",
        discovered: {
          "upstream-a": { displayName: "Upstream A" },
          "kimi-k3": { displayName: "kimi-k3", manual: true },
        },
        modelFilter: ["upstream-a", "kimi-k3"],
        models: {
          "upstream-a": { displayName: "Upstream A" },
          "kimi-k3": { displayName: "kimi-k3", manual: true },
        },
      },
    },
  };
  const result = planStoreRefresh({
    configText,
    store,
    discoveries: [{ providerId: "sensenova", rawIds: ["upstream-a"], sanitizedIds: ["upstream-a"] }],
  });
  const sensenova = result.store.providers.sensenova;
  // complete upstream that omits the manual model must not prune it
  assert.deepEqual(Object.keys(sensenova.discovered).sort(), ["kimi-k3", "upstream-a"]);
  assert.deepEqual(sensenova.modelFilter, ["upstream-a", "kimi-k3"]);
  assert.deepEqual(Object.keys(sensenova.models).sort(), ["kimi-k3", "upstream-a"]);
});

test("planStoreRefresh does not revive a removed manual model on a complete refresh", () => {
  const configText = `{
  "provider": {
    "sensenova": {
      "options": { "baseURL": "https://sensenova.example/v1" },
      "models": { "upstream-a": { "name": "Upstream A" } }
    }
  }
}`;
  const store = {
    version: 2,
    providers: {
      sensenova: {
        displayName: "SenseNova",
        baseURL: "https://sensenova.example/v1",
        protocol: "openai-compatible",
        credentialFile: "sensenova.dpapi",
        discovered: {
          "upstream-a": { displayName: "Upstream A" },
          "kimi-k3": { displayName: "kimi-k3", manual: true },
        },
        modelFilter: ["upstream-a", "kimi-k3"],
        models: {
          "upstream-a": { displayName: "Upstream A" },
          "kimi-k3": { displayName: "kimi-k3", manual: true },
        },
      },
    },
  };
  // remove the manual model, then refresh: the upstream does not report it,
  // so nothing re-seeds it — a removed manual model stays gone
  const removal = planRemoveModels(store.providers.sensenova, ["kimi-k3"]);
  assert.equal(removal.ok, true);
  store.providers.sensenova = removal.nextEntry;
  const result = planStoreRefresh({
    configText,
    store,
    discoveries: [{ providerId: "sensenova", rawIds: ["upstream-a"], sanitizedIds: ["upstream-a"] }],
  });
  const sensenova = result.store.providers.sensenova;
  assert.deepEqual(Object.keys(sensenova.discovered), ["upstream-a"]);
  assert.deepEqual(sensenova.modelFilter, ["upstream-a"]);
  assert.deepEqual(Object.keys(sensenova.models), ["upstream-a"]);
});

test("planStoreRefresh re-adds a removed discovered model to discovered but not to models", () => {
  const configText = `{
  "provider": {
    "sensenova": {
      "options": { "baseURL": "https://sensenova.example/v1" },
      "models": { "upstream-a": { "name": "Upstream A" } }
    }
  }
}`;
  const store = {
    version: 2,
    providers: {
      sensenova: {
        displayName: "SenseNova",
        baseURL: "https://sensenova.example/v1",
        protocol: "openai-compatible",
        credentialFile: "sensenova.dpapi",
        discovered: {
          "upstream-a": { displayName: "Upstream A" },
          "upstream-b": { displayName: "Upstream B" },
        },
        modelFilter: ["upstream-a", "upstream-b"],
        models: {
          "upstream-a": { displayName: "Upstream A" },
          "upstream-b": { displayName: "Upstream B" },
        },
      },
    },
  };
  // remove a discovered model, then refresh: the upstream still reports it,
  // so it returns to discovered, but modelFilter no longer lists it, so it
  // stays out of models (unchecked in the panel)
  const removal = planRemoveModels(store.providers.sensenova, ["upstream-b"]);
  assert.equal(removal.ok, true);
  store.providers.sensenova = removal.nextEntry;
  const result = planStoreRefresh({
    configText,
    store,
    discoveries: [{ providerId: "sensenova", rawIds: ["upstream-a", "upstream-b"], sanitizedIds: ["upstream-a", "upstream-b"] }],
  });
  const sensenova = result.store.providers.sensenova;
  assert.deepEqual(Object.keys(sensenova.discovered).sort(), ["upstream-a", "upstream-b"]);
  assert.deepEqual(sensenova.modelFilter, ["upstream-a"]);
  assert.deepEqual(Object.keys(sensenova.models), ["upstream-a"]);
  assert.deepEqual(result.reports[0].added, ["upstream-b"]);
});
