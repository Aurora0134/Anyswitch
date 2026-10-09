import { spawn } from "node:child_process";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync, existsSync, readFileSync } from "node:fs";
import { createOpenAIRelayServer, listenLoopback, probeRelay, DEFAULT_RELAY_PORT } from "./openai-server.mjs";
import { createProductionDeps } from "./launch.mjs";
import { loadStore, storePaths } from "./store-io.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { createLogger } from "./logger.mjs";
import { createPanelRouter } from "./panel.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";
import { createUsageJournal } from "./usage-journal.mjs";
import {
  readZcodeConfig,
  mergeZcodeConfig,
  writeZcodeConfigWithBackup,
  extractManagedProviders,
  deriveAnyswitchChannel,
  readSidecar,
  writeSidecar,
  validateZcodeConfig,
  zcodeCliSlotDir,
  zcodeCliSidecarPath,
} from "./zcode-merge-config.mjs";
// CLI 槽位常量/路径 helper 住在 zcode-merge-config.mjs（两个 launcher 共用），
// 这里 re-export 保持既有 import 面不变。
export { ZCODE_CLI_SLOT_DIRNAME, ZCODE_CLI_SIDECAR_FILENAME, zcodeCliSlotDir, zcodeCliSidecarPath } from "./zcode-merge-config.mjs";
import { catalogForRoot, effortSupplementEnabled } from "./effort-catalog.mjs";
import { syncZcodePersonalConfig, defaultCliModelSelection, PERSONAL_CONFIG_FILENAME } from "./zcode-personal-config.mjs";
import { readSidecar as readSidecarFile, writeSidecar as writeSidecarFile } from "./merge-common.mjs";
import { acquireRelayOrNative, buildNativeLauncherEnv, loadNativeSyncToken } from "./launcher-native-fallback.mjs";

export function zcodeConfigPath(base = process.env) {
  return join(base.USERPROFILE ?? "", ".zcode", "v2", "config.json");
}

const ZCODE_CONFIG_PATH = zcodeConfigPath();

export const RELAY_PORT = DEFAULT_RELAY_PORT;

function relayDataRoot(base = process.env) {
  return join(base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"), "Anyswitch");
}

function createOpenAIProductionDeps(options = {}) {
  const paths = options.paths ?? storePaths();
  const claudeDeps = createProductionDeps({ paths });
  const root = relayDataRoot(options.base ?? process.env);
  const logger = options.logger ?? createLogger();
  // Usage journal (same dir as the resident relay) so fallback-relay traffic
  // still lands in the stats journal when the resident relay is down.
  let usageJournal = null;
  try {
    usageJournal = createUsageJournal({ dir: join(root, "usage") });
  } catch { usageJournal = null; }
  const metricsCollector = options.metricsCollector ?? createAgentMetricsCollector({ journal: usageJournal });
  return {
    token: loadOrGenerateToken(root),
    loadStore: claudeDeps.loadStore,
    loadCredential: claudeDeps.loadCredential,
    buildUpstreamURLs: claudeDeps.buildUpstreamURLs,
    upstreamFetch: claudeDeps.upstreamFetch,
    recordGeneration: claudeDeps.recordGeneration,
    readGeneration: claudeDeps.readGeneration,
    effortInjector: claudeDeps.effortInjector,
    panelRouter: createPanelRouter({ storePaths: paths, logger, metricsCollector }),
    metricsCollector,
    logger,
  };
}

export async function startOpenAIRelay(options = {}) {
  const deps = createOpenAIProductionDeps(options);
  const probe = deps.loadStore();
  if (!probe.ok) {
    throw new Error("the Anyswitch global store is not usable; refusing to start the zcode relay");
  }
  const server = createOpenAIRelayServer(deps);
  const { port, reused, close } = await listenLoopback(server, RELAY_PORT);
  return { port, token: deps.token, close, reused };
}

export async function writeZcodeConfig(store, port, token, sidecarRoot, configPath = ZCODE_CONFIG_PATH, catalog = catalogForRoot(sidecarRoot), effortsEnabled = null, cliSlot = {}) {
  const managedProviders = extractManagedProviders(store);
  const autoChannel = deriveAnyswitchChannel(store, "zcode");
  // Last channel deleted: what the previous sync wrote into the client config
  // is only recorded in the sidecar, so an empty previous managed set is what
  // makes bailing out safe — otherwise the merge has to run to drop the stale
  // entries instead of leaving them behind forever.
  // CLI 槽位的 sidecar 一并参与早退判定：上一轮 CLI 同步失败（锁占用等）会留
  // 下「桌面版 sidecar 已清空、CLI sidecar 仍记着托管渠道」的分歧，此时早退会
  // 把 CLI 槽位的残留条目永久留下。
  const previousManaged = readSidecar(sidecarRoot).providers;
  const cliPreviousManaged = readSidecarFile(zcodeCliSidecarPath(sidecarRoot)).providers;
  if (
    Object.keys(managedProviders).length === 0 &&
    !autoChannel &&
    previousManaged.length === 0 &&
    cliPreviousManaged.length === 0
  ) {
    return { ok: true, unchanged: true, reason: "no Anyswitch providers with models" };
  }
  // With 「注入推理强度」 off no level declaration is written at all: the merge
  // rebuilds every managed entry wholesale, so an absent catalog also strips
  // the levels a previous sync wrote — that is the switch's cleanup path.
  const effectiveCatalog = (effortsEnabled ?? effortSupplementEnabled(sidecarRoot)) ? catalog : null;
  let existing;
  try {
    existing = readZcodeConfig(configPath);
  } catch (error) {
    if (error?.code === "UNPARSEABLE_CONFIG") {
      return { ok: false, unchanged: true, reason: error.message };
    }
    throw error;
  }
  const { config, managed } = mergeZcodeConfig(existing, managedProviders, port, token, previousManaged, autoChannel, effectiveCatalog);

  const gate = validateZcodeConfig(config);
  if (!gate.valid) {
    return { ok: false, unchanged: true, reason: `zcode config.json would be invalid: ${gate.error}` };
  }

  const writeResult = writeZcodeConfigWithBackup(configPath, config);
  if (!writeResult.ok) return writeResult;
  writeSidecar(sidecarRoot, managed);
  // config.json is only read by ZCode while its own provider_config.json is
  // still missing; once that file exists it becomes the list the client
  // renders, so a sync that stops at config.json changes nothing the user can
  // pick. Maintain the client-side list from the entries just written.
  const personalEntries = Object.fromEntries(managed.map((id) => [`_${id}`, config.provider[`_${id}`]]));
  const personal = syncZcodePersonalConfig({
    configPath,
    managedEntries: personalEntries,
    previousManaged: previousManaged.map((id) => `_${id}`),
  });
  if (!personal.ok) return { ...writeResult, ok: false, reason: personal.reason };
  // 桌面版两文件之外追加 CLI 独立槽位同步（zcode-cli\provider_config.json）。
  // CLI 是独立端点：它的失败只回报在 cli 分支，不拖垮桌面版的同步结论。
  let cli;
  try {
    cli = syncZcodeCliSlot({ sidecarRoot, managedEntries: personalEntries, managedIds: managed, ...cliSlot });
  } catch (error) {
    cli = { ok: false, skipped: false, unchanged: true, reason: error.message };
  }
  return { ...writeResult, personal, cli };
}

/* ---------- ZCode CLI 独立槽位同步 ---------- */

// 槽位目录与 sidecar 的定义在 zcode-merge-config.mjs（本文件顶部 re-export）。
// 槽位目录由 CLI launcher 的首次同步创建；目录不存在等价于「CLI 槽位从未启
// 用」，周期同步跳过不报错。
// CLI 槽位的 defaultModelSelection 需要一个经 CLI builtin 规则解析后合法的
// reasoningLevel，所以解析要用 CLI 自己随包的 zcode-builtin.json（launcher 把
// 同一份文件钉进 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE，CLI 不再走 CDN 刷新，
// 两边读到的是同一份规则）。定位与 zcode-cli-launcher.mjs 的
// resolveZcodeCliBuiltinConfig 同一布局：发行树 bin\zcode.mjs 的兄弟
// agent\provider\，再回落源码树的 config\provider\。找不到或解析失败都返回
// null，生成器随之走验收锚点回落（free-pool 首模型 + disabled）。
export function loadZcodeCliBuiltinModelRules(cliEntry, io = { existsSync, readFileSync }) {
  if (typeof cliEntry !== "string" || cliEntry.length === 0) return null;
  const entryDir = dirname(cliEntry);
  const candidates = [
    join(entryDir, "..", "agent", "provider", "zcode-builtin.json"),
    resolve(entryDir, "..", "..", "..", "..", "..", "config", "provider", "zcode-builtin.json"),
  ];
  for (const candidate of candidates) {
    try {
      if (!io.existsSync(candidate)) continue;
      const rules = JSON.parse(io.readFileSync(candidate, "utf8"))?.config?.modelConfigRules;
      if (rules && typeof rules === "object") return rules;
    } catch {
      // 坏文件按不可解析处理，尝试下一个候选。
    }
  }
  return null;
}

/**
 * One sync of the CLI slot's provider_config.json from the entries just written
 * to the desktop config.json. 跳过不报错的两种情形：槽位目录不存在（CLI 从未
 * 启用）、CLI 未安装（resolveExecutable 找不到执行体）。同步失败（锁占用、文
 * 件不可读、校验不过）返回 { ok: false }，文件保持原样。
 *
 * options 是测试注入口：base（环境）、io（existsSync/readFileSync）、
 * resolveExecutable、builtinModelRules（跳过文件定位直接给规则）、lockWaitMs。
 */
export function syncZcodeCliSlot({ sidecarRoot, managedEntries, managedIds, ...options }) {
  const io = { existsSync, readFileSync, ...(options.io ?? {}) };
  const slotDir = zcodeCliSlotDir(sidecarRoot);
  if (!io.existsSync(slotDir)) {
    return { ok: true, skipped: true, reason: "zcode CLI slot directory does not exist" };
  }
  const resolveExecutable =
    options.resolveExecutable ?? ((base) => resolveZcodeCliExecutable(base, { existsSync: io.existsSync }));
  const cliEntry = resolveExecutable(options.base ?? process.env);
  if (typeof cliEntry !== "string" || cliEntry.length === 0) {
    return { ok: true, skipped: true, reason: "zcode CLI is not installed" };
  }
  const sidecarPath = zcodeCliSidecarPath(sidecarRoot);
  const previousManaged = readSidecarFile(sidecarPath).providers;
  if (
    (managedIds?.length ?? 0) === 0 &&
    previousManaged.length === 0 &&
    !io.existsSync(join(slotDir, PERSONAL_CONFIG_FILENAME))
  ) {
    return { ok: true, skipped: true, reason: "no Anyswitch providers with models" };
  }
  const builtinModelRules =
    "builtinModelRules" in options ? options.builtinModelRules : loadZcodeCliBuiltinModelRules(cliEntry, io);
  const personal = syncZcodePersonalConfig({
    // syncZcodePersonalConfig 取 dirname(configPath) 落 provider_config.json，
    // configPath 只需落在槽位目录内。
    configPath: join(slotDir, "config.json"),
    managedEntries,
    previousManaged: previousManaged.map((id) => `_${id}`),
    defaultModelSelection: defaultCliModelSelection(managedEntries, builtinModelRules) ?? undefined,
    ...(options.lockWaitMs === undefined ? {} : { lockWaitMs: options.lockWaitMs }),
  });
  if (!personal.ok) return { ok: false, skipped: false, unchanged: true, reason: personal.reason };
  // 同步成功才更新 sidecar：失败时保留上一轮记忆，下一轮退役清理才认得出残留。
  writeSidecarFile(sidecarPath, managedIds ?? []);
  return { ok: true, skipped: false, unchanged: personal.unchanged, backupPath: personal.backupPath, path: personal.path };
}

import { resolveZcodeExecutable, resolveZcodeCliExecutable } from "./agent-discovery.mjs";
export { resolveZcodeExecutable };

export function buildZcodeLauncherEnv({ port, token, base = {} }) {
  const env = { ...base };
  env.ANYSWITCH_RELAY_TOKEN = token;
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = "127.0.0.1,localhost";
  return env;
}

export function killExistingZcode() {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/F", "/IM", "ZCode.exe"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runZcodeLauncher({
  startRelay,
  writeConfig,
  spawnZcode,
  isZcodeRunning: checkZcodeRunning,
  waitForZcodeExit: waitForZcodeExitFn,
  log = () => {},
  base = process.env,
  zcodeArgs = [],
  // When the resident relay host (relay-host.mjs) is already bound on 47821,
  // the per-launch path can skip starting its own relay and just reuse it:
  // writeConfig + spawn ZCode, with a no-op close so the resident host is not
  // torn down when ZCode exits. probeRelay defaults to "no" so the classic
  // per-launch behavior (and its tests) are unchanged unless a probe is wired.
  probeRelay: probeRelayFn = async () => false,
}) {
  // Two-level relay acquisition (probe resident → start per-launch), then a
  // native fallback: when both levels fail, relay is null and ZCode launches
  // on its own configuration below instead of the launch being refused.
  const relay = await acquireRelayOrNative({
    endpoint: "zcode",
    port: RELAY_PORT,
    log,
    probeRelay: probeRelayFn,
    // The resident relay outlives this launch, so the reuse handle closes as a
    // no-op; only a per-launch relay we started gets torn down.
    residentRelay: async () => ({
      port: RELAY_PORT,
      token: loadOrGenerateToken(relayDataRoot(base)),
      close: async () => {},
      reused: true,
    }),
    startRelay,
  });

  try {
    const loaded = loadStore();
    if (!loaded.ok) {
      log("warning: Anyswitch store could not be read; zcode config not updated");
    } else {
      // Native mode syncs against the well-known port too, so the managed
      // providers revive with the resident relay; the token then comes from
      // the shared token file, and an unreadable token only skips the sync.
      const syncToken = relay
        ? relay.token
        : loadNativeSyncToken({ loadToken: loadOrGenerateToken, root: relayDataRoot(base), endpoint: "zcode", log });
      if (syncToken) {
        const sidecarRoot = relayDataRoot(base);
        const writeResult = await writeConfig(loaded.store, relay ? relay.port : RELAY_PORT, syncToken, sidecarRoot);
        if (!writeResult.ok) {
          log(`warning: zcode config.json not updated: ${writeResult.reason ?? "unknown error"}`);
        } else if (!writeResult.unchanged) {
          log(`zcode config.json updated (backup: ${writeResult.backupPath ?? "none"})`);
        }
      }
    }

    const running = await checkZcodeRunning();
    if (running) {
      if (relay) {
        log("ZCode is already running; relay attached. Waiting for ZCode to exit...");
        // The launcher stays alive on purpose: a per-launch relay dies with
        // this process, and the running ZCode's managed entries point at it.
        await waitForZcodeExitFn();
      } else {
        // Native mode holds no relay for the already-running instance, so
        // there is nothing to babysit — leave ZCode running and exit.
        log("ZCode is already running; nothing to attach in native mode, exiting");
      }
      return 0;
    }

    // Relay mode injects ANYSWITCH_RELAY_TOKEN + NO_PROXY; native mode passes
    // the environment through verbatim so ZCode behaves exactly as if started
    // without Anyswitch.
    const env = relay
      ? buildZcodeLauncherEnv({ port: relay.port, token: relay.token, base })
      : buildNativeLauncherEnv({ base });
    return await spawnZcode({ env, args: zcodeArgs });
  } finally {
    // A reused resident relay's close is a no-op; only a per-launch relay dies
    // here. Native mode (relay === null) has nothing to close.
    await relay?.close();
  }
}

function realIsZcodeRunning() {
  return new Promise((resolve) => {
    try {
      const child = spawn("tasklist", ["/FI", "IMAGENAME eq ZCode.exe", "/NH"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
      });
      let out = "";
      child.stdout?.on("data", (c) => (out += c));
      child.on("error", () => resolve(false));
      child.on("close", () => resolve(/ZCode\.exe/i.test(out)));
    } catch {
      resolve(false);
    }
  });
}

async function realWaitForZcodeExit(intervalMs = 2000) {
  while (true) {
    const running = await realIsZcodeRunning();
    if (!running) return;
    await sleep(intervalMs);
  }
}

function realSpawnZcode({ env, args }) {
  return new Promise((resolve, reject) => {
    const exe = resolveZcodeExecutable(env);
    const child = spawn(exe, args, {
      env,
      stdio: "ignore",
      shell: false,
      windowsHide: false,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export async function main(argv = process.argv.slice(2)) {
  const code = await runZcodeLauncher({
    startRelay: () => startOpenAIRelay(),
    writeConfig: (store, port, token, sidecarRoot) => writeZcodeConfig(store, port, token, sidecarRoot),
    spawnZcode: realSpawnZcode,
    isZcodeRunning: realIsZcodeRunning,
    waitForZcodeExit: realWaitForZcodeExit,
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
      process.stderr.write(`zcode launcher failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
