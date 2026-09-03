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
  extractApiCredProviders,
  deriveAutoRouteChannel,
  mergeReasonixConfigToml,
  readReasonixConfigToml,
  writeReasonixConfigTomlWithBackup,
  writeReasonixEnvWithBackup,
  reasonixEnvPathFromConfig,
  writeSidecar,
} from "./reasonix-merge-config.mjs";

export const RELAY_PORT = DEFAULT_RELAY_PORT;

function apiCredRoot(base = process.env) {
  return join(base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"), "ApiCred");
}

export function reasonixConfigPath(base = process.env) {
  return join(
    base.APPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Roaming"),
    "reasonix",
    "config.toml",
  );
}

export async function writeReasonixConfig(store, port, token, sidecarRoot, configPath = reasonixConfigPath()) {
  const apiCredProviders = extractApiCredProviders(store);
  const autoChannel = deriveAutoRouteChannel(store, "reasonix");
  if (Object.keys(apiCredProviders).length === 0 && !autoChannel) {
    return { ok: true, unchanged: true, reason: "no ApiCred providers with models" };
  }
  let existing;
  try {
    existing = readReasonixConfigToml(configPath);
  } catch (error) {
    return { ok: false, unchanged: true, reason: error.message };
  }
  let merged;
  try {
    merged = mergeReasonixConfigToml(existing, apiCredProviders, port, autoChannel);
  } catch (error) {
    if (error?.code === "UNPARSEABLE_REASONIX_CONFIG") {
      return { ok: false, unchanged: true, reason: error.message };
    }
    throw error;
  }
  const writeResult = writeReasonixConfigTomlWithBackup(configPath, merged.text);
  const envResult = writeReasonixEnvWithBackup(reasonixEnvPathFromConfig(configPath), token);
  if (writeResult.ok) {
    writeSidecar(sidecarRoot, merged.managed);
  }
  return {
    ok: writeResult.ok && envResult.ok,
    unchanged: Boolean(writeResult.unchanged && envResult.unchanged),
    backupPath: writeResult.backupPath,
    envBackupPath: envResult.backupPath,
    reason: writeResult.reason,
  };
}

export async function syncReasonixFromStore({ store, port, token, root, configPath }) {
  const loaded = store ?? loadStore().store;
  return writeReasonixConfig(loaded, port, token, root, configPath);
}

function createOpenAIProductionDeps(options = {}) {
  const paths = options.paths ?? storePaths();
  const claudeDeps = createProductionDeps({ paths });
  const root = apiCredRoot(options.base ?? process.env);
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
    throw new Error("the ApiCred global store is not usable; refusing to start the reasonix relay");
  }
  const server = createOpenAIRelayServer(deps);
  const { port, reused, close } = await listenLoopback(server, RELAY_PORT);
  return { port, token: deps.token, close, reused };
}

export function resolveReasonixExecutable(base = process.env) {
  const override = base.REASONIX_EXECUTABLE;
  if (override !== undefined && override !== null && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error(
        `REASONIX_EXECUTABLE must be an absolute path, got "${override}". ` +
          `A bare name or relative path could resolve back to the apicred shim and ` +
          `make the launcher recurse into itself.`,
      );
    }
    return override;
  }
  // Reasonix desktop installer layout: %LOCALAPPDATA%\Programs\Reasonix\
  const installDir = join(
    base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"),
    "Programs",
    "Reasonix",
  );
  const cliPath = join(installDir, "reasonix-cli.exe");
  if (existsSync(cliPath)) return cliPath;
  const desktopPath = join(installDir, "Reasonix.exe");
  if (existsSync(desktopPath)) return desktopPath;
  return cliPath;
}

export function buildReasonixLauncherEnv({ port, token, base = {} }) {
  const env = { ...base };
  env.APICRED_RELAY_TOKEN = token;
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = "127.0.0.1,localhost";
  return env;
}

export async function runReasonixLauncher({
  startRelay,
  writeConfig,
  spawnReasonix,
  log = () => {},
  base = process.env,
  reasonixArgs = [],
  probeRelay: probeRelayFn = async () => false,
}) {
  let relay;
  try {
    const reused = await probeRelayFn(RELAY_PORT);
    if (reused) {
      const token = loadOrGenerateToken(apiCredRoot(base));
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
      log("warning: ApiCred store could not be read; reasonix config not updated");
    } else {
      const sidecarRoot = apiCredRoot(base);
      const writeResult = await writeConfig(loaded.store, relay.port, relay.token, sidecarRoot);
      if (!writeResult.ok) {
        log(`warning: reasonix config.toml not updated: ${writeResult.reason ?? "unknown error"}`);
      } else if (!writeResult.unchanged) {
        log(`reasonix config.toml updated (backup: ${writeResult.backupPath ?? "none"})`);
      }
    }

    const env = buildReasonixLauncherEnv({ port: relay.port, token: relay.token, base });
    return await spawnReasonix({ env, args: reasonixArgs });
  } finally {
    await relay.close();
  }
}

function realSpawnReasonix({ env, args }) {
  return new Promise((resolve, reject) => {
    const exe = resolveReasonixExecutable(env);
    const child = spawn(exe, args, {
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
  const code = await runReasonixLauncher({
    startRelay: () => startOpenAIRelay(),
    writeConfig: (store, port, token, sidecarRoot) =>
      syncReasonixFromStore({ store, port, token, root: sidecarRoot }),
    spawnReasonix: realSpawnReasonix,
    log: (line) => process.stderr.write(`${line}\n`),
    reasonixArgs: argv,
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
      process.stderr.write(`reasonix launcher failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
