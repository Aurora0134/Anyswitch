import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { compareVersions, parseVersion } from "./version-check.mjs";

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

// 走官渠发布文件升级的桌面客户端：DSH 桌面端（官方 Electron 包）。它的发布源就是
// 它自己更新通道读的那份 nightly.yml（见 release-service 的 "dsh-desktop" 条目），
// 包里带 electron-builder 的 sha512，安装包是 NSIS 安装器——同一份文件由这条腿自
// 己下载、自己验摘要、再按该项目的安装参数静默执行，全程不经过任何商店或第三方工具。
//
// 安装参数取自包内 electron-updater 的 NsisUpdater.doInstall：`--updated` 是「这是一次
// 更新」的标记（装完由安装器重启应用），`/S` 是静默。这里不追加 `--force-run`，并额外
// 传 `/D=<安装目录>`：electron-updater 装完会把应用拉起来，而面板正在服务这次更新，
// 抢在收尾前重启应用会让「更新完成」的判定跑在一个刚被替换的安装目录上。
//
// 摘要不合就中止、绝不落盘执行；应用在跑时不装（Windows 下正在使用的文件换不掉，
// 硬装只会留下半个安装）。
export const OFFICIAL_FEED_CLIENTS = Object.freeze({
  dsh: Object.freeze({
    displayName: "DeepSeek Harness",
    // 与 app-update.yml 的 provider/url/channel 是同一份事实。
    feedUrl: "https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml",
    processName: "DeepSeek Harness",
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

// 一次「更新」要动的形态腿：npm / 原生客户端天然只有 CLI 一条腿；claude 多一条
// 官渠 MSIX 桌面腿，codex 多一条商店腿，dsh 多一条官渠发布文件桌面腿。多腿串行
// 执行，成败按腿分别记录。
export function clientLifecycleLegs(id) {
  const kind = clientLifecycleKind(id);
  if (!kind) return Object.freeze([]);
  const legs = [{ form: "cli", kind }];
  if (Object.hasOwn(WINGET_CLIENTS, id)) legs.push({ form: "desktop", kind: "winget" });
  if (Object.hasOwn(OFFICIAL_MSIX_CLIENTS, id)) legs.push({ form: "desktop", kind: "official-msix" });
  if (Object.hasOwn(OFFICIAL_FEED_CLIENTS, id)) legs.push({ form: "desktop", kind: "official-feed" });
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

// 发布文件（electron-builder 的 channel 文件）读法。这里只认「版本 + 指向安装包
// 的 url + sha512 + size」四件事实，字段缺失即判为读不出——宁可报失败也不猜。
//
// 两个形态细节是这段解析存在的全部理由，写成普通 YAML 直觉就会读错：
//   * 折叠标量：`- url: >-` 后面缩进的那一行才是值，`>` 那个标记本身不是值；
//   * `sha512` 在文件里出现两次——`files[]` 里那次是这条安装包的摘要，文件顶层
//     那次是整条 channel 的摘要。把顶层那个当成安装包摘要，校验就会拿错误的值
//     去比（实测会让「摘要不符」这条防线静默失效）。
// 于是状态机按缩进认条目：`- url:` 开启一条文件条目，其后同级缩进的 `sha512`
// 属于该条目；文件顶层的 `path:`/`sha512:`（缩进更浅）不属于任何条目，忽略。
//
// 下载地址必须是 https，且与发布文件同源：那份文件的绝对地址由官方镜像给出，
// 我们不接受它把我们指向别处。
function parseOfficialFeed(text, feedUrl) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const scalar = (group) => group[0] ?? group[1] ?? group[2] ?? null;
  const indentOf = (line) => line.length - line.trimStart().length;
  let version = null;
  const files = [];
  let current = null;
  let itemIndent = null; // 当前文件条目的字段缩进；更浅的 sha512 是顶层字段
  let pending = null; // 上一行是裸的块指示符，值在下一行
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (pending !== null) {
      const apply = pending;
      pending = null;
      apply(line);
      continue;
    }
    const blockKey = /^(?:-\s*)?(version|url|sha512)\s*:\s*[|>][-+]?\s*$/.exec(line);
    if (blockKey !== null) {
      const key = blockKey[1];
      const startsItem = /^-\s*url\s*:/.test(line);
      const indent = indentOf(rawLine);
      pending = (value) => {
        if (key === "version") { version = value; return; }
        if (key === "url") {
          current = { url: value };
          itemIndent = indent;
          files.push(current);
          return;
        }
        // sha512：只收属于当前条目的那一次。
        if (current !== null && itemIndent !== null && indent >= itemIndent) current.sha512 = value;
      };
      continue;
    }
    const versionMatch = /^version\s*:\s*(?:"([^"\\]*)"|'([^']*)'|([^\s#'"]+))/.exec(line);
    if (versionMatch) { version = scalar(versionMatch.slice(1)); continue; }
    const urlMatch = /^-\s*url\s*:\s*(?:"([^"]+)"|'([^']+)'|([^\s#'"]+))/.exec(line);
    if (urlMatch) {
      current = { url: scalar(urlMatch.slice(1)) };
      itemIndent = indentOf(rawLine);
      files.push(current);
      continue;
    }
    if (current === null || itemIndent === null || indentOf(rawLine) < itemIndent) continue;
    const shaMatch = /^sha512\s*:\s*(?:"([^"]+)"|'([^']+)'|([^\s#'"]+))/.exec(line);
    if (shaMatch) { current.sha512 = scalar(shaMatch.slice(1)); continue; }
    const sizeMatch = /^size\s*:\s*(\d+)\s*$/.exec(line);
    if (sizeMatch) current.size = Number(sizeMatch[1]);
  }
  const parsed = parseVersion(version);
  if (!parsed) return null;
  const feedOrigin = new URL(feedUrl).origin;
  const resolved = files.map((file) => {
    if (typeof file.url !== "string") return null;
    try {
      const url = new URL(file.url, feedUrl);
      if (url.protocol !== "https:" || url.origin !== feedOrigin) return null;
      return { url: url.href, sha512: file.sha512 ?? null, size: Number.isSafeInteger(file.size) ? file.size : null };
    } catch { return null; }
  }).filter((file) => file !== null && typeof file.sha512 === "string" && file.sha512.length > 0);
  return resolved.length === 0 ? null : { version, file: resolved[0] };
}

function digestBase64(buffer, algorithm) {
  return createHash(algorithm).update(buffer).digest("base64");
}

// 下载到系统临时目录。整包进内存核摘要：落盘的就是已核过的那份字节，且不论
// 路径如何都先过一遍 sha512 才可能被当成安装器执行。安装包约 300MB，这条腿在
// 后台进程里跑，一次性占用可以接受。
async function downloadToTemp(file, { fetchFn, io, timeoutMs, maxOutputChars }) {
  const clamp = (value, max) => String(value ?? "").slice(0, max);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(file.url, { credentials: "omit", redirect: "error", signal: controller.signal });
    if (!response.ok) return { ok: false, networkError: true, timedOut: false, output: `下载失败（HTTP ${response.status}）` };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (controller.signal.aborted) return { ok: false, networkError: true, timedOut: true, output: "下载超时" };
    if (file.size !== null && bytes.length !== file.size) {
      return { ok: false, networkError: true, timedOut: false, output: "安装包大小与发布文件不符" };
    }
    const path = join(tmpdir(), `anys-update-${file.sha512.slice(0, 16)}.exe`);
    io.writeFileSync(path, bytes);
    return { ok: true, path, bytes };
  } catch (error) {
    return { ok: false, networkError: true, timedOut: controller.signal.aborted, output: clamp(error?.message, maxOutputChars) };
  } finally {
    clearTimeout(timer);
  }
}

// NSIS 静默更新。参数与说明见 OFFICIAL_FEED_CLIENTS 上方。安装器是被替换应用
// 自己产出的可执行文件，路径由我们拼、不与任何远端字符串相接。
function runInstaller({ installerPath, spec, spawn, timeoutMs, maxOutputChars }) {
  const args = ["--updated", "/S"];
  if (typeof spec.installDir === "string" && isAbsolute(spec.installDir)) args.push(`/D=${spec.installDir}`);
  return new Promise((done) => {
    spawn(
      installerPath,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const output = tailLines(`${stdout ?? ""}\n${stderr ?? ""}`.trim(), 8, maxOutputChars);
        done({ ok: !error, timedOut: Boolean(error?.killed), output });
      },
    );
  });
}

// tasklist 判活：桌面端是否在跑。读不出来时按「在跑」处理——装不了总比硬装坏好。
function desktopProcessRunning({ processName, spawn }) {
  return new Promise((done) => {
    spawn(
      "tasklist",
      ["/FI", `IMAGENAME eq ${processName}.exe`, "/NH", "/FO", "CSV"],
      { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) return done(true);
        const text = String(stdout ?? "");
        if (/no tasks are running|没有运行的任务/i.test(text)) return done(false);
        return done(new RegExp(`"${processName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.exe"`, "i").test(text));
      },
    );
  });
}

// 官渠发布文件腿：拉发布文件 → 比对本地版本 → 挡运行中的桌面端 → 下载 → 验摘要
// → 静默执行安装器。网络类失败（发布文件、下载）归 networkError；摘要不符即中止，
// 绝不执行下载物；桌面端在跑归 appRunning。目标版本只从发布文件读，不接受调用方
// 传入（那条路是 native 自升级腿的降级安装，形态不同）。
async function runOfficialFeedUpdate(spec, { spawn, io, fetchFn, timeoutMs, maxOutputChars, installedVersion = null }) {
  const clamp = (value, max) => String(value ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-8).join("\n").slice(0, max);
  let feedText;
  try {
    const response = await fetchFn(spec.feedUrl, { credentials: "omit", redirect: "error", headers: { Accept: "text/yaml, text/plain" } });
    if (!response.ok) throw new Error(`feed http ${response.status}`);
    feedText = await response.text();
  } catch (error) {
    return { ok: false, networkError: true, timedOut: false, output: clamp(error?.message, maxOutputChars) };
  }
  const feed = parseOfficialFeed(feedText, spec.feedUrl);
  if (feed === null) return { ok: false, timedOut: false, output: "发布文件无法解读" };
  const targetVersion = feed.version;
  // 已装版本由调用方给出（环境检测读的是应用自己的版本）；缺了就走不了比对，
  // 但也不能因此放弃这次更新——照常装，文档里如实报「已更新」。
  if (installedVersion !== null) {
    const order = compareVersions(installedVersion, targetVersion);
    if (order !== null && order >= 0) return { ok: true, noUpgrade: true, timedOut: false, output: "" };
  }
  if (await desktopProcessRunning({ processName: spec.processName, spawn })) {
    return { ok: false, appRunning: true, timedOut: false, output: "" };
  }
  const download = await downloadToTemp(feed.file, { fetchFn, io, timeoutMs, maxOutputChars });
  if (!download.ok) return download;
  const installerPath = download.path;
  try {
    // 摘要不贴合就绝不执行：这里是防「下载到的东西不是官方发布的那一份」的最后
    // 一道闸，比对用的值必须来自发布文件本身（parseOfficialFeed 已经保证它存在）。
    const digest = digestBase64(download.bytes, "sha512");
    if (typeof feed.file.sha512 !== "string" || digest !== feed.file.sha512) {
      // 摘要对不上：下载物一律不执行，也不留在盘上。
      return { ok: false, timedOut: false, output: "安装包校验不通过，已丢弃" };
    }
    const install = await runInstaller({ installerPath, spec, spawn, timeoutMs, maxOutputChars });
    if (!install.ok) return install;
    return { ok: true, timedOut: false, installedVersion: targetVersion, output: install.output };
  } finally {
    try { io.rmSync(installerPath, { force: true }); } catch { /* 临时文件清不掉不遮结果 */ }
  }
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
  installedVersionByForm = null,
  spawn = execFile,
  execPath = process.execPath,
  io = { existsSync, readFileSync, rmSync },
  fetchFn = fetch,
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
    if (leg.kind === "official-feed") return runOfficialFeedUpdate(OFFICIAL_FEED_CLIENTS[id], { fetchFn, installedVersion: installedVersionByForm?.[leg.form] ?? null, ...shared });
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
