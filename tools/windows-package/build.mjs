import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseVersion } from "../../src/ops/version-check.mjs";
import { desktopReleaseArchiveName } from "../../src/ops/update-trust.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const APP_ENTRIES = ["panel-host.mjs", "panel-host-restart-helper.mjs", "relay-host.mjs"];
const TOOLS = dirname(fileURLToPath(import.meta.url));
const NODE_VERSION = "22.15.0";
const REQUIRED_FILES = ["dpapi.ps1", "codex-model-catalog-template.json", "thinking-efforts-baseline.json", "package.json", "panel-app.vbs", "silent-start.vbs", "anyswitch.ico", "LICENSE", "docs/assets/logo.png"];
const UPDATE_KEY_MARKER = "__ANYSWITCH_UPDATE_PUBLIC_KEY__";
const PKCS8_ED25519_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function versionFromTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v") || !parseVersion(tag.slice(1))) throw new Error("Release tag must be v<SemVer>");
  return tag.slice(1);
}

export function releaseChannel(version) {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error("Invalid release version");
  return parsed.prerelease.length ? "preview" : "stable";
}

export function manifestBytes({ version, channel, asset, sha256, size }) {
  const expectedChannel = releaseChannel(version);
  if (channel !== expectedChannel) throw new Error("Release channel does not match SemVer prerelease state");
  const expectedAsset = desktopReleaseArchiveName(version);
  if (asset !== expectedAsset) throw new Error("Archive name does not match version");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid SHA-256 digest");
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("Invalid archive size");
  return Buffer.from(JSON.stringify({ schema: 1, version, channel, platform: "win-x64", asset, sha256, size }), "utf8");
}

function privateKeyFromSeed(encoded) {
  if (!encoded) throw new Error("ANYSWITCH_UPDATE_SIGNING_KEY is required");
  let seed;
  try { seed = Buffer.from(encoded, "base64"); } catch { throw new Error("ANYSWITCH_UPDATE_SIGNING_KEY must be base64 raw 32-byte seed"); }
  if (seed.length !== 32 || seed.toString("base64") !== encoded.trim()) throw new Error("ANYSWITCH_UPDATE_SIGNING_KEY must be base64 raw 32-byte seed");
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_SEED_PREFIX, seed]), format: "der", type: "pkcs8" });
}

export function signManifest(bytes, encodedSeed) {
  const privateKey = privateKeyFromSeed(encodedSeed);
  const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return {
    signature: sign(null, bytes, privateKey).toString("base64"),
    publicKey: Buffer.from(publicDer).subarray(-32).toString("base64"),
  };
}

async function compileFiles(source, destination, { target, format, publicKey }) {
  const esbuild = await import("esbuild");
  const input = await readFile(source, "utf8");
  const code = publicKey === undefined ? input : injectUpdateKey(input, publicKey);
  const transformed = await esbuild.transform(code, {
    sourcefile: basename(source), loader: "js", format, target,
    minify: true, legalComments: "none",
  });
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, transformed.code, "utf8");
}

export function injectUpdateKey(source, publicKey) {
  if (source.split(UPDATE_KEY_MARKER).length !== 2) throw new Error("Expected one update trust key marker in src/ops/update-trust.mjs");
  return source.replace(UPDATE_KEY_MARKER, publicKey);
}

export async function stageTree(source, destination, compileOptions) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const input = join(source, entry.name);
    const output = join(destination, entry.name);
    if (entry.isDirectory()) await stageTree(input, output, compileOptions);
    else if (!entry.isFile()) throw new Error("Unexpected link in application tree: " + input);
    else if (entry.name.endsWith(compileOptions.extension)) {
      const publicKey = input === compileOptions.trustPath ? compileOptions.publicKey : undefined;
      await compileFiles(input, output, { ...compileOptions, publicKey });
    } else if (!entry.name.endsWith(".md")) {
      await mkdir(dirname(output), { recursive: true });
      await cp(input, output);
    }
  }
}

export async function stageApp({ root, appDir, version, publicKey }) {
  const trustPath = join(root, "src", "ops", "update-trust.mjs");
  await stat(trustPath);
  await mkdir(appDir, { recursive: true });
  for (const entry of APP_ENTRIES) await compileFiles(join(root, entry), join(appDir, entry), { target: "node22", format: "esm" });
  await stageTree(join(root, "src"), join(appDir, "src"), { target: "node22", format: "esm", extension: ".mjs", trustPath, publicKey });
  await stageTree(join(root, "panel-ui"), join(appDir, "panel-ui"), { target: "es2022", extension: ".js" });
  for (const file of REQUIRED_FILES) {
    await mkdir(dirname(join(appDir, file)), { recursive: true });
    await cp(join(root, file), join(appDir, file));
  }
  await cp(join(root, "test-helpers", "vendor", "js-yaml"), join(appDir, "test-helpers", "vendor", "js-yaml"), { recursive: true });
  await cp(join(root, "node_modules"), join(appDir, "node_modules"), { recursive: true });
  for (const file of ["package-health.mjs", "package-dispatch.mjs"]) await compileFiles(join(TOOLS, file), join(appDir, file), { target: "node22", format: "esm" });
  const packageJson = JSON.parse(await readFile(join(appDir, "package.json"), "utf8"));
  await writeFile(join(appDir, "package.json"), JSON.stringify({ ...packageJson, version }) + "\n", "utf8");
}

function run(file, args, cwd, overrides) {
  const { ANYSWITCH_UPDATE_SIGNING_KEY: _secret, NODE_OPTIONS: _nodeOptions, ...env } = process.env;
  const result = spawnSync(file, args, { cwd, env: { ...env, ...overrides }, encoding: "utf8", timeout: 120_000, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || file + " failed with exit " + result.status);
  return result.stdout;
}

export async function publishBuild(out, build) {
  const target = resolve(out);
  await mkdir(dirname(target), { recursive: true });
  await stat(target).then(
    () => { throw new Error("Build output must not already exist: " + target); },
    (error) => { if (error.code !== "ENOENT") throw error; },
  );
  const work = await mkdtemp(join(dirname(target), ".anyswitch-build-"));
  try {
    const result = await build(work);
    await rename(work, target);
    return result;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function buildRelease({ tag, outputDir, nodeExe, signingSeed, desktopBuild, root = ROOT, desktopCopy = join(root, "installer", "windows", "desktop", "copy.json") }) {
  const version = versionFromTag(tag);
  const channel = releaseChannel(version);
  const key = privateKeyFromSeed(signingSeed);
  const publicKey = createPublicKey(key).export({ format: "jwk" }).x;
  const rawPublicKey = Buffer.from(publicKey, "base64url").toString("base64");
  if (process.platform !== "win32" || process.arch !== "x64" || process.versions.node !== NODE_VERSION) {
    throw new Error("Build using Windows x64 Node " + NODE_VERSION);
  }
  const runtime = resolve(nodeExe);
  const nodeInfo = run(runtime, ["-p", "process.platform + ':' + process.arch + ':' + process.versions.node"], root).trim();
  if (nodeInfo !== "win32:x64:" + NODE_VERSION) throw new Error("Incorrect bundled Node runtime: " + nodeInfo);
  const asset = desktopReleaseArchiveName(version);
  return publishBuild(outputDir, async (work) => {
    const staging = join(work, "staging");
    const runtimeDir = join(staging, "runtime");
    await mkdir(runtimeDir, { recursive: true });
    await cp(runtime, join(runtimeDir, "node.exe"));
    await cp(join(dirname(runtime), "LICENSE"), join(runtimeDir, "LICENSE"));
    await stageApp({ root: resolve(root), appDir: join(staging, "app"), version, publicKey: rawPublicKey });
    if (!desktopBuild) throw new Error("Compiled Windows desktop assets are required");
    await cp(join(desktopBuild, "desktop"), join(staging, "app", "desktop"), { recursive: true });
    const copy = JSON.parse(await readFile(desktopCopy, "utf8"));
    for (const key of ["open", "browser", "exit", "exitTitle", "exitBody"]) {
      if (typeof copy?.[key] !== "string" || !copy[key].trim()) throw new Error(`Missing desktop copy: ${key}`);
    }
    await cp(desktopCopy, join(staging, "app", "desktop", "copy.json"));
    await cp(join(desktopBuild, "Anyswitch.exe"), join(staging, "Anyswitch.exe"));
    const archivePath = join(work, asset);
    run("tar.exe", ["-a", "-cf", archivePath, "app", "runtime"], staging);
    // 提取目录用纯 ASCII 名：System32 的 bsdtar 按系统代码页解析参数，非中文区域
    // 机器上带中文的 -C 路径会被折成问号（本地 GBK 码页过、英文 runner 必挂）。
    // 提取完再 rename 进带中文与空格的冒烟目录——非 ASCII 安装根的健康检查照跑。
    const extract = join(work, "extract");
    await mkdir(extract);
    run("tar.exe", ["-xf", archivePath, "-C", "extract"], work);
    const smoke = join(work, "smoke 空间");
    await rename(extract, smoke);
    const roots = (await readdir(smoke)).sort();
    if (roots.join(",") !== "app,runtime") throw new Error("Unexpected release archive layout");
    // An installer launched by the previous version may inherit its app root.
    run(join(smoke, "runtime", "node.exe"), [join(smoke, "app", "package-health.mjs"), version], work, { ANYSWITCH_APP_ROOT: root });
    await rm(smoke, { recursive: true, force: true });
    const archive = await readFile(archivePath);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const bytes = manifestBytes({ version, channel, asset, sha256, size: archive.length });
    const stem = asset.slice(0, -4);
    await writeFile(join(work, stem + ".manifest.json"), bytes);
    await writeFile(join(work, stem + ".manifest.sig"), sign(null, bytes, key).toString("base64"), "ascii");
    return { version, channel, asset, sha256, size: archive.length, publicKey: rawPublicKey };
  });
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=")];
  }));
  if (!args.tag || !args.output || !args.nodeExe || !args.desktopBuild) throw new Error("Usage: build.mjs --tag=v1.2.3 --output=DIR --nodeExe=PATH --desktopBuild=DIR");
  const signingSeed = process.env.ANYSWITCH_UPDATE_SIGNING_KEY;
  delete process.env.ANYSWITCH_UPDATE_SIGNING_KEY;
  console.log(JSON.stringify(await buildRelease({ tag: args.tag, outputDir: args.output, nodeExe: args.nodeExe, signingSeed, desktopBuild: args.desktopBuild })));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
