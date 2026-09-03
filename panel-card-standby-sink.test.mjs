// 看板端点卡待命下沉排序——行为回归测试。
// 背景：卡序旧语义按「agent 进程 running」二分（running 在上、其余在下）；
// 现语义三段分层：「生成中」的卡在顶层；待命超过 5s 的已启动卡掉到待命层
// （生成中卡下方、未启动卡之上）；刚生成完（待命 ≤ 5s 宽限）的卡留在顶层
// 防请求间隙抖动；恢复生成中立即回顶；未启动的卡垫底。
// 各层内部都保持基准顺序（AGENT_CARD_ORDER）。
// 本文件钉住的行为：
// ① 生成中在上、待命超 5s 在下，从未活动的卡（锚点缺失）视为长期待命下沉；
// ② 待命 ≤ 5s 的卡留在上组，跨过 5s 边界那一刻才触发 DOM 重排（顺序没变不动 DOM）；
// ③ 待命锚点取端点最近活动时间（服务端 lastSeen）而非观测起点——页签隐藏
//    后回看板，长待命卡按锚点立即就位；
// ④ claude 会话整行退出后 payload 锚点消失，面板侧记忆的历史最大锚点让
//    待命计时连续，不因锚点回退而提前下沉/回组。
// 「生成中」判定与卡片状态徽标同口径：聚合卡看 metrics.activeRequests，
// claude 看任一 session 在途（activeRequests > 0 或 status === "active"）。
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const panelHtml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
  "utf8",
);

const AGENT_IDS = ["zcode", "claude", "dsh", "agy", "pi", "reasonix", "kimi", "opencode"];
// 基准顺序（fixture 默认全为已启动空闲，即待命层的完整卡序）
const BASE_ORDER = AGENT_IDS;

// 提取 panel.html 中排序语义整块（常量 + 判定 helper + reorderAgentCards）。
// 块内有多个 2 空格缩进的函数闭合，无法用「首个 \n  }」截断，改锚定块尾
// 唯一的 container.append(...cards) 语句 + 函数闭合。
function makeReorder() {
  const m = panelHtml.match(
    /const AGENT_CARD_ORDER[\s\S]*?container\.append\(\.\.\.cards\);\r?\n  \}/,
  );
  assert.ok(m, "排序语义块（AGENT_CARD_ORDER…reorderAgentCards）在 panel.html 中完整存在");
  return buildSandbox(m[0]);
}

function buildSandbox(block) {
  const cards = {}; // agent id → 卡片元素（id 字段即 agent id）
  for (const id of AGENT_IDS) cards[id] = { id };
  const appends = []; // 每次 DOM 重排追加的 id 序列（即最终卡序）
  const container = {
    append(...els) { appends.push(els.map((e) => e.id)); },
    querySelector(sel) {
      const id = /data-agent-id="([^"]+)"/.exec(sel)[1];
      return cards[id] || null;
    },
  };
  const doc = {
    querySelector: (sel) =>
      sel === ".agent-cards-container" ? container : null,
  };
  let nowMs = 1_000_000;
  const fakeDate = { now: () => nowMs };
  const sandbox = new Function(
    "document", "Date",
    `${block}\nreturn { reorderAgentCards, cardActivityAnchor };`,
  )(doc, fakeDate);
  return {
    ...sandbox,
    advance: (ms) => { nowMs += ms; },
    now: () => nowMs,
    appends,
  };
}

// 全 8 卡的默认看板 payload：聚合卡已启动（status=running）空闲且从未活动
// （无 sessions、无 lastSeen），claude 无会话——默认全部落待命层，用例按需
// 覆盖个别端点（status 改 "stopped" 即落入底组）。
function board(overrides = {}) {
  return AGENT_IDS.map((id) => {
    if (overrides[id]) return overrides[id];
    if (id === "claude") return { id, status: "running", processCount: 0, sessions: [] };
    return { id, status: "running", processCount: 1, metrics: { activeRequests: 0 }, sessions: [] };
  });
}

const aggStopped = (id) => ({
  id, status: "stopped", processCount: 0,
  metrics: { activeRequests: 0 }, sessions: [],
});

const aggGenerating = (id) => ({
  id, status: "running", processCount: 1,
  metrics: { activeRequests: 2 }, sessions: [],
});
const aggIdleSince = (id, ageMs, nowMs) => ({
  id, status: "running", processCount: 1,
  metrics: { activeRequests: 0 }, sessions: [{ lastSeen: nowMs - ageMs }],
});
const claudeWith = (sessions) => ({ id: "claude", status: "running", processCount: sessions.length, sessions });

describe("panel.html 端点卡待命下沉排序", () => {
  it("① 生成中在顶、超宽限落待命层、未启动垫底，层内保持基准顺序", () => {
    const t = makeReorder();
    t.reorderAgentCards(board({
      zcode: aggGenerating("zcode"),
      claude: claudeWith([{ activeRequests: 0, status: "idle", lastSeen: t.now() - 60 * 1000 }]),
      dsh: aggIdleSince("dsh", 60 * 1000, t.now()),
      pi: aggStopped("pi"),
    }));
    assert.deepEqual(t.appends[0], [
      "zcode",
      "claude", "dsh", "agy", "reasonix", "kimi", "opencode",
      "pi",
    ], "生成中的 zcode 独占顶层；长待命与从未活动的已启动卡落待命层；未启动的 pi 垫底");
  });

  it("① 聚合卡生成中但 lastSeen 很老仍在上组（生成中不看锚点）", () => {
    const t = makeReorder();
    const agents = board({ zcode: aggGenerating("zcode") });
    agents.find((a) => a.id === "zcode").sessions = [{ lastSeen: t.now() - 600 * 1000 }];
    t.reorderAgentCards(agents);
    assert.equal(t.appends[0][0], "zcode");
  });

  it("② 待命 ≤5s 留上组；跨过 5s 边界那一刻才重排 DOM（顺序没变不动 DOM）", () => {
    const t = makeReorder();
    const dshAnchor = t.now(); // 锚点固定：待命时长随时钟推进自然老化
    const agents = () => board({
      zcode: aggGenerating("zcode"),
      claude: claudeWith([{ activeRequests: 0, status: "idle", lastSeen: dshAnchor - 600 * 1000 }]),
      dsh: aggIdleSince("dsh", 0, dshAnchor), // 刚生成完，宽限期内
    });
    t.reorderAgentCards(agents());
    assert.deepEqual(t.appends[0], [
      "zcode", "dsh",
      "claude", "agy", "pi", "reasonix", "kimi", "opencode",
    ], "宽限期内的 dsh 与生成中的 zcode 同处顶层，长待命已启动卡居待命层");
    t.advance(1000);
    t.reorderAgentCards(agents());
    assert.equal(t.appends.length, 1, "宽限期内顺序没变，不得动 DOM");
    t.advance(5000); // dsh 待命累计 6s > 5s
    t.reorderAgentCards(agents());
    assert.equal(t.appends.length, 2, "跨过 5s 边界触发一次重排");
    assert.deepEqual(t.appends[1], [
      "zcode",
      "claude", "dsh", "agy", "pi", "reasonix", "kimi", "opencode",
    ], "超时后 dsh 掉到待命层，且排在长待命的 claude 之后");
  });

  it("③ 页签隐藏很久后回看板：按服务端锚点第一拍就位，不再等观察期", () => {
    const t = makeReorder();
    t.reorderAgentCards(board({
      dsh: aggIdleSince("dsh", 10 * 60 * 1000, t.now()),
    }));
    assert.deepEqual(t.appends[0], BASE_ORDER, "10 分钟前最后活动的已启动卡首拍即落待命层（基准序）");
  });

  it("④ claude 会话整行退出后锚点消失，面板记忆让待命计时连续", () => {
    const t = makeReorder();
    t.reorderAgentCards(board({
      claude: claudeWith([{ activeRequests: 0, status: "idle", lastSeen: t.now() - 2000 }]),
    }));
    assert.deepEqual(t.appends[0], [
      "claude",
      "zcode", "dsh", "agy", "pi", "reasonix", "kimi", "opencode",
    ], "待命 2s 在宽限期内，claude 留顶层");
    t.reorderAgentCards(board({})); // 会话整行退出，payload 锚点消失
    assert.equal(t.appends.length, 1, "锚点消失不回退：仍按记忆锚点处于宽限期，顺序没变不动 DOM");
    t.advance(4000); // 待命累计 6s
    t.reorderAgentCards(board({}));
    assert.equal(t.appends.length, 2, "按记忆锚点跨过 5s 边界，正常下沉");
    assert.deepEqual(t.appends[1], BASE_ORDER, "claude 落回基准序位置（进程仍在，落待命层）");
  });

  it("⑤ 三段分层全序：生成中/宽限在顶，已启动待命居中，未启动垫底", () => {
    const t = makeReorder();
    t.reorderAgentCards(board({
      zcode: aggGenerating("zcode"),
      claude: claudeWith([{ activeRequests: 0, status: "idle", lastSeen: t.now() - 60 * 1000 }]),
      dsh: aggIdleSince("dsh", 2000, t.now()), // 刚生成完，宽限期内留顶层
      pi: aggStopped("pi"),
    }));
    assert.deepEqual(t.appends[0], [
      "zcode", "dsh",
      "claude", "agy", "reasonix", "kimi", "opencode",
      "pi",
    ], "生成中 zcode 与宽限内 dsh 居顶；长待命 claude 与空闲已启动卡居待命层；未启动 pi 垫底");
  });

  it("claude 生成中（session 在途）立即回上组，兼容 status==='active' 徽标口径", () => {
    const t = makeReorder();
    t.reorderAgentCards(board({
      claude: claudeWith([{ activeRequests: 0, status: "active", lastSeen: t.now() - 600 * 1000 }]),
      zcode: aggIdleSince("zcode", 600 * 1000, t.now()),
    }));
    assert.deepEqual(t.appends[0], [
      "claude",
      "zcode", "dsh", "agy", "pi", "reasonix", "kimi", "opencode",
    ], "session 在途（status 口径）的 claude 排最前");
  });
});
