import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./panel-ui/panel.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./panel-ui/panel.html", import.meta.url), "utf8");

class Element {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.className = "";
    this.style = { setProperty() {} };
    this.classList = {
      contains: (name) => this.className.split(" ").includes(name),
      toggle: (name, on) => {
        const names = new Set(this.className.split(" ").filter(Boolean));
        if (on) names.add(name); else names.delete(name);
        this.className = [...names].join(" ");
      },
      remove: (name) => this.classList.toggle(name, false),
    };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || "") + this.children.map((child) => child.textContent).join(""); }
  set innerHTML(_) { throw new Error("About must use text nodes"); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.text = ""; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelector() { return null; }
  focus() { this.focused = true; }
  click() { if (!this.disabled) return this.onclick?.(); }
}

function descendants(node, predicate) {
  return node.children.flatMap((child) => [ ...(predicate(child) ? [child] : []), ...descendants(child, predicate) ]);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const appInfo = { version: "0.5.0-preview", prerelease: true, platform: "win32", nodeVersion: "v24.13.0" };
const ids = ["claude", "codex", "opencode", "pi", "kimi", "dsh", "zcode", "qoder", "grok"];
function environment() {
  return {
    platform: "win32", nodeVersion: "v24.13.0", checkedAt: "2026-09-18T08:00:00Z",
    clients: ids.map((id) => ({
      id, name: id,
      installations: (id === "qoder" || id === "zcode" ? ["desktop"] : ["cli"]).map((kind) => ({
        kind, remoteId: id === "grok" ? null : id, // Grok Build 无官方版本源，关于页不对其发起查询（与生产行为一致）
        status: "found", path: `C:\\Apps\\${id}\\${kind}`, version: kind === "desktop" ? "2.0.0" : "1.0.0",
        versionSource: "package-json", issue: null,
      })),
    })),
  };
}
const latest = (version = "1.1.0", comparison = "update_available") => ({ state: "ok", version, comparison, source: "npm", checkedAt: "2026-09-18T08:01:00Z", url: "https://www.npmjs.com/package/@anthropic-ai/claude-code" });

function harness(respond = () => latest(), options = {}) {
  const nodes = new Map();
  for (const match of html.matchAll(/<([a-z0-9]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Element(match[1]);
    node.className = match[0].match(/class="([^"]*)"/)?.[1] || "";
    node.hidden = /\bhidden\b/.test(match[0]);
    nodes.set(match[2], node);
  }
  const doc = {
    getElementById: (id) => nodes.get(id),
    createElement: (tag) => new Element(tag),
    querySelector: () => null,
  };
  const calls = [];
  const mutations = [];
  const toasts = [];
  const respondPost = options.respondPost ?? (() => { throw new Error("unexpected POST"); });
  const request = (method, path, body) => {
    if (method === "POST") {
      mutations.push({ path, body });
      return Promise.resolve().then(() => respondPost({ path, body }));
    }
    assert.equal(method, "GET");
    calls.push(path);
    return Promise.resolve().then(() => respond(path));
  };
  // 手动轮询调度器：不主动跑，测试用 flushJobs() 推进，时间全可控
  const jobs = [];
  const schedule = options.schedule ?? ((fn) => { jobs.push(fn); return jobs.length; });
  const cancelSchedule = options.cancelSchedule ?? (() => {});
  const flushJobs = () => { const pending = jobs.splice(0); for (const fn of pending) fn(); };
  const match = source.match(/  function createAboutController\([\s\S]*?\n  \}/);
  assert.ok(match, "testable About controller exists in panel.js");
  const factory = vm.runInNewContext(`(${match[0]})`, { URL, URLSearchParams, setTimeout, clearTimeout });
  const controller = factory({ request, doc, notify: options.notify ?? ((message, isErr) => { toasts.push({ message, isErr }); }), schedule, cancelSchedule });
  return { nodes, doc, calls, mutations, toasts, flushJobs, controller, get: (id) => nodes.get(id), row: (id) => nodes.get("aboutClients").children.find((node) => node.dataset.clientId === id) };
}

function normal(path) {
  if (path === "/api/app-info") return appInfo;
  if (path.startsWith("/api/environment?" ) || path === "/api/environment") return environment();
  return latest();
}

test("enter renders local data before official replies; remote concurrency is bounded; entering triggers one non-forced update check", async () => {
  const pending = [];
  const h = harness((path) => {
    if (!path.includes("/latest/")) return normal(path);
    const d = deferred(); pending.push({ path, ...d }); return d.promise;
  });
  const entering = h.controller.enter();
  await tick();
  assert.match(h.get("aboutAppVersion").textContent, /0\.5\.0-preview/);
  assert.equal(h.get("aboutPreviewBadge").hidden, false);
  assert.match(h.get("aboutSystem").textContent, /Windows.*Node.*v24\.13\.0/);
  assert.equal(h.get("aboutClients").children.length, 9);
  assert.match(h.row("claude").textContent, /本地.*1\.0\.0/);
  assert.match(h.row("claude").textContent, /查询中/);
  assert.equal(pending.length, 3);
  assert.ok(h.get("aboutEnvironmentRefresh").disabled);
  assert.deepEqual(h.calls.filter((path) => path.startsWith("/api/updates")), ["/api/updates"]);
  pending[0].resolve(latest());
  await tick();
  assert.match(h.row("claude").textContent, /官方最新.*1\.1\.0.*有新版本/);
  assert.equal(pending.length, 4);
  for (let index = 1; index < pending.length; index++) { pending[index].resolve(latest()); await tick(); }
  await entering;
  assert.equal(h.get("aboutEnvironmentRefresh").disabled, false);
  assert.match(h.row("qoder").textContent, /桌面.*本地.*2\.0\.0/);
  assert.doesNotMatch(h.row("qoder").textContent, /CLI/);
  assert.equal(descendants(h.row("qoder"), (node) => node.className === "about-version-line").length, 1);
});

test("update check runs once on entry and the button forces a fresh check; all server states render", async () => {
  let update = deferred();
  const h = harness((path) => path.startsWith("/api/updates") ? update.promise : normal(path));
  const entering = h.controller.enter();
  await tick();
  assert.deepEqual(h.calls.filter((path) => path.startsWith("/api/updates")), ["/api/updates"]);
  assert.match(h.get("aboutUpdateStatus").textContent, /正在检查更新/);
  assert.equal(h.get("aboutCheckUpdates").disabled, true, "entry check in flight must block the button");
  update.resolve({ state: "current", checkedAt: "2026-09-18T09:00:00Z", release: null });
  await entering;
  await tick(); await tick();
  assert.match(h.get("aboutUpdateStatus").textContent, /当前已是最新/);
  assert.equal(h.get("aboutCheckUpdates").disabled, false);
  update = deferred();
  const checking = h.get("aboutCheckUpdates").click();
  h.controller.checkUpdates(true);
  await tick();
  assert.equal(h.calls.filter((path) => path === "/api/updates?refresh=1").length, 1);
  assert.equal(h.get("aboutCheckUpdates").disabled, true);
  update.resolve({ state: "update_available", checkedAt: "2026-09-18T09:00:00Z", release: { version: "0.5.1", prerelease: false, url: "https://github.com/Aurora0134/Anyswitch/releases/tag/v0.5.1" } });
  await checking;
  assert.match(h.get("aboutUpdateStatus").textContent, /发现新版本 0\.5\.1/);
  assert.doesNotMatch(h.get("aboutUpdateStatus").textContent, /预览版/);
  update = deferred();
  const checkingPreview = h.get("aboutCheckUpdates").click();
  update.resolve({ state: "update_available", checkedAt: "2026-09-18T09:00:30Z", release: { version: "0.5.0-preview.2", prerelease: true, url: "https://github.com/Aurora0134/Anyswitch/releases/tag/v0.5.0-preview.2" } });
  await checkingPreview;
  assert.match(h.get("aboutUpdateStatus").textContent, /发现新预览版 0\.5\.0-preview\.2/);
  assert.equal(h.get("aboutReleaseLink").href, "https://github.com/Aurora0134/Anyswitch/releases/tag/v0.5.0-preview.2");
  assert.equal(h.get("aboutReleaseLink").hidden, false);
  for (const [state, copy] of [["current", /当前已是最新/], ["ahead", /当前版本领先/], ["no_releases", /暂无发布/], ["unknown_version", /无法比较/], ["error", /暂时无法检查/]]) {
    update = deferred();
    const checkingAgain = h.get("aboutCheckUpdates").click();
    update.resolve({ state, checkedAt: "2026-09-18T09:01:00Z", release: null });
    await checkingAgain;
    assert.match(h.get("aboutUpdateStatus").textContent, copy);
    assert.equal(h.get("aboutCheckUpdates").disabled, false);
    assert.equal(h.get("aboutReleaseLink").hidden, true);
  }
  update = deferred();
  const failed = h.get("aboutCheckUpdates").click();
  update.reject(new Error("offline"));
  await failed;
  assert.match(h.get("aboutUpdateStatus").textContent, /暂时无法检查/);
  assert.doesNotMatch(h.get("aboutUpdateStatus").textContent, /已是最新/);
});

test("local failure can retry from button; refresh passes explicit bypass to local and official requests", async () => {
  let failed = true;
  const h = harness((path) => {
    if (path === "/api/environment" && failed) throw new Error("local failed");
    return normal(path);
  });
  await h.controller.enter();
  assert.match(h.get("aboutEnvironmentStatus").textContent, /检测失败/);
  assert.equal(h.get("aboutEnvironmentRefresh").disabled, false);
  assert.equal(h.calls.some((path) => path.includes("/latest/")), false);
  failed = false;
  await h.get("aboutEnvironmentRefresh").click();
  assert.ok(h.calls.includes("/api/environment?refresh=1"));
  assert.equal(h.calls.filter((path) => path.includes("/latest/")).length, 8);
  assert.ok(h.calls.filter((path) => path.includes("/latest/")).every((path) => new URL(path, "http://local").searchParams.get("refresh") === "1"));
});

test("only found valid versions are compared; missing and unreadable clients retain their local status", async () => {
  const local = environment();
  local.clients[0].installations[0].status = "not_found";
  local.clients[1].installations[0].version = null;
  local.clients[2].installations[0].version = "not a version";
  local.clients[3].installations[0].status = "error";
  const h = harness((path) => path === "/api/environment" ? local : normal(path));
  await h.controller.enter();
  for (const id of ["claude", "codex", "opencode", "pi"]) {
    const call = h.calls.find((path) => path.includes(`/latest/${id}?`) || path === `/api/environment/latest/${id}`);
    assert.ok(call);
    assert.equal(new URL(call, "http://local").searchParams.has("localVersion"), false);
    assert.doesNotMatch(h.row(id).textContent, /有新版本|与官方最新版本一致/);
  }
  const lineText = (id) => descendants(h.row(id), (node) => node.className === "about-version-line").map((node) => node.textContent).join(" ");
  assert.match(h.row("claude").textContent, /未找到/);
  assert.match(h.row("codex").textContent, /版本无法读取/);
  assert.match(h.row("pi").textContent, /检测失败/);
  // 状态词只在「本地」列出现一次，结果列不重复同一句
  assert.equal((lineText("claude").match(/未找到/g) || []).length, 1);
  assert.equal((lineText("codex").match(/版本无法读取/g) || []).length, 1);
  assert.equal((lineText("pi").match(/检测失败/g) || []).length, 1);
  assert.ok(h.calls.includes("/api/environment/latest/qoder?localVersion=2.0.0"));
});

test("an installed-but-unresponsive client is flagged without a comparison claim", async () => {
  const local = environment();
  local.clients[1].installations[0].version = null;
  local.clients[1].installations[0].issue = "not_runnable";
  const h = harness((path) => path === "/api/environment" ? local : normal(path));
  await h.controller.enter();
  const codex = h.row("codex");
  assert.match(codex.textContent, /已安装但无法运行/);
  const localSpan = descendants(codex, (node) => node.className === "about-version" && /已安装但无法运行/.test(node.textContent))[0];
  assert.equal(localSpan.dataset.tone, "danger");
  const call = h.calls.find((path) => path.includes("/latest/codex"));
  assert.ok(call);
  assert.equal(new URL(call, "http://local").searchParams.has("localVersion"), false);
  assert.doesNotMatch(codex.textContent, /有新版本|与官方最新版本一致/);
});

test("official errors are per item and never claim the local client is current", async () => {
  const h = harness((path) => {
    if (path.includes("/latest/claude")) return { state: "error", version: null, errorCode: "offline" };
    if (path.includes("/latest/codex")) throw new Error("offline");
    return normal(path);
  });
  await h.controller.enter();
  for (const id of ["claude", "codex"]) {
    assert.match(h.row(id).textContent, /查询失败/);
    assert.match(h.row(id).textContent, /本地.*1\.0\.0/);
    assert.doesNotMatch(h.row(id).textContent, /与官方最新版本一致/);
  }
  assert.match(h.row("kimi").textContent, /有新版本/);
});

test("leaving ignores late local and update responses; returning reuses pending requests but starts a new view generation", async () => {
  const local = deferred(), update = deferred();
  const h = harness((path) => path === "/api/environment" ? local.promise : path.startsWith("/api/updates") ? update.promise : normal(path));
  const first = h.controller.enter();
  await tick();
  h.controller.leave();
  const second = h.controller.enter();
  await tick();
  assert.equal(h.calls.filter((path) => path === "/api/environment").length, 1);
  local.resolve(environment());
  update.resolve({ state: "current", checkedAt: "2026-09-18T09:00:00Z" });
  await Promise.all([first, second]);
  await tick(); await tick();
  assert.equal(h.get("aboutClients").children.length, 9);
  assert.match(h.get("aboutUpdateStatus").textContent, /当前已是最新/);
  assert.equal(h.calls.filter((path) => path.includes("/latest/")).length, 8);
});

test("refresh and navigation isolate late remote comparisons and preserve visible cached values", async () => {
  const old = deferred();
  const h = harness((path) => {
    if (path === "/api/environment") return environment();
    if (path === "/api/environment?refresh=1") {
      const local = environment(); local.clients[0].installations[0].version = "3.0.0"; return local;
    }
    if (path.includes("/latest/claude?refresh=1")) return old.promise;
    return path.includes("/latest/claude") ? latest("3.0.0", "current") : normal(path);
  });
  await h.controller.enter();
  const refreshing = h.get("aboutEnvironmentRefresh").click();
  await tick();
  h.controller.leave();
  await h.controller.enter();
  assert.match(h.row("claude").textContent, /本地.*3\.0\.0.*与官方最新版本一致/);
  old.resolve(latest("1.1.0"));
  await refreshing;
  assert.match(h.row("claude").textContent, /本地.*3\.0\.0.*官方最新.*3\.0\.0/);
  h.controller.leave();
  const reopened = h.controller.enter();
  assert.match(h.row("claude").textContent, /3\.0\.0/);
  await reopened;
});

test("untrusted text remains literal and external links are restricted to HTTPS official product locations", async () => {
  const bad = '<img src=x onerror="alert(1)">';
  const local = environment(); local.clients[0].installations[0].path = bad;
  let releaseUrl = "https://github.com/attacker/Anyswitch/releases/tag/v1";
  const h = harness((path) => {
    if (path === "/api/environment") return local;
    if (path.startsWith("/api/updates")) return { state: "update_available", release: { version: bad, url: releaseUrl } };
    if (path.includes("/latest/")) return { ...latest(bad), url: "javascript:alert(1)" };
    return normal(path);
  });
  await h.controller.enter();
  assert.match(h.row("claude").textContent, /<img src=x/);
  assert.equal(descendants(h.row("claude"), (node) => node.tagName === "a").length, 0);
  for (const url of [releaseUrl, "http://github.com/Aurora0134/Anyswitch/releases/tag/v1", "https://github.com.evil.test/Aurora0134/Anyswitch/releases/tag/v1", "https://user@github.com/Aurora0134/Anyswitch/releases/tag/v1"]) {
    releaseUrl = url;
    await h.get("aboutCheckUpdates").click();
    assert.equal(h.get("aboutReleaseLink").hidden, true);
    assert.match(h.get("aboutUpdateStatus").textContent, /<img src=x/);
  }
});

test("DSH 官方来源链接放行真实仓库 deepseek-harness", async () => {
  const h = harness((path) => path.includes("/latest/dsh")
    ? { ...latest(), url: "https://github.com/deepseek-ai/deepseek-harness/releases" }
    : normal(path));
  await h.controller.enter();
  const links = descendants(h.row("dsh"), (node) => node.tagName === "a");
  assert.equal(links.length, 1);
  assert.equal(links[0].href, "https://github.com/deepseek-ai/deepseek-harness/releases");
});

test("关于页头部提供产品图标与常驻 GitHub、发布说明入口", () => {
  assert.match(html, /<img class="about-app-icon" src="\/panel\/assets\/logo\.png" alt="">/);
  assert.match(html, /href="https:\/\/github\.com\/Aurora0134\/Anyswitch"[^>]*>GitHub<\/a>/);
  assert.match(html, /href="https:\/\/github\.com\/Aurora0134\/Anyswitch\/releases"[^>]*>发布说明<\/a>/);
});

test("settings has explicit third tab mapping and leaving About runs its lifecycle without taking a theme snapshot", () => {
  const h = harness();
  const tabs = source.match(/    const settingsSubTabs = \{[\s\S]*?\n    \};/);
  const activate = source.match(/    function activateSettingsSubTab\(which, animate\) \{[\s\S]*?\n    \}/);
  const bind = source.match(/    function bindSettingsSubTabs\(\) \{[\s\S]*?\n    \}/);
  assert.ok(tabs && activate && bind);
  let enters = 0, leaves = 0, mirrors = 0, pageScrollResets = 0;
  const context = vm.createContext({
    $: h.get, about: { enter() { enters++; }, leave() { leaves++; } },
    replayViewEnter() {}, captureSettingsMirror() { mirrors++; },
    resetPageScroll() { pageScrollResets++; },
  });
  vm.runInContext(`${tabs[0]}\n${activate[0]}\n${bind[0]}\nbindSettingsSubTabs();`, context);
  h.get("settingsTabAbout").click();
  assert.equal(h.get("settingsPanelAbout").hidden, false);
  assert.equal(h.get("settingsPanelTheme").hidden, true);
  assert.equal(h.get("settingsPanelGeneral").hidden, true);
  assert.equal(h.get("settingsTabAbout").getAttribute("aria-selected"), "true");
  assert.equal(enters, 1); assert.equal(mirrors, 0);
  assert.equal(pageScrollResets, 1, "switching to About returns the page to the top");
  h.get("settingsTabAbout").click(); assert.equal(enters, 1); assert.equal(pageScrollResets, 1);
  h.get("settingsTabTheme").click(); assert.equal(leaves, 1); assert.equal(mirrors, 1); assert.equal(pageScrollResets, 2);
  const event = { key: "ArrowRight", preventDefault() {} };
  h.get("settingsTabTheme").onkeydown(event);
  assert.equal(h.get("settingsTabAbout").focused, true);
  assert.equal(enters, 2); assert.equal(pageScrollResets, 3);
  h.get("settingsTabGeneral").click();
  assert.equal(h.get("settingsPanelGeneral").hidden, false);
  assert.equal(h.get("settingsPanelAbout").hidden, true);
  assert.equal(pageScrollResets, 4);
  assert.match(source, /if \(settings\) viewReady = enterSettingsView\(\); else leaveSettingsView\(\);/);
});

// ── 本地环境卡：安装/更新动作位 ───────────────────────

const actionButtons = (row) => descendants(row, (node) => node.tagName === "button" && node.className.includes("about-client-action"));
const actionButton = (h, id) => actionButtons(h.row(id))[0];
const flush = async () => { for (let index = 0; index < 6; index += 1) await tick(); };
const doneRun = (runId, clientId, extra = {}) => ({
  ok: true, runId, clientId, action: extra.action ?? "update", state: "done",
  startedAt: "2026-09-18T08:00:00Z", finishedAt: "2026-09-18T08:00:10Z",
  outcome: "updated", message: "已更新到 1.1.0", beforeVersion: "1.0.0", afterVersion: "1.1.0",
  latestVersion: "1.1.0", comparison: "current", ...extra,
});

test("本地环境卡为可更新客户端出更新按钮，桌面应用只留官方入口", async () => {
  const h = harness(normal);
  await h.controller.enter();
  assert.match(actionButton(h, "claude").textContent, /更新到 1\.1\.0/);
  assert.equal(actionButton(h, "zcode"), undefined, "桌面应用不经面板更新");
  assert.equal(actionButton(h, "qoder"), undefined);
  assert.equal(h.get("aboutUpdateAll").disabled, false);
  assert.match(h.get("aboutUpdateAll").textContent, /全部更新 \(6\)/);
});

test("已是最新的客户端不出动作按钮，未安装的出安装按钮", async () => {
  const local = environment();
  local.clients[0].installations[0].status = "not_found";
  local.clients[0].installations[0].version = null;
  const h = harness((path) => {
    if (path.includes("/latest/claude")) return latest("1.1.0", "current");
    if (path === "/api/environment" || path.startsWith("/api/environment?")) return local;
    return normal(path);
  });
  await h.controller.enter();
  assert.equal(actionButton(h, "claude").textContent, "安装");
  assert.match(actionButton(h, "codex").textContent, /更新到/);
});

test("目标客户端正在运行时先确认：取消不动手，确认后才发请求", async () => {
  const running = { agents: [{ id: "claude", status: "running" }] };
  const h = harness(
    (path) => {
      if (path === "/api/agents") return running;
      if (path.startsWith("/api/environment/update/")) return doneRun("run-c", "claude");
      return normal(path);
    },
    { respondPost: () => ({ ok: true, runId: "run-c" }) },
  );
  await h.controller.enter();
  const first = actionButton(h, "claude").click();
  await flush();
  assert.ok(h.get("clientUpdateModal").className.includes("show"), "弹层已出现");
  assert.match(h.get("clientUpdateModalTitle").textContent, /正在运行/);
  assert.match(h.get("clientUpdateModalBody").textContent, /claude/);
  assert.equal(h.mutations.length, 0, "未确认前不发更新请求");
  h.get("clientUpdateModalCancel").click();
  await first;
  assert.equal(h.mutations.length, 0, "取消不动手");
  assert.equal(h.get("clientUpdateModal").className.includes("show"), false);

  const second = actionButton(h, "claude").click();
  await flush();
  h.get("clientUpdateModalConfirm").click();
  await second;
  assert.equal(h.mutations.length, 1);
  assert.equal(h.mutations[0].path, "/api/environment/update");
  assert.equal(h.mutations[0].body.id, "claude");
  assert.equal(h.mutations[0].body.action, "update");
  assert.match(h.toasts.map((toast) => toast.message).join("\n"), /claude 已更新到 1\.1\.0/);
  assert.ok(h.calls.includes("/api/environment?refresh=1"), "完成后重新检测本地环境");
});

test("安装动作走 install，完成后重新检测", async () => {
  const local = environment();
  local.clients[0].installations[0].status = "not_found";
  local.clients[0].installations[0].version = null;
  const h = harness(
    (path) => {
      if (path.startsWith("/api/environment/update/")) return doneRun("run-i", "claude", { action: "install", message: "已更新到 1.0.0" });
      if (path === "/api/environment" || path.startsWith("/api/environment?")) return local;
      return normal(path);
    },
    { respondPost: () => ({ ok: true, runId: "run-i" }) },
  );
  await h.controller.enter();
  await actionButton(h, "claude").click();
  assert.equal(h.mutations.length, 1);
  assert.equal(h.mutations[0].path, "/api/environment/update");
  assert.deepEqual([h.mutations[0].body.id, h.mutations[0].body.action], ["claude", "install"]);
  assert.ok(h.calls.includes("/api/environment?refresh=1"));
});

test("批量更新串行执行、单飞期间他行按钮禁用、收尾汇总并重新检测", async () => {
  const pending = new Map();
  const posts = [];
  let seq = 0;
  const h = harness(
    (path) => {
      if (path === "/api/agents") return { agents: [] };
      if (path.includes("/latest/claude")) return latest("1.1.0");
      if (path.includes("/latest/codex")) return latest("1.2.0");
      if (path.includes("/latest/")) return latest("1.0.0", "current");
      if (path.startsWith("/api/environment/update/")) {
        const runId = path.slice("/api/environment/update/".length);
        return new Promise((resolve) => pending.set(runId, resolve));
      }
      return normal(path);
    },
    { respondPost: ({ body }) => { posts.push(body); return { ok: true, runId: `run-${++seq}` }; } },
  );
  await h.controller.enter();
  assert.match(h.get("aboutUpdateAll").textContent, /全部更新 \(2\)/);
  const batch = h.get("aboutUpdateAll").click();
  await flush();
  assert.deepEqual(posts.map((post) => post.id), ["claude"], "一次只发一个，服务器单飞");
  assert.equal(actionButton(h, "codex").disabled, true, "单飞期间其他行的动作按钮留形但禁用");
  pending.get("run-1")(doneRun("run-1", "claude"));
  await flush();
  assert.deepEqual(posts.map((post) => post.id), ["claude", "codex"]);
  pending.get("run-2")(doneRun("run-2", "codex", { message: "已更新到 1.2.0" }));
  await batch;
  assert.match(h.toasts.map((toast) => toast.message).join("\n"), /批量更新完成：2 个客户端已更新/);
  assert.ok(h.calls.includes("/api/environment?refresh=1"));
  assert.equal(h.get("aboutUpdateAll").disabled, false);
});

test("更新失败与未生效分别提示，失败带出错误末行", async () => {
  const cases = [
    { run: doneRun("run-f", "kimi", { outcome: "failed", message: "更新命令执行失败，请稍后重试", detail: "npm error code EACCES\nnpm error path C:\\npm" }), expect: /npm error code EACCES/ },
    { run: doneRun("run-f", "kimi", { outcome: "unchanged", message: "更新已完成，但本地版本未变化，可能仍有旧版本在生效", comparison: "update_available" }), expect: /本地版本未变化/ },
    { run: doneRun("run-f", "kimi", { outcome: "installed_not_runnable", message: "已安装但无法运行，请先检查运行环境（如 Node 版本）" }), expect: /运行环境/ },
  ];
  for (const { run, expect } of cases) {
    const h = harness(
      (path) => (path.startsWith("/api/environment/update/") ? run : normal(path)),
      { respondPost: () => ({ ok: true, runId: "run-f" }) },
    );
    await h.controller.enter();
    await actionButton(h, "kimi").click();
    const text = h.toasts.map((toast) => toast.message).join("\n");
    assert.match(text, expect);
    assert.ok(h.toasts.every((toast) => toast.isErr), "这三类结果都要用户注意，不走普通成功提示");
    assert.equal(actionButton(h, "kimi").disabled, false, "失败后按钮恢复可点");
  }
});

test("更新请求被单飞锁拒绝时给出提示，不假装在跑", async () => {
  const h = harness(normal, {
    respondPost: () => { throw Object.assign(new Error("HTTP 409：busy"), { code: "busy" }); },
  });
  await h.controller.enter();
  await actionButton(h, "claude").click();
  assert.match(h.toasts.map((toast) => toast.message).join("\n"), /已有更新任务在进行中/);
  assert.equal(h.toasts[0].isErr, true);
  assert.equal(actionButton(h, "claude").disabled, false);
});

test("关于页新增的更新入口与确认弹层都在 DOM 里，弹层按钮文案面向用户", () => {
  assert.match(html, /id="aboutUpdateAll"[^>]*>全部更新<\/button>/);
  assert.match(html, /id="clientUpdateModal"/);
  assert.match(html, /id="clientUpdateModalConfirm">仍要更新<\/button>/);
  assert.match(html, /id="clientUpdateModalCancel">取消<\/button>/);
  assert.doesNotMatch(html, /npm i -g|npm install --global/, "界面不展示实现层命令");
});
