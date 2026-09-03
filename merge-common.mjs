// Shared sidecar read/write for the five per-agent merge modules
// (kimi/zcode/dsh/reasonix/pi). Each module used to carry a byte-identical
// copy of these two functions; the on-disk contract is one JSON object
// { "providers": [ids…] } — ids sorted, 2-space indent, trailing newline —
// written through atomicWriteFile so a crash never leaves a half-written
// sidecar. The sidecar is a cache of "what we injected last time", never user
// data, so a missing or corrupt file reads back as an empty managed list
// (fail-open) rather than failing the merge.
//
// Also home to the shared auto-routing pseudo-channel derivation (chain
// routing, wave 2): endpoint-aware, so it lives here rather than in
// pool-providers.mjs, whose deriveVisibleChannels is deliberately
// endpoint-agnostic.

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFile } from "./atomic-write.mjs";

export function readSidecar(path) {
  if (!existsSync(path)) return { providers: [] };
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { providers: [] };
  }
}

export function writeSidecar(path, providerIds) {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(
    path,
    JSON.stringify({ providers: [...providerIds].sort() }, null, 2) + "\n",
  );
}

// The managed-id key of the virtual auto-routing channel. Merge modules
// prefix managed ids with "_", so it surfaces to endpoints as "_auto".
export const AUTO_CHANNEL_KEY = "auto";
export const AUTO_CHANNEL_NAME = "自动路由";

// Derive the virtual auto-routing pseudo-channel for one endpoint, or null
// when the endpoint has no usable route chain. The shape mirrors the pool
// pseudo-providers from pool-providers.mjs so the merge modules can append it
// to their provider map and let the ordinary entry builders emit it:
//   - channelName    — the endpoint-facing provider label (provider 显示名
//                      「自动路由」，仅 zcode/pi/dsh 等支持渠道显示名的格式使用）;
//   - baseUrlSegment — the URL segment the builders place in
//                      /openai/<segment>/v1. For a real channel this is its
//                      own id; for the auto channel it is the chain HEAD node
//                      id (which always resolves per the store schema). The
//                      relay intercepts the virtual model "auto" before any
//                      provider/model check, so the segment never routes a
//                      concrete model itself;
//   - models         — exactly one entry: the virtual model "auto"，模型显示名
//                      也是 "auto"（端点软件里模型名显示 auto、provider 名显示
//                      「自动路由」，二者不再共用同一个标注）。
export function deriveAutoRouteChannel(store, endpointId) {
  const entry = store?.routingChains?.[endpointId];
  // per-endpoint 启用开关：关 = 链配置保留，但 _auto 伪渠道不再同步进 agent 配置
  // （下一轮 merge 的 managed 块自然不再含它，与删链同一条清理路径）。
  if (entry?.enabled === false) return null;
  const chain = entry?.chain;
  if (!Array.isArray(chain) || chain.length === 0) return null;
  const head = chain[0]?.node;
  if (typeof head !== "string" || head.length === 0) return null;
  return {
    channelName: AUTO_CHANNEL_NAME,
    baseUrlSegment: head,
    models: { [AUTO_CHANNEL_KEY]: { displayName: AUTO_CHANNEL_KEY } },
  };
}
