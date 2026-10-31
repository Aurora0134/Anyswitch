import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// 「备份位置」卡：控制器从 panel.js 原文摘出来跑，元素按 panel.html 真实存在的
// id 建。它只管三件事——读当前路径、换目录（服务端迁移历史备份）、恢复默认；
// 落点是否真的搬了由 backup-location.test.mjs 在临时目录里验。

const source = readFileSync(new URL("./panel-ui/panel.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./panel-ui/panel.html", import.meta.url), "utf8");

const IDS = ["dataBackupPath", "dataBackupOpenBtn", "dataBackupPickBtn", "dataBackupResetBtn"];

class El {
  constructor(tag = "") {
    this.textContent = "";
    this.disabled = /\bdisabled\b/.test(tag);
    this.hidden = /\bhidden\b/.test(tag);
    this.onclick = null;
    this.dataset = {};
  }
}

function harness(respond) {
  const nodes = new Map();
  for (const match of html.matchAll(/<([a-z0-9]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    nodes.set(match[2], new El(match[0]));
  }
  const doc = { getElementById: (id) => nodes.get(id) };
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
  const factory = vm.runInNewContext(`(${match[0]})`, {});
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
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (h) => { for (let i = 0; i < 4; i += 1) await tick(); return h; };

test("markup 有这四个 id，控制器接管三个按钮，初始不写路径", () => {
  for (const id of IDS) assert.ok(html.includes(`id="${id}"`), `panel.html 缺 #${id}`);
  const h = harness(() => ({ ok: true }));
  for (const id of ["dataBackupOpenBtn", "dataBackupPickBtn", "dataBackupResetBtn"]) {
    assert.equal(typeof h.get(id).onclick, "function", `#${id} 应被控制器接管`);
  }
  assert.equal(h.get("dataBackupResetBtn").hidden, true, "默认位置下不显示恢复默认");
  assert.equal(h.path(), "", "初始路径等 enter 现读，不在 markup 里写死");
});

test("进子页现读路径与默认态，恢复默认按钮随 isDefault 显隐", async () => {
  const custom = harness(() => ({ ok: true, path: "D:\\Anyswitch-backups", isDefault: false }));
  custom.controller.enter();
  await settle(custom);
  assert.equal(custom.path(), "D:\\Anyswitch-backups");
  assert.equal(custom.get("dataBackupResetBtn").hidden, false);
  assert.deepEqual(custom.calls.map((c) => `${c.method} ${c.path}`), ["GET /api/backups"]);

  const def = harness(() => ({ ok: true, path: "C:\\Users\\me\\AppData\\Local\\Anyswitch\\backups", isDefault: true }));
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
  assert.deepEqual(h.calls.map((c) => c.path), ["/api/backups", "/api/backups/pick", "/api/backups/set"]);
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
  assert.deepEqual(h.calls.map((c) => c.path), ["/api/backups", "/api/backups/pick"]);
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
