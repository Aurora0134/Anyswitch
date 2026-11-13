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
const WHITE_DOMINANT = makePixels(80, 80, (i) => (i % 10 === 0 ? [22, 163, 74] : [253, 253, 253])); // 近白主导（彩色占一成）
// 近白洪泛＋采样首格彩色：近白像素三通道 ≥ 251，HSL 亮度恒 ≥ 0.984，过不了种子的
// 亮度上限（0.9）——白色成不了种子，ignoreWhite 的可观测面在占比稀释：采样步长 8
// 下 512 采样格只有首格彩色，滤近白时彩色满占比成种子；不滤则 1/512 跌破 1% 占比
// 下限，全色板无合格种子、回退 #667788（色相 210°，远离绿色锚）。
const WHITE_FLOOD = makePixels(64, 64, (i) => (i === 0 ? [22, 163, 74] : [253, 253, 253])); // 近白洪泛
const NEAR_BLACK = makePixels(32, 32, [10, 10, 10]); // 近黑
const GRAY = makePixels(32, 32, [128, 128, 128]); // 低饱和灰
// 全透明互补双色（上半洋红、下半绿，alpha 全 0）：通道均值恰为无彩色 (115,115,115)。
// 第三档 alphaThreshold=0 采样不看 alpha、仍按像素 RGB 聚类，种子取绿簇（饱和度
// 1.0 胜洋红 0.8）；删掉第三档则两级采样全空、落入全图均值兜底——均值过不了饱和
// 度下限，回退 #667788，与不透明孪生的聚类种子分道扬镳。
const TRANSPARENT_DUO = makePixels(64, 64, (i) => (i < 2048 ? [230, 30, 230, 0] : [0, 200, 0, 0])); // 全透明互补双色
const OPAQUE_DUO = makePixels(64, 64, (i) => (i < 2048 ? [230, 30, 230] : [0, 200, 0])); // 同 RGB 不透明孪生
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
  const theme = extractTheme(WHITE_FLOOD);
  assert.ok(
    hueDistance(seedHue(theme), 145) <= 15,
    `近白主导图应滤近白保住彩色占比成种子（不滤则占比跌破 1%、回退 #667788 色相 210），实得色相 ${seedHue(theme)}`,
  );
});

test("近黑图：亮度低于下限，种子回退 #667788", () => {
  assert.equal(extractTheme(NEAR_BLACK).seed, "#667788");
});

test("低饱和图：饱和度低于下限，种子回退 #667788", () => {
  assert.equal(extractTheme(GRAY).seed, "#667788");
});

test("全透明图：透明阈值放宽后仍取像素 RGB，与同 RGB 不透明图取色一致", () => {
  const theme = extractTheme(TRANSPARENT_DUO);
  // 第三档（alphaThreshold=0）采样不看 alpha：同 RGB 的透明/不透明输入同输出。
  // 删掉该档则透明图两级采样全空、走全图均值兜底，互补双色的均值是无彩色、过不了
  // 饱和度下限，种子回退 #667788，与不透明图的绿簇种子分道扬镳。
  assert.deepEqual(theme, extractTheme(OPAQUE_DUO),
    "全透明图应与同 RGB 的不透明图取色一致（透明阈值放宽档仍在采样）");
  assert.ok(
    hueDistance(seedHue(theme), 120) <= 20,
    `全透明图种子应取自像素绿簇（色相 120 附近，聚类往返漂移约 13°），实得色相 ${seedHue(theme)}`,
  );
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

test("语义色相互可区分：accent/ok/warn/danger 两两 ≥25°，pool 与四者 ≥25°", () => {
  for (const fixture of [BLUE, GREEN, RED, PURPLE, TWO_TONE]) {
    const theme = extractTheme(fixture);
    for (const mode of ["light", "dark"]) {
      const hue = (key) => rgbToHue(parseColor(theme[mode][key]).rgb);
      const semantics = ["--accent", "--ok", "--warn", "--danger"];
      for (let i = 0; i < semantics.length; i++) {
        for (let j = i + 1; j < semantics.length; j++) {
          const d = hueDistance(hue(semantics[i]), hue(semantics[j]));
          assert.ok(d >= 25, `${mode} ${semantics[i]} 与 ${semantics[j]} 色相距离 ${d}° 不足 25°（种子 ${theme.seed}）`);
        }
      }
      const poolHue = hue("--pool");
      for (const key of semantics) {
        const d = hueDistance(poolHue, hue(key));
        assert.ok(d >= 25, `${mode} --pool 与 ${key} 色相距离 ${d}° 不足 25°（种子 ${theme.seed}）`);
      }
    }
  }
});

test("accent 色相避让：种子贴近语义色时 accent 沿色环推移到安全距离", () => {
  // 红图种子色相 ≈0°（贴 danger），绿图 ≈142°（贴 ok）：accent 必须被推离
  const red = extractTheme(RED);
  const green = extractTheme(GREEN);
  for (const mode of ["light", "dark"]) {
    const hue = (theme, key) => rgbToHue(parseColor(theme[mode][key]).rgb);
    for (const key of ["--ok", "--warn", "--danger"]) {
      assert.ok(hueDistance(hue(red, "--accent"), hue(red, key)) >= 25, `红图 ${mode} accent 未避开 ${key}`);
      assert.ok(hueDistance(hue(green, "--accent"), hue(green, key)) >= 25, `绿图 ${mode} accent 未避开 ${key}`);
    }
    // 避让只推 accent token，种子本身仍保原图色相
    assert.ok(hueDistance(seedHue(red), hue(red, "--danger")) <= 15, "红图种子应仍贴近红色族");
    assert.ok(hueDistance(seedHue(green), hue(green, "--ok")) <= 25, "绿图种子应仍贴近绿色族");
  }
});
