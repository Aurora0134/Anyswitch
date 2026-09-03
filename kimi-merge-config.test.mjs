import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildKimiManagedToml,
  mergeKimiConfigToml,
  stripManagedBlock,
  writeKimiConfigTomlWithBackup,
  extractApiCredProviders,
  readSidecar,
  writeSidecar,
  sidecarPath,
  MANAGED_BEGIN,
  MANAGED_END,
  deriveAutoRouteChannel,
} from "./kimi-merge-config.mjs";

const STORE = {
  version: 2,
  providers: {
    "poke-api": {
      baseURL: "https://poke.example/v1",
      protocol: "openai-compatible",
      credentialFile: "poke-api.dpapi",
      models: {
        "claude-opus-5": { displayName: "Claude Opus 5", contextWindow: 200000 },
      },
    },
  },
};

describe("kimi-merge-config", () => {
  it("builds openai provider and model entries for the relay", () => {
    const providers = extractApiCredProviders(STORE);
    const { text, managed } = buildKimiManagedToml(providers, 47821, "tok");
    assert.deepEqual(managed, ["poke-api"]);
    assert.match(text, /\[providers\."_poke-api"\]/);
    assert.match(text, /type = "openai"/);
    assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:47821\/openai\/poke-api\/v1"/);
    assert.match(text, /api_key = "tok"/);
    // 端点身份头改由 launcher 经 KIMI_CODE_CUSTOM_HEADERS env 注入——config.toml
    // 的 customHeaders 会覆盖 env 同名头，managed block 不再携带它。
    assert.doesNotMatch(text, /custom_headers/);
    assert.doesNotMatch(text, /x-agent-id/);
    assert.match(text, /\[models\."_poke-api\/claude-opus-5"\]/);
    assert.match(text, /provider = "_poke-api"/);
    assert.match(text, /model = "claude-opus-5"/);
    assert.doesNotMatch(text, /^name = /m);
    assert.match(text, /max_context_size = 200000/);
    assert.match(text, /display_name = "Claude Opus 5"/);
  });

  it("preserves user hooks and replaces a previous managed block", () => {
    const existing = [
      "# user hooks",
      "[[hooks]]",
      'event = "Stop"',
      MANAGED_BEGIN,
      '[providers."_old"]',
      MANAGED_END,
      "",
    ].join("\n");
    const { text } = mergeKimiConfigToml(existing, extractApiCredProviders(STORE), 47821, "tok");
    assert.match(text, /# user hooks/);
    assert.match(text, /event = "Stop"/);
    assert.doesNotMatch(text, /_old/);
    assert.match(text, /_poke-api/);
    assert.equal(text.indexOf(MANAGED_BEGIN) < text.indexOf(MANAGED_END), true);
  });

  it("refuses a truncated managed block", () => {
    assert.throws(
      () => stripManagedBlock(`${MANAGED_BEGIN}\n[providers."_x"]\n`),
      (err) => err.code === "UNPARSEABLE_KIMI_CONFIG",
    );
  });

  it("strips unmarked provider/model tables left by a Kimi self-rewrite", () => {
    // Real-world shape (2026-08-25 incident): Kimi Code re-serializes its own
    // config.toml after a settings change, dropping the managed markers and
    // unquoting keys. Without this cleanup the next merge appends a duplicate
    // provider table and the whole file fails to decode.
    const rewritten = [
      'default_model = "_poke-api/claude-opus-5"',
      "",
      "[[hooks]]",
      'event = "Stop"',
      "",
      "[providers._poke-api]",
      'type = "openai"',
      'base_url = "http://127.0.0.1:47821/openai/poke-api/v1"',
      'api_key = "old-token"',
      "",
      '[models."_poke-api/claude-opus-5"]',
      'provider = "_poke-api"',
      'model = "claude-opus-5"',
      "max_context_size = 200000",
      "",
    ].join("\n");
    const { text } = mergeKimiConfigToml(rewritten, extractApiCredProviders(STORE), 47821, "tok");
    assert.match(text, /default_model = "_poke-api\/claude-opus-5"/);
    assert.match(text, /event = "Stop"/);
    assert.doesNotMatch(text, /\[providers\._poke-api\]/);
    assert.match(text, /\[providers\."_poke-api"\]/);
    assert.match(text, /api_key = "tok"/);
    const providerHeaders = text.match(/^\[providers\..*\]/gm) ?? [];
    assert.equal(providerHeaders.length, 1);
  });
});

describe("writeKimiConfigTomlWithBackup", () => {
  it("writes atomically, backs up the previous file, and prunes to the newest 5 backups", () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-merge-test-"));
    const filePath = join(dir, "config.toml");
    // Six stale backups predating this write; the fresh backup plus the
    // newest 4 of these survive.
    for (let i = 1; i <= 6; i++) {
      writeFileSync(join(dir, `config.backup.2020-01-0${i}T00-00-00-000Z.toml`), `old${i}`, "utf8");
    }
    writeFileSync(filePath, "# old", "utf8");
    const result = writeKimiConfigTomlWithBackup(filePath, "# new");
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
    const dir = mkdtempSync(join(tmpdir(), "kimi-merge-test-"));
    const filePath = join(dir, "config.toml");
    writeKimiConfigTomlWithBackup(filePath, "# same");
    const before = readdirSync(dir);
    const result = writeKimiConfigTomlWithBackup(filePath, "# same");
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.equal(result.backupPath, undefined);
    assert.deepEqual(readdirSync(dir), before);
  });
});

describe("pool channels", () => {
  const POOL_STORE = {
    version: 2,
    providers: {
      "poke-api": {
        ...STORE.providers["poke-api"],
        models: {
          "claude-opus-5": { displayName: "Claude Opus 5", contextWindow: 200000 },
          "claude-sonnet-5": { displayName: "Claude Sonnet 5" },
        },
      },
      "nvidia-nim": {
        baseURL: "https://nim.invalid/v1",
        protocol: "openai-compatible",
        credentialFile: "nvidia-nim.dpapi",
        models: {
          "claude-opus-5": { displayName: "NIM Opus" },
          "deepseek-chat": { displayName: "DeepSeek Chat" },
        },
      },
    },
    pools: {
      "pool-claude": { displayName: "Claude Pool", members: ["poke-api", "nvidia-nim"] },
    },
  };

  it("emits one provider table for the pool with unioned, deduped model aliases", () => {
    const { text, managed } = buildKimiManagedToml(extractApiCredProviders(POOL_STORE), 47821, "tok");
    assert.match(text, /\[providers\."_pool-claude"\]/);
    assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:47821\/openai\/pool-claude\/v1"/);
    assert.match(text, /\[models\."_pool-claude\/claude-opus-5"\]/);
    assert.match(text, /\[models\."_pool-claude\/claude-sonnet-5"\]/);
    assert.match(text, /\[models\."_pool-claude\/deepseek-chat"\]/);
    // First member in pool order wins the shared model's metadata.
    const opusBlock = text.match(/\[models\."_pool-claude\/claude-opus-5"\][^\[]*/)[0];
    assert.match(opusBlock, /display_name = "Claude Opus 5"/);
    assert.ok(managed.includes("pool-claude"));
    // Member channels are absorbed into the pool channel — every endpoint sees
    // one provider per pool, exactly like the wire catalog.
    assert.doesNotMatch(text, /\[providers\."_poke-api"\]/);
    assert.doesNotMatch(text, /\[providers\."_nvidia-nim"\]/);
  });

  it("removes the pool tables after the pool is dissolved", () => {
    const withPool = mergeKimiConfigToml("", extractApiCredProviders(POOL_STORE), 47821, "tok").text;
    assert.match(withPool, /_pool-claude/);
    const withoutPool = mergeKimiConfigToml(
      withPool,
      extractApiCredProviders({ version: 2, providers: POOL_STORE.providers }),
      47821,
      "tok",
    ).text;
    assert.doesNotMatch(withoutPool, /_pool-claude/);
    assert.match(withoutPool, /\[providers\."_poke-api"\]/);
  });

  it("keeps a single provider table when the pool id equals a member provider id", () => {
    const store = {
      ...POOL_STORE,
      pools: { "poke-api": { displayName: "Poke Pool", members: ["poke-api", "nvidia-nim"] } },
    };
    const { text, managed } = buildKimiManagedToml(extractApiCredProviders(store), 47821, "tok");
    // Both members are absorbed; only the pool channel (reusing the member id)
    // remains. Duplicate aliases would break TOML decoding.
    const providerHeaders = text.match(/^\[providers\..*\]/gm) ?? [];
    assert.deepEqual(providerHeaders, ['[providers."_poke-api"]']);
    const aliasHeaders = text.match(/^\[models\."_poke-api\//gm) ?? [];
    assert.equal(aliasHeaders.length, 3);
    assert.deepEqual(managed, ["poke-api"]);
  });
});

describe("kimi sidecar", () => {
  it("readSidecar returns empty list for missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-sidecar-"));
    assert.deepEqual(readSidecar(dir), { providers: [] });
  });

  it("writeSidecar and readSidecar round-trip sorted", () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-sidecar-"));
    writeSidecar(dir, ["zeta", "alpha"]);
    assert.deepEqual(readSidecar(dir), { providers: ["alpha", "zeta"] });
    assert.ok(existsSync(sidecarPath(dir)));
  });

  it("writeSidecar keeps the shared on-disk format", () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-sidecar-"));
    writeSidecar(dir, ["poke-api"]);
    assert.equal(
      readFileSync(sidecarPath(dir), "utf8"),
      '{\n  "providers": [\n    "poke-api"\n  ]\n}\n',
    );
  });
});

describe("auto routing channel (_auto)", () => {
  const CHAIN_STORE = {
    ...STORE,
    routingChains: {
      kimi: { chain: [{ node: "poke-api", model: "claude-opus-5" }] },
    },
  };

  it("injects the _auto provider whose alias maps to the literal wire id auto", () => {
    const auto = deriveAutoRouteChannel(CHAIN_STORE, "kimi");
    const { text, managed } = mergeKimiConfigToml("", extractApiCredProviders(CHAIN_STORE), 47821, "tok", auto);
    assert.match(text, /\[providers\."_auto"\]/);
    assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:47821\/openai\/poke-api\/v1"/);
    assert.match(text, /\[models\."_auto\/auto"\]/);
    // _auto 走链式路由，链查询按 x-agent-id 定位端点链——身份头由 launcher 的
    // KIMI_CODE_CUSTOM_HEADERS env 注入，config.toml 不再携带（config 的
    // customHeaders 会覆盖 env 同名头）。
    const autoBlock = text.match(/\[providers\."_auto"\][^[]*/)[0];
    assert.doesNotMatch(autoBlock, /custom_headers/);
    // The model field is the literal "auto" — the relay intercepts it before
    // unpackWireId, so no anthropic/<provider>/<model> wire id is needed.
    assert.match(text, /provider = "_auto"/);
    assert.match(text, /model = "auto"/);
    assert.ok(managed.includes("auto"), "sidecar tracks the _auto channel as managed");
  });

  it("does not inject _auto when the endpoint has no route chain", () => {
    const { text, managed } = mergeKimiConfigToml(
      "",
      extractApiCredProviders(STORE),
      47821,
      "tok",
      deriveAutoRouteChannel(STORE, "kimi"),
    );
    assert.doesNotMatch(text, /_auto/);
    assert.ok(!managed.includes("auto"));
  });

  it("drops _auto from the managed block on the re-sync after the chain is deleted", () => {
    const first = mergeKimiConfigToml(
      "",
      extractApiCredProviders(CHAIN_STORE),
      47821,
      "tok",
      deriveAutoRouteChannel(CHAIN_STORE, "kimi"),
    );
    assert.match(first.text, /\[providers\."_auto"\]/);
    const second = mergeKimiConfigToml(
      first.text,
      extractApiCredProviders(STORE),
      47821,
      "tok",
      deriveAutoRouteChannel(STORE, "kimi"),
    );
    assert.doesNotMatch(second.text, /_auto/, "stale _auto removed once the chain is gone");
    assert.match(second.text, /\[providers\."_poke-api"\]/, "real channels survive the cleanup");
    assert.ok(!second.managed.includes("auto"));
  });
});
