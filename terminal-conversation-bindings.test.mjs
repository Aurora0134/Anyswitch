import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RESUMABLE_AGENTS,
  bindingFromMeta,
  createBindingStore,
  pickConversationMeta,
  pickRefreshedMeta,
  resumeArgsFor,
} from "./terminal-conversation-bindings.mjs";

// 绑定存储与匹配的纯数据层合同：文件形态（version+bindings、原子写）、读写
// 回环、畸形条目清洗；匹配纪律（同 agent 同 cwd、生命周期重叠、最新活跃胜
// 出、并列判不出）；六家续会参数拼法。
describe("terminal-conversation-bindings", () => {
  function mkStore() {
    const dir = mkdtempSync(join(tmpdir(), "anyswitch-tcb-"));
    return { dir, store: createBindingStore({ file: join(dir, "terminal-conversation-bindings.json") }) };
  }

  const binding = (over = {}) => ({
    agentId: "kimi",
    cwd: "C:\\work\\proj",
    conversationId: "conv-1",
    file: null,
    boundAt: 1729000000000,
    source: "bound",
    ...over,
  });

  describe("binding store", () => {
    it("set/get/delete round-trips and persists across instances", () => {
      const { dir, store } = mkStore();
      try {
        assert.equal(store.get("sess-1"), null);
        store.set("sess-1", binding());
        assert.equal(store.get("sess-1").conversationId, "conv-1");

        const reread = createBindingStore({ file: join(dir, "terminal-conversation-bindings.json") });
        assert.deepEqual(reread.get("sess-1"), binding(), "另一个实例能从盘上读回同一条绑定");

        assert.equal(store.delete("sess-1"), true);
        assert.equal(store.get("sess-1"), null);
        assert.equal(store.delete("sess-1"), false, "删不存在的键是 no-op");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("on-disk shape is { version: 1, bindings } and rejects invalid bindings", () => {
      const { dir, store } = mkStore();
      try {
        store.set("sess-1", binding({ file: "C:\\archives\\conv-1.jsonl" }));
        const raw = JSON.parse(readFileSync(join(dir, "terminal-conversation-bindings.json"), "utf8"));
        assert.equal(raw.version, 1);
        assert.equal(raw.bindings["sess-1"].conversationId, "conv-1");
        assert.equal(raw.bindings["sess-1"].file, "C:\\archives\\conv-1.jsonl");

        assert.throws(() => store.set("sess-2", { agentId: "kimi" }), TypeError);
        assert.equal(store.get("sess-2"), null, "非法绑定不落盘");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("missing or corrupt file starts empty; malformed entries are dropped on load", () => {
      const { dir, store } = mkStore();
      try {
        assert.equal(store.size, 0, "没有文件就是空库");
        writeFileSync(join(dir, "terminal-conversation-bindings.json"), "not json {");
        const corrupt = createBindingStore({ file: join(dir, "terminal-conversation-bindings.json") });
        assert.equal(corrupt.size, 0, "损坏文件从空开始");

        writeFileSync(
          join(dir, "terminal-conversation-bindings.json"),
          JSON.stringify({
            version: 1,
            bindings: {
              good: binding(),
              bad: { agentId: 42 },
              alsoBad: { ...binding(), source: "elsewhere" },
            },
          }),
        );
        const mixed = createBindingStore({ file: join(dir, "terminal-conversation-bindings.json") });
        assert.equal(mixed.size, 1);
        assert.equal(mixed.get("good").conversationId, "conv-1");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("prune drops bindings whose session is gone and keeps the rest", () => {
      const { dir, store } = mkStore();
      try {
        store.set("sess-1", binding());
        store.set("sess-2", binding({ conversationId: "conv-2" }));
        assert.equal(store.prune(new Set(["sess-2"])), true);
        assert.equal(store.get("sess-1"), null);
        assert.equal(store.get("sess-2").conversationId, "conv-2");
        assert.equal(store.prune(new Set(["sess-2"])), false, "无变化不重写");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("resumeArgsFor", () => {
    const b = binding({ conversationId: "abc-123", file: "C:\\archives\\rollout.jsonl" });

    it("builds each covered agent's documented resume form", () => {
      assert.deepEqual(resumeArgsFor("claude", b), ["--resume", "abc-123"]);
      assert.deepEqual(resumeArgsFor("kimi", b), ["--session", "abc-123"]);
      assert.deepEqual(resumeArgsFor("grok", b), ["--resume", "abc-123"]);
      assert.deepEqual(resumeArgsFor("opencode", b), ["--session", "abc-123"]);
      assert.deepEqual(resumeArgsFor("codex", b), ["resume", "abc-123"], "codex 是子命令形态");
      assert.deepEqual(resumeArgsFor("pi", b), ["--session", "C:\\archives\\rollout.jsonl"], "pi 认存档文件路径");
    });

    it("returns null for unsupported agents and unusable bindings", () => {
      assert.equal(resumeArgsFor("qoder", b), null);
      assert.equal(resumeArgsFor("zcode", b), null);
      assert.equal(resumeArgsFor("dsh", b), null);
      assert.equal(resumeArgsFor("claude", null), null);
      assert.equal(resumeArgsFor("claude", binding({ conversationId: "" })), null);
      assert.equal(resumeArgsFor("pi", binding({ file: null })), null, "pi 没有 file 接不出");
    });

    it("RESUMABLE_AGENTS matches exactly the six covered endpoints", () => {
      assert.deepEqual([...RESUMABLE_AGENTS].sort(), ["claude", "codex", "grok", "kimi", "opencode", "pi"]);
    });
  });

  describe("pickConversationMeta", () => {
    const meta = (id, over = {}) => ({
      endpoint: "kimi",
      id,
      project: "C:\\work\\proj",
      file: `C:\\archives\\${id}`,
      createdAt: 1000,
      lastActive: 2000,
      ...over,
    });
    const window = { agentId: "kimi", cwd: "c:/work/proj/", createdAt: 500, lastActiveAt: 3000 };

    it("matches case/separator-insensitively on cwd and picks the latest-active overlap", () => {
      const older = meta("old", { createdAt: 600, lastActive: 1500 });
      const newer = meta("new", { createdAt: 2500, lastActive: 2900 });
      assert.equal(pickConversationMeta([older, newer], window).id, "new");
    });

    it("returns null when nothing overlaps the session lifecycle", () => {
      const before = meta("before", { createdAt: 100, lastActive: 400 });
      const after = meta("after", { createdAt: 3100, lastActive: 3200 });
      assert.equal(pickConversationMeta([before, after], window), null, "死在窗口两端的都不算");
    });

    it("treats a null createdAt (kimi index) as a point window at lastActive", () => {
      const point = meta("point", { createdAt: null, lastActive: 1500 });
      assert.equal(pickConversationMeta([point], window).id, "point");
      const stale = meta("stale", { createdAt: null, lastActive: 400 });
      assert.equal(pickConversationMeta([stale], window), null);
    });

    it("returns null on an exact lastActive tie between different conversations", () => {
      const a = meta("a", { lastActive: 2000 });
      const b = meta("b", { lastActive: 2000 });
      assert.equal(pickConversationMeta([a, b], window), null, "判不出就放弃——宁可不接");
    });

    it("rejects wrong agent, wrong cwd, and desktop-originated codex sessions", () => {
      assert.equal(pickConversationMeta([meta("x", { endpoint: "claude" })], window), null);
      assert.equal(pickConversationMeta([meta("x", { project: "C:\\other" })], window), null);
      assert.equal(pickConversationMeta([meta("x")], { ...window, cwd: "" }), null, "会话 cwd 未知不匹配");
      const codex = meta("cx", { endpoint: "codex", originator: "codex_work_desktop" });
      assert.equal(pickConversationMeta([codex], { ...window, agentId: "codex" }), null, "桌面端会话不抢终端匹配");
      const cli = meta("cx", { endpoint: "codex", originator: "codex-tui" });
      assert.equal(pickConversationMeta([cli], { ...window, agentId: "codex" }).id, "cx");
    });

    it("open-ended window (running session) admits anything active since creation", () => {
      const later = meta("later", { createdAt: 5000, lastActive: 9000 });
      assert.equal(pickConversationMeta([later], { ...window, lastActiveAt: null }).id, "later");
    });
  });

  describe("pickRefreshedMeta", () => {
    const meta = (id, lastActive, over = {}) => ({
      endpoint: "kimi", id, project: "C:\\work\\proj", file: `f:${id}`, createdAt: null, lastActive, ...over,
    });
    const scope = { agentId: "kimi", cwd: "C:\\work\\proj", sinceMs: 10_000 };

    it("returns the single archive active since the revive", () => {
      assert.equal(pickRefreshedMeta([meta("old", 500), meta("new", 12_000)], scope).id, "new");
    });

    it("returns null on zero or multiple active archives", () => {
      assert.equal(pickRefreshedMeta([meta("old", 500)], scope), null, "agent 还没落笔");
      assert.equal(pickRefreshedMeta([meta("a", 11_000), meta("b", 12_000)], scope), null, "多条活跃判不出");
    });

    it("same id twice (or the bound archive itself) stays a confirmation, not a rebind", () => {
      assert.equal(pickRefreshedMeta([meta("same", 12_000)], scope).id, "same");
    });
  });

  describe("bindingFromMeta", () => {
    it("carries id and file, stamps boundAt, and nulls a missing file", () => {
      const b = bindingFromMeta(
        { id: "conv-9", file: "C:\\archives\\conv-9.jsonl" },
        { agentId: "claude", cwd: "C:\\work\\proj" },
        "scanned",
      );
      assert.equal(b.conversationId, "conv-9");
      assert.equal(b.file, "C:\\archives\\conv-9.jsonl");
      assert.equal(b.source, "scanned");
      assert.equal(typeof b.boundAt, "number");
      assert.equal(bindingFromMeta({ id: "c", file: "" }, { agentId: "kimi", cwd: "w" }, "bound").file, null);
    });
  });
});
