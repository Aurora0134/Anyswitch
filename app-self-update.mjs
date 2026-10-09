// Anyswitch 自身的更新执行面，分两步：下载与应用。
//
// 下载（step=download）：把目标 release tag 浅拉进本地 git 仓库，并用
// git show 核对 tag 里的 package.json 版本——全程不碰工作树、不动任何进程，
// 失败即服务无损。完成后记录停在「已下载待应用」（phase=staged）。
//
// 应用（step=apply）：同一条记录被面板翻回 running 后由新 worker 接管——幂等
// 补拉、记录回滚点、--detach --force 换装、复核树版本、装依赖（中止都先还原
// 工作树），然后停 watchdog、重启 relay、等 panel-host 经 restart-helper 自杀
// 换新并验证复活；新面板未接管以回滚点退回旧版并重装依赖。
//
// 工作树归更新器全权管理：checkout 一律 --force（收敛手动同步留下的漂移），
// logs/node_modules 等运行时文件在 .gitignore 里不受影响。
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
// raw 模式保留完整 stdout（git show 读文件内容用，8 行收尾会把 JSON 截残）。
function runCommand({ file, args, cwd = null, spawnFn = execFileDefault, timeoutMs = GIT_TIMEOUT_MS, raw = false }) {
  return new Promise((done) => {
    spawnFn(file, args, { ...(cwd ? { cwd } : {}), timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      const output = raw && !error ? String(stdout ?? "") : tailLines(String(stderr ?? "").trim() || String(stdout ?? "").trim(), 8, MAX_OUTPUT_CHARS);
      done({ ok: !error, missing: error?.code === "ENOENT", timedOut: Boolean(error?.killed), output });
    });
  });
}

// 快捷方式拉起的进程 PATH 可能很窄（client-lifecycle 的 npm 同理），git 依次试
// PATH 与标准安装位；ENOENT 换下一个候选，其余错误当场定夺。
async function runGit({ args, cwd, spawnFn, env, timeoutMs = GIT_TIMEOUT_MS, raw = false }) {
  const candidates = ["git", join(env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd", "git.exe")];
  let last = { ok: false, missing: true, timedOut: false, output: "" };
  for (const candidate of candidates) {
    const result = await runCommand({ file: candidate, args, cwd, spawnFn, timeoutMs, raw });
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
// drives the step the record names (download by default). Every step writes its
// phase back so the panel (and the page) can render progress; the final result
// uses the same shape the client-update journal does.
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
  const step = run.step === "apply" ? "apply" : "download";
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
  const gitFailure = (stepName, r) => r.missing
    ? `未检测到 Git，请先安装 Git 后重试`
    : r.timedOut
      ? `${stepName}用时过长被中止，请检查网络后重试`
      : `${stepName}失败，请稍后重试`;

  if (!appDir || !targetVersion || !targetTag) {
    return finish({ outcome: "failed", message: "更新信息不完整，请重新检查更新后重试", beforeVersion, latestVersion: targetVersion });
  }
  if (!TARGET_TAG_PATTERN.test(targetTag)) {
    return finish({ outcome: "failed", message: "更新目标无效，请重新检查更新后重试", beforeVersion, latestVersion: targetVersion });
  }

  // 确保 app 工作树有 git 身份：镜像安装（无 .git）首次引导；clone 安装只校正 remote。
  const ensureGitReady = async () => {
    if (!io.existsSync(join(appDir, ".git"))) {
      const init = await runGit({ args: ["init"], cwd: appDir, spawnFn, env });
      if (!init.ok) return gitFailure("准备更新环境", init);
      const remote = await runGit({ args: ["remote", "add", "origin", repoUrl], cwd: appDir, spawnFn, env });
      if (!remote.ok) return gitFailure("连接更新源", remote);
      return null;
    }
    const current = await runGit({ args: ["remote", "get-url", "origin"], cwd: appDir, spawnFn, env });
    if (current.ok && normalizeRepoUrl(current.output) !== normalizeRepoUrl(repoUrl)) {
      await runGit({ args: ["remote", "set-url", "origin", repoUrl], cwd: appDir, spawnFn, env });
    }
    return null;
  };

  const fetchTarget = () => runGit({ args: ["fetch", "--depth", "1", "--no-tags", "origin", "tag", targetTag], cwd: appDir, spawnFn, env, timeoutMs: gitTimeoutMs });

  if (step === "download") {
    // ── 下载：只把比特拉进本地仓库，工作树与进程一个都不动 ──
    setPhase("staging");
    const readyError = await ensureGitReady();
    if (readyError) return finish({ outcome: "failed", message: readyError, beforeVersion, latestVersion: targetVersion });
    const fetched = await fetchTarget();
    if (!fetched.ok) return finish({ outcome: "failed", message: gitFailure(`下载 ${targetTag}`, fetched), detail: fetched.output || undefined, beforeVersion, latestVersion: targetVersion });
    // 不脱裤查验：直接读 tag 里的 package.json，版本不符在此止步——磁盘上什么都没动。
    const shown = await runGit({ args: ["show", "FETCH_HEAD:package.json"], cwd: appDir, spawnFn, env, raw: true });
    let tagVersion = null;
    try { tagVersion = JSON.parse(shown.output).version ?? null; } catch { tagVersion = null; }
    if (!shown.ok || tagVersion !== targetVersion) {
      return finish({ outcome: "failed", message: `下载的代码版本（${tagVersion ?? "未知"}）与目标（${targetVersion}）不一致，已中止更新`, beforeVersion, latestVersion: targetVersion });
    }
    // staged 是「已下载待应用」的对外标记：面板据它把按钮换成「应用更新」。
    setPhase("staged");
    return finish({ outcome: "downloaded", message: `已下载 ${targetVersion}，应用后生效`, beforeVersion, latestVersion: targetVersion });
  }

  // ── 应用：换装 + 依赖 + 重启 ──
  let watchdogStopped = false;
  const restoreWatchdog = async () => {
    if (!watchdogStopped) return;
    try { await spawnWatchdogFn(env); } catch { /* 恢复失败不翻转结果：面板设置页可见漂移 */ }
  };

  try {
    setPhase("installing");
    const readyError = await ensureGitReady();
    if (readyError) return finish({ outcome: "failed", message: readyError, beforeVersion, latestVersion: targetVersion });
    // 幂等补拉：已下载过的 tag 秒回；也兜住「下载后对象被 gc」的边角。
    const fetched = await fetchTarget();
    if (!fetched.ok) return finish({ outcome: "failed", message: gitFailure(`下载 ${targetTag}`, fetched), detail: fetched.output || undefined, beforeVersion, latestVersion: targetVersion });
    // 回滚点在应用开始时现取：HEAD 此刻仍是旧版（下载阶段不碰工作树）。首次引导
    // 没有 HEAD，回滚分支如实告知。
    const head = await runGit({ args: ["rev-parse", "HEAD"], cwd: appDir, spawnFn, env });
    const beforeHead = head.ok ? head.output.split(/\r?\n/)[0]?.trim() || null : null;
    // 换装之后的中止都先把工作树还原到这个点：进程还活着（旧模块在内存里服务），
    // 但磁盘不能停在「新代码配旧进程」——面板静态资源是按请求活读的。
    const restoreTree = async () => {
      if (!beforeHead) return false;
      const back = await runGit({ args: ["checkout", "--detach", "--force", beforeHead], cwd: appDir, spawnFn, env });
      return back.ok;
    };
    // 就地换装。force 是所有权声明：手动同步留下的漂移在这里被收敛成目标版本。
    const checkedOut = await runGit({ args: ["checkout", "--detach", "--force", "FETCH_HEAD"], cwd: appDir, spawnFn, env });
    if (!checkedOut.ok) return finish({ outcome: "failed", message: gitFailure("应用新版本", checkedOut), detail: checkedOut.output || undefined, beforeVersion, latestVersion: targetVersion });
    // 落盘的版本必须与目标一致，否则还原工作树后止步——面板与 relay 都还没动过。
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
    // 依赖安装：仍在旧进程服务期间做，不占中断窗口。registry 钉回官方源，
    // 用户 npm 配置里同步落后的镜像不会掺进这次安装。
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
    // 中断窗口开始：watchdog 先停（防 3s 轮询在窗口内拉起旧代码 relay；即使拉起，
    // 磁盘已是新代码，只是时序变脏），relay 换新，然后交棒给面板自换。
    setPhase("ready-to-restart");
    const watchdogUp = await probeWatchdogFn().catch(() => false);
    if (watchdogUp) {
      const stopped = await stopWatchdogFn(env).catch(() => ({ ok: false }));
      watchdogStopped = stopped?.ok === true;
    }
    const relay = await restartRelayFn(relayRoot).catch(() => ({ ok: false }));
    const relayClause = relay?.ok ? null : "Relay 重启未完成，可稍后在面板手动重启";
    // 面板内监听器看到 ready-to-restart 就会拉起 helper 并按宽限自退；这里等它退场。
    // 注意监听器在 ready-to-restart 就点火：relay 重启要花几秒，面板可能在我们
    // 还没到这一步时就换完了。所以「退场」的证据有两种——探测落空（旧面板走了、
    // 新面板还没起），或答话的已是目标版本（换装抢在轮询前完成）。两种都算数。
    setPhase("waiting-panel");
    let downSeen = false;
    const downDeadline = nowMs() + panelDownTimeoutMs;
    while (nowMs() < downDeadline) {
      const identity = await probePanelFn(panelPort);
      if (identity === null || identity?.version === targetVersion) { downSeen = true; break; }
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
    // 等新面板接管（helper 拉起的新 panel-host 载的就是刚换装的代码）。
    let revived = null;
    const upDeadline = nowMs() + panelUpTimeoutMs;
    while (nowMs() < upDeadline) {
      const identity = await probePanelFn(panelPort);
      if (identity?.version === targetVersion) { revived = identity; break; }
      await delay(pollMs);
    }
    if (revived) {
      await restoreWatchdog();
      return finish({ outcome: "updated", message: `已更新到 ${targetVersion}${relayClause ? `；${relayClause}` : ""}`, beforeVersion, afterVersion: targetVersion, latestVersion: targetVersion });
    }
    // 新面板没有接管：有恢复点就退回旧版并重装依赖（旧代码配旧依赖才算恢复
    // 完整），再把面板与 relay 拉起；没有恢复点就把面板尽力拉起并如实报告。
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
