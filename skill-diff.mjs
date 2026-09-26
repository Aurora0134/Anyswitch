// skill-diff.mjs — 行级左右对照差异引擎（面板「查看差异」的正文层）
//
// diffDirs 只回答「哪些文件不一样」，回答不了「哪几行不一样」。本模块把一对
// 文本变成可以直接画成左右两栏的对齐行：每行自带两侧行号，删除行只有左栏有
// 内容、插入行只有右栏有内容、位置对齐的一改一删合成 mod 让两栏并排显示改动，
// 与常见 CLI diff 工具的同款形态一致。前端只管渲染，不再算第二次对齐。
//
// 纯函数、零依赖、不碰文件系统：所有边界（读盘、二进制、超大文件）由调用方
// （agent-skills.mjs 的 diffSkillContent）判定后决定要不要把文本送进来。

// LCS 动态规划的规模上限（两侧中段行数之积）。超上限时不硬算，返回 null 让
// 调用方标成「未比对」——宁可少给一段差异，也不让面板卡在几十秒的表格上。
export const DIFF_MAX_CELLS = 4_000_000;

// 折叠上下文行数：改动行上下各保留这么多未改动行，其余收进 gap。
export const DIFF_CONTEXT_LINES = 3;

// 文本切成显示行：去掉行尾 \r（两侧换行符风格不同时不该报成整文件改动），
// 末尾换行不产生空尾行。空文本是零行而不是一行空串。
export function splitLines(text) {
  const s = String(text ?? "");
  if (s === "") return [];
  const out = s.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

// 编辑脚本：[{op:"equal"|"del"|"ins", a?, b?}]。先掐掉公共前后缀（真实编辑
// 里绝大部分行本来就不动），中段才进 LCS 表；超出规模上限返回 null。
function editOps(a, b, { maxCells = DIFF_MAX_CELLS } = {}) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length - 1;
  let tailB = b.length - 1;
  while (tailA >= head && tailB >= head && a[tailA] === b[tailB]) { tailA--; tailB--; }
  const midA = a.slice(head, tailA + 1);
  const midB = b.slice(head, tailB + 1);
  if (midA.length * midB.length > maxCells) return null;

  const n = midA.length;
  const m = midB.length;
  // dp[i][j] = midA[i..] 与 midB[j..] 的 LCS 长度，自后向前推，回溯时顺走
  const dp = new Int32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = midA[i] === midB[j]
        ? dp[at(i + 1, j + 1)] + 1
        : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  const mid = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) { mid.push({ op: "equal", a: head + i, b: head + j }); i++; j++; }
    else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) { mid.push({ op: "del", a: head + i }); i++; }
    else { mid.push({ op: "ins", b: head + j }); j++; }
  }
  while (i < n) { mid.push({ op: "del", a: head + i }); i++; }
  while (j < m) { mid.push({ op: "ins", b: head + j }); j++; }

  const ops = [];
  for (let k = 0; k < head; k++) ops.push({ op: "equal", a: k, b: k });
  ops.push(...mid);
  const tailLen = a.length - 1 - tailA;
  for (let k = 0; k < tailLen; k++) {
    ops.push({ op: "equal", a: tailA + 1 + k, b: tailB + 1 + k });
  }
  return ops;
}

// 编辑脚本 → 左右对齐行。一段连续改动里的删除与插入按位置配成 mod（两栏同行
// 并列，读起来就是"这行改成了那行"），多出来的一侧才落成单独的 del / ins。
function opsToRows(ops, a, b) {
  const rows = [];
  let aNo = 0;
  let bNo = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === "equal") {
      const { a: ai, b: bi } = ops[i];
      aNo++;
      bNo++;
      rows.push({ op: "equal", aNo, aText: a[ai], bNo, bText: b[bi] });
      i++;
      continue;
    }
    const dels = [];
    const inss = [];
    while (i < ops.length && ops[i].op !== "equal") {
      if (ops[i].op === "del") dels.push(ops[i].a);
      else inss.push(ops[i].b);
      i++;
    }
    const paired = Math.min(dels.length, inss.length);
    for (let k = 0; k < paired; k++) {
      aNo++;
      bNo++;
      rows.push({ op: "mod", aNo, aText: a[dels[k]], bNo, bText: b[inss[k]] });
    }
    for (let k = paired; k < dels.length; k++) {
      aNo++;
      rows.push({ op: "del", aNo, aText: a[dels[k]], bNo: null, bText: null });
    }
    for (let k = paired; k < inss.length; k++) {
      bNo++;
      rows.push({ op: "ins", aNo: null, aText: null, bNo, bText: b[inss[k]] });
    }
  }
  return rows;
}

// 未改动的长段落折成 gap，只留改动行上下各 context 行。首尾被折掉的部分同样
// 要出 gap：不然一屏从第 18 行开始、到第 24 行结束，用户无从知道两头还有内容。
// gap 行不带行号，前端据此断开两栏底色。
function collapseRows(rows, { context = DIFF_CONTEXT_LINES } = {}) {
  const keep = new Set();
  rows.forEach((row, idx) => {
    if (row.op === "equal") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(rows.length - 1, idx + context); k++) keep.add(k);
  });
  const kept = [...keep].sort((x, y) => x - y);
  if (!kept.length) return [];
  const out = [];
  if (kept[0] > 0) out.push({ op: "gap", hidden: kept[0] });
  let prev = kept[0];
  out.push(rows[kept[0]]);
  for (const idx of kept.slice(1)) {
    if (idx > prev + 1) out.push({ op: "gap", hidden: idx - prev - 1 });
    out.push(rows[idx]);
    prev = idx;
  }
  const tail = rows.length - 1 - prev;
  if (tail > 0) out.push({ op: "gap", hidden: tail });
  return out;
}

/**
 * 一对文本的左右对照差异。
 * state：
 *  - "diff"       有改动，rows 为折叠后的对齐行
 *  - "same"       逐行读下来没有任何不同（两侧仅在换行符/末尾空行上不同时就是这态）
 *  - "oversize"   中段规模超上限，未比对
 * changed / added / removed 按对齐行统计，供弹窗顶部一句话交代改动量。
 */
export function diffFileText(aText, bText, { context = DIFF_CONTEXT_LINES, maxCells = DIFF_MAX_CELLS } = {}) {
  const a = splitLines(aText);
  const b = splitLines(bText);
  const base = { aLines: a.length, bLines: b.length };
  const ops = editOps(a, b, { maxCells });
  if (!ops) return { state: "oversize", rows: [], changed: 0, added: 0, removed: 0, ...base };
  const rows = opsToRows(ops, a, b);
  const changed = rows.reduce((n, r) => n + (r.op === "equal" ? 0 : 1), 0);
  if (changed === 0) return { state: "same", rows: [], changed: 0, added: 0, removed: 0, ...base };
  const added = rows.reduce((n, r) => n + (r.op === "ins" ? 1 : r.op === "mod" ? 1 : 0), 0);
  const removed = rows.reduce((n, r) => n + (r.op === "del" ? 1 : r.op === "mod" ? 1 : 0), 0);
  return { state: "diff", rows: collapseRows(rows, { context }), changed, added, removed, ...base };
}
