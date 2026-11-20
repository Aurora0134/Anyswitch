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
  const asset = "anyswitch-v" + version + "-win-x64.zip";
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
