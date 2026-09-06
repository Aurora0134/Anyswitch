// pi launcher: starts the fallback OpenAI relay, syncs pi's models.json with
// the Anyswitch managed providers, then spawns the real pi CLI.
//
// Instance-tagging coupling: managed providers in models.json carry a literal
// "${ANYSWITCH_INSTANCE_ID}" x-agent-instance header placeholder (see
// pi-merge-models.mjs). The pi CLI expands header placeholders via
// resolveHeadersOrThrow and THROWS when the env var is missing, so once
// models.json has been written, invoking pi directly (bypassing this launcher)
// fails at startup. That is accepted on purpose: the Anyswitch shim routes every
// `pi` command through this launcher (resolvePiExecutable's recursion guard
// documents the shim), and the launcher always sets ANYSWITCH_INSTANCE_ID in the
// spawned environment below.
import { spawn } from "node:child_process";
import { join, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { createOpenAIRelayServer, listenLoopback, DEFAULT_RELAY_PORT } from "./openai-server.mjs";
import { createProductionDeps } from "./launch.mjs";
import { loadStore } from "./store-io.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { createAgentMetricsCollector, INSTANCE_ID_MAX_LEN } from "./agent-metrics.mjs";
import { createUsageJournal } from "./usage-journal.mjs";
import {
  readModelsJson,
  mergeModelsJson,
  writeModelsJsonWithBackup,
  extractManagedProviders,
  deriveAutoRouteChannel,
  readSidecar,
  writeSidecar,
  validatePiModelsConfig,
} from "./pi-merge-models.mjs";

export function piModelsPath(base = process.env) {
  return join(base.USERPROFILE ?? "", ".pi", "agent", "models.json");
}

const PI_MODELS_PATH = piModelsPath();

export const RELAY_PORT = DEFAULT_RELAY_PORT;

function relayDataRoot(base = process.env) {
  return join(base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"), "Anyswitch");
}

function createOpenAIProductionDeps(options = {}) {
  const claudeDeps = createProductionDeps(options);
  // Fallback-relay metrics + usage journal (same dir as the resident relay):
  // without these, traffic served while the resident relay is down would be
  // missing from the panel and the stats journal entirely.
  let usageJournal = null;
  try {
    usageJournal = createUsageJournal({ dir: join(relayDataRoot(options.base ?? process.env), "usage") });
  } catch { usageJournal = null; }
  const metricsCollector = createAgentMetricsCollector({ journal: usageJournal });
  return {
    token: loadOrGenerateToken(relayDataRoot(options.base ?? process.env)),
    loadStore: claudeDeps.loadStore,
    loadCredential: claudeDeps.loadCredential,
    buildUpstreamURLs: claudeDeps.buildUpstreamURLs,
    upstreamFetch: claudeDeps.upstreamFetch,
    recordGeneration: claudeDeps.recordGeneration,
    readGeneration: claudeDeps.readGeneration,
    metricsCollector,
  };
}

export async function startOpenAIRelay(options = {}) {
  const deps = createOpenAIProductionDeps(options);
  const probe = deps.loadStore();
  if (!probe.ok) {
    throw new Error("the Anyswitch global store is not usable; refusing to start the pi relay");
  }
  const server = createOpenAIRelayServer(deps);
  const { port, reused, close } = await listenLoopback(server, RELAY_PORT);
  return { port, token: deps.token, close, reused };
}

export async function writePiModels(store, port, sidecarRoot, modelsPath = PI_MODELS_PATH) {
  const managedProviders = extractManagedProviders(store);
  const autoChannel = deriveAutoRouteChannel(store, "pi");
  if (Object.keys(managedProviders).length === 0 && !autoChannel) {
    return { ok: true, unchanged: true, reason: "no Anyswitch providers with models" };
  }
  const previousManaged = readSidecar(sidecarRoot).providers;
  let existing;
  try {
    existing = readModelsJson(modelsPath);
  } catch (error) {
    if (error?.code === "UNPARSEABLE_MODELS") {
      return { ok: false, unchanged: true, reason: error.message };
    }
    throw error;
  }
  const { config, managed } = mergeModelsJson(existing, managedProviders, port, previousManaged, autoChannel);

  const gate = validatePiModelsConfig(config);
  if (!gate.valid) {
    return { ok: false, unchanged: true, reason: `pi models.json would be invalid: ${gate.error}` };
  }

  const writeResult = writeModelsJsonWithBackup(modelsPath, config);
  if (writeResult.ok) {
    writeSidecar(sidecarRoot, managed);
  }
  return writeResult;
}

export function resolvePiExecutable(base = process.env) {
  const override = base.PI_EXECUTABLE;
  if (override === undefined || override === null || override === "") {
    return join(
      base.APPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Roaming"),
      "npm",
      "pi.cmd",
    );
  }
  if (!isAbsolute(override)) {
    throw new Error(
      `PI_EXECUTABLE must be an absolute path, got "${override}". ` +
        `A bare name or relative path could resolve back to the Anyswitch shim and ` +
        `make the launcher recurse into itself.`,
    );
  }
  return override;
}

// Per-instance id, shared scheme across all four endpoints:
// "<cwd basename>-<launcher pid>". The basename is charset-cleaned to the
// relay's instance-id whitelist (off-whitelist chars become "-") and the total
// is capped at INSTANCE_ID_MAX_LEN; an empty basename falls back to
// "<endpoint>-<pid>". The launcher process maps 1:1 to a client instance — the
// child's pid is unknowable before spawn, so the launcher's own pid is used.
export function buildInstanceId({ cwd = process.cwd(), pid = process.pid, endpoint = "pi" } = {}) {
  const base = basename(cwd).replace(/[^A-Za-z0-9._:-]/g, "-");
  return `${base || endpoint}-${pid}`.slice(0, INSTANCE_ID_MAX_LEN);
}

export function buildPiLauncherEnv({ port, token, instanceId = buildInstanceId(), base = {} }) {
  const env = { ...base };
  env.ANYSWITCH_RELAY_TOKEN = token;
  // Consumed by the pi CLI's ${VAR} expansion of the x-agent-instance header
  // placeholder that mergeModelsJson writes into models.json.
  env.ANYSWITCH_INSTANCE_ID = instanceId;
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = "127.0.0.1,localhost";
  return env;
}

export async function runPiLauncher({
  startRelay,
  writeModels,
  spawnPi,
  log = () => {},
  base = process.env,
  piArgs = [],
}) {
  const relay = await startRelay();

  try {
    const loaded = loadStore();
    if (!loaded.ok) {
      log("warning: Anyswitch store could not be read; pi models not updated");
    } else {
      const sidecarRoot = relayDataRoot(base);
      const writeResult = await writeModels(loaded.store, relay.port, sidecarRoot);
      if (!writeResult.ok) {
        log(`warning: pi models.json not updated: ${writeResult.reason ?? "unknown error"}`);
      } else if (!writeResult.unchanged) {
        log(`pi models.json updated (backup: ${writeResult.backupPath ?? "none"})`);
      }
    }

    const env = buildPiLauncherEnv({ port: relay.port, token: relay.token, instanceId: buildInstanceId(), base });
    return await spawnPi({ env, args: piArgs });
  } finally {
    await relay.close();
  }
}

function realGetPiVersion() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolvePiExecutable(), ["--version"], { shell: false, windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    child.stdout?.on("data", (c) => (out += c));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(out.trim() || null));
  });
}

function realSpawnPi({ env, args }) {
  return new Promise((resolve, reject) => {
    const comspec = process.env.COMSPEC || "cmd.exe";
    const child = spawn(comspec, ["/d", "/c", resolvePiExecutable(), ...args], {
      env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export async function main(argv = process.argv.slice(2)) {
  const code = await runPiLauncher({
    startRelay: () => startOpenAIRelay(),
    writeModels: (store, port, sidecarRoot) => writePiModels(store, port, sidecarRoot),
    spawnPi: realSpawnPi,
    log: (line) => process.stderr.write(`${line}\n`),
    piArgs: argv,
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
      process.stderr.write(`pi launcher failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}