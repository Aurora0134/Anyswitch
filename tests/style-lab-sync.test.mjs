// style-lab 主题同步校验：panel.css 内嵌块（/* ===== style-lab: SLUG ===== */ 横幅）
// 必须与 panel-ui/style-lab/SLUG.css 源文件逐字一致（归一化 CRLF/LF 行尾后比对）。
// 在册主题清单＝静态三皮肤（saas/aurora/sepia，走本文件的横幅块与源文件校验）＋
// 动态第四项 wallpaper（「自定义」：token 由取色引擎按背景图运行时注入，无静态
// 片段，不进本文件的块校验）。panel.html 的 PANEL_STYLES 与 panel.js 的 STYLES
// 必须是「三静态 + wallpaper」四项；panel.css 横幅块集合仍恰为三静态——已退役
// 主题的横幅块残留、在册静态皮肤缺块、同名横幅重复都会红。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const SLUGS = ["saas", "aurora", "sepia"];
// 动态主题：不进 style-lab 静态片段机制，但占用主题清单第四项
const DYNAMIC_STYLES = ["wallpaper"];

test("在册主题清单两处一致：panel.html PANEL_STYLES = panel.js STYLES = 三静态皮肤 + 动态第四项", () => {
  const html = readFileSync(join(root, "../panel-ui", "panel.html"), "utf8");
  const js = readFileSync(join(root, "../panel-ui", "panel.js"), "utf8");
  const htmlList = html.match(/var PANEL_STYLES = (\[[^\]]*\]);/);
  assert.ok(htmlList, "panel.html 找不到 var PANEL_STYLES = [...] ——清单手写处变更后请同步本测试的解析");
  const jsList = js.match(/const STYLES = (\[[^\]]*\]);/);
  assert.ok(jsList, "panel.js 找不到 const STYLES = [...] ——清单手写处变更后请同步本测试的解析");
  const expected = [...SLUGS, ...DYNAMIC_STYLES];
  const htmlStyles = JSON.parse(htmlList[1]);
  const jsStyles = JSON.parse(jsList[1]);
  assert.deepEqual(htmlStyles, expected,
    `panel.html 的 PANEL_STYLES ${JSON.stringify(htmlStyles)} 与在册清单 ${JSON.stringify(expected)} 不一致：` +
    "静态皮肤变更须同步 SLUGS 与 style-lab/ 源文件；动态项变更须同步 DYNAMIC_STYLES");
  assert.deepEqual(jsStyles, expected,
    `panel.js 的 STYLES ${JSON.stringify(jsStyles)} 与在册清单 ${JSON.stringify(expected)} 不一致：` +
    "清单各手写副本必须同步");
  // 动态主题不得有 style-lab 源文件：它的 token 是运行时注入的，静态片段没有意义
  for (const slug of DYNAMIC_STYLES) {
    assert.ok(!existsSync(join(root, "../panel-ui", "style-lab", `${slug}.css`)),
      `动态主题 ${slug} 不应存在 style-lab/${slug}.css 源文件`);
  }
});

function extractBlocks() {
  const css = readFileSync(join(root, "../panel-ui", "panel.css"), "utf8").replace(/\r\n/g, "\n");
  const lines = css.split("\n");
  const marks = [];
  lines.forEach((l, i) => {
    const m = l.match(/\/\* ===== style-lab: (\w+)/);
    if (m) marks.push({ slug: m[1], line: i });
  });
  // 纯 CSS 文件没有 </style>：末块终点 = 开屏样式段（文件头注释里的 ② 段）的首条规则，
  // 即原主 <style> 块结尾的等价边界；横幅块全部位于主样式段内，开屏规则不属于任何主题块。
  // 锚点只认「去缩进后行首 #panelStartup 紧跟 {」，容忍缩进、括号内空白与单行重排
  // （如 #panelStartup{display:none}），但排除 #panelStartup[...] 复合选择器。
  // 找不到时必须显式报错并指认锚点失效——带着 -1 继续切片会把 panel.css 尾部整段
  // 伪差异的红记到 sepia.css 头上，误导排查方向。
  const styleEnd = lines.findIndex((l) => /^#panelStartup\s*\{/.test(l.trim()));
  if (styleEnd === -1) {
    throw new Error(
      "panel.css 找不到开屏样式段首条规则（顶层 #panelStartup { ... }）：末块边界锚点失效。" +
      "这是 panel.css 开屏段结构变化，不是主题块漂移——请按新结构更新本测试的 styleEnd 锚点",
    );
  }
  if (marks.length && marks[marks.length - 1].line >= styleEnd) {
    throw new Error(
      "panel.css 的 style-lab 横幅块出现在开屏样式段边界之后：横幅块应全部位于主样式段内，" +
      "末块边界失去意义——请先核对横幅块位置，再更新本测试的边界锚点",
    );
  }
  const blocks = new Map();
  for (let k = 0; k < marks.length; k++) {
    const { slug, line } = marks[k];
    const stop = k + 1 < marks.length ? marks[k + 1].line : styleEnd;
    blocks.set(slug, lines.slice(line + 1, stop).join("\n").replace(/\s+$/, "") + "\n");
  }
  return { blocks, slugs: marks.map((m) => m.slug) };
}

test("panel.css 横幅块恰为在册清单：无残留退役块、无缺块、无同名重复", () => {
  const { slugs } = extractBlocks();
  const counts = new Map();
  for (const s of slugs) counts.set(s, (counts.get(s) ?? 0) + 1);
  const dupes = [...counts].filter(([, n]) => n > 1).map(([s]) => s);
  assert.deepEqual(dupes, [],
    `panel.css 中同名横幅块重复：${JSON.stringify(dupes)}——重复块后者覆盖前者，必须去重后再跑`);
  const extra = slugs.filter((s) => !SLUGS.includes(s));
  const missing = SLUGS.filter((s) => !slugs.includes(s));
  assert.deepEqual([...slugs].sort(), [...SLUGS].sort(),
    `panel.css 横幅块与在册清单不一致：多出 ${JSON.stringify(extra)}，缺少 ${JSON.stringify(missing)}。` +
    "已退役主题的横幅块必须随退役一并删除；新增在册主题必须配套 style-lab/SLUG.css 源文件");
});

for (const slug of SLUGS) {
  test(`style-lab 同步：${slug}.css 与 panel.css 内嵌块逐字一致`, () => {
    const { blocks } = extractBlocks();
    const embedded = blocks.get(slug);
    assert.ok(embedded, `panel.css 缺少 /* ===== style-lab: ${slug} ===== */ 横幅块`);
    const srcPath = join(root, "../panel-ui", "style-lab", `${slug}.css`);
    assert.ok(existsSync(srcPath), `在册主题 ${slug} 缺少源文件 panel-ui/style-lab/${slug}.css`);
    const source = readFileSync(srcPath, "utf8")
      .replace(/\r\n/g, "\n")
      .replace(/\s+$/, "") + "\n";
    if (embedded !== source) {
      const a = embedded.split("\n");
      const b = source.split("\n");
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          assert.fail(
            `${slug} 漂移：首个差异在第 ${i + 1} 行\n` +
            `  内嵌块: ${JSON.stringify(a[i] ?? "<EOF>")}\n` +
            `  源文件: ${JSON.stringify(b[i] ?? "<EOF>")}\n` +
            `按 style-lab/CONTRACT.md 以现行生效侧为准回写另一侧后重跑`
          );
        }
      }
    }
  });
}


// ═══════════════════════════════════════════════
// 预览隔离：皮肤片段整块收在 @scope 内，终点恰为 .wallpaper-preview
// ═══════════════════════════════════════════════
// 「自定义」主题窗口的预览是壁纸看板的镜像克隆，落在 :root 之下：皮肤规则若不收边，
// 预览就会读成「当前皮肤 + 壁纸取色」。收边外壳的形态（作用域起点 = 皮肤键、终点 =
// .wallpaper-preview）由本组断言钉住，选择器本身不改写。
const PREVIEW_LIMIT = ".wallpaper-preview";

// 剥注释后切规则，记录每条规则的 @ 帧链；同时回传每个 @ 块的起止偏移
function scanCss(text) {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const rules = [];
  const atBlocks = [];
  const frames = [];
  let buf = "", bufLine = 1, line = 1, bodyStart = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "\n") { line++; buf += ch; continue; }
    if (!buf.trim() && ch.trim()) bufLine = line;
    if (ch === "{") {
      const pre = buf.trim().replace(/\s+/g, " ");
      frames.push({ pre, line: bufLine, bodyStart: i + 1, open: i });
      if (pre.startsWith("@")) atBlocks.push({ pre, line: bufLine, open: i, close: -1 });
      buf = "";
    } else if (ch === "}") {
      const frame = frames.pop();
      if (frame) {
        if (frame.pre.startsWith("@")) {
          for (let k = atBlocks.length - 1; k >= 0; k--) if (atBlocks[k].open === frame.open) { atBlocks[k].close = i; break; }
        } else {
          rules.push({ chain: frames.map((f) => f.pre), sel: frame.pre, line: frame.line });
        }
      }
      buf = "";
    } else if (ch === ";") {
      buf = "";
    } else {
      buf += ch;
    }
  }
  return { rules, atBlocks, stripped: css };
}

const scopePrelude = (slug) => `@scope (:root[data-style="${slug}"]) to (${PREVIEW_LIMIT})`;

for (const slug of SLUGS) {
  test(`预览隔离：${slug}.css 全部主题规则收在 @scope 内，终点恰为 ${PREVIEW_LIMIT}`, () => {
    const file = join(root, "../panel-ui", "style-lab", `${slug}.css`);
    assert.ok(existsSync(file), `在册主题 ${slug} 缺少源文件 panel-ui/style-lab/${slug}.css`);
    const { rules, atBlocks, stripped } = scanCss(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
    const scopes = atBlocks.filter((b) => b.pre.startsWith("@scope"));
    assert.deepEqual(scopes.map((b) => b.pre), [scopePrelude(slug)],
      `${slug}.css 必须恰有一个 @scope 外壳且终点恰为 ${PREVIEW_LIMIT}：` +
      "皮肤规则收边到预览容器之外（@scope 起点 = 皮肤键，终点 = .wallpaper-preview）");
    const scope = scopes[0];
    assert.equal(stripped.slice(scope.close + 1).trim(), "",
      `${slug}.css 的 @scope 之后还有内容：收边必须覆盖到文件末尾`);
    // 作用域只包皮肤覆盖规则：@scope 的作用域不含作用域根自身（实测 Chrome 157），
    // 把 `:root` 上的 token 定义收进去会让整份 token 失效。故块外只允许 root token 规则；
    // 块内覆盖规则必须把「:root + 皮肤键」前缀改写成 `:scope:scope`（详见 CONTRACT.md；
    // 与 base 版本的逐条等价性由 tests/panel-preview-isolation.test.mjs 校验）。
    // @keyframes 里的帧不算选择器，跳过。
    const ROOT_ONLY = /^:root(\[[^\]]+\]|:not\([^)]*\))*$/;
    const tokenRule = (r) => r.sel.split(",").map((s) => s.trim()).every((s) => ROOT_ONLY.test(s));
    const scopePrefixed = (r) => r.sel.split(",").map((s) => s.trim()).every((s) => s.startsWith(":scope"));
    const misplaced = [];
    for (const r of rules) {
      if (r.chain.some((pre) => pre.startsWith("@keyframes"))) continue;
      const inside = r.chain.includes(scope.pre);
      const isToken = tokenRule(r);
      if (inside && isToken) misplaced.push(`${slug}.css:${r.line} ${r.sel.slice(0, 80)} —— :root token 规则不能收进 @scope（会让 token 整体失效）`);
      if (inside && !scopePrefixed(r)) misplaced.push(`${slug}.css:${r.line} ${r.sel.slice(0, 80)} —— @scope 内覆盖规则必须以 :scope 开头（:scope:scope 顶替原「:root + 皮肤键」前缀）`);
      if (!inside && !isToken) misplaced.push(`${slug}.css:${r.line} ${r.sel.slice(0, 80)} —— 皮肤覆盖规则必须收进 @scope`);
    }
    assert.deepEqual(misplaced, [],
      `${slug}.css 的 @scope 边界不对：` + JSON.stringify(misplaced, null, 2));
    const tokenBlocks = rules.filter((r) => !r.chain.includes(scope.pre) && tokenRule(r));
    assert.ok(tokenBlocks.length >= 3,
      `${slug}.css 块外应至少有三段 :root token 规则（亮色 / 显式暗色 / 跟随系统暗色），实为 ${tokenBlocks.length} 段`);
    // 块外允许的 @ 块：@keyframes（不能进 @scope）与承载 token 定义的 @media；
    // 其他 @ 块（例如把覆盖规则塞进 @media 却漏在外层）一律红。
    const atOutside = atBlocks.filter((b) => b.open < scope.open || b.open > scope.close)
      .filter((b) => !b.pre.startsWith("@keyframes") && !b.pre.startsWith("@media"));
    assert.deepEqual(atOutside.map((b) => `${slug}.css:${b.line} ${b.pre}`), [],
      "\\@scope 之外只允许顶层 @keyframes 与承载 token 定义的 @media");
    const keyframesInside = atBlocks.filter((b) => b.pre.startsWith("@keyframes") && b.open > scope.open && b.open < scope.close);
    assert.deepEqual(keyframesInside.map((b) => `${slug}.css:${b.line} ${b.pre}`), [],
      "\@keyframes 不能放在 @scope 内：浏览器不会为它注册动画");
  });
}
