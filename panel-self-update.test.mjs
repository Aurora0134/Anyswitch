import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPanelRouter } from "./panel.mjs";
import { readClientUpdateRun, writeClientUpdateRun } from "./client-update-journal.mjs";

const RUN_ID = "00000000-0000-4000-8000-000000000001";

// 自更新登记是纯登记 + 拉起：worker 的实际执行在 app-self-update.test.mjs 里
// 全注入覆盖，这里把 spawn 换成捕获桩，专注 API 面与换装监听器的行为。
function selfUpdateReleaseService(state = "update_available") {
  return {
    getAppUpdate: async () => ({
      currentVersion: "0.6.1-preview",
      state,
      checkedAt: "2026-10-07T00:00:00.000Z",
      release: state === "update_available" ? { version: "0.7.0", tag: "v0.7.0", prerelease: false, url: "https://github.com/Aurora0134/Anyswitch/releases/tag/v0.7.0" } : null,
      errorCode: null,
    }),
    getClientLatest: async () => { throw new Error("not used by self update"); },
  };
}

async function withPanel(options, run) {
  const journalDir = options.clientUpdateJournalDir ?? mkdtempSync(join(tmpdir(), "anys-self-update-panel-"));
  const ownsJournal = !options.clientUpdateJournalDir;
  options = {
    appInfo: { version: "0.6.1-preview", platform: "win32", nodeVersion: "v24.18.0", prerelease: true },
    ...options,
    clientUpdateJournalDir: journalDir,
    spawnClientUpdateWorkerFn: () => process.pid,
    spawnSelfUpdateWorkerFn: options.spawnSelfUpdateWorkerFn ?? (() => process.pid),
  };
  const forbidden = () => { throw new Error("unexpected production operation"); };
  const router = createPanelRouter({
    storePaths: { root: "C:/unused-self-update-test" },
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
      { journalDir },
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (ownsJournal) rmSync(journalDir, { recursive: true, force: true });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("POST /panel/api/self-update", () => {
  test("有可用更新：登记 journal、拉起脱离 worker、布上换装监听器，返回 202", async () => {
    const spawned = [];
    const watch = { scheduled: 0, canceled: 0, pump: null };
    await withPanel({
      releaseService: selfUpdateReleaseService(),
      spawnSelfUpdateWorkerFn: (request) => { spawned.push(request); return 424242; },
      selfUpdateWatchScheduleFn: (fn) => { watch.pump = fn; watch.scheduled += 1; return 42; },
      selfUpdateWatchCancelFn: () => { watch.canceled += 1; },
    }, async (get, post) => {
      const result = await post("/panel/api/self-update", {});
      assert.equal(result.status, 202);
      assert.equal(result.body.ok, true);
      assert.equal(result.body.clientId, "anyswitch");
      assert.equal(result.body.targetVersion, "0.7.0");
      assert.equal(spawned.length, 1);
      const recorded = readClientUpdateRun(spawned[0].journalDir, result.body.runId);
      assert.equal(recorded.clientId, "anyswitch");
      assert.equal(recorded.state, "running");
      assert.equal(recorded.workerPid, 424242);
      assert.equal(recorded.phase, "staging");
      assert.equal(recorded.targetVersion, "0.7.0");
      assert.equal(recorded.targetTag, "v0.7.0");
      assert.equal(recorded.beforeVersion, "0.6.1-preview");
      // appDir 就是 panel.mjs 所在目录（与测试文件同目录），与检出位置的名字无关。
      assert.equal(recorded.appDir, dirname(fileURLToPath(import.meta.url)));
      assert.equal(watch.scheduled, 1, "the swap watcher must be armed");
    });
  });

  test("没有可用更新：409 no_update，不登记不拉起", async () => {
    const spawned = [];
    await withPanel({
      releaseService: selfUpdateReleaseService("current"),
      spawnSelfUpdateWorkerFn: (request) => { spawned.push(request); return process.pid; },
    }, async (get, post) => {
      const result = await post("/panel/api/self-update", {});
      assert.equal(result.status, 409);
      assert.equal(result.body.error, "no_update");
      assert.equal(spawned.length, 0);
    });
  });

  test("已有进行中的自更新：409 busy（journal running 记录即单飞锁）", async () => {
    const spawned = [];
    await withPanel({
      releaseService: selfUpdateReleaseService(),
      spawnSelfUpdateWorkerFn: (request) => { spawned.push(request); return process.pid; },
    }, async (get, post, ctx) => {
      writeClientUpdateRun(ctx.journalDir, {
        runId: RUN_ID, clientId: "anyswitch", action: "update", state: "running",
        startedAt: "2026-10-07T00:00:00.000Z", finishedAt: null, result: null,
        workerPid: process.pid, phase: "staging", targetVersion: "0.7.0",
      });
      const result = await post("/panel/api/self-update", {});
      assert.equal(result.status, 409);
      assert.equal(result.body.error, "busy");
      assert.equal(spawned.length, 0);
    });
  });

  test("relay 副本不是控制面：409，换装自杀必须由 47820 自己做", async () => {
    const spawned = [];
    await withPanel({
      hostKind: "relay-host",
      releaseService: selfUpdateReleaseService(),
      spawnSelfUpdateWorkerFn: (request) => { spawned.push(request); return process.pid; },
    }, async (get, post) => {
      const result = await post("/panel/api/self-update", {});
      assert.equal(result.status, 409);
      assert.equal(spawned.length, 0);
    });
  });
});

describe("GET /panel/api/self-update/*", () => {
  test("active 与按 runId 状态查询带 phase；未知 run 404", async () => {
    await withPanel({}, async (get, post, ctx) => {
      writeClientUpdateRun(ctx.journalDir, {
        runId: RUN_ID, clientId: "anyswitch", action: "update", state: "running",
        startedAt: "2026-10-07T00:00:00.000Z", finishedAt: null, result: null,
        workerPid: process.pid, phase: "installing", targetVersion: "0.7.0", targetTag: "v0.7.0",
      });
      const active = await get("/panel/api/self-update/active");
      assert.equal(active.status, 200);
      assert.equal(active.body.runs.length, 1);
      assert.equal(active.body.runs[0].phase, "installing");
      assert.equal(active.body.runs[0].targetVersion, "0.7.0");
      const status = await get(`/panel/api/self-update/${RUN_ID}`);
      assert.equal(status.status, 200);
      assert.equal(status.body.state, "running");
      assert.equal(status.body.phase, "installing");
      const missing = await get("/panel/api/self-update/ffffffff-ffff-4fff-8fff-ffffffffffff");
      assert.equal(missing.status, 404);
    });
  });

  test("完成态把 result 展开进状态负载", async () => {
    await withPanel({}, async (get, post, ctx) => {
      writeClientUpdateRun(ctx.journalDir, {
        runId: RUN_ID, clientId: "anyswitch", action: "update", state: "done",
        startedAt: "2026-10-07T00:00:00.000Z", finishedAt: "2026-10-07T00:05:00.000Z",
        result: { outcome: "updated", message: "已更新到 0.7.0", beforeVersion: "0.6.1-preview", afterVersion: "0.7.0", latestVersion: "0.7.0" },
        workerPid: process.pid, phase: "waiting-panel", targetVersion: "0.7.0",
      });
      const status = await get(`/panel/api/self-update/${RUN_ID}`);
      assert.equal(status.status, 200);
      assert.equal(status.body.state, "done");
      assert.equal(status.body.outcome, "updated");
      assert.equal(status.body.afterVersion, "0.7.0");
    });
  });
});

describe("自更新换装监听器", () => {
  function watchCapture() {
    const watch = { pumps: [], canceled: 0, restarts: 0, exits: [] };
    return {
      watch,
      selfUpdateWatchScheduleFn: (fn) => { watch.pumps.push(fn); return 42; },
      selfUpdateWatchCancelFn: () => { watch.canceled += 1; },
      spawnPanelHostRestartFn: () => { watch.restarts += 1; return 99; },
      exitPanelHostFn: (code) => { watch.exits.push(code); },
    };
  }

  test("phase 到 ready-to-restart：泵一次 = helper 拉起 + 本进程宽限后退，且只此一次", async () => {
    const capture = watchCapture();
    await withPanel({
      releaseService: selfUpdateReleaseService(),
      ...capture,
    }, async (get, post, ctx) => {
      const started = await post("/panel/api/self-update", {});
      assert.equal(started.status, 202);
      // worker 把阶段推到换装点（这里直接改写 journal 模拟）。
      const run = readClientUpdateRun(ctx.journalDir, started.body.runId);
      writeClientUpdateRun(ctx.journalDir, { ...run, phase: "ready-to-restart" });
      assert.equal(capture.watch.pumps.length, 1);
      capture.watch.pumps[0]();
      assert.equal(capture.watch.restarts, 1, "the restart helper must be spawned");
      assert.equal(capture.watch.canceled, 1, "the watcher must be withdrawn after firing");
      await sleep(300);
      assert.deepEqual(capture.watch.exits, [0]);
      // 定时器已撤（canceled=1），监听器不会再次自动点火；手动再调 pump 属于测试
      // 之外的路径，不在此断言。
    });
  });

  test("本进程已是目标版本（换装后的新面板）：绝不点火", async () => {
    const capture = watchCapture();
    const journalDir = mkdtempSync(join(tmpdir(), "anys-self-update-panel-"));
    // 种子在 router 创建之前落盘：boot-scan 才扫得到这个进行中的 run。
    writeClientUpdateRun(journalDir, {
      runId: RUN_ID, clientId: "anyswitch", action: "update", state: "running",
      startedAt: "2026-10-07T00:00:00.000Z", finishedAt: null, result: null,
      workerPid: process.pid, phase: "waiting-panel", targetVersion: "0.7.0", targetTag: "v0.7.0",
    });
    try {
      await withPanel({
        clientUpdateJournalDir: journalDir,
        releaseService: selfUpdateReleaseService(),
        appInfo: { version: "0.7.0", platform: "win32", nodeVersion: "v24.18.0", prerelease: false },
        ...capture,
      }, async () => {
        assert.equal(capture.watch.pumps.length, 1, "boot scan must adopt the running run");
        capture.watch.pumps[0]();
        assert.equal(capture.watch.restarts, 0);
        assert.deepEqual(capture.watch.exits, []);
      });
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  test("phase 还在 staging：泵了也不动（换装前每一步失败都服务无损）", async () => {
    const capture = watchCapture();
    await withPanel({
      releaseService: selfUpdateReleaseService(),
      ...capture,
    }, async (get, post, ctx) => {
      const started = await post("/panel/api/self-update", {});
      assert.equal(started.status, 202);
      capture.watch.pumps[0]();
      assert.equal(capture.watch.restarts, 0);
      assert.deepEqual(capture.watch.exits, []);
    });
  });
});
