import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeClientUpdate,
  listClientUpdateRuns,
  readClientUpdateRun,
  reapDeadClientUpdateRuns,
  spawnClientUpdateWorker,
  writeClientUpdateRun,
} from "./client-update-journal.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "anys-client-update-"));
}

function running(overrides = {}) {
  return {
    runId: "11111111-1111-1111-1111-111111111111",
    clientId: "claude",
    action: "update",
    state: "running",
    startedAt: "2026-09-26T00:00:00.000Z",
    finishedAt: null,
    result: null,
    workerPid: null,
    targetVersion: null,
    commandPath: "C:/fixture/claude",
    ...overrides,
  };
}

test("进程已经不在的进行中记录按中断收尾，活着的不动", () => {
  const dir = scratch();
  try {
    writeClientUpdateRun(dir, running({ workerPid: 41 }));
    writeClientUpdateRun(dir, running({ runId: "22222222-2222-2222-2222-222222222222", clientId: "codex", workerPid: 42 }));
    reapDeadClientUpdateRuns(dir, (pid) => pid === 42, () => "2026-09-26T00:01:00.000Z");
    const dead = readClientUpdateRun(dir, "11111111-1111-1111-1111-111111111111");
    assert.equal(dead.state, "done");
    assert.equal(dead.result.outcome, "failed");
    assert.match(dead.result.message, /更新中断/);
    const live = readClientUpdateRun(dir, "22222222-2222-2222-2222-222222222222");
    assert.equal(live.state, "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("安装跑完后记录带上新版本与比对结论，面板进程不参与", async () => {
  const dir = scratch();
  try {
    writeClientUpdateRun(dir, running({ beforeVersion: "1.0.0" }));
    const seen = [];
    const result = await executeClientUpdate({
      runId: running().runId,
      journalDir: dir,
      runLifecycle: async (request) => {
        seen.push(request);
        return { ok: true, output: "" };
      },
      environment: {
        async getState(options = {}) {
          return {
            clients: [{
              id: "claude",
              installations: [{ version: options.force ? "1.1.0" : "1.0.0", path: "C:/fixture/claude", issue: null }],
            }],
          };
        },
      },
      releases: { async getClientLatest() { return { state: "ok", version: "1.1.0" }; } },
      compareVersions: (left, right) => (left === right ? 0 : -1),
      alive: () => true,
      now: () => "2026-09-26T00:02:00.000Z",
    });
    assert.equal(result.outcome, "updated");
    assert.equal(seen[0].targetVersion, null);
    assert.equal(seen[0].commandPath, "C:/fixture/claude");
    const stored = readClientUpdateRun(dir, running().runId);
    assert.equal(stored.state, "done");
    assert.equal(stored.result.afterVersion, "1.1.0");
    assert.equal(stored.result.comparison, "current");
    assert.equal(listClientUpdateRuns(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("拉起安装进程时脱离父进程并丢掉管道", () => {
  const calls = [];
  const pid = spawnClientUpdateWorker({
    runId: "33333333-3333-3333-3333-333333333333",
    journalDir: "C:/journal",
    execPath: "C:/node.exe",
    workerPath: "C:/worker.mjs",
    spawnFn: (file, args, options) => {
      calls.push({ file, args, options });
      return { pid: 77, unref() { calls[0].unrefed = true; } };
    },
  });
  assert.equal(pid, 77);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].unrefed, true);
  assert.deepEqual(calls[0].args, ["C:/worker.mjs", "33333333-3333-3333-3333-333333333333", "C:/journal"]);
});

function codexEnvironment(cliAfter, desktopAfter) {
  return {
    async getState(options = {}) {
      assert.equal(options.force, true, "worker 不再有非 force 预读：before 由面板登记，装完只 force 重读");
      return {
        clients: [{
          id: "codex",
          installations: [
            { kind: "cli", version: cliAfter, path: "C:/fixture/codex", issue: null, remoteId: "codex" },
            { kind: "desktop", version: desktopAfter, path: "C:/fixture/codex-app", issue: null },
          ],
        }],
      };
    },
  };
}

function codexHarness(dir, legs, environment) {
  return executeClientUpdate({
    runId: running().runId,
    journalDir: dir,
    runLifecycle: async () => ({ ok: legs.every((leg) => leg.ok), output: "", legs }),
    environment,
    releases: { async getClientLatest() { return { state: "ok", version: "0.158.0" }; } },
    compareVersions: (left, right) => (left === right ? 0 : -1),
    alive: () => true,
    now: () => "2026-09-28T00:02:00.000Z",
  });
}

test("多腿客户端逐腿记录前后版本，全成时逐形态一句、顶层 updated", async () => {
  const dir = scratch();
  try {
    writeClientUpdateRun(dir, running({ clientId: "codex", beforeVersion: "0.150.0", beforeByForm: { cli: "0.150.0", desktop: "26.900.0" } }));
    const result = await codexHarness(dir,
      [{ form: "cli", ok: true }, { form: "desktop", ok: true }],
      codexEnvironment("0.158.0", "26.930.0"));
    assert.equal(result.outcome, "updated");
    assert.deepEqual(result.legs.map((leg) => leg.form), ["cli", "desktop"]);
    assert.deepEqual(result.legs.map((leg) => leg.outcome), ["updated", "updated"]);
    assert.equal(result.legs[0].versionBefore, "0.150.0");
    assert.equal(result.legs[0].versionAfter, "0.158.0");
    assert.equal(result.legs[1].versionBefore, "26.900.0");
    assert.equal(result.message, "CLI 已更新到 0.158.0；Desktop 已更新到 26.930.0");
    const stored = readClientUpdateRun(dir, running().runId);
    assert.equal(stored.result.legs.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("多腿客户端一腿失败顶层即 failed，桌面失败按降级路径分句式", async () => {
  for (const [desktopLeg, sentence] of [
    [{ form: "desktop", ok: false, storePageOpened: true }, "Desktop 更新未完成，已打开应用商店页"],
    [{ form: "desktop", ok: false, wingetMissing: true }, "Desktop 更新工具缺失（winget），请安装后重试"],
    [{ form: "desktop", ok: false }, "Desktop 更新命令执行失败，请稍后重试"],
  ]) {
    const dir = scratch();
    try {
      writeClientUpdateRun(dir, running({ clientId: "codex", beforeVersion: "0.150.0", beforeByForm: { cli: "0.150.0", desktop: "26.900.0" } }));
      const result = await codexHarness(dir,
        [{ form: "cli", ok: true }, desktopLeg],
        codexEnvironment("0.158.0", "26.900.0"));
      assert.equal(result.outcome, "failed");
      assert.equal(result.legs[1].outcome, "failed");
      assert.equal(result.legs[1].versionAfter, "26.900.0", "失败腿也记录实际检测到的版本");
      assert.equal(result.message, `CLI 已更新到 0.158.0；${sentence}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("多腿客户端两腿都已最新时顶层 unchanged", async () => {
  const dir = scratch();
  try {
    writeClientUpdateRun(dir, running({ clientId: "codex", beforeVersion: "0.158.0", beforeByForm: { cli: "0.158.0", desktop: "26.930.0" } }));
    const result = await codexHarness(dir,
      [{ form: "cli", ok: true, noUpgrade: true }, { form: "desktop", ok: true, noUpgrade: true }],
      codexEnvironment("0.158.0", "26.930.0"));
    assert.equal(result.outcome, "unchanged");
    assert.equal(result.message, "CLI 已是最新；Desktop 已是最新");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("多腿 CLI 腿命令成功但版本原地踏步且官方仍有新版：在案保护如实报未变化，不谎报已更新", async () => {
  const dir = scratch();
  try {
    // 镜像源滞后的形状（grok 条目）：npm 退出码 0、版本没动、dist-tag 更高。
    writeClientUpdateRun(dir, running({ clientId: "codex", beforeVersion: "0.150.0", beforeByForm: { cli: "0.150.0", desktop: "26.900.0" } }));
    const result = await codexHarness(dir,
      [{ form: "cli", ok: true }, { form: "desktop", ok: true, noUpgrade: true }],
      codexEnvironment("0.150.0", "26.900.0"));
    assert.equal(result.outcome, "unchanged");
    assert.equal(result.legs[0].outcome, "unchanged");
    assert.equal(result.message, "CLI 更新已完成，但本地版本未变化，可能仍有旧版本在生效；Desktop 已是最新");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("多腿 CLI 腿版本原地踏步但官方同版（已是真最新）：与单腿分支同语义，仍计 updated", async () => {
  const dir = scratch();
  try {
    // 钉死与单腿 HEAD 分支的语义对齐：comparison 是 current 而不是 update_available
    // 时不走「未变化」保护（单腿从来如此；若日后要收紧，两条分支必须一起改）。
    writeClientUpdateRun(dir, running({ clientId: "codex", beforeVersion: "0.158.0", beforeByForm: { cli: "0.158.0", desktop: "26.930.0" } }));
    const result = await codexHarness(dir,
      [{ form: "cli", ok: true }, { form: "desktop", ok: true, noUpgrade: true }],
      codexEnvironment("0.158.0", "26.930.0"));
    assert.equal(result.outcome, "updated");
    assert.equal(result.legs[0].outcome, "updated");
    assert.equal(result.message, "CLI 已更新到 0.158.0；Desktop 已是最新");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Claude 官渠 MSIX 腿：网络/在跑/成功三句 ──────────────────

// claude 检测只有 CLI 一条安装项（桌面版本不单独呈现），桌面腿 after 为空，
// 成功句的版本由官渠腿自己带回（leg.installedVersion）。
function claudeEnvironment(cliAfter) {
  return {
    async getState(options = {}) {
      assert.equal(options.force, true, "worker 不再有非 force 预读");
      return {
        clients: [{
          id: "claude",
          installations: [{ kind: "cli", version: cliAfter, path: "C:/fixture/claude", issue: null, remoteId: "claude" }],
        }],
      };
    },
  };
}

function claudeRun() {
  return {
    clientId: "claude",
    beforeVersion: "0.9.0",
    beforeByForm: { cli: "0.9.0", desktop: null },
  };
}

test("claude 官渠腿网络类失败报网络问题", async () => {
  const dir = scratch();
  try {
    const legs = [{ form: "cli", ok: true }, { form: "desktop", ok: false, networkError: true }];
    writeClientUpdateRun(dir, running(claudeRun()));
    const result = await codexHarness(dir, legs, claudeEnvironment("1.0.0"));
    assert.equal(result.outcome, "failed");
    assert.equal(result.legs[1].versionBefore, null, "claude 没有桌面安装项，桌面腿 before 为空");
    assert.equal(result.message, "CLI 已更新到 1.0.0；网络问题，请检查网络后重试");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude 桌面端在跑时提示先退出再重试", async () => {
  const dir = scratch();
  try {
    const legs = [{ form: "cli", ok: true }, { form: "desktop", ok: false, appRunning: true }];
    writeClientUpdateRun(dir, running(claudeRun()));
    const result = await codexHarness(dir, legs, claudeEnvironment("1.0.0"));
    assert.equal(result.outcome, "failed");
    assert.equal(result.message, "CLI 已更新到 1.0.0；Desktop 正在运行，请先退出 Claude 桌面端后重试");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude 官渠腿成功句带元数据版本，检测不到桌面版本也不落空", async () => {
  const dir = scratch();
  try {
    const legs = [{ form: "cli", ok: true }, { form: "desktop", ok: true, installedVersion: "2.9939.2" }];
    writeClientUpdateRun(dir, running(claudeRun()));
    const result = await codexHarness(dir, legs, claudeEnvironment("1.0.0"));
    assert.equal(result.outcome, "updated");
    assert.equal(result.legs[1].versionAfter, null, "环境检测不单独报桌面版本");
    assert.equal(result.message, "CLI 已更新到 1.0.0；Desktop 已更新到 2.9939.2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
