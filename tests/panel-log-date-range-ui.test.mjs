import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../panel-ui/panel.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../panel-ui/panel.js", import.meta.url), "utf8");

test("request logs offer all six date presets without changing the overview controls", () => {
  const logs = html.split('id="statsLogsPane"')[1].split("</section>")[0];
  const choices = [...logs.matchAll(/data-log-range="([^"]+)">([^<]+)<\/button>/g)].map(([, value, label]) => [value, label]);
  assert.deepEqual(choices, [
    ["today", "今天"], ["1d", "近 24 小时"], ["7d", "近 7 天"],
    ["14d", "近 14 天"], ["30d", "近 30 天"], ["all", "全部"],
  ]);
  assert.doesNotMatch(html.split('id="statsLogsPane"')[0], /data-log-range=/);
  for (const id of ["logsRangeStart", "logsRangeEnd", "logsRangeLive", "logsCalendarPrev", "logsCalendarNext", "logsCalendarToday", "logsRangeApply", "logsRangeCancel"]) {
    assert.match(logs, new RegExp(`id="${id}"`));
  }
  assert.match(logs, /type="datetime-local" id="logsRangeStart" step="60"/);
  assert.match(logs, /type="datetime-local" id="logsRangeEnd" step="60"/);
  assert.match(logs, /结束时间跟随当前时刻/);
  assert.match(js, /开始时间不能晚于结束时间/);
  assert.match(js, /自定义范围不能超过 30 天/);
  assert.match(js, /end - logsRangeDraft\.startTs > 30 \* LOG_RANGE_DAY_MS/);
  assert.match(js, /!logsRangeDraft\.liveEnd && end - logsRangeDraft\.startTs/);
  assert.match(js, /requestRange === "custom"/);
  assert.ok(js.includes('sp.set("liveEnd", "1")'));
  assert.ok(js.includes("picker.hidePopover()"));
});
