import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeModelId,
  effortLookupKeys,
  isNonTextModel,
  normalizeEffortEntry,
  loadEffortCatalog,
  getEffortCatalog,
  clearEffortCatalogCache,
  resolveModelEfforts,
  pickDefaultEffort,
  effortWireValue,
  intersectEffortVocabulary,
  intersectReasonixEfforts,
  modelEffortSurface,
  OPTIMISTIC_EFFORT_LEVELS,
} from "./effort-catalog.mjs";

function fakeFs(files) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    statSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
      return { mtimeMs: files[p].length, size: files[p].length };
    },
  };
}

function dbWith(models) {
  return JSON.stringify({ version: 1, models });
}

const SAMPLE_MODELS = {
  "glm-5.3": {
    levels: ["medium", "high", "xhigh", "max"],
    default: "high",
    confidence: "high",
    kind: "reasoning",
  },
  "deepseek-v4-flash": {
    levels: ["high", "xhigh", "max"],
    default: "high",
    wire: { minimal: "minimal", low: "low", medium: "medium", high: "high", max: "max", xhigh: null },
    thinkingFormat: "deepseek",
    kind: "reasoning",
  },
  "agnes-image-2.0-flash": { levels: null, default: null, kind: "non-text" },
  "claude-opus-4-7": { levels: ["minimal", "high", "xhigh", "max"], default: "high", kind: "reasoning" },
};

describe("canonicalizeModelId", () => {
  it("strips repeated bracket prefixes and effort tails", () => {
    assert.equal(canonicalizeModelId("[次][AN]gemini-3.7-flash"), "gemini-3.7-flash");
    assert.equal(canonicalizeModelId("claude-opus-4.7-max-thinking"), "claude-opus-4.7");
    assert.equal(canonicalizeModelId("kimi-k2.5-thinking"), "kimi-k2.5");
    assert.equal(canonicalizeModelId("gpt-5.6-sol-light"), "gpt-5.6-sol");
  });

  it("keeps variant words that name a different model", () => {
    assert.equal(canonicalizeModelId("glm-5.3-flash"), "glm-5.3-flash");
    assert.equal(canonicalizeModelId("qwen3.8-max-preview"), "qwen3.8-max-preview");
    assert.equal(canonicalizeModelId("gpt-5.6-luna"), "gpt-5.6-luna");
  });

  it("drops date tails, namespaces and reorders Claude family names", () => {
    assert.equal(canonicalizeModelId("deepseek-v4-20260315"), "deepseek-v4");
    assert.equal(canonicalizeModelId("go/mimo-v2.5-pro"), "mimo-v2.5-pro");
    assert.equal(canonicalizeModelId("claude-4.6-sonnet"), "claude-sonnet-4-6");
  });

  it("returns an empty string for non-string input", () => {
    assert.equal(canonicalizeModelId(undefined), "");
    assert.equal(canonicalizeModelId(null), "");
  });
});

describe("effortLookupKeys", () => {
  it("carries both dot and dash spellings of a versioned id", () => {
    const keys = effortLookupKeys("claude-opus-4.7-high-thinking");
    assert.ok(keys.includes("claude-opus-4.7"));
    assert.ok(keys.includes("claude-opus-4-7"), "generator re-keys rows to the most frequent spelling");
    assert.equal(keys.indexOf("claude-opus-4-7") < keys.indexOf("claude-opus-4.7-high-thinking"), true);
  });

  it("folds a reversed Claude name onto the library key", () => {
    assert.ok(effortLookupKeys("claude-4.6-sonnet").includes("claude-sonnet-4-6"));
  });
});

describe("isNonTextModel", () => {
  it("recognizes non-text families by raw id and canonical id", () => {
    assert.equal(isNonTextModel("text-embedding-v3"), true);
    assert.equal(isNonTextModel("[次]agnes-image-2.0-flash"), true);
    assert.equal(isNonTextModel("glm-5.3"), false);
  });
});

describe("normalizeEffortEntry", () => {
  it("accepts a well-formed reasoning row", () => {
    assert.deepEqual(normalizeEffortEntry(SAMPLE_MODELS["glm-5.3"]), {
      kind: "reasoning",
      levels: ["medium", "high", "xhigh", "max"],
      default: "high",
      wire: {},
      thinkingFormat: null,
    });
  });

  it("treats a non-text row as an explicit empty level set", () => {
    assert.deepEqual(normalizeEffortEntry(SAMPLE_MODELS["agnes-image-2.0-flash"]), {
      kind: "non-text", levels: [], wire: {}, thinkingFormat: null,
    });
    assert.equal(normalizeEffortEntry({ kind: "non-text", levels: ["high"] }), null);
  });

  it("drops unknown levels and dedupes, rejecting a row left with none", () => {
    assert.deepEqual(normalizeEffortEntry({ kind: "reasoning", levels: ["turbo"] }), null);
    assert.deepEqual(
      normalizeEffortEntry({ kind: "reasoning", levels: ["high", "high", "ultra", "max"] }).levels,
      ["high", "max"],
    );
  });

  it("keeps 'light', the gpt-5.6+ lightest level", () => {
    assert.deepEqual(
      normalizeEffortEntry({ kind: "reasoning", levels: ["light", "medium", "high", "xhigh", "max"], default: "high" }).levels,
      ["light", "medium", "high", "xhigh", "max"],
    );
  });

  it("refuses to default to a level the model does not offer", () => {
    assert.equal(normalizeEffortEntry({ kind: "reasoning", levels: ["high"], default: "max" }).default, null);
  });

  it("rejects non-objects and empty level arrays", () => {
    assert.equal(normalizeEffortEntry(null), null);
    assert.equal(normalizeEffortEntry([]), null);
    assert.equal(normalizeEffortEntry({ kind: "reasoning", levels: [] }), null);
  });
});

describe("loadEffortCatalog", () => {
  it("reports a missing file instead of throwing", () => {
    const catalog = loadEffortCatalog("C:/nowhere/thinking-efforts.db.json", fakeFs({}));
    assert.equal(catalog.warning, "missing");
    assert.equal(catalog.loadedCount, 0);
  });

  it("reports unparseable and invalid-schema files instead of throwing", () => {
    const io = fakeFs({
      "/bad.json": "{not json",
      "/array.json": "[]",
    });
    assert.equal(loadEffortCatalog("/bad.json", io).warning, "unparseable");
    assert.equal(loadEffortCatalog("/array.json", io).warning, "invalid-schema");
  });

  it("skips invalid rows and counts them without voiding the table", () => {
    const io = fakeFs({
      "/db.json": dbWith({
        "good-model": SAMPLE_MODELS["glm-5.3"],
        "bad-levels": { kind: "reasoning", levels: ["turbo"] },
        "bad-shape": "nope",
      }),
    });
    const catalog = loadEffortCatalog("/db.json", io);
    assert.equal(catalog.warning, null);
    assert.equal(catalog.loadedCount, 1);
    assert.equal(catalog.invalidCount, 2);
  });
});

describe("getEffortCatalog cache", () => {
  it("reloads when the file changes and reuses the cached table otherwise", () => {
    const files = { "/db.json": dbWith({ "glm-5.3": SAMPLE_MODELS["glm-5.3"] }) };
    const io = { iomarker: "case-1", ...fakeFs(files) };
    const first = getEffortCatalog("/db.json", io);
    assert.equal(first.loadedCount, 1);
    assert.equal(getEffortCatalog("/db.json", io), first, "unchanged file returns the cached table");

    files["/db.json"] = dbWith({
      "glm-5.3": SAMPLE_MODELS["glm-5.3"],
      "kimi-k3": { kind: "reasoning", levels: ["low", "high", "max"], default: "high" },
    });
    const second = getEffortCatalog("/db.json", io);
    assert.equal(second.loadedCount, 2, "edited library takes effect without a restart");
    clearEffortCatalogCache();
  });

  it("keeps the last usable table when a later edit breaks the file", () => {
    const files = { "/db.json": dbWith({ "glm-5.3": SAMPLE_MODELS["glm-5.3"] }) };
    const io = { iomarker: "case-2", ...fakeFs(files) };
    assert.equal(getEffortCatalog("/db.json", io).loadedCount, 1);
    files["/db.json"] = "{ broken";
    const degraded = getEffortCatalog("/db.json", io);
    assert.equal(degraded.loadedCount, 1, "a corrupt edit must not zero out levels");
    assert.match(degraded.warning, /unparseable/);
    assert.equal(degraded.stale, true);
    clearEffortCatalogCache();
  });
});

describe("resolveModelEfforts", () => {
  const catalog = { models: new Map(Object.entries(SAMPLE_MODELS).map(([k, v]) => [k, normalizeEffortEntry(v)])) };

  it("matches a production id through the canonical spelling", () => {
    const resolved = resolveModelEfforts("[次]glm-5.3-high", catalog);
    assert.equal(resolved.origin, "library");
    assert.equal(resolved.matchedKey, "glm-5.3");
    assert.deepEqual(resolved.levels, ["medium", "high", "xhigh", "max"]);
    assert.equal(resolved.default, "high");
  });

  it("matches through the dot/dash fold", () => {
    assert.equal(resolveModelEfforts("claude-opus-4.7-max-thinking", catalog).matchedKey, "claude-opus-4-7");
  });

  it("honors a library row that says the model is not a text model", () => {
    const resolved = resolveModelEfforts("agnes-image-2.0-flash", catalog);
    assert.equal(resolved.kind, "non-text");
    assert.deepEqual(resolved.levels, []);
    assert.equal(resolved.default, null);
  });

  it("falls back to the optimistic levels for an unknown text model", () => {
    const resolved = resolveModelEfforts("brand-new-gateway-model", { models: new Map() });
    assert.equal(resolved.origin, "optimistic");
    assert.deepEqual(resolved.levels, OPTIMISTIC_EFFORT_LEVELS);
    assert.equal(resolved.default, "high");
  });

  it("works with no library loaded at all", () => {
    const resolved = resolveModelEfforts("glm-5.3", null);
    assert.equal(resolved.origin, "optimistic");
    assert.deepEqual(resolved.levels, ["high", "xhigh", "max"]);
  });

  it("derives a default when the row declares none usable", () => {
    const partial = { models: new Map([["x-model", { kind: "reasoning", levels: ["xhigh", "max"], default: null, wire: {}, thinkingFormat: null }]]) };
    assert.equal(resolveModelEfforts("x-model", partial).default, "xhigh");
  });
});

describe("pickDefaultEffort", () => {
  it("prefers high, then the deepest level actually offered", () => {
    assert.equal(pickDefaultEffort(["minimal", "low", "medium", "high", "xhigh", "max"]), "high");
    assert.equal(pickDefaultEffort(["xhigh", "max"]), "xhigh");
    assert.equal(pickDefaultEffort(["minimal", "low"]), "low");
    assert.equal(pickDefaultEffort(["off"]), null);
    assert.equal(pickDefaultEffort([]), null);
  });

  it("picks high for the gpt-5.6+ light/medium/high/xhigh/max set", () => {
    assert.equal(pickDefaultEffort(["light", "medium", "high", "xhigh", "max"]), "high");
    assert.equal(pickDefaultEffort(["light"]), "light");
  });
});

describe("effortWireValue", () => {
  it("uses the library wire spelling and falls back to the level name", () => {
    const resolved = resolveModelEfforts("deepseek-v4-flash", {
      models: new Map([["deepseek-v4-flash", normalizeEffortEntry(SAMPLE_MODELS["deepseek-v4-flash"])]]),
    });
    assert.equal(effortWireValue(resolved, "high"), "high");
    // xhigh is offered but the raw thinkingLevelMap pins it null: a non-empty
    // value is still required downstream, so the level name is sent.
    assert.equal(effortWireValue(resolved, "xhigh"), "xhigh");
    assert.equal(effortWireValue(resolved, "medium"), "medium");
  });
});

describe("intersectEffortVocabulary", () => {
  it("clips to the levels an endpoint can render, in canonical order", () => {
    assert.deepEqual(intersectEffortVocabulary(["max", "high", "ultra"], "pi"), ["high", "max"]);
    assert.deepEqual(intersectEffortVocabulary(["minimal", "high", "xhigh", "max"], "dsh"), ["minimal", "high", "xhigh", "max"]);
  });

  it("drops 'light' for pi and DSH, whose fixed level sets predate it", () => {
    // Both endpoints validate offered levels against their own hard-coded list
    // (pi EXTENDED_THINKING_LEVELS, dsh-llm-pi-ai THINKING_LEVELS); passing a
    // word outside it is invisible on pi and a settings.yaml load failure on
    // DSH, so the clip must remove it.
    assert.deepEqual(intersectEffortVocabulary(["light", "medium", "high", "xhigh", "max"], "pi"), ["medium", "high", "xhigh", "max"]);
    assert.deepEqual(intersectEffortVocabulary(["light", "medium", "high", "xhigh", "max"], "dsh"), ["medium", "high", "xhigh", "max"]);
  });

  it("keeps 'light' for free-form endpoints", () => {
    // Free-form endpoints render the list verbatim, input order included.
    assert.deepEqual(intersectEffortVocabulary(["max", "light", "high"], "kimi"), ["max", "light", "high"]);
    assert.deepEqual(intersectEffortVocabulary(["light", "medium", "high", "xhigh", "max"], "zcode"), ["light", "medium", "high", "xhigh", "max"]);
  });

  it("leaves free-form endpoints unclipped", () => {
    assert.deepEqual(intersectEffortVocabulary(["ultra", "high"], "kimi"), ["ultra", "high"]);
    assert.deepEqual(intersectEffortVocabulary(["ultra", "high"], "zcode"), ["ultra", "high"]);
  });

  it("returns nothing for an endpoint with no effort surface", () => {
    assert.deepEqual(intersectEffortVocabulary(["high"], "qoder"), []);
  });

  it("clips to codex's vocabulary: off/light drop, minimal..max pass", () => {
    // codex's zero level is spelled "none", so an "off" library level has no
    // codex word and clips away; "light" is likewise outside its wire set.
    assert.deepEqual(
      intersectEffortVocabulary(["off", "minimal", "low", "medium", "high", "xhigh", "max"], "codex"),
      ["minimal", "low", "medium", "high", "xhigh", "max"],
    );
    assert.deepEqual(intersectEffortVocabulary(["light", "high"], "codex"), ["high"]);
    // ultra/persistent are codex wire words the library space never produces,
    // so they never survive the canonical-order filter either.
    assert.deepEqual(intersectEffortVocabulary(["ultra", "high"], "codex"), ["high"]);
  });

  it("tolerates an unknown agent and empty input", () => {
    assert.deepEqual(intersectEffortVocabulary(["high"], "nope"), ["high"]);
    assert.deepEqual(intersectEffortVocabulary(undefined, "pi"), []);
  });
});

describe("intersectReasonixEfforts", () => {
  it("clips to the channel family's accepted set", () => {
    assert.deepEqual(intersectReasonixEfforts(["high", "xhigh", "max"], "deepseek-v4-flash"), ["high", "max"]);
  });

  it("comes back empty for a binary-toggle family, which means do not write it", () => {
    assert.deepEqual(intersectReasonixEfforts(["low", "high", "max"], "longcat-chat"), []);
    assert.deepEqual(intersectReasonixEfforts(["minimal", "low", "medium", "high", "max"], "MiniMax-M3"), []);
  });

  it("leaves an unconstrained family as the library stated", () => {
    assert.deepEqual(intersectReasonixEfforts(["high", "xhigh", "max"], "glm-5.3"), ["high", "xhigh", "max"]);
    assert.deepEqual(intersectReasonixEfforts(["high"], undefined), ["high"]);
  });
});

describe("modelEffortSurface", () => {
  const catalog = { models: new Map(Object.entries(SAMPLE_MODELS).map(([k, v]) => [k, normalizeEffortEntry(v)])) };

  it("hands a writer the clipped levels and the default among them", () => {
    const surface = modelEffortSurface("deepseek-v4-flash", { catalog, agent: "reasonix" });
    assert.deepEqual(surface.levels, ["high", "max"]);
    assert.equal(surface.default, "high");
    assert.equal(surface.thinkingFormat, "deepseek");
  });

  it("re-picks the default when clipping removed the declared one", () => {
    const partial = {
      models: new Map([["deepseek-v5", normalizeEffortEntry({ kind: "reasoning", levels: ["low", "high", "xhigh"], default: "xhigh" })]]),
    };
    const surface = modelEffortSurface("deepseek-v5", { catalog: partial, agent: "reasonix" });
    assert.deepEqual(surface.levels, ["low", "high"]);
    assert.equal(surface.default, "high");
  });

  it("says nothing for a non-text model", () => {
    assert.equal(modelEffortSurface("agnes-image-2.0-flash", { catalog, agent: "pi" }), null);
  });

  it("says nothing when the endpoint cannot carry a level at all", () => {
    assert.equal(modelEffortSurface("longcat-chat", { catalog, agent: "reasonix" }), null);
    assert.equal(modelEffortSurface("glm-5.3", { catalog, agent: "qoder" }), null);
  });

  it("still offers the optimistic levels for a model the library lacks", () => {
    const surface = modelEffortSurface("brand-new-model", { catalog: { models: new Map() }, agent: "kimi" });
    assert.deepEqual(surface.levels, ["high", "xhigh", "max"]);
    assert.equal(surface.origin, "optimistic");
  });
});
