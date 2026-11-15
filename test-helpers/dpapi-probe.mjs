import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This probe deliberately does not import src/ops/dpapi.mjs. A green probe is
// independent evidence that CurrentUser DPAPI and the script protocol work;
// failures in the production bridge after that point must remain test failures.
export const DPAPI_PROBE_PLAINTEXT = "anyswitch-synthetic-dpapi-probe";

function helperEnvironment(env) {
  const minimal = {};
  for (const key of ["SystemRoot", "WINDIR", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "PATH"]) {
    if (env[key]) minimal[key] = env[key];
  }
  return minimal;
}

function invokeHelper(spawnFn, powershell, scriptPath, operation, payload, env) {
  return new Promise((resolve, reject) => {
    const request = Buffer.from(JSON.stringify({ payloadBase64: payload.toString("base64") }));
    const output = [];
    let size = 0;
    let settled = false;
    const child = spawnFn(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath, "-Operation", operation, "-Generation", "v2",
      "-ProviderId", "anyswitch-test-environment-probe",
    ], { env: helperEnvironment(env), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => finish(new Error("DPAPI probe timed out")), 30_000);
    function finish(error, result = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.fill(0);
      for (const chunk of output) chunk.fill(0);
      if (error) {
        child.kill();
        reject(error);
        return;
      }
      resolve(result);
    }
    child.stdout.on("data", (chunk) => {
      if (settled) { chunk.fill(0); return; }
      size += chunk.length;
      if (size > 64 * 1024) return finish(new Error("DPAPI probe response too large"));
      output.push(chunk);
    });
    child.stderr.on("data", (chunk) => chunk.fill(0));
    child.on("error", () => finish(new Error("DPAPI probe helper could not start")));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error("DPAPI probe helper failed"));
      try {
        const response = JSON.parse(Buffer.concat(output).toString("utf8"));
        if (response?.ok !== true || typeof response.payloadBase64 !== "string") {
          return finish(new Error("DPAPI probe returned an invalid response"));
        }
        finish(null, Buffer.from(response.payloadBase64, "base64"));
      } catch {
        finish(new Error("DPAPI probe returned an invalid response"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(request);
  });
}

export async function probeDpapi({
  platform = process.platform,
  env = process.env,
  spawnFn = spawn,
  scriptPath = join(dirname(dirname(fileURLToPath(import.meta.url))), "dpapi.ps1"),
  existsFn = existsSync,
} = {}) {
  if (platform !== "win32") return { available: false, reason: "requires Windows CurrentUser DPAPI" };
  const powershell = join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsFn(powershell) || !existsFn(scriptPath)) {
    return { available: false, reason: "requires Windows PowerShell and the DPAPI helper" };
  }
  const plaintext = Buffer.from(DPAPI_PROBE_PLAINTEXT);
  let ciphertext = null;
  let recovered = null;
  try {
    ciphertext = await invokeHelper(spawnFn, powershell, scriptPath, "protect", plaintext, env);
    recovered = await invokeHelper(spawnFn, powershell, scriptPath, "unprotect", ciphertext, env);
    if (!recovered.equals(plaintext)) throw new Error("DPAPI probe round trip did not match");
    return { available: true };
  } catch (error) {
    return { available: false, reason: `CurrentUser DPAPI probe failed: ${error.message}` };
  } finally {
    plaintext.fill(0);
    ciphertext?.fill(0);
    recovered?.fill(0);
  }
}

export function dpapiTestOptions(probe, { required = process.env.ANYSWITCH_REQUIRE_DPAPI === "1" } = {}) {
  if (probe.available) return {};
  if (required) throw new Error(`Real DPAPI is required by this test run: ${probe.reason}`);
  return { skip: probe.reason };
}
