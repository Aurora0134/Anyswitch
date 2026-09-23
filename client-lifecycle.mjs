import { execFile } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";

// npm 全局安装的客户端：本地检测（environment-service）读的就是这些包在 npm
// 全局目录里的落点，所以“更新/安装”也走 npm，两个方向口径一致。zcode / qoder
// 是桌面应用，没有对应的 npm 包，在这里缺席即代表“面板不代管它的更新”。
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
export const NATIVE_CLIENTS = Object.freeze({
  grok: Object.freeze({
    package: "@xai-official/grok",
    registry: "https://registry.npmjs.org",
    updateArgs: Object.freeze(["update"]),
  }),
});

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
// 换不掉它；两跳都不经 shell，参数逐项传递。官方最新版本拿不准时不做兜底安装——
// 宁可报失败，也不能拿一个可能落后的 dist-tag 覆盖正在跑的执行体。
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
        else if (!SEMVER.test(String(targetVersion ?? ""))) {
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

export function runClientLifecycle({
  id,
  action,
  commandPath = null,
  targetVersion = null,
  spawn = execFile,
  execPath = process.execPath,
  io = { existsSync },
  timeoutMs = 20 * 60 * 1000,
  maxOutputChars = 2000,
} = {}) {
  const kind = clientLifecycleKind(id);
  if (!kind || !clientLifecycleActions(id).includes(action)) {
    return Promise.resolve({ ok: false, unsupported: true, output: "" });
  }
  const shared = { spawn, execPath, io, timeoutMs, maxOutputChars };
  if (kind === "native") return runNativeSelfUpdate({ id, commandPath, targetVersion, ...shared });
  return runNpmInstall({ pkg: packageFor(id), ...shared });
}
