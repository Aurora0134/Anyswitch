import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIHandler } from "../src/relay/openai-handler.mjs";
import { createOpenAIRelayServer, listenLoopback } from "../src/relay/openai-server.mjs";
import { createEffortInjector } from "../src/catalog/effort-injection.mjs";

const TOKEN = "test-token-lb";
const PATH = "/openai/test-pool/v1/chat/completions";
const HEADERS = { authorization: TOKEN };
const BODY = { model: "gpt-pool", messages: [{ role: "user", content: "hi" }] };

const STORE = {
  version: 2,
  providers: {
    "member-a": { displayName: "A", baseURL: "http://member-a.invalid/v1", protocol: "openai-compatible", credentialFile: "a.dpapi", models: { "gpt-pool": { displayName: "Pool" } } },
    "member-b": { displayName: "B", baseURL: "http://member-b.invalid/v1", protocol: "openai-compatible", credentialFile: "b.dpapi", models: { "gpt-pool": { displayName: "Pool" } } },
    "member-c": { displayName: "C", baseURL: "http://member-c.invalid/v1", protocol: "openai-compatible", credentialFile: "c.dpapi", models: { "gpt-pool": { displayName: "Pool" } } },
  },
  pools: {
    "test-pool": { displayName: "Test Pool", members: ["member-a", "member-b", "member-c"] },
  },
};

const offEffort = () => createEffortInjector({ isEnabled: () => false });

function makeHandler({ gate = () => true, upstream = null } = {}) {
  return createOpenAIHandler({
    token: TOKEN,
    loadStore: () => ({ ok: true, store: STORE }),
    loadCredential: async () => ({ ok: true, value: "sk-test" }),
    upstreamFetch: async () => upstream,
    effortInjector: offEffort(),
    recordGeneration: () => {},
    readGeneration: () => null,
    poolLoadBalancingGate: gate,
  });
}

const plan = (handler, sessionKey = null) => handler.planPoolChatCompletions(PATH, HEADERS, BODY, sessionKey);
const ids = (members) => members.map((member) => member.memberId);

describe("pool load balancing — plan mode", () => {
  it("exposes in-flight hooks only when enabled", async () => {
    const on = await plan(makeHandler({ gate: () => true }));
    assert.equal(typeof on.beginMember, "function");
    assert.equal(typeof on.endMember, "function");
    const off = await plan(makeHandler({ gate: () => false }));
    assert.equal(off.beginMember, undefined);
    assert.equal(off.endMember, undefined);
  });

  it("spreads concurrent requests across members", async () => {
    const handler = makeHandler();
    const first = await plan(handler);
    assert.equal(ids(first.members)[0], "member-a");
    first.beginMember("member-a");
    const second = await plan(handler);
    assert.equal(ids(second.members)[0], "member-b");
    second.beginMember("member-b");
    const third = await plan(handler);
    assert.equal(ids(third.members)[0], "member-c");
  });

  it("keeps a session on its answering member", async () => {
    const handler = makeHandler();
    const first = await plan(handler, "sess-1");
    first.noteSuccess("member-b", 1000);
    const again = await plan(handler, "sess-1");
    assert.equal(ids(again.members)[0], "member-b");
    const other = await plan(handler, "sess-2");
    assert.equal(ids(other.members)[0], "member-a");
  });

  it("latches a failing member to the back", async () => {
    const handler = makeHandler();
    const p = await plan(handler);
    p.noteFailure("member-a");
    p.noteFailure("member-a");
    const next = await plan(handler);
    assert.equal(ids(next.members)[0], "member-b");
    assert.equal(ids(next.members)[2], "member-a");
  });

  it("weights by quality (slow first token lowers weight)", async () => {
    const handler = makeHandler();
    const p = await plan(handler);
    for (let i = 0; i < 6; i += 1) p.noteSuccess("member-a", 20000); // slow → poor quality
    for (let i = 0; i < 6; i += 1) p.noteSuccess("member-b", 1000); // fast → high quality
    const next = await plan(handler);
    assert.equal(ids(next.members)[0], "member-b");
  });

  it("falls back to sticky routing when disabled", async () => {
    const handler = makeHandler({ gate: () => false });
    const p = await plan(handler);
    p.noteFailure("member-a");
    p.noteFailure("member-a"); // latch the head
    p.noteSuccess("member-b"); // sticky demotes past the latched head to b
    const next = await plan(handler);
    assert.equal(ids(next.members)[0], "member-b");
  });

  it("honours a mid-life mode switch", async () => {
    let enabled = false;
    const handler = makeHandler({ gate: () => enabled });
    const sticky = await plan(handler);
    sticky.noteSuccess("member-a"); // stick the head
    assert.equal(ids((await plan(handler)).members)[0], "member-a");
    enabled = true;
    const lb = await plan(handler);
    assert.equal(typeof lb.beginMember, "function");
    lb.beginMember("member-a");
    assert.equal(ids((await plan(handler)).members)[0], "member-b"); // spread
  });
});

describe("pool load balancing — chain pool node", () => {
  const CHAIN_STORE = {
    ...STORE,
    routingChains: { zcode: { chain: [{ node: "test-pool", model: "gpt-pool" }] } },
  };
  function makeChainHandler(gate) {
    return createOpenAIHandler({
      token: TOKEN,
      loadStore: () => ({ ok: true, store: CHAIN_STORE }),
      loadCredential: async () => ({ ok: true, value: "sk-test" }),
      upstreamFetch: async () => null,
      effortInjector: offEffort(),
      recordGeneration: () => {},
      readGeneration: () => null,
      poolLoadBalancingGate: gate,
    });
  }
  const chainPlan = (handler, sessionKey = null) =>
    handler.planChainChatCompletions(PATH, HEADERS, { model: "auto", messages: [] }, "zcode", sessionKey);

  it("balances pool members inside a chain node when enabled", async () => {
    const handler = makeChainHandler(() => true);
    const first = await chainPlan(handler);
    assert.equal(typeof first.beginMember, "function");
    first.beginMember(first.members[0].memberId);
    const second = await chainPlan(handler);
    assert.notEqual(second.members[0].memberId, first.members[0].memberId);
  });

  it("keeps chain pool nodes sticky when disabled", async () => {
    const handler = makeChainHandler(() => false);
    const first = await chainPlan(handler);
    assert.equal(first.beginMember, undefined);
  });
});

describe("pool load balancing — server concurrency", () => {
  function slowRouter() {
    const calls = [];
    const pending = [];
    let notify = null;
    const reached = new Promise((resolve) => { notify = resolve; });
    const upstreamFetch = (urls) => {
      const url = Array.isArray(urls) ? urls[0] : urls;
      const memberId = new URL(url).host.split(".")[0];
      calls.push(memberId);
      if (calls.length === 3) notify();
      return new Promise((resolve) => {
        pending.push(() => resolve(new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } })));
      });
    };
    return { upstreamFetch, calls, reached, releaseAll: () => pending.splice(0).forEach((release) => release()) };
  }

  function serverDeps(router, gate) {
    return {
      token: TOKEN,
      loadStore: () => ({ ok: true, store: STORE }),
      loadCredential: async () => ({ ok: true, value: "sk-test" }),
      upstreamFetch: router.upstreamFetch,
      effortInjector: offEffort(),
      recordGeneration: () => {},
      readGeneration: () => null,
      getKeepAliveConfig: () => ({ enabled: false, maxRetries: 0, backoffMs: 0 }),
      poolLoadBalancingGate: gate,
    };
  }

  async function fireThree(port) {
    const post = () => fetch(`http://127.0.0.1:${port}/openai/test-pool/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: TOKEN, "content-type": "application/json", "x-agent-id": "zcode" },
      body: JSON.stringify({ model: "gpt-pool", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    const requests = [post(), post(), post()];
    return requests;
  }

  it("spreads three concurrent requests across three members when enabled", async () => {
    const router = slowRouter();
    const server = createOpenAIRelayServer(serverDeps(router, () => true));
    const { port, close } = await listenLoopback(server, 0);
    try {
      const requests = await fireThree(port);
      await router.reached;
      assert.equal(router.calls.length, 3);
      assert.equal(new Set(router.calls).size, 3, `expected spread, got ${router.calls.join(",")}`);
      router.releaseAll();
      await Promise.all(requests);
    } finally {
      await close();
    }
  });

  it("pins all three concurrent requests to the sticky head when disabled", async () => {
    const router = slowRouter();
    const server = createOpenAIRelayServer(serverDeps(router, () => false));
    const { port, close } = await listenLoopback(server, 0);
    try {
      const requests = await fireThree(port);
      await router.reached;
      assert.deepEqual(router.calls, ["member-a", "member-a", "member-a"]);
      router.releaseAll();
      await Promise.all(requests);
    } finally {
      await close();
    }
  });
});