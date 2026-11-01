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

// Every .mjs path a rendered shim body names, as repo-relative POSIX text. The
// sh variant spells the root "$localappdata/Anyswitch/app/…", the .cmd and .ps1
// variants "%LOCALAPPDATA%\Anyswitch\app\…" — both mean the same tree.
function renderedLaunchers(text) {
  return [...text.matchAll(/Anyswitch[\\/]app[\\/]([^"'\s]+\.mjs)/g)]
    .map((match) => match[1].replace(/\\/g, "/"));
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
        renderedLaunchers(text),
        [spec.launcher],
        `${spec.id}.${kind} must exec exactly ${spec.launcher}`,
      );
    }
  }
});
