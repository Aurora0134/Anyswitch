// Socket→PID 兜底归组（panel 实例行 / 实例计数胶囊的兜底数据源）。
//
// 背景：实例归组的正源是 launcher 注入的 x-agent-instance 头（openai 路径）。
// 但用户经常直接在
// 终端敲 npm shim 命令（kimi / opencode / pi）启动客户端，绕过
// launcher，请求不带任何实例标签——instances[] 恒空，面板实例行与左上角
// 实例计数胶囊不出现。
//
// 兜底机制：Windows 上每个客户端进程都持有自己的 keep-alive 连接到 relay，
// 在 netstat -ano -p tcp 的输出里呈现为「本端端口 = 客户端临时端口、
// 外端端口 = relay 端口、行尾 PID = 客户端进程 PID」的一行，例如：
//   TCP    127.0.0.1:11790    127.0.0.1:47821    ESTABLISHED    22524
// 据此合成 "<agentId>-<pid>" 实例 id，绕过 launcher 的客户端也能按进程分组。
//
// relay 视角的方向换算：req.socket.remotePort = 客户端临时端口 = netstat 行
// 的本端端口；req.socket.localPort = relay 端口 = netstat 行的外端端口。
// 所以 lookup({ localPort, remotePort }) 找的是「本端 = remotePort 且
// 外端 = localPort」的行。

import { exec } from "node:child_process";

const NETSTAT_CMD = "netstat -ano -p tcp";
const NETSTAT_TIMEOUT_MS = 3000;

// 只认 ESTABLISHED：TIME_WAIT 行 PID 归 0（无主残线）、LISTENING 行是
// 服务端 socket（PID 是 relay 自己或系统）、CLOSE_WAIT 是半关闭残线——
// 都不能用来归组。IPv6 loopback 写作 [::1]:port，地址段按 bracket 兼容；
// IPv4（127.0.0.1）不含冒号，走 [^:\s]+ 分支。
const NETSTAT_LINE_RE = /^\s*TCP\s+(?:\[[^\]]+\]|[^:\s]+):(\d+)\s+(?:\[[^\]]+\]|[^:\s]+):(\d+)\s+ESTABLISHED\s+(\d+)\s*$/;

// 解析 netstat -ano -p tcp 输出为 Map<localPort, Array<{foreignPort, pid}>>。
// 同一 localPort 理论上只会对应一条 ESTABLISHED 行（协议栈保证端口唯一），
// 但 IPv4/IPv6 双栈可能复用端口号，所以值是数组而非单条。
export function parseNetstatOutput(text) {
  const map = new Map();
  if (typeof text !== "string") return map;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(NETSTAT_LINE_RE);
    if (!match) continue;
    const localPort = Number(match[1]);
    const foreignPort = Number(match[2]);
    const pid = Number(match[3]);
    if (!Number.isInteger(localPort) || !Number.isInteger(foreignPort) || !Number.isInteger(pid)) continue;
    if (pid <= 0) continue; // PID 0 是系统空闲 socket，永远不是客户端进程
    let rows = map.get(localPort);
    if (!rows) {
      rows = [];
      map.set(localPort, rows);
    }
    rows.push({ foreignPort, pid });
  }
  return map;
}

// 共享快照 + 同步查询。为什么 lookup 必须同步：调用点在 server 的
// startRequest（构造 metrics tracker 的同步代码）里，把它改成 async 会
// 波及整条请求处理链；而 netstat spawn 一次要几十到几百毫秒，为了一个
// 纯装饰性的实例归组去阻塞请求路径完全不值。所以这里维护一份后台刷新的
// netstat 快照，lookup 只做内存查表。
//
// 为什么要容忍新连接的首请求 miss：客户端进程刚建立 keep-alive 连接时，
// 快照里还没有它的行，首请求落聚合桶（面板卡片刻意不丢这条数据）；
// miss 会触发一次后台刷新，keep-alive 连接随后续请求长期存在，所以
// 第二个请求起就能命中。这是"首请求少打一个实例行"换"请求路径零阻塞"。
export function createInstanceSocketOwner(options = {}) {
  const execFn = options.execFn ?? exec;
  const ttlMs = options.ttlMs ?? 2000;
  const nowFn = options.nowFn ?? Date.now;

  let snapshot = new Map();
  let snapshotAt = 0;
  let refreshInFlight = false;
  const refreshListeners = new Set();

  // 后台 fire-and-forget 刷新。in-flight 标记把并发 miss 合并成一次
  // spawn（TTL 内的连续 miss 不会排队刷屏）；错误静默——netstat 不可用
  // 时兜底归组整体退化为"恒 miss、落聚合桶"，绝不能反过来影响请求。
  // 失败也推进 snapshotAt：否则每次 miss 都会重 spawn 一个注定失败的
  // netstat，形成 miss→spawn→fail→miss 的循环。
  // 刷新结束（成功或失败）通知 onRefresh 订阅方：首请求 miss 的在途请求
  // 可以再 lookup 一次，命中则补到实例行——不把身份钉在 socket 上。
  function refresh() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    execFn(NETSTAT_CMD, { timeout: NETSTAT_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      refreshInFlight = false;
      snapshotAt = nowFn();
      if (!err && typeof stdout === "string") snapshot = parseNetstatOutput(stdout);
      for (const listener of refreshListeners) {
        try { listener(); } catch { /* 订阅方失败不得伤及后续 listener / 请求路径 */ }
      }
    });
  }

  function onRefresh(listener) {
    if (typeof listener !== "function") return () => {};
    refreshListeners.add(listener);
    return () => { refreshListeners.delete(listener); };
  }

  // 同步查快照：localPort = relay 端口（netstat 行的外端），remotePort =
  // 客户端临时端口（netstat 行的本端）。miss 或超 TTL 只触发后台刷新，
  // 本次仍返回旧值或 null，绝不阻塞、绝不抛错（调用点在 metrics 代码里，
  // 兜底失败不能伤及请求本身）。注意参数解构必须在 try 内部——签名层面的
  // 解构会在进入 try 之前就对 null 入参抛错。
  function lookup(query) {
    try {
      const local = Number(query?.localPort);
      const remote = Number(query?.remotePort);
      if (!Number.isInteger(local) || !Number.isInteger(remote) || local <= 0 || remote <= 0) return null;
      const rows = snapshot.get(remote);
      const hit = rows ? rows.find((row) => row.foreignPort === local) : null;
      if (!hit || nowFn() - snapshotAt > ttlMs) refresh();
      return hit ? hit.pid : null;
    } catch {
      return null;
    }
  }

  refresh(); // 构造时预热：让 relay 起来后的第一批请求就有快照可查
  return { lookup, refresh, onRefresh };
}
