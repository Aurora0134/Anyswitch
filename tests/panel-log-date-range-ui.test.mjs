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

test("calendar cells are flat 28px rows in a chromeless grid with 1px gutters", () => {
  assert.ok(css.includes(".logs-calendar { min-width: 0; }"));
  const grid = css.split(".logs-calendar-days {")[1].split("}")[0];
  assert.ok(grid.includes("gap: 1px"));
  const cell = css.split(".logs-calendar-day {")[1].split("}")[0];
  assert.ok(cell.includes("height: 28px"));
  assert.doesNotMatch(cell, /aspect-ratio/);
  const endpoint = css.split('.logs-calendar-day[data-endpoint="true"] {')[1].split("}")[0];
  assert.ok(endpoint.includes("var(--accent)"));
  const future = css.split('.logs-calendar-day[data-out-of-bounds="true"] {')[1].split("}")[0];
  assert.ok(future.includes("opacity: 0.4"));
  assert.ok(js.includes('button.dataset.outOfBounds = "true"'));
});

test("popover keeps 620px width and a 250px fields column beside the calendar", () => {
  const popover = css.split(".logs-range-picker {")[1].split("}")[0];
  assert.ok(popover.includes("width: min(620px, calc(100vw - 32px))"));
  assert.ok(popover.includes("container-type: inline-size"));
  assert.ok(popover.includes("padding: 14px"));
  assert.ok(popover.includes("border: 1px solid var(--border-strong)"));
  assert.ok(popover.includes("border-radius: 6px"));
  assert.ok(popover.includes("box-shadow: 0 12px 36px"));
  assert.ok(css.includes("@container (min-width: 500px)"));
  assert.ok(css.includes(".logs-range-layout { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }"));
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
