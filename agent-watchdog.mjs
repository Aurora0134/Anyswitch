// 自更新契约壳：≤0.7.0 升级器收尾恢复 watchdog、旧自启任务快照按此根路径
// 拉起看门狗。零实现、转发到分域后的真入口；契约与退役条件见
// src/shared/entry-forward.mjs 头注。
import { forwardEntry } from "./src/shared/entry-forward.mjs";
forwardEntry(new URL("./src/agents/agent-watchdog.mjs", import.meta.url));
