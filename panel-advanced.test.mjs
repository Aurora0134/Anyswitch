import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// 高级选项页的数据搬迁界面：控制器按 panel-about.test.mjs 的同一种做法从
// panel.js 原文里摘出来跑，元素全部按 panel.html 真实存在的 id 建，所以这条
// 套件同时钉住「markup 里的 id ↔ JS 里取的 id ↔ 注册表里的子 tab」三者一致。
// 版式沿用本页其它设置卡：卡头右侧放动作按钮，卡体第一行状态行、第二行明细行，
// 需要独立控件的行用 .modal-item；状态色只由 data-tone 决定。

const source = readFileSync(new URL("./panel-ui/panel.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./panel-ui/panel.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./panel-ui/panel.css", import.meta.url), "utf8");

class El {
  constructor() {
    this.textContent = "";
    this.disabled = false;
    this.onclick = null;
    this.className = "";
    this.dataset = {};
    this.hidden = false;
  }
}

const IDS = [
  "settingsTabAdvanced", "settingsPanelAdvanced",
  "dataExportBtn", "dataExportStatus", "dataExportMeta",
  "dataImportPickBtn", "dataImportApplyBtn", "dataImportSummary", "dataImportMeta",
  "dataSkillsPath", "dataSkillsPickBtn",
];

function harness({ respondPost, confirmAnswer = true, errorText } = {}) {
  const nodes = new Map();
  for (const match of html.matchAll(/<([a-z0-9]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const el = new El();
    el.hidden = /\bhidden\b/.test(match[0]);
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
    askConfirm: () => confirmAnswer,
  });
  const line = (id) => ({ text: nodes.get(id).textContent, tone: nodes.get(id).dataset.tone });
  return {
    nodes, mutations, toasts, controller,
    get: (id) => nodes.get(id),
    exportStatus: () => line("dataExportStatus"),
    exportMeta: () => nodes.get("dataExportMeta").textContent,
    summary: () => line("dataImportSummary"),
    meta: () => nodes.get("dataImportMeta").textContent,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// 状态行的初始值写在 markup 里（与「关于」的「尚未检查更新」同一写法），
// 控制器不在启动时覆盖它，所以这条只能对着 HTML 断。
const initialText = (id) => (html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`)) || [, ""])[1];

const PREVIEW = {
  ok: true, token: "t1", sourceComputer: "DESKTOP-A1B2C3", createdAt: "2026-09-23T04:00:00.000Z",
  counts: { providers: 22, pools: 4, routingChains: 2, presets: 8, skillDirs: 25, credentials: 22 },
  skillsSourcePath: "C:\\Users\\me\\Desktop\\agent-home\\skills",
};

const EXPORT_OK = {
  ok: true, path: "C:\\out\\anyswitch-export-20260923-120000.zip",
  counts: { providers: 22, pools: 4, routingChains: 2, presets: 8, skillDirs: 25, credentials: 22 },
  skippedCredentials: [],
};

const applyHarness = (watchdog, applyResult = {}) => harness({
  respondPost: ({ path }) => (path === "/panel/api/data/import-pick"
    ? { ok: true, token: "t1", counts: { providers: 3 }, skillsSourcePath: null }
    : { ok: true, backupId: "b7", counts: { providers: 3 }, ...applyResult, ...(watchdog ? { watchdog } : {}) }),
});

async function click(h, id, rounds = 2) {
  h.get(id).onclick();
  for (let i = 0; i < rounds; i += 1) await tick();
  return h;
}

const pickPackage = (h) => click(h, "dataImportPickBtn");

test("markup 与控制器共用同一批 id，且注册表里有高级选项子 tab", () => {
  for (const id of IDS) assert.ok(html.includes(`id="${id}"`), `panel.html 缺 #${id}`);
  assert.ok(source.includes('advanced: ["settingsTabAdvanced", "settingsPanelAdvanced"]'),
    "settingsSubTabs 注册高级选项子 tab");
  const h = harness({ respondPost: () => ({ ok: true }) });
  for (const id of ["dataExportBtn", "dataImportPickBtn", "dataImportApplyBtn", "dataSkillsPickBtn"]) {
    assert.equal(typeof h.get(id).onclick, "function", `#${id} 应被控制器接管`);
  }
  assert.equal(initialText("dataExportStatus"), "尚未导出", "状态行要有初始值，与「关于」的尚未检查更新同一写法");
  assert.equal(initialText("dataImportSummary"), "尚未选择导出包");
  assert.equal(h.exportStatus().text, "", "控制器不抢写初始值");
  assert.equal(h.get("dataImportApplyBtn").disabled, true, "没选包之前不给写入");
  assert.equal(h.get("dataSkillsPickBtn").disabled, true, "没选包之前不能改 Skills 位置");
});

test("版式按 id 挂：本页各子面板的 display 都写在 id 上，漏一格就贴成一坨", () => {
  assert.match(css, /#settingsPanelAdvanced \{ display: flex; flex-direction: column; gap: 20px; \}/,
    "高级选项面板要有自己的 display 规则，与通用/关于同一待遇");
  assert.match(css, /#settingsPanelAdvanced \.modal-item \{/,
    "Skills 那行要跟通用页的 modal-item 同一手感（含悬停底）");
  for (const tone of ["busy", "ok", "warn", "danger"]) {
    assert.ok(css.includes(`.data-bundle-status[data-tone="${tone}"] { color: var(--`), `状态行缺 ${tone} 色调`);
  }
  assert.match(css,
    /html\[data-prepaint-view="settings"\]\[data-prepaint-subtab="advanced"\] #settingsPanelAdvanced\[hidden\] \{ display: flex !important; \}/,
    "停在高级选项时首帧要有落位规则，否则先闪「通用」");
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

test("导入：预览后状态行是中性摘要、明细行摆计数，两个按钮同时放开", async () => {
  const h = harness({ respondPost: () => PREVIEW });
  await pickPackage(h);
  assert.equal(h.summary().tone, undefined, "读到包内容只是中间步骤，不上成功色");
  assert.match(h.summary().text, /^已读取包内容：来自 DESKTOP-A1B2C3 · /);
  assert.equal(h.meta(), "渠道 22 · 号池 4 · 路由链 2 · 预设 8 · Skills 25 · 密钥 22");
  assert.equal(h.get("dataImportApplyBtn").disabled, false);
  assert.equal(h.get("dataSkillsPickBtn").disabled, false);
  assert.match(h.get("dataSkillsPath").textContent, /沿用导出包里记录的原始位置：C:\\Users\\me\\Desktop\\agent-home\\skills/);

  const bare = harness({ respondPost: () => ({ ok: true, token: "t2", counts: { providers: 1 }, skillsSourcePath: null }) });
  await click(bare, "dataImportPickBtn");
  assert.equal(bare.get("dataSkillsPickBtn").disabled, true, "包里没 Skills 就不给改位置");
  assert.equal(bare.get("dataSkillsPath").textContent, "包里不含 Skills 目录");
});

test("导入：确认框里选取消则一个写入请求都不发，票据还留着", async () => {
  const h = harness({
    confirmAnswer: false,
    respondPost: ({ path }) => (path === "/panel/api/data/import-pick" ? PREVIEW : { ok: true }),
  });
  await pickPackage(h);
  await click(h, "dataImportApplyBtn");
  assert.deepEqual(h.mutations.map((m) => m.path), ["/panel/api/data/import-pick"], "取消确认不该写入");
  assert.equal(h.get("dataImportApplyBtn").disabled, false, "取消后不必重选包");
});

test("导入：写入成功回填备份号，票据一次性", async () => {
  const h = harness({
    respondPost: ({ path }) => (path === "/panel/api/data/import-pick"
      ? { ok: true, token: "t1", counts: { providers: 3 }, skillsSourcePath: null }
      : { ok: true, backupId: "20260923-125900", counts: { providers: 3 }, applied: { store: true, credentials: 3 } }),
  });
  await pickPackage(h);
  await click(h, "dataImportApplyBtn", 3);
  assert.equal(h.summary().tone, "ok");
  assert.equal(h.summary().text, "导入完成 · 备份号 20260923-125900");
  assert.equal(h.meta(), "渠道 3");
  assert.equal(h.toasts.at(-1).message, "导入完成，已备份为 20260923-125900");
  assert.equal(h.toasts.at(-1).isErr, false);
  assert.equal(h.get("dataImportApplyBtn").disabled, true, "票据用掉后不许再点一次");
  await click(h, "dataImportApplyBtn");
  assert.equal(h.mutations.filter((m) => m.path === "/panel/api/data/import-apply").length, 1);
  assert.equal(JSON.stringify(h.mutations.find((m) => m.path === "/panel/api/data/import-apply").body),
    JSON.stringify({ token: "t1", skillsRepoPath: null }));
});

test("导入：读包与写入失败都退回未选择态并转 danger", async () => {
  const badZip = harness({
    respondPost: () => { const err = new Error("HTTP 200：包里缺 manifest.json，不像 anyswitch 导出包"); err.code = "包里缺 manifest.json，不像 anyswitch 导出包"; throw err; },
  });
  await pickPackage(badZip);
  assert.equal(badZip.summary().tone, "danger");
  assert.equal(badZip.summary().text, "包里缺 manifest.json，不像 anyswitch 导出包");
  assert.equal(badZip.get("dataImportApplyBtn").disabled, true, "坏包不留写入通道");

  const expired = harness({
    respondPost: ({ path }) => (path === "/panel/api/data/import-pick"
      ? { ok: true, token: "gone", counts: { providers: 3 }, skillsSourcePath: "C:\\skills" }
      : { ok: false, error: "导入确认已过期，请重新选择导出包" }),
  });
  await pickPackage(expired);
  await click(expired, "dataImportApplyBtn", 3);
  assert.equal(expired.summary().tone, "danger");
  assert.equal(expired.summary().text, "导入确认已过期，请重新选择导出包", "服务端原文直接可见");
  assert.equal(expired.get("dataImportApplyBtn").disabled, true, "过期票据只能重选包，不做静默重试");
  assert.equal(expired.get("dataSkillsPath").textContent, "沿用导出包里记录的原始位置", "Skills 行退回初始说法");
  assert.equal(expired.meta(), "");
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
    const h = await click(await pickPackage(applyHarness(c.watchdog)), "dataImportApplyBtn", 3);
    assert.equal(h.summary().tone, "warn", c.name);
    assert.equal(h.summary().text, "导入完成 · 备份号 b7，但「跟随 Coding Agent 启动」没完全跟上", c.name);
    assert.match(h.meta(), /渠道 3 · 「跟随 Coding Agent 启动」/, c.name);
    assert.match(h.meta(), c.expect, c.name);
    assert.equal(h.toasts.at(-1).isErr, false, "数据已换完，不该报成失败");
  }

  const clean = await click(await pickPackage(applyHarness({ desired: true, task: "registered", process: "started", warnings: [], reasons: {} })), "dataImportApplyBtn", 3);
  assert.equal(clean.summary().tone, "ok", "对齐顺利就是一句成功，不多话");
  assert.equal(clean.meta(), "渠道 3");
  const noWatchdog = await click(await pickPackage(applyHarness(null)), "dataImportApplyBtn", 3);
  assert.equal(noWatchdog.summary().tone, "ok");
});

test("导入：可改 Skills 位置，改完的路径随写入请求交回后端", async () => {
  const h = harness({
    respondPost: ({ path }) => (path === "/panel/api/data/import-pick"
      ? { ok: true, token: "t9", counts: {}, skillsSourcePath: "C:\\old\\skills" }
      : path === "/panel/api/skills/repo/pick"
        ? { ok: true, path: "D:\\new\\skills" }
        : { ok: true, backupId: "b1", counts: {} }),
  });
  await pickPackage(h);
  await click(h, "dataSkillsPickBtn");
  assert.equal(h.get("dataSkillsPath").textContent, "导入时放到：D:\\new\\skills");
  await click(h, "dataImportApplyBtn", 3);
  assert.equal(JSON.stringify(h.mutations.at(-1).body), JSON.stringify({ token: "t9", skillsRepoPath: "D:\\new\\skills" }));
});
