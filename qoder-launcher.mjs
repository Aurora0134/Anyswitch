// Qoder launcher — spawns the Qoder CLI through its qoder.cmd dispatcher with
// the Anyswitch relay token in the child environment.
//
// Qoder is different from the other endpoints: it has NO config.toml /
// config.json surface for API endpoints (it authenticates via browser OAuth
// against its own cloud), so there is no merge-config module and nothing to
// sync from agent-sync.mjs. The integration is:
//   1. reuse the resident relay on 47821 when it is already serving (probe),
//      otherwise start a per-launch OpenAI relay against the real v2 store;
//   2. spawn the qoder.cmd dispatcher (COMSPEC /d /c, like the other .cmd
//      CLIs) with ANYSWITCH_RELAY_TOKEN injected via process-level env vars
//      only — never written to disk;
//   3. tear the per-launch relay down when Qoder exits, so nothing leaks.
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
  log = () => {},
  base = process.env,
  qoderArgs = [],
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
    const env = buildQoderLauncherEnv({ token: relay.token, base });
    return await spawnQoder({ env, args: qoderArgs });
  } finally {
    await relay.close();
  }
}

function realSpawnQoder({ env, args }) {
  return new Promise((resolve, reject) => {
    const exe = resolveQoderExecutable(env);
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
  const code = await runQoderLauncher({
    startRelay: () => startOpenAIRelay(),
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
