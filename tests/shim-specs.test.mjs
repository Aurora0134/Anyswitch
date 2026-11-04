// SHIM_SPECS 守卫：规格表是对磁盘的声明，两边各自漂移过一次。
//
// 2026-11-01 分域重构把 *-launcher.mjs 搬进 src/launchers，规格表跟着改了，
// 盘上手写的 shim 没改（zcode-cli / agy / zcode-app.vbs 三处指着已经不存在的
// launcher）；而当时的测试只核了 grok 与 dsh 两条的渲染结果，于是「表里写了
// launcher、盘上没有」照样全绿。这里把三条不变式钉住：未退休条目的 launcher
// 必须在盘上、id/command/dir 不重复、渲染出的 shim 只认 src/launchers。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SHIM_SPECS, renderShimScripts } from "../src/agents/shim-manager.mjs";

// Same repo-root resolution as tests/module-graph.test.mjs: the test file's own
// location, never an absolute path from one developer's machine.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER_DIR = "src/launchers/";

function duplicates(values) {
  const seen = new Set();
  const dupes = new Set();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

// ── 渲染体 exec 枚举（sh / cmd / ps1）────────────────────────────
// 「别的什么都不执行」不能靠只抓 Anyswitch/app 前缀后面的 .mjs 段来证明：
// 路径落在 %LOCALAPPDATA%\Anyswitch\app 之外的 exec 对那个正则完全不可见，
// 往渲染体里追加一条 %APPDATA% 下的 node 调用照样全绿。
// 改成把每种方言的语句全部归类：launches 是会启动进程的
// { command, args }，assignments 是 sh 变量名 / ps1 的 launcher 路径拼装
// 语句，unclassified 是解析器不认识的行——后者一律翻红，exec 就没法藏进
// 一个未知的语句形状里。

// sh: shebang 与 # 注释惰性（shebang 的解释器本身也算 exec 面，钉成 sh）；
// $( … ) 命令替换与 ; | && || 分隔符各自开启一条新命令；`exec` 让下一个词
// 成为被启动的程序；`name=` 形式的替换赋值头是变量定义不是命令；重定向
// （2>/dev/null）不携带命令。重定向剥离故意写粗——渲染体是机器生成的，
// 剥歪的产物只会落进 unclassified 翻红，不会静默漏过。
function classifySh(text) {
  const launches = [];
  const assignmentVars = [];
  const unclassified = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#")) {
      if (line.startsWith("#!") && !/#!.*\/sh$/.test(line)) unclassified.push(line);
      continue;
    }
    const flattened = line
      .replace(/\$\(/g, " ; ")
      .replace(/\)/g, " ; ")
      .replace(/\d*>+\S*/g, " ");
    let classified = false;
    for (const segment of flattened.split(/\s*(?:&&|\|\||[|;])\s*/)) {
      const words = segment.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) continue;
      const assignment = words[0].match(/^(\w+)=$/);
      if (assignment) {
        assignmentVars.push(assignment[1]);
        classified = true;
        continue;
      }
      const offset = words[0] === "exec" ? 1 : 0;
      if (words.length <= offset) continue;
      launches.push({ command: words[offset], args: words.slice(offset + 1) });
      classified = true;
    }
    if (!classified) unclassified.push(line);
  }
  return { launches, assignmentVars, unclassified };
}

// cmd: 每个非空行要么是固定指令（@ECHO / SETLOCAL / EXIT，且不得用 & 或 |
// 链上第二条命令），要么就是一条命令调用、首词即程序名。cmd 没有惰性语法
// 可以藏身，追加的 exec 天然全部被枚举。
const CMD_DIRECTIVES = new Set(["@ECHO", "SETLOCAL", "EXIT"]);
function classifyCmd(text) {
  const launches = [];
  const unclassified = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const words = line.split(/\s+/);
    if (CMD_DIRECTIVES.has(words[0])) {
      if (/[&|]/.test(line)) unclassified.push(line);
      continue;
    }
    launches.push({ command: words[0], args: words.slice(1) });
  }
  return { launches, unclassified };
}

// ps1: shebang（解释器钉成 pwsh/powershell）、if/else 花括号与 exit 惰性；
// `$x = <cmd> <args>` 记录 launcher 路径的拼装；`& cmd args`（可作
// `$input | ` 管道成员）是进程启动。其余一律 unclassified。
function classifyPs1(text) {
  const launches = [];
  const assignments = [];
  const unclassified = [];
  const structural = /^(?:if \(.*\) \{|\} else \{|\}|exit \S+)$/;
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#!")) {
      if (index !== 0 || !/#!.*[\/ ](pwsh|powershell)$/.test(line)) unclassified.push(line);
      continue;
    }
    if (structural.test(line)) continue;
    const assignment = line.match(/^\$(\w+)\s*=\s*(\S+)\s*(.*)$/);
    if (assignment) {
      assignments.push({
        variable: assignment[1],
        command: assignment[2],
        args: assignment[3].trim() ? assignment[3].trim().split(/\s+/) : [],
      });
      continue;
    }
    const call = line.match(/^(?:\$\w+\s*\|\s*)?&\s*(\S+)\s*(.*)$/);
    if (call) {
      launches.push({ command: call[1], args: call[2].trim() ? call[2].trim().split(/\s+/) : [] });
      continue;
    }
    unclassified.push(line);
  }
  return { launches, assignments, unclassified };
}

// sh 里除 node 外仅允许 prologue 解析路径用到的两个 PATH 工具，实参白名单
// 钉死解析根只能是 $LOCALAPPDATA：node 行钉住的 "$localappdata/…" 路径只有
// 根可信，整条才可信（根换成 $APPDATA 就是仓外 exec）。
const SH_COMMANDS = new Set(["node", "cygpath", "echo"]);
const SH_UTILITY_ARGS = new Set(["-u", '"$LOCALAPPDATA"']);

const sameTokens = (a, b) => a.join(" ") === b.join(" ");

// Enumerate every exec-shaped statement in one rendered body and verify it
// lands under %LOCALAPPDATA%\Anyswitch\app on the spec's own launcher.
// Returns a list of problems; empty means the body execs the launcher and
// nothing else.
function auditRenderedBody(spec, kind, text) {
  const problems = [];
  const fixedArgs = spec.launcherArgs ?? [];
  const classified =
    kind === "sh" ? classifySh(text)
      : kind === "cmd" ? classifyCmd(text)
        : classifyPs1(text);
  const { launches, unclassified } = classified;
  for (const line of unclassified) problems.push(`unclassifiable statement: ${line}`);

  if (kind === "sh") {
    const { assignmentVars } = classified;
    for (const launch of launches) {
      if (!SH_COMMANDS.has(launch.command)) {
        problems.push(`unexpected sh command: ${launch.command}`);
      } else if (launch.command !== "node") {
        for (const arg of launch.args) {
          if (!SH_UTILITY_ARGS.has(arg)) problems.push(`unexpected arg to ${launch.command}: ${arg}`);
        }
      }
    }
    const nodeLaunches = launches.filter((launch) => launch.command === "node");
    const expected = [`"$localappdata/Anyswitch/app/${spec.launcher}"`, ...fixedArgs, '"$@"'];
    if (nodeLaunches.length !== 1) {
      problems.push(`expected exactly one node exec, found ${nodeLaunches.length}`);
    } else if (!sameTokens(nodeLaunches[0].args, expected)) {
      problems.push(`node must exec ${expected.join(" ")}, got ${nodeLaunches[0].args.join(" ")}`);
    }
    if (!assignmentVars.includes("localappdata")) {
      problems.push(`$localappdata must be defined for the node exec, defined: [${assignmentVars.join(", ")}]`);
    }
    return problems;
  }

  if (kind === "cmd") {
    const winLauncher = spec.launcher.replace(/\//g, "\\");
    if (launches.length !== 1) {
      problems.push(`expected exactly one command line, found ${launches.length}`);
    }
    for (const launch of launches) {
      if (launch.command !== "node") problems.push(`unexpected cmd command: ${launch.command}`);
    }
    const nodeLaunch = launches.find((launch) => launch.command === "node");
    const expected = [`"%LOCALAPPDATA%\\Anyswitch\\app\\${winLauncher}"`, ...fixedArgs, "%*"];
    if (!nodeLaunch) {
      problems.push("missing node command line");
    } else if (!sameTokens(nodeLaunch.args, expected)) {
      problems.push(`node must exec ${expected.join(" ")}, got ${nodeLaunch.args.join(" ")}`);
    }
    return problems;
  }

  // ps1: the launcher path is assembled once by Join-Path off $env:LOCALAPPDATA
  // and every node call must run that assembled variable.
  const winLauncher = spec.launcher.replace(/\//g, "\\");
  const { assignments } = classified;
  if (assignments.length !== 1) {
    problems.push(`expected exactly one launcher-path assignment, found ${assignments.length}`);
  }
  const assignment = assignments[0];
  const launcherVar = assignment ? `$${assignment.variable}` : null;
  if (assignment) {
    if (assignment.command !== "Join-Path") {
      problems.push(`assignment must use Join-Path, got ${assignment.command}`);
    }
    const expected = ["$env:LOCALAPPDATA", `'Anyswitch\\app\\${winLauncher}'`];
    if (!sameTokens(assignment.args, expected)) {
      problems.push(`launcher must assemble %LOCALAPPDATA%\\Anyswitch\\app\\${winLauncher}, got ${assignment.args.join(" ")}`);
    }
  }
  if (launches.length === 0) problems.push("missing node call");
  for (const launch of launches) {
    if (launch.command !== "node") {
      problems.push(`unexpected ps1 command: ${launch.command}`);
      continue;
    }
    const expected = launcherVar ? [launcherVar, ...fixedArgs, "@args"] : null;
    if (!expected || !sameTokens(launch.args, expected)) {
      problems.push(`node must run the Join-Path result${launcherVar ? ` (${launcherVar})` : ""}, got ${launch.args.join(" ")}`);
    }
  }
  return problems;
}

test("every shipped shim spec names a launcher that exists on disk", () => {
  const missing = SHIM_SPECS
    .filter((spec) => !spec.retired)
    .filter((spec) => !existsSync(resolve(REPO_ROOT, spec.launcher)))
    .map((spec) => `${spec.id} -> ${spec.launcher}`);
  assert.deepEqual(missing, [], `shim specs pointing at absent launchers:\n  ${missing.join("\n  ")}`);
});

test("shim spec ids and commands are unique, and each dir is bin/ or its own bin-<id>", () => {
  for (const key of ["id", "command"]) {
    const dupes = duplicates(SHIM_SPECS.map((spec) => spec[key]));
    assert.deepEqual(dupes, [], `duplicate shim ${key}: ${dupes.join(", ")}`);
  }
  // `dir` is deliberately not unique: bin/ hosts several auxiliary commands
  // (dsh, zcode, the retired agy). What must hold is that a spec owns a private
  // bin-<id> directory or shares the one bin/, so two specs can never write the
  // same file — command uniqueness above already rules that out.
  const strayDirs = SHIM_SPECS
    .filter((spec) => spec.dir !== "bin" && spec.dir !== `bin-${spec.id}`)
    .map((spec) => `${spec.id} -> ${spec.dir}`);
  assert.deepEqual(strayDirs, [], `unexpected shim directories:\n  ${strayDirs.join("\n  ")}`);
});

test("rendered shims exec a launcher under src/launchers and nothing else", () => {
  for (const spec of SHIM_SPECS) {
    assert.ok(spec.launcher.startsWith(LAUNCHER_DIR), `${spec.id}: launcher must live under ${LAUNCHER_DIR}, got ${spec.launcher}`);
    const scripts = renderShimScripts(spec);
    for (const [kind, text] of Object.entries(scripts)) {
      assert.deepEqual(
        auditRenderedBody(spec, kind, text),
        [],
        `${spec.id}.${kind}: every enumerated exec must land under %LOCALAPPDATA%\\Anyswitch\\app`,
      );
    }
  }
});
