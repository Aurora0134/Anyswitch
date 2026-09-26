// One-click CLI Agent launch for the virtual terminal: turn "which agent + which
// working directory" into a launch spec terminal-host can spawn directly, plus
// the environment that carries Anyswitch credentials.
//
// Credentials ride environment variables ONLY: no agent config file is written,
// no secret is concatenated into the command line, and the env never reaches
// disk (terminal-host keeps it in memory for the session's lifetime).
//
// The env contract is imported from each launcher's exported build*Env, so the
// panel and the launchers can never drift apart. Two pieces are copied locally
// with their source cited (the launchers do not export them):
//   - withStoreSmallFastDefault (launcher.mjs:309-330) — the store-derived
//     small-fast (classifier) wire id for Claude;
//   - the buildInstanceId scheme (each launcher), and only for the two clients
//     that cannot do without it (see TERMINAL_INSTANCE_ID_FROM_SOCKET): the
//     session's shell pid does not exist yet at assembly time, so the launcher
//     pid in that scheme becomes a per-session random tag.

import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildLauncherEnv } from "./launcher.mjs";
import { buildKimiLauncherEnv } from "./kimi-launcher.mjs";
import { buildCodexLauncherEnv } from "./codex-launcher.mjs";
import { buildGrokLauncherEnv } from "./grok-launcher.mjs";
import { buildPiLauncherEnv } from "./pi-launcher.mjs";
import { buildDshLauncherEnv } from "./dsh-launcher.mjs";
import { buildOpencodeLauncherEnv } from "./opencode-launcher.mjs";
import {
  resolveClaudeExecutable,
  resolveCodexExecutable,
  resolveKimiExecutable,
  resolvePiExecutable,
  resolveDshExecutable,
  resolveOpencodeExecutable,
  resolveGrokExecutable,
} from "./agent-discovery.mjs";

// The resident relay on 47821 is the only credential route: the base URL is
// always it (no per-launch relay is started for a terminal session).
export const AGENT_RELAY_PORT = 47821;

// Copied from launcher.mjs:53 — loopback must never leave the machine.
const LOOPBACK_NO_PROXY = "127.0.0.1,localhost";

// Instance-id scheme caps, same as agent-metrics.mjs:158 (INSTANCE_ID_MAX_LEN).
const INSTANCE_ID_MAX_LEN = 64;

// Which CLI Agents may be launched into a terminal. zcode/qoder (and the Codex
// desktop app) are GUI programs — they do not belong in a terminal tab. `name`
// is the display name shared with environment-service.mjs CLIENTS so the tab,
// the menu and the environment page all read the same.
export const AGENT_TERMINAL_TARGETS = {
  claude: { name: "Claude Code", kind: "cli", unset: ["ANTHROPIC_API_KEY"] },
  codex: { name: "Codex", kind: "cli", unset: [] },
  kimi: { name: "Kimi Code", kind: "cli", unset: ["ANTHROPIC_API_KEY"] },
  pi: { name: "Pi", kind: "cli", unset: [] },
  dsh: { name: "DSH", kind: "cli", unset: [] },
  opencode: { name: "OpenCode", kind: "cli", unset: [] },
  grok: { name: "Grok Build", kind: "cli", unset: ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"] },
};

function agentError(message, code, cause) {
  return Object.assign(new Error(message), { code, ...(cause === undefined ? {} : { cause }) });
}

function requireTarget(agentId) {
  const target = AGENT_TERMINAL_TARGETS[agentId];
  if (!target) throw agentError("没有找到这个 CLI Agent，请重新选择", "unknown_agent");
  return target;
}

// Copied verbatim from launcher.mjs:309-330 (not exported there): derive the
// small-fast wire id from the local store's first provider/model when the user
// has not set either override. Any failure leaves the base untouched and the
// launcher's placeholder wire id applies.
function withStoreSmallFastDefault(base) {
  if (base.ANTHROPIC_SMALL_FAST_MODEL !== undefined || base.ANYSWITCH_SMALL_FAST_MODEL !== undefined) {
    return base;
  }
  try {
    const storePath = join(
      base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"),
      "Anyswitch",
      "store.json",
    );
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    for (const [providerId, provider] of Object.entries(store.providers ?? {})) {
      const modelId = Object.keys(provider?.models ?? {})[0];
      if (modelId) {
        return { ...base, ANYSWITCH_SMALL_FAST_MODEL: `anthropic/${providerId}/${modelId}` };
      }
    }
  } catch {
    // Store missing or unreadable — the relay start probe reports that itself.
  }
  return base;
}

// 终端一键启动不再自造实例标签的端点。这些客户端不带 x-agent-instance 时，
// relay 用 netstat 反查连接属主合成规范的 "<agentId>-<pid>"（兜底白名单见
// late-socket-instance.mjs），而那才是实例行唯一能对上进程扫描的身份：折叠
// 只认数字尾巴（agent-metrics.mjs normalizeInstanceId），随机标签折不进去，
// 于是同一次会话被拆成两行——进程扫描的占位行带着面徽标却是零计数，流量行
// 带着全部计数却读不出面；终端页的监测区、最近请求与「生成中」灯按占位行的
// id 取数，一并落在空的那行上。这三家的托管配置都写明「无该环境变量即省略
// 该头」，所以省掉标签就等于用户在终端里自己敲这条命令的既有形态。
// pi 不在列：models.json 里的 ${ANYSWITCH_INSTANCE_ID} 占位符缺变量会在启动时
// 抛错（pi-launcher.mjs 头注）。codex 不在列：它的实例身份正源是
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

const EXECUTABLE_RESOLVERS = {
  claude: resolveClaudeExecutable,
  codex: resolveCodexExecutable,
  kimi: resolveKimiExecutable,
  pi: resolvePiExecutable,
  dsh: resolveDshExecutable,
  opencode: resolveOpencodeExecutable,
  grok: resolveGrokExecutable,
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
// terminal-host's inherited environment. Keys listed in the target's `unset`
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

function buildTargetEnv(agentId, { port, token, base, instanceId }) {
  switch (agentId) {
    case "claude": {
      // discovery is false: no version probe runs in the terminal flow, so the
      // gateway-discovery flag stays off — the launcher's unverified-family
      // downgrade. An explicit ANTHROPIC_SMALL_FAST_MODEL in the environment
      // wins and is NOT injected (the inherited value rides along untouched).
      const env = buildLauncherEnv({ port, token, discovery: false, base: {} });
      if (base.ANTHROPIC_SMALL_FAST_MODEL === undefined) {
        const derived = withStoreSmallFastDefault(base);
        env.ANTHROPIC_SMALL_FAST_MODEL = derived.ANYSWITCH_SMALL_FAST_MODEL ?? env.ANTHROPIC_SMALL_FAST_MODEL;
      } else {
        delete env.ANTHROPIC_SMALL_FAST_MODEL;
      }
      return env;
    }
    case "kimi":
      return buildKimiLauncherEnv({ port, token, base: {}, instanceId });
    case "codex":
      return buildCodexLauncherEnv({ instanceId, base: {} });
    case "grok":
      return buildGrokLauncherEnv({ instanceId, base: {} });
    case "pi":
      return buildPiLauncherEnv({ port, token, instanceId, base: {} });
    case "dsh":
      return buildDshLauncherEnv({ port, token, base: {} });
    case "opencode":
      return buildOpencodeLauncherEnv({ token, instanceId, base: {} });
    default:
      throw requireTarget(agentId);
  }
}

// Everything terminal-host needs to spawn the session: a cmd /c wrapper (see
// the attribution note on `launch`), the injected env delta, and the non-secret
// metadata the tab and the persisted snapshot display. Throws — never falls
// back — when the working directory or the agent's executable is missing.
export function buildAgentSessionLaunch({ agentId, cwd, port = AGENT_RELAY_PORT, token, base = process.env, instanceId = null }) {
  const target = requireTarget(agentId);
  const directory = typeof cwd === "string" ? cwd.trim() : "";
  if (!directory) throw agentError("请先填写工作目录", "invalid_cwd");
  if (!existsSync(directory)) throw agentError("工作目录不存在，请检查后重试", "invalid_cwd");
  const executable = resolveAgentExecutable(agentId, base);
  const instance = sessionInstanceId(agentId, directory, instanceId);
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
      // carry the executable path only — never a credential.
      file: base.ComSpec || "cmd.exe",
      args: ["/d", "/c", executable],
    },
    env: buildAgentSessionEnv({ agentId, port, token, base, instanceId: instance }),
    agentId,
    agentName: target.name,
  };
}
