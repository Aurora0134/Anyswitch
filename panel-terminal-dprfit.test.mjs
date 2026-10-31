// 终端像素密度→fit 接线（2026-10-22 收窄 bug 修复）：WebGL 渲染器按整设备像素量化
// 字宽，devicePixelRatio 变化（显示缩放/睡眠唤醒，CSS 布局不变）会让屏宽跳变而
// cols/PTY 不动；宿主 RO 与 window resize 都看不见这条变化，必须挂 resolution
// 媒体查询。断言分两层：静态源码（挂/销/路由三处接线＋事件名）＋ vm 真跑换挂式监听
//（换挂新密度、摘除旧监听、防抖 fit 被调用）。取样惯例照 panel-terminal-rail：
// 源码字符串断言 + 按函数名切源码进桩环境，函数体不得出现提前闭合的「\n  }」。
// 桩的媒体查询按事件名分桶存监听器，用例只按 "change" 派发与清点——源码把监听
// 注册到别的媒体查询事件名时桩上收不到派发，用例即红（事件名是本接线的核心契约）。
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
        // 按事件名分桶存监听器（真实 MediaQueryList 只在 change 上发声）：源码把
        // 监听器注册到哪个事件名就落在哪个桶里，类型参数不再被吞掉。
        queries.set(spec, {
          spec,
          listeners: new Map(),
          addEventListener(type, fn) {
            if (!this.listeners.has(type)) this.listeners.set(type, new Set());
            this.listeners.get(type).add(fn);
          },
          removeEventListener(type, fn) {
            this.listeners.get(type)?.delete(fn);
          },
        });
      }
      return queries.get(spec);
    },
    queries,
  };
}

// 按事件名取监听器快照。
function listenersOf(query, type) {
  return [...(query.listeners.get(type) ?? [])];
}

// 跨全部事件名清点监听器总数（等于源码在桩上注册掉的每一次 add）。
function totalListeners(query) {
  let n = 0;
  for (const set of query.listeners.values()) n += set.size;
  return n;
}

// 按 change 事件名派发事件：源码挂错事件名时这里派发不到任何监听器，用例即红。
function fireChange(query) {
  for (const fn of listenersOf(query, "change")) fn();
}

describe("终端像素密度→fit 接线（收窄 bug 修复）", () => {
  describe("静态源码接线", () => {
    it("模块级监视句柄在册（与宿主 RO 相邻）", () => {
      const roAt = panelJs.indexOf("let terminalHostResizeObserver = null;");
      assert.ok(roAt >= 0, "宿主 RO 句柄在册");
      // 相邻判定按「去行注释、去空白后的代码串」逐段比对：两个监视句柄与宿主 RO
      // 句柄之间只容注释行，混入任何其它声明即红；纯注释增删不再影响判定。
      let expected = "let terminalHostResizeObserver = null;".replace(/\s+/g, "");
      for (const symbol of ["let terminalDprMediaQuery = null;", "let terminalDprMediaHandler = null;"]) {
        const at = panelJs.indexOf(symbol);
        assert.ok(at > roAt, `${symbol} 在宿主 RO 句柄之后`);
        const code = panelJs.slice(roAt, at).replace(/\/\/[^\n]*/g, "").replace(/\s+/g, "");
        assert.equal(code, expected, `${symbol} 与宿主 RO 句柄相邻（中间只容注释）`);
        expected += symbol.replace(/\s+/g, "");
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
      // 结构判定：切出整个 closeTerminalStream，摘除调用必须落在其中、且在 RO
      // disconnect 之后——不再用字符窗口近似「同函数同拍」，注释增删不影响判定。
      const closeSrc = extractFn("closeTerminalStream");
      const disconnectAt = closeSrc.indexOf("terminalHostResizeObserver?.disconnect();");
      assert.ok(disconnectAt >= 0, "RO disconnect 在册");
      const disarmAt = closeSrc.indexOf("disarmTerminalDprWatch();");
      assert.ok(disarmAt > disconnectAt, "摘除与 RO 摘除同函数同拍（disconnect 之后）");
    });

    it("事件名钉死：媒体查询监听的注册与摘除都挂在 change 上", () => {
      const armSrc = extractFn("armTerminalDprWatch");
      const disarmSrc = extractFn("disarmTerminalDprWatch");
      assert.ok(armSrc.includes('query.addEventListener("change", handler)'),
        "挂载监听注册到 change（挂到别的媒体查询事件名则永远收不到发声）");
      assert.ok(disarmSrc.includes('query.removeEventListener("change", handler)'),
        "摘除按 change 配对移除（事件名不一致则旧监听残留）");
    });

    it("路由与换挂：handler 走防抖 fit，事件内先换挂新密度查询", () => {
      const armSrc = extractFn("armTerminalDprWatch");
      assert.ok(armSrc.includes("debounceTerminalFit();"), "事件路由到防抖 fit（与宿主 RO 同一条入口）");
      assert.ok(armSrc.includes("matchMedia(`screen and (resolution: ${window.devicePixelRatio}dppx)`"),
        "查询挂当前 window.devicePixelRatio（媒体查询自身闭括号在模板内）");
      const handlerArrowAt = armSrc.indexOf("=> {");
      assert.ok(armSrc.indexOf("armTerminalDprWatch();", handlerArrowAt) > handlerArrowAt,
        "事件内换挂（新密度的查询，旧查询只对旧值发声）");
      const disarmCallAt = armSrc.indexOf("disarmTerminalDprWatch();");
      // 先判定在册再比对先后：indexOf 未命中返回 -1，-1 恒小于正位置会让断言假通过。
      assert.ok(disarmCallAt >= 0 && disarmCallAt < handlerArrowAt,
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
      const q = window.queries.get("screen and (resolution: 1.25dppx)");
      assert.ok(q, "查询挂当前密度");
      assert.equal(listenersOf(q, "change").length, 1, "恰好一条监听器，且注册到 change 事件上");
      assert.equal(totalListeners(q), 1, "无其它事件名上的多余监听器");
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
      fireChange(oldQ);
      const newQ = window.queries.get("screen and (resolution: 1.5dppx)");
      assert.ok(newQ, "新密度查询已挂");
      assert.equal(listenersOf(newQ, "change").length, 1, "新查询把监听器注册到 change 上");
      assert.equal(totalListeners(newQ), 1, "新查询无其它事件名的监听器");
      assert.equal(totalListeners(oldQ), 0, "旧查询监听器已摘净（不换挂下一次变化就聋）");
      assert.equal(fitCalls.length, 1, "防抖 fit 恰好被叫一次");
      assert.equal(watch.liveQuery().spec, "screen and (resolution: 1.5dppx)", "live 句柄已切到新查询");
    });

    it("连发两档密度：逐档换挂，fit 每次都被叫到", () => {
      const window = stubWindow();
      const fitCalls = [];
      const watch = makeWatch(window, () => fitCalls.push(1));
      watch.arm();
      window.devicePixelRatio = 1.5;
      fireChange(window.queries.get("screen and (resolution: 1.25dppx)"));
      window.devicePixelRatio = 2;
      fireChange(window.queries.get("screen and (resolution: 1.5dppx)"));
      const twoQ = window.queries.get("screen and (resolution: 2dppx)");
      assert.ok(twoQ, "逐档换挂到 2dppx");
      assert.equal(listenersOf(twoQ, "change").length, 1, "新档监听器注册到 change 上");
      assert.equal(fitCalls.length, 2, "两档各叫一次 fit");
    });

    it("重入与摘除：重复挂载不叠监听器，摘除后句柄清空、监听器全摘", () => {
      const window = stubWindow();
      const watch = makeWatch(window, () => {});
      watch.arm();
      watch.arm();
      const q = window.queries.get("screen and (resolution: 1.25dppx)");
      assert.equal(totalListeners(q), 1, "重复挂载不叠监听器（挂前先摘）");
      watch.disarm();
      assert.equal(watch.liveQuery(), null, "查询句柄清空");
      assert.equal(watch.liveHandler(), null, "监听器句柄清空");
      assert.equal(totalListeners(q), 0, "桩上监听器已摘净");
      watch.disarm(); // 空态再摘不抛
    });

    it("无 matchMedia 的环境：挂载空操作不抛（桩环境/旧浏览器闸）", () => {
      const watch = makeWatch({ devicePixelRatio: 1 }, () => {});
      watch.arm();
      assert.equal(watch.liveQuery(), null, "未挂任何查询");
    });
  });
});
