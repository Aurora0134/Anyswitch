import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPanelRouter } from "./panel.mjs";

// Sessions tab routes: the router is exercised with a mock session-scan
// service so no real agent session store is touched. Covers the B3/B4/B5
// contract shapes (REVIEW-FINDINGS.md): list degradation via endpointErrors,
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

function sessionsRouter(sessionScanService) {
  return createPanelRouter({
    storePaths: { root: "C:/fake/anyswitch" },
    logger: null,
    metricsCollector: null,
    aliasResolver: null,
    aliasPath: null,
    fetchRelayAgents: async () => null,
    sessionScanService,
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
    assert.deepEqual(json(), { ok: true, messages });
    assert.deepEqual(svc.calls.loadMessages, [["claude", "C:/s/abc.jsonl"]]);
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
