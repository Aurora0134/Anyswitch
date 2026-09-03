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

const here = dirname(fileURLToPath(import.meta.url));
export const AGENT_SYNC_RUN_SCRIPT = join(here, "agent-sync-run.mjs");

// Resolves (never rejects) with { ok, code?, error?, stdout, stderr }.
// ok === true only when the runner exited 0. stdout/stderr lines are mirrored
// into the caller's logger so both resident processes' log views see them.
export function spawnAgentSync({ port, logger = null, timeoutMs = 120_000 }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [AGENT_SYNC_RUN_SCRIPT, "--port", String(port)], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        // The resident relay/panel run windowless (silent-start.vbs); never
        // let a sync spawn flash a console on the user's desktop.
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, error: err.message, stdout: "", stderr: "" });
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

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, stdout, stderr });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = (text) => text.trim().split(/\r?\n/).filter(Boolean);
      for (const line of lines(stdout)) logger?.info?.(line);
      if (code !== 0) {
        for (const line of lines(stderr)) logger?.warn?.(line);
      }
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}
