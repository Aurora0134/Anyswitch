// Global Anyswitch DPAPI bridge.
//
// Wraps dpapi.ps1. Nothing is cached, nothing is logged, and error messages
// never carry the payload, the provider entropy or the underlying PowerShell
// error text.
//
// Buffer ownership contract:
//   - This bridge zeroes every buffer IT allocates (the encoded request, all
//     stdout/stderr chunks, the decoded response on failure) on every exit path,
//     including timeout, spawn failure and non-zero exit.
//   - The caller OWNS the buffer it passes in and the buffer it receives back,
//     and must zero both itself. The input is deliberately left intact because
//     callers legitimately reuse it after the call (e.g. comparing a v2
//     round-trip against the same plaintext that was sealed).
//
// Two generations, two entropies (see dpapi.ps1):
//   v1 -> OpenCodeApiCred|DPAPI|v1|<ProviderId>   (legacy, read-only)
//   v2 -> ApiCred|DPAPI|v2|<ProviderId>           (global store)

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const powershell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_OUTPUT_BYTES = 131072;

// Mirrors the ps1 ValidatePattern so a bad id fails before a process is spawned.
export function assertProviderId(providerId) {
  if (typeof providerId !== "string" || !PROVIDER_ID.test(providerId)) {
    throw new Error("invalid provider id for a DPAPI operation");
  }
  return providerId;
}

function minimalEnvironment() {
  const environment = {};
  for (const key of ["SystemRoot", "WINDIR", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "PATH"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

function run(args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", join(root, "dpapi.ps1"), ...args],
      { env: minimalEnvironment(), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );

    const output = [];
    let size = 0;
    let settled = false;

    const timer = setTimeout(() => finish(new Error("DPAPI operation timed out")), timeoutMs);

    function wipe() {
      input?.fill?.(0);
      for (const chunk of output) chunk.fill(0);
      output.length = 0;
    }

    function finish(error, value) {
      if (settled) {
        value?.fill?.(0);
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        wipe();
        try {
          child.kill();
        } catch {
          // already gone
        }
        reject(error);
        return;
      }
      for (const chunk of output) chunk.fill(0);
      output.length = 0;
      resolve(value);
    }

    child.stdout.on("data", (chunk) => {
      // Once settled (success, timeout, spawn error or size overflow) the output
      // buffer has already been wiped. A late chunk buffered before the child was
      // killed must be zeroed here and dropped, or it would linger unwiped: the
      // close handler returns early when settled and never sees it.
      if (settled) {
        chunk.fill(0);
        return;
      }
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        chunk.fill(0);
        finish(new Error("DPAPI output exceeded the limit"));
        return;
      }
      output.push(chunk);
    });
    // Never surface stderr text: it could echo payload fragments.
    child.stderr?.on("data", (chunk) => chunk.fill(0));
    child.on("error", () => finish(new Error("DPAPI helper could not start")));
    child.on("close", (code) => {
      if (settled) return;
      const combined = Buffer.concat(output);
      if (code !== 0) {
        combined.fill(0);
        finish(new Error("DPAPI operation failed"));
        return;
      }
      finish(null, combined);
    });

    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function decodeResponse(buffer) {
  try {
    const parsed = JSON.parse(buffer.toString("utf8"));
    if (parsed?.ok !== true || typeof parsed.payloadBase64 !== "string") throw new Error();
    return Buffer.from(parsed.payloadBase64, "base64");
  } catch {
    throw new Error("DPAPI returned an invalid response");
  } finally {
    buffer.fill(0);
  }
}

async function transform(operation, generation, providerId, payload, timeoutMs) {
  assertProviderId(providerId);
  const request = Buffer.from(
    JSON.stringify({ payloadBase64: payload.toString("base64") }),
    "utf8",
  );
  try {
    return decodeResponse(
      await run(
        ["-Operation", operation, "-Generation", generation, "-ProviderId", providerId],
        request,
        timeoutMs,
      ),
    );
  } finally {
    request.fill(0);
  }
}

// The caller owns `plaintext` and must zero it; see the ownership contract at
// the top of this file.
export function protect(plaintext, providerId, { generation = "v2", timeoutMs = 30000 } = {}) {
  return transform("protect", generation, providerId, plaintext, timeoutMs);
}

// The caller owns `ciphertext` and the returned plaintext, and must zero both.
export function unprotect(ciphertext, providerId, { generation = "v2", timeoutMs = 30000 } = {}) {
  return transform("unprotect", generation, providerId, ciphertext, timeoutMs);
}
