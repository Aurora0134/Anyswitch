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
  respondPost: ({ path }) => (path === "/api/data/import-pick"
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
  assert.equal(h.exportStatus().text, "尚未导出", "控制器不抢写初始值（保持 markup 那份）");
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
    respondPost: ({ path }) => (path === "/api/data/import-pick" ? PREVIEW : { ok: true }),
  });
  await pickPackage(h);
  await click(h, "dataImportApplyBtn");
  assert.deepEqual(h.mutations.map((m) => m.path), ["/api/data/import-pick"], "取消确认不该写入");
  assert.equal(h.get("dataImportApplyBtn").disabled, false, "取消后不必重选包");
});

test("导入：写入成功回填备份号，票据一次性", async () => {
  const h = harness({
    respondPost: ({ path }) => (path === "/api/data/import-pick"
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
  assert.equal(h.mutations.filter((m) => m.path === "/api/data/import-apply").length, 1);
  assert.equal(JSON.stringify(h.mutations.find((m) => m.path === "/api/data/import-apply").body),
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
    respondPost: ({ path }) => (path === "/api/data/import-pick"
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
    respondPost: ({ path }) => (path === "/api/data/import-pick"
      ? { ok: true, token: "t9", counts: {}, skillsSourcePath: "C:\\old\\skills" }
      : path === "/api/skills/repo/pick"
        ? { ok: true, path: "D:\\new\\skills" }
        : { ok: true, backupId: "b1", counts: {} }),
  });
  await pickPackage(h);
  await click(h, "dataSkillsPickBtn");
  assert.equal(h.get("dataSkillsPath").textContent, "导入时放到：D:\\new\\skills");
  await click(h, "dataImportApplyBtn", 3);
  assert.equal(JSON.stringify(h.mutations.at(-1).body), JSON.stringify({ token: "t9", skillsRepoPath: "D:\\new\\skills" }));
});

// ─────────────────────────────────────────────────────────────
// 文案生命周期：结果离开即复位，状态随票据留着，离开期间落地的结果等切回
//
// 本卡文本有两种身份，复位规则不同（见 createDataBundleController 的注释）：
//   状态 = 票据还活着时的预览摘要 + Skills 落点行 → 离开再回来必须还在
//   结果 = 导出 / 导入的一次性回执 → 离开即回初值
// 复位用的初值一律取 markup 里写的那份，控制器不另造文案。
// 没有这套规则时的实际症状：导出成功后「已导出 xxx.zip」永不复位，切子 tab、
// 回看板、再回来都还挂着，文件删了界面照样说已导出，只有整页刷新才回初值。

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

test("生命周期：票据还在时离开，预览是状态，必须留着（不逼用户重挑包）", async () => {
  const h = harness({ respondPost: () => PREVIEW });
  h.controller.enter();
  await pickPackage(h);
  assert.match(h.summary().text, /^已读取包内容：/);
  h.controller.leave();
  assert.match(h.summary().text, /^已读取包内容：/, "预览是状态，离开不清");
  assert.equal(h.meta(), "渠道 22 · 号池 4 · 路由链 2 · 预设 8 · Skills 25 · 密钥 22", "明细也留着");
  assert.equal(h.get("dataImportApplyBtn").disabled, false, "票据还有效，写入通道不能关");
  assert.equal(h.get("dataSkillsPickBtn").disabled, false, "Skills 位置也还能改");
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

test("生命周期：导入结果离开也复位，Skills 落点行一起回初值", async () => {
  const h = harness({
    respondPost: ({ path }) => (path === "/api/data/import-pick"
      ? { ok: true, token: "t9", counts: {}, skillsSourcePath: "C:\\old\\skills" }
      : path === "/api/skills/repo/pick"
        ? { ok: true, path: "D:\\new\\skills" }
        : { ok: false, error: "导入确认已过期，请重新选择导出包" }),
  });
  h.controller.enter();
  await pickPackage(h);
  await click(h, "dataSkillsPickBtn");
  await click(h, "dataImportApplyBtn", 3);
  assert.equal(h.summary().tone, "danger");
  h.controller.leave();
  assert.equal(h.summary().text, initialText("dataImportSummary"), "失败回执也回初值");
  assert.equal(h.get("dataSkillsPath").textContent, initialText("dataSkillsPath"), "改过的落点行跟着收");
});

test("生命周期：导出侧的复位不碰导入侧的状态（两半互不牵连）", async () => {
  const h = harness({ respondPost: ({ path }) => (path === "/api/data/import-pick" ? PREVIEW : EXPORT_OK) });
  h.controller.enter();
  await pickPackage(h);
  await click(h, "dataExportBtn");
  h.controller.leave();
  assert.equal(h.exportStatus().text, initialText("dataExportStatus"), "导出结果复位");
  assert.match(h.summary().text, /^已读取包内容：/, "票据还在，导入预览不受影响");
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

