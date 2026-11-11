/*
 * 壁纸主题取色引擎
 *
 * 输入解码后的 RGBA 像素数组，输出「自定义壁纸」主题的亮暗双套 token 表：
 *   extractTheme({ data, width, height }) → { seed, light: { "--bg": ... }, dark: { ... } }
 * 纯函数：不读 DOM/Canvas/存储，不做图片解码（解码与 token 注入属 UI 集成层）。
 *
 * 取色管线：
 *   1. 采样：按步长抽点，过滤近白/低透明像素；采不到时逐级放宽（先放近白过滤、
 *      再放透明阈值），仍为空则退化为全图平均色；
 *   2. 聚类：像素先编码进 OKLCH 空间（L·255、C/0.4·255、H/360·255），再做
 *      5bit/通道直方图 + MMCQ 中位切分，得到 ≤8 个代表色（含占比），结果映射回 sRGB；
 *   3. 种子：按 占比/饱和度/亮度 筛选代表色，取 占比×饱和度 最优者，无合格色时
 *      回退默认种子；再按均衡档收敛饱和度/亮度、保留色相；
 *   4. 成板：种子色向白（亮）/黑（暗）定量混合出背景族（玻璃化 rgba，透明度默认值
 *      为本文件常量，可经 options.surfaceAlpha 覆盖），语义色保固定色相只随亮暗与
 *      种子调和饱和度/亮度，文字色过 WCAG 对比度推拉兜底。
 *
 * 浏览器以经典脚本引入时挂 window.WallpaperTheme；Node 侧按 CommonJS 导出，
 * 测试以 .mjs import 默认导出。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else if (root) {
    root.WallpaperTheme = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // ═══════════════════════════════════════════════
  // 参数常量
  // ═══════════════════════════════════════════════

  // —— 提取 ——
  const COLOR_COUNT = 8; // MMCQ 目标聚类数
  const QUALITY = 8; // 采样步长：每 8 个像素取 1
  const WHITE_THRESHOLD = 250; // 三通道均高于该值视为近白，采样时过滤
  const ALPHA_THRESHOLD = 125; // 透明度低于该值的像素采样时过滤
  const SIGBITS = 5; // 直方图每通道量化位数
  const RSHIFT = 8 - SIGBITS;
  const HISTO_SIZE = 1 << (SIGBITS * 3);
  const MAX_SPLIT_ITERATIONS = 1000; // 切分迭代上限，防异常输入死循环

  // —— 种子筛选与均衡档 ——
  const SEED_MIN_PROPORTION = 0.01; // 代表色占比下限
  const SEED_MIN_SATURATION = 0.12; // HSL 饱和度下限
  const SEED_MIN_LIGHTNESS = 0.06; // HSL 亮度下限（排除近黑）
  const SEED_MAX_LIGHTNESS = 0.9; // HSL 亮度上限（排除近白）
  const FALLBACK_SEED = "#667788"; // 无合格代表色时的默认种子
  const BALANCED_SATURATION_SCALE = 0.9; // 均衡档：饱和度按比例收缩
  const BALANCED_SATURATION_MIN = 0.18;
  const BALANCED_SATURATION_MAX = 0.48;
  const BALANCED_LIGHTNESS = 0.48; // 均衡档亮度归中

  // —— 对比度兜底（WCAG） ——
  const CONTRAST_TARGET = 4.65; // 文字色对候选背景的目标对比度
  const CONTRAST_TARGET_WEAK = 3.0; // 最弱一档文字（占位提示级）的对比度下限
  const CONTRAST_TARGET_ACCENT = 4.5; // 强调色/渐变深端承载白字或文字用法的目标
  const CONTRAST_STEP = 0.035; // 亮度推拉步长
  const CONTRAST_MAX_STEPS = 28;
  const CONTRAST_FALLBACKS = ["#171717", "#f7f7f5"]; // 推拉仍不达标时取对比度高者

  // —— 背景族：种子色向白（亮）/黑（暗）的混合比例与玻璃化默认透明度 ——
  // 透明度是 UI 滑杆的挂钩点：extractTheme 第二参数 surfaceAlpha 可按键覆盖。
  const SURFACE_SPEC = {
    light: {
      "--bg": { ratio: 0.94, alpha: 0.86 },
      "--bg-page": { ratio: 0.9, alpha: 0.86 },
      "--surface": { ratio: 0.985, alpha: 0.78 },
      "--surface-sunken": { ratio: 0.93, alpha: 0.84 },
      "--surface-hover": { ratio: 0.965, alpha: 0.92 },
      "--surface-glass": { ratio: 0.975, alpha: 0.62 },
    },
    dark: {
      "--bg": { ratio: 0.9, alpha: 0.86 },
      "--bg-page": { ratio: 0.94, alpha: 0.88 },
      "--surface": { ratio: 0.855, alpha: 0.8 },
      "--surface-sunken": { ratio: 0.915, alpha: 0.84 },
      "--surface-hover": { ratio: 0.8, alpha: 0.9 },
      "--surface-glass": { ratio: 0.88, alpha: 0.68 },
    },
  };

  // —— 文字四档基准色（过对比度推拉前的起点） ——
  const TEXT_BASE = {
    light: { "--text": "#20201f", "--text-2": "#5e5e5a", "--text-3": "#777772", "--text-4": "#9c9c96" },
    dark: { "--text": "#f2f2ee", "--text-2": "#b5b5af", "--text-3": "#989892", "--text-4": "#85857f" },
  };

  // —— 语义色固定色相：监控面板靠颜色读状态，色相不随壁纸漂移 ——
  const SEMANTIC_HUE = { "--ok": 160, "--warn": 32, "--danger": 0 };
  const ACCENT_HUE_MIN_GAP = 30; // accent 与 ok/warn/danger 的最小色相距离
  const POOL_BASE_HUE = 262; // 号池色基准色相，自动避开 accent 与三个语义色

  // —— 与基座一致、不随壁纸变化的 token ——
  const STATIC_TOKENS = {
    "--font-sans":
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans", sans-serif',
    "--font-mono":
      'ui-monospace, "Cascadia Mono", "Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, "Noto Sans SC", monospace',
    "--ease-out": "cubic-bezier(0.16, 1, 0.3, 1)",
    "--radius-sm": "6px",
    "--radius-md": "8px",
    "--radius-lg": "12px",
  };

  // ═══════════════════════════════════════════════
  // 颜色空间换算与通用工具
  // ═══════════════════════════════════════════════

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function linearToSrgb(c) {
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  // sRGB（0..1）→ OKLCH（L 0..1，C ≥0，H 0..360）
  function srgbToOklch(r, g, b) {
    const lr = srgbToLinear(r);
    const lg = srgbToLinear(g);
    const lb = srgbToLinear(b);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const b2 = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    const C = Math.sqrt(a * a + b2 * b2);
    let H = (Math.atan2(b2, a) * 180) / Math.PI;
    if (H < 0) H += 360;
    return [L, C, H];
  }

  // OKLCH → sRGB（0..1）：色域外的聚类中心直接钳回 sRGB 边界
  function oklchToSrgb(L, C, H) {
    const hr = (H * Math.PI) / 180;
    const a = C * Math.cos(hr);
    const b = C * Math.sin(hr);
    const l3 = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m3 = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s3 = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    return [
      linearToSrgb(clamp(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3, 0, 1)),
      linearToSrgb(clamp(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3, 0, 1)),
      linearToSrgb(clamp(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3, 0, 1)),
    ];
  }

  // RGB（0..255）→ HSL（h 0..360，s/l 0..1）
  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    let h;
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    return [h, s, l];
  }

  // HSL → RGB（0..255，取整）
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r, g, b;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex([r, g, b]) {
    return "#" + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
  }

  // rgba 序列化：透明度保留三位小数（同输入必得同字符串）
  function rgba([r, g, b], alpha) {
    return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`;
  }

  // 两色按 t 混合（t=1 时全为 b）
  function mixRgb(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  }

  function hueDistance(a, b) {
    const d = Math.abs((((a - b) % 360) + 360) % 360);
    return d > 180 ? 360 - d : d;
  }

  function relativeLuminance([r, g, b]) {
    return 0.2126 * srgbToLinear(r / 255) + 0.7152 * srgbToLinear(g / 255) + 0.0722 * srgbToLinear(b / 255);
  }

  function contrastRatio(c1, c2) {
    const l1 = relativeLuminance(c1);
    const l2 = relativeLuminance(c2);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  // 对比度兜底：对一组候选背景取最小对比度，不达标则按背景明暗以固定步长
  // 推拉亮度（保色相饱和度），步进用尽仍不达标时取两个极值色中对比度高者。
  function ensureContrast(rgb, backgrounds, target) {
    const minRatio = (c) => Math.min(...backgrounds.map((bg) => contrastRatio(c, bg)));
    if (minRatio(rgb) >= target) return rgb;
    const [h, s, l0] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    const bgLum = backgrounds.reduce((sum, bg) => sum + relativeLuminance(bg), 0) / backgrounds.length;
    const darken = bgLum > 0.18; // 候选背景偏亮则压暗，偏暗则提亮
    for (let i = 1; i <= CONTRAST_MAX_STEPS; i++) {
      const l = clamp(l0 + (darken ? -CONTRAST_STEP : CONTRAST_STEP) * i, 0, 1);
      const c = hslToRgb(h, s, l);
      if (minRatio(c) >= target) return c;
    }
    let best = hexToRgb(CONTRAST_FALLBACKS[0]);
    let bestRatio = minRatio(best);
    for (const hex of CONTRAST_FALLBACKS.slice(1)) {
      const c = hexToRgb(hex);
      const r = minRatio(c);
      if (r > bestRatio) {
        best = c;
        bestRatio = r;
      }
    }
    return best;
  }

  // ═══════════════════════════════════════════════
  // 采样与 MMCQ 聚类
  // ═══════════════════════════════════════════════

  // 采样建直方图：像素编码进 OKLCH 后按 5bit/通道量化计数。
  // 返回 { histo, sampled }；sampled 为 0 表示该过滤档下无可用像素。
  function buildHistogram(data, pixelCount, { alphaThreshold, ignoreWhite }) {
    const histo = new Uint32Array(HISTO_SIZE);
    let sampled = 0;
    for (let p = 0; p < pixelCount; p += QUALITY) {
      const o = p * 4;
      if (data[o + 3] < alphaThreshold) continue;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      if (ignoreWhite && r > WHITE_THRESHOLD && g > WHITE_THRESHOLD && b > WHITE_THRESHOLD) continue;
      const [L, C, H] = srgbToOklch(r / 255, g / 255, b / 255);
      const e0 = clamp(Math.round(L * 255), 0, 255) >> RSHIFT;
      const e1 = clamp(Math.round((C / 0.4) * 255), 0, 255) >> RSHIFT;
      const e2 = clamp(Math.round((H / 360) * 255), 0, 255) >> RSHIFT;
      histo[(e0 << (2 * SIGBITS)) | (e1 << SIGBITS) | e2]++;
      sampled++;
    }
    return { histo, sampled };
  }

  // 全图平均色：三级放宽仍采不到像素时的兜底代表色
  function averageColor(data, pixelCount) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let p = 0; p < pixelCount; p++) {
      r += data[p * 4];
      g += data[p * 4 + 1];
      b += data[p * 4 + 2];
    }
    return { r: Math.round(r / pixelCount), g: Math.round(g / pixelCount), b: Math.round(b / pixelCount) };
  }

  // vbox：5bit 量化空间里的轴对齐盒子，存三通道 [lo, hi]
  function vboxCount(histo, v) {
    let n = 0;
    for (let i = v[0][0]; i <= v[0][1]; i++)
      for (let j = v[1][0]; j <= v[1][1]; j++)
        for (let k = v[2][0]; k <= v[2][1]; k++) n += histo[(i << (2 * SIGBITS)) | (j << SIGBITS) | k];
    return n;
  }

  function vboxVolume(v) {
    return (v[0][1] - v[0][0] + 1) * (v[1][1] - v[1][0] + 1) * (v[2][1] - v[2][0] + 1);
  }

  // 箱内直方图加权平均，bin 中心还原为 8bit 编码值
  function vboxAverage(histo, v) {
    let n = 0;
    const sum = [0, 0, 0];
    const half = 1 << (RSHIFT - 1);
    for (let i = v[0][0]; i <= v[0][1]; i++)
      for (let j = v[1][0]; j <= v[1][1]; j++)
        for (let k = v[2][0]; k <= v[2][1]; k++) {
          const cnt = histo[(i << (2 * SIGBITS)) | (j << SIGBITS) | k];
          if (!cnt) continue;
          n += cnt;
          sum[0] += cnt * ((i << RSHIFT) + half);
          sum[1] += cnt * ((j << RSHIFT) + half);
          sum[2] += cnt * ((k << RSHIFT) + half);
        }
    return [sum[0] / n, sum[1] / n, sum[2] / n];
  }

  function histogramBounds(histo) {
    const lo = [HISTO_SIZE, HISTO_SIZE, HISTO_SIZE];
    const hi = [-1, -1, -1];
    for (let idx = 0; idx < HISTO_SIZE; idx++) {
      if (!histo[idx]) continue;
      const p = [idx >> (2 * SIGBITS), (idx >> SIGBITS) & 31, idx & 31];
      for (let d = 0; d < 3; d++) {
        if (p[d] < lo[d]) lo[d] = p[d];
        if (p[d] > hi[d]) hi[d] = p[d];
      }
    }
    if (hi[0] < 0) return null;
    return [
      [lo[0], hi[0]],
      [lo[1], hi[1]],
      [lo[2], hi[2]],
    ];
  }

  // 沿最长轴按像素量中位切分；切点保证两侧区间非空（像素量可空，入队前过滤）
  function splitVbox(histo, v) {
    const dims = v.map(([a, b]) => b - a + 1);
    let axis = 0;
    if (dims[1] >= dims[0] && dims[1] >= dims[2]) axis = 1;
    else if (dims[2] >= dims[0] && dims[2] >= dims[1]) axis = 2;
    const o1 = (axis + 1) % 3;
    const o2 = (axis + 2) % 3;
    const lo = v[axis][0];
    const hi = v[axis][1];
    let total = 0;
    const partial = new Array(hi + 1).fill(0);
    for (let i = lo; i <= hi; i++) {
      let plane = 0;
      for (let j = v[o1][0]; j <= v[o1][1]; j++)
        for (let k = v[o2][0]; k <= v[o2][1]; k++) {
          const p = [0, 0, 0];
          p[axis] = i;
          p[o1] = j;
          p[o2] = k;
          plane += histo[(p[0] << (2 * SIGBITS)) | (p[1] << SIGBITS) | p[2]];
        }
      total += plane;
      partial[i] = total;
    }
    let split = hi - 1;
    for (let i = lo; i < hi; i++) {
      if (partial[i] >= total / 2) {
        split = i;
        break;
      }
    }
    const left = v.map((d) => d.slice());
    const right = v.map((d) => d.slice());
    left[axis][1] = split;
    right[axis][0] = split + 1;
    return [left, right];
  }

  // 从候选箱中取优先级最高者切一刀；最高优先者不可再分（单像素箱）时返回 false
  function splitLargest(vboxes, histo, priority) {
    let idx = -1;
    let best = -1;
    for (let i = 0; i < vboxes.length; i++) {
      const p = priority(vboxes[i]);
      if (p > best) {
        best = p;
        idx = i;
      }
    }
    if (idx === -1 || vboxCount(histo, vboxes[idx]) <= 1) return false;
    const [left, right] = splitVbox(histo, vboxes[idx]);
    vboxes.splice(idx, 1);
    if (vboxCount(histo, left) > 0) vboxes.push(left);
    if (vboxCount(histo, right) > 0) vboxes.push(right);
    return true;
  }

  // MMCQ 中位切分：先按像素量优先切到 3/4 目标数（高占比色先成箱），
  // 再按 像素量×体积 优先补齐目标数（照顾分布广的少数色）。
  function mmcq(histo, colorCount) {
    const bounds = histogramBounds(histo);
    if (!bounds) return [];
    const vboxes = [bounds];
    let guard = 0;
    const phaseOne = Math.max(1, Math.floor(colorCount * 0.75));
    while (vboxes.length < phaseOne && guard++ < MAX_SPLIT_ITERATIONS) {
      if (!splitLargest(vboxes, histo, (v) => vboxCount(histo, v))) break;
    }
    while (vboxes.length < colorCount && guard++ < MAX_SPLIT_ITERATIONS) {
      if (!splitLargest(vboxes, histo, (v) => vboxCount(histo, v) * vboxVolume(v))) break;
    }
    return vboxes;
  }

  // 代表色表：箱内均值从 OKLCH 编码映射回 sRGB，按像素量降序
  function paletteFromVboxes(histo, vboxes, sampled) {
    const palette = [];
    for (const v of vboxes) {
      const population = vboxCount(histo, v);
      if (!population) continue;
      const avg = vboxAverage(histo, v);
      const [r, g, b] = oklchToSrgb(avg[0] / 255, (avg[1] / 255) * 0.4, (avg[2] / 255) * 360);
      palette.push({
        r: Math.round(r * 255),
        g: Math.round(g * 255),
        b: Math.round(b * 255),
        population,
        proportion: population / sampled,
      });
    }
    palette.sort((a, b) => b.population - a.population || a.r - b.r || a.g - b.g || a.b - b.b);
    return palette;
  }

  // 三级放宽采样：近白过滤 → 放开近白 → 放开透明阈值；全空退化为全图平均色
  function extractPalette(data, pixelCount) {
    const filters = [
      { alphaThreshold: ALPHA_THRESHOLD, ignoreWhite: true },
      { alphaThreshold: ALPHA_THRESHOLD, ignoreWhite: false },
      { alphaThreshold: 0, ignoreWhite: false },
    ];
    for (const filter of filters) {
      const { histo, sampled } = buildHistogram(data, pixelCount, filter);
      if (sampled > 0) return paletteFromVboxes(histo, mmcq(histo, COLOR_COUNT), sampled);
    }
    if (pixelCount > 0) {
      const avg = averageColor(data, pixelCount);
      return [{ ...avg, population: pixelCount, proportion: 1 }];
    }
    return [];
  }

  // ═══════════════════════════════════════════════
  // 种子色
  // ═══════════════════════════════════════════════

  // 代表色中筛 占比/饱和度/亮度 合格者，取 占比×饱和度 最优；
  // 无合格者回退默认种子。选中的基色过均衡档：保色相，饱和度收缩、亮度归中。
  function selectSeed(palette) {
    let best = null;
    let bestScore = 0;
    for (const c of palette) {
      if (c.proportion < SEED_MIN_PROPORTION) continue;
      const [, s, l] = rgbToHsl(c.r, c.g, c.b);
      if (s < SEED_MIN_SATURATION || l < SEED_MIN_LIGHTNESS || l > SEED_MAX_LIGHTNESS) continue;
      const score = c.proportion * s;
      if (!best || score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    if (!best) return FALLBACK_SEED;
    const [h, s] = rgbToHsl(best.r, best.g, best.b);
    const balanced = clamp(s * BALANCED_SATURATION_SCALE, BALANCED_SATURATION_MIN, BALANCED_SATURATION_MAX);
    return rgbToHex(hslToRgb(h, balanced, BALANCED_LIGHTNESS));
  }

  // ═══════════════════════════════════════════════
  // token 成板
  // ═══════════════════════════════════════════════

  // 语义色：固定色相，饱和度随种子调和，亮度按亮暗取档
  function semanticColor(hue, seedSaturation, light) {
    const s = clamp(0.6 + 0.3 * seedSaturation, 0.55, 0.85);
    return hslToRgb(hue, s, light ? 0.35 : 0.62);
  }

  // accent 色相避让：与任一语义色距离不足 ACCENT_HUE_MIN_GAP 时，沿色环推移到
  // 最近的安全色相（双向等距取顺时针）。语义色只有三个，色环上必存在安全区。
  function avoidSemanticHues(h) {
    const semHues = Object.values(SEMANTIC_HUE);
    const safe = (x) => Math.min(...semHues.map((o) => hueDistance(x, o))) >= ACCENT_HUE_MIN_GAP;
    if (safe(h)) return h;
    for (let d = 1; d <= 180; d++) {
      const cw = (h + d) % 360;
      if (safe(cw)) return cw;
      const ccw = (h + 360 - d) % 360;
      if (safe(ccw)) return ccw;
    }
    return h;
  }

  // 号池色：在色环上取与 accent/ok/warn/danger 距离最远的色相，平局取最接近基准色相者
  function pickPoolHue(occupied) {
    let bestHue = POOL_BASE_HUE;
    let bestScore = -Infinity;
    for (let h = 0; h < 360; h++) {
      const score = Math.min(...occupied.map((o) => hueDistance(h, o)));
      if (score > bestScore + 1e-9) {
        bestScore = score;
        bestHue = h;
      } else if (
        Math.abs(score - bestScore) <= 1e-9 &&
        hueDistance(h, POOL_BASE_HUE) < hueDistance(bestHue, POOL_BASE_HUE)
      ) {
        bestHue = h;
      }
    }
    return bestHue;
  }

  // 由种子色生成一套完整 token（mode: "light" | "dark"；alphaOverrides 覆盖玻璃化透明度）
  function buildTokens(seedHex, mode, alphaOverrides) {
    const light = mode === "light";
    const seedRgb = hexToRgb(seedHex);
    const [seedH, seedS] = rgbToHsl(seedRgb[0], seedRgb[1], seedRgb[2]);

    // 背景族：种子色向白（亮）/黑（暗）按比例混合，面体带玻璃化透明度。
    // 对比度核算以不透明基色为准；壁纸透出对观感的补偿由 UI 层阅读透明度兜底。
    const surfaceOpaque = {};
    const surfaceTokens = {};
    const targetRgb = light ? [255, 255, 255] : [0, 0, 0];
    for (const [key, spec] of Object.entries(SURFACE_SPEC[mode])) {
      const mixed = mixRgb(seedRgb, targetRgb, spec.ratio);
      surfaceOpaque[key] = mixed;
      let alpha = spec.alpha;
      const override = alphaOverrides && alphaOverrides[key];
      if (typeof override === "number" && Number.isFinite(override)) alpha = clamp(override, 0, 1);
      surfaceTokens[key] = rgba(mixed, alpha);
    }

    // 文字四档：中性基准色过对比度推拉，候选背景取页面底与卡片面
    const textBgs = [surfaceOpaque["--bg"], surfaceOpaque["--surface"]];
    const textTokens = {};
    for (const key of ["--text", "--text-2", "--text-3", "--text-4"]) {
      const target = key === "--text-4" ? CONTRAST_TARGET_WEAK : CONTRAST_TARGET;
      textTokens[key] = rgbToHex(ensureContrast(hexToRgb(TEXT_BASE[mode][key]), textBgs, target));
    }

    // 边框：种子色调向亮暗两端的发丝线
    const borderRgb = hslToRgb(seedH, seedS * 0.55, light ? 0.42 : 0.62);

    // 强调色：均衡档种子（暗色模式提亮），色相先避开三个语义色，再过对比度
    const accentHue = avoidSemanticHues(seedH);
    const accent = ensureContrast(hslToRgb(accentHue, seedS, light ? BALANCED_LIGHTNESS : 0.66), textBgs, CONTRAST_TARGET_ACCENT);
    const [accentH, accentS, accentL] = rgbToHsl(accent[0], accent[1], accent[2]);

    // 品牌渐变：浅端提亮、深端加深，深端保证白字可读
    const gradFrom = hslToRgb(accentH, accentS, clamp(accentL + 0.1, 0, 0.86));
    const gradTo = ensureContrast(
      hslToRgb(accentH, Math.min(1, accentS + 0.08), clamp(accentL - 0.12, 0.05, 0.9)),
      [[255, 255, 255]],
      CONTRAST_TARGET_ACCENT,
    );

    const semanticTokens = {};
    for (const [key, hue] of Object.entries(SEMANTIC_HUE)) {
      const c = semanticColor(hue, seedS, light);
      semanticTokens[key] = rgbToHex(c);
      semanticTokens[`${key}-soft`] = rgba(c, light ? 0.1 : 0.16);
      semanticTokens[`${key}-border`] = rgba(c, light ? 0.38 : 0.45);
    }

    const pool = hslToRgb(
      pickPoolHue([accentH, SEMANTIC_HUE["--ok"], SEMANTIC_HUE["--warn"], SEMANTIC_HUE["--danger"]]),
      clamp(0.6 + 0.3 * seedS, 0.55, 0.85),
      light ? 0.5 : 0.7,
    );

    // 阴影：种子色压暗作投影基色，透明度按亮暗取档
    const shadowRgb = mixRgb(seedRgb, [0, 0, 0], light ? 0.55 : 0.75);
    const sh = light
      ? { xs: [0.04], sm: [0.06, 0.04], md: [0.06, 0.04], lg: [0.08, 0.04] }
      : { xs: [0.35], sm: [0.45, 0.35], md: [0.55, 0.4], lg: [0.65, 0.45] };

    return {
      ...STATIC_TOKENS,
      ...surfaceTokens,
      ...textTokens,
      "--border": rgba(borderRgb, light ? 0.32 : 0.3),
      "--border-strong": rgba(borderRgb, light ? 0.5 : 0.48),
      "--divider": rgba(borderRgb, 0.16),
      "--accent": rgbToHex(accent),
      "--accent-soft": rgba(accent, light ? 0.1 : 0.16),
      "--accent-border": rgba(accent, light ? 0.38 : 0.45),
      ...semanticTokens,
      "--pool": rgbToHex(pool),
      "--pool-soft": rgba(pool, light ? 0.1 : 0.16),
      "--pool-border": rgba(pool, light ? 0.38 : 0.45),
      "--spark-line": rgbToHex(accent),
      "--spark-fill": rgba(accent, light ? 0.12 : 0.18),
      "--danger-glow": rgba(hexToRgb(semanticTokens["--danger"]), light ? 0.18 : 0.3),
      "--shadow-xs": `0 1px 2px 0 ${rgba(shadowRgb, sh.xs[0])}`,
      "--shadow-sm": `0 1px 3px 0 ${rgba(shadowRgb, sh.sm[0])}, 0 1px 2px -1px ${rgba(shadowRgb, sh.sm[1])}`,
      "--shadow-md": `0 4px 6px -1px ${rgba(shadowRgb, sh.md[0])}, 0 2px 4px -2px ${rgba(shadowRgb, sh.md[1])}`,
      "--shadow-lg": `0 10px 15px -3px ${rgba(shadowRgb, sh.lg[0])}, 0 4px 6px -4px ${rgba(shadowRgb, sh.lg[1])}`,
      "--accent-gradient": `linear-gradient(135deg, ${rgbToHex(gradFrom)} 0%, ${rgbToHex(gradTo)} 100%)`,
      "--accent-glow": light ? `0 2px 8px ${rgba(accent, 0.35)}` : `0 2px 10px ${rgba(accent, 0.45)}`,
    };
  }

  // ═══════════════════════════════════════════════
  // 入口
  // ═══════════════════════════════════════════════

  // pixels: { data: RGBA 字节数组, width, height }；options.surfaceAlpha 可按
  // { light: { "--surface": 0.9 }, dark: { ... } } 覆盖玻璃化透明度（UI 滑杆挂钩）。
  function extractTheme(pixels, options) {
    const data = pixels && pixels.data ? pixels.data : new Uint8ClampedArray(0);
    const width = pixels && pixels.width > 0 ? Math.floor(pixels.width) : 0;
    const height = pixels && pixels.height > 0 ? Math.floor(pixels.height) : 0;
    const pixelCount = Math.min(width * height, Math.floor(data.length / 4));
    const palette = pixelCount > 0 ? extractPalette(data, pixelCount) : [];
    const seed = selectSeed(palette);
    const alphaOption = options && options.surfaceAlpha;
    return {
      seed,
      light: buildTokens(seed, "light", alphaOption && alphaOption.light),
      dark: buildTokens(seed, "dark", alphaOption && alphaOption.dark),
    };
  }

  return { extractTheme };
});
