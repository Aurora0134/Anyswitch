// Rendered mirror of one PTY session's screen.
//
// Why this exists: the replay a client gets when it attaches to /stream used to be
// the raw byte window. A full-screen TUI (kimi code, claude code, anything that
// addresses the cursor) draws its frame with *relative* moves — "up 22, rewrite
// these rows" — and the position that frame occupies comes from scrolling that has
// already happened. Any bounded window must cut that byte stream at the head, and a
// head-cut stream replayed into a fresh screen starts with a cursor the replay
// assumes is somewhere it isn't. Measured on a live kimi session (181x46): 512KB of
// window, 1,400 repaint frames, 894 line feeds, zero clear-screen and zero absolute
// positioning in the whole slice — replay produced 0 scroll events, painted content
// only into rows 1..27 and left ~20 blank rows below the frame. That is the pair of
// symptoms: the area above the frame is unreachable after a refresh (nothing
// scrolled, so the emulator's scrollback stays empty) and the picture floats upward
// by whatever the accumulated cursor-up bias happens to be.
//
// The mirror consumes the same bytes a terminal emulator would and keeps the
// rendered result instead of the transcript of moves: the current grid plus the rows
// that scrolled off the top. Replaying it emits a self-contained, absolutely
// positioned repaint, so correctness no longer depends on where the window head
// fell, and history is budgeted in rendered lines rather than in repaint bytes.
//
// Scope, on purpose: the sequence set that terminal output actually produces here
// (CR/LF/VT/FF/BS/TAB, CUU/CUD/CUF/CUB/CNL/CPL/CHA/VPA/CUP, ED/EL/IL/DL/DCH/ICH/ECH,
// SU/SD, DECSTBM, SGR incl. 256/truecolor, DECSC/DECRC, cursor visibility, alt screen
// 1049/1047/47, autowrap 7, IRM 4, convertEol 20) plus OSC and DCS strings (consumed
// whole, or held across chunks when the terminator has not arrived yet). The C0
// line-feed family must match the client's emulator exactly: a lost line feed drifts
// the whole mirror one row above the real screen, and the client only sees it when it
// rebuilds from a replay.
// Unknown sequences are consumed and ignored — the mirror must never be able to
// break forwarding. Reflow on resize is deliberately not modelled: a resize makes
// the application repaint its own frame, so only historical rows keep their old
// wrap, which is what a real terminal's scrollback shows too.
//
// 分块边界：PTY 的 onData 会在任意字节处切开输出，转义序列也不例外。解析器因此把
// 未终结的序列暂留到下一块（上限 TERMINAL_ESCAPE_HOLD_MAX），而不是丢掉 ESC 头把
// 参数当文字画进屏幕。暂留期间该序列之后的字节还没解析，画面会短暂落后于字节流；
// 序列终结（或超过暂留上限被丢弃）后立刻追上。转发不受影响——镜像始终只是一名
// 乘客，最坏情况是这一段没画上，绝不是输出停止转发。
// 解析本身可以按时间预算切片（writeSliced/drain）：预算用尽就停在字符边界，
// 剩余字节留在待解析缓冲里等下一轮，画面随后补齐。

export const TERMINAL_HISTORY_LINES = 5000; // matches the panel's xterm scrollback
export const TERMINAL_HISTORY_MAX_BYTES = 1024 * 1024;
export const TERMINAL_REPLAY_MAX_BYTES = 2 * 1024 * 1024;
// 跨块未完成转义序列的暂留上限：畸形且永不终结的 OSC/DCS 不能无限吃缓冲。
// 超限即按旧行为丢弃（宁可少画这一段，也不能把内存挂在这条流上）。
export const TERMINAL_ESCAPE_HOLD_MAX = 64 * 1024;
// 待解析积压上限：持续高速输出时切片跟不上，积压到这个量就整段同步排空一次
// （等于退回旧的整块解析），保证内存有界。真实输出远低于切片吞吐，正常不触发。
export const TERMINAL_PENDING_MAX = 1024 * 1024;
// parseInto 的返回值：输入在转义序列中间用完了，剩下的部分要留到下一块。
const INCOMPLETE = -1;
// 预算采样的量子：逐字符读时钟比解析本身还贵，每 256 字符看一次即可。
const BUDGET_QUANTUM = 256;

// 字符宽度表与面板客户端同源：客户端加载 @xterm/addon-unicode11 且
// t.unicode.activeVersion = "11"，下面两张表逐码点等于它的 wcwidth（生成来源与
// 版本由 terminal-screen.test.mjs 的全码点对账用例钉住——客户端那份表一变，那里就红）。
// 为什么必须同源：镜像只在「后台切回 / F5」时上屏一次，宽度少算一列，应用用
// 「相对移动 + 空格覆盖」擦行时就少擦一格，行尾留下擦不掉的旧字符——即用户看到的
// 悬空碎片（2026-10-26 取证：dsh 的 ⚓ 客户端占 2 列、旧手写表按 1 列算）。
const ZERO_WIDTH_RANGES = [
  [0x0, 0x1f], [0x7f, 0x9f], [0x300, 0x36f], [0x483, 0x489], [0x591, 0x5bd],
  [0x5bf, 0x5bf], [0x5c1, 0x5c2], [0x5c4, 0x5c5], [0x5c7, 0x5c7], [0x600, 0x605],
  [0x610, 0x61a], [0x61c, 0x61c], [0x64b, 0x65f], [0x670, 0x670], [0x6d6, 0x6dd],
  [0x6df, 0x6e4], [0x6e7, 0x6e8], [0x6ea, 0x6ed], [0x70f, 0x70f], [0x711, 0x711],
  [0x730, 0x74a], [0x7a6, 0x7b0], [0x7eb, 0x7f3], [0x7fd, 0x7fd], [0x816, 0x819],
  [0x81b, 0x823], [0x825, 0x827], [0x829, 0x82d], [0x859, 0x85b], [0x8d3, 0x902],
  [0x93a, 0x93a], [0x93c, 0x93c], [0x941, 0x948], [0x94d, 0x94d], [0x951, 0x957],
  [0x962, 0x963], [0x981, 0x981], [0x9bc, 0x9bc], [0x9c1, 0x9c4], [0x9cd, 0x9cd],
  [0x9e2, 0x9e3], [0x9fe, 0x9fe], [0xa01, 0xa02], [0xa3c, 0xa3c], [0xa41, 0xa42],
  [0xa47, 0xa48], [0xa4b, 0xa4d], [0xa51, 0xa51], [0xa70, 0xa71], [0xa75, 0xa75],
  [0xa81, 0xa82], [0xabc, 0xabc], [0xac1, 0xac5], [0xac7, 0xac8], [0xacd, 0xacd],
  [0xae2, 0xae3], [0xafa, 0xaff], [0xb01, 0xb01], [0xb3c, 0xb3c], [0xb3f, 0xb3f],
  [0xb41, 0xb44], [0xb4d, 0xb4d], [0xb56, 0xb56], [0xb62, 0xb63], [0xb82, 0xb82],
  [0xbc0, 0xbc0], [0xbcd, 0xbcd], [0xc00, 0xc00], [0xc04, 0xc04], [0xc3e, 0xc40],
  [0xc46, 0xc48], [0xc4a, 0xc4d], [0xc55, 0xc56], [0xc62, 0xc63], [0xc81, 0xc81],
  [0xcbc, 0xcbc], [0xcbf, 0xcbf], [0xcc6, 0xcc6], [0xccc, 0xccd], [0xce2, 0xce3],
  [0xd00, 0xd01], [0xd3b, 0xd3c], [0xd41, 0xd44], [0xd4d, 0xd4d], [0xd62, 0xd63],
  [0xdca, 0xdca], [0xdd2, 0xdd4], [0xdd6, 0xdd6], [0xe31, 0xe31], [0xe34, 0xe3a],
  [0xe47, 0xe4e], [0xeb1, 0xeb1], [0xeb4, 0xebc], [0xec8, 0xecd], [0xf18, 0xf19],
  [0xf35, 0xf35], [0xf37, 0xf37], [0xf39, 0xf39], [0xf71, 0xf7e], [0xf80, 0xf84],
  [0xf86, 0xf87], [0xf8d, 0xf97], [0xf99, 0xfbc], [0xfc6, 0xfc6], [0x102d, 0x1030],
  [0x1032, 0x1037], [0x1039, 0x103a], [0x103d, 0x103e], [0x1058, 0x1059], [0x105e, 0x1060],
  [0x1071, 0x1074], [0x1082, 0x1082], [0x1085, 0x1086], [0x108d, 0x108d], [0x109d, 0x109d],
  [0x1160, 0x11ff], [0x135d, 0x135f], [0x1712, 0x1714], [0x1732, 0x1734], [0x1752, 0x1753],
  [0x1772, 0x1773], [0x17b4, 0x17b5], [0x17b7, 0x17bd], [0x17c6, 0x17c6], [0x17c9, 0x17d3],
  [0x17dd, 0x17dd], [0x180b, 0x180e], [0x1885, 0x1886], [0x18a9, 0x18a9], [0x1920, 0x1922],
  [0x1927, 0x1928], [0x1932, 0x1932], [0x1939, 0x193b], [0x1a17, 0x1a18], [0x1a1b, 0x1a1b],
  [0x1a56, 0x1a56], [0x1a58, 0x1a5e], [0x1a60, 0x1a60], [0x1a62, 0x1a62], [0x1a65, 0x1a6c],
  [0x1a73, 0x1a7c], [0x1a7f, 0x1a7f], [0x1ab0, 0x1abe], [0x1b00, 0x1b03], [0x1b34, 0x1b34],
  [0x1b36, 0x1b3a], [0x1b3c, 0x1b3c], [0x1b42, 0x1b42], [0x1b6b, 0x1b73], [0x1b80, 0x1b81],
  [0x1ba2, 0x1ba5], [0x1ba8, 0x1ba9], [0x1bab, 0x1bad], [0x1be6, 0x1be6], [0x1be8, 0x1be9],
  [0x1bed, 0x1bed], [0x1bef, 0x1bf1], [0x1c2c, 0x1c33], [0x1c36, 0x1c37], [0x1cd0, 0x1cd2],
  [0x1cd4, 0x1ce0], [0x1ce2, 0x1ce8], [0x1ced, 0x1ced], [0x1cf4, 0x1cf4], [0x1cf8, 0x1cf9],
  [0x1dc0, 0x1df9], [0x1dfb, 0x1dff], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064],
  [0x2066, 0x206f], [0x20d0, 0x20f0], [0x2cef, 0x2cf1], [0x2d7f, 0x2d7f], [0x2de0, 0x2dff],
  [0x302a, 0x302d], [0x3099, 0x309a], [0xa66f, 0xa672], [0xa674, 0xa67d], [0xa69e, 0xa69f],
  [0xa6f0, 0xa6f1], [0xa802, 0xa802], [0xa806, 0xa806], [0xa80b, 0xa80b], [0xa825, 0xa826],
  [0xa8c4, 0xa8c5], [0xa8e0, 0xa8f1], [0xa8ff, 0xa8ff], [0xa926, 0xa92d], [0xa947, 0xa951],
  [0xa980, 0xa982], [0xa9b3, 0xa9b3], [0xa9b6, 0xa9b9], [0xa9bc, 0xa9bd], [0xa9e5, 0xa9e5],
  [0xaa29, 0xaa2e], [0xaa31, 0xaa32], [0xaa35, 0xaa36], [0xaa43, 0xaa43], [0xaa4c, 0xaa4c],
  [0xaa7c, 0xaa7c], [0xaab0, 0xaab0], [0xaab2, 0xaab4], [0xaab7, 0xaab8], [0xaabe, 0xaabf],
  [0xaac1, 0xaac1], [0xaaec, 0xaaed], [0xaaf6, 0xaaf6], [0xabe5, 0xabe5], [0xabe8, 0xabe8],
  [0xabed, 0xabed], [0xfb1e, 0xfb1e], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff],
  [0xfff9, 0xfffb], [0x101fd, 0x101fd], [0x102e0, 0x102e0], [0x10376, 0x1037a], [0x10a01, 0x10a03],
  [0x10a05, 0x10a06], [0x10a0c, 0x10a0f], [0x10a38, 0x10a3a], [0x10a3f, 0x10a3f], [0x10ae5, 0x10ae6],
  [0x10d24, 0x10d27], [0x10f46, 0x10f50], [0x11001, 0x11001], [0x11038, 0x11046], [0x1107f, 0x11081],
  [0x110b3, 0x110b6], [0x110b9, 0x110ba], [0x110bd, 0x110bd], [0x110cd, 0x110cd], [0x11100, 0x11102],
  [0x11127, 0x1112b], [0x1112d, 0x11134], [0x11173, 0x11173], [0x11180, 0x11181], [0x111b6, 0x111be],
  [0x111c9, 0x111cc], [0x1122f, 0x11231], [0x11234, 0x11234], [0x11236, 0x11237], [0x1123e, 0x1123e],
  [0x112df, 0x112df], [0x112e3, 0x112ea], [0x11300, 0x11301], [0x1133b, 0x1133c], [0x11340, 0x11340],
  [0x11366, 0x1136c], [0x11370, 0x11374], [0x11438, 0x1143f], [0x11442, 0x11444], [0x11446, 0x11446],
  [0x1145e, 0x1145e], [0x114b3, 0x114b8], [0x114ba, 0x114ba], [0x114bf, 0x114c0], [0x114c2, 0x114c3],
  [0x115b2, 0x115b5], [0x115bc, 0x115bd], [0x115bf, 0x115c0], [0x115dc, 0x115dd], [0x11633, 0x1163a],
  [0x1163d, 0x1163d], [0x1163f, 0x11640], [0x116ab, 0x116ab], [0x116ad, 0x116ad], [0x116b0, 0x116b5],
  [0x116b7, 0x116b7], [0x1171d, 0x1171f], [0x11722, 0x11725], [0x11727, 0x1172b], [0x1182f, 0x11837],
  [0x11839, 0x1183a], [0x119d4, 0x119d7], [0x119da, 0x119db], [0x119e0, 0x119e0], [0x11a01, 0x11a0a],
  [0x11a33, 0x11a38], [0x11a3b, 0x11a3e], [0x11a47, 0x11a47], [0x11a51, 0x11a56], [0x11a59, 0x11a5b],
  [0x11a8a, 0x11a96], [0x11a98, 0x11a99], [0x11c30, 0x11c36], [0x11c38, 0x11c3d], [0x11c3f, 0x11c3f],
  [0x11c92, 0x11ca7], [0x11caa, 0x11cb0], [0x11cb2, 0x11cb3], [0x11cb5, 0x11cb6], [0x11d31, 0x11d36],
  [0x11d3a, 0x11d3a], [0x11d3c, 0x11d3d], [0x11d3f, 0x11d45], [0x11d47, 0x11d47], [0x11d90, 0x11d91],
  [0x11d95, 0x11d95], [0x11d97, 0x11d97], [0x11ef3, 0x11ef4], [0x13430, 0x13438], [0x16af0, 0x16af4],
  [0x16b30, 0x16b36], [0x16f4f, 0x16f4f], [0x16f8f, 0x16f92], [0x1bc9d, 0x1bc9e], [0x1bca0, 0x1bca3],
  [0x1d167, 0x1d169], [0x1d173, 0x1d182], [0x1d185, 0x1d18b], [0x1d1aa, 0x1d1ad], [0x1d242, 0x1d244],
  [0x1da00, 0x1da36], [0x1da3b, 0x1da6c], [0x1da75, 0x1da75], [0x1da84, 0x1da84], [0x1da9b, 0x1da9f],
  [0x1daa1, 0x1daaf], [0x1e000, 0x1e006], [0x1e008, 0x1e018], [0x1e01b, 0x1e021], [0x1e023, 0x1e024],
  [0x1e026, 0x1e02a], [0x1e130, 0x1e136], [0x1e2ec, 0x1e2ef], [0x1e8d0, 0x1e8d6], [0x1e944, 0x1e94a],
  [0xe0001, 0xe0001], [0xe0020, 0xe007f], [0xe0100, 0xe01ef],
];
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0],
  [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x2e99], [0x2e9b, 0x2ef3], [0x2f00, 0x2fd5], [0x2ff0, 0x2ffb], [0x3000, 0x3029],
  [0x302e, 0x303e], [0x3041, 0x3096], [0x309b, 0x30ff], [0x3105, 0x312f], [0x3131, 0x318e],
  [0x3190, 0x31ba], [0x31c0, 0x31e3], [0x31f0, 0x321e], [0x3220, 0x3247], [0x3250, 0x4dbf],
  [0x4e00, 0xa48c], [0xa490, 0xa4c6], [0xa960, 0xa97c], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe52], [0xfe54, 0xfe66], [0xfe68, 0xfe6b], [0xff01, 0xff60],
  [0xffe0, 0xffe6], [0x16fe0, 0x16fe3], [0x17000, 0x187f7], [0x18800, 0x18af2], [0x1b000, 0x1b11e],
  [0x1b150, 0x1b152], [0x1b164, 0x1b167], [0x1b170, 0x1b2fb], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248],
  [0x1f250, 0x1f251], [0x1f260, 0x1f265], [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d5], [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fa], [0x1f7e0, 0x1f7eb], [0x1f90d, 0x1f971], [0x1f973, 0x1f976], [0x1f97a, 0x1f9a2],
  [0x1f9a5, 0x1f9aa], [0x1f9ae, 0x1f9ca], [0x1f9cd, 0x1f9ff], [0x1fa70, 0x1fa73], [0x1fa78, 0x1fa7a],
  [0x1fa80, 0x1fa82], [0x1fa90, 0x1fa95], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

// 区间表有序且两表互斥，走二分：解析热路径上每个非 ASCII 字符都要问一次宽度，
// 逐条比较的线性扫描在三百多个区间上会变成这段解析里最贵的一笔常数。
const inRanges = (code, ranges) => {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid];
    if (code < range[0]) hi = mid - 1;
    else if (code > range[1]) lo = mid + 1;
    else return true;
  }
  return false;
};

// ASCII 快路径：全部宽字符与其余零宽区间的下界都在 0x300 之上，0x300 以下只有
// 控制区（C0/DEL/C1）是零宽（客户端表如此），其余一律一列。解析一段回放要过十万次
// 这个判定，区间查找在那条路上是最大的一笔常数开销。
export function terminalCharWidth(ch) {
  const code = ch.codePointAt(0);
  if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return 0;
  if (code < 0x300) return 1;
  if (inRanges(code, ZERO_WIDTH_RANGES)) return 0;
  if (inRanges(code, WIDE_RANGES)) return 2;
  return 1;
}

const blankRow = (cols, attr = "") => ({
  chars: new Array(cols).fill(null),
  attrs: new Array(cols).fill(attr),
});

// A row of spaces is still a painted bar when those cells carry a background
// or inverse. Treating it as blank drops the bar from the repaint. Covers every
// background form the SGR stream can carry: 7 inverse, 40-47 and 100-107 basic
// and bright backgrounds, 48 extended, 49 default.
// 有界记忆化：同一行里连续空格的属性串完全相同，逐格重扫一次属性串是纯重复劳动
// （回放一段 373KB 输出要调用十八万次）。属性串取值集合本身很小，4096 条足够覆盖
// 任何真实会话；满了整体清空而不是淘汰单条，避免为维护 LRU 再付一笔开销。
const PAINTED_CACHE_MAX = 4096;
const paintedCache = new Map();
const cellPainted = (attr) => {
  const key = attr ?? "";
  const cached = paintedCache.get(key);
  if (cached !== undefined) return cached;
  let painted = false;
  for (const part of String(key).split(";")) {
    const n = Number(part);
    if (!Number.isFinite(n)) continue;
    if (n === 7 || n === 48 || n === 49) { painted = true; break; }
    if (n >= 40 && n <= 47) { painted = true; break; }
    if (n >= 100 && n <= 107) { painted = true; break; }
  }
  if (paintedCache.size >= PAINTED_CACHE_MAX) paintedCache.clear();
  paintedCache.set(key, painted);
  return painted;
};

const isBlankRow = (row) => row.chars.every((ch, index) => {
  if (!(ch === null || ch === "" || ch === " ")) return false;
  return !cellPainted(row.attrs[index]);
});

// 回放要重放的应用态模式。收录规则（不再逐块打补丁）：凡是镜像内部追踪、且会改变
// 渲染或转发语义的模式，必须三选一——①进这份清单（客户端重建＝RIS 后退回出厂默认，
// 应用显式设置过而回放不带，两边对后续实时字节的理解就分叉；7/4/20 同此理）；②走
// 专用回放（?25 光标可见性见 toReplay 末尾；备屏 1049/1047/47 见 inAlt 分支，须发
// 应用实际使用的那只 API）；③在 setMode 的注释里写明不回放的理由（2026 是同帧批
// 处理标记，回放只有单帧画面）。不得只追踪不回放。
const REPLAYED_MODES = [7, 4, 20, 1000, 1002, 1003, 1006, 1015, 2004];

export function createScreenMirror({ cols = 80, rows = 24, historyLines = TERMINAL_HISTORY_LINES, historyBytes = TERMINAL_HISTORY_MAX_BYTES } = {}) {
  let width = Math.max(1, cols | 0);
  let height = Math.max(1, rows | 0);
  let grid = Array.from({ length: height }, () => blankRow(width));
  let altSaved = null;
  let inAlt = false;
  // 进备屏用的那只 API（1049/1047/47）：回放时原样发回。1049 附带存光标＋清备屏，
  // 47/1047 不带——擅自换成 1049 会把客户端的保存/恢复语义换成另一套。
  let altApi = 1049;
  let row = 0;
  let col = 0;
  let pendingWrap = false;
  let saved = { row: 0, col: 0, attrs: "" };
  let top = 0;
  let bottom = height - 1;
  let sgr = [];
  let autoWrap = true;
  // 客户端（面板的 xterm）开着 convertEol：裸 LF 会把列一并归零。镜像必须跟它
  // 一样，否则同一段字节在镜像里和屏幕上排成两种样子。应用可以用 ?20h/?20l 在
  // 运行时改这个开关，所以它是状态而非常量。
  let convertEol = true;
  let insertMode = false;
  let cursorVisible = true;
  // 应用态模式的记录表：只在被显式 set/reset 过后才入表；从未出现过的模式
  // 保持「未记录」，回放时不发任何模式序列，与旧行为一致。
  let appModes = {};
  let history = [];
  let historyTotal = 0;
  let consumedBytes = 0;
  // 待解析输入：切片解析可能在中途停下，未消化的字节留在这里等下一轮。
  let pending = "";
  let pendingOffset = 0;
  // 跨块未完成的转义序列（见 consumeEscape 的 INCOMPLETE）。
  let carry = "";
  // toReplay 结果缓存：一次整屏重绘要 15–20ms，而每次 attach 都会调一次。
  // 任何解析推进或 resize 都置空。
  let replayCache = null;

  // SGR 属性串按版本号缓存：每格写屏都要取一次，而它只在真正改了 SGR 时才变。
  // 所有对 sgr 的写都走 setSgr / pushSgr，漏一处就会让缓存停在旧值上。
  let sgrVersion = 0;
  let sgrCachedVersion = -1;
  let sgrCached = "";
  const setSgr = (next) => { sgr = next; sgrVersion += 1; };
  const pushSgr = (value) => { sgr.push(value); sgrVersion += 1; };
  const attrsString = () => {
    if (sgrCachedVersion !== sgrVersion) {
      sgrCached = sgr.length ? sgr.join(";") : "";
      sgrCachedVersion = sgrVersion;
    }
    return sgrCached;
  };

  // BCE（xterm.js 5.5 行为）：擦除填入的只有当前 SGR 的背景属性，前景与其余属性都不带。
  const bgString = () =>
    sgr
      .filter((code) => {
        const n = Number(code);
        return (n >= 40 && n <= 47) || (n >= 100 && n <= 107) || /^48;/.test(String(code));
      })
      .join(";");

  function rebuild(newCols, newRows) {
    const next = Array.from({ length: newRows }, (_, r) => {
      const source = grid[r];
      const fresh = blankRow(newCols);
      if (source) {
        for (let c = 0; c < Math.min(newCols, width); c += 1) {
          fresh.chars[c] = source.chars[c];
          fresh.attrs[c] = source.attrs[c];
        }
      }
      return fresh;
    });
    width = newCols;
    height = newRows;
    grid = next;
    top = 0;
    bottom = height - 1;
    // 尺寸变了，旧的折行待定状态没有意义。
    pendingWrap = false;
    clampCursor();
  }

  // 只把光标夹回屏内。刻意不动 pendingWrap：它表示「光标停在最后一列、下一个可打印
  // 字符要折行」，是跨块仍然有效的状态。旧实现把清 pendingWrap 混在这里、并在每次
  // write() 结束时调用一次，于是块边界正好落在满行时折行状态被吃掉——下一个字符
  // 覆盖掉行尾那一格，整行少一个字（切片解析与整块解析的回放差一个字符即此形态）。
  // 真正需要取消折行状态的是「光标被移动」，那些位置各自显式清（见 dispatchCsi）。
  function clampCursor() {
    row = Math.min(height - 1, Math.max(0, row));
    col = Math.min(width - 1, Math.max(0, col));
  }

  function pushHistory(text) {
    history.push(text);
    historyTotal += text.length;
    while (history.length > historyLines || historyTotal > historyBytes) {
      historyTotal -= history.shift().length;
    }
  }

  // Scroll the region up by n (content moves toward the top); a whole-screen
  // scroll on the main screen sends the departing line into history.
  // 滚出屏顶的那一行整行复用成新的底行（先序列化进 history，再就地清空），
  // 不重新分配两个数组。换行密集的输出（一段 resume、一次 `type` 大文件）会连续
  // 滚动几十万次，每次两次 181 元数组分配是这条路径上最大的一笔开销。
  function scrollRegionUp(n) {
    for (let k = 0; k < n; k += 1) {
      const whole = top === 0 && bottom === height - 1;
      const departed = grid[top];
      if (whole && !inAlt) pushHistory(serializeRow(departed));
      for (let r = top; r < bottom; r += 1) grid[r] = grid[r + 1];
      // 复用的行必须真的清空：它可能带着上一屏的字符与属性（背景色尤其不能留，
      // 否则新行会继承旧底色，回放里凭空多出一条色带）。
      departed.chars.fill(null);
      departed.attrs.fill("");
      grid[bottom] = departed;
    }
  }

  function scrollRegionDown(n) {
    for (let k = 0; k < n; k += 1) {
      const departed = grid[bottom];
      for (let r = bottom; r > top; r -= 1) grid[r] = grid[r - 1];
      // 与 scrollRegionUp 同理：滚出屏底的行复用成新的顶行。
      departed.chars.fill(null);
      departed.attrs.fill("");
      grid[top] = departed;
    }
  }

  // 换行同时取消折行待定：xterm 5.5 用「列号 === cols」当待折行哨兵，lineFeed 里
  // 的 `x >= cols && x--` 把哨兵换成真实列号，等价于清掉它。我们照这个真值建模，
  // 否则满行后一次换行会让下一个字符先多折一行。
  function lineFeed() {
    pendingWrap = false;
    if (row === bottom) scrollRegionUp(1);
    else row = Math.min(height - 1, row + 1);
  }

  // 同理：xterm 的 reverseIndex 先 _restrictCursor()（夹掉哨兵）再移行。
  function reverseIndex() {
    pendingWrap = false;
    if (row === top) scrollRegionDown(1);
    else row = Math.max(0, row - 1);
  }

  function putCell(targetCol, ch, chWidth) {
    if (targetCol >= width) return;
    if (insertMode) {
      for (let c = width - 1; c > targetCol; c -= 1) {
        grid[row].chars[c] = grid[row].chars[c - 1];
        grid[row].attrs[c] = grid[row].attrs[c - 1];
      }
    }
    grid[row].chars[targetCol] = ch;
    grid[row].attrs[targetCol] = attrsString();
    if (chWidth === 2 && targetCol + 1 < width) {
      grid[row].chars[targetCol + 1] = ""; // continuation cell: occupies a column, prints nothing
      grid[row].attrs[targetCol + 1] = grid[row].attrs[targetCol];
    }
  }

  function appendToPrevious(targetCol, ch) {
    const at = Math.max(0, Math.min(width - 1, targetCol - 1));
    const existing = grid[row].chars[at];
    if (typeof existing === "string" && existing !== "" && existing !== " ") grid[row].chars[at] = existing + ch;
  }

  function eraseLine(mode) {
    const line = grid[row];
    const from = mode === 1 ? 0 : mode === 2 ? 0 : col;
    const to = mode === 0 ? width - 1 : mode === 1 ? col : width - 1;
    const fill = bgString();
    // 整行擦除走原生 fill：TUI 几乎每行都以 ESC[2K 开头，逐格赋值在 181 列终端上
    // 是每行 181 次 JS 写，一段回放就是上百万次。区间擦除仍走循环。
    if (from === 0 && to >= width - 1) {
      line.chars.fill(null);
      line.attrs.fill(fill);
      return;
    }
    for (let c = from; c <= to; c += 1) { line.chars[c] = null; line.attrs[c] = fill; }
  }

  function eraseDisplay(mode) {
    if (mode === 3) {
      // 3J 降级为 no-op（2026-10-18 拍板：回滚历史归页签）：应用清滚动区的请求
      // 不清镜像 history——客户端 xterm 对备屏 3J 本就免疫，镜像保史后重挂回放
      // 不再丢史。派发处已拦 mode 3，这里兜底防直调回退成整屏清除。
      return;
    }
    const fill = bgString();
    if (mode === 0) {
      eraseLine(0);
      for (let r = row + 1; r < height; r += 1) grid[r] = blankRow(width, fill);
    } else if (mode === 1) {
      eraseLine(1);
      for (let r = 0; r < row; r += 1) grid[r] = blankRow(width, fill);
    } else {
      grid = grid.map(() => blankRow(width, fill));
    }
  }

  // 冒号子参数（ITU T.416 风格）单独成族：4:x 是下划线样式、58:x 是下划线颜色。
  // 其余冒号族（含 38:/48: 的冒号形态）一律安全忽略——不入列，也不许被拆成数字码：
  // 旧实现把冒号当垃圾丢掉再把数字拼起来（\e[4:3m → 43），回放里凭空多出一条黄底
  // （2026-10-18 取证，opencode 2.0.32 的 4:3 序列触发）。
  function applySgrColon(token) {
    const parts = token.split(":");
    const family = Number(parts[0]);
    if ((parts[1] ?? "") === "") return; // 裸族名（"4:" / "58:"）语义不明，按未知忽略
    if (family === 4) {
      // 4 与 4:x 同一槽，样式是赋值：后到的替换先到的，24/0 摘整槽。
      setSgr(sgr.filter((c) => c !== 4 && !String(c).startsWith("4:")));
      pushSgr(token);
    } else if (family === 58) {
      // 下划线色与 38/48 同款赋值语义：push 前摘掉整个 58 槽（分号/冒号两种形态）。
      setSgr(sgr.filter((c) => !String(c).startsWith("58;") && !String(c).startsWith("58:")));
      pushSgr(token);
    }
  }

  function applySgr(raw) {
    const tokens = (raw === "" ? "0" : raw).split(";");
    // 颜色 run 的子参数是位置语义：缺失或非数字按 0 补齐（与旧实现一致）。
    const sub = (index) => {
      const token = tokens[index];
      if (token === undefined || token === "") return 0;
      const n = Number(token);
      return Number.isFinite(n) ? n : 0;
    };
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      // 含冒号的 token 先分派给子参数解析，绝不能落到下面的 Number 归一：
      // 旧实现 Number("4:3")||0 = 0，等于把整条 SGR 当全复位执行。
      if (token.includes(":")) { applySgrColon(token); continue; }
      const p = token === "" ? 0 : Number(token);
      // 非数字 token 跳过而不是归零：0 是「清空全部属性」，误归一等于清屏。
      if (!Number.isFinite(p)) continue;
      if (p === 0) { setSgr([]); continue; }
      if (p === 39) { setSgr(sgr.filter((c) => !(c === 39 || (c >= 30 && c <= 37) || (c >= 90 && c <= 97) || /^38;/.test(String(c))))); continue; }
      if (p === 49) { setSgr(sgr.filter((c) => !(c === 49 || (c >= 40 && c <= 47) || (c >= 100 && c <= 107) || /^48;/.test(String(c))))); continue; }
      if (p === 59) { setSgr(sgr.filter((c) => !String(c).startsWith("58;") && !String(c).startsWith("58:"))); continue; }
      if (p === 22) { setSgr(sgr.filter((c) => c !== 1 && c !== 2 && c !== 21)); continue; }
      if (p === 23) { setSgr(sgr.filter((c) => c !== 3)); continue; }
      if (p === 24) { setSgr(sgr.filter((c) => c !== 4 && !String(c).startsWith("4:"))); continue; }
      if (p === 25) { setSgr(sgr.filter((c) => c !== 5 && c !== 6)); continue; }
      if (p === 27) { setSgr(sgr.filter((c) => c !== 7)); continue; }
      if (p === 4) {
        // 4 与 4:x 同槽：后到的覆盖先到的（24/0 摘整槽），避免 4:3;4 越积越长。
        setSgr(sgr.filter((c) => c !== 4 && !String(c).startsWith("4:")));
        pushSgr(4);
        continue;
      }
      if (p === 38 || p === 48 || p === 58) {
        // 38;5;n / 38;2;r;g;b — carry the whole colour run as one attribute token.
        // 58（下划线色）走同一套：子参数散着入列会让回放序列被客户端当成独立指令
        // （58;2;171;178;194;40;90;30 的尾巴 = 黑底 + 黑字，2026-10-18 取证）。
        const kind = sub(i + 1);
        let next = null;
        if (kind === 5) { next = `${p};5;${sub(i + 2)}`; i += 2; }
        else if (kind === 2) { next = `${p};2;${sub(i + 2)};${sub(i + 3)};${sub(i + 4)}`; i += 4; }
        if (next) {
          // 颜色是赋值不是叠加：push 前摘掉同槽旧 token（扩展或基础形态都算）。
          // 残留叠加会把回放序列化撑成一条超长 SGR，超过 xterm 的 32 参数上限后
          // 被截，末尾 38;2 缺 RGB 按零补齐解析成纯黑——dsh 状态栏一帧连设 7 色、
          // 切回后「近白灰字变纯黑」即此形态（2026-10-17 取证）。
          setSgr(p === 38
            ? sgr.filter((c) => { const n = Number(c); return !String(c).startsWith("38;") && !(n >= 30 && n <= 37) && !(n >= 90 && n <= 97); })
            : p === 48
              ? sgr.filter((c) => { const n = Number(c); return !String(c).startsWith("48;") && !(n >= 40 && n <= 47) && !(n >= 100 && n <= 107); })
              : sgr.filter((c) => !String(c).startsWith("58;") && !String(c).startsWith("58:")));
          pushSgr(next);
        }
        continue;
      }
      if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) setSgr(sgr.filter((c) => !String(c).startsWith("38;")));
      else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) setSgr(sgr.filter((c) => !String(c).startsWith("48;")));
      if (!sgr.includes(p)) pushSgr(p);
    }
  }

  function setMode(raw, final, on) {
    const params = (raw === "" ? "0" : raw).split(";").map((x) => (x === "" ? 0 : Number(x) || 0));
    for (const p of params) {
      if (final === "h" || final === "l") {
        const value = on;
        if (p === 25) cursorVisible = value;
        else if (p === 7) { autoWrap = value; appModes[p] = value; }
        else if (p === 4) { insertMode = value; appModes[p] = value; }
        else if (p === 20) { convertEol = value; appModes[p] = value; }
        else if (p === 1049 || p === 1047 || p === 47) { if (value) altApi = p; setAlt(value); }
        else if (REPLAYED_MODES.includes(p)) appModes[p] = value;
        // 1 (cursor keys), 12 (blink), 6 (origin), 1004 (focus reporting):
        // consumed, no grid effect, not tracked — replaying them would need new
        // recording plus replay-ordering care (origin/scroll-region modes change
        // how the replay's own absolute positioning and history pushes behave;
        // see the REPLAYED_MODES rule comment). 2026 stays unreplayed per toReplay.
      }
    }
  }

  function setAlt(on) {
    if (on === inAlt) return;
    // 切屏必然重定光标（进备屏归零、退备屏恢复保存位置），折行待定随之作废。
    pendingWrap = false;
    if (on) {
      altSaved = { grid, row, col, top, bottom, inAlt };
      grid = Array.from({ length: height }, () => blankRow(width));
      row = 0;
      col = 0;
    } else if (altSaved) {
      ({ grid, row, col, top, bottom } = altSaved);
      altSaved = null;
    }
    inAlt = on;
  }

  function dispatchCsi(raw, final, priv) {
    // 单参数快路径：绝大多数序列形如 ESC[<数字><final>，逐条 split+map 建数组再取
    // 第 0 项是纯开销（一段回放两万七千条序列）。带 ";" 或 ":" 的仍走通用路径，
    // 语义完全一致——通用路径对单 token 的结果就是下面这个值。
    const simple = raw.indexOf(";") < 0 && raw.indexOf(":") < 0;
    const single = raw === "" ? 0 : Number(raw) || 0;
    let params = null;
    const param = (index) => {
      if (simple) return index === 0 ? single : undefined;
      params ??= raw.split(";").map((x) => (x === "" ? 0 : Number(x) || 0));
      return params[index];
    };
    // arg 是「缺省或 0 一律取默认值」的取参口径，光标移动族全用它。
    const arg = (index, dflt) => {
      const value = param(index);
      return value === undefined || Number.isNaN(value) || value === 0 ? dflt : value;
    };
    // 光标被移动或编辑格位的序列取消折行待定（真实终端语义）：xterm 5.5 用
    // 「x === cols」当哨兵，A–H/f/G/`/d/r/u 与 P/@/X/L/M 各自走 _restrictCursor()
    // 把哨兵夹成 cols-1，哨兵随之消失；不取消的话，移动后写的第一个字符会先多折
    // 一行。J/K（擦除）在 xterm 里以 cols 为上限夹，哨兵保留，故不在此列；m/s/h/l
    // 不动光标，同样保留。夹光标（clampCursor）不负责这件事，见那里的注释。
    if ("ABCDEFG`dHfruP@XLM".includes(final)) pendingWrap = false;
    switch (final) {
      case "A": row = Math.max(0, row - arg(0, 1)); break;
      case "B": row = Math.min(height - 1, row + arg(0, 1)); break;
      case "C": col = Math.min(width - 1, col + arg(0, 1)); break;
      case "D": col = Math.max(0, col - arg(0, 1)); break;
      case "E": col = 0; row = Math.min(height - 1, row + arg(0, 1)); break;
      case "F": col = 0; row = Math.max(0, row - arg(0, 1)); break;
      case "G": case "`": col = arg(0, 1) - 1; break;
      case "d": row = arg(0, 1) - 1; break;
      case "H": case "f": row = arg(0, 1) - 1; col = arg(1, 1) - 1; break;
      case "J": {
        // 3J/?3J 一律 no-op（回滚历史归页签）：xterm 5.5 的 eraseInDisplay case 3
        // 只裁活动缓冲超出屏行的头部、备屏恒等于屏行数——kimi 备屏里发 3J 客户端
        // 天然免疫，镜像曾在这里无条件清 history（「当场没感觉、重挂才丢」的病灶）；
        // ?3J 旧路径误派 erase-below（擦掉光标下半屏）一并收口。
        const mode = param(0) || 0;
        if (mode === 3) break;
        eraseDisplay(priv ? 0 : mode);
        break;
      }
      case "K": eraseLine(param(0) || 0); break;
      // IL 插入行：光标行及以下整体下移 n 行，底部多出滚动区外的行丢弃。
      case "L": for (let k = arg(0, 1); k > 0; k -= 1) { for (let r = bottom; r > row; r -= 1) grid[r] = grid[r - 1]; grid[row] = blankRow(width); } break;
      case "M": for (let k = arg(0, 1); k > 0; k -= 1) { for (let r = row; r < bottom; r += 1) grid[r] = grid[r + 1]; grid[bottom] = blankRow(width); } break;
      case "P": {
        const n = arg(0, 1);
        for (let c = col; c < width; c += 1) {
          const src = c + n;
          grid[row].chars[c] = src < width ? grid[row].chars[src] : null;
          grid[row].attrs[c] = src < width ? grid[row].attrs[src] : "";
        }
        break;
      }
      case "X": {
        // ECH 是擦除填充：从光标起擦 n 格（BCE 背景），右侧内容保持不动；不是 DCH 那样的左移删除。
        const n = arg(0, 1);
        const fill = bgString();
        for (let c = col; c < Math.min(width, col + n); c += 1) { grid[row].chars[c] = null; grid[row].attrs[c] = fill; }
        break;
      }
      case "@": {
        const n = arg(0, 1);
        for (let c = width - 1; c >= col; c -= 1) {
          const src = c - n;
          grid[row].chars[c] = src >= col ? grid[row].chars[src] : null;
          grid[row].attrs[c] = src >= col ? grid[row].attrs[src] : "";
        }
        break;
      }
      case "S": scrollRegionUp(arg(0, 1)); break;
      case "T": scrollRegionDown(arg(0, 1)); break;
      case "r": {
        const nextTop = arg(0, 1) - 1;
        const second = param(1);
        const nextBottom = (second === undefined || second === 0 ? height : second) - 1;
        top = Math.max(0, Math.min(height - 1, nextTop));
        bottom = Math.max(top, Math.min(height - 1, nextBottom));
        row = top;
        col = 0;
        break;
      }
      case "m": if (!priv) applySgr(raw); break;
      case "s": saved = { row, col, attrs: attrsString() }; break;
      case "u":
        row = saved.row;
        col = saved.col;
        // 恢复串经 applySgr 重放：直接 split 会把 38;2;… 劈成裸数字碎片，
        // 破坏 applySgr 里「同槽颜色 token 是原子、新色到达先摘旧色」的替换不变量。
        setSgr([]);
        applySgr(saved.attrs);
        break;
      case "h": setMode(raw, "h", true); break;
      case "l": setMode(raw, "l", false); break;
      default: break; // DSR/DA/window ops/scroll-area save/restore …: consumed
    }
    clampCursor();
  }

  // A CSI parameter string can carry private markers and intermediates
  // ("?<params><intermediates><final>"); keep the digits for dispatch.
  // 返回 INCOMPLETE 表示「输入在这里用完了、序列还没结束」：调用方要把 start 之后
  // 的尾巴留到下一块。旧实现一律返回 input.length 当作已消费，等于把 ESC 头连同
  // 参数一起丢掉、把参数当普通文字画进屏幕——实测真实 resume 抓包的 22 个块边界里
  // 有 3 个正好劈在序列中间，屏幕上就多出一行 "session[79Gwiah" 之类的乱码。
  function consumeEscape(input, start) {
    const len = input.length;
    if (start + 1 >= len) return INCOMPLETE;
    const next = input.charCodeAt(start + 1);
    if (next === 0x5b) {
      // "[": CSI
      let i = start + 2;
      let priv = "";
      if (i < len) {
        const c = input.charCodeAt(i);
        if (c === 0x3f || c === 0x3e || c === 0x3d || c === 0x21) { priv = input[i]; i += 1; }
      }
      const paramStart = i;
      let params = "";
      let filtered = false;
      while (i < len) {
        const c = input.charCodeAt(i);
        if (c >= 0x40 && c <= 0x7e) break; // final byte
        const keep = (c >= 0x30 && c <= 0x39) || c === 0x3b || c === 0x3a;
        // 冒号是参数的一部分（4:3 / 58:2::r:g:b 的子参数分隔符）：留着交给 applySgr
        // 按族处置。旧实现只收数字和分号，冒号一丢，两侧数字就拼成一个新码
        // （\e[4:3m → 43 黄底）。
        if (!keep && !filtered) { params = input.slice(paramStart, i); filtered = true; }
        else if (filtered && keep) params += input[i];
        i += 1;
      }
      if (i >= len) return INCOMPLETE;
      if (!filtered) params = input.slice(paramStart, i);
      const final = input[i];
      if (!priv || priv === "?") dispatchCsi(params, final, priv === "?");
      // ESC[?2026h/l and friends stay invisible to the grid; the private marker on
      // other modes is handled inside setMode via the params we did pass.
      return i + 1;
    }
    if (next === 0x5d) {
      // "]": OSC — 结束符是 BEL 或 ST
      let i = start + 2;
      while (i < len) {
        const c = input.charCodeAt(i);
        if (c === 0x07) return i + 1;
        if (c === 0x1b && input.charCodeAt(i + 1) === 0x5c) return i + 2;
        i += 1;
      }
      return INCOMPLETE;
    }
    if (next === 0x50 || next === 0x5e || next === 0x5f) {
      // P / ^ / _: DCS、PM、APC —— 同样以 BEL 或 ST 结束
      let i = start + 2;
      while (i < len) {
        const c = input.charCodeAt(i);
        if (c === 0x07) return i + 1;
        if (c === 0x1b && input.charCodeAt(i + 1) === 0x5c) return i + 2;
        i += 1;
      }
      return INCOMPLETE;
    }
    if (next === 0x37) { saved = { row, col, attrs: attrsString() }; return start + 2; } // ESC 7
    // ESC 8 恢复光标、ESC E 归零再换行、ESC c 整屏复位：三者都重新定光标，
    // 折行待定随之作废（否则恢复位置后写的第一个字符会先多折一行）。
    if (next === 0x38) { row = saved.row; col = saved.col; pendingWrap = false; return start + 2; } // ESC 8
    // ESC D（IND）与 ESC M（RI）只移行不移列，与 LF 同口径：折行待定保留。
    if (next === 0x44) { lineFeed(); return start + 2; } // ESC D
    if (next === 0x45) { col = 0; pendingWrap = false; lineFeed(); return start + 2; } // ESC E
    if (next === 0x4d) { reverseIndex(); return start + 2; } // ESC M
    if (next === 0x63) { // ESC c
      grid = Array.from({ length: height }, () => blankRow(width));
      row = 0; col = 0; top = 0; bottom = height - 1;
      pendingWrap = false;
      setSgr([]);
      return start + 2;
    }
    if (next === 0x28 || next === 0x29 || next === 0x2a || next === 0x2b) {
      // 字符集指定：ESC ( <final>，final 还没到就等下一块
      if (start + 2 >= len) return INCOMPLETE;
      return start + 3;
    }
    return start + 2;
  }

  const nowMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

  // 折行待定在这里落地：上一格写满一行且自动换行开着，就先折到下一行行首。
  // 批写与逐字符两条路径共用（lineFeed 自己会清 pendingWrap，无需再清）。
  function wrapIfPending() {
    if (autoWrap && pendingWrap) { col = 0; lineFeed(); }
  }

  // 一段可打印字符写完后的收尾：写满一行就挂上折行待定，否则光标停在行尾。
  function settleRunEnd() {
    if (col >= width) { pendingWrap = autoWrap; col = width - 1; }
  }

  // 解析核心：从 start 起消费到 deadlineMs（0 = 不设预算）。
  // 返回 { index, done, incomplete }：index 是下一个未消费字符的位置；done=false
  // 表示预算用尽、还有字节没解析；incomplete=true 表示尾部是一个没结束的转义序列。
  function parseInto(input, start, deadlineMs) {
    const len = input.length;
    let i = start;
    // 按「已消费字符数」采样，不是按循环次数：ASCII 批写一次能吞掉整行、OSC 扫描
    // 一次能吞掉整段，按循环次数计数会让预算在长 run 上完全失效。
    let nextCheck = start + BUDGET_QUANTUM;
    while (i < len) {
      if (deadlineMs > 0 && i >= nextCheck) {
        if (nowMs() >= deadlineMs) return { index: i, done: false, incomplete: false };
        nextCheck = i + BUDGET_QUANTUM;
      }
      const code = input.charCodeAt(i);
      if (code === 0x1b) {
        const next = consumeEscape(input, i);
        if (next === INCOMPLETE) return { index: i, done: false, incomplete: true };
        i = next;
        continue;
      }
      if (code === 0x0d) { col = 0; pendingWrap = false; i += 1; continue; }
      if (code === 0x0a || code === 0x0b || code === 0x0c) {
        // xterm 把 LF、VT、FF 一并交给 lineFeed()（换行是这三个字符共同的语义），
        // convertEol 打开时列一并归零。镜像少认一个换行，画面就比屏幕高一行，
        // 回放出去的整屏会整体错位——自带背景、成片刷新的 TUI 字节流里这些控制
        // 字符很常见，它们正是「切页签回来画面坏掉」的形态。
        if (convertEol) col = 0;
        lineFeed();
        i += 1;
        continue;
      }
      if (code === 0x08) { col = Math.max(0, col - 1); pendingWrap = false; i += 1; continue; }
      if (code === 0x09) { col = Math.min(width - 1, (Math.floor(col / 8) + 1) * 8); pendingWrap = false; i += 1; continue; }
      if (code < 0x20) { i += 1; continue; }
      // 可打印 ASCII 连续段批写：逐字符走宽度分类再调 putCell 是解析里最贵的常数
      // （一段回放要过十六万次），而普通文本几乎全是这种字符。插入模式下不能批写
      // （每格都要右移），落回逐字符路径。
      if (code <= 0x7e && !insertMode) {
        wrapIfPending();
        const line = grid[row];
        const attr = attrsString();
        let j = i;
        while (j < len && col < width) {
          const c = input.charCodeAt(j);
          if (c < 0x20 || c > 0x7e) break;
          line.chars[col] = input[j];
          line.attrs[col] = attr;
          col += 1;
          j += 1;
        }
        i = j;
        settleRunEnd();
        continue;
      }
      const w = terminalCharWidth(input[i]);
      if (w === 0) { appendToPrevious(col, input[i]); i += 1; continue; }
      wrapIfPending();
      putCell(col, input[i], w);
      if (col + w >= width) {
        pendingWrap = autoWrap;
        col = width - 1;
      } else {
        col += w;
      }
      i += 1;
    }
    return { index: i, done: true, incomplete: false };
  }

  // 待解析输入入队：上一轮留下的未完成转义序列排在最前面，顺序天然保序。
  function queueInput(input) {
    const prefix = carry;
    carry = "";
    if (pendingOffset >= pending.length) {
      pending = prefix ? prefix + input : input;
    } else {
      pending = prefix + pending.slice(pendingOffset) + input;
    }
    pendingOffset = 0;
  }

  // 解析到预算为止。done=true 表示这一轮没有剩余工作（已排空，或尾部是一个
  // 还在等后续字节的转义序列）；done=false 表示预算用尽、调用方应尽快再调一次。
  function drain(budgetMs) {
    if (pendingOffset >= pending.length) {
      pending = "";
      pendingOffset = 0;
      return { done: true, pendingChars: 0 };
    }
    const backlog = pending.length - pendingOffset;
    // 积压超过上限就整段同步排空：这是内存兜底，正常速率下永不触发。
    const deadline = budgetMs > 0 && backlog <= TERMINAL_PENDING_MAX ? nowMs() + budgetMs : 0;
    const start = pendingOffset;
    const result = parseInto(pending, start, deadline);
    if (result.index > start) replayCache = null;
    if (result.incomplete) {
      const rest = pending.slice(result.index);
      pending = "";
      pendingOffset = 0;
      // 超限说明这是一个畸形且不会终结的序列：按旧行为丢掉，不让它占住内存。
      // 这里不 clampCursor：序列只是没读完，光标本来就在合法位置；而 clamp 会
      // 清掉 pendingWrap，把「刚写满一行」的待折行状态吃掉。
      carry = rest.length <= TERMINAL_ESCAPE_HOLD_MAX ? rest : "";
      return { done: true, pendingChars: carry.length };
    }
    pendingOffset = result.index;
    if (result.done) {
      pending = "";
      pendingOffset = 0;
      clampCursor();
      return { done: true, pendingChars: 0 };
    }
    return { done: false, pendingChars: backlog - (result.index - start) };
  }

  function write(input) {
    if (typeof input !== "string" || input === "") return;
    consumedBytes += Buffer.byteLength(input);
    queueInput(input);
    drain(0);
  }

  // 有预算的写入：解析最多占用 budgetMs，没解析完的部分留在 pending 里等 drain。
  // 调用方（terminal-host 的 feedMirror）据此把一次大块解析拆到多个事件循环轮次。
  function writeSliced(input, budgetMs = 4) {
    if (typeof input !== "string" || input === "") return { done: true, pendingChars: 0 };
    consumedBytes += Buffer.byteLength(input);
    queueInput(input);
    return drain(budgetMs);
  }

  // 立刻排空待解析字节（回放/查询前调用，保证看到的是当前字节流的完整结果）。
  function flush() { drain(0); }

  // 丢弃待解析字节：解析出错时调用，宁可少画这一段，也不能让偏移和字节流脱节后
  // 把后续所有输出都画错位。
  function discardPending() {
    pending = "";
    pendingOffset = 0;
    carry = "";
    // 丢弃是出错路径：回放缓存可能对应着已经不再可信的状态，一并作废。
    replayCache = null;
  }

  function serializeRow(line) {
    let end = line.chars.length;
    while (end > 0) {
      const ch = line.chars[end - 1];
      const blank = ch === null || ch === undefined || ch === " ";
      if (!blank || cellPainted(line.attrs[end - 1])) break;
      end -= 1;
    }
    let out = "";
    let current = "";
    let pending = null;
    for (let c = 0; c < end; c += 1) {
      const ch = line.chars[c];
      const attr = line.attrs[c];
      const text = ch === null || ch === undefined ? " " : ch;
      if (text === "" ) continue; // wide-char continuation
      if (pending === null || attr === pending) {
        pending = attr;
        current += text;
        continue;
      }
      out += flushRun(current, pending);
      current = text;
      pending = attr;
    }
    if (current !== "") out += flushRun(current, pending);
    return out;
  }

  function flushRun(text, attr) {
    const code = attr && attr !== "0" && attr !== "" ? `\u001b[0m\u001b[${attr}m` : "\u001b[0m";
    return `${code}${text}`;
  }

  // Self-contained repaint of "history that scrolled away, then the current screen
  // pinned at the bottom". Written into a fresh terminal it reproduces what the user
  // was looking at, including a scrollable scrollback, with no reliance on where a
  // byte window happened to start. Alt-screen sessions diverge after the history:
  // the client is switched into the alternate screen first (1049h) and the frame is
  // painted there — painting it into the normal buffer instead would strand the
  // client in the wrong buffer while the application keeps writing with alt-screen
  // semantics, and every scrolled line the app emits afterwards piles into the
  // client's scrollback (实测：重建后每波输出 scrollHeight 稳定 +9000px 不复原).
  function toReplay() {
    // 先把待解析字节排空：切片解析可能正停在半路，回放必须对应到字节流的末端。
    flush();
    if (replayCache !== null) return replayCache;
    const parts = ["\u001b[0m\u001b[2J\u001b[H"];
    let bytes = 8;
    // 画面前先回放记录过的应用态模式（autowrap/IRM/convertEol 开关、鼠标族、
    // 括号粘贴），让客户端与应用的当前状态对齐。2026 同步标记不发：它是同帧批处理
    // 标记，回放只有单帧画面，发了没有意义。备屏（1049/1047/47）只对「当下就在备屏」
    // 的会话发（见下面的 inAlt 分支）——不在备屏的会话发备屏序列会把回放切进备用屏，
    // 丢掉刻意保留的滚屏历史。
    for (const p of REPLAYED_MODES) {
      if (!(p in appModes)) continue;
      const seq = `\u001b[?${p}${appModes[p] ? "h" : "l"}`;
      parts.push(seq);
      bytes += seq.length;
    }
    // 从尾部往前收，够 2MB 就停；收完反向输出，免掉逐条 unshift 的 O(n²) 搬移。
    const keep = [];
    for (let k = history.length - 1; k >= 0; k -= 1) {
      const size = history[k].length + 2;
      if (bytes + size > TERMINAL_REPLAY_MAX_BYTES) break;
      bytes += size;
      keep.push(history[k]);
    }
    for (let k = keep.length - 1; k >= 0; k -= 1) parts.push(`${keep[k]}\u001b[0m\r\n`);
    if (inAlt) {
      // 备屏会话：历史画进普通屏即止，不垫 LF 推开——帧画在备屏，普通屏维持历史
      // 尾部原样，应用退备屏时客户端恢复的就是这张（与 1049 的保存/恢复语义对齐）。
      // 切换序列用应用当初进备屏的那只 API，不擅自换（1049 带存光标＋清屏，另两只不带）。
      const seq = `\u001b[?${altApi}h`;
      parts.push(seq);
      bytes += seq.length;
    } else {
      // Push the tail of the history off the bottom edge before painting: after `keep`
      // lines the client still has up to rows-1 of them sitting on screen, and the
      // absolute paint below would overwrite them out of existence. Scrolling them in
      // first is what makes "client scrollback = exactly the rows that scrolled away"
      // hold, which is the whole point of the replay. rows-1 and not rows: the last
      // history line already left one blank row under the cursor, and a filler past
      // that pushes a blank line into the scrollback (the round-trip test caught the
      // off-by-one as 256 lines where 255 existed).
      for (let r = 0; r < height - 1; r += 1) parts.push("\r\n");
    }
    // Every row is written explicitly, blanks included: the history above already
    // dirtied these lines, so a shorter repaint must erase before it writes —
    // otherwise the tail of a history row bleeds through the frame (caught by the
    // round-trip test: '帧 119 第 0 行 zzz…' came back with 'yyy' stuck on the end).
    // 每行结尾必须复位 SGR：serializeRow 的 run 只在开头设色、行尾不清，而下一行的
    // EL 擦除带 BCE 语义（用当前背景色填擦除区）——不复位就会把上一行的底色漏给
    // 下一行，且 EL 不改 SGR，空行会把泄漏级联到屏底（OpenCode 全屏染色、Claude
    // 消息行下多一条灰即此形态）。
    for (let r = 0; r < grid.length; r += 1) {
      const serialized = isBlankRow(grid[r]) ? "" : serializeRow(grid[r]);
      const size = serialized.length + 16;
      if (bytes + size > TERMINAL_REPLAY_MAX_BYTES) break;
      bytes += size;
      parts.push(`\u001b[${r + 1};1H\u001b[2K${serialized}\u001b[0m`);
    }
    parts.push("\u001b[0m");
    parts.push(`\u001b[${row + 1};${col + 1}H`);
    parts.push(cursorVisible ? "\u001b[?25h" : "\u001b[?25l");
    replayCache = parts.join("");
    return replayCache;
  }

  return {
    write,
    writeSliced,
    drain,
    flush,
    discardPending,
    toReplay,
    resize(nextCols, nextRows) {
      const cols = Math.max(1, nextCols | 0);
      const rows = Math.max(1, nextRows | 0);
      if (cols === width && rows === height) return;
      rebuild(cols, rows);
      replayCache = null;
    },
    // Test/diagnostic surface: the rendered picture as plain lines.
    screenLines() {
      flush();
      return grid.map((line) => line.chars.map((ch) => (ch === null ? " " : ch)).join("").replace(/\s+$/, ""));
    },
    // Same grid, one cell at a time, so a repaint can be checked for colour and
    // not just for text. Background is whatever background SGR the cell carries.
    // 38/48/58 的扩展色子参数必须整组跳过：58;2;40;90;30 里的 40 是下划线色的
    // 绿色分量，不是背景（下划线色不是底色）。
    screenAttrs() {
      flush();
      return grid.map((line) => line.chars.map((ch, index) => {
        const tokens = String(line.attrs[index] ?? "").split(";");
        let bg = "";
        for (let i = 0; i < tokens.length; i += 1) {
          const token = tokens[i];
          if (token === "7") { bg = "7"; break; }
          if (token.includes(":")) continue;
          const n = Number(token);
          if (!Number.isFinite(n)) continue;
          if (n === 38 || n === 58) {
            const kind = Number(tokens[i + 1]);
            if (kind === 5) i += 2;
            else if (kind === 2) i += 4;
            continue;
          }
          if (n === 48) {
            const kind = Number(tokens[i + 1]);
            if (kind === 5) bg = `48;5;${tokens[i + 2] ?? 0}`;
            else if (kind === 2) bg = `48;2;${tokens[i + 2] ?? 0};${tokens[i + 3] ?? 0};${tokens[i + 4] ?? 0}`;
            else bg = "48";
            break;
          }
          if (n === 49 || (n >= 40 && n <= 47) || (n >= 100 && n <= 107)) { bg = token; break; }
        }
        return { ch: ch === null || ch === undefined ? " " : ch, bg };
      }));
    },
    historyLines() {
      flush();
      return history.map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+$/, ""));
    },
    info() {
      // 刻意不排空待解析字节：info() 在每次建连（stream 判断要不要发回放）与
      // restartHygiene 里都会调，而排空一整批积压是几十毫秒的同步工作——那正是
      // 本次改动要消除的卡顿形态。consumedBytes 在入队时就已累加，因此这里读到的
      // 值天然对应当前字节流；需要「解析后的画面状态」的调用方自己先 flush()。
      return { cols: width, rows: height, row, col, historyLines: history.length, historyBytes: historyTotal, consumedBytes, inAlt, cursorVisible, pendingChars: carry.length + Math.max(0, pending.length - pendingOffset) };
    },
  };
}
