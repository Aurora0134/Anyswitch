import test, { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelRouter, createPromptsPanelService } from "./panel.mjs";
import { MANAGED_BEGIN } from "./agent-prompts-inject.mjs";

// Prompts tab routes: the router is exercised with a mock prompts service so
// no real home directories or instruction files are touched. Mirrors the
// fakeReqRes pattern from panel-skills.test.mjs.

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
      host: "127.0.0.1",
      origin: "http://127.0.0.1:47820",
      "x-anyswitch-panel": "1",
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

function promptsRouter(promptsService) {
  return createPanelRouter({
    storePaths: { root: "C:/fake/anyswitch" },
    logger: null,
    metricsCollector: null,
    aliasResolver: null,
    aliasPath: null,
    fetchRelayAgents: async () => null,
    promptsService,
  });
}

function mockService(overrides = {}) {
  return {
    getState: () => ({
      enabled: false,
      presets: [],
      endpointOverrides: {},
      endpoints: [{ id: "claude", label: "Claude Code", hotReload: false, targetRel: "~/.claude/CLAUDE.md" }],
      sync: {},
    }),
    setMaster: (enabled) => ({ enabled }),
    createPreset: ({ title }) => ({ preset: { id: "aaaaaaaaaaaa", title, tag: "", enabled: true, content: "c" } }),
    updatePreset: ({ id, title }) => ({ preset: { id, title } }),
    deletePreset: () => ({}),
    setPresetEnabled: ({ id, enabled }) => ({ id, enabled }),
    setOverride: ({ endpointId, presetId, off }) => ({ endpointId, presetId, off }),
    ...overrides,
  };
}

describe("panel router prompts routes", () => {
  it("GET /panel/api/prompts/state serves the facade state verbatim", async () => {
    const state = {
      enabled: true,
      presets: [{ id: "aaaaaaaaaaaa", title: "A", tag: "t", enabled: true, content: "c", createdAt: "x", updatedAt: "x" }],
      endpointOverrides: { claude: { off: ["aaaaaaaaaaaa"] } },
      endpoints: [
        { id: "claude", label: "Claude Code", hotReload: false, targetRel: "~/.claude/CLAUDE.md" },
        { id: "kimi", label: "Kimi Code", hotReload: true, targetRel: "~/.kimi-code/AGENTS.md" },
      ],
      sync: { claude: { ok: true }, kimi: { ok: false, error: "EPERM" } },
    };
    const router = promptsRouter(mockService({ getState: () => state }));
    const { req, res, json } = fakeReqRes("/panel/api/prompts/state", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.deepEqual(json().presets, state.presets);
    assert.deepEqual(json().endpointOverrides, state.endpointOverrides);
    assert.deepEqual(json().endpoints, state.endpoints);
    assert.deepEqual(json().sync, state.sync);
  });

  it("POST /panel/api/prompts/master forwards the boolean and validates it", async () => {
    let got = null;
    const router = promptsRouter(mockService({ setMaster: (enabled) => { got = enabled; return { enabled }; } }));
    const { req, res, json } = fakeReqRes("/panel/api/prompts/master", "POST", { enabled: true });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.equal(got, true);

    const bad = fakeReqRes("/panel/api/prompts/master", "POST", { enabled: "yes" });
    await router.handle(bad.req, bad.res);
    assert.equal(bad.res.statusCode, 400);
    assert.equal(bad.json().ok, false);
  });

  it("POST /panel/api/prompts/preset/create forwards title/tag/content", async () => {
    let got = null;
    const router = promptsRouter(mockService({
      createPreset: (fields) => { got = fields; return { preset: { id: "aaaaaaaaaaaa", ...fields, enabled: true } }; },
    }));
    const { req, res, json } = fakeReqRes("/panel/api/prompts/preset/create", "POST", {
      title: "规则A", tag: "安全", content: "先读文件",
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(got, { title: "规则A", tag: "安全", content: "先读文件" });
    assert.equal(json().preset.id, "aaaaaaaaaaaa");

    // tag omitted → empty string default
    const noTag = fakeReqRes("/panel/api/prompts/preset/create", "POST", { title: "B", content: "x" });
    await router.handle(noTag.req, noTag.res);
    assert.equal(noTag.res.statusCode, 200);
    assert.equal(got.tag, "");

    for (const body of [{ title: "", content: "x" }, { title: "B" }, { title: "B", content: 42 }]) {
      const bad = fakeReqRes("/panel/api/prompts/preset/create", "POST", body);
      await router.handle(bad.req, bad.res);
      assert.equal(bad.res.statusCode, 400, JSON.stringify(body));
    }
  });

  it("POST /panel/api/prompts/preset/update forwards all fields and maps service errors", async () => {
    let got = null;
    const router = promptsRouter(mockService({
      updatePreset: (fields) => {
        got = fields;
        if (fields.id === "ghost") {
          const error = new Error(`预设不存在: ${fields.id}`);
          error.statusCode = 404;
          throw error;
        }
        return { preset: fields };
      },
    }));
    const ok = fakeReqRes("/panel/api/prompts/preset/update", "POST", {
      id: "aaaaaaaaaaaa", title: "新", tag: "b", content: "v2",
    });
    await router.handle(ok.req, ok.res);
    assert.equal(ok.res.statusCode, 200);
    assert.deepEqual(got, { id: "aaaaaaaaaaaa", title: "新", tag: "b", content: "v2" });

    const missing = fakeReqRes("/panel/api/prompts/preset/update", "POST", {
      id: "ghost", title: "x", content: "y",
    });
    await router.handle(missing.req, missing.res);
    assert.equal(missing.res.statusCode, 404);
    assert.equal(missing.json().ok, false);
  });

  it("POST /panel/api/prompts/preset/delete and preset/enable forward args", async () => {
    const calls = [];
    const router = promptsRouter(mockService({
      deletePreset: (id) => { calls.push(["delete", id]); return {}; },
      setPresetEnabled: (args) => { calls.push(["enable", args]); return args; },
    }));
    const del = fakeReqRes("/panel/api/prompts/preset/delete", "POST", { id: "aaaaaaaaaaaa" });
    await router.handle(del.req, del.res);
    assert.equal(del.res.statusCode, 200);
    assert.equal(del.json().ok, true);

    const en = fakeReqRes("/panel/api/prompts/preset/enable", "POST", { id: "aaaaaaaaaaaa", enabled: false });
    await router.handle(en.req, en.res);
    assert.equal(en.res.statusCode, 200);
    assert.deepEqual(calls, [["delete", "aaaaaaaaaaaa"], ["enable", { id: "aaaaaaaaaaaa", enabled: false }]]);

    for (const [path, body] of [
      ["/panel/api/prompts/preset/delete", {}],
      ["/panel/api/prompts/preset/enable", { id: "x" }],
      ["/panel/api/prompts/preset/enable", { id: "x", enabled: 1 }],
    ]) {
      const bad = fakeReqRes(path, "POST", body);
      await router.handle(bad.req, bad.res);
      assert.equal(bad.res.statusCode, 400, `${path} ${JSON.stringify(body)}`);
    }
  });

  it("POST /panel/api/prompts/override forwards endpointId/presetId/off", async () => {
    let got = null;
    const router = promptsRouter(mockService({
      setOverride: (args) => { got = args; return args; },
    }));
    const { req, res, json } = fakeReqRes("/panel/api/prompts/override", "POST", {
      endpointId: "claude", presetId: "aaaaaaaaaaaa", off: true,
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(got, { endpointId: "claude", presetId: "aaaaaaaaaaaa", off: true });
    assert.equal(json().ok, true);

    for (const body of [
      { presetId: "x", off: true },
      { endpointId: "claude", off: true },
      { endpointId: "claude", presetId: "x" },
    ]) {
      const bad = fakeReqRes("/panel/api/prompts/override", "POST", body);
      await router.handle(bad.req, bad.res);
      assert.equal(bad.res.statusCode, 400, JSON.stringify(body));
    }
  });

  it("rejects prompts POSTs without the panel header as CSRF (service never called)", async () => {
    let called = false;
    const counting = new Proxy(mockService(), {
      get(target, prop) {
        const value = target[prop];
        return typeof value === "function"
          ? (...args) => { called = true; return value(...args); }
          : value;
      },
    });
    const router = promptsRouter(counting);
    for (const [path, body] of [
      ["/panel/api/prompts/master", { enabled: true }],
      ["/panel/api/prompts/preset/create", { title: "A", content: "x" }],
      ["/panel/api/prompts/preset/delete", { id: "x" }],
      ["/panel/api/prompts/preset/enable", { id: "x", enabled: true }],
      ["/panel/api/prompts/override", { endpointId: "claude", presetId: "x", off: true }],
    ]) {
      const { req, res, json } = fakeReqRes(path, "POST", body);
      delete req.headers["x-anyswitch-panel"];
      await router.handle(req, res);
      assert.equal(res.statusCode, 403, `${path} gated`);
      assert.equal(json().error, "csrf");
    }
    assert.equal(called, false);
  });
});

// Facade integration: real data plane + injector over temp dirs. Verifies
// the mutation → syncAll wiring and that sync failures never fail mutations.
describe("createPromptsPanelService facade", () => {
  const tempDirs = [];
  function makeFacade() {
    const root = mkdtempSync(join(tmpdir(), "anyswitch-prompts-facade-"));
    tempDirs.push(root);
    const homeDir = join(root, "home");
    const base = { LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "appdata") };
    return { facade: createPromptsPanelService({ base, homeDir }), base, homeDir };
  }
  afterEach(() => {
    while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
  });

  it("state exposes the eight endpoints and an initially empty sync snapshot", () => {
    const { facade } = makeFacade();
    const state = facade.getState();
    assert.equal(state.enabled, false);
    assert.deepEqual(state.presets, []);
    assert.deepEqual(state.sync, {});
    assert.equal(state.endpoints.length, 8);
    assert.equal(state.endpoints.some((e) => e.id === "qoder"), true, "qoder must reach the panel endpoint list");
    assert.deepEqual(Object.keys(state.endpoints[0]).sort(), ["hotReload", "id", "label", "targetRel"]);
  });

  it("mutations sync immediately; the sync snapshot is served by getState", () => {
    const { facade, homeDir } = makeFacade();
    const { preset } = facade.createPreset({ title: "规则A", content: "内容" });
    // Master is off: the sync removed blocks (none) but recorded results.
    let sync = facade.getState().sync;
    assert.equal(Object.keys(sync).length, 8);
    assert.equal(existsSync(join(homeDir, ".claude", "CLAUDE.md")), false);

    facade.setMaster(true);
    const text = readFileSync(join(homeDir, ".claude", "CLAUDE.md"), "utf8");
    assert.equal(text.startsWith(MANAGED_BEGIN), true);
    assert.match(text, /内容/);
    assert.doesNotMatch(text, /规则A/, "title must not be injected");
    // qoder reaches its user-level rules file through the same path.
    const qoderText = readFileSync(join(homeDir, ".qoder", "rules", "anyswitch-managed-prompts.md"), "utf8");
    assert.equal(qoderText.startsWith(MANAGED_BEGIN), true);
    assert.match(qoderText, /内容/);

    facade.setOverride({ endpointId: "claude", presetId: preset.id, off: true });
    assert.equal(existsSync(join(homeDir, ".claude", "CLAUDE.md")), false, "off override removes claude's block");
    assert.match(readFileSync(join(homeDir, ".kimi-code", "AGENTS.md"), "utf8"), /内容/);
    sync = facade.getState().sync;
    assert.deepEqual(sync.claude, { ok: true });
  });

  it("a failing endpoint lands in the sync snapshot without failing the mutation", () => {
    const { facade, homeDir } = makeFacade();
    // Break claude: a regular file where its target directory must be.
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(join(homeDir, ".claude"), "not a dir", "utf8");
    facade.createPreset({ title: "A", content: "x" });
    const result = facade.setMaster(true);
    assert.equal(result.enabled, true, "mutation succeeds despite the endpoint failure");
    const sync = facade.getState().sync;
    assert.equal(sync.claude.ok, false);
    assert.match(sync.claude.error, /.+/);
    assert.deepEqual(sync.kimi, { ok: true });
  });

  it("rejects overrides for unknown endpoints", () => {
    const { facade } = makeFacade();
    const { preset } = facade.createPreset({ title: "A", content: "x" });
    assert.throws(
      () => facade.setOverride({ endpointId: "ghost", presetId: preset.id, off: true }),
      (err) => err.statusCode === 400,
    );
  });
});
