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
// 只是那一拍会卡），并只在首次降级时记一条 warn——不每拍重试、不无限重连。
// 这保证了「worker 在某些打包/受限环境下不可用」不会变成「会话列表没了」。
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

// One request/response channel to the scan worker, plus the in-process
// fallback. `fallback.scanAll()` / `fallback.scanAgent(id)` must be the same
// session-scan entry points, so both paths return the same shape.
export function createSessionScanOffload({
  workerFile = WORKER_FILE,
  workerData = null,
  timeoutMs = SCAN_TIMEOUT_MS,
  logger = null,
  fallback,
} = {}) {
  let worker = null;
  let degraded = false; // worker 不可用：此后一律本进程扫，不再重试
  let warned = false;
  let seq = 0;
  const pending = new Map(); // id → { resolve, reject, timer }

  function settleAll(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  // 一次性降级：起不来 / 崩了 / 超时都走这里。只记一条 warn——之后每一拍都
  // 本进程扫，重复刷日志没有增量信息。
  function retire(error) {
    if (!degraded) {
      degraded = true;
      if (!warned) {
        warned = true;
        logger?.warn?.(`session scan worker unavailable, scanning in-process: ${error?.message}`);
      }
    }
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
    if (degraded) return fallbackFn();
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
