// Anyswitch 自身的一键更新。面板把目标 release tag 登记进 journal 后拉起本模块
// 的脱离 worker：就地浅拉取 tag、换装 app 工作树、装依赖，然后重启 relay、等
// panel-host 经 restart-helper 自杀换新并验证复活。
//
// 安全语义与 client-lifecycle 一致——失败绝不留半截服务：真正动进程的只有 relay
// 重启（秒级）与面板自退（helper 负责拉起新面板）；换装前的每一步（git fetch /
// checkout / npm install）都在旧面板与 relay 照常服务期间完成，失败时服务无损。
// 换装之后的两个中止点（版本校验不符、依赖安装失败）会先把工作树还原到换装前
// 记录的 HEAD，不让磁盘停在「新代码配旧进程」的半截状态。工作树归更新器全权
// 管理：checkout 一律 --force（收敛手动同步留下的漂移），logs/node_modules 等
// 运行时文件在 .gitignore 里不受影响。
import { execFile as execFileDefault, spawn as spawnDefault } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readClientUpdateRun, writeClientUpdateRun } from "./client-update-journal.mjs";
import { resolveNpmCli } from "./client-lifecycle.mjs";
import { restartRelay } from "./relay-process-manager.mjs";
import { probeWatchdog, spawnWatchdog, stopWatchdog } from "./agent-watchdog.mjs";
import { storePaths } from "./store-io.mjs";

export const SELF_UPDATE_CLIENT_ID = "anyswitch";
export const APP_REPO_URL = "https://github.com/Aurora0134/Anyswitch.git";

// worker 等旧面板退场、再等新面板接管的窗口。面板侧的 helper 有自己的 10s/12s
// 预算，这两个窗口给得比它宽——worker 的结论只写 journal，超时各自有如实的结果。
const PANEL_DOWN_TIMEOUT_MS = 20_000;
const PANEL_UP_TIMEOUT_MS = 30_000;
const POLL_MS = 500;
// git fetch 经 SNIBypass 通道，慢但不能没有上限；npm 与 client-lifecycle 同一量级。
const GIT_TIMEOUT_MS = 10 * 60_000;
const NPM_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 2000;

// 目标 tag 只接受 release-service 的发布形态（v<semver>）：tag 来自 journal 记录，
// 进 git 参数前钉住形态，杜绝任何以 `-` 开头被当成选项解析的余地。
const TARGET_TAG_PATTERN = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
// npm 显式指回官方源：用户 npm 配置的 registry 可能停在同步落后的镜像上
// （client-lifecycle 对 grok 已确立同一先例）。
const NPM_REGISTRY = "https://registry.npmjs.org";

// 与 client-lifecycle 同一口径的输出收尾：只留末 8 行、总长截断。
function tailLines(text, limit, maxChars) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(Math.max(0, lines.length - limit)).join("\n");
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail;
}

// execFile 形态的一跳：git / npm 共用。stdout 与 stderr 谁非空取谁（git 的进度
// 与报错走 stderr，rev-parse/get-url 的数据走 stdout），ENOENT 单独标出。
function runCommand({ file, args, cwd = null, spawnFn = execFileDefault, timeoutMs = GIT_TIMEOUT_MS }) {
  return new Promise((done) => {
    spawnFn(file, args, { ...(cwd ? { cwd } : {}), timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      const raw = String(stderr ?? "").trim() || String(stdout ?? "").trim();
      done({ ok: !error, missing: error?.code === "ENOENT", timedOut: Boolean(error?.killed), output: tailLines(raw, 8, MAX_OUTPUT_CHARS) });
    });
  });
}

// 快捷方式拉起的进程 PATH 可能很窄（client-lifecycle 的 npm 同理），git 依次试
// PATH 与标准安装位；ENOENT 换下一个候选，其余错误当场定夺。
async function runGit({ args, cwd, spawnFn, env, timeoutMs = GIT_TIMEOUT_MS }) {
  const candidates = ["git", join(env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd", "git.exe")];
  let last = { ok: false, missing: true, timedOut: false, output: "" };
  for (const candidate of candidates) {
    const result = await runCommand({ file: candidate, args, cwd, spawnFn, timeoutMs });
    if (!result.missing) return result;
    last = result;
  }
  return last;
}

// 面板复活探测：app-info 是最轻的带版本端点。null = 没人应答（端口安静）。
async function probePanelAppInfo(port = 47820, fetchFn = fetch) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetchFn(`http://127.0.0.1:${port}/panel/api/app-info`, { signal: controller.signal });
      if (!response.ok) return null;
      const data = await response.json();
      return { version: typeof data?.version === "string" ? data.version : null };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

// 回滚/接管的兜底拉起：与 helper spawn panel-host 同一形态（脱离、隐藏、丢管道）。
function defaultSpawnPanelHost({ appDir, execPath = process.execPath }) {
  const child = spawnDefault(execPath, [join(appDir, "panel-host.mjs")], {
    cwd: appDir,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    shell: false,
  });
  child.unref?.();
  return child.pid;
}

// 自更新 worker 的脱离拉起，形态与 spawnClientUpdateWorker 逐字一致：
// 管道丢弃使面板退出不带走安装（journal.mjs 同一条注释的理由）。
export function spawnSelfUpdateWorker({
  runId,
  journalDir,
  spawnFn = spawnDefault,
  execPath = process.execPath,
  workerPath = fileURLToPath(new URL("./self-update-worker.mjs", import.meta.url)),
} = {}) {
  const child = spawnFn(execPath, [workerPath, runId, journalDir], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    shell: false,
  });
  child.unref?.();
  return child.pid;
}

// remote URL 归一化：尾斜杠与 .git 后缀不影响同一性判断。
function normalizeRepoUrl(url) {
  return String(url ?? "").replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

// Entry used by the worker. Reads the request the panel already recorded and
// drives the whole update. Every step writes its phase back so the panel (and
// the page) can render progress; the final result uses the same shape the
// client-update journal does.
export async function runSelfUpdate({
  runId,
  journalDir,
  io = { existsSync, readFileSync },
  spawnFn = execFileDefault,
  execPath = process.execPath,
  env = process.env,
  fetchFn = fetch,
  restartRelayFn = (root) => restartRelay(root),
  stopWatchdogFn = (e) => stopWatchdog(e),
  probeWatchdogFn = () => probeWatchdog(),
  spawnWatchdogFn = (e) => spawnWatchdog(e),
  spawnPanelHostFn = defaultSpawnPanelHost,
  probePanelFn = (port) => probePanelAppInfo(port, fetchFn),
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date().toISOString(),
  nowMs = Date.now,
  gitTimeoutMs = GIT_TIMEOUT_MS,
  npmTimeoutMs = NPM_TIMEOUT_MS,
  panelDownTimeoutMs = PANEL_DOWN_TIMEOUT_MS,
  panelUpTimeoutMs = PANEL_UP_TIMEOUT_MS,
  pollMs = POLL_MS,
  panelPort = 47820,
} = {}) {
  const run = readClientUpdateRun(journalDir, runId);
  if (!run || run.state !== "running" || run.clientId !== SELF_UPDATE_CLIENT_ID) return null;
  writeClientUpdateRun(journalDir, { ...run, workerPid: process.pid });
  const appDir = run.appDir ?? null;
  const targetVersion = run.targetVersion ?? null;
  const targetTag = run.targetTag ?? null;
  const repoUrl = run.repoUrl ?? APP_REPO_URL;
  const relayRoot = run.relayRoot ?? storePaths().root;
  const beforeVersion = run.beforeVersion ?? null;

  // 阶段推进：journal 是 worker 与面板（监听器）、页面（轮询）之间唯一的进度通道。
  const setPhase = (phase) => {
    const current = readClientUpdateRun(journalDir, runId);
    if (current) writeClientUpdateRun(journalDir, { ...current, phase, workerPid: process.pid });
  };
  const finish = (result) => {
    const current = readClientUpdateRun(journalDir, runId) ?? run;
    writeClientUpdateRun(journalDir, { ...current, state: "done", finishedAt: now(), result, workerPid: process.pid });
    return result;
  };
  const gitFailure = (step, r) => r.missing
    ? `未检测到 Git，请先安装 Git 后重试`
    : r.timedOut
      ? `${step}用时过长被中止，请检查网络后重试`
      : `${step}失败，请稍后重试`;

  let watchdogStopped = false;
  const restoreWatchdog = async () => {
    if (!watchdogStopped) return;
    try { await spawnWatchdogFn(env); } catch { /* 恢复失败不翻转结果：面板设置页可见漂移 */ }
  };

  try {
    if (!appDir || !targetVersion || !targetTag) {
      return finish({ outcome: "failed", message: "更新信息不完整，请重新检查更新后重试", beforeVersion, latestVersion: targetVersion });
    }
    if (!TARGET_TAG_PATTERN.test(targetTag)) {
      return finish({ outcome: "failed", message: "更新目标无效，请重新检查更新后重试", beforeVersion, latestVersion: targetVersion });
    }
    setPhase("staging");
    // 1. 确保 app 工作树有 git 身份：镜像安装（无 .git）首次引导；clone 安装只校正 remote。
    if (!io.existsSync(join(appDir, ".git"))) {
      const init = await runGit({ args: ["init"], cwd: appDir, spawnFn, env });
      if (!init.ok) return finish({ outcome: "failed", message: gitFailure("准备更新环境", init), detail: init.output || undefined, beforeVersion, latestVersion: targetVersion });
      const remote = await runGit({ args: ["remote", "add", "origin", repoUrl], cwd: appDir, spawnFn, env });
      if (!remote.ok) return finish({ outcome: "failed", message: gitFailure("连接更新源", remote), detail: remote.output || undefined, beforeVersion, latestVersion: targetVersion });
    } else {
      const current = await runGit({ args: ["remote", "get-url", "origin"], cwd: appDir, spawnFn, env });
      if (current.ok && normalizeRepoUrl(current.output) !== normalizeRepoUrl(repoUrl)) {
        await runGit({ args: ["remote", "set-url", "origin", repoUrl], cwd: appDir, spawnFn, env });
      }
    }
    // 2. 换装前记住恢复点。首次引导没有 HEAD，恢复分支如实告知。
    const head = await runGit({ args: ["rev-parse", "HEAD"], cwd: appDir, spawnFn, env });
    const beforeHead = head.ok ? head.output.split(/\r?\n/)[0]?.trim() || null : null;
    // 换装之后的中止都先把工作树还原到这个点：进程还活着（旧模块在内存里服务），
    // 但磁盘不能停在「新代码配旧进程」——面板静态资源是按请求活读的。
    const restoreTree = async () => {
      if (!beforeHead) return false;
      const back = await runGit({ args: ["checkout", "--detach", "--force", beforeHead], cwd: appDir, spawnFn, env });
      return back.ok;
    };
    // 3. 浅拉取目标 tag：只取这一层历史，几 MB 量级，走与「检查更新」同一网络前提。
    const fetched = await runGit({ args: ["fetch", "--depth", "1", "--no-tags", "origin", "tag", targetTag], cwd: appDir, spawnFn, env, timeoutMs: gitTimeoutMs });
    if (!fetched.ok) return finish({ outcome: "failed", message: gitFailure(`下载 ${targetTag}`, fetched), detail: fetched.output || undefined, beforeVersion, latestVersion: targetVersion });
    // 4. 就地换装。force 是所有权声明：手动同步留下的漂移在这里被收敛成目标版本。
    const checkedOut = await runGit({ args: ["checkout", "--detach", "--force", "FETCH_HEAD"], cwd: appDir, spawnFn, env });
    if (!checkedOut.ok) return finish({ outcome: "failed", message: gitFailure("应用新版本", checkedOut), detail: checkedOut.output || undefined, beforeVersion, latestVersion: targetVersion });
    // 5. 落盘的版本必须与目标一致，否则还原工作树后止步——面板与 relay 都还没动过。
    let treeVersion = null;
    try { treeVersion = JSON.parse(io.readFileSync(join(appDir, "package.json"), "utf8")).version ?? null; } catch { treeVersion = null; }
    if (treeVersion !== targetVersion) {
      const restored = await restoreTree();
      return finish({
        outcome: "failed",
        message: `下载的代码版本（${treeVersion ?? "未知"}）与目标（${targetVersion}）不一致，已中止更新${restored ? "，文件已还原到更新前状态" : ""}`,
        beforeVersion,
        afterVersion: restored ? beforeVersion : treeVersion,
        latestVersion: targetVersion,
      });
    }
    // 6. 依赖安装：仍在旧进程服务期间做，不占中断窗口。registry 钉回官方源，
    //    用户 npm 配置里同步落后的镜像不会掺进这次安装。
    setPhase("installing");
    const npmCli = resolveNpmCli({ execPath, io });
    if (!npmCli) {
      const restored = await restoreTree();
      return finish({
        outcome: "failed",
        message: `未找到 Node.js 自带的安装工具（npm），请修复或重装 Node.js 后重试${restored ? "；文件已还原到更新前状态" : ""}`,
        beforeVersion,
        afterVersion: restored ? beforeVersion : treeVersion,
        latestVersion: targetVersion,
      });
    }
    const npm = await runCommand({ file: execPath, args: [npmCli, "install", "--no-audit", "--no-fund", `--registry=${NPM_REGISTRY}`], cwd: appDir, spawnFn, timeoutMs: npmTimeoutMs });
    if (!npm.ok) {
      const restored = await restoreTree();
      return finish({
        outcome: "failed",
        message: `${npm.timedOut ? "新版本组件安装用时过长被中止，请检查网络后重试" : "新版本组件安装失败，请稍后重试"}${restored ? "；文件已还原到更新前状态" : ""}`,
        detail: npm.output || undefined,
        beforeVersion,
        afterVersion: restored ? beforeVersion : treeVersion,
        latestVersion: targetVersion,
      });
    }
    // 7. 中断窗口开始：watchdog 先停（防 3s 轮询在窗口内拉起旧代码 relay；即使拉起，
    //    磁盘已是新代码，只是时序变脏），relay 换新，然后交棒给面板自换。
    setPhase("ready-to-restart");
    const watchdogUp = await probeWatchdogFn().catch(() => false);
    if (watchdogUp) {
      const stopped = await stopWatchdogFn(env).catch(() => ({ ok: false }));
      watchdogStopped = stopped?.ok === true;
    }
    const relay = await restartRelayFn(relayRoot).catch(() => ({ ok: false }));
    const relayClause = relay?.ok ? null : "Relay 重启未完成，可稍后在面板手动重启";
    // 8. 面板内监听器看到 ready-to-restart 就会拉起 helper 并按宽限自退；这里等它退场。
    setPhase("waiting-panel");
    let downSeen = false;
    const downDeadline = nowMs() + panelDownTimeoutMs;
    while (nowMs() < downDeadline) {
      if ((await probePanelFn(panelPort)) === null) { downSeen = true; break; }
      await delay(pollMs);
    }
    if (!downSeen) {
      await restoreWatchdog();
      // 面板没有退场：文件已换装而旧面板还在跑旧代码。如实记录，不谎报已生效。
      return finish({
        outcome: "updated_pending_restart",
        message: relayClause ? `新版本已就位；${relayClause}，重启面板后生效` : "新版本已就位，重启面板后生效",
        beforeVersion,
        afterVersion: targetVersion,
        latestVersion: targetVersion,
      });
    }
    // 9. 等新面板接管（helper 拉起的新 panel-host 载的就是刚换装的代码）。
    let revived = null;
    const upDeadline = nowMs() + panelUpTimeoutMs;
    while (nowMs() < upDeadline) {
      const identity = await probePanelFn(panelPort);
      if (identity?.version === targetVersion) { revived = identity; break; }
      await delay(pollMs);
    }
    if (revived) {
      await restoreWatchdog();
      return finish({ outcome: "updated", message: `已更新到 ${targetVersion}`, beforeVersion, afterVersion: targetVersion, latestVersion: targetVersion });
    }
    // 10. 新面板没有接管：有恢复点就退回旧版并重装依赖（旧代码配旧依赖才算恢复
    //     完整），再把面板与 relay 拉起；没有恢复点就把面板尽力拉起并如实报告。
    if (beforeHead && (await restoreTree())) {
      let rollbackDepsOk = true;
      const rollbackNpmCli = resolveNpmCli({ execPath, io });
      if (rollbackNpmCli) {
        const rollbackNpm = await runCommand({ file: execPath, args: [rollbackNpmCli, "install", "--no-audit", "--no-fund", `--registry=${NPM_REGISTRY}`], cwd: appDir, spawnFn, timeoutMs: npmTimeoutMs });
        rollbackDepsOk = rollbackNpm.ok;
      }
      const depsClause = rollbackDepsOk ? "" : "；运行组件未完全恢复，请重新执行一次更新";
      try { spawnPanelHostFn({ appDir, execPath }); } catch { /* 拉起失败由下面的探测如实呈现 */ }
      await restartRelayFn(relayRoot).catch(() => ({ ok: false }));
      let backUp = null;
      const backDeadline = nowMs() + panelUpTimeoutMs;
      while (nowMs() < backDeadline) {
        const identity = await probePanelFn(panelPort);
        if (identity) { backUp = identity; break; }
        await delay(pollMs);
      }
      await restoreWatchdog();
      return finish({
        outcome: "rolled_back",
        message: backUp
          ? `新面板未能启动，已恢复到更新前版本${depsClause}`
          : `已恢复到更新前版本，但面板未能自动启动，请用桌面快捷方式重新打开${depsClause}`,
        beforeVersion,
        afterVersion: backUp?.version ?? run.beforeVersion ?? null,
        latestVersion: targetVersion,
      });
    }
    try { spawnPanelHostFn({ appDir, execPath }); } catch { /* 同上 */ }
    await restoreWatchdog();
    return finish({
      outcome: "failed",
      message: beforeHead
        ? "新面板未能启动，恢复旧版本也未成功，请用桌面快捷方式重新打开面板"
        : "新面板未能启动（本次为首次更新，没有可退回的旧版本），请重新打开面板后重试",
      detail: relayClause || undefined,
      beforeVersion,
      afterVersion: null,
      latestVersion: targetVersion,
    });
  } catch {
    await restoreWatchdog();
    return finish({ outcome: "failed", message: "更新失败，请重新检查更新后重试", beforeVersion, latestVersion: targetVersion });
  }
}
