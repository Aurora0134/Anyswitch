import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeImportedEntries, jsoncToJsonText } from "./byok-remove.mjs";
import { MANAGED_BEGIN as KIMI_BEGIN, MANAGED_END as KIMI_END } from "./kimi-merge-config.mjs";
import { MANAGED_BEGIN as GROK_BEGIN, MANAGED_END as GROK_END } from "./grok-merge-config.mjs";
import { getYamlModule, dshYamlSchema } from "./dsh-merge-config.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

// Fixed local-time stamp → deterministic backup directory name.
const NOW = new Date(2026, 9, 7, 12, 30, 15);
const STAMP_DIR = `byok-import-20261007-123015`;

function setup() {
  const dir = mkTestDir("byok-remove-");
  return { dir, backupRoot: join(dir, "backups") };
}

function entryOf(agentId, sourcePath, sourceId, baseURL) {
  return {
    key: `${agentId}::${sourceId}`,
    agentId,
    sourcePath,
    sourceId,
    displayName: sourceId,
    baseURL,
    models: [],
    keyPlaintext: null,
  };
}

function writeFixture(dir, name, text) {
  const filePath = join(dir, name);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, text, "utf8");
  return filePath;
}

// --- zcode -------------------------------------------------------------------

function zcodeFixtures(dir) {
  const zdir = join(dir, "zcode", "v2");
  mkdirSync(zdir, { recursive: true });
  const configPath = join(zdir, "config.json");
  const personalPath = join(zdir, "provider_config.json");
  const configJson = {
    provider: {
      mychan: {
        name: "My Channel",
        kind: "openai-compatible",
        options: { apiKey: "sk-user", baseURL: "https://api.example.com/v1" },
        models: {},
      },
      _managed: {
        name: "Managed",
        kind: "openai-compatible",
        options: { apiKey: "tok", baseURL: "http://127.0.0.1:47820/openai/managed/v1" },
        models: {},
      },
    },
    other: { keep: true },
  };
  writeFileSync(configPath, JSON.stringify(configJson, null, 2) + "\n");
  const personal = {
    schemaVersion: 1,
    config: {
      providerOrder: ["mychan", "_managed"],
      providerConfigRules: {
        providerRules: [
          {
            providerId: "mychan",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "sk-user" },
              api: { type: "openai-chat-completions", baseUrl: "https://api.example.com/v1" },
            },
          },
          {
            providerId: "_managed",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "tok" },
              api: {
                type: "openai-chat-completions",
                baseUrl: "http://127.0.0.1:47820/openai/managed/v1",
                headers: { "x-agent-id": "zcode" },
              },
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          { providerId: "mychan", modelId: "m1", config: { properties: { contextWindow: 128000 } } },
          { providerId: "_managed", modelId: "m2", config: { properties: { contextWindow: 64000 } } },
        ],
      },
    },
  };
  // ZCode's own byte shape: 2-space indent, no trailing newline.
  writeFileSync(personalPath, JSON.stringify(personal, null, 2));
  return { configPath, personalPath, configJson, personal };
}

test("zcode: config.json 与 provider_config.json 两处同删，托管条目与字节形状保持", async () => {
  const { dir, backupRoot } = setup();
  const { configPath, personalPath, configJson } = zcodeFixtures(dir);
  const before = readFileSync(configPath, "utf8");

  const result = await removeImportedEntries(
    [entryOf("zcode", configPath, "mychan", "https://api.example.com/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.removed, ["zcode::mychan"]);
  const backupDir = join(backupRoot, STAMP_DIR);
  assert.equal(result.backupDir, backupDir);

  const configAfterText = readFileSync(configPath, "utf8");
  assert.ok(configAfterText.endsWith("\n"), "config.json 保留尾换行");
  const configAfter = JSON.parse(configAfterText);
  assert.equal(configAfter.provider.mychan, undefined);
  assert.ok(configAfter.provider._managed, "托管渠道原样保留");
  assert.deepEqual(configAfter.other, { keep: true });

  const personalAfterText = readFileSync(personalPath, "utf8");
  assert.ok(!personalAfterText.endsWith("\n"), "provider_config.json 必须无尾换行（1 秒轮询教训）");
  const personalAfter = JSON.parse(personalAfterText);
  assert.deepEqual(
    personalAfter.config.providerConfigRules.providerRules.map((rule) => rule.providerId),
    ["_managed"],
  );
  assert.deepEqual(
    personalAfter.config.modelConfigRules.providerModelRules.map((rule) => rule.providerId),
    ["_managed"],
  );
  assert.deepEqual(personalAfter.config.providerOrder, ["mychan", "_managed"], "providerOrder 不动");

  const backups = readdirSync(join(backupDir, "zcode")).sort();
  assert.deepEqual(backups, ["config.json", "provider_config.json"]);
  assert.equal(readFileSync(join(backupDir, "zcode", "config.json"), "utf8"), before);
});

test("zcode: baseURL 被第三方改动 → 拒删，两份文件逐字节不动", async () => {
  const { dir, backupRoot } = setup();
  const { configPath, personalPath } = zcodeFixtures(dir);
  const configBefore = readFileSync(configPath, "utf8");
  const personalBefore = readFileSync(personalPath, "utf8");

  const result = await removeImportedEntries(
    [entryOf("zcode", configPath, "mychan", "https://changed-elsewhere.example/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.removed, []);
  assert.equal(result.failed.length, 1);
  assert.ok(result.failed[0].error.startsWith("identity-mismatch"), result.failed[0].error);
  assert.equal(readFileSync(configPath, "utf8"), configBefore);
  assert.equal(readFileSync(personalPath, "utf8"), personalBefore);
  assert.equal(result.backupDir, null, "没有任何文件被改动时不建备份目录");
});

test("zcode: 托管前缀 id 与 relay 指纹条目一律拒删", async () => {
  const { dir, backupRoot } = setup();
  const { configPath, personalPath } = zcodeFixtures(dir);
  // 非前缀 id 但 baseURL 指向本机 relay 的条目：指纹判定为托管，拒删。
  const configJson = JSON.parse(readFileSync(configPath, "utf8"));
  configJson.provider.relaycopy = {
    name: "Relay Copy",
    kind: "openai-compatible",
    options: { apiKey: "tok", baseURL: "http://127.0.0.1:47820/openai/mychan/v1" },
    models: {},
  };
  writeFileSync(configPath, JSON.stringify(configJson, null, 2) + "\n");
  const configBefore = readFileSync(configPath, "utf8");
  const personalBefore = readFileSync(personalPath, "utf8");

  const result = await removeImportedEntries(
    [
      entryOf("zcode", configPath, "_managed", "http://127.0.0.1:47820/openai/managed/v1"),
      entryOf("zcode", configPath, "relaycopy", "http://127.0.0.1:47820/openai/mychan/v1"),
    ],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.removed, []);
  assert.equal(result.failed.length, 2);
  assert.ok(result.failed.every((f) => f.error.startsWith("managed-entry")), JSON.stringify(result.failed));
  assert.equal(readFileSync(configPath, "utf8"), configBefore);
  assert.equal(readFileSync(personalPath, "utf8"), personalBefore);
});

test("kimi/pi: 伪渠道的 Anyswitch 显示名 id 同样是托管条目，拒删", async () => {
  const { dir, backupRoot } = setup();
  const kimiPath = writeFixture(
    dir,
    "kimi/config.toml",
    [
      '[providers."Anyswitch"]',
      'type = "openai"',
      'base_url = "http://127.0.0.1:47820/openai/auto/v1"',
      'api_key = "tok"',
      "",
    ].join("\n"),
  );
  const piPath = writeFixture(
    dir,
    "pi/models.json",
    JSON.stringify(
      {
        providers: {
          Anyswitch: {
            name: "Anyswitch",
            baseUrl: "http://127.0.0.1:47820/openai/auto/v1",
            apiKey: "tok",
            api: "openai-completions",
            models: [{ id: "auto" }],
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  const kimiBefore = readFileSync(kimiPath, "utf8");
  const piBefore = readFileSync(piPath, "utf8");

  const result = await removeImportedEntries(
    [
      entryOf("kimi", kimiPath, "Anyswitch", "http://127.0.0.1:47820/openai/auto/v1"),
      entryOf("pi", piPath, "Anyswitch", "http://127.0.0.1:47820/openai/auto/v1"),
    ],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.removed, []);
  assert.equal(result.failed.length, 2);
  assert.ok(result.failed.every((f) => f.error.startsWith("managed-entry")), JSON.stringify(result.failed));
  assert.equal(readFileSync(kimiPath, "utf8"), kimiBefore, "kimi 托管伪渠道逐字节不动");
  assert.equal(readFileSync(piPath, "utf8"), piBefore, "pi 托管伪渠道逐字节不动");
});

test("dsh: 伪渠道的 Anyswitch key 同样是托管条目，拒删", async () => {
  const { dir, backupRoot } = setup();
  const fixture = dshPatchFixture([
    "      Anyswitch:",
    "        displayName: Anyswitch",
    "        api: openai-completions",
    "        baseURL: http://127.0.0.1:47820/openai/auto/v1",
    "        models:",
    "          - id: auto",
    "            name: auto",
  ]);
  const filePath = writeFixture(dir, "dsh/profiles/dsh-tui/cordis.patch.yml", fixture);
  const before = readFileSync(filePath, "utf8");

  const result = await removeImportedEntries(
    [entryOf("dsh", filePath, "Anyswitch", "http://127.0.0.1:47820/openai/auto/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.removed, []);
  assert.equal(result.failed.length, 1);
  assert.ok(result.failed[0].error.startsWith("managed-entry"), JSON.stringify(result.failed));
  assert.equal(readFileSync(filePath, "utf8"), before, "dsh 托管伪渠道逐字节不动");
});

test("zcode: provider_config.json 缺失时只删 config.json", async () => {
  const { dir, backupRoot } = setup();
  const { configPath, personalPath } = zcodeFixtures(dir);
  writeFileSync(personalPath, "", "utf8");
  const { rmSync } = await import("node:fs");
  rmSync(personalPath, { force: true });

  const result = await removeImportedEntries(
    [entryOf("zcode", configPath, "mychan", "https://api.example.com/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.removed, ["zcode::mychan"]);
  const configAfter = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(configAfter.provider.mychan, undefined);
  assert.ok(configAfter.provider._managed);
  assert.equal(existsSync(personalPath), false, "不凭空创建 provider_config.json");
});

test("zcode: provider_config.json 损坏 → 整对拒写，config.json 也不动", async () => {
  const { dir, backupRoot } = setup();
  const { configPath, personalPath } = zcodeFixtures(dir);
  const configBefore = readFileSync(configPath, "utf8");
  writeFileSync(personalPath, "{ not json", "utf8");

  const result = await removeImportedEntries(
    [entryOf("zcode", configPath, "mychan", "https://api.example.com/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.removed, []);
  assert.equal(result.failed.length, 1);
  assert.ok(result.failed[0].error.startsWith("unparseable-source"), result.failed[0].error);
  assert.equal(readFileSync(configPath, "utf8"), configBefore, "先规划后写入：任一文件失败则全对不动");
});

// --- kimi --------------------------------------------------------------------

function kimiFixture() {
  return [
    "# 我自己的渠道",
    "[providers.foo]",
    'type = "openai"',
    'base_url = "https://foo.example/v1"',
    'api_key = "sk-foo"',
    "",
    '[models."foo/m1"]',
    'provider = "foo"',
    'model = "m1"',
    "max_context_size = 128000",
    "",
    '[models."foo/m2"]',
    'provider = "foo"',
    'model = "m2"',
    "",
    "# bar 渠道的说明注释",
    "[providers.bar]",
    'type = "openai"',
    'base_url = "https://bar.example/v1"',
    'api_key = "sk-bar"',
    "",
    '[models."bar/m3"]',
    'provider = "bar"',
    'model = "m3"',
    "",
    KIMI_BEGIN,
    '  # 块内注释也不许动',
    '[providers."_z"]',
    'type = "openai"',
    'base_url = "http://127.0.0.1:47820/openai/z/v1"',
    'api_key = "tok"',
    "",
    '[models."_z/m4"]',
    'provider = "_z"',
    'model = "m4"',
    KIMI_END,
    "",
    "# 序列化器重写残留（标记块外、托管前缀）",
    '[providers."_stale"]',
    'type = "openai"',
    'base_url = "http://127.0.0.1:47820/openai/stale/v1"',
    "",
  ].join("\n");
}

test("kimi: 删 [providers.<id>] 与全部 [models.\"<id>/*\"]，注释/托管块/无关表原样", async () => {
  const { dir, backupRoot } = setup();
  const filePath = writeFixture(dir, "kimi/config.toml", kimiFixture());
  const before = readFileSync(filePath, "utf8");

  const result = await removeImportedEntries(
    [entryOf("kimi", filePath, "foo", "https://foo.example/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.removed, ["kimi::foo"]);
  const after = readFileSync(filePath, "utf8");
  assert.ok(!after.includes("[providers.foo]"), "目标 provider 表已删");
  assert.ok(!after.includes('foo/m1') && !after.includes("foo/m2"), "目标 models 表已删");
  assert.ok(after.includes("# 我自己的渠道"), "前置注释保留");
  assert.ok(after.includes("# bar 渠道的说明注释"), "后续表的注释保留");
  assert.ok(after.includes("[providers.bar]") && after.includes('"bar/m3"'), "无关渠道原样");
  const block = before.slice(before.indexOf(KIMI_BEGIN), before.indexOf(KIMI_END) + KIMI_END.length);
  assert.ok(after.includes(block), "托管块逐字节保留");
  assert.ok(after.includes('[providers."_stale"]'), "块外托管前缀残留表不动");
  assert.equal(
    readFileSync(join(backupRoot, STAMP_DIR, "kimi", "config.toml"), "utf8"),
    before,
    "备份是改动前的逐字节副本",
  );
});

test("kimi: baseURL 不一致 → 拒删且文件逐字节不动", async () => {
  const { dir, backupRoot } = setup();
  const filePath = writeFixture(dir, "kimi/config.toml", kimiFixture());
  const before = readFileSync(filePath, "utf8");

  const result = await removeImportedEntries(
    [entryOf("kimi", filePath, "foo", "https://foo.example/v2")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.removed, []);
  assert.ok(result.failed[0].error.startsWith("identity-mismatch"), result.failed[0].error);
  assert.equal(readFileSync(filePath, "utf8"), before);
  assert.equal(result.backupDir, null);
});

test("kimi: 目标只存在于托管块内 → entry-not-found，整块逐字节不动", async () => {
  const { dir, backupRoot } = setup();
  const fixture = kimiFixture().replace(
    '[providers."_z"]',
    "[providers.ghost]\n" + 'base_url = "https://ghost.example/v1"' + "\n\n" + '[providers."_z"]',
  );
  const filePath = writeFixture(dir, "kimi/config.toml", fixture);
  const before = readFileSync(filePath, "utf8");

  const result = await removeImportedEntries(
    [entryOf("kimi", filePath, "ghost", "https://ghost.example/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.removed, []);
  assert.ok(result.failed[0].error.startsWith("entry-not-found"), result.failed[0].error);
  assert.equal(readFileSync(filePath, "utf8"), before);
});

test("kimi: 删空后文件仍是合法（空）TOML，文件本身保留", async () => {
  const { dir, backupRoot } = setup();
  const fixture = [
    "[providers.foo]",
    'base_url = "https://foo.example/v1"',
    'api_key = "sk-foo"',
    "",
    '[models."foo/m1"]',
    'provider = "foo"',
    'model = "m1"',
    "",
  ].join("\n");
  const filePath = writeFixture(dir, "kimi/config.toml", fixture);

  const result = await removeImportedEntries(
    [entryOf("kimi", filePath, "foo", "https://foo.example/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.failed, []);
  const after = readFileSync(filePath, "utf8");
  assert.equal(after.trim(), "", "全删后只剩空白");
  assert.equal(existsSync(filePath), true, "文件保留不删");
});

// --- codex -------------------------------------------------------------------

test("codex: 删 [model_providers.<id>] 及子表；选择键与目录指针不动；CRLF 保留", async () => {
  const { dir, backupRoot } = setup();
  const fixture = [
    'model_provider = "foo"',
    'model = "gpt-x"',
    'model_catalog_json = "model-catalogs/anyswitch-models.json"',
    "",
    "[model_providers.foo]",
    'name = "Foo"',
    'base_url = "https://foo.example/v1"',
    'wire_api = "responses"',
    "",
    "[model_providers.foo.http_headers]",
    'X-Custom = "1"',
    "",
    "# 另一个用户渠道",
    "[model_providers.bar]",
    'name = "Bar"',
    'base_url = "https://bar.example/v1"',
    "",
    "[model_providers.anyswitch-poke]",
    'name = "Poke"',
    'base_url = "http://127.0.0.1:47820/openai/poke/v1"',
    "",
    "[features]",
    "memories = false",
    "",
  ].join("\r\n");
  const filePath = writeFixture(dir, "codex/config.toml", fixture);

  const result = await removeImportedEntries(
    [entryOf("codex", filePath, "foo", "https://foo.example/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.failed, []);
  const after = readFileSync(filePath, "utf8");
  assert.ok(!after.includes("[model_providers.foo]"), "目标表已删");
  assert.ok(!after.includes("[model_providers.foo.http_headers]"), "子表随之删除");
  assert.ok(after.includes('model_provider = "foo"'), "顶层选择键不动（spec）");
  assert.ok(after.includes('model = "gpt-x"'), "顶层 model 键不动");
  assert.ok(after.includes('model_catalog_json = "model-catalogs/anyswitch-models.json"'), "目录指针不动");
  assert.ok(after.includes("[model_providers.bar]"), "无关渠道原样");
  assert.ok(after.includes("[model_providers.anyswitch-poke]"), "块外托管前缀表不动");
  assert.ok(after.includes("[features]"), "features 表不动");
  assert.ok(after.includes("# 另一个用户渠道"), "注释保留");
  assert.ok(after.includes('name = "Bar"\r\n'), "未删行保留 CRLF 行尾");
});

// --- opencode ------------------------------------------------------------------

function opencodeJsoncFixture() {
  return [
    "{",
    "  // 用户手写的渠道",
    '  "provider": {',
    '    "foo": {',
    '      "npm": "@ai-sdk/openai-compatible",',
    '      "options": {',
    '        "baseURL": "https://foo.example/v1",',
    '        "apiKey": "sk-foo", // foo 的行内注释',
    "      },",
    '      "models": { "m1": {} },',
    "    },",
    "    /* bar 的块注释 */",
    '    "bar": {',
    '      "options": { "baseURL": "https://bar.example/v1" },',
    "    },",
    "  },",
    '  "theme": "dark",',
    "}",
    "",
  ].join("\n");
}

test("opencode: opencode.jsonc 文本手术——删首成员，注释与尾逗号处理", async () => {
  const { dir, backupRoot } = setup();
  const filePath = writeFixture(dir, "opencode/opencode.jsonc", opencodeJsoncFixture());
  const before = readFileSync(filePath, "utf8");

  const result = await removeImportedEntries(
    [entryOf("opencode", filePath, "foo", "https://foo.example/v1/")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.failed, []);
  const after = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(jsoncToJsonText(after));
  assert.deepEqual(Object.keys(parsed.provider), ["bar"]);
  assert.equal(parsed.theme, "dark");
  assert.ok(after.includes("// 用户手写的渠道"), "行注释保留");
  assert.ok(after.includes("/* bar 的块注释 */"), "块注释保留");
  assert.ok(after.includes("// foo 的行内注释") === false, "被删条目内部的注释随条目移除");
  assert.equal(
    readFileSync(join(backupRoot, STAMP_DIR, "opencode", "opencode.jsonc"), "utf8"),
    before,
  );
});

// 与 opencodeJsoncFixture 的唯一差别：bar 作为 provider 的最后成员不带尾逗号。
// 只有"末成员无尾逗号"才迫使 splice 走"删前驱成员尾逗号"分支
// （byok-remove.mjs 中 target.commaAfter 为 null 的 else 路径）。
function opencodeJsoncLastMemberFixture() {
  return [
    "{",
    "  // 用户手写的渠道",
    '  "provider": {',
    '    "foo": {',
    '      "npm": "@ai-sdk/openai-compatible",',
    '      "options": {',
    '        "baseURL": "https://foo.example/v1",',
    '        "apiKey": "sk-foo", // foo 的行内注释',
    "      },",
    '      "models": { "m1": {} },',
    "    },",
    "    /* bar 的块注释 */",
    '    "bar": {',
    '      "options": { "baseURL": "https://bar.example/v1" },',
    "    }",
    "  },",
    '  "theme": "dark",',
    "}",
    "",
  ].join("\n");
}

test("opencode: 删最后一个成员时移除前导逗号", async () => {
  const { dir, backupRoot } = setup();
  const filePath = writeFixture(dir, "opencode/opencode.jsonc", opencodeJsoncLastMemberFixture());

  const result = await removeImportedEntries(
    [entryOf("opencode", filePath, "bar", "https://bar.example/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.failed, []);
  const after = readFileSync(filePath, "utf8");
  // jsoncToJsonText 会剥掉 } 前的悬空逗号，JSON.parse+Object.keys 对前导逗号
  // 是否被删完全不敏感，所以这里必须做字节级断言：foo 的收口大括号必须直接
  // 接换行+块注释（尾逗号已随末成员删除），不得残留悬空的前导逗号。
  assert.ok(after.includes("}\n    /* bar 的块注释 */"), "foo 的尾逗号已移除，块注释保留");
  assert.ok(!after.includes("},\n    /* bar 的块注释 */"), "不得残留悬空的前导逗号");
  const parsed = JSON.parse(jsoncToJsonText(after));
  assert.deepEqual(Object.keys(parsed.provider), ["foo"]);
  assert.equal(parsed.theme, "dark");
});

test("opencode: opencode.json 纯 JSON 删空 provider 后仍合法", async () => {
  const { dir, backupRoot } = setup();
  const filePath = writeFixture(
    dir,
    "opencode/opencode.json",
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        provider: {
          foo: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://foo.example/v1" }, models: {} },
        },
      },
      null,
      2,
    ) + "\n",
  );

  const result = await removeImportedEntries(
    [entryOf("opencode", filePath, "foo", "https://foo.example/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.failed, []);
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  assert.deepEqual(parsed.provider, {}, "删空后留空结构");
  assert.equal(parsed.$schema, "https://opencode.ai/config.json");
});

test("opencode: opencode.json 纯 JSON 删末成员时前驱的尾逗号必须随之移除", async () => {
  const { dir, backupRoot } = setup();
  // 纯 JSON 的末成员本就无尾逗号（JSON.stringify 产物），删它必然走前导逗号
  // 分支；悬空逗号会让 JSON 非法——实现若漏删，surgery 自检必须拒写而不是
  // 留下坏文件，所以这里的 removed 断言对分支缺失有区分度。
  const filePath = writeFixture(
    dir,
    "opencode/opencode.json",
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        provider: {
          foo: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://foo.example/v1" }, models: {} },
          bar: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://bar.example/v1" }, models: {} },
        },
      },
      null,
      2,
    ) + "\n",
  );

  const result = await removeImportedEntries(
    [entryOf("opencode", filePath, "bar", "https://bar.example/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.removed, ["opencode::bar"]);
  // 纯 JSON 无注释可兜底：严格 JSON.parse 通过即证明没有悬空逗号残留。
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  assert.deepEqual(Object.keys(parsed.provider), ["foo"]);
});

test("opencode: baseURL 不一致 → 拒删且文件逐字节不动", async () => {
  const { dir, backupRoot } = setup();
  const filePath = writeFixture(dir, "opencode/opencode.jsonc", opencodeJsoncFixture());
  const before = readFileSync(filePath, "utf8");

  const result = await removeImportedEntries(
    [entryOf("opencode", filePath, "foo", "https://foo.example/other")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.removed, []);
  assert.ok(result.failed[0].error.startsWith("identity-mismatch"), result.failed[0].error);
  assert.equal(readFileSync(filePath, "utf8"), before);
});

// --- pi ------------------------------------------------------------------------

test("pi: 删 providers.<id>，保持原文件缩进风格", async () => {
  const { dir, backupRoot } = setup();
  const fixture = [
    "{",
    '    "providers": {',
    '        "foo": {',
    '            "name": "Foo",',
    '            "baseUrl": "https://foo.example/v1",',
    '            "models": [',
    "                {",
    '                    "id": "m1"',
    "                }",
    "            ]",
    "        },",
    '        "_managed": {',
    '            "baseUrl": "http://127.0.0.1:47820/openai/poke/v1",',
    '            "models": []',
    "        }",
    "    }",
    "}",
    "",
  ].join("\n");
  const filePath = writeFixture(dir, "pi/models.json", fixture);

  const result = await removeImportedEntries(
    [entryOf("pi", filePath, "foo", "https://foo.example/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.failed, []);
  const after = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(after);
  assert.deepEqual(Object.keys(parsed.providers), ["_managed"]);
  assert.ok(after.includes('\n    "providers": {'), "缩进风格保持 4 空格");
  assert.ok(after.includes('\n        "_managed": {'), "嵌套层级缩进同风格");
  assert.ok(after.endsWith("\n"), "尾换行保持");
});

test("pi: 删空后 providers 留空映射，文件仍合法", async () => {
  const { dir, backupRoot } = setup();
  const filePath = writeFixture(
    dir,
    "pi/models.json",
    JSON.stringify({ providers: { foo: { baseUrl: "https://foo.example/v1", models: [] } } }, null, 2) + "\n",
  );

  const result = await removeImportedEntries(
    [entryOf("pi", filePath, "foo", "https://foo.example/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.failed, []);
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  assert.deepEqual(parsed.providers, {});
});

// --- dsh -----------------------------------------------------------------------

function dshPatchFixture(providers) {
  return [
    "# 界面插件补丁（用户手改）",
    "- id: tool-bash",
    '  name: "@deepseek-ai/tool-bash"',
    "  config:",
    "    disabled: !!js process.platform === 'win32'",
    "- id: llm-pi-ai",
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    "  config:",
    "    providers:",
    ...providers,
    "",
  ].join("\n");
}

const DSH_MYPROV_BLOCK = [
  "      # 我自己加的渠道",
  "      myprov:",
  "        displayName: My Prov",
  "        api: openai-completions",
  "        baseURL: https://api.example.com/v1",
  "        models:",
  "          - id: m1",
  "            name: Model 1",
];
const DSH_MANAGED_BLOCK = [
  "      _managed:",
  "        displayName: Managed",
  "        api: openai-completions",
  "        baseURL: http://127.0.0.1:47820/openai/poke/v1",
  "        models:",
  "          - id: m2",
];

test("dsh: 删 llm-pi-ai 行的目标 provider，!!js 与其它行逐字节保留", async () => {
  const yaml = await getYamlModule();
  const { dir, backupRoot } = setup();
  const fixture = dshPatchFixture([...DSH_MYPROV_BLOCK, ...DSH_MANAGED_BLOCK]);
  const filePath = writeFixture(dir, "dsh/profiles/dsh-tui/cordis.patch.yml", fixture);
  const before = readFileSync(filePath, "utf8");

  const result = await removeImportedEntries(
    [entryOf("dsh", filePath, "myprov", "https://api.example.com/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.removed, ["dsh::myprov"]);
  const after = readFileSync(filePath, "utf8");
  const rowPrefix = before.slice(0, before.indexOf("- id: llm-pi-ai"));
  assert.ok(after.startsWith(rowPrefix), "llm-pi-ai 行之前逐字节不动（含 !!js 行）");
  assert.ok(after.includes("!!js process.platform === 'win32'"), "!!js 标签表达式原样保留");
  const parsed = yaml.load(after, { schema: dshYamlSchema(yaml) });
  const row = parsed.find((item) => item.id === "llm-pi-ai");
  assert.deepEqual(Object.keys(row.config.providers), ["_managed"]);
  assert.ok(after.includes("# 我自己加的渠道"), "块上注释保留");
  assert.equal(
    readFileSync(join(backupRoot, STAMP_DIR, "dsh", "cordis.patch.yml"), "utf8"),
    before,
  );
});

test("dsh: 解析不过的 patch 拒删且逐字节不动", async () => {
  const { dir, backupRoot } = setup();
  const fixture = "- id: llm-pi-ai\n  config: [unclosed\n";
  const filePath = writeFixture(dir, "dsh/profiles/web/cordis.patch.yml", fixture);
  const before = readFileSync(filePath, "utf8");

  const result = await removeImportedEntries(
    [entryOf("dsh", filePath, "myprov", "https://api.example.com/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.removed, []);
  assert.ok(result.failed[0].error.startsWith("unparseable-source"), result.failed[0].error);
  assert.equal(readFileSync(filePath, "utf8"), before);
  assert.equal(result.backupDir, null);
});

test("dsh: 删空 providers 写成显式空映射，文件仍合法", async () => {
  const yaml = await getYamlModule();
  const { dir, backupRoot } = setup();
  const fixture = dshPatchFixture(DSH_MYPROV_BLOCK);
  const filePath = writeFixture(dir, "dsh/profiles/web/cordis.patch.yml", fixture);

  const result = await removeImportedEntries(
    [entryOf("dsh", filePath, "myprov", "https://api.example.com/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.failed, []);
  const after = readFileSync(filePath, "utf8");
  assert.ok(after.includes("providers: {}"), "空 providers 显式为 {} 而非 null");
  const parsed = yaml.load(after, { schema: dshYamlSchema(yaml) });
  const row = parsed.find((item) => item.id === "llm-pi-ai");
  assert.deepEqual(row.config.providers, {});
});

test("dsh: 多 profile 同名文件分别删除、备份不互覆", async () => {
  const yaml = await getYamlModule();
  const { dir, backupRoot } = setup();
  const fixtureA = dshPatchFixture([...DSH_MYPROV_BLOCK, ...DSH_MANAGED_BLOCK]);
  const fixtureB = dshPatchFixture([
    ...DSH_MYPROV_BLOCK,
    "      other:",
    "        displayName: Other",
    "        baseURL: https://other.example/v1",
    "        models:",
    "          - id: m9",
  ]);
  const pathA = writeFixture(dir, "dsh/profiles/web/cordis.patch.yml", fixtureA);
  const pathB = writeFixture(dir, "dsh/profiles/headless/cordis.patch.yml", fixtureB);

  const result = await removeImportedEntries(
    [
      entryOf("dsh", pathA, "myprov", "https://api.example.com/v1"),
      entryOf("dsh", pathB, "myprov", "https://api.example.com/v1"),
    ],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.removed, ["dsh::myprov", "dsh::myprov"]);
  for (const path of [pathA, pathB]) {
    const parsed = yaml.load(readFileSync(path, "utf8"), { schema: dshYamlSchema(yaml) });
    const row = parsed.find((item) => item.id === "llm-pi-ai");
    assert.equal(row.config.providers.myprov, undefined);
  }
  const backups = readdirSync(join(backupRoot, STAMP_DIR, "dsh")).sort();
  assert.equal(backups.length, 2, "两个 profile 的同名 patch 各有备份");
  assert.ok(backups.includes("cordis.patch.yml"));
  assert.ok(backups.some((name) => name !== "cordis.patch.yml" && name.includes("cordis.patch.yml")));
});

// --- qoder ---------------------------------------------------------------------

test("qoder: 删 settings.json 的 providers.<connectionId>，其余原样", async () => {
  const { dir, backupRoot } = setup();
  const settings = {
    providers: {
      "conn-user": {
        baseUrl: "https://foo.example/v1",
        apiKey: "sk-user",
        type: "openai-compatible",
        models: [{ model: "m1", displayName: "M1" }],
      },
      "qoder-custom-anyswitch-0123456789abcdef": {
        baseUrl: "http://127.0.0.1:47820/openai/qoder~poke/v1",
        apiKey: "tok",
        models: [],
      },
    },
    modelConfigs: { other: true },
  };
  const filePath = writeFixture(dir, "qoder/settings.json", JSON.stringify(settings, null, 2) + "\n");

  const result = await removeImportedEntries(
    // 归一化比对：条目带尾斜杠、文件不带，视为一致
    [entryOf("qoder", filePath, "conn-user", "https://foo.example/v1/")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.failed, []);
  const afterText = readFileSync(filePath, "utf8");
  assert.ok(afterText.endsWith("\n"));
  const after = JSON.parse(afterText);
  assert.deepEqual(Object.keys(after.providers), ["qoder-custom-anyswitch-0123456789abcdef"]);
  assert.deepEqual(after.modelConfigs, { other: true });
});

// --- grok ----------------------------------------------------------------------

test("grok: 删块外 [model.<name>] 及其子表；[models] 复数表永不碰", async () => {
  const { dir, backupRoot } = setup();
  const fixture = [
    "# 我的 grok 模型",
    '[model."foo"]',
    'model = "m1"',
    'name = "Foo M1"',
    'base_url = "https://foo.example/v1"',
    'api_key = "sk-foo"',
    "",
    '[[model."foo".reasoning_efforts]]',
    'value = "high"',
    'label = "High"',
    "",
    '[model."anyswitch-poke~m2"]',
    'model = "m2"',
    'base_url = "http://127.0.0.1:47820/openai/poke/v1"',
    "",
    "[models]",
    'default = "foo"',
    "web_search = true",
    "",
    GROK_BEGIN,
    '[model."anyswitch-z~m3"]',
    'model = "m3"',
    'base_url = "http://127.0.0.1:47820/openai/z/v1"',
    GROK_END,
    "",
  ].join("\n");
  const filePath = writeFixture(dir, "grok/config.toml", fixture);
  const before = readFileSync(filePath, "utf8");

  const result = await removeImportedEntries(
    [entryOf("grok", filePath, "foo", "https://foo.example/v1")],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.failed, []);
  const after = readFileSync(filePath, "utf8");
  assert.ok(!after.includes('[model."foo"]'), "目标模型表已删");
  assert.ok(!after.includes("reasoning_efforts"), "子表随之删除");
  assert.ok(after.includes("[models]"), "[models] 复数表保留");
  assert.ok(after.includes('default = "foo"'), "[models] 内的 default 键不动");
  assert.ok(after.includes("web_search = true"), "[models] 内的其它键不动");
  assert.ok(after.includes('[model."anyswitch-poke~m2"]'), "块外托管前缀表不动");
  const block = before.slice(before.indexOf(GROK_BEGIN), before.indexOf(GROK_END) + GROK_END.length);
  assert.ok(after.includes(block), "托管块逐字节保留");
  assert.ok(after.includes("# 我的 grok 模型"), "注释保留");
});

// --- workbuddy -----------------------------------------------------------------

test("workbuddy: 只摘目标数组项，顶层键与其它条目原样；workbuddy~ 托管 url 拒删", async () => {
  const { dir, backupRoot } = setup();
  const fixture = {
    models: [
      {
        id: "mine",
        name: "My Chan",
        url: "https://wb.example.com/v1/chat/completions",
        apiKey: "sk-mine",
      },
      {
        id: "chan~m2",
        name: "m2 · 某渠道",
        url: "http://127.0.0.1:47820/openai/workbuddy~chan/v1/chat/completions",
        apiKey: "t",
      },
    ],
    availableModels: ["mine"],
    unknownTopLevel: { keep: true },
  };
  const filePath = writeFixture(dir, "workbuddy/models.json", JSON.stringify(fixture, null, 2) + "\n");

  const result = await removeImportedEntries(
    // 票据里的 baseURL 是扫描侧报的「url 去掉 /chat/completions」，身份比对同口径
    [entryOf("workbuddy", filePath, "mine", "https://wb.example.com/v1")],
    { backupRoot, now: NOW },
  );
  assert.deepEqual(result.failed, []);
  const text = readFileSync(filePath, "utf8");
  const after = JSON.parse(text);
  assert.deepEqual(after.models.map((n) => n.id), ["chan~m2"], "只摘掉目标条目");
  assert.deepEqual(after.availableModels, ["mine"], "顶层键原样保留");
  assert.deepEqual(after.unknownTopLevel, { keep: true }, "未知顶层键不动");
  assert.ok(text.endsWith("\n"), "沿用文件自身的尾换行");

  // 托管项：url 命中 workbuddy~ 段 → 即便票据伪造也拒删
  const managed = await removeImportedEntries(
    [entryOf("workbuddy", filePath, "chan~m2", "http://127.0.0.1:47820/openai/workbuddy~chan/v1")],
    { backupRoot, now: NOW },
  );
  assert.equal(managed.removed.length, 0);
  assert.ok(managed.failed[0].error.startsWith("managed-entry"), managed.failed[0].error);
  assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")).models.map((n) => n.id), ["chan~m2"],
    "托管条目原样保留");
});

test("workbuddy: 裸数组形状按数组还原；坏 JSON 不动文件", async () => {
  const { dir, backupRoot } = setup();
  const filePath = writeFixture(
    dir,
    "workbuddy/array/models.json",
    JSON.stringify([{ id: "a", url: "https://a.example.com/v1/chat/completions" }, { id: "b", url: "https://b.example.com/v1/chat/completions" }], null, 2),
  );
  const result = await removeImportedEntries(
    [entryOf("workbuddy", filePath, "a", "https://a.example.com/v1")],
    { backupRoot, now: NOW },
  );
  assert.deepEqual(result.failed, []);
  const after = JSON.parse(readFileSync(filePath, "utf8"));
  assert.ok(Array.isArray(after), "仍按数组形状写回");
  assert.deepEqual(after.map((n) => n.id), ["b"]);

  const broken = writeFixture(dir, "workbuddy/broken/models.json", "{ not json");
  const refused = await removeImportedEntries(
    [entryOf("workbuddy", broken, "x", "https://x.example.com/v1/chat/completions")],
    { backupRoot, now: NOW },
  );
  assert.ok(refused.failed[0].error.startsWith("unparseable-source"));
  assert.equal(readFileSync(broken, "utf8"), "{ not json", "坏文件逐字节不动");
});

// --- 通用行为 ------------------------------------------------------------------

test("通用: 同文件多条目只备一次、逐条独立成败", async () => {
  const { dir, backupRoot } = setup();
  const filePath = writeFixture(dir, "kimi/config.toml", kimiFixture());
  const before = readFileSync(filePath, "utf8");

  const result = await removeImportedEntries(
    [
      entryOf("kimi", filePath, "foo", "https://foo.example/v1"),
      entryOf("kimi", filePath, "bar", "https://WRONG.example/v1"),
    ],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.removed, ["kimi::foo"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].key, "kimi::bar");
  assert.ok(result.failed[0].error.startsWith("identity-mismatch"));
  const backups = readdirSync(join(backupRoot, STAMP_DIR, "kimi"));
  assert.deepEqual(backups, ["config.toml"], "同一文件一次调用只备一份（改动前字节）");
  assert.equal(readFileSync(join(backupRoot, STAMP_DIR, "kimi", "config.toml"), "utf8"), before);
  const after = readFileSync(filePath, "utf8");
  assert.ok(!after.includes("[providers.foo]"));
  assert.ok(after.includes("[providers.bar]"), "失败的条目原样保留");
});

test("通用: 未知端点 / 源文件缺失 / 非法条目各自 failed，互不影响", async () => {
  const { dir, backupRoot } = setup();
  const filePath = writeFixture(dir, "kimi/config.toml", kimiFixture());

  const result = await removeImportedEntries(
    [
      entryOf("claude", filePath, "foo", "https://foo.example/v1"),
      entryOf("kimi", join(dir, "kimi/absent.toml"), "foo", "https://foo.example/v1"),
      { key: "kimi::no-url", agentId: "kimi", sourcePath: filePath, sourceId: "foo" },
      entryOf("kimi", filePath, "foo", "https://foo.example/v1"),
    ],
    { backupRoot, now: NOW },
  );

  assert.deepEqual(result.removed, ["kimi::foo"]);
  assert.equal(result.failed.length, 3);
  assert.ok(result.failed[0].error.startsWith("unknown-agent"), result.failed[0].error);
  assert.ok(result.failed[1].error.startsWith("entry-not-found"), result.failed[1].error);
  assert.ok(result.failed[2].error.startsWith("invalid-entry"), result.failed[2].error);
});
