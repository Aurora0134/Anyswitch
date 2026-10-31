import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 新增模型待读态（置顶+高光，看过即复位）的单测。沿用 panel-skills.test.mjs 的
// new Function 提取范式：把机制相关纯函数从 panel.js（面板主脚本）抠出来，喂一个
// localStorage / storeProviders 的桩，验证标记合并、老化清理、置顶排序与消耗语义。
// 不碰 DOM、不碰后端。

const panelJs = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "panel-ui", "panel.js"),
  "utf8"
);

// 机制块：常量 + 状态变量 + 全部函数（从 STORE_NEW_MODELS_KEY 到 orderStoreModelIds 收尾）
const mechSrc = panelJs.match(
  /const STORE_NEW_MODELS_KEY[\s\S]*?function orderStoreModelIds\(discoveredIds, newIds\) \{[\s\S]*?\n  \}/
);
assert.ok(mechSrc, "panel.js must contain the store-new-models mechanism block");

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
      raw: () => JSON.parse(localStorage.getItem(STORE_NEW_MODELS_KEY) || "{}"),
      rawStr: () => localStorage.getItem(STORE_NEW_MODELS_KEY), // null = 从未落盘（区别于 "{}"）
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
    const staleTs = Date.now() - 60_000; // 把 ts 拨回过去，制造可观测的「未刷新」基准
    h.setTs("p1", staleTs);
    h.markStoreNewModels("p1", ["x", "y"]); // 重复登记 x 应去重，y 追加
    assert.deepEqual(h.storeNewIdsFor("p1"), ["x", "y"]);
    // panel.js markStoreNewModels 末尾以 { ids, ts: Date.now() } 整体重写该渠道条目：
    // ts 必须存在且晚于拨回的旧值，否则老化和 TTL 判定都会失真
    const ts = h.raw().p1.ts;
    assert.ok(Number.isFinite(ts), "重新登记后必须存在数字 ts");
    assert.ok(ts > staleTs, "重新登记必须把 ts 刷新到晚于登记前的旧值");
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
  it("已不在 discovered 的 id 被清理，有效项回写保留", () => {
    const h = makeHarness(PROV); // discovered: a/b/c/d/x/y（ghost、ghost2 均未发现）
    h.markStoreNewModels("p1", ["a", "ghost"]);
    assert.deepEqual(h.storeNewIdsFor("p1"), ["a"]); // ghost 失效被清
    h.markStoreNewModels("p1", ["ghost2"]);
    // 此刻 p1 = [a, ghost2]，ghost2 失效被清
    assert.deepEqual(h.storeNewIdsFor("p1"), ["a"]);
    // 部分清理走「有剩余有效项 → 回写」分支，不能整条删档
    assert.deepEqual(h.raw().p1.ids, ["a"]);
  });

  it("全部失效则删档", () => {
    const h = makeHarness(PROV);
    h.markStoreNewModels("p1", ["ghost", "ghost2"]); // 均不在 discovered
    assert.deepEqual(h.storeNewIdsFor("p1"), []);
    // 全失效走 else 分支整条删档，不残留 { ids: [], ts } 空壳
    assert.deepEqual(h.raw(), {});
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

  it("consume 空渠道不报错，且不发生落盘", () => {
    const h = makeHarness(PROV);
    assert.doesNotThrow(() => h.consumeStoreNewModels("nope"));
    // panel.js consumeStoreNewModels 由 if (map[providerId]) 守卫：key 不存在时
    // 连 saveStoreNewModels 都不该调——落盘与否只有看原始字符串才区分得出来
    assert.equal(h.rawStr(), null);
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
