// One-click CLI Agent launch for the virtual terminal: turn "which agent + which
// working directory" into a launch spec terminal-host can spawn directly, plus
// the environment that carries Anyswitch credentials.
//
// Credentials ride environment variables ONLY: no agent config file is written,
// no secret is concatenated into the command line, and the env never reaches
// disk (terminal-host keeps it in memory for the session's lifetime). The one
// exception is zcode: its terminal entry spawns zcode-cli-launcher.mjs and the
// credential path lives entirely inside that launcher (the relay token lands as
// the apiKey of the CLI slot's provider_config.json), so the terminal injects
// no env for it at all.
//
// The env contract is imported from each launcher's exported build*Env, so the
// panel and the launchers can never drift apart. One piece is still copied
// locally with its source cited (the launchers do not export it):
//   - the buildInstanceId scheme (each launcher), and only for the two clients
//     that cannot do without it (see TERMINAL_INSTANCE_ID_FROM_SOCKET): the
//     session's shell pid does not exist yet at assembly time, so the launcher
//     pid in that scheme becomes a per-session random tag.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  buildLauncherEnv,
  CLAUDE_BYPASS_PERMISSIONS_ARG,
  isVerifiedDiscoveryVersion,
} from "./launcher.mjs";
import { buildKimiLauncherEnv } from "./kimi-launcher.mjs";
import { buildCodexLauncherEnv } from "./codex-launcher.mjs";
import { buildGrokLauncherEnv } from "./grok-launcher.mjs";
import { buildPiLauncherEnv } from "./pi-launcher.mjs";
import { buildDshLauncherEnv } from "./dsh-launcher.mjs";
import { buildOpencodeLauncherEnv } from "./opencode-launcher.mjs";
import { buildQoderLauncherEnv } from "./qoder-launcher.mjs";
import {
  resolveClaudeExecutable,
  resolveCodexExecutable,
  resolveKimiExecutable,
  resolvePiExecutable,
  resolveDshExecutable,
  resolveOpencodeExecutable,
  resolveGrokExecutable,
  resolveQoderCliExecutable,
  resolveZcodeCliExecutable,
} from "./agent-discovery.mjs";
import { RESUME_COMMAND } from "./session-scan.mjs";

// The resident relay on 47821 is the only credential route: the base URL is
// always it (no per-launch relay is started for a terminal session).
export const AGENT_RELAY_PORT = 47821;

// Copied from launcher.mjs:53 — loopback must never leave the machine.
const LOOPBACK_NO_PROXY = "127.0.0.1,localhost";

// Instance-id scheme caps, same as agent-metrics.mjs:158 (INSTANCE_ID_MAX_LEN).
const INSTANCE_ID_MAX_LEN = 64;

// zcode 终端条目的拉起目标：同目录的 zcode-cli-launcher.mjs，绝对路径在模块
// 加载时静态算出（随安装树整体移动，不吃任何环境变量）。
const ZCODE_CLI_LAUNCHER_PATH = fileURLToPath(new URL("./zcode-cli-launcher.mjs", import.meta.url));

// cmd 包装的固定前缀。/d /c 防 AutoRun 劫持之后，先在 cmd 内部把伪控制台切到
// UTF-8 再串接 agent：ConPTY 新建的伪控制台跟随系统 ANSI 码页（简中机上是
// 936/GBK），而这些 CLI 把界面色块按 UTF-8 原始字节直接写控制台，conhost 拿
// GBK 解码——乱码在 PTY 入口就已产生，面板、SSE 与屏幕镜像拿到的已是坏字符，
// 无从修复。六个 token 全部不含空格，node-pty 拼命令行时不会给它们套引号，
// cmd 按原生语义解析 `chcp 65001 >nul & <exe>`；该形态经真实 terminal-host
// 抓包验证（乱码签名 6150→0，色块全部干净）。副作用与 Windows 系统级 UTF-8
// 选项同口径：同一终端里只写 GBK 字节的老工具会反过来乱码。
const UTF8_CODEPAGE_PREFIX = ["/d", "/c", "chcp", "65001", ">nul", "&"];

// 允许进终端的 CLI Agent。zcode 桌面端是纯 GUI 程序，不属于终端页签；这里的
// zcode 条目拉起的是 CLI 形态：经 zcode-cli-launcher.mjs 中转，因为 CLI 入口
// 是 node 拉起的 bin\zcode.mjs，cmd /d /c 不能直接执行 .mjs；relay 复用、
// 槽位同步与防物化 pin 全在 launcher 内部完成。qoder 已有独立 CLI 形态
// （qodercli.exe，与环境检测同一执行体），同样收进白名单。
// `name` 是显示名，与 environment-service.mjs CLIENTS 共用：页签、菜单与环境页
// 读的是同一句。
export const AGENT_TERMINAL_TARGETS = {
  claude: { name: "Claude Code", kind: "cli", unset: ["ANTHROPIC_API_KEY"] },
  codex: { name: "Codex", kind: "cli", unset: [] },
  kimi: { name: "Kimi Code", kind: "cli", unset: ["ANTHROPIC_API_KEY"] },
  pi: { name: "Pi", kind: "cli", unset: [] },
  dsh: { name: "DeepSeek Harness", kind: "cli", unset: [], launchArgs: ["--profile", "dsh-tui"] },
  opencode: { name: "OpenCode", kind: "cli", unset: [] },
  grok: { name: "Grok Build", kind: "cli", unset: ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"] },
  qoder: { name: "Qoder", kind: "cli", unset: [] },
  // launchArgs 即上面的 launcher 路径：zcode 的执行体解析结果是 node.exe
  // （见 resolveZcodeTerminalExecutable），cmd /d /c node.exe <launcher> 成形。
  zcode: { name: "ZCode", kind: "cli", unset: [], launchArgs: [ZCODE_CLI_LAUNCHER_PATH] },
};

function agentError(message, code, cause) {
  return Object.assign(new Error(message), { code, ...(cause === undefined ? {} : { cause }) });
}

function requireTarget(agentId) {
  const target = AGENT_TERMINAL_TARGETS[agentId];
  if (!target) throw agentError("没有找到这个 CLI Agent，请重新选择", "unknown_agent");
  return target;
}

// 终端一键启动不再自造实例标签的端点。这些客户端不带 x-agent-instance 时，
// relay 用 netstat 反查连接属主合成规范的 "<agentId>-<pid>"（兜底白名单见
// late-socket-instance.mjs），而那才是实例行唯一能对上进程扫描的身份：折叠
// 只认数字尾巴（agent-metrics.mjs normalizeInstanceId），随机标签折不进去，
// 于是同一次会话被拆成两行——进程扫描的占位行带着面徽标却是零计数，流量行
// 带着全部计数却读不出面；终端页的监测区、最近请求与「生成中」灯按占位行的
// id 取数，一并落在空的那行上。这三家的托管配置都写明「无该环境变量即省略
// 该头」，所以省掉标签就等于用户在终端里自己敲这条命令的既有形态。
// pi 不在列：models.json 的 x-agent-instance 落的是静态值（sync 写盘为
// direct，launcher 拉起时改写成实例值、退出恢复——pi-merge-models.mjs），头照
// 发——但 relay 侧把 pi 归进 socket override 集合（late-socket-instance.mjs），
// 头值被忽略、身份以连接属主进程归一，随机标签不再拆出第二行。codex 不在列：它的实例身份正源是
// prompt_cache_key 的会话 id（GUI 多会话复用一个引擎进程，进程粒度根本不成立），
// 标签只是该源缺失时的防撞车兜底，且 codex 不出进程占位行、拆不出第二行。
const TERMINAL_INSTANCE_ID_FROM_SOCKET = new Set(["kimi", "grok", "opencode"]);

// Per-session instance id, same shape as each launcher's buildInstanceId
// ("<cwd basename>-<launcher pid>"): the pid becomes a random per-session tag
// because the shell pid does not exist yet at assembly time. Only reached for
// the two clients above — everyone else ships no tag at all.
function terminalInstanceId(cwd, endpoint) {
  const base = basename(String(cwd || "")).replace(/[^A-Za-z0-9._:-]/g, "-");
  const tag = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${base || endpoint}-t${tag}`.slice(0, INSTANCE_ID_MAX_LEN);
}

// 本会话要注入的实例标签：调用方显式给的算（测试与将来的显式身份用），否则
// 按端点决定要不要现造一个随机标签，不要就返回 null——下游每个 build*Env 都
// 把 null 读成「这条头不发」。
function sessionInstanceId(agentId, cwd, instanceId) {
  if (instanceId !== null) return instanceId;
  return TERMINAL_INSTANCE_ID_FROM_SOCKET.has(agentId) ? null : terminalInstanceId(cwd, agentId);
}

// zcode 的终端形态是 launcher 拉起：真正要验证的是 CLI 入口（bin\zcode.mjs）
// 存在，交给 cmd 的执行体则是 node.exe 本身（process.execPath 恒为绝对路径且
// 存在，必过 resolveAgentExecutable 的检查）。CLI 入口是显式配置制
// （ZCODE_CLI_EXECUTABLE 覆盖、无内置默认），覆盖只验绝对路径，存在性在此
// 一并补齐；入口解析不到返回 null，由 resolveAgentExecutable 转成
// executable_missing 的产品文案。
function resolveZcodeTerminalExecutable(base) {
  const entry = resolveZcodeCliExecutable(base);
  if (typeof entry !== "string" || !existsSync(entry)) return null;
  return process.execPath;
}

const EXECUTABLE_RESOLVERS = {
  claude: resolveClaudeExecutable,
  codex: resolveCodexExecutable,
  kimi: resolveKimiExecutable,
  pi: resolvePiExecutable,
  dsh: resolveDshExecutable,
  opencode: resolveOpencodeExecutable,
  grok: resolveGrokExecutable,
  qoder: resolveQoderCliExecutable,
  zcode: resolveZcodeTerminalExecutable,
};

function resolveAgentExecutable(agentId, base) {
  const missing = agentError("没有找到这个 CLI Agent 的程序，请先在环境检测里确认安装", "executable_missing");
  try {
    const executable = EXECUTABLE_RESOLVERS[agentId](base);
    if (typeof executable !== "string" || !isAbsolute(executable) || !existsSync(executable)) {
      throw missing;
    }
    return executable;
  } catch (error) {
    if (error === missing) throw error;
    // Discovery threw (e.g. codex.exe not found): the raw message is operator
    // text, so the user gets the product sentence and the cause stays attached.
    throw agentError(missing.message, "executable_missing", error);
  }
}

// The env DELTA for one agent: only the keys this launch injects, built by the
// launcher's own build*Env with an empty base so nothing depends on the
// terminal-host's inherited environment (zcode injects nothing at all — its
// launcher owns the env, see buildTargetEnv). Keys listed in the target's `unset`
// come back as null — terminal-host reads null as "delete this key from the
// inherited environment", which is how upstream real keys (a stray
// ANTHROPIC_API_KEY, XAI's pair) are kept out of the PTY.
export function buildAgentSessionEnv({ agentId, port = AGENT_RELAY_PORT, token, base = {}, instanceId = null }) {
  const target = requireTarget(agentId);
  const instance = sessionInstanceId(agentId, base.cwd ?? process.cwd(), instanceId);
  const env = buildTargetEnv(agentId, { port, token, base, instanceId: instance });
  for (const key of target.unset) env[key] = null;
  return env;
}

// The terminal flow has no process to probe `claude --version` (assembly happens
// before any session exists), so the version is read statically from the
// package.json that ships beside the resolved exe (npm-global layout:
// <npm>/node_modules/@anthropic-ai/claude-code/bin/claude.exe). The verified
// 2.1.x family (launcher.mjs) turns discovery on; an unreadable version or one
// outside the family keeps it off — the same downgrade the per-launch shim
// applies, now derived instead of hardcoded.
function claudeDiscoveryEnabled(base) {
  try {
    const executable = resolveClaudeExecutable(base);
    const pkg = JSON.parse(readFileSync(join(dirname(executable), "..", "package.json"), "utf8"));
    return isVerifiedDiscoveryVersion(pkg?.version);
  } catch {
    return false;
  }
}

function buildTargetEnv(agentId, { port, token, base, instanceId }) {
  switch (agentId) {
    case "claude": {
      // discovery is version-gated from the installed package.json: within the
      // verified family the gateway-discovery flag rides the env and the /model
      // picker fills from the relay catalog; outside it (or unreadable) the
      // flag stays off.
      return buildLauncherEnv({ port, token, discovery: claudeDiscoveryEnabled(base), base: {} });
    }
    case "kimi":
      return buildKimiLauncherEnv({ port, token, base: {}, instanceId });
    case "codex":
      return buildCodexLauncherEnv({ instanceId, base: {} });
    case "grok": {
      // 主题选择归用户：只透传显式给的 GROK_THEME（默认值也一律不注入——
      // 主题跟随由终端自身的查询/通知契约负责），其余键仍与终端宿主的
      // 继承环境隔离。
      const theme = "GROK_THEME" in base ? { GROK_THEME: base.GROK_THEME } : {};
      return buildGrokLauncherEnv({ instanceId, base: theme });
    }
    case "pi":
      return buildPiLauncherEnv({ port, token, instanceId, base: {} });
    case "dsh":
      return buildDshLauncherEnv({ port, token, base: {} });
    case "opencode":
      return buildOpencodeLauncherEnv({ token, instanceId, base: {} });
    case "qoder":
      return buildQoderLauncherEnv({ token, base: {} });
    case "zcode":
      // env 全由 launcher 内部构造：凭证作为 apiKey 落在槽位
      // provider_config.json，不骑环境变量，终端注入为零。
      return {};
    default:
      throw requireTarget(agentId);
  }
}

// bypassPermissions 附加参数只属于 claude：设置页开关打开时给 Claude Code 补
// --dangerously-skip-permissions，其余端点不因这个开关多出任何参数。
function claudeBypassArg(agentId, enabled) {
  return agentId === "claude" && enabled === true ? [CLAUDE_BYPASS_PERMISSIONS_ARG] : [];
}

// Theme selection belongs to the agent. The terminal supplies appearance
// queries and notifications; launch arguments must not replace the user's
// chosen theme as a workaround for an incomplete terminal implementation.


// ---------------------------------------------------------------------------
// 续接历史会话：把「哪一条对话」换成续接参数
// ---------------------------------------------------------------------------
//
// 请求里只带会话身份（endpoint / id / file），命令行一律由 session-scan 的
// RESUME_COMMAND 模板重建——客户端发来的命令原文、参数、launch 一概不接。
// 模板同时是「这家 CLI 支持续接吗」的唯一判据：不在表内的端点报
// resume-unsupported，前端据此直接提示，而不是起一个空对话。
//
// 身份值会原样落进 cmd 命令行（node-pty 只给含空格的参数套引号），而引号挡不
// 住 %VAR% 展开，也承不住引号内的转义：& | < > ^ " % 与控制字符一律判非法。
// 会话 id 额外不许含空白——它是单个 token；存档路径（pi）可以含空格，整体作为
// 一个参数交给 node-pty，由它加引号。file 的路径规则只约束「模板真把它拼进
// 命令行」的端点（pi）；其余端点的 file 是扫描器的会话定位符（sqlite:<db>#<id>、
// 百分号编码路径），不进命令行，按元数据放行。
const RESUME_FIELDS = new Set(["endpoint", "id", "file"]);
const RESUME_ID_UNSAFE = /[\s"&|<>^%]/;
const RESUME_FILE_UNSAFE = /["&|<>^%]/;
const RESUME_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// 单个续接身份值的上限，与 terminal-host 的 MAX_LAUNCH_ARG_BYTES 同口径
// （terminal-host.mjs：`arg.length > MAX_LAUNCH_ARG_BYTES` 即判 invalid_launch）。
// 超过它的值放过去，会在宿主那一层被拦成裸 invalid_launch——用户看到「启动
// 失败」，而真正的毛病是这条会话信息有问题，契约要在这一层就把它归到
// resume-invalid。
const RESUME_ARG_MAX_LENGTH = 4096;
// 模板里 id / file 的占位符：先按占位符把模板切成 argv，再把身份值换进去，
// 这样含空格的存档路径不会被拆成两个参数，也不需要第二张参数表与模板并行维护。
const RESUME_ID_SENTINEL = "\u0000id\u0000";
const RESUME_FILE_SENTINEL = "\u0000file\u0000";

function resumeInvalid(cause) {
  return agentError("这个会话的信息不完整，请重新打开对话", "resume-invalid", cause);
}

// Pure: request shape → { endpoint, args }. No process spawn, no disk read, so
// the whole template contract is testable with a stub.
export function buildAgentResumeArgs(resume) {
  if (resume === null || typeof resume !== "object" || Array.isArray(resume)) throw resumeInvalid();
  for (const key of Object.keys(resume)) {
    if (!RESUME_FIELDS.has(key)) throw resumeInvalid();
  }
  const endpoint = typeof resume.endpoint === "string" ? resume.endpoint.trim() : "";
  // 身份不全（缺 endpoint / 空串 / 非字符串）与「端点不支持续接」是两回事：
  // 前者是请求有问题，后者是这家 CLI 压根没有续接参数。
  if (!endpoint) throw resumeInvalid();
  // 原型链上的键（constructor / toString …）不是模板，必须用自有属性判。
  const template = Object.prototype.hasOwnProperty.call(RESUME_COMMAND, endpoint) ? RESUME_COMMAND[endpoint] : null;
  if (typeof template !== "function") {
    throw agentError("这个 Agent 还不支持续接历史会话，请新开一个会话", "resume-unsupported");
  }
  const id = typeof resume.id === "string" ? resume.id.trim() : "";
  if (!id || id.length > RESUME_ARG_MAX_LENGTH || RESUME_ID_UNSAFE.test(id) || RESUME_CONTROL_CHARS.test(id)) {
    throw resumeInvalid();
  }
  let file = "";
  if (resume.file !== undefined && resume.file !== null) {
    if (typeof resume.file !== "string") throw resumeInvalid();
    file = resume.file.trim();
  }
  const tokens = String(template({ id: RESUME_ID_SENTINEL, file: RESUME_FILE_SENTINEL })).trim().split(/\s+/);
  // 模板首 token 是命令名：执行体已由 agentId 解析成绝对路径（归属链与安装位
  // 都不该由一条历史记录决定），这里只取它后面的参数。
  const [, ...args] = tokens;
  const templateUsesFile = args.some((token) => token.includes(RESUME_FILE_SENTINEL));
  // 模板要 file 而请求没给＝身份不全；要了才按路径规则严校验——它将原样落进
  // cmd 命令行。不要 file 的端点，file 只是随行元数据，定位符形态不是路径，
  // 不拿路径规则审它（opencode 的 sqlite 定位符、grok 的百分号编码路径在此
  // 放行，不再误判 resume-invalid）。
  if (templateUsesFile) {
    if (!file || file.length > RESUME_ARG_MAX_LENGTH || !isAbsolute(file) || RESUME_FILE_UNSAFE.test(file) || RESUME_CONTROL_CHARS.test(file)) {
      throw resumeInvalid();
    }
  }
  const rebuilt = args.map((token) => token.replaceAll(RESUME_ID_SENTINEL, id).replaceAll(RESUME_FILE_SENTINEL, file));
  if (rebuilt.length === 0) throw resumeInvalid();
  return { endpoint, args: rebuilt };
}

// 续接参数并进最终命令行时，去掉与端点固定参数完全相同的「--flag value」对
// （见 buildAgentSessionLaunch 内的调用注释）。只认成对形态——flag 后跟一个
// 非选项值，且固定参数里同位置出现同一对；单 token 的重复不在此列（没有哪家的
// 启动器对它报错）。
function dropDuplicateFlagPairs(fixedArgs, resumeArgs) {
  if (resumeArgs.length === 0) return resumeArgs;
  const merged = [];
  for (let i = 0; i < resumeArgs.length; i++) {
    const flag = resumeArgs[i];
    const value = resumeArgs[i + 1];
    const at = typeof value === "string" ? fixedArgs.indexOf(flag) : -1;
    if (
      at !== -1 && flag.startsWith("--") && !value.startsWith("--")
      && fixedArgs[at + 1] === value
    ) {
      i += 1;
      continue;
    }
    merged.push(flag);
  }
  return merged;
}

// Everything terminal-host needs to spawn the session: a cmd /c wrapper (see
// the attribution note on `launch`), the injected env delta, and the non-secret
// metadata the tab and the persisted snapshot display. Throws — never falls
// back — when the working directory or the agent's executable is missing.
export function buildAgentSessionLaunch({ agentId, cwd, port = AGENT_RELAY_PORT, token, base = process.env, instanceId = null, claudeBypassPermissions = false, resume = null }) {
  const target = requireTarget(agentId);
  const directory = typeof cwd === "string" ? cwd.trim() : "";
  if (!directory) throw agentError("请先填写工作目录", "invalid_cwd");
  if (!existsSync(directory)) throw agentError("工作目录不存在，请检查后重试", "invalid_cwd");
  const executable = resolveAgentExecutable(agentId, base);
  const instance = sessionInstanceId(agentId, directory, instanceId);
  // 续接参数在 cwd 与执行体都确认可用之后才校验：这两项是每次启动的硬前提，
  // 报错优先级保持不变（工作目录错就报工作目录，不因续接字段把既有错误盖掉）。
  // 续接的 endpoint 必须与要启动的 agent 一致——否则会拿 A 的执行体拼 B 的
  // 参数（例如 kimi 加 --resume），那是一条谁都不认识的命令。
  let resumeArgs = [];
  if (resume !== null && resume !== undefined) {
    const rebuilt = buildAgentResumeArgs(resume);
    if (rebuilt.endpoint !== agentId) {
      throw agentError("要续接的对话不属于这个 Agent，请重新打开对话", "resume-invalid");
    }
    resumeArgs = rebuilt.args;
  }
  // dsh 的续接模板自带 --profile（复制到终端要能脱离面板独立跑，裸 dsh 拒绝启动），
  // 而端点固定参数已经选过一次 profile，dsh 启动器对二次选择直接报错
  // （bin.js "select a profile only once"）。合并时把续接参数里与固定参数完全
  // 相同的「--flag value」对去掉：值相同语义幂等；其余端点的续接参数不含固定
  // 参数对，逐位不变。
  const fixedArgs = [
    ...(target.launchArgs ?? []),
    ...claudeBypassArg(agentId, claudeBypassPermissions),
  ];
  const mergedResumeArgs = dropDuplicateFlagPairs(fixedArgs, resumeArgs);
  return {
    label: target.name,
    shell: "cmd",
    cwd: directory,
    launch: {
      // Attribution hard requirement: under ConPTY a directly-spawned agent's
      // parent is conhost, which is NOT in agent-metrics' process scan list —
      // monitoring, metrics and recent requests would all lose the session.
      // Wrapping in `cmd /d /c <exe>` makes session.pid a cmd.exe (on the scan
      // list), so the agent's ancestor chain reaches the session. The args
      // carry the executable path only — never a credential. cmd 包装同时
      // 前置代码页切换（见 UTF8_CODEPAGE_PREFIX），agent 与整个终端会话共享
      // UTF-8 伪控制台。
      // dsh 是唯一还要带参数的：它的 CLI 不接裸调用（bin.js 要求显式
      // --profile），终端形态固定为 dsh-tui，与 dsh-cli 快捷命令同一口径。
      // claude 的 bypassPermissions 是设置页开关驱动的附加参数：开 = 跳过工具
      // 权限确认（用户显式打开才带），关 = 一个参数都不加。
      // 续接参数排在最后：执行体与端点自带的固定参数不变，只是这条命令接着
      // 走历史对话（模板见 session-scan.mjs 的 RESUME_COMMAND）。
      file: base.ComSpec || "cmd.exe",
      args: [...UTF8_CODEPAGE_PREFIX, executable, ...fixedArgs, ...mergedResumeArgs],
    },
    env: buildAgentSessionEnv({ agentId, port, token, base, instanceId: instance }),
    agentId,
    agentName: target.name,
  };
}
