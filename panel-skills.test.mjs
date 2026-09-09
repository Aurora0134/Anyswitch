import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPanelRouter } from "./panel.mjs";

// Skills tab routes: the router is exercised with a mock skills service so no
// real home directories, junctions, or PowerShell subprocesses are touched.
// Mirrors the fakeReqRes pattern from panel.test.mjs.

function fakeReqRes(url, method = "GET", body = null, extraHeaders = {}) {
  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(code, h) { this.statusCode = code; this.headers = h || {}; },
    end(data) { if (data !== undefined) this.body += data; },
  };
  const listeners = {};
  const req = {
    url,
    method,
    headers: {
      host: "127.0.0.1",
      origin: "http://127.0.0.1:47820",
      "x-anyswitch-panel": "1",
      ...extraHeaders,
    },
    on(event, fn) { listeners[event] = fn; return req; },
  };
  if (body !== null) {
    queueMicrotask(() => {
      listeners.data?.(Buffer.from(JSON.stringify(body)));
      listeners.end?.();
    });
  }
  const json = () => (res.body ? JSON.parse(res.body) : null);
  return { req, res, json };
}

function skillsRouter(skillsService) {
  return createPanelRouter({
    storePaths: { root: "C:/fake/anyswitch" },
    logger: null,
    metricsCollector: null,
    aliasResolver: null,
    aliasPath: null,
    fetchRelayAgents: async () => null,
    skillsService,
  });
}

function mockService(overrides = {}) {
  return {
    getState: () => ({ repoPath: "C:/repo/skills", repoValid: true, skills: [], endpoints: [], candidates: [] }),
    setRepoPath: (p) => ({ repoPath: p, skillCount: 3 }),
    pickFolder: async () => ({ cancelled: true }),
    importSkill: (sourcePath) => ({ skill: { name: "x", dirName: sourcePath } }),
    importPickedSkill: async () => ({ cancelled: true }),
    importPickedZip: async () => ({ cancelled: true }),
    deleteRepoSkill: async () => ({ unlinked: ["claude"] }),
    deleteLocalSkill: async () => ({ ok: true }),
    deploy: async () => ({ ok: true }),
    undeploy: async () => ({ ok: true }),
    mergeLocalSkill: async () => ({ ok: true }),
    resolveConflictSkill: async () => ({ ok: true }),
    diffLocalSkill: async () => ({ ok: true, diffs: [] }),
    readSkillBody: (relPath) => ({ name: relPath, dirName: relPath, relPath, content: "---\n---\n" }),
    ...overrides,
  };
}

describe("panel router skills routes", () => {
  it("GET /panel/api/skills/state aggregates the service state", async () => {
    const state = {
      repoPath: "C:/repo/skills",
      repoValid: true,
      skills: [{ name: "skill-a" }],
      endpoints: [{ id: "claude", entries: [] }],
      candidates: [{ path: "C:/cand", exists: true }],
    };
    const router = skillsRouter(mockService({ getState: () => state }));
    const { req, res, json } = fakeReqRes("/panel/api/skills/state", "GET");
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.deepEqual(json().skills, state.skills);
    assert.deepEqual(json().endpoints, state.endpoints);
    assert.deepEqual(json().candidates, state.candidates);
  });

  it("POST /panel/api/skills/repo validates and forwards repoPath", async () => {
    let got = null;
    const router = skillsRouter(mockService({ setRepoPath: (p) => { got = p; return { repoPath: p, skillCount: 2 }; } }));
    const { req, res, json } = fakeReqRes("/panel/api/skills/repo", "POST", { repoPath: "C:/repo/skills" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.equal(json().skillCount, 2);
    assert.equal(got, "C:/repo/skills");

    const bad = fakeReqRes("/panel/api/skills/repo", "POST", { repoPath: "" });
    await router.handle(bad.req, bad.res);
    assert.equal(bad.res.statusCode, 400);
    assert.equal(bad.json().ok, false);
  });

  it("POST /panel/api/skills/repo/pick returns the picker outcome verbatim", async () => {
    const router = skillsRouter(mockService({ pickFolder: async () => ({ cancelled: false, path: "D:\\skills" }) }));
    const { req, res, json } = fakeReqRes("/panel/api/skills/repo/pick", "POST", {});
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.equal(json().path, "D:\\skills");
  });

  it("POST /panel/api/skills/repo/import forwards sourcePath", async () => {
    let got = null;
    const router = skillsRouter(mockService({ importSkill: (s) => { got = s; return { skill: { name: "imported" } }; } }));
    const { req, res, json } = fakeReqRes("/panel/api/skills/repo/import", "POST", { sourcePath: "D:/external/skill" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().skill.name, "imported");
    assert.equal(got, "D:/external/skill");
  });

  it("POST /panel/api/skills/repo/import-pick returns the pick-and-import outcome verbatim", async () => {
    let called = false;
    const router = skillsRouter(mockService({
      importPickedSkill: async () => { called = true; return { cancelled: false, skill: { name: "picked" } }; },
    }));
    const { req, res, json } = fakeReqRes("/panel/api/skills/repo/import-pick", "POST", {});
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.equal(json().skill.name, "picked");
    assert.equal(called, true);

    const cancelled = skillsRouter(mockService());
    const c = fakeReqRes("/panel/api/skills/repo/import-pick", "POST", {});
    await cancelled.handle(c.req, c.res);
    assert.equal(c.res.statusCode, 200);
    assert.equal(c.json().cancelled, true);
  });

  it("POST /panel/api/skills/repo/import-pick-zip returns the zip pick-and-import outcome verbatim", async () => {
    let called = false;
    const router = skillsRouter(mockService({
      importPickedZip: async () => { called = true; return { cancelled: false, skill: { name: "zipped" } }; },
    }));
    const { req, res, json } = fakeReqRes("/panel/api/skills/repo/import-pick-zip", "POST", {});
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().ok, true);
    assert.equal(json().skill.name, "zipped");
    assert.equal(called, true);

    const cancelled = skillsRouter(mockService());
    const c = fakeReqRes("/panel/api/skills/repo/import-pick-zip", "POST", {});
    await cancelled.handle(c.req, c.res);
    assert.equal(c.res.statusCode, 200);
    assert.equal(c.json().cancelled, true);
  });

  it("POST /panel/api/skills/repo/delete forwards skillName and returns unlinked endpoints", async () => {
    let got = null;
    const router = skillsRouter(mockService({
      deleteRepoSkill: async (name) => { got = name; return { unlinked: ["claude", "kimi"] }; },
    }));
    const { req, res, json } = fakeReqRes("/panel/api/skills/repo/delete", "POST", { skillName: "old-skill" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(got, "old-skill");
    assert.deepEqual(json().unlinked, ["claude", "kimi"]);
  });

  it("POST /panel/api/skills/local/delete forwards endpointId/skillName", async () => {
    let got = null;
    const router = skillsRouter(mockService({
      deleteLocalSkill: async (args) => { got = args; return { ok: true }; },
    }));
    const { req, res, json } = fakeReqRes("/panel/api/skills/local/delete", "POST", {
      endpointId: "claude", skillName: "local-gem",
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(got, { endpointId: "claude", skillName: "local-gem" });
    assert.equal(json().ok, true);

    const bad = fakeReqRes("/panel/api/skills/local/delete", "POST", { endpointId: "claude", skillName: "" });
    await router.handle(bad.req, bad.res);
    assert.equal(bad.res.statusCode, 400);
  });

  it("POST /panel/api/skills/deploy forwards endpointId/skillName/force", async () => {
    let got = null;
    const router = skillsRouter(mockService({ deploy: async (args) => { got = args; return { ok: true }; } }));
    const { req, res, json } = fakeReqRes("/panel/api/skills/deploy", "POST", {
      endpointId: "kimi", skillName: "skill-a", force: true,
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(got, { endpointId: "kimi", skillName: "skill-a", force: true });
    assert.equal(json().ok, true);

    // force defaults to false when omitted
    const plain = fakeReqRes("/panel/api/skills/deploy", "POST", { endpointId: "kimi", skillName: "skill-a" });
    await router.handle(plain.req, plain.res);
    assert.equal(got.force, false);
  });

  it("POST /panel/api/skills/deploy passes a conflict through as 200 + conflict shape", async () => {
    const diffs = [{ path: "local-only.txt", kind: "only-b" }];
    const router = skillsRouter(mockService({
      deploy: async () => ({ ok: false, conflict: true, diffs }),
    }));
    const { req, res, json } = fakeReqRes("/panel/api/skills/deploy", "POST", { endpointId: "claude", skillName: "s" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200, "conflict is a confirm-flow response, not an error status");
    assert.equal(json().ok, false);
    assert.equal(json().conflict, true);
    assert.deepEqual(json().diffs, diffs);
  });

  it("POST /panel/api/skills/merge-local passes a conflict through too", async () => {
    const router = skillsRouter(mockService({
      mergeLocalSkill: async () => ({ ok: false, conflict: true, diffs: [{ path: "a.txt", kind: "different" }] }),
    }));
    const { req, res, json } = fakeReqRes("/panel/api/skills/merge-local", "POST", { endpointId: "pi", skillName: "s" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(json().conflict, true);
    assert.equal(json().diffs[0].kind, "different");
  });

  it("POST /panel/api/skills/undeploy forwards args and reports service errors", async () => {
    let got = null;
    const router = skillsRouter(mockService({
      undeploy: async (args) => {
        got = args;
        if (args.skillName === "real-dir") throw new Error("拒绝解除部署：实体目录");
        return { ok: true };
      },
    }));
    const ok = fakeReqRes("/panel/api/skills/undeploy", "POST", { endpointId: "claude", skillName: "skill-a" });
    await router.handle(ok.req, ok.res);
    assert.equal(ok.res.statusCode, 200);
    assert.deepEqual(got, { endpointId: "claude", skillName: "skill-a" });

    const bad = fakeReqRes("/panel/api/skills/undeploy", "POST", { endpointId: "claude", skillName: "real-dir" });
    await router.handle(bad.req, bad.res);
    assert.equal(bad.res.statusCode, 500);
    assert.equal(bad.json().ok, false);
    assert.match(bad.json().error, /实体目录/);
  });

  it("POST /panel/api/skills/resolve-conflict forwards the direction and validates it", async () => {
    let got = null;
    const router = skillsRouter(mockService({
      resolveConflictSkill: async (args) => { got = args; return { ok: true }; },
    }));
    const { req, res, json } = fakeReqRes("/panel/api/skills/resolve-conflict", "POST", {
      endpointId: "claude", skillName: "skill-a", direction: "local",
    });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(got, { endpointId: "claude", skillName: "skill-a", direction: "local" });
    assert.equal(json().ok, true);

    const bad = fakeReqRes("/panel/api/skills/resolve-conflict", "POST", {
      endpointId: "claude", skillName: "skill-a", direction: "sideways",
    });
    await router.handle(bad.req, bad.res);
    assert.equal(bad.res.statusCode, 400);
    assert.equal(bad.json().ok, false);
  });

  it("POST /panel/api/skills/diff returns the service diffs", async () => {
    const diffs = [{ path: "helper.txt", kind: "different" }];
    let got = null;
    const router = skillsRouter(mockService({
      diffLocalSkill: async (args) => { got = args; return { ok: true, diffs }; },
    }));
    const { req, res, json } = fakeReqRes("/panel/api/skills/diff", "POST", { endpointId: "kimi", skillName: "s" });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(got, { endpointId: "kimi", skillName: "s" });
    assert.deepEqual(json().diffs, diffs);
  });

  it("POST /panel/api/skills/body returns the SKILL.md content and maps service errors", async () => {
    let got = null;
    const router = skillsRouter(mockService({
      readSkillBody: (relPath) => {
        got = relPath;
        if (relPath === "ghost") {
          const error = new Error("repo 中不存在 skill: ghost");
          error.statusCode = 404;
          throw error;
        }
        return { name: "skill-a", dirName: "skill-a", relPath, content: "---\nname: skill-a\n---\n\nbody\n" };
      },
    }));
    const ok = fakeReqRes("/panel/api/skills/body", "POST", { relPath: "skill-a" });
    await router.handle(ok.req, ok.res);
    assert.equal(ok.res.statusCode, 200);
    assert.equal(got, "skill-a");
    assert.equal(ok.json().ok, true);
    assert.equal(ok.json().name, "skill-a");
    assert.match(ok.json().content, /name: skill-a/);

    const missing = fakeReqRes("/panel/api/skills/body", "POST", { relPath: "ghost" });
    await router.handle(missing.req, missing.res);
    assert.equal(missing.res.statusCode, 404);
    assert.equal(missing.json().ok, false);
    assert.match(missing.json().error, /不存在/);

    const blank = fakeReqRes("/panel/api/skills/body", "POST", { relPath: "  " });
    await router.handle(blank.req, blank.res);
    assert.equal(blank.res.statusCode, 400);
    assert.equal(blank.json().ok, false);
  });

  it("rejects skills POSTs without the panel header as CSRF (service never called)", async () => {
    let called = false;
    const router = skillsRouter(mockService({
      deploy: async () => { called = true; return { ok: true }; },
      setRepoPath: () => { called = true; return { repoPath: "x", skillCount: 1 }; },
    }));
    for (const [path, body] of [
      ["/panel/api/skills/deploy", { endpointId: "kimi", skillName: "s" }],
      ["/panel/api/skills/repo", { repoPath: "C:/x" }],
      ["/panel/api/skills/repo/delete", { skillName: "s" }],
      ["/panel/api/skills/repo/import-pick", {}],
      ["/panel/api/skills/repo/import-pick-zip", {}],
      ["/panel/api/skills/merge-local", { endpointId: "pi", skillName: "s" }],
    ]) {
      const { req, res, json } = fakeReqRes(path, "POST", body, { "x-anyswitch-panel": "" });
      delete req.headers["x-anyswitch-panel"];
      await router.handle(req, res);
      assert.equal(res.statusCode, 403, `${path} gated`);
      assert.equal(json().error, "csrf");
    }
    assert.equal(called, false);
  });

  it("validates required fields on mutating routes", async () => {
    const router = skillsRouter(mockService());
    for (const [path, body] of [
      ["/panel/api/skills/deploy", { endpointId: "kimi" }],
      ["/panel/api/skills/undeploy", { skillName: "s" }],
      ["/panel/api/skills/merge-local", { endpointId: "", skillName: "s" }],
      ["/panel/api/skills/repo/import", {}],
      ["/panel/api/skills/repo/delete", { skillName: 42 }],
    ]) {
      const { req, res, json } = fakeReqRes(path, "POST", body);
      await router.handle(req, res);
      assert.equal(res.statusCode, 400, `${path} with ${JSON.stringify(body)}`);
      assert.equal(json().ok, false);
    }
  });
});

// ── panel.html 变动差分高亮（diffSkillsState）──
// 沿用 panel.test.mjs 的 new Function 提取范式：把差分函数从内嵌脚本里抠出来单测——
// 它是纯状态对比，不碰 DOM 也不碰后端。
describe("panel.html skills change diff highlighting", () => {
  const panelHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
    "utf8"
  );

  // 顶层函数闭合花括号恒为 2 空格缩进、内部块更深，非贪婪匹配到首个 "\n  }" 即函数边界。
  function extractFn(name, params) {
    const m = panelHtml.match(
      new RegExp(`function ${name}\\(${params.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) \\{[\\s\\S]*?\\n  \\}`)
    );
    assert.ok(m, `panel.html must contain function ${name}`);
    return m[0];
  }

  const deployedSrc = extractFn("deployedEndpointsFor", "skill, state = skillsState");
  const diffFnSrc = extractFn("diffSkillsState", "prev, next");
  // 标记变量与 skillSignature 同处一块（从 flashNew 声明到 skillSignature 收尾）
  const marksSrc = panelHtml.match(
    /let skillsFlashNew[\s\S]*?function skillSignature\(state, s\) \{[\s\S]*?\n  \}/
  );
  assert.ok(marksSrc, "panel.html must contain the skills flash-mark block");

  const harness = new Function(`
    let skillsState = null;
    ${deployedSrc}
    ${marksSrc[0]}
    ${diffFnSrc}
    return {
      diffSkillsState,
      marks: () => ({
        flashNew: skillsFlashNew,
        flashChanged: skillsFlashChanged,
        flashCount: skillsFlashCount,
      }),
    };
  `)();

  const skill = (relPath, description = "desc") => ({ relPath, dirName: relPath, name: relPath, description });
  const state = (skills, endpoints = [], repoPath = "R:/repo") => ({
    repoConfigured: true, repoValid: true, repoPath, skills, endpoints,
  });
  const junctionEp = (repoSkill) => ({
    id: "kimi", label: "Kimi", dirExists: true,
    entries: [{ kind: "junction", broken: false, repoSkill }],
  });

  it("first load seeds baseline without marking anything new", () => {
    harness.diffSkillsState(null, state([skill("a"), skill("b")]));
    const m = harness.marks();
    assert.equal(m.flashNew.size, 0);
    assert.equal(m.flashChanged.size, 0);
    assert.equal(m.flashCount, false);
  });

  it("marks added skills and count change", () => {
    harness.diffSkillsState(state([skill("a")]), state([skill("a"), skill("b")]));
    const m = harness.marks();
    assert.deepEqual([...m.flashNew], ["b"]);
    assert.equal(m.flashCount, true);
  });

  it("marks description and deployment changes as changed, not new", () => {
    harness.diffSkillsState(state([skill("a")]), state([skill("a", "new desc")], [junctionEp("a")]));
    const m = harness.marks();
    assert.equal(m.flashNew.size, 0);
    assert.deepEqual([...m.flashChanged], ["a"]);
    assert.equal(m.flashCount, false);
  });

  it("repo switch or unconfigured repo resets baseline instead of flashing everything", () => {
    harness.diffSkillsState(state([skill("a")]), state([skill("x"), skill("y")], [], "R:/other"));
    let m = harness.marks();
    assert.equal(m.flashNew.size, 0);
    harness.diffSkillsState({ repoConfigured: false, skills: [] }, state([skill("a")]));
    m = harness.marks();
    assert.equal(m.flashNew.size, 0);
  });

  it("resets marks on every diff", () => {
    harness.diffSkillsState(state([skill("a")]), state([skill("a"), skill("b")]));
    assert.ok(harness.marks().flashNew.has("b"));
    harness.diffSkillsState(state([skill("a"), skill("b")]), state([skill("a")]));
    let m = harness.marks();
    assert.equal(m.flashNew.size, 0);
    assert.equal(m.flashCount, true);
    harness.diffSkillsState(state([skill("a")]), state([skill("a")]));
    const m2 = harness.marks();
    assert.equal(m2.flashNew.size, 0);
    assert.equal(m2.flashChanged.size, 0);
    assert.equal(m2.flashCount, false);
  });

  it("render functions consume flash marks so plain re-renders don't replay animations", () => {
    const renderList = extractFn("renderSkillsList", "");
    assert.match(renderList, /skillsFlashNew = new Set\(\)/);
    assert.match(renderList, /skillsFlashChanged = new Set\(\)/);
    assert.match(renderList, /skillsFlashCount = false/);
    assert.match(renderList, /row-new/);
    assert.match(renderList, /row-changed/);
    assert.match(renderList, /badge-flash/);
    // 手动刷新走带反馈的包装：按钮禁用（吃 .btn:disabled 变暗）+ 整列 cascade + 串行动画时长
    assert.match(panelHtml, /\$\("skillsRefreshBtn"\)\.onclick = runSkillsRefreshWithFeedback/);
    assert.match(panelHtml, /setTimeout\(r, SKILLS_CASCADE_TOTAL_MS\)/);
  });

  it("manual refresh dims the button until the cascade finishes, not for a fixed floor", () => {
    const fn = extractFn("runSkillsRefreshWithFeedback", "");
    // 旋转整套撤下：变暗交回 .btn:disabled 的 45%，与看板「重启」键同源；
    // 按钮内的圆弧箭头图标一并删除，只留「刷新」二字
    assert.doesNotMatch(panelHtml, /skillsRefreshSpin|#skillsRefreshBtn\.busy|skills-refresh-ico/);
    assert.match(panelHtml, /<button class="btn" id="skillsRefreshBtn" title="[^"]*">刷新<\/button>/);
    // 串行而非 Promise.all 取最大值：cascade 在数据落地那次渲染才起跑，
    // 从点击起算会让按钮亮起早于动画收尾一个请求耗时
    assert.doesNotMatch(fn, /Promise\.all/);
    assert.match(fn, /await refreshSkillsState\(\);\s*await new Promise\(\(r\) => setTimeout\(r, SKILLS_CASCADE_TOTAL_MS\)\)/);
    // 点击瞬间隐列；finally 兜底解除——请求失败时 doRefreshSkillsState 走 catch 不渲染，
    // 不清则列表永久隐形、标记滞留到下次无关渲染
    assert.match(fn, /classList\.add\("is-blank"\)/);
    assert.match(fn, /skillsCascadePending = true/);
    assert.match(
      fn,
      /finally \{[\s\S]*?skillsCascadePending = false;[\s\S]*?classList\.remove\("is-blank"\);[\s\S]*?btn\.disabled = false;/
    );
  });

  it("renderSkillsList consumes the animation marks before the empty-list early returns", () => {
    const renderList = extractFn("renderSkillsList", "");
    const consumed = renderList.indexOf("skillsCascadePending = false");
    assert.ok(consumed > 0, "renderSkillsList must consume the cascade mark");
    assert.ok(renderList.indexOf('classList.remove("is-blank")') > 0);
    const flipConsumed = renderList.indexOf("skillsFlipTops = null");
    assert.ok(flipConsumed > 0, "renderSkillsList must consume the FLIP snapshot");
    assert.ok(renderList.indexOf("skillsRevealKeys = null") > 0);
    // 三条早退（仓库未配置 / 空仓库 / 过滤无匹配）都必须在消费之后，否则标记滞留
    for (const hint of ["先设置主仓库", "仓库中还没有 skill", "没有匹配的 skill"]) {
      assert.ok(renderList.indexOf(hint) > consumed, `${hint} 的早退必须在 cascade 消费之后`);
      assert.ok(renderList.indexOf(hint) > flipConsumed, `${hint} 的早退必须在 FLIP 消费之后`);
    }
    // cascade 那次渲染不挂行级高亮：同元素同特异性的 animation 简写整条互相覆盖，会吃掉一个
    assert.match(renderList, /const flashCls = cascade\s*\?\s*""/);
    assert.match(renderList, /style="--i:\$\{i\}"/);
    assert.match(renderList, /listEl\.scrollTop = prevScrollTop;[\s\S]*?playSkillsListCascade\(listEl, prevScrollTop\)/);
    // 入场类先挂、FLIP 后跑：FLIP 每行强制一次回流，反了入场动画会晚一帧起跑
    assert.ok(
      renderList.indexOf('classList.add("row-reveal")') < renderList.indexOf("skillsListFlipFrom(flipTops, flipMs)"),
      "入场类必须在 FLIP 之前挂上"
    );
  });

  it("cascade animates only the rows in view and pins the total to 320ms", () => {
    // CSS 侧契约：backwards 填充（延迟期间锁 0% 帧，否则行会先全亮再逐个消失）
    // + clip-path 自上而下揭开 + translateX 横向落位 + 步长走 --csc-step
    assert.match(panelHtml, /\.skills-list\.is-blank \{ visibility: hidden; \}/);
    assert.match(panelHtml, /animation: skillsRowEnter 150ms var\(--ease-out\) backwards;\s*\n\s*animation-delay: calc\(var\(--i\) \* var\(--csc-step/);
    assert.match(panelHtml, /@keyframes skillsRowEnter \{\s*\n\s*from \{ clip-path: inset\(0 0 100% 0\); transform: translateX\(-6px\); \}\s*\n\s*to \{ clip-path: inset\(0 0 0 0\); transform: translateX\(0\); \}/);
    assert.doesNotMatch(panelHtml, /skillsRowCascade/);

    const totalSrc = panelHtml.match(/const SKILLS_CASCADE_TOTAL_MS = \d+;/);
    const rowSrc = panelHtml.match(/const SKILLS_CASCADE_ROW_MS = \d+;/);
    assert.ok(totalSrc && rowSrc, "panel.html must declare the cascade timing constants");
    const h = new Function(`
      ${totalSrc[0]}
      ${rowSrc[0]}
      ${extractFn("playSkillsListCascade", "listEl, prevScrollTop")}
      return { playSkillsListCascade, total: SKILLS_CASCADE_TOTAL_MS, row: SKILLS_CASCADE_ROW_MS };
    `)();
    assert.equal(h.total, 320);
    assert.equal(h.row, 150);

    // 行高均匀（名称/描述两行都是 nowrap+ellipsis），首行 offsetHeight 即代表全体
    function fakeList(rowCount, clientHeight, rowHeight = 53) {
      const children = Array.from({ length: rowCount }, () => {
        const cls = new Set();
        return { offsetHeight: rowHeight, classList: { add: (c) => cls.add(c), has: (c) => cls.has(c) } };
      });
      const props = {};
      return { children, clientHeight, style: { props, setProperty(k, v) { props[k] = v; } } };
    }
    const stepOf = (list) => parseFloat(list.style.props["--csc-step"]);
    const animated = (list) => list.children.filter((r) => r.classList.has("row-cascade")).length;

    // 长仓库：40 条只有首屏 11 行（495px / 53px 向上取整 + 半行余量）参与，尾部不动
    const long = fakeList(40, 495);
    h.playSkillsListCascade(long);
    assert.equal(animated(long), 11);
    assert.equal(stepOf(long), 17);
    // 末行延迟 + 单行时长 == 总时长：总时长不随仓库条数漂
    assert.equal((animated(long) - 1) * stepOf(long) + h.row, h.total);

    // 短仓库：3 条全部参与，步长自动拉开，总时长仍 320ms
    const short = fakeList(3, 495);
    h.playSkillsListCascade(short);
    assert.equal(animated(short), 3);
    assert.equal((3 - 1) * stepOf(short) + h.row, h.total);

    // 单行不退化成除零；空列表（正常走不到，防御 early return 之外的调用）不写变量
    const single = fakeList(1, 495);
    h.playSkillsListCascade(single);
    assert.equal(stepOf(single), 0);
    const empty = fakeList(0, 495);
    h.playSkillsListCascade(empty);
    assert.deepEqual(empty.style.props, {});
  });

  it("cascade anchors to the visible window and keeps --i window-local when scrolled off-top", () => {
    const totalSrc = panelHtml.match(/const SKILLS_CASCADE_TOTAL_MS = \d+;/);
    const rowSrc = panelHtml.match(/const SKILLS_CASCADE_ROW_MS = \d+;/);
    const h = new Function(`
      ${totalSrc[0]}
      ${rowSrc[0]}
      ${extractFn("playSkillsListCascade", "listEl, prevScrollTop")}
      return { playSkillsListCascade, total: SKILLS_CASCADE_TOTAL_MS, row: SKILLS_CASCADE_ROW_MS };
    `)();
    // 行高均匀；每行带 .style（含 setProperty）以承载 --i 内联重基
    function winList(rowCount, clientHeight, prevScrollTop, rowHeight = 53) {
      const children = Array.from({ length: rowCount }, () => {
        const cls = new Set();
        const style = {};
        return {
          offsetHeight: rowHeight,
          classList: { add: (c) => cls.add(c), has: (c) => cls.has(c) },
          style: { props: style, setProperty(k, v) { style[k] = v; } },
        };
      });
      const props = {};
      return { children, clientHeight, style: { props, setProperty(k, v) { props[k] = v; } } };
    }
    const animated = (list) => list.children.filter((r) => r.classList.has("row-cascade"));
    const idxOf = (list) => animated(list).map((r) => Number(r.style.props["--i"])).sort((a, b) => a - b);

    // 40 行、视口 495、行高 53、scrollTop=1060 → 可见窗口 ≈ 第 20..30 行（含半行余量共 11 行）
    const mid = winList(40, 495, 1060);
    h.playSkillsListCascade(mid, 1060);
    const anim = animated(mid);
    assert.equal(anim.length, 11);
    // --i 重基为窗口内位次，从 0 起，绝无绝对行号泄漏（否则中后段行延迟会溢出 320ms 预算）
    assert.deepEqual(idxOf(mid), Array.from({ length: 11 }, (_, n) => n));
    // 步长仍由窗口行数反推：末行延迟 + 单行时长 ≡ 总时长
    const step = parseFloat(mid.style.props["--csc-step"]);
    assert.equal((anim.length - 1) * step + h.row, h.total);

    // 到顶时窗口即前 K 行，与旧行为逐字节等价（回归保护）
    const top = winList(40, 495, 0);
    h.playSkillsListCascade(top, 0);
    assert.equal(animated(top).length, 11);
    assert.deepEqual(idxOf(top), Array.from({ length: 11 }, (_, n) => n));
  });

  it("presets refresh button routes through the same feedback path as skills", () => {
    const init = extractFn("initPresetsTab", "");
    assert.match(init, /\$\("presetsRefreshBtn"\)\.onclick = runPresetsRefreshWithFeedback;/);
  });

  it("runPresetsRefreshWithFeedback dims the button, hides the list, and always restores", () => {
    const fn = extractFn("runPresetsRefreshWithFeedback", "");
    // 串行而非 Promise.all 取最大值：cascade 在数据落地那次渲染才起跑
    assert.doesNotMatch(fn, /Promise\.all/);
    assert.match(fn, /await refreshPresetsState\(\);\s*await new Promise\(\(r\) => setTimeout\(r, SKILLS_CASCADE_TOTAL_MS\)\)/);
    assert.match(fn, /\$\("presetsList"\)\.classList\.add\("is-blank"\)/);
    assert.match(fn, /presetsCascadePending = true/);
    assert.match(
      fn,
      /finally \{[\s\S]*?presetsCascadePending = false;[\s\S]*?\$\("presetsList"\)\.classList\.remove\("is-blank"\);[\s\S]*?btn\.disabled = false;/
    );
  });

  it("renderPresetsList consumes the cascade mark, emits --i, and restores scroll on cascade", () => {
    const renderList = extractFn("renderPresetsList", "");
    assert.ok(renderList.indexOf("presetsCascadePending = false") > 0, "renderPresetsList must consume the cascade mark");
    assert.ok(renderList.indexOf('classList.remove("is-blank")') > 0);
    assert.match(renderList, /const rowStyle = /);
    assert.match(renderList, /style="\$\{rowStyle\}"/);
    assert.match(renderList, /listEl\.scrollTop = prevScrollTop;[\s\S]*?playSkillsListCascade\(listEl, prevScrollTop\)/);
  });

  it("import lands the new row in view: FLIP yields, reveal enters, row gets selected", () => {
    const imp = extractFn("importSkillViaPicker", "btnId, endpoint");
    // 暗态要有名字：一次 POST 覆盖「弹原生框→校验→拷贝」，后端 pickFolder 超时 120s，
    // 而原生框弹在桌面上，页面里只剩一个暗按钮
    assert.match(imp, /const label = btn\.textContent;/);
    assert.match(imp, /btn\.textContent = "导入中…"/);
    assert.match(imp, /finally \{[\s\S]*?btn\.textContent = label;/);
    // 等新行真的上屏才恢复按钮（旧写法不 await，完成信号早于结果）
    assert.match(imp, /await revealSkillsInsert\(\[d\.skill\.relPath\]\)/);

    const reveal = extractFn("revealSkillsInsert", "relPaths");
    // 空集即「本次没有新行」（批量转托管 / 失败路径），退化为朴素刷新
    assert.match(reveal, /if \(!relPaths\.length\) \{\s*\n\s*await refreshSkillsState\(\);\s*\n\s*return;/);
    // 快照必须在重渲之前；选中语义照普通左键（集合=新行、焦点=首条），详情卡随之切过去
    assert.match(reveal, /skillsFlipTops = skillsListTops\(\);\s*\n\s*skillsFlipMs = SKILLS_INSERT_MS;\s*\n\s*skillsRevealKeys = new Set\(relPaths\);/);
    assert.match(reveal, /skillsSelection\.clear\(\);\s*\n\s*for \(const key of relPaths\) skillsSelection\.add\(key\);\s*\n\s*skillsFocusKey = relPaths\[0\];/);
    // 定位在重渲之后：新行按仓库序落在字母序中间，不滚过去动画就发生在折叠区外；
    // 批量时新行散落各处，居中最靠上的那条
    assert.match(reveal, /await refreshSkillsState\(\);[\s\S]*?centerSkillsRow\(topmost \? topmost\.getAttribute\("data-skill"\) : relPaths\[0\]\);/);
    // 手动改容器 scrollTop 而非 scrollIntoView（后者会连带滚动页面级容器）
    const center = extractFn("centerSkillsRow", "relPath");
    assert.doesNotMatch(center, /scrollIntoView/);
    assert.match(center, /listEl\.scrollTop = Math\.max\(0, top - \(listEl\.clientHeight - row\.offsetHeight\) \/ 2\)/);

    // 入场与 row-new 并存：不同属性用逗号并列，否则同特异性的 animation 简写会整条互覆
    assert.match(panelHtml, /\.skills-list-row\.row-reveal \{ animation: skillsRowEnter 600ms var\(--ease-out\) backwards; \}/);
    assert.match(panelHtml, /\.skills-list-row\.row-new\.row-reveal \{\s*\n\s*animation: skillsRowEnter 600ms var\(--ease-out\) backwards, skillsRowNew 2s var\(--ease-out\);/);
  });

  it("delete dissolves the row first, then FLIPs the gap closed", () => {
    const del = extractFn("confirmDeleteSkill", "skill");
    // 形参收整个 skill：接口按 dirName 删、行按 relPath 定位，嵌套 skill 下两者不相等
    assert.match(del, /skillName: skill\.dirName/);
    assert.match(del, /removed = \[skill\.relPath\]/);
    assert.match(del, /await refreshAfterSkillsRemove\(removed\)/);

    const multi = extractFn("confirmDeleteSelectedSkills", "");
    assert.match(multi, /removed\.push\(s\.relPath\)/);
    assert.match(multi, /await refreshAfterSkillsRemove\(removed\)/);

    const rm = extractFn("refreshAfterSkillsRemove", "relPaths");
    // 失败路径传空集：行还在服务端，不退场，直接重渲与真实状态对齐
    assert.match(rm, /if \(!relPaths\.length\) \{\s*\n\s*await refreshSkillsState\(\);\s*\n\s*return;/);
    // 顺序：快照 → 退场 → 重渲（FLIP 在渲染内消费快照）
    assert.match(rm, /const tops = skillsListTops\(\);\s*\n\s*await dissolveSkillsRows\(relPaths\);\s*\n\s*skillsFlipTops = tops;\s*\n\s*skillsFlipMs = SKILLS_DELETE_FLIP_MS;\s*\n\s*await refreshSkillsState\(\);/);

    // 退场只动 opacity/transform（高度交给重渲后的 FLIP，两处同时做会让邻行位移两次）；
    // fill forwards 防退场结束到重渲之间闪回一帧
    const dissolve = extractFn("dissolveSkillsRows", "relPaths");
    assert.match(dissolve, /\[\{ opacity: 1, transform: "none" \}, \{ opacity: 0, transform: "translateX\(-8px\)" \}\]/);
    assert.match(dissolve, /fill: "forwards"/);
    assert.match(dissolve, /prefers-reduced-motion/);
  });

  it("only paths that really insert a repo row reveal; 转托管 and resolve-conflict do not", () => {
    // 后端 mergeLocalSkill 三条出口：仓库无此 skill → 拷入仓库根（新行，relPath 即
    // skillName）；仓库副本内容一致 → reusedRepoCopy（没有新行，本地目录只换成
    // junction）；分叉 → conflict（什么都没动）
    const single = extractFn("mergeLocal", "endpointId, skillName, kind");
    assert.match(single, /let inserted = null;/);
    assert.match(single, /inserted = d\.reusedRepoCopy \? \[\] : \[skillName\];/);
    // 空集即朴素刷新：失败路径（inserted 仍为 null）与转托管都不该演入场
    assert.match(single, /await revealSkillsInsert\(inserted \|\| \[\]\);/);
    // conflict 兜底分支维持自己的朴素刷新（什么都没动，没有新行可演）
    assert.match(single, /if \(d\.conflict\) \{[\s\S]*?await refreshSkillsState\(\);\s*\n\s*return;/);

    const batch = extractFn("confirmBatchMergeLocal", "items, kind");
    assert.match(batch, /else \{ okCount\+\+; if \(!d\.reusedRepoCopy\) inserted\.push\(it\.entry\.name\); \}/);
    assert.match(batch, /await revealSkillsInsert\(inserted\);/);

    // resolve-conflict 两个方向都不产生新行：repo 方向只把本地目录换成 junction，
    // local 方向把内容拷进同一 repo 路径（行还在，只是内容变，走 row-changed 高亮）
    const resolve = extractFn("resolveConflict", "endpointId, skillName, direction");
    assert.doesNotMatch(resolve, /revealSkillsInsert/);
    assert.match(resolve, /await refreshSkillsState\(\)/);
  });

  it("FLIP shifts a displaced row back to its old spot, immune to scrolling", async () => {
    const flipSrc = extractFn("skillsListFlipFrom", "tops, ms");
    let origin = 0;
    let listEl = null;
    function fakeRow(key, contentTop) {
      const log = [];
      const style = {};
      Object.defineProperty(style, "transform", {
        enumerable: true,
        get: () => style._t,
        set: (v) => { style._t = v; log.push(v); },
      });
      return {
        log, style, offsetWidth: 0,
        getAttribute: (n) => (n === "data-skill" ? key : null),
        getBoundingClientRect: () => ({ top: origin + contentTop }),
      };
    }
    // 场景：在 a 与 b 之间插入 x —— 旧 a=0/b=55/c=110，新 a=0/x=55/b=110/c=165
    function run(scrollTop, listTop, reduce) {
      origin = listTop - scrollTop; // 内容坐标原点 = 视口上缘补偿滚动量
      const rows = [fakeRow("a", 0), fakeRow("x", 55), fakeRow("b", 110), fakeRow("c", 165)];
      listEl = { scrollTop, children: rows, getBoundingClientRect: () => ({ top: listTop }) };
      const flip = new Function("$", "window", `${flipSrc}\n return skillsListFlipFrom;`)(
        (id) => (id === "skillsList" ? listEl : null),
        { matchMedia: () => ({ matches: reduce }) },
      );
      flip(new Map([["a", 0], ["b", 55], ["c", 110]]), 1);
      return rows;
    }

    // 位移符号是 FLIP 最易错处：b 的新位在旧位之下，必须先被平移回上方（负值）再归零下滑
    const [a, x, b, c] = run(0, 100, false);
    assert.deepEqual(a.log, [], "没位移的行不该被写任何内联样式");
    assert.deepEqual(x.log, [], "新行没有旧位置，交给入场动画");
    assert.deepEqual(b.log, ["translateY(-55px)", ""]);
    assert.deepEqual(c.log, ["translateY(-55px)", ""]);
    // 缓动必须与入场动画同一条，否则让位行上缘与揭开前沿会错开几像素
    assert.equal(b.style.transition, "transform 1ms var(--ease-out)");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(b.style.transition, "", "收尾要清掉内联 transition，交回基样式");

    // 容器滚过之后再 FLIP：内容坐标系让位移量与滚动位置无关
    assert.deepEqual(run(200, 100, false)[2].log, ["translateY(-55px)", ""]);
    // reduced-motion：整套位移反馈跳过，行直接落在新位置
    assert.deepEqual(run(0, 100, true).flatMap((r) => r.log), []);
  });
});
