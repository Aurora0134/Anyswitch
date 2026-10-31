// 终端会话栏视图状态（M7 S1/S2）：归档清单 + 已移除分组目录清单。
// 三层断言：store 纯单测（清洗/归一化/幂等/落盘形状与重读）+ 路由级
// （createPanelRouter 真跑五条端点，持久化跨router实例）+ 装配级
// （不注入 store 真跑 panel.mjs 的惰性装配分支，落点与跨实例加载）。
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPanelRouter } from "./panel.mjs";
import { createRailStore, normalizeRailDir, TERMINAL_RAIL_STORE_FILE } from "./terminal-rail-store.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

const panelJs = readFileSync(fileURLToPath(new URL("./panel-ui/panel.js", import.meta.url)), "utf8");

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
  // base 一并隔离：不传 base 时 createPanelRouter 落到 process.env，settingsFile
  // 会指到真机 %LOCALAPPDATA%\Anyswitch\settings.json（logLevelGate 每拍真读），
  // 测试结果随宿主机设置漂移。这里把 settings 落点也圈进用例自己的临时目录
  // （照 panel-self-update.test.mjs 的 base 隔离惯例）；store 不注入时走惰性装配。
  return createPanelRouter({
    base: { LOCALAPPDATA: root },
    storePaths: { root },
    logger: null, metricsCollector: null,
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
      // 落盘形状钉死：{version, archived, removedGroups} 三键俱全。version 由写侧
      // 负责、读侧不认它（只取 archived/removedGroups），所以必须对原始文件断言，
      // store API 层面看不出来。
      const onDisk = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(onDisk, { version: 1, archived: [{ endpoint: "kimi", id: "s-1" }], removedGroups: ["C:\\Dev\\Alpha"] }, "落盘形状 {version, archived, removedGroups}");
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

    it("归一化：与前端同一把尺（大小写/斜杠/尾斜杠不敏感）；纯空白按空值——后端比前端多一道 trim", () => {
      // 前端那把尺直接从 panel.js 抽真函数（同 panel-terminal-rail-actions.test.mjs
      // 的抽取惯例），不在测试里复刻实现——复刻只会钉住复制品。
      const frontNormDir = (() => {
        const src = panelJs.match(/function terminalRailNormDir\([\s\S]*?\n  \}/)?.[0];
        assert.ok(src, "terminalRailNormDir 在 panel.js 在册");
        return vm.runInNewContext(`(${src})`);
      })();
      assert.equal(normalizeRailDir("C:\\Dev\\Alpha"), "c:\\dev\\alpha", "小写+统一分隔符");
      assert.equal(normalizeRailDir("C:/Dev/Alpha/"), "c:\\dev\\alpha", "斜杠归一+去尾斜杠");
      assert.equal(normalizeRailDir("  C:\\Dev\\Alpha  "), "c:\\dev\\alpha", "首尾空白剥掉（后端多一道 trim）");
      for (const raw of ["C:\\Dev\\Alpha", "C:/Dev/Alpha/", "C:\\DEV\\alpha\\\\"]) {
        assert.equal(normalizeRailDir(raw), frontNormDir(raw), `真实路径两侧同键：${raw}`);
      }
      // 两侧唯一分歧（源码注释自证「多一道 trim」）：纯空白后端按坏数据判 null，
      // 前端无 trim、原样进键。真实 project/目录路径不含纯空白，分歧落不到真实
      // 数据上；按实测值钉住，防止再把「同尺」误读成「逐字同源」。
      assert.equal(normalizeRailDir("  "), null, "空白不是目录");
      assert.equal(frontNormDir("  "), "  ", "前端无 trim，纯空白原样保留（与后端 null 的分歧在册）");
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

    it("坏条目加载时清洗：坏归档条目不进清单，目录按归一化键去重、保留原始拼写", () => {
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

    it("未注入 store 时走 panel.mjs 惰性装配：落点 relayRoot 下 terminal-rail.json，跨实例读回", async () => {
      const root = mkTestDir("anyswitch-rail-lazy-");
      const file = join(root, TERMINAL_RAIL_STORE_FILE);
      // 两个 router 都不注入 terminalRailStore：装配只能走 panel.mjs 的
      // terminalRailPrefs() 惰性分支（file = join(relayRoot, TERMINAL_RAIL_STORE_FILE)，
      // 与绑定库同一惯例）。装配若被拆掉，这里会 500/空表，源码子串断言钉不住这一点。
      const first = railRouter({ root });
      let call = fakeReqRes("/panel/api/terminal/rail/archive", "POST", { endpoint: "kimi", id: "s-1" });
      await first.handle(call.req, call.res);
      assert.equal(call.res.statusCode, 200);
      assert.equal(call.json().ok, true);
      assert.ok(existsSync(file), "惰性装配落在 relayRoot/terminal-rail.json");

      const second = railRouter({ root });
      call = fakeReqRes("/panel/api/terminal/rail/prefs", "GET");
      await second.handle(call.req, call.res);
      assert.equal(call.res.statusCode, 200);
      assert.deepEqual(call.json().archived, [{ endpoint: "kimi", id: "s-1" }], "新实例从盘上惰性加载");
    });
    // 五条路由的注册与 200/400 行为已由上面四条用例真跑覆盖（GET prefs +
    // archive/unarchive/remove-group/restore-group 各自真发请求），不再保留
    // panel.mjs 源码子串/正则钉死——那类断言对等价改写（改形制不改行为）会假红，
    // 对装配被拆（import 行即含标识符）又假绿。
  });
});
