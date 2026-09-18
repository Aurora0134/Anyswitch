import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
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

export const CLIENT_ACTIONS = Object.freeze(["install", "update"]);

// 面板能代管生命周期的客户端；null 表示只能给官方入口、面板不执行任何写入。
// 用自身属性判定：普通对象会从原型链上捡到 constructor/toString 这类名字。
export function clientLifecycleKind(id) {
  return typeof id === "string" && Object.hasOwn(CLIENT_PACKAGES, id) ? "npm" : null;
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

// 安装与更新是同一个 npm 命令（--global 装最新版），action 只影响结果措辞。
// 超时给得很宽、只当泄漏兜底：中途杀 npm 会在全局目录里留下半截安装，比等它跑完更糟。
export function runClientLifecycle({
  id,
  action,
  spawn = execFile,
  execPath = process.execPath,
  io = { existsSync },
  timeoutMs = 20 * 60 * 1000,
  maxOutputChars = 2000,
} = {}) {
  const pkg = packageFor(id);
  if (!pkg || !CLIENT_ACTIONS.includes(action)) return Promise.resolve({ ok: false, unsupported: true, output: "" });
  const npmCli = resolveNpmCli({ execPath, io });
  if (!npmCli) return Promise.resolve({ ok: false, npmMissing: true, output: "" });
  return new Promise((done) => {
    spawn(
      execPath,
      [npmCli, "install", "--global", "--no-audit", "--no-fund", `${pkg}@latest`],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const raw = String(stderr ?? "").trim() || String(stdout ?? "").trim();
        done({ ok: !error, timedOut: Boolean(error?.killed), output: tailLines(raw, 8, maxOutputChars) });
      },
    );
  });
}
