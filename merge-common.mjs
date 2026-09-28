// Shared sidecar read/write for the per-agent merge modules
// (kimi/zcode/dsh/pi/qoder). The on-disk contract is one JSON object
// { "providers": [ids…] } — ids sorted, 2-space indent, trailing newline —
// written through atomicWriteFile so a crash never leaves a half-written
// sidecar. The sidecar is a cache of "what we injected last time", never user
// data, so a missing or corrupt file reads back as an empty managed list
// (fail-open) rather than failing the merge.
//
// Also home to the shared auto-routing pseudo-channel derivation:
// endpoint-aware, so it lives here rather than in
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
// The Anyswitch pseudo-channel's endpoint-facing provider label（provider
// 显示名）：虚拟模型与 auto 都装在这个分组下（原「自动路由」改名，auto 一并
// 归组）。
export const ANYSWITCH_CHANNEL_NAME = "Anyswitch";

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
    channelName: ANYSWITCH_CHANNEL_NAME,
    baseUrlSegment: head,
    models: { [AUTO_CHANNEL_KEY]: { displayName: AUTO_CHANNEL_KEY } },
  };
}

// The full Anyswitch pseudo-channel: auto（端点链仍在时）+ 全部启用中的虚拟
// 模型，统一挂在 provider 显示名「Anyswitch」下（用户需求：各端点的 provider
// 字段显示为 Anyswitch，旗下装所有虚拟模型，auto 一并归组）。端点无关：
// 每个端点都收到同一份虚拟模型集合，而 auto 仍按各自端点的链有或没有。
// URL 段沿用 auto 链的头节点（链拦截先于一切 provider 解析，段本身从不路由
// 具体模型）；端点没有可用 auto 链但虚拟模型存在时，段退取第一个虚拟模型的
// 链头——虚拟模型请求同样在链拦截层处理，段只为 parseOpenAIPath 服务。
// 全空（无 auto 链且无启用虚拟模型）返回 null，由各写入器的既有清理路径
// 自然移除托管块。
export function deriveAnyswitchChannel(store, endpointId) {
  const auto = deriveAutoRouteChannel(store, endpointId);
  const vms = (Array.isArray(store?.virtualModels) ? store.virtualModels : []).filter(
    (vm) =>
      vm &&
      typeof vm === "object" &&
      typeof vm.name === "string" &&
      vm.enabled !== false &&
      Array.isArray(vm.chain) &&
      vm.chain.length > 0 &&
      typeof vm.chain[0]?.node === "string" &&
      vm.chain[0].node.length > 0,
  );
  if (!auto && vms.length === 0) return null;
  const models = {};
  if (auto) models[AUTO_CHANNEL_KEY] = { displayName: AUTO_CHANNEL_KEY };
  for (const vm of vms) {
    // 模型显示名 = 虚拟模型名（与 auto 的裸名口径一致：它是链路由触发词，
    // 不是真模型，渠道限定显示名反而误导）。
    models[vm.name] = { displayName: vm.name };
  }
  return {
    channelName: ANYSWITCH_CHANNEL_NAME,
    baseUrlSegment: auto?.baseUrlSegment ?? vms[0].chain[0].node,
    models,
  };
}
