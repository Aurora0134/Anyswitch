import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EFFORT_LEVELS_ORDER,
  normalizeEffortEntry,
} from "../src/catalog/effort-catalog.mjs";

const BASELINE_PATH = fileURLToPath(new URL("../thinking-efforts-baseline.json", import.meta.url));

// 守卫口径只描述"什么样算泄漏"，刻意不含任何真实值：这份测试本身也进 git、
// 也推远端，写进具体渠道名或本机路径等于换个地方泄漏。命中报告同样只给
// 字段路径与类别，不回显原文，免得测试输出变成第二泄漏面。
const LEAK_PATTERNS = [
  ["url", /\bhttps?:\/\//i],
  ["drive-path", /\b[A-Za-z]:[\\/]/],
  ["home-path", /\/(?:Users|home)\//],
  ["api-key", /\bsk-[A-Za-z0-9_-]{8,}/],
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
];

// 这两个字段是生成时从本机渠道配置反查出来的投影，脱敏时整体剥离。
const FORBIDDEN_KEYS = ["seenOn", "aliases"];

function readBaseline() {
  const data = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  return { data, models: data.models ?? {} };
}

function scanLeaks(data) {
  const hits = [];
  const walk = (value, path) => {
    if (typeof value === "string") {
      for (const [label, pattern] of LEAK_PATTERNS) {
        if (pattern.test(value)) hits.push(`${path} 命中 ${label}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.includes(key)) {
          hits.push(`${path}.${key} 是脱敏时必须剥掉的字段`);
        }
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(data, "$");
  return hits;
}

describe("thinking-efforts 脱敏基线", () => {
  it("随包分发：仓根文件在、可解析、覆盖整库", () => {
    assert.equal(existsSync(BASELINE_PATH), true, "基线必须随仓库分发，运行时靠它兜底");
    const { data, models } = readBaseline();
    assert.equal(data.version, 1);
    assert.ok(Array.isArray(data.levelsOrder));
    assert.ok(
      Object.keys(models).length >= 100,
      `基线条目过少（${Object.keys(models).length}），看起来是残缺快照`,
    );
  });

  it("每条记录都能通过运行时的条目校验", () => {
    const { models } = readBaseline();
    const rejected = Object.entries(models)
      .filter(([, entry]) => normalizeEffortEntry(entry) === null)
      .map(([key]) => key);
    assert.deepEqual(rejected, [], "这些条目进不了运行时表，等于基线里不存在");
  });

  it("挡位词表与代码一致", () => {
    const { data } = readBaseline();
    assert.deepEqual(data.levelsOrder, [...EFFORT_LEVELS_ORDER]);
  });

  it("不含本机字段与可识别的私有串", () => {
    const { data } = readBaseline();
    assert.deepEqual(scanLeaks(data), []);
  });

  it("关键规则抽样：原生分档与非文本判定都在", () => {
    const { models } = readBaseline();
    assert.deepEqual(models["deepseek-v4.1-flash"].levels, ["low", "high", "max"]);
    assert.deepEqual(
      models["minimax-m3.1-flash"].levels,
      ["low", "medium", "high", "xhigh", "max"],
    );
    assert.equal(models["minimax-m3.1-flash"].default, "max");
    assert.equal(models["agnes-image-2.0-flash"].kind, "non-text");
    assert.equal(models["agnes-image-2.0-flash"].levels, null);
  });
});
