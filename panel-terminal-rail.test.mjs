// 终端视图左栏换血（M4）：随 agent 的会话栏。
// 断言分三层：静态源码（HTML 骨架 / CSS 换血与观感红线 / JS 挂点）、vm 真跑纯函数
// （分组、水位线、跟随、指纹门控、FLIP 门控）、vm 真跑点击两分支（续接 POST 与提示）。
// 取样惯例照 panel.test.mjs：源码字符串断言 + 按函数名切源码进桩环境，函数体不得出现
// 提前闭合的「\n  }」，DOM 操作带 typeof document 双闸。
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const panelHtml = readFileSync(join(here, "panel-ui", "panel.html"), "utf8");
const panelCss = readFileSync(join(here, "panel-ui", "panel.css"), "utf8");
const panelJs = readFileSync(join(here, "panel-ui", "panel.js"), "utf8");

const railHtml = () => {
  const m = panelHtml.match(/<aside class="rail" id="v2Rail"[\s\S]*?<\/aside>/);
  assert.ok(m, "左栏在册");
  return m[0];
};

function extractFn(name) {
  const src = panelJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
  assert.ok(src, `${name} found in panel.js`);
  return src;
}

const cssRule = (selector) => {
  const at = panelCss.indexOf(selector);
  assert.ok(at >= 0, `样式规则 ${selector} 在册`);
  return panelCss.slice(at, panelCss.indexOf("}", at) + 1);
};

const escapeHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("终端视图左栏换血（M4）", () => {
  describe("HTML 骨架", () => {
    it("终端会话栏静态在册：hidden、aria-label「终端会话」、落在主 tab 组与栏底之间", () => {
      const rail = railHtml();
      const dir = rail.match(/<nav class="rail-dir rail-terminal-dir" id="railTerminalDir" aria-label="终端会话" hidden>([\s\S]*?)<\/nav>/);
      assert.ok(dir, "终端会话栏在册（同设置目录的换血形制：nav + 静态 hidden）");
      assert.ok(rail.indexOf('class="rail-tabs"') < rail.indexOf('id="railTerminalDir"')
        && rail.indexOf('id="railTerminalDir"') < rail.indexOf('class="rail-foot"'),
        "位置：主 tab 组之后、栏底行之前（换血时整组顶上主 tab 组）");
      for (const id of ["railTermNewBtn", "railTermSectionHead", "railTermHistoryList"]) {
        assert.ok(dir[1].includes(`id="${id}"`), `骨架节点 ${id} 就位`);
      }
      // M8 T1 两段合并后栏体自上而下：新建终端 → 「工作区」段头（T7 三钮）→
      // 目录分组树（live 会话内联）→ 底栏。「打开的终端」段整段拆除。
      const body = dir[1];
      assert.ok(body.indexOf('id="railTermNewBtn"') < body.indexOf('id="railTermSectionHead"')
        && body.indexOf('id="railTermSectionHead"') < body.indexOf("rail-term-scroll"),
        "栏体自上而下：新建终端 → 段头 → 滚动层（树）");
      assert.ok(!body.includes('id="railTermOpenList"'), "「打开的终端」段整段拆除（M8 T1）");
      assert.ok(!body.includes("打开的终端"), "旧段头文案不在册");
      assert.ok(body.includes(">工作区<"), "段头标题「工作区」（M8 T3）");
    });

    it("身份行整块拆除：头像槽、名称、通用字形与相关 id 一律不在册", () => {
      // 用户 2026-10-21 拍板：agent 头像＋名称与 anys 产品图标贴在一起抢视野，顶区
      // 只留「新建终端」。栏体仍跟随聚焦终端的 agent 取两段数据，只是不再显示身份。
      const rail = railHtml();
      for (const id of ["railTermAgentAvatar", "railTermAgentName"]) {
        assert.ok(!rail.includes(`id="${id}"`), `身份行节点 ${id} 已清净`);
      }
      assert.ok(!panelHtml.includes("rail-term-agent-glyph"), "通用终端字形槽一并清净");
      assert.ok(!panelCss.includes(".rail-term-agent"), "身份行样式一并清净");
      const railBlock = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      for (const symbol of ["renderTerminalRailAgent", "terminalRailAgentGlyph", "terminalRailAgentLabel"]) {
        assert.ok(!railBlock.includes(symbol), `身份行函数 ${symbol} 已清净`);
      }
    });

    it("文案只用已批准的清单：新建终端 / 工作区", () => {
      const rail = railHtml();
      const body = rail.slice(rail.indexOf('id="railTerminalDir"'), rail.indexOf('class="rail-foot"'));
      assert.ok(/id="railTermNewBtn"[^>]*title="新建终端"[^>]*aria-label="新建终端"/.test(body),
        "「新建终端」是静态默认态（无 agent 聚焦时的文案，有 agent 时 JS 换「新建会话」）");
      assert.ok(body.includes('title="新建终端"'), "新建按钮 title 就是产品动词本身");
      assert.ok(body.includes(">新建终端<"), "新建按钮可见文案「新建终端」");
      assert.ok(body.includes(">工作区<"), "段头标题「工作区」");
      // D4：段头只剩搜索＋视图选项两钮（刷新钮已砍）；刷新钮不在册
      assert.ok(!body.includes('id="railTermHistoryRefresh"'), "段头刷新钮已拆除（M9-D4，用户拍板）");
      // 栏内可见文案只许是批准清单里的那几句：把 HTML 文本节点全取出来逐个比对，
      // 新造词一进来就红（不是只看某一条正则不命中）。
      const textNodes = [...body.matchAll(/>([^<>]+)</g)].map((m) => m[1].trim()).filter(Boolean);
      const APPROVED = new Set(["终端会话", "新建终端", "工作区"]);
      assert.deepEqual(textNodes.filter((t) => !APPROVED.has(t)), [], "栏体静态文案全部在批准清单内");
      assert.ok(textNodes.includes("新建终端"), "新建按钮的可见文案在清单里");
    });
  });

  describe("CSS 换血与首帧孪生", () => {
    it("运行时 body.terminal-mode 四条 + 首帧 data-prepaint-view 同值四条，只锚 #v2Rail", () => {
      for (const scope of [
        ':root[data-ui-version="v2"] body.terminal-mode',
        'html[data-prepaint-view="terminal"][data-ui-version="v2"]',
      ]) {
        assert.ok(panelCss.includes(`${scope} #v2Rail .rail-tabs { display: none; }`), `${scope} 收主 tab 组`);
        assert.ok(panelCss.includes(`${scope} #v2Rail #railTerminalDir[hidden] { display: flex !important; }`),
          `${scope} 放终端会话栏（!important 压全局 [hidden] 兜底）`);
        assert.ok(panelCss.includes(`${scope} #v2Rail #railSettingsBtn { display: none; }`), `${scope} 收栏底齿轮`);
        assert.ok(panelCss.includes(`${scope} #v2Rail #railBackBtn[hidden] { display: flex !important; }`), `${scope} 放「返回」`);
      }
    });

    it("观感红线：行 hover/选中 0ms 硬切、动作按钮 display 硬切，只有组箭头 .15s", () => {
      const row = cssRule(".rail-term-row {");
      assert.ok(!/transition/.test(row), "行本体无 transition——hover 底色 0ms 硬切（加过渡就错）");
      assert.ok(panelCss.includes(".rail-term-row:hover { background: var(--surface-hover);"), "hover 底色直接换，无过渡");
      // live 行的关闭叉（M8 T5）：只限 live 行 hover 出现，与归档钮同形制
      const closeRule = panelCss.match(/\.rail-term-row\.is-live:hover \.rail-term-row-close \{([^}]*)\}/);
      assert.ok(closeRule, "live 行 hover 出关闭叉（M8 T5，× 走 terminalRailCloseSession 同一条路）");
      assert.ok(closeRule[1].includes("display: inline-flex"), "动作按钮 display 硬切（无淡入无位移）");
      const arrow = cssRule(".rail-term-group-arrow {");
      assert.ok(arrow.includes("transition: transform .15s ease-in-out"),
        "组箭头是栏内唯一一条 CSS 过渡：.15s ease-in-out（M14 照 dsh 实测缓动）");
      assert.ok(panelCss.includes(".rail-term-group.is-open .rail-term-group-arrow { transform: rotate(90deg); }"),
        "展开态箭头旋转 90°");
      const rm = panelCss.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.rail-term-group-arrow \{ transition: none; \}/);
      assert.ok(rm, "prefers-reduced-motion 下箭头过渡关掉");
    });

    it("矮窗口不重叠：定高块 flex:none，只有中段滚动层吃剩余空间并自己滚", () => {
      // 真机缺陷：栏体是列 flex，定高块默认 flex:0 1 auto 会参与收缩，而它们的行有
      // min-height、容器没有 → 行溢出容器画到下一段头上。布局几何在桩框架里量不出来
      // （要真渲染才有 rect），所以这里钉住让几何成立的结构契约；几何本身由无头
      // Chrome harness 验。M8 T1 起段头是滚动层外的定高块（dsh：sectionHeader 在
      // regionArea 里 flex:none，滚的只有里面的列表）。
      const dir = cssRule("#railTerminalDir {");
      // 只比对声明（注释里也会出现「min-height:0」这类说明文字）
      const decls = (block) => block.replace(/\/\*[\s\S]*?\*\//g, "");
      // M9-D1：栏体必须 min-height:0 + overflow:hidden（dsh regionArea 同口径）。
      // 早先选 auto 是为躲 e160790，但它把整棵树的 min-content 全高传给 aside 的
      // flex 布局——收缩链断在栏体，aside 自己滚、底栏被滚走、滚动层从不接管
      // （真机实测：rail scrollHeight 1468 > clientHeight 566，滚动层 1254==1254）。
      // min-height:0 让栏体可缩到剩余空间，flex:1 的滚动层成为唯一 scroller；
      // overflow:hidden 保证矮窗下溢出的也是被裁切而不是画到段头/底栏上（e160790
      // 的病征是「可见的重叠」，裁切是 containment，且 500px 矮窗下根本裁不到）。
      assert.ok(/min-height:\s*0/.test(decls(dir)), "栏体 min-height:0（收缩链不断，M9-D1）");
      assert.ok(/overflow:\s*hidden/.test(decls(dir)), "栏体 overflow:hidden（溢出由滚动层裁）");
      for (const [selector, why] of [
        [".rail-term-new {", "新建终端钮"],
        [".rail-term-section-head {", "段头（T7 三钮所在，定高不滚）"],
        [".rail-term-history {", "树容器"],
      ]) {
        assert.ok(cssRule(selector).includes("flex: none"), `${why} 是定高块，必须 flex:none（不参与收缩）`);
      }
      // S4 起滚动收进唯一中段滚动层（M8 起里面只有一棵工作区树）
      const scroll = cssRule(".rail-term-scroll {");
      assert.ok(scroll.includes("flex: 1 1 auto") && scroll.includes("min-height: 0"),
        "中段滚动层是唯一吃剩余空间的那层（空间不够时它先缩）");
      assert.ok(scroll.includes("overflow-y: auto"), "滚动发生在中段滚动层，溢出由它裁切、不越段");
      assert.ok(scroll.includes("scrollbar-gutter: stable"), "预留滚动条槽位：有无滚动条布局不跳");
      assert.ok(scroll.includes("padding-bottom: 16px"), "列表底部留白 16px（dsh 同值）");
      // 树容器不得靠 overflow:hidden 掩盖问题（那会把行切掉，不是修）
      assert.ok(!/\.rail-term-history[^{]*\{[^}]*overflow/.test(panelCss), "树容器不靠 overflow 裁切");
    });

    it("M9-D1：栏内浮层 portal 到 body（栏体 overflow:hidden 不裁它们）", () => {
      // 组头 ⋯ 菜单与视图选项菜单原先挂在栏内 absolute——栏体加 overflow:hidden 后
      // 会把贴边展开的菜单裁掉，故一并 portal 到 body（dsh 的 portal:true 同款），
      // 坐标改按视口 rect 算、层级抬到与 hover 卡/右键菜单同档。
      const menu = cssRule(".rail-term-menu {");
      assert.ok(menu.includes("position: fixed"), "菜单挂 body 下 fixed（不再吃栏内 absolute）");
      assert.ok(/z-index:\s*1200/.test(menu), "层级 1200：压过栏体 40 与终端页内容");
      const railBlock = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      const groupOpen = railBlock.slice(railBlock.indexOf("function openTerminalRailGroupMenu"), railBlock.indexOf("function toggleTerminalRailGroupMenu"));
      const viewOpen = railBlock.slice(railBlock.indexOf("function openTerminalRailViewMenu"), railBlock.indexOf("function applyTerminalRailViewChoice"));
      assert.ok(groupOpen.includes("document.body.append(menu)"), "组头菜单 append 到 body");
      assert.ok(viewOpen.includes("document.body.append(menu)"), "视图选项菜单 append 到 body");
      assert.ok(!groupOpen.includes("dir.append(menu)") && !viewOpen.includes("dir.append(menu)"),
        "两个菜单都不再挂回栏体（挂了就会被 overflow:hidden 裁）");
    });

    it("钉底三层：顶区/中段滚动层/底栏各司其职，不用 sticky/fixed", () => {
      // S4（m6 §3）：dsh 的钉底不是 sticky/fixed，是 flex:1+min-height:0 的唯一
      // 可伸缩层 + flex:none 的兄弟节点。栏体与设置态共用骨架，底栏一颗钮两态共用。
      // （hover 卡是挂 body 的 portal 浮层，dsh 同款 position:fixed，不属钉底机制，
      // 钉底三件——滚动层/底栏/遮罩——的规则里不许出现 sticky/fixed。）
      assert.ok(cssRule(".rail-foot {").includes("flex: none"), "底栏（亮暗/返回）不参与伸缩");
      const pinRules = [".rail-term-scroll {", ".rail-foot {", ".rail-term-fade {"]
        .map((sel) => cssRule(sel)).join("");
      assert.ok(!/position:\s*(sticky|fixed)/.test(pinRules), "钉底三件不碰 sticky/fixed（钉底靠 flex）");
      // 滚动条指针感知隐退（dsh §3.5）：变量替换、无淡出
      assert.ok(panelCss.includes("#railTerminalDir[data-quiet] { --rail-term-scrollbar-thumb: transparent; }"),
        "离开 2s 后 thumb 变量替换成透明（瞬时消失，无过渡）");
      const thumb = panelCss.match(/\.rail-term-scroll::-webkit-scrollbar-thumb \{([^}]*)\}/);
      assert.ok(thumb && thumb[1].includes("var(--rail-term-scrollbar-thumb"), "thumb 取可被 quiet 替换的变量");
      assert.ok(thumb && thumb[1].includes("border-radius: 999px"), "thumb 圆角");
      assert.ok(panelCss.includes(".rail-term-scroll::-webkit-scrollbar { width: 5px; }"), "滚条 5px");
      const track = panelCss.match(/\.rail-term-scroll::-webkit-scrollbar-track \{([^}]*)\}/);
      assert.ok(track && track[1].includes("transparent"), "track 透明");
    });

    it("列表底部 24px 渐隐遮罩、滚条 5px、折叠态只留新建图标钮", () => {
      const fade = cssRule(".rail-term-fade {");
      assert.ok(fade.includes("height: 24px"), "底部渐隐 24px");
      // 终点必须与栏底色同一个取值源：栏底在 saas/sepia 被对调成 --bg-page，写死
      // --surface 会在那两套皮肤下变成一条更亮的实色带。断言钉的是「同一来源」而不是
      // 某个具体 token 名，改取值源时测试跟着改、不会替错的实现背书。
      assert.ok(fade.includes("var(--rail-bg"), "渐隐终点取 --rail-bg（栏底色取值源），不写死某个 token");
      assert.ok(!/linear-gradient\(to bottom, transparent, var\(--(surface|bg-page)\)\)/.test(fade),
        "不直接写 --surface / --bg-page（皮肤一换就错）");
      assert.ok(panelCss.includes(":root[data-ui-version=\"v2\"] #v2Rail { --rail-bg: var(--surface); }"),
        "基座：栏底色 = --surface");
      // --rail-bg 与「材质修正 ②」那条栏底对调逐项同源：基座 --surface，
      // saas/sepia 合并选择器里一起换成 --bg-page，aurora 不参与（沿用基座）。
      assert.ok(/:root\[data-ui-version="v2"\]\[data-style="saas"\] #v2Rail,\s*\n\s*:root\[data-ui-version="v2"\]\[data-style="sepia"\] #v2Rail \{ --rail-bg: var\(--bg-page\); \}/.test(panelCss),
        "saas/sepia：--rail-bg 跟随栏底对调成 --bg-page");
      // 栏底那条对调规则（合并选择器一格）确实把 saas/sepia 的 .rail 换成 --bg-page
      assert.ok(/:root\[data-ui-version="v2"\]\[data-style="saas"\] \.rail,\s*\n\s*:root\[data-ui-version="v2"\]\[data-style="sepia"\] \.rail \{ background: var\(--bg-page\); \}/.test(panelCss),
        "saas/sepia 的 .rail 底色确为 --bg-page（--rail-bg 与之同值，渐隐终点才对得上）");
      assert.ok(!panelCss.includes(':root[data-ui-version="v2"][data-style="aurora"] #v2Rail { --rail-bg'),
        "aurora 不参与对调，沿用基座 --surface（玻璃料）");
      assert.ok(fade.includes("pointer-events: none"), "遮罩不吃点击");
      // S4：遮罩挂栏体（不在滚动层里，不随内容滚），贴滚动层底、right 让出滚动条
      assert.ok(fade.includes("position: absolute"), "绝对定位贴滚动层底");
      assert.ok(fade.includes("bottom: 0"), "贴底");
      assert.ok(/right:\s*[5-9]px/.test(fade), "right 让出滚动条宽度（5px 滚条 + 余量）");
      assert.ok(panelCss.includes(".rail-term-scroll::-webkit-scrollbar { width: 5px; }"), "滚条 5px");
      // 折叠态（72px 图标栏）两个来处：窄栏自动档与手动态 collapsed
      assert.ok(/:is\(\.rail-term-new-label, \.rail-term-section-head, \.rail-term-scroll, \.rail-term-fade\) \{ display: none; \}/.test(panelCss),
        "折叠态只留新建图标钮：段头/树/渐隐整段不出（dsh 折叠同款取舍）");
      assert.ok(/:root\[data-ui-version="v2"\]:not\(\[data-rail="expanded"\]\) \.rail-term-new \{ justify-content: center; padding: 9px 0; margin: 0; \}/.test(panelCss),
        "窄栏（<1200 自动档）新建按钮收成图标钮");
      assert.ok(/:root\[data-ui-version="v2"\]\[data-rail="collapsed"\] \.rail-term-new \{ justify-content: center; padding: 9px 0; margin: 0; \}/.test(panelCss),
        "手动态 collapsed 同形制");
    });

    it("样式全走语义 token：不新增色值", () => {
      const start = panelCss.indexOf("/* ── 终端会话栏（M4 + M7 + M8）");
      assert.ok(start > 0, "终端会话栏样式段在册");
      const block = panelCss.slice(start, panelCss.indexOf("── 阶段 2 补", start));
      assert.ok(block.length > 0, "样式段可取样");
      const hex = block.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
      assert.deepEqual(hex, [], `终端会话栏样式不含硬编码色值：${hex.join(",")}`);
      assert.ok(!/rgba?\(/.test(block), "也不含 rgba() 直写色");
    });
  });

  describe("跟随语义（vm 真跑）", () => {
    const runAgentId = (session) => {
      const fn = new Function("session", `
        let terminalBackendReady = true;
        const terminalBackendSessions = session ? { t1: session } : {};
        const activeTerminalPreviewId = "t1";
        ${extractFn("terminalRailSessionMap")}
        ${extractFn("terminalRailActiveSession")}
          ${extractFn("terminalRailAgentId")}
          ${extractFn("terminalRailFindOpenSession")}
        ${extractFn("terminalRailAgentId")}
          ${extractFn("terminalRailFindOpenSession")}
        return terminalRailAgentId;
      `)(session);
      return fn();
    };

    it("身份取页签同一口径：实时归属 endpointId 优先、一键启动快照 agentId 次之", () => {
      assert.equal(runAgentId({ id: "t1", agent: { endpointId: "claude" } }), "claude", "归属注入的 endpointId 优先");
      assert.equal(runAgentId({ id: "t1", agent: null, agentId: "kimi" }), "kimi", "一键启动快照 agentId 次之");
      assert.equal(runAgentId({ id: "t1", agent: { endpointId: "claude" }, agentId: "kimi" }), "claude", "两者都有时以实时归属为准");
      assert.equal(runAgentId({ id: "t1", agent: null }), "", "纯外壳终端 = 无 agent");
      assert.equal(runAgentId({ id: "t1", agent: { endpointId: 'bad"id' } }), "", "非常规字符的身份不落进属性与选择器");
      assert.equal(runAgentId(null), "", "零会话不炸");
      const src = extractFn("terminalRailAgentId");
      assert.ok(src.includes("target.agent && target.agent.endpointId"), "与页签左图标同一取值链");
      assert.ok(src.includes("target.agentId"), "快照身份次之");
    });

    it("live 判定＝打开中的终端有同 endpoint＋同会话 id 的 resume 记录（M8 T1，M7-S5 映射复用）", () => {
      // 「打开的终端」段拆除后，live 不再是一张独立列表，而是树里行的属性：
      // 一条历史会话行，只要有开着终端替它续接（resume 两键匹配），就是 live。
      const run = (sessions, endpoint, id) => {
        const fn = new Function("sessions", "endpoint", "id", `
          let terminalBackendReady = true;
          const terminalBackendSessions = sessions;
          ${extractFn("terminalRailSessionMap")}
          ${extractFn("terminalRailFindOpenSession")}
          return terminalRailFindOpenSession;
        `)(sessions, endpoint, id);
        return fn(endpoint, id);
      };
      const sessions = {
        t1: { id: "t1", agent: { endpointId: "claude" }, resume: { endpoint: "claude", id: "s-1" } },
        t2: { id: "t2", agent: { endpointId: "claude" }, resume: { endpoint: "claude", id: "s-2" } },
        t3: { id: "t3", agent: { endpointId: "claude" }, resume: null },
      };
      assert.equal(run(sessions, "claude", "s-1").id, "t1", "两键都对上才认（续接创建的终端必识别）");
      assert.equal(run(sessions, "claude", "s-9"), null, "没有对得上的终端 = 非 live");
      assert.equal(run(sessions, "kimi", "s-1"), null, "换端点不算同一会话（单键会误伤）");
      assert.equal(run(sessions, "", "s-1"), null, "空身份不查");
      assert.equal(run({}, "claude", "s-1"), null, "零终端不炸");
    });
  });

  describe("历史会话：分组、水位线、指纹（vm 真跑）", () => {
    const groupFn = () => {
      const fn = new Function(`
        ${extractFn("sessDirName")}
        ${extractFn("terminalRailNormDir")}
        ${extractFn("terminalRailGroupSessions")}
        return terminalRailGroupSessions;
      `)();
      return fn;
    };

    it("按 project 归组、无 project 落「未分组」、组序按最近活跃倒序且未分组沉底", () => {
      const groups = groupFn()([
        { id: "a", project: "C:\\dev\\alpha", lastActive: 100 },
        { id: "b", project: "C:\\dev\\beta", lastActive: 300 },
        { id: "c", project: "C:\\dev\\alpha", lastActive: 200 },
        { id: "d", project: null, lastActive: 900 },
        { id: "e", project: "", lastActive: 800 },
      ]);
      assert.deepEqual(groups.map((g) => g.label), ["beta", "alpha", "未分组"], "组头取目录短名，未分组沉底");
      assert.deepEqual(groups.map((g) => g.key), ["C:\\dev\\beta", "C:\\dev\\alpha", ""], "组键是完整 project 路径（组态/水位线都按它存）");
      assert.deepEqual(groups[1].rows.map((r) => r.id), ["c", "a"], "组内按最近活跃倒序");
      assert.deepEqual(groups[2].rows.map((r) => r.id), ["d", "e"], "空 project 与 null 同归未分组");
      assert.deepEqual(groupFn()([]), [], "空表不炸");
      assert.deepEqual(groupFn()(null), [], "非数组不炸");
    });

    it("分组键归一化：同一目录的不同拼写只出一组，label 取最短拼写（M14）", () => {
      // 用户实测的病灶：同名目录因拼写不同裂成两个组（两个「ai4math」）。
      const groups = groupFn()([
        { id: "a", project: "C:\\dev\\alpha", lastActive: 100 },
        { id: "b", project: "C:/Dev/Alpha/", lastActive: 300 },
        { id: "c", project: "C:\\DEV\\ALPHA\\", lastActive: 200 },
      ]);
      assert.equal(groups.length, 1, "三种拼写（斜杠/大小写/尾斜杠）只出一组");
      assert.equal(groups[0].key, "C:\\dev\\alpha", "组键取最短的那条原始拼写");
      assert.equal(groups[0].label, "alpha", "组头短名取自同一拼写");
      assert.deepEqual(groups[0].rows.map((r) => r.id), ["b", "c", "a"], "组内仍按最近活跃倒序");
    });

    it("label 稳定：等长拼写按字典序定，和会话先后无关（不随活跃序漂）", () => {
      const first = groupFn()([
        { id: "a", project: "C:\\dev\\Beta", lastActive: 100 },
        { id: "b", project: "c:\\dev\\beta", lastActive: 200 },
      ]);
      const second = groupFn()([
        { id: "b", project: "c:\\dev\\beta", lastActive: 200 },
        { id: "a", project: "C:\\dev\\Beta", lastActive: 100 },
      ]);
      assert.equal(first.length, 1, "等长不同拼写同样归一");
      assert.equal(first[0].key, "C:\\dev\\Beta", "等长按原串字典序（大写在前）");
      assert.equal(second[0].key, first[0].key, "输入顺序反过来，组名不漂");
    });

    it("水位线：基线 5、点一次 +5、剩余 ≤5 一次全展开、全展开后「收起」回基线", () => {
      const run = new Function(`
        const TERMINAL_RAIL_WATERMARK = 5;
        ${extractFn("terminalRailWatermarkView")}
        ${extractFn("terminalRailNextWatermark")}
        ${extractFn("terminalRailMoreLabel")}
        return { view: terminalRailWatermarkView, next: terminalRailNextWatermark, label: terminalRailMoreLabel };
      `)();
      assert.deepEqual(run.view(12, 5), { visible: 5, hidden: 7, expanded: false }, "默认先露 5 条");
      assert.equal(run.label(run.view(12, 5)), "展开其余 7 个会话", "按钮文案带剩余数");
      assert.equal(run.next(12, 5), 10, "点一次 +5");
      assert.equal(run.next(12, 10), 12, "剩余 ≤5 一次全展开（不再分两跳）");
      assert.deepEqual(run.view(12, 12), { visible: 12, hidden: 0, expanded: true }, "全展开态");
      assert.equal(run.label(run.view(12, 12)), "收起", "全展开后按钮变「收起」");
      assert.equal(run.next(12, 12), 5, "「收起」回基线 5");
      assert.deepEqual(run.view(3, 5), { visible: 3, hidden: 0, expanded: true }, "不足一档的组不截断");
    });

    it("live 行渲染：状态点 + 选中态 + 关闭叉 + 归档钮并存（M8 T1/T2/T5）", () => {
      const fn = new Function("session", "live", "activeId", `
        const TERMINAL_RAIL_ICON_ARCHIVE = "<svg></svg>";
        const TERMINAL_RAIL_ICON_UNARCHIVE = "<svg></svg>";
        function sessTitle(s) { return s.title || String(s.id || "").slice(0, 8); }
        function sessRelTime() { return "3 分钟前"; }
        function terminalRailRelTime() { return "3 分钟前"; }
        function terminalRailIsArchived() { return false; }
        function esc(v) { return String(v); }
        function escapeHtml(v) { return String(v || ""); }
        // 槽位接线用桩（markup 逐项由源码钉死测试负责）
        const TERMINAL_RAIL_SPINNER = '<span class="rail-term-spinner">SPINNER-STUB</span>';
        const TERMINAL_RAIL_DONE_DOT = '<span class="rail-term-done" title="已完成">DONE-STUB</span>';
        const terminalDoneUnread = new Map();
        let terminalRailSelectPending = null;
        ${extractFn("terminalRailStateSlotHtml")}
        ${extractFn("terminalRailRowHtml")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
        return terminalRailRowHtml;
      `)(null, null, "t1");
      const session = { id: "s-1", endpoint: "kimi", title: "重构权限矩阵", lastActive: 100 };
      const live = { id: "t-1", status: "working" };
      const html = fn(session, live, "t-1");
      // M12-B：working 行的行首槽位挂转圈（dsh 实测口径），不再用 7×7 状态点。
      assert.ok(html.includes("SPINNER-STUB"), "working 行行首槽位挂转圈");
      assert.ok(!html.includes("terminal-tab-state"), "working 行不挂 7×7 状态点（转圈即运行中视觉）");
      assert.ok(html.includes("is-active"), "聚焦终端对应的行是选中态（T2）");
      assert.ok(html.includes('data-rail-term-live="t-1"'), "live 行带终端 id（点击走聚焦）");
      assert.ok(html.includes('data-rail-term-close="t-1"'), "live 行 hover 出关闭叉（T5，走同一条关闭处理）");
      assert.ok(html.includes('data-rail-term-archive="s-1"'), "live 行同时带归档钮（T5）");
      assert.ok(html.includes('aria-hidden="true">×</span>'), "关闭叉照页签形制：字形 + aria-hidden，不新造文案");
      // 非 live 行：槽位空（无点、无转圈），无关闭叉，只有归档钮
      const plain = fn(session, null, "t-9");
      assert.ok(!plain.includes("terminal-tab-state"), "非 live 行无状态点");
      assert.ok(!plain.includes("SPINNER-STUB"), "非 live 行槽位留空（转圈只填运行行的空槽）");
      assert.ok(!plain.includes("data-rail-term-close"), "非 live 行无关闭叉");
      assert.ok(plain.includes('data-rail-term-archive="s-1"'), "非 live 行 hover 出归档钮（T5）");
      assert.ok(!plain.includes("is-active"), "非 live 行不占选中态");
      // 选中只属于聚焦终端那条 live 行；idle 的 live 行留空槽（dsh 四态机：idle
      // 不画任何图标，灰点退役）
      const other = fn(session, { id: "t-2", status: "idle" }, "t-1");
      assert.ok(other.includes('<span class="rail-term-slot"></span>'), "idle 的 live 行是空常驻槽（不画图标）");
      assert.ok(!other.includes("terminal-tab-state"), "idle 的 live 行不再渲染状态点");
      assert.ok(!other.includes("SPINNER-STUB"), "idle 的 live 行无转圈");
      assert.ok(!other.includes('title="空闲"'), "「空闲」tooltip 随灰点一并消失");
      assert.ok(!other.includes("is-active"), "同一时刻至多一条选中（T2）");
    });

    it("M12-B 转圈 markup 逐项（源码钉死，dsh 实测规格照抄）", () => {
      const spinner = panelJs.match(/const TERMINAL_RAIL_SPINNER = '([\s\S]*?)';/)?.[1];
      assert.ok(spinner, "转圈常量在册");
      assert.ok(spinner.includes('width="14" height="14" viewBox="0 0 24 24"'), "SVG 14×14、viewBox 0 0 24 24");
      assert.ok(spinner.includes('aria-hidden="true"'), "SVG aria-hidden（读屏文本另挂）");
      assert.ok(spinner.includes('stroke="currentColor"'), "currentColor 吃三级文字色（不造新色值）");
      assert.ok(spinner.includes('class="rail-term-spinner-track"') && spinner.includes('r="9.5"') && spinner.includes('opacity=".25"'), "轨道圆 r=9.5、opacity .25");
      assert.ok(spinner.includes('class="rail-term-spinner-arc"') && spinner.includes('stroke-dasharray="12 150"'), "弧线圆 dasharray 12 150");
      assert.ok(spinner.includes('class="rail-term-spinner-rot"'), "外层 g 挂旋转类（transform-origin center）");
      assert.ok(spinner.includes("进行中"), "槽内读屏文本「进行中」（规格批准的唯一新增 aria 文本）");
      assert.ok(spinner.includes('class="rail-term-spinner-sr"'), "读屏文本走 visuallyHidden 形制");
    });

    it("行首常驻槽：三种状态同起点，组头文字与会话标题同 x（dsh sessionRow 同构）", () => {
      const fn = new Function("session", "live", "activeId", `
        const TERMINAL_RAIL_ICON_ARCHIVE = "<svg></svg>";
        const TERMINAL_RAIL_ICON_UNARCHIVE = "<svg></svg>";
        function sessTitle(s) { return s.title || String(s.id || "").slice(0, 8); }
        function terminalRailRelTime() { return "3 分钟前"; }
        function terminalRailIsArchived() { return false; }
        function esc(v) { return String(v); }
        function escapeHtml(v) { return String(v || ""); }
        const TERMINAL_RAIL_SPINNER = '<span class="rail-term-spinner">SPINNER-STUB</span>';
        const TERMINAL_RAIL_DONE_DOT = '<span class="rail-term-done" title="已完成">DONE-STUB</span>';
        const terminalDoneUnread = new Map();
        let terminalRailSelectPending = null;
        ${extractFn("terminalRailStateSlotHtml")}
        ${extractFn("terminalRailRowHtml")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
        return terminalRailRowHtml;
      `)(null, null, "t1");
      const session = { id: "s-1", endpoint: "kimi", title: "重构权限矩阵", lastActive: 100 };
      const states = {
        working: fn(session, { id: "t-1", status: "working" }, "t-1"),
        idle: fn(session, { id: "t-1", status: "idle" }, "t-1"),
        dead: fn(session, null, "t-1"),
      };
      // 不变式②：三种行（working 转圈 / idle 空 / 非 live 空）行首都是同一个常驻
      // 槽——图标出现/消失/互换只动槽内容，标题文字起点不动。
      for (const [name, html] of Object.entries(states)) {
        const slotAt = html.indexOf('<span class="rail-term-slot">');
        const titleAt = html.indexOf('class="rail-term-row-title"');
        assert.ok(slotAt >= 0, `${name} 行行首先渲染常驻槽`);
        assert.ok(titleAt > slotAt, `${name} 行槽在标题之前（空槽也占位）`);
      }
      assert.ok(states.working.indexOf("SPINNER-STUB") > states.working.indexOf('<span class="rail-term-slot">'), "转圈填进常驻槽");
      assert.ok(states.idle.includes('<span class="rail-term-slot"></span>'), "idle 行常驻槽留空（dsh 四态机 idle 不画图标）");
      assert.ok(!states.idle.includes("terminal-tab-state"), "idle 行不再渲染状态点");
      // 不变式①③：几何同式对齐——行 8+16+8 == 组头 8+16+8（32px），行 gap 与组头
      // gap 都是 8、两个槽都是 16 宽，标题与组头文字严格同 x，三种行互相对齐。
      const slot = cssRule(".rail-term-slot {");
      assert.ok(slot.includes("width: 16px") && slot.includes("height: 20px"), "行首槽 16×20（dsh 实测槽）");
      assert.ok(slot.includes("flex: none"), "槽不参与伸缩");
      assert.ok(slot.includes("justify-content: center"), "槽内图标居中（状态互换不产生位移）");
      const row = cssRule(".rail-term-row {");
      assert.ok(/gap: 8px/.test(row) && /padding: 0 8px/.test(row), "行 padding 0 8px + gap 8px（8+16+8=32px 起点）");
      const toggle = cssRule(".rail-term-group-toggle {");
      assert.ok(/gap: 8px/.test(toggle), "组头 gap 8px（8+16+8=32px 起点，与行严格同 x）");
      const groupSlot = cssRule(".rail-term-group-slot {");
      assert.ok(groupSlot.includes("width: 16px") && groupSlot.includes("height: 20px"), "组头槽同 16×20（两槽同宽）");
      // pending「新会话」行同构：兜底行也走常驻槽，标题与历史行对齐
      const pendingSrc = extractFn("terminalRailPendingRowHtml");
      assert.ok(pendingSrc.includes('<span class="rail-term-slot">${working ? TERMINAL_RAIL_SPINNER'), "pending 行行首常驻槽包住转圈/留空");
    });

    it("树渲染指纹门控：同串不重写 DOM，选中/状态变化才重写", () => {
      // 打开列表段拆除后，指纹门控并进树渲染（1s 归属轮询每拍都走，同串不写 DOM）。
      const list = { html: "", writes: 0 };
      Object.defineProperty(list, "innerHTML", {
        get: () => list.html,
        set: (v) => { list.writes += 1; list.html = v; },
      });
      const state = { collapsed: new Set(), scrolled: [] };
      const sandbox = new Function("list", "state", `
        let terminalBackendReady = true;
        const terminalBackendSessions = { t1: { id: "t1", cwd: "C:\\\\dev\\\\alpha", agent: { endpointId: "kimi" }, status: "working", resume: { endpoint: "kimi", id: "s-1" } } };
        let activeTerminalPreviewId = "t1";
        let terminalRailRendered = { history: null };
        let terminalRailAutoExpandedFor = "";
        let terminalRailScrolledFor = "";
        let terminalRailFlipMode = "instant";
        const terminalRailCollapsedGroups = state.collapsed;
        function saveTerminalRailCollapsedGroups() { state.saved = (state.saved || 0) + 1; }
        const terminalRailWatermarks = new Map();
        const terminalRailPrefs = { archived: [], removedGroups: [] };
        const terminalRailViewPrefs = { groupBy: "workspace", orderBy: "updated", archivedFilter: "default", sessionOrder: {} };
        const terminalRailSearch = { open: false, query: "", timer: null, searching: false };
        let terminalRailLastGroups = [];
        const TERMINAL_RAIL_WATERMARK = 5;
        const TERMINAL_RAIL_MOTION_SELECTOR = "[data-rail-term-resume], [data-rail-term-session], [data-rail-term-group-head], [data-rail-term-more]";
        const TERMINAL_RAIL_UNGROUPED_HEAD = "~ungrouped";
        const TERMINAL_RAIL_ICON_CHEVRON = "";
        const TERMINAL_RAIL_ICON_ARCHIVE = "";
        const TERMINAL_RAIL_ICON_UNARCHIVE = "";
        const TERMINAL_RAIL_ICON_ELLIPSIS = "";
        const TERMINAL_RAIL_ICON_PLUS = "";
        const TERMINAL_RAIL_ICON_FOLDER_OPEN = "";
        const TERMINAL_RAIL_ICON_FOLDER_CLOSED = "";
        let terminalRailHistory = { endpoint: "kimi", sessions: [
          { id: "s-1", endpoint: "kimi", project: "C:\\\\dev\\\\alpha", title: "重构权限矩阵", lastActive: 100 },
        ], fetchedAt: 1, error: null };
        function $(id) { return id === "railTermHistoryList" ? list : null; }
        ${extractFn("terminalRailSessionMap")}
        ${extractFn("terminalRailActiveSession")}
        ${extractFn("terminalRailAgentId")}
          ${extractFn("terminalRailFindOpenSession")}
        ${extractFn("terminalRailFindOpenSession")}
        ${extractFn("sessDirName")}
        function sessTitle(s) { return s.title || String(s.id || "").slice(0, 8); }
        function sessRelTime() { return "3 分钟前"; }
        function terminalRailRelTime() { return "3 分钟前"; }
        function esc(v) { return String(v); }
        function escapeHtml(v) { return String(v || ""); }
        function terminalRailScrollGroupIntoView(key) { state.scrolled.push(key); }
        function terminalRailMotionTops() { return null; }
        function playTerminalRailFlip() {}
        function terminalRailMotionEnabled() { return false; }
        function terminalRailPendingRowKeys() { return new Set(); }
        function terminalRailSnapshotMotion() { return new Map(); }
        function terminalRailMountExitGhosts() {}
        let terminalRailLastDiffAgent = null;
        let terminalRailLastDiffSearch = false;
        ${extractFn("terminalRailNormDir")}
        ${extractFn("terminalRailGroupSessions")}
        ${extractFn("terminalRailWatermarkView")}
        ${extractFn("terminalRailNextWatermark")}
        ${extractFn("terminalRailMoreLabel")}
        ${extractFn("terminalRailSameDir")}
        ${extractFn("terminalRailGroupForDir")}
        ${extractFn("terminalRailArchivedKey")}
        ${extractFn("terminalRailIsArchived")}
        ${extractFn("terminalRailVisibleSessions")}
        ${extractFn("terminalRailRegroupRemoved")}
        function terminalRailSelfHealRemovedGroups() { return false; }
        ${extractFn("terminalRailPendingNewTerminals")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
        const TERMINAL_RAIL_SPINNER = "";
        const TERMINAL_RAIL_DONE_DOT = "";
        const terminalDoneUnread = new Map();
        let terminalRailSelectPending = null;
        ${extractFn("terminalRailStateSlotHtml")}
        ${extractFn("terminalRailRowHtml")}
        ${extractFn("terminalRailPendingRowHtml")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
        ${extractFn("renderTerminalRailHistory")}
        return { render: renderTerminalRailHistory, rendered: terminalRailRendered };
      `)(list, state);
      sandbox.render("kimi");
      assert.equal(list.writes, 1, "首帧写入");
      assert.ok(list.html.includes("is-live"), "s-1 有开着终端 → 行内联进树（T1）");
      assert.ok(list.html.includes("is-active"), "聚焦终端的行是选中态（T2）");
      sandbox.render("kimi");
      assert.equal(list.writes, 1, "同串再渲不写 DOM（指纹门控）");
      assert.equal(sandbox.rendered.history, list.html, "指纹恒等于 DOM 现值");
    });
  });

  describe("历史会话点击：续接两分支（vm 真跑）", () => {
    const runResume = (session, apiImpl) => {
      const log = { posts: [], toasts: [], renders: 0, active: null, rememberedCwd: [] };
      const sandbox = new Function("session", "log", "apiImpl", `
        let terminalBackendReady = true;
        const terminalBackendSessions = {};
        let activeTerminalPreviewId = null;
        function api(method, path, body) { log.posts.push({ method, path, body }); return apiImpl(method, path, body); }
        function toast(msg, isErr) { log.toasts.push({ msg, isErr }); }
        function panelError(err, fallback) { return fallback; }
        function terminalBackendSession(item) { return { ...item }; }
        function rememberTerminalSessionId(id) { log.active = id; }
        function rememberTerminalCwd(cwd) { log.rememberedCwd.push(cwd); }
        function renderTerminalPreviewSession() { log.renders += 1; }
        function armTerminalBootingOverlay() {}
        function terminalCreateSize() { return { cols: 120, rows: 34 }; }
        function terminalSessionFor(id) { return terminalBackendSessions[id] || null; }
        const terminalRailPrefs = { archived: [], removedGroups: [] };
        ${extractFn("terminalRailArchivedKey")}
        ${extractFn("terminalRailIsArchived")}
        function terminalCwdInitial() { return "C:\\\\Users\\\\fixture"; }
        ${extractFn("terminalRailSessionMap")}
        ${extractFn("terminalRailFindOpenSession")}
        let terminalRailSelectPending = null;
        let terminalRailSelectSeq = 0;
        const TERMINAL_RAIL_SELECT_TTL_MS = 12000;
        function renderTerminalRail() { log.railRenders = (log.railRenders || 0) + 1; }
        ${extractFn("terminalRailSwitchBusy")}
        ${extractFn("terminalRailBeginSelect")}
        ${extractFn("terminalRailArmSelect")}
        ${extractFn("terminalRailEndSelect")}
        ${extractFn("createAgentTerminal")}
        let terminalSwitchInFlight = false;
        function enrichTerminalSessions() {}
        ${extractFn("terminalRailSwitchOrCreateCore")}
        ${extractFn("terminalRailSwitchOrCreate")}
        ${extractFn("terminalRailResumeSession")}
        return {
          run: () => terminalRailResumeSession(session),
          sessions: terminalBackendSessions,
          activeId: () => activeTerminalPreviewId,
          pending: () => terminalRailSelectPending,
          setBusy: (busy) => { terminalSwitchInFlight = busy; },
          endSelect: (token) => terminalRailEndSelect(token),
        };
      `)(session, log, apiImpl);
      return { sandbox, log };
    };

    const RESUMABLE = {
      endpoint: "kimi", id: "s-1", title: "重构权限矩阵", project: "C:\\dev\\alpha",
      file: "C:\\Users\\fixture\\.kimi\\sessions\\s-1.jsonl", resumeCommand: "kimi --session s-1",
    };

    it("resumeCommand 非空：按 M3 契约 POST，成功即登记会话并置活跃", async () => {
      const { sandbox, log } = runResume(RESUMABLE, async () => ({
        id: "t-9", label: "Kimi Code", agentId: "kimi", agentName: "Kimi Code", shell: "cmd", cwd: "C:\\dev\\alpha",
      }));
      await sandbox.run();
      assert.deepEqual(log.posts, [{
        method: "POST",
        path: "/api/terminal/agent-sessions",
        body: {
          agentId: "kimi",
          cwd: "C:\\dev\\alpha",
          resume: { endpoint: "kimi", id: "s-1", file: "C:\\Users\\fixture\\.kimi\\sessions\\s-1.jsonl" },
          cols: 120,
          rows: 34,
        },
      }], "带 resume:{endpoint,id,file}，cwd 取会话 project，尺寸与新建同拍");
      assert.ok(sandbox.sessions["t-9"], "成功即登记会话");
      assert.equal(sandbox.activeId(), "t-9", "新终端置为活跃");
      assert.equal(log.renders, 1, "成功分支重渲会话");
      assert.equal(log.toasts.length, 0, "成功不提示");
    });

    it("resumeCommand 为空：只提示，不发请求、不做复制命令", async () => {
      const { sandbox, log } = runResume({ ...RESUMABLE, resumeCommand: "" }, async () => {
        throw new Error("不该发请求");
      });
      await sandbox.run();
      assert.deepEqual(log.posts, [], "空 resumeCommand 一律不 POST");
      assert.equal(log.toasts.length, 1, "给一句可执行的解释");
      assert.equal(log.toasts[0].msg, "这个 Agent 的会话暂时不能在终端里续接", "文案逐字取批准清单");
      assert.equal(log.toasts[0].isErr, true, "按错误提示上屏");
      assert.equal(log.renders, 0, "不重渲");
      assert.ok(!extractFn("terminalRailResumeSession").includes("clipboard"), "不做复制命令（用户拍板）");
    });

    it("续接必须落在会话所属项目目录：cwd 取 project，绝不回落到「记住上次」", async () => {
      // 真机缺陷：claude 的会话存档按项目目录分，在错目录下 --resume 找不到那条会话，
      // 还会触发不该有的目录信任提示。这里把「记住上次」设成一个**不同的**目录，
      // 只要实现有任何回落，POST 里的 cwd 就会露出来。
      const { sandbox, log } = runResume(
        { ...RESUMABLE, project: "C:\\Users\\me\\Desktop\\work" },
        async () => ({ id: "t-9", label: "Claude Code", agentId: "claude", shell: "cmd", cwd: "C:\\Users\\me\\Desktop\\work" }),
      );
      await sandbox.run();
      const post = log.posts.find((p) => p.path === "/api/terminal/agent-sessions");
      assert.ok(post, "发起续接请求");
      assert.equal(post.body.cwd, "C:\\Users\\me\\Desktop\\work", "cwd = 会话 project");
      assert.notEqual(post.body.cwd, "C:\\Users\\me\\fixture", "不是「记住上次」的那个目录");
      assert.equal(post.body.resume.id, "s-1", "resume 身份照旧");
    });

    it("取不到可靠项目路径：不发起续接，只提示（不错目录启动）", async () => {
      for (const project of [null, "", "   ", undefined, 123, {}]) {
        const { sandbox, log } = runResume(
          { ...RESUMABLE, project },
          async () => { throw new Error("不该发请求"); },
        );
        await sandbox.run();
        assert.deepEqual(log.posts, [], `project=${JSON.stringify(project)} 时不 POST（否则就是错目录续接）`);
        assert.equal(log.toasts.length, 1, `project=${JSON.stringify(project)} 给一句提示`);
        assert.equal(log.toasts[0].msg, "这个 Agent 的会话暂时不能在终端里续接", "文案逐字取批准清单（不新造）");
        assert.equal(log.toasts[0].isErr, true, "按错误提示上屏");
        assert.equal(sandbox.activeId(), null, "不置活跃、不登记会话");
        assert.deepEqual(Object.keys(sandbox.sessions), [], "不登记会话");
        assert.deepEqual(log.rememberedCwd, [], "不把空/无效目录写进「记住上次」");
      }
    });

    it("续接类短码（resume-unsupported / resume-invalid）一律落批准句，不暴露后端原文", async () => {
      // 真实形状：api() 把服务端 data.error 落 err.code、data.code 落 err.serverCode，
      // 两者都可能是短码；这里按它实际抛出的样子造错（不是随手塞一个 code 字段）。
      const serverError = (status, error, code) => {
        const detail = String(error || "");
        const err = new Error(`HTTP ${status}${detail ? "：" + detail : ""}`);
        err.code = detail;
        if (typeof code === "string") err.serverCode = code;
        return err;
      };
      for (const code of ["resume-unsupported", "resume-invalid"]) {
        const { sandbox, log } = runResume(RESUMABLE, async () => {
          throw serverError(400, code, code);
        });
        await sandbox.run();
        await flush();
        assert.equal(log.toasts.length, 1, `${code}：只提示一次`);
        assert.equal(log.toasts[0].msg, "这个 Agent 的会话暂时不能在终端里续接", `${code}：落批准句，原文不上屏`);
        assert.ok(!log.toasts[0].msg.includes("resume-"), `${code}：短码不外泄`);
        assert.deepEqual(Object.keys(sandbox.sessions), [], `${code}：不登记会话`);
        assert.equal(sandbox.activeId(), null, `${code}：活跃指针不动`);
      }
      // 只有 error 字段是短码、serverCode 缺席（老宿主/转发丢字段）同样拦住
      const bare = runResume(RESUMABLE, async () => { throw serverError(400, "resume-invalid"); });
      await bare.sandbox.run();
      await flush();
      assert.equal(bare.log.toasts[0].msg, "这个 Agent 的会话暂时不能在终端里续接", "只有 error 字段也认");
    });

    it("其它失败落既有兜底文案，不吞错", async () => {
      const { sandbox, log } = runResume(RESUMABLE, async () => {
        // 非续接类失败：api() 的真实形状（detail 落 code、机读信号落 serverCode）
        const err = new Error("HTTP 500：spawn_failed");
        err.code = "spawn_failed";
        throw err;
      });
      await sandbox.run();
      await flush();
      assert.equal(log.toasts.length, 1);
      assert.equal(log.toasts[0].msg, "无法启动这个终端", "非续接类失败走终端创建的既有兜底");
    });

    it("乐观选中（M5）：点击当拍落 pending；新建失败即撤，成功不清（live 接管）", async () => {
      // 点亮发生在调判定门之前：点击当拍高亮成立，不等宿主 1~2s。
      const ok = runResume(RESUMABLE, async () => ({
        id: "t-9", label: "Kimi Code", agentId: "kimi", agentName: "Kimi Code", shell: "cmd", cwd: "C:\\dev\\alpha",
      }));
      ok.sandbox.run();
      assert.deepEqual(ok.sandbox.pending(), { endpoint: "kimi", id: "s-1", terminalId: null, cwd: null, token: 1, timer: ok.sandbox.pending().timer },
        "BeginSelect 当拍落 pending（带端点+会话 id 两键，同 FindOpenSession 口径；全新内切那两键空着）");
      await flush();
      assert.equal(ok.sandbox.activeId(), "t-9", "成功照旧置活跃");
      assert.ok(ok.sandbox.pending() && ok.sandbox.pending().id === "s-1",
        "成功不清：点亮行与 live 派生同一行，自然接管（TTL 兜底会收）");
      ok.sandbox.endSelect(null); // 收尾清计时器（TTL 已 unref，不拖进程）

      // 失败清点：新建失败即撤——点亮的那行没换成，继续说它选中就是说谎。
      const failed = runResume(RESUMABLE, async () => {
        const err = new Error("HTTP 500：spawn_failed");
        err.code = "spawn_failed";
        throw err;
      });
      await failed.sandbox.run();
      await flush();
      assert.equal(failed.sandbox.pending(), null, "新建失败即撤乐观高亮");
      assert.equal(failed.log.toasts.length, 1, "照旧只提示一次");

      // 续接类短码同路：落批准句，pending 同样撤（clear 在分支之前）。
      const unsupported = runResume(RESUMABLE, async () => {
        const err = new Error("HTTP 400：resume-unsupported");
        err.code = "resume-unsupported";
        err.serverCode = "resume-unsupported";
        throw err;
      });
      await unsupported.sandbox.run();
      await flush();
      assert.equal(unsupported.sandbox.pending(), null, "resume-* 失败也撤");
      assert.equal(unsupported.log.toasts[0].msg, "这个 Agent 的会话暂时不能在终端里续接", "落批准句");
    });
  });

  describe("打开的终端行交互（vm 真跑）", () => {
    const runRail = ({ sessions, activeId = "t1", tabs = null }) => {
      const log = { renders: 0, remembered: [] };
      const els = { terminalTabs: tabs };
      const sandbox = new Function("sessions", "activeId", "log", "els", `
        const terminalBackendSessions = sessions;
        let activeTerminalPreviewId = activeId;
        const terminalDoneUnread = new Map();
        let terminalRailSelectPending = null;
        let terminalRailSelectSeq = 0;
        let terminalSwitchInFlight = false;
        const TERMINAL_RAIL_SELECT_TTL_MS = 12000;
        function renderTerminalRail() { log.railRenders = (log.railRenders || 0) + 1; }
        ${extractFn("terminalRailSwitchBusy")}
        ${extractFn("terminalRailBeginSelect")}
        ${extractFn("terminalRailArmSelect")}
        ${extractFn("terminalRailEndSelect")}
        function $(id) { return els[id] ?? null; }
        function terminalSessionFor(id) { return terminalBackendSessions[id] || null; }
        function rememberTerminalSessionId(id) { log.remembered.push(id); }
        function renderTerminalPreviewSession() { log.renders += 1; }
        ${extractFn("terminalRailActivateSession")}
        ${extractFn("terminalRailCloseSession")}
        return {
          activate: terminalRailActivateSession,
          close: terminalRailCloseSession,
          activeId: () => activeTerminalPreviewId,
          markDone: (id) => terminalDoneUnread.set(id, true),
          done: (id) => terminalDoneUnread.has(id),
          begin: (session) => terminalRailBeginSelect(session),
          endSelect: (token) => terminalRailEndSelect(token),
          pending: () => terminalRailSelectPending,
          seq: () => terminalRailSelectSeq,
        };
      `)(sessions, activeId, log, els);
      return { sandbox, log };
    };

    it("点击行切换活跃终端：置活跃、写存档、重渲一次", () => {
      const { sandbox, log } = runRail({
        sessions: { t1: { id: "t1" }, t2: { id: "t2" } },
      });
      sandbox.activate("t2");
      assert.equal(sandbox.activeId(), "t2", "活跃指针切到点中的终端");
      assert.deepEqual(log.remembered, ["t2"], "存档同步写回（刷新恢复才认得这条）");
      assert.equal(log.renders, 1, "重渲一次（会话屏与页签、左栏同拍）");
    });

    it("点当前活跃终端 / 不存在的 id / 空 id：一律不动手，不重渲", () => {
      const { sandbox, log } = runRail({ sessions: { t1: { id: "t1" } } });
      sandbox.activate("t1");
      sandbox.activate("ghost");
      sandbox.activate("");
      sandbox.activate(null);
      assert.equal(sandbox.activeId(), "t1", "活跃指针原样");
      assert.deepEqual(log.remembered, [], "不写存档");
      assert.equal(log.renders, 0, "不重渲");
    });

    it("done（跑完未读）：点行即读——点它的行/点焦点行都当场清标", () => {
      const { sandbox } = runRail({ sessions: { t1: { id: "t1" }, t2: { id: "t2" } }, activeId: "t1" });
      sandbox.markDone("t2");
      sandbox.activate("t2");
      assert.equal(sandbox.activeId(), "t2", "活跃指针切换");
      assert.ok(!sandbox.done("t2"), "点行＝已读，标记当场清");
      sandbox.markDone("t1");
      sandbox.markDone("t2");
      sandbox.activate("t2");
      assert.ok(!sandbox.done("t2"), "点已在焦点上的行同样清（清标在早退前，幂等）");
      assert.ok(sandbox.done("t1"), "别的会话的标记不受牵连");
    });

    it("乐观选中（M5）：activate 无条件作废旧令牌；EndSelect 令牌不匹配 no-op", () => {
      const { sandbox, log } = runRail({ sessions: { t1: { id: "t1" }, t2: { id: "t2" } }, activeId: "t1" });
      // 改主意清点：点 live 行（activate）前先有一发在飞的乐观选中（resume 路径落的）。
      sandbox.begin({ endpoint: "kimi", id: "s-1" });
      const stale = sandbox.pending().token;
      assert.equal(stale, 1, "BeginSelect 领到令牌 1");
      sandbox.activate("t2");
      assert.equal(sandbox.pending(), null, "activate 无条件作废旧令牌——置活跃即由 live 派生接管");
      assert.equal(sandbox.activeId(), "t2", "置活跃照旧");
      assert.equal(log.renders, 1, "仍只重渲一次（快路径让帧不改变重渲次数）");

      // 令牌不匹配 no-op：迟到的旧切换清不掉新点击的高亮。
      sandbox.begin({ endpoint: "kimi", id: "s-1" });
      const fresh = sandbox.pending().token;
      assert.equal(fresh, sandbox.seq(), "再次 BeginSelect 领到当前 seq 作令牌（activate 作废时已推进）");
      sandbox.endSelect(999);
      assert.ok(sandbox.pending(), "旧令牌（999）不匹配 → no-op，新高亮留着");
      sandbox.endSelect(fresh);
      assert.equal(sandbox.pending(), null, "匹配即清");
    });

    it("关闭叉走页签同一条处理：点到对应页签里那颗 ×，不复制第二份关闭逻辑", () => {
      const clicked = [];
      const makeTab = (id, closeEl) => ({
        getAttribute: (name) => (name === "data-terminal-tab" ? id : null),
        querySelector: (sel) => (sel === ".terminal-tab-close" ? closeEl : null),
      });
      const other = { click: () => clicked.push("other") };
      const target = { click: () => clicked.push("t2") };
      const tabs = { querySelectorAll: () => [makeTab("t1", other), makeTab("t2", target)] };
      const { sandbox, log } = runRail({ sessions: { t1: {}, t2: {} }, tabs });
      sandbox.close("t2");
      assert.deepEqual(clicked, ["t2"], "只点目标页签的关闭叉（运行中确认/POST/空态计数全由那一处承担）");
      assert.equal(log.renders, 0, "关闭逻辑不在本函数里重写——不自己删会话、不自己重渲");
    });

    it("页签条缺席或找不到对应页签：静默返回，不炸", () => {
      const absent = runRail({ sessions: { t1: {} }, tabs: null });
      absent.sandbox.close("t1");
      assert.equal(absent.log.renders, 0, "页签条不存在时不动手");

      const clicked = [];
      const tabs = { querySelectorAll: () => [{
        getAttribute: () => "t1",
        querySelector: () => ({ click: () => clicked.push("t1") }),
      }] };
      const missing = runRail({ sessions: { t1: {}, t2: {} }, tabs });
      missing.sandbox.close("t9");
      assert.deepEqual(clicked, [], "id 对不上时什么都不点");
    });
  });

  describe("乐观选中态（M5）：行选中判据 pending 优先（vm 真跑）", () => {
    // 行 HTML 直判：同一份 pending 状态下两行各渲一次，等价于一屏——「一屏至多
    // 一条选中」由判据本身保证（pending 存在时只有命中行亮）。
    const rowSandbox = () => new Function("log", `
      const log2 = log;
      const TERMINAL_RAIL_ICON_ARCHIVE = "<svg></svg>";
      const TERMINAL_RAIL_ICON_UNARCHIVE = "<svg></svg>";
      function sessTitle(s) { return s.title || String(s.id || "").slice(0, 8); }
      function terminalRailRelTime() { return "3 分钟前"; }
      function terminalRailIsArchived() { return false; }
      function esc(v) { return String(v); }
      function escapeHtml(v) { return String(v || ""); }
      const TERMINAL_RAIL_SPINNER = "";
      const TERMINAL_RAIL_DONE_DOT = "";
      const terminalDoneUnread = new Map();
      function terminalRailSessionMap() { return {}; }
      let terminalRailSelectPending = null;
      let terminalRailSelectSeq = 0;
      let terminalSwitchInFlight = false;
      const TERMINAL_RAIL_SELECT_TTL_MS = 12000;
      function renderTerminalRail() { log2.rails += 1; }
      ${extractFn("terminalRailSwitchBusy")}
      ${extractFn("terminalRailBeginSelect")}
        ${extractFn("terminalRailArmSelect")}
      ${extractFn("terminalRailEndSelect")}
      ${extractFn("terminalRailStateSlotHtml")}
      ${extractFn("terminalRailRowHtml")}
      ${extractFn("terminalRailPendingRowHtml")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
      return {
        row: terminalRailRowHtml,
        pendingRow: terminalRailPendingRowHtml,
        begin: (session) => terminalRailBeginSelect(session),
        endSelect: (token) => terminalRailEndSelect(token),
        pending: () => terminalRailSelectPending,
      };
    `)({ rails: 0 });

    it("pending 命中非 live 行当拍亮；同期 live 活跃行立刻失亮", () => {
      const fn = rowSandbox();
      const live = { id: "t-1", status: "idle" };
      const oldActiveRow = { id: "s-1", endpoint: "kimi", title: "甲" };
      const targetRow = { id: "s-2", endpoint: "kimi", title: "乙" };
      // 无 pending：原判（live 派生）——s-1 亮、s-2 不亮。
      assert.ok(fn.row(oldActiveRow, live, "t-1").includes("is-active"), "基线：live 活跃行亮");
      assert.ok(!fn.row(targetRow, null, "t-1").includes("is-active"), "基线：非活跃行不亮");

      fn.begin({ endpoint: "kimi", id: "s-2" });
      const hit = fn.row(targetRow, null, "t-1");
      const old = fn.row(oldActiveRow, live, "t-1");
      assert.ok(hit.includes("is-active"), "pending 命中的非 live 行当拍亮（不等宿主 1~2s）");
      assert.ok(!old.includes("is-active"), "同期旧活跃行失亮——pending 优先于 live 派生，高亮不说谎");
      assert.equal((hit.match(/is-active/g) || []).length, 1, "一行只带一个 is-active");
      // 同 id 不同端点是另一条会话（FindOpenSession 两键口径）：不误亮。
      assert.ok(!fn.row({ id: "s-2", endpoint: "claude", title: "乙" }, null, "t-1").includes("is-active"),
        "端点不同不误亮（两键比对）");

      // 收尾后回到 live 派生。
      fn.endSelect(fn.pending().token);
      assert.equal(fn.pending(), null, "匹配令牌收尾即清");
      assert.ok(!fn.row(targetRow, null, "t-1").includes("is-active"), "收尾后非 live 行不再占选中");
      assert.ok(fn.row(oldActiveRow, live, "t-1").includes("is-active"), "回到 live 派生（旧活跃行复位）");
    });

    it("pending 期间「新会话」兜底行不亮；无 pending 维持原判", () => {
      const fn = rowSandbox();
      const entry = { id: "t-9" };
      fn.begin({ endpoint: "kimi", id: "s-2" });
      assert.ok(!fn.pendingRow(entry, "t-9").includes("is-active"),
        "pending 期间兜底行不亮——它没有历史身份，pending 命中的永远是历史行");
      fn.endSelect(null);
      assert.ok(fn.pendingRow(entry, "t-9").includes("is-active"), "无 pending 时维持原判（活跃兜底行照常亮）");
    });

    it("BeginSelect 只重渲栏（不碰终端屏重建）；在飞时不亮", () => {
      const log = { rails: 0 };
      const fn = new Function("log", `
        const log2 = log;
        let terminalRailSelectPending = null;
        let terminalRailSelectSeq = 0;
        let terminalSwitchInFlight = false;
        const TERMINAL_RAIL_SELECT_TTL_MS = 12000;
        let screenRuns = 0;
        function renderTerminalRail() { log2.rails += 1; }
        function renderTerminalPreviewSession() { screenRuns += 1; }
        ${extractFn("terminalRailSwitchBusy")}
        ${extractFn("terminalRailBeginSelect")}
        ${extractFn("terminalRailArmSelect")}
        ${extractFn("terminalRailEndSelect")}
        return {
          begin: (session) => terminalRailBeginSelect(session),
          endSelect: (token) => terminalRailEndSelect(token),
          pending: () => terminalRailSelectPending,
          setBusy: (busy) => { terminalSwitchInFlight = busy; },
          screenRuns: () => screenRuns,
        };
      `)(log);
      fn.begin({ endpoint: "kimi", id: "s-2" });
      assert.equal(log.rails, 1, "BeginSelect 只重渲栏一帧");
      assert.equal(fn.screenRuns(), 0, "不触发终端屏重建（xterm 那 1~2s 不在高亮的关键路径上）");
      fn.setBusy(true);
      fn.endSelect(null);
      fn.begin({ endpoint: "kimi", id: "s-3" });
      assert.equal(fn.pending(), null, "在飞时不亮（亮也会被判定门静默吞掉——高亮说谎比慢更糟）");
      fn.setBusy(false);
      fn.begin({ endpoint: "kimi", id: "s-3" });
      assert.ok(fn.pending() && fn.pending().id === "s-3", "放行后才点亮");
      fn.endSelect(null);
    });
  });

  describe("未就绪不泄漏设计稿预览种子（缺陷 B）", () => {
    const run = (ready, backendSessions, previewSessions, activeId = "t1") => {
      const fn = new Function("ready", "backendSessions", "previewSessions", "activeId", `
        let terminalBackendReady = ready;
        const terminalBackendSessions = backendSessions;
        const terminalPreviewSessions = previewSessions;
        const activeTerminalPreviewId = activeId;
        function terminalSessionMap() { return terminalBackendReady ? terminalBackendSessions : terminalPreviewSessions; }
        ${extractFn("terminalRailSessionMap")}
        ${extractFn("terminalRailFindOpenSession")}
        ${extractFn("terminalRailActiveSession")}
          ${extractFn("terminalRailAgentId")}
          ${extractFn("terminalRailFindOpenSession")}
        ${extractFn("terminalRailAgentId")}
          ${extractFn("terminalRailFindOpenSession")}
        return { agentId: terminalRailAgentId, findOpen: terminalRailFindOpenSession };
      `)(ready, backendSessions, previewSessions, activeId);
      return fn;
    };

    // 设计稿遗留的预览种子：未就绪时 terminalSessionMap 会回落这张表
    const PREVIEW = {
      checkout: { id: "checkout", label: "demo-service", shell: { name: "PowerShell" }, agent: null, status: "idle" },
      "preview-1": { id: "preview-1", label: "新终端", shell: { name: "PowerShell" }, agent: null, status: "idle" },
    };
    const BACKEND = {
      t1: { id: "t1", label: "Claude Code", shell: { name: "命令提示符" }, agent: { endpointId: "claude" }, status: "idle" },
    };

    it("未就绪：树里一条 live 行都不出——预览种子不许冒充真实终端", () => {
      // live 判定经 terminalRailSessionMap（未就绪即空）：种子的 id/身份一律采不到。
      const fn = run(false, BACKEND, PREVIEW, "checkout");
      assert.equal(fn.findOpen("", "checkout"), null, "未就绪时找不到开着终端，种子不进树");
      assert.equal(fn.findOpen("kimi", "checkout"), null, "带身份也采不到（那不是真实终端）");
    });

    it("未就绪：栏体的 agent 来源取不到真值，不冒充种子里的 agent", () => {
      const fn = run(false, BACKEND, PREVIEW, "checkout");
      assert.equal(fn.agentId(), "", "未就绪时 agent 来源为空");
      const withAgentSeed = { ...PREVIEW, checkout: { ...PREVIEW.checkout, agent: { endpointId: "kimi" } } };
      const fn2 = run(false, BACKEND, withAgentSeed, "checkout");
      assert.equal(fn2.agentId(), "", "就算种子自带 agent 身份也不采信（那不是真实终端）");
    });

    it("就绪后照常按真实终端判 live、agent 来源跟随真实归属", () => {
      const ready = { ...BACKEND, t1: { ...BACKEND.t1, resume: { endpoint: "claude", id: "s-1" } } };
      const fn = run(true, ready, PREVIEW, "t1");
      assert.equal(fn.findOpen("claude", "s-1").id, "t1", "就绪时只认真实后端会话的 resume 记录");
      assert.equal(fn.agentId(), "claude", "身份取真实会话的归属");
    });

    it("源码钉死：栏体入口都不读预览种子表", () => {
      const src = extractFn("terminalRailFindOpenSession") + extractFn("terminalRailAgentId");
      assert.ok(!src.includes("terminalSessionMap"), "live 判定与 agent 来源都不直读会回落种子的表");
      const map = extractFn("terminalRailSessionMap");
      assert.ok(map.includes("terminalBackendReady"), "先看就绪位：未就绪一律空");
      assert.ok(!map.includes("terminalPreviewSessions"), "就绪位的假分支不回落到预览种子表");
      assert.ok(extractFn("terminalRailAgentId").includes("terminalRailActiveSession"), "agent 来源同样只认后端真值");
      assert.ok(extractFn("renderTerminalRailHistory").includes("terminalRailActiveSession"), "树里找活跃组同样不读种子");
    });
  });

  describe("刷新落回终端视图与点击进入同一条补连链（缺陷 A）", () => {
    const run = (hostState, { ready = false, view = "terminal", manualStop = false } = {}) => {
      const log = { connected: 0, applied: [], switched: [] };
      const fn = new Function("hostState", "ready", "view", "manualStop", "log", `
        let terminalBackendReady = ready;
        let terminalHostState = "unknown";
        let terminalFirstConnectSettled = true;
        let currentView = view;
        let terminalHostOpInFlight = false;
        function api(method, path) {
          if (path === "/api/terminal/host/status") return Promise.resolve({ state: hostState, manualStop });
          return Promise.resolve({});
        }
        function switchView(name) { currentView = name; log.switched.push(name); }
        function applyTerminalHostState(state, opts) { terminalHostState = state; log.applied.push(state); }
        function connectTerminalBackend() { log.connected += 1; }
        function clearTerminalLocalSessions() {}
        function renderTerminalStoppedState() { log.stopped = true; }
        function renderTerminalUnavailableState() { log.unavailable = true; }
        function autoStartTerminalHost() { log.autoStart = (log.autoStart || 0) + 1; }
        function normalizeTerminalHostState(raw) {
          if (raw === "running") return "running";
          if (raw === "stopped" || raw === "stopped-manual") return "stopped";
          if (raw === "exited" || raw === "crashed") return "exited";
          return "unknown";
        }
        ${extractFn("dispatchTerminalEntry")}
        ${extractFn("resumeTerminalBackendAfterEntry")}
        return {
          run: () => dispatchTerminalEntry().then(resumeTerminalBackendAfterEntry),
          ready: () => terminalBackendReady,
          view: () => currentView,
        };
      `)(hostState, ready, view, manualStop, log);
      return { fn, log };
    };

    it("宿主在跑且本地未就绪：补连一次（与点击进入同一条分派）", async () => {
      const { fn, log } = run("running");
      await fn.run();
      assert.deepEqual(log.applied, ["running"], "先按现取的真值落宿主状态");
      assert.equal(log.connected, 1, "未就绪即补连——这正是刷新恢复缺的那一步");
    });

    it("宿主在跑且已就绪：不重复连接", async () => {
      const { fn, log } = run("running", { ready: true });
      await fn.run();
      assert.equal(log.connected, 0, "已就绪不空连");
    });

    it("宿主已停（手动）：清缓存落停止态，不补连", async () => {
      const { fn, log } = run("stopped", { manualStop: true });
      await fn.run();
      assert.equal(log.connected, 0, "停着不补连");
      assert.ok(!log.autoStart, "手动关停不擅自拉起");
      assert.equal(log.stopped, true, "落「已停止」页");
    });

    it("宿主异常退出：拉起一次", async () => {
      const { fn, log } = run("exited");
      await fn.run();
      assert.equal(log.autoStart, 1, "非手动原因的未运行自动拉起");
      assert.equal(log.connected, 0, "拉起期间不补连");
    });

    it("宿主状态不可知：落不可用空态", async () => {
      const { fn, log } = run("unknown");
      await fn.run();
      assert.equal(log.unavailable, true, "读不到就落既有不可用空态");
    });

    it("源码钉死：restoreView 的终端分支走同一条分派，不再裸 switchView", () => {
      const restore = extractFn("restoreView");
      const at = restore.indexOf("if (terminalOpen)");
      assert.ok(at > 0, "终端恢复分支可取样");
      const branch = restore.slice(at, restore.indexOf("} else if (settingsOpen)", at));
      assert.ok(branch.includes("dispatchTerminalEntry()"), "刷新落回终端视图与点击进入共用同一条宿主状态分派");
      const open = extractFn("openTerminalPreview");
      assert.ok(open.includes("dispatchTerminalEntry()"), "点击进入同样走这条分派（单一实现）");
      assert.ok(!open.includes('api("GET", "/api/terminal/host/status")'), "现取宿主状态已收进分派函数，点击路径不另写一份");
    });
  });

  describe("栏体渲染不得把连接成功翻成失败（缺陷 A 的结构性根因）", () => {
    const runConnect = (railThrows) => {
      const log = { ready: false, warns: [], unavailable: 0, rendered: 0 };
      const fn = new Function("railThrows", "log", `
        let terminalBackendReady = false;
        let terminalFirstConnectSettled = false;
        let terminalHostState = "running";
        function $(id) { return { disabled: false }; }
        function fetchTerminalSessions() { terminalBackendReady = true; return Promise.resolve(); }
        function renderTerminalPreviewSession() { log.rendered += 1; }
        function pollTerminalSessions() {}
        function syncTerminalActivityStream() {}
        function reportTerminalThemeToBackend() {}
        function renderTerminalStoppedState() {}
        function renderTerminalUnavailableState() { log.unavailable += 1; }
        function renderTerminalRail() { if (railThrows) throw new Error("rail boom"); }
        const console = { warn: (...a) => log.warns.push(a.join(" ")) };
        ${extractFn("syncTerminalAddBtn")}
        ${extractFn("connectTerminalBackend")}
        return { connect: connectTerminalBackend, ready: () => terminalBackendReady, settled: () => terminalFirstConnectSettled };
      `)(railThrows, log);
      return { fn, log };
    };

    it("栏体渲染抛错：连接仍算成功、就绪位仍落定，不落「终端服务未运行」", async () => {
      const { fn, log } = runConnect(true);
      await fn.connect();
      assert.equal(fn.ready(), true, "连接本身成功——栏体是旁挂渲染，不许把成功翻成失败");
      assert.equal(fn.settled(), true, "首连定性位照常落定");
      assert.equal(log.unavailable, 0, "不落降级空态");
      assert.equal(log.rendered, 1, "会话渲染照常发生");
    });

    it("栏体渲染正常：行为不变（成功链三件套各一拍）", async () => {
      const { fn, log } = runConnect(false);
      await fn.connect();
      assert.equal(fn.ready(), true, "就绪");
      assert.equal(log.rendered, 1, "渲染一次");
      assert.equal(log.warns.length, 0, "无告警");
    });

    it("源码钉死：栏体渲染在连接链里是旁挂调用，异常不外溢", () => {
      const sync = extractFn("syncTerminalAddBtn");
      assert.ok(sync.includes("try"), "栏体渲染包在 try 里——它读 DOM/会话表，任何异常都不该决定连接成败");
      const connect = extractFn("connectTerminalBackend");
      assert.ok(!/^\s*renderTerminalRail\(\);$/m.test(connect.split(".then(")[1] || ""),
        "连接成功链里不裸调栏体渲染");
    });
  });

  describe("进终端页的补连：单飞去重（复审必修 1）", () => {
    // 基线遗留行「进页未就绪先补连」与共享分派叠用：running 时同一进页会连两次。
    // connectTerminalBackend 没有 in-flight 去重，两次成功链各跑一次
    // renderTerminalPreviewSession/connectTerminalStream（xterm 重建两遍），后发失败
    // 还会把就绪位翻回 false——正是要消除的停态。这里按行为断言，不看字符串。
    // runOpen 的 known 形参 = 进页那一刻「上一帧宿主态」（1s 轮询维护的那个值），
    // 它决定 openTerminalPreview 的预连守卫是否放行。默认 "unknown"（面板初载的
    // 真实形态）；测「双连」那条必须传 "running"——否则预连从不触发，唯一一发
    // 来自分派路径，断言「恰 1 发」就是同义反复，去掉单飞也照样绿（判别力为零）。
    const runOpen = (hostState, { ready = false, known = "unknown" } = {}) => {
      const log = { fetches: 0, renders: 0, applied: [], switched: [], stopped: false, autoStart: 0, pending: [] };
      const sandbox = new Function("hostState", "ready", "known", "log", `
        let terminalBackendReady = ready;
        let terminalFirstConnectSettled = false;
        let terminalHostState = known;
        let currentView = "board";
        let terminalReturnView = "board";
        let terminalReturnScrollTop = 0;
        const window = { scrollY: 0 };
        const document = { documentElement: { scrollTop: 0 } };
        function $(id) { return null; }
        function api(method, path) {
          if (path === "/api/terminal/host/status") return Promise.resolve({ state: hostState, manualStop: false });
          return Promise.resolve({});
        }
        function switchView(name) { currentView = name; log.switched.push(name); }
        function applyTerminalHostState(state) { terminalHostState = state; log.applied.push(state); }
        function normalizeTerminalHostState(raw) {
          if (raw === "running") return "running";
          if (raw === "stopped" || raw === "stopped-manual") return "stopped";
          if (raw === "exited" || raw === "crashed") return "exited";
          return "unknown";
        }
        function clearTerminalLocalSessions() {}
        function renderTerminalStoppedState() { log.stopped = true; }
        function renderTerminalUnavailableState() { log.unavailable = true; }
        function autoStartTerminalHost() { log.autoStart += 1; }
        // 连接请求挂起：真实网络有往返时延，双连正是发生在这段窗口里
        // （进页先补连 → 分派拿到宿主状态时第一发还没回来 → 又补一次）。
        function fetchTerminalSessions() {
          log.fetches += 1;
          return new Promise((resolve) => {
            log.pending.push(() => { terminalBackendReady = true; resolve(); });
          });
        }
        function syncTerminalAddBtn() {}
        function renderTerminalPreviewSession() { log.renders += 1; }
        function pollTerminalSessions() {}
        function syncTerminalActivityStream() {}
        function reportTerminalThemeToBackend() {}
        ${extractFn("connectTerminalBackend")}
        ${extractFn("dispatchTerminalEntry")}
        ${extractFn("resumeTerminalBackendAfterEntry")}
        ${extractFn("openTerminalPreview")}
        return { open: openTerminalPreview, ready: () => terminalBackendReady };
      `)(hostState, ready, known, log);
      return { sandbox, log };
    };

    it("running + 未就绪：真正发出的连接请求恰为 1（不双连、xterm 不重建两遍）", async () => {
      // known:"running" 是关键——预连守卫（terminalHostState === "running"）必须放行，
      // 否则这条测不到双连（同义反复）。断言预连确实发出：挂起队列里恰有一发在飞。
      const { sandbox, log } = runOpen("running", { known: "running" });
      await sandbox.open();                       // 进页：先补连（挂起），再分派
      assert.equal(log.pending.length, 1, "预连确实发出（一发生效的请求在飞）");
      assert.equal(log.fetches, 1, "分派那一步不该再发第二发（第一发还在飞）");
      for (const settle of log.pending) settle(); // 连接返回
      await flush();
      await flush();
      assert.equal(log.fetches, 1, "整次进页只发一次连接请求（单飞去重）");
      assert.equal(log.renders, 1, "成功链只跑一次会话渲染（xterm 不会重建两遍）");
      assert.equal(sandbox.ready(), true, "就绪位落定");
    });

    it("running + 已就绪：一次都不连", async () => {
      const { sandbox, log } = runOpen("running", { ready: true });
      await sandbox.open();
      assert.equal(log.fetches, 0, "已就绪不空连");
    });

    it("stopped / exited：不发明知必败的拉取，改走拉起", async () => {
      for (const state of ["stopped", "exited"]) {
        const { sandbox, log } = runOpen(state);
        await sandbox.open();
        assert.equal(log.fetches, 0, `${state} 时不发注定失败的连接请求`);
        assert.equal(log.autoStart, 1, `${state} 时拉起宿主`);
      }
    });

    it("unknown：不连，落不可用空态", async () => {
      const { sandbox, log } = runOpen("unknown");
      await sandbox.open();
      assert.equal(log.fetches, 0, "状态不可知时不连");
      assert.equal(log.unavailable, true, "落既有不可用空态");
    });
  });

  describe("connectTerminalBackend 单飞（复审必修 1 的根因修法）", () => {
    const runConnect = () => {
      const log = { fetches: 0, renders: 0, settled: 0 };
      const sandbox = new Function("log", `
        let terminalBackendReady = false;
        let terminalFirstConnectSettled = false;
        let terminalHostState = "running";
        function fetchTerminalSessions() {
          log.fetches += 1;
          return log.failNext
            ? Promise.reject(new Error("boom"))
            : Promise.resolve().then(() => { terminalBackendReady = true; });
        }
        function syncTerminalAddBtn() {}
        function renderTerminalPreviewSession() { log.renders += 1; }
        function pollTerminalSessions() {}
        function syncTerminalActivityStream() {}
        function reportTerminalThemeToBackend() {}
        function renderTerminalStoppedState() {}
        function renderTerminalUnavailableState() { log.unavailable = true; }
        ${extractFn("connectTerminalBackend")}
        return { connect: connectTerminalBackend, ready: () => terminalBackendReady };
      `)(log);
      return { sandbox, log };
    };

    it("进行中并发调用：只发一次请求，两处拿到同一条 Promise", async () => {
      const { sandbox, log } = runConnect();
      const a = sandbox.connect();
      const b = sandbox.connect();
      assert.equal(a, b, "进行中返回同一条 Promise（单飞）");
      await Promise.all([a, b]);
      assert.equal(log.fetches, 1, "只发一次连接请求");
      assert.equal(log.renders, 1, "成功链只跑一次");
    });

    it("失败后缓存必须清掉：下一次调用能重新发起（不是永久卡死）", async () => {
      const { sandbox, log } = runConnect();
      log.failNext = true;
      await sandbox.connect();
      assert.equal(log.fetches, 1, "第一次失败");
      log.failNext = false;
      await sandbox.connect();
      assert.equal(log.fetches, 2, "失败后可以重试（缓存已清）");
      assert.equal(sandbox.ready(), true, "重试成功即就绪");
    });

    it("成功后缓存也要清掉：稳态下后续调用照常发起", async () => {
      const { sandbox, log } = runConnect();
      await sandbox.connect();
      await sandbox.connect();
      assert.equal(log.fetches, 2, "成功后不缓存结果（下次仍可重连）");
    });
  });

  describe("渲染挂点与刷新纪律（源码钉死）", () => {
    it("历史会话只在进终端视图拉一次：switchView 挂 enterTerminalRail，轮询不碰会话列表", () => {
      const sw = extractFn("switchView");
      const termBranch = sw.slice(sw.indexOf("if (terminal) {"));
      const branchBody = termBranch.slice(0, termBranch.indexOf("\n    }"));
      assert.ok(branchBody.includes("enterTerminalRail()"), "进终端视图即挂一次终端会话栏");
      const fetchSrc = panelJs.match(/async function refreshTerminalRailHistory\([\s\S]*?\n  \}/)?.[0];
      assert.ok(fetchSrc, "refreshTerminalRailHistory 在册");
      assert.ok(fetchSrc.includes('api("GET", force ? "/api/sessions/list?refresh=1" : "/api/sessions/list")'),
        "历史会话数据源是会话列表接口（追赶路径带 ?refresh=1：等真扫描落地）");
      const poll = panelJs.match(/async function pollTerminalSessions\([\s\S]*?\n  \}/)?.[0];
      assert.ok(poll, "pollTerminalSessions 在册");
      assert.ok(!poll.includes('api("GET", "/api/sessions/list'), "1s 轮询自己不抓全量扫盘");
      // 追赶是唯一的在页内刷新路径，且自带闸：20s 最小间隔＋在飞去重，扫盘不连排。
      const catchUp = extractFn("maybeCatchUpTerminalRailHistory");
      assert.ok(catchUp.includes("TERMINAL_RAIL_CATCHUP_MIN_MS") && catchUp.includes("terminalRailFetchInFlight"),
        "追赶路径有最小间隔闸与在飞去重（不能把 6.7s 扫盘挂成轮询）");
      assert.ok(poll.includes("maybeCatchUpTerminalRailHistory()"), "轮询收尾问一次「有没有可疑兜底行要补」");
      assert.ok(extractFn("enterTerminalRail").includes("renderTerminalRail()"), "进页即渲一帧（不必等轮询）");
      // D4：段头刷新钮已砍（用户拍板只留搜索/视图选项）——手动重取入口随之消失，
      // 列表拉取只剩「进终端视图一次 + 换 agent 补拉」两条自动路径。
      assert.ok(!panelJs.includes("railTermHistoryRefresh"), "刷新钮本体/绑定/锚点全清净（M9-D4）");
    });

    it("渲染挂点：会话渲染、归属轮询、就绪位三处同拍重渲栏体（typeof 闸护桩环境）", () => {
      const render = extractFn("renderTerminalPreviewSession");
      assert.ok(render.includes("if (typeof renderTerminalRail === \"function\") renderTerminalRail();"),
        "会话渲染即同步栏体（切页签/新建/关闭/归属恢复都经这里）");
      assert.ok(render.indexOf("renderTerminalRail();") < render.indexOf("if (terminalBackendReady === false)"),
        "栏体渲染在就绪三态闸之前：降级/零会话时左栏照常可用（新建自带就绪闸）");
      const poll = panelJs.match(/async function pollTerminalSessions\([\s\S]*?\n  \}/)?.[0];
      assert.ok(poll.includes("if (typeof renderTerminalRail === \"function\") renderTerminalRail();"),
        "1s 归属轮询同拍同步（归属变化要立刻反映到身份行与打开的终端）");
      const sync = extractFn("syncTerminalAddBtn");
      assert.ok(sync.includes("if (typeof renderTerminalRail === \"function\") renderTerminalRail();"),
        "就绪位变化与「新建终端」禁用态同拍");
      assert.ok(extractFn("renderTerminalRail").includes('if (currentView !== "terminal") return;'),
        "栏体只在终端视图露出，别处不白跑渲染");
    });

    it("live 行快路径让帧（M5）：停放/建流/fit 成对延后双 rAF，帧令牌保连点（源码+vm 真跑）", async () => {
      const render = extractFn("renderTerminalPreviewSession");
      assert.ok(render.includes("{ revive = true, deferScreen = false } = {}"), "开关默认关，其余调用点行为不变");
      const branch = render.slice(render.indexOf("if (deferScreen)"));
      assert.ok(branch.includes("requestAnimationFrame(() => requestAnimationFrame(runDeferredScreen))"),
        "双 rAF 调度（一帧给渲染器排程、一帧给合成器上屏）");
      assert.ok(branch.indexOf("parkTerminalScreen();") < branch.indexOf("connectTerminalStream(session, { revive });"),
        "停放排在建流之前：92f6ced 垫片次序，park 与 connect 成对延后");
      assert.ok(branch.includes('if (currentView === "terminal") scheduleTerminalFit();'), "fit 同组延后");
      assert.ok(branch.includes("if (terminalScreenSeq !== screenSeq) return;"), "帧令牌：连点时旧帧醒来即退场");
      // 非 defer 路径保持同步直排（panel-terminal-loading 的切换入口断言同款字面）
      assert.ok(render.includes("if (typeof parkTerminalScreen === \"function\") parkTerminalScreen();\n    connectTerminalStream(session, { revive });"),
        "默认路径原样：停放→建流同步直排");
      const passers = panelJs.match(/renderTerminalPreviewSession\(\{[^}]*deferScreen[^}]*\}\)/g) || [];
      assert.equal(passers.length, 1, "只有一处传 deferScreen");
      assert.ok(extractFn("terminalRailActivateSession").includes("renderTerminalPreviewSession({ deferScreen: true })"),
        "传它的只有 terminalRailActivateSession（live 行快路径）");

      // vm 真跑：栏体先渲、屏重建延后；连点只有最新一帧执行。
      const log = { order: [], frames: 0 };
      const fn = new Function("log", `
        const order = log.order;
        let currentView = "terminal";
        let terminalBackendReady = true;
        let terminalFirstConnectSettled = true;
        const terminalBackendSessions = { t1: { id: "t1" } };
        let activeTerminalPreviewId = "t1";
        let terminalScreenSeq = 0;
        const document = { hidden: false, querySelector: () => null };
        function $(id) { return null; }
        function terminalSessionFor(id) { return terminalBackendSessions[id] || null; }
        function renderTerminalRail() { order.push("rail"); }
        function renderTerminalSessionData() { order.push("data"); }
        function renderTerminalPreviewTabs() { order.push("tabs"); }
        function syncTerminalBootingOverlay() {}
        function clearTerminalEmptyState() { order.push("clearEmpty"); }
        function renderTerminalEmptyState() { order.push("empty"); }
        function parkTerminalScreen() { order.push("park"); }
        function connectTerminalStream(session, opts) { order.push("connect:" + !!(opts && opts.revive)); }
        function scheduleTerminalFit() { order.push("fit"); }
        const requestAnimationFrame = (cb) => { log.frames += 1; queueMicrotask(cb); return log.frames; };
        ${extractFn("renderTerminalPreviewSession")}
        return renderTerminalPreviewSession;
      `)(log);
      fn({ deferScreen: true });
      assert.deepEqual(log.order, ["rail", "clearEmpty", "data", "tabs"],
        "同步任务里先渲栏与数据——高亮当拍成立，xterm 重建不挡首绘");
      assert.equal(log.frames, 1, "第一层 rAF 当拍排上");
      await flush();
      assert.deepEqual(log.order, ["rail", "clearEmpty", "data", "tabs", "park", "connect:true", "fit"],
        "双 rAF 后按垫片次序成对执行（停放 → 建流 → fit）");
      assert.equal(log.frames, 2, "双 rAF（嵌套两层）");
      log.order.length = 0;
      fn({ deferScreen: true });
      fn({ deferScreen: true });
      await flush();
      assert.deepEqual(log.order, ["rail", "clearEmpty", "data", "tabs", "rail", "clearEmpty", "data", "tabs", "park", "connect:true", "fit"],
        "连点两帧：两拍的栏体/数据都当拍渲，屏重建只有最新令牌那帧执行（旧帧醒来即退场）");
      log.order.length = 0;
      fn();
      assert.deepEqual(log.order, ["rail", "clearEmpty", "data", "tabs", "park", "connect:true", "fit"],
        "默认关：与改前一致（同步直排）");
    });

    it("返回镜像：终端态栏底「返回」回进入终端前的视图（settingsReturnView 同款）", () => {
      const init = extractFn("initTerminalRail");
      assert.ok(init.includes("closeTerminalPreview"), "终端态「返回」回 terminalReturnView（closeTerminalPreview 同一链）");
      assert.ok(panelJs.includes("const exitSettings = () => switchView(settingsReturnView);")
        && panelJs.includes('if (railBackBtn) railBackBtn.onclick = exitSettings;'),
        "设置态那条既有绑定原样保留（一颗钮两态互斥）");
      assert.ok(extractFn("openTerminalPreview").includes("terminalReturnView = currentView;"),
        "进入终端前记下返回目标");
    });

    it("新建终端：对当前 agent 走同一道内切判定门（idle 内切/working 新开），cwd 沿用记住上次，无 agent 建空白终端，禁用位跟就绪位", () => {
      const create = extractFn("terminalRailCreateTerminal");
      assert.ok(create.includes("terminalCwdInitial()"), "cwd 沿用既有「记住上次」逻辑");
      assert.ok(create.includes("terminalRailSwitchOrCreateCore({ agentId, cwd })"), "有 agent 与点历史行同一道内切判定门（2026-10-25 对齐超实例）");
      assert.ok(create.includes('api("POST", "/api/terminal/sessions"'), "无 agent 建空白终端");
      assert.ok(create.includes("terminalBackendReady"), "就绪闸与页签栏加号同拍");
      assert.ok(extractFn("renderTerminalRail").includes("newBtn.disabled = !terminalBackendReady")
        || panelJs.includes("railTermNewBtn") && panelJs.includes("disabled = !terminalBackendReady"),
        "禁用态跟就绪位同拍");
    });

    it("新建钮文案随聚焦分态：有 agent「新建会话」/ 无 agent「新建终端」（M8 T3）", () => {
      // 用户 2026-10-21 指示：起的是该 agent 的会话时就叫「新建会话」；起空白终端
      // 才叫「新建终端」。行为不变，仅文案；aria/title 同步换。
      const render = extractFn("renderTerminalRail");
      assert.ok(/新建会话/.test(render) && /新建终端/.test(render), "两个分支的文案都在渲染里");
      assert.ok(render.includes("agentId ?"), "按有无 agent 聚焦分态");
    });

    it("M8 显式不做：选工作区钮 / 身份行 / 真删除会话 / 置顶 / 组行拖拽 / 快捷键 / v1", () => {
      const railBlock = panelJs.slice(panelJs.indexOf("终端会话栏（M4 + M7 + M8）"), panelJs.indexOf("function initSkillsTab"));
      assert.ok(railBlock.length > 1000, "栏体代码段可取样");
      for (const forbidden of ["marquee", "contextmenu", "快捷键", "terminalRailPin"]) {
        assert.ok(!railBlock.includes(forbidden), `不做清单项「${forbidden}」不在栏体代码里`);
      }
      // 会话行拖拽随「手动排序」照搬（手序的唯一来源）；组行不可拖（组是目录派生）
      const groupHeadHtml = railBlock.slice(railBlock.indexOf("rail-term-group-head"), railBlock.indexOf("rail-term-group-slot"));
      assert.ok(!groupHeadHtml.includes("draggable"), "组行不搬拖拽（我们的组无清单可持久化）");
      // 真删除会话文件不在栏体能力里（归档=标记+过滤，M7 口径不变）
      assert.ok(!railBlock.includes("sessionDelete") && !railBlock.includes("deleteSession"), "栏体不碰真删除");
      // v1 旧版面板通路不碰：栏体全部锚 v2
      assert.ok(!railBlock.includes('data-ui-version="v1"'), "不写 v1 分支");
    });
  });

  describe("FLIP 门控（vm 真跑）", () => {
    // 量测集＝行＋组头＋水位线钮（TERMINAL_RAIL_MOTION_SELECTOR，2026-10-26 扩全）：
    // 同一段布局变化里所有元素同缓动——位移 200ms ease-out、新元素 100ms ease-out。
    const runFlip = ({ mode = "flip", armed = true, reduced = false, before = new Map(), items = null } = {}) => {
      const animated = [];
      const defs = items || [
        { attrs: { "data-rail-term-resume": "s1" }, top: 10, key: "s1" },
        { attrs: { "data-rail-term-resume": "s2" }, top: 70, key: "s2" },
        { attrs: { "data-rail-term-resume": "s3" }, top: 100, key: "s3" },
      ];
      const nodes = defs.map((def) => ({
        getAttribute: (name) => (name in def.attrs ? def.attrs[name] : null),
        hasAttribute: (name) => name in def.attrs,
        getBoundingClientRect: () => ({ top: def.top }),
        animate: (frames, opts) => animated.push({ key: def.key, frames, opts }),
      }));
      const list = { querySelectorAll: () => nodes };
      const fn = new Function("list", "before", "mode", "armed", "reduced", `
        const terminalRailFlipMode = mode;
        const terminalRailMotionArmed = armed;
        const TERMINAL_RAIL_MOTION_SELECTOR = "[data-rail-term-resume], [data-rail-term-session], [data-rail-term-group-head], [data-rail-term-more]";
        const TERMINAL_RAIL_UNGROUPED_HEAD = "~ungrouped";
        const window = { matchMedia: () => ({ matches: reduced }) };
        ${extractFn("terminalRailMotionKey")}
        ${extractFn("terminalRailMotionEntries")}
        ${extractFn("playTerminalRailFlip")}
        return playTerminalRailFlip;
      `)(list, before, mode, armed, reduced);
      fn(list, before);
      return animated;
    };

    it("组展开/收起：位移 200ms ease-out、新行 100ms 淡入", () => {
      const animated = runFlip({ before: new Map([["resume:s1", 10], ["resume:s2", 40]]) });
      assert.equal(animated.length, 2, "位置变的两行 + 新出现的一行各一条动画");
      const glide = animated.find((a) => a.key === "s2");
      assert.equal(glide.opts.duration, 200, "行移动 200ms");
      assert.equal(glide.opts.easing, "ease-out", "行移动用 ease-out（与 dsh 实测一致，不是设计 token）");
      assert.ok(glide.frames[0].transform.startsWith("translateY("), "FLIP 位移从旧位置滑到新位置");
      assert.equal(glide.frames[1].transform, "none", "落位到自然位置");
      const fade = animated.find((a) => a.key === "s3");
      assert.equal(fade.opts.duration, 100, "新行 100ms 淡入");
      assert.equal(fade.frames[0].opacity, 0);
      assert.equal(animated.filter((a) => a.key === "s1").length, 0, "位置没变的行不做空动画");
    });

    it("组头与水位线钮同缓动：兜底行增删推动整棵树时不再瞬跳压在行上（2026-10-26 回归钉）", () => {
      const animated = runFlip({
        before: new Map([["head:C:\\dev\\alpha", 168], ["more:C:\\dev\\beta", 368]]),
        items: [
          { attrs: { "data-rail-term-group-head": "C:\\dev\\alpha" }, top: 200, key: "组头 α" },
          { attrs: { "data-rail-term-group-head": "C:\\dev\\delta" }, top: 12, key: "组头 δ（新组）" },
          { attrs: { "data-rail-term-more": "C:\\dev\\beta" }, top: 400, key: "水位线钮" },
        ],
      });
      assert.equal(animated.length, 3, "两个组头各一条、水位线钮一条");
      const moved = animated.find((a) => a.key === "组头 α");
      assert.equal(moved.opts.duration, 200, "组头位移与行同 200ms");
      assert.equal(moved.opts.easing, "ease-out", "组头位移与行同 ease-out");
      assert.equal(moved.frames[0].transform, "translateY(-32px)", "组头从旧位起滑（168→200 的 -32px）");
      assert.equal(moved.frames[1].transform, "none", "落位到自然位置");
      const born = animated.find((a) => a.key === "组头 δ（新组）");
      assert.equal(born.opts.duration, 100, "新组头与「新会话」行同 100ms 淡入");
      assert.equal(born.frames[0].opacity, 0);
      const more = animated.find((a) => a.key === "水位线钮");
      assert.equal(more.opts.duration, 200, "水位线钮同为 200ms 位移");
      assert.equal(more.frames[0].transform, "translateY(-32px)");
    });

    it("身份键按类前缀：会话行/兜底行/组头/水位线钮四属不互撞（组头与水位线钮同吃组键）", () => {
      const keyOf = (attrs) => new Function(`
        const TERMINAL_RAIL_UNGROUPED_HEAD = "~ungrouped";
        ${extractFn("terminalRailMotionKey")}
        return terminalRailMotionKey;
      `)()({
        getAttribute: (name) => (name in attrs ? attrs[name] : null),
        hasAttribute: (name) => name in attrs,
      });
      assert.equal(keyOf({ "data-rail-term-resume": "s-1" }), "resume:s-1", "历史行");
      assert.equal(keyOf({ "data-rail-term-session": "t-9" }), "pending:t-9", "「新会话」兜底行");
      assert.equal(keyOf({ "data-rail-term-group-head": "C:\\dev\\alpha" }), "head:C:\\dev\\alpha", "组头");
      assert.equal(keyOf({ "data-rail-term-group-head": "~ungrouped" }), "head:~ungrouped", "「未分组」组头用哨兵键，不落空串");
      assert.equal(keyOf({ "data-rail-term-more": "C:\\dev\\beta" }), "more:C:\\dev\\beta", "水位线钮");
      assert.equal(keyOf({ "data-rail-term-more": "" }), "more:~ungrouped", "「未分组」水位线钮同哨兵");
      assert.equal(keyOf({}), "", "三属都没有＝不进动效集");
    });

    it("resetKey（水位线 / 刷新 / 换 agent）直接落位；首次输入前与 reduced-motion 不动", () => {
      const before = new Map([["resume:s1", 0], ["resume:s2", 0]]);
      assert.deepEqual(runFlip({ mode: "instant", before }), [], "水位线增减与刷新是瞬时跳变（dsh 实测）");
      assert.deepEqual(runFlip({ armed: false, before }), [], "首次输入前不做动画（真实首挂由 armed 门拦下）");
      assert.deepEqual(runFlip({ reduced: true, before }), [], "prefers-reduced-motion 全关");
      // 空集 before（换写前栏里一行都没量到）不再整体跳过（2026-10-25 兜底行动效
      // 放宽）：新元素淡入仍然成立——空栏里第一条「新会话」兜底行的出现、撤销归档让
      // 唯一行归组；位移无旧位可播，不做整列表位移。
      const emptyBefore = runFlip({ before: new Map() });
      assert.ok(emptyBefore.length > 0, "空集 before 仍播新元素淡入");
      assert.ok(emptyBefore.every((a) => a.frames.length === 2 && a.frames[0].opacity === 0 && a.frames[1].opacity === 1 && a.opts.duration === 100),
        "只淡入（100ms），无位移动画");
    });

    it("同 id 的两行各算各的旧位：收起下方组时不再把后一行的位置当前一行的旧位（2026-10-26 抽搐根因钉）", () => {
      // 真实成因：同一段对话被复制到另一个项目目录，扫描按文件各出一行，同一个
      // data-rail-term-resume 在组里出现两次。旧位表按 id 索引，后一行覆盖前一行，
      // 靠前那行算出一个行距的假位移（30~32px，200ms ease-out）——收起下方组时整组
      // 位移把同组其它行的运动盖住，只有它单行「向下抽搐再弹回」。
      const node = (attrs, top) => ({
        getAttribute: (name) => (name in attrs ? attrs[name] : null),
        hasAttribute: (name) => name in attrs,
        getBoundingClientRect: () => ({ top }),
        animate: () => {},
        cloneNode: () => null,
      });
      const oldRows = [
        node({ "data-rail-term-resume": "dup" }, 70),
        node({ "data-rail-term-resume": "dup" }, 100),
        node({ "data-rail-term-resume": "other" }, 130),
      ];
      // 收起下方组：这三行自身位置一个都没变
      const newRows = [
        node({ "data-rail-term-resume": "dup" }, 70),
        node({ "data-rail-term-resume": "dup" }, 100),
        node({ "data-rail-term-resume": "other" }, 130),
      ];
      const animated = [];
      const run = new Function("oldList", "newList", "animated", `
        const TERMINAL_RAIL_MOTION_SELECTOR = "[data-rail-term-resume], [data-rail-term-session], [data-rail-term-group-head], [data-rail-term-more]";
        const TERMINAL_RAIL_UNGROUPED_HEAD = "~ungrouped";
        const terminalRailFlipMode = "flip";
        const terminalRailMotionArmed = true;
        const window = { matchMedia: () => ({ matches: false }) };
        ${extractFn("terminalRailMotionKey")}
        ${extractFn("terminalRailMotionEntries")}
        ${extractFn("terminalRailMotionTops")}
        ${extractFn("playTerminalRailFlip")}
        const before = terminalRailMotionTops(oldList);
        const keys = [...before.keys()];
        playTerminalRailFlip(newList, before);
        return { keys, size: before.size };
      `);
      const result = run(
        { querySelectorAll: () => oldRows },
        { querySelectorAll: () => newRows.map((el) => ({ ...el, animate: (frames, opts) => animated.push({ frames, opts }) })) },
        animated,
      );
      assert.equal(result.size, 3, "三行三个旧位（同 id 的两行不互相覆盖）");
      assert.deepEqual(result.keys, ["resume:dup", "resume:dup#2", "resume:other"],
        "同键的第 n 个出现补序号后缀，量测/播放同一份枚举");
      assert.deepEqual(animated, [], "自身位置没变就不该有任何位移动画（抽搐＝假位移）");
    });

    it("活跃终端所在组自动展开：等列表落地后才做一次，用户手动收起不被轮询顶回来", () => {
      const build = (history, activeSession, collapsed, autoKey) => {
        const list = { html: "", writes: 0 };
        Object.defineProperty(list, "innerHTML", {
          get: () => list.html,
          set: (v) => { list.writes += 1; list.html = v; },
        });
        const state = { collapsed: new Set(collapsed), autoKey, scrolled: [] };
        const fn = new Function("list", "state", "history", "activeSession", `
          let terminalRailRendered = { open: null, history: null };
          let terminalRailAutoExpandedFor = state.autoKey;
          let terminalRailScrolledFor = "";
          let terminalRailFlipMode = "instant";
          const terminalRailCollapsedGroups = state.collapsed;
          function saveTerminalRailCollapsedGroups() { state.saved = (state.saved || 0) + 1; }
          const terminalRailWatermarks = new Map();
          const terminalRailPrefs = { archived: [], removedGroups: [] };
          const terminalRailPendingNew = new Map();
          const terminalRailViewPrefs = { groupBy: "workspace", orderBy: "updated", archivedFilter: "default", sessionOrder: {} };
        const terminalRailSearch = { open: false, query: "", timer: null, searching: false };
          let terminalRailLastGroups = [];
          const TERMINAL_RAIL_WATERMARK = 5;
          const TERMINAL_RAIL_MOTION_SELECTOR = "[data-rail-term-resume], [data-rail-term-session], [data-rail-term-group-head], [data-rail-term-more]";
          const TERMINAL_RAIL_UNGROUPED_HEAD = "~ungrouped";
          const TERMINAL_RAIL_ICON_CHEVRON = "";
          const TERMINAL_RAIL_ICON_ARCHIVE = "";
          const TERMINAL_RAIL_ICON_UNARCHIVE = "";
          const TERMINAL_RAIL_ICON_ELLIPSIS = "";
          const TERMINAL_RAIL_ICON_PLUS = "";
          const TERMINAL_RAIL_ICON_FOLDER_OPEN = "";
          const TERMINAL_RAIL_ICON_FOLDER_CLOSED = "";
          const terminalRailHistory = history;
          const activeTerminalPreviewId = "t1";
          function $(id) { return id === "railTermHistoryList" ? list : null; }
          let terminalBackendReady = true;
          const terminalBackendSessions = { t1: activeSession };
          ${extractFn("terminalRailSessionMap")}
          ${extractFn("terminalRailActiveSession")}
          ${extractFn("terminalRailAgentId")}
          ${extractFn("terminalRailFindOpenSession")}
          function sessDirName(p) { return String(p || "").replace(/\\\\/g, "/").split("/").filter(Boolean).pop() || p || ""; }
          function sessTitle(s) { return s.title || String(s.id || "").slice(0, 8); }
          function sessRelTime() { return "刚刚"; }
        function terminalRailRelTime() { return "3 分钟前"; }
          function esc(v) { return String(v); }
          function escapeHtml(v) { return String(v || ""); }
          function terminalRailScrollGroupIntoView(key) { state.scrolled.push(key); }
          function terminalRailMotionTops() { return null; }
          function terminalRailScrollGroupIntoView(key) { state.scrolled.push(key); }
          function playTerminalRailFlip() {}
          function terminalRailMotionEnabled() { return false; }
          function terminalRailPendingRowKeys() { return new Set(); }
          function terminalRailSnapshotMotion() { return new Map(); }
          function terminalRailMountExitGhosts() {}
          let terminalRailLastDiffAgent = null;
          let terminalRailLastDiffSearch = false;
          ${extractFn("terminalRailNormDir")}
          ${extractFn("terminalRailGroupSessions")}
          ${extractFn("terminalRailWatermarkView")}
          ${extractFn("terminalRailNextWatermark")}
          ${extractFn("terminalRailMoreLabel")}
          ${extractFn("terminalRailSameDir")}
          ${extractFn("terminalRailGroupForDir")}
          ${extractFn("terminalRailRegroupRemoved")}
          function terminalRailSelfHealRemovedGroups() { return false; }
          ${extractFn("terminalRailArchivedKey")}
          ${extractFn("terminalRailVisibleSessions")}
          const TERMINAL_RAIL_SPINNER = "";
          const TERMINAL_RAIL_DONE_DOT = "";
          const terminalDoneUnread = new Map();
        let terminalRailSelectPending = null;
          ${extractFn("terminalRailStateSlotHtml")}
          ${extractFn("terminalRailRowHtml")}
          ${extractFn("terminalRailIsArchived")}
${extractFn("terminalRailPendingNewTerminals")}
${extractFn("terminalRailPendingRowHtml")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
          ${extractFn("renderTerminalRailHistory")}
          return { render: renderTerminalRailHistory, collapsed: terminalRailCollapsedGroups, scrolled: state.scrolled };
        `)(list, state, history, activeSession);
        return { fn, list, state };
      };

      const activeSession = { id: "t1", cwd: "C:\\dev\\alpha" };
      const collapsed = ["c:\\dev\\alpha"];
      // 首帧：历史还没拉回来（sessions 空），不许把「已自动展开」认下来
      const early = build({ endpoint: "kimi", sessions: [] }, activeSession, collapsed, "");
      early.fn.render("kimi");
      assert.equal(early.state.collapsed.has("c:\\dev\\alpha"), true, "数据没落地时不动组态（这一刻组表本来就是空的）");
      assert.equal(early.state.scrolled.length, 0, "也不滚");

      // 落地后同一次渲染：展开活跃所在组并滚到可见
      const landed = build(
        { endpoint: "kimi", sessions: [
          { id: "s1", project: "C:\\dev\\alpha", title: "重构权限矩阵", lastActive: 100 },
          { id: "s2", project: "C:\\dev\\beta", title: "接入渠道", lastActive: 200 },
        ] },
        activeSession, collapsed, "",
      );
      landed.fn.render("kimi");
      assert.equal(landed.state.collapsed.has("c:\\dev\\alpha"), false, "活跃终端所在组自动展开");
      assert.ok(landed.state.saved >= 1, "自动展开同步写回折叠存档（看到的＝存下的）");
      assert.deepEqual(landed.state.scrolled, ["C:\\dev\\alpha"], "并滚到可见");

      // 已展开过一次之后：用户手动收起，后续轮询渲染不许把它顶回来
      const after = build(
        { endpoint: "kimi", sessions: [{ id: "s1", project: "C:\\dev\\alpha", title: "重构权限矩阵", lastActive: 100 }] },
        activeSession, ["c:\\dev\\alpha"], "kimi\u0000t1",
      );
      after.fn.render("kimi");
      assert.equal(after.state.collapsed.has("c:\\dev\\alpha"), true, "同一活跃终端不再自动展开（尊重用户手动收起）");
      assert.equal(after.state.scrolled.length, 0, "也不重复滚");
    });

    it("抓取失败不算「落地」：失败态不消费自动展开，手动刷新成功后才展开", () => {
      // 同一个沙盒里连跑两帧：先失败、再刷新成功。失败帧若把 autoKey 消费掉，
      // 刷新成功那一帧就再也不会自动展开——这正是要钉住的回归。
      const list = { html: "", writes: 0 };
      Object.defineProperty(list, "innerHTML", {
        get: () => list.html,
        set: (v) => { list.writes += 1; list.html = v; },
      });
      const state = { collapsed: new Set(["c:\\dev\\alpha"]), scrolled: [] };
      const sandbox = new Function("list", "state", "activeSession", `
        let terminalRailRendered = { open: null, history: null };
        let terminalRailAutoExpandedFor = "";
        let terminalRailScrolledFor = "";
        let terminalRailFlipMode = "instant";
        const terminalRailCollapsedGroups = state.collapsed;
        function saveTerminalRailCollapsedGroups() { state.saved = (state.saved || 0) + 1; }
        const terminalRailWatermarks = new Map();
        const terminalRailPrefs = { archived: [], removedGroups: [] };
        const terminalRailPendingNew = new Map();
        const terminalRailViewPrefs = { groupBy: "workspace", orderBy: "updated", archivedFilter: "default", sessionOrder: {} };
        const terminalRailSearch = { open: false, query: "", timer: null, searching: false };
        let terminalRailLastGroups = [];
        const TERMINAL_RAIL_WATERMARK = 5;
        const TERMINAL_RAIL_MOTION_SELECTOR = "[data-rail-term-resume], [data-rail-term-session], [data-rail-term-group-head], [data-rail-term-more]";
        const TERMINAL_RAIL_UNGROUPED_HEAD = "~ungrouped";
        const TERMINAL_RAIL_ICON_CHEVRON = "";
        const TERMINAL_RAIL_ICON_ARCHIVE = "";
          const TERMINAL_RAIL_ICON_UNARCHIVE = "";
        const TERMINAL_RAIL_ICON_ELLIPSIS = "";
        const TERMINAL_RAIL_ICON_PLUS = "";
        const TERMINAL_RAIL_ICON_FOLDER_OPEN = "";
        const TERMINAL_RAIL_ICON_FOLDER_CLOSED = "";
        let terminalRailHistory = { endpoint: "", sessions: [], fetchedAt: 0, error: null };
        const activeTerminalPreviewId = "t1";
        function $(id) { return id === "railTermHistoryList" ? list : null; }
        let terminalBackendReady = true;
        const terminalBackendSessions = { t1: activeSession };
        ${extractFn("terminalRailSessionMap")}
        ${extractFn("terminalRailActiveSession")}
          ${extractFn("terminalRailAgentId")}
          ${extractFn("terminalRailFindOpenSession")}
        function sessDirName(p) { return String(p || "").replace(/\\\\/g, "/").split("/").filter(Boolean).pop() || p || ""; }
        function sessTitle(s) { return s.title || String(s.id || "").slice(0, 8); }
        function sessRelTime() { return "刚刚"; }
        function terminalRailRelTime() { return "3 分钟前"; }
        function esc(v) { return String(v); }
        function escapeHtml(v) { return String(v || ""); }
        function terminalRailScrollGroupIntoView(key) { state.scrolled.push(key); }
        function terminalRailMotionTops() { return null; }
        function playTerminalRailFlip() {}
        function terminalRailMotionEnabled() { return false; }
        function terminalRailPendingRowKeys() { return new Set(); }
        function terminalRailSnapshotMotion() { return new Map(); }
        function terminalRailMountExitGhosts() {}
        let terminalRailLastDiffAgent = null;
        let terminalRailLastDiffSearch = false;
        ${extractFn("terminalRailNormDir")}
        ${extractFn("terminalRailGroupSessions")}
        ${extractFn("terminalRailWatermarkView")}
        ${extractFn("terminalRailNextWatermark")}
        ${extractFn("terminalRailMoreLabel")}
        ${extractFn("terminalRailSameDir")}
        ${extractFn("terminalRailGroupForDir")}
        ${extractFn("terminalRailRegroupRemoved")}
        function terminalRailSelfHealRemovedGroups() { return false; }
        ${extractFn("terminalRailArchivedKey")}
        ${extractFn("terminalRailVisibleSessions")}
        const TERMINAL_RAIL_SPINNER = "";
        const TERMINAL_RAIL_DONE_DOT = "";
        const terminalDoneUnread = new Map();
        let terminalRailSelectPending = null;
        ${extractFn("terminalRailStateSlotHtml")}
        ${extractFn("terminalRailRowHtml")}
        ${extractFn("terminalRailIsArchived")}
${extractFn("terminalRailPendingNewTerminals")}
${extractFn("terminalRailPendingRowHtml")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
        ${extractFn("renderTerminalRailHistory")}
        return {
          render: renderTerminalRailHistory,
          collapsed: terminalRailCollapsedGroups,
          setHistory: (h) => { terminalRailHistory = h; },
          autoExpandedFor: () => terminalRailAutoExpandedFor,
        };
      `)(list, state, { id: "t1", cwd: "C:\\dev\\alpha" });

      // 第一帧：抓取失败。endpoint 已写成 kimi（与成功态同形），但带 error。
      sandbox.setHistory({ endpoint: "kimi", sessions: [], fetchedAt: 1, error: new Error("terminal_host_unavailable") });
      sandbox.render("kimi");
      assert.equal(sandbox.autoExpandedFor(), "", "失败态不消费 autoKey（失败那份空表不是事实）");
      assert.equal(state.collapsed.has("c:\\dev\\alpha"), true, "失败态不动组态");

      // 第二帧：用户手动刷新成功，列表落地 → 活跃组照常自动展开并滚到可见。
      sandbox.setHistory({
        endpoint: "kimi",
        sessions: [{ id: "s1", project: "C:\\dev\\alpha", title: "重构权限矩阵", lastActive: 100 }],
        fetchedAt: 2, error: null,
      });
      sandbox.render("kimi");
      assert.equal(sandbox.autoExpandedFor(), "kimi\u0000t1", "成功落地才认下「已自动展开」");
      assert.equal(state.collapsed.has("c:\\dev\\alpha"), false, "活跃组自动展开");
      assert.deepEqual(state.scrolled, ["C:\\dev\\alpha"], "并滚到可见");
    });

    it("水位线与刷新把 flip 模式置回 instant；组展开才置 flip", () => {
      assert.ok(extractFn("toggleTerminalRailWatermark").includes('terminalRailFlipMode = "instant"'), "水位线点击 = resetKey");
      assert.ok(extractFn("toggleTerminalRailGroup").includes('terminalRailFlipMode = "flip"'), "组展开/收起走 FLIP");
      assert.ok(extractFn("refreshTerminalRailHistory").includes('terminalRailFlipMode = "instant"'), "刷新直接落位");
      assert.ok(extractFn("renderTerminalRailHistory").includes('terminalRailFlipMode = "instant"'),
        "一帧用完即复位，下一次更新默认瞬时");
      assert.ok(extractFn("renderTerminalRailHistory").includes('terminalRailFlipMode === "flip" ? terminalRailMotionTops(list) : null'),
        "旧位置只在真要播 FLIP 时才量（1s 轮询每拍都渲染，无条件量行等于每秒一次强制布局）");
      assert.ok(extractFn("initTerminalRail").includes("terminalRailMotionArmed = true"), "首次指针/键盘输入才武装动画");
    });
  });
});

describe("组折叠持久化（localStorage）", () => {
  const KEY = "panel-terminal-rail-collapsed";
  const storageSandbox = (store) => new Function("store", `
    const TERMINAL_RAIL_COLLAPSED_KEY = "panel-terminal-rail-collapsed";
    const terminalRailCollapsedGroups = new Set();
    const localStorage = {
      getItem(key) { return store.has(key) ? store.get(key) : null; },
      setItem(key, value) { store.set(key, String(value)); },
    };
    ${extractFn("terminalRailNormDir")}
    ${extractFn("loadTerminalRailCollapsedGroups")}
    ${extractFn("saveTerminalRailCollapsedGroups")}
    let terminalRailFlipMode = "instant";
    function terminalRailAgentId() { return "kimi"; }
    function renderTerminalRailHistory() {}
    ${extractFn("toggleTerminalRailGroup")}
    return {
      load: loadTerminalRailCollapsedGroups,
      save: saveTerminalRailCollapsedGroups,
      toggle: toggleTerminalRailGroup,
      groups: terminalRailCollapsedGroups,
    };
  `)(store);

  it("读回落盘：大小写/斜杠/尾斜杠归一化，脏键跳过；写回同一口径", () => {
    const store = new Map();
    store.set(KEY, JSON.stringify(["C:\\Dev\\Alpha\\", "d:/Work/Beta", "", 42, null]));
    const box = storageSandbox(store);
    box.load();
    assert.deepEqual([...box.groups].sort(),
      ["", "c:\\dev\\alpha", "d:\\work\\beta"],
      "目录键归一化到同一把尺（未分组空键保留，非字符串丢弃）");
    box.save();
    assert.deepEqual(JSON.parse(store.get(KEY)).sort(),
      ["", "c:\\dev\\alpha", "d:\\work\\beta"], "写回同样归一化");
  });

  it("坏存档不砸内存现值：坏 JSON / 非数组保留当前集合", () => {
    const store = new Map([[KEY, "{oops"]]);
    const box = storageSandbox(store);
    box.groups.add("c:\\dev\\alpha");
    box.load();
    assert.ok(box.groups.has("c:\\dev\\alpha"), "坏 JSON：保留内存现值");
    store.set(KEY, JSON.stringify({ collapsed: true }));
    box.load();
    assert.ok(box.groups.has("c:\\dev\\alpha"), "非数组：保留内存现值");
  });

  it("点组头即落盘：收起写入归一化键，再点删键", () => {
    const store = new Map();
    const box = storageSandbox(store);
    box.toggle("C:\\Dev\\Alpha");
    assert.deepEqual(JSON.parse(store.get(KEY)), ["c:\\dev\\alpha"], "收起即写盘");
    box.toggle("C:\\Dev\\Alpha");
    assert.deepEqual(JSON.parse(store.get(KEY)), [], "展开即删键");
  });

  it("接线钉：首渲前读回，四条改折叠态的路径都写回", () => {
    assert.ok(extractFn("initTerminalRail").includes("loadTerminalRailCollapsedGroups()"),
      "页面启动首渲之前读回折叠存档");
    for (const fn of ["toggleTerminalRailGroup", "terminalRailCreateTerminalInDir"]) {
      assert.ok(extractFn(fn).includes("saveTerminalRailCollapsedGroups()"), `${fn} 写回`);
    }
    assert.ok(extractFn("applyTerminalRailViewChoice").includes("saveTerminalRailCollapsedGroups()"),
      "树模式自动展开祖先组写回");
    assert.ok(extractFn("renderTerminalRailHistory").includes("terminalRailCollapsedGroups.has(terminalRailNormDir(group.key))"),
      "渲染按归一化键读折叠态");
    assert.ok(extractFn("renderTerminalRailHistory").includes("saveTerminalRailCollapsedGroups()"),
      "活跃组自动展开写回（看到的＝存下的）");
  });
});

describe("M12-B 运行中转圈与水位线联动（dsh 实测规格）", () => {
  it("转圈 CSS 逐项：16×20 槽、轨道/弧线 currentColor、两动画同周期、reduced-motion 降级", () => {
    const slot = cssRule(".rail-term-spinner {");
    assert.ok(/width:\s*16px/.test(slot) && /height:\s*20px/.test(slot), "行首槽位 16×20（dsh 实测）");
    assert.ok(/color:\s*var\(--text-3\)/.test(slot), "槽位取三级文字色 token（currentColor 链）");
    const track = cssRule(".rail-term-spinner-track {");
    assert.ok(/fill:\s*none/.test(track) && /stroke:\s*currentColor/.test(track) && /stroke-width:\s*2/.test(track) && /opacity:\s*\.25/.test(track),
      "轨道圆：none 填充、currentColor、2px 描边、opacity .25（r=9.5 由 markup 钉）");
    const arc = cssRule(".rail-term-spinner-arc {");
    assert.ok(/stroke:\s*currentColor/.test(arc) && /stroke-width:\s*2/.test(arc), "弧线圆同描边（currentColor，不造新色值）");
    assert.ok(/stroke-dasharray:\s*12 150/.test(arc), "弧线 dasharray 12 150");
    assert.ok(/animation:\s*rail-term-spinner-breathe 1\.5s ease-in-out infinite/.test(arc), "弧线呼吸 1.5s ease-in-out infinite");
    const rot = cssRule(".rail-term-spinner-rot {");
    assert.ok(/transform-origin:\s*center/.test(rot), "外层 g transform-origin center");
    assert.ok(/animation:\s*rail-term-spinner-rotate 1\.5s linear infinite/.test(rot), "外层 g 匀速转 1.5s linear infinite（与弧线同周期）");
    assert.ok(/@keyframes rail-term-spinner-breathe \{[\s\S]*?0% \{ stroke-dasharray: 12 150; stroke-dashoffset: 0; \}[\s\S]*?50% \{ stroke-dasharray: 24 150; stroke-dashoffset: -6; \}[\s\S]*?100% \{ stroke-dasharray: 12 150; stroke-dashoffset: 0; \}/.test(panelCss),
      "呼吸三段：弧长 12→24→12、offset 0→-6→0");
    assert.ok(/@keyframes rail-term-spinner-rotate \{ from \{ transform: rotate\(0deg\); \} to \{ transform: rotate\(360deg\); \} \}/.test(panelCss),
      "匀速 360°");
    assert.ok(/@media \(prefers-reduced-motion: reduce\) \{\s*\.rail-term-spinner-arc, \.rail-term-spinner-rot \{ animation: none; \}/.test(panelCss),
      "reduced-motion 两动画全 none（静态轨道＋固定弧）");
    assert.ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.rail-term-spinner-arc \{ stroke-dasharray: 18 150; stroke-dashoffset: -3; \}/.test(panelCss),
      "reduced-motion 静态弧对齐 dsh：dasharray 18 150、offset -3（不是动画 0% 的短弧）");
    const sr = cssRule(".rail-term-spinner-sr {");
    assert.ok(/width:\s*1px/.test(sr) && /height:\s*1px/.test(sr) && /clip:/.test(sr), "读屏文本 visuallyHidden 形制");
  });

  // 水位线联动 vm 沙盒：参数化（history/sessions/activeId），一次构造两帧对照。
  const watermarkSandbox = (list, state, history, sessions, activeId) => new Function("list", "state", "history", "sessions", "activeId", `
    let terminalRailRendered = { open: null, history: null };
    let terminalRailAutoExpandedFor = "";
    let terminalRailScrolledFor = "";
    let terminalRailFlipMode = "instant";
    const terminalRailCollapsedGroups = state.collapsed;
    function saveTerminalRailCollapsedGroups() { state.saved = (state.saved || 0) + 1; }
    const terminalRailWatermarks = new Map();
    const terminalRailPrefs = { archived: [], removedGroups: [] };
    const terminalRailPendingNew = new Map();
    const terminalRailViewPrefs = { groupBy: "workspace", orderBy: "updated", archivedFilter: "default", sessionOrder: {} };
    const terminalRailSearch = { open: false, query: "", timer: null, searching: false };
    let terminalRailLastGroups = [];
    const TERMINAL_RAIL_WATERMARK = 5;
    const TERMINAL_RAIL_MOTION_SELECTOR = "[data-rail-term-resume], [data-rail-term-session], [data-rail-term-group-head], [data-rail-term-more]";
    const TERMINAL_RAIL_UNGROUPED_HEAD = "~ungrouped";
    const TERMINAL_RAIL_ICON_CHEVRON = "";
    const TERMINAL_RAIL_ICON_ARCHIVE = "";
    const TERMINAL_RAIL_ICON_UNARCHIVE = "";
    const TERMINAL_RAIL_ICON_ELLIPSIS = "";
    const TERMINAL_RAIL_ICON_PLUS = "";
    const TERMINAL_RAIL_ICON_FOLDER_OPEN = "";
    const TERMINAL_RAIL_ICON_FOLDER_CLOSED = "";
    const TERMINAL_RAIL_SPINNER = "";
    const TERMINAL_RAIL_DONE_DOT = "";
    const terminalDoneUnread = new Map();
    let terminalRailSelectPending = null;
    ${extractFn("terminalRailStateSlotHtml")}
    let terminalRailHistory = history;
    let activeTerminalPreviewId = activeId;
    function $(id) { return id === "railTermHistoryList" ? list : null; }
    let terminalBackendReady = true;
    const terminalBackendSessions = sessions;
    ${extractFn("terminalRailSessionMap")}
    ${extractFn("terminalRailActiveSession")}
    ${extractFn("terminalRailAgentId")}
    ${extractFn("terminalRailFindOpenSession")}
    function sessDirName(p) { return String(p || "").replace(/\\\\/g, "/").split("/").filter(Boolean).pop() || p || ""; }
    function sessTitle(s) { return s.title || String(s.id || "").slice(0, 8); }
    function sessRelTime() { return "刚刚"; }
    function terminalRailRelTime() { return "3 分钟前"; }
    function esc(v) { return String(v); }
    function escapeHtml(v) { return String(v || ""); }
    function terminalRailScrollGroupIntoView(key) { state.scrolled.push(key); }
    function terminalRailMotionTops() { return null; }
    function playTerminalRailFlip() {}
    function terminalRailMotionEnabled() { return false; }
    function terminalRailPendingRowKeys() { return new Set(); }
    function terminalRailSnapshotMotion() { return new Map(); }
    function terminalRailMountExitGhosts() {}
    let terminalRailLastDiffAgent = null;
    let terminalRailLastDiffSearch = false;
    ${extractFn("terminalRailNormDir")}
        ${extractFn("terminalRailGroupSessions")}
    ${extractFn("terminalRailWatermarkView")}
    ${extractFn("terminalRailNextWatermark")}
    ${extractFn("terminalRailMoreLabel")}
    ${extractFn("terminalRailSameDir")}
    ${extractFn("terminalRailGroupForDir")}
    ${extractFn("terminalRailRegroupRemoved")}
    function terminalRailSelfHealRemovedGroups() { return false; }
    ${extractFn("terminalRailArchivedKey")}
    ${extractFn("terminalRailIsArchived")}
    ${extractFn("terminalRailVisibleSessions")}
    ${extractFn("terminalRailPendingNewTerminals")}
    ${extractFn("terminalRailRowHtml")}
    ${extractFn("terminalRailPendingRowHtml")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
    ${extractFn("renderTerminalRailHistory")}
    return { render: renderTerminalRailHistory };
  `)(list, state, history, sessions, activeId);

  const makeList = () => {
    const list = { html: "", writes: 0 };
    Object.defineProperty(list, "innerHTML", {
      get: () => list.html,
      set: (v) => { list.writes += 1; list.html = v; },
    });
    return list;
  };

  it("水位线联动：运行中＋当前会话两档强制入可见段，不被藏进「展开其余 N」（vm 真跑）", () => {
    // 10 条同目录会话（lastActive 递减，s10 最新）：基线水位 5 → s10..s6 可见；
    // s2 运行中（第 9 新）、s3 是当前会话（第 8 新）——两档强制入可见段。
    const rows = [];
    for (let i = 10; i >= 1; i -= 1) {
      rows.push({ id: `s${i}`, endpoint: "kimi", project: "C:\\dev\\alpha", title: `会话 ${i}`, lastActive: i * 100 });
    }
    const history = { endpoint: "kimi", sessions: rows, fetchedAt: 1, error: null };
    const sessions = {
      "t-work": { id: "t-work", cwd: "C:\\dev\\alpha", agent: { endpointId: "kimi" }, status: "working", resume: { endpoint: "kimi", id: "s2" } },
      "t-cur": { id: "t-cur", cwd: "C:\\dev\\alpha", agent: { endpointId: "kimi" }, status: "idle", resume: { endpoint: "kimi", id: "s3" } },
    };
    const list = makeList();
    watermarkSandbox(list, { collapsed: new Set(), scrolled: [] }, history, sessions, "t-cur").render("kimi");
    const html = list.html;
    assert.ok(html.includes('data-rail-term-resume="s2"'), "运行中行（第 9 新，基线水位外）强制入可见段");
    assert.ok(html.includes('data-rail-term-resume="s3"'), "当前会话行（第 8 新，基线水位外）强制入可见段");
    assert.ok(!html.includes('data-rail-term-resume="s1"'), "强制入段是前缀语义：最后一条（最旧）仍藏");
    assert.ok(html.includes("展开其余 1 个会话"), "剩余计数随强制入段扣减（10 − 9＝1）");

    // 对照组：无运行中/当前会话 → 回到纯水位线（最新 5 条）
    const plain = makeList();
    watermarkSandbox(plain, { collapsed: new Set(), scrolled: [] }, history, {}, "t-none").render("kimi");
    assert.ok(plain.html.includes('data-rail-term-resume="s6"'), "对照组：最新 5 条在册（s10..s6）");
    assert.ok(!plain.html.includes('data-rail-term-resume="s5"'), "对照组：第 6 新起照旧折叠");
    assert.ok(plain.html.includes("展开其余 5 个会话"), "对照组：剩余 5 条");
  });

  it("活动流 working 翻转同拍重渲会话栏（转圈不等 1s 轮询；源码钉死）", () => {
    const block = panelJs.slice(panelJs.indexOf("function syncTerminalActivityStream"), panelJs.indexOf("function initTerminalPreview"));
    assert.ok(/const statusBefore = new Map\(Object\.values\(terminalSessionMap\(\)\)/.test(block), "应用帧前快照各会话 working 态");
    assert.ok(block.includes("const flipped = Object.values(terminalSessionMap()).some((s) => statusBefore.get(s.id) !== s.status)"), "帧后比对翻转");
    assert.ok(/if \(flipped && typeof renderTerminalRail === "function"\)/.test(block), "只在实际翻转时重渲栏（不是每帧）");
    assert.ok(/renderTerminalSessionData\(\);\s*renderTerminalPreviewTabs\(\);/s.test(block), "原两渲不动（数据＋页签）");
  });

  // M12-A 空白壳接管的可达性前提：活跃页签是空白外壳（无 agent 归属）时栏体不清表——
  // 沿用上次加载的历史，用户才点得到行、把空白壳内切接管（规格判定矩阵空白壳行）。
  // 真机验收发现：旧行为在空白壳聚焦时把 history 清空，矩阵那一行 thereby 不可达。
  it("空白壳聚焦不清栏：沿用上次加载的历史，同参不重拉（vm 真跑）", () => {
    const fn = new Function(`
      let terminalRailHistory = { endpoint: "kimi", sessions: [{ id: "s-1", endpoint: "kimi" }], fetchedAt: 1, error: null };
      const rendered = [];
      const refetched = [];
      function terminalRailSessionMap() { return { "t-blank": { id: "t-blank" } }; }
      function renderTerminalRailHistory(agentId) { rendered.push(agentId); }
      function refreshTerminalRailHistory({ endpoint }) { refetched.push(endpoint); }
      ${extractFn("syncTerminalRailHistory")}
      return { sync: syncTerminalRailHistory, state: () => terminalRailHistory, rendered, refetched };
    `)();
    fn.sync("");
    assert.deepEqual(fn.state().sessions, [{ id: "s-1", endpoint: "kimi" }], "空白壳聚焦不清表（行还点得到）");
    assert.equal(fn.state().endpoint, "", "标记为无 agent 上下文（区别于已加载的 kimi）");
    assert.deepEqual(fn.rendered, [""], "按无 agent 上下文重渲一次");
    fn.sync("");
    assert.deepEqual(fn.rendered, [""], "同参二次调用早退，不重渲");
    fn.sync("kimi");
    assert.deepEqual(fn.refetched, ["kimi"], "切回 agent 上下文才走重拉");
  });

  // 空态回落中性空树（用户 2026-10-24 裁决）：一个终端都没了（关光最后一个页签/
  // 远端关光/进程自退），栏不再挂已关 agent 的会话表——会话栏是壳的资产，空态保持
  // 终端页的正常形态；与「空白壳还开着」的保史行为（f2a60f0）按开着的终端数分界。
  it("空态清栏：零终端时回落中性空树，不再挂已关 agent 的会话表（vm 真跑）", () => {
    const fn = new Function(`
      let terminalRailHistory = { endpoint: "kimi", sessions: [{ id: "s-1", endpoint: "kimi" }], fetchedAt: 1, error: null };
      const rendered = [];
      const refetched = [];
      function terminalRailSessionMap() { return {}; }
      function renderTerminalRailHistory(agentId) { rendered.push(agentId); }
      function refreshTerminalRailHistory({ endpoint }) { refetched.push(endpoint); }
      ${extractFn("syncTerminalRailHistory")}
      return { sync: syncTerminalRailHistory, state: () => terminalRailHistory, rendered, refetched };
    `)();
    fn.sync("");
    assert.deepEqual(fn.state().sessions, [], "零终端＝空态：上次加载的历史整份清空");
    assert.equal(fn.state().endpoint, "", "endpoint 归零（后续同参早退、切回 agent 自然重拉）");
    assert.deepEqual(fn.rendered, [""], "按空态重渲一次");
    fn.sync("");
    assert.deepEqual(fn.rendered, [""], "同参二次调用早退");
    assert.deepEqual(fn.refetched, [], "空态不发重拉");
  });
});

describe("done（跑完未读）标记与绿点（dsh completed/completionUnread 同构）", () => {
  const mkObserver = () => new Function(`
    const terminalDoneUnread = new Map();
    const terminalPrevWorking = new Map();
    let activeTerminalPreviewId = "t-focus";
    ${extractFn("noteTerminalWorkingStatus")}
    return { note: noteTerminalWorkingStatus, marked: (id) => terminalDoneUnread.has(id) };
  `)();

  it("翻转观测：非聚焦会话真实观测到 working→idle 才置标；初拍不置", () => {
    const h = mkObserver();
    h.note({ id: "t-bg", backendState: { status: "running" } }, "working");
    assert.ok(!h.marked("t-bg"), "跑着不置");
    h.note({ id: "t-bg", backendState: { status: "running" } }, "idle");
    assert.ok(h.marked("t-bg"), "后台翻完成即置（dsh completed）");
    const fresh = mkObserver();
    fresh.note({ id: "t-bg", backendState: { status: "running" } }, "idle");
    assert.ok(!fresh.marked("t-bg"), "初拍（刷新后首见直接 idle）不置——不拿想象补标");
  });

  it("聚焦即读：翻转发生在焦点上的会话不置标", () => {
    const h = mkObserver();
    h.note({ id: "t-focus", backendState: { status: "running" } }, "working");
    h.note({ id: "t-focus", backendState: { status: "running" } }, "idle");
    assert.ok(!h.marked("t-focus"), "看着＝已读，不置");
  });

  it("working 再起清旧标、下次完成重新置；exited 清标且不置", () => {
    const h = mkObserver();
    h.note({ id: "a", backendState: { status: "running" } }, "working");
    h.note({ id: "a", backendState: { status: "running" } }, "idle");
    assert.ok(h.marked("a"), "先置上");
    h.note({ id: "a", backendState: { status: "running" } }, "working");
    assert.ok(!h.marked("a"), "跑起来就不再是「已完成」");
    h.note({ id: "a", backendState: { status: "running" } }, "idle");
    assert.ok(h.marked("a"), "再次完成重新置");
    h.note({ id: "a", backendState: { status: "exited" } }, "idle");
    assert.ok(!h.marked("a"), "退出清标");
    h.note({ id: "b", backendState: { status: "running" } }, "working");
    h.note({ id: "b", backendState: { status: "exited" } }, "idle");
    assert.ok(!h.marked("b"), "working 直接翻 exited 不置");
  });

  it("行渲染：working 转圈优先、非聚焦 done 绿点、聚焦/无标/非 live 空槽；pending 行不涉及 done", () => {
    const mkRow = (seed) => new Function("seed", `
      function sessTitle(s) { return s.title || String(s.id || "").slice(0, 8); }
      function terminalRailRelTime() { return "3 分钟"; }
      function terminalRailIsArchived() { return false; }
      function esc(v) { return String(v); }
      function escapeHtml(v) { return String(v || ""); }
      const TERMINAL_RAIL_SPINNER = '<span class="rail-term-spinner">SPINNER-STUB</span>';
      const TERMINAL_RAIL_DONE_DOT = '<span class="rail-term-done" title="已完成">DONE-STUB</span>';
      const TERMINAL_RAIL_ICON_ARCHIVE = "<svg></svg>";
      const TERMINAL_RAIL_ICON_UNARCHIVE = "<svg></svg>";
      const terminalDoneUnread = new Map(seed);
      let terminalRailSelectPending = null;
      ${extractFn("terminalRailStateSlotHtml")}
      ${extractFn("terminalRailRowHtml")}
    ${extractFn("terminalRailPendingFreshActive")}
    ${extractFn("terminalRailPendingFreshArmed")}
      return terminalRailRowHtml;
    `)(seed);
    const plain = mkRow([]);
    const seeded = mkRow([["t-2", true]]);
    const session = { id: "s-1", endpoint: "kimi", title: "权限矩阵", lastActive: 100 };
    const liveIdle = { id: "t-2", status: "idle" };
    const doneRow = seeded(session, liveIdle, "t-1");
    assert.ok(doneRow.includes("DONE-STUB") && !doneRow.includes("SPINNER-STUB"), "非聚焦已完成行：槽内绿点非转圈");
    const workingRow = seeded(session, { id: "t-2", status: "working" }, "t-1");
    assert.ok(workingRow.includes("SPINNER-STUB") && !workingRow.includes("DONE-STUB"), "working 转圈优先于绿点");
    const focusedRow = seeded(session, liveIdle, "t-2");
    assert.ok(!focusedRow.includes("DONE-STUB") && !focusedRow.includes("SPINNER-STUB"), "聚焦＝已读：渲染面同语义兜底，空槽");
    const plainRow = plain(session, liveIdle, "t-1");
    assert.ok(!plainRow.includes("DONE-STUB") && !plainRow.includes("SPINNER-STUB"), "idle 无标：空槽");
    const nonLiveRow = plain(session, null, "t-1");
    assert.ok(!nonLiveRow.includes("DONE-STUB") && !nonLiveRow.includes("SPINNER-STUB"), "非 live 行恒空槽");
    assert.ok(extractFn("terminalRailPendingRowHtml").includes('working ? TERMINAL_RAIL_SPINNER : ""'), "pending 行维持 working 转圈/留空两态（方案定死不涉及 done）");
  });

  it("绿点规格与四路清除接线（源码钉）：dsh 状态点规格＋清除在位", () => {
    const doneRule = cssRule(".rail-term-done {");
    assert.ok(doneRule.includes("width: 10px") && doneRule.includes("height: 10px"), "10×10 槽（dsh 状态点规格）");
    const afterRule = panelCss.slice(panelCss.indexOf(".rail-term-done::after")).slice(0, 220);
    assert.ok(afterRule.includes("inset: 20%") && afterRule.includes("var(--ok)") && afterRule.includes("border-radius: 50%"), "视觉 6px 圆、--ok（dsh success 档）、:after 承载");
    assert.ok(extractFn("terminalRailActivateSession").includes("terminalDoneUnread.delete(id)"), "点行即读：activate 即时清标");
    const sendAt = panelJs.indexOf("function sendTerminalInput");
    const sendBlock = panelJs.slice(sendAt, sendAt + 700);
    assert.ok(sendBlock.includes("terminalDoneUnread.delete(sessionId)"), "键入即读：sendTerminalInput 清标");
    const hollowAt = panelJs.indexOf("terminalHollowStreak.delete(id);");
    const closeBlock = panelJs.slice(hollowAt - 200, hollowAt + 500);
    assert.ok(closeBlock.includes("terminalDoneUnread.delete(id)") && closeBlock.includes("terminalPrevWorking.delete(id)"), "关页签即失效：done 标记与上一拍状态两表同清");
    const rebuildAt = panelJs.indexOf("function rebuildTerminalBackendSessions");
    const rebuildBlock = panelJs.slice(rebuildAt, rebuildAt + 700);
    assert.ok(rebuildBlock.includes("pruneTerminalDoneState()"), "整表换血清孤儿标记（别处关掉的会话不串到同 id 下一代）");
  });
});

