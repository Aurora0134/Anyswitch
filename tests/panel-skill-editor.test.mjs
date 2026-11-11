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

  it("同窗换态重播弹窗入场：已开才重播，冲刷只为中断动画", () => {
    const modal = extractFn("showSkillsModal");
    // 判定必须在挂 .show 之前：之后判永远为真，每次开窗都会多播一遍
    const readAt = modal.indexOf('const wasOpen = $("skillsModal").classList.contains("show")');
    const showAt = modal.indexOf('$("skillsModal").classList.add("show")');
    assert.ok(readAt >= 0, "必须记录调用前是否已开");
    assert.ok(showAt > readAt, "已开判定前置于 .show");
    assert.match(modal, /if \(wasOpen\) replayModalCardEnter\(/);

    const replay = extractFn("replayModalCardEnter", "overlay");
    assert.match(replay, /card\.style\.animation = "none"/);
    assert.match(replay, /getComputedStyle\(card\)\.animationName/);
    assert.doesNotMatch(replay, /offsetWidth|offsetHeight/, "冲刷不逼布局");
    // 留空串还原：动画名回到级联，各皮肤变体才能自动生效
    assert.match(replay, /card\.style\.animation = ""/);
  });

  it("重播依赖的入场动画仍在 .show 上（含各皮肤变体）", () => {
    assert.match(panelCss, /\.modal-overlay\.show \.modal-card \{[^}]*animation: modal-in/);
    assert.match(panelCss, /@keyframes modal-in \{/);
    for (const style of ["saas", "aurora", "sepia"]) {
      assert.match(
        panelCss,
        new RegExp(`:scope:scope \\.modal-overlay\\.show \\.modal-card \\{[^}]*animation: ${style}-modal-in`),
        `${style} 皮肤变体缺失会让重播落到默认动画上，与开窗手感不一致`,
      );
    }
  });

  it("两层对齐的样式契约还在（隐式依赖，改动会静默错位）", () => {
    assert.match(panelCss, /\.skills-editor-highlight,\s*\n\s*\.skills-editor-input \{/);
    assert.match(panelCss, /scrollbar-gutter: stable/);
    assert.match(panelCss, /-webkit-text-fill-color: transparent/);
    assert.match(panelCss, /\.skills-modal-edit \.modal-body \{/);
  });

  it("高亮层内层 code 必须继承字体（UA 的 monospace 会压掉继承，字宽不同即错位）", () => {
    // <code> 的 UA 样式自带 font-family: monospace，优先级高于从 <pre> 继承；
    // 两层字体不同则等宽字宽不同，可见字沿行累积漂移，光标落在旁边的字上。
    const decl = panelCss.match(/\.skills-editor-highlight code \{([^}]*)\}/);
    assert.ok(decl, "必须给高亮层的 code 显式钉住字体");
    assert.match(decl[1], /font:\s*inherit|font-family:\s*inherit/);
  });

  it("选区底色必须半透明：不透明会整片盖住下层高亮文字", () => {
    // textarea 在上层、自身文字透明，选中区完全由这层底色绘制；saas / sepia 亮色的
    // --accent-soft 是实色，拿它当底色会把下层高亮层的字整片涂掉（选中即看不见字）。
    const decl = panelCss.match(/\.skills-editor-input::selection \{([^}]*)\}/);
    assert.ok(decl, "编辑层选区样式必须存在");
    assert.match(decl[1], /color-mix\([^;]*transparent\)|rgba\(/);
  });

  it("组字期间照常重绘：预输入只活在透明 textarea 里，跳过重绘等于屏上无字", () => {
    // 2026-11-04 实机反馈「中文预输入看不到、光标自己往右飞」的成因：两层分工下
    // textarea 的字是透明的，组字文本只有铺到高亮层才看得见。原按 composing 早退，
    // 理由是「重绘会打断候选框」，该说法已被无头 Chrome 的合成组字通路证伪，勿加回。
    const editor = extractFn("renderSkillBodyEditor");
    assert.doesNotMatch(editor, /composing/);
    assert.match(editor, /addEventListener\("input", schedulePaint\)/);
  });
});
