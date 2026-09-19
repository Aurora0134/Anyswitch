// Grok Build launcher — connects the Grok Build CLI (xAI) through the
// Anyswitch relay so it uses the shared credential store.
//
// Grok Build speaks OpenAI chat/completions natively and reads its custom
// models from ~/.grok/config.toml, where grok-merge-config.mjs writes one
// managed [model."anyswitch-<channel>~<model>"] table per (channel, model)
// pointing at the relay's /openai/<seg>/v1 surface. The instance-tagging
// coupling is the same as codex's env_http_headers scheme: every managed
// table carries `env_http_headers = { "x-agent-instance" = "ANYSWITCH_INSTANCE_ID" }`,
// which grok expands from the child environment, so the launcher always sets
// ANYSWITCH_INSTANCE_ID below. Like codex, no relay token rides the
// environment — it only ever lives as the literal api_key of the managed
// tables on disk.
//
// The flow:
//   1. reuse the resident relay on 47821 when it answers the identity probe
//      (probeRelay); otherwise start a fallback OpenAI relay on the same port
//      which exits with grok — the resident relay is never touched;
//   2. best-effort sync of the managed model tables into ~/.grok/config.toml
//      (errors are logged, never block the launch);
//   3. spawn the real grok.exe with argv passed through verbatim;
//   4. report the session lifecycle (pid bind on spawn, "ended" on exit) to
//      the panel exactly the way the kimi launcher does (session reporter).

import { spawn } from "node:child_process";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { createOpenAIRelayServer, listenLoopback, probeRelay, DEFAULT_RELAY_PORT } from "./openai-server.mjs";
import { createProductionDeps } from "./launch.mjs";
import { loadStore } from "./store-io.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { createAgentMetricsCollector, createSessionReporter, INSTANCE_ID_MAX_LEN } from "./agent-metrics.mjs";
import { createUsageJournal } from "./usage-journal.mjs";
import { writeGrokConfig, grokConfigPath } from "./grok-merge-config.mjs";
import { resolveGrokExecutable } from "./agent-discovery.mjs";
export { resolveGrokExecutable, grokConfigPath };

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
    throw new Error("the Anyswitch global store is not usable; refusing to start the grok relay");
  }
  const server = createOpenAIRelayServer(deps);
  const { port, reused, close } = await listenLoopback(server, RELAY_PORT);
  return { port, token: deps.token, close, reused };
}

// Per-instance id, shared scheme across the endpoints:
// "<cwd basename>-<launcher pid>". The basename is charset-cleaned to the
// relay's instance-id whitelist (off-whitelist chars become "-") and the total
// is capped at INSTANCE_ID_MAX_LEN; an empty basename falls back to
// "<endpoint>-<pid>". The launcher process maps 1:1 to a client instance — the
// child's pid is unknowable before spawn, so the launcher's own pid is used.
export function buildInstanceId({ cwd = process.cwd(), pid = process.pid, endpoint = "grok" } = {}) {
  const base = basename(cwd).replace(/[^A-Za-z0-9._:-]/g, "-");
  return `${base || endpoint}-${pid}`.slice(0, INSTANCE_ID_MAX_LEN);
}

// Build the child environment for grok. ANYSWITCH_INSTANCE_ID is the variable
// the managed tables' env_http_headers expansion reads (missing it silently
// drops x-agent-instance and degrades per-instance buckets to the relay's
// socket-owner fallback). NO_PROXY keeps relay traffic on loopback.
export function buildGrokLauncherEnv({ instanceId = buildInstanceId(), base = {} }) {
  const env = { ...base };
  env.ANYSWITCH_INSTANCE_ID = instanceId;
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = "127.0.0.1,localhost";
  // Strip the real upstream credentials so grok's built-in xAI path cannot
  // bypass the relay with a direct api.x.ai connection (the kimi launcher
  // strips ANTHROPIC_API_KEY for the same reason). The managed tables are
  // unaffected: each carries its own literal api_key (the relay token).
  // Functional variables like GROK_HOME stay — they configure where grok
  // reads its files, not where it sends traffic.
  delete env.XAI_API_KEY;
  delete env.GROK_CODE_XAI_API_KEY;
  return env;
}

export async function runGrokLauncher({
  startRelay,
  spawnGrok,
  // writeConfig / loadStore / loadToken / createTracker are the only doors this
  // function has to the user's machine (~/.grok/config.toml, the Anyswitch
  // store, the shared relay token file, the panel's session-report endpoint).
  // They deliberately have no defaults: main() wires the real implementations
  // and a test that forgets one crashes instead of silently writing through to
  // the live paths.
  writeConfig,
  loadStore: loadStoreFn,
  loadToken,
  createTracker,
  log = () => {},
  base = process.env,
  grokArgs = [],
  probeRelay: probeRelayFn = async () => false,
}) {
  // Asserted up front because the config sync below sits inside a best-effort
  // catch that would otherwise swallow a missing injection as a warning and
  // still spawn grok.
  for (const [name, dep] of Object.entries({
    writeConfig,
    loadStore: loadStoreFn,
    loadToken,
    createTracker,
  })) {
    if (typeof dep !== "function") {
      throw new TypeError(`runGrokLauncher requires ${name} to be a function`);
    }
  }

  let relay;
  try {
    const reused = await probeRelayFn(RELAY_PORT);
    if (reused) {
      const token = loadToken(relayDataRoot(base));
      // close is a no-op on purpose: the resident relay outlives this launch
      // (常驻不随进程拆); only a fallback relay we started gets torn down.
      relay = { port: RELAY_PORT, token, close: async () => {}, reused: true };
      log(`resident relay already running on ${RELAY_PORT}; reusing, no spawn of a new relay`);
    } else {
      relay = await startRelay();
    }
  } catch (error) {
    log(`probe failed (${error.message}); falling back to per-launch relay`);
    relay = await startRelay();
  }

  // Session lifecycle reporter (kimi pattern): bind the child pid on spawn so
  // the panel can tell the session is alive, send "ended" before exit. The
  // reporter posts to the resident panel relay; when it is unreachable
  // (fallback mode) the posts fail silently — reporting never blocks a launch.
  const tracker = createTracker({ token: relay.token }) ?? null;
  // One instance id per launcher process (launcher 与客户端实例一一对应)，
  // 经 env_http_headers 随子进程出站请求打到 relay 的实例桶。
  const instanceId = buildInstanceId();

  try {
    // Merge the managed model tables into ~/.grok/config.toml before spawning.
    // Errors are logged but never block the launch — grok can still start
    // with a stale or hand-written config.
    try {
      const loaded = loadStoreFn();
      if (loaded.ok) {
        const sidecarRoot = relayDataRoot(base);
        const writeResult = await writeConfig(loaded.store, relay.port, relay.token, sidecarRoot, grokConfigPath(base));
        if (!writeResult.ok) {
          log(`warning: grok config.toml not updated: ${writeResult.reason ?? "unknown error"}`);
        } else if (!writeResult.unchanged) {
          log(`grok config.toml updated (backup: ${writeResult.backupPath ?? "none"})`);
        }
      } else {
        log("warning: Anyswitch store could not be read; grok config not updated");
      }
    } catch (syncErr) {
      log(`warning: grok config sync failed: ${syncErr.message}`);
    }

    const env = buildGrokLauncherEnv({ instanceId, base });
    return await spawnGrok({
      env,
      args: grokArgs,
      onPid: (pid) => {
        // 与 kimi 一致：把子进程 PID 报给 session reporter（面板的会话
        // 行要求 PID，ended 归账按 pid+token 去重）。
        tracker?.setClaudePid(pid);
      },
    });
  } finally {
    // 与 kimi 一致：relay 拆除前先向面板发 ended 信号；若 grok 被强杀走
    // 不到这里，面板的 PID 扫描会兜底回收会话。
    tracker?.reportEnd();
    // A reused resident relay's close is a no-op; only a fallback relay dies here.
    await relay.close();
  }
}

export function realSpawnGrok({ env, args, onPid = () => {} }) {
  return new Promise((resolve, reject) => {
    // resolveGrokExecutable only ever returns a native .exe (the override is
    // rejected otherwise), so no COMSPEC wrapping branch is needed.
    const child = spawn(resolveGrokExecutable(env), args, {
      env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    // Notify the caller of the PID immediately — before exit — so the session
    // reporter can bind the session while grok is still running (same pattern
    // as the kimi launcher).
    if (child.pid) onPid(child.pid);
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export async function main(argv = process.argv.slice(2)) {
  const code = await runGrokLauncher({
    startRelay: () => startOpenAIRelay(),
    writeConfig: (store, port, token, sidecarRoot, configPath) =>
      writeGrokConfig(store, port, token, sidecarRoot, configPath),
    loadStore,
    loadToken: (root) => loadOrGenerateToken(root),
    // Per-launch session reporter (kimi pattern, agentId "grok"): posts the
    // session lifecycle to the resident panel relay. journal stays null —
    // per-request usage rows are journaled relay-side via the x-agent-id /
    // x-agent-instance headers; this reporter only carries pid bind + ended.
    createTracker: ({ token }) => {
      const tracker = createSessionReporter({
        reportUrl: `http://127.0.0.1:${RELAY_PORT}/panel/api/session/report`,
        agentId: "grok",
      });
      tracker.setToken(token);
      return tracker;
    },
    spawnGrok: realSpawnGrok,
    log: (line) => process.stderr.write(`${line}\n`),
    grokArgs: argv,
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
      process.stderr.write(`grok launcher failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
