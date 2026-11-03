// 自更新契约壳：≤0.7.0 升级器换树后按此根路径重启常驻 relay。零实现、转发到
// 分域后的真入口；契约与退役条件见 src/shared/entry-forward.mjs 头注。
import { forwardEntry } from "./src/shared/entry-forward.mjs";
forwardEntry(new URL("./src/relay/relay-host.mjs", import.meta.url));
