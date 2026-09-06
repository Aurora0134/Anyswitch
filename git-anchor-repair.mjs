// One-shot / ops repair for the B-layer git object store.
// Hosts (panel-host / relay-host) must not import this for migration or ACL.
//
// Usage:
//   node git-anchor-repair.mjs
//   node git-anchor-repair.mjs --app <appDir>
//
// - Moves legacy `%LOCALAPPDATA%\ApiCred\app.git` → `%LOCALAPPDATA%\Anyswitch-git\objects`
// - Writes `app/.git` gitfile
// - Denies DELETE + DELETE-CHILD on the parent `Anyswitch-git` only (not inherited),
//   so `rm -rf` of the parent fails while git can still write inside objects/

import { existsSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  defaultAnchorDir,
  defaultAnchorParent,
  defaultSealedDir,
  ensureGitAnchor,
  legacyAnchorDir,
} from "./git-anchor.mjs";

function icacls(args) {
  return spawnSync("icacls", args, { encoding: "utf8", windowsHide: true });
}

function icaclsResult(r) {
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || `exit ${r.status}`).trim() };
  }
  return { ok: true };
}

/** This-folder-only: cannot delete the parent or its immediate children (the objects dir). */
export function icaclsDenyDeleteParent(parentDir) {
  const user = process.env.USERNAME;
  if (!user) return { ok: false, error: "USERNAME unset" };
  return icaclsResult(icacls([parentDir, "/deny", `${user}:(DE,DC)`]));
}

/** This-folder-only: cannot rmdir the live store; git must still delete temp files inside. */
export function icaclsDenyDeleteStore(storeDir) {
  const user = process.env.USERNAME;
  if (!user) return { ok: false, error: "USERNAME unset" };
  return icaclsResult(icacls([storeDir, "/deny", `${user}:(DE)`]));
}

/** Inherited: files under the sealed mirror cannot be deleted by a casual rm -rf. */
export function icaclsSealTree(dir) {
  const user = process.env.USERNAME;
  if (!user) return { ok: false, error: "USERNAME unset" };
  const r = icacls([dir, "/deny", `${user}:(DE,DC)`, "/T", "/C"]);
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || `exit ${r.status}`).trim() };
  }
  return { ok: true };
}

export function robocopyMirror(src, dest) {
  const r = spawnSync("robocopy", [src, dest, "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np"], {
    encoding: "utf8",
    windowsHide: true,
  });
  // robocopy 0-7 are success-ish; >=8 is failure
  if (r.status !== null && r.status >= 8) {
    return { ok: false, error: (r.stderr || r.stdout || `exit ${r.status}`).trim(), status: r.status };
  }
  return { ok: true, status: r.status };
}

export function unsealTree(dir) {
  const user = process.env.USERNAME;
  if (!user) return { ok: false, error: "USERNAME unset" };
  if (!existsSync(dir)) return { ok: true, action: "absent" };
  return icaclsResult(icacls([dir, "/remove:d", user, "/T", "/C"]));
}

export function refreshSealedCopy(env = process.env) {
  const src = defaultAnchorDir(env);
  const dest = defaultSealedDir(env);
  if (!existsSync(src)) return { ok: false, error: "no live store" };
  mkdirSync(defaultAnchorParent(env), { recursive: true });
  unsealTree(dest);
  if (existsSync(dest)) {
    try {
      rmSync(dest, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  const copied = robocopyMirror(src, dest);
  if (!copied.ok) return copied;
  const sealed = icaclsSealTree(dest);
  return { ok: sealed.ok, copied, sealed, dest };
}

export function icaclsClearDeny(dir) {
  const user = process.env.USERNAME;
  if (!user) return { ok: false, error: "USERNAME unset" };
  return icaclsResult(icacls([dir, "/remove:d", user]));
}

export function migrateLegacyAnchor(env = process.env) {
  const dest = defaultAnchorDir(env);
  const parent = defaultAnchorParent(env);
  const legacy = legacyAnchorDir(env);
  mkdirSync(parent, { recursive: true });
  if (existsSync(dest)) {
    return { ok: true, action: "dest-exists", dest };
  }
  if (existsSync(legacy)) {
    icaclsClearDeny(parent);
    renameSync(legacy, dest);
    return { ok: true, action: "migrated-legacy", dest };
  }
  return { ok: false, action: "missing-source", dest, legacy };
}

export function repairGitAnchor(appDir, env = process.env) {
  const migrated = migrateLegacyAnchor(env);
  const parent = defaultAnchorParent(env);
  const dest = defaultAnchorDir(env);
  const aclParent = existsSync(parent) ? icaclsDenyDeleteParent(parent) : { ok: false, error: "no parent" };
  const aclStore = existsSync(dest) ? icaclsDenyDeleteStore(dest) : { ok: false, error: "no store" };
  const sealed = existsSync(dest) ? refreshSealedCopy(env) : { ok: false, error: "no store" };
  const pointer = ensureGitAnchor(appDir, { env });
  return { migrated, aclParent, aclStore, sealed, pointer };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--app") out.app = argv[++i];
  }
  return out;
}

function isEntryModule(argv1, metaUrl) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  const norm = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  try {
    return norm(metaUrl) === norm(argv1);
  } catch {
    return false;
  }
}

const __filename = fileURLToPath(import.meta.url);
if (isEntryModule(process.argv[1], __filename)) {
  const args = parseArgs(process.argv.slice(2));
  const appDir = args.app ?? dirname(__filename);
  const result = repairGitAnchor(appDir);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.pointer?.ok) process.exit(1);
}
