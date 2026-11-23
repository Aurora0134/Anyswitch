import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { manifestBytes, publishBuild, releaseChannel, signManifest, versionFromTag } from "./build.mjs";
import { resolveLauncher } from "./package-dispatch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const seed = Buffer.alloc(32, 23).toString("base64");

test("SemVer tags distinguish prerelease from build metadata", () => {
  assert.equal(versionFromTag("v1.2.3"), "1.2.3");
  assert.equal(versionFromTag("v1.2.3+ci-build"), "1.2.3+ci-build");
  assert.equal(releaseChannel("1.2.3+ci-build"), "stable");
  assert.equal(releaseChannel("1.2.3-rc.1"), "preview");
  for (const value of ["v01.2.3", "v1.2.3-01", "v1.2.3-", "v1.2.3-a..b", "1.2.3"]) assert.throws(() => versionFromTag(value));
});

test("package-health.mjs parses and the silent launcher VBS compiles cleanly", () => {
  const health = spawnSync(process.execPath, ["--check", join(here, "package-health.mjs")], { encoding: "utf8" });
  assert.equal(health.status, 0, "package-health.mjs 必须可解析（安装健康检查的载体）：" + health.stderr);
  const vbs = spawnSync("cscript", ["//nologo", join(here, "anyswitch-silent.vbs")], { encoding: "utf8" });
  assert.equal(vbs.status, 1, "无参数运行应走参数检查退出码 1");
  const noise = (vbs.stdout || "") + (vbs.stderr || "");
  assert.ok(!/VBScript|编译|compil/i.test(noise), "VBS 必须干净编译（装后唯一入口的启动载体）：" + noise);
});

test("manifest bytes are canonical and Ed25519 signature verifies", () => {
  const version = "1.2.3-preview.4";
  const asset = "anyswitch-v" + version + "-win-x64-desktop.zip";
  const archive = Buffer.from("test archive");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const bytes = manifestBytes({ version, channel: "preview", asset, sha256, size: archive.length });
  const manifest = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(Object.keys(manifest), ["schema", "version", "channel", "platform", "asset", "sha256", "size"]);
  assert.equal(bytes.toString("utf8"), JSON.stringify(manifest));
  const signed = signManifest(bytes, seed);
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(signed.publicKey, "base64")]);
  assert.equal(Buffer.from(signed.publicKey, "base64").length, 32);
  assert.equal(Buffer.from(signed.signature, "base64").length, 64);
  assert.ok(verify(null, bytes, createPublicKey({ key: der, format: "der", type: "spki" }), Buffer.from(signed.signature, "base64")));
  assert.throws(() => manifestBytes({ version, channel: "stable", asset, sha256, size: 1 }));
  assert.throws(() => manifestBytes({ version, channel: "preview", asset: "wrong.zip", sha256, size: 1 }));
  assert.throws(() => signManifest(bytes, undefined), /required/);
});

test("failed and repeated builds cannot publish partial output", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "anyswitch-build-contract-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const output = join(base, "output");
  await assert.rejects(publishBuild(output, async (work) => {
    await writeFile(join(work, "partial.zip"), "partial");
    throw new Error("interrupted");
  }), /interrupted/);
  await assert.rejects(readFile(output), { code: "ENOENT" });
  await publishBuild(output, async (work) => writeFile(join(work, "complete.zip"), "complete"));
  assert.equal(await readFile(join(output, "complete.zip"), "utf8"), "complete");
  await assert.rejects(publishBuild(output, async () => {}), /must not already exist/);
});

test("launcher path stays inside active app root with Unicode spaces", async (t) => {
  const app = await mkdtemp(join(tmpdir(), "Anyswitch 中文 app "));
  t.after(() => rm(app, { recursive: true, force: true }));
  await mkdir(join(app, "src", "launchers"), { recursive: true });
  await writeFile(join(app, "src", "launchers", "probe.mjs"), "");
  assert.equal(resolveLauncher(app, "src/launchers/probe.mjs"), resolve(app, "src", "launchers", "probe.mjs"));
  for (const value of ["../outside.mjs", "C:/outside.mjs", "src/launchers/probe.js"]) assert.throws(() => resolveLauncher(app, value));
});

test("Inno activation checks one candidate and preserves owned registry baselines", async () => {
  const script = await readFile(join(here, "..", "..", "installer", "windows", "anyswitch.iss"), "utf8");
  const code = await readFile(join(here, "..", "..", "installer", "windows", "install-code.iss"), "utf8");
  assert.ok(!script.includes("AfterInstall:"));
  assert.equal(code.split("procedure CurStepChanged(CurStep: TSetupStep);").length - 1, 1);
  assert.ok(code.includes("function PrepareRegistryOwnership(Root: String): Boolean;"));
  assert.ok(code.includes("if not CheckCandidate then RaiseException"));
  assert.ok(code.includes("ManagedInstallRoot"));
  assert.ok(code.includes("PreviousInstallRoot"));
  assert.ok(code.includes("PreviousEnvRoot"));
  assert.ok(code.includes("if RegQueryStringValue(HKCU, PackageKey, 'ManagedInstallRoot'"));
  assert.ok(!code.includes("ssDone"));
});

test("Inno rollback on failed install covers registry, pointer and version tree", async () => {
  const code = await readFile(join(here, "..", "..", "installer", "windows", "install-code.iss"), "utf8");
  // 补偿回滚三段按序：指针回滚 → 注册表基线还原 → 指针未指向本次版本才删版本树。
  const deinit = /procedure DeinitializeSetup;([\s\S]*?)\nend;/.exec(code);
  assert.ok(deinit, "DeinitializeSetup 必须存在");
  assert.ok(deinit[1].includes("if SetupComplete then Exit;"), "完成后不得回滚");
  assert.ok(deinit[1].includes("if PointerChanged then"), "指针回滚必须保留");
  assert.ok(deinit[1].includes("if RegistryWritten then RestoreOwnedRegistry(Root);"), "注册表基线必须回滚");
  assert.ok(deinit[1].includes("DeleteOwnedTree(Root + '\\versions\\{#ReleaseVersion}')"), "失败安装的版本树必须清残");
  assert.ok(deinit[1].includes('Pos(\'"version":"{#ReleaseVersion}"\''), "删版本树前必须确认指针未指向本次版本");
  // RegistryWritten 只在 PrepareRegistryOwnership 实际写盘分支置位（同名托管锁直通
  // 与异根基线拒绝两个早退分支不得置位，否则误回滚别人持有的托管锁）。
  assert.equal(code.split("RegistryWritten := True").length - 1, 1);
  assert.ok(/function PrepareRegistryOwnership[\s\S]*RegistryWritten := True;[\s\S]*?\nend;/.test(code));
});

test("uninstall hook unregisters owned scheduled tasks and the desktop shortcut", async () => {
  const code = await readFile(join(here, "..", "..", "installer", "windows", "install-code.iss"), "utf8");
  // 五个任务名与 src/ops/autostart.mjs 的注册面一致（含两个 ApiCred* 历史名）；
  // 按 Actions[0].Arguments 比对安装根，源码安装的同名任务不碰。
  assert.ok(code.includes("Unregister-ScheduledTask"), "卸载必须注销自启任务");
  assert.ok(code.includes("$t.Actions[0].Arguments"), "注销前必须按任务参数比对安装根");
  for (const name of ["AnyswitchRelay", "AnyswitchWatchdog", "AnyswitchPanel", "ApiCredRelay", "ApiCredWatchdog"])
    assert.ok(code.includes(`''${name}''`), `卸载钩子缺任务名 ${name}`);
  // 桌面 Anyswitch.lnk 由运行时创建（src/ops/desktop-shortcut.mjs），不在卸载日志内：
  // 读回校验 target/arguments 指本安装根才删。
  assert.ok(code.includes("WScript.Shell"));
  assert.ok(code.includes("{userdesktop}\\Anyswitch.lnk"));
  assert.ok(code.includes("DeleteOwnedDesktopShortcut(Root);"));
});

test("RemoveSettings manifest stays in sync with the data-root write surface", async () => {
  const code = await readFile(join(here, "..", "..", "installer", "windows", "install-code.iss"), "utf8");
  // 数据根写入面常量表：卸载弹窗承诺删除设置、凭据与备份，清单须覆盖运行时全部落盘物。
  // 每条附一处源码证据文件，漂移时测试双向报错。
  const files = [
    ["store.json", "src/agents/agent-sync.mjs"],
    ["settings.json", "src/catalog/effort-catalog.mjs"],
    ["prompts.json", "src/agents/agent-prompts.mjs"],
    ["skills.json", "src/agents/agent-skills.mjs"],
    ["pi-relay-token", "src/launchers/opencode-merge-config.mjs"],
    ["pi-relay-token-chain.json", "src/launchers/pi-relay-token.mjs"],
    ["pi-relay-token-usage.json", "src/launchers/pi-relay-token.mjs"],
    ["terminal-sessions.json", "src/relay/relay-host.mjs"],
    ["terminal-rail.json", "src/terminal/terminal-rail-store.mjs"],
    ["terminal-conversation-bindings.json", "src/terminal/terminal-conversation-bindings.mjs"],
    ["thinking-efforts.db.json", "src/catalog/effort-catalog.mjs"],
    ["sync-status.json", "src/shared/sync-status.mjs"],
    ["terminal-switch.log", "src/panel/panel.mjs"],
    ["delete-journal.json", "src/store/store-service.mjs"],
    ["relay.pid", "src/relay/relay-process-manager.mjs"],
    ["watchdog.pid", "src/ops/retire-agent-watchdog.mjs"],
    ["terminal-host.pid", "src/terminal/terminal-process-manager.mjs"],
    ["agent-metrics-snapshot.json", "src/agents/agent-metrics.mjs"],
    ["model-stability.json", "src/catalog/model-stability.mjs"],
    ["backup-root.json", "src/ops/backup-location.mjs"],
    // sidecar 家族（渠道托管记忆）：与 src/ops/uninstall-agent.mjs 的
    // ENDPOINT_DEFS 逐条对上，root 均为 relayDataRoot（各 launcher 的
    // sidecarRoot = relayDataRoot(base) 传参）。
    ["codex-sidecar.json", "src/launchers/codex-merge-config.mjs"],
    ["dsh-sidecar.json", "src/launchers/dsh-merge-config.mjs"],
    ["grok-sidecar.json", "src/launchers/grok-merge-config.mjs"],
    ["kimi-sidecar.json", "src/launchers/kimi-merge-config.mjs"],
    ["opencode-sidecar.json", "src/launchers/opencode-merge-config.mjs"],
    ["pi-sidecar.json", "src/launchers/pi-merge-models.mjs"],
    ["qoder-sidecar.json", "src/launchers/qoder-merge-config.mjs"],
    ["workbuddy-sidecar.json", "src/launchers/workbuddy-merge-models.mjs"],
    ["zcode-sidecar.json", "src/launchers/zcode-merge-config.mjs"],
    ["zcode-cli-sidecar.json", "src/launchers/zcode-merge-config.mjs"],
  ];
  const trees = [
    ["credentials", "src/store/data-bundle.mjs"],
    ["logs", "src/panel/panel-host.mjs"],
    ["webview", "installer/windows/desktop/Desktop.cs"],
    ["backups", "src/ops/backup-location.mjs"],
    ["client-updates", "src/agents/client-update-journal.mjs"],
    ["usage", "src/launchers/codex-launcher.mjs"],
    ["bin", "src/agents/agent-skills.mjs"],
    // zcode-cli 槽位目录：Anyswitch 自有 CLI 槽位（provider_config.json），
    // zcode-cli-launcher.mjs 的 zcodeCliDataDir = relayDataRoot\zcode-cli。
    ["zcode-cli", "src/launchers/zcode-cli-launcher.mjs"],
  ];
  for (const [name, evidence] of files) {
    assert.ok(code.includes(`DeleteOwnedFile(DataRoot, '${name}');`), `RemoveSettings 缺文件 ${name}`);
    assert.ok((await readFile(join(here, "..", "..", evidence), "utf8")).includes(`"${name}"`), `${evidence} 不再写 ${name}，常量表需复核`);
  }
  for (const [name, evidence] of trees) {
    assert.ok(code.includes(`DeleteOwnedTree(DataRoot + '\\${name}');`), `RemoveSettings 缺目录 ${name}`);
    assert.ok((await readFile(join(here, "..", "..", evidence), "utf8")).includes(`"${name}"`), `${evidence} 不再写 ${name}，常量表需复核`);
  }
  // 反向比对：清单不得多出常量表之外的条目（防止误删未核实的数据）。
  const listed = [...code.matchAll(/DeleteOwnedFile\(DataRoot, '([^']+)'\);/g)].map((m) => m[1]);
  assert.deepEqual(new Set(listed), new Set(files.map(([name]) => name)));
  const listedTrees = [...code.matchAll(/DeleteOwnedTree\(DataRoot \+ '\\([^']+)'\);/g)].map((m) => m[1]);
  assert.deepEqual(new Set(listedTrees), new Set(trees.map(([name]) => name)));
  // 自选备份根：删 backup-root.json 前先读 root 字段，非默认根整树清（备份不保留）。
  const backupIdx = code.indexOf("ExtractBackupRoot(DataRoot)");
  assert.ok(backupIdx >= 0 && backupIdx < code.indexOf("DeleteOwnedFile(DataRoot, 'backup-root.json');"), "必须先读自选备份根再删 backup-root.json");
  // {app}\staging 是自更新落盘暂存，不在卸载日志内，须显式清。
  assert.ok(code.includes("DeleteOwnedTree(Root + '\\staging');"), "卸载必须清安装根 staging");
});

test("same-version leftover offers cleanup confirmation, active version stays hard-rejected", async () => {
  const code = await readFile(join(here, "..", "..", "installer", "windows", "install-code.iss"), "utf8");
  const validator = /function ValidateInstallRoot\(Path: String\): String;([\s\S]*?)\nend;/.exec(code);
  assert.ok(validator, "ValidateInstallRoot 必须存在");
  // 文案③逐字（用户已批）：确认→DeleteOwnedTree 清理后继续；拒绝维持硬拒句式。
  assert.ok(validator[1].includes("if MsgBox('A leftover from a previous incomplete installation of this version was found. Remove it and continue?', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) <> IDYES then Exit;"), "残留确认框文案③必须逐字在位");
  // 指针仍指向本版本＝在用的活动版本而非残留：确认框之前必须先过指针闸。
  const guard = validator[1].indexOf(`Pos('"version":"{#ReleaseVersion}"', ActiveText) > 0`);
  const prompt = validator[1].indexOf("A leftover from a previous incomplete installation");
  assert.ok(guard >= 0 && guard < prompt, "活动版本指针闸必须先于残留确认框");
  // 清理失败（占用等）或防护跳过后目录仍在，都维持拒绝，不新造文案。
  assert.ok(validator[1].includes("if not DeleteOwnedTree(VersionTree) then Exit;"), "清理失败必须维持拒绝");
  assert.ok(validator[1].includes("if GetFileAttributes(VersionTree) <> InvalidAttributes then Exit;"), "清理后必须复核目录确已不在");
  assert.ok(validator[1].includes("Result := 'This version is already present in the installation folder.';"), "拒绝句式复用既有错误文案");
  // Inno Pascal 无前置声明：DeleteOwnedTree 必须定义在 ValidateInstallRoot 之前。
  assert.ok(code.indexOf("function DeleteOwnedTree(Path: String): Boolean;") >= 0, "DeleteOwnedTree 必须带成败返回");
  assert.ok(code.indexOf("function DeleteOwnedTree(Path: String): Boolean;") < code.indexOf("function ValidateInstallRoot(Path: String): String;"), "DeleteOwnedTree 必须先于 ValidateInstallRoot 定义");
  // 双闸语义一致：目录页 Next 与 PrepareToInstall 都过同一 ValidateInstallRoot。
  assert.ok(/function NextButtonClick[\s\S]*?ValidateInstallRoot\(WizardDirValue\)/.test(code), "NextButtonClick 闸必须在位");
  assert.ok(/function PrepareToInstall[\s\S]*?ValidateInstallRoot\(WizardDirValue\)/.test(code), "PrepareToInstall 闸必须在位");
});

test("uninstall prompts: backups in settings copy and one in-use leftover guidance", async () => {
  const code = await readFile(join(here, "..", "..", "installer", "windows", "install-code.iss"), "utf8");
  // 文案④逐字（用户已批）：删除面扩到备份，弹窗承诺对齐。
  assert.ok(code.includes("MsgBox('Also delete Anyswitch settings, stored credentials and backups? The source installation and its Git history will be kept.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2)"), "卸载弹窗文案④必须逐字在位");
  assert.ok(!code.includes("Also delete Anyswitch settings and stored credentials?"), "旧卸载文案必须替换干净");
  // 文案⑤逐字（用户已批）：占用残留末尾指引一次，路径为实际残留根；静默卸载不弹，全删净不弹。
  assert.ok(code.includes("MsgBox('Some files could not be removed because they are in use. After closing Anyswitch, delete them manually from: ' + UninstallResidueRoot, mbInformation, MB_OK)"), "残留指引文案⑤必须逐字在位");
  assert.ok(code.includes("if (UninstallResidueRoot <> '') and not UninstallSilent then"), "指引必须只在有残留且非静默时弹");
  // 残留记账：整树删除与单文件删除的失败都汇入同一残留根（先记先赢）。
  assert.ok(/procedure UninstallDeleteOwnedTree\(Path: String\);[\s\S]*?if not DeleteOwnedTree\(Path\) then NoteUninstallResidue\(Path\);/.test(code), "整树删除失败必须记残留");
  assert.ok(/procedure DeleteOwnedFile\(Root, Name: String\);[\s\S]*?NoteUninstallResidue\(Root\);/.test(code), "单文件删除失败必须记残留");
});

test("path-prefix boundary protects task unregister and desktop shortcut cleanup", async () => {
  const code = await readFile(join(here, "..", "..", "installer", "windows", "install-code.iss"), "utf8");
  // 子串命中后须校验命中点之后是路径分隔符或串尾，防 C:\Anyswitch 误伤 C:\Anyswitch-src。
  assert.ok(code.includes("$al.IndexOf($r)"), "任务比对必须先定位命中点");
  assert.ok(code.includes("$i+$r.Length -eq $al.Length -or $al[$i+$r.Length]"), "任务比对必须校验命中点后字符");
  assert.ok(!code.includes(".Contains($r)"), "裸 Contains 子串比对必须下线");
  // 桌面快捷方式走同口径帮手：串尾或路径分隔符才算命中。
  assert.ok(/function PathMentionsRoot\(Haystack, LowerRoot: String\): Boolean;[\s\S]*?Pos\(LowerRoot, Lower\)[\s\S]*?\nend;/.test(code), "PathMentionsRoot 帮手必须在位");
  assert.ok(code.includes("if not PathMentionsRoot(Target, LowerRoot) and not PathMentionsRoot(Arguments, LowerRoot) then Exit;"), "快捷方式读回校验必须过边界帮手");
});
test("Windows CMD dispatcher preserves empty arguments, spaces and exit code", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "Anyswitch 中文 空格 "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const versionRoot = join(root, "versions", "1.2.3");
  const app = join(versionRoot, "app");
  const runtime = join(versionRoot, "runtime");
  await mkdir(join(app, "src", "launchers"), { recursive: true });
  await mkdir(runtime, { recursive: true });
  await writeFile(join(root, "current.json"), JSON.stringify({ schema: 1, version: "1.2.3" }));
  await cp(process.execPath, join(runtime, "node.exe"));
  await cp(join(here, "package-dispatch.mjs"), join(app, "package-dispatch.mjs"));
  await cp(join(here, "dispatch.ps1"), join(root, "dispatch.ps1"));
  await cp(join(here, "anyswitch.cmd"), join(root, "anyswitch.cmd"));
  await writeFile(join(app, "src", "launchers", "probe.mjs"), "console.log(JSON.stringify({args:process.argv.slice(2),root:process.env.ANYSWITCH_INSTALL_ROOT,app:process.env.ANYSWITCH_APP_ROOT}));process.exit(7);");
  const wrapper = join(root, "anyswitch.cmd");
  const command = '""' + wrapper + '" "src\\launchers\\probe.mjs" --profile dsh-tui one "" "two words""';
  const result = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true, timeout: 30_000 });
  assert.equal(result.error, undefined, result.error && result.error.message);
  assert.equal(result.status, 7, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(value.args, ["--profile", "dsh-tui", "one", "", "two words"]);
  assert.equal(value.root, root);
  assert.equal(value.app, app);
});
