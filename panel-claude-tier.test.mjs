// Claude Code 档位映射在面板侧的形态校验：DOM 在 panel.html、绑定与渲染在
// panel.js、样式在 panel.css。与卡片类测试同范式（读源码断言结构），因为这一项
// 的正确性判据是「四行各自能存、存坏能回滚、切页回来显示与磁盘真值一致、且不
// 带任何主题特化」。
//
// 文案面钉的是用户拍板过的原句：卡头 Claude Code + 两个开关（以 bypassPermissions
// 启动 / 接管默认模型，各带一句描述）+ 四行档位名 + placeholder「留空不接管」。
// 四行本身保持极简、不加解释句。日后要改文案必须连这份断言一起改。

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
const tierCard = sliceBetween(generalPanel, "<!-- Claude Code 卡", "\n    </div>\n\n    <!--", "档位映射卡");
const tierRows = sliceBetween(tierCard, '<div class="settings-tier-rows" id="claudeTierRows">', "\n          </div>\n        </div>", "四档行容器");

describe("panel.html · Claude Code 档位映射卡", () => {
  it("卡头标题是 Claude Code，且带标准卡头件", () => {
    assert.match(tierCard, /class="card-header"/);
    assert.match(tierCard, /class="card-title"/);
    assert.match(tierCard, /<\/svg>\s*\n\s*Claude Code\s*\n\s*<\/h2>/);
  });

  it("卡内是两个开关 + 收起容器里的四行：启动开关与接管总开关各自唯一", () => {
    assert.equal((html.match(/id="claudeBypassPermissionsToggle"/g) ?? []).length, 1, "bypassPermissions 开关 id 必须恰好出现一次");
    assert.equal((html.match(/id="claudeTierEnabledToggle"/g) ?? []).length, 1, "接管总开关 id 必须恰好出现一次");
    for (const id of ["claudeBypassPermissionsToggle", "claudeTierEnabledToggle"]) {
      assert.match(tierCard, new RegExp(`<input type="checkbox" id="${id}">`));
    }
    assert.match(tierCard, /<div class="settings-tier-rows" id="claudeTierRows">/);
  });

  it("两个开关的文案是用户拍板过的原句", () => {
    assert.match(tierCard, /<div class="modal-item-title">以 bypassPermissions 启动<\/div>/);
    assert.match(tierCard, /<div class="modal-item-desc">从 Anyswitch 启动 Claude Code 时跳过工具权限确认，Agent 可自主执行命令、修改文件。有误操作风险，请仅在可信环境开启。<\/div>/);
    assert.match(tierCard, /<div class="modal-item-title">接管默认模型<\/div>/);
    assert.match(tierCard, /<div class="modal-item-desc">开启后，Sonnet \/ Opus \/ Fable \/ Haiku 四个默认档位按下方指定模型应答；关闭后暂停接管，下方配置收起，已填写的映射保留。<\/div>/);
  });

  it("四行按 Sonnet / Opus / Fable / Haiku 排列，控件 id 各自唯一", () => {
    const titles = [...tierRows.matchAll(/class="modal-item-title">([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(titles, ["Sonnet", "Opus", "Fable", "Haiku"]);
    for (const tier of ["Sonnet", "Opus", "Fable", "Haiku"]) {
      const id = `claudeTier${tier}Input`;
      assert.equal((html.match(new RegExp(`id="${id}"`, "g")) ?? []).length, 1, `${id} 必须恰好出现一次`);
    }
  });

  it("每行都是可输入的下拉：共用 datalist + 留空即不接管的占位文案", () => {
    const inputs = [...tierRows.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
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

  it("四行保持极简形态：只有档位名与控件，不加解释句", () => {
    assert.equal(tierRows.includes("modal-item-desc"), false);
    assert.equal(tierRows.includes("settings-tier-hint"), false);
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
    // 收起态与回灌解耦：行内保存进行中也要能更新四行显隐。
    assert.match(hydrate, /\n        applyClaudeTierUi\(\);/);
    const apply = sliceBetween(js, "function applyClaudeTierUi()", "\n    }\n", "applyClaudeTierUi");
    assert.match(apply, /if \(claudeTierSaving\[tier\]\) continue;/);
  });

  it("总开关与 bypass 开关各自绑定 change，PATCH 只带本项键", () => {
    assert.match(js, /claudeBypassPermissionsToggle\.onchange = async \(\) => \{/);
    assert.match(js, /api\("POST", "\/api\/settings", \{ claudeBypassPermissions: next \}\)/);
    assert.match(js, /claudeTierEnabledToggle\.onchange = async \(\) => \{/);
    assert.match(js, /api\("POST", "\/api\/settings", \{ claudeTierMappingsEnabled: next \}\)/);
    // 两个开关都在 settingsSaving 里占位，保存期间挡住轮询回灌。
    assert.match(js, /settingsSaving = \{[^}]*claudeBypassPermissions: false, claudeTierEnabled: false/);
  });

  it("总开关关闭即收起四行，回灌与切换都走 applyClaudeTierUi", () => {
    assert.match(js, /const claudeTierRows = \$\("claudeTierRows"\);/);
    assert.match(js, /let claudeTierEnabled = true;/);
    const apply = sliceBetween(js, "function applyClaudeTierUi()", "\n    }\n", "applyClaudeTierUi");
    assert.match(apply, /if \(claudeTierRows\) claudeTierRows\.hidden = !claudeTierEnabled;/);
    // 开关切换成功即时收起/展开，不必等下一次进设置页。
    assert.match(js, /claudeTierEnabled = saved !== false;\n\s*applyClaudeTierUi\(\);/);
    // 回灌 hydrate 两个开关的复选框。
    assert.match(js, /claudeTierEnabledToggle\.checked = claudeTierEnabled;/);
    assert.match(js, /claudeBypassPermissionsToggle\.checked = d\.settings\.claudeBypassPermissions;/);
  });

  it("下拉选项取 storeRows 同源（号池出合并行、成员并集），值是中继认得的完整模型名", () => {
    const render = sliceBetween(js, "function renderClaudeTierOptions()", "\n    async function persistClaudeTier(", "renderClaudeTierOptions");
    assert.match(render, /for \(const row of storeRows\(\)\)/);
    assert.match(render, /anthropic\/\$\{row\.id\}\/\$\{modelId\}/);
    assert.match(render, /if \(seen\.has\(wireId\)\) continue;/);
    // 名称来自用户自填的渠道/模型显示名，进 DOM 与属性都必须过转义。
    assert.match(render, /value="\$\{esc\(wireId\)\}"/);
    assert.match(render, /">\$\{esc\(`\[\$\{label\}\] \$\{shown\}`\)\}<\/option>/);
    // 修掉的掉回默认：重画选项后按已存映射回填四行（select 形态下重画会跳回
    // 首项，不回填则切页回来显示与磁盘真值不符）。
    assert.match(render, /list\.innerHTML = options\.join\(""\);\n\s*\/\/ 重画选项后必须按已存映射把四行回填一遍/);
    assert.match(render, /\n\s*applyClaudeTierUi\(\);\n\s*\}/);
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

  it("收起容器显式声明 [hidden]，不依赖 UA 默认样式", () => {
    assert.match(css, /#claudeTierRows\[hidden\] \{ display: none; \}/);
  });

  it("「通用」结构注释与四张卡的实际形态一致", () => {
    assert.match(css, /「通用」分组：八项按语义分四张卡/);
    assert.match(html, /「通用」：八项按语义分四张卡/);
  });
});
