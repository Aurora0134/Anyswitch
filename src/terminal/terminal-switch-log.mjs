// 切会话决策留痕（terminal-switch.log，JSONL 每拍一行）。
//
// 虚拟终端「切会话」的准入链跨三段：前端判定门（panel.js）、面板 /switch 路由、
// switch-guard 杀前复核。修前全程零日志——每次「该内切却新开了页签」复发都不
// 可归因。本模块是这条链的唯一写者：/switch 处理器直写，前端埋点经
// POST /panel/api/terminal/switch-log 上报后由同一路由写者落盘，两侧进同一份
// 文件（面板数据根 logs/terminal-switch.log，由 panel.mjs 定位，本模块不解析
// 任何本机路径）。
//
// 纪律：
//   · 单行 JSON：{ ts, event, ...fields }；字段经 sanitizeFields 只留标量
//     （字符串截断、键数封顶）——这是机器判读的留痕，不是给人看的文案；
//   · 尺寸封顶 TERMINAL_SWITCH_LOG_MAX_BYTES：写前发现超限就把现文件改名为
//     terminal-switch.log.old（覆盖上一档，单档轮转，与 relay-host 的
//     rotateLogIfNeeded 同约定）。与 relay-host 的「只能启动时轮转」不同，
//     这里每条都是「同步追加、写完即关」、进程不持有句柄，运行中 rename 在
//     Windows 上也不会被锁；
//   · 任何一步失败（目录建不出、盘满、序列化失败）都静默吞掉：留痕绝不能反
//     过来打垮切换主流程。返回的写者函数保证不抛。
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export const TERMINAL_SWITCH_LOG_MAX_BYTES = 512 * 1024;

const MAX_FIELDS = 20;
const MAX_FIELD_KEY_BYTES = 64;
const MAX_FIELD_STRING_BYTES = 300;
const MAX_FIELD_ARRAY_ITEMS = 10;

// 字段净化：只留可 JSON 化的标量与标量数组（如命中信号清单），顶层 ts/event
// 两个键保留给信封。前端上报的 detail 来自请求体、形状不可信；服务端埋点虽是
// 自己人，同走这道闸保持两侧口径一致。
function sanitizeFields(detail) {
  const out = {};
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return out;
  let count = 0;
  for (const [key, value] of Object.entries(detail)) {
    if (count >= MAX_FIELDS) break;
    if (!key || key.length > MAX_FIELD_KEY_BYTES || key === "ts" || key === "event") continue;
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      out[key] = value;
    } else if (typeof value === "string") {
      out[key] = value.length > MAX_FIELD_STRING_BYTES ? value.slice(0, MAX_FIELD_STRING_BYTES) : value;
    } else if (Array.isArray(value)) {
      out[key] = value
        .filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
        .slice(0, MAX_FIELD_ARRAY_ITEMS);
    } else {
      continue; // 对象/undefined/函数等一律丢弃
    }
    count += 1;
  }
  return out;
}

export function createTerminalSwitchLog({ file }) {
  let dirReady = false;
  return function terminalSwitchLogWrite(event, detail) {
    try {
      if (typeof event !== "string" || !event) return;
      const line = `${JSON.stringify({ ts: new Date().toISOString(), event, ...sanitizeFields(detail) })}\n`;
      if (!dirReady) {
        mkdirSync(dirname(file), { recursive: true });
        dirReady = true; // 失败会被下面的 catch 吞掉且不置位，下一拍自动重试
      }
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        /* 文件还没出生＝尺寸 0 */
      }
      if (size >= TERMINAL_SWITCH_LOG_MAX_BYTES) {
        const oldPath = `${file}.old`;
        try {
          if (existsSync(oldPath)) unlinkSync(oldPath);
        } catch {
          /* 旧档被占：rename 那步的失败同样吞掉，本条丢弃 */
        }
        renameSync(file, oldPath);
      }
      appendFileSync(file, line, "utf8");
    } catch {
      /* 留痕失败静默：绝不抛进切换主流程 */
    }
  };
}
