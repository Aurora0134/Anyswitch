import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createScreenMirror, terminalCharWidth, TERMINAL_ESCAPE_HOLD_MAX } from "./terminal-screen.mjs";

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
  for (const p of [7, 4, 20, 1000, 1002, 1003, 1006, 1015, 2004]) {
    assert.ok(!legacyReplay.includes(`?${p}`), `未记录时回放不得含 ?${p}`);
  }
});

test("autowrap/IRM 显式设置进回放：重建后客户端与镜像对后续字节的排法一致", () => {
  // ?7l（kimi code 进 TUI 即关 autowrap）与 ?4h（IRM）此前只被镜像追踪、不进回放：
  // 重建后退回客户端默认（7 开 / 4 关），应用的溢出行与中段插入两边排法分叉——
  // 回放帧本身用绝对定位不受影响，分叉发生在其后的活字节上。
  const nowrap = createScreenMirror({ cols: 10, rows: 6 });
  nowrap.write("\u001b[?7l");
  nowrap.write("A".repeat(25));
  assert.equal(nowrap.screenLines()[0], "A".repeat(10), "autowrap 关时镜像钳在行尾不折行");
  assert.equal(nowrap.screenLines()[1].trim(), "", "不得折到第二行");
  assert.ok(nowrap.toReplay().includes("\u001b[?7l"), "显式关掉的 autowrap 必须进回放，否则重建后退回默认开");
  const nowrapAgain = repaint(nowrap.toReplay(), 10, 6);
  nowrapAgain.write("B".repeat(25));
  nowrap.write("B".repeat(25));
  assert.deepEqual(nowrapAgain.screenLines(), nowrap.screenLines(), "重建后两边对溢出行的排法必须一致");

  const rewrap = createScreenMirror({ cols: 10, rows: 6 });
  rewrap.write("\u001b[?7l\u001b[?7h");
  assert.ok(rewrap.toReplay().includes("\u001b[?7h"), "重新显式打开的 autowrap 以 DECSET 回放");

  const irm = createScreenMirror({ cols: 10, rows: 4 });
  irm.write("\u001b[?4hABCDEF\u001b[1;2HXY");
  assert.equal(irm.screenLines()[0], "AXYBCDEF", "IRM 开时按插入语义落字");
  assert.ok(irm.toReplay().includes("\u001b[?4h"), "显式开着的 IRM 必须进回放");
  const irmAgain = repaint(irm.toReplay(), 10, 4);
  irmAgain.write("\u001b[1;3HZ");
  irm.write("\u001b[1;3HZ");
  assert.deepEqual(irmAgain.screenLines(), irm.screenLines(), "重建后两边的插入语义必须一致");
  irm.write("\u001b[?4l");
  assert.ok(irm.toReplay().includes("\u001b[?4l"), "显式关掉的 IRM 以 DECRST 回放");
});

test("备屏 API 保真：?47h 进的备屏以 47h 回放，退出 47l 照常弹回", () => {
  // 旧实现回放只发 1049：用旧 API（47/1047）进备屏的应用，重建后客户端留在普通屏，
  // 应用在备屏语义下续写、客户端却画在普通屏。1049 附带存光标＋清备屏，不得擅自替换。
  const mirror = createScreenMirror({ cols: 30, rows: 6 });
  for (let i = 1; i <= 6; i += 1) mirror.write(`主屏行 ${i}\r\n`);
  mirror.write("\u001b[?47h");
  for (let i = 1; i <= 3; i += 1) mirror.write(`备屏行 ${i}\r\n`);
  const altScreen = mirror.screenLines();
  const replay = mirror.toReplay();
  assert.ok(replay.includes("\u001b[?47h"), "用 47 进的备屏必须以 47 回放");
  assert.ok(!replay.includes("?1049"), "不得擅自换成 1049（保存/恢复语义不同）");
  const again = repaint(replay, 30, 6);
  assert.equal(again.info().inAlt, true, "回放后客户端必须在备屏");
  assert.deepEqual(again.screenLines(), altScreen, "回放必须还原同一张备屏画面");
  mirror.write("\u001b[?47l");
  again.write("\u001b[?47l");
  assert.equal(again.info().inAlt, false, "47l 退出备屏");
  const restored = again.screenLines().join("\n");
  assert.ok(!restored.includes("备屏行"), "退备屏后不得残留备屏帧");
  assert.ok(restored.includes("主屏行"), "退备屏后普通屏的历史尾部可见（与 1049 测试同口径）");
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

test("ESC[3J 不清滚动区（历史归页签）、IL 只移位、ECH 擦除填充", () => {
  const m1 = createScreenMirror({ cols: 20, rows: 4 });
  for (let i = 1; i <= 8; i += 1) m1.write(`行 ${i}\r\n`);
  assert.ok(m1.info().historyLines > 0, "前置：已有滚动历史");
  const before = m1.screenLines();
  const historyBefore = m1.info().historyLines;
  m1.write("\u001b[3J");
  assert.equal(m1.info().historyLines, historyBefore, "3J 不得清空滚动区（回滚历史归页签所有）");
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

test("3J/?3J 降级为 no-op：历史归页签，清滚动区请求后重挂不丢史", () => {
  // 2026-10-18 拍板：重启/清回滚不丢史。客户端 xterm 5.5 的 eraseInDisplay
  // case 3 只裁活动缓冲超出屏行的头部——备屏恒等于屏行数，kimi 备屏里发 3J
  // 客户端天然免疫；镜像曾无条件清 history（「当场没感觉、重挂才丢」的病灶
  // 全在镜像侧），?3J 还被误派 erase-below 擦掉光标下半屏。两者一律 no-op。
  const mirror = createScreenMirror({ cols: 24, rows: 6 });
  for (let i = 1; i <= 12; i += 1) mirror.write(`历史行 ${i}\r\n`);
  const historyBefore = mirror.info().historyLines;
  const screenBefore = mirror.screenLines();

  mirror.write("\u001b[2;3H\u001b[?3J");
  assert.deepEqual(mirror.screenLines(), screenBefore, "?3J 不得擦掉光标以下的画面（旧误派 erase-below 的腐蚀形态）");
  assert.equal(mirror.info().historyLines, historyBefore, "?3J 不得清滚动区");

  mirror.write("\u001b[3J");
  assert.deepEqual(mirror.screenLines(), screenBefore, "3J 不得改动画面");
  assert.equal(mirror.info().historyLines, historyBefore, "3J 不得清滚动区");

  // 备屏形态（kimi / 指令表整屏重绘）：主屏历史同样不动
  mirror.write("\u001b[?1049h");
  for (let i = 1; i <= 4; i += 1) mirror.write(`备屏行 ${i}\r\n`);
  mirror.write("\u001b[2J\u001b[H\u001b[3J");
  assert.equal(mirror.info().historyLines, historyBefore, "备屏里的 3J 同样不得清滚动区");
  mirror.write("\u001b[?1049l");
  const restored = mirror.screenLines().join("|");
  assert.ok(!restored.includes("备屏行"), "弹回主屏不残留备屏内容");
  assert.ok(restored.includes("历史行"), "弹回主屏应看到历史尾部");

  // 核心断言：清滚动区请求之后再重挂，回放必须仍带着完整历史
  const again = repaint(mirror.toReplay(), 24, 6);
  assert.equal(again.info().historyLines, mirror.info().historyLines, "回放必须逐行还原保住的历史（重挂不丢史）");
});

test("SGR 58 下划线色按赋值语义替换：回放只留最后一组，旧色不残留", () => {
  // 2026-10-18 复发取证：applySgr 只认 38/48，58 落进兜底逐条入列，重复设置时
  // 旧 RGB 三元组全部残留。回放成 `58;2;171;178;194;40;90;30`，客户端把尾巴
  // 当成独立指令执行 = 黑底黑字（dsh 切回黑字即此形态）。
  const mirror = createScreenMirror({ cols: 24, rows: 3 });
  mirror.write("\u001b[58;2;171;178;194m\u001b[58;2;40;90;30m下划线");
  const replay = mirror.toReplay();
  assert.ok(replay.includes("58;2;40;90;30"), "回放必须带最后一次设置的下划线色");
  assert.ok(!replay.includes("171;178;194"), "被替换的旧下划线色不得残留");
  const again = repaint(replay, 24, 3);
  assert.equal(again.screenAttrs()[0].slice(0, 6).every((cell) => cell.bg === ""), true,
    "下划线色不是底色：回放后不得凭空出现背景");
});

test("58;5;n 与 58;2 同槽：后到的整组替换前一组", () => {
  const mirror = createScreenMirror({ cols: 20, rows: 2 });
  mirror.write("\u001b[58;5;40m\u001b[58;2;171;178;194mX");
  const replay = mirror.toReplay();
  assert.ok(replay.includes("58;2;171;178;194"), "回放必须带新下划线色");
  assert.ok(!replay.includes("58;5;40"), "被替换的 256 色下划线色不得残留");
  assert.equal(repaint(replay, 20, 2).screenAttrs()[0][0].bg, "", "下划线色不得被当成背景");
});

test("59 摘除下划线色槽，39/49 不误摘", () => {
  const off = createScreenMirror({ cols: 20, rows: 2 });
  off.write("\u001b[58;2;171;178;194m\u001b[59mZ");
  assert.ok(!off.toReplay().includes("58"), "59 之后回放不得再带 58 槽");

  const kept = createScreenMirror({ cols: 20, rows: 2 });
  kept.write("\u001b[58;2;171;178;194m\u001b[39m\u001b[49mX");
  assert.ok(kept.toReplay().includes("58;2;171;178;194"),
    "39/49 只复位前景/背景，不得误摘下划线色");
});

test("冒号子参数 4:3 不得拼成 43：无黄底、前置前景色不丢", () => {
  // 旧收集器只收 [\d;]，冒号被丢弃后 `4:3` 拼成 `43` = 黄底（opencode 2.0.32
  // 二进制里 4:3 命中 8 处）。冒号必须留着交给 applySgr 按族处置。
  const mirror = createScreenMirror({ cols: 24, rows: 2 });
  mirror.write("\u001b[38;2;171;178;194m灰\u001b[4:3m卷曲");
  const replay = mirror.toReplay();
  assert.ok(replay.includes("4:3"), "回放必须原样保留卷曲下划线样式");
  assert.ok(!/\u001b\[[0-9;]*\b43m/.test(replay), "不得出现 43（黄底）");
  const again = repaint(replay, 24, 2);
  assert.equal(again.screenAttrs()[0].slice(0, 6).every((cell) => cell.bg === ""), true,
    "卷曲下划线段不得凭空多出背景");
  assert.ok(replay.includes("38;2;171;178;194"), "前置真彩色前景必须保留");
});

test("冒号 58:2::r:g:b 归入 58 槽，不污染其它属性", () => {
  const mirror = createScreenMirror({ cols: 24, rows: 2 });
  mirror.write("\u001b[1;38;2;171;178;194m\u001b[58:2::40:90:30mX");
  const replay = mirror.toReplay();
  assert.ok(replay.includes("58:2::40:90:30"), "冒号形态的下划线色整组入槽");
  assert.ok(replay.includes("38;2;171;178;194"), "前景色不得被冒号 token 清掉");
  assert.ok(/[;[]1(;|m)/.test(replay), "粗体不得被冒号 token 误复位");
  assert.equal(repaint(replay, 24, 2).screenAttrs()[0][0].bg, "", "冒号下划线色不得变成背景");

  // 未知冒号族安全忽略：7:3 不得被当成 7（反显），也不得拆成 7/3 入列
  const unknown = createScreenMirror({ cols: 20, rows: 2 });
  unknown.write("\u001b[7:3mZ");
  assert.ok(!/\u001b\[[0-9;]*\b7m/.test(unknown.toReplay()), "未知冒号族不得变形为反显");
  assert.equal(unknown.screenAttrs()[0][0].bg, "", "未知冒号族不得影响背景判定");
});

test("含冒号 token 不得触发 NaN→0 全复位", () => {
  // 旧实现 Number("4:3")||0 = 0，等于把整条 SGR 当清屏复位：已设的颜色/粗体全丢。
  const mirror = createScreenMirror({ cols: 20, rows: 2 });
  mirror.write("\u001b[1;31;4:3mX");
  const replay = mirror.toReplay();
  assert.ok(/\b31\b/.test(replay), "冒号 token 之后的 31 必须生效且不被清零");
  assert.ok(/[;[]1(;|m)/.test(replay), "冒号 token 不得把粗体一并复位");
  assert.ok(replay.includes("4:3"), "冒号样式本身要保留");
});

// ---- 跨块解析（真实 PTY 的 onData 边界会劈开转义序列）----
// 镜像原先对每块独立解析：转义序列被块边界劈开时丢掉 ESC 头、把参数当普通文字
// 画进屏幕。真实 resume 抓包的 22 个块边界里有 3 个正好劈在序列中间，屏幕上就
// 多出一行 "session[79Gwiah" 之类的乱码。下面每条都拿「整块喂」当唯一真值。
describe("跨块转义序列：分块喂与整块喂必须画出同一张画面", () => {
  const cases = [
    ["SGR 在参数中间劈开", ["\u001b[31mRED"], ["\u001b[3", "1mRED"]],
    ["ESC 与 [ 之间劈开", ["\u001b[31mRED"], ["\u001b", "[31mRED"]],
    ["CSI 末尾字符前劈开", ["\u001b[2JX"], ["\u001b[2", "JX"]],
    ["OSC 用 BEL 结束且分块", ["\u001b]0;title\u0007ok"], ["\u001b]0;ti", "tle\u0007ok"]],
    ["OSC 用 ST 结束且分块", ["\u001b]0;t\u001b\\ok"], ["\u001b]0;t\u001b", "\\ok"]],
    ["DCS 分块", ["\u001bPqdata\u001b\\ok"], ["\u001bPqda", "ta\u001b\\ok"]],
    ["ESC 7 保存光标后分块", ["\u001b7AB\u001b8C"], ["\u001b", "7AB\u001b8C"]],
    ["ESC ( 字符集指定分块", ["\u001b(BAB"], ["\u001b(", "BAB"]],
    ["代理对劈开（对照，本就该一致）", ["😀Z"], ["\ud83d", "\ude00Z"]],
  ];
  for (const [name, whole, split] of cases) {
    test(name, () => {
      const a = createScreenMirror({ cols: 40, rows: 6, historyLines: 100 });
      for (const chunk of whole) a.write(chunk);
      const b = createScreenMirror({ cols: 40, rows: 6, historyLines: 100 });
      for (const chunk of split) b.write(chunk);
      assert.equal(b.toReplay(), a.toReplay(), "分块与整块的回放必须逐字节相同");
      assert.deepEqual(b.screenLines(), a.screenLines(), "画面也必须相同");
      assert.equal(b.info().pendingChars, 0, "喂完最后一块后不得残留待接续字节");
    });
  }

  test("劈开的 SGR 不得把参数当文字画进屏幕", () => {
    const mirror = createScreenMirror({ cols: 40, rows: 4 });
    mirror.write("\u001b[3");
    mirror.write("1mRED");
    assert.equal(mirror.screenLines()[0], "RED", "屏幕上只应有 RED，不得出现 1m 前缀");
    assert.equal(mirror.screenAttrs()[0][0].bg, "", "31 是前景色，不得被当成背景");
  });

  test("未终结的 OSC 暂留而不是吃掉后半段", () => {
    const mirror = createScreenMirror({ cols: 40, rows: 4 });
    mirror.write("\u001b]0;very long tit");
    assert.ok(mirror.info().pendingChars > 0, "未终结的 OSC 必须留在待接续缓冲里");
    mirror.write("le\u0007VISIBLE");
    assert.equal(mirror.screenLines()[0], "VISIBLE", "OSC 结束后其后的文字要正常落屏");
    assert.equal(mirror.info().pendingChars, 0, "序列终结后待接续缓冲必须清空");
  });

  test("超长未终结序列不无限占缓冲：超过上限按旧行为丢弃", () => {
    const mirror = createScreenMirror({ cols: 20, rows: 4 });
    mirror.write("\u001b]0;" + "x".repeat(TERMINAL_ESCAPE_HOLD_MAX + 10));
    assert.equal(mirror.info().pendingChars, 0, "超过暂留上限必须丢弃而不是一直攒着");
    mirror.write("AFTER");
    assert.equal(mirror.screenLines()[0], "AFTER", "丢弃后后续输出照常落屏");
  });
});

// ---- 有预算切片：把一次大块解析拆到多个事件循环轮次 ----
describe("有预算切片解析：与整块解析逐字节等价，且单片不超预算", () => {
  // 确定性伪随机：用例必须可复现，失败时能照同一序列重跑。
  function makeRandom(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  // 覆盖面：换行/回车/制表/退格、SGR 全套、光标定位、擦除、滚动、备屏、OSC/DCS、
  // 宽字符与组合字符——切块点落在其中任何位置都必须等价。
  function corpus() {
    return [
      "\u001b[2J\u001b[H",
      "\u001b[38;2;12;34;56mhello\u001b[0m world\r\n",
      "\u001b[48;5;240m  bar  \u001b[49m\r\n",
      "\u001b[1;4;7mbold underline inverse\u001b[0m\r\n",
      "\u001b[3;5Hpositioned\u001b[6;1H",
      "\u001b[2K\u001b[1K\u001b[0K",
      "\u001b[3L\u001b[2M\u001b[2P\u001b[3@\u001b[4X",
      "\u001b[2S\u001b[1T",
      "\u001b[5;20r\u001b[10;1Hscrolled",
      "\u001b]0;title\u0007",
      "\u001bPq#0\u001b\\",
      "中文宽字符与組合字元 e\u0301\r\n",
      "\u001b[?1049halt screen\u001b[?1049l",
      "\u001b[?20lno convert eol\nback\r\n",
      "\tTABBED\b\bX\r\n",
      "\u001b[4:3mcolon underline\u001b[24m\r\n",
      "\u001b[58;2;1;2;3munderline color\u001b[59m\r\n",
      "\u001b7saved\u001b8restored\r\n",
      "\u001b[sCSI saved\u001b[uCSI restored\r\n",
      "plain ascii line that is long enough to wrap around the 40 column edge",
    ].join("");
  }

  test("随机切块 × 随机预算，与整块 write 完全一致", () => {
    // 语料重复到足够长：预算每 256 个字符才采样一次时钟，语料太短时每个块都会在
    // 第一次采样前就解析完，fuzz 就退化成「同步 write 的等价性测试」。
    const text = corpus().repeat(12);
    const reference = createScreenMirror({ cols: 40, rows: 12, historyLines: 200 });
    reference.write(text);
    const expectedReplay = reference.toReplay();
    const expectedLines = reference.screenLines();
    const expectedHistory = reference.historyLines();

    // 覆盖率自检：必须真的走到「预算用尽、中途停下」这条路径，否则偏移错误抓不到。
    let stalls = 0;
    let carried = 0;
    for (let round = 0; round < 12; round += 1) {
      const rand = makeRandom(0x5eed + round);
      const mirror = createScreenMirror({ cols: 40, rows: 12, historyLines: 200 });
      let offset = 0;
      while (offset < text.length) {
        // 块大小跨两个数量级：小到 1 字符（切在转义序列中间），大到数千字符。
        // 大块是必须的——预算每 256 字符才采样一次时钟，只有够长的块才可能中途停下。
        const size = rand() < 0.25 ? 1 + Math.floor(rand() * 4) : 256 + Math.floor(rand() * 2000);
        const chunk = text.slice(offset, offset + size);
        offset += size;
        // 预算从极小到不限：0 表示同步排空，极小值强制中途停下。
        const roll = rand();
        const budget = roll < 0.15 ? 0 : roll < 0.5 ? 0.001 : roll < 0.75 ? 0.5 : 4;
        const first = mirror.writeSliced(chunk, budget);
        if (!first.done) stalls += 1;
        while (!mirror.drain(budget).done) { /* 模拟 setImmediate 续排 */ }
        if (mirror.info().pendingChars > 0) carried += 1;
      }
      mirror.flush();
      assert.equal(mirror.toReplay(), expectedReplay, `第 ${round} 轮回放必须与整块一致`);
      assert.deepEqual(mirror.screenLines(), expectedLines, `第 ${round} 轮画面必须一致`);
      assert.deepEqual(mirror.historyLines(), expectedHistory, `第 ${round} 轮历史必须一致`);
      assert.equal(mirror.info().pendingChars, 0, `第 ${round} 轮结束后不得残留待接续字节`);
    }
    assert.ok(stalls > 20, `fuzz 必须真的走到中途停下（实际 ${stalls} 次）`);
    assert.ok(carried > 0, `fuzz 必须覆盖未终结序列暂留（实际 ${carried} 次）`);
  });

  test("单片耗时不超过预算 + 一个采样量子", () => {
    // 64KB 换行密集块是镜像最坏的输入形态（每字符都触发一次滚动与历史序列化）。
    const heavy = "\n".repeat(64 * 1024);
    const mirror = createScreenMirror({ cols: 80, rows: 24 });
    const budget = 4;
    const started = performance.now();
    const first = mirror.writeSliced(heavy, budget);
    const elapsed = performance.now() - started;
    assert.equal(first.done, false, "64KB 换行密集块必须在预算内停下，不能一口气排完");
    // 门槛是单次同步块 ≤ 8ms（spec 验收表）。预算是软的：每 256 个字符才看一次
    // 时钟，所以最多超出一个量子的解析时间；8ms 对 4ms 预算留了整整一个量子。
    assert.ok(elapsed < 8, `单片耗时 ${elapsed.toFixed(1)}ms 必须 ≤ 8ms 门槛`);
    while (!mirror.drain(budget).done) { /* 排完 */ }
    assert.equal(mirror.info().pendingChars, 0, "排空后不得残留字节");
  });

  test("flush 与 info 先把待解析字节排空再回答", () => {
    const mirror = createScreenMirror({ cols: 40, rows: 8 });
    mirror.writeSliced("A".repeat(80) + "\r\nB", 0.0001);
    // 预算极小，第一轮很可能没排完；不论排没排完，info 都必须给出排空后的结果。
    const info = mirror.info();
    assert.equal(info.pendingChars, 0, "info 前必须排空");
    assert.equal(mirror.screenLines()[2], "B", "排空后 B 必须已经落到第三行");
  });

  test("discardPending 丢弃待解析字节，后续输出仍从干净状态继续", () => {
    const mirror = createScreenMirror({ cols: 40, rows: 4 });
    mirror.writeSliced("X".repeat(4096), 0.0001);
    mirror.discardPending();
    assert.equal(mirror.info().pendingChars, 0, "丢弃后不得残留");
    mirror.write("CLEAN");
    assert.ok(mirror.screenLines().join("").includes("CLEAN"), "丢弃后新输出要正常落屏");
  });
});

// ---- 回放缓存：重复 attach 不再重算，任何推进都失效 ----
describe("回放缓存", () => {
  test("重复调用返回同一结果，且解析推进或 resize 后失效", () => {
    const mirror = createScreenMirror({ cols: 20, rows: 4 });
    mirror.write("first");
    const a = mirror.toReplay();
    const b = mirror.toReplay();
    assert.equal(a, b, "同一状态下的重复回放必须完全相同");

    mirror.write("\r\nsecond");
    const c = mirror.toReplay();
    assert.notEqual(c, a, "新字节到达后回放必须重新生成");
    assert.ok(c.includes("second"), "新回放必须包含新内容");

    const d = mirror.toReplay();
    assert.equal(d, c, "缓存命中时仍要与新状态一致");

    mirror.resize(30, 6);
    const e = mirror.toReplay();
    assert.notEqual(e, d, "resize 后回放必须失效重算");
  });

  test("缓存不得把待解析字节当成已落屏", () => {
    const mirror = createScreenMirror({ cols: 40, rows: 4 });
    mirror.write("AAA");
    assert.ok(mirror.toReplay().includes("AAA"));
    // 只入队不排空（预算 0.0001 极可能停在半路），toReplay 仍须看到完整内容。
    mirror.writeSliced("\r\nBBB", 0.0001);
    assert.ok(mirror.toReplay().includes("BBB"), "回放必须先排空待解析字节");
  });
});

// ---- 折行待定的取消时机 ----
// clampCursor 不再清 pendingWrap（它只在解析轮次末尾夹光标，块边界正好落在满行时
// 清掉会让下一个字符覆盖行尾那一格）。取消折行待定改由「光标被移动」负责，这里把
// 每条路径逐一对齐 xterm 5.5 的真值：它用 x === cols 当哨兵，所有移动类操作都会
// _restrictCursor() 把哨兵夹掉，lineFeed 里的 x-- 同理。
describe("满行后光标被移动，折行待定必须取消", () => {
  const cols = 10;
  const cases = [
    // [说明, 前置, 操作, 期望 B 落在第几行第几列]
    ["ESC 8 恢复光标", "A".repeat(cols), "\u001b8", 1, 1],
    ["CSI u 恢复光标", "A".repeat(cols), "\u001b[u", 1, 1],
    ["1049h 进备屏", "A".repeat(cols), "\u001b[?1049h", 1, 1],
    ["ESC c 整屏复位", "A".repeat(cols), "\u001bc", 1, 1],
    ["CUP 定位", "A".repeat(cols), "\u001b[3;1H", 3, 1],
    ["ESC E 归零换行", "A".repeat(cols), "\u001bE", 2, 1],
    ["裸 LF", "A".repeat(cols), "\n", 2, 1],
    ["未满行时 ESC 8 仍回原位", "AAA", "\u001b8", 1, 1],
  ];
  for (const [name, setup, op, wantRow, wantCol] of cases) {
    test(name, () => {
      const mirror = createScreenMirror({ cols, rows: 6 });
      mirror.write(setup);
      mirror.write(op);
      mirror.write("B");
      const lines = mirror.screenLines();
      const row = lines.findIndex((line) => line.includes("B")) + 1;
      const col = row > 0 ? lines[row - 1].indexOf("B") + 1 : -1;
      assert.equal(row, wantRow, `${name}：B 应在第 ${wantRow} 行`);
      assert.equal(col, wantCol, `${name}：B 应在第 ${wantCol} 列`);
    });
  }

  test("满行后不移动光标，下一个字符仍要折行", () => {
    const mirror = createScreenMirror({ cols, rows: 6 });
    mirror.write("A".repeat(cols));
    mirror.write("B");
    const lines = mirror.screenLines();
    assert.equal(lines[0], "A".repeat(cols), "第一行必须保持满行");
    assert.equal(lines[1], "B", "B 必须折到第二行");
  });
});
