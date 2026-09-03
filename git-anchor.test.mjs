import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  defaultAnchorDir,
  ensureGitAnchor,
  logGitAnchorResult,
} from "./git-anchor.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "git-anchor-"));
}

test("defaultAnchorDir is LocalAppData/ApiCred-git/objects, not under ApiCred", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" };
  assert.equal(defaultAnchorDir(env), join("C:\\Users\\x\\AppData\\Local", "ApiCred-git", "objects"));
  assert.equal(defaultAnchorDir(env).includes("\\ApiCred\\"), false);
});

test("restores a missing gitfile when the object store still exists", () => {
  const root = scratch();
  const appDir = join(root, "app");
  const anchorDir = join(root, "objects");
  mkdirSync(appDir, { recursive: true });
  mkdirSync(anchorDir);
  writeFileSync(join(anchorDir, "HEAD"), "ref: refs/heads/master\n");
  const result = ensureGitAnchor(appDir, { anchorDir, env: { APICRED_GIT_ANCHOR: "1" } });
  assert.equal(result.ok, true);
  assert.equal(result.action, "restored");
  assert.match(readFileSync(join(appDir, ".git"), "utf8"), /^gitdir: /);
  rmSync(root, { recursive: true, force: true });
});

test("discards a nested .git directory when the real store already exists", () => {
  const root = scratch();
  const appDir = join(root, "app");
  const anchorDir = join(root, "objects");
  mkdirSync(join(appDir, ".git"), { recursive: true });
  writeFileSync(join(appDir, ".git", "HEAD"), "ref: refs/heads/junk\n");
  mkdirSync(anchorDir);
  writeFileSync(join(anchorDir, "HEAD"), "ref: refs/heads/master\n");
  const result = ensureGitAnchor(appDir, { anchorDir, env: { APICRED_GIT_ANCHOR: "1" } });
  assert.equal(result.ok, true);
  assert.equal(result.action, "discarded-nested");
  assert.equal(readFileSync(join(appDir, ".git"), "utf8"), `gitdir: ${anchorDir}\n`);
  assert.equal(readFileSync(join(anchorDir, "HEAD"), "utf8"), "ref: refs/heads/master\n");
  rmSync(root, { recursive: true, force: true });
});

test("does not promote a nested empty repo when the object store is missing", () => {
  const root = scratch();
  const appDir = join(root, "app");
  const anchorDir = join(root, "objects");
  mkdirSync(join(appDir, ".git"), { recursive: true });
  writeFileSync(join(appDir, ".git", "HEAD"), "ref: refs/heads/junk\n");
  const result = ensureGitAnchor(appDir, { anchorDir, env: { APICRED_GIT_ANCHOR: "1" } });
  assert.equal(result.ok, false);
  assert.equal(result.action, "missing-anchor");
  assert.equal(existsSync(anchorDir), false);
  assert.equal(readFileSync(join(appDir, ".git", "HEAD"), "utf8"), "ref: refs/heads/junk\n");
  rmSync(root, { recursive: true, force: true });
});

test("missing-anchor is logged as error, not swallowed as info", () => {
  const lines = [];
  const logger = {
    info: (m) => lines.push(["info", m]),
    error: (m) => lines.push(["error", m]),
  };
  logGitAnchorResult(logger, { ok: false, action: "missing-anchor", anchorDir: "X" });
  assert.deepEqual(lines, [["error", "git anchor missing-anchor: X"]]);
});

test("no-op by default: without APICRED_GIT_ANCHOR=1 nothing is touched or logged", () => {
  const root = scratch();
  const appDir = join(root, "app");
  const anchorDir = join(root, "objects");
  // Worst-case setup: a nested .git dir whose discard branch would fire if
  // the gate were bypassed — it must be left alone.
  mkdirSync(join(appDir, ".git"), { recursive: true });
  writeFileSync(join(appDir, ".git", "HEAD"), "ref: refs/heads/junk\n");
  mkdirSync(anchorDir);

  const result = ensureGitAnchor(appDir, { anchorDir, env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.action, "skipped");
  assert.equal(existsSync(join(appDir, ".git", "HEAD")), true);
  assert.equal(readFileSync(join(appDir, ".git", "HEAD"), "utf8"), "ref: refs/heads/junk\n");

  // "skipped" is quiet: neither error nor info.
  const lines = [];
  const logger = {
    info: (m) => lines.push(["info", m]),
    error: (m) => lines.push(["error", m]),
  };
  logGitAnchorResult(logger, result);
  assert.deepEqual(lines, []);
  rmSync(root, { recursive: true, force: true });
});
