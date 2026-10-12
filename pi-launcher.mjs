// pi launcher: starts the fallback OpenAI relay, syncs pi's models.json with
// the Anyswitch managed providers, retags them with this launch's instance id,
// then spawns the real pi CLI.
//
// models.json carries real values, not ${VAR} placeholders: the pi CLI expands
// $VAR/${VAR} in apiKey and header values and THROWS when the variable is
// missing, and its template syntax has no ${VAR:-default} form (pi-coding-agent
// dist/core/resolve-config-value.js), so a placeholder file makes every direct
// (launcher-bypassing) start crash at startup. Sync therefore writes the stable
// relay token and the static DIRECT_INSTANCE_ID (see pi-merge-models.mjs); the
// launcher retags the managed entries with its per-launch instance id right
// before spawn and restores the static values on exit (restore touches only
// entries still carrying this launch's tag, so concurrent launchers never
// clobber each other's restore). If the relay can be neither reused nor
// started, pi is launched with its on-disk configuration as-is.
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
  deriveAnyswitchChannel,
  readSidecar,
  writeSidecar,
  validatePiModelsConfig,
  tagManagedProvidersForLaunch,
  restoreManagedProvidersAfterLaunch,
} from "./pi-merge-models.mjs";
import { catalogForRoot, effortSupplementEnabled } from "./effort-catalog.mjs";

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
    effortInjector: claudeDeps.effortInjector,
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

export async function writePiModels(store, port, sidecarRoot, modelsPath = PI_MODELS_PATH, catalog = catalogForRoot(sidecarRoot), effortsEnabled = null) {
  const managedProviders = extractManagedProviders(store);
  const autoChannel = deriveAnyswitchChannel(store, "pi");
  // Last channel deleted: what the previous sync wrote into the client config
  // is only recorded in the sidecar, so an empty previous managed set is what
  // makes bailing out safe — otherwise the merge has to run to drop the stale
  // entries instead of leaving them behind forever.
  const previousManaged = readSidecar(sidecarRoot).providers;
  if (Object.keys(managedProviders).length === 0 && !autoChannel && previousManaged.length === 0) {
    return { ok: true, unchanged: true, reason: "no Anyswitch providers with models" };
  }
  // Switch off → no level declaration; the wholesale entry rebuild also
  // removes the thinkingLevelMap a previous sync wrote.
  const effectiveCatalog = (effortsEnabled ?? effortSupplementEnabled(sidecarRoot)) ? catalog : null;
  let existing;
  try {
    existing = readModelsJson(modelsPath);
  } catch (error) {
    if (error?.code === "UNPARSEABLE_MODELS") {
      return { ok: false, unchanged: true, reason: error.message };
    }
    throw error;
  }
  // The token landing on disk is the same stable per-install token the relay
  // (resident or fallback) requires: sidecarRoot IS the relay data root on
  // both call paths (this launcher and agent-sync). Derived here, after the
  // early bails, so a no-op sync never touches the token file.
  const token = loadOrGenerateToken(sidecarRoot);
  const { config, managed } = mergeModelsJson(existing, managedProviders, port, previousManaged, autoChannel, effectiveCatalog, token);

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

import { resolvePiExecutable } from "./agent-discovery.mjs";
export { resolvePiExecutable };

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
  // Legacy insurance: models.json now carries real values (see the header
  // comment), so pi never consults these variables — unless a placeholder
  // file written by an older version survived (e.g. this run's sync bailed),
  // in which case the injected variables keep pi's ${VAR} expansion from
  // throwing at startup.
  env.ANYSWITCH_RELAY_TOKEN = token;
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
  modelsPath = null,
}) {
  let relay;
  try {
    relay = await startRelay();
  } catch (error) {
    // Both relay acquisition levels failed (resident probe + own bind) —
    // launch pi with its on-disk configuration instead of failing the command
    // outright. No relay env rides along: pi behaves as a native install.
    log(`warning: Anyswitch relay unavailable (${error.message}); launching pi with its existing configuration`);
    return await spawnPi({ env: { ...base }, args: piArgs });
  }

  const instanceId = buildInstanceId();
  let tagged = false;
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

    // Per-launch instance tag onto the managed entries on disk (the static
    // values are what keep direct launches working). modelsPath stays null in
    // tests and library use so the real user config is never touched; main()
    // wires the real path.
    if (modelsPath) {
      const tag = tagManagedProvidersForLaunch(modelsPath, { token: relay.token, instanceId });
      tagged = tag.ok && tag.tagged.length > 0;
      if (!tag.ok) log(`warning: could not retag pi models.json for this launch: ${tag.reason}`);
    }

    const env = buildPiLauncherEnv({ port: relay.port, token: relay.token, instanceId, base });
    return await spawnPi({ env, args: piArgs });
  } finally {
    if (tagged) {
      const restore = restoreManagedProvidersAfterLaunch(modelsPath, { token: relay.token, instanceId });
      if (!restore.ok) log(`warning: could not restore pi models.json instance tags: ${restore.reason}`);
    }
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
    modelsPath: PI_MODELS_PATH,
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