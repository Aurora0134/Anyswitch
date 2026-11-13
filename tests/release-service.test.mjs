import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createReleaseService, CLIENTS } from "../src/ops/release-service.mjs";

const checkedAt = "2026-09-18T08:00:00.000Z";
const now = () => Date.parse(checkedAt);
const json = (value, init) => new Response(JSON.stringify(value), init);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

it("caches remote results for ten minutes, merges in-flight requests, and lets force replace cache", async () => {
  let current = Date.parse(checkedAt);
  let calls = 0;
  const first = deferred();
  const service = createReleaseService({ now: () => current, fetchFn: async () => {
    calls++;
    return calls === 1 ? first.promise : json({ latest: `2.1.${275 + calls}` });
  } });
  const initial = service.getClientLatest("claude");
  const forcedWhilePending = service.getClientLatest("claude", { force: true });
  assert.equal(calls, 1);
  first.resolve(json({ latest: "2.1.276" }));
  // 在途合并钉在身份上：两次调用返回的是同一个在途 Promise，force 也不例外
  // （对同一对象做 deepEqual 恒真，钉不住合并语义）。
  assert.equal(initial, forcedWhilePending);
  assert.equal((await service.getClientLatest("claude")).version, "2.1.276");
  assert.equal(calls, 1);
  current += 599999;
  await service.getClientLatest("claude");
  assert.equal(calls, 1);
  current += 1;
  assert.equal((await service.getClientLatest("claude")).version, "2.1.277");
  assert.equal(calls, 2);
  assert.equal((await service.getClientLatest("claude", { force: true })).version, "2.1.278");
  assert.equal(calls, 3);
});

it("limits simultaneous remote requests and converts request timeouts and oversized bodies to errors", async () => {
  const waiting = [];
  const service = createReleaseService({ maxConcurrent: 2, fetchFn: async () => {
    const next = deferred();
    waiting.push(next);
    return next.promise;
  } });
  const first = service.getClientLatest("claude");
  const second = service.getClientLatest("opencode");
  const third = service.getClientLatest("pi");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waiting.length, 2);
  waiting.shift().resolve(json({ latest: "1.0.0" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waiting.length, 2);
  for (const request of waiting) request.resolve(json({ latest: "1.0.0" }));
  assert.equal((await first).state, "ok");
  assert.equal((await second).state, "ok");
  assert.equal((await third).state, "ok");

  const timed = createReleaseService({ timeoutMs: 10, fetchFn: (_url, { signal }) => new Promise((resolve) => {
    signal?.addEventListener("abort", () => resolve(json({ latest: "2.1.276" })), { once: true });
  }) });
  assert.equal((await timed.getClientLatest("claude")).errorCode, "timeout");

  const oversized = createReleaseService({ maxResponseBytes: 30, fetchFn: async () => json({ latest: "2.1.276", padding: "x".repeat(100) }) });
  assert.equal((await oversized.getClientLatest("claude")).errorCode, "response_too_large");
});
const appEndpoint = "https://api.github.com/repos/Aurora0134/Anyswitch/releases?per_page=100&page=1";
const release = (tag, extra = {}) => ({
  tag_name: tag, draft: false, prerelease: tag.includes("-"),
  html_url: `https://github.com/Aurora0134/Anyswitch/releases/tag/${tag}`,
  published_at: "2026-09-17T01:00:00Z", ...extra,
});

it("accepts only matching official release links and constrained pagination", async () => {
  const badLinks = ["javascript:alert(1)", "http://github.com/Aurora0134/Anyswitch/releases/tag/v0.5.0", "https://github.com.evil.test/Aurora0134/Anyswitch/releases/tag/v0.5.0", "https://user@github.com/Aurora0134/Anyswitch/releases/tag/v0.5.0", "https://github.com/other/Anyswitch/releases/tag/v0.5.0", "https://github.com/Aurora0134/Anyswitch/releases/tag/v0.6.0", "https://github.com/Aurora0134/Anyswitch/releases/tag/v0.5.0?next=evil"];
  for (const html_url of badLinks) {
    const result = await createReleaseService({ currentVersion: "0.4.3", now, fetchFn: async () => json([release("v0.5.0", { html_url })]) }).getAppUpdate();
    assert.equal(result.state, "error", html_url);
    assert.equal(result.errorCode, "unsafe_url");
    assert.equal(result.release, null);
  }
  for (const endpoint of ["https://evil.test/releases", "http://127.0.0.1/releases", "https://api.github.com/repos/other/repo/releases?page=2", appEndpoint, `${appEndpoint}&token=secret`]) {
    const result = await createReleaseService({ currentVersion: "0.4.3", now, fetchFn: async (url) => {
      assert.equal(url, appEndpoint);
      return json([release("v0.4.3")], { headers: { Link: `<${endpoint}>; rel="next"` } });
    } }).getAppUpdate();
    assert.equal(result.state, "error", endpoint);
    assert.equal(result.errorCode, "invalid_pagination");
  }
  // npm 系客户端的发布页是写死的固定链接，远端响应里没有任何可注入的 URL；
  // 能做的只有拒绝读不出版本的响应体。Grok Build 走同一形态，一并钉住。
  for (const body of [{}, { latest: null }, { latest: "not-a-version" }, { latest: "1.0.30.1" }, { next: "1.0.41" }]) {
    const result = await createReleaseService({ now, fetchFn: async () => json(body) }).getClientLatest("grok");
    assert.equal(result.state, "error", JSON.stringify(body));
    assert.equal(result.errorCode, "invalid_response", JSON.stringify(body));
    assert.equal(result.version, null);
  }
});

it("follows all release pages before deciding and never trusts partial results", async () => {
  const next = appEndpoint.replace("&page=1", "&page=2");
  const service = createReleaseService({ currentVersion: "0.4.3", now, fetchFn: async (url) => {
    if (url === appEndpoint) return json([release("v0.4.3")], { headers: { Link: `<${next}>; rel="next", <${next}>; rel="last"` } });
    assert.equal(url, next);
    return json([release("v0.5.0")]);
  } });
  const result = await service.getAppUpdate();
  assert.equal(result.state, "update_available");
  assert.equal(result.release.version, "0.5.0");
  for (const second of [() => { throw new Error("offline"); }, () => json({}, { status: 429 })]) {
    // offline 子例钉「无代理」：默认代理解析器读真实环境变量与 git http.proxy，
    // 配了代理且网络可达的机器上「fetchFn 抛错＝离线」前提失效（数据真的会经
    // 代理取回），显式 null 让离线语义在任何机器上成立。
    const partial = createReleaseService({ currentVersion: "0.4.3", now, proxyResolveFn: async () => null, fetchFn: async (url) => url === appEndpoint
      ? json([release("v0.4.3")], { headers: { Link: `<${next}>; rel="next"` } }) : second() });
    const failure = await partial.getAppUpdate();
    assert.equal(failure.state, "error");
    assert.equal(failure.release, null);
  }
});

it("selects the highest eligible app SemVer, keeping the process version and empty releases distinct", async () => {
  const releases = [release("v0.5.0-preview.2", { published_at: "2026-09-19T01:00:00Z" }), release("v0.5.0-preview.10"), release("v0.4.3"), release("v9.0.0", { draft: true })];
  for (const [currentVersion, state, tag] of [
    ["0.5.0-preview.2", "update_available", "v0.5.0-preview.10"],
    ["0.5.0-preview.10", "current", "v0.5.0-preview.10"],
    ["0.5.0-preview.11", "ahead", "v0.5.0-preview.10"],
    ["0.4.3", "current", "v0.4.3"],
    ["0.4.2", "update_available", "v0.4.3"],
    ["0.6.0", "ahead", "v0.4.3"],
  ]) {
    const service = createReleaseService({ currentVersion, now, fetchFn: async (url) => {
      assert.equal(url, appEndpoint);
      return json(releases);
    } });
    assert.deepEqual(await service.getAppUpdate(), {
      currentVersion, state, checkedAt, errorCode: null,
      release: { version: tag.slice(1), tag, prerelease: tag.includes("-"), url: `https://github.com/Aurora0134/Anyswitch/releases/tag/${tag}`, publishedAt: "2026-09-17T01:00:00Z" },
    });
  }
  const empty = createReleaseService({ currentVersion: "0.5.0-preview", now, fetchFn: async () => json([]) });
  assert.deepEqual(await empty.getAppUpdate(), { currentVersion: "0.5.0-preview", state: "no_releases", release: null, checkedAt, errorCode: null });
  const unknown = createReleaseService({ currentVersion: "1.2.3.4", now, fetchFn: () => assert.fail("unknown current version must not query") });
  assert.deepEqual(await unknown.getAppUpdate(), { currentVersion: "1.2.3.4", state: "unknown_version", release: null, checkedAt, errorCode: null });
});

it("reports unavailable or malformed sources without claiming a latest version", async () => {
  const fixtures = [
    ["claude", () => json({}, { status: 429 }), "rate_limited"],
    ["claude", () => json({}, { status: 403, headers: { "x-ratelimit-remaining": "0" } }), "rate_limited"],
    ["claude", () => json({}, { status: 404 }), "http_error"],
    ["claude", () => { throw new Error("offline"); }, "network_error"],
    ["claude", () => new Response("<html>failure</html>"), "invalid_response"],
    ["claude", () => json({ stable: "2.1.267" }), "invalid_response"],
    ["claude", () => json({ latest: "1.2.3.4" }), "invalid_response"],
    ["zcode", () => new Response("files:\n  version: 1.2.3\n"), "invalid_response"],
    ["zcode", () => new Response("version: 1.2.3\nversion: 9.9.9\n"), "invalid_response"],
    ["zcode", () => new Response("version: !!str 1.2.3\n"), "invalid_response"],
  ];
  for (const [id, fetchFn, errorCode] of fixtures) {
    // offline 夹具钉「无代理」（默认解析器读真实代理配置，配了的机器上
    // network_error 前提会失效），见「follows all release pages」用例同款注释。
    const result = await createReleaseService({ now, fetchFn, proxyResolveFn: async () => null }).getClientLatest(id);
    assert.equal(result.state, "error", `${id}: ${errorCode}`);
    assert.equal(result.errorCode, errorCode);
    assert.equal(result.version, null);
    assert.equal(result.url, null);
    assert.equal(typeof result.source, "string");
  }
  const service = createReleaseService({ fetchFn: () => { assert.fail("unsupported id must not fetch"); } });
  for (const id of ["unknown", "__proto__", "toString", "https://example.com", null]) {
    await assert.rejects(() => service.getClientLatest(id), { name: "TypeError", message: "Unsupported client id" });
  }
});

it("falls back to the newest preview for a stable install when no stable release exists yet", async () => {
  const onlyPreview = [release("v0.5.0-preview.2", { published_at: "2026-09-19T01:00:00Z" }), release("v0.5.0-preview.10")];
  for (const [currentVersion, state, tag] of [
    ["0.4.3", "update_available", "v0.5.0-preview.10"],
    ["0.4.2", "update_available", "v0.5.0-preview.10"],
    ["0.9.0", "ahead", "v0.5.0-preview.10"],
  ]) {
    const service = createReleaseService({ currentVersion, now, fetchFn: async () => json(onlyPreview) });
    const result = await service.getAppUpdate();
    assert.equal(result.state, state);
    assert.equal(result.release.version, tag.slice(1));
    assert.equal(result.release.prerelease, true);
    assert.equal(result.release.url, `https://github.com/Aurora0134/Anyswitch/releases/tag/${tag}`);
  }
  const draftsOnly = [release("v0.5.0", { draft: true })];
  const drafted = await createReleaseService({ currentVersion: "0.4.3", now, fetchFn: async () => json(draftsOnly) }).getAppUpdate();
  assert.equal(drafted.state, "no_releases");
  assert.equal(drafted.release, null);
});

it("uses the Codex and Grok npm dist-tags plus the official desktop manifests", async () => {
  const fixtures = [
    // Codex 与更新动作同源：本地检测读 npm 全局包、装的是 npm 全局包，官方最新也查 npm。
    ["codex", "https://registry.npmjs.org/-/package/%40openai%2Fcodex/dist-tags", { latest: "0.155.0", alpha: "0.157.0-alpha.10", "win32-x64": "0.155.0-win32-x64" }, "0.155.0", "https://github.com/openai/codex/releases", "npm:@openai/codex:latest"],
    ["grok", "https://registry.npmjs.org/-/package/%40xai-official%2Fgrok/dist-tags", { latest: "1.0.41", alpha: "1.0.41" }, "1.0.41", "https://www.npmjs.com/package/@xai-official/grok", "npm:@xai-official/grok:latest"],
    ["zcode", "https://zcode.z.ai/api/v1/releases/electron/manifest?platform=windows-x86_64&channel=1", 'version: "3.12.3"\nfiles:\n  - version: 99.0.0\n', "3.12.3", "https://zcode.z.ai/cn/changelog", "zcode:windows-x86_64:stable"],
    // qoder 桌面端（intl IDE 线）：官方源是 VS Code 式更新 API（零 commit 探针
    // 回最新版），版本取 productVersion 字段。旧钉的 download.qoder.com.cn
    // /qoder-app 是另一条版本线（0.5.x）的 feed；CN 桌面版的源在 static 主机，
    // 见下一条。
    ["qoder", "https://center.qoder.sh/algo/api/update/win32-x64/stable/0000000000000000000000000000000000000000", { productVersion: "1.39.2", name: "1.39.2", url: "https://example.invalid/setup.exe" }, "1.39.2", "https://qoder.com/changelog", "qoder:desktop:win32-x64:stable"],
    // qoder CN 桌面版：与已装应用内置 electron-updater 同源的频道文件（app-update.yml
    // 的 url 是 static.qoder.com.cn/qoder-app/releases）。旧钉的 qoder-work-cn 是
    // QoderWork CN 的源——另一条产品线，0.9.18 与已装应用不在同一版本线。
    ["qoder-desktop-cn", "https://static.qoder.com.cn/qoder-app/releases/latest.yml", "version: 0.5.7\nfiles:\n  - url: Qoder-CN-win-x64-user.exe\n", "0.5.7", "https://qoder.com.cn/changelog", "qoder-desktop-cn:win-x64:latest"],
    // Kimi 桌面端与 DSH 桌面端同型：官方最新查它内置 electron-updater 的那份频道文件。
    // endpoint 钉 CDN 最终地址（code.kimi.com 会 302，查询不追跳转）；官方来源链接
    // 是官方文档站的桌面端变更记录页（桌面端没有独立仓库）。
    ["kimi-desktop", "https://cdn.kimi.com/kimi-code/desktop/latest.yml", "version: 1.0.4\nfiles:\n  - url: binaries/99.0.0/KimiCode-99.0.0-win-x64.exe\n", "1.0.4", "https://www.kimi.com/code/docs/kimi-code-desktop/changelog.html", "kimi-desktop:win-x64:latest"],
  ];
  for (const [id, endpoint, payload, version, page, source] of fixtures) {
    const service = createReleaseService({ now, fetchFn: async (url, options) => {
      assert.equal(url, endpoint);
      if (id === "zcode") {
        assert.equal(options.headers["X-Platform"], "windows-x86_64");
        assert.equal(options.headers["X-Release-Channel"], "stable");
      }
      return typeof payload === "string" ? new Response(payload) : json(payload);
    } });
    assert.deepEqual(await service.getClientLatest(id), { state: "ok", version, url: page, source, errorCode: null });
  }
});

it("answers the Claude desktop static source without any network request", async () => {
  let fetched = 0;
  let current = Date.parse(checkedAt);
  const service = createReleaseService({ now: () => current, fetchFn: async () => { fetched++; return json({}); } });
  const first = await service.getClientLatest("claude-desktop");
  assert.deepEqual(first, {
    state: "ok", version: null, url: "https://claude.ai/download", source: "claude-desktop:win32-x64:msix", errorCode: null,
  });
  assert.equal(fetched, 0, "静态条目没有可请求的版本端点");
  // 十分钟缓存同样覆盖静态条目：时钟推进后仍命中缓存，返回的仍是同一个结果
  // 对象（引用相等）；静态分支若被重新执行会造出一个新对象，这条断言随之失败。
  current += 599999;
  assert.equal(await service.getClientLatest("claude-desktop"), first);
});

it("reads the Codex desktop version from the Windows Store update manifest", async () => {
  const endpoint = "https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json";
  const url = "https://apps.microsoft.com/detail/9PLM9XGG6VKS";
  const source = "codex-desktop:windows-store:latest";
  for (const [buildVersion, version] of [["26.915.4065.0", "26.915.4065"], ["27.1.2", "27.1.2"], ["27.1.0", "27.1.0"]]) {
    const service = createReleaseService({ now, fetchFn: async (requested, options) => {
      assert.equal(requested, endpoint);
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.deepEqual(options.headers, { Accept: "application/json" });
      return json({ schemaVersion: 1, buildVersion, storeProductId: "9PLM9XGG6VKS" });
    } });
    assert.deepEqual(await service.getClientLatest("codex-desktop"), { state: "ok", version, url, source, errorCode: null });
  }
  const invalid = [
    { schemaVersion: 1, storeProductId: "9PLM9XGG6VKS" },
    { schemaVersion: 1, buildVersion: 26.9, storeProductId: "9PLM9XGG6VKS" },
    { schemaVersion: 1, buildVersion: "abc", storeProductId: "9PLM9XGG6VKS" },
    { schemaVersion: 1, buildVersion: "26.915.4065.1.2", storeProductId: "9PLM9XGG6VKS" },
  ];
  for (const payload of invalid) {
    const result = await createReleaseService({ now, fetchFn: async () => json(payload) }).getClientLatest("codex-desktop");
    assert.equal(result.state, "error", JSON.stringify(payload));
    assert.equal(result.errorCode, "invalid_response");
  }
  const httpErrors = [
    [() => json({}, { status: 429 }), "rate_limited"],
    [() => json({}, { status: 403, headers: { "x-ratelimit-remaining": "0" } }), "rate_limited"],
    [() => json({}, { status: 404 }), "http_error"],
    [() => { throw new Error("offline"); }, "network_error"],
  ];
  for (const [fetchFn, errorCode] of httpErrors) {
    // offline 夹具钉「无代理」，保住 network_error 前提（同上两处）。
    const result = await createReleaseService({ now, fetchFn, proxyResolveFn: async () => null }).getClientLatest("codex-desktop");
    assert.equal(result.state, "error", errorCode);
    assert.equal(result.errorCode, errorCode);
    assert.equal(result.version, null);
    assert.equal(result.url, null);
    assert.equal(result.source, source);
  }
});

it("queries npm latest for each fixed CLI package, preserving preview channels", async () => {
  const fixtures = [
    ["claude", "@anthropic-ai/claude-code", "2.1.276", "https://github.com/anthropics/claude-code/releases"],
    ["opencode", "@opencode/cli", "2.0.29", "https://github.com/anomalyco/opencode/releases"],
    ["pi", "@earendil-works/pi-coding-agent", "0.85.1", "https://github.com/earendil-works/pi/releases"],
    ["kimi", "@moonshot-ai/kimi-code", "2.0.0", "https://github.com/MoonshotAI/kimi-code/releases"],
    ["dsh", "@deepseek-ai/dsh", "0.1.5-rc.2", "https://github.com/deepseek-ai/deepseek-harness/releases"],
    // dsh 的终端插件是社区包，官方分发只在 npm，官方链接因此指 npm 包页。
    ["dsh-tui", "@deepseek-harness-tui/dsh-tui", "0.16.1", "https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui"],
    // Qoder CLI 与 Grok Build 同型（原生二进制、官方分发走 npm），官方链接指 npm 包页。
    ["qoder-cli", "@qoder-ai/qodercli", "1.1.64", "https://www.npmjs.com/package/@qoder-ai/qodercli"],
    // CN 区 CLI 镜像包，与 qoder-cli 同口径。
    ["qoder-cli-cn", "@qodercn-ai/qoderclicn", "1.1.88", "https://www.npmjs.com/package/@qodercn-ai/qoderclicn"],
  ];
  for (const [id, name, version, page] of fixtures) {
    const service = createReleaseService({ now, fetchFn: async (url, options) => {
      assert.equal(url, `https://registry.npmjs.org/-/package/${encodeURIComponent(name)}/dist-tags`);
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.deepEqual(options.headers, { Accept: "application/json" });
      return json({ latest: version, stable: "1.0.0", alpha: "99.0.0-alpha" });
    } });
    assert.deepEqual(await service.getClientLatest(id), {
      state: "ok", version, url: page, source: `npm:${name}:latest`, errorCode: null,
    });
  }
});

it("pins the panel /latest whitelist to the full CLIENTS table — 加客户端漏一侧即红", () => {
  // 白名单是 panel.mjs 路由里的数组字面量，CLIENTS 是本模块的查询表，两张表分居
  // 两处：此前只有 qoder-cli / codex-desktop 两个单点钉，新增客户端漏改一侧不会
  // 被任何测试抓住。照 client-lifecycle.test.mjs 读 panel.js 源码比对的钉法，这里
  // 读 panel.mjs 源码取出白名单键集合，与 CLIENTS 键集合排序后双向比对：任一侧
  // 多出或缺少客户端都会红。
  const panelSource = readFileSync(new URL("../src/panel/panel.mjs", import.meta.url), "utf8");
  const match = panelSource.match(/startsWith\("\/panel\/api\/environment\/latest\/"\)[\s\S]*?if \(!(\[[^\]]*\])\.includes\(id\)\)/);
  assert.ok(match, "panel.mjs 的 /latest 路由里存在白名单数组字面量");
  assert.deepEqual(JSON.parse(match[1]).sort(), Object.keys(CLIENTS).sort());
});

it("pins the panel.js products table to CLIENTS — 包名与官方链接漏改一侧即红", () => {
  // 关于页 safeLink 只放行 products 里登记的仓库与 npm 包名：CLIENTS 改了包名
  // 或官方链接而 products 没跟上，前端会静默拒掉后端给出的官方链接、测试照绿
  // （products 与 CLIENTS 的注释都自称同源，却是同类配对里唯一漏钉的一对）。
  // 照上一条白名单的钉法读 panel.js 源码，把 products 逐条取出对值。官方来源是
  // 厂商自家站点、靠 safeLink 域白名单放行的条目（zcode / qoder / 各桌面副形态）
  // 在表里只有空映射 []：[] 表示「不登记仓库与包名」而不是「不收录」，放行依据在
  // 下一条用例的域白名单里；本用例只对登记了仓库或包名的条目取值比对。
  const panelSource = readFileSync(new URL("../panel-ui/panel.js", import.meta.url), "utf8");
  const block = panelSource.match(/const products = \{[\s\S]*?\n    \};/);
  assert.ok(block, "panel.js 里存在 products 表字面量");
  const products = {};
  for (const [, rawKey, rawValue] of block[0].matchAll(/("[\w/-]+"|[\w-]+)\s*:\s*\[([^\]]*)\]/g)) {
    products[JSON.parse(rawKey.startsWith('"') ? rawKey : `"${rawKey}"`)] = JSON.parse(`[${rawValue}]`);
  }
  assert.ok(Object.keys(products).length >= 10, "products 表应逐条取出而不是匹配到空壳");
  for (const [id, [repo, pkg]] of Object.entries(products)) {
    assert.ok(CLIENTS[id], `products 里的 ${id} 在 CLIENTS 已不存在`);
    if (pkg) {
      const entry = /^npm:(.+):latest$/.exec(CLIENTS[id].source ?? "");
      assert.ok(entry, `${id} 的 CLIENTS 条目不是 npm dist-tag 源`);
      assert.equal(entry[1], pkg, `${id} 的 npm 包名与 products 登记的 ${pkg} 漂移`);
      if (!repo) {
        // 只登记包名、不登记仓库的客户端（dsh-tui / grok / qoder-cli），safeLink
        // 唯一放行的官方链接就是 /package/<pkg> 包页本体。CLIENTS 里这三条的 url
        // 与 source 是分开手写的字面量：url 路径与包名漂移（或整个换走）时前端
        // 会静默拒链、只钉 source 的旧断言不触发，这里把 url 与包名互钉。
        assert.equal(
          CLIENTS[id].url,
          `https://www.npmjs.com/package/${pkg}`,
          `${id} 的 npm 包页链接与包名 ${pkg} 漂移，safeLink 会静默拒链`,
        );
      }
    }
    if (repo) {
      assert.ok(
        CLIENTS[id].url === `https://github.com/${repo}` || CLIENTS[id].url === `https://github.com/${repo}/releases`,
        `${id} 的官方仓库链接与 products 登记的 ${repo} 漂移`,
      );
    }
  }
});

it("pins the panel.js safeLink domain whitelists to CLIENTS in both directions — 官方来源漏改一侧即红", () => {
  // 不在 products 里登记仓库与包名的条目（zcode / qoder / 各桌面副形态）只有一条
  // 放行依据：safeLink 的域白名单。它与 CLIENTS 的 url 分居两处手写，只钉一个方向
  // 会各留一个洞：白名单 → CLIENTS 抓不到「新增客户端只加了 CLIENTS、没加白名单」，
  // CLIENTS → 白名单抓不到「删掉某条白名单分支」（claude-desktop / codex-desktop
  // 这类 products 不收的桌面副形态，删掉分支只做方向一时实测全绿）；而只比 hostname
  // 还会放过「域名对、路径漂走」——kimi 桌面端的官方来源就在这一层由精确 URL 退成
  // 过域名。所以三件事一起钉：两个方向的主机互钉＋整串钉住白名单条目的官方来源 URL。
  const panelSource = readFileSync(new URL("../panel-ui/panel.js", import.meta.url), "utf8");
  const whitelists = {};
  for (const [, id, list] of panelSource.matchAll(/id === "([\w-]+)" \? (\[[^\]]*\])/g)) whitelists[id] = JSON.parse(list);
  assert.ok(Object.keys(whitelists).length >= 5, "safeLink 的域白名单应逐条取出而不是匹配到空壳");
  // products 表照上一条用例的读法再取一份：CLIENTS 的 url 已由仓库/包名规则覆盖的
  // 条目不需要域白名单，其余都必须能在白名单里找到放行域。
  const block = panelSource.match(/const products = \{[\s\S]*?\n    \};/);
  assert.ok(block, "panel.js 里存在 products 表字面量");
  const products = {};
  for (const [, rawKey, rawValue] of block[0].matchAll(/("[\w/-]+"|[\w-]+)\s*:\s*\[([^\]]*)\]/g)) {
    products[JSON.parse(rawKey.startsWith('"') ? rawKey : `"${rawKey}"`)] = JSON.parse(`[${rawValue}]`);
  }
  assert.ok(Object.keys(products).length >= 10, "products 表应逐条取出而不是匹配到空壳");

  // 方向一（白名单 → CLIENTS）：表里每个 id 都要在 CLIENTS 里、且放行自己 url 的主机。
  for (const [id, hosts] of Object.entries(whitelists)) {
    assert.ok(CLIENTS[id], `safeLink 白名单里的 ${id} 在 CLIENTS 已不存在`);
    assert.ok(hosts.length, `${id} 的域白名单为空`);
    assert.ok(hosts.includes(new URL(CLIENTS[id].url).hostname), `${id} 的官方来源链接域名与 safeLink 白名单漂移`);
  }

  // 方向二（CLIENTS → 白名单）：url 由 products 的仓库/包名规则放行的条目不需要白名单，
  // 其余每个条目都必须登记在白名单里，否则新增客户端只改一侧时前端静默拒链、方向一全绿。
  // dsh（本体 CLI 形态）与 dsh-desktop 是刻意不上屏的两条：关于页不渲染它们的官方来源
  // （panel.js 的 products 与域白名单都不收录），safeLink 因此恒返 null、链接行不出现。
  const offscreen = new Set(["dsh", "dsh-desktop"]);
  for (const id of offscreen) {
    assert.equal(products[id], undefined, `${id} 刻意不上屏，products 不收录`);
    assert.equal(whitelists[id], undefined, `${id} 刻意不上屏，safeLink 白名单不收录`);
  }
  for (const [id, entry] of Object.entries(CLIENTS)) {
    if (offscreen.has(id)) continue;
    const url = new URL(entry.url);
    const path = decodeURIComponent(url.pathname).replace(/\/$/, "");
    const [repo, pkg] = products[id] ?? [];
    const coveredByProducts = (url.hostname === "github.com" && repo && (path === `/${repo}` || path.startsWith(`/${repo}/releases`)))
      || (url.hostname === "www.npmjs.com" && pkg && path === `/package/${pkg}`);
    if (coveredByProducts) continue;
    assert.ok(whitelists[id], `${id} 的官方来源 ${entry.url} 既不在 products 的仓库/包名规则里，也没有 safeLink 域白名单`);
    assert.ok(whitelists[id].includes(url.hostname), `${id} 的官方来源主机 ${url.hostname} 不在 safeLink 白名单里`);
  }

  // 整串钉住：白名单条目只有域白名单这一条放行依据，只比主机时 url 的路径可以漂到
  // 任意位置仍全绿。这里把每个白名单条目的官方来源写死，改 URL 或删分支都红。
  const expected = {
    zcode: "https://zcode.z.ai/cn/changelog",
    qoder: "https://qoder.com/changelog",
    "qoder-desktop-cn": "https://qoder.com.cn/changelog",
    "codex-desktop": "https://apps.microsoft.com/detail/9PLM9XGG6VKS",
    "claude-desktop": "https://claude.ai/download",
    "kimi-desktop": "https://www.kimi.com/code/docs/kimi-code-desktop/changelog.html",
  };
  assert.deepEqual(Object.keys(whitelists).sort(), Object.keys(expected).sort(),
    "safeLink 白名单的条目集合与本文钉住的官方来源集合漂移（新增或删掉白名单分支都要同步这里）");
  for (const [id, url] of Object.entries(expected)) {
    assert.equal(CLIENTS[id].url, url, `${id} 的官方来源不是钉住的 ${url}`);
  }
});

// 代理回退（net-proxy.mjs）：直连传输层倒下才走代理；服务端已作答的形态
// （HTTP 错误、响应非法、超限）换条路答案不会变，不白付第二跳。
it("falls back to the configured proxy only on transport failure, resolving it once per service", async () => {
  const releases = () => json([release("v0.5.0")]);

  // 直连成功：代理腿从不出现，解析都不做。
  let resolveCalls = 0;
  let proxyCalls = 0;
  const direct = createReleaseService({ currentVersion: "0.4.3", now,
    fetchFn: async () => releases(),
    proxyResolveFn: async () => { resolveCalls++; return "http://127.0.0.1:7890/"; },
    proxyFetchFn: async () => { proxyCalls++; return releases(); },
  });
  assert.equal((await direct.getAppUpdate()).state, "update_available");
  assert.equal(resolveCalls, 0);
  assert.equal(proxyCalls, 0);

  // 直连传输失败 + 有代理：代理腿拿到完整 URL 与解析出的代理地址，结果照常。
  // force 再查一次时代理解析不重复（每服务实例一次）。
  const seen = [];
  const viaProxy = createReleaseService({ currentVersion: "0.4.3", now,
    fetchFn: async () => { throw new TypeError("fetch failed"); },
    proxyResolveFn: async () => { resolveCalls++; return "http://127.0.0.1:7890/"; },
    proxyFetchFn: async ({ url, proxyUrl }) => { seen.push({ url, proxyUrl }); return releases(); },
  });
  assert.equal((await viaProxy.getAppUpdate()).state, "update_available");
  assert.equal((await viaProxy.getAppUpdate({ force: true })).state, "update_available");
  assert.deepEqual(seen, [
    { url: appEndpoint, proxyUrl: "http://127.0.0.1:7890/" },
    { url: appEndpoint, proxyUrl: "http://127.0.0.1:7890/" },
  ]);
  assert.equal(resolveCalls, 1);

  // 直连超时同样回退（慢网络配代理正是要救的情形）：fetchFn 随中止信号失败，
  // 代理腿应答即恢复。
  const timedOut = createReleaseService({ currentVersion: "0.4.3", now, timeoutMs: 10,
    fetchFn: (_url, { signal }) => new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    proxyResolveFn: async () => "http://127.0.0.1:7890/",
    proxyFetchFn: async () => releases(),
  });
  assert.equal((await timedOut.getAppUpdate()).state, "update_available");

  // 没配代理：维持直连的原结论，代理腿不出现。
  const noProxy = createReleaseService({ currentVersion: "0.4.3", now,
    fetchFn: async () => { throw new TypeError("fetch failed"); },
    proxyResolveFn: async () => null,
    proxyFetchFn: async () => { proxyCalls++; return releases(); },
  });
  const unreachable = await noProxy.getAppUpdate();
  assert.equal(unreachable.state, "error");
  assert.equal(unreachable.errorCode, "network_error");
  assert.equal(proxyCalls, 0);

  // 代理也倒：如实报错，不粉饰成别的形态。
  const proxyDown = createReleaseService({ currentVersion: "0.4.3", now,
    fetchFn: async () => { throw new TypeError("fetch failed"); },
    proxyResolveFn: async () => "http://127.0.0.1:7890/",
    proxyFetchFn: async () => { throw new Error("proxy_connect_failed_407"); },
  });
  const stillDown = await proxyDown.getAppUpdate();
  assert.equal(stillDown.state, "error");
  assert.equal(stillDown.errorCode, "network_error");

  // 服务端已作答（429 限额）：不回退、不放大请求量，错误码原样透出。429 在
  // queryAppUpdate 内直抛、从不进 request 的 catch，转发守卫对它零鉴别力——
  // 真正穿过守卫的是 request 内抛出的非 timeout ReleaseError，用下面的超限
  // 子例钉住（超限在 attempt 读完 body 才能判，必经 request 的 catch）。
  let limitedProxyCalls = 0;
  const limited = createReleaseService({ currentVersion: "0.4.3", now,
    fetchFn: async () => json({}, { status: 429 }),
    proxyResolveFn: async () => "http://127.0.0.1:7890/",
    proxyFetchFn: async () => { limitedProxyCalls++; return releases(); },
  });
  const rateLimited = await limited.getAppUpdate();
  assert.equal(rateLimited.state, "error");
  assert.equal(rateLimited.errorCode, "rate_limited");
  assert.equal(limitedProxyCalls, 0);

  // 超限＋配代理：非 timeout 的 ReleaseError 必须被守卫原样转发，代理解析与
  // 代理腿都不出现。删掉守卫时这条会红两次——代理解析被触发（解析计数变 1）、
  // 代理腿取回数据把错误吞成 update_available。
  let oversizedResolves = 0;
  let oversizedProxyCalls = 0;
  const oversized = createReleaseService({ currentVersion: "0.4.3", now, maxResponseBytes: 30,
    fetchFn: async () => json({ releases: "x".repeat(100) }),
    proxyResolveFn: async () => { oversizedResolves++; return "http://127.0.0.1:7890/"; },
    proxyFetchFn: async () => { oversizedProxyCalls++; return releases(); },
  });
  const tooLarge = await oversized.getAppUpdate();
  assert.equal(tooLarge.state, "error");
  assert.equal(tooLarge.errorCode, "response_too_large");
  assert.equal(oversizedResolves, 0, "超限是服务端已作答的形态，代理解析不该发生");
  assert.equal(oversizedProxyCalls, 0);
});
