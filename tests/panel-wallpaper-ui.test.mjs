// 「自定义」壁纸主题 UI 接线回归测试。
// 静态面：panel.html 的清单/垫底 DOM/配置窗口骨架与文案锚点、panel.css 的垫底/
// 终端半透明/窗口预览规则、panel.js 的接线点（setPanelStyle→syncStyle、亮暗→
// syncMode、「自定义...」开窗分支、xterm allowTransparency、rgba 上报剥 alpha）。
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

  it("终端屏半透明：壁纸主题 --terminal-bg 带 alpha（亮/暗/跟随系统三态）", () => {
    assert.ok(panelCss.includes(':root[data-style="wallpaper"] {\n    --terminal-bg: rgba(248, 250, 252, 0.78);'),
      "亮态终端底色带 alpha");
    assert.ok(panelCss.includes(':root[data-style="wallpaper"][data-theme="dark"] {\n    --terminal-bg: rgba(11, 18, 32, 0.72);'),
      "暗态终端底色带 alpha");
    assert.ok(/@media \(prefers-color-scheme: dark\) \{\n    :root\[data-style="wallpaper"\]:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\) \{\n      --terminal-bg: rgba\(11, 18, 32, 0\.72\);/.test(panelCss),
      "跟随系统暗态终端底色带 alpha");
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
    assert.ok(panelHtml.includes('id="wallpaperFxBlur" min="0" max="30" step="1" value="0"'), "模糊 0–30 默认 0");
    assert.ok(panelHtml.includes('id="wallpaperFxDim" min="0" max="70" step="1" value="10"'), "压暗 0–70 默认 10");
    assert.ok(panelHtml.includes('id="wallpaperFxSurface" min="40" max="100" step="1" value="80"'), "阅读区不透明度 40–100 默认 80");
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

  it("panel.js 接线：清单四项、「自定义...」开窗分支、主题/亮暗切换进控制器、xterm 允许透明", () => {
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
    assert.ok(panelJs.includes("allowTransparency: true,"), "xterm 允许透明底色");
  });
});

// ═══════════════════════════════════════════════
// 控制器行为（vm 沙箱）
// ═══════════════════════════════════════════════

// 控制器闭包引用的模块级常量一并抽出
const WALLPAPER_CONSTS = [
  "WALLPAPER_FX_KEY", "WALLPAPER_TOKENS_KEY", "WALLPAPER_MAX_BYTES",
  "WALLPAPER_MIME_TYPES", "WALLPAPER_FX_DEFAULTS", "WALLPAPER_FX_LIMITS", "WALLPAPER_SURFACE_KEYS",
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
    "wallpaperUploadBtn", "wallpaperRemoveBtn", "wallpaperConfirmBtn",
    "wallpaperFxBlur", "wallpaperFxBlurVal", "wallpaperFxDim", "wallpaperFxDimVal",
    "wallpaperFxSurface", "wallpaperFxSurfaceVal"]) {
    els.set(id, makeEl(id));
  }
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
    assert.equal(h.doc.els.get("wallpaperPreviewDim").style.background, "rgba(0, 0, 0, 0.1)", "默认压暗 10%");
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
    assert.deepEqual(JSON.parse(h.storage.getItem("panel-wallpaper-fx")), { blur: 12, dim: 10, surface: 40 },
      "滑杆值记本机");
    const cache = JSON.parse(h.storage.getItem("panel-wallpaper-tokens"));
    assert.ok(cache?.light?.["--accent"] && cache?.dark?.["--accent"], "亮暗双套写入首帧缓存");
    assert.ok(/0\.4\)$/.test(cache.light["--surface"]), "表面 alpha 按暂存值 0.4");
    assert.equal(h.rootEl._attrs.get("data-wallpaper"), "active", "全局垫底激活");
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
    assert.deepEqual(JSON.parse(h.storage.getItem("panel-wallpaper-fx")), { blur: 0, dim: 60, surface: 80 });
    assert.equal(h.store.state.saves, 0, "未换图不重复入库");
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
    assert.equal(h.controller.fx.surface, 80);
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
