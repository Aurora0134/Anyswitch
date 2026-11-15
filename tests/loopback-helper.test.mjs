// Behavior tests for the shared loopback fixture (test-helpers/loopback.mjs).
// Three regressions must stay caught:
//   1. a blocked-port table that drifts from what live fetch actually rejects
//      (missing entry = the probabilistic "Error: bad port" false red returns);
//   2. a retry loop that lost its bound (a pathological bind sequence would
//      hang the suite instead of failing);
//   3. an intermediate listener left open between retries (port leaks, later
//      binds collide).

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { FETCH_BAD_PORTS, bindOnce, closeServer, isFetchBadPort, listenLoopback } from "../test-helpers/loopback.mjs";

function httpServer() {
  return createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
}

// A closed loopback port answers ECONNREFUSED; a live one answers HTTP.
// Either way the result is decisive within the abort window.
async function refused(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return false;
  } catch (err) {
    return err.cause?.code === "ECONNREFUSED";
  }
}

test("isFetchBadPort covers the table edges and coerces the numeric port", () => {
  for (const port of [1, 21, 6000, 6566, 6667, 6679, 6697, 10080]) {
    assert.equal(isFetchBadPort(port), true, String(port));
  }
  for (const port of [0, 2, 49, 81, 88, 6001, 6670, 10081, 49152]) {
    assert.equal(isFetchBadPort(port), false, String(port));
  }
  assert.equal(isFetchBadPort("6000"), true);
});

// 穷举扫 [1..10080]：表里的口 fetch 必须当场拒（"bad port"，建连前判定，与
// 本机谁在监听无关），表外的口 fetch 必须放行。规范表上限就是 10080，超出
// 此范围无表可对——若未来表顶越过了 10080，这条断言会先把扫查范围逼着跟上。
test("FETCH_BAD_PORTS matches what live fetch rejects, exhaustively over 1..10080", { timeout: 120000 }, async () => {
  const rejectedByFetch = new Set();
  const probe = async (port) => {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    } catch (err) {
      if (err.cause?.message === "bad port") rejectedByFetch.add(port);
    }
  };
  const BATCH = 400;
  for (let start = 1; start <= 10080; start += BATCH) {
    const range = [];
    for (let p = start; p < start + BATCH && p <= 10080; p++) range.push(p);
    await Promise.all(range.map(probe));
  }
  assert.deepEqual(
    [...rejectedByFetch].filter((p) => !FETCH_BAD_PORTS.has(p)),
    [],
    "fetch rejects ports the table misses — false red is back",
  );
  assert.deepEqual(
    [...FETCH_BAD_PORTS].filter((p) => !rejectedByFetch.has(p)),
    [],
    "table lists ports live fetch accepts — pointless retries mask real regressions",
  );
  assert.equal(Math.max(...FETCH_BAD_PORTS), 10080, "sweep range must cover the whole table");
});

test("gives up with a bounded error when every bind reports a fetch-bad port", { timeout: 15000 }, async () => {
  const server = httpServer();
  const reallyBound = [];
  // 谎报：每轮都真实绑上临时口，但对 helper 报一个表内禁用端口，逼它走完
  // 「命中 → 关 → 重试」的整条路径，且每轮 listener 都是真实可关的。重试
  // 超出哨兵轮数仍不收手，seam 主动掷错：让「无限重试」回归立刻红，而不是
  // 把测试进程吊死在死循环里（node:test 的 timeout 杀不掉仍在跑的循环）。
  const SENTINEL_ROUNDS = 6;
  const bind = async (srv) => {
    if (reallyBound.length >= SENTINEL_ROUNDS) {
      throw new Error(`sentinel: retry loop kept going past ${SENTINEL_ROUNDS} rounds`);
    }
    const port = await bindOnce(srv, 0, "127.0.0.1");
    reallyBound.push(port);
    return 6000;
  };
  try {
    await assert.rejects(
      () => listenLoopback(server, 0, { bind, maxAttempts: 3 }),
      (err) => {
        assert.match(err.message, /3 ephemeral binds/);
        assert.match(err.message, /bad port 6000/);
        assert.equal(err.attempts, 3);
        assert.equal(err.lastPort, 6000);
        return true;
      },
    );
    assert.equal(reallyBound.length, 3, "every attempt must really bind before giving up");
    for (const port of reallyBound) {
      assert.equal(await refused(port), true, `attempt port ${port} must be closed after the bounded failure`);
    }
  } finally {
    await closeServer(server);
  }
});

test("closes every intermediate listener and lands on a fetch-usable port", { timeout: 15000 }, async () => {
  const server = httpServer();
  const reallyBound = [];
  const reportedBad = [6000, 6566];
  let call = 0;
  const bind = async (srv) => {
    const port = await bindOnce(srv, 0, "127.0.0.1");
    reallyBound.push(port);
    const reported = call < reportedBad.length ? reportedBad[call] : port;
    call += 1;
    return reported;
  };
  try {
    const { port, close } = await listenLoopback(server, 0, { bind });
    assert.equal(call, 3, "two blocked hits, then the honest round");
    assert.equal(server.listening, true);
    assert.equal(server.address().port, port);
    for (let i = 0; i < reportedBad.length; i += 1) {
      assert.equal(await refused(reallyBound[i]), true, `intermediate listener ${reallyBound[i]} must not leak`);
    }
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    await close();
    assert.equal(server.listening, false);
    assert.equal(await refused(port), true, "close() must really close the final listener too");
  } finally {
    await closeServer(server);
  }
});

test("propagates product errors from bind untouched, without retrying them", async () => {
  const server = httpServer();
  const boom = Object.assign(new Error("product wiring exploded"), { code: "EACCES" });
  let calls = 0;
  const bind = async () => {
    calls += 1;
    throw boom;
  };
  await assert.rejects(
    () => listenLoopback(server, 0, { bind }),
    (err) => err === boom,
  );
  assert.equal(calls, 1, "a bind failure is a product error, not a bad-port hit — no retry");
});

test("refuses to bind anything but an ephemeral port", async () => {
  const server = httpServer();
  // 47821 是生产常驻中继端口：测试绝不许碰，guard 必须拦住误传。
  await assert.rejects(() => listenLoopback(server, 47821), /ephemeral/);
});
