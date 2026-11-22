// Spawn helper for the standalone agent-config sync runner.
//
// The sync deliberately runs OUTSIDE the resident processes: every spawn
// loads agent-sync + the merge modules fresh from disk, so code changes to
// the catalog writers take effect at the next store-change sync or panel
// "同步到端点" click — no relay/panel restart needed. Shared by relay-host
// (initial sync + store watcher) and panel.mjs (the sync route).

import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Single source of truth for the machine-readable summary marker: the runner
// prints one such line per sync for the panel to parse. It carries endpoint
// names and counts, not prose, so the mirror below keeps it out of log views.
import { parseSyncSummaryLine, SYNC_RESULT_PREFIX } from "./agent-sync.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const AGENT_SYNC_RUN_SCRIPT = join(here, "agent-sync-run.mjs");

// Resolves (never rejects) with { ok, code?, error?, timeout?, stdout, stderr }.
// ok === true only when the runner exited 0. The parent logs the batch outcome
// from the process result and endpoint summary, without changing the result.
// timeout distinguishes a timed-out runner from other signal exits (code null).
export function spawnAgentSync({ port, logger = null, timeoutMs = 120_000, spawnFn = spawn }) {
  return new Promise((resolve) => {
    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      if (!result.ok) {
        logger?.error?.(`agent config sync failed: ${result.error ?? `runner exit ${result.code}`}`);
      } else {
        const summary = parseSyncSummaryLine(result.stdout);
        if (summary && !summary.ok) {
          logger?.error?.("agent config sync failed: runner reported failure");
        } else if (summary?.failed.length) {
          const failed = summary.failed.join(", ");
          if (!summary.synced.length) {
            logger?.error?.(`agent config sync failed for all applicable endpoints: ${failed}`);
          } else {
            logger?.warn?.(`[agent-sync] sync finished with failures: ${failed}`);
          }
        }
      }
      resolve(result);
    }

    let child;
    try {
      child = spawnFn(process.execPath, [AGENT_SYNC_RUN_SCRIPT, "--port", String(port)], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        // The resident relay/panel run windowless (silent-start.vbs); never
        // let a sync spawn flash a console on the user's desktop.
        windowsHide: true,
      });
    } catch (err) {
      finish({ ok: false, error: err.message, stdout: "", stderr: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message, stdout, stderr });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = (text) => text.trim().split(/\r?\n/).filter(Boolean);
      const humanLines = (text) => lines(text).filter((line) => !line.includes(SYNC_RESULT_PREFIX));
      // Keep diagnostics even on exit 0, where an individual endpoint can fail.
      for (const line of humanLines(stdout)) logger?.info?.(line);
      for (const line of humanLines(stderr)) logger?.warn?.(line);
      if (timedOut) {
        finish({ ok: false, code, timeout: true, error: `runner timed out after ${Math.round(timeoutMs / 1000)}s`, stdout, stderr });
        return;
      }
      finish({ ok: code === 0, code, stdout, stderr });
    });
  });
}
