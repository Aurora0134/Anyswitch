import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  buildReasoningIndex,
  resolveKnowledgeReasoning,
  loadPiAiReasoningIndex,
} from "./reasoning-fallback.mjs";

// pi-ai provider data file shape: { "<api>": { "<modelId>": model } }
const zaiDoc = {
  "openai-completions": {
    "glm-5.2": {
      id: "glm-5.2",
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: "high", medium: "high", high: "high", max: "max" },
      compat: { thinkingFormat: "zai", supportsReasoningEffort: true },
    },
    "glm-4.5": {
      id: "glm-4.5",
      reasoning: true,
      // binary toggle: non-DSH level spellings
      thinkingLevelMap: { enabled: "auto", off: null },
      compat: { thinkingFormat: "zai" },
    },
  },
};

const openrouterDoc = {
  "openai-completions": {
    "glm-5.2": {
      id: "glm-5.2",
      reasoning: true,
      // no thinkingLevelMap — gateway mirror must lose to the vendor entry
      compat: { thinkingFormat: "openrouter" },
    },
    "gpt-5.6-luna": {
      id: "gpt-5.6-luna",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max", off: "none" },
      compat: { thinkingFormat: "openrouter" },
    },
    "bare-model": {
      id: "bare-model",
      reasoning: true,
      // no map, no compat — plain reasoning_effort model
    },
  },
};

test("buildReasoningIndex indexes thinkingLevelMap and thinkingFormat by model id", () => {
  const index = buildReasoningIndex([zaiDoc, openrouterDoc]);
  const glm = index.get("glm-5.2");
  assert.ok(glm);
  assert.equal(glm.thinkingFormat, "zai", "vendor entry with a map beats the later mirror without one");
  assert.deepEqual(glm.levels, ["low", "medium", "high", "max"]);
  const luna = index.get("gpt-5.6-luna");
  assert.equal(luna.thinkingFormat, "openrouter");
  assert.deepEqual(luna.wireValues, { xhigh: "xhigh", max: "max", off: "none" });
});

test("buildReasoningIndex skips models that do not reason", () => {
  const doc = {
    "openai-completions": {
      "gpt-4o": { id: "gpt-4o", reasoning: false },
      "also-no": { id: "also-no" },
    },
  };
  const index = buildReasoningIndex([doc]);
  assert.equal(index.size, 0);
});

test("resolveKnowledgeReasoning maps DSH levels to wire values", () => {
  const index = buildReasoningIndex([zaiDoc]);
  const resolved = resolveKnowledgeReasoning(index.get("glm-5.2"));
  assert.deepEqual(resolved.levels, ["low", "medium", "high", "max"]);
  assert.deepEqual(resolved.wireValues, { low: "high", medium: "high", high: "high", max: "max" });
  assert.equal(resolved.thinkingFormat, "zai");
});

test("resolveKnowledgeReasoning normalizes binary toggles to off/low", () => {
  const index = buildReasoningIndex([zaiDoc]);
  const resolved = resolveKnowledgeReasoning(index.get("glm-4.5"));
  assert.deepEqual(resolved.levels, ["low"]);
  assert.equal(resolved.wireValues.low, "auto");
});

test("resolveKnowledgeReasoning returns null when no usable level exists", () => {
  const doc = {
    "openai-completions": {
      m: { id: "m", reasoning: true, thinkingLevelMap: { low: null, high: null } },
    },
  };
  const resolved = resolveKnowledgeReasoning(buildReasoningIndex([doc]).get("m"));
  assert.equal(resolved, null);
  assert.equal(resolveKnowledgeReasoning(undefined), null);
});

test("resolveKnowledgeReasoning gives a mapless entry the base levels", () => {
  const index = buildReasoningIndex([openrouterDoc]);
  const resolved = resolveKnowledgeReasoning(index.get("bare-model"));
  assert.deepEqual(resolved.levels, ["minimal", "low", "medium", "high", "max"]);
  assert.deepEqual(resolved.wireValues, {
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    max: "max",
  });
});

test("resolveKnowledgeReasoning drops null wire levels", () => {
  const doc = {
    "openai-completions": {
      m: {
        id: "m",
        reasoning: true,
        thinkingLevelMap: { low: "low", medium: null, high: "high" },
      },
    },
  };
  const resolved = resolveKnowledgeReasoning(buildReasoningIndex([doc]).get("m"));
  assert.deepEqual(resolved.levels, ["low", "high"]);
});

test("resolveKnowledgeReasoning withholds unusable thinkingFormats", () => {
  const doc = {
    "openai-completions": {
      m: {
        id: "m",
        reasoning: true,
        thinkingLevelMap: { high: "high" },
        compat: { thinkingFormat: "chat-template" },
      },
    },
  };
  const resolved = resolveKnowledgeReasoning(buildReasoningIndex([doc]).get("m"));
  assert.equal(resolved.thinkingFormat, null);
});

test("loadPiAiReasoningIndex returns empty map when package is absent", () => {
  const index = loadPiAiReasoningIndex("C:\\definitely\\not\\a\\real\\path");
  assert.ok(index instanceof Map);
  assert.equal(index.size, 0);
});

test("loadPiAiReasoningIndex reads the real installed pi-ai data when present", (t) => {
  // The DSH package installed under the roaming npm root ships the pi-ai
  // database this fallback exists to read. If that layout ever moves, this
  // test failing is the early warning.
  const dshRoot = join(
    process.env.APPDATA ?? "",
    "npm",
    "node_modules",
    "@deepseek-ai",
    "dsh",
  );
  const index = loadPiAiReasoningIndex(dshRoot);
  if (index.size === 0) {
    // Machine without the DSH install — report the skip instead of passing silently.
    t.skip("DSH pi-ai package is not installed on this machine");
    return;
  }
  const glm = index.get("glm-5.2");
  if (glm) {
    assert.equal(glm.thinkingFormat, "zai");
    assert.ok(glm.levels.length > 0);
  }
});
