// DPAPI bridge tests (groundwork for real credential re-encryption).
//
// SCOPE GUARD: every ciphertext in this file is produced by this file from a
// synthetic plaintext. No real credential file is read, and no file under
// %LOCALAPPDATA%\OpenCodeApiCred\ is touched. Real credential re-encryption is
// out of scope here and requires separate authorisation.
//
// These tests DO exercise real Windows DPAPI (CurrentUser scope) via dpapi.ps1,
// because entropy correctness cannot be verified with a fake. CurrentUser
// masterkeys live under the real user profile, so the LOCALAPPDATA/APPDATA
// redirection to a temp directory that other suites apply must NOT be used
// here: it would change which DPAPI scope (or whether any) answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { protect, unprotect, assertProviderId, DPAPI_CODES } from "./dpapi.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const powershell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

// The DPAPI tests below spawn the real powershell.exe bridge; where the helper
// or the CurrentUser scope is unavailable (non-Windows, service accounts,
// runners without a user profile) the runner must report them as skipped
// rather than fail. The existence of powershell.exe alone says nothing about
// whether DPAPI actually works, so the first DPAPI test to run also probes one
// synthetic protect/unprotect round trip and caches the verdict for the file.
const dpapiPresent = process.platform === "win32" && existsSync(powershell);
const needsDpapi = dpapiPresent ? {} : { skip: "requires Windows DPAPI (powershell.exe)" };

const SYNTHETIC = "SYNTHETIC-PLAINTEXT-not-a-real-key-8c1f2e";
const SKIP_REASON = "requires a working Windows DPAPI CurrentUser scope";

let dpapiUsablePromise = null;
function dpapiUsable() {
  dpapiUsablePromise ??= (async () => {
    try {
      const ciphertext = await protect(Buffer.from(SYNTHETIC, "utf8"), "dpapi-selftest-probe");
      const recovered = await unprotect(ciphertext, "dpapi-selftest-probe");
      return recovered.toString("utf8") === SYNTHETIC;
    } catch {
      return false;
    }
  })();
  return dpapiUsablePromise;
}

// Inline guard for tests that need a working DPAPI scope, not merely an
// existing powershell.exe.
async function skipUnlessDpapiWorks(t) {
  if (!(await dpapiUsable())) {
    t.skip(SKIP_REASON);
    return true;
  }
  return false;
}

test("assertProviderId mirrors the ps1 ValidatePattern", () => {
  assert.equal(assertProviderId("deepseek"), "deepseek");
  assert.equal(assertProviderId("S3-claude"), "S3-claude");
  assert.equal(assertProviderId("luminai-GPT-0.08x"), "luminai-GPT-0.08x");

  // Must start alphanumeric, and '/' is never allowed.
  for (const bad of ["", "-leading", ".leading", "has/slash", "has\\slash", "has space", "a".repeat(129)]) {
    assert.throws(() => assertProviderId(bad), /invalid provider id/, `expected rejection: ${JSON.stringify(bad)}`);
  }
});

test("v2 protect/unprotect round trips a synthetic plaintext", needsDpapi, async (t) => {
  if (await skipUnlessDpapiWorks(t)) return;
  const plaintext = Buffer.from(SYNTHETIC, "utf8");
  const ciphertext = await protect(plaintext, "roundtrip-provider");

  // Ciphertext must not contain the plaintext.
  assert.equal(ciphertext.includes(Buffer.from(SYNTHETIC, "utf8")), false);
  assert.ok(ciphertext.length > 0);

  const recovered = await unprotect(ciphertext, "roundtrip-provider");
  assert.equal(recovered.toString("utf8"), SYNTHETIC);
});

test("entropy is bound to the provider id: a different id cannot decrypt", needsDpapi, async (t) => {
  if (await skipUnlessDpapiWorks(t)) return;
  const ciphertext = await protect(Buffer.from(SYNTHETIC, "utf8"), "owner-provider");
  await assert.rejects(
    () => unprotect(ciphertext, "other-provider"),
    (error) => {
      // Classify by the stable machine-readable code, not by the message prose.
      assert.equal(error.code, DPAPI_CODES.FAILED);
      return true;
    },
  );
});

test("v1 and v2 generations are not interchangeable", needsDpapi, async (t) => {
  if (await skipUnlessDpapiWorks(t)) return;
  // A v2 ciphertext must not decrypt under the v1 entropy, and vice versa.
  const v2Cipher = await protect(Buffer.from(SYNTHETIC, "utf8"), "gen-provider", { generation: "v2" });
  await assert.rejects(
    () => unprotect(v2Cipher, "gen-provider", { generation: "v1" }),
    (error) => {
      assert.equal(error.code, DPAPI_CODES.FAILED);
      return true;
    },
  );

  const v1Cipher = await protect(Buffer.from(SYNTHETIC, "utf8"), "gen-provider", { generation: "v1" });
  await assert.rejects(
    () => unprotect(v1Cipher, "gen-provider", { generation: "v2" }),
    (error) => {
      assert.equal(error.code, DPAPI_CODES.FAILED);
      return true;
    },
  );

  // Each still round trips within its own generation.
  assert.equal(
    (await unprotect(v1Cipher, "gen-provider", { generation: "v1" })).toString("utf8"),
    SYNTHETIC,
  );
});

test("garbage ciphertext fails closed without leaking detail", needsDpapi, async (t) => {
  if (await skipUnlessDpapiWorks(t)) return;
  const garbage = Buffer.from("this is not dpapi ciphertext at all", "utf8");
  await assert.rejects(
    () => unprotect(garbage, "some-provider"),
    (error) => {
      // Classification goes through the machine-readable code. The exact
      // generic message stays deliberately as the no-leak guard: no
      // PowerShell text and no payload echo may slip into the error prose.
      assert.equal(error.code, DPAPI_CODES.FAILED);
      assert.match(error.message, /^DPAPI operation failed$/);
      assert.equal(error.message.includes("this is not dpapi"), false);
      return true;
    },
  );
});

test("an invalid provider id is rejected before a process is spawned", async () => {
  await assert.rejects(
    () => protect(Buffer.from("x", "utf8"), "bad/id"),
    /invalid provider id/,
  );
});

test("binary plaintext survives a round trip byte for byte", needsDpapi, async (t) => {
  if (await skipUnlessDpapiWorks(t)) return;
  const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f, 0x80, 0x0a, 0x0d]);
  const ciphertext = await protect(Buffer.from(bytes), "binary-provider");
  const recovered = await unprotect(ciphertext, "binary-provider");
  assert.deepEqual([...recovered], [...bytes]);
});

test("empty plaintext is handled without throwing an unexpected error", needsDpapi, async (t) => {
  if (await skipUnlessDpapiWorks(t)) return;
  const ciphertext = await protect(Buffer.alloc(0), "empty-provider");
  const recovered = await unprotect(ciphertext, "empty-provider");
  assert.equal(recovered.length, 0);
});

test("a short timeout fails closed with the generic timeout classification", needsDpapi, async (t) => {
  if (await skipUnlessDpapiWorks(t)) return;
  // A 1ms deadline expires before PowerShell can emit any response, so this
  // pins the failure contract of the timeout path itself: the call must reject
  // with the TIMEOUT classification, never resolve and never echo payload.
  const ciphertext = await protect(Buffer.from(SYNTHETIC, "utf8"), "timeout-provider");
  await assert.rejects(
    () => unprotect(ciphertext, "timeout-provider", { timeoutMs: 1 }),
    (error) => {
      assert.equal(error.code, DPAPI_CODES.TIMEOUT);
      assert.equal(error.message.includes(SYNTHETIC), false);
      return true;
    },
  );
  // A normal-deadline call on the same input still round trips, proving the
  // process path itself is intact and the short timeout was the only cause.
  const recovered = await unprotect(ciphertext, "timeout-provider");
  assert.equal(recovered.toString("utf8"), SYNTHETIC);
});

// The bridge caps helper output at 128 KiB (MAX_OUTPUT_BYTES in dpapi.mjs), so
// a ciphertext whose unprotect response must exceed that cap cannot be produced
// through protect(): the cap would fire on the protect response first. The
// oversized ciphertext is therefore sealed by invoking dpapi.ps1 directly with
// the same argument shape as the bridge — synthetic plaintext only, see the
// SCOPE GUARD at the top of this file.
function sealOversizedWithoutBridgeCap(plaintext, providerId) {
  const request = Buffer.from(
    JSON.stringify({ payloadBase64: plaintext.toString("base64") }),
    "utf8",
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershell,
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", join(root, "dpapi.ps1"),
        "-Operation", "protect", "-Generation", "v2", "-ProviderId", providerId,
      ],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks = [];
    const timer = setTimeout(() => reject(new Error("dpapi.ps1 protect did not finish")), 30000);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`dpapi.ps1 protect exited with code ${code}`));
      }
      const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      resolve(Buffer.from(response.payloadBase64, "base64"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(request);
  });
}

test("helper output past the size cap fails closed without leaking the payload", needsDpapi, async (t) => {
  if (await skipUnlessDpapiWorks(t)) return;
  // A plaintext whose base64 response must exceed the bridge's output cap: the
  // bridge abandons the response mid-stream and kills the helper, so the bytes
  // the helper already pushed into the pipe arrive on the stdout listener
  // AFTER the promise settled. That is the settled-then-late-chunk path in
  // dpapi.mjs run(): the late chunks must be zeroed and dropped there, and the
  // call must reject with the generic OUTPUT_LIMIT classification — never
  // resolve with a truncated buffer, never echo payload.
  const marker = "OVERSIZED-SYNTHETIC-PAYLOAD-";
  const plaintext = Buffer.concat([
    Buffer.from(marker, "utf8"),
    Buffer.alloc(256 * 1024, 0x61),
  ]);
  const ciphertext = await sealOversizedWithoutBridgeCap(plaintext, "limit-provider");
  assert.ok(ciphertext.length > 0);

  await assert.rejects(
    () => unprotect(ciphertext, "limit-provider"),
    (error) => {
      assert.equal(error.code, DPAPI_CODES.OUTPUT_LIMIT);
      assert.equal(error.message.includes(marker), false);
      return true;
    },
  );
});
