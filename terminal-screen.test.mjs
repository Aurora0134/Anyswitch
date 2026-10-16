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

test("备屏会话的回放：历史在前、1049h 切换、帧画备屏，续写不污染滚动区", () => {
  // 回归钉：回放若把备屏帧画进普通缓冲区，客户端留在普通屏而应用仍在备屏——
  // 其后应用的滚动输出全积进客户端滚动区（实测：重建后每波输出 scrollHeight
  // 稳定 +9000px 不复原，用户侧形态=「同一个内容向下渲染很多行」）。
  const mirror = createScreenMirror({ cols: 40, rows: 8 });
  for (let i = 1; i <= 20; i += 1) mirror.write(`历史行 ${i}\r\n`);
  mirror.write("\u001b[?1049h");
  for (let i = 1; i <= 12; i += 1) mirror.write(`备屏行 ${i}\r\n`);
  const altScreen = mirror.screenLines();

  const replay = mirror.toReplay();
  const iSwitch = replay.indexOf("\u001b[?1049h");
  assert.ok(iSwitch > -1, "备屏会话的回放必须带 1049h 把客户端切进备屏");
  assert.ok(replay.lastIndexOf("历史行") < iSwitch, "历史必须在 1049h 之前画进普通屏");
  assert.ok(replay.indexOf("备屏行") > iSwitch, "备屏帧必须在 1049h 之后画");

  const again = repaint(replay, 40, 8);
  assert.equal(again.info().inAlt, true, "回放后客户端必须在备屏");
  assert.deepEqual(again.screenLines(), altScreen, "回放必须还原同一张备屏画面");

  // 污染钉：回放后续写（等价应用活字节）在备屏里滚动，不得积进滚动区
  const histAtReplay = again.info().historyLines;
  again.write("备屏续写 1\r\n备屏续写 2\r\n备屏续写 3\r\n");
  assert.equal(again.info().historyLines, histAtReplay, "备屏里的滚动输出不得进滚动区");

  // 退出复原：备屏帧消失，普通屏的历史尾部可见（1049 的保存/恢复语义）
  again.write("\u001b[?1049l");
  const restored = again.screenLines().join("\n");
  assert.ok(!restored.includes("备屏行"), "退备屏后不得残留备屏帧");
  assert.ok(restored.includes("历史行"), "退备屏后应看到普通屏的历史尾部");
});

test("回放不得把上一行的背景色漏给下一行（BCE 擦除污染）", () => {
  // Claude Code 的用户消息是灰底行、其后是普通行。回放逐行「先整行擦除再写内容」，
  // xterm 的擦除带 BCE 语义（用当前背景色填擦除区）：若上一行序列化结尾不复位 SGR，
  // 下一行的擦除就被残留的灰底填满——用户侧形态=「带灰底的会话行向下多绘制了半行」。
  const mirror = createScreenMirror({ cols: 24, rows: 4 });
  mirror.write("\u001b[0m\u001b[48;2;55;55;55m ❯ user message\u001b[0m\r\n");
  mirror.write("plain reply line\r\n");
  assert.equal(mirror.screenAttrs()[1].every((cell) => cell.bg === ""), true,
    "前置：镜像里灰底行下面的普通行本身无背景");
  const again = repaint(mirror.toReplay(), 24, 4);
  assert.equal(again.screenAttrs()[1].every((cell) => cell.bg === ""), true,
    "回放后的普通行不得被上一行的背景色染色");
  assert.ok(again.screenAttrs()[0].some((cell) => cell.bg !== ""), "灰底行自身的背景必须保留");
});

test("回放不得沿空行级联背景色（OpenCode 整屏污染形态）", () => {
  // OpenCode 每帧逐格带背景色；回放里空行只发「整行擦除」不发内容，而擦除指令
  // 不改变 SGR——行尾不复位时一个带色行能把其后所有空行染成同一底色（实测整屏 38/39 行）。
  const mirror = createScreenMirror({ cols: 16, rows: 4 });
  mirror.write("\u001b[48;5;238m header bar \u001b[0m\r\n");
  assert.equal(mirror.screenAttrs()[1].every((cell) => cell.bg === ""), true, "前置：其后是空行");
  const again = repaint(mirror.toReplay(), 16, 4);
  for (let r = 1; r < 4; r += 1) {
    assert.equal(again.screenAttrs()[r].every((cell) => cell.bg === ""), true, `空行 ${r} 不得被级联染色`);
  }
});

test("扩展色按赋值语义替换旧色：回放不得把历史颜色累积成超长 SGR", () => {
  // dsh 状态栏一帧连设 7 种前景色且中途不复位。镜像若把每条设色当叠加，回放会把
  // 整串颜色拼进一条 SGR（35 参数）——超过 xterm 的 32 参数上限后被截，末尾
  // 38;2 缺 RGB 按零补齐解析成纯黑（2026-10-17 dsh 切回「近白灰字变黑」取证）。
  const mirror = createScreenMirror({ cols: 30, rows: 4 });
  const colors = ["10;20;30", "20;30;40", "30;40;50", "40;50;60", "50;60;70", "60;70;80", "170;178;194"];
  for (const c of colors) mirror.write(`\u001b[38;2;${c}m`);
  mirror.write("X");
  const replay = mirror.toReplay();
  assert.ok(replay.includes("38;2;170;178;194m"), "回放必须保留最后一次设置的颜色");
  assert.ok(!replay.includes("38;2;10;20;30"), "被替换的旧颜色不得残留在回放里");
  for (const m of replay.matchAll(/\u001b\[[0-9;]*m/g)) {
    assert.ok(m[0].split(";").length - 1 <= 32, `单条 SGR 参数不得超过 xterm 的 32 上限：${m[0].slice(0, 60)}…`);
  }
});

test("背景扩展色同样替换：旧背景不得顶掉新背景", () => {
  const mirror = createScreenMirror({ cols: 20, rows: 2 });
  mirror.write("\u001b[48;2;9;9;9m\u001b[48;2;170;178;194m ");
  assert.equal(mirror.screenAttrs()[0][0].bg, "48;2;170;178;194", "新背景必须生效（不得被旧背景顶掉）");
  assert.ok(mirror.toReplay().includes("48;2;170;178;194"), "回放必须带新背景");
});

test("扩展色与基础色互相替换：同槽只留一个颜色 token", () => {
  const toExtended = createScreenMirror({ cols: 20, rows: 2 });
  toExtended.write("\u001b[41m\u001b[48;2;9;9;9m ");
  assert.equal(toExtended.screenAttrs()[0][0].bg, "48;2;9;9;9", "扩展背景到达要摘掉基础背景");

  const toBasic = createScreenMirror({ cols: 20, rows: 2 });
  toBasic.write("\u001b[48;2;7;7;7m\u001b[41m ");
  assert.equal(toBasic.screenAttrs()[0][0].bg, "41", "基础背景到达要摘掉扩展背景");
});

test("CSI s/u 保存恢复后再设色：恢复色不得残留在新色的 SGR 里", () => {
  const mirror = createScreenMirror({ cols: 20, rows: 2 });
  mirror.write("\u001b[38;2;10;20;30m\u001b[s");
  mirror.write("\u001b[38;2;60;70;80mX");
  mirror.write("\u001b[u");
  mirror.write("Y");
  mirror.write("\u001b[38;2;70;80;90mZ");
  const replay = mirror.toReplay();
  assert.ok(!replay.includes("38;2;10;20;30;38;2;70;80;90"), "恢复后再设色不得把恢复色拼进同一条 SGR");
});

test("非备屏会话的回放逐字节不变（回归金样，防误伤普通路径）", () => {
  // 金样由改动前实现生成（12x3、两行内容）：非备屏路径的格式任何变化都应显式过审。
  // 2026-10-16 过审变更：每行序列化结尾追加 \u001b[0m 复位——否则下一行 EL 的 BCE
  // 擦除吃上一行残留背景色（见上方两条泄漏回归测试）。
  const mirror = createScreenMirror({ cols: 12, rows: 3 });
  mirror.write("AB\r\nCD");
  const golden = "\u001b[0m\u001b[2J\u001b[H\r\n\r\n\u001b[1;1H\u001b[2K\u001b[0mAB\u001b[0m\u001b[2;1H\u001b[2K\u001b[0mCD\u001b[0m\u001b[3;1H\u001b[2K\u001b[0m\u001b[0m\u001b[2;3H\u001b[?25h";
  assert.equal(mirror.toReplay(), golden, "非备屏回放必须逐字节保持原样");
  assert.ok(!mirror.toReplay().includes("1049"), "非备屏会话的回放不得含 1049");
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
  for (const p of [20, 1000, 1002, 1003, 1006, 1015, 2004]) {
    assert.ok(!legacyReplay.includes(`?${p}`), `未记录时回放不得含 ?${p}`);
  }
});

test("换行语义与客户端一致：LF/VT/FF 都换行，convertEol 下连列一起归零", () => {
  // xterm 把 LF、VT、FF 一并挂到 lineFeed()；面板的 xterm 开着 convertEol，
  // 裸 LF 连列一起归零。镜像少认一个换行，画面就比屏幕高一行——回放出去的
  // 整屏会整体错位，这正是「切页签回来 TUI 那块区域没了」的形态。
  for (const [name, ch] of [["LF", "\n"], ["VT", "\u000b"], ["FF", "\u000c"]]) {
    const mirror = createScreenMirror({ cols: 20, rows: 4 });
    mirror.write(`one${ch}two`);
    assert.deepEqual(mirror.screenLines().slice(0, 2), ["one", "two"], `${name} 必须换行且列归零`);
  }

  // ?20l 之后 LF 只下移、保留列位（xterm 允许应用运行时关掉 convertEol）
  const off = createScreenMirror({ cols: 20, rows: 4 });
  off.write("\u001b[?20l");
  off.write("one\ntwo");
  assert.deepEqual(off.screenLines().slice(0, 2), ["one", "   two"], "关掉 convertEol 后 LF 保留列位");
  assert.ok(off.toReplay().includes("\u001b[?20l"), "显式关掉的 convertEol 必须进回放，否则重建后又退回默认值");
  assert.deepEqual(repaint(off.toReplay(), 20, 4).screenLines(), off.screenLines(), "回放必须还原同一张画面");

  const on = createScreenMirror({ cols: 20, rows: 4 });
  on.write("\u001b[?20l\u001b[?20h");
  on.write("one\ntwo");
  assert.deepEqual(on.screenLines().slice(0, 2), ["one", "two"], "?20h 恢复列归零");
});

test("NUL/STX 填充与 FF：填充字节不占列，FF 之后的内容落到下一行", () => {
  // grok build 经 conpty 转发时成片出现这种形态：行内夹 NUL/STX/DC1 填充，
  // 行尾用 FF 断行。填充字节两边都忽略、不占列，FF 必须断行。
  const mirror = createScreenMirror({ cols: 12, rows: 4 });
  mirror.write(`\u001b[1;1Hm${"\u0000".repeat(5)}n`);
  mirror.write("\u001b[2;1H`}\u0002\u0000\u0011Z\u000cAFTER");
  const lines = mirror.screenLines();
  assert.equal(lines[0], "mn", "NUL 填充不占列");
  assert.equal(lines[1], "`}Z", "FF 之前的内容留在本行");
  assert.equal(lines[2], "AFTER", "FF 之后的内容落到下一行");
  assert.deepEqual(repaint(mirror.toReplay(), 12, 4).screenLines(), lines, "回放必须还原同一张画面");
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
