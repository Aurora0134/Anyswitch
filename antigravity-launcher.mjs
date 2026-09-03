// Launcher for antigravity (agy) pointing at the resident ApiCred relay.
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { loadOrGenerateToken } from "./pi-relay-token.mjs";

const DEFAULT_AGY_PATH = join(
  process.env.LOCALAPPDATA ?? "",
  "agy",
  "bin",
  "antigravity.exe",
);

function apiCredRoot(base = process.env) {
  return join(
    base.LOCALAPPDATA ?? join(base.USERPROFILE ?? "", "AppData", "Local"),
    "ApiCred",
  );
}

// agy's grep_search tool shells out to a bare `grep` binary (its CLI falls back
// to PATH lookup when no IDE app root is present). System PATH only contains
// Git\cmd, so prepend Git's usr\bin (grep.exe and friends) for the agy process
// only. Prepend (not append) so GNU find/sort win over the unrelated System32
// namesakes inside this child process.
function withAgyUnixTools(pathVar) {
  const gitUsrBin = join(
    process.env.ProgramFiles ?? "C:\\Program Files",
    "Git",
    "usr",
    "bin",
  );
  if (!existsSync(join(gitUsrBin, "grep.exe"))) {
    return pathVar;
  }
  const current = pathVar ?? "";
  if (current.split(";").includes(gitUsrBin)) return current;
  return `${gitUsrBin};${current}`;
}

// Same loopback rule as the kimi/dsh launchers: relay traffic (which carries
// the session token in the URL/query) must stay on loopback even when the
// user has HTTP_PROXY set — otherwise the proxy would see the token.
const LOOPBACK_NO_PROXY = "127.0.0.1,localhost";

// Unified per-instance id (same scheme as the other endpoint launchers):
// `<cwd basename>-<launcher pid>`, basename scrubbed to the relay's accepted
// charset [A-Za-z0-9._:-] and the whole id capped at 64 chars; falls back to
// `<endpoint>-<pid>` when the basename scrubs to empty. The launcher process
// maps 1:1 to a client instance, so its own pid is the discriminator.
export function buildInstanceId({
  cwd = process.cwd(),
  pid = process.pid,
  endpoint = "agy",
} = {}) {
  const base = basename(cwd).replace(/[^A-Za-z0-9._:-]/g, "-");
  const id = base ? `${base}-${pid}` : `${endpoint}-${pid}`;
  return id.slice(0, 64);
}

export function buildAntigravityEnv({
  token,
  instanceId,
  relayPort = 47821,
  base = process.env,
  extraEnv = {},
}) {
  const relayBaseUrl = `http://127.0.0.1:${relayPort}`;
  return {
    ...base,
    // Relay-side gemini auth accepts `token.instanceId`: the base segment is
    // authenticated as before and the suffix tags per-instance stats. The
    // generated token is hex-only, so `.` unambiguously delimits the suffix.
    GEMINI_API_KEY: instanceId ? `${token}.${instanceId}` : token,
    GOOGLE_GEMINI_BASE_URL: relayBaseUrl,
    GEMINI_BASE_URL: relayBaseUrl,
    PATH: withAgyUnixTools(base.PATH),
    NO_PROXY: LOOPBACK_NO_PROXY,
    no_proxy: LOOPBACK_NO_PROXY,
    ...extraEnv,
  };
}

export function launchAntigravity(options = {}) {
  const agyPath = options.agyPath ?? DEFAULT_AGY_PATH;
  if (!existsSync(agyPath)) {
    throw new Error(`antigravity executable not found at: ${agyPath}`);
  }

  const root = apiCredRoot();
  const token = options.token ?? loadOrGenerateToken(root);
  const relayPort = options.relayPort ?? 47821;

  const env = buildAntigravityEnv({
    token,
    instanceId: options.instanceId ?? buildInstanceId(),
    relayPort,
    base: process.env,
    extraEnv: options.extraEnv,
  });

  const child = spawn(agyPath, options.args ?? [], {
    env,
    stdio: "inherit",
    detached: options.detached ?? false,
  });

  return child;
}

// CLI entry: forward argv (e.g. `agy --version`, `agy -p "..."`) through to
// the agy process — the pre-fix entry swallowed them silently.
export function main(argv = process.argv.slice(2), launchImpl = launchAntigravity) {
  const child = launchImpl({ args: argv });
  child.on("exit", (code) => process.exit(code ?? 0));
}

if (process.argv[1] && process.argv[1].endsWith("antigravity-launcher.mjs")) {
  try {
    main();
  } catch (err) {
    console.error(`Failed to launch antigravity: ${err.message}`);
    process.exit(1);
  }
}
