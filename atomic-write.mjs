// Global Anyswitch atomic write helpers.
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
//
// `withDirectoryLock` is a second, unrelated lock shape: a sibling
// `<target>.lock` DIRECTORY holding an owner credential file, mirroring
// ZCode's own acquireFileLock (packages/shared/src/node/atomicFileLock.ts) so
// Anyswitch and a running ZCode client mutually exclude each other on files
// both sides write (e.g. ~/.zcode/v2/provider_config.json). Never mix the two
// lock shapes on one target: the single-file lock and the directory lock at
// the same path cannot even see each other reliably.

import {
  existsSync as realExistsSync,
  mkdirSync as realMkdirSync,
  readFileSync as realReadFileSync,
  readdirSync as realReaddirSync,
  renameSync as realRenameSync,
  rmdirSync as realRmdirSync,
  rmSync as realRmSync,
  statSync as realStatSync,
  writeFileSync as realWriteFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const realFs = {
  existsSync: realExistsSync,
  mkdirSync: realMkdirSync,
  readFileSync: realReadFileSync,
  readdirSync: realReaddirSync,
  renameSync: realRenameSync,
  rmdirSync: realRmdirSync,
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

// ---------------------------------------------------------------------------
// ZCode-compatible directory lock
//
// ZCode serializes its own writes to the files it owns (notably
// ~/.zcode/v2/provider_config.json, which the running client rewrites with the
// user's default model selection) through a directory lock: a bare mkdir of
// "<file>.lock", then an owner credential file `owner-<pid>-<ts>-<rand>.json`
// holding {"pid","createdAt","token"} plus a trailing newline. withFileLock
// above is a single FILE at the same ".lock" path, which cannot interoperate:
// mkdir over an existing file and a file create over an existing directory do
// not collide on the same errno semantics across platforms. Files a ZCode
// process can write must therefore use this lock instead.
//
// Everything below mirrors the semantics of ZCode's acquireFileLock /
// removeAbandonedLock (packages/shared/src/node/atomicFileLock.ts), ported to
// this module's synchronous discipline (the lock retry loop already blocks via
// sleepSync; our callers are short-lived launcher/sync processes, so a bounded
// blocking wait is acceptable):
//   - same lock path (<file>.lock), same directory shape, same owner file
//     naming and payload, so ZCode's stale checks judge our locks exactly like
//     its own;
//   - ownership re-verified after the owner write (a swapped directory or a
//     second owner means we lost the race and fall back to contention);
//   - a lock is reclaimable only when its owner's process is gone, or when it
//     carries no usable pid and has outlived the ownerless grace — a live
//     owner is never reclaimed no matter how long we have waited, because a
//     waiter's own waiting time says nothing about the current holder;
//   - legacy single-file locks left by older ZCode versions are reclaimed
//     under the same rules (content re-read before deletion);
//   - release removes only our own owner file and best-effort rmdir's the
//     directory, so a lock taken over meanwhile is never disturbed.

const DIR_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400];
const DIR_LOCK_OWNERLESS_GRACE_MS = 100;
const DIR_LOCK_WAIT_MS = 8_000;
// Owner metadata timestamps further in the future than this are treated as
// corrupt (clock skew tolerance), same bound as ZCode.
const DIR_LOCK_MAX_CLOCK_SKEW_MS = 5 * 60_000;

function dirLockErrorCode(error) {
  return typeof error?.code === "string" ? error.code : undefined;
}

// A timestamp is usable only when finite, non-negative and not beyond the
// tolerated clock skew; anything else falls back to the file mtime so corrupt
// metadata cannot park an ownerless lock forever.
function parseDirLockTimestamp(value, observedAt) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= observedAt + DIR_LOCK_MAX_CLOCK_SKEW_MS
    ? value
    : null;
}

function parseDirLockMetadata(raw, observedAt) {
  try {
    const parsed = JSON.parse(raw);
    return {
      createdAt: parseDirLockTimestamp(parsed?.createdAt, observedAt),
      // Only a positive safe-integer pid carries owner semantics: 0, negatives
      // or fractions could make process.kill misjudge a dead owner as alive
      // and strand the lock forever.
      pid:
        typeof parsed?.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
          ? parsed.pid
          : null,
    };
  } catch {
    return { createdAt: null, pid: null };
  }
}

// ZCode's liveness rule: a pid counts as alive unless the OS says it does not
// exist. pidAlive above is stricter (EPERM-only) because the store lock prefers
// reclaiming over waiting on another account's process; the credential format
// here is ZCode's, so its judgement rule applies verbatim.
function dirLockOwnerAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return dirLockErrorCode(error) !== "ESRCH";
  }
}

// When both the metadata timestamp and the mtime are unusable, the grace clock
// can only start when this process first sees that exact lock instance; a
// replaced lock (new dev/ino/birthtime/mtime) restarts it.
function createDirLockObserver() {
  const observations = new Map();
  return (lockPath, lockStat, observedAt) => {
    const identity = [lockStat.dev, lockStat.ino, lockStat.birthtimeMs, lockStat.mtimeMs].join(":");
    const previous = observations.get(lockPath);
    if (previous?.identity === identity) return previous.firstObservedAt;
    observations.set(lockPath, { firstObservedAt: observedAt, identity });
    return observedAt;
  };
}

function dirLockOwnerReclaimable(fs, ownerFile, ownerlessGraceMs, observe) {
  const observedAt = Date.now();
  const raw = fs.readFileSync(ownerFile, "utf8");
  const metadata = parseDirLockMetadata(raw, observedAt);
  let createdAt = metadata.createdAt;
  if (createdAt === null) {
    const ownerStat = fs.statSync(ownerFile);
    createdAt =
      parseDirLockTimestamp(ownerStat.mtimeMs, observedAt) ?? observe(ownerFile, ownerStat, observedAt);
  }
  const ownerExited = metadata.pid !== null && !dirLockOwnerAlive(metadata.pid);
  const ownerlessLockIsStale = metadata.pid === null && observedAt - createdAt >= ownerlessGraceMs;
  return ownerExited || ownerlessLockIsStale;
}

// Best-effort stale-lock reclamation, mirroring ZCode's removeAbandonedLock.
// {removed:false} means "still owned or raced — keep waiting", never an error
// the caller must handle; a genuine fs failure rides back as `error` so the
// acquire loop can surface EACCES/EPERM instead of a misleading timeout.
function removeAbandonedDirLock(fs, lockPath, ownerlessGraceMs, observe) {
  try {
    const lockStat = fs.statSync(lockPath);
    if (lockStat.isDirectory()) {
      const entries = fs.readdirSync(lockPath);
      const owners = entries.filter((entry) => entry.startsWith("owner-") && entry.endsWith(".json"));
      if (owners.length === 1) {
        const ownerFile = join(lockPath, owners[0]);
        if (!dirLockOwnerReclaimable(fs, ownerFile, ownerlessGraceMs, observe)) {
          return { removed: false };
        }
        // Deleting the one observed owner file doubles as the ownership check:
        // if the directory was replaced by a new lock, the new owner's
        // different file name survives this rm and the rmdir below lands on a
        // non-empty directory and refuses.
        fs.rmSync(ownerFile, { force: true });
        fs.rmdirSync(lockPath);
        return { removed: true };
      }

      const observedAt = Date.now();
      const directoryTimestamp =
        parseDirLockTimestamp(lockStat.mtimeMs, observedAt) ?? observe(lockPath, lockStat, observedAt);
      if (observedAt - directoryTimestamp < ownerlessGraceMs) return { removed: false };
      for (const owner of owners) {
        if (!dirLockOwnerReclaimable(fs, join(lockPath, owner), ownerlessGraceMs, observe)) {
          return { removed: false };
        }
      }
      // An empty directory is what a crash between mkdir and the owner write
      // leaves behind; a corrupt one may hold several owners. Only the entries
      // observed above are removed — a fresh owner landing meanwhile makes the
      // rmdir fail instead of being deleted. rmSync(force) swallows individual
      // entries racing away; any other failure aborts the reclaim via the
      // outer catch, same as ZCode's rejecting Promise.all.
      for (const entry of entries) {
        fs.rmSync(join(lockPath, entry), { force: true });
      }
      fs.rmdirSync(lockPath);
      return { removed: true };
    }

    // Legacy single-file lock left by an older ZCode. Reclaim only when the
    // content is still exactly what was judged stale — a replaced file means a
    // new lock we have no verdict on.
    const raw = fs.readFileSync(lockPath, "utf8");
    if (!dirLockOwnerReclaimable(fs, lockPath, ownerlessGraceMs, observe)) {
      return { removed: false };
    }
    if (fs.readFileSync(lockPath, "utf8") !== raw) return { removed: false };
    fs.rmSync(lockPath, { force: true });
    return { removed: true };
  } catch (error) {
    if (dirLockErrorCode(error) === "ENOENT" || dirLockErrorCode(error) === "ENOTEMPTY") {
      return { removed: false };
    }
    return { removed: false, error };
  }
}

// Run `fn` while holding the ZCode-compatible directory lock on `target`.
// Contention is retried on `retryDelaysMs` until `waitMs` elapses, then
// LockTimeoutError is thrown (or the underlying EACCES/EPERM when stale-lock
// reclamation failed with it). `ownerlessGraceMs` is how long a lock without
// a usable owner pid must sit before it may be reclaimed, capped at half of
// `waitMs` exactly as ZCode caps it. `fn` runs synchronously and must not
// re-enter this lock on the same target: our own pid is alive, so the nested
// acquire would wait the full timeout and fail.
export function withDirectoryLock(target, fn, {
  fs = realFs,
  waitMs = DIR_LOCK_WAIT_MS,
  retryDelaysMs = DIR_LOCK_RETRY_DELAYS_MS,
  ownerlessGraceMs = DIR_LOCK_OWNERLESS_GRACE_MS,
} = {}) {
  const lockPath = `${target}.lock`;
  // ZCode acquires with a bare mkdir, so the parent must already exist; its
  // own withFileLock wrapper performs the same recursive ensure first.
  fs.mkdirSync(dirname(lockPath), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ownerName = `owner-${token}.json`;
  const ownerFile = join(lockPath, ownerName);
  const payload = `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token })}\n`;
  const startedAt = Date.now();
  const effectiveOwnerlessGraceMs = Math.min(
    Math.max(ownerlessGraceMs, 0),
    Math.max(Math.floor(waitMs / 2), 0),
  );
  const observe = createDirLockObserver();
  let lastRemovalError;

  for (let attempt = 0; ; attempt += 1) {
    let createdLock = false;
    try {
      fs.mkdirSync(lockPath);
      createdLock = true;
      const createdLockStat = fs.statSync(lockPath);
      fs.writeFileSync(ownerFile, payload, { encoding: "utf8", flag: "wx" });
      const currentLockStat = fs.statSync(lockPath);
      const currentOwners = fs
        .readdirSync(lockPath)
        .filter((entry) => entry.startsWith("owner-") && entry.endsWith(".json"));
      if (
        currentLockStat.dev !== createdLockStat.dev ||
        currentLockStat.ino !== createdLockStat.ino ||
        currentOwners.length !== 1 ||
        currentOwners[0] !== ownerName
      ) {
        // The directory was swapped under us between mkdir and the ownership
        // check; take the same contention path as a plain EEXIST.
        throw Object.assign(new Error("directory lock ownership changed during acquire"), {
          code: "EEXIST",
        });
      }
      break;
    } catch (error) {
      if (createdLock) {
        try {
          fs.rmSync(ownerFile, { force: true });
        } catch {
          // raced away
        }
        try {
          fs.rmdirSync(lockPath);
        } catch {
          // taken over or not empty — nothing of ours left to remove
        }
      }
      const lostCreatedLock = createdLock && dirLockErrorCode(error) === "ENOENT";
      if (dirLockErrorCode(error) !== "EEXIST" && !lostCreatedLock) throw error;

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= waitMs) {
        const removalErrorCode = dirLockErrorCode(lastRemovalError);
        if (removalErrorCode === "EACCES" || removalErrorCode === "EPERM") throw lastRemovalError;
        throw new LockTimeoutError(
          `timed out after ${elapsedMs}ms waiting for the directory lock on ${target}`,
        );
      }
      const removal = removeAbandonedDirLock(fs, lockPath, effectiveOwnerlessGraceMs, observe);
      if (removal.removed) continue;
      if (removal.error) lastRemovalError = removal.error;

      const remainingMs = Math.max(waitMs - elapsedMs, 0);
      if (retryDelaysMs.length === 0 || remainingMs === 0) {
        const removalErrorCode = dirLockErrorCode(lastRemovalError);
        if (removalErrorCode === "EACCES" || removalErrorCode === "EPERM") throw lastRemovalError;
        throw new LockTimeoutError(
          `timed out after ${elapsedMs}ms waiting for the directory lock on ${target}`,
        );
      }
      const retryDelayMs = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? remainingMs;
      sleepSync(Math.min(retryDelayMs, remainingMs));
    }
  }

  try {
    return fn();
  } finally {
    // Release touches only this writer's owner file; if the lock was reclaimed
    // and taken over while fn ran, a later writer's credential is never ours
    // to delete, and rmdir on a non-empty directory simply fails.
    try {
      fs.rmSync(ownerFile, { force: true });
    } catch {
      // already gone
    }
    try {
      fs.rmdirSync(lockPath);
    } catch {
      // taken over or not empty — best-effort cleanup
    }
  }
}
