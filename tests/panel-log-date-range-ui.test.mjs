import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../panel-ui/panel.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../panel-ui/panel.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../panel-ui/panel.css", import.meta.url), "utf8");

test("request logs offer all six date presets without changing the overview controls", () => {
  const logs = html.split('id="statsLogsPane"')[1].split("</section>")[0];
  const choices = [...logs.matchAll(/data-log-range="([^"]+)">([^<]+)<\/button>/g)].map(([, value, label]) => [value, label]);
  assert.deepEqual(choices, [
    ["today", "今天"], ["1d", "近 24 小时"], ["7d", "近 7 天"],
    ["14d", "近 14 天"], ["30d", "近 30 天"], ["all", "全部"],
  ]);
  assert.doesNotMatch(html.split('id="statsLogsPane"')[0], /data-log-range=/);
  for (const id of ["logsRangeStartDate", "logsRangeStartTime", "logsRangeEndDate", "logsRangeEndTime", "logsRangeLive", "logsCalendarPrev", "logsCalendarNext", "logsCalendarToday", "logsRangeApply", "logsRangeCancel"]) {
    assert.match(logs, new RegExp(`id="${id}"`));
  }
  assert.match(logs, /type="date" id="logsRangeStartDate"/);
  assert.match(logs, /type="time"[^>]*id="logsRangeStartTime"[^>]*step="60"/);
  assert.match(logs, /type="date" id="logsRangeEndDate"/);
  assert.match(logs, /type="time"[^>]*id="logsRangeEndTime"[^>]*step="60"/);
  assert.doesNotMatch(logs, /type="datetime-local"/);
  assert.match(logs, /结束时间跟随当前时刻/);
  assert.match(js, /开始时间不能晚于结束时间/);
  assert.match(js, /自定义范围不能超过 30 天/);
  assert.match(js, /end - logsRangeDraft\.startTs > 30 \* LOG_RANGE_DAY_MS/);
  assert.match(js, /!logsRangeDraft\.liveEnd && end - logsRangeDraft\.startTs/);
  assert.match(js, /requestRange === "custom"/);
  assert.ok(js.includes('sp.set("liveEnd", "1")'));
  assert.ok(js.includes("picker.hidePopover()"));
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

test("request log range separates date and time and compresses calendar rows", () => {
  const logs = html.split('id="statsLogsPane"')[1].split("</section>")[0];
  for (const id of ["logsRangeStartDate", "logsRangeStartTime", "logsRangeEndDate", "logsRangeEndTime"]) {
    assert.match(logs, new RegExp(`id="${id}"`));
  }
  assert.ok(logs.includes('type="date"'));
  assert.ok(logs.includes('type="time"'));
  assert.ok(logs.includes('step="60"'));
  assert.ok(!logs.includes('type="datetime-local"'));
  const day = css.split(".logs-calendar-day {")[1].split("}")[0];
  assert.ok(!day.includes("aspect-ratio"));
  assert.ok(day.includes("height: 30px"));
  assert.ok(day.includes("min-height: 0"));
  assert.ok(day.includes("width: 100%"));
  assert.ok(css.includes("grid-template-columns: repeat(7, minmax(0, 1fr))"));
  assert.ok(css.includes(".logs-calendar { min-width: 0; padding: 8px; border-radius: 8px; background: var(--surface-hover); }"));
  const picker = css.split(".logs-range-picker {")[1].split("}")[0];
  assert.ok(picker.includes("width: min(620px, calc(100vw - 32px))"));
  const field = css.split(".logs-range-field {")[1].split("}")[0];
  assert.ok(field.includes("height: 104px"));
  const control = css.split(".logs-range-control input {")[1].split("}")[0];
  assert.ok(control.includes("color-scheme: inherit"));
  assert.ok(js.includes("logDateTimeFromInputs"));
  assert.ok(js.includes("box.dataset.rangeField === \"start\""));
  assert.ok(js.includes('if (!e.target.checked) logsRangeDraft.endTs'));
  assert.ok(js.includes('logsCalendarField = "start";'));
});
