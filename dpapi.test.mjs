// DPAPI bridge tests (groundwork for real credential re-encryption).
//
// SCOPE GUARD: every ciphertext in this file is produced by this file from a
// synthetic plaintext. No real credential file is read, and no file under
// %LOCALAPPDATA%\OpenCodeApiCred\ is touched. Real credential re-encryption is
// out of scope here and requires separate authorisation.
//
// These tests DO exercise real Windows DPAPI (CurrentUser scope) via dpapi.ps1,
// because entropy correctness cannot be verified with a fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { protect, unprotect, assertProviderId } from "./dpapi.mjs";

// The DPAPI tests below spawn the real powershell.exe bridge; where it is
// unavailable the runner must report them as skipped rather than fail.
const dpapiAvailable = process.platform === "win32" &&
  existsSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
const needsDpapi = dpapiAvailable ? {} : { skip: "requires Windows DPAPI (powershell.exe)" };

const SYNTHETIC = "SYNTHETIC-PLAINTEXT-not-a-real-key-8c1f2e";

test("assertProviderId mirrors the ps1 ValidatePattern", () => {
  assert.equal(assertProviderId("deepseek"), "deepseek");
  assert.equal(assertProviderId("S3-claude"), "S3-claude");
  assert.equal(assertProviderId("luminai-GPT-0.08x"), "luminai-GPT-0.08x");

  // Must start alphanumeric, and '/' is never allowed.
  for (const bad of ["", "-leading", ".leading", "has/slash", "has\\slash", "has space", "a".repeat(129)]) {
    assert.throws(() => assertProviderId(bad), /invalid provider id/, `expected rejection: ${JSON.stringify(bad)}`);
  }
});

test("v2 protect/unprotect round trips a synthetic plaintext", needsDpapi, async () => {
  const plaintext = Buffer.from(SYNTHETIC, "utf8");
  const ciphertext = await protect(plaintext, "roundtrip-provider");

  // Ciphertext must not contain the plaintext.
  assert.equal(ciphertext.includes(Buffer.from(SYNTHETIC, "utf8")), false);
  assert.ok(ciphertext.length > 0);

  const recovered = await unprotect(ciphertext, "roundtrip-provider");
  assert.equal(recovered.toString("utf8"), SYNTHETIC);
});

test("entropy is bound to the provider id: a different id cannot decrypt", needsDpapi, async () => {
  const ciphertext = await protect(Buffer.from(SYNTHETIC, "utf8"), "owner-provider");
  await assert.rejects(
    () => unprotect(ciphertext, "other-provider"),
    /DPAPI operation failed/,
  );
});

test("v1 and v2 generations are not interchangeable", needsDpapi, async () => {
  // A v2 ciphertext must not decrypt under the v1 entropy, and vice versa.
  const v2Cipher = await protect(Buffer.from(SYNTHETIC, "utf8"), "gen-provider", { generation: "v2" });
  await assert.rejects(
    () => unprotect(v2Cipher, "gen-provider", { generation: "v1" }),
    /DPAPI operation failed/,
  );

  const v1Cipher = await protect(Buffer.from(SYNTHETIC, "utf8"), "gen-provider", { generation: "v1" });
  await assert.rejects(
    () => unprotect(v1Cipher, "gen-provider", { generation: "v2" }),
    /DPAPI operation failed/,
  );

  // Each still round trips within its own generation.
  assert.equal(
    (await unprotect(v1Cipher, "gen-provider", { generation: "v1" })).toString("utf8"),
    SYNTHETIC,
  );
});

test("garbage ciphertext fails closed without leaking detail", needsDpapi, async () => {
  const garbage = Buffer.from("this is not dpapi ciphertext at all", "utf8");
  await assert.rejects(
    () => unprotect(garbage, "some-provider"),
    (error) => {
      // Generic message only: no PowerShell text, no payload echo.
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

test("binary plaintext survives a round trip byte for byte", needsDpapi, async () => {
  const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f, 0x80, 0x0a, 0x0d]);
  const ciphertext = await protect(Buffer.from(bytes), "binary-provider");
  const recovered = await unprotect(ciphertext, "binary-provider");
  assert.deepEqual([...recovered], [...bytes]);
});

test("empty plaintext is handled without throwing an unexpected error", needsDpapi, async () => {
  const ciphertext = await protect(Buffer.alloc(0), "empty-provider");
  const recovered = await unprotect(ciphertext, "empty-provider");
  assert.equal(recovered.length, 0);
});

test("a timeout fails closed even if stdout arrives after the operation settled", needsDpapi, async () => {
  // Regression for the settled-then-late-chunk path: a 1ms timeout fires the
  // error finish() before PowerShell can emit its response, so any stdout that
  // the child buffered before it was killed reaches the data listener AFTER
  // settled=true. The listener must zero and drop that late chunk (verified by
  // inspection; it is internal buffer state) and the call must still reject
  // with the generic timeout error rather than resolve or throw unexpectedly.
  const ciphertext = await protect(Buffer.from(SYNTHETIC, "utf8"), "timeout-provider");
  await assert.rejects(
    () => unprotect(ciphertext, "timeout-provider", { timeoutMs: 1 }),
    (error) => {
      assert.match(error.message, /^DPAPI operation timed out$/);
      return true;
    },
  );
  // A normal-timeout call on the same input still round trips, proving the
  // process path itself is intact and the short timeout was the only cause.
  const recovered = await unprotect(ciphertext, "timeout-provider");
  assert.equal(recovered.toString("utf8"), SYNTHETIC);
});
