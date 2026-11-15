import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dpapiTestOptions, probeDpapi, DPAPI_PROBE_PLAINTEXT } from "../test-helpers/dpapi-probe.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("the probe runs the script protocol directly, without the production bridge", async () => {
  const calls = [];
  const ciphertext = Buffer.from("sealed synthetic probe");
  const spawnFn = (command, args) => {
    calls.push({ command, args });
    const { EventEmitter } = requireEvents();
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { on() {}, end() { queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify({
        ok: true,
        payloadBase64: (calls.length === 1 ? ciphertext : Buffer.from(DPAPI_PROBE_PLAINTEXT)).toString("base64"),
      })));
      child.emit("close", 0);
    }); } };
    child.kill = () => {};
    return child;
  };
  const result = await probeDpapi({ platform: "win32", env: { SystemRoot: "C:\\fake-system" }, spawnFn, existsFn: () => true });
  assert.equal(result.available, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.args[c.args.indexOf("-Operation") + 1]), ["protect", "unprotect"]);
  assert.ok(calls.every((c) => c.args[c.args.indexOf("-File") + 1].endsWith("dpapi.ps1")));
});

function requireEvents() {
  // Indirect access keeps this helper's fixture independent of DPAPI's implementation.
  return process.getBuiltinModule("node:events");
}

test("a missing platform may skip; a required run fails instead of skipping", () => {
  const missing = { available: false, reason: "requires Windows CurrentUser DPAPI" };
  assert.equal(dpapiTestOptions(missing, { required: false }).skip, missing.reason);
  assert.throws(() => dpapiTestOptions(missing, { required: true }), /Real DPAPI is required/);
});

test("a successful probe makes a globally broken production bridge fail, not skip", async () => {
  const probe = await probeDpapi();
  assert.equal(probe.available, true, "this counterfactual needs the real environment");
  assert.deepEqual(dpapiTestOptions(probe), {});
  const dir = mkdtempSync(join(tmpdir(), "anyswitch-dpapi-gate-"));
  try {
    cpSync(join(root, "dpapi.ps1"), join(dir, "dpapi.ps1"));
    mkdirSync(join(dir, "tests"));
    mkdirSync(join(dir, "test-helpers"));
    cpSync(join(root, "test-helpers", "dpapi-probe.mjs"), join(dir, "test-helpers", "dpapi-probe.mjs"));
    mkdirSync(join(dir, "src", "ops"), { recursive: true });
    const broken = readFileSync(join(root, "src", "ops", "dpapi.mjs"), "utf8").replace(
      '  return transform("protect", generation, providerId, plaintext, timeoutMs);',
      '  return Promise.reject(new Error("counterfactual production bridge"));',
    );
    writeFileSync(join(dir, "src", "ops", "dpapi.mjs"), broken);
    writeFileSync(join(dir, "tests", "dpapi.test.mjs"), readFileSync(join(root, "tests", "dpapi.test.mjs"), "utf8"));
    const child = spawnSync(process.execPath, ["--test", "tests/dpapi.test.mjs"], {
      cwd: dir, encoding: "utf8", timeout: 90_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_TEST_WORKER_ID: undefined },
    });
    assert.notEqual(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /ℹ fail [1-9]/);
    assert.match(child.stdout, /ℹ skipped 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("counterfactual: a successful independent probe still fails a broken production bridge", () => {
  const dir = mkdtempSync(join(tmpdir(), "anyswitch-dpapi-mutation-"));
  try {
    // Mutate the exported production bridge itself in a disposable tree.
    // The independent probe uses the original helper, not this mutant.
    mkdirSync(join(dir, "src", "ops"), { recursive: true });
    const bridgeSource = readFileSync(join(root, "src", "ops", "dpapi.mjs"), "utf8").replace(
      '  return transform("protect", generation, providerId, plaintext, timeoutMs);',
      '  return Promise.reject(new Error("mutated production protect"));',
    );
    writeFileSync(join(dir, "src", "ops", "dpapi.mjs"), bridgeSource);
    cpSync(join(root, "dpapi.ps1"), join(dir, "dpapi.ps1"));
    writeFileSync(join(dir, "run-probe.mjs"), `
      import assert from "node:assert/strict";
      import { probeDpapi, dpapiTestOptions } from ${JSON.stringify(new URL("../test-helpers/dpapi-probe.mjs", import.meta.url).href)};
      const probe = await probeDpapi();
      if (!probe.available) { console.log("DPAPI_UNAVAILABLE", probe.reason); process.exit(0); }
      assert.deepEqual(dpapiTestOptions(probe), {});
      const dpapi = await import(new URL("./src/ops/dpapi.mjs", import.meta.url));
      await assert.rejects(() => dpapi.protect(Buffer.from("synthetic"), "mutation"), /mutated production protect/);
      console.log("BROKEN_BRIDGE_REJECTED");
    `);
    const result = spawnSync(process.execPath, [join(dir, "run-probe.mjs")], {
      cwd: dir, encoding: "utf8", timeout: 90_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_TEST_WORKER_ID: undefined },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes("BROKEN_BRIDGE_REJECTED") || result.stdout.includes("DPAPI_UNAVAILABLE"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
