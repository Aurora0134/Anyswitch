import { createHash } from "node:crypto";
import { spawn as spawnDefault } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile } from "../store/atomic-write.mjs";
import { readClientUpdateRun, writeClientUpdateRun } from "../agents/client-update-journal.mjs";
import { restartRelay } from "../relay/relay-process-manager.mjs";
import { probeWatchdog, spawnWatchdog, stopWatchdog } from "../agents/agent-watchdog.mjs";
import { storePaths } from "../store/store-io.mjs";
import { UPDATE_SIGNING_PUBLIC_KEY, isValidReleaseVersion, parseCurrentPointer, resolveInstallRoot, verifyReleaseManifest } from "./update-trust.mjs";
import { extractReleaseArchive } from "./update-archive.mjs";

export { verifyReleaseManifest, parseCurrentPointer, resolveInstallRoot } from "./update-trust.mjs";
export { extractReleaseArchive } from "./update-archive.mjs";

export const SELF_UPDATE_CLIENT_ID = "anyswitch";
export const APP_REPO_URL = "https://github.com/Aurora0134/Anyswitch.git";
export const MAX_RELEASE_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const API_URL = "https://api.github.com/repos/Aurora0134/Anyswitch/releases/tags/";
const API_HEADERS = { accept: "application/vnd.github+json", "user-agent": "anyswitch-self-update" };
const DOWN_MS = 20_000, UP_MS = 30_000, ROLLBACK_PROBE_MS = 10_000, POLL_MS = 500;

const assetNames = (version) => {
  const zip = "anyswitch-v" + version + "-win-x64.zip";
  return { zip, manifest: zip.replace(/\.zip$/, ".manifest.json"), signature: zip.replace(/\.zip$/, ".manifest.sig") };
};
const releaseTag = (run) => run.targetTag ?? "v" + run.targetVersion;

function releaseAsset(release, name) {
  const asset = release.assets?.find((row) => row?.name === name);
  if (!asset || typeof asset.browser_download_url !== "string" || !Number.isSafeInteger(asset.size) || asset.size <= 0 || (asset.digest !== undefined && asset.digest !== null && typeof asset.digest !== "string")) throw new Error("release asset metadata unavailable");
  const url = new URL(asset.browser_download_url);
  if (url.protocol !== "https:" || !["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(url.hostname) || url.username || url.password) throw new Error("unsafe release asset URL");
  return asset;
}

async function fetchRelease({ run, channel, fetchFn, signal }) {
  const tag = releaseTag(run);
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag) || tag !== "v" + run.targetVersion) throw new Error("invalid release tag");
  const response = await fetchFn(API_URL + encodeURIComponent(tag), { headers: API_HEADERS, signal, redirect: "error" });
  if (!response.ok) throw new Error("release unavailable");
  const release = await response.json();
  if (release.tag_name !== tag || release.draft === true || release.prerelease !== (channel === "preview")) throw new Error("release channel mismatch");
  const names = assetNames(run.targetVersion);
  const zip = releaseAsset(release, names.zip);
  const manifest = releaseAsset(release, names.manifest);
  const signature = releaseAsset(release, names.signature);
  const manifestBytes = await fetchSmallAsset(fetchFn, manifest, 16 * 1024, signal);
  const signatureBytes = await fetchSmallAsset(fetchFn, signature, 256, signal);
  return { release, assets: { zip, manifest, signature }, manifestBytes, signature: signatureBytes.toString("utf8") };
}

async function fetchSmallAsset(fetchFn, asset, limit, signal) {
  if (asset.size > limit) throw new Error("release metadata asset too large");
  const response = await fetchFn(asset.browser_download_url, { headers: { "user-agent": API_HEADERS["user-agent"] }, signal });
  if (!response.ok) throw new Error("release asset download failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.size) throw new Error("release asset size mismatch");
  return bytes;
}

async function fetchArchive(fetchFn, asset, signal) {
  if (asset.size > MAX_RELEASE_ARCHIVE_BYTES) throw new Error("release archive too large");
  if (asset.digest != null && !/^sha256:[0-9a-f]{64}$/.test(asset.digest)) throw new Error("GitHub asset digest invalid");
  const response = await fetchFn(asset.browser_download_url, { headers: { "user-agent": API_HEADERS["user-agent"] }, signal });
  if (!response.ok) throw new Error("release archive download failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.size) throw new Error("release archive size mismatch");
  const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  if (asset.digest != null && digest !== asset.digest) throw new Error("GitHub asset digest mismatch");
  return bytes;
}

function currentPath(root) { return join(root, "current.json"); }
function writePointer(path, version) { atomicWriteFile(path, JSON.stringify({ schema: 1, version }) + "\n"); }

export function probePanelAppInfo(port = 47820, fetchFn = fetch, timers = {}) {
  const controller = new AbortController();
  const setTimer = timers.setTimeoutFn ?? setTimeout;
  const clearTimer = timers.clearTimeoutFn ?? clearTimeout;
  const timer = setTimer(() => controller.abort(), 1500);
  return fetchFn("http://127.0.0.1:" + port + "/panel/api/app-info", { signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) return null;
      const data = await response.json();
      return { version: typeof data?.version === "string" ? data.version : null, commit: typeof data?.commit === "string" ? data.commit : null };
    })
    .catch(() => null)
    .finally(() => clearTimer(timer));
}

export function defaultSpawnPanelHost({ installRoot, appRoot, appDir, nodePath, env = process.env, spawnFn = spawnDefault }) {
  const root = installRoot ?? resolveInstallRoot({ appRoot: appRoot ?? appDir, env });
  if (!root) throw new Error("packaged install root unavailable");
  // 直拉目标版本的 node 跑面板宿主真身（同 panel-launcher/panel-host-restart-helper
  // 形态）：旧的 cmd /s /c "start \"\" ..." 单串形态在 Windows 上引号被转义后必挂死。
  const hostAppRoot = appRoot ?? appDir ?? env.ANYSWITCH_APP_ROOT ?? env.ANYSWITCH_APP_DIR;
  if (!hostAppRoot) throw new Error("packaged app root unavailable");
  const nodeBin = nodePath ?? env.ANYSWITCH_NODE_PATH ?? null;
  const child = spawnFn(nodeBin ?? process.execPath, [join(hostAppRoot, "src", "panel", "panel-host.mjs")], {
    detached: true, windowsHide: true, stdio: "ignore", shell: false,
    env: { ...env, ANYSWITCH_INSTALL_ROOT: root, ...(hostAppRoot ? { ANYSWITCH_APP_ROOT: hostAppRoot } : {}), ...(nodeBin ? { ANYSWITCH_NODE_PATH: nodeBin, PATH: [dirname(nodeBin), env.PATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":") } : {}) },
  });
  child.unref?.();
  return child.pid;
}

export function spawnSelfUpdateWorker({ runId, journalDir, spawnFn = spawnDefault, execPath = process.execPath, workerPath = fileURLToPath(new URL("./self-update-worker.mjs", import.meta.url)), env = process.env } = {}) {
  const appRoot = env.ANYSWITCH_APP_ROOT ?? env.ANYSWITCH_APP_DIR ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const child = spawnFn(execPath, [workerPath, runId, journalDir], {
    detached: true, windowsHide: true, stdio: "ignore", shell: false,
    env: { ...env, ANYSWITCH_INSTALL_ROOT: env.ANYSWITCH_INSTALL_ROOT ?? "", ANYSWITCH_APP_ROOT: appRoot },
  });
  child.unref?.();
  return child.pid;
}

export async function runSelfUpdate({
  runId, journalDir,
  io = { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync },
  fetchFn = fetch,
  env = process.env,
  restartRelayFn = (root, targetEnv = env) => restartRelay(root, targetEnv),
  stopWatchdogFn = (e) => stopWatchdog(e),
  probeWatchdogFn = () => probeWatchdog(),
  spawnWatchdogFn = (e) => spawnWatchdog(e),
  spawnPanelHostFn = defaultSpawnPanelHost,
  probePanelFn = (port) => probePanelAppInfo(port, fetchFn),
  publicKey = UPDATE_SIGNING_PUBLIC_KEY,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date().toISOString(), nowMs = Date.now,
  panelDownTimeoutMs = DOWN_MS, panelUpTimeoutMs = UP_MS, rollbackProbeMs = ROLLBACK_PROBE_MS, pollMs = POLL_MS, panelPort = 47820,
} = {}) {
  const run = readClientUpdateRun(journalDir, runId);
  if (!run || run.state !== "running" || run.clientId !== SELF_UPDATE_CLIENT_ID) return null;
  writeClientUpdateRun(journalDir, { ...run, workerPid: process.pid });
  const channel = run.channel === "preview" ? "preview" : "stable";
  const runningAppRoot = run.appRoot ?? run.appDir ?? env.ANYSWITCH_APP_ROOT ?? env.ANYSWITCH_APP_DIR;
  const installRoot = resolveInstallRoot({ appRoot: runningAppRoot, env: { ...env, ANYSWITCH_INSTALL_ROOT: run.installRoot ?? env.ANYSWITCH_INSTALL_ROOT } });
  const targetVersion = run.targetVersion;
  const beforeVersion = run.beforeVersion ?? null;
  const finish = (result) => {
    const current = readClientUpdateRun(journalDir, runId) ?? run;
    writeClientUpdateRun(journalDir, { ...current, state: "done", finishedAt: now(), result, workerPid: process.pid });
    return result;
  };
  const setPhase = (phase) => {
    const current = readClientUpdateRun(journalDir, runId);
    if (current) writeClientUpdateRun(journalDir, { ...current, phase, workerPid: process.pid });
  };
  if (!installRoot || typeof targetVersion !== "string" || !isValidReleaseVersion(targetVersion)) return finish({ outcome: "failed", message: "更新信息不完整，请重新检查更新后重试", beforeVersion, latestVersion: targetVersion ?? null });
  const names = assetNames(targetVersion), stageDir = join(installRoot, "staging", runId);
  const archivePath = join(stageDir, names.zip), manifestPath = join(stageDir, names.manifest), signaturePath = join(stageDir, names.signature);
  let watchdogStopped = false;
  // staging/<runId>-XXXXXX 解压临时目录：成功后 rename 走，任何异常收场都纳入清理半径。
  let extractRoot = null;
  // 收尾清理一律 best-effort：删不动（EPERM/EBUSY 占用）不翻 outcome，残留路径记进 result。
  const bestEffortRm = (paths) => {
    const residue = [];
    for (const path of paths) {
      try { io.rmSync(path, { recursive: true, force: true }); } catch { residue.push(path); }
    }
    return residue;
  };
  try {
    if (run.step !== "apply") {
      setPhase("staging");
      const release = await fetchRelease({ run, channel, fetchFn });
      const manifest = verifyReleaseManifest(release.manifestBytes, release.signature, {
        publicKey, assetName: release.assets.zip.name, channel, prerelease: release.release.prerelease,
        assetDigest: release.assets.zip.digest, assetSize: release.assets.zip.size,
      });
      if (manifest.version !== targetVersion) throw new Error("release version mismatch");
      const archive = await fetchArchive(fetchFn, release.assets.zip);
      // 同 runId 重派（面板重试）先清旧 staging：wx 落盘撞残留即 EEXIST。
      io.rmSync(stageDir, { recursive: true, force: true });
      io.mkdirSync(stageDir, { recursive: true });
      io.writeFileSync(archivePath, archive, { flag: "wx" });
      io.writeFileSync(manifestPath, release.manifestBytes, { flag: "wx" });
      io.writeFileSync(signaturePath, release.signature, { flag: "wx" });
      const current = readClientUpdateRun(journalDir, runId) ?? run;
      writeClientUpdateRun(journalDir, { ...current, manifestDigest: release.assets.zip.digest, channel });
      if (!run.autoApply) return finish({ outcome: "downloaded", message: "已下载 " + targetVersion + "，应用后生效", beforeVersion, latestVersion: targetVersion });
      writeClientUpdateRun(journalDir, { ...current, step: "apply", targetVersion, manifestDigest: release.assets.zip.digest, channel });
    }

    setPhase("installing");
    const release = await fetchRelease({ run, channel, fetchFn });
    const stagedManifestBytes = io.readFileSync(manifestPath);
    const stagedSignature = io.readFileSync(signaturePath, "utf8");
    if (!stagedManifestBytes.equals(release.manifestBytes) || stagedSignature !== release.signature) throw new Error("staged release metadata changed");
    const manifest = verifyReleaseManifest(stagedManifestBytes, stagedSignature, {
      publicKey, assetName: release.assets.zip.name, channel, prerelease: release.release.prerelease,
      assetDigest: release.assets.zip.digest, assetSize: release.assets.zip.size,
    });
    if (manifest.version !== targetVersion) throw new Error("release version mismatch");
    const archive = io.readFileSync(archivePath);
    const digest = "sha256:" + createHash("sha256").update(archive).digest("hex");
    if ((release.assets.zip.digest != null && digest !== release.assets.zip.digest) || archive.length !== manifest.size || digest !== "sha256:" + manifest.sha256) throw new Error("staged release digest mismatch");
    const targetDir = join(installRoot, "versions", targetVersion);
    if (io.existsSync(targetDir)) {
      // 指针感知断点续传：上一尝试已把目标目录落成（app+runtime 齐全）且 current.json
      // 已指向目标版，随后被瞬时异常打断收场——同版本重试跳过安装直接进健康验证；
      // 目录不完整或指针未指向目标仍按冲突硬抛。
      let pointerVersion = null;
      try { pointerVersion = parseCurrentPointer(io.readFileSync(currentPath(installRoot), "utf8"))?.version ?? null; } catch { pointerVersion = null; }
      if (pointerVersion !== targetVersion || !io.existsSync(join(targetDir, "app")) || !io.existsSync(join(targetDir, "runtime"))) throw new Error("version already exists");
    } else {
      const stageRoot = join(installRoot, "staging");
      io.mkdirSync(stageRoot, { recursive: true });
      extractRoot = io.mkdtempSync(join(stageRoot, runId + "-"));
      const payload = extractReleaseArchive(archive, extractRoot);
      if (payload.version !== targetVersion) throw new Error("package version mismatch");
      io.mkdirSync(dirname(targetDir), { recursive: true });
      io.renameSync(extractRoot, targetDir);
    }

    const pointerFile = currentPath(installRoot);
    let previous = null;
    try {
      previous = parseCurrentPointer(io.readFileSync(pointerFile, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    // 断点续传（resume）时指针已指目标版：旧版身份改取 run.beforeVersion，
    // 否则回滚分支被跳过，resume 再失败会落首装失败分支误删指针与目标目录。
    if (previous?.version === targetVersion && typeof run.beforeVersion === "string" && run.beforeVersion !== targetVersion) previous = { schema: 1, version: run.beforeVersion };
    setPhase("ready-to-restart");
    writePointer(pointerFile, targetVersion);
    const dataRoot = run.relayRoot ?? join(env.LOCALAPPDATA ?? "", "Anyswitch");
    const targetAppRoot = join(installRoot, "versions", targetVersion, "app");
    const targetNodePath = join(installRoot, "versions", targetVersion, "runtime", "node.exe");
    const targetEnv = { ...env, ANYSWITCH_INSTALL_ROOT: installRoot, ANYSWITCH_APP_ROOT: targetAppRoot, ANYSWITCH_NODE_PATH: targetNodePath, PATH: [dirname(targetNodePath), env.PATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":") };
    const watchdogWasUp = await probeWatchdogFn().catch(() => false);
    if (watchdogWasUp) watchdogStopped = (await stopWatchdogFn(env).catch(() => ({ ok: false })))?.ok === true;
    const relay = await restartRelayFn(dataRoot, targetEnv).catch(() => ({ ok: false }));
    setPhase("waiting-panel");
    const deadline = nowMs() + panelDownTimeoutMs;
    let panelDown = false;
    let targetPanelAlreadyUp = false;
    while (nowMs() < deadline) {
      const identity = await probePanelFn(panelPort);
      if (identity === null) { panelDown = true; break; }
      if (identity.version === targetVersion) { panelDown = true; targetPanelAlreadyUp = true; break; }
      await delay(pollMs);
    }
    const maxPanelSpawnAttempts = Math.max(1, Math.floor(panelUpTimeoutMs / pollMs));
    let panelSpawnAttempts = 0;
    const spawnTargetPanel = () => {
      if (panelSpawnAttempts >= maxPanelSpawnAttempts) return;
      panelSpawnAttempts += 1;
      try { spawnPanelHostFn({ installRoot, appRoot: targetAppRoot, appDir: targetAppRoot, nodePath: targetNodePath, env: targetEnv }); } catch { /* health probe reports failure */ }
    };
    if (panelDown && !targetPanelAlreadyUp) spawnTargetPanel();
    let targetPanelHealthy = targetPanelAlreadyUp;
    const upDeadline = nowMs() + panelUpTimeoutMs;
    while (!targetPanelHealthy && nowMs() < upDeadline) {
      const identity = await probePanelFn(panelPort);
      targetPanelHealthy = identity?.version === targetVersion;
      if (!targetPanelHealthy) {
        // 目标 panel-host 可能撞 EADDRINUSE 静默退场：上线窗内按探测节拍有界重拉。
        if (panelDown) spawnTargetPanel();
        await delay(pollMs);
      }
    }
    if (targetPanelHealthy && relay?.ok === true) {
      if (watchdogStopped) await spawnWatchdogFn(targetEnv).catch(() => {});
      const residue = bestEffortRm(extractRoot ? [stageDir, extractRoot] : [stageDir]);
      return finish({ outcome: "updated", message: "已更新到 " + targetVersion, beforeVersion, afterVersion: targetVersion, latestVersion: targetVersion, relayRestartFailed: false, ...(residue.length ? { residue } : {}) });
    }
    if (previous && previous.version !== targetVersion) {
      writePointer(pointerFile, previous.version);
      const previousAppRoot = join(installRoot, "versions", previous.version, "app");
      const previousNodePath = join(installRoot, "versions", previous.version, "runtime", "node.exe");
      const previousEnv = { ...env, ANYSWITCH_INSTALL_ROOT: installRoot, ANYSWITCH_APP_ROOT: previousAppRoot, ANYSWITCH_NODE_PATH: previousNodePath, PATH: [dirname(previousNodePath), env.PATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":") };
      const rollbackRelay = await restartRelayFn(dataRoot, previousEnv).catch(() => ({ ok: false }));
      let panelRelaunchFailed = false;
      try { spawnPanelHostFn({ installRoot, appRoot: previousAppRoot, appDir: previousAppRoot, nodePath: previousNodePath, env: previousEnv }); } catch { panelRelaunchFailed = true; }
      if (watchdogStopped) await spawnWatchdogFn(previousEnv).catch(() => {});
      // 回滚后短窗探测旧面板身份：relay 没拉起或旧面板在窗内不应答都算服务未自动
      // 恢复——如实报 failed，不冒称 rolled_back。
      let previousPanelHealthy = false;
      const rollbackDeadline = nowMs() + rollbackProbeMs;
      while (!previousPanelHealthy && nowMs() < rollbackDeadline) {
        const identity = await probePanelFn(panelPort);
        previousPanelHealthy = identity?.version === previous.version;
        if (!previousPanelHealthy) await delay(pollMs);
      }
      // 本轮换装失败：目标目录是本 run 或上一断点尝试落成的（指针已回退、必不指向
      // 它），留着会让同版本重试永远撞 "version already exists"——尽力清掉，清不动记 residue。
      const residue = bestEffortRm(extractRoot ? [join(installRoot, "versions", targetVersion), stageDir, extractRoot] : [join(installRoot, "versions", targetVersion), stageDir]);
      const relayRestartFailed = relay?.ok !== true || rollbackRelay?.ok !== true;
      const residueNote = residue.length ? "残留目录未清走：" + residue.join("、") + "，可手动删除。" : "";
      if (rollbackRelay?.ok !== true || !previousPanelHealthy) {
        return finish({ outcome: "failed", message: "已恢复到更新前版本，但服务未能自动恢复。请从开始菜单启动 Anyswitch。" + residueNote, beforeVersion, afterVersion: previous.version, latestVersion: targetVersion, relayRestartFailed, ...(panelRelaunchFailed ? { panelRelaunchFailed } : {}), ...(residue.length ? { residue } : {}) });
      }
      return finish({ outcome: "rolled_back", message: "新面板未能启动，已恢复到更新前版本" + (residueNote ? "。" + residueNote : ""), beforeVersion, afterVersion: previous.version, latestVersion: targetVersion, relayRestartFailed, ...(panelRelaunchFailed ? { panelRelaunchFailed } : {}), ...(residue.length ? { residue } : {}) });
    }
    if (watchdogStopped) await spawnWatchdogFn(env).catch(() => {});
    // 首装失败同理：指针、目标目录与 staging 都是本 run 的残留，尽力清掉再收场，
    // 清不动记 residue，不翻 outcome。
    const residue = bestEffortRm(extractRoot ? [pointerFile, join(installRoot, "versions", targetVersion), stageDir, extractRoot] : [pointerFile, join(installRoot, "versions", targetVersion), stageDir]);
    return finish({ outcome: "failed", message: "新面板未能启动，且没有可恢复的旧版本" + (residue.length ? "。残留目录未清走：" + residue.join("、") + "，可手动删除。" : ""), beforeVersion, afterVersion: null, latestVersion: targetVersion, relayRestartFailed: relay?.ok !== true, ...(residue.length ? { residue } : {}) });
  } catch (error) {
    // 停了的看门狗不能因异常收场而无人拉起（对齐 62e69f9 旧版的 restoreWatchdog）：
    // apply 阶段同步 I/O 异常时面板已换装或已回滚，等面板重启才拉起会留自愈空窗。
    if (watchdogStopped) await spawnWatchdogFn(env).catch(() => {});
    // staging 与解压临时目录是本 run 的暂存，异常收场尽力清掉；versions/<target>
    // 绝不动——catch 也可能发生在指针已切新版的邻域。
    const residue = bestEffortRm(extractRoot ? [stageDir, extractRoot] : [stageDir]);
    const keyUnavailable = error?.message === "release signing key unavailable";
    return finish({ outcome: "failed", message: keyUnavailable ? "更新验证失败，请稍后重试" : "更新失败，请重新检查更新后重试", detail: error?.message ?? undefined, beforeVersion, latestVersion: targetVersion, ...(residue.length ? { residue } : {}) });
  }
}
