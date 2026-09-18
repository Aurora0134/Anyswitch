import { spawn } from "node:child_process";
import { basename, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { createOpenAIRelayServer, listenLoopback, DEFAULT_RELAY_PORT } from "./openai-server.mjs";
import { createProductionDeps } from "./launch.mjs";
import { loadStore } from "./store-io.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { createAgentMetricsCollector } from "./agent-metrics.mjs";
import { createUsageJournal } from "./usage-journal.mjs";
import {
  readOpencodeConfig,
  mergeOpencodeConfig,
  writeOpencodeConfigWithBackup,
  extractManagedProviders,
  deriveAutoRouteChannel,
  readSidecar,
  writeSidecar,
  relayTokenFileRef,
  validateOpencodeConfig,
} from "./opencode-merge-config.mjs";
import { catalogForRoot, effortSupplementEnabled } from "./effort-catalog.mjs";

export const RELAY_PORT = DEFAULT_RELAY_PORT;

export function opencodeConfigPath(base = process.env) {
  return join(base.USERPROFILE ?? "", ".config", "opencode", "opencode.json");
}

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
    throw new Error("the Anyswitch global store is not usable; refusing to start the opencode relay");
  }
  const server = createOpenAIRelayServer(deps);
  const { port, reused, close } = await listenLoopback(server, RELAY_PORT);
  return { port, token: deps.token, close, reused };
}

// High-level write: read existing opencode.json, merge managed providers,
// write back with backup. Returns { ok, unchanged, backupPath?, reason? }.
// Fail-closed: a config whose managed block cannot be parsed is reported,
// never overwritten. Token-less signature (like dsh/pi): the apiKey is a
// `{file:...}` reference to the relay token file, not a literal value.
export async function writeOpencodeConfig(store, port, sidecarRoot, configPath = opencodeConfigPath(), catalog = catalogForRoot(sidecarRoot), effortsEnabled = null) {
  const managedProviders = extractManagedProviders(store);
  const autoChannel = deriveAutoRouteChannel(store, "opencode");
  if (Object.keys(managedProviders).length === 0 && !autoChannel) {
    return { ok: true, unchanged: true, reason: "no Anyswitch providers with models" };
  }
  const previousManaged = readSidecar(sidecarRoot).providers;
  // With 「注入推理强度」 off no variants are written at all: the merge
  // rebuilds every managed entry wholesale, so an absent catalog also strips
  // the variants a previous sync wrote — that is the switch's cleanup path.
  const effectiveCatalog = (effortsEnabled ?? effortSupplementEnabled(sidecarRoot)) ? catalog : null;
  let existing;
  try {
    existing = readOpencodeConfig(configPath);
  } catch (error) {
    if (error?.code === "UNPARSEABLE_CONFIG") {
      return { ok: false, unchanged: true, reason: error.message };
    }
    throw error;
  }
  const { config, managed } = mergeOpencodeConfig(existing, managedProviders, port, relayTokenFileRef(sidecarRoot), previousManaged, autoChannel, effectiveCatalog);

  const gate = validateOpencodeConfig(config);
  if (!gate.valid) {
    return { ok: false, unchanged: true, reason: `opencode.json would be invalid: ${gate.error}` };
  }

  const writeResult = writeOpencodeConfigWithBackup(configPath, config);
  if (writeResult.ok) {
    writeSidecar(sidecarRoot, managed);
  }
  return writeResult;
}

import { resolveOpencodeExecutable } from "./agent-discovery.mjs";
export { resolveOpencodeExecutable };

// Unified per-instance id: `<cwd basename>-<launcher pid>`, basename scrubbed
// to the relay's accepted charset [A-Za-z0-9._:-] and the whole id capped at
// 64 chars; falls back to `<endpoint>-<pid>` when the basename scrubs to empty. The launcher process
// maps 1:1 to a client instance, so its own pid is the discriminator.
export function buildInstanceId({
  cwd = process.cwd(),
  pid = process.pid,
  endpoint = "opencode",
} = {}) {
  const base = basename(cwd).replace(/[^A-Za-z0-9._:-]/g, "-");
  const id = base ? `${base}-${pid}` : `${endpoint}-${pid}`;
  return id.slice(0, 64);
}

export function buildOpencodeLauncherEnv({ token, instanceId, base = {} }) {
  const env = { ...base };
  env.ANYSWITCH_RELAY_TOKEN = token;
  // Consumed by the `{env:ANYSWITCH_AGENT_INSTANCE}` reference the managed
  // opencode.json writes into every provider's x-agent-instance header —
  // expanded inside the opencode process, so the tag lives in the child env
  // and the config reference, never as a literal on disk. Missing when the
  // client was not started through the launcher: the header expands empty
  // and the relay drops it (sanitizeInstanceId), as before.
  if (instanceId) env.ANYSWITCH_AGENT_INSTANCE = instanceId;
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = "127.0.0.1,localhost";
  return env;
}

export async function runOpencodeLauncher({
  startRelay,
  base = process.env,
  opencodeArgs = [],
  spawnFn = spawn,
  instanceId = buildInstanceId(),
  // writeConfig syncs opencode.json against the store before spawning. The
  // default is a no-op so tests stay hermetic (a default-real writer would
  // rewrite the user's actual config); production main() wires it explicitly.
  writeConfig = null,
  log = () => {},
}) {
  const relay = await startRelay();

  try {
    if (writeConfig) {
      const loaded = loadStore();
      if (!loaded.ok) {
        log("warning: Anyswitch store could not be read; opencode config not updated");
      } else {
        const writeResult = await writeConfig(loaded.store, relay.port, relayDataRoot(base));
        if (!writeResult.ok) {
          log(`warning: opencode.json not updated: ${writeResult.reason ?? "unknown error"}`);
        } else if (!writeResult.unchanged) {
          log(`opencode.json updated (backup: ${writeResult.backupPath ?? "none"})`);
        }
      }
    }

    const env = buildOpencodeLauncherEnv({ token: relay.token, instanceId, base });
    const exe = resolveOpencodeExecutable(base);
    const comspec = base.COMSPEC || "cmd.exe";

    return await new Promise((resolve, reject) => {
      const child = spawnFn(comspec, ["/d", "/c", exe, ...opencodeArgs], {
        env,
        stdio: "inherit",
        shell: false,
        windowsHide: true,
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    await relay.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const code = await runOpencodeLauncher({
    startRelay: () => startOpenAIRelay(),
    writeConfig: (store, port, sidecarRoot) => writeOpencodeConfig(store, port, sidecarRoot),
    log: (line) => process.stderr.write(`${line}\n`),
    opencodeArgs: argv,
  });
  return code;
}

export function isEntryModule(argv1, metaUrl, realpath = realpathSync) {
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
      process.stderr.write(`opencode launcher failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
