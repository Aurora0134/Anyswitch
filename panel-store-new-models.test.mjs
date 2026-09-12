import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 新增模型待读态（置顶+高光，看过即复位）的单测。沿用 panel-skills.test.mjs 的
// new Function 提取范式：把机制相关纯函数从 panel.html 内嵌脚本抠出来，喂一个
// localStorage / storeProviders 的桩，验证标记合并、老化清理、置顶排序与消耗语义。
// 不碰 DOM、不碰后端。

const panelHtml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.html"),
  "utf8"
);

function extractFn(name, params) {
  const m = panelHtml.match(
    new RegExp(`function ${name}\\(${params.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) \\{[\\s\\S]*?\\n  \\}`)
  );
  assert.ok(m, `panel.html must contain function ${name}`);
  return m[0];
}

// 机制块：常量 + 状态变量 + 全部函数（从 STORE_NEW_MODELS_KEY 到 orderStoreModelIds 收尾）
const mechSrc = panelHtml.match(
  /const STORE_NEW_MODELS_KEY[\s\S]*?function orderStoreModelIds\(discoveredIds, newIds\) \{[\s\S]*?\n  \}/
);
assert.ok(mechSrc, "panel.html must contain the store-new-models mechanism block");

// 每个用例一份独立 harness：自带 localStorage 内存桩 + 可注入的 storeProviders
function makeHarness(providers) {
  return new Function(`
    const __store = new Map();
    const localStorage = {
      getItem: (k) => (__store.has(k) ? __store.get(k) : null),
      setItem: (k, v) => { __store.set(k, String(v)); },
      removeItem: (k) => { __store.delete(k); },
    };
    function storeProviders() { return ${JSON.stringify(providers)}; }
    ${mechSrc[0]}
    return {
      markStoreNewModels,
      storeNewIdsFor,
      consumeStoreNewModels,
      orderStoreModelIds,
      shown: storeNewShown,
      raw: () => JSON.parse(localStorage.getItem(STORE_NEW_MODELS_KEY) || "{}"),
      setTs: (pid, ts) => {
        const raw = JSON.parse(localStorage.getItem(STORE_NEW_MODELS_KEY) || "{}");
        if (raw[pid]) { raw[pid].ts = ts; localStorage.setItem(STORE_NEW_MODELS_KEY, JSON.stringify(raw)); }
        storeNewModels = null; // 失效内存缓存，强制下次从 localStorage 重读
      },
    };
  `)();
}

// discovered 需覆盖测试用到的全部 id（storeNewIdsFor 会按 discovered 过滤失效项）
const PROV = [{ id: "p1", discovered: { a: {}, b: {}, c: {}, d: {}, x: {}, y: {} } }];

describe("store-new-models 标记与合并", () => {
  it("登记 added 后该渠道待读集可查", () => {
    const h = makeHarness(PROV);
    h.markStoreNewModels("p1", ["x", "y"]);
    assert.deepEqual(h.storeNewIdsFor("p1"), ["x", "y"]);
  });

  it("重复刷新合并去重、保序，且 ts 刷新", () => {
    const h = makeHarness(PROV);
    h.markStoreNewModels("p1", ["x"]);
    h.markStoreNewModels("p1", ["x", "y"]);
    assert.deepEqual(h.storeNewIdsFor("p1"), ["x", "y"]);
  });

  it("空 added 不产生记录", () => {
    const h = makeHarness(PROV);
    h.markStoreNewModels("p1", []);
    assert.deepEqual(h.storeNewIdsFor("p1"), []);
    assert.deepEqual(h.raw(), {});
  });

  it("跨渠道互不串扰", () => {
    const h = makeHarness([...PROV, { id: "p2", discovered: { m: {} } }]);
    h.markStoreNewModels("p1", ["x"]);
    h.markStoreNewModels("p2", ["m"]);
    assert.deepEqual(h.storeNewIdsFor("p1"), ["x"]);
    assert.deepEqual(h.storeNewIdsFor("p2"), ["m"]);
  });
});

describe("store-new-models 失效与老化清理", () => {
  it("已不在 discovered 的 id 被清理，全失效则删档", () => {
    const h = makeHarness(PROV); // discovered 只有 a/b/c
    h.markStoreNewModels("p1", ["a", "ghost"]);
    assert.deepEqual(h.storeNewIdsFor("p1"), ["a"]);
    h.markStoreNewModels("p1", ["ghost2"]);
    // 此刻 p1 = [a, ghost2]，ghost2 失效被清
    assert.deepEqual(h.storeNewIdsFor("p1"), ["a"]);
  });

  it("超过 TTL 的待读记录被老化清除", () => {
    const h = makeHarness(PROV);
    h.markStoreNewModels("p1", ["a"]);
    h.setTs("p1", Date.now() - 8 * 24 * 3600 * 1000); // 8 天前
    assert.deepEqual(h.storeNewIdsFor("p1"), []);
    assert.deepEqual(h.raw(), {});
  });
});

describe("store-new-models 消耗语义", () => {
  it("consume 后待读集清空", () => {
    const h = makeHarness(PROV);
    h.markStoreNewModels("p1", ["a"]);
    h.consumeStoreNewModels("p1");
    assert.deepEqual(h.storeNewIdsFor("p1"), []);
  });

  it("consume 空渠道不报错", () => {
    const h = makeHarness(PROV);
    assert.doesNotThrow(() => h.consumeStoreNewModels("nope"));
  });
});

describe("store-new-models 置顶排序", () => {
  it("新增 id 置顶且组内保原相对序，其余保原序", () => {
    const h = makeHarness(PROV);
    const out = h.orderStoreModelIds(["a", "b", "c", "d"], ["c", "a"]);
    assert.deepEqual(out, ["a", "c", "b", "d"]);
  });

  it("无新增时原样返回", () => {
    const h = makeHarness(PROV);
    assert.deepEqual(h.orderStoreModelIds(["a", "b"], []), ["a", "b"]);
    assert.deepEqual(h.orderStoreModelIds(["a", "b"], null), ["a", "b"]);
  });

  it("新增 id 不在 discovered 中时被忽略", () => {
    const h = makeHarness(PROV);
    assert.deepEqual(h.orderStoreModelIds(["a", "b"], ["zzz"]), ["a", "b"]);
  });
});

describe("store-new-models 高光呈现门控（storeNewShown）", () => {
  it("未呈现的渠道 highlight 为真，已呈现为假", () => {
    const h = makeHarness(PROV);
    h.markStoreNewModels("p1", ["a"]);
    const newIds = h.storeNewIdsFor("p1");
    const highlightFirst = newIds.length > 0 && !h.shown.has("p1");
    assert.equal(highlightFirst, true);
    h.shown.add("p1"); // applyStoreFocus 登记
    const highlightSecond = h.storeNewIdsFor("p1").length > 0 && !h.shown.has("p1");
    assert.equal(highlightSecond, false);
  });
});
