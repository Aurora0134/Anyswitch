// 档位映射 (Claude Code tier entries) on the relay path: handler-level refusal /
// takeover behaviour plus real loopback requests against both relay frontends
// with a recording mock upstream. Synthetic store only — no real credentials, no
// DPAPI, no network egress. The settings root is redirected to an empty temp
// dir at load and the effort injector plus both image gates are fixed thunks,
// so nothing on the request path touches the real user profile either.
//
// The load-bearing assertions are (1) what the UPSTREAM is asked for and what
// the tracker is told, which must both be the hosted model and never the entry
// name, and (2) every refusal staying a refusal.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createHandler } from "./handler.mjs";
import { createRelayServer, listenLoopback as listenPerLaunch } from "./server.mjs";
import { createOpenAIRelayServer, listenLoopback as listenResident, DEFAULT_RELAY_PORT } from "./openai-server.mjs";
import { wireIdToStatModel, wireIdToTargetId } from "./wire-id.mjs";
import { createEffortInjector } from "./effort-injection.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

// 最后一条通向真实用户目录的路：mid-system 改写开关在 anthropicToOpenAI 里现读
// settings.json 而 handler 没有给它注入面（handler.mjs 调它时不传 options），图片
// 两门之外的其余 relay-settings 默认门同理。store / 凭据 / 上游 / 档位映射已经全
// 部注入，这里再把三个基础目录整体重定向到空临时目录——node --test 每个文件独
// 立进程，不影响其他测试文件；设置读取落空按默认值处理，与此前本机键缺失时的
// 出网语义一致，本文件不再随宿主机 settings 与 effort db 漂移。
const settingsBase = mkTestDir("anys-tier-relay-settings-");
process.env.LOCALAPPDATA = settingsBase;
process.env.APPDATA = settingsBase;
process.env.USERPROFILE = settingsBase;

const TOKEN = "test-token-claude-tier-mapping";

function syntheticStore() {
  return {
    version: 2,
    providers: {
      "host-a": {
        displayName: "Host A",
        baseURL: "http://host-a.invalid/v1",
        protocol: "openai-compatible",
        credentialFile: "host-a.dpapi",
        models: {
          "kimi-k3": { displayName: "Kimi K3" },
          "glm-5.3": { displayName: "GLM 5.3" },
          "deepseek-sonnet-mini": { displayName: "DeepSeek Sonnet Mini" },
        },
      },
      "host-b": {
        displayName: "Host B",
        baseURL: "http://host-b.invalid/v1",
        protocol: "openai-compatible",
        credentialFile: "host-b.dpapi",
        models: {
          "flash-lite": { displayName: "Flash Lite" },
          "claude-sonnet-dup": { displayName: "Dup Sonnet (B)" },
          "glm-twin": { displayName: "GLM Twin (B)" },
        },
      },
      "host-c": {
        displayName: "Host C",
        baseURL: "http://host-c.invalid/v1",
        protocol: "openai-compatible",
        credentialFile: "host-c.dpapi",
        models: {
          // Same model name as host-b: ambiguous on purpose. It is Claude's
          // default-model shape, so a mapped tier takes it over; unmapped, the
          // refusal points at the row.
          "claude-sonnet-dup": { displayName: "Dup Sonnet (C)" },
          // Ambiguous like the one above but not a tier entry: no takeover may
          // touch it, the plain multiple-provider refusal owns it.
          "glm-twin": { displayName: "GLM Twin (C)" },
          // Unique to this provider, tier-worded but NOT Claude's vocabulary
          // (no claude- family): a resolvable bare name outside the four tier
          // entries is never steered, mapped sonnet row or not.
          "solo-sonnet-mini": { displayName: "Solo Sonnet Mini" },
        },
      },
    },
    pools: {
      "tier-pool": { displayName: "Tier Pool", members: ["host-a", "host-b"] },
    },
  };
}

const DEFAULT_MAPPINGS = {
  sonnet: "anthropic/host-a/kimi-k3",
  opus: "anthropic/host-a/glm-5.3",
  haiku: "anthropic/host-b/flash-lite",
};

// Records one upstream call per request: { host, model } as translated outbound.
function makeDeps({ mappings = DEFAULT_MAPPINGS, store = syntheticStore(), ...overrides } = {}) {
  const sent = [];
  const logs = [];
  let generation = null;
  const handler = createHandler({
    token: TOKEN,
    loadStore: () => ({ ok: true, store }),
    loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
    upstreamFetch: async (urls, init) => {
      sent.push({ host: new URL(Array.isArray(urls) ? urls[0] : urls).host.split(".")[0], ...JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "cmpl-1",
          model: "ignored",
          choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
      };
    },
    recordGeneration: (value) => { generation = value; },
    readGeneration: () => generation,
    logger: {
      info: (message) => logs.push({ level: "info", message }),
      warn: (message) => logs.push({ level: "warn", message }),
      error: (message) => logs.push({ level: "error", message }),
    },
    getClaudeTierMapping: () => mappings,
    // 隔离：effort 注入与图片两门给死值（同 relay.test.mjs / openai-handler.test.mjs
    // 的注入做法）。本文件断言不涉及推理强度与图片，宿主机的 settings 键与
    // thinking-efforts.db.json 都不得影响出网 body 或任何用例结果。
    effortInjector: createEffortInjector({ isEnabled: () => false, catalog: { models: new Map() } }),
    imageFallbackGate: () => false,
    imageHeuristicGate: () => false,
    ...overrides,
  });
  return { handler, sent, logs };
}

const AUTH = { authorization: TOKEN };

function messagesBody(model, extra = {}) {
  return { model, max_tokens: 16, messages: [{ role: "user", content: "hi" }], ...extra };
}

// Drive the full pre-flight sequence exactly as both relay frontends order it:
// takeover, then the strict path with the (possibly rewritten) body.
async function relayMessages(handler, body, agentId) {
  await handler.planTierEntryMessages(AUTH, body, agentId);
  return handler.handleMessages(AUTH, body, { agentId });
}

describe("handler: takeover rewrites the name before routing", () => {
  it("maps a bare tier word onto its hosted model, upstream and response included", async () => {
    const { handler, sent } = makeDeps();
    const body = messagesBody("sonnet");
    const out = await relayMessages(handler, body, "claude");

    assert.equal(out.status, 200);
    assert.equal(body.model, "anthropic/host-a/kimi-k3");
    assert.equal(sent[0].model, "kimi-k3", "the upstream must never see the entry name");
    // Journal / stability attribution keys off the same field.
    assert.equal(wireIdToStatModel(body.model), "kimi-k3");
    assert.equal(wireIdToTargetId(body.model), "host-a");
    // The echoed response model is the destination too.
    assert.equal(out.body.model, "anthropic/host-a/kimi-k3");
  });

  it("maps Anthropic official ids by their tier, dated or not", async () => {
    for (const [entry, expected] of [
      ["claude-sonnet-4-5-20250929", "kimi-k3"],
      ["claude-opus-5", "glm-5.3"],
      ["claude-haiku-4-5", "flash-lite"],
      ["anthropic.claude-sonnet-4-5", "kimi-k3"],
      ["sonnet[1m]", "kimi-k3"],
      ["Sonnet[1M]", "kimi-k3"],
    ]) {
      const { handler, sent } = makeDeps();
      await relayMessages(handler, messagesBody(entry), "claude");
      assert.equal(sent[0].model, expected, `${entry} should land on ${expected}`);
    }
  });

  it("logs one single-line takeover record naming both sides", async () => {
    const { handler, logs } = makeDeps();
    await relayMessages(handler, messagesBody("claude-opus-5"), "claude");
    const takeover = logs.filter((line) => line.message.includes("档位映射接管"));
    assert.equal(takeover.length, 1);
    assert.match(takeover[0].message, /claude-opus-5/);
    assert.match(takeover[0].message, /anthropic\/host-a\/glm-5\.3/);
    assert.match(takeover[0].message, /Opus/);
  });

  it("takes over a claude-family name that is ambiguous across channels", async () => {
    // The default-model shape Claude actually sends: an official id several
    // channels carry. The sonnet row is the operator's disambiguation of it,
    // never a guess between the channels that happen to have the name.
    const { handler, sent } = makeDeps();
    const body = messagesBody("claude-sonnet-dup");
    const out = await relayMessages(handler, body, "claude");

    assert.equal(out.status, 200);
    assert.equal(sent[0].model, "kimi-k3", "the mapped destination, never a guessed channel");
    assert.equal(out.body.model, "anthropic/host-a/kimi-k3");
  });

  it("takes over a tier-entry name a channel really carries, pool-resolved", async () => {
    // The 2026-10-07 incident shape: Claude Code 2.1.292 resolves the Opus
    // picker to the concrete id "claude-opus-5-5", and one pool member
    // carries that exact name, so the unqualified scan resolves the bare name
    // through the pool. The name is still unmistakably Claude's tier
    // vocabulary: the operator's mapped row owns the tier, not the collision.
    const store = syntheticStore();
    store.providers["host-a"].models["claude-opus-5-5"] = { displayName: "Claude Opus 5.5 (A)" };
    const { handler, sent, logs } = makeDeps({ store });
    const body = messagesBody("claude-opus-5-5");
    const out = await relayMessages(handler, body, "claude");

    assert.equal(out.status, 200);
    assert.equal(body.model, "anthropic/host-a/glm-5.3");
    assert.equal(sent[0].model, "glm-5.3", "the upstream must never see the tier-entry name");
    assert.equal(sent[0].host, "host-a", "the mapped channel, not the colliding pool");
    assert.equal(logs.filter((line) => line.message.includes("档位映射接管")).length, 1);
  });

  it("takes over a tier-entry name a channel really carries, provider-resolved", async () => {
    // Same collision under a non-pool channel: the scan resolves the bare
    // name to one provider, and the mapped tier still outranks the hit.
    const store = syntheticStore();
    store.providers["host-c"].models["claude-opus-5-5"] = { displayName: "Claude Opus 5.5 (C)" };
    const { handler, sent } = makeDeps({ store });
    const out = await relayMessages(handler, messagesBody("claude-opus-5-5"), "claude");

    assert.equal(out.status, 200);
    assert.equal(sent[0].model, "glm-5.3");
  });

  it("keeps serving a resolvable tier-entry name when its tier is unmapped", async () => {
    // The strict hit stays the fallback: with no honest destination for the
    // tier, the channel that carries the name serves it exactly as before.
    const store = syntheticStore();
    store.providers["host-c"].models["claude-opus-5-5"] = { displayName: "Claude Opus 5.5 (C)" };
    const { handler, sent, logs } = makeDeps({ store, mappings: { sonnet: DEFAULT_MAPPINGS.sonnet } });
    const out = await relayMessages(handler, messagesBody("claude-opus-5-5"), "claude");

    assert.equal(out.status, 200);
    assert.equal(sent[0].model, "claude-opus-5-5");
    assert.equal(logs.some((line) => line.message.includes("接管")), false);
  });

  it("takes nothing over for a resolvable name that is not Claude's vocabulary", async () => {
    const { handler, sent, logs } = makeDeps();
    // Registered on exactly one provider, and its name carries a tier word:
    // the unqualified scan owns it, and the sonnet row must not steal it.
    const out = await relayMessages(handler, messagesBody("solo-sonnet-mini"), "claude");
    assert.equal(out.status, 200);
    assert.equal(sent[0].host, "host-c");
    assert.equal(sent[0].model, "solo-sonnet-mini");
    assert.equal(logs.some((line) => line.message.includes("接管")), false);
  });

  it("takes nothing over for a full wire ID, even one whose model segment names a tier", async () => {
    const { handler, sent } = makeDeps();
    const out = await relayMessages(handler, messagesBody("anthropic/host-a/deepseek-sonnet-mini"), "claude");
    assert.equal(out.status, 200);
    assert.equal(sent[0].model, "deepseek-sonnet-mini");
  });

  it("reads the mapping only when a name actually needs it", async () => {
    let reads = 0;
    const { handler } = makeDeps({ getClaudeTierMapping: () => { reads += 1; return DEFAULT_MAPPINGS; } });
    await relayMessages(handler, messagesBody("anthropic/host-a/kimi-k3"), "claude");
    assert.equal(reads, 0, "a well-formed wire ID must cost no settings read");
    await relayMessages(handler, messagesBody("opus"), "claude");
    assert.equal(reads, 1);
  });
});

describe("handler: every refusal stays a refusal", () => {
  it("an unmapped tier says which row to fill", async () => {
    const { handler, sent, logs } = makeDeps({ mappings: { sonnet: DEFAULT_MAPPINGS.sonnet } });
    const out = await relayMessages(handler, messagesBody("claude-fable-5"), "claude");

    assert.equal(out.status, 400);
    assert.equal(sent.length, 0);
    assert.match(out.body.error.message, /Fable tier/);
    assert.match(out.body.error.message, /not mapped/);
    assert.match(out.body.error.message, /设置 · 通用 · Claude Code/);
    assert.equal(logs.filter((line) => line.level === "warn" && line.message.includes("未接管")).length, 1);
  });

  it("a broken mapping target is reported as the misconfigured row, not an outage", async () => {
    const { handler, sent } = makeDeps({ mappings: { sonnet: "claude-sonnet-4-5-20250929" } });
    const out = await relayMessages(handler, messagesBody("sonnet"), "claude");

    assert.equal(out.status, 400);
    assert.equal(sent.length, 0);
    assert.match(out.body.error.message, /mapping target/);
    assert.match(out.body.error.message, /claude-sonnet-4-5-20250929/);
  });

  it("keeps the strict contract's own advice for names that are not tiers", async () => {
    const { handler, sent } = makeDeps();
    const out = await relayMessages(handler, messagesBody("gpt-5-codex"), "claude");
    assert.equal(out.status, 400);
    assert.equal(sent.length, 0);
    assert.match(out.body.error.message, /is not registered in this relay/);

    // Ambiguous across channels and not a tier entry: several real models,
    // only the operator knows — the plain refusal, no takeover vocabulary.
    const ambiguous = await relayMessages(handler, messagesBody("glm-twin"), "claude");
    assert.equal(ambiguous.status, 400);
    assert.match(ambiguous.body.error.message, /multiple relay providers/);
  });

  it("an ambiguous tier-entry name whose tier is unmapped points at the row", async () => {
    const { handler, sent } = makeDeps({ mappings: { opus: DEFAULT_MAPPINGS.opus } });
    const out = await relayMessages(handler, messagesBody("claude-sonnet-dup"), "claude");

    assert.equal(out.status, 400);
    assert.equal(sent.length, 0);
    assert.match(out.body.error.message, /Sonnet tier/);
    assert.match(out.body.error.message, /not mapped/);
  });

  it("refuses the virtual model and the endpoint's own vocabulary", async () => {
    const { handler } = makeDeps();
    for (const model of ["auto", "<synthetic>", ""]) {
      const out = await relayMessages(handler, messagesBody(model), "claude");
      assert.notEqual(out.status, 200, `${model} must not be taken over`);
    }
  });

  it("a takeover request carries no forged log lines", async () => {
    const { handler, logs } = makeDeps({ mappings: { sonnet: "sonnet\n[info] fake entry" } });
    const out = await relayMessages(handler, messagesBody("sonnet"), "claude");
    assert.equal(out.status, 400);
    for (const line of logs) assert.equal(line.message.includes("\n"), false);
  });
});

describe("endpoint gating: only the Claude relay consults the mapping", () => {
  it("another endpoint on the same handler keeps the strict answer", async () => {
    for (const agentId of ["kimi", "opencode", undefined]) {
      const { handler, sent } = makeDeps();
      const out = await relayMessages(handler, messagesBody("sonnet"), agentId);
      assert.equal(out.status, 400, `${agentId} must not be taken over`);
      assert.equal(sent.length, 0);
      assert.match(out.body.error.message, /not registered in this relay/);
    }
  });
});

// ---------- loopback: what the frontends actually order and attribute ----------

function relayDeps({ agentId, mappings = DEFAULT_MAPPINGS, upstreamFetch, metricsCollector, store = syntheticStore() }) {
  return {
    token: TOKEN,
    agentId,
    loadStore: () => ({ ok: true, store }),
    loadCredential: async () => ({ ok: true, value: "TEST_SECRET" }),
    upstreamFetch,
    recordGeneration: () => {},
    readGeneration: () => null,
    getClaudeTierMapping: () => mappings,
    // 与 makeDeps 同一套隔离：两个 relay 前端都把 deps 原样交给 createHandler。
    effortInjector: createEffortInjector({ isEnabled: () => false, catalog: { models: new Map() } }),
    imageFallbackGate: () => false,
    imageHeuristicGate: () => false,
    metricsCollector,
  };
}

function recordingUpstream(calls) {
  return async (urls, init) => {
    calls.push({ host: new URL(Array.isArray(urls) ? urls[0] : urls).host.split(".")[0], ...JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        id: "cmpl-1",
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

// 虚拟模型：Anyswitch 自建的命名路由链，不绑定端点。目录 id 与 auto 同造法
// 「anthropic/<名字>」（前缀段内无 '/'，永不与真 wire id 相撞），中继按它自己
// 的链路由。档位接管可以直接改投它。
function storeWithVirtualModel(name, chain, extra = {}) {
  const store = syntheticStore();
  store.virtualModels = [{ name, chain, ...extra }];
  return store;
}

async function post(port, model, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { authorization: TOKEN, "content-type": "application/json", ...headers },
    body: JSON.stringify(messagesBody(model, { stream: false })),
  });
}

describe("per-launch relay", () => {
  it("serves a tier name on the hosted model and reports it as such", async () => {
    const calls = [];
    const server = createRelayServer(relayDeps({ agentId: "claude", upstreamFetch: recordingUpstream(calls) }));
    const { port, close } = await listenPerLaunch(server);
    try {
      const res = await post(port, "claude-sonnet-4-5-20250929");
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(calls[0].model, "kimi-k3");
      assert.equal(calls[0].host, "host-a");
      assert.equal(payload.model, "anthropic/host-a/kimi-k3");
    } finally {
      await close();
    }
  });

  it("fans a pool destination out to pool members, i.e. takeover really precedes the pool plan", async () => {
    const calls = [];
    const server = createRelayServer(
      relayDeps({
        agentId: "claude",
        mappings: { sonnet: "anthropic/tier-pool/kimi-k3" },
        upstreamFetch: recordingUpstream(calls),
      }),
    );
    const { port, close } = await listenPerLaunch(server);
    try {
      const res = await post(port, "sonnet");
      assert.equal(res.status, 200);
      assert.equal(calls[0].host, "host-a", "the pool's first member serves it");
    } finally {
      await close();
    }
  });

  it("档位改投虚拟模型：走该虚拟模型自己的链，上游拿到链节点绑定的模型", async () => {
    // 档位行指向 Anyswitch 自建的虚拟模型：接管把模型名改写成它的目录 id，
    // 链规划随即接手（目录别名归一为裸名后按该链路由），上游只见到节点绑定的
    // 模型——虚拟模型名本身永远不出网。
    const calls = [];
    const server = createRelayServer(
      relayDeps({
        agentId: "claude",
        store: storeWithVirtualModel("my-vm", [{ node: "host-a", model: "kimi-k3" }]),
        mappings: { sonnet: "anthropic/my-vm" },
        upstreamFetch: recordingUpstream(calls),
      }),
    );
    const { port, close } = await listenPerLaunch(server);
    try {
      const res = await post(port, "sonnet");
      assert.equal(res.status, 200);
      assert.equal(calls[0].model, "kimi-k3", "上游拿到的是链节点绑定的模型，不是虚拟模型名");
      assert.equal(calls[0].host, "host-a", "由虚拟模型链的第一个节点应答");
    } finally {
      await close();
    }
  });

  it("目标虚拟模型被停用或不存在时仍是坏行：400 指向那一行，不静默改投别处", async () => {
    for (const [label, store] of [
      ["已停用", storeWithVirtualModel("my-vm", [{ node: "host-a", model: "kimi-k3" }], { enabled: false })],
      ["不存在", syntheticStore()],
    ]) {
      const calls = [];
      const server = createRelayServer(
        relayDeps({
          agentId: "claude",
          store,
          mappings: { sonnet: "anthropic/my-vm" },
          upstreamFetch: recordingUpstream(calls),
        }),
      );
      const { port, close } = await listenPerLaunch(server);
      try {
        const res = await post(port, "sonnet");
        assert.equal(res.status, 400, `${label}的虚拟模型必须被拒`);
        assert.equal(calls.length, 0, `${label}的虚拟模型不得触达上游`);
        assert.match((await res.json()).error.message, /mapping target/);
      } finally {
        await close();
      }
    }
  });

  it("a kimi relay of the same build never enters the mapping", async () => {
    const calls = [];
    const server = createRelayServer(relayDeps({ agentId: "kimi", upstreamFetch: recordingUpstream(calls) }));
    const { port, close } = await listenPerLaunch(server);
    try {
      const res = await post(port, "sonnet");
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0);
      assert.match((await res.json()).error.message, /not registered in this relay/);
    } finally {
      await close();
    }
  });
});

describe("resident relay", () => {
  it("takes over only for a Claude-attributed request", async () => {
    for (const [headers, expectServed] of [
      [{ "x-agent-id": "claude" }, true],
      [{ "user-agent": "claude-cli/2.1.280 (external, cli)" }, true],
      [{ "x-agent-id": "kimi" }, false],
      [{}, false],
    ]) {
      const calls = [];
      const server = createOpenAIRelayServer(
        relayDeps({ upstreamFetch: recordingUpstream(calls), metricsCollector: null }),
      );
      const { port, close } = await listenResident(server, 0);
      // 0 是必须的：listenResident 的默认端口就是生产常驻中继的 DEFAULT_RELAY_PORT，
      // 而端口被自家中继占用时它会「复用」并返回那个端口——漏传 0 的测试会把请求
      // 直接打进正在服务的中继，且负分支在真中继上同样 400 + 零上游调用，其余断
      // 言抓不住。对照量用导出常量而不是硬编码端口：默认端口漂移时这条绊线跟着走。
      assert.notEqual(port, DEFAULT_RELAY_PORT, "a test must never land on the live resident relay");
      try {
        const res = await post(port, "opus", headers);
        if (expectServed) {
          assert.equal(res.status, 200, `${JSON.stringify(headers)} should be served`);
          assert.equal(calls[0].model, "glm-5.3");
        } else {
          assert.equal(res.status, 400, `${JSON.stringify(headers)} must not be taken over`);
          assert.equal(calls.length, 0);
        }
      } finally {
        await close();
      }
    }
  });
});
