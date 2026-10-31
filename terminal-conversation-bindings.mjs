// 终端会话 ↔ agent 对话存档的绑定存储与匹配（复活带回原对话的数据层）。
//
// 背景：复活链（panel.mjs handleTerminalSessionRevive）重组 launch 时没有任何
// 一环携带 agent 对话 id，起来的天然是空白新对话。本模块提供两块能力：
//   1. 绑定存储：终端会话 id → { agentId, cwd, conversationId, file, boundAt,
//      source }，落在 %LOCALAPPDATA%\Anyswitch\terminal-conversation-bindings.json
//      （与 terminal-sessions.json 同目录），原子写沿用 atomic-write.mjs。
//      会话 id 跨宿主重启稳定（terminal-host restore 原样读回盘上的 id）。
//   2. 匹配纪律：绑定捕获（会话还在跑时异步扫描）与 revive 兜底（无绑定时按
//      生命周期重叠挑存档）共用同一套「同 agent 同 cwd + 时间窗重叠 + 最新活
//      跃胜出」判定；判不出唯一者就返回 null——宁可不接，不可接错。
//
// 覆盖名单与 session-scan.mjs 的 RESUME_COMMAND 表同一份：只有能把对话 id
// 非交互地传回 CLI 的端点才可接。qoder 认 -r <id>（无参才弹选择器），dsh /
// zcode / workbuddy 的 CLI 亦有 --resume <id>，四家已随 RESUME_COMMAND 一同
// 补齐；纯 shell 会话没有可传回的对话 id，维持现状。
//
// resume 后是否同一对话文件：claude/kimi/grok/pi/opencode/dsh/zcode/qoder 续写
// 原存档，绑定天然不失效；codex 若另起新 rollout，由 revive 成功后的延迟重扫
// （pickRefreshedMeta）按「复活时刻之后唯一活跃」自愈换绑。workbuddy 的
// `--resume <sessionId>` 读写同一个 <sessionId>.jsonl，同属续写原存档一类。

import { readFileSync } from "node:fs";
import { atomicWriteFile } from "./atomic-write.mjs";

export const TERMINAL_CONVERSATION_BINDINGS_FILE = "terminal-conversation-bindings.json";

// 可按对话 id 续会的端点（参数格式见 resumeArgsFor，与 session-scan.mjs 的
// RESUME_COMMAND 注释同源：各家 CLI 自己 --help 文档化的形态）。
export const RESUMABLE_AGENTS = new Set(["claude", "kimi", "pi", "opencode", "codex", "grok", "dsh", "zcode", "qoder", "workbuddy"]);

// 追加在 launch.args 末尾的续会参数。pi 认存档文件路径（同 RESUME_COMMAND 里
// 的 meta.file），其余各家认对话 id；codex 是子命令形态（codex resume <id>）。
// 这里是「追加片段」语境，不是 RESUME_COMMAND 的「独立可跑整句」语境：端点固定
// 参数已在 launch.args 里，dsh 不再带 --profile（带上会撞 dsh 启动器的
// 「select a profile only once」）。缺续会所需字段（如 pi 绑定没有 file）返回
// null——接不出就不接。
const RESUME_ARGS = {
  claude: (binding) => ["--resume", binding.conversationId],
  kimi: (binding) => ["--session", binding.conversationId],
  grok: (binding) => ["--resume", binding.conversationId],
  codex: (binding) => ["resume", binding.conversationId],
  opencode: (binding) => ["--session", binding.conversationId],
  dsh: (binding) => ["--resume", binding.conversationId],
  zcode: (binding) => ["--resume", binding.conversationId],
  qoder: (binding) => ["--resume", binding.conversationId],
  // workbuddy 与 RESUME_COMMAND 同口径（workbuddy --resume <id>）：这里只追加
  // 参数片段，命令名由终端执行体（shim）负责。
  workbuddy: (binding) => ["--resume", binding.conversationId],
  pi: (binding) => (typeof binding.file === "string" && binding.file !== "" ? ["--session", binding.file] : null),
};

export function resumeArgsFor(agentId, binding) {
  if (!binding || typeof binding.conversationId !== "string" || binding.conversationId === "") return null;
  const build = RESUME_ARGS[agentId];
  return build ? build(binding) : null;
}

// Windows 路径键：小写、统一分隔符、去尾斜杠。与 terminal-attribution.mjs 的
// cwdKey 同一口径——终端会话的 cwd 与对话存档里的 project 是同一目录的不同
// 拼写。
function cwdKey(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "" ? null : normalized;
}

// 两个 cwd 是否同一目录（键口径同上；任一侧为空即判不同）。
export function sameCwd(a, b) {
  const ka = cwdKey(a);
  return ka !== null && ka === cwdKey(b);
}

function ts(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// 一条存档元数据的时间窗 [first, last]。kimi 的索引没有创建时间（createdAt
// 为 null），退化为以最近活跃为点的点窗。
function metaWindow(meta) {
  const last = ts(meta?.lastActive) ?? ts(meta?.createdAt);
  if (last === null) return null;
  return { first: ts(meta.createdAt) ?? last, last };
}

// 候选过滤：同端点、同目录；codex 排除桌面端来源（originator 含 "desktop"）——
// 与 terminal-attribution.mjs 的 codex 桥同一规则，GUI 会话不能抢 CLI 终端的
// 匹配。
function candidateFilter(meta, { agentId, cwd }) {
  if (!meta || meta.endpoint !== agentId) return false;
  const key = cwdKey(cwd);
  if (key === null || cwdKey(meta.project) !== key) return false;
  if (agentId === "codex" && String(meta.originator ?? "").toLowerCase().includes("desktop")) return false;
  return true;
}

// 存档时间窗与终端会话生命周期 [createdAt, lastActiveAt] 是否重叠（任一端为
// null 即该侧开口）。跑着的会话由调用方把 lastActiveAt 传成当前时刻——窗口是
// 开口的，「createdAt 之后新建/活跃」全部纳入。
function overlaps(window, sessionCreatedAt, sessionLastActiveAt) {
  if (sessionCreatedAt !== null && window.last < sessionCreatedAt) return false;
  if (sessionLastActiveAt !== null && window.first > sessionLastActiveAt) return false;
  return true;
}

// 绑定捕获与 revive 兜底共用的挑选：生命周期重叠的候选里取最近活跃者；完全
// 并列（不同 id 同 lastActive）判不出，返回 null。
export function pickConversationMeta(metas, { agentId, cwd, createdAt = null, lastActiveAt = null }) {
  let best = null;
  let tied = false;
  for (const meta of Array.isArray(metas) ? metas : []) {
    if (!candidateFilter(meta, { agentId, cwd })) continue;
    if (typeof meta.id !== "string" || meta.id === "") continue;
    const window = metaWindow(meta);
    if (window === null || !overlaps(window, ts(createdAt), ts(lastActiveAt))) continue;
    if (best === null || window.last > best.window.last) {
      best = { meta, window };
      tied = false;
    } else if (window.last === best.window.last && meta.id !== best.meta.id) {
      tied = true;
    }
  }
  return best === null || tied ? null : best.meta;
}

// revive 后的自愈换绑：复活时刻之后活跃的存档恰好一条时返回它（同 id 即确认
// 原绑定，不同 id 即 resume 另起了新存档）。零条（agent 还没落笔）或多条
// （同目录另有对话同期活跃）都判不出，返回 null 维持原绑定。
export function pickRefreshedMeta(metas, { agentId, cwd, sinceMs }) {
  if (typeof sinceMs !== "number" || !Number.isFinite(sinceMs)) return null;
  let found = null;
  for (const meta of Array.isArray(metas) ? metas : []) {
    if (!candidateFilter(meta, { agentId, cwd })) continue;
    if (typeof meta.id !== "string" || meta.id === "") continue;
    const window = metaWindow(meta);
    if (window === null || window.last < sinceMs) continue;
    if (found !== null && meta.id !== found.id) return null;
    found = meta;
  }
  return found;
}

export function bindingFromMeta(meta, { agentId, cwd }, source) {
  return {
    agentId,
    cwd,
    conversationId: meta.id,
    file: typeof meta.file === "string" && meta.file !== "" ? meta.file : null,
    boundAt: Date.now(),
    source,
  };
}

function sanitizeBinding(value) {
  if (!value || typeof value !== "object") return null;
  const { agentId, cwd, conversationId, boundAt, source } = value;
  if (typeof agentId !== "string" || agentId === "") return null;
  if (typeof cwd !== "string" || cwd === "") return null;
  if (typeof conversationId !== "string" || conversationId === "") return null;
  if (typeof boundAt !== "number" || !Number.isFinite(boundAt)) return null;
  if (source !== "bound" && source !== "scanned") return null;
  return {
    agentId,
    cwd,
    conversationId,
    file: typeof value.file === "string" && value.file !== "" ? value.file : null,
    boundAt,
    source,
  };
}

// 绑定文件的读缓存 + 原子写。读只发生一次（懒加载），之后进程内以缓存为准——
// 唯一写入方是本面板进程。落盘失败上抛给调用方决定（捕获/复活路径都是尽力
// 而为，绑不上不改主流程）。
export function createBindingStore({ file }) {
  let loaded = null; // Map<sessionId, binding>

  function ensureLoaded() {
    if (loaded !== null) return;
    loaded = new Map();
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return; // 文件不存在或损坏：从空开始
    }
    const entries = raw?.bindings;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return;
    for (const [sessionId, value] of Object.entries(entries)) {
      if (typeof sessionId !== "string" || sessionId === "") continue;
      const binding = sanitizeBinding(value);
      if (binding) loaded.set(sessionId, binding);
    }
  }

  function save() {
    const bindings = Object.fromEntries(loaded);
    atomicWriteFile(file, JSON.stringify({ version: 1, bindings }, null, 2));
  }

  return {
    get(sessionId) {
      ensureLoaded();
      return loaded.get(sessionId) ?? null;
    },
    set(sessionId, binding) {
      ensureLoaded();
      const clean = sanitizeBinding(binding);
      if (!clean) throw new TypeError(`invalid binding for terminal session ${sessionId}`);
      loaded.set(sessionId, clean);
      save();
      return clean;
    },
    delete(sessionId) {
      ensureLoaded();
      if (!loaded.delete(sessionId)) return false;
      save();
      return true;
    },
    // 清掉会话已不在列表里的绑定（页签关闭即会话记录删除，绑定成孤儿）。
    // 退出中的会话仍在列表里，其绑定必须留到复活用。
    prune(keepIds) {
      ensureLoaded();
      let changed = false;
      for (const sessionId of [...loaded.keys()]) {
        if (!keepIds.has(sessionId)) {
          loaded.delete(sessionId);
          changed = true;
        }
      }
      if (changed) save();
      return changed;
    },
    // 测试与排查用：当前缓存的条目数。
    get size() {
      ensureLoaded();
      return loaded.size;
    },
  };
}
