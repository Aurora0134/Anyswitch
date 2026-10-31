// Shim manager tests — real fs against temp dirs for the file side, in-memory
// fakes for the registry PATH store, the environment broadcast and spawned
// PowerShell. ZERO real registry, ZERO real PowerShell, ZERO real user config.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  shimRoot,
  SHIM_SPECS,
  findShimSpec,
  renderShimScripts,
  shimFileNames,
  pathEntriesEqual,
  splitPathValue,
  appendPathEntry,
  removePathEntry,
  createRegistryPathStore,
  createEnvironmentBroadcaster,
  createShimManager,
} from "./shim-manager.mjs";
import { mkTestDir } from "./test-helpers/tmp.mjs";

// A spawnFn fake matching child_process.spawn's surface as runPowerShell uses
// it: piped stdout/stderr, close with an exit code. `behavior` may inspect
// the call (args, env) to decide its output.
function fakeSpawn(behavior = () => ({})) {
  const calls = [];
  const spawnFn = (file, args, options) => {
    calls.push({ file, args, options });
    const result = behavior(file, args, options) ?? {};
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      if (result.stdout) child.stdout.emit("data", Buffer.from(result.stdout, "utf8"));
      if (result.stderr) child.stderr.emit("data", Buffer.from(result.stderr, "utf8"));
      child.emit("close", result.code ?? 0);
    });
    return child;
  };
  return { calls, spawnFn };
}

function memoryPathStore(initial = null) {
  let value = initial;
  const writes = [];
  return {
    writes,
    get value() {
      return value;
    },
    store: {
      read: async () => value,
      write: async (next) => {
        writes.push(next);
        value = next;
      },
    },
  };
}

function testManager(home, { pathValue = null, broadcasts = null } = {}) {
  const path = memoryPathStore(pathValue);
  const broadcastLog = broadcasts ?? [];
  const env = { USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local") };
  const manager = createShimManager({
    env,
    pathStore: path.store,
    broadcastFn: async () => {
      broadcastLog.push("broadcast");
    },
  });
  return { manager, path, broadcastLog, env, root: shimRoot(env) };
}

test("shimRoot follows USERPROFILE", () => {
  assert.equal(shimRoot({ USERPROFILE: "C:\\Users\\x" }), join("C:\\Users\\x", ".config", "anyswitch-bin"));
});

test("the registry covers the nine known commands and the shared bin/ members", () => {
  const byId = new Map(SHIM_SPECS.map((spec) => [spec.id, spec]));
  for (const id of ["grok", "claude", "codex", "opencode", "pi", "workbuddy"]) {
    assert.equal(byId.get(id).dir, `bin-${id}`);
    assert.equal(byId.get(id).command, id);
  }
  assert.equal(byId.get("dsh").dir, "bin");
  assert.deepEqual(byId.get("dsh").launcherArgs, ["--profile", "dsh-tui"]);
  assert.equal(byId.get("zcode").dir, "bin");
  assert.deepEqual(byId.get("zcode").extraFiles, ["zcode-app.vbs"]);
  assert.equal(byId.get("workbuddy").launcher, "workbuddy-launcher.mjs");
  assert.equal(byId.get("agy").retired, true);
  assert.throws(() => findShimSpec("nope"), /unknown shim spec/);
});

test("renderShimScripts emits the canonical triplet (grok template shape)", () => {
  const spec = findShimSpec("grok");
  const scripts = renderShimScripts(spec);
  // sh: cygpath + exec, args passthrough
  assert.match(scripts.sh, /^#!\/bin\/sh\n/);
  assert.match(scripts.sh, /cygpath -u "\$LOCALAPPDATA"/);
  assert.match(scripts.sh, /exec node "\$localappdata\/Anyswitch\/app\/grok-launcher\.mjs" "\$@"/);
  // cmd: SETLOCAL + errorlevel propagation
  assert.match(scripts.cmd, /^@ECHO off\nSETLOCAL\n/);
  assert.match(scripts.cmd, /node "%LOCALAPPDATA%\\Anyswitch\\app\\grok-launcher\.mjs" %\*/);
  assert.match(scripts.cmd, /EXIT \/b %ERRORLEVEL%/);
  // ps1: piped-stdin branch + splat
  assert.match(scripts.ps1, /Join-Path \$env:LOCALAPPDATA 'Anyswitch\\app\\grok-launcher\.mjs'/);
  assert.match(scripts.ps1, /\$MyInvocation\.ExpectingInput/);
  assert.match(scripts.ps1, /& node \$launcher @args/);
  assert.match(scripts.ps1, /exit \$LASTEXITCODE/);
  // LF everywhere, trailing newline, ASCII only
  for (const text of Object.values(scripts)) {
    assert.ok(!text.includes("\r"), "no CR bytes");
    assert.ok(text.endsWith("\n"));
    assert.ok([...text].every((ch) => ch.charCodeAt(0) < 128), "ASCII only");
  }
});

test("renderShimScripts places fixed launcher args before the user's own", () => {
  const scripts = renderShimScripts(findShimSpec("dsh"));
  assert.match(scripts.sh, /dsh-launcher\.mjs" --profile dsh-tui "\$@"/);
  assert.match(scripts.cmd, /dsh-launcher\.mjs" --profile dsh-tui %\*/);
  assert.match(scripts.ps1, /& node \$launcher --profile dsh-tui @args/);
});

test("shimFileNames is the extensionless/cmd/ps1 triplet", () => {
  assert.deepEqual(shimFileNames(findShimSpec("pi")), ["pi", "pi.cmd", "pi.ps1"]);
});

test("pathEntriesEqual ignores case and trailing separators", () => {
  assert.ok(pathEntriesEqual("C:\\X\\Bin", "c:\\x\\bin\\"));
  assert.ok(pathEntriesEqual("C:/x/bin/", "C:\\x\\bin"));
  assert.ok(!pathEntriesEqual("C:\\x", "C:\\xy"));
});

test("splitPathValue drops empty segments", () => {
  assert.deepEqual(splitPathValue("a;;b;"), ["a", "b"]);
  assert.deepEqual(splitPathValue(""), []);
  assert.deepEqual(splitPathValue(null), []);
});

test("appendPathEntry appends at the end and is a verbatim no-op when present", () => {
  assert.deepEqual(appendPathEntry("", "C:\\bin"), { value: "C:\\bin", changed: true });
  assert.deepEqual(appendPathEntry("A;B", "C:\\bin"), { value: "A;B;C:\\bin", changed: true });
  // present (case-insensitive): the original string passes through untouched
  assert.deepEqual(appendPathEntry("A;c:\\BIN\\;B", "C:\\bin"), { value: "A;c:\\BIN\\;B", changed: false });
});

test("removePathEntry removes every match and keeps the rest verbatim", () => {
  assert.deepEqual(removePathEntry("A;C:\\bin;B;c:\\BIN\\", "C:\\bin"), { value: "A;B", changed: true });
  assert.deepEqual(removePathEntry("A;B", "C:\\bin"), { value: "A;B", changed: false });
});

test("registry path store reads the raw value, maps the absent sentinel to null", async () => {
  const { calls, spawnFn } = fakeSpawn(() => ({ stdout: "C:\\a;C:\\b" }));
  const store = createRegistryPathStore({ spawnFn });
  assert.equal(await store.read(), "C:\\a;C:\\b");
  const [call] = calls;
  assert.match(call.file, /powershell/i);
  const script = call.args.at(-1);
  assert.match(script, /CurrentUser.*Environment/s);
  assert.match(script, /DoNotExpandEnvironmentNames/);

  const absent = fakeSpawn(() => ({ code: 3 }));
  assert.equal(await createRegistryPathStore({ spawnFn: absent.spawnFn }).read(), null);

  const broken = fakeSpawn(() => ({ code: 1, stderr: "boom" }));
  await assert.rejects(() => createRegistryPathStore({ spawnFn: broken.spawnFn }).read(), /boom/);
});

test("registry path store writes via env-carried value and preserves the existing kind", async () => {
  const { calls, spawnFn } = fakeSpawn();
  const store = createRegistryPathStore({ spawnFn });
  await store.write("C:\\a;C:\\b", { env: { SOME: "env" } });
  const [call] = calls;
  const script = call.args.at(-1);
  assert.match(script, /SetValue\('Path', \$env:ANYSWITCH_PATH_VALUE, \$kind\)/);
  assert.match(script, /GetValueKind\('Path'\)/);
  assert.equal(call.options.env.ANYSWITCH_PATH_VALUE, "C:\\a;C:\\b");
  assert.equal(call.options.env.SOME, "env");
});

test("environment broadcaster sends WM_SETTINGCHANGE via powershell and surfaces failure", async () => {
  const { calls, spawnFn } = fakeSpawn();
  await createEnvironmentBroadcaster({ spawnFn })();
  const script = calls[0].args.at(-1);
  assert.match(script, /SendMessageTimeout/);
  assert.match(script, /0x1A/);
  assert.match(script, /'Environment'/);

  const broken = fakeSpawn(() => ({ code: 1, stderr: "no user32" }));
  await assert.rejects(() => createEnvironmentBroadcaster({ spawnFn: broken.spawnFn })(), /no user32/);
});

test("installShim writes the triplet, is byte-idempotent, refuses retired specs", () => {
  const home = mkTestDir("shim-install-");
  const { manager, root } = testManager(home);
  const first = manager.installShim("grok");
  assert.equal(first.dir, join(root, "bin-grok"));
  assert.equal(first.written.length, 3);
  for (const name of ["grok", "grok.cmd", "grok.ps1"]) {
    assert.ok(existsSync(join(root, "bin-grok", name)), name);
  }
  assert.equal(
    readFileSync(join(root, "bin-grok", "grok.cmd"), "utf8"),
    renderShimScripts(findShimSpec("grok")).cmd,
  );
  const second = manager.installShim("grok");
  assert.equal(second.written.length, 0);
  assert.equal(second.unchanged.length, 3);
  assert.throws(() => manager.installShim("agy"), /retired/);
});

test("removeShim removes only the spec's files and the directory only when empty", () => {
  const home = mkTestDir("shim-remove-");
  const { manager, root } = testManager(home);
  manager.installShim("grok");
  const foreign = join(root, "bin-grok", "notes.txt");
  writeFileSync(foreign, "mine");
  const kept = manager.removeShim("grok");
  assert.equal(kept.removed.length, 3);
  assert.equal(kept.dirRemoved, false);
  assert.ok(existsSync(foreign));

  // zcode's extraFiles travel with its triplet; bin/ survives while another
  // command still lives there.
  manager.installShim("zcode");
  manager.installShim("dsh");
  writeFileSync(join(root, "bin", "zcode-app.vbs"), "vbs");
  const zRemoved = manager.removeShim("zcode");
  assert.deepEqual(
    zRemoved.removed.map((p) => p.split(/[\\/]/).pop()).sort(),
    ["zcode", "zcode-app.vbs", "zcode.cmd", "zcode.ps1"],
  );
  assert.equal(zRemoved.dirRemoved, false);
  assert.ok(existsSync(join(root, "bin", "dsh-cli.cmd")));
  const dRemoved = manager.removeShim("dsh");
  assert.equal(dRemoved.dirRemoved, true);
  assert.ok(!existsSync(join(root, "bin")));
});

test("retireShim drops the PATH entry exactly when the directory is gone", async () => {
  const home = mkTestDir("shim-retire-");
  const binGrok = join(shimRoot({ USERPROFILE: home }), "bin-grok");
  const { manager, path } = testManager(home, { pathValue: `C:\\x;${binGrok}` });
  // directory never existed: PATH entry still removed
  const gone = await manager.retireShim("grok");
  assert.equal(gone.dirRemoved, false);
  assert.equal(gone.path.changed, true);
  assert.equal(path.value, "C:\\x");

  // directory survives on a foreign file: PATH entry kept
  const { manager: manager2, path: path2 } = testManager(home, { pathValue: `C:\\x;${binGrok}` });
  manager2.installShim("grok");
  writeFileSync(join(binGrok, "foreign.txt"), "keep");
  const kept = await manager2.retireShim("grok");
  assert.equal(kept.dirRemoved, false);
  assert.equal(kept.path.changed, false);
  assert.equal(path2.value, `C:\\x;${binGrok}`);
});

test("addShimToPath appends the spec's directory once", async () => {
  const home = mkTestDir("shim-addpath-");
  const { manager, path } = testManager(home, { pathValue: "C:\\x" });
  const dir = join(shimRoot({ USERPROFILE: home }), "bin-pi");
  const added = await manager.addShimToPath("pi");
  assert.equal(added.changed, true);
  assert.equal(path.value, `C:\\x;${dir}`);
  const again = await manager.addShimToPath("pi");
  assert.equal(again.changed, false);
  assert.equal(path.writes.length, 1);
});

test("broadcast is a separate explicit step", async () => {
  const home = mkTestDir("shim-broadcast-");
  const { manager, broadcastLog } = testManager(home);
  await manager.broadcastEnvironmentChange();
  assert.deepEqual(broadcastLog, ["broadcast"]);
});
