// 自更新契约壳：≤0.7.0 面板的换装监听器按此根路径拉起一次性 restart-helper
// （换树后旧路径的文件已删，无壳则新面板无人复活、升级确定性回滚）。零实现、
// 转发到分域后的真入口；契约与退役条件见 src/shared/entry-forward.mjs 头注。
import { forwardEntry } from "./src/shared/entry-forward.mjs";
forwardEntry(new URL("./src/panel/panel-host-restart-helper.mjs", import.meta.url));
