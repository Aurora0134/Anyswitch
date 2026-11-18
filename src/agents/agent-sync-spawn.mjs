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
import { SYNC_RESULT_PREFIX } from "./agent-sync.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const AGENT_SYNC_RUN_SCRIPT = join(here, "agent-sync-run.mjs");

// Resolves (never rejects) with { ok, code?, error?, timeout?, stdout, stderr }.
// ok === true only when the runner exited 0. stdout/stderr lines are mirrored
// into the caller's logger so both resident processes' log views see them.
// timeout === true marks the 120s 超时分支：超时被 SIGTERM 掐掉的子进程在 close
// 事件里同样报 code null，没有这个标记的话「超时」与「崩溃」会压成同一句
// runner exit null；error 文案由这里直接给出，呈现处（relay-host / 面板路由）
// 的模板原样渲染即可。
export function spawnAgentSync({ port, logger = null, timeoutMs = 120_000, spawnFn = spawn }) {
  return new Promise((resolve) => {
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
      resolve({ ok: false, error: err.message, stdout, stderr });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = (text) => text.trim().split(/\r?\n/).filter(Boolean);
      const humanLines = (text) => lines(text).filter((line) => !line.includes(SYNC_RESULT_PREFIX));
      // 级别由流决定，不由退出码决定：stderr 一律是 warn。原来只在退出码非 0 时才
      // 转 stderr，于是「退出码 0 但个别端点没同步上」那条警告整条丢掉——而它恰恰
      // 是最需要被看到的一类。
      for (const line of humanLines(stdout)) logger?.info?.(line);
      for (const line of humanLines(stderr)) logger?.warn?.(line);
      if (timedOut) {
        resolve({ ok: false, code, timeout: true, error: `runner timed out after ${Math.round(timeoutMs / 1000)}s`, stdout, stderr });
        return;
      }
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}
