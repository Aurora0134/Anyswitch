// 内切换内容的杀前兜底（switch-guard）。
//
// 背景缺陷：虚拟终端的工作/空闲真值只统计在途 LLM 请求数，agent 执行工具命令
// 的整段时间里请求数是零（上一个请求已答完、下一个还没发），跑长命令的会话被
// 全线判成空闲；「栏内点历史会话就地换内容」随之把宿主进程树整个 terminate，
// 正在跑的命令被连坐。这里在不可逆动作前按需探测一次：进程树里还有没有「正在
// 执行的命令」。判定的难点是「agent 本体」与「agent 跑的命令」都是树上的活子
// 进程，区分靠起点——只有起点之下的进程才算证据：
//
//   ① 归属锚优先（panel 侧已 join 出 agent 主进程 pid）：锚之下任何非豁免进程
//      即在跑命令。等输入的 agent 是光杆（或只挂同命令行派生引擎），锚之下为空。
//   ② 无锚时按根形态：Anyswitch 拉起的会话根是一次性包装壳（cmd /c …），它的
//      直接子进程是 agent 本体、不算证据，再下一层起才算（归属丢失但 agent 在
//      跑的兜底）；交互式 shell（用户手开的普通终端）没有「本体层」，直接子进
//      程就是用户跑的命令，算证据。
//
// 豁免形态：dsh 0.2.0 宿主会常驻派生「同命令行」引擎子进程，光杆形态的例外。
// 命中「命令行与某祖先相同」的派生对不作为在跑证据，但派生进程自己的子树照
// 常走——引擎底下挂着的命令进程仍算在跑。
import { execFile } from "node:child_process";

// 单次枚举的预算。实测（本机 2 条真实会话、机器空闲）：整次探测 548–617ms，
// 拆开是 PowerShell 启动 ~250–350ms + 全表查询 ~270–370ms。1500ms ≈ 实测 2.4 倍，
// 留够一台真在跑 agent 的机器的抖动；撞满即按 null 处置＝拒换（宁多开勿错杀），
// 与修前语义一致——收窄的只是「等多久才认输」，不是「认输之后干什么」。
// 修前是 4000ms：那是实测值的 6 倍多，最坏等待被它一个人撑到 6.7s（双探的上界
// 见 panel.mjs handleTerminalSessionSwitch 的注释），而真正的枚举成本从来不到 1s。
export const SWITCH_GUARD_PROBE_TIMEOUT_MS = 1500;

// 全表查询（不带 name 过滤）：命令子进程的 image 千姿百态（npm/python/构建器
// …），白名单式过滤必然漏，漏报就是误杀。查询按需低频（用户点击内切时一次），
// 全表代价可以承受。Name 列用于识别 shell 包装（交互 shell 与一次性包装壳）。
const SWITCH_GUARD_PS_QUERY =
  "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)\" }";

const SHELL_IMAGES = new Set(["cmd.exe", "powershell.exe", "pwsh.exe"]);
// 一次性包装形态的命令行特征（cmd /c /k、powershell/pwsh -Command/-c）：命中即
// 「这个 shell 是拉起器，子进程是受拉程序」；不命中则是交互 shell，用户在提示
// 符下跑的命令就是它的直接子进程。
const WRAPPER_SHELL_ARGS = /(?:^|\s)(?:\/[ck]\b|-Command\b|-c\b)/i;

// 行形状 "<pid>\t<ppid>\t<name>\t<command line | 空>"。命令行本身可含制表符与
// 换行，所以只按前三段切、余下整体归命令行；解析不出 pid 的行（空行/表头污染）
// 跳过。
export function parseProcessTable(out) {
  const ppidByPid = new Map();
  const cmdByPid = new Map();
  const imageByPid = new Map();
  const cuts = [];
  for (const line of String(out ?? "").split("\n")) {
    cuts.length = 0;
    let at = -1;
    for (let i = 0; i < 3; i += 1) {
      at = line.indexOf("\t", at + 1);
      if (at < 0) break;
      cuts.push(at);
    }
    if (cuts.length < 3) continue;
    const pid = Number(line.slice(0, cuts[0]));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    ppidByPid.set(pid, Number(line.slice(cuts[0] + 1, cuts[1])) || 0);
    imageByPid.set(pid, line.slice(cuts[1] + 1, cuts[2]).trim().toLowerCase() || null);
    cmdByPid.set(pid, line.slice(cuts[2] + 1).trim() || null);
  }
  return { ppidByPid, cmdByPid, imageByPid };
}

function wrapperShellRoot(cmdByPid, imageByPid, rootPid) {
  const image = imageByPid.get(rootPid);
  if (!image || !SHELL_IMAGES.has(image)) return false;
  return WRAPPER_SHELL_ARGS.test(cmdByPid.get(rootPid) ?? "");
}

// 证据层深度：锚起点（锚即 agent 本体，子进程就是命令）与交互 shell 起点（直接
// 子进程就是用户命令）都是 1；一次性包装壳起点跳过 agent 本体层，从 2 起。
function evidenceMinDepth(cmdByPid, imageByPid, rootPid, anchorPid) {
  if (anchorPid !== null) return 1;
  return wrapperShellRoot(cmdByPid, imageByPid, rootPid) ? 2 : 1;
}

// 从起点（锚或根）向下走：每个节点携带「到它为止的祖先命令行集合」与深度。
//   - 命令行命中祖先集合＝派生引擎（dsh 形态）：不算证据，子树照走；
//   - 新命令行或拿不到命令行（null，保守）落在证据层（evidenceMinDepth 起）：
//     在跑证据，立即返回；
//   - 本体层（锚/包装壳的直接子进程，未达证据层）的进程不是证据，子树照走——
//     它们的子进程到证据层自然按上面判。
// 返回 true / false；起点不在表里时返回 null（这轮枚举不可信，调用方按保护
// 语义处置）。
export function hasRunningCommand(table, { rootPid, anchorPid = null }) {
  const { ppidByPid, cmdByPid, imageByPid } = table ?? {};
  if (!(ppidByPid instanceof Map) || !(cmdByPid instanceof Map) || !(imageByPid instanceof Map)) return null;
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null;
  const anchored = Number.isInteger(anchorPid) && anchorPid > 0 && ppidByPid.has(anchorPid);
  const startPid = anchored ? anchorPid : rootPid;
  if (!ppidByPid.has(startPid)) return null;
  const rootCmd = cmdByPid.get(startPid) ?? null;
  const minDepth = evidenceMinDepth(cmdByPid, imageByPid, rootPid, anchored ? anchorPid : null);
  const queue = [{ pid: startPid, ancestorCmds: rootCmd ? new Set([rootCmd]) : new Set(), depth: 0 }];
  const seen = new Set([startPid]);
  while (queue.length > 0) {
    const { pid, ancestorCmds, depth } = queue.shift();
    for (const [child, parent] of ppidByPid) {
      if (parent !== pid || seen.has(child)) continue;
      seen.add(child);
      const cmd = cmdByPid.get(child) ?? null;
      if (depth + 1 >= minDepth && (cmd === null || !ancestorCmds.has(cmd))) return true;
      const inherited = new Set(ancestorCmds);
      if (cmd) inherited.add(cmd);
      queue.push({ pid: child, ancestorCmds: inherited, depth: depth + 1 });
    }
  }
  return false;
}

// 一次按需探测。true＝树里有正在执行的命令；false＝光杆（等输入/交互提示符）；
// null＝没跑成（spawn 失败/超时/被中止/起点不在枚举表里）。execFileFn 与 timeoutMs
// 可注入，单测不碰真 PowerShell。
//
// delayMs：查询前先睡这么久（脚本里 Start-Sleep）。给「复探」用——调用方要在首探
// 之后一拍再取一次观察，把它塞进子进程自己睡，两个探测的启动税就能重叠：修前
// 复探是串行等首探返回再起进程（再付一次 ~0.3s 启动税 + ~0.35s 查询），现在是
// 「复探进程先起、睡够再查」，整段等待由最慢的一次封顶。
// timeoutMs 只算查询这一段，睡的那段另加——所以 execFile 的 timeout 是
// delayMs + timeoutMs。
// signal：AbortSignal。首探判出「干净」后调用方立刻掐掉还在睡的复探子进程，
// Node 会杀掉它并把这次探测置成 null（调用方此时已不再看这个值）。
export async function probeTerminalCommandTree(rootPid, {
  anchorPid = null,
  execFileFn = execFile,
  timeoutMs = SWITCH_GUARD_PROBE_TIMEOUT_MS,
  delayMs = 0,
  signal = null,
} = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null;
  const sleepMs = Number.isFinite(delayMs) && delayMs > 0 ? Math.round(delayMs) : 0;
  const script = sleepMs > 0 ? `Start-Sleep -Milliseconds ${sleepMs}; ${SWITCH_GUARD_PS_QUERY}` : SWITCH_GUARD_PS_QUERY;
  let out;
  try {
    out = await new Promise((resolve, reject) => {
      execFileFn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          windowsHide: true,
          timeout: timeoutMs + sleepMs,
          maxBuffer: 8 * 1024 * 1024,
          ...(signal ? { signal } : {}),
        },
        (error, stdout) => {
          if (error && !stdout) reject(error);
          else resolve(stdout);
        },
      );
    });
  } catch {
    return null;
  }
  return hasRunningCommand(parseProcessTable(out), { rootPid, anchorPid });
}
