import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCodexManagedToml,
  mergeCodexConfigToml,
  stripManagedBlock,
  stripManagedTables,
  writeCodexConfigTomlWithBackup,
  writeCodexConfig,
  extractManagedProviders,
  deriveAutoRouteChannel,
  readSidecar,
  writeSidecar,
  sidecarPath,
  codexConfigPath,
  managedProviderId,
  loadCodexCatalogTemplate,
  collectCodexCatalogModels,
  buildCodexModelCatalog,
  CATALOG_POINTER_VALUE,
  MANAGED_BEGIN,
  MANAGED_END,
} from "./codex-merge-config.mjs";

const CATALOG_TEMPLATE = loadCodexCatalogTemplate();

const STORE = {
  version: 2,
  providers: {
    "poke-api": {
      displayName: "Poke API",
      baseURL: "https://poke.example/v1",
      protocol: "openai-compatible",
      credentialFile: "poke-api.dpapi",
      models: {
        "gpt-6-astra": { displayName: "GPT 6 Astra", contextWindow: 200000 },
      },
    },
  },
};

const CHAIN_STORE = {
  ...STORE,
  routingChains: {
    codex: { chain: [{ node: "poke-api", model: "gpt-6-astra" }] },
  },
};

describe("codex-merge-config", () => {
  it("builds one responses provider table per channel with literal auth headers", () => {
    const providers = extractManagedProviders(STORE);
    const { text, managed } = buildCodexManagedToml(providers, 47821, "tok");
    assert.deepEqual(managed, ["poke-api"]);
    assert.match(text, /\[model_providers\."anyswitch-poke-api"\]/);
    assert.match(text, /name = "Poke API"/);
    assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:47821\/openai\/poke-api\/v1"/);
    assert.match(text, /wire_api = "responses"/);
    assert.match(text, /http_headers = \{ "Authorization" = "Bearer tok", "x-agent-id" = "codex" \}/);
    assert.match(text, /env_http_headers = \{ "x-agent-instance" = "ANYSWITCH_INSTANCE_ID" \}/);
    // 刻意不写的键：env_key（GUI 拿不到 env）、supports_websockets（保持默认 false）。
    assert.doesNotMatch(text, /env_key/);
    assert.doesNotMatch(text, /supports_websockets/);
    assert.doesNotMatch(text, /\[profiles\]/);
  });

  it("preserves foreign sections verbatim and replaces a previous managed block", () => {
    const existing = [
      'model = "gpt-6-astra"',
      "",
      "[desktop]",
      'theme = "dark"',
      "",
      "[mcp_servers.fs]",
      'command = "npx"',
      "",
      MANAGED_BEGIN,
      '[model_providers."anyswitch-old"]',
      'base_url = "http://127.0.0.1:47821/openai/old/v1"',
      MANAGED_END,
      "",
    ].join("\n");
    const { text } = mergeCodexConfigToml(existing, extractManagedProviders(STORE), 47821, "tok");
    assert.match(text, /\[desktop\]/);
    assert.match(text, /theme = "dark"/);
    assert.match(text, /\[mcp_servers\.fs\]/);
    assert.doesNotMatch(text, /anyswitch-old/);
    assert.match(text, /\[model_providers\."anyswitch-poke-api"\]/);
    // Foreign sections stay in front; the managed block is always appended last.
    assert.ok(text.indexOf("[desktop]") < text.indexOf(MANAGED_BEGIN));
    assert.equal(text.trimEnd().endsWith(MANAGED_END), true);
  });

  it("is idempotent: merging the merged output changes nothing", () => {
    const once = mergeCodexConfigToml("", extractManagedProviders(CHAIN_STORE), 47821, "tok", deriveAutoRouteChannel(CHAIN_STORE, "codex"));
    const twice = mergeCodexConfigToml(once.text, extractManagedProviders(CHAIN_STORE), 47821, "tok", deriveAutoRouteChannel(CHAIN_STORE, "codex"));
    assert.equal(twice.text, once.text);
  });

  it("refuses a truncated managed block", () => {
    assert.throws(
      () => stripManagedBlock(`${MANAGED_BEGIN}\n[model_providers."anyswitch-x"]\n`),
      (err) => err.code === "UNPARSEABLE_CODEX_CONFIG",
    );
  });

  it("strips unmarked anyswitch tables left by a desktop-app rewrite", () => {
    // The desktop app re-serializes config.toml itself, dropping the managed
    // markers and expanding inline tables into sub-tables. Without the prefix
    // strip the next merge would append duplicate table declarations and codex
    // would reject the whole file.
    const rewritten = [
      'model_provider = "anyswitch-poke-api"',
      "",
      "[desktop]",
      'theme = "dark"',
      "",
      "[model_providers.anyswitch-poke-api]",
      'name = "Poke API"',
      'base_url = "http://127.0.0.1:47821/openai/poke-api/v1"',
      'wire_api = "responses"',
      "",
      "[model_providers.anyswitch-poke-api.http_headers]",
      'Authorization = "Bearer old-tok"',
      "",
    ].join("\n");
    const { text } = mergeCodexConfigToml(rewritten, extractManagedProviders(STORE), 47821, "tok");
    assert.match(text, /\[desktop\]/);
    const providerHeaders = text.match(/^\[model_providers\..*\]/gm) ?? [];
    assert.deepEqual(providerHeaders, ['[model_providers."anyswitch-poke-api"]']);
    assert.match(text, /Bearer tok/);
    assert.doesNotMatch(text, /old-tok/);
    // The surviving selector already points at a current managed id: untouched.
    assert.match(text, /model_provider = "anyswitch-poke-api"/);
  });

  it("migrates the legacy manual config: drops openai_base_url, re-anchors model_provider", () => {
    const legacy = [
      'model_provider = "openai"',
      'openai_base_url = "http://127.0.0.1:47821"',
      'model = "gpt-6-astra"',
      "",
    ].join("\n");
    const { text } = mergeCodexConfigToml(legacy, extractManagedProviders(STORE), 47821, "tok");
    assert.doesNotMatch(text, /openai_base_url/);
    assert.match(text, /^model_provider = "anyswitch-poke-api"$/m);
    assert.match(text, /model = "gpt-6-astra"/);
  });

  it("drops a stale managed selector and a dangling selector onto the auto channel", () => {
    const stale = 'model_provider = "anyswitch-gone" # 我选的\n';
    const { text: staleOut } = mergeCodexConfigToml(
      stale,
      extractManagedProviders(CHAIN_STORE),
      47821,
      "tok",
      deriveAutoRouteChannel(CHAIN_STORE, "codex"),
    );
    assert.match(staleOut, /^model_provider = "anyswitch-auto" # 我选的$/m);
    assert.doesNotMatch(staleOut, /anyswitch-gone/);

    const dangling = 'model_provider = "no-such-provider"\n';
    const { text: danglingOut } = mergeCodexConfigToml(dangling, extractManagedProviders(STORE), 47821, "tok");
    assert.match(danglingOut, /^model_provider = "anyswitch-poke-api"$/m);
  });

  it("leaves a user's own provider selection and other built-ins alone", () => {
    const existing = [
      'model_provider = "my-corp"',
      "",
      "[model_providers.my-corp]",
      'name = "Corp"',
      'base_url = "https://corp.example/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n");
    const { text } = mergeCodexConfigToml(existing, extractManagedProviders(STORE), 47821, "tok");
    assert.match(text, /^model_provider = "my-corp"$/m);
    assert.match(text, /\[model_providers\.my-corp\]/);

    const builtin = 'model_provider = "ollama"\n';
    const { text: builtinOut } = mergeCodexConfigToml(builtin, extractManagedProviders(STORE), 47821, "tok");
    assert.match(builtinOut, /^model_provider = "ollama"$/m);

    const absent = 'model = "gpt-6-astra"\n';
    const { text: absentOut } = mergeCodexConfigToml(absent, extractManagedProviders(STORE), 47821, "tok");
    assert.doesNotMatch(absentOut, /^model_provider/m);
  });
});

describe("[features] memories gate", () => {
  it("declares the gate inside the managed block when the user has no [features] table", () => {
    const { text, memoriesGate } = mergeCodexConfigToml("", extractManagedProviders(STORE), 47821, "tok");
    assert.equal(memoriesGate, "managed-block");
    assert.match(text, /\[features\]\nmemories = false/);
    // The declaration sits between the markers, after the provider tables.
    assert.ok(text.indexOf("[features]") > text.indexOf(MANAGED_BEGIN));
    assert.ok(text.indexOf("[features]") < text.indexOf(MANAGED_END));
  });

  it("appends the key to a user's [features] table and keeps the block silent on [features]", () => {
    const existing = ["[features]", 'notify = true', ""].join("\n");
    const { text, memoriesGate } = mergeCodexConfigToml(existing, extractManagedProviders(STORE), 47821, "tok");
    assert.equal(memoriesGate, "absorbed");
    assert.match(text, /\[features\]\nmemories = false\nnotify = true/);
    // Exactly one [features] declaration across the whole file — a duplicate
    // table would break TOML parsing.
    assert.equal(text.split("[features]").length - 1, 1);
    const block = text.slice(text.indexOf(MANAGED_BEGIN));
    assert.doesNotMatch(block, /\[features\]/);
  });

  it("presses a user-written memories = true back to false, keeping the comment", () => {
    const existing = ["[features]", "memories = true # 我开的", 'notify = true', ""].join("\n");
    const { text, memoriesGate } = mergeCodexConfigToml(existing, extractManagedProviders(STORE), 47821, "tok");
    assert.equal(memoriesGate, "absorbed");
    assert.match(text, /^memories = false # 我开的$/m);
    assert.equal(text.split("memories").length - 1, 1, "no duplicate key");
  });

  it("restores the key when the user hand-deleted it", () => {
    const once = mergeCodexConfigToml("[features]\n", extractManagedProviders(STORE), 47821, "tok");
    const userDeleted = once.text.replace(/^memories = false\n/m, "");
    const twice = mergeCodexConfigToml(userDeleted, extractManagedProviders(STORE), 47821, "tok");
    assert.equal(twice.memoriesGate, "absorbed");
    assert.match(twice.text, /\[features\]\nmemories = false/);
    assert.equal(twice.text.split("[features]").length - 1, 1);
  });

  it("never touches the other keys in the user's table, including sub-tables", () => {
    const existing = [
      "[features]",
      'notify = true',
      "",
      "[features.experimental]",
      "enabled = true",
      "",
    ].join("\n");
    const { text } = mergeCodexConfigToml(existing, extractManagedProviders(STORE), 47821, "tok");
    // The gate lands before the sub-table header, inside the parent table.
    assert.ok(text.indexOf("memories = false") < text.indexOf("[features.experimental]"));
    assert.match(text, /\[features\.experimental\]\nenabled = true/);
    assert.equal(text.split("[features]").length - 1, 1);
  });

  it("is idempotent on both paths and keeps foreign sections untouched", () => {
    const foreign = ['model = "gpt-6-astra"', "", "[desktop]", 'theme = "dark"', ""].join("\n");
    const onceBlock = mergeCodexConfigToml(foreign, extractManagedProviders(STORE), 47821, "tok");
    const twiceBlock = mergeCodexConfigToml(onceBlock.text, extractManagedProviders(STORE), 47821, "tok");
    assert.equal(twiceBlock.text, onceBlock.text);

    const userTable = ["[features]", 'notify = true', ""].join("\n");
    const onceAbsorbed = mergeCodexConfigToml(userTable, extractManagedProviders(STORE), 47821, "tok");
    const twiceAbsorbed = mergeCodexConfigToml(onceAbsorbed.text, extractManagedProviders(STORE), 47821, "tok");
    assert.equal(twiceAbsorbed.text, onceAbsorbed.text);

    assert.match(twiceAbsorbed.text, /\[features\]\nmemories = false\nnotify = true/);
    assert.match(onceBlock.text, /\[desktop\]\ntheme = "dark"/);
  });

  it("survives a desktop-app rewrite that dropped the markers (orphan [features] is absorbed, not duplicated)", () => {
    // Same disease as the provider-table strip: a markerless leftover of our
    // own managed [features] must not cause a second declaration.
    const rewritten = [
      "[features]",
      "memories = false",
      "",
      "[desktop]",
      'theme = "dark"',
      "",
    ].join("\n");
    const { text } = mergeCodexConfigToml(rewritten, extractManagedProviders(STORE), 47821, "tok");
    assert.equal(text.split("[features]").length - 1, 1);
    assert.match(text, /\[features\]\nmemories = false/);
    const second = mergeCodexConfigToml(text, extractManagedProviders(STORE), 47821, "tok");
    assert.equal(second.text, text, "stable once absorbed");
  });
});

describe("auto routing channel (anyswitch-auto)", () => {
  it("injects the auto provider pointing at the chain head", () => {
    const auto = deriveAutoRouteChannel(CHAIN_STORE, "codex");
    const { text, managed } = mergeCodexConfigToml("", extractManagedProviders(CHAIN_STORE), 47821, "tok", auto);
    assert.match(text, /\[model_providers\."anyswitch-auto"\]/);
    const autoBlock = text.match(/\[model_providers\."anyswitch-auto"\][^[]*/)[0];
    assert.match(autoBlock, /name = "自动路由"/);
    assert.match(autoBlock, /base_url = "http:\/\/127\.0\.0\.1:47821\/openai\/poke-api\/v1"/);
    assert.match(autoBlock, /"x-agent-id" = "codex"/);
    assert.ok(managed.includes("auto"), "sidecar tracks the auto channel as managed");
    assert.equal(managedProviderId("auto"), "anyswitch-auto");
  });

  it("does not inject anyswitch-auto when the endpoint has no route chain", () => {
    const { text, managed } = mergeCodexConfigToml(
      "",
      extractManagedProviders(STORE),
      47821,
      "tok",
      deriveAutoRouteChannel(STORE, "codex"),
    );
    assert.doesNotMatch(text, /anyswitch-auto/);
    assert.ok(!managed.includes("auto"));
  });

  it("drops anyswitch-auto on the re-sync after the chain is deleted", () => {
    const first = mergeCodexConfigToml("", extractManagedProviders(CHAIN_STORE), 47821, "tok", deriveAutoRouteChannel(CHAIN_STORE, "codex"));
    assert.match(first.text, /anyswitch-auto/);
    const second = mergeCodexConfigToml(first.text, extractManagedProviders(STORE), 47821, "tok", deriveAutoRouteChannel(STORE, "codex"));
    assert.doesNotMatch(second.text, /anyswitch-auto/, "stale auto removed once the chain is gone");
    assert.match(second.text, /\[model_providers\."anyswitch-poke-api"\]/, "real channels survive the cleanup");
  });
});

describe("writeCodexConfigTomlWithBackup", () => {
  it("writes atomically, backs up the previous file, and prunes to the newest 5 backups", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-merge-test-"));
    const filePath = join(dir, "config.toml");
    for (let i = 1; i <= 6; i++) {
      writeFileSync(join(dir, `config.backup.2020-01-0${i}T00-00-00-000Z.toml`), `old${i}`, "utf8");
    }
    writeFileSync(filePath, "# old", "utf8");
    const result = writeCodexConfigTomlWithBackup(filePath, "# new");
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);
    assert.ok(result.backupPath);
    assert.equal(readFileSync(filePath, "utf8"), "# new");
    const backups = readdirSync(dir).filter((n) => n.startsWith("config.backup.")).sort();
    assert.equal(backups.length, 5);
    assert.equal(backups[0], "config.backup.2020-01-03T00-00-00-000Z.toml", "oldest backups pruned");
    assert.ok(backups.includes(result.backupPath.split(/[\\/]/).pop()), "fresh backup kept");
  });

  it("reports unchanged without creating a backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-merge-test-"));
    const filePath = join(dir, "config.toml");
    writeCodexConfigTomlWithBackup(filePath, "# same");
    const before = readdirSync(dir);
    const result = writeCodexConfigTomlWithBackup(filePath, "# same");
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.equal(result.backupPath, undefined);
    assert.deepEqual(readdirSync(dir), before);
  });
});

describe("codex sidecar", () => {
  it("readSidecar returns empty list for missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-sidecar-"));
    assert.deepEqual(readSidecar(dir), { providers: [] });
  });

  it("writeSidecar and readSidecar round-trip sorted in the shared format", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-sidecar-"));
    writeSidecar(dir, ["zeta", "alpha"]);
    assert.deepEqual(readSidecar(dir), { providers: ["alpha", "zeta"] });
    assert.equal(
      readFileSync(sidecarPath(dir), "utf8"),
      '{\n  "providers": [\n    "alpha",\n    "zeta"\n  ]\n}\n',
    );
  });
});

describe("codex model catalog (model_catalog_json)", () => {
  it("builds spec-compliant entries from the channel view, one per routable model", () => {
    assert.ok(CATALOG_TEMPLATE, "template asset codex-model-catalog-template.json loads");
    const providers = {
      alpha: { models: { "m-one": { displayName: "M One", contextWindow: 128000 }, "m-two": {} } },
      beta: { models: { "m-one": { displayName: "shadowed" } } },
    };
    const catalog = buildCodexModelCatalog(collectCodexCatalogModels(providers), CATALOG_TEMPLATE);
    assert.equal(catalog.models.length, 2, "duplicate model ids collapse, first channel wins");
    const [one, two] = catalog.models;
    assert.equal(one.slug, "m-one");
    assert.equal(one.display_name, "M One");
    assert.equal(one.context_window, 128000, "store contextWindow overrides the template window");
    assert.equal(one.max_context_window, 128000);
    assert.equal(two.slug, "m-two");
    assert.equal(two.display_name, "m-two", "display_name falls back to the model id");
    assert.equal(two.context_window, CATALOG_TEMPLATE.context_window, "no metadata keeps the template window");
    for (const [index, entry] of catalog.models.entries()) {
      assert.equal(entry.visibility, "list");
      assert.equal(entry.supported_in_api, true);
      assert.equal(entry.multi_agent_version, "v2", "without it codex disables the subagent tools");
      assert.equal(entry.priority, index + 1);
      assert.ok(Array.isArray(entry.supported_reasoning_levels) && entry.supported_reasoning_levels.length > 0);
      assert.equal(typeof entry.default_reasoning_level, "string");
      assert.equal(entry.truncation_policy?.mode, "tokens");
      assert.equal(typeof entry.model_messages?.instructions_template, "string");
      assert.ok(entry.model_messages.instructions_template.length > 0, "catalog entries without instructions fail codex's config load");
      // request-shaping overrides for non-OpenAI upstreams
      assert.equal(entry.supports_search_tool, false);
      assert.equal(entry.prefer_websockets, false, "the relay has no WebSocket surface — codex must stay on HTTP");
      assert.equal(entry.support_verbosity, false);
      assert.equal(entry.supports_image_detail_original, false);
    }
    assert.equal(buildCodexModelCatalog(new Map(), CATALOG_TEMPLATE), null, "empty model set builds no catalog");
  });

  it("writes the catalog file and anchors the pointer in the top-level key region", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-catalog-"));
    const configPath = join(dir, ".codex", "config.toml");
    const result = writeCodexConfig(CHAIN_STORE, 47821, "tok", dir, configPath);
    assert.equal(result.ok, true);
    const text = readFileSync(configPath, "utf8");
    const pointerLine = `model_catalog_json = "${CATALOG_POINTER_VALUE}"`;
    assert.ok(text.includes(pointerLine));
    assert.ok(text.indexOf(pointerLine) < text.indexOf(MANAGED_BEGIN), "pointer precedes the managed tables");
    assert.equal(text.split("model_catalog_json").length - 1, 1, "exactly one pointer line");

    const catalogPath = join(dir, ".codex", "model-catalogs", "anyswitch-models.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    assert.deepEqual(catalog.models.map((m) => m.slug).sort(), ["auto", "gpt-6-astra"]);

    // A second sync is stable: one pointer, unchanged config, same catalog bytes.
    const before = readFileSync(catalogPath, "utf8");
    const second = writeCodexConfig(CHAIN_STORE, 47821, "tok", dir, configPath);
    assert.equal(second.unchanged, true);
    assert.equal(readFileSync(catalogPath, "utf8"), before);
    const textAgain = readFileSync(configPath, "utf8");
    assert.equal(textAgain.split("model_catalog_json").length - 1, 1);
  });

  it("keeps foreign sections around the pointer", () => {
    const existing = ['model = "gpt-6-astra"', "", "[desktop]", 'theme = "dark"', ""].join("\n");
    const { text } = mergeCodexConfigToml(existing, extractManagedProviders(STORE), 47821, "tok", null, CATALOG_TEMPLATE);
    assert.match(text, /^model_catalog_json = "model-catalogs\/anyswitch-models\.json"$/m);
    assert.match(text, /^model = "gpt-6-astra"$/m);
    assert.match(text, /\[desktop\]/);
    assert.match(text, /theme = "dark"/);
    assert.ok(text.indexOf("model_catalog_json") < text.indexOf("[desktop]"), "top-level key stays ahead of tables");
  });

  it("keeps a user's own model_catalog_json and writes neither pointer nor file", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-catalog-"));
    const configPath = join(dir, ".codex", "config.toml");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, 'model_catalog_json = "my-own/catalog.json"\n', "utf8");
    const result = writeCodexConfig(STORE, 47821, "tok", dir, configPath);
    assert.equal(result.ok, true);
    const text = readFileSync(configPath, "utf8");
    assert.match(text, /^model_catalog_json = "my-own\/catalog\.json"$/m);
    assert.equal(text.split("model_catalog_json").length - 1, 1, "no second pointer added");
    assert.match(text, /\[model_providers\."anyswitch-poke-api"\]/, "provider tables still merge");
    assert.equal(existsSync(join(dir, ".codex", "model-catalogs")), false, "our catalog is not written");
  });

  it("removes our stale catalog file when the user points model_catalog_json elsewhere", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-catalog-"));
    const configPath = join(dir, ".codex", "config.toml");
    // A first sync owns the pointer and generates the catalog file.
    writeCodexConfig(STORE, 47821, "tok", dir, configPath);
    const catalogPath = join(dir, ".codex", "model-catalogs", "anyswitch-models.json");
    assert.equal(existsSync(catalogPath), true);
    // The user then hand-writes a pointer at their own catalog: the next sync
    // strips our leftover file but never touches theirs.
    const userCatalogPath = join(dir, ".codex", "my-own", "catalog.json");
    mkdirSync(dirname(userCatalogPath), { recursive: true });
    writeFileSync(userCatalogPath, '{"models":[]}\n', "utf8");
    writeFileSync(configPath, 'model_catalog_json = "my-own/catalog.json"\n', "utf8");
    const result = writeCodexConfig(STORE, 47821, "tok", dir, configPath);
    assert.equal(result.ok, true);
    assert.equal(existsSync(catalogPath), false, "stale anyswitch-managed catalog removed");
    assert.equal(readFileSync(userCatalogPath, "utf8"), '{"models":[]}\n', "the user's own catalog is never touched");
    assert.match(readFileSync(configPath, "utf8"), /^model_catalog_json = "my-own\/catalog\.json"$/m);
  });

  it("writes no pointer and no file when no model is routable, and cleans up stale ones", () => {
    // merge level: providers exist but expose no models
    const { text, catalogPointer } = mergeCodexConfigToml("", {}, 47821, "tok", null, CATALOG_TEMPLATE);
    assert.doesNotMatch(text, /model_catalog_json/);
    assert.equal(catalogPointer, "none");

    // write level: the re-sync after the last channel is removed strips our
    // pointer and deletes the generated file
    const dir = mkdtempSync(join(tmpdir(), "codex-catalog-"));
    const configPath = join(dir, ".codex", "config.toml");
    writeCodexConfig(STORE, 47821, "tok", dir, configPath);
    const catalogPath = join(dir, ".codex", "model-catalogs", "anyswitch-models.json");
    assert.equal(existsSync(catalogPath), true);
    const result = writeCodexConfig({ version: 2, providers: {} }, 47821, "tok", dir, configPath);
    assert.equal(result.ok, true);
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /model_catalog_json/);
    assert.equal(existsSync(catalogPath), false);
  });

  it("strips our stale pointer when the catalog feature is off (no template)", () => {
    const existing = `model_catalog_json = "${CATALOG_POINTER_VALUE}"\n`;
    const { text, catalogPointer } = mergeCodexConfigToml(existing, extractManagedProviders(STORE), 47821, "tok");
    assert.doesNotMatch(text, /model_catalog_json/);
    assert.equal(catalogPointer, "none");
  });
});

describe("writeCodexConfig", () => {
  it("writes config and sidecar, then reports unchanged on a second run", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-write-"));
    const configPath = join(dir, ".codex", "config.toml");
    const first = writeCodexConfig(STORE, 47821, "tok", dir, configPath);
    assert.equal(first.ok, true);
    assert.equal(first.unchanged, false);
    const text = readFileSync(configPath, "utf8");
    assert.match(text, /\[model_providers\."anyswitch-poke-api"\]/);
    assert.match(text, /Bearer tok/);
    assert.deepEqual(readSidecar(dir), { providers: ["poke-api"] });

    const second = writeCodexConfig(STORE, 47821, "tok", dir, configPath);
    assert.equal(second.ok, true);
    assert.equal(second.unchanged, true);
  });

  it("returns a no-op reason when the store has no channels and nothing was managed before", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-write-"));
    const result = writeCodexConfig({ version: 2, providers: {} }, 47821, "tok", dir, join(dir, ".codex", "config.toml"));
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.equal(result.reason, "no Anyswitch providers with models");
    assert.equal(existsSync(join(dir, ".codex", "config.toml")), false);
  });

  it("still cleans up after the last channel is removed, using the sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-write-"));
    const configPath = join(dir, ".codex", "config.toml");
    writeCodexConfig(STORE, 47821, "tok", dir, configPath);
    const result = writeCodexConfig({ version: 2, providers: {} }, 47821, "tok", dir, configPath);
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /anyswitch-poke-api/);
    assert.deepEqual(readSidecar(dir), { providers: [] });
  });

  it("fails closed on a truncated managed block and leaves the file untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-write-"));
    const configPath = join(dir, ".codex", "config.toml");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${MANAGED_BEGIN}\n[model_providers."anyswitch-x"]\n`, "utf8");
    const before = readFileSync(configPath, "utf8");
    const result = writeCodexConfig(STORE, 47821, "tok", dir, configPath);
    assert.equal(result.ok, false);
    assert.equal(result.unchanged, true);
    assert.match(result.reason, /truncated/);
    assert.equal(readFileSync(configPath, "utf8"), before);
    assert.equal(existsSync(sidecarPath(dir)), false, "no sidecar written for a refused merge");
  });

  it("codexConfigPath resolves under USERPROFILE", () => {
    assert.equal(codexConfigPath({ USERPROFILE: "/home/u" }), join("/home/u", ".codex", "config.toml"));
  });
});
