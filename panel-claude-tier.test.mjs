// Claude Code 档位映射在面板侧的形态校验：DOM 在 panel.html、绑定与渲染在
// panel.js、样式在 panel.css。与卡片类测试同范式（读源码断言结构），因为这一项
// 的正确性判据是「四行各自能存、存坏能回滚、且不带任何主题特化」。
//
// 文案面钉的是用户拍板过的极简形态：卡头 Claude Code + 四行档位名 + placeholder
// 「留空不接管」，卡内不加任何解释句。日后要加说明句必须连这份断言一起改。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, "panel-ui", "panel.html"), "utf8").replace(/\r\n/g, "\n");
const js = readFileSync(join(root, "panel-ui", "panel.js"), "utf8").replace(/\r\n/g, "\n");
const css = readFileSync(join(root, "panel-ui", "panel.css"), "utf8").replace(/\r\n/g, "\n");

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${label} 缺少起点 ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${label} 缺少终点 ${endMarker}`);
  return source.slice(start, end);
}

// 「通用」子页的 DOM 片段：从面板容器起，到下一个子页（自动路由）容器前。
const generalPanel = sliceBetween(
  html,
  '<div class="settings-panel" id="settingsPanelGeneral"',
  '<div class="settings-panel" id="settingsPanelRoute"',
  "设置页「通用」",
);
const tierCard = sliceBetween(generalPanel, "<!-- Claude Code 档位映射", "\n    </div>\n\n    <!--", "档位映射卡");

describe("panel.html · Claude Code 档位映射卡", () => {
  it("卡头标题是 Claude Code，且带标准卡头件", () => {
    assert.match(tierCard, /class="card-header"/);
    assert.match(tierCard, /class="card-title"/);
    assert.match(tierCard, /<\/svg>\s*\n\s*Claude Code\s*\n\s*<\/h2>/);
  });

  it("四行按 Sonnet / Opus / Fable / Haiku 排列，控件 id 各自唯一", () => {
    const titles = [...tierCard.matchAll(/class="modal-item-title">([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(titles, ["Sonnet", "Opus", "Fable", "Haiku"]);
    for (const tier of ["Sonnet", "Opus", "Fable", "Haiku"]) {
      const id = `claudeTier${tier}Input`;
      assert.equal((html.match(new RegExp(`id="${id}"`, "g")) ?? []).length, 1, `${id} 必须恰好出现一次`);
    }
  });

  it("每行都是可输入的下拉：共用 datalist + 留空即不接管的占位文案", () => {
    const inputs = [...tierCard.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
    assert.equal(inputs.length, 4);
    for (const input of inputs) {
      assert.match(input, /list="claudeTierModelOptions"/);
      assert.match(input, /placeholder="留空不接管"/);
      assert.match(input, /type="text"/);
      assert.match(input, /autocomplete="off"/);
      assert.match(input, /class="modal-number settings-tier-input"/);
    }
    assert.equal((html.match(/<datalist id="claudeTierModelOptions">/g) ?? []).length, 1);
  });

  it("极简形态：卡内不出现任何解释句，只留档位名与控件", () => {
    assert.equal(tierCard.includes("modal-item-desc"), false);
    assert.equal(tierCard.includes("settings-tier-hint"), false);
  });
});

describe("panel.js · 逐行即改即存与回滚", () => {
  it("四行各自绑定 change 与回车，落到带档位名的保存调用", () => {
    const block = sliceBetween(js, "for (const [tier, input] of Object.entries(claudeTierInputs))", "\n  }\n", "档位行绑定");
    assert.match(block, /input\.onchange = \(\) => persistClaudeTier\(tier, input\.value\)/);
    assert.match(block, /e\.key === "Enter"/);
    assert.match(block, /persistClaudeTier\(tier, input\.value\)/);
  });

  it("PATCH 只带本次改动的那一档，其余三档不受牵连", () => {
    assert.match(js, /api\("POST", "\/api\/settings", \{ claudeTierMappings: \{ \[tier\]: next \} \}\)/);
  });

  it("空值即清除该档位，保存成功与失败都有反馈、失败回滚到原值", () => {
    const persist = sliceBetween(js, "async function persistClaudeTier(", "\n    for (const [tier, input]", "persistClaudeTier");
    assert.match(persist, /if \(next\) optimistic\[tier\] = next;\s*\n\s*else delete optimistic\[tier\];/);
    assert.match(persist, /toast\("档位映射保存失败", true\)/);
    assert.match(persist, /const previous = claudeTierMappings\[tier\] \?\? "";/);
    assert.match(persist, /if \(previous\) claudeTierMappings\[tier\] = previous;/);
    // 服务端归一值是最终真相（空行删键、未知档位名丢弃都在服务端）。
    assert.match(persist, /d\.settings\?\.claudeTierMappings/);
  });

  it("在存的那一行不被轮询回灌覆盖，其余行照常同步", () => {
    assert.match(js, /const anyClaudeTierSaving = \(\) => Object\.values\(claudeTierSaving\)\.some\(Boolean\);/);
    const hydrate = sliceBetween(js, "// 档位映射按服务端归一值回灌", "\n      } catch {}", "档位回灌");
    assert.match(hydrate, /if \(!anyClaudeTierSaving\(\)\) \{/);
    assert.match(hydrate, /claudeTierMappings = \{ \.\.\.\(d\.settings\?\.claudeTierMappings \?\? \{\}\) \};/);
    const apply = sliceBetween(js, "function applyClaudeTierUi()", "\n    }\n", "applyClaudeTierUi");
    assert.match(apply, /if \(claudeTierSaving\[tier\]\) continue;/);
  });

  it("下拉选项取 storeRows 同源（号池出合并行、成员并集），值是中继认得的完整模型名", () => {
    const render = sliceBetween(js, "function renderClaudeTierOptions()", "\n    async function persistClaudeTier(", "renderClaudeTierOptions");
    assert.match(render, /for \(const row of storeRows\(\)\)/);
    assert.match(render, /anthropic\/\$\{row\.id\}\/\$\{modelId\}/);
    assert.match(render, /if \(seen\.has\(wireId\)\) continue;/);
    // 名称来自用户自填的渠道/模型显示名，进 DOM 与属性都必须过转义。
    assert.match(render, /value="\$\{esc\(wireId\)\}"/);
    assert.match(render, /">\$\{esc\(`\[\$\{label\}\] \$\{shown\}`\)\}<\/option>/);
  });

  it("进「通用」子页刷新 store 并在落地后重生成选项，拉取失败保留旧选项", () => {
    const tab = sliceBetween(js, "// 「通用」的档位映射下拉同样以 store state 为源", "\n      if (which === \"about\")", "子页钩子");
    assert.match(tab, /if \(which === "general"\) refreshStoreState\(\)\.then\(renderClaudeTierOptions, \(\) => \{\}\);/);
  });
});

describe("panel.css · 档位行只管版式", () => {
  it("新增类不引入任何颜色取值，因此主题片段无需特化", () => {
    const rule = sliceBetween(css, ".settings-tier-input {", "\n  }\n", ".settings-tier-input");
    assert.equal(/(background|border|color|outline|box-shadow)\s*:/.test(rule), false);
    assert.match(rule, /width: min\(320px, 46vw\)/);
    assert.match(rule, /text-align: left/);
  });

  it("「通用」结构注释与四张卡的实际形态一致", () => {
    assert.match(css, /「通用」分组：六项按语义分四张卡/);
    assert.match(html, /「通用」：六项按语义分四张卡/);
  });
});
