// Follow-agent auto-heal watcher.
//
// When the user enables "跟随 Coding Agent 启动" in settings.json (followAgent),
// this watcher polls every few seconds and keeps the relay link ready:
//
//   1. relay not running  → start it (the original behaviour)
//   2. relay running but DEGRADED (answering the probe while failing every real
//      request) → restart it, under backoff and a rolling budget
//
// Case 2 is the one added after 2026-10-05: the resident relay stayed up and kept
// answering the probe while every request failed for 70 straight minutes, and
// nothing acted because "the port answers" was the only question anyone asked.
//
// The guard rails matter as much as the reaction. The old shape — start on every
// tick, forever, failures included — spent 2.5 hours spawning 48 relays that each
// died on the occupied port, and that churn is itself load on a machine that is
// already struggling. So: a grace period before acting at all, growing backoff
// between attempts, a hard cap per window, and an explicit give-up that says so
// in the log instead of silently retrying forever.
//
// All external capabilities (process scan, relay start/restart, relay status,
// settings read, clock) are INJECTED, so this module has no hard imports and is
// trivially testable. The polling timer is unref'd so it never keeps the event
// loop alive on its own.

export const DEFAULT_INTERVAL_MS = 3000;

// 服务异常持续多久才动手。低于这个时长的抖动不该惊动重启——重启会掐掉在途请求，
// 而一两次凭据读取抖动本来就会自己恢复。
export const DEFAULT_DEGRADED_GRACE_MS = 60_000;
// 每次自愈尝试之后的等待，按次数递增、最后一次封顶。指数退避的意义是给环境
// （负载、被占满的资源）自己缓过来的时间，而不是把故障期变成密集重启。
export const DEFAULT_HEAL_BACKOFF_MS = Object.freeze([30_000, 60_000, 120_000, 300_000]);
// 滚动窗口内最多自愈几次。用完就停手并明确记录「需要人工介入」：一个环境性的
// 根因不会因为重启而消失，继续拉下去只是在制造 2026-10-05 那种进程堆积。
export const DEFAULT_HEAL_BUDGET = 3;
export const DEFAULT_HEAL_BUDGET_WINDOW_MS = 30 * 60_000;

export function createAgentWatcher({
  root,
  scanProcesses,
  startRelay,
  restartRelay = startRelay,
  getRelayStatus,
  loadSettings,
  intervalMs = DEFAULT_INTERVAL_MS,
  logger,
  now = Date.now,
  degradedGraceMs = DEFAULT_DEGRADED_GRACE_MS,
  healBackoffMs = DEFAULT_HEAL_BACKOFF_MS,
  healBudget = DEFAULT_HEAL_BUDGET,
  healBudgetWindowMs = DEFAULT_HEAL_BUDGET_WINDOW_MS,
}) {
  let timer = null;
  let inFlight = false;

  // 降级自愈状态。degradedSince 是「第一次看见降级」的时刻，不是「最近一次看见」，
  // 否则每次巡检都会把计时清零、宽限期永远不会到。
  //
  // healAttempts 刻意不因一次「看起来恢复了」而清空。重启之后新进程当然是干净的、
  // 探针立刻报正常——如果这就把预算还回去，那「30 分钟内最多 3 次」形同虚设：每次
  // 重启都重置，实际节奏变成「宽限期 + 退避」一次，比原来还密。预算只随时间窗口
  // 自然过期，所以「反复降级」这件事本身会被累计，而不被每次重启抹掉。
  let degradedSince = null;
  let healAttempts = [];
  let nextHealAt = null;
  let giveUpLogged = false;

  // 恢复只结束「当前这一次降级」：宽限期重新计时、退避重新起算、放弃提示可以再报。
  // 预算不在其列（见上）。
  function onRelayHealthy() {
    degradedSince = null;
    nextHealAt = null;
    giveUpLogged = false;
  }

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      let settings = {};
      try {
        settings = loadSettings(root)?.settings ?? {};
      } catch {
        return;
      }
      if (!settings.followAgent) return;

      // scanProcesses is ASYNC (the collector's stale-while-revalidate probe)
      // — without await, procs is a Promise, every count reads undefined and
      // anyAgent short-circuits the tick to a silent no-op.
      const procs = await scanProcesses();
      const anyAgent = (procs?.zcode || 0) + (procs?.claude || 0) + (procs?.opencode || 0) + (procs?.dsh || 0) + (procs?.pi || 0) + (procs?.kimi || 0) + (procs?.qoder || 0) + (procs?.codex || 0) + (procs?.grok || 0) > 0;
      if (!anyAgent) return;

      const relay = await getRelayStatus();

      // 不在跑：这是原有的自愈路径，直接拉起。
      if (relay?.status !== "running") {
        onRelayHealthy();
        logger?.info("followAgent: coding agent running and relay down; auto-starting relay");
        try {
          await startRelay();
        } catch (err) {
          logger?.error(`followAgent auto-start failed: ${err.message}`);
        }
        return;
      }

      // 在跑且服务正常：结束当前这次降级（预算不动）。
      if (relay.degraded !== true) {
        onRelayHealthy();
        return;
      }

      const t = now();
      if (degradedSince === null) {
        degradedSince = t;
        logger?.warn(
          `followAgent: relay answers the probe but is failing requests (${relay.consecutiveFailures} in a row, last cause: ${relay.lastFailureKind ?? "unknown"}); watching before acting`,
        );
        return;
      }
      if (t - degradedSince < degradedGraceMs) return;

      // 滚动窗口内的尝试次数：既决定预算，也决定退避档位。
      const recent = healAttempts.filter((at) => t - at < healBudgetWindowMs);
      healAttempts = recent;

      if (recent.length >= healBudget) {
        if (!giveUpLogged) {
          giveUpLogged = true;
          logger?.error(
            `followAgent: relay still degraded after ${recent.length} restarts within ${Math.round(healBudgetWindowMs / 60000)} min; auto-heal stopped — this needs attention (last cause: ${relay.lastFailureKind ?? "unknown"})`,
          );
        }
        return;
      }
      giveUpLogged = false;
      if (nextHealAt !== null && t < nextHealAt) return;

      healAttempts = [...recent, t];
      const backoff = healBackoffMs[Math.min(recent.length, healBackoffMs.length - 1)];
      nextHealAt = t + backoff;
      logger?.warn(
        `followAgent: relay degraded for ${Math.round((t - degradedSince) / 1000)}s; restarting it (attempt ${recent.length + 1}/${healBudget}, next earliest in ${Math.round(backoff / 1000)}s)`,
      );
      try {
        await restartRelay();
      } catch (err) {
        logger?.error(`followAgent degraded-restart failed: ${err.message}`);
      }
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
    timer.unref();
    // Fire once immediately so we don't wait a full interval on startup.
    tick().catch(() => {});
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tick };
}
