// Qoder launcher — spawns the Qoder CLI through its qoder.cmd dispatcher with
// the Anyswitch relay token in the child environment.
//
// Qoder's BYOK (custom provider) is configured via settings.json
// modelConfigs.customModels — a JSON array of model entries. Before spawning,
// the launcher syncs the Anyswitch store into that array so Qoder picks up
// the current providers/models without manual configuration.
// The integration is:
//   1. reuse the resident relay on 47821 when it is already serving (probe),
//      otherwise start a per-launch OpenAI relay against the real v2 store;
//   2. write the BYOK config into ~/.qoder/settings.json (via qoder-merge-config);
//   3. spawn the qoder.cmd dispatcher (COMSPEC /d /c, like the other .cmd
//      CLIs) with ANYSWITCH_RELAY_TOKEN injected via process-level env vars
//      only — never written to disk;
//   4. tear the per-launch relay down when Qoder exits, so nothing leaks.
// Qoder-side endpoint overrides ride the QODER_BIG_MODEL_ENDPOINT /
// QODER_OPENAPI_ENDPOINT env vars the CLI itself reads (inherited verbatim
// from the caller's environment — the launcher never invents values for them).

import { spawn } from "node:child_process";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync, existsSync } from "node:fs";
import { createOpenAIRelayServer, listenLoopback, probeRelay, DEFAULT_RELAY_PORT } from "./openai-server.mjs";
import { createProductionDeps } from "./launch.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";
import { createUsageJournal } from "./usage-journal.mjs";
import { loadStore } from "./store-io.mjs";
import { writeQoderConfig, qoderSettingsPath } from "./qoder-merge-config.mjs";
import { refreshQoderModelCatalog, QODER_CDP_PORT } from "./qoder-cdp-refresh.mjs";

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
  const metricsCollector = options.metricsCollector ?? createAgentMetricsCollector({ journal: usageJournal });
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
    throw new Error("the Anyswitch global store is not usable; refusing to start the qoder relay");
  }
  const server = createOpenAIRelayServer(deps);
  const { port, reused, close } = await listenLoopback(server, RELAY_PORT);
  return { port, token: deps.token, close, reused };
}

// Qoder's qoder.cmd dispatcher lives under ~/.qoder/entry and resolves the
// CLI itself (QODER_CLI_BIN → `qodercli` on PATH → ~/.qoder/bin/qodercli/
// qodercli.exe), so pointing the launcher at the dispatcher keeps that
// resolution in one place. The direct CLI path is only the fallback for
// entry-dir-less layouts.
export function resolveQoderExecutable(base = process.env) {
  const override = base.QODER_EXECUTABLE;
  if (override !== undefined && override !== null && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error(
        `QODER_EXECUTABLE must be an absolute path, got "${override}". ` +
          `A bare name or relative path could resolve back to the Anyswitch shim and ` +
          `make the launcher recurse into itself.`,
      );
    }
    return override;
  }
  const home = base.USERPROFILE ?? "";
  const entryPath = join(home, ".qoder", "entry", "qoder.cmd");
  if (existsSync(entryPath)) return entryPath;
  return join(home, ".qoder", "bin", "qodercli", "qodercli.exe");
}

export function buildQoderLauncherEnv({ token, base = {} }) {
  const env = { ...base };
  env.ANYSWITCH_RELAY_TOKEN = token;
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = "127.0.0.1,localhost";
  return env;
}

export async function runQoderLauncher({
  startRelay,
  spawnQoder,
  // writeConfig / loadStore / loadToken / refreshCatalog are the only doors this
  // function has to the user's machine (settings.json, the shared relay token
  // file, Qoder's CDP port). They deliberately have no defaults: main() wires
  // the real implementations and a test that forgets one crashes instead of
  // silently writing through to the live paths.
  writeConfig,
  loadStore: loadStoreFn,
  loadToken,
  refreshCatalog,
  log = () => {},
  base = process.env,
  qoderArgs = [],
  probeRelay: probeRelayFn = async () => false,
}) {
  // Asserted up front because every call below sits inside a best-effort catch
  // that would otherwise swallow a missing injection as a warning and still
  // spawn Qoder.
  for (const [name, dep] of Object.entries({
    writeConfig,
    loadStore: loadStoreFn,
    loadToken,
    refreshCatalog,
  })) {
    if (typeof dep !== "function") {
      throw new TypeError(`runQoderLauncher requires ${name} to be a function`);
    }
  }

  let relay;
  try {
    const reused = await probeRelayFn(RELAY_PORT);
    if (reused) {
      const token = loadToken(relayDataRoot(base));
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
    // Sync BYOK config into Qoder's settings.json before spawning so the
    // customModels array reflects the current store. Errors are logged but
    // never block the launch — Qoder can still start with stale or no BYOK.
    try {
      const loaded = loadStoreFn();
      if (loaded.ok) {
        const sidecarRoot = relayDataRoot(base);
        const settingsPath = qoderSettingsPath(base.USERPROFILE ?? "");
        const writeResult = await writeConfig(loaded.store, relay.port, relay.token, sidecarRoot, settingsPath);
        if (!writeResult.ok) {
          log(`warning: qoder settings.json not updated: ${writeResult.reason ?? "unknown error"}`);
        } else if (!writeResult.unchanged) {
          log(`qoder settings.json updated (backup: ${writeResult.backupPath ?? "none"})`);
        }
      } else {
        log("warning: Anyswitch store could not be read; qoder settings not updated");
      }
    } catch (syncErr) {
      log(`warning: qoder BYOK config sync failed: ${syncErr.message}`);
    }

    const env = buildQoderLauncherEnv({ token: relay.token, base });
    const exitCode = await spawnQoder({ env, args: qoderArgs, onSpawned: () => {
      // Best-effort model-catalog warm-up: Qoder 0.2.x cold-start can render the
      // composer with an empty model list (a cache-strategy race), leaving the
      // model button disabled. Nudge the store to reload once the renderer is up.
      refreshCatalog({ port: QODER_CDP_PORT, log }).catch((error) => {
        log(`qoder model catalog warm-up failed: ${error.message}`);
      });
    } });
    return exitCode;
  } finally {
    await relay.close();
  }
}

export function realSpawnQoder({ env, args, onSpawned }) {
  return new Promise((resolve, reject) => {
    const exe = resolveQoderExecutable(env);
    const isCmd = exe.toLowerCase().endsWith(".cmd");
    const comspec = process.env.COMSPEC || "cmd.exe";
    // Inject the CDP port so the launcher can warm up the model catalog after
    // the renderer comes up (Qoder 0.2.x cold-start race). Qoder ignores the
    // flag harmlessly when debugging is unavailable.
    const cdpArg = `--remote-debugging-port=${QODER_CDP_PORT}`;
    const fullArgs = [cdpArg, ...args];
    const child = isCmd
      ? spawn(comspec, ["/d", "/c", exe, ...fullArgs], {
          env,
          stdio: "inherit",
          shell: false,
          windowsHide: false,
        })
      : spawn(exe, fullArgs, {
          env,
          stdio: "inherit",
          shell: false,
          windowsHide: false,
        });
    child.on("spawn", () => {
      try { onSpawned?.(); } catch { /* never block the launch */ }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export async function main(argv = process.argv.slice(2)) {
  const code = await runQoderLauncher({
    startRelay: () => startOpenAIRelay(),
    writeConfig: (store, port, token, sidecarRoot, settingsPath) =>
      writeQoderConfig(store, port, token, sidecarRoot, settingsPath),
    loadStore,
    loadToken: (root) => loadOrGenerateToken(root),
    refreshCatalog: (options) => refreshQoderModelCatalog(options),
    spawnQoder: realSpawnQoder,
    log: (line) => process.stderr.write(`${line}\n`),
    qoderArgs: argv,
    probeRelay: probeRelay,
  });
  return code;
}

function isEntryModule(argv1, metaUrl, realpath = realpathSync) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  const norm = (p) => {
    try { return realpath(p); } catch { return p; }
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
      process.stderr.write(`qoder launcher failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
