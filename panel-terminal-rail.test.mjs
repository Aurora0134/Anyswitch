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
      for (const id of ["railTermAgentAvatar", "railTermAgentName", "railTermNewBtn",
        "railTermOpenList", "railTermHistoryRefresh", "railTermHistoryList"]) {
        assert.ok(dir[1].includes(`id="${id}"`), `骨架节点 ${id} 就位`);
      }
      // 身份行在上、新建其次、两个段自上而下（用户拍板的栏体顺序）
      const body = dir[1];
      assert.ok(body.indexOf('id="railTermAgentAvatar"') < body.indexOf('id="railTermNewBtn"')
        && body.indexOf('id="railTermNewBtn"') < body.indexOf("打开的终端")
        && body.indexOf("打开的终端") < body.indexOf("历史会话"),
        "栏体自上而下：身份行 → 新建终端 → 打开的终端 → 历史会话");
    });

    it("文案只用已批准的清单：新建终端 / 打开的终端 / 历史会话 / 刷新会话列表", () => {
      const rail = railHtml();
      const body = rail.slice(rail.indexOf('id="railTerminalDir"'), rail.indexOf('class="rail-foot"'));
      assert.ok(/id="railTermNewBtn"[^>]*title="新建终端"[^>]*aria-label="新建终端"/.test(body),
        "「新建终端」与页签栏加号同词同义");
      assert.ok(body.includes('title="新建终端"'), "新建按钮 title 就是产品动词本身");
      assert.ok(body.includes(">新建终端<"), "新建按钮可见文案「新建终端」");
      assert.ok(body.includes(">打开的终端<"), "段头「打开的终端」");
      assert.ok(body.includes(">历史会话<"), "段头「历史会话」");
      assert.ok(/id="railTermHistoryRefresh"[^>]*title="刷新会话列表"[^>]*aria-label="刷新会话列表"/.test(body),
        "刷新图标 title/aria-label「刷新会话列表」");
      // 栏内可见文案只许是批准清单里的那几句：把 HTML 文本节点全取出来逐个比对，
      // 新造词一进来就红（不是只看某一条正则不命中）。
      const textNodes = [...body.matchAll(/>([^<>]+)</g)].map((m) => m[1].trim()).filter(Boolean);
      const APPROVED = new Set(["终端会话", "本地终端", "新建终端", "打开的终端", "历史会话", "刷新会话列表"]);
      assert.deepEqual(textNodes.filter((t) => !APPROVED.has(t)), [], "栏体静态文案全部在批准清单内");
      assert.ok(textNodes.includes("新建终端"), "新建按钮的可见文案在清单里");
    });

    it("身份行头像槽留通用终端字形兜底，品牌头像由看板克隆后填", () => {
      const rail = railHtml();
      const slot = rail.match(/<span class="rail-term-agent-avatar" id="railTermAgentAvatar"[^>]*>([\s\S]*?)<\/span>\s*<span class="rail-term-agent-name"/);
      assert.ok(slot, "头像槽在册");
      assert.ok(slot[1].includes("rail-term-agent-glyph"), "槽位默认内容是通用终端字形（无 agent 时不留空槽）");
      assert.ok(slot[1].includes("<svg"), "通用字形是既有 feather 风 svg");
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
      const closeRule = panelCss.match(/\.rail-term-row-open:hover \.rail-term-row-close \{([^}]*)\}/);
      assert.ok(closeRule, "hover 出关闭叉（只限有动作的「打开的终端」行）");
      assert.ok(closeRule[1].includes("display: inline-flex"), "动作按钮 display 硬切（无淡入无位移）");
      const arrow = cssRule(".rail-term-group-arrow {");
      assert.ok(arrow.includes("transition: transform .15s cubic-bezier(.4,0,.2,1)"),
        "组箭头是栏内唯一一条 CSS 过渡：.15s + 设计缓动");
      assert.ok(panelCss.includes(".rail-term-group.is-open .rail-term-group-arrow { transform: rotate(90deg); }"),
        "展开态箭头旋转 90°");
      const rm = panelCss.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.rail-term-group-arrow \{ transition: none; \}/);
      assert.ok(rm, "prefers-reduced-motion 下箭头过渡关掉");
    });

    it("矮窗口不重叠：定高块 flex:none，只有历史会话段吃剩余空间并自己滚", () => {
      // 真机缺陷：栏体是列 flex，定高块默认 flex:0 1 auto 会参与收缩，而它们的行有
      // min-height、容器没有 → 行溢出容器画到下一段头上（「打开的终端」行压在
      // 「历史会话」段头里）。布局几何在桩框架里量不出来（要真渲染才有 rect），
      // 所以这里钉住让几何成立的结构契约；几何本身由无头 Chrome harness 验。
      const dir = cssRule("#railTerminalDir {");
      // 只比对声明（注释里也会出现「min-height:0」这类说明文字）
      const decls = (block) => block.replace(/\/\*[\s\S]*?\*\//g, "");
      assert.ok(!/min-height:\s*0/.test(decls(dir)), "栏体不吃 min-height:0（否则定高内容可被压到内容高度以下）");
      for (const [selector, why] of [
        [".rail-term-agent {", "身份行"],
        [".rail-term-new {", "新建终端钮"],
        [".rail-term-section {", "段容器"],
        [".rail-term-section-head {", "段头"],
        [".rail-term-open, .rail-term-history {", "两个列表容器"],
      ]) {
        assert.ok(cssRule(selector).includes("flex: none"), `${why} 是定高块，必须 flex:none（不参与收缩）`);
      }
      const hist = cssRule(".rail-term-section-history {");
      assert.ok(hist.includes("flex: 1 1 auto") && hist.includes("min-height: 0"),
        "历史会话段是唯一吃剩余空间的那段（空间不够时它先缩）");
      assert.ok(cssRule(".rail-term-history-scroll {").includes("overflow-y: auto"),
        "历史列表在自己的滚动容器里滚，溢出由它裁切、不越段");
      // 列表容器不得靠 overflow:hidden 掩盖问题（那会把行切掉，不是修）
      assert.ok(!/\.rail-term-open[^{]*\{[^}]*overflow/.test(panelCss), "「打开的终端」列表不靠 overflow 裁切");
    });

    it("列表底部 24px 渐隐遮罩、滚条 5px、折叠态只留头像与新建图标", () => {
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
      // 滚区底距 = 遮罩高度：末行底边落在渐隐上沿，整行可读
      const scroll = cssRule(".rail-term-history-scroll {");
      assert.ok(scroll.includes("padding-bottom: 24px"), "滚动区底距对齐遮罩高度（16px 会让末行压在渐变里）");
      assert.ok(panelCss.includes(".rail-term-history-scroll::-webkit-scrollbar { width: 5px; }"), "滚条 5px");
      // 折叠态（72px 图标栏）两个来处：窄栏自动档与手动态 collapsed
      assert.ok(/:is\(\.rail-term-agent-name, \.rail-term-new-label, \.rail-term-section\) \{ display: none; \}/.test(panelCss),
        "折叠态列表整段不出（dsh 折叠同款取舍）");
      assert.ok(/:root\[data-ui-version="v2"\]:not\(\[data-rail="expanded"\]\) \.rail-term-new \{ justify-content: center; padding: 9px 0; margin: 0; \}/.test(panelCss),
        "窄栏（<1200 自动档）新建按钮收成图标钮");
      assert.ok(/:root\[data-ui-version="v2"\]\[data-rail="collapsed"\] \.rail-term-new \{ justify-content: center; padding: 9px 0; margin: 0; \}/.test(panelCss),
        "手动态 collapsed 同形制");
    });

    it("样式全走语义 token：不新增色值", () => {
      const start = panelCss.indexOf("/* ── 终端会话栏（M4）");
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

    it("「打开的终端」只列同一 agent 的会话；无 agent 聚焦时列空白终端", () => {
      const run = (sessions, agentId) => {
        const fn = new Function("sessions", "agentId", `
          let terminalBackendReady = true;
          const terminalBackendSessions = sessions;
          const activeTerminalPreviewId = "t1";
          ${extractFn("terminalRailSessionMap")}
          ${extractFn("terminalRailActiveSession")}
          ${extractFn("terminalRailAgentId")}
          ${extractFn("terminalRailOpenSessions")}
          return terminalRailOpenSessions;
        `)(sessions, agentId);
        return fn(agentId).map((s) => s.id);
      };
      const sessions = {
        t1: { id: "t1", agent: { endpointId: "claude" } },
        t2: { id: "t2", agent: { endpointId: "claude" } },
        t3: { id: "t3", agent: { endpointId: "kimi" } },
        t4: { id: "t4", agent: null },
      };
      assert.deepEqual(run(sessions, "claude"), ["t1", "t2"], "严格跟随活跃 agent，不跨 agent 浏览");
      assert.deepEqual(run(sessions, ""), ["t4"], "无 agent 聚焦时列空白终端");
      assert.deepEqual(run({}, "claude"), [], "零会话落空表，不炸");
    });
  });

  describe("历史会话：分组、水位线、指纹（vm 真跑）", () => {
    const groupFn = () => {
      const fn = new Function(`
        ${extractFn("sessDirName")}
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

    it("打开的终端列表指纹门控：同串不重写 DOM，身份/状态变化才重写", () => {
      const run = (sessions, agentId, seed) => {
        const list = { html: seed, writes: 0 };
        Object.defineProperty(list, "innerHTML", {
          get: () => list.html,
          set: (v) => { list.writes += 1; list.html = v; },
        });
        const fn = new Function("sessions", "agentId", "list", "esc", "escapeHtml", `
          let terminalBackendReady = true;
          const terminalBackendSessions = sessions;
          const activeTerminalPreviewId = "t1";
          const terminalRailRendered = { agent: null, open: null, history: null };
          function $(id) { return id === "railTermOpenList" ? list : null; }
          ${extractFn("terminalRailSessionMap")}
          ${extractFn("terminalRailActiveSession")}
          ${extractFn("terminalRailAgentId")}
          ${extractFn("terminalRailOpenSessions")}
          ${extractFn("renderTerminalRailOpenList")}
          return { render: renderTerminalRailOpenList, rendered: terminalRailRendered };
        `)(sessions, agentId, list, esc, escapeHtml);
        return { fn, list };
      };
      const sessions = {
        t1: { id: "t1", label: "Kimi Code", agent: { endpointId: "kimi" }, status: "working", shell: { name: "命令提示符" } },
        t2: { id: "t2", label: "新终端", agent: { endpointId: "kimi" }, status: "idle", shell: { name: "PowerShell" } },
      };
      const a = run(sessions, "kimi", "");
      a.fn.render("kimi");
      assert.equal(a.list.writes, 1, "首帧写入");
      assert.ok(a.list.html.includes('data-rail-term-session="t1"'), "行带会话 id");
      assert.ok(a.list.html.includes("terminal-tab-state is-working"), "状态点沿用页签同款样式");
      assert.ok(a.list.html.includes("is-active"), "活跃行有选中态");
      assert.ok(a.list.html.includes('data-rail-term-close="t1"'), "行内关闭叉走同一关闭处理");
      assert.ok(a.list.html.includes('aria-hidden="true">×</span>'), "关闭叉照页签形制：字形 + aria-hidden，不新造文案");
      a.fn.render("kimi");
      assert.equal(a.list.writes, 1, "同串再渲不写 DOM（指纹门控）");
      sessions.t2.status = "working";
      a.fn.render("kimi");
      assert.equal(a.list.writes, 2, "状态变化即重写");
      assert.equal(a.fn.rendered.open, a.list.html, "指纹恒等于 DOM 现值");
    });
  });

  describe("历史会话点击：续接两分支（vm 真跑）", () => {
    const runResume = (session, apiImpl) => {
      const log = { posts: [], toasts: [], renders: 0, active: null, rememberedCwd: [] };
      const sandbox = new Function("session", "log", "apiImpl", `
        const terminalBackendSessions = {};
        let activeTerminalPreviewId = null;
        function api(method, path, body) { log.posts.push({ method, path, body }); return apiImpl(method, path, body); }
        function toast(msg, isErr) { log.toasts.push({ msg, isErr }); }
        function panelError(err, fallback) { return fallback; }
        function terminalBackendSession(item) { return { ...item }; }
        function rememberTerminalSessionId(id) { log.active = id; }
        function rememberTerminalCwd(cwd) { log.rememberedCwd.push(cwd); }
        function renderTerminalPreviewSession() { log.renders += 1; }
        function terminalCreateSize() { return { cols: 120, rows: 34 }; }
        function terminalCwdInitial() { return "C:\\\\Users\\\\fixture"; }
        ${extractFn("createAgentTerminal")}
        ${extractFn("terminalRailResumeSession")}
        return {
          run: () => terminalRailResumeSession(session),
          sessions: terminalBackendSessions,
          activeId: () => activeTerminalPreviewId,
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
        { ...RESUMABLE, project: "C:\\Users\\86183\\Desktop\\agent-home" },
        async () => ({ id: "t-9", label: "Claude Code", agentId: "claude", shell: "cmd", cwd: "C:\\Users\\86183\\Desktop\\agent-home" }),
      );
      await sandbox.run();
      const post = log.posts.find((p) => p.path === "/api/terminal/agent-sessions");
      assert.ok(post, "发起续接请求");
      assert.equal(post.body.cwd, "C:\\Users\\86183\\Desktop\\agent-home", "cwd = 会话 project");
      assert.notEqual(post.body.cwd, "C:\\Users\\86183\\fixture", "不是「记住上次」的那个目录");
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
  });

  describe("打开的终端行交互（vm 真跑）", () => {
    const runRail = ({ sessions, activeId = "t1", tabs = null }) => {
      const log = { renders: 0, remembered: [] };
      const els = { terminalTabs: tabs };
      const sandbox = new Function("sessions", "activeId", "log", "els", `
        const terminalBackendSessions = sessions;
        let activeTerminalPreviewId = activeId;
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

  describe("未就绪不泄漏设计稿预览种子（缺陷 B）", () => {
    const run = (ready, backendSessions, previewSessions, activeId = "t1") => {
      const fn = new Function("ready", "backendSessions", "previewSessions", "activeId", `
        let terminalBackendReady = ready;
        const terminalBackendSessions = backendSessions;
        const terminalPreviewSessions = previewSessions;
        const activeTerminalPreviewId = activeId;
        function terminalSessionMap() { return terminalBackendReady ? terminalBackendSessions : terminalPreviewSessions; }
        ${extractFn("terminalRailSessionMap")}
        ${extractFn("terminalRailActiveSession")}
        ${extractFn("terminalRailAgentId")}
        ${extractFn("terminalRailOpenSessions")}
        return { agentId: terminalRailAgentId, open: terminalRailOpenSessions };
      `)(ready, backendSessions, previewSessions, activeId);
      return fn;
    };

    // 设计稿遗留的预览种子：未就绪时 terminalSessionMap 会回落这张表
    const PREVIEW = {
      checkout: { id: "checkout", label: "payment-service", shell: { name: "PowerShell" }, agent: null, status: "idle" },
      "preview-1": { id: "preview-1", label: "新终端", shell: { name: "PowerShell" }, agent: null, status: "idle" },
    };
    const BACKEND = {
      t1: { id: "t1", label: "Claude Code", shell: { name: "命令提示符" }, agent: { endpointId: "claude" }, status: "idle" },
    };

    it("未就绪：「打开的终端」一个都不列——预览种子不许冒充真实终端", () => {
      const fn = run(false, BACKEND, PREVIEW, "checkout");
      assert.deepEqual(fn.open("").map((s) => s.id), [], "未就绪时列表为空，不把 payment-service 等种子当真实终端");
      const fn2 = run(false, BACKEND, PREVIEW, "preview-1");
      assert.deepEqual(fn2.open("").map((s) => s.id), [], "预览稿的新终端 id 同样不列");
    });

    it("未就绪：身份行取不到 agent，落通用终端态（不冒充某个 agent）", () => {
      const fn = run(false, BACKEND, PREVIEW, "checkout");
      assert.equal(fn.agentId(), "", "未就绪时身份为空 → 身份行走通用终端标识");
      const withAgentSeed = { ...PREVIEW, checkout: { ...PREVIEW.checkout, agent: { endpointId: "kimi" } } };
      const fn2 = run(false, BACKEND, withAgentSeed, "checkout");
      assert.equal(fn2.agentId(), "", "就算种子自带 agent 身份也不采信（那不是真实终端）");
    });

    it("就绪后照常列真实终端、身份行跟随真实归属", () => {
      const fn = run(true, BACKEND, PREVIEW, "t1");
      assert.deepEqual(fn.open("claude").map((s) => s.id), ["t1"], "就绪时只列真实后端会话");
      assert.equal(fn.agentId(), "claude", "身份取真实会话的归属");
    });

    it("源码钉死：栏体两个入口都不读预览种子表", () => {
      const src = extractFn("terminalRailOpenSessions") + extractFn("terminalRailAgentId");
      assert.ok(!src.includes("terminalSessionMap"), "栏体不再经 terminalSessionMap 回落预览种子");
      const map = extractFn("terminalRailSessionMap");
      assert.ok(map.includes("terminalBackendReady"), "先看就绪位：未就绪一律空");
      assert.ok(!map.includes("terminalPreviewSessions"), "就绪位的假分支不回落到预览种子表");
      assert.ok(extractFn("terminalRailAgentId").includes("terminalRailActiveSession"), "身份行同样只认后端真值");
      assert.ok(extractFn("renderTerminalRailAgent").includes("terminalRailActiveSession"), "渲染身份行不直读 terminalSessionFor");
      assert.ok(extractFn("renderTerminalRailHistory").includes("terminalRailActiveSession"), "历史段找活跃组同样不读种子");
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
      assert.ok(fetchSrc.includes('api("GET", "/api/sessions/list")'), "历史会话数据源是会话列表接口");
      const poll = panelJs.match(/async function pollTerminalSessions\([\s\S]*?\n  \}/)?.[0];
      assert.ok(poll, "pollTerminalSessions 在册");
      assert.ok(!poll.includes("/api/sessions/list"), "1s 轮询不碰全量扫盘（6.7s 无缓存，禁挂轮询）");
      assert.ok(extractFn("enterTerminalRail").includes("renderTerminalRail()"), "进页即渲一帧（不必等轮询）");
      assert.ok(panelJs.includes('$("railTermHistoryRefresh").onclick'), "段头刷新图标是唯一的手动重取入口");
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

    it("返回镜像：终端态栏底「返回」回进入终端前的视图（settingsReturnView 同款）", () => {
      const init = extractFn("initTerminalRail");
      assert.ok(init.includes("closeTerminalPreview"), "终端态「返回」回 terminalReturnView（closeTerminalPreview 同一链）");
      assert.ok(panelJs.includes("const exitSettings = () => switchView(settingsReturnView);")
        && panelJs.includes('if (railBackBtn) railBackBtn.onclick = exitSettings;'),
        "设置态那条既有绑定原样保留（一颗钮两态互斥）");
      assert.ok(extractFn("openTerminalPreview").includes("terminalReturnView = currentView;"),
        "进入终端前记下返回目标");
    });

    it("新建终端：对当前 agent 建终端，cwd 沿用记住上次，无 agent 建空白终端，禁用位跟就绪位", () => {
      const create = extractFn("terminalRailCreateTerminal");
      assert.ok(create.includes("terminalCwdInitial()"), "cwd 沿用既有「记住上次」逻辑");
      assert.ok(create.includes("createAgentTerminal({ agentId, cwd })"), "有 agent 走一键启动同一通路");
      assert.ok(create.includes('api("POST", "/api/terminal/sessions"'), "无 agent 建空白终端");
      assert.ok(create.includes("terminalBackendReady"), "就绪闸与页签栏加号同拍");
      assert.ok(extractFn("renderTerminalRail").includes("newBtn.disabled = !terminalBackendReady")
        || panelJs.includes("railTermNewBtn") && panelJs.includes("disabled = !terminalBackendReady"),
        "禁用态跟就绪位同拍");
    });

    it("明确不做：搜索、置顶、拖拽排序、管理菜单、快捷键、跑马灯、未读角标", () => {
      const railBlock = panelJs.slice(panelJs.indexOf("终端会话栏（M4）"), panelJs.indexOf("function initSkillsTab"));
      assert.ok(railBlock.length > 1000, "栏体代码段可取样");
      for (const forbidden of ["draggable", "marquee", "contextmenu", "快捷键"]) {
        assert.ok(!railBlock.includes(forbidden), `不做清单项「${forbidden}」不在栏体代码里`);
      }
      assert.ok(!panelJs.includes("terminalRailPin"), "无置顶");
      assert.ok(!panelJs.includes("terminalRailSearch"), "无搜索");
    });
  });

  describe("FLIP 门控（vm 真跑）", () => {
    const runFlip = ({ mode = "flip", armed = true, reduced = false, before = new Map() }) => {
      const animated = [];
      const rows = [
        { key: "s1", top: 10 },
        { key: "s2", top: 70 },
        { key: "s3", top: 100 },
      ];
      const list = {
        querySelectorAll: () => rows.map((row) => ({
          getAttribute: () => row.key,
          getBoundingClientRect: () => ({ top: row.top }),
          animate: (frames, opts) => animated.push({ key: row.key, frames, opts }),
        })),
      };
      const fn = new Function("list", "before", "mode", "armed", "reduced", `
        const terminalRailFlipMode = mode;
        const terminalRailMotionArmed = armed;
        const window = { matchMedia: () => ({ matches: reduced }) };
        ${extractFn("playTerminalRailFlip")}
        return playTerminalRailFlip;
      `)(list, before, mode, armed, reduced);
      fn(list, before);
      return animated;
    };

    it("组展开/收起：位移 200ms ease-out、新行 100ms 淡入", () => {
      const animated = runFlip({ before: new Map([["s1", 10], ["s2", 40]]) });
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

    it("resetKey（水位线 / 刷新 / 换 agent）直接落位；首次输入前与 reduced-motion 不动", () => {
      const before = new Map([["s1", 0], ["s2", 0]]);
      assert.deepEqual(runFlip({ mode: "instant", before }), [], "水位线增减与刷新是瞬时跳变（dsh 实测）");
      assert.deepEqual(runFlip({ armed: false, before }), [], "首次输入前不做动画");
      assert.deepEqual(runFlip({ reduced: true, before }), [], "prefers-reduced-motion 全关");
      assert.deepEqual(runFlip({ before: new Map() }), [], "首次挂载直接落位（不做整列表淡入）");
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
          const terminalRailWatermarks = new Map();
          const TERMINAL_RAIL_WATERMARK = 5;
          const TERMINAL_RAIL_ICON_CHEVRON = "";
          const TERMINAL_RAIL_ICON_FOLDER_OPEN = "";
          const TERMINAL_RAIL_ICON_FOLDER_CLOSED = "";
          const terminalRailHistory = history;
          const activeTerminalPreviewId = "t1";
          function $(id) { return id === "railTermHistoryList" ? list : null; }
          let terminalBackendReady = true;
          const terminalBackendSessions = { t1: activeSession };
          ${extractFn("terminalRailSessionMap")}
          ${extractFn("terminalRailActiveSession")}
          function sessDirName(p) { return String(p || "").replace(/\\\\/g, "/").split("/").filter(Boolean).pop() || p || ""; }
          function sessTitle(s) { return s.title || String(s.id || "").slice(0, 8); }
          function sessRelTime() { return "刚刚"; }
          function esc(v) { return String(v); }
          function escapeHtml(v) { return String(v || ""); }
          function terminalRailScrollGroupIntoView(key) { state.scrolled.push(key); }
          function terminalRailRowTops() { return null; }
          function playTerminalRailFlip() {}
          ${extractFn("terminalRailGroupSessions")}
          ${extractFn("terminalRailWatermarkView")}
          ${extractFn("terminalRailNextWatermark")}
          ${extractFn("terminalRailMoreLabel")}
          ${extractFn("terminalRailSameDir")}
          ${extractFn("terminalRailGroupForDir")}
          ${extractFn("terminalRailHistoryRowHtml")}
          ${extractFn("renderTerminalRailHistory")}
          return { render: renderTerminalRailHistory, collapsed: terminalRailCollapsedGroups, scrolled: state.scrolled };
        `)(list, state, history, activeSession);
        return { fn, list, state };
      };

      const activeSession = { id: "t1", cwd: "C:\\dev\\alpha" };
      const collapsed = ["C:\\dev\\alpha"];
      // 首帧：历史还没拉回来（sessions 空），不许把「已自动展开」认下来
      const early = build({ endpoint: "kimi", sessions: [] }, activeSession, collapsed, "");
      early.fn.render("kimi");
      assert.equal(early.state.collapsed.has("C:\\dev\\alpha"), true, "数据没落地时不动组态（这一刻组表本来就是空的）");
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
      assert.equal(landed.state.collapsed.has("C:\\dev\\alpha"), false, "活跃终端所在组自动展开");
      assert.deepEqual(landed.state.scrolled, ["C:\\dev\\alpha"], "并滚到可见");

      // 已展开过一次之后：用户手动收起，后续轮询渲染不许把它顶回来
      const after = build(
        { endpoint: "kimi", sessions: [{ id: "s1", project: "C:\\dev\\alpha", title: "重构权限矩阵", lastActive: 100 }] },
        activeSession, ["C:\\dev\\alpha"], "kimi\u0000t1",
      );
      after.fn.render("kimi");
      assert.equal(after.state.collapsed.has("C:\\dev\\alpha"), true, "同一活跃终端不再自动展开（尊重用户手动收起）");
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
      const state = { collapsed: new Set(["C:\\dev\\alpha"]), scrolled: [] };
      const sandbox = new Function("list", "state", "activeSession", `
        let terminalRailRendered = { open: null, history: null };
        let terminalRailAutoExpandedFor = "";
        let terminalRailScrolledFor = "";
        let terminalRailFlipMode = "instant";
        const terminalRailCollapsedGroups = state.collapsed;
        const terminalRailWatermarks = new Map();
        const TERMINAL_RAIL_WATERMARK = 5;
        const TERMINAL_RAIL_ICON_CHEVRON = "";
        const TERMINAL_RAIL_ICON_FOLDER_OPEN = "";
        const TERMINAL_RAIL_ICON_FOLDER_CLOSED = "";
        let terminalRailHistory = { endpoint: "", sessions: [], fetchedAt: 0, error: null };
        const activeTerminalPreviewId = "t1";
        function $(id) { return id === "railTermHistoryList" ? list : null; }
        let terminalBackendReady = true;
        const terminalBackendSessions = { t1: activeSession };
        ${extractFn("terminalRailSessionMap")}
        ${extractFn("terminalRailActiveSession")}
        function sessDirName(p) { return String(p || "").replace(/\\\\/g, "/").split("/").filter(Boolean).pop() || p || ""; }
        function sessTitle(s) { return s.title || String(s.id || "").slice(0, 8); }
        function sessRelTime() { return "刚刚"; }
        function esc(v) { return String(v); }
        function escapeHtml(v) { return String(v || ""); }
        function terminalRailScrollGroupIntoView(key) { state.scrolled.push(key); }
        function terminalRailRowTops() { return null; }
        function playTerminalRailFlip() {}
        ${extractFn("terminalRailGroupSessions")}
        ${extractFn("terminalRailWatermarkView")}
        ${extractFn("terminalRailNextWatermark")}
        ${extractFn("terminalRailMoreLabel")}
        ${extractFn("terminalRailSameDir")}
        ${extractFn("terminalRailGroupForDir")}
        ${extractFn("terminalRailHistoryRowHtml")}
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
      assert.equal(state.collapsed.has("C:\\dev\\alpha"), true, "失败态不动组态");

      // 第二帧：用户手动刷新成功，列表落地 → 活跃组照常自动展开并滚到可见。
      sandbox.setHistory({
        endpoint: "kimi",
        sessions: [{ id: "s1", project: "C:\\dev\\alpha", title: "重构权限矩阵", lastActive: 100 }],
        fetchedAt: 2, error: null,
      });
      sandbox.render("kimi");
      assert.equal(sandbox.autoExpandedFor(), "kimi\u0000t1", "成功落地才认下「已自动展开」");
      assert.equal(state.collapsed.has("C:\\dev\\alpha"), false, "活跃组自动展开");
      assert.deepEqual(state.scrolled, ["C:\\dev\\alpha"], "并滚到可见");
    });

    it("水位线与刷新把 flip 模式置回 instant；组展开才置 flip", () => {
      assert.ok(extractFn("toggleTerminalRailWatermark").includes('terminalRailFlipMode = "instant"'), "水位线点击 = resetKey");
      assert.ok(extractFn("toggleTerminalRailGroup").includes('terminalRailFlipMode = "flip"'), "组展开/收起走 FLIP");
      assert.ok(extractFn("refreshTerminalRailHistory").includes('terminalRailFlipMode = "instant"'), "刷新直接落位");
      assert.ok(extractFn("renderTerminalRailHistory").includes('terminalRailFlipMode = "instant"'),
        "一帧用完即复位，下一次更新默认瞬时");
      assert.ok(extractFn("renderTerminalRailHistory").includes('terminalRailFlipMode === "flip" ? terminalRailRowTops(list) : null'),
        "旧位置只在真要播 FLIP 时才量（1s 轮询每拍都渲染，无条件量行等于每秒一次强制布局）");
      assert.ok(extractFn("initTerminalRail").includes("terminalRailMotionArmed = true"), "首次指针/键盘输入才武装动画");
    });
  });
});
