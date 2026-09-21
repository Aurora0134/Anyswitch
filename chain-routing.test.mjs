// Deterministic unit tests for chain routing: the pure module behind virtual
// model "auto". Time is injected everywhere (`now` parameters), so every
// assertion around the 5-minute upstream retry is exact — no timers, no IO.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RETRY_UPSTREAM_MS,
  CHAIN_DEMOTE_AFTER_FAILURES,
  AUTO_MODEL,
  resolveChain,
  chainNodeExists,
  planChainAttempts,
  createChainState,
  noteChainSuccess,
  noteChainFailure,
  logChainDemote,
  expandChainNode,
  isChainFailoverStatus,
  buildChainRuntime,
  uniqueMemberId,
} from "./chain-routing.mjs";

const T0 = 1_000_000;

function makeStore() {
  return {
    version: 2,
    providers: {
      "prov-a": {
        displayName: "Provider A",
        baseURL: "https://a.example/v1",
        protocol: "openai-compatible",
        credentialFile: "a.dpapi",
        models: {
          "gpt-shared": { displayName: "Shared from A" },
          "gpt-a-only": { displayName: "A only" },
        },
      },
      "prov-b": {
        displayName: "Provider B",
        baseURL: "https://b.example/v1",
        protocol: "openai-compatible",
        credentialFile: "b.dpapi",
        models: {
          "gpt-shared": { displayName: "Shared from B" },
        },
      },
      "prov-c": {
        displayName: "Provider C",
        baseURL: "https://c.example/v1",
        protocol: "openai-compatible",
        credentialFile: "c.dpapi",
        models: {
          "gpt-c-only": { displayName: "C only" },
        },
      },
    },
    pools: {
      "pool-x": {
        displayName: "Pool X",
        members: ["prov-a", "prov-b"],
      },
      // A pool id may reuse a provider id; the pool wins the tie.
      "prov-c": {
        displayName: "Same-name pool",
        members: ["prov-a"],
      },
    },
    routingChains: {
      "ep-auto": {
        chain: [
          { node: "pool-x", model: "gpt-shared" },
          { node: "prov-a", model: "gpt-a-only" },
          { node: "prov-b", model: "gpt-shared" },
        ],
      },
      "ep-short": { chain: [{ node: "prov-c", model: "gpt-c-only" }] },
    },
  };
}

describe("resolveChain", () => {
  it("returns the chain entry for a configured endpoint", () => {
    const store = makeStore();
    assert.deepEqual(resolveChain(store, "ep-auto"), {
      chain: [
        { node: "pool-x", model: "gpt-shared" },
        { node: "prov-a", model: "gpt-a-only" },
        { node: "prov-b", model: "gpt-shared" },
      ],
    });
  });

  it("returns null for unconfigured endpoints and missing maps", () => {
    const store = makeStore();
    assert.equal(resolveChain(store, "ghost-endpoint"), null);
    assert.equal(resolveChain({ providers: {} }, "ep-auto"), null);
    assert.equal(resolveChain(null, "ep-auto"), null);
  });

  it("returns null for malformed entries without a chain array", () => {
    const store = makeStore();
    store.routingChains["ep-bad"] = { note: "no chain here" };
    assert.equal(resolveChain(store, "ep-bad"), null);
  });

  it("returns null when the endpoint's chain is disabled (enabled: false)", () => {
    // 启用开关（自动路由 per-endpoint 开关）：关 = 链配置保留但 auto 不暴露、
    // 请求也不走链。resolveChain 是所有消费方（/models 暴露、planChain*）的
    // 统一入口，开关判定收敛在这里。
    const store = makeStore();
    store.routingChains["ep-auto"].enabled = false;
    assert.equal(resolveChain(store, "ep-auto"), null);
  });

  it("treats a missing enabled flag as enabled (向后兼容：存量链行为不变)", () => {
    const store = makeStore();
    assert.ok(resolveChain(store, "ep-auto") !== null);
    store.routingChains["ep-auto"].enabled = true;
    assert.ok(resolveChain(store, "ep-auto") !== null);
  });
});

describe("planChainAttempts (pure decision)", () => {
  const chain = [
    { node: "n1", model: "m1" },
    { node: "n2", model: "m2" },
    { node: "n3", model: "m3" },
  ];

  it("starts from the chain head when there is no current state", () => {
    assert.deepEqual(planChainAttempts(chain, null, T0), chain);
  });

  it("backs off from the current node, keeping the tail entries in order", () => {
    const current = { nodeId: "n2", model: "m2", since: T0 };
    assert.deepEqual(planChainAttempts(chain, current, T0 + 1000), [
      { node: "n2", model: "m2" },
      { node: "n3", model: "m3" },
    ]);
  });

  it("does not retry upstream before RETRY_UPSTREAM_MS elapses", () => {
    const current = { nodeId: "n2", model: "m2", since: T0 };
    assert.deepEqual(planChainAttempts(chain, current, T0 + RETRY_UPSTREAM_MS - 1), [
      { node: "n2", model: "m2" },
      { node: "n3", model: "m3" },
    ]);
  });

  it("retries the whole chain from the head once RETRY_UPSTREAM_MS elapses", () => {
    const current = { nodeId: "n3", model: "m3", since: T0 };
    assert.deepEqual(planChainAttempts(chain, current, T0 + RETRY_UPSTREAM_MS), chain);
  });

  it("treats a current node that already is the head as plain order", () => {
    const current = { nodeId: "n1", model: "m1", since: T0 };
    assert.deepEqual(planChainAttempts(chain, current, T0 + 1000), chain);
  });

  it("treats a current node outside the chain as no state (from the head)", () => {
    const current = { nodeId: "ghost", model: "mx", since: T0 };
    assert.deepEqual(planChainAttempts(chain, current, T0 + 1000), chain);
  });

  it("returns an empty plan for an empty chain", () => {
    assert.deepEqual(planChainAttempts([], null, T0), []);
  });

  it("honours an overridden retry window", () => {
    const current = { nodeId: "n2", model: "m2", since: T0 };
    assert.deepEqual(planChainAttempts(chain, current, T0 + 60_000, 60_000), chain);
  });

  it("matches the current position by node+model, not by node alone", () => {
    // 同一节点绑定不同模型多次入链时，位置键必须区分两次出现。
    const shared = [
      { node: "n1", model: "m1" },
      { node: "n2", model: "m2" },
      { node: "n1", model: "m3" },
    ];
    const secondOccurrence = { nodeId: "n1", model: "m3", since: T0 };
    assert.deepEqual(planChainAttempts(shared, secondOccurrence, T0 + 1000), [{ node: "n1", model: "m3" }]);
    // 同样的 node、不同的 model 是链中另一条目，不算同一位置。
    const wrongModel = { nodeId: "n1", model: "ghost", since: T0 };
    assert.deepEqual(planChainAttempts(shared, wrongModel, T0 + 1000), shared);
  });
});

describe("chain state (sticky backoff per endpoint)", () => {
  it("holds the backoff position only after the skipped node latches as failing (失败才降级)", () => {
    const store = makeStore();
    const state = createChainState();
    const chain = resolveChain(store, "ep-auto").chain;

    // First request: no state -> from the head.
    assert.deepEqual(state.plan(store, "ep-auto", chain, T0), chain);

    // pool-x blips ONCE (a single transient fault) and prov-a answers: no
    // demotion — the next request must start from the head again (黄灯不降).
    noteChainFailure(state, "ep-auto", "pool-x", "gpt-shared");
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", T0);
    assert.deepEqual(state.plan(store, "ep-auto", chain, T0 + 1000), chain);
    assert.equal(state.get("ep-auto"), undefined, "a single blip must not latch a demotion");

    // pool-x fails a second consecutive request: NOW it is latched-failing
    // and prov-a answering demotes the chain past it.
    noteChainFailure(state, "ep-auto", "pool-x", "gpt-shared");
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", T0 + 2000);
    assert.deepEqual(state.plan(store, "ep-auto", chain, T0 + 3000), [
      { node: "prov-a", model: "gpt-a-only" },
      { node: "prov-b", model: "gpt-shared" },
    ]);
    assert.deepEqual(state.get("ep-auto"), { nodeId: "prov-a", model: "gpt-a-only", since: T0 + 2000 });
  });

  it("keeps backing off level by level across a >2 node chain", () => {
    const store = makeStore();
    const state = createChainState();
    const chain = resolveChain(store, "ep-auto").chain;
    state.plan(store, "ep-auto", chain, T0);

    noteChainFailure(state, "ep-auto", "pool-x", "gpt-shared");
    noteChainFailure(state, "ep-auto", "pool-x", "gpt-shared");
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", T0);
    // prov-a now fails twice too, prov-b answers -> only the last node remains.
    noteChainFailure(state, "ep-auto", "prov-a", "gpt-a-only");
    noteChainFailure(state, "ep-auto", "prov-a", "gpt-a-only");
    noteChainSuccess(state, "ep-auto", "prov-b", "gpt-shared", T0 + 2000);
    assert.deepEqual(state.plan(store, "ep-auto", chain, T0 + 3000), [
      { node: "prov-b", model: "gpt-shared" },
    ]);
    assert.deepEqual(state.get("ep-auto"), { nodeId: "prov-b", model: "gpt-shared", since: T0 + 2000 });
  });

  it("onDemote fires once per demotion (同一退避周期只推一条)，恢复后再次降级算新周期", () => {
    const store = makeStore();
    const events = [];
    const state = createChainState({
      onDemote: (ep, idx, nodes) => events.push({ ep, idx, len: nodes.length }),
    });
    const chain = resolveChain(store, "ep-auto").chain;
    state.plan(store, "ep-auto", chain, T0);

    // 单次抖动不降级、不触发
    noteChainFailure(state, "ep-auto", "pool-x", "gpt-shared");
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", T0);
    assert.deepEqual(events, []);

    // 锁死后降级到第 2 跳：触发一次，参数 = 端点/位次/链长
    noteChainFailure(state, "ep-auto", "pool-x", "gpt-shared");
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", T0 + 2000);
    assert.deepEqual(events, [{ ep: "ep-auto", idx: 1, len: chain.length }]);

    // 退避期间的尾部成功（原地不动）与探测重锚都不再触发
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", T0 + 60_000);
    state.plan(store, "ep-auto", chain, T0 + 2000 + RETRY_UPSTREAM_MS);
    assert.equal(events.length, 1);

    // 上游恢复（不触发）后再次降级：新退避周期，再触发一次
    noteChainSuccess(state, "ep-auto", "pool-x", "gpt-shared", T0 + 3000 + RETRY_UPSTREAM_MS);
    assert.equal(events.length, 1, "upstream recovery is not a demotion");
    noteChainFailure(state, "ep-auto", "pool-x", "gpt-shared");
    noteChainFailure(state, "ep-auto", "pool-x", "gpt-shared");
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", T0 + 5000 + RETRY_UPSTREAM_MS);
    assert.equal(events.length, 2);
  });

  it("logChainDemote 输出中文退避文案（端点/位次/模型/m:ss 窗口），logger 缺失静默", () => {
    const lines = [];
    const logger = { warn: (line) => lines.push(line) };
    const chain = resolveChain(makeStore(), "ep-auto").chain;
    logChainDemote(logger, "zcode", 1, chain);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^自动路由退避：zcode 改用第 2\/3 跳（gpt-a-only），5:00 后重试上游$/);
    logChainDemote(null, "zcode", 1, chain); // must not throw
  });

  it("tail successes never extend the upstream-retry window (持续流量下 5 分钟必回探)", () => {
    const store = makeStore();
    const state = createChainState();
    const chain = resolveChain(store, "ep-auto").chain;
    state.plan(store, "ep-auto", chain, T0);

    noteChainFailure(state, "ep-auto", "pool-x", "gpt-shared");
    noteChainFailure(state, "ep-auto", "pool-x", "gpt-shared");
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", T0);

    // prov-a keeps answering for minutes — the demotion anchor stays at T0.
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", T0 + 60_000);
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", T0 + 120_000);
    assert.deepEqual(state.get("ep-auto"), { nodeId: "prov-a", model: "gpt-a-only", since: T0 });
    assert.deepEqual(state.plan(store, "ep-auto", chain, T0 + RETRY_UPSTREAM_MS - 1), [
      { node: "prov-a", model: "gpt-a-only" },
      { node: "prov-b", model: "gpt-shared" },
    ]);
    // Exactly one window after the DEMOTION (not after the last success) the
    // chain probes from the head again.
    assert.deepEqual(state.plan(store, "ep-auto", chain, T0 + RETRY_UPSTREAM_MS), chain);
    // The probe plan re-anchors the window so a probe that walks back to the
    // tail does not expire again on the very next request.
    assert.deepEqual(state.get("ep-auto"), { nodeId: "prov-a", model: "gpt-a-only", since: T0 + RETRY_UPSTREAM_MS });
  });

  it("retries upstream from the head after 5 minutes, and a head success re-homes with the anchor cleared", () => {
    const store = makeStore();
    const state = createChainState();
    const chain = resolveChain(store, "ep-auto").chain;
    state.plan(store, "ep-auto", chain, T0);

    noteChainFailure(state, "ep-auto", "pool-x", "gpt-shared");
    noteChainFailure(state, "ep-auto", "pool-x", "gpt-shared");
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", T0);
    // 4m59s later: still backed off.
    assert.deepEqual(state.plan(store, "ep-auto", chain, T0 + RETRY_UPSTREAM_MS - 1000), [
      { node: "prov-a", model: "gpt-a-only" },
      { node: "prov-b", model: "gpt-shared" },
    ]);
    // 5m later: probe from the head again.
    const t1 = T0 + RETRY_UPSTREAM_MS;
    assert.deepEqual(state.plan(store, "ep-auto", chain, t1), chain);

    // The head answers on the probe -> sticky returns home; since clears (the
    // panel countdown disappears) and the head's failure latch resets.
    noteChainSuccess(state, "ep-auto", "pool-x", "gpt-shared", t1);
    assert.deepEqual(state.get("ep-auto"), { nodeId: "pool-x", model: "gpt-shared", since: null });
    assert.deepEqual(state.plan(store, "ep-auto", chain, t1 + 1000), chain);

    // The head blips once right after re-homing: no demotion (its counter was
    // reset by its own success — one more failure is not a latch).
    noteChainFailure(state, "ep-auto", "pool-x", "gpt-shared");
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", t1 + 2000);
    assert.deepEqual(state.plan(store, "ep-auto", chain, t1 + 3000), chain);

    // A second consecutive failure latches again, measured from the new demotion.
    noteChainFailure(state, "ep-auto", "pool-x", "gpt-shared");
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", t1 + 4000);
    assert.deepEqual(state.plan(store, "ep-auto", chain, t1 + 5000), [
      { node: "prov-a", model: "gpt-a-only" },
      { node: "prov-b", model: "gpt-shared" },
    ]);
    assert.deepEqual(state.plan(store, "ep-auto", chain, t1 + 4000 + RETRY_UPSTREAM_MS), chain);
  });

  it("lazily skips nodes that left the store, holding the backoff position", () => {
    const store = makeStore();
    const state = createChainState();
    const chain = resolveChain(store, "ep-auto").chain;
    state.plan(store, "ep-auto", chain, T0);

    noteChainFailure(state, "ep-auto", "pool-x", "gpt-shared");
    noteChainFailure(state, "ep-auto", "pool-x", "gpt-shared");
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", T0);
    // prov-a is deleted from the store; the plan must skip it without any
    // explicit invalidation call, continuing at the next live node rather
    // than re-hitting the (recently dead) head.
    delete store.providers["prov-a"];
    assert.deepEqual(state.plan(store, "ep-auto", chain, T0 + 1000), [
      { node: "prov-b", model: "gpt-shared" },
    ]);
    // The entry is kept: its position still encodes the backoff, and the
    // upstream retry window keeps running from the original since.
    assert.deepEqual(state.get("ep-auto"), { nodeId: "prov-a", model: "gpt-a-only", since: T0 });
    assert.deepEqual(state.plan(store, "ep-auto", chain, T0 + RETRY_UPSTREAM_MS), [
      { node: "pool-x", model: "gpt-shared" },
      { node: "prov-b", model: "gpt-shared" },
    ]);
  });

  it("lazily drops state whose current node left the chain itself, restarting from the head", () => {
    const store = makeStore();
    const state = createChainState();

    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", T0);
    // The endpoint is reconfigured without prov-a: the entry's position no
    // longer exists, so it is invalidated and the plan restarts from the head.
    const editedChain = [
      { node: "pool-x", model: "gpt-shared" },
      { node: "prov-b", model: "gpt-shared" },
    ];
    const plan = state.plan(store, "ep-auto", editedChain, T0 + 1000);
    assert.deepEqual(plan, editedChain);
    assert.equal(state.get("ep-auto"), undefined, "stale entry must be dropped lazily");
  });

  it("keeps state per endpoint id", () => {
    const store = makeStore();
    const state = createChainState();
    noteChainSuccess(state, "ep-auto", "prov-b", "gpt-shared", T0);
    assert.deepEqual(state.plan(store, "ep-auto", resolveChain(store, "ep-auto").chain, T0 + 1000), [
      { node: "prov-b", model: "gpt-shared" },
    ]);
    assert.deepEqual(state.plan(store, "ep-short", resolveChain(store, "ep-short").chain, T0 + 1000), [
      { node: "prov-c", model: "gpt-c-only" },
    ]);
  });

  it("distinguishes two occurrences of one node with different models (adjacent)", () => {
    // 同一节点绑定不同模型相邻入链：位置键是 node+model，两次出现互不碰撞。
    const store = makeStore();
    const state = createChainState();
    const chain = [
      { node: "prov-a", model: "gpt-a-only" },
      { node: "prov-a", model: "gpt-shared" },
      { node: "prov-b", model: "gpt-shared" },
    ];
    state.plan(store, "ep-auto", chain, T0);

    // 第一次出现连续失败两次、第二次出现应答 -> 退避到第二次出现的位置。
    noteChainFailure(state, "ep-auto", "prov-a", "gpt-a-only");
    noteChainFailure(state, "ep-auto", "prov-a", "gpt-a-only");
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-shared", T0);
    assert.deepEqual(state.plan(store, "ep-auto", chain, T0 + 1000), [
      { node: "prov-a", model: "gpt-shared" },
      { node: "prov-b", model: "gpt-shared" },
    ]);
    assert.deepEqual(state.get("ep-auto"), { nodeId: "prov-a", model: "gpt-shared", since: T0 });

    // 5 分钟重试窗口过后，探测仍从链首（第一次出现）开始。
    assert.deepEqual(state.plan(store, "ep-auto", chain, T0 + RETRY_UPSTREAM_MS), chain);
  });

  it("distinguishes two occurrences of one node with different models (interleaved)", () => {
    const store = makeStore();
    const state = createChainState();
    const chain = [
      { node: "prov-a", model: "gpt-a-only" },
      { node: "prov-b", model: "gpt-shared" },
      { node: "prov-a", model: "gpt-shared" },
    ];
    state.plan(store, "ep-auto", chain, T0);

    // 前两跳各自连续失败两次，链尾（prov-a 的第二次出现）应答：只剩它自己，
    // 不会错配到链首的第一次出现。
    noteChainFailure(state, "ep-auto", "prov-a", "gpt-a-only");
    noteChainFailure(state, "ep-auto", "prov-a", "gpt-a-only");
    noteChainFailure(state, "ep-auto", "prov-b", "gpt-shared");
    noteChainFailure(state, "ep-auto", "prov-b", "gpt-shared");
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-shared", T0);
    assert.deepEqual(state.plan(store, "ep-auto", chain, T0 + 1000), [
      { node: "prov-a", model: "gpt-shared" },
    ]);
    // 第一次出现应答则回到链首（整条链按序）。
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", T0 + 2000);
    assert.deepEqual(state.plan(store, "ep-auto", chain, T0 + 3000), chain);
  });

  it("drops state when the sticky node+model pair left the chain, even if the node stays", () => {
    // 链重排：节点还在但绑定的模型换了 -> 旧位置失效，从链首重来。
    const store = makeStore();
    const state = createChainState();
    noteChainSuccess(state, "ep-auto", "prov-a", "gpt-a-only", T0);
    const editedChain = [
      { node: "prov-a", model: "gpt-shared" },
      { node: "prov-b", model: "gpt-shared" },
    ];
    assert.deepEqual(state.plan(store, "ep-auto", editedChain, T0 + 1000), editedChain);
    assert.equal(state.get("ep-auto"), undefined, "stale entry must be dropped lazily");
  });
});

describe("expandChainNode", () => {
  it("expands a pool node, filtering members by the entry's bound model", () => {
    const store = makeStore();
    assert.deepEqual(expandChainNode(store, { node: "pool-x", model: "gpt-shared" }), {
      kind: "pool",
      poolId: "pool-x",
      memberIds: ["prov-a", "prov-b"],
      model: "gpt-shared",
    });
    assert.deepEqual(expandChainNode(store, { node: "pool-x", model: "gpt-a-only" }).memberIds, ["prov-a"]);
    assert.deepEqual(expandChainNode(store, { node: "pool-x", model: "ghost-model" }).memberIds, []);
  });

  it("drops pool members missing from providers instead of throwing", () => {
    const store = makeStore();
    store.pools["pool-x"].members.push("ghost-member");
    assert.deepEqual(expandChainNode(store, { node: "pool-x", model: "gpt-shared" }).memberIds, [
      "prov-a",
      "prov-b",
    ]);
  });

  it("identifies a plain channel node and carries the bound model", () => {
    const store = makeStore();
    assert.deepEqual(expandChainNode(store, { node: "prov-a", model: "gpt-a-only" }), {
      kind: "channel",
      providerId: "prov-a",
      model: "gpt-a-only",
    });
  });

  it("does NOT validate the bound model against the channel catalog", () => {
    const store = makeStore();
    // Catalogs shift with discovered refreshes; the store schema deliberately
    // does not hard-validate models, so expansion must not either — the
    // upstream 404s itself if it cannot serve the model.
    assert.deepEqual(expandChainNode(store, { node: "prov-a", model: "ghost-model" }), {
      kind: "channel",
      providerId: "prov-a",
      model: "ghost-model",
    });
  });

  it("lets a pool win the id tie against a same-named provider", () => {
    const store = makeStore();
    assert.deepEqual(expandChainNode(store, { node: "prov-c", model: "gpt-shared" }), {
      kind: "pool",
      poolId: "prov-c",
      memberIds: ["prov-a"],
      model: "gpt-shared",
    });
  });

  it("returns null for unknown node ids", () => {
    const store = makeStore();
    assert.equal(expandChainNode(store, { node: "ghost", model: "m" }), null);
    assert.equal(expandChainNode(null, { node: "ghost", model: "m" }), null);
  });
});

describe("chainNodeExists", () => {
  it("is true for pools and providers, false otherwise", () => {
    const store = makeStore();
    assert.equal(chainNodeExists(store, "pool-x"), true);
    assert.equal(chainNodeExists(store, "prov-a"), true);
    assert.equal(chainNodeExists(store, "prov-c"), true, "pool shadowing a provider id still exists");
    assert.equal(chainNodeExists(store, "ghost"), false);
    assert.equal(chainNodeExists(null, "pool-x"), false);
  });
});

describe("isChainFailoverStatus", () => {
  it("fails over on every pool failover status", () => {
    for (const status of [500, 502, 503, 429, 401, 403]) {
      assert.equal(isChainFailoverStatus(status), true, `status ${status}`);
    }
  });

  it("treats 404 as a node-level failure (the upstream cannot serve the bound model)", () => {
    assert.equal(isChainFailoverStatus(404), true);
  });

  it("fails over on every upstream 4xx (any rejection is a property of the node)", () => {
    for (const status of [400, 402, 404, 408, 413, 422, 499]) {
      assert.equal(isChainFailoverStatus(status), true, `status ${status}`);
    }
  });

  it("passes success statuses through (no failover on 2xx)", () => {
    for (const status of [200, 201, 204, 304]) {
      assert.equal(isChainFailoverStatus(status), false, `status ${status}`);
    }
  });
});

describe("constants", () => {
  it("exports the 5-minute upstream retry window and the auto model id", () => {
    assert.equal(RETRY_UPSTREAM_MS, 300_000);
    assert.equal(AUTO_MODEL, "auto");
  });

  it("exports the consecutive-failure demotion threshold (失败才降级)", () => {
    assert.equal(CHAIN_DEMOTE_AFTER_FAILURES, 2);
  });
});

describe("chainState.snapshot", () => {
  it("lists every remembered endpoint entry for diagnostics/panel introspection", () => {
    const state = createChainState();
    assert.deepEqual(state.snapshot(), []);
    state.noteSuccess("zcode", "chan-b", "model-b", T0);
    state.noteSuccess("kimi", "pool-x", "model-p", T0 + 5);
    assert.deepEqual(state.snapshot(), [
      { endpointId: "zcode", nodeId: "chan-b", model: "model-b", since: T0 },
      { endpointId: "kimi", nodeId: "pool-x", model: "model-p", since: T0 + 5 },
    ]);
  });
});

describe("buildChainRuntime", () => {
  const store = {
    routingChains: {
      zcode: { chain: [{ node: "chan-a", model: "model-a" }, { node: "chan-b", model: "model-b" }] },
      dsh: { chain: [] },
    },
  };

  it("no configured chains and no state -> empty endpoints map", () => {
    assert.deepEqual(buildChainRuntime({}, []), { endpoints: {} });
    assert.deepEqual(buildChainRuntime(null, null), { endpoints: {} });
  });

  it("a configured chain without any backoff record reports the chain head with since null", () => {
    const runtime = buildChainRuntime(store, []);
    assert.deepEqual(runtime.endpoints.zcode, {
      current: { node: "chan-a", model: "model-a" },
      since: null,
      retryIntervalMs: RETRY_UPSTREAM_MS,
      lamps: ["green", "gray"], // fresh start: head lit, tail gray
      positions: [], // no backoff records anywhere
    });
    // An empty configured chain has no head to report.
    assert.deepEqual(runtime.endpoints.dsh, {
      current: null,
      since: null,
      retryIntervalMs: RETRY_UPSTREAM_MS,
      lamps: [],
      positions: [],
    });
  });

  it("a backoff record reports the backed-off node+model and its since", () => {
    const state = createChainState();
    state.noteSuccess("zcode", "chan-b", "model-b", T0);
    // Enriched snapshot shape (positions + per-startup node outcomes) — what
    // the relay's runtime endpoint feeds buildChainRuntime since the lamp
    // column landed. Legacy bare-array snapshots keep working (test below).
    const runtime = buildChainRuntime(store, [{ positions: state.snapshot(), nodes: state.nodeStats() }]);
    assert.deepEqual(runtime.endpoints.zcode, {
      current: { node: "chan-b", model: "model-b" },
      since: T0,
      retryIntervalMs: RETRY_UPSTREAM_MS,
      lamps: ["gray", "green"], // only chan-b was touched this process
      positions: [{ nodeId: "chan-b", model: "model-b", since: T0 }],
    });
  });

  it("per-startup lamps: latched node red, touched node green, untouched gray; no yellow", () => {
    const state = createChainState();
    // chan-a fails twice -> latched (CHAIN_DEMOTE_AFTER_FAILURES) -> red.
    state.noteFailure("zcode", "chan-a", "model-a");
    state.noteFailure("zcode", "chan-a", "model-a");
    // chan-b answered once -> green; chan-c never touched -> gray.
    state.noteSuccess("zcode", "chan-b", "model-b", T0);
    const snap = { positions: state.snapshot(), nodes: state.nodeStats() };
    const runtime = buildChainRuntime({
      routingChains: {
        zcode: { chain: [
          { node: "chan-a", model: "model-a" },
          { node: "chan-b", model: "model-b" },
          { node: "chan-c", model: "model-c" },
        ] },
      },
    }, [snap]);
    assert.deepEqual(runtime.endpoints.zcode.lamps, ["red", "green", "gray"]);
    // Not all gray -> the head-default does NOT light chan-c.
    assert.ok(!runtime.endpoints.zcode.lamps.includes("yellow"), "no yellow tier");
  });

  it("a single transient failure stays green (黄灯不降级语义收严：慢/单闪仍算可用)", () => {
    const state = createChainState();
    state.noteFailure("zcode", "chan-a", "model-a");
    const runtime = buildChainRuntime(store, [{ positions: [], nodes: state.nodeStats() }]);
    assert.deepEqual(runtime.endpoints.zcode.lamps, ["green", "gray"]);
  });

  it("legacy bare-array snapshots still merge positions (no node stats -> head default)", () => {
    const state = createChainState();
    state.noteSuccess("zcode", "chan-b", "model-b", T0);
    const runtime = buildChainRuntime(store, [state.snapshot()]);
    assert.equal(runtime.endpoints.zcode.since, T0);
    assert.deepEqual(runtime.endpoints.zcode.lamps, ["green", "gray"]);
  });

  it("node stats merge across snapshots worst-case (any latched closure -> red)", () => {
    const ok = createChainState();
    ok.noteSuccess("zcode", "chan-a", "model-a", T0);
    const failing = createChainState();
    failing.noteFailure("zcode", "chan-a", "model-a");
    failing.noteFailure("zcode", "chan-a", "model-a");
    const runtime = buildChainRuntime(store, [
      { positions: ok.snapshot(), nodes: ok.nodeStats() },
      { positions: failing.snapshot(), nodes: failing.nodeStats() },
    ]);
    assert.deepEqual(runtime.endpoints.zcode.lamps, ["red", "gray"]);
  });

  it("merging several snapshots (multi-protocol handlers) keeps the newest entry per endpoint", () => {
    const older = createChainState();
    older.noteSuccess("zcode", "chan-a", "model-a", T0);
    const newer = createChainState();
    newer.noteSuccess("zcode", "chan-b", "model-b", T0 + 1000);
    const runtime = buildChainRuntime(store, [newer.snapshot(), older.snapshot()]);
    assert.equal(runtime.endpoints.zcode.since, T0 + 1000);
    assert.deepEqual(runtime.endpoints.zcode.current, { node: "chan-b", model: "model-b" });
  });

  it("runtime exposes the FULL positions set (multi-frontend merge no longer collapses to one current)", () => {
    // Two protocol frontends hold different sticky positions for the same
    // endpoint: `current` keeps the newest (what the chain card's countdown
    // reads), `positions` surfaces every remembered hop so nothing is hidden
    // by the single-current merge.
    const older = createChainState();
    older.noteSuccess("zcode", "chan-a", "model-a", T0);
    const newer = createChainState();
    newer.noteSuccess("zcode", "chan-b", "model-b", T0 + 1000);
    const runtime = buildChainRuntime(store, [newer.snapshot(), older.snapshot()]);
    assert.deepEqual(
      runtime.endpoints.zcode.positions,
      [
        { nodeId: "chan-b", model: "model-b", since: T0 + 1000 },
        { nodeId: "chan-a", model: "model-a", since: T0 },
      ],
    );
  });

  it("positions dedupe by node+model across snapshots keeping the newest since", () => {
    const first = createChainState();
    first.noteSuccess("zcode", "chan-a", "model-a", T0);
    const second = createChainState();
    second.noteSuccess("zcode", "chan-a", "model-a", T0 + 5000);
    const runtime = buildChainRuntime(store, [first.snapshot(), second.snapshot()]);
    assert.deepEqual(runtime.endpoints.zcode.positions, [
      { nodeId: "chan-a", model: "model-a", since: T0 + 5000 },
    ]);
  });

  it("state for an endpoint whose chain left the store still surfaces (stale but real)", () => {
    const state = createChainState();
    state.noteSuccess("ghost", "chan-a", "model-a", T0);
    const runtime = buildChainRuntime(store, [state.snapshot()]);
    assert.deepEqual(runtime.endpoints.ghost, {
      current: { node: "chan-a", model: "model-a" },
      since: T0,
      retryIntervalMs: RETRY_UPSTREAM_MS,
      lamps: [], // chain left the store -> no configured entries to light
      positions: [{ nodeId: "chan-a", model: "model-a", since: T0 }],
    });
  });

  it("excludes disabled endpoints (enabled: false): 开关关 = Flow Rail 不再显示该端点", () => {
    const disabledStore = {
      routingChains: {
        zcode: { enabled: false, chain: [{ node: "chan-a", model: "model-a" }] },
        dsh: { chain: [{ node: "chan-b", model: "model-b" }] },
      },
    };
    // 无退避记录：禁用的端点不进 runtime，未禁用的照常报链首。
    const runtime = buildChainRuntime(disabledStore, []);
    assert.equal(runtime.endpoints.zcode, undefined);
    assert.deepEqual(runtime.endpoints.dsh.current, { node: "chan-b", model: "model-b" });

    // 有退避记录也一样：禁用端点的残留状态不再浮现（链已停走，状态是历史）。
    const state = createChainState();
    state.noteSuccess("zcode", "chan-a", "model-a", T0);
    const withState = buildChainRuntime(disabledStore, [state.snapshot()]);
    assert.equal(withState.endpoints.zcode, undefined);
    assert.deepEqual(Object.keys(withState.endpoints), ["dsh"]);
  });
});


describe("uniqueMemberId", () => {
  it("first occurrence keeps the base id, a collision gets the `#<model>` suffix", () => {
    const taken = new Map();
    const first = uniqueMemberId(taken, "chan-a", "model-a");
    taken.set(first, {});
    const second = uniqueMemberId(taken, "chan-a", "model-a2");
    assert.equal(first, "chan-a");
    assert.equal(second, "chan-a#model-a2");
  });

  it("accepts any has()-shaped collection (Set works too)", () => {
    const taken = new Set(["pool-x/m1"]);
    assert.equal(uniqueMemberId(taken, "pool-x/m1", "model-p"), "pool-x/m1#model-p");
    assert.equal(uniqueMemberId(taken, "pool-x/m2", "model-p"), "pool-x/m2");
  });
});
