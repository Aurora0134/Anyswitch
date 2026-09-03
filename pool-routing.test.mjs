import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isPoolFailoverStatus,
  resolvePool,
  poolMembersWithModel,
  poolModelsUnion,
  createStickyTable,
  POOL_DEMOTE_AFTER_FAILURES,
} from "./pool-routing.mjs";

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
          "gpt-shared": { displayName: "Shared from A", contextWindow: 1000 },
          "gpt-a-only": { displayName: "A only" },
        },
      },
      "prov-b": {
        displayName: "Provider B",
        baseURL: "https://b.example/v1",
        protocol: "openai-compatible",
        credentialFile: "b.dpapi",
        models: {
          "gpt-shared": { displayName: "Shared from B", contextWindow: 2000 },
          "gpt-b-only": { displayName: "B only" },
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
      "test-pool": {
        displayName: "Test Pool",
        members: ["prov-a", "prov-b", "prov-c"],
      },
      // A pool id may reuse the id of one of its own members.
      "prov-a": {
        displayName: "Same-name pool",
        members: ["prov-a", "prov-b"],
      },
    },
  };
}

describe("isPoolFailoverStatus", () => {
  it("treats channel-level faults as failover", () => {
    for (const status of [500, 502, 503, 522, 429, 401, 403]) {
      assert.equal(isPoolFailoverStatus(status), true, `status ${status}`);
    }
  });

  it("keeps request-shaped 4xx terminal", () => {
    for (const status of [400, 404, 422, 409, 413]) {
      assert.equal(isPoolFailoverStatus(status), false, `status ${status}`);
    }
  });

  it("never fails over on success", () => {
    assert.equal(isPoolFailoverStatus(200), false);
  });
});

describe("resolvePool", () => {
  it("finds pools before providers and wins the same-name tie", () => {
    const store = makeStore();
    const pool = resolvePool(store, "prov-a");
    assert.ok(pool, "pool named prov-a must resolve even though a provider shares the id");
    assert.equal(pool.displayName, "Same-name pool");
  });

  it("returns null for plain provider ids and unknown ids", () => {
    const store = makeStore();
    assert.equal(resolvePool(store, "prov-b"), null);
    assert.equal(resolvePool(store, "ghost"), null);
  });
});

describe("poolMembersWithModel", () => {
  it("keeps pool order and filters by the materialized model catalog", () => {
    const store = makeStore();
    const candidates = poolMembersWithModel(store, store.pools["test-pool"], "gpt-shared");
    assert.deepEqual(candidates.map((c) => c.memberId), ["prov-a", "prov-b"]);
  });

  it("returns every member when all carry the model", () => {
    const store = makeStore();
    store.providers["prov-c"].models["gpt-shared"] = { displayName: "Shared from C" };
    const candidates = poolMembersWithModel(store, store.pools["test-pool"], "gpt-shared");
    assert.deepEqual(candidates.map((c) => c.memberId), ["prov-a", "prov-b", "prov-c"]);
  });

  it("returns an empty list when no member carries the model", () => {
    const store = makeStore();
    assert.deepEqual(poolMembersWithModel(store, store.pools["test-pool"], "ghost-model"), []);
  });

  it("skips members missing from providers instead of throwing", () => {
    const store = makeStore();
    store.pools["test-pool"].members.push("ghost-member");
    const candidates = poolMembersWithModel(store, store.pools["test-pool"], "gpt-shared");
    assert.deepEqual(candidates.map((c) => c.memberId), ["prov-a", "prov-b"]);
  });
});

describe("poolModelsUnion", () => {
  it("unions member catalogs in pool order, first member wins metadata", () => {
    const store = makeStore();
    const union = poolModelsUnion(store, store.pools["test-pool"]);
    assert.deepEqual(Object.keys(union), ["gpt-shared", "gpt-a-only", "gpt-b-only", "gpt-c-only"]);
    assert.equal(union["gpt-shared"].displayName, "Shared from A");
    assert.equal(union["gpt-shared"].contextWindow, 1000);
  });
});

describe("sticky table", () => {
  const candidates = [
    { memberId: "prov-a" },
    { memberId: "prov-b" },
    { memberId: "prov-c" },
  ];

  it("keeps pool order when no sticky entry exists", () => {
    const table = createStickyTable();
    const ordered = table.order("pool", "model", candidates);
    assert.deepEqual(ordered.map((c) => c.memberId), ["prov-a", "prov-b", "prov-c"]);
  });

  it("puts the last successful member first", () => {
    const table = createStickyTable();
    table.noteSuccess("pool", "model", "prov-b");
    const ordered = table.order("pool", "model", candidates);
    assert.deepEqual(ordered.map((c) => c.memberId), ["prov-b", "prov-a", "prov-c"]);
  });

  it("moves the sticky point when another member succeeds", () => {
    const table = createStickyTable();
    table.noteSuccess("pool", "model", "prov-b");
    table.noteSuccess("pool", "model", "prov-c");
    const ordered = table.order("pool", "model", candidates);
    assert.deepEqual(ordered.map((c) => c.memberId), ["prov-c", "prov-a", "prov-b"]);
  });

  it("lazily drops entries whose member left the candidate set", () => {
    const table = createStickyTable();
    table.noteSuccess("pool", "model", "prov-c");
    const remaining = candidates.slice(0, 2);
    const ordered = table.order("pool", "model", remaining);
    assert.deepEqual(ordered.map((c) => c.memberId), ["prov-a", "prov-b"]);
    assert.equal(table.get("pool", "model"), undefined, "stale entry must be invalidated");
  });

  it("keys entries per (pool, model) pair", () => {
    const table = createStickyTable();
    table.noteSuccess("pool", "model-1", "prov-b");
    table.noteSuccess("pool", "model-2", "prov-c");
    table.noteSuccess("other-pool", "model-1", "prov-a");
    assert.equal(table.get("pool", "model-1"), "prov-b");
    assert.equal(table.get("pool", "model-2"), "prov-c");
    assert.equal(table.get("other-pool", "model-1"), "prov-a");
  });

  it("a single blip does NOT move the sticky point (黄灯不降级)", () => {
    const table = createStickyTable();
    // order() 记录候选顺序；prov-a 单次闪错后 prov-b 应答：粘性位不动，
    // 下一请求仍从 prov-a 开始。
    table.order("pool", "model", candidates);
    table.noteFailure("pool", "model", "prov-a");
    table.noteSuccess("pool", "model", "prov-b");
    assert.equal(table.get("pool", "model"), undefined);
    assert.deepEqual(table.order("pool", "model", candidates).map((c) => c.memberId), ["prov-a", "prov-b", "prov-c"]);
  });

  it("moves the sticky point only after POOL_DEMOTE_AFTER_FAILURES consecutive failures (失败才降级)", () => {
    assert.equal(POOL_DEMOTE_AFTER_FAILURES, 2);
    const table = createStickyTable();
    table.order("pool", "model", candidates);
    // 两次连续请求级失败锁定降级；prov-b 应答后粘性位前移。
    table.noteFailure("pool", "model", "prov-a");
    table.order("pool", "model", candidates); // 下一次请求仍从 prov-a 开始
    table.noteFailure("pool", "model", "prov-a");
    table.noteSuccess("pool", "model", "prov-b");
    assert.equal(table.get("pool", "model"), "prov-b");
    assert.deepEqual(table.order("pool", "model", candidates).map((c) => c.memberId), ["prov-b", "prov-a", "prov-c"]);
  });

  it("a member's own success resets its failure counter (成功后清零)", () => {
    const table = createStickyTable();
    table.order("pool", "model", candidates);
    // prov-a 失败一次后成功：计数清零。之后的一次失败不构成连续两次。
    table.noteFailure("pool", "model", "prov-a");
    table.noteSuccess("pool", "model", "prov-a");
    assert.equal(table.consecutive("prov-a", "model"), 0);
    table.noteFailure("pool", "model", "prov-a");
    table.noteSuccess("pool", "model", "prov-b");
    assert.equal(table.get("pool", "model"), "prov-a", "reset 后的单次失败不降级，粘性位仍在前排 prov-a");
  });

  it("a skipped mid member without a latch keeps the sticky point from jumping past it", () => {
    const table = createStickyTable();
    table.order("pool", "model", candidates);
    // prov-a 锁定失败、prov-b 只闪错一次：prov-c 应答不得越过 prov-b。
    table.noteFailure("pool", "model", "prov-a");
    table.noteFailure("pool", "model", "prov-a");
    table.noteFailure("pool", "model", "prov-b");
    table.noteSuccess("pool", "model", "prov-c");
    assert.equal(table.get("pool", "model"), undefined, "prov-b 未锁定，粘性位不越过它");
    // prov-b 再失败一次（连续两次）后 prov-c 应答：一次性降级到 prov-c。
    table.noteFailure("pool", "model", "prov-b");
    table.noteSuccess("pool", "model", "prov-c");
    assert.equal(table.get("pool", "model"), "prov-c");
  });

  it("recovery: an earlier member answering again takes the sticky point back", () => {
    const table = createStickyTable();
    table.order("pool", "model", candidates);
    table.noteFailure("pool", "model", "prov-a");
    table.noteFailure("pool", "model", "prov-a");
    table.noteSuccess("pool", "model", "prov-b");
    assert.equal(table.get("pool", "model"), "prov-b");
    // 后排出错把请求 walk 回 prov-a；prov-a 应答即回归粘性位（且计数清零）。
    table.noteFailure("pool", "model", "prov-b");
    table.noteSuccess("pool", "model", "prov-a");
    assert.equal(table.get("pool", "model"), "prov-a");
    assert.equal(table.consecutive("prov-a", "model"), 0);
  });
});
