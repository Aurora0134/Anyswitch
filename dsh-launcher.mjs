import { spawn } from "node:child_process";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync, existsSync } from "node:fs";
import { createOpenAIRelayServer, listenLoopback, probeRelay, DEFAULT_RELAY_PORT } from "./openai-server.mjs";
import { createProductionDeps } from "./launch.mjs";
import { loadStore, storePaths } from "./store-io.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { createLogger } from "./logger.mjs";
import { createPanelRouter } from "./panel.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";
import { createUsageJournal } from "./usage-journal.mjs";
import {
  readDshSettings,
  mergeDshSettings,
  writeDshSettingsWithBackup,
  extractManagedProviders,
  deriveAutoRouteChannel,
  readSidecar,
  writeSidecar,
  validateDshSettings,
  getYamlModule,
} from "./dsh-merge-config.mjs";
import { loadPiAiReasoningIndex } from "./reasoning-fallback.mjs";

export function dshSettingsPath(base = process.env) {
  return join(base.DSH_HOME ?? join(base.USERPROFILE ?? "", ".dsh"), "settings.yaml");
}

const DSH_SETTINGS_PATH = dshSettingsPath();

export const RELAY_PORT = DEFAULT_RELAY_PORT;

function relayDataRoot(base = process.env) {
  return join(base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"), "ApiCred");
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
    throw new Error("the Anyswitch global store is not usable; refusing to start the dsh relay");
  }
  const server = createOpenAIRelayServer(deps);
  const { port, reused, close } = await listenLoopback(server, RELAY_PORT);
  return { port, token: deps.token, close, reused };
}

export function dshPackageRoot(base = process.env) {
  return join(
    base.APPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Roaming"),
    "npm",
    "node_modules",
    "@deepseek-ai",
    "dsh",
  );
}

export async function writeDshConfig(store, port, sidecarRoot, settingsPath = DSH_SETTINGS_PATH) {
  const yaml = await getYamlModule();
  const managedProviders = extractManagedProviders(store);
  const autoChannel = deriveAutoRouteChannel(store, "dsh");
  if (Object.keys(managedProviders).length === 0 && !autoChannel) {
    return { ok: true, unchanged: true, reason: "no Anyswitch providers with models" };
  }
  const previousManaged = readSidecar(sidecarRoot).providers;
  let existing;
  try {
    existing = readDshSettings(settingsPath, yaml);
  } catch (error) {
    if (error?.code === "UNPARSEABLE_DSH_SETTINGS") {
      return { ok: false, unchanged: true, reason: error.message };
    }
    throw error;
  }
  // The pi-ai database shipped inside the installed DSH package is the
  // reasoning-effort knowledge source for models whose upstream /v1/models
  // listing discloses nothing. Empty (and skipped) when DSH is not installed.
  const knowledge = loadPiAiReasoningIndex(dshPackageRoot());
  const { config, managed } = mergeDshSettings(existing, managedProviders, port, previousManaged, knowledge, autoChannel);

  const gate = validateDshSettings(config);
  if (!gate.valid) {
    return { ok: false, unchanged: true, reason: `dsh settings.yaml would be invalid: ${gate.error}` };
  }

  const writeResult = writeDshSettingsWithBackup(settingsPath, config, yaml);
  if (writeResult.ok) {
    writeSidecar(sidecarRoot, managed);
  }
  return writeResult;
}

export function resolveDshExecutable(base = process.env) {
  const override = base.DSH_EXECUTABLE;
  if (override !== undefined && override !== null && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error(
        `DSH_EXECUTABLE must be an absolute path, got "${override}". ` +
          `A bare name or relative path could resolve back to the Anyswitch shim and ` +
          `make the launcher recurse into itself.`,
      );
    }
    return override;
  }
  // Windows npm global dsh executable
  const roamingNpm = join(
    base.APPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Roaming"),
    "npm",
  );
  const cmdPath = join(roamingNpm, "dsh.cmd");
  if (existsSync(cmdPath)) return cmdPath;
  // Deliberately skip dsh.ps1: realSpawnDsh only wraps .cmd in comspec /c,
  // and Windows cannot execute a .ps1 file directly — returning it would
  // guarantee an error event on spawn. Fall through to the extensionless
  // shim instead.
  return join(roamingNpm, "dsh");
}

export function buildDshLauncherEnv({ port, token, base = {} }) {
  const env = { ...base };
  env.ANYSWITCH_RELAY_TOKEN = token;
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = "127.0.0.1,localhost";
  return env;
}

export async function runDshLauncher({
  startRelay,
  writeConfig,
  spawnDsh,
  log = () => {},
  base = process.env,
  dshArgs = [],
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
    log(`probe failed (${error.message}); falling back to per-launch relay`);
    relay = await startRelay();
  }

  try {
    const loaded = loadStore();
    if (!loaded.ok) {
      log("warning: Anyswitch store could not be read; dsh settings not updated");
    } else {
      const sidecarRoot = relayDataRoot(base);
      const writeResult = await writeConfig(loaded.store, relay.port, sidecarRoot);
      if (!writeResult.ok) {
        log(`warning: dsh settings.yaml not updated: ${writeResult.reason ?? "unknown error"}`);
      } else if (!writeResult.unchanged) {
        log(`dsh settings.yaml updated (backup: ${writeResult.backupPath ?? "none"})`);
      }
    }

    const env = buildDshLauncherEnv({ port: relay.port, token: relay.token, base });
    return await spawnDsh({ env, args: dshArgs });
  } finally {
    await relay.close();
  }
}

function realSpawnDsh({ env, args }) {
  return new Promise((resolve, reject) => {
    const exe = resolveDshExecutable(env);
    const isCmd = exe.toLowerCase().endsWith(".cmd");
    const comspec = process.env.COMSPEC || "cmd.exe";

    const child = isCmd
      ? spawn(comspec, ["/d", "/c", exe, ...args], {
          env,
          stdio: "inherit",
          shell: false,
          windowsHide: false,
        })
      : spawn(exe, args, {
          env,
          stdio: "inherit",
          shell: false,
          windowsHide: false,
        });

    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export async function main(argv = process.argv.slice(2)) {
  const code = await runDshLauncher({
    startRelay: () => startOpenAIRelay(),
    writeConfig: (store, port, sidecarRoot) => writeDshConfig(store, port, sidecarRoot),
    spawnDsh: realSpawnDsh,
    log: (line) => process.stderr.write(`${line}\n`),
    dshArgs: argv,
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
      process.stderr.write(`dsh launcher failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
