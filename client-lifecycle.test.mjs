import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CLIENT_PACKAGES, CLIENT_ACTIONS, NATIVE_CLIENTS, WINGET_CLIENTS, OFFICIAL_MSIX_CLIENTS, clientLifecycleKind, clientLifecycleActions, clientLifecycleLegs, resolveNpmCli, runClientLifecycle } from "./client-lifecycle.mjs";

const ALL_CLIENTS = ["claude", "codex", "opencode", "pi", "kimi", "dsh", "zcode", "qoder"];

test("npm 代管清单恰好覆盖 6 个 CLI 客户端，桌面应用缺席", () => {
  assert.deepEqual(Object.keys(CLIENT_PACKAGES).sort(), ["claude", "codex", "dsh", "kimi", "opencode", "pi"].sort());
  for (const id of ["zcode", "not-a-client", "claude/../../etc", "constructor"]) {
    assert.equal(clientLifecycleKind(id), null);
  }
  for (const id of ALL_CLIENTS.slice(0, 6)) assert.equal(clientLifecycleKind(id), "npm");
  assert.throws(() => { CLIENT_PACKAGES.claude = "evil"; }, TypeError, "清单被冻结，不能被改写");
});

test("Grok Build 与 Qoder CLI 走自身升级命令，且只接受更新", () => {
  assert.deepEqual(Object.keys(NATIVE_CLIENTS), ["grok", "qoder"]);
  assert.equal(clientLifecycleKind("grok"), "native");
  assert.equal(clientLifecycleKind("qoder"), "native");
  assert.deepEqual([...clientLifecycleActions("qoder")], ["update"], "未安装时面板不代装 qoder");
  assert.deepEqual([...clientLifecycleActions("grok")], ["update"], "未安装时面板不代装 grok");
  assert.deepEqual([...clientLifecycleActions("claude")].sort(), ["install", "update"]);
  assert.deepEqual([...clientLifecycleActions("zcode")], [], "桌面应用没有任何代管动作");
  assert.deepEqual([...clientLifecycleActions("constructor")], [], "原型链上的名字不是客户端");
  assert.throws(() => { NATIVE_CLIENTS.grok.package = "evil"; }, TypeError);
  assert.equal(NATIVE_CLIENTS.qoder.package, undefined, "qoder 没有 npm 兜底这一跳（已被明确否决）");
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
  const result = await runClientLifecycle({ id: "dsh", action: "update", spawn, execPath: "C:\\node\\node.exe", io });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const { file, args, options } = calls[0];
  assert.equal(file, "C:\\node\\node.exe");
  assert.deepEqual(args, [npmCli, "install", "--global", "--no-audit", "--no-fund", "@deepseek-ai/dsh@latest"]);
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

// ── Qoder CLI：只跑自身的 qodercli update，没有 npm 兜底 ──────────────────
const QODER_EXE = "C:\\Users\\me\\.qoder\\bin\\qodercli\\qodercli.exe";

test("qoder 自身升级成功时不碰 npm，命令不经 shell", async () => {
  const { calls, spawn } = fakeSpawn((_, callback) => callback(null, "Already up to date\n", ""));
  const result = await runClientLifecycle({
    id: "qoder", action: "update", commandPath: QODER_EXE, targetVersion: "1.1.64",
    spawn, execPath: "C:\\node\\node.exe", io: grokIo,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1, "升级成功就结束，没有第二跳");
  assert.equal(calls[0].file, QODER_EXE);
  assert.deepEqual(calls[0].args, ["update"]);
  assert.equal(calls[0].options.shell, undefined, "不经 shell，参数逐项传递");
  assert.equal(calls[0].options.windowsHide, true);
});

test("qoder 自身升级失败也不降级 npm：官方版本在手同样只有一跳", async () => {
  const { calls, spawn } = fakeSpawn((_, callback) =>
    callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "qodercli update failed: network unreachable"));
  const result = await runClientLifecycle({
    id: "qoder", action: "update", commandPath: QODER_EXE, targetVersion: "1.1.64",
    spawn, execPath: "C:\\node\\node.exe", io: grokIo,
  });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1, "spec 没有 package 就没有兜底安装——兜底会把原生单文件执行体换成另一种形态（已被否决）");
  assert.match(result.output, /qodercli update failed/);
});

test("qoder 检测不到执行体时不执行任何命令", async () => {
  const { calls, spawn } = fakeSpawn((_, callback) => callback(null, "", ""));
  const result = await runClientLifecycle({
    id: "qoder", action: "update", commandPath: null, targetVersion: "1.1.64",
    spawn, execPath: "C:\\node\\node.exe", io: grokIo,
  });
  assert.equal(result.ok, false);
  assert.equal(result.unsupported, true);
  assert.equal(calls.length, 0);
});

// ── Codex 双腿：CLI 走 npm，桌面走 winget 商店源 ──────────────────

test("形态腿清单：codex 与 claude 双腿，其余单腿或没有", () => {
  assert.deepEqual(clientLifecycleLegs("codex"), [{ form: "cli", kind: "npm" }, { form: "desktop", kind: "winget" }]);
  assert.deepEqual(clientLifecycleLegs("claude"), [{ form: "cli", kind: "npm" }, { form: "desktop", kind: "official-msix" }]);
  assert.deepEqual(clientLifecycleLegs("kimi"), [{ form: "cli", kind: "npm" }]);
  assert.deepEqual(clientLifecycleLegs("qoder"), [{ form: "cli", kind: "native" }]);
  assert.deepEqual([...clientLifecycleLegs("zcode")], []);
  assert.deepEqual([...clientLifecycleLegs("constructor")], [], "原型链上的名字不是客户端");
  assert.throws(() => { WINGET_CLIENTS.codex.packageId = "evil"; }, TypeError);
  assert.throws(() => { OFFICIAL_MSIX_CLIENTS.claude.packageName = "evil"; }, TypeError);
});

test("codex 双腿串行：先 npm 后 winget，两跳都不经 shell", async () => {
  const { calls, spawn } = fakeSpawn((_, callback) => callback(null, "", ""));
  const npmCli = "C:\\node\\node_modules\\npm\\bin\\npm-cli.js";
  const io = { existsSync: (path) => path === npmCli };
  const result = await runClientLifecycle({ id: "codex", action: "update", spawn, execPath: "C:\\node\\node.exe", io });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].file, "C:\\node\\node.exe", "CLI 腿照旧走 npm-cli.js");
  assert.equal(calls[1].file, "winget");
  assert.deepEqual(calls[1].args, ["install", "--id", "9PLM9XGG6VKS", "--source", "msstore"]);
  assert.equal(calls[1].options.shell, undefined, "不经 shell，参数逐项传递");
  assert.deepEqual(result.legs.map((l) => l.form), ["cli", "desktop"]);
});

test("codex 桌面腿 exit 43 或无可用升级文案都记为已最新，整体仍算成功，不开商店页", async () => {
  const io = { existsSync: () => true };
  for (const impl of [
    (call, callback) => callback(call.file === "winget" ? Object.assign(new Error("exit 43"), { code: 43 }) : null, "", ""),
    (call, callback) => callback(call.file === "winget" ? Object.assign(new Error("exit 1"), { code: 1 }) : null, "找不到可用的升级", ""),
    (call, callback) => callback(call.file === "winget" ? Object.assign(new Error("exit 1"), { code: 1 }) : null, "No applicable upgrade found", ""),
  ]) {
    const { calls, spawn } = fakeSpawn(impl);
    const result = await runClientLifecycle({ id: "codex", action: "update", spawn, execPath: "C:\node\node.exe", io });
    assert.equal(result.ok, true);
    const desktop = result.legs.find((l) => l.form === "desktop");
    assert.equal(desktop.ok, true);
    assert.equal(desktop.noUpgrade, true);
    assert.equal(calls.some((c) => c.file === "explorer.exe"), false, "已最新不算失败，不打扰用户");
  }
});

test("codex 桌面腿失败时打开商店页降级，整体记失败", async () => {
  const { calls, spawn } = fakeSpawn((call, callback) => callback(
    call.file === "winget" ? Object.assign(new Error("0x8a150044"), { code: 1 }) : null,
    call.file === "winget" ? "" : "",
    call.file === "winget" ? "store source unavailable" : "",
  ));
  const result = await runClientLifecycle({ id: "codex", action: "update", spawn, execPath: "C:\node\node.exe", io: { existsSync: () => true } });
  assert.equal(result.ok, false);
  const desktop = result.legs.find((l) => l.form === "desktop");
  assert.equal(desktop.ok, false);
  assert.equal(desktop.storePageOpened, true);
  const store = calls.find((c) => c.file === "explorer.exe");
  assert.deepEqual(store.args, ["ms-windows-store://pdp/?productid=9PLM9XGG6VKS"]);
});

test("codex 桌面腿 winget 缺失时不伪装失败也不开商店页", async () => {
  const { calls, spawn } = fakeSpawn((call, callback) => callback(
    call.file === "winget" ? Object.assign(new Error("spawn winget ENOENT"), { code: "ENOENT" }) : null, "", ""));
  const result = await runClientLifecycle({ id: "codex", action: "update", spawn, execPath: "C:\node\node.exe", io: { existsSync: () => true } });
  const desktop = result.legs.find((l) => l.form === "desktop");
  assert.equal(desktop.ok, false);
  assert.equal(desktop.wingetMissing, true);
  assert.equal(desktop.storePageOpened, undefined, "winget 都没有时商店页没有意义");
  assert.equal(calls.some((c) => c.file === "explorer.exe"), false);
});

test("codex 任一腿被超时杀掉都会向上聚合 timedOut", async () => {
  const { spawn } = fakeSpawn((call, callback) => callback(
    call.file === "winget" ? Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }) : null, "", ""));
  const result = await runClientLifecycle({ id: "codex", action: "update", spawn, execPath: "C:\node\node.exe", io: { existsSync: () => true } });
  assert.equal(result.timedOut, true);
});

// ── Claude 双腿：CLI 走 npm，桌面走官渠 MSIX（全 PowerShell，全替身） ──────────

const claudeNpmCli = "C:\\node\\node_modules\\npm\\bin\\npm-cli.js";

// 桌面腿的 PS 调用按脚本特征认步名，替身按步名应答。
function msixStepOf(call) {
  const script = String(call.args[2]);
  if (script.includes("Get-AppxPackage")) return "installed";
  if (script.includes("ConvertFrom-Json")) return "metadata";
  if (script.includes("Get-Process")) return "running";
  if (script.includes("-OutFile")) return "download";
  if (script.includes("Get-AuthenticodeSignature")) return "signature";
  if (script.includes("Add-AppxPackage")) return "install";
  return "unknown";
}

function msixSpawn(responders) {
  const calls = [];
  const spawn = (file, args, options, callback) => {
    const call = { file, args, options };
    calls.push(call);
    if (file !== "powershell") return callback(null, "", ""); // CLI 腿：npm 成功
    const respond = responders[msixStepOf(call)];
    assert.ok(respond, `PS 步 ${msixStepOf(call)} 有应答替身`);
    respond(call, callback);
  };
  return { calls, spawn, psCalls: () => calls.filter((c) => c.file === "powershell") };
}

// io 替身：existsSync 只认 npm-cli.js（CLI 腿要过 npm 解析）；readFileSync 演
// ant-did（内容是 base64，解出 device_id）；rmSync 记录临时文件清理。
function claudeIo({ deviceId = "11111111-2222-3333-4444-555555555555" } = {}) {
  const rmCalls = [];
  const io = {
    existsSync: (path) => path === claudeNpmCli,
    readFileSync: (path) => {
      if (String(path).endsWith("ant-did") && deviceId !== null) return Buffer.from(deviceId, "utf8").toString("base64");
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    rmSync: (path) => { rmCalls.push(path); },
  };
  return { io, rmCalls };
}

const okPs = {
  installed: (call, callback) => callback(null, "1.37937.1.0\r\n", ""),
  metadata: (call, callback) => callback(null, JSON.stringify({ version: "2.9939.2", url: "https://downloads.claude.ai/releases/Claude-2.9939.2.msix" }), ""),
  running: (call, callback) => callback(null, "", ""),
  download: (call, callback) => callback(null, "", ""),
  signature: (call, callback) => callback(null, JSON.stringify({ status: "Valid", signer: 'CN="Anthropic, PBC", O="Anthropic, PBC", C=US' }), ""),
  install: (call, callback) => callback(null, "", ""),
};

test("claude 双腿串行：CLI 走 npm，桌面腿六步 PS 全走注入 spawn 且不经 shell", async () => {
  const { calls, spawn, psCalls } = msixSpawn(okPs);
  const { io } = claudeIo();
  const result = await runClientLifecycle({ id: "claude", action: "update", spawn, execPath: "C:\\node\\node.exe", io });
  assert.equal(result.ok, true);
  assert.deepEqual(result.legs.map((leg) => [leg.form, leg.ok]), [["cli", true], ["desktop", true]]);
  assert.equal(result.legs[1].installedVersion, "2.9939.2", "装完报的是官渠元数据版本");
  assert.equal(calls[0].file, "C:\\node\\node.exe", "CLI 腿照旧走 npm-cli.js");
  assert.deepEqual(psCalls().map(msixStepOf), ["installed", "metadata", "running", "download", "signature", "install"]);
  for (const call of psCalls()) {
    assert.deepEqual(call.args.slice(0, 2), ["-NoProfile", "-Command"]);
    assert.equal(call.options.shell, undefined, "不经 shell，参数逐项传递");
    assert.equal(call.options.windowsHide, true);
  }
  const meta = psCalls()[1];
  assert.equal(meta.options.env.ANYS_MSIX_METADATA_URL, "https://api.anthropic.com/api/desktop/win32/x64/msix/update");
  assert.equal(meta.options.env.ANYS_MSIX_DEVICE_ID, "11111111-2222-3333-4444-555555555555", "device_id 来自 ant-did 的 base64 解码");
  const download = psCalls()[3];
  assert.equal(download.options.env.ANYS_MSIX_URL, "https://downloads.claude.ai/releases/Claude-2.9939.2.msix", "下载地址来自元数据，经环境变量进脚本");
  assert.ok(download.options.timeout > psCalls()[0].options.timeout, "MSIX 近 300MB，下载超时单独放宽");
});

test("claude 桌面腿已最新（元数据版本 ≤ 已装，四段剥尾比对）不下载不安装", async () => {
  const { spawn, psCalls } = msixSpawn({
    ...okPs,
    installed: (call, callback) => callback(null, "2.9939.2.0\r\n", ""),
  });
  const { io } = claudeIo();
  const result = await runClientLifecycle({ id: "claude", action: "update", spawn, execPath: "C:\\node\\node.exe", io });
  assert.equal(result.ok, true);
  const desktop = result.legs.find((leg) => leg.form === "desktop");
  assert.equal(desktop.noUpgrade, true);
  assert.deepEqual(psCalls().map(msixStepOf), ["installed", "metadata"], "比对通过即停，不进下载");
});

test("claude 桌面形态没装时该腿记普通失败，不代装", async () => {
  const { spawn, psCalls } = msixSpawn({ ...okPs, installed: (call, callback) => callback(null, "", "") });
  const { io } = claudeIo();
  const result = await runClientLifecycle({ id: "claude", action: "update", spawn, execPath: "C:\\node\\node.exe", io });
  assert.equal(result.ok, false);
  const desktop = result.legs.find((leg) => leg.form === "desktop");
  assert.equal(desktop.ok, false);
  assert.equal(desktop.networkError, undefined, "没装不是网络问题");
  assert.equal(desktop.appRunning, undefined);
  assert.deepEqual(psCalls().map(msixStepOf), ["installed"], "第一步即止步");
});

test("claude 桌面壳在跑时不下载不安装，归 appRunning", async () => {
  const { spawn, psCalls } = msixSpawn({ ...okPs, running: (call, callback) => callback(null, "running\r\n", "") });
  const { io, rmCalls } = claudeIo();
  const result = await runClientLifecycle({ id: "claude", action: "update", spawn, execPath: "C:\\node\\node.exe", io });
  const desktop = result.legs.find((leg) => leg.form === "desktop");
  assert.equal(desktop.ok, false);
  assert.equal(desktop.appRunning, true);
  assert.deepEqual(psCalls().map(msixStepOf), ["installed", "metadata", "running"], "挡在下载前");
  assert.deepEqual(rmCalls, [], "还没下载，没有临时文件要清");
});

test("claude 元数据拉取失败归 networkError，不下载", async () => {
  const { spawn, psCalls } = msixSpawn({
    ...okPs,
    metadata: (call, callback) => callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "Invoke-WebRequest : 远程服务器返回错误: (403) 已禁止。"),
  });
  const { io } = claudeIo();
  const result = await runClientLifecycle({ id: "claude", action: "update", spawn, execPath: "C:\\node\\node.exe", io });
  const desktop = result.legs.find((leg) => leg.form === "desktop");
  assert.equal(desktop.networkError, true);
  assert.deepEqual(psCalls().map(msixStepOf), ["installed", "metadata"]);
});

test("claude 下载失败归 networkError，临时文件被清理", async () => {
  const { spawn, psCalls } = msixSpawn({
    ...okPs,
    download: (call, callback) => callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "Invoke-WebRequest : 连接超时"),
  });
  const { io, rmCalls } = claudeIo();
  const result = await runClientLifecycle({ id: "claude", action: "update", spawn, execPath: "C:\\node\\node.exe", io });
  const desktop = result.legs.find((leg) => leg.form === "desktop");
  assert.equal(desktop.networkError, true);
  assert.deepEqual(psCalls().map(msixStepOf), ["installed", "metadata", "running", "download"], "不到验签");
  assert.equal(rmCalls.length, 1);
  assert.match(rmCalls[0], /anys-claude-msix-\d+\.msix$/);
});

test("claude 验签不过即中止，不安装", async () => {
  for (const [label, respond] of [
    ["签名者不是 Anthropic", (call, callback) => callback(null, JSON.stringify({ status: "Valid", signer: 'CN="Evil Corp"' }), "")],
    ["未签名", (call, callback) => callback(null, JSON.stringify({ status: "NotSigned", signer: "" }), "")],
    ["验签命令本身失败", (call, callback) => callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "boom")],
  ]) {
    const { spawn, psCalls } = msixSpawn({ ...okPs, signature: respond });
    const { io } = claudeIo();
    const result = await runClientLifecycle({ id: "claude", action: "update", spawn, execPath: "C:\\node\\node.exe", io });
    const desktop = result.legs.find((leg) => leg.form === "desktop");
    assert.equal(desktop.ok, false, label);
    assert.equal(desktop.networkError, undefined, "验签不过是普通失败，不归网络");
    assert.equal(desktop.appRunning, undefined);
    assert.deepEqual(psCalls().map(msixStepOf), ["installed", "metadata", "running", "download", "signature"], `${label}：不到安装步`);
  }
});

test("claude ant-did 缺失时不带 device_id 仍拉元数据", async () => {
  const { spawn, psCalls } = msixSpawn(okPs);
  const { io } = claudeIo({ deviceId: null });
  const result = await runClientLifecycle({ id: "claude", action: "update", spawn, execPath: "C:\\node\\node.exe", io });
  assert.equal(result.ok, true);
  assert.equal(psCalls()[1].options.env.ANYS_MSIX_DEVICE_ID, "", "缺失即不带参数试一次");
});

test("claude 官渠腿成功路径同样清理临时安装包", async () => {
  const { spawn } = msixSpawn(okPs);
  const { io, rmCalls } = claudeIo();
  const result = await runClientLifecycle({ id: "claude", action: "update", spawn, execPath: "C:\\node\\node.exe", io });
  assert.equal(result.ok, true);
  assert.equal(rmCalls.length, 1);
  assert.match(rmCalls[0], /anys-claude-msix-\d+\.msix$/);
});
