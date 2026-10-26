// Scan host: run session-scan.mjs's synchronous on-disk scan in a worker thread.
//
// Why this file exists (2026-10-26, M1「扫描离线程」)：session-scan.mjs 的九个
// adapter 体内全是同步 fs（readdirSync/statSync/readFileSync/readSync），async
// 外壳下没有任何 await 点——整段扫描跑在同一个 turn 里。修前面板进程（47820）
// 直接调用它，实测 2927 条会话要 2.7–8.0s；而终端字节流、SSE 握手与全部面板
// 接口都要穿过这个进程，于是「扫描在飞」＝「整个面板停摆」（S1：并发请求从
// 25ms 变 4325ms；S2：SSE 首帧从 47–175ms 变 7.3s/15.2s）。
//
// 这里不重写扫描逻辑：同一份 session-scan.mjs 原样搬进 worker 线程执行，
// 面板进程只等消息。语义只有一处变化——扫描不再占面板的事件循环；扫描结果
// 与 in-process 调用逐字段一致（session-scan.test.mjs 有对照钉）。
//
// 降级：worker 起不来 / 崩了 / 单次超时，就退回本进程内扫（面板仍能出列表，
// 只是那一拍会卡），并记一条 warn——不每拍重试、不无限重连。这保证了「worker
// 在某些打包/受限环境下不可用」不会变成「会话列表没了」。
//
// 降级不是终点（reviveCooldownMs，默认 5 分钟）：冷却窗过后允许重建一次
// worker。一次抖动（机器休眠唤醒、磁盘卡顿撞上 120s 上限、worker 偶发崩溃）
// 不许把整个进程生命周期永久打回「扫描占住事件循环」——那正是本 mission 要
// 消掉的症状。重建失败只是再记一条 warn 并重新起算冷却窗，没有额外成本；
// 也不主动定时重建——没人在扫的时候不必起线程。
//
// 生命周期：worker 懒建（首次真正要扫时才起），有请求在飞时 ref、空闲时
// unref，所以它既不拖住进程退出，也不会在空闲期被提前回收。

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import { createSessionScanner } from "./session-scan.mjs";

const WORKER_FILE = fileURLToPath(import.meta.url);
// 单次扫描上限：本机最坏实测 8s（2927 条会话），给到 120s 只用于兜住「worker
// 挂死」这种不该发生的情形——超时后退回进程内扫，宁可卡一拍也不无限等。
const SCAN_TIMEOUT_MS = 120_000;
// 降级后的冷却窗：期间一律本进程扫，到点允许重建一次 worker。
const REVIVE_COOLDOWN_MS = 5 * 60_000;

// One request/response channel to the scan worker, plus the in-process
// fallback. `fallback.scanAll()` / `fallback.scanAgent(id)` must be the same
// session-scan entry points, so both paths return the same shape.
export function createSessionScanOffload({
  workerFile = WORKER_FILE,
  workerData = null,
  timeoutMs = SCAN_TIMEOUT_MS,
  reviveCooldownMs = REVIVE_COOLDOWN_MS,
  logger = null,
  fallback,
} = {}) {
  let worker = null;
  // 冷却窗：degradedUntil 在未来时一律走本进程；到点后下一次扫描尝试重建。
  let degradedUntil = 0;
  // 是否处于「已降级且还没重建」的状态：同一次故障会同时从 worker 的 error
  // 事件和 run() 的 catch 两路走到 retire()，靠它去重，别把一次故障记成两次。
  let degraded = false;
  let failures = 0;
  let workerStarts = 0;
  let seq = 0;
  const pending = new Map(); // id → { resolve, reject, timer }

  function settleAll(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  // 一次降级：起不来 / 崩了 / 超时都走这里。记一条 warn，起算冷却窗。
  function retire(error) {
    if (degraded && worker === null) return; // 同一场故障只记一次
    degraded = true;
    failures += 1;
    degradedUntil = Date.now() + reviveCooldownMs;
    logger?.warn?.(
      `session scan worker unavailable (${failures}), scanning in-process; retry in ${Math.round(reviveCooldownMs / 1000)}s: ${error?.message}`,
    );
    try {
      worker?.terminate();
    } catch {
      // terminate 失败无所谓：worker 已经不可用，本进程兜底。
    }
    worker = null;
    settleAll(error);
  }

  function ensureWorker() {
    if (worker) return worker;
    workerStarts += 1;
    // 重建即离开降级态：若这次仍失败，retire() 会重新置位并重新起算冷却窗。
    degraded = false;
    const created = new Worker(workerFile, { name: "session-scan", ...(workerData ? { workerData } : {}) });
    created.on("message", (message) => {
      const entry = pending.get(message?.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (pending.size === 0) created.unref?.();
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error ?? "session_scan_failed"));
    });
    created.on("error", (error) => retire(error));
    // 非 0 退出＝扫描线程异常结束；0 是正常终止（terminate() 之后也会走到这里）。
    created.on("exit", (code) => {
      if (code === 0 || worker !== created) return;
      retire(new Error(`session scan worker exited (${code})`));
    });
    created.unref?.(); // 空闲时不拖住进程退出；有请求在飞时由 request() ref 回来
    worker = created;
    return created;
  }

  function request(kind, agentId) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = ensureWorker();
      } catch (error) {
        reject(error);
        return;
      }
      const id = (seq += 1);
      const timer = setTimeout(() => {
        if (pending.delete(id)) retire(new Error("session_scan_timeout"));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      target.ref?.();
      try {
        target.postMessage({ id, kind, agentId });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async function run(kind, agentId, fallbackFn) {
    // 冷却窗内一律本进程扫——不在这段时间里反复重建线程（起不来的环境每拍
    // 重建一次只会拖慢每一拍）。
    if (Date.now() < degradedUntil) return fallbackFn();
    try {
      return await request(kind, agentId);
    } catch (error) {
      retire(error);
      return fallbackFn();
    }
  }

  return {
    // 九家全量扫描（会话管理 tab 的列表）。
    scanAll: () => run("all", undefined, () => fallback.scanAll()),
    // 单端点扫描（终端会话 ↔ 对话存档绑定、复活兜底）。
    scanAgent: (agentId) => run("agent", agentId, () => fallback.scanAgent(agentId)),
    // 诊断面（测试与现场排查用）：worker 起过几次、降级了几次、当前是否在冷却窗。
    stats() {
      return { workerStarts, failures, degraded: Date.now() < degradedUntil, degradedUntil };
    },
    close() {
      if (!worker) return;
      const target = worker;
      worker = null;
      settleAll(new Error("session_scan_closed"));
      target.terminate();
    },
  };
}

// ---- worker 侧：原样跑 session-scan.mjs，不重写任何扫描逻辑 ----
if (!isMainThread) {
  // workerData.roots 只在测试里给（临时目录根，绝不碰真 home）；生产不传，
  // createSessionScanner 走默认 home 根。
  const scanner = createSessionScanner(workerData?.roots ? { roots: workerData.roots } : {});
  parentPort.on("message", async (message) => {
    const { id, kind, agentId } = message ?? {};
    try {
      const result = kind === "agent" ? await scanner.scanEndpoint(agentId) : await scanner.scanAll();
      parentPort.postMessage({ id, ok: true, result });
    } catch (error) {
      parentPort.postMessage({ id, ok: false, error: error?.message ?? String(error) });
    }
  });
}
