// Atomic write + cross-process lock unit tests. Real fs on temp
// dirs only; no credentials, no network, no DPAPI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, readdirSync, rmSync, mkdirSync, renameSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  atomicWriteFile,
  casWriteFile,
  contentHash,
  pruneBackups,
  withFileLock,
  withDirectoryLock,
  PreconditionFailedError,
  LockTimeoutError,
} from "./atomic-write.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

function tempDir() {
  return mkTestDir("atomic-write-test-");
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

// --- withDirectoryLock: the ZCode-compatible directory lock -----------------
//
// ZCode locks the files it owns (e.g. ~/.zcode/v2/provider_config.json) with a
// "<file>.lock" directory holding an owner-<pid>-<ts>-<rand>.json credential
// (packages/shared/src/node/atomicFileLock.ts). These tests pin the on-disk
// shape our lock leaves, the mutual exclusion against a ZCode-style holder,
// and the stale-reclamation rules — all aligned with ZCode's own.

// A foreign holder exactly as ZCode's acquireFileLock leaves it on disk.
function holdZcodeStyleLock(target, { pid, createdAt = Date.now(), token = "foreign" } = {}) {
  const lockPath = `${target}.lock`;
  mkdirSync(lockPath);
  const ownerName = `owner-${pid}-${createdAt}-${token}.json`;
  writeFileSync(join(lockPath, ownerName), `${JSON.stringify({ pid, createdAt, token })}\n`, "utf8");
  return { lockPath, ownerName };
}

test("withDirectoryLock runs the critical section and releases the lock directory", () => {
  const dir = tempDir();
  const target = join(dir, "provider_config.json");

  const result = withDirectoryLock(target, () => {
    // While held, the on-disk shape is exactly what a ZCode acquirer expects:
    // a lock directory with a single owner credential it can parse.
    const owners = readdirSync(`${target}.lock`).filter((e) => e.startsWith("owner-") && e.endsWith(".json"));
    assert.equal(owners.length, 1);
    assert.match(owners[0], /^owner-\d+-\d+-[a-z0-9]+\.json$/);
    const raw = readFileSync(join(`${target}.lock`, owners[0]), "utf8");
    assert.ok(raw.endsWith("\n"), "owner credential ends with a newline like ZCode's");
    const meta = JSON.parse(raw);
    assert.equal(meta.pid, process.pid);
    assert.equal(typeof meta.createdAt, "number");
    assert.equal(typeof meta.token, "string");
    return "done";
  });
  assert.equal(result, "done");
  assert.equal(existsSync(`${target}.lock`), false, "lock directory must be released");
});

test("withDirectoryLock releases the lock when fn throws", () => {
  const dir = tempDir();
  const target = join(dir, "provider_config.json");
  assert.throws(() => withDirectoryLock(target, () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(`${target}.lock`), false, "lock must be released on throw");
});

test("withDirectoryLock times out against a live ZCode-style holder and leaves it untouched", () => {
  const dir = tempDir();
  const target = join(dir, "provider_config.json");
  // A live owner pid (this process) is exactly what a running ZCode client
  // holding the lock looks like from the outside.
  const { lockPath, ownerName } = holdZcodeStyleLock(target, { pid: process.pid });

  let ran = false;
  const startedAt = Date.now();
  assert.throws(
    () => withDirectoryLock(target, () => { ran = true; }, { waitMs: 150 }),
    (error) => error instanceof LockTimeoutError,
  );
  assert.ok(Date.now() - startedAt >= 140, "the contender actually waited");
  assert.equal(ran, false, "fn must not run under a foreign lock");
  assert.deepEqual(readdirSync(lockPath), [ownerName], "the live foreign lock is never reclaimed");
  rmSync(lockPath, { recursive: true, force: true });

  // Once the holder releases, the same target locks immediately.
  let after = false;
  withDirectoryLock(target, () => { after = true; }, { waitMs: 150 });
  assert.equal(after, true);
});

test("withDirectoryLock reclaims the lock of a dead owner", async () => {
  const dir = tempDir();
  const target = join(dir, "provider_config.json");

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
  holdZcodeStyleLock(target, { pid: dead });

  let ran = false;
  withDirectoryLock(target, () => { ran = true; });
  assert.equal(ran, true, "a dead owner's lock must be reclaimed");
  assert.equal(existsSync(`${target}.lock`), false);
});

test("withDirectoryLock reclaims an ownerless lock once it outlives the grace", () => {
  const dir = tempDir();
  const target = join(dir, "provider_config.json");
  // No usable pid in the credential: only the age can retire it.
  const lockPath = `${target}.lock`;
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, "owner-0-0-x.json"), JSON.stringify({ createdAt: Date.now() - 60_000 }), "utf8");

  let ran = false;
  withDirectoryLock(target, () => { ran = true; }, { ownerlessGraceMs: 50 });
  assert.equal(ran, true, "an ownerless lock past the grace must be reclaimed");
});

test("withDirectoryLock reclaims an empty lock directory left by a crashed acquirer", () => {
  const dir = tempDir();
  const target = join(dir, "provider_config.json");
  // Crash between mkdir and the owner write leaves a bare directory.
  mkdirSync(`${target}.lock`);

  let ran = false;
  withDirectoryLock(target, () => { ran = true; }, { ownerlessGraceMs: 50, waitMs: 2_000 });
  assert.equal(ran, true, "an empty lock directory past the grace must be reclaimed");
  assert.equal(existsSync(`${target}.lock`), false);
});

test("withDirectoryLock respects a legacy single-file lock with a live owner", () => {
  const dir = tempDir();
  const target = join(dir, "provider_config.json");
  // Older ZCode versions left a plain file at the .lock path; a live one is
  // still a held lock and must survive our timeout untouched.
  const lockPath = `${target}.lock`;
  const content = `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "legacy" })}\n`;
  writeFileSync(lockPath, content, "utf8");

  let ran = false;
  assert.throws(
    () => withDirectoryLock(target, () => { ran = true; }, { waitMs: 150 }),
    (error) => error instanceof LockTimeoutError,
  );
  assert.equal(ran, false);
  assert.equal(readFileSync(lockPath, "utf8"), content, "the live legacy lock is never reclaimed");
});

test("withDirectoryLock reclaims a legacy single-file lock whose owner is gone", () => {
  const dir = tempDir();
  const target = join(dir, "provider_config.json");
  writeFileSync(`${target}.lock`, JSON.stringify({ createdAt: Date.now() - 60_000 }), "utf8");

  let ran = false;
  withDirectoryLock(target, () => { ran = true; }, { ownerlessGraceMs: 50 });
  assert.equal(ran, true);
  assert.equal(existsSync(`${target}.lock`), false, "the reclaimed legacy lock is gone after release");
});

test("withDirectoryLock never reclaims a live holder, not even for a nested acquire", () => {
  const dir = tempDir();
  const target = join(dir, "provider_config.json");

  withDirectoryLock(target, () => {
    // A nested acquire sees our own credential: the pid is alive, so the lock
    // is not stale no matter how long the outer section takes — it waits out
    // the timeout instead of breaking the exclusion.
    assert.throws(
      () => withDirectoryLock(target, () => {}, { waitMs: 120 }),
      (error) => error instanceof LockTimeoutError,
    );
    assert.ok(existsSync(`${target}.lock`), "the outer lock survives the nested timeout");
  });
  assert.equal(existsSync(`${target}.lock`), false);
});

test("withDirectoryLock is seen as a live foreign lock by a ZCode-style acquirer", () => {
  const dir = tempDir();
  const target = join(dir, "provider_config.json");

  // While we hold the lock, a separate process running ZCode's acquire steps
  // (bare mkdir, then owner inspection) must see EEXIST and judge the owner
  // alive — the two directions of the exclusion both hold.
  const childScript = `
    const fs = require("node:fs");
    const path = require("node:path");
    const lockPath = process.argv[1];
    const out = { mkdir: null, owners: null, payloadOk: null, ownerAlive: null };
    try {
      fs.mkdirSync(lockPath);
      out.mkdir = "ACQUIRED";
    } catch (error) {
      out.mkdir = error.code;
    }
    if (out.mkdir === "EEXIST") {
      const owners = fs.readdirSync(lockPath).filter((e) => e.startsWith("owner-") && e.endsWith(".json"));
      out.owners = owners.length;
      if (owners.length === 1) {
        const meta = JSON.parse(fs.readFileSync(path.join(lockPath, owners[0]), "utf8"));
        out.payloadOk = Number.isSafeInteger(meta.pid) && meta.pid > 0 &&
          typeof meta.createdAt === "number" && typeof meta.token === "string";
        try { process.kill(meta.pid, 0); out.ownerAlive = true; }
        catch (error) { out.ownerAlive = error.code !== "ESRCH"; }
      }
    }
    process.stdout.write(JSON.stringify(out));
  `;
  withDirectoryLock(target, () => {
    const child = spawnSync(process.execPath, ["-e", childScript, `${target}.lock`], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const seen = JSON.parse(child.stdout);
    assert.equal(seen.mkdir, "EEXIST", "ZCode's mkdir collides with our held lock directory");
    assert.equal(seen.owners, 1);
    assert.equal(seen.payloadOk, true, "our owner credential parses under ZCode's metadata rules");
    assert.equal(seen.ownerAlive, true, "ZCode's liveness rule judges our process alive");
  });
});
