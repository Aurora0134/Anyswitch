// Production wiring tests.
//
// Exercises launch.mjs against temp-directory stores and synthetic credentials
// sealed with REAL CurrentUser DPAPI (v2 entropy) — the same cryptographic path
// production uses, without touching the real store or real keys.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protect } from "./dpapi.mjs";
import {
  buildUpstreamURLs,
  createProductionDeps,
  createRetryingFetch,
  startProductionRelay,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
} from "./launch.mjs";
import { createHandler } from "./handler.mjs";
import { createUsageJournal } from "./usage-journal.mjs";

const PLAINTEXT = "synthetic-launch-test-key-not-a-real-credential";

// Tests that seal a fixture credential spawn the real powershell.exe DPAPI
// bridge; where it is unavailable the runner must report them as skipped
// rather than fail.
const dpapiAvailable = process.platform === "win32" &&
  existsSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
const needsDpapi = dpapiAvailable ? {} : { skip: "requires Windows DPAPI (powershell.exe)" };

function makePaths(t) {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-launch-"));
  mkdirSync(join(root, "credentials"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    storeFile: join(root, "store.json"),
    credentialsDir: join(root, "credentials"),
    appDir: join(root, "app"),
  };
}

function syntheticStore({ fallbackURLs } = {}) {
  return {
    version: 2,
    providers: {
      alpha: {
        displayName: "Alpha",
        baseURL: "https://alpha.example/v1",
        ...(fallbackURLs === undefined ? {} : { fallbackURLs }),
        protocol: "openai-compatible",
        credentialFile: "alpha.dpapi",
        models: { "model-one": { displayName: "Model One" } },
      },
    },
  };
}

async function writeFixture(paths, { sealCredential = true, fallbackURLs } = {}) {
  writeFileSync(paths.storeFile, JSON.stringify(syntheticStore({ fallbackURLs })));
  if (sealCredential) {
    const sealed = await protect(Buffer.from(PLAINTEXT, "utf8"), "alpha", { generation: "v2" });
    writeFileSync(join(paths.credentialsDir, "alpha.dpapi"), sealed);
    sealed.fill(0);
  }
}

function okUpstream(t, captured) {
  return async (url, init) => {
    captured.url = url;
    captured.authorization = init.headers.authorization;
    return new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 0,
        model: "model-one",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hi" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

function messagesBody(model = "anthropic/alpha/model-one") {
  return {
    model,
    max_tokens: 16,
    messages: [{ role: "user", content: "hello" }],
  };
}

function successfulResponse() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-fallback",
      object: "chat.completion",
      created: 0,
      model: "model-one",
      choices: [{ index: 0, message: { role: "assistant", content: "fallback" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---------- BaseURL fallback ----------

test("buildUpstreamURLs keeps primary-first order and normalizes trailing slashes", () => {
  assert.deepEqual(
    buildUpstreamURLs(
      {
        baseURL: "https://primary.example/v1///",
        fallbackURLs: ["https://backup-one.example/v1/", "https://backup-two.example/v1"],
      },
      "/chat/completions",
    ),
    [
      "https://primary.example/v1/chat/completions",
      "https://backup-one.example/v1/chat/completions",
      "https://backup-two.example/v1/chat/completions",
    ],
  );
  assert.deepEqual(
    buildUpstreamURLs({ baseURL: "https://primary.example/v1" }, "/chat/completions"),
    ["https://primary.example/v1/chat/completions"],
  );
});

test("retrying fetch retries 5xx and transport failures against the next endpoint", async () => {
  const calls = [];
  const delays = [];
  const retryingFetch = createRetryingFetch(
    async (url) => {
      calls.push(url);
      if (url.includes("primary")) return new Response("primary unavailable", { status: 503 });
      if (url.includes("backup-one")) throw new Error("connection refused");
      return successfulResponse();
    },
    { sleep: async (ms) => delays.push(ms) },
  );

  const result = await retryingFetch([
    "https://primary.example/v1/chat/completions",
    "https://backup-one.example/v1/chat/completions",
    "https://backup-two.example/v1/chat/completions",
  ]);

  assert.equal(result.status, 200);
  assert.deepEqual(calls, [
    "https://primary.example/v1/chat/completions",
    "https://backup-one.example/v1/chat/completions",
    "https://backup-two.example/v1/chat/completions",
  ]);
  assert.deepEqual(delays, [1_000, 2_000]);
});

test("retrying fetch treats a 3xx response as successful without trying fallbacks", async () => {
  const calls = [];
  const retryingFetch = createRetryingFetch(
    async (url) => {
      calls.push(url);
      return new Response("redirect", { status: 302 });
    },
    { sleep: async () => { throw new Error("must not delay"); } },
  );

  const result = await retryingFetch(["https://primary.example", "https://backup.example"]);
  assert.equal(result.status, 302);
  assert.deepEqual(calls, ["https://primary.example"]);
});

test("retrying fetch retries a network failure against the next endpoint", async () => {
  const calls = [];
  const retryingFetch = createRetryingFetch(
    async (url) => {
      calls.push(url);
      if (url.includes("primary")) throw new Error("connection refused");
      return successfulResponse();
    },
    { sleep: async () => {} },
  );

  const result = await retryingFetch(["https://primary.example", "https://backup.example"]);
  assert.equal(result.status, 200);
  assert.deepEqual(calls, ["https://primary.example", "https://backup.example"]);
});

test("retrying fetch returns a 4xx response without trying fallbacks", async () => {
  const calls = [];
  const retryingFetch = createRetryingFetch(
    async (url) => {
      calls.push(url);
      return new Response("invalid request", { status: 429 });
    },
    { sleep: async () => { throw new Error("must not delay"); } },
  );

  const result = await retryingFetch(["https://primary.example", "https://backup.example"]);
  assert.equal(result.status, 429);
  assert.deepEqual(calls, ["https://primary.example"]);
});

test("retrying fetch cancels a discarded 5xx response before trying fallback", async () => {
  let cancelled = false;
  const retryingFetch = createRetryingFetch(
    async (url) => {
      if (url.includes("primary")) {
        return {
          status: 503,
          body: { cancel: async () => { cancelled = true; } },
        };
      }
      return successfulResponse();
    },
    { sleep: async () => {} },
  );

  const result = await retryingFetch(["https://primary.example", "https://backup.example"]);
  assert.equal(result.status, 200);
  assert.equal(cancelled, true);
});

test("retrying fetch applies an independent timeout before trying fallback", async () => {
  const calls = [];
  const retryingFetch = createRetryingFetch(
    (url, init) => {
      calls.push({ url, signal: init.signal });
      if (url.includes("primary")) {
        return new Promise((_, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("timed out"), { name: "AbortError" })),
            { once: true },
          );
        });
      }
      return Promise.resolve(successfulResponse());
    },
    { timeoutMs: 5, sleep: async () => {} },
  );

  const result = await retryingFetch(["https://primary.example", "https://backup.example"]);
  assert.equal(result.status, 200);
  assert.deepEqual(calls.map((call) => call.url), ["https://primary.example", "https://backup.example"]);
  assert.equal(calls[0].signal.aborted, true);
});

test("retrying fetch uses fallback when a buffered primary body times out", async () => {
  const calls = [];
  const retryingFetch = createRetryingFetch(
    async (url, init) => {
      calls.push(url);
      if (url.includes("primary")) {
        return {
          status: 200,
          text: () => new Promise((_, reject) => {
            init.signal.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("timed out"), { name: "AbortError" })),
              { once: true },
            );
          }),
        };
      }
      return successfulResponse();
    },
    { timeoutMs: 5, sleep: async () => {} },
  );

  const result = await retryingFetch(
    ["https://primary.example", "https://backup.example"],
    {},
    { bufferResponse: true },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(calls, ["https://primary.example", "https://backup.example"]);
});

test("retrying fetch surfaces the last upstream 5xx response instead of throwing", async () => {
  const calls = [];
  const retryingFetch = createRetryingFetch(
    async (url) => {
      calls.push(url);
      return new Response("unavailable", { status: 503 });
    },
    { sleep: async () => {} },
  );

  const result = await retryingFetch(["https://primary.example", "https://backup.example"]);
  assert.equal(result.status, 503);
  assert.deepEqual(calls, ["https://primary.example", "https://backup.example"]);
});

test("retrying fetch throws only when every endpoint is a transport failure", async () => {
  const calls = [];
  const retryingFetch = createRetryingFetch(
    async (url) => {
      calls.push(url);
      throw new Error("connection refused");
    },
    { sleep: async () => {} },
  );

  await assert.rejects(
    () => retryingFetch(["https://primary.example", "https://backup.example"]),
    /connection refused/,
  );
  assert.deepEqual(calls, ["https://primary.example", "https://backup.example"]);
});

test("loadStore surfaces store-io failures as { ok:false }", (t) => {
  const paths = makePaths(t); // no store.json written
  const deps = createProductionDeps({ paths, upstreamFetch: okUpstream(t, {}) });
  const loaded = deps.loadStore();
  assert.equal(loaded.ok, false);
  assert.ok(Array.isArray(loaded.errors));
});

test("end-to-end: store load + DPAPI decrypt injects the credential into one upstream call", needsDpapi, async (t) => {
  const paths = makePaths(t);
  await writeFixture(paths);
  const captured = {};
  const deps = createProductionDeps({ paths, upstreamFetch: okUpstream(t, captured) });
  const handler = createHandler(deps);

  const result = await handler.handleMessages(
    { authorization: deps.token },
    messagesBody(),
  );

  assert.equal(result.status, 200);
  assert.equal(captured.url, "https://alpha.example/v1/chat/completions");
  assert.equal(captured.authorization, `Bearer ${PLAINTEXT}`);
  assert.equal(result.body.model, "anthropic/alpha/model-one");
});

test("production dependencies retry the configured fallback after a primary failure", needsDpapi, async (t) => {
  const paths = makePaths(t);
  await writeFixture(paths, { fallbackURLs: ["https://alpha-backup.example/v1/"] });
  const calls = [];
  const deps = createProductionDeps({
    paths,
    upstreamFetch: async (url) => {
      calls.push(url);
      if (url.includes("alpha.example")) return new Response("primary unavailable", { status: 503 });
      return successfulResponse();
    },
    retryOptions: { sleep: async () => {} },
  });
  const handler = createHandler(deps);

  const result = await handler.handleMessages({ authorization: deps.token }, messagesBody());

  assert.equal(result.status, 200);
  assert.deepEqual(calls, [
    "https://alpha.example/v1/chat/completions",
    "https://alpha-backup.example/v1/chat/completions",
  ]);
  assert.equal(result.body.content[0].text, "fallback");
});

test("production dependencies pass the upstream 5xx through after every configured endpoint fails", needsDpapi, async (t) => {
  const paths = makePaths(t);
  await writeFixture(paths, { fallbackURLs: ["https://alpha-backup.example/v1"] });
  const calls = [];
  const deps = createProductionDeps({
    paths,
    upstreamFetch: async (url) => {
      calls.push(url);
      return new Response("unavailable", { status: 503 });
    },
    retryOptions: { sleep: async () => {} },
  });
  const handler = createHandler(deps);

  const result = await handler.handleMessages({ authorization: deps.token }, messagesBody());

  // A reached upstream 5xx is passed through with its real status, not
  // collapsed to a transport 502. The upstream URL must still not leak.
  assert.equal(result.status, 503);
  assert.deepEqual(calls, [
    "https://alpha.example/v1/chat/completions",
    "https://alpha-backup.example/v1/chat/completions",
  ]);
  assert.ok(!JSON.stringify(result.body).includes("alpha-backup.example"));
});

test("missing credential file fails closed with 502 and no upstream call", async (t) => {
  const paths = makePaths(t);
  await writeFixture(paths, { sealCredential: false });
  let upstreamCalled = false;
  const deps = createProductionDeps({
    paths,
    upstreamFetch: async () => {
      upstreamCalled = true;
      throw new Error("must not be called");
    },
  });
  const handler = createHandler(deps);

  const result = await handler.handleMessages(
    { authorization: deps.token },
    messagesBody(),
  );

  assert.equal(result.status, 502);
  assert.equal(upstreamCalled, false);
  assert.equal(result.body.error.message, "the upstream credential for this provider could not be loaded");
});

test("loadCredential rejects a missing providerId or a malformed provider entry", needsDpapi, async (t) => {
  const paths = makePaths(t);
  await writeFixture(paths);
  const deps = createProductionDeps({ paths, upstreamFetch: okUpstream(t, {}) });
  const store = deps.loadStore().store;

  const noId = await deps.loadCredential("", store.providers.alpha);
  assert.equal(noId.ok, false);
  assert.equal(noId.reason, "a provider id is required to load a credential");

  const badEntry = await deps.loadCredential("alpha", { displayName: "no credentialFile" });
  assert.equal(badEntry.ok, false);
  assert.equal(badEntry.reason, "a provider entry with a credentialFile is required");
});

test("a credential that decrypts to empty is refused", needsDpapi, async (t) => {
  const paths = makePaths(t);
  writeFileSync(paths.storeFile, JSON.stringify(syntheticStore()));
  const sealed = await protect(Buffer.alloc(0), "alpha", { generation: "v2" });
  writeFileSync(join(paths.credentialsDir, "alpha.dpapi"), sealed);
  sealed.fill(0);

  const deps = createProductionDeps({ paths, upstreamFetch: okUpstream(t, {}) });
  const entry = deps.loadStore().store.providers.alpha;
  const result = await deps.loadCredential("alpha", entry);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "credential decrypted to an empty value");
});

test("concurrent requests do not steer each other's credential load", needsDpapi, async (t) => {
  // Regression for the object-identity reverse-lookup race: two independent
  // loadStore() results (distinct object graphs from JSON.parse) must both
  // resolve their own credential. A stale lastStore would have made the first
  // lookup fail once the second overwrote it.
  const paths = makePaths(t);
  await writeFixture(paths);
  const deps = createProductionDeps({ paths, upstreamFetch: okUpstream(t, {}) });

  const storeA = deps.loadStore().store;
  const storeB = deps.loadStore().store;
  assert.notEqual(storeA.providers.alpha, storeB.providers.alpha); // distinct objects

  const [a, b] = await Promise.all([
    deps.loadCredential("alpha", storeA.providers.alpha),
    deps.loadCredential("alpha", storeB.providers.alpha),
  ]);
  assert.equal(a.ok, true);
  assert.equal(a.value, PLAINTEXT);
  assert.equal(b.ok, true);
  assert.equal(b.value, PLAINTEXT);
});

test("two concurrent handleMessages calls both reach upstream with the right credential", needsDpapi, async (t) => {
  // End-to-end form of the same regression, through the real handler path that
  // interleaves loadStore() and the awaited loadCredential().
  const paths = makePaths(t);
  await writeFixture(paths);
  const seen = [];
  const deps = createProductionDeps({
    paths,
    upstreamFetch: async (url, init) => {
      seen.push(init.headers.authorization);
      return new Response(
        JSON.stringify({
          id: "chatcmpl-c",
          object: "chat.completion",
          created: 0,
          model: "model-one",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const handler = createHandler(deps);
  const headers = { authorization: deps.token };

  const [one, two] = await Promise.all([
    handler.handleMessages(headers, messagesBody()),
    handler.handleMessages(headers, messagesBody()),
  ]);

  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.deepEqual(seen, [`Bearer ${PLAINTEXT}`, `Bearer ${PLAINTEXT}`]);
});

// ---------- retry timeout: generous deadline to avoid false 502 ----------
//
// Regression for the Claude Code 502 cluster: the per-endpoint upstream timeout
// bounds fetch() resolve time. For non-streaming chat completions the upstream
// only sends headers after the FULL generation is ready, so this deadline is
// effectively the generation budget. The original 5s default aborted legitimate
// slow LLM generations and collapsed them to 502. The default must be generous
// enough to absorb real generation/TTFB latency while still failing over for a
// genuinely hanging endpoint.

test("default upstream timeout is generous enough for real LLM generation", () => {
  assert.ok(
    DEFAULT_UPSTREAM_TIMEOUT_MS >= 120_000,
    `DEFAULT_UPSTREAM_TIMEOUT_MS=${DEFAULT_UPSTREAM_TIMEOUT_MS} must be >= 120s to avoid aborting legitimate LLM generations`,
  );
});

test("startProductionRelay refuses to listen when the store is absent", async (t) => {
  const paths = makePaths(t); // empty root
  await assert.rejects(
    () => startProductionRelay({ paths }),
    /not usable/,
  );
});

test("startProductionRelay serves discovery and messages against a temp store", needsDpapi, async (t) => {
  const paths = makePaths(t);
  await writeFixture(paths);
  const captured = {};
  const relay = await startProductionRelay({ paths, upstreamFetch: okUpstream(t, captured) });
  t.after(() => relay.close());

  const base = `http://127.0.0.1:${relay.port}`;

  const hello = await fetch(`${base}/api/hello`, { method: "HEAD" });
  assert.equal(hello.status, 200);

  const anon = await fetch(`${base}/v1/models`);
  assert.equal(anon.status, 401);

  const discovery = await fetch(`${base}/v1/models`, {
    headers: { authorization: relay.token },
  });
  assert.equal(discovery.status, 200);
  const catalog = await discovery.json();
  assert.deepEqual(
    catalog.data.map((entry) => entry.id),
    ["anthropic/alpha/model-one"],
  );

  const completion = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { authorization: relay.token, "content-type": "application/json" },
    body: JSON.stringify(messagesBody()),
  });
  assert.equal(completion.status, 200);
  assert.equal(captured.authorization, `Bearer ${PLAINTEXT}`);
});

test("startProductionRelay journals request rows under the configured agentId", needsDpapi, async (t) => {
  // kimi per-launch relay 与 claude 共用这条链路：agentId 必须穿过
  // createProductionDeps → session reporter → usage journal，否则 kimi
  // 流量会被记进 claude 桶。
  const paths = makePaths(t);
  await writeFixture(paths);
  const relay = await startProductionRelay({ paths, upstreamFetch: okUpstream(t, {}), agentId: "kimi" });
  t.after(() => relay.close());

  const completion = await fetch(`http://127.0.0.1:${relay.port}/v1/messages`, {
    method: "POST",
    headers: { authorization: relay.token, "content-type": "application/json" },
    body: JSON.stringify(messagesBody()),
  });
  assert.equal(completion.status, 200);

  const journal = createUsageJournal({ dir: join(paths.root, "usage") });
  const rows = journal.readRequests();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agentId, "kimi");
});

test("startProductionRelay keeps the claude agentId default", needsDpapi, async (t) => {
  const paths = makePaths(t);
  await writeFixture(paths);
  const relay = await startProductionRelay({ paths, upstreamFetch: okUpstream(t, {}) });
  t.after(() => relay.close());

  const completion = await fetch(`http://127.0.0.1:${relay.port}/v1/messages`, {
    method: "POST",
    headers: { authorization: relay.token, "content-type": "application/json" },
    body: JSON.stringify(messagesBody()),
  });
  assert.equal(completion.status, 200);

  const journal = createUsageJournal({ dir: join(paths.root, "usage") });
  const rows = journal.readRequests();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agentId, "claude");
});
