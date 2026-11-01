// Module-graph guard: every path a source file resolves against its own
// location must exist on disk.
//
// 2026-11-01 分域重构把 terminal-host.mjs 搬进 src/terminal，却漏改
// relay-host.mjs 里以自身目录为基准的裸名 `new URL("terminal-host.mjs", …)`——
// 结果是每次 spawn 都 MODULE_NOT_FOUND，终端服务整晚起不来，而
// relay-host.test.mjs 的 `endsWith("terminal-host.mjs")` 照样绿。同类漏网
// 还有 client-update-worker.mjs 的 `./package.json`。断言的锚点因此改成
// 「解析结果在盘」，不再信字符串后缀。

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

// Only relative specifiers can silently rot: bare package names resolve through
// node_modules, absolute URLs are somebody else's problem.
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.[^"']*)["']/g;
const SELF_URL_RE = /new URL\(\s*["'](\.[^"']*)["']\s*,\s*import\.meta\.url\s*\)/g;

test("every relative import and self-URL resolves to a file on disk", () => {
  const missing = [];
  for (const file of walk(SRC_DIR)) {
    const source = readFileSync(file, "utf8");
    const base = dirname(file);
    for (const re of [IMPORT_RE, SELF_URL_RE]) {
      for (const match of source.matchAll(re)) {
        const target = resolve(base, match[1]);
        if (!existsSync(target)) {
          missing.push(`${file.slice(SRC_DIR.length + 1)} -> ${match[1]}`);
        }
      }
    }
  }
  assert.deepEqual(missing, [], `dangling relative references:\n  ${missing.join("\n  ")}`);
});

test("the terminal host script and the app version both live where their importers look", () => {
  // The two exact paths that broke in the 2026-11-01 refactor, pinned by value so
  // a future move fails here rather than at spawn time in production.
  const shell = join(SRC_DIR, "relay", "relay-host.mjs");
  const worker = join(SRC_DIR, "agents", "client-update-worker.mjs");
  assert.ok(existsSync(join(SRC_DIR, "terminal", "terminal-host.mjs")), "terminal-host.mjs must live in src/terminal");
  assert.ok(readFileSync(shell, "utf8").includes('new URL("../terminal/terminal-host.mjs"'), "relay-host must resolve the terminal script through src/terminal");
  assert.ok(readFileSync(worker, "utf8").includes('new URL("../../package.json"'), "client-update-worker must reach the repo-root package.json");
  assert.ok(existsSync(join(SRC_DIR, "..", "package.json")), "the repo-root package.json must stay put");
});
