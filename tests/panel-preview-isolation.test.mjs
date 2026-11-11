// 「自定义」主题窗口预览的皮肤隔离测试（静态面）。
// 预览是「壁纸主题生效时真实看板」的镜像克隆（panel.js 的 captureMirrorInto），克隆体位于
// :root 之下，所以当前静态皮肤的规则与私有 token 天然会命中/继承进去，预览就失真。本文件
// 守两条隔离：
// 一、@scope 收边：panel.css 里凡以 saas/aurora/sepia 字面量键控的皮肤规则，必须落在
//     `@scope (…) to (.wallpaper-preview)` 内。唯一例外是 `:root` 上只声明自定义属性的
//     皮肤 token 规则——自定义属性靠继承下发，@scope 管不到继承，收边无意义。
// 二、私有 token：`.wallpaper-preview` 上按壁纸主题生效时真实看板的 computed 值逐项补齐
//     皮肤私有 token（基座段有定义的抄基座段，没有的显式 initial）。
// 口径说明：
// - 作用域起点必须覆盖规则自身的皮肤键：写错皮肤（如 sepia 规则包进 saas 作用域）会让该条
//   在真实看板上失效，属于「静默丢样式」，必须拦。
// - token 取值与基座段 + 壁纸主题覆盖逐项对账：改基座段不改隔离层即为红。
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WallpaperTheme from "../panel-ui/wallpaper-theme.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const panelCss = readFileSync(join(rootDir, "panel-ui", "panel.css"), "utf8").replace(/\r\n/g, "\n");
const panelHtml = readFileSync(join(rootDir, "panel-ui", "panel.html"), "utf8");
const SLUGS = ["saas", "aurora", "sepia"];
const PREVIEW = ".wallpaper-preview";
// 皮肤私有 token：皮肤片段里出现的自定义属性 − 取色引擎派生的公共 token 全集
const ENGINE_KEYS = (() => {
  const flat = { data: new Uint8ClampedArray(16 * 16 * 4).fill(120), width: 16, height: 16 };
  const theme = WallpaperTheme.extractTheme(flat);
  return new Set([...Object.keys(theme.light), ...Object.keys(theme.dark)]);
})();

// ═══════════════════════════════════════════════
// 极简 CSS 结构解析：剥注释后按 {...} 切规则，记录每条规则的 @ 帧链与行号
// ═══════════════════════════════════════════════
function parseCss(text) {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const rules = [];
  const frames = [];
  let buf = "", bufLine = 1, line = 1, bodyStart = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "\n") { line++; buf += ch; continue; }
    if (!buf.trim() && ch.trim()) bufLine = line;
    if (ch === "{") {
      frames.push({ pre: buf.trim().replace(/\s+/g, " "), line: bufLine, bodyStart: i + 1 });
      buf = "";
    } else if (ch === "}") {
      const frame = frames.pop();
      if (frame && !frame.pre.startsWith("@")) {
        rules.push({
          chain: frames.map((f) => f.pre),
          sel: frame.pre,
          line: frame.line,
          body: css.slice(frame.bodyStart, i),
        });
      }
      buf = "";
    } else if (ch === ";") {
      buf = "";
    } else {
      buf += ch;
    }
  }
  return rules;
}
const RULES = parseCss(panelCss);
function scopeFrame(pre) {
  const m = pre.match(/^@scope\s*\((.*)\)\s*to\s*\((.*)\)$/);
  return m ? { start: m[1].trim(), end: m[2].trim() } : null;
}
function declMap(body) {
  const map = new Map();
  for (const d of body.split(";")) {
    const m = d.trim().match(/^(--[a-z0-9-]+)\s*:\s*([\s\S]+)$/);
    if (m) map.set(m[1], m[2].trim().replace(/\s+/g, " "));
  }
  return map;
}
// 通用声明解析（自定义属性之外也收）：font / color 这类继承型属性用
function declPairs(body) {
  const map = new Map();
  for (const d of body.split(";")) {
    const m = d.trim().match(/^([a-z-]+)\s*:\s*([\s\S]+)$/);
    if (m) map.set(m[1], m[2].trim().replace(/\s+/g, " "));
  }
  return map;
}
const selectorList = (sel) => sel.split(",").map((s) => s.trim()).filter(Boolean);
const skinKeys = (sel) => [...sel.matchAll(/data-style="(saas|aurora|sepia)"/g)].map((m) => m[1]);

// ═══════════════════════════════════════════════
// 一、@scope 收边
// ═══════════════════════════════════════════════
describe("皮肤规则的 @scope 收边", () => {
  it("panel.css 的每个 @scope 终点都恰为 .wallpaper-preview", () => {
    const frames = new Set();
    for (const r of RULES) for (const pre of r.chain) if (pre.startsWith("@scope")) frames.add(pre);
    assert.ok(frames.size > 0, "panel.css 找不到任何 @scope ——收边外壳缺失");
    for (const pre of frames) {
      const scope = scopeFrame(pre);
      assert.ok(scope, `@scope 写法不可解析：${pre}`);
      assert.equal(scope.end, PREVIEW, `@scope 终点应恰为 ${PREVIEW}，实为 ${scope.end}`);
    }
  });

  it("静态皮肤键控规则一律收边（:root 上的皮肤 token 定义除外）", () => {
    const offenders = [];
    for (const r of RULES) {
      if (skinKeys(r.sel).length === 0) continue;
      const inPreviewScope = r.chain.some((pre) => {
        const scope = pre.startsWith("@scope") ? scopeFrame(pre) : null;
        return Boolean(scope && scope.end === PREVIEW);
      });
      if (inPreviewScope) continue;
      // 例外：主语就是 :root 本身（皮肤 token 定义层）。@scope 的作用域不含作用域根自身，
      // 这类规则收进 @scope 会连 token 一起失效（实测 Chrome 157），只能留在块外。
      const rootTokenRule = selectorList(r.sel).every((s) => /^:root(\[[^\]]+\]|:not\([^)]*\))*$/.test(s));
      if (rootTokenRule) continue;
      offenders.push(`panel.css:${r.line} ${r.sel.slice(0, 120)}`);
    }
    assert.deepEqual(offenders, [],
      "以下皮肤键控规则没有收边到 @scope (…) to (.wallpaper-preview)：" + JSON.stringify(offenders, null, 2) +
      "——它们是「自定义」窗口预览吃到当前皮肤的直接来源；主语就是 :root 的皮肤 token 定义才是例外");
  });

  it("作用域起点覆盖规则自身的皮肤键（写错皮肤会让该条在真实看板失效）", () => {
    const mismatched = [];
    for (const r of RULES) {
      const keys = skinKeys(r.sel);
      if (keys.length === 0) continue;
      for (const pre of r.chain) {
        if (!pre.startsWith("@scope")) continue;
        const scope = scopeFrame(pre);
        if (!scope || scope.end !== PREVIEW) continue;
        for (const key of keys) {
          if (!scope.start.includes(`data-style="${key}"`)) {
            mismatched.push(`panel.css:${r.line} 规则键 ${key} 未出现在作用域起点 ${scope.start}`);
          }
        }
      }
    }
    assert.deepEqual(mismatched, [], "作用域起点与规则皮肤键不一致：" + JSON.stringify(mismatched, null, 2));
  });

  it("预览视口不再被皮肤换底规则命中（.wallpaper-preview-viewport 保持透明底）", () => {
    assert.ok(panelHtml.includes('class="settings-mirror-viewport wallpaper-preview-viewport"'),
      "panel.html 的预览视口应同时带 settings-mirror-viewport 类——本测试的前提");
    assert.ok(panelCss.includes(".wallpaper-preview-viewport { display: none; position: relative; background: transparent; }"),
      "预览视口基座应为透明底（皮肤换底规则收边后，壁纸图才透得出来）");
    const hit = RULES.filter((r) => skinKeys(r.sel).length > 0 && r.sel.includes(".settings-mirror-viewport"))
      .filter((r) => !r.chain.some((pre) => {
        const scope = pre.startsWith("@scope") ? scopeFrame(pre) : null;
        return Boolean(scope && scope.end === PREVIEW);
      }))
      .map((r) => `panel.css:${r.line} ${r.sel.slice(0, 120)}`);
    assert.deepEqual(hit, [], "皮肤键控的 .settings-mirror-viewport 换底规则必须收边：" + JSON.stringify(hit, null, 2));
  });
});

// ═══════════════════════════════════════════════
// 二、私有 token 隔离层
// ═══════════════════════════════════════════════

// 壁纸主题生效时 :root 上的 token 取值：基座段 → 皮肤不参与 → 壁纸主题覆盖。
// 六类 :root 规则按特异性从低到高叠（本文件里层叠次序与源序一致）：基座亮色、壁纸覆盖、
// 基座暗色、壁纸暗色；两条暗色变体（显式 data-theme="dark" 与 prefers-color-scheme）
// 内容必须相同，这里取并集校验。
function wallpaperRootTokens() {
  const light = new Map();
  const dark = new Map();
  const isDarkMedia = (r) => r.chain.some((pre) => pre.includes("prefers-color-scheme: dark"));
  const passes = [
    [light, (r) => r.chain.length === 0 && r.sel === ":root"],
    [light, (r) => r.chain.length === 0 && r.sel === ':root[data-style="wallpaper"]'],
    [dark, (r) => r.chain.length === 0 && r.sel === ':root[data-theme="dark"]'],
    [dark, (r) => isDarkMedia(r) && r.sel === ':root:not([data-theme="light"]):not([data-theme="dark"])'],
    [dark, (r) => r.chain.length === 0 && r.sel === ':root[data-style="wallpaper"][data-theme="dark"]'],
    [dark, (r) => isDarkMedia(r) && r.sel === ':root[data-style="wallpaper"]:not([data-theme="light"]):not([data-theme="dark"])'],
  ];
  for (const [target, match] of passes) {
    for (const r of RULES) if (match(r)) for (const [k, v] of declMap(r.body)) target.set(k, v);
  }
  return { light, dark };
}
const ROOT_TOKENS = wallpaperRootTokens();
// 皮肤私有 token 全集：三份片段里出现过的自定义属性，去掉引擎派生的公共 token
const SKIN_ONLY = (() => {
  const set = new Set();
  for (const slug of SLUGS) {
    const src = readFileSync(join(rootDir, "panel-ui", "style-lab", `${slug}.css`), "utf8");
    for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:/g)) if (!ENGINE_KEYS.has(m[1])) set.add(m[1]);
  }
  return [...set].sort();
})();
// 隔离层三条规则：亮色 / 显式暗色 / 跟随系统暗色。取规则放在断言内部，
// 缺失时按测试逐条报红，而不是整个文件在模块求值阶段挂掉。
function isolationRule(selector, wantMedia) {
  const pureTokens = (r) => {
    const decls = r.body.split(";").map((d) => d.trim()).filter(Boolean);
    return decls.length > 0 && decls.every((d) => d.startsWith("--"));
  };
  const found = RULES.filter((r) => r.sel === selector && pureTokens(r)
    && (wantMedia ? r.chain.some((p) => p.includes("prefers-color-scheme: dark")) : r.chain.length === 0));
  assert.equal(found.length, 1, `隔离层规则应恰有一条：${selector}（实为 ${found.length} 条）`);
  return found[0];
}
const lightRule = () => isolationRule(PREVIEW, false);
const darkRule = () => isolationRule(':root[data-theme="dark"] .wallpaper-preview', false);
const darkMediaRule = () => isolationRule(':root:not([data-theme="light"]):not([data-theme="dark"]) .wallpaper-preview', true);
const lightTokens = () => declMap(lightRule().body);
const darkTokens = () => declMap(darkRule().body);
const darkMediaTokens = () => declMap(darkMediaRule().body);
const expectedLight = (key) => ROOT_TOKENS.light.get(key) ?? "initial";
const expectedDark = (key) => ROOT_TOKENS.dark.get(key) ?? ROOT_TOKENS.light.get(key) ?? "initial";
const effectiveDark = (key) => darkTokens().get(key) ?? lightTokens().get(key);

describe("预览私有 token 隔离层", () => {
  it("隔离层不落在任何 @scope 内（否则对预览元素本身不生效）", () => {
    for (const rule of [lightRule(), darkRule(), darkMediaRule()]) {
      assert.deepEqual(rule.chain.filter((p) => p.startsWith("@scope")), [],
        `panel.css:${rule.line} 的 ${rule.sel} 落在 @scope 内：隔离层会失效`);
    }
  });

  it("隔离层恰好覆盖皮肤私有 token 全集（不多不少）", () => {
    assert.deepEqual([...lightTokens().keys()].sort(), SKIN_ONLY,
      "亮色隔离层声明的 token 与「皮肤片段出现过的自定义属性 − 引擎公共 token」不一致：" +
      "皮肤新增私有 token 必须同步补进 .wallpaper-preview 隔离层；删掉的要一并撤掉");
    for (const key of darkTokens().keys()) {
      assert.ok(lightTokens().has(key), `暗色隔离层多出亮色没有的 token：${key}`);
    }
  });

  it("亮色取值 = 壁纸主题生效时真实看板的取值", () => {
    const drift = [];
    for (const [key, value] of lightTokens()) {
      if (value !== expectedLight(key)) drift.push(`${key}: 隔离层 ${value} ≠ 壁纸态 ${expectedLight(key)}`);
    }
    assert.deepEqual(drift, [], "亮色隔离层与基座段/壁纸覆盖漂移：" + JSON.stringify(drift, null, 2));
  });

  it("暗色取值 = 壁纸主题生效时真实看板的取值，且两条暗色变体逐字相同", () => {
    assert.deepEqual([...darkMediaTokens().entries()], [...darkTokens().entries()],
      "两条暗色变体（显式 data-theme=\"dark\" 与 prefers-color-scheme）必须逐字相同");
    const drift = [];
    for (const key of lightTokens().keys()) {
      if (effectiveDark(key) !== expectedDark(key)) drift.push(`${key}: 隔离层 ${effectiveDark(key)} ≠ 壁纸态 ${expectedDark(key)}`);
    }
    assert.deepEqual(drift, [], "暗色隔离层与基座段/壁纸覆盖漂移：" + JSON.stringify(drift, null, 2));
  });
});

// 继承型属性：基座 body 的 font/color 已按当前皮肤解析成计算值，预览子树继承的是那份值，
// 注入 token 改不回来（实测 sepia 下预览字体仍是 Helvetica）。预览容器必须按壁纸态重设。
describe("预览继承型属性", () => {
  it("预览容器重设 font / color，取值与基座 body 规则逐字相同", () => {
    const bodyRule = RULES.find((r) => r.sel === "body" && r.chain.length === 0);
    assert.ok(bodyRule, "panel.css 找不到基座 body 规则（本测试的对照基准）");
    const baseDecls = declPairs(bodyRule.body);
    for (const prop of ["font", "color"]) {
      assert.ok(baseDecls.has(prop), `基座 body 规则应声明 ${prop}`);
    }
    const previewRule = RULES.filter((r) => r.sel === PREVIEW && r.chain.length === 0)
      .find((r) => declPairs(r.body).has("font"));
    assert.ok(previewRule, `.wallpaper-preview 缺少继承型属性重设规则（font / color）：预览会继承当前皮肤已解析的字体与文字色`);
    const decls = declPairs(previewRule.body);
    for (const prop of ["font", "color"]) {
      assert.equal(decls.get(prop), baseDecls.get(prop),
        `预览容器的 ${prop} 必须与基座 body 同名同值（壁纸主题不改这两项）：` +
        `隔离层 ${JSON.stringify(decls.get(prop))} ≠ 基座 ${JSON.stringify(baseDecls.get(prop))}`);
    }
  });
});
