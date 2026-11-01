// 实例 id 上限单源护栏：所有持有 buildInstanceId 本地副本的 launcher，以及
// 终端会话的随机标签（terminalInstanceId），都必须按 agent-metrics 的
// INSTANCE_ID_MAX_LEN 截断，且截断结果能通过 sanitizeInstanceId——上限若各写
// 各的，超长 id 会被 relay 的 sanitizeInstanceId 静默丢弃、会话身份回落到
// socket→pid 兜底，各机制的 cap 必须同源钉死。

import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTANCE_ID_MAX_LEN, sanitizeInstanceId } from "../src/agents/agent-metrics.mjs";
import { buildInstanceId as buildKimiInstanceId } from "../src/launchers/kimi-launcher.mjs";
import { buildInstanceId as buildOpencodeInstanceId } from "../src/launchers/opencode-launcher.mjs";
import { buildInstanceId as buildCodexInstanceId } from "../src/launchers/codex-launcher.mjs";
import { buildInstanceId as buildGrokInstanceId } from "../src/launchers/grok-launcher.mjs";
import { buildInstanceId as buildPiInstanceId } from "../src/launchers/pi-launcher.mjs";
import { buildInstanceId as buildWorkbuddyInstanceId } from "../src/launchers/workbuddy-launcher.mjs";
import { buildAgentSessionEnv } from "../src/agents/agent-session-env.mjs";

// 100 个合法字符集内的字符：长到任何一份 cap 实现都必须截断，又合法——
// 只要 cap 与 sanitizeInstanceId 口径一致，截断结果就应原样存活。
const LONG_CWD = `/work/${"a".repeat(100)}`;

const BUILDERS = [
  ["kimi", buildKimiInstanceId],
  ["opencode", buildOpencodeInstanceId],
  ["codex", buildCodexInstanceId],
  ["grok", buildGrokInstanceId],
  ["pi", buildPiInstanceId],
  ["workbuddy", buildWorkbuddyInstanceId],
];

test("每个 launcher 的 buildInstanceId 都按 INSTANCE_ID_MAX_LEN 截断且过 sanitizeInstanceId", () => {
  for (const [endpoint, build] of BUILDERS) {
    const id = build({ cwd: LONG_CWD, pid: 1234 });
    assert.equal(id.length, INSTANCE_ID_MAX_LEN, `${endpoint} 的实例 id 未按共享上限截断`);
    assert.notEqual(sanitizeInstanceId(id), null, `${endpoint} 截断后的 id 应能通过 sanitizeInstanceId`);
  }
});

test("终端会话随机标签也按 INSTANCE_ID_MAX_LEN 截断且过 sanitizeInstanceId", () => {
  const env = buildAgentSessionEnv({
    agentId: "pi",
    base: { cwd: LONG_CWD },
    instanceId: null,
  });
  const id = env.ANYSWITCH_INSTANCE_ID;
  assert.equal(typeof id, "string");
  assert.equal(id.length, INSTANCE_ID_MAX_LEN);
  assert.notEqual(sanitizeInstanceId(id), null);
});
