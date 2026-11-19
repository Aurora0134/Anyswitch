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

