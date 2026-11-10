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
