// Atomic write + cross-process lock unit tests (Phase 2.4). Real fs on temp
// dirs only; no credentials, no network, no DPAPI.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  atomicWriteFile,
  casWriteFile,
  contentHash,
  pruneBackups,
  withFileLock,
  PreconditionFailedError,
  LockTimeoutError,
} from "./atomic-write.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "atomic-write-test-"));
}

test("atomicWriteFile replaces content and leaves no temp files", () => {
  const dir = tempDir();
  const target = join(dir, "store.json");
  writeFileSync(target, "old", "utf8");
  atomicWriteFile(target, "new");
  assert.equal(readFileSync(target, "utf8"), "new");
  assert.deepEqual(readdirSync(dir), ["store.json"], "no orphaned .tmp files");
});

test("atomicWriteFile retries transient EPERM on rename and eventually succeeds", () => {
  const dir = tempDir();
  const target = join(dir, "config.json");
  writeFileSync(target, "old", "utf8");

  let calls = 0;
  const flakyFs = {
    writeFileSync: (...args) => writeFileSync(...args),
    // Fail the first two renames with EPERM (AV/indexer transient lock), then pass.
    renameSync: (temp, dest) => {
      calls += 1;
      if (calls <= 2) {
        const error = new Error(`EPERM: rename ${temp} -> ${dest}`);
        error.code = "EPERM";
        throw error;
      }
      return renameSync(temp, dest);
    },
    rmSync: (...args) => rmSync(...args),
  };

  atomicWriteFile(target, "new", { fs: flakyFs });
  assert.equal(calls, 3, "two transient failures then success");
  assert.equal(readFileSync(target, "utf8"), "new");
  assert.deepEqual(readdirSync(dir), ["config.json"], "no orphaned .tmp files");
});

test("atomicWriteFile surfaces persistent EPERM after bounded retries", () => {
  const dir = tempDir();
  const target = join(dir, "config.json");
  writeFileSync(target, "old", "utf8");

  let calls = 0;
  const lockedFs = {
    writeFileSync: (...args) => writeFileSync(...args),
    renameSync: (temp, dest) => {
      calls += 1;
      const error = new Error(`EPERM: rename ${temp} -> ${dest}`);
      error.code = "EPERM";
      throw error;
    },
    rmSync: (...args) => rmSync(...args),
  };

  assert.throws(() => atomicWriteFile(target, "new", { fs: lockedFs }), /EPERM/);
  assert.equal(calls, 4, "initial attempt + 3 retries");
  assert.equal(readFileSync(target, "utf8"), "old", "target must survive");
  assert.deepEqual(readdirSync(dir), ["config.json"], "temp file cleaned up");
});

test("casWriteFile expect-absent create writes once and refuses to clobber", () => {
  const dir = tempDir();
  const target = join(dir, "credential.dpapi");
  casWriteFile(target, "first", { expectedHash: null });
  assert.equal(readFileSync(target, "utf8"), "first");

  assert.throws(
    () => casWriteFile(target, "second", { expectedHash: null }),
    (error) =>
      error instanceof PreconditionFailedError &&
      /expected .* to be absent/.test(error.message),
  );
  assert.equal(readFileSync(target, "utf8"), "first", "existing content must survive");
});

test("casWriteFile hash match writes; stale hash is rejected without writing", () => {
  const dir = tempDir();
  const target = join(dir, "store.json");
  writeFileSync(target, "v1", "utf8");
  const hash = contentHash("v1");

  casWriteFile(target, "v2", { expectedHash: hash });
  assert.equal(readFileSync(target, "utf8"), "v2");

  const stale = contentHash("v0");
  assert.throws(
    () => casWriteFile(target, "v3", { expectedHash: stale }),
    (error) =>
      error instanceof PreconditionFailedError &&
      /modified since the expected snapshot/.test(error.message),
  );
  assert.equal(readFileSync(target, "utf8"), "v2", "failed CAS must not write");
});

test("casWriteFile hash path rejects an absent target", () => {
  const dir = tempDir();
  assert.throws(
    () => casWriteFile(join(dir, "absent.json"), "x", { expectedHash: contentHash("y") }),
    (error) => error instanceof PreconditionFailedError && /to exist/.test(error.message),
  );
});

test("withFileLock runs the critical section and always removes the lock", () => {
  const dir = tempDir();
  const target = join(dir, "store.json");
  let ran = false;
  withFileLock(target, () => {
    ran = true;
  });
  assert.equal(ran, true);
  assert.equal(existsSync(`${target}.lock`), false, "lock must be released");

  let threw = null;
  try {
    withFileLock(target, () => {
      throw new Error("boom");
    });
  } catch (error) {
    threw = error;
  }
  assert.equal(threw?.message, "boom");
  assert.equal(existsSync(`${target}.lock`), false, "lock must be released on throw");
});

test("withFileLock times out against a live lock, then succeeds once it is gone", () => {
  const dir = tempDir();
  const target = join(dir, "store.json");
  const lockPath = `${target}.lock`;
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");

  assert.throws(
    () => withFileLock(target, () => {}, { waitMs: 20 }),
    (error) => error instanceof LockTimeoutError,
  );

  // Owner releases; the same target is now writable.
  rmSync(lockPath, { force: true });
  let ran = false;
  withFileLock(target, () => {
    ran = true;
  });
  assert.equal(ran, true);
});

test("withFileLock reclaims a lock left by a dead owner", async () => {
  const dir = tempDir();
  const target = join(dir, "store.json");
  const lockPath = `${target}.lock`;

  // A real child process that we terminate: its pid is a genuine dead owner.
  const dead = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    child.once("spawn", () => {
      child.kill();
      child.once("exit", () => resolve(child.pid));
    });
    child.once("error", reject);
  });
  assert.ok(dead > 0);
  writeFileSync(lockPath, JSON.stringify({ pid: dead, at: Date.now() }), "utf8");

  let ran = false;
  withFileLock(target, () => {
    ran = true;
  });
  assert.equal(ran, true, "dead owner's lock must be reclaimed");
  assert.equal(existsSync(lockPath), false);
});

test("casWriteFile hash path honors the cross-process lock", () => {
  const dir = tempDir();
  const target = join(dir, "store.json");
  writeFileSync(target, "v1", "utf8");
  const hash = contentHash("v1");

  // Simulate a live foreign holder.
  writeFileSync(`${target}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
  assert.throws(
    () => casWriteFile(target, "v2", { expectedHash: hash, lockWaitMs: 20 }),
    (error) => error instanceof LockTimeoutError,
  );
  assert.equal(readFileSync(target, "utf8"), "v1", "lock contention must not write");
  assert.equal(existsSync(`${target}.lock`), true, "foreign lock must not be removed");

  // After the holder releases, the same CAS succeeds.
  rmSync(`${target}.lock`, { force: true });
  casWriteFile(target, "v2", { expectedHash: hash });
  assert.equal(readFileSync(target, "utf8"), "v2");
});

test("pruneBackups keeps only the newest `keep` backups by name order", () => {
  const dir = tempDir();
  for (let i = 1; i <= 7; i++) {
    writeFileSync(join(dir, `config.backup.2026-01-0${i}T00-00-00-000Z.toml`), `v${i}`, "utf8");
  }
  pruneBackups(dir, "config.backup.", 5);
  const remaining = readdirSync(dir).sort();
  assert.deepEqual(remaining, [
    "config.backup.2026-01-03T00-00-00-000Z.toml",
    "config.backup.2026-01-04T00-00-00-000Z.toml",
    "config.backup.2026-01-05T00-00-00-000Z.toml",
    "config.backup.2026-01-06T00-00-00-000Z.toml",
    "config.backup.2026-01-07T00-00-00-000Z.toml",
  ]);
});

test("pruneBackups keeps everything when at or below the keep limit", () => {
  const dir = tempDir();
  for (let i = 1; i <= 5; i++) {
    writeFileSync(join(dir, `config.backup.2026-01-0${i}T00-00-00-000Z.toml`), `v${i}`, "utf8");
  }
  pruneBackups(dir, "config.backup.", 5);
  assert.equal(readdirSync(dir).length, 5);

  const emptyDir = tempDir();
  pruneBackups(emptyDir, "config.backup.", 5);
  assert.equal(readdirSync(emptyDir).length, 0);
});

test("pruneBackups only touches files with the exact prefix", () => {
  const dir = tempDir();
  const files = [
    "models.backup.2026-01-01T00-00-00-000Z.json",
    "models.backup.2026-01-02T00-00-00-000Z.json",
    // pi's own backups in ~/.pi/agent — "models.backup." must not match them.
    "models-store.backup.2025-01-01T00-00-00-000Z.json",
    // Same-family foreign names and the main file itself stay untouched.
    "models.json",
    "config.backup.2026-01-01T00-00-00-000Z.json",
    "my-models.backup.2026-01-01T00-00-00-000Z.json",
  ];
  for (const name of files) {
    writeFileSync(join(dir, name), "x", "utf8");
  }
  mkdirSync(join(dir, "models.backup.not-a-file"));
  pruneBackups(dir, "models.backup.", 1);
  const remaining = readdirSync(dir).sort();
  assert.deepEqual(remaining, [
    "config.backup.2026-01-01T00-00-00-000Z.json",
    "models-store.backup.2025-01-01T00-00-00-000Z.json",
    "models.backup.2026-01-02T00-00-00-000Z.json",
    "models.backup.not-a-file",
    "models.json",
    "my-models.backup.2026-01-01T00-00-00-000Z.json",
  ]);
});

test("pruneBackups is a no-op for a missing directory", () => {
  const dir = join(tempDir(), "does-not-exist");
  pruneBackups(dir, "config.backup.", 5);
  assert.equal(existsSync(dir), false);
});

test("pruneBackups defaults to keeping 5", () => {
  const dir = tempDir();
  for (let i = 1; i <= 8; i++) {
    writeFileSync(join(dir, `config.backup.2026-01-0${i}T00-00-00-000Z.toml`), `v${i}`, "utf8");
  }
  pruneBackups(dir, "config.backup.");
  const remaining = readdirSync(dir).sort();
  assert.equal(remaining.length, 5);
  assert.equal(remaining[0], "config.backup.2026-01-04T00-00-00-000Z.toml");
});
