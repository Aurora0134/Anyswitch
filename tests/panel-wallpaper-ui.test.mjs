// 「自定义」壁纸主题 UI 接线回归测试。
// 静态面：panel.html 的清单/垫底 DOM/配置窗口骨架与文案锚点、panel.css 的垫底/
// 终端半透明/窗口预览规则、panel.js 的接线点（setPanelStyle→syncStyle、亮暗→
// syncMode、「自定义...」开窗分支、xterm 透明开关门控、rgba 上报剥 alpha）。
// 行为面：抽取 createWallpaperThemeController 进 vm 沙箱，桩化 DOM 根/存档/解码/
// 存储，驱动「窗口暂存 → 确认落盘 / 取消丢弃」全模型：上传校验、暂存隔离、
// 亮暗跟随、三滑杆、移除的确认闸门。
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WallpaperTheme from "../panel-ui/wallpaper-theme.js";
import { extractPanelFn } from "../test-helpers/extract-panel-fn.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const panelHtml = readFileSync(join(rootDir, "panel-ui", "panel.html"), "utf8");
const panelCss = readFileSync(join(rootDir, "panel-ui", "panel.css"), "utf8");
const panelJs = readFileSync(join(rootDir, "panel-ui", "panel.js"), "utf8");

// ═══════════════════════════════════════════════
// 静态接线
// ═══════════════════════════════════════════════

describe("壁纸主题静态接线", () => {
  it("head 恢复脚本：wallpaper 在册且绘制前从 token 缓存注入，不闪默认皮肤", () => {
    assert.ok(panelHtml.includes('var PANEL_STYLES = ["saas", "aurora", "sepia", "wallpaper"];'),
      "PANEL_STYLES 含 wallpaper 第四项");
    const head = panelHtml.slice(panelHtml.indexOf("var PANEL_STYLES"), panelHtml.indexOf("</script>"));
    assert.ok(head.includes('if (panelStyle === "wallpaper")'), "仅壁纸主题才走缓存注入");
    assert.ok(head.includes('localStorage.getItem("panel-wallpaper-tokens")'), "读 token 缓存");
    assert.ok(head.includes('window.matchMedia("(prefers-color-scheme: dark)").matches'),
      "未显式亮暗时按系统偏好选缓存套");
    assert.ok(head.includes("document.documentElement.style.setProperty("), "绘制前注入 <html> 内联样式");
  });

  it("取色引擎以经典脚本引入且先于 panel.js", () => {
    const engineTag = '<script src="/panel/assets/wallpaper-theme.js" defer></script>';
    const panelTag = '<script src="/panel/assets/panel.js" defer></script>';
    assert.ok(panelHtml.includes(engineTag), "引擎 script 标签在册");
    assert.ok(panelHtml.indexOf(engineTag) < panelHtml.indexOf(panelTag), "引擎先于 panel.js 加载");
  });

  it("垫底 DOM：fixed 容器 + 图片层 + 压暗层，aria 隐藏", () => {
    const m = panelHtml.match(/<div class="wallpaper-backdrop" aria-hidden="true">[\s\S]*?<\/div>\n<\/div>/);
    assert.ok(m, "垫底容器在册");
    assert.ok(m[0].includes('id="wallpaperBackdropImage"'), "图片层在册");
    assert.ok(m[0].includes('id="wallpaperBackdropDim"'), "压暗层在册");
  });

  it("垫底 CSS：负 z 层不压内容、不响应交互、图片层外扩防模糊露边、仅选中且有图时显示", () => {
    const layer = panelCss.match(/\.wallpaper-backdrop \{([^}]*)\}/);
    assert.ok(layer, "垫底层规则在册");
    for (const pin of ["position: fixed", "inset: 0", "z-index: -1", "pointer-events: none", "overflow: hidden"]) {
      assert.ok(layer[1].includes(pin), `垫底层含 ${pin}`);
    }
    assert.ok(panelCss.includes(":root[data-style=\"wallpaper\"][data-wallpaper=\"active\"] .wallpaper-backdrop { display: block; }"),
      "显示门控：壁纸主题 + 有图双条件");
    assert.ok(panelCss.includes(".wallpaper-backdrop-image { position: absolute; inset: -40px;"),
      "图片层外扩 40px");
    assert.ok(panelCss.includes(":root[data-style=\"wallpaper\"] body { background: transparent; }"),
      "壁纸主题下 body 底透明（否则画布色盖住垫底）");
  });

  it("终端屏不透明：壁纸主题 --terminal-bg 与静态皮肤同源实色（亮/暗/跟随系统三态）", () => {
    assert.ok(panelCss.includes(':root[data-style="wallpaper"] {\n    --terminal-bg: #f8fafc;'),
      "亮态终端底色为不透明实色（与基座段同值）");
    assert.ok(panelCss.includes(':root[data-style="wallpaper"][data-theme="dark"] {\n    --terminal-bg: #0b1220;'),
      "暗态终端底色为不透明实色");
    assert.ok(/@media \(prefers-color-scheme: dark\) \{\n    :root\[data-style="wallpaper"\]:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\) \{\n      --terminal-bg: #0b1220;/.test(panelCss),
      "跟随系统暗态终端底色为不透明实色");
    // 白芯蓝环/透明路径缺陷回归闸：壁纸三态不得再写回带 alpha 的底色
    assert.ok(!panelCss.includes("--terminal-bg: rgba("), "全 CSS 无带 alpha 的终端底色");
  });

  it("配置窗口骨架：modal 体系 + 标题/说明/按钮/预览/高级选项逐字在册", () => {
    const modal = panelHtml.slice(panelHtml.indexOf("<!-- 「自定义主题」窗口"), panelHtml.indexOf("<!-- 终端设置小窗"));
    assert.ok(modal.includes('class="modal-overlay" id="wallpaperModal"'), "复用 modal-overlay 体系");
    assert.ok(modal.includes(">自定义主题</h3>"), "窗口标题");
    assert.ok(modal.includes("以上传的背景图取色生成主题，确认前不影响当前面板。支持 PNG、JPEG、WebP、GIF，不超过 20MB。"),
      "说明行逐字");
    assert.ok(modal.includes(">上传背景图</button>"), "无图态按钮「上传背景图」");
    assert.ok(modal.includes(">移除背景图</button>"), "「移除背景图」在册");
    assert.ok(modal.includes(">取消</button>") && modal.includes(">确认</button>"), "卡脚取消/确认");
    assert.ok(modal.includes("上传背景图后在此预览效果"), "预览空态占位文案");
    assert.ok(modal.includes("<summary>高级选项</summary>"), "高级选项展开钮");
    for (const id of ["wallpaperUploadBtn", "wallpaperRemoveBtn", "wallpaperFileInput",
      "wallpaperPreview", "wallpaperPreviewImage", "wallpaperPreviewDim", "wallpaperPreviewEmpty",
      "wallpaperPreviewViewport", "wallpaperPreviewSizer", "wallpaperPreviewScale",
      "wallpaperModalCloseBtn", "wallpaperCancelBtn", "wallpaperConfirmBtn",
      "wallpaperFxBlur", "wallpaperFxDim", "wallpaperFxSurface"]) {
      assert.ok(panelHtml.includes(`id="${id}"`), `${id} 在册`);
    }
    assert.ok(panelHtml.includes('id="wallpaperFxBlur" min="0" max="30" step="1" value="5"'), "模糊 0–30 默认 5");
    assert.ok(panelHtml.includes('id="wallpaperFxDim" min="0" max="70" step="1" value="15"'), "压暗 0–70 默认 15");
    assert.ok(panelHtml.includes('id="wallpaperFxSurface" min="40" max="100" step="1" value="75"'), "阅读区不透明度 40–100 默认 75");
    assert.ok(panelHtml.includes('accept="image/png,image/jpeg,image/webp,image/gif"'), "文件选择器限四种格式");
    assert.ok(!panelHtml.includes("wallpaperControls") && !panelHtml.includes("wallpaperChangeBtn"),
      "主题页旧从属区与「更换背景图」已拆除");
  });

  it("窗口 CSS：预览空态/有图态由 has-image 切换，垫底外扩防模糊露边，预览 viewport 透明", () => {
    assert.ok(/\.wallpaper-preview \{[^}]*position: relative;[^}]*pointer-events: none;/.test(panelCss),
      "预览容器相对定位且不响应交互");
    assert.ok(panelCss.includes(".wallpaper-preview.has-image .wallpaper-preview-backdrop { display: block; }"),
      "垫底仅有图态显示");
    assert.ok(panelCss.includes(".wallpaper-preview.has-image .wallpaper-preview-empty { display: none; }"),
      "空态占位有图时隐藏");
    assert.ok(/\.wallpaper-preview-viewport \{ display: none;[^}]*background: transparent;/.test(panelCss),
      "预览 viewport 默认收起且底透明（透出垫底图）");
    assert.ok(panelCss.includes(".wallpaper-preview.has-image .wallpaper-preview-viewport { display: block; }"),
      "预览 viewport 有图态展开");
    assert.ok(panelCss.includes(".wallpaper-preview-image { position: absolute; inset: -40px;"),
      "窗内图片层外扩 40px");
    assert.ok(/\.wallpaper-modal-card \{[^}]*max-width: min\(960px, 94vw\);/.test(panelCss),
      "窗口中等偏大尺寸档");
    assert.ok(!panelCss.includes("#wallpaperControls"), "旧从属区 CSS 门控已清");
  });

  it("panel.js 接线：清单四项、「自定义...」开窗分支、主题/亮暗切换进控制器、xterm 透明开关按底色门控", () => {
    assert.ok(panelJs.includes('const STYLES = ["saas", "aurora", "sepia", "wallpaper"];'), "STYLES 四项");
    assert.ok(/b\.dataset\.style === WALLPAPER_STYLE[\s\S]{0,200}?openModal\(\)/.test(panelJs),
      "「自定义...」点开配置窗口");
    assert.ok(panelJs.includes("wallpaperController.syncStyle(s === WALLPAPER_STYLE)"),
      "setPanelStyle 通知壁纸控制器进/出「自定义」");
    assert.ok(panelJs.split("wallpaperController.syncMode()").length - 1 >= 2,
      "setTheme 与系统亮暗监听都跟随 syncMode");
    assert.ok(panelJs.includes('onApplyStyle: () => setPanelStyle(WALLPAPER_STYLE)'),
      "确认走标准换肤路径");
    assert.ok(panelJs.includes("onFallbackStyle: () => setPanelStyle(\"saas\")"),
      "确认删除已存图时切回 Default");
    assert.ok(panelJs.includes("allowTransparency: terminalBackgroundHasAlpha(),"),
      "构造首帧按底色是否带 alpha 决定开关");
    assert.ok(panelJs.includes("terminalXterm.options.allowTransparency = terminalBackgroundHasAlpha();"),
      "换肤/亮暗/系统偏好变化时同步开关");
  });
});

// ═══════════════════════════════════════════════
// 终端透明栅格化门控（vm 沙箱）
// ═══════════════════════════════════════════════

describe("终端透明栅格化守门闸：底色带 alpha 才开（2026-11-13 起全皮肤不透明，恒关）", () => {
  function sandbox(initialBg) {
    const state = { bg: initialBg };
    const log = [];
    const options = new Proxy({}, {
      set(target, key, value) { log.push([key, value]); target[key] = value; return true; },
    });
    const context = {
      document: { documentElement: {} },
      getComputedStyle: () => ({ getPropertyValue: (n) => (n === "--terminal-bg" ? state.bg : "") }),
      terminalXterm: { options },
      terminalXtermTheme: () => ({ background: state.bg }),
      reportTerminalThemeToBackend: () => {},
    };
    const api = vm.runInNewContext(
      `(() => { ${extractPanelFn("terminalBackgroundHasAlpha")}
        ${extractPanelFn("applyTerminalXtermTheme")}
        return { apply: applyTerminalXtermTheme, hasAlpha: terminalBackgroundHasAlpha }; })()`,
      context,
    );
    return { api, state, log };
  }

  // 六档终端底色从 panel.css 的皮肤 token 规则切出（亮档 :root[data-style=…]、暗档
  // 同选择器加 [data-theme="dark"]），手抄字面量退役——皮肤改值或写回带 alpha 的底色，
  // 这里取到的是新值，六档观测才落在现行 token 上。saas 暗档须取皮肤段而非基座
  // :root[data-theme="dark"] 段：基座特异性低一档，saas 态被皮肤段压住，喂基座值
  // 观测的是不生效的 token。
  function skinTerminalBg(selector) {
    const css = panelCss.replace(/\/\*[\s\S]*?\*\//g, "");
    let idx = -1;
    while ((idx = css.indexOf(selector, idx + 1)) >= 0) {
      const open = css.indexOf("{", idx);
      const close = css.indexOf("}", open);
      const m = open > idx && close > open && css.slice(open + 1, close).match(/--terminal-bg:\s*([^;]+);/);
      if (m) return m[1].trim();
    }
    assert.ok(false, `panel.css 无声明 --terminal-bg 的规则：${selector}`);
  }

  it("三静态皮肤亮暗六档都是六位 hex，透明开关恒关", () => {
    for (const [label, bg] of [
      ["saas 亮档", skinTerminalBg(':root[data-style="saas"] {')],
      ["saas 暗档", skinTerminalBg(':root[data-style="saas"][data-theme="dark"] {')],
      ["aurora 亮档", skinTerminalBg(':root[data-style="aurora"] {')],
      ["aurora 暗档", skinTerminalBg(':root[data-style="aurora"][data-theme="dark"] {')],
      ["sepia 亮档", skinTerminalBg(':root[data-style="sepia"] {')],
      ["sepia 暗档", skinTerminalBg(':root[data-style="sepia"][data-theme="dark"] {')],
    ]) {
      assert.match(bg, /^#[0-9a-f]{6}$/, `${label}终端底色应为六位 hex，实得 ${bg}`);
      const { api, log } = sandbox(bg);
      assert.equal(api.hasAlpha(), false, `${bg} 不带 alpha`);
      api.apply();
      assert.deepEqual(log[0], ["allowTransparency", false], `${bg} 开关落定`);
      assert.equal(log[1][0], "theme", "theme 赋值在开关之后");
    }
  });

  it("守门闸：带 alpha 的 rgba 取值如实打开（当前全皮肤不透明，防未来写回 alpha 的回归）", () => {
    for (const bg of ["rgba(248, 250, 252, 0.78)", "rgba(11, 18, 32, 0.72)"]) {
      const { api, log } = sandbox(bg);
      assert.equal(api.hasAlpha(), true, `${bg} 带 alpha`);
      api.apply();
      assert.deepEqual(log[0], ["allowTransparency", true]);
    }
  });

  it("alpha=1 的 rgba 与八位 hex 的 ff 通道按不透明处理", () => {
    assert.equal(sandbox("rgba(248, 250, 252, 1)").api.hasAlpha(), false);
    assert.equal(sandbox("#f8fafcff").api.hasAlpha(), false);
    assert.equal(sandbox("#f8fafcc8").api.hasAlpha(), true);
  });

  it("同一实例换肤：开关随底色在开/关之间如实翻转，且每次都先于 theme 落定", () => {
    const { api, state, log } = sandbox("#f8fafc");
    api.apply();
    state.bg = "rgba(248, 250, 252, 0.78)"; // 模拟未来某皮肤写回带 alpha 底色的假想态
    api.apply();
    state.bg = "#faf6ec";
    api.apply();
    assert.deepEqual(log.filter(([k]) => k === "allowTransparency").map(([, v]) => v),
      [false, true, false], "不透明 → 假想带 alpha → 不透明，依次关/开/关");
    assert.deepEqual(log.map(([k]) => k),
      ["allowTransparency", "theme", "allowTransparency", "theme", "allowTransparency", "theme"],
      "每次都先设开关再设 theme（theme 赋值触发图集重建）");
  });
});

// ═══════════════════════════════════════════════
// 控制器行为（vm 沙箱）
// ═══════════════════════════════════════════════

// 控制器闭包引用的模块级常量一并抽出
const WALLPAPER_CONSTS = [
  "WALLPAPER_FX_KEY", "WALLPAPER_TOKENS_KEY", "WALLPAPER_MAX_BYTES",
  "WALLPAPER_MIME_TYPES", "WALLPAPER_FX_DEFAULTS", "WALLPAPER_FX_LIMITS", "WALLPAPER_SURFACE_TIERS",
  "WALLPAPER_FX_INPUTS",
].map((name) => {
  const m = panelJs.match(new RegExp(`const ${name} = [^;]+;`));
  assert.ok(m, `panel.js 含常量 ${name}`);
  return m[0];
}).join("\n");

function makeRoot() {
  const attrs = new Map();
  const props = new Map();
  return {
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
    style: {
      setProperty: (k, v) => props.set(k, String(v)),
      removeProperty: (k) => props.delete(k),
    },
    _attrs: attrs,
    _props: props,
  };
}

function makeEl(id) {
  const classes = new Set();
  const props = new Map();
  return {
    id,
    hidden: false,
    disabled: false,
    textContent: "",
    value: "",
    style: {
      setProperty: (k, v) => props.set(k, String(v)),
      removeProperty: (k) => props.delete(k),
    },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => {
        const next = on === undefined ? !classes.has(c) : !!on;
        if (next) classes.add(c); else classes.delete(c);
      },
      contains: (c) => classes.has(c),
    },
    _classes: classes,
    _props: props,
  };
}

function makeDoc() {
  const els = new Map();
  for (const id of ["wallpaperBackdropImage", "wallpaperBackdropDim",
    "wallpaperModal", "wallpaperPreview", "wallpaperPreviewImage", "wallpaperPreviewDim",
    "wallpaperAdvanced",
    "wallpaperUploadBtn", "wallpaperRemoveBtn", "wallpaperConfirmBtn",
    "wallpaperFxBlur", "wallpaperFxBlurVal", "wallpaperFxDim", "wallpaperFxDimVal",
    "wallpaperFxSurface", "wallpaperFxSurfaceVal"]) {
    els.set(id, makeEl(id));
  }
  // HTML 的静态初值（hidden）不在这里预置：桩从「未隐藏」起，收放全由 renderPreview
  // 驱动，空态露没露才是被钉的那件事；静态初值另由 panel.test.mjs 断言。
  return { getElementById: (id) => els.get(id) ?? null, els };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => map.set(String(k), String(v)),
    removeItem: (k) => map.delete(String(k)),
    _map: map,
  };
}

function makeStore() {
  const state = { blob: null, saves: 0, clears: 0 };
  return {
    state,
    load: async () => state.blob,
    save: async (blob) => { state.blob = blob; state.saves++; },
    clear: async () => { state.blob = null; state.clears++; },
  };
}

function harness(options = {}) {
  const doc = makeDoc();
  const rootEl = makeRoot();
  const storage = makeStorage();
  const store = options.store === undefined ? makeStore() : options.store;
  if (options.fxSaved !== undefined) storage.setItem("panel-wallpaper-fx", options.fxSaved);
  const toasts = [];
  const calls = { afterChange: 0, applyStyle: 0, fallback: 0, captures: 0 };
  let dark = false;
  let styleActive = options.styleActive ?? false;
  // 解码桩：固定返回一块 32×32 纯蓝像素，驱动真引擎取色
  const decode = async () => {
    const data = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i++) data.set([40, 90, 200, 255], i * 4);
    return { data, width: 32, height: 32 };
  };
  const factory = vm.runInNewContext(
    `(() => { ${WALLPAPER_CONSTS}\n${extractPanelFn("createWallpaperThemeController")}\nreturn createWallpaperThemeController; })()`,
    { URL: { createObjectURL: () => "blob:mock", revokeObjectURL: () => {} } },
  );
  const controller = factory({
    doc,
    root: rootEl,
    storage,
    engine: options.engine === undefined ? WallpaperTheme : options.engine,
    decode,
    store,
    preferDark: () => dark,
    notify: (message, isErr) => toasts.push({ message, isErr: !!isErr }),
    onAfterChange: () => { calls.afterChange++; },
    onApplyStyle: () => { calls.applyStyle++; },
    onFallbackStyle: () => { calls.fallback++; },
    isStyleActive: () => styleActive,
    captureMirror: () => { calls.captures++; return true; },
  });
  return {
    controller, doc, rootEl, storage, store, toasts, calls,
    setDark: (v) => { dark = v; },
    setStyleActive: (v) => { styleActive = v; },
  };
}

const PNG_1KB = { type: "image/png", size: 1024 };

describe("壁纸控制器：上传校验（窗口内）", () => {
  it("窗口未开时上传直接作废，不提示不写库", async () => {
    const h = harness();
    await h.controller.pickFile(PNG_1KB);
    assert.equal(h.toasts.length, 0);
    assert.equal(h.store.state.blob, null);
  });

  it("格式白名单外拒绝并提示，不入暂存", async () => {
    const h = harness();
    await h.controller.openModal();
    await h.controller.pickFile({ type: "text/plain", size: 100 });
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0].isErr, true);
    for (const name of ["PNG", "JPEG", "WebP", "GIF"]) {
      assert.ok(h.toasts[0].message.includes(name), `拒绝文案点名 ${name}`);
    }
    assert.equal(h.doc.els.get("wallpaperPreview")._classes.has("has-image"), false, "预览停在空态");
    assert.equal(h.doc.els.get("wallpaperConfirmBtn").disabled, true, "无暂存图确认禁用");
  });

  it("超过 20MB 拒绝并提示，恰好 20MB 放行", async () => {
    const h = harness();
    await h.controller.openModal();
    await h.controller.pickFile({ type: "image/png", size: 20 * 1024 * 1024 + 1 });
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0].isErr, true);
    assert.ok(h.toasts[0].message.includes("20MB"), "超限文案点名上限");
    await h.controller.pickFile({ type: "image/png", size: 20 * 1024 * 1024 });
    assert.equal(h.doc.els.get("wallpaperPreview")._classes.has("has-image"), true, "边界值放行进暂存");
  });
});

describe("壁纸控制器：暂存与确认闸门", () => {
  it("开窗上传只写暂存：预览有图、token 注预览容器，全局与存储一概不动", async () => {
    const h = harness();
    await h.controller.openModal();
    await h.controller.pickFile(PNG_1KB);
    const preview = h.doc.els.get("wallpaperPreview");
    assert.equal(preview._classes.has("has-image"), true, "预览进有图态");
    assert.equal(h.doc.els.get("wallpaperPreviewImage").style.backgroundImage, 'url("blob:mock")');
    assert.equal(h.doc.els.get("wallpaperPreviewDim").style.background, "rgba(0, 0, 0, 0.15)", "默认压暗 15%");
    assert.ok(preview._props.get("--accent"), "引擎 token 注入预览容器");
    assert.equal(h.calls.captures, 1, "首次有图拍一次镜像");
    assert.equal(h.doc.els.get("wallpaperUploadBtn").textContent, "重新上传", "有图态上传钮改名");
    assert.equal(h.doc.els.get("wallpaperRemoveBtn").hidden, false, "移除钮出现");
    assert.equal(h.doc.els.get("wallpaperConfirmBtn").disabled, false, "确认可用");
    assert.equal(h.store.state.blob, null, "确认前不写 IndexedDB");
    assert.equal(h.storage.getItem("panel-wallpaper-fx"), null, "确认前不写滑杆存档");
    assert.equal(h.storage.getItem("panel-wallpaper-tokens"), null, "确认前不写首帧缓存");
    assert.equal(h.rootEl._props.size, 0, "确认前全局零注入");
    assert.equal(h.rootEl._attrs.has("data-wallpaper"), false, "确认前全局垫底不亮");
  });

  it("取消丢弃暂存：窗内注入与垫底清空，存储与全局保持原样", async () => {
    const h = harness();
    await h.controller.openModal();
    await h.controller.pickFile(PNG_1KB);
    h.controller.closeModal();
    const preview = h.doc.els.get("wallpaperPreview");
    assert.equal(preview._classes.has("has-image"), false, "预览回空态");
    assert.equal(preview._props.size, 0, "预览容器注入清空");
    assert.equal(h.doc.els.get("wallpaperModal")._classes.has("show"), false, "窗口关闭");
    assert.equal(h.store.state.blob, null);
    assert.equal(h.rootEl._props.size, 0);
    assert.equal(h.toasts.length, 0, "取消无回执");
  });

  it("确认落盘：入库、滑杆值与首帧缓存写本机、全局垫底与 token 生效、走换肤回调", async () => {
    const h = harness();
    await h.controller.openModal();
    await h.controller.pickFile(PNG_1KB);
    h.controller.setStagedFx("blur", 12);
    h.controller.setStagedFx("surface", 40);
    await h.controller.confirmModal();
    assert.equal(h.store.state.saves, 1, "blob 入库");
    assert.deepEqual(JSON.parse(h.storage.getItem("panel-wallpaper-fx")), { blur: 12, dim: 15, surface: 40 },
      "滑杆值记本机");
    const cache = JSON.parse(h.storage.getItem("panel-wallpaper-tokens"));
    assert.ok(cache?.light?.["--accent"] && cache?.dark?.["--accent"], "亮暗双套写入首帧缓存");
    assert.match(cache.light["--terminal-bg"], /^#[0-9a-f]{6}$/, "亮套 --terminal-bg 为不透明六位 hex");
    assert.match(cache.dark["--terminal-bg"], /^#[0-9a-f]{6}$/, "暗套 --terminal-bg 为不透明六位 hex");
    assert.ok(/0\.4\)$/.test(cache.light["--surface"]), "表面 alpha 按暂存值 0.4");
    assert.equal(h.rootEl._attrs.get("data-wallpaper"), "active", "全局垫底激活");
    assert.equal(h.rootEl._props.get("--terminal-bg"), cache.light["--terminal-bg"], "全局 --terminal-bg 由引擎随壁纸注入");
    assert.ok(/0\.4\)$/.test(h.rootEl._props.get("--surface")), "全局 token 按暂存值注入");
    assert.equal(h.doc.els.get("wallpaperBackdropImage").style.backgroundImage, 'url("blob:mock")');
    assert.equal(h.doc.els.get("wallpaperBackdropImage").style.filter, "blur(12px)", "全局模糊生效");
    assert.equal(h.calls.applyStyle, 1, "走标准换肤路径");
    assert.equal(h.calls.afterChange, 1, "终端屏配色重刷");
    assert.equal(h.doc.els.get("wallpaperModal")._classes.has("show"), false, "确认后关窗");
    assert.equal(h.toasts.at(-1).message, "自定义主题已应用");
    assert.equal(h.toasts.at(-1).isErr, false);
  });

  it("已生效用户开窗：以已存图与已存滑杆值为暂存初值，取消不碰现状", async () => {
    const store = makeStore();
    store.state.blob = PNG_1KB;
    const h = harness({ store, fxSaved: JSON.stringify({ blur: 7, dim: 20, surface: 90 }) });
    await h.controller.syncStyle(true); // 启动恢复：已生效侧就位
    assert.ok(h.rootEl._props.get("--accent"), "已生效 token 在全局");
    const globalAccent = h.rootEl._props.get("--accent");
    await h.controller.openModal();
    const preview = h.doc.els.get("wallpaperPreview");
    assert.equal(preview._classes.has("has-image"), true, "开窗即见已存图预览");
    assert.equal(preview._props.get("--accent"), globalAccent, "暂存初值复用已生效 token");
    assert.equal(h.doc.els.get("wallpaperFxBlur").value, "7", "滑杆回显已存值");
    assert.equal(h.doc.els.get("wallpaperFxBlurVal").textContent, "7px");
    h.controller.setStagedFx("blur", 25);
    assert.equal(h.doc.els.get("wallpaperPreviewImage").style.filter, "blur(25px)", "窗内调参生效");
    assert.equal(h.doc.els.get("wallpaperBackdropImage").style.filter, "blur(7px)", "全局垫底层不动");
    h.controller.closeModal();
    assert.equal(h.rootEl._props.get("--accent"), globalAccent, "取消后全局 token 原样");
    assert.deepEqual(JSON.parse(h.storage.getItem("panel-wallpaper-fx")), { blur: 7, dim: 20, surface: 90 },
      "取消后滑杆存档原样");
    assert.equal(h.store.state.saves, 0, "取消不落库");
  });

  it("暂存调参后确认：全局按新值生效", async () => {
    const store = makeStore();
    store.state.blob = PNG_1KB;
    const h = harness({ store });
    await h.controller.syncStyle(true);
    await h.controller.openModal();
    h.controller.setStagedFx("dim", 60);
    await h.controller.confirmModal();
    assert.equal(h.doc.els.get("wallpaperBackdropDim").style.background, "rgba(0, 0, 0, 0.6)", "全局压暗按新值");
    assert.deepEqual(JSON.parse(h.storage.getItem("panel-wallpaper-fx")), { blur: 5, dim: 60, surface: 75 });
    assert.equal(h.store.state.saves, 0, "未换图不重复入库");
  });
});

// 表面 token 分档：滑杆值折成三档 alpha（内容面 1:1、玻璃面 0.8 倍、页面底 0.6+0.4×）。
// 六键同值是修复前的形态：字压在照片上时卡面/磨砂面/页面底一起变透，分档把三者的
// 透明度各自钉在语义位置上——这组断言对六键同值的旧实现为红。
describe("壁纸控制器：表面 token 按档折算（内容面 / 玻璃面 / 页面底）", () => {
  const alphaOf = (v) => {
    const m = /^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*([\d.]+)\s*\)$/.exec(v || "");
    assert.ok(m, `表面 token 应为 rgba：${v}`);
    return Number(m[1]);
  };
  async function committed(surface) {
    const h = harness();
    await h.controller.openModal();
    await h.controller.pickFile(PNG_1KB);
    if (surface !== undefined) h.controller.setStagedFx("surface", surface);
    await h.controller.confirmModal();
    return h;
  }

  it("默认 75 档：内容面 1:1、玻璃面 0.8 倍、页面底高档带——六键不再同值", async () => {
    const h = await committed();
    const p = h.rootEl._props;
    for (const key of ["--surface", "--surface-sunken", "--surface-hover"]) {
      assert.equal(alphaOf(p.get(key)), 0.75, `${key} 1:1 跟随滑杆值`);
    }
    assert.equal(alphaOf(p.get("--surface-glass")), 0.6, "玻璃面 0.8 倍跟随（默认档与引擎亮套 0.62 同档，磨砂不丢）");
    for (const key of ["--bg", "--bg-page"]) {
      assert.equal(alphaOf(p.get(key)), 0.9, `${key} 走 0.6+0.4×滑杆的高档带`);
    }
    assert.notEqual(alphaOf(p.get("--surface-glass")), alphaOf(p.get("--surface")), "玻璃面必须低于内容面");
    assert.notEqual(alphaOf(p.get("--bg")), alphaOf(p.get("--surface")), "页面底必须高于内容面");
    // 同一组系数作用亮暗两套：两套同档
    const cache = JSON.parse(h.storage.getItem("panel-wallpaper-tokens"));
    for (const key of ["--surface", "--surface-glass", "--bg"]) {
      assert.equal(alphaOf(cache.dark[key]), alphaOf(cache.light[key]), `${key} 亮暗同档`);
    }
  });

  it("两端档位：40 → 内容 0.4 / 玻璃 0.32 / 页面底 0.76；100 → 1 / 0.8 / 1", async () => {
    const low = await committed(40);
    assert.equal(alphaOf(low.rootEl._props.get("--surface")), 0.4, "最低档内容面 0.4（滑杆语义原样）");
    assert.equal(alphaOf(low.rootEl._props.get("--surface-glass")), 0.32, "玻璃面同比折半");
    assert.equal(alphaOf(low.rootEl._props.get("--bg")), 0.76, "页面底最低档仍留 0.76，不退成照片");
    const high = await committed(100);
    assert.equal(alphaOf(high.rootEl._props.get("--surface")), 1, "最高档内容面全实");
    assert.equal(alphaOf(high.rootEl._props.get("--surface-glass")), 0.8, "最高档玻璃面仍在内容面下");
    assert.equal(alphaOf(high.rootEl._props.get("--bg")), 1, "最高档页面底全实");
  });

  it("单调：滑杆越低每档都更透（「越低越透」不因分档改变）", async () => {
    const low = await committed(40);
    const mid = await committed(70);
    const high = await committed(100);
    const read = (h, key) => alphaOf(h.rootEl._props.get(key));
    for (const key of ["--surface", "--surface-sunken", "--surface-hover", "--surface-glass", "--bg", "--bg-page"]) {
      assert.ok(read(low, key) < read(mid, key) && read(mid, key) < read(high, key), `${key} 随滑杆单调变实`);
    }
  });
});

describe("壁纸控制器：移除的确认闸门", () => {
  it("移除只清暂存：预览回空态、移除钮消失，确认前已存图与全局原样", async () => {
    const store = makeStore();
    store.state.blob = PNG_1KB;
    const h = harness({ store, styleActive: true });
    await h.controller.syncStyle(true);
    await h.controller.openModal();
    h.controller.removeStaged();
    const preview = h.doc.els.get("wallpaperPreview");
    assert.equal(preview._classes.has("has-image"), false, "预览回空态");
    assert.equal(h.doc.els.get("wallpaperRemoveBtn").hidden, true, "空态下移除钮不存在");
    assert.equal(h.doc.els.get("wallpaperConfirmBtn").disabled, false, "有待确认删除时确认可用");
    assert.equal(store.state.blob?.size, 1024, "确认前已存图不动");
    assert.equal(h.rootEl._attrs.get("data-wallpaper"), "active", "确认前全局垫底原样");
    assert.equal(h.store.state.clears, 0, "确认前不清库");
  });

  it("确认删除：清库、熄垫底、清注入与缓存；全局生效中切回 Default", async () => {
    const store = makeStore();
    store.state.blob = PNG_1KB;
    const h = harness({ store, styleActive: true });
    await h.controller.syncStyle(true);
    await h.controller.openModal();
    h.controller.removeStaged();
    await h.controller.confirmModal();
    assert.equal(h.store.state.clears, 1, "存储清空");
    assert.equal(h.rootEl._attrs.has("data-wallpaper"), false, "垫底熄灭");
    assert.equal(h.rootEl._props.size, 0, "注入 token 全清");
    assert.equal(h.storage.getItem("panel-wallpaper-tokens"), null, "首帧缓存删除");
    assert.equal(h.calls.fallback, 1, "触发切回 Default");
    assert.equal(h.toasts.at(-1).message, "背景图已移除，主题已切回 Default");
    assert.equal(h.doc.els.get("wallpaperModal")._classes.has("show"), false, "确认后关窗");
  });

  it("确认删除时全局未生效自定义：只删图不切主题", async () => {
    const store = makeStore();
    store.state.blob = PNG_1KB;
    const h = harness({ store, styleActive: false });
    await h.controller.openModal();
    h.controller.removeStaged();
    await h.controller.confirmModal();
    assert.equal(h.store.state.clears, 1);
    assert.equal(h.calls.fallback, 0, "非生效态不切主题");
    assert.equal(h.toasts.at(-1).message, "背景图已移除");
  });

  it("移除后取消：已存图与全局保持原样", async () => {
    const store = makeStore();
    store.state.blob = PNG_1KB;
    const h = harness({ store, styleActive: true });
    await h.controller.syncStyle(true);
    await h.controller.openModal();
    h.controller.removeStaged();
    h.controller.closeModal();
    assert.equal(h.store.state.blob?.size, 1024, "已存图保留");
    assert.equal(h.store.state.clears, 0);
    assert.equal(h.rootEl._attrs.get("data-wallpaper"), "active", "全局垫底原样");
    assert.ok(h.rootEl._props.get("--accent"), "全局 token 原样");
    assert.equal(h.calls.fallback, 0);
  });

  it("从未有过已存图：移除后确认钮回禁用（无可提交内容）", async () => {
    const h = harness();
    await h.controller.openModal();
    await h.controller.pickFile(PNG_1KB);
    h.controller.removeStaged();
    assert.equal(h.doc.els.get("wallpaperConfirmBtn").disabled, true, "无图且无已存图时确认禁用");
  });
});

describe("壁纸控制器：「高级选项」只随暂存图态露出", () => {
  const advanced = (h) => h.doc.els.get("wallpaperAdvanced");

  it("开窗无图空态：「高级选项」随预览一起收起", async () => {
    const h = harness();
    await h.controller.openModal();
    assert.equal(advanced(h).hidden, true, "无暂存图时三根滑杆不露出");
    assert.equal(h.doc.els.get("wallpaperPreview")._classes.has("has-image"), false, "预览同为空态");
  });

  it("上传后：「高级选项」随有图态展开", async () => {
    const h = harness();
    await h.controller.openModal();
    await h.controller.pickFile(PNG_1KB);
    assert.equal(advanced(h).hidden, false, "有暂存图即展开可调");
  });

  it("已存图开窗后窗内移除：「高级选项」回到收起，确认前已生效侧不受影响", async () => {
    const store = makeStore();
    store.state.blob = PNG_1KB;
    const h = harness({ store, styleActive: true });
    await h.controller.syncStyle(true);
    await h.controller.openModal();
    assert.equal(advanced(h).hidden, false, "已存图开窗即有图态，高级选项可用");
    h.controller.removeStaged();
    assert.equal(advanced(h).hidden, true, "窗内移除后回到空态收起");
    assert.equal(store.state.clears, 0, "移除只清暂存，确认前不清库");
    assert.equal(h.rootEl._attrs.get("data-wallpaper"), "active", "确认前全局垫底原样");
  });
});

describe("壁纸控制器：主题进出与亮暗跟随", () => {
  it("切走「自定义」清掉全部注入属性，切回时按缓存恢复", async () => {
    const h = harness();
    await h.controller.openModal();
    await h.controller.pickFile(PNG_1KB);
    await h.controller.confirmModal();
    const accentLight = h.rootEl._props.get("--accent");
    await h.controller.syncStyle(false);
    assert.equal(h.rootEl._props.size, 0, "切走清空注入");
    assert.equal(h.storage.getItem("panel-wallpaper-tokens"), null, "缓存随切走删除");
    assert.equal(h.store.state.blob?.size, 1024, "图片本体保留在库");
    await h.controller.syncStyle(true);
    assert.equal(h.rootEl._props.get("--accent"), accentLight, "切回同会话按内存像素重注");
  });

  it("亮暗切换：全局与窗内预览各自换套", async () => {
    const h = harness();
    await h.controller.openModal();
    await h.controller.pickFile(PNG_1KB);
    await h.controller.confirmModal();
    const lightAccent = h.rootEl._props.get("--accent");
    h.rootEl.setAttribute("data-theme", "dark");
    h.controller.syncMode();
    const darkAccent = h.rootEl._props.get("--accent");
    assert.notEqual(darkAccent, lightAccent, "暗态注入暗套 token");
    h.rootEl.removeAttribute("data-theme");
    h.setDark(true);
    h.controller.syncMode();
    assert.equal(h.rootEl._props.get("--accent"), darkAccent, "跟随系统暗态同套");
    // 窗口开着时窗内暂存预览跟随换套
    await h.controller.openModal();
    const preview = h.doc.els.get("wallpaperPreview");
    assert.equal(preview._props.get("--accent"), darkAccent, "开窗时暂存预览按当前暗态");
    h.rootEl.setAttribute("data-theme", "light");
    h.controller.syncMode();
    assert.equal(preview._props.get("--accent"), lightAccent, "窗内预览跟随切回亮套");
  });

  it("启动恢复：有库存图时 syncStyle(true) 重入库图像并注入；无图停在基座态", async () => {
    const store = makeStore();
    store.state.blob = PNG_1KB;
    const h = harness({ store });
    await h.controller.syncStyle(true);
    assert.equal(h.rootEl._attrs.get("data-wallpaper"), "active", "垫底恢复");
    assert.ok(h.rootEl._props.get("--accent"), "token 重注");
    const h2 = harness();
    await h2.controller.syncStyle(true);
    assert.equal(h2.rootEl._props.size, 0, "无图不注入，停在基座色");
    assert.equal(h2.rootEl._attrs.has("data-wallpaper"), false);
  });

  it("首帧缓存接管：只按缓存键集注入，切走能按接管的键集清干净", async () => {
    const h = harness();
    h.storage.setItem("panel-wallpaper-tokens", JSON.stringify({
      light: { "--accent": "#111111" }, dark: { "--accent": "#222222" },
    }));
    await h.controller.syncStyle(true);
    assert.equal(h.rootEl._props.get("--accent"), "#111111", "按缓存亮套注入");
    await h.controller.syncStyle(false);
    assert.equal(h.rootEl._props.size, 0, "接管的键集切走全清");
  });

  it("引擎缺席时垫底与滑杆仍工作，token 步骤跳过不炸", async () => {
    const h = harness({ engine: null });
    await h.controller.openModal();
    await h.controller.pickFile(PNG_1KB);
    assert.equal(h.doc.els.get("wallpaperPreview")._classes.has("has-image"), true);
    assert.equal(h.doc.els.get("wallpaperPreview")._props.size, 0, "无引擎不注入");
    h.controller.setStagedFx("blur", 5);
    assert.equal(h.doc.els.get("wallpaperPreviewImage").style.filter, "blur(5px)");
  });

  it("滑杆存档越界按区间钳制，非法值回默认", () => {
    const h = harness({ fxSaved: JSON.stringify({ blur: 99, dim: -3, surface: "x" }) });
    assert.equal(h.controller.fx.blur, 30);
    assert.equal(h.controller.fx.dim, 0);
    assert.equal(h.controller.fx.surface, 75);
  });
});

describe("壁纸主题终端链路", () => {
  it("terminalCssHex 剥 rgba 的 alpha 报 RGB 部分，非法值仍兜底", () => {
    const cases = [
      ["rgba(11, 18, 32, 0.72)", "#0b1220"],
      ["rgba(248, 250, 252, 0.78)", "#f8fafc"],
      ["rgb(5, 14, 26)", "#050e1a"],
      ["oklch(0.7 0.1 200)", "#010203"],
    ];
    for (const [input, expected] of cases) {
      const fn = vm.runInNewContext(
        `(() => { ${extractPanelFn("terminalCssHex")}; return terminalCssHex; })()`,
        {
          getComputedStyle: () => ({ getPropertyValue: () => ` ${input} ` }),
          document: { documentElement: {} },
        },
      );
      assert.equal(fn("--t", "#010203"), expected, `${input} → ${expected}`);
    }
  });
});
