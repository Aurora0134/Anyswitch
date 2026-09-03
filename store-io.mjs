// Global ApiCred store IO layer.
//
// Owns every filesystem path the relay touches. Two hard rules:
//   1. A credentialFile is resolved ONLY under the fixed credentials root, and
//      only after validateCredentialRef accepts it. A hostile or corrupt store
//      can never steer a read outside that root.
//   2. Loading never throws for expected conditions (absent, unreadable,
//      unparsable, schema-invalid). It classifies, so the caller fails closed
//      with a status code instead of a stack trace.
//
// store.json carries no secrets by contract; the ciphertext lives in
// separate per-provider files under credentials\.

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { validateStore } from "./store-schema.mjs";
import { validateCredentialRef } from "./credential-ref.mjs";
import { atomicWriteFile, casWriteFile, contentHash } from "./atomic-write.mjs";

export function defaultRoot() {
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error("LOCALAPPDATA is not set; cannot locate the ApiCred store");
  // legacy name "ApiCred" retained for compatibility after product rename to Anyswitch
  return join(local, "ApiCred");
}

export function storePaths(root = defaultRoot()) {
  return {
    root,
    storeFile: join(root, "store.json"),
    credentialsDir: join(root, "credentials"),
    appDir: join(root, "app"),
  };
}

export const LOAD_REASON = {
  ABSENT: "store-absent",
  UNREADABLE: "store-unreadable",
  UNPARSABLE: "store-unparsable",
  INVALID: "store-schema-invalid",
};

// Returns { ok:true, store, text, hash } or { ok:false, reason, errors }.
// `hash` lets a caller do a compare-and-swap write against exactly what it read.
export function loadStore(paths = storePaths()) {
  if (!existsSync(paths.storeFile)) {
    return { ok: false, reason: LOAD_REASON.ABSENT, errors: ["the global store does not exist"] };
  }
  let text;
  try {
    text = readFileSync(paths.storeFile, "utf8");
  } catch {
    return { ok: false, reason: LOAD_REASON.UNREADABLE, errors: ["the global store could not be read"] };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: LOAD_REASON.UNPARSABLE, errors: ["the global store is not valid JSON"] };
  }
  const result = validateStore(parsed);
  if (!result.valid) {
    return { ok: false, reason: LOAD_REASON.INVALID, errors: result.errors };
  }
  return { ok: true, store: parsed, text, hash: contentHash(text) };
}

// Resolve a credentialFile to an absolute path under the credentials root.
// Rejects anything validateCredentialRef refuses, so traversal, UNC, drive
// letters, reserved device names and separators never reach the filesystem.
export function resolveCredentialPath(credentialFile, paths = storePaths()) {
  const ref = validateCredentialRef(credentialFile);
  if (!ref.valid) return { ok: false, reason: ref.reason };
  return { ok: true, path: join(paths.credentialsDir, credentialFile) };
}

// Read one provider's ciphertext. Returns a Buffer; the caller is responsible
// for zeroing whatever the DPAPI layer produces from it.
export function readCiphertext(credentialFile, paths = storePaths()) {
  const resolved = resolveCredentialPath(credentialFile, paths);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  if (!existsSync(resolved.path)) return { ok: false, reason: "credential file is missing" };
  try {
    return { ok: true, ciphertext: readFileSync(resolved.path) };
  } catch {
    return { ok: false, reason: "credential file could not be read" };
  }
}

export function ensureLayout(paths = storePaths()) {
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.credentialsDir, { recursive: true });
  mkdirSync(paths.appDir, { recursive: true });
  return paths;
}

// Write a store after validating it. Refuses to persist an invalid store, so a
// bug upstream cannot leave an unusable file on disk.
// `expectedHash`: omit for last-writer-wins, null to require absence, or a hash
// from loadStore() to require that nothing changed since.
export function writeStore(store, { paths = storePaths(), expectedHash } = {}) {
  const result = validateStore(store);
  if (!result.valid) {
    return { ok: false, reason: "refusing to write a schema-invalid store", errors: result.errors };
  }
  const text = `${JSON.stringify(store, null, 2)}\n`;
  try {
    if (expectedHash === undefined) {
      atomicWriteFile(paths.storeFile, text);
    } else {
      casWriteFile(paths.storeFile, text, { expectedHash });
    }
  } catch (error) {
    return { ok: false, reason: error.name === "PreconditionFailedError" ? "store changed since it was read" : "store write failed", errors: [] };
  }
  return { ok: true, hash: contentHash(text) };
}

// ---------- legacy v1 (read-only) ----------
//
// The v1 store lives in the OpenCode-specific scope directory and is NEVER
// written here. It is read only to plan a migration. v1 entries carry
// just { credentialFile, baseURL }: no protocol, no displayName, no models.

export function v1Paths(scope) {
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error("LOCALAPPDATA is not set; cannot locate the legacy store");
  const root = join(local, "OpenCodeApiCred", "scopes", scope);
  return { root, storeFile: join(root, "store.json"), credentialsDir: root };
}

export function loadV1Store(scope) {
  const paths = v1Paths(scope);
  if (!existsSync(paths.storeFile)) {
    return { ok: false, reason: LOAD_REASON.ABSENT, paths };
  }
  try {
    const parsed = JSON.parse(readFileSync(paths.storeFile, "utf8"));
    if (parsed?.version !== 1 || parsed.providers === null || typeof parsed.providers !== "object") {
      return { ok: false, reason: LOAD_REASON.INVALID, paths };
    }
    return { ok: true, store: parsed, paths };
  } catch {
    return { ok: false, reason: LOAD_REASON.UNPARSABLE, paths };
  }
}
