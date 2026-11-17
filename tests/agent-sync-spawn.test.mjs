// agent-sync-spawn tests: the spawn helper's result contract.
//
// A5 的核心区分：超时被 SIGTERM 掐掉的子进程与崩溃/信号死亡的子进程在 close
// 事件里都报 code null——结果对象必须带 timeout 标记与「runner timed out after
// Ns」文案，否则两种结局压成同一句 runner exit null。spawnFn 注入缝让测试用
// 真实 node -e 子进程走完 spawn/kill/close 全链，不碰真正的同步 runner。

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { spawnAgentSync } from "../src/agents/agent-sync-spawn.mjs";

// 无视 spawnAgentSync 传来的 runner 脚本路径，换成测试脚本；其余（execPath、
// stdio 三元组、windowsHide）原样保留，走完真实进程生命周期。
function spawnScript(source) {
  return (cmd, _args, options) => spawn(cmd, ["-e", source], options);
}

test("超时：结果带 timeout 标记与时长文案，不再落成 runner exit null", async () => {
  const result = await spawnAgentSync({
    port: 47821,
    timeoutMs: 1000,
    spawnFn: spawnScript("setInterval(() => {}, 1000)"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.timeout, true, "超时分支必须可区分");
  assert.equal(result.error, "runner timed out after 1s");
  assert.equal(result.code, null, "SIGTERM 掐掉的进程 close 报 null——没有 timeout 标记时这就是歧义现场");
});

test("非零退出：崩溃/失败不带 timeout 标记", async () => {
  const result = await spawnAgentSync({
    port: 47821,
    timeoutMs: 60_000,
    spawnFn: spawnScript("process.exit(3)"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 3);
  assert.equal(result.timeout, undefined);
  assert.equal(result.error, undefined, "退出码路径不编造 error 文案");
});

test("外部掐死（非超时）：timeout 缺省、error 缺省——与超时不再是同一句", async () => {
  let childRef = null;
  const result = await Promise.all([
    spawnAgentSync({
      port: 47821,
      timeoutMs: 60_000,
      spawnFn: (cmd, _args, options) => {
        childRef = spawn(cmd, ["-e", "setInterval(() => {}, 1000)"], options);
        return childRef;
      },
    }),
    // 等子进程起来后由外部掐死：走完 close 但未经 helper 的超时分支。
    new Promise((r) => setTimeout(r, 300)).then(() => childRef.kill()),
  ]).then(([res]) => res);
  assert.equal(result.ok, false);
  assert.equal(result.timeout, undefined, "非超时的死亡不带 timeout 标记");
  assert.equal(result.error, undefined, "error 缺省——呈现处落成 runner exit null，专指崩溃/被掐");
});

test("子进程行按流定级 mirror 进调用方 logger，摘要标记行不外泄", async () => {
  const lines = { info: [], warn: [] };
  const logger = { info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m) };
  const result = await spawnAgentSync({
    port: 47821,
    timeoutMs: 60_000,
    logger,
    spawnFn: spawnScript(
      "process.stdout.write('[agent-sync] all good\\n');" +
      "process.stdout.write('__ANYSWITCH_SYNC_RESULT__{\"ok\":true}\\n');" +
      "process.stderr.write('[agent-sync] partial trouble\\n');",
    ),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(lines.info, ["[agent-sync] all good"]);
  assert.deepEqual(lines.warn, ["[agent-sync] partial trouble"]);
  assert.ok(result.stdout.includes("__ANYSWITCH_SYNC_RESULT__"), "摘要行留在 result.stdout 供面板解析");
});
