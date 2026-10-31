// Socket→PID 兜底归组的单元测试（机制见 instance-socket-owner.mjs）：
// netstat 行解析（双方向 / IPv6 bracket 容错 / 状态过滤 / pid=0 过滤）、TTL 合并刷新、
// lookup 同步且绝不抛错。全部用注入式 execFn / nowFn，不 spawn 真 netstat。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseNetstatOutput, createInstanceSocketOwner } from "./instance-socket-owner.mjs";

// 双方向样本：11790 是客户端行（外端 47821 = relay），47821 上另有一条
// relay 侧的反向行（PID 不同），验证方向换算不会串行。
const NETSTAT_SAMPLE = [
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    127.0.0.1:11790        127.0.0.1:47821        ESTABLISHED     22524",
  "  TCP    127.0.0.1:47821        127.0.0.1:11790        ESTABLISHED     999",
  "  TCP    127.0.0.1:11500        127.0.0.1:47821        ESTABLISHED     12804",
  "  TCP    [::1]:49673            [::1]:47821            ESTABLISHED     12804",
  "  TCP    127.0.0.1:11800        127.0.0.1:47821        TIME_WAIT       0",
  "  TCP    127.0.0.1:11900        127.0.0.1:47821        CLOSE_WAIT      7777",
  "  TCP    0.0.0.0:47821          0.0.0.0:0              LISTENING       999",
  "  TCP    127.0.0.1:12000        127.0.0.1:47821        ESTABLISHED     0",
  "",
].join("\r\n");

describe("parseNetstatOutput", () => {
  it("collects ESTABLISHED rows into Map<localPort, rows> in both directions", () => {
    const map = parseNetstatOutput(NETSTAT_SAMPLE);
    assert.deepEqual(map.get(11790), [{ foreignPort: 47821, pid: 22524 }]);
    assert.deepEqual(map.get(47821), [{ foreignPort: 11790, pid: 999 }]);
    assert.deepEqual(map.get(11500), [{ foreignPort: 47821, pid: 12804 }]);
  });

  // 防御性解析容错，不是产品承诺：生产命令 `netstat -ano -p tcp` 只输出
  // IPv4 行（IPv6 行仅出现在 -p tcpv6 下；实测本机 -p tcp 76 行、bracket 行 0），
  // bracket 地址段是正则为地址段兼容预留的容错分支，生产输入打不到它。
  it("parses bracketed IPv6 addresses ([::1]:port) — defensive branch, unreachable via netstat -p tcp", () => {
    const map = parseNetstatOutput(NETSTAT_SAMPLE);
    assert.deepEqual(map.get(49673), [{ foreignPort: 47821, pid: 12804 }]);
  });

  it("drops non-ESTABLISHED rows (TIME_WAIT / CLOSE_WAIT / LISTENING)", () => {
    const map = parseNetstatOutput(NETSTAT_SAMPLE);
    assert.equal(map.has(11800), false, "TIME_WAIT");
    assert.equal(map.has(11900), false, "CLOSE_WAIT");
    // LISTENING 行的 localPort 与 relay 相同，但状态不符，不得混入
    const relayRows = map.get(47821);
    assert.equal(relayRows.some((r) => r.foreignPort === 0), false, "LISTENING foreign port 0");
  });

  it("drops pid=0 rows even when ESTABLISHED", () => {
    const map = parseNetstatOutput(NETSTAT_SAMPLE);
    assert.equal(map.has(12000), false);
  });

  it("tolerates non-string input and junk lines", () => {
    assert.equal(parseNetstatOutput(null).size, 0);
    assert.equal(parseNetstatOutput(undefined).size, 0);
    assert.equal(parseNetstatOutput("").size, 0);
    assert.equal(parseNetstatOutput("random garbage\r\nUDP 127.0.0.1:53 *:* 0").size, 0);
  });
});

describe("createInstanceSocketOwner", () => {
  function syncOwner(sample = NETSTAT_SAMPLE, ttlMs = 2000) {
    let t = 1000;
    const execFn = (cmd, opts, cb) => cb(null, sample);
    return {
      owner: createInstanceSocketOwner({ execFn, nowFn: () => t, ttlMs }),
      getTime: () => t,
      advance: (ms) => { t += ms; },
    };
  }

  it("resolves the client PID from the relay's perspective (localPort=relay, remotePort=client)", () => {
    const { owner } = syncOwner();
    assert.equal(owner.lookup({ localPort: 47821, remotePort: 11790 }), 22524);
    // 反方向同理可查（relay 侧行），验证行选择按方向而非只取第一条
    assert.equal(owner.lookup({ localPort: 11790, remotePort: 47821 }), 999);
    assert.equal(owner.lookup({ localPort: 47821, remotePort: 11500 }), 12804);
  });

  it("returns null for an unknown port without throwing (first-request miss)", () => {
    const { owner } = syncOwner();
    assert.equal(owner.lookup({ localPort: 47821, remotePort: 55555 }), null);
  });

  it("notifies onRefresh listeners after a snapshot lands so a missed first request can retry", async () => {
    let t = 1000;
    const pending = [];
    const execFn = (cmd, opts, cb) => pending.push(cb);
    const owner = createInstanceSocketOwner({ execFn, nowFn: () => t, ttlMs: 2000 });
    const hits = [];
    const unsub = owner.onRefresh(() => {
      hits.push(owner.lookup({ localPort: 47821, remotePort: 11790 }));
    });

    assert.equal(owner.lookup({ localPort: 47821, remotePort: 11790 }), null);
    assert.equal(hits.length, 0, "listeners wait for the in-flight refresh to finish");

    pending.shift()(null, NETSTAT_SAMPLE);
    assert.deepEqual(hits, [22524]);
    unsub();
  });

  it("never throws on malformed lookup arguments", () => {
    const { owner } = syncOwner();
    assert.equal(owner.lookup(), null);
    assert.equal(owner.lookup(null), null);
    assert.equal(owner.lookup({}), null);
    assert.equal(owner.lookup({ localPort: "x", remotePort: [] }), null);
    assert.equal(owner.lookup({ localPort: 0, remotePort: 11790 }), null);
    assert.equal(owner.lookup({ localPort: 47821, remotePort: -1 }), null);
  });

  it("pre-warms once at construction, then refreshes only past the TTL (hits never refresh)", async () => {
    let t = 1000;
    let calls = 0;
    const pending = [];
    // 异步 exec：回调挂起，用于验证 in-flight 期间的并发 miss 合并成一次 spawn
    const execFn = (cmd, opts, cb) => {
      calls += 1;
      pending.push(cb);
    };
    const owner = createInstanceSocketOwner({ execFn, nowFn: () => t, ttlMs: 2000 });

    assert.equal(calls, 1, "construction pre-warms once");
    // 快照还是空的：miss 返回 null 且不阻塞，也不在 in-flight 之外再 spawn
    assert.equal(owner.lookup({ localPort: 47821, remotePort: 11790 }), null, "miss before snapshot lands returns null");
    assert.equal(owner.lookup({ localPort: 47821, remotePort: 11790 }), null);
    assert.equal(calls, 1, "concurrent misses coalesce into the in-flight refresh");

    pending.shift()(null, NETSTAT_SAMPLE); // 预热完成
    assert.equal(owner.lookup({ localPort: 47821, remotePort: 11790 }), 22524);
    assert.equal(calls, 1, "hit within TTL does not refresh");

    t += 2000; // 恰好在 TTL 边界：仍算新鲜
    assert.equal(owner.lookup({ localPort: 47821, remotePort: 11790 }), 22524);
    assert.equal(calls, 1, "exactly-at-TTL is still fresh");

    t += 1; // 过 TTL：本次仍返回旧快照的值，后台刷新
    assert.equal(owner.lookup({ localPort: 47821, remotePort: 11790 }), 22524, "stale lookup serves the old snapshot");
    assert.equal(calls, 2, "past TTL triggers a background refresh");
    pending.shift()(null, NETSTAT_SAMPLE);
  });

  it("keeps the last good snapshot when netstat fails (silent error, no throw)", () => {
    let t = 1000;
    let calls = 0;
    const pending = [];
    // 挂起式 exec（同文件其他用例的写法）：手动控制刷新何时落地。
    // 不能用同步回调夹具——lookup 的返回值在 refresh 落地前就已算好，
    // 同步夹具会让"失败不清快照"的断言恒真（普查发现的原始问题）。
    const execFn = (cmd, opts, cb) => { calls += 1; pending.push(cb); };
    const owner = createInstanceSocketOwner({ execFn, nowFn: () => t, ttlMs: 2000 });
    assert.equal(calls, 1, "construction pre-warms once");
    pending.shift()(null, NETSTAT_SAMPLE); // 预热成功
    assert.equal(owner.lookup({ localPort: 47821, remotePort: 11790 }), 22524);

    t += 3000; // 过 TTL：本次仍返回旧快照的值，并触发后台刷新，此次 netstat 失败
    assert.equal(owner.lookup({ localPort: 47821, remotePort: 11790 }), 22524, "stale lookup serves the old snapshot");
    assert.equal(calls, 2, "past TTL triggers a background refresh");
    pending.shift()(new Error("netstat unavailable"), ""); // 失败落地，不得抛错

    // 失败落地之后再查，才能钉住"失败不清快照"：若失败即清空快照，此处为 null
    assert.equal(owner.lookup({ localPort: 47821, remotePort: 11790 }), 22524, "last good snapshot survives a failed refresh");
    // 失败也推进 snapshotAt（防 miss→spawn→fail→miss 循环）：若失败不推进，
    // stale 快照会让每次命中查询都重 spawn 注定失败的 netstat，calls 会涨
    assert.equal(owner.lookup({ localPort: 47821, remotePort: 11790 }), 22524);
    assert.equal(calls, 2, "a failed refresh still advances the freshness clock (no miss→spawn→fail loop)");
  });

  it("does not hammer netstat when every lookup misses", async () => {
    let t = 1000;
    let calls = 0;
    const pending = [];
    const execFn = (cmd, opts, cb) => {
      calls += 1;
      pending.push(cb);
    };
    const owner = createInstanceSocketOwner({ execFn, nowFn: () => t, ttlMs: 2000 });
    pending.shift()(null, NETSTAT_SAMPLE); // 预热完成（新鲜快照）
    assert.equal(calls, 1);

    // 新鲜快照内的 miss：触发后台刷新，但 in-flight 合并
    owner.lookup({ localPort: 47821, remotePort: 55555 });
    owner.lookup({ localPort: 47821, remotePort: 55556 });
    owner.lookup({ localPort: 47821, remotePort: 55557 });
    assert.equal(calls, 2, "a burst of misses triggers exactly one refresh");
    pending.shift()(null, NETSTAT_SAMPLE);
  });
});
