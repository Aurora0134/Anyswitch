// Client update jobs outlive the panel. The record lives next to the panel's
// other data, and the install itself runs in a detached process: closing or
// restarting the panel must not kill an install halfway through a global
// package directory.
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile } from "./atomic-write.mjs";
import { OFFICIAL_MSIX_CLIENTS } from "./client-lifecycle.mjs";
import { alignDshTuiPlugins } from "./dsh-tui-align.mjs";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function clientUpdateJournalDir(root) {
  return join(root, "client-updates");
}

export function readClientUpdateRun(dir, runId) {
  if (!RUN_ID.test(String(runId ?? ""))) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(dir, `${runId}.json`), "utf8"));
    if (parsed?.runId !== runId || (parsed.state !== "running" && parsed.state !== "done")) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function listClientUpdateRuns(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => readClientUpdateRun(dir, name.slice(0, -".json".length)))
    .filter(Boolean);
}

export function writeClientUpdateRun(dir, run) {
  mkdirSync(dir, { recursive: true });
  atomicWriteFile(join(dir, `${run.runId}.json`), `${JSON.stringify(run)}\n`);
}

// A record that still says "running" after its process is gone is a crash,
// not an install that is still going. The lock for that client has to come
// off, or the next update of the same client is refused forever.
export function reapDeadClientUpdateRuns(dir, alive, now = () => new Date().toISOString()) {
  for (const run of listClientUpdateRuns(dir)) {
    if (run.state !== "running") continue;
    if (Number.isInteger(run.workerPid) && run.workerPid > 0 && alive(run.workerPid)) continue;
    writeClientUpdateRun(dir, {
      ...run,
      state: "done",
      finishedAt: now(),
      result: { outcome: "failed", message: "更新中断，请重新检测确认结果" },
    });
  }
}

export function runningClientUpdate(dir, clientId) {
  return listClientUpdateRuns(dir).find((run) => run.state === "running" && run.clientId === clientId) ?? null;
}

export function clientUpdateStatus(run) {
  const payload = {
    ok: true,
    runId: run.runId,
    clientId: run.clientId,
    action: run.action,
    state: run.state,
    startedAt: run.startedAt,
  };
  if (run.state === "done") Object.assign(payload, { finishedAt: run.finishedAt }, run.result);
  return payload;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The worker is detached and its pipes are dropped, so the panel exiting
// does not take the install with it. Returns the worker pid.
export function spawnClientUpdateWorker({
  runId,
  journalDir,
  spawnFn = spawn,
  execPath = process.execPath,
  workerPath = fileURLToPath(new URL("./client-update-worker.mjs", import.meta.url)),
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

// dsh-tui 插件对齐结果 → 结果句里追加的一句话。none/unknown 无话可说，保持沉默。
function dshTuiAlignClause(align) {
  switch (align?.state) {
    case "updated": {
      const versions = [...new Set((align.profiles ?? []).filter((p) => p.state === "updated" && p.to).map((p) => p.to))];
      return versions.length ? `终端插件 dsh-tui 已一并更新到 ${versions.join("、")}` : null;
    }
    case "current":
      return "终端插件 dsh-tui 已是最新适配版本";
    case "incompatible-newer":
      return "终端插件 dsh-tui 有新版本，但尚未适配当前 DSH 版本";
    case "failed":
      return "终端插件 dsh-tui 自动更新未完成，可稍后手工更新";
    default:
      return null;
  }
}

// Entry used by the worker. Reads the request the panel already recorded,
// runs the install, then writes the same outcome the panel used to compute
// in memory. A worker that dies before this returns leaves the record as
// "running"; the next panel start reaps it.
export async function executeClientUpdate({
  runId,
  journalDir,
  runLifecycle,
  environment,
  releases,
  compareVersions,
  alignDshTui = alignDshTuiPlugins,
  alive = processAlive,
  now = () => new Date().toISOString(),
}) {
  const run = readClientUpdateRun(journalDir, runId);
  if (!run || run.state !== "running") return null;
  writeClientUpdateRun(journalDir, { ...run, workerPid: process.pid });
  let result;
  try {
    // 动手前的版本由面板登记。安装进程不再读一遍：那次读取没有 force，
    // 读到的是缓存，而面板已经拿过同一份。
    const beforeVersion = run.beforeVersion ?? null;
    const command = await runLifecycle({
      id: run.clientId,
      action: run.action,
      commandPath: run.commandPath ?? null,
      targetVersion: run.targetVersion,
      // 逐形态的动手前版本：桌面腿自己比对要用它（CLI 与桌面端的版本可以不同，
      // 面板登记的是每一形态各自的版本）。
      installedVersionByForm: run.beforeByForm ?? null,
    });
    const after = (await environment.getState({ force: true })).clients.find((client) => client.id === run.clientId);
    const installation = after?.installations?.[0] ?? null;
    const afterVersion = installation?.version ?? null;
    // 官方版本查询渠道跟被更新那条安装项的 remoteId 走：qoder 的客户端 id 是桌面端
    // 渠道，CLI 更新要比对的是 installations[0] 的 "qoder-cli"。
    const latest = await releases.getClientLatest(installation?.remoteId ?? run.clientId, { force: true });
    const order = latest?.state === "ok" && afterVersion ? compareVersions(afterVersion, latest.version) : null;
    const comparison = order === null ? "unknown" : order < 0 ? "update_available" : order > 0 ? "ahead" : "current";
    if (Array.isArray(command.legs)) {
      // 多腿客户端：逐腿一句、按形态取名（CLI/Desktop，与关于页徽标同一口径），
      // 顶层 outcome 归并——有失败即 failed，全未动即 unchanged，其余 updated。
      const legViews = command.legs.map((leg) => {
        const label = leg.form === "cli" ? "CLI" : "Desktop";
        const inst = (after?.installations ?? []).find((i) => i.kind === leg.form) ?? null;
        const legAfter = inst?.version ?? null;
        const before = run.beforeByForm?.[leg.form] ?? null;
        let legOutcome, legMessage;
        if (!leg.ok) {
          legOutcome = "failed";
          legMessage = leg.networkError
            ? "网络问题，请检查网络后重试"
            : leg.appRunning
              ? `Desktop 正在运行，请先退出 ${OFFICIAL_MSIX_CLIENTS[run.clientId]?.displayName ?? "对应"} 桌面端后重试`
              : leg.form === "desktop"
                ? leg.storePageOpened
                  ? "Desktop 更新未完成，已打开应用商店页"
                  : leg.wingetMissing
                    ? "Desktop 更新工具缺失（winget），请安装后重试"
                    : "Desktop 更新命令执行失败，请稍后重试"
                : leg.npmMissing
                  ? "CLI 更新工具缺失（npm），请修复或重装 Node.js 后重试"
                  : leg.timedOut
                    ? "CLI 更新用时过长被中止，请检查网络后重新检测确认结果"
                    : "CLI 更新命令执行失败，请稍后重试";
        } else if (leg.noUpgrade) {
          legOutcome = "unchanged";
          legMessage = `${label} 已是最新`;
        } else if (leg.form === "cli" && before && legAfter && before === legAfter && comparison === "update_available") {
          // 在案保护（grok 条目）：镜像源滞后时 npm 退出码 0 但版本原地踏步，
          // 必须如实报「未变化」，与下方单腿分支同口径，不许谎报「已更新」。
          legOutcome = "unchanged";
          legMessage = `${label} 更新已完成，但本地版本未变化，可能仍有旧版本在生效`;
        } else {
          legOutcome = "updated";
          const known = leg.installedVersion ?? legAfter;
          legMessage = known ? `${label} 已更新到 ${known}` : `${label} 更新已完成`;
        }
        return { form: leg.form, outcome: legOutcome, versionBefore: before, versionAfter: legAfter, message: legMessage };
      });
      result = {
        outcome: legViews.some((v) => v.outcome === "failed")
          ? "failed"
          : legViews.every((v) => v.outcome === "unchanged")
            ? "unchanged"
            : "updated",
        message: legViews.map((v) => v.message).join("；"),
        detail: command.output || undefined,
        legs: legViews,
      };
    } else if (!command.ok) {
      result = {
        outcome: "failed",
        message: command.npmMissing
          ? "更新工具缺失（npm），请修复或重装 Node.js 后重试"
          : command.timedOut
            ? "更新用时过长被中止，请检查网络后重新检测确认结果"
            : "更新命令执行失败，请稍后重试",
        detail: command.output || undefined,
      };
    } else if (installation?.issue === "not_runnable") {
      result = { outcome: "installed_not_runnable", message: "已安装但无法运行，请先检查运行环境（如 Node 版本）" };
    } else if (!afterVersion) {
      result = { outcome: "not_found_after", message: "命令已执行，但仍未找到该客户端，请重新检测确认" };
    } else if (beforeVersion && beforeVersion === afterVersion && comparison === "update_available") {
      result = { outcome: "unchanged", message: "更新已完成，但本地版本未变化，可能仍有旧版本在生效" };
    } else {
      result = { outcome: "updated", message: `已更新到 ${afterVersion}` };
    }
    result = { ...result, beforeVersion, afterVersion, latestVersion: latest?.state === "ok" ? latest.version : null, comparison };
    // dsh 联动：本体更新流程收尾时对齐 dsh-tui profile 插件（每次点更新都查——
    // 面板外的升级留下的插件失配同样借此自愈；2026-09-28 的 dsh-cli 事故即此
    // 形态）。对齐只往结果上附加信息，永不翻转 CLI 腿本身的成败。
    if (run.clientId === "dsh" && command.ok && !Array.isArray(command.legs)) {
      let align;
      try {
        align = await alignDshTui({ dshVersion: afterVersion });
      } catch {
        align = { state: "failed", profiles: [] };
      }
      const clause = dshTuiAlignClause(align);
      if (clause) result.message = `${result.message}；${clause}`;
      const alignOutput = (align?.profiles ?? []).find((p) => p.state === "failed")?.output ?? align?.output;
      if (align?.state === "failed" && alignOutput) result.detail = [result.detail, alignOutput].filter(Boolean).join("\n");
    }
  } catch {
    result = { outcome: "failed", message: "更新失败，请重新检测确认结果" };
  }
  const current = readClientUpdateRun(journalDir, runId) ?? run;
  if (!alive(process.pid)) return result;
  writeClientUpdateRun(journalDir, { ...current, state: "done", finishedAt: now(), result, workerPid: process.pid });
  return result;
}


