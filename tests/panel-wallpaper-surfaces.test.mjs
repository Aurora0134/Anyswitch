// 壁纸主题「部分块无底层」修复的回归测试：壁纸态平铺盒补底（panel.css 补偿段）与
// 表面 token 分档（panel.js 的三档系数）。
// 断言口径：不只查字符串在不在，还查补偿段落在平铺段之后（同特异性靠源序取胜）、
// 声明只含卡面一项（描边/圆角/无影沿用平铺段，不重画材质）、补偿段只锚 wallpaper
// （三套静态皮肤与默认外观零变化）、档位表恰好覆盖引擎的六个表面 token 且不是同值。
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

const WALLPAPER_SETTINGS_SEL = ':root[data-ui-version="v2"][data-style="wallpaper"] :is(#settingsPanelGeneral, #settingsPanelRoute, #settingsPanelAbout, #settingsPanelAdvanced) .panel-card';
const WALLPAPER_SETTINGS_HEAD_SEL = ':root[data-ui-version="v2"][data-style="wallpaper"] :is(#settingsPanelGeneral, #settingsPanelRoute, #settingsPanelAbout, #settingsPanelAdvanced) .card-header';
const WALLPAPER_STATS_HEAD_SEL = ':root[data-ui-version="v2"][data-style="wallpaper"] #statsView .card-header';
const WALLPAPER_STATS_EMPTY_SEL = ':root[data-ui-version="v2"][data-style="wallpaper"] #statsView .empty-hint';
const WALLPAPER_STATS_SEL = ':root[data-ui-version="v2"][data-style="wallpaper"] #statsView .panel-card';
const STAGE2_SETTINGS_SEL = ':root[data-ui-version="v2"][data-style] :is(#settingsPanelGeneral, #settingsPanelRoute, #settingsPanelAbout, #settingsPanelAdvanced) .panel-card';
const STAGE3_STATS_SEL = ':root[data-ui-version="v2"][data-style] #statsView .panel-card';

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

