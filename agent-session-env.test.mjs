import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_TERMINAL_TARGETS,
  AGENT_RELAY_PORT,
  buildAgentSessionEnv,
  buildAgentSessionLaunch,
  buildAgentResumeArgs,
} from "./agent-session-env.mjs";

const TOKEN = "relay-session-token-abc123";
const LOOPBACK_NO_PROXY = "127.0.0.1,localhost";

// A machine-like environment: every agent's executable resolves to a real file
// under one temp root (agent-discovery's overrides all accept absolute paths)
// and ComSpec points at a fake cmd.exe.
function fakeBase(root, { claudePackageVersion = undefined } = {}) {
  const exe = (name) => {
    const path = join(root, "bin", name);
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(path, "");
    return path;
  };
  const base = {
    ComSpec: exe("cmd.exe"),
    CLAUDE_EXECUTABLE: exe("claude.exe"),
    KIMI_EXECUTABLE: exe("kimi.cmd"),
    PI_EXECUTABLE: exe("pi.cmd"),
    DSH_EXECUTABLE: exe("dsh.cmd"),
    OPENCODE_EXECUTABLE: exe("opencode.exe"),
    GROK_EXECUTABLE: exe("grok.exe"),
    // zcode CLI 入口是 node 拉起的 .mjs：覆盖变量指向一个真实存在的假文件，
    // 终端侧验证入口后实际交给 cmd 的执行体是 process.execPath（node.exe）。
    ZCODE_CLI_EXECUTABLE: exe("zcode.mjs"),
    // Codex 两种安装形态：npm 全局 shim（APPDATA/npm/codex.cmd）优先，官方原生
    // 安装位（LOCALAPPDATA/[OI]/Codex/bin/<hash>/codex.exe）是回退。fakeBase 默认
    // 只摆原生那份以验证回退；需要 shim 优先的用例自行写 shim 并设 APPDATA。
    // qoder CLI 固定在 USERPROFILE/.qoder/bin/qodercli/qodercli.exe
    // （resolveQoderCliExecutable 不收覆盖变量），fakeBase 直接摆出这份目录。
    LOCALAPPDATA: join(root, "local"),
    USERPROFILE: join(root, "user"),
  };
  // claude 版本文件就在 exe 的上一级（npm-global 布局
  // <npm>/node_modules/@anthropic-ai/claude-code/bin/claude.exe 旁的
  // package.json）；fake 布局里 root/bin/claude.exe 对应 root/package.json。
  if (claudePackageVersion !== undefined) {
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: claudePackageVersion }));
  }
  mkdirSync(join(base.LOCALAPPDATA, "OpenAI", "Codex", "bin", "hash-1"), { recursive: true });
  writeFileSync(join(base.LOCALAPPDATA, "OpenAI", "Codex", "bin", "hash-1", "codex.exe"), "");
  mkdirSync(join(base.USERPROFILE, ".qoder", "bin", "qodercli"), { recursive: true });
  writeFileSync(join(base.USERPROFILE, ".qoder", "bin", "qodercli", "qodercli.exe"), "");
  return base;
}

test("白名单只含进终端的 CLI Agent，桌面 GUI 不在列", () => {
  assert.deepEqual(Object.keys(AGENT_TERMINAL_TARGETS), ["claude", "codex", "kimi", "pi", "dsh", "opencode", "grok", "qoder", "zcode"]);
  for (const banned of ["codex-desktop"]) {
    assert.equal(AGENT_TERMINAL_TARGETS[banned], undefined, `${banned} 不得进终端`);
  }
  for (const [id, target] of Object.entries(AGENT_TERMINAL_TARGETS)) {
    assert.equal(target.kind, "cli", `${id} 只接 CLI 安装`);
    assert.ok(target.name && target.name.length > 0, `${id} 有显示名`);
  }
});

test("claude 注入三件套 + NO_PROXY，上游真键标删，discovery 不注入", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const env = buildAgentSessionEnv({ agentId: "claude", token: TOKEN, base: fakeBase(root) });
    assert.deepEqual(Object.keys(env).sort(), [
      "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
      "NO_PROXY", "no_proxy",
    ]);
    assert.equal(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${AGENT_RELAY_PORT}`);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, TOKEN);
    assert.equal(env.NO_PROXY, LOOPBACK_NO_PROXY);
    assert.equal(env.no_proxy, LOOPBACK_NO_PROXY);
    assert.equal(env.ANTHROPIC_API_KEY, null, "上游真钥以 null 标删，不随继承环境带进 PTY");
    assert.equal(
      "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY" in env,
      false,
      "fake 布局没有 claude 的 package.json，版本读不到，discovery 保持关闭",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claude discovery 版本门：装的是已验证 2.1.x 族才注入发现开关", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    // 已验证族内的 patch 版本：开。面板终端 /model 拉常驻 relay 的 /v1/models。
    const inFamily = buildAgentSessionEnv({
      agentId: "claude", token: TOKEN, base: fakeBase(root, { claudePackageVersion: "2.1.220" }),
    });
    assert.equal(inFamily.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1", "2.1.220 在已验证 2.1.x 族内");

    const familyPatch = buildAgentSessionEnv({
      agentId: "claude", token: TOKEN, base: fakeBase(root, { claudePackageVersion: "2.1.9" }),
    });
    assert.equal(familyPatch.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1", "族内任意 patch 同样开：patch 不改发现过滤行为");

    // 族外大/小版本：门关——发现过滤行为未验证，不能承诺拉到的清单可用。
    const outOfFamily = buildAgentSessionEnv({
      agentId: "claude", token: TOKEN, base: fakeBase(root, { claudePackageVersion: "2.2.0" }),
    });
    assert.equal("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY" in outOfFamily, false, "2.2.x 未验证，discovery 不注入");

    // 版本字段非字符串（读得到 package.json 但 version 不是合法形态）同样关。
    const malformed = buildAgentSessionEnv({
      agentId: "claude", token: TOKEN, base: fakeBase(root, { claudePackageVersion: null }),
    });
    assert.equal("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY" in malformed, false, "version 非字符串按未验证处理");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kimi 与 claude 同协议，x-agent-id 随自定义头出站", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const env = buildAgentSessionEnv({ agentId: "kimi", token: TOKEN, base: fakeBase(root) });
    assert.deepEqual(Object.keys(env).sort(), [
      "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
      "KIMI_CODE_CUSTOM_HEADERS", "NO_PROXY", "no_proxy",
    ]);
    assert.equal(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${AGENT_RELAY_PORT}`);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, TOKEN);
    assert.ok(env.KIMI_CODE_CUSTOM_HEADERS.includes("x-agent-id: kimi"), "x-agent-id 是 relay 白名单与自动链的查找键");
    assert.equal(env.KIMI_CODE_CUSTOM_HEADERS, "x-agent-id: kimi", "只发端点身份，不发实例标签：实例行要认的身份是 relay 反查连接属主合成的 \"<agentId>-<pid>\"，自造的随机标签折不进规范形，会把一次会话拆成占位行与流量行两行");
    assert.equal(env.ANTHROPIC_API_KEY, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex 补实例 id 与 NO_PROXY，grok 只补 NO_PROXY 且双真键标删", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const codex = buildAgentSessionEnv({ agentId: "codex", token: TOKEN, base: fakeBase(root) });
    assert.deepEqual(Object.keys(codex).sort(), ["ANYSWITCH_INSTANCE_ID", "NO_PROXY", "no_proxy"]);
    assert.match(codex.ANYSWITCH_INSTANCE_ID, /^[A-Za-z0-9._:-]+$/);
    assert.equal("ANYSWITCH_RELAY_TOKEN" in codex, false, "codex 的 relay 令牌在托管 config.toml 里，不走 env");

    const grok = buildAgentSessionEnv({ agentId: "grok", token: TOKEN, base: fakeBase(root) });
    assert.deepEqual(Object.keys(grok).sort(), ["GROK_CODE_XAI_API_KEY", "NO_PROXY", "XAI_API_KEY", "no_proxy"]);
    assert.equal(grok.XAI_API_KEY, null, "xAI 真钥标删：内置直连不得绕过 relay");
    assert.equal(grok.GROK_CODE_XAI_API_KEY, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pi/dsh/opencode 带 relay 令牌，实例标签只有 pi 还发", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const pi = buildAgentSessionEnv({ agentId: "pi", token: TOKEN, base: fakeBase(root) });
    assert.deepEqual(Object.keys(pi).sort(), ["ANYSWITCH_INSTANCE_ID", "ANYSWITCH_RELAY_TOKEN", "NO_PROXY", "no_proxy"]);
    assert.equal(pi.ANYSWITCH_RELAY_TOKEN, TOKEN);

    const dsh = buildAgentSessionEnv({ agentId: "dsh", token: TOKEN, base: fakeBase(root) });
    assert.deepEqual(Object.keys(dsh).sort(), ["ANYSWITCH_RELAY_TOKEN", "NO_PROXY", "no_proxy"]);
    assert.equal(dsh.ANYSWITCH_RELAY_TOKEN, TOKEN);

    const opencode = buildAgentSessionEnv({ agentId: "opencode", token: TOKEN, base: fakeBase(root) });
    assert.deepEqual(Object.keys(opencode).sort(), ["ANYSWITCH_RELAY_TOKEN", "NO_PROXY", "no_proxy"]);
    assert.equal(opencode.ANYSWITCH_RELAY_TOKEN, TOKEN);

    // 与 dsh 同型：relay 令牌 + NO_PROXY 三键；实例 id 与 BYOK 配置同步都不收
    const qoder = buildAgentSessionEnv({ agentId: "qoder", token: TOKEN, base: fakeBase(root) });
    assert.deepEqual(Object.keys(qoder).sort(), ["ANYSWITCH_RELAY_TOKEN", "NO_PROXY", "no_proxy"]);
    assert.equal(qoder.ANYSWITCH_RELAY_TOKEN, TOKEN);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("base 恒为常驻 relay 47821，端口可显式覆盖", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const env = buildAgentSessionEnv({ agentId: "claude", token: TOKEN, base: fakeBase(root) });
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:47821", "不起 per-launch relay，base 恒为常驻 relay");
    assert.equal(AGENT_RELAY_PORT, 47821);
    const custom = buildAgentSessionEnv({ agentId: "claude", token: TOKEN, port: 47999, base: fakeBase(root) });
    assert.equal(custom.ANTHROPIC_BASE_URL, "http://127.0.0.1:47999");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("同一工作目录连开两个终端，实例 id 不撞车", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = fakeBase(root);
    // 经 launch 组装：实例 id 取自会话工作目录（独立调 buildAgentSessionEnv 时
    // 回退到 base.cwd/进程 cwd，面板流永远由 launch 显式带入）。
    const first = buildAgentSessionLaunch({ agentId: "codex", cwd: root, token: TOKEN, base });
    const second = buildAgentSessionLaunch({ agentId: "codex", cwd: root, token: TOKEN, base });
    assert.notEqual(first.env.ANYSWITCH_INSTANCE_ID, second.env.ANYSWITCH_INSTANCE_ID);
    for (const id of [first.env.ANYSWITCH_INSTANCE_ID, second.env.ANYSWITCH_INSTANCE_ID]) {
      assert.ok(id.length <= 64);
      assert.match(id, /^anyswitch-agent-env-[A-Za-z0-9-]+-t[0-9a-f]{8}$/, "cwd 基名 + 每会话随机标签");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("终端启动的实例身份：能按连接属主认出来的端点一律不自造标签", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = { ...fakeBase(root), cwd: root };
    // 这几家（加 dsh/qoder：它们的 build*Env 本就不收实例 id）不带
    // x-agent-instance 时，relay 用 netstat 反查连接属主合成 "<agentId>-<pid>"，
    // 那才是实例行唯一能对上进程扫描的身份。自造的随机标签只有数字尾巴折得进
    // 规范形，折不进就把一次会话拆成两行：带面徽标的进程占位行零计数、带全部
    // 计数的流量行读不出面，终端页的监测区与最近请求还按占位行 id 取数取到全零。
    for (const agentId of ["kimi", "grok", "opencode", "dsh", "qoder"]) {
      const env = buildAgentSessionEnv({ agentId, token: TOKEN, base });
      assert.equal("ANYSWITCH_INSTANCE_ID" in env, false, `${agentId} 不发实例标签变量`);
      assert.equal("ANYSWITCH_AGENT_INSTANCE" in env, false, `${agentId} 不发实例标签变量`);
      assert.ok(!JSON.stringify(env).includes("x-agent-instance"), `${agentId} 的出站头里不含实例标签`);
    }
    // 经 launch 组装（面板走的这条）同样不发：标签只在服务那两个客户端的
    // 配置契约时才造。
    const kimiLaunch = buildAgentSessionLaunch({ agentId: "kimi", cwd: root, token: TOKEN, base });
    assert.equal("ANYSWITCH_INSTANCE_ID" in kimiLaunch.env, false, "launch 路径与 env 路径同口径");
    assert.equal(kimiLaunch.env.KIMI_CODE_CUSTOM_HEADERS, "x-agent-id: kimi");

    // 两个例外按各自契约保留：pi 的 models.json 用 ${ANYSWITCH_INSTANCE_ID}
    // 占位符、缺变量启动即抛；codex 的实例身份正源是 prompt_cache_key，标签
    // 只是防撞车兜底。
    for (const agentId of ["pi", "codex"]) {
      const env = buildAgentSessionEnv({ agentId, token: TOKEN, base });
      assert.match(env.ANYSWITCH_INSTANCE_ID, /^anyswitch-agent-env-[A-Za-z0-9._:-]+-t[0-9a-f]{8}$/,
        `${agentId} 保留每会话随机标签`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch 一律 cmd /d /c 包装并前置 UTF-8 码页切换：归属链的硬前提，参数无任何凭证", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = fakeBase(root);
    for (const agentId of Object.keys(AGENT_TERMINAL_TARGETS)) {
      const launch = buildAgentSessionLaunch({ agentId, cwd: root, token: TOKEN, base });
      assert.equal(launch.shell, "cmd");
      assert.equal(launch.label, AGENT_TERMINAL_TARGETS[agentId].name);
      assert.equal(launch.agentId, agentId);
      assert.equal(launch.agentName, AGENT_TERMINAL_TARGETS[agentId].name);
      // ConPTY 下直接 spawn agent，父进程是 conhost（不在 agent-metrics 扫描
      // 名单），归属全丢；cmd 包装让 session.pid=cmd.exe 落在名单内。
      assert.equal(launch.launch.file, base.ComSpec, `${agentId} 经 cmd 启动`);
      assert.deepEqual(
        launch.launch.args.slice(0, 6),
        ["/d", "/c", "chcp", "65001", ">nul", "&"],
        `${agentId} 用 /d /c 防 cmd 自动运行脚本劫持，并在 cmd 内先切 UTF-8 码页再串接 agent`,
      );
      assert.ok(launch.launch.args[6].length > 0);
      // 凭证只走 env（由 build*Env 注入、terminal-host 只驻内存）；命令行参数
      // 与文件路径里不允许出现任何令牌。
      const commandLine = JSON.stringify({ file: launch.launch.file, args: launch.launch.args });
      assert.ok(!commandLine.includes(TOKEN), `${agentId} 的命令行不含 relay 令牌`);
      assert.ok(JSON.stringify(launch.env).includes(TOKEN) || agentId === "codex" || agentId === "grok" || agentId === "zcode",
        `${agentId} 的令牌经 env 注入（codex/grok 的令牌在各自托管配置里，zcode 的由 launcher 落槽位 provider_config.json）`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("码页前置的六个 token 全部不含空格：带空格会被 node-pty 套引号，cmd 就不按原生语义解析了", () => {
  // 乱码根因：ConPTY 伪控制台跟随系统 ANSI 码页（简中机 936/GBK），agent 的
  // UTF-8 色块字节在 PTY 入口就被按 GBK 解码成中文乱码。修复是把整棵进程树
  // 的伪控制台切到 65001；成立前提是 `chcp 65001 >nul &` 保持裸 token 形态
  // 抵达 cmd（node-pty 只对含空格参数加引号），真实 terminal-host 抓包已验证
  // 该形态乱码签名归零。任何人把这段合成单个字符串参数都会静默退回乱码。
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = fakeBase(root);
    for (const agentId of Object.keys(AGENT_TERMINAL_TARGETS)) {
      const launch = buildAgentSessionLaunch({ agentId, cwd: root, token: TOKEN, base });
      const prefix = launch.launch.args.slice(0, 6);
      assert.deepEqual(prefix, ["/d", "/c", "chcp", "65001", ">nul", "&"], `${agentId} 的码页前置必须是六个裸 token`);
      for (const token of prefix) {
        assert.ok(!token.includes(" "), `${agentId} 的前置参数 "${token}" 不得含空格`);
      }
      assert.ok(launch.launch.args[3] === "65001", `${agentId} 切的是 UTF-8 码页`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dsh 一键启动带 --profile dsh-tui：裸 dsh 会被 bin.js 拒绝启动", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = fakeBase(root);
    const dsh = buildAgentSessionLaunch({ agentId: "dsh", cwd: root, token: TOKEN, base });
    assert.deepEqual(dsh.launch.args.slice(7), ["--profile", "dsh-tui"], "dsh 必须带 profile 参数（与 dsh-cli 快捷命令同一口径）");
    for (const agentId of Object.keys(AGENT_TERMINAL_TARGETS)) {
      if (agentId === "dsh") continue;
      const launch = buildAgentSessionLaunch({ agentId, cwd: root, token: TOKEN, base });
      // zcode 固定 8 段：/d /c chcp 65001 >nul & + node.exe + launcher 路径
      //（launcher 形态见专项测试）。
      assert.equal(launch.launch.args.length, agentId === "zcode" ? 8 : 7, `${agentId} 维持零附加参数`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claude bypassPermissions 开关：开 = 追加 --dangerously-skip-permissions，关 = 原样", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = fakeBase(root);
    const off = buildAgentSessionLaunch({ agentId: "claude", cwd: root, token: TOKEN, base });
    assert.equal(off.launch.args.length, 7, "开关关着（默认）不多出参数");
    const on = buildAgentSessionLaunch({ agentId: "claude", cwd: root, token: TOKEN, base, claudeBypassPermissions: true });
    assert.deepEqual(on.launch.args.slice(7), ["--dangerously-skip-permissions"]);
    // 开关只属于 claude：其余端点不该因它多出任何参数。
    for (const agentId of Object.keys(AGENT_TERMINAL_TARGETS)) {
      if (agentId === "claude") continue;
      const launch = buildAgentSessionLaunch({ agentId, cwd: root, token: TOKEN, base, claudeBypassPermissions: true });
      assert.equal(launch.launch.args.length, agentId === "dsh" ? 9 : agentId === "zcode" ? 8 : 7, `${agentId} 不受 bypassPermissions 开关影响`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("可执行文件按 agent-discovery 解析，缺失即报错不静默", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = fakeBase(root);
    const launch = buildAgentSessionLaunch({ agentId: "codex", cwd: root, token: TOKEN, base });
    assert.equal(launch.launch.args[6], join(base.LOCALAPPDATA, "OpenAI", "Codex", "bin", "hash-1", "codex.exe"));

    const kimi = buildAgentSessionLaunch({ agentId: "kimi", cwd: root, token: TOKEN, base });
    assert.equal(kimi.launch.args[6], base.KIMI_EXECUTABLE);

    const broken = { ...base, GROK_EXECUTABLE: join(root, "bin", "gone.exe") };
    assert.throws(() => buildAgentSessionLaunch({ agentId: "grok", cwd: root, token: TOKEN, base: broken }), (error) => {
      assert.equal(error.code, "executable_missing");
      assert.match(error.message, /[\u4e00-\u9fff]/, "面向用户的 product 文案");
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("zcode 一键启动是 launcher 形态：cmd /d /c node.exe <launcher>，env 零注入", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = fakeBase(root);
    const launch = buildAgentSessionLaunch({ agentId: "zcode", cwd: root, token: TOKEN, base });
    assert.equal(launch.label, "ZCode");
    assert.equal(launch.agentName, "ZCode");
    assert.equal(launch.shell, "cmd");
    assert.equal(launch.launch.file, base.ComSpec, "经 cmd 启动（归属链硬前提）");
    // CLI 入口是 node 拉起的 bin\zcode.mjs，cmd /d /c 不能直接执行 .mjs：
    // 执行体是 node.exe 本身（process.execPath），launcher 绝对路径作为参数。
    const launcherPath = fileURLToPath(new URL("./zcode-cli-launcher.mjs", import.meta.url));
    assert.deepEqual(launch.launch.args, ["/d", "/c", "chcp", "65001", ">nul", "&", process.execPath, launcherPath]);
    // 凭证不骑环境变量：relay token 由 launcher 作为 apiKey 落进槽位
    // provider_config.json，终端注入为零。
    assert.deepEqual(launch.env, {});
    assert.ok(!JSON.stringify({ file: launch.launch.file, args: launch.launch.args }).includes(TOKEN), "命令行不含 relay 令牌");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("zcode CLI 未装：入口解析不到即报 executable_missing 产品文案", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = fakeBase(root);
    // 覆盖变量指向不存在的绝对路径：agent-discovery 只验绝对路径，存在性
    // 由终端侧包装补齐。
    const brokenOverride = { ...base, ZCODE_CLI_EXECUTABLE: join(root, "bin", "gone.mjs") };
    // 不设覆盖、默认构建路径也不存在：resolveZcodeCliExecutable 返回 null。
    const noCli = { ...base };
    delete noCli.ZCODE_CLI_EXECUTABLE;
    for (const broken of [brokenOverride, noCli]) {
      assert.throws(() => buildAgentSessionLaunch({ agentId: "zcode", cwd: root, token: TOKEN, base: broken }), (error) => {
        assert.equal(error.code, "executable_missing");
        assert.match(error.message, /[一-鿿]/, "面向用户的 product 文案");
        return true;
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("终端一键启动 codex：npm 全局 shim 存在时用它，不再误报未安装", () => {
  // 回归：面板更新按钮装的是 npm 全局包，检测侧认的也是它；终端侧若只解析官方
  // 原生安装位，npm 装的 codex 会在「+」菜单里列出却一点就报「没有找到程序」。
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = { ...fakeBase(root), APPDATA: join(root, "roaming") };
    const shim = join(base.APPDATA, "npm", "codex.cmd");
    mkdirSync(dirname(shim), { recursive: true });
    writeFileSync(shim, "");
    const launch = buildAgentSessionLaunch({ agentId: "codex", cwd: root, token: TOKEN, base });
    assert.equal(launch.launch.args[6], shim, "npm 全局装的 codex 走 shim，与检测侧同源");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未知 agentId 与缺失/不存在的工作目录都报错，不静默回落", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = fakeBase(root);
    for (const build of [buildAgentSessionEnv, buildAgentSessionLaunch]) {
      assert.throws(() => build({ agentId: "codex-desktop", cwd: root, token: TOKEN, base }), (error) => {
        assert.equal(error.code, "unknown_agent");
        return true;
      });
    }
    assert.throws(() => buildAgentSessionLaunch({ agentId: "kimi", cwd: "", token: TOKEN, base }), (error) => {
      assert.equal(error.code, "invalid_cwd");
      return true;
    });
    assert.throws(() => buildAgentSessionLaunch({ agentId: "kimi", cwd: "   ", token: TOKEN, base }), { code: "invalid_cwd" });
    assert.throws(() => buildAgentSessionLaunch({ agentId: "kimi", cwd: join(root, "no-such-dir"), token: TOKEN, base }), (error) => {
      assert.equal(error.code, "invalid_cwd");
      assert.match(error.message, /[\u4e00-\u9fff]/);
      return true;
    });
    assert.throws(() => buildAgentSessionLaunch({ agentId: "kimi", cwd: undefined, token: TOKEN, base }), { code: "invalid_cwd" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 续接历史会话：服务端只收会话身份（endpoint/id/file），命令按 session-scan
// 的 RESUME_COMMAND 模板重建——客户端给什么命令原文都不接。
const RESUME_SESSION_ID = "3f2b8c1e-9a44-4d0b-8f6e-1c2d3e4f5a6b";
const RESUME_FILE = "C:\\Users\\someone\\.pi\\sessions\\3f2b8c1e.jsonl";

// 每个端点的续接参数（模板去掉命令名之后的部分）。
const RESUME_ARGS_BY_ENDPOINT = {
  claude: ["--resume", RESUME_SESSION_ID],
  kimi: ["--session", RESUME_SESSION_ID],
  pi: ["--session", RESUME_FILE],
  opencode: ["--session", RESUME_SESSION_ID],
  codex: ["resume", RESUME_SESSION_ID],
  grok: ["--resume", RESUME_SESSION_ID],
};

test("续接：六个端点按模板重建参数，exe/env/label 与普通启动同源", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = fakeBase(root);
    for (const [endpoint, expected] of Object.entries(RESUME_ARGS_BY_ENDPOINT)) {
      // 实例标签按会话现造随机值，比对 env 时固定住它，只验「续接不改 env」。
      const plain = buildAgentSessionLaunch({ agentId: endpoint, cwd: root, token: TOKEN, base, instanceId: "pinned" });
      const resumed = buildAgentSessionLaunch({
        agentId: endpoint,
        cwd: root,
        token: TOKEN,
        base,
        instanceId: "pinned",
        resume: { endpoint, id: RESUME_SESSION_ID, file: RESUME_FILE },
      });
      assert.deepEqual(
        resumed.launch.args.slice(0, 7),
        plain.launch.args.slice(0, 7),
        `${endpoint} 的码页前置与执行体不变（归属链与 UTF-8 伪控制台硬前提）`,
      );
      assert.deepEqual(resumed.launch.args.slice(7), expected, `${endpoint} 的续接参数来自 RESUME_COMMAND 模板`);
      assert.equal(resumed.launch.file, plain.launch.file, `${endpoint} 仍经 cmd 包装`);
      assert.deepEqual(resumed.env, plain.env, `${endpoint} 的凭证注入与普通启动逐位一致`);
      assert.equal(resumed.label, plain.label, `${endpoint} 的页签名仍是 agent 显示名`);
      assert.equal(resumed.cwd, plain.cwd);
      assert.equal(resumed.agentId, endpoint);
      // 续接身份（会话 id / 存档路径）不是凭证，但也绝不夹带令牌。
      assert.ok(!JSON.stringify(resumed.launch.args).includes(TOKEN), `${endpoint} 命令行不含 relay 令牌`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("续接：只有模板表内的端点支持，dsh/zcode/qoder 报 resume-unsupported", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = fakeBase(root);
    for (const endpoint of ["dsh", "zcode", "qoder"]) {
      assert.throws(
        () => buildAgentSessionLaunch({
          agentId: endpoint,
          cwd: root,
          token: TOKEN,
          base,
          resume: { endpoint, id: RESUME_SESSION_ID },
        }),
        (error) => {
          assert.equal(error.code, "resume-unsupported", `${endpoint} 不在续接白名单`);
          assert.match(error.message, /[\u4e00-\u9fff]/, `${endpoint} 报产品文案而不是机器码`);
          return true;
        },
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("续接：非法 endpoint 与身份字段一律拒绝，不猜不回落", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = fakeBase(root);
    const build = (resume) => () => buildAgentSessionLaunch({ agentId: "kimi", cwd: root, token: TOKEN, base, resume });

    // endpoint 缺失/空串/非字符串 → resume-invalid（身份不全）；非表内键 →
    // resume-unsupported（端点不支持续接）。
    for (const resume of [{ id: RESUME_SESSION_ID }, { endpoint: "", id: RESUME_SESSION_ID },
      { endpoint: "  ", id: RESUME_SESSION_ID }, { endpoint: 42, id: RESUME_SESSION_ID }]) {
      assert.throws(build(resume), { code: "resume-invalid" }, `endpoint=${JSON.stringify(resume.endpoint)} 判身份不全`);
    }
    assert.throws(build({ endpoint: "no-such-agent", id: RESUME_SESSION_ID }), { code: "resume-unsupported" });
    // 原型链上的键不能当模板用。
    assert.throws(build({ endpoint: "constructor", id: RESUME_SESSION_ID }), { code: "resume-unsupported" });

    // 载荷形态/身份字段不合法 → resume-invalid。
    assert.throws(build("kimi"), { code: "resume-invalid" }, "resume 不是对象");
    assert.throws(build([]), { code: "resume-invalid" });
    assert.throws(build({ endpoint: "kimi" }), { code: "resume-invalid" }, "缺 id");
    assert.throws(build({ endpoint: "kimi", id: "   " }), { code: "resume-invalid" }, "id 全空白");
    assert.throws(build({ endpoint: "kimi", id: 123 }), { code: "resume-invalid" }, "id 非字符串");
    assert.throws(build({ endpoint: "pi", id: RESUME_SESSION_ID }), { code: "resume-invalid" }, "pi 缺存档路径");
    // 续接身份与要启动的 agent 不一致：不能拿 A 的模板拼 B 的命令。
    assert.throws(build({ endpoint: "claude", id: RESUME_SESSION_ID }), { code: "resume-invalid" });

    // cmd 元字符进不了命令行（这些身份值会被 cmd 当命令分隔符/重定向解释）。
    for (const id of ["a&calc", "a|b", "a>b", "a^b", 'a"b', "a%PATH%b", "a b", "a\r\nb"]) {
      assert.throws(build({ endpoint: "kimi", id }), { code: "resume-invalid" }, `id ${JSON.stringify(id)} 被拒`);
    }
    for (const file of ['C:\\a"b.jsonl', "C:\\a&b.jsonl", "C:\\a%b.jsonl", "C:\\a|b.jsonl"]) {
      assert.throws(
        build({ endpoint: "pi", id: RESUME_SESSION_ID, file }),
        { code: "resume-invalid" },
        `pi 存档路径 ${JSON.stringify(file)} 被拒`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("续接：带空格的存档路径整体作为一个参数交给 node-pty，不被拆成两段", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = fakeBase(root);
    const file = "C:\\Users\\John Doe\\.pi\\sessions\\3f2b8c1e.jsonl";
    const launch = buildAgentSessionLaunch({
      agentId: "pi",
      cwd: root,
      token: TOKEN,
      base,
      resume: { endpoint: "pi", id: RESUME_SESSION_ID, file },
    });
    assert.deepEqual(launch.launch.args.slice(7), ["--session", file], "含空格的路径保持单参数（node-pty 会加引号）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("续接：纯函数可桩测，返回模板端点与重建出的参数", () => {
  for (const [endpoint, expected] of Object.entries(RESUME_ARGS_BY_ENDPOINT)) {
    assert.deepEqual(
      buildAgentResumeArgs({ endpoint, id: RESUME_SESSION_ID, file: RESUME_FILE }),
      { endpoint, args: expected },
      `${endpoint} 的组装是纯函数，不起进程、不读盘`,
    );
  }
});

test("无 resume 字段：九端点启动参数与改造前逐位一致", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = fakeBase(root);
    for (const agentId of Object.keys(AGENT_TERMINAL_TARGETS)) {
      const plain = buildAgentSessionLaunch({ agentId, cwd: root, token: TOKEN, base, instanceId: "pinned" });
      for (const resume of [undefined, null]) {
        const same = buildAgentSessionLaunch({ agentId, cwd: root, token: TOKEN, base, instanceId: "pinned", resume });
        assert.deepEqual(same.launch.args, plain.launch.args, `${agentId} 在 resume=${resume} 时参数不变`);
        assert.deepEqual(same.env, plain.env, `${agentId} 在 resume=${resume} 时 env 不变`);
        assert.equal(same.label, plain.label);
        assert.equal(same.cwd, plain.cwd);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
