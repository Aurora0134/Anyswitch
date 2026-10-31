// WorkBuddy launcher —— 把 WorkBuddy 自带 CodeBuddy Code CLI 接到 Anyswitch
// relay：探/起 relay → best-effort 写 ~/.workbuddy/models.json → 注入 env →
// 原样透传 argv 拉起 CLI → 结束时上报会话生命周期。
//
// 与 grok-launcher 同骨架，差异都来自这个客户端的形态：
//   - 执行体是 `resources/app.asar.unpacked/cli/bin/codebuddy`（无扩展名、
//     不在 PATH），必须用 node 拉起；node 优先取 WorkBuddy 自带的
//     `~/.workbuddy/binaries/node/versions/*/node.exe` 最新版，回落 PATH 的
//     node。两者都没有就明确报错，绝不静默启动一个不存在的程序。
//   - 身份走 URL 段前缀（models.json 的 url 自带 /openai/workbuddy~…），
//     CLI 发请求前会删 user-agent，UA 通道不可靠；因此这里**不注入
//     x-agent-id**，只注入 ANYSWITCH_INSTANCE_ID 供面板做实例桶。
//   - 不写 relay token 到 env：token 只作为 models.json 条目的 apiKey 落盘。
//   - 上游网关的真实 key（CODEBUDDY_BASE_URL / *_TOKEN 这类覆盖项）剥掉，
//     避免自定义模型之外的内置通道被环境变量改道；CODEBUDDY_API_KEY 按
//     plan §3.2 保留（用户自己的内置模型凭据不受影响）。
//
// argv 全量透传：`-p` 非交互、`--acp` 宿主模式、无参交互 TUI 三种用法都从
// shim/面板原样穿到 CLI。

import { spawn } from "node:child_process";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync, existsSync, readdirSync } from "node:fs";
import { createOpenAIRelayServer, listenLoopback, probeRelay, DEFAULT_RELAY_PORT } from "./openai-server.mjs";
import { createProductionDeps } from "./launch.mjs";
import { loadStore } from "./store-io.mjs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";
import { createAgentMetricsCollector, createSessionReporter, INSTANCE_ID_MAX_LEN } from "./agent-metrics.mjs";
import { createUsageJournal } from "./usage-journal.mjs";
import { writeWorkbuddyModels, workbuddyModelsPath, workbuddyConfigRoot } from "./workbuddy-merge-models.mjs";
import { acquireRelayOrNative, buildNativeLauncherEnv, loadNativeSyncToken } from "./launcher-native-fallback.mjs";
import { resolveWorkbuddyExecutable } from "./agent-discovery.mjs";
import { compareVersions, parseVersion } from "./version-check.mjs";
export { resolveWorkbuddyExecutable, workbuddyModelsPath, workbuddyConfigRoot };

export const RELAY_PORT = DEFAULT_RELAY_PORT;

// Upstream-only overrides stripped from the child environment. `CODEBUDDY_API_KEY`
// is deliberately NOT here (plan §3.2): it is the user's own built-in-gateway
// credential, and custom-model traffic never reads it — the per-entry apiKey in
// models.json is the relay token. These four, by contrast, would reroute or
// re-authenticate the built-in gateway away from its own configuration.
const UPSTREAM_ENV_KEYS = [
  "CODEBUDDY_BASE_URL",
  "CODEBUDDY_API_BASE",
  "CODEBUDDY_AUTH_TOKEN",
  "CODEBUDDY_TOKEN",
];

function relayDataRoot(base = process.env) {
  return join(base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"), "Anyswitch");
}

function createOpenAIProductionDeps(options = {}) {
  const claudeDeps = createProductionDeps(options);
  // Fallback-relay metrics + usage journal: traffic served while the resident
  // relay is down must still reach the panel and the stats journal.
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
    throw new Error("the Anyswitch global store is not usable; refusing to start the workbuddy relay");
  }
  const server = createOpenAIRelayServer(deps);
  const { port, reused, close } = await listenLoopback(server, RELAY_PORT);
  return { port, token: deps.token, close, reused };
}

// Per-instance id, shared scheme across the endpoints:
// "<cwd basename>-<launcher pid>", charset-cleaned and length-capped.
export function buildInstanceId({ cwd = process.cwd(), pid = process.pid, endpoint = "workbuddy" } = {}) {
  const base = basename(cwd).replace(/[^A-Za-z0-9._:-]/g, "-");
  return `${base || endpoint}-${pid}`.slice(0, INSTANCE_ID_MAX_LEN);
}

const defaultIo = { existsSync, readdirSync };

// WorkBuddy 自带的 node 运行时：~/.workbuddy/binaries/node/versions/<version>/node.exe，
// 取版本号最高的一份。目录不存在/为空返回 null，由 PATH 回落兜底。
export function resolveBundledNode(base = process.env, io = defaultIo) {
  const versionsDir = join(workbuddyConfigRoot(base), "binaries", "node", "versions");
  let entries = [];
  try {
    entries = io.readdirSync(versionsDir);
  } catch {
    return null;
  }
  const candidates = entries
    .map((entry) => ({ dir: entry, version: entry.replace(/^v(?=\d)/, "") }))
    .filter((candidate) => parseVersion(candidate.version))
    .map((candidate) => ({ ...candidate, exe: join(versionsDir, candidate.dir, "node.exe") }))
    .filter((candidate) => io.existsSync(candidate.exe))
    .sort((left, right) => compareVersions(right.version, left.version) ?? 0);
  return candidates.length > 0 ? candidates[0].exe : null;
}

// PATH 回落的 node（不 spawn 探测，只查文件存在性）。
export function resolvePathNode(base = process.env, io = defaultIo) {
  const separator = process.platform === "win32" ? ";" : ":";
  const exeName = process.platform === "win32" ? "node.exe" : "node";
  for (const dir of String(base.PATH ?? base.Path ?? "").split(separator)) {
    if (!dir) continue;
    const candidate = join(dir, exeName);
    if (io.existsSync(candidate)) return candidate;
  }
  return null;
}

// 执行体解析：自带 node 最新版优先，回落 PATH；两者皆无返回 null，由调用方
// 明确报错（launcher 不静默降级）。
export function resolveWorkbuddyNode(base = process.env, io = defaultIo) {
  return resolveBundledNode(base, io) ?? resolvePathNode(base, io);
}

// Build the child environment. ANYSWITCH_INSTANCE_ID is the only Anyswitch
// variable; NO_PROXY keeps relay traffic on loopback. No x-agent-id — identity
// lives in the models.json URL segment, which also covers the GUI path that
// never goes through this launcher.
export function buildWorkbuddyLauncherEnv({ instanceId = buildInstanceId(), base = {} } = {}) {
  const env = { ...base };
  // Guarded like the grok launcher: an explicit null means "no instance tag",
  // and a null reaching child_process.spawn would become the literal "null".
  if (instanceId) env.ANYSWITCH_INSTANCE_ID = instanceId;
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = "127.0.0.1,localhost";
  for (const key of UPSTREAM_ENV_KEYS) delete env[key];
  return env;
}

export async function runWorkbuddyLauncher({
  startRelay,
  spawnWorkbuddy,
  // writeConfig / loadStore / loadToken / createTracker are the only doors this
  // function has to the user's machine (~/.workbuddy/models.json, the store,
  // the shared relay token file, the panel session-report endpoint). They have
  // no defaults on purpose: main() wires the real ones and a test that forgets
  // one crashes instead of writing through to live paths.
  writeConfig,
  loadStore: loadStoreFn,
  loadToken,
  createTracker,
  resolveNode = resolveWorkbuddyNode,
  log = () => {},
  base = process.env,
  args = [],
  probeRelay: probeRelayFn = async () => false,
}) {
  for (const [name, dep] of Object.entries({
    writeConfig,
    loadStore: loadStoreFn,
    loadToken,
    createTracker,
    spawnWorkbuddy,
    resolveNode,
  })) {
    if (typeof dep !== "function") {
      throw new TypeError(`runWorkbuddyLauncher requires ${name} to be a function`);
    }
  }

  // 明确报错：没有 node 就没有执行体，不能假装启动成功。
  const nodePath = resolveNode(base);
  if (!nodePath) {
    throw new Error(
      "no node runtime found for the WorkBuddy CLI: neither " +
        `${join(workbuddyConfigRoot(base), "binaries", "node", "versions")}/*/node.exe ` +
        "nor a node executable on PATH",
    );
  }
  const cliPath = resolveWorkbuddyExecutable(base);

  const relay = await acquireRelayOrNative({
    endpoint: "workbuddy",
    port: RELAY_PORT,
    log,
    probeRelay: probeRelayFn,
    residentRelay: async () => ({
      port: RELAY_PORT,
      token: loadToken(relayDataRoot(base)),
      // 常驻 relay 不随本次启动拆；只有我们起的回落 relay 才关。
      close: async () => {},
      reused: true,
    }),
    startRelay,
  });

  const tracker = relay ? (createTracker({ token: relay.token }) ?? null) : null;
  const instanceId = buildInstanceId({ endpoint: "workbuddy" });

  try {
    // Best-effort config sync. Errors are logged but never block the launch —
    // WorkBuddy can still start with a stale or hand-written models.json.
    try {
      const loaded = loadStoreFn();
      if (!loaded.ok) {
        log("warning: Anyswitch store could not be read; workbuddy models.json not updated");
      } else {
        const syncToken = relay
          ? relay.token
          : loadNativeSyncToken({ loadToken, root: relayDataRoot(base), endpoint: "workbuddy", log });
        if (syncToken) {
          const sidecarRoot = relayDataRoot(base);
          const writeResult = await writeConfig(
            loaded.store,
            relay ? relay.port : RELAY_PORT,
            syncToken,
            sidecarRoot,
            workbuddyModelsPath(base),
          );
          if (!writeResult.ok) {
            log(`warning: workbuddy models.json not updated: ${writeResult.reason ?? "unknown error"}`);
          } else if (!writeResult.unchanged) {
            log(`workbuddy models.json updated (backup: ${writeResult.backupPath ?? "none"})`);
          }
        }
      }
    } catch (syncErr) {
      log(`warning: workbuddy config sync failed: ${syncErr.message}`);
    }

    const env = relay
      ? buildWorkbuddyLauncherEnv({ instanceId, base })
      : buildNativeLauncherEnv({ base });
    return await spawnWorkbuddy({
      env,
      args,
      node: nodePath,
      cli: cliPath,
      onPid: (pid) => tracker?.setClaudePid(pid),
    });
  } finally {
    tracker?.reportEnd();
    await relay?.close();
  }
}

// Real spawn: node <cli/bin/codebuddy> <argv…>. `spawnFn` is injectable so the
// argv/env pass-through can be asserted without starting a process.
export function realSpawnWorkbuddy({ env, args, onPid = () => {}, node, cli, spawnFn = spawn }) {
  if (!node) return Promise.reject(new Error("realSpawnWorkbuddy requires the node executable path"));
  const cliPath = cli ?? resolveWorkbuddyExecutable(env);
  return new Promise((resolve, reject) => {
    const child = spawnFn(node, [cliPath, ...(args ?? [])], {
      env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    if (child.pid) onPid(child.pid);
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export async function main(argv = process.argv.slice(2)) {
  return runWorkbuddyLauncher({
    startRelay: () => startOpenAIRelay(),
    writeConfig: (store, port, token, sidecarRoot, modelsPath) =>
      writeWorkbuddyModels(store, port, token, sidecarRoot, modelsPath),
    loadStore,
    loadToken: (root) => loadOrGenerateToken(root),
    createTracker: ({ token }) => {
      const tracker = createSessionReporter({
        reportUrl: `http://127.0.0.1:${RELAY_PORT}/panel/api/session/report`,
        agentId: "workbuddy",
      });
      tracker.setToken(token);
      return tracker;
    },
    spawnWorkbuddy: realSpawnWorkbuddy,
    log: (line) => process.stderr.write(`${line}\n`),
    args: argv,
    probeRelay,
  });
}

function isEntryModule(argv1, metaUrl, realpath = realpathSync) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  const norm = (path) => {
    try {
      return realpath(path);
    } catch {
      return path;
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
      process.stderr.write(`workbuddy launcher failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
