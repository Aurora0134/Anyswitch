import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  buildReasoningIndex,
  resolveKnowledgeReasoning,
  loadPiAiReasoningIndex,
} from "./reasoning-fallback.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

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

// The loader used to carry a smoke test against the DSH package actually
// installed under the host's roaming npm root. It could never fail: the
// pi-ai 1.4.0 database keys its entries "chat:<modelId>" (a bare id like
// "glm-5.2" resolves to undefined), so the entry assertions were dead code,
// and the only live check — index.size !== 0 — skipped rather than failed
// on machines without the install. A unit test cannot tripwire a host
// install anyway; the loader contract is pinned here with fixtures instead.
test("loadPiAiReasoningIndex reads the package data dir through the default fs", () => {
  const pkgRoot = mkTestDir("anys-reasoning-pkg-");
  const dataDir = join(
    pkgRoot,
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "providers",
    "data",
  );
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "zai.json"), JSON.stringify(zaiDoc));
  // pi-ai 1.4.0 ships composite keys ("chat:<modelId>") rather than bare
  // model ids: the index carries data keys verbatim, and key derivation
  // stays the caller's job (dsh-merge-config looks ids up itself).
  writeFileSync(
    join(dataDir, "catalog.json"),
    JSON.stringify({
      "openai-completions": {
        "chat:glm-5.2": {
          id: "chat:glm-5.2",
          reasoning: true,
          thinkingLevelMap: { high: "high" },
          compat: { thinkingFormat: "qwen" },
        },
      },
    }),
  );
  // Real data dirs ship a .manifest.json sibling; it parses but matches no
  // model shape, so it must contribute no entries.
  writeFileSync(
    join(dataDir, ".manifest.json"),
    JSON.stringify({ schemaVersion: 3, files: ["zai.json"] }),
  );
  // One malformed file must not sink the index; non-.json files are not read.
  writeFileSync(join(dataDir, "broken.json"), "{ not json");
  writeFileSync(join(dataDir, "notes.txt"), "not a data file");

  const index = loadPiAiReasoningIndex(pkgRoot);
  assert.deepEqual([...index.keys()].sort(), ["chat:glm-5.2", "glm-4.5", "glm-5.2"]);
  assert.equal(index.get("glm-5.2").thinkingFormat, "zai");
  assert.equal(index.get("chat:glm-5.2").thinkingFormat, "qwen");
});

test("loadPiAiReasoningIndex returns an empty map when the data dir cannot be listed", () => {
  const index = loadPiAiReasoningIndex("C:\\anywhere", {
    existsSync: () => true,
    readdirSync: () => {
      throw new Error("EACCES");
    },
    readFileSync: () => {
      throw new Error("unreachable");
    },
  });
  assert.ok(index instanceof Map);
  assert.equal(index.size, 0);
});
