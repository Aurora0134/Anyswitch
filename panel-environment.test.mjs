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
    await run(
      async (path) => {
        const response = await fetch(root + path);
        return { status: response.status, body: await response.json() };
      },
      async (path, body, options = {}) => {
        const response = await fetch(root + path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: root,
            "x-anyswitch-panel": "1",
            ...(options.headers || {}),
          },
          body: JSON.stringify(body ?? {}),
        });
        return { status: response.status, body: await response.json() };
      },
    );
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
    assert.equal((await get("/panel/api/environment/latest/qoder-desktop")).status, 404);
    assert.equal((await get("/panel/api/environment/latest/https%3A%2F%2Fevil.test")).status, 404);
  });
});

test("Codex 桌面端纳入官方版本查询白名单，不再吃 unknown_client", async () => {
  const latest = { state: "ok", version: "26.915.4066", url: "https://apps.microsoft.com/detail/9PLM9XGG6VKS", source: "codex-desktop:windows-store:latest", checkedAt: "2026-09-18T00:00:00Z", errorCode: null };
  await withPanel({ releaseService: { async getClientLatest(id, options) {
    assert.equal(id, "codex-desktop", "远端 id 原样传给发布服务");
    assert.deepEqual(options, { force: false });
    return latest;
  } } }, async (get) => {
    const result = await get("/panel/api/environment/latest/codex-desktop");
    assert.equal(result.status, 200, "codex-desktop 不再落进 404 unknown_client");
    assert.deepEqual(result.body, { ...latest, comparison: "unknown" });
    const compared = await get("/panel/api/environment/latest/codex-desktop?localVersion=26.915.4065");
    assert.equal(compared.status, 200);
    assert.equal(compared.body.comparison, "update_available", "comparison 字段照常按本地版本计算");
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

// ── 客户端安装/更新：按客户端分锁、结果分级、不误报成功 ──────────────

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function clientState(versions = {}, issues = {}) {
  return {
    checkedAt: "2026-09-18T00:00:00.000Z", platform: "win32", nodeVersion: "v24.18.0",
    clients: ["claude", "codex", "opencode", "pi", "kimi", "dsh", "zcode", "qoder"].map((id) => ({
      id, name: id,
      installations: [{
        kind: id === "zcode" || id === "qoder" ? "desktop" : "cli",
        remoteId: id, status: "found", path: `C:/fixture/${id}`,
        version: Object.hasOwn(versions, id) ? versions[id] : "1.0.0", versionSource: "package.json", issue: issues[id] ?? null,
      }],
    })),
  };
}

const latestFor = (version) => ({
  state: "ok", version, url: null, source: "npm", checkedAt: "2026-09-18T00:00:00.000Z", errorCode: null,
});

async function waitForRun(get, runId) {
  for (let index = 0; index < 200; index += 1) {
    const result = await get(`/panel/api/environment/update/${runId}`);
    if (result.status !== 200 || result.body.state === "done") return { status: result.status, body: result.body };
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("client lifecycle run never finished");
}

test("客户端更新接口沿用面板写闸门，缺写头直接拒绝", async () => {
  await withPanel({}, async (get, post) => {
    const blocked = await post("/panel/api/environment/update", { id: "claude", action: "update" }, { headers: { "x-anyswitch-panel": "" } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, "csrf");
  });
});

test("客户端更新只接受可代管客户端与合法动作，非法请求不触发任何安装", async () => {
  let spawned = 0;
  await withPanel({ runClientLifecycleFn: async () => { spawned += 1; return { ok: true, output: "" }; } }, async (get, post) => {
    assert.equal((await post("/panel/api/environment/update", { id: "zcode", action: "update" })).status, 404, "桌面应用不经面板更新");
    assert.equal((await post("/panel/api/environment/update", { id: "qoder", action: "install" })).status, 404);
    assert.equal((await post("/panel/api/environment/update", { id: "not-a-client", action: "update" })).status, 404);
    assert.equal((await post("/panel/api/environment/update", { id: "constructor", action: "update" })).status, 404, "原型链上的名字不能当客户端 id");
    assert.equal((await post("/panel/api/environment/update", { id: "claude", action: "uninstall" })).status, 400);
    assert.equal((await post("/panel/api/environment/update", { id: "claude" })).status, 400);
    assert.equal((await post("/panel/api/environment/update", {})).status, 404);
    assert.equal(spawned, 0);
  });
});

test("客户端更新按客户端分锁：同一客户端任务进行中再来的请求被 409 拒绝，不同客户端并行放行", async () => {
  const gate = deferred();
  await withPanel({
    environmentService: { async getState() { return clientState(); } },
    releaseService: { async getClientLatest() { return latestFor("1.0.0"); } },
    runClientLifecycleFn: async () => { await gate.promise; return { ok: true, output: "" }; },
  }, async (get, post) => {
    const first = await post("/panel/api/environment/update", { id: "claude", action: "update" });
    assert.equal(first.status, 202);
    assert.ok(first.body.runId);
    assert.equal(first.body.clientId, "claude");
    // 另一个客户端可以同时开工——关于页因此能同时开多个更新，而不是一次只放行一个。
    const parallel = await post("/panel/api/environment/update", { id: "codex", action: "update" });
    assert.equal(parallel.status, 202, "不同客户端互不阻塞");
    assert.equal(parallel.body.clientId, "codex");
    // 同一个客户端再来一个请求仍然被拒：npm 全局目录里同一个包只有一份落点，
    // 并发的同一个包安装会互搬目录（本机实测会把安装搬坏）。
    const same = await post("/panel/api/environment/update", { id: "claude", action: "update" });
    assert.equal(same.status, 409);
    assert.equal(same.body.error, "busy");
    gate.resolve();
    assert.equal((await waitForRun(get, first.body.runId)).body.state, "done");
    assert.equal((await waitForRun(get, parallel.body.runId)).body.state, "done");
    // 都跑完之后同一客户端可以再次开工——锁按客户端释放，没被别的客户端带走。
    const again = await post("/panel/api/environment/update", { id: "claude", action: "update" });
    assert.equal(again.status, 202);
  });
});

test("一个客户端跑完不会解锁另一个客户端正在进行的任务", async () => {
  const fast = deferred();
  const slow = deferred();
  const gates = { claude: fast, codex: slow };
  const started = [];
  await withPanel({
    environmentService: { async getState() { return clientState(); } },
    releaseService: { async getClientLatest() { return latestFor("1.0.0"); } },
    runClientLifecycleFn: async ({ id }) => { started.push(id); await gates[id].promise; return { ok: true, output: "" }; },
  }, async (get, post) => {
    const claude = await post("/panel/api/environment/update", { id: "claude", action: "update" });
    const codex = await post("/panel/api/environment/update", { id: "codex", action: "update" });
    assert.equal(claude.status, 202);
    assert.equal(codex.status, 202);
    fast.resolve();
    assert.equal((await waitForRun(get, claude.body.runId)).body.state, "done");
    // claude 收尾时不能顺手把 codex 那把锁也放掉，否则 codex 会被第二个任务同时更新。
    const bleeding = await post("/panel/api/environment/update", { id: "codex", action: "update" });
    assert.equal(bleeding.status, 409, "codex 仍在跑，锁必须还在");
    slow.resolve();
    assert.equal((await waitForRun(get, codex.body.runId)).body.state, "done");
    // 两个任务各自只跑了一次；最后一次 202 会再起一个 codex 任务，故只比对前两次。
    assert.deepEqual(started.slice(0, 2), ["claude", "codex"]);
    assert.equal((await post("/panel/api/environment/update", { id: "codex", action: "update" })).status, 202);
  });
});

test("更新完成后回传新本地版本、官方最新与比对结论", async () => {
  const probes = [];
  await withPanel({
    environmentService: {
      async getState(options = {}) {
        probes.push(Boolean(options.force));
        return clientState({ claude: options.force ? "1.1.0" : "1.0.0" });
      },
    },
    releaseService: {
      async getClientLatest(id, options) {
        assert.equal(id, "claude");
        assert.deepEqual(options, { force: true });
        return latestFor("1.1.0");
      },
    },
    runClientLifecycleFn: async ({ id, action }) => {
      assert.deepEqual({ id, action }, { id: "claude", action: "update" });
      return { ok: true, output: "" };
    },
  }, async (get, post) => {
    const started = await post("/panel/api/environment/update", { id: "claude", action: "update" });
    const finished = await waitForRun(get, started.body.runId);
    assert.deepEqual({ outcome: finished.body.outcome, before: finished.body.beforeVersion, after: finished.body.afterVersion }, { outcome: "updated", before: "1.0.0", after: "1.1.0" });
    assert.equal(finished.body.latestVersion, "1.1.0");
    assert.equal(finished.body.comparison, "current");
    assert.match(finished.body.message, /1\.1\.0/);
    assert.deepEqual(probes.slice(0, 2), [false, true], "安装后重查本地版本必须绕过 TTL 缓存");
  });
});

test("命令成功但版本原地踏步归为未生效，不误报成功", async () => {
  await withPanel({
    environmentService: { async getState() { return clientState({ claude: "1.0.0" }); } },
    releaseService: { async getClientLatest() { return latestFor("2.0.0"); } },
    runClientLifecycleFn: async () => ({ ok: true, output: "" }),
  }, async (get, post) => {
    const started = await post("/panel/api/environment/update", { id: "claude", action: "update" });
    const finished = await waitForRun(get, started.body.runId);
    assert.equal(finished.body.outcome, "unchanged");
    assert.equal(finished.body.comparison, "update_available", "新版本仍然可升，说明这次更新没落到生效位置");
    assert.match(finished.body.message, /版本未变化/);
  });
});

test("更新命令失败带出末行错误，不谎报成功", async () => {
  await withPanel({
    environmentService: { async getState() { return clientState(); } },
    releaseService: { async getClientLatest() { return latestFor("1.0.0"); } },
    runClientLifecycleFn: async () => ({ ok: false, output: "npm warn deprecated x\nnpm error code EACCES\nnpm error path C:\\npm" }),
  }, async (get, post) => {
    const started = await post("/panel/api/environment/update", { id: "kimi", action: "update" });
    const finished = await waitForRun(get, started.body.runId);
    assert.equal(finished.body.outcome, "failed");
    assert.match(finished.body.detail, /npm error path C:\\npm/);
  });
});

test("装上了却跑不起来给出运行环境提示，而非报成安装成功", async () => {
  await withPanel({
    environmentService: {
      async getState(options = {}) {
        return options.force ? clientState({ codex: null }, { codex: "not_runnable" }) : clientState({ codex: "1.0.0" });
      },
    },
    releaseService: { async getClientLatest() { return latestFor("1.0.0"); } },
    runClientLifecycleFn: async () => ({ ok: true, output: "" }),
  }, async (get, post) => {
    const started = await post("/panel/api/environment/update", { id: "codex", action: "update" });
    const finished = await waitForRun(get, started.body.runId);
    assert.equal(finished.body.outcome, "installed_not_runnable");
    assert.match(finished.body.message, /运行环境/);
    assert.equal(finished.body.comparison, "unknown", "跑不起来时不与官方版本比新旧");
  });
});

test("未知运行编号返回 404，页面可据此走重新检测自愈", async () => {
  await withPanel({}, async (get) => {
    const missing = await get("/panel/api/environment/update/8bfd5a4e-0000-0000-0000-000000000000");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "unknown_run");
  });
});
