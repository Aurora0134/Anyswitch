// 终端像素密度→fit 接线（2026-10-22 收窄 bug 修复）：WebGL 渲染器按整设备像素量化
// 字宽，devicePixelRatio 变化（显示缩放/睡眠唤醒，CSS 布局不变）会让屏宽跳变而
// cols/PTY 不动；宿主 RO 与 window resize 都看不见这条变化，必须挂 resolution
// 媒体查询。断言分两层：静态源码（挂/销/路由三处接线）＋ vm 真跑换挂式监听
//（换挂新密度、摘除旧监听、防抖 fit 被调用）。取样惯例照 panel-terminal-rail：
// 源码字符串断言 + 按函数名切源码进桩环境，函数体不得出现提前闭合的「\n  }」。
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const panelJs = readFileSync(join(here, "panel-ui", "panel.js"), "utf8");

function extractFn(name) {
  const src = panelJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
  assert.ok(src, `${name} found in panel.js`);
  return src;
}

// 切出的两个函数引用模块级 let（查询/监听器句柄）并调用 debounceTerminalFit，
// 在桩环境里以同名局部量补齐闭包后真跑。
function makeWatch(window, debounceTerminalFit) {
  const factory = new Function(
    "window",
    "debounceTerminalFit",
    `
    let terminalDprMediaQuery = null;
    let terminalDprMediaHandler = null;
    ${extractFn("armTerminalDprWatch")}
    ${extractFn("disarmTerminalDprWatch")}
    return {
      arm: armTerminalDprWatch,
      disarm: disarmTerminalDprWatch,
      liveQuery: () => terminalDprMediaQuery,
      liveHandler: () => terminalDprMediaHandler,
    };
    `
  );
  return factory(window, debounceTerminalFit);
}

function stubWindow() {
  const queries = new Map();
  return {
    devicePixelRatio: 1.25,
    matchMedia(spec) {
      if (!queries.has(spec)) {
        queries.set(spec, {
          spec,
          listeners: [],
          addEventListener(type, fn) { this.listeners.push(fn); },
          removeEventListener(type, fn) {
            const at = this.listeners.indexOf(fn);
            if (at >= 0) this.listeners.splice(at, 1);
          },
        });
      }
      return queries.get(spec);
    },
    queries,
  };
}

describe("终端像素密度→fit 接线（收窄 bug 修复）", () => {
  describe("静态源码接线", () => {
    it("模块级监视句柄在册（与宿主 RO 相邻）", () => {
      const roAt = panelJs.indexOf("let terminalHostResizeObserver = null;");
      assert.ok(roAt >= 0, "宿主 RO 句柄在册");
      for (const symbol of ["let terminalDprMediaQuery = null;", "let terminalDprMediaHandler = null;"]) {
        assert.ok(panelJs.indexOf(symbol) > roAt && panelJs.indexOf(symbol) < roAt + 700,
          `${symbol} 紧邻宿主 RO 句柄`);
      }
    });

    it("建连挂载：ensureTerminalXterm 在宿主 RO observe 之后挂密度监视", () => {
      const observeAt = panelJs.indexOf("terminalHostResizeObserver.observe(host);");
      assert.ok(observeAt >= 0, "宿主 RO observe 在册");
      const armAt = panelJs.indexOf("armTerminalDprWatch();", observeAt);
      const returnAt = panelJs.indexOf("return terminalXterm;", observeAt);
      assert.ok(armAt > observeAt && armAt < returnAt, "挂载落在 observe 与函数返回之间");
    });

    it("拆流摘除：closeTerminalStream 在 RO disconnect 之后摘密度监视", () => {
      const disconnectAt = panelJs.indexOf("terminalHostResizeObserver?.disconnect();");
      assert.ok(disconnectAt >= 0, "RO disconnect 在册");
      const disarmAt = panelJs.indexOf("disarmTerminalDprWatch();", disconnectAt);
      assert.ok(disarmAt > disconnectAt && disarmAt < disconnectAt + 300, "摘除与 RO 摘除同函数同拍");
    });

    it("路由与换挂：handler 走防抖 fit，事件内先换挂新密度查询", () => {
      const armSrc = extractFn("armTerminalDprWatch");
      assert.ok(armSrc.includes("debounceTerminalFit();"), "事件路由到防抖 fit（与宿主 RO 同一条入口）");
      assert.ok(armSrc.includes("matchMedia(`screen and (resolution: ${window.devicePixelRatio}dppx)`"),
        "查询挂当前 window.devicePixelRatio（媒体查询自身闭括号在模板内）");
      const handlerArrowAt = armSrc.indexOf("=> {");
      assert.ok(armSrc.indexOf("armTerminalDprWatch();", handlerArrowAt) > handlerArrowAt,
        "事件内换挂（新密度的查询，旧查询只对旧值发声）");
      assert.ok(armSrc.indexOf("disarmTerminalDprWatch();") < handlerArrowAt,
        "挂载前先摘旧（重入安全）");
      assert.ok(armSrc.includes("query.addEventListener") && armSrc.includes("query.addListener"),
        "监听器双 API 兼容（addEventListener 优先，旧浏览器 addListener 兜底）");
    });
  });

  describe("vm 真跑（桩 window.matchMedia）", () => {
    it("挂载：只对当前密度发声，一条监听器", () => {
      const window = stubWindow();
      const watch = makeWatch(window, () => {});
      watch.arm();
      assert.equal(window.queries.size, 1, "只建一条查询");
      assert.ok(window.queries.has("screen and (resolution: 1.25dppx)"), "查询挂当前密度");
      assert.equal(window.queries.get("screen and (resolution: 1.25dppx)").listeners.length, 1,
        "恰好一条监听器");
      assert.ok(watch.liveQuery() && watch.liveHandler(), "句柄已记");
    });

    it("密度变化：换挂新密度查询、摘除旧监听、防抖 fit 被叫到", () => {
      const window = stubWindow();
      const fitCalls = [];
      const watch = makeWatch(window, () => fitCalls.push(Date.now()));
      watch.arm();
      const oldQ = window.queries.get("screen and (resolution: 1.25dppx)");
      // 事件到达时 devicePixelRatio 已是新值（内核 CoreBrowserService 同款语义）
      window.devicePixelRatio = 1.5;
      for (const fn of oldQ.listeners.slice()) fn();
      assert.ok(window.queries.has("screen and (resolution: 1.5dppx)"), "新密度查询已挂");
      assert.equal(window.queries.get("screen and (resolution: 1.5dppx)").listeners.length, 1,
        "新查询挂上监听器");
      assert.equal(oldQ.listeners.length, 0, "旧查询监听器已摘（不换挂下一次变化就聋）");
      assert.equal(fitCalls.length, 1, "防抖 fit 恰好被叫一次");
      assert.equal(watch.liveQuery().spec, "screen and (resolution: 1.5dppx)", "live 句柄已切到新查询");
    });

    it("连发两档密度：逐档换挂，fit 每次都被叫到", () => {
      const window = stubWindow();
      const fitCalls = [];
      const watch = makeWatch(window, () => fitCalls.push(1));
      watch.arm();
      window.devicePixelRatio = 1.5;
      for (const fn of window.queries.get("screen and (resolution: 1.25dppx)").listeners.slice()) fn();
      window.devicePixelRatio = 2;
      for (const fn of window.queries.get("screen and (resolution: 1.5dppx)").listeners.slice()) fn();
      assert.ok(window.queries.has("screen and (resolution: 2dppx)"), "逐档换挂到 2dppx");
      assert.equal(fitCalls.length, 2, "两档各叫一次 fit");
    });

    it("重入与摘除：重复挂载不叠监听器，摘除后句柄清空、监听器全摘", () => {
      const window = stubWindow();
      const watch = makeWatch(window, () => {});
      watch.arm();
      watch.arm();
      assert.equal(window.queries.get("screen and (resolution: 1.25dppx)").listeners.length, 1,
        "重复挂载不叠监听器（挂前先摘）");
      watch.disarm();
      assert.equal(watch.liveQuery(), null, "查询句柄清空");
      assert.equal(watch.liveHandler(), null, "监听器句柄清空");
      assert.equal(window.queries.get("screen and (resolution: 1.25dppx)").listeners.length, 0,
        "桩上监听器已摘");
      watch.disarm(); // 空态再摘不抛
    });

    it("无 matchMedia 的环境：挂载空操作不抛（桩环境/旧浏览器闸）", () => {
      const watch = makeWatch({ devicePixelRatio: 1 }, () => {});
      watch.arm();
      assert.equal(watch.liveQuery(), null, "未挂任何查询");
    });
  });
});
