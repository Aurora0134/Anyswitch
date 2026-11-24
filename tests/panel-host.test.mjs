// panel-host unit tests: the terminal-backend discovery leg. Since the relay
// owns the terminal host process, the panel can only discover it — a missing
// backend is logged and swallowed so panel startup is never blocked.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPanelServer, discoverTerminalBackend, migrateWatchdogAutostart, rotateLogIfNeeded, teeStderrToFile } from "../src/panel/panel-host.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

function recordingLogger() {
  const warnings = [];
  return { warnings, warn: (line) => warnings.push(String(line)) };
}

test("discoverTerminalBackend passes through a serving backend without a warning", async () => {
  const logger = recordingLogger();
  const serving = { ok: true, reused: true, pid: 5150, port: 47823 };
  const result = await discoverTerminalBackend("root-dir", {
    ensureFn: async () => serving,
    logger,
  });

  assert.equal(result, serving);
  assert.deepEqual(logger.warnings, []);
});

test("discoverTerminalBackend treats a missing backend as an empty state, not an error", async () => {
  const logger = recordingLogger();
  let receivedRoot = null;
  const result = await discoverTerminalBackend("root-dir", {
    ensureFn: async (root) => {
      receivedRoot = root;
      return { ok: false, reused: false, pid: null, port: 47823, reason: "terminal host is not running" };
    },
    logger,
  });

  assert.equal(receivedRoot, "root-dir");
  assert.equal(result.ok, false);
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /until the relay is running/, "the log explains who starts the terminal host");
});

test("discoverTerminalBackend swallows a throwing probe so panel startup never blocks", async () => {
  const logger = recordingLogger();
  const result = await discoverTerminalBackend("root-dir", {
    ensureFn: async () => {
      throw new Error("token store locked");
    },
    logger,
  });

  assert.equal(result.ok, false);
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /token store locked/);
});

const watchdogResponded = ["info", "followAgent migration: watchdog logon task registered and watchdog responded"];

for (const { name, registration, probe, spawn, expected } of [
  {
    name: "registration fails",
    registration: async () => ({ ok: false, error: "registration denied" }),
    expected: ["warn", "followAgent migration: failed to register watchdog logon task (non-fatal): registration denied"],
  },
  {
    name: "the watchdog does not respond after startup",
    spawn: async () => ({ ok: false, reused: false }),
    expected: ["warn", "followAgent migration: watchdog logon task registered, but watchdog readiness could not be confirmed"],
  },
  {
    name: "an already-running watchdog responds",
    probe: async () => true,
    expected: watchdogResponded,
  },
  {
    name: "a reused watchdog responds",
    spawn: async () => ({ ok: true, reused: true }),
    expected: watchdogResponded,
  },
  {
    name: "a newly started watchdog responds",
    spawn: async () => ({ ok: true, reused: false }),
    expected: watchdogResponded,
  },
  {
    name: "the watchdog probe throws",
    probe: async () => { throw new Error("probe failed"); },
    expected: ["warn", "followAgent migration check failed (non-fatal): probe failed"],
  },
]) {
  test(`watchdog migration logs the outcome when ${name}`, async () => {
    const settingsFile = join(mkTestDir("anyswitch-watchdog-migration-"), "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ followAgent: true }));
    const entries = [];
    await migrateWatchdogAutostart({
      settingsFile,
      logger: {
        info: (message) => entries.push(["info", message]),
        warn: (message) => entries.push(["warn", message]),
      },
      isWatchdogAutostartEnabledFn: async () => false,
      enableWatchdogAutostartFn: registration ?? (async () => ({ ok: true })),
      probeWatchdogFn: probe ?? (async () => false),
      spawnWatchdogFn: spawn ?? (async () => { throw new Error("unexpected watchdog start"); }),
    });
    assert.deepEqual(entries, [expected]);
  });
}

// 接线兜底用例：createPanelServer 必须在启动时调 prewarmPromptsBackfill——
// 注入文件唯一写入触发面原本是预设变更，漏掉这行接线则启动回填失效（面板
// 重启后注入文件仍不落盘）。四条预热腿的全部依赖来源都注入 mock：注入回填
// （environmentService/promptsService）、冷扫（environmentService/sessionScanService）、
// watchdog 快照（isWatchdogAutostartEnabledFn/probeWatchdogFn）与技能补齐
// （environmentService/skillsService）。未注入的腿直建 server 的测试会真的起
// worker 扫全机会话存档、真的跑 reg.exe/PowerShell 探针、真读真实 skills.json
// 真扫技能仓（panel-host.mjs 的透传缝是为此开的）；断言打到注入桩上＝预热确实
// 走注入面，没有偷跑真探测。
test("createPanelServer 启动即预热四条腿：注入回填 resync 一次、冷扫扫一次、watchdog 探一轮、技能补齐 catchUp 一次，全部走注入桩", async () => {
  let getStateCalls = 0;
  const env = {
    getState: async () => {
      getStateCalls += 1;
      return { clients: [{ id: "claude", installations: [{ status: "found" }] }] };
    },
  };
  let resyncs = 0;
  const promptsService = { resync: () => { resyncs += 1; } };
  let scanAlls = 0;
  const sessionScanService = { scanAll: async () => { scanAlls += 1; return []; } };
  let autostartProbes = 0, watchdogProbes = 0;
  let catchUps = 0;
  const skillsService = { catchUp: async () => { catchUps += 1; return { ok: true, created: [], skipped: [] }; } };
  createPanelServer({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    environmentService: env,
    promptsService,
    sessionScanService,
    skillsService,
    isWatchdogAutostartEnabledFn: async () => { autostartProbes += 1; return false; },
    probeWatchdogFn: async () => { watchdogProbes += 1; return false; },
  });
  const waitFor = async (value) => {
    const deadline = Date.now() + 100;
    while (value() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await waitFor(() => resyncs);
  await waitFor(() => getStateCalls);
  await waitFor(() => scanAlls);
  await waitFor(() => autostartProbes);
  await waitFor(() => catchUps);
  assert.equal(resyncs, 1, "启动即一次注入回填");
  assert.ok(getStateCalls >= 1, "冷扫预热消费注入的环境检测（不触真检测）");
  assert.equal(scanAlls, 1, "冷扫预热把会话首扫提前一拍：走注入的扫描服务");
  assert.equal(autostartProbes, 1, "watchdog 预热探一轮自启状态：走注入桩，不跑真 reg.exe");
  assert.equal(watchdogProbes, 1, "watchdog 预热探一轮存活：走注入桩，不跑真探测");
  assert.equal(catchUps, 1, "技能补齐预热走注入桩，不读真实 skills.json、不扫真实技能仓");
});

// 技能面同一接线纪律：junction 唯一的写入触发面是面板部署，漏掉这行接线则
// 后装的区域版根 / 从没部署过的 Agent 在用户手点之前永远没有技能。四条预热腿
// createPanelServer 都无条件跑，本用例只断言技能腿的接线（其余三腿由上面的
// 用例钉住），但夹具必须同样注满桩——漏注哪条哪条就真跑：真 PowerShell 自启
// 探针、真 127.0.0.1:47822 存活探测、真 worker 全机会话扫描、真写用户根的
// 注入文件（~/.claude/CLAUDE.md 一族），正是文件头纪律注释明令避免的形态。
test("createPanelServer 启动即预热技能补齐（漏接线则 catchUp 计数为 0）", async () => {
  const env = { getState: async () => ({ clients: [{ id: "claude", installations: [{ status: "found" }] }] }) };
  let catchUps = 0;
  const skillsService = { catchUp: async () => { catchUps += 1; return { ok: true, created: [], skipped: [] }; } };
  createPanelServer({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    environmentService: env,
    skillsService,
    // 其余三腿纯隔离桩（不断言次数）：只为让本用例的预热全部落在桩上、零真实
    // 路径副作用，接线断言面归上面的四腿用例。
    promptsService: { resync: () => {} },
    sessionScanService: { scanAll: async () => [] },
    isWatchdogAutostartEnabledFn: async () => false,
    probeWatchdogFn: async () => false,
  });
  const deadline = Date.now() + 100;
  while (catchUps === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(catchUps, 1, "启动即一次技能补齐");
});

// ── A6：panel-host 日志落盘（logs/panel-host.log）──────────────────────────
// 三件套与 relay-host 同款：启动轮转（超阈值改名 .old）、stderr tee（窗口进程
// 的 stderr 没有别人接收，不落盘则进程一退全蒸发）、崩溃留痕。这里逐件钉行为。

test("rotateLogIfNeeded leaves a small log untouched, rotates an oversized one, and ignores a missing one", () => {
  const dir = mkTestDir("anyswitch-ph-rotate-");
  try {
    const small = join(dir, "small.log");
    writeFileSync(small, "small\n", "utf8");
    assert.equal(rotateLogIfNeeded(small, 1024), false);
    assert.equal(existsSync(`${small}.old`), false);

    const big = join(dir, "big.log");
    writeFileSync(big, "x".repeat(2048), "utf8");
    assert.equal(rotateLogIfNeeded(big, 1024), true);
    assert.equal(existsSync(big), false, "the live log is renamed away");
    assert.equal(readFileSync(`${big}.old`, "utf8"), "x".repeat(2048));

    const missing = join(dir, "missing.log");
    assert.equal(rotateLogIfNeeded(missing, 1024), false);
    assert.equal(existsSync(`${missing}.old`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("teeStderrToFile mirrors stderr lines into the log file until restored", () => {
  const dir = mkTestDir("anyswitch-ph-tee-");
  try {
    const logPath = join(dir, "panel-host.log");
    const restore = teeStderrToFile(logPath);
    process.stderr.write("[test] panel-host tee probe\n");
    restore();
    process.stderr.write("[test] panel-host tee after-restore\n");
    const text = readFileSync(logPath, "utf8");
    assert.ok(text.includes("[test] panel-host tee probe"), "tee 期间 stderr 行落盘");
    assert.ok(!text.includes("after-restore"), "restore 后不再写文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
