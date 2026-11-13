import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPanelRouter } from "../src/panel/panel.mjs";
import { buildTurns } from "../src/agents/session-scan.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

// Sessions tab routes: the router is exercised with a mock session-scan
// service so no real agent session store is touched. Covers the route
// contract shapes: worker offload of the list scan, list snapshot
// TTL / in-flight dedup / ?refresh=1 escape hatch, delete-vs-refresh
// generation, messages query-param validation + turns, and per-item
// delete outcomes passed through verbatim in session-scan's real result
// shape. The roots whitelist itself lives inside session-scan's delete
// (see its own suite) — the router only validates the request shape.
// Mirrors the fakeReqRes pattern from panel-stats.test.mjs.

function fakeReqRes(url, method = "GET", body = null, extraHeaders = {}) {
  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(code, h) { this.statusCode = code; this.headers = h || {}; },
    end(data) { if (data !== undefined) this.body += data; },
  };
  const listeners = {};
  const req = {
    url,
    method,
    headers: {
      host: "127.0.0.1:47820",
      origin: "http://127.0.0.1:47820",
      "x-anyswitch-panel": "1",
      ...extraHeaders,
    },
    on(event, fn) { listeners[event] = fn; return req; },
  };
  if (body !== null) {
    queueMicrotask(() => {
      listeners.data?.(Buffer.from(JSON.stringify(body)));
      listeners.end?.();
    });
  }
  const json = () => (res.body ? JSON.parse(res.body) : null);
  return { req, res, json };
}

function sessionsRouter(sessionScanService, extra = {}) {
  return createPanelRouter({
    storePaths: { root: "C:/fake/anyswitch" },
    logger: null,
    metricsCollector: null,
    fetchRelayAgents: async () => null,
    sessionScanService,
    ...extra,
  });
}

function mockSessionScan({ scanResult, scanError, messagesResult, deleteResult, scanAgentResult, scanAgentError } = {}) {
  const calls = { scanAll: 0, scanAgent: [], loadMessages: [], deleteSessions: [] };
  return {
    calls,
    scanAll: async () => {
      calls.scanAll += 1;
      if (scanError) throw scanError;
      return scanResult ?? { sessions: [], endpointErrors: [] };
    },
    // 会话栏追赶的单端点扫描面：列表路由 ?endpoint= 参数只经这里。
    scanAgent: async (agentId) => {
      calls.scanAgent.push(agentId);
      if (scanAgentError) throw scanAgentError;
      return scanAgentResult ?? [];
    },
    // messages 服务面：正文＋目录在服务侧（worker 线程）序列化成一整串，路由
    // 原样直写不再 re-stringify。参数记录进 calls.loadMessages，形状与修前一致。
    loadMessagesResponse: async (endpoint, file) => {
      calls.loadMessages.push([endpoint, file]);
      const messages = messagesResult ?? { session: { endpoint, file }, messages: [] };
      return JSON.stringify({ ok: true, messages, turns: buildTurns(messages) });
    },
    deleteSessions: async (items) => {
      calls.deleteSessions.push(items);
      // 默认结果对齐 session-scan.mjs deleteSessions 的真实逐项形状：
      // ok.push({ endpoint, file })、fail.push({ endpoint, file, reason })。
      return deleteResult ?? {
        ok: items.map((it) => ({ endpoint: it.endpoint, file: it.file })),
        fail: [],
      };
    },
  };
}

describe("panel router sessions routes", () => {
  // 回归钉：不注入 sessionScanService 时，列表扫描必须走扫描承载（worker
  // 线程），绝不许在面板进程里直接跑 session-scan 的同步 fs 扫描。修前这条路径
  // 就是 `scanAll: sessionScanAll`——一次 8s 的同步块，整个面板停摆。
  // 活性探针跑满扫描全程（worker 忙等 400ms）：慢机/粗定时器只会让拍距变宽、
  // 拍数随窗口长度照常累积，不会像固定墙钟窗口那样在慢机上把窗口截短而误红。
  // 真回归（同步块在本进程跑）把整个 400ms 按成一个空档：拍数归零、空档≈忙等
  // 时长，两条断言都会红。
  it("默认服务把列表扫描送进 worker（面板进程零阻塞）", async () => {
    const root = mkTestDir("anyswitch-sessions-offload-");
    // 临时扫描 worker：忙等 400ms 再回一份可识别的空表。
    const workerFile = join(root, "busy-scan-worker.mjs");
    writeFileSync(workerFile, `
import { parentPort } from "node:worker_threads";
parentPort.on("message", (message) => {
  const started = Date.now();
  while (Date.now() - started < 400) { /* 同步全盘扫描的替身 */ }
  parentPort.postMessage({ id: message?.id, ok: true, result: { sessions: [], endpointErrors: [] } });
});
`);
    const router = sessionsRouter(null, { sessionScanWorkerFile: workerFile });
    let finished = false;
    let ticks = 0;
    let worstGap = 0;
    let last = Date.now();
    const probe = (async () => {
      while (!finished) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (finished) break;
        const now = Date.now();
        worstGap = Math.max(worstGap, now - last - 5);
        last = now;
        ticks += 1;
      }
    })();
    const list = fakeReqRes("/panel/api/sessions/list", "GET");
    try {
      await router.handle(list.req, list.res);
    } finally {
      finished = true;
      await probe;
    }
    assert.equal(list.res.statusCode, 200);
    assert.ok(ticks > 10, `定时器链几乎没跑（${ticks} 拍），扫描把面板事件循环按住了`);
    assert.ok(worstGap < 150, `扫描期间事件循环空档 ${worstGap}ms`);
  });

  // 回归钉：列表路由的扫描是「短 TTL + 在飞去重 + 先返回上次结果」。
  // 修前每次 GET 都整盘重扫（S2 实测 2927 条会话 2.7–8.0s / 1.6MB），用户
  // 每进一次终端页就堵一次事件循环；修后同一 TTL 窗口内只扫一拍。
  it("TTL 窗口内重复 GET 只扫一拍（在飞去重）", async () => {
    const svc = mockSessionScan({
      scanResult: { sessions: [{ endpoint: "claude", id: "abc", file: "C:/s/abc.jsonl" }], endpointErrors: [] },
    });
    const router = sessionsRouter(svc);
    for (let round = 0; round < 3; round += 1) {
      const { req, res } = fakeReqRes("/panel/api/sessions/list", "GET");
      await router.handle(req, res);
      assert.equal(res.statusCode, 200);
    }
    assert.equal(svc.calls.scanAll, 1, "TTL 窗口内三次列表请求只该触发一次扫描");
  });

  // 回归钉（评审 F2）：会话管理 tab 的刷新按钮不许变成假动作。TTL 内
  // 普通 GET 拿旧快照是对的，但用户显式点刷新（?refresh=1）必须等一次真扫描
  // 再回新值——否则前端照旧 toast「已刷新」，屏幕上还是旧列表。
  it("?refresh=1 命中 TTL 也等真扫描并返回新值（刷新按钮的逃生口）", async () => {
    let round = 0;
    const calls = { scanAll: 0 };
    const svc = {
      scanAll: async () => {
        calls.scanAll += 1;
        round += 1;
        return { sessions: [{ endpoint: "claude", id: `r${round}`, file: `C:/s/r${round}.jsonl` }], endpointErrors: [] };
      },
      deleteSessions: async () => ({ ok: [], fail: [] }),
    };
    // TTL 拉长到 1 小时：普通 GET 一定命中旧快照，只有 ?refresh=1 能穿透。
    const router = sessionsRouter(svc, { sessionsListTtlMs: 3_600_000 });
    const first = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(first.req, first.res);
    assert.equal(first.json().sessions[0].id, "r1");
    const warm = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(warm.req, warm.res);
    assert.equal(warm.json().sessions[0].id, "r1", "TTL 内普通 GET 走快照");
    assert.equal(calls.scanAll, 1);
    const forced = fakeReqRes("/panel/api/sessions/list?refresh=1", "GET");
    await router.handle(forced.req, forced.res);
    assert.equal(forced.res.statusCode, 200);
    assert.equal(calls.scanAll, 2, "?refresh=1 必须真的扫一次");
    assert.equal(forced.json().sessions[0].id, "r2", "?refresh=1 必须回新值，不能回旧快照");
    // 刷新落地后快照也更新了：紧接着的普通 GET 拿到的就是新值。
    const after = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(after.req, after.res);
    assert.equal(after.json().sessions[0].id, "r2");
    assert.equal(calls.scanAll, 2, "刷新重置了 TTL，普通 GET 不该再扫");
  });

  // 会话栏追赶的专用形（?endpoint=<agent>）：只扫该 agent 一家（worker 线程、与
  // 绑定捕获同一条通路），响应只带该家的行——追赶本来就是要等真扫描的强制语义，
  // 且全量十家对只显示一个 agent 的左栏纯属陪跑（全盘 2.7–9.8s vs 单家 ~1s）。
  // 扫到的行集并进全量快照（mergeEndpoint，2026-11-12 行消失案形态二）：不并的
  // 话快照停在物化前，等待窗里切出再切回终端视图（30s TTL 过期、非强制拉取）
  // 会拿旧快照把刚出现的行整表抹掉。合并刷新 at：随后的普通 GET 在 TTL 内拿到
  // 含新行的合并值，且不为全量重扫付一次 2.7–9.8s。
  it("?endpoint=<agent> 走单端点扫描：只回该家的行，结果并进全量快照（行消失案形态二）", async () => {
    const svc = mockSessionScan({
      scanResult: { sessions: [{ endpoint: "claude", id: "full-1", file: "C:/s/full.jsonl" }], endpointErrors: [] },
      scanAgentResult: [{ endpoint: "kimi", id: "k-1", file: "C:/k/k-1", lastActive: 500 }],
    });
    const router = sessionsRouter(svc, { sessionsListTtlMs: 3_600_000 });
    // 先把全量快照建起来（这一拍扫全量）。
    const warm = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(warm.req, warm.res);
    assert.equal(svc.calls.scanAll, 1);
    const hit = fakeReqRes("/panel/api/sessions/list?refresh=1&endpoint=kimi", "GET");
    await router.handle(hit.req, hit.res);
    assert.equal(hit.res.statusCode, 200);
    assert.deepEqual(hit.json().sessions, [{ endpoint: "kimi", id: "k-1", file: "C:/k/k-1", lastActive: 500 }]);
    assert.deepEqual(svc.calls.scanAgent, ["kimi"], "只扫 kimi 一家");
    assert.equal(svc.calls.scanAll, 1, "全量一次没多扫");
    // 形态二回归钉：合并后的普通 GET（TTL 内、非强制）拿到含新行的合并值——
    // 修前这里拿回旧快照，新行整表替换时消失。
    const after = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(after.req, after.res);
    const ids = after.json().sessions.map((row) => row.id).sort();
    assert.deepEqual(ids, ["full-1", "k-1"], "合并值含该 agent 的既有行与追赶新行");
    assert.equal(svc.calls.scanAll, 1, "合并不触发全量重扫");
  });

  // mergeEndpoint 的空表护栏：scanEndpoint 对读盘失败与真空表一律降级空表，两者
  // 在路由面不可区分——一次扫描抖动（或名单外 agent）不该有把该家全部行从快照
  // 抹掉的权力。空表不并，别家/该家的行维持到下一轮全量刷新。
  it("?endpoint= 空表不并进快照：扫描降级/未知 agent 不抹既有行", async () => {
    const svc = mockSessionScan({
      scanResult: { sessions: [
        { endpoint: "kimi", id: "k-1", file: "C:/k/k-1", lastActive: 500 },
        { endpoint: "claude", id: "c-1", file: "C:/s/c-1", lastActive: 400 },
      ], endpointErrors: [] },
      scanAgentResult: [],
    });
    const router = sessionsRouter(svc, { sessionsListTtlMs: 3_600_000 });
    const warm = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(warm.req, warm.res);
    const hit = fakeReqRes("/panel/api/sessions/list?refresh=1&endpoint=kimi", "GET");
    await router.handle(hit.req, hit.res);
    assert.equal(hit.res.statusCode, 200);
    assert.deepEqual(hit.json().sessions, [], "响应仍按契约回该家（空）结果");
    const after = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(after.req, after.res);
    assert.deepEqual(after.json().sessions.map((row) => row.id).sort(), ["c-1", "k-1"], "空表没抹掉快照里的既有行");
    assert.equal(svc.calls.scanAll, 1);
  });

  // mergeEndpoint 的删除墓碑：用户刚删的行，随后追赶的单端点扫描又把它带回来
  // （扫描与删除竞态的形状），合并必须滤掉——dropRows 的删除语义不许被合并复活。
  it("删除后的行不被单端点合并复活（墓碑）", async () => {
    const svc = mockSessionScan({
      scanResult: { sessions: [
        { endpoint: "kimi", id: "k-1", file: "C:/k/k-1", lastActive: 500 },
        { endpoint: "claude", id: "c-1", file: "C:/s/c-1", lastActive: 400 },
      ], endpointErrors: [] },
      // 删后新一轮单家扫描仍带回 k-1（删前起的扫描/盘面滞后的形状）。
      scanAgentResult: [{ endpoint: "kimi", id: "k-1", file: "C:/k/k-1", lastActive: 500 }],
    });
    const router = sessionsRouter(svc, { sessionsListTtlMs: 3_600_000 });
    const warm = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(warm.req, warm.res);
    const del = fakeReqRes("/panel/api/sessions/delete", "POST", { items: [{ endpoint: "kimi", file: "C:/k/k-1" }] });
    await router.handle(del.req, del.res);
    assert.deepEqual(del.json().ok, [{ endpoint: "kimi", file: "C:/k/k-1" }]);
    const hit = fakeReqRes("/panel/api/sessions/list?refresh=1&endpoint=kimi", "GET");
    await router.handle(hit.req, hit.res);
    const after = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(after.req, after.res);
    assert.deepEqual(after.json().sessions.map((row) => row.id), ["c-1"], "已删行被墓碑挡住，没有复活");
  });

  // mergeEndpoint 与在飞全量扫描的竞态：TTL 过期触发后台全量补一拍（起扫早于
  // 新行物化，结果里没有它），追赶合并先行落进快照——全量落地整体覆写时会把
  // 合并行抹回去（形态二在竞态窗里的窄版）。落地后合并补拍一次，两种先后都收敛。
  it("在飞全量扫描落地后合并补拍：新行不被起扫更早的全量结果抹掉", async () => {
    let round = 0;
    const svc = {
      scanAll: async () => {
        round += 1;
        // 第二拍（后台补扫）慢且不含新行：模拟起扫早于行物化。
        if (round > 1) await new Promise((resolve) => setTimeout(resolve, 50));
        return { sessions: [{ endpoint: "claude", id: `full-${round}`, file: `C:/s/full-${round}.jsonl`, lastActive: round }], endpointErrors: [] };
      },
      scanAgent: async () => [{ endpoint: "kimi", id: "k-1", file: "C:/k/k-1", lastActive: 500 }],
      deleteSessions: async () => ({ ok: [], fail: [] }),
    };
    // ttl=0：第一拍冷扫；第二拍 GET 过期先回旧值、后台补扫（在飞 50ms）。
    const router = sessionsRouter(svc, { sessionsListTtlMs: 0 });
    const warm = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(warm.req, warm.res);
    assert.equal(round, 1);
    const stale = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(stale.req, stale.res);
    // 在飞全量还没落地时追赶合并先行。
    const hit = fakeReqRes("/panel/api/sessions/list?refresh=1&endpoint=kimi", "GET");
    await router.handle(hit.req, hit.res);
    // 等后台全量落地（覆写快照）+ 合并补拍。
    await new Promise((resolve) => setTimeout(resolve, 120));
    const after = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(after.req, after.res);
    const ids = after.json().sessions.map((row) => row.id).sort();
    assert.deepEqual(ids, ["full-2", "k-1"], "在飞全量落地后合并行仍在（补拍把行带回来）");
    // ttl=0：这最后一拍 GET 自身也过期，会再起一拍后台扫描（round 3，不进响应）——
    // 响应值来自落地前的快照，行为面不受它影响。
    assert.equal(round, 3);
  });

  it("?endpoint= 单端点扫描失败回 500（前端保旧行不空栏）", async () => {
    const svc = mockSessionScan({ scanAgentError: new Error("scan boom") });
    const router = sessionsRouter(svc);
    const failed = fakeReqRes("/panel/api/sessions/list?refresh=1&endpoint=dsh", "GET");
    await router.handle(failed.req, failed.res);
    assert.equal(failed.res.statusCode, 500);
    assert.equal(failed.json().ok, false);
  });

  it("?endpoint= 未知 agent 按空表处理（名单外降级不抛错），参数原样透传给扫描层", async () => {
    const svc = mockSessionScan({ scanAgentResult: [] });
    const router = sessionsRouter(svc);
    const empty = fakeReqRes("/panel/api/sessions/list?endpoint=nobody", "GET");
    await router.handle(empty.req, empty.res);
    assert.equal(empty.res.statusCode, 200);
    assert.deepEqual(empty.json().sessions, []);
    assert.deepEqual(svc.calls.scanAgent, ["nobody"]);
  });

  it("TTL 过期先返回上次结果、刷新在后台（请求不等刷新）", async () => {
    let round = 0;
    const calls = { scanAll: 0 };
    const svc = {
      scanAll: async () => {
        calls.scanAll += 1;
        round += 1;
        // 第二拍扫描慢一些也无所谓：请求绝不该等它。
        if (round > 1) await new Promise((resolve) => setTimeout(resolve, 50));
        return { sessions: [{ endpoint: "claude", id: `s${round}`, file: `C:/s/${round}.jsonl` }], endpointErrors: [] };
      },
      deleteSessions: async () => ({ ok: [], fail: [] }),
    };
    // ttl=0：每一拍都过期，但只有冷缓存那一拍会等扫描。
    const router = sessionsRouter(svc, { sessionsListTtlMs: 0 });
    const first = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(first.req, first.res);
    assert.equal(first.json().sessions[0].id, "s1", "冷缓存首拍等扫描");
    const started = Date.now();
    const second = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(second.req, second.res);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 40, `过期拍不许等刷新（等了 ${elapsed}ms）`);
    assert.equal(second.json().sessions[0].id, "s1", "先返回上次结果");
    assert.equal(calls.scanAll, 2, "后台确实补了一拍刷新");
    // 刷新落地后下一次请求拿到新结果。
    await new Promise((resolve) => setTimeout(resolve, 80));
    const third = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(third.req, third.res);
    assert.equal(third.json().sessions[0].id, "s2");
  });

  // 启动预热：快照与环境检测的首扫从「第一个用户请求」挪到「进程启动」（panel-host
  // 启动时调一次 prewarmColdScans）。左栏历史与会话页的首开因此不再吃 2.7–8s 冷扫。
  it("prewarmColdScans 启动即预热：快照与环境检测各扫一拍，首个 GET 不吃冷扫", async () => {
    const svc = mockSessionScan({ scanResult: { sessions: [], endpointErrors: [] } });
    const envCalls = { getState: 0 };
    const envService = { getState: async () => { envCalls.getState += 1; return { clients: [] }; } };
    const router = sessionsRouter(svc, { environmentService: envService });
    router.prewarmColdScans();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(svc.calls.scanAll, 1, "快照启动预热已扫一拍");
    assert.equal(envCalls.getState, 1, "环境检测启动预热已跑一拍");
    const { req, res } = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(svc.calls.scanAll, 1, "预热落地的快照直接服务首个请求，不再冷扫");
  });

  // 回归钉（评审 F9）：删除与在飞刷新有竞态——删掉一行的同时后台刷新正
  // 在飞，那份结果是「删之前」的盘面，落地时会把刚删的行写回快照，最长留一个
  // TTL。用户看到的是「删了又回来」。删除代际：dropRows 时 +1，刷新落地时代际
  // 不符就整份丢弃。
  it("删除与在飞刷新竞态：已删的行不会被写回快照（回归钉）", async () => {
    let call = 0;
    let releaseSlowScan = null;
    const slow = new Promise((resolve) => { releaseSlowScan = resolve; });
    const svc = {
      scanAll: async () => {
        call += 1;
        if (call === 2) {
          // 第二拍＝删除期间在飞的那一次：它扫到的是「删除前」的盘面。
          await slow;
          return {
            sessions: [
              { endpoint: "claude", id: "keep", file: "C:/s/keep.jsonl" },
              { endpoint: "claude", id: "gone", file: "C:/s/gone.jsonl" },
            ],
            endpointErrors: [],
          };
        }
        if (call === 1) {
          return {
            sessions: [
              { endpoint: "claude", id: "keep", file: "C:/s/keep.jsonl" },
              { endpoint: "claude", id: "gone", file: "C:/s/gone.jsonl" },
            ],
            endpointErrors: [],
          };
        }
        // 之后：盘面已无 gone。
        return { sessions: [{ endpoint: "claude", id: "keep", file: "C:/s/keep.jsonl" }], endpointErrors: [] };
      },
      deleteSessions: async () => ({ ok: [{ endpoint: "claude", file: "C:/s/gone.jsonl" }], fail: [] }),
    };
    const router = sessionsRouter(svc, { sessionsListTtlMs: 0 });
    const first = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(first.req, first.res);
    assert.equal(first.json().sessions.length, 2);
    // 过期拍：先回旧值，同时后台那一拍（call 2）挂在 slow 上。
    const stale = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(stale.req, stale.res);
    assert.equal(stale.json().sessions.length, 2);
    // 刷新在飞时删除 gone。
    const del = fakeReqRes("/panel/api/sessions/delete", "POST", { items: [{ endpoint: "claude", file: "C:/s/gone.jsonl" }] });
    await router.handle(del.req, del.res);
    assert.equal(del.res.statusCode, 200);
    // 让那一拍旧盘面的刷新落地。
    releaseSlowScan();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 下一拍：已删的 gone 绝不许回来。
    const after = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(after.req, after.res);
    const ids = after.json().sessions.map((s) => s.id);
    assert.ok(!ids.includes("gone"), `已删的会话被在飞刷新写回了快照：${JSON.stringify(ids)}`);
  });

  it("GET /panel/api/sessions/list returns the scan result verbatim", async () => {
    const scan = {
      sessions: [
        { endpoint: "claude", id: "abc", title: "t", file: "C:/s/abc.jsonl", lastActive: 1 },
      ],
      endpointErrors: [],
    };
    const svc = mockSessionScan({ scanResult: scan });
    const router = sessionsRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), scan);
    assert.equal(svc.calls.scanAll, 1);
  });

  it("list degrades a single adapter failure into endpointErrors, not a 500", async () => {
    const svc = mockSessionScan({
      scanResult: {
        sessions: [{ endpoint: "kimi", id: "k1", file: "C:/k/wire.jsonl" }],
        endpointErrors: [{ endpoint: "zcode", reason: "sqlite busy" }],
      },
    });
    const router = sessionsRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().sessions.length, 1);
    assert.deepEqual(json().endpointErrors, [{ endpoint: "zcode", reason: "sqlite busy" }]);
  });

  it("surfaces a throwing scanAll as 500 { ok:false }", async () => {
    const svc = mockSessionScan({ scanError: new Error("boom") });
    const router = sessionsRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 500);
    assert.equal(json().ok, false);
    assert.equal(json().error, "boom");
  });

  it("GET /panel/api/sessions/messages passes endpoint+path through to loadMessagesResponse", async () => {
    // loadMessagesResponse returns the serialized { ok, messages, turns }
    // body string (worker-thread product); the router writes it verbatim.
    const messages = [
      { role: "user", content: "hi", ts: 1 },
      { role: "assistant", content: "hello", ts: 2 },
      { role: "tool", content: "[Tool: Read]", ts: 3 },
    ];
    const svc = mockSessionScan({ messagesResult: messages });
    const router = sessionsRouter(svc);
    const { req, res, json } = fakeReqRes(
      `/panel/api/sessions/messages?endpoint=claude&path=${encodeURIComponent("C:/s/abc.jsonl")}`,
      "GET",
    );
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    // 目录条目（turns）随正文一起下发：由 session-scan 判定，路由不自己认角色。
    assert.deepEqual(json(), {
      ok: true,
      messages,
      turns: [{ index: 0, preview: "hi", ts: 1 }],
    });
    assert.deepEqual(svc.calls.loadMessages, [["claude", "C:/s/abc.jsonl"]]);
  });

  it("messages turns exclude injected user-role text", async () => {
    const messages = [
      { role: "user", content: "# AGENTS.md instructions <INSTRUCTIONS>x</INSTRUCTIONS>", ts: 1 },
      { role: "tool", content: "Successfully modified file: panel.css", ts: 2 },
      { role: "user", content: "把右栏修好", ts: 3 },
    ];
    const router = sessionsRouter(mockSessionScan({ messagesResult: messages }));
    const { req, res, json } = fakeReqRes(
      `/panel/api/sessions/messages?endpoint=qoder&path=${encodeURIComponent("C:/s/x.jsonl")}`,
      "GET",
    );
    await router.handle(req, res);
    assert.deepEqual(json().turns, [{ index: 2, preview: "把右栏修好", ts: 3 }]);
  });

  it("messages rejects a missing endpoint or path with 400", async () => {
    const svc = mockSessionScan();
    const router = sessionsRouter(svc);
    for (const url of [
      "/panel/api/sessions/messages",
      "/panel/api/sessions/messages?endpoint=claude",
      "/panel/api/sessions/messages?path=C%3A%2Fs%2Fabc.jsonl",
      "/panel/api/sessions/messages?endpoint=&path=",
    ]) {
      const { req, res, json } = fakeReqRes(url, "GET");
      await router.handle(req, res);
      assert.equal(res.statusCode, 400, url);
      assert.equal(json().ok, false);
    }
    assert.equal(svc.calls.loadMessages.length, 0);
  });

  it("POST /panel/api/sessions/delete forwards items and returns per-item outcomes", async () => {
    // 夹具形状 = session-scan.mjs deleteSessions 的真实逐项结果：
    // ok.push({ endpoint, file })，fail.push({ endpoint, file, reason })。
    const items = [
      { endpoint: "claude", file: "C:/s/a.jsonl" },
      { endpoint: "kimi", file: "C:/k/b/wire.jsonl" },
    ];
    const svc = mockSessionScan({
      deleteResult: {
        ok: [{ endpoint: "claude", file: "C:/s/a.jsonl" }],
        fail: [{ endpoint: "kimi", file: "C:/k/b/wire.jsonl", reason: "session file is locked" }],
      },
    });
    const router = sessionsRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/sessions/delete", "POST", { items });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(svc.calls.deleteSessions, [items]);
    // 路由对逐项成败原样透传，不改写 reason、不重组条目。
    assert.deepEqual(json(), {
      ok: [{ endpoint: "claude", file: "C:/s/a.jsonl" }],
      fail: [{ endpoint: "kimi", file: "C:/k/b/wire.jsonl", reason: "session file is locked" }],
    });
  });

  it("delete 的 ok 条目按 file 就地摘除快照行（session-scan 的真实对象形状）", async () => {
    // panel.mjs 用 ok 条目的 file 匹配快照行（entry?.file）；这里用
    // session-scan 真实回传的 { endpoint, file } 形状钉住这一支：删除落地后，
    // TTL 内的列表立刻不再包含刚删的行。
    const svc = mockSessionScan({
      scanResult: {
        sessions: [
          { endpoint: "claude", id: "a", file: "C:/s/a.jsonl" },
          { endpoint: "kimi", id: "b", file: "C:/k/b/wire.jsonl" },
        ],
        endpointErrors: [],
      },
      deleteResult: {
        ok: [{ endpoint: "claude", file: "C:/s/a.jsonl" }],
        fail: [],
      },
    });
    const router = sessionsRouter(svc);
    const first = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(first.req, first.res);
    assert.deepEqual(first.json().sessions.map((s) => s.file), ["C:/s/a.jsonl", "C:/k/b/wire.jsonl"]);
    const del = fakeReqRes("/panel/api/sessions/delete", "POST", {
      items: [{ endpoint: "claude", file: "C:/s/a.jsonl" }],
    });
    await router.handle(del.req, del.res);
    assert.equal(del.res.statusCode, 200);
    const after = fakeReqRes("/panel/api/sessions/list", "GET");
    await router.handle(after.req, after.res);
    assert.deepEqual(
      after.json().sessions.map((s) => s.file),
      ["C:/k/b/wire.jsonl"],
      "刚删的行必须被就地摘出快照，用户删完立刻刷新不该再看到它",
    );
  });

  it("delete rejects a malformed body with 400 and never touches the service", async () => {
    const svc = mockSessionScan();
    const router = sessionsRouter(svc);
    for (const body of [
      {},
      { items: null },
      { items: [] },
      { items: [{ endpoint: "claude" }] },
      { items: [{ file: "C:/s/a.jsonl" }] },
      { items: [{ endpoint: "", file: "" }] },
      { items: ["not-an-object"] },
    ]) {
      const { req, res, json } = fakeReqRes("/panel/api/sessions/delete", "POST", body);
      await router.handle(req, res);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(json().ok, false);
    }
    assert.equal(svc.calls.deleteSessions.length, 0);
  });

  it("POST /panel/api/sessions/delete without the panel header is 403 (csrf gate)", async () => {
    const svc = mockSessionScan();
    const router = sessionsRouter(svc);
    const { req, res, json } = fakeReqRes(
      "/panel/api/sessions/delete",
      "POST",
      { items: [{ endpoint: "claude", file: "C:/s/a.jsonl" }] },
      { "x-anyswitch-panel": "0", origin: "http://evil.example" },
    );
    await router.handle(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(json().error, "csrf");
    assert.equal(svc.calls.deleteSessions.length, 0);
  });

  it("unknown /panel/api/sessions/* paths fall through to 404", async () => {
    const svc = mockSessionScan();
    const router = sessionsRouter(svc);
    const { req, res } = fakeReqRes("/panel/api/sessions/nope", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 404);
  });
});
