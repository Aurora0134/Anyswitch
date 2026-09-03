import assert from "node:assert/strict";
import test from "node:test";
import { validateStore } from "./store-schema.mjs";

function legalStore() {
  return {
    version: 2,
    providers: {
      deepseek: {
        displayName: "DeepSeek",
        baseURL: "https://api.deepseek.com/v1",
        protocol: "openai-compatible",
        credentialFile: "credential-11111111-1111-1111-1111-111111111111.dpapi",
        models: {
          "deepseek-chat": { displayName: "DeepSeek V4 Flash", contextWindow: 128000, maxOutputTokens: 16384 },
          "deepseek-reasoner": { displayName: "DeepSeek Reasoner" },
        },
      },
    },
  };
}

test("validateStore accepts a well-formed v2 store", () => {
  const result = validateStore(legalStore());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateStore accepts a legacy deletedModels list on a provider", () => {
  // The short-lived tombstone experiment (reverted: refresh re-adds removed
  // discovered models) may have left deletedModels fields in real store.json
  // files; the field is inert now but must never trip the secret-like key
  // scan (the relay validates the store on every request).
  const store = legalStore();
  store.providers.deepseek.deletedModels = ["deepseek-reasoner"];
  const result = validateStore(store);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateStore accepts an empty clientPolicies exceptions list", () => {
  const store = legalStore();
  store.clientPolicies = { opencode: { literalCredentialExceptions: [] } };
  const result = validateStore(store);
  assert.equal(result.valid, true);
});

test("validateStore rejects a missing version", () => {
  const store = legalStore();
  delete store.version;
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /version/i.test(e)), true);
});

test("validateStore rejects a version other than 2", () => {
  const store = legalStore();
  store.version = 1;
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /version/i.test(e)), true);
});

test("validateStore rejects a secret-like field on a provider (case-insensitive)", () => {
  const store = legalStore();
  store.providers.deepseek.apiKey = "sk-should-not-be-here";
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /secret|key|apiKey/i.test(e)), true);
});

test("validateStore rejects a secret-like field nested inside a model", () => {
  const store = legalStore();
  store.providers.deepseek.models["deepseek-chat"].authorization = "Bearer x";
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /authorization|secret/i.test(e)), true);
});

test("validateStore rejects a bearer field anywhere", () => {
  const store = legalStore();
  store.providers.deepseek.bearer = "abc";
  const result = validateStore(store);
  assert.equal(result.valid, false);
});

test("validateStore rejects a non-positive-integer contextWindow", () => {
  const store = legalStore();
  store.providers.deepseek.models["deepseek-chat"].contextWindow = 0;
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /contextWindow/i.test(e)), true);
});

test("validateStore rejects a fractional maxOutputTokens", () => {
  const store = legalStore();
  store.providers.deepseek.models["deepseek-chat"].maxOutputTokens = 1.5;
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /maxOutputTokens/i.test(e)), true);
});

test("validateStore rejects a null model displayName", () => {
  const store = legalStore();
  store.providers.deepseek.models["deepseek-chat"].displayName = null;
  const result = validateStore(store);
  assert.equal(result.valid, false);
});

test("validateStore rejects a provider whose protocol is not openai-compatible", () => {
  const store = legalStore();
  store.providers.deepseek.protocol = "anthropic";
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /protocol/i.test(e)), true);
});

test("validateStore rejects two provider ids that differ only by case", () => {
  const store = legalStore();
  store.providers.DeepSeek = { ...store.providers.deepseek };
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /case|duplicate/i.test(e)), true);
});

// credentialFile path safety must be enforced at the schema
// boundary, not only in the standalone credential-ref validator. A malicious
// credentialFile that escapes the store root must fail validateStore().
test("validateStore rejects an absolute-drive credentialFile", () => {
  const store = legalStore();
  store.providers.deepseek.credentialFile = "C:\\outside.dpapi";
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /credentialFile/i.test(e)), true);
});

test("validateStore rejects a parent-traversal credentialFile", () => {
  const store = legalStore();
  store.providers.deepseek.credentialFile = "..\\secrets\\other.dpapi";
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /credentialFile/i.test(e)), true);
});

test("validateStore rejects a UNC credentialFile", () => {
  const store = legalStore();
  store.providers.deepseek.credentialFile = "\\\\server\\share\\cred.dpapi";
  const result = validateStore(store);
  assert.equal(result.valid, false);
});

test("validateStore rejects a credentialFile with an embedded separator", () => {
  const store = legalStore();
  store.providers.deepseek.credentialFile = "sub/cred.dpapi";
  const result = validateStore(store);
  assert.equal(result.valid, false);
});

test("validateStore rejects a credentialFile that is a reserved device name", () => {
  const store = legalStore();
  store.providers.deepseek.credentialFile = "nul.dpapi";
  const result = validateStore(store);
  assert.equal(result.valid, false);
});

test("validateStore rejects a credentialFile with a trailing dot", () => {
  const store = legalStore();
  store.providers.deepseek.credentialFile = "cred.dpapi.";
  const result = validateStore(store);
  assert.equal(result.valid, false);
});

// ---- provider id must never contain '/' (wire-ID invariant) --------------
// The Claude wire ID `anthropic/<provider-id>/<model-id>` is unpacked by
// splitting on the first '/' after the prefix. That reversibility only holds
// if a provider id can never contain '/'. This is a v2 store hard invariant,
// not just a character-whitelist side effect, so it must fail with a message
// that names the slash / wire-ID reason.
test("validateStore rejects a provider id containing a slash (wire-ID invariant)", () => {
  const store = legalStore();
  store.providers["a/b"] = { ...store.providers.deepseek };
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((e) => /slash|wire/i.test(e) && /a\/b/.test(e)),
    true,
    "error must name the slash/wire-ID reason and the offending id",
  );
});

test("validateStore rejects a provider id that is only a slash", () => {
  const store = legalStore();
  store.providers["/"] = { ...store.providers.deepseek };
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /slash|wire/i.test(e)), true);
});

test("validateStore rejects a provider id with an embedded model-like slash path", () => {
  const store = legalStore();
  store.providers["nvidia/nim"] = { ...store.providers.deepseek };
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /slash|wire/i.test(e)), true);
});

// ---- secret field detection matrix: comprehensive coverage --------------
// Ensure the segment-based detection catches various naming conventions and
// doesn't false-positive on legit fields (residual risk from reviewer).

test("secret field matrix: various sensitive field names are rejected", () => {
  const cases = [
    "apiKey",
    "api_key",
    "API_KEY",
    "accessToken",
    "access_token",
    "client_secret",
    "clientSecret",
    "password",
    "PASSWORD",
    "bearerToken",
    "authorization",
    "AUTHORIZATION",
    "authToken",
  ];
  for (const field of cases) {
    const store = legalStore();
    store.providers.deepseek[field] = "should-not-be-here";
    const result = validateStore(store);
    assert.equal(result.valid, false, `${field} should be rejected but was not`);
  }
});

test("secret field matrix: nested secret fields in arrays and objects are caught", () => {
  const store = legalStore();
  store.providers.deepseek.nested = { secret: "value" };
  assert.equal(validateStore(store).valid, false);
  const store2 = legalStore();
  store2.providers.deepseek.arr = [{ password: "x" }];
  assert.equal(validateStore(store2).valid, false);
});

test("secret field matrix: legitimate fields are NOT rejected", () => {
  const legitFields = ["credentialFile", "maxOutputTokens", "displayName", "baseURL", "protocol"];
  for (const field of legitFields) {
    const store = legalStore();
    store.providers.deepseek[field] = store.providers.deepseek[field] ?? "test-value";
    const result = validateStore(store);
    assert.equal(result.valid, true, `${field} should NOT be rejected but was flagged as secret`);
  }
});

// ---- resolver → store-schema link: illegal limit values are caught ------
// The resolver passes limit values through when present (catalog-resolver
// contract: "write only when present"); store-schema enforces legality.
test("validateStore rejects a non-positive-integer contextWindow from an upstream resolver", () => {
  const store = legalStore();
  store.providers.deepseek.models["deepseek-chat"].contextWindow = 1.5;
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /contextWindow/i.test(e)), true);
});

test("validateStore rejects a zero maxOutputTokens from an upstream resolver", () => {
  const store = legalStore();
  store.providers.deepseek.models["deepseek-chat"].maxOutputTokens = 0;
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /maxOutputTokens/i.test(e)), true);
});

// ---- fallbackURLs (BaseURL 无感退避): optional ordered backup endpoints ----
// The relay walks [baseURL, ...fallbackURLs] per request. The field is optional
// (stores written before it existed must stay valid) but never meaningless:
// an empty array or non-string entries are configuration errors.
test("validateStore accepts an ordered fallbackURLs list", () => {
  const store = legalStore();
  store.providers.deepseek.fallbackURLs = [
    "https://backup-one.deepseek.com/v1",
    "https://backup-two.deepseek.com/v1",
  ];
  const result = validateStore(store);
  assert.equal(result.valid, true);
});

test("validateStore rejects an empty fallbackURLs array", () => {
  const store = legalStore();
  store.providers.deepseek.fallbackURLs = [];
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /fallbackURLs/i.test(e)), true);
});

test("validateStore rejects non-array or non-string fallbackURLs entries", () => {
  for (const fallbackURLs of ["https://backup.example/v1", [""], [42], {}]) {
    const store = legalStore();
    store.providers.deepseek.fallbackURLs = fallbackURLs;
    const result = validateStore(store);
    assert.equal(result.valid, false, JSON.stringify(fallbackURLs));
    assert.equal(
      result.errors.some((e) => /fallbackURLs/i.test(e)),
      true,
      JSON.stringify(fallbackURLs),
    );
  }
});

// ---- pools (号池, panel 一期): top-level map of grouped providers ----------
// Phase 1 is panel-only: the relay never resolves pools, but the schema
// validates them on every request (loadStore runs per request), so malformed
// pools must be rejected the same way malformed providers are. Pool ids share
// the provider id alphabet and namespace so phase 2 endpoint routing needs no
// id migration.
function legalStoreWithPool() {
  const store = legalStore();
  store.providers.zhipu = {
    displayName: "Zhipu",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai-compatible",
    credentialFile: "credential-22222222-2222-2222-2222-222222222222.dpapi",
    models: { "glm-5": { displayName: "GLM 5" } },
  };
  store.pools = {
    "main-pool": { displayName: "主号池", members: ["deepseek", "zhipu"] },
  };
  return store;
}

test("validateStore accepts a well-formed pools map", () => {
  const result = validateStore(legalStoreWithPool());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateStore rejects a non-object pools field", () => {
  for (const pools of [[], "x", 42, null]) {
    const store = legalStoreWithPool();
    store.pools = pools;
    const result = validateStore(store);
    assert.equal(result.valid, false, JSON.stringify(pools));
    assert.equal(result.errors.some((e) => /pools/i.test(e)), true);
  }
});

test("validateStore rejects pool members referencing a missing provider", () => {
  const store = legalStoreWithPool();
  store.pools["main-pool"].members = ["deepseek", "ghost"];
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /ghost.*does not exist/i.test(e)), true);
});

test("validateStore rejects a provider claimed by two pools", () => {
  const store = legalStoreWithPool();
  store.providers.moonshot = {
    displayName: "Moonshot",
    baseURL: "https://api.moonshot.cn/v1",
    protocol: "openai-compatible",
    credentialFile: "credential-33333333-3333-3333-3333-333333333333.dpapi",
    models: { "kimi-k3": { displayName: "Kimi K3" } },
  };
  store.pools["second-pool"] = { displayName: "二号池", members: ["deepseek", "moonshot"] };
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /already belongs to pool/i.test(e)), true);
});

test("validateStore rejects a pool id colliding with a non-member provider id (case-insensitive)", () => {
  const store = legalStoreWithPool();
  delete store.pools["main-pool"];
  store.providers.moonshot = {
    displayName: "Moonshot",
    baseURL: "https://api.moonshot.cn/v1",
    protocol: "openai-compatible",
    credentialFile: "credential-33333333-3333-3333-3333-333333333333.dpapi",
    models: { "kimi-k3": { displayName: "Kimi K3" } },
  };
  store.pools["DeepSeek"] = { displayName: "撞名池", members: ["zhipu", "moonshot"] };
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /collides|differs only by case/i.test(e)), true);
});

test("validateStore accepts a pool id reusing one of its own members' ids", () => {
  const store = legalStoreWithPool();
  delete store.pools["main-pool"];
  store.pools["deepseek"] = { displayName: "收编池", members: ["deepseek", "zhipu"] };
  const result = validateStore(store);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateStore rejects pools with fewer than 2 or more than 5 members", () => {
  const store1 = legalStoreWithPool();
  store1.pools["main-pool"].members = ["deepseek"];
  assert.equal(validateStore(store1).valid, false);
  const store2 = legalStoreWithPool();
  for (const id of ["m3", "m4", "m5", "m6"]) {
    store2.providers[id] = {
      displayName: id,
      baseURL: `https://api.${id}.example/v1`,
      protocol: "openai-compatible",
      credentialFile: `credential-44444444-4444-4444-4444-44444444444${id.slice(1)}.dpapi`,
      models: { x: { displayName: "x" } },
    };
  }
  store2.pools["main-pool"].members = ["deepseek", "zhipu", "m3", "m4", "m5", "m6"];
  const result = validateStore(store2);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /2-5/.test(e)), true);
});

test("validateStore rejects illegal pool ids (slash and bad characters)", () => {
  const store = legalStoreWithPool();
  delete store.pools["main-pool"];
  store.pools["bad/pool"] = { displayName: "x", members: ["deepseek", "zhipu"] };
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /must not contain '\/'/.test(e)), true);
});

test("validateStore rejects duplicate members inside one pool", () => {
  const store = legalStoreWithPool();
  store.pools["main-pool"].members = ["deepseek", "deepseek"];
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /duplicate member/i.test(e)), true);
});

test("validateStore rejects secret-like fields inside pools", () => {
  const store = legalStoreWithPool();
  store.pools["main-pool"].apiKey = "sk-should-not-be-here";
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /secret-like/i.test(e)), true);
});

// ---- routingChains (自动路由): per-endpoint ordered fallback chains --------
// Each coding-agent endpoint may carry one route chain: an ordered array of
// { node, model } entries. node names a provider OR a pool (resolution checks
// pools first, same as pool-routing.mjs); model is the concrete upstream
// model the node is asked for. The map is optional; when present every chain
// is validated on each load like pools are.
function legalStoreWithChains() {
  const store = legalStoreWithPool();
  store.routingChains = {
    claude: {
      chain: [
        { node: "main-pool", model: "glm-5" },
        { node: "deepseek", model: "deepseek-chat" },
      ],
    },
    kimi: { chain: [{ node: "zhipu", model: "glm-5" }] },
  };
  return store;
}

test("validateStore accepts well-formed routingChains (provider and pool nodes)", () => {
  const result = validateStore(legalStoreWithChains());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateStore accepts a bound model that is not in the node's catalog", () => {
  // Catalogs shift with discovered refreshes, so the schema deliberately does
  // NOT hard-validate chain models against provider catalogs.
  const store = legalStoreWithChains();
  store.routingChains.claude.chain = [{ node: "deepseek", model: "not-in-any-catalog" }];
  const result = validateStore(store);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateStore rejects a non-object routingChains field", () => {
  for (const routingChains of [[], "x", 42, null]) {
    const store = legalStoreWithChains();
    store.routingChains = routingChains;
    const result = validateStore(store);
    assert.equal(result.valid, false, JSON.stringify(routingChains));
    assert.equal(result.errors.some((e) => /routingChains/i.test(e)), true);
  }
});

test("validateStore rejects an unknown endpoint id in routingChains", () => {
  const store = legalStoreWithChains();
  store.routingChains.cursor = { chain: [{ node: "deepseek", model: "deepseek-chat" }] };
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /routingChains\.cursor.*unknown endpoint/i.test(e)), true);
});

test("validateStore rejects a non-object routing chain entry", () => {
  const store = legalStoreWithChains();
  store.routingChains.claude = [{ node: "deepseek", model: "deepseek-chat" }];
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /routingChains\.claude: .*must be an object/i.test(e)), true);
});

test("validateStore rejects an empty or oversized chain (max 8 nodes)", () => {
  const store1 = legalStoreWithChains();
  store1.routingChains.claude.chain = [];
  const result1 = validateStore(store1);
  assert.equal(result1.valid, false);
  assert.equal(result1.errors.some((e) => /chain.*non-empty array/i.test(e)), true);

  const store2 = legalStoreWithChains();
  for (const id of ["m3", "m4", "m5", "m6", "m7", "m8"]) {
    store2.providers[id] = {
      displayName: id,
      baseURL: `https://api.${id}.example/v1`,
      protocol: "openai-compatible",
      credentialFile: `credential-55555555-5555-5555-5555-55555555555${id.slice(1)}.dpapi`,
      models: { x: { displayName: "x" } },
    };
  }
  store2.routingChains.claude.chain = ["deepseek", "zhipu", "main-pool", "m3", "m4", "m5", "m6", "m7", "m8"]
    .map((node) => ({ node, model: "x" }));
  const result2 = validateStore(store2);
  assert.equal(result2.valid, false);
  assert.equal(result2.errors.some((e) => /chain.*1-8|at most 8/i.test(e)), true);
});

test("validateStore rejects chain items that are not { node, model } objects", () => {
  const store = legalStoreWithChains();
  store.routingChains.claude.chain = ["deepseek"];
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /chain\[0\].*must be an object/i.test(e)), true);
});

test("validateStore rejects chain items with a missing/empty node or model", () => {
  const store1 = legalStoreWithChains();
  store1.routingChains.claude.chain = [{ model: "deepseek-chat" }];
  const result1 = validateStore(store1);
  assert.equal(result1.valid, false);
  assert.equal(result1.errors.some((e) => /chain\[0\]\.node.*non-empty string/i.test(e)), true);

  const store2 = legalStoreWithChains();
  store2.routingChains.claude.chain = [{ node: "deepseek", model: "  " }];
  const result2 = validateStore(store2);
  assert.equal(result2.valid, false);
  assert.equal(result2.errors.some((e) => /chain\[0\]\.model.*non-empty string/i.test(e)), true);

  const store3 = legalStoreWithChains();
  store3.routingChains.claude.chain = [{ node: "deepseek" }];
  assert.equal(validateStore(store3).valid, false);
});

test("validateStore rejects illegal chain node ids (slash and bad characters)", () => {
  const store = legalStoreWithChains();
  store.routingChains.claude.chain = [
    { node: "deepseek", model: "deepseek-chat" },
    { node: "bad/id", model: "x" },
  ];
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /chain\[1\].*letters, digits/i.test(e)), true);
});

test("validateStore rejects chain nodes that exist neither as provider nor pool", () => {
  const store = legalStoreWithChains();
  store.routingChains.claude.chain = [
    { node: "deepseek", model: "deepseek-chat" },
    { node: "ghost", model: "x" },
  ];
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /ghost.*does not exist/i.test(e)), true);
});

test("validateStore accepts the same node multiple times when the bound models differ", () => {
  // 链节点按 node+model 复合键去重：同一节点可绑定不同模型多次入链
  // （相邻与相间都合法）。
  const adjacent = legalStoreWithChains();
  adjacent.routingChains.claude.chain = [
    { node: "deepseek", model: "deepseek-chat" },
    { node: "deepseek", model: "deepseek-reasoner" },
  ];
  assert.equal(validateStore(adjacent).valid, true);

  const interleaved = legalStoreWithChains();
  interleaved.routingChains.claude.chain = [
    { node: "deepseek", model: "deepseek-chat" },
    { node: "zhipu", model: "glm-5" },
    { node: "deepseek", model: "deepseek-reasoner" },
  ];
  assert.equal(validateStore(interleaved).valid, true);
});

test("validateStore rejects the same node+model pair twice inside one chain", () => {
  const store = legalStoreWithChains();
  store.routingChains.claude.chain = [
    { node: "deepseek", model: "deepseek-chat" },
    { node: "zhipu", model: "glm-5" },
    { node: "deepseek", model: "deepseek-chat" },
  ];
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((e) => /duplicate node "deepseek" with model "deepseek-chat"/i.test(e)),
    true,
  );
});

test("validateStore rejects secret-like fields inside routingChains", () => {
  const store = legalStoreWithChains();
  store.routingChains.claude.apiKey = "sk-should-not-be-here";
  const result = validateStore(store);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((e) => /secret-like/i.test(e)), true);
});

// ---- routingChains entry.enabled: per-endpoint 自动路由启用开关（可选布尔）----
test("validateStore accepts an optional boolean enabled flag on routing chain entries", () => {
  for (const enabled of [true, false]) {
    const store = legalStoreWithChains();
    store.routingChains.claude.enabled = enabled;
    const result = validateStore(store);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual(result.errors, []);
  }
});

test("validateStore rejects a non-boolean enabled flag on routing chain entries", () => {
  for (const enabled of ["true", 1, 0, null, {}]) {
    const store = legalStoreWithChains();
    store.routingChains.claude.enabled = enabled;
    const result = validateStore(store);
    assert.equal(result.valid, false, JSON.stringify(enabled));
    assert.equal(result.errors.some((e) => /routingChains\.claude\.enabled: .*boolean/i.test(e)), true);
  }
});
