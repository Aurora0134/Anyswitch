const PREFIX = "/openai/";

// 端点身份前缀：`/openai/<agentId>~<providerId>/v1`。
//
// 为什么需要：relay 认发起端点只有两条通道——`x-agent-id` 头与 UA 嗅探，两者都落空
// 时一律兜底成 "zcode"（见 openai-server 的 openaiAgentIdFrom）。Qoder 这类 BYOK 客户
// 端的 provider 配置没有放自定义请求头的地方、UA 里也不带自家标识，于是它的请求全记到
// zcode 名下：看板 Qoder 卡恒 0 请求，zcode 指标被反向污染。前缀让身份跟着 URL 走，
// 不依赖客户端能力。
//
// 为什么是 "~"：store-schema 的 PROVIDER_ID 字符集是 [A-Za-z0-9._-]，真 provider /
// pool / chain node id 永远不含 "~"，所以这个语法自带消歧，无需在此再维护一份端点白名
// 单（白名单校验留在消费侧 openai-server，与 x-agent-id 同一条规则）。
export const AGENT_SEGMENT_SEPARATOR = "~";

export const PARSE_REASON = {
  NOT_OPENAI: "not-an-openai-path",
  NOT_A_STRING: "path-not-a-string",
  NO_PROVIDER: "no-provider-segment",
  EMPTY_PROVIDER: "empty-provider-segment",
  INVALID_PROVIDER: "invalid-provider-character",
};

export function parseOpenAIPath(path) {
  if (typeof path !== "string") {
    return { ok: false, reason: PARSE_REASON.NOT_A_STRING, message: "path must be a string" };
  }
  if (!path.startsWith(PREFIX)) {
    return { ok: false, reason: PARSE_REASON.NOT_OPENAI, message: `path must start with "${PREFIX}"` };
  }
  const rest = path.slice(PREFIX.length);
  const cut = rest.indexOf("/");
  if (cut === -1) {
    return { ok: false, reason: PARSE_REASON.NO_PROVIDER, message: "no provider segment after /openai/" };
  }
  let providerId = rest.slice(0, cut);
  try {
    providerId = decodeURIComponent(providerId);
  } catch {
    return { ok: false, reason: PARSE_REASON.INVALID_PROVIDER, message: "provider segment is not valid percent-encoded" };
  }
  if (providerId.length === 0) {
    return { ok: false, reason: PARSE_REASON.EMPTY_PROVIDER, message: "provider segment is empty" };
  }
  if (providerId.includes("/")) {
    return { ok: false, reason: PARSE_REASON.INVALID_PROVIDER, message: `provider id "${providerId}" must not contain '/' (v2 store invariant)` };
  }
  // 身份前缀在此剥离，且必须在上面两条不变量校验之后：provider id 的 '/' 检查要跑在
  // 未剥离的整段上，否则 `qoder~a%2Fb` 能绕过 v2 不变量。剥离后 providerId 就是真实
  // 渠道 id——store/pool 查找、404 文案、stats 归属全部按它走，前缀只留 agentHint 给
  // 归属决策用。
  let agentHint = null;
  const sep = providerId.indexOf(AGENT_SEGMENT_SEPARATOR);
  if (sep > 0) {
    agentHint = providerId.slice(0, sep);
    providerId = providerId.slice(sep + AGENT_SEGMENT_SEPARATOR.length);
    if (providerId.length === 0) {
      return { ok: false, reason: PARSE_REASON.EMPTY_PROVIDER, message: "provider segment is empty" };
    }
  }
  const subpath = rest.slice(cut);
  return { ok: true, providerId, subpath, agentHint };
}

export function buildOpenAIPath(providerId, subpath = "/v1/chat/completions") {
  if (typeof providerId !== "string" || providerId.length === 0) {
    throw new Error("buildOpenAIPath: providerId must be a non-empty string");
  }
  if (providerId.includes("/")) {
    throw new Error(`buildOpenAIPath: provider id "${providerId}" must not contain '/'`);
  }
  return `${PREFIX}${encodeURIComponent(providerId)}${subpath}`;
}

// 供各端点 merge 模块拼自己的绝对 baseURL 用（它们不走 buildOpenAIPath）。
// 两段各自 percent-encode、分隔符保持字面量——encodeURIComponent 不转义 "~"，
// 与 parseOpenAIPath「先整段解码、再按 '~' 剥离」的顺序严格互逆。
export function buildAgentPrefixedSegment(agentId, providerId) {
  if (typeof agentId !== "string" || agentId.length === 0) {
    throw new Error("buildAgentPrefixedSegment: agentId must be a non-empty string");
  }
  if (typeof providerId !== "string" || providerId.length === 0) {
    throw new Error("buildAgentPrefixedSegment: providerId must be a non-empty string");
  }
  return `${encodeURIComponent(agentId)}${AGENT_SEGMENT_SEPARATOR}${encodeURIComponent(providerId)}`;
}