import { execFile } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { compareVersions } from "./version-check.mjs";

// npm 全局安装的客户端：本地检测（environment-service）读的就是这些包在 npm
// 全局目录里的落点，所以“更新/安装”也走 npm，两个方向口径一致。zcode 是纯桌面
// 应用，没有对应的 npm 包，在这里缺席即代表“面板不代管它的更新”；qoder 的 CLI
// 执行体是原生二进制，更新走下面 NATIVE_CLIENTS 的自升级通道。
export const CLIENT_PACKAGES = Object.freeze({
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  opencode: "opencode-ai",
  pi: "@earendil-works/pi-coding-agent",
  kimi: "@moonshot-ai/kimi-code",
  dsh: "@deepseek-ai/dsh",
});

// 执行体不是 npm 全局包、但官方分发在 npm 上的客户端（Grok Build）：先跑它自身的
// 升级命令，失败才降级到 npm 安装。npm 那一跳必须钉住服务端查到的官方版本、并把
// registry 显式指回官方源——用户 npm 配置的 registry 可能停在同步落后的镜像上
// （本机镜像的 @xai-official/grok latest 落后了整条大版本），`@latest` 在那种机器上
// 会把执行体降级。allowScripts 同理不能省：把新二进制安置进 ~/.grok/bin 的正是该包的
// postinstall，而 npm 的脚本白名单默认不放行它，被拦下就成「命令成功、版本没动」。
// qoder 同型（Bun 单文件 qodercli.exe）但只跑自身的 `qodercli update`：spec 里没有
// package 即没有 npm 兜底——npm 上的 @qoder-ai/qodercli 只是官方版本探测渠道，拿它
// 兜底安装已被明确否决（会把原生单文件执行体换成另一种安装形态），升级失败就如实报
// 失败，不留第二跳。
export const NATIVE_CLIENTS = Object.freeze({
  grok: Object.freeze({
    package: "@xai-official/grok",
    registry: "https://registry.npmjs.org",
    updateArgs: Object.freeze(["update"]),
  }),
  qoder: Object.freeze({
    updateArgs: Object.freeze(["update"]),
  }),
});

// 桌面形态走系统包管理器升级的客户端：codex 桌面端是 Microsoft Store 托管的 MSIX，
// 官方商店条目固定为 9PLM9XGG6VKS（商店 API 不支持静默装，winget 是唯一不交互的
// 入口）。winget 报「找不到可用的升级」时退出码 43＝已是最新；其余失败降级为打开
// 商店条目页——商店会话本身不该由后台 worker 代演。
export const WINGET_CLIENTS = Object.freeze({
  codex: Object.freeze({
    packageId: "9PLM9XGG6VKS",
    storeUrl: "ms-windows-store://pdp/?productid=9PLM9XGG6VKS",
  }),
});

// 桌面形态走官渠 MSIX 升级的客户端：claude 桌面端不在任何包管理器里，官方更新
// 通道是「元数据端点拿版本与 MSIX 直链 → Invoke-WebRequest 下载 → 验签 →
// Add-AppxPackage」。元数据与下载一律走 Invoke-WebRequest：本机官渠必须经系统
// 代理，而 Node fetch 不读系统代理。装包只认 Anthropic 签名（publisherPattern）；
// 桌面壳在跑时不装（正在运行的包文件被占用，装了也换不上）。
export const OFFICIAL_MSIX_CLIENTS = Object.freeze({
  claude: Object.freeze({
    packageName: "Claude",
    displayName: "Claude",
    metadataUrl: "https://api.anthropic.com/api/desktop/win32/x64/msix/update",
    publisherPattern: "Anthropic, PBC",
  }),
});

// 一次「更新」要动的形态腿：npm / 原生客户端天然只有 CLI 一条腿；codex 与 claude
// 各多一条桌面腿（codex 走 winget 商店源、claude 走官渠 MSIX，都串行执行），成败
// 按腿分别记录。
export function clientLifecycleLegs(id) {
  const kind = clientLifecycleKind(id);
  if (!kind) return Object.freeze([]);
  const legs = [{ form: "cli", kind }];
  if (Object.hasOwn(WINGET_CLIENTS, id)) legs.push({ form: "desktop", kind: "winget" });
  if (Object.hasOwn(OFFICIAL_MSIX_CLIENTS, id)) legs.push({ form: "desktop", kind: "official-msix" });
  return Object.freeze(legs);
}

export const CLIENT_ACTIONS = Object.freeze(["install", "update"]);
const NATIVE_ACTIONS = Object.freeze(["update"]);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// 面板能代管生命周期的客户端与执行形态；null 表示只能给官方入口、面板不执行任何写入。
// 用自身属性判定：普通对象会从原型链上捡到 constructor/toString 这类名字。
export function clientLifecycleKind(id) {
  if (typeof id !== "string") return null;
  if (Object.hasOwn(CLIENT_PACKAGES, id)) return "npm";
  return Object.hasOwn(NATIVE_CLIENTS, id) ? "native" : null;
}

// 该客户端可接受的动作。原生自更新的客户端只有「更新」：未安装时面板不代装，
// 从裸装起把用户切进哪种安装形态不该由一个按钮代劳。
export function clientLifecycleActions(id) {
  const kind = clientLifecycleKind(id);
  return kind === "npm" ? CLIENT_ACTIONS : kind === "native" ? NATIVE_ACTIONS : [];
}

function packageFor(id) {
  return typeof id === "string" && Object.hasOwn(CLIENT_PACKAGES, id) ? CLIENT_PACKAGES[id] : null;
}

// npm 与 node 装在同一份里。直接让当前这个 node 跑它旁边的 npm-cli.js，
// 既不必依赖 panel-host 启动环境里的 PATH（快捷方式拉起的进程 PATH 可能很窄），
// 也不经过 shell——包名来自上面的固定表，客户端 id 只做查表，没有拼接面。
export function resolveNpmCli({ execPath = process.execPath, io = { existsSync } } = {}) {
  const candidate = join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return io.existsSync(candidate) ? candidate : null;
}

function tailLines(text, limit, maxChars) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(Math.max(0, lines.length - limit)).join("\n");
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail;
}

// 全局安装最新（或钉住的）版本；action 只影响结果措辞，命令同一跳。
// 超时给得很宽、只当泄漏兜底：中途杀 npm 会在全局目录里留下半截安装，比等它跑完更糟。
function runNpmInstall({
  pkg,
  version = "latest",
  registry = null,
  allowScripts = null,
  spawn,
  execPath,
  io,
  timeoutMs,
  maxOutputChars,
}) {
  const npmCli = resolveNpmCli({ execPath, io });
  if (!npmCli) return Promise.resolve({ ok: false, npmMissing: true, output: "" });
  const args = [npmCli, "install", "--global", "--no-audit", "--no-fund"];
  if (registry) args.push(`--registry=${registry}`);
  if (allowScripts) args.push(`--allow-scripts=${allowScripts}`);
  args.push(`${pkg}@${version}`);
  return new Promise((done) => {
    spawn(
      execPath,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const raw = String(stderr ?? "").trim() || String(stdout ?? "").trim();
        done({ ok: !error, timedOut: Boolean(error?.killed), output: tailLines(raw, 8, maxOutputChars) });
      },
    );
  });
}

// 执行体路径来自本地检测（GROK_EXECUTABLE 覆盖时已要求绝对路径 .exe），面板请求里
// 换不掉它；两跳都不经 shell，参数逐项传递。spec 里没有 package 的客户端（qoder）
// 没有降级安装这一跳：官方最新版本拿不准时不做兜底安装——宁可报失败，也不能拿一个
// 可能落后的 dist-tag 覆盖正在跑的执行体。
function runNativeSelfUpdate({
  id,
  commandPath,
  targetVersion,
  spawn,
  execPath,
  io,
  timeoutMs,
  maxOutputChars,
}) {
  const spec = NATIVE_CLIENTS[id];
  if (typeof commandPath !== "string" || !isAbsolute(commandPath)) {
    return Promise.resolve({ ok: false, unsupported: true, output: "" });
  }
  return new Promise((done) => {
    spawn(
      commandPath,
      [...spec.updateArgs],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const raw = String(stderr ?? "").trim() || String(stdout ?? "").trim();
        const selfUpdateOutput = tailLines(raw, 8, maxOutputChars);
        if (!error) done({ ok: true, timedOut: false, output: selfUpdateOutput });
        else if (!spec.package || !SEMVER.test(String(targetVersion ?? ""))) {
          done({ ok: false, timedOut: Boolean(error.killed), output: selfUpdateOutput });
        } else {
          runNpmInstall({
            pkg: spec.package,
            version: targetVersion,
            registry: spec.registry,
            allowScripts: spec.package,
            spawn,
            execPath,
            io,
            timeoutMs,
            maxOutputChars,
          }).then((fallback) => done(fallback.ok
            ? fallback
            : { ...fallback, output: [selfUpdateOutput, fallback.output].filter(Boolean).join("\n") }));
        }
      },
    );
  });
}

// winget 报「找不到可用的升级」时退出码 43；文案随系统语言走，中英两份都对。
const WINGET_NO_UPGRADE = /找不到可用的升级|no applicable upgrade|no available upgrade found/i;

// 桌面腿：winget 走商店源静默升级商店托管的 MSIX。ENOENT＝winget 不存在或不在
// PATH，这条腿如实记失败；exit 43／无可用升级文案＝已是最新（ok 且未动版本）；
// 其余非零才是失败。超时任由上层给宽限，商店包下载起来比 npm 慢得多。
function runWingetUpdate({ spec, spawn, timeoutMs, maxOutputChars }) {
  const args = ["install", "--id", spec.packageId, "--source", "msstore"];
  return new Promise((done) => {
    spawn(
      "winget",
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const raw = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
        const output = tailLines(raw, 8, maxOutputChars);
        if (error && error.code === "ENOENT") return done({ ok: false, wingetMissing: true, output });
        if (!error || error.code === 43 || WINGET_NO_UPGRADE.test(raw)) {
          return done({ ok: true, noUpgrade: Boolean(error), timedOut: false, output });
        }
        done({ ok: false, timedOut: Boolean(error.killed), output });
      },
    );
  });
}

// 商店页降级：winget 拉不动时把官方商店条目页打开给用户自己点。explorer 拉起即走，
// 与其退出码无关；spawn 都失败才算没打开。注入替身可能不返回子进程，unref 逐层可选。
function openStorePage({ spec, spawn }) {
  try {
    const child = spawn("explorer.exe", [spec.storeUrl], { detached: true, windowsHide: true, stdio: "ignore" }, () => {});
    child?.unref?.();
    return true;
  } catch {
    return false;
  }
}

// 官渠 MSIX 腿的 PowerShell 脚本。动态值（远端给的下载地址、本机路径、device_id）
// 一律经环境变量传入，脚本体里没有任何字符串拼接面；全部走注入的 spawn，
// execFile 口径（-NoProfile -Command，不经 shell），JS 侧只解析 stdout。
const PS_MSIX_INSTALLED = String.raw`$p = Get-AppxPackage -Name $env:ANYS_MSIX_PACKAGE -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { [string]$p.Version }`;

// 元数据响应的版本字段经官方客户端代码取证为 currentRelease（version 兜底）；
// 直链字段名没有留存样本，按形态认：第一个以 .msix 结尾的 https 字符串即安装包地址。
const PS_MSIX_METADATA = String.raw`$ProgressPreference = 'SilentlyContinue'
try {
  $uri = $env:ANYS_MSIX_METADATA_URL
  if ($env:ANYS_MSIX_DEVICE_ID) { $uri = $uri + '?device_id=' + [uri]::EscapeDataString($env:ANYS_MSIX_DEVICE_ID) }
  $j = (Invoke-WebRequest -Uri $uri -UseBasicParsing).Content | ConvertFrom-Json
  $version = $null
  if ($j.currentRelease) { $version = [string]$j.currentRelease } elseif ($j.version) { $version = [string]$j.version }
  $link = $null
  foreach ($prop in $j.PSObject.Properties) {
    if ($prop.Value -is [string] -and $prop.Value -match '^https://\S+\.msix([?#].*)?$') { $link = $prop.Value; break }
  }
  if (-not $version -or -not $link) { exit 1 }
  @{ version = $version; url = $link } | ConvertTo-Json -Compress
} catch { exit 1 }`;

// 只挡桌面壳：MSIX 进程路径形如 C:\Program Files\WindowsApps\Claude_<版本>\…；
// CLI 引擎 claude.exe 同名但落在别处，不算。
const PS_MSIX_RUNNING = String.raw`$found = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -like ('*\WindowsApps\' + $env:ANYS_MSIX_PACKAGE + '_*') } catch { $false } }); if ($found.Count -gt 0) { 'running' }`;

const PS_MSIX_DOWNLOAD = String.raw`$ProgressPreference = 'SilentlyContinue'
try { Invoke-WebRequest -Uri $env:ANYS_MSIX_URL -OutFile $env:ANYS_MSIX_OUT -UseBasicParsing }
catch { Remove-Item $env:ANYS_MSIX_OUT -Force -ErrorAction SilentlyContinue; exit 1 }`;

const PS_MSIX_SIGNATURE = String.raw`$s = Get-AuthenticodeSignature -FilePath $env:ANYS_MSIX_OUT; @{ status = [string]$s.Status; signer = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress`;

const PS_MSIX_INSTALL = String.raw`Add-AppxPackage -Path $env:ANYS_MSIX_OUT -ErrorAction Stop`;

// MSIX 包近 300MB，慢代理下其余 PS 调用的腿超时不够用，下载这步单独放宽。
const MSIX_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

function runPowerShell({ script, env = {}, spawn, timeoutMs, maxOutputChars }) {
  return new Promise((done) => {
    spawn(
      "powershell",
      ["-NoProfile", "-Command", script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        done({
          ok: !error,
          timedOut: Boolean(error?.killed),
          stdout: String(stdout ?? ""),
          output: tailLines(`${stdout ?? ""}\n${stderr ?? ""}`.trim(), 8, maxOutputChars),
        });
      },
    );
  });
}

function lastJsonLine(stdout) {
  const line = String(stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
  try { return JSON.parse(line); } catch { return null; }
}

// ant-did 里存的是 base64，解出来才是官渠元数据端点要的 device_id。3p 数据目录
// 优先、1p 目录兜底（用户从哪个形态用都有可能）；两份都读不到就不带参数试一次。
function readMsixDeviceId(io) {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  for (const dir of ["Claude-3p", "Claude"]) {
    try {
      const decoded = Buffer.from(String(io.readFileSync(join(localAppData, dir, "ant-did"), "utf8")).trim(), "base64").toString("utf8").trim();
      if (decoded) return decoded;
    } catch { /* 这份没有就试下一份 */ }
  }
  return null;
}

// MSIX 清单版本是四段（1.37937.1.0），比照 codex 先例把尾部 .0 剥成三段再比对。
function normalizeMsixVersion(value) {
  return String(value ?? "").trim().replace(/^(\d+\.\d+\.\d+)\.0$/, "$1");
}

// 官渠 MSIX 桌面腿：查已装版本 → 读 device_id → 拉元数据 → 比对 → 挡运行中的
// 桌面壳 → 下载 → 验签 → 安装。网络类失败（元数据、下载）归 networkError，验签
// 不过即中止，桌面壳在跑归 appRunning，其余是非零退出的普通失败。
async function runOfficialMsixUpdate(spec, { spawn, io, timeoutMs, maxOutputChars }) {
  const ps = (script, env = {}, timeout = timeoutMs) => runPowerShell({ script, env, spawn, timeoutMs: timeout, maxOutputChars });
  const psEnv = { ANYS_MSIX_PACKAGE: spec.packageName };
  // 查不到已装包＝桌面形态不在，这条腿不代装（首装形态不该由更新按钮代劳）。
  const installed = await ps(PS_MSIX_INSTALLED, psEnv);
  const installedVersion = normalizeMsixVersion(installed.stdout);
  if (!installed.ok || !/^\d+\.\d+\.\d+$/.test(installedVersion)) {
    return { ok: false, timedOut: installed.timedOut, output: installed.output };
  }
  const meta = await ps(PS_MSIX_METADATA, { ...psEnv, ANYS_MSIX_METADATA_URL: spec.metadataUrl, ANYS_MSIX_DEVICE_ID: readMsixDeviceId(io) ?? "" });
  const metadata = meta.ok ? lastJsonLine(meta.stdout) : null;
  if (typeof metadata?.version !== "string" || typeof metadata?.url !== "string") {
    return { ok: false, networkError: true, timedOut: meta.timedOut, output: meta.output };
  }
  const targetVersion = normalizeMsixVersion(metadata.version);
  const order = compareVersions(installedVersion, targetVersion);
  if (order !== null && order >= 0) return { ok: true, noUpgrade: true, timedOut: false, output: "" };
  const running = await ps(PS_MSIX_RUNNING, psEnv);
  if (running.ok && /^running$/m.test(running.stdout.trim())) return { ok: false, appRunning: true, timedOut: false, output: running.output };
  const packagePath = join(tmpdir(), `anys-claude-msix-${process.pid}.msix`);
  try {
    const download = await ps(PS_MSIX_DOWNLOAD, { ...psEnv, ANYS_MSIX_URL: metadata.url, ANYS_MSIX_OUT: packagePath }, MSIX_DOWNLOAD_TIMEOUT_MS);
    if (!download.ok) return { ok: false, networkError: true, timedOut: download.timedOut, output: download.output };
    const sig = await ps(PS_MSIX_SIGNATURE, { ...psEnv, ANYS_MSIX_OUT: packagePath });
    const signature = sig.ok ? lastJsonLine(sig.stdout) : null;
    if (signature?.status !== "Valid" || !String(signature?.signer ?? "").includes(spec.publisherPattern)) {
      return { ok: false, timedOut: sig.timedOut, output: sig.output };
    }
    const install = await ps(PS_MSIX_INSTALL, { ...psEnv, ANYS_MSIX_OUT: packagePath });
    if (!install.ok) return { ok: false, timedOut: install.timedOut, output: install.output };
    return { ok: true, timedOut: false, installedVersion: targetVersion, output: install.output };
  } finally {
    try { io.rmSync(packagePath, { force: true }); } catch { /* 临时文件清不掉不遮结果 */ }
  }
}

export function runClientLifecycle({
  id,
  action,
  commandPath = null,
  targetVersion = null,
  spawn = execFile,
  execPath = process.execPath,
  io = { existsSync, readFileSync, rmSync },
  timeoutMs = 20 * 60 * 1000,
  maxOutputChars = 2000,
} = {}) {
  const kind = clientLifecycleKind(id);
  if (!kind || !clientLifecycleActions(id).includes(action)) {
    return Promise.resolve({ ok: false, unsupported: true, output: "" });
  }
  const shared = { spawn, execPath, io, timeoutMs, maxOutputChars };
  const runLeg = (leg) => {
    if (leg.kind === "winget") {
      const spec = WINGET_CLIENTS[id];
      // winget 都没有时开商店页没有意义（用户得先装 winget），只报缺失。
      return runWingetUpdate({ spec, ...shared }).then((r) =>
        !r.ok && !r.noUpgrade && !r.wingetMissing ? { ...r, storePageOpened: openStorePage({ spec, spawn }) } : r);
    }
    if (leg.kind === "official-msix") return runOfficialMsixUpdate(OFFICIAL_MSIX_CLIENTS[id], shared);
    if (leg.kind === "native") return runNativeSelfUpdate({ id, commandPath, targetVersion, ...shared });
    return runNpmInstall({ pkg: packageFor(id), ...shared });
  };
  const legs = clientLifecycleLegs(id);
  // 单腿客户端返回形态与改动前逐字一致，多腿才带 legs[]。
  if (legs.length === 1) return runLeg(legs[0]);
  return legs.reduce((prev, leg) => prev.then(async (acc) => {
    const r = await runLeg(leg);
    acc.legs.push({ form: leg.form, ...r });
    acc.ok = acc.ok && r.ok !== false;
    acc.timedOut = acc.timedOut || Boolean(r.timedOut);
    return acc;
  }), Promise.resolve({ ok: true, legs: [], timedOut: false }))
    .then((acc) => ({
      ...acc,
      output: acc.legs.map((l) => l.output).filter(Boolean).join("\n"),
    }));
}
