// style-lab 主题同步校验：panel.html 内嵌块（/* ===== style-lab: SLUG ===== */ 横幅）
// 必须与 panel-ui/style-lab/SLUG.css 源文件逐字一致（归一化 CRLF/LF 行尾后比对）。
// neon 已退役、按约定保留存档，不在校验范围（见 style-lab/CONTRACT.md）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const SLUGS = ["saas", "aurora", "blueprint", "sepia"];

function extractBlocks() {
  const html = readFileSync(join(root, "panel-ui", "panel.html"), "utf8").replace(/\r\n/g, "\n");
  const lines = html.split("\n");
  const marks = [];
  lines.forEach((l, i) => {
    const m = l.match(/\/\* ===== style-lab: (\w+)/);
    if (m) marks.push({ slug: m[1], line: i });
  });
  const styleEnd = lines.findIndex((l) => l.includes("</style>"));
  const blocks = new Map();
  for (let k = 0; k < marks.length; k++) {
    const { slug, line } = marks[k];
    const stop = k + 1 < marks.length ? marks[k + 1].line : styleEnd;
    blocks.set(slug, lines.slice(line + 1, stop).join("\n").replace(/\s+$/, "") + "\n");
  }
  return blocks;
}

const blocks = extractBlocks();

for (const slug of SLUGS) {
  test(`style-lab 同步：${slug}.css 与 panel.html 内嵌块逐字一致`, () => {
    const embedded = blocks.get(slug);
    assert.ok(embedded, `panel.html 缺少 /* ===== style-lab: ${slug} ===== */ 横幅块`);
    const source = readFileSync(join(root, "panel-ui", "style-lab", `${slug}.css`), "utf8")
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
