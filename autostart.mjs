// Login autostart for the resident relay host, via a per-user Scheduled Task.
//
// Three generations of attempts, for the record:
//   1. schtasks.exe /create /sc onlogon — fails "拒绝访问/Access denied" for
//      non-elevated users (the CLI path demands admin no matter the flags).
//   2. HKCU\...\Run registry key — works per-user without elevation, but some
//      machines suppress the ENTIRE user-level Run processing at logon (all
//      HKCU entries skipped while HKLM ones fire; observed 2026-08-24 with
//      OneDrive/QQNT/Thunder hit alongside ApiCred). No code bug — the shell
//      just never runs the entries.
//   3. PowerShell Register-ScheduledTask with an Interactive/Limited
//      principal and an AtLogOn trigger — succeeds non-elevated, is launched
//      by the Task Scheduler service (not Explorer's Run processing), and
//      survives whatever was eating Run entries. This module.
//
// The task XML travels over stdin to PowerShell so no path- or quote-
// sensitive string ever reaches the command line. ExecutionTimeLimit is PT0S
// ("no limit") — the Task Scheduler default of 72h would silently kill the
// resident relay.
//
// This module is the thin shim the panel's toggle calls; it owns no process
// supervision (crash recovery is "log in again or re-run", by design — see
// relay-host.mjs).

import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// legacy task names kept for compatibility after product rename ApiCred → Anyswitch
const TASK_NAME = "ApiCredRelay";
const WATCHDOG_TASK_NAME = "ApiCredWatchdog";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export function getAutostartCommand(script = "relay-host.mjs") {
  // node "<app>/<script>" — quoted because LOCALAPPDATA paths can contain
  // spaces. kept for display/diagnostics; the scheduled task splits this into
  // Execute (absolute node) + Arguments (quoted script).
  return `node "${join(__dirname, script)}"`;
}

// Exported for tests: the escaping contract of every value interpolated into
// the task XML below.
export function xmlEscape(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function currentUser() {
  const domain = process.env.USERDOMAIN || process.env.COMPUTERNAME;
  const user = process.env.USERNAME;
  if (!user) return null;
  return domain ? `${domain}\\${user}` : user;
}

export function buildTaskXml(script) {
  const user = currentUser();
  const userIdXml = user ? `<UserId>${xmlEscape(user)}</UserId>` : "";
  // Task Scheduler's Exec action has no hidden-window option — launching
  // node.exe (a console app) directly pops a console at every logon. The
  // task therefore starts silent-start.vbs via wscript.exe, which spawns
  // node with window style 0 (same trick as panel-app.vbs).
  const launcher = join(__dirname, "silent-start.vbs");
  const wscript = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
  return `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals>
    <Principal id="Author">
      ${userIdXml}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      ${userIdXml}
    </LogonTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(wscript)}</Command>
      <Arguments>${xmlEscape(`"${launcher}" "${join(__dirname, script)}"`)}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

// Single-quoted PS literals below contain only the fixed task name — nothing
// user-controlled reaches the command line. spawnFn is injectable so tests
// can drive the PowerShell boundary without touching the real Task Scheduler.
function runPS(script, stdin, spawnFn = spawn) {
  return new Promise((resolve) => {
    const child = spawnFn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, stdout });
      else resolve({ ok: false, error: stderr.trim() || `powershell exited ${code}` });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

async function registerTask(taskName, script, spawnFn = spawn) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "$xml = [Console]::In.ReadToEnd()",
    `Register-ScheduledTask -TaskName '${taskName}' -Xml $xml -Force | Out-Null`,
    "'REGISTERED'",
  ].join("; ");
  return runPS(ps, buildTaskXml(script), spawnFn);
}

async function unregisterTask(taskName, spawnFn = spawn) {
  // SilentlyContinue: deleting an absent task is success (idempotent disable),
  // same semantics the old reg delete fallback had.
  const ps = [
    `Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue`,
    "'UNREGISTERED'",
  ].join("; ");
  return runPS(ps, undefined, spawnFn);
}

async function isTaskPresent(taskName, spawnFn = spawn) {
  const ps = [
    `$t = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue`,
    "if ($t) { 'PRESENT' } else { 'ABSENT' }",
  ].join("; ");
  const result = await runPS(ps, undefined, spawnFn);
  if (!result.ok) return false;
  return result.stdout.includes("PRESENT");
}

export async function enableAutostart({ spawnFn = spawn } = {}) {
  return registerTask(TASK_NAME, "relay-host.mjs", spawnFn);
}

export async function disableAutostart({ spawnFn = spawn } = {}) {
  return unregisterTask(TASK_NAME, spawnFn);
}

export async function isAutostartEnabled({ spawnFn = spawn } = {}) {
  return isTaskPresent(TASK_NAME, spawnFn);
}

// Watchdog variant: the followAgent entry starts agent-watchdog.mjs (NOT the
// relay) so the relay stays lazily started until a coding agent appears.
export async function enableWatchdogAutostart({ spawnFn = spawn } = {}) {
  return registerTask(WATCHDOG_TASK_NAME, "agent-watchdog.mjs", spawnFn);
}

export async function disableWatchdogAutostart({ spawnFn = spawn } = {}) {
  return unregisterTask(WATCHDOG_TASK_NAME, spawnFn);
}

export async function isWatchdogAutostartEnabled({ spawnFn = spawn } = {}) {
  return isTaskPresent(WATCHDOG_TASK_NAME, spawnFn);
}
