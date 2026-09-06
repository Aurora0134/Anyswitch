import { spawn } from "node:child_process";
import { basename, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { createOpenAIRelayServer, listenLoopback, DEFAULT_RELAY_PORT } from "./openai-server.mjs";
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
    throw new Error("the Anyswitch global store is not usable; refusing to start the opencode relay");
  }
  const server = createOpenAIRelayServer(deps);
  const { port, reused, close } = await listenLoopback(server, RELAY_PORT);
  return { port, token: deps.token, close, reused };
}

export function resolveOpencodeExecutable(base = process.env) {
  const override = base.OPENCODE_EXECUTABLE;
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error(
        `OPENCODE_EXECUTABLE must be an absolute path, got "${override}". ` +
          `A bare name or relative path could resolve back to the Anyswitch shim and ` +
          `make the launcher recurse into itself.`,
      );
    }
    return override;
  }
  // Default to the real opencode binary, NOT a PATH-resolved `opencode`:
  // the Anyswitch shadow shims (bin-opencode, ahead of npm in PATH) route
  // `opencode` back into this launcher, so resolving the command name here
  // would recurse forever.
  return join(
    base.APPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Roaming"),
    "npm",
    "node_modules",
    "opencode-ai",
    "bin",
    "opencode.exe",
  );
}

// Unified per-instance id (same scheme as the antigravity launcher):
// `<cwd basename>-<launcher pid>`, basename scrubbed to the relay's accepted
// charset [A-Za-z0-9._:-] and the whole id capped at 64 chars; falls back to
// `<endpoint>-<pid>` when the basename scrubs to empty. The launcher process
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
  // Read by the companion OpenCode injection plugin (not shipped with this
  // repository) and turned into an x-agent-instance header; the tag lives in
  // the child env only, never on disk.
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
}) {
  const relay = await startRelay();

  try {
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
