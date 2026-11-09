// 壁纸主题取色引擎回归测试：合成像素夹具驱动 extractTheme，断言
// token 完备性（亮暗两套逐键齐）、文字对比度兜底、语义色相互可区分、
// 采样过滤链（近白/透明/兜底种子）与同输入同输出（确定性）。
import { test } from "node:test";
import assert from "node:assert/strict";
import WallpaperTheme from "../panel-ui/wallpaper-theme.js";

const { extractTheme } = WallpaperTheme;

// 契约「必须定义齐全的 token」全集：引擎亮暗两套必须逐键不多不少
const TOKEN_KEYS = [
  "--font-sans", "--font-mono", "--ease-out",
  "--bg", "--bg-page", "--surface", "--surface-sunken", "--surface-hover", "--surface-glass",
  "--text", "--text-2", "--text-3", "--text-4",
  "--border", "--border-strong", "--divider",
  "--accent", "--accent-soft", "--accent-border",
  "--ok", "--ok-soft", "--ok-border",
  "--warn", "--warn-soft", "--warn-border",
  "--danger", "--danger-soft", "--danger-border",
  "--pool", "--pool-soft", "--pool-border",
  "--spark-line", "--spark-fill", "--danger-glow",
  "--shadow-xs", "--shadow-sm", "--shadow-md", "--shadow-lg",
  "--radius-sm", "--radius-md", "--radius-lg",
  "--accent-gradient", "--accent-glow",
];

const SURFACE_KEYS = ["--bg", "--bg-page", "--surface", "--surface-sunken", "--surface-hover", "--surface-glass"];

// ═══════════════════════════════════════════════
// 夹具与解析工具
// ═══════════════════════════════════════════════

// fill: [r,g,b] / [r,g,b,a] 常量，或 (pixelIndex) => [...] 逐像素函数
function makePixels(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const [r, g, b, a] = typeof fill === "function" ? fill(i) : fill;
    data.set([r, g, b, a === undefined ? 255 : a], i * 4);
  }
  return { data, width, height };
}

function parseColor(v) {
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  m = v.match(/^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/);
  assert.ok(m, `无法解析的颜色值: ${v}`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) };
}

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

function rgbToHue([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  return ((h % 360) + 360) % 360;
}

function hueDistance(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

function seedHue(theme) {
  return rgbToHue(parseColor(theme.seed).rgb);
}

// ═══════════════════════════════════════════════
// 夹具集
// ═══════════════════════════════════════════════

const BLUE = makePixels(64, 64, [37, 99, 235]); // 纯色蓝
const GREEN = makePixels(64, 64, [22, 163, 74]); // 纯色绿
const RED = makePixels(64, 64, [192, 32, 32]); // 纯色红
const PURPLE = makePixels(64, 64, [124, 58, 237]); // 纯色紫（号池基准色相，压测避让）
const TWO_TONE = makePixels(64, 64, (i) => ((i % 64) < 32 ? [192, 32, 32] : [32, 64, 192])); // 左红右蓝
const WHITE_DOMINANT = makePixels(80, 80, (i) => (i % 10 === 0 ? [22, 163, 74] : [253, 253, 253])); // 近白主导
const NEAR_BLACK = makePixels(32, 32, [10, 10, 10]); // 近黑
const GRAY = makePixels(32, 32, [128, 128, 128]); // 低饱和灰
const TRANSPARENT_RED = makePixels(32, 32, [200, 30, 30, 0]); // 全透明（透明通道下仍带 RGB）
const EMPTY = { data: new Uint8ClampedArray(0), width: 0, height: 0 }; // 零像素输入

// ═══════════════════════════════════════════════
// token 完备性与确定性
// ═══════════════════════════════════════════════

test("token 完备性：亮暗两套逐键对齐契约全集，不多不少", () => {
  const theme = extractTheme(BLUE);
  const want = [...TOKEN_KEYS].sort();
  assert.deepEqual(Object.keys(theme.light).sort(), want, "亮色套 token 键集与契约全集不一致");
  assert.deepEqual(Object.keys(theme.dark).sort(), want, "暗色套 token 键集与契约全集不一致");
  for (const mode of ["light", "dark"]) {
    for (const key of TOKEN_KEYS) {
      assert.equal(typeof theme[mode][key], "string", `${mode} ${key} 必须是字符串值`);
      assert.ok(theme[mode][key].length > 0, `${mode} ${key} 不能为空串`);
    }
  }
  assert.match(theme.seed, /^#[0-9a-f]{6}$/, "seed 必须是 #rrggbb 形态");
});

test("surface 系为玻璃化 rgba：默认透明度小于 1，且可按 options.surfaceAlpha 覆盖", () => {
  const theme = extractTheme(BLUE);
  for (const mode of ["light", "dark"]) {
    for (const key of SURFACE_KEYS) {
      const { alpha } = parseColor(theme[mode][key]);
      assert.ok(alpha < 1, `${mode} ${key} 默认应透明（玻璃化），实得 alpha=${alpha}`);
      assert.ok(alpha > 0, `${mode} ${key} 透明度必须为正`);
    }
  }
  const overridden = extractTheme(BLUE, { surfaceAlpha: { light: { "--surface": 0.5 }, dark: { "--surface": 1 } } });
  assert.equal(parseColor(overridden.light["--surface"]).alpha, 0.5, "surfaceAlpha 亮色覆盖未生效");
  assert.equal(parseColor(overridden.dark["--surface"]).alpha, 1, "surfaceAlpha 暗色覆盖未生效");
  // 覆盖不污染默认值：同输入再跑一次应回到默认
  const again = extractTheme(BLUE);
  assert.deepEqual(again, theme, "options 覆盖泄漏到了默认输出");
});

test("确定性：同输入同输出（含零像素边界输入）", () => {
  for (const fixture of [BLUE, TWO_TONE, WHITE_DOMINANT, NEAR_BLACK, GRAY, EMPTY]) {
    assert.deepEqual(extractTheme(fixture), extractTheme(fixture), "同一像素输入两次取色结果不一致");
  }
});

// ═══════════════════════════════════════════════
// 采样过滤链与种子选取
// ═══════════════════════════════════════════════

test("纯色图：种子色相贴近原色", () => {
  const theme = extractTheme(BLUE);
  assert.ok(hueDistance(seedHue(theme), 221) <= 10, `蓝色图种子色相 ${seedHue(theme)} 偏离 221 过远`);
});

test("双色图：种子取自两主色之一", () => {
  const theme = extractTheme(TWO_TONE);
  const h = seedHue(theme);
  assert.ok(
    hueDistance(h, 0) <= 15 || hueDistance(h, 230) <= 15,
    `双色（红/蓝）图种子色相 ${h} 不接近任一主色`,
  );
});

test("近白主导：ignoreWhite 过滤近白像素，种子取自少数彩色", () => {
  const theme = extractTheme(WHITE_DOMINANT);
  assert.ok(
    hueDistance(seedHue(theme), 145) <= 15,
    `近白主导图应忽略白色、取绿色为种子，实得色相 ${seedHue(theme)}`,
  );
});

test("近黑图：亮度低于下限，种子回退 #667788", () => {
  assert.equal(extractTheme(NEAR_BLACK).seed, "#667788");
});

test("低饱和图：饱和度低于下限，种子回退 #667788", () => {
  assert.equal(extractTheme(GRAY).seed, "#667788");
});

test("全透明图：透明阈值放宽后仍取像素 RGB，种子贴近红色", () => {
  const theme = extractTheme(TRANSPARENT_RED);
  assert.ok(hueDistance(seedHue(theme), 0) <= 15, `全透明红图种子色相 ${seedHue(theme)} 偏离 0 过远`);
});

test("零像素输入：种子回退 #667788，token 仍齐全", () => {
  const theme = extractTheme(EMPTY);
  assert.equal(theme.seed, "#667788");
  assert.deepEqual(Object.keys(theme.light).sort(), [...TOKEN_KEYS].sort());
  assert.deepEqual(Object.keys(theme.dark).sort(), [...TOKEN_KEYS].sort());
});

// ═══════════════════════════════════════════════
// 对比度兜底
// ═══════════════════════════════════════════════

test("文字对比度：text/text-2/text-3 对页面底与卡片面 ≥4.65，text-4 ≥3.0", () => {
  // 对比度按面体不透明基色核算（玻璃透明度对观感的补偿由 UI 层兜底）
  for (const fixture of [BLUE, GREEN, RED, TWO_TONE, WHITE_DOMINANT, NEAR_BLACK, GRAY, EMPTY]) {
    const theme = extractTheme(fixture);
    for (const mode of ["light", "dark"]) {
      const bgs = [parseColor(theme[mode]["--bg"]).rgb, parseColor(theme[mode]["--surface"]).rgb];
      for (const key of ["--text", "--text-2", "--text-3"]) {
        const fg = parseColor(theme[mode][key]).rgb;
        for (const bg of bgs) {
          assert.ok(contrast(fg, bg) >= 4.65 - 1e-9, `${mode} ${key} 对比度 ${contrast(fg, bg)} 不达标（目标 4.65）`);
        }
      }
      const fg4 = parseColor(theme[mode]["--text-4"]).rgb;
      for (const bg of bgs) {
        assert.ok(contrast(fg4, bg) >= 3.0 - 1e-9, `${mode} --text-4 对比度 ${contrast(fg4, bg)} 低于下限 3.0`);
      }
    }
  }
});

// ═══════════════════════════════════════════════
// 语义色可区分（徽章靠颜色读状态）
// ═══════════════════════════════════════════════

test("语义色相互可区分：ok/warn/danger 两两 ≥25°，pool 与 accent/ok/warn/danger ≥25°", () => {
  for (const fixture of [BLUE, GREEN, RED, PURPLE, TWO_TONE]) {
    const theme = extractTheme(fixture);
    for (const mode of ["light", "dark"]) {
      const hue = (key) => rgbToHue(parseColor(theme[mode][key]).rgb);
      const semantics = ["--ok", "--warn", "--danger"];
      for (let i = 0; i < semantics.length; i++) {
        for (let j = i + 1; j < semantics.length; j++) {
          const d = hueDistance(hue(semantics[i]), hue(semantics[j]));
          assert.ok(d >= 25, `${mode} ${semantics[i]} 与 ${semantics[j]} 色相距离 ${d}° 不足 25°`);
        }
      }
      const poolHue = hue("--pool");
      for (const key of ["--accent", ...semantics]) {
        const d = hueDistance(poolHue, hue(key));
        assert.ok(d >= 25, `${mode} --pool 与 ${key} 色相距离 ${d}° 不足 25°（种子 ${theme.seed}）`);
      }
    }
  }
});
