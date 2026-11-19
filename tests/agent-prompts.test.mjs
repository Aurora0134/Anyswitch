import test, { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createPromptsService,
  promptsPath,
  UnparseablePromptsError,
} from "../src/agents/agent-prompts.mjs";
import { mkTestDir } from "../test-helpers/tmp.mjs";

// Prompts data plane: every service is rooted at a temp LOCALAPPDATA so the
// real relay data root is never touched.

const tempDirs = [];

function makeService() {
  const dir = mkTestDir("anyswitch-prompts-");
  tempDirs.push(dir);
  const base = { LOCALAPPDATA: dir };
  return { svc: createPromptsService({ base }), file: promptsPath(base), base };
}

afterEach(() => {
  // Windows AV/indexers transiently hold a handle on files a test just wrote
  // (same phenomenon atomic-write.mjs documents for rename), so rmSync here
  // retries like test-helpers/tmp.mjs's exit sweep. A fixture still locked
  // after the retries is best-effort: the process-exit sweep removes it, and
  // a locked fixture must never turn a passing run red.
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // swept later by tmp.mjs's process-exit sweep
    }
  }
});

describe("agent-prompts data plane", () => {
  it("returns the default state when prompts.json is missing", () => {
    const { svc } = makeService();
    assert.deepEqual(svc.getState(), { enabled: false, presetOrder: [], presets: [], endpointOverrides: {} });
  });

  it("creates a preset with a 12-char base64url id and persists it", () => {
    const { svc, base } = makeService();
    const { preset } = svc.createPreset({ title: "规则A", tag: "安全", content: "总是先读文件再修改" });
    assert.match(preset.id, /^[A-Za-z0-9_-]{12}$/);
    assert.equal(preset.enabled, true);
    assert.equal(preset.title, "规则A");
    assert.equal(preset.tag, "安全");
    assert.ok(preset.createdAt);
    assert.equal(preset.createdAt, preset.updatedAt);

    // A fresh service over the same root sees the persisted preset.
    const reloaded = createPromptsService({ base });
    assert.equal(reloaded.getState().presets.length, 1);
    assert.equal(reloaded.getState().presets[0].id, preset.id);
  });

  it("enforces title/tag/content limits with 400 errors", () => {
    const { svc } = makeService();
    // 内容上限的期望值硬编码 32768：上限本身就是产品承诺（超限报错文案把
    // 上限值带给用户），期望值从生产常量生成等于常量漂移时测试跟着漂。
    for (const fields of [
      { title: "", content: "x" },
      { title: "  ", content: "x" },
      { title: "t".repeat(201), content: "x" },
      { title: "ok", tag: "t".repeat(51), content: "x" },
      { title: "ok", content: Buffer.alloc(32768 + 1, 0x61).toString("utf8") },
      { title: "ok" },
    ]) {
      assert.throws(() => svc.createPreset(fields), (err) => err.statusCode === 400, JSON.stringify(fields).slice(0, 60));
    }
    // 超限报错把字节数带给人看，上限值必须在场。
    assert.throws(
      () => svc.createPreset({ title: "ok", content: "a".repeat(32769) }),
      (err) => err.statusCode === 400 && err.message.includes("32768"),
    );
    // Exactly 32KB is accepted.
    const ok = svc.createPreset({ title: "上限内", content: "a".repeat(32768) });
    assert.equal(ok.preset.content.length, 32768);
    assert.equal(svc.getState().presets.length, 1);
  });

  it("updates a preset, bumping updatedAt while keeping id/createdAt", () => {
    const { svc, file, base } = makeService();
    const { preset } = svc.createPreset({ title: "旧", tag: "a", content: "v1" });
    // 把 updatedAt 钉死在过去：这样「更新必须刷新 updatedAt」只有唯一方向可过
    // ——实现若忘了刷新（updatedAt 原值带回），>= 的宽容会把假绿放过去。
    const stale = JSON.parse(readFileSync(file, "utf8"));
    stale.presets[0].updatedAt = "2020-01-01T00:00:00.000Z";
    writeFileSync(file, JSON.stringify(stale), "utf8");
    const { preset: updated } = svc.updatePreset({ id: preset.id, title: "新", tag: "b", content: "v2" });
    assert.equal(updated.id, preset.id);
    assert.equal(updated.title, "新");
    assert.equal(updated.tag, "b");
    assert.equal(updated.content, "v2");
    assert.equal(updated.createdAt, preset.createdAt);
    assert.equal(updated.updatedAt > "2020-01-01T00:00:00.000Z", true, "updatedAt 必须刷新到夹具时间之后");
    // 刷新值要落到盘上：重开服务读回来的就是新值，不是只在返回值里好看。
    assert.equal(
      createPromptsService({ base }).getState().presets[0].updatedAt,
      updated.updatedAt,
    );
    assert.throws(() => svc.updatePreset({ id: "missing-id", title: "x", content: "y" }), (err) => err.statusCode === 404);
  });

  it("deletes a preset and prunes it from every endpoint off list", () => {
    const { svc, file } = makeService();
    const { preset } = svc.createPreset({ title: "A", content: "a" });
    svc.setOverride({ endpointId: "claude", presetId: preset.id, off: true });
    svc.setOverride({ endpointId: "kimi", presetId: preset.id, off: true });
    svc.deletePreset(preset.id);
    const state = svc.getState();
    assert.equal(state.presets.length, 0);
    assert.deepEqual(state.endpointOverrides, {});
    // 读路径 normalizeState 也会把死 id 的 off 项剔掉，内存口径兜得住；落盘
    // 字节才是写路径清理唯一的观察面——写路径剪枝删掉时这里必须变红。
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(raw.endpointOverrides, {}, "删除预设时写路径必须清掉各端点 off 列表");
    assert.throws(() => svc.deletePreset(preset.id), (err) => err.statusCode === 404);
  });

  it("toggles master and per-preset enabled, validating booleans", () => {
    const { svc } = makeService();
    const { preset } = svc.createPreset({ title: "A", content: "a" });

    assert.equal(svc.setMaster(true).enabled, true);
    assert.equal(svc.getState().enabled, true);
    assert.throws(() => svc.setMaster("yes"), (err) => err.statusCode === 400);

    assert.deepEqual(svc.setPresetEnabled({ id: preset.id, enabled: false }), { id: preset.id, enabled: false });
    assert.equal(svc.getState().presets[0].enabled, false);
    assert.throws(() => svc.setPresetEnabled({ id: preset.id, enabled: 1 }), (err) => err.statusCode === 400);
    assert.throws(() => svc.setPresetEnabled({ id: "missing", enabled: true }), (err) => err.statusCode === 404);
  });

  it("normalizes overrides: dedupe, empty off list drops the endpoint key", () => {
    const { svc, file } = makeService();
    const { preset } = svc.createPreset({ title: "A", content: "a" });
    svc.setOverride({ endpointId: "claude", presetId: preset.id, off: true });
    svc.setOverride({ endpointId: "claude", presetId: preset.id, off: true });
    assert.deepEqual(svc.getState().endpointOverrides, { claude: { off: [preset.id] } });

    svc.setOverride({ endpointId: "claude", presetId: preset.id, off: false });
    assert.deepEqual(svc.getState().endpointOverrides, {});
    // 空 off 列表摘键是写路径职责（setOverride 里 delete），读路径 normalizeState
    // 只是兜底：落盘文件里不得残留空键。
    const rawAfterClear = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(rawAfterClear.endpointOverrides, {}, "空 off 列表在写路径就摘键，不靠读路径兜底");

    assert.throws(() => svc.setOverride({ endpointId: "claude", presetId: "missing", off: true }), (err) => err.statusCode === 404);
    assert.throws(() => svc.setOverride({ endpointId: "claude", presetId: preset.id, off: "true" }), (err) => err.statusCode === 400);
  });

  it("resolveForEndpoint applies master AND preset.enabled AND off overrides", () => {
    const { svc } = makeService();
    const a = svc.createPreset({ title: "A", content: "a" }).preset;
    const b = svc.createPreset({ title: "B", content: "b" }).preset;
    const c = svc.createPreset({ title: "C", content: "c" }).preset;

    // Master off: nothing resolves anywhere.
    assert.deepEqual(svc.resolveForEndpoint("claude"), []);

    svc.setMaster(true);
    assert.deepEqual(svc.resolveForEndpoint("claude").map((p) => p.id), [a.id, b.id, c.id]);

    svc.setPresetEnabled({ id: b.id, enabled: false });
    svc.setOverride({ endpointId: "claude", presetId: c.id, off: true });
    assert.deepEqual(svc.resolveForEndpoint("claude").map((p) => p.id), [a.id]);
    // kimi has no override for c; b stays off for everyone.
    assert.deepEqual(svc.resolveForEndpoint("kimi").map((p) => p.id), [a.id, c.id]);
  });

  it("keeps creation order in presetOrder and drops reordered ids on delete", () => {
    const { svc, base } = makeService();
    const a = svc.createPreset({ title: "A", content: "a" }).preset;
    const b = svc.createPreset({ title: "B", content: "b" }).preset;
    const c = svc.createPreset({ title: "C", content: "c" }).preset;
    assert.deepEqual(svc.getState().presetOrder, [a.id, b.id, c.id]);

    svc.deletePreset(a.id);
    assert.deepEqual(svc.getState().presetOrder, [b.id, c.id]);
    assert.deepEqual(createPromptsService({ base }).getState().presetOrder, [b.id, c.id]);
  });

  it("reorderPresets moves a preset and drives both the panel list and the injection order", () => {
    const { svc } = makeService();
    const a = svc.createPreset({ title: "A", content: "a" }).preset;
    const b = svc.createPreset({ title: "B", content: "b" }).preset;
    const c = svc.createPreset({ title: "C", content: "c" }).preset;
    svc.setMaster(true);

    const result = svc.reorderPresets([c.id, a.id, b.id]);
    assert.deepEqual(result.presetOrder, [c.id, a.id, b.id]);
    assert.deepEqual(svc.getState().presetOrder, [c.id, a.id, b.id]);
    assert.deepEqual(svc.getState().presets.map((p) => p.id), [c.id, a.id, b.id]);
    // 托管块里的正文顺序跟着走：排序不是纯展示层的排序
    assert.deepEqual(svc.resolveForEndpoint("claude").map((p) => p.id), [c.id, a.id, b.id]);
  });

  it("reorderPresets rejects partial, duplicated, unknown and non-array orders", () => {
    const { svc } = makeService();
    const a = svc.createPreset({ title: "A", content: "a" }).preset;
    const b = svc.createPreset({ title: "B", content: "b" }).preset;
    const bad = (order) =>
      assert.throws(() => svc.reorderPresets(order), (err) => err.statusCode === 400);
    bad([a.id]);                    // 少了 b：部分排列会让未列出的预设无家可归
    bad([a.id, a.id]);              // 重复
    bad([a.id, "ghost"]);           // 不存在的 id
    bad([a.id, b.id, a.id]);
    bad("not an array");
    bad([a.id, 42]);
    // 拒绝后顺序不变：失败的拖拽不该半途落盘
    assert.deepEqual(svc.getState().presetOrder, [a.id, b.id]);
  });

  it("an order written by an older build (or lost ids) is completed instead of shuffled", () => {
    const { svc, file } = makeService();
    const a = svc.createPreset({ title: "A", content: "a" }).preset;
    const b = svc.createPreset({ title: "B", content: "b" }).preset;
    const c = svc.createPreset({ title: "C", content: "c" }).preset;
    const raw = JSON.parse(readFileSync(file, "utf8"));

    // 老版本写的文件：压根没有 presetOrder —— 回落到文件序，不重排
    delete raw.presetOrder;
    writeFileSync(file, JSON.stringify(raw), "utf8");
    assert.deepEqual(svc.getState().presetOrder, [a.id, b.id, c.id]);
    assert.deepEqual(svc.getState().presets.map((p) => p.id), [a.id, b.id, c.id]);

    // 并发写坏的顺序：未知 id 与重复项剔掉，漏掉的补到末尾
    raw.presetOrder = [c.id, "ghost", c.id];
    writeFileSync(file, JSON.stringify(raw), "utf8");
    assert.deepEqual(svc.getState().presetOrder, [c.id, a.id, b.id]);
  });

  it("read path degrades to defaults on a corrupt prompts.json", () => {
    const { svc, file } = makeService();
    svc.createPreset({ title: "A", content: "a" });
    writeFileSync(file, "{ not json !!!", "utf8");
    assert.deepEqual(svc.getState(), { enabled: false, presetOrder: [], presets: [], endpointOverrides: {} });
  });

  it("write path quarantines a corrupt prompts.json and refuses to overwrite it", () => {
    const { svc, file } = makeService();
    // Seed a corrupt file (the service itself creates the dir on first save).
    svc.setMaster(true);
    writeFileSync(file, "{ not json !!!", "utf8");
    assert.throws(() => svc.setMaster(false), (err) => err instanceof UnparseablePromptsError);
    // Original bytes are intact and a .corrupt-<ts> copy sits next to it.
    assert.equal(readFileSync(file, "utf8"), "{ not json !!!");
    const siblings = readdirSync(join(file, ".."));
    assert.ok(siblings.some((name) => name.startsWith("prompts.json.corrupt-")), siblings.join(","));
    assert.equal(existsSync(file), true);
  });
});

