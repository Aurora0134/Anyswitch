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

function runningRun(overrides = {}) {
  return {
    runId: RUN_ID,
    clientId: SELF_UPDATE_CLIENT_ID,
    action: "update",
    state: "running",
    startedAt: "2026-10-07T00:00:00.000Z",
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
    spawnFn: fakeSpawn(() => ({ stdout: "" })).spawnFn,
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
    now: () => "2026-10-07T01:00:00.000Z",
    nowMs: clock.nowMs,
    alive: () => true,
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

describe("runSelfUpdate", () => {
  test("快乐路径：换装、装依赖、重启 relay、等新面板接管，outcome=updated", async () => {
    const probe = scriptedProbe([{ version: "0.6.1-preview" }, null, { version: "0.7.0" }]);
    const git = fakeSpawn(({ args }) => (args0("rev-parse", "HEAD")(args) ? { stdout: "abc123def\n" } : { stdout: "" }));
    const { deps, events, journalDir, cleanup } = baseDeps({
      spawnFn: git.spawnFn,
      probePanelFn: probe.probePanelFn,
    });
    writeJournal(journalDir, runningRun());
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "updated");
      assert.equal(result.beforeVersion, "0.6.1-preview");
      assert.equal(result.afterVersion, "0.7.0");
      // git 步骤的形状：浅拉取钉 tag、强制 detach 检出、npm 在 app 目录里装。
      const fetchCall = git.calls.find((call) => args0("fetch", "--depth", "1", "--no-tags", "origin", "tag", "v0.7.0")(call.args));
      assert.ok(fetchCall, "fetch must shallow-pin the target tag");
      const checkoutCall = git.calls.find((call) => args0("checkout", "--detach", "--force", "FETCH_HEAD")(call.args));
      assert.ok(checkoutCall, "checkout must be a forced detach onto FETCH_HEAD");
      const npm = git.calls.find(npmCall);
      assert.ok(npm, "npm install must run through the local npm-cli");
      assert.deepEqual(npm.args.slice(1), ["install", "--no-audit", "--no-fund"]);
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

  test("镜像安装首次引导：没有 .git 就 init + remote add，无回滚点也照常更新", async () => {
    const probe = scriptedProbe([null, { version: "0.7.0" }]);
    const git = fakeSpawn(({ args }) => (args0("rev-parse", "HEAD")(args) ? { error: { code: 128 } } : { stdout: "" }));
    const { deps, events, journalDir, cleanup } = baseDeps({
      io: fakeIo({ hasGit: false }),
      spawnFn: git.spawnFn,
      probePanelFn: probe.probePanelFn,
    });
    writeJournal(journalDir, runningRun());
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "updated");
      assert.ok(git.calls.some((call) => args0("init")(call.args)), "bootstrap must git init");
      assert.ok(git.calls.some((call) => args0("remote", "add", "origin", REPO_URL)(call.args)));
      assert.equal(events.relayRestarts, 1);
    } finally {
      cleanup();
    }
  });

  test("remote 漂移被校正：origin 指向别处时 set-url 回权威源", async () => {
    const probe = scriptedProbe([null, { version: "0.7.0" }]);
    const git = fakeSpawn(({ args }) => (args0("remote", "get-url", "origin")(args) ? { stdout: "https://github.com/someone/else.git\n" } : { stdout: "" }));
    const { deps, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn, probePanelFn: probe.probePanelFn });
    writeJournal(journalDir, runningRun());
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "updated");
      assert.ok(git.calls.some((call) => args0("remote", "set-url", "origin", REPO_URL)(call.args)));
    } finally {
      cleanup();
    }
  });

  test("检出版本与目标不一致：在中止点收场，relay 与面板都没被动过", async () => {
    const { probePanelFn, probe } = scriptedProbe([{ version: "0.6.1-preview" }]);
    const git = fakeSpawn(({ args }) => (args0("rev-parse", "HEAD")(args) ? { stdout: "abc123def\n" } : { stdout: "" }));
    const { deps, events, journalDir, cleanup } = baseDeps({
      io: fakeIo({ version: "0.6.9" }),
      spawnFn: git.spawnFn,
      probePanelFn,
    });
    writeJournal(journalDir, runningRun());
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "failed");
      assert.match(result.message, /不一致/);
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
    writeJournal(journalDir, runningRun());
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

  test("拉取失败：网络/git 层面的失败在服务无损的前提下收场", async () => {
    const git = fakeSpawn(({ args }) => (args0("fetch", "--depth", "1", "--no-tags", "origin", "tag", "v0.7.0")(args) ? { error: { code: 128 }, stderr: "fatal: could not read" } : { stdout: "" }));
    const { deps, events, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn });
    writeJournal(journalDir, runningRun());
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "failed");
      assert.match(result.message, /拉取 v0.7.0/);
      assert.equal(result.detail, "fatal: could not read");
      assert.equal(events.relayRestarts, 0);
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
    writeJournal(journalDir, runningRun());
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

  test("新面板未接管且有回滚点：退回 beforeHead、重拉面板与 relay，outcome=rolled_back", async () => {
    const probe = scriptedProbe([
      { version: "0.6.1-preview" }, // 退场前仍在应答
      null,                          // 面板退场
      null,                          // 新面板迟迟不来（超时窗口内一直如此）
      { version: "0.6.1-preview" },  // 回滚后的旧面板回来了
    ]);
    const git = fakeSpawn(({ args }) => (args0("rev-parse", "HEAD")(args) ? { stdout: "abc123def\n" } : { stdout: "" }));
    const { deps, events, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn, probePanelFn: probe.probePanelFn });
    writeJournal(journalDir, runningRun());
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "rolled_back");
      assert.match(result.message, /已回滚/);
      const rollback = git.calls.find((call) => args0("checkout", "--detach", "--force", "abc123def")(call.args));
      assert.ok(rollback, "rollback must force-checkout the recorded HEAD");
      assert.equal(events.panelHostSpawns, 1);
      assert.equal(events.relayRestarts, 2);
    } finally {
      cleanup();
    }
  });

  test("新面板未接管且无回滚点：尽力拉起面板并如实报 failed", async () => {
    const probe = scriptedProbe([{ version: "0.6.1-preview" }, null, null]);
    const git = fakeSpawn(({ args }) => (args0("rev-parse", "HEAD")(args) ? { error: { code: 128 } } : { stdout: "" }));
    const { deps, events, journalDir, cleanup } = baseDeps({ spawnFn: git.spawnFn, probePanelFn: probe.probePanelFn });
    writeJournal(journalDir, runningRun());
    try {
      const result = await runSelfUpdate({ ...deps });
      assert.equal(result.outcome, "failed");
      assert.match(result.message, /首次引导更新没有回滚点/);
      assert.equal(events.panelHostSpawns, 1);
    } finally {
      cleanup();
    }
  });

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

  test("watchdog 在跑时：换装窗口先停、收尾恢复", async () => {
    const probe = scriptedProbe([null, { version: "0.7.0" }]);
    const { deps, events, journalDir, cleanup } = baseDeps({
      probeWatchdogFn: async () => true,
      probePanelFn: probe.probePanelFn,
    });
    writeJournal(journalDir, runningRun());
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

// 前后端契约的静态钉子：按钮、阶段文案与换装事件名必须同时在两端存在，
// 防止单独改掉任何一头（client-lifecycle.test.mjs 对清单漂移的同款防线）。
test("关于页 UI 契约：自更新按钮、阶段文案与换装事件两端对齐", () => {
  const panelJs = readFileSync(new URL("./panel-ui/panel.js", import.meta.url), "utf8");
  const panelHtml = readFileSync(new URL("./panel-ui/panel.html", import.meta.url), "utf8");
  assert.match(panelHtml, /id="aboutSelfUpdate"/);
  assert.match(panelJs, /aboutSelfUpdate/);
  assert.match(panelJs, /anyswitch:self-update-swap/);
  assert.match(panelJs, /\/api\/self-update\/active/);
});
