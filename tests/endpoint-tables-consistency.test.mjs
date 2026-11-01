// Endpoint-id table consistency guardrail（端点表跨表一致性不变量）.
//
// 同一份「端点全集」的事实以字面形式散落在多张各自声明的表里：store schema 的
// 路由白名单、skills 注册表、提示词注入面、卸载驱动、x-agent-id 白名单、终端
// 目标、可续聊集合、BYOK 导入面、agent 同步面、进程归属面。历史上每接入一个
// 端点（如 workbuddy）都靠人工逐表手改，漏改一侧不会让任何测试变红。这些测试
// 把各表与十个真实端点全集的关系钉成不变量：新增端点只改一张表、或拼错一个
// id，都会在这里红，把「逐表同步义务」从注释级升级成测试级。
//
// 成员关系逐表取自各表所在模块的注释语义（存量例外都写明了缘由）；有意变更
// 某张表的成员集合时，连同本文件里对应的关系行一起改。

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTING_ENDPOINT_IDS } from "../src/store/store-schema.mjs";
import { ENDPOINT_DEFS as SKILLS_ENDPOINT_DEFS } from "../src/agents/agent-skills.mjs";
import { PROMPT_ENDPOINTS } from "../src/agents/agent-prompts-inject.mjs";
import { UNINSTALL_ENDPOINT_IDS } from "../src/ops/uninstall-agent.mjs";
import { AGENT_ENDPOINTS } from "../src/agents/agent-sync.mjs";
import { BYOK_IMPORT_AGENTS } from "../src/store/byok-import.mjs";
import { RESUMABLE_AGENTS } from "../src/terminal/terminal-conversation-bindings.mjs";
import { AGENT_TERMINAL_TARGETS } from "../src/agents/agent-session-env.mjs";

const root = dirname(fileURLToPath(import.meta.url));

// 未导出的字面表从源码取样。取样不到就红（守卫齐全），绝不静默放行。
function literalIds(relPath, pattern, label) {
  const src = readFileSync(join(root, "..", relPath), "utf8");
  const hit = src.match(pattern)?.[1];
  assert.ok(hit, `${label} 能从 ${relPath} 取样（声明形式变了就更新取样正则）`);
  return hit.split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
}

const knownAgentIds = literalIds(
  "src/relay/openai-server.mjs",
  /const KNOWN_AGENT_IDS = new Set\(\[([^\]]*)\]\)/,
  "KNOWN_AGENT_IDS",
);
const detectedClientEndpoints = literalIds(
  "src/agents/agent-metrics.mjs",
  /const DETECTED_CLIENT_ENDPOINTS = \[([^\]]*)\]/,
  "DETECTED_CLIENT_ENDPOINTS",
);

// 十个真实端点全集：各表共同的语义基准。新增端点 = 改这里 + 受影响的表 +
// 本文件里对应的关系行。
const UNIVERSE = ["claude", "zcode", "opencode", "pi", "kimi", "dsh", "qoder", "codex", "grok", "workbuddy"];

describe("端点表跨表成员一致性", () => {
  const routing = [...ROUTING_ENDPOINT_IDS];
  const skills = SKILLS_ENDPOINT_DEFS.map((def) => def.id);
  const prompts = PROMPT_ENDPOINTS.map((def) => def.id);
  const uninstall = [...UNINSTALL_ENDPOINT_IDS];
  const sync = [...AGENT_ENDPOINTS];
  const byok = [...BYOK_IMPORT_AGENTS];
  const resumable = [...RESUMABLE_AGENTS];
  const terminalTargets = Object.keys(AGENT_TERMINAL_TARGETS);
  const all = {
    "ROUTING_ENDPOINT_IDS（store-schema 路由白名单）": routing,
    "agent-skills ENDPOINT_DEFS（skills 注册表）": skills,
    "KNOWN_AGENT_IDS（relay x-agent-id 白名单）": knownAgentIds,
    "PROMPT_ENDPOINTS（提示词注入面）": prompts,
    "UNINSTALL_ENDPOINT_IDS（卸载驱动）": uninstall,
    "AGENT_TERMINAL_TARGETS（终端目标登记）": terminalTargets,
    "RESUMABLE_AGENTS（可续聊集合）": resumable,
    "AGENT_ENDPOINTS（agent 配置同步面）": sync,
    "BYOK_IMPORT_AGENTS（BYOK 导入面）": byok,
    "DETECTED_CLIENT_ENDPOINTS（终端会话归属面）": detectedClientEndpoints,
  };

  it("任何表都不允许重复成员，所有成员都登记在 ROUTING_ENDPOINT_IDS 里", () => {
    for (const [label, ids] of Object.entries(all)) {
      assert.equal(new Set(ids).size, ids.length, `${label} 有重复成员（重复会让覆盖面静默缩水）`);
    }
    const registry = new Set([...routing, "agents"]);
    for (const [label, ids] of Object.entries(all)) {
      for (const id of ids) {
        assert.ok(
          registry.has(id),
          `${label} 的 "${id}" 未登记进 ROUTING_ENDPOINT_IDS（新端点先入注册表再上各表；agents 是 skills-only 例外）`,
        );
      }
    }
  });

  it("五张全量表与十个真实端点一一对应", () => {
    const expected = [...UNIVERSE].sort();
    for (const [label, ids] of [
      ["KNOWN_AGENT_IDS（relay x-agent-id 白名单）", knownAgentIds],
      ["PROMPT_ENDPOINTS（提示词注入面）", prompts],
      ["UNINSTALL_ENDPOINT_IDS（卸载驱动）", uninstall],
      ["AGENT_TERMINAL_TARGETS（终端目标登记）", terminalTargets],
      ["RESUMABLE_AGENTS（可续聊集合）", resumable],
    ]) {
      assert.deepEqual([...ids].sort(), expected, `${label} 应与十个真实端点全集一致`);
    }
  });

  it("同步与 BYOK 导入面不含 claude（claude 的模型经中继动态发现，无本地配置可写/可导）", () => {
    const expected = UNIVERSE.filter((id) => id !== "claude").sort();
    assert.deepEqual([...sync].sort(), expected, "AGENT_ENDPOINTS 应为全集去掉 claude");
    assert.deepEqual([...byok].sort(), expected, "BYOK_IMPORT_AGENTS 应为全集去掉 claude");
  });

  it("终端会话归属面不含 zcode（zcode 聚合口径，见 agent-metrics 内注释）", () => {
    const expected = UNIVERSE.filter((id) => id !== "zcode").sort();
    assert.deepEqual([...detectedClientEndpoints].sort(), expected, "DETECTED_CLIENT_ENDPOINTS 应为全集去掉 zcode");
  });

  it("两张超集表：routing 多两个仅存量 id，skills 多全局端点", () => {
    // agy / reasonix 仅作为存量 store id 接受（schema 注释：还有 store 带着这
    // 两个键就不能让校验失败）；agents 是 skills-only 全局端点，无 relay/launcher
    // 实现（agent-skills 注释），也刻意不入 routing。
    assert.deepEqual([...routing].sort(), [...UNIVERSE, "agy", "reasonix"].sort(), "ROUTING_ENDPOINT_IDS = 全集 + agy/reasonix");
    assert.deepEqual([...skills].sort(), [...UNIVERSE, "agents"].sort(), "skills ENDPOINT_DEFS = 全集 + agents");
  });
});
