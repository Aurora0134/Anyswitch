// 根目录入口壳的转发执行芯——自更新跨版本契约的机械部分。
//
// 背景：Anyswitch 的自更新是 `git checkout --force` 就地换树，而换树之后到新
// 面板接管之前，仍在内存里跑的是**旧版本**的更新器与旧面板：它们按换树前的
// 根目录旧路径拉起 relay-host / panel-host / panel-host-restart-helper /
// agent-watchdog（这些路径在各模块加载时就以 fileURLToPath(import.meta.url)
// 记死，改不了）。2026-11 分域重构把源码挪进 src/ 后，旧路径在新树里不再存
// 在，旧版升级会卡在「无人复活新面板」处确定性失败并回滚——0.7.0 用户将永
// 远升不上 0.7.1（沙盒三轮实证见 bridge anyswitch STATUS 2026-11-03 在途条）。
//
// 解法：新树在根目录保留少量**零实现转发壳**，把旧路径的拉起转发到 src/ 真
// 入口。壳与真入口同树同 checkout、原子落地；转发时 argv、stdio、cwd、退出码
// 原样传递。常驻进程（relay / panel-host / watchdog）的壳会作为 wrapper 活满
// 子进程的整个生命周期——pidfile 记下的壳 pid 在停服时按 taskkill /T 树杀连
// 真身一起收，端口归属探测按命令行里的入口名子串匹配也依然命中真身。
//
// 契约：根目录这批壳的入口名，与 src/ 侧 panel-host / relay-host 等关键入口
// 路径，共同构成自更新协议的跨版本契约面——改名、挪位、删除任何一枚都会打断
// 某一代已发布旧版的升级。0.7.1 自身的更新器已全部按 src/ 路径拉起（本模块
// 只服务 ≤0.7.0 的存量更新器），待旧版存量出清后根壳可整组退役；src/ 侧入
// 口路径则从此是长期契约，后续布局调整必须保住或在更新器里显式换代。
//
// 实现取舍：各 src 入口都带 isEntryModule 守卫（argv[1] 须等于模块自身路径
// 才执行 main），所以壳不能 re-export——只能转发 exec，让真入口以自己的路径
// 成为 argv[1]，守卫自然放行。

import { spawn as spawnDefault } from "node:child_process";
import { fileURLToPath } from "node:url";

// 转发并接管当前进程：spawn 真入口（argv[2:] 原样跟队），stdio 全 inherit
// （终端交互、ps1 shim 的管道输入、旧面板给 helper 的 stderr 重定向都靠它），
// 退出码透传（shim 的 cmd/ps1 靠 EXIT /b %ERRORLEVEL% 把结果还给用户终端）。
// spawn 失败（target 缺失等）往 stderr 落一行并退 1——半换树状态下这行字是
// 唯一的现场诊断线索。settled 防护 error 与 exit 双拍都触发退出。
export function forwardEntry(targetUrl, {
  spawnFn = spawnDefault,
  execPath = process.execPath,
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  stderr = process.stderr,
  exit = (code) => process.exit(code),
} = {}) {
  const target = fileURLToPath(targetUrl);
  const child = spawnFn(execPath, [target, ...argv], {
    cwd,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    exit(code);
  };
  child.on("error", (err) => {
    stderr.write(`入口壳转发失败 ${target}: ${err?.message ?? err}\n`);
    finish(1);
  });
  child.on("exit", (code) => finish(code ?? 1));
  return child;
}
