import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createPanelRouter } from "./panel.mjs";
import { readClientUpdateRun, writeClientUpdateRun } from "./client-update-journal.mjs";

const RUN_ID = "00000000-0000-4000-8000-000000000001";

// 自更新登记是纯登记 + 拉起：worker 的实际执行在 app-self-update.test.mjs 里
// 全注入覆盖，这里把 spawn 换成捕获桩，专注 API 面、两步衔接与换装监听器的行为。
function selfUpdateReleaseService(state = "update_available") {
  return {
    getAppUpdate: async () => ({
      currentVersion: "0.6.1-preview",
      state,
      checkedAt: "2026-10-09T00:00:00.000Z",
      release: state === "update_available" ? { version: "0.7.0", tag: "v0.7.0", prerelease: false, url: "https://github.com/Aurora0134/Anyswitch/releases/tag/v0.7.0" } : null,
      errorCode: null,
    }),
    getClientLatest: async () => { throw new Error("not used by self update"); },
  };
}

// 已下载待应用的 journal 记录（下载阶段完成的落点）。
function stagedRun(overrides = {}) {
  return {
    runId: RUN_ID,
    clientId: "anyswitch",
    action: "update",
    step: "download",
    state: "done",
    startedAt: "2026-10-09T00:00:00.000Z",
    finishedAt: "2026-10-09T00:01:00.000Z",
    result: { outcome: "downloaded", message: "已下载 0.7.0，应用后生效", beforeVersion: "0.6.1-preview", latestVersion: "0.7.0" },
    workerPid: process.pid,
    targetVersion: "0.7.0",
    targetTag: "v0.7.0",
    phase: "staged",
    ...overrides,
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

describe("POST /panel/api/self-update（下载）", () => {
  test("有可用更新：登记 download 任务、拉起脱离 worker、布监听器，返回 202", async () => {
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
      assert.equal(result.body.step, "download");
      assert.equal(result.body.targetVersion, "0.7.0");
      assert.equal(spawned.length, 1);
      const recorded = readClientUpdateRun(spawned[0].journalDir, result.body.runId);
      assert.equal(recorded.clientId, "anyswitch");
      assert.equal(recorded.step, "download");
      assert.equal(recorded.state, "running");
      assert.equal(recorded.workerPid, 424242);
      assert.equal(recorded.phase, "staging");
      assert.equal(recorded.targetVersion, "0.7.0");
      assert.equal(recorded.targetTag, "v0.7.0");
      assert.equal(recorded.beforeVersion, "0.6.1-preview");
      // appDir 就是 panel.mjs 所在目录（与测试文件同目录），与检出位置的名字无关。
      assert.equal(recorded.appDir, dirname(fileURLToPath(import.meta.url)));
      assert.equal(watch.scheduled, 0, "下载阶段不布换装监听器：它只等换装阶段，应用时才布");
    });
  });

  test("一键登记带 autoApply：worker 下载核验通过后原地续跑应用段", async () => {
    const spawned = [];
    await withPanel({
      releaseService: selfUpdateReleaseService(),
      spawnSelfUpdateWorkerFn: (request) => { spawned.push(request); return 424242; },
    }, async (get, post) => {
      const result = await post("/panel/api/self-update", {});
      assert.equal(result.status, 202);
      const recorded = readClientUpdateRun(spawned[0].journalDir, result.body.runId);
      assert.equal(recorded.autoApply, true, "一键确认授权的就是下载并应用：记录带 autoApply");
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
        runId: RUN_ID, clientId: "anyswitch", action: "update", step: "download", state: "running",
        startedAt: "2026-10-09T00:00:00.000Z", finishedAt: null, result: null,
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

describe("POST /panel/api/self-update/apply（应用）", () => {
  test("有已下载记录：同一 runId 翻回 running、step=apply，返回 202", async () => {
    const spawned = [];
    const watch = { scheduled: 0 };
    await withPanel({
      spawnSelfUpdateWorkerFn: (request) => { spawned.push(request); return 424242; },
      selfUpdateWatchScheduleFn: (fn) => { watch.scheduled += 1; return 42; },
      selfUpdateWatchCancelFn: () => {},
    }, async (get, post, ctx) => {
      writeClientUpdateRun(ctx.journalDir, stagedRun());
      const result = await post("/panel/api/self-update/apply", { runId: RUN_ID });
      assert.equal(result.status, 202);
      assert.equal(result.body.step, "apply");
      assert.equal(result.body.runId, RUN_ID);
      assert.equal(result.body.targetVersion, "0.7.0");
      const recorded = readClientUpdateRun(ctx.journalDir, RUN_ID);
      assert.equal(recorded.state, "running");
      assert.equal(recorded.step, "apply");
      assert.equal(recorded.phase, "installing");
      assert.equal(recorded.result, null);
      assert.equal(recorded.workerPid, 424242);
      assert.equal(watch.scheduled, 1, "the swap watcher must be armed");
    });
  });

  test("没有已下载记录：409 no_staged，不登记不拉起", async () => {
    const spawned = [];
    await withPanel({
      spawnSelfUpdateWorkerFn: (request) => { spawned.push(request); return process.pid; },
    }, async (get, post) => {
      const result = await post("/panel/api/self-update/apply", {});
      assert.equal(result.status, 409);
      assert.equal(result.body.error, "no_staged");
      assert.equal(spawned.length, 0);
    });
  });

  test("runId 钉不住已下载记录：409 no_staged（防错位应用）", async () => {
    await withPanel({}, async (get, post, ctx) => {
      writeClientUpdateRun(ctx.journalDir, stagedRun());
      const result = await post("/panel/api/self-update/apply", { runId: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
      assert.equal(result.status, 409);
      assert.equal(result.body.error, "no_staged");
    });
  });

  test("已有进行中的任务：409 busy，staged 记录原样保留", async () => {
    await withPanel({}, async (get, post, ctx) => {
      writeClientUpdateRun(ctx.journalDir, stagedRun());
      writeClientUpdateRun(ctx.journalDir, {
        runId: "00000000-0000-4000-8000-000000000009", clientId: "anyswitch", action: "update", step: "download", state: "running",
        startedAt: "2026-10-09T00:02:00.000Z", finishedAt: null, result: null,
        workerPid: process.pid, phase: "staging", targetVersion: "0.7.0",
      });
      const result = await post("/panel/api/self-update/apply", { runId: RUN_ID });
      assert.equal(result.status, 409);
      assert.equal(result.body.error, "busy");
      const staged = readClientUpdateRun(ctx.journalDir, RUN_ID);
      assert.equal(staged.state, "done", "staged record must survive the refused apply");
      assert.equal(staged.result.outcome, "downloaded");
    });
  });
});

describe("GET /panel/api/self-update/*", () => {
  test("active 与按 runId 状态查询带 phase/step；未知 run 404", async () => {
    await withPanel({}, async (get, post, ctx) => {
      writeClientUpdateRun(ctx.journalDir, {
        runId: RUN_ID, clientId: "anyswitch", action: "update", step: "apply", state: "running",
        startedAt: "2026-10-09T00:00:00.000Z", finishedAt: null, result: null,
        workerPid: process.pid, phase: "installing", targetVersion: "0.7.0", targetTag: "v0.7.0",
      });
      const active = await get("/panel/api/self-update/active");
      assert.equal(active.status, 200);
      assert.equal(active.body.runs.length, 1);
      assert.equal(active.body.runs[0].phase, "installing");
      assert.equal(active.body.runs[0].step, "apply");
      assert.equal(active.body.runs[0].targetVersion, "0.7.0");
      assert.equal(active.body.staged, null);
      const status = await get(`/panel/api/self-update/${RUN_ID}`);
      assert.equal(status.status, 200);
      assert.equal(status.body.state, "running");
      assert.equal(status.body.phase, "installing");
      const missing = await get("/panel/api/self-update/ffffffff-ffff-4fff-8fff-ffffffffffff");
      assert.equal(missing.status, 404);
    });
  });

  test("active 带回待应用记录：staged 载荷完整", async () => {
    await withPanel({}, async (get, post, ctx) => {
      writeClientUpdateRun(ctx.journalDir, stagedRun());
      const active = await get("/panel/api/self-update/active");
      assert.equal(active.status, 200);
      assert.equal(active.body.runs.length, 0);
      assert.equal(active.body.staged.runId, RUN_ID);
      assert.equal(active.body.staged.outcome, "downloaded");
      assert.equal(active.body.staged.targetVersion, "0.7.0");
      assert.equal(active.body.staged.targetTag, "v0.7.0");
    });
  });

  test("进行中的自更新不出现在客户端更新活跃列表（避免关于页两条通道重复接回）", async () => {
    await withPanel({}, async (get, post, ctx) => {
      writeClientUpdateRun(ctx.journalDir, {
        runId: RUN_ID, clientId: "anyswitch", action: "update", step: "apply", state: "running",
        startedAt: "2026-10-09T00:00:00.000Z", finishedAt: null, result: null,
        workerPid: process.pid, phase: "installing", targetVersion: "0.7.0", targetTag: "v0.7.0",
      });
      writeClientUpdateRun(ctx.journalDir, {
        runId: "00000000-0000-4000-8000-000000000009", clientId: "claude", action: "update", state: "running",
        startedAt: "2026-10-09T00:00:00.000Z", finishedAt: null, result: null,
        workerPid: process.pid,
      });
      const selfActive = await get("/panel/api/self-update/active");
      assert.equal(selfActive.body.runs.length, 1, "自更新通道照常接回");
      const clientActive = await get("/panel/api/environment/updates/active");
      assert.deepEqual(clientActive.body.runs.map((run) => run.clientId), ["claude"], "客户端通道只见客户端更新");
    });
  });

  test("last 返回最近一次结论；一条记录都没有时 404", async () => {
    await withPanel({}, async (get, post, ctx) => {
      const empty = await get("/panel/api/self-update/last");
      assert.equal(empty.status, 404);
      writeClientUpdateRun(ctx.journalDir, stagedRun());
      writeClientUpdateRun(ctx.journalDir, stagedRun({
        runId: "00000000-0000-4000-8000-000000000009",
        finishedAt: "2026-10-09T00:05:00.000Z",
        result: { outcome: "updated", message: "已更新到 0.7.0", beforeVersion: "0.6.1-preview", afterVersion: "0.7.0", latestVersion: "0.7.0" },
      }));
      const last = await get("/panel/api/self-update/last");
      assert.equal(last.status, 200);
      assert.equal(last.body.runId, "00000000-0000-4000-8000-000000000009");
      assert.equal(last.body.outcome, "updated");
      assert.equal(last.body.message, "已更新到 0.7.0");
    });
  });

  test("完成态把 result 展开进状态负载", async () => {
    await withPanel({}, async (get, post, ctx) => {
      writeClientUpdateRun(ctx.journalDir, {
        runId: RUN_ID, clientId: "anyswitch", action: "update", step: "apply", state: "done",
        startedAt: "2026-10-09T00:00:00.000Z", finishedAt: "2026-10-09T00:05:00.000Z",
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
      spawnSelfUpdateWorkerFn: () => process.pid,
      ...capture,
    }, async (get, post, ctx) => {
      // 应用入口才布监听器：先落一条已下载记录，走 /apply 翻回 running。
      writeClientUpdateRun(ctx.journalDir, stagedRun());
      const started = await post("/panel/api/self-update/apply", { runId: RUN_ID });
      assert.equal(started.status, 202);
      // worker 把阶段推到换装点（这里直接改写 journal 模拟）。
      const run = readClientUpdateRun(ctx.journalDir, started.body.runId);
      writeClientUpdateRun(ctx.journalDir, { ...run, phase: "ready-to-restart" });
      assert.equal(capture.watch.pumps.length, 1, "apply must arm the swap watcher");
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
      runId: RUN_ID, clientId: "anyswitch", action: "update", step: "apply", state: "running",
      startedAt: "2026-10-09T00:00:00.000Z", finishedAt: null, result: null,
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

  test("下载阶段不布换装监听器（下载永远挨不到换装，布了也是空转）", async () => {
    const capture = watchCapture();
    await withPanel({
      releaseService: selfUpdateReleaseService(),
      ...capture,
    }, async (get, post) => {
      const started = await post("/panel/api/self-update", {});
      assert.equal(started.status, 202);
      assert.equal(capture.watch.pumps.length, 0, "download must not arm the swap watcher");
      assert.equal(capture.watch.restarts, 0);
      assert.deepEqual(capture.watch.exits, []);
    });
  });
});

describe("自动检测并下载更新（设置项默认关）", () => {
  // 拍节调度是注入的：捕获回调后手动泵。settings 经 base.LOCALAPPDATA 重定向到临时目录。
  function autoDownloadCapture() {
    const captured = { pump: null };
    return {
      captured,
      selfUpdateAutoDownloadScheduleFn: (fn) => { captured.pump = fn; return null; },
    };
  }

  function withSettings(baseDir, settings) {
    mkdirSync(join(baseDir, "Anyswitch"), { recursive: true });
    writeFileSync(join(baseDir, "Anyswitch", "settings.json"), JSON.stringify(settings));
  }

  test("首开一拍（设置显式开启）：有更新就登记 download；已有在跑则不重复登记", async () => {
    const capture = autoDownloadCapture();
    const baseDir = mkdtempSync(join(tmpdir(), "anys-self-update-settings-"));
    const spawned = [];
    try {
      withSettings(baseDir, { autoDownloadUpdates: true });
      await withPanel({
        base: { LOCALAPPDATA: baseDir },
        releaseService: selfUpdateReleaseService(),
        spawnSelfUpdateWorkerFn: (request) => { spawned.push(request); return process.pid; },
        ...capture,
      }, async (get, post, ctx) => {
        assert.ok(capture.captured.pump, "the auto-download cadence must be armed on panel-host");
        await capture.captured.pump();
        const runs = (await get("/panel/api/self-update/active")).body;
        assert.equal(runs.runs.length, 1, "one download run must be registered");
        assert.equal(runs.runs[0].step, "download");
        assert.equal(runs.runs[0].phase, "staging");
        assert.equal(spawned.length, 1);
        // 已有在跑任务时再泵一拍：不重复登记。
        await capture.captured.pump();
        assert.equal(spawned.length, 1);
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test("自动下载的记录不带 autoApply（只下载，绝不自动应用）", async () => {
    const capture = autoDownloadCapture();
    const baseDir = mkdtempSync(join(tmpdir(), "anys-self-update-settings-"));
    const spawned = [];
    try {
      withSettings(baseDir, { autoDownloadUpdates: true });
      await withPanel({
        base: { LOCALAPPDATA: baseDir },
        releaseService: selfUpdateReleaseService(),
        spawnSelfUpdateWorkerFn: (request) => { spawned.push(request); return process.pid; },
        ...capture,
      }, async (get, post) => {
        await capture.captured.pump();
        assert.equal(spawned.length, 1);
        const recorded = readClientUpdateRun(spawned[0].journalDir, spawned[0].runId);
        assert.notEqual(recorded.autoApply, true, "自动下载停在「已下载待应用」，绝不自动应用");
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test("默认关（设置里没有这个键）：一拍什么都不登记", async () => {
    const capture = autoDownloadCapture();
    const baseDir = mkdtempSync(join(tmpdir(), "anys-self-update-settings-"));
    const spawned = [];
    try {
      withSettings(baseDir, {});
      await withPanel({
        base: { LOCALAPPDATA: baseDir },
        releaseService: selfUpdateReleaseService(),
        spawnSelfUpdateWorkerFn: (request) => { spawned.push(request); return process.pid; },
        ...capture,
      }, async () => {
        await capture.captured.pump();
        assert.equal(spawned.length, 0);
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test("设置显式关闭：一拍什么都不登记", async () => {
    const capture = autoDownloadCapture();
    const baseDir = mkdtempSync(join(tmpdir(), "anys-self-update-settings-"));
    const spawned = [];
    try {
      withSettings(baseDir, { autoDownloadUpdates: false });
      await withPanel({
        base: { LOCALAPPDATA: baseDir },
        releaseService: selfUpdateReleaseService(),
        spawnSelfUpdateWorkerFn: (request) => { spawned.push(request); return process.pid; },
        ...capture,
      }, async () => {
        await capture.captured.pump();
        assert.equal(spawned.length, 0);
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test("已有待应用记录：不重复下载（同一个版本攒两份没有意义）", async () => {
    const capture = autoDownloadCapture();
    const baseDir = mkdtempSync(join(tmpdir(), "anys-self-update-settings-"));
    const spawned = [];
    try {
      withSettings(baseDir, { autoDownloadUpdates: true });
      await withPanel({
        base: { LOCALAPPDATA: baseDir },
        releaseService: selfUpdateReleaseService(),
        spawnSelfUpdateWorkerFn: (request) => { spawned.push(request); return process.pid; },
        ...capture,
      }, async (get, post, ctx) => {
        writeClientUpdateRun(ctx.journalDir, stagedRun());
        await capture.captured.pump();
        assert.equal(spawned.length, 0);
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

// ── 陈旧 staged 的有效性判定（本地领先远端时不再呈现、不再可应用）──────────
describe("staged 有效性判定", () => {
  test("稳定轨目标 ≤ 当前版本：active 不再给出 staged，记录被标记 stale，apply 拒绝", async () => {
    const spawned = [];
    await withPanel({
      appInfo: { version: "0.7.0", platform: "win32", nodeVersion: "v24.18.0", prerelease: false },
      spawnSelfUpdateWorkerFn: (request) => { spawned.push(request); return process.pid; },
    }, async (get, post, ctx) => {
      // 目标 0.7.0 == 当前 0.7.0：下载后本地经别的途径已经到过它，横幅与按钮都该消失。
      writeClientUpdateRun(ctx.journalDir, stagedRun());
      const active = (await get("/panel/api/self-update/active")).body;
      assert.equal(active.staged, null, "陈旧 staged 不再呈现");
      const apply = await post("/panel/api/self-update/apply", { runId: RUN_ID });
      assert.equal(apply.status, 409);
      assert.equal(apply.body.error, "no_staged");
      assert.equal(spawned.length, 0);
      const marked = readClientUpdateRun(ctx.journalDir, RUN_ID);
      assert.equal(marked.stale, true, "记录被标记 stale，之后不再被捞起");
      assert.equal(marked.result.outcome, "downloaded", "结论保持原样（/last 补显通道不受影响）");
      assert.equal((await get("/panel/api/self-update/active")).body.staged, null);
    });
  });

  test("稳定轨目标高于当前版本：staged 照常给出（正常停留态不受影响）", async () => {
    await withPanel({}, async (get, post, ctx) => {
      writeClientUpdateRun(ctx.journalDir, stagedRun());
      const active = (await get("/panel/api/self-update/active")).body;
      assert.equal(active.staged?.runId, RUN_ID);
      assert.equal(readClientUpdateRun(ctx.journalDir, RUN_ID).stale, undefined);
    });
  });

  test("先行轨目标已是本地 HEAD：staged 失效并标记 stale", async () => {
    const SHA = "fedcba0987654321fedcba0987654321fedcba09";
    await withPanel({
      readLocalHeadFn: async () => ({ sha: SHA, short: "fedcba0" }),
    }, async (get, post, ctx) => {
      writeClientUpdateRun(ctx.journalDir, stagedRun({
        track: "bleeding", targetSha: SHA, targetVersion: "0.6.7", targetTag: null,
        result: { outcome: "downloaded", message: "已下载 fedcba0，应用后生效", beforeVersion: "0.6.1-preview", latestVersion: "0.6.7" },
      }));
      const active = (await get("/panel/api/self-update/active")).body;
      assert.equal(active.staged, null, "目标提交已在本地：不呈现");
      assert.equal(readClientUpdateRun(ctx.journalDir, RUN_ID).staleReason, "already_at_target");
    });
  });
});

// ── 先行轨道：检查、登记、回退计划与逆更新 ────────────────────────────
describe("先行轨道（bleedingEdgeMode）", () => {
  const LOCAL_SHA = "0123456789abcdef0123456789abcdef01234567";
  const MAIN_SHA = "fedcba0987654321fedcba0987654321fedcba09";
  const identityFns = {
    readLocalHeadFn: async () => ({ sha: LOCAL_SHA, short: "0123456" }),
    readRemoteRefsFn: async () => ({
      headSha: MAIN_SHA,
      tags: new Map([
        ["v0.6.6", "cccccccccccccccccccccccccccccccccccccccc"],
        ["v0.6.5", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      ]),
    }),
  };

  function bleedingSettings(baseDir) {
    mkdirSync(join(baseDir, "Anyswitch"), { recursive: true });
    writeFileSync(join(baseDir, "Anyswitch", "settings.json"), JSON.stringify({ bleedingEdgeMode: true }));
  }

  test("检查更新走提交比对：/api/updates 给出先行轨状态与双方身份", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "anys-bleeding-"));
    try {
      bleedingSettings(baseDir);
      await withPanel({
        base: { LOCALAPPDATA: baseDir },
        releaseService: selfUpdateReleaseService("current"),
        ...identityFns,
      }, async (get, post) => {
        const result = (await get("/panel/api/updates?refresh=1")).body;
        assert.equal(result.track, "bleeding");
        assert.equal(result.identity, true);
        assert.equal(result.state, "update_available", "本地 HEAD ≠ 远端最新提交：有先行更新");
        assert.equal(result.remoteSha, MAIN_SHA);
        assert.equal(result.remoteCommit, "fedcba0");
        assert.equal(result.currentCommit, "0123456");
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test("本地已跟上远端最新提交：state=current；远端不可达：state=error（不新增报错形态）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "anys-bleeding-"));
    try {
      bleedingSettings(baseDir);
      await withPanel({
        base: { LOCALAPPDATA: baseDir },
        releaseService: selfUpdateReleaseService("current"),
        readLocalHeadFn: identityFns.readLocalHeadFn,
        readRemoteRefsFn: async () => ({ headSha: LOCAL_SHA, tags: new Map([["v0.6.6", "cccccccccccccccccccccccccccccccccccccccc"]]) }),
      }, async (get) => {
        assert.equal((await get("/panel/api/updates?refresh=1")).body.state, "current");
      });
      await withPanel({
        base: { LOCALAPPDATA: baseDir },
        releaseService: selfUpdateReleaseService("current"),
        readLocalHeadFn: identityFns.readLocalHeadFn,
        readRemoteRefsFn: async () => null,
      }, async (get) => {
        const body = (await get("/panel/api/updates?refresh=1")).body;
        assert.equal(body.state, "error");
        assert.equal(body.track, "bleeding");
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test("无本地 git 身份（镜像安装未引导）：按稳定轨口径回答（identity=false）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "anys-bleeding-"));
    try {
      bleedingSettings(baseDir);
      await withPanel({
        base: { LOCALAPPDATA: baseDir },
        releaseService: selfUpdateReleaseService("update_available"),
        readLocalHeadFn: async () => null,
      }, async (get) => {
        const body = (await get("/panel/api/updates?refresh=1")).body;
        assert.equal(body.track, "bleeding");
        assert.equal(body.identity, false);
        assert.equal(body.state, "update_available", "版本号比较照常给出结论");
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test("POST /api/self-update（先行轨）：按 remoteSha 登记 bleeding run，无 tag/版本", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "anys-bleeding-"));
    const spawned = [];
    try {
      bleedingSettings(baseDir);
      await withPanel({
        base: { LOCALAPPDATA: baseDir },
        releaseService: selfUpdateReleaseService("current"),
        spawnSelfUpdateWorkerFn: (request) => { spawned.push(request); return process.pid; },
        ...identityFns,
      }, async (get, post, ctx) => {
        const result = await post("/panel/api/self-update", {});
        assert.equal(result.status, 202);
        assert.equal(result.body.step, "download");
        assert.equal(result.body.targetSha, MAIN_SHA);
        assert.equal(result.body.targetVersion, null);
        const run = readClientUpdateRun(ctx.journalDir, result.body.runId);
        assert.equal(run.track, "bleeding");
        assert.equal(run.targetSha, MAIN_SHA);
        assert.equal(run.targetTag, null);
        assert.equal(spawned.length, 1);
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test("GET /api/self-update/bleeding-plan：HEAD 不在 tag 上 → 回退到本地版本之下最近的 tag", async () => {
    await withPanel({
      appInfo: { version: "0.6.6", platform: "win32", nodeVersion: "v24.18.0", prerelease: false },
      ...identityFns,
    }, async (get) => {
      const plan = (await get("/panel/api/self-update/bleeding-plan")).body;
      assert.equal(plan.ok, true);
      assert.equal(plan.onStableNode, false);
      assert.equal(plan.baseTag, "v0.6.6");
      assert.equal(plan.baseVersion, "0.6.6");
    });
  });

  test("HEAD 恰在远端 tag 上：onStableNode=true（就地关闭）；远端不可达：ok=false", async () => {
    await withPanel({
      ...identityFns,
      readRemoteRefsFn: async () => ({ headSha: MAIN_SHA, tags: new Map([["v0.6.6", LOCAL_SHA], ["v0.6.5", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]]) }),
    }, async (get) => {
      const plan = (await get("/panel/api/self-update/bleeding-plan")).body;
      assert.equal(plan.ok, true);
      assert.equal(plan.onStableNode, true);
      assert.equal(plan.baseVersion, "0.6.6");
    });
    await withPanel({
      ...identityFns,
      readRemoteRefsFn: async () => null,
    }, async (get) => {
      assert.equal((await get("/panel/api/self-update/bleeding-plan")).body.ok, false);
    });
  });

  test("POST /api/self-update/rollback：登记 step=apply 的 rollback run 并布换装监听器", async () => {
    const spawned = [];
    const watch = { scheduled: 0 };
    await withPanel({
      ...identityFns,
      spawnSelfUpdateWorkerFn: (request) => { spawned.push(request); return 424242; },
      selfUpdateWatchScheduleFn: (fn) => { watch.scheduled += 1; return 42; },
      selfUpdateWatchCancelFn: () => {},
    }, async (get, post, ctx) => {
      const result = await post("/panel/api/self-update/rollback", {});
      assert.equal(result.status, 202);
      assert.equal(result.body.step, "apply");
      assert.equal(result.body.track, "rollback");
      assert.equal(result.body.targetVersion, "0.6.6");
      const run = readClientUpdateRun(ctx.journalDir, result.body.runId);
      assert.equal(run.track, "rollback");
      assert.equal(run.targetTag, "v0.6.6");
      assert.equal(run.phase, "installing");
      assert.equal(spawned.length, 1);
      assert.equal(watch.scheduled, 1, "回退同样要布换装监听器");
    });
  });

  test("rollback：远端不可达：409，不登记不拉起", async () => {
    const spawned = [];
    await withPanel({
      ...identityFns,
      readRemoteRefsFn: async () => null,
      spawnSelfUpdateWorkerFn: (request) => { spawned.push(request); return process.pid; },
    }, async (get, post) => {
      const result = await post("/panel/api/self-update/rollback", {});
      assert.equal(result.status, 409);
      assert.equal(result.body.error, "no_rollback");
      assert.equal(spawned.length, 0);
    });
  });

  test("先行换装监听器：本地身份未对上→点火；已是目标提交→不自杀刚接班的自己", async () => {
    const SHA = "fedcba0987654321fedcba0987654321fedcba09";
    const stagedBleeding = () => stagedRun({
      track: "bleeding", targetSha: SHA, targetVersion: "0.6.7", targetTag: null,
      result: { outcome: "downloaded", message: "已下载 fedcba0，应用后生效", beforeVersion: "0.6.1-preview", latestVersion: "0.6.7" },
    });
    // 与「自更新换装监听器」describe 里的 watchCapture 同形（那是它的局部函数）。
    const watchCaptureLocal = () => {
      const watch = { pumps: [], canceled: 0, restarts: 0, exits: [] };
      return {
        watch,
        selfUpdateWatchScheduleFn: (fn) => { watch.pumps.push(fn); return 42; },
        selfUpdateWatchCancelFn: () => { watch.canceled += 1; },
        spawnPanelHostRestartFn: () => { watch.restarts += 1; return 99; },
        exitPanelHostFn: (code) => { watch.exits.push(code); },
      };
    };
    // 场景一（点火）：本地 HEAD 不是目标提交 → 异步续体确认后拉起换装。
    const fired = watchCaptureLocal();
    await withPanel({
      readLocalHeadFn: async () => ({ sha: "0123456789abcdef0123456789abcdef01234567", short: "0123456" }),
      ...fired,
    }, async (get, post, ctx) => {
      writeClientUpdateRun(ctx.journalDir, stagedBleeding());
      await post("/panel/api/self-update/apply", { runId: RUN_ID });
      assert.equal(fired.watch.pumps.length, 1, "apply 布上换装监听器");
      const running = readClientUpdateRun(ctx.journalDir, RUN_ID);
      writeClientUpdateRun(ctx.journalDir, { ...running, phase: "waiting-panel" });
      fired.watch.pumps[0]();
      await sleep(50);
      assert.equal(fired.watch.restarts, 1, "身份未对上：拉起换装");
      assert.equal(fired.watch.canceled, 1);
    });
    // 场景二（不点火）：本地已换装到目标提交（新面板接班）——绝不点火自杀。
    // 用启动接管形态模拟：路由创建前 journal 里就有进行中的先行 apply run。
    const quiet = watchCaptureLocal();
    const journalDir = mkdtempSync(join(tmpdir(), "anys-bleeding-pump-"));
    try {
      writeClientUpdateRun(journalDir, {
        runId: RUN_ID, clientId: "anyswitch", action: "update", step: "apply", state: "running",
        startedAt: "2026-10-09T00:00:00.000Z", finishedAt: null, result: null, workerPid: process.pid,
        track: "bleeding", targetSha: SHA, targetVersion: "0.6.7", targetTag: null, phase: "waiting-panel",
      });
      await withPanel({
        clientUpdateJournalDir: journalDir,
        readLocalHeadFn: async () => ({ sha: SHA, short: "fedcba0" }),
        ...quiet,
      }, async (get, post) => {
        assert.equal(quiet.watch.pumps.length, 1, "启动接管：进行中的 run 会布上监听器");
        quiet.watch.pumps[0]();
        await sleep(50);
        assert.equal(quiet.watch.restarts, 0, "已是目标提交：不点火");
        assert.equal(quiet.watch.canceled, 0);
      });
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });
});

// ── 稳定轨的不一致判定（ahead / 安装游离）───────────────────────────────
describe("稳定轨不一致判定（drift）", () => {
  test("版本一致但 HEAD 不在 tag 上：state=current 且 drift.offTag=true", async () => {
    const identity = {
      readLocalHeadFn: async () => ({ sha: "dddddddddddddddddddddddddddddddddddddddd", short: "ddddddd" }),
      readRemoteRefsFn: async () => ({ headSha: "fedcba0987654321fedcba0987654321fedcba09", tags: new Map([["v0.6.6", "cccccccccccccccccccccccccccccccccccccccc"]]) }),
    };
    // 与真实 release-service 同形：current 态也带 release（版本一致才有 current）。
    await withPanel({
      appInfo: { version: "0.6.6", platform: "win32", nodeVersion: "v24.18.0", prerelease: false },
      releaseService: { getAppUpdate: async () => ({
        currentVersion: "0.6.6", state: "current", checkedAt: "2026-10-15T00:00:00.000Z",
        release: { version: "0.6.6", tag: "v0.6.6", prerelease: false, url: "https://github.com/Aurora0134/Anyswitch/releases/tag/v0.6.6" },
        errorCode: null,
      }) },
      ...identity,
    }, async (get) => {
      const body = (await get("/panel/api/updates?refresh=1")).body;
      assert.equal(body.state, "current");
      assert.equal(body.track, "stable");
      assert.equal(body.drift.ahead, false);
      assert.equal(body.drift.offTag, true);
      assert.equal(body.drift.remoteVersion, "0.6.6");
    });
  });

  test("有可用更新时不判 drift；无 git 身份只判 ahead（跳过 HEAD 维度）", async () => {
    await withPanel({
      appInfo: { version: "0.6.1-preview", platform: "win32", nodeVersion: "v24.18.0", prerelease: true },
      releaseService: selfUpdateReleaseService("update_available"),
      readLocalHeadFn: async () => ({ sha: "dddddddddddddddddddddddddddddddddddddddd", short: "ddddddd" }),
      readRemoteRefsFn: async () => ({ headSha: "x", tags: new Map() }),
    }, async (get) => {
      const body = (await get("/panel/api/updates?refresh=1")).body;
      assert.equal(body.drift, null, "update_available 不叠加不一致提示");
    });
    await withPanel({
      appInfo: { version: "0.6.1-preview", platform: "win32", nodeVersion: "v24.18.0", prerelease: true },
      releaseService: selfUpdateReleaseService("ahead"),
      readLocalHeadFn: async () => null,
    }, async (get) => {
      const body = (await get("/panel/api/updates?refresh=1")).body;
      assert.equal(body.state, "ahead");
      assert.equal(body.drift.ahead, true);
      assert.equal(body.drift.offTag, null, "无本地身份时跳过 HEAD 维度");
      assert.equal(body.drift.localCommit, null);
    });
  });
});

describe("GET /panel/api/status 的 selfUpdate 捎带", () => {
  // 捎带是页面级观察者的唯一数据源：有 running 给 running，否则给 15 分钟内
  // 最近一条 done（新完成的结论让观察者补一次提示），再没有就 null。
  // runId 必须 UUID 形态：journal 读写按 RUN_ID 形态校验，不合形态的记录读不回。
  const runningRecord = () => ({
    runId: "00000000-0000-4000-8000-0000000000a1",
    clientId: "anyswitch",
    action: "update",
    step: "download",
    state: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    workerPid: process.pid,
    track: "stable",
    targetVersion: "0.7.0",
    targetTag: "v0.7.0",
    phase: "staging",
  });

  test("无记录：null（前端观察者按无任务处理）", async () => {
    await withPanel({}, async (get) => {
      const body = (await get("/panel/api/status")).body;
      assert.equal(body.selfUpdate, null);
    });
  });

  test("进行中的记录：原样捎带 phase/step", async () => {
    await withPanel({}, async (get, post, ctx) => {
      writeClientUpdateRun(ctx.journalDir, runningRecord());
      const body = (await get("/panel/api/status")).body;
      assert.equal(body.selfUpdate.runId, "00000000-0000-4000-8000-0000000000a1");
      assert.equal(body.selfUpdate.state, "running");
      assert.equal(body.selfUpdate.phase, "staging");
      assert.equal(body.selfUpdate.step, "download");
    });
  });

  test("刚完成的结论（15 分钟内）：捎带终态 outcome", async () => {
    await withPanel({}, async (get, post, ctx) => {
      writeClientUpdateRun(ctx.journalDir, {
        ...stagedRun({ runId: "00000000-0000-4000-8000-0000000000a2" }),
        finishedAt: new Date(Date.now() - 60 * 1000).toISOString(),
      });
      const body = (await get("/panel/api/status")).body;
      assert.equal(body.selfUpdate.runId, "00000000-0000-4000-8000-0000000000a2");
      assert.equal(body.selfUpdate.state, "done");
      assert.equal(body.selfUpdate.outcome, "downloaded");
    });
  });

  test("超过 15 分钟的旧结论：不捎带（补显窗口由 /last 单独管）", async () => {
    await withPanel({}, async (get, post, ctx) => {
      writeClientUpdateRun(ctx.journalDir, {
        ...stagedRun({ runId: "00000000-0000-4000-8000-0000000000a3" }),
        finishedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      });
      const body = (await get("/panel/api/status")).body;
      assert.equal(body.selfUpdate, null);
    });
  });
});

describe("自更新页面级观察者（panel.js createSelfUpdateFrameWatcher）", () => {
  const panelJs = readFileSync(new URL("./panel-ui/panel.js", import.meta.url), "utf8");

  function watcherHarness() {
    const match = panelJs.match(/  function createSelfUpdateFrameWatcher\([\s\S]*?\n  \}/);
    assert.ok(match, "watcher factory must exist in panel.js");
    const storage = new Map();
    const localStorage = {
      getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
      setItem: (key, value) => storage.set(String(key), String(value)),
    };
    const factory = vm.runInNewContext(`(${match[0]})`, { localStorage });
    const toasts = [];
    const swaps = [];
    const flags = { restarting: false, startupRestart: false };
    let aboutTracking = false;
    const watcher = factory({
      toast: (message, isErr) => toasts.push({ message, isErr }),
      dispatchSwap: () => swaps.push(1),
      isPanelRestarting: () => flags.restarting,
      isStartupRestartPage: () => flags.startupRestart,
    });
    watcher.setAboutProbe(() => aboutTracking);
    const doneFrame = (outcome, message = `结论 ${outcome}`) => ({
      runId: "r1", state: "done", step: "apply", phase: "waiting-panel",
      outcome, message, finishedAt: "2026-10-23T00:00:00.000Z", targetVersion: "0.7.0",
    });
    return {
      watcher,
      toasts,
      swaps,
      flags,
      storage,
      frame: (payload) => watcher.frame(payload),
      doneFrame,
      setTracking: (value) => { aboutTracking = value; },
    };
  }

  test("running / downloaded / 无任务帧：什么都不触发", () => {
    const h = watcherHarness();
    h.frame({ runId: "r1", state: "running", step: "download", phase: "staging", outcome: null });
    h.frame({ runId: "r1", state: "done", outcome: "downloaded", message: "已下载 0.7.0，应用后生效" });
    h.frame(null);
    assert.equal(h.toasts.length, 0);
    assert.equal(h.swaps.length, 0);
    assert.equal(h.storage.size, 0, " downloaded 停留态不是收场：不落已读");
  });

  test("无刷新终态（失败/回滚/待重启生效）：toast 一次并落已读，重帧不重弹", () => {
    const h = watcherHarness();
    for (const [outcome, isErr] of [["failed", true], ["rolled_back", true], ["updated_pending_restart", false]]) {
      h.frame(h.doneFrame(outcome));
      assert.equal(h.toasts.length, 1, `${outcome} 就地提示一次`);
      assert.equal(h.toasts[0].isErr, isErr);
      assert.equal(h.storage.get("anyswitch:self-update-shown:r1"), "1");
      h.frame(h.doneFrame(outcome));
      assert.equal(h.toasts.length, 1, "已读标记压制重弹");
      h.storage.clear();
      h.toasts.length = 0;
    }
  });

  test("updated 终态：派换装事件（恰一次），不 toast 不落已读——结论归换装后的新页面补显", () => {
    const h = watcherHarness();
    h.frame(h.doneFrame("updated", "已更新到 0.7.0"));
    assert.equal(h.swaps.length, 1);
    assert.equal(h.toasts.length, 0);
    assert.equal(h.storage.get("anyswitch:self-update-shown:r1"), undefined, "已读不落：换装后的新页面要经 /last 补显一次");
    h.frame(h.doneFrame("updated", "已更新到 0.7.0"));
    assert.equal(h.swaps.length, 1, "同一 run 只派一次，恢复失败也不反复重派");
  });

  test("归属让位：关于页跟踪、恢复在途、重启恢复页都不抢提示", () => {
    const h = watcherHarness();
    h.setTracking(true);
    h.frame(h.doneFrame("failed"));
    assert.equal(h.toasts.length, 0, "关于页在跟踪：提示归它");
    h.setTracking(false);
    h.frame(h.doneFrame("failed"));
    assert.equal(h.toasts.length, 1, "关于页放弃后观察者接管");

    const restarting = watcherHarness();
    restarting.flags.restarting = true;
    restarting.frame(restarting.doneFrame("updated"));
    assert.equal(restarting.swaps.length, 0, "恢复监视在途：换装事件已由发起方派过");

    const revived = watcherHarness();
    revived.flags.startupRestart = true;
    revived.frame(revived.doneFrame("failed"));
    assert.equal(revived.toasts.length, 0, "本页就是换装产物：结论由 /last 补显通道负责");
  });
});
