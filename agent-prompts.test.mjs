import test, { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPromptsService,
  promptsPath,
  UnparseablePromptsError,
  MAX_CONTENT_BYTES,
} from "./agent-prompts.mjs";

// Prompts data plane: every service is rooted at a temp LOCALAPPDATA so the
// real relay data root is never touched.

const tempDirs = [];

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "anyswitch-prompts-"));
  tempDirs.push(dir);
  const base = { LOCALAPPDATA: dir };
  return { svc: createPromptsService({ base }), file: promptsPath(base), base };
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
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
    for (const fields of [
      { title: "", content: "x" },
      { title: "  ", content: "x" },
      { title: "t".repeat(201), content: "x" },
      { title: "ok", tag: "t".repeat(51), content: "x" },
      { title: "ok", content: Buffer.alloc(MAX_CONTENT_BYTES + 1, 0x61).toString("utf8") },
      { title: "ok" },
    ]) {
      assert.throws(() => svc.createPreset(fields), (err) => err.statusCode === 400, JSON.stringify(fields).slice(0, 60));
    }
    // Exactly 32KB is accepted.
    const ok = svc.createPreset({ title: "上限内", content: "a".repeat(MAX_CONTENT_BYTES) });
    assert.equal(ok.preset.content.length, MAX_CONTENT_BYTES);
    assert.equal(svc.getState().presets.length, 1);
  });

  it("updates a preset, bumping updatedAt while keeping id/createdAt", () => {
    const { svc } = makeService();
    const { preset } = svc.createPreset({ title: "旧", tag: "a", content: "v1" });
    const { preset: updated } = svc.updatePreset({ id: preset.id, title: "新", tag: "b", content: "v2" });
    assert.equal(updated.id, preset.id);
    assert.equal(updated.title, "新");
    assert.equal(updated.tag, "b");
    assert.equal(updated.content, "v2");
    assert.equal(updated.createdAt, preset.createdAt);
    assert.ok(updated.updatedAt >= preset.updatedAt);
    assert.throws(() => svc.updatePreset({ id: "missing-id", title: "x", content: "y" }), (err) => err.statusCode === 404);
  });

  it("deletes a preset and prunes it from every endpoint off list", () => {
    const { svc } = makeService();
    const { preset } = svc.createPreset({ title: "A", content: "a" });
    svc.setOverride({ endpointId: "claude", presetId: preset.id, off: true });
    svc.setOverride({ endpointId: "kimi", presetId: preset.id, off: true });
    svc.deletePreset(preset.id);
    const state = svc.getState();
    assert.equal(state.presets.length, 0);
    assert.deepEqual(state.endpointOverrides, {});
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
    const { svc } = makeService();
    const { preset } = svc.createPreset({ title: "A", content: "a" });
    svc.setOverride({ endpointId: "claude", presetId: preset.id, off: true });
    svc.setOverride({ endpointId: "claude", presetId: preset.id, off: true });
    assert.deepEqual(svc.getState().endpointOverrides, { claude: { off: [preset.id] } });

    svc.setOverride({ endpointId: "claude", presetId: preset.id, off: false });
    assert.deepEqual(svc.getState().endpointOverrides, {});

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

