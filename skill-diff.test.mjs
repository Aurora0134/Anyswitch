import assert from "node:assert/strict";
import test from "node:test";
import { diffFileText, splitLines } from "./skill-diff.mjs";

// 行级左右对照引擎（skill-diff.mjs）的契约：
//   每行自带两侧行号；删除行只有左栏有内容、插入行只有右栏有内容；
//   一段连续改动里的删与插按位置配成 mod（两栏同行并列）；
//   未改动的长段落折成一条 gap；中段规模超上限标 oversize 而不是硬算。
// 纯函数、不碰磁盘，全部用合成输入。

const L = (...lines) => lines.join("\n") + "\n";

test("改一行：只有那一行是 mod，两侧行号各自对齐", () => {
  const a = L("one", "two", "three");
  const b = L("one", "TWO", "three");
  const r = diffFileText(a, b);
  assert.equal(r.state, "diff");
  assert.equal(r.changed, 1);
  assert.deepEqual(r.rows.map((x) => x.op), ["equal", "mod", "equal"]);
  assert.deepEqual(
    r.rows.map((x) => [x.aNo, x.bNo]),
    [[1, 1], [2, 2], [3, 3]],
  );
  assert.equal(r.rows[1].aText, "two");
  assert.equal(r.rows[1].bText, "TWO");
});

test("插入一行：ins 行只有右栏有内容，左栏行号留空", () => {
  const r = diffFileText(L("a", "b"), L("a", "new", "b"));
  const ins = r.rows.find((x) => x.op === "ins");
  assert.ok(ins, "应有一条 ins");
  assert.equal(ins.aNo, null);
  assert.equal(ins.aText, null);
  assert.equal(ins.bNo, 2);
  assert.equal(ins.bText, "new");
  // ins 之后两侧行号重新对齐：右栏比左栏多走一格
  const last = r.rows[r.rows.length - 1];
  assert.equal(last.aNo, 2);
  assert.equal(last.bNo, 3);
  assert.equal(r.added, 1);
  assert.equal(r.removed, 0);
});

test("删除一行：del 行只有左栏有内容", () => {
  const r = diffFileText(L("a", "gone", "b"), L("a", "b"));
  const del = r.rows.find((x) => x.op === "del");
  assert.equal(del.bNo, null);
  assert.equal(del.bText, null);
  assert.equal(del.aText, "gone");
  assert.equal(r.removed, 1);
  assert.equal(r.added, 0);
});

test("两侧各改两行且位置相邻：配成两条 mod，不留单独的 del/ins", () => {
  const r = diffFileText(L("k1", "a1", "a2", "k2"), L("k1", "b1", "b2", "k2"));
  assert.deepEqual(r.rows.map((x) => x.op), ["equal", "mod", "mod", "equal"]);
});

test("改动数不对称时多出来的一侧落成单独的行", () => {
  // 左 1 行改成右 3 行：1 条 mod + 2 条 ins
  const r = diffFileText(L("k", "x", "k2"), L("k", "y1", "y2", "y3", "k2"));
  assert.deepEqual(r.rows.map((x) => x.op), ["equal", "mod", "ins", "ins", "equal"]);
});

test("长未改动段折成 gap，只留改动行上下各 3 行；两头折掉的部分也要出 gap", () => {
  const a = Array.from({ length: 40 }, (_, i) => `x${i}`);
  const b = a.map((s, i) => (i === 20 ? "CHANGED" : s));
  const r = diffFileText(L(...a), L(...b));
  const gaps = r.rows.filter((x) => x.op === "gap");
  assert.deepEqual(gaps.map((g) => g.hidden), [17, 16], "第 18 行之前与第 24 行之后各折一段");
  assert.ok(r.rows.filter((x) => x.op !== "gap").length <= 8, "可见行受上下文控制");
  // 折叠不吞行号：改动行仍是第 21 行
  assert.equal(r.rows.find((x) => x.op === "mod").aNo, 21);
});

test("改动在文件开头与结尾：只折中间，不留假 gap", () => {
  const a = Array.from({ length: 30 }, (_, i) => `x${i}`);
  const b = a.map((s, i) => (i === 0 || i === 29 ? "CHANGED" : s));
  const r = diffFileText(L(...a), L(...b));
  assert.deepEqual(r.rows.filter((x) => x.op === "gap").map((g) => g.hidden), [22]);
  assert.equal(r.rows[0].op, "mod");
  assert.equal(r.rows[r.rows.length - 1].op, "mod");
});

test("两侧完全一致：state=same、零行", () => {
  const r = diffFileText(L("a", "b"), L("a", "b"));
  assert.equal(r.state, "same");
  assert.deepEqual(r.rows, []);
  assert.equal(r.changed, 0);
});

test("仅换行符风格不同（CRLF vs LF）也算一致，不报成整文件改动", () => {
  const r = diffFileText("a\r\nb\r\n", "a\nb\n");
  assert.equal(r.state, "same");
});

test("末尾换行有无不产生假差异", () => {
  assert.equal(diffFileText("a\nb", "a\nb\n").state, "same");
});

test("空文本：零行，两侧都空即 same", () => {
  assert.deepEqual(splitLines(""), []);
  assert.equal(diffFileText("", "").state, "same");
  const r = diffFileText("", "a\n");
  assert.equal(r.state, "diff");
  assert.equal(r.rows.filter((x) => x.op === "ins").length, 1);
});

test("中段规模超上限：state=oversize，不返回半截差异", () => {
  const a = Array.from({ length: 300 }, (_, i) => `p${i}`).join("\n");
  const b = Array.from({ length: 300 }, (_, i) => `q${i}`).join("\n");
  const r = diffFileText(a, b, { maxCells: 100 });
  assert.equal(r.state, "oversize");
  assert.deepEqual(r.rows, []);
  assert.equal(r.aLines, 300);
  assert.equal(r.bLines, 300);
});

test("上下文行数可配：context=0 时只留改动行", () => {
  const a = L("k1", "k2", "x", "k3", "k4");
  const b = L("k1", "k2", "Y", "k3", "k4");
  const ops = diffFileText(a, b, { context: 0 }).rows.map((r) => r.op);
  assert.deepEqual(ops.filter((o) => o !== "gap"), ["mod"]);
});
