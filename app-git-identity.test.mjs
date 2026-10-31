import { test } from "node:test";
import assert from "node:assert/strict";
import { readLocalHead, readRemoteRefs } from "./app-git-identity.mjs";

const APP_DIR = "C:/app";
const REPO_URL = "https://github.com/Aurora0134/Anyswitch.git";

// execFile 形态的脚本化替身：按 args 前缀匹配应答，记录每一次调用。
function fakeSpawn(script) {
  const calls = [];
  const spawnFn = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const reply = script({ file, args, options }) ?? {};
    callback(reply.error ?? null, reply.stdout ?? "", reply.stderr ?? "");
    return { unref() {} };
  };
  return { spawnFn, calls };
}

const args0 = (...prefix) => (args) => prefix.every((arg, i) => args[i] === arg);
const MISSING = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });

test("readLocalHead：rev-parse 应答解析为完整 SHA 与 7 位短标识", async () => {
  const git = fakeSpawn(({ args }) => (args0("rev-parse", "HEAD")(args) ? { stdout: "0123456789abcdef0123456789abcdef01234567\n" } : { stdout: "" }));
  const head = await readLocalHead({ appDir: APP_DIR, spawnFn: git.spawnFn, env: {} });
  assert.deepEqual(head, { sha: "0123456789abcdef0123456789abcdef01234567", short: "0123456" });
  assert.equal(git.calls[0].options.cwd, APP_DIR);
});

test("readLocalHead：命令失败、空仓库、目录缺失都如实 null，不抛错", async () => {
  for (const stdout of ["", "\n", "not-a-sha\n"]) {
    const git = fakeSpawn(({ args }) => (args0("rev-parse", "HEAD")(args) ? { stdout } : { stdout: "" }));
    assert.equal(await readLocalHead({ appDir: APP_DIR, spawnFn: git.spawnFn, env: {} }), null, `stdout=${JSON.stringify(stdout)}`);
  }
  const failing = fakeSpawn(({ args }) => (args0("rev-parse", "HEAD")(args) ? { error: new Error("fatal: not a git repository") } : {}));
  assert.equal(await readLocalHead({ appDir: APP_DIR, spawnFn: failing.spawnFn, env: {} }), null);
  const unused = fakeSpawn(() => ({ error: MISSING }));
  assert.equal(await readLocalHead({ appDir: null, spawnFn: unused.spawnFn, env: {} }), null, "无 appDir 直接 null，一个命令都不发");
  assert.equal(unused.calls.length, 0);
});

test("readLocalHead：PATH 上没有 git 时换标准安装位，两处都没有才返回 null", async () => {
  const git = fakeSpawn(({ file }) => (String(file).endsWith("git.exe") ? { stdout: "0123456789abcdef0123456789abcdef01234567\n" } : { error: MISSING }));
  const head = await readLocalHead({ appDir: APP_DIR, spawnFn: git.spawnFn, env: {} });
  assert.equal(head?.short, "0123456", "第二个候选（标准安装位）应答即采用");
  const none = fakeSpawn(() => ({ error: MISSING }));
  assert.equal(await readLocalHead({ appDir: APP_DIR, spawnFn: none.spawnFn, env: {} }), null);
});

const LS_REMOTE_OUTPUT = [
  "0123456789abcdef0123456789abcdef01234567\tHEAD",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v0.6.5",
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/v0.6.5^{}",
  "cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v0.6.6",
  "0123456789abcdef0123456789abcdef01234567\trefs/heads/feature",
  "",
].join("\n");

test("readRemoteRefs：一次往返解析默认分支 HEAD 与 v-tag；附注 tag 的 peeled 行指向提交本体，优先采信", async () => {
  const git = fakeSpawn(({ args }) => (args0("ls-remote", REPO_URL, "HEAD", "refs/tags/v*")(args) ? { stdout: LS_REMOTE_OUTPUT } : { stdout: "" }));
  const remote = await readRemoteRefs({ repoUrl: REPO_URL, spawnFn: git.spawnFn, env: {} });
  assert.equal(remote.headSha, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(remote.tags.get("v0.6.5"), "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "附注 tag 取 peeled 的提交 SHA");
  assert.equal(remote.tags.get("v0.6.6"), "cccccccccccccccccccccccccccccccccccccccc", "轻量 tag 的 plain 行本身就是提交 SHA");
  assert.equal(remote.tags.size, 2, "非 v-tag 的 ref 不进 tag 表");
});

test("readRemoteRefs：远端默认分支叫 master 也能解析（回归：曾写死 main）", async () => {
  // 共享夹具 LS_REMOTE_OUTPUT 里混着一行 refs/heads/feature（远端另有分支的情形），
  // 解析必须忽略它；查询参数也不点名任何分支。结论只依赖 HEAD 与 tag，因此与默认分支
  // 叫什么无关——这里证明的是「不白问」，不是「远端没有 refs/heads/*」。
  const git = fakeSpawn(({ args }) => (args0("ls-remote")(args) ? { stdout: LS_REMOTE_OUTPUT } : { stdout: "" }));
  const remote = await readRemoteRefs({ repoUrl: REPO_URL, spawnFn: git.spawnFn, env: {} });
  assert.equal(remote?.headSha, "0123456789abcdef0123456789abcdef01234567", "不依赖 refs/heads/main 存在");
  assert.deepEqual(git.calls.at(-1).args.slice(0, 2), ["ls-remote", REPO_URL]);
  assert.equal(git.calls.at(-1).args.includes("refs/heads/main"), false, "查询里不再出现任何写死的分支名");
});

test("readRemoteRefs：没有 HEAD、命令失败、无 repoUrl 都返回 null", async () => {
  const noHead = fakeSpawn(({ args }) => (args0("ls-remote")(args) ? { stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v0.6.6\n" } : { stdout: "" }));
  assert.equal(await readRemoteRefs({ repoUrl: REPO_URL, spawnFn: noHead.spawnFn, env: {} }), null, "远端空仓（无 HEAD）");
  const failing = fakeSpawn(({ args }) => (args0("ls-remote")(args) ? { error: new Error("network down") } : {}));
  assert.equal(await readRemoteRefs({ repoUrl: REPO_URL, spawnFn: failing.spawnFn, env: {} }), null);
  const unused = fakeSpawn(() => ({ error: MISSING }));
  assert.equal(await readRemoteRefs({ repoUrl: null, spawnFn: unused.spawnFn, env: {} }), null, "无 repoUrl 直接 null，一个命令都不发");
  assert.equal(unused.calls.length, 0);
});
