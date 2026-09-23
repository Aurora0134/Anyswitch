import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test fixtures are created under one shared root per process, so a full run
// leaves a single directory behind instead of hundreds of orphans. The root is
// removed when the process exits normally, including after an uncaught error;
// a run killed outright leaves one `anyswitch-tests-*` directory that is
// easy to spot and sweep.
let root = null;

function sweep() {
  if (!root) return;
  const stale = root;
  root = null;
  try {
    rmSync(stale, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // A locked fixture must never turn a passing test run into a failing one.
  }
}

process.on("exit", sweep);

export function mkTestDir(prefix = "anyswitch-test-") {
  if (!root) root = mkdtempSync(join(tmpdir(), "anyswitch-tests-"));
  return mkdtempSync(join(root, prefix));
}

export function testTmpRoot() {
  return root;
}
