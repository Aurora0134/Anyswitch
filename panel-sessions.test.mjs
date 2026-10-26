import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPanelRouter } from "./panel.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

// Sessions tab routes: the router is exercised with a mock session-scan
// service so no real agent session store is touched. Covers the route
// contract shapes: list degradation via endpointErrors,
// messages query-param validation, per-item delete outcomes, and the roots
// whitelist rejection surfaced from session-scan's delete. Mirrors the
// fakeReqRes pattern from panel-stats.test.mjs.

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
    aliasResolver: null,
    aliasPath: null,
    fetchRelayAgents: async () => null,
    sessionScanService,
    ...extra,
  });
}

function mockSessionScan({ scanResult, scanError, messagesResult, deleteResult } = {}) {
  const calls = { scanAll: 0, loadMessages: [], deleteSessions: [] };
  return {
    calls,
    scanAll: async () => {
      calls.scanAll += 1;
      if (scanError) throw scanError;
      return scanResult ?? { sessions: [], endpointErrors: [] };
    },
    loadMessages: async (endpoint, file) => {
      calls.loadMessages.push([endpoint, file]);
      return messagesResult ?? { session: { endpoint, file }, messages: [] };
    },
    deleteSessions: async (items) => {
      calls.deleteSessions.push(items);
      if (typeof deleteResult === "function") return deleteResult(items);
      return deleteResult ?? { ok: items.map((it) => it.file), fail: [] };
    },
  };
}

describe("panel router sessions routes", () => {
  // 回归钉（M1）：不注入 sessionScanService 时，列表扫描必须走扫描承载（worker
  // 线程），绝不许在面板进程里直接跑 session-scan 的同步 fs 扫描。修前这条路径
  // 就是 `scanAll: sessionScanAll`——一次 8s 的同步块，整个面板停摆。
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
    const started = Date.now();
    let worstGap = 0;
    let last = Date.now();
    let ticks = 0;
    const list = fakeReqRes("/panel/api/sessions/list", "GET");
    const done = router.handle(list.req, list.res);
    while (Date.now() - started < 250) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const now = Date.now();
      worstGap = Math.max(worstGap, now - last - 5);
      last = now;
      ticks += 1;
    }
    await done;
    assert.equal(list.res.statusCode, 200);
    assert.ok(ticks > 10, `定时器链几乎没跑（${ticks} 拍），扫描把面板事件循环按住了`);
    assert.ok(worstGap < 150, `扫描期间事件循环空档 ${worstGap}ms`);
  });

  // 回归钉（M1）：列表路由的扫描是「短 TTL + 在飞去重 + 先返回上次结果」。
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

  // 回归钉（M1，评审 F2）：会话管理 tab 的刷新按钮不许变成假动作。TTL 内
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
      loadMessages: async () => [],
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
      loadMessages: async () => [],
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

  // 回归钉（M1，评审 F9）：删除与在飞刷新有竞态——删掉一行的同时后台刷新正
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
      loadMessages: async () => [],
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

  it("GET /panel/api/sessions/messages passes endpoint+path through to loadMessages", async () => {
    // loadMessages returns a bare message array; the router wraps it as
    // { ok, messages } for the frontend contract.
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
    const items = [
      { endpoint: "claude", file: "C:/s/a.jsonl" },
      { endpoint: "kimi", file: "C:/k/b/wire.jsonl" },
    ];
    const svc = mockSessionScan({
      deleteResult: {
        ok: ["C:/s/a.jsonl"],
        fail: [{ id: "C:/k/b/wire.jsonl", reason: "文件被占用" }],
      },
    });
    const router = sessionsRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/sessions/delete", "POST", { items });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(svc.calls.deleteSessions, [items]);
    assert.deepEqual(json(), {
      ok: ["C:/s/a.jsonl"],
      fail: [{ id: "C:/k/b/wire.jsonl", reason: "文件被占用" }],
    });
  });

  it("delete surfaces a roots-whitelist rejection as the item's fail reason", async () => {
    // session-scan canonicalizes and rejects paths outside the adapter roots;
    // the router must pass that per-item failure through untouched.
    const svc = mockSessionScan({
      deleteResult: (items) => ({
        ok: [],
        fail: items.map((it) => ({ id: it.file, reason: "路径不在该端点会话目录内" })),
      }),
    });
    const router = sessionsRouter(svc);
    const { req, res, json } = fakeReqRes("/panel/api/sessions/delete", "POST", {
      items: [{ endpoint: "claude", file: "C:/Windows/evil.jsonl" }],
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json().ok, []);
    assert.equal(json().fail.length, 1);
    assert.match(json().fail[0].reason, /会话目录/);
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
