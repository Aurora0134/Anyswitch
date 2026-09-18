// Codex launcher: starts the fallback OpenAI relay, merges the Anyswitch
// managed providers into ~/.codex/config.toml, then spawns the real codex CLI.
//
// Instance-tagging coupling: the managed providers in config.toml carry an
// env_http_headers placeholder `x-agent-instance=ANYSWITCH_INSTANCE_ID` (see
// codex-merge-config.mjs), which codex expands from the child environment —
// the launcher always sets ANYSWITCH_INSTANCE_ID below. Unlike pi/qoder, no
// relay token is injected via env: the desktop GUI cannot see launcher env, so
// the token only ever lives as a literal Authorization header inside the
// managed config block, never in the spawned environment.
import { spawn } from "node:child_process";
import { join, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync, readdirSync, existsSync, statSync } from "node:fs";
import { createOpenAIRelayServer, listenLoopback, DEFAULT_RELAY_PORT } from "./openai-server.mjs";
import { createProductionDeps } from "./launch.mjs";
import { loadStore } from "./store-io.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { createAgentMetricsCollector, INSTANCE_ID_MAX_LEN } from "./agent-metrics.mjs";
import { createUsageJournal } from "./usage-journal.mjs";

export function codexConfigPath(base = process.env) {
  return join(base.USERPROFILE ?? "", ".codex", "config.toml");
}

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
    throw new Error("the Anyswitch global store is not usable; refusing to start the codex relay");
  }
  const server = createOpenAIRelayServer(deps);
  const { port, reused, close } = await listenLoopback(server, RELAY_PORT);
  return { port, token: deps.token, close, reused };
}

// The Codex CLI installs under %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe
// where the hash directory changes with every package upgrade — discover it by
// glob, never hardcode it. Multiple hash dirs can linger after an upgrade, so
// the newest codex.exe wins. The CODEX_EXECUTABLE override must be absolute:
// a bare name or relative path could resolve back to the Anyswitch shim and
// make the launcher recurse into itself.
import { resolveCodexExecutable } from "./agent-discovery.mjs";
export { resolveCodexExecutable };

// Per-instance id, shared scheme across the endpoints:
// "<cwd basename>-<launcher pid>". The basename is charset-cleaned to the
// relay's instance-id whitelist (off-whitelist chars become "-") and the total
// is capped at INSTANCE_ID_MAX_LEN; an empty basename falls back to
// "<endpoint>-<pid>". The launcher process maps 1:1 to a client instance — the
// child's pid is unknowable before spawn, so the launcher's own pid is used.
export function buildInstanceId({ cwd = process.cwd(), pid = process.pid, endpoint = "codex" } = {}) {
  const base = basename(cwd).replace(/[^A-Za-z0-9._:-]/g, "-");
  return `${base || endpoint}-${pid}`.slice(0, INSTANCE_ID_MAX_LEN);
}

export function buildCodexLauncherEnv({ instanceId = buildInstanceId(), base = {} }) {
  const env = { ...base };
  // Consumed by codex's env_http_headers expansion of the x-agent-instance
  // placeholder that codex-merge-config writes into config.toml.
  env.ANYSWITCH_INSTANCE_ID = instanceId;
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = "127.0.0.1,localhost";
  return env;
}

export async function runCodexLauncher({
  startRelay,
  spawnCodex,
  // writeConfig / loadStore are the only doors this function has to the user's
  // machine (~/.codex/config.toml and the Anyswitch store). They deliberately
  // have no defaults: main() wires the real implementations and a test that
  // forgets one crashes instead of silently writing through to the live paths.
  writeConfig,
  loadStore: loadStoreFn,
  log = () => {},
  base = process.env,
  codexArgs = [],
}) {
  // Asserted up front because the config sync below sits inside a best-effort
  // catch that would otherwise swallow a missing injection as a warning and
  // still spawn codex.
  for (const [name, dep] of Object.entries({ writeConfig, loadStore: loadStoreFn })) {
    if (typeof dep !== "function") {
      throw new TypeError(`runCodexLauncher requires ${name} to be a function`);
    }
  }

  const relay = await startRelay();

  try {
    // Merge the managed providers into ~/.codex/config.toml before spawning.
    // Errors are logged but never block the launch — codex can still start
    // with a stale or hand-written config.
    try {
      const loaded = loadStoreFn();
      if (loaded.ok) {
        const sidecarRoot = relayDataRoot(base);
        const writeResult = await writeConfig(loaded.store, relay.port, relay.token, sidecarRoot, codexConfigPath(base));
        if (!writeResult.ok) {
          log(`warning: codex config.toml not updated: ${writeResult.reason ?? "unknown error"}`);
        } else if (!writeResult.unchanged) {
          log(`codex config.toml updated (backup: ${writeResult.backupPath ?? "none"})`);
        }
      } else {
        log("warning: Anyswitch store could not be read; codex config not updated");
      }
    } catch (syncErr) {
      log(`warning: codex config sync failed: ${syncErr.message}`);
    }

    const env = buildCodexLauncherEnv({ instanceId: buildInstanceId(), base });
    return await spawnCodex({ env, args: codexArgs });
  } finally {
    await relay.close();
  }
}

export function realSpawnCodex({ env, args }) {
  return new Promise((resolve, reject) => {
    const exe = resolveCodexExecutable(env);
    const isCmd = exe.toLowerCase().endsWith(".cmd");
    const comspec = process.env.COMSPEC || "cmd.exe";
    const child = isCmd
      ? spawn(comspec, ["/d", "/c", exe, ...args], {
          env,
          stdio: "inherit",
          shell: false,
          windowsHide: true,
        })
      : spawn(exe, args, {
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
  // codex-merge-config.mjs is a separate module (plan §3); imported lazily so
  // this launcher stays loadable in checkouts where the writer has not landed.
  const { writeCodexConfig } = await import("./codex-merge-config.mjs");
  const code = await runCodexLauncher({
    startRelay: () => startOpenAIRelay(),
    writeConfig: (store, port, token, sidecarRoot, configPath) =>
      writeCodexConfig(store, port, token, sidecarRoot, configPath),
    loadStore,
    spawnCodex: realSpawnCodex,
    log: (line) => process.stderr.write(`${line}\n`),
    codexArgs: argv,
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
      process.stderr.write(`codex launcher failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
