import { spawn } from "node:child_process";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
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
  deriveAutoRouteChannel,
  readSidecar,
  writeSidecar,
  validateZcodeConfig,
} from "./zcode-merge-config.mjs";
import { catalogForRoot, effortSupplementEnabled } from "./effort-catalog.mjs";
import { syncZcodePersonalConfig } from "./zcode-personal-config.mjs";

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

export async function writeZcodeConfig(store, port, token, sidecarRoot, configPath = ZCODE_CONFIG_PATH, catalog = catalogForRoot(sidecarRoot), effortsEnabled = null) {
  const managedProviders = extractManagedProviders(store);
  const autoChannel = deriveAutoRouteChannel(store, "zcode");
  // Last channel deleted: what the previous sync wrote into the client config
  // is only recorded in the sidecar, so an empty previous managed set is what
  // makes bailing out safe — otherwise the merge has to run to drop the stale
  // entries instead of leaving them behind forever.
  const previousManaged = readSidecar(sidecarRoot).providers;
  if (Object.keys(managedProviders).length === 0 && !autoChannel && previousManaged.length === 0) {
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
  const personal = syncZcodePersonalConfig({
    configPath,
    managedEntries: Object.fromEntries(managed.map((id) => [`_${id}`, config.provider[`_${id}`]])),
    previousManaged: previousManaged.map((id) => `_${id}`),
  });
  if (!personal.ok) return { ...writeResult, ok: false, reason: personal.reason };
  return { ...writeResult, personal };
}

import { resolveZcodeExecutable } from "./agent-discovery.mjs";
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
  let relay;
  try {
    const reused = await probeRelayFn(RELAY_PORT);
    if (reused) {
      const token = loadOrGenerateToken(relayDataRoot(base));
      relay = { port: RELAY_PORT, token, close: async () => {}, reused: true };
      log(`resident relay already running on ${RELAY_PORT}; reusing, no spawn of a new relay`);
    } else {
      relay = await startRelay();
    }
  } catch (error) {
    // A probe failure must never block the launcher: fall back to the classic
    // per-launch relay start rather than trusting an ambiguous probe result.
    log(`probe failed (${error.message}); falling back to per-launch relay`);
    relay = await startRelay();
  }

  try {
    const loaded = loadStore();
    if (!loaded.ok) {
      log("warning: Anyswitch store could not be read; zcode config not updated");
    } else {
      const sidecarRoot = relayDataRoot(base);
      const writeResult = await writeConfig(loaded.store, relay.port, relay.token, sidecarRoot);
      if (!writeResult.ok) {
        log(`warning: zcode config.json not updated: ${writeResult.reason ?? "unknown error"}`);
      } else if (!writeResult.unchanged) {
        log(`zcode config.json updated (backup: ${writeResult.backupPath ?? "none"})`);
      }
    }

    const running = await checkZcodeRunning();
    if (running) {
      log("ZCode is already running; relay attached. Waiting for ZCode to exit...");
      await waitForZcodeExitFn();
      return 0;
    }

    const env = buildZcodeLauncherEnv({ port: relay.port, token: relay.token, base });
    return await spawnZcode({ env, args: zcodeArgs });
  } finally {
    await relay.close();
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
