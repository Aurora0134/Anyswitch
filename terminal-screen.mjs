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
// (CR/LF/BS/TAB, CUU/CUD/CUF/CUB/CNL/CPL/CHA/VPA/CUP, ED/EL/IL/DL/DCH/ICH/ECH,
// SU/SD, DECSTBM, SGR incl. 256/truecolor, DECSC/DECRC, cursor visibility, alt
// screen 1049/1047/47, autowrap 7, IRM 4) plus OSC and DCS strings consumed whole.
// Unknown sequences are consumed and ignored — the mirror must never be able to
// break forwarding. Reflow on resize is deliberately not modelled: a resize makes
// the application repaint its own frame, so only historical rows keep their old
// wrap, which is what a real terminal's scrollback shows too.

export const TERMINAL_HISTORY_LINES = 5000; // matches the panel's xterm scrollback
export const TERMINAL_HISTORY_MAX_BYTES = 1024 * 1024;
export const TERMINAL_REPLAY_MAX_BYTES = 2 * 1024 * 1024;

const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];
const COMBINING_RANGES = [[0x300, 0x36f], [0x483, 0x489], [0x591, 0x5bd], [0x610, 0x61a], [0x64b, 0x65f], [0x200b, 0x200f], [0xfe00, 0xfe0f], [0x1ab0, 0x1aff]];

const inRanges = (code, ranges) => ranges.some(([lo, hi]) => code >= lo && code <= hi);

export function terminalCharWidth(ch) {
  const code = ch.codePointAt(0);
  if (code === 0x200b || inRanges(code, COMBINING_RANGES)) return 0;
  if (inRanges(code, WIDE_RANGES)) return 2;
  return 1;
}

const blankRow = (cols, attr = "") => ({
  chars: new Array(cols).fill(null),
  attrs: new Array(cols).fill(attr),
});

// 纯背景（只有 SGR 背景属性、字符全是空格）的行也不算空行，否则 toReplay 会把它漏画。
const isBlankRow = (row) =>
  row.chars.every((ch) => ch === null || ch === "" || ch === " ") &&
  row.attrs.every((attr) => attr === "");

// 回放要重放的应用态模式：鼠标族（1000/1002/1003/1006/1015）与括号粘贴（2004）。
const REPLAYED_MODES = [1000, 1002, 1003, 1006, 1015, 2004];

export function createScreenMirror({ cols = 80, rows = 24, historyLines = TERMINAL_HISTORY_LINES, historyBytes = TERMINAL_HISTORY_MAX_BYTES } = {}) {
  let width = Math.max(1, cols | 0);
  let height = Math.max(1, rows | 0);
  let grid = Array.from({ length: height }, () => blankRow(width));
  let altSaved = null;
  let inAlt = false;
  let row = 0;
  let col = 0;
  let pendingWrap = false;
  let saved = { row: 0, col: 0, attrs: "" };
  let top = 0;
  let bottom = height - 1;
  let sgr = [];
  let autoWrap = true;
  let insertMode = false;
  let cursorVisible = true;
  // 应用态模式的记录表：只在被显式 set/reset 过后才入表；从未出现过的模式
  // 保持「未记录」，回放时不发任何模式序列，与旧行为一致。
  let appModes = {};
  let history = [];
  let historyTotal = 0;
  let consumedBytes = 0;

  const attrsString = () => (sgr.length ? sgr.join(";") : "");

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
    clampCursor();
  }

  function clampCursor() {
    row = Math.min(height - 1, Math.max(0, row));
    col = Math.min(width - 1, Math.max(0, col));
    pendingWrap = false;
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
  function scrollRegionUp(n) {
    for (let k = 0; k < n; k += 1) {
      const whole = top === 0 && bottom === height - 1;
      if (whole && !inAlt) pushHistory(serializeRow(grid[top]));
      for (let r = top; r < bottom; r += 1) grid[r] = grid[r + 1];
      grid[bottom] = blankRow(width);
    }
  }

  function scrollRegionDown(n) {
    for (let k = 0; k < n; k += 1) {
      for (let r = bottom; r > top; r -= 1) grid[r] = grid[r - 1];
      grid[top] = blankRow(width);
    }
  }

  function lineFeed() {
    if (row === bottom) scrollRegionUp(1);
    else row = Math.min(height - 1, row + 1);
  }

  function reverseIndex() {
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
    for (let c = from; c <= to; c += 1) { line.chars[c] = null; line.attrs[c] = fill; }
  }

  function eraseDisplay(mode) {
    if (mode === 3) {
      // ESC[3J 只清滚动区，当前画面原样保留。
      history = [];
      historyTotal = 0;
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

  function applySgr(raw) {
    const params = (raw === "" ? "0" : raw).split(";").map((x) => (x === "" ? 0 : Number(x) || 0));
    for (let i = 0; i < params.length; i += 1) {
      const p = params[i];
      if (p === 0) { sgr = []; continue; }
      if (p === 39) { sgr = sgr.filter((c) => !(c === 39 || (c >= 30 && c <= 37) || (c >= 90 && c <= 97) || /^38;/.test(String(c)))); continue; }
      if (p === 49) { sgr = sgr.filter((c) => !(c === 49 || (c >= 40 && c <= 47) || (c >= 100 && c <= 107) || /^48;/.test(String(c)))); continue; }
      if (p === 22) { sgr = sgr.filter((c) => c !== 1 && c !== 2 && c !== 21); continue; }
      if (p === 23) { sgr = sgr.filter((c) => c !== 3); continue; }
      if (p === 24) { sgr = sgr.filter((c) => c !== 4); continue; }
      if (p === 25) { sgr = sgr.filter((c) => c !== 5 && c !== 6); continue; }
      if (p === 27) { sgr = sgr.filter((c) => c !== 7); continue; }
      if (p === 38 || p === 48) {
        // 38;5;n / 38;2;r;g;b — carry the whole colour run as one attribute token.
        const kind = params[i + 1];
        if (kind === 5) { sgr.push(`${p};5;${params[i + 2] ?? 0}`); i += 2; continue; }
        if (kind === 2) { sgr.push(`${p};2;${params[i + 2] ?? 0};${params[i + 3] ?? 0};${params[i + 4] ?? 0}`); i += 4; continue; }
        continue;
      }
      if (!sgr.includes(p)) sgr.push(p);
    }
  }

  function setMode(raw, final, on) {
    const params = (raw === "" ? "0" : raw).split(";").map((x) => (x === "" ? 0 : Number(x) || 0));
    for (const p of params) {
      if (final === "h" || final === "l") {
        const value = on;
        if (p === 25) cursorVisible = value;
        else if (p === 7) autoWrap = value;
        else if (p === 4 && !value) insertMode = false;
        else if (p === 4 && value) insertMode = true;
        else if (p === 1049 || p === 1047 || p === 47) setAlt(value);
        else if (REPLAYED_MODES.includes(p)) appModes[p] = value;
        // 1 (cursor keys), 12 (blink), 2026 (synchronised output), 6 (origin):
        // consumed, no grid effect here. Mouse modes and bracketed paste are
        // recorded above so toReplay can restore them.
      }
    }
  }

  function setAlt(on) {
    if (on === inAlt) return;
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
    const nums = raw.split(";").map((x) => (x === "" ? 0 : Number(x) || 0));
    const arg = (index, dflt) => {
      const value = nums[index];
      return value === undefined || Number.isNaN(value) || value === 0 ? dflt : value;
    };
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
      case "J": eraseDisplay(priv ? 0 : (nums[0] || 0)); break;
      case "K": eraseLine(nums[0] || 0); break;
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
        const nextBottom = (nums[1] === undefined || nums[1] === 0 ? height : nums[1]) - 1;
        top = Math.max(0, Math.min(height - 1, nextTop));
        bottom = Math.max(top, Math.min(height - 1, nextBottom));
        row = top;
        col = 0;
        break;
      }
      case "m": if (!priv) applySgr(raw); break;
      case "s": saved = { row, col, attrs: attrsString() }; break;
      case "u": row = saved.row; col = saved.col; sgr = saved.attrs === "" ? [] : saved.attrs.split(";"); break;
      case "h": setMode(raw, "h", true); break;
      case "l": setMode(raw, "l", false); break;
      default: break; // DSR/DA/window ops/scroll-area save/restore …: consumed
    }
    clampCursor();
  }

  // A CSI parameter string can carry private markers and intermediates
  // ("?<params><intermediates><final>"); keep the digits for dispatch.
  function consumeEscape(input, start) {
    const next = input[start + 1];
    if (next === undefined) return input.length;
    if (next === "[") {
      let i = start + 2;
      let priv = "";
      if (i < input.length && /^[?>=!]/.test(input[i])) { priv = input[i]; i += 1; }
      let params = "";
      while (i < input.length && !/[@-~]/.test(input[i])) {
        if (/[\d;]/.test(input[i])) params += input[i];
        i += 1;
      }
      const final = input[i];
      if (final === undefined) return input.length;
      if (!priv || priv === "?") dispatchCsi(params, final, priv === "?");
      i += 1;
      // ESC[?2026h/l and friends stay invisible to the grid; the private marker on
      // other modes is handled inside setMode via the params we did pass.
      return i;
    }
    if (next === "]") {
      let i = start + 2;
      while (i < input.length) {
        if (input[i] === "\u0007") return i + 1;
        if (input[i] === "\u001b" && input[i + 1] === "\\") return i + 2;
        i += 1;
      }
      return input.length;
    }
    if (next === "P" || next === "^" || next === "_") {
      let i = start + 2;
      while (i < input.length) {
        if (input[i] === "\u0007") return i + 1;
        if (input[i] === "\u001b" && input[i + 1] === "\\") return i + 2;
        i += 1;
      }
      return input.length;
    }
    if (next === "7") { saved = { row, col, attrs: attrsString() }; return start + 2; }
    if (next === "8") { row = saved.row; col = saved.col; return start + 2; }
    if (next === "D") { lineFeed(); return start + 2; }
    if (next === "E") { col = 0; lineFeed(); return start + 2; }
    if (next === "M") { reverseIndex(); return start + 2; }
    if (next === "c") {
      grid = Array.from({ length: height }, () => blankRow(width));
      row = 0; col = 0; top = 0; bottom = height - 1; sgr = [];
      return start + 2;
    }
    if (next === "(" || next === ")" || next === "*" || next === "+") return Math.min(input.length, start + 3);
    return start + 2;
  }

  function write(input) {
    if (typeof input !== "string" || input === "") return;
    consumedBytes += Buffer.byteLength(input);
    let i = 0;
    while (i < input.length) {
      const ch = input[i];
      if (ch === "\u001b") { i = consumeEscape(input, i); continue; }
      if (ch === "\r") { col = 0; pendingWrap = false; i += 1; continue; }
      if (ch === "\n") { lineFeed(); i += 1; continue; }
      if (ch === "\u0008") { col = Math.max(0, col - 1); pendingWrap = false; i += 1; continue; }
      if (ch === "\u0009") { col = Math.min(width - 1, (Math.floor(col / 8) + 1) * 8); pendingWrap = false; i += 1; continue; }
      if (ch < " ") { i += 1; continue; }
      const w = terminalCharWidth(ch);
      if (w === 0) { appendToPrevious(col, ch); i += 1; continue; }
      if (autoWrap && pendingWrap) { col = 0; lineFeed(); pendingWrap = false; }
      putCell(col, ch, w);
      if (col + w >= width) {
        pendingWrap = autoWrap;
        col = width - 1;
      } else {
        col += w;
      }
      i += 1;
    }
    clampCursor();
  }

  function serializeRow(line) {
    let out = "";
    let current = "";
    let pending = null;
    // 只裁「无属性的尾随空格」：带 SGR 属性（典型是纯背景）的尾随空格照常走 SGR 发射。
    let end = line.chars.length;
    while (end > 0) {
      const ch = line.chars[end - 1];
      const blank = ch === null || ch === undefined || ch === "" || ch === " ";
      if (!blank || line.attrs[end - 1] !== "") break;
      end -= 1;
    }
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
  // byte window happened to start.
  function toReplay() {
    const parts = ["\u001b[0m\u001b[2J\u001b[H"];
    let bytes = 8;
    // 画面前先回放记录过的应用态模式（鼠标族 / 括号粘贴），让客户端与应用的当前状态对齐。
    // 明确不发 1049 备屏与 2026 同步：1049 会把回放切进备用屏，丢掉刻意保留的滚屏历史；
    // 2026 是同帧批处理标记，回放只有单帧画面，发了没有意义。
    for (const p of REPLAYED_MODES) {
      if (!(p in appModes)) continue;
      const seq = `\u001b[?${p}${appModes[p] ? "h" : "l"}`;
      parts.push(seq);
      bytes += seq.length;
    }
    const keep = [];
    for (let k = history.length - 1; k >= 0; k -= 1) {
      const size = history[k].length + 2;
      if (bytes + size > TERMINAL_REPLAY_MAX_BYTES) break;
      bytes += size;
      keep.unshift(history[k]);
    }
    for (const line of keep) parts.push(`${line}\u001b[0m\r\n`);
    // Push the tail of the history off the bottom edge before painting: after `keep`
    // lines the client still has up to rows-1 of them sitting on screen, and the
    // absolute paint below would overwrite them out of existence. Scrolling them in
    // first is what makes "client scrollback = exactly the rows that scrolled away"
    // hold, which is the whole point of the replay. rows-1 and not rows: the last
    // history line already left one blank row under the cursor, and a filler past
    // that pushes a blank line into the scrollback (the round-trip test caught the
    // off-by-one as 256 lines where 255 existed).
    for (let r = 0; r < height - 1; r += 1) parts.push("\r\n");
    // Every row is written explicitly, blanks included: the history above already
    // dirtied these lines, so a shorter repaint must erase before it writes —
    // otherwise the tail of a history row bleeds through the frame (caught by the
    // round-trip test: '帧 119 第 0 行 zzz…' came back with 'yyy' stuck on the end).
    for (let r = 0; r < grid.length; r += 1) {
      const serialized = isBlankRow(grid[r]) ? "" : serializeRow(grid[r]);
      const size = serialized.length + 16;
      if (bytes + size > TERMINAL_REPLAY_MAX_BYTES) break;
      bytes += size;
      parts.push(`\u001b[${r + 1};1H\u001b[2K${serialized}`);
    }
    parts.push("\u001b[0m");
    parts.push(`\u001b[${row + 1};${col + 1}H`);
    parts.push(cursorVisible ? "\u001b[?25h" : "\u001b[?25l");
    return parts.join("");
  }

  return {
    write,
    toReplay,
    resize(nextCols, nextRows) {
      const cols = Math.max(1, nextCols | 0);
      const rows = Math.max(1, nextRows | 0);
      if (cols === width && rows === height) return;
      rebuild(cols, rows);
    },
    // Test/diagnostic surface: the rendered picture as plain lines.
    screenLines() {
      return grid.map((line) => line.chars.map((ch) => (ch === null ? " " : ch)).join("").replace(/\s+$/, ""));
    },
    historyLines() {
      return history.map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+$/, ""));
    },
    info() {
      return { cols: width, rows: height, row, col, historyLines: history.length, historyBytes: historyTotal, consumedBytes, inAlt, cursorVisible };
    },
  };
}
