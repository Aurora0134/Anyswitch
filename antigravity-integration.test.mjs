import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGY_SLUGS,
  AGY_NORMAL_SLUGS,
  AGY_SMALL_SLUG,
  splitTarget,
  buildDefaultAliases,
  readAliasFile,
  writeAliasFile,
  ensureAliasFile,
  createAliasResolver,
  aliasFilePath,
} from "./antigravity-alias.mjs";
import { parseGeminiPath, PARSE_REASON, METHODS } from "./gemini-path.mjs";
import { geminiToOpenAI, openAIToGemini, geminiError, buildGeminiModelsResponse } from "./gemini-protocol.mjs";
import { getMatchingProvidersForAgy, getEnabledModelCatalog, isAliasTargetEnabled } from "./panel.mjs";

describe("antigravity alias manager", () => {
  it("defines exactly 5 supported AGY slugs", () => {
    assert.strictEqual(AGY_SLUGS.length, 5);
    assert.ok(AGY_SLUGS.includes("gemini-3.7-flash"));
    assert.ok(AGY_SLUGS.includes("gemini-3.6-flash"));
    assert.ok(AGY_SLUGS.includes("gemini-3.5-flash"));
    assert.ok(AGY_SLUGS.includes("gemini-3.1-pro-preview"));
    assert.ok(AGY_SLUGS.includes("gemini-3.1-flash-lite-preview"));
  });

  it("partitions slugs into normal (one-to-one) and small (free choice) groups", () => {
    assert.strictEqual(AGY_NORMAL_SLUGS.length, 4);
    assert.ok(AGY_NORMAL_SLUGS.includes("gemini-3.1-pro-preview"));
    assert.ok(AGY_NORMAL_SLUGS.includes("gemini-3.5-flash"));
    assert.ok(AGY_NORMAL_SLUGS.includes("gemini-3.6-flash"));
    assert.ok(AGY_NORMAL_SLUGS.includes("gemini-3.7-flash"));
    assert.strictEqual(AGY_SMALL_SLUG, "gemini-3.1-flash-lite-preview");
    assert.deepStrictEqual([...AGY_NORMAL_SLUGS, AGY_SMALL_SLUG].sort(), [...AGY_SLUGS].sort());
  });

  it("splits target strings into providerId and modelId correctly", () => {
    assert.deepStrictEqual(splitTarget("acme-default/gemini-3.7-flash"), {
      ok: true,
      providerId: "acme-default",
      modelId: "gemini-3.7-flash",
    });
    assert.deepStrictEqual(splitTarget("vendorb-gemini/google/gemini-3.5-flash"), {
      ok: true,
      providerId: "vendorb-gemini",
      modelId: "google/gemini-3.5-flash",
    });
    assert.strictEqual(splitTarget("invalid-no-slash").ok, false);
    assert.strictEqual(splitTarget("").ok, false);
    assert.strictEqual(splitTarget("/no-provider").ok, false);
    assert.strictEqual(splitTarget("no-model/").ok, false);
  });

  it("builds default aliases covering all slugs", () => {
    const defaults = buildDefaultAliases("default-prov/gemini-3.7-flash");
    assert.ok(defaults.aliases);
    for (const slug of AGY_SLUGS) {
      assert.strictEqual(defaults.aliases[slug], "default-prov/gemini-3.7-flash");
    }
  });

  it("handles on-disk persistence, ensureAliasFile, and in-memory overlay hot reloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "anyswitch-agy-test-"));
    const filePath = join(dir, "antigravity.json");
    try {
      // 1. Initial ensure creates file
      const result = ensureAliasFile(filePath, "acme-default/gemini-3.7-flash");
      assert.strictEqual(result.changed, true);
      assert.strictEqual(result.aliases["gemini-3.7-flash"], "acme-default/gemini-3.7-flash");

      // 2. Resolver reads file
      const resolver = createAliasResolver({ filePath });
      assert.deepStrictEqual(resolver.resolve("gemini-3.7-flash"), {
        ok: true,
        providerId: "acme-default",
        modelId: "gemini-3.7-flash",
      });

      // 3. Hot update in overlay takes precedence
      resolver.setAlias("gemini-3.7-flash", "vendorb-gemini/gemini-3.7-flash");
      assert.deepStrictEqual(resolver.resolve("gemini-3.7-flash"), {
        ok: true,
        providerId: "vendorb-gemini",
        modelId: "gemini-3.7-flash",
      });

      // 4. Snapshot contains overlay
      const snap = resolver.snapshot();
      assert.strictEqual(snap["gemini-3.7-flash"], "vendorb-gemini/gemini-3.7-flash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("picks up on-disk writes from another process on the next resolve (cross-process hot reload)", () => {
    const dir = mkdtempSync(join(tmpdir(), "anyswitch-agy-xproc-"));
    const filePath = join(dir, "antigravity.json");
    try {
      writeAliasFile(filePath, { aliases: { "gemini-3.7-flash": "prov-a/gemini-3.7-flash" } });

      // Two processes, each with its own resolver over the same file.
      const relay = createAliasResolver({ filePath });
      const panel = createAliasResolver({ filePath });

      // The panel process saves a new binding to disk (write-then-setAlias,
      // exactly what POST /panel/api/antigravity/aliases does).
      const next = { "gemini-3.7-flash": "prov-b/gemini-3.7-flash-extended" };
      writeAliasFile(filePath, { aliases: next });
      panel.setAlias("gemini-3.7-flash", next["gemini-3.7-flash"]);

      // The relay process sees the disk change on its next resolve, without a
      // restart — and its own (stale) overlay gives way to the new disk value.
      assert.deepStrictEqual(relay.resolve("gemini-3.7-flash"), {
        ok: true,
        providerId: "prov-b",
        modelId: "gemini-3.7-flash-extended",
      });
      assert.strictEqual(relay.snapshot()["gemini-3.7-flash"], "prov-b/gemini-3.7-flash-extended");
      assert.strictEqual(panel.snapshot()["gemini-3.7-flash"], "prov-b/gemini-3.7-flash-extended");

      // An unchanged file is NOT reloaded: an overlay set after the last disk
      // write keeps winning until the file changes again.
      relay.setAlias("gemini-3.6-flash", "prov-c/gemini-3.6-flash");
      assert.deepStrictEqual(relay.resolve("gemini-3.6-flash"), {
        ok: true,
        providerId: "prov-c",
        modelId: "gemini-3.6-flash",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gemini path parser", () => {
  it("parses generateContent and streamGenerateContent paths", () => {
    const gen = parseGeminiPath("/v1beta/models/gemini-3.7-flash:generateContent");
    assert.strictEqual(gen.ok, true);
    assert.strictEqual(gen.slug, "gemini-3.7-flash");
    assert.strictEqual(gen.method, METHODS.GENERATE);

    const stream = parseGeminiPath("/v1beta/models/gemini-3.6-flash:streamGenerateContent");
    assert.strictEqual(stream.ok, true);
    assert.strictEqual(stream.slug, "gemini-3.6-flash");
    assert.strictEqual(stream.method, METHODS.STREAM);
  });

  it("rejects non-gemini or invalid paths", () => {
    assert.strictEqual(parseGeminiPath("/v1/chat/completions").ok, false);
    assert.strictEqual(parseGeminiPath("/v1beta/unknown").ok, false);
  });
});

describe("gemini protocol converter", () => {
  it("converts basic Gemini prompt to OpenAI Chat format", () => {
    const geminiBody = {
      contents: [
        {
          role: "user",
          parts: [{ text: "Hello AI" }],
        },
      ],
      systemInstruction: {
        parts: [{ text: "You are a helpful assistant" }],
      },
    };
    const openAIBody = geminiToOpenAI(geminiBody, "gemini-3.7-flash");
    assert.strictEqual(openAIBody.model, "gemini-3.7-flash");
    assert.strictEqual(openAIBody.messages.length, 2);
    assert.strictEqual(openAIBody.messages[0].role, "system");
    assert.ok(openAIBody.messages[0].content.includes("You are a helpful assistant"));
    assert.strictEqual(openAIBody.messages[1].role, "user");
    assert.strictEqual(openAIBody.messages[1].content, "Hello AI");
  });

  it("converts OpenAI response to Gemini format", () => {
    const openAIResponse = {
      id: "chatcmpl-123",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello human!",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };
    const geminiRes = openAIToGemini(openAIResponse, "gemini-3.7-flash");
    assert.ok(geminiRes.candidates);
    assert.strictEqual(geminiRes.candidates[0].content.parts[0].text, "Hello human!");
    assert.strictEqual(geminiRes.candidates[0].finishReason, "STOP");
  });
});

describe("store same-name model matching for antigravity", () => {
  const mockStore = {
    version: 2,
    providers: {
      "prov-a": {
        displayName: "Provider A",
        models: {
          "gemini-3.7-flash": { displayName: "Gemini 3.7 Flash" },
          "claude-opus-4-6": { displayName: "Opus" },
        },
      },
      "prov-b": {
        displayName: "Provider B",
        models: {
          "google/gemini-3.7-flash": { displayName: "G-3.7 Flash" },
        },
        discovered: {
          "gemini-3.6-flash": { displayName: "Discovered Only" },
          "gemini-3.7-flash-thinking": { displayName: "Thinking Variant" },
        },
      },
      "prov-c": {
        displayName: "Provider C",
        models: {
          "[AN]gemini-3.6-flash": { displayName: "Tagged 3.6" },
          "[次][AN]gemini-3.5-flash": { displayName: "Double Tagged 3.5" },
          "gemini-3.5-flash-latest": { displayName: "Not Same Name" },
        },
      },
    },
  };

  it("matches same-name models across enabled sets, exact first", () => {
    const options = getMatchingProvidersForAgy(mockStore);

    // gemini-3.7-flash: exact in prov-a, google/-stripped in prov-b
    assert.strictEqual(options["gemini-3.7-flash"].length, 2);
    const matchA = options["gemini-3.7-flash"].find((m) => m.providerId === "prov-a");
    assert.ok(matchA);
    assert.strictEqual(matchA.isExact, true);
    assert.strictEqual(matchA.modelId, "gemini-3.7-flash");
    const matchB = options["gemini-3.7-flash"].find((m) => m.providerId === "prov-b");
    assert.ok(matchB);
    assert.strictEqual(matchB.modelId, "google/gemini-3.7-flash");
    assert.strictEqual(matchB.isExact, false);

    // [tag] stripping: one and two leading tags both reduce to the slug
    assert.strictEqual(options["gemini-3.6-flash"].length, 1);
    assert.strictEqual(options["gemini-3.6-flash"][0].providerId, "prov-c");
    assert.strictEqual(options["gemini-3.6-flash"][0].modelId, "[AN]gemini-3.6-flash");
    assert.strictEqual(options["gemini-3.5-flash"].length, 1);
    assert.strictEqual(options["gemini-3.5-flash"][0].modelId, "[次][AN]gemini-3.5-flash");
  });

  it("never offers discovered-only models or non-identical names (strict same-name)", () => {
    const options = getMatchingProvidersForAgy(mockStore);

    // prov-b's gemini-3.6-flash lives only in `discovered` (filtered out):
    // the handler would 404 on it, so it must not be a candidate.
    assert.ok(options["gemini-3.6-flash"].every((m) => m.providerId !== "prov-b"));

    // "gemini-3.7-flash-thinking" merely CONTAINS the slug — not same-name.
    assert.ok(options["gemini-3.7-flash"].every((m) => !m.modelId.includes("thinking")));

    // "gemini-3.5-flash-latest" is a different model, not gemini-3.5-flash.
    assert.ok(options["gemini-3.5-flash"].every((m) => !m.modelId.includes("latest")));
  });

  it("catalogs every enabled model for the small slug's free choice", () => {
    const catalog = getEnabledModelCatalog(mockStore);
    // 2 (prov-a) + 1 (prov-b models) + 3 (prov-c) — discovered excluded
    assert.strictEqual(catalog.length, 6);
    assert.ok(catalog.every((entry) => typeof entry.providerId === "string"));
    assert.ok(catalog.every((entry) => typeof entry.modelId === "string"));
    // Deterministic order: provider id then model id.
    for (let i = 1; i < catalog.length; i += 1) {
      const prev = catalog[i - 1];
      const cur = catalog[i];
      assert.ok(
        prev.providerId < cur.providerId ||
          (prev.providerId === cur.providerId && prev.modelId <= cur.modelId),
      );
    }
    // Discovered-only models are absent from the catalog.
    assert.ok(!catalog.some((e) => e.providerId === "prov-b" && e.modelId === "gemini-3.6-flash"));
  });

  it("validates alias targets against the enabled set", () => {
    assert.strictEqual(isAliasTargetEnabled(mockStore, "prov-a/gemini-3.7-flash"), true);
    assert.strictEqual(isAliasTargetEnabled(mockStore, "prov-b/google/gemini-3.7-flash"), true);
    // Filtered out (discovered only) — would 404 at request time.
    assert.strictEqual(isAliasTargetEnabled(mockStore, "prov-b/gemini-3.6-flash"), false);
    // Missing provider / missing model.
    assert.strictEqual(isAliasTargetEnabled(mockStore, "nope/gemini-3.7-flash"), false);
    assert.strictEqual(isAliasTargetEnabled(mockStore, "prov-a/claude-opus-4-6"), true);
    assert.strictEqual(isAliasTargetEnabled(mockStore, "prov-a/no-such-model"), false);
    // Malformed target.
    assert.strictEqual(isAliasTargetEnabled(mockStore, "no-slash"), false);
  });
});

describe("gemini tool_call id synthesis (same-name dedup)", () => {
  // Reads the tool_call ids out of the assistant message convertContent
  // produces for a single model content.
  function toolCallIdsOf(content) {
    const [msg] = geminiToOpenAI({ contents: [content] }, "m").messages.filter((m) => m.role === "assistant");
    return msg.tool_calls.map((tc) => tc.id);
  }

  it("single functionCall keeps the bare `call_${name}` id (no suffix regression)", () => {
    assert.deepStrictEqual(
      toolCallIdsOf({ role: "model", parts: [{ functionCall: { name: "getWeather", args: {} } }] }),
      ["call_getWeather"],
    );
  });

  it("same-name parallel calls get distinct ids numbered by occurrence", () => {
    assert.deepStrictEqual(
      toolCallIdsOf({
        role: "model",
        parts: [
          { functionCall: { name: "readFile", args: { path: "a" } } },
          { functionCall: { name: "readFile", args: { path: "b" } } },
          { functionCall: { name: "readFile", args: { path: "c" } } },
        ],
      }),
      ["call_readFile", "call_readFile__2", "call_readFile__3"],
    );
  });

  it("an explicit call id is kept verbatim and never suffixed", () => {
    assert.deepStrictEqual(
      toolCallIdsOf({
        role: "model",
        parts: [
          { functionCall: { id: "abc", name: "f", args: {} } },
          { functionCall: { id: "def", name: "f", args: {} } },
        ],
      }),
      ["abc", "def"],
    );
  });

  it("functionResponse fallback pairs same-name responses to the same-name calls by occurrence order", () => {
    const messages = geminiToOpenAI(
      {
        contents: [
          {
            role: "model",
            parts: [
              { functionCall: { name: "readFile", args: { path: "a" } } },
              { functionCall: { name: "readFile", args: { path: "b" } } },
            ],
          },
          {
            role: "user",
            parts: [
              { functionResponse: { name: "readFile", response: { path: "a" } } },
              { functionResponse: { name: "readFile", response: { path: "b" } } },
            ],
          },
        ],
      },
      "m",
    ).messages;
    const assistant = messages.find((m) => m.role === "assistant");
    const tools = messages.filter((m) => m.role === "tool");
    assert.deepStrictEqual(
      assistant.tool_calls.map((tc) => tc.id),
      ["call_readFile", "call_readFile__2"],
    );
    assert.deepStrictEqual(
      tools.map((t) => t.tool_call_id),
      ["call_readFile", "call_readFile__2"],
    );
  });

  it("multi-turn tool history: turn-1 call A + turn-2 call B, merged responses keep bare ids", () => {
    // The regression case: two different tools across two turns (each content
    // holds ONE call), with both functionResponses merged into a single user
    // content. Numbering must stay per-content, so both ids remain the bare
    // `call_${name}` form — the pre-dedup behavior every existing client
    // history depends on.
    const messages = geminiToOpenAI(
      {
        contents: [
          { role: "user", parts: [{ text: "read the config" }] },
          { role: "model", parts: [{ functionCall: { name: "readFile", args: { path: "config.json" } } }] },
          {
            role: "user",
            parts: [{ functionResponse: { name: "readFile", response: { content: "{}" } } }],
          },
          { role: "model", parts: [{ functionCall: { name: "parseJson", args: { text: "{}" } } }] },
          {
            role: "user",
            parts: [
              { functionResponse: { name: "readFile", response: { content: "{}" } } },
              { functionResponse: { name: "parseJson", response: { value: 42 } } },
            ],
          },
        ],
      },
      "m",
    ).messages;
    const assistant = messages.filter((m) => m.role === "assistant");
    assert.deepStrictEqual(
      assistant.map((m) => m.tool_calls[0].id),
      ["call_readFile", "call_parseJson"],
      "lone calls across turns keep bare ids",
    );
    const tools = messages.filter((m) => m.role === "tool");
    assert.deepStrictEqual(
      tools.map((t) => t.tool_call_id),
      ["call_readFile", "call_readFile", "call_parseJson"],
      "merged responses fall back to the same bare ids by name",
    );
  });

  it("same-name dedup is per-content: repeated names in different turns never get suffixed", () => {
    const ids = [
      ...toolCallIdsOf({ role: "model", parts: [{ functionCall: { name: "search", args: { q: "1" } } }] }),
      ...toolCallIdsOf({ role: "model", parts: [{ functionCall: { name: "search", args: { q: "2" } } }] }),
    ];
    assert.deepStrictEqual(ids, ["call_search", "call_search"]);
  });
});
