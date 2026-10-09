// ZCode CLI launcher — spawns the locally built ZCode CLI (node bin\zcode.mjs)
// through the Anyswitch relay against an Anyswitch-owned provider config slot,
// so the CLI never reads or writes the desktop client's ~/.zcode data.
//
// The isolation mechanism (verified against the CLI source,
// apps/zcode-cli packages/cli/src/provider-runtime-env.ts):
//   - ZCODE_PERSONAL_PROVIDER_CONFIG_FILE points the CLI at the slot file
//     <LOCALAPPDATA>\Anyswitch\zcode-cli\provider_config.json instead of the
//     desktop's ~/.zcode/v2/provider_config.json;
//   - ZCODE_BUILTIN_PROVIDER_CONFIG_FILE pins the builtin provider config
//     bundled next to the CLI entry. The two must be set together: with only
//     the personal path set the CLI materializes its builtin cache under
//     ~/.zcode/v2/runtime/provider/... (isolation broken); with both set it
//     writes nothing and skips the CDN refresh entirely.
//
// The flow:
//   1. resolve the CLI entry (ZCODE_CLI_EXECUTABLE override or the local build
//      tree) and derive the bundled builtin config from it — when neither the
//      bundled file nor the source-tree fallback exists the launch is refused:
//      starting without the pin would silently materialize the builtin cache
//      into the desktop client's data root;
//   2. reuse the resident relay on 47821 when it answers the identity probe,
//      otherwise start a per-launch relay that dies with the CLI; when BOTH
//      levels fail the CLI still launches on its native configuration — the
//      personal-config injection is dropped (the CLI falls back to the
//      desktop-shared ~/.zcode/v2 config) while the builtin pin stays, since
//      it only guards against materialization and has nothing to do with the
//      relay;
//   3. best-effort sync of the managed provider entries into the slot's
//      provider_config.json (zcode-personal-config.mjs; errors are logged,
//      never block the launch, and the sync runs in native mode too so the
//      entries revive once the resident relay answers again);
//   4. spawn node <bin\zcode.mjs> with argv passed through verbatim (no args
//      enters the TUI; -p is single-shot; app-server is the stdio protocol
//      service). The child process handle is the only liveness signal — there
//      is no tasklist/image-name detection of any kind.

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, realpathSync } from "node:fs";
import { createOpenAIRelayServer, listenLoopback, probeRelay, DEFAULT_RELAY_PORT } from "./openai-server.mjs";
import { createProductionDeps } from "./launch.mjs";
import { loadStore } from "./store-io.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";
import { createUsageJournal } from "./usage-journal.mjs";
import {
  mergeZcodeConfig,
  extractManagedProviders,
  deriveAnyswitchChannel,
  zcodeCliSidecarPath,
} from "./zcode-merge-config.mjs";
import { readSidecar, writeSidecar } from "./merge-common.mjs";
import { syncZcodePersonalConfig } from "./zcode-personal-config.mjs";
import { acquireRelayOrNative, loadNativeSyncToken } from "./launcher-native-fallback.mjs";
import { defaultZcodeCliExecutable, resolveZcodeCliExecutable } from "./agent-discovery.mjs";
export { resolveZcodeCliExecutable };

export const RELAY_PORT = DEFAULT_RELAY_PORT;

function relayDataRoot(base = process.env) {
  return join(base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"), "Anyswitch");
}

// The CLI's Anyswitch-owned slot: the personal provider config lives here,
// fully isolated from the desktop client's ~/.zcode. Its sidecar lives one
// level up next to the desktop's (zcode-cli-sidecar.json — see
// zcode-merge-config.mjs), shared with the periodic sync.
export function zcodeCliDataDir(base = process.env) {
  return join(relayDataRoot(base), "zcode-cli");
}

// ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 的注入目标。
export function zcodeCliProviderConfigPath(base = process.env) {
  return join(zcodeCliDataDir(base), "provider_config.json");
}

function createOpenAIProductionDeps(options = {}) {
  const claudeDeps = createProductionDeps(options);
  // Usage journal (same dir as the resident relay) so fallback-relay traffic
  // still lands in the stats journal when the resident relay is down.
  let usageJournal = null;
  try {
    usageJournal = createUsageJournal({ dir: join(relayDataRoot(options.base ?? process.env), "usage") });
  } catch { usageJournal = null; }
  return {
    token: loadOrGenerateToken(relayDataRoot(options.base ?? process.env)),
    loadStore: claudeDeps.loadStore,
    loadCredential: claudeDeps.loadCredential,
    buildUpstreamURLs: claudeDeps.buildUpstreamURLs,
    upstreamFetch: claudeDeps.upstreamFetch,
    recordGeneration: claudeDeps.recordGeneration,
    readGeneration: claudeDeps.readGeneration,
    effortInjector: claudeDeps.effortInjector,
    metricsCollector: createAgentMetricsCollector({ journal: usageJournal }),
  };
}

export async function startOpenAIRelay(options = {}) {
  const deps = createOpenAIProductionDeps(options);
  const probe = deps.loadStore();
  if (!probe.ok) {
    throw new Error("the Anyswitch global store is not usable; refusing to start the zcode-cli relay");
  }
  const server = createOpenAIRelayServer(deps);
  const { port, reused, close } = await listenLoopback(server, RELAY_PORT);
  return { port, token: deps.token, close, reused };
}

// ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 的取值：优先发行树内随包的 builtin 配置
// （dist 实测布局：bin\zcode.mjs 的兄弟 agent\provider\zcode-builtin.json），
// 推导不到再回落到源码树 config/provider/zcode-builtin.json（与 CLI 自己的
// resolveBundledZCodeBuiltinProviderConfig 同一相对层级）。两者都没有则报错
// 不启动——这比让 CLI 把 builtin 缓存静默物化进 ~/.zcode/v2/runtime 好。
export function resolveZcodeCliBuiltinConfig(cliEntry, io = { existsSync }) {
  const entryDir = dirname(cliEntry);
  const candidates = [
    join(entryDir, "..", "agent", "provider", "zcode-builtin.json"),
    resolve(entryDir, "..", "..", "..", "..", "..", "config", "provider", "zcode-builtin.json"),
  ];
  const found = candidates.find((candidate) => io.existsSync(candidate));
  if (!found) {
    throw new Error(
      `cannot locate the zcode builtin provider config next to ${cliEntry} ` +
        `(looked for ${candidates.join(" and ")}); refusing to launch without it — ` +
        `the CLI would materialize its builtin cache into the desktop client's data root`,
    );
  }
  return found;
}

// Relay mode: the personal path redirects the CLI's provider list into the
// Anyswitch slot, the builtin pin keeps the CLI from materializing its builtin
// cache, NO_PROXY keeps relay traffic on loopback. The relay token never rides
// the environment — it only lives as the apiKey of the managed entries in the
// slot's provider_config.json (same contract as codex/grok's managed config).
export function buildZcodeCliLauncherEnv({ base = {}, personalConfigPath, builtinConfigPath }) {
  const env = { ...base };
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personalConfigPath;
  env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinConfigPath;
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = "127.0.0.1,localhost";
  return env;
}

// 原生回落 = 摘掉 personal 注入（含外层环境残留的同名变量），CLI 退回桌面版
// 共享的 ~/.zcode/v2 配置；builtin 指向保留——它只为防物化，与 relay 无关。
// 因此这里不用 buildNativeLauncherEnv 的逐字透传。
export function buildZcodeCliNativeEnv({ base = {}, builtinConfigPath }) {
  const env = { ...base };
  delete env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinConfigPath;
  return env;
}

// One sync of the CLI slot's provider_config.json from the store. The slot has
// no config.json at all — the CLI reads provider_config.json directly — so the
// merge runs against an empty base purely to produce the managed entries, and
// only the personal document reaches disk. The sidecar is shared with the
// periodic sync (zcode-launcher.mjs syncZcodeCliSlot): it lives next to the
// desktop sidecar as <sidecarRoot>\zcode-cli-sidecar.json, derived here from
// the slot dir's parent; tests pass it explicitly.
export async function writeZcodeCliConfig(store, port, token, slotRoot, sidecarPath = zcodeCliSidecarPath(dirname(slotRoot))) {
  const managedProviders = extractManagedProviders(store);
  const autoChannel = deriveAnyswitchChannel(store, "zcode");
  // Same early-exit contract as the desktop writeZcodeConfig: a machine with no
  // channels and no prior injection must not get files created on every launch.
  const previousManaged = readSidecar(sidecarPath).providers;
  if (Object.keys(managedProviders).length === 0 && !autoChannel && previousManaged.length === 0) {
    return { ok: true, unchanged: true, reason: "no Anyswitch providers with models" };
  }
  // catalog 传 null：推理强度 variants 不进入 provider_config.json 的规则
  // （personalRuleFromProviderEntry 只取 contextWindow），带上只是死重。
  const { config, managed } = mergeZcodeConfig({ provider: {} }, managedProviders, port, token, previousManaged, autoChannel, null);
  const personal = syncZcodePersonalConfig({
    // syncZcodePersonalConfig 取 dirname(configPath) 落 provider_config.json，
    // configPath 只需落在槽位目录内。
    configPath: join(slotRoot, "config.json"),
    managedEntries: Object.fromEntries(managed.map((id) => [`_${id}`, config.provider[`_${id}`]])),
    previousManaged: previousManaged.map((id) => `_${id}`),
  });
  if (!personal.ok) return { ok: false, unchanged: true, reason: personal.reason };
  writeSidecar(sidecarPath, managed);
  return { ok: true, unchanged: personal.unchanged, backupPath: personal.backupPath };
}

export async function runZcodeCliLauncher({
  startRelay,
  // writeConfig / loadStore / loadToken / spawnZcodeCli are the only doors this
  // function has to the user's machine (the slot's provider_config.json, the
  // Anyswitch store, the shared relay token file, the process table). They
  // deliberately have no defaults: main() wires the real implementations and a
  // test that forgets one crashes instead of silently writing through to the
  // live paths.
  writeConfig,
  loadStore: loadStoreFn,
  loadToken,
  spawnZcodeCli,
  resolveExecutable = resolveZcodeCliExecutable,
  resolveBuiltinConfig = resolveZcodeCliBuiltinConfig,
  log = () => {},
  base = process.env,
  zcodeArgs = [],
  probeRelay: probeRelayFn = async () => false,
}) {
  for (const [name, dep] of Object.entries({
    startRelay,
    writeConfig,
    loadStore: loadStoreFn,
    loadToken,
    spawnZcodeCli,
  })) {
    if (typeof dep !== "function") {
      throw new TypeError(`runZcodeCliLauncher requires ${name} to be a function`);
    }
  }

  // 入口与 builtin 配置的解析放在 relay 获取之前：两者缺一个都必须拒绝启动
  // （没有 builtin 指向的启动会把缓存物化进桌面版数据根），也避免为一场注定
  // 失败的启动白占 47821。
  const entry = resolveExecutable(base);
  if (entry === null || entry === undefined) {
    throw new Error(
      `zcode CLI not found at the default build path (${defaultZcodeCliExecutable(base)}); ` +
        `set ZCODE_CLI_EXECUTABLE to the absolute path of the CLI's bin\\zcode.mjs`,
    );
  }
  const builtinConfigPath = resolveBuiltinConfig(entry);

  // Two-level relay acquisition (probe resident → start per-launch), then a
  // native fallback: when both levels fail, relay is null and the CLI launches
  // on its own configuration below instead of the launch being refused.
  const relay = await acquireRelayOrNative({
    endpoint: "zcode-cli",
    port: RELAY_PORT,
    log,
    probeRelay: probeRelayFn,
    // The resident relay outlives this launch, so the reuse handle closes as a
    // no-op; only a per-launch relay we started gets torn down.
    residentRelay: async () => ({
      port: RELAY_PORT,
      token: loadToken(relayDataRoot(base)),
      close: async () => {},
      reused: true,
    }),
    startRelay,
  });

  try {
    // 启动前同步独立槽位配置：失败只记日志，从不阻断启动（CLI 拿着旧配置也
    // 能跑）。Native mode syncs against the well-known port too, so the managed
    // entries revive with the resident relay; the token then comes from the
    // shared token file, and an unreadable token only skips the sync.
    try {
      const loaded = loadStoreFn();
      if (!loaded.ok) {
        log("warning: Anyswitch store could not be read; zcode CLI provider config not updated");
      } else {
        const syncToken = relay
          ? relay.token
          : loadNativeSyncToken({ loadToken, root: relayDataRoot(base), endpoint: "zcode-cli", log });
        if (syncToken) {
          const result = await writeConfig(loaded.store, relay ? relay.port : RELAY_PORT, syncToken, zcodeCliDataDir(base));
          if (!result.ok) {
            log(`warning: zcode CLI provider config not updated: ${result.reason ?? "unknown error"}`);
          } else if (!result.unchanged) {
            log(`zcode CLI provider config updated (backup: ${result.backupPath ?? "none"})`);
          }
        }
      }
    } catch (syncError) {
      log(`warning: zcode CLI provider config sync failed: ${syncError.message}`);
    }

    const env = relay
      ? buildZcodeCliLauncherEnv({ base, personalConfigPath: zcodeCliProviderConfigPath(base), builtinConfigPath })
      : buildZcodeCliNativeEnv({ base, builtinConfigPath });
    return await spawnZcodeCli({ env, args: zcodeArgs, entry });
  } finally {
    // A reused resident relay's close is a no-op; only a per-launch relay dies
    // here. Native mode (relay === null) has nothing to close.
    await relay?.close();
  }
}

export function realSpawnZcodeCli({ env, args, entry, spawnFn = spawn, nodeExe = process.execPath }) {
  return new Promise((resolvePromise, reject) => {
    // Windows 无法直接执行 .mjs——以 node 拉起 CLI 入口，参数原样透传（无参进
    // TUI；-p 单次执行；app-server 是 stdio 协议服务）。
    const child = spawnFn(nodeExe, [entry, ...args], {
      env,
      stdio: "inherit",
      shell: false,
      windowsHide: false,
    });
    child.on("error", reject);
    // 存活检测就是子进程句柄本身：exit 事件即会话结束，不碰 tasklist ZCode.exe
    // 那套映像名检测（CLI 是 node 进程，映像名检测既找不到它也找不准它）。
    child.on("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
  });
}

export async function main(argv = process.argv.slice(2)) {
  const code = await runZcodeCliLauncher({
    startRelay: () => startOpenAIRelay(),
    writeConfig: (store, port, token, slotRoot) => writeZcodeCliConfig(store, port, token, slotRoot),
    loadStore,
    loadToken: (root) => loadOrGenerateToken(root),
    spawnZcodeCli: realSpawnZcodeCli,
    log: (line) => process.stderr.write(`${line}\n`),
    zcodeArgs: argv,
    probeRelay: probeRelay,
  });
  return code;
}

function isEntryModule(argv1, metaUrl, realpath = realpathSync) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  const norm = (p) => {
    try {
      return realpath(p);
    } catch {
      return p;
    }
  };
  try {
    return norm(fileURLToPath(metaUrl)) === norm(argv1);
  } catch {
    return false;
  }
}

if (isEntryModule(process.argv[1], import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`zcode cli launcher failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
