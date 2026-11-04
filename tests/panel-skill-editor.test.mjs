// Skill 正文编辑层：高亮必须逐字符等价（只加 span、不删字符），否则透明
// textarea 与高亮层会从折行处开始错位。这里用取样执行做机器兜底，外加几条
// 接线/样式契约，避免以后把标记「优化」掉了。

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractPanelFn as extractFn } from "../test-helpers/extract-panel-fn.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const panelJs = readFileSync(join(root, "panel-ui", "panel.js"), "utf8");
const panelHtml = readFileSync(join(root, "panel-ui", "panel.html"), "utf8");
const panelCss = readFileSync(join(root, "panel-ui", "panel.css"), "utf8");

function highlighter() {
  // escapeHtml 是面板里的共享小工具，取样时连带塞进来，避免把整份 panel.js 拉进测试。
  return new Function(`
    function escapeHtml(s) {
      return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    ${extractFn("highlightSkillMarkdown", "text")}
    ${extractFn("highlightSkillMarkdownLine", "line")}
    ${extractFn("formatSkillInline", "text")}
    return highlightSkillMarkdown;
  `)();
}

// 去标签 + 还原实体 = 高亮层渲染出来的可见文字；它必须与输入逐字符相等。
function visibleText(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("highlightSkillMarkdown", () => {
  it("标题/列表/引用/加粗/斜体/代码/链接混排后逐字符等价", () => {
    const src = [
      "## 用法",
      "",
      "- 第一步：`npm test`",
      "- 第二步：**不要**跳过 *任何* 一项",
      "1. 有序项 [文档](https://example.com/a)",
      "",
      "> 引用一行",
      "",
      "```js",
      "const a = 1;",
      "```",
    ].join("\n");
    assert.equal(visibleText(highlighter()(src)), src);
  });

  it("围栏代码块里的 ** 不被当成加粗", () => {
    const html = highlighter()("```\na ** b\n```");
    assert.doesNotMatch(html, /md-tok-strong/);
    assert.match(html, /md-tok-code/);
  });

  it("HTML 只转义，不注入", () => {
    const html = highlighter()("<script>alert(1)</script>");
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.equal(visibleText(html), "<script>alert(1)</script>");
  });

  it("末尾换行与空行原样保留", () => {
    const src = "第一行\n\n第三行\n";
    assert.equal(visibleText(highlighter()(src)), src);
    assert.equal(highlighter()(""), "");
  });
});

describe("正文编辑接线", () => {
  it("读取带上 body/hash/editable，保存带上 baseHash", () => {
    const view = extractFn("viewSkillBody", "relPath");
    assert.match(view, /body: skillBodyDraftOf\(d\.body\)/);
    assert.match(view, /baseHash: d\.hash/);
    assert.match(view, /editable: d\.editable !== false/);

    const save = extractFn("saveSkillBodyDraft", "");
    assert.match(save, /\/api\/skills\/body\/save/);
    assert.match(save, /baseHash: s\.baseHash/);
    assert.match(save, /skills_body_conflict/);
    // textarea 的 value 一律 LF；三处基线都要归一，否则 CRLF 文件一进编辑就算脏
    assert.match(save, /s\.body = skillBodyDraftOf/);
    assert.match(extractFn("reloadSkillBody", ""), /s\.body = skillBodyDraftOf\(d\.body\)/);
  });

  it("共用弹窗按态切换：aux 钮、取消文案、edit 类都要复位", () => {
    const modal = extractFn("showSkillsModal");
    assert.match(modal, /auxBtn\.hidden = !auxText/);
    assert.match(modal, /cancelBtn\.textContent = cancelText \|\| "取消"/);
    assert.match(modal, /classList\.toggle\("skills-modal-edit", !!edit\)/);
    assert.match(panelHtml, /id="skillsModalAuxBtn"/);
  });

  it("查阅态隐藏重复的「取消」按钮，编辑/冲突态保持原样", () => {
    // 每次 show 都复位隐藏态，否则上一个弹窗的隐藏会泄漏到下一个
    assert.match(extractFn("showSkillsModal"), /cancelBtn\.hidden = !!hideCancel/);
    assert.match(extractFn("renderSkillBodyPreview"), /hideCancel: true/);
    assert.doesNotMatch(extractFn("renderSkillBodyEditor"), /hideCancel/);
    assert.doesNotMatch(extractFn("renderSkillBodyConflict"), /hideCancel/);
  });

  it("两层对齐的样式契约还在（隐式依赖，改动会静默错位）", () => {
    assert.match(panelCss, /\.skills-editor-highlight,\s*\n\s*\.skills-editor-input \{/);
    assert.match(panelCss, /scrollbar-gutter: stable/);
    assert.match(panelCss, /-webkit-text-fill-color: transparent/);
    assert.match(panelCss, /\.skills-modal-edit \.modal-body \{/);
  });

  it("选区底色必须半透明：不透明会整片盖住下层高亮文字", () => {
    // textarea 在上层、自身文字透明，选中区完全由这层底色绘制；saas / sepia 亮色的
    // --accent-soft 是实色，拿它当底色会把下层高亮层的字整片涂掉（选中即看不见字）。
    const decl = panelCss.match(/\.skills-editor-input::selection \{([^}]*)\}/);
    assert.ok(decl, "编辑层选区样式必须存在");
    assert.match(decl[1], /color-mix\([^;]*transparent\)|rgba\(/);
  });
});
