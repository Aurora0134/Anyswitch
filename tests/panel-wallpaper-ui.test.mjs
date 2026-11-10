// 「自定义」壁纸主题 UI 接线回归测试。
// 静态面：panel.html 的清单/垫底 DOM/从属控件与文案锚点、panel.css 的垫底与
// 终端半透明规则、panel.js 的接线点（setPanelStyle→syncStyle、亮暗→syncMode、
// xterm allowTransparency、rgba 上报剥 alpha）。
// 行为面：抽取 createWallpaperThemeController 进 vm 沙箱，桩化 DOM 根/存档/
// 解码/存储，驱动上传校验、token 注入与清退、亮暗跟随、三滑杆、移除回退。
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

  it("从属控件：仅选中「自定义」时展开，文案逐字在册", () => {
    assert.ok(panelCss.includes(':root:not([data-style="wallpaper"]) #wallpaperControls { display: none; }'),
      "未选中时整组收起（CSS 门控）");
    for (const id of ["wallpaperUploadBtn", "wallpaperChangeBtn", "wallpaperRemoveBtn", "wallpaperFileInput",
      "wallpaperFxBlur", "wallpaperFxDim", "wallpaperFxSurface"]) {
      assert.ok(panelHtml.includes(`id="${id}"`), `${id} 在册`);
    }
    assert.ok(panelHtml.includes(">上传背景图</button>"), "无图态按钮「上传背景图」");
    assert.ok(panelHtml.includes(">更换背景图</button>"), "有图态按钮「更换背景图」");
    assert.ok(panelHtml.includes(">移除背景图</button>"), "有图态按钮「移除背景图」");
    assert.ok(panelHtml.includes("背景图支持 PNG、JPEG、WebP、GIF，不超过 20MB"), "说明行逐字");
    assert.ok(panelHtml.includes(">背景效果</div>"), "滑杆组标题");
    assert.ok(panelHtml.includes('id="wallpaperFxBlur" min="0" max="30" step="1" value="0"'), "模糊 0–30 默认 0");
    assert.ok(panelHtml.includes('id="wallpaperFxDim" min="0" max="70" step="1" value="10"'), "压暗 0–70 默认 10");
    assert.ok(panelHtml.includes('id="wallpaperFxSurface" min="40" max="100" step="1" value="80"'), "阅读区不透明度 40–100 默认 80");
    assert.ok(panelHtml.includes('accept="image/png,image/jpeg,image/webp,image/gif"'), "文件选择器限四种格式");
  });

  it("panel.js 接线：清单四项、主题/亮暗切换进控制器、xterm 允许透明", () => {
    assert.ok(panelJs.includes('const STYLES = ["saas", "aurora", "sepia", "wallpaper"];'), "STYLES 四项");
    assert.ok(panelJs.includes("wallpaperController.syncStyle(s === WALLPAPER_STYLE)"),
      "setPanelStyle 通知壁纸控制器进/出「自定义」");
    assert.ok(panelJs.split("wallpaperController.syncMode()").length - 1 >= 2,
      "setTheme 与系统亮暗监听都跟随 syncMode");
    assert.ok(panelJs.includes("onFallbackStyle: () => setPanelStyle(\"saas\")"),
      "移除背景图自动切回 Default");
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

function makeDoc() {
  const els = new Map();
  for (const id of ["wallpaperBackdropImage", "wallpaperBackdropDim",
    "wallpaperUploadBtn", "wallpaperChangeBtn", "wallpaperRemoveBtn"]) {
    els.set(id, { id, hidden: false, style: {} });
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
  const calls = { afterChange: 0, fallback: 0 };
  let dark = false;
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
    onFallbackStyle: () => { calls.fallback++; },
  });
  return {
    controller, doc, rootEl, storage, store, toasts, calls,
    setDark: (v) => { dark = v; },
  };
}

const PNG_1KB = { type: "image/png", size: 1024 };

describe("壁纸控制器：上传校验", () => {
  it("格式白名单外拒绝并提示，不入库", async () => {
    const h = harness();
    await h.controller.pickFile({ type: "text/plain", size: 100 });
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0].isErr, true);
    for (const name of ["PNG", "JPEG", "WebP", "GIF"]) {
      assert.ok(h.toasts[0].message.includes(name), `拒绝文案点名 ${name}`);
    }
    assert.equal(h.store.state.blob, null, "拒绝时不写存储");
    assert.equal(h.rootEl._attrs.has("data-wallpaper"), false, "垫底不亮");
  });

  it("超过 20MB 拒绝并提示，恰好 20MB 放行", async () => {
    const h = harness();
    await h.controller.pickFile({ type: "image/png", size: 20 * 1024 * 1024 + 1 });
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0].isErr, true);
    assert.ok(h.toasts[0].message.includes("20MB"), "超限文案点名上限");
    assert.equal(h.store.state.blob, null);
    await h.controller.pickFile({ type: "image/png", size: 20 * 1024 * 1024 });
    assert.equal(h.store.state.blob?.size, 20 * 1024 * 1024, "边界值放行");
  });

  it("动图与 webp 同在白名单", async () => {
    const h = harness();
    await h.controller.pickFile({ type: "image/gif", size: 10 });
    assert.equal(h.toasts.at(-1).isErr, false);
    await h.controller.pickFile({ type: "image/webp", size: 10 });
    assert.equal(h.toasts.at(-1).isErr, false);
  });
});

describe("壁纸控制器：上传/调参/移除", () => {
  it("上传成功：入库、垫底点亮、token 注入并写首帧缓存，按钮换「更换/移除」", async () => {
    const h = harness();
    await h.controller.pickFile(PNG_1KB);
    assert.equal(h.store.state.saves, 1, "blob 入库");
    assert.equal(h.rootEl._attrs.get("data-wallpaper"), "active", "垫底激活");
    assert.ok(h.rootEl._props.get("--accent"), "引擎 token 已注入 :root");
    assert.ok(h.rootEl._props.get("--surface").startsWith("rgba("), "表面 token 为玻璃化 rgba");
    const cache = JSON.parse(h.storage.getItem("panel-wallpaper-tokens"));
    assert.ok(cache?.light?.["--accent"] && cache?.dark?.["--accent"], "亮暗双套写入首帧缓存");
    assert.equal(h.doc.els.get("wallpaperBackdropImage").style.backgroundImage, 'url("blob:mock")');
    assert.equal(h.doc.els.get("wallpaperBackdropDim").style.background, "rgba(0, 0, 0, 0.1)", "默认压暗 10%");
    assert.equal(h.doc.els.get("wallpaperUploadBtn").hidden, true, "有图后藏上传钮");
    assert.equal(h.doc.els.get("wallpaperChangeBtn").hidden, false);
    assert.equal(h.doc.els.get("wallpaperRemoveBtn").hidden, false);
    assert.equal(h.toasts.at(-1).isErr, false, "成功提示");
  });

  it("再次上传走「更换」语义", async () => {
    const h = harness();
    await h.controller.pickFile(PNG_1KB);
    await h.controller.pickFile({ type: "image/jpeg", size: 2048 });
    assert.equal(h.store.state.saves, 2, "覆盖同键");
    assert.equal(h.toasts.at(-1).isErr, false);
    assert.notEqual(h.toasts[0].message, h.toasts[1].message, "首传与更换提示不同词");
  });

  it("滑杆：模糊/压暗直改垫底层，阅读区不透明度经引擎重取色", async () => {
    const h = harness();
    await h.controller.pickFile(PNG_1KB);
    h.controller.setFx("blur", 12);
    assert.equal(h.doc.els.get("wallpaperBackdropImage").style.filter, "blur(12px)");
    h.controller.setFx("dim", 55);
    assert.equal(h.doc.els.get("wallpaperBackdropDim").style.background, "rgba(0, 0, 0, 0.55)");
    h.controller.setFx("surface", 40);
    assert.ok(/0\.4\)$/.test(h.rootEl._props.get("--surface")), "表面 alpha 随滑杆到 0.4");
    assert.ok(/0\.4\)$/.test(h.rootEl._props.get("--bg-page")), "页底 alpha 同步");
    const cache = JSON.parse(h.storage.getItem("panel-wallpaper-tokens"));
    assert.ok(/0\.4\)$/.test(cache.light["--surface"]), "重取色结果回写缓存");
    const fx = JSON.parse(h.storage.getItem("panel-wallpaper-fx"));
    assert.deepEqual(fx, { blur: 12, dim: 55, surface: 40 }, "滑杆值记本机");
  });

  it("滑杆存档越界按区间钳制，非法值回默认", () => {
    const h = harness({ fxSaved: JSON.stringify({ blur: 99, dim: -3, surface: "x" }) });
    assert.equal(h.controller.fx.blur, 30);
    assert.equal(h.controller.fx.dim, 0);
    assert.equal(h.controller.fx.surface, 80);
  });

  it("移除背景图：清库、熄垫底、清注入与缓存、自动切回 Default，滑杆值保留", async () => {
    const h = harness();
    await h.controller.pickFile(PNG_1KB);
    h.controller.setFx("blur", 12);
    await h.controller.removeImage();
    assert.equal(h.store.state.clears, 1, "存储清空");
    assert.equal(h.rootEl._attrs.has("data-wallpaper"), false, "垫底熄灭");
    assert.equal(h.rootEl._props.size, 0, "注入 token 全清");
    assert.equal(h.storage.getItem("panel-wallpaper-tokens"), null, "首帧缓存删除");
    assert.equal(h.calls.fallback, 1, "触发切回 Default");
    assert.equal(h.doc.els.get("wallpaperUploadBtn").hidden, false, "回到无图态按钮");
    assert.deepEqual(JSON.parse(h.storage.getItem("panel-wallpaper-fx")), { blur: 12, dim: 10, surface: 80 },
      "滑杆值保留");
  });
});

describe("壁纸控制器：主题进出与亮暗跟随", () => {
  it("切走「自定义」清掉全部注入属性，切回时按缓存恢复", async () => {
    const h = harness();
    await h.controller.pickFile(PNG_1KB);
    const accentLight = h.rootEl._props.get("--accent");
    await h.controller.syncStyle(false);
    assert.equal(h.rootEl._props.size, 0, "切走清空注入");
    assert.equal(h.storage.getItem("panel-wallpaper-tokens"), null, "缓存随切走删除");
    assert.equal(h.store.state.blob?.size, 1024, "图片本体保留在库");
    await h.controller.syncStyle(true);
    assert.equal(h.rootEl._props.get("--accent"), accentLight, "切回同会话按内存像素重注");
  });

  it("亮暗切换注入对应套（含跟随系统的系统侧变化）", async () => {
    const h = harness();
    await h.controller.pickFile(PNG_1KB);
    const lightAccent = h.rootEl._props.get("--accent");
    h.rootEl.setAttribute("data-theme", "dark");
    h.controller.syncMode();
    const darkAccent = h.rootEl._props.get("--accent");
    assert.notEqual(darkAccent, lightAccent, "暗态注入暗套 token");
    h.rootEl.removeAttribute("data-theme");
    h.setDark(true);
    h.controller.syncMode();
    assert.equal(h.rootEl._props.get("--accent"), darkAccent, "跟随系统暗态同套");
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
    await h.controller.pickFile(PNG_1KB);
    assert.equal(h.rootEl._attrs.get("data-wallpaper"), "active");
    assert.equal(h.rootEl._props.size, 0, "无引擎不注入");
    h.controller.setFx("blur", 5);
    assert.equal(h.doc.els.get("wallpaperBackdropImage").style.filter, "blur(5px)");
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
