import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const TOKEN_FILENAME = "pi-relay-token";

export function getTokenPath(root) {
  return join(root, TOKEN_FILENAME);
}

export function loadOrGenerateToken(root) {
  const path = getTokenPath(root);
  if (existsSync(path)) {
    return readFileSync(path, "utf8").trim();
  }
  const token = randomBytes(32).toString("hex");
  // First boot on an empty data root: the root directory may not exist yet,
  // so create it before writing (otherwise the relay dies on ENOENT before
  // its friendly preflight can run).
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, "utf8");
  return token;
}