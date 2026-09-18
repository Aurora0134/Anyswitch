import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CLIENT_PACKAGES, CLIENT_ACTIONS, clientLifecycleKind, resolveNpmCli, runClientLifecycle } from "./client-lifecycle.mjs";

const ALL_CLIENTS = ["claude", "codex", "opencode", "pi", "kimi", "dsh", "zcode", "qoder"];

test("npm 代管清单恰好覆盖 6 个 CLI 客户端，桌面应用缺席", () => {
  assert.deepEqual(Object.keys(CLIENT_PACKAGES).sort(), ["claude", "codex", "dsh", "kimi", "opencode", "pi"].sort());
  for (const id of ["zcode", "qoder", "not-a-client", "claude/../../etc", "constructor"]) {
    assert.equal(clientLifecycleKind(id), null);
  }
  for (const id of ALL_CLIENTS.slice(0, 6)) assert.equal(clientLifecycleKind(id), "npm");
  assert.throws(() => { CLIENT_PACKAGES.claude = "evil"; }, TypeError, "清单被冻结，不能被改写");
});

test("前端关于页的更新按钮清单与服务端 npm 包表一致", () => {
  // 两个清单分居前后端，任何一端增删客户端而忘记另一端都会让按钮与服务端行为漂移
  const panelJs = readFileSync(new URL("./panel-ui/panel.js", import.meta.url), "utf8");
  const match = panelJs.match(/updatableClients = new Set\(\[([^\]]+)\]\)/);
  assert.ok(match, "panel.js 里存在 updatableClients 集合");
  const ids = JSON.parse(`[${match[1]}]`);
  assert.deepEqual(ids.sort(), Object.keys(CLIENT_PACKAGES).sort());
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
  for (const [id, action] of [["zcode", "update"], ["qoder", "install"], ["nope", "update"], ["claude", "reinstall"], ["claude", "rm -rf /"]]) {
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
