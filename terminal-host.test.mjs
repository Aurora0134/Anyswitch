import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createTerminalHost } from "./terminal-host.mjs";

class FakePty {
  constructor() {
    this.pid = 4321;
    this.cols = 80;
    this.rows = 24;
    this.dataListener = null;
    this.exitListener = null;
  }
  onData(fn) { this.dataListener = fn; }
  onExit(fn) { this.exitListener = fn; }
  write(data) { this.dataListener?.(`echo:${data}`); }
  resize(cols, rows) { this.cols = cols; this.rows = rows; }
  kill() { this.exitListener?.({ exitCode: 0 }); }
}

function headers(host) {
  return { authorization: `Bearer ${host.token}`, "content-type": "application/json" };
}

async function listen(host) {
  await new Promise((resolve, reject) => {
    host.server.once("error", reject);
    host.server.listen(0, "127.0.0.1", resolve);
  });
  return host.server.address().port;
}

test("terminal host owns persistent session metadata and PTY controls", async () => {
  const root = mkdtempSync(`${tmpdir()}\\anyswitch-terminal-test-`);
  const host = createTerminalHost({
    root,
    port: 0,
    ptyModule: { spawn: () => new FakePty() },
    logger: { warn() {} },
  });
  const port = await listen(host);
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const unauthorized = await fetch(url("/terminal/sessions"));
    assert.equal(unauthorized.status, 401);

    const createdResponse = await fetch(url("/terminal/sessions"), {
      method: "POST",
      headers: headers(host),
      body: JSON.stringify({ label: "测试终端", cwd: root, shell: "powershell", cols: 100, rows: 30 }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.label, "测试终端");
    assert.equal(created.pid, 4321);
    assert.equal(created.status, "running");

    const inputResponse = await fetch(url(`/terminal/sessions/${created.id}/input`), {
      method: "POST", headers: headers(host), body: JSON.stringify({ data: "hello\r" }),
    });
    assert.equal(inputResponse.status, 200);
    const resized = await fetch(url(`/terminal/sessions/${created.id}/resize`), {
      method: "POST", headers: headers(host), body: JSON.stringify({ cols: 120, rows: 40 }),
    }).then((response) => response.json());
    assert.deepEqual({ cols: resized.cols, rows: resized.rows }, { cols: 120, rows: 40 });

    const state = await fetch(url(`/terminal/sessions/${created.id}`), { headers: headers(host) }).then((response) => response.json());
    assert.equal(state.status, "running");
    assert.ok(state.buffer.some((chunk) => chunk.includes("echo:hello")));

    await host.close();
    const restored = createTerminalHost({ root, port: 0, ptyModule: { spawn: () => new FakePty() }, logger: { warn() {} } });
    const restoredPort = await listen(restored);
    const listed = await fetch(`http://127.0.0.1:${restoredPort}/terminal/sessions`, { headers: headers(restored) }).then((response) => response.json());
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].id, created.id);
    assert.equal(listed.sessions[0].status, "exited", "restored metadata waits for explicit restart");
    await restored.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
