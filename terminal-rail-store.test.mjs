// 终端会话栏视图状态（M7 S1/S2）：归档清单 + 已移除分组目录清单。
// 两层断言：store 纯单测（清洗/归一化/幂等/落盘重读）+ 路由级
// （createPanelRouter 真跑五条端点，持久化跨router实例）。
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPanelRouter } from "./panel.mjs";
import { createRailStore, normalizeRailDir, TERMINAL_RAIL_STORE_FILE } from "./terminal-rail-store.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

const panelMjs = readFileSync(fileURLToPath(new URL("./panel.mjs", import.meta.url)), "utf8");

function fakeReqRes(url, method = "GET", body = null) {
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

function railRouter({ root, store }) {
  return createPanelRouter({
    storePaths: { root },
    logger: null, metricsCollector: null, aliasResolver: null, aliasPath: null,
    fetchRelayAgents: async () => null,
    terminalRailStore: store,
  });
}

describe("终端会话栏视图状态存储（M7）", () => {
  describe("store：归档清单", () => {
    const withStore = (fn) => {
      const root = mkTestDir("anyswitch-rail-store-");
      return fn(createRailStore({ file: join(root, TERMINAL_RAIL_STORE_FILE) }), root);
    };

    it("归档＝标记＋过滤语义：键＝endpoint＋session id，重复归档幂等", () => {
      withStore((store) => {
        assert.equal(store.archive("kimi", "s-1"), true, "首次归档");
        assert.equal(store.isArchived("kimi", "s-1"), true, "同键可查");
        assert.equal(store.isArchived("claude", "s-1"), false, "换端点不算同一会话");
        assert.equal(store.archive("kimi", "s-1"), false, "重复归档无变化（调用方不必重渲）");
        assert.deepEqual(store.list().archived, [{ endpoint: "kimi", id: "s-1" }], "全量快照一条");
      });
    });

    it("取消归档＝从清单移除，磁盘会话不受影响（本模块不碰任何会话文件）", () => {
      withStore((store) => {
        store.archive("kimi", "s-1");
        assert.equal(store.unarchive("kimi", "s-1"), true, "取消生效");
        assert.equal(store.isArchived("kimi", "s-1"), false, "取消后不再过滤");
        assert.equal(store.unarchive("kimi", "s-1"), false, "重复取消无变化");
        assert.deepEqual(store.list().archived, [], "清单清空");
      });
    });

    it("非法入参一律拒（空串/超长/非字符串），不落盘不炸", () => {
      withStore((store) => {
        for (const [endpoint, id] of [["", "s-1"], ["kimi", ""], [null, "s-1"], ["kimi", 42], ["k".repeat(65), "s-1"], ["kimi", "x".repeat(257)]]) {
          assert.equal(store.archive(endpoint, id), false, `archive(${endpoint}, ${id}) 拒收`);
        }
        assert.deepEqual(store.list().archived, [], "一条都不进");
      });
    });

    it("落盘即持久化：新实例从盘上原样读回（页面刷新/面板重启不丢）", () => {
      const root = mkTestDir("anyswitch-rail-store-");
      const file = join(root, TERMINAL_RAIL_STORE_FILE);
      const first = createRailStore({ file });
      first.archive("kimi", "s-1");
      first.removeGroup("C:\\Dev\\Alpha");
      const second = createRailStore({ file });
      assert.equal(second.isArchived("kimi", "s-1"), true, "归档跨实例");
      assert.equal(second.isGroupRemoved("c:/dev/alpha"), true, "移除分组跨实例");
    });

    it("坏文件/缺文件从空开始：视图状态丢了不挡面板主流程", () => {
      const root = mkTestDir("anyswitch-rail-store-");
      const file = join(root, TERMINAL_RAIL_STORE_FILE);
      writeFileSync(file, "{ 这不是 json");
      const store = createRailStore({ file });
      assert.deepEqual(store.list(), { archived: [], removedGroups: [] }, "损坏文件按空起步");
    });
  });

  describe("store：已移除分组目录清单", () => {
    const withStore = (fn) => {
      const root = mkTestDir("anyswitch-rail-store-");
      return fn(createRailStore({ file: join(root, TERMINAL_RAIL_STORE_FILE) }), root);
    };

    it("归一化口径同前端 terminalRailSameDir：大小写/斜杠/尾斜杠不敏感", () => {
      assert.equal(normalizeRailDir("C:\\Dev\\Alpha"), "c:\\dev\\alpha");
      assert.equal(normalizeRailDir("C:/Dev/Alpha/"), "c:\\dev\\alpha");
      assert.equal(normalizeRailDir("  "), null, "空白不是目录");
      assert.equal(normalizeRailDir(null), null, "空值不是目录");
      withStore((store) => {
        store.removeGroup("C:\\Dev\\Alpha");
        assert.equal(store.isGroupRemoved("c:/dev/alpha/"), true, "不同拼写同一目录（前端按原路径查）");
        assert.equal(store.removeGroup("c:/dev/alpha"), false, "重复移除无变化");
      });
    });

    it("移除可恢复：恢复后该目录的会话重新归组", () => {
      withStore((store) => {
        store.removeGroup("C:\\Dev\\Alpha");
        assert.equal(store.restoreGroup("c:/dev/alpha"), true, "恢复生效（归一化后同键）");
        assert.equal(store.isGroupRemoved("C:\\Dev\\Alpha"), false, "恢复后不再进未分组");
        assert.equal(store.restoreGroup("C:\\Dev\\Alpha"), false, "重复恢复无变化");
        assert.equal(store.restoreGroup(""), false, "空目录拒收");
      });
    });

    it("落盘形状：{version, archived, removedGroups}，坏条目加载时清洗", () => {
      const root = mkTestDir("anyswitch-rail-store-");
      const file = join(root, TERMINAL_RAIL_STORE_FILE);
      writeFileSync(file, JSON.stringify({
        version: 1,
        archived: [{ endpoint: "kimi", id: "s-1" }, { endpoint: "" }, "垃圾", null, { endpoint: "kimi", id: 7 }],
        removedGroups: ["C:\\Dev\\Alpha", "", null, "c:/dev/alpha", 42],
      }));
      const store = createRailStore({ file });
      assert.deepEqual(store.list().archived, [{ endpoint: "kimi", id: "s-1" }], "坏归档条目被清洗");
      assert.deepEqual(store.list().removedGroups, ["C:\\Dev\\Alpha"], "坏目录条目被清洗、按归一化键去重、保留原始拼写");
    });
  });

  describe("路由级：GET 全量 + POST 四个动作", () => {
    const withRouter = (fn) => {
      const root = mkTestDir("anyswitch-rail-route-");
      const store = createRailStore({ file: join(root, TERMINAL_RAIL_STORE_FILE) });
      const router = railRouter({ root, store });
      return fn({ router, store, root, file: join(root, TERMINAL_RAIL_STORE_FILE) });
    };

    it("GET /panel/api/terminal/rail/prefs：全量下发归档与移除清单", async () => {
      await withRouter(async ({ router }) => {
        const { req, res, json } = fakeReqRes("/panel/api/terminal/rail/prefs", "GET");
        await router.handle(req, res);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(json(), { ok: true, archived: [], removedGroups: [] }, "空库原样");
      });
    });

    it("归档 → 取消归档：POST 即落盘，快照跟随", async () => {
      await withRouter(async ({ router, file }) => {
        let call = fakeReqRes("/panel/api/terminal/rail/archive", "POST", { endpoint: "kimi", id: "s-1" });
        await router.handle(call.req, call.res);
        assert.equal(call.res.statusCode, 200);
        assert.equal(call.json().ok, true);
        call = fakeReqRes("/panel/api/terminal/rail/prefs", "GET");
        await router.handle(call.req, call.res);
        assert.deepEqual(call.json().archived, [{ endpoint: "kimi", id: "s-1" }], "归档进快照");

        call = fakeReqRes("/panel/api/terminal/rail/unarchive", "POST", { endpoint: "kimi", id: "s-1" });
        await router.handle(call.req, call.res);
        assert.equal(call.res.statusCode, 200);
        call = fakeReqRes("/panel/api/terminal/rail/prefs", "GET");
        await router.handle(call.req, call.res);
        assert.deepEqual(call.json().archived, [], "取消后出快照");

        // 持久化跨 router 实例：面板重启后清单还在
        assert.ok(existsSync(file), "落盘");
        const revived = railRouter({ root: dirname(file), store: createRailStore({ file }) });
        const again = fakeReqRes("/panel/api/terminal/rail/prefs", "GET");
        await revived.handle(again.req, again.res);
        assert.deepEqual(again.json().archived, [], "跨实例一致");
      });
    });

    it("移除分组 → 恢复分组：POST 即落盘，恢复后出清单", async () => {
      await withRouter(async ({ router }) => {
        let call = fakeReqRes("/panel/api/terminal/rail/remove-group", "POST", { dir: "C:\\Dev\\Alpha" });
        await router.handle(call.req, call.res);
        assert.equal(call.res.statusCode, 200);
        call = fakeReqRes("/panel/api/terminal/rail/prefs", "GET");
        await router.handle(call.req, call.res);
        assert.deepEqual(call.json().removedGroups, ["C:\\Dev\\Alpha"], "保留原始拼写入清单（恢复区 title 要给完整路径）");

        call = fakeReqRes("/panel/api/terminal/rail/restore-group", "POST", { dir: "C:\\Dev\\Alpha" });
        await router.handle(call.req, call.res);
        assert.equal(call.res.statusCode, 200);
        call = fakeReqRes("/panel/api/terminal/rail/prefs", "GET");
        await router.handle(call.req, call.res);
        assert.deepEqual(call.json().removedGroups, [], "恢复后出清单");
      });
    });

    it("非法载荷 400 拒收，不落盘不炸", async () => {
      await withRouter(async ({ router, store }) => {
        for (const [path, body] of [
          ["/panel/api/terminal/rail/archive", { endpoint: "kimi" }],
          ["/panel/api/terminal/rail/archive", { id: "s-1" }],
          ["/panel/api/terminal/rail/archive", { endpoint: "  ", id: "s-1" }],
          ["/panel/api/terminal/rail/remove-group", {}],
          ["/panel/api/terminal/rail/remove-group", { dir: "   " }],
          ["/panel/api/terminal/rail/restore-group", { dir: null }],
        ]) {
          const call = fakeReqRes(path, "POST", body);
          await router.handle(call.req, call.res);
          assert.equal(call.res.statusCode, 400, `${path} ${JSON.stringify(body)} 判非法`);
          assert.equal(call.json().ok, false, "带 ok:false");
        }
        assert.deepEqual(store.list(), { archived: [], removedGroups: [] }, "一条都不进");
      });
    });

    it("源码钉死：store 经 panel.mjs 惰性装配（同绑定库惯例），路由五条在册", () => {
      assert.ok(panelMjs.includes("TERMINAL_RAIL_STORE_FILE"), "store 文件名常量经 panel.mjs 引用");
      assert.ok(panelMjs.includes("createRailStore"), "store 工厂经 panel.mjs 引用");
      assert.ok(panelMjs.includes('"/panel/api/terminal/rail/prefs"'), "GET 全量路由在册");
      // 四个动作路由同一形制循环分派（各动作一个路径，与 store 四个方法一一对应）
      assert.ok(/for \(const action of \["archive", "unarchive", "remove-group", "restore-group"\]\)/.test(panelMjs),
        "archive/unarchive/remove-group/restore-group 四动作在册");
      assert.ok(/if \(path === `\/panel\/api\/terminal\/rail\/\$\{action\}` && method === "POST"\)/.test(panelMjs),
        "动作路由按 action 拼装、只收 POST");
    });
  });
});
