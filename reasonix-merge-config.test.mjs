import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildReasonixManagedToml,
  mergeReasonixConfigToml,
  stripManagedBlock,
  stripPrefixedProviderTables,
  writeReasonixConfigTomlWithBackup,
  writeReasonixEnvWithBackup,
  extractApiCredProviders,
  mergeReasonixEnv,
  readSidecar,
  writeSidecar,
  sidecarPath,
  MANAGED_BEGIN,
  MANAGED_END,
  deriveAutoRouteChannel,
} from "./reasonix-merge-config.mjs";

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

describe("reasonix-merge-config", () => {
  it("builds openai provider entries pointing at the relay", () => {
    const providers = extractApiCredProviders(STORE);
    const { text, managed } = buildReasonixManagedToml(providers, 47821);
    assert.deepEqual(managed, ["poke-api"]);
    assert.match(text, /\[\[providers\]\]/);
    assert.match(text, /name\s+= "_poke-api"/);
    assert.match(text, /kind\s+= "openai"/);
    assert.match(text, /base_url\s+= "http:\/\/127\.0\.0\.1:47821\/openai\/poke-api\/v1"/);
    assert.match(text, /api_key_env\s+= "APICRED_RELAY_TOKEN"/);
    assert.match(text, /model\s+= "claude-opus-5"/);
    assert.match(text, /models\s+= \[/);
    assert.match(text, /"claude-opus-5"/);
    assert.match(text, /headers\s+= \{ "x-agent-id" = "reasonix" \}/);
    assert.match(text, /context_window\s+= 200000/);
  });

  it("keeps official deepseek presets when the user had no providers", () => {
    const { text } = mergeReasonixConfigToml("", extractApiCredProviders(STORE), 47821);
    assert.match(text, /name\s+= "deepseek-flash"/);
    assert.match(text, /name\s+= "_poke-api"/);
    assert.equal(text.indexOf("deepseek-flash") < text.indexOf(MANAGED_BEGIN), true);
  });

  it("preserves user providers and replaces a previous managed block", () => {
    const existing = [
      "[[providers]]",
      'name = "mine"',
      'kind = "openai"',
      MANAGED_BEGIN,
      "[[providers]]",
      'name = "_old"',
      MANAGED_END,
      "",
    ].join("\n");
    const { text } = mergeReasonixConfigToml(existing, extractApiCredProviders(STORE), 47821);
    assert.match(text, /name = "mine"/);
    assert.doesNotMatch(text, /_old/);
    assert.match(text, /_poke-api/);
    assert.doesNotMatch(text, /name\s+= "deepseek-flash"/);
  });

  it("refuses a truncated managed block", () => {
    assert.throws(
      () => stripManagedBlock(`${MANAGED_BEGIN}\n[[providers]]\n`),
      (err) => err.code === "UNPARSEABLE_REASONIX_CONFIG",
    );
  });

  it("drops leftover _-prefixed provider tables so an old 9-model copy cannot win", () => {
    const existing = [
      "[[providers]]",
      'name        = "deepseek-flash"',
      'models      = ["deepseek-v4-flash"]',
      "[[providers]]",
      'name        = "_acme-main"',
      'models      = ["kimi-k3", "qwen3.8-max", "mimo-v2.5-pro", "claude-sonnet-5", "gemini-3.6-flash", "grok-4.6", "gpt-5.6-sol", "glm-5.3", "gemini-3.7-flash"]',
      "[[providers]]",
      'name = "mine"',
      "",
    ].join("\n");
    const stripped = stripPrefixedProviderTables(existing);
    assert.match(stripped, /deepseek-flash/);
    assert.match(stripped, /name = "mine"/);
    assert.doesNotMatch(stripped, /_acme-main/);
    const providers = {
      "acme-main": {
        models: {
          "kimi-k3": { displayName: "kimi-k3" },
          "claude-opus-5": { displayName: "opus 5" },
        },
      },
    };
    const { text } = mergeReasonixConfigToml(existing, providers, 47821);
    assert.equal([...text.matchAll(/name\s+=\s+"_acme-main"/g)].length, 1);
    assert.match(text, /"claude-opus-5"/);
    assert.match(text, /name = "mine"/);
  });

  it("emits one provider per store channel with the full filtered models list", () => {
    const providers = {
      "acme-main": {
        models: {
          "kimi-k3": { displayName: "kimi-k3" },
          "deepseek-v4-flash-vision-exp": { displayName: "vision" },
          "claude-opus-5": { displayName: "opus 5" },
        },
      },
    };
    const { text } = buildReasonixManagedToml(providers, 47821);
    assert.equal([...text.matchAll(/\[\[providers\]\]/g)].length, 1);
    assert.match(text, /name\s+= "_acme-main"/);
    assert.match(text, /"kimi-k3"/);
    assert.match(text, /"deepseek-v4-flash-vision-exp"/);
    assert.match(text, /"claude-opus-5"/);
    assert.doesNotMatch(text, /name\s+= "_acme-main\//);
    assert.doesNotMatch(text, /name\s+= "_acme-main--/);
  });

  it("upserts APICRED_RELAY_TOKEN without clobbering other env keys", () => {
    const merged = mergeReasonixEnv("DEEPSEEK_API_KEY=abc\nAPICRED_RELAY_TOKEN=old\n", "newtok");
    assert.match(merged, /DEEPSEEK_API_KEY=abc/);
    assert.match(merged, /APICRED_RELAY_TOKEN=newtok/);
    assert.doesNotMatch(merged, /APICRED_RELAY_TOKEN=old/);
  });

  it("writes config and env under a sandbox home", async () => {
    const { writeReasonixConfig } = await import("./reasonix-launcher.mjs");
    const tmp = mkdtempSync(join(tmpdir(), "reasonix-sync-"));
    const configPath = join(tmp, "reasonix", "config.toml");
    const res = await writeReasonixConfig(STORE, 47821, "tok-1", tmp, configPath);
    assert.equal(res.ok, true);
    const toml = readFileSync(configPath, "utf8");
    assert.match(toml, /_poke-api/);
    const env = readFileSync(join(tmp, "reasonix", ".env"), "utf8");
    assert.match(env, /APICRED_RELAY_TOKEN=tok-1/);
  });
});

describe("backup pruning", () => {
  it("prunes config.toml backups to the newest 5 after a write", () => {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-merge-test-"));
    const filePath = join(dir, "config.toml");
    for (let i = 1; i <= 6; i++) {
      writeFileSync(join(dir, `config.backup.2020-01-0${i}T00-00-00-000Z.toml`), `old${i}`, "utf8");
    }
    writeFileSync(filePath, "# old", "utf8");
    const result = writeReasonixConfigTomlWithBackup(filePath, "# new");
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);
    assert.ok(result.backupPath);
    const backups = readdirSync(dir).filter((n) => n.startsWith("config.backup.")).sort();
    assert.equal(backups.length, 5);
    assert.equal(backups[0], "config.backup.2020-01-03T00-00-00-000Z.toml", "oldest backups pruned");
    assert.ok(backups.includes(result.backupPath.split(/[\\/]/).pop()), "fresh backup kept");
  });

  it("prunes .env backups to the newest 5 after a write", () => {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-merge-test-"));
    const filePath = join(dir, ".env");
    for (let i = 1; i <= 6; i++) {
      writeFileSync(join(dir, `.env.backup.2020-01-0${i}T00-00-00-000Z`), `old${i}`, "utf8");
    }
    writeFileSync(filePath, "APICRED_RELAY_TOKEN=old\n", "utf8");
    const result = writeReasonixEnvWithBackup(filePath, "tok");
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, false);
    assert.ok(result.backupPath);
    const backups = readdirSync(dir).filter((n) => n.startsWith(".env.backup.")).sort();
    assert.equal(backups.length, 5);
    assert.equal(backups[0], ".env.backup.2020-01-03T00-00-00-000Z", "oldest backups pruned");
    assert.ok(backups.includes(result.backupPath.split(/[\\/]/).pop()), "fresh backup kept");
    assert.match(readFileSync(filePath, "utf8"), /APICRED_RELAY_TOKEN=tok/);
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
          "claude-sonnet-5": { displayName: "Claude Sonnet 5", contextWindow: 180000 },
        },
      },
      deepseek: {
        baseURL: "https://deepseek.example/v1",
        protocol: "openai-compatible",
        credentialFile: "deepseek.dpapi",
        models: {
          "claude-opus-5": { displayName: "DS Opus" },
          "deepseek-v4": { displayName: "DeepSeek V4" },
        },
      },
    },
    pools: {
      "pool-claude": { displayName: "Claude Pool", members: ["poke-api", "deepseek"] },
    },
  };

  it("emits one [[providers]] block for the pool with unioned, deduped models", () => {
    const { text, managed } = buildReasonixManagedToml(extractApiCredProviders(POOL_STORE), 47821);
    assert.match(text, /name\s+= "_pool-claude"/);
    assert.match(text, /base_url\s+= "http:\/\/127\.0\.0\.1:47821\/openai\/pool-claude\/v1"/);
    assert.match(text, /api_key_env\s+= "APICRED_RELAY_TOKEN"/);
    assert.match(text, /headers\s+= \{ "x-agent-id" = "reasonix" \}/);
    const poolBlock = text.match(/\[\[providers\]\]\nname\s+= "_pool-claude"[\s\S]*?(?=\n\[\[providers\]\]|\n# <<<)/)[0];
    assert.match(poolBlock, /"claude-opus-5",/);
    assert.match(poolBlock, /"claude-sonnet-5",/);
    assert.match(poolBlock, /"deepseek-v4",/);
    assert.equal(poolBlock.match(/"claude-opus-5"/g).length >= 1, true);
    // First member in pool order supplies the provider-level context window.
    assert.match(poolBlock, /context_window\s+= 200000/);
    assert.ok(managed.includes("pool-claude"));
    // Member channels are absorbed into the pool channel — every endpoint sees
    // one provider per pool, exactly like the wire catalog.
    assert.doesNotMatch(text, /name\s+= "_poke-api"/);
    assert.doesNotMatch(text, /name\s+= "_deepseek"/);
  });

  it("removes the pool block after the pool is dissolved", () => {
    const withPool = mergeReasonixConfigToml("", extractApiCredProviders(POOL_STORE), 47821).text;
    assert.match(withPool, /_pool-claude/);
    const withoutPool = mergeReasonixConfigToml(
      withPool,
      extractApiCredProviders({ version: 2, providers: POOL_STORE.providers }),
      47821,
    ).text;
    assert.doesNotMatch(withoutPool, /_pool-claude/);
    assert.match(withoutPool, /name\s+= "_poke-api"/);
  });

  it("keeps a single block when the pool id equals a member provider id", () => {
    const store = {
      ...POOL_STORE,
      pools: { "poke-api": { displayName: "Poke Pool", members: ["poke-api", "deepseek"] } },
    };
    const { text, managed } = buildReasonixManagedToml(extractApiCredProviders(store), 47821);
    assert.equal(text.match(/name\s+= "_poke-api"/g).length, 1);
    const block = text.match(/\[\[providers\]\]\nname\s+= "_poke-api"[\s\S]*?(?=\n\[\[providers\]\]|\n# <<<)/)[0];
    assert.match(block, /"claude-opus-5",/);
    assert.match(block, /"claude-sonnet-5",/);
    assert.match(block, /"deepseek-v4",/);
    // The other member is absorbed too; only the pool channel remains managed.
    assert.equal(text.match(/name\s+= "_deepseek"/g), null);
    assert.deepEqual(managed, ["poke-api"]);
  });
});

describe("reasonix sidecar", () => {
  it("readSidecar returns empty list for missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-sidecar-"));
    assert.deepEqual(readSidecar(dir), { providers: [] });
  });

  it("writeSidecar and readSidecar round-trip sorted", () => {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-sidecar-"));
    writeSidecar(dir, ["zeta", "alpha"]);
    assert.deepEqual(readSidecar(dir), { providers: ["alpha", "zeta"] });
    assert.ok(existsSync(sidecarPath(dir)));
  });

  it("writeSidecar keeps the shared on-disk format", () => {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-sidecar-"));
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
      reasonix: { chain: [{ node: "poke-api", model: "claude-opus-5" }] },
    },
  };

  it("injects the _auto provider when the endpoint has a route chain", () => {
    const auto = deriveAutoRouteChannel(CHAIN_STORE, "reasonix");
    const { text, managed } = mergeReasonixConfigToml("", extractApiCredProviders(CHAIN_STORE), 47821, auto);
    assert.match(text, /name\s+= "_auto"/);
    assert.match(text, /kind\s+= "openai"/);
    // The base URL points at the chain HEAD node, not at a literal "auto" segment.
    assert.match(text, /base_url\s+= "http:\/\/127\.0\.0\.1:47821\/openai\/poke-api\/v1"/);
    assert.match(text, /model\s+= "auto"/);
    assert.match(text, /models\s+= \[\s*\n?\s*"auto",?\s*\n?\]/);
    assert.match(text, /headers\s+= \{ "x-agent-id" = "reasonix" \}/);
    assert.ok(managed.includes("auto"), "sidecar tracks the _auto channel as managed");
  });

  it("does not inject _auto when the endpoint has no route chain", () => {
    const { text, managed } = mergeReasonixConfigToml(
      "",
      extractApiCredProviders(STORE),
      47821,
      deriveAutoRouteChannel(STORE, "reasonix"),
    );
    assert.doesNotMatch(text, /_auto/);
    assert.ok(!managed.includes("auto"));
  });

  it("drops _auto from the managed block on the re-sync after the chain is deleted", () => {
    const first = mergeReasonixConfigToml(
      "",
      extractApiCredProviders(CHAIN_STORE),
      47821,
      deriveAutoRouteChannel(CHAIN_STORE, "reasonix"),
    );
    assert.match(first.text, /name\s+= "_auto"/);
    const second = mergeReasonixConfigToml(
      first.text,
      extractApiCredProviders(STORE),
      47821,
      deriveAutoRouteChannel(STORE, "reasonix"),
    );
    assert.doesNotMatch(second.text, /_auto/, "stale _auto removed once the chain is gone");
    assert.match(second.text, /name\s+= "_poke-api"/, "real channels survive the cleanup");
    assert.ok(!second.managed.includes("auto"));
  });
});
