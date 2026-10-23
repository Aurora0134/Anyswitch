import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSelfUpdate, spawnSelfUpdateWorker, SELF_UPDATE_CLIENT_ID } from "./app-self-update.mjs";
import { readClientUpdateRun, writeClientUpdateRun } from "./client-update-journal.mjs";

const RUN_ID = "00000000-0000-4000-8000-000000000000";
const APP_DIR = "C:/app";
const REPO_URL = "https://github.com/Aurora0134/Anyswitch.git";
const NPM_CLI = join("/node", "node_modules", "npm", "bin", "npm-cli.js");
const NPM_ARGS = ["install", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org"];

function runningRun(overrides = {}) {
  return {
    runId: RUN_ID,
    clientId: SELF_UPDATE_CLIENT_ID,
    action: "update",
    step: "download",
    state: "running",
    startedAt: "2026-10-09T00:00:00.000Z",
    finishedAt: null,
    result: null,
    workerPid: null,
    targetVersion: "0.7.0",
    targetTag: "v0.7.0",
    beforeVersion: "0.6.1-preview",
    appDir: APP_DIR,
    repoUrl: REPO_URL,
    relayRoot: "C:/data",
    phase: "staging",
    ...overrides,
  };
}

// execFile 形态的脚本化替身：按 args 前缀匹配应答，记录每一次调用。
// git 与 npm 的调用在 args[0] 上天然可分（npm 的第一参是 npm-cli.js 路径）。
// git show FETCH_HEAD:package.json 默认应答目标版本（下载阶段的「不脱裤查验」）。
function fakeSpawn(script) {
  const calls = [];
  const spawnFn = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const reply = script({ file, args, options }, calls.length) ?? {};
    callback(reply.error ?? null, reply.stdout ?? "", reply.stderr ?? "");
    return { unref() {} };
  };
  return { spawnFn, calls };
}

const args0 = (...prefix) => (args) => prefix.every((arg, i) => args[i] === arg);
const npmCall = (call) => call.args[0] === NPM_CLI;
const gitShowPackage = (args) => args0("show", "FETCH_HEAD:package.json")(args);
const withTagVersion = (script, version = "0.7.0") => (call, n) => {
  if (gitShowPackage(call.args)) return { stdout: JSON.stringify({ version }) };
  return script(call, n);
};

// io 替身：app/.git 是否存在、package.json 的版本、npm-cli 可解析。
function fakeIo({ hasGit = true, version = "0.7.0", npmPresent = true } = {}) {
  return {
    existsSync: (p) => {
      const normalized = String(p).replaceAll("\\", "/");
      if (normalized.endsWith("/.git")) return hasGit;
      if (normalized.endsWith("/npm-cli.js")) return npmPresent;
      return false;
    },
    readFileSync: (p) => {
      if (String(p).replaceAll("\\", "/").endsWith("/package.json")) return JSON.stringify({ version });
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
}

// 假时钟：delay 推进时间，让退场/接管的超时窗口确定性地走完。
function fakeClock() {
  let t = 0;
  return { nowMs: () => t, delay: async (ms) => { t += ms; } };
}

// 探测面板的脚本化应答：按次序消费，末位元素重复。
function scriptedProbe(sequence) {
  const probe = { calls: 0 };
  const probePanelFn = async () => {
    const value = sequence[Math.min(probe.calls, sequence.length - 1)];
    probe.calls += 1;
    return value;
  };
  return { probePanelFn, probe };
}

function baseDeps(overrides = {}) {
  const journalDir = mkdtempSync(join(tmpdir(), "anys-self-update-"));
  const events = { relayRestarts: 0, watchdogStops: 0, watchdogSpawns: 0, panelHostSpawns: 0 };
  const clock = fakeClock();
  const deps = {
    runId: RUN_ID,
    journalDir,
    io: fakeIo(),
    spawnFn: fakeSpawn(withTagVersion(() => ({ stdout: "" }))).spawnFn,
    execPath: "/node/node.exe",
    env: {},
    fetchFn: async () => { throw new Error("no network in tests"); },
    restartRelayFn: async () => { events.relayRestarts += 1; return { ok: true }; },
    stopWatchdogFn: async () => { events.watchdogStops += 1; return { ok: true }; },
    probeWatchdogFn: async () => false,
    spawnWatchdogFn: async () => { events.watchdogSpawns += 1; return { ok: true }; },
    spawnPanelHostFn: () => { events.panelHostSpawns += 1; return 424242; },
    probePanelFn: async () => null,
    delay: clock.delay,
    now: () => "2026-10-09T01:00:00.000Z",
    nowMs: clock.nowMs,
    ...overrides,
  };
  return {
    deps,
    events,
    journalDir,
    cleanup: () => rmSync(journalDir, { recursive: true, force: true }),
  };
}

// journalDir 与真实链路同语义：就是 client-updates 目录本身，worker 直接读写。
function writeJournal(journalDir, run) {
  writeClientUpdateRun(journalDir, run);
}

function readJournal(journalDir) {
  return readClientUpdateRun(journalDir, RUN_ID);
}

describe("runSelfUpdate · download 阶段", () => {
  test("快乐路径：拉取 + 核版本后停在 staged，工作树与进程一个都不动", async () => {
    const git = fakeSpawn(withTagVersion(() => ({ stdout: "" })));
    const { deps, events, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn });
    writeJournal(journalDir, runningRun());
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "downloaded");
      assert.match(result.message, /已下载 0\.7\.0，应用后生效/);
      assert.ok(git.calls.some((call) => args0("fetch", "--depth", "1", "--no-tags", "origin", "tag", "v0.7.0")(call.args)), "download must shallow-pin the target tag");
      assert.ok(git.calls.some((call) => gitShowPackage(call.args)), "download must verify the tag's package.json without touching the tree");
      // 下载阶段的红线：不换装、不装依赖、不停 watchdog、不重启 relay、不拉起面板。
      assert.equal(git.calls.some((call) => args0("checkout")(call.args)), false, "download must never checkout");
      assert.equal(git.calls.some(npmCall), false, "download must never run npm");
      assert.equal(events.relayRestarts, 0);
      assert.equal(events.watchdogStops, 0);
      assert.equal(events.panelHostSpawns, 0);
      const done = readJournal(journalDir);
      assert.equal(done.state, "done");
      assert.equal(done.phase, "staged");
      assert.equal(done.result.outcome, "downloaded");
    } finally {
      cleanup();
    }
  });

  test("镜像安装首次引导：没有 .git 就 init + remote add，再正常下载", async () => {
    const git = fakeSpawn(withTagVersion(() => ({ stdout: "" })));
    const { deps, journalDir, cleanup } = baseDeps({
      io: fakeIo({ hasGit: false }),
      spawnFn: git.spawnFn,
    });
    writeJournal(journalDir, runningRun());
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "downloaded");
      assert.ok(git.calls.some((call) => args0("init")(call.args)), "bootstrap must git init");
      assert.ok(git.calls.some((call) => args0("remote", "add", "origin", REPO_URL)(call.args)));
    } finally {
      cleanup();
    }
  });

  test("remote 漂移被校正：origin 指向别处时 set-url 回权威源", async () => {
    const git = fakeSpawn(withTagVersion(
      ({ args }) => (args0("remote", "get-url", "origin")(args) ? { stdout: "https://github.com/someone/else.git\n" } : { stdout: "" }),
    ));
    const { deps, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn });
    writeJournal(journalDir, runningRun());
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "downloaded");
      assert.ok(git.calls.some((call) => args0("remote", "set-url", "origin", REPO_URL)(call.args)));
    } finally {
      cleanup();
    }
  });

  test("目标 tag 形态无效：直接失败，一个 git 命令都不发", async () => {
    const git = fakeSpawn(() => ({ stdout: "" }));
    const { deps, events, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn });
    writeJournal(journalDir, runningRun({ targetTag: "-bad" }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "failed");
      assert.match(result.message, /更新目标无效/);
      assert.equal(git.calls.length, 0);
      assert.equal(events.relayRestarts, 0);
    } finally {
      cleanup();
    }
  });

  test("tag 里的版本与目标不一致：中止，磁盘上什么都没动过", async () => {
    const git = fakeSpawn(withTagVersion(() => ({ stdout: "" }), "0.6.9"));
    const { deps, events, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn });
    writeJournal(journalDir, runningRun());
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "failed");
      assert.match(result.message, /不一致/);
      assert.equal(git.calls.some((call) => args0("checkout")(call.args)), false, "nothing to restore: the tree was never touched");
      assert.equal(events.relayRestarts, 0);
    } finally {
      cleanup();
    }
  });

  test("下载失败：网络/git 层面的失败如实收场", async () => {
    const git = fakeSpawn(withTagVersion(
      ({ args }) => (args0("fetch", "--depth", "1", "--no-tags", "origin", "tag", "v0.7.0")(args) ? { error: { code: 128 }, stderr: "fatal: could not read" } : { stdout: "" }),
    ));
    const { deps, events, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn });
    writeJournal(journalDir, runningRun());
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "failed");
      assert.match(result.message, /下载 v0.7.0/);
      assert.equal(result.detail, "fatal: could not read");
      assert.equal(events.relayRestarts, 0);
    } finally {
      cleanup();
    }
  });
});

describe("runSelfUpdate · apply 阶段", () => {
  test("快乐路径：补拉、换装、装依赖、重启 relay、等新面板接管，outcome=updated", async () => {
    const probe = scriptedProbe([{ version: "0.6.1-preview" }, null, { version: "0.7.0" }]);
    const git = fakeSpawn(withTagVersion(({ args }) => (args0("rev-parse", "HEAD")(args) ? { stdout: "abc123def\n" } : { stdout: "" })));
    const { deps, events, journalDir, cleanup } = baseDeps({
      spawnFn: git.spawnFn,
      probePanelFn: probe.probePanelFn,
    });
    writeJournal(journalDir, runningRun({ step: "apply", phase: "installing" }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "updated");
      assert.equal(result.beforeVersion, "0.6.1-preview");
      assert.equal(result.afterVersion, "0.7.0");
      // git 步骤的形状：幂等补拉钉 tag、强制 detach 检出、npm 在 app 目录里装。
      assert.ok(git.calls.some((call) => args0("fetch", "--depth", "1", "--no-tags", "origin", "tag", "v0.7.0")(call.args)), "apply re-fetches the tag idempotently");
      const checkoutCall = git.calls.find((call) => args0("checkout", "--detach", "--force", "FETCH_HEAD")(call.args));
      assert.ok(checkoutCall, "checkout must be a forced detach onto FETCH_HEAD");
      const npm = git.calls.find(npmCall);
      assert.ok(npm, "npm install must run through the local npm-cli");
      assert.deepEqual(npm.args.slice(1), NPM_ARGS);
      assert.equal(npm.options.cwd, APP_DIR);
      // 进程面：relay 换新一次、面板没有回滚拉起、watchdog 默认不在跑则不动。
      assert.equal(events.relayRestarts, 1);
      assert.equal(events.panelHostSpawns, 0);
      assert.equal(events.watchdogStops, 0);
      const done = readJournal(journalDir);
      assert.equal(done.state, "done");
      assert.equal(done.phase, "waiting-panel");
      assert.equal(done.result.outcome, "updated");
    } finally {
      cleanup();
    }
  });

  test("检出版本与目标不一致：还原工作树后收场，relay 与面板都没被动过", async () => {
    const { probePanelFn, probe } = scriptedProbe([{ version: "0.6.1-preview" }]);
    const git = fakeSpawn(withTagVersion(({ args }) => (args0("rev-parse", "HEAD")(args) ? { stdout: "abc123def\n" } : { stdout: "" })));
    const { deps, events, journalDir, cleanup } = baseDeps({
      io: fakeIo({ version: "0.6.9" }),
      spawnFn: git.spawnFn,
      probePanelFn,
    });
    writeJournal(journalDir, runningRun({ step: "apply", phase: "installing" }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "failed");
      assert.match(result.message, /不一致/);
      assert.match(result.message, /已还原/);
      assert.equal(result.afterVersion, "0.6.1-preview");
      // 中止还原：换装后必须把工作树退回记录的 HEAD，不留新代码配旧进程。
      assert.ok(git.calls.some((call) => args0("checkout", "--detach", "--force", "abc123def")(call.args)), "abort must restore the recorded HEAD");
      assert.equal(events.relayRestarts, 0);
      assert.equal(probe.calls, 0);
    } finally {
      cleanup();
    }
  });

  test("npm 缺失：如实报失败，不进入换装窗口", async () => {
    const { probePanelFn, probe } = scriptedProbe([{ version: "0.6.1-preview" }]);
    const { deps, events, journalDir, cleanup } = baseDeps({
      io: fakeIo({ npmPresent: false }),
      probePanelFn,
    });
    writeJournal(journalDir, runningRun({ step: "apply", phase: "installing" }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "failed");
      assert.match(result.message, /npm/);
      assert.equal(events.relayRestarts, 0);
      assert.equal(probe.calls, 0);
    } finally {
      cleanup();
    }
  });

  test("依赖安装失败：还原工作树后如实报失败", async () => {
    const { probePanelFn, probe } = scriptedProbe([{ version: "0.6.1-preview" }]);
    const git = fakeSpawn(withTagVersion(({ args }) => {
      if (args0("rev-parse", "HEAD")(args)) return { stdout: "abc123def\n" };
      if (args[0] === NPM_CLI) return { error: { code: 1 }, stderr: "npm error" };
      return { stdout: "" };
    }));
    const { deps, events, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn, probePanelFn });
    writeJournal(journalDir, runningRun({ step: "apply", phase: "installing" }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "failed");
      assert.match(result.message, /组件安装失败/);
      assert.match(result.message, /已还原/);
      assert.equal(result.afterVersion, "0.6.1-preview");
      assert.ok(git.calls.some((call) => args0("checkout", "--detach", "--force", "abc123def")(call.args)), "abort must restore the recorded HEAD");
      assert.equal(events.relayRestarts, 0);
      assert.equal(probe.calls, 0);
    } finally {
      cleanup();
    }
  });

  test("面板不退场：updated_pending_restart，不谎报已生效", async () => {
    const probe = scriptedProbe([{ version: "0.6.1-preview" }]);
    const { deps, events, journalDir, cleanup } = baseDeps({
      probeWatchdogFn: async () => true,
      probePanelFn: probe.probePanelFn,
    });
    writeJournal(journalDir, runningRun({ step: "apply", phase: "installing" }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "updated_pending_restart");
      assert.match(result.message, /重启面板后生效/);
      assert.equal(events.panelHostSpawns, 0);
      assert.equal(events.watchdogStops, 1);
      assert.equal(events.watchdogSpawns, 1);
    } finally {
      cleanup();
    }
  });

  test("换装抢在轮询前完成：down 等待直接见到新版本即算数，不误报 pending_restart", async () => {
    // 监听器在 ready-to-restart 就点火，relay 重启的几秒里面板已换完：
    // 探测从不见 null，但答话的已是目标版本——这就是换装完成。
    const probe = scriptedProbe([{ version: "0.6.1-preview" }, { version: "0.7.0" }]);
    const { deps, journalDir, cleanup } = baseDeps({
      spawnFn: fakeSpawn(withTagVersion(({ args }) => (args0("rev-parse", "HEAD")(args) ? { stdout: "abc123def\n" } : { stdout: "" }))).spawnFn,
      probePanelFn: probe.probePanelFn,
      restartRelayFn: async () => ({ ok: false }), // Relay 重启失败不得被 updated 吞掉
    });
    writeJournal(journalDir, runningRun({ step: "apply", phase: "installing" }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "updated");
      assert.match(result.message, /已更新到 0\.7\.0/);
      assert.match(result.message, /Relay 未能自动重启/);
    } finally {
      cleanup();
    }
  });

  test("新面板未接管且有恢复点：退回 beforeHead、重装依赖、重拉面板与 relay，outcome=rolled_back", async () => {
    const probe = scriptedProbe([
      { version: "0.6.1-preview" }, // 退场前仍在应答
      null,                          // 面板退场
      null,                          // 新面板迟迟不来（超时窗口内一直如此）
      { version: "0.6.1-preview" },  // 恢复后的旧面板回来了
    ]);
    const git = fakeSpawn(withTagVersion(({ args }) => (args0("rev-parse", "HEAD")(args) ? { stdout: "abc123def\n" } : { stdout: "" })));
    const { deps, events, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn, probePanelFn: probe.probePanelFn });
    writeJournal(journalDir, runningRun({ step: "apply", phase: "installing" }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "rolled_back");
      assert.match(result.message, /已恢复/);
      const rollback = git.calls.find((call) => args0("checkout", "--detach", "--force", "abc123def")(call.args));
      assert.ok(rollback, "rollback must force-checkout the recorded HEAD");
      // 恢复完整 = 旧代码配旧依赖：退回后必须再跑一次 npm install。
      assert.equal(git.calls.filter(npmCall).length, 2, "rollback must re-run npm install");
      assert.equal(events.panelHostSpawns, 1);
      assert.equal(events.relayRestarts, 2);
    } finally {
      cleanup();
    }
  });

  test("恢复后依赖重装失败：如实附加组件未完全恢复，不谎报恢复完整", async () => {
    const probe = scriptedProbe([
      { version: "0.6.1-preview" },
      null,
      null,
      { version: "0.6.1-preview" },
    ]);
    let npmCount = 0;
    const git = fakeSpawn(withTagVersion(({ args }) => {
      if (args0("rev-parse", "HEAD")(args)) return { stdout: "abc123def\n" };
      if (args[0] === NPM_CLI) {
        npmCount += 1;
        return npmCount === 2 ? { error: { code: 1 }, stderr: "npm error" } : { stdout: "" };
      }
      return { stdout: "" };
    }));
    const { deps, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn, probePanelFn: probe.probePanelFn });
    writeJournal(journalDir, runningRun({ step: "apply", phase: "installing" }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "rolled_back");
      assert.match(result.message, /运行组件未完全恢复/);
    } finally {
      cleanup();
    }
  });

  test("新面板未接管且无恢复点：尽力拉起面板并如实报 failed", async () => {
    const probe = scriptedProbe([{ version: "0.6.1-preview" }, null, null]);
    const git = fakeSpawn(withTagVersion(({ args }) => (args0("rev-parse", "HEAD")(args) ? { error: { code: 128 } } : { stdout: "" })));
    const { deps, events, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn, probePanelFn: probe.probePanelFn });
    writeJournal(journalDir, runningRun({ step: "apply", phase: "installing" }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "failed");
      assert.match(result.message, /没有可退回的旧版本/);
      assert.equal(events.panelHostSpawns, 1);
    } finally {
      cleanup();
    }
  });

  test("watchdog 在跑时：换装窗口先停、收尾恢复", async () => {
    const probe = scriptedProbe([null, { version: "0.7.0" }]);
    const { deps, events, journalDir, cleanup } = baseDeps({
      probeWatchdogFn: async () => true,
      probePanelFn: probe.probePanelFn,
    });
    writeJournal(journalDir, runningRun({ step: "apply", phase: "installing" }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "updated");
      assert.equal(events.watchdogStops, 1);
      assert.equal(events.watchdogSpawns, 1);
    } finally {
      cleanup();
    }
  });
});

describe("runSelfUpdate · autoApply 顺延（一键流水线）", () => {
  test("稳定轨：下载核验通过后原地续跑应用段，一个 runId 走到 updated，不停 staged", async () => {
    const probe = scriptedProbe([{ version: "0.6.1-preview" }, null, { version: "0.7.0" }]);
    const git = fakeSpawn(withTagVersion(({ args }) => (args0("rev-parse", "HEAD")(args) ? { stdout: "abc123def\n" } : { stdout: "" })));
    const { deps, events, journalDir, cleanup } = baseDeps({
      spawnFn: git.spawnFn,
      probePanelFn: probe.probePanelFn,
    });
    writeJournal(journalDir, runningRun({ autoApply: true }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "updated");
      assert.match(result.message, /已更新到 0\.7\.0/);
      // 下载与应用同一个 worker 接力：fetch 恰好两次（下载一次、应用幂等补拉一次），
      // 换装、装依赖、重启 relay 全都发生。
      const fetches = git.calls.filter((call) => args0("fetch", "--depth", "1", "--no-tags", "origin", "tag", "v0.7.0")(call.args));
      assert.equal(fetches.length, 2, "download fetch and apply re-fetch must share one worker");
      assert.ok(git.calls.some((call) => args0("checkout", "--detach", "--force", "FETCH_HEAD")(call.args)));
      assert.ok(git.calls.some(npmCall));
      assert.equal(events.relayRestarts, 1);
      // journal：下载后记录原地翻成 apply，终态直达 done，没有 staged 停留。
      const done = readJournal(journalDir);
      assert.equal(done.step, "apply");
      assert.equal(done.state, "done");
      assert.equal(done.result.outcome, "updated");
    } finally {
      cleanup();
    }
  });

  test("先行轨：版本号下载后回填并顺延进应用段，结论带提交标识", async () => {
    const TARGET_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const probe = scriptedProbe([{ version: "0.8.0", commit: "bbbbbbb" }, null, { version: "0.9.0", commit: "aaaaaaa" }]);
    const git = fakeSpawn(({ args }) => {
      if (args0("rev-parse", "FETCH_HEAD")(args) || args0("rev-parse", "HEAD")(args)) return { stdout: `${TARGET_SHA}\n` };
      if (gitShowPackage(args)) return { stdout: JSON.stringify({ version: "0.9.0" }) };
      return { stdout: "" };
    });
    const { deps, journalDir, cleanup } = baseDeps({
      io: fakeIo({ version: "0.9.0" }),
      spawnFn: git.spawnFn,
      probePanelFn: probe.probePanelFn,
    });
    writeJournal(journalDir, runningRun({ track: "bleeding", targetSha: TARGET_SHA, targetVersion: null, targetTag: null, autoApply: true }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "updated");
      assert.match(result.message, /已更新到 0\.9\.0-aaaaaaa/);
      // 先行轨按引用拉 HEAD：下载与补拉恰好两次。
      const fetches = git.calls.filter((call) => args0("fetch", "--depth", "1", "--no-tags", "origin", "HEAD")(call.args));
      assert.equal(fetches.length, 2);
      const done = readJournal(journalDir);
      assert.equal(done.step, "apply");
      assert.equal(done.targetVersion, "0.9.0", "下载阶段回填的版本号留在记录上");
      assert.equal(done.result.outcome, "updated");
    } finally {
      cleanup();
    }
  });

  test("顺延后应用段失败：回滚点还原照旧、不落 staged，outcome=failed", async () => {
    const git = fakeSpawn(withTagVersion(({ args }) => (args0("rev-parse", "HEAD")(args) ? { stdout: "abc123def\n" } : { stdout: "" })));
    const { deps, events, journalDir, cleanup } = baseDeps({
      io: fakeIo({ version: "0.6.9" }),
      spawnFn: git.spawnFn,
    });
    writeJournal(journalDir, runningRun({ autoApply: true }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "failed");
      assert.match(result.message, /不一致/);
      assert.match(result.message, /已还原/);
      assert.ok(git.calls.some((call) => args0("checkout", "--detach", "--force", "abc123def")(call.args)), "abort restores the recorded HEAD");
      assert.equal(events.relayRestarts, 0);
      const done = readJournal(journalDir);
      assert.equal(done.step, "apply");
      assert.equal(done.result.outcome, "failed");
    } finally {
      cleanup();
    }
  });
});

describe("runSelfUpdate · 先行轨（bleeding）", () => {
  const TARGET_SHA = "fedcba0987654321fedcba0987654321fedcba09";

  test("下载：按引用拉 main、SHA 核对通过后停在 staged，版本号回填 journal", async () => {
    const git = fakeSpawn(({ args }) => {
      if (args0("rev-parse", "FETCH_HEAD")(args)) return { stdout: `${TARGET_SHA}\n` };
      if (gitShowPackage(args)) return { stdout: JSON.stringify({ version: "0.6.7" }) };
      return { stdout: "" };
    });
    const { deps, events, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn });
    writeJournal(journalDir, runningRun({ track: "bleeding", targetSha: TARGET_SHA, targetVersion: null, targetTag: null }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "downloaded");
      assert.match(result.message, /已下载 fedcba0，应用后生效/);
      assert.ok(git.calls.some((call) => args0("fetch", "--depth", "1", "--no-tags", "origin", "HEAD")(call.args)), "先行轨按引用拉远端默认分支 HEAD，不按 tag 也不按 SHA");
      assert.equal(git.calls.some((call) => args0("checkout")(call.args)), false, "下载不碰工作树");
      assert.equal(events.relayRestarts, 0);
      // 版本号下载后才得知，回填进 journal 供应用阶段与终态文案使用
      const done = readJournal(journalDir);
      assert.equal(done.state, "done");
      assert.equal(done.phase, "staged");
      assert.equal(done.targetVersion, "0.6.7");
    } finally {
      cleanup();
    }
  });

  test("下载：FETCH_HEAD 与目标不一致（上游又前进）即中止，不落 staged", async () => {
    const git = fakeSpawn(({ args }) => {
      if (args0("rev-parse", "FETCH_HEAD")(args)) return { stdout: "1111111111111111111111111111111111111111\n" };
      return { stdout: "" };
    });
    const { deps, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn });
    writeJournal(journalDir, runningRun({ track: "bleeding", targetSha: TARGET_SHA, targetVersion: null, targetTag: null }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "failed");
      assert.match(result.message, /下载的代码版本（1111111）与目标（fedcba0）不一致/);
      const done = readJournal(journalDir);
      assert.equal(done.state, "done");
      assert.equal(done.result.outcome, "failed", "失败收场不落「已下载待应用」");
    } finally {
      cleanup();
    }
  });

  test("应用：换装后按 HEAD SHA 复核、复活验证比 commit，结论带提交标识", async () => {
    const probe = scriptedProbe([{ version: "0.6.6", commit: "abc1234" }, null, { version: "0.6.7", commit: "fedcba0" }]);
    const git = fakeSpawn(({ args }) => {
      if (args0("rev-parse", "HEAD")(args)) return { stdout: `${TARGET_SHA}\n` };
      return { stdout: "" };
    });
    const { deps, journalDir, cleanup } = baseDeps({
      io: fakeIo({ version: "0.6.7" }),
      spawnFn: git.spawnFn,
      probePanelFn: probe.probePanelFn,
    });
    writeJournal(journalDir, runningRun({ track: "bleeding", step: "apply", phase: "installing", targetSha: TARGET_SHA, targetVersion: "0.6.7", targetTag: null }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "updated");
      assert.match(result.message, /已更新到 0\.6\.7-fedcba0/);
      assert.equal(result.afterVersion, "0.6.7-fedcba0");
      assert.ok(git.calls.some((call) => args0("fetch", "--depth", "1", "--no-tags", "origin", "HEAD")(call.args)), "应用幂等补拉的还是 HEAD");
      assert.ok(git.calls.some(npmCall), "先行轨同样要装依赖");
    } finally {
      cleanup();
    }
  });

  test("应用：换装后的 HEAD 与目标不一致：还原工作树后失败收场", async () => {
    const { probePanelFn, probe } = scriptedProbe([{ version: "0.6.6", commit: "abc1234" }]);
    const git = fakeSpawn(({ args }) => {
      if (args0("rev-parse", "HEAD")(args)) return { stdout: "1111111111111111111111111111111111111111\n" };
      return { stdout: "" };
    });
    const { deps, events, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn, probePanelFn });
    writeJournal(journalDir, runningRun({ track: "bleeding", step: "apply", phase: "installing", targetSha: TARGET_SHA, targetVersion: "0.6.7", targetTag: null }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "failed");
      assert.match(result.message, /下载的代码版本（1111111）与目标（fedcba0）不一致/);
      assert.ok(git.calls.some((call) => args0("checkout", "--detach", "--force", "1111111111111111111111111111111111111111")(call.args)), "还原回滚点");
      assert.equal(events.relayRestarts, 0);
      assert.equal(probe.calls, 0);
    } finally {
      cleanup();
    }
  });

  test("目标形态无效（缺 targetSha）：直接失败，一个 git 命令都不发", async () => {
    const git = fakeSpawn(() => ({ stdout: "" }));
    const { deps, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn });
    writeJournal(journalDir, runningRun({ track: "bleeding", targetSha: null, targetVersion: null, targetTag: null }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "failed");
      assert.match(result.message, /更新目标无效/);
      assert.equal(git.calls.length, 0);
    } finally {
      cleanup();
    }
  });
});

describe("runSelfUpdate · 回退轨（rollback）", () => {
  test("登记即 apply：fetch 目标 tag、换装核版本、复活比版本，结论「已回到稳定版」", async () => {
    const probe = scriptedProbe([{ version: "0.6.7-abc1234" }, null, { version: "0.6.6" }]);
    const git = fakeSpawn(withTagVersion(({ args }) => (args0("rev-parse", "HEAD")(args) ? { stdout: "abc123def\n" } : { stdout: "" }), "0.6.6"));
    const { deps, events, journalDir, cleanup } = baseDeps({
      io: fakeIo({ version: "0.6.6" }),
      spawnFn: git.spawnFn,
      probePanelFn: probe.probePanelFn,
    });
    writeJournal(journalDir, runningRun({ track: "rollback", step: "apply", phase: "installing", targetVersion: "0.6.6", targetTag: "v0.6.6" }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "updated");
      assert.match(result.message, /已回到稳定版 0\.6\.6/);
      assert.equal(result.afterVersion, "0.6.6");
      assert.ok(git.calls.some((call) => args0("fetch", "--depth", "1", "--no-tags", "origin", "tag", "v0.6.6")(call.args)), "回退按 tag 补拉（幂等）");
      assert.equal(events.relayRestarts, 1);
    } finally {
      cleanup();
    }
  });

  test("旧记录没有 track 字段：一律按稳定轨走（journal 兼容）", async () => {
    const probe = scriptedProbe([{ version: "0.6.1-preview" }, null, { version: "0.7.0" }]);
    const git = fakeSpawn(withTagVersion(({ args }) => (args0("rev-parse", "HEAD")(args) ? { stdout: "abc123def\n" } : { stdout: "" })));
    const { deps, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn, probePanelFn: probe.probePanelFn });
    writeJournal(journalDir, runningRun({ step: "apply", phase: "installing" }));
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "updated");
      assert.match(result.message, /已更新到 0\.7\.0/);
    } finally {
      cleanup();
    }
  });
});

describe("runSelfUpdate · 通用闸门", () => {
  test("journal 记录不属于自更新或不在 running 态：直接返回 null，一个进程都不动", async () => {
    const { deps, events, journalDir, cleanup } = baseDeps();
    writeJournal(journalDir, runningRun({ clientId: "claude" }));
    try {
      assert.equal(await runSelfUpdate({ ...deps }), null);
      writeJournal(journalDir, runningRun({ state: "done" }));
      assert.equal(await runSelfUpdate({ ...deps }), null);
      assert.equal(events.relayRestarts, 0);
    } finally {
      cleanup();
    }
  });
});

describe("spawnSelfUpdateWorker", () => {
  test("脱离形态与 client-update worker 逐字一致：detached、丢管道、unref", () => {
    const recorded = [];
    const child = { unref() { recorded.push("unref"); } };
    const pid = spawnSelfUpdateWorker({
      runId: RUN_ID,
      journalDir: "C:/data/client-updates",
      spawnFn: (execPath, args, options) => {
        recorded.push({ execPath, args, options });
        return child;
      },
      execPath: "/node/node.exe",
    });
    assert.equal(pid, undefined);
    assert.equal(recorded[1], "unref");
    const call = recorded[0];
    assert.equal(call.execPath, "/node/node.exe");
    assert.equal(call.args[0].replaceAll("\\", "/").endsWith("/self-update-worker.mjs"), true);
    assert.deepEqual(call.args.slice(1), [RUN_ID, "C:/data/client-updates"]);
    assert.equal(call.options.detached, true);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.shell, false);
    assert.deepEqual(call.options.stdio, "ignore");
  });
});

// 前后端契约的静态钉子：按钮、阶段文案、换装事件与两步入口必须同时在两端存在，
// 防止单独改掉任何一头（client-lifecycle.test.mjs 对清单漂移的同款防线）。
test("关于页 UI 契约：自更新按钮、两步入口与换装事件两端对齐", () => {
  const panelJs = readFileSync(new URL("./panel-ui/panel.js", import.meta.url), "utf8");
  const panelHtml = readFileSync(new URL("./panel-ui/panel.html", import.meta.url), "utf8");
  assert.match(panelHtml, /id="aboutSelfUpdate"/);
  assert.match(panelJs, /aboutSelfUpdate/);
  assert.match(panelJs, /anyswitch:self-update-swap/);
  assert.match(panelJs, /\/api\/self-update\/active/);
  assert.match(panelJs, /\/api\/self-update\/apply/);
  assert.match(panelJs, /\/api\/self-update\/last/);
  assert.match(panelJs, /应用更新/);
});
