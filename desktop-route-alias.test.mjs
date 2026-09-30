import test from "node:test";
import assert from "node:assert/strict";
import {
  DESKTOP_PICKER_BLOCKLIST,
  passesDesktopPickerFilter,
  buildDesktopCatalogView,
  resolveDesktopAlias,
} from "./desktop-route-alias.mjs";

// 桌面拾取器的品牌黑名单，逐字取自 Claude Desktop 2.9939.2 app.asar
// （.vite/build/index.chunk-6aZ703Pj.js，拾取器两道闸共用同一条）。这里把
// source 整串钉死：官方一旦换表，这个测试红——别名层必须跟着重核，不能静默
// 沿用过期黑名单给桌面发错的目录形状。
const ASAR_BLOCKLIST_SOURCE =
  "ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\\bling\\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\\bunic\\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\\d|\\bk2\\.|\\bm2\\.|jamba|arctic|solar|mercury|zamba|kat-coder|\\bds-|dpsk";

test("品牌黑名单与桌面 asar 逐字一致（无标志位：过滤前先转小写）", () => {
  assert.equal(DESKTOP_PICKER_BLOCKLIST.flags, "", "模块按小写输入测试，正则本身不带 i 标志");
  assert.equal(DESKTOP_PICKER_BLOCKLIST.source, ASAR_BLOCKLIST_SOURCE);
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
    "anthropic/sta1n/step-5-preview", // step-5 不在表上（表上是 step-3/stepfun）
    "anthropic/auto",
    "claude-opus-5-5",
  ]) {
    assert.equal(passesDesktopPickerFilter(id), true, `${id} 含家族词且不撞品牌词`);
  }
  // 滤：撞品牌词的（前缀 anthropic/ 也救不回来——黑名单先判）
  for (const id of [
    "anthropic/moonshot/kimi-k3",
    "anthropic/a6api/deepseek-v3",
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
    { wireId: "anthropic/a6api/kimi-k3", displayName: "[a6api] Kimi K3", contextWindow: 1000000 },
    { wireId: "anthropic/a6api/deepseek-v3", displayName: "[a6api] DeepSeek V3", contextWindow: 128000 },
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

  // 撞黑名单的两条换成 anthropic/<6位> 单段别名：必过拾取器过滤、必不等于
  // 任何真 wire id（真 id 双段）、彼此不同（表内单射）。
  assert.equal(view.aliases.size, 2);
  const aliased = [view.entries[1], view.entries[2]];
  const codes = new Set();
  for (const entry of aliased) {
    assert.match(entry.wireId, /^anthropic\/[a-z0-9]{6}$/, "确定性单段别名形状");
    assert.equal(passesDesktopPickerFilter(entry.wireId), true, "别名本身过拾取器过滤");
    assert.notEqual(entry.wireId, "anthropic/a6api/kimi-k3");
    assert.notEqual(entry.wireId, "anthropic/a6api/deepseek-v3");
    codes.add(entry.wireId);
  }
  assert.equal(codes.size, 2, "别名互不相同");
  // 显示名照旧——真名本来就骑在 display_name 上，桌面永远显示它。
  assert.equal(view.entries[1].displayName, "[a6api] Kimi K3");
  assert.equal(view.entries[2].displayName, "[a6api] DeepSeek V3");
  // 别名表：别名 → 真 id，与换出的 id 对得上。
  assert.equal(view.aliases.get(view.entries[1].wireId), "anthropic/a6api/kimi-k3");
  assert.equal(view.aliases.get(view.entries[2].wireId), "anthropic/a6api/deepseek-v3");
  // auto 与已服务单段名是保留字：任何别名不得与之相撞。
  for (const code of codes) {
    assert.notEqual(code, "anthropic/auto");
    assert.notEqual(code, "anthropic/my-vm");
  }
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

test("别名反解：同一目录内回环，目录外/双段/未知名一律 null", () => {
  const entries = sampleEntries();
  const view = buildDesktopCatalogView(entries);

  // 回环：目录里换出的别名都反解回真 id。
  for (const [alias, real] of view.aliases) {
    assert.equal(resolveDesktopAlias(alias, entries), real, `${alias} 反解回 ${real}`);
  }

  // 真双段 wire id 永不是别名（别名恒单段）。
  assert.equal(resolveDesktopAlias("anthropic/a6api/kimi-k3", entries), null);
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
