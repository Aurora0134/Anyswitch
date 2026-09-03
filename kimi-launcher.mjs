// Kimi Code launcher — connects the Kimi Code CLI (Moonshot AI) through
// the Anyswitch relay so it uses the shared credential store.
//
// Kimi Code speaks Anthropic protocol natively (it reads ANTHROPIC_BASE_URL,
// ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY), so the same relay that serves
// Claude Code also serves Kimi Code. The launcher:
//   1. starts the relay against the real v2 store (ephemeral loopback port +
//      CSPRNG session token),
//   2. injects the relay endpoint + session token into a child kimi process
//      via process-level environment variables only (never written to disk),
//   3. passes the terminal straight through,
//   4. tears the relay down when kimi exits, so the token dies with it.

import { spawn } from "node:child_process";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { startProductionRelay } from "./launch.mjs";
import {
  extractManagedProviders,
  deriveAutoRouteChannel,
  mergeKimiConfigToml,
  readKimiConfigToml,
  writeKimiConfigTomlWithBackup,
  writeSidecar,
} from "./kimi-merge-config.mjs";

const LOOPBACK_NO_PROXY = "127.0.0.1,localhost";

export function kimiConfigPath(base = process.env) {
  return join(base.USERPROFILE ?? "", ".kimi-code", "config.toml");
}

export async function writeKimiConfig(store, port, token, sidecarRoot, configPath = kimiConfigPath()) {
  const managedProviders = extractManagedProviders(store);
  const autoChannel = deriveAutoRouteChannel(store, "kimi");
  if (Object.keys(managedProviders).length === 0 && !autoChannel) {
    return { ok: true, unchanged: true, reason: "no Anyswitch providers with models" };
  }
  let existing;
  try {
    existing = readKimiConfigToml(configPath);
  } catch (error) {
    return { ok: false, unchanged: true, reason: error.message };
  }
  let merged;
  try {
    merged = mergeKimiConfigToml(existing, managedProviders, port, token, autoChannel);
  } catch (error) {
    if (error?.code === "UNPARSEABLE_KIMI_CONFIG") {
      return { ok: false, unchanged: true, reason: error.message };
    }
    throw error;
  }
  const writeResult = writeKimiConfigTomlWithBackup(configPath, merged.text);
  if (writeResult.ok) {
    writeSidecar(sidecarRoot, merged.managed);
  }
  return writeResult;
}

// Unified per-instance id (same scheme as the other endpoint launchers):
// `<cwd basename>-<launcher pid>`, basename scrubbed to the relay's accepted
// charset [A-Za-z0-9._:-] and the whole id capped at 64 chars; falls back to
// `<endpoint>-<pid>` when the basename scrubs to empty. The launcher process
// maps 1:1 to a client instance, so its own pid is the discriminator.
export function buildInstanceId({
  cwd = process.cwd(),
  pid = process.pid,
  endpoint = "kimi",
} = {}) {
  const base = basename(cwd).replace(/[^A-Za-z0-9._:-]/g, "-");
  const id = base ? `${base}-${pid}` : `${endpoint}-${pid}`;
  return id.slice(0, 64);
}

// Build the child environment for kimi-code. Same pattern as Claude Code
// launcher: ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN + NO_PROXY.
export function buildKimiLauncherEnv({ port, token, base = {}, instanceId = null }) {
  const env = { ...base };

  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  env.ANTHROPIC_AUTH_TOKEN = token;

  // Endpoint identity + per-instance tag ride KIMI_CODE_CUSTOM_HEADERS —
  // newline-separated "Name: value" lines, parsed by kimi-code's
  // parseKimiCodeCustomHeaders and merged under every provider's outgoing
  // request headers (env layer is the base; provider customHeaders from
  // config.toml would override it, which is why the managed block no longer
  // carries x-agent-id). x-agent-id stays load-bearing: the relay's agent-id
  // whitelist and auto-chain lookup key on it. x-agent-instance feeds the
  // panel's per-instance buckets (agent-metrics.mjs instanceBuckets).
  const headers = ["x-agent-id: kimi"];
  if (instanceId) headers.push(`x-agent-instance: ${instanceId}`);
  env.KIMI_CODE_CUSTOM_HEADERS = headers.join("\n");

  // Load-bearing: relay traffic must stay on loopback.
  env.NO_PROXY = LOOPBACK_NO_PROXY;
  env.no_proxy = LOOPBACK_NO_PROXY;

  // Strip any real Anthropic key so it can't ride along.
  delete env.ANTHROPIC_API_KEY;

  return env;
}

export function resolveKimiExecutable(base = process.env) {
  const override = base.KIMI_EXECUTABLE;
  if (override) return override;

  // Default: the global npm bin directory
  return join(
    base.APPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Roaming"),
    "npm",
    "kimi.cmd",
  );
}

function realSpawnKimi({ env, args, onPid = () => {} }) {
  return new Promise((resolve, reject) => {
    const comspec = process.env.COMSPEC || "cmd.exe";
    const child = spawn(comspec, ["/d", "/c", resolveKimiExecutable(), ...args], {
      env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    // Notify the caller of the PID immediately — before exit — so the session
    // reporter can start pushing metrics while kimi is still running (same
    // pattern as the claude launcher).
    if (child.pid) onPid(child.pid);
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function realGetKimiVersion() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolveKimiExecutable(), ["--version"], { shell: false, windowsHide: true });
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

export async function runKimiLauncher({
  startRelay,
  buildEnv,
  spawnKimi,
  log = () => {},
  base = process.env,
  kimiArgs = [],
}) {
  const relay = await startRelay();
  const tracker = relay.sessionTracker ?? null;
  // One instance id per launcher process (launcher 与客户端实例一一对应)，
  // 经 KIMI_CODE_CUSTOM_HEADERS 随子进程出站请求打到 relay 的实例桶。
  const instanceId = buildInstanceId();

  try {
    const env = buildEnv({ port: relay.port, token: relay.token, base, instanceId });
    return await spawnKimi({
      env,
      args: kimiArgs,
      onPid: (pid) => {
        // 与 claude 一致：把子进程 PID 报给 session reporter（reportSession
        // 要求 PID，面板用它判断会话存活）。
        tracker?.setClaudePid(pid);
      },
    });
  } finally {
    // 与 claude 一致：relay 拆除前先向面板发 ended 信号；若 kimi 被强杀走
    // 不到这里，面板的 PID 扫描会兜底回收会话。
    tracker?.reportEnd();
    // The token dies with the relay. Always tear it down.
    await relay.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const code = await runKimiLauncher({
    // agentId "kimi"：per-launch relay 的 auto 路由、usage journal 行与
    // session 上报都归到 kimi 端点，不再落进 claude 桶。
    startRelay: () => startProductionRelay({ agentId: "kimi" }),
    buildEnv: buildKimiLauncherEnv,
    spawnKimi: realSpawnKimi,
    log: (line) => process.stderr.write(`${line}\n`),
    kimiArgs: argv,
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
      process.stderr.write(`kimi launcher failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
