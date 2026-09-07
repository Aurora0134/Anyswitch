// Chain routing primitives (virtual model "auto", wave 1).
// Pure functions plus one in-memory chain state table. No IO — the store is
// passed in by the caller, same contract as pool-routing.mjs.
//
// A chain is an ordered list of { node, model } entries configured per
// endpoint (store.routingChains[endpointId].chain). node is a flat id that
// resolves as a pool FIRST, then as a provider (mirroring resolvePool's tie
// rule: a pool id may shadow one of its own member's ids, the pool wins);
// model is the concrete upstream model the node is asked for when the chain
// routes to it — this binding is what makes a pool node expandable: its
// members are filtered to those whose catalog contains the bound model.
// Requests against the virtual model AUTO_MODEL walk the chain in order:
//   - a channel node is a single upstream callable;
//   - a pool node expands to the pool's member callables (filtered by the
//     bound model) and runs the existing member-level pool routing
//     internally — the node only counts as failed when the whole pool is
//     exhausted, then the chain backs off to the next node;
//   - a sticky per-endpoint entry remembers the node+model pair that answered
//     last (node alone is not unique: one node may carry several bound
//     models), so subsequent requests start there instead of re-hitting dead
//     heads. The position only moves past a node that is FAILING — see
//     CHAIN_DEMOTE_AFTER_FAILURES below: a single transient fault fails that
//     one request over but leaves the chain at home, so a slow-but-alive
//     (yellow) front node is never demoted for a blip;
//   - every RETRY_UPSTREAM_MS the chain probes upstream again: the attempt
//     plan restarts from the chain head, and a head success sticks back via
//     noteChainSuccess (clearing the backoff anchor — since only marks when
//     a demotion latched, later successes never extend the wait, so a probe
//     always happens within one window however busy the tail is).
//
// The bound model is never checked against a channel's catalog at expansion
// time (matching the store schema, which does not hard-validate it either):
// catalogs shift with discovered refreshes, so a structural check would
// break saved chains. If the upstream cannot serve the model it rejects
// itself — any 4xx included — and the chain backs off.

import { resolvePool, poolMembersWithModel } from "./pool-routing.mjs";

// Statuses that mark a chain NODE as failed and back the chain off to the
// next node: every upstream 4xx and 5xx. Chain nodes deliberately bind models
// without checking the catalog (see the header note) and the client asked for
// the virtual model "auto" — it cannot have "chosen the wrong model", so any
// upstream rejection is a property of THIS node (model renamed/removed
// upstream, lost entitlement, contract drift — many of which surface as 400,
// not 404), exactly what chain failover exists for. The client receives the
// last node's status when the whole chain rejects.
// Pool plans keep using isPoolFailoverStatus unchanged: there the requested
// model was catalog-matched, so 4xx other than 401/403/429 is the client's
// own problem.
export function isChainFailoverStatus(status) {
  return status >= 400;
}

// How long a backed-off chain waits before probing the nodes ahead of the
// current one again. Exported so tests (and future config) can reference it;
// plan functions accept an override parameter.
export const RETRY_UPSTREAM_MS = 300_000;

// How many CONSECUTIVE request-level node failures latch a demotion. One
// transient fault (a single 504/429 blip on an otherwise healthy node) must
// not demote the front row — the chain semantics are 失败（持续红灯）才降级,
// 黄灯（可用但慢）不降. A node that fails this many requests in a row is
// treated as genuinely failing and the chain backs off past it; its counter
// resets the moment it answers again.
export const CHAIN_DEMOTE_AFTER_FAILURES = 2;

// The virtual model id that triggers chain routing. It is deliberately absent
// from every provider catalog — it never reaches an upstream; each chain node
// carries its own concrete bound model instead.
export const AUTO_MODEL = "auto";

// The picker-visible id for AUTO_MODEL on the anthropic protocol path. Claude
// Code's gateway model discovery keeps only catalog entries whose id matches
// /(claude|anthropic)/i, so the bare "auto" id never reaches its /model
// picker; every real wire id survives that filter only because it starts with
// the "anthropic/" prefix. The alias carries the same prefix for the same
// reason. It is deliberately NOT unpackable — a single segment after the
// prefix can never be produced by a provider/model pair (provider ids contain
// no '/'), so it can never collide with a real wire id. planChainMessages
// accepts it and normalizes the body back to AUTO_MODEL before planning.
export const AUTO_MODEL_ANTHROPIC_ID = "anthropic/auto";

// The chain entry for an endpoint, or null. The shape is fixed with the store
// layer: store.routingChains is a top-level map
// endpointId -> { chain: [{ node, model }, ...], enabled?: boolean }.
// enabled is the per-endpoint 自动路由 switch: false keeps the chain config
// but hides/short-circuits auto everywhere (this function is the single
// choke point — /models exposure and every planChain* go through it).
// Absent means enabled (存量链行为不变).
export function resolveChain(store, endpointId) {
  const entry = store?.routingChains?.[endpointId];
  if (!entry || !Array.isArray(entry.chain)) return null;
  if (entry.enabled === false) return null;
  return entry;
}

// 链节点的唯一键：node+model 复合键。同一节点可绑定不同模型多次入链
// （store-schema 按此键去重），所以链位置/退避状态都必须用复合键区分，
// 单按 node 索引会让两次出现互相碰撞。
export function chainNodeKey(nodeId, model) {
  return `${nodeId}\n${model}`;
}

// 同一节点可绑定不同模型多次入链：memberId 撞车时用 `#<model>` 区分两次
// 出现（store schema 保证同节点的 model 不重复，所以后缀后必唯一）。
// taken 是调用方已占用的 memberId 集合（Map 或 Set，只看 has）。
export function uniqueMemberId(taken, baseId, model) {
  return taken.has(baseId) ? `${baseId}#${model}` : baseId;
}

// Whether a chain node id still resolves to something in the store (pool
// first, then provider). Used for lazy invalidation: chains are not edited
// when a node is deleted, plans just skip the corpse.
export function chainNodeExists(store, nodeId) {
  if (resolvePool(store, nodeId)) return true;
  return store?.providers?.[nodeId] !== undefined;
}

// Pure attempt-plan decision. Given the LIVE chain (caller filters dead
// nodes) as an array of { node, model } entries, the current sticky entry
// ({ nodeId, model, since } or null) and now, return the entries to try in
// order:
//   - no state, head state, or stale state -> the whole chain from the head;
//   - backed off and within the retry window -> current node first, tail in
//     order (nodes before the current one are skipped);
//   - backed off and now - since >= retryUpstreamMs -> the whole chain from
//     the head (upstream retry: the nodes before the current one go first, in
//     their original order; the current node and tail stay behind them).
export function planChainAttempts(chain, current, now, retryUpstreamMs = RETRY_UPSTREAM_MS) {
  if (!Array.isArray(chain) || chain.length === 0) return [];
  const currentKey = current ? chainNodeKey(current.nodeId, current.model) : null;
  const index = current ? chain.findIndex((entry) => chainNodeKey(entry?.node, entry?.model) === currentKey) : -1;
  if (index <= 0) return [...chain];
  if (now - current.since >= retryUpstreamMs) return [...chain];
  return chain.slice(index);
}

// Chain-level runtime state: endpointId -> { nodeId, model, since } where
// nodeId+model identify the chain entry that answered last (node alone is
// not unique — one node may carry several bound models) and since is when
// the CURRENT demotion latched (null/absent while the chain sits at home).
// Process memory only — a relay restart resets it, by design (same as
// createStickyTable).
//
// Demotion semantics (失败才降级): a per-node consecutive-failure counter
// (noteFailure, request-level — the handler dedups a pool node's member
// failovers within one request) gates every forward move of the position.
// The position advances past a node only once it has failed
// CHAIN_DEMOTE_AFTER_FAILURES requests in a row; a single blip fails that
// one request over internally but leaves the position alone. since anchors
// at the demotion moment and is NOT refreshed by later tail successes —
// only plan()'s probe (window expiry) re-anchors it, so upstream is probed
// within one RETRY_UPSTREAM_MS of the demotion however busy the tail is.
export function createChainState(options = {}) {
  // onDemote(endpointId, hopIndex, nodes)：进入退避（降级锁定）时回调一次——
  // 仅在位置前进且被跨过的跳全部锁死失败的判定点触发；探测重锚（plan）与
  // 上游恢复不经过它，故同一退避周期只触发一次，链继续降级算新周期再触发。
  const onDemote = options?.onDemote ?? null;
  const table = new Map();
  // nodeKey -> consecutive request-level failures. Keyed by node+model (the
  // chain-position composite) but shared across endpoints: the failing thing
  // is the upstream node, not the endpoint whose chain mentions it.
  const failures = new Map();
  // nodeKeys with ANY recorded outcome since process start. The per-startup
  // lamp view (数据统计与显示单独拆开：每次启动重新统计) treats an untouched
  // node as "no data" — gray — instead of leaning on the persisted model
  // stability file, so a relay restart deliberately resets the picture.
  const attempted = new Set();
  // endpointId -> the chain array of the last plan(), so noteSuccess can
  // compute order (did the answer move forward past failing nodes?) without
  // the handler re-passing the chain.
  const chains = new Map();

  const isLatched = (key) => (failures.get(key) ?? 0) >= CHAIN_DEMOTE_AFTER_FAILURES;

  return {
    // Ordered attempt plan for one request: an array of the chain's
    // { node, model } entries. Dead nodes (deleted from the store) are
    // filtered out of the result lazily — a dead CURRENT node keeps its
    // entry, so the backoff holds at its position and the plan continues at
    // the next live node instead of re-hitting the dead head early. Only an
    // entry whose node+model pair left the configured chain itself (chain
    // re-edited) is dropped here, restarting from the head — no explicit
    // invalidation pass, mirroring createStickyTable.order.
    plan(store, endpointId, chain, now, retryUpstreamMs = RETRY_UPSTREAM_MS) {
      const nodes = chain ?? [];
      chains.set(endpointId, nodes);
      const live = nodes.filter((entry) => chainNodeExists(store, entry?.node));
      let entry = table.get(endpointId);
      const entryKey = entry ? chainNodeKey(entry.nodeId, entry.model) : null;
      if (entry && !nodes.some((chainEntry) => chainNodeKey(chainEntry?.node, chainEntry?.model) === entryKey)) {
        table.delete(endpointId);
        entry = undefined;
      }
      const planned = planChainAttempts(nodes, entry ?? null, now, retryUpstreamMs).filter((chainEntry) =>
        live.includes(chainEntry),
      );
      // Window expired: this plan IS the upstream probe. Re-anchor the window
      // AFTER the plan is computed (the plan must see the expired window and
      // start from the head), so a probe that walks back to the tail (head
      // still failing) starts a fresh RETRY_UPSTREAM_MS instead of expiring
      // again on every request.
      if (entry) {
        const index = nodes.findIndex((chainEntry) => chainNodeKey(chainEntry?.node, chainEntry?.model) === entryKey);
        if (index > 0 && now - entry.since >= retryUpstreamMs) {
          table.set(endpointId, { ...entry, since: now });
        }
      }
      return planned;
    },
    noteSuccess(endpointId, nodeId, model, now) {
      const key = chainNodeKey(nodeId, model);
      attempted.add(key);
      failures.set(key, 0);
      const nodes = chains.get(endpointId);
      // No chain on record (noteSuccess before any plan — tests/diagnostics)
      // or the answer is not in the chain (stale): order is unknowable,
      // mirror the legacy behavior of just sticking.
      if (!Array.isArray(nodes) || !nodes.some((chainEntry) => chainNodeKey(chainEntry?.node, chainEntry?.model) === key)) {
        table.set(endpointId, { nodeId, model, since: now });
        return;
      }
      const newIndex = nodes.findIndex((chainEntry) => chainNodeKey(chainEntry?.node, chainEntry?.model) === key);
      const current = table.get(endpointId);
      const currentIndex = current
        ? nodes.findIndex((chainEntry) => chainNodeKey(chainEntry?.node, chainEntry?.model) === chainNodeKey(current.nodeId, current.model))
        : -1;
      // Staying put: keep the entry (and its demotion anchor) untouched.
      if (newIndex === currentIndex) return;
      // Home: nothing is skipped, no countdown, the whole chain is in play.
      if (newIndex === 0) {
        table.set(endpointId, { nodeId, model, since: null });
        return;
      }
      // An upstream recovery (probe or in-request walk backwards): the chain
      // serves from an earlier node while the front that was skipped is still
      // latched-failing — start a fresh window before probing it again.
      if (newIndex < currentIndex) {
        table.set(endpointId, { nodeId, model, since: now });
        return;
      }
      // Forward move: demote past the skipped entries only if EVERY one of
      // them is latched-failing. Any non-latched skip means the walk crossed
      // a mere blip — leave the position untouched (the next request retries
      // the front row from where it was).
      const skipped = nodes.slice(Math.max(currentIndex, 0), newIndex);
      if (skipped.every((chainEntry) => isLatched(chainNodeKey(chainEntry?.node, chainEntry?.model)))) {
        table.set(endpointId, { nodeId, model, since: now });
        onDemote?.(endpointId, newIndex, nodes);
      }
    },
    // One request-level failure of a node (the handler dedups pool-member
    // failovers within one request). Latching is read lazily by noteSuccess,
    // so the counter is the single source of truth.
    noteFailure(endpointId, nodeId, model) {
      const key = chainNodeKey(nodeId, model);
      attempted.add(key);
      failures.set(key, (failures.get(key) ?? 0) + 1);
    },
    // Introspection for tests and diagnostics.
    get(endpointId) {
      return table.get(endpointId);
    },
    consecutive(nodeId, model) {
      return failures.get(chainNodeKey(nodeId, model)) ?? 0;
    },
    // Per-startup node outcome dump for the runtime/lamp view: one entry per
    // node the chain machinery touched since this process started.
    nodeStats() {
      return Array.from(attempted, (key) => {
        const sep = key.indexOf("\n");
        return {
          node: sep === -1 ? key : key.slice(0, sep),
          model: sep === -1 ? "" : key.slice(sep + 1),
          failures: failures.get(key) ?? 0,
        };
      });
    },
    // Full dump for the panel's route-chain runtime view: one entry per
    // endpoint the chain has a remembered position for.
    snapshot() {
      return Array.from(table, ([endpointId, entry]) => ({ endpointId, ...entry }));
    },
  };
}

// Build the panel-facing chain runtime payload from the store plus one or
// more chainState snapshots. One relay process hosts several protocol
// frontends (openai-handler / anthropic handler), each with
// its OWN chainState closure, so the same endpoint can hold a backoff record
// in more than one of them; the merge keeps the newest entry (max `since`)
// per endpoint — the most recent backoff is the position the next request
// will actually start from in the handler that fired last, and the older
// records only matter to their own handler's next plan (which re-reads its
// own table anyway).
//
// Snapshot elements: a plain array of position entries (legacy/tests) or
// `{ positions, nodes }` where `nodes` is chainState.nodeStats() — the
// per-startup node outcomes backing the lamp column. Node stats merge
// across snapshots worst-case: any closure seeing the node latched-failing
// makes it red; otherwise any recorded outcome makes it green; a node no
// closure touched since process start stays gray.
//
// Payload shape per endpoint:
//   current: { node, model } — where the chain currently sits. With no
//     backoff record this is the chain HEAD (plans always start there), or
//     null when the configured chain is empty.
//   since: epochMs of the last backoff; null when nothing ever backed off
//     (the front-end shows no countdown then: there is nothing to retry).
//   retryIntervalMs: the upstream-retry window; the front-end derives the
//     countdown as retryIntervalMs - (now - since).
//   lamps: per configured chain entry, "green" (touched and not latched —
//     可用), "red" (latched-failing — 不可用/退避), or "gray" (no data this
//     process lifetime). There is deliberately NO yellow: the TTFT-based
//     caution tier was removed from the chain lamps (2026-09-01) — a slow
//     but answering node is still 可用. When every lamp is gray (fresh
//     start, no traffic yet) the head is lit green: it is the next hop by
//     definition, so the rail reads "第一个亮灯，后面暂时全灰".
// Endpoints come from the union of configured routingChains and snapshot
// state: state for a deleted chain still surfaces (it is stale but real,
// and lazily dropped on the endpoint's next request).
export function buildChainRuntime(store, snapshots, retryIntervalMs = RETRY_UPSTREAM_MS) {
  const latest = new Map();
  // Full per-endpoint position set across ALL protocol frontends, deduped by
  // node+model keeping the newest since. `current` alone collapses multi-
  // frontend state into one record (the newest backoff); `positions` surfaces
  // every remembered hop so consumers can see the whole picture.
  const allPositions = new Map(); // endpointId -> Map(nodeKey -> { nodeId, model, since })
  const nodeStats = new Map(); // nodeKey -> { failures, attempted }
  for (const snapshot of snapshots ?? []) {
    if (!snapshot) continue;
    const positions = Array.isArray(snapshot) ? snapshot : snapshot.positions;
    const nodes = Array.isArray(snapshot) ? null : snapshot.nodes;
    if (Array.isArray(nodes)) {
      for (const n of nodes) {
        if (!n || typeof n.node !== "string") continue;
        const key = chainNodeKey(n.node, n.model ?? "");
        const prev = nodeStats.get(key);
        nodeStats.set(key, {
          failures: Math.max(prev?.failures ?? 0, Number(n.failures) || 0),
          attempted: true,
        });
      }
    }
    for (const pos of Array.isArray(positions) ? positions : []) {
      if (!pos || typeof pos.endpointId !== "string") continue;
      const existing = latest.get(pos.endpointId);
      if (!existing || pos.since > existing.since) latest.set(pos.endpointId, pos);
      let perEndpoint = allPositions.get(pos.endpointId);
      if (!perEndpoint) {
        perEndpoint = new Map();
        allPositions.set(pos.endpointId, perEndpoint);
      }
      const key = chainNodeKey(pos.nodeId, pos.model ?? "");
      const prevPos = perEndpoint.get(key);
      if (!prevPos || pos.since > prevPos.since) {
        perEndpoint.set(key, { nodeId: pos.nodeId, model: pos.model ?? "", since: pos.since });
      }
    }
  }
  const lampOf = (node, model) => {
    const e = nodeStats.get(chainNodeKey(node, model));
    if (!e || !e.attempted) return "gray";
    return e.failures >= CHAIN_DEMOTE_AFTER_FAILURES ? "red" : "green";
  };
  const endpoints = {};
  const configured = store?.routingChains ?? {};
  for (const endpointId of new Set([...Object.keys(configured), ...latest.keys()])) {
    // 启用开关关（enabled:false）的端点不进 runtime：链已停走，残留的退避
    // 状态只是历史，监测页 Flow Rail 不应再显示该端点。
    if (configured[endpointId]?.enabled === false) continue;
    const chain = configured[endpointId]?.chain ?? [];
    const state = latest.get(endpointId);
    const lamps = chain.map((entry) => lampOf(entry?.node, entry?.model));
    if (lamps.length && lamps.every((l) => l === "gray")) {
      lamps[0] = "green"; // fresh start: the head is the next hop — light it
    }
    const positionsPayload = Array.from(allPositions.get(endpointId)?.values() ?? []);
    if (state) {
      endpoints[endpointId] = {
        current: { node: state.nodeId, model: state.model },
        since: state.since,
        retryIntervalMs,
        lamps,
        positions: positionsPayload,
      };
      continue;
    }
    const head = chain[0];
    endpoints[endpointId] = {
      current: head ? { node: head.node, model: head.model } : null,
      since: null,
      retryIntervalMs,
      lamps,
      positions: positionsPayload,
    };
  }
  return { endpoints };
}

// A node answered: stick the endpoint to its node+model pair and restart the
// retry clock. This covers both the ordinary failover case (chain head dead,
// a later node answered) and the upstream-retry case (the probe reached an
// earlier node and it answered — sticky returns to it with a fresh since).
export function noteChainSuccess(state, endpointId, nodeId, model, now) {
  state.noteSuccess(endpointId, nodeId, model, now);
}

// One request-level failure of a chain node (called by the handler's plan
// when a member failover advances past it; pool-member failovers within one
// request are deduped to a single count by the handler).
export function noteChainFailure(state, endpointId, nodeId, model) {
  state.noteFailure(endpointId, nodeId, model);
}

// 退避日志：链降级锁定时（onDemote 回调）经 relay logger 落一条 warn；常驻
// 模式下该日志经日志桥（panel.mjs startRelayLogBridge）流进面板「实时输出」。
// 文案中文，含端点 / 位次 / 模型 / 退避窗口（m:ss）。logger 缺失时静默
// （测试与独立 server 场景 deps 里可以没有 logger）。
export function logChainDemote(logger, endpointId, hopIndex, nodes) {
  const totalSec = Math.round(RETRY_UPSTREAM_MS / 1000);
  const wait = `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
  const model = nodes?.[hopIndex]?.model ?? "?";
  const total = nodes?.length ?? "?";
  logger?.warn?.(`自动路由退避：${endpointId} 改用第 ${hopIndex + 1}/${total} 跳（${model}），${wait} 后重试上游`);
}

// Expand one chain entry ({ node, model }) into what the request handler
// needs to build its callUpstreams list. Pools resolve before providers
// (same tie rule as resolvePool). The entry's bound model drives the
// expansion — this is the point of binding a model per node:
//   pool    -> { kind: "pool", poolId, memberIds, model } where memberIds are
//              the pool members whose materialized catalog contains the bound
//              model (pool order, members missing from store.providers
//              dropped — poolMembersWithModel already skips them)
//   channel -> { kind: "channel", providerId, model }; the bound model is NOT
//              checked against the channel's catalog (see the header note)
//   unknown -> null
export function expandChainNode(store, entry) {
  const nodeId = entry?.node;
  const model = entry?.model;

  const pool = resolvePool(store, nodeId);
  if (pool) {
    const memberIds = poolMembersWithModel(store, pool, model).map((candidate) => candidate.memberId);
    return { kind: "pool", poolId: nodeId, memberIds, model };
  }

  if (store?.providers?.[nodeId] !== undefined) {
    return { kind: "channel", providerId: nodeId, model };
  }

  return null;
}
