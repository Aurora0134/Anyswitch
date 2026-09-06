// Keep the B-layer git object store outside the replaceable `app/` tree
// AND outside `%LOCALAPPDATA%\Anyswitch\` (a parent wipe of Anyswitch must
// miss the history). Hosts only rewrite the gitfile; they never move or
// delete the object store. ACL / migration lives in git-anchor-repair.mjs.

import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const GITFILE_PREFIX = "gitdir: ";

// Durable object store lives OUTSIDE the data dir, as a sibling named after the product.
export const ANCHOR_PARENT_NAME = "Anyswitch-git";
export const ANCHOR_DIR_NAME = "objects";
export const ANCHOR_SEAL_NAME = "objects.sealed";

export function defaultLocalAppData(env = process.env) {
  return env.LOCALAPPDATA ?? join(env.USERPROFILE ?? "", "AppData", "Local");
}

export function defaultAnchorParent(env = process.env) {
  return join(defaultLocalAppData(env), ANCHOR_PARENT_NAME);
}

export function defaultAnchorDir(env = process.env) {
  return join(defaultAnchorParent(env), ANCHOR_DIR_NAME);
}

export function defaultSealedDir(env = process.env) {
  return join(defaultAnchorParent(env), ANCHOR_SEAL_NAME);
}

/** Previous sibling location — repair script migrates this; hosts do not. */
export function legacyAnchorDir(env = process.env) {
  return join(defaultLocalAppData(env), "ApiCred", "app.git");
}

function isDirectory(p) {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readGitfileTarget(gitPath) {
  try {
    const text = readFileSync(gitPath, "utf8").trim();
    if (!text.startsWith(GITFILE_PREFIX)) return null;
    return text.slice(GITFILE_PREFIX.length).trim();
  } catch {
    return null;
  }
}

export function writeGitfile(gitPath, anchorDir) {
  writeFileSync(gitPath, `${GITFILE_PREFIX}${anchorDir}\n`, "utf8");
}

/**
 * Ensure `app/.git` is a gitfile to the durable object store.
 * Never moves/creates the object store. Returns { ok, action, anchorDir }.
 *
 * Opt-in: open-source clones have no durable object store, so this is pure
 * noise (a scary missing-anchor error) on every start. Unless
 * ANYSWITCH_GIT_ANCHOR=1 is set in the environment, this returns a quiet
 * no-op ("skipped"). With the flag set, behavior is exactly as before.
 */
export function ensureGitAnchor(appDir, options = {}) {
  const env = options.env ?? process.env;
  const anchorDir = options.anchorDir ?? defaultAnchorDir(env);
  if (env.ANYSWITCH_GIT_ANCHOR !== "1") {
    return { ok: true, action: "skipped", anchorDir };
  }
  const gitPath = join(appDir, ".git");
  try {
    if (isDirectory(gitPath)) {
      if (existsSync(anchorDir)) {
        rmSync(gitPath, { recursive: true, force: true });
        writeGitfile(gitPath, anchorDir);
        return { ok: true, action: "discarded-nested", anchorDir };
      }
      return { ok: false, action: "missing-anchor", anchorDir };
    }
    const pointed = readGitfileTarget(gitPath);
    if (pointed && resolve(pointed) === resolve(anchorDir) && existsSync(anchorDir)) {
      return { ok: true, action: "ok", anchorDir };
    }
    if (existsSync(anchorDir)) {
      writeGitfile(gitPath, anchorDir);
      return { ok: true, action: pointed ? "rewrote" : "restored", anchorDir };
    }
    return { ok: false, action: "missing-anchor", anchorDir };
  } catch (err) {
    return { ok: false, action: "error", anchorDir, error: err.message };
  }
}

export function logGitAnchorResult(logger, result) {
  if (!logger) return;
  if (!result?.ok) {
    logger.error(`git anchor ${result?.action ?? "unknown"}: ${result?.anchorDir ?? ""}${result?.error ? ` (${result.error})` : ""}`);
    return;
  }
  if (result.action !== "ok" && result.action !== "skipped") {
    logger.info(`git anchor ${result.action}: ${result.anchorDir}`);
  }
}
