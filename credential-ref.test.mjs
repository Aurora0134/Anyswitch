import assert from "node:assert/strict";
import test from "node:test";
import { validateCredentialRef } from "./credential-ref.mjs";

// credentialFile must be a Store-root-relative reference that
// cannot escape the store root. Absolute paths, drive letters, UNC paths,
// parent traversal and path separators are all rejected so that Phase 2 DPAPI
// reads can never be steered outside the credentials directory.

test("accepts a plain uuid credential filename", () => {
  const result = validateCredentialRef("credential-11111111-1111-1111-1111-111111111111.dpapi");
  assert.equal(result.valid, true);
});

test("rejects a non-string", () => {
  assert.equal(validateCredentialRef(null).valid, false);
  assert.equal(validateCredentialRef(undefined).valid, false);
  assert.equal(validateCredentialRef(42).valid, false);
});

test("rejects an empty string", () => {
  assert.equal(validateCredentialRef("").valid, false);
});

test("rejects parent traversal with backslash", () => {
  const result = validateCredentialRef("..\\secrets\\other.dpapi");
  assert.equal(result.valid, false);
  assert.equal(/escape|traversal|separator|relative/i.test(result.reason), true);
});

test("rejects parent traversal with forward slash", () => {
  const result = validateCredentialRef("../secrets/other.dpapi");
  assert.equal(result.valid, false);
});

test("rejects a bare .. segment", () => {
  assert.equal(validateCredentialRef("..").valid, false);
});

test("rejects an absolute drive path", () => {
  const result = validateCredentialRef("C:\\Users\\x\\cred.dpapi");
  assert.equal(result.valid, false);
  assert.equal(/absolute|drive|separator/i.test(result.reason), true);
});

test("rejects a drive-relative reference", () => {
  assert.equal(validateCredentialRef("C:cred.dpapi").valid, false);
});

test("rejects a UNC path", () => {
  const result = validateCredentialRef("\\\\server\\share\\cred.dpapi");
  assert.equal(result.valid, false);
});

test("rejects a leading backslash (root-relative)", () => {
  assert.equal(validateCredentialRef("\\cred.dpapi").valid, false);
});

test("rejects a leading forward slash", () => {
  assert.equal(validateCredentialRef("/cred.dpapi").valid, false);
});

test("rejects any embedded forward slash (no subdirectories)", () => {
  assert.equal(validateCredentialRef("sub/cred.dpapi").valid, false);
});

test("rejects any embedded backslash (no subdirectories)", () => {
  assert.equal(validateCredentialRef("sub\\cred.dpapi").valid, false);
});

test("rejects a NUL byte", () => {
  assert.equal(validateCredentialRef("cred\u0000.dpapi").valid, false);
});

test("rejects a current-directory prefix", () => {
  assert.equal(validateCredentialRef(".\\cred.dpapi").valid, false);
});

test("rejects a trailing dot or space (Windows name squashing)", () => {
  assert.equal(validateCredentialRef("cred.dpapi.").valid, false);
  assert.equal(validateCredentialRef("cred.dpapi ").valid, false);
});

test("rejects a reserved Windows device name", () => {
  assert.equal(validateCredentialRef("CON").valid, false);
  assert.equal(validateCredentialRef("nul.dpapi").valid, false);
});

test("accepts letters digits dot underscore hyphen", () => {
  assert.equal(validateCredentialRef("cred_ABC-123.9.dpapi").valid, true);
});
