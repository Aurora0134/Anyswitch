import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  DESKTOP_PICKER_BLOCKLIST,
  passesDesktopPickerFilter,
  buildDesktopCatalogView,
  resolveDesktopAlias,
} from "./desktop-route-alias.mjs";

// 桌面拾取器的品牌黑名单钉样（golden pin），字面逐字取自 Claude Desktop
// 2.9939.2 app.asar（.vite/build/index.chunk-6aZ703Pj.js，拾取器两道闸共用
// 同一条）。这个测试不读 asar，探不到官方换表——它锁的是模块常量：任何人
// 改 DESKTOP_PICKER_BLOCKLIST 都必须同步更新这份手抄副本，改的时候按上面
// 出处对照官方 asar 重核；官方真换表而模块没人动时，这里不会红（那种漂移
// 靠升级 Claude Desktop 时对别名层的人工重核兜底）。
const ASAR_BLOCKLIST_SOURCE =
  "ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\\bling\\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\\bunic\\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\\d|\\bk2\\.|\\bm2\\.|jamba|arctic|solar|mercury|zamba|kat-coder|\\bds-|dpsk";

test("品牌黑名单钉样：模块正则锁死为钉样字面，且无 i 标志（过滤前先转小写）", () => {
  assert.equal(DESKTOP_PICKER_BLOCKLIST.flags, "", "模块按小写输入测试，正则本身不带 i 标志");
  assert.equal(
    DESKTOP_PICKER_BLOCKLIST.source,
    ASAR_BLOCKLIST_SOURCE,
    "黑名单字面被改动：按本文件头出处对照官方 asar 重核后，再同步这份钉样",
  );
});

test("拾取器过滤正反例：档位名/家族词过，竞品品牌词滤", () => {
  // 过：裸档位名（含带版本号）
  for (const id of ["sonnet", "opus", "haiku", "fable", "mythos", "sonnet-4-5", "opus-4-1"]) {
    assert.equal(passesDesktopPickerFilter(id), true, `${id} 是裸档位名`);
  }
  // 过：含 Claude 家族词——目录里全部 wire id 都以 "anthropic/" 开头，家族词
  // 恒真，真正裁决黑名单的是品牌词。
  for (const id of [
    "anthropic/poke-api/claude-opus-5",
    "anthropic/your-provider/your-small-fast-model",
    "anthropic/kestrel/step-5-preview", // step-5 不在表上（表上是 step-3/stepfun）
    "anthropic/auto",
    "claude-opus-5-5",
  ]) {
    assert.equal(passesDesktopPickerFilter(id), true, `${id} 含家族词且不撞品牌词`);
  }
  // 滤：撞品牌词的（前缀 anthropic/ 也救不回来——黑名单先判）
  for (const id of [
    "anthropic/moonshot/kimi-k3",
    "anthropic/north/deepseek-v3",
    "anthropic/openai/gpt-5",
    "anthropic/x/glm-4.6",
    "anthropic/x/qwen3-coder",
    "anthropic/x/stepfun-step-2",
    "anthropic/x/yi-lightning",
    "anthropic/x/doubao-pro",
    "anthropic/x/ernie-4.5",
    "anthropic/x/codex-mini",
  ]) {
    assert.equal(passesDesktopPickerFilter(id), false, `${id} 撞品牌黑名单`);
  }
});

// 一个跨口径的目录样张：真 wire id 两条（一条过过滤、一条撞黑名单）、auto、
// 单段虚拟模型一条。contextWindow 字段对别名层无关紧要，带上只为形状同构。
function sampleEntries() {
  return [
    { wireId: "anthropic/poke-api/claude-opus-5", displayName: "[poke-api] Claude Opus 5", contextWindow: 1000000 },
    { wireId: "anthropic/north/kimi-k3", displayName: "[north] Kimi K3", contextWindow: 1000000 },
    { wireId: "anthropic/north/deepseek-v3", displayName: "[north] DeepSeek V3", contextWindow: 128000 },
    { wireId: "anthropic/auto", displayName: "[Anyswitch] auto" },
    { wireId: "anthropic/my-vm", displayName: "[Anyswitch] my-vm" },
  ];
}

test("桌面视图：只有撞黑名单的条目换确定性单段别名，其余原样", () => {
  const entries = sampleEntries();
  const view = buildDesktopCatalogView(entries);

  // 过滤通过的条目（真 wire id、auto、虚拟模型）一个字节都不动。
  assert.equal(view.entries[0].wireId, "anthropic/poke-api/claude-opus-5");
  assert.equal(view.entries[3].wireId, "anthropic/auto");
  assert.equal(view.entries[4].wireId, "anthropic/my-vm");
  for (const i of [0, 3, 4]) {
    assert.equal(view.entries[i].displayName, entries[i].displayName, "显示名不受 id 过滤影响");
  }

  // 撞黑名单的两条换成 anthropic/<6位> 单段别名：必过拾取器过滤、彼此不同
  // （表内单射）。本目录的真 id 要么多段、要么是 auto(尾4字符)/my-vm(尾5字
  // 符) 这类短单段名，与 6 位码形状不可能相撞——形状断言已蕴含，不另设恒
  // 真的 notEqual；真正可能撞的 6 位单段真名（虚拟模型）由保留字机制负责，
  // 见下一个用例。
  assert.equal(view.aliases.size, 2);
  const aliased = [view.entries[1], view.entries[2]];
  const codes = new Set();
  for (const entry of aliased) {
    assert.match(entry.wireId, /^anthropic\/[a-z0-9]{6}$/, "确定性单段别名形状");
    assert.equal(passesDesktopPickerFilter(entry.wireId), true, "别名本身过拾取器过滤");
    codes.add(entry.wireId);
  }
  assert.equal(codes.size, 2, "别名互不相同");
  // 显示名照旧——真名本来就骑在 display_name 上，桌面永远显示它。
  assert.equal(view.entries[1].displayName, "[north] Kimi K3");
  assert.equal(view.entries[2].displayName, "[north] DeepSeek V3");
  // 别名表：别名 → 真 id，与换出的 id 对得上。
  assert.equal(view.aliases.get(view.entries[1].wireId), "anthropic/north/kimi-k3");
  assert.equal(view.aliases.get(view.entries[2].wireId), "anthropic/north/deepseek-v3");
});

test("确定性：同一目录两次构建结果完全一致（跨重启稳定）", () => {
  const a = buildDesktopCatalogView(sampleEntries());
  const b = buildDesktopCatalogView(sampleEntries());
  assert.deepEqual(a.entries, b.entries);
  assert.deepEqual([...a.aliases.entries()], [...b.aliases.entries()]);
});

test("单段虚拟模型撞黑名单时同样换别名（名字含竞品词的 vm 也进得了菜单）", () => {
  const entries = [
    { wireId: "anthropic/poke-api/claude-opus-5", displayName: "[poke-api] Claude Opus 5" },
    { wireId: "anthropic/kimi-router", displayName: "[Anyswitch] kimi-router" },
  ];
  const view = buildDesktopCatalogView(entries);
  assert.equal(view.aliases.size, 1);
  assert.match(view.entries[1].wireId, /^anthropic\/[a-z0-9]{6}$/);
  assert.equal(view.entries[1].displayName, "[Anyswitch] kimi-router");
  assert.equal(view.aliases.get(view.entries[1].wireId), "anthropic/kimi-router");
});

test("保留字：已服务单段名占住 6 位码空间时，别名换盐避让", () => {
  // 真正可能与别名相撞的真 id 只有 6 位单段名（已服务的虚拟模型）。别名码
  // 派生见 desktop-route-alias.mjs 的 aliasCodeFor：sha256(`${salt}:${tail}`)
  // 首 4 字节大端 → base36 补零截 6 位。这里按同一派生算出失败条目的首选
  // 码，并让同目录恰好已服务这个名字——保留字生效时模块必须换盐避让。
  // （对派生方式是钉样式耦合：模块改派生则本用例的夹具前提会红，属有意。）
  const codeOf = (tail, salt = 0) =>
    createHash("sha256").update(`${salt}:${tail}`).digest().readUInt32BE(0).toString(36).padStart(6, "0").slice(0, 6);

  const failingTail = "x/kimi-k3";
  const occupied = codeOf(failingTail); // 无保留逻辑时 kimi-k3 会被发成这个名字
  assert.equal(DESKTOP_PICKER_BLOCKLIST.test(occupied), false, "夹具前提：占用名不撞黑名单，才能作为已服务名过过滤");

  const entries = [
    { wireId: "anthropic/poke-api/claude-opus-5", displayName: "[poke-api] Claude Opus 5" },
    { wireId: `anthropic/${occupied}`, displayName: `[Anyswitch] ${occupied}` },
    { wireId: `anthropic/${failingTail}`, displayName: "[x] Kimi K3" },
  ];
  const view = buildDesktopCatalogView(entries);

  assert.equal(view.aliases.size, 1, "只有撞黑名单的 kimi-k3 需要换名");
  assert.equal(view.entries[1].wireId, `anthropic/${occupied}`, "已服务单段虚拟模型原样保留");
  const alias = view.entries[2].wireId;
  assert.notEqual(alias, `anthropic/${occupied}`, "保留字生效：首选码被占则换盐避让");
  assert.match(alias, /^anthropic\/[a-z0-9]{6}$/);
  assert.equal(passesDesktopPickerFilter(alias), true, "避让后的别名仍过拾取器过滤");
  assert.equal(view.aliases.get(alias), `anthropic/${failingTail}`);
  assert.equal(resolveDesktopAlias(`anthropic/${occupied}`, entries), null, "已服务名不在别名表，反解得 null");
  assert.equal(resolveDesktopAlias(alias, entries), `anthropic/${failingTail}`);
});

test("别名反解：同一目录内回环，目录外/双段/未知名一律 null", () => {
  const entries = sampleEntries();
  const view = buildDesktopCatalogView(entries);

  // 回环：目录里换出的别名都反解回真 id。
  for (const [alias, real] of view.aliases) {
    assert.equal(resolveDesktopAlias(alias, entries), real, `${alias} 反解回 ${real}`);
  }

  // 真双段 wire id 永不是别名（别名恒单段）。
  assert.equal(resolveDesktopAlias("anthropic/north/kimi-k3", entries), null);
  assert.equal(resolveDesktopAlias("anthropic/poke-api/claude-opus-5", entries), null);
  // 已服务单段名（auto、虚拟模型）不在别名表里。
  assert.equal(resolveDesktopAlias("anthropic/auto", entries), null);
  assert.equal(resolveDesktopAlias("anthropic/my-vm", entries), null);
  // 未知名、无前缀名、非字符串都拒绝。
  assert.equal(resolveDesktopAlias("anthropic/zzzzzz", entries), null);
  assert.equal(resolveDesktopAlias("claude-opus-5", entries), null);
  assert.equal(resolveDesktopAlias("auto", entries), null);
  assert.equal(resolveDesktopAlias(null, entries), null);
  assert.equal(resolveDesktopAlias(undefined, entries), null);
  assert.equal(resolveDesktopAlias(12345, entries), null);

  // 目录换了：反解从新目录重建表，旧别名查不到就 null（无持久化映射）。
  const other = [{ wireId: "anthropic/poke-api/claude-opus-5", displayName: "[poke-api] Claude Opus 5" }];
  assert.equal(resolveDesktopAlias(view.entries[1].wireId, other), null, "kimi-k3 的旧别名在新目录里反解不到");
});
