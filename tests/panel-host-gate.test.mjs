// AUTH-1 · 面板读面 Host 门（封 DNS rebinding）。三段：
// ① isTrustedPanelHostHeader 纯函数：环回各形 / 敌意域名 / 裸 127.0.0.1 无端口 /
//   缺头 / 畸形 Host。
// ② mock 路由级：敌意 Host 403（GET 与 POST 都拦在 POST 写门之前）、缺头 403、
//   环回照常放行；写门兜底漏洞闭合（环回 Origin＋敌意 Host 的 POST 原先放行）；
//   环回 Host＋双头（x-anyswitch-panel / 旧名 x-apicred-panel）写门兼容不变。
// ③ 活体腿：仿上轮 AUTH-1 复现手法——DI 起 createPanelServer 绑临时端口，
//   node:http.request 覆写 Host（undici fetch 会静默丢弃 Host 覆写，上轮已证）：
//   attacker.example 下读路由全 403 且响应体无合成秘密，真实环回 Host 全 200。
//   此即 rebinding 的服务端等效证明；浏览器侧 LNA/PNA 闸门不依赖、不测。
//
// env 沙箱先于 panel.mjs 的动态 import：session-scan 的 defaultScanner 在模块
// 加载期按 HOME 固化各 adapter 的存档根，先 import 后改 env 会让活体腿的
// messages 路由拿真实 HOME 当根（沙箱 transcript 判越界 500）。mock 腿全走
// 注入不受 env 影响；env 只活在本测试进程（test runner 每文件独立进程）。
// 动态 import 同时让待测导出缺失时给出逐腿断言红，而非整文件链接期崩。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { mkTestDir } from "../test-helpers/tmp.mjs";

// ── 沙箱（活体腿与 env 重定向共用）──
// root 取 <LOCALAPPDATA>/Anyswitch：settings 路由读的是 defaultSettingsPath
// （panel.mjs 在 router 创建期按 base 解析），标记文件必须落在它实际读的位置。
const sandbox = mkTestDir("anyswitch-auth1-live-");
const home = join(sandbox, "home");
const local = join(sandbox, "local");
const temp = join(sandbox, "temp");
const root = join(local, "Anyswitch");
for (const d of [join(home, "AppData", "Roaming"), local, temp, root]) mkdirSync(d, { recursive: true });
const settingsFile = join(root, "settings.json");
writeFileSync(settingsFile, JSON.stringify({ logLevel: "info", syntheticMarker: "AUTH1-LIVE-MARKER-7c1e" }, null, 2));

// 合成 transcript：messages 路由的环回对照腿要真读到内容。
const projDir = join(home, ".claude", "projects", "C--synthetic-proj");
mkdirSync(projDir, { recursive: true });
const transcript = join(projDir, "sess-synth-1.jsonl");
const SECRET = "AUTH1-LIVE-SECRET-9f3c: payroll file C:/synth/secret.xlsx";
writeFileSync(transcript, [
  JSON.stringify({ sessionId: "sess-synth-1", cwd: "C:\\synthetic\\proj", timestamp: "2026-11-01T00:00:00.000Z", type: "user", message: { role: "user", content: SECRET } }),
  JSON.stringify({ sessionId: "sess-synth-1", cwd: "C:\\synthetic\\proj", timestamp: "2026-11-01T00:05:00.000Z", type: "assistant", message: { role: "assistant", content: "ack" } }),
].join("\n") + "\n");

const prevEnv = Object.fromEntries(
  ["USERPROFILE", "HOME", "LOCALAPPDATA", "TEMP", "TMP", "APPDATA", "ANYSWITCH_UPDATE_DISABLED", "ANYSWITCH_JOURNAL_DIR"].map((k) => [k, process.env[k]]),
);
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.LOCALAPPDATA = local;
process.env.TEMP = temp;
process.env.TMP = temp;
process.env.APPDATA = join(home, "AppData", "Roaming");
process.env.ANYSWITCH_UPDATE_DISABLED = "1";
process.env.ANYSWITCH_JOURNAL_DIR = join(sandbox, "journal");

const panel = await import("../src/panel/panel.mjs");

describe("AUTH-1 · isTrustedPanelHostHeader 纯函数", () => {
  it("环回各形可信（只认主机名，不校验端口）", () => {
    assert.equal(typeof panel.isTrustedPanelHostHeader, "function", "实现规格要求导出该纯函数");
    for (const host of [
      "127.0.0.1", "127.0.0.1:47820", "127.0.0.1:9999",
      "localhost", "localhost:47820", "LOCALHOST:47820",
      "[::1]", "[::1]:47820", "[::1]:12345",
    ]) {
      assert.equal(panel.isTrustedPanelHostHeader(host), true, `Host "${host}" 应可信`);
    }
  });

  it("敌意域名与前后缀伪装不可信", () => {
    for (const host of [
      "attacker.example", "attacker.example:47820",
      "sub.localhost",              // *.localhost 解析到环回，但主机名非裸 localhost
      "127.0.0.1.evil.com",         // 前缀伪装
      "192.168.1.5:47820",
      "[::ffff:127.0.0.1]:47820",   // IPv4-mapped 形，URL 规范化为 [::ffff:7f00:1]
    ]) {
      assert.equal(panel.isTrustedPanelHostHeader(host), false, `Host "${host}" 应不可信`);
    }
  });

  it("缺头 / 空串按不可信（fail closed）", () => {
    for (const host of [null, undefined, ""]) {
      assert.equal(panel.isTrustedPanelHostHeader(host), false, `Host ${JSON.stringify(host)} 应不可信`);
    }
  });

  it("畸形 Host 不可信（解析失败即拒）", () => {
    for (const host of ["127.0.0.1:99999", "attacker example", "http://attacker.example"]) {
      assert.equal(panel.isTrustedPanelHostHeader(host), false, `Host "${host}" 应不可信`);
    }
  });
});

// ── mock 路由级 ──
// fakeReqRes 与 routerWith 的 DI 形状照抄 tests/panel.test.mjs（已验证能让
// GET /panel/api/status 返回 200）。GET 走 /panel/api/status：不触发 watchdog
// 探针（PowerShell / 常驻端口 GET），mock 腿保持零真实副作用。
function fakeReqRes(url, method = "GET", body = null, extraHeaders = {}) {
  const res = {
    statusCode: null,
    headers: {},
    body: "",
    _events: {},
    once(event, fn) { (this._events[event] ??= []).push(fn); return res; },
    emit(event) { for (const fn of this._events?.[event] ?? []) fn(); return true; },
    writeHead(code, h) { this.statusCode = code; this.headers = h || {}; },
    end(data) { if (data !== undefined) this.body += data; },
  };
  const listeners = {};
  const req = {
    url,
    method,
    headers: {
      host: "127.0.0.1",
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

function gateRouter(logger = null) {
  return panel.createPanelRouter({
    storePaths: { root: "C:/fake/anyswitch" },
    logger,
    metricsCollector: null,
    startTime: 123456,
    getRelayStatusFn: async () => ({ status: "stopped", pid: null, port: 47821 }),
    startRelayFn: async () => ({ ok: true, relay: { status: "running", pid: 4242, port: 47821 } }),
    stopRelayFn: async () => ({ ok: true, relay: { status: "stopped", pid: null, port: 47821 } }),
    restartRelayFn: async () => ({ ok: true, relay: { status: "running", pid: 4243, port: 47821 } }),
    fetchRelayAgents: async () => null,
    fetchTerminalHostStatus: async () => null,
  });
}

describe("AUTH-1 · 路由级 Host 门（mock）", () => {
  it("敌意 Host 的 GET 读路由 403，机器可读 error host", async () => {
    const router = gateRouter();
    const { req, res, json } = fakeReqRes("/panel/api/status", "GET", null, { host: "attacker.example" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(json().ok, false);
    assert.equal(json().error, "host");
  });

  it("缺 Host 的 GET 403", async () => {
    const router = gateRouter();
    const { req, res, json } = fakeReqRes("/panel/api/status", "GET", null, { host: undefined });
    await router.handle(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(json().error, "host");
  });

  it("环回 Host 各形 GET 照常 200", async () => {
    for (const host of ["127.0.0.1", "localhost:47820", "[::1]:47820"]) {
      const router = gateRouter();
      const { req, res } = fakeReqRes("/panel/api/status", "GET", null, { host });
      await router.handle(req, res);
      assert.equal(res.statusCode, 200, `Host "${host}" 应照常放行`);
    }
  });

  it("敌意 Host 拒绝时打 warn：方法 / 路径 / 来者 Host 都在日志里", async () => {
    const warnings = [];
    const router = gateRouter({ warn: (line) => warnings.push(String(line)) });
    const { req, res } = fakeReqRes("/panel/api/status", "GET", null, { host: "attacker.example" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 403);
    assert.ok(
      warnings.some((w) => w.includes("GET") && w.includes("/panel/api/status") && w.includes("attacker.example")),
      `warn 应含方法/路径/来者 Host，实际：${JSON.stringify(warnings)}`,
    );
  });

  it("写门兜底漏洞闭合：环回 Origin＋敌意 Host＋panel 头的 POST 从放行变 403 host（Host 门先于 csrf 门）", async () => {
    const router = gateRouter();
    // 路径故意不存在：旧代码放行后落到 404（不触发写副作用）；新代码必须在
    // 路由分发前拦下。headers 三件套齐备＝旧写门判 ALLOW 的完整形态。
    const { req, res, json } = fakeReqRes("/panel/api/auth1-no-such-route", "POST", null, { host: "attacker.example" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(json().error, "host", "应是 host 门拦截而非 csrf（钉住门的顺序）");
  });

  it("环回 Host＋双头（旧名 x-apicred-panel / 新名 x-anyswitch-panel）写门兼容不变", async () => {
    for (const headerName of ["x-apicred-panel", "x-anyswitch-panel"]) {
      const router = gateRouter();
      const headers = { host: "127.0.0.1:47820", [headerName]: "1" };
      const { req, res, json } = fakeReqRes("/panel/api/auth1-no-such-route", "POST", null, headers);
      await router.handle(req, res);
      // 404 ＝ 两道门都放行、落到路由分发：写门行为未被 Host 门改变。
      assert.equal(res.statusCode, 404, `双头 ${headerName} 应照旧过两道门`);
      assert.equal(json().error, "not found");
    }
  });

  it("环回 Host 无 panel 头的 POST 仍 403 csrf（既有写门不受影响）", async () => {
    const router = gateRouter();
    const { req, res, json } = fakeReqRes("/panel/api/settings", "POST", null, { "x-anyswitch-panel": undefined });
    await router.handle(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(json().error, "csrf");
  });
});

// ── 活体腿 ──
// 生产栈（createPanelServer）绑 127.0.0.1 临时端口，node:http.request 显式
// 覆写 Host。prewarm 会照生产语义发只读探针（PowerShell 计划任务/进程查询、
// 常驻 watchdog 健康探活），与上轮留档探针同一副作用面。
describe("AUTH-1 · 活体腿：createPanelServer＋Host 覆写", () => {
  it("attacker.example 读路由全 403 且无泄漏；真实环回 Host 全 200", async () => {
    const warnings = [];
    let server = null;
    try {
      const { createPanelServer } = await import("../src/panel/panel-host.mjs");
      const { storePaths } = await import("../src/store/store-io.mjs");
      const built = createPanelServer({
        paths: storePaths(root),
        settingsFile,
        selfUpdateAutoDownloadScheduleFn: () => ({ first: null, interval: null }),
        logger: { warn: (line) => warnings.push(String(line)) },
      });
      server = built.server;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const port = server.address().port;

      // agent:false → 一次性连接，避免 keep-alive 挂住 server.close()。
      function rawReq(method, path, headers = {}) {
        return new Promise((resolve, reject) => {
          const r = request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c) => { text += c; });
            res.on("end", () => resolve({ status: res.statusCode, text }));
          });
          r.on("error", reject);
          r.end();
        });
      }

      const readRoutes = [
        "/panel/api/settings",
        "/panel/api/status",
        "/panel/api/app-info",
        "/panel/api/sessions/list",
        `/panel/api/sessions/messages?endpoint=claude&path=${encodeURIComponent(transcript)}`,
      ];

      // 1) 敌意 Host：全部读路由 403，响应体不含合成秘密。
      for (const path of readRoutes) {
        const r = await rawReq("GET", path, { host: "attacker.example" });
        assert.equal(r.status, 403, `敌意 Host GET ${path} 应 403`);
        assert.ok(r.text.includes("\"error\":\"host\""), `GET ${path} 403 体应为机器可读 error host`);
        assert.ok(!r.text.includes(SECRET) && !r.text.includes("AUTH1-LIVE-MARKER"), `GET ${path} 响应体不得泄漏沙箱数据`);
      }

      // 2) 写门兜底漏洞闭合（活体版）：环回 Origin＋panel 头＋敌意 Host 的 POST
      //    拦在路由分发前（路径不存在，旧代码会放行落到 404）。
      const postHole = await rawReq("POST", "/panel/api/auth1-no-such-route", {
        host: "attacker.example",
        origin: "http://127.0.0.1:47820",
        "x-anyswitch-panel": "1",
      });
      assert.equal(postHole.status, 403, "环回 Origin＋敌意 Host 的 POST 应 403");
      assert.ok(postHole.text.includes("\"error\":\"host\""));

      // 3) 真实环回 Host（浏览器实际发出的形态＝IP:端口）：全部读路由 200，
      //    settings 带合成标记、messages 带合成秘密——与敌意腿的对照面。
      for (const path of readRoutes) {
        const r = await rawReq("GET", path, { host: `127.0.0.1:${port}` });
        assert.equal(r.status, 200, `环回 Host GET ${path} 应 200`);
      }
      const settings = await rawReq("GET", "/panel/api/settings", { host: `127.0.0.1:${port}` });
      assert.ok(settings.text.includes("AUTH1-LIVE-MARKER"), "环回 Host 下 settings 照常下发沙箱标记");
      const messages = await rawReq("GET", readRoutes[4], { host: `127.0.0.1:${port}` });
      assert.ok(messages.text.includes(SECRET), "环回 Host 下会话消息照常可读");

      // 4) 敌意腿拒绝时 warn 有痕（方法 / 路径 / 来者 Host）。
      assert.ok(
        warnings.some((w) => w.includes("attacker.example") && w.includes("/panel/api/settings")),
        `活体敌意腿应有 warn 留痕，实际：${JSON.stringify(warnings.slice(0, 5))}`,
      );
    } finally {
      if (server) {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
      }
      // env 恢复：虽只活在本测试进程，仍按原样复位，避免同进程后续用例意外继承。
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

process.on("exit", () => {
  rmSync(sandbox, { recursive: true, force: true });
});
