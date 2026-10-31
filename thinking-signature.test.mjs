// Tests for the narration thinking signature constant.
//
// The constant is the whole feature, so these tests re-implement the client
// checker's exact wire rules — a protobuf walk where length-delimited fields
// are captured by field number (last occurrence wins) and the buffer must
// parse cleanly to the end — and hold the value to its verified form.

import { test } from "node:test";
import assert from "node:assert/strict";

import { NARRATION_THINKING_SIGNATURE } from "./thinking-signature.mjs";

// Mirror of the client checker's field walk. Returns the bytes of the last
// length-delimited `want` field, or null when the buffer is not a cleanly
// parsable message carrying that field.
function findField(bytes, want) {
  let found = null;
  let at = 0;
  const readVarint = () => {
    let value = 0;
    let shift = 1;
    for (let i = 0; i < 10; i++) {
      if (at + i >= bytes.length) return null;
      const byte = bytes[at + i];
      value += (byte & 127) * shift;
      if ((byte & 128) === 0) {
        at += i + 1;
        return value;
      }
      shift *= 128;
    }
    return null;
  };
  while (at < bytes.length) {
    const key = readVarint();
    if (key === null) return null;
    const wire = key & 7;
    const field = Math.floor(key / 8);
    if (wire === 0) {
      if (readVarint() === null) return null;
    } else if (wire === 1) {
      if (at + 8 > bytes.length) return null;
      at += 8;
    } else if (wire === 2) {
      const length = readVarint();
      if (length === null || length > bytes.length - at) return null;
      if (field === want) found = bytes.subarray(at, at + length);
      at += length;
    } else if (wire === 5) {
      if (at + 4 > bytes.length) return null;
      at += 4;
    } else {
      return null;
    }
  }
  return found;
}

const signatureBytes = Uint8Array.from(atob(NARRATION_THINKING_SIGNATURE), (c) => c.charCodeAt(0));

test("the constant is pinned to the verified minimal form", () => {
  assert.equal(NARRATION_THINKING_SIGNATURE, "Eg0KC0IJbmFycmF0aW9u");
});

test("the wire chain decodes to the narration kind", () => {
  const payload = findField(signatureBytes, 2);
  assert.ok(payload, "top-level field 2 must exist");
  const kindMessage = findField(payload, 1);
  assert.ok(kindMessage, "payload field 1 must exist");
  const marker = findField(kindMessage, 8);
  assert.ok(marker, "kind message field 8 must exist");
  assert.equal(new TextDecoder().decode(marker), "narration");
});

test("a buffer that does not parse cleanly to the end yields null", () => {
  // The clean-parse rule is what makes the positive walk above mean
  // anything: a buffer cut off mid-element, or ending in a length-delimited
  // key with no payload behind it, must return null even though field 2
  // itself was seen on the way. (Legal trailing fields parse and are
  // ignored; these are buffers that cannot parse at all.)
  const truncated = signatureBytes.subarray(0, signatureBytes.length - 1);
  assert.equal(findField(truncated, 2), null);
  const trailingKey = new Uint8Array([...signatureBytes, 0x0a]);
  assert.equal(findField(trailingKey, 2), null);
});
