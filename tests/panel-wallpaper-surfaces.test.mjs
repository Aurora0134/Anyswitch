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

describe("壁纸态平铺盒补底（T1）", () => {
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
    // 子 tab 托盘，共三个选择器；卡头与空态已按塔台口径撤出补偿（见下一条），三套静态
    // 皮肤一条都不许多。注释剥离与选择器切分见 cssRules/splitSelectors。
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

  it("卡头与空态不铺底：壁纸态仍无背景，由卡片实底承担（塔台口径）", () => {
    // 结构扫描：壁纸作用域一条规则都不得命中 .card-header / .empty-hint。卡头在卡内、
    // 卡面已恢复实底，再加一层会在卡顶多出一道头带；空态则守住阶段 3 的纯排版
    // （无底无框）。命中即说明 T1 又把这两处铺了回去。
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

describe("表面 token 分档（T2）", () => {
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

