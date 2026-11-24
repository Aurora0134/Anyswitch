import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = dirname(fileURLToPath(import.meta.url));
const expectedVersion = process.argv[2];
const manifest = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
assert.equal(manifest.version, expectedVersion);
assert.equal(process.platform, "win32");
assert.equal(process.arch, "x64");
assert.equal(process.versions.node, "22.15.0");
assert.equal(process.versions.modules, "127");
for (const path of [
  "dpapi.ps1", "codex-model-catalog-template.json", "thinking-efforts-baseline.json", "anyswitch.ico",
  "panel-app.vbs", "silent-start.vbs", "panel-ui/panel.html", "panel-ui/panel.css", "panel-ui/panel.js",
  "panel-ui/wallpaper-theme.js", "panel-ui/style-lab/default.css", "panel-ui/style-lab/cyan.css",
  "panel-ui/style-lab/aurora.css", "panel-ui/style-lab/sepia.css", "docs/assets/logo.png",
  "node_modules/@xterm/xterm/lib/xterm.js", "node_modules/@xterm/xterm/css/xterm.css",
  "node_modules/@xterm/addon-fit/lib/addon-fit.js", "node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js",
  "node_modules/@xterm/addon-webgl/lib/addon-webgl.js", "node_modules/node-pty/package.json",
  "test-helpers/vendor/js-yaml/index.js", "src/panel/panel-host.mjs", "src/relay/relay-host.mjs",
  "src/terminal/terminal-host.mjs", "src/ops/update-trust.mjs",
]) await access(join(appRoot, path));
const trust = await import("./src/ops/update-trust.mjs");
assert.equal(typeof trust.UPDATE_SIGNING_PUBLIC_KEY, "string");
assert.equal(Buffer.from(trust.UPDATE_SIGNING_PUBLIC_KEY, "base64").length, 32);
const pty = await import("node-pty");
assert.equal(typeof pty.spawn, "function");
console.log("package health passed");
