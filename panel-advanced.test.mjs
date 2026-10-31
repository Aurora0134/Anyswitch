import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// 高级选项页的数据搬迁界面：控制器按 panel-about.test.mjs 的同一种做法从
// panel.js 原文里摘出来跑，元素全部按 panel.html 真实存在的 id 建，所以这条
// 套件同时钉住「markup 里的 id ↔ JS 里取的 id ↔ 注册表里的子 tab」三者一致。
// 导入的预览与 Skills 落点选择都在确认弹窗里：已配仓库时勾选收成小字注释行、
// 自选位置常开且与勾选互斥（自选有内容即锁勾选，点它弹报错）；未配过仓库时
// 直接给默认落点。「备份并导入」单击即落定（写入前整份备份已足够），不再有二次确认态。

const source = readFileSync(new URL("./panel-ui/panel.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./panel-ui/panel.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./panel-ui/panel.css", import.meta.url), "utf8");

class El {
  constructor(tag = "") {
    this.textContent = "";
    this.disabled = /\bdisabled\b/.test(tag);
    this.hidden = /\bhidden\b/.test(tag);
    this.checked = /\bchecked\b/.test(tag);
    this.onclick = null;
    this.onchange = null;
    this.dataset = {};
    const cls = (tag.match(/class="([^"]*)"/) || [, ""])[1];
    this._cls = new Set(cls.split(/\s+/).filter(Boolean));
    this.classList = {
      add: (c) => this._cls.add(c),
      remove: (c) => this._cls.delete(c),
      toggle: (c, force) => { (force ?? !this._cls.has(c)) ? this._cls.add(c) : this._cls.delete(c); },
      contains: (c) => this._cls.has(c),
    };
  }
}

const IDS = [
  "settingsTabAdvanced", "settingsPanelAdvanced",
  "dataExportBtn", "dataExportStatus", "dataExportMeta",
  "dataImportPickBtn", "dataImportSummary", "dataImportMeta",
  "dataImportModal", "dataImportModalClose", "dataImportModalCancel",
  "dataImportModalSummary", "dataImportModalMeta", "dataImportModalError", "dataImportApplyBtn",
  "dataSkillsRepoLine", "dataSkillsRepoLabel", "dataSkillsRepoCheck", "dataSkillsRepoPath",
  "dataSkillsCustomItem", "dataSkillsCustomPath", "dataSkillsCustomPickBtn", "dataSkillsCustomClearBtn",
  "dataSkillsDefaultItem", "dataSkillsDefaultPath", "dataSkillsDefaultPickBtn",
];

function harness({ respondPost, errorText } = {}) {
  const nodes = new Map();
  for (const match of html.matchAll(/<([a-z0-9]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const el = new El(match[0]);
    // 初值照 markup 填进来：真 DOM 里这些字本来就画在页面上。给个空壳的话，
    // 「控制器不抢写初值」「离开回初值」这类断言测的就是个假状态——控制器从
    // DOM 里取到的初值会变成空串，而线上取到的是 markup 那句，两边不一致。
    el.textContent = initialText(match[2]);
    nodes.set(match[2], el);
  }
  const doc = { getElementById: (id) => nodes.get(id) };
  const mutations = [];
  const toasts = [];
  const request = (method, path, body) => {
    assert.equal(method, "POST");
    mutations.push({ path, body });
    // 与真 api() 同契约：非 2xx 或服务端 ok:false 一律抛出，服务端原文挂到 err.code。
    return Promise.resolve().then(() => {
      const data = respondPost({ path, body });
      if (data && data.ok === false) {
        const detail = String(data.error || "");
        const err = new Error(`HTTP 200：${detail}`);
        err.code = detail;
        throw err;
      }
      return data;
    });
  };
  const match = source.match(/  function createDataBundleController\([\s\S]*?\n  \}/);
  assert.ok(match, "testable data bundle controller exists in panel.js");
  const factory = vm.runInNewContext(`(${match[0]})`, { URL, setTimeout, clearTimeout, Date, Number });
  const controller = factory({
    request,
    doc,
    notify: (message, isErr) => toasts.push({ message, isErr }),
    errorText: errorText ?? ((err, fallback) => err?.code || fallback),
  });
  const line = (id) => ({ text: nodes.get(id).textContent, tone: nodes.get(id).dataset.tone });
  return {
    nodes, mutations, toasts, controller,
    get: (id) => nodes.get(id),
    exportStatus: () => line("dataExportStatus"),
    exportMeta: () => nodes.get("dataExportMeta").textContent,
    summary: () => line("dataImportSummary"),
    meta: () => nodes.get("dataImportMeta").textContent,
    modalOpen: () => nodes.get("dataImportModal").classList.contains("show"),
    modalSummary: () => line("dataImportModalSummary"),
    modalMeta: () => nodes.get("dataImportModalMeta").textContent,
    modalError: () => ({ ...line("dataImportModalError"), hidden: nodes.get("dataImportModalError").hidden }),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// 状态行的初始值写在 markup 里（与「关于」的「尚未检查更新」同一写法），
// 控制器不在启动时覆盖它，所以这条只能对着 HTML 断。
const initialText = (id) => (html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`)) || [, ""])[1];

const PREVIEW = {
  ok: true, token: "t1", sourceComputer: "DESKTOP-A1B2C3", createdAt: "2026-09-23T04:00:00.000Z",
  counts: { providers: 22, pools: 4, routingChains: 2, presets: 8, skillDirs: 25, credentials: 22 },
  includes: { settings: true, prompts: true, skills: true },
  skillsSourcePath: "C:\\Users\\me\\Desktop\\work\\skills",
  skillsRepoPath: "C:\\Users\\me\\Desktop\\work\\skills",
  skillsDefaultPath: "C:\\Users\\me\\.agents\\skills",
};
// 形态 B：本机没配过 Skills 仓库
const PREVIEW_NO_REPO = { ...PREVIEW, token: "t2", skillsRepoPath: null };
// 包里不含 Skills
const PREVIEW_NO_SKILLS = { ok: true, token: "t3", counts: { providers: 1 }, includes: { settings: true, prompts: true, skills: false }, skillsRepoPath: "C:\\repo", skillsDefaultPath: "C:\\d" };

const EXPORT_OK = {
  ok: true, path: "C:\\out\\anyswitch-export-20260923-120000.zip",
  counts: { providers: 22, pools: 4, routingChains: 2, presets: 8, skillDirs: 25, credentials: 22 },
  skippedCredentials: [],
};

const APPLY_OK = { ok: true, backupId: "20260923-125900", counts: { providers: 3 }, applied: { store: true, credentials: 3 } };

const applyHarness = (watchdog, applyResult = {}) => harness({
  respondPost: ({ path }) => (path === "/api/data/import-pick"
    ? PREVIEW_NO_SKILLS
    : { ok: true, backupId: "b7", counts: { providers: 3 }, applied: { store: true, credentials: 3 }, ...applyResult, ...(watchdog ? { watchdog } : {}) }),
});

async function click(h, id, rounds = 2, ev) {
  h.get(id).onclick(ev ?? {});
  for (let i = 0; i < rounds; i += 1) await tick();
  return h;
}

const pickPackage = (h) => click(h, "dataImportPickBtn");
// 单击即落定：一击就发写入请求，没有中间确认态
const confirmApply = (h, rounds = 3) => click(h, "dataImportApplyBtn", rounds);

test("markup 与控制器共用同一批 id，且注册表里有高级选项子 tab", () => {
  for (const id of IDS) assert.ok(html.includes(`id="${id}"`), `panel.html 缺 #${id}`);
  assert.ok(source.includes('advanced: ["settingsTabAdvanced", "settingsPanelAdvanced"]'),
    "settingsSubTabs 注册高级选项子 tab");
  const h = harness({ respondPost: () => ({ ok: true }) });
  for (const id of ["dataExportBtn", "dataImportPickBtn", "dataImportApplyBtn", "dataImportModalClose", "dataImportModalCancel", "dataSkillsCustomPickBtn", "dataSkillsCustomClearBtn", "dataSkillsDefaultPickBtn"]) {
    assert.equal(typeof h.get(id).onclick, "function", `#${id} 应被控制器接管`);
  }
  assert.equal(initialText("dataExportStatus"), "尚未导出", "状态行要有初始值，与「关于」的尚未检查更新同一写法");
  assert.equal(initialText("dataImportSummary"), "尚未选择配置包");
  assert.equal(h.exportStatus().text, "尚未导出", "控制器不抢写初始值（保持 markup 那份）");
  assert.equal(h.get("dataImportApplyBtn").disabled, true, "没选包之前不给写入");
  assert.equal(h.modalOpen(), false, "弹窗初始不开");
});

test("版式按 id 挂：本页各子面板的 display 都写在 id 上，漏一格就贴成一坨", () => {
  assert.match(css, /#settingsPanelAdvanced \{ display: flex; flex-direction: column; gap: 20px; \}/,
    "高级选项面板要有自己的 display 规则，与通用/关于同一待遇");
  for (const tone of ["busy", "ok", "warn", "danger"]) {
    assert.ok(css.includes(`.data-bundle-status[data-tone="${tone}"] { color: var(--`), `状态行缺 ${tone} 色调`);
  }
  assert.match(css,
    /html\[data-prepaint-view="settings"\]\[data-prepaint-subtab="advanced"\] #settingsPanelAdvanced\[hidden\] \{ display: flex !important; \}/,
    "停在高级选项时首帧要有落位规则，否则先闪「通用」");
  assert.match(css, /\.data-skills-inline \{/, "仓库勾选是小字注释行，样式要落档");
  assert.match(css, /\.data-skills-path \{/, "落点路径等宽小字");
  assert.match(css, /\.modal-item\[hidden\] \{ display: none; \}/, "modal-item 的 flex 会盖掉 hidden，必须显式补回");
  assert.match(css, /\.toast \{[\s\S]*?z-index: 400;/, "toast 要浮在弹窗蒙层（300）之上，否则弹窗内的报错被盖住");
});

test("导出：状态行报结果、明细行摆计数，按钮始终在卡头右侧", async () => {
  const h = harness({ respondPost: () => EXPORT_OK });
  await click(h, "dataExportBtn");
  assert.equal(h.exportStatus().tone, "ok");
  assert.equal(h.exportStatus().text, "已导出 anyswitch-export-20260923-120000.zip");
  assert.equal(h.exportMeta(), "渠道 22 · 号池 4 · 路由链 2 · 预设 8 · Skills 25 · 密钥 22");
  assert.equal(h.get("dataExportBtn").disabled, false, "结束后按钮回到可点");
  assert.equal(h.toasts.at(-1).message, "导出完成");
  assert.equal(h.toasts.at(-1).isErr, false, "成功不该用告警色");
  assert.match(html, /明文 API 密钥[\s\S]{0,160}导入完成后请删除该文件/, "密钥提醒要在卡内固定可见");
});

test("导出：部分密钥没取到如实记在明细里，不算失败", async () => {
  const h = harness({
    respondPost: () => ({ ok: true, path: "C:\\out\\a.zip", counts: { providers: 2 }, skippedCredentials: [{ providerId: "x" }, { providerId: "y" }] }),
  });
  await click(h, "dataExportBtn");
  assert.equal(h.exportStatus().tone, "ok");
  assert.equal(h.exportMeta(), "渠道 2 · 2 个密钥未取到");
});

test("导出：取消目录框是中性色，失败原因出服务端原文并转 danger", async () => {
  const cancelled = harness({ respondPost: () => ({ ok: true, cancelled: true }) });
  await click(cancelled, "dataExportBtn");
  assert.equal(cancelled.exportStatus().tone, undefined, "取消不是成功也不是失败");
  assert.equal(cancelled.exportStatus().text, "未选择导出位置");
  assert.equal(cancelled.toasts.length, 0);

  const failed = harness({
    respondPost: () => { const err = new Error("HTTP 200：导出目录不存在，请重新选择"); err.code = "导出目录不存在，请重新选择"; throw err; },
  });
  await click(failed, "dataExportBtn");
  assert.equal(failed.exportStatus().tone, "danger");
  assert.equal(failed.exportStatus().text, "导出目录不存在，请重新选择", "服务端原文要直接可见，不吞成通用文案");
  assert.equal(failed.exportMeta(), "");
});

test("导入：选包后预览进弹窗，卡面回初值；形态 A 的勾选与自选行都在", async () => {
  const h = harness({ respondPost: () => PREVIEW });
  await pickPackage(h);
  assert.equal(h.modalOpen(), true, "预览以整体弹窗呈现");
  assert.match(h.modalSummary().text, /^已读取包内容：来自 DESKTOP-A1B2C3 · /);
  assert.equal(h.modalMeta(), "渠道 22 · 号池 4 · 路由链 2 · 预设 8 · Skills 25 · 密钥 22");
  assert.equal(h.summary().text, "尚未选择配置包", "卡面不占预览内容");
  assert.equal(h.get("dataSkillsRepoLine").hidden, false);
  assert.equal(h.get("dataSkillsRepoPath").textContent, "C:\\Users\\me\\Desktop\\work\\skills");
  assert.equal(h.get("dataSkillsRepoCheck").checked, true, "默认导入到本机仓库");
  assert.equal(h.get("dataSkillsCustomItem").hidden, false, "自选行常开");
  assert.equal(h.get("dataSkillsCustomPickBtn").disabled, false, "自选随时可点");
  assert.equal(h.get("dataSkillsCustomClearBtn").hidden, true, "还没选过就没有清除");
  assert.equal(h.get("dataSkillsDefaultItem").hidden, true, "已配仓库不出默认落点行");
  assert.equal(h.get("dataImportApplyBtn").disabled, false);
  assert.match(html, /导入到这台机器的 Skills 仓库(?![^<]*同名覆盖)/, "勾选文案不含「同名覆盖」");
});

test("导入：形态 B（未配过仓库）出默认落点行，勾选与自选整段不出", async () => {
  const h = harness({ respondPost: () => PREVIEW_NO_REPO });
  await pickPackage(h);
  assert.equal(h.get("dataSkillsRepoLine").hidden, true);
  assert.equal(h.get("dataSkillsCustomItem").hidden, true);
  assert.equal(h.get("dataSkillsDefaultItem").hidden, false);
  assert.equal(h.get("dataSkillsDefaultPath").textContent, "C:\\Users\\me\\.agents\\skills");
  await confirmApply(h);
  assert.equal(JSON.stringify(h.mutations.find((m) => m.path === "/api/data/import-apply").body), JSON.stringify({ token: "t2", skillsMode: "default" }));
});

test("导入：形态 B 改过落点按 custom 交回；包里不含 Skills 时三段都不出、按 skip 落", async () => {
  const moved = harness({
    respondPost: ({ path }) => (path === "/api/data/import-pick"
      ? PREVIEW_NO_REPO
      : path === "/api/skills/repo/pick"
        ? { ok: true, path: "D:\\picked\\skills" }
        : APPLY_OK),
  });
  await pickPackage(moved);
  await click(moved, "dataSkillsDefaultPickBtn");
  assert.equal(moved.get("dataSkillsDefaultPath").textContent, "D:\\picked\\skills");
  await confirmApply(moved);
  assert.equal(JSON.stringify(moved.mutations.find((m) => m.path === "/api/data/import-apply").body),
    JSON.stringify({ token: "t2", skillsMode: "custom", skillsTarget: "D:\\picked\\skills" }));

  const bare = harness({ respondPost: () => PREVIEW_NO_SKILLS });
  await pickPackage(bare);
  assert.equal(bare.get("dataSkillsRepoLine").hidden, true);
  assert.equal(bare.get("dataSkillsCustomItem").hidden, true);
  assert.equal(bare.get("dataSkillsDefaultItem").hidden, true);
  await confirmApply(bare);
  assert.equal(JSON.stringify(bare.mutations.find((m) => m.path === "/api/data/import-apply").body), JSON.stringify({ token: "t3", skillsMode: "skip" }));
});

test("导入：单击即落定——一击就发写入请求、弹窗收起，票据用掉后再点无效", async () => {
  const h = harness({
    respondPost: ({ path }) => (path === "/api/data/import-pick" ? PREVIEW : APPLY_OK),
  });
  await pickPackage(h);
  await click(h, "dataImportApplyBtn", 3);
  assert.deepEqual(h.mutations.map((m) => m.path), ["/api/data/import-pick", "/api/data/import-apply"],
    "一击就该落定，中间不再有确认态");
  assert.equal(JSON.stringify(h.mutations.find((m) => m.path === "/api/data/import-apply").body), JSON.stringify({ token: "t1", skillsMode: "repo" }));
  assert.equal(h.modalOpen(), false, "落定后弹窗收起");
  assert.equal(h.summary().tone, "ok");
  assert.equal(h.summary().text, "导入完成 · 备份号 20260923-125900");
  assert.equal(h.meta(), "渠道 3");
  assert.equal(h.toasts.at(-1).message, "导入完成，已备份为 20260923-125900");
  assert.equal(h.get("dataImportApplyBtn").disabled, true, "票据用掉后不许再点");
  await click(h, "dataImportApplyBtn");
  assert.equal(h.mutations.filter((m) => m.path === "/api/data/import-apply").length, 1, "票据一次性");
});

test("导入：Skills 落到哪、指向动没动，如实进结果明细", async () => {
  const landed = harness({
    respondPost: ({ path }) => (path === "/api/data/import-pick" ? PREVIEW : {
      ok: true, backupId: "b8", counts: { providers: 3 },
      applied: { store: true, credentials: 3, skills: true, skillsTarget: "C:\\Users\\me\\Desktop\\work\\skills", skillsRepoChanged: false },
    }),
  });
  await pickPackage(landed);
  await confirmApply(landed);
  assert.equal(landed.summary().text, "导入完成 · 备份号 b8");
  assert.match(landed.meta(), /Skills 落到：C:\\Users\\me\\Desktop\\work\\skills/);
  assert.match(landed.meta(), /主仓库指向未变/, "已配仓库自选别处时要注明指向未动");

  const skipped = harness({
    respondPost: ({ path }) => (path === "/api/data/import-pick" ? PREVIEW : {
      ok: true, backupId: "b9", counts: { providers: 3 },
      applied: { store: true, credentials: 3, skills: false, skillsSkippedReason: "Skills 落盘未完成：EPERM" },
    }),
  });
  await pickPackage(skipped);
  await confirmApply(skipped);
  assert.equal(skipped.summary().text, "导入完成 · 备份号 b9（Skills 未导入）");
  assert.match(skipped.meta(), /Skills 落盘未完成：EPERM/, "落盘失败的原因要如实可见");
});

test("导入：自选与勾选互斥——自选有内容即锁勾选，点锁弹报错，清除后还原", async () => {
  const h = harness({
    respondPost: ({ path }) => (path === "/api/data/import-pick"
      ? PREVIEW
      : path === "/api/skills/repo/pick"
        ? { ok: true, path: "D:\\elsewhere\\skills" }
        : APPLY_OK),
  });
  await pickPackage(h);
  await click(h, "dataSkillsCustomPickBtn");
  assert.equal(h.get("dataSkillsCustomPath").textContent, "D:\\elsewhere\\skills");
  assert.equal(h.get("dataSkillsRepoCheck").checked, false, "自选有内容，勾选强制退出");
  assert.equal(h.get("dataSkillsRepoLine").classList.contains("is-locked"), true, "勾选进锁定态");
  assert.equal(h.get("dataSkillsCustomClearBtn").hidden, false);

  let prevented = false;
  h.get("dataSkillsRepoCheck").onclick({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, "锁定后点勾选要被拦下");
  assert.equal(h.get("dataSkillsRepoCheck").checked, false, "勾选保持退出");
  assert.equal(h.toasts.at(-1).isErr, true);
  assert.match(h.toasts.at(-1).message, /清除自选位置/);

  await confirmApply(h);
  assert.equal(JSON.stringify(h.mutations.find((m) => m.path === "/api/data/import-apply").body),
    JSON.stringify({ token: "t1", skillsMode: "custom", skillsTarget: "D:\\elsewhere\\skills" }));

  const cleared = harness({
    respondPost: ({ path }) => (path === "/api/data/import-pick"
      ? PREVIEW
      : path === "/api/skills/repo/pick"
        ? { ok: true, path: "D:\\elsewhere\\skills" }
        : APPLY_OK),
  });
  await pickPackage(cleared);
  await click(cleared, "dataSkillsCustomPickBtn");
  await click(cleared, "dataSkillsCustomClearBtn");
  assert.equal(cleared.get("dataSkillsRepoCheck").checked, true, "清除自选后勾选还原");
  assert.equal(cleared.get("dataSkillsRepoLine").classList.contains("is-locked"), false);
  assert.equal(cleared.get("dataSkillsCustomClearBtn").hidden, true);
  await confirmApply(cleared);
  assert.equal(JSON.stringify(cleared.mutations.find((m) => m.path === "/api/data/import-apply").body), JSON.stringify({ token: "t1", skillsMode: "repo" }));
});

test("导入：只摘掉勾选、不选自选，就是不导 Skills", async () => {
  const h = harness({
    respondPost: ({ path }) => (path === "/api/data/import-pick" ? PREVIEW : APPLY_OK),
  });
  await pickPackage(h);
  h.get("dataSkillsRepoCheck").checked = false;
  await confirmApply(h);
  assert.equal(JSON.stringify(h.mutations.find((m) => m.path === "/api/data/import-apply").body), JSON.stringify({ token: "t1", skillsMode: "skip" }));
});

test("导入：取消/关闭弹窗丢弃这次选择，一个写入请求都不发", async () => {
  const h = harness({ respondPost: () => PREVIEW });
  await pickPackage(h);
  await click(h, "dataImportModalCancel");
  assert.equal(h.modalOpen(), false);
  assert.deepEqual(h.mutations.map((m) => m.path), ["/api/data/import-pick"]);
  assert.equal(h.summary().text, "尚未选择配置包");
  assert.equal(h.get("dataImportApplyBtn").textContent, "备份并导入", "按钮文案保持原样，取消不改它");
});

test("导入：读包失败在卡面转 danger；写入失败在弹窗里出原文、票据作废", async () => {
  const badZip = harness({
    respondPost: () => { const err = new Error("HTTP 200：包里缺 manifest.json，不像 anyswitch 导出包"); err.code = "包里缺 manifest.json，不像 anyswitch 导出包"; throw err; },
  });
  await pickPackage(badZip);
  assert.equal(badZip.modalOpen(), false, "坏包不开弹窗");
  assert.equal(badZip.summary().tone, "danger");
  assert.equal(badZip.summary().text, "包里缺 manifest.json，不像 anyswitch 导出包");

  const expired = harness({
    respondPost: ({ path }) => (path === "/api/data/import-pick"
      ? PREVIEW
      : { ok: false, error: "导入确认已过期或无效，请重新选择导出包" }),
  });
  await pickPackage(expired);
  await confirmApply(expired);
  assert.equal(expired.modalOpen(), true, "失败留在弹窗里，原因可见");
  assert.equal(expired.modalError().hidden, false);
  assert.equal(expired.modalError().text, "导入确认已过期或无效，请重新选择导出包", "服务端原文直接可见");
  assert.equal(expired.get("dataImportApplyBtn").disabled, true, "票据已作废，只能取消后重选包");
  assert.equal(expired.toasts.at(-1).isErr, true);
});

test("导入后 followAgent 没对齐回来：状态行转提醒色，明细行说没跟上的是什么", async () => {
  const cases = [
    {
      name: "登录自启",
      watchdog: { desired: true, task: "failed", process: "unchanged", warnings: [], reasons: { task: "拒绝访问" } },
      expect: /「跟随 Coding Agent 启动」已按包里的设置更新，但登录自启没跟着改，重启电脑后的行为可能和设置显示的不一致（拒绝访问）。可以在设置里把它拨一次再拨回来重试。/,
    },
    {
      name: "自愈进程",
      watchdog: { desired: false, task: "unregistered", process: "failed", warnings: [], reasons: { process: "pid 认不出来" } },
      expect: /「跟随 Coding Agent 启动」的开关已更新，但自愈进程没跟上（pid 认不出来）。当前实际行为可能和设置显示的不一致。/,
    },
  ];
  for (const c of cases) {
    const h = applyHarness(c.watchdog);
    await pickPackage(h);
    await confirmApply(h);
    assert.equal(h.summary().tone, "warn", c.name);
    assert.equal(h.summary().text, "导入完成 · 备份号 b7，但「跟随 Coding Agent 启动」没完全跟上", c.name);
    assert.match(h.meta(), /渠道 3 · 「跟随 Coding Agent 启动」/, c.name);
    assert.match(h.meta(), c.expect, c.name);
    assert.equal(h.toasts.at(-1).isErr, false, "数据已换完，不该报成失败");
  }

  const clean = applyHarness({ desired: true, task: "registered", process: "started", warnings: [], reasons: {} });
  await pickPackage(clean);
  await confirmApply(clean);
  assert.equal(clean.summary().tone, "ok", "对齐顺利就是一句成功，不多话");
  assert.equal(clean.meta(), "渠道 3");
  const noWatchdog = applyHarness(null);
  await pickPackage(noWatchdog);
  await confirmApply(noWatchdog);
  assert.equal(noWatchdog.summary().tone, "ok");
});

// ─────────────────────────────────────────────────────────────
// 文案生命周期：结果离开即复位；离开期间落地的结果等切回
//
// 预览与落点选择都在弹窗里（弹窗不关就不受子 tab 切换影响），卡面只有初始行
// 与一次性回执，所以复位规则只剩「结果」这一半要管。
// 复位用的初值一律取 markup 里写的那份，控制器不另造文案。

test("生命周期：导出结果离开子页即回初值，且复位文案就是 markup 的初值", async () => {
  const h = harness({ respondPost: () => EXPORT_OK });
  h.controller.enter(); // 用户就停在高级选项页上
  await click(h, "dataExportBtn");
  assert.equal(h.exportStatus().text, "已导出 anyswitch-export-20260923-120000.zip");
  h.controller.leave();
  assert.equal(h.exportStatus().text, initialText("dataExportStatus"), "回初值，不另造文案");
  assert.equal(h.exportStatus().tone, undefined, "色调一并摘掉，不留半截态");
  assert.equal(h.exportMeta(), "", "明细行一起收");
});

test("生命周期：导入弹窗开着时离开不受影响，卡面本就只占初始行", async () => {
  const h = harness({ respondPost: () => PREVIEW });
  h.controller.enter();
  await pickPackage(h);
  assert.equal(h.modalOpen(), true);
  h.controller.leave();
  assert.equal(h.modalOpen(), true, "弹窗是确认现场，离开不收");
  assert.equal(h.summary().text, initialText("dataImportSummary"));
});

test("生命周期：导入完成的结果离开也复位", async () => {
  const h = harness({
    respondPost: ({ path }) => (path === "/api/data/import-pick" ? PREVIEW : APPLY_OK),
  });
  h.controller.enter();
  await pickPackage(h);
  await confirmApply(h);
  assert.equal(h.summary().tone, "ok");
  h.controller.leave();
  assert.equal(h.summary().text, initialText("dataImportSummary"), "完成回执离开即回初值");
  assert.equal(h.meta(), "");
});

test("生命周期：离开期间落地的结果等切回，看过之后下次离开才复位", async () => {
  const h = harness({ respondPost: () => EXPORT_OK });
  h.controller.leave(); // 人先离开，此时还没有任何结果
  assert.equal(h.exportStatus().text, initialText("dataExportStatus"));
  await click(h, "dataExportBtn"); // 结果在人不在的时候落地
  const landed = "已导出 anyswitch-export-20260923-120000.zip";
  assert.equal(h.exportStatus().text, landed, "结果照常写入，不能在没人看的时候被丢掉");
  h.controller.leave(); // 用户还没切回来就又离开：仍要留着
  assert.equal(h.exportStatus().text, landed, "没看过就不清");
  h.controller.enter(); // 切回，这下看到了
  assert.equal(h.exportStatus().text, landed, "切回时结果还在，用户能看到");
  h.controller.leave(); // 看过了，这次才复位
  assert.equal(h.exportStatus().text, initialText("dataExportStatus"));
});

test("生命周期：控制器真的接进了设置页子 tab 机制，不留「有钩子没人调」的死代码", () => {
  // 这条是本次问题的根：控制器原先声明了 reset() 却零调用点，等于没有生命周期。
  assert.ok(source.includes('if (which !== "advanced") dataBundle.leave();'), "切走高级选项时离开");
  assert.ok(source.includes('if (which === "advanced") return dataBundle.enter();'), "切回高级选项时进入");
  assert.ok(source.includes("leaveSettingsView = () => { about.leave(); dataBundle.leave(); };"),
    "整个设置视图关掉时也要复位（否则从看板回来还挂着旧结果）");
  assert.ok(source.includes("enter() { away = false; awaitReturn = false; }"), "enter 消费「等切回」");
  assert.ok(source.includes("leave() { away = true; if (awaitReturn) return; resetResults(); }"), "leave 按等切回决定清不清");
  assert.ok(!source.includes("dataBundle.reset"), "旧的死钩子不该留着");
});
