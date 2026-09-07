import { createServer, request } from "node:http";
import { createOpenAIHandler, openAIError } from "./openai-handler.mjs";
import { createHandler, errorBody } from "./handler.mjs";
import { sendJson, runStreamWithKeepAlive, openAIStreamChannel, anthropicStreamChannel } from "./stream-pipe.mjs";
import { validateStore } from "./store-schema.mjs";
import { isPoolFailoverStatus } from "./pool-routing.mjs";
import { isChainFailoverStatus, buildChainRuntime } from "./chain-routing.mjs";
import { sanitizeInstanceId } from "./agent-metrics.mjs";
import { instanceIdFromSocket, bindLateSocketInstance } from "./late-socket-instance.mjs";
import { wireIdToStatModel, wireIdToTargetId } from "./wire-id.mjs";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
// Single source of truth for the relay's loopback port. Every launcher
// (zcode/dsh/pi/reasonix/opencode) imports this instead of carrying its own
// hardcoded copy, so a launcher can never drift onto a different port than
// the resident relay (relay-host.mjs) binds.
export const DEFAULT_RELAY_PORT = 47821;

// Liveness + identity probe for the relay's own port. GET / must answer a
// JSON body whose service field is "anyswitch-relay" (see the root route) —
// a bare 200 from some unrelated loopback service must not count.
export function probeRelay(port) {
  return new Promise((resolve) => {
    const req = request(`http://127.0.0.1:${port}/`, { method: "GET", timeout: 2000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(false);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const service = JSON.parse(body)?.service;
          resolve(service === "anyswitch-relay" || service === "apicred-relay");
        } catch {
          resolve(false);
        }
      });
      res.on("error", () => resolve(false));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// 已知端点 id 白名单（与 usage-journal 的 agentId 枚举一致）。显式
// x-agent-id 只接受其中的已知值（trim + 小写归一）；未知值视为配置错误
// 或非授权客户端，一律回落 UA 识别与兜底，杜绝幽灵端点 id 进入 journal、
// 面板分桶和链路由查询。
const KNOWN_AGENT_IDS = new Set(["zcode", "dsh", "kimi", "pi", "reasonix", "opencode", "claude"]);

function explicitAgentId(headers) {
  const raw = headers["x-agent-id"];
  if (typeof raw !== "string") return null;
  const id = raw.toLowerCase().trim();
  return KNOWN_AGENT_IDS.has(id) ? id : null;
}

// 可选的实例标签头（同一端点多实例分别统计）。与 x-agent-id 不同，这不是
// 白名单值域——任何符合字符集规则的字符串都是合法实例 id；非法值静默丢弃
// （sanitizeInstanceId），绝不因此拒绝请求。x-agent-id 的值域不受此影响。
function explicitInstanceId(headers) {
  return sanitizeInstanceId(headers["x-agent-instance"]);
}

// Socket→PID 兜底实例标签（机制见 instance-socket-owner.mjs）。x-agent-instance
// 头仍是唯一正源且优先——launcher 注入路径的行为完全不变；只有头缺失（或非法
// 被静默丢弃）时，才对多实例端点（kimi/opencode/pi，与 agent-metrics 的
// instanceBuckets 口径一致）用 netstat 快照反查 keep-alive 连接对端进程，
// 合成 "<agentId>-<pid>"。zcode/claude/dsh/reasonix 保持聚合一桶，一律不兜底。
// pid === process.pid 说明该 socket 归 relay 自己（自环/进程内转发），同样不
// 兜底，避免把 relay 进程伪造成一个实例。
// 两条路径的 id 都在 collector.startRequest 内过 normalizeInstanceId（消费侧
// 归一，读 scanProcesses 缓存，不在请求热路径上新增 spawn）：launcher 注入的
// "<cwd基名>-<launcher pid>" 折入规范的 "<agentId>-<客户端 pid>"；socket 兜底
// 本已规范，归一对它是恒等映射。
function instanceIdForRequest(req, agentId, deps) {
  const explicit = explicitInstanceId(req.headers);
  if (explicit !== null) return explicit;
  return instanceIdFromSocket(req, agentId, deps);
}

// opencode 客户端不带 x-agent-id，用 UA 识别归到 opencode 栏，
// 避免兜底进 zcode 污染其指标。kimi 同理：launcher 经 KIMI_CODE_CUSTOM_HEADERS
// env 注入 x-agent-id: kimi（2026-08-31 起由 config.toml 改为 env 注入，
// config 的 customHeaders 会覆盖 env 同名头），UA 识别降级为未走 launcher
// 直连时的防线——不识别的话 kimi 的链式路由（自动路由 auto）会被
// 兜底成 zcode 的链或直接 404。与 anthropicAgentIdFrom 的 UA 口径保持一致。
function openaiAgentIdFrom(headers) {
  const explicit = explicitAgentId(headers);
  if (explicit) return explicit;
  const ua = (headers["user-agent"] || "").toLowerCase();
  if (ua.includes("opencode")) return "opencode";
  if (ua.includes("kimi-code") || ua.includes("kimi/")) return "kimi";
  return "zcode";
}

// Anthropic-native clients don't send x-agent-id, so we sniff the UA for
// metrics routing and chain (自动路由) lookup. Returns null when unknown.
// A whitelisted explicit header still wins (reasonix injects one), keeping
// both paths' attribution rules symmetric.
function anthropicAgentIdFrom(headers) {
  const explicit = explicitAgentId(headers);
  if (explicit) return explicit;
  const ua = (headers["user-agent"] || "").toLowerCase();
  if (ua.includes("opencode")) return "opencode";
  if (ua.includes("kimi-code") || ua.includes("kimi/")) return "kimi";
  if (ua.includes("reasonix")) return "reasonix";
  if (ua.includes("claude") || ua.includes("anthropic")) return "claude";
  return null;
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        if (!tooLarge) {
          tooLarge = true;
          reject(new BodyTooLargeError());
        }
        chunk.fill(0);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

// Anthropic-shaped usage -> the OpenAI shape the aggregate tracker reads
// (agent-metrics only looks at prompt_tokens/completion_tokens and the
// cached fallback chain ending in cached_tokens). Mirrors the mapping the
// streaming path already does in stream-pipe.mjs onTerminalResult.
export function anthropicUsageToOpenAI(usage) {
  if (!usage || typeof usage !== "object") return usage;
  const mapped = {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
  };
  if (usage.cache_read_input_tokens !== undefined) mapped.cached_tokens = usage.cache_read_input_tokens;
  return mapped;
}

export function createOpenAIRelayServer(deps) {
  const handler = createOpenAIHandler(deps);
  const anthropicHandler = createHandler(deps);

  const server = createServer(async (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJson(res, 403, openAIError("permission_error", "this relay only serves loopback clients"));
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;

    if (path === "/api/hello" && (req.method === "HEAD" || req.method === "GET")) {
      res.writeHead(200, { "content-length": 0 });
      res.end();
      return;
    }

    // Internal loopback telemetry query for the standalone control panel
    // (panel-host.mjs on 47820). Lets a decoupled panel PULL this relay's
    // authoritative live agent metrics cross-process. Loopback-only (already
    // enforced above) and guarded by the same pi-relay-token the relay uses
    // elsewhere — so a foreign loopback client can't read telemetry without
    // the token that lives only in %LOCALAPPDATA%\Anyswitch.
    if (path === "/api/internal/agents" && req.method === "GET") {
      const authHeader = req.headers["authorization"];
      const token = authHeader?.replace(/^Bearer\s+/i, "");
      if (!token || token !== deps.token) {
        sendJson(res, 401, openAIError("authentication_error", "invalid relay token"));
        return;
      }
      if (!deps.metricsCollector) {
        sendJson(res, 200, { ok: true, agents: [] });
        return;
      }
      try {
        const agents = await deps.metricsCollector.getAgentsStatus();
        sendJson(res, 200, { ok: true, agents });
      } catch (err) {
        sendJson(res, 500, openAIError("api_error", `failed to get agent metrics: ${err.message}`));
      }
      return;
    }

    if (path === "/api/internal/model-stability" && req.method === "GET") {
      const authHeader = req.headers["authorization"];
      const token = authHeader?.replace(/^Bearer\s+/i, "");
      if (!token || token !== deps.token) {
        sendJson(res, 401, openAIError("authentication_error", "invalid relay token"));
        return;
      }
      if (!deps.metricsCollector?.getModelStability) {
        sendJson(res, 200, { ok: true, window: "8h", buckets: 48, models: [] });
        return;
      }
      try {
        const snap = deps.metricsCollector.getModelStability();
        sendJson(res, 200, { ok: true, ...snap });
      } catch (err) {
        sendJson(res, 500, openAIError("api_error", `failed to get model stability: ${err.message}`));
      }
      return;
    }

    // Internal loopback route-chain runtime query for the standalone control
    // panel (47820 → /panel/api/route-chain/runtime). The chain backoff state
    // lives in this process's handler closures — one chainState per protocol
    // frontend (openai / anthropic) — so the payload merges both
    // snapshots, keeping the newest record (max since) per endpoint
    // (see buildChainRuntime). Per-LAUNCH relay processes keep their own
    // state and are not aggregated: they are transient and not reachable from
    // the panel, same blind spot as their model-stability rows. Same guard
    // rail as /api/internal/agents: loopback + pi-relay-token.
    if (path === "/api/internal/route-chain-runtime" && req.method === "GET") {
      const authHeader = req.headers["authorization"];
      const token = authHeader?.replace(/^Bearer\s+/i, "");
      if (!token || token !== deps.token) {
        sendJson(res, 401, openAIError("authentication_error", "invalid relay token"));
        return;
      }
      try {
        const loaded = deps.loadStore();
        const store = loaded?.ok ? loaded.store : null;
        // Enriched snapshots: sticky/backoff positions + per-startup node
        // outcomes (the lamp column) per protocol handler's chainState.
        const snapshots = [handler.chainState, anthropicHandler.chainState]
          .filter(Boolean)
          .map((state) => ({ positions: state.snapshot(), nodes: state.nodeStats() }));
        sendJson(res, 200, { ok: true, ...buildChainRuntime(store, snapshots) });
      } catch (err) {
        sendJson(res, 500, openAIError("api_error", `failed to get route-chain runtime: ${err.message}`));
      }
      return;
    }

    // Internal loopback log stream for the standalone control panel
    // (panel-host.mjs on 47820). The panel page's 实时输出 window subscribes
    // to its own process's logger — after the panel/relay process split that
    // bus no longer carries relay-side entries (keep-alive retries, faults),
    // so the panel-host proxies this endpoint and merges both streams.
    // Same guard rail as /api/internal/agents: loopback-only plus the
    // pi-relay-token that lives only in %LOCALAPPDATA%\Anyswitch.
    if (path === "/api/internal/logs" && req.method === "GET") {
      const authHeader = req.headers["authorization"];
      const token = authHeader?.replace(/^Bearer\s+/i, "");
      if (!token || token !== deps.token) {
        sendJson(res, 401, openAIError("authentication_error", "invalid relay token"));
        return;
      }
      if (!deps.logger?.subscribe) {
        sendJson(res, 200, { ok: true });
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Live mode writes nothing until the next entry; without an explicit
      // flush the headers sit unsent and SSE clients (undici fetch, 300s
      // headers timeout) hang on connect. flushHeaders() makes the
      // subscription itself visible immediately.
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      // The panel-host's log bridge reconnects after every relay restart;
      // replaying history there would duplicate entries it already bridged
      // into the panel bus. ?live=1 skips the replay and streams only
      // entries logged after this subscription.
      const liveOnly = url.searchParams.get("live") === "1";
      if (!liveOnly) {
        for (const entry of deps.logger.getHistory()) {
          res.write(`data: ${JSON.stringify(entry)}\n\n`);
        }
      }
      const unsubscribe = deps.logger.subscribe((entry) => {
        try {
          res.write(`data: ${JSON.stringify(entry)}\n\n`);
        } catch {
          // socket gone; unsubscribe happens on close below
        }
      });
      req.on("close", unsubscribe);
      req.on("error", unsubscribe);
      return;
    }

    // GET / — root endpoint liveness probe. Return a minimal JSON body so
    // connectivity checks see a reachable API.
    if ((path === "/" || path === "/v1") && (req.method === "GET" || req.method === "HEAD")) {
      sendJson(res, 200, { status: "ok", service: "anyswitch-relay" });
      return;
    }

    // WebSocket upgrade requests: return 404 so clients fall back to HTTP
    // transport. We don't support WebSocket natively.
    if (req.headers["upgrade"]?.toLowerCase() === "websocket") {
      sendJson(res, 404, openAIError("not_found_error", "WebSocket transport is not supported; use HTTP"));
      return;
    }

    // In-process control panel. Same server, same loopback binding, same token
    // realm as the relay — mounted on a /panel prefix that cannot collide with
    // the /openai/... and /api/hello routes. Only wired when a panelRouter is
    // injected (resident host); the classic per-launch path leaves it unset.
    if (path.startsWith("/panel") && deps.panelRouter) {
      return deps.panelRouter.handle(req, res);
    }

    try {
      const modelsMatch = path.match(/^\/openai\/[^/]+\/v1\/models$/);
      if (modelsMatch && req.method === "GET") {
        const result = await handler.handleModels(path, req.headers, openaiAgentIdFrom(req.headers));
        sendJson(res, result.status, result.body);
        return;
      }

      const chatMatch = path.match(/^\/openai\/([^/]+)\/v1\/chat\/completions$/);
      if (chatMatch && req.method === "POST") {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, openAIError("invalid_request_error", "request body is not valid JSON"));
          return;
        }
        const openaiAgentId = openaiAgentIdFrom(req.headers);
        const tracker = deps.metricsCollector?.startRequest({
          providerId: chatMatch[1],
          model: body?.model,
          userAgent: req.headers["user-agent"],
          agentId: openaiAgentId,
          instanceId: instanceIdForRequest(req, openaiAgentId, deps),
          stream: body.stream === true,
          path: "openai",
        });
        bindLateSocketInstance(req, openaiAgentId, deps, tracker, {
          explicitId: explicitInstanceId(req.headers),
        });

        const abortController = new AbortController();
        const onResAborted = () => {
          // res "close" (not req — see pipeGuardedStream in stream-pipe.mjs)
          // so mid-response client
          // disconnects actually reach this handler on Node >= 16. The fault
          // latch defers to recordEnd ordering: an abort must not be
          // overwritten by a later fault-only recordEnd, and vice versa —
          // first writer wins, both paths are terminal.
          if (!res.writableEnded) {
            abortController.abort();
            tracker?.recordEnd({ aborted: true });
          }
        };
        res.on("close", onResAborted);

        try {
          // Chain routing (自动路由): body.model === "auto" walks the
          // requesting agent's route chain. It takes priority over pool
          // routing because "auto" is a virtual model no real channel (and
          // therefore no pool member catalog) carries. Returns null when the
          // model is not "auto" or the agent has no chain.
          const chainPlan = await handler.planChainChatCompletions(path, req.headers, body, openaiAgentId);
          if (chainPlan !== null && !chainPlan.ok) {
            tracker?.recordEnd({ status: chainPlan.status, error: { status: chainPlan.status, message: chainPlan.body?.error?.message || "Error" } });
            sendJson(res, chainPlan.status, chainPlan.body);
            return;
          }

          // Pool routing (phase 2): when the URL segment names a pool, the
          // request fans out across the pool's candidate members (sticky
          // member first, then pool order). planPoolChatCompletions returns
          // null for plain provider ids — those take the classic path below
          // untouched.
          const poolPlan = chainPlan === null
            ? await handler.planPoolChatCompletions(path, req.headers, body)
            : null;
          if (poolPlan !== null && !poolPlan.ok) {
            tracker?.recordEnd({ status: poolPlan.status, error: { status: poolPlan.status, message: poolPlan.body?.error?.message || "Error" } });
            sendJson(res, poolPlan.status, poolPlan.body);
            return;
          }

          // Chains and pools share the flat per-member call plan shape
          // ({ members, noteSuccess }), so the fan-out below consumes either.
          const memberPlan = chainPlan ?? poolPlan;
          const planLabel = chainPlan ? `chain for "${chainPlan.agentId}"` : `pool "${poolPlan?.poolId}"`;
          // Failover semantics differ by plan kind: chain plans treat an
          // upstream 404 as a node-level failure (the node cannot serve its
          // bound model), pool plans keep 404 request-shaped (passthrough).
          const isFailoverStatus = chainPlan ? isChainFailoverStatus : isPoolFailoverStatus;
          // Auto-route stats attribution: journal/stability rows land on the
          // node that actually serves the request (node + bound model) so the
          // virtual model "auto" never becomes an independent stats entry.
          // Pool plans keep their pool-level attribution (no resolver).
          if (chainPlan) tracker?.setAttributeResolver?.((memberId) => chainPlan.attributeOf?.(memberId) ?? null);

          if (body.stream === true) {
            await runStreamWithKeepAlive(res, openAIStreamChannel({
              res,
              tracker,
              abortController,
              deps,
              ...(memberPlan
                ? {
                    // One callable per candidate member; the keep-alive loop
                    // gives each member its own retry budget and only the last
                    // member's failure goes terminal. The failover class comes
                    // from the plan kind (chain: any 4xx, pool:
                    // isPoolFailoverStatus); a committed stream never switches
                    // members.
                    callUpstreams: memberPlan.members.map((member) => ({
                      memberId: member.memberId,
                      memberNoun: member.memberNoun,
                      call: () => member.call({ signal: abortController.signal }),
                    })),
                    shouldFailover: (result) => isFailoverStatus(result.status),
                    onMemberSuccess: (member) => memberPlan.noteSuccess(member.memberId),
                    // 链计划：成员切换真正越过该节点时计一次请求级失败
                    //（降级门控的计数来源；池计划没有 noteFailure，可选链兜底）。
                    onMemberFailover: (member) => memberPlan.noteFailure?.(member.memberId),
                  }
                : {
                    callUpstream: () => handler.handleChatCompletions(path, req.headers, body, { signal: abortController.signal }),
                  }),
            }));
            return;
          }

          let result;
          if (memberPlan) {
            // Non-streaming pool/chain request: one attempt per member (no
            // keep-alive, same as the classic path), failing over on
            // plan-kind channel-level faults (chain: any 4xx, pool:
            // isPoolFailoverStatus). The client receives the LAST member's
            // error when all fail.
            for (let index = 0; index < memberPlan.members.length; index += 1) {
              const member = memberPlan.members[index];
              tracker?.setCurrentMember?.(member.memberId);
              result = await member.call({ signal: abortController.signal });
              if (result.status < 400) {
                memberPlan.noteSuccess(member.memberId);
                break;
              }
              const isLastMember = index === memberPlan.members.length - 1;
              if (isLastMember || !isFailoverStatus(result.status)) break;
              tracker?.recordRetry?.({ reason: `upstream_${result.status}`, memberId: member.memberId, usage: result.body?.usage });
              deps.logger?.warn?.(`${planLabel}: member "${member.memberId}" returned ${result.status}; failing over to the next member`);
              memberPlan.noteFailure?.(member.memberId);
            }
          } else {
            result = await handler.handleChatCompletions(path, req.headers, body, { signal: abortController.signal });
          }
          if (result.status >= 400) {
            // Error responses never produce a first token — no recordFirstChunk
            // here, otherwise the failure duration lands in TTFT as a fake
            // healthy-looking first-byte latency.
            tracker?.recordEnd({ status: result.status, error: { status: result.status, message: result.body?.error?.message || "Error" }, usage: result.body?.usage });
          } else {
            // Non-streaming success: do NOT call recordFirstChunk here. The full
            // request duration is the best TTFT proxy available; calling recordFirstChunk
            // right before recordEnd would falsely compress generation duration to 0-1ms
            // and inflate TPS to 2000-5000+ tok/s.
            tracker?.recordEnd({ status: result.status, usage: result.body?.usage });
          }
          sendJson(res, result.status, result.body);
          return;
        } catch (err) {
          if (abortController.signal.aborted) {
            tracker?.recordEnd({ aborted: true });
          } else {
            tracker?.recordEnd({ status: 500, error: { status: 500, message: err.message } });
          }
          throw err;
        } finally {
          res.removeListener("close", onResAborted);
        }
      }

      // ── Anthropic protocol endpoints (native /v1/models, /v1/messages) ──
      // Claude Code, Kimi Code and other Anthropic-native clients speak this
      // protocol directly. The resident relay must serve these routes so they
      // can discover models and send messages without a per-launch relay.

      if (path === "/v1/models" && req.method === "GET") {
        const result = await anthropicHandler.handleModels(req.headers, anthropicAgentIdFrom(req.headers));
        sendJson(res, result.status, result.body);
        return;
      }

      if (path === "/v1/messages" && req.method === "POST") {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, errorBody("invalid_request_error", "request body is not valid JSON"));
          return;
        }

        // Detect the agent from the user-agent header for metrics routing
        // and chain (自动路由) lookup.
        const agentId = anthropicAgentIdFrom(req.headers);

        // Chain routing (自动路由): body.model === "auto" walks the
        // requesting agent's route chain and takes priority over pool
        // routing (a virtual model no pool member catalog carries).
        const chainPlan = await anthropicHandler.planChainMessages(req.headers, body, agentId);

        // Pool routing (phase 2): a body.model of anthropic/<pool-id>/<model>
        // fans out across the pool's candidate members (sticky member first,
        // then pool order). planPoolMessages returns null for plain provider
        // wire ids — those take the classic path below untouched.
        const poolPlan = chainPlan === null
          ? await anthropicHandler.planPoolMessages(req.headers, body)
          : null;

        // Chains and pools share the flat per-member call plan shape
        // ({ members, noteSuccess }), so the fan-out below consumes either.
        const memberPlan = chainPlan ?? poolPlan;
        const planLabel = chainPlan ? `chain for "${chainPlan.agentId}"` : `pool "${poolPlan?.poolId}"`;
        // Failover semantics differ by plan kind: chain plans treat an
        // upstream 404 as a node-level failure (the node cannot serve its
        // bound model), pool plans keep 404 request-shaped (passthrough).
        const isFailoverStatus = chainPlan ? isChainFailoverStatus : isPoolFailoverStatus;

        const tracker = deps.metricsCollector?.startRequest({
          // The tracker's main key is the pool id for pool requests; member
          // attribution rides failure/retry entries as memberId. Plain
          // channel wire-id requests carry their channel id — the fallback
          // chain otherwise ends in stale lastProvider or an empty 未知渠道
          // row.
          providerId: memberPlan?.poolId ?? wireIdToTargetId(body?.model),
          // Stats attribution uses the bare "<provider>/<model>" tail, not
          // the wire ID the client sent: the "anthropic/" prefix is wire
          // identity spoofing and must not reach the journal/panel stats.
          model: wireIdToStatModel(body?.model),
          userAgent: req.headers["user-agent"],
          agentId,
          instanceId: instanceIdForRequest(req, agentId, deps),
          stream: body.stream === true,
          path: "anthropic",
        });
        // Auto-route stats attribution: journal/stability rows land on the
        // serving chain node (node + bound model) instead of the virtual
        // model "auto". Pool plans keep pool-level attribution (no resolver).
        if (chainPlan) tracker?.setAttributeResolver?.((memberId) => chainPlan.attributeOf?.(memberId) ?? null);
        bindLateSocketInstance(req, agentId, deps, tracker, {
          explicitId: explicitInstanceId(req.headers),
        });

        const abortController = new AbortController();
        const onResAborted = () => {
          if (!res.writableEnded) {
            abortController.abort();
            tracker?.recordEnd({ aborted: true });
          }
        };
        res.on("close", onResAborted);

        try {
          if (memberPlan !== null && !memberPlan.ok) {
            tracker?.recordEnd({ status: memberPlan.status, error: { status: memberPlan.status, message: memberPlan.body?.error?.message || "Error" } });
            sendJson(res, memberPlan.status, memberPlan.body);
            return;
          }

          if (body.stream === true) {
            // Resident Anthropic channel: no keep-alive pings, and at
            // exhaustion nothing more is written once headers are committed.
            await runStreamWithKeepAlive(res, anthropicStreamChannel({
              res,
              tracker,
              abortController,
              deps,
              ...(memberPlan
                ? {
                    // One callable per candidate member; the keep-alive loop
                    // gives each member its own retry budget and only the last
                    // member's failure goes terminal. The failover class comes
                    // from the plan kind (chain: any 4xx, pool:
                    // isPoolFailoverStatus); a committed stream never switches
                    // members.
                    callUpstreams: memberPlan.members.map((member) => ({
                      memberId: member.memberId,
                      memberNoun: member.memberNoun,
                      call: () => member.call(),
                    })),
                    shouldFailover: (result) => isFailoverStatus(result.status),
                    onMemberSuccess: (member) => memberPlan.noteSuccess(member.memberId),
                    onMemberFailover: (member) => memberPlan.noteFailure?.(member.memberId),
                  }
                : {
                    callUpstream: () => anthropicHandler.handleMessages(req.headers, body),
                  }),
              name: "anthropic",
              logLabel: "anthropic request",
              pings: false,
              writeFrameWhenHeadersSent: false,
            }));
            return;
          }

          let result;
          if (memberPlan) {
            // Non-streaming pool/chain request: one attempt per member (no
            // keep-alive, same as the classic path), failing over on
            // plan-kind channel-level faults (chain: any 4xx, pool:
            // isPoolFailoverStatus). The client receives the LAST member's
            // error when all fail.
            for (let index = 0; index < memberPlan.members.length; index += 1) {
              const member = memberPlan.members[index];
              tracker?.setCurrentMember?.(member.memberId);
              result = await member.call();
              if (result.status < 400) {
                memberPlan.noteSuccess(member.memberId);
                break;
              }
              const isLastMember = index === memberPlan.members.length - 1;
              if (isLastMember || !isFailoverStatus(result.status)) break;
              tracker?.recordRetry?.({ reason: `upstream_${result.status}`, memberId: member.memberId, usage: result.body?.usage });
              deps.logger?.warn?.(`${planLabel}: member "${member.memberId}" returned ${result.status}; failing over to the next member`);
              memberPlan.noteFailure?.(member.memberId);
            }
          } else {
            result = await anthropicHandler.handleMessages(req.headers, body);
          }
          const mappedUsage = anthropicUsageToOpenAI(result.body?.usage);
          if (result.status >= 400) {
            tracker?.recordEnd({ status: result.status, error: { status: result.status, message: result.body?.error?.message || "Error" }, usage: mappedUsage });
          } else {
            tracker?.recordEnd({ status: result.status, usage: mappedUsage });
          }
          sendJson(res, result.status, result.body);
          return;
        } catch (err) {
          if (abortController.signal.aborted) {
            tracker?.recordEnd({ aborted: true });
          } else {
            tracker?.recordEnd({ status: 500, error: { status: 500, message: err.message } });
          }
          throw err;
        } finally {
          res.removeListener("close", onResAborted);
        }
      }

      sendJson(res, 404, openAIError("not_found_error", `unsupported endpoint ${req.method} ${path}`));
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        if (!res.headersSent) {
          sendJson(res, 413, openAIError("invalid_request_error", "request body exceeds the maximum allowed size"));
        }
        return;
      }
      if (!res.headersSent) {
        sendJson(res, 500, openAIError("api_error", "the relay failed to handle this request"));
      } else {
        res.end();
      }
    }
  });

  return server;
}

export function listenLoopback(server, preferredPort = DEFAULT_RELAY_PORT) {
  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        probeRelay(preferredPort).then((isOurs) => {
          if (isOurs) {
            resolve({
              port: preferredPort,
              reused: true,
              close: () => Promise.resolve(),
            });
          } else {
            reject(new Error(`port ${preferredPort} is in use by another process`));
          }
        }, reject);
      } else {
        reject(err);
      }
    });
    server.listen(preferredPort, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}