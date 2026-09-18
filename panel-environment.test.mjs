import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createPanelRouter } from "./panel.mjs";

async function withPanel(options, run) {
  const forbidden = () => { throw new Error("unexpected production operation"); };
  const router = createPanelRouter({
    storePaths: { root: "C:/unused-about-test" },
    logger: null,
    metricsCollector: null,
    spawnAgentSyncFn: forbidden,
    getRelayStatusFn: forbidden,
    startRelayFn: forbidden,
    stopRelayFn: forbidden,
    restartRelayFn: forbidden,
    spawnPanelHostRestartFn: forbidden,
    exitPanelHostFn: forbidden,
    isWatchdogAutostartEnabledFn: forbidden,
    probeWatchdogFn: forbidden,
    ...options,
  });
  const server = createServer((req, res) => {
    router.handle(req, res).catch(() => {
      res.writeHead(500);
      res.end("unhandled route error");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(async (path) => {
      const response = await fetch(root + path);
      return { status: response.status, body: await response.json() };
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("关于页在不启动客户端或服务的情况下返回当前面板版本", async () => {
  const appInfo = { version: "0.5.0-preview", platform: "win32", nodeVersion: "v24.18.0", prerelease: true };
  await withPanel({ appInfo }, async (get) => {
    const result = await get("/panel/api/app-info");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, appInfo);
  });
});

test("环境接口保留已发现但版本未知的客户端，并支持主动刷新", async () => {
  const state = {
    checkedAt: "2026-09-18T00:00:00.000Z", platform: "win32", nodeVersion: "v24.18.0",
    clients: [{ id: "codex", name: "Codex", installations: [{ kind: "cli", remoteId: "codex", status: "found", path: "C:/fixture/codex.exe", version: null, versionSource: null, issue: "version_unavailable" }] }],
  };
  const requests = [];
  await withPanel({ environmentService: { async getState(options) { requests.push(options); return state; } } }, async (get) => {
    const result = await get("/panel/api/environment?refresh=1");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, state);
    assert.deepEqual(requests, [{ force: true }]);
  });
});

test("检查更新接口提供真实预览版发布链接，网络失败不转换成最新", async () => {
  const latest = { version: "0.5.0-preview.2", tag: "v0.5.0-preview.2", prerelease: true, url: "https://github.com/Aurora0134/Anyswitch/releases/tag/v0.5.0-preview.2", publishedAt: "2026-09-18T00:00:00Z" };
  let offline = false;
  await withPanel({ releaseService: { async getAppUpdate({ force }) {
    assert.equal(force, true);
    return { currentVersion: "0.5.0-preview.1", state: offline ? "error" : "update_available", checkedAt: "2026-09-18T01:00:00Z", release: offline ? null : latest, errorCode: offline ? "network_error" : null };
  } } }, async (get) => {
    const result = await get("/panel/api/updates?refresh=1");
    assert.equal(result.status, 200);
    assert.equal(result.body.state, "update_available");
    assert.deepEqual(result.body.release, latest);
    offline = true;
    const failed = await get("/panel/api/updates?refresh=1");
    assert.equal(failed.body.state, "error");
    assert.equal(failed.body.release, null);
  });
});

test("官方客户端版本查询只允许已支持客户端", async () => {
  const latest = { state: "ok", version: "0.1.5-rc.2", url: "https://github.com/deepseek-ai/deepseek-harness/releases", source: "npm", checkedAt: "2026-09-18T00:00:00Z", errorCode: null };
  await withPanel({ releaseService: { async getClientLatest(id, options) {
    assert.equal(id, "dsh");
    assert.deepEqual(options, { force: true });
    return latest;
  } } }, async (get) => {
    const result = await get("/panel/api/environment/latest/dsh?refresh=1");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ...latest, comparison: "unknown" });
    assert.equal((await get("/panel/api/environment/latest/not-a-client")).status, 404);
    assert.equal((await get("/panel/api/environment/latest/https%3A%2F%2Fevil.test")).status, 404);
  });
});

test("客户端预发布版本按数字比较，未知和查询失败保持无法比较", async () => {
  let offline = false;
  const service = { async getClientLatest() {
    return { state: offline ? "error" : "ok", version: offline ? null : "0.5.0-preview.10", url: null, source: "npm", checkedAt: "2026-09-18T00:00:00Z", errorCode: offline ? "timeout" : null };
  } };
  await withPanel({ releaseService: service }, async (get) => {
    const update = await get("/panel/api/environment/latest/dsh?localVersion=0.5.0-preview.2");
    assert.equal(update.body.comparison, "update_available");
    assert.equal((await get("/panel/api/environment/latest/dsh?localVersion=0.5.0-preview.10")).body.comparison, "current");
    assert.equal((await get("/panel/api/environment/latest/dsh?localVersion=0.5.0")).body.comparison, "ahead");
    assert.equal((await get("/panel/api/environment/latest/dsh?localVersion=unknown")).body.comparison, "unknown");
    offline = true;
    assert.equal((await get("/panel/api/environment/latest/dsh?localVersion=0.5.0-preview.2")).body.comparison, "unknown");
  });
});

test("版本在面板加载时确定，首次打开关于页不会把磁盘新版本当作运行版本", async () => {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(new URL("./panel.mjs", import.meta.url), "utf8");
  const declaration = source.slice(source.indexOf("const APP_VERSION ="), source.indexOf("const REPO_PANEL_HTML ="));
  let diskVersion = "0.5.0-preview";
  const getInfo = runInNewContext(
    declaration.replaceAll("import.meta.url", '"file:///fixture/panel.mjs"') + "; () => APP_INFO",
    { URL, process: { platform: "win32", version: "v24.18.0" }, readFileSync: () => JSON.stringify({ version: diskVersion }) },
  );
  diskVersion = "0.5.0";
  assert.equal(getInfo().version, "0.5.0-preview");
  assert.equal(getInfo().prerelease, true);
});

test("检测服务异常返回受控错误，不泄漏本机异常信息", async () => {
  const fail = async () => { throw new Error("private filesystem details"); };
  await withPanel({ environmentService: { getState: fail }, releaseService: { getAppUpdate: fail, getClientLatest: fail } }, async (get) => {
    const environment = await get("/panel/api/environment");
    assert.equal(environment.status, 500);
    assert.equal(environment.body.message, "暂时无法检测本地环境");
    for (const path of ["/panel/api/updates", "/panel/api/environment/latest/kimi"]) {
      const result = await get(path);
      assert.equal(result.body.state, "error");
      assert.doesNotMatch(JSON.stringify(result.body), /private filesystem/);
    }
  });
});
