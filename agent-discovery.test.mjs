import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  defaultClaudeExecutable, resolveClaudeExecutable, resolveCodexExecutable,
  resolveOpencodeExecutable, resolvePiExecutable, resolveKimiExecutable,
  resolveDshExecutable, resolveZcodeExecutable, resolveZcodeCliExecutable,
  resolveQoderExecutable,
  resolveQoderCliExecutable, resolveGrokExecutable,
} from "./agent-discovery.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

test("standalone discovery preserves all nine launcher installation choices", () => {
  const base = { USERPROFILE: "C:\\Users\\fixture", APPDATA: "C:\\roaming", LOCALAPPDATA: "C:\\local" };
  assert.equal(defaultClaudeExecutable(base), "C:/roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe");
  assert.equal(resolveClaudeExecutable(base), defaultClaudeExecutable(base));
  assert.equal(resolveCodexExecutable({ ...base, CODEX_EXECUTABLE: "C:\\custom\\codex.exe" }), "C:\\custom\\codex.exe");
  assert.equal(resolveOpencodeExecutable(base), join(base.APPDATA, "npm/node_modules/@opencode/cli/node_modules/@opencode/cli-windows-x64/bin/opencode.exe"));
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

// opencode 的包名与目录布局由上游发包决定，fixture 要照 npm 真实落盘的样子写：
// 宿主包的 package.json 声明 optionalDependencies 与 bin，变体包只出执行体。
function installOpencode(roaming, { name, variants = [], hoisted = false, bundledBinary = null }) {
  const modulesRoot = join(roaming, "npm", "node_modules");
  const pkgRoot = join(modulesRoot, ...name.split("/"));
  const optionalDependencies = Object.fromEntries(variants.map((variant) => [variant, "1.0.0"]));
  mkdirSync(join(pkgRoot, "bin"), { recursive: true });
  writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({
    name, version: "1.0.0", bin: { opencode: "./bin/opencode.exe" }, optionalDependencies,
  }));
  const exeOf = (variant) => join(
    hoisted ? modulesRoot : join(pkgRoot, "node_modules"), ...variant.split("/"), "bin", "opencode.exe",
  );
  for (const variant of variants) {
    const exe = exeOf(variant);
    mkdirSync(dirname(exe), { recursive: true });
    writeFileSync(exe, "MZ");
  }
  if (bundledBinary !== null) writeFileSync(join(pkgRoot, "bin", "opencode.exe"), bundledBinary);
  return { pkgRoot, exeOf };
}

test("opencode 解析认实际安装的平台变体：只装 baseline 的机器到 baseline 执行体", () => {
  // 上游把平台依赖按 CPU 档位拆成 x64 / x64-baseline / arm64 可选包，npm 按机器
  // 实际落盘其中一个（本机 2026-10-11 至 2026-10-14 那段只有 baseline）。写死
  // 非 baseline 的一条路，baseline 布局的机器就会在环境检测与终端一键启动两侧
  // 同报未找到——新建菜单缺项与关于页「本地 未找到」都是这一个病因。
  const dir = mkTestDir("opencode-pick-");
  try {
    const roaming = join(dir, "roaming");
    const { exeOf } = installOpencode(roaming, {
      name: "opencode-ai", variants: ["opencode-windows-x64-baseline"],
    });
    assert.equal(
      resolveOpencodeExecutable({ APPDATA: roaming }),
      exeOf("opencode-windows-x64-baseline"),
      "只装了 baseline 就解析到 baseline 执行体",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode 两个平台变体都在时优先非 baseline，与上游 postinstall 的 AVX2 偏好一致", () => {
  const dir = mkTestDir("opencode-both-");
  try {
    const roaming = join(dir, "roaming");
    const { exeOf } = installOpencode(roaming, {
      name: "opencode-ai", variants: ["opencode-windows-x64-baseline", "opencode-windows-x64"],
    });
    assert.equal(resolveOpencodeExecutable({ APPDATA: roaming }), exeOf("opencode-windows-x64"), "两变体并存维持既有优先序");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode 认 2.x 的 scoped 包名与变体名：上游改名当天不能报未找到", () => {
  // 本机 2026-10-14 13:18 起，官方包整组改名：opencode-ai → @opencode/cli，
  // opencode-windows-x64 → @opencode/cli-windows-x64。写死旧名的一版修复在这里
  // 全线失效，关于页与虚拟终端菜单同时丢了 OpenCode，所以新名是主用例。
  const dir = mkTestDir("opencode-scoped-");
  try {
    const roaming = join(dir, "roaming");
    const { exeOf } = installOpencode(roaming, {
      name: "@opencode/cli", variants: ["@opencode/cli-windows-x64", "@opencode/cli-windows-x64-baseline"],
    });
    assert.equal(resolveOpencodeExecutable({ APPDATA: roaming }), exeOf("@opencode/cli-windows-x64"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode 认 npm 把平台包提到全局 node_modules 顶层的落盘形态", () => {
  // npm 会把不冲突的依赖提升到顶层，宿主包目录里就没有 node_modules 这一层。
  const dir = mkTestDir("opencode-hoist-");
  try {
    const roaming = join(dir, "roaming");
    const { exeOf } = installOpencode(roaming, {
      name: "@opencode/cli", variants: ["@opencode/cli-windows-x64"], hoisted: true,
    });
    assert.equal(resolveOpencodeExecutable({ APPDATA: roaming }), exeOf("@opencode/cli-windows-x64"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode 上游再改名时按 bin 声明认包，不再依赖写死的包名", () => {
  // 候选包名只是快路径：本机装了 opencode 命令（npm 落下的 shim 在）而两个已知
  // 包名都不存在时，扫一遍全局 node_modules，认 bin 里提供 opencode 的那个包。
  const dir = mkTestDir("opencode-rename-");
  try {
    const roaming = join(dir, "roaming");
    mkdirSync(join(roaming, "npm"), { recursive: true });
    writeFileSync(join(roaming, "npm", "opencode.cmd"), "@echo off\r\n");
    const { exeOf } = installOpencode(roaming, {
      name: "@anomalyco/opencode", variants: ["@anomalyco/opencode-windows-x64"],
    });
    assert.equal(resolveOpencodeExecutable({ APPDATA: roaming }), exeOf("@anomalyco/opencode-windows-x64"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode 不把 postinstall 被拦下留下的文本桩当执行体", () => {
  // 包自己的 bin 在 npm 的脚本白名单拦住 postinstall 时是一段报错文本（本机
  // 2.0.28 正是这样），Windows 拒绝执行它，历史表现为「与你运行的 Windows 版本
  // 不兼容」。平台包都不在、只剩这个桩时，宁可如实报未安装。
  const dir = mkTestDir("opencode-stub-");
  try {
    const roaming = join(dir, "roaming");
    installOpencode(roaming, { name: "@opencode/cli", bundledBinary: 'echo "postinstall was not run" >&2\r\n' });
    assert.equal(
      resolveOpencodeExecutable({ APPDATA: roaming }),
      join(roaming, "npm", "node_modules", "@opencode", "cli", "node_modules", "@opencode", "cli-windows-x64", "bin", "opencode.exe"),
      "只剩文本桩时按未安装报，路径不落在桩上",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode 可选依赖缺席但包自己带了真二进制时用它", () => {
  // 上游 postinstall 有临时装包再复制进包内 bin 的一条路（installPackage），
  // 走这条路的安装没有落盘平台包，那份复制品是唯一执行体。
  const dir = mkTestDir("opencode-bundled-");
  try {
    const roaming = join(dir, "roaming");
    installOpencode(roaming, { name: "@opencode/cli", bundledBinary: "MZ" });
    assert.equal(
      resolveOpencodeExecutable({ APPDATA: roaming }),
      join(roaming, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe"),
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

test("resolveZcodeCliExecutable: explicit-config only — override wins, unconfigured is null", () => {
  const base = { USERPROFILE: "C:\\Users\\fixture" };
  // CLI 形态无内置默认路径：唯一入口是 ZCODE_CLI_EXECUTABLE 绝对路径覆盖
  // （只验绝对路径，存在性由调用方核验）；未配置返回 null（优雅 not-found）
  // 而不抛错。
  assert.equal(resolveZcodeCliExecutable(base), null);
  assert.equal(
    resolveZcodeCliExecutable({ ...base, ZCODE_CLI_EXECUTABLE: "D:\\cli\\zcode.mjs" }),
    "D:\\cli\\zcode.mjs",
  );
  assert.throws(
    () => resolveZcodeCliExecutable({ ...base, ZCODE_CLI_EXECUTABLE: "zcode.mjs" }),
    /must be an absolute path/,
  );
});
