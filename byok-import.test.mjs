import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createByokImportService, suggestBaseId } from "./byok-import.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";
import { MANAGED_BEGIN as KIMI_BEGIN, MANAGED_END as KIMI_END } from "./kimi-merge-config.mjs";
import { MANAGED_BEGIN as CODEX_BEGIN, MANAGED_END as CODEX_END } from "./codex-merge-config.mjs";
import { MANAGED_BEGIN as GROK_BEGIN, MANAGED_END as GROK_END } from "./grok-merge-config.mjs";

// ── hermetic js-yaml for the dsh scan ───────────────────────────
// scanDsh reads profile patches through dsh-merge-config.mjs's getYamlModule(),
// which probes %APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\js-yaml
// and otherwise falls back to a bare "js-yaml" import. Neither exists on a
// machine without a global dsh install, and scanLocalConfigs swallows scanner
// errors — the dsh group would silently vanish and the dsh case below would
// stay red on a clean machine (and green here only because this machine
// happens to carry the global install). Ship a vendored parser copy in
// test-helpers/vendor/js-yaml (js-yaml 4.3.2, the exact dependency the global
// @deepseek-ai/dsh install carries) and point APPDATA at a fixture tree that
// exposes it at the probed path. This must run at module load: getYamlModule()
// caches the first parser it resolves for the whole process.
const yamlFixtureRoot = mkTestDir("byok-import-yaml-");
const fakeAppData = join(yamlFixtureRoot, "appdata");
const fakeDshYaml = join(fakeAppData, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "js-yaml");
mkdirSync(dirname(fakeDshYaml), { recursive: true });
cpSync(join(dirname(fileURLToPath(import.meta.url)), "test-helpers", "vendor", "js-yaml"), fakeDshYaml, {
  recursive: true,
});
const realAppData = process.env.APPDATA;
process.env.APPDATA = fakeAppData;
after(() => {
  if (realAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = realAppData;
});

// ── fixture helpers ─────────────────────────────────────────────

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function writeText(path, text) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function makeFixture() {
  const root = mkTestDir("byok-import-");
  const homeDir = join(root, "home");
  const storeRoot = join(root, "store");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(storeRoot, { recursive: true });
  return { root, homeDir, storeRoot };
}

function storeProvider(baseURL, extra = {}) {
  return {
    displayName: baseURL,
    baseURL,
    protocol: "openai-compatible",
    credentialFile: "x.dpapi",
    discovered: { m1: { displayName: "m1" } },
    modelFilter: ["m1"],
    models: { m1: { displayName: "m1" } },
    ...extra,
  };
}

function makeService(fixture, overrides = {}) {
  return createByokImportService({
    storeRoot: fixture.storeRoot,
    homeDir: fixture.homeDir,
    env: {},
    now: () => overrides.nowValue ?? 1_000_000,
    protect: async (plaintext, providerId) => Buffer.from(`fake-cipher:${providerId}:${plaintext.toString("utf8")}`, "utf8"),
    ...overrides,
  });
}

function findEntry(scan, agentId, keySuffix) {
  const group = scan.groups.find((g) => g.agentId === agentId);
  return group?.entries.find((e) => e.key === `${agentId}::${keySuffix}`);
}

function agentKeys(scan, agentId) {
  return scan.groups.find((g) => g.agentId === agentId)?.entries.map((e) => e.key) ?? [];
}

// ── per-endpoint scan fixtures ──────────────────────────────────

test("zcode: union of provider_config.json and config.json, managed excluded", async () => {
  const fixture = makeFixture();
  writeJson(join(fixture.homeDir, ".zcode", "v2", "provider_config.json"), {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "myz",
            providerName: "My Z",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "z-secret" },
              api: { type: "openai-chat-completions", baseUrl: "https://z.example.com/v1" },
              personalModelIds: ["m1", "m2"],
            },
          },
          {
            providerId: "_managed",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "x" },
              api: { type: "openai-chat-completions", baseUrl: "https://managed.example.com/v1" },
            },
          },
          {
            providerId: "relay-leftover",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "x" },
              api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:47820/openai/relay-leftover/v1" },
            },
          },
          {
            providerId: "builtin:zai",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "" },
              api: { type: "openai-chat-completions", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
            },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [] },
    },
  });
  writeJson(join(fixture.homeDir, ".zcode", "v2", "config.json"), {
    provider: {
      myz: { name: "Dup", options: { apiKey: "other", baseURL: "https://z.example.com/v1" }, models: {} },
      extra: { name: "Extra", options: { apiKey: "e-secret", baseURL: "https://extra.example.com/v1" }, models: { em1: {} } },
      _old: { name: "Old", options: { apiKey: "o", baseURL: "https://old.example.com/v1" }, models: {} },
    },
  });
  const service = makeService(fixture);
  const scan = await service.scanLocalConfigs();
  const keys = agentKeys(scan, "zcode");
  assert.deepEqual(keys.sort(), ["zcode::builtin:zai", "zcode::extra", "zcode::myz"]);
  // provider_config.json is authoritative: its displayName wins over config.json's.
  assert.equal(findEntry(scan, "zcode", "myz").displayName, "My Z");
  assert.equal(findEntry(scan, "zcode", "myz").modelCount, 2);
  assert.equal(findEntry(scan, "zcode", "myz").status, "ok");
  assert.equal(findEntry(scan, "zcode", "extra").modelCount, 1);
  // builtin:* with an empty key is listed as no-key; its id is sanitized.
  assert.equal(findEntry(scan, "zcode", "builtin:zai").status, "no-key");
  assert.equal(findEntry(scan, "zcode", "builtin:zai").suggestedId, "builtin-zai");
});

test("kimi: managed block and stray _-prefixed tables excluded, models collected", async () => {
  const fixture = makeFixture();
  writeText(
    join(fixture.homeDir, ".kimi-code", "config.toml"),
    `${KIMI_BEGIN}
[providers."_mgd"]
type = "openai"
base_url = "http://127.0.0.1:47820/openai/mgd/v1"
api_key = "tok"
${KIMI_END}

[providers."_stray"]
type = "openai"
base_url = "https://stray.example.com/v1"
api_key = "s"

# Kimi 自写回配置后掉标记的伪渠道：provider id 就是渠道显示名，别名仍是 _auto/ 前缀
[providers."Anyswitch"]
type = "openai"
base_url = "http://127.0.0.1:47820/openai/auto/v1"
api_key = "relay-token"

[models."_auto/auto"]
provider = "Anyswitch"
model = "auto"

[providers.mykimi]
type = "openai"
base_url = "https://kimi.example.com/v1"
api_key = "kimi-secret"

[models."mykimi/model-a"]
provider = "mykimi"
model = "model-a"
display_name = "Model A"

[models."mykimi/model-b"]
provider = "mykimi"
model = "model-b"
`,
  );
  const service = makeService(fixture);
  const scan = await service.scanLocalConfigs();
  assert.deepEqual(agentKeys(scan, "kimi"), ["kimi::mykimi"]);
  const entry = findEntry(scan, "kimi", "mykimi");
  assert.equal(entry.modelCount, 2);
  assert.equal(entry.status, "ok");
});

test("codex: managed block/stray anyswitch- tables excluded, env_key resolution", async () => {
  const fixture = makeFixture();
  writeText(
    join(fixture.homeDir, ".codex", "config.toml"),
    `${CODEX_BEGIN}
[model_providers."anyswitch-mgd"]
name = "mgd"
base_url = "http://127.0.0.1:47820/openai/mgd/v1"
wire_api = "responses"
${CODEX_END}

[model_providers."anyswitch-stray"]
name = "stray"
base_url = "https://stray.example.com/v1"
wire_api = "responses"

[model_providers.usercx]
name = "User CX"
base_url = "https://cx.example.com/v1"
env_key = "CX_API_KEY"

[model_providers.noenv]
base_url = "https://noenv.example.com/v1"
env_key = "MISSING_CX_KEY"

[model_providers.litcx]
base_url = "https://lit.example.com/v1"
http_headers = { "Authorization" = "Bearer lit-secret" }
`,
  );
  const service = makeService(fixture, { env: { CX_API_KEY: "cx-secret" } });
  const scan = await service.scanLocalConfigs();
  assert.deepEqual(agentKeys(scan, "codex").sort(), ["codex::litcx", "codex::noenv", "codex::usercx"]);
  assert.equal(findEntry(scan, "codex", "usercx").status, "ok");
  assert.equal(findEntry(scan, "codex", "noenv").status, "unresolved-key");
  assert.equal(findEntry(scan, "codex", "litcx").status, "ok");
  assert.equal(findEntry(scan, "codex", "usercx").displayName, "User CX");
});

test("opencode: json + jsonc union, sidecar-only ownership, relay fingerprint backstop", async () => {
  const fixture = makeFixture();
  writeJson(join(fixture.storeRoot, "opencode-sidecar.json"), { providers: ["sidecarprov"] });
  writeJson(join(fixture.homeDir, ".config", "opencode", "opencode.json"), {
    provider: {
      sidecarprov: { options: { baseURL: "https://sc.example.com/v1", apiKey: "k" } },
      useroc: {
        name: "User OC",
        options: { baseURL: "https://oc.example.com/v1", apiKey: "oc-secret" },
        models: { m1: { name: "M One" } },
      },
      relayleft: { options: { baseURL: "http://127.0.0.1:47820/openai/relayleft/v1", apiKey: "k" } },
    },
  });
  writeText(
    join(fixture.homeDir, ".config", "opencode", "opencode.jsonc"),
    `{
  // user comment
  "provider": {
    "envref": { "options": { "baseURL": "https://er.example.com/v1", "apiKey": "{env:OC_ENV_KEY}" } },
    "fileref": { "options": { "baseURL": "https://fr.example.com/v1", "apiKey": "{file:${join(fixture.root, "oc-token").replace(/\\/g, "/")}}" } },
  }
}`,
  );
  writeText(join(fixture.root, "oc-token"), "file-secret\n");
  const service = makeService(fixture, { env: { OC_ENV_KEY: "env-secret" } });
  const scan = await service.scanLocalConfigs();
  assert.deepEqual(agentKeys(scan, "opencode").sort(), ["opencode::envref", "opencode::fileref", "opencode::useroc"]);
  assert.equal(findEntry(scan, "opencode", "useroc").status, "ok");
  assert.equal(findEntry(scan, "opencode", "envref").status, "ok");
  assert.equal(findEntry(scan, "opencode", "fileref").status, "ok");
  assert.equal(findEntry(scan, "opencode", "useroc").modelCount, 1);
});

test("pi: _-prefix and sidecar excluded, ${VAR} reference resolution", async () => {
  const fixture = makeFixture();
  writeJson(join(fixture.storeRoot, "pi-sidecar.json"), { providers: ["sc"] });
  writeJson(join(fixture.homeDir, ".pi", "agent", "models.json"), {
    providers: {
      _mg: { baseUrl: "https://mg.example.com/v1", apiKey: "k", models: [{ id: "x" }] },
      sc: { baseUrl: "https://sc.example.com/v1", apiKey: "k", models: [{ id: "x" }] },
      envmiss: { baseUrl: "https://em.example.com/v1", apiKey: "${PI_MISSING_KEY}", models: [{ id: "p1" }] },
      lit: { baseUrl: "https://lit.example.com/v1", apiKey: "pi-secret", models: [{ id: "p2", name: "P Two" }] },
      // 伪渠道的 provider key 就是可见渠道名（没有 _ 前缀）：靠 relay URL 指纹识别。
      Anyswitch: {
        name: "Anyswitch",
        baseUrl: "http://127.0.0.1:47820/openai/auto/v1",
        apiKey: "relay-token",
        api: "openai-completions",
        models: [{ id: "auto" }],
      },
      "Anyswitch-corp": {
        baseUrl: "https://corp.example.com/v1",
        apiKey: "corp-secret",
        api: "openai-completions",
        models: [{ id: "corp-model" }],
      },
    },
  });
  const service = makeService(fixture);
  const scan = await service.scanLocalConfigs();
  assert.deepEqual(agentKeys(scan, "pi").sort(), ["pi::Anyswitch-corp", "pi::envmiss", "pi::lit"]);
  assert.equal(findEntry(scan, "pi", "envmiss").status, "unresolved-key");
  assert.equal(findEntry(scan, "pi", "lit").status, "ok");
  assert.equal(findEntry(scan, "pi", "Anyswitch-corp").status, "ok");
});

test("dsh: sidecar-only ownership (even _-prefixed user entries listed), profile dedup", async () => {
  const fixture = makeFixture();
  writeJson(join(fixture.storeRoot, "dsh-sidecar.json"), { providers: ["managed", "auto"] });
  const patch = (providers) => {
    const lines = ["- id: llm-pi-ai", '  name: "@deepseek-ai/dsh-llm-pi-ai"', "  config:", "    providers:"];
    for (const [id, p] of Object.entries(providers)) {
      lines.push(`      ${id}:`);
      lines.push(`        displayName: "${p.displayName}"`);
      lines.push(`        api: openai-completions`);
      lines.push(`        baseURL: "${p.baseURL}"`);
      if (p.apiKeyEnv) lines.push(`        apiKeyEnv: "${p.apiKeyEnv}"`);
      if (p.apiKey) lines.push(`        apiKey: "${p.apiKey}"`);
      lines.push(`        models:`);
      for (const m of p.models) lines.push(`          - id: "${m}"`);
    }
    return lines.join("\n") + "\n";
  };
  const shared = {
    _managed: { displayName: "Managed", baseURL: "http://127.0.0.1:47820/openai/managed/v1", apiKeyEnv: "ANYSWITCH_RELAY_TOKEN", models: ["m1"] },
    // The pseudo channel lives under its display-name key; the pre-rename
    // "_auto" key of a profile not yet re-synced is owned by the same id.
    Anyswitch: { displayName: "Anyswitch", baseURL: "http://127.0.0.1:47820/openai/auto/v1", apiKeyEnv: "ANYSWITCH_RELAY_TOKEN", models: ["auto"] },
    _auto: { displayName: "Anyswitch", baseURL: "http://127.0.0.1:47820/openai/auto/v1", apiKeyEnv: "ANYSWITCH_RELAY_TOKEN", models: ["auto"] },
    userchan: { displayName: "User Chan", baseURL: "https://user.example.com/v1", apiKeyEnv: "DSH_USER_KEY", models: ["um1"] },
  };
  writeText(join(fixture.homeDir, ".dsh", "profiles", "alpha", "cordis.patch.yml"), patch(shared));
  writeText(
    join(fixture.homeDir, ".dsh", "profiles", "beta", "cordis.patch.yml"),
    patch({
      ...shared,
      _userown: { displayName: "Own", baseURL: "https://own.example.com/v1", apiKey: "dsh-secret", models: ["om1"] },
    }),
  );
  const service = makeService(fixture, { env: { DSH_USER_KEY: "dsh-env-secret" } });
  const scan = await service.scanLocalConfigs();
  // userchan appears once (deduped across profiles); _managed, Anyswitch and the
  // legacy _auto key are sidecar-owned; _userown is a `_`-prefixed USER entry
  // dsh never auto-owns → a candidate.
  assert.deepEqual(agentKeys(scan, "dsh").sort(), ["dsh::_userown", "dsh::userchan"]);
  assert.equal(findEntry(scan, "dsh", "userchan").status, "ok");
  assert.equal(findEntry(scan, "dsh", "_userown").status, "ok");
});

test("qoder: qoder-custom-anyswitch-<hash> excluded, user connection listed", async () => {
  const fixture = makeFixture();
  writeJson(join(fixture.homeDir, ".qoder", "settings.json"), {
    providers: {
      "qoder-custom-anyswitch-0123456789abcdef": { baseUrl: "http://127.0.0.1:47820/openai/qoder~mg/v1", apiKey: "k", models: [] },
      "qoder-custom-mine": {
        baseUrl: "https://q.example.com/v1",
        apiKey: "q-secret",
        displayName: "My Qoder",
        models: [{ model: "qm1", displayName: "QM One" }],
      },
    },
  });
  const service = makeService(fixture);
  const scan = await service.scanLocalConfigs();
  assert.deepEqual(agentKeys(scan, "qoder"), ["qoder::qoder-custom-mine"]);
  const entry = findEntry(scan, "qoder", "qoder-custom-mine");
  assert.equal(entry.displayName, "My Qoder");
  assert.equal(entry.modelCount, 1);
  assert.equal(entry.status, "ok");
});

test("grok: one [model.x] table = one candidate, managed and [models] excluded", async () => {
  const fixture = makeFixture();
  writeText(
    join(fixture.homeDir, ".grok", "config.toml"),
    `${GROK_BEGIN}
[model."anyswitch-mg~m1"]
model = "m1"
base_url = "http://127.0.0.1:47820/openai/mg/v1"
api_key = "t"
${GROK_END}

[model."anyswitch-stray"]
model = "s"
base_url = "https://stray.example.com/v1"
api_key = "t"

[models]
default = "mychan"

[model.mychan]
model = "real-model"
name = "My Chan"
base_url = "https://grok.example.com/v1"
api_key = "grok-secret"
`,
  );
  const service = makeService(fixture);
  const scan = await service.scanLocalConfigs();
  assert.deepEqual(agentKeys(scan, "grok"), ["grok::mychan"]);
  const entry = findEntry(scan, "grok", "mychan");
  assert.equal(entry.modelCount, 1);
  assert.equal(entry.status, "ok");
});

test("workbuddy: one models.json entry = one candidate; workbuddy~ route and sidecar excluded", async () => {
  const fixture = makeFixture();
  writeJson(join(fixture.homeDir, ".workbuddy", "models.json"), {
    models: [
      {
        id: "mychan",
        name: "My Chan",
        url: "https://wb.example.com/v1/chat/completions",
        apiKey: "wb-secret",
        useCustomProtocol: true,
      },
      // 托管项：url 命中 workbuddy~ 段（与写入侧同一签名），不依赖 sidecar
      {
        id: "chan~m2",
        name: "m2 · 某渠道",
        url: "http://127.0.0.1:47820/openai/workbuddy~chan/v1/chat/completions",
        apiKey: "t",
      },
      // sidecar 列过的 id：即便 url 看着像用户条目也排除
      { id: "sidecar-named", name: "S", url: "https://s.example.com/v1/chat/completions", apiKey: "s" },
      { id: "no-url", name: "N" },
    ],
    // 顶层其它键不影响读取
    availableModels: ["mychan"],
  });
  writeJson(join(fixture.storeRoot, "workbuddy-sidecar.json"), { providers: ["sidecar-named"] });
  const service = makeService(fixture);
  const scan = await service.scanLocalConfigs();
  assert.deepEqual(agentKeys(scan, "workbuddy"), ["workbuddy::mychan"]);
  assert.equal(scan.groups.find((g) => g.agentId === "workbuddy")?.agentName, "WorkBuddy");
  const entry = findEntry(scan, "workbuddy", "mychan");
  assert.equal(entry.displayName, "My Chan");
  // 文件里存的是完整 /chat/completions 全路径，候选 base 去掉它（上游拼接时再加回）
  assert.equal(entry.baseURL, "https://wb.example.com/v1");
  assert.equal(entry.modelCount, 1);
  assert.equal(entry.status, "ok");
  assert.ok(!JSON.stringify(scan).includes("wb-secret"), "key 不进序列化输出");
});

test("workbuddy: bare-array models.json is read too (GUI 两种形状都认)", async () => {
  const fixture = makeFixture();
  writeJson(join(fixture.homeDir, ".workbuddy", "models.json"), [
    { id: "arr", name: "Arr", url: "https://arr.example.com/v1/chat/completions", apiKey: "a" },
  ]);
  const service = makeService(fixture);
  const scan = await service.scanLocalConfigs();
  assert.deepEqual(agentKeys(scan, "workbuddy"), ["workbuddy::arr"]);
  assert.equal(findEntry(scan, "workbuddy", "arr").baseURL, "https://arr.example.com/v1");
});

test("workbuddy: WORKBUDDY_CONFIG_DIR 改根后仍扫该根下的 models.json", async () => {
  const fixture = makeFixture();
  const configRoot = join(fixture.root, "wb-config");
  writeJson(join(configRoot, "models.json"), [
    { id: "rooted", name: "Rooted", url: "https://rooted.example.com/v1/chat/completions", apiKey: "r" },
  ]);
  const service = makeService(fixture, { env: { WORKBUDDY_CONFIG_DIR: configRoot } });
  const scan = await service.scanLocalConfigs();
  assert.deepEqual(agentKeys(scan, "workbuddy"), ["workbuddy::rooted"]);
  assert.equal(findEntry(scan, "workbuddy", "rooted").baseURL, "https://rooted.example.com/v1");
});

// ── shared pipeline ─────────────────────────────────────────────
test("empty scan: no endpoint configs → ticket null, no groups", async () => {
  const fixture = makeFixture();
  const service = makeService(fixture);
  const scan = await service.scanLocalConfigs();
  assert.deepEqual(scan, { ok: true, ticket: null, groups: [], scannedAt: new Date(1_000_000).toISOString() });
});

test("serialized scan entries never carry key material", async () => {
  const fixture = makeFixture();
  writeJson(join(fixture.homeDir, ".qoder", "settings.json"), {
    providers: { mine: { baseUrl: "https://q.example.com/v1", apiKey: "top-secret-value", models: [] } },
  });
  const service = makeService(fixture);
  const scan = await service.scanLocalConfigs();
  assert.ok(!JSON.stringify(scan).includes("top-secret-value"));
});

test("duplicate detection: baseURL and fallbackURLs compared normalized", async () => {
  const fixture = makeFixture();
  writeJson(join(fixture.storeRoot, "store.json"), {
    version: 2,
    providers: {
      existing: storeProvider("https://oc.example.com/v1"),
      withfallback: storeProvider("https://primary.example.com/v1", { fallbackURLs: ["https://cx.example.com/v1"] }),
    },
  });
  writeJson(join(fixture.homeDir, ".config", "opencode", "opencode.json"), {
    provider: { useroc: { options: { baseURL: "https://oc.example.com/v1/", apiKey: "k" } } },
  });
  writeText(
    join(fixture.homeDir, ".codex", "config.toml"),
    `[model_providers.usercx]
base_url = "cx.example.com/v1"
env_key = "CX_API_KEY"
`,
  );
  const service = makeService(fixture, { env: { CX_API_KEY: "s" } });
  const scan = await service.scanLocalConfigs();
  assert.equal(findEntry(scan, "opencode", "useroc").status, "duplicate");
  // bare host + fallback URL both normalize to https://cx.example.com/v1
  assert.equal(findEntry(scan, "codex", "usercx").status, "duplicate");
});

test("suggestedId: sanitization and collision suffixes", async () => {
  assert.equal(suggestBaseId("builtin:zai"), "builtin-zai");
  assert.equal(suggestBaseId("__lead"), "lead");
  assert.equal(suggestBaseId(":::"), "channel");
  assert.equal(suggestBaseId("a".repeat(200)).length, 128);

  const fixture = makeFixture();
  writeJson(join(fixture.storeRoot, "store.json"), {
    version: 2,
    providers: { mine: storeProvider("https://taken.example.com/v1") },
  });
  // Two same-named candidates (pi + qoder) both sanitize to "mine", which is
  // also taken in the store → "mine-2" and "mine-3".
  writeJson(join(fixture.homeDir, ".pi", "agent", "models.json"), {
    providers: { mine: { baseUrl: "https://pi.example.com/v1", apiKey: "k", models: [{ id: "p" }] } },
  });
  writeJson(join(fixture.homeDir, ".qoder", "settings.json"), {
    providers: { mine: { baseUrl: "https://q.example.com/v1", apiKey: "k", models: [] } },
  });
  const service = makeService(fixture);
  const scan = await service.scanLocalConfigs();
  const suggested = scan.groups.flatMap((g) => g.entries.map((e) => e.suggestedId)).sort();
  assert.deepEqual(suggested, ["mine-2", "mine-3"]);
});

// ── applyImport ─────────────────────────────────────────────────

function qoderFixture(fixture) {
  writeJson(join(fixture.homeDir, ".qoder", "settings.json"), {
    providers: {
      mine: {
        baseUrl: "https://q.example.com/v1",
        apiKey: "q-secret",
        displayName: "My Qoder",
        models: [{ model: "qm1", displayName: "QM One" }, { model: "qm2" }],
      },
    },
  });
}

test("apply success: store entry + credential written, no secret in store.json", async () => {
  const fixture = makeFixture();
  qoderFixture(fixture);
  const service = makeService(fixture);
  const scan = await service.scanLocalConfigs();
  const key = "qoder::mine";
  const applied = await service.applyImport({ ticket: scan.ticket, keys: [key], deleteLocal: false });
  assert.equal(applied.ok, true);
  assert.equal(applied.imported, 1);
  assert.deepEqual(applied.failed, []);
  assert.deepEqual(applied.removed, []);
  assert.equal(applied.backupDir, null);

  const store = JSON.parse(readFileSync(join(fixture.storeRoot, "store.json"), "utf8"));
  assert.ok(store.providers.mine);
  assert.equal(store.providers.mine.protocol, "openai-compatible");
  assert.equal(store.providers.mine.baseURL, "https://q.example.com/v1");
  assert.deepEqual(Object.keys(store.providers.mine.models), ["qm1", "qm2"]);
  assert.deepEqual(store.providers.mine.modelFilter, ["qm1", "qm2"]);
  assert.ok(!readFileSync(join(fixture.storeRoot, "store.json"), "utf8").includes("q-secret"));
  const credential = readFileSync(join(fixture.storeRoot, "credentials", "mine.dpapi"), "utf8");
  assert.equal(credential, "fake-cipher:mine:q-secret");
});

test("apply: ticket expired / unknown / reused", async () => {
  const fixture = makeFixture();
  qoderFixture(fixture);
  let nowValue = 1_000_000;
  const service = makeService(fixture, { now: () => nowValue });
  const scan = await service.scanLocalConfigs();
  nowValue += 16 * 60 * 1000; // past the default 15-minute TTL
  assert.deepEqual(await service.applyImport({ ticket: scan.ticket, keys: ["qoder::mine"], deleteLocal: false }), {
    ok: false,
    error: "ticket-expired",
  });
  assert.deepEqual(await service.applyImport({ ticket: "nope", keys: ["qoder::mine"], deleteLocal: false }), {
    ok: false,
    error: "ticket-expired",
  });
});

test("apply: unknown-selection for unknown, duplicated, or non-ok keys", async () => {
  const fixture = makeFixture();
  writeJson(join(fixture.homeDir, ".qoder", "settings.json"), {
    providers: {
      mine: { baseUrl: "https://q.example.com/v1", apiKey: "q-secret", models: [] },
      nokey: { baseUrl: "https://nk.example.com/v1", apiKey: "", models: [] },
    },
  });
  const service = makeService(fixture);
  const scan = await service.scanLocalConfigs();
  assert.equal((await service.applyImport({ ticket: scan.ticket, keys: ["qoder::ghost"], deleteLocal: false })).error, "unknown-selection");
  assert.equal((await service.applyImport({ ticket: scan.ticket, keys: ["qoder::mine", "qoder::mine"], deleteLocal: false })).error, "unknown-selection");
  assert.equal((await service.applyImport({ ticket: scan.ticket, keys: ["qoder::nokey"], deleteLocal: false })).error, "unknown-selection");
  assert.equal((await service.applyImport({ ticket: scan.ticket, keys: [], deleteLocal: false })).error, "unknown-selection");
});

test("apply: partial failure counts per entry, success still lands", async () => {
  const fixture = makeFixture();
  writeJson(join(fixture.homeDir, ".qoder", "settings.json"), {
    providers: {
      one: { baseUrl: "https://one.example.com/v1", apiKey: "s1", models: [] },
      two: { baseUrl: "https://two.example.com/v1", apiKey: "s2", models: [] },
    },
  });
  const service = makeService(fixture);
  const scan = await service.scanLocalConfigs();
  // "one" races into the store between scan and apply.
  writeJson(join(fixture.storeRoot, "store.json"), { version: 2, providers: { one: storeProvider("https://other.example.com/v1") } });
  const applied = await service.applyImport({ ticket: scan.ticket, keys: ["qoder::one", "qoder::two"], deleteLocal: false });
  assert.equal(applied.ok, true);
  assert.equal(applied.imported, 1);
  assert.equal(applied.failed.length, 1);
  assert.equal(applied.failed[0].key, "qoder::one");
  const store = JSON.parse(readFileSync(join(fixture.storeRoot, "store.json"), "utf8"));
  assert.ok(store.providers.two);
});

test("apply: store write failure rolls back the orphaned credential", async () => {
  const fixture = makeFixture();
  qoderFixture(fixture);
  const service = makeService(fixture, {
    writeStore: () => ({ ok: false, reason: "boom" }),
  });
  const scan = await service.scanLocalConfigs();
  const applied = await service.applyImport({ ticket: scan.ticket, keys: ["qoder::mine"], deleteLocal: false });
  assert.equal(applied.imported, 0);
  assert.deepEqual(applied.failed, [{ key: "qoder::mine", error: "boom" }]);
  assert.equal(existsSync(join(fixture.storeRoot, "credentials", "mine.dpapi")), false);
  assert.equal(existsSync(join(fixture.storeRoot, "store.json")), false);
});

test("apply deleteLocal: removeFn receives exactly the imported set", async () => {
  const fixture = makeFixture();
  writeJson(join(fixture.homeDir, ".qoder", "settings.json"), {
    providers: {
      one: { baseUrl: "https://one.example.com/v1", apiKey: "s1", models: [] },
      two: { baseUrl: "https://two.example.com/v1", apiKey: "s2", models: [] },
    },
  });
  let removeCalls = [];
  const removeFn = (entries, options) => {
    removeCalls.push({ entries, options });
    return {
      removed: [entries[0].key],
      failed: entries.slice(1).map((e) => ({ key: e.key, error: "locked" })),
      backupDir: join(fixture.storeRoot, "byok-import-backups", "run-1"),
    };
  };
  const service = makeService(fixture, { removeFn });
  const scan = await service.scanLocalConfigs();
  // Only "one" is selected; it imports, so removeFn sees exactly it.
  const applied = await service.applyImport({ ticket: scan.ticket, keys: ["qoder::one"], deleteLocal: true });
  assert.equal(applied.imported, 1);
  assert.equal(removeCalls.length, 1);
  assert.deepEqual(removeCalls[0].entries.map((e) => e.key), ["qoder::one"]);
  assert.equal(removeCalls[0].entries[0].agentId, "qoder");
  assert.equal(typeof removeCalls[0].entries[0].sourcePath, "string");
  assert.deepEqual(applied.removed, ["qoder::one"]);
  assert.deepEqual(applied.removeFailed, []);
  assert.equal(applied.backupDir, join(fixture.storeRoot, "byok-import-backups", "run-1"));
});

test("apply deleteLocal: failing import never reaches removeFn", async () => {
  const fixture = makeFixture();
  writeJson(join(fixture.homeDir, ".qoder", "settings.json"), {
    providers: {
      one: { baseUrl: "https://one.example.com/v1", apiKey: "s1", models: [] },
      two: { baseUrl: "https://two.example.com/v1", apiKey: "s2", models: [] },
    },
  });
  let removeCalls = [];
  const removeFn = (entries) => {
    removeCalls.push(entries);
    return { removed: entries.map((e) => e.key), failed: [], backupDir: null };
  };
  const service = makeService(fixture, { removeFn });
  const scan = await service.scanLocalConfigs();
  writeJson(join(fixture.storeRoot, "store.json"), { version: 2, providers: { one: storeProvider("https://other.example.com/v1") } });
  const applied = await service.applyImport({ ticket: scan.ticket, keys: ["qoder::one", "qoder::two"], deleteLocal: true });
  assert.equal(applied.imported, 1);
  assert.equal(applied.failed.length, 1);
  assert.deepEqual(removeCalls.map((c) => c.map((e) => e.key)), [["qoder::two"]]);
  assert.deepEqual(applied.removed, ["qoder::two"]);
});

test("apply deleteLocal false: removeFn is never called", async () => {
  const fixture = makeFixture();
  qoderFixture(fixture);
  const removeFn = () => {
    throw new Error("must not be called");
  };
  const service = makeService(fixture, { removeFn });
  const scan = await service.scanLocalConfigs();
  const applied = await service.applyImport({ ticket: scan.ticket, keys: ["qoder::mine"], deleteLocal: false });
  assert.equal(applied.imported, 1);
  assert.deepEqual(applied.removed, []);
  assert.deepEqual(applied.removeFailed, []);
});

test("apply: ticket is single-use after apply", async () => {
  const fixture = makeFixture();
  qoderFixture(fixture);
  const service = makeService(fixture);
  const scan = await service.scanLocalConfigs();
  await service.applyImport({ ticket: scan.ticket, keys: ["qoder::mine"], deleteLocal: false });
  const again = await service.applyImport({ ticket: scan.ticket, keys: ["qoder::mine"], deleteLocal: false });
  assert.deepEqual(again, { ok: false, error: "ticket-expired" });
});

test("dropTickets clears pending tickets", async () => {
  const fixture = makeFixture();
  qoderFixture(fixture);
  const service = makeService(fixture);
  const scan = await service.scanLocalConfigs();
  service.dropTickets();
  assert.deepEqual(await service.applyImport({ ticket: scan.ticket, keys: ["qoder::mine"], deleteLocal: false }), {
    ok: false,
    error: "ticket-expired",
  });
});
