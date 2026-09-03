// Relay loopback HTTP transport.
//
// Binds 127.0.0.1 on an ephemeral port. The session token is CSPRNG-generated at
// startup, never written to disk, never logged, and dies with the process.
// Non-loopback peers are refused before any routing happens.
//
// This module owns transport only: routing, auth and translation live in
// handler.mjs / protocol.mjs / stream.mjs, and the keep-alive streaming
// pipeline lives in stream-pipe.mjs.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createHandler, errorBody } from "./handler.mjs";
import { sendJson, runStreamWithKeepAlive, anthropicStreamChannel } from "./stream-pipe.mjs";
import { isPoolFailoverStatus } from "./pool-routing.mjs";
import { isChainFailoverStatus } from "./chain-routing.mjs";
import { wireIdToStatModel, wireIdToTargetId } from "./wire-id.mjs";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

export function generateToken() {
  // 256 bits, hex encoded.
  return randomBytes(32).toString("hex");
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

// deps are the same injected IO surface handler.mjs takes, plus an optional
// sessionTracker for per-launch metrics reporting. deps.agentId names the
// endpoint this per-launch relay serves (default "claude"; the kimi launcher
// passes "kimi") — it drives the auto catalog entry, chain routing and the
// log label, so a kimi relay's traffic never lands in the claude bucket.
export function createRelayServer(deps) {
  const handler = createHandler(deps);
  const tracker = deps?.sessionTracker ?? null;
  const agentId = typeof deps?.agentId === "string" && deps.agentId ? deps.agentId : "claude";

  const server = createServer(async (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJson(res, 403, errorBody("permission_error", "this relay only serves loopback clients"));
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;

    // Liveness probe: never touches the store or upstream.
    if (path === "/api/hello" && (req.method === "HEAD" || req.method === "GET")) {
      res.writeHead(200, { "content-length": 0 });
      res.end();
      return;
    }

    try {
      if (path === "/v1/models" && req.method === "GET") {
        // The per-launch relay serves exactly one endpoint: the launched
        // agent (agentId). Passing the id lets the catalog offer that
        // endpoint's route chain as the "auto" virtual model.
        const result = await handler.handleModels(req.headers, agentId);
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
        const abortController = new AbortController();
        // Terminal/first-chunk signals go through the per-request handle
        // returned by startRequest once it exists (see below); until then
        // (and for mock trackers without a handle) the tracker itself.
        let reqTracker = tracker;
        const onResAborted = () => {
          if (!res.writableEnded) {
            abortController.abort();
            reqTracker?.recordEnd({ aborted: true });
          }
        };
        res.on("close", onResAborted);
        try {
          // Pool routing: a body.model of anthropic/<pool-id>/<model>
          // fans out across the pool's candidate members (sticky member first,
          // then pool order). planPoolMessages returns null for plain provider
          // wire ids — those take the classic path below untouched.
          const poolPlan = await handler.planPoolMessages(req.headers, body);

          // Chain routing (自动路由): a body.model of "auto" walks this
          // endpoint's route chain (per-launch relay = the agentId endpoint).
          // planChainMessages returns null for anything else — pool and plain
          // provider wire ids take their paths above/below untouched.
          const chainPlan = poolPlan === null
            ? await handler.planChainMessages(req.headers, body, agentId)
            : null;
          const memberPlan = poolPlan ?? chainPlan;
          // Failover semantics differ by plan kind: chain plans treat an
          // upstream 404 as a node-level failure (the node cannot serve its
          // bound model), pool plans keep 404 request-shaped (passthrough).
          const isFailoverStatus = chainPlan ? isChainFailoverStatus : isPoolFailoverStatus;

          const request = tracker?.startRequest({
            // Pool requests attribute to the pool id; plain channel wire-id
            // requests carry their channel id — without it the session
            // reporter has no fallback left (attr exists only for chain
            // plans) and the row lands as 未知渠道 in the stats tab.
            providerId: memberPlan?.poolId ?? wireIdToTargetId(body?.model),
            // Stats attribution uses the bare "<provider>/<model>" tail, not
            // the wire ID Claude Code sent: the "anthropic/" prefix is wire
            // identity spoofing and must not reach the journal/panel stats.
            model: wireIdToStatModel(body?.model),
            stream: body.stream === true,
            path: "anthropic",
          });
          // Claude Code fires concurrent in-session requests (side queries,
          // rapid re-send after Esc): terminal/first-chunk signals must go
          // through the per-request handle so an interleaved end settles its
          // own request — the shared outer recordEnd would swallow the late
          // end and pin activeRequests at 1 forever. Session-level wiring
          // (member attribution, keep-alive counters) stays on the tracker.
          if (request) reqTracker = { ...tracker, ...request };
          // Auto-route stats attribution: journal rows land on the serving
          // chain node (node + bound model) instead of the virtual "auto" —
          // same wiring as the resident relay paths.
          if (chainPlan) tracker?.setAttributeResolver?.((memberId) => chainPlan.attributeOf?.(memberId) ?? null);

          if (poolPlan !== null && !poolPlan.ok) {
            reqTracker?.recordEnd({ status: poolPlan.status, error: { status: poolPlan.status, message: poolPlan.body?.error?.message || "Error" } });
            sendJson(res, poolPlan.status, poolPlan.body);
            return;
          }
          if (chainPlan !== null && !chainPlan.ok) {
            reqTracker?.recordEnd({ status: chainPlan.status, error: { status: chainPlan.status, message: chainPlan.body?.error?.message || "Error" } });
            sendJson(res, chainPlan.status, chainPlan.body);
            return;
          }

          // handleMessages (stream + non-stream) is driven entirely by the
          // keep-alive loop: it owns the retry decision and the first
          // upstream call, so a pre-call here would leak a discarded stream.
          await runStreamWithKeepAlive(res, anthropicStreamChannel({
            res,
            tracker: reqTracker,
            abortController,
            deps,
            ...(memberPlan
              ? {
                  // One callable per candidate member (pool members, or the
                  // chain's flattened node/member callables); the keep-alive
                  // loop gives each member its own retry budget and only the
                  // last member's failure goes terminal. The failover class
                  // comes from the plan kind (chain: any 4xx, pool:
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
                  callUpstream: () => handler.handleMessages(req.headers, body),
                }),
            name: agentId,
            logLabel: `${agentId} request`,
            pings: true,
            writeFrameWhenHeadersSent: true,
          }));
          return;
        } catch (err) {
          if (res.destroyed || abortController.signal.aborted) {
            reqTracker?.recordEnd({ aborted: true });
          } else {
            reqTracker?.recordEnd({ error: { status: 500, message: err?.message || "relay error" } });
          }
          throw err;
        } finally {
          res.removeListener("close", onResAborted);
        }
      }

      sendJson(res, 404, errorBody("not_found_error", `unsupported endpoint ${req.method} ${path}`));
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        if (!res.headersSent) {
          sendJson(res, 413, errorBody("invalid_request_error", "request body exceeds the maximum allowed size"));
        }
        return;
      }
      // Generic: an internal fault must not leak paths, credentials or stacks.
      if (!res.headersSent) {
        sendJson(res, 500, errorBody("api_error", "the relay failed to handle this request"));
      } else {
        res.end();
      }
    }
  });

  return server;
}

// Start on an ephemeral loopback port. Resolves with { port, close }.
export function listenLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
