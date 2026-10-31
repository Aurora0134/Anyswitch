// Claude Code 档位映射在面板侧的形态校验：DOM 在 panel.html、绑定与渲染在
// panel.js、样式在 panel.css。与卡片类测试同范式（读源码断言结构），因为这一项
// 的正确性判据是「四行各自能存、存坏能回滚、切页回来显示与磁盘真值一致、且不
// 带任何主题特化」。
//
// 文案面钉的是用户拍板过的原句：卡头 Claude Code + 三个开关（以 bypassPermissions
// 启动 / 会话缓存优化 / 接管默认模型，各带一句描述，卡内顺序同此）+ 四行档位名。
// 四行本身保持极简、不加解释句；下拉首项「不接管」与兜底项「已失效，请重选」是 JS
// 注入的选项文案，钉在渲染断言里。日后要改文案必须连这份断言一起改——这些句子是用
// 户逐字批准的原文，不能从代码行为反推。

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
// 终点必须是本卡自己的收尾：6 空格缩进的 </div> + 空行 + 下一张卡的注释
// （panel.html 卡与卡之间的接缝）。4 空格那档是「通用」面板容器层的缩进，
// 切到那里会把下一张「实时输出」卡整卡并进来，卡内断言就失去了行归属。
const tierCard = sliceBetween(generalPanel, "<!-- Claude Code 卡", "\n      </div>\n\n      <!--", "档位映射卡");
const tierRows = sliceBetween(tierCard, '<div class="settings-tier-rows" id="claudeTierRows">', "\n          </div>\n        </div>", "四档行容器");

describe("panel.html · Claude Code 档位映射卡", () => {
  it("卡头标题是 Claude Code，且带标准卡头件", () => {
    assert.match(tierCard, /class="card-header"/);
    assert.match(tierCard, /class="card-title"/);
    assert.match(tierCard, /<\/svg>\s*\n\s*Claude Code\s*\n\s*<\/h2>/);
  });

  it("卡内是三个开关 + 收起容器里的四行：启动开关、会话缓存开关与接管总开关各自唯一", () => {
    assert.equal((html.match(/id="claudeBypassPermissionsToggle"/g) ?? []).length, 1, "bypassPermissions 开关 id 必须恰好出现一次");
    assert.equal((html.match(/id="midSystemRewriteToggle"/g) ?? []).length, 1, "会话缓存优化开关 id 必须恰好出现一次");
    assert.equal((html.match(/id="claudeTierEnabledToggle"/g) ?? []).length, 1, "接管总开关 id 必须恰好出现一次");
    for (const id of ["claudeBypassPermissionsToggle", "midSystemRewriteToggle", "claudeTierEnabledToggle"]) {
      assert.match(tierCard, new RegExp(`<input type="checkbox" id="${id}">`));
    }
    assert.match(tierCard, /<div class="settings-tier-rows" id="claudeTierRows">/);
  });

  it("两个既有开关的文案是用户拍板过的原句", () => {
    assert.match(tierCard, /<div class="modal-item-title">以 bypassPermissions 启动<\/div>/);
    assert.match(tierCard, /<div class="modal-item-desc">从 Anyswitch 启动 Claude Code 时跳过工具权限确认，Agent 可自主执行命令、修改文件。有误操作风险，请仅在可信环境开启。<\/div>/);
    assert.match(tierCard, /<div class="modal-item-title">接管默认模型<\/div>/);
    assert.match(tierCard, /<div class="modal-item-desc">开启后，Sonnet \/ Opus \/ Fable \/ Haiku 四个默认档位按下方指定模型应答；关闭后暂停接管，下方配置收起，已填写的映射保留。<\/div>/);
  });

  it("会话缓存优化开关是 [CC] 卡第二项：bypass 行之后、接管默认模型之前，文案逐字使用批准原句", () => {
    const iBypass = tierCard.indexOf('id="claudeBypassPermissionsToggle"');
    const iCache = tierCard.indexOf('id="midSystemRewriteToggle"');
    const iTier = tierCard.indexOf('id="claudeTierEnabledToggle"');
    assert.ok(iBypass >= 0 && iCache > iBypass && iTier > iCache, "开关顺序：bypass → 会话缓存优化 → 接管默认模型");
    // 文案是用户逐字批准的（版 A），一个字不得增删改。
    assert.match(tierCard, /<div class="modal-item-title">会话缓存优化<\/div>/);
    assert.match(tierCard, /<div class="modal-item-desc">将对话中途的系统提示转为普通消息发送，避免部分渠道缓存失效导致长会话重复计费<\/div>/);
  });

  it("四行按 Sonnet / Opus / Fable / Haiku 排列，控件 id 各自唯一", () => {
    const titles = [...tierRows.matchAll(/class="modal-item-title">([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(titles, ["Sonnet", "Opus", "Fable", "Haiku"]);
    for (const tier of ["Sonnet", "Opus", "Fable", "Haiku"]) {
      const id = `claudeTier${tier}Input`;
      assert.equal((html.match(new RegExp(`id="${id}"`, "g")) ?? []).length, 1, `${id} 必须恰好出现一次`);
    }
  });

  it("每行都是下拉选择：选项由 JS 注入，卡面不出现 wire 前缀或输入残留", () => {
    const selects = [...tierRows.matchAll(/<select\b[^>]*>/g)].map((m) => m[0]);
    assert.equal(selects.length, 4);
    for (const tier of ["Sonnet", "Opus", "Fable", "Haiku"]) {
      const hit = selects.find((s) => s.includes(`id="claudeTier${tier}Input"`));
      assert.ok(hit, `claudeTier${tier}Input 必须是 select`);
      assert.match(hit, /class="modal-number settings-tier-input"/);
    }
    // 静态 markup 不带任何 option（选项全部由 renderClaudeTierOptions 注入），
    // datalist 形态与输入框残留一并清零。
    assert.equal(tierRows.includes("<option"), false);
    assert.equal((html.match(/<datalist id="claudeTierModelOptions">/g) ?? []).length, 0);
    assert.equal((html.match(/list="claudeTierModelOptions"/g) ?? []).length, 0);
    assert.equal((html.match(/<input class="modal-number settings-tier-input"/g) ?? []).length, 0);
    // anthropic/ 前缀只是线上身份，不得以任何静态属性形式进卡面。
    assert.equal(tierRows.includes("anthropic/"), false);
  });

  it("四行保持极简形态：只有档位名与控件，不加解释句", () => {
    assert.equal(tierRows.includes("modal-item-desc"), false);
  });
});

describe("panel.js · 逐行即改即存与回滚", () => {
  it("四行各自绑定 change（下拉无回车路径），落到带档位名的保存调用", () => {
    assert.match(js, /input\.onchange = \(\) => persistClaudeTier\(tier, input\.value\)/);
    assert.equal(js.includes("input.onkeydown = (e) => {"), false, "下拉形态不再有回车保存路径");
  });

  it("POST 只带本次改动的那一档，其余三档不受牵连", () => {
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

  it("总开关与 bypass 开关各自绑定 change，POST 只带本项键", () => {
    assert.match(js, /claudeBypassPermissionsToggle\.onchange = async \(\) => \{/);
    assert.match(js, /api\("POST", "\/api\/settings", \{ claudeBypassPermissions: next \}\)/);
    assert.match(js, /claudeTierEnabledToggle\.onchange = async \(\) => \{/);
    assert.match(js, /api\("POST", "\/api\/settings", \{ claudeTierMappingsEnabled: next \}\)/);
  });

  it("三个开关的保存窗口由 settingsSaving 把守：handler 置位、finally 复位，回灌按位让行", () => {
    // 光在声明里占位挡不住回灌盖回：进 handler 先置 true（发请求前），成败皆在
    // finally 复位——轮询回灌的逐位守卫认的就是这面旗。
    assert.match(js, /settingsSaving = \{[^}]*claudeBypassPermissions: false, midSystemRewrite: false, claudeTierEnabled: false/);
    for (const key of ["claudeBypassPermissions", "midSystemRewrite", "claudeTierEnabled"]) {
      assert.match(js, new RegExp(`settingsSaving\\.${key} = true;\\n\\s*settingsLoadGen \\+= 1;`), `${key} 必须在发请求前置位`);
      assert.match(js, new RegExp(`finally \\{\\n\\s*settingsSaving\\.${key} = false;`), `${key} 必须在 finally 复位`);
    }
    // 回灌侧逐位守卫：正在保存的那一项不被轮询盖回（midSystemRewrite 的守卫见下一用例）。
    assert.match(js, /if \(!settingsSaving\.claudeBypassPermissions && claudeBypassPermissionsToggle && d\.settings && typeof d\.settings\.claudeBypassPermissions === "boolean"\) \{/);
    assert.match(js, /if \(!settingsSaving\.claudeTierEnabled && claudeTierEnabledToggle && d\.settings && typeof d\.settings\.claudeTierMappingsEnabled === "boolean"\) \{/);
  });

  it("会话缓存优化开关：即改即存、失败回滚、轮询回灌全走既有模式", () => {
    assert.match(js, /midSystemRewriteToggle\.onchange = async \(\) => \{/);
    assert.match(js, /api\("POST", "\/api\/settings", \{ midSystemRewrite: next \}\)/);
    // 失败/异常都回滚到原值，成功以服务端归一值为最终真相。
    const handler = sliceBetween(js, "if (midSystemRewriteToggle) {\n      midSystemRewriteToggle.onchange", "\n    }\n\n    // 接管默认模型总开关", "会话缓存优化 onchange");
    assert.match(handler, /midSystemRewriteToggle\.checked = !next;/);
    assert.match(handler, /const saved = d\.settings\?\.midSystemRewrite;/);
    assert.match(handler, /toast\("设置保存失败", true\)/);
    // 轮询回灌：不在保存中的窗口里按服务端值刷复选框。
    assert.match(js, /if \(!settingsSaving\.midSystemRewrite && midSystemRewriteToggle && d\.settings && typeof d\.settings\.midSystemRewrite === "boolean"\) \{\n\s*midSystemRewriteToggle\.checked = d\.settings\.midSystemRewrite;\n\s*\}/);
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

  it("下拉选项取 storeRows 同源（号池出合并行、成员并集），值是完整模型名、文本无 wire 前缀", () => {
    const render = sliceBetween(js, "function renderClaudeTierOptions()", "\n    async function persistClaudeTier(", "renderClaudeTierOptions");
    assert.match(render, /for \(const row of storeRows\(\)\)/);
    assert.match(render, /anthropic\/\$\{row\.id\}\/\$\{modelId\}/);
    assert.match(render, /if \(seen\.has\(wireId\)\) continue;/);
    // 名称来自用户自填的渠道/模型显示名，进 DOM 与属性都必须过转义。
    assert.match(render, /value="\$\{esc\(wireId\)\}"/);
    assert.match(render, /">\$\{esc\(`\[\$\{label\}\] \$\{shown\}`\)\}<\/option>/);
    // 首项固定「不接管」；已存值不在候选集时补「已失效，请重选」——与链编辑器
    // 「已保存但目录里消失的模型补入选项」同一口径。
    assert.match(render, /const base = \[`<option value="">不接管<\/option>`\];/);
    assert.match(render, /options\.push\(`<option value="\$\{esc\(current\)\}">已失效，请重选<\/option>`\);/);
    // 逐行各自的选项表挂到各自的 select；wire 前缀只存在于 value，不进显示文本。
    assert.match(render, /input\.innerHTML = options\.join\(""\);/);
    // 修掉的掉回默认：重画选项后按已存映射回填四行（select 重画会跳回首项，
    // 不回填则切页回来显示与磁盘真值不符）。
    assert.match(render, /\n\s*applyClaudeTierUi\(\);\n\s*\}/);
  });

  it("下拉选项先列 Anyswitch 自建的虚拟模型：启用中且链非空才列，值是目录 id、文本不带 wire 前缀", () => {
    const render = sliceBetween(js, "function renderClaudeTierOptions()", "\n    async function persistClaudeTier(", "renderClaudeTierOptions");
    // 候选取自 store state 的虚拟模型列表——它们不在渠道目录里，却是中继真认得的模型。
    assert.match(render, /for \(const vm of storeVirtualModels\(\)\)/);
    // 准入口径与中继同源：停用、链为空的模型不在中继目录里，选中必然失败。
    assert.match(render, /if \(vm\.enabled === false\) continue;/);
    assert.match(render, /if \(!Array\.isArray\(vm\.chain\) \|\| vm\.chain\.length === 0\) continue;/);
    // 值 = 虚拟模型的目录 id（与 auto 同造法，单段，永不与真 wire id 相撞）；
    // 文本 = 「[Anyswitch] 名字」，与中继目录里虚拟模型那一行逐字一致。
    assert.match(render, /const wireId = `anthropic\/\$\{name\}`;/);
    assert.match(render, /base\.push\(`<option value="\$\{esc\(wireId\)\}">\$\{esc\(`\[Anyswitch\] \$\{name\}`\)\}<\/option>`\);/);
    // 排在渠道模型之前（首项「不接管」之后）。
    const vmAt = render.indexOf("for (const vm of storeVirtualModels())");
    const rowAt = render.indexOf("for (const row of storeRows())");
    assert.ok(vmAt >= 0 && rowAt > vmAt, "虚拟模型选项必须排在渠道模型之前");
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
    // select 形态没有 placeholder，输入框时代的占位规则不得回潮成死代码。
    assert.equal(css.includes(".settings-tier-input::placeholder"), false);
  });

  it("收起容器显式声明 [hidden]，不依赖 UA 默认样式", () => {
    assert.match(css, /#claudeTierRows\[hidden\] \{ display: none; \}/);
  });

  it("「通用」结构注释与六张卡的实际形态一致", () => {
    // 卡数随结构演进：「显示」卡随「UI版本」分段钮落地，是第六张。注释钉的数
    // 必须与实数一致：结构加减卡时这里先红，逼着把两处注释一起改。
    assert.equal((generalPanel.match(/<div class="panel-card">/g) ?? []).length, 6, "「通用」实数六张卡");
    assert.match(css, /「通用」分组：按语义分六张卡/);
    assert.match(html, /「通用」：按语义分六张卡/);
  });
});
