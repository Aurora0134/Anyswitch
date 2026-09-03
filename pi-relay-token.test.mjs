import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getTokenPath, loadOrGenerateToken } from "./pi-relay-token.mjs";

describe("getTokenPath", () => {
  it("returns path under root", () => {
    const p = getTokenPath("C:\\root");
    assert.equal(p, "C:\\root\\pi-relay-token");
  });
});

describe("loadOrGenerateToken", () => {
  it("generates and persists a token when none exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-token-test-"));
    const token = loadOrGenerateToken(dir);
    assert.equal(typeof token, "string");
    assert.equal(token.length, 64);
    assert.ok(existsSync(join(dir, "pi-relay-token")));
    const read = readFileSync(join(dir, "pi-relay-token"), "utf8").trim();
    assert.equal(read, token);
  });

  it("returns the same token on subsequent calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-token-test-"));
    const first = loadOrGenerateToken(dir);
    const second = loadOrGenerateToken(dir);
    assert.equal(first, second);
  });

  it("creates a missing root directory before writing (first boot on empty data root)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-token-test-"));
    const root = join(dir, "empty-root");
    const token = loadOrGenerateToken(root);
    assert.equal(token.length, 64);
    assert.ok(existsSync(join(root, "pi-relay-token")));
    assert.equal(readFileSync(join(root, "pi-relay-token"), "utf8").trim(), token);
  });

  it("reads existing token file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-token-test-"));
    const path = join(dir, "pi-relay-token");
    writeFileSync(path, "my-persisted-token\n", "utf8");
    const token = loadOrGenerateToken(dir);
    assert.equal(token, "my-persisted-token");
  });
});