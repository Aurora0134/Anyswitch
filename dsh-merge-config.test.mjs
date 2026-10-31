import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDshProviderEntry,
  extractManagedProviders,
  readSidecar,
  writeSidecar,
  writeDshProfilePatches,
  getYamlModule,
  dshYamlSchema,
} from "./dsh-merge-config.mjs";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { mkTestDir } from "./test-helpers/tmp.mjs";

// Every provider profile carries the relay token in its headers; the tests
// thread one fixed value through the builders and assert it lands verbatim.
const TOKEN = "test-relay-token";

// writeDshProfilePatches/getYamlModule parse and emit cordis.patch.yml through
// js-yaml, which this project does not declare: resolveYamlModule prefers the
// copy vendored inside a global @deepseek-ai/dsh install and only then falls
// back to a bare "js-yaml". On a machine with neither, the whole YAML surface
// cannot run — skip with that reason instead of failing with an unrelated
// MODULE_NOT_FOUND (same guard as dsh-launcher.test.mjs).
async function requireYamlModule(t) {
  try {
    return await getYamlModule();
  } catch (error) {
    t.skip(`js-yaml is unavailable (${error.message}); install @deepseek-ai/dsh globally to run this test`);
    return null;
  }
}

test("buildDshProviderEntry creates valid dsh profile", () => {
  const provider = {
    models: {
      "deepseek-chat": {
        displayName: "DeepSeek V3",
        contextWindow: 64000,
        maxOutputTokens: 8000,
      },
    },
  };
  const entry = buildDshProviderEntry("deepseek", provider, 47821, TOKEN);
  assert.ok(entry._deepseek);
  assert.equal(entry._deepseek.displayName, "deepseek");
  assert.equal(entry._deepseek.api, "openai-completions");
  assert.equal(entry._deepseek.baseURL, "http://127.0.0.1:47821/openai/deepseek/v1");
  // The credential rides the profile's headers: the schema has no literal
  // apiKey field, and an apiKeyEnv reference would be resolved (and fail)
  // before any header is read.
  assert.equal(entry._deepseek.apiKeyEnv, undefined);
  assert.deepEqual(entry._deepseek.headers, {
    "x-agent-id": "dsh",
    Authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(entry._deepseek.models.length, 1);
  assert.equal(entry._deepseek.models[0].id, "deepseek-chat");
  assert.equal(entry._deepseek.models[0].name, "DeepSeek V3");
  assert.equal(entry._deepseek.models[0].contextWindow, 64000);
  assert.equal(entry._deepseek.models[0].maxTokens, 8000);
});

test("buildDshProviderEntry omits the credential header when no token is available", () => {
  // Native fallback has no relay of its own, so the token read comes back null.
  // Writing an empty "Bearer " would only fail the request with a 401; a
  // keyless profile is the honest shape.
  const provider = { models: { m: { displayName: "M" } } };
  for (const token of [null, undefined, ""]) {
    const entry = buildDshProviderEntry("p", provider, 47821, token);
    assert.equal(entry._p.apiKeyEnv, undefined);
    assert.deepEqual(entry._p.headers, { "x-agent-id": "dsh" });
  }
});

test("buildDshProviderEntry attaches compat and reasoningEfforts when reasoning configured", () => {
  const provider = {
    reasoningVariants: ["low", "high"],
    models: {
      "r1": {
        displayName: "DeepSeek R1",
        contextWindow: 128000,
      },
    },
  };
  const entry = buildDshProviderEntry("deepseek-r1", provider, 47821, TOKEN);
  assert.ok(entry["_deepseek-r1"].compat);
  assert.equal(entry["_deepseek-r1"].compat.thinkingFormat, "deepseek");
  assert.equal(entry["_deepseek-r1"].compat.supportsReasoningEffort, true);
  assert.deepEqual(entry["_deepseek-r1"].models[0].reasoningEfforts, {
    off: null,
    low: "low",
    high: "high",
  });
});

test("buildDshProviderEntry falls back to the pi-ai knowledge base by model id", () => {
  // Store carries no reasoning metadata at all — today's production shape —
  // so the knowledge tier is the only thing that can produce efforts.
  const knowledge = new Map([
    ["glm-5.2", {
      hasMap: true,
      levels: ["low", "medium", "high", "max"],
      wireValues: { minimal: null, low: "high", medium: "high", high: "high", max: "max" },
      thinkingFormat: "zai",
    }],
    ["kimi-k3", {
      hasMap: true,
      levels: ["low", "high", "max"],
      wireValues: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
      thinkingFormat: "openai",
    }],
    ["embedding-bge-m3", {
      hasMap: true,
      levels: [],
      wireValues: { enabled: "auto", off: null },
      thinkingFormat: "deepseek",
    }],
  ]);
  const provider = {
    models: {
      "glm-5.2": { displayName: "GLM 5.2" },
      "kimi-k3": {},
      "embedding-bge-m3": {},
    },
  };
  const entry = buildDshProviderEntry("vendorb", provider, 47821, TOKEN, knowledge);
  const models = Object.fromEntries(entry._vendorb.models.map((m) => [m.id, m]));

  // glm-5.2: DSH "low" dispatches as zai wire "high"
  assert.deepEqual(models["glm-5.2"].reasoningEfforts, {
    off: null,
    low: "high",
    medium: "high",
    high: "high",
    max: "max",
  });
  assert.equal(models["glm-5.2"].compat.thinkingFormat, "zai");

  // kimi-k3: wire values match level names; per-model openai format
  assert.deepEqual(models["kimi-k3"].reasoningEfforts, {
    off: null,
    low: "low",
    high: "high",
    max: "max",
  });
  assert.equal(models["kimi-k3"].compat.thinkingFormat, "openai");

  // embedding-bge-m3: binary toggle collapses to off/low
  assert.deepEqual(models["embedding-bge-m3"].reasoningEfforts, {
    off: null,
    low: "auto",
  });

  // Mixed formats on the route: no single route-level winner, but compat
  // still present with supportsReasoningEffort for the plain-effort models.
  assert.ok(entry._vendorb.compat);
  assert.equal(entry._vendorb.compat.supportsReasoningEffort, true);
});

test("buildDshProviderEntry knowledge tier never overrides store-declared levels", () => {
  const knowledge = new Map([
    ["my-model", {
      hasMap: true,
      levels: ["low", "high"],
      wireValues: { low: "low", high: "high" },
      thinkingFormat: "deepseek",
    }],
  ]);
  const provider = {
    models: {
      "my-model": { reasoningEffortLevels: ["medium", "max"] },
    },
  };
  const entry = buildDshProviderEntry("p", provider, 47821, TOKEN, knowledge);
  assert.deepEqual(entry._p.models[0].reasoningEfforts, {
    off: null,
    medium: "medium",
    max: "max",
  });
  assert.ok(!entry._p.models[0].compat, "store-declared levels carry no per-model format");
});

test("writeDshProfilePatches manages the channel lifecycle and preserves user rows", async (t) => {
  const yaml = await requireYamlModule(t);
  if (yaml === null) return;
  const dir = mkTestDir("dsh-patch-lifecycle-");
  try {
    const profiles = join(dir, "profiles");
    mkdirSync(join(profiles, "dsh-tui"), { recursive: true });
    const patchPath = join(profiles, "dsh-tui", "cordis.patch.yml");
    writeFileSync(patchPath, yaml.dump([
      { id: "ui-theme", name: "@deepseek-ai/dsh-client-ui-theme", config: { preference: "dark" } },
      {
        id: "llm-pi-ai",
        name: "@deepseek-ai/dsh-llm-pi-ai",
        config: {
          providers: {
            custom_manual: {
              baseURL: "https://api.custom.com",
              api: "openai-completions",
              models: [{ id: "m1" }],
            },
            _old_provider: {
              baseURL: "http://127.0.0.1:47821/openai/old/v1",
              api: "openai-completions",
              models: [{ id: "old-m" }],
            },
          },
        },
      },
    ], { lineWidth: -1 }), "utf8");
    // The sidecar records what the previous sync managed: only those ids may
    // be removed from the profile — a user-added provider never is.
    writeSidecar(dir, ["old_provider"]);

    const store = {
      version: 2,
      providers: {
        new_provider: {
          models: { "m-new": { contextWindow: 32000 } },
        },
      },
    };
    const result = await writeDshProfilePatches(store, 47821, TOKEN, dir, dir);
    assert.equal(result.ok, true, result.reason);

    const entries = yaml.load(readFileSync(patchPath, "utf8"));
    assert.equal(entries.find((entry) => entry.id === "ui-theme").config.preference, "dark", "界面自己的行保持原样");
    const providers = entries.find((entry) => entry.id === "llm-pi-ai").config.providers;
    assert.ok(providers.custom_manual, "user custom provider preserved");
    assert.equal(providers._old_provider, undefined, "stale managed provider removed");
    assert.ok(providers._new_provider, "new managed provider injected");
    assert.deepEqual(readSidecar(dir), { providers: ["new_provider"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extractManagedProviders filters providers without models", () => {
  const store = {
    providers: {
      valid: { models: { m1: {} } },
      empty: { models: {} },
      none: {},
    },
  };
  const result = extractManagedProviders(store);
  assert.deepEqual(Object.keys(result), ["valid"]);
});

test("0.1.7 的每个已有界面都能读到托管渠道，界面自己的其它设置保持原样", async (t) => {
  const yaml = await requireYamlModule(t);
  if (yaml === null) return;
  const dir = mkTestDir("dsh-patch-test-");
  try {
    const profiles = join(dir, "profiles");
    const theme = {
      id: "ui-theme",
      name: "@deepseek-ai/dsh-client-ui-theme",
      config: { preference: "dark" },
    };
    const headlessOnly = {
      id: "permission",
      name: "@deepseek-ai/dsh-permission-presets",
      config: { defaultPreset: "danger-full-access" },
    };
    writeFileSync(join(dir, "cordis.patch.yml"), yaml.dump([theme]), "utf8");
    for (const name of ["dsh-tui", "web", "headless"]) {
      mkdirSync(join(profiles, name), { recursive: true });
    }
    writeFileSync(join(profiles, "web", "cordis.patch.yml"), yaml.dump([
      theme,
      {
        id: "llm-pi-ai",
        name: "@deepseek-ai/dsh-llm-pi-ai",
        config: { providers: { _mine: { displayName: "Mine", api: "openai-completions", baseURL: "https://mine.example/v1", models: [{ id: "m" }] } } },
      },
    ]), "utf8");
    writeFileSync(join(profiles, "headless", "cordis.patch.yml"), yaml.dump([headlessOnly]), "utf8");

    const store = {
      version: 2,
      providers: {
        poke: {
          displayName: "Poke",
          baseURL: "https://poke.example/v1",
          protocol: "openai-compatible",
          credentialFile: "poke.dpapi",
          models: { "claude-opus-5": { displayName: "Claude Opus 5", contextWindow: 200000 } },
        },
      },
    };
    const result = await writeDshProfilePatches(store, 47821, TOKEN, dir, dir);
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);
    assert.equal(existsSync(join(dir, "settings.yaml")), false, "已弃用的全局设置文件不再写出");

    for (const name of ["dsh-tui", "web", "headless"]) {
      const entries = yaml.load(readFileSync(join(profiles, name, "cordis.patch.yml"), "utf8"));
      const row = entries.find((entry) => entry.id === "llm-pi-ai");
      assert.ok(row, `${name} 必须有 llm-pi-ai 行`);
      assert.equal(row.name, "@deepseek-ai/dsh-llm-pi-ai");
      const channel = row.config.providers["_poke"];
      assert.equal(channel.baseURL, "http://127.0.0.1:47821/openai/poke/v1");
      assert.equal(channel.apiKeyEnv, undefined);
      assert.deepEqual(channel.headers, {
        "x-agent-id": "dsh",
        Authorization: `Bearer ${TOKEN}`,
      });
      assert.equal(channel.models[0].id, "claude-opus-5");
    }

    const web = yaml.load(readFileSync(join(profiles, "web", "cordis.patch.yml"), "utf8"));
    assert.equal(web.find((entry) => entry.id === "ui-theme").config.preference, "dark");
    assert.ok(web.find((entry) => entry.id === "llm-pi-ai").config.providers._mine, "界面里自己加的渠道必须留下");
    const headless = yaml.load(readFileSync(join(profiles, "headless", "cordis.patch.yml"), "utf8"));
    assert.equal(headless.find((entry) => entry.id === "permission").config.defaultPreset, "danger-full-access");
    const home = yaml.load(readFileSync(join(dir, "cordis.patch.yml"), "utf8"));
    assert.equal(home.find((entry) => entry.id === "llm-pi-ai"), undefined, "家目录那一层不是界面配置，不能写渠道");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// dsh 0.1.7 自带的 patch 用 cordis 的 !!js 标签按平台启停 bash/pwsh 插件；js-yaml 4
// 删掉了全部 js 类型，裸 load 直接抛 unknown tag，四个界面的同步曾因此整批跳过。
// 解析要把表达式收进包装、写回时原样带回标签——不许求值、不许丢标签。
test("带 !!js 平台表达式的官方 patch 照常同步，表达式逐字节留在原地", async (t) => {
  const yaml = await requireYamlModule(t);
  if (yaml === null) return;
  const dir = mkTestDir("dsh-patch-js-expr-");
  try {
    const profiles = join(dir, "profiles");
    mkdirSync(join(profiles, "dsh-tui"), { recursive: true });
    const patchPath = join(profiles, "dsh-tui", "cordis.patch.yml");
    const patch = [
      "- id: tool-bash",
      "  name: '@deepseek-ai/dsh-tool-bash'",
      "  disabled: !!js process.platform === 'win32'",
      "- id: tool-pwsh",
      "  name: '@deepseek-ai/dsh-tool-pwsh'",
      "  disabled: !!js process.platform !== 'win32'",
      "",
    ].join("\n");
    writeFileSync(patchPath, patch, "utf8");

    const store = {
      version: 2,
      providers: {
        poke: {
          displayName: "Poke",
          baseURL: "https://poke.example/v1",
          protocol: "openai-compatible",
          credentialFile: "poke.dpapi",
          models: { "claude-opus-5": { displayName: "Claude Opus 5", contextWindow: 200000 } },
        },
      },
    };
    const result = await writeDshProfilePatches(store, 47821, TOKEN, dir, dir);
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.skipped ?? [], []);

    const after = readFileSync(patchPath, "utf8");
    assert.ok(after.includes("disabled: !!js process.platform === 'win32'"), "!!js 表达式必须逐字节留下");
    assert.ok(after.includes("disabled: !!js process.platform !== 'win32'"), "!!js 表达式必须逐字节留下");
    const entries = yaml.load(after, { schema: dshYamlSchema(yaml) });
    const row = entries.find((entry) => entry.id === "llm-pi-ai");
    assert.equal(row.config.providers._poke.baseURL, "http://127.0.0.1:47821/openai/poke/v1");

    const second = await writeDshProfilePatches(store, 47821, TOKEN, dir, dir);
    assert.equal(second.unchanged, true, "同样的 store 再同步不得改动文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm-pi-ai 行自带的 !!js 值在重写该行后仍带标签", async (t) => {
  const yaml = await requireYamlModule(t);
  if (yaml === null) return;
  const dir = mkTestDir("dsh-patch-js-row-");
  try {
    const profiles = join(dir, "profiles");
    mkdirSync(join(profiles, "web"), { recursive: true });
    const patchPath = join(profiles, "web", "cordis.patch.yml");
    writeFileSync(patchPath, [
      "- id: llm-pi-ai",
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      "  disabled: !!js process.platform === 'linux'",
      "  config:",
      "    providers: {}",
      "",
    ].join("\n"), "utf8");

    const store = {
      version: 2,
      providers: {
        poke: {
          displayName: "Poke",
          baseURL: "https://poke.example/v1",
          protocol: "openai-compatible",
          credentialFile: "poke.dpapi",
          models: { "claude-opus-5": { contextWindow: 200000 } },
        },
      },
    };
    const result = await writeDshProfilePatches(store, 47821, TOKEN, dir, dir);
    assert.equal(result.ok, true, result.reason);
    const after = readFileSync(patchPath, "utf8");
    assert.ok(after.includes("disabled: !!js process.platform === 'linux'"), "重写 llm-pi-ai 行后表达式仍带 !!js 标签");
    assert.ok(after.includes("_poke:"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-09-29 事故边界里唯一能自动恢复的部分：patch 能被 js-yaml 解析、但不是条目
// 数组时，记入 skipped、逐字节不动，同期其它界面照常写好——免得以后有人把「跳过」
// 误读成「已修复」，再等一个不会来的自愈。语法错误（事故本身的形状）不走这条链路，
// 由下一个用例单独钉住。
test("patch 能解析但不是条目数组时只跳过这一个 profile，其它界面照常写好", async (t) => {
  const yaml = await requireYamlModule(t);
  if (yaml === null) return;
  const dir = mkTestDir("dsh-patch-skip-");
  try {
    const profiles = join(dir, "profiles");
    for (const name of ["dsh-tui", "web"]) mkdirSync(join(profiles, name), { recursive: true });
    const theme = { id: "ui-theme", name: "@deepseek-ai/dsh-client-ui-theme", config: { preference: "dark" } };
    const broken = "just a scalar, not a loader patch array\n";
    const brokenPath = join(profiles, "dsh-tui", "cordis.patch.yml");
    writeFileSync(brokenPath, broken, "utf8");
    writeFileSync(join(profiles, "web", "cordis.patch.yml"), yaml.dump([theme]), "utf8");

    const store = {
      version: 2,
      providers: {
        poke: {
          displayName: "Poke",
          baseURL: "https://poke.example/v1",
          protocol: "openai-compatible",
          credentialFile: "poke.dpapi",
          models: { "claude-opus-5": { displayName: "Claude Opus 5", contextWindow: 200000 } },
        },
      },
    };
    const result = await writeDshProfilePatches(store, 47821, TOKEN, dir, dir);
    assert.equal(result.ok, true, "一个界面坏掉不拖垮其它界面");
    assert.deepEqual(result.skipped.map((p) => p.replace(/\\/g, "/")), [brokenPath.replace(/\\/g, "/")]);
    assert.equal(readFileSync(brokenPath, "utf8"), broken, "被跳过的文件一个字节都不许动");
    const web = yaml.load(readFileSync(join(profiles, "web", "cordis.patch.yml"), "utf8"));
    assert.equal(web.find((entry) => entry.id === "llm-pi-ai").config.providers._poke.baseURL, "http://127.0.0.1:47821/openai/poke/v1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-09-29 事故的真实形状：dsh-tui 的 patch 被写坏（模板那行裸 `[]` 和真正的条目
// 行并存）之后，面板与 dsh 用的是同一份严格 js-yaml（dsh 自带那份），两边读它都直接
// 报「end of the stream or a document separator is expected」。这个语法异常不带
// UNPARSEABLE_DSH_SETTINGS 码，不在同步器的跳过名单里，所以现状是：
// writeDshProfilePatches 把异常整体抛出去——所有界面一个都不会写，dsh 一键启动同崩
// （agent-sync 调用链自己有 catch，会降级成 ok:false 警告；launcher 路径没有 catch）。
// **代码不会自己修好这种文件，也不会替你跳过它**：本次是靠人工按备份逐行修回
// （bridge/tmp/repair-dsh-cordis-patch.mjs）。本用例把现状钉住——将来若给语法错误补
// 上「跳过并报失败」，这里会红，逼着改动的人同步更新这条边界的说法。
test("2026-09-29 事故形状：patch 带 YAML 语法错误时同步整体抛错，其它界面一个都不写", async (t) => {
  const yaml = await requireYamlModule(t);
  if (yaml === null) return;
  const dir = mkTestDir("dsh-patch-syntax-broken-");
  try {
    const profiles = join(dir, "profiles");
    for (const name of ["dsh-tui", "web"]) mkdirSync(join(profiles, name), { recursive: true });
    const brokenPath = join(profiles, "dsh-tui", "cordis.patch.yml");
    const broken = [
      "- id: ui-theme",
      "  name: '@deepseek-ai/dsh-client-ui-theme'",
      "  config: {}",
      "[]",
      "- id: llm-pi-ai",
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      "  config:",
      "    providers: {}",
      "",
    ].join("\n");
    writeFileSync(brokenPath, broken, "utf8");
    const webPath = join(profiles, "web", "cordis.patch.yml");
    const webBefore = yaml.dump([
      { id: "ui-theme", name: "@deepseek-ai/dsh-client-ui-theme", config: { preference: "dark" } },
    ], { lineWidth: -1 });
    writeFileSync(webPath, webBefore, "utf8");

    await assert.rejects(
      () => writeDshProfilePatches(SYNC_PRESENCE_STORE, 47821, TOKEN, dir, dir),
      /end of the stream or a document separator/i,
      "语法错误不在跳过名单里：现状是整体抛错，不是记成 skipped 或 ok:false",
    );
    assert.equal(readFileSync(brokenPath, "utf8"), broken, "坏文件保持原样，等人工修");
    assert.equal(readFileSync(webPath, "utf8"), webBefore, "抛错路径一个界面都没写——正是注释里「一键启动同崩」的形状");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 失联不得伪装成功（2026-10-25 体检项）：dsh 在装而 profiles 目录失联（被移走、读不出）
// 时，同步必须报 ok:false，交给 agent-sync 既有的 warn 日志与 failed 名单接管，而不是顶
// 着「no dsh profiles」的 ok 计成同步成功；「dsh 未装/没有 profile」维持 ok+unchanged 正常
// 跳过。sidecar 里的托管记录（上次确实往 profiles 里写过渠道）是「曾经有 profile」的存在
// 性前提，家目录整个不在则视为未装，不得拿残留记录报假失败。
const SYNC_PRESENCE_STORE = {
  version: 2,
  providers: {
    poke: {
      displayName: "Poke",
      baseURL: "https://poke.example/v1",
      protocol: "openai-compatible",
      credentialFile: "poke.dpapi",
      models: { "claude-opus-5": { displayName: "Claude Opus 5", contextWindow: 200000 } },
    },
  },
};

test("dsh 在装而 profiles 目录失联时必须报失败，不得伪装成正常跳过", async (t) => {
  if ((await requireYamlModule(t)) === null) return;
  const dir = mkTestDir("dsh-patch-lost-");
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, "profiles", "dsh-tui"), { recursive: true });
    const first = await writeDshProfilePatches(SYNC_PRESENCE_STORE, 47821, TOKEN, dir, home);
    assert.equal(first.ok, true, first.reason);
    // profile 目录被整体移走：dsh 还在装，托管渠道却再也写不进去了。
    renameSync(join(home, "profiles"), join(home, "profiles.moved-away"));
    const second = await writeDshProfilePatches(SYNC_PRESENCE_STORE, 47821, TOKEN, dir, home);
    assert.equal(second.ok, false, "失联必须走可见失败，不能计成同步成功");
    assert.equal(second.unchanged, true);
    assert.match(second.reason, /dsh profiles directory/i, `原因要可读：${second.reason}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profiles 位置被普通文件顶替（patch 面读不出来）时必须报失败", async (t) => {
  if ((await requireYamlModule(t)) === null) return;
  const dir = mkTestDir("dsh-patch-notdir-");
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, "profiles", "dsh-tui"), { recursive: true });
    const first = await writeDshProfilePatches(SYNC_PRESENCE_STORE, 47821, TOKEN, dir, home);
    assert.equal(first.ok, true, first.reason);
    rmSync(join(home, "profiles"), { recursive: true, force: true });
    writeFileSync(join(home, "profiles"), "not a directory\n", "utf8");
    const second = await writeDshProfilePatches(SYNC_PRESENCE_STORE, 47821, TOKEN, dir, home);
    assert.equal(second.ok, false, "patch 面读不出来必须走可见失败");
    assert.match(second.reason, /dsh profiles directory/i, `原因要可读：${second.reason}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dsh 未装（家目录不存在）时维持 ok+unchanged 正常跳过", async (t) => {
  if ((await requireYamlModule(t)) === null) return;
  const dir = mkTestDir("dsh-patch-absent-");
  try {
    const result = await writeDshProfilePatches(SYNC_PRESENCE_STORE, 47821, TOKEN, dir, join(dir, "home"));
    assert.deepEqual(result, { ok: true, unchanged: true, reason: "no dsh profiles" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profiles 目录在而是空的时候维持 ok+unchanged 正常跳过", async (t) => {
  if ((await requireYamlModule(t)) === null) return;
  const dir = mkTestDir("dsh-patch-empty-");
  try {
    mkdirSync(join(dir, "home", "profiles"), { recursive: true });
    const result = await writeDshProfilePatches(SYNC_PRESENCE_STORE, 47821, TOKEN, dir, join(dir, "home"));
    assert.deepEqual(result, { ok: true, unchanged: true, reason: "no dsh profiles" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dsh 卸载后（家目录整个没了）不因 sidecar 残留记录报假失败", async (t) => {
  if ((await requireYamlModule(t)) === null) return;
  const dir = mkTestDir("dsh-patch-gone-");
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, "profiles", "dsh-tui"), { recursive: true });
    const first = await writeDshProfilePatches(SYNC_PRESENCE_STORE, 47821, TOKEN, dir, home);
    assert.equal(first.ok, true, first.reason);
    rmSync(home, { recursive: true, force: true });
    const second = await writeDshProfilePatches(SYNC_PRESENCE_STORE, 47821, TOKEN, dir, home);
    assert.deepEqual(second, { ok: true, unchanged: true, reason: "no dsh profiles" }, "未装就是未装，不得拿 sidecar 残留当失联证据");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sidecar 落盘为 dsh 专属文件名，内容按共享实现的排序往返", () => {
  const dir = mkTestDir("dsh-sidecar-test-");
  try {
    assert.equal(existsSync(join(dir, "dsh-sidecar.json")), false, "没写过就不该有文件");
    writeSidecar(dir, ["p2", "p1"]);
    // dsh 包装层唯一自己的东西就是文件名：排序与字节格式都是 merge-common 的共享
    // 实现（那边已逐字节断言）。这里钉住包装没有把文件名写错。
    assert.equal(
      readFileSync(join(dir, "dsh-sidecar.json"), "utf8"),
      '{\n  "providers": [\n    "p1",\n    "p2"\n  ]\n}\n',
    );
    assert.deepEqual(readSidecar(dir), { providers: ["p1", "p2"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pool 以一条 dsh 渠道浮出（模型取并集），解散后残留条目被清掉", async (t) => {
  const yaml = await requireYamlModule(t);
  if (yaml === null) return;
  const dir = mkTestDir("dsh-patch-pool-");
  try {
    const profiles = join(dir, "profiles");
    mkdirSync(join(profiles, "dsh-tui"), { recursive: true });
    const patchPath = join(profiles, "dsh-tui", "cordis.patch.yml");
    const store = {
      version: 2,
      providers: {
        alpha: {
          displayName: "Alpha",
          baseURL: "https://alpha.invalid/v1",
          protocol: "openai-compatible",
          credentialFile: "alpha.dpapi",
          models: {
            "model-a": { displayName: "Model A", contextWindow: 100000 },
            "model-shared": { displayName: "Shared (alpha)" },
          },
        },
        beta: {
          displayName: "Beta",
          baseURL: "https://beta.invalid/v1",
          protocol: "openai-compatible",
          credentialFile: "beta.dpapi",
          models: {
            "model-shared": { displayName: "Shared (beta)" },
            "model-b": { displayName: "Model B" },
          },
        },
      },
      pools: {
        "pool-ab": { displayName: "Pool AB", members: ["alpha", "beta"] },
      },
    };

    const first = await writeDshProfilePatches(store, 47821, TOKEN, dir, dir);
    assert.equal(first.ok, true, first.reason);
    const providers = yaml.load(readFileSync(patchPath, "utf8")).find((entry) => entry.id === "llm-pi-ai").config.providers;
    const pool = providers["_pool-ab"];
    assert.ok(pool);
    assert.equal(pool.displayName, "Pool AB");
    assert.equal(pool.baseURL, "http://127.0.0.1:47821/openai/pool-ab/v1");
    assert.equal(pool.apiKeyEnv, undefined);
    assert.deepEqual(pool.headers, {
      "x-agent-id": "dsh",
      Authorization: `Bearer ${TOKEN}`,
    });
    assert.deepEqual(pool.models.map((m) => m.id), ["model-a", "model-shared", "model-b"]);
    // First member in pool order wins the shared model's metadata.
    assert.equal(pool.models[1].name, "Shared (alpha)");
    // Member channels are absorbed into the pool channel — every endpoint sees
    // one provider per pool, exactly like the wire catalog.
    assert.equal(providers._alpha, undefined);
    assert.equal(providers._beta, undefined);
    assert.deepEqual(readSidecar(dir), { providers: ["pool-ab"] });

    // Dissolve the pool: the same store without it. The stale managed entry is
    // removed via the sidecar list, and the members resurface as standalone
    // channels.
    const withoutPool = await writeDshProfilePatches({ version: 2, providers: store.providers }, 47821, TOKEN, dir, dir);
    assert.equal(withoutPool.ok, true, withoutPool.reason);
    const after = yaml.load(readFileSync(patchPath, "utf8")).find((entry) => entry.id === "llm-pi-ai").config.providers;
    assert.equal(after["_pool-ab"], undefined, "dissolved pool channel removed");
    assert.equal(after._alpha.baseURL, "http://127.0.0.1:47821/openai/alpha/v1");
    assert.ok(after._beta, "members resurface as standalone channels");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pool id 与成员 id 相同时，成员仍被并进同一条渠道", async (t) => {
  const yaml = await requireYamlModule(t);
  if (yaml === null) return;
  const dir = mkTestDir("dsh-patch-pool-twin-");
  try {
    const profiles = join(dir, "profiles");
    mkdirSync(join(profiles, "dsh-tui"), { recursive: true });
    const patchPath = join(profiles, "dsh-tui", "cordis.patch.yml");
    const store = {
      version: 2,
      providers: {
        alpha: { models: { "model-a": { displayName: "Model A" } } },
        beta: { models: { "model-b": { displayName: "Model B" } } },
      },
      pools: {
        alpha: { displayName: "Alpha Pool", members: ["alpha", "beta"] },
      },
    };
    const result = await writeDshProfilePatches(store, 47821, TOKEN, dir, dir);
    assert.equal(result.ok, true, result.reason);
    const providers = yaml.load(readFileSync(patchPath, "utf8")).find((entry) => entry.id === "llm-pi-ai").config.providers;
    assert.equal(providers._alpha.displayName, "Alpha Pool");
    assert.equal(providers._alpha.baseURL, "http://127.0.0.1:47821/openai/alpha/v1");
    assert.deepEqual(providers._alpha.models.map((m) => m.id), ["model-a", "model-b"]);
    // beta is absorbed even though its id differs from the pool id.
    assert.equal(providers._beta, undefined);
    assert.deepEqual(readSidecar(dir), { providers: ["alpha"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Virtual "auto" routing channel: injected when the
// dsh endpoint has a route chain, cleaned up when the chain is deleted.
const DSH_CHAIN_STORE = {
  version: 2,
  providers: {
    "poke-api": {
      baseURL: "https://poke.example/v1",
      models: { "claude-opus-5": { displayName: "Claude Opus 5" } },
    },
  },
  routingChains: {
    dsh: { chain: [{ node: "poke-api", model: "claude-opus-5" }] },
  },
};

test("有路由链时伪渠道以 Anyswitch 键写进 profile，URL 段指向链头节点", async (t) => {
  const yaml = await requireYamlModule(t);
  if (yaml === null) return;
  const dir = mkTestDir("dsh-patch-auto-inject-");
  try {
    const profiles = join(dir, "profiles");
    mkdirSync(join(profiles, "dsh-tui"), { recursive: true });
    const result = await writeDshProfilePatches(DSH_CHAIN_STORE, 47821, TOKEN, dir, dir);
    assert.equal(result.ok, true, result.reason);
    const providers = yaml.load(readFileSync(join(profiles, "dsh-tui", "cordis.patch.yml"), "utf8"))
      .find((entry) => entry.id === "llm-pi-ai").config.providers;
    const entry = providers.Anyswitch;
    assert.ok(entry, "the pseudo channel must be written under its display-name key");
    assert.equal(providers._auto, undefined, "the pre-rename key is not written");
    assert.equal(entry.displayName, "Anyswitch");
    assert.equal(entry.api, "openai-completions");
    // The base URL points at the chain HEAD node, not at a literal "auto" segment.
    assert.equal(entry.baseURL, "http://127.0.0.1:47821/openai/poke-api/v1");
    assert.equal(entry.apiKeyEnv, undefined);
    assert.deepEqual(entry.headers, {
      "x-agent-id": "dsh",
      Authorization: `Bearer ${TOKEN}`,
    });
    assert.deepEqual(entry.models.map((m) => m.id), ["auto"]);
    assert.ok(!entry.models[0].reasoningEfforts, "the virtual model carries no reasoning levels");
    assert.ok(providers["_poke-api"], "real channels are written alongside");
    // sidecar records the logical id, not the display-name key.
    assert.deepEqual(readSidecar(dir), { providers: ["auto", "poke-api"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("没有路由链就不写伪渠道", async (t) => {
  const yaml = await requireYamlModule(t);
  if (yaml === null) return;
  const dir = mkTestDir("dsh-patch-auto-absent-");
  try {
    const profiles = join(dir, "profiles");
    mkdirSync(join(profiles, "dsh-tui"), { recursive: true });
    const result = await writeDshProfilePatches(
      { version: 2, providers: DSH_CHAIN_STORE.providers },
      47821,
      TOKEN,
      dir,
      dir,
    );
    assert.equal(result.ok, true, result.reason);
    const providers = yaml.load(readFileSync(join(profiles, "dsh-tui", "cordis.patch.yml"), "utf8"))
      .find((entry) => entry.id === "llm-pi-ai").config.providers;
    assert.equal(providers.Anyswitch, undefined);
    assert.equal(providers._auto, undefined);
    assert.ok(providers["_poke-api"]);
    assert.deepEqual(readSidecar(dir), { providers: ["poke-api"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("链删掉后，下一次同步把伪渠道清掉", async (t) => {
  const yaml = await requireYamlModule(t);
  if (yaml === null) return;
  const dir = mkTestDir("dsh-patch-auto-cleanup-");
  try {
    const profiles = join(dir, "profiles");
    mkdirSync(join(profiles, "dsh-tui"), { recursive: true });
    const patchPath = join(profiles, "dsh-tui", "cordis.patch.yml");
    const first = await writeDshProfilePatches(DSH_CHAIN_STORE, 47821, TOKEN, dir, dir);
    assert.equal(first.ok, true, first.reason);
    assert.ok(
      yaml.load(readFileSync(patchPath, "utf8")).find((entry) => entry.id === "llm-pi-ai").config.providers.Anyswitch,
    );

    const second = await writeDshProfilePatches(
      { version: 2, providers: DSH_CHAIN_STORE.providers },
      47821,
      TOKEN,
      dir,
      dir,
    );
    assert.equal(second.ok, true, second.reason);
    const providers = yaml.load(readFileSync(patchPath, "utf8")).find((entry) => entry.id === "llm-pi-ai").config.providers;
    assert.equal(
      providers.Anyswitch,
      undefined,
      "stale pseudo channel removed once the chain is gone",
    );
    assert.ok(providers["_poke-api"], "real channels survive the cleanup");
    assert.deepEqual(readSidecar(dir), { providers: ["poke-api"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("用户自己写的 _auto 渠道（没有 dsh 头）原样保留，伪渠道照常注入", async (t) => {
  const yaml = await requireYamlModule(t);
  if (yaml === null) return;
  const dir = mkTestDir("dsh-patch-user-auto-");
  try {
    const profiles = join(dir, "profiles");
    mkdirSync(join(profiles, "dsh-tui"), { recursive: true });
    const patchPath = join(profiles, "dsh-tui", "cordis.patch.yml");
    writeFileSync(patchPath, [
      "- id: llm-pi-ai",
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      "  config:",
      "    providers:",
      "      _auto:",
      "        displayName: my own",
      "        api: openai-completions",
      "        baseURL: https://mine.example/v1",
      "",
    ].join("\n"), "utf8");

    const result = await writeDshProfilePatches(DSH_CHAIN_STORE, 47821, TOKEN, dir, dir);
    assert.equal(result.ok, true, result.reason);
    const providers = yaml.load(readFileSync(patchPath, "utf8")).find((entry) => entry.id === "llm-pi-ai").config.providers;
    assert.equal(providers._auto.displayName, "my own", "a user provider is never excised");
    assert.ok(providers.Anyswitch, "the managed pseudo channel is injected beside it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDshProfilePatches retires the legacy _auto key on the write path", async (t) => {
  const yaml = await requireYamlModule(t);
  if (yaml === null) return;
  const dir = mkTestDir("dsh-patch-auto-rename-");
  try {
    const profiles = join(dir, "profiles");
    mkdirSync(join(profiles, "dsh-tui"), { recursive: true });
    const patchPath = join(profiles, "dsh-tui", "cordis.patch.yml");
    writeFileSync(patchPath, [
      "- id: llm-pi-ai",
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      "  config:",
      "    providers:",
      "      _auto:",
      "        displayName: Anyswitch",
      "        api: openai-completions",
      "        baseURL: 'http://127.0.0.1:47821/openai/poke-api/v1'",
      "        headers:",
      "          x-agent-id: dsh",
      "          Authorization: 'Bearer stale-token'",
      "        models:",
      "          - id: auto",
      "            name: auto",
      "      _poke-api:",
      "        displayName: poke-api",
      "        api: openai-completions",
      "        baseURL: 'http://127.0.0.1:47821/openai/poke-api/v1'",
      "        models:",
      "          - id: old-model",
      "            name: old-model",
      "",
    ].join("\n"), "utf8");

    const result = await writeDshProfilePatches(DSH_CHAIN_STORE, 47821, TOKEN, dir, dir);
    assert.equal(result.ok, true, result.reason);
    const entries = yaml.load(readFileSync(patchPath, "utf8"), { schema: dshYamlSchema(yaml) });
    const providers = entries.find((entry) => entry.id === "llm-pi-ai").config.providers;
    assert.equal(providers._auto, undefined, "the legacy managed key is retired");
    assert.ok(providers.Anyswitch, "the pseudo channel lives under its new key");
    assert.deepEqual(providers.Anyswitch.models.map((m) => m.id), ["auto"]);
    assert.ok(providers["_poke-api"], "real channels survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("library tier: no catalog keeps today's shape for an unknown model", () => {
  const provider = { models: { "mimo-v2.5-pro": { displayName: "Mimo" } } };
  const entry = buildDshProviderEntry("poke", provider, 47821, TOKEN, null);
  const model = entry._poke.models[0];
  assert.equal(model.reasoningEfforts, undefined);
  assert.equal(entry._poke.compat, undefined);
});

test("library tier: an unknown text model gets levels, not a route dialect", () => {
  const provider = { models: { "mimo-v2.5-pro": { displayName: "Mimo" } } };
  const catalog = {
    models: new Map([
      ["mimo-v2.5-pro", { kind: "reasoning", levels: ["high", "xhigh", "max"], default: "high", wire: {}, thinkingFormat: null }],
    ]),
  };
  const entry = buildDshProviderEntry("poke", provider, 47821, TOKEN, null, catalog);
  const model = entry._poke.models[0];
  // DSH rejects a non-off level whose wire value is empty, so every level lands
  // with the level name itself.
  assert.deepEqual(model.reasoningEfforts, { off: null, high: "high", xhigh: "xhigh", max: "max" });
  assert.equal(entry._poke.compat, undefined, "the library alone must not pick the route's thinking dialect");
});

test("library tier: a level outside DSH's fixed set is clipped, not written", () => {
  // dsh-llm-pi-ai validates reasoningEfforts keys against its THINKING_LEVELS
  // union and rejects the whole settings.yaml otherwise, so the gpt-5.6+
  // "light" level must never reach the file.
  const provider = { models: { "gpt-5.6-sol": { displayName: "Sol" } } };
  const catalog = {
    models: new Map([
      ["gpt-5.6-sol", { kind: "reasoning", levels: ["light", "medium", "high", "xhigh", "max"], default: "high", wire: { light: "light" }, thinkingFormat: null }],
    ]),
  };
  const entry = buildDshProviderEntry("poke", provider, 47821, TOKEN, null, catalog);
  assert.deepEqual(entry._poke.models[0].reasoningEfforts, { off: null, medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
});

test("library tier: a model the library calls non-text stays exempt", () => {
  const provider = { models: { "agnes-image-2.0-flash": { displayName: "Agnes" } } };
  const catalog = {
    models: new Map([
      ["agnes-image-2.0-flash", { kind: "non-text", levels: [], default: null, wire: {}, thinkingFormat: null }],
    ]),
  };
  const entry = buildDshProviderEntry("poke", provider, 47821, TOKEN, null, catalog);
  assert.equal(entry._poke.models[0].reasoningEfforts, undefined);
});

test("library tier sits behind the store and provider declarations", () => {
  const provider = {
    models: { "glm-5.3": { displayName: "GLM", reasoningEffortLevels: ["low", "high"] } },
  };
  const catalog = {
    models: new Map([
      ["glm-5.3", { kind: "reasoning", levels: ["medium", "high", "xhigh", "max"], default: "high", wire: {}, thinkingFormat: null }],
    ]),
  };
  const entry = buildDshProviderEntry("poke", provider, 47821, TOKEN, null, catalog);
  assert.deepEqual(Object.keys(entry._poke.models[0].reasoningEfforts), ["off", "low", "high"]);
});

test("a library dialect is written per model, not as a route default", () => {
  const provider = { models: { "deepseek-v4-flash": { displayName: "DS" } } };
  const catalog = {
    models: new Map([
      ["deepseek-v4-flash", { kind: "reasoning", levels: ["high", "max"], default: "high", wire: {}, thinkingFormat: "deepseek" }],
    ]),
  };
  const entry = buildDshProviderEntry("poke", provider, 47821, TOKEN, null, catalog);
  assert.deepEqual(entry._poke.models[0].compat, { thinkingFormat: "deepseek" });
  assert.equal(entry._poke.compat, undefined);
});
