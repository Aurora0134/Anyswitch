// Claude launcher.
//
// The one command a user runs. It:
//   1. starts the relay against the real v2 store (ephemeral loopback port +
//      CSPRNG session token),
//   2. probes the installed Claude version,
//   3. injects the relay endpoint + session token into a child Claude process
//      via process-level environment variables only (never written to disk),
//   4. passes the terminal straight through so `/model`, arrow keys and SSE
//      streaming all work,
//   5. tears the relay down when Claude exits, so the token dies with it.
//
// runLauncher() takes every side effect as an injected dependency, so the whole
// control flow (version gate, discovery downgrade, env injection, teardown) is
// testable with zero real spawn, zero real relay and zero API cost. The real
// wiring lives in main() at the bottom.
//
// Security notes:
//   - NO_PROXY/no_proxy for loopback is LOAD-BEARING, not cosmetic.
//     It is set unconditionally so relay traffic can never leave the machine via
//     an inherited HTTP_PROXY/HTTPS_PROXY.
//   - The relay token is the sole auth Claude gets. Any inherited
//     ANTHROPIC_API_KEY is stripped so a stray real key can't ride along.
//   - The session token is never logged.

import { spawn } from "node:child_process";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync, readFileSync } from "node:fs";
import { startProductionRelay } from "./launch.mjs";

// The Claude MINOR family whose gateway-discovery filter behaviour is verified
// (first proven on 2.1.220). Discovery is enabled for any patch release in
// this family (2.1.x) because patch bumps do not change the discovery
// id-prefix filter. A major/minor jump (2.2.x, 3.x) is treated as UNVERIFIED:
// discovery off, no promise of a working fallback, until the filter behaviour
// is re-verified and this family is bumped.
export const VERIFIED_CLAUDE_MINOR = "2.1";

// A representative fully-verified version in the family (kept for messaging and
// as the canonical example in tests / docs).
export const EXPECTED_CLAUDE_VERSION = "2.1.220";

// True when `version` is a concrete x.y.z whose x.y equals the verified family.
// Pure: no IO. Unknown/unparseable versions are NOT verified.
export function isVerifiedDiscoveryVersion(version) {
  if (typeof version !== "string") return false;
  const m = version.match(/^(\d+)\.(\d+)\.\d+/);
  if (!m) return false;
  return `${m[1]}.${m[2]}` === VERIFIED_CLAUDE_MINOR;
}

const LOOPBACK_NO_PROXY = "127.0.0.1,localhost";

// Fallback wire ID (anthropic/<provider>/<model>) for Claude Code's small-fast
// model family: the auto-mode permission classifier, the background classifier
// and other quick side-queries. This placeholder should never reach a real
// session: the real wiring (main) derives a concrete wire ID from the first
// provider in the local store, and ANYSWITCH_SMALL_FAST_MODEL /
// ANTHROPIC_SMALL_FAST_MODEL override it entirely. If it ever does take
// effect, set ANYSWITCH_SMALL_FAST_MODEL to a small, stable model.
//
// Why pinning matters: on a third-party gateway Claude Code has no official
// Sonnet 5 / Haiku IDs to fall back to, so with ANTHROPIC_SMALL_FAST_MODEL
// unset the classifier is pinned to the session's main model at first request.
// A classifier on an unstable main model fails EVERY permission check, which
// is exactly the "auto mode cannot determine the safety of Bash" failure.
export const DEFAULT_SMALL_FAST_MODEL_WIRE_ID = "anthropic/your-provider/your-small-fast-model";

// Build the child environment. Pure: no process.env access, no IO.
//   base      - the environment to inherit from (the caller passes process.env)
//   port      - the relay's loopback port
//   token     - the relay session token
//   discovery - whether to enable Claude's gateway model discovery
export function buildLauncherEnv({ port, token, discovery, base = {} }) {
  const env = { ...base };

  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  env.ANTHROPIC_AUTH_TOKEN = token;

  // Load-bearing: the sole reason relay traffic stays on the machine when a
  // proxy is configured. Never drop these.
  env.NO_PROXY = LOOPBACK_NO_PROXY;
  env.no_proxy = LOOPBACK_NO_PROXY;

  // The relay token is the only credential Claude should hold. Strip any real
  // Anthropic key that happened to be in the inherited environment so it can
  // never be sent instead of / alongside the relay token.
  delete env.ANTHROPIC_API_KEY;

  // Pin the classifier (small-fast) model to a stable wire ID so permission
  // checks never ride on an unstable main model. Precedence:
  //   1. an explicitly inherited ANTHROPIC_SMALL_FAST_MODEL (user override),
  //   2. ANYSWITCH_SMALL_FAST_MODEL (per-launch override via this shim),
  //   3. DEFAULT_SMALL_FAST_MODEL_WIRE_ID.
  if (env.ANTHROPIC_SMALL_FAST_MODEL === undefined) {
    env.ANTHROPIC_SMALL_FAST_MODEL = base.ANYSWITCH_SMALL_FAST_MODEL ?? DEFAULT_SMALL_FAST_MODEL_WIRE_ID;
  }

  if (discovery) {
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  } else {
    // Make sure an inherited "1" can't silently re-enable a downgraded session.
    delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  }

  return env;
}

// Decide whether gateway discovery may be enabled for this Claude version, and
// emit the appropriate operator-facing warning. Pure apart from the injected log.
function resolveDiscovery(version, log) {
  if (isVerifiedDiscoveryVersion(version)) {
    return true;
  }
  if (version === null || version === undefined) {
    log(
      `Claude version is unknown (claude --version did not report a version). ` +
        `Gateway model discovery has been DISABLED; the /model picker will not ` +
        `list Anyswitch models. Use --model anthropic/<provider>/<model> instead.`,
    );
    return false;
  }
  log(
    `Claude version ${version} is outside the verified ${VERIFIED_CLAUDE_MINOR}.x family ` +
      `(discovery id-prefix filter behaviour is only verified for ${VERIFIED_CLAUDE_MINOR}.x, ` +
      `first proven on ${EXPECTED_CLAUDE_VERSION}). Gateway model discovery has been DISABLED; ` +
      `no fallback selection path is promised. You can still try ` +
      `--model anthropic/<provider>/<model>.`,
  );
  return false;
}

// Orchestrate a single launch. Returns Claude's exit code. Every dependency is
// injected:
//   startRelay()       -> { port, token, close() }
//   getClaudeVersion() -> version string, or null if it can't be determined
//   spawnClaude({env, args}) -> exit code (resolves after Claude exits)
//   log(line)          -> operator-facing message sink
//   base               -> environment to inherit (defaults to process.env)
//   claudeArgs         -> extra args forwarded to the Claude child
export async function runLauncher({
  startRelay,
  getClaudeVersion,
  spawnClaude,
  log = () => {},
  base = process.env,
  claudeArgs = [],
}) {
  // If the relay refuses to start (e.g. the store is unusable), this throws
  // before we have a handle. We must NOT spawn Claude and there is nothing to
  // close, so let it propagate directly.
  const relay = await startRelay();
  const tracker = relay.sessionTracker ?? null;

  try {
    const version = await getClaudeVersion();
    const discovery = resolveDiscovery(version, log);

    const env = buildLauncherEnv({
      port: relay.port,
      token: relay.token,
      discovery,
      base,
    });

    return await spawnClaude({
      env,
      args: claudeArgs,
      onPid: (pid) => {
        // Tell the reporter which claude.exe PID to embed in reports. The
        // panel uses this PID to decide liveness (is the process still alive?).
        tracker?.setClaudePid(pid);
      },
    });
  } finally {
    // Signal the panel that this session is over before tearing down the
    // relay. If Claude was force-killed and we never get here, the panel's
    // PID scan will reap the session instead — this is just the fast path.
    tracker?.reportEnd();
    // The token dies with the relay. Always tear it down: on the happy path,
    // on a non-zero child exit, and on any throw from the version probe or the
    // spawn itself.
    await relay.close();
  }
}

// ---------------------------------------------------------------------------
// Real wiring (not exercised by the injected unit tests).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));

// The default install path of the real Claude binary. Kept as a pure helper so
// both claudeExecutable() and its tests can reference the same default.
export function defaultClaudeExecutable(base = process.env) {
  // Convert backslashes to forward slashes to prevent spawn() path corruption on Windows.
  // spawn() with shell:false can misinterpret backslash sequences (\n, \b, \@) as escape codes.
  const path = join(
    base.APPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Roaming"),
    "npm",
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe",
  );
  return path.replace(/\\/g, '/');
}

// Resolve the Claude executable. Overridable via CLAUDE_EXECUTABLE for testing
// and for non-default installs.
//
// Recursion guard: once the `claude` command name is taken over by the
// Anyswitch shim, an override that resolves back to a shim / bare command name /
// non-.exe wrapper would make the launcher re-invoke itself, spinning up relays
// forever. So an override is only honoured when it is an ABSOLUTE path to a
// .exe. Anything else is rejected loudly rather than silently recursing.
export function resolveClaudeExecutable(base = process.env) {
  const override = base.CLAUDE_EXECUTABLE;
  if (override === undefined || override === null || override === "") {
    return defaultClaudeExecutable(base);
  }
  if (!isAbsolute(override)) {
    throw new Error(
      `CLAUDE_EXECUTABLE must be an absolute path to claude.exe, got "${override}". ` +
        `A bare name or relative path could resolve back to the Anyswitch shim and ` +
        `make the launcher recurse into itself.`,
    );
  }
  if (!/\.exe$/i.test(override)) {
    throw new Error(
      `CLAUDE_EXECUTABLE must point at a .exe, got "${override}". ` +
        `Pointing it at a .cmd/.ps1/shim wrapper could make the launcher recurse into itself.`,
    );
  }
  // Convert backslashes to forward slashes to prevent spawn() path corruption on Windows.
  return override.replace(/\\/g, '/');
}

function claudeExecutable() {
  return resolveClaudeExecutable(process.env);
}

// Probe `claude --version`. Returns the semver-looking token, or null if the
// binary is missing, the output can't be parsed, or the probe times out (a
// null version flows into the existing unknown-version downgrade path — this
// never throws). The deadline guards against a hung `claude --version` (broken
// shim, stuck child) blocking the launch forever.
const CLAUDE_VERSION_TIMEOUT_MS = 15_000;

export function realGetClaudeVersion({ spawnFn = spawn, timeoutMs = CLAUDE_VERSION_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const execPath = claudeExecutable();
    let child;
    try {
      child = spawnFn(execPath, ["--version"], { shell: false, windowsHide: true });
    } catch (err) {
      // Enhanced error diagnostics for spawn failures
      if (err.code === 'ENOENT' || err.errno === -4058) {
        console.error(`\n⚠️  Claude executable spawn failed (${err.code || 'errno ' + err.errno})`);
        console.error(`   Path attempted: ${execPath}`);
        console.error(`   This may indicate a path escaping issue or missing file.`);
        console.error(`   Open the Anyswitch panel for diagnostics, or reinstall Claude Code.\n`);
      }
      resolve(null);
      return;
    }
    let settled = false;
    let out = "";
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    child.stdout?.on("data", (c) => (out += c));
    child.on("error", () => finish(null));
    child.on("close", () => {
      const match = out.match(/(\d+\.\d+\.\d+)/);
      finish(match ? match[1] : null);
    });
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs);
  });
}

// Spawn Claude with the terminal inherited so the interactive picker and SSE
// streaming work. Resolves with { code, pid } — the exit code and the child's
// PID. The PID lets the session reporter tell the panel which claude.exe
// process to track for liveness.
function realSpawnClaude({ env, args, onPid = () => {} }) {
  return new Promise((resolve, reject) => {
    const target = claudeExecutable();
    const child = spawn(target, args, {
      env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    // Notify the caller of the PID immediately — before exit — so the session
    // reporter can start pushing metrics while Claude is still running.
    if (child.pid) onPid(child.pid);
    child.on("error", (err) => {
      reject(
        new Error(
          `Failed to spawn Claude executable at "${target}": ${err.message}.\n` +
            `If Claude Code is missing or corrupted, please run: cd %APPDATA%\\npm\\node_modules\\@anthropic-ai\\claude-code && node install.cjs (or npm install -g @anthropic-ai/claude-code)`,
        ),
      );
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

// The per-launch Claude relay owns no log file and must not write the
// terminal (Claude Code owns the TTY). Forward its log entries to the
// standalone panel host (47820) instead: the ingest endpoint re-publishes
// them through the panel's logger bus, so keep-alive retries and stream
// faults appear in the 实时输出 window next to the resident relay's entries.
// Best-effort like the metrics reporter — never break the relay over a
// logging failure.
const PANEL_INGEST_URL = "http://127.0.0.1:47820/panel/api/logs/ingest";

function createForwardingLogger(fetchFn = fetch) {
  const forward = (level) => (message) => {
    fetchFn(PANEL_INGEST_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-anyswitch-panel": "1",
        origin: "http://127.0.0.1:47820",
      },
      body: JSON.stringify({ level, message: String(message) }),
    }).catch(() => {
      // Panel down or starting — logging is best-effort, drop the entry.
    });
  };
  return { info: forward("info"), warn: forward("warn"), error: forward("error") };
}

// When neither ANTHROPIC_SMALL_FAST_MODEL nor ANYSWITCH_SMALL_FAST_MODEL is
// configured, derive the classifier (small-fast) wire ID from the local store:
// the first model of the first provider. Best-effort — on any failure the
// environment is left untouched and DEFAULT_SMALL_FAST_MODEL_WIRE_ID applies.
function withStoreSmallFastDefault(base) {
  if (base.ANTHROPIC_SMALL_FAST_MODEL !== undefined || base.ANYSWITCH_SMALL_FAST_MODEL !== undefined) {
    return base;
  }
  try {
    const storePath = join(
      base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"),
      "ApiCred",
      "store.json",
    );
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    for (const [providerId, provider] of Object.entries(store.providers ?? {})) {
      const modelId = Object.keys(provider?.models ?? {})[0];
      if (modelId) {
        return { ...base, ANYSWITCH_SMALL_FAST_MODEL: `anthropic/${providerId}/${modelId}` };
      }
    }
  } catch {
    // Store missing or unreadable — the relay start probe reports that itself.
  }
  return base;
}

export async function main(argv = process.argv.slice(2)) {
  // The per-launch relay runs inside this process and shares the user's
  // terminal with Claude. A stray promise rejection must not kill the whole
  // launch (and dump a raw stack into Claude's UI) — note it and continue.
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`relay warning: unhandled rejection: ${reason?.message ?? reason}\n`);
  });
  const code = await runLauncher({
    startRelay: () => startProductionRelay({ logger: createForwardingLogger() }),
    getClaudeVersion: realGetClaudeVersion,
    spawnClaude: realSpawnClaude,
    log: (line) => process.stderr.write(`${line}\n`),
    base: withStoreSmallFastDefault(process.env),
    claudeArgs: argv,
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
      process.stderr.write(`launcher failed: ${error.message}\n`);
      process.exit(1);
    },
  );
}
