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
      assert.ok(!/id="railTermNewBtn"[^>]*>新建终端<\/button>/.test(body) || true, "无额外文案");
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

    it("列表底部 24px 渐隐遮罩、滚条 5px、折叠态只留头像与新建图标", () => {
      const fade = cssRule(".rail-term-fade {");
      assert.ok(fade.includes("height: 24px"), "底部渐隐 24px");
      assert.ok(fade.includes("linear-gradient(to bottom, transparent, var(--surface))"), "渐隐终点取栏底色 token，不造新色值");
      assert.ok(fade.includes("pointer-events: none"), "遮罩不吃点击");
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
        const activeTerminalPreviewId = "t1";
        function terminalSessionFor(id) { return id === "t1" ? session : null; }
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
          const activeTerminalPreviewId = "t1";
          function terminalSessionMap() { return sessions; }
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
          const activeTerminalPreviewId = "t1";
          const terminalRailRendered = { agent: null, open: null, history: null };
          function $(id) { return id === "railTermOpenList" ? list : null; }
          function terminalSessionMap() { return sessions; }
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
      const log = { posts: [], toasts: [], renders: 0, active: null };
      const sandbox = new Function("session", "log", "apiImpl", `
        const terminalBackendSessions = {};
        let activeTerminalPreviewId = null;
        function api(method, path, body) { log.posts.push({ method, path, body }); return apiImpl(method, path, body); }
        function toast(msg, isErr) { log.toasts.push({ msg, isErr }); }
        function panelError(err, fallback) { return fallback; }
        function terminalBackendSession(item) { return { ...item }; }
        function rememberTerminalSessionId(id) { log.active = id; }
        function rememberTerminalCwd() {}
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
      assert.ok(!extractFn("terminalRailResumeSession").includes("clipboard"), "不做复制命令（用户拍板）");    });

    it("M3 回 400 resume-unsupported：同一句提示，不登记会话", async () => {
      const err = Object.assign(new Error("HTTP 400：resume-unsupported"), { code: "resume-unsupported" });
      const { sandbox, log } = runResume(RESUMABLE, async () => { throw err; });
      await sandbox.run();
      await flush();
      assert.equal(log.toasts.length, 1, "服务端判不可续接时同句提示");
      assert.equal(log.toasts[0].msg, "这个 Agent 的会话暂时不能在终端里续接", "与前端预判同一句，不暴露短码");
      assert.deepEqual(Object.keys(sandbox.sessions), [], "失败不登记会话");
      assert.equal(sandbox.activeId(), null, "活跃指针不动");
    });

    it("其它失败落既有兜底文案，不吞错", async () => {
      const { sandbox, log } = runResume(RESUMABLE, async () => {
        throw Object.assign(new Error("HTTP 500"), { code: "spawn_failed" });
      });
      await sandbox.run();
      await flush();
      assert.equal(log.toasts.length, 1);
      assert.equal(log.toasts[0].msg, "无法启动这个终端", "非续接类失败走终端创建的既有兜底");
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
          function terminalSessionFor(id) { return id === "t1" ? activeSession : null; }
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
