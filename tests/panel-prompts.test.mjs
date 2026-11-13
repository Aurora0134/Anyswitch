import test, { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPanelRouter, createPromptsPanelService } from "../src/panel/panel.mjs";
import { MANAGED_BEGIN } from "../src/agents/agent-prompts-inject.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

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

function promptsRouter(promptsService, environmentService) {
  return createPanelRouter({
    storePaths: { root: "C:/fake/anyswitch" },
    logger: null,
    metricsCollector: null,
    fetchRelayAgents: async () => null,
    promptsService,
    ...(environmentService ? { environmentService } : {}),
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
    reorderPresets: (order) => ({ presetOrder: order }),
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

  it("POST /panel/api/prompts/preset/reorder forwards the order array and validates it", async () => {
    let got = null;
    const router = promptsRouter(mockService({
      reorderPresets: (order) => {
        got = order;
        if (order.includes("ghost")) {
          const error = new Error("预设不存在: ghost");
          error.statusCode = 400;
          throw error;
        }
        return { presetOrder: order };
      },
    }));
    const { req, res, json } = fakeReqRes("/panel/api/prompts/preset/reorder", "POST", {
      order: ["bbbbbbbbbbbb", "aaaaaaaaaaaa"],
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(got, ["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
    assert.equal(json().ok, true);
    assert.deepEqual(json().presetOrder, ["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);

    // 非数组直接 400，业务校验（排列完整性）由数据层抛 400 冒泡上来
    for (const body of [{}, { order: "aaaaaaaaaaaa" }, { order: 42 }]) {
      const bad = fakeReqRes("/panel/api/prompts/preset/reorder", "POST", body);
      await router.handle(bad.req, bad.res);
      assert.equal(bad.res.statusCode, 400, JSON.stringify(body));
      assert.equal(bad.json().ok, false);
    }
    const partial = fakeReqRes("/panel/api/prompts/preset/reorder", "POST", { order: ["ghost"] });
    await router.handle(partial.req, partial.res);
    assert.equal(partial.res.statusCode, 400);
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
      ["/panel/api/prompts/preset/reorder", { order: ["x"] }],
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

// 启动回填与可见集变更钩子（prewarmPromptsBackfill / refreshEndpointVisibility
// 的注入面触发口径）：注入文件唯一的写入触发面原本是面板预设变更，这里钉住
// 两个非用户主动触发面各自的 fire 条件——首算不 fire、null 首算跳过落盘、
// null→Set 恢复补填、同集不 fire、Set→null 运行中翻转零写盘。
describe("panel router prompts injection backfill", () => {
  const clients = (...ids) => ids.map((id) => ({ id, installations: [{ status: "found" }] }));

  it("检测正常：首调恰一次显式回填（首算不触发钩子），注入的 mock 服务原样保留", async () => {
    const env = { getState: async () => ({ clients: clients("claude") }) };
    let resyncs = 0;
    const svc = mockService({ resync: () => { resyncs += 1; } });
    const router = promptsRouter(svc, env);
    await router.prewarmPromptsBackfill();
    assert.equal(resyncs, 1, "首调显式回填恰一次（只有 prewarm 自己的 resync）");
    const { req, res, json } = fakeReqRes("/panel/api/prompts/state", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      json().endpoints,
      [{ id: "claude", label: "Claude Code", hotReload: false, targetRel: "~/.claude/CLAUDE.md" }],
      "GET state 仍由注入 mock 服务应答（未被懒建真服务顶掉）",
    );
  });

  it("检测失败首算跳过落盘；恢复后经 null→Set 变更钩子自补（spy 0→1）", async () => {
    const env = { getState: async () => { throw new Error("detection broken"); } };
    let resyncs = 0;
    const svc = mockService({ resync: () => { resyncs += 1; } });
    const router = promptsRouter(svc, env);
    await router.prewarmPromptsBackfill();
    assert.equal(resyncs, 0, "null 首算：跳过落盘（不给未装端点造文件）");
    env.getState = async () => ({ clients: clients("claude") });
    await router.prewarmPromptsBackfill();
    assert.equal(resyncs, 1, "恢复后的下一轮经变更钩子补恰一次（显式名额已在首调消费）");
  });

  it("可见集变化再触发、同集不触发、运行中检测失败翻转零写盘", async () => {
    const env = { getState: async () => ({ clients: clients("claude") }) };
    let resyncs = 0;
    const svc = mockService({ resync: () => { resyncs += 1; } });
    const router = promptsRouter(svc, env);
    await router.prewarmPromptsBackfill();
    assert.equal(resyncs, 1, "首调显式回填");
    env.getState = async () => ({ clients: clients("claude", "kimi") });
    await router.prewarmPromptsBackfill();
    assert.equal(resyncs, 2, "可见集变化经钩子再触发恰一次");
    await router.prewarmPromptsBackfill();
    assert.equal(resyncs, 2, "同集不触发");
    env.getState = async () => { throw new Error("detection broken again"); };
    await router.prewarmPromptsBackfill();
    assert.equal(resyncs, 2, "运行中 Set→null 翻转不触发（非用户主动路径零写盘）");
  });
});

// Facade integration: real data plane + injector over temp dirs. Verifies
// the mutation → syncAll wiring and that sync failures never fail mutations.
describe("createPromptsPanelService facade", () => {
  const tempDirs = [];
  function makeFacade() {
    const root = mkTestDir("anyswitch-prompts-facade-");
    tempDirs.push(root);
    const homeDir = join(root, "home");
    const base = { LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "appdata") };
    return { facade: createPromptsPanelService({ base, homeDir }), base, homeDir };
  }
  afterEach(() => {
    while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
  });

  it("state exposes the ten endpoints and an initially empty sync snapshot", () => {
    const { facade } = makeFacade();
    const state = facade.getState();
    assert.equal(state.enabled, false);
    assert.deepEqual(state.presets, []);
    assert.deepEqual(state.sync, {});
    assert.equal(state.endpoints.length, 10);
    assert.equal(state.endpoints.some((e) => e.id === "qoder"), true, "qoder must reach the panel endpoint list");
    // API 级互钉：qoder 行 hotReload 与注入表口径一致（CN 实证＝会话启动
    // 一次性读取、无热加载），面板提示分支据此渲染「运行中会话需重开生效」。
    assert.equal(state.endpoints.find((e) => e.id === "qoder").hotReload, false, "qoder hotReload must be false in the served state");
    assert.equal(state.endpoints.some((e) => e.id === "codex"), true, "codex must reach the panel endpoint list");
    assert.equal(state.endpoints.some((e) => e.id === "grok"), true, "grok must reach the panel endpoint list");
    assert.deepEqual(Object.keys(state.endpoints[0]).sort(), ["hotReload", "id", "label", "targetRel"]);
  });

  it("mutations sync immediately; the sync snapshot is served by getState", () => {
    const { facade, homeDir } = makeFacade();
    const { preset } = facade.createPreset({ title: "规则A", content: "内容" });
    // Master is off: the sync removed blocks (none) but recorded results.
    let sync = facade.getState().sync;
    assert.equal(Object.keys(sync).length, 10);
    assert.equal(existsSync(join(homeDir, ".claude", "CLAUDE.md")), false);

    facade.setMaster(true);
    const text = readFileSync(join(homeDir, ".claude", "CLAUDE.md"), "utf8");
    assert.equal(text.startsWith(MANAGED_BEGIN), true);
    assert.match(text, /内容/);
    assert.match(text, /^## 规则A$/m, "the preset title reaches the endpoint file as a heading");
    assert.equal((text.match(/规则A/g) || []).length, 1, "the title appears only as that heading");
    // qoder reaches its user-level rules file through the same path.
    const qoderText = readFileSync(join(homeDir, ".qoder", "rules", "anyswitch-managed-prompts.md"), "utf8");
    assert.equal(qoderText.startsWith(MANAGED_BEGIN), true);
    assert.match(qoderText, /内容/);
    assert.match(qoderText, /^## 规则A$/m, "qoder gets the same titled section");

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

  it("reordering presets changes the injected block order on every endpoint", () => {
    const { facade, homeDir } = makeFacade();
    const a = facade.createPreset({ title: "A", content: "正文A" }).preset;
    const b = facade.createPreset({ title: "B", content: "正文B" }).preset;
    facade.setMaster(true);
    const claude = () => readFileSync(join(homeDir, ".claude", "CLAUDE.md"), "utf8");
    assert.ok(claude().indexOf("正文A") < claude().indexOf("正文B"), "creation order first");

    facade.reorderPresets([b.id, a.id]);
    assert.deepEqual(facade.getState().presetOrder, [b.id, a.id]);
    assert.deepEqual(facade.getState().presets.map((p) => p.id), [b.id, a.id]);
    // The reorder is a real mutation: it re-syncs, so the managed block follows.
    assert.ok(claude().indexOf("正文B") < claude().indexOf("正文A"), "block order follows presetOrder");
    assert.deepEqual(facade.getState().sync.claude, { ok: true });
  });

  it("rejects overrides for unknown endpoints", () => {
    const { facade } = makeFacade();
    const { preset } = facade.createPreset({ title: "A", content: "x" });
    assert.throws(
      () => facade.setOverride({ endpointId: "ghost", presetId: preset.id, off: true }),
      (err) => err.statusCode === 400,
    );
  });

  it("resync()：注入文件缺失时无变更回填（数据面零写入）", () => {
    const { facade, homeDir, base } = makeFacade();
    // 预置双根（双装形态）后注入一轮并落盘
    mkdirSync(join(homeDir, ".qoder"), { recursive: true });
    mkdirSync(join(homeDir, ".qoder-cn"), { recursive: true });
    facade.createPreset({ title: "规则A", content: "内容" });
    facade.setMaster(true);
    const claudeTarget = join(homeDir, ".claude", "CLAUDE.md");
    const intlTarget = join(homeDir, ".qoder", "rules", "anyswitch-managed-prompts.md");
    const cnTarget = join(homeDir, ".qoder-cn", "rules", "anyswitch-managed-prompts.md");
    const expected = {
      claude: readFileSync(claudeTarget, "utf8"),
      intl: readFileSync(intlTarget, "utf8"),
      cn: readFileSync(cnTarget, "utf8"),
    };
    const presetsBefore = facade.getState().presets;

    // 删文件（模拟注入文件晚于写入面出生/被外部删掉），同 base 新建 facade
    // （模拟新进程：数据面每次落盘重读，同 base 即同预设集）
    rmSync(claudeTarget);
    rmSync(intlTarget);
    rmSync(cnTarget);
    const fresh = createPromptsPanelService({ base, homeDir });
    fresh.resync();
    assert.equal(readFileSync(claudeTarget, "utf8"), expected.claude, "claude 逐字节复原");
    assert.equal(readFileSync(intlTarget, "utf8"), expected.intl, "qoder intl 根逐字节复原");
    assert.equal(readFileSync(cnTarget, "utf8"), expected.cn, "qoder CN 根逐字节复原");
    assert.deepEqual(fresh.getState().presets, presetsBefore, "数据面零写入");
  });

  it("resync()：无可注入内容时不新建任何文件", () => {
    const { facade, homeDir } = makeFacade();
    facade.resync();
    assert.equal(existsSync(join(homeDir, ".claude")), false);
    assert.equal(existsSync(join(homeDir, ".qoder")), false);
  });

  it("resync()：对不可见端点按空集清理（隐藏端点的残留托管块被摘除）", () => {
    const { facade, homeDir, base } = makeFacade();
    facade.createPreset({ title: "A", content: "正文" });
    facade.setMaster(true);
    const grokTarget = join(homeDir, ".grok", "rules", "anyswitch-managed-prompts.md");
    assert.equal(existsSync(grokTarget), true, "先注入出残留");
    const hidden = createPromptsPanelService({ base, homeDir, isEndpointVisible: (id) => id !== "grok" });
    hidden.resync();
    assert.equal(existsSync(grokTarget), false, "不可见端点的托管块被清（文件只剩块时连文件删）");
  });

  it("隐藏端点：清单不出、不再写入、残留托管块被摘除（卸载清理语义）", () => {
    const { facade, homeDir, base } = makeFacade();
    // 先用全可见门面注入一轮，模拟「装过又卸载」留下的残留
    facade.createPreset({ title: "A", content: "正文" });
    facade.setMaster(true);
    assert.match(
      readFileSync(join(homeDir, ".grok", "rules", "anyswitch-managed-prompts.md"), "utf8"),
      /正文/,
      "grok block injected while visible",
    );

    const hidden = createPromptsPanelService({ base, homeDir, isEndpointVisible: (id) => id !== "grok" });
    // 状态清单不含被隐藏端点
    const state = hidden.getState();
    assert.equal(state.endpoints.some((e) => e.id === "grok"), false);
    assert.equal(state.endpoints.length, 9);
    // 任意 mutation 触发的 syncAll 对隐藏端点按空预设集处理：托管块被移除，
    // 文件只剩块时连文件一起删——不给未安装的 Agent 留注入内容
    hidden.createPreset({ title: "B", content: "加一条" });
    assert.equal(
      existsSync(join(homeDir, ".grok", "rules", "anyswitch-managed-prompts.md")),
      false,
      "hidden endpoint's leftover block is removed",
    );
    // 可见端点照常注入（两条预设都在）
    const claudeText = readFileSync(join(homeDir, ".claude", "CLAUDE.md"), "utf8");
    assert.match(claudeText, /正文/);
    assert.match(claudeText, /加一条/);

    // 对隐藏端点配置注入被拒（400 + 产品语义文案）
    const presetId = hidden.getState().presets[0].id;
    assert.throws(
      () => hidden.setOverride({ endpointId: "grok", presetId, off: true }),
      (err) => err.statusCode === 400 && /未安装/.test(err.message),
    );
  });
});
