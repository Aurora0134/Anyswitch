import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// 「配置备份」卡：控制器从 panel.js 原文摘出来跑，元素按 panel.html 真实存在的
// id 建。位置部分只管三件事——读当前路径、换目录（服务端迁移历史备份）、恢复默认；
// 落点是否真的搬了由 backup-location.test.mjs 在临时目录里验。备份文件部分：
// 列表渲染（行结构＝名称等宽＋时间·大小次行＋行内删除钮）、空态、删除确认弹窗
// 全流程；列表数据的真实来源（listBackups/deleteBackup）同样在临时目录里验。

const source = readFileSync(new URL("../panel-ui/panel.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../panel-ui/panel.html", import.meta.url), "utf8");

const IDS = [
  "dataBackupPath", "dataBackupOpenBtn", "dataBackupPickBtn", "dataBackupResetBtn",
  "dataBackupList", "dataBackupListEmpty",
  "dataBackupDeleteModal", "dataBackupDeleteName",
  "dataBackupDeleteConfirm", "dataBackupDeleteCancel", "dataBackupDeleteClose",
];

class El {
  constructor(tag = "") {
    this.textContent = "";
    this.innerHTML = "";
    this.disabled = /\bdisabled\b/.test(tag);
    this.hidden = /\bhidden\b/.test(tag);
    this.onclick = null;
    this.dataset = {};
    this.children = [];
    this.className = "";
    this.attributes = {};
    const cls = (tag.match(/class="([^"]*)"/) || [, ""])[1];
    this._cls = new Set(cls.split(/\s+/).filter(Boolean));
    this.classList = {
      add: (c) => this._cls.add(c),
      remove: (c) => this._cls.delete(c),
      toggle: (c, force) => { (force ?? !this._cls.has(c)) ? this._cls.add(c) : this._cls.delete(c); },
      contains: (c) => this._cls.has(c),
    };
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
}

function harness(respond) {
  const nodes = new Map();
  for (const match of html.matchAll(/<([a-z0-9]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    nodes.set(match[2], new El(match[0]));
  }
  const doc = {
    getElementById: (id) => nodes.get(id),
    createElement: (tag) => new El(tag),
  };
  const calls = [];
  const toasts = [];
  const request = (method, path, body) => {
    calls.push({ method, path, body });
    return Promise.resolve().then(() => {
      const data = respond({ method, path, body });
      if (data && data.ok === false) {
        const err = new Error(`HTTP 200：${data.error}`);
        err.code = String(data.error || "");
        throw err;
      }
      return data;
    });
  };
  const match = source.match(/  function createBackupLocationController\([\s\S]*?\n  \}/);
  assert.ok(match, "testable backup location controller exists in panel.js");
  const factory = vm.runInNewContext(`(${match[0]})`, { URL, Date, Number });
  const controller = factory({
    request,
    doc,
    notify: (message, isErr) => toasts.push({ message, isErr }),
    errorText: (err, fallback) => err?.code || fallback,
  });
  return {
    nodes, calls, toasts, controller,
    get: (id) => nodes.get(id),
    path: () => nodes.get("dataBackupPath").textContent,
    rows: () => nodes.get("dataBackupList").children,
    emptyShown: () => !nodes.get("dataBackupListEmpty").hidden,
    delModalOpen: () => nodes.get("dataBackupDeleteModal").classList.contains("show"),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (h) => { for (let i = 0; i < 4; i += 1) await tick(); return h; };

test("markup 有这些 id，控制器接管按钮，初始不写路径", () => {
  for (const id of IDS) assert.ok(html.includes(`id="${id}"`), `panel.html 缺 #${id}`);
  const h = harness(() => ({ ok: true }));
  for (const id of ["dataBackupOpenBtn", "dataBackupPickBtn", "dataBackupResetBtn", "dataBackupDeleteConfirm", "dataBackupDeleteCancel", "dataBackupDeleteClose"]) {
    assert.equal(typeof h.get(id).onclick, "function", `#${id} 应被控制器接管`);
  }
  assert.equal(h.get("dataBackupResetBtn").hidden, true, "默认位置下不显示恢复默认");
  assert.equal(h.path(), "", "初始路径等 enter 现读，不在 markup 里写死");
  assert.equal(h.rows().length, 0, "列表等 enter 现读，不在 markup 里写死");
  assert.equal(h.emptyShown(), false, "空态初值 hidden：还没读过列表时不该抢话");
  assert.match(html, /id="dataBackupListEmpty" hidden>暂无备份</, "空态文案初值写在 markup 里");
  assert.equal(h.delModalOpen(), false, "删除弹窗初始不开");
});

test("进子页现读路径与默认态，恢复默认按钮随 isDefault 显隐", async () => {
  const custom = harness(() => ({ ok: true, path: "D:\\Anyswitch-backups", isDefault: false, items: [] }));
  custom.controller.enter();
  await settle(custom);
  assert.equal(custom.path(), "D:\\Anyswitch-backups");
  assert.equal(custom.get("dataBackupResetBtn").hidden, false);
  assert.deepEqual(custom.calls.map((c) => `${c.method} ${c.path}`), ["GET /api/backups", "GET /api/backups/list"]);

  const def = harness(() => ({ ok: true, path: "C:\\Users\\me\\AppData\\Local\\Anyswitch\\backups", isDefault: true, items: [] }));
  def.controller.enter();
  await settle(def);
  assert.equal(def.get("dataBackupResetBtn").hidden, true);
});

test("更改位置：选目录 → set 迁移 → 路径换新、出现恢复默认、toast 报新位置", async () => {
  const h = harness(({ path }) => {
    if (path === "/api/backups") return { ok: true, path: "C:\\old\\backups", isDefault: true };
    if (path === "/api/backups/pick") return { ok: true, cancelled: false, path: "D:\\new\\backups" };
    if (path === "/api/backups/set") return { ok: true, path: "D:\\new\\backups", moved: 2 };
    return { ok: true };
  });
  h.controller.enter();
  await settle(h);
  h.get("dataBackupPickBtn").onclick();
  await settle(h);
  assert.deepEqual(h.calls.map((c) => c.path), ["/api/backups", "/api/backups/list", "/api/backups/pick", "/api/backups/set"]);
  assert.equal(JSON.stringify(h.calls.at(-1).body), JSON.stringify({ path: "D:\\new\\backups" }), "请求体只带目标路径");
  assert.equal(h.path(), "D:\\new\\backups");
  assert.equal(h.get("dataBackupResetBtn").hidden, false);
  assert.equal(h.toasts.at(-1).message, "备份位置已改为 D:\\new\\backups");
  assert.equal(h.toasts.at(-1).isErr, false);
  assert.equal(h.get("dataBackupPickBtn").disabled, false, "落定后按钮回到可点");
});

test("选目录取消：一个迁移请求都不发", async () => {
  const h = harness(({ path }) => {
    if (path === "/api/backups") return { ok: true, path: "C:\\backups", isDefault: true };
    if (path === "/api/backups/pick") return { ok: true, cancelled: true };
    return { ok: true };
  });
  h.controller.enter();
  await settle(h);
  h.get("dataBackupPickBtn").onclick();
  await settle(h);
  assert.deepEqual(h.calls.map((c) => c.path), ["/api/backups", "/api/backups/list", "/api/backups/pick"]);
  assert.equal(h.path(), "C:\\backups");
});

test("迁移被拒：路径保持原样，toast 说「未做任何改动」并带服务端原因", async () => {
  const h = harness(({ path }) => {
    if (path === "/api/backups") return { ok: true, path: "C:\\backups", isDefault: true };
    if (path === "/api/backups/pick") return { ok: true, cancelled: false, path: "D:\\taken" };
    if (path === "/api/backups/set") return { ok: false, error: "目标里已有同名项 pre-import-20261031-120000" };
    return { ok: true };
  });
  h.controller.enter();
  await settle(h);
  h.get("dataBackupPickBtn").onclick();
  await settle(h);
  assert.equal(h.path(), "C:\\backups", "失败不改屏上路径");
  assert.equal(h.get("dataBackupResetBtn").hidden, true);
  assert.equal(h.toasts.at(-1).message, "未做任何改动：目标里已有同名项 pre-import-20261031-120000");
  assert.equal(h.toasts.at(-1).isErr, true);
});

test("恢复默认：走 reset，路径回默认、按钮收起、toast 报结果", async () => {
  const h = harness(({ path }) => {
    if (path === "/api/backups") return { ok: true, path: "D:\\custom", isDefault: false };
    if (path === "/api/backups/reset") return { ok: true, path: "C:\\Users\\me\\AppData\\Local\\Anyswitch\\backups", moved: 1 };
    return { ok: true };
  });
  h.controller.enter();
  await settle(h);
  h.get("dataBackupResetBtn").onclick();
  await settle(h);
  assert.equal(h.calls.at(-1).path, "/api/backups/reset");
  assert.equal(h.path(), "C:\\Users\\me\\AppData\\Local\\Anyswitch\\backups");
  assert.equal(h.get("dataBackupResetBtn").hidden, true);
  assert.equal(h.toasts.at(-1).message, "备份位置已恢复默认");
});

test("打开文件夹：只发 open，不携带任何路径参数", async () => {
  const h = harness(() => ({ ok: true }));
  h.get("dataBackupOpenBtn").onclick();
  await settle(h);
  assert.deepEqual(h.calls, [{ method: "POST", path: "/api/backups/open", body: undefined }]);
});

test("读路径失败在 toast 里报错，不把空路径画上去", async () => {
  const h = harness(() => ({ ok: false, error: "服务端不可用" }));
  h.controller.enter();
  await settle(h);
  assert.equal(h.path(), "");
  assert.equal(h.toasts.at(-1).message, "服务端不可用");
  assert.equal(h.toasts.at(-1).isErr, true);
});

// ── 备份文件列表 ─────────────────────────────────────────

const ITEMS = [
  { name: "pre-import-20261116-101500", kind: "pre-import", createdAt: "2026-11-16T02:00:00.000Z", sizeBytes: 1536 },
  { name: "byok-import-20261115-230000", kind: "byok-import", createdAt: "2026-11-15T15:00:00.000Z", sizeBytes: 2097152 },
];

const withList = (items) => ({ path }) => {
  if (path === "/api/backups") return { ok: true, path: "C:\\backups", isDefault: true };
  if (path === "/api/backups/list") return { ok: true, items };
  return { ok: true };
};

test("备份文件列表：行＝名称等宽＋时间·大小次行＋行内删除钮，空态收起", async () => {
  const h = harness(withList(ITEMS));
  h.controller.enter();
  await settle(h);
  assert.equal(h.rows().length, 2);
  assert.equal(h.emptyShown(), false, "有备份时不显示空态");
  const [first] = h.rows();
  const [main, del] = first.children;
  assert.equal(main.children[0].className, "data-backup-name");
  assert.equal(main.children[0].textContent, "pre-import-20261116-101500");
  assert.match(main.children[1].textContent, /· 1\.5 KB/, "次行＝时间 · 大小");
  assert.equal(del.className, "data-backup-del");
  assert.equal(del.getAttribute("aria-label"), "删除备份", "行内删除钮是定稿 aria-label");
  assert.equal(del.textContent, "", "纯图标钮，零新增可见文案");
  assert.match(del.innerHTML, /<svg/, "图标用 svg");
  assert.equal(h.rows()[1].children[0].children[1].textContent.includes("2.0 MB"), true, "MB 档格式化");
});

test("备份文件列表：空列表揭开空态「暂无备份」", async () => {
  const h = harness(withList([]));
  h.controller.enter();
  await settle(h);
  assert.equal(h.rows().length, 0);
  assert.equal(h.emptyShown(), true);
});

test("删除备份：行内钮唤起确认弹窗，确认后删除、toast、列表重拉", async () => {
  const h = harness(withList(ITEMS));
  h.controller.enter();
  await settle(h);
  h.rows()[0].children[1].onclick();
  assert.equal(h.delModalOpen(), true);
  assert.equal(h.get("dataBackupDeleteName").textContent, "pre-import-20261116-101500", "弹窗展示正在删除的对象");
  h.get("dataBackupDeleteConfirm").onclick();
  await settle(h);
  assert.deepEqual(h.calls.map((c) => `${c.method} ${c.path}`),
    ["GET /api/backups", "GET /api/backups/list", "POST /api/backups/delete", "GET /api/backups/list"],
    "删除成功后重拉列表");
  assert.equal(JSON.stringify(h.calls[2].body), JSON.stringify({ name: "pre-import-20261116-101500" }), "请求体只带备份名");
  assert.equal(h.delModalOpen(), false, "成功后弹窗收起");
  assert.equal(h.toasts.at(-1).message, "已删除备份", "删除 toast 为定稿文案");
  assert.equal(h.toasts.at(-1).isErr, false);
  assert.equal(h.get("dataBackupDeleteConfirm").disabled, false, "落定后按钮回到可点");
});

test("删除备份：取消/关闭不发请求，弹窗收起", async () => {
  for (const closer of ["dataBackupDeleteCancel", "dataBackupDeleteClose"]) {
    const h = harness(withList(ITEMS));
    h.controller.enter();
    await settle(h);
    h.rows()[1].children[1].onclick();
    assert.equal(h.delModalOpen(), true);
    h.get(closer).onclick();
    assert.equal(h.delModalOpen(), false);
    assert.equal(h.calls.filter((c) => c.path === "/api/backups/delete").length, 0, `${closer} 不发删除请求`);
  }
});

test("删除备份：服务端拒绝时弹窗留着，toast 带服务端原文", async () => {
  const h = harness(({ path }) => {
    if (path === "/api/backups") return { ok: true, path: "C:\\backups", isDefault: true };
    if (path === "/api/backups/list") return { ok: true, items: ITEMS };
    if (path === "/api/backups/delete") return { ok: false, error: "备份不存在" };
    return { ok: true };
  });
  h.controller.enter();
  await settle(h);
  h.rows()[0].children[1].onclick();
  h.get("dataBackupDeleteConfirm").onclick();
  await settle(h);
  assert.equal(h.delModalOpen(), true, "失败不关弹窗，用户可再看一眼");
  assert.equal(h.toasts.at(-1).message, "备份不存在", "服务端原文直接可见");
  assert.equal(h.toasts.at(-1).isErr, true);
});

test("删除确认弹窗文案为定稿逐字：标题/正文/按钮", () => {
  const modal = html.slice(html.indexOf('id="dataBackupDeleteModal"'), html.indexOf('id="dataBackupDeleteModal"') + 1600);
  assert.ok(modal.includes(">删除备份</h3>"), "标题「删除备份」");
  assert.ok(modal.includes("该备份文件将被永久删除，无法撤销。"), "正文逐字");
  assert.ok(modal.includes('id="dataBackupDeleteConfirm">删除</button>'), "确认钮「删除」");
  assert.ok(modal.includes('id="dataBackupDeleteCancel">取消</button>'), "取消钮「取消」");
});
