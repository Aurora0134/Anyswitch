#!/usr/bin/env node
// pre-push 守卫：本次推送引入（新增或修改）测试面文件即拒绝。
// 测试面 = 根级 tests/ 与 test-helpers/、任意位置的 *.test.* / *.spec.* 文件、
// fixtures / __tests__ / testdata 目录。删除与移出不算违规（撤下测试面本身合法）。
import { spawnSync } from "node:child_process";

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "git " + args.join(" ") + " failed");
  return result.stdout;
}

function isTestPath(path) {
  const segments = path.split("/");
  if (segments[0] === "tests" || segments[0] === "test-helpers") return true;
  if (segments.includes("fixtures") || segments.includes("__tests__") || segments.includes("testdata")) return true;
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path);
}

const ZERO = /^0+$/;
const stdin = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => resolve(data));
});

const violations = [];
try {
  for (const line of stdin.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const localSha = fields[1];
    const remoteSha = fields[3];
    if (ZERO.test(localSha)) continue;
    const range = ZERO.test(remoteSha)
      ? git(["rev-list", localSha, "--not", "--remotes"]).trim()
      : git(["rev-list", remoteSha + ".." + localSha]).trim();
    for (const commit of range ? range.split("\n") : []) {
      const changes = git(["diff-tree", "--no-commit-id", "--name-status", "-r", "--root", "-m", commit]);
      for (const row of changes.split("\n")) {
        const match = /^([AM])\t(.+)$/.exec(row);
        if (match && isTestPath(match[2])) violations.push(commit.slice(0, 12) + " " + match[1] + " " + match[2]);
      }
    }
  }
} catch (error) {
  console.error("pre-push 守卫无法核对推送内容：" + error.message);
  process.exit(1);
}

if (violations.length > 0) {
  console.error("拒绝推送：以下提交把测试面文件带入公开远端——");
  for (const item of violations) console.error("  " + item);
  console.error("测试用例、夹具与打包契约由本地私有仓 Anyswitch-tests 维护，不入本仓。");
  process.exit(1);
}
