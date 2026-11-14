// 「自定义」主题窗口预览的皮肤隔离测试（静态面）。
// 预览是「壁纸主题生效时真实看板」的镜像克隆（panel.js 的 captureMirrorInto），克隆体位于
// :root 之下，所以当前静态皮肤的规则与私有 token 天然会命中/继承进去，预览就失真。本文件
// 守两条隔离：
// 一、@scope 收边：panel.css 里凡以 saas/aurora/sepia 字面量键控的皮肤规则，必须落在
//     `@scope (…) to (.wallpaper-preview)` 内。唯一例外是 `:root` 上只声明自定义属性的
//     皮肤 token 规则——自定义属性靠继承下发，@scope 管不到继承，收边无意义。
//     作用域不含作用域根自身：块内选择器必须把「`:root` + 皮肤键」前缀改写成
//     `:scope:scope`（两个伪类 = (0,2,0)，与原前缀特异性相等；其余条件原样保留），否则
//     整块皮肤规则在真实看板与预览里都匹配不到。改写等价性（前缀归一化后选择器逐条
//     等于 base 版本、特异性逐条相等、规则条数与多重集相等、声明逐条相同）由本文件
//     对 base 版本（218f6f9）逐文件校验，并对 base CSS 反向断言必须判红。
// 二、私有 token：`.wallpaper-preview` 上按壁纸主题生效时真实看板的 computed 值逐项补齐
//     皮肤私有 token（基座段有定义的抄基座段，没有的显式 initial）。
// 口径说明：
// - 作用域起点必须覆盖规则自身的皮肤键：写错皮肤（如 sepia 规则包进 saas 作用域）会让该条
//   在真实看板上失效，属于「静默丢样式」，必须拦。
// - token 取值与基座段 + 壁纸主题覆盖逐项对账：改基座段不改隔离层即为红。
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WallpaperTheme from "../panel-ui/wallpaper-theme.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const panelCss = readFileSync(join(rootDir, "panel-ui", "panel.css"), "utf8").replace(/\r\n/g, "\n");
const panelHtml = readFileSync(join(rootDir, "panel-ui", "panel.html"), "utf8");
const SLUGS = ["saas", "aurora", "sepia"];
const PREVIEW = ".wallpaper-preview";
// 改写前的基准版本：@scope 收边已存在但选择器仍是「:root + 皮肤键」前缀的最后一版。
// e01ede8 首个把皮肤覆盖规则收进 @scope，218f6f9 补齐 v2 集中段的收边，0b51458 才把
// 块内前缀改写成 :scope:scope——基准必须取 218f6f9：早于 e01ede8 的版本里 inScope
// 恒空、逐条比较循环零次迭代，红测只剩「找不到 @scope 块」一道闸。
// 断言逐文件比对选择器/特异性/条数/声明；git 取不到该版本时（浅克隆、源码包）跳过，
// 不用假绿代替——跳过会显示在 node --test 的 skip 计数里。
const BASE_REV = "218f6f9";
const SCOPE_FILES = [
  "panel-ui/panel.css",
  ...SLUGS.map((slug) => `panel-ui/style-lab/${slug}.css`),
];
// 有意下线的 base 皮肤规则（按 splitSelectorList 归一化后的选择器登记）。
// 本组对账防的是「@scope 改写把规则漏掉或写错」，皮肤规则本身随产品演进会合法增减：
// 登记一条＝从 base 侧扣除一条，未登记的增删照旧判红。登记必须带日期与下线理由，
// 否则它就退化成消音器。
const RETIRED_BASE_SKIN_RULES = new Map([
  ["panel-ui/panel.css", new Set([
    // 2026-11-12：终端会话栏底部渐隐改挂滚动层 mask（原渐变色块在壁纸主题的半透明栏底
    // 上会叠出第二层 alpha，暗色下读成一道黑带）。渐隐不再取栏底色，--rail-bg 的
    // saas/sepia 对调失去用点，随渐隐一并删除。
    ':root[data-ui-version="v2"][data-style="saas"] #v2Rail, :root[data-ui-version="v2"][data-style="sepia"] #v2Rail',
    // 2026-11-14：实时输出改消息提示式双态流，伪终端壳（.log-console/.log-toolbar）
    // 退场；消息卡走基座 surface/border/shadow token，皮肤不再单独覆盖。
    ':root[data-style="saas"] .log-console',
    ':root[data-style="saas"] .log-toolbar',
    ':root[data-style="aurora"] .log-console',
    ':root[data-style="aurora"] .log-toolbar',
    ':root[data-style="aurora"] .log-clear-btn',
    ':root[data-style="aurora"] .log-clear-btn:hover',
    ':root[data-style="aurora"][data-theme="dark"] .log-console',
    ':root[data-style="aurora"]:not([data-theme="light"]):not([data-theme="dark"]) .log-console',
  ])],
  ["panel-ui/style-lab/saas.css", new Set([
    // 2026-11-14：同 panel.css——实时输出伪终端壳退场，消息卡吃基座 token。
    ':root[data-style="saas"] .log-console',
    ':root[data-style="saas"] .log-toolbar',
  ])],
  ["panel-ui/style-lab/aurora.css", new Set([
    // 2026-11-14：同 panel.css——实时输出伪终端壳退场，消息卡吃基座 token。
    ':root[data-style="aurora"] .log-console',
    ':root[data-style="aurora"] .log-toolbar',
    ':root[data-style="aurora"] .log-clear-btn',
    ':root[data-style="aurora"] .log-clear-btn:hover',
    ':root[data-style="aurora"][data-theme="dark"] .log-console',
    ':root[data-style="aurora"]:not([data-theme="light"]):not([data-theme="dark"]) .log-console',
  ])],
]);
function readBaseCss(relPath) {
  try {
    return execFileSync("git", ["show", `${BASE_REV}:${relPath}`], {
      cwd: rootDir, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}
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
          endLine: line,
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

// ─── 作用域改写等价性：前缀归一化 / 特异性 / 与 base 逐条对账 ───
function skipBalanced(text, i, open, close) {
  let depth = 0;
  let quote = null;
  for (let k = i; k < text.length; k++) {
    const ch = text[k];
    if (quote) { if (ch === quote && text[k - 1] !== "\\") quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return k + 1; }
  }
  return -1;
}
// 括号感知的选择器列表切分：:is(#settingsPanelA, #settingsPanelB) 里的逗号不是分隔符
function splitSelectorList(sel) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (quote) { if (ch === quote && sel[i - 1] !== "\\") quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) { parts.push(sel.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(sel.slice(start).trim());
  return parts.filter(Boolean);
}
const DATA_STYLE_ATTR = /^\[\s*data-style\s*=\s*["'](saas|aurora|sepia)["']\s*\]$/;
// 把 base 选择器的链首「:root + 皮肤键」归一化成改写后的 :scope:scope 形态。
// 其余条件（[data-theme="dark"]、v2 块的 [data-ui-version="v2"] 等）原样保留在后。
function canonicalSelector(sel) {
  let ok = true;
  const parts = splitSelectorList(sel).map((part) => {
    if (!part.startsWith(":root")) { ok = false; return part; }
    let j = 5;
    const kept = [];
    let hasSkin = false;
    while (j < part.length) {
      const ch = part[j];
      if (ch === "[") {
        const end = skipBalanced(part, j, "[", "]");
        if (end < 0) break;
        const text = part.slice(j, end);
        if (DATA_STYLE_ATTR.test(text)) hasSkin = true;
        else kept.push(text);
        j = end;
        continue;
      }
      if (ch === ":") {
        const fn = /^:[a-zA-Z-]+\(/.exec(part.slice(j));
        if (fn) {
          const end = skipBalanced(part, j + fn[0].length - 1, "(", ")");
          if (end < 0) break;
          kept.push(part.slice(j, end));
          j = end;
          continue;
        }
        const pseudo = /^:[a-zA-Z-]+/.exec(part.slice(j));
        if (pseudo) { kept.push(pseudo[0]); j += pseudo[0].length; continue; }
        break;
      }
      break;
    }
    if (!hasSkin) ok = false;
    return ":scope:scope" + kept.join("") + part.slice(j);
  });
  return { text: parts.join(", "), ok };
}
// CSS 特异性（行内即 (a,b,c)：id / class(含属性、伪类) / 元素(含伪元素)）
function specificityOfPart(part) {
  const maxOf = (list) => list.reduce((best, cur) => {
    for (let k = 0; k < 3; k++) {
      if (cur[k] !== best[k]) return cur[k] > best[k] ? cur : best;
    }
    return best;
  }, [0, 0, 0]);
  let a = 0, b = 0, c = 0;
  let i = 0;
  while (i < part.length) {
    const ch = part[i];
    const skipWord = () => { while (i < part.length && /[-\w]/.test(part[i])) i++; };
    if (ch === "#") { a++; i++; skipWord(); continue; }
    if (ch === ".") { b++; i++; skipWord(); continue; }
    if (ch === "[") { const end = skipBalanced(part, i, "[", "]"); if (end < 0) break; b++; i = end; continue; }
    if (ch === ":") {
      if (part[i + 1] === ":") { c++; i += 2; skipWord(); if (part[i] === "(") { const end = skipBalanced(part, i, "(", ")"); i = end < 0 ? part.length : end; } continue; }
      const m = /^:([-\w]+)/.exec(part.slice(i));
      if (!m) { i++; continue; }
      const name = m[1];
      i += m[0].length;
      let arg = null;
      if (part[i] === "(") { const end = skipBalanced(part, i, "(", ")"); arg = end < 0 ? "" : part.slice(i + 1, end - 1); i = end < 0 ? part.length : end; }
      if (name === "where") continue;
      if ((name === "is" || name === "not" || name === "has" || name === "matches") && arg !== null) {
        const inner = maxOf(splitSelectorList(arg).map(specificityOfPart));
        a += inner[0]; b += inner[1]; c += inner[2];
        continue;
      }
      b++;
      continue;
    }
    if (ch === "*") { i++; continue; }
    if (/[-\w]/.test(ch)) { c++; skipWord(); continue; }
    i++;
  }
  return [a, b, c];
}
const specificityText = (sel) => splitSelectorList(sel)
  .map((part) => specificityOfPart(part).join(","))
  .sort()
  .join(" | ");
// base 版本里「主语是 :root 之后元素、且键控 saas/aurora/sepia」的皮肤覆盖规则；
// 主语就是 :root 的 token 定义不计入（它们必须留在 @scope 外）。
const ROOT_ONLY_PREFIX = /^:root(?:\[[^\]]*\]|:not\([^)]*\)|:is\([^)]*\))*(?=\s|$)/;
function isRootFacingSkinRule(sel) {
  const parts = splitSelectorList(sel);
  if (parts.length === 0) return false;
  if (!parts.every((part) => ROOT_ONLY_PREFIX.test(part) && /data-style="(saas|aurora|sepia)"/.test(part))) return false;
  const tokenOnly = parts.every((part) => {
    const m = part.match(ROOT_ONLY_PREFIX);
    return Boolean(m) && part.replace(/\s+/g, "") === m[0].replace(/\s+/g, "");
  });
  return !tokenOnly;
}
const normalizeBody = (body) => body.replace(/\s+/g, " ").trim();
function selectorMultiset(list) {
  const map = new Map();
  for (const sel of list) map.set(sel, (map.get(sel) ?? 0) + 1);
  return [...map.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
}
// 规则所在 @scope 块起点（前导）携带的皮肤键集合：块内选择器改写后不再带皮肤键，
// 皮肤归属只剩起点这一个载体。
function scopeSkinKeys(rule) {
  const keys = new Set();
  for (const pre of rule.chain) {
    if (!pre.startsWith("@scope")) continue;
    const frame = scopeFrame(pre);
    if (frame) for (const k of skinKeys(frame.start)) keys.add(k);
  }
  return keys;
}
function auditScopedCss(cssText, baseCssText, label) {
  const violations = [];
  const rules = parseCss(cssText);
  const scopeFrames = new Set();
  for (const r of rules) for (const pre of r.chain) if (pre.startsWith("@scope")) scopeFrames.add(pre);
  const inScope = rules.filter((r) => r.chain.some((pre) => pre.startsWith("@scope")));
  if (scopeFrames.size === 0) violations.push(label + ": 找不到 @scope 块");
  for (const r of inScope) {
    for (const part of splitSelectorList(r.sel)) {
      if (!part.startsWith(":scope")) violations.push(label + ":" + r.line + " @scope 内选择器未以 :scope 开头：" + part.slice(0, 120));
    }
  }
  const retired = RETIRED_BASE_SKIN_RULES.get(label) ?? new Set();
  const baseRules = baseCssText === null ? [] : parseCss(baseCssText)
    .filter((r) => isRootFacingSkinRule(r.sel))
    .filter((r) => !retired.has(splitSelectorList(r.sel).join(", ")));
  if (baseCssText !== null) {
    if (baseRules.length === 0) violations.push(label + ": base 版本找不到皮肤覆盖规则（基准失效）");
    if (inScope.length !== baseRules.length) {
      violations.push(label + ": @scope 内规则 " + inScope.length + " 条 ≠ base 皮肤覆盖规则 " + baseRules.length + " 条");
    }
    const canonicalBase = [];
    for (let i = 0; i < Math.min(inScope.length, baseRules.length); i++) {
      const b = baseRules[i];
      const s = inScope[i];
      const canonical = canonicalSelector(b.sel);
      const actual = splitSelectorList(s.sel).join(", ");
      canonicalBase.push(canonical.text);
      if (!canonical.ok) violations.push(label + ": base 第 " + (i + 1) + " 条选择器无法归一化：" + b.sel.slice(0, 140));
      // 皮肤键闸（文件头口径「作用域起点必须覆盖规则自身的皮肤键」的落实）：base 侧
      // 选择器链首的皮肤键必须全部出现在当前规则所在 @scope 块的起点里。规则被挪进
      // 别的皮肤块（或块起点写错皮肤）时，展平顺序、前缀归一化、特异性、声明全部照旧
      // 相等，只有这道闸会红——挪动正是「静默丢样式」。
      const scopeKeys = scopeSkinKeys(s);
      for (const k of skinKeys(b.sel)) {
        if (!scopeKeys.has(k)) {
          violations.push(label + ": 第 " + (i + 1) + " 条的皮肤键 " + k + " 不在其 @scope 起点内（起点皮肤：" +
            (scopeKeys.size ? [...scopeKeys].join("/") : "无") + "）——该条对 " + k + " 看板整条静默失效：" + actual.slice(0, 120));
        }
      }
      if (canonical.text !== actual) {
        violations.push(label + ": 第 " + (i + 1) + " 条前缀归一化后与 base 不一致\n  base: " + canonical.text + "\n  当前: " + actual);
      }
      if (specificityText(b.sel) !== specificityText(s.sel)) {
        violations.push(label + ": 第 " + (i + 1) + " 条特异性与 base 不一致（base " + specificityText(b.sel) + " / 当前 " + specificityText(s.sel) + "）：" + actual.slice(0, 120));
      }
      if (normalizeBody(b.body) !== normalizeBody(s.body)) {
        violations.push(label + ": 第 " + (i + 1) + " 条声明与 base 不一致：" + actual.slice(0, 120));
      }
    }
    if (JSON.stringify(selectorMultiset(canonicalBase)) !== JSON.stringify(selectorMultiset(inScope.map((r) => splitSelectorList(r.sel).join(", "))))) {
      violations.push(label + ": 选择器多重集（前缀归一化后）与 base 不一致");
    }
  }
  return { violations, inScope, baseRules };
}

// ═══════════════════════════════════════════════
// 一、@scope 收边
// ═══════════════════════════════════════════════
describe("皮肤规则的 @scope 收边", () => {
  it("panel.css 的每个 @scope 起点都带皮肤键、终点都恰为 .wallpaper-preview", () => {
    const frames = new Set();
    for (const r of RULES) for (const pre of r.chain) if (pre.startsWith("@scope")) frames.add(pre);
    assert.ok(frames.size > 0, "panel.css 找不到任何 @scope ——收边外壳缺失");
    for (const pre of frames) {
      const scope = scopeFrame(pre);
      assert.ok(scope, `@scope 写法不可解析：${pre}`);
      assert.ok(skinKeys(scope.start).length > 0,
        `@scope 起点必须携带皮肤键（saas/aurora/sepia），实为「${scope.start}」——皮肤归属只剩起点这一个载体，起点不带皮肤键等于给挪块开了门`);
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

  // 作用域起点与选择器皮肤键的一一对应（改写前口径）由下方「作用域内选择器改写」组接手：
  // 块内选择器不再带皮肤键，「前缀归一化后与 base 逐条相等」只保证选择器本身没改样，
  // 挡不住把规则挪进别的皮肤块（挪动后顺序、特异性、声明都可以照旧）——起点覆盖由
  // auditScopedCss 的皮肤键闸与防挪用例承担。

  it("预览视口不再被皮肤换底规则命中（.wallpaper-preview-viewport 保持透明底）", () => {
    assert.ok(panelHtml.includes('class="settings-mirror-viewport wallpaper-preview-viewport"'),
      "panel.html 的预览视口应同时带 settings-mirror-viewport 类——本测试的前提");
    assert.ok(/\.wallpaper-preview-viewport \{ display: none;[^}]*background: transparent;/.test(panelCss),
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
// 一·补：@scope 内选择器的 :scope 改写（与 base 版本逐条等价）
// ═══════════════════════════════════════════════
// @scope 的作用域不含作用域根自身：块内保留「:root + 皮肤键」前缀的选择器一条都匹配不到，
// 整段皮肤会静默失效。改写口径 = 只把链首的「:root + [data-style=皮肤]」换成 :scope:scope，
// 其余条件（[data-theme="dark"]、v2 块的 [data-ui-version="v2"] 等）原样保留，从而与原
// 前缀特异性逐条相等。下面对每个含 @scope 的文件与 base 版本（218f6f9）逐条对账：
// 选择器（前缀归一化后）、特异性、规则条数、选择器多重集、声明体，外加皮肤键闸——
// base 侧选择器的皮肤键必须仍在当前规则所在 @scope 块的起点内（规则被挪进别的皮肤块
// 时其余各项都可以照旧相等，只有起点对不上）。对 base CSS 反向断言必须判红——否则这
// 组断言已失去判别力。
describe("作用域内选择器改写：:scope 前缀与 base 等价", () => {
  for (const rel of SCOPE_FILES) {
    const baseCss = readBaseCss(rel);
    test(`${rel}：块内选择器以 :scope 开头，且与 base 修改前逐条等价`, {
      skip: baseCss ? false : `git 取不到 ${BASE_REV}:${rel}（浅克隆/源码包），跳过与 base 的逐条对账`,
    }, () => {
      const cssText = readFileSync(join(rootDir, rel), "utf8").replace(/\r\n/g, "\n");
      const report = auditScopedCss(cssText, baseCss, rel);
      assert.deepEqual(report.violations, [], "作用域改写与 base 不等价：" + JSON.stringify(report.violations, null, 2));
      assert.ok(report.inScope.length > 0, `${rel} 的 @scope 块里没有任何规则`);
    });
  }

  test("对 base CSS 跑同一组断言必须为红（证明断言真的在查改写）", {
    skip: readBaseCss("panel-ui/panel.css") ? false : "git 取不到 base 版本，跳过红/绿对照",
  }, () => {
    const baseCss = readBaseCss("panel-ui/panel.css");
    const report = auditScopedCss(baseCss, baseCss, `base ${BASE_REV} panel.css`);
    assert.ok(report.violations.length > 0,
      "base CSS 竟然通过了改写断言：这组断言已失去判别力（应报出「没有 @scope 块 / 规则条数不等」）");
  });

  test("把规则挪进别的皮肤 @scope 块必须判红（静默丢样式防挪闸）", {
    skip: readBaseCss("panel-ui/panel.css") ? false : "git 取不到 base 版本，跳过防挪对照",
  }, () => {
    const baseCss = readBaseCss("panel-ui/panel.css");
    const lines = panelCss.split("\n");
    // 挪动设计：取 saas/sepia 合并块的第一条规则，挪到它前面最近的 aurora 块内末尾。
    // 两块之间没有别的 @scope 内规则，尾接尾挪动后展平顺序不变——前缀归一化、特异性、
    // 声明、多重集全部照旧绿，唯一该红的是皮肤键闸（复核复现过：这条变异在闸补上前
    // violations=[]、175/175 全绿）。挪进 aurora 块后，该条对 saas/sepia 看板整条失效，
    // 正是文件头口径声明要拦的「静默丢样式」。
    const mergeRule = RULES.find((r) => {
      if (!r.chain.some((p) => p.startsWith("@scope"))) return false;
      const keys = scopeSkinKeys(r);
      return keys.size === 2 && keys.has("saas") && keys.has("sepia");
    });
    assert.ok(mergeRule, "panel.css 应存在 saas/sepia 合并 @scope 块内的规则（本用例的挪动源）");
    const auroraBefore = RULES.filter((r) => {
      const keys = scopeSkinKeys(r);
      return keys.size === 1 && keys.has("aurora") && r.line < mergeRule.line;
    });
    assert.ok(auroraBefore.length > 0, "合并块之前应存在 aurora @scope 块内的规则（本用例的挪动目标）");
    const lastAurora = auroraBefore[auroraBefore.length - 1];
    const span = mergeRule.endLine - mergeRule.line + 1;
    const moved = lines.splice(mergeRule.line - 1, span);
    lines.splice(lastAurora.endLine, 0, ...moved);
    const report = auditScopedCss(lines.join("\n"), baseCss, "panel-ui/panel.css");
    const skinGate = report.violations.filter((v) => v.includes("不在其 @scope 起点内"));
    assert.deepEqual(skinGate.map((v) => /皮肤键 (\w+)/.exec(v)[1]).sort(), ["saas", "sepia"],
      "挪进 aurora 块的 saas/sepia 规则必须报出两个皮肤键都不在起点内：" + JSON.stringify(report.violations, null, 2));
    const others = report.violations.filter((v) => !v.includes("不在其 @scope 起点内"));
    assert.deepEqual(others, [],
      "尾接尾挪动保持展平顺序——前缀归一化/条数/特异性/声明/多重集必须照旧全绿，红只能来自皮肤键闸：" +
      JSON.stringify(others, null, 2));
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
