import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBalanceService } from "../src/panel/balance-service.mjs";
import { storePaths, ensureLayout, loadStore, writeStore } from "../src/store/store-io.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

// Balance poller against a real mkdtemp store root with real store-io; fetch
// and dpapi are faked. Credential "ciphertext" is the reversible `enc:` fake
// from store-service.test.mjs, so the service's decrypt path is exercised
// without real DPAPI.

function makeRoot() {
  const root = mkTestDir("anyswitch-balance-");
  const paths = storePaths(root);
  ensureLayout(paths);
  return paths;
}

function seedProviders(paths, providers) {
  const written = writeStore({ version: 2, providers }, { paths });
  assert.equal(written.ok, true, written.reason);
}

function providerEntry(over = {}) {
  return {
    displayName: "p",
    baseURL: "https://api.example.com/v1",
    protocol: "openai-compatible",
    credentialFile: "p.dpapi",
    models: {},
    ...over,
  };
}

function writeCredential(paths, file, key = "sk-test") {
  writeFileSync(join(paths.credentialsDir, file), Buffer.from(`enc:${key}`, "utf8"));
}

function fakeUnprotect(ciphertext) {
  const text = ciphertext.toString("utf8");
  assert.ok(text.startsWith("enc:"), "fake ciphertext prefix");
  return Buffer.from(text.slice(4), "utf8");
}

function creditsResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    body: { cancel: async () => {} },
  };
}

function makeService(paths, fetchImpl, extra = {}) {
  return createBalanceService({
    loadStore: () => loadStore(paths),
    readCiphertext: (file) => {
      try {
        return { ok: true, ciphertext: readFileSync(join(paths.credentialsDir, file)) };
      } catch {
        return { ok: false, reason: "credential file could not be read" };
      }
    },
    unprotect: async (ciphertext) => fakeUnprotect(ciphertext),
    fetchImpl,
    ...extra,
  });
}

describe("balance-service fetchOne", () => {
  it("parses total_available and defaults currency to usd", async () => {
    const paths = makeRoot();
    seedProviders(paths, { p: providerEntry() });
    writeCredential(paths, "p.dpapi");
    const service = makeService(paths, async () => creditsResponse({ total_available: 12.34 }));
    await service.refreshRound();
    assert.deepEqual(service.snapshot().p, {
      available: 12.34,
      currency: "usd",
      fetchedAt: service.snapshot().p.fetchedAt,
    });
  });

  it("honours the currency hint in the upstream payload", async () => {
    const paths = makeRoot();
    seedProviders(paths, { p: providerEntry() });
    writeCredential(paths, "p.dpapi");
    const service = makeService(paths, async () => creditsResponse({ total_available: 100, currency: "CNY" }));
    await service.refreshRound();
    assert.equal(service.snapshot().p.currency, "cny");
  });

  it("manual balanceCurrency override beats the upstream hint", async () => {
    const paths = makeRoot();
    seedProviders(paths, { p: providerEntry({ balanceCurrency: "cny" }) });
    writeCredential(paths, "p.dpapi");
    const service = makeService(paths, async () => creditsResponse({ total_available: 100, currency: "USD" }));
    await service.refreshRound();
    assert.equal(service.snapshot().p.currency, "cny");
  });

  it("calls <baseURL>/dashboard/billing/credit_grants with the bearer key", async () => {
    const paths = makeRoot();
    seedProviders(paths, { p: providerEntry({ baseURL: "https://api.example.com/v1/" }) });
    writeCredential(paths, "p.dpapi", "sk-secret");
    let seenUrl = null;
    let seenAuth = null;
    const service = makeService(paths, async (url, opts) => {
      seenUrl = url;
      seenAuth = opts.headers.Authorization;
      return creditsResponse({ total_available: 1 });
    });
    await service.refreshRound();
    assert.equal(seenUrl, "https://api.example.com/v1/dashboard/billing/credit_grants");
    assert.equal(seenAuth, "Bearer sk-secret");
  });

  it("404 marks the provider unsupported and hides it from the snapshot", async () => {
    const paths = makeRoot();
    seedProviders(paths, { p: providerEntry() });
    writeCredential(paths, "p.dpapi");
    const service = makeService(paths, async () => creditsResponse(null, { status: 404 }), { unsupportedRetryEvery: 3 });
    await service.refreshRound();
    assert.deepEqual(service.snapshot(), {});
  });

  it("unsupported providers are retried only every Nth round", async () => {
    const paths = makeRoot();
    seedProviders(paths, { p: providerEntry() });
    writeCredential(paths, "p.dpapi");
    let calls = 0;
    const service = makeService(paths, async () => {
      calls += 1;
      return creditsResponse(null, { status: 404 });
    }, { unsupportedRetryEvery: 3 });
    await service.refreshRound();
    await service.refreshRound();
    await service.refreshRound();
    assert.equal(calls, 1);
    await service.refreshRound();
    assert.equal(calls, 2);
  });

  it("200 without numeric total_available marks the provider unsupported", async () => {
    const paths = makeRoot();
    seedProviders(paths, { p: providerEntry() });
    writeCredential(paths, "p.dpapi");
    const service = makeService(paths, async () => creditsResponse({ object: "list" }));
    await service.refreshRound();
    assert.deepEqual(service.snapshot(), {});
  });

  it("transient failure keeps the previous good value", async () => {
    const paths = makeRoot();
    seedProviders(paths, { p: providerEntry() });
    writeCredential(paths, "p.dpapi");
    let fail = false;
    const service = makeService(paths, async () => {
      if (fail) throw new Error("network down");
      return creditsResponse({ total_available: 7.5 });
    });
    await service.refreshRound();
    fail = true;
    await service.refreshRound();
    assert.equal(service.snapshot().p.available, 7.5);
  });

  it("missing credential marks an error and does not call the network", async () => {
    const paths = makeRoot();
    seedProviders(paths, { p: providerEntry() });
    let calls = 0;
    const service = makeService(paths, async () => {
      calls += 1;
      return creditsResponse({ total_available: 1 });
    });
    await service.refreshRound();
    assert.equal(calls, 0);
    assert.deepEqual(service.snapshot(), {});
  });

  it("skips rounds entirely while the display switch is off", async () => {
    const paths = makeRoot();
    seedProviders(paths, { p: providerEntry() });
    writeCredential(paths, "p.dpapi");
    let calls = 0;
    const service = makeService(paths, async () => {
      calls += 1;
      return creditsResponse({ total_available: 1 });
    }, { enabledFn: () => false });
    await service.refreshRound();
    assert.equal(calls, 0);
    assert.deepEqual(service.snapshot(), {});
  });

  it("drops cache entries for providers removed from the store", async () => {
    const paths = makeRoot();
    seedProviders(paths, { p: providerEntry() });
    writeCredential(paths, "p.dpapi");
    const service = makeService(paths, async () => creditsResponse({ total_available: 1 }));
    await service.refreshRound();
    assert.ok(service.snapshot().p);
    seedProviders(paths, {});
    await service.refreshRound();
    assert.deepEqual(service.snapshot(), {});
  });
});
