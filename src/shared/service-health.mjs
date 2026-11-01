// 中继自检：把「我还能不能服务」变成一个可被程序看见的状态。
//
// 背景（2026-10-05）：relay 进程活着、47821 在监听、探针也答得出来，但每一个
// 请求都因为取不到上游密钥而 502，连续 70 分钟。所有监管者问的都只有一个问题
// ——「探针答不答」——于是这次全灭没有任何警报、没有自愈，事后也没留下痕迹。
//
// 这里只统计「中继自身原因」导致的失败：取不到凭据、store 读不了或校验不过。
// 客户端自己发错的请求（4xx）和上游的限流/5xx 都不算——那是别人的问题，把别人
// 的问题报成自己降级只会制造误报，而误报会让真正的降级被忽略。
//
// 清零信号是「真的把请求送到了上游」：它同时证明了凭据读得出、网络出得去。上游
// 之后回 429 或 5xx 不影响这次清零——中继的活干完了。
//
// 阈值取 5：偶发一两次凭据读取抖动不该惊动看板和 watchdog；连续 5 次已经不可能
// 是抖动（按出事当天的请求密度，5 次失败几十秒内就会攒满）。

export const DEFAULT_DEGRADED_THRESHOLD = 5;

// 失败分类。只用于日志与快照，不参与判定——判定只看连续次数。
export const SERVICE_FAILURE_KINDS = Object.freeze(["credential", "store"]);

export function createServiceHealth({ threshold = DEFAULT_DEGRADED_THRESHOLD, now = Date.now } = {}) {
  let consecutiveFailures = 0;
  let lastFailure = null;

  function recordFailure(kind) {
    consecutiveFailures += 1;
    lastFailure = { kind, at: now() };
  }

  function recordSuccess() {
    consecutiveFailures = 0;
  }

  function snapshot() {
    return {
      consecutiveFailures,
      degraded: consecutiveFailures >= threshold,
      threshold,
      lastFailureKind: lastFailure?.kind ?? null,
      lastFailureAt: lastFailure?.at ?? null,
    };
  }

  return { recordFailure, recordSuccess, snapshot };
}
