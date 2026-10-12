import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  defaultClaudeExecutable, resolveClaudeExecutable, resolveCodexExecutable,
  resolveOpencodeExecutable, resolvePiExecutable, resolveKimiExecutable,
  resolveDshExecutable, resolveZcodeExecutable, resolveZcodeCliExecutable,
  defaultZcodeCliExecutable, resolveQoderExecutable,
  resolveQoderCliExecutable, resolveGrokExecutable,
} from "./agent-discovery.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

test("standalone discovery preserves all nine launcher installation choices", () => {
  const base = { USERPROFILE: "C:\\Users\\fixture", APPDATA: "C:\\roaming", LOCALAPPDATA: "C:\\local" };
  assert.equal(defaultClaudeExecutable(base), "C:/roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe");
  assert.equal(resolveClaudeExecutable(base), defaultClaudeExecutable(base));
  assert.equal(resolveCodexExecutable({ ...base, CODEX_EXECUTABLE: "C:\\custom\\codex.exe" }), "C:\\custom\\codex.exe");
  assert.equal(resolveOpencodeExecutable(base), join(base.APPDATA, "npm/node_modules/opencode-ai/node_modules/opencode-windows-x64/bin/opencode.exe"));
  assert.equal(resolvePiExecutable(base), join(base.APPDATA, "npm/pi.cmd"));
  // kimi 两种官方形态：npm 全局 shim 优先（面板更新按钮装的就是那个包），
  // 没有 shim 才回退官方原生执行体（~/.kimi-code/bin/kimi.exe）。
  assert.equal(resolveKimiExecutable(base, { existsSync: () => true }), join(base.APPDATA, "npm/kimi.cmd"));
  assert.equal(resolveKimiExecutable(base, { existsSync: () => false }), join(base.USERPROFILE, ".kimi-code/bin/kimi.exe"));
  assert.equal(resolveDshExecutable(base, { existsSync: () => true }), join(base.APPDATA, "npm/dsh.cmd"));
  assert.equal(resolveZcodeExecutable(base), join(base.LOCALAPPDATA, "Programs/zcode/ZCode.exe"));
  assert.equal(resolveQoderExecutable(base, { existsSync: () => true }), join(base.USERPROFILE, ".qoder/entry/qoder.cmd"));
  // 环境检测与终端一键启动认 CLI 执行体本身，不经 IDE 的 qoder.cmd 调度器。
  assert.equal(resolveQoderCliExecutable(base), join(base.USERPROFILE, ".qoder/bin/qodercli/qodercli.exe"));
  assert.equal(resolveGrokExecutable(base), join(base.USERPROFILE, ".grok/bin/grok.exe"));
  assert.equal(resolveGrokExecutable({ ...base, GROK_EXECUTABLE: "C:\\custom\\grok.exe" }), "C:\\custom\\grok.exe");
});

test("codex 解析优先 npm 全局 shim，与面板检测同源", () => {
  // 两套安装形态必须解析到同一个文件：面板更新按钮装的是 npm 全局包，检测侧
  // （environment-service 的 resolveCodexShim）认的也是它；终端一键启动与
  // codex-launcher 若还只看官方原生安装位，npm 装的 codex 就会被误报未安装。
  // 原生安装位仍是回退，其 glob 行为由 codex-launcher.test.mjs 覆盖。
  const dir = mkTestDir("codex-pick-");
  try {
    const roaming = join(dir, "roaming");
    const shim = join(roaming, "npm", "codex.cmd");
    mkdirSync(dirname(shim), { recursive: true });
    writeFileSync(shim, "");
    assert.equal(
      resolveCodexExecutable({ APPDATA: roaming, LOCALAPPDATA: join(dir, "local") }),
      shim,
      "shim 在就优先 npm 全局包：面板更新按钮装的那个",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex 两种安装形态都没有时如实抛错，两个位置都写进文案", () => {
  const dir = mkTestDir("codex-none-");
  try {
    assert.throws(
      () => resolveCodexExecutable({ APPDATA: join(dir, "roaming"), LOCALAPPDATA: join(dir, "local") }),
      /no codex\.exe found under[\s\S]*and no npm shim at/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GROK_EXECUTABLE refuses shims that could recurse into the launcher", () => {
  const base = { USERPROFILE: "C:\\Users\\fixture" };
  assert.equal(resolveGrokExecutable(base), "C:\\Users\\fixture\\.grok\\bin\\grok.exe");
  assert.throws(() => resolveGrokExecutable({ ...base, GROK_EXECUTABLE: "grok.exe" }), /must be an absolute path/);
  assert.throws(() => resolveGrokExecutable({ ...base, GROK_EXECUTABLE: "C:\\custom\\grok.cmd" }), /must point at a \.exe/);
});

test("resolveZcodeCliExecutable: override wins, default needs the local build to exist, missing is null", () => {
  const base = { USERPROFILE: "C:\\Users\\fixture" };
  // 默认候选是本机构建路径（dist 发行树的 bin\zcode.mjs）；存在与否由 io 注入决定，
  // 找不到返回 null（优雅 not-found）而不抛错。
  const expected = join(base.USERPROFILE, "Desktop/agent-home/zcode-src/dist/zcode/debug/zcode/bin/zcode.mjs");
  assert.equal(defaultZcodeCliExecutable(base), expected);
  assert.equal(resolveZcodeCliExecutable(base, { existsSync: () => true }), expected);
  assert.equal(resolveZcodeCliExecutable(base, { existsSync: () => false }), null);
  assert.equal(
    resolveZcodeCliExecutable({ ...base, ZCODE_CLI_EXECUTABLE: "D:\\cli\\zcode.mjs" }, { existsSync: () => false }),
    "D:\\cli\\zcode.mjs",
  );
  assert.throws(
    () => resolveZcodeCliExecutable({ ...base, ZCODE_CLI_EXECUTABLE: "zcode.mjs" }),
    /must be an absolute path/,
  );
});
