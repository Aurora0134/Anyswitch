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

export async function writeZcodeConfig(store, port, token, sidecarRoot, configPath = ZCODE_CONFIG_PATH) {
  const managedProviders = extractManagedProviders(store);
  const autoChannel = deriveAutoRouteChannel(store, "zcode");
  if (Object.keys(managedProviders).length === 0 && !autoChannel) {
    return { ok: true, unchanged: true, reason: "no Anyswitch providers with models" };
  }
  const previousManaged = readSidecar(sidecarRoot).providers;
  let existing;
  try {
    existing = readZcodeConfig(configPath);
  } catch (error) {
    if (error?.code === "UNPARSEABLE_CONFIG") {
      return { ok: false, unchanged: true, reason: error.message };
    }
    throw error;
  }
  const { config, managed } = mergeZcodeConfig(existing, managedProviders, port, token, previousManaged, autoChannel);

  const gate = validateZcodeConfig(config);
  if (!gate.valid) {
    return { ok: false, unchanged: true, reason: `zcode config.json would be invalid: ${gate.error}` };
  }

  const writeResult = writeZcodeConfigWithBackup(configPath, config);
  if (writeResult.ok) {
    writeSidecar(sidecarRoot, managed);
  }
  return writeResult;
}

export function resolveZcodeExecutable(base = process.env) {
  const override = base.ZCODE_EXECUTABLE;
  if (override === undefined || override === null || override === "") {
    // ZCode 通常作为 Electron 应用安装在 LocalAppData
    return join(
      base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"),
      "Programs",
      "zcode",
      "ZCode.exe",
    );
  }
  if (!isAbsolute(override)) {
    throw new Error(
      `ZCODE_EXECUTABLE must be an absolute path, got "${override}". ` +
        `A bare name or relative path could resolve back to the Anyswitch shim and ` +
        `make the launcher recurse into itself.`,
    );
  }
  return override;
}

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
