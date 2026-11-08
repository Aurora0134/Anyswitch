// SEC-P0-001 回归：escapeHtml 必须转义引号。模型 id 等外部输入会经
// data-mid="${escapeHtml(mid)}" 一类属性插值进 innerHTML；二轮审计在真实
// Chrome 里复现过「只转 & < >」时 payload 模型 id 可以闭引号注入
// onmouseover/onfocus 事件属性并执行。这里从 panel.js 原文取样生产
// escapeHtml 与生产 store 模型行模板，钉三件事：引号进实体、& 先行的
// 转义顺序不双重转义、模板产物的属性值恰为转义结果且无裸引号与尖括号。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractPanelFn } from "../test-helpers/extract-panel-fn.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const panelJs = readFileSync(join(root, "panel-ui", "panel.js"), "utf8");

// 上轮复现留档的 payload 模型 id（前三条照抄复现证据，末条为通用属性逃逸形）
const PAYLOADS = [
  `pwn" onmouseover="globalThis.__pwned=1`,
  `x" onmouseover="document.title='EXEC-mouseover'`,
  `pwn" autofocus onfocus="fetch('/hit?via=autofocus')"`,
  `q"><img src=x onerror=alert(1)>`,
];

// 生产 escapeHtml 原文取样执行（取样惯例同 extract-panel-fn）
const escapeHtml = new Function(`${extractPanelFn("escapeHtml", "s")}\n return escapeHtml;`)();

// 生产 store 模型行模板原文摘取：起点钉模板头、终点钉 </label>`;，模板内
// 自由变量 escapeHtml/mid/checked/badges/isNew 由参数注入
const template = panelJs.match(/return `\r?\n        <label class="store-model-row[\s\S]*?<\/label>`;/);
assert.ok(template, "panel.js 的 store 模型行模板必须能按原文摘出");
const renderModelRow = new Function("escapeHtml", "mid", "checked", "badges", "isNew", template[0]);

describe("escapeHtml 引号转义（SEC-P0-001）", () => {
  it("payload 过 escapeHtml 后无裸引号与尖括号，引号进实体", () => {
    for (const p of PAYLOADS) {
      const out = escapeHtml(p);
      assert.ok(!out.includes('"'), `双引号必须转义，实际输出：${out}`);
      assert.ok(!out.includes("'"), `单引号必须转义，实际输出：${out}`);
      assert.ok(!/[<>]/.test(out), `尖括号必须转义，实际输出：${out}`);
      assert.ok(out.includes("&quot;"), `双引号实体必须是 &quot;，实际输出：${out}`);
    }
  });

  it("转义顺序不双重转义：& 先行，产出的实体不被再加工", () => {
    assert.equal(escapeHtml("&"), "&amp;");
    // 引号产出的 & 不能被再转一层；实体样文本按普通文本处理、不放行成引号
    assert.equal(escapeHtml(`"`), "&quot;");
    assert.equal(escapeHtml(`'`), "&#39;");
    assert.equal(escapeHtml("&amp;"), "&amp;amp;");
    assert.equal(escapeHtml("&quot;"), "&amp;quot;");
    assert.equal(escapeHtml("<>&\"'"), "&lt;&gt;&amp;&quot;&#39;");
  });

  it("生产模板行拼 payload：data-mid 属性值恰为转义产物，无裸引号与 <", () => {
    for (const p of PAYLOADS) {
      const row = renderModelRow(escapeHtml, p, false, [], false);
      const values = [...row.matchAll(/data-mid="([^"]*)"/g)].map((m) => m[1]);
      assert.equal(values.length, 2, "label 与 checkbox 各有一处 data-mid");
      for (const v of values) {
        assert.equal(v, escapeHtml(p), `属性值必须恰为 escapeHtml(payload)，实际：${v}`);
        assert.ok(!v.includes('"'), "属性值内不得有裸双引号");
        assert.ok(!v.includes("<"), "属性值内不得有裸 <");
      }
    }
  });
});
