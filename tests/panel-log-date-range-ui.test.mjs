import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "panel-ui/panel.html"), "utf8");
const js = readFileSync(join(root, "panel-ui/panel.js"), "utf8");
const css = readFileSync(join(root, "panel-ui/panel.css"), "utf8");

const logs = html.split('id="statsLogsPane"')[1].split("</section>")[0];

test("request logs offer all six date presets without changing the overview controls", () => {
  const choices = [...logs.matchAll(/data-log-range="([^"]+)">([^<]+)<\/button>/g)].map(([, value, label]) => [value, label]);
  assert.deepEqual(choices, [
    ["today", "今天"], ["1d", "近 24 小时"], ["7d", "近 7 天"],
    ["14d", "近 14 天"], ["30d", "近 30 天"], ["all", "全部"],
  ]);
  assert.doesNotMatch(html.split('id="statsLogsPane"')[0], /data-log-range=/);
  assert.match(logs, /class="btn btn-mini" aria-pressed="true" data-log-range="today"/);
  assert.match(js, /开始时间不能晚于结束时间/);
  assert.match(js, /自定义范围不能超过 30 天/);
  assert.match(js, /end - logsRangeDraft\.startTs > 30 \* LOG_RANGE_DAY_MS/);
  assert.match(js, /!logsRangeDraft\.liveEnd && end - logsRangeDraft\.startTs/);
  assert.match(js, /requestRange === "custom"/);
  assert.ok(js.includes('sp.set("liveEnd", "1")'));
  assert.ok(js.includes("picker.hidePopover()"));
});

test("custom range fields split each bound into date and time inputs on a selectable card", () => {
  assert.doesNotMatch(logs, /datetime-local/);
  assert.doesNotMatch(logs, /logs-range-hint/);
  assert.match(logs, /type="date" id="logsRangeStartDate"/);
  assert.match(logs, /type="time" id="logsRangeStartTime" step="60"/);
  assert.match(logs, /type="date" id="logsRangeEndDate"/);
  assert.match(logs, /type="time" id="logsRangeEndTime" step="60"/);
  assert.match(logs, /id="logsRangeStartCard"/);
  assert.match(logs, /id="logsRangeEndCard"/);
  assert.match(logs, /结束时间跟随当前时刻/);
  assert.match(logs, /class="btn btn-mini" id="logsRangeCancel">取消/);
  assert.match(logs, /class="btn btn-mini btn-primary" id="logsRangeApply">确认/);
  assert.match(logs, /<h3 id="logsRangeTitle">时间范围<\/h3>/);
  assert.match(logs, /class="btn btn-mini" id="logsCalendarPrev" aria-label="上个月">‹<\/button>/);
  assert.ok(css.includes(".logs-range-live input { accent-color: var(--accent); }"));
  // 输入改写只动被编辑的一半，另一半沿用现值；跟随结束时日历只改开始
  assert.ok(js.includes("logDateTimeFromInputs"));
  assert.ok(js.includes('logsRangeDraft.liveEnd ? "start" : logsCalendarField'));
  assert.ok(js.includes("logsRangeEndCard"));
  // 跟随结束开窗期每秒走针；勾上时活动字段回到开始
  assert.ok(js.includes("setLogLiveEndTicker"));
  assert.match(js, /logsRangeDraft\.endTs = Math\.floor\(Date\.now\(\) \/ 60_000\) \* 60_000; logsCalendarField = "start";/);
});

test("calendar cells are flat 22px rows in a chromeless grid with 1px gutters", () => {
  assert.ok(css.includes(".logs-calendar { min-width: 0; }"));
  const grid = css.split(".logs-calendar-days {")[1].split("}")[0];
  assert.ok(grid.includes("gap: 1px"));
  const cell = css.split(".logs-calendar-day {")[1].split("}")[0];
  assert.ok(cell.includes("height: 22px"));
  assert.doesNotMatch(cell, /aspect-ratio/);
  const endpoint = css.split('.logs-calendar-day[data-endpoint="true"] {')[1].split("}")[0];
  assert.ok(endpoint.includes("var(--accent)"));
  const future = css.split('.logs-calendar-day[data-out-of-bounds="true"] {')[1].split("}")[0];
  assert.ok(future.includes("opacity: 0.4"));
  assert.ok(js.includes('button.dataset.outOfBounds = "true"'));
});

test("confirm button keeps its accent fill on hover and brightens instead of dimming", () => {
  // 通用 .btn:hover 会把底色换成面板悬停色，主按钮因此变暗；确认键单独守住主色底并叠提亮
  const hover = css.split(".logs-range-actions .btn-primary:hover {")[1].split("}")[0];
  assert.ok(hover.includes("background: var(--accent)"));
  assert.ok(hover.includes("color: #fff"));
  assert.ok(hover.includes("filter: brightness(1.12)"));
});

test("popover keeps 620px width and a 250px fields column beside the calendar", () => {
  const popover = css.split(".logs-range-picker {")[1].split("}")[0];
  assert.ok(popover.includes("width: min(620px, calc(100vw - 32px))"));
  assert.ok(popover.includes("container-type: inline-size"));
  assert.ok(popover.includes("padding: 10px"));
  assert.ok(popover.includes("border: 1px solid var(--border-strong)"));
  assert.ok(popover.includes("border-radius: 6px"));
  assert.ok(popover.includes("box-shadow: 0 12px 36px"));
  assert.ok(css.includes("@container (min-width: 500px)"));
  assert.ok(css.includes(".logs-range-layout { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }"));
  assert.ok(css.includes(".logs-range-fields { width: 250px; flex: none; }"));
  assert.ok(css.includes(".logs-calendar { min-width: 0; flex: 1 1 0%; }"));
  const selected = css.split('.logs-range-presets [aria-pressed="true"] {')[1].split("}")[0];
  assert.ok(selected.includes("background: var(--accent-soft)"));
  assert.ok(selected.includes("color: var(--accent)"));
});

test("range popover opens in place and blurs the content behind it", () => {
  // 首帧即按触发器矩形预定位：开窗前不允许先钉到左上角再跳位
  assert.ok(js.includes("prePlacePicker"));
  assert.ok(js.includes('picker.addEventListener("beforetoggle",'));
  assert.ok(!js.includes('picker.style.left = "16px"'));
  // 高度缓存：close 后再开用上次实测高度预算，开窗后 rAF 精修
  assert.ok(js.includes("logsPickerHeight"));
  // 玻璃模糊与面板既有玻璃面同构（双前缀）
  const block = css.split(".logs-range-picker {")[1].split("}")[0];
  assert.ok(block.includes("backdrop-filter: var(--glass-blur)"));
  assert.ok(block.includes("-webkit-backdrop-filter: var(--glass-blur)"));
});

test("range popover animates open with fade, slide and zoom, and closed with fade and zoom only", () => {
  // 开＝淡入＋自上 8px 滑入＋自 95% 放大到位；关＝淡出＋缩回 95%，无位移
  const closed = css.match(/\.logs-range-picker \{ opacity: 0; transform: scale\(0\.95\); transition: [^}]+\}/);
  assert.ok(closed, "关闭归宿态（隐藏＋95% 缩放）在册");
  assert.ok(closed[0].includes("opacity 150ms ease"));
  assert.ok(closed[0].includes("transform 150ms ease"));
  // display/overlay 是离散属性：带 allow-discrete 才把 none 推迟到过渡收尾生效、
  // 让弹窗留在顶层播完关闭动画再让位
  assert.ok(closed[0].includes("display 150ms ease allow-discrete"));
  assert.ok(closed[0].includes("overlay 150ms ease allow-discrete"));
  assert.ok(css.includes(".logs-range-picker:popover-open { opacity: 1; transform: none; }"));
  // @starting-style 给从 display:none 进场的首帧定起点：开态的滑入位移只写在这里
  const start = css.split("@starting-style {")[1].split("}")[0];
  assert.ok(start.includes(".logs-range-picker:popover-open { opacity: 0; transform: translateY(-8px) scale(0.95);"));
  // 开合动画吃全局 reduced-motion 通配禁用规则（transition 清零后即时切换）
  assert.ok(css.includes("@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }"));
});

test("fresh log rows fade in under a fading accent tint only when the same view gains rows", () => {
  // 入场类只挂在 .logs-row 上（空态/错误态/骨架行不挂）；高亮颜色走主题令牌，不落字面色
  assert.ok(css.includes(".logs-table tbody tr.logs-row.logs-row-new"));
  assert.ok(css.includes("animation: logsRowEnter 240ms ease-out 160ms backwards;"));
  assert.ok(css.includes("animation: logsRowNew 1200ms ease-in 300ms backwards;"));
  const shade = css.split("@keyframes logsRowNew {")[1].split("}")[0];
  assert.ok(shade.includes("inset 0 0 0 100vmax var(--accent-soft)"));
  assert.doesNotMatch(shade, /#[0-9a-f]{3,8}\b|rgba?\(/);
  // 判定逻辑：同视图＋第 1 页才挑新键；翻页/换视图/首次加载一概不播
  const m = js.match(/function logsEnterKeys\(shown, view, page, keys\) \{([\s\S]*?)\n  \}/);
  assert.ok(m, "logsEnterKeys 在册");
  const fn = new Function(`return function logsEnterKeys(shown, view, page, keys) {${m[1]}\n  }`)();
  const shown = { view: "v", keys: ["a", "b"] };
  assert.deepEqual(fn(shown, "v", 1, ["c", "a", "b"]), ["c"], "同视图第 1 页只挑新键");
  assert.equal(fn(shown, "v", 1, ["a", "b"]), null, "同视图无新行不播");
  assert.equal(fn(shown, "v", 2, ["c"]), null, "非第 1 页不播");
  assert.equal(fn(shown, "w", 1, ["c"]), null, "换视图不播");
  assert.equal(fn(null, "v", 1, ["c"]), null, "首次加载不播");
  // 视图串＝本次请求参数集；renderLogs 只给新键行挂类
  assert.ok(js.includes("const view = sp.toString();"));
  assert.ok(js.includes("logsEnterKeys(logsShown, view, res.page, keys)"));
  assert.ok(js.includes('tr.classList.add("logs-row-new")'));
});

test("existing log rows slide from their previous position only when the same view shifts rows", () => {
  // 参数：320ms／cubic-bezier(0.2, 0, 0, 1)；起帧位移由 JS 写进变量，尾帧落回自然位置
  assert.ok(css.includes(".logs-table tbody tr.logs-row.logs-row-shift, .logs-table tbody tr.logs-detail-row.logs-row-shift { animation: logsRowShift 320ms cubic-bezier(0.2, 0, 0, 1); }"));
  assert.ok(css.includes("@keyframes logsRowShift { from { transform: translateY(var(--logs-row-shift, 0px)); } to { transform: none; } }"));
  // 纯位移无颜色量
  const kf = css.split("@keyframes logsRowShift {")[1].split("\n")[0];
  assert.doesNotMatch(kf, /var\(--accent|#[0-9a-f]{3,8}\b|rgba?\(/);
  // 位移量按重建前后实测顶点差写入：旧行顶点必须先于重建记录
  assert.ok(js.includes('tr.style.setProperty("--logs-row-shift",'));
  assert.ok(js.indexOf("oldTops.set(") < js.indexOf("tbody.innerHTML = logsRows.map"));
  assert.ok(js.includes('tr.classList.add("logs-row-shift")'));
  // 判定逻辑：同视图＋第 1 页且前后索引变化才移位；其余一概 null
  const m = js.match(/function logsShiftRows\(shown, view, page, keys\) \{([\s\S]*?)\n  \}/);
  assert.ok(m, "logsShiftRows 在册");
  const fn = new Function(`return function logsShiftRows(shown, view, page, keys) {${m[1]}\n  }`)();
  const shown = { view: "v", keys: ["a", "b"] };
  assert.deepEqual(fn(shown, "v", 1, ["c", "a", "b"]), new Map([["a", -1], ["b", -1]]), "前面插新行：旧行下移一位");
  assert.deepEqual(fn({ view: "v", keys: ["x", "a", "b"] }, "v", 1, ["a", "b"]), new Map([["a", 1], ["b", 1]]), "行集收缩：旧行上移一位");
  assert.equal(fn(shown, "v", 1, ["a", "b"]), null, "索引未变不移位");
  assert.equal(fn(shown, "v", 2, ["c", "a", "b"]), null, "非第 1 页不移位");
  assert.equal(fn(shown, "w", 1, ["c", "a", "b"]), null, "换视图不移位");
  assert.equal(fn(null, "v", 1, ["c", "a", "b"]), null, "首次加载不移位");
  // 移位动画同吃全局 reduced-motion 通配禁用规则（animation 清零后行直接落位）
  assert.ok(css.includes("@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }"));
});

test("expanded detail rows ride along with their shifted parent row", () => {
  // 挂值在展开恢复之后：先有详情行，再随父行挂同值
  assert.ok(js.indexOf("appendLogsDetail(rowEls.get(key), r);") < js.indexOf('tbody.querySelectorAll("tr.logs-row-shift")'));
  // 行为：父行位移→紧邻详情行挂父行同值；父行无位移→详情行零动画；详情行不挂新行入场类
  const loop = js.match(/for \(const tr of tbody\.querySelectorAll\("tr\.logs-row-shift"\)\) \{([\s\S]*?)\n      \}/);
  assert.ok(loop, "详情行随行挂类循环在册");
  const run = new Function("tbody", `for (const tr of tbody.querySelectorAll("tr.logs-row-shift")) {${loop[1]}\n      }`);
  const mkRow = (classes, shiftVal, next) => {
    const row = { classes, shiftVal, next, applied: null, added: [] };
    row.classList = { contains: (c) => row.classes.includes(c), add: (c) => row.added.push(c) };
    row.style = { getPropertyValue: () => row.shiftVal, setProperty: (k, v) => { row.applied = [k, v]; } };
    row.nextElementSibling = next;
    return row;
  };
  const shiftedDetail = mkRow(["logs-detail-row"], null, null);
  const shiftedParent = mkRow(["logs-row", "logs-row-shift"], "-40px", shiftedDetail);
  const stillDetail = mkRow(["logs-detail-row"], null, null);
  mkRow(["logs-row"], null, stillDetail); // 父行未挂滑位类：不进 querySelectorAll 结果
  run({ querySelectorAll: () => [shiftedParent] });
  assert.deepEqual(shiftedDetail.applied, ["--logs-row-shift", "-40px"], "父行位移：详情行挂父行同值");
  assert.deepEqual(shiftedDetail.added, ["logs-row-shift"], "详情行挂滑位类");
  assert.equal(stillDetail.applied, null, "父行无位移：详情行零动画");
  assert.equal(stillDetail.added.length, 0, "详情行不挂任何类");
  assert.ok(!js.includes('detail.classList.add("logs-row-new")'), "详情行不挂新行入场类");
});

test("row shift re-measures tops after detail rows return, so rows below an expanded row start from their old spot", () => {
  // 时序：详情行恢复先于新顶点采样（详情行是常规布局流兄弟行，插回来会把下方
  // 的行推下去）；旧行顶点仍先于重建记录
  assert.ok(js.indexOf("appendLogsDetail(rowEls.get(key), r);") < js.indexOf("oldTop - tr.getBoundingClientRect().top"));
  assert.ok(js.indexOf("oldTops.set(") < js.indexOf("tbody.innerHTML = logsRows.map"));
  // 差值语义（展开行下方行的算例：旧行顶点 80、恢复后新顶点 100 → 起帧偏移 −20px，
  // 该行自旧位置 80 向下滑到自然位 100）
  const loop = js.match(/for \(const tr of tbody\.children\) \{\n        const oldTop = oldTops\.get\(tr\.getAttribute\("data-logs-key"\)\);\n        if \(oldTop === undefined\) continue;\n        tr\.style\.setProperty\("--logs-row-shift", oldTop - tr\.getBoundingClientRect\(\)\.top \+ "px"\);\n        tr\.classList\.add\("logs-row-shift"\);\n      \}/);
  assert.ok(loop, "滑位挂类循环在册");
  const mkRow = (key, top) => {
    const row = { key, top, applied: null, added: [] };
    row.getAttribute = () => row.key;
    row.getBoundingClientRect = () => ({ top: row.top });
    row.style = { setProperty: (k, v) => { row.applied = [k, v]; } };
    row.classList = { add: (c) => row.added.push(c) };
    return row;
  };
  const below = mkRow("c", 100);    // 展开行下方的行：恢复后新顶点 100
  const shifted = mkRow("a", 20);   // 展开行自身：旧顶点 0、新顶点 20
  const detail = mkRow(null, 40);   // 详情行：无行键，不进挂类循环
  new Function("tbody", "oldTops", loop[0])({ children: [shifted, detail, below] }, new Map([["a", 0], ["c", 80]]));
  assert.deepEqual(below.applied, ["--logs-row-shift", "-20px"], "旧行顶点 80、新顶点 100：起帧偏移 −20px");
  assert.deepEqual(shifted.applied, ["--logs-row-shift", "-20px"]);
  assert.equal(detail.applied, null, "无行键（详情行）不进滑位挂类循环");
});

test("restored detail rows land right after their own parent row when several rows stay expanded", () => {
  // 整幅重建＋详情行恢复段连原文一起执行：children 恒指同一数组、after 以 splice
  // 落位，模拟 live 集合的索引漂移；多行同展时各详情行必须紧随其父行（边插边按
  // 索引取父行，插回的详情行会把后续兄弟索引顶偏，第二条起挂错父行）
  const seg = js.match(/(tbody\.innerHTML = logsRows\.map\(\(r\) => logsRowHtml\(r\)\)\.join\(""\);[\s\S]*?)\n    if \(shifts\) \{/);
  assert.ok(seg, "整幅重建＋详情行恢复段在册");
  const detailFn = js.match(/function appendLogsDetail\(tr, row\) \{([\s\S]*?)\n  \}/);
  assert.ok(detailFn, "appendLogsDetail 在册");
  const kids = [];
  const mkEl = (key) => ({
    key, className: "", cells: [], parentList: kids,
    getAttribute: (name) => (name === "data-logs-key" ? key : null),
    appendChild(c) { this.cells.push(c); },
    after(el) { this.parentList.splice(this.parentList.indexOf(this) + 1, 0, el); },
  });
  const tbody = {
    children: kids,
    set innerHTML(html) {
      kids.length = 0;
      for (const m of html.matchAll(/data-logs-key="([^"]+)"/g)) kids.push(mkEl(m[1]));
    },
  };
  const appendLogsDetail = new Function("document", "logsDetailHtml",
    `return function appendLogsDetail(tr, row) {${detailFn[1]}\n  }`)(
    { createElement: () => mkEl(null) },
    (row) => row.key,
  );
  const run = new Function("tbody", "logsRows", "logsRowHtml", "enter", "logsExpanded", "logsRowKey", "appendLogsDetail", seg[1]);
  const rows = [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }];
  run(tbody, rows, (r) => `<tr class="logs-row" data-logs-key="${r.key}"></tr>`, null, new Set(["a", "b", "c"]), (r) => r.key, appendLogsDetail);
  // 三行同展＋一行未展：a/b/c 各带一条紧随其父的详情行，d 不带
  const shape = kids.map((el) => (el.className === "logs-detail-row" ? "det:" + el.cells[0].innerHTML : "row:" + el.key));
  assert.deepEqual(shape, ["row:a", "det:a", "row:b", "det:b", "row:c", "det:c", "row:d"], "每条详情行挂在其正确父行后");
});

test("same-ms retry pair with rid expands independently on click and poll-restore", () => {
  // 同毫秒同渠道同模型的成对结算（典型：一次 200 一次 429 的重试对）旧行键完全
  // 重复：点击第 2 行展开出第 1 行的详情、单行收起清共用键拖累另一行、轮询重建
  // 详情堆挂同键首行。rid 把行键身份收窄到每笔结算唯一；点击取详情与轮询重建
  // 恢复两条路径都用真身 logsRowKey 验证。
  const keyLine = js.match(/const logsRowKey = \(r\) => (.+);$/m);
  assert.ok(keyLine, "logsRowKey 在册");
  const logsRowKey = new Function("r", `return ${keyLine[1]};`);
  const ok = { ts: 1763800000000, providerId: "pool-1", model: "kimi-k3", ok: true, status: 200, rid: "m1-7" };
  const fail = { ts: 1763800000000, providerId: "pool-1", model: "kimi-k3", ok: false, status: 429, rid: "m1-8" };
  assert.equal(logsRowKey(ok), "1763800000000|pool-1|kimi-k3|m1-7");
  assert.equal(logsRowKey(fail), "1763800000000|pool-1|kimi-k3|m1-8");
  assert.notEqual(logsRowKey(ok), logsRowKey(fail), "同毫秒重试对两行键不同");
  // 旧行（无 rid）：三段旧键形不变，不挂空尾段（回退 2026-11-19 决策的旧行为）
  assert.equal(logsRowKey({ ts: 1, providerId: "p", model: "m" }), "1|p|m");
  assert.equal(logsRowKey({ ts: 1 }), "1||");

  // ── 点击路径：toggleLogsDetail 按行键找数据行 ──
  const toggleFn = js.match(/function toggleLogsDetail\(tr\) \{([\s\S]*?)\n  \}/);
  assert.ok(toggleFn, "toggleLogsDetail 在册");
  const appended = [];
  const logsExpanded = new Set();
  const toggleLogsDetail = new Function("logsRows", "logsRowKey", "logsExpanded", "appendLogsDetail",
    `return function toggleLogsDetail(tr) {${toggleFn[1]}\n  }`)(
    [ok, fail], logsRowKey, logsExpanded, (tr, row) => appended.push(row));
  const mkTr = (key) => {
    const tr = {
      detail: null,
      get nextElementSibling() { return tr.detail; },
      getAttribute: () => key,
    };
    return tr;
  };
  const trFail = mkTr(logsRowKey(fail));
  toggleLogsDetail(trFail); // 点击第 2 行（429）：展开的必须是第 2 行自己的详情
  assert.equal(appended.length, 1);
  assert.equal(appended[0].rid, "m1-8", "点击第 2 行展开第 2 行的详情（旧行为：首次命中展开第 1 行的）");
  assert.deepEqual([...logsExpanded], [logsRowKey(fail)], "展开态只记第 2 行的键");
  const trOk = mkTr(logsRowKey(ok));
  toggleLogsDetail(trOk); // 第 1 行也展开
  assert.equal(appended[1].rid, "m1-7");
  trFail.detail = { classList: { contains: () => true }, remove() { trFail.detail = null; } };
  toggleLogsDetail(trFail); // 再点第 2 行 → 收起
  assert.deepEqual([...logsExpanded], [logsRowKey(ok)], "收起第 2 行只清自己的键，第 1 行保持展开（旧行为：共用一键，收起拖累另一行）");

  // ── 轮询恢复路径：整幅重建＋详情行恢复段（与上一用例同一段源码）──
  const seg = js.match(/(tbody\.innerHTML = logsRows\.map\(\(r\) => logsRowHtml\(r\)\)\.join\(""\);[\s\S]*?)\n    if \(shifts\) \{/);
  assert.ok(seg, "整幅重建＋详情行恢复段在册");
  const detailFn = js.match(/function appendLogsDetail\(tr, row\) \{([\s\S]*?)\n  \}/);
  assert.ok(detailFn, "appendLogsDetail 在册");
  const kids = [];
  const mkEl = (key) => ({
    key, className: "", cells: [], parentList: kids,
    getAttribute: (name) => (name === "data-logs-key" ? key : null),
    appendChild(c) { this.cells.push(c); },
    after(el) { this.parentList.splice(this.parentList.indexOf(this) + 1, 0, el); },
  });
  const tbody = {
    children: kids,
    set innerHTML(html) {
      kids.length = 0;
      for (const m of html.matchAll(/data-logs-key="([^"]+)"/g)) kids.push(mkEl(m[1]));
    },
  };
  const appendLogsDetail = new Function("document", "logsDetailHtml",
    `return function appendLogsDetail(tr, row) {${detailFn[1]}\n  }`)(
    { createElement: () => mkEl(null) },
    (row) => row.rid,
  );
  new Function("tbody", "logsRows", "logsRowHtml", "enter", "logsExpanded", "logsRowKey", "appendLogsDetail", seg[1])(
    tbody, [ok, fail],
    (r) => `<tr class="logs-row" data-logs-key="${logsRowKey(r)}"></tr>`, null,
    new Set([logsRowKey(ok), logsRowKey(fail)]), logsRowKey, appendLogsDetail);
  const restored = kids.map((el) => (el.className === "logs-detail-row" ? "det:" + el.cells[0].innerHTML : "row:" + el.key));
  assert.deepEqual(restored, ["row:1763800000000|pool-1|kimi-k3|m1-7", "det:m1-7", "row:1763800000000|pool-1|kimi-k3|m1-8", "det:m1-8"],
    "同毫秒两行同展：各详情行挂各父行（旧行为：同键两行，详情堆挂首行后、末行丢失）");
});

test("source cell pairs the agent name with a board brand avatar clone slot", () => {
  // 槽位只给已登记端点：未知来源与未登记 id 纯文字兜底，不留图标位
  const fn = js.match(/function logsAgentBrandHtml\(id\) \{([\s\S]*?)\n  \}/);
  assert.ok(fn, "logsAgentBrandHtml 在册");
  const slotHtml = new Function("STATS_ENDPOINT_LABELS", "esc",
    `return function (id) {${fn[1]}\n  }`)(
    { claude: "Claude Code", dsh: "DeepSeek Harness" }, (s) => String(s));
  assert.equal(slotHtml("claude"), '<span class="logs-agent-brand" data-logs-agent="claude" aria-hidden="true"></span>');
  assert.equal(slotHtml(null), "");
  assert.equal(slotHtml("unknown-agent"), "");
  // 行模板把槽位放在名字左侧，同一内联行
  assert.ok(js.includes('<td><span class="logs-agent">${logsAgentBrandHtml(r.agentId)}${esc(logsAgentLabel(r.agentId))}</span></td>'));
  // 重建后克隆看板 .agent-avatar 填槽：双闸门跳过单测桩环境；先于滑位新顶点采样
  assert.ok(js.includes('if (typeof document !== "undefined" && typeof tbody.querySelectorAll === "function")'));
  assert.ok(js.indexOf('tbody.innerHTML = logsRows.map') < js.indexOf('tbody.querySelectorAll("[data-logs-agent]")'));
  assert.ok(js.indexOf('tbody.querySelectorAll("[data-logs-agent]")') < js.indexOf("oldTop - tr.getBoundingClientRect().top"));
  // 空槽折叠不留位；克隆整体缩放进 16px 槽
  assert.ok(css.includes(".logs-agent-brand:empty { display: none; }"));
  assert.ok(css.includes(".logs-agent-brand .agent-avatar { flex: none; transform: scale(0.5); transform-origin: center; }"));
});

test("code comments do not name external products as the origin of implementation choices", () => {
  const pattern = /cc[-_ .]?switch/i;
  const offenders = [];
  const scan = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git" || name === "tmp") continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) scan(p);
      else if (/\.(mjs|js|html|css)$/.test(name)) {
        if (pattern.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    }
  };
  scan(join(root, "src"));
  scan(join(root, "panel-ui"));
  assert.deepEqual(offenders, []);
});
