import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CLIENT_PACKAGES, CLIENT_ACTIONS, NATIVE_CLIENTS, clientLifecycleKind, clientLifecycleActions, resolveNpmCli, runClientLifecycle } from "./client-lifecycle.mjs";

const ALL_CLIENTS = ["claude", "codex", "opencode", "pi", "kimi", "dsh", "zcode", "qoder"];

test("npm 代管清单恰好覆盖 6 个 CLI 客户端，桌面应用缺席", () => {
  assert.deepEqual(Object.keys(CLIENT_PACKAGES).sort(), ["claude", "codex", "dsh", "kimi", "opencode", "pi"].sort());
  for (const id of ["zcode", "qoder", "not-a-client", "claude/../../etc", "constructor"]) {
    assert.equal(clientLifecycleKind(id), null);
  }
  for (const id of ALL_CLIENTS.slice(0, 6)) assert.equal(clientLifecycleKind(id), "npm");
  assert.throws(() => { CLIENT_PACKAGES.claude = "evil"; }, TypeError, "清单被冻结，不能被改写");
});

test("Grok Build 走自身升级命令，且只接受更新", () => {
  assert.deepEqual(Object.keys(NATIVE_CLIENTS), ["grok"]);
  assert.equal(clientLifecycleKind("grok"), "native");
  assert.deepEqual([...clientLifecycleActions("grok")], ["update"], "未安装时面板不代装 grok");
  assert.deepEqual([...clientLifecycleActions("claude")].sort(), ["install", "update"]);
  assert.deepEqual([...clientLifecycleActions("zcode")], [], "桌面应用没有任何代管动作");
  assert.deepEqual([...clientLifecycleActions("constructor")], [], "原型链上的名字不是客户端");
  assert.throws(() => { NATIVE_CLIENTS.grok.package = "evil"; }, TypeError);
});

test("前端关于页的按钮清单与服务端两张表一致", () => {
  // 两个清单分居前后端，任何一端增删客户端而忘记另一端都会让按钮与服务端行为漂移
  const panelJs = readFileSync(new URL("./panel-ui/panel.js", import.meta.url), "utf8");
  const listed = (name) => {
    const match = panelJs.match(new RegExp(`${name} = new Set\\(\\[([^\\]]+)\\]\\)`));
    assert.ok(match, `panel.js 里存在 ${name} 集合`);
    return JSON.parse(`[${match[1]}]`).sort();
  };
  assert.deepEqual(listed("updatableClients"), [...Object.keys(CLIENT_PACKAGES), ...Object.keys(NATIVE_CLIENTS)].sort());
  assert.deepEqual(listed("installableClients"), Object.keys(CLIENT_PACKAGES).sort());
});

test("动作白名单只有安装与更新", () => {
  assert.deepEqual([...CLIENT_ACTIONS].sort(), ["install", "update"]);
  assert.throws(() => CLIENT_ACTIONS.push("wipe"), TypeError);
});

test("npm 解析：找到 node 旁边的 npm-cli.js，缺失时返回 null", () => {
  const execPath = "C:\\Program Files\\nodejs\\node.exe";
  const expected = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  assert.equal(resolveNpmCli({ execPath, io: { existsSync: (path) => path === expected } }), expected);
  assert.equal(resolveNpmCli({ execPath, io: { existsSync: () => false } }), null);
});

function fakeSpawn(impl) {
  const calls = [];
  const spawn = (file, args, options, callback) => { calls.push({ file, args, options }); impl(calls[calls.length - 1], callback); };
  return { calls, spawn };
}

test("安装命令：node 直跑 npm-cli.js，不经 shell，包名来自服务端固定表", async () => {
  const { calls, spawn } = fakeSpawn((_, callback) => callback(null, "", ""));
  const npmCli = "C:\\node\\node_modules\\npm\\bin\\npm-cli.js";
  const io = { existsSync: (path) => path === npmCli };
  const result = await runClientLifecycle({ id: "claude", action: "update", spawn, execPath: "C:\\node\\node.exe", io });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const { file, args, options } = calls[0];
  assert.equal(file, "C:\\node\\node.exe");
  assert.deepEqual(args, [npmCli, "install", "--global", "--no-audit", "--no-fund", "@anthropic-ai/claude-code@latest"]);
  assert.equal(options.shell, undefined, "不经 shell，参数是数组逐项传递");
  assert.equal(options.windowsHide, true);
  assert.ok(options.timeout >= 5 * 60 * 1000, "超时是分钟级兜底，不会中途杀掉慢安装");
});

test("未知客户端或非法动作不触发任何进程", async () => {
  const { calls, spawn } = fakeSpawn((_, callback) => callback(null, "", ""));
  for (const [id, action] of [["zcode", "update"], ["qoder", "install"], ["nope", "update"], ["claude", "reinstall"], ["claude", "rm -rf /"], ["grok", "install"]]) {
    const result = await runClientLifecycle({ id, action, spawn });
    assert.equal(result.ok, false);
    assert.equal(result.unsupported, true);
  }
  assert.equal(calls.length, 0);
});

test("找不到 npm 时给出可区分的结果，不伪装成命令失败", async () => {
  const { calls, spawn } = fakeSpawn(() => { throw new Error("must not spawn"); });
  const result = await runClientLifecycle({ id: "kimi", action: "update", spawn, execPath: "C:\\no-npm\\node.exe", io: { existsSync: () => false } });
  assert.equal(result.ok, false);
  assert.equal(result.npmMissing, true);
  assert.equal(calls.length, 0);
});

test("命令失败带标准错误末行，超时被标记为超时", async () => {
  const longStderr = Array.from({ length: 20 }, (_, index) => `npm warn line ${index}`).join("\n") + "\nnpm error _http fetch failed";
  const { spawn } = fakeSpawn((_, callback) => callback(Object.assign(new Error("exit 1"), { code: 1 }), "", longStderr));
  const npmCli = "C:\\node\\node_modules\\npm\\bin\\npm-cli.js";
  const io = { existsSync: (path) => path === npmCli };
  const failed = await runClientLifecycle({ id: "codex", action: "update", spawn, execPath: "C:\\node\\node.exe", io });
  assert.equal(failed.ok, false);
  assert.equal(failed.timedOut, false);
  assert.match(failed.output, /npm error _http fetch failed/);
  assert.ok(!failed.output.includes("npm warn line 0"), "只保留末行，整段安装日志不进入结果");

  const { spawn: killing } = fakeSpawn((_, callback) => callback(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }), "", ""));
  const timedOut = await runClientLifecycle({ id: "codex", action: "update", spawn: killing, execPath: "C:\\node\\node.exe", io });
  assert.equal(timedOut.timedOut, true);
});

test("管道/文件名里带空格与特殊字符的执行路径原样传递，不做字符串拼接", async () => {
  const { calls, spawn } = fakeSpawn((_, callback) => callback(null, "", ""));
  const npmCli = "C:\\Program Files (x86)\\node dir\\node_modules\\npm\\bin\\npm-cli.js";
  const io = { existsSync: () => true };
  await runClientLifecycle({ id: "dsh", action: "install", spawn, execPath: "C:\\Program Files (x86)\\node dir\\node.exe", io });
  assert.equal(calls[0].args[0], npmCli);
  assert.deepEqual(calls[0].args.slice(1, 4), ["install", "--global", "--no-audit"]);
});

// ── Grok Build：先跑它自身的升级命令，失败才降级到 npm ──────────────────
const GROK_EXE = "C:\\Users\\me\\.grok\\bin\\grok.exe";
const grokNpmCli = "C:\\node\\node_modules\\npm\\bin\\npm-cli.js";
const grokIo = { existsSync: (path) => path === grokNpmCli };

test("grok 自身升级成功时不碰 npm，命令不经 shell", async () => {
  const { calls, spawn } = fakeSpawn((_, callback) => callback(null, "Already up to date\n", ""));
  const result = await runClientLifecycle({
    id: "grok", action: "update", commandPath: GROK_EXE, targetVersion: "1.0.41",
    spawn, execPath: "C:\\node\\node.exe", io: grokIo,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1, "升级成功就结束，不再有第二跳");
  assert.equal(calls[0].file, GROK_EXE);
  assert.deepEqual(calls[0].args, ["update"]);
  assert.equal(calls[0].options.shell, undefined, "不经 shell，参数逐项传递");
  assert.equal(calls[0].options.windowsHide, true);
});

test("grok 自身升级失败时降级到 npm，钉住官方版本、显式指官方 registry 并放行该包脚本", async () => {
  const { calls, spawn } = fakeSpawn((call, callback) => callback(
    call.file === GROK_EXE ? Object.assign(new Error("GCS channel pointer fetch failed"), { code: 1 }) : null,
    "",
    call.file === GROK_EXE ? "Error: No such file or directory (os error 2)" : "",
  ));
  const result = await runClientLifecycle({
    id: "grok", action: "update", commandPath: GROK_EXE, targetVersion: "1.0.41",
    spawn, execPath: "C:\\node\\node.exe", io: grokIo,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, [
    grokNpmCli, "install", "--global", "--no-audit", "--no-fund",
    "--registry=https://registry.npmjs.org", "--allow-scripts=@xai-official/grok", "@xai-official/grok@1.0.41",
  ], "版本钉死且不跟随用户 registry：镜像的 latest 落后时会把执行体降级");
  assert.equal(calls[1].file, "C:\\node\\node.exe");
});

for (const targetVersion of [null, undefined, "latest", "0.1.4.9", "1.0.41 ; rm", ""])
  test(`拿不到可信的官方版本（${JSON.stringify(targetVersion)}）时不做兜底安装`, async () => {
    const { calls, spawn } = fakeSpawn((_, callback) => callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "update failed"));
    const result = await runClientLifecycle({
      id: "grok", action: "update", commandPath: GROK_EXE, targetVersion,
      spawn, execPath: "C:\\node\\node.exe", io: grokIo,
    });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1, "只跑客户端自身的升级命令");
    assert.match(result.output, /update failed/);
  });

test("兜底安装也失败时两跳的末行一起上报", async () => {
  const { spawn } = fakeSpawn((call, callback) => callback(
    Object.assign(new Error("exit 1"), { code: 1 }),
    "",
    call.file === GROK_EXE ? "self-update said no" : "npm error code UNAUTHORIZED",
  ));
  const result = await runClientLifecycle({
    id: "grok", action: "update", commandPath: GROK_EXE, targetVersion: "1.0.41",
    spawn, execPath: "C:\\node\\node.exe", io: grokIo,
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /self-update said no/);
  assert.match(result.output, /npm error code UNAUTHORIZED/);
});

for (const commandPath of [null, undefined, "", "grok.exe", "./grok.exe"])
  test(`检测不到执行体（${JSON.stringify(commandPath)}）时不执行任何命令`, async () => {
    const { calls, spawn } = fakeSpawn((_, callback) => callback(null, "", ""));
    const result = await runClientLifecycle({
      id: "grok", action: "update", commandPath, targetVersion: "1.0.41",
      spawn, execPath: "C:\\node\\node.exe", io: grokIo,
    });
    assert.equal(result.ok, false);
    assert.equal(result.unsupported, true);
    assert.equal(calls.length, 0);
  });
