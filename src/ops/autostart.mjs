// Login autostart for the resident relay host, via a per-user Scheduled Task.
//
// Three generations of attempts, for the record:
//   1. schtasks.exe /create /sc onlogon — fails "拒绝访问/Access denied" for
//      non-elevated users (the CLI path demands admin no matter the flags).
//   2. HKCU\...\Run registry key — works per-user without elevation, but some
//      machines suppress the ENTIRE user-level Run processing at logon (all
//      HKCU entries skipped while HKLM ones fire). No code bug — the shell
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
//
// A registered task is a SNAPSHOT of two absolute paths (the silent-start.vbs
// launcher and the .mjs it starts). Neither survives a source move: the 2026-11
// src/ split left both tasks pointing at the pre-refactor tree, and because
// isAutostartEnabled only asked "does a task with this name exist", the panel
// kept showing 开启 while the logon entry died silently (wscript hides the
// console, so node's MODULE_NOT_FOUND went nowhere). reconcileAutostart is the
// repair path: on panel start, compare each task's stored action against what
// this build would register today and re-register when they differ. It never
// CREATES a task — an absent task is the user's own 关闭, not a breakage.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Migration note: tasks were registered as "ApiCredRelay"/"ApiCredWatchdog"
// before the product rename ApiCred → Anyswitch. New registrations use the
// Anyswitch* names; the disable paths also unregister the legacy tasks so a
// pre-rename install doesn't keep two tasks alive, and the probe treats the
// legacy name as enabled so the panel toggle doesn't flip on old installs.
const LEGACY_TASK_NAME = "ApiCredRelay";
const LEGACY_WATCHDOG_TASK_NAME = "ApiCredWatchdog";
const TASK_NAME = "AnyswitchRelay";
const WATCHDOG_TASK_NAME = "AnyswitchWatchdog";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Entry points, relative to this file. Kept in one place because three things
// must agree on them: the registration, the staleness probe, and the tests.
const RELAY_SCRIPT = join("..", "relay", "relay-host.mjs");
const WATCHDOG_SCRIPT = join("..", "agents", "agent-watchdog.mjs");

export function getAutostartCommand(script = RELAY_SCRIPT) {
  // Plain-node form of the launch line: `node "<app>/<script>"`, quoted because
  // LOCALAPPDATA paths can contain spaces. This is NOT what the scheduled task
  // runs — the task's Exec action starts wscript.exe with silent-start.vbs, so
  // registering this string instead would pop a console at every logon (see
  // buildTaskXml). Currently exercised only by the tests.
  // script 默认值给相对 src/ops/ 的路径——源码 2026-11 起迁入 src/ 子目录，
  // __dirname 已不在仓根。
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

// The Exec action of a task, as this build would write it today. buildTaskXml
// interpolates it and reconcileAutostart compares against it — one source, so
// the two can never disagree about what "correct" means.
export function taskAction(script = RELAY_SCRIPT) {
  return {
    command: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe"),
    arguments: `"${join(__dirname, "../../silent-start.vbs")}" "${join(__dirname, script)}"`,
  };
}

export function buildTaskXml(script) {
  const user = currentUser();
  const userIdXml = user ? `<UserId>${xmlEscape(user)}</UserId>` : "";
  // Task Scheduler's Exec action has no hidden-window option — launching
  // node.exe (a console app) directly pops a console at every logon. The
  // task therefore starts silent-start.vbs via wscript.exe, which spawns
  // node with window style 0 (same trick as panel-app.vbs).
  const action = taskAction(script);
  const wscript = action.command;
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
      <Arguments>${xmlEscape(action.arguments)}</Arguments>
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

// One PowerShell round trip reads every task we care about: four separate
// spawns at panel start would cost around a second for a check that is almost
// always a no-op. Absent tasks simply produce no record.
async function probeTaskActions(taskNames, spawnFn = spawn) {
  const list = taskNames.map((name) => `'${name}'`).join(",");
  // `exit 0` is load-bearing: Get-ScheduledTask against an absent task is a
  // non-terminating error, and PowerShell then exits 1 even though the script
  // did exactly what we asked. Under 'Stop' any real failure (missing module,
  // access denied) stays terminating, so a non-zero exit still means trouble.
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    `$names = @(${list})`,
    "foreach ($n in $names) { $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue; if ($t) { \"TASK=$n\"; \"COMMAND=\" + $t.Actions[0].Execute; \"ARGS=\" + $t.Actions[0].Arguments } }",
    "exit 0",
  ].join("; ");
  const result = await runPS(ps, undefined, spawnFn);
  if (!result.ok) return { ok: false, error: result.error, byName: new Map() };
  const byName = new Map();
  let current = null;
  for (const raw of result.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("TASK=")) {
      current = { command: "", arguments: "" };
      byName.set(line.slice("TASK=".length), current);
    } else if (current && line.startsWith("COMMAND=")) {
      current.command = line.slice("COMMAND=".length);
    } else if (current && line.startsWith("ARGS=")) {
      current.arguments = line.slice("ARGS=".length);
    }
  }
  return { ok: true, byName };
}

async function isTaskPresent(taskName, spawnFn = spawn) {
  const probed = await probeTaskActions([taskName], spawnFn);
  return probed.ok && probed.byName.has(taskName);
}

// The stored action, reduced to the quoted path tokens it starts. Comparing
// the raw strings would trip over Task Scheduler's own normalisation (it
// re-serialises what we registered); the two paths are what actually matters.
function actionPaths(text) {
  return [...String(text ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1].toLowerCase());
}

function actionMatches(stored, expected) {
  if (stored.command && stored.command.toLowerCase() !== expected.command.toLowerCase()) return false;
  const actual = actionPaths(stored.arguments);
  const wanted = actionPaths(expected.arguments);
  return actual.length === wanted.length && actual.every((path, index) => path === wanted[index]);
}

async function reconcileTask({ taskName, legacyTaskName, script, register }, byName, spawnFn) {
  const stored = byName.get(taskName);
  if (!stored) {
    // Absent is the user's own 关闭, and a legacy-only install is already
    // reported as enabled — neither is ours to rewrite.
    return { task: taskName, state: byName.has(legacyTaskName) ? "legacy" : "absent" };
  }
  const expected = taskAction(script);
  if (actionMatches(stored, expected)) return { task: taskName, state: "ok" };
  const registered = await register({ spawnFn });
  if (!registered.ok) {
    return { task: taskName, state: "heal-failed", was: stored.arguments, error: registered.error };
  }
  return { task: taskName, state: "healed", was: stored.arguments, now: expected.arguments };
}

// Startup reconcile: re-register any task whose stored action no longer points
// at the tree this build lives in. Never creates a task that is absent.
export async function reconcileAutostart({ spawnFn = spawn } = {}) {
  const probed = await probeTaskActions(
    [TASK_NAME, WATCHDOG_TASK_NAME, LEGACY_TASK_NAME, LEGACY_WATCHDOG_TASK_NAME],
    spawnFn,
  );
  if (!probed.ok) return { ok: false, error: probed.error, tasks: [] };
  const entries = [
    { taskName: TASK_NAME, legacyTaskName: LEGACY_TASK_NAME, script: RELAY_SCRIPT, register: enableAutostart },
    { taskName: WATCHDOG_TASK_NAME, legacyTaskName: LEGACY_WATCHDOG_TASK_NAME, script: WATCHDOG_SCRIPT, register: enableWatchdogAutostart },
  ];
  const tasks = [];
  for (const entry of entries) tasks.push(await reconcileTask(entry, probed.byName, spawnFn));
  return { ok: true, tasks };
}

export async function enableAutostart({ spawnFn = spawn } = {}) {
  return registerTask(TASK_NAME, RELAY_SCRIPT, spawnFn);
}

export async function disableAutostart({ spawnFn = spawn } = {}) {
  const result = await unregisterTask(TASK_NAME, spawnFn);
  await unregisterTask(LEGACY_TASK_NAME, spawnFn);
  return result;
}

export async function isAutostartEnabled({ spawnFn = spawn } = {}) {
  const present = await isTaskPresent(TASK_NAME, spawnFn);
  if (present) return true;
  // Pre-rename install: legacy task still registered under the old name.
  return isTaskPresent(LEGACY_TASK_NAME, spawnFn);
}

// Watchdog variant: the followAgent entry starts agent-watchdog.mjs (NOT the
// relay) so the relay stays lazily started until a coding agent appears.
export async function enableWatchdogAutostart({ spawnFn = spawn } = {}) {
  return registerTask(WATCHDOG_TASK_NAME, WATCHDOG_SCRIPT, spawnFn);
}

export async function disableWatchdogAutostart({ spawnFn = spawn } = {}) {
  const result = await unregisterTask(WATCHDOG_TASK_NAME, spawnFn);
  await unregisterTask(LEGACY_WATCHDOG_TASK_NAME, spawnFn);
  return result;
}

export async function isWatchdogAutostartEnabled({ spawnFn = spawn } = {}) {
  const present = await isTaskPresent(WATCHDOG_TASK_NAME, spawnFn);
  if (present) return true;
  return isTaskPresent(LEGACY_WATCHDOG_TASK_NAME, spawnFn);
}
