import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  defaultClaudeExecutable, resolveClaudeExecutable, resolveCodexExecutable,
  resolveOpencodeExecutable, resolvePiExecutable, resolveKimiExecutable,
  resolveDshExecutable, resolveZcodeExecutable, resolveQoderExecutable,
} from "./agent-discovery.mjs";

test("standalone discovery preserves all eight launcher installation choices", () => {
  const base = { USERPROFILE: "C:\\Users\\fixture", APPDATA: "C:\\roaming", LOCALAPPDATA: "C:\\local" };
  assert.equal(defaultClaudeExecutable(base), "C:/roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe");
  assert.equal(resolveClaudeExecutable(base), defaultClaudeExecutable(base));
  assert.equal(resolveCodexExecutable({ ...base, CODEX_EXECUTABLE: "C:\\custom\\codex.exe" }), "C:\\custom\\codex.exe");
  assert.equal(resolveOpencodeExecutable(base), join(base.APPDATA, "npm/node_modules/opencode-ai/node_modules/opencode-windows-x64/bin/opencode.exe"));
  assert.equal(resolvePiExecutable(base), join(base.APPDATA, "npm/pi.cmd"));
  assert.equal(resolveKimiExecutable(base), join(base.APPDATA, "npm/kimi.cmd"));
  assert.equal(resolveDshExecutable(base, { existsSync: () => true }), join(base.APPDATA, "npm/dsh.cmd"));
  assert.equal(resolveZcodeExecutable(base), join(base.LOCALAPPDATA, "Programs/zcode/ZCode.exe"));
  assert.equal(resolveQoderExecutable(base, { existsSync: () => true }), join(base.USERPROFILE, ".qoder/entry/qoder.cmd"));
});
