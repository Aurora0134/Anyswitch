import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPanelRouter } from "./panel.mjs";

// Store tab routes: the router is exercised with a mock store service so no
// real store, DPAPI, or network is touched. Mirrors the fakeReqRes pattern
// from panel.test.mjs / panel-skills.test.mjs.

function fakeReqRes(url, method = "GET", body = null, extraHeaders = {}) {
  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(code, h) { this.statusCode = code; this.headers = h || {}; },
    end(data) { if (data !== undefined) this.body += data; },
  };
  const listeners = {};
  const req = {
    url,
    method,
    headers: {
      host: "127.0.0.1:47820",
      origin: "http://127.0.0.1:47820",
      "x-apicred-panel": "1",
      ...extraHeaders,
    },
    on(event, fn) { listeners[event] = fn; return req; },
  };
  if (body !== null) {
    queueMicrotask(() => {
      listeners.data?.(Buffer.from(JSON.stringify(body)));
      listeners.end?.();
    });
  }
  const json = () => (res.body ? JSON.parse(res.body) : null);
  return { req, res, json };
}

function storeRouter(storeService) {
  return createPanelRouter({
    storePaths: { root: "C:/fake/apicred" },
    logger: null,
    metricsCollector: null,
    aliasResolver: null,
    aliasPath: null,
    fetchRelayAgents: async () => null,
    storeService,
  });
}

function mockService(overrides = {}) {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, arg: args.length > 1 ? args : args[0] });
    return mockResults[name]?.(...args) ?? { ok: true };
  };
  const mockResults = {
    getState: async () => ({
      ok: true,
      storeOk: true,
      hash: "abc123",
      providers: [{ id: "prov", displayName: "Prov", baseURL: "https://api.example.com/v1", fallbackURLs: [], modelCount: 2, discoveredCount: 3, filterCount: 2, hasCredential: true }],
      resumeResult: { resumed: [], failed: [] },
    }),
    getBoardState: async () => ({
      ok: true,
      storeOk: true,
      hash: "abc123",
      routingChains: [{ endpointId: "claude", chain: [{ node: "prov", model: "m1" }], enabled: true }],
      providerNames: { prov: "Prov" },
      poolNames: { "pool-x": "备用号池" },
    }),
    addProvider: async () => ({ ok: true, id: "prov", modelCount: 2 }),
    rotateProvider: async () => ({ ok: true, id: "prov" }),
    testProvider: async () => ({ ok: true, modelCount: 2 }),
    refreshProviders: async () => ({ ok: true, reports: [{ providerId: "prov", status: "updated", added: ["model-b"], pruned: [], reason: null }], anyFailed: false }),
    saveFilter: async () => ({ ok: true, effective: ["m1"] }),
    addModels: async () => ({ ok: true, added: ["m2"], models: ["m1", "m2"] }),
    removeModels: async () => ({ ok: true, removed: ["m2"], models: ["m1"] }),
    createPool: async () => ({ ok: true, poolId: "pool-x" }),
    deletePool: async () => ({ ok: true, poolId: "pool-x" }),
    renameProvider: async () => ({ ok: true, id: "prov", displayName: "新名字" }),
    renamePool: async () => ({ ok: true, poolId: "pool-x", displayName: "备用号池" }),
    updatePoolMembers: async () => ({ ok: true, poolId: "pool-x" }),
    reorderProviders: async () => ({ ok: true }),
    saveRouteChain: async () => ({ ok: true, endpointId: "claude" }),
    deleteRouteChain: async () => ({ ok: true, endpointId: "claude" }),
    deleteProvider: async () => ({ ok: true, deleted: true, modelCount: 2, credentialFile: "prov.dpapi" }),
    ...overrides,
  };
  const service = {};
  for (const name of Object.keys(mockResults)) service[name] = record(name);
  service.calls = calls;
  return service;
}

describe("panel router store routes", () => {
  it("GET /panel/api/store/state returns the service state verbatim", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/state", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.equal(json().storeOk, true);
    assert.equal(json().providers.length, 1);
    assert.equal(json().providers[0].id, "prov");
    assert.deepEqual(svc.calls.map((c) => c.name), ["getState"]);
  });

  it("GET /panel/api/store/board-state returns the lightweight board payload", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/board-state", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.equal(json().storeOk, true);
    assert.deepEqual(json().routingChains, [{ endpointId: "claude", chain: [{ node: "prov", model: "m1" }], enabled: true }]);
    assert.deepEqual(json().providerNames, { prov: "Prov" });
    assert.deepEqual(json().poolNames, { "pool-x": "备用号池" });
    assert.deepEqual(svc.calls.map((c) => c.name), ["getBoardState"]);
  });

  it("POST /panel/api/store/add forwards the add payload", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/add", "POST", {
      id: "prov",
      displayName: "Prov",
      baseURLs: "https://api.example.com/v1",
      apiKey: "sk-secret",
      modelIds: ["m1"],
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.deepEqual(svc.calls[0].arg, {
      id: "prov",
      displayName: "Prov",
      baseURLs: "https://api.example.com/v1",
      apiKey: "sk-secret",
      modelIds: ["m1"],
    });
  });

  it("POST /panel/api/store/add is 400 when id/baseURLs/apiKey is missing", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const missingId = fakeReqRes("/panel/api/store/add", "POST", { baseURLs: "https://x.example.com", apiKey: "k" });
    await router.handle(missingId.req, missingId.res);
    assert.equal(missingId.res.statusCode, 400);
    assert.equal(missingId.json().ok, false);

    const missingKey = fakeReqRes("/panel/api/store/add", "POST", { id: "prov", baseURLs: "https://x.example.com" });
    await router.handle(missingKey.req, missingKey.res);
    assert.equal(missingKey.res.statusCode, 400);

    const missingUrls = fakeReqRes("/panel/api/store/add", "POST", { id: "prov", apiKey: "k" });
    await router.handle(missingUrls.req, missingUrls.res);
    assert.equal(missingUrls.res.statusCode, 400);
    assert.deepEqual(svc.calls, []); // the service was never reached
  });

  it("POST /panel/api/store/rotate forwards only the provided fields", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/rotate", "POST", { id: "prov", apiKey: "sk-new" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.deepEqual(svc.calls[0].arg, { id: "prov", apiKey: "sk-new" });

    const urlOnly = fakeReqRes("/panel/api/store/rotate", "POST", { id: "prov", baseURLs: "https://new.example.com" });
    await router.handle(urlOnly.req, urlOnly.res);
    assert.equal(urlOnly.res.statusCode, 200);
    assert.deepEqual(svc.calls[1].arg, { id: "prov", baseURLs: "https://new.example.com" });
  });

  it("POST /panel/api/store/test forwards the provider id", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/test", "POST", { id: "prov" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().modelCount, 2);
    assert.equal(svc.calls[0].arg, "prov");
  });

  it("POST /panel/api/store/refresh forwards a single id or undefined for all", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const one = fakeReqRes("/panel/api/store/refresh", "POST", { id: "prov" });
    await router.handle(one.req, one.res);
    assert.equal(one.res.statusCode, 200);
    assert.equal(one.json().ok, true);
    assert.equal(svc.calls[0].arg, "prov");

    const all = fakeReqRes("/panel/api/store/refresh", "POST", {});
    await router.handle(all.req, all.res);
    assert.equal(all.res.statusCode, 200);
    assert.equal(svc.calls[1].arg, undefined);
  });

  it("POST /panel/api/store/filter validates modelFilter and forwards it", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/filter", "POST", { id: "prov", modelFilter: ["m1", "m2"] });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.deepEqual(svc.calls[0].arg, { id: "prov", modelFilter: ["m1", "m2"] });

    const bad = fakeReqRes("/panel/api/store/filter", "POST", { id: "prov", modelFilter: "m1" });
    await router.handle(bad.req, bad.res);
    assert.equal(bad.res.statusCode, 400);
    assert.equal(bad.json().ok, false);
    assert.deepEqual(svc.calls.length, 1); // rejected before the service
  });

  it("POST /panel/api/store/models/add forwards the manual add payload", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/models/add", "POST", { providerId: "prov", modelIds: ["m2", "m3"] });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.deepEqual(json().added, ["m2"]);
    assert.equal(svc.calls[0].name, "addModels");
    assert.deepEqual(svc.calls[0].arg, ["prov", ["m2", "m3"]]);
  });

  it("POST /panel/api/store/models/add is 400 on a malformed body", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const noIds = fakeReqRes("/panel/api/store/models/add", "POST", { providerId: "prov" });
    await router.handle(noIds.req, noIds.res);
    assert.equal(noIds.res.statusCode, 400);
    assert.equal(noIds.json().ok, false);

    const idsNotArray = fakeReqRes("/panel/api/store/models/add", "POST", { providerId: "prov", modelIds: "m2" });
    await router.handle(idsNotArray.req, idsNotArray.res);
    assert.equal(idsNotArray.res.statusCode, 400);

    const noProvider = fakeReqRes("/panel/api/store/models/add", "POST", { modelIds: ["m2"] });
    await router.handle(noProvider.req, noProvider.res);
    assert.equal(noProvider.res.statusCode, 400);
    assert.deepEqual(svc.calls, []); // the service was never reached
  });

  it("POST /panel/api/store/models/add is 400 with the model-exists message", async () => {
    const svc = mockService({
      addModels: async () => ({ ok: false, reason: "model-exists", duplicates: ["m1", "m2"] }),
    });
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/models/add", "POST", { providerId: "prov", modelIds: ["m1", "m2"] });
    await router.handle(req, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(json(), { ok: false, reason: "model-exists", message: "模型已存在: m1, m2" });
  });

  it("POST /panel/api/store/models/add maps an unknown provider to 400", async () => {
    const svc = mockService({
      addModels: async () => ({ ok: false, reason: "unknown-provider" }),
    });
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/models/add", "POST", { providerId: "nope", modelIds: ["m1"] });
    await router.handle(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(json().ok, false);
    assert.equal(json().reason, "unknown-provider");
    assert.match(json().message, /not managed/);
  });

  it("POST /panel/api/store/models/remove forwards the removal payload", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/models/remove", "POST", { providerId: "prov", modelIds: ["m2"] });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.deepEqual(json().removed, ["m2"]);
    assert.equal(svc.calls[0].name, "removeModels");
    assert.deepEqual(svc.calls[0].arg, ["prov", ["m2"]]);
  });

  it("POST /panel/api/store/models/remove is 400 on a malformed body", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const noIds = fakeReqRes("/panel/api/store/models/remove", "POST", { providerId: "prov" });
    await router.handle(noIds.req, noIds.res);
    assert.equal(noIds.res.statusCode, 400);
    assert.equal(noIds.json().ok, false);

    const idsNotArray = fakeReqRes("/panel/api/store/models/remove", "POST", { providerId: "prov", modelIds: "m2" });
    await router.handle(idsNotArray.req, idsNotArray.res);
    assert.equal(idsNotArray.res.statusCode, 400);

    const noProvider = fakeReqRes("/panel/api/store/models/remove", "POST", { modelIds: ["m2"] });
    await router.handle(noProvider.req, noProvider.res);
    assert.equal(noProvider.res.statusCode, 400);
    assert.deepEqual(svc.calls, []); // the service was never reached
  });

  it("POST /panel/api/store/models/remove is 400 with the model-not-found message", async () => {
    const svc = mockService({
      removeModels: async () => ({ ok: false, reason: "model-not-found", missing: ["m9"] }),
    });
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/models/remove", "POST", { providerId: "prov", modelIds: ["m9"] });
    await router.handle(req, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(json(), { ok: false, reason: "model-not-found", message: "模型不存在: m9" });
  });

  it("POST /panel/api/store/models/remove maps an unknown provider to 400", async () => {
    const svc = mockService({
      removeModels: async () => ({ ok: false, reason: "unknown-provider" }),
    });
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/models/remove", "POST", { providerId: "nope", modelIds: ["m1"] });
    await router.handle(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(json().ok, false);
    assert.equal(json().reason, "unknown-provider");
    assert.match(json().message, /not managed/);
  });

  it("POST /panel/api/store/delete forwards the provider id", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/delete", "POST", { id: "prov" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().deleted, true);
    assert.equal(svc.calls[0].arg, "prov");
  });

  it("POST /panel/api/store/pool/create forwards the pool payload", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/pool/create", "POST", {
      poolId: "pool-x",
      displayName: "主号池",
      members: ["prov-a", "prov-b"],
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), { ok: true, poolId: "pool-x" });
    assert.deepEqual(svc.calls[0], {
      name: "createPool",
      arg: { poolId: "pool-x", displayName: "主号池", members: ["prov-a", "prov-b"] },
    });
  });

  it("POST /panel/api/store/pool/create is 400 without members or poolId", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const noMembers = fakeReqRes("/panel/api/store/pool/create", "POST", { poolId: "p", displayName: "x" });
    await router.handle(noMembers.req, noMembers.res);
    assert.equal(noMembers.res.statusCode, 400);
    const noId = fakeReqRes("/panel/api/store/pool/create", "POST", { displayName: "x", members: ["a", "b"] });
    await router.handle(noId.req, noId.res);
    assert.equal(noId.res.statusCode, 400);
    assert.deepEqual(svc.calls, []);
  });

  it("POST /panel/api/store/pool/create surfaces the >5 rejection as 200 + {ok:false}", async () => {
    const svc = mockService({
      createPool: async () => ({ ok: false, error: "一个号池最多联立 5 个渠道（至少 2 个）；当前 6 个" }),
    });
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/pool/create", "POST", {
      poolId: "p",
      displayName: "x",
      members: ["a", "b", "c", "d", "e", "f"],
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, false);
    assert.match(json().error, /最多联立 5 个渠道/);
  });

  it("POST /panel/api/store/pool/delete forwards the pool id", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/pool/delete", "POST", { poolId: "pool-x" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), { ok: true, poolId: "pool-x" });
    assert.deepEqual(svc.calls[0], { name: "deletePool", arg: "pool-x" });
  });

  it("POST /panel/api/store/rename forwards the provider id and displayName", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/rename", "POST", { id: "prov", displayName: "新名字" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), { ok: true, id: "prov", displayName: "新名字" });
    assert.deepEqual(svc.calls[0], { name: "renameProvider", arg: ["prov", "新名字"] });
  });

  it("POST /panel/api/store/rename is 400 without a displayName", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res } = fakeReqRes("/panel/api/store/rename", "POST", { id: "prov" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(svc.calls, []);
  });

  it("POST /panel/api/store/pool/rename forwards the pool id and displayName", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/pool/rename", "POST", { poolId: "pool-x", displayName: "备用号池" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), { ok: true, poolId: "pool-x", displayName: "备用号池" });
    assert.deepEqual(svc.calls[0], { name: "renamePool", arg: ["pool-x", "备用号池"] });
  });

  it("POST /panel/api/store/pool/rename is 400 without a displayName", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res } = fakeReqRes("/panel/api/store/pool/rename", "POST", { poolId: "pool-x" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(svc.calls, []);
  });

  it("POST /panel/api/store/pool/members/update forwards poolId and members", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/pool/members/update", "POST", {
      poolId: "pool-x",
      members: ["prov-b", "prov-a", "prov-c"],
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), { ok: true, poolId: "pool-x" });
    assert.deepEqual(svc.calls[0], {
      name: "updatePoolMembers",
      arg: { poolId: "pool-x", members: ["prov-b", "prov-a", "prov-c"] },
    });
  });

  it("POST /panel/api/store/pool/members/update is 400 without members array or poolId", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const noMembers = fakeReqRes("/panel/api/store/pool/members/update", "POST", { poolId: "pool-x" });
    await router.handle(noMembers.req, noMembers.res);
    assert.equal(noMembers.res.statusCode, 400);
    const badMembers = fakeReqRes("/panel/api/store/pool/members/update", "POST", { poolId: "pool-x", members: "prov-a" });
    await router.handle(badMembers.req, badMembers.res);
    assert.equal(badMembers.res.statusCode, 400);
    const noId = fakeReqRes("/panel/api/store/pool/members/update", "POST", { members: ["a", "b"] });
    await router.handle(noId.req, noId.res);
    assert.equal(noId.res.statusCode, 400);
    assert.deepEqual(svc.calls, []);
  });

  it("POST /panel/api/store/pool/members/update surfaces a business failure as 200 + {ok:false}", async () => {
    const svc = mockService({
      updatePoolMembers: async () => ({ ok: false, error: "一个号池最多联立 5 个渠道（至少 2 个）；当前 6 个" }),
    });
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/pool/members/update", "POST", {
      poolId: "pool-x",
      members: ["a", "b", "c", "d", "e", "f"],
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, false);
    assert.match(json().error, /最多联立 5 个渠道/);
  });

  it("POST /panel/api/store/reorder forwards the order array to reorderProviders", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/reorder", "POST", {
      order: ["prov-c", "prov-a", "prov-b"],
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), { ok: true });
    assert.deepEqual(svc.calls[0], { name: "reorderProviders", arg: ["prov-c", "prov-a", "prov-b"] });
  });

  it("POST /panel/api/store/reorder is 400 when order is not an array", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const noOrder = fakeReqRes("/panel/api/store/reorder", "POST", {});
    await router.handle(noOrder.req, noOrder.res);
    assert.equal(noOrder.res.statusCode, 400);
    assert.deepEqual(noOrder.json(), { ok: false, error: "order must be an array of provider ids" });
    const badOrder = fakeReqRes("/panel/api/store/reorder", "POST", { order: "prov-a" });
    await router.handle(badOrder.req, badOrder.res);
    assert.equal(badOrder.res.statusCode, 400);
    assert.deepEqual(svc.calls, []);
  });

  it("surfaces a business failure as 200 + {ok:false} and a CAS conflict as cas-conflict", async () => {
    const svc = mockService({
      addProvider: async () => ({ ok: false, error: "Provider prov already exists" }),
      rotateProvider: async () => ({ ok: false, error: "cas-conflict" }),
    });
    const router = storeRouter(svc);
    const add = fakeReqRes("/panel/api/store/add", "POST", { id: "prov", baseURLs: "https://x.example.com", apiKey: "k" });
    await router.handle(add.req, add.res);
    assert.equal(add.res.statusCode, 200);
    assert.equal(add.json().ok, false);
    assert.match(add.json().error, /already exists/);

    const rotate = fakeReqRes("/panel/api/store/rotate", "POST", { id: "prov", apiKey: "k2" });
    await router.handle(rotate.req, rotate.res);
    assert.equal(rotate.res.statusCode, 200);
    assert.deepEqual(rotate.json(), { ok: false, error: "cas-conflict" });
  });

  it("POST /panel/api/store/route-chain/save forwards endpointId and chain", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const chain = [{ node: "prov-a", model: "m1" }, { node: "pool-x", model: "m2" }];
    const { req, res, json } = fakeReqRes("/panel/api/store/route-chain/save", "POST", {
      endpointId: "claude",
      chain,
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), { ok: true, endpointId: "claude" });
    assert.deepEqual(svc.calls[0], { name: "saveRouteChain", arg: ["claude", chain] });
  });

  it("POST /panel/api/store/route-chain/save is 400 without a string endpointId or an array chain", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const chain = [{ node: "prov-a", model: "m1" }];
    const noId = fakeReqRes("/panel/api/store/route-chain/save", "POST", { chain });
    await router.handle(noId.req, noId.res);
    assert.equal(noId.res.statusCode, 400);
    const badId = fakeReqRes("/panel/api/store/route-chain/save", "POST", { endpointId: 42, chain });
    await router.handle(badId.req, badId.res);
    assert.equal(badId.res.statusCode, 400);
    const noChain = fakeReqRes("/panel/api/store/route-chain/save", "POST", { endpointId: "claude" });
    await router.handle(noChain.req, noChain.res);
    assert.equal(noChain.res.statusCode, 400);
    const badChain = fakeReqRes("/panel/api/store/route-chain/save", "POST", { endpointId: "claude", chain: "prov-a" });
    await router.handle(badChain.req, badChain.res);
    assert.equal(badChain.res.statusCode, 400);
    assert.deepEqual(svc.calls, []);
  });

  it("POST /panel/api/store/route-chain/save surfaces a business failure as 200 + {ok:false}", async () => {
    const svc = mockService({
      saveRouteChain: async () => ({ ok: false, error: "unknown endpoint: cursor" }),
    });
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/route-chain/save", "POST", {
      endpointId: "cursor",
      chain: [{ node: "prov-a", model: "m1" }],
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, false);
    assert.match(json().error, /unknown endpoint/);
  });

  it("POST /panel/api/store/route-chain/delete forwards endpointId", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/route-chain/delete", "POST", { endpointId: "claude" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), { ok: true, endpointId: "claude" });
    assert.deepEqual(svc.calls[0], { name: "deleteRouteChain", arg: "claude" });
  });

  it("POST /panel/api/store/route-chain/delete is 400 without a string endpointId", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const noId = fakeReqRes("/panel/api/store/route-chain/delete", "POST", {});
    await router.handle(noId.req, noId.res);
    assert.equal(noId.res.statusCode, 400);
    const badId = fakeReqRes("/panel/api/store/route-chain/delete", "POST", { endpointId: 42 });
    await router.handle(badId.req, badId.res);
    assert.equal(badId.res.statusCode, 400);
    assert.deepEqual(svc.calls, []);
  });

  it("POST /panel/api/store/route-chain/delete surfaces a business failure as 200 + {ok:false}", async () => {
    const svc = mockService({
      deleteRouteChain: async () => ({ ok: false, error: "no route chain for endpoint: claude" }),
    });
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/route-chain/delete", "POST", { endpointId: "claude" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, false);
    assert.match(json().error, /no route chain/);
  });

  it("rejects untrusted POSTs with 403 before the service is reached", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    for (const path of ["/panel/api/store/add", "/panel/api/store/rotate", "/panel/api/store/test", "/panel/api/store/refresh", "/panel/api/store/filter", "/panel/api/store/models/add", "/panel/api/store/models/remove", "/panel/api/store/pool/create", "/panel/api/store/pool/delete", "/panel/api/store/rename", "/panel/api/store/pool/rename", "/panel/api/store/pool/members/update", "/panel/api/store/reorder", "/panel/api/store/route-chain/save", "/panel/api/store/route-chain/delete", "/panel/api/store/delete"]) {
      const noHeader = fakeReqRes(path, "POST", { id: "prov", modelFilter: [] }, { "x-apicred-panel": "0" });
      await router.handle(noHeader.req, noHeader.res);
      assert.equal(noHeader.res.statusCode, 403, `${path} without the panel header`);
      assert.equal(noHeader.json().error, "csrf");

      const evilOrigin = fakeReqRes(path, "POST", { id: "prov", modelFilter: [] }, { origin: "http://evil.example.com" });
      await router.handle(evilOrigin.req, evilOrigin.res);
      assert.equal(evilOrigin.res.statusCode, 403, `${path} with an evil origin`);
    }
    assert.deepEqual(svc.calls, []);
  });

  it("404s an unknown store API path", async () => {
    const svc = mockService();
    const router = storeRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/store/nonsense", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 404);
    assert.equal(json().error, "not found");
  });
});
