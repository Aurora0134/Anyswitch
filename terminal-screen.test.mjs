import test from "node:test";
import assert from "node:assert/strict";
import { createScreenMirror, terminalCharWidth } from "./terminal-screen.mjs";

// 把镜像吐出的回放再喂给一个干净的镜像（就是浏览器 xterm 的等价物），
// 用来断言「回放自足」：不依赖任何前序状态就能得到同一张画面。
function repaint(replay, cols, rows) {
  const mirror = createScreenMirror({ cols, rows });
  mirror.write(replay);
  return mirror;
}
const lastTextRow = (mirror) => {
  const lines = mirror.screenLines();
  for (let r = lines.length - 1; r >= 0; r -= 1) if (lines[r].trim() !== "") return r + 1;
  return 0;
};
const bottomBlanks = (mirror) => mirror.info().rows - lastTextRow(mirror);

// 一帧底部锚定的 TUI 重绘：回到帧顶、逐行擦重写、再走回输入行。
function tuiFrame(index, height = 22) {
  let out = "\u001b[?2026h\u001b[" + height + "A";
  for (let line = 0; line < height; line += 1) {
    out += `\r\u001b[2K\u001b[38;2;79;168;255m帧 ${index} 第 ${line} 行\u001b[0m ${"z".repeat(12)}\r\n`;
  }
  out += `\u001b[${height - 6}B\u001b[6G\u001b[?2026l`;
  return out;
}

test("行型输出：滚动区有历史、画面钉在底部、回放自足", () => {
  const mirror = createScreenMirror({ cols: 80, rows: 24 });
  for (let i = 1; i <= 200; i += 1) mirror.write(`输出行 ${i} ${"x".repeat(30)}\r\n`);
  const info = mirror.info();
  assert.equal(info.rows, 24);
  assert.ok(lastTextRow(mirror) >= 23, `最后一行应有内容，实得第 ${lastTextRow(mirror)} 行`);
  assert.equal(bottomBlanks(mirror), 1, "底栏只允许光标所在那一行的空白");
  assert.ok(info.historyLines > 150, `滚动区应有历史，实得 ${info.historyLines} 行`);

  const again = repaint(mirror.toReplay(), 80, 24);
  assert.deepEqual(again.screenLines(), mirror.screenLines(), "回放必须还原同一张画面");
  assert.equal(again.info().historyLines, mirror.info().historyLines,
    "滚动区必须逐行还原——这就是「刷新后读不到视窗之上内容」的那一条");
});

test("重绘型 TUI：回放后不浮空、历史不随重绘丢失", () => {
  const mirror = createScreenMirror({ cols: 181, rows: 46 });
  for (let i = 1; i <= 300; i += 1) mirror.write(`历史行 ${i} ${"y".repeat(50)}\r\n`);
  for (let f = 0; f < 120; f += 1) mirror.write(tuiFrame(f));

  assert.ok(lastTextRow(mirror) >= 40, `画面必须落在底部区，实得第 ${lastTextRow(mirror)}/46 行`);
  assert.ok(bottomBlanks(mirror) <= 6, `浮空不得超过几行，实得底部空白 ${bottomBlanks(mirror)} 行`);
  assert.ok(mirror.info().historyLines > 250, "TUI 的历史行必须留在滚动区，不被重绘挤掉");

  const replay = mirror.toReplay();
  const again = repaint(replay, 181, 46);
  assert.deepEqual(again.screenLines(), mirror.screenLines(), "同一份回放喂进干净终端必须得到同一屏");
  assert.ok(bottomBlanks(again) <= 6, "回放侧同样不得浮空——这正是「每刷一次上移一段」的那条");
  assert.equal(again.info().historyLines, mirror.info().historyLines, "回放后向上滚回的历史必须逐行等价");
});

test("回放与裁点无关：任何客户端起点都还原同一屏", () => {
  const mirror = createScreenMirror({ cols: 100, rows: 20 });
  for (let i = 1; i <= 40; i += 1) mirror.write(`行 ${i}\r\n`);
  for (let f = 0; f < 30; f += 1) mirror.write(tuiFrame(f, 12));
  const replay = mirror.toReplay();
  // 干净终端、脏终端、被别的会话脏过的终端：同一份回放必须收敛到同一屏
  const clean = repaint(replay, 100, 20);
  const dirty = createScreenMirror({ cols: 100, rows: 20 });
  dirty.write("\u001b[3;4H残留内容\u001b[10;20H更多残留");
  dirty.write(replay);
  const half = createScreenMirror({ cols: 100, rows: 20 });
  half.write(tuiFrame(999, 12));
  half.write(replay);
  assert.deepEqual(dirty.screenLines(), clean.screenLines(), "脏起点不得改变回放结果");
  assert.deepEqual(half.screenLines(), clean.screenLines(), "起点有一帧残留也不得改变回放结果");
});

test("备用屏（vim/htop 类）不污染历史，退出后主屏复原", () => {
  const mirror = createScreenMirror({ cols: 60, rows: 12 });
  for (let i = 1; i <= 8; i += 1) mirror.write(`主屏行 ${i}\r\n`);
  const before = mirror.screenLines().join("|");
  const historyBefore = mirror.info().historyLines;
  mirror.write("\u001b[?1049h");
  for (let i = 1; i <= 30; i += 1) mirror.write(`备用屏内容 ${i}\r\n`);
  assert.equal(mirror.info().historyLines, historyBefore, "备用屏期间的滚动不得进滚动区");
  mirror.write("\u001b[?1049l");
  assert.deepEqual(mirror.screenLines(), before.split("|"), "退出备用屏必须复原主屏");
});

test("SGR 与宽字符：颜色随回放保留，中日韩字不切碎行", () => {
  const mirror = createScreenMirror({ cols: 20, rows: 4 });
  mirror.write("\u001b[1;38;2;255;0;0m红色粗体\u001b[0m 普通\r\n");
  const replay = mirror.toReplay();
  assert.ok(/38;2;255;0;0/.test(replay), "真彩色 token 必须进回放");
  assert.ok(/\[1;/.test(replay) || /;1m/.test(replay) || /\[1;38/.test(replay), "粗体 token 必须进回放");
  const again = repaint(replay, 20, 4);
  assert.equal(again.screenLines()[0].trim(), "红色粗体 普通", "宽字符回放后列位不能错位");
  assert.equal(terminalCharWidth("红"), 2);
  assert.equal(terminalCharWidth("a"), 1);
});

test("铺满一行的色块和字后面的色块，重画后还在", () => {
  const mirror = createScreenMirror({ cols: 20, rows: 4 });
  mirror.write(`\u001b[48;5;236m${" ".repeat(20)}\u001b[0m\r\n`);
  mirror.write(`\u001b[0mModels\u001b[48;5;236m${" ".repeat(14)}\u001b[0m`);
  const again = repaint(mirror.toReplay(), 20, 4);
  const rows = again.screenAttrs();
  assert.equal(rows[0].every((cell) => cell.bg === "48;5;236"), true, "整行色块重画后必须铺满");
  assert.equal(rows[1].slice(0, 6).every((cell) => cell.bg === ""), true, "文字本身不该被染上后面的色块");
  assert.equal(rows[1].slice(6).every((cell) => cell.bg === "48;5;236"), true, "字后面的色块必须画到行尾");
});

test("resize 保留画面与历史，畸形/未知序列吞掉且不影响后续", () => {
  const mirror = createScreenMirror({ cols: 40, rows: 10 });
  for (let i = 1; i <= 25; i += 1) mirror.write(`行 ${i}\r\n`);
  mirror.resize(60, 14);
  assert.equal(mirror.info().cols, 60);
  assert.equal(mirror.info().rows, 14);
  assert.ok(mirror.info().historyLines > 5, "改尺寸不得清空滚动区");
  assert.doesNotThrow(() => {
    mirror.write("\u001b[\u001b\u001b]0;标题\u0007\u001bP?q\u001b\\\u001b[?9;9;9h\u001b[>1u\u001b[<x\u001b[1;2$}");
    mirror.write("\u001b[3;3H锚点\r\n");
  });
  assert.equal(mirror.toReplay().length > 0, true, "吐完垃圾仍要能出回放");
});

test("纯背景行不算空行：只刷背景色的行也进回放", () => {
  const mirror = createScreenMirror({ cols: 10, rows: 4 });
  mirror.write("\u001b[2;1H\u001b[48;5;240m     \u001b[0m");
  const replay = mirror.toReplay();
  assert.ok(replay.includes("48;5;240"), "纯背景行的背景属性必须出现在回放里");
  const again = repaint(replay, 10, 4);
  assert.ok(again.toReplay().includes("48;5;240"), "回放的再回放仍要保住这行背景");
});

test("行尾只裁无属性空格：带背景色的尾随空格保留", () => {
  const mirror = createScreenMirror({ cols: 12, rows: 3 });
  mirror.write("\u001b[41mAB  \u001b[0m");
  assert.ok(mirror.toReplay().includes("\u001b[41mAB  "), "带 SGR 背景的尾随空格不得被裁掉");

  const plain = createScreenMirror({ cols: 12, rows: 3 });
  plain.write("AB  ");
  assert.ok(!plain.toReplay().includes("AB  "), "无属性尾随空格仍要裁掉");
});

test("擦除按 BCE 建模：EL 与 ED 填入当前背景属性", () => {
  const ed = createScreenMirror({ cols: 10, rows: 3 });
  ed.write("\u001b[44m\u001b[2J\u001b[0m");
  assert.ok(ed.toReplay().includes("44"), "ED 擦除后的行要带上当前背景属性");

  const el = createScreenMirror({ cols: 10, rows: 3 });
  el.write("abc\r\n\u001b[44m\u001b[K\u001b[0m");
  assert.ok(el.toReplay().includes("44"), "EL 擦除段要带上当前背景属性");

  const none = createScreenMirror({ cols: 10, rows: 3 });
  none.write("abc\r\n\u001b[K");
  assert.ok(!none.toReplay().includes("\u001b[44m"), "无背景时擦除不产生多余属性");
});

test("鼠标族与括号粘贴：显式设置过的模式进回放，未记录的不发", () => {
  const mirror = createScreenMirror({ cols: 40, rows: 10 });
  mirror.write("\u001b[?1000h\u001b[?1006h\u001b[?2004h内容\r\n");
  const replay = mirror.toReplay();
  for (const seq of ["\u001b[?1000h", "\u001b[?1006h", "\u001b[?2004h"]) {
    assert.ok(replay.includes(seq), `回放应带 ${JSON.stringify(seq)}`);
  }
  assert.ok(!replay.includes("?1002"), "从未设置的 1002 不得出现在回放里");
  assert.ok(!replay.includes("?2026"), "2026 同步标记不重放");

  mirror.write("\u001b[?2004l");
  const off = mirror.toReplay();
  assert.ok(off.includes("\u001b[?2004l"), "显式关掉的模式以 DECRST 回放");
  assert.ok(!off.includes("\u001b[?2004h"), "关掉的模式不得以 DECSET 回放");

  // 兼容：从未记录过任何模式的旧状态，回放不带任何模式序列
  const legacy = createScreenMirror({ cols: 40, rows: 10 });
  legacy.write("旧会话\r\n");
  const legacyReplay = legacy.toReplay();
  for (const p of [1000, 1002, 1003, 1006, 1015, 2004]) {
    assert.ok(!legacyReplay.includes(`?${p}`), `未记录时回放不得含 ?${p}`);
  }
});

test("ESC[3J 只清滚动区、IL 只移位、ECH 擦除填充", () => {
  const m1 = createScreenMirror({ cols: 20, rows: 4 });
  for (let i = 1; i <= 8; i += 1) m1.write(`行 ${i}\r\n`);
  assert.ok(m1.info().historyLines > 0, "前置：已有滚动历史");
  const before = m1.screenLines();
  m1.write("\u001b[3J");
  assert.equal(m1.info().historyLines, 0, "3J 必须清空滚动区");
  assert.deepEqual(m1.screenLines(), before, "3J 不得改动当前画面");

  const m2 = createScreenMirror({ cols: 10, rows: 5 });
  m2.write("甲\r\n乙\r\n丙");
  m2.write("\u001b[1;1H\u001b[1L");
  const lines = m2.screenLines();
  assert.equal(lines[0], "", "插入行后光标行应为空行");
  assert.equal(lines[1], "甲", "原内容应随插入行下移");
  assert.equal(lines[2], "乙", "第二行内容同样下移");

  const m3 = createScreenMirror({ cols: 10, rows: 3 });
  m3.write("ABCDE");
  m3.write("\u001b[1;2H\u001b[2X");
  assert.equal(m3.screenLines()[0], "A  DE", "ECH 擦除填充而不是左移删除");
});
