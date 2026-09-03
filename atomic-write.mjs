// Global ApiCred atomic write helpers.
//
// Single-file replacement via temp file + atomic rename.
// `atomicWriteFile` is a last-writer-wins atomic replace. `casWriteFile` layers
// an optimistic compare-and-swap precondition (expected content hash) so that
// callers can adopt optimistic concurrency without breaking this API's shape.
// No crash-recovery state machine lives here.
//
// Closing the CAS TOCTOU window:
//   - expect-absent create (expectedHash: null) uses O_EXCL ("wx") create
//     directly, so there is no check-then-rename gap for a concurrent creator
//     to slip into. This mirrors the `wx` idiom the early CLI already uses.
//   - the hash-match path holds a cross-process advisory lock (exclusive-create
//     lock file with stale-lock reclamation) around the read-check-rename
//     sequence, so a concurrent writer cannot modify the target between the
//     check and the rename.
// `atomicWriteFile` stays unlocked by design: it carries no precondition, so
// there is nothing to violate; it is the documented last-writer-wins path.

import {
  existsSync as realExistsSync,
  readFileSync as realReadFileSync,
  readdirSync as realReaddirSync,
  renameSync as realRenameSync,
  rmSync as realRmSync,
  statSync as realStatSync,
  writeFileSync as realWriteFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const realFs = {
  existsSync: realExistsSync,
  readFileSync: realReadFileSync,
  readdirSync: realReaddirSync,
  renameSync: realRenameSync,
  rmSync: realRmSync,
  statSync: realStatSync,
  writeFileSync: realWriteFileSync,
};

export class PreconditionFailedError extends Error {
  constructor(message) {
    super(message);
    this.name = "PreconditionFailedError";
  }
}

export class LockTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "LockTimeoutError";
  }
}

// Stable content hash used only for optimistic CAS comparison. Not a security
// primitive; it never touches secrets (store.json carries no secrets).
export function contentHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Windows rename over an existing file can transiently fail with EPERM/EACCES
// when an antivirus scanner or the search indexer holds a handle on the target
// for a few milliseconds. Retry a bounded number of times before surfacing the
// error; the sync sleeps mirror the lock retry loop's blocking discipline.
const RENAME_RETRY_ATTEMPTS = 3;
const RENAME_RETRY_BASE_MS = 25;

function renameSyncWithRetry(fs, temp, target) {
  let lastError;
  for (let attempt = 0; attempt <= RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(temp, target);
      return;
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
      lastError = error;
      if (attempt < RENAME_RETRY_ATTEMPTS) {
        sleepSync(RENAME_RETRY_BASE_MS * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

// Atomically replace `target` with `content` via a sibling temp file + rename.
// On any failure the temp file is removed and the existing target is left
// untouched (no half-written file). Last-writer-wins; no concurrency guarantee.
export function atomicWriteFile(target, content, { fs = realFs } = {}) {
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, content, { encoding: "utf8" });
    renameSyncWithRetry(fs, temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // best-effort cleanup; surface the original error below
    }
    throw error;
  }
}

// Prune timestamped backup files (`<prefix><ts>.<ext>`, e.g.
// `config.backup.2026-08-30T17-22-18-622Z.toml`) down to the newest `keep`.
// The embedded ISO timestamp sorts lexicographically in chronological order,
// so a plain name sort ranks the backups by age. `backupPrefix` must be the
// caller's exact backup-name prefix ("config.backup.", "settings.backup.",
// "models.backup.", ".env.backup." …): a loose prefix would risk deleting
// foreign look-alike files — e.g. pi's own `models-store.backup.*` under
// ~/.pi/agent, which the exact "models.backup." prefix never matches.
// Unbounded retention had already piled up hundreds of token-bearing backups
// (233 in one production data directory), so callers prune right after the main file write
// succeeds. A missing dir is a no-op; an undeletable backup is skipped rather
// than failing the merge that just succeeded.
export function pruneBackups(dir, backupPrefix, keep = 5, { fs = realFs } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // dir absent — nothing to prune
  }
  const backups = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(backupPrefix))
    .map((entry) => entry.name)
    .sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
    try {
      fs.rmSync(join(dir, name), { force: true });
    } catch {
      // best-effort cleanup; an undeletable old backup must not fail the merge
    }
  }
}

const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 2_000;

// Synchronous sleep that blocks only this thread. The lock retry loop is
// cross-process, so blocking the event loop for up to `waitMs` is intentional
// and bounded.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another account.
    return error?.code === "EPERM";
  }
}

// A lock is stale when its owner process is gone, or when it is older than
// LOCK_STALE_MS (PID-reuse safety net). Unparsable or vanished locks fall back
// to the mtime age check and are reclaimed when old enough.
function lockIsStale(lockPath, fs) {
  try {
    const info = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (info?.pid !== undefined) {
      return !pidAlive(info.pid) || Date.now() - (info.at ?? 0) > LOCK_STALE_MS;
    }
  } catch {
    // fall through to the mtime check
  }
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch {
    return true;
  }
}

// Run `fn` inside a cross-process advisory lock on `target`. The lock is a
// sibling `<target>.lock` file created with O_EXCL ("wx"); the loser retries
// until `waitMs` elapses, then throws LockTimeoutError. Locks left by a crashed
// or dead owner are reclaimed. The lock file is always removed afterwards.
// `fn` runs synchronously; it must not itself re-enter this lock.
export function withFileLock(target, fn, { fs = realFs, waitMs = LOCK_WAIT_MS } = {}) {
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (lockIsStale(lockPath, fs)) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // lost the reclaim race; the loop retries the wx create
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(`timed out waiting for the lock on ${target}`);
      }
      sleepSync(Math.min(LOCK_RETRY_MS, deadline - Date.now()));
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // lock already gone; nothing to do
    }
  }
}

// Compare-and-swap write. `expectedHash`:
//   - a hash string: target must currently exist and its content hash must match
//   - null: target must currently be absent (expect-absent create)
// `lockWaitMs` bounds how long the hash-match path waits on the cross-process
// lock (default LOCK_WAIT_MS); it exists for tests and tuning.
// Precondition violations throw PreconditionFailedError and never write.
export function casWriteFile(target, content, { expectedHash, fs = realFs, lockWaitMs = LOCK_WAIT_MS } = {}) {
  if (expectedHash === null) {
    // O_EXCL create is itself the atomic primitive: the file appears fully
    // written or not at all, and a concurrent creator can never be clobbered
    // by a later rename (the old temp+rename path could silently overwrite a
    // file another process created between the existsSync check and the
    // rename).
    try {
      fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new PreconditionFailedError(
          `precondition failed: expected ${target} to be absent but it exists`,
        );
      }
      throw error;
    }
    return;
  }

  // Hash-match path: read, compare and rename are not atomic together, so a
  // concurrent writer could slip a change between the check and the rename and
  // be silently overwritten. The advisory lock serializes writers and closes
  // that window; the check still runs inside the lock against the live bytes.
  withFileLock(
    target,
    () => {
      if (!fs.existsSync(target)) {
        throw new PreconditionFailedError(
          `precondition failed: expected ${target} to exist but it is absent`,
        );
      }
      const current = fs.readFileSync(target, "utf8");
      if (contentHash(current) !== expectedHash) {
        throw new PreconditionFailedError(
          `precondition failed: ${target} was modified since the expected snapshot`,
        );
      }
      atomicWriteFile(target, content, { fs });
    },
    { fs, waitMs: lockWaitMs },
  );
}
