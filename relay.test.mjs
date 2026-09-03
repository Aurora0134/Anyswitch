// Relay unit tests. Synthetic data only: no real credentials, no DPAPI,
// no real upstream, no network. All IO is injected.

import { test } from "node:test";
import assert from "node:assert/strict";

import { packWireId, unpackWireId, buildWireCatalog, UNPACK_REASON } from "./wire-id.mjs";
import { catalogGeneration, generationMatches } from "./catalog-generation.mjs";
import { anthropicToOpenAI, openAIToAnthropic, buildModelsResponse } from "./protocol.mjs";
import { createHandler, extractPresentedToken } from "./handler.mjs";

const TOKEN = "test-token-0123456789abcdef";

function syntheticStore() {
  return {
    version: 2,
    providers: {
      "poke-api": {
        displayName: "Poke API",
        baseURL: "https://upstream.invalid/v1",
        protocol: "openai-compatible",
        credentialFile: "poke-api.dpapi",
        models: {
          "claude-opus-5": { displayName: "Claude Opus 5" },
          "claude-sonnet-5": { displayName: "Claude Sonnet 5" },
        },
      },
      "nvidia-nim": {
        displayName: "NVIDIA NIM",
        baseURL: "https://nim.invalid/v1",
        protocol: "openai-compatible",
        credentialFile: "nvidia-nim.dpapi",
        models: {
          "deepseek-ai/deepseek-v4-pro": { displayName: "DeepSeek V4 Pro" },
        },
      },
    },
  };
}

function makeDeps(overrides = {}) {
  let generation = null;
  const store = overrides.store ?? syntheticStore();
  return {
    token: TOKEN,
    loadStore: overrides.loadStore ?? (() => ({ ok: true, store })),
    loadCredential: overrides.loadCredential ?? (async () => ({ ok: true, value: "synthetic-key" })),
    upstreamFetch:
      overrides.upstreamFetch ??
      (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: "cmpl-1",
          choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
      })),
    recordGeneration: overrides.recordGeneration ?? ((g) => { generation = g; }),
    readGeneration: overrides.readGeneration ?? (() => generation),
  };
}

const AUTH = { authorization: TOKEN };

function messageBody(model) {
  return { model, max_tokens: 16, messages: [{ role: "user", content: "hello" }] };
}

// ---------- §1.2 / §1.3 wire ID ----------

test("packWireId prefixes canonical id", () => {
  assert.equal(packWireId("poke-api", "claude-opus-5"), "anthropic/poke-api/claude-opus-5");
});

test("packWireId rejects a provider id containing a slash", () => {
  assert.throws(() => packWireId("a/b", "m"), /wire-ID invariant/);
});

test("unpack round-trips ids with embedded slashes", () => {
  const wire = packWireId("nvidia-nim", "deepseek-ai/deepseek-v4-pro");
  const out = unpackWireId(wire);
  assert.equal(out.ok, true);
  assert.equal(out.providerId, "nvidia-nim");
  assert.equal(out.modelId, "deepseek-ai/deepseek-v4-pro");
});

test("unpack strips the prefix exactly once", () => {
  const out = unpackWireId("anthropic/anthropic/nested-model");
  assert.equal(out.ok, true);
  assert.equal(out.providerId, "anthropic");
  assert.equal(out.modelId, "nested-model");
});

test("unpack rejects non-wire ids including bare Anthropic model names", () => {
  for (const bad of ["claude-sonnet-5", "sonnet", "opus", "gpt-4"]) {
    const out = unpackWireId(bad);
    assert.equal(out.ok, false);
    assert.equal(out.reason, UNPACK_REASON.NOT_WIRE_ID);
  }
});

test("unpack resolves an unqualified model only against one relay provider", () => {
  const store = syntheticStore();
  const out = unpackWireId("claude-opus-5", store);
  assert.equal(out.ok, true);
  assert.equal(out.providerId, "poke-api");
  assert.equal(out.modelId, "claude-opus-5");
  assert.equal(out.legacy, true);
});

test("unpack maps a dated Claude preset to one registered relay model", () => {
  const store = syntheticStore();
  const out = unpackWireId("claude-haiku-4-5-20251001", {
    ...store,
    providers: {
      "poke-api": {
        ...store.providers["poke-api"],
        models: { "claude-haiku-4-5": { displayName: "Claude Haiku 4.5" } },
      },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.modelId, "claude-haiku-4-5");
});

test("unpack refuses ambiguous unqualified relay models", () => {
  const store = syntheticStore();
  store.providers.other = { ...store.providers["poke-api"], models: { "claude-opus-5": { displayName: "Claude Opus 5" } } };
  const out = unpackWireId("claude-opus-5", store);
  assert.equal(out.ok, false);
  assert.equal(out.reason, UNPACK_REASON.AMBIGUOUS_UNQUALIFIED);
});

test("unpack is case sensitive on the prefix (§1.5 no normalisation)", () => {
  for (const bad of ["Anthropic/p/m", "ANTHROPIC/p/m"]) {
    assert.equal(unpackWireId(bad).reason, UNPACK_REASON.NOT_WIRE_ID);
  }
});

test("unpack rejects missing separator and empty segments", () => {
  assert.equal(unpackWireId("anthropic/onlyprovider").reason, UNPACK_REASON.NO_SEPARATOR);
  assert.equal(unpackWireId("anthropic//model").reason, UNPACK_REASON.EMPTY_PROVIDER);
  assert.equal(unpackWireId("anthropic/provider/").reason, UNPACK_REASON.EMPTY_MODEL);
});

test("unpack rejects missing and non-string model", () => {
  assert.equal(unpackWireId(undefined).reason, UNPACK_REASON.MISSING);
  assert.equal(unpackWireId(null).reason, UNPACK_REASON.MISSING);
  assert.equal(unpackWireId(42).reason, UNPACK_REASON.NOT_A_STRING);
});

test("buildWireCatalog covers every model", () => {
  const entries = buildWireCatalog(syntheticStore());
  assert.equal(entries.length, 3);
  assert.ok(entries.some((e) => e.wireId === "anthropic/nvidia-nim/deepseek-ai/deepseek-v4-pro"));
});

test("catalog entries carry the provider display label", () => {
  const entries = buildWireCatalog(syntheticStore());
  const opus = entries.find((e) => e.wireId === "anthropic/poke-api/claude-opus-5");
  assert.equal(opus.displayName, "[poke-api] Claude Opus 5");
  const nim = entries.find((e) => e.wireId === "anthropic/nvidia-nim/deepseek-ai/deepseek-v4-pro");
  assert.equal(nim.displayName, "[nvidia-nim] DeepSeek V4 Pro");
});

test("same model display name under two providers stays distinguishable", () => {
  // The real store has 25 model display names shared across providers whose
  // billing multipliers differ. The picker label must disambiguate them.
  const store = syntheticStore();
  store.providers["S3-claude"] = {
    displayName: "S3 claude-0.08x",
    baseURL: "https://s3.invalid/v1",
    protocol: "openai-compatible",
    credentialFile: "s3-claude.dpapi",
    models: { "claude-opus-5": { displayName: "Claude Opus 5" } },
  };
  const labels = buildWireCatalog(store).map((e) => e.displayName);
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(labels.includes("[poke-api] Claude Opus 5"));
  assert.ok(labels.includes("[S3-claude] Claude Opus 5"));
});

test("model with no displayName falls back to the model id, still prefixed", () => {
  const store = syntheticStore();
  store.providers["poke-api"].models["bare-model"] = {};
  const entry = buildWireCatalog(store).find((e) => e.wireId === "anthropic/poke-api/bare-model");
  assert.equal(entry.displayName, "[poke-api] bare-model");
});

test("buildModelsResponse surfaces the prefixed label as display_name", () => {
  const body = buildModelsResponse(buildWireCatalog(syntheticStore()));
  const opus = body.data.find((m) => m.id === "anthropic/poke-api/claude-opus-5");
  assert.equal(opus.display_name, "[poke-api] Claude Opus 5");
});

test("buildWireCatalog emits a pool as one unit with the members' union, absorbing members", () => {
  const store = syntheticStore();
  store.pools = { "poke-pool": { displayName: "Poke Pool", members: ["poke-api", "nvidia-nim"] } };
  const wireIds = buildWireCatalog(store).map((e) => e.wireId).sort();
  assert.deepEqual(wireIds, [
    "anthropic/poke-pool/claude-opus-5",
    "anthropic/poke-pool/claude-sonnet-5",
    "anthropic/poke-pool/deepseek-ai/deepseek-v4-pro",
  ]);
});

test("every catalog entry unpacks back to a store hit", async () => {
  const store = syntheticStore();
  const handler = createHandler(makeDeps({ store }));
  for (const entry of buildWireCatalog(store)) {
    const out = await handler.handleMessages(AUTH, messageBody(entry.wireId));
    assert.equal(out.status, 200, `${entry.wireId} should route`);
  }
});

test("provider label change does not invalidate a live session (§2.6)", () => {
  // displayName is presentation metadata and must stay out of the generation
  // digest, otherwise relabelling would 409 an in-flight session.
  const a = syntheticStore();
  const b = syntheticStore();
  b.providers["poke-api"].displayName = "Renamed Provider";
  assert.equal(catalogGeneration(a), catalogGeneration(b));
});

test("buildWireCatalog fails whole catalog on collision (§1.5)", () => {
  // "a" + "b/m" and "a/b" + "m" would collide, but the second provider id is
  // itself illegal, so packWireId rejects it before a partial catalog is built.
  const store = {
    version: 2,
    providers: {
      a: { models: { "b/m": {} } },
      "a/b": { models: { m: {} } },
    },
  };
  assert.throws(() => buildWireCatalog(store), /wire-ID invariant|collision/);
});

// ---------- §2.6 catalog generation ----------

test("generation ignores presentation metadata", () => {
  const a = syntheticStore();
  const b = syntheticStore();
  b.providers["poke-api"].models["claude-opus-5"].displayName = "Renamed";
  assert.equal(catalogGeneration(a), catalogGeneration(b));
});

test("generation changes when baseURL or fallbackURLs change", () => {
  const a = syntheticStore();
  const baseURLChanged = syntheticStore();
  baseURLChanged.providers["poke-api"].baseURL = "https://elsewhere.invalid/v1";
  assert.notEqual(catalogGeneration(a), catalogGeneration(baseURLChanged));

  const fallbackURLsChanged = syntheticStore();
  fallbackURLsChanged.providers["poke-api"].fallbackURLs = ["https://backup.invalid/v1"];
  assert.notEqual(catalogGeneration(a), catalogGeneration(fallbackURLsChanged));
});

test("generation changes when credentialFile or model set changes", () => {
  const base = catalogGeneration(syntheticStore());
  const credChanged = syntheticStore();
  credChanged.providers["poke-api"].credentialFile = "other.dpapi";
  assert.notEqual(base, catalogGeneration(credChanged));

  const modelsChanged = syntheticStore();
  delete modelsChanged.providers["poke-api"].models["claude-sonnet-5"];
  assert.notEqual(base, catalogGeneration(modelsChanged));
});

test("generationMatches rejects empty and non-string recordings", () => {
  assert.equal(generationMatches("", ""), false);
  assert.equal(generationMatches(null, "x"), false);
  assert.equal(generationMatches("x", "x"), true);
});

// ---------- protocol translation ----------

test("anthropicToOpenAI uses the bare model id and hoists system", () => {
  const out = anthropicToOpenAI(
    { system: "be terse", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
    "claude-opus-5",
  );
  assert.equal(out.model, "claude-opus-5");
  // System is hoisted to a leading OpenAI system message, passed through
  // verbatim — no injected reasoning-language directive.
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[0].content, "be terse");
  assert.equal(out.max_tokens, 8);
});

test("anthropicToOpenAI emits no system message when no system text", () => {
  const out = anthropicToOpenAI(
    { max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
    "claude-opus-5",
  );
  assert.equal(out.messages[0].role, "user");
  assert.ok(out.messages.every((m) => !String(m.content ?? "").includes("REASONING LANGUAGE")));
});

test("anthropicToOpenAI converts tool_use and tool_result", () => {
  const out = anthropicToOpenAI(
    {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "a" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    },
    "m",
  );
  // The translated tool_use/tool_result messages lead the list directly —
  // no injected system directive.
  assert.equal(out.messages[0].tool_calls[0].function.name, "read");
  assert.equal(out.messages[1].role, "tool");
  assert.equal(out.messages[1].tool_call_id, "t1");
});

test("anthropicToOpenAI drops Claude Code's fixed reasoning_effort", () => {
  const out = anthropicToOpenAI(
    { reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] },
    "m",
  );
  assert.ok(!("reasoning_effort" in out));
});

test("openAIToAnthropic echoes the wire ID and maps stop reasons", () => {
  const out = openAIToAnthropic(
    { id: "c1", choices: [{ message: { content: "x" }, finish_reason: "length" }], usage: {} },
    "anthropic/poke-api/claude-opus-5",
  );
  assert.equal(out.model, "anthropic/poke-api/claude-opus-5");
  assert.equal(out.stop_reason, "max_tokens");
  assert.deepEqual(out.content, [{ type: "text", text: "x" }]);
});

test("openAIToAnthropic preserves unparsable tool arguments", () => {
  const out = openAIToAnthropic(
    {
      choices: [
        {
          message: { tool_calls: [{ id: "t", function: { name: "f", arguments: "{not json" } }] },
          finish_reason: "tool_calls",
        },
      ],
    },
    "w",
  );
  assert.equal(out.content[0].input.__unparsed_arguments, "{not json");
  assert.equal(out.stop_reason, "tool_use");
});

test("buildModelsResponse emits wire ids only", () => {
  const body = buildModelsResponse(buildWireCatalog(syntheticStore()));
  assert.equal(body.data.length, 3);
  assert.ok(body.data.every((m) => m.id.startsWith("anthropic/")));
  assert.equal(body.has_more, false);
});

// ---------- §2.5 auth ----------

test("extractPresentedToken handles bare and Bearer forms", () => {
  assert.equal(extractPresentedToken({ authorization: "abc" }), "abc");
  assert.equal(extractPresentedToken({ authorization: "Bearer abc" }), "abc");
  assert.equal(extractPresentedToken({}), null);
});

test("missing or wrong token is 401 and never reaches upstream", async () => {
  let upstreamCalls = 0;
  const handler = createHandler(
    makeDeps({ upstreamFetch: async () => { upstreamCalls += 1; throw new Error("must not run"); } }),
  );
  const noAuth = await handler.handleMessages({}, messageBody("anthropic/poke-api/claude-opus-5"));
  assert.equal(noAuth.status, 401);
  const badAuth = await handler.handleMessages(
    { authorization: "wrong-token-with-different-length" },
    messageBody("anthropic/poke-api/claude-opus-5"),
  );
  assert.equal(badAuth.status, 401);
  assert.equal(upstreamCalls, 0);
});

test("a same-length wrong token is 401 via the constant-time path", async () => {
  // Exercises the timingSafeEqual branch (the different-length case above
  // short-circuits before it), so the buffer-wiping finally is covered too.
  let upstreamCalls = 0;
  const handler = createHandler(
    makeDeps({ upstreamFetch: async () => { upstreamCalls += 1; throw new Error("must not run"); } }),
  );
  const sameLength = `${TOKEN.slice(0, -1)}X`;
  assert.equal(sameLength.length, TOKEN.length);
  assert.notEqual(sameLength, TOKEN);

  const out = await handler.handleMessages(
    { authorization: sameLength },
    messageBody("anthropic/poke-api/claude-opus-5"),
  );
  assert.equal(out.status, 401);
  assert.equal(out.body.error.type, "authentication_error");
  assert.equal(upstreamCalls, 0);

  // The correct token still authorizes after the failed comparison.
  assert.equal((await handler.handleModels(AUTH)).status, 200);
});

test("discovery also requires the token", async () => {
  const handler = createHandler(makeDeps());
  assert.equal((await handler.handleModels({})).status, 401);
  assert.equal((await handler.handleModels(AUTH)).status, 200);
});

// ---------- §2.3 error surface ----------

test("non-object body is 400", async () => {
  const handler = createHandler(makeDeps());
  for (const bad of [null, "str", [1]]) {
    assert.equal((await handler.handleMessages(AUTH, bad)).status, 400);
  }
});

test("missing model is 400", async () => {
  const handler = createHandler(makeDeps());
  const out = await handler.handleMessages(AUTH, { max_tokens: 1, messages: [] });
  assert.equal(out.status, 400);
});

test("unknown bare model is 400 with no official passthrough (§2.4)", async () => {
  let upstreamCalls = 0;
  const handler = createHandler(
    makeDeps({ upstreamFetch: async () => { upstreamCalls += 1; throw new Error("must not run"); } }),
  );
  const out = await handler.handleMessages(AUTH, messageBody("claude-sonnet-999"));
  assert.equal(out.status, 400);
  assert.match(out.body.error.message, /use the full model id from \/v1\/models/);
  assert.equal(upstreamCalls, 0);
});

test("unknown provider is 404, unknown model is 404, neither hits upstream", async () => {
  let upstreamCalls = 0;
  const handler = createHandler(
    makeDeps({ upstreamFetch: async () => { upstreamCalls += 1; throw new Error("must not run"); } }),
  );
  const noProvider = await handler.handleMessages(AUTH, messageBody("anthropic/ghost/m"));
  assert.equal(noProvider.status, 404);
  const noModel = await handler.handleMessages(AUTH, messageBody("anthropic/poke-api/ghost"));
  assert.equal(noModel.status, 404);
  assert.equal(upstreamCalls, 0);
});

test("no fuzzy matching: a near-miss model id is rejected, not corrected", async () => {
  const handler = createHandler(makeDeps());
  const out = await handler.handleMessages(AUTH, messageBody("anthropic/poke-api/claude-opus-4"));
  assert.equal(out.status, 404);
});

test("credential load failure is 502 and never reaches upstream", async () => {
  let upstreamCalls = 0;
  const handler = createHandler(
    makeDeps({
      loadCredential: async () => ({ ok: false, reason: "decrypt failed" }),
      upstreamFetch: async () => { upstreamCalls += 1; throw new Error("must not run"); },
    }),
  );
  const out = await handler.handleMessages(AUTH, messageBody("anthropic/poke-api/claude-opus-5"));
  assert.equal(out.status, 502);
  assert.equal(upstreamCalls, 0);
});

test("error bodies never contain the credential or the token", async () => {
  const handler = createHandler(
    makeDeps({ upstreamFetch: async () => { throw new Error("connect ECONNREFUSED secret-key-leak"); } }),
  );
  const out = await handler.handleMessages(AUTH, messageBody("anthropic/poke-api/claude-opus-5"));
  assert.equal(out.status, 502);
  const text = JSON.stringify(out.body);
  assert.ok(!text.includes("synthetic-key"));
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes("secret-key-leak"));
});

test("unreadable or invalid store is 502", async () => {
  const unreadable = createHandler(makeDeps({ loadStore: () => ({ ok: false }) }));
  assert.equal((await unreadable.handleMessages(AUTH, messageBody("anthropic/poke-api/claude-opus-5"))).status, 502);

  const invalid = createHandler(makeDeps({ loadStore: () => ({ ok: true, store: { version: 1 } }) }));
  assert.equal((await invalid.handleMessages(AUTH, messageBody("anthropic/poke-api/claude-opus-5"))).status, 502);
});

test("upstream error status class is passed through without the raw body", async () => {
  const handler = createHandler(
    makeDeps({ upstreamFetch: async () => ({ ok: false, status: 429, json: async () => ({ secret: "leak" }) }) }),
  );
  const out = await handler.handleMessages(AUTH, messageBody("anthropic/poke-api/claude-opus-5"));
  assert.equal(out.status, 429);
  assert.ok(!JSON.stringify(out.body).includes("leak"));
});

test("handler supplies primary and fallback URLs in order to its retry boundary", async () => {
  const store = syntheticStore();
  store.providers["poke-api"].baseURL = "https://primary.invalid/v1///";
  store.providers["poke-api"].fallbackURLs = ["https://backup-one.invalid/v1/", "https://backup-two.invalid/v1"];
  const seen = {};
  const handler = createHandler(
    makeDeps({
      store,
      buildUpstreamURLs: (provider, path) => [provider.baseURL, ...provider.fallbackURLs]
        .map((baseURL) => `${baseURL.replace(/\/+$/, "")}${path}`),
      upstreamFetch: async (urls, init) => {
        seen.urls = urls;
        seen.init = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "fallback" }, finish_reason: "stop" }], usage: {} }),
        };
      },
    }),
  );

  const out = await handler.handleMessages(AUTH, messageBody("anthropic/poke-api/claude-opus-5"));
  assert.equal(out.status, 200);
  assert.deepEqual(seen.urls, [
    "https://primary.invalid/v1/chat/completions",
    "https://backup-one.invalid/v1/chat/completions",
    "https://backup-two.invalid/v1/chat/completions",
  ]);
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.authorization, "Bearer synthetic-key");
});

test("handler returns terminal 4xx from the retry boundary without exposing raw content", async () => {
  const calls = [];
  const handler = createHandler(
    makeDeps({
      upstreamFetch: async (urls) => {
        calls.push(urls);
        return { ok: false, status: 429, json: async () => ({ secret: "leak" }) };
      },
    }),
  );

  const out = await handler.handleMessages(AUTH, messageBody("anthropic/poke-api/claude-opus-5"));
  assert.equal(out.status, 429);
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(out.body).includes("leak"));
});

test("handler returns a generic 502 after the retry boundary exhausts every endpoint", async () => {
  const handler = createHandler(
    makeDeps({ upstreamFetch: async () => { throw new Error("primary-and-fallback-unavailable"); } }),
  );
  const out = await handler.handleMessages(AUTH, messageBody("anthropic/poke-api/claude-opus-5"));
  assert.equal(out.status, 502);
  assert.ok(!JSON.stringify(out.body).includes("primary-and-fallback-unavailable"));
});

test("malformed upstream JSON is 502", async () => {
  const handler = createHandler(
    makeDeps({ upstreamFetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad"); } }) }),
  );
  const out = await handler.handleMessages(AUTH, messageBody("anthropic/poke-api/claude-opus-5"));
  assert.equal(out.status, 502);
});

// ---------- §2.6 409 on stale catalog ----------

test("catalog change after discovery is 409 and never hits upstream", async () => {
  let upstreamCalls = 0;
  let store = syntheticStore();
  let generation = null;
  const handler = createHandler({
    token: TOKEN,
    loadStore: () => ({ ok: true, store }),
    loadCredential: async () => ({ ok: true, value: "synthetic-key" }),
    upstreamFetch: async () => {
      upstreamCalls += 1;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }) };
    },
    recordGeneration: (g) => { generation = g; },
    readGeneration: () => generation,
  });

  assert.equal((await handler.handleModels(AUTH)).status, 200);
  assert.equal((await handler.handleMessages(AUTH, messageBody("anthropic/poke-api/claude-opus-5"))).status, 200);
  assert.equal(upstreamCalls, 1);

  // Same provider id, different fallback endpoint: must NOT silently route.
  const swapped = syntheticStore();
  swapped.providers["poke-api"].fallbackURLs = ["https://attacker.invalid/v1"];
  store = swapped;

  const stale = await handler.handleMessages(AUTH, messageBody("anthropic/poke-api/claude-opus-5"));
  assert.equal(stale.status, 409);
  assert.match(stale.body.error.message, /re-run model discovery/);
  assert.equal(upstreamCalls, 1);
});

test("requests before any discovery are allowed (--model / ANTHROPIC_MODEL path)", async () => {
  // --model and ANTHROPIC_MODEL pass a wire ID through without a
  // discovery round-trip, so a null recorded generation must not 409.
  const handler = createHandler(makeDeps({ readGeneration: () => null }));
  const out = await handler.handleMessages(AUTH, messageBody("anthropic/poke-api/claude-opus-5"));
  assert.equal(out.status, 200);
});

// ---------- happy path ----------

test("valid request reaches upstream with the bare model id and Bearer key", async () => {
  const seen = {};
  const handler = createHandler(
    makeDeps({
      upstreamFetch: async (url, init) => {
        seen.url = url;
        seen.headers = init.headers;
        seen.body = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "c", choices: [{ message: { content: "pong" }, finish_reason: "stop" }], usage: {} }),
        };
      },
    }),
  );
  const out = await handler.handleMessages(AUTH, messageBody("anthropic/poke-api/claude-opus-5"));
  assert.equal(out.status, 200);
  assert.deepEqual(seen.url, ["https://upstream.invalid/v1/chat/completions"]);
  assert.equal(seen.headers.authorization, "Bearer synthetic-key");
  assert.equal(seen.body.model, "claude-opus-5");
  assert.equal(out.body.model, "anthropic/poke-api/claude-opus-5");
  assert.equal(out.body.content[0].text, "pong");
});

test("every catalog entry unpacks back to a store hit", async () => {
  const store = syntheticStore();
  const handler = createHandler(makeDeps({ store }));
  for (const entry of buildWireCatalog(store)) {
    const out = await handler.handleMessages(AUTH, messageBody(entry.wireId));
    assert.equal(out.status, 200, `${entry.wireId} should route`);
  }
});

test("every catalog entry unpacks back to a store hit when pools exist", async () => {
  const store = syntheticStore();
  store.pools = { "poke-pool": { displayName: "Poke Pool", members: ["poke-api", "nvidia-nim"] } };
  const handler = createHandler(makeDeps({ store }));
  for (const entry of buildWireCatalog(store)) {
    // Pool entries route through planPoolMessages (the server's pool branch);
    // plain provider entries take the classic handleMessages path.
    const plan = await handler.planPoolMessages(AUTH, messageBody(entry.wireId));
    if (plan === null) {
      const out = await handler.handleMessages(AUTH, messageBody(entry.wireId));
      assert.equal(out.status, 200, `${entry.wireId} should route`);
    } else {
      assert.equal(plan.ok, true, `${entry.wireId} pool plan must succeed`);
      assert.ok(plan.members.length >= 1, `${entry.wireId} must have a candidate member`);
    }
  }
});
