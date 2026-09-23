// data-bundle 的集成测试：全部在临时 LOCALAPPDATA 下跑，不碰真 DPAPI、
// 不碰真数据目录。打包解包走真 bsdtar（包格式本身就是被测对象之一），
// 只把 protect / unprotect 换成可逆的假实现。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkTestDir } from "./test-helpers/tmp.mjs";
import { ensureLayout, storePaths, writeStore } from "./store-io.mjs";
import { assertSafeEntries, createDataBundleService, exportFileName, CREDENTIALS_NAME, TICKET_TTL_MS } from "./data-bundle.mjs";

// 预览的暂存目录落在 %TEMP% 下、前缀固定，用调用前后的差集认出它——
// 「密钥有没有留在盘上」这件事只能在真实文件系统上判，不能问返回值。
const importStagingDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("anyswitch-import-"));
function newStagingDir(before) {
  const fresh = importStagingDirs().filter((d) => !before.includes(d));
  assert.equal(fresh.length, 1, `一次预览应当只留一个暂存目录，实得 ${fresh.length} 个`);
  return join(tmpdir(), fresh[0]);
}

const FAKE_MARK = "enc:";
const fakeProtect = async (plaintext) => Buffer.from(FAKE_MARK + Buffer.from(plaintext).toString("utf8"), "utf8");
const fakeUnprotect = async (ciphertext) => Buffer.from(String(ciphertext).replace(FAKE_MARK, ""), "utf8");

function validStore(id = "alpha") {
  return {
    version: 2,
    providers: {
      [id]: {
        displayName: "Alpha",
        baseURL: "https://alpha.example/v1",
        protocol: "openai-compatible",
        credentialFile: `${id}.dpapi`,
        models: { "model-one": { displayName: "Model One" } },
      },
    },
    pools: {},
    routingChains: {},
  };
}

// 造一台"待迁移的机器"：渠道、relay 设置、预设、Skills 主仓库、两份密钥。
function fakeMachine({ store = validStore(), settings = true, prompts = true, skills = 2, withCredential = true } = {}) {
  const localAppData = mkTestDir("anyswitch-bundle-machine-");
  const base = { LOCALAPPDATA: localAppData };
  const root = join(localAppData, "Anyswitch");
  const paths = storePaths(root);
  ensureLayout(paths);
  if (store) writeStore(store, { paths });
  if (settings) writeFileSync(join(root, "settings.json"), JSON.stringify(typeof settings === "object" ? settings : { followAgent: true }) + "\n", "utf8");
  if (prompts) writeFileSync(join(root, "prompts.json"), JSON.stringify({ presets: [{ id: "p1", content: "x" }, { id: "p2", content: "y" }] }) + "\n", "utf8");
  const repoPath = join(root, "skill-repo");
  if (skills > 0) {
    for (let i = 1; i <= skills; i += 1) {
      mkdirSync(join(repoPath, `skill-${i}`, "references"), { recursive: true });
      writeFileSync(join(repoPath, `skill-${i}`, "SKILL.md"), `# skill ${i}\n`, "utf8");
      writeFileSync(join(repoPath, `skill-${i}`, "references", "a.txt"), "deep\n", "utf8");
    }
  }
  writeFileSync(join(root, "skills.json"), JSON.stringify({ repoPath }) + "\n", "utf8");
  if (withCredential) {
    for (const id of Object.keys(store?.providers ?? {})) {
      writeFileSync(join(paths.credentialsDir, `${id}.dpapi`), Buffer.from(FAKE_MARK + "sk-secret-" + id, "utf8"));
    }
  }
  const targetDir = mkTestDir("anyswitch-bundle-target-");
  const service = () => createDataBundleService({ base, protect: fakeProtect, unprotect: fakeUnprotect });
  return { base, root, paths, repoPath, targetDir, service };
}

const listZip = async (zipPath) => {
  const { spawn } = await import("node:child_process");
  return await new Promise((res, rej) => {
    let out = "";
    const child = spawn("C:\\Windows\\System32\\tar.exe", ["-tf", zipPath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c) => (out += c));
    child.on("error", rej);
    child.on("close", (code) => (code === 0 ? res(out.split(/\r?\n/)) : rej(new Error("tar list failed"))));
  });
};

test("导出包内含全部人写的配置、skills 目录树与凭据", async () => {
  const m = fakeMachine();
  const result = await m.service().exportBundle({ targetDir: m.targetDir });
  assert.equal(result.ok, true, result.error);
  assert.match(result.path, /anyswitch-export-\d{8}-\d{6}\.zip$/);
  assert.equal(existsSync(result.path), true);
  assert.deepEqual(result.counts, {
    providers: 1, pools: 0, routingChains: 0, presets: 2, skillDirs: 2, credentials: 1, credentialsSkipped: 0,
  });
  const entries = (await listZip(result.path)).map((e) => e.replace(/^\.\//, ""));
  for (const want of ["manifest.json", "store.json", "settings.json", "prompts.json", "credentials.json", "skills/skill-1/SKILL.md", "skills/skill-1/references/a.txt"]) {
    assert.ok(entries.includes(want), `包里应含 ${want}，实得 ${entries.join(",")}`);
  }
});

test("导出文件名带时间戳且可预测", () => {
  assert.equal(exportFileName(new Date(2026, 8, 23, 7, 5, 3)), "anyswitch-export-20260923-070503.zip");
});

test("缺 settings / prompts / skills 时按实际有无入包", async () => {
  const m = fakeMachine({ settings: false, prompts: false, skills: 0 });
  const result = await m.service().exportBundle({ targetDir: m.targetDir });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.counts.presets, 0);
  assert.equal(result.counts.skillDirs, 0);
  const entries = (await listZip(result.path)).map((e) => e.replace(/^\.\//, ""));
  assert.ok(!entries.includes("settings.json"));
  assert.ok(!entries.includes("skills/skill-1/SKILL.md"));
});

test("解不开的密钥只记为跳过，不阻断导出", async () => {
  const m = fakeMachine();
  const service = createDataBundleService({
    base: m.base,
    protect: fakeProtect,
    unprotect: async () => { throw new Error("cannot decrypt"); },
  });
  const result = await service.exportBundle({ targetDir: m.targetDir });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.counts.credentials, 0);
  assert.equal(result.counts.credentialsSkipped, 1);
  assert.equal(result.skippedCredentials[0].providerId, "alpha");
});

test("拒绝把含明文密钥的包导进应用安装目录", async () => {
  const m = fakeMachine();
  const service = m.service();
  const insideApp = await service.exportBundle({ targetDir: m.paths.appDir });
  assert.equal(insideApp.ok, false);
  assert.match(insideApp.error, /安装目录/);
  const bogus = await service.exportBundle({ targetDir: join(m.root, "nope") });
  assert.equal(bogus.ok, false);
  assert.match(bogus.error, /导出目录不存在/);
});

test("当前 store 读不出来时不导出空包", async () => {
  const m = fakeMachine({ store: null });
  const result = await m.service().exportBundle({ targetDir: m.targetDir });
  assert.equal(result.ok, false);
  assert.match(result.error, /渠道配置读不出来/);
});

test("预览给出摘要、含明文密钥标记与来源主机", async () => {
  const m = fakeMachine();
  const service = m.service();
  const exp = await service.exportBundle({ targetDir: m.targetDir });
  const before = importStagingDirs();
  const preview = await service.previewBundle(exp.path);
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.counts.providers, 1);
  assert.equal(preview.counts.presets, 2);
  assert.equal(preview.counts.skillDirs, 2);
  assert.equal(preview.hasPlaintextKeys, true);
  assert.equal(preview.includes.settings, true);
  assert.equal(typeof preview.token, "string");
  assert.ok(preview.skillsSourcePath.endsWith("skill-repo"));

  // 用户看完摘要就走：暂存必须能被一次退出清理收走，测试也不往 %TEMP% 丢东西。
  const stale = importStagingDirs().filter((n) => !before.includes(n));
  service.dropAllTickets();
  assert.equal(stale.length, 1, "预览留下一个暂存目录");
  assert.equal(existsSync(join(tmpdir(), stale[0])), false);
});

test("预览拒绝：非 zip、缺 manifest、格式版本不符、store 非法", async () => {
  const m = fakeMachine();
  const service = m.service();
  assert.equal((await service.previewBundle(join(m.root, "notes.txt"))).ok, false);

  const bad = mkTestDir("anyswitch-bundle-bad-");
  let badSeq = 0;
  const writeBadZip = (files) => {
    badSeq += 1;
    const staging = join(bad, `s${badSeq}`);
    mkdirSync(staging, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      const target = join(staging, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body, "utf8");
    }
    return { staging, zip: join(bad, `z${badSeq}.zip`) };
  };
  // 用同一套 tar 现造几个坏包
  const { spawn } = await import("node:child_process");
  const pack = (staging, zip) => new Promise((res, rej) => {
    const c = spawn("C:\\Windows\\System32\\tar.exe", ["--format=zip", "-cf", zip, "-C", staging, "."], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    c.on("error", rej); c.on("close", (code) => (code === 0 ? res(zip) : rej(new Error("pack failed"))));
  });

  const noManifest = writeBadZip({ "store.json": JSON.stringify(validStore()) });
  await pack(noManifest.staging, noManifest.zip);
  assert.match((await service.previewBundle(noManifest.zip)).error, /manifest\.json/);

  const wrongFormat = writeBadZip({ "manifest.json": JSON.stringify({ format: 99 }), "store.json": JSON.stringify(validStore()) });
  await pack(wrongFormat.staging, wrongFormat.zip);
  assert.match((await service.previewBundle(wrongFormat.zip)).error, /包格式版本/);

  const badStore = writeBadZip({ "manifest.json": JSON.stringify({ format: 1 }), "store.json": JSON.stringify({ version: 2, providers: { alpha: { displayName: "A" } } }) });
  await pack(badStore.staging, badStore.zip);
  assert.match((await service.previewBundle(badStore.zip)).error, /不合法|provider/);

  const staleVersion = writeBadZip({ "manifest.json": JSON.stringify({ format: 1 }), "store.json": JSON.stringify({ ...validStore(), version: 1 }) });
  await pack(staleVersion.staging, staleVersion.zip);
  const stale = await service.previewBundle(staleVersion.zip);
  assert.equal(stale.ok, false);
  assert.match(stale.error, /不合法/);
  rmSync(bad, { recursive: true, force: true });
});

test("落定：整体覆盖、先备份、凭据重新加密、skills 位置回写", async () => {
  const src = fakeMachine();
  const exporter = src.service();
  const exp = await exporter.exportBundle({ targetDir: src.targetDir });

  // 目标机：另起一台机器根，先自带一个会被覆盖掉的渠道，再导入。
  const dst = fakeMachine({ store: validStore("beta"), skills: 0 });
  const importer = dst.service();
  const preview = await importer.previewBundle(exp.path);
  assert.equal(preview.ok, true, preview.error);
  const applied = await importer.applyBundle({ token: preview.token });
  assert.equal(applied.ok, true, applied.error);

  const imported = JSON.parse(readFileSync(dst.paths.storeFile, "utf8"));
  assert.deepEqual(Object.keys(imported.providers), ["alpha"], "导入应整体覆盖目标机已有渠道");
  assert.equal(applied.applied.settings, true);
  assert.equal(applied.applied.followAgent, true, "刚写进盘的 followAgent 值要交回调用方，由它对齐登录计划与自愈进程");
  assert.equal(applied.applied.prompts, true);
  assert.equal(applied.applied.credentials, 1);
  assert.equal(applied.applied.skills, true);
  assert.deepEqual(JSON.parse(readFileSync(join(dst.root, "settings.json"), "utf8")), { followAgent: true });
  assert.equal(readFileSync(join(dst.paths.credentialsDir, "alpha.dpapi"), "utf8").startsWith(FAKE_MARK), true, "落盘密钥必须重新加密，不存明文");
  const skillsCfg = JSON.parse(readFileSync(join(dst.root, "skills.json"), "utf8"));
  assert.equal(skillsCfg.repoPath, applied.applied.skillsTarget);
  assert.equal(existsSync(join(skillsCfg.repoPath, "skill-1", "references", "a.txt")), true, "嵌套 skill 文件要原样落回");

  // 备份：旧 store 与旧凭据都在，且能读回被覆盖掉的那一笔。
  assert.match(applied.backupId, /^\d{8}-\d{6}$/);
  const backupDir = join(dst.root, "backups", `pre-import-${applied.backupId}`);
  const backed = JSON.parse(readFileSync(join(backupDir, "store.json"), "utf8"));
  assert.deepEqual(Object.keys(backed.providers), ["beta"]);
  assert.equal(existsSync(join(backupDir, "credentials", "beta.dpapi")), true);
  assert.ok(JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8")).saved.includes("store.json"));
});

test("包内 settings 没提 followAgent 时按关交回，与 loadSettings 的读法一致", async () => {
  const src = fakeMachine({ settings: { sparkWindowPoints: 60 } });
  const exp = await src.service().exportBundle({ targetDir: src.targetDir });
  const dst = fakeMachine({ store: validStore("beta"), settings: { followAgent: true }, skills: 0 });
  const importer = dst.service();
  const preview = await importer.previewBundle(exp.path);
  const applied = await importer.applyBundle({ token: preview.token });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.applied.followAgent, false, "导入后盘上没有这个开关，等于是关");
  assert.deepEqual(JSON.parse(readFileSync(join(dst.root, "settings.json"), "utf8")), { sparkWindowPoints: 60 });
});

test("换机往返：导出 → 清空 → 导入，数据回到原样且密钥能解回", async () => {
  const src = fakeMachine();
  const exp = await src.service().exportBundle({ targetDir: src.targetDir });
  const before = readFileSync(src.paths.storeFile, "utf8");
  rmSync(src.paths.storeFile, { force: true });
  rmSync(join(src.root, "prompts.json"), { force: true });
  rmSync(join(src.paths.credentialsDir, "alpha.dpapi"), { force: true });

  const service = src.service();
  const preview = await service.previewBundle(exp.path);
  const applied = await service.applyBundle({ token: preview.token });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(readFileSync(src.paths.storeFile, "utf8"), before, "store.json 应逐字节回到导入前");
  assert.equal(existsSync(join(src.root, "prompts.json")), true);
  const plain = await fakeUnprotect(readFileSync(join(src.paths.credentialsDir, "alpha.dpapi"), "utf8"));
  assert.equal(plain.toString(), "sk-secret-alpha");
});

test("落定拒绝复用票据与无效票据", async () => {
  const src = fakeMachine();
  const service = src.service();
  const exp = await src.service().exportBundle({ targetDir: src.targetDir });
  const preview = await service.previewBundle(exp.path);
  assert.equal((await service.applyBundle({ token: "nope" })).ok, false);
  assert.equal((await service.applyBundle({ token: preview.token })).ok, true);
  const second = await service.applyBundle({ token: preview.token });
  assert.equal(second.ok, false);
  assert.match(second.error, /过期|无效/);
});

test("目标机上包内 skills 有内容但没位置时跳过 skills，其余照落", async () => {
  const src = fakeMachine();
  const exp = await src.service().exportBundle({ targetDir: src.targetDir });
  const dst = fakeMachine({ store: validStore("beta"), skills: 0 });
  writeFileSync(join(dst.root, "skills.json"), "{}\n", "utf8");
  const importer = dst.service();
  const preview = await importer.previewBundle(exp.path);
  const applied = await importer.applyBundle({ token: preview.token, skillsRepoPath: "" });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.applied.skills, true, "包内记了来源路径时按该路径落盘");
});

test("Skills 仓库的 .git 不进包、不计数、也不回拷", async () => {
  const m = fakeMachine();
  // agent-home/skills 本身就是 git 仓库：只读对象文件会在回拷时撞 Access denied。
  mkdirSync(join(m.repoPath, ".git", "objects"), { recursive: true });
  writeFileSync(join(m.repoPath, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  writeFileSync(join(m.repoPath, ".git", "objects", "loose"), "git-object-bytes\n", "utf8");
  mkdirSync(join(m.repoPath, "skill-1", ".git"), { recursive: true });
  writeFileSync(join(m.repoPath, "skill-1", ".git", "nested"), "submodule pointer\n", "utf8");

  const exp = await m.service().exportBundle({ targetDir: m.targetDir });
  assert.equal(exp.ok, true, exp.error);
  assert.equal(exp.counts.skillDirs, 2, "计数不把 .git 当 skill");
  const entries = (await listZip(exp.path)).map((e) => e.replace(/^\.\//, ""));
  assert.ok(!entries.some((e) => e.split("/").includes(".git")), `包内不该有 .git：${entries.filter((e) => e.includes(".git")).join(",")}`);

  const dst = fakeMachine({ store: validStore("beta"), skills: 0 });
  const importer = dst.service();
  const preview = await importer.previewBundle(exp.path);
  assert.equal(preview.counts.skillDirs, 2);
  // 显式给一个全新落点：缺省时按包内记的来源路径落，那在源机上本就带着 .git。
  const freshTarget = join(dst.root, "restored-skills");
  const applied = await importer.applyBundle({ token: preview.token, skillsRepoPath: freshTarget });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.applied.skillsTarget, freshTarget);
  assert.equal(existsSync(join(freshTarget, ".git")), false, "落点不该出现 .git");
  assert.equal(existsSync(join(freshTarget, "skill-1", ".git")), false, "嵌套 .git 也要跳过");
  assert.equal(existsSync(join(freshTarget, "skill-2", "SKILL.md")), true, "正常内容照常落回");
});

test("不安全压缩包条目在解包前就被拒", () => {
  assert.equal(assertSafeEntries(["./store.json", "./skills/a/SKILL.md"]).ok, true);
  for (const evil of ["../evil.txt", "./../evil.txt", "C:/Windows/x.txt", "\\\\server\\share\\x", "skills/../../evil"]) {
    const r = assertSafeEntries([evil]);
    assert.equal(r.ok, false, `${evil} 应被拒`);
  }
});

test("预览：明文密钥读出后立刻从暂存里摘掉，落定仍按票据内存重新加密写回", async () => {
  const src = fakeMachine();
  const exp = await src.service().exportBundle({ targetDir: src.targetDir });
  const dst = fakeMachine({ store: validStore("beta"), skills: 0 });
  const importer = dst.service();
  const before = importStagingDirs();
  const preview = await importer.previewBundle(exp.path);
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.counts.credentials, 1, "摘要里的密钥计数按包内实数报");

  const staging = newStagingDir(before);
  assert.equal(existsSync(join(staging, CREDENTIALS_NAME)), false, "明文密钥不该留在 %TEMP% 里");
  assert.equal(existsSync(join(staging, "store.json")), true, "不含密钥的部分留着给落定用");

  const applied = await importer.applyBundle({ token: preview.token });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.applied.credentials, 1, "落定取票据内存里那份，盘上删了也不影响");
  assert.equal(readFileSync(join(dst.paths.credentialsDir, "alpha.dpapi"), "utf8").startsWith(FAKE_MARK), true);
  assert.equal(existsSync(staging), false, "落定完暂存目录整个收走");
});

test("弃用的预览：过期后由下一次预览扫掉，旧票据同时失效", async () => {
  const src = fakeMachine();
  const exp = await src.service().exportBundle({ targetDir: src.targetDir });
  const dst = fakeMachine({ store: validStore("beta"), skills: 0 });
  let clock = 1_700_000_000_000;
  const svc = createDataBundleService({ base: dst.base, protect: fakeProtect, unprotect: fakeUnprotect, now: () => clock });

  const before = importStagingDirs();
  const first = await svc.previewBundle(exp.path);
  const abandoned = newStagingDir(before);

  clock += TICKET_TTL_MS + 1;
  const second = await svc.previewBundle(exp.path);
  assert.equal(second.ok, true, second.error);
  assert.equal(existsSync(abandoned), false, "过期暂存该被顺带扫掉，而不是等到有人拿同一张票再来");
  assert.equal(first.token === second.token, false);
  // 扫掉旧的之后，相对第一次之前只多出第二次这一个目录。
  const secondStaging = newStagingDir(before);

  const stale = await svc.applyBundle({ token: first.token });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /过期|无效/);
  rmSync(secondStaging, { recursive: true, force: true });
});

test("退出清理：dropAllTickets 把在用的暂存与内存副本一起丢", async () => {
  const src = fakeMachine();
  const exp = await src.service().exportBundle({ targetDir: src.targetDir });
  const dst = fakeMachine({ store: validStore("beta"), skills: 0 });
  const svc = dst.service();
  const before = importStagingDirs();
  const preview = await svc.previewBundle(exp.path);
  const staging = newStagingDir(before);
  svc.dropAllTickets();
  assert.equal(existsSync(staging), false, "面板宿主退出时不该把解开的包留在 %TEMP%");
  const late = await svc.applyBundle({ token: preview.token });
  assert.equal(late.ok, false, "清完再拿票据来落定要被拒");
});

test("上次进程留下的过期暂存会在建服务时扫掉，正在用的动不到", () => {
  const staleDir = join(tmpdir(), "anyswitch-import-stalecase");
  const freshDir = join(tmpdir(), "anyswitch-import-freshcase");
  for (const d of [staleDir, freshDir]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "store.json"), "{}", "utf8");
  }
  const past = new Date(Date.now() - TICKET_TTL_MS - 60_000);
  utimesSync(staleDir, past, past);
  createDataBundleService({ base: fakeMachine().base });
  assert.equal(existsSync(staleDir), false, "超过有效期的孤儿目录该收走");
  assert.equal(existsSync(freshDir), true, "mtime 还新的是别人正在用的，不能动");
  rmSync(freshDir, { recursive: true, force: true });
});
