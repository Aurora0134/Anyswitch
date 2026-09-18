import { it } from "node:test";
import assert from "node:assert/strict";
import { createReleaseService } from "./release-service.mjs";

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
  assert.deepEqual(await initial, await forcedWhilePending);
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
  for (const patch of [{ tag_name: "desktop-v0.155.0" }, { prerelease: true }, { draft: true }, { tag_name: null }]) {
    const result = await createReleaseService({ now, fetchFn: async () => json({ ...release("rust-v0.155.0"), prerelease: false, html_url: "https://github.com/openai/codex/releases/tag/rust-v0.155.0", ...patch }) }).getClientLatest("codex");
    assert.equal(result.errorCode, "invalid_response");
  }
  const codex = await createReleaseService({ now, fetchFn: async () => json({ ...release("rust-v0.155.0"), prerelease: false, html_url: "https://github.com/openai/codex/releases/tag/desktop-v0.155.0" }) }).getClientLatest("codex");
  assert.equal(codex.errorCode, "unsafe_url");
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
    const partial = createReleaseService({ currentVersion: "0.4.3", now, fetchFn: async (url) => url === appEndpoint
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
    const result = await createReleaseService({ now, fetchFn }).getClientLatest(id);
    assert.equal(result.state, "error", `${id}: ${errorCode}`);
    assert.equal(result.errorCode, errorCode);
    assert.equal(result.version, null);
    assert.equal(result.url, null);
    assert.equal(result.checkedAt, checkedAt);
    assert.equal(typeof result.source, "string");
  }
  const service = createReleaseService({ fetchFn: () => { assert.fail("unsupported id must not fetch"); } });
  for (const id of ["unknown", "__proto__", "toString", "https://example.com", null]) {
    await assert.rejects(() => service.getClientLatest(id), { name: "TypeError", message: "Unsupported client id" });
  }
});

it("uses the Codex CLI release and distinct official desktop and CLI manifests", async () => {
  const fixtures = [
    ["codex", "https://api.github.com/repos/openai/codex/releases/latest", { tag_name: "rust-v0.155.0", draft: false, prerelease: false, html_url: "https://github.com/openai/codex/releases/tag/rust-v0.155.0" }, "0.155.0", "https://github.com/openai/codex/releases/tag/rust-v0.155.0", "github:openai/codex:latest"],
    ["zcode", "https://zcode.z.ai/api/v1/releases/electron/manifest?platform=windows-x86_64&channel=1", 'version: "3.12.3"\nfiles:\n  - version: 99.0.0\n', "3.12.3", "https://zcode.z.ai/cn/changelog", "zcode:windows-x86_64:stable"],
    ["qoder", "https://qoder-ide.oss-accelerate.aliyuncs.com/qodercli/channels/manifest.json", { latest: "1.1.55" }, "1.1.55", "https://qoder.com/cli", "qoder:cli:latest"],
    ["qoder-desktop", "https://download.qoder.com.cn/qoder-app/releases/latest.yml", "version: '0.2.5' # product\nfiles:\n  - url: runtime-99.0.0.zip\n", "0.2.5", "https://qoder.com/changelog", "qoder:desktop:latest"],
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
    assert.deepEqual(await service.getClientLatest(id), { state: "ok", version, url: page, source, checkedAt, errorCode: null });
  }
});

it("queries npm latest for each fixed CLI package, preserving preview channels", async () => {
  const fixtures = [
    ["claude", "@anthropic-ai/claude-code", "2.1.276", "https://github.com/anthropics/claude-code/releases"],
    ["opencode", "opencode-ai", "1.18.31", "https://github.com/anomalyco/opencode/releases"],
    ["pi", "@earendil-works/pi-coding-agent", "0.85.1", "https://github.com/earendil-works/pi/releases"],
    ["kimi", "@moonshot-ai/kimi-code", "2.0.0", "https://github.com/MoonshotAI/kimi-code/releases"],
    ["dsh", "@deepseek-ai/dsh", "0.1.5-rc.2", "https://github.com/deepseek-ai/deepseek-harness/releases"],
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
      state: "ok", version, url: page, source: `npm:${name}:latest`, checkedAt, errorCode: null,
    });
  }
});
