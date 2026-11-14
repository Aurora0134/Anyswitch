import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createLoadBalancer,
  LOAD_TTFT_GOOD_MS,
  LOAD_WINDOW_MS,
  LOAD_MIN_SAMPLES,
  LOAD_NEUTRAL_WEIGHT,
  LOAD_WEIGHT_FLOOR,
  LOAD_DEMOTE_AFTER_FAILURES,
  LOAD_AFFINITY_TTL_MS,
} from "../src/channels/pool-load-routing.mjs";

const candidates = (...ids) => ids.map((memberId) => ({ memberId, provider: {} }));
const ids = (ordered) => ordered.map((candidate) => candidate.memberId);

function clock() {
  let now = 1_000_000;
  return { nowFn: () => now, advance: (ms) => { now += ms; }, set: (ms) => { now = ms; } };
}

// Feed n quality samples to a member/model. Bad samples are slow successes
// (not-quality without latching the demotion counter, which noteFailure owns).
function feed(lb, memberId, modelId, goodCount, badCount) {
  for (let i = 0; i < goodCount; i += 1) lb.noteSuccess("pool", modelId, memberId, 1000, null);
  for (let i = 0; i < badCount; i += 1) lb.noteSuccess("pool", modelId, memberId, LOAD_TTFT_GOOD_MS + 1, null);
}

describe("load balancer weight", () => {
  it("scores a cold member neutral until the sample threshold", () => {
    const lb = createLoadBalancer(clock());
    assert.equal(lb.weight("a", "m"), LOAD_NEUTRAL_WEIGHT);
    feed(lb, "a", "m", LOAD_MIN_SAMPLES - 1, 0);
    assert.equal(lb.weight("a", "m"), LOAD_NEUTRAL_WEIGHT);
    feed(lb, "a", "m", 1, 0);
    assert.equal(lb.weight("a", "m"), 1);
  });

  it("computes quality as the good share once trusted", () => {
    const lb = createLoadBalancer(clock());
    feed(lb, "a", "m", 7, 3);
    assert.equal(lb.weight("a", "m"), 0.7);
  });

  it("counts a slow first token as not-quality", () => {
    const lb = createLoadBalancer(clock());
    feed(lb, "a", "m", 0, 0);
    for (let i = 0; i < LOAD_MIN_SAMPLES; i += 1) {
      lb.noteSuccess("pool", "m", "a", LOAD_TTFT_GOOD_MS + 1, null);
    }
    assert.equal(lb.weight("a", "m"), LOAD_WEIGHT_FLOOR);
  });

  it("treats the threshold boundary as quality", () => {
    const lb = createLoadBalancer(clock());
    for (let i = 0; i < LOAD_MIN_SAMPLES; i += 1) {
      lb.noteSuccess("pool", "m", "a", LOAD_TTFT_GOOD_MS, null);
    }
    assert.equal(lb.weight("a", "m"), 1);
  });

  it("never drops weight below the floor", () => {
    const lb = createLoadBalancer(clock());
    feed(lb, "a", "m", 0, 20);
    assert.equal(lb.weight("a", "m"), LOAD_WEIGHT_FLOOR);
  });

  it("forgets samples older than the window", () => {
    const c = clock();
    const lb = createLoadBalancer(c);
    feed(lb, "a", "m", 10, 0);
    assert.equal(lb.weight("a", "m"), 1);
    c.advance(LOAD_WINDOW_MS + 1);
    assert.equal(lb.sampleCount("a", "m"), 0);
    assert.equal(lb.weight("a", "m"), LOAD_NEUTRAL_WEIGHT);
  });
});

describe("load balancer ordering", () => {
  it("spreads by in-flight load when quality is equal", () => {
    const lb = createLoadBalancer(clock());
    lb.begin("a");
    lb.begin("a");
    lb.begin("b");
    const ordered = ids(lb.order("pool", "m", candidates("a", "b", "c")));
    assert.equal(ordered[0], "c");
    assert.equal(ordered[1], "b");
    assert.equal(ordered[2], "a");
  });

  it("prefers a higher-quality member at equal load", () => {
    const lb = createLoadBalancer(clock());
    feed(lb, "a", "m", 5, 5);
    feed(lb, "b", "m", 10, 0);
    const ordered = ids(lb.order("pool", "m", candidates("a", "b")));
    assert.equal(ordered[0], "b");
  });

  it("trades load against quality via the weighted score", () => {
    const lb = createLoadBalancer(clock());
    feed(lb, "a", "m", 10, 0); // weight 1
    feed(lb, "b", "m", 5, 5); // weight 0.5
    lb.begin("a"); // a score (1+1)/1 = 2 ; b score (0+1)/0.5 = 2 -> tie, pool order
    assert.equal(ids(lb.order("pool", "m", candidates("a", "b")))[0], "a");
    lb.begin("a"); // a score 3/1 = 3 ; b 2 -> b wins despite lower quality
    assert.equal(ids(lb.order("pool", "m", candidates("a", "b")))[0], "b");
  });

  it("breaks score ties by pool order", () => {
    const lb = createLoadBalancer(clock());
    assert.equal(ids(lb.order("pool", "m", candidates("a", "b", "c")))[0], "a");
  });

  it("keeps a single candidate regardless of state", () => {
    const lb = createLoadBalancer(clock());
    lb.noteFailure("pool", "m", "a", null);
    lb.noteFailure("pool", "m", "a", null);
    assert.deepEqual(ids(lb.order("pool", "m", candidates("a"))), ["a"]);
  });
});

describe("load balancer in-flight counting", () => {
  it("tracks begin/end and never goes negative", () => {
    const lb = createLoadBalancer(clock());
    assert.equal(lb.inflightOf("a"), 0);
    lb.begin("a");
    lb.begin("a");
    assert.equal(lb.inflightOf("a"), 2);
    lb.end("a");
    assert.equal(lb.inflightOf("a"), 1);
    lb.end("a");
    lb.end("a");
    assert.equal(lb.inflightOf("a"), 0);
  });
});

describe("load balancer circuit break", () => {
  it("latches a member to the back after consecutive failures", () => {
    const lb = createLoadBalancer(clock());
    for (let i = 0; i < LOAD_DEMOTE_AFTER_FAILURES; i += 1) lb.noteFailure("pool", "m", "a", null);
    const ordered = ids(lb.order("pool", "m", candidates("a", "b")));
    assert.deepEqual(ordered, ["b", "a"]);
    assert.equal(lb.consecutive("a", "m"), LOAD_DEMOTE_AFTER_FAILURES);
  });

  it("does not latch on a single transient failure", () => {
    const lb = createLoadBalancer(clock());
    lb.noteFailure("pool", "m", "a", null);
    assert.deepEqual(ids(lb.order("pool", "m", candidates("a", "b"))), ["a", "b"]);
  });

  it("recovers a latched member on success", () => {
    const lb = createLoadBalancer(clock());
    lb.noteFailure("pool", "m", "a", null);
    lb.noteFailure("pool", "m", "a", null);
    lb.noteSuccess("pool", "m", "a", 1000, null);
    assert.equal(lb.consecutive("a", "m"), 0);
    assert.deepEqual(ids(lb.order("pool", "m", candidates("a", "b"))), ["a", "b"]);
  });

  it("still tries an all-latched pool in pool order", () => {
    const lb = createLoadBalancer(clock());
    for (const id of ["a", "b"]) {
      lb.noteFailure("pool", "m", id, null);
      lb.noteFailure("pool", "m", id, null);
    }
    assert.deepEqual(ids(lb.order("pool", "m", candidates("a", "b"))), ["a", "b"]);
  });
});

describe("load balancer session affinity", () => {
  it("keeps a session on its answering member", () => {
    const lb = createLoadBalancer(clock());
    lb.noteSuccess("pool", "m", "b", 1000, "sess-1");
    assert.equal(lb.affinityOf("pool", "m", "sess-1"), "b");
    lb.begin("b");
    lb.begin("b");
    // b carries load but affinity outranks least-load for the same session.
    assert.equal(ids(lb.order("pool", "m", candidates("a", "b"), "sess-1"))[0], "b");
    // a different session still balances freely toward the lighter member.
    assert.equal(ids(lb.order("pool", "m", candidates("a", "b"), "sess-2"))[0], "a");
  });

  it("re-binds affinity to the member that actually answers after failover", () => {
    const lb = createLoadBalancer(clock());
    lb.noteSuccess("pool", "m", "a", 1000, "sess-1");
    lb.noteFailure("pool", "m", "a", "sess-1");
    lb.noteFailure("pool", "m", "a", "sess-1");
    assert.equal(lb.affinityOf("pool", "m", "sess-1"), undefined);
    lb.noteSuccess("pool", "m", "b", 1000, "sess-1");
    assert.equal(lb.affinityOf("pool", "m", "sess-1"), "b");
  });

  it("ignores affinity for a latched member", () => {
    const lb = createLoadBalancer(clock());
    lb.noteSuccess("pool", "m", "a", 1000, "sess-1");
    lb.noteFailure("pool", "m", "a", null);
    lb.noteFailure("pool", "m", "a", null);
    assert.equal(ids(lb.order("pool", "m", candidates("a", "b"), "sess-1"))[0], "b");
  });

  it("expires an idle affinity after the TTL", () => {
    const c = clock();
    const lb = createLoadBalancer(c);
    lb.noteSuccess("pool", "m", "b", 1000, "sess-1");
    lb.begin("b");
    lb.begin("b");
    c.advance(LOAD_AFFINITY_TTL_MS + 1);
    assert.equal(ids(lb.order("pool", "m", candidates("a", "b"), "sess-1"))[0], "a");
  });

  it("drops affinity when its member leaves the candidate set", () => {
    const lb = createLoadBalancer(clock());
    lb.noteSuccess("pool", "m", "b", 1000, "sess-1");
    assert.deepEqual(ids(lb.order("pool", "m", candidates("a"), "sess-1")), ["a"]);
    assert.equal(lb.affinityOf("pool", "m", "sess-1"), undefined);
  });

  it("scopes affinity per pool and model", () => {
    const lb = createLoadBalancer(clock());
    lb.noteSuccess("pool", "m1", "a", 1000, "sess-1");
    lb.noteSuccess("pool", "m2", "b", 1000, "sess-1");
    assert.equal(lb.affinityOf("pool", "m1", "sess-1"), "a");
    assert.equal(lb.affinityOf("pool", "m2", "sess-1"), "b");
  });
});