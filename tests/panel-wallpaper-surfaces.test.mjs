// 壁纸主题「部分块无底层」修复的回归测试：壁纸态平铺盒补底（panel.css 补偿段，只补
// 卡面与统计子 tab 托盘；卡头与空态由卡片底承担、不另铺）与表面 token 分档（panel.js 的
// 三档系数）。
// 断言口径：不只查字符串在不在，还查补偿段落在平铺段之后（同特异性靠源序取胜）、
// 声明只含该补的一项（描边/圆角/无影沿用平铺段，不重画材质）、补偿段只锚 wallpaper
// （三套静态皮肤与默认外观零变化）、卡头/空态在壁纸作用域无任何补底规则、
// 档位表恰好覆盖引擎的六个表面 token 且不是同值。
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WallpaperTheme from "../panel-ui/wallpaper-theme.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const panelCss = readFileSync(join(rootDir, "panel-ui", "panel.css"), "utf8");
const panelJs = readFileSync(join(rootDir, "panel-ui", "panel.js"), "utf8");

// 引擎 SURFACE_SPEC 的键集（壁纸主题下六个表面 token 的定义面）
const ENGINE_SURFACE_KEYS = ["--bg", "--bg-page", "--surface", "--surface-sunken", "--surface-hover", "--surface-glass"];

// 档位表在 panel.js 里是纯数据：原样抽出来求值
function surfaceTierTable() {
  const m = panelJs.match(/const WALLPAPER_SURFACE_TIERS = (\[[\s\S]*?\]);/);
  assert.ok(m, "panel.js 含 WALLPAPER_SURFACE_TIERS 档位表");
  return vm.runInNewContext(`(${m[1]})`);
}

// 滑杆值 → 六个表面 token 的 alpha（与 panel.js surfaceOverrides 同式：floor + scale×滑杆值，
// 三位小数）。测试用它算出「用户停在某一档时引擎实际拿到的 alpha」。
function surfaceAlphasAt(slider) {
  const s = slider / 100;
  const overrides = {};
  for (const tier of surfaceTierTable()) {
    const alpha = Math.round((tier.floor + tier.scale * s) * 1000) / 1000;
    for (const key of tier.keys) overrides[key] = alpha;
  }
  return overrides;
}

// 取一条规则的声明体：selector 必须逐字命中，取其后第一个 {...}
function ruleBody(selector, label) {
  const idx = panelCss.indexOf(selector);
  assert.ok(idx >= 0, `${label}：规则不在册（selector 未逐字命中）`);
  const open = panelCss.indexOf("{", idx);
  const close = panelCss.indexOf("}", open);
  assert.ok(open > 0 && close > open, `${label}：规则体不闭合`);
  return {
    start: idx,
    decls: panelCss.slice(open + 1, close).split(";").map((d) => d.trim().replace(/\s+/g, " ")).filter(Boolean),
  };
}

// 结构扫描口径（各条测试共用）：注释块里也有逗号与花括号，先剥注释再按 {...} 切规则；
// 选择器按括号深度切逗号（:is(a, b, c) 内的逗号不是选择器分隔符）。
function splitSelectors(text) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
function cssRules() {
  const css = panelCss.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: splitSelectors(m[1]), body: m[2] }));
}
// 壁纸作用域的选择器（补偿段审计用；token 段与垫底结构也在内，故按需再筛目标元素）
function wallpaperSelectors() {
  return cssRules().flatMap((r) => r.sel.filter((s) => s.includes('data-style="wallpaper"')));
}
// 补偿段命中的元素：卡面与统计子 tab 托盘（卡头/空态不在补偿范围，见对应断言）
const COMPENSATION_SURFACE = /\.panel-card|\.view-tabs\.stats-subtabs/;

const WALLPAPER_SETTINGS_SEL = ':root[data-ui-version="v2"][data-style="wallpaper"] :is(#settingsPanelGeneral, #settingsPanelRoute, #settingsPanelAbout, #settingsPanelAdvanced) .panel-card';
const WALLPAPER_STATS_SEL = ':root[data-ui-version="v2"][data-style="wallpaper"] #statsView .panel-card';
const WALLPAPER_STATS_SUBTABS_SEL = ':root[data-ui-version="v2"][data-style="wallpaper"] .view-tabs.stats-subtabs';
const STAGE2_SETTINGS_SEL = ':root[data-ui-version="v2"][data-style] :is(#settingsPanelGeneral, #settingsPanelRoute, #settingsPanelAbout, #settingsPanelAdvanced) .panel-card';
const STAGE2_SETTINGS_HEAD_SEL = ':root[data-ui-version="v2"][data-style] :is(#settingsPanelGeneral, #settingsPanelRoute, #settingsPanelAbout, #settingsPanelAdvanced) .card-header';
const STAGE3_STATS_SEL = ':root[data-ui-version="v2"][data-style] #statsView .panel-card';
const STAGE3_STATS_HEAD_SEL = ':root[data-ui-version="v2"][data-style] #statsView .card-header';
const STAGE3_STATS_EMPTY_SEL = ':root[data-ui-version="v2"][data-style] #statsView .empty-hint';

describe("壁纸态平铺盒补底", () => {
  it("设置页四张卡与统计页卡补卡面：只加 background: var(--surface)，描边/圆角/无影沿用平铺段", () => {
    const comp = ruleBody(WALLPAPER_SETTINGS_SEL, "壁纸态设置页补底规则");
    assert.deepEqual(comp.decls, ["background: var(--surface)"],
      "补底只写卡面一项（排除顺手重画描边/圆角/投影/backdrop-filter）");
    // 统计页卡与设置页四张卡同一条规则（同一个声明块）：确认两处都罩到
    assert.ok(panelCss.slice(comp.start, comp.start + 400).includes(WALLPAPER_STATS_SEL),
      "同一条补偿规则同时锚统计页卡（两处来源一次收口）");
    const stats = ruleBody(WALLPAPER_STATS_SEL, "壁纸态统计页补底规则");
    assert.deepEqual(stats.decls, ["background: var(--surface)"], "统计页卡面声明与设置页同源");
  });

  it("补偿段落在阶段 2/3 平铺段之后（同特异性靠源序取胜，不靠 !important）", () => {
    const stage2 = panelCss.indexOf(STAGE2_SETTINGS_SEL);
    const stage3 = panelCss.indexOf(STAGE3_STATS_SEL);
    const comp = panelCss.indexOf(WALLPAPER_SETTINGS_SEL);
    assert.ok(stage2 > 0 && stage3 > 0 && comp > 0, "三段规则都在册");
    assert.ok(comp > stage2, "设置页补偿在阶段 2 平铺段之后");
    assert.ok(comp > stage3, "统计页补偿在阶段 3 平铺段之后");
    assert.ok(!panelCss.slice(comp, panelCss.indexOf("}", comp)).includes("!important"),
      "不靠 !important 压层叠");
    // 平铺段自身仍是透明描边盒（补偿是叠加的一层，不是把平铺段改回实底——
    // 那样 saas/aurora/sepia 三套皮肤会跟着变）
    for (const [sel, label] of [[STAGE2_SETTINGS_SEL, "阶段 2 设置段"], [STAGE3_STATS_SEL, "阶段 3 统计段"]]) {
      const body = ruleBody(sel, label);
      assert.ok(body.decls.includes("background: transparent"), `${label} 仍为透明描边盒`);
      assert.ok(body.decls.includes("border: 1px solid var(--border)"), `${label} 描边语言不变`);
      assert.ok(body.decls.includes("border-radius: var(--radius-md)"), `${label} 圆角档不变`);
    }
  });

  it("补偿段只锚 wallpaper：三套静态皮肤与默认外观零变化", () => {
    // 全文件结构扫描：壁纸态补偿规则只剩两条——卡面（设置页四面板 + 统计页）与统计
    // 子 tab 托盘，共三个选择器；卡头与空态不在补偿范围（见下一条），三套静态皮肤
    // 一条都不许多。注释剥离与选择器切分见 cssRules/splitSelectors。
    const compensation = cssRules().flatMap((r) => r.sel
      .filter((s) => s.includes('data-style="wallpaper"') && COMPENSATION_SURFACE.test(s))
      .map((s) => ({ rule: r, sel: s })));
    assert.equal(compensation.length, 3, "补偿段共三个选择器（设置页卡 + 统计页卡 + 统计子 tab）");
    assert.equal(new Set(compensation.map((c) => c.rule)).size, 2, "分属两条规则（卡面一条、托盘一条）");
    const cardRule = compensation.find((c) => c.sel.includes(".panel-card")).rule;
    assert.equal(compensation.filter((c) => c.rule === cardRule).length, 2,
      "卡面规则恰好两个选择器（设置页四面板 + 统计页）");
    for (const { sel } of compensation) {
      assert.ok(sel.includes('[data-ui-version="v2"]'), "补偿只作用于 v2（v1 平铺段不存在，无需补）");
      assert.ok(sel.includes('[data-style="wallpaper"]'), "选择器逐条锚 wallpaper");
      for (const skin of ["saas", "aurora", "sepia"]) {
        assert.ok(!sel.includes(skin), `${skin} 不得进补偿段作用域`);
      }
    }
    // aurora 原有的玻璃卡例外原样在册（补偿不是把例外替换掉）
    assert.ok(panelCss.includes(':root[data-ui-version="v2"][data-style="aurora"] #statsView .panel-card'),
      "aurora 统计页玻璃卡例外原样");
    assert.ok(/\[data-ui-version="v2"\]\[data-style="aurora"\] :is\(#settingsPanelGeneral[^)]*\) \.panel-card \{/.test(panelCss),
      "aurora 设置页玻璃卡例外原样");
  });

  it("卡头与空态不铺底：壁纸态仍无背景，由卡片实底承担", () => {
    // 结构扫描：壁纸作用域一条规则都不得命中 .card-header / .empty-hint。卡头在卡内、
    // 卡面已恢复实底，再加一层会在卡顶多出一道头带；空态则守住阶段 3 的纯排版
    // （无底无框）。命中即说明补偿又把这两处铺了回去。
    const hits = wallpaperSelectors().filter((s) => /\.card-header|\.empty-hint/.test(s));
    assert.deepEqual(hits, [], "壁纸作用域不得命中卡头/空态");
    // 计算值口径：壁纸态不再有覆盖规则，卡头/空态的 background 由阶段 2/3 平铺规则定成
    // 的 transparent 生效（其特异性：属性 + ID 级 > 基座的单类，故不看源序也压得住基座）。
    const baseHead = panelCss.indexOf("  .card-header {\n    display: flex;");
    const baseEmpty = panelCss.indexOf("  .empty-hint {\n    text-align: center;");
    assert.ok(baseHead > 0 && baseEmpty > 0, "基座卡头/空态规则在册");
    for (const [sel, label] of [
      [STAGE2_SETTINGS_HEAD_SEL, "阶段 2 设置页卡头"],
      [STAGE3_STATS_HEAD_SEL, "阶段 3 统计页卡头"],
    ]) {
      const body = ruleBody(sel, label);
      assert.ok(body.decls.includes("background: transparent"), `${label} 仍为透明（底由卡面承担）`);
    }
    const empty = ruleBody(STAGE3_STATS_EMPTY_SEL, "阶段 3 统计页空态");
    assert.ok(empty.decls.includes("background: transparent"), "空态仍无底（不铺 sunken）");
    assert.ok(empty.decls.includes("border: 0"), "空态仍无框（阶段 3 定稿原样）");
    // 基座确实带实底：它是「卡头有底、却被平铺段剥成透明」的来源，也是卡面补偿必须
    // 承担整张卡底的由来；空态基座的 sunken 底同理被阶段 3 剥掉。
    assert.ok(panelCss.slice(baseHead, panelCss.indexOf("}", baseHead)).includes("background: var(--surface)"),
      "基座卡头实底原样（壁纸态由平铺段剥成透明）");
    assert.ok(panelCss.slice(baseEmpty, panelCss.indexOf("}", baseEmpty)).includes("background: var(--surface-sunken)"),
      "基座空态 sunken 底原样（壁纸态由阶段 3 剥掉）");
  });

  it("统计页子 tab：恢复托盘材质（--surface-sunken + 描边），选中态仍是下划线指示条", () => {
    const sel = WALLPAPER_STATS_SUBTABS_SEL;
    const tray = ruleBody(sel, "壁纸态统计子 tab 托盘");
    assert.deepEqual(tray.decls, ["background: var(--surface-sunken)", "border-color: var(--border)"],
      "只补托盘底与描边（不重画胶囊、不动圆角档，基座已给 --radius-md）");
    // 阶段 3 撤托盘那条仍在（补偿不改写它，三皮肤照旧无托盘）
    const stage3Tray = ':root[data-ui-version="v2"][data-style] .view-tabs.stats-subtabs {';
    const stage3Idx = panelCss.indexOf(stage3Tray);
    assert.ok(stage3Idx > 0, "阶段 3 撤托盘规则在册");
    assert.ok(stage3Idx < panelCss.indexOf(sel), "补偿在撤托盘之后（靠源序取胜）");
    // 选中态仍是不占几何的下划线指示条（托盘回来了也不改用胶囊选中块）
    assert.ok(panelCss.includes(':root[data-ui-version="v2"][data-style] .stats-subtabs .view-tab.active {\n    background: transparent; border: 0; color: var(--text);\n    box-shadow: inset 0 -2px 0 var(--accent);\n  }'),
      "选中态 2px accent 下划线原样");
  });
});

describe("表面 token 分档", () => {
  it("档位表恰好覆盖引擎的六个表面 token，不漏不重", () => {
    const table = surfaceTierTable();
    assert.ok(Array.isArray(table) && table.length > 0, "WALLPAPER_SURFACE_TIERS 在册");
    const keys = table.flatMap((t) => t.keys);
    assert.equal(new Set(keys).size, keys.length, "同一 token 不得落进两档");
    assert.deepEqual([...keys].sort(), [...ENGINE_SURFACE_KEYS].sort(),
      "档位表必须覆盖引擎 SURFACE_SPEC 的全部键（漏一键该键就不跟滑杆走）");
    // 引擎确实自带分档：默认档下 玻璃面 < 内容面 < 页面底（档位表是对齐它的）
    const theme = WallpaperTheme.extractTheme({ data: new Uint8ClampedArray(4 * 16), width: 16, height: 16 });
    const alpha = (mode, key) => Number(theme[mode][key].match(/,\s*([\d.]+)\)$/)[1]);
    for (const mode of ["light", "dark"]) {
      assert.ok(alpha(mode, "--surface-glass") < alpha(mode, "--surface"),
        `${mode} 引擎默认玻璃面本就低于内容面（磨砂语言）`);
      assert.ok(alpha(mode, "--surface") < alpha(mode, "--bg"),
        `${mode} 引擎默认页面底本就高于内容面`);
    }
  });

  it("三档语义：内容面 1:1、玻璃面较低系数、页面底高档带，且六键不同值", () => {
    const byKey = {};
    for (const tier of surfaceTierTable()) for (const key of tier.keys) byKey[key] = tier;
    for (const key of ["--surface", "--surface-sunken", "--surface-hover"]) {
      assert.equal(byKey[key].floor, 0, `${key} 无底座偏移（滑杆语义原样）`);
      assert.equal(byKey[key].scale, 1, `${key} 1:1 跟随滑杆`);
    }
    const glass = byKey["--surface-glass"];
    assert.equal(glass.scale > 0 && glass.scale < 1, true, "玻璃面按较低系数跟随（保住磨砂）");
    for (const key of ["--bg", "--bg-page"]) {
      const tier = byKey[key];
      assert.ok(tier.floor > 0, `${key} 有高档底座（最低档也不退成照片）`);
      assert.ok(tier.scale > 0 && tier.floor + tier.scale <= 1, `${key} 满档不超过 1`);
    }
    // 分档的本质：默认档下六键至少三种不同 alpha（六键同值的旧形态过不了这关）
    const s = 0.8;
    const alphas = new Set(Object.values(byKey).map((t) => Math.round((t.floor + t.scale * s) * 1000) / 1000));
    assert.ok(alphas.size >= 3, "默认档下内容面/玻璃面/页面底三值不同");
  });
});

// ═══════════════════════════════════════════════
// 弱字对比：真实观感 = 面体按 alpha 合成到照片上
// ═══════════════════════════════════════════════

// 与引擎同式的 WCAG 核算。文字色是不透明 hex，面体是 rgba：壁纸下真实观感色 =
// 面体按 alpha 合成到照片上，照片不受控，取全色域网格里的最不利值。
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r / 255) + 0.7152 * srgbToLinear(g / 255) + 0.0722 * srgbToLinear(b / 255);
}
function contrast(c1, c2) {
  const l1 = luminance(c1);
  const l2 = luminance(c2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function parseColor(v) {
  const m = v.match(/^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], alpha: +m[4] };
  const n = parseInt(v.slice(1), 16);
  return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
}
function overPhoto(color, photo) {
  const { rgb, alpha } = parseColor(color);
  return [0, 1, 2].map((i) => Math.round(alpha * rgb[i] + (1 - alpha) * photo[i]));
}
// 照片色网格：每通道 0..255 步长 17（16³ = 4096 色，含两端极值）
const PHOTO_GRID = [];
for (let r = 0; r <= 255; r += 17) for (let g = 0; g <= 255; g += 17) for (let b = 0; b <= 255; b += 17) PHOTO_GRID.push([r, g, b]);
function minContrastOn(colorToken, textToken) {
  const fg = parseColor(textToken).rgb;
  let min = Infinity, at = null;
  for (const photo of PHOTO_GRID) {
    const ratio = contrast(overPhoto(colorToken, photo), fg);
    if (ratio < min) { min = ratio; at = photo; }
  }
  return { min, at };
}
function solidPixels(rgb, w = 16, h = 16) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return { data, width: w, height: h };
}

describe("弱字对比：默认档下卡面与下沉面合成到照片仍达标", () => {
  const FIXTURES = {
    蓝: [37, 99, 235], 暖橙: [210, 120, 50], 绿: [22, 163, 74],
    近黑: [10, 10, 10], 近白: [253, 253, 253],
  };
  const DEFAULT_ALPHAS = surfaceAlphasAt(80); // 滑杆默认档 80
  const TARGETS = { "--text-2": 4.65, "--text-3": 4.65, "--text-4": 3.0 };

  it("默认 80 档：--text-2/--text-3 ≥4.65、--text-4 ≥3.0（卡面与下沉面，亮暗两套）", () => {
    for (const [name, rgb] of Object.entries(FIXTURES)) {
      const theme = WallpaperTheme.extractTheme(solidPixels(rgb), { surfaceAlpha: { light: DEFAULT_ALPHAS, dark: DEFAULT_ALPHAS } });
      for (const mode of ["light", "dark"]) {
        for (const surface of ["--surface", "--surface-sunken"]) {
          for (const [textKey, target] of Object.entries(TARGETS)) {
            const { min, at } = minContrastOn(theme[mode][surface], theme[mode][textKey]);
            assert.ok(min >= target - 1e-9,
              `${name} ${mode} ${surface} 上的 ${textKey} 对最不利照片 rgb(${at.join(",")}) 只有 ${min.toFixed(2)}（目标 ${target}）`);
          }
        }
      }
    }
  });

  it("核算含「合成到照片」这一层：亮套卡面压黑照片时 --text-3 从 3.13 提到 ≥4.65", () => {
    // 旧实现只按不透明基色推拉，亮套 --text-3 = #6e6e69；同一格换成合成后的卡面只有 3.13。
    // 修好后这一格必须达标——这条对「只算不透明基色」的引擎实现为红。
    const theme = WallpaperTheme.extractTheme(solidPixels([37, 99, 235]), { surfaceAlpha: { light: DEFAULT_ALPHAS, dark: DEFAULT_ALPHAS } });
    const card = parseColor(theme.light["--surface"]);
    const onBlack = [0, 1, 2].map((i) => Math.round(card.alpha * card.rgb[i]));
    const fg = parseColor(theme.light["--text-3"]).rgb;
    const ratio = contrast(onBlack, fg);
    assert.ok(ratio >= 4.65 - 1e-9,
      `亮套 --text-3 对压黑照片的卡面实得 ${ratio.toFixed(2)}（目标 4.65；旧实现 3.13）`);
    // 暗套对称：卡面压白照片
    const darkCard = parseColor(theme.dark["--surface"]);
    const onWhite = [0, 1, 2].map((i) => Math.round(darkCard.alpha * darkCard.rgb[i] + (1 - darkCard.alpha) * 255));
    const darkFg = parseColor(theme.dark["--text-3"]).rgb;
    assert.ok(contrast(onWhite, darkFg) >= 4.65 - 1e-9,
      `暗套 --text-3 对压白照片的卡面实得 ${contrast(onWhite, darkFg).toFixed(2)}（目标 4.65；旧实现 3.69）`);
  });

  it("字阶仍是四档：四个文字 token 两两不同（推拉没有把四档压成同一个颜色）", () => {
    const theme = WallpaperTheme.extractTheme(solidPixels([37, 99, 235]), { surfaceAlpha: { light: DEFAULT_ALPHAS, dark: DEFAULT_ALPHAS } });
    for (const mode of ["light", "dark"]) {
      const values = ["--text", "--text-2", "--text-3", "--text-4"].map((k) => theme[mode][k]);
      assert.equal(new Set(values).size, 4, `${mode} 四档文字色不得重合成一色`);
    }
  });

  it("字阶顺序：亮暗 × 滑杆 60/80/100 × 五个 seed，四档对比度逐档不降且相邻间距 ≥ 最小可分间距", () => {
    // 「两两不同」是空断言：四档互不钳制时，弱档会被步长冲过次弱档——默认 80 档亮套
    // --text-2 4.90 / --text-3 5.13，四色确实不同，层次却是反的。这条按强度次序
    // （text ≥ text-2 ≥ text-3 ≥ text-4）逐档核对比度，并要求相邻档拉开可辨间距。
    const LADDER = ["--text", "--text-2", "--text-3", "--text-4"];
    // 与引擎的 TEXT_LADDER_MIN_GAP 同值，此处按契约独立写死：引擎若把间距改窄，这条
    // 断言就该红，而不是跟着一起放宽。0.2 对比度差在 4.65 一带约合 4 级 8bit 灰阶：
    // 并排看得出两层灰，再窄就只剩 1~2 级、肉眼近乎并色；再宽则要把 --text-2 一起推深，
    // 挤掉正文与次级文字的层次。
    const MIN_GAP = 0.2;
    for (const slider of [60, 80, 100]) {
      const alphas = surfaceAlphasAt(slider);
      for (const [name, rgb] of Object.entries(FIXTURES)) {
        const theme = WallpaperTheme.extractTheme(solidPixels(rgb), { surfaceAlpha: { light: alphas, dark: alphas } });
        for (const mode of ["light", "dark"]) {
          const ratios = LADDER.map((key) =>
            Math.min(...["--surface", "--surface-sunken"].map((surface) => minContrastOn(theme[mode][surface], theme[mode][key]).min)),
          );
          const shown = LADDER.map((key, i) => `${key}=${ratios[i].toFixed(2)}`).join(" ");
          for (let i = 1; i < LADDER.length; i++) {
            const gap = ratios[i - 1] - ratios[i];
            assert.ok(gap >= MIN_GAP - 1e-9,
              `${name} ${mode} 滑杆 ${slider}：${LADDER[i - 1]} 与 ${LADDER[i]} 对比度只差 ${gap.toFixed(2)}（最少 ${MIN_GAP}）——${shown}`);
          }
        }
      }
    }
  });

  it("滑杆 60 暗套边界：四档严格单调、间距 ≥ 0.2，但目标叠加两档间距超出该 alpha 的物理上限", () => {
    // 60 档的 --surface / --surface-sunken alpha 都是 0.6。暗套文字是浅色，卡面按 0.6
    // 合成到最亮照片（白）后已是浅灰：白字对它的对比度上限，五个 seed 里最紧约 4.71
    // （绿 4.71，其余 4.88–5.10）。若四档都按目标 4.65 / 3.0 且相邻再让 0.2，弱档以上
    // 三档要从 3.0 依次走到 4.65 / 4.85 / 5.05——4.85 已高过 4.71，这一档不可能同时
    // 满足「4.65 + 两档间距」。顺序推拉于是从强到弱把中档让到目标之下：实测 --text-3
    // 落在约 4.25–4.64（绿 4.25 / 橙 4.44 / 近黑与近白 4.51 / 蓝 4.64），四档仍严格
    // 单调、间距 ≥ 0.2。这条钉住该边界：不是达标，而是「让不出间距时优先保住层次」。
    const alphas = surfaceAlphasAt(60);
    const LADDER = ["--text", "--text-2", "--text-3", "--text-4"];
    const MIN_GAP = 0.2;
    const weakRung = [];
    let tightestCeiling = Infinity;
    for (const [name, rgb] of Object.entries(FIXTURES)) {
      const theme = WallpaperTheme.extractTheme(solidPixels(rgb), { surfaceAlpha: { light: alphas, dark: alphas } });
      const dark = theme.dark;
      const ratios = LADDER.map((key) =>
        Math.min(...["--surface", "--surface-sunken"].map((surface) => minContrastOn(dark[surface], dark[key]).min)),
      );
      const shown = LADDER.map((key, i) => `${key}=${ratios[i].toFixed(2)}`).join(" ");
      for (let i = 1; i < LADDER.length; i++) {
        const gap = ratios[i - 1] - ratios[i];
        assert.ok(gap >= MIN_GAP - 1e-9,
          `${name} 暗套滑杆 60：${LADDER[i - 1]} 与 ${LADDER[i]} 对比度只差 ${gap.toFixed(2)}（最少 ${MIN_GAP}）——${shown}`);
      }
      weakRung.push({ name, ratio: ratios[2] });
      // 物理上限：任一文字色在两个阅读面合成到最亮照片后能拿到的最小对比度的上界；
      // 合成面是浅灰，白字即最高点，黑字更低。
      for (const surface of ["--surface", "--surface-sunken"]) {
        const c = parseColor(dark[surface]);
        const onWhite = [0, 1, 2].map((i) => Math.round(c.alpha * c.rgb[i] + (1 - c.alpha) * 255));
        const best = Math.max(contrast(onWhite, [255, 255, 255]), contrast(onWhite, [0, 0, 0]));
        if (best < tightestCeiling) tightestCeiling = best;
      }
    }
    // 该组确实在目标之下（不伪造达标）：最紧的 seed 的 --text-3 也够不到 4.65
    const weakest = weakRung.reduce((a, b) => (a.ratio <= b.ratio ? a : b));
    assert.ok(weakest.ratio < 4.65,
      `${weakest.name} 暗套滑杆 60 的 --text-3 实得 ${weakest.ratio.toFixed(2)}，这一档本就不该假装达标`);
    // 上限压住了「4.65 目标 + 两档 0.2 间距」（5.05）：达不到，所以只能优先保间距
    assert.ok(tightestCeiling < 4.65 + 2 * MIN_GAP,
      `滑杆 60 暗套的物理上限 ${tightestCeiling.toFixed(2)} 应低于 ${(4.65 + 2 * MIN_GAP).toFixed(2)}，否则这一档不该让出目标`);
  });
});
