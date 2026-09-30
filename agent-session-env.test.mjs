import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_TERMINAL_TARGETS,
  AGENT_RELAY_PORT,
  buildAgentSessionEnv,
  buildAgentSessionLaunch,
} from "./agent-session-env.mjs";

const TOKEN = "relay-session-token-abc123";
const LOOPBACK_NO_PROXY = "127.0.0.1,localhost";

// A machine-like environment: every agent's executable resolves to a real file
// under one temp root (agent-discovery's overrides all accept absolute paths),
// ComSpec points at a fake cmd.exe, and no store.json exists unless a test
// writes one.
function fakeBase(root, { withStore = null, claudeSmallFast = undefined, claudePackageVersion = undefined } = {}) {
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
    // Codex is discovered by globbing <LOCALAPPDATA>\OpenAI\Codex\bin\<hash>\codex.exe；
    // qoder CLI 固定在 <USERPROFILE>\.qoder\bin\qodercli\qodercli.exe（resolveQoderCliExecutable
    // 不收覆盖变量），fakeBase 直接摆出这份目录。
    LOCALAPPDATA: join(root, "local"),
    USERPROFILE: join(root, "user"),
    ...(claudeSmallFast === undefined ? {} : { ANTHROPIC_SMALL_FAST_MODEL: claudeSmallFast }),
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
  if (withStore) {
    mkdirSync(join(base.LOCALAPPDATA, "Anyswitch"), { recursive: true });
    writeFileSync(join(base.LOCALAPPDATA, "Anyswitch", "store.json"), JSON.stringify(withStore));
  }
  return base;
}

test("白名单只含进终端的 CLI Agent，桌面 GUI 不在列", () => {
  assert.deepEqual(Object.keys(AGENT_TERMINAL_TARGETS), ["claude", "codex", "kimi", "pi", "dsh", "opencode", "grok", "qoder"]);
  for (const banned of ["zcode", "codex-desktop"]) {
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
      "ANTHROPIC_SMALL_FAST_MODEL", "NO_PROXY", "no_proxy",
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
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "anthropic/your-provider/your-small-fast-model", "无 store 时落 launcher 占位 wire id");
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

test("claude 分类器模型：store 派生优先，用户显式覆盖时不注入", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const store = { providers: { "a6api-main": { models: { "kimi-k3": {} } } } };
    const derived = buildAgentSessionEnv({ agentId: "claude", token: TOKEN, base: fakeBase(root, { withStore: store }) });
    assert.equal(derived.ANTHROPIC_SMALL_FAST_MODEL, "anthropic/a6api-main/kimi-k3", "store 第一个 provider 的第一个模型");

    const overridden = buildAgentSessionEnv({
      agentId: "claude", token: TOKEN,
      base: fakeBase(root, { withStore: store, claudeSmallFast: "anthropic/mine/small" }),
    });
    assert.equal("ANTHROPIC_SMALL_FAST_MODEL" in overridden, false, "用户显式覆盖优先：不注入，继承值生效");
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

test("launch 一律 cmd /d /c 包装：归属链的硬前提，参数无任何凭证", () => {
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
      assert.deepEqual(launch.launch.args.slice(0, 2), ["/d", "/c"], `${agentId} 用 /d /c 防 cmd 自动运行脚本劫持`);
      assert.ok(launch.launch.args[2].length > 0);
      // 凭证只走 env（由 build*Env 注入、terminal-host 只驻内存）；命令行参数
      // 与文件路径里不允许出现任何令牌。
      const commandLine = JSON.stringify({ file: launch.launch.file, args: launch.launch.args });
      assert.ok(!commandLine.includes(TOKEN), `${agentId} 的命令行不含 relay 令牌`);
      assert.ok(JSON.stringify(launch.env).includes(TOKEN) || agentId === "codex" || agentId === "grok",
        `${agentId} 的令牌经 env 注入（codex/grok 的令牌在各自托管配置里）`);
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
    assert.deepEqual(dsh.launch.args.slice(3), ["--profile", "dsh-tui"], "dsh 必须带 profile 参数（与 dsh-cli 快捷命令同一口径）");
    for (const agentId of Object.keys(AGENT_TERMINAL_TARGETS)) {
      if (agentId === "dsh") continue;
      const launch = buildAgentSessionLaunch({ agentId, cwd: root, token: TOKEN, base });
      assert.equal(launch.launch.args.length, 3, `${agentId} 维持零附加参数`);
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
    assert.equal(off.launch.args.length, 3, "开关关着（默认）不多出参数");
    const on = buildAgentSessionLaunch({ agentId: "claude", cwd: root, token: TOKEN, base, claudeBypassPermissions: true });
    assert.deepEqual(on.launch.args.slice(3), ["--dangerously-skip-permissions"]);
    // 开关只属于 claude：其余端点不该因它多出任何参数。
    for (const agentId of Object.keys(AGENT_TERMINAL_TARGETS)) {
      if (agentId === "claude") continue;
      const launch = buildAgentSessionLaunch({ agentId, cwd: root, token: TOKEN, base, claudeBypassPermissions: true });
      assert.equal(launch.launch.args.length, agentId === "dsh" ? 5 : 3, `${agentId} 不受 bypassPermissions 开关影响`);
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
    assert.equal(launch.launch.args[2], join(base.LOCALAPPDATA, "OpenAI", "Codex", "bin", "hash-1", "codex.exe"));

    const kimi = buildAgentSessionLaunch({ agentId: "kimi", cwd: root, token: TOKEN, base });
    assert.equal(kimi.launch.args[2], base.KIMI_EXECUTABLE);

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

test("未知 agentId 与缺失/不存在的工作目录都报错，不静默回落", () => {
  const root = mkdtempSync(join(tmpdir(), "anyswitch-agent-env-"));
  try {
    const base = fakeBase(root);
    for (const build of [buildAgentSessionEnv, buildAgentSessionLaunch]) {
      assert.throws(() => build({ agentId: "zcode", cwd: root, token: TOKEN, base }), (error) => {
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
