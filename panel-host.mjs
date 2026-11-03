// 自更新契约壳：≤0.7.0 升级器的回滚兜底（defaultSpawnPanelHost）按此根路径
// 拉起面板宿主。零实现、转发到分域后的真入口；契约与退役条件见
// src/shared/entry-forward.mjs 头注。
import { forwardEntry } from "./src/shared/entry-forward.mjs";
forwardEntry(new URL("./src/panel/panel-host.mjs", import.meta.url));
