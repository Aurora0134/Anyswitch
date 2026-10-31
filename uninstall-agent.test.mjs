// Restore-native driver tests. Everything runs against temp directories with
// an in-memory PATH store and a fake broadcast: ZERO real user config, ZERO
// real registry, ZERO real PowerShell. The only real-machine touch is the
// dsh endpoint's YAML module, resolved from the installed dsh package exactly
// as dsh-merge-config.test.mjs already does (read-only); cases that need it
// skip when the package is absent — same guard as dsh-merge-config.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createUninstallDriver, UNINSTALL_ENDPOINT_IDS } from "./uninstall-agent.mjs";
import { createShimManager, shimRoot } from "./shim-manager.mjs";
import { createPromptsInjector, buildManagedBlock, MANAGED_BEGIN, MANAGED_END } from "./agent-prompts-inject.mjs";
import { createJunction } from "./agent-skills.mjs";
import * as kimiMerge from "./kimi-merge-config.mjs";
import * as grokMerge from "./grok-merge-config.mjs";
import * as codexMerge from "./codex-merge-config.mjs";
import * as qoderMerge from "./qoder-merge-config.mjs";
import * as zcodeMerge from "./zcode-merge-config.mjs";
import * as zcodePersonal from "./zcode-personal-config.mjs";
import * as opencodeMerge from "./opencode-merge-config.mjs";
import * as piMerge from "./pi-merge-models.mjs";
import * as workbuddyMerge from "./workbuddy-merge-models.mjs";
import { getYamlModule } from "./dsh-merge-config.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

const FIXTURE_PORT = 47821;

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function seedSidecar(sidecarRoot, name, providers) {
  writeJson(join(sidecarRoot, name), { providers });
}

function memoryPathStore(initial = "") {
  let value = initial;
  const writes = [];
  return {
    writes,
    get value() {
      return value;
    },
    store: {
      read: async () => value,
      write: async (next) => {
        writes.push(next);
        value = next;
      },
    },
  };
}

function testDriver(home, { pathValue = "", env: extraEnv = {} } = {}) {
  const env = { USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local"), ...extraEnv };
  const sidecarRoot = join(home, "AppData", "Local", "Anyswitch");
  const path = memoryPathStore(pathValue);
  const broadcasts = [];
  const shimManager = createShimManager({
    env,
    pathStore: path.store,
    broadcastFn: async () => {
      broadcasts.push("broadcast");
    },
  });
  const driver = createUninstallDriver({
    env,
    homeDir: home,
    sidecarRoot,
    shimManager,
    promptsInjector: createPromptsInjector({ homeDir: home }),
  });
  return { driver, env, home, sidecarRoot, path, broadcasts, shimManager, binRoot: shimRoot(env) };
}

function stepsByName(result) {
  return Object.fromEntries(result.steps.map((step) => [step.step, step]));
}

// A managed provider map in the shape extractManagedProviders hands the
// merge modules: one channel, one model.
function managedProviders() {
  return { chan1: { models: { m1: { contextWindow: 128000 } } } };
}

// writeDshProfilePatches/getYamlModule parse and emit cordis.patch.yml through
// js-yaml, which this project does not declare: resolveYamlModule prefers the
// copy vendored inside a global @deepseek-ai/dsh install and only then falls
// back to a bare "js-yaml" — resolved from the real process env, outside every
// injected handle. On a machine with neither, the whole dsh surface cannot
// run — including uninstallAll, whose endpoint loop strips dsh too. Probe
// read-only and skip with that reason instead of failing with an unrelated
// MODULE_NOT_FOUND (same guard as dsh-merge-config.test.mjs).
async function requireYamlModule(t) {
  try {
    await getYamlModule();
    return false;
  } catch (error) {
    t.skip(`js-yaml is unavailable (${error.message}); install @deepseek-ai/dsh globally to run this test`);
    return true;
  }
}

test("the registry covers all ten integrated endpoints", () => {
  assert.deepEqual(
    [...UNINSTALL_ENDPOINT_IDS].sort(),
    ["claude", "codex", "dsh", "grok", "kimi", "opencode", "pi", "qoder", "workbuddy", "zcode"],
  );
});

test("uninstallAll on a pristine home is a complete no-op", async (t) => {
  if (await requireYamlModule(t)) return; // the endpoint loop includes dsh
  const home = mkTestDir("uninstall-pristine-");
  const { driver, broadcasts } = testDriver(home);
  const result = await driver.uninstallAll();
  assert.equal(result.ok, true);
  for (const endpoint of Object.values(result.endpoints)) {
    assert.equal(endpoint.ok, true, endpoint.endpoint);
    for (const step of endpoint.steps) {
      assert.equal(step.changed, false, `${endpoint.endpoint}/${step.step}`);
    }
  }
  assert.deepEqual(broadcasts, []);
});

test("unknown endpoint id is rejected", async () => {
  const { driver } = testDriver(mkTestDir("uninstall-unknown-"));
  await assert.rejects(() => driver.uninstallEndpoint("nope"), /unknown endpoint/);
});

// ─────────────────────────────────────────────────────────────
// kimi
// ─────────────────────────────────────────────────────────────

function seedKimi(home, sidecarRoot, { sidecar = true, userText = 'model = "user-model"\n' } = {}) {
  const configPath = join(home, ".kimi-code", "config.toml");
  mkdirSync(dirname(configPath), { recursive: true });
  const seeded = kimiMerge.mergeKimiConfigToml(userText, managedProviders(), FIXTURE_PORT, "tok", null, null);
  writeFileSync(configPath, seeded.text);
  if (sidecar) seedSidecar(sidecarRoot, "kimi-sidecar.json", ["chan1"]);
  return configPath;
}

test("kimi: sidecar-recorded strip removes the whole block and the sidecar", async () => {
  const home = mkTestDir("uninstall-kimi-");
  const { driver, sidecarRoot } = testDriver(home);
  const configPath = seedKimi(home, sidecarRoot);

  const result = await driver.uninstallEndpoint("kimi");
  assert.equal(result.ok, true);
  const text = readFileSync(configPath, "utf8");
  assert.equal(text, 'model = "user-model"\n');
  assert.ok(!existsSync(join(sidecarRoot, "kimi-sidecar.json")));

  const again = await driver.uninstallEndpoint("kimi");
  assert.equal(again.ok, true);
  for (const step of again.steps) assert.equal(step.changed, false, step.step);
  assert.equal(readFileSync(configPath, "utf8"), 'model = "user-model"\n');
});

test("kimi: sidecar-lost residue is removed by the marker sweep", async () => {
  const home = mkTestDir("uninstall-kimi-nosidecar-");
  const { driver, sidecarRoot } = testDriver(home);
  const configPath = seedKimi(home, sidecarRoot, { sidecar: false });

  const result = await driver.uninstallEndpoint("kimi");
  assert.equal(result.ok, true);
  assert.equal(stepsByName(result)["config-sync"].changed, false); // public path early-returned
  assert.equal(stepsByName(result)["marker-sweep"].changed, true);
  assert.equal(readFileSync(configPath, "utf8"), 'model = "user-model"\n');
});

test("kimi: sidecar-lost residue carrying the Anyswitch pseudo-channel is swept", async () => {
  const home = mkTestDir("uninstall-kimi-anyswitch-");
  const { driver } = testDriver(home);
  const configPath = join(home, ".kimi-code", "config.toml");
  mkdirSync(dirname(configPath), { recursive: true });
  // Kimi 自写回配置后掉标记的伪渠道：provider id 就是渠道显示名（不在 "_" 前缀
  // 管理面内），模型别名保持 _auto/ 前缀。
  writeFileSync(
    configPath,
    [
      'default_model = "user-model"',
      "",
      '[providers."Anyswitch"]',
      'type = "openai"',
      `base_url = "http://127.0.0.1:${FIXTURE_PORT}/openai/auto/v1"`,
      'api_key = "tok"',
      "",
      '[models."_auto/auto"]',
      'provider = "Anyswitch"',
      'model = "auto"',
      "",
      "[providers.user-own]",
      'type = "openai"',
      'base_url = "https://mine.example/v1"',
      "",
    ].join("\n"),
  );

  const result = await driver.uninstallEndpoint("kimi");
  assert.equal(result.ok, true);
  const text = readFileSync(configPath, "utf8");
  assert.doesNotMatch(text, /Anyswitch/);
  assert.doesNotMatch(text, /_auto/);
  assert.match(text, /\[providers\.user-own\]/, "用户自建渠道保留");
  assert.match(text, /default_model = "user-model"/, "用户的默认模型引用保留");
});

test("kimi: a config holding only the managed block is deleted", async () => {
  const home = mkTestDir("uninstall-kimi-only-");
  const { driver, sidecarRoot } = testDriver(home);
  const configPath = seedKimi(home, sidecarRoot, { userText: "" });

  const result = await driver.uninstallEndpoint("kimi");
  assert.equal(result.ok, true);
  assert.ok(!existsSync(configPath));
  assert.equal(stepsByName(result)["marker-sweep"].removed, true);
});

// ─────────────────────────────────────────────────────────────
// grok
// ─────────────────────────────────────────────────────────────

test("grok: block, stale tables and sidecar are removed; user tables stay", async () => {
  const home = mkTestDir("uninstall-grok-");
  const { driver, sidecarRoot } = testDriver(home);
  const configPath = join(home, ".grok", "config.toml");
  mkdirSync(dirname(configPath), { recursive: true });
  const seeded = grokMerge.mergeGrokConfigToml(
    'api_key = "user-key"\n\n[models]\ndefault = "user-model"\n',
    managedProviders(),
    FIXTURE_PORT,
    "tok",
    null,
    { catalog: null },
  );
  writeFileSync(configPath, seeded.text);
  seedSidecar(sidecarRoot, "grok-sidecar.json", ["chan1"]);

  const result = await driver.uninstallEndpoint("grok");
  assert.equal(result.ok, true);
  const text = readFileSync(configPath, "utf8");
  assert.ok(!text.includes("anyswitch"), text);
  assert.ok(text.includes('api_key = "user-key"'));
  assert.ok(text.includes('default = "user-model"'));
  assert.ok(!existsSync(join(sidecarRoot, "grok-sidecar.json")));
});

// ─────────────────────────────────────────────────────────────
// codex
// ─────────────────────────────────────────────────────────────

function seedCodex(home, sidecarRoot, { sidecar = true } = {}) {
  const configPath = join(home, ".codex", "config.toml");
  mkdirSync(dirname(configPath), { recursive: true });
  const seeded = codexMerge.mergeCodexConfigToml(
    'model = "user-model"\n\n[features]\nmy_feature = true\n',
    managedProviders(),
    FIXTURE_PORT,
    "tok",
    null,
    null,
    null,
  );
  // The public merge only writes the pointer when models exist; seed it by
  // hand to simulate a config whose sync once produced a catalog.
  const text = seeded.text.replace(
    'model = "user-model"\n',
    'model = "user-model"\nmodel_catalog_json = "model-catalogs/anyswitch-models.json"\n',
  );
  writeFileSync(configPath, text);
  const catalogPath = join(home, ".codex", "model-catalogs", "anyswitch-models.json");
  writeJson(catalogPath, { models: [{ slug: "chan1~m1" }] });
  if (sidecar) seedSidecar(sidecarRoot, "codex-sidecar.json", ["chan1"]);
  return { configPath, catalogPath };
}

test("codex: block, pointer, catalog file and sidecar are all removed", async () => {
  const home = mkTestDir("uninstall-codex-");
  const { driver, sidecarRoot } = testDriver(home);
  const { configPath, catalogPath } = seedCodex(home, sidecarRoot);

  const result = await driver.uninstallEndpoint("codex");
  assert.equal(result.ok, true);
  const text = readFileSync(configPath, "utf8");
  assert.ok(!text.includes("anyswitch"), text);
  assert.ok(!text.includes("model_catalog_json"), text);
  // the user's own [features] table survives untouched — the table is wholly
  // user/codex-client owned (the once-managed memories gate is gone from the
  // sync; there is no forced residue here any more)
  assert.ok(text.includes("my_feature = true"));
  assert.ok(!existsSync(catalogPath));
  assert.ok(!existsSync(join(sidecarRoot, "codex-sidecar.json")));
});

test("codex: sidecar-lost sweep also removes the pointer and the catalog file", async () => {
  const home = mkTestDir("uninstall-codex-nosidecar-");
  const { driver, sidecarRoot } = testDriver(home);
  const { configPath, catalogPath } = seedCodex(home, sidecarRoot, { sidecar: false });

  const result = await driver.uninstallEndpoint("codex");
  assert.equal(result.ok, true);
  assert.equal(stepsByName(result)["marker-sweep"].changed, true);
  assert.equal(stepsByName(result)["catalog-file"].changed, true);
  const text = readFileSync(configPath, "utf8");
  assert.ok(!text.includes("anyswitch"), text);
  assert.ok(!text.includes("model_catalog_json"), text);
  assert.ok(!existsSync(catalogPath));
  // the emptied model-catalogs dir goes with it
  assert.ok(!existsSync(dirname(catalogPath)));
});

// ─────────────────────────────────────────────────────────────
// qoder
// ─────────────────────────────────────────────────────────────

function seedQoder(home, sidecarRoot, { sidecar = true } = {}) {
  const settingsPath = join(home, ".qoder", "settings.json");
  const managedMap = qoderMerge.buildQoderProviders(managedProviders(), FIXTURE_PORT, "tok");
  writeJson(settingsPath, {
    providers: { ...managedMap, "user-conn": { baseUrl: "https://api.example.com", models: [] } },
    theme: "dark",
  });
  if (sidecar) seedSidecar(sidecarRoot, "qoder-sidecar.json", ["chan1"]);
  return settingsPath;
}

for (const withSidecar of [true, false]) {
  test(`qoder: managed connections removed (sidecar ${withSidecar ? "present" : "lost"})`, async () => {
    const home = mkTestDir(`uninstall-qoder-${withSidecar}-`);
    const { driver, sidecarRoot } = testDriver(home);
    const settingsPath = seedQoder(home, sidecarRoot, { sidecar: withSidecar });

    const result = await driver.uninstallEndpoint("qoder");
    assert.equal(result.ok, true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(Object.keys(settings.providers), ["user-conn"]);
    assert.equal(settings.theme, "dark");
    assert.ok(!existsSync(join(sidecarRoot, "qoder-sidecar.json")));
  });
}

// ─────────────────────────────────────────────────────────────
// zcode
// ─────────────────────────────────────────────────────────────

function seedZcode(home, sidecarRoot, { sidecar = true } = {}) {
  const configPath = join(home, ".zcode", "v2", "config.json");
  const managedEntry = zcodeMerge.buildZcodeProviderEntry("chan1", managedProviders().chan1, FIXTURE_PORT, "tok");
  writeJson(configPath, {
    provider: { ...managedEntry, "user-prov": { kind: "openai-compatible", options: { baseURL: "https://api.example.com/v1" } } },
  });
  // the client-side list carries one managed rule (relay fingerprint) and one
  // hand-made rule
  const personalPath = zcodePersonal.personalConfigPath(configPath);
  const { rule, modelRules } = zcodePersonal.personalRuleFromProviderEntry("_chan1", managedEntry._chan1);
  const userRule = {
    providerId: "mine",
    config: { group: "standard-personal", access: { type: "api-key", apiKey: "k" }, api: { type: "openai-chat-completions", baseUrl: "https://api.example.com/v1" } },
  };
  writeJson(personalPath, {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [rule, userRule] },
      modelConfigRules: { providerModelRules: modelRules },
    },
  });
  if (sidecar) seedSidecar(sidecarRoot, "zcode-sidecar.json", ["chan1"]);
  // CLI 槽位（整体为 Anyswitch 自有产物）：provider_config.json + 备份 + 共享
  // sidecar（zcode-cli-sidecar.json，与桌面版 sidecar 并排）。
  const cliSlotDir = zcodeMerge.zcodeCliSlotDir(sidecarRoot);
  writeJson(join(cliSlotDir, "provider_config.json"), {
    schemaVersion: 1,
    config: { providerConfigRules: { providerRules: [rule] }, modelConfigRules: { providerModelRules: modelRules } },
  });
  writeJson(join(cliSlotDir, "provider_config.backup.2026-01-01.json"), {});
  seedSidecar(sidecarRoot, "zcode-cli-sidecar.json", ["chan1"]);
  return { configPath, personalPath, cliSlotDir };
}

for (const withSidecar of [true, false]) {
  test(`zcode: config.json and provider_config.json stripped (sidecar ${withSidecar ? "present" : "lost"})`, async () => {
    const home = mkTestDir(`uninstall-zcode-${withSidecar}-`);
    const { driver, sidecarRoot } = testDriver(home);
    const { configPath, personalPath, cliSlotDir } = seedZcode(home, sidecarRoot, { sidecar: withSidecar });

    const result = await driver.uninstallEndpoint("zcode");
    assert.equal(result.ok, true, JSON.stringify(result.steps));
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(Object.keys(config.provider), ["user-prov"]);
    const personal = JSON.parse(readFileSync(personalPath, "utf8"));
    assert.deepEqual(
      personal.config.providerConfigRules.providerRules.map((rule) => rule.providerId),
      ["mine"],
    );
    assert.deepEqual(personal.config.modelConfigRules.providerModelRules, []);
    assert.ok(!existsSync(join(sidecarRoot, "zcode-sidecar.json")));
    // CLI 槽位目录与其 sidecar 一并移除（桌面版用户配置不受影响）。
    assert.ok(!existsSync(cliSlotDir), "CLI 槽位目录整体移除");
    assert.ok(!existsSync(join(sidecarRoot, "zcode-cli-sidecar.json")), "CLI sidecar 移除");

    const again = await driver.uninstallEndpoint("zcode");
    assert.equal(again.ok, true);
    for (const step of again.steps) assert.equal(step.changed, false, step.step);
  });
}

// ─────────────────────────────────────────────────────────────
// opencode
// ─────────────────────────────────────────────────────────────

test("opencode: sidecar-recorded strip removes the managed providers and the sidecar", async () => {
  const home = mkTestDir("uninstall-opencode-");
  const { driver, sidecarRoot } = testDriver(home);
  const configPath = join(home, ".config", "opencode", "opencode.json");
  const managedEntry = opencodeMerge.buildOpencodeProviderEntry("chan1", managedProviders().chan1, FIXTURE_PORT, "{file:x}");
  writeJson(configPath, {
    provider: {
      ...managedEntry,
      mine: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://api.example.com/v1" }, models: {} },
    },
  });
  seedSidecar(sidecarRoot, "opencode-sidecar.json", ["chan1"]);

  const result = await driver.uninstallEndpoint("opencode");
  assert.equal(result.ok, true);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(Object.keys(config.provider), ["mine"]);
  assert.ok(!existsSync(join(sidecarRoot, "opencode-sidecar.json")));
});

test("opencode: sidecar-lost residue is stripped by the relay fingerprint sweep", async () => {
  const home = mkTestDir("uninstall-opencode-nosidecar-");
  const { driver } = testDriver(home);
  const configPath = join(home, ".config", "opencode", "opencode.json");
  const managedEntry = opencodeMerge.buildOpencodeProviderEntry("chan1", managedProviders().chan1, FIXTURE_PORT, "{file:x}");
  writeJson(configPath, {
    provider: {
      ...managedEntry,
      mine: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://api.example.com/v1" }, models: {} },
    },
  });

  const result = await driver.uninstallEndpoint("opencode");
  assert.equal(result.ok, true);
  // No sidecar names the entry and the empty-set sync early-returned, so the
  // sweep's relay fingerprint is the only identification left.
  assert.equal(stepsByName(result)["config-sync"].changed, false);
  const sweep = stepsByName(result)["marker-sweep"];
  assert.equal(sweep.changed, true);
  assert.deepEqual(sweep.removed, ["chan1"]);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(Object.keys(config.provider), ["mine"]);
  // user content survives, so the wholesale-managed husk removal must not fire
  assert.ok(existsSync(configPath));
});

test("opencode: the wholesale-managed file is removed once nothing remains", async () => {
  const home = mkTestDir("uninstall-opencode-husk-");
  const { driver, sidecarRoot } = testDriver(home);
  const configPath = join(home, ".config", "opencode", "opencode.json");
  const managedEntry = opencodeMerge.buildOpencodeProviderEntry("chan1", managedProviders().chan1, FIXTURE_PORT, "{file:x}");
  writeJson(configPath, { provider: { ...managedEntry } });
  seedSidecar(sidecarRoot, "opencode-sidecar.json", ["chan1"]);

  const result = await driver.uninstallEndpoint("opencode");
  assert.equal(result.ok, true);
  assert.ok(!existsSync(configPath));
});

// ─────────────────────────────────────────────────────────────
// pi
// ─────────────────────────────────────────────────────────────

test("pi: sidecar-recorded strip removes managed providers, user providers stay", async () => {
  const home = mkTestDir("uninstall-pi-");
  const { driver, sidecarRoot } = testDriver(home);
  const modelsPath = join(home, ".pi", "agent", "models.json");
  const managedEntry = piMerge.buildPiProviderEntry("chan1", managedProviders().chan1, FIXTURE_PORT, null, "tok");
  writeJson(modelsPath, {
    providers: {
      ...managedEntry,
      userp: { baseUrl: "https://api.example.com/v1", api: "openai-completions", models: [] },
      // a "_"-named provider NOT pointing at the relay is the user's own
      "_mine": { baseUrl: "https://api.example.com/v1", api: "openai-completions", models: [] },
    },
  });
  seedSidecar(sidecarRoot, "pi-sidecar.json", ["chan1"]);

  const result = await driver.uninstallEndpoint("pi");
  assert.equal(result.ok, true);
  const config = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(Object.keys(config.providers).sort(), ["_mine", "userp"]);
  assert.ok(!existsSync(join(sidecarRoot, "pi-sidecar.json")));
});

test("pi: sidecar-lost residue carrying the reserved \"_\" prefix is swept by the relay fingerprint", async () => {
  const home = mkTestDir("uninstall-pi-nosidecar-");
  const { driver } = testDriver(home);
  const modelsPath = join(home, ".pi", "agent", "models.json");
  const managedEntry = piMerge.buildPiProviderEntry("chan1", managedProviders().chan1, FIXTURE_PORT, null, "tok");
  writeJson(modelsPath, {
    providers: {
      ...managedEntry, // key "_chan1", baseURL at the loopback relay
      // a "_"-named provider NOT pointing at the relay is the user's own —
      // the prefix alone must not sink it
      "_mine": { baseUrl: "https://api.example.com/v1", api: "openai-completions", models: [] },
    },
  });

  const result = await driver.uninstallEndpoint("pi");
  assert.equal(result.ok, true);
  // No sidecar names the entry and the empty-set sync early-returned, so the
  // sweep's reserved-prefix-plus-relay-fingerprint rule does the stripping.
  assert.equal(stepsByName(result)["config-sync"].changed, false);
  const sweep = stepsByName(result)["marker-sweep"];
  assert.equal(sweep.changed, true);
  assert.deepEqual(sweep.removed, ["_chan1"]);
  const config = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(Object.keys(config.providers), ["_mine"]);
});

test("pi: sidecar-lost Anyswitch pseudo-channel is stripped by the relay fingerprint", async () => {
  const home = mkTestDir("uninstall-pi-anyswitch-");
  const { driver } = testDriver(home);
  const modelsPath = join(home, ".pi", "agent", "models.json");
  writeJson(modelsPath, {
    providers: {
      // 伪渠道 key 是渠道显示名，没有 "_" 前缀；托管身份只剩 x-agent-id 头与 relay URL。
      Anyswitch: {
        name: "Anyswitch",
        baseUrl: `http://127.0.0.1:${FIXTURE_PORT}/openai/auto/v1`,
        apiKey: "tok",
        api: "openai-completions",
        headers: { "x-agent-id": "pi", "x-agent-instance": "direct" },
        models: [{ id: "auto" }],
      },
      // 用户自己刚好以 Anyswitch 开头但指向别处的渠道必须留下。
      "Anyswitch-corp": {
        baseUrl: "https://mine.example/v1",
        api: "openai-completions",
        models: [{ id: "m1" }],
      },
    },
  });

  const result = await driver.uninstallEndpoint("pi");
  assert.equal(result.ok, true);
  const config = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(Object.keys(config.providers), ["Anyswitch-corp"]);
});

// ─────────────────────────────────────────────────────────────
// dsh
// ─────────────────────────────────────────────────────────────

// The relay credential inside a managed dsh provider, in either shape the
// writer has emitted: the legacy token-by-env reference, and the token-by-
// header it now writes (dsh-merge-config.mjs buildDshProviderEntry). Uninstall
// must recognize both — a profile predating the move still has to strip.
const DSH_CREDENTIAL_LINES = {
  legacy: [
    "        apiKeyEnv: ANYSWITCH_RELAY_TOKEN",
    "        headers:",
    "          x-agent-id: dsh",
  ],
  header: [
    "        headers:",
    "          x-agent-id: dsh",
    "          Authorization: 'Bearer relay-token'",
  ],
};

const dshPatchSeed = (credential, pseudo = false) => [
  "- id: llm-pi-ai",
  "  name: '@deepseek-ai/dsh-llm-pi-ai'",
  "  config:",
  "    providers:",
  ...(pseudo
    ? [
      "      Anyswitch:",
      "        displayName: Anyswitch",
      "        api: openai-completions",
      "        baseURL: 'http://127.0.0.1:47821/openai/chan1/v1'",
      ...DSH_CREDENTIAL_LINES[credential],
      "        models: []",
    ]
    : []),
  "      _chan1:",
  "        displayName: chan1",
  "        api: openai-completions",
  "        baseURL: 'http://127.0.0.1:47821/openai/chan1/v1'",
  ...DSH_CREDENTIAL_LINES[credential],
  "        models: []",
  "      userp:",
  "        api: anthropic",
  "        baseURL: 'https://api.example.com'",
  "- id: other-plugin",
  "  config:",
  "    x: 1",
  "",
].join("\n");

function seedDsh(home, sidecarRoot, { sidecar = true, credential = "legacy", pseudo = false } = {}) {
  const dshHome = join(home, ".dsh");
  const patchPath = join(dshHome, "profiles", "p1", "cordis.patch.yml");
  mkdirSync(dirname(patchPath), { recursive: true });
  writeFileSync(patchPath, dshPatchSeed(credential, pseudo));
  mkdirSync(join(dshHome, "profiles", "p2"), { recursive: true }); // no patch file
  if (sidecar) seedSidecar(sidecarRoot, "dsh-sidecar.json", ["chan1"]);
  return { dshHome, patchPath, p2PatchPath: join(dshHome, "profiles", "p2", "cordis.patch.yml") };
}

for (const withSidecar of [true, false]) {
  for (const credential of ["legacy", "header"]) {
    test(`dsh: managed providers spliced out, other rows and profiles untouched (sidecar ${withSidecar ? "present" : "lost"}, ${credential} credential)`, async (t) => {
      if (await requireYamlModule(t)) return;
      const home = mkTestDir(`uninstall-dsh-${withSidecar}-${credential}-`);
      const { driver, sidecarRoot } = testDriver(home);
      const { patchPath, p2PatchPath } = seedDsh(home, sidecarRoot, { sidecar: withSidecar, credential });

    const result = await driver.uninstallEndpoint("dsh");
    assert.equal(result.ok, true, JSON.stringify(result.steps));
    const text = readFileSync(patchPath, "utf8");
    assert.ok(!text.includes("_chan1"), text);
    assert.ok(!text.includes("127.0.0.1"), text);
    assert.ok(text.includes("userp:"), text);
    assert.ok(text.includes("other-plugin"), text);
    // a profile that never had a patch file must not gain one
    assert.ok(!existsSync(p2PatchPath));
    assert.ok(!existsSync(join(sidecarRoot, "dsh-sidecar.json")));

    const again = await driver.uninstallEndpoint("dsh");
      assert.equal(again.ok, true);
      assert.equal(stepsByName(again)["marker-sweep"].changed, false);
    });
  }
}

test("dsh: sidecar-lost sweep also recognizes the Anyswitch pseudo-channel key", async (t) => {
  if (await requireYamlModule(t)) return;
  const home = mkTestDir("uninstall-dsh-pseudo-");
  const { driver, sidecarRoot } = testDriver(home);
  const { patchPath } = seedDsh(home, sidecarRoot, { sidecar: false, pseudo: true });
  const result = await driver.uninstallEndpoint("dsh");
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  const text = readFileSync(patchPath, "utf8");
  assert.ok(!text.includes("Anyswitch:"), text);
  assert.ok(!text.includes("_chan1"), text);
  assert.ok(text.includes("userp:"), text);
});

// ─────────────────────────────────────────────────────────────
// claude
// ─────────────────────────────────────────────────────────────

test("claude: prompt block removed, junctions removed, real dirs and targets kept", async () => {
  const home = mkTestDir("uninstall-claude-");
  const { driver } = testDriver(home);

  // seed the CLAUDE.md managed block through the real injector
  const claudeDir = join(home, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const claudeMd = join(claudeDir, "CLAUDE.md");
  writeFileSync(claudeMd, "# My notes\n");
  createPromptsInjector({ homeDir: home }).syncEndpoint("claude", [{ content: "Always answer in Chinese." }]);
  assert.ok(readFileSync(claudeMd, "utf8").includes(MANAGED_BEGIN));

  // seed skills: one junction into a repo lookalike, one real local dir
  const repo = mkTestDir("claude-skills-repo-");
  mkdirSync(join(repo, "my-skill"), { recursive: true });
  writeFileSync(join(repo, "my-skill", "SKILL.md"), "---\nname: my-skill\n---\n");
  const skillsDir = join(claudeDir, "skills");
  mkdirSync(skillsDir, { recursive: true });
  createJunction(join(skillsDir, "my-skill"), join(repo, "my-skill"));
  mkdirSync(join(skillsDir, "local-skill"), { recursive: true });
  writeFileSync(join(skillsDir, "local-skill", "SKILL.md"), "---\nname: local-skill\n---\n");

  const result = await driver.uninstallEndpoint("claude");
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.equal(readFileSync(claudeMd, "utf8"), "# My notes\n");
  assert.ok(!existsSync(join(skillsDir, "my-skill")), "junction removed");
  assert.ok(existsSync(join(repo, "my-skill", "SKILL.md")), "junction target intact");
  assert.ok(existsSync(join(skillsDir, "local-skill", "SKILL.md")), "real dir untouched");

  const again = await driver.uninstallEndpoint("claude");
  assert.equal(again.ok, true);
  for (const step of again.steps) assert.equal(step.changed, false, step.step);
});

test("claude: a CLAUDE.md holding only the managed block is deleted", async () => {
  const home = mkTestDir("uninstall-claude-only-");
  const { driver } = testDriver(home);
  createPromptsInjector({ homeDir: home }).syncEndpoint("claude", [{ content: "preset body" }]);
  const claudeMd = join(home, ".claude", "CLAUDE.md");
  assert.ok(existsSync(claudeMd));

  const result = await driver.uninstallEndpoint("claude");
  assert.equal(result.ok, true);
  assert.ok(!existsSync(claudeMd));
});

// ─────────────────────────────────────────────────────────────
// workbuddy
// ─────────────────────────────────────────────────────────────

function seedWorkbuddy(home, sidecarRoot, { sidecar = true } = {}) {
  const modelsPath = join(home, ".workbuddy", "models.json");
  const managed = workbuddyMerge.buildWorkbuddyModelEntry(
    "chan1",
    { models: {} },
    "m1",
    {},
    FIXTURE_PORT,
    "tok",
  );
  writeJson(modelsPath, {
    models: [
      { id: "user-1", name: "Mine", url: "https://mine.example/v1/chat/completions" },
      managed,
    ],
    theme: "dark",
  });
  writeFileSync(
    join(home, ".workbuddy", "AGENTS.md"),
    "# My notes\n\n" + buildManagedBlock([{ content: "preset body" }]) + "\n",
  );
  if (sidecar) seedSidecar(sidecarRoot, "workbuddy-sidecar.json", ["chan1"]);
  return modelsPath;
}

test("workbuddy: managed models, prompt block, skill junctions and sidecar are removed", async () => {
  const home = mkTestDir("uninstall-workbuddy-");
  const { driver, sidecarRoot } = testDriver(home);
  const modelsPath = seedWorkbuddy(home, sidecarRoot);

  // skills：一个指向仓库的联接 + 一个本地真目录（必须留下）。
  const repo = mkTestDir("workbuddy-skills-repo-");
  mkdirSync(join(repo, "my-skill"), { recursive: true });
  writeFileSync(join(repo, "my-skill", "SKILL.md"), "---\nname: my-skill\n---\n");
  const skillsDir = join(home, ".workbuddy", "skills");
  mkdirSync(skillsDir, { recursive: true });
  createJunction(join(skillsDir, "my-skill"), join(repo, "my-skill"));
  mkdirSync(join(skillsDir, "local-skill"), { recursive: true });
  writeFileSync(join(skillsDir, "local-skill", "SKILL.md"), "---\nname: local-skill\n---\n");

  const result = await driver.uninstallEndpoint("workbuddy");
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  const models = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(models.models.map((entry) => entry.id), ["user-1"]);
  assert.equal(models.theme, "dark", "未知顶层键原样保留");
  assert.equal(readFileSync(join(home, ".workbuddy", "AGENTS.md"), "utf8"), "# My notes\n");
  assert.ok(!existsSync(join(skillsDir, "my-skill")), "junction removed");
  assert.ok(existsSync(join(repo, "my-skill", "SKILL.md")), "junction target intact");
  assert.ok(existsSync(join(skillsDir, "local-skill", "SKILL.md")), "real dir untouched");
  assert.ok(!existsSync(join(sidecarRoot, "workbuddy-sidecar.json")));
  assert.equal(stepsByName(result)["prompt-block"].changed, true);
  assert.equal(stepsByName(result)["skill-junctions"].changed, true);

  const again = await driver.uninstallEndpoint("workbuddy");
  assert.equal(again.ok, true);
  for (const step of again.steps) assert.equal(step.changed, false, step.step);
});

test("workbuddy: sidecar-lost residue is removed by the URL-signature sweep", async () => {
  const home = mkTestDir("uninstall-workbuddy-nosidecar-");
  const { driver } = testDriver(home);
  const modelsPath = seedWorkbuddy(home, join(home, "AppData", "Local", "Anyswitch"), { sidecar: false });

  const result = await driver.uninstallEndpoint("workbuddy");
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.equal(stepsByName(result)["config-sync"].changed, false, "空 sidecar + 空 store 走早退");
  assert.equal(stepsByName(result)["marker-sweep"].changed, true);
  const models = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(models.models.map((entry) => entry.id), ["user-1"]);
});

test("workbuddy: a models.json created by the strip itself is reclaimed", async () => {
  const home = mkTestDir("uninstall-workbuddy-husk-");
  const { driver, sidecarRoot } = testDriver(home);
  seedSidecar(sidecarRoot, "workbuddy-sidecar.json", ["chan1"]);
  const modelsPath = join(home, ".workbuddy", "models.json");

  const result = await driver.uninstallEndpoint("workbuddy");
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.ok(!existsSync(modelsPath), "no models.json husk");
});

test("workbuddy: WORKBUDDY_CONFIG_DIR 只挪 models，提示词与 skills 仍按静态 home 清理", async () => {
  const home = mkTestDir("uninstall-workbuddy-envroot-");
  const envRoot = mkTestDir("uninstall-workbuddy-envroot-dir-");
  const { driver, sidecarRoot } = testDriver(home, { env: { WORKBUDDY_CONFIG_DIR: envRoot } });
  seedSidecar(sidecarRoot, "workbuddy-sidecar.json", ["chan1"]);

  // models.json 落在写入器认的 env 目录里。
  const modelsPath = join(envRoot, "models.json");
  writeJson(modelsPath, {
    models: [
      { id: "user-1", name: "Mine", url: "https://mine.example/v1/chat/completions" },
      workbuddyMerge.buildWorkbuddyModelEntry("chan1", { models: {} }, "m1", {}, FIXTURE_PORT, "tok"),
    ],
    theme: "dark",
  });
  // 提示词与 skills 落在注入/部署侧的静态 home 目录里。
  const agentsMd = join(home, ".workbuddy", "AGENTS.md");
  mkdirSync(dirname(agentsMd), { recursive: true });
  writeFileSync(agentsMd, "# My notes\n\n" + buildManagedBlock([{ content: "preset body" }]) + "\n");
  const repo = mkTestDir("workbuddy-skills-repo-envroot-");
  mkdirSync(join(repo, "my-skill"), { recursive: true });
  writeFileSync(join(repo, "my-skill", "SKILL.md"), "---\nname: my-skill\n---\n");
  const skillsDir = join(home, ".workbuddy", "skills");
  mkdirSync(skillsDir, { recursive: true });
  createJunction(join(skillsDir, "my-skill"), join(repo, "my-skill"));

  const result = await driver.uninstallEndpoint("workbuddy");
  assert.equal(result.ok, true, JSON.stringify(result.steps));

  const models = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(models.models.map((entry) => entry.id), ["user-1"], "env 目录的托管模型条目被清除");
  assert.equal(models.theme, "dark");
  assert.equal(readFileSync(agentsMd, "utf8"), "# My notes\n", "静态 home 的托管块被清除");
  assert.ok(!existsSync(join(skillsDir, "my-skill")), "静态 home 的联接被撤销");
  assert.ok(existsSync(join(repo, "my-skill", "SKILL.md")), "junction target intact");
  assert.equal(stepsByName(result)["prompt-block"].changed, true);
  assert.equal(stepsByName(result)["skill-junctions"].changed, true);
  assert.ok(!existsSync(join(home, ".workbuddy", "models.json")), "不再去静态 home 清模型表");
});

// ─────────────────────────────────────────────────────────────
// shims through the driver
// ─────────────────────────────────────────────────────────────

test("shim retirement: per-endpoint dir removed, PATH entry dropped, broadcast sent", async () => {
  const home = mkTestDir("uninstall-shim-grok-");
  const binGrok = join(shimRoot({ USERPROFILE: home }), "bin-grok");
  const { driver, shimManager, path, broadcasts } = testDriver(home, { pathValue: `C:\\x;${binGrok}` });
  shimManager.installShim("grok");

  const result = await driver.uninstallEndpoint("grok");
  assert.equal(result.ok, true);
  assert.ok(!existsSync(binGrok));
  assert.equal(path.value, "C:\\x");
  assert.deepEqual(broadcasts, ["broadcast"]);

  const again = await driver.uninstallEndpoint("grok");
  assert.equal(again.ok, true);
  assert.equal(stepsByName(again)["shim"].changed, false);
  assert.equal(stepsByName(again)["path"].changed, false);
  assert.equal(broadcasts.length, 1, "no second broadcast when nothing changed");
});

test("shared bin/: PATH entry survives a partial uninstall, is dropped with the last command", async (t) => {
  if (await requireYamlModule(t)) return; // strips dsh directly and via uninstallAll
  const home = mkTestDir("uninstall-shim-bin-");
  const binDir = join(shimRoot({ USERPROFILE: home }), "bin");
  const { driver, shimManager, path, broadcasts } = testDriver(home, { pathValue: `C:\\x;${binDir}` });
  shimManager.installShim("dsh");
  shimManager.installShim("zcode");
  writeFileSync(join(binDir, "zcode-app.vbs"), "' vbs\n");
  // the retired agy shim still on disk from a previous product generation
  writeFileSync(join(binDir, "agy"), "sh");
  writeFileSync(join(binDir, "agy.cmd"), "cmd");
  writeFileSync(join(binDir, "agy.ps1"), "ps1");

  const partial = await driver.uninstallEndpoint("dsh");
  assert.equal(partial.ok, true, JSON.stringify(partial.steps));
  assert.ok(existsSync(join(binDir, "zcode.cmd")), "zcode untouched");
  assert.equal(path.value, `C:\\x;${binDir}`, "PATH entry kept while zcode remains");
  assert.deepEqual(broadcasts, []);

  const all = await driver.uninstallAll();
  assert.equal(all.ok, true, JSON.stringify(all.retiredShims));
  assert.ok(!existsSync(binDir), "bin/ removed once empty");
  assert.equal(path.value, "C:\\x");
  assert.deepEqual(broadcasts, ["broadcast"], "one broadcast at the end");
  assert.equal(all.retiredShims.find((r) => r.id === "agy").changed, true);
});

// ─────────────────────────────────────────────────────────────
// husk reclamation
// ─────────────────────────────────────────────────────────────

test("zcode/pi/qoder: config files created by the strip itself are reclaimed", async () => {
  const home = mkTestDir("uninstall-husk-");
  const { driver, sidecarRoot } = testDriver(home);
  // sidecars claim management, but the endpoint files never existed
  seedSidecar(sidecarRoot, "zcode-sidecar.json", ["chan1"]);
  seedSidecar(sidecarRoot, "pi-sidecar.json", ["chan1"]);
  seedSidecar(sidecarRoot, "qoder-sidecar.json", ["chan1"]);

  const zcode = await driver.uninstallEndpoint("zcode");
  assert.equal(zcode.ok, true, JSON.stringify(zcode.steps));
  assert.ok(!existsSync(join(home, ".zcode", "v2", "config.json")), "no config.json husk");
  assert.ok(!existsSync(join(home, ".zcode", "v2", "provider_config.json")), "no provider_config.json husk");

  const pi = await driver.uninstallEndpoint("pi");
  assert.equal(pi.ok, true, JSON.stringify(pi.steps));
  assert.ok(!existsSync(join(home, ".pi", "agent", "models.json")), "no models.json husk");

  const qoder = await driver.uninstallEndpoint("qoder");
  assert.equal(qoder.ok, true, JSON.stringify(qoder.steps));
  assert.ok(!existsSync(join(home, ".qoder", "settings.json")), "no settings.json husk");
});
