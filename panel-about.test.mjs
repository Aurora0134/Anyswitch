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
// 与生产 CLIENT_ENTRY_FORMS 同形的端点入口形态枚举（数据下发，徽标按它「/」连写）
const ENTRY_FORMS = {
  claude: ["CLI", "Desktop"], codex: ["CLI", "Desktop"], opencode: ["CLI"], pi: ["CLI"],
  kimi: ["CLI", "Desktop", "Web"], dsh: ["CLI", "Desktop"], zcode: ["Desktop", "CLI"], qoder: ["CLI", "Desktop"], grok: ["CLI"],
};
function environment() {
  return {
    platform: "win32", nodeVersion: "v24.13.0", checkedAt: "2026-09-18T08:00:00Z",
    clients: ids.map((id) => ({
      id, name: id, entryForms: ENTRY_FORMS[id],
      // 与生产同形：qoder / codex / dsh / claude / kimi 一张卡两条以上安装记录。qoder index 0
      // 是 qodercli.exe 原生 CLI、remoteId qoder-cli，index 1 是桌面 IDE、remoteId qoder；
      // codex index 0 是 npm CLI、index 1 是 Store 桌面端、remoteId codex-desktop；dsh
      // index 0 是 npm 全局 CLI（本体 harness）、index 1 是官方桌面端、remoteId
      // dsh-desktop、index 2 是社区插件 dsh-tui（remoteId dsh-tui）；claude 与
      // kimi 同 dsh 前两条顺序，桌面端各走 claude-desktop / kimi-desktop 远端。
      // 九个客户端都有官方版本源，逐安装记录发起查询，主行只呈现每端点一行。
      installations: id === "qoder"
        ? [
          { kind: "cli", remoteId: "qoder-cli", status: "found", path: "C:\\Apps\\qoder\\qodercli.exe", version: "1.0.0", versionSource: "cli --version", issue: null },
          { kind: "desktop", remoteId: "qoder", status: "found", path: "C:\\Apps\\qoder\\desktop", version: "2.0.0", versionSource: "app.asar/package.json", issue: null },
        ]
        : id === "codex"
          ? [
            { kind: "cli", remoteId: "codex", status: "found", path: "C:\\Apps\\codex\\cli", version: "1.0.0", versionSource: "package.json", issue: null },
            { kind: "desktop", remoteId: "codex-desktop", status: "found", path: "C:\\Apps\\codex\\desktop", version: "26.915.4065", versionSource: "appx manifest", issue: null },
          ]
          : id === "dsh"
            ? [
              { kind: "cli", remoteId: "dsh", status: "found", path: "C:\\Apps\\dsh\\cli", version: "1.0.0", versionSource: "package.json", issue: null },
              { kind: "desktop", remoteId: "dsh-desktop", status: "found", path: "C:\\Apps\\dsh\\desktop", version: "3.0.0", versionSource: "app.asar/package.json", issue: null },
              // 社区插件：用户实际进的终端界面，主行 CLI 段与详情区 CLI 组都跟着它走
              { kind: "tui", remoteId: "dsh-tui", status: "found", path: "C:\\Apps\\dsh\\tui\\bin\\dsh-tui.js", version: "0.15.0", versionSource: "package.json", issue: null },
            ]
            : id === "claude"
              ? [
                { kind: "cli", remoteId: "claude", status: "found", path: "C:\\Apps\\claude\\cli", version: "1.0.0", versionSource: "package.json", issue: null },
                { kind: "desktop", remoteId: "claude-desktop", status: "found", path: "C:\\Apps\\claude\\desktop", version: "2.9939.2", versionSource: "appx manifest", issue: null },
              ]
              : id === "kimi"
                ? [
                  { kind: "cli", remoteId: "kimi", status: "found", path: "C:\\Apps\\kimi\\cli", version: "1.0.0", versionSource: "package.json", issue: null },
                  { kind: "desktop", remoteId: "kimi-desktop", status: "found", path: "C:\\Apps\\kimi\\desktop", version: "1.0.4", versionSource: "app.asar/package.json", issue: null },
                ]
        : id === "zcode"
          ? [
            // 与生产同形：zcode 桌面主形态守 index 0，CLI 行 remoteId 为空（显式配置制，无官方源）
            { kind: "desktop", remoteId: "zcode", status: "found", path: "C:\\Apps\\zcode\\desktop", version: "2.0.0", versionSource: "package-json", issue: null },
            { kind: "cli", remoteId: null, status: "found", path: "C:\\Apps\\zcode\\cli", version: "1.0.0", versionSource: "package-json", issue: null },
          ]
          : ["cli"].map((kind) => ({
            kind, remoteId: id,
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
    addEventListener: () => {},
    // 换装事件捕获：pollSelfUpdate 见到换装信号会 dispatchEvent 到 doc 上。
    dispatchEvent: (event) => { if (event?.type === "anyswitch:self-update-swap") swaps.push(event); return true; },
  };
  const calls = [];
  const mutations = [];
  const toasts = [];
  const swaps = [];
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
  // localStorage 存档（逐 harness 独立的 mock）：vm 沙箱里没有全局 localStorage，
  // 不一致提示行的「不再显示」按状态指纹读写它，测试据此断言静默与复现。
  const storage = new Map();
  const localStorage = {
    getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
    setItem: (key, value) => { storage.set(String(key), String(value)); },
    removeItem: (key) => { storage.delete(String(key)); },
  };
  const factory = vm.runInNewContext(`(${match[0]})`, {
    URL, URLSearchParams, setTimeout, clearTimeout, localStorage,
    // 自更新流程会触到换装事件与「本页是否换装产物」判定：给最小桩。
    window: {},
    CustomEvent: class { constructor(type) { this.type = type; } },
  });
  const controller = factory({ request, doc, notify: options.notify ?? ((message, isErr) => { toasts.push({ message, isErr }); }), schedule, cancelSchedule });
  return { nodes, doc, calls, mutations, toasts, swaps, flushJobs, controller, storage, get: (id) => nodes.get(id), row: (id) => nodes.get("aboutClients").children.find((node) => node.dataset.clientId === id) };
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
  const qoderLines = descendants(h.row("qoder"), (node) => node.className === "about-version-line");
  assert.equal(qoderLines.length, 1, "qoder 双形态归并为每端点一行");
  assert.equal(descendants(qoderLines[0], (node) => node.className === "about-kind")[0].textContent, "CLI/Desktop", "徽标读 entryForms「/」连写");
  assert.match(qoderLines[0].textContent, /本地 1\.0\.0/);
  assert.doesNotMatch(qoderLines[0].textContent, /2\.0\.0/, "桌面形态版本不在主行呈现");
  assert.equal(descendants(h.row("kimi"), (node) => node.className === "about-kind")[0].textContent, "CLI/Desktop/Web");
  assert.equal(descendants(h.row("pi"), (node) => node.className === "about-kind")[0].textContent, "CLI");
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
  for (const [state, copy] of [["current", /当前已是最新/], ["no_releases", /暂无发布/], ["unknown_version", /无法比较/], ["error", /暂时无法检查/]]) {
    update = deferred();
    const checkingAgain = h.get("aboutCheckUpdates").click();
    update.resolve({ state, checkedAt: "2026-09-18T09:01:00Z", release: null, track: "stable", drift: null });
    await checkingAgain;
    assert.match(h.get("aboutUpdateStatus").textContent, copy);
    assert.equal(h.get("aboutCheckUpdates").disabled, false);
    assert.equal(h.get("aboutReleaseLink").hidden, true);
    assert.equal(h.get("aboutDriftRow").hidden, true, "非不一致状态不出提示行");
  }
  // ahead 属「本地与官方发布不一致」家族：状态行只交代检查过（已检查更新），
  // 事实在下方的不一致提示行；「不再显示」在行尾。
  update = deferred();
  const checkingAhead = h.get("aboutCheckUpdates").click();
  update.resolve({
    state: "ahead", checkedAt: "2026-09-18T09:01:00Z",
    release: { version: "0.5.0", prerelease: false, url: "https://github.com/Aurora0134/Anyswitch/releases/tag/v0.5.0" },
    track: "stable", drift: { ahead: true, offTag: false, localVersion: "0.5.1", remoteVersion: "0.5.0", localCommit: null },
  });
  await checkingAhead;
  assert.match(h.get("aboutUpdateStatus").textContent, /已检查更新/);
  assert.equal(h.get("aboutDriftRow").hidden, false);
  assert.match(h.get("aboutDriftNotice").textContent, /当前版本 0\.5\.1 领先于官方最新 0\.5\.0/);
  assert.equal(h.get("aboutDriftDismiss").hidden, false);
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
  assert.equal(h.calls.filter((path) => path.includes("/latest/")).length, 15, "九个客户端都有官方版本源，各安装记录各查一次（qoder / codex / claude / kimi 各两条渠道，dsh 三条）");
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
  assert.equal(h.calls.filter((path) => path.includes("/latest/")).length, 15, "九个客户端都有官方版本源，各安装记录各查一次（qoder / codex / claude / kimi 各两条渠道，dsh 三条）");
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

test("DSH 详情区不单列本体 harness：官方仓库链接不出现，CLI 来源只指社区插件", async () => {
  const h = harness((path) => {
    if (path.includes("/latest/dsh-tui")) return { ...latest("0.15.0", "current"), url: "https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui" };
    if (path.includes("/latest/dsh")) return { ...latest(), url: "https://github.com/deepseek-ai/deepseek-harness/releases" };
    return normal(path);
  });
  await h.controller.enter();
  const row = h.row("dsh");
  const links = descendants(row, (node) => node.tagName === "a");
  assert.deepEqual(links.map((node) => node.href), ["https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui"], "CLI 来源只指社区插件的 npm 包页");
  assert.doesNotMatch(row.textContent, /C:\\Apps\\dsh\\cli/, "本体 harness 的路径不再单列");
  assert.doesNotMatch(row.textContent, /官方来源/, "详情区不再有官方来源这一行");
});

test("DSH 双组件并段：CLI 段摆社区插件版本、最新格前缀「最新」、结论跟插件比对", async () => {
  // 形态模型：dsh 的 CLI 入口是社区插件 dsh-tui（内核是官方 harness，官方没有
  // CLI 入口产品），CLI 与 TUI 是同一个终端形态。主行 CLI 段与详情区 CLI 组都
  // 跟着插件走，本体 harness 不单列；dsh 行的前缀是「最新」而不是「官方最新」。
  const h = harness((path) => {
    if (path.includes("/latest/dsh-tui")) {
      return { ...latest("0.16.1", "update_available"), url: "https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui" };
    }
    if (path.includes("/latest/dsh-desktop")) {
      return { ...latest("0.2.1-rc.2", "current"), url: "https://harness.deepseek.com" };
    }
    if (path.includes("/latest/dsh")) {
      return { ...latest("0.1.7-rc.2", "current"), url: "https://github.com/deepseek-ai/deepseek-harness/releases" };
    }
    return normal(path);
  });
  await h.controller.enter();
  const row = h.row("dsh");
  const lines = descendants(row, (node) => node.className === "about-version-line");
  assert.equal(lines.length, 1, "dsh 仍是每端点一行");
  const text = lines[0].textContent;
  assert.equal(descendants(lines[0], (node) => node.className === "about-kind")[0].textContent, "CLI/Desktop", "徽标不再带 Web");
  assert.match(text, /本地 CLI 0\.15\.0 · Desktop 3\.0\.0/, "CLI 段是插件版本、Desktop 段是桌面端版本");
  assert.doesNotMatch(text, /1\.0\.0/, "本体 harness 的版本不上主行");
  assert.match(text, /最新 CLI 0\.16\.1 · Desktop 0\.2\.1-rc\.2/, "前缀只说「最新」，不带「官方」");
  assert.doesNotMatch(text, /官方最新/);
  assert.match(text, /有新版本/, "结论跟社区插件的比对走");
  assert.ok(h.calls.includes("/api/environment/latest/dsh-tui?localVersion=0.15.0"), "插件按自己的远端 id 查最新");
  // 详情区：CLI 组就是社区插件（路径/版本来源/上游来源/查询时间 + 一句说明），
  // 桌面组原样跟在后面；本体 harness 不单列。
  assert.match(row.textContent, /CLI 路径C:\\Apps\\dsh\\tui\\bin\\dsh-tui\.js/);
  assert.match(row.textContent, /CLI 版本来源安装包资料/);
  assert.match(row.textContent, /CLI 上游来源/);
  assert.match(row.textContent, /CLI 查询时间/);
  assert.match(row.textContent, /CLI 说明由社区插件提供，内核为官方版本/);
  assert.doesNotMatch(row.textContent, /终端插件/, "终端插件那组文案整组撤掉");
  assert.match(row.textContent, /桌面 路径C:\\Apps\\dsh\\desktop/, "桌面组原样保留");
  const links = descendants(row, (node) => node.tagName === "a");
  assert.deepEqual(links.map((node) => node.textContent), ["查看上游版本"], "只剩插件那一条来源链接");
  assert.equal(links[0].href, "https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui");
});

test("DSH 结论句：插件与最新一致时说「与最新版本一致」，其它端点仍是「与官方最新版本一致」", async () => {
  const h = harness((path) => {
    if (path.includes("/latest/dsh-tui")) return { ...latest("0.15.0", "current"), url: "https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui" };
    if (path.includes("/latest/claude")) return latest("1.0.0", "current");
    if (path.includes("/latest/dsh")) return latest("1.0.0", "current");
    return normal(path);
  });
  await h.controller.enter();
  const dshLine = descendants(h.row("dsh"), (node) => node.className === "about-version-line")[0].textContent;
  assert.match(dshLine, /与最新版本一致/);
  assert.doesNotMatch(dshLine, /与官方最新版本一致/);
  const claudeLine = descendants(h.row("claude"), (node) => node.className === "about-version-line")[0].textContent;
  assert.match(claudeLine, /与官方最新版本一致/, "其它端点的文案不动");
});

test("DSH 社区插件未装：主行 CLI 段不占位，详情区如实报未找到", async () => {
  const local = environment();
  const dsh = local.clients.find((client) => client.id === "dsh");
  dsh.installations[2] = { ...dsh.installations[2], status: "not_found", version: null, path: null, issue: "entry_missing" };
  const h = harness((path) => (path === "/api/environment" ? local : normal(path)));
  await h.controller.enter();
  const line = descendants(h.row("dsh"), (node) => node.className === "about-version-line")[0];
  assert.match(line.textContent, /本地 Desktop 3\.0\.0/, "插件没装时只剩桌面段");
  assert.doesNotMatch(line.textContent, /未找到/, "not_found 不占位，与既有惯例一致");
  assert.doesNotMatch(line.textContent, /CLI 0\.15\.0/);
  assert.match(h.row("dsh").textContent, /CLI 路径未找到/, "详情区仍如实报未找到");
});

test("DSH 只有社区插件过期时端点级按钮也要出现", async () => {
  const h = harness((path) => {
    if (path.includes("/latest/dsh-tui")) return { ...latest("0.16.1", "update_available"), url: "https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui" };
    if (path.includes("/latest/dsh-desktop")) return latest("3.0.0", "current");
    if (path.includes("/latest/dsh")) return latest("1.0.0", "current");
    return normal(path);
  });
  await h.controller.enter();
  const line = descendants(h.row("dsh"), (node) => node.className === "about-version-line")[0];
  const actions = descendants(line, (node) => node.tagName === "button" && node.className.includes("about-client-action"));
  assert.equal(actions.length, 1, "端点级一颗");
  assert.equal(actions[0].textContent, "更新");
  // 计数要带数字断言：count 归零时文案同样是无计数的「全部更新」，裸 /全部更新/ 不随计数变化
  assert.match(h.get("aboutUpdateAll").textContent, /全部更新 \(8\)/, "批量入口照常计数：插件渠道让 dsh 计入端点数，与全量场景同为 8");
});

test("DSH 社区插件未装且本体未装时不代装插件", async () => {
  const local = environment();
  const dsh = local.clients.find((client) => client.id === "dsh");
  dsh.installations[0] = { ...dsh.installations[0], status: "not_found", version: null, path: null, issue: "entry_missing" };
  dsh.installations[2] = { ...dsh.installations[2], status: "not_found", version: null, path: null, issue: "entry_missing" };
  const h = harness((path) => (path === "/api/environment" ? local : normal(path)));
  await h.controller.enter();
  const line = descendants(h.row("dsh"), (node) => node.className === "about-version-line")[0];
  const actions = descendants(line, (node) => node.tagName === "button" && node.className.includes("about-client-action"));
  assert.equal(actions.length, 1, "安装按钮仍由本体那条决定");
  assert.equal(actions[0].textContent, "安装");
});

test("Codex 双形态归并为一行：徽标 CLI/Desktop、本地与官方格双版本并排带形态小注、端点级一个更新按钮", async () => {
  const h = harness((path) => {
    if (path.includes("/latest/codex-desktop")) return { ...latest("26.915.4066"), url: "https://apps.microsoft.com/detail/9PLM9XGG6VKS" };
    return normal(path);
  });
  await h.controller.enter();
  const row = h.row("codex");
  assert.equal(h.get("aboutClients").children.length, 9, "桌面安装项不额外开卡");
  const lines = descendants(row, (node) => node.className === "about-version-line");
  assert.equal(lines.length, 1, "codex 两形态归并为每端点一行");
  assert.equal(descendants(lines[0], (node) => node.className === "about-kind")[0].textContent, "CLI/Desktop");
  assert.match(lines[0].textContent, /本地 CLI 1\.0\.0 · Desktop 26\.915\.4065/);
  assert.match(lines[0].textContent, /官方最新 CLI 1\.1\.0 · Desktop 26\.915\.4066/);
  const actions = descendants(lines[0], (node) => node.tagName === "button" && node.className.includes("about-client-action"));
  assert.equal(actions.length, 1, "端点级一个动作位");
  assert.equal(actions[0].textContent, "更新");
  assert.ok(h.calls.includes("/api/environment/latest/codex-desktop?localVersion=26.915.4065"), "桌面渠道的官方版本照常按 codex-desktop 远端 id 查询");
  assert.match(row.textContent, /桌面 路径C:\\Apps\\codex\\desktop/, "桌面形态的路径在详情区逐形态补行");
  assert.match(h.get("aboutUpdateAll").textContent, /全部更新 \(8\)/, "批量更新按端点计一次，qoder 同此");
});

test("Codex 桌面渠道的官方来源链接放行 Microsoft Store，仿冒域名被丢弃", async () => {
  const dual = (desktopUrl) => harness((path) => {
    if (path.includes("/latest/codex-desktop")) return { ...latest("26.915.4066"), url: desktopUrl };
    if (path.includes("/latest/codex?")) return { ...latest("1.1.0"), url: "https://github.com/openai/codex" };
    return normal(path);
  });
  const allowed = dual("https://apps.microsoft.com/detail/9PLM9XGG6VKS");
  await allowed.controller.enter();
  const links = descendants(allowed.row("codex"), (node) => node.tagName === "a");
  assert.equal(links.length, 2, "详情区逐形态各留一条官方来源链接");
  const store = links.find((node) => node.href === "https://apps.microsoft.com/detail/9PLM9XGG6VKS");
  assert.ok(store, "桌面形态的查看官方版本链接指向 Microsoft Store");
  assert.equal(store.textContent, "查看官方版本");
  assert.ok(links.every((node) => node.rel === "noopener noreferrer" && node.target === "_blank"));
  const rejected = dual("https://apps.microsoft.com.evil.test/detail/9PLM9XGG6VKS");
  await rejected.controller.enter();
  const survivors = descendants(rejected.row("codex"), (node) => node.tagName === "a");
  assert.equal(survivors.length, 1, "仿冒域名被丢弃，只留 CLI 形态的链接");
  assert.equal(survivors[0].href, "https://github.com/openai/codex");
  const lines = descendants(rejected.row("codex"), (node) => node.className === "about-version-line");
  assert.equal(lines.length, 1);
  assert.match(lines[0].textContent, /官方最新 CLI 1\.1\.0 · Desktop 26\.915\.4066/, "只是不放链接，官方版本照常展示");
});

test("Claude 与 Kimi 桌面形态在详情区补行，官方来源各归各源", async () => {
  const h = harness((path) => {
    if (path.includes("/latest/claude-desktop")) return { ...latest(), version: null, comparison: "unknown", url: "https://claude.ai/download" };
    if (path.includes("/latest/kimi-desktop")) return { ...latest("1.0.5", "update_available"), url: "https://github.com/MoonshotAI/kimi-code-app" };
    return normal(path);
  });
  await h.controller.enter();
  assert.ok(h.calls.includes("/api/environment/latest/claude-desktop?localVersion=2.9939.2"), "claude 桌面形态按自己的远端 id 查询");
  assert.ok(h.calls.includes("/api/environment/latest/kimi-desktop?localVersion=1.0.4"), "kimi 桌面形态按自己的远端 id 查询");
  const claudeRow = h.row("claude");
  assert.match(claudeRow.textContent, /桌面 路径C:\\Apps\\claude\\desktop/, "claude 桌面形态的路径在详情区逐形态补行");
  assert.ok(descendants(claudeRow, (node) => node.tagName === "a").some((node) => node.href === "https://claude.ai/download"),
    "claude 桌面端官方来源指向官方下载页");
  const kimiRow = h.row("kimi");
  assert.match(kimiRow.textContent, /桌面 路径C:\\Apps\\kimi\\desktop/);
  assert.ok(descendants(kimiRow, (node) => node.tagName === "a").some((node) => node.href === "https://github.com/MoonshotAI/kimi-code-app"),
    "kimi 桌面端官方来源指向官方仓库");
});

test("Claude 桌面端官方来源只放行官方下载页域名", async () => {
  const h = harness((path) => (path.includes("/latest/claude-desktop")
    ? { ...latest(), version: null, comparison: "unknown", url: "https://claude.ai.evil.test/download" }
    : normal(path)));
  await h.controller.enter();
  const links = descendants(h.row("claude"), (node) => node.tagName === "a").map((node) => node.href);
  assert.deepEqual(links, ["https://www.npmjs.com/package/@anthropic-ai/claude-code"], "仿冒域名被丢弃，只留 CLI 形态的链接");
});

test("Grok Build 行按 npm 官方版本比对，链接只放行 npm 包页", async () => {
  const grokRow = (url) => harness((path) => (path.includes("/latest/grok?") ? { ...latest("1.0.41"), url } : normal(path)));
  const allowed = grokRow("https://www.npmjs.com/package/@xai-official/grok");
  await allowed.controller.enter();
  assert.ok(allowed.calls.includes("/api/environment/latest/grok?localVersion=1.0.0"), "grok 用自己的远端 id 查官方最新");
  const lines = descendants(allowed.row("grok"), (node) => node.className === "about-version-line");
  assert.equal(lines.length, 1);
  assert.match(lines[0].textContent, /本地.*1\.0\.0.*官方最新.*1\.0\.41.*有新版本/);
  const actions = descendants(lines[0], (node) => node.tagName === "button" && node.className.includes("about-client-action"));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].textContent, "更新");
  assert.deepEqual(descendants(allowed.row("grok"), (node) => node.tagName === "a").map((node) => node.href),
    ["https://www.npmjs.com/package/@xai-official/grok"]);

  const rejected = grokRow("https://npmjs.com.evil.test/package/@xai-official/grok");
  await rejected.controller.enter();
  assert.equal(descendants(rejected.row("grok"), (node) => node.tagName === "a").length, 0, "仿冒域名的链接被丢弃，版本比对照常");
  assert.match(descendants(rejected.row("grok"), (node) => node.className === "about-version-line")[0].textContent, /官方最新.*1\.0\.41/);
});

test("Qoder CLI 形态的官方来源链接放行 npm 包页，仿冒域名被丢弃", async () => {
  const qoderRow = (url) => harness((path) => (path.includes("/latest/qoder-cli") ? { ...latest("1.1.64"), url } : normal(path)));
  const allowed = qoderRow("https://www.npmjs.com/package/@qoder-ai/qodercli");
  await allowed.controller.enter();
  assert.deepEqual(descendants(allowed.row("qoder"), (node) => node.tagName === "a").map((node) => node.href),
    ["https://www.npmjs.com/package/@qoder-ai/qodercli"]);

  const rejected = qoderRow("https://npmjs.com.evil.test/package/@qoder-ai/qodercli");
  await rejected.controller.enter();
  assert.equal(descendants(rejected.row("qoder"), (node) => node.tagName === "a").length, 0, "仿冒域名的链接被丢弃，版本比对照常");
  assert.match(descendants(rejected.row("qoder"), (node) => node.className === "about-version-line")[0].textContent, /官方最新.*1\.1\.64/);
});

test("关于页头部提供产品图标与常驻 GitHub、发布说明入口", () => {
  assert.match(html, /<img class="about-app-icon" src="\/panel\/assets\/logo\.png" alt="">/);
  assert.match(html, /href="https:\/\/github\.com\/Aurora0134\/Anyswitch"[^>]*>GitHub<\/a>/);
  assert.match(html, /href="https:\/\/github\.com\/Aurora0134\/Anyswitch\/releases"[^>]*>发布说明<\/a>/);
});

test("settings has explicit third tab mapping and leaving About runs its lifecycle without taking a theme snapshot", () => {
  const h = harness();
  const tabs = source.match(/    const settingsSubTabs = \{[\s\S]*?\n    \};/);
  const dirItems = source.match(/    const settingsDirItems = \{[\s\S]*?\n    \};/);
  const activate = source.match(/    function activateSettingsSubTab\(which, animate\) \{[\s\S]*?\n    \}/);
  const bind = source.match(/    function bindSettingsSubTabs\(\) \{[\s\S]*?\n    \}/);
  assert.ok(tabs && dirItems && activate && bind);
  let enters = 0, leaves = 0, mirrors = 0, pageScrollResets = 0, bundleEnters = 0, bundleLeaves = 0;
  let backupEnters = 0, backupLeaves = 0;
  const context = vm.createContext({
    $: h.get, about: { enter() { enters++; }, leave() { leaves++; } },
    // 数据搬迁卡与 About 同待遇：切走 / 切回都要走它的生命周期钩子，否则
    // 「导出成功」那类一次性结果会一直挂在屏上（离开时复位正是靠这个钩子）。
    dataBundle: { enter() { bundleEnters++; }, leave() { bundleLeaves++; } },
    // 备份位置卡同一套子页生命周期：进子页现读路径，切走复位。
    backupLocation: { enter() { backupEnters++; }, leave() { backupLeaves++; } },
    replayViewEnter() {}, captureSettingsMirror() { mirrors++; },
    resetPageScroll() { pageScrollResets++; },
    // 「通用」子页会拉 store state 生成档位映射下拉的选项（与「自动路由」同源），
    // 本测试只验 About 生命周期，给一条已落地的 Promise 即可。
    refreshStoreState: () => Promise.resolve(), renderClaudeTierOptions() {},
  });
  vm.runInContext(`${tabs[0]}\n${dirItems[0]}\n${activate[0]}\n${bind[0]}\nbindSettingsSubTabs();`, context);
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
  // 主视图切换必须把 settings 视图生命周期接上：进入调 enterSettingsView、离开调
  // leaveSettingsView（后者是 About 与数据搬迁卡离开钩子的总闸，else 半句全套件仅
  // 此处覆盖）。只验接线存在，不钉整行写法——加花括号、换行、抽成函数都不该误报；
  // switchView 内部的时序（hidden 先落定、再进钩子）由 panel.test.mjs 钉。
  assert.match(source, /enterSettingsView\(\)/, "主视图切换接通 settings 进入钩子");
  assert.match(source, /leaveSettingsView\(\)/, "主视图切换接通 settings 离开钩子");
  // 数据搬迁卡：每次切到「非高级选项」的子页都要让它离开（结果文案据此复位），
  // 切回高级选项才进入。此前它声明的复位钩子零调用点，等于没有生命周期。
  assert.equal(bundleLeaves, 4, "此前每次切走非高级选项子页都已让它离开");
  assert.equal(bundleEnters, 0, "还没进过高级选项");
  assert.equal(backupLeaves, 4, "备份位置卡与数据搬迁卡同走子页生命周期");
  assert.equal(backupEnters, 0, "还没进过高级选项");
  h.get("settingsTabAdvanced").click();
  assert.equal(bundleEnters, 1, "切到高级选项要进入数据搬迁卡");
  assert.equal(bundleLeaves, 4, "切进高级选项本身不算离开");
  assert.equal(backupEnters, 1, "切到高级选项要进入备份位置卡");
  assert.equal(backupLeaves, 4, "切进高级选项本身不算离开");
  h.get("settingsTabGeneral").click();
  assert.equal(bundleLeaves, 5, "切走高级选项要让它离开");
  assert.equal(backupLeaves, 5, "切走高级选项也要让备份位置卡离开");
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
// 关于页更新状态的夹具：本地版本与官方版本都可控，更新任务停在轮询里由用例放行，
// 强制重检先挂起——用来断言「运行结束、确认还没落地」这段窗口。
const REMOTE_BASE = (() => {
  const map = new Map();
  for (const client of environment().clients) {
    for (const installation of client.installations) if (installation.remoteId) map.set(installation.remoteId, installation.version);
  }
  return map;
})();
function updateScenario({ versions = {}, latest = {} } = {}) {
  const localVersions = { ...versions };
  const remoteVersions = new Map(REMOTE_BASE);
  for (const [id, version] of Object.entries(latest)) remoteVersions.set(id, version);
  const pendingStatus = new Map();
  const pendingRefresh = [];
  const posts = [];
  const envNow = () => {
    const data = environment();
    for (const [id, version] of Object.entries(localVersions)) {
      const client = data.clients.find((item) => item.id === id);
      if (client?.installations[0]) client.installations[0].version = version;
    }
    return data;
  };
  const respond = (path) => {
    if (path === "/api/app-info") return appInfo;
    if (path === "/api/updates" || path.startsWith("/api/updates?")) return { state: "current" };
    if (path === "/api/settings") return { settings: {} };
    if (path === "/api/environment/updates/active") return { runs: [] };
    if (path === "/api/self-update/active" || path === "/api/self-update/last") return {};
    if (path === "/api/agents") return { agents: [] };
    if (path === "/api/environment" || path.startsWith("/api/environment?")) {
      if (path.includes("refresh=1")) return new Promise((resolve) => pendingRefresh.push(() => resolve(envNow())));
      return envNow();
    }
    if (path.startsWith("/api/environment/update/")) {
      const runId = decodeURIComponent(path.slice("/api/environment/update/".length));
      return new Promise((resolve) => pendingStatus.set(runId, resolve));
    }
    if (path.startsWith("/api/environment/latest/")) {
      const url = new URL("http://x" + path);
      const id = decodeURIComponent(url.pathname.split("/").pop());
      const localVersion = url.searchParams.get("localVersion");
      const remote = remoteVersions.get(id);
      return { state: "ok", version: remote ?? localVersion, comparison: localVersion === remote ? "current" : "update_available" };
    }
    return {};
  };
  const h = harness(respond, { respondPost: ({ body }) => { posts.push(body); return { ok: true, runId: `run-${body.id}` }; } });
  return { h, localVersions, pendingStatus, pendingRefresh, posts };
}
const versionLine = (h, id) => descendants(h.row(id), (node) => node.className === "about-version-line")[0];

test("本地环境卡为可更新客户端出更新按钮，桌面应用只留官方入口", async () => {
  const h = harness(normal);
  await h.controller.enter();
  assert.equal(actionButton(h, "claude").textContent, "更新", "按钮文案端点级一个「更新」");
  assert.equal(actionButton(h, "grok").textContent, "更新", "Grok Build 走自身升级命令，按钮与 npm 客户端同位");
  assert.equal(actionButton(h, "zcode"), undefined, "桌面应用不经面板更新");
  // qoder 一张卡一个动作位：更新接口按端点 id 受理，服务端串行跑全腿
  const qoderLines = descendants(h.row("qoder"), (node) => node.className === "about-version-line");
  assert.equal(qoderLines.length, 1);
  assert.equal(actionButtons(qoderLines[0]).length, 1);
  assert.equal(actionButtons(qoderLines[0])[0].textContent, "更新", "Qoder CLI 走自身升级命令，按钮与 grok 同位");
  assert.ok(h.calls.includes("/api/environment/latest/qoder-cli?localVersion=1.0.0"), "主更新形态用 qoder-cli 渠道查官方版本");
  assert.equal(h.get("aboutUpdateAll").disabled, false);
  assert.match(h.get("aboutUpdateAll").textContent, /全部更新 \(8\)/);
});

// 「本地与官方一致 → 不出动作位」不在本用例断言：它由更新确认收尾用例行为性覆盖
// （「批量中先完成的端点立即显示已更新…」「单点更新完成到确认前…」「并行单点更新
// 不共用过期重检…」三处在 comparison 落到 current 后断言 actionButtons(...).length === 0）。
// 本用例只钉安装/更新动作位的出现条件。
test("未安装且可代装的客户端出安装按钮（grok 未安装不代装），可更新的出更新按钮", async () => {
  const local = environment();
  local.clients[0].installations[0].status = "not_found";
  local.clients[0].installations[0].version = null;
  // Grok Build 未安装时不给安装：首装会把用户切进另一种安装形态，面板只代管更新。
  local.clients[8].installations[0].status = "not_found";
  local.clients[8].installations[0].version = null;
  const h = harness((path) => {
    if (path.includes("/latest/claude")) return latest("1.1.0", "current");
    if (path === "/api/environment" || path.startsWith("/api/environment?")) return local;
    return normal(path);
  });
  await h.controller.enter();
  assert.equal(actionButton(h, "claude").textContent, "安装");
  assert.equal(actionButton(h, "codex").textContent, "更新");
  assert.equal(actionButton(h, "grok"), undefined, "未安装的 grok 不给安装按钮");
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

test("批量更新并行派出：一次确认后两个 POST 同时发、批量期间各行动作位禁用、收尾汇总并重新检测", async () => {
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
  // 服务端锁按客户端分，不同客户端互不触碰对方目录，批量一次并发派出全部任务
  assert.deepEqual([...posts.map((post) => post.id)].sort(), ["claude", "codex"], "批量一次性并行派出，不逐行等前一个完成");
  assert.equal(actionButton(h, "claude").disabled, true, "批量进行中动作位禁点，免得同一行被两个任务同时更新");
  assert.equal(actionButton(h, "codex").disabled, true);
  pending.get("run-2")(doneRun("run-2", "codex", { message: "已更新到 1.2.0" }));
  await flush();
  assert.match(h.toasts.map((toast) => toast.message).join("\n"), /codex 已更新到 1\.2\.0/, "先回包的先提示，不等整批");
  assert.match(h.get("aboutUpdateAll").textContent, /批量更新中/);
  pending.get("run-1")(doneRun("run-1", "claude"));
  await batch;
  assert.match(h.toasts.map((toast) => toast.message).join("\n"), /批量更新完成：2 个客户端已更新/);
  assert.ok(h.calls.includes("/api/environment?refresh=1"));
  assert.equal(h.get("aboutUpdateAll").disabled, false);
});

test("单个更新按行独立：一行在更新时其他行照常可点，各自收尾各自提示", async () => {
  const pending = new Map();
  const posts = [];
  let seq = 0;
  const h = harness(
    (path) => {
      if (path === "/api/agents") return { agents: [] };
      if (path.includes("/latest/claude")) return latest("1.1.0");
      if (path.includes("/latest/codex")) return latest("1.2.0");
      if (path.includes("/latest/opencode")) return latest("1.3.0");
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
  // 第一行开工后停在轮询里（服务端任务还没回来）
  const first = actionButton(h, "claude").click();
  await flush();
  assert.deepEqual(posts.map((post) => post.id), ["claude"]);
  assert.equal(actionButton(h, "claude").disabled, true, "本行更新中，自己不可再点");
  assert.match(actionButton(h, "claude").textContent, /更新中/);
  // 关键：别人在跑不挡这一行——旧行为会把这里一起禁掉
  assert.equal(actionButton(h, "codex").disabled, false, "别的客户端在更新不阻塞本行");
  const second = actionButton(h, "codex").click();
  await flush();
  assert.deepEqual(posts.map((post) => post.id), ["claude", "codex"], "两个客户端并发开工");
  assert.equal(actionButton(h, "opencode").disabled, false, "第三个也照常可点");
  pending.get("run-2")(doneRun("run-2", "codex", { message: "已更新到 1.2.0" }));
  await second;
  assert.match(h.toasts.map((toast) => toast.message).join("\n"), /codex 已更新到 1\.2\.0/);
  assert.match(actionButton(h, "claude").textContent, /更新中/, "另一行还在跑，不受影响");
  pending.get("run-1")(doneRun("run-1", "claude"));
  await first;
  assert.match(h.toasts.map((toast) => toast.message).join("\n"), /claude 已更新到 1\.1\.0/);
  assert.equal(actionButton(h, "claude").disabled, false);
});

test("codex 单行卡片：更新中按钮显「更新中…」并禁点，桌面形态不另出动作位", async () => {
  const pending = new Map();
  const h = harness(
    (path) => {
      if (path === "/api/agents") return { agents: [] };
      if (path.includes("/latest/codex-desktop")) return latest("26.915.4065", "current");
      if (path.startsWith("/api/environment/update/")) {
        const runId = path.slice("/api/environment/update/".length);
        return new Promise((resolve) => pending.set(runId, resolve));
      }
      return normal(path);
    },
    { respondPost: () => ({ ok: true, runId: "run-x" }) },
  );
  await h.controller.enter();
  const row = h.row("codex");
  const idleLines = descendants(row, (node) => node.className === "about-version-line");
  assert.equal(idleLines.length, 1, "空闲时每端点一行");
  assert.match(idleLines[0].textContent, /有新版本/);
  assert.equal(descendants(idleLines[0], (node) => node.className === "about-result").length, 1, "结论只看主更新形态一条");
  const first = actionButton(h, "codex").click();
  await flush();
  assert.deepEqual([h.mutations[0]?.body.id, h.mutations[0]?.body.action], ["codex", "update"]);
  const busyLines = descendants(row, (node) => node.className === "about-version-line");
  assert.equal(busyLines.length, 1);
  assert.equal(actionButtons(busyLines[0]).length, 1);
  assert.match(actionButtons(busyLines[0])[0].textContent, /更新中/);
  assert.equal(actionButtons(busyLines[0])[0].disabled, true);
  pending.get("run-x")(doneRun("run-x", "codex"));
  await first;
  assert.match(h.toasts.map((toast) => toast.message).join("\n"), /codex 已更新到 1\.1\.0/);
  const doneLines = descendants(row, (node) => node.className === "about-version-line");
  assert.equal(doneLines.length, 1, "收尾重检后仍每端点一行");
  assert.equal(actionButtons(doneLines[0]).length, 1);
  assert.equal(actionButtons(doneLines[0])[0].textContent, "更新");
});

test("批量中先完成的端点立即显示「已更新」：不再回落暗态更新、顶部给进度、确认期禁点", async () => {
  const { h, localVersions, pendingStatus, pendingRefresh } = updateScenario({ latest: { claude: "1.1.0", codex: "1.2.0" } });
  await h.controller.enter();
  assert.match(h.get("aboutUpdateAll").textContent, /全部更新 \(2\)/);
  const batch = h.get("aboutUpdateAll").click();
  await flush();
  assert.equal(h.get("aboutEnvironmentRefresh").disabled, true, "更新进行中不许重新检测");
  assert.equal(h.get("aboutEnvironmentRefresh").title, "更新任务进行中，结束后会自动重新检测");

  pendingStatus.get("run-claude")(doneRun("run-claude", "claude"));
  await flush();
  localVersions.claude = "1.1.0";
  const claudeLine = versionLine(h, "claude");
  assert.match(claudeLine.textContent, /已更新/, "先完成的行立刻给出结果");
  assert.doesNotMatch(claudeLine.textContent, /有新版本/, "结论位不再挂着更新前的结论");
  assert.match(claudeLine.textContent, /本地 1\.1\.0/, "本地版本先按更新后的版本显示");
  assert.equal(actionButtons(h.row("claude")).length, 0, "已更新待确认的行不再出更新按钮");
  assert.match(h.get("aboutUpdateAll").textContent, /批量更新中… \(1\/2\)/, "顶部件数带进度");
  assert.match(versionLine(h, "codex").textContent, /更新中…/, "没跑完的行照常是更新中");

  pendingStatus.get("run-codex")(doneRun("run-codex", "codex", { message: "已更新到 1.2.0", afterVersion: "1.2.0" }));
  await flush();
  localVersions.codex = "1.2.0";
  assert.equal(h.get("aboutUpdateAll").disabled, true, "确认期间批量入口禁点");
  const before = h.mutations.length;
  h.get("aboutUpdateAll").click();
  await flush();
  assert.equal(h.mutations.length, before, "确认期间点批量入口不会再发起一轮更新");
  assert.equal(actionButtons(h.row("claude")).length, 0);
  assert.equal(actionButtons(h.row("codex")).length, 0);
  assert.ok(pendingRefresh.length >= 1, "批量收尾后补一次重检");
  pendingRefresh.shift()();
  await batch;
  await flush();
  assert.match(versionLine(h, "claude").textContent, /与官方最新版本一致/);
  assert.match(versionLine(h, "codex").textContent, /与官方最新版本一致/);
  assert.equal(actionButtons(h.row("claude")).length, 0);
  assert.equal(h.get("aboutUpdateAll").disabled, true, "已无更新项时批量入口禁用");
});

test("单点更新完成到确认前不露出可点的更新按钮，也不发第二次更新", async () => {
  const { h, localVersions, pendingStatus, pendingRefresh } = updateScenario({ latest: { claude: "1.1.0" } });
  await h.controller.enter();
  const run = actionButton(h, "claude").click();
  await flush();
  pendingStatus.get("run-claude")(doneRun("run-claude", "claude"));
  await flush();
  localVersions.claude = "1.1.0";
  assert.match(versionLine(h, "claude").textContent, /已更新/);
  assert.equal(actionButtons(h.row("claude")).length, 0, "确认前不再出现可点的更新");
  assert.equal(h.get("aboutEnvironmentRefresh").disabled, true, "确认重检进行中，重检钮禁用");
  const before = h.mutations.length;
  pendingRefresh.shift()();
  await run;
  await flush();
  assert.match(versionLine(h, "claude").textContent, /与官方最新版本一致/);
  assert.equal(actionButtons(h.row("claude")).length, 0);
  assert.equal(h.mutations.length, before, "确认前后都没有第二次更新请求");
});

test("并行单点更新不共用过期重检：后完成者保持「已更新」，自动补一轮晚于它的重检", async () => {
  const { h, localVersions, pendingStatus, pendingRefresh } = updateScenario({ latest: { claude: "1.1.0", codex: "1.2.0" } });
  await h.controller.enter();
  const first = actionButton(h, "claude").click();
  await flush();
  const second = actionButton(h, "codex").click();
  await flush();

  pendingStatus.get("run-claude")(doneRun("run-claude", "claude"));
  await flush();
  localVersions.claude = "1.1.0";
  assert.ok(pendingRefresh.length >= 1, "先完成的端点触发了重检");
  // 第二个端点在第一次重检还在飞时完成：结果必须先落在行内
  pendingStatus.get("run-codex")(doneRun("run-codex", "codex", { message: "已更新到 1.2.0", afterVersion: "1.2.0" }));
  await flush();
  assert.match(versionLine(h, "codex").textContent, /已更新/);
  assert.equal(actionButtons(h.row("codex")).length, 0, "结果待确认期间不给更新按钮");

  // 第一次重检扫的是 codex 完成前的环境：落地后应自动再补一轮
  pendingRefresh.shift()();
  await flush();
  assert.ok(pendingRefresh.length >= 1, "发现重检早于结果，自动补一轮");
  assert.equal(actionButtons(h.row("codex")).length, 0, "第二轮落地前依旧不可再点");
  localVersions.codex = "1.2.0";
  pendingRefresh.shift()();
  await first; await second;
  await flush();
  assert.match(versionLine(h, "codex").textContent, /与官方最新版本一致/);
  assert.equal(actionButtons(h.row("codex")).length, 0);
});

test("批量里的失败行保留「更新未完成」并可重试，汇总点名未生效客户端", async () => {
  const { h, localVersions, pendingStatus, pendingRefresh } = updateScenario({ latest: { claude: "1.1.0", codex: "1.2.0" } });
  await h.controller.enter();
  const batch = h.get("aboutUpdateAll").click();
  await flush();
  pendingStatus.get("run-claude")(doneRun("run-claude", "claude"));
  pendingStatus.get("run-codex")(doneRun("run-codex", "codex", { outcome: "failed", message: "更新命令执行失败，请稍后重试" }));
  await flush();
  localVersions.claude = "1.1.0";
  pendingRefresh.shift()();
  await batch;
  await flush();
  assert.match(versionLine(h, "codex").textContent, /更新未完成/);
  assert.doesNotMatch(versionLine(h, "codex").textContent, /有新版本/);
  const retry = actionButton(h, "codex");
  assert.equal(retry.textContent, "重试");
  assert.equal(retry.disabled, false);
  assert.match(h.toasts.map((toast) => toast.message).join("\n"), /批量更新完成：1 个成功，1 个未生效（codex）/);

  const retryRun = retry.click();
  await flush();
  assert.deepEqual(h.mutations.map((mutation) => mutation.body.id).slice(-1), ["codex"], "重试只更新失败的那一行");
  pendingStatus.get("run-codex")(doneRun("run-codex", "codex", { message: "已更新到 1.2.0", afterVersion: "1.2.0" }));
  await flush();
  localVersions.codex = "1.2.0";
  assert.ok(pendingRefresh.length >= 1);
  pendingRefresh.shift()();
  await retryRun;
  await flush();
  assert.match(versionLine(h, "codex").textContent, /与官方最新版本一致/);
  assert.equal(actionButtons(h.row("codex")).length, 0);
});

test("重新检测时「查询中…」占用结论位、不叠加在旧结论后面", async () => {
  const pending = [];
  const h = harness((path) => {
    if (path.startsWith("/api/environment/latest/")) return new Promise((resolve) => pending.push(() => resolve(latest())));
    return normal(path);
  });
  // 反复放行 /api/environment/latest/ 上挂着的查询，直到连续两轮 tick 都没有待放行请求为止。
  // 为什么要两轮而不是一轮：面板的后续查询可能挂在更长的异步链后面，单轮轮空不足以说明已经查完；
  // 任何一轮取到请求就把 empty 清零，因此清零的是「连续」而不是「累计」。
  // 200 轮只是上限，不是期望轮数；耗尽后直接返回，此时可能仍有未放行的请求。
  // 边界：本函数只保证请求侧放空，调用方仍需各自 await entering / refreshing 才算状态真正落地——
  // 本用例两处断言「有新版本」都依赖「先 settle 再 await」这个顺序。
  const settleLatest = async () => {
    let empty = 0;
    for (let round = 0; round < 200; round += 1) {
      await tick();
      if (pending.length === 0) { empty += 1; if (empty >= 2) return; continue; }
      empty = 0;
      for (const resolve of pending.splice(0)) resolve();
    }
  };
  const entering = h.controller.enter();
  await settleLatest();
  await entering;
  assert.match(versionLine(h, "claude").textContent, /有新版本/);

  const refreshing = h.controller.refresh();
  await flush();
  const during = versionLine(h, "claude").textContent;
  assert.match(during, /查询中…/);
  assert.doesNotMatch(during, /有新版本查询中/, "两个状态不再叠在同一个结论位");
  assert.equal((during.match(/查询中…/g) || []).length, 1, "查询中只出现一次");
  assert.equal(actionButtons(h.row("claude")).length, 1, "查询中不藏动作位");

  await settleLatest();
  await refreshing;
  await flush();
  assert.match(versionLine(h, "claude").textContent, /有新版本/);
});

test("更新期间离开关于页，回来强制重检一次，不吃旧环境快照", async () => {
  const { h, pendingRefresh } = updateScenario({ latest: { claude: "1.1.0" } });
  await h.controller.enter();
  actionButton(h, "claude").click();
  await flush();
  h.controller.leave();
  const before = h.calls.length;
  const entering = h.controller.enter();
  await flush();
  assert.ok(h.calls.slice(before).includes("/api/environment?refresh=1"), "回页强制重检");
  pendingRefresh.shift()();
  await entering;
});

test("重新打开关于页时，面板重启前没跑完的更新继续显示为更新中", async () => {
  const h = harness((path) => {
    if (path === "/api/environment/updates/active") {
      return { ok: true, runs: [{ ok: true, runId: "run-kept", clientId: "claude", action: "update", state: "running" }] };
    }
    if (path.startsWith("/api/environment/update/")) return new Promise(() => {});
    return normal(path);
  });
  await h.controller.enter();
  assert.match(actionButton(h, "claude").textContent, /更新中/);
  assert.equal(actionButton(h, "claude").disabled, true);
  assert.equal(actionButton(h, "codex").disabled, false, "别的客户端没有在跑，按钮照常可点");
});

test("同时到来的运行中确认排队逐个弹，离开关于页时排队项按取消收尾", async () => {
  const running = { agents: [{ id: "claude", status: "running" }, { id: "codex", status: "running" }] };
  const posts = [];
  const h = harness(
    (path) => {
      if (path === "/api/agents") return running;
      if (path.includes("/latest/claude")) return latest("1.1.0");
      if (path.includes("/latest/codex")) return latest("1.2.0");
      if (path.includes("/latest/")) return latest("1.0.0", "current");
      if (path.startsWith("/api/environment/update/")) return doneRun("run-c", "claude");
      return normal(path);
    },
    { respondPost: ({ body }) => { posts.push(body); return { ok: true, runId: "run-c" }; } },
  );
  await h.controller.enter();
  const first = actionButton(h, "claude").click();
  await flush();
  assert.ok(h.get("clientUpdateModal").className.includes("show"), "第一个确认已上屏");
  assert.match(h.get("clientUpdateModalTitle").textContent, /claude 正在运行/);
  const second = actionButton(h, "codex").click();
  await flush();
  assert.match(h.get("clientUpdateModalTitle").textContent, /claude 正在运行/, "第二个确认排队等待，不覆盖屏上那个");
  h.get("clientUpdateModalConfirm").click();
  await flush();
  await first;
  assert.match(h.get("clientUpdateModalTitle").textContent, /codex 正在运行/, "答完第一个才轮到第二个");
  h.get("clientUpdateModalCancel").click();
  await second;
  assert.deepEqual(posts.map((post) => post.id), ["claude"], "取消的那个不动手");
  assert.equal(h.get("clientUpdateModal").className.includes("show"), false);

  // 排队中的确认在离开关于页时按取消作答，不留悬挂的 Promise
  const third = actionButton(h, "claude").click();
  await flush();
  const fourth = actionButton(h, "codex").click();
  await flush();
  h.controller.leave();
  await third;
  await fourth;
  assert.deepEqual(posts.map((post) => post.id), ["claude"], "离开后两个确认都不动手");
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

test("同一客户端重复请求被拒时给出提示，不假装在跑", async () => {
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

// ── 先行轨道与「本地 vs 官方发布」不一致提示 ──────────────────────────
test("先行轨：版本号带提交标识、先行版徽标独占、状态行按提交比对答话", async () => {
  const h = harness((path) => {
    if (path === "/api/app-info") return { version: "0.6.6", platform: "win32", nodeVersion: "v24.18.0", prerelease: false, commit: "0123456" };
    if (path === "/api/settings") return { ok: true, settings: { bleedingEdgeMode: true } };
    if (path.startsWith("/api/updates")) return { track: "bleeding", identity: true, state: "current", currentVersion: "0.6.6", currentCommit: "0123456", remoteCommit: "0123456", checkedAt: "2026-10-15T00:00:00Z", release: null, errorCode: null };
    return normal(path);
  });
  await h.controller.enter();
  await tick(); await tick(); await tick();
  assert.equal(h.get("aboutAppVersion").textContent, "0.6.6-0123456", "版本号＝包版本-短哈希");
  assert.equal(h.get("aboutBleedingBadge").hidden, false);
  assert.equal(h.get("aboutPreviewBadge").hidden, true, "先行时预览徽标让位（防提交标识被误判成预发布）");
  assert.match(h.get("aboutUpdateStatus").textContent, /已是先行版最新/);
  assert.equal(h.get("aboutDriftRow").hidden, true, "先行是常态，不出不一致提示");
});

test("先行轨：上游有新提交 → 状态行给出提交标识，「立即更新」可用；检查失败用现有文案", async () => {
  const h = harness((path) => {
    if (path === "/api/settings") return { ok: true, settings: { bleedingEdgeMode: true } };
    if (path.startsWith("/api/updates")) return { track: "bleeding", identity: true, state: "update_available", currentVersion: "0.6.6", currentCommit: "0123456", remoteCommit: "fedcba0", remoteSha: "fedcba0987654321fedcba0987654321fedcba09", checkedAt: "2026-10-15T00:00:00Z", release: null, errorCode: null };
    return normal(path);
  });
  await h.controller.enter();
  await tick(); await tick(); await tick();
  assert.match(h.get("aboutUpdateStatus").textContent, /发现先行新提交 fedcba0/);
  assert.equal(h.get("aboutSelfUpdate").hidden, false);
});

test("不一致提示行：三种形态的文案、「不再显示」按状态指纹静默、新状态复现", async () => {
  let answer = { state: "current", checkedAt: "2026-10-15T00:00:00Z", release: { version: "0.6.6", tag: "v0.6.6", prerelease: false, url: "https://github.com/Aurora0134/Anyswitch/releases/tag/v0.6.6" }, errorCode: null, track: "stable",
    drift: { ahead: false, offTag: true, localVersion: "0.6.6", remoteVersion: "0.6.6", localCommit: "0123456" } };
  const h = harness((path) => {
    if (path === "/api/settings") return { ok: true, settings: {} };
    if (path.startsWith("/api/updates")) return answer;
    return normal(path);
  });
  await h.controller.enter();
  await tick(); await tick(); await tick();
  // 仅游离：状态行中性，事实在提示行。
  assert.match(h.get("aboutUpdateStatus").textContent, /已检查更新/);
  assert.equal(h.get("aboutDriftRow").hidden, false);
  assert.match(h.get("aboutDriftNotice").textContent, /当前安装不是官方发布的版本，官方最新为 0\.6\.6/);
  assert.equal(h.get("aboutDriftDismiss").hidden, false);
  // 「不再显示」：同状态静默（提示行整行收起），状态行保持中性。
  h.get("aboutDriftDismiss").click();
  assert.equal(h.get("aboutDriftRow").hidden, true);
  assert.match(h.get("aboutUpdateStatus").textContent, /已检查更新/);
  // 同状态再次进页：仍然静默。
  h.controller.leave();
  await h.controller.enter();
  await tick(); await tick(); await tick();
  assert.equal(h.get("aboutDriftRow").hidden, true);
  // 新状态（远端身份变化）：提示行复现，文案换 ahead+游离合并形态。
  answer = { ...answer, checkedAt: "2026-10-15T01:00:00Z", drift: { ahead: true, offTag: true, localVersion: "0.6.7", remoteVersion: "0.6.6", localCommit: "1234567" } };
  await h.controller.checkUpdates(true);
  await tick(); await tick();
  assert.equal(h.get("aboutDriftRow").hidden, false);
  assert.match(h.get("aboutDriftNotice").textContent, /当前安装不是官方发布的版本（0\.6\.7-1234567），官方最新为 0\.6\.6/);
});

test("先行版开关与确认弹层的定稿文案逐字落盘（对稿结论）", () => {
  // 本用例只保留套件里别处没有覆盖的文案契约：高级选项页「更新通道」卡的开关行
  // 说明、开关控件、先行版徽标与「不再显示」的动作文案、开启/关闭确认弹层与
  // toast。这些 UI 片段没有渲染用例走过，逐字落盘是它们唯一的回归保护。
  // 关于页的先行状态行（已是先行版最新 / 发现先行新提交）、不一致提示行三形态与
  // 中性状态行（已检查更新）不在字面层重复断言——「先行轨」两条与「不一致提示行」
  // 用例已通过渲染结果逐字验证它们出现在正确的状态分支上，ahead 形态另见
  // 「update check runs once…all server states render」。
  // 高级选项页「更新通道」卡：开关行说明。
  assert.ok(html.includes("关闭时，更新只提供官方正式发布的版本；开启后，检查更新跟随上游最新提交，安装的版本号会带提交标识并显示「先行版」标记。从先行版关闭时，会先回退到离当前最近的稳定版本。"), "开关行说明");
  assert.ok(html.includes('id="bleedingEdgeToggle"'));
  assert.ok(html.includes(">先行版</span>"), "先行版徽标");
  assert.ok(html.includes(">不再显示</a>"), "不再显示动作");
  // 开启确认 / 关闭确认（带回退）/ 关闭确认（已在稳定节点）。
  assert.ok(source.includes("开启后只切换更新来源，当前已安装的版本不变；之后检查更新会显示上游最新提交，是否更新到它由你在关于页决定。先行版本包含尚未正式发布的改动。确认开启？"), "开启确认");
  assert.ok(source.includes("已开启先行版") && source.includes("已关闭先行版"), "开/关 toast");
  assert.ok(source.includes("关闭前会把 Anyswitch 回退到离当前最近的稳定版本（"), "回退确认前半");
  assert.ok(source.includes("回退期间面板与 Relay 会自动重启，服务中断几秒钟；安装目录中的手动修改会被覆盖。关闭后，更新只提供官方正式发布的版本。"), "回退确认后半");
  assert.ok(source.includes("当前已在稳定版本（"), "就地关闭确认");
  assert.ok(source.includes("确认回退并关闭？"), "回退确认按钮");
});

// ── 一键自更新（服务端 autoApply 流水线，前端只跟同一 runId）──────────────
const appUpdateAvailable = () => ({
  state: "update_available",
  track: "stable",
  checkedAt: "2026-09-18T08:01:00Z",
  drift: null,
  release: { version: "0.7.0", tag: "v0.7.0", prerelease: false, url: "https://example.com/releases/tag/v0.7.0" },
});

// 一键流程公共驱动：进页 → 点「立即更新」→ 确认弹层 → POST 登记 → 轮询帧脚本。
function selfUpdateHarness({ frames, last = null } = {}) {
  let frameIndex = 0;
  let lastOutcome = last;
  const h = harness((path) => {
    if (path.startsWith("/api/self-update/r1")) {
      const frame = frames[Math.min(frameIndex, frames.length - 1)];
      frameIndex += 1;
      if (!frame) throw new Error("poll transient failure");
      return frame;
    }
    if (path === "/api/updates") return appUpdateAvailable();
    if (path === "/api/self-update/active") return { ok: true, runs: [], staged: null };
    if (path === "/api/self-update/last") return lastOutcome;
    return normal(path);
  }, {
    respondPost: ({ path }) => {
      if (path === "/api/self-update") return { ok: true, runId: "r1", targetVersion: "0.7.0" };
      throw new Error(`unexpected POST ${path}`);
    },
  });
  return {
    h,
    publishLast: (record) => { lastOutcome = record; },
  };
}

async function startOneClick(h) {
  h.controller.enter();
  await tick(); await tick();
  h.get("aboutSelfUpdate").onclick();
  await tick();
  h.get("clientUpdateModalConfirm").click();
  await tick(); await tick();
}

test("一键任务：下载期落空轮询不派换装，翻到 apply 后落空才派；旧页面不落已读标记", async () => {
  const { h } = selfUpdateHarness({
    frames: [
      { ok: true, runId: "r1", state: "running", phase: "staging", step: "download", track: "stable", targetVersion: "0.7.0" },
      null, // 下载期一次落空轮询（网络抖动）：信号未武装，不得误盖开屏
      { ok: true, runId: "r1", state: "running", phase: "installing", step: "apply", track: "stable", targetVersion: "0.7.0" },
      null, // 应用中落空（面板已退场）：这才是换装信号
      {
        ok: true, runId: "r1", state: "done", step: "apply", phase: "waiting-panel", track: "stable",
        targetVersion: "0.7.0", startedAt: "2026-10-23T00:00:00.000Z", finishedAt: "2026-10-23T00:05:00.000Z",
        outcome: "updated", message: "已更新到 0.7.0", beforeVersion: "0.6.1", afterVersion: "0.7.0", latestVersion: "0.7.0",
      },
    ],
  });
  await startOneClick(h);
  assert.deepEqual(h.mutations.map((m) => m.path), ["/api/self-update"], "一键更新只发一次登记 POST，应用由服务端接续");
  for (let index = 0; index < 5; index++) {
    h.flushJobs();
    await tick();
  }
  assert.equal(h.swaps.length, 1, "下载期落空不派、应用期落空派一次");
  assert.match(h.get("aboutUpdateStatus").textContent, /即将刷新/, "旧页面只交代即将刷新");
  assert.ok(h.toasts.some((t) => /已更新到 0\.7\.0/.test(t.message)));
  assert.equal(h.storage.get("anyswitch:self-update-shown:r1"), undefined, "旧页面不落已读：结论由换装后的新页面经 /last 补显");
});

test("无刷新终态（失败）：本页 toast+落已读，再进页 /last 补显通道不再重弹", async () => {
  const failedRecord = {
    ok: true, runId: "r1", state: "done", step: "apply", phase: "installing", track: "stable",
    targetVersion: "0.7.0", startedAt: "2026-10-23T00:00:00.000Z", finishedAt: new Date().toISOString(),
    outcome: "failed", message: "应用新版本失败，请稍后重试", beforeVersion: "0.6.1", latestVersion: "0.7.0",
  };
  const { h, publishLast } = selfUpdateHarness({
    frames: [
      { ok: true, runId: "r1", state: "running", phase: "installing", step: "apply", track: "stable", targetVersion: "0.7.0" },
      failedRecord,
    ],
  });
  await startOneClick(h);
  for (let index = 0; index < 3; index++) {
    h.flushJobs();
    await tick();
  }
  assert.equal(h.swaps.length, 0, "失败收场不派换装");
  assert.ok(h.toasts.some((t) => t.isErr && /失败/.test(t.message)));
  assert.equal(h.storage.get("anyswitch:self-update-shown:r1"), "1", "本页已交代，观察者与补显通道凭已读标记退场");
  // 再进页（模拟刷新后回关于页）：/last 有结论但已读过，不重弹。
  const toastsBefore = h.toasts.length;
  publishLast(failedRecord);
  h.controller.leave();
  await h.controller.enter();
  await tick(); await tick();
  assert.equal(h.toasts.length, toastsBefore, "已读标记压制 /last 补显");
});
