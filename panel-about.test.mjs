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
const ids = ["claude", "codex", "opencode", "pi", "kimi", "dsh", "zcode", "qoder"];
function environment() {
  return {
    platform: "win32", nodeVersion: "v24.13.0", checkedAt: "2026-09-18T08:00:00Z",
    clients: ids.map((id) => ({
      id, name: id,
      installations: (id === "qoder" ? ["cli", "desktop"] : [id === "zcode" ? "desktop" : "cli"]).map((kind) => ({
        kind, remoteId: id === "qoder" && kind === "desktop" ? "qoder-desktop" : id,
        status: "found", path: `C:\\Apps\\${id}\\${kind}`, version: kind === "desktop" ? "2.0.0" : "1.0.0",
        versionSource: "package-json", issue: null,
      })),
    })),
  };
}
const latest = (version = "1.1.0", comparison = "update_available") => ({ state: "ok", version, comparison, source: "npm", checkedAt: "2026-09-18T08:01:00Z", url: "https://www.npmjs.com/package/@anthropic-ai/claude-code" });

function harness(respond = () => latest()) {
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
  const request = (method, path) => {
    assert.equal(method, "GET");
    calls.push(path);
    return Promise.resolve().then(() => respond(path));
  };
  const match = source.match(/  function createAboutController\([\s\S]*?\n  \}/);
  assert.ok(match, "testable About controller exists in panel.js");
  const factory = vm.runInNewContext(`(${match[0]})`, { URL, URLSearchParams });
  const controller = factory({ request, doc });
  return { nodes, doc, calls, controller, get: (id) => nodes.get(id), row: (id) => nodes.get("aboutClients").children.find((node) => node.dataset.clientId === id) };
}

function normal(path) {
  if (path === "/api/app-info") return appInfo;
  if (path.startsWith("/api/environment?" ) || path === "/api/environment") return environment();
  return latest();
}

test("enter renders local data before official replies; remote concurrency is bounded and application updates stay manual", async () => {
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
  assert.equal(h.get("aboutClients").children.length, 8);
  assert.match(h.row("claude").textContent, /本地.*1\.0\.0/);
  assert.match(h.row("claude").textContent, /查询中/);
  assert.equal(pending.length, 3);
  assert.ok(h.get("aboutEnvironmentRefresh").disabled);
  assert.equal(h.calls.some((path) => path.startsWith("/api/updates")), false);
  pending[0].resolve(latest());
  await tick();
  assert.match(h.row("claude").textContent, /官方最新.*1\.1\.0.*有新版本/);
  assert.equal(pending.length, 4);
  for (let index = 1; index < 9; index++) { pending[index].resolve(latest()); await tick(); }
  await entering;
  assert.equal(h.get("aboutEnvironmentRefresh").disabled, false);
  assert.match(h.row("qoder").textContent, /CLI.*本地.*1\.0\.0.*桌面.*本地.*2\.0\.0/);
  assert.equal(descendants(h.row("qoder"), (node) => node.className === "about-version-line").length, 2);
});

test("check-updates button is manual, deduplicated, retryable and shows all server states", async () => {
  let update = deferred();
  const h = harness((path) => path.startsWith("/api/updates") ? update.promise : normal(path));
  await h.controller.enter();
  assert.match(h.get("aboutUpdateStatus").textContent, /尚未检查/);
  const checking = h.get("aboutCheckUpdates").click();
  h.controller.checkUpdates();
  await tick();
  assert.equal(h.calls.filter((path) => path === "/api/updates?refresh=1").length, 1);
  assert.equal(h.get("aboutCheckUpdates").disabled, true);
  update.resolve({ state: "update_available", checkedAt: "2026-09-18T09:00:00Z", release: { version: "0.5.0-preview.2", url: "https://github.com/Aurora0134/Anyswitch/releases/tag/v0.5.0-preview.2" } });
  await checking;
  assert.match(h.get("aboutUpdateStatus").textContent, /发现新版本.*0\.5\.0-preview\.2/);
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
  assert.equal(h.calls.filter((path) => path.includes("/latest/")).length, 9);
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
  assert.match(h.row("claude").textContent, /未找到/);
  assert.match(h.row("codex").textContent, /版本无法读取/);
  assert.match(h.row("pi").textContent, /检测失败/);
  assert.ok(h.calls.includes("/api/environment/latest/qoder?localVersion=1.0.0"));
  assert.ok(h.calls.includes("/api/environment/latest/qoder-desktop?localVersion=2.0.0"));
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
  const checking = h.get("aboutCheckUpdates").click();
  await tick();
  h.controller.leave();
  const second = h.controller.enter();
  await tick();
  assert.equal(h.calls.filter((path) => path === "/api/environment").length, 1);
  local.resolve(environment());
  update.resolve({ state: "current", checkedAt: "2026-09-18T09:00:00Z" });
  await Promise.all([first, second, checking]);
  assert.equal(h.get("aboutClients").children.length, 8);
  assert.match(h.get("aboutUpdateStatus").textContent, /尚未检查/);
  assert.equal(h.calls.filter((path) => path.includes("/latest/")).length, 9);
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

test("settings has explicit third tab mapping and leaving About runs its lifecycle without taking a theme snapshot", () => {
  const h = harness();
  const tabs = source.match(/    const settingsSubTabs = \{[\s\S]*?\n    \};/);
  const activate = source.match(/    function activateSettingsSubTab\(which, animate\) \{[\s\S]*?\n    \}/);
  const bind = source.match(/    function bindSettingsSubTabs\(\) \{[\s\S]*?\n    \}/);
  assert.ok(tabs && activate && bind);
  let enters = 0, leaves = 0, mirrors = 0;
  const context = vm.createContext({
    $: h.get, about: { enter() { enters++; }, leave() { leaves++; } },
    replayViewEnter() {}, captureSettingsMirror() { mirrors++; },
  });
  vm.runInContext(`${tabs[0]}\n${activate[0]}\n${bind[0]}\nbindSettingsSubTabs();`, context);
  h.get("settingsTabAbout").click();
  assert.equal(h.get("settingsPanelAbout").hidden, false);
  assert.equal(h.get("settingsPanelTheme").hidden, true);
  assert.equal(h.get("settingsPanelGeneral").hidden, true);
  assert.equal(h.get("settingsTabAbout").getAttribute("aria-selected"), "true");
  assert.equal(enters, 1); assert.equal(mirrors, 0);
  h.get("settingsTabAbout").click(); assert.equal(enters, 1);
  h.get("settingsTabTheme").click(); assert.equal(leaves, 1); assert.equal(mirrors, 1);
  const event = { key: "ArrowRight", preventDefault() {} };
  h.get("settingsTabTheme").onkeydown(event);
  assert.equal(h.get("settingsTabAbout").focused, true);
  assert.equal(enters, 2);
  h.get("settingsTabGeneral").click();
  assert.equal(h.get("settingsPanelGeneral").hidden, false);
  assert.equal(h.get("settingsPanelAbout").hidden, true);
  assert.match(source, /if \(settings\) viewReady = enterSettingsView\(\); else leaveSettingsView\(\);/);
});
