// 垫片对账——把 ~/.config/anyswitch-bin 的命令门牌维持成「接线状态的终端投影」。
//
// 语义（2026-11-03 用户裁决「垫片随产品安装」）：
//   - 已接线（store 有可见渠道、或启用虚拟模型——这两者全体端点共享——或该端
//     点自己的 auto 链）且本机装了该 Agent → 三件套在盘、内容指向当前
//     launcher 路径、其目录置顶用户 PATH。置顶是必要条件：追加条目永远排在
//     Agent 自己的安装目录之后，命令查找轮不到门牌（见下方 PATH 批量手术）。
//   - 掉线或 Agent 已不在的端点 → 门牌撤下；PATH 条目等目录清空后一并撤，
//     命令落回 Agent 原生入口。手写异形门牌不是我们放的，不碰——判据沿用
//     2026-11-01 孤儿清理：三件套逐文件字节比对「当前形态或根路径旧形态」的
//     渲染结果，全中才算我们的；装侧同理，在盘的是异形就不覆盖（尊重用户的
//     自定义启动器，宁可少装不可误写）。
//   - store 读不出来 → 整体不动（装与撤都停）：绝不基于半截状态动用户的盘
//     与注册表。调用方（面板宿主启动、面板同步完成）全部非致命包裹，对账
//     失败不拖倒任何主线。
//
// 触发面：panel-host.mjs 启动、panel.mjs handleAgentSync 完成后
// （fire-and-forget）。幂等：无变化零写入；PATH 值有变才写一次、广播一次
// （WM_SETTINGCHANGE 只对新开的终端生效——已开终端维持旧 PATH 是 Windows
// 语义，不是缺陷）。升级路径自愈：换树后新面板宿主起来的这一轮对账会把
// ≤0.7.0 旧形态门牌就地改写成新路径——正是 0.7.1 更新债在垫片侧的还法。

import {
  existsSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  SHIM_SPECS,
  createShimManager,
  renderShimScripts,
  shimFileNames,
  splitPathValue,
  pathEntriesEqual,
  createRegistryPathStore,
  createEnvironmentBroadcaster,
} from "./shim-manager.mjs";
import { deriveVisibleChannels } from "../channels/pool-providers.mjs";
import { deriveAnyswitchChannel } from "../launchers/merge-common.mjs";
import { loadStore, storePaths } from "../store/store-io.mjs";
import {
  resolveClaudeExecutable,
  resolveCodexExecutable,
  resolveDshExecutable,
  resolveGrokExecutable,
  resolveOpencodeExecutable,
  resolvePiExecutable,
  resolveWorkbuddyExecutable,
  resolveZcodeExecutable,
} from "./agent-discovery.mjs";

// 与 shim-manager 的 defaultFs 同一面：注入时测试给全套，默认走真 fs。
const realFs = {
  existsSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
};

// spec.id → 安装探测，与面板环境检测（environment-service 的 CLIENTS 表）同一
// 族 resolver。codex 直用 agent-discovery 的执行体解析（含 npm shim 候选）；
// 环境页自己的 resolveCodexShim 是它检测面的专属包装，不在此复用——本表只回
// 答「CLI 在不在本机」，不关心桌面入口形态。
const SPEC_RESOLVERS = {
  claude: resolveClaudeExecutable,
  codex: resolveCodexExecutable,
  dsh: resolveDshExecutable,
  grok: resolveGrokExecutable,
  opencode: resolveOpencodeExecutable,
  pi: resolvePiExecutable,
  workbuddy: resolveWorkbuddyExecutable,
  zcode: resolveZcodeExecutable,
};

/**
 * 端点此刻是否接线。渠道与虚拟模型是全体端点共享的（各 Agent 的配置同步写
 * 同一份可见渠道集——deriveVisibleChannels 的端点无关是有意设计），链才是端
 * 点维度：任一共享面在、或该端点自己的 auto 链在，即视为接线。
 */
export function isEndpointWired(store, endpointId) {
  if (Object.keys(deriveVisibleChannels(store)).length > 0) return true;
  return deriveAnyswitchChannel(store, endpointId) !== null;
}

// 根路径旧形态：分域重构（af65661）前的 spec 长相——launcher 直接在 app 根。
// 认得出它，≤0.7.0 时代的产品门牌才能被改写或撤下；认不出的手写文件不动。
function legacySpecOf(spec) {
  return { ...spec, launcher: spec.launcher.split("/").pop() };
}

/**
 * 三件套是否全是本管理器的产物（当前形态或根路径旧形态；缺文件按部分残留
 * 仍算我们的——清一半的旧账也是清）。任何一个在盘文件读出来对不上两种渲染
 * 即判异形：宁可不动，不可误写误删。
 * shimFileNames 的顺序（sh/.cmd/.ps1）与 renderShimScripts 的键（sh/cmd/ps1）
 * 按位一一对应——按文件名去索引渲染结果会恒 undefined，这里是两套命名的桥。
 */
export function shimSetIsOurs(spec, dir, fs) {
  const forms = [renderShimScripts(spec), renderShimScripts(legacySpecOf(spec))];
  const names = shimFileNames(spec);
  const kinds = ["sh", "cmd", "ps1"];
  for (let i = 0; i < names.length; i++) {
    const target = join(dir, names[i]);
    if (!fs.existsSync(target)) continue;
    let text;
    try {
      text = fs.readFileSync(target, "utf8");
    } catch {
      return false;
    }
    if (!forms.some((form) => form[kinds[i]] === text)) return false;
  }
  return true;
}

/**
 * 跑一轮对账。deps 全注入口（测试给假件，生产走默认）：
 *   env / fs / pathStore / broadcastFn —— shim-manager 同款注入面；
 *   loadStoreFn —— 默认读真实 store，返回 { ok:false } 即整体不动；
 *   isEndpointInstalled —— (specId, baseEnv) => boolean；
 *   log —— (level, message) 往调用方日志走（info/warn）。
 * 返回 { ok, reason?, installed, rewrote, removed, keptForeign, pathChanged,
 * pathError? }。单 spec 的失败记日志不中断其余；PATH 读写失败降级为 pathError
 * 不影响文件面已完成的收敛。
 */
export async function reconcileShims(deps = {}) {
  const {
    env = process.env,
    fs = realFs,
    pathStore = createRegistryPathStore(),
    broadcastFn = createEnvironmentBroadcaster(),
    loadStoreFn = () => loadStore(storePaths()),
    isEndpointInstalled = (specId, base) => SPEC_RESOLVERS[specId]?.(base) != null,
    log = () => {},
  } = deps;

  let probe;
  try {
    probe = await loadStoreFn();
  } catch (error) {
    probe = { ok: false, reason: String(error?.message ?? error) };
  }
  if (!probe?.ok) {
    log("warn", `shim reconcile skipped: store not usable (${probe?.reason ?? "unknown"})`);
    return {
      ok: false,
      reason: "store_unreadable",
      installed: [],
      rewrote: [],
      removed: [],
      keptForeign: [],
      pathChanged: false,
    };
  }
  const store = probe.store;

  const manager = createShimManager({ env, fs, pathStore, broadcastFn });
  const dirFor = (spec) => join(manager.root, spec.dir);

  const installed = [];
  const rewrote = [];
  const removed = [];
  const keptForeign = [];
  const desiredDirs = [];

  for (const spec of SHIM_SPECS) {
    const dir = dirFor(spec);
    let hasFiles = false;
    try {
      hasFiles = shimFileNames(spec).some((name) => fs.existsSync(join(dir, name)));
    } catch {
      hasFiles = false;
    }
    try {
      if (spec.retired) {
        // 退役命令永不安装；在盘且是我们的 → 清掉（2026-11-01 孤儿类的自愈）。
        if (hasFiles) {
          if (shimSetIsOurs(spec, dir, fs)) {
            manager.removeShim(spec);
            removed.push(spec.id);
            log("info", `shims: retired command "${spec.command}" removed`);
          } else {
            keptForeign.push(spec.id);
            log("warn", `shims: retired command "${spec.command}" has hand-made files, left alone`);
          }
        }
        continue;
      }
      const wanted = isEndpointWired(store, spec.id) && isEndpointInstalled(spec.id, env);
      if (wanted) {
        // 在盘的是异形（用户自己的启动器）就不覆盖：尊重自定义，宁可少装。
        if (hasFiles && !shimSetIsOurs(spec, dir, fs)) {
          keptForeign.push(spec.id);
          log("warn", `shims: "${spec.command}" has hand-made files, not overwriting`);
          continue;
        }
        const result = manager.installShim(spec);
        if (result.written.length > 0) (hasFiles ? rewrote : installed).push(spec.id);
        if (!desiredDirs.includes(dir)) desiredDirs.push(dir);
      } else if (hasFiles) {
        if (shimSetIsOurs(spec, dir, fs)) {
          manager.removeShim(spec);
          removed.push(spec.id);
        } else {
          keptForeign.push(spec.id);
          log("warn", `shims: "${spec.command}" is no longer wired but its files are hand-made, left alone`);
        }
      }
    } catch (error) {
      log("warn", `shims: reconcile failed for "${spec.command}" (non-fatal): ${error?.message ?? error}`);
    }
  }

  // PATH 批量手术：一次读、一次写、一次广播。期望终态＝在册目录按 SHIM_SPECS
  // 稳定序置顶、其余条目原样跟随（归一化只剔空段）。与归一化后的当前值比对、
  // 有差才写——幂等性由此而来；「逐条前插」会把我们的目录顺序每轮翻转一遍、
  // 每轮都触发一次写，是把置顶做错的最常见形态。读写失败降级为 pathError，
  // 不影响文件面已完成的收敛。
  let pathChanged = false;
  let pathError = null;
  try {
    const current = await pathStore.read();
    const entries = splitPathValue(current ?? "");
    const rest = entries.filter((entry) => !desiredDirs.some((dir) => pathEntriesEqual(entry, dir)));
    // 死条目清理只针对 spec 目录：目录已不在盘上且不在册的，条目一并清；目录
    // 还在（共享 bin/ 里另有在册命令、或剩了手写文件）的按 retireShim 同款语
    // 义保留。非 spec 目录的条目是用户自己的 PATH，永远不动。
    const specDirs = [];
    for (const spec of SHIM_SPECS) {
      const dir = dirFor(spec);
      if (!specDirs.some((d) => pathEntriesEqual(d, dir))) specDirs.push(dir);
    }
    const aliveRest = rest.filter((entry) =>
      !specDirs.some((dir) => pathEntriesEqual(entry, dir)) || fs.existsSync(entry));
    const desiredValue = [...desiredDirs, ...aliveRest].join(";");
    if (desiredValue !== entries.join(";")) {
      await pathStore.write(desiredValue);
      pathChanged = true;
      await broadcastFn().catch((error) => {
        log("warn", `shims: PATH broadcast failed (non-fatal): ${error?.message ?? error}`);
      });
    }
  } catch (error) {
    pathError = error?.message ?? String(error);
    log("warn", `shims: user PATH update failed (non-fatal): ${pathError}`);
  }

  if (installed.length > 0) log("info", `shims: installed for ${installed.join(", ")}`);
  if (rewrote.length > 0) log("info", `shims: refreshed stale form for ${rewrote.join(", ")}`);
  if (removed.length > 0) log("info", `shims: removed for ${removed.join(", ")}`);
  if (pathChanged) log("info", "shims: user PATH updated; new terminals pick it up");

  return { ok: true, installed, rewrote, removed, keptForeign, pathChanged, pathError };
}
