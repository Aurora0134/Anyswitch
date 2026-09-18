import { it } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, parseVersion } from "./version-check.mjs";

it("rejects invalid or runtime versions and exposes lossless parsed identifiers", () => {
  for (const invalid of [null, 123, "", "v1.2.3", "rust-v1.2.3", "1.2", "1.2.3.0", "01.2.3", "1.2.3-01", "1.2.3-rc.01", "1.2.3-", "1.2.3+", "1.2.3-α", "1.2.3\n", " 1.2.3"]) {
    assert.equal(parseVersion(invalid), null, String(invalid));
    assert.equal(compareVersions(invalid, "1.2.3"), null);
    assert.equal(compareVersions("1.2.3", invalid), null);
  }
  assert.deepEqual(parseVersion("1.2.3-rc.2+004"), {
    version: "1.2.3-rc.2+004", core: ["1", "2", "3"], prerelease: ["rc", "2"], build: ["004"],
  });
});

it("orders SemVer releases and numeric prereleases without losing precision", () => {
  const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0"];
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(compareVersions(ordered[i - 1], ordered[i]), -1);
    assert.equal(compareVersions(ordered[i], ordered[i - 1]), 1);
  }
  assert.equal(compareVersions("0.5.0-preview.2", "0.5.0-preview.10"), -1);
  assert.equal(compareVersions("0.1.5-rc.2", "0.1.5"), -1);
  assert.equal(compareVersions("1.0.0+one", "1.0.0+two"), 0);
  assert.equal(compareVersions("99999999999999999999.0.0", "100000000000000000000.0.0"), -1);
  assert.equal(compareVersions("1.0.0-99999999999999999999", "1.0.0-100000000000000000000"), -1);
});
